import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { tryLock, withFileLock } from "./filelock.ts";
import { locksDir } from "./paths.ts";
import { isAlive, selfIdentity } from "./proc.ts";
import { ensurePrivateDir, writeJsonAtomic } from "./store.ts";

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
  o: { pollMs?: number; onWait?: () => void } = {},
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
  o: { pollMs?: number; onWait?: () => void } = {},
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
    o.onWait?.();
    await Bun.sleep(Math.min(o.pollMs ?? 500, left));
  }
}

/** A process inside a role lock: who, so a dead one is dropped, and a token, so one process can hold twice. */
interface RoleHolder {
  pid: number;
  startTime: string | null;
  token: string;
}

interface RoleLockState {
  /** whose the lock is: a run id (holders of one run share it), or a lone process's own key */
  owner: string;
  holders: RoleHolder[];
}

function readRoleState(file: string): RoleLockState | null {
  if (!existsSync(file)) return null;
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as RoleLockState;
    return typeof v?.owner === "string" && Array.isArray(v.holders) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Spec 1.5 "Cross-run verifier contention": one owner at a time machine-wide holds the lock of `role`.
 * Commands of the same owner (one run's verifier, side by side within its slots) share it; another owner's
 * wait until the last of them ends, so two runs' verifiers never overlap. A dead holder is dropped.
 */
export async function withRoleLock<T>(
  role: string,
  owner: string,
  fn: () => T | Promise<T>,
  o: { pollMs?: number; onWait?: () => void } = {},
): Promise<T> {
  const dir = locksDir();
  ensurePrivateDir(dir);
  const file = join(dir, `role-${role}.json`);
  const me: RoleHolder = { ...selfIdentity(), token: randomUUID() };
  const enter = () =>
    withFileLock(file, () => {
      const state = readRoleState(file);
      const live = (state?.holders ?? []).filter((h) => isAlive(h.pid, h.startTime));
      if (live.length && state?.owner !== owner) return false;
      writeJsonAtomic(file, { owner, holders: [...live, me] } satisfies RoleLockState);
      return true;
    });
  while (!(await enter())) {
    o.onWait?.();
    await Bun.sleep(o.pollMs ?? 500);
  }
  try {
    return await fn();
  } finally {
    await withFileLock(file, () => {
      const state = readRoleState(file);
      if (state)
        writeJsonAtomic(file, { ...state, holders: state.holders.filter((h) => h.token !== me.token) });
    });
  }
}

/** Who holds the role lock now, or null. */
export function roleLockOwner(role: string): string | null {
  const state = readRoleState(join(locksDir(), `role-${role}.json`));
  return state && state.holders.some((h) => isAlive(h.pid, h.startTime)) ? state.owner : null;
}
