import { existsSync, readFileSync } from "node:fs";
import { CatherdError, errorMessage, isCatherdError } from "../domain/errors.ts";
import { assertId, parseRung } from "../domain/ids.ts";
import type { RunRecord } from "../domain/record.ts";
import type { Role } from "../domain/roles.ts";
import {
  awaitsCollect,
  dispatchPaths,
  endCollect,
  readExit,
  requestCancel,
  supervisorAlive,
  tryCollect,
} from "../infra/dispatch-dir.ts";
import { withFileLock } from "../infra/filelock.ts";
import { log } from "../infra/log.ts";
import { isAlive, isSurelyAlive, killGroup } from "../infra/proc.ts";
import { writeJsonAtomic } from "../infra/store.ts";
import { admit, KILL_GRACE_MS, laneFile, launch } from "./admission.ts";
import { standInFor } from "./backends.ts";
import {
  type Dispatch,
  dispatchState,
  type FailoverFile,
  launchPath,
  listDispatches,
  liveDispatches,
  pendingDispatches,
  readFailover,
  readProc,
  recordHints,
} from "./dispatches.ts";
import { finalizeDispatch, waitForFinish } from "./finalize.ts";
import type { Deps } from "./ports.ts";
import { findRun, readRecords, type Run } from "./run-store.ts";
import { claimRun } from "./sessions.ts";
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

/**
 * A finalized dispatch once catherd has acted on it (spec §3.4): its record, its hints, and for a usage limit
 * what failover did: the stand-in it launched, or the pause it wrote.
 */
export interface Settled {
  run: Run;
  d: Dispatch;
  record: RunRecord;
  hints: string[];
  started: Dispatched | null;
  pause: string | null;
  /** state.md's refresh failed: its hint (the notes are kept in state.json) */
  stateHints: string[];
}

/**
 * Called with every dispatch this process settles, once each (the notifier, services/notifier.ts, is one). A
 * hook that throws is logged and never stops the others.
 */
export const settledHooks = new Set<(s: Settled) => void | Promise<void>>();

/** A live dispatch whose supervisor reported a stall (spec §3.6: quiet for half its idle timeout, not busy). */
export interface Stalled {
  run: Run;
  d: Dispatch;
  /** how long it had been quiet when the supervisor noticed */
  quietMs: number;
}

/** Called once per watcher when its dispatch's stall.json appears (the notifier is one). */
export const stallHooks = new Set<(s: Stalled) => void>();

/** A watcher's poll: the first time the dispatch's stall.json is there, every stall hook hears of it. */
export function stallPoll(run: Run, d: Dispatch): () => void {
  let seen = false;
  return () => {
    if (seen || !existsSync(dispatchPaths(d.dir).stall)) return;
    seen = true;
    let quietMs = 0;
    try {
      quietMs = Number(JSON.parse(readFileSync(dispatchPaths(d.dir).stall, "utf8")).quietMs) || 0;
    } catch {
      // being written: the stall is reported without its length
    }
    for (const hook of stallHooks) {
      try {
        hook({ run, d, quietMs });
      } catch (e) {
        log("warn", "stall", { run: run.id, name: d.admit.name, error: errorMessage(e) });
      }
    }
  };
}

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

/**
 * Starts an admitted dispatch's supervisor. Admission already left its collect mark, and a launch that
 * throws keeps it: the dispatch is recorded as lost once its start grace passes, and `result` reads that
 * record, as the error says.
 */
function start(d: Dispatch, specPath: string): void {
  try {
    launcher.launch(d, specPath);
  } catch (e) {
    throw new CatherdError("E_IO_UNEXPECTED", `could not launch ${d.admit.name}: ${errorMessage(e)}`, {
      fix: `result(run, "${d.admit.name}") reads its record, lost, once its start grace passes (30 s); then dispatch it again`,
    });
  }
}

/** The watchers this process started, each until its dispatch is settled. */
const watchers = new Set<Promise<void>>();
/** The dispatches some watcher of this process is on (this module's, or reconcile's): watched once each. */
export const watching = new Set<string>();

/** Settles once every watcher has: tests await it so none outlives its test. */
export async function watchersSettled(): Promise<void> {
  while (watchers.size > 0) await Promise.all(watchers);
}

/**
 * Finalizes a dispatch as soon as it exits and settles it (failover, state.md, the settled hooks), so its
 * after-snapshot holds only its own writes and the live list and the spend stay true. Its errors are logged.
 */
