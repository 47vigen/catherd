import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { CatherdError, isCatherdError } from "../domain/errors.ts";
import { assertId, parseRung } from "../domain/ids.ts";
import { dispatchHints } from "../domain/hints.ts";
import type { RunRecord } from "../domain/record.ts";
import type { Role } from "../domain/roles.ts";
import {
  awaitsCollect,
  dispatchPaths,
  markForCollect,
  readExit,
  requestCancel,
  tryCollect,
} from "../infra/dispatch-dir.ts";
import { isAlive, isSurelyAlive, killGroup } from "../infra/proc.ts";
import { writeJsonAtomic } from "../infra/store.ts";
import { admit, KILL_GRACE_MS, laneFile, launch } from "./admission.ts";
import { standInFor } from "./backends.ts";
import { type Dispatch, dispatchState, listDispatches, liveDispatches, readProc } from "./dispatches.ts";
import { finalizeDispatch, lastEvent, waitForFinish } from "./finalize.ts";
import type { Deps } from "./ports.ts";
import { findRun, readRecords, type Run } from "./run-store.ts";
import { type NotesPatch, refreshState } from "./state.ts";

export interface DispatchInput {
  run: string;
  role: Role;
  name: string;
  brief: string;
  rung: string;
  thread?: string;
  lane?: string;
  next?: string;
}

/** One finished dispatch: its record and what to do next. */
export interface DispatchResult {
  record: RunRecord;
  hints: string[];
}

/** A dispatch that has been admitted and launched. */
export interface Dispatched {
  name: string;
  role: Role;
  rung: string;
  dispatchId: string;
  admittedAt: string;
}

export interface DispatchStarted {
  dispatched: Dispatched;
  hints: string[];
}

export interface WaitInput {
  run: string;
  /** the role names to wait on; default: every live dispatch of the run */
  names?: string[];
  /** wait until every one of them has finished, not only the first */
  all?: boolean;
}

export interface WaitResult {
  /** each dispatch that finished, with its record and hints */
  records: DispatchResult[];
  /** failover stand-ins launched for a usage limit, not awaited */
  started: Dispatched[];
  /** the names of the run's dispatches still running, stand-ins included */
  running: string[];
  hints: string[];
}

export type Progress = (message: string) => void;

const hintsFor = (run: Run, d: Dispatch, r: RunRecord) =>
  dispatchHints(r, d.admit.owns, relative(run.dir, d.dir));

const dispatchedOf = (d: Dispatch): Dispatched => ({
  name: d.admit.name,
  role: d.admit.role,
  rung: d.admit.rung,
  dispatchId: d.admit.dispatchId,
  admittedAt: d.admit.admittedAt,
});

/** Refreshes state.md (spec §4.5 notes kept on a git failure); a refresh that fails adds its hint once. */
async function refresh(run: Run, change: NotesPatch, hints: string[]): Promise<void> {
  for (const h of (await refreshState(run, change)).hints) if (!hints.includes(h)) hints.push(h);
}

/** Marks an admitted dispatch for a `wait` to collect, then starts its supervisor. */
function start(d: Dispatch, specPath: string): void {
  markForCollect(d.dir);
  launch(d, specPath);
}

/**
 * Spec §4.4, plan 9 ruling 1: admit and launch one role, then refresh state.md with `next` (after the
 * launch, so nothing delays it). Returns at once; `wait` collects the record.
 */
export async function dispatch(deps: Deps, i: DispatchInput): Promise<DispatchStarted> {
  const run = findRun(i.run);
  const { d, specPath } = await admit(deps, run, {
    role: i.role,
    name: i.name,
    brief: i.brief,
    rung: i.rung,
    thread: i.thread ?? null,
    lane: i.lane ?? null,
    failoverFrom: null,
  });
  start(d, specPath);
  const hints: string[] = [];
  await refresh(run, i.next ? { next: i.next } : {}, hints);
  return { dispatched: dispatchedOf(d), hints };
}

const NOTHING = "nothing to wait for: no dispatch of this run is running; dispatch a role first";

/** The run's dispatches a `wait` has yet to hand back, read from disk, so a restarted server finds them. */
const uncollected = (run: Run): Dispatch[] => listDispatches(run).filter((d) => awaitsCollect(d.dir));

/** Of the uncollected dispatches, the names of those still running. */
function runningNames(run: Run, now: number): string[] {
  const recorded = new Set(readRecords(run).records.map((r) => r.dispatchId));
  return uncollected(run)
    .filter((d) => !recorded.has(d.admit.dispatchId) && dispatchState(d, now) !== "finished")
    .map((d) => d.admit.name);
}

