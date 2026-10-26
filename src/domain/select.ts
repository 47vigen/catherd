import { type Bars, barOf, percentilesOf } from "./bars.ts";
import { type Catalog, capableFor, effortOffered, type RungInfo, rungInfo } from "./catalog.ts";
import { type BillingMode, type Cost, compareCost, costOf, DEFAULT_BILLING } from "./cost.ts";
import { CatherdError } from "./errors.ts";
import { quotaOf } from "./failover.ts";
import { type EffortWord, effortRank, tryParseRung } from "./ids.ts";
import { DIFFICULTIES, type Difficulty } from "./lane.ts";
import { ROLES, type Role } from "./roles.ts";

/** What routing reads from a profile for one role. */
export interface RoutingProfile {
  objective: "cost" | "speed";
  billing: Partial<Record<string, BillingMode>>;
  role: { enabled: boolean; rungs: string[]; defaultRung?: string };
  /**
   * spec 1.5 plan 24: the run's dispatches so far per quota (`quotaOf`), the headroom a tie between rungs of
   * equal intelligence is broken on; absent, every quota counts 0 and the candidates' order breaks it
   */
  usage?: Partial<Record<string, number>>;
  /** `<backend>:<model>` → the highest effort routing may start (plan 33); a rung above it is skipped */
  maxEffort?: Readonly<Record<string, string>>;
  /** this role's bar percentiles over the profile's, laid over the shipped ones (`percentilesOf`) */
  bars?: Bars;
}

/** What a start check reads of a profile: `ProfileView` and the resolved `Profile` both satisfy it. */
export interface ProfileLike {
  objective: "cost" | "speed";
  billing: Partial<Record<string, BillingMode>>;
  roles: Partial<Record<Role, { enabled: boolean; rungs: string[]; defaultRung?: string }>>;
  maxEffort?: Readonly<Record<string, string>>;
}

/** Spec 2.0 decision 22: the roles that write code. The worker runs repo_code, terminal and ui lanes and every fix round. */
export const CODING_ROLES: readonly Role[] = ["worker"];
/** A coding role never runs below this effort, whatever the objective or the budget. */
export const CODING_FLOOR: EffortWord = "medium";

/**
 * False for a rung above its model's `maxEffort`, or below `CODING_FLOOR` for a coding role. A rung that does not
 * parse, one whose effort is no effort word (`default`), and a ceiling that is no effort word all allow it.
 */
export function effortAllowed(
  maxEffort: Readonly<Record<string, string>>,
  role: Role,
  rung: string,
): boolean {
  const r = tryParseRung(rung);
  const rank = r ? effortRank(r.effort) : -1;
  if (!r || rank < 0) return true;
  if (CODING_ROLES.includes(role) && rank < effortRank(CODING_FLOOR)) return false;
  const cap = effortRank(maxEffort[`${r.backend}:${r.model}`] ?? "");
  return cap < 0 || rank <= cap;
}

export interface Candidate {
  rung: string;
  info: RungInfo;
  intelligence: number;
  cost: Cost;
  /** the pair's tokens per second; null when Slopalytics has none */
  speed: number | null;
}

export interface Pick {
  rung: string;
  ladder: string[];
  /** no rung clears the difficulty's bar (`no rung clears hard (bar 47.1); best is …`) */
  noClear?: string;
  /** spec 1.5 plan 24: rungs of equal intelligence competed for the start, and how the tie was broken */
  tie?: string;
}

/** The enabled roles, in `ROLES` order, that the catalog can place no rung for. */
export function rolesWithoutRung(c: Catalog, v: ProfileLike): Role[] {
  return ROLES.filter((role) => {
    const r = v.roles[role];
    return (
      r?.enabled === true &&
      candidates(
        c,
        {
          objective: v.objective,
          billing: v.billing,
          role: r,
          ...(v.maxEffort ? { maxEffort: v.maxEffort } : {}),
        },
        role,
      ).length === 0
    );
  });
}

