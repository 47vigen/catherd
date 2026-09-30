import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { adapterFor } from "../adapters/registry.ts";
import "../adapters/all.ts";
import { CatherdError, UPGRADE } from "../domain/errors.ts";
import { ADAPTER_IDS, tryParseRung } from "../domain/ids.ts";
import {
  assertProfileName,
  defaultProfileDoc,
  PROFILE_NAME,
  type Profile,
  type ProfileDoc,
  ProfileDocSchema,
  resolveProfile,
} from "../domain/profile.ts";
import { type Issue, type Validation, validateProfile } from "../domain/profile-rules.ts";
import type { Catalog } from "../domain/catalog.ts";
import type { Access } from "../domain/record.ts";
import { ROLES, type Role } from "../domain/roles.ts";
import { configDir } from "../infra/paths.ts";
import { readJsonFile } from "../infra/store.ts";
import { standInFor } from "./backends.ts";
import { backendOfKey, loadCatalog } from "./catalog-service.ts";

// Spec §7.3, the read side of the profile service: where profiles, config.json and projects.json live,
// and reading them. Every write goes through profile-service.ts.

export const profilesDir = (): string => join(configDir(), "profiles");
export const configFile = (): string => join(configDir(), "config.json");
export const projectsFile = (): string => join(configDir(), "projects.json");
/** `<config>/agents/<profile>/<agent>.md`: catherd's own agent files, which the links point at. */
export const agentsRoot = (): string => join(configDir(), "agents");
export const profileFile = (name: string): string => join(profilesDir(), `${name}.json`);

const ConfigSchema = z.looseObject({ schema: z.literal(1), activeProfile: z.string().optional() });
const ProjectsSchema = z.looseObject({
  schema: z.literal(1),
  bindings: z.record(z.string(), z.string()).default({}),
});
export type Config = z.infer<typeof ConfigSchema>;
export type Projects = z.infer<typeof ProjectsSchema>;

/**
 * Reads a schema-1 file. A file without `schema` was written by catherd 0.x, which 1.0 does not read
 * (spec D2): `catherd init` moves those aside.
 */
function readV1<T>(file: string, schema: z.ZodType<T>): T {
  const raw = readJsonFile(file);
  const found = (raw as { schema?: unknown } | null)?.schema;
  if (found === undefined)
    throw new CatherdError("E_CONFIG_INVALID", `${file} is from catherd 0.x`, {
      fix: "run catherd init, which moves 0.x files aside and writes 1.0 ones",
    });
  if (typeof found === "number" && found > 1)
    throw new CatherdError(
      "E_CONFIG_NEWER_SCHEMA",
      `${file} has schema ${found}, newer than this catherd (1)`,
      {
        fix: `upgrade catherd: ${UPGRADE}`,
      },
    );
  const r = schema.safeParse(raw);
  if (!r.success)
    throw new CatherdError("E_CONFIG_INVALID", `${file} is invalid:\n${z.prettifyError(r.error)}`, {
      fix: `fix it with catherd profile set, or delete ${file}`,
    });
  return r.data;
}

export const readConfig = (): Config =>
  existsSync(configFile()) ? readV1(configFile(), ConfigSchema) : { schema: 1 };
export const readProjects = (): Projects =>
  existsSync(projectsFile()) ? readV1(projectsFile(), ProjectsSchema) : { schema: 1, bindings: {} };

/** Every profile name: the files in `profiles/`, and `default`, which exists even before its file does. */
export function listProfiles(): string[] {
  const onDisk = existsSync(profilesDir())
    ? readdirSync(profilesDir())
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -".json".length))
        .filter((n) => PROFILE_NAME.test(n))
    : [];
  return [...new Set(["default", ...onDisk])].sort();
}

export const profileExists = (name: string): boolean => listProfiles().includes(name);

/** The stored document; `default` without a file is the built-in default profile. */
export function readProfileDoc(name: string): ProfileDoc {
  assertProfileName(name);
  if (existsSync(profileFile(name))) return readV1(profileFile(name), ProfileDocSchema);
  if (name === "default") return defaultProfileDoc();
  throw new CatherdError("E_CONFIG_INVALID", `no profile named "${name}"`, { fix: "catherd profile list" });
}

export const getProfile = (name: string): Profile => resolveProfile(readProfileDoc(name), name);

/** A profile name the user typed: refused as bad input (exit 2) when no such profile exists. */
export function requireProfile(name: string): string {
  if (!profileExists(assertProfileName(name)))
    throw new CatherdError("E_INPUT_INVALID", `no profile named "${name}"`, { fix: "catherd profile list" });
  return name;
}

/** The profile bound to `repo` (a git toplevel), else the active one, else `default`. */
export function activeName(repo: string | null = null): string {
  const bound = repo === null ? undefined : readProjects().bindings[repo];
  return bound ?? readConfig().activeProfile ?? "default";
}

export const profileFor = (repo: string | null): Profile => getProfile(activeName(repo));

/** The backends catherd can run: every registered adapter, and the native `claude` path. */
export const runnableBackends = (): string[] => ["claude", ...ADAPTER_IDS.filter((id) => adapterFor(id))];

/** Whether a profile's billing or harness key belongs to one of `backends` (default: runnableBackends()). */
export const keyRunnable = (key: string, backends: string[] = runnableBackends()): boolean =>
  backends.includes(backendOfKey(key));

/**
 * Spec 1.3 §8: each backend `p` isolates whose isolated run logs in with an API key that is not in `env` (the
 * environment catherd runs, and starts workers, in).
 */
