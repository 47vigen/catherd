import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { locksDir } from "./paths.ts";
import { isAlive, processStartTime } from "./proc.ts";
import { ensurePrivateDir, writeJsonAtomic } from "./store.ts";

// Plan 23: a role's long gate runs behind `catherd lock`. While such a lock child is alive and writing, the
// role's wall timeout counts from its last output, not from the role's start. The lock writes here, in the
// locks dir every role may write; the supervisor reads it.

/** The env var the supervisor's spec carries, so a `catherd lock` inside the role knows its dispatch. */
export const DISPATCH_ID_ENV = "CATHERD_DISPATCH_ID";

/** A lock child reports at most this often, so a chatty command does not write a file per line. */
export const ACTIVITY_EVERY_MS = 1_000;

const SAFE_ID = /^[A-Za-z0-9][\w.-]{0,127}$/;

/** `<locks>/activity/<dispatch id>`: one file per live `catherd lock` of that dispatch. */
export const activityDir = (dispatchId: string): string => join(locksDir(), "activity", dispatchId);

interface Activity {
  schema: 1;
  pid: number;
  startTime: string | null;
  /** the last time the lock's command wrote output (its start, before the first line) */
  at: string;
}

/**
 * A reporter for this `catherd lock` process, or null outside a dispatch (no id, or one that is not a plain
 * id: it names a path). `tick` records output, at most once per ACTIVITY_EVERY_MS; `done` removes the file.
 */
export function activityReporter(
  dispatchId: string | undefined,
  now: () => number = Date.now,
  everyMs = ACTIVITY_EVERY_MS,
): { tick: () => void; done: () => void } | null {
  if (!dispatchId || !SAFE_ID.test(dispatchId) || dispatchId.includes("..")) return null;
  const dir = activityDir(dispatchId);
  const file = join(dir, `${process.pid}.json`);
  const startTime = processStartTime(process.pid);
  let last = 0;
  const write = (t: number): void => {
    try {
      ensurePrivateDir(dir);
      writeJsonAtomic(file, {
        schema: 1,
        pid: process.pid,
        startTime,
        at: new Date(t).toISOString(),
      } satisfies Activity);
      last = t;
    } catch {
      // advisory: a lock that cannot report still runs its command
    }
  };
  write(now());
  return {
    tick: () => {
      const t = now();
      if (t - last >= everyMs) write(t);
    },
    done: () => rmSync(file, { force: true }),
  };
}

/**
 * When a live `catherd lock` of the dispatch last wrote output, in ms; null when none is alive. A file whose
 * process is gone is left alone (its lock may still be finishing its own cleanup) and never counts.
 */
export function lastLockOutput(dispatchId: string): number | null {
  const dir = activityDir(dispatchId);
  if (!existsSync(dir)) return null;
  let latest: number | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const a = JSON.parse(readFileSync(join(dir, name), "utf8")) as Activity;
      if (a.schema !== 1 || !isAlive(a.pid, a.startTime)) continue;
      const at = Date.parse(a.at);
      if (!Number.isNaN(at)) latest = Math.max(latest ?? at, at);
    } catch {
      // a file being written, or damaged: skipped this poll
    }
  }
  return latest;
}
