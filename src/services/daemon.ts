import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { errorMessage } from "../domain/errors.ts";
import { launchDaemon } from "../infra/launch.ts";
import type { SuperviseClock } from "../infra/supervisor.ts";
import { lockHeld, tryLock } from "../infra/filelock.ts";
import { log } from "../infra/log.ts";
import { processStartTime } from "../infra/proc.ts";
import { readVersioned, writeJsonAtomic } from "../infra/store.ts";
import type { Deps } from "./ports.ts";
import type { Effects } from "./run-effects.ts";
import { appendEvent, eventsFile, isDaemonRun } from "./run-events-store.ts";
import { findRun, type Run } from "./run-store.ts";

/** The daemon holds this lock for its whole life: a second holder gets none, a dead one's is reclaimed. */
export const daemonLockTarget = (run: Run): string => join(run.dir, "daemon");
export const heartbeatFile = (run: Run): string => join(run.dir, "daemon.json");

/** `beatMs`: how often the heartbeat is written; `pollMs`: how often the loop reads the events. Tests shorten them. */
export const daemonLimits = { beatMs: 5_000, pollMs: 500 };

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
 * started again (two callers at once start two processes, and the lock lets one run). A 1.5 run has none.
 */
export function ensureDaemon(run: Run): "alive" | "revived" | "ended" | "1.5" {
  if (!isDaemonRun(run)) return "1.5";
  if (hasEnded(run)) return "ended";
  if (daemonAlive(run)) return "alive";
  daemonLauncher.launch(run.id, run.dir);
  return "revived";
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

export interface DaemonOptions {
  /** what carries the machine's actions out; the real services when absent */
  effects?: Effects;
  /** the loop's time; the real clock when absent */
  clock?: SuperviseClock;
  /** ends the loop early (tests) */
  until?: () => boolean;
}

/**
 * Plan 30 task 4's part of the daemon: take the run's lock (`"lost-lock"` without it), return `"ended"` for a
 * run that ended, else announce itself and beat once. The loop that drives the run follows in `drive`.
 */
export async function runDaemon(
  deps: Deps,
  runId: string,
  _o: DaemonOptions = {},
): Promise<"ended" | "lost-lock"> {
  const run = findRun(runId);
  const release = tryLock(daemonLockTarget(run));
  if (!release) return "lost-lock";
  try {
    if (!isDaemonRun(run) || hasEnded(run)) return "ended";
    const e = await appendEvent(run, { type: "daemon.started", pid: process.pid, version: deps.version });
    beat(run, deps, e.seq);
    log("info", "daemon", { run: run.id, pid: process.pid, seq: e.seq });
    return "ended";
  } catch (e) {
    log("error", "daemon", { run: runId, error: errorMessage(e) });
    throw e;
  } finally {
    release();
  }
}