export function watch(deps: Deps, run: Run, d: Dispatch): void {
  watching.add(d.admit.dispatchId);
  const w = (async () => {
    await waitForFinish(d, { pollMs: deps.pollMs, now: deps.now, onPoll: stallPoll(run, d) });
    const s = await settle(deps, run, d, await finalizeDispatch(run, d));
    if (s.stateHints[0]) log("warn", "dispatch", { run: run.id, name: d.admit.name, hint: s.stateHints[0] });
  })()
    .catch((e: unknown) =>
      log("warn", "dispatch", { run: run.id, name: d.admit.name, error: errorMessage(e) }),
    )
    .finally(() => {
      watchers.delete(w);
      watching.delete(d.admit.dispatchId);
    });
  watchers.add(w);
}

/**
 * Spec §3.3: a run this session has just taken over may have roles another session's server launched. This
 * process watches each live one it is not already watching, so it settles them and its notifier announces them
 * to their new owner (a second settle of a dispatch is harmless: finalize and failover run once).
 */
export function adopt(deps: Deps, run: Run): void {
  for (const d of liveDispatches(run, deps.now())) if (!watching.has(d.admit.dispatchId)) watch(deps, run, d);
}

/**
 * Spec §3.3 with the plan 10 fix-round ruling: `dispatch` and `peek` on a run make this session its owner. When
 * the owner changes, this session takes over what the run's earlier owner left: it watches the live roles
 * (`adopt`), records and settles each role that finished with no record, settles each unread usage limit
 * that was never failed over, and settles again each unread record no message announced (the earlier owner's
 * server settled it but never told its session). Each settle runs the hooks, so the notifier tells the new
 * owner. A settle that fails is logged and never fails the call.
 */
export async function claim(deps: Deps, run: Run): Promise<void> {
  if (!(await claimRun(deps, run))) return;
  adopt(deps, run);
  const warn = (d: Dispatch, e: unknown) =>
    log("warn", "claim", { run: run.id, name: d.admit.name, error: errorMessage(e) });
  for (const d of pendingDispatches(run, deps.now())) {
    if (d.state !== "finished" || watching.has(d.admit.dispatchId)) continue;
    try {
      await settle(deps, run, d, await finalizeDispatch(run, d));
    } catch (e) {
      warn(d, e);
    }
  }
  const limits = unsettledLimits(run);
  for (const { d, record } of limits) {
    try {
      await settle(deps, run, d, record);
    } catch (e) {
      warn(d, e);
    }
  }
  const done = new Set(limits.map((l) => l.d.admit.dispatchId));
  for (const { d, record } of unannounced(run)) {
    if (done.has(d.admit.dispatchId) || watching.has(d.admit.dispatchId)) continue;
    try {
      await settle(deps, run, d, record);
    } catch (e) {
      warn(d, e);
    }
  }
}

/** The recorded dispatches of a run still unread that no message announced (no notified.json). */
function unannounced(run: Run): { d: Dispatch; record: RunRecord }[] {
  const records = new Map(readRecords(run).records.map((r) => [r.dispatchId, r]));
  return listDispatches(run).flatMap((d) => {
    const record = records.get(d.admit.dispatchId);
    return record && awaitsCollect(d.dir) && !existsSync(dispatchPaths(d.dir).notified)
      ? [{ d, record }]
      : [];
  });
}

/**
 * Spec §4.4, plan 9 ruling 1: admit and launch one role, start its watcher, then refresh state.md with
 * `next` (after the launch, so nothing delays it). Returns at once; catherd announces the record (spec §3).
 */
export async function dispatch(deps: Deps, i: DispatchInput): Promise<DispatchStarted> {
  const run = findRun(i.run);
  await claim(deps, run);
  const { d, specPath } = await admit(
    deps,
    run,
    {
      role: i.role,
      name: i.name,
      brief: i.brief,
      rung: i.rung,
      thread: i.thread ?? null,
      lane: i.lane ?? null,
      failoverFrom: null,
    },
    // a finished role no watcher here covers, recorded by admit: settled as a watcher would, so its owner hears
    async (f, record) => {
      if (!watching.has(f.admit.dispatchId)) await settle(deps, run, f, record);
    },
  );
  try {
    start(d, specPath);
  } finally {
    // a launch that failed is still watched: its record (lost, after the start grace) is announced
    watch(deps, run, d);
  }
  const hints: string[] = [];
  await refresh(run, i.next ? { next: i.next } : {}, hints);
  return { dispatched: dispatchedOf(d), hints };
}

