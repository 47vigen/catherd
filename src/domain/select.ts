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
import { quotaOf } from "./failover.ts";
import { tryParseRung } from "./ids.ts";
import { DIFFICULTIES, type Difficulty, type Kind } from "./lane.ts";
import type { Role } from "./roles.ts";

/** What routing reads from a profile for one role. */
export interface RoutingProfile {
  objective: "cost" | "speed";
  billing: Partial<Record<string, BillingMode>>;
  role: { enabled: boolean; rungs: string[]; defaultRung?: string };
  /**
   * spec 1.5 plan 24: the run's dispatches so far per quota (`quotaOf`), the headroom a tie between rungs of
   * equal scores is broken on; absent, every quota counts 0 and the candidates' order breaks it
   */
  usage?: Partial<Record<string, number>>;
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
  /** spec 1.5 plan 24: no rung clears the lane's bar (`no rung clears repo_code/hard; best is …`) */
  noClear?: string;
  /** spec 1.5 plan 24: rungs of equal scores competed for the start, and how the tie was broken */
  tie?: string;
}

const byNull = (a: number | null, b: number | null) =>
  a === null || b === null ? (a === null ? 1 : 0) - (b === null ? 1 : 0) : a - b;

function secsOf(c: Catalog, canonical: string, kind: Kind | null): number | null {
  return c.secs[`${canonical}|${kind ?? "*"}`] ?? c.secs[`${canonical}|*`] ?? null;
}

/**
 * The role's enabled rungs that the catalog can place: parseable, offered by their model, listed by
 * the backend when it has a listing, capable for the role, and scored (their own or a treat-like).
 * Ordered by cost (spec §5.3), or by measured speed with cost breaking ties; with fewer than 5
 * samples a rung has no speed, and cost orders it, which within a model is effort order. The profile's
 * ladder order breaks every remaining tie (spec 1.5 plan 24), so equal rungs start in the order the user wrote.
 */
