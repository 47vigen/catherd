import { mkdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { tryLock } from "./filelock.ts";
import { locksDir } from "./paths.ts";

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
  const dir = locksDir();
  mkdirSync(dir, { recursive: true });
  for (;;) {
    for (let i = 0; i < slots; i++) {
      const release = tryLock(join(dir, `slot-${i}`));
      if (!release) continue;
      try {
        return await fn(i);
      } finally {
        release();
      }
    }
    await Bun.sleep(o.pollMs ?? 500);
  }
}
