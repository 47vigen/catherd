import {
  type Catalog,
  type Dim,
  capableFor,
  effortOffered,
  ROLE_NEEDS,
  type RungInfo,
  rungInfo,
  scoresOf,
} from "./catalog.ts";
import {
  catalogRungs,
  claudeBilled,
  downgradeDims,
  ladderDropDims,
  quotaOf,
  rankStandIns,
} from "./failover.ts";
import { tryParseRung } from "./ids.ts";
import { DIFFICULTIES, KINDS } from "./lane.ts";
import { type Profile, type ProfileDoc, unknownValues } from "./profile.ts";
import { DEFAULT_ACCESS, ROLES, type Role } from "./roles.ts";
import { candidates, clearsBar, type RoutingProfile } from "./select.ts";

export { quotaOf };

/** One finding of `validate`: where in the profile, what is wrong, and the action that fixes it. */
export interface Issue {
  path: string;
  message: string;
  fix?: string;
}

export interface Validation {
  errors: Issue[];
  warnings: Issue[];
}

const TREAT_LIKE_FIX = (rung: string) =>
  `map it with: catherd catalog treat-like ${rung} <a scored rung>; catalog_query lists them`;
const SUGGEST_FIX = (rung: string) =>
  `confirm or replace it: catherd catalog treat-like --suggest ${rung}, then catherd catalog treat-like ${rung} <a rung>`;

/** Spec 1.2 §6.2: two findings are the same one when they name the same path with the same message. */
const sameIssue = (a: Issue, b: Issue): boolean => a.path === b.path && a.message === b.message;

/**
 * Spec 1.2 §6.2: a save that leaves errors goes through when it removes at least one of the errors the
 * profile had and adds none. `before` is the stored profile's validation, null when it does not exist yet.
 */
export function repairs(before: Validation | null, after: Validation): boolean {
  if (after.errors.length === 0) return true;
  if (!before) return false;
  const added = after.errors.some((e) => !before.errors.some((b) => sameIssue(b, e)));
  const removed = before.errors.some((b) => !after.errors.some((e) => sameIssue(b, e)));
  return removed && !added;
}

/** Spec 1.2 §6.1 "stand-in to confirm": a rung whose values on some bar dimensions are an inferred stand-in's. */
export interface StandInToConfirm {
  canonical: string;
  /** the profile's rungs that run it, and where the first one is */
  rungs: string[];
  path: string;
  dims: { dim: Dim; like: string }[];
}

/**
 * Spec 1.2 §6.1: the profile's rungs that lean on an inferred stand-in, one entry per canonical rung. Only
 * where bars choose: rungs of a role with more than one usable rung, and failover stand-ins; a role with one
 * rung runs it whatever the bars say (plan 14 Ruling 13).
 */
export function standInsToConfirm(p: Profile, c: Catalog, backends: readonly string[]): StandInToConfirm[] {
  const seen = new Map<string, StandInToConfirm>();
  const add = (rung: string, path: string) => {
    const r = tryParseRung(rung);
    if (!r || !backends.includes(r.backend)) return;
    const info = rungInfo(c, rung);
    const s = scoresOf(c, info.canonical);
    if (!s || s.inferred.length === 0) return;
    const had = seen.get(info.canonical);
    if (had) {
      if (!had.rungs.includes(rung)) had.rungs.push(rung);
      return;
    }
    const dims = s.inferred.map((dim) => ({ dim, like: s.standIns[dim] as string }));
    seen.set(info.canonical, { canonical: info.canonical, rungs: [rung], path, dims });
  };
  for (const role of ROLES) {
    const rc = p.roles[role];
    if (!rc.enabled || candidates(c, routingProfileOf(p, role), role).length < 2) continue;
    for (const rung of rc.rungs) add(rung, `roles.${role}.rungs`);
  }
  for (const [from, to] of Object.entries(p.failover)) add(to, `failover.${from}`);
  return [...seen.values()];
}

/** One "stand-in to confirm" warning's words. */
export function standInMessage(x: StandInToConfirm): string {
  const words = (xs: string[]) =>
    xs.length < 3 ? xs.join(" or ") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`;
  const lent = x.dims.map((d) => `${d.like}'s ${d.dim}`).join(", ");
  const also = x.rungs.length > 1 ? ` (${x.rungs.join(", ")})` : "";
  return `stand-in to confirm: ${x.canonical}${also} has no ${words(x.dims.map((d) => d.dim))} value of its own; routing uses ${lent} (inferred)`;
}

export const routingProfileOf = (p: Profile, role: Role): RoutingProfile => ({
  objective: p.objective,
  billing: p.billing,
  role: p.roles[role],
});