/** A failover's outcome before it is written down. */
interface Outcome {
  hints: string[];
  started: Dispatched | null;
  pause: string | null;
}

/**
 * Spec §3.4 (plan 10): what catherd does once a dispatch is finalized, whoever finalized it (its watcher,
 * reconcile after a restart): a usage limit fails over (once per limited dispatch, under a lock, its outcome
 * written to failover.json so a second settle or a restarted server reuses it), state.md is refreshed with the
 * pause a limit calls for (a refresh that fails comes back in `stateHints`), and every settled hook runs. Never
 * throws for a hook.
 */
export async function settle(deps: Deps, run: Run, d: Dispatch, record: RunRecord): Promise<Settled> {
  let o: Outcome = { hints: recordHints(run, d, record), started: null, pause: null };
  if (record.status === "limit") {
    try {
      o = await withFileLock(dispatchPaths(d.dir).failover, () => failoverOnce(deps, run, d, record), {
        timeoutMs: 120_000,
      });
    } catch (e) {
      o = {
        hints: [...o.hints, `failover: ${errorMessage(e)}`],
        started: null,
        pause: `paused: ${record.backend} usage limit; resume when the user says so`,
      };
    }
  }
  const stateHints: string[] = [];
  await refresh(run, o.pause ? { next: o.pause } : {}, stateHints);
  const s: Settled = { run, d, record, hints: o.hints, started: o.started, pause: o.pause, stateHints };
  for (const hook of settledHooks) {
    try {
      await hook(s);
    } catch (e) {
      log("warn", "settle", { run: run.id, name: d.admit.name, error: errorMessage(e) });
    }
  }
  return s;
}

/** Under the failover lock: the outcome already written, else a failover run now and written down. */
async function failoverOnce(deps: Deps, run: Run, d: Dispatch, record: RunRecord): Promise<Outcome> {
  const done = readFailover(d.dir);
  if (done) {
    const next = done.standIn
      ? listDispatches(run).find((x) => x.admit.dispatchId === done.standIn?.dispatchId)
      : undefined;
    return { hints: done.hints, started: next ? dispatchedOf(next) : null, pause: done.pause };
  }
  let o: Outcome;
  try {
    o = await failover(deps, run, d, record);
  } catch (e) {
    o = {
      hints: [...recordHints(run, d, record), `failover: ${errorMessage(e)}`],
      started: null,
      pause: `paused: ${record.backend} usage limit; resume when the user says so`,
    };
  }
  const file: FailoverFile = {
    schema: 1,
    at: new Date(deps.now()).toISOString(),
    standIn: o.started ? { dispatchId: o.started.dispatchId, rung: o.started.rung } : null,
    hints: o.hints,
    pause: o.pause,
  };
  writeJsonAtomic(dispatchPaths(d.dir).failover, file);
  return o;
}

/**
 * Whether a dispatch has concrete launch evidence: a live supervisor holding its lock (taken first thing),
 * launch.json (written by `launch` right after the spawn), proc.json (written by the supervisor once its
 * worker runs) or exit.json. Not the collect mark: admission writes the mark before any launch.
 */
