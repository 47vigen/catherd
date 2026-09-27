import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { EXIT_REASONS, type ExitInfo } from "../domain/record.ts";
import { processStartTime } from "./proc.ts";
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
  } finally {
    closeSync(fd);
  }
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

export const awaitsCollect = (dir: string): boolean => existsSync(dispatchPaths(dir).collect);

/** Removes the mark: true for the one caller that removed it, so each record reaches one `wait` only. */
export function tryCollect(dir: string): boolean {
  try {
    unlinkSync(dispatchPaths(dir).collect);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return false;
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
