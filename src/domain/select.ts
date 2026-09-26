import {
  type Catalog,
  capableFor,
  type Dim,
  effortOffered,
  type RungInfo,
  rungInfo,
  scoresOf,
} from "./catalog.ts";
import { type BillingMode, type Cost, compareCost, costOf, DEFAULT_BILLING } from "./cost.ts";
import { CatherdError } from "./errors.ts";
import type { Difficulty, Kind } from "./lane.ts";
import type { Role } from "./roles.ts";

/** What routing reads from a profile for one role. */
export interface RoutingProfile {
  objective: "cost" | "speed";
  billing: Partial<Record<string, BillingMode>>;
  role: { enabled: boolean; rungs: string[]; defaultRung?: string };
}

export interface Candidate {
  rung: string;
  info: RungInfo;
  scores: Partial<Record<Dim, number>>;
  cost: Cost;
  /** median seconds over the user's own runs (≥ 5 samples), else null */
  secs: number | null;
}

export interface Pick {
  rung: string;
  ladder: string[];
}

const byNull = (a: number | null, b: number | null) =>
  a === null || b === null ? (a === null ? 1 : 0) - (b === null ? 1 : 0) : a - b;

export function secsOf(c: Catalog, canonical: string, kind: Kind | null): number | null {
  return c.secs[`${canonical}|${kind ?? "*"}`] ?? c.secs[`${canonical}|*`] ?? null;
}

/**
 * The role's enabled rungs that the catalog can place: parseable, offered by their model, listed by
 * the backend when it has a listing, capable for the role, and scored (their own or a treat-like).
 * Ordered by cost (spec §5.3), or by measured speed with cost breaking ties; with fewer than 5
 * samples a rung has no speed, and cost orders it, which within a model is effort order.
 */
export function candidates(c: Catalog, p: RoutingProfile, role: Role, kind: Kind | null = null): Candidate[] {
  if (!p.role.enabled) return [];
  const out: Candidate[] = [];
  for (const rung of new Set(p.role.rungs)) {
    let info: RungInfo;
    try {
      info = rungInfo(c, rung);
    } catch {
      continue;
    }
    if (!effortOffered(info) || info.listed === false || !capableFor(c, info, role)) continue;
    const s = scoresOf(c, info.canonical);
    if (!s) continue;
    const mode = p.billing[info.key] ?? DEFAULT_BILLING[info.key];
    out.push({
      rung,
      info,
      scores: s.values,
      cost: costOf(info.family, info.parsed.effort, mode),
      secs: secsOf(c, info.canonical, kind),
    });
  }
  const cost = (a: Candidate, b: Candidate) => compareCost(a.cost, b.cost) || byNull(a.secs, b.secs);
  const speed = (a: Candidate, b: Candidate) => byNull(a.secs, b.secs) || compareCost(a.cost, b.cost);
  return out.sort(p.objective === "speed" ? speed : cost);
}

export function clearsBar(c: Catalog, cand: Candidate, kind: Kind, difficulty: Difficulty): boolean {
  return Object.entries(c.bars[kind][difficulty]).every(
    ([dim, min]) => min === undefined || (cand.scores[dim as Dim] ?? Number.NEGATIVE_INFINITY) >= min,
  );
}

function noRung(role: Role): CatherdError {
  return new CatherdError("E_CONFIG_INVALID", `role "${role}" has no enabled, capable, scored rung`, {
    fix: "run profile_validate, then enable a scored rung or map one with catherd catalog treat-like",
  });
}

/** The role's default rung and every candidate above it (the whole list when it has no default). */
export function defaultLadder(c: Catalog, p: RoutingProfile, role: Role): Pick {
  const all = candidates(c, p, role).map((x) => x.rung);
  if (all.length === 0) throw noRung(role);
  const i = Math.max(0, all.indexOf(p.role.defaultRung ?? ""));
  return { rung: all[i] as string, ladder: all.slice(i) };
}

/**
 * Under `objective: "speed"` the objective picks only the start (the fastest bar-clearing rung); the
 * ladder above it is the other bar-clearing rungs at least as strong on the kind's primary dimension,
 * weakest first, cost breaking ties, so a lane never climbs onto a weaker rung. Ported from 0.x.
 */
function speedLadder(clearing: Candidate[], kind: Kind): Pick {
  const start = clearing[0] as Candidate;
  const dim: Dim = kind === "terminal" ? "terminal" : "repo_code";
  const strength = (x: Candidate) => x.scores[dim] ?? Number.NEGATIVE_INFINITY;
  const rest = clearing
    .filter((x) => x !== start && strength(x) >= strength(start))
    .sort((a, b) => strength(a) - strength(b) || compareCost(a.cost, b.cost));
  return { rung: start.rung, ladder: [start, ...rest].map((x) => x.rung) };
}

/** Spec §5.4: the start rung and ladder for a lane of this kind and difficulty (0.x `select`). */
export function select(c: Catalog, p: RoutingProfile, role: Role, kind: Kind, difficulty: Difficulty): Pick {
  const all = candidates(c, p, role, kind);
  if (all.length === 0) throw noRung(role);
  if (all.length === 1) return { rung: all[0]?.rung as string, ladder: [all[0]?.rung as string] };
  const clearing = all.filter((x) => clearsBar(c, x, kind, difficulty));
  if (clearing.length === 0) return defaultLadder(c, p, role);
  return p.objective === "speed"
    ? speedLadder(clearing, kind)
    : { rung: clearing[0]?.rung as string, ladder: clearing.map((x) => x.rung) };
}
