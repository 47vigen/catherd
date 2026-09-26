import { existsSync, readFileSync } from "node:fs";
import type { ExitInfo, RunRecord } from "../domain/record.ts";
import { dispatchPaths, readExit } from "../infra/dispatch-dir.ts";
import { redact } from "../infra/log.ts";
import { listDispatches } from "./dispatches.ts";
import { readRecords, type Run } from "./run-store.ts";

/** How many trailing lines of stderr, events and the supervisor log `runs show --debug` prints. */
export const TAIL_LINES = 20;

export interface DispatchDebug {
  name: string;
  dispatchId: string;
  rung: string;
  admittedAt: string;
  record: RunRecord | null;
  exit: ExitInfo | null;
  stderrTail: string[];
  eventsTail: string[];
  supervisorTail: string[];
}

function tail(file: string, n = TAIL_LINES): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .slice(-n);
}

/**
 * Spec §10.2 `runs show <id> --debug`: per dispatch, oldest first, its record, exit.json and the tails of
 * stderr, events.jsonl and supervisor.log, with every known secret redacted. Reads only.
 */
export function runDebug(run: Run, name?: string): DispatchDebug[] {
  const records = new Map(readRecords(run).records.map((r) => [r.dispatchId, r]));
  return listDispatches(run)
    .filter((d) => name === undefined || d.admit.name === name)
    .sort((a, b) => a.admit.dispatchId.localeCompare(b.admit.dispatchId))
    .map((d) => {
      const p = dispatchPaths(d.dir);
      return redact({
        name: d.admit.name,
        dispatchId: d.admit.dispatchId,
        rung: d.admit.rung,
        admittedAt: d.admit.admittedAt,
        record: records.get(d.admit.dispatchId) ?? null,
        exit: readExit(d.dir),
        stderrTail: tail(p.stderr),
        eventsTail: tail(p.events),
        supervisorTail: tail(p.supervisorLog),
      });
    });
}
