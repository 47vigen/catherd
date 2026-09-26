import {
  billingKeyOf,
  type Catalog,
  capableFor,
  effortOffered,
  ROLE_NEEDS,
  type RungInfo,
  rungInfo,
  scoresOf,
} from "./catalog.ts";
import { parseRung, type Rung } from "./ids.ts";
import { DIFFICULTIES, KINDS } from "./lane.ts";
import type { Profile } from "./profile.ts";
import { DEFAULT_ACCESS, ROLES, type Role } from "./roles.ts";
import { candidates, clearsBar, type RoutingProfile } from "./select.ts";

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

export const routingProfileOf = (p: Profile, role: Role): RoutingProfile => ({
  objective: p.objective,
  billing: p.billing,
  role: p.roles[role],
});

/**
 * Spec §7.1 and §4.5: a stand-in on the same quota would be out of quota too. The billing key names the
 * quota, except that the native `claude` path and headless `claude-code` both draw on the Claude plan.
 */
export const quotaOf = (r: Rung): string => (billingKeyOf(r) === "claude" ? "claude-code" : billingKeyOf(r));

function parsed(rung: string): Rung | null {
  try {
    return parseRung(rung);
  } catch {
    return null;
  }
}

/** Whether a rung's scores are catherd's guess: borrowed through a treat-like, or only `inferred` ones. */
export function inferredScores(c: Catalog, info: RungInfo): { inferred: boolean; via: string | null } {
  const s = scoresOf(c, info.canonical);
  if (!s) return { inferred: false, via: null };
  const records = Object.values(s.records);
  return { inferred: s.via !== null || records.every((r) => r.confidence === "inferred"), via: s.via };
}

/**
 * Spec §7.1. Errors: the worker disabled; an enabled role with no usable rung; an unscored rung without a
 * treat-like; a failover stand-in unscored or on the same quota; a rung whose backend catherd cannot run
 * (`backends` lists those it can, `claude` included). Everything else worth knowing is a warning: an access
 * mode other than the role's default, an effort or model the last listing does not offer, a stand-in
 * that never runs.
 */
export function validateProfile(p: Profile, c: Catalog, backends: readonly string[]): Validation {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
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
      const r = parsed(rung);
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
        errors.push({ path: `${at}.rungs`, message: `${rung} is unscored`, fix: TREAT_LIKE_FIX(rung) });
    }
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
    if (role === "worker" && usable.length > 1) {
      const missed = KINDS.flatMap((k) =>
        DIFFICULTIES.filter((d) => !usable.some((x) => clearsBar(c, x, k, d))).map((d) => `${k}/${d}`),
      );
      if (missed.length)
        warnings.push({
          path: `${at}.rungs`,
          message: `no worker rung clears the bar for ${missed.join(", ")}; those lanes start at the default rung`,
        });
    }
  }

  const ladders = new Set(ROLES.filter((r) => p.roles[r].enabled).flatMap((r) => p.roles[r].rungs));
  for (const [from, to] of Object.entries(p.failover)) {
    const at = `failover.${from}`;
    const a = parsed(from);
    const b = parsed(to);
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
      errors.push({ path: at, message: `stand-in ${to} is unscored`, fix: TREAT_LIKE_FIX(to) });
    if (quotaOf(a) === quotaOf(b))
      errors.push({
        path: at,
        message: `stand-in ${to} draws on the same quota as ${from}, which is out when ${from} hits its limit`,
        fix: "name a stand-in on another backend or plan",
      });
    if (b.backend === "claude")
      warnings.push({
        path: at,
        message: `stand-in ${to} is a native subagent: the orchestrator must start it, dispatch cannot`,
      });
    if (!ladders.has(from))
      warnings.push({ path: at, message: `${from} is on no enabled role's ladder, so this never runs` });
  }
  return { errors, warnings };
}
