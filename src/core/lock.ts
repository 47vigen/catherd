import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { defineCommand } from "citty";
import { dataDir } from "../paths.ts";
import { loadProfile } from "../profile/profile.ts";

/** Kept for interface parity across plans; reclaim here is immediate (pid liveness), not a stale-mtime window. */
export const LOCK_STALE_MS = 5_000;

export function heavySlots(setting: number | "cpus/2" | undefined): number {
  if (typeof setting === "number") return Math.max(1, Math.floor(setting));
  return Math.max(1, Math.floor(availableParallelism() / 2));
}

/** --slots, then CATHERD_LOCK_SLOTS, then the active profile's lock.heavy, then half the cores. */
export function resolveSlots(flag?: string): number {
  const raw = flag ?? process.env.CATHERD_LOCK_SLOTS;
  if (raw) {
    if (raw === "cpus/2") return heavySlots("cpus/2");
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`catherd lock: slots must be a number or cpus/2, got "${raw}"`);
    return heavySlots(n);
  }
  try {
    return heavySlots(loadProfile().lock.heavy);
  } catch (e) {
    console.error(`catherd lock: ${(e as Error).message}; using half the CPU cores`);
    return heavySlots("cpus/2");
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Exclusive create (`wx`): fails EEXIST when another process already holds the slot. A held slot
 * whose pid is dead is reclaimed by removing the file and retrying, with no mtime bookkeeping. */
function tryTake(file: string, label: string): boolean {
  try {
    const fd = openSync(file, "wx");
    writeSync(fd, JSON.stringify({ pid: process.pid, label }));
    closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    try {
      const { pid } = JSON.parse(readFileSync(file, "utf8")) as { pid: number };
      if (!pidAlive(pid)) {
        rmSync(file, { force: true });
        return tryTake(file, label);
      }
    } catch {
      // corrupt or mid-write: leave it for its holder, try again on the next poll
    }
    return false;
  }
}

export async function acquire(
  slots: number,
  label: string,
  pollMs = 2000,
): Promise<{ slot: number; release: () => Promise<void> }> {
  const dir = join(dataDir(), "locks");
  mkdirSync(dir, { recursive: true });
  for (;;) {
    for (let i = 0; i < slots; i++) {
      const file = join(dir, `slot-${i}`);
      if (!tryTake(file, label)) continue;
      return {
        slot: i,
        release: async () => {
          rmSync(file, { force: true });
        },
      };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

export const lockCommand = defineCommand({
  meta: { name: "lock", description: "Run a heavy command behind the machine-wide semaphore" },
  args: {
    slots: { type: "string", description: "Slots (default: CATHERD_LOCK_SLOTS, else half the CPU cores)" },
  },
  async run({ args, rawArgs }) {
    const sep = rawArgs.indexOf("--");
    const [cmd, ...rest] = sep < 0 ? [] : rawArgs.slice(sep + 1);
    if (!cmd) {
      console.error("usage: catherd lock [--slots N] -- <command> [args...]");
      process.exitCode = 2;
      return;
    }
    const held = await acquire(resolveSlots(args.slots), cmd);
    try {
      const proc = Bun.spawn([cmd, ...rest], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      process.exitCode = await proc.exited;
    } catch (e) {
      console.error(`catherd lock: ${(e as Error).message}`);
      process.exitCode = 1;
    } finally {
      await held.release();
    }
  },
});
