import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { readJsonFile } from "../files.ts";
import { configDir } from "../paths.ts";
import {
  type HarnessConfig,
  type NotifyMoment,
  type Profile,
  ROLES,
  type Role,
  type RoleConfig,
} from "../types.ts";

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const Harness = z.object({ isolated: z.boolean() }).default(() => ({ isolated: false }));

const ProfileSchema = z.object({
  name: z.string().regex(NAME),
  objective: z.enum(["cost", "speed"]),
  roles: z.record(
    z.enum(ROLES),
    z.object({
      enabled: z.boolean(),
      models: z.record(z.string().min(1), z.array(z.string().min(1))),
      defaultRung: z.string().optional(),
    }),
  ),
  // Profiles written before the harness toggle existed load as native, which is the default.
  harness: z
    .object({ codex: Harness, opencode: Harness })
    .default(() => ({ codex: { isolated: false }, opencode: { isolated: false } })),
  lock: z.object({ heavy: z.union([z.number().int().min(1), z.literal("cpus/2")]) }),
  notify: z.array(z.enum(["milestone", "finish", "blocked"])),
  // spec §11b: quota failover and the run budget. Both optional, so old profile files still load.
  failover: z.record(z.string(), z.string()).optional(),
  budget: z
    .object({ minutes: z.number().optional(), tokens: z.number().optional(), usd: z.number().optional() })
    .optional(),
});
const ConfigSchema = z.looseObject({ activeProfile: z.string().optional() });
const ProjectsSchema = z.record(z.string(), z.string());

export type ProfilePatch = {
  objective?: Profile["objective"];
  /** A role's `models` map is replaced whole, so a patch can drop an entry. */
  roles?: Partial<Record<Role, Partial<RoleConfig>>>;
  harness?: Partial<Record<"codex" | "opencode", Partial<HarnessConfig>>>;
  lock?: Profile["lock"];
  notify?: NotifyMoment[];
};

const profilesDir = () => join(configDir(), "profiles");
const configFile = () => join(configDir(), "config.json");
const projectsFile = () => join(configDir(), "projects.json");

function checkName(name: string): string {
  if (!NAME.test(name))
    throw new Error(`catherd: bad profile name "${name}": use letters, digits, "-" and "_"`);
  return name;
}

function readOr<T>(schema: z.ZodType<T>, file: string, fallback: T): T {
  return existsSync(file) ? readJsonFile(schema, file) : fallback;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function defaultProfile(): Profile {
  return {
    name: "default",
    objective: "cost",
    roles: {
      architect: { enabled: true, models: { "claude-opus-5-5": ["high"] } },
      verifier: { enabled: true, models: { "claude-opus-5-5": ["low"] } },
      worker: {
        enabled: true,
        defaultRung: "gpt-6-sol#medium",
        models: { "gpt-6-luna": ["high"], "gpt-6-sol": ["medium", "high", "xhigh"] },
      },
      reviewer: { enabled: true, models: { "gpt-6-sol": ["high"] } },
      "ui-reviewer": { enabled: true, models: { "gpt-6-sol": ["medium"] } },
      artist: { enabled: true, models: { "gpt-6-sol": ["medium"] } },
      writer: { enabled: true, models: { "gpt-6-luna": ["high"] } },
      researcher: { enabled: true, models: { "gpt-6-luna": ["high"] } },
    },
    harness: { codex: { isolated: false }, opencode: { isolated: false } },
    lock: { heavy: "cpus/2" },
    notify: ["milestone", "finish", "blocked"],
  };
}

export function loadProfile(name?: string): Profile {
  const n = checkName(name ?? activeProfileName());
  const file = join(profilesDir(), `${n}.json`);
  if (existsSync(file)) return { ...readJsonFile(ProfileSchema, file), name: n };
  if (n === "default") return defaultProfile();
  throw new Error(`catherd: no profile named "${n}" (looked for ${file})`);
}

export function saveProfile(p: Profile): void {
  const file = join(profilesDir(), `${checkName(p.name)}.json`);
  const r = ProfileSchema.safeParse(p);
  if (!r.success) throw new Error(`catherd: profile "${p.name}" is invalid:\n${z.prettifyError(r.error)}`);
  writeJson(file, r.data);
}

export function listProfiles(): string[] {
  const onDisk = existsSync(profilesDir())
    ? readdirSync(profilesDir())
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -".json".length))
        .filter((n) => NAME.test(n))
    : [];
  return [...new Set(["default", ...onDisk])].sort();
}

export function activeProfileName(repo?: string): string {
  const bound = repo === undefined ? undefined : readOr(ProjectsSchema, projectsFile(), {})[resolve(repo)];
  return bound ?? readOr(ConfigSchema, configFile(), {}).activeProfile ?? "default";
}

export function setActiveProfile(name: string, repo?: string): void {
  if (!listProfiles().includes(name)) throw new Error(`catherd: no profile named "${name}"`);
  if (repo === undefined)
    writeJson(configFile(), { ...readOr(ConfigSchema, configFile(), {}), activeProfile: name });
  else writeJson(projectsFile(), { ...readOr(ProjectsSchema, projectsFile(), {}), [resolve(repo)]: name });
}

export function patchProfile(p: Profile, patch: ProfilePatch): Profile {
  const roles = { ...p.roles };
  for (const role of ROLES) {
    const rc = patch.roles?.[role];
    if (rc) roles[role] = { ...roles[role], ...rc };
  }
  return {
    ...p,
    objective: patch.objective ?? p.objective,
    roles,
    harness: {
      codex: { ...p.harness.codex, ...patch.harness?.codex },
      opencode: { ...p.harness.opencode, ...patch.harness?.opencode },
    },
    lock: patch.lock ?? p.lock,
    notify: patch.notify ?? p.notify,
  };
}
