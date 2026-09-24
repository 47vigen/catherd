import {
  type Catalog,
  type Difficulty,
  type Kind,
  type Profile,
  type Role,
  type RungId,
  rungOf,
  type ScoreDim,
} from "../types.ts";
import { capableFor, entryFor, modelOf } from "./catalog.ts";

export function candidates(p: Profile, c: Catalog, role: Role): RungId[] {
  const rc = p.roles[role];
  if (!rc.enabled) return [];
  const scored: { rung: RungId; costRank: number; secs: number }[] = [];
  for (const [id, efforts] of Object.entries(rc.models)) {
    const m = modelOf(c, id);
    if (!m || !capableFor(role, m)) continue;
    for (const effort of new Set(efforts)) {
      const rung = rungOf(id, effort);
      const entry = m.efforts.includes(effort) ? entryFor(c, rung) : undefined;
      if (entry) {
        scored.push({
          rung,
          costRank: entry.costRank,
          secs: entry.scores.secs_per_task ?? Number.POSITIVE_INFINITY,
        });
      }
    }
  }
  const [first, second] =
    p.objective === "speed" ? (["secs", "costRank"] as const) : (["costRank", "secs"] as const);
  // Infinity - Infinity is NaN, which `||` passes over and sort reads as a tie.
  return scored.sort((a, b) => a[first] - b[first] || a[second] - b[second]).map((s) => s.rung);
}

export function clearsBar(c: Catalog, rung: RungId, kind: Kind, difficulty: Difficulty): boolean {
  const scores = entryFor(c, rung)?.scores;
  if (!scores) return false;
  return Object.entries(c.bars[kind][difficulty]).every(
    ([dim, min]) => min === undefined || (scores[dim as ScoreDim] ?? Number.NEGATIVE_INFINITY) >= min,
  );
}

export function defaultLadder(p: Profile, c: Catalog, role: Role): { rung: RungId; ladder: RungId[] } {
  const all = candidates(p, c, role);
  if (all.length === 0) {
    throw new Error(`catherd: role "${role}" has no enabled, capable, scored model; run profile_validate`);
  }
  const i = Math.max(0, all.indexOf(p.roles[role].defaultRung ?? ""));
  return { rung: all[i] as RungId, ladder: all.slice(i) };
}

/**
 * OVERRIDES cross-plan fix 2: under `objective: "speed"`, the objective picks only the start rung
 * (the fastest bar-clearing candidate). The climb ladder above it is the other bar-clearing
 * candidates at least as strong as the start on the kind's primary dimension (terminal for
 * terminal work, repo_code otherwise), weakest first, costRank breaking ties — so a lane never
 * climbs onto a weaker rung. `objective: "cost"` keeps the plain cost-then-secs order, unchanged.
 */
function speedLadder(c: Catalog, clearing: RungId[], kind: Kind): { rung: RungId; ladder: RungId[] } {
  const start = clearing[0] as RungId;
  const dim: ScoreDim = kind === "terminal" ? "terminal" : "repo_code";
  const strengthOf = (r: RungId) => entryFor(c, r)?.scores[dim] ?? Number.NEGATIVE_INFINITY;
  const startStrength = strengthOf(start);
  const rest = clearing
    .filter((r) => r !== start && strengthOf(r) >= startStrength)
    .sort(
      (a, b) =>
        strengthOf(a) - strengthOf(b) || (entryFor(c, a)?.costRank ?? 0) - (entryFor(c, b)?.costRank ?? 0),
    );
  return { rung: start, ladder: [start, ...rest] };
}

export function select(
  p: Profile,
  c: Catalog,
  role: Role,
  kind: Kind,
  difficulty: Difficulty,
): { rung: RungId; ladder: RungId[] } {
  const all = candidates(p, c, role);
  if (all.length === 1) return { rung: all[0] as RungId, ladder: all };
  const clearing = all.filter((r) => clearsBar(c, r, kind, difficulty));
  if (clearing.length === 0) return defaultLadder(p, c, role);
  return p.objective === "speed"
    ? speedLadder(c, clearing, kind)
    : { rung: clearing[0] as RungId, ladder: clearing };
}