/**
 * Whether a rung's scores are catherd's guess: borrowed through a treat-like, filled by an inferred stand-in
 * (spec 1.2 §6.1), or only `inferred` ones. `note` says what a treat-like lends: "scores borrowed from X"
 * when the rung has no value of its own, else the dimensions it borrows (a rung a sync scored on some).
 */
export function inferredScores(
  c: Catalog,
  info: RungInfo,
): { inferred: boolean; via: string | null; note: string | null } {
  const s = scoresOf(c, info.canonical);
  if (!s) return { inferred: false, via: null, note: null };
  const records = Object.values(s.records);
  const guessed =
    s.via !== null || s.inferred.length > 0 || records.every((r) => r.confidence === "inferred");
  const all = s.borrowed.length + s.inferred.length === records.length;
  const note = s.via ? `${all ? "scores" : s.borrowed.join(", ")} borrowed from ${s.via}` : null;
  return { inferred: guessed, via: s.via, note };
}

/**
 * Spec §7.1. Errors: the worker disabled; an enabled role with no usable rung; a failover stand-in on the
 * same quota; a rung whose backend catherd cannot run (`backends` lists those it can, `claude` included).
 * Everything else worth knowing is a warning: an access mode other than the role's default, an effort or
 * model the last listing does not offer, a stand-in that never runs, (spec 1.1 §11) a stand-in that
 * downgrades its rung, one that spends Claude quota while another plan could stand in, and a ladder that goes
 * down, and (spec 1.2 §6.1) an unscored rung or stand-in, never an error: a rung that leans on an inferred
 * stand-in is a "stand-in to confirm", and one with no value and no stand-in is skipped by routing. With the
 * stored `doc` `p` came from, a value this catherd does not know is also a warning, one that says how the
 * value is read.
 */
