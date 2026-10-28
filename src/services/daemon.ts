import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { errorMessage } from "../domain/errors.ts";
import { launchDaemon } from "../infra/launch.ts";
import type { SuperviseClock } from "../infra/supervisor.ts";
import { lockHeld, tryLock, withFileLockSync } from "../infra/filelock.ts";
import { heavyLimits } from "../infra/heavy-lock.ts";
import { log } from "../infra/log.ts";
import { selfIdentity } from "../infra/proc.ts";
import { readVersioned, writeJsonAtomic } from "../infra/store.ts";
import type { Deps } from "./ports.ts";
import type { RunEvent } from "../domain/run-events.ts";
import { type Action, actionKey, confirms, failKey, next } from "../domain/run-machine.ts";
import { reduce, replay, type RunState } from "../domain/run-state.ts";
import { type Effects, realEffects } from "./run-effects.ts";
import { appendEvent, hasRunEnded, isDaemonRun, readEvents } from "./run-events-store.ts";
import { pausesFor } from "./pause.ts";
import { findRun, type Run } from "./run-store.ts";

/** The daemon holds this lock for its whole life: a second holder gets none, a dead one's is reclaimed. */
export const daemonLockTarget = (run: Run): string => join(run.dir, "daemon");
export const heartbeatFile = (run: Run): string => join(run.dir, "daemon.json");
export const launchStamp = (run: Run): string => join(run.dir, "daemon.launched");

/**
 * `beatMs`: heartbeat interval; `pollMs`: event poll interval; `reviveMs`: minimum time between launches;
 * `drainMs`: how long a stopping daemon waits for its effects before it gives up the lock.
 */
export const daemonLimits = { beatMs: 5_000, pollMs: 500, reviveMs: 30_000, drainMs: 900_000 };

export interface Heartbeat {
  schema: 1;
  pid: number;
  startTime: string | null;
  beatAt: string;
  seq: number;
  version: string;
}

const HeartbeatSchema = z.looseObject({
  schema: z.literal(1),
  pid: z.number().int(),
  startTime: z.string().nullable(),
  beatAt: z.string(),
  seq: z.number().int(),
  version: z.string(),
});

/** The daemon's last beat, or null when it never wrote one or the file cannot be read. */
export function readHeartbeat(run: Run): Heartbeat | null {
  try {
    return readVersioned(heartbeatFile(run), HeartbeatSchema, 1);
  } catch {
    return null;
  }
}

/** Whether a live process holds the run's daemon lock: its pid and start time, never the heartbeat. */
export const daemonAlive = (run: Run): boolean => lockHeld(daemonLockTarget(run));

/** How the daemon is started; tests replace it so no process is spawned. */
export const daemonLauncher = { launch: launchDaemon };

/**
 * Makes sure a 2.0 run that has not ended has a daemon: one that is alive is left alone, a dead one is
 * started again at most once per revive window. A 1.5 run has none.
 */
export function ensureDaemon(run: Run): "alive" | "revived" | "ended" | "1.5" {
  if (!isDaemonRun(run)) return "1.5";
  if (hasRunEnded(run)) return "ended";
  if (daemonAlive(run)) return "alive";
  return withFileLockSync(launchStamp(run), () => {
    if (hasRunEnded(run)) return "ended";
    if (daemonAlive(run)) return "alive";
    // A daemon that died within reviveMs most likely fails at start: one launch per window, not per read.
    const last = existsSync(launchStamp(run)) ? statSync(launchStamp(run)).mtimeMs : 0;
    if (Date.now() - last < daemonLimits.reviveMs) return "revived";
    writeFileSync(launchStamp(run), "");
    daemonLauncher.launch(run.id, run.dir);
    return "revived";
  });
}

/** Writes the heartbeat: who holds the lock, since when, and how far it has read. */
export function beat(run: Run, deps: Deps, seq: number): void {
  const { pid, startTime } = selfIdentity();
  writeJsonAtomic(heartbeatFile(run), {
    schema: 1,
    pid,
    startTime,
    beatAt: new Date(deps.now()).toISOString(),
    seq,
    version: deps.version,
  } satisfies Heartbeat);
}

/**
 * The deps the daemon drives `run` with: the detached process has no host of its own, so its profile
 * resolves on the host the run recorded (`startedBy`); a run no host started keeps the deps as they are.
 */
export function daemonDeps(deps: Deps, run: Run): Deps {
  const host = run.meta.startedBy?.host;
  if (!host) return deps;
  const scoped: Deps = { ...deps, host: { host, session: null, conflict: null } };
  scoped.profiles = deps.profiles.withHost?.(() => scoped.host) ?? deps.profiles;
  return scoped;
}

export interface DaemonOptions {
  /** what carries the machine's actions out; the real services when absent */
  effects?: Effects;
  /** the loop's time; the real clock when absent */
  clock?: SuperviseClock;
  /** ends the loop early (tests) */
  until?: () => boolean;
}

/** Whether `e` is a full disk: an errno code, or a message that starts with it (a wrapped write error). */
const isEnospc = (e: unknown): boolean =>
  (e as { code?: unknown } | null)?.code === "ENOSPC" || errorMessage(e).startsWith("ENOSPC");

/**
 * Waits for the effects in flight, at most `drainMs`: their git and check runs are killed by their own timeouts
 * (`effectLimits`) well within it, so a daemon started after this one never overlaps them. A `watch` lasts as
 * long as its worker, so it is not waited for: the next daemon issues it again on `daemon.started`.
 */
