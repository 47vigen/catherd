import type { OrchestrationHost } from "./host.ts";
import { type Catalog, capableFor, effortOffered, ROLE_NEEDS, rungInfo } from "./catalog.ts";
import {
  catalogPairs,
  claudeBilled,
  downgrade,
  intelligenceOf,
  ladderDrop,
  quotaOf,
  rankStandIns,
} from "./failover.ts";
import { effortRank, tryParseRung } from "./ids.ts";
import { DECISION_UNSET_FIX, type Profile, type ProfileDoc, unknownValues } from "./profile.ts";
import { DEFAULT_ACCESS, ROLES, type Role } from "./roles.ts";
import { candidates, CODING_FLOOR, CODING_ROLES, type RoutingProfile } from "./select.ts";

export { quotaOf };

/**
 * `unindexed: "warning"` (doctor's) reads a rung with no Slopalytics index as a warning, since a profile can
 * lose a pair overnight; everywhere else it is an error.
 */
export interface ValidateOptions {
  unindexed?: "error" | "warning";
}

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

const SYNC_FIX = "catherd catalog sync";
/** No indexed pair at all (not fetched, corrupt or empty), whatever fetchedAt says. */
const noIndex = (c: Catalog): boolean => Object.keys(c.index).length === 0;
const unindexedMessage = (rung: string) => `${rung} has no Slopalytics intelligence index: routing skips it`;

/** Spec 1.2 §6.2: two findings are the same one when they name the same path with the same message. */
const sameIssue = (a: Issue, b: Issue): boolean => a.path === b.path && a.message === b.message;

/** The errors of `after` that `before` (null: no stored profile) did not have. */
export const addedErrors = (before: Validation | null, after: Validation): Issue[] =>
  after.errors.filter((e) => !before?.errors.some((b) => sameIssue(b, e)));

/**
 * Spec 1.2 §6.2: a save that leaves errors goes through when it removes at least one of the errors the
 * profile had and adds none. `before` is the stored profile's validation, null when it does not exist yet.
 */
export function repairs(before: Validation | null, after: Validation): boolean {
  if (after.errors.length === 0) return true;
  if (!before) return false;
  const added = addedErrors(before, after).length > 0;
  const removed = before.errors.some((b) => !after.errors.some((e) => sameIssue(b, e)));
  return removed && !added;
}

export const routingProfileOf = (p: Profile, role: Role): RoutingProfile => ({
  billing: p.billing,
  role: p.roles[role],
  maxEffort: p.maxEffort,
});

/**
 * Spec §7.1. Errors: the worker disabled; an enabled role with no usable rung; a failover stand-in on the
 * same quota; a rung whose backend catherd cannot run (`backends` lists those it can, `claude` included).
 * Everything else worth knowing is a warning: an access mode other than the role's default, an effort or
 * model the last listing does not offer, a stand-in that never runs, (spec 1.1 §11) a stand-in that
 * downgrades its rung, one that spends Claude quota while another plan could stand in, and a ladder that goes
 * down. A rung or stand-in with no Slopalytics index is an error (spec 2.0 decision 12; a warning with
 * `o.unindexed: "warning"`): routing skips it. With the stored `doc` `p` came from, a value this catherd does
 * not know is also a warning, one that says how the value is read.
 */
