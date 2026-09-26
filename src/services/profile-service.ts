import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { basename, join, sep } from "node:path";
import { z } from "zod";
import { ADAPTER_IDS } from "../adapters/backend.ts";
import { adapterFor } from "../adapters/registry.ts";
import "../adapters/all.ts";
import { type AgentFile, agentFiles } from "../domain/agents.ts";
import { CatherdError } from "../domain/errors.ts";
import { parseRung } from "../domain/ids.ts";
import {
  agentName,
  applyPatch,
  assertProfileName,
  type Change,
  defaultProfileDoc,
  diffProfiles,
  PROFILE_NAME,
  type Profile,
  type ProfileDoc,
  ProfileDocSchema,
  type ProfilePatch,
  resolveProfile,
} from "../domain/profile.ts";
import { type Issue, type Validation, validateProfile } from "../domain/profile-rules.ts";
import type { Access } from "../domain/record.ts";
import { ROLES, type Role } from "../domain/roles.ts";
import { withFileLockSync } from "../infra/filelock.ts";
import { claudeAgentsDir, configDir } from "../infra/paths.ts";
import { writeJsonAtomic, writeTextAtomic } from "../infra/store.ts";
import { VERSION } from "../infra/version.ts";
import { backendOfKey, loadCatalog } from "./catalog-service.ts";
import type { ProfilePort, ProfileView } from "./ports.ts";

export const profilesDir = (): string => join(configDir(), "profiles");
export const configFile = (): string => join(configDir(), "config.json");
export const projectsFile = (): string => join(configDir(), "projects.json");
/** `<config>/agents/<profile>/<agent>.md`: catherd's own agent files, which the links point at. */
export const agentsRoot = (): string => join(configDir(), "agents");
const profileFile = (name: string) => join(profilesDir(), `${name}.json`);

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
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new CatherdError("E_CONFIG_INVALID", `${file} is not readable JSON: ${(e as Error).message}`, {
      fix: `fix or delete ${file}`,
    });
  }
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
        fix: "upgrade catherd: bunx catherd-cli@latest",
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
  return validateProfile(
    getProfile(name ?? activeName()),
    loadCatalog({ timings: false }),
    runnableBackends(),
  );
}

/** Spec D10: how strongly the backend holds a role to its access mode. */
export function enforcementOf(rung: string, access: Access): "enforced" | "advisory" {
  let backend: string;
  try {
    backend = parseRung(rung).backend;
  } catch {
    return "advisory";
  }
  return adapterFor(backend)?.enforcement[access] ?? "advisory";
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

// ---- agent files and links (spec §7.3) ----

const lstatOrNull = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};
const ours = (): string => `${agentsRoot()}${sep}`;
/** A link catherd made: a symlink into `<config>/agents/`. Nothing else in the agents dir is ever touched. */
const isOurLink = (path: string): boolean => {
  const st = lstatOrNull(path);
  return st !== null && st.isSymbolicLink() && readlinkSync(path).startsWith(ours());
};

/** Spec §7.3: the active profile and every repo-bound one are linked at once. */
export function linkedProfiles(): string[] {
  const names = new Set([activeName(), ...Object.values(readProjects().bindings)]);
  return [...names].filter(profileExists).sort();
}

interface Planned {
  files: Map<string, AgentFile[]>;
  links: Map<string, string>;
}

function plan(extra: string[] = []): Planned {
  const files = new Map<string, AgentFile[]>();
  for (const name of new Set([...linkedProfiles(), ...extra.filter(profileExists)]))
    files.set(name, agentFiles(getProfile(name), VERSION));
  const links = new Map<string, string>();
  for (const name of linkedProfiles())
    for (const f of files.get(name) ?? [])
      links.set(join(claudeAgentsDir(), `${f.name}.md`), join(agentsRoot(), name, `${f.name}.md`));
  return { files, links };
}

/** Refuses before anything is written when a planned link would replace a file catherd does not own. */
function assertNoConflict(p: Planned): void {
  for (const link of p.links.keys())
    if (lstatOrNull(link) && !isOurLink(link))
      throw new CatherdError("E_CONFIG_INVALID", `${link} exists and is not catherd's`, {
        fix: `move ${link} away, then run the command again`,
      });
}

export interface Synced {
  linked: string[];
  pruned: string[];
  /** agents whose link is new or whose file changed: Claude Code reads them only at a session's start */
  newSessionNeededFor: string[];
}

/**
 * Writes the planned agent files and links, prunes catherd's stale ones, and says what changed. The
 * ownership check runs before the first write, so no caller can replace a file catherd does not own.
 */
