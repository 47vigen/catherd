import type { RunRecord } from "../domain/record.ts";
import { liveSessionFile, readSessionFiles, type SessionFile } from "../infra/claude-session.ts";
import { awaitsCollect } from "../infra/dispatch-dir.ts";
import { listDispatches, liveDispatches } from "./dispatches.ts";
import { readRecords, type Run } from "./run-store.ts";
import { runOwner } from "./sessions.ts";

export const ORCHESTRATOR_STALL_MS = 5 * 60_000;

/**
 * Plan 22 (#42 finding 3): the line shows only for a current owner (its Claude Code session live, or seen in the
 * last day) and an unread record that ended in the last day, so an abandoned run never reads "stalled" forever.
 */
export const WAIT_WINDOW_MS = 24 * 3_600_000;

export interface OrchestratorWait {
  since: string;
  seconds: number;
  stalled: boolean;
  unread: number;
  /** when the line stops showing, unless the owner is seen again or another record ends */
  until: string;
}

/**
 * When the owner was last seen acting on the run: it took the run (`since`), or one of the run's dispatches was
 * admitted from its session.
 */
function ownerSeen(run: Run, owner: { sessionId: string; since: string }): number {
  let seen = Date.parse(owner.since) || 0;
  for (const d of listDispatches(run))
    if (d.admit.sessionId?.toLowerCase() === owner.sessionId.toLowerCase())
      seen = Math.max(seen, Date.parse(d.admit.admittedAt) || 0);
  return seen;
}

/**
 * Pure diagnostic: queue acceptance cannot show that the orchestrator processed a completion. Null unless the
 * run has a current owner, no live role, and an unread record that ended within WAIT_WINDOW_MS.
 */
export function orchestratorWait(
  run: Run,
  now: number,
  records: RunRecord[] = readRecords(run).records,
  hasLive = liveDispatches(run, now).length > 0,
  files: () => SessionFile[] = readSessionFiles,
): OrchestratorWait | null {
  const owner = runOwner(run);
  if (!owner || hasLive) return null;
  const unread = new Set(
    listDispatches(run)
      .filter((d) => awaitsCollect(d.dir))
      .map((d) => d.admit.dispatchId),
  );
  const recent = records.filter(
    (r) => unread.has(r.dispatchId) && now - (Date.parse(r.endedAt) || 0) < WAIT_WINDOW_MS,
  );
  if (!recent.length) return null;
  const ended = Math.max(...recent.map((r) => Date.parse(r.endedAt) || 0));
  const live = owner.host === "claude-code" && liveSessionFile(owner.sessionId, files()) !== null;
  const seen = live ? now : ownerSeen(run, owner);
  if (now - seen >= WAIT_WINDOW_MS) return null;
  const since = Math.max(ended, Date.parse(owner.since) || 0);
  const elapsed = Math.max(0, now - since);
  return {
    since: new Date(since).toISOString(),
    seconds: Math.floor(elapsed / 1000),
    stalled: elapsed >= ORCHESTRATOR_STALL_MS,
    unread: records.filter((r) => unread.has(r.dispatchId)).length,
    until: new Date(Math.min(ended, seen) + WAIT_WINDOW_MS).toISOString(),
  };
}

/**
 * The one "waiting for orchestrator" line every view shows (#42 finding 7): seconds and `stalled` from `since` at
 * `now`, so a memoised wait stays true between recomputes; null once it is past `until`.
 */
export function waitingLine(w: OrchestratorWait | null | undefined, now: number): string | null {
  if (!w || now >= Date.parse(w.until)) return null;
  const elapsed = Math.max(0, now - Date.parse(w.since));
  return `${elapsed >= ORCHESTRATOR_STALL_MS ? "stalled · " : ""}waiting for orchestrator ${Math.floor(elapsed / 1000)}s`;
}
