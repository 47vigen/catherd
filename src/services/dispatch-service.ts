import { existsSync, readFileSync, rmSync } from "node:fs";
import { relative } from "node:path";
import { CatherdError, errorMessage, isCatherdError } from "../domain/errors.ts";
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
  endCollect,
  putBackCollect,
} from "../infra/dispatch-dir.ts";
import { log } from "../infra/log.ts";
import { isAlive, isSurelyAlive, killGroup } from "../infra/proc.ts";
import { writeJsonAtomic } from "../infra/store.ts";
import { admit, KILL_GRACE_MS, laneFile, launch } from "./admission.ts";
import { standInFor } from "./backends.ts";
import {
  type Dispatch,
  dispatchState,
  launchPath,
  listDispatches,
  liveDispatches,
  readProc,
} from "./dispatches.ts";
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
  /** the role names to wait on; default: every uncollected dispatch of the run */
  names?: string[];
  /** wait until every one of them has finished, not only the first */
  all?: boolean;
}

export interface WaitResult {
  /** each dispatch that finished, with its record and hints */
  records: DispatchResult[];
  /** failover stand-ins launched for a usage limit, not awaited */
  started: Dispatched[];
  /** every uncollected role of the run this call did not return, running or finished, stand-ins included */
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

/** How a dispatch's supervisor is started; tests replace it to make a launch fail. */
export const launcher = { launch };

/** Marks an admitted dispatch for a `wait` to collect, then starts its supervisor; no mark outlives a failed launch. */
function start(d: Dispatch, specPath: string): void {
  markForCollect(d.dir);
  try {
    launcher.launch(d, specPath);
  } catch (e) {
    rmSync(dispatchPaths(d.dir).collect, { force: true });
    throw e;
  }
}

/** The watchers `dispatch` started, each until its dispatch is finalized. */
const watchers = new Set<Promise<void>>();

/** Settles once every watcher has: tests await it so none outlives its test. */
export async function watchersSettled(): Promise<void> {
  while (watchers.size > 0) await Promise.all(watchers);
}

/**
 * Finalizes a dispatch as soon as it exits and refreshes state.md, as reconcile's watcher does, so its
 * after-snapshot holds only its own writes and the live list and the spend stay true. It never collects
 * the record and never fails over: `wait` does both, once. Its errors are logged; `wait` finalizes then.
 */
function watch(deps: Deps, run: Run, d: Dispatch): void {
  const w = (async () => {
    await waitForFinish(d, { pollMs: deps.pollMs, tickMs: Number.POSITIVE_INFINITY, now: deps.now });
    await finalizeDispatch(run, d);
    const { hints } = await refreshState(run);
    if (hints[0]) log("warn", "dispatch", { run: run.id, name: d.admit.name, hint: hints[0] });
  })()
    .catch((e: unknown) =>
      log("warn", "dispatch", { run: run.id, name: d.admit.name, error: errorMessage(e) }),
    )
    .finally(() => watchers.delete(w));
  watchers.add(w);
}

/**
 * Spec §4.4, plan 9 ruling 1: admit and launch one role, start its watcher, then refresh state.md with
 * `next` (after the launch, so nothing delays it). Returns at once; `wait` collects the record.
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
  watch(deps, run, d);
  const hints: string[] = [];
  await refresh(run, i.next ? { next: i.next } : {}, hints);
  return { dispatched: dispatchedOf(d), hints };
}

const NOTHING = "nothing to wait for: every dispatch of this run has been collected; dispatch a role first";
const nothingFor = (n: string) => `${n} has nothing to collect: result(run, "${n}") reads its last record`;
const takenElsewhere = (n: string) =>
  `${n}: its record went to another call (cancel or wait); result(run, "${n}") reads it`;
const ABORTED = "wait was cancelled: nothing collected";

/** The run's dispatches a `wait` has yet to hand back, read from disk, so a restarted server finds them. */
const uncollected = (run: Run): Dispatch[] => listDispatches(run).filter((d) => awaitsCollect(d.dir));

/** Every uncollected role of the run, running or finished: what a `wait` still has to return. */
const pendingNames = (run: Run): string[] => [...new Set(uncollected(run).map((d) => d.admit.name))];

interface Collected {
  result: DispatchResult;
  started: Dispatched | null;
  pause: string | null;
}

/** The record of a dispatch this wait has collected, with its failover; an unexpected failover error becomes a hint. */
async function collected(deps: Deps, run: Run, d: Dispatch, record: RunRecord): Promise<Collected> {
  if (record.status !== "limit")
    return { result: { record, hints: hintsFor(run, d, record) }, started: null, pause: null };
  try {
    return await failover(deps, run, d, record);
  } catch (e) {
    return {
      result: { record, hints: [...hintsFor(run, d, record), `failover: ${errorMessage(e)}`] },
      started: null,
      pause: `paused: ${record.backend} usage limit; resume when the user says so`,
    };
  }
}

/**
 * Plan 9 ruling 1: blocks until one of the named uncollected dispatches (default: every one of the run)
 * has finished, or every one with `all`; finalizes each (claim-based, so the dispatch's watcher, a cancel,
 * reconcile or another server finalizes it once), hands each record to this wait only, launches a usage
 * limit's stand-in without awaiting it, then refreshes state.md, with the pause a limit calls for.
 * `running` names every uncollected role this call did not return. One dispatch that cannot be finalized
 * becomes a hint and is dropped; an error that still escapes puts back what this call collected, and so
 * does an abort, which returns without collecting.
 */
export async function wait(
  deps: Deps,
  i: WaitInput,
  onProgress?: Progress,
  signal?: AbortSignal,
): Promise<WaitResult> {
  const run = findRun(i.run);
  const names = i.names ? [...new Set(i.names)] : null;
  for (const n of names ?? []) assertId("role name", n);
  const hints: string[] = [];
  const targets = uncollected(run).filter((d) => !names || names.includes(d.admit.name));
  for (const n of names ?? []) if (!targets.some((d) => d.admit.name === n)) hints.push(nothingFor(n));
  if (targets.length === 0) {
    const running = pendingNames(run);
    return { records: [], started: [], running, hints: running.length ? hints : [...hints, NOTHING] };
  }

  const open = new Map(targets.map((d) => [d.admit.dispatchId, d]));
  const taken: Dispatch[] = [];
  const records: DispatchResult[] = [];
  const started: Dispatched[] = [];
  let pause: string | null = null;
  let ticked = Date.now();
  const putBack = () => {
    for (const d of taken) putBackCollect(d.dir);
  };
  try {
    for (;;) {
      if (signal?.aborted) {
        putBack();
        return { records: [], started: [], running: pendingNames(run), hints: [ABORTED] };
      }
      const recorded = new Set(readRecords(run).records.map((r) => r.dispatchId));
      for (const d of open.values()) {
        if (!recorded.has(d.admit.dispatchId) && dispatchState(d, deps.now()) !== "finished") continue;
        open.delete(d.admit.dispatchId);
        let record: RunRecord;
        try {
          record = await finalizeDispatch(run, d);
        } catch (e) {
          // dropped, not retried: one dispatch that cannot be finalized must not hold every later wait
          if (await tryCollect(d.dir)) {
            endCollect(d.dir);
            hints.push(
              `${d.admit.name}: not finalized: ${errorMessage(e)}; result(run, "${d.admit.name}") reads its record once it has one`,
            );
          }
          continue;
        }
        if (signal?.aborted) break;
        if (!(await tryCollect(d.dir))) {
          hints.push(takenElsewhere(d.admit.name));
          continue;
        }
        taken.push(d);
        const c = await collected(deps, run, d, record);
        records.push(c.result);
        if (c.started) started.push(c.started);
        if (c.pause) pause = c.pause;
      }
      if (signal?.aborted) continue;
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
  } catch (e) {
    putBack();
    throw e;
  }
  // aborted during the refresh: the result would reach no one, so put back what it collected
  if (signal?.aborted) {
    putBack();
    return { records: [], started: [], running: pendingNames(run), hints: [ABORTED] };
  }
  // in the order the roles finished, however the polls happened to see them
  records.sort((a, b) => Date.parse(a.record.endedAt) - Date.parse(b.record.endedAt));
  // the leases end only now, with the failovers launched and state.md refreshed: a crash before this
  // leaves each lease to a dead owner, and the next wait collects that record again
  for (const d of taken) endCollect(d.dir);
  return { records, started, running: pendingNames(run), hints };
}

/** Whether a dispatch was started: launched, running, or marked (or leased) for a wait by `start`. */
function launched(d: Dispatch): boolean {
  const p = dispatchPaths(d.dir);
  return (
    existsSync(launchPath(d.dir)) || readProc(d.dir) !== null || existsSync(p.collect) || existsSync(p.lease)
  );
}

const recordOf = (run: Run, d: Dispatch): boolean =>
  readRecords(run).records.some((r) => r.dispatchId === d.admit.dispatchId);

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
 * included), without awaiting it. A stand-in that hits a limit too pauses the run. A stand-in already
 * launched for this record (by a wait whose collection was put back) is reused, never launched twice.
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
  const failedOver = (standIn: string, next: Dispatch): Collected => ({
    result: result([
      `limit: ${limited.rung} hit a usage limit; failed over to ${standIn}`,
      // the stand-in's before-snapshot already holds the limited run's writes: surface them here
      ...hints.filter((h) => /^(violation|git-unavailable):/.test(h)),
    ]),
    started: dispatchedOf(next),
    pause: null,
  });
  // tied to this limited dispatch's id: a later dispatch of the same name, rung and limit is not its stand-in
  const already = listDispatches(run)
    .filter((x) => x.admit.failoverOf === d.admit.dispatchId)
    .at(-1);
  if (already && launched(already)) return failedOver(already.admit.rung, already);
  if (already && !recordOf(run, already) && dispatchState(already, deps.now()) === "starting") {
    // admitted by a collector that died before launching it: launch it now, never report it unlaunched
    start(already, dispatchPaths(already.dir).spec);
    watch(deps, run, already);
    return failedOver(already.admit.rung, already);
  }
  // else that stand-in never ran and is over (recorded as lost, or past its start grace): admit a new one
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
      failoverOf: d.admit.dispatchId,
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
  watch(deps, run, next.d);
  return failedOver(standIn, next.d);
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

/**
 * Spec §4.7: stop a live dispatch (interrupt, SIGTERM, SIGKILL) and record it as cancelled. It collects the
 * record it returns, so no later `wait` returns it again.
 */
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
  const mine = await tryCollect(live.dir);
  // cancel returns at once, so its lease ends at once
  if (mine) endCollect(live.dir);
  const also = mine ? [] : [`${name}: a wait in flight also returned this record`];
  const { hints } = await refreshState(run);
  return { record, hints: [...hintsFor(run, live, record), ...also, ...hints] };
}
