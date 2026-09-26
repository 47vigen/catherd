import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { ExitInfo, RunRecord } from "../domain/record.ts";
import { dispatchPaths, readExit } from "../infra/dispatch-dir.ts";
import { redact } from "../infra/log.ts";
import { listDispatches } from "./dispatches.ts";
import { registerSavedSecrets } from "./jev-service.ts";
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

/**
 * The last `n` non-blank lines of `file`, read backwards `chunk` bytes at a time until they are in hand:
 * a worker's stderr or event stream can be large, and only its end is shown. [] when there is no file.
 */
export function tail(file: string, n = TAIL_LINES, chunk = 64 * 1024): string[] {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return [];
  }
  try {
    let pos = fstatSync(fd).size;
    let buf = Buffer.alloc(0);
    for (;;) {
      const lines = buf.toString("utf8").split("\n");
      // the first line may start mid-line, or mid-character: it counts only once the file's start is read
      if (pos > 0) lines.shift();
      const kept = lines.filter((l) => l.trim());
      if (kept.length >= n || pos === 0) return kept.slice(-n);
      const len = Math.min(chunk, pos);
      pos -= len;
      const part = Buffer.alloc(len);
      readSync(fd, part, 0, len, pos);
      buf = Buffer.concat([part, buf]);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Spec §10.2 `runs show <id> --debug`: per dispatch, oldest first, its record, exit.json and the tails of
 * stderr, events.jsonl and supervisor.log, with every known secret redacted. Reads only.
 */
export function runDebug(run: Run, name?: string): DispatchDebug[] {
  registerSavedSecrets();
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
