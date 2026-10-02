import type { RunRecord } from "../domain/record.ts";
import { awaitsCollect } from "../infra/dispatch-dir.ts";
import { listDispatches, liveDispatches } from "./dispatches.ts";
import { readRecords, type Run } from "./run-store.ts";
import { runOwner } from "./sessions.ts";

export const ORCHESTRATOR_STALL_MS = 5 * 60_000;

export interface OrchestratorWait {
  since: string;
  seconds: number;
  stalled: boolean;
  unread: number;
}

/** Pure diagnostic: queue acceptance cannot show that the orchestrator processed a completion. */
export function orchestratorWait(
  run: Run,
  now: number,
  records: RunRecord[] = readRecords(run).records,
  hasLive = liveDispatches(run, now).length > 0,
): OrchestratorWait | null {
  const owner = runOwner(run);
  if (!owner || hasLive) return null;
  const unread = new Set(
    listDispatches(run)
      .filter((d) => awaitsCollect(d.dir))
      .map((d) => d.admit.dispatchId),
  );
  if (!records.some((r) => unread.has(r.dispatchId))) return null;
  const ended = records.map((r) => Date.parse(r.endedAt)).filter(Number.isFinite);
  if (!ended.length) return null;
  const since = Math.max(...ended, Date.parse(owner.since) || 0);
  const elapsed = Math.max(0, now - since);
  return {
    since: new Date(since).toISOString(),
    seconds: Math.floor(elapsed / 1000),
    stalled: elapsed >= ORCHESTRATOR_STALL_MS,
    unread: records.filter((r) => unread.has(r.dispatchId)).length,
  };
}
