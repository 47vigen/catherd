import { assertNativeHost } from "./backends.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
import { lockHeld, withFileLock } from "../infra/filelock.ts";
import { log } from "../infra/log.ts";
import { isAlive, isSurelyAlive, killGroup } from "../infra/proc.ts";
import { groupAlive, stopGroup } from "../infra/supervisor.ts";
import { writeJsonAtomic } from "../infra/store.ts";
import { admit, KILL_GRACE_MS, laneFile, laneOwns, launch } from "./admission.ts";
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
import { finalizeDispatch, finalizingElsewhere, waitForFinish } from "./finalize.ts";
import type { Deps } from "./ports.ts";
import { route } from "./lane-service.ts";
import { currentRoute } from "../domain/route.ts";
import { appendRoute, findRun, readRecords, readRoleRoutes, readRoutes, type Run } from "./run-store.ts";
import { sessionKey } from "../domain/host.ts";
import { claimRun, currentSession, ownsRun, runOwner, type SessionRef } from "./sessions.ts";
import { pinChanges, runProfile } from "./run-pin.ts";
import { type NotesPatch, refreshState } from "./state.ts";

export interface DispatchInput {
  run: string;
  role: Role;
  name: string;
  brief: string;
  /** spec 1.5 plan 24: optional with `lane` (the lane's current rung); required without one */
  rung?: string;
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
/** A stall's quiet time; 0 when stall.json is being written or damaged, so one bad file never blocks a notice. */
export function readStallQuietMs(dir: string): number {
  try {
    return Number(JSON.parse(readFileSync(dispatchPaths(dir).stall, "utf8")).quietMs) || 0;
  } catch {
    return 0;
  }
}

export function stallPoll(run: Run, d: Dispatch): () => void {
  let seen = false;
  return () => {
    if (seen || !existsSync(dispatchPaths(d.dir).stall)) return;
    seen = true;
    const quietMs = readStallQuietMs(d.dir);
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
  // the session this watcher started under, kept apart from its live identity: an MCP connection that closes
  // invalidates the scoped host (no session), yet the watcher still came from that session (PR #47 P1)
  const origin = currentSession(deps);
  const w = (async () => {
    await waitForFinish(d, { pollMs: deps.pollMs, now: deps.now, onPoll: stallPoll(run, d) });
    const record = await finalizeDispatch(run, d);
    // a session that lost the run since it dispatched leaves a limit to the owner's claim (1.1 push minors):
    // only the run's owner starts a stand-in. A process with no session (a terminal) settles as before.
    if (record.status === "limit" && !limitIsMine(deps, run, origin)) {
      log("info", "dispatch", { run: run.id, name: d.admit.name, limit: "left to the run's owner" });
      return;
    }
    const s = await settle(deps, run, d, record);
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
 * Whether a watcher settles a limit (fails it over): a watcher with no session, then or now (a terminal, a
 * test), always does; one that started under a session does only while that session, or its live one, owns
 * the run.
 */
function limitIsMine(deps: Deps, run: Run, origin: SessionRef | null): boolean {
  if (origin === null && currentSession(deps) === null) return true;
  if (ownsRun(deps, run)) return true;
  const owner = runOwner(run);
  return origin !== null && owner !== null && sessionKey(owner) === sessionKey(origin);
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
 * Spec §3.3 with the plan 10 fix-round ruling: `dispatch` and `peek` on a run make this session its owner. The
 * owner, new or not, then takes care of what is left on the run: it watches the live roles no watcher here is
 * on (`adopt`), records and settles each role that finished with no record (the earlier owner's server died, or
 * a watcher here failed to finalize it), settles each unread usage limit that was never failed over, and
 * settles again each unread record no message announced (the earlier owner's server settled it but never told
 * its session). Each settle runs the hooks, so the notifier tells the owner. Nothing left, nothing done. A
 * settle that fails is logged and never fails the call.
 *
 * Codex r4 ruling: the recovery never waits on another live process. A role whose finalizer claim, or a limit
 * whose failover lock, another live process holds is left to that process (it writes the record, fails over
 * and runs its own hooks). With `background` (peek, spec §3.7 "never waits") the recovery runs after the call
 * returns, its errors logged; `dispatch` awaits it, bounded by those skips. One recovery per run at a time.
 */
export async function claim(deps: Deps, run: Run, o: { background?: boolean } = {}): Promise<void> {
  if (!(await claimRun(deps, run)) && !ownsRun(deps, run)) return;
  await recoverOwned(deps, run, o);
}

/**
 * What `claim` does for a run this session already owns, without taking it: watch its live roles, record and
 * settle what finished unrecorded, settle its unsettled limits and unannounced records. A server that does not
 * lead the boot runs it for each run its session owns (PR #47 P1: a role that finished while that server was
 * away has no live process to watch and no record to scan).
 */
export async function recoverOwned(deps: Deps, run: Run, o: { background?: boolean } = {}): Promise<void> {
  adopt(deps, run);
  let r = recovering.get(run.id);
  if (!r) {
    const p: Promise<void> = recover(deps, run)
      .catch((e: unknown) => log("warn", "claim", { run: run.id, error: errorMessage(e) }))
      .finally(() => {
        recovering.delete(run.id);
        watchers.delete(p);
      });
    recovering.set(run.id, p);
    watchers.add(p);
    r = p;
  }
  if (!o.background) await r;
}

/** The recovery pass `claim` has in flight, by run id. */
const recovering = new Map<string, Promise<void>>();

/** A limit's failover lock another live process holds: its settle fails it over and announces it. */
const failingOverElsewhere = (d: Dispatch): boolean => lockHeld(dispatchPaths(d.dir).failover);

async function recover(deps: Deps, run: Run): Promise<void> {
  const warn = (d: Dispatch, e: unknown) =>
    log("warn", "claim", { run: run.id, name: d.admit.name, error: errorMessage(e) });
  for (const d of pendingDispatches(run, deps.now())) {
    if (d.state !== "finished" || watching.has(d.admit.dispatchId)) continue;
    if (finalizingElsewhere(d.dir)) continue;
    try {
      await settle(deps, run, d, await finalizeDispatch(run, d));
    } catch (e) {
      warn(d, e);
    }
  }
  const limits = unsettledLimits(run);
  for (const { d, record } of limits) {
    // a watcher here settles it (a peek never waits on its failover lock)
    if (watching.has(d.admit.dispatchId) || failingOverElsewhere(d)) continue;
    try {
      await settle(deps, run, d, record);
    } catch (e) {
      warn(d, e);
    }
  }
  const done = new Set(limits.map((l) => l.d.admit.dispatchId));
  for (const { d, record } of unannounced(run)) {
    if (done.has(d.admit.dispatchId) || watching.has(d.admit.dispatchId)) continue;
    if (record.status === "limit" && failingOverElsewhere(d)) continue;
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

/** How long a dispatch waits for another dispatch's route of the same lane (Jev may take tens of seconds). */
const ROUTE_LOCK_MS = 120_000;

/**
 * What admission would refuse anyway, refused before a lane is routed, so a refused dispatch asks Jev nothing
 * and writes no route row: the role off, the lane file missing or with no Owns:, the name or the lane already
 * running. Admission checks them again under its lock.
 */
function refuseBeforeRouting(deps: Deps, run: Run, i: DispatchInput & { lane: string }): void {
  const profile = runProfile(deps, run);
  if (!profile.roles[i.role]?.enabled)
    throw new CatherdError("E_ADMIT_RUNG", `the ${i.role} role is off in profile ${profile.name}`, {
      fix: "skip the role, or turn it on with profile_set",
    });
  laneOwns(run, i.lane);
  const pending = pendingDispatches(run, deps.now());
  const same = pending.find((d) => d.admit.name === i.name);
  if (same)
    throw new CatherdError("E_ADMIT_DUPLICATE", `${i.name} is already running on ${same.admit.rung}`, {
      fix: `its record is announced when it finishes; or cancel(run, "${i.name}")`,
    });
  const lane = pending.find((d) => d.admit.lane === i.lane);
  if (lane)
    throw new CatherdError("E_ADMIT_OVERLAP", `lane ${i.lane} is already running as ${lane.admit.name}`, {
      fix: `dispatch it after ${lane.admit.name} finishes`,
    });
}

/**
 * Plan 22: the thread a dispatch resumes. `"latest"` is the name's last recorded thread; any other id must be one
 * the name's records in this run hold (`runs.jsonl`), in any case, so a wrong id is refused before a CLI starts
 * and fails on it. Null for a fresh thread.
 */
function threadFor(run: Run, name: string, thread: string | undefined): string | null {
  if (thread === undefined) return null;
  assertId("role name", name);
  const mine = readRecords(run)
    .records.filter((r) => r.name === name && r.thread !== null)
    .map((r) => r.thread as string);
  const last = mine.at(-1);
  if (thread === "latest") {
    if (last) return last;
    throw new CatherdError("E_ADMIT_THREAD", `${name} has no earlier thread in this run`, {
      fix: "omit thread for a fresh thread",
    });
  }
  const known = mine.findLast((t) => t.toLowerCase() === thread.toLowerCase());
  if (known) return known;
  throw new CatherdError("E_ADMIT_THREAD", `${thread} is not a thread of ${name} in this run`, {
    fix: last
      ? `pass thread: "latest" for ${name}'s last thread (${last}), or omit thread for a fresh one`
      : "omit thread for a fresh thread",
  });
}

/**
 * Plan 22, resume hygiene: what an earlier turn on `thread` left running in its process group (a server, a
 * watcher, a background command) is stopped before the thread is resumed, so it never ends the resumed CLI
 * (exit 143). Only a dispatch whose supervisor and group leader are both gone is touched (with or without
 * exit.json: a supervisor killed before it stopped the group writes none): a live group with no process of the
 * leader's pid can only be that dispatch's leftovers (a pid is never reused while its group lives), and a pid
 * that answers belongs to someone else by now. Returns a hint per group stopped.
 */
async function stopLeftovers(deps: Deps, run: Run, thread: string): Promise<string[]> {
  const records = new Map(readRecords(run).records.map((r) => [r.dispatchId, r]));
  const hints: string[] = [];
  for (const d of listDispatches(run)) {
    const on = d.admit.thread ?? records.get(d.admit.dispatchId)?.thread ?? null;
    if (on?.toLowerCase() !== thread.toLowerCase()) continue;
    const proc = readProc(d.dir);
    const pgid = proc?.pgid ?? proc?.pid;
    if (!proc || pgid === undefined || pgid !== proc.pid) continue;
    // a live supervisor stops its own group when its worker ends; exit.json is not the test, since a supervisor
    // killed (SIGKILL, OOM) before it stopped the group never writes one
    if (isAlive(proc.supervisorPid, proc.supervisorStartTime)) continue;
    if (isAlive(proc.pid, null) || !groupAlive(pgid)) continue;
    await stopGroup(pgid, orphanLimits.killGraceMs, deps.pollMs);
    log("info", "dispatch", { run: run.id, name: d.admit.name, thread, stoppedGroup: pgid });
    hints.push(`resume: stopped what ${d.admit.name}'s earlier turn left running on thread ${thread}`);
  }
  return hints;
}

/**
 * Spec §4.4, plan 9 ruling 1: admit and launch one role, start its watcher, then refresh state.md with
 * `next` (after the launch, so nothing delays it). Returns at once; catherd announces the record (spec §3).
 */
export async function dispatch(deps: Deps, i: DispatchInput): Promise<DispatchStarted> {
  const run = findRun(i.run);
  // refused before the claim, so a wrong thread changes nothing
  const thread = threadFor(run, i.name, i.thread);
  await claim(deps, run);
  const hints: string[] = [];
  if (thread !== null) hints.push(...(await stopLeftovers(deps, run, thread)));
  let rung: string;
  if (i.lane !== undefined) {
    const lane = i.lane;
    assertId("lane", lane);
    // spec 1.1 §6: a lane is routed before its first dispatch; a rung off the routed ladder starts at the routed one
    let current = currentRoute(readRoutes(run), lane);
    let routed: Awaited<ReturnType<typeof route>> | null = null;
    if (!current) {
      refuseBeforeRouting(deps, run, { ...i, lane });
      // one route per lane: a second dispatch of the lane waits for the first's route and takes it
      const got = await withFileLock(
        join(run.dir, `route-${lane}`),
        async () => {
          const now = currentRoute(readRoutes(run), lane);
          return now
            ? { current: now, routed: null }
            : {
                current: null,
                routed: await route(deps, { run: i.run, laneFile: `lanes/${lane}.md`, role: i.role }),
              };
        },
        { timeoutMs: ROUTE_LOCK_MS },
      );
      current = got.current;
      routed = got.routed;
    }
    // spec 1.5 plan 24: without a rung, a lane runs at its current rung (its route, after any climb)
    rung = i.rung ?? routed?.rung ?? (current?.rung as string);
    if (routed && i.rung !== undefined && !routed.ladder.includes(i.rung)) {
      rung = routed.rung;
      hints.push(`${i.rung} is not on ${lane}'s routed ladder: dispatched at ${routed.rung}`);
    }
  } else if (i.rung === undefined)
    throw new CatherdError("E_INPUT_INVALID", `dispatch ${i.name}: a role outside a lane needs a rung`, {
      fix: `route(run, role: "${i.role}") gives the role's rung; pass it as rung`,
    });
  else rung = i.rung;
  // the rung that runs, after routing: an off-ladder native rung routing replaced is never launched
  assertNativeHost(rung, deps.host.host);
  const { d, specPath } = await admit(
    deps,
    run,
    {
      role: i.role,
      name: i.name,
      brief: i.brief,
      rung,
      thread,
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
  if (i.lane === undefined) recordRoleDispatch(deps, run, i.role, i.name, rung);
  // spec 1.5: a change since the run's pin is logged in state.md each time a role starts
  const changes = pinChanges(deps, run);
  if (changes.length)
    hints.push(
      `dispatched on the run's pinned values: ${changes.join("; ")}; run_pin(run) re-pins to the repo's now`,
    );
  await refresh(run, { ...(i.next ? { next: i.next } : {}), pinChanges: changes }, hints);
  return { dispatched: dispatchedOf(d), hints };
}

/**
 * Spec 1.5 plan 24: a lane-less dispatch's rung in routes.jsonl, so every role's decision can be audited:
 * `route` when it is the rung the role's last `route` gave (with that ladder), else the coordinator's own pick.
 * A failed write is logged, never a failed dispatch: the role is already running.
 */
function recordRoleDispatch(deps: Deps, run: Run, role: Role, name: string, rung: string): void {
  try {
    const last = readRoleRoutes(run).findLast((r) => r.role === role && r.source === "route");
    const routed = last?.rung === rung;
    appendRoute(run, {
      at: new Date(deps.now()).toISOString(),
      lane: null,
      role,
      name,
      rung,
      ladder: last?.ladder ?? [rung],
      source: "dispatch",
      decidedBy: routed ? last.decidedBy : "orchestrator",
      why: routed
        ? `the rung route gave the ${role}`
        : last
          ? `the coordinator's rung; route gave the ${role} ${last.rung}`
          : `the coordinator's rung; the ${role} was never routed`,
    });
  } catch (e) {
    log("warn", "dispatch", { run: run.id, name, routes: errorMessage(e) });
  }
}

/** How long a settle waits for another process's failover of the same dispatch (a test seam). */
export const failoverLock = { timeoutMs: 120_000 };

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
 *
 * Codex r4 ruling: a settle that times out waiting for the failover lock (another live process holds it) is
 * not a failed failover. It writes nothing and runs no hook: the holder's settle writes failover.json, refreshes
 * state.md and announces the outcome. It returns the hints and pause failover.json holds by then, else none.
 */
export async function settle(deps: Deps, run: Run, d: Dispatch, record: RunRecord): Promise<Settled> {
  let o: Outcome = { hints: recordHints(run, d, record), started: null, pause: null };
  if (record.status === "limit") {
    let entered = false;
    try {
      o = await withFileLock(
        dispatchPaths(d.dir).failover,
        () => {
          entered = true;
          return failoverOnce(deps, run, d, record);
        },
        { timeoutMs: failoverLock.timeoutMs },
      );
    } catch (e) {
      if (!entered && isCatherdError(e) && e.code === "E_IO_LOCK") {
        log("info", "settle", { run: run.id, name: d.admit.name, failover: "left to the lock's holder" });
        const done = readFailover(d.dir);
        return {
          run,
          d,
          record,
          hints: done?.hints ?? [...o.hints, "failover: another catherd process is failing it over"],
          started: null,
          pause: done?.pause ?? null,
          stateHints: [],
        };
      }
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
  const standIn = standInFor(runProfile(deps, run).failover, limited.rung, run.meta.repo);
  if (!standIn) return { hints, started: null, pause: paused };
  // the stand-in answers to whoever owns the run now, which a claim from another host may have changed
  assertNativeHost(standIn, runOwner(run)?.host ?? deps.host.host);
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
      host: d.admit.host,
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
