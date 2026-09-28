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
import { dispatchPaths, readClaimant, readExit, tryClaim } from "../infra/dispatch-dir.ts";
import { isAlive } from "../infra/proc.ts";
import { withFileLock } from "../infra/filelock.ts";
import { gitLimits, statusSnapshot } from "../infra/git.ts";
import {
  appendJsonl,
  ensureJsonlHeader,
  makePrivate,
  nonBlankLines,
  writeTextAtomic,
} from "../infra/store.ts";
import { type Dispatch, dispatchState, listDispatches, readProc } from "./dispatches.ts";
import { appendRecord, readRecords, recordsOnThread, type Run, runPaths } from "./run-store.ts";

const text = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

function claimAgeMs(dir: string): number {
  try {
    return Date.now() - statSync(dispatchPaths(dir).claim).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Whether another finalizer's claim may be taken over: its claimant is dead, or the claim is older than
 * the longest a live claimant can take: every bounded step of `compute` (the adapter's settle, the one
 * `git status` snapshot, each at its own timeout) plus the margin for its unbounded file work. A claim
 * that names no one (an older build's) is judged by its age alone.
 */
function claimStale(dir: string): boolean {
  const who = readClaimant(dir);
  if (who && !isAlive(who.pid, who.startTime)) return true;
  return claimAgeMs(dir) > settleLimits.timeoutMs + gitLimits.timeoutMs + settleLimits.claimMarginMs;
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

/**
 * How long a backend may take to settle a finished session before its stream's own figures stand, and
 * how much longer than that and the git snapshot's timeout (gitLimits) a finalizer's claim may live (its file
 * work and the append) before a second finalizer takes it over.
 */
export const settleLimits = { timeoutMs: 20_000, claimMarginMs: 10_000 };

/**
 * What earlier records on `thread` already counted: a resumed session's totals repeat them. Every run's,
 * since a role may resume a thread an earlier catherd run started.
 */
function priorOn(run: Run, backend: string, thread: string, self: string): Spent {
  const earlier = recordsOnThread(run, backend, thread).filter((r) => r.dispatchId !== self);
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
    eventLines: nonBlankLines(p.events),
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
  // one the CLI wrote itself (codex) has the CLI's mode
  else makePrivate(p.reply);
  const replyText = o.reply ?? reply;
  const start = Date.parse(startedAt);
  const end = Date.parse(exit.endedAt);
  const after = await snapshotOrNull(a.repo);
  const { changedOwned, violations } = after
    ? splitChanges(
        changedPaths(a.before, after),
        a.owns,
        // from admission, when the before-snapshot was taken, not from the worker's start
        othersOwns(run, d, Date.parse(a.admittedAt), end),
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

/**
 * A fresh thread's first-turn input, for the harness-cost line of runs_summary: its first model request's
 * input, from a backend whose stream reports usage per request. Codex reports it per exec: no row.
 */
function recordHarness(run: Run, d: Dispatch, r: RunRecord): void {
  const a = adapterFor(d.admit.backend);
  if (d.admit.thread !== null || !a) return;
  for (const line of nonBlankLines(dispatchPaths(d.dir).events)) {
    let input;
    try {
      input = a.parse(line).requestInput;
    } catch {
      continue;
    }
    if (input === undefined) continue;
    const file = runPaths(run.dir).harness;
    ensureJsonlHeader(file, "harness");
    appendJsonl(file, {
      at: r.endedAt,
      name: r.name,
      backend: r.backend,
      isolated: r.isolated,
      firstTurnInput: input,
    });
    return;
  }
}

/**
 * Spec §3.3: the first finalizer claims the dispatch and writes its record; any other waits for that
 * record and returns it. If the claimer died before appending, the late finalizer appends instead;
 * appendRecord's per-dispatch dedupe keeps that to one record either way (audit C2). A claimer that throws
 * releases its claim.
 *
 * In this process, a second finalizer (`cancel` beside the dispatch's watcher) joins the first one's
 * promise. Across processes it waits for the claimant's record, and takes over only once the claim is
 * stale (claimant dead, or past its settle window): never while a live claimant may still be settling.
 */
export function finalizeDispatch(run: Run, d: Dispatch): Promise<RunRecord> {
  const id = d.admit.dispatchId;
  const joined = inFlight.get(id);
  if (joined) return joined;
  const p = finalizeOnce(run, d).finally(() => inFlight.delete(id));
  inFlight.set(id, p);
  return p;
}

/** This process's finalizes in flight, by dispatch id. */
const inFlight = new Map<string, Promise<RunRecord>>();

const recordOf = (run: Run, id: string): RunRecord | undefined =>
  readRecords(run).records.find((r) => r.dispatchId === id);

/** Test seam: runs after a finalizer judged a claim stale, before it takes the lock to take it over. */
export const claimSeams = { beforeTakeover: async (_dir: string): Promise<void> => {} };

/**
 * Takes over a stale claim, serialized by a lock on the claim: under it, reads the claim again, removes it
 * only if it is still stale, and claims it. True for the one caller that now holds the claim; a caller that
 * finds it live (another took it over, or its claimant woke) or loses the claim to a fresh claimant gets
 * false and goes back to waiting for the record. A claim is removed only here and by its own claimant, and
 * here only right before claiming it, so there is never a second live computer, and never none for long:
 * a claim that vanished is claimed by the next finalizer's poll.
 */
export async function takeOverStaleClaim(dir: string): Promise<boolean> {
  const claim = dispatchPaths(dir).claim;
  return withFileLock(claim, () => {
    if (existsSync(claim)) {
      if (!claimStale(dir)) return false;
      rmSync(claim, { force: true });
    }
    return tryClaim(dir);
  });
}

async function finalizeOnce(run: Run, d: Dispatch): Promise<RunRecord> {
  for (;;) {
    const existing = recordOf(run, d.admit.dispatchId);
    if (existing) return existing;
    // a claim released by a claimer that threw is gone: this claims it
    if (tryClaim(d.dir)) break;
    if (existsSync(dispatchPaths(d.dir).claim) && claimStale(d.dir)) {
      await claimSeams.beforeTakeover(d.dir);
      if (await takeOverStaleClaim(d.dir)) break;
      continue;
    }
    await Bun.sleep(50);
  }
  let saved: RunRecord;
  let mine: RunRecord;
  try {
    mine = await compute(run, d);
    saved = await appendRecord(run, mine);
  } catch (e) {
    // no record: let the next finalizer try at once rather than wait on this claim; ours only, since a
    // claim held past its window may have been taken over
    if (readClaimant(d.dir)?.pid === process.pid) rmSync(dispatchPaths(d.dir).claim, { force: true });
    throw e;
  }
  if (saved === mine) recordHarness(run, d, mine);
  return saved;
}

/** The last event of a running dispatch worth showing (peek, the runs page), if any. */
export function lastEvent(d: Dispatch): string | null {
  const a = adapterFor(d.admit.backend);
  const line = nonBlankLines(dispatchPaths(d.dir).events).at(-1);
  if (!a || !line) return null;
  try {
    return a.parse(line).lastEvent ?? null;
  } catch {
    return null;
  }
}

/** Waits until the dispatch finishes, polling every `pollMs`. */
export async function waitForFinish(d: Dispatch, o: { pollMs: number; now: () => number }): Promise<void> {
  while (dispatchState(d, o.now()) !== "finished") await Bun.sleep(o.pollMs);
}