function launched(d: Dispatch): boolean {
  return (
    supervisorAlive(d.dir) ||
    existsSync(launchPath(d.dir)) ||
    readProc(d.dir) !== null ||
    readExit(d.dir) !== null
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
 * admitted for this record (by a settle that died before writing failover.json) is reused, never launched
 * twice.
 */
async function failover(deps: Deps, run: Run, d: Dispatch, limited: RunRecord): Promise<Outcome> {
  const hints = recordHints(run, d, limited);
  if (d.admit.failoverFrom !== null)
    return {
      hints,
      started: null,
      pause: `paused: ${limited.backend} usage limit on ${limited.rung} and on ${d.admit.failoverFrom}`,
    };
  const paused = `paused: ${limited.backend} usage limit; resume when the user says so`;
  const failedOver = (standIn: string, next: Dispatch): Outcome => ({
    hints: [
      `limit: ${limited.rung} hit a usage limit; failed over to ${standIn}`,
      // the stand-in's before-snapshot already holds the limited run's writes: surface them here
      ...hints.filter((h) => /^(violation|git-unavailable):/.test(h)),
    ],
    started: dispatchedOf(next),
    pause: null,
  });
  // tied to this limited dispatch's id: a later dispatch of the same name, rung and limit is not its stand-in
  const already = listDispatches(run)
    .filter((x) => x.admit.failoverOf === d.admit.dispatchId)
    .at(-1);
  if (already && launched(already)) return failedOver(already.admit.rung, already);
  if (already && !recordOf(run, already) && dispatchState(already, deps.now()) === "starting") {
    // Admitted by a settle that died before launching it: launch it now, never report it unlaunched. Only
    // the holder of the failover lock launches a stand-in, and we hold it now, so that settle is dead. If
    // it died after spawning a supervisor that has not taken the dispatch's lock yet, the second supervisor
    // started here and that one race for the lock: exactly one runs the worker, the other exits touching
    // nothing (supervisor.ts), so no worker ever runs twice.
    start(already, dispatchPaths(already.dir).spec);
    watch(deps, run, already);
    return failedOver(already.admit.rung, already);
  }
  // else that stand-in never ran and is over (recorded as lost, or past its start grace): admit a new one
  const standIn = standInFor(deps.profiles.forRepo(run.meta.repo).failover, limited.rung, run.meta.repo);
  if (!standIn) return { hints, started: null, pause: paused };
  if (parseRung(standIn).backend === "claude") {
    const agent = deps.profiles.agentFor(run.meta.repo, d.admit.role, standIn);
    return {
      hints: [
        ...hints,
        `failover: run ${d.admit.name} as Agent(subagent_type: "${agent}"), standing in for ${limited.rung}`,
      ],
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
      // the stand-in answers to the session that dispatched the limited role, whoever fails it over
      sessionId: d.admit.sessionId ?? null,
    });
  } catch (e) {
    if (!isCatherdError(e)) throw e;
    return {
      hints: [...hints, `failover: ${standIn} refused: ${e.code} ${e.message}`],
      started: null,
      pause: paused,
    };
  }
  start(next.d, next.specPath);
  watch(deps, run, next.d);
  return failedOver(standIn, next.d);
}

/**
 * The finished dispatches of a run that still await catherd's action after a restart: a usage limit recorded,
 * not yet failed over (no failover.json) and not yet read. Reconcile settles them for a run this session owns;
 * a claim of the run (`claim`) settles them for the session that takes it over.
 */
export const unsettledLimits = (run: Run): { d: Dispatch; record: RunRecord }[] => {
  const records = new Map(readRecords(run).records.map((r) => [r.dispatchId, r]));
  return listDispatches(run).flatMap((d) => {
    const record = records.get(d.admit.dispatchId);
    return record?.status === "limit" && !readFailover(d.dir) && awaitsCollect(d.dir) ? [{ d, record }] : [];
  });
};

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
 * Spec §4.7: stop a live dispatch (interrupt, SIGTERM, SIGKILL) and record it as cancelled. With `read` (the MCP
 * `cancel` tool, whose caller holds the record it returns) the record is marked read, so `peek` no longer lists
 * it. Without it (the dashboard, `catherd runs cancel`) the record stays unread and catherd announces it to the
 * run's owner at `later` (spec §3.6).
 */
export async function cancel(
  deps: Deps,
  runId: string,
  name: string,
  o: { read?: boolean } = {},
): Promise<DispatchResult> {
  const run = findRun(runId);
  assertId("role name", name);
  const live = liveDispatches(run, deps.now()).find((d) => d.admit.name === name);
  if (!live)
    throw new CatherdError("E_RUN_NOT_LIVE", `${name} has no live dispatch`, {
      fix: "status(run) lists the live ones",
    });
  requestCancel(live.dir);
  await stopOrphan(deps, live);
  await waitForFinish(live, { pollMs: deps.pollMs, now: deps.now });
  const record = await finalizeDispatch(run, live);
  let also: string[] = [];
  if (o.read) {
    const mine = await tryCollect(live.dir);
    // cancel returns at once, so its lease ends at once
    if (mine) endCollect(live.dir);
    else also = [`${name}: result had already read this record`];
  }
  const { hints } = await refreshState(run);
  return { record, hints: [...recordHints(run, live, record), ...also, ...hints] };
}
