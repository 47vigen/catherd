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
import { type Validation, validateProfile } from "../domain/profile-rules.ts";
import type { Access } from "../domain/record.ts";
import { ROLES, type Role } from "../domain/roles.ts";
import { configDir } from "../infra/paths.ts";
import { readJsonFile } from "../infra/store.ts";
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

export function validateNamed(name?: string): Validation {
  const n = name ?? activeName();
  const doc = readProfileDoc(n);
  return validateProfile(resolveProfile(doc, n), loadCatalog({ timings: false }), runnableBackends(), doc);
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
