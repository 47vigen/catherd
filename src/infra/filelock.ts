import { closeSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { CatherdError } from "../domain/errors.ts";
import { isAlive, processStartTime } from "./proc.ts";

interface Holder {
  pid: number;
  startTime: string | null;
}

const me = (): Holder => ({ pid: process.pid, startTime: processStartTime(process.pid) });

function readHolder(lock: string): Holder | null {
  try {
    return JSON.parse(readFileSync(lock, "utf8")) as Holder;
  } catch {
    return null;
  }
}

function tryTake(lock: string, self: Holder): boolean {
  try {
    const fd = openSync(lock, "wx");
    writeSync(fd, JSON.stringify(self));
    closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return false;
  }
}

/** A dead holder's lock is renamed away first: only one reclaimer's rename succeeds, so two
 * waiters can never both delete and re-take the same lock. */
function reclaimIfDead(lock: string): void {
  const h = readHolder(lock);
  if (!h || isAlive(h.pid, h.startTime)) return;
  const aside = `${lock}.stale.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(lock, aside);
    rmSync(aside, { force: true });
  } catch {
    // another waiter reclaimed it first
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