interface Collected {
  result: DispatchResult;
  started: Dispatched | null;
  pause: string | null;
}

/**
 * Plan 9 ruling 1: blocks until one of the named uncollected dispatches (default: every one of the run)
 * has finished, or every one with `all`; finalizes each (claim-based, so a concurrent cancel, reconcile or
 * other server finalizes it once), hands each record to this wait only, launches a usage limit's stand-in
 * without awaiting it, then refreshes state.md, with the pause a limit calls for.
 */
export async function wait(deps: Deps, i: WaitInput, onProgress?: Progress): Promise<WaitResult> {
  const run = findRun(i.run);
  const names = i.names ? [...new Set(i.names)] : null;
  for (const n of names ?? []) assertId("role name", n);
  const hints: string[] = [];
  const targets = uncollected(run).filter((d) => !names || names.includes(d.admit.name));
  for (const n of names ?? [])
    if (!targets.some((d) => d.admit.name === n))
      hints.push(`${n} is not running: result(run, "${n}") reads its last record`);
  if (targets.length === 0) return { records: [], started: [], running: [], hints: [...hints, NOTHING] };

  const open = new Map(targets.map((d) => [d.admit.dispatchId, d]));
  const records: DispatchResult[] = [];
  const started: Dispatched[] = [];
  let pause: string | null = null;
  let ticked = Date.now();
  for (;;) {
    const recorded = new Set(readRecords(run).records.map((r) => r.dispatchId));
    for (const d of open.values()) {
      if (!recorded.has(d.admit.dispatchId) && dispatchState(d, deps.now()) !== "finished") continue;
      open.delete(d.admit.dispatchId);
      const record = await finalizeDispatch(run, d);
      if (!tryCollect(d.dir)) {
        hints.push(`${d.admit.name}: another wait returned its record`);
        continue;
      }
      const c: Collected =
        record.status === "limit"
          ? await failover(deps, run, d, record)
          : { result: { record, hints: hintsFor(run, d, record) }, started: null, pause: null };
      records.push(c.result);
      if (c.started) started.push(c.started);
      if (c.pause) pause = c.pause;
    }
    if (open.size === 0 || (!i.all && records.length > 0)) break;
    await Bun.sleep(deps.pollMs);
    if (onProgress && Date.now() - ticked >= deps.tickMs) {
      ticked = Date.now();
      for (const d of open.values()) {
        const secs = Math.max(0, Math.round((ticked - Date.parse(d.admit.admittedAt)) / 1000));
        const ev = lastEvent(d);
        try {
          onProgress(`${d.admit.name} · ${d.admit.rung} · ${secs}s${ev ? ` · ${ev}` : ""}`);
        } catch {
          // a progress report must never stop the wait
        }
      }
    }
  }
  await refresh(run, pause ? { next: pause } : {}, hints);
  return { records, started, running: runningNames(run, deps.now()), hints };
}

/**
 * The stand-in's brief (spec §4.5, audit C4). A fresh round reruns its own brief; a fix round hands
 * over the lane file and the fix brief by path, since the stand-in cannot resume the old thread.
 */
function standInBrief(run: Run, d: Dispatch): string {
  const own = dispatchPaths(d.dir).brief;
  if (d.admit.thread === null) return readFileSync(own, "utf8");
  return [
    `You take over ${d.admit.name} from ${d.admit.rung}, which hit a usage limit. You start on a fresh thread, so read these first:`,
    ...(d.admit.lane ? [`- the lane file: ${laneFile(run, d.admit.lane)}`] : []),
    `- the fix brief the previous thread was given: ${own}`,
    "The work so far is in the tree. Do what the fix brief asks.",
  ].join("\n");
}

/**
 * Spec §4.5: on a limit, launch the rung's stand-in on a fresh thread, through admission again (budget
 * included), without awaiting it. A stand-in that hits a limit too pauses the run.
 */