function apply(p: Planned, removed: string[] = []): Synced {
  assertNoConflict(p);
  const changed = new Set<string>();
  for (const [name, files] of p.files) {
    const dir = join(agentsRoot(), name);
    mkdirSync(dir, { recursive: true });
    const keep = new Set(files.map((f) => `${f.name}.md`));
    for (const f of files) {
      const path = join(dir, `${f.name}.md`);
      if (!existsSync(path) || readFileSync(path, "utf8") !== f.text) {
        writeTextAtomic(path, f.text);
        changed.add(path);
      }
    }
    for (const f of readdirSync(dir)) if (!keep.has(f)) rmSync(join(dir, f), { force: true });
  }
  for (const name of removed) rmSync(join(agentsRoot(), name), { recursive: true, force: true });

  const target = claudeAgentsDir();
  const newSession: string[] = [];
  if (p.links.size > 0) mkdirSync(target, { recursive: true });
  for (const [link, file] of p.links) {
    const fresh = !isOurLink(link) || readlinkSync(link) !== file;
    if (fresh) {
      rmSync(link, { force: true });
      symlinkSync(file, link);
    }
    if (fresh || changed.has(file)) newSession.push(basename(link, ".md"));
  }
  const pruned: string[] = [];
  if (existsSync(target))
    for (const entry of readdirSync(target)) {
      const link = join(target, entry);
      if (isOurLink(link) && !p.links.has(link)) {
        rmSync(link, { force: true });
        pruned.push(entry);
      }
    }
  return {
    linked: [...p.links.keys()].map((l) => basename(l, ".md")).sort(),
    pruned: pruned.sort(),
    newSessionNeededFor: newSession.sort(),
  };
}

/** What `doctor` compares: each link that should exist, and whether it and its file are current. */
export function agentLinkState(): { missing: string[]; stale: string[]; ok: string[] } {
  const p = plan();
  const out = { missing: [] as string[], stale: [] as string[], ok: [] as string[] };
  for (const [name, files] of p.files)
    for (const f of files) {
      const link = join(claudeAgentsDir(), `${f.name}.md`);
      if (!p.links.has(link)) continue;
      const file = join(agentsRoot(), name, `${f.name}.md`);
      if (!isOurLink(link)) out.missing.push(f.name);
      else if (readlinkSync(link) !== file || !existsSync(file) || readFileSync(file, "utf8") !== f.text)
        out.stale.push(f.name);
      else out.ok.push(f.name);
    }
  return out;
}

/** Read-only: how many of catherd's links are in the agents dir (the 0.x dashboard's status row). */
export function countLinkedAgents(): number {
  const target = claudeAgentsDir();
  return existsSync(target) ? readdirSync(target).filter((e) => isOurLink(join(target, e))).length : 0;
}

// ---- writers: one lock over profiles, config.json, projects.json, agent files and links ----

/** The profiles lock every writer here takes; `init` moves 0.x files aside under it too. */
export const withProfilesLock = <T>(fn: () => T): T => {
  mkdirSync(configDir(), { recursive: true });
  return withFileLockSync(join(configDir(), "profiles"), fn);
};
const locked = withProfilesLock;

const writeDoc = (name: string, doc: ProfileDoc) => writeJsonAtomic(profileFile(name), { ...doc, name });

/** Writes `doc` as profile `name` and relinks; when the relink refuses, puts the profile back as it was. */
function saveAndLink(name: string, doc: ProfileDoc): Synced {
  const before = existsSync(profileFile(name)) ? readFileSync(profileFile(name), "utf8") : null;
  writeDoc(name, doc);
  try {
    return apply(plan([name]));
  } catch (e) {
    if (before === null) rmSync(profileFile(name), { force: true });
    else writeTextAtomic(profileFile(name), before);
    throw e;
  }
}

const validate = (doc: ProfileDoc, name: string): Validation =>
  validateProfile(resolveProfile(doc, name), loadCatalog({ timings: false }), runnableBackends());

export interface Saved extends Synced {
  saved: boolean;
  errors: Issue[];
  warnings: Issue[];
  diff: Change[];
}

const unsaved = (v: Validation): Saved => ({
  saved: false,
  ...v,
  diff: [],
  linked: [],
  pruned: [],
  newSessionNeededFor: [],
});

/**
 * Spec §7.3 `patch` (profile_set, `catherd profile set`): validates first and writes nothing when invalid.
 * A profile that does not exist yet starts from the default profile.
 */
export function patchProfile(name: string | undefined, patch: ProfilePatch): Saved {
  return locked(() => {
    const n = assertProfileName(name ?? activeName());
    const before = profileExists(n) ? readProfileDoc(n) : defaultProfileDoc(n);
    const after = applyPatch(before, patch);
    const resolved = resolveProfile(after, n);
    const v = validate(after, n);
    if (v.errors.length) return unsaved(v);
    const diff = diffProfiles(resolveProfile(before, n), resolved);
    return { saved: true, ...v, diff, ...saveAndLink(n, after) };
  });
}

/** Spec §7.3 `create` and `copy`: a new profile from `from` (default: the default profile). */
export function createProfile(name: string, from?: string): Saved {
  return locked(() => {
    assertProfileName(name);
    if (existsSync(profileFile(name)))
      throw new CatherdError("E_INPUT_INVALID", `profile "${name}" already exists`, {
        fix: `pick another name, or edit it with catherd profile set --profile ${name}`,
      });
    if (from !== undefined && !profileExists(assertProfileName(from)))
      throw new CatherdError("E_INPUT_INVALID", `no profile named "${from}" to copy`, {
        fix: "catherd profile list",
      });
    const doc = from === undefined ? defaultProfileDoc(name) : readProfileDoc(from);
    const v = validate(doc, name);
    if (v.errors.length) return unsaved(v);
    return { saved: true, ...v, diff: [], ...saveAndLink(name, doc) };
  });
}

