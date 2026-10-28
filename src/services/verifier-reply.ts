import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunRecord } from "../domain/record.ts";
import type { Run } from "./run-store.ts";

// Plan 50: how catherd reads a verifier's reply, kept from milestones.ts, which is deleted with the land gate.

/**
 * Plan 23: `VERDICT: BLOCKED: environment — <the probe that proves it>`, a verdict on the machine, not on the
 * work. Its probe, or null when `line` is no such verdict ("" when it names none).
 */
export function blockedByEnvironment(line: string | null | undefined): string | null {
  const m = /^VERDICT:\s*BLOCKED:\s*environment\b\s*(?:—|–|-|:)?\s*(.*)$/i.exec(line?.trim() ?? "");
  return m ? (m[1] ?? "").trim() : null;
}

/** A headless verifier's reply: its first non-blank line, trimmed; null when there is no reply to read. */
export function replyVerdict(run: Run, r: RunRecord): string | null {
  const file = join(run.dir, r.replyPath);
  if (!r.replyPath || !existsSync(file)) return null;
  return (
    readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? null
  );
}
