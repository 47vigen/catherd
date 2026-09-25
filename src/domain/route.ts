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
}

export function nextRung(ladder: string[], current: string): string | null {
  const i = ladder.indexOf(current);
  return i >= 0 && i < ladder.length - 1 ? (ladder[i + 1] as string) : null;
}

export const currentRoute = (rows: RouteRow[], lane: string): RouteRow | null =>
  rows.findLast((r) => r.lane === lane) ?? null;
