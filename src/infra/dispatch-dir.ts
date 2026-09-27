import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { EXIT_REASONS, type ExitInfo } from "../domain/record.ts";
import { isAlive, processStartTime } from "./proc.ts";
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
    /** exists from launch until a `wait` hands the dispatch's record to the orchestrator */
    collect: join(dir, "collect"),
    /** while a `wait` hands the record back: names that wait's process, so a crash leaves it reclaimable */
    lease: join(dir, "collect.lease"),
    supervisorLog: join(dir, "supervisor.log"),
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
    writeSync(fd, JSON.stringify({ pid: process.pid, startTime: processStartTime(process.pid) }));
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

/** Marks a dispatch as one a `wait` is to hand back; written before its launch. */
export function markForCollect(dir: string): void {
  writeFileSync(dispatchPaths(dir).collect, "", { mode: PRIVATE_FILE });
}

const errno = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

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

/** A lease no live process holds: its owner is dead, or it names none (a lease is only ever linked in whole). */
function leaseDead(file: string): boolean {
  const who = leaseOwner(file);
  return !who || !isAlive(who.pid, who.startTime);
}

/**
 * Whether a `wait` still has this dispatch's record to hand back: it has the mark, or a lease whose
 * collector died before handing the record back.
 */
export function awaitsCollect(dir: string): boolean {
  const p = dispatchPaths(dir);
  return existsSync(p.collect) || (existsSync(p.lease) && leaseDead(p.lease));
}

/** Links a lease naming this process in, whole and exclusively: true when it is now this process's. */
function linkLease(dir: string): boolean {
  const p = dispatchPaths(dir);
  const tmp = `${p.lease}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, startTime: processStartTime(process.pid) }), {
    mode: PRIVATE_FILE,
  });
  try {
    linkSync(tmp, p.lease);
    return true;
  } catch (e) {
    if (errno(e) !== "EEXIST") throw e;
    return false;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Moves a dead collector's lease aside: true for the one caller that did, with its owner checked again. */
function takeDeadLease(dir: string): boolean {
  const p = dispatchPaths(dir);
  const aside = `${p.lease}.dead.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(p.lease, aside);
  } catch (e) {
    if (errno(e) !== "ENOENT") throw e;
    return false;
  }
  if (!leaseDead(aside)) {
    // it changed hands between the check and the move: give it back, unless another took its place
    try {
      linkSync(aside, p.lease);
    } catch (e) {
      if (errno(e) !== "EEXIST") throw e;
    }
    rmSync(aside, { force: true });
    return false;
  }
  rmSync(aside, { force: true });
  return true;
}

/**
 * Collects the dispatch as a lease naming this process: true for the one caller that got it, so each
 * record reaches one `wait` only. The mark goes only once the lease exists, so a crash never leaves
 * neither; a lease whose collector died is taken over; a live collector's never is. The caller ends the
 * lease with `endCollect` once the record has gone out, or turns it back into the mark with `putBackCollect`.
 */
export function tryCollect(dir: string): boolean {
  const p = dispatchPaths(dir);
  if (!existsSync(p.collect) && !existsSync(p.lease)) return false;
  if (linkLease(dir)) {
    // no lease was there: the record is this caller's only if the mark still is (else it went out already)
    if (!existsSync(p.collect)) {
      endCollect(dir);
      return false;
    }
    rmSync(p.collect, { force: true });
    return true;
  }
  if (!leaseDead(p.lease) || !takeDeadLease(dir) || !linkLease(dir)) return false;
  rmSync(p.collect, { force: true });
  return true;
}

/** Ends this process's lease: the record has gone out. */
export function endCollect(dir: string): void {
  rmSync(dispatchPaths(dir).lease, { force: true });
}

/** Turns this process's lease back into the mark: the record did not go out. */
export function putBackCollect(dir: string): void {
  markForCollect(dir);
  endCollect(dir);
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
