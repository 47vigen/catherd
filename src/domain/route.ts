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

/**
 * Spec §5.4: where a lane's kind and difficulty came from. `jev-kind`: Jev was sure of the kind only, and the
 * difficulty came from the lane's `Difficulty:` line, else from the role's default rung.
 */
export type RouteSource = "jev" | "jev-kind" | "lane" | "default" | "decision";

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
  /** route rows (spec 1.5 plan 24): the decision in one line, as `route` returned it */
  why?: string;
  /** plan 44 D24, `decision` rows: the picked level, how many levels the decision had, and the rung's intelligence */
  level?: number;
  levels?: number;
  intelligence?: number;
  /** route rows: where Jev disagreed with the lane's declared Kind/Difficulty */
  jevSaid?: string;
  /** route rows: no rung clears the lane's bar, and the closest one */
  noClear?: string;
  /** route rows: rungs of equal scores on other quotas competed for the start, and what decided */
  tie?: string;
  /** route rows: the chosen rung's thresholds, values and sources (spec 1.2 §5.3), kept out of `route`'s answer */
  provenance?: unknown;
}

/**
 * Spec 1.5 plan 24: one routes.jsonl row for a role's decision outside a lane: `route` without a lane file, or
 * a lane-less `dispatch` (its `name`). `readRoutes` skips these rows: they have no lane to climb.
 */
export interface RoleRouteRow {
  at: string;
  lane: null;
  role: Role;
  /** the dispatch's name; null for a `route` */
  name: string | null;
  rung: string;
  ladder: string[];
  source: "route" | "dispatch";
  /** who chose the rung: the router (its source), or the coordinator passing `rung` to `dispatch` */
  decidedBy: RouteSource | "orchestrator";
  why: string;
  provenance?: unknown;
}

/**
 * Plan 33: one routes.jsonl row each time a dispatch fails over after a limit (decision 6): the rung it left,
 * the stand-in `failoverRung` chose (null when every candidate was held or weaker), and the quotas held. The
 * row has no lane to climb and no route to read, so `readRoutes` and `readRoleRoutes` skip it by `source`.
 */
export interface FailoverRouteRow {
  at: string;
  lane: string | null;
  role: Role;
  name: string;
  source: "failover";
  from: string;
  rung: string | null;
  why: string;
  held: string[];
}

export function nextRung(ladder: string[], current: string): string | null {
  const i = ladder.indexOf(current);
  return i >= 0 && i < ladder.length - 1 ? (ladder[i + 1] as string) : null;
}

export const currentRoute = (rows: RouteRow[], lane: string): RouteRow | null =>
  rows.findLast((r) => r.lane === lane) ?? null;

/**
 * The lane's route in force at `at`: its last row stamped at or before that time; null when the lane
 * had no row by then (or `at` is not a time). Rows without a parseable `at` are skipped.
 */
export function routeAt(rows: RouteRow[], lane: string, at: string): RouteRow | null {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return null;
  return rows.findLast((r) => r.lane === lane && Date.parse(r.at) <= t) ?? null;
}

/**
 * One outcomes.jsonl row (spec §5.6): how a routed lane ended, for calibrating Jev's route rule.
 * A lane can get several rows (a top-rung failure later landed, a milestone landed again):
 * the last row per lane wins; read them through `latestOutcomes`.
 */
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
  /** plan 44 R7: the level of the lane's first decision, how many levels it had and its rung's intelligence; null before decisions */
  level?: number | null;
  levels?: number | null;
  intelligence?: number | null;
}

