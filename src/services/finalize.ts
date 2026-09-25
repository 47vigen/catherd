import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { relative } from "node:path";
import type { BackendAdapter, FinishedRun, Outcome, Spent } from "../adapters/backend.ts";
import { adapterFor } from "../adapters/registry.ts";
import "../adapters/all.ts";
import { changedPaths, type Snapshot, splitChanges } from "../domain/changes.ts";
import { isCatherdError } from "../domain/errors.ts";
import { parseRung } from "../domain/ids.ts";
import {
  type ExitInfo,
  parseReplyStatus,
  type RunRecord,
  THREAD_HEAVY_INPUT,
  ZERO_TOKENS,
} from "../domain/record.ts";
import { dispatchPaths, readExit, tryClaim } from "../infra/dispatch-dir.ts";
import { statusSnapshot } from "../infra/git.ts";
import { appendJsonl, ensureJsonlHeader, writeTextAtomic } from "../infra/store.ts";
import { type Dispatch, dispatchState, listDispatches, readProc } from "./dispatches.ts";
import { appendRecord, readRecords, type Run, runPaths } from "./run-store.ts";

const text = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};
const lines = (file: string): string[] =>
  text(file)
    .split("\n")
    .filter((l) => l.trim());

/** A claim this old with no record was left by a finalizer that died between the two. */
const CLAIM_STALE_MS = 30_000;

function claimAgeMs(dir: string): number {
  try {
    return Date.now() - statSync(dispatchPaths(dir).claim).mtimeMs;
  } catch {
    return 0;
  }
}

async function waitForRecord(run: Run, dispatchId: string, ms: number): Promise<RunRecord | null> {
  const end = Date.now() + ms;
  for (;;) {
    const r = readRecords(run).records.find((x) => x.dispatchId === dispatchId);
    if (r || Date.now() >= end) return r ?? null;
    await Bun.sleep(50);
  }
}

/** The owned paths of the run's other dispatches whose lifetime overlapped [start, end]. */
function othersOwns(run: Run, self: Dispatch, start: number, end: number): string[] {
  const ended = new Map(readRecords(run).records.map((r) => [r.dispatchId, Date.parse(r.endedAt)]));
  return listDispatches(run)
    .filter((d) => d.admit.dispatchId !== self.admit.dispatchId)
    .filter((d) => {
      const from = Date.parse(d.admit.admittedAt);
      const to = ended.get(d.admit.dispatchId) ?? (Date.parse(readExit(d.dir)?.endedAt ?? "") || Date.now());
      return from <= end && to >= start;
    })
    .flatMap((d) => d.admit.owns);
}

/** The tree after the run, or null when git cannot say: the record is still written, its changes unknown. */
async function snapshotOrNull(repo: string): Promise<Snapshot | null> {
  try {
    return await statusSnapshot(repo);
  } catch (e) {
    if (isCatherdError(e) && e.code === "E_IO_UNEXPECTED") return null;
    throw e;
  }
}

/** How long a backend may take to settle a finished session before its stream's own figures stand. */
export const settleLimits = { timeoutMs: 20_000 };

/** What the run's earlier records on `thread` already counted: a resumed session's totals repeat them. */
function priorOn(run: Run, backend: string, thread: string, self: string): Spent {
  const earlier = readRecords(run).records.filter(
    (r) => r.backend === backend && r.thread === thread && r.dispatchId !== self,
  );
  return {
    tokens: {
      input: earlier.reduce((n, r) => n + r.tokens.input, 0),
      cached: earlier.reduce((n, r) => n + r.tokens.cached, 0),
      output: earlier.reduce((n, r) => n + r.tokens.output, 0),
    },
    costUsd: earlier.reduce((n, r) => n + (r.costUsd ?? 0), 0),
  };
}

/** The adapter's settled outcome, or `o` unchanged when it has none, throws, or is slower than the limit. */
export async function settled(
  adapter: BackendAdapter,
  o: Outcome,
  finished: FinishedRun,
  prior: () => Spent,
): Promise<Outcome> {
  if (!adapter.settle || o.thread === null) return o;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const late = new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => resolve(o), settleLimits.timeoutMs);
    });
    return await Promise.race([adapter.settle(o, finished, prior()), late]);
  } catch {
    return o;
  } finally {
    clearTimeout(timer);
  }
}

