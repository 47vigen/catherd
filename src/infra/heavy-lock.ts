import { availableParallelism } from "node:os";
import { join } from "node:path";
import { tryLock } from "./filelock.ts";
import { locksDir } from "./paths.ts";
import { ensurePrivateDir } from "./store.ts";

/** A profile's `lock.heavy` as a slot count: a number, or half the cores. */
export function heavySlots(setting: number | "cpus/2" | undefined): number {
  if (typeof setting === "number" && Number.isFinite(setting)) return Math.max(1, Math.floor(setting));
  return Math.max(1, Math.floor(availableParallelism() / 2));
}

/**
 * Runs `fn` holding one of `slots` machine-wide heavy-command slots, waiting for a free one. A slot is
 * a file lock, so a slot whose holder died, or died before writing its name, is reclaimed.
 */
export async function withHeavySlot<T>(
  slots: number,
  fn: (slot: number) => T | Promise<T>,
  o: { pollMs?: number } = {},
): Promise<T> {
  const r = await withHeavySlotWithin(slots, Number.POSITIVE_INFINITY, fn, o);
  if (r.busy) throw new Error("unreachable: an unbounded wait never gives up");
  return r.value;
}

/**
 * withHeavySlot with a wait budget (plan 23): `{ busy: true }` when no slot came free within `waitMs`, so a
 * caller with a deadline of its own (preflight) reports the lock as busy instead of timing out behind it.
 */
export async function withHeavySlotWithin<T>(
  slots: number,
  waitMs: number,
  fn: (slot: number) => T | Promise<T>,
  o: { pollMs?: number } = {},
): Promise<{ busy: false; value: T } | { busy: true }> {
  const dir = locksDir();
  ensurePrivateDir(dir);
  const deadline = Date.now() + waitMs;
  for (;;) {
    for (let i = 0; i < slots; i++) {
      const release = tryLock(join(dir, `slot-${i}`));
      if (!release) continue;
      try {
        return { busy: false, value: await fn(i) };
      } finally {
        release();
      }
    }
    const left = deadline - Date.now();
    if (left <= 0) return { busy: true };
    await Bun.sleep(Math.min(o.pollMs ?? 500, left));
  }
}
