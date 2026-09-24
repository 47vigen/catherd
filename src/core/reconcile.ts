import type { RunRecord } from "../types.ts";
import { finalizeCodex } from "./codex.ts";
import { finalizeOpencode } from "./opencode.ts";
import { type LiveMarker, readLive } from "./runstore.ts";

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function reconcileLive(runDir: string): { finished: RunRecord[]; stillRunning: LiveMarker[] } {
  const finished: RunRecord[] = [];
  const stillRunning: LiveMarker[] = [];
  for (const m of readLive(runDir)) {
    if (pidAlive(m.pid)) {
      stillRunning.push(m);
      continue;
    }
    finished.push(m.backend === "codex" ? finalizeCodex(runDir, m, null) : finalizeOpencode(runDir, m, null));
  }
  return { finished, stillRunning };
}
