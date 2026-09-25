import { closeSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { EXIT_REASONS, type ExitInfo } from "../domain/record.ts";
import { readVersioned } from "./store.ts";

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
    supervisorLog: join(dir, "supervisor.log"),
  };
}

/** Exclusive create: the first caller finalizes; every later caller reads the record it wrote. */
export function tryClaim(dir: string): boolean {
  try {
    closeSync(openSync(dispatchPaths(dir).claim, "wx"));
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return false;
  }
}

export const ExitFileSchema = z.looseObject({
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
  writeFileSync(dispatchPaths(dir).cancel, new Date().toISOString());
}
