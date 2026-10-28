import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, statfsSync } from "node:fs";
import { availableParallelism, loadavg } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CatherdError } from "../domain/errors.ts";
import { roleScopeOfScratch } from "../domain/role-scope.ts";
import { lockHeld, tryLock, withFileLock } from "./filelock.ts";
import { locksDir } from "./paths.ts";
import { isAlive, selfIdentity } from "./proc.ts";
import { ensurePrivateDir, readVersioned, writeJsonAtomic } from "./store.ts";

/** Set in a locked command's env: a `catherd lock` inside it runs at once, holding nothing more. */
export const LOCK_HELD_ENV = "CATHERD_LOCK_HELD";

const envLoadWaitMs = Number(process.env.CATHERD_HEAVY_LOAD_WAIT_MS ?? 900_000);

/** What a waiter reports on each poll: whom it waits for, how many tickets are ahead, and the time waited. */
export interface LockWait {
  lock: string;
  holder: string | null;
  ahead: number;
  waitedMs: number;
}

/**
 * Spec 2.0 decision 18: heavy slots wait while the load is above twice the cores, up to 15 minutes.
 * CATHERD_HEAVY_LOAD_WAIT_MS overrides the wait (0 = none); the test preload sets 0, since a busy CI runner
 * would otherwise stall every lock in the suite, spawned `catherd lock` processes included.
 * Plan 40: the same wait also holds a slot while free disk is under `diskReserveMb` (D14).
 */
export const heavyLimits = {
  loadWaitMs: envLoadWaitMs >= 0 ? envLoadWaitMs : 900_000,
  loadPollMs: 15_000,
  load: (): number => loadavg()[0] ?? 0,
  cores: (): number => availableParallelism(),
  diskReserveMb: 4096,
  /** Free space an unprivileged write can still use on the disk that holds catherd's locks, in MB. */
  freeMb: (): number => {
    try {
      const s = statfsSync(locksDir());
      return Math.floor((s.bavail * s.bsize) / 1_048_576);
    } catch {
      // the gate is advisory: a disk that cannot be read holds no slot
      return Number.POSITIVE_INFINITY;
    }
  },
};

/**
 * The emptied TMPDIR and GOTMPDIR of one slot: under the role's scratch when the caller's TMPDIR is one (a role
 * is told by its TMPDIR, so the slot dir must stay under it), else under catherd's locks dir.
 */
export function slotTmpDir(slot: number, inherited?: string): string {
  return roleScopeOfScratch(inherited)
    ? join(inherited as string, `heavy-${slot}`)
    : join(locksDir(), "tmp", `slot-${slot}`);
}

/** A profile's `lock.heavy` as a slot count: a number, or half the cores. */
export function heavySlots(setting: number | "cpus/2" | undefined): number {
  if (typeof setting === "number" && Number.isFinite(setting)) return Math.max(1, Math.floor(setting));
  return Math.max(1, Math.floor(availableParallelism() / 2));
}

/** A waiter in a queue file: who (so a dead one is dropped), a token and when it joined. */
const TicketSchema = z.object({
  pid: z.number(),
  startTime: z.string().nullable(),
  token: z.string(),
  at: z.number(),
});

type Ticket = z.infer<typeof TicketSchema>;

const QueueSchema = z.looseObject({
  schema: z.literal(1).optional(),
  tickets: z.array(TicketSchema),
});

/** The tickets of a queue file in arrival order; a missing or damaged file is an empty queue. */
function readQueue(file: string): Ticket[] {
  try {
    return readVersioned(file, QueueSchema, 1).tickets;
  } catch (error) {
    if (error instanceof CatherdError && error.code === "E_CONFIG_NEWER_SCHEMA") throw error;
    return [];
  }
}

const alive = (t: Ticket): boolean => isAlive(t.pid, t.startTime);

const liveTickets = (file: string): Ticket[] => readQueue(file).filter(alive);

function writeQueue(file: string, tickets: Ticket[]): void {
  writeJsonAtomic(file, { schema: 1, tickets });
}

/**
 * Under the queue's lock: the live tickets with `me` at the end, joined unless it is there already. Dead tickets
 * are dropped, and the file is written back only when that or the join changed it.
 */
function joinQueue(file: string, me: Ticket): Ticket[] {
  const before = readQueue(file);
  const live = before.filter(alive);
  const joined = live.some((t) => t.token === me.token);
  const queued = joined ? live : [...live, me];
  if (!joined || live.length < before.length) writeQueue(file, queued);
  return queued;
}

/** Under the queue's lock: `token`'s ticket leaves the queue, and the dead tickets with it. */
function leaveQueue(file: string, token: string): void {
  const before = readQueue(file);
  const after = before.filter((t) => t.token !== token && alive(t));
  if (after.length < before.length) writeQueue(file, after);
}