/** Why a role has no rung: the coding floor, the effort cap, or the index. */
export type NoRungCause = "floor" | "cap" | "index";
export function noRungCause(c: Catalog, v: ProfileLike, role: Role): NoRungCause {
  const r = v.roles[role];
  if (!r) return "index";
  if (r.rungs.length > 0 && !r.rungs.some((rung) => effortAllowed({}, role, rung))) return "floor";
  if (candidates(c, { objective: v.objective, billing: v.billing, role: r }, role).length > 0) return "cap";
  return "index";
}

const byNull = (a: number | null, b: number | null) =>
  a === null || b === null ? (a === null ? 1 : 0) - (b === null ? 1 : 0) : a - b;

/**
 * The role's enabled rungs that the catalog can place: parseable, indexed, offered by their model, listed by
 * the backend when it has a listing, and capable for the role. Ordered by cost (spec §5.3), or by speed with
 * cost breaking ties; the profile's ladder order breaks every remaining tie (spec 1.5 plan 24), so equal rungs
 * start in the order the user wrote.
 */
export function candidates(c: Catalog, p: RoutingProfile, role: Role): Candidate[] {
  if (!p.role.enabled) return [];
  const out: Candidate[] = [];
  const order = [...new Set(p.role.rungs)];
  for (const rung of order) {
    if (!effortAllowed(p.maxEffort ?? {}, role, rung)) continue;
    let info: RungInfo;
    try {
      info = rungInfo(c, rung);
    } catch {
      continue;
    }
    if (!info.pair || !effortOffered(info) || info.listed === false || !capableFor(c, info, role)) continue;
    const mode = p.billing[info.key] ?? DEFAULT_BILLING[info.key];
    out.push({
      rung,
      info,
      intelligence: info.pair.intelligence,
      cost: costOf(info.family, info.pair, info.parsed.effort, mode),
      speed: info.pair.speed,
    });
  }
  const written = (a: Candidate, b: Candidate) => order.indexOf(a.rung) - order.indexOf(b.rung);
  const cost = (a: Candidate, b: Candidate) => compareCost(a.cost, b.cost) || written(a, b);
  // fastest first, a pair with no speed last
  const speed = (a: Candidate, b: Candidate) =>
    byNull(a.speed === null ? null : -a.speed, b.speed === null ? null : -b.speed) ||
    compareCost(a.cost, b.cost) ||
    written(a, b);
  return out.sort(p.objective === "speed" ? speed : cost);
}

/** Plan 44: the candidates in cost order whatever the objective; the decision model, not the order, picks. */
export const decisionCandidates = (c: Catalog, p: RoutingProfile, role: Role): Candidate[] =>
  candidates(c, { ...p, objective: "cost" }, role);

/**
 * Plan 44 D20: of `rungs` (one level, in cost order), the one on the quota with the fewest dispatches in the run;
 * the order breaks an equal count. `why` is null when there was nothing to choose.
 */
export function tieBreak(
  rungs: readonly string[],
  usage: Partial<Record<string, number>>,
): { rung: string; why: string | null } {
  const quotas = rungs.map((x) => {
    const r = tryParseRung(x);
    return r ? quotaOf(r) : "";
  });
  const used = (i: number) => usage[quotas[i] as string] ?? 0;
  const at = rungs.map((_, i) => i).sort((a, b) => used(a) - used(b))[0] ?? 0;
  const rung = rungs[at] as string;
  if (rungs.length < 2) return { rung, why: null };
  const counts = [...new Set(quotas)].map((q) => `${q} ${usage[q] ?? 0}`).join(", ");
  return { rung, why: `${rung} has the most headroom (dispatches in this run: ${counts})` };
}

export const clearsBar = (cand: Candidate, bar: number): boolean => cand.intelligence >= bar;

function noRung(role: Role): CatherdError {
  return new CatherdError("E_CONFIG_INVALID", `role "${role}" has no enabled, capable, indexed rung`, {
    fix: `pick indexed pairs: catherd catalog list --role ${role}`,
  });
}

