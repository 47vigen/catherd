import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { EXIT_REASONS, type ExitInfo } from "../domain/record.ts";
import { lockHeld, withFileLock } from "./filelock.ts";
import { isAlive, selfIdentity } from "./proc.ts";
import { PRIVATE_FILE, readVersioned } from "./store.ts";

export function dispatchPaths(dir: string) {
  return {
    brief: join(dir, "brief.md"),
    spec: join(dir, "spec.json"),
    proc: join(dir, "proc.json"),
    events: join(dir, "events.jsonl"),
    stderr: join(dir, "stderr"),
    reply: join(dir, "reply.md"),
    exit: join(dir, "exit.json"),
    claim: join(dir, "claim"),
    cancel: join(dir, "cancel"),
    /** held by the one supervisor of this dispatch for its lifetime (filelock, dead holders reclaimed) */
    supervisorLock: join(dir, "supervisor.lock"),
    /** exists from admission until the orchestrator reads the record (`result`, `cancel`): "not yet read" */
    collect: join(dir, "collect"),
    /** while a reader takes the record: names that reader's process, so a crash leaves it reclaimable */
    lease: join(dir, "collect.lease"),
    supervisorLog: join(dir, "supervisor.log"),
    /** what failover did for this limited dispatch, written once under `failover.lock` (plan 10) */
    failover: join(dir, "failover.json"),
  };
}

/**
 * Exclusive create: the first caller finalizes; every later caller reads the record it wrote. The claim
 * names its claimant (pid and start time), so a later caller can tell a dead claimant from a slow one.
 */
export function tryClaim(dir: string): boolean {
  let fd: number;
  try {
    fd = openSync(dispatchPaths(dir).claim, "wx", PRIVATE_FILE);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return false;
  }
  try {
    writeSync(fd, JSON.stringify(selfIdentity()));
  } catch (e) {
    // a claim that names no one would hold every other finalizer off until it is stale: drop it
    closeSync(fd);
    try {
      unlinkSync(dispatchPaths(dir).claim);
    } catch {
      // already gone
    }
    throw e;
  }
  closeSync(fd);
  return true;
}

/** Who holds the claim, or null when it names no one (an older build's empty claim, or one being written). */
export function readClaimant(dir: string): { pid: number; startTime: string | null } | null {
  try {
    const c = JSON.parse(readFileSync(dispatchPaths(dir).claim, "utf8")) as {
      pid?: unknown;
      startTime?: unknown;
    };
    if (typeof c.pid !== "number") return null;
    return { pid: c.pid, startTime: typeof c.startTime === "string" ? c.startTime : null };
  } catch {
    return null;
  }
}

/** Marks a dispatch's record as not yet read; written before its launch. */
export function markForCollect(dir: string): void {
  writeFileSync(dispatchPaths(dir).collect, "", { mode: PRIVATE_FILE });
}

const errno = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

/** Test seams: `beforeTakeover` runs after a collector judged a lease dead, before it takes the lock. */
export const collectSeams = { beforeTakeover: async (_dir: string): Promise<void> => {} };
/** The hard link a lease is made with; tests replace it to stand for a filesystem without hard links. */
export const leaseFs = { link: linkSync };

/** An ownerless lease this old was left by a crash mid-write (only the no-hard-link fallback can leave one). */
const OWNERLESS_STALE_MS = 5_000;
/** A lease temp file this old, or whose pid is dead, was left by a crash. */
const TEMP_STALE_MS = 60_000;

const self = selfIdentity;

/** Who holds a collection lease, or null when none can be read. */
function leaseOwner(file: string): { pid: number; startTime: string | null } | null {
  try {
    const c = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; startTime?: unknown };
    if (typeof c.pid !== "number") return null;
    return { pid: c.pid, startTime: typeof c.startTime === "string" ? c.startTime : null };
  } catch {
    return null;
  }
}

function olderThan(file: string, ms: number): boolean {
  try {
    return statSync(file).mtimeMs < Date.now() - ms;
  } catch {
    return false;
  }
}

/**
 * A lease no live process holds: it exists, and its owner is dead, or it names none and is too old to be
 * one still being written.
 */
function leaseDead(file: string): boolean {
  if (!existsSync(file)) return false;
  const who = leaseOwner(file);
  return who ? !isAlive(who.pid, who.startTime) : olderThan(file, OWNERLESS_STALE_MS);
}

/**
 * Whether this dispatch's record is still unread: it has the mark, or a lease whose reader died before the
 * record went out.
 */
export function awaitsCollect(dir: string): boolean {
  const p = dispatchPaths(dir);
  return existsSync(p.collect) || leaseDead(p.lease);
}

