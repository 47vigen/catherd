import { type LaneRecord, type OutcomeStat, summarize } from "../domain/track-record.ts";
import { latestOutcomes } from "../domain/route.ts";
import { isDaemonRun, readEvents } from "./run-events-store.ts";
import { listRuns, readOutcomes, readRoutes, type Run } from "./run-store.ts";

/**
 * A daemon run's finished lanes: each lane's last outcome joined with its last route (kind, difficulty, chore) and
 * its dispatches (rounds). A run with no events (a 1.x run) or an unreadable one gives []. Plan 48: no run has a
 * plan of lanes any more, so no finding is pinned to a lane; plan 49 deletes the outcomes and routes behind this.
 */
export function laneRecords(run: Run): LaneRecord[] {
  let events: ReturnType<typeof readEvents>;
  try {
    if (!isDaemonRun(run)) return [];
    events = readEvents(run);
  } catch {
    return [];
  }
  const outcomes = latestOutcomes(readOutcomes(run));
  const routes = readRoutes(run);
  const rounds = new Map<string, number>();
  for (const e of events)
    if (e.type === "dispatch.started" && e.lane) rounds.set(e.lane, (rounds.get(e.lane) ?? 0) + 1);
  return outcomes.map((o) => {
    const route = routes.findLast((r) => r.lane === o.lane && r.source === "route");
    const n = rounds.get(o.lane) ?? 0;
    return {
      rung: o.startRung,
      kind: route?.kind ?? null,
      difficulty: route?.difficulty ?? null,
      landed: o.landed,
      firstPass: o.landed && o.start_ok && n === 1,
      rounds: n,
      findings: 0,
    };
  });
}

/** The summary over every repo's daemon runs on this machine. */
export function outcomeStats(runs: readonly Run[] = listRuns().runs): OutcomeStat[] {
  return summarize(runs.flatMap(laneRecords));
}