export function isolationKeyErrors(
  p: Profile,
  env: Record<string, string | undefined> = process.env,
): Issue[] {
  const out: Issue[] = [];
  for (const [id, h] of Object.entries(p.harness)) {
    const key = h.isolated ? adapterFor(id)?.isolationKey : undefined;
    if (key && !env[key])
      out.push({
        path: `harness.${id}.isolated`,
        message: `an isolated ${id} run needs ${key}, which catherd's environment does not have`,
        fix: `export ${key}=<key>, or catherd profile set harness.${id}.isolated false`,
      });
  }
  return out;
}

/**
 * Spec 1.3 §9 Q2: each enabled role whose rung, or a failover stand-in of one, runs natively on a backend that
 * holds the role's access only when isolated (agy has no read-only flag).
 */
export function isolatedOnlyErrors(p: Profile): Issue[] {
  const out: Issue[] = [];
  for (const role of ROLES) {
    const rc = p.roles[role];
    if (!rc.enabled) continue;
    // a stand-in the profile does not name is the one dispatch picks on its own (a paired backend's or the
    // adapter's); one on the rung's own backend adds nothing, since the rung's own error names that backend
    const runs = [
      ...rc.rungs.map((r) => [r, `roles.${role}.rungs`]),
      ...rc.rungs.flatMap((r) => {
        if (p.failover[r]) return [[p.failover[r], `failover.${r}`, null]];
        const s = standInFor(p.failover, r);
        return s && tryParseRung(s)?.backend !== tryParseRung(r)?.backend
          ? [[s, `roles.${role}.rungs`, r]]
          : [];
      }),
    ] as [string, string, string | null][];
    for (const [rung, path, auto] of runs) {
      const b = tryParseRung(rung)?.backend;
      if (!b || p.harness[b]?.isolated || !adapterFor(b)?.isolatedOnly?.includes(rc.access)) continue;
      const isolate = `isolate ${b} (catherd profile set harness.${b}.isolated true)`;
      out.push({
        path,
        message: `${rung}${auto ? `, the automatic stand-in of ${auto}` : ""}: native ${b} cannot hold the ${role} role to ${rc.access}`,
        fix: auto
          ? `${isolate}, or name another stand-in (catherd profile set failover.${auto} <rung>)`
          : `${isolate}, or put this role on another backend`,
      });
    }
  }
  return out;
}

/**
 * Spec §4.6: with `budget.usd` set, one warning per backend an enabled role runs on whose adapter reports no
 * dollar cost, since that cap never sees what the backend spends. Never an error: the cap still counts the rest.
 */
export function budgetUsdWarnings(p: Profile): Issue[] {
  if (p.budget.usd === undefined) return [];
  const blind = new Map<string, Role[]>();
  const note = (rung: string, role: Role) => {
    const b = tryParseRung(rung)?.backend;
    // no adapter (native `claude`, whose subagents report their own cost): nothing to warn about
    if (!b || adapterFor(b)?.reportsCost !== false) return;
    const roles = blind.get(b) ?? [];
    if (!roles.includes(role)) roles.push(role);
    blind.set(b, roles);
  };
  for (const role of ROLES) {
    const rc = p.roles[role];
    if (!rc.enabled) continue;
    for (const rung of rc.rungs) {
      note(rung, role);
      // a quota failover runs the role on its stand-in, whose spend the cap must see too
      const standIn = p.failover[rung];
      if (standIn) note(standIn, role);
    }
  }
  return [...blind].map(([b, roles]) => ({
    path: "budget.usd",
    message: `budget.usd will not see ${b}'s spend: ${b} reports no dollar cost (${roles.join(", ")} run on it)`,
    fix: "cap it with budget.tokens or budget.minutes: catherd profile set budget.tokens <n>",
  }));
}

/**
 * Spec §7.1 validation on this machine: the backends catherd can run here, the keys isolation needs, the
 * accesses a backend holds only when isolated, and the backends a dollar budget cannot see.
 */
export function validateHere(p: Profile, c: Catalog, doc?: ProfileDoc): Validation {
  const v = validateProfile(p, c, runnableBackends(), doc);
  return {
    errors: [...v.errors, ...isolationKeyErrors(p), ...isolatedOnlyErrors(p)],
    warnings: [...v.warnings, ...budgetUsdWarnings(p)],
  };
}

/** `repo`: the git toplevel whose listing route reads (opencode lists its models per repository). */
export function validateNamed(name?: string, repo: string | null = null): Validation {
  const n = name ?? activeName(repo);
  const doc = readProfileDoc(n);
  const catalog = loadCatalog({ timings: false, ...(repo === null ? {} : { repo }) });
  return validateHere(resolveProfile(doc, n), catalog, doc);
}

/** Spec D10: how strongly the backend holds a role to its access mode. */
export function enforcementOf(rung: string, access: Access): "enforced" | "advisory" {
  const r = tryParseRung(rung);
  return (r && adapterFor(r.backend)?.enforcement[access]) ?? "advisory";
}

/** Each role's weakest enforcement over its rungs, for `profile show` and profile_get. */
export function roleEnforcement(p: Profile): Record<Role, "enforced" | "advisory"> {
  const out = {} as Record<Role, "enforced" | "advisory">;
  for (const role of ROLES) {
    const rc = p.roles[role];
    out[role] = rc.rungs.every((r) => enforcementOf(r, rc.access) === "enforced") ? "enforced" : "advisory";
  }
  return out;
}
