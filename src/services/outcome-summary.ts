import { CHORE_WHY, type LaneRecord, type OutcomeStat, summarize } from "../domain/track-record.ts";
import { latestOutcomes } from "../domain/route.ts";
import { ownerOfFile } from "../domain/run-state.ts";
import type { MilestonePlan } from "../domain/run-events.ts";
import { isDaemonRun, readEvents } from "./run-events-store.ts";
import { listRuns, readOutcomes, readRoutes, type Run } from "./run-store.ts";

/**
 * A daemon run's finished lanes: each lane's last outcome joined with its last route (kind, difficulty, chore),
 * its dispatches (rounds) and the reviewer BLOCKER and BUG findings on files it owns in the last plan. A run with
 * no events.jsonl (a 1.x run) or an unreadable one gives [].
 */
export function laneRecords(run: Run): LaneRecord[] {
  if (!isDaemonRun(run)) return [];
  let events: ReturnType<typeof readEvents>;
  try {
    events = readEvents(run);
  } catch {
    return [];
  }
  const outcomes = latestOutcomes(readOutcomes(run));
  const routes = readRoutes(run);
  let plan: MilestonePlan[] = [];
  const rounds = new Map<string, number>();
  const reviewers = new Set<string>();
  const found: { file: string | null }[] = [];
  for (const e of events) {
    if (e.type === "plan.ready") plan = e.milestones;
    else if (e.type === "dispatch.started") {
      if (e.lane) rounds.set(e.lane, (rounds.get(e.lane) ?? 0) + 1);
      if (e.role === "reviewer") reviewers.add(e.dispatchId);
    } else if (e.type === "dispatch.ended" && reviewers.has(e.dispatchId))
      found.push(...e.findings.filter((f) => f.label !== "NIT"));
  }
  const lanes = plan.flatMap((m) => m.lanes);
  return outcomes.map((o) => {
    const route = routes.findLast((r) => r.lane === o.lane && r.source === "route");
    const n = rounds.get(o.lane) ?? 0;
    return {
      rung: o.startRung,
      kind: route?.kind ?? null,
      difficulty: route?.difficulty ?? null,
      chore: route?.why?.includes(CHORE_WHY) ?? false,
      landed: o.landed,
      firstPass: o.landed && o.start_ok && n === 1,
      rounds: n,
      findings: found.filter((f) => ownerOfFile(f.file, lanes) === o.lane).length,
    };
  });
}

/** The summary over every repo's daemon runs on this machine. */
export function outcomeStats(runs: readonly Run[] = listRuns().runs): OutcomeStat[] {
  return summarize(runs.flatMap(laneRecords));
}