async function failover(deps: Deps, run: Run, d: Dispatch, limited: RunRecord): Promise<Collected> {
  const hints = hintsFor(run, d, limited);
  const result = (h: string[]): DispatchResult => ({ record: limited, hints: h });
  if (d.admit.failoverFrom !== null)
    return {
      result: result(hints),
      started: null,
      pause: `paused: ${limited.backend} usage limit on ${limited.rung} and on ${d.admit.failoverFrom}`,
    };
  const paused = `paused: ${limited.backend} usage limit; resume when the user says so`;
  const standIn = standInFor(deps.profiles.forRepo(run.meta.repo).failover, limited.rung, run.meta.repo);
  if (!standIn) return { result: result(hints), started: null, pause: paused };
  if (parseRung(standIn).backend === "claude") {
    const agent = deps.profiles.agentFor(run.meta.repo, d.admit.role, standIn);
    return {
      result: result([
        ...hints,
        `failover: run ${d.admit.name} as Agent(subagent_type: "${agent}"), standing in for ${limited.rung}`,
      ]),
      started: null,
      pause: null,
    };
  }
  let next: Awaited<ReturnType<typeof admit>>;
  try {
    next = await admit(deps, run, {
      role: d.admit.role,
      name: d.admit.name,
      brief: standInBrief(run, d),
      rung: standIn,
      thread: null,
      lane: d.admit.lane,
      failoverFrom: limited.rung,
    });
  } catch (e) {
    if (!isCatherdError(e)) throw e;
    return {
      result: result([...hints, `failover: ${standIn} refused: ${e.code} ${e.message}`]),
      started: null,
      pause: paused,
    };
  }
  start(next.d, next.specPath);
  return {
    result: result([
      `limit: ${limited.rung} hit a usage limit; failed over to ${standIn}`,
      // the stand-in's before-snapshot already holds the limited run's writes: surface them here
      ...hints.filter((h) => /^(violation|git-unavailable):/.test(h)),
    ]),
    started: dispatchedOf(next.d),
    pause: null,
  };
}

/** How long an orphaned worker gets between SIGTERM and SIGKILL; tests shorten it. */
export const orphanLimits = { killGraceMs: KILL_GRACE_MS };

/**
 * A worker whose supervisor died has no one to read the cancel file: stop its group here (SIGTERM, then
 * SIGKILL after the grace), each signal guarded by the worker's pid and start time, and write the
 * exit.json the supervisor would have, with the signal that ended it. A worker catherd cannot identify
 * (no start time, or a proc.json whose pgid is not the worker's own pid) is never signalled: its pid may
 * belong to someone else by now, so the dispatch is only recorded as cancelled. A finalizer that sees the
 * worker gone first reads the cancel file instead (finalize.ts). Nothing happens while the supervisor
 * lives: it acts on the cancel file itself.
 */
async function stopOrphan(deps: Deps, d: Dispatch): Promise<void> {
  const proc = readProc(d.dir);
  if (!proc || readExit(d.dir) || isAlive(proc.supervisorPid, proc.supervisorStartTime)) return;
  const worker = () => isAlive(proc.pid, proc.startTime);
  // a signal needs the start time read back exactly: a pid whose start time cannot be read now may be reused
  const surely = () => isSurelyAlive(proc.pid, proc.startTime);
  if (!worker()) return;
  let signal: NodeJS.Signals | null = null;
  if (proc.startTime !== null && (proc.pgid === undefined || proc.pgid === proc.pid)) {
    if (surely()) {
      signal = "SIGTERM";
      killGroup(proc.pid, signal);
    }
    const end = Date.now() + orphanLimits.killGraceMs;
    while (signal && Date.now() < end && worker()) await Bun.sleep(deps.pollMs);
    if (signal && worker() && surely()) {
      signal = "SIGKILL";
      killGroup(proc.pid, signal);
    }
  }
  writeJsonAtomic(dispatchPaths(d.dir).exit, {
    schema: 1,
    code: null,
    signal,
    reason: "cancelled",
    endedAt: new Date().toISOString(),
  });
}

/** Spec §4.7: stop a live dispatch (interrupt, SIGTERM, SIGKILL) and record it as cancelled. */
export async function cancel(deps: Deps, runId: string, name: string): Promise<DispatchResult> {
  const run = findRun(runId);
  assertId("role name", name);
  const live = liveDispatches(run, deps.now()).find((d) => d.admit.name === name);
  if (!live)
    throw new CatherdError("E_RUN_NOT_LIVE", `${name} has no live dispatch`, {
      fix: "status(run) lists the live ones",
    });
  requestCancel(live.dir);
  await stopOrphan(deps, live);
  await waitForFinish(live, { pollMs: deps.pollMs, tickMs: Number.POSITIVE_INFINITY, now: deps.now });
  const record = await finalizeDispatch(run, live);
  const { hints } = await refreshState(run);
  return { record, hints: [...hintsFor(run, live, record), ...hints] };
}