/** The lane's outcome from its routes.jsonl rows since its last route; null when it was never routed. */
export function laneOutcome(rows: RouteRow[], lane: string, landed: boolean, at: string): OutcomeRow | null {
  const mine = rows.filter((r) => r.lane === lane);
  const decisions = mine.filter((r) => r.source === "route" && r.decidedBy === "decision");
  if (decisions.length > 0) return decisionOutcome(decisions, lane, landed, at);
  const i = mine.findLastIndex((r) => r.source === "route");
  const start = mine[i];
  if (!start) return null;
  // every climb row counts for start_ok and envCaused, including a no-op past the top rung (from === rung),
  // which only drops out of the listed climbs
  const allClimbs = mine
    .slice(i + 1)
    .filter((r) => r.source === "climb" && r.from !== null)
    .map((r) => ({ from: r.from as string, to: r.rung, reason: r.reason ?? "", env: r.env === true }));
  const climbs = allClimbs.filter((c) => c.from !== c.to);
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
    start_ok: landed && allClimbs.every((c) => c.env),
    min_ok_index: landed && idx >= 0 ? idx : null,
    envCaused: allClimbs.some((c) => c.env),
    level: null,
    levels: null,
    intelligence: null,
  };
}

/**
 * plan 44 D24: a lane decided per dispatch. The first decision is the start and the last the final rung; each change
 * of rung between two decisions is a climb with reason `decision`. The level fields are the first decision's.
 */
function decisionOutcome(rows: RouteRow[], lane: string, landed: boolean, at: string): OutcomeRow {
  const start = rows[0] as RouteRow;
  const final = rows.at(-1) as RouteRow;
  const climbs = rows.flatMap((r, i) => {
    const from = rows[i - 1]?.rung;
    return from !== undefined && from !== r.rung
      ? [{ from, to: r.rung, reason: "decision", env: false }]
      : [];
  });
  const idx = final.ladder.indexOf(final.rung);
  return {
    at,
    lane,
    questionSet: null,
    jevProbs: null,
    source: "decision",
    startRung: start.rung,
    finalRung: final.rung,
    climbs,
    landed,
    start_ok: landed && climbs.length === 0,
    min_ok_index: landed && idx >= 0 ? idx : null,
    envCaused: false,
    level: start.level ?? null,
    levels: start.levels ?? null,
    intelligence: start.intelligence ?? null,
  };
}

/**
 * Spec 1.5 plan 24: a lane's final outcome in routes.jsonl, beside the route row that holds Jev's answer, for
 * calibrating Jev's difficulty question: what Jev said and what the route used, whether the lane climbed, and
 * how it ended. `readRoutes` skips these rows; outcomes.jsonl keeps its own (spec §5.6).
 */
export interface OutcomeRouteRow {
  at: string;
  lane: string;
  source: "outcome";
  decidedBy: RouteSource;
  kind: Kind | null;
  difficulty: Difficulty | null;
  questionSet: string | null;
  jev: RouteJev | null;
  /** some climb moved the lane to another rung (an environment climb included) */
  climbed: boolean;
  startRung: string;
  finalRung: string;
  landed: boolean;
  start_ok: boolean;
  envCaused: boolean;
}

/** The routes.jsonl outcome row of `o`, with the kind and difficulty of the lane's last route. */
export function outcomeRouteRow(rows: RouteRow[], o: OutcomeRow): OutcomeRouteRow {
  const start = rows.findLast((r) => r.lane === o.lane && r.source === "route");
  return {
    at: o.at,
    lane: o.lane,
    source: "outcome",
    decidedBy: o.source,
    kind: start?.kind ?? null,
    difficulty: start?.difficulty ?? null,
    questionSet: o.questionSet,
    jev: o.jevProbs,
    climbed: o.climbs.length > 0,
    startRung: o.startRung,
    finalRung: o.finalRung,
    landed: o.landed,
    start_ok: o.start_ok,
    envCaused: o.envCaused,
  };
}

/** Spec §5.6: one row per lane, the last one written (last row per lane wins), in first-seen lane order. */
export function latestOutcomes(rows: OutcomeRow[]): OutcomeRow[] {
  const byLane = new Map<string, OutcomeRow>();
  for (const r of rows) byLane.set(r.lane, r);
  return [...byLane.values()];
}
