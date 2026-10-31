import type { Overview, RunCard } from "../../../client";
import { formatCost, formatElapsed, formatMinutes } from "./format";

export interface RangeFinding {
  id: string;
  tone: "danger" | "warning" | "neutral";
  title: string;
  detail: string | null;
  /** the run it is about, when there is one */
  run: string | null;
}

const median = (xs: number[]) => {
  const s = xs.toSorted((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};
const names = (runs: RunCard[]) =>
  runs.length > 3
    ? `${runs
        .slice(0, 3)
        .map((r) => r.title)
        .join(", ")} and ${runs.length - 3} more`
    : runs.map((r) => r.title).join(", ");

/**
 * What a person would point at over the range, worst first: runs that did not finish, questions left waiting, the
 * run that cost the most or ran the longest when it stands apart, the one that needed you most, recoveries. Read from
 * the range's recent runs; thresholds keep an ordinary week quiet.
 */
export function rangeFindings(data: Overview, now: number): RangeFinding[] {
  const out: RangeFinding[] = [];
  const runs = data.recent;

  const failed = runs.filter((r) => r.outcome === "failed");
  if (failed.length)
    out.push({
      id: "failed",
      tone: "danger",
      title: failed.length === 1 ? `${failed[0]!.title} failed` : `${failed.length} runs failed`,
      detail:
        failed.length === 1
          ? failed[0]!.endedAt
            ? `ended ${formatElapsed(now - Date.parse(failed[0]!.endedAt))} ago`
            : null
          : names(failed),
      run: failed[0]!.id,
    });

  const oldest = data.questions.first.toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  if (oldest && now - Date.parse(oldest.at) >= 15 * 60_000)
    out.push({
      id: "waiting",
      tone: "warning",
      title: `A question has waited ${formatElapsed(now - Date.parse(oldest.at))}`,
      detail: `${oldest.runTitle} · ${oldest.question}`,
      run: oldest.run,
    });

  const cancelled = runs.filter((r) => r.outcome === "cancelled");
  if (cancelled.length)
    out.push({
      id: "cancelled",
      tone: "warning",
      title:
        cancelled.length === 1 ? `${cancelled[0]!.title} was cancelled` : `${cancelled.length} runs were cancelled`,
      detail: cancelled.length === 1 ? null : names(cancelled),
      run: cancelled[0]!.id,
    });

  const paused = runs.filter((r) => r.paused && r.phase !== "ended");
  if (paused.length)
    out.push({
      id: "paused",
      tone: "warning",
      title: paused.length === 1 ? `${paused[0]!.title} is paused` : `${paused.length} runs are paused`,
      detail: paused.length === 1 ? null : names(paused),
      run: paused[0]!.id,
    });

  const priced = runs.filter((r) => (r.totals.costUsd ?? 0) > 0);
  const spend = priced.reduce((a, r) => a + r.totals.costUsd!, 0);
  const dear = priced.toSorted((a, b) => b.totals.costUsd! - a.totals.costUsd!)[0];
  if (dear && priced.length >= 2 && dear.totals.costUsd! / spend >= 0.4)
    out.push({
      id: "cost",
      tone: "neutral",
      title: `${dear.title} took ${Math.round((dear.totals.costUsd! / spend) * 100)}% of the spend`,
      detail: `${formatCost(dear.totals.costUsd)} of ${formatCost(spend)} across ${priced.length} runs`,
      run: dear.id,
    });

  const timed = runs.filter((r) => r.wallMinutes !== null && r.wallMinutes > 0);
  const typical = median(timed.map((r) => r.wallMinutes!));
  const long = timed.toSorted((a, b) => b.wallMinutes! - a.wallMinutes!)[0];
  if (long && timed.length >= 3 && long.wallMinutes! >= 2 * typical && long.wallMinutes! >= 10)
    out.push({
      id: "long",
      tone: "neutral",
      title: `${long.title} ran ${formatMinutes(long.wallMinutes)}, ${Math.round(long.wallMinutes! / typical)}× the usual run`,
      detail: `the median is ${formatMinutes(typical)}`,
      run: long.id,
    });

  const needy = runs.toSorted((a, b) => b.totals.interventions - a.totals.interventions)[0];
  if (needy && needy.totals.interventions >= 2)
    out.push({
      id: "needy",
      tone: "neutral",
      title: `${needy.title} needed you ${needy.totals.interventions} times`,
      detail:
        data.kpis.interventions > needy.totals.interventions ? `of ${data.kpis.interventions} in the range` : null,
      run: needy.id,
    });

  const rounds = runs.toSorted((a, b) => b.totals.rounds - a.totals.rounds)[0];
  if (rounds && rounds.totals.rounds >= 3)
    out.push({
      id: "rounds",
      tone: "neutral",
      title: `${rounds.title} took ${rounds.totals.rounds} review rounds`,
      detail: null,
      run: rounds.id,
    });

  if (data.failovers + data.climbs > 0)
    out.push({
      id: "recoveries",
      tone: "neutral",
      title: [
        data.failovers ? `${data.failovers} ${data.failovers === 1 ? "failover" : "failovers"}` : null,
        data.climbs ? `${data.climbs} ${data.climbs === 1 ? "climb" : "climbs"}` : null,
      ]
        .filter(Boolean)
        .join(" and "),
      detail: [
        data.failovers ? "a stand-in model ran after a provider limit" : null,
        data.climbs ? "a role was retried on a stronger rung" : null,
      ]
        .filter(Boolean)
        .join("; "),
      run: null,
    });

  return out;
}
