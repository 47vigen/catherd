import type { Difficulty, Kind } from "./lane.ts";
import type { Role } from "./roles.ts";

export const CLIMB_REASONS = [
  "check-failed-twice",
  "blocker",
  "same-defect",
  "refused",
  "blocked",
  "unchanged",
] as const;
export type ClimbReason = (typeof CLIMB_REASONS)[number];

/** Spec §5.4: where a lane's kind and difficulty came from. */
export type RouteSource = "jev" | "lane" | "default";

/** What Jev said about a lane, kept with its route for outcomes.jsonl (spec §5.6). */
export interface RouteJev {
  pKind: number | null;
  pA: number | null;
  pB: number | null;
  nouls: Record<string, number>;
}

/** One row of routes.jsonl: a lane's route, or one climb of it. The last row of a lane is its current route. */
export interface RouteRow {
  at: string;
  lane: string;
  role: Role;
  rung: string;
  ladder: string[];
  source: "route" | "climb";
  decidedBy: RouteSource;
  from: string | null;
  reason: string | null;
  kind: Kind | null;
  difficulty: Difficulty | null;
  /** route rows: the Jev question set asked (null when Jev was not asked) and its probabilities */
  questionSet?: string | null;
  jev?: RouteJev | null;
  /** climb rows: the climb was caused by the environment, not the rung's capability (spec §5.6) */
  env?: boolean;
}

export function nextRung(ladder: string[], current: string): string | null {
  const i = ladder.indexOf(current);
  return i >= 0 && i < ladder.length - 1 ? (ladder[i + 1] as string) : null;
}

export const currentRoute = (rows: RouteRow[], lane: string): RouteRow | null =>
  rows.findLast((r) => r.lane === lane) ?? null;

/** One outcomes.jsonl row (spec §5.6): how a routed lane ended, for calibrating Jev's route rule. */
export interface OutcomeRow {
  at: string;
  lane: string;
  questionSet: string | null;
  jevProbs: RouteJev | null;
  source: RouteSource;
  startRung: string;
  finalRung: string;
  climbs: { from: string; to: string; reason: string; env: boolean }[];
  /** true when the lane landed, false when it ended open (a climb past its top rung) */
  landed: boolean;
  /** landed with no climb the rung itself caused */
  start_ok: boolean;
  /** the ladder index it landed on; null when it ended open (censored) */
  min_ok_index: number | null;
  /** some climb was the environment's fault: calibration leaves this lane out */
  envCaused: boolean;
}

/** The lane's outcome from its routes.jsonl rows since its last route; null when it was never routed. */
export function laneOutcome(rows: RouteRow[], lane: string, landed: boolean, at: string): OutcomeRow | null {
  const mine = rows.filter((r) => r.lane === lane);
  const i = mine.findLastIndex((r) => r.source === "route");
  const start = mine[i];
  if (!start) return null;
  const climbs = mine
    .slice(i + 1)
    .filter((r) => r.source === "climb" && r.from !== null && r.from !== r.rung)
    .map((r) => ({ from: r.from as string, to: r.rung, reason: r.reason ?? "", env: r.env === true }));
  const finalRung = mine.at(-1)?.rung ?? start.rung;
  const idx = start.ladder.indexOf(finalRung);
  return {
    at,
    lane,
    questionSet: start.questionSet ?? null,
    jevProbs: start.jev ?? null,
    source: start.decidedBy,
    startRung: start.rung,
    finalRung,
    climbs,
    landed,
    start_ok: landed && climbs.every((c) => c.env),
    min_ok_index: landed && idx >= 0 ? idx : null,
    envCaused: climbs.some((c) => c.env),
  };
}
