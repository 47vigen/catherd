import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { CatherdError } from "../domain/errors.ts";
import { isAlive, isValidPid, processStartTime } from "./proc.ts";

interface Holder {
  pid: number;
  startTime: string | null;
}

/** A lock or reclaim marker this old whose owner cannot be identified was left by a crash. */
const STALE_MS = 5_000;

const me = (): Holder => ({ pid: process.pid, startTime: processStartTime(process.pid) });

/** The holder recorded in `lock`, or null when it is missing, empty, unparsable or malformed. */
function readHolder(lock: string): Holder | null {
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(lock, "utf8"));
  } catch {
    return null;
  }
  const h = v as Partial<Holder> | null;
  if (typeof h !== "object" || h === null || !isValidPid(h.pid)) return null;
  if (h.startTime !== null && typeof h.startTime !== "string") return null;
  return { pid: h.pid, startTime: h.startTime };
}

function olderThan(file: string, ms: number): boolean {
  try {
    return statSync(file).mtimeMs < Date.now() - ms;
  } catch {
    return false;
  }
}

/** Creates `file` exclusively with `content`; false when it already exists. */
function tryCreate(file: string, content: string): boolean {
  try {
    const fd = openSync(file, "wx");
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return false;
  }
}

const tryTake = (lock: string, self: Holder): boolean => tryCreate(lock, JSON.stringify(self));

/** Whether `lock` is abandoned: its holder is dead, or it names no valid holder and is older than STALE_MS. */
function abandoned(lock: string, h: Holder | null): boolean {
  return h ? !isAlive(h.pid, h.startTime) : olderThan(lock, STALE_MS);
}

const sameHolder = (a: Holder | null, b: Holder | null): boolean =>
  a === b || (a !== null && b !== null && a.pid === b.pid && a.startTime === b.startTime);

/**
 * Removes an abandoned lock. Reclaims are serialised by `${lock}.reclaim`, and the reclaimer
 * re-reads the lock while holding it and removes it only if it still names the same abandoned
 * holder, so a waiter can never delete a lock that a live process took in the meantime.
 */
function reclaimIfDead(lock: string): void {
  const seen = readHolder(lock);
  if (!abandoned(lock, seen)) return;
  const marker = `${lock}.reclaim`;
  if (!tryCreate(marker, String(process.pid))) {
    // A reclaim takes milliseconds; a marker this old was left by a reclaimer that crashed.
    if (olderThan(marker, STALE_MS)) rmSync(marker, { force: true });
    return;
  }
  try {
    const now = readHolder(lock);
    if (sameHolder(now, seen) && abandoned(lock, now)) rmSync(lock, { force: true });
  } finally {
    rmSync(marker, { force: true });
  }
}

export async function withFileLock<T>(
  target: string,
  fn: () => T | Promise<T>,
  o: { timeoutMs?: number; pollMs?: number } = {},
): Promise<T> {
  const lock = `${target}.lock`;
  const self = me();
  const deadline = Date.now() + (o.timeoutMs ?? 10_000);
  while (!tryTake(lock, self)) {
    reclaimIfDead(lock);
    if (Date.now() > deadline)
      throw new CatherdError("E_IO_LOCK", `timed out waiting for the lock on ${target}`, {
        fix: `if no catherd process is running, delete ${lock}`,
      });
    await Bun.sleep(o.pollMs ?? 25);
  }
  try {
    return await fn();
  } finally {
    const h = readHolder(lock);
    if (h?.pid === self.pid && h.startTime === self.startTime) rmSync(lock, { force: true });
  }
}

/**
 * One attempt at the lock on `target`, reclaiming it first from a dead holder. Returns its release,
 * or null while a live holder keeps it. For locks held for a long time, like the heavy-command slots.
 */
export function tryLock(target: string): (() => void) | null {
  const lock = `${target}.lock`;
  const self = me();
  if (!tryTake(lock, self)) {
    reclaimIfDead(lock);
    if (!tryTake(lock, self)) return null;
  }
  return () => {
    const h = readHolder(lock);
    if (h?.pid === self.pid && h.startTime === self.startTime) rmSync(lock, { force: true });
  };
}