export function validateProfile(
  p: Profile,
  c: Catalog,
  backends: readonly string[],
  doc?: ProfileDoc,
): Validation {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  for (const u of doc ? unknownValues(doc) : [])
    warnings.push({
      path: u.path,
      message: `"${u.value}" is not a value this catherd knows (a newer one wrote it?); it is read as ${u.readAs}`,
      fix: "upgrade catherd (bun add -g catherd-cli@latest), or set a value this version knows",
    });
  if (!p.roles.worker.enabled)
    errors.push({
      path: "roles.worker.enabled",
      message: "the worker cannot be disabled",
      fix: "catherd profile set roles.worker.enabled true",
    });

  for (const role of ROLES) {
    const rc = p.roles[role];
    const at = `roles.${role}`;
    if (rc.access !== DEFAULT_ACCESS[role])
      warnings.push({
        path: `${at}.access`,
        message: `${role} runs ${rc.access}; catherd's default for it is ${DEFAULT_ACCESS[role]}`,
      });
    if (!rc.enabled) continue;
    for (const rung of rc.rungs) {
      const r = tryParseRung(rung);
      if (!r) {
        errors.push({
          path: `${at}.rungs`,
          message: `"${rung}" is not a rung`,
          fix: "write it as <backend>:<model>#<effort>",
        });
        continue;
      }
      if (!backends.includes(r.backend)) {
        errors.push({
          path: `${at}.rungs`,
          message: `${rung}: catherd cannot run ${r.backend} yet`,
          fix: `use a rung on ${backends.join(", ")}`,
        });
        continue;
      }
      const info = rungInfo(c, rung);
      if (!capableFor(c, info, role))
        errors.push({
          path: `${at}.rungs`,
          message: `${rung} cannot fill the ${role} role (it needs ${Object.keys(ROLE_NEEDS[role]).join(" + ")})`,
          fix: `catalog_query({ role: "${role}" }) lists the models that can`,
        });
      if (info.efforts.length > 0 && !effortOffered(info))
        errors.push({
          path: `${at}.rungs`,
          message: `${r.model} has no effort "${r.effort}" on ${r.backend} (it has ${info.efforts.join(", ")})`,
        });
      else if (info.efforts.length === 0 && r.effort !== "default")
        warnings.push({
          path: `${at}.rungs`,
          message: `${rung}: catherd cannot check its effort until ${r.backend} lists its models`,
          fix: "catherd catalog refresh",
        });
      if (info.listed === false)
        warnings.push({
          path: `${at}.rungs`,
          message: `${r.backend}'s last listing does not offer ${r.model}; routing skips it`,
        });
      if (!scoresOf(c, info.canonical))
        warnings.push({
          path: `${at}.rungs`,
          message: `${rung} is unscored and no rung is near enough to stand in for it: routing skips it`,
          fix: TREAT_LIKE_FIX(rung),
        });
    }
    rc.rungs.forEach((rung, i) => {
      const prev = rc.rungs[i - 1];
      const down = prev === undefined ? [] : ladderDropDims(c, prev, rung);
      if (down.length)
        warnings.push({
          path: `${at}.rungs`,
          message: `the ladder goes down at ${rung}: it scores below ${prev} on ${down.join(", ")}`,
          fix: `order ${at}.rungs weakest first`,
        });
    });
    if (rc.defaultRung !== undefined && !rc.rungs.includes(rc.defaultRung))
      errors.push({
        path: `${at}.defaultRung`,
        message: `${rc.defaultRung} is not one of the ${role}'s rungs`,
        fix: `catherd profile set ${at}.defaultRung null, or add it to ${at}.rungs`,
      });
    const usable = candidates(c, routingProfileOf(p, role), role);
    if (usable.length === 0)
      errors.push({
        path: `${at}.rungs`,
        message: `the ${role} role has no usable rung`,
        fix: `enable a scored rung its backend offers, or turn the role off with: catherd profile set ${at}.enabled false`,
      });
    if (usable.length > 1)
      // Claude rungs have no honesty score, so they clear no shipped bar: select() starts on one only as the
      // default rung (when nothing clears) and never climbs onto it
      for (const x of usable)
        if (
          quotaOf(x.info.parsed) === "claude-code" &&
          !KINDS.some((k) => DIFFICULTIES.some((d) => clearsBar(c, x, k, d)))
        )
          warnings.push({
            path: `${at}.rungs`,
            message: `${x.rung} clears no routing bar, so a lane starts on it only as the role's default rung and never climbs onto it`,
          });
    // spec 1.2 §5.2: the logic and hard bars sit at the 60th and 75th percentiles, which a cost-minded ladder
    // may never reach, and those lanes start at the default rung and climb; only a kind whose every bar the
    // ladder misses routes blind (plan 14 Ruling 12)
    if (role === "worker" && usable.length > 1) {
      const blind = KINDS.filter((k) => !DIFFICULTIES.some((d) => usable.some((x) => clearsBar(c, x, k, d))));
      if (blind.length)
        warnings.push({
          path: `${at}.rungs`,
          message: `no worker rung clears any bar for ${blind.join(", ")}; those lanes always start at the default rung`,
        });
    }
  }

  const ladders = new Set(ROLES.filter((r) => p.roles[r].enabled).flatMap((r) => p.roles[r].rungs));
  // the stand-ins catherd could run here, for the fixes below
  const pool = catalogRungs(c).filter((x) => {
    const r = tryParseRung(x);
    return r !== null && backends.includes(r.backend);
  });
  for (const [from, to] of Object.entries(p.failover)) {
    const at = `failover.${from}`;
    const a = tryParseRung(from);
    const b = tryParseRung(to);
    if (!a || !b) {
      errors.push({
        path: at,
        message: `"${!a ? from : to}" is not a rung`,
        fix: "write it as <backend>:<model>#<effort>",
      });
      continue;
    }
    if (!backends.includes(b.backend)) {
      errors.push({ path: at, message: `stand-in ${to}: catherd cannot run ${b.backend} yet` });
      continue;
    }
    if (!scoresOf(c, rungInfo(c, to).canonical))
      warnings.push({
        path: at,
        message: `stand-in ${to} is unscored and no rung is near enough to stand in for it`,
        fix: TREAT_LIKE_FIX(to),
      });
    if (quotaOf(a) === quotaOf(b))
      errors.push({
        path: at,
        message: `stand-in ${to} draws on the same quota as ${from}, which is out when ${from} hits its limit`,
        fix: "name a stand-in on another backend or plan",
      });
    const ranked = rankStandIns(c, p.billing, from, pool);
    const down = downgradeDims(c, from, to);
    if (down.length)
      warnings.push({
        path: at,
        message: `downgrade: ${to} stands in for ${from}, scoring below it on ${down.join(", ")}`,
        fix: `catherd profile set failover.${from} ${ranked[0] ?? "null"}`,
      });
    const other = ranked.find((x) => !claudeBilled(x));
    if (claudeBilled(to) && other)
      warnings.push({
        path: at,
        message: `stand-in ${to} spends Claude quota, while ${other} could stand in on another plan`,
        fix: `catherd profile set failover.${from} ${other}`,
      });
    if (b.backend === "claude")
      warnings.push({
        path: at,
        message: `stand-in ${to} is a native subagent: the orchestrator must start it, dispatch cannot`,
      });
    if (!ladders.has(from))
      warnings.push({ path: at, message: `${from} is on no enabled role's ladder, so this never runs` });
  }
  for (const x of standInsToConfirm(p, c, backends))
    warnings.push({ path: x.path, message: standInMessage(x), fix: SUGGEST_FIX(x.rungs[0] as string) });
  return { errors, warnings };
}