export function candidates(c: Catalog, p: RoutingProfile, role: Role, kind: Kind | null = null): Candidate[] {
  if (!p.role.enabled) return [];
  const out: Candidate[] = [];
  const order = [...new Set(p.role.rungs)];
  for (const rung of order) {
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
  const written = (a: Candidate, b: Candidate) => order.indexOf(a.rung) - order.indexOf(b.rung);
  const cost = (a: Candidate, b: Candidate) =>
    compareCost(a.cost, b.cost) || byNull(a.secs, b.secs) || written(a, b);
  const speed = (a: Candidate, b: Candidate) =>
    byNull(a.secs, b.secs) || compareCost(a.cost, b.cost) || written(a, b);
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

/** The dimensions a ladder is compared on: the bar's, else every dimension the start has a value on. */
function compareDims(start: Candidate, bar: Partial<Record<Dim, number>>): Dim[] {
  const dims = (Object.keys(bar) as Dim[]).filter((d) => bar[d] !== undefined);
  return dims.length ? dims : (Object.keys(start.scores) as Dim[]);
}

/** `x` scores at least `start` on every one of `dims` (a missing value scores below any). */
const atLeast = (x: Candidate, start: Candidate, dims: Dim[]): boolean =>
  dims.every(
    (d) => (x.scores[d] ?? Number.NEGATIVE_INFINITY) >= (start.scores[d] ?? Number.NEGATIVE_INFINITY),
  );

/** Spec 1.5 plan 24: how many of `rungs` (a run's dispatched rungs) drew on each quota. */
export function quotaUsage(rungs: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const rung of rungs) {
    const r = tryParseRung(rung);
    if (r) out[quotaOf(r)] = (out[quotaOf(r)] ?? 0) + 1;
  }
  return out;
}

/** Equal on every one of `dims`: a tie for the start. */
const same = (a: Candidate, b: Candidate, dims: Dim[]): boolean => atLeast(a, b, dims) && atLeast(b, a, dims);

const quota = (x: Candidate): string => quotaOf(x.info.parsed);

/**
 * Spec 1.5 plan 24: when rungs on other quotas score exactly as `start` does on `dims`, the start goes to the
 * quota with the most headroom (the fewest of the run's dispatches so far), the candidates' order (cost, then
 * the profile's ladder order) breaking an equal count. `tie` says what decided. Rungs of one quota that tie
 * are no tie (cost already orders them), nor is a rung of another cost tier.
 */
function breakTie(
  start: Candidate,
  order: Candidate[],
  dims: Dim[],
  usage: Partial<Record<string, number>>,
): { start: Candidate; tie?: string } {
  // a metered rung never wins a tie over a plan's: headroom is free only within the start's cost tier
  const rivals = order.filter(
    (x) =>
      x !== start && quota(x) !== quota(start) && x.cost.tier === start.cost.tier && same(x, start, dims),
  );
  if (rivals.length === 0) return { start };
  const used = (x: Candidate) => usage[quota(x)] ?? 0;
  const tied = [start, ...rivals];
  const pick = [...tied].sort((a, b) => used(a) - used(b))[0] as Candidate;
  const others = tied.filter((x) => x !== pick).map((x) => x.rung);
  const counts = [...new Set(tied.map(quota))].map((q) => `${q} ${usage[q] ?? 0}`).join(", ");
  const why = tied.every((x) => used(x) === used(pick))
    ? `equal headroom (${used(pick)} dispatches each); the profile's ladder order and cost decided`
    : `${quota(pick)} has the most headroom (dispatches in this run: ${counts})`;
  return {
    start: pick,
    tie: `tie on ${dims.join(", ")} with ${others.join(", ")}: started on ${pick.rung}; ${why}`,
  };
}

/**
 * Spec 1.5 plan 24, "climb ladders only go up": the start (after a tie on equal scores goes to the quota with
 * the most headroom), then, in `order`'s order, every other candidate that scores at least the last rung kept
 * on `dims`. A stronger rung is on the ladder wherever cost puts it, and one weaker than the rung before it
 * never is (checking each against the start alone let a cheaper, weaker rung follow a stronger one), so a
 * climb never lands on a rung below the one it leaves.
 */
function ladderFrom(
  first: Candidate,
  order: Candidate[],
  dims: Dim[],
  usage: Partial<Record<string, number>> = {},
): Pick {
  const { start, tie } = breakTie(first, order, dims, usage);
  const kept = [start];
  for (const x of order) if (x !== start && atLeast(x, kept.at(-1) as Candidate, dims)) kept.push(x);
  return { rung: start.rung, ladder: kept.map((x) => x.rung), ...(tie ? { tie } : {}) };
}

/**
 * The role's default rung and every candidate at least as strong on every dimension it has a value on (the
 * whole list when it has no default), in cost order under either objective: speed order would put slower, not
 * stronger, rungs above the default.
 */
export function defaultLadder(c: Catalog, p: RoutingProfile, role: Role): Pick {
  const all = candidates(c, { ...p, objective: "cost" }, role);
  if (all.length === 0) throw noRung(role);
  const start = all.find((x) => x.rung === p.role.defaultRung) ?? (all[0] as Candidate);
  return ladderFrom(start, all, compareDims(start, {}), p.usage);
}

/**
 * The role's default difficulty for a kind: the hardest difficulty whose bar the role's default rung clears
 * (`build` when it clears none, or is no candidate: never `copy`, whose start is the cheapest rung, below
 * what the `default` source would pick). A route sure of the kind but not the difficulty starts there.
 */
export function defaultDifficulty(c: Catalog, p: RoutingProfile, role: Role, kind: Kind): Difficulty {
  const start = defaultLadder(c, p, role).rung;
  const cand = candidates(c, p, role, kind).find((x) => x.rung === start);
  const cleared = cand ? DIFFICULTIES.filter((d) => clearsBar(c, cand, kind, d)) : [];
  return cleared.at(-1) ?? "build";
}

/** The kind's main dimension: what a speed ladder sorts on and what `best is` reads first. */
export const primaryDim = (kind: Kind): Dim =>
  kind === "terminal" ? "terminal" : kind === "ui" ? "frontend" : "repo_code";

/**
 * Under `objective: "speed"` the objective picks only the start (the fastest bar-clearing rung); the
 * ladder above it is the other rungs at least as strong on the bar, weakest first on the kind's primary
 * dimension, cost breaking ties, so a lane never climbs onto a weaker rung. Ported from 0.x.
 */
function speedLadder(start: Candidate, all: Candidate[], kind: Kind, dims: Dim[], p: RoutingProfile): Pick {
  const dim = primaryDim(kind);
  const strength = (x: Candidate) => x.scores[dim] ?? Number.NEGATIVE_INFINITY;
  const order = [...all].sort((a, b) => strength(a) - strength(b) || compareCost(a.cost, b.cost));
  return ladderFrom(start, order, dims, p.usage);
}

/** The thresholds of `bar` a rung misses, each with its value: `agentic 0.0818 < 0.1077`. */
function shortfalls(cand: Candidate, bar: Partial<Record<Dim, number>>): string[] {
  return (Object.entries(bar) as [Dim, number | undefined][]).flatMap(([dim, min]) => {
    if (min === undefined) return [];
    const v = cand.scores[dim];
    return v !== undefined && v >= min ? [] : [`${dim} ${v ?? "none"} < ${min}`];
  });
}

/**
 * Spec 1.5 plan 24: when no rung clears a bar, the one closest to it: the fewest thresholds missed, then the
 * highest on the kind's primary dimension, then the candidates' order.
 */
function bestOf(all: Candidate[], bar: Partial<Record<Dim, number>>, kind: Kind): Candidate {
  const dim = primaryDim(kind);
  const v = (x: Candidate) => x.scores[dim] ?? Number.NEGATIVE_INFINITY;
  const misses = (x: Candidate) => shortfalls(x, bar).length;
  return [...all].sort((a, b) => misses(a) - misses(b) || v(b) - v(a))[0] as Candidate;
}

/** `no rung clears repo_code/hard; best is codex:gpt-6-sol#xhigh (agentic 0.0818 < 0.1077)`. */
export function noClearLine(
  all: Candidate[],
  bar: Partial<Record<Dim, number>>,
  kind: Kind,
  d: Difficulty,
): string {
  const best = bestOf(all, bar, kind);
  return `no rung clears ${kind}/${d}; best is ${best.rung} (${shortfalls(best, bar).join(", ")})`;
}

/**
 * Spec §5.4: the start rung and ladder for a lane of this kind and difficulty (0.x `select`). The start is the
 * first rung in objective order that clears the bar. When none does, it is the default rung, raised to an
 * easier difficulty's start when that one scores at least the default on this bar (spec 1.5 plan 24: `logic`
 * starts no lower than `build`), and `noClear` says so. The ladder above the start only goes up.
 */
export function select(c: Catalog, p: RoutingProfile, role: Role, kind: Kind, difficulty: Difficulty): Pick {
  const all = candidates(c, p, role, kind);
  if (all.length === 0) throw noRung(role);
  const bar = c.bars[kind][difficulty];
  if (all.length === 1) {
    const only = all[0] as Candidate;
    const one = { rung: only.rung, ladder: [only.rung] };
    return clearsBar(c, only, kind, difficulty)
      ? one
      : { ...one, noClear: noClearLine(all, bar, kind, difficulty) };
  }
  const first = all.find((x) => clearsBar(c, x, kind, difficulty));
  if (first) {
    const dims = compareDims(first, bar);
    return p.objective === "speed"
      ? speedLadder(first, all, kind, dims, p)
      : ladderFrom(first, all, dims, p.usage);
  }
  const byCost = candidates(c, { ...p, objective: "cost" }, role, kind);
  const fallback = defaultLadder(c, p, role).rung;
  let start = byCost.find((x) => x.rung === fallback) ?? (byCost[0] as Candidate);
  const dims = compareDims(start, bar);
  for (const easier of DIFFICULTIES.slice(0, DIFFICULTIES.indexOf(difficulty)).reverse()) {
    const s = byCost.find((x) => clearsBar(c, x, kind, easier));
    if (!s) continue;
    if (atLeast(s, start, dims)) start = s;
    break;
  }
  return { ...ladderFrom(start, byCost, dims, p.usage), noClear: noClearLine(all, bar, kind, difficulty) };
}
