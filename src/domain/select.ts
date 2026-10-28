import { type Catalog, capableFor, effortOffered, type RungInfo, rungInfo } from "./catalog.ts";
import { type BillingMode, type Cost, compareCost, costOf, DEFAULT_BILLING } from "./cost.ts";
import { type EffortWord, effortRank, tryParseRung } from "./ids.ts";
import { ROLES, type Role } from "./roles.ts";

/** What routing reads from a profile for one role. */
export interface RoutingProfile {
  billing: Partial<Record<string, BillingMode>>;
  role: { enabled: boolean; rungs: string[]; defaultRung?: string };
  /**
   * the run's dispatches so far per quota (`quotaOf`), the headroom a tie between rungs of equal intelligence
   * is broken on; absent, every quota counts 0 and the candidates' order breaks it
   */
  usage?: Partial<Record<string, number>>;
  /** `<backend>:<model>` → the highest effort routing may start (plan 33); a rung above it is skipped */
  maxEffort?: Readonly<Record<string, string>>;
}

/** What a start check reads of a profile: `ProfileView` and the resolved `Profile` both satisfy it. */
export interface ProfileLike {
  billing: Partial<Record<string, BillingMode>>;
  roles: Partial<Record<Role, { enabled: boolean; rungs: string[]; defaultRung?: string }>>;
  maxEffort?: Readonly<Record<string, string>>;
}

/** Spec 2.0 decision 22: the roles that write code. The worker runs repo_code, terminal and ui lanes and every fix round. */
export const CODING_ROLES: readonly Role[] = ["worker"];
/** A coding role never runs below this effort, whatever the budget. */
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

/** The enabled roles, in `ROLES` order, that the catalog can place no rung for. */
export function rolesWithoutRung(c: Catalog, v: ProfileLike): Role[] {
  return ROLES.filter((role) => {
    const r = v.roles[role];
    return (
      r?.enabled === true &&
      candidates(c, { billing: v.billing, role: r, ...(v.maxEffort ? { maxEffort: v.maxEffort } : {}) }, role)
        .length === 0
    );
  });
}

/** Why a role has no rung: the coding floor, the effort cap, or the index. */
export type NoRungCause = "floor" | "cap" | "index";
export function noRungCause(c: Catalog, v: ProfileLike, role: Role): NoRungCause {
  const r = v.roles[role];
  if (!r) return "index";
  if (r.rungs.length > 0 && !r.rungs.some((rung) => effortAllowed({}, role, rung))) return "floor";
  if (candidates(c, { billing: v.billing, role: r }, role).length > 0) return "cap";
  return "index";
}

/**
 * The role's enabled rungs that the catalog can place: parseable, indexed, offered by their model, listed by
 * the backend when it has a listing, and capable for the role. In cost order (spec §5.3), the profile's ladder
 * order breaking every tie, so equal rungs stay in the order the user wrote.
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
  return out.sort((a, b) => compareCost(a.cost, b.cost) || order.indexOf(a.rung) - order.indexOf(b.rung));
}
