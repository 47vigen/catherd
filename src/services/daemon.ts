import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { errorMessage } from "../domain/errors.ts";
import { launchDaemon } from "../infra/launch.ts";
import type { SuperviseClock } from "../infra/supervisor.ts";
import { lockHeld, tryLock, withFileLockSync } from "../infra/filelock.ts";
import { log } from "../infra/log.ts";
import { processStartTime } from "../infra/proc.ts";
import { readVersioned, writeJsonAtomic } from "../infra/store.ts";
import type { Deps } from "./ports.ts";
import type { RunEvent } from "../domain/run-events.ts";
import { type Action, actionKey, confirms, failKey, next } from "../domain/run-machine.ts";
import { reduce, replay, type RunState } from "../domain/run-state.ts";
import { type Effects, realEffects } from "./run-effects.ts";
import { appendEvent, eventsFile, isDaemonRun, readEvents } from "./run-events-store.ts";
import { findRun, type Run } from "./run-store.ts";

/** The daemon holds this lock for its whole life: a second holder gets none, a dead one's is reclaimed. */
export const daemonLockTarget = (run: Run): string => join(run.dir, "daemon");
export const heartbeatFile = (run: Run): string => join(run.dir, "daemon.json");
export const launchStamp = (run: Run): string => join(run.dir, "daemon.launched");

/** `beatMs`: heartbeat interval; `pollMs`: event poll interval; `reviveMs`: minimum time between launches. */
export const daemonLimits = { beatMs: 5_000, pollMs: 500, reviveMs: 30_000 };

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

/** Whether the run's events say it ended (`run.ended`). A `"type":"run.ended"` never occurs inside a JSON string. */
function hasEnded(run: Run): boolean {
  try {
    return readFileSync(eventsFile(run), "utf8").includes('"type":"run.ended"');
  } catch {
    return false;
  }
}

/**
 * Makes sure a 2.0 run that has not ended has a daemon: one that is alive is left alone, a dead one is
 * started again at most once per revive window. A 1.5 run has none.
 */
export function ensureDaemon(run: Run): "alive" | "revived" | "ended" | "1.5" {
  if (!isDaemonRun(run)) return "1.5";
  if (hasEnded(run)) return "ended";
  if (daemonAlive(run)) return "alive";
  return withFileLockSync(launchStamp(run), () => {
    if (hasEnded(run)) return "ended";
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
  const pid = process.pid;
  writeJsonAtomic(heartbeatFile(run), {
    schema: 1,
    pid,
    startTime: processStartTime(pid),
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
  try {
    if (!isDaemonRun(run) || hasEnded(run)) return "ended";
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
    const inFlight = new Set<Promise<void>>();
    const issue = (a: Action): void => {
      const key = actionKey(a);
      if (issued.has(key)) return;
      issued.set(key, failKey(a, state));
      const p: Promise<void> = effects
        .run(a, state)
        .catch((e: unknown) =>
          log("error", "daemon", { run: run.id, action: a.type, error: errorMessage(e) }),
        )
        .finally(() => {
          inFlight.delete(p);
          // Notices, stale reminders and empty merge checks leave no event to free their key.
          if (a.type === "notify" || a.type === "remind" || a.type === "checkMerged") issued.delete(key);
        });
      inFlight.add(p);
    };
    const take = (e: RunEvent): void => {
      state = reduce(state, e);
      for (const k of confirms(e))
        for (const [key, fk] of issued) if (key === k || fk === k) issued.delete(key);
      for (const a of next(state, e)) issue(a);
    };
    let beatAt = clock.now();
    while (!o.until?.()) {
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
    release();
  }
}