/** Spec 1.5 plan 24: how many of `rungs` (a run's dispatched rungs) drew on each quota. */
export function quotaUsage(rungs: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const rung of rungs) {
    const r = tryParseRung(rung);
    if (r) out[quotaOf(r)] = (out[quotaOf(r)] ?? 0) + 1;
  }
  return out;
}

/** Equal intelligence: a tie for the start. */
const same = (a: Candidate, b: Candidate): boolean => a.intelligence === b.intelligence;

const quota = (x: Candidate): string => quotaOf(x.info.parsed);

/**
 * Spec 1.5 plan 24: when rungs on other quotas are exactly as intelligent as `start`, the start goes to the
 * quota with the most headroom (the fewest of the run's dispatches so far), the candidates' order (cost, then
 * the profile's ladder order) breaking an equal count. `tie` says what decided. Rungs of one quota that tie
 * are no tie (cost already orders them), nor is a rung of another cost tier.
 */
function breakTie(
  start: Candidate,
  order: Candidate[],
  usage: Partial<Record<string, number>>,
): { start: Candidate; tie?: string } {
  // a metered rung never wins a tie over a plan's: headroom is free only within the start's cost tier
  const rivals = order.filter(
    (x) => x !== start && quota(x) !== quota(start) && x.cost.tier === start.cost.tier && same(x, start),
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
    tie: `tie on intelligence with ${others.join(", ")}: started on ${pick.rung}; ${why}`,
  };
}

/**
 * Spec 1.5 plan 24, "climb ladders only go up": the start (after a tie on equal intelligence goes to the quota
 * with the most headroom), then, in `order`'s order, every other candidate at least as intelligent as the last
 * rung kept. A stronger rung is on the ladder wherever cost puts it, and one weaker than the rung before it
 * never is, so a climb never lands on a rung below the one it leaves.
 */
function ladderFrom(first: Candidate, order: Candidate[], usage: Partial<Record<string, number>> = {}): Pick {
  const { start, tie } = breakTie(first, order, usage);
  const kept = [start];
  for (const x of order)
    if (x !== start && x.intelligence >= (kept.at(-1) as Candidate).intelligence) kept.push(x);
  return { rung: start.rung, ladder: kept.map((x) => x.rung), ...(tie ? { tie } : {}) };
}

/**
 * The role's default rung and every candidate at least as intelligent (the whole list when it has no default),
 * in cost order under either objective: speed order would put faster, not stronger, rungs above the default.
 */
export function defaultLadder(c: Catalog, p: RoutingProfile, role: Role): Pick {
  const all = candidates(c, { ...p, objective: "cost" }, role);
  if (all.length === 0) throw noRung(role);
  const start = all.find((x) => x.rung === p.role.defaultRung) ?? (all[0] as Candidate);
  return ladderFrom(start, all, p.usage);
}

/** The cost-ordered candidates; throws when the role has none. */
function byCostOf(c: Catalog, p: RoutingProfile, role: Role): Candidate[] {
  const all = candidates(c, { ...p, objective: "cost" }, role);
  if (all.length === 0) throw noRung(role);
  return all;
}

/** The ladder that starts at `rung` (a candidate), in cost order, only going up. */
export function startAt(c: Catalog, p: RoutingProfile, role: Role, rung: string): Pick {
  const all = byCostOf(c, p, role);
  const start = all.find((x) => x.rung === rung);
  if (!start) throw noRung(role);
  return ladderFrom(start, all, p.usage);
}

/** The cheapest candidate in cost order, and the ladder up from it. */
export function cheapest(c: Catalog, p: RoutingProfile, role: Role): Pick {
  const all = byCostOf(c, p, role);
  return ladderFrom(all[0] as Candidate, all, p.usage);
}

/**
 * The role's default difficulty: the hardest difficulty whose bar the role's default rung clears (`build` when
 * it clears none, or is no candidate: never `copy`, whose start is the cheapest rung). A route sure of the
 * lane but not its difficulty starts there.
 */