export function validateProfile(
  p: Profile,
  c: Catalog,
  backends: readonly string[],
  doc?: ProfileDoc,
  host: OrchestrationHost = "unknown",
  o: ValidateOptions = {},
): Validation {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  for (const u of doc ? unknownValues(doc) : [])
    warnings.push({
      path: u.path,
      message: `"${u.value}" is not a value this catherd knows (a newer one wrote it?); it is read as ${u.readAs}`,
      fix: "upgrade catherd (bun add -g catherd-cli@latest), or set a value this version knows",
    });
  if (!p.decision.url || !p.decision.model)
    warnings.push({
      path: "decision",
      message: "the decision model is not set",
      fix: DECISION_UNSET_FIX,
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
    // spec §5: network: false takes a workspace-write role's network grants; read-only and full have none to take
    if (rc.network === false && rc.access !== "workspace-write")
      warnings.push({
        path: `${at}.network`,
        message: `network: false does nothing here: it applies to workspace-write roles, and ${role} runs ${rc.access}`,
        fix: `catherd profile set ${at}.network null`,
      });
    let unindexed = 0;
    for (const rung of rc.rungs) {
      const native = nativeClaudeIssue(rung, host, `${at}.rungs`);
      if (native) errors.push(native);
      const r = tryParseRung(rung);
      if (!r) {
        errors.push({
          path: `${at}.rungs`,
          message: `"${rung}" is not a rung`,
          fix: "write it as <backend>:<model>#<effort>",
        });
        continue;
      }
      const above = aboveCeiling(p.maxEffort, rung, `${at}.rungs`);
      if (above) warnings.push(above);
      if (
        CODING_ROLES.includes(role) &&
        effortRank(r.effort) >= 0 &&
        effortRank(r.effort) < effortRank(CODING_FLOOR)
      )
        warnings.push({
          path: `${at}.rungs`,
          message: `${rung} is below ${CODING_FLOOR} effort: a coding worker never runs it`,
          fix: `pick #${CODING_FLOOR} or above: catherd catalog list --role ${role}`,
        });
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
      if (info.listed === true && !effortOffered(info))
        errors.push({
          path: `${at}.rungs`,
          message: `${r.model} has no effort "${r.effort}" on ${r.backend} (it has ${info.efforts.join(", ")})`,
        });
      else if (!info.pair) {
        unindexed++;
        (o.unindexed === "warning" ? warnings : errors).push({
          path: `${at}.rungs`,
          message: unindexedMessage(rung),
          fix: noIndex(c) ? SYNC_FIX : `pick an indexed pair: catherd catalog list --role ${role}`,
        });
      }
      if (info.listed === false)
        warnings.push({
          path: `${at}.rungs`,
          message: `${r.backend}'s last listing does not offer ${r.model}; routing skips it`,
        });
    }
    rc.rungs.forEach((rung, i) => {
      const prev = rc.rungs[i - 1];
      if (prev !== undefined && ladderDrop(c, prev, rung))
        warnings.push({
          path: `${at}.rungs`,
          message: `the ladder goes down at ${rung}: intelligence ${(intelligenceOf(c, rung) as number).toFixed(1)} below ${prev}'s ${(intelligenceOf(c, prev) as number).toFixed(1)}`,
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
      // doctor's mode: rungs that are only unindexed are the same warning, so the role's total is one too, but
      // only when an index exists: with none (not fetched, corrupt, empty) nothing can route, which is an error
      (o.unindexed === "warning" && !noIndex(c) && unindexed > 0 && unindexed === rc.rungs.length
        ? warnings
        : errors
      ).push({
        path: `${at}.rungs`,
        message: `the ${role} role has no usable rung`,
        fix: `enable an indexed rung its backend offers, or turn the role off with: catherd profile set ${at}.enabled false`,
      });
  }

  const ladders = new Set(ROLES.filter((r) => p.roles[r].enabled).flatMap((r) => p.roles[r].rungs));
  // the stand-ins the fixes below may suggest: on a backend catherd runs and the profile already names (a
  // ladder or a failover entry), never one this machine may not have (Cursor on a machine without it); a
  // native claude: rung names claude-code too, the same Claude Code CLI
  const named = new Set(
    [...ladders, ...Object.keys(p.failover), ...Object.values(p.failover)].flatMap((x) => {
      const b = tryParseRung(x)?.backend;
      return b === undefined ? [] : b === "claude" ? [b, "claude-code"] : [b];
    }),
  );
  const pool = catalogPairs(c).filter((x) => {
    const r = tryParseRung(x);
    return r !== null && backends.includes(r.backend) && named.has(r.backend);
  });
  for (const [from, to] of Object.entries(p.failover)) {
    const at = `failover.${from}`;
    const native = ladders.has(from) ? nativeClaudeIssue(to, host, at) : null;
    if (native) errors.push(native);
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
    const above = aboveCeiling(p.maxEffort, to, at);
    if (above) warnings.push(above);
    if (!backends.includes(b.backend)) {
      errors.push({ path: at, message: `stand-in ${to}: catherd cannot run ${b.backend} yet` });
      continue;
    }
    const ranked = rankStandIns(c, p.billing, from, pool);
    const unindexed = intelligenceOf(c, to) === null;
    if (unindexed)
      (o.unindexed === "warning" ? warnings : errors).push({
        path: at,
        message: unindexedMessage(to),
        fix: noIndex(c) ? SYNC_FIX : `catherd profile set failover.${from} ${ranked[0] ?? "null"}`,
      });
    if (quotaOf(a) === quotaOf(b))
      errors.push({
        path: at,
        message: `stand-in ${to} draws on the same quota as ${from}, which is out when ${from} hits its limit`,
        fix: "name a stand-in on another backend or plan",
      });
    // an unindexed stand-in has its own finding above: no "downgrade" besides
    if (!unindexed && downgrade(c, from, to))
      warnings.push({
        path: at,
        message: `downgrade: ${to} stands in for ${from} at intelligence ${(intelligenceOf(c, to) as number).toFixed(1)}, below its ${(intelligenceOf(c, from) as number).toFixed(1)}`,
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

/** Plan 33: a warning for a rung above its model's `maxEffort`, null for any other. */
function aboveCeiling(maxEffort: Readonly<Record<string, string>>, rung: string, path: string): Issue | null {
  const r = tryParseRung(rung);
  const key = r ? `${r.backend}:${r.model}` : "";
  const cap = maxEffort[key];
  if (!r || cap === undefined || effortRank(r.effort) <= effortRank(cap) || effortRank(r.effort) < 0)
    return null;
  return {
    path,
    message: `${rung} is above maxEffort ${cap} for ${key}: routing skips it`,
    fix: `catherd profile set maxEffort.${key} ${r.effort}, or remove the rung`,
  };
}

export function nativeClaudeIssue(rung: string, host: OrchestrationHost, path: string): Issue | null {
  const r = tryParseRung(rung);
  return host !== "claude-code" && r?.backend === "claude"
    ? {
        path,
        message: `${rung}: native Claude subagents require the claude-code orchestration host`,
        fix: `use claude-code:${r.model}#${r.effort} for headless execution, or --host claude-code`,
      }
    : null;
}