/** Creates a lease naming this process, exclusively: true when it is now this process's. */
function createLease(dir: string): boolean {
  const p = dispatchPaths(dir);
  const content = JSON.stringify(self());
  const tmp = `${p.lease}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, content, { mode: PRIVATE_FILE });
  try {
    // linked in whole: no reader ever sees a lease without its owner
    leaseFs.link(tmp, p.lease);
    return true;
  } catch (e) {
    if (errno(e) === "EEXIST") return false;
    if (!["EPERM", "ENOTSUP", "EXDEV", "EOPNOTSUPP"].includes(errno(e) ?? "")) throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
  // no hard links here: an exclusive create, its owner written at once (an ownerless lease is young)
  let fd: number;
  try {
    fd = openSync(p.lease, "wx", PRIVATE_FILE);
  } catch (e) {
    if (errno(e) === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Turns a dead collector's lease back into the mark, serialized by a lock on the lease, and only after
 * reading it again under the lock: the mark is written before the lease goes, so the record is never
 * without both, and a lease that is not dead (gone, or a live collector's) is left alone. A moved lease
 * is never linked back.
 */
async function reviveDeadLease(dir: string): Promise<void> {
  const p = dispatchPaths(dir);
  await withFileLock(p.lease, () => {
    if (!leaseDead(p.lease)) return;
    markForCollect(dir);
    rmSync(p.lease, { force: true });
    sweepLeaseTemps(dir);
  });
}

/**
 * Collects the dispatch as a lease naming this process: true for the one caller that got it, so each
 * record is read (marked read) once. The common path takes no lock: the lease is created exclusively, and
 * the record is this caller's only if the mark still exists then; the mark goes only once the lease
 * exists. A dead collector's lease is first turned back into the mark (`reviveDeadLease`), then
 * collected the same way; a live collector's is never taken. The caller ends the lease with `endCollect`
 * once the record has gone out, or turns it back into the mark with `putBackCollect`.
 */
export async function tryCollect(dir: string): Promise<boolean> {
  const p = dispatchPaths(dir);
  if (!existsSync(p.collect)) {
    if (!leaseDead(p.lease)) return false;
    await collectSeams.beforeTakeover(dir);
    await reviveDeadLease(dir);
  }
  if (!createLease(dir)) {
    // a lease is there: collect it only if it is dead, and only by way of the mark
    if (!leaseDead(p.lease)) return false;
    await collectSeams.beforeTakeover(dir);
    await reviveDeadLease(dir);
    if (!createLease(dir)) return false;
  }
  // no lease was there when this one was made: the record is ours only if the mark still is
  if (!existsSync(p.collect)) {
    endCollect(dir);
    return false;
  }
  rmSync(p.collect, { force: true });
  return true;
}

/** Ends this process's lease (never another's): the record has gone out. Sweeps leftover temp files. */
export function endCollect(dir: string): void {
  const p = dispatchPaths(dir);
  const who = leaseOwner(p.lease);
  // the pid alone: while this process lives no other can hold its pid, so a lease naming it is its own
  if (who?.pid === process.pid) rmSync(p.lease, { force: true });
  sweepLeaseTemps(dir);
}

/** Turns this process's lease back into the mark: the record did not go out. */
export function putBackCollect(dir: string): void {
  markForCollect(dir);
  endCollect(dir);
}

const LEASE_TEMP = /^collect\.lease\.(?:dead\.)?(\d+)\.[^.]+$/;

/** Removes lease temp files a crash left behind: a dead pid's, or any older than a minute. */
function sweepLeaseTemps(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const m = LEASE_TEMP.exec(n);
    if (!m) continue;
    const f = join(dir, n);
    if (!isAlive(Number(m[1]), null) || olderThan(f, TEMP_STALE_MS)) rmSync(f, { force: true });
  }
}

const ExitFileSchema = z.looseObject({
  schema: z.literal(1),
  code: z.number().nullable(),
  signal: z.string().nullable(),
  reason: z.enum(EXIT_REASONS),
  endedAt: z.string(),
});

export function readExit(dir: string): ExitInfo | null {
  try {
    const e = readVersioned(dispatchPaths(dir).exit, ExitFileSchema, 1);
    return { code: e.code, signal: e.signal, reason: e.reason, endedAt: e.endedAt };
  } catch {
    return null;
  }
}

export function requestCancel(dir: string): void {
  writeFileSync(dispatchPaths(dir).cancel, new Date().toISOString(), { mode: PRIVATE_FILE });
}

/** The target of the dispatch's supervisor lock (`supervisor.lock`, as `dispatchPaths` names it). */
export const supervisorLockTarget = (dir: string): string => join(dir, "supervisor");

/** Whether a live supervisor holds the dispatch: launch evidence even before launch.json or proc.json. */
export const supervisorAlive = (dir: string): boolean => lockHeld(supervisorLockTarget(dir));