async function drain(inFlight: Set<Promise<void>>, watches: Set<Promise<void>>): Promise<void> {
  inFlight = new Set([...inFlight].filter((p) => !watches.has(p)));
  if (inFlight.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((r) => (timer = setTimeout(() => r(true), daemonLimits.drainMs)));
  const timedOut = await Promise.race([Promise.allSettled(inFlight).then(() => false), late]);
  clearTimeout(timer);
  if (timedOut) log("warn", "daemon", { drain: "timed out", inFlight: inFlight.size });
}

const REAL_CLOCK: SuperviseClock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) };

/**
 * Drives one run: takes its lock (`"lost-lock"` without it), returns `"ended"` at once for a run that ended,
 * else replays the events, announces itself, and then feeds each new event to the machine: it clears the keys
 * the event confirms, runs each action of `next` it has not issued (not awaited), appends one `tick` when a
 * hold or wait has passed and beats. It leaves, releasing the lock, once the run has ended and every effect
 * is done. The effects append the events, so a crash loses nothing: a new daemon replays and issues again
 * what never got its event.
 */
export async function runDaemon(
  daemonSide: Deps,
  runId: string,
  o: DaemonOptions = {},
): Promise<"ended" | "lost-lock"> {
  const run = findRun(runId);
  const deps = daemonDeps(daemonSide, run);
  const release = tryLock(daemonLockTarget(run));
  if (!release) return "lost-lock";
  const inFlight = new Set<Promise<void>>();
  const watches = new Set<Promise<void>>();
  try {
    if (!isDaemonRun(run) || hasRunEnded(run)) return "ended";
    const clock = o.clock ?? REAL_CLOCK;
    const effects = o.effects ?? realEffects(deps, run);
    let state: RunState = replay(readEvents(run), run.id);
    const hello = await appendEvent(
      run,
      { type: "daemon.started", pid: process.pid, version: deps.version },
      new Date(clock.now()),
    );
    log("info", "daemon", { run: run.id, pid: process.pid, seq: hello.seq });
    beat(run, deps, hello.seq);
    /** action key → the key `effect.failed` frees it by */
    const issued = new Map<string, string>();
    /** the error of an effect that could not record its failure; it stops the loop, and the effects in flight settle before the lock is released */
    let stopError: unknown = null;
    const issue = (a: Action): void => {
      const key = actionKey(a);
      if (issued.has(key)) return;
      issued.set(key, failKey(a, state));
      const p: Promise<void> = effects
        .run(a, state)
        .catch((e: unknown) => {
          log("error", "daemon", { run: run.id, action: a.type, error: errorMessage(e) });
          // an effect that could not record its failure leaves its key issued: a new daemon must replay it
          stopError ??= e;
        })
        .finally(() => {
          inFlight.delete(p);
          watches.delete(p);
          // Notices, stale reminders and empty merge checks leave no event to free their key.
          if (a.type === "notify" || a.type === "remind" || a.type === "checkMerged") issued.delete(key);
        });
      inFlight.add(p);
      if (a.type === "watch") watches.add(p);
    };
    const take = (e: RunEvent): void => {
      state = reduce(state, e);
      for (const k of confirms(e))
        for (const [key, fk] of issued) if (key === k || fk === k) issued.delete(key);
      for (const a of next(state, e)) issue(a);
    };
    let beatAt = clock.now();
    while (!o.until?.()) {
      if (stopError !== null) throw stopError;
      const fresh = readEvents(run, state.seq + 1);
      for (const e of fresh) take(e);
      if (fresh.length > 0) continue;
      if (state.wakeAt !== null && Date.parse(state.wakeAt) <= clock.now()) {
        await appendEvent(run, { type: "tick" }, new Date(clock.now()));
        continue;
      }
      if (clock.now() - beatAt >= daemonLimits.beatMs) {
        beat(run, deps, state.seq);
        beatAt = clock.now();
        // The pause that held a refused dispatch is gone (also one lifted while no daemon ran): owe it again.
        if (state.held !== null && pausesFor(run).length === 0) {
          await appendEvent(run, { type: "pause.lifted" }, new Date(clock.now()));
          continue;
        }
      }
      if (state.phase === "ended" && inFlight.size === 0) break;
      await clock.sleep(daemonLimits.pollMs);
    }
    beat(run, deps, Math.max(state.seq, hello.seq));
    return "ended";
  } catch (e) {
    log("error", "daemon", { run: runId, error: errorMessage(e) });
    throw e;
  } finally {
    await drain(inFlight, watches);
    release();
  }
}

export interface SuperviseOptions {
  freeMb: () => number;
  reserveMb: () => number;
  sleep: (ms: number) => Promise<unknown>;
  pollMs: number;
}

/**
 * Runs the daemon (`once`); one that a full disk stopped waits until the disk has its reserve again and runs it
 * again, since the new daemon replays and issues what was lost. Any other error is the caller's.
 */
export async function superviseDaemon<T>(
  once: () => Promise<T>,
  o: SuperviseOptions = {
    freeMb: heavyLimits.freeMb,
    reserveMb: () => heavyLimits.diskReserveMb,
    sleep: Bun.sleep,
    pollMs: 30_000,
  },
): Promise<T> {
  for (;;) {
    try {
      return await once();
    } catch (e) {
      if (!isEnospc(e)) throw e;
      while (o.freeMb() < o.reserveMb()) await o.sleep(o.pollMs);
    }
  }
}