/** The pid holding the first busy heavy slot, for a wait's report; null while none reads back. */
function slotHolder(dir: string, slots: number): string | null {
  for (let i = 0; i < slots; i++) {
    const target = join(dir, `slot-${i}`);
    if (!lockHeld(target)) continue;
    try {
      return String(JSON.parse(readFileSync(`${target}.lock`, "utf8")).pid);
    } catch {
      return null; // released since the check
    }
  }
  return null;
}

const heavyWait = (dir: string, slots: number, started: number, ahead: number): LockWait => ({
  lock: "heavy",
  holder: slotHolder(dir, slots),
  ahead,
  waitedMs: Date.now() - started,
});

interface Slot {
  index: number;
  release: () => void;
}

/**
 * Joins the heavy queue, waits out an overloaded host or a nearly full disk until `gateDeadline` (the ticket holds
 * its place meanwhile), then waits until this ticket is the oldest live one and a slot is free, takes that slot and
 * leaves the queue in the same step, so the next ticket may try at once. Null once `deadline` passes. The ticket
 * is withdrawn on every way out, so an error or a timeout never leaves a live ticket behind.
 */
async function takeSlot(
  dir: string,
  slots: number,
  deadline: number,
  gateDeadline: number,
  started: number,
  o: { pollMs?: number; onWait?: (w: LockWait) => void },
): Promise<Slot | null> {
  const queue = join(dir, "queue-heavy.json");
  const me: Ticket = { ...selfIdentity(), token: randomUUID(), at: Date.now() };
  try {
    await withFileLock(queue, () => joinQueue(queue, me));
    while (
      Date.now() < gateDeadline &&
      (heavyLimits.load() > 2 * heavyLimits.cores() || heavyLimits.freeMb() < heavyLimits.diskReserveMb)
    ) {
      const ahead = liveTickets(queue).findIndex((t) => t.token === me.token);
      o.onWait?.(heavyWait(dir, slots, started, Math.max(0, ahead)));
      await Bun.sleep(Math.min(heavyLimits.loadPollMs, Math.max(1, gateDeadline - Date.now())));
    }
    for (;;) {
      const turn = await withFileLock(queue, (): { slot: Slot } | { ahead: number } => {
        const ahead = joinQueue(queue, me).findIndex((t) => t.token === me.token);
        if (ahead === 0) {
          for (let i = 0; i < slots; i++) {
            const release = tryLock(join(dir, `slot-${i}`));
            if (!release) continue;
            try {
              leaveQueue(queue, me.token);
            } catch (error) {
              release();
              throw error;
            }
            return { slot: { index: i, release } };
          }
        }
        return { ahead };
      });
      if ("slot" in turn) return turn.slot;
      const left = deadline - Date.now();
      if (left <= 0) return null;
      o.onWait?.(heavyWait(dir, slots, started, turn.ahead));
      await Bun.sleep(Math.min(o.pollMs ?? 500, left));
    }
  } finally {
    await withFileLock(queue, () => leaveQueue(queue, me.token));
  }
}

/**
 * Runs `fn` holding one of `slots` machine-wide heavy-command slots, waiting for a free one. A slot is
 * a file lock, so a slot whose holder died, or died before writing its name, is reclaimed.
 */
export async function withHeavySlot<T>(
  slots: number,
  fn: (slot: number, tmp: string) => T | Promise<T>,
  o: { pollMs?: number; onWait?: (w: LockWait) => void; tmpBase?: string } = {},
): Promise<T> {
  const r = await withHeavySlotWithin(slots, Number.POSITIVE_INFINITY, fn, o);
  if (r.busy) throw new Error("unreachable: an unbounded wait never gives up");
  return r.value;
}

/**
 * withHeavySlot with a wait budget (plan 23): `{ busy: true }` when no slot came free within `waitMs`, so a
 * caller with a deadline of its own (preflight) reports the lock as busy instead of timing out behind it.
 * Slots go in arrival order (plan 40 D7): only the oldest waiting ticket tries them.
 */
export async function withHeavySlotWithin<T>(
  slots: number,
  waitMs: number,
  fn: (slot: number, tmp: string) => T | Promise<T>,
  o: { pollMs?: number; onWait?: (w: LockWait) => void; tmpBase?: string } = {},
): Promise<{ busy: false; value: T } | { busy: true }> {
  const dir = locksDir();
  ensurePrivateDir(dir);
  const started = Date.now();
  const deadline = started + waitMs;
  // an overloaded host, or a nearly full disk, runs the command late, not never: the wait is bounded by the
  // load deadline, and the slot loop follows it
  const gateDeadline = started + Math.min(heavyLimits.loadWaitMs, waitMs);
  const slot = await takeSlot(dir, slots, deadline, gateDeadline, started, o);
  if (!slot) return { busy: true };
  const tmp = slotTmpDir(slot.index, o.tmpBase);
  try {
    rmSync(tmp, { recursive: true, force: true });
    ensurePrivateDir(tmp);
    return { busy: false, value: await fn(slot.index, tmp) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    slot.release();
  }
}