export function defaultDifficulty(c: Catalog, p: RoutingProfile, role: Role): Difficulty {
  const start = defaultLadder(c, p, role).rung;
  const cand = candidates(c, p, role).find((x) => x.rung === start);
  const at = percentilesOf(p);
  const cleared = cand ? DIFFICULTIES.filter((d) => clearsBar(cand, barOf(c, d, at))) : [];
  return cleared.at(-1) ?? "build";
}

/**
 * Under `objective: "speed"` the objective picks only the start (the fastest rung that clears the bar); the
 * ladder above it is the other rungs at least as intelligent, least intelligent first, cost breaking ties, so a
 * lane never climbs onto a weaker rung.
 */
function speedLadder(start: Candidate, all: Candidate[], p: RoutingProfile): Pick {
  const order = [...all].sort((a, b) => a.intelligence - b.intelligence || compareCost(a.cost, b.cost));
  return ladderFrom(start, order, p.usage);
}

/**
 * Spec 1.5 plan 24: when no rung clears a bar, the most intelligent one (the candidates' order breaking a tie).
 */
const bestOf = (all: Candidate[]): Candidate =>
  [...all].sort((a, b) => b.intelligence - a.intelligence)[0] as Candidate;

/** `no rung clears hard (bar 47.1); best is codex:gpt-6-sol#xhigh (44.2)`, and where a raised start came from. */
export function noClearLine(all: Candidate[], bar: number, d: Difficulty, raisedFrom?: Difficulty): string {
  const best = bestOf(all);
  return `no rung clears ${d} (bar ${bar.toFixed(1)}); best is ${best.rung} (${best.intelligence.toFixed(1)})${raisedFrom ? `; started at ${raisedFrom}'s start` : ""}`;
}

/**
 * Spec §5.4: the start rung and ladder for a lane of this difficulty. The start is the first rung in objective
 * order that clears the bar (under speed the fastest one with a speed, else the cheapest). When none does, it is
 * the default rung, raised to an easier difficulty's start when that one is at least as intelligent (spec 1.5
 * plan 24: `logic` starts no lower than `build`), and `noClear` says so. The ladder above the start only goes up.
 */
export function select(c: Catalog, p: RoutingProfile, role: Role, difficulty: Difficulty): Pick {
  const all = candidates(c, p, role);
  if (all.length === 0) throw noRung(role);
  const at = percentilesOf(p);
  const bar = barOf(c, difficulty, at);
  if (all.length === 1) {
    const only = all[0] as Candidate;
    const one = { rung: only.rung, ladder: [only.rung] };
    return clearsBar(only, bar) ? one : { ...one, noClear: noClearLine(all, bar, difficulty) };
  }
  const byCost = p.objective === "speed" ? candidates(c, { ...p, objective: "cost" }, role) : all;
  if (p.objective === "speed") {
    // the fastest clearing pair that has a speed, else the cheapest clearing one
    const rung = (
      all.find((x) => x.speed !== null && clearsBar(x, bar)) ?? byCost.find((x) => clearsBar(x, bar))
    )?.rung;
    const first = all.find((x) => x.rung === rung);
    if (first) return speedLadder(first, all, p);
  } else {
    const first = all.find((x) => clearsBar(x, bar));
    if (first) return ladderFrom(first, all, p.usage);
  }
  const fallback = defaultLadder(c, p, role).rung;
  const base = byCost.find((x) => x.rung === fallback) ?? (byCost[0] as Candidate);
  let start = base;
  let raisedFrom: Difficulty | undefined;
  for (const easier of DIFFICULTIES.slice(0, DIFFICULTIES.indexOf(difficulty)).reverse()) {
    const s = byCost.find((x) => clearsBar(x, barOf(c, easier, at)));
    if (!s) continue;
    if (s.intelligence >= start.intelligence) {
      start = s;
      if (s !== base) raisedFrom = easier;
    }
    break;
  }
  return {
    ...ladderFrom(start, byCost, p.usage),
    noClear: noClearLine(all, bar, difficulty, raisedFrom),
  };
}
