import {
  type Catalog,
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

export const routingProfileOf = (p: Profile, role: Role): RoutingProfile => ({
  objective: p.objective,
  billing: p.billing,
  role: p.roles[role],
});

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
 * that never runs, and (spec 1.1 §11) a stand-in that downgrades its rung, one that spends Claude quota
 * while another plan could stand in, and a ladder that goes down. With the stored `doc` `p` came from, a value this catherd does not know is also a
 * warning, one that says how the value is read.
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
        errors.push({ path: `${at}.rungs`, message: `${rung} is unscored`, fix: TREAT_LIKE_FIX(rung) });
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
      errors.push({ path: at, message: `stand-in ${to} is unscored`, fix: TREAT_LIKE_FIX(to) });
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
  return { errors, warnings };
}