/** Writes the default profile under `name`, replacing what is there (`catherd init` when asked to). */
export function resetProfile(name: string): Saved {
  return locked(() => {
    assertProfileName(name);
    const doc = defaultProfileDoc(name);
    const v = validate(doc, name);
    if (v.errors.length) return unsaved(v);
    return { saved: true, ...v, diff: [], ...saveAndLink(name, doc) };
  });
}

/** Spec §7.3 `delete`: never the active profile or a repo-bound one; its agent files go with it. */
export function deleteProfile(name: string): Synced {
  return locked(() => {
    assertProfileName(name);
    if (!existsSync(profileFile(name)))
      throw new CatherdError("E_INPUT_INVALID", `profile "${name}" has no file to delete`, {
        fix: "catherd profile list",
      });
    if (name === activeName())
      throw new CatherdError("E_INPUT_INVALID", `"${name}" is the active profile`, {
        fix: "make another profile active first: catherd profile use <name>",
      });
    const bound = Object.entries(readProjects().bindings)
      .filter(([, p]) => p === name)
      .map(([repo]) => repo);
    if (bound.length)
      throw new CatherdError("E_INPUT_INVALID", `"${name}" is bound to ${bound.join(", ")}`, {
        fix: `bind those repos to another profile: catherd profile use <name> --repo (run inside each)`,
      });
    const text = readFileSync(profileFile(name), "utf8");
    rmSync(profileFile(name), { force: true });
    try {
      return apply(plan(), [name]);
    } catch (e) {
      writeTextAtomic(profileFile(name), text);
      throw e;
    }
  });
}

/** Spec §7.3 `activate(name, repo?)`: the active profile, or the one bound to a repo; relinks the agents. */
export function activate(
  name: string,
  repo: string | null = null,
): Synced & { active: string; repo: string | null } {
  return locked(() => {
    assertProfileName(name);
    if (!profileExists(name))
      throw new CatherdError("E_INPUT_INVALID", `no profile named "${name}"`, {
        fix: "catherd profile list",
      });
    const config = readConfig();
    const projects = readProjects();
    const write = () =>
      repo === null
        ? writeJsonAtomic(configFile(), { ...config, schema: 1, activeProfile: name })
        : writeJsonAtomic(projectsFile(), {
            ...projects,
            schema: 1,
            bindings: { ...projects.bindings, [repo]: name },
          });
    write();
    try {
      return { active: name, repo, ...apply(plan([name])) };
    } catch (e) {
      if (repo === null) writeJsonAtomic(configFile(), config);
      else writeJsonAtomic(projectsFile(), projects);
      throw e;
    }
  });
}

/** Rewrites every agent file and link from the profiles as they are (after an upgrade, or for doctor's fix). */
export const relink = (): Synced => locked(() => apply(plan()));

export function diffNamed(a: string, b: string): Change[] {
  return diffProfiles(getProfile(a), getProfile(b));
}

export function viewOf(p: Profile): ProfileView {
  const roles: ProfileView["roles"] = {};
  for (const role of ROLES) roles[role] = { ...p.roles[role], rungs: [...p.roles[role].rungs] };
  return {
    name: p.name,
    objective: p.objective,
    roles,
    billing: p.billing,
    jev: p.jev,
    isolated: Object.fromEntries(Object.entries(p.harness).map(([k, h]) => [k, h.isolated])),
    failover: p.failover,
    budget: p.budget,
    timeouts: p.timeouts,
    preflight: p.preflight,
    heavy: p.lock.heavy,
    notify: p.notify,
  };
}

/** The ProfilePort the run engine and the MCP tools use (spec §7.3: the single writer). */
export function profileService(): ProfilePort {
  // without a name, each tool acts on the profile `repo` runs on (the active one outside a repo)
  return {
    forRepo: (repo) => viewOf(profileFor(repo)),
    get(name, repo = null) {
      const here = activeName(repo);
      const p = getProfile(name === undefined ? here : requireProfile(name));
      return {
        active: activeName(),
        here,
        profiles: listProfiles(),
        profile: viewOf(p),
        enforcement: roleEnforcement(p),
      };
    },
    validate(name, repo = null) {
      const v = validateNamed(name === undefined ? activeName(repo) : requireProfile(name));
      return { valid: v.errors.length === 0, ...v };
    },
    // a name that does not exist yet starts from the default profile
    set: (name, patch, repo = null) => patchProfile(name ?? activeName(repo), patch),
    agentFor: (repo, role, rung) =>
      parseRung(rung).backend === "claude" ? agentName(activeName(repo), role, rung) : null,
  };
}