async function compute(run: Run, d: Dispatch): Promise<RunRecord> {
  const a = d.admit;
  const p = dispatchPaths(d.dir);
  // no exit.json: its supervisor died. A cancel asked for before that ended it; anything else is lost.
  const exit: ExitInfo = readExit(d.dir) ?? {
    code: null,
    signal: null,
    reason: existsSync(p.cancel) ? "cancelled" : "lost",
    endedAt: new Date().toISOString(),
  };
  const startedAt = readProc(d.dir)?.startedAt ?? a.admittedAt;
  const reply = text(p.reply);
  const finished: FinishedRun = {
    request: {
      rung: parseRung(a.rung),
      access: a.access,
      thread: a.thread,
      isolated: a.isolated,
      repo: a.repo,
      briefPath: p.brief,
      replyPath: p.reply,
      dispatchDir: d.dir,
    },
    eventLines: lines(p.events),
    reply,
    stderr: text(p.stderr),
    exit,
    startedAtMs: Date.parse(startedAt),
  };
  const adapter = adapterFor(a.backend);
  const first: Outcome = adapter
    ? adapter.finalize(finished)
    : {
        status: "failed",
        thread: a.thread,
        tokens: { ...ZERO_TOKENS },
        costUsd: null,
        images: [],
        error: { code: "E_BACKEND_MISSING", message: `catherd has no ${a.backend} adapter` },
      };
  const o = adapter
    ? await settled(adapter, first, finished, () => priorOn(run, a.backend, first.thread ?? "", a.dispatchId))
    : first;
  // A CLI that streams its reply (claude, opencode) leaves reply.md to catherd.
  if (o.reply !== undefined && o.reply !== reply) writeTextAtomic(p.reply, o.reply);
  const replyText = o.reply ?? reply;
  const start = Date.parse(startedAt);
  const end = Date.parse(exit.endedAt);
  const after = await snapshotOrNull(a.repo);
  const { changedOwned, violations } = after
    ? splitChanges(
        changedPaths(a.before, after),
        a.owns,
        othersOwns(run, d, start, end),
        a.lane !== null || a.access === "read-only",
      )
    : { changedOwned: [], violations: [] };
  const reported = parseReplyStatus(replyText);
  return {
    schema: 1,
    runId: run.id,
    dispatchId: a.dispatchId,
    name: a.name,
    role: a.role,
    lane: a.lane,
    backend: a.backend,
    rung: a.rung,
    attempt: a.attempt,
    failoverFrom: a.failoverFrom,
    thread: o.thread,
    status: o.status,
    startedAt,
    endedAt: exit.endedAt,
    secs: Math.max(0, Math.round((end - start) / 1000)),
    exitCode: exit.code,
    signal: exit.signal,
    cliVersion: a.cliVersion,
    tokens: o.tokens,
    costUsd: o.costUsd,
    changedOwned,
    violations,
    ...(after ? {} : { gitUnavailable: true }),
    replyStatus: reported.status,
    replyWhy: reported.why,
    threadHeavy: o.tokens.input >= THREAD_HEAVY_INPUT,
    access: a.access,
    isolated: a.isolated,
    images: o.images,
    error: o.error,
    replyPath: relative(run.dir, p.reply),
  };
}

/** A fresh thread's first-turn input, for the harness-cost line of runs_summary. */
function recordHarness(run: Run, d: Dispatch, r: RunRecord): void {
  const a = adapterFor(d.admit.backend);
  if (d.admit.thread !== null || !a) return;
  for (const line of lines(dispatchPaths(d.dir).events)) {
    let tokens;
    try {
      tokens = a.parse(line).tokens;
    } catch {
      continue;
    }
    if (!tokens) continue;
    const file = runPaths(run.dir).harness;
    ensureJsonlHeader(file, "harness");
    appendJsonl(file, {
      at: r.endedAt,
      name: r.name,
      backend: r.backend,
      isolated: r.isolated,
      firstTurnInput: tokens.input,
    });
    return;
  }
}

/**
 * Spec §3.3: the first finalizer claims the dispatch and writes its record; any other waits for that
 * record and returns it. If the claimer died before appending, the late finalizer appends instead;
 * appendRecord's per-dispatch dedupe keeps that to one record either way (audit C2). A claimer that throws
 * releases its claim.
 */
export async function finalizeDispatch(run: Run, d: Dispatch): Promise<RunRecord> {
  const existing = readRecords(run).records.find((r) => r.dispatchId === d.admit.dispatchId);
  if (existing) return existing;
  const claimed = tryClaim(d.dir);
  if (!claimed) {
    const theirs = await waitForRecord(
      run,
      d.admit.dispatchId,
      claimAgeMs(d.dir) > CLAIM_STALE_MS ? 0 : 10_000,
    );
    if (theirs) return theirs;
  }
  let saved: RunRecord;
  let mine: RunRecord;
  try {
    mine = await compute(run, d);
    saved = await appendRecord(run, mine);
  } catch (e) {
    // no record: let the next finalizer try at once rather than wait on this claim
    if (claimed) rmSync(dispatchPaths(d.dir).claim, { force: true });
    throw e;
  }
  if (saved === mine) recordHarness(run, d, mine);
  return saved;
}

function lastEvent(d: Dispatch): string | null {
  const a = adapterFor(d.admit.backend);
  const line = lines(dispatchPaths(d.dir).events).at(-1);
  if (!a || !line) return null;
  try {
    return a.parse(line).lastEvent ?? null;
  } catch {
    return null;
  }
}

/** Waits until the dispatch finishes, calling `onTick` every `tickMs`; a throwing onTick never ends the wait. */
export async function waitForFinish(
  d: Dispatch,
  o: {
    pollMs: number;
    tickMs: number;
    now: () => number;
    onTick?: (secs: number, lastEvent: string | null) => void;
  },
): Promise<void> {
  const started = Date.now();
  let ticked = started;
  while (dispatchState(d, o.now()) !== "finished") {
    await Bun.sleep(o.pollMs);
    if (o.onTick && Date.now() - ticked >= o.tickMs) {
      ticked = Date.now();
      try {
        o.onTick(Math.round((ticked - started) / 1000), lastEvent(d));
      } catch {
        // a progress report must never stop the wait
      }
    }
  }
}
