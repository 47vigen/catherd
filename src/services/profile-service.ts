import type { HostContext, OrchestrationHost } from "../domain/host.ts";
import { agentFiles } from "../domain/agents.ts";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CatherdError } from "../domain/errors.ts";
import { parseRung } from "../domain/ids.ts";
import {
  agentName,
  applyPatch,
  assertProfileName,
  type Change,
  defaultProfileDoc,
  hostDefaultsDoc,
  diffProfiles,
  type Profile,
  type ProfileDoc,
  type ProfilePatch,
  resolveProfile,
} from "../domain/profile.ts";
import { nativeClaudeIssue, repairs, type Validation } from "../domain/profile-rules.ts";
import { ROLES } from "../domain/roles.ts";
import { withFileLockSync } from "../infra/filelock.ts";
import { configDir } from "../infra/paths.ts";
import { ensurePrivateDir, writeJsonAtomic, writeTextAtomic } from "../infra/store.ts";
import { apply, plan, pruneProfileAgents, type Synced } from "./agent-links.ts";
import { loadCatalog } from "./catalog-service.ts";
import type { ProfilePort, ProfileSaved, ProfileView } from "./ports.ts";
import {
  activeName,
  configFile,
  getProfile,
  listProfiles,
  profileExists,
  profileFile,
  profileFor,
  projectsFile,
  readConfig,
  readProfileDoc,
  readProjects,
  requireProfile,
  roleEnforcement,
  validateHere,
  validateNamed,
} from "./profile-store.ts";

// Spec §7.3, the single writer: one lock over profiles, config.json, projects.json, agent files and links.
// Reads live in profile-store.ts, the agent files and links in agent-links.ts.

/** The profiles lock every writer here takes; `init` moves 0.x files aside under it too. */
export const withProfilesLock = <T>(fn: () => T): T => {
  ensurePrivateDir(configDir());
  return withFileLockSync(join(configDir(), "profiles"), fn);
};
const locked = withProfilesLock;

const writeDoc = (name: string, doc: ProfileDoc) => writeJsonAtomic(profileFile(name), { ...doc, name });

/** Writes `doc` as profile `name` and relinks; when the relink refuses, puts the profile back as it was. */
function saveAndLink(name: string, doc: ProfileDoc, host: OrchestrationHost): Synced {
  const before = existsSync(profileFile(name)) ? readFileSync(profileFile(name), "utf8") : null;
  const hadNative = before !== null && agentFiles(getProfile(name, host), "").length > 0;
  writeDoc(name, doc);
  try {
    return syncFor(name, host, [name], host === "claude-code" || hadNative);
  } catch (e) {
    if (before === null) rmSync(profileFile(name), { force: true });
    else writeTextAtomic(profileFile(name), before);
    throw e;
  }
}

const validate = (doc: ProfileDoc, name: string, host: OrchestrationHost): Validation => {
  try {
    return validateHere(resolveProfile(doc, name, host), loadCatalog({ timings: false }), doc, host);
  } catch (e) {
    if (!(e instanceof CatherdError)) throw e;
    return { errors: [{ path: "roles", message: e.message, fix: e.fix }], warnings: [] };
  }
};
function nativeAgents(name: string, host: OrchestrationHost) {
  const files = agentFiles(getProfile(name, host), "");
  const first = files[0];
  const issue = first && nativeClaudeIssue(first.rung, host, `roles.${first.role}.rungs`);
  if (issue) throw new CatherdError("E_CONFIG_INVALID", issue.message, { fix: issue.fix });
  return files;
}
function syncFor(
  name: string,
  host: OrchestrationHost,
  extra: string[] = [],
  allowPrune = host === "claude-code",
): Synced {
  if (nativeAgents(name, host).length) return apply(plan(host, extra));
  return allowPrune ? pruneProfileAgents(name) : { linked: [], pruned: [], newSessionNeededFor: [] };
}

/** What a save returns: the port's ProfileSaved (one type for the CLI, the TUI and the MCP tools). */
export type Saved = ProfileSaved;

const unsaved = (v: Validation): Saved => ({
  saved: false,
  ...v,
  diff: [],
  linked: [],
  pruned: [],
  newSessionNeededFor: [],
});

/** The issue path of a save refused because the profile is no longer the one its caller was shown. */
export const CHANGED_ON_DISK = "profile";

/**
 * Spec §7.3 `patch` (profile_set, `catherd profile set`, the TUI's save): validates first and writes
 * nothing when invalid, unless the save repairs the profile (spec 1.2 §6.2): it removes at least one error
 * the stored profile had and adds none. Then it saves, and the result's `errors` are those still open. A
 * profile that does not exist yet starts from the default profile. With `expect` (the profile as a preview
 * read it), it writes nothing when the profile under the lock is no longer that one: the patch would land on
 * values the preview never showed.
 */
export function patchProfile(
  name: string | undefined,
  patch: ProfilePatch,
  opts: { host: OrchestrationHost; expect?: ProfileDoc },
): Saved {
  return locked(() => {
    const n = assertProfileName(name ?? activeName());
    const before = profileExists(n) ? readProfileDoc(n) : defaultProfileDoc(n);
    if (opts.expect !== undefined && !isDeepStrictEqual(before, opts.expect))
      return unsaved({
        errors: [
          {
            path: CHANGED_ON_DISK,
            message: `profile "${n}" changed on disk since it was shown`,
            fix: "check the changes and save again",
          },
        ],
        warnings: [],
      });
    const host = opts.host;
    const after = applyPatch(before, patch);
    const v = validate(after, n, host);
    if (v.errors.length && !repairs(profileExists(n) ? validate(before, n, host) : null, v))
      return unsaved(v);
    const diff = diffProfiles(resolveProfile(before, n, host), resolveProfile(after, n, host));
    return { saved: true, ...v, diff, ...saveAndLink(n, after, host) };
  });
}

/** Spec §7.3 `create` and `copy`: a new profile from `from` (default: the default profile). */
export function createProfile(name: string, from: string | undefined, host: OrchestrationHost): Saved {
  return locked(() => {
    // `default` exists without a file: resetProfile is the only way to write it
    if (profileExists(assertProfileName(name)))
      throw new CatherdError("E_INPUT_INVALID", `profile "${name}" already exists`, {
        fix: `pick another name, or edit it with catherd profile set --profile ${name}`,
      });
    if (from !== undefined && !profileExists(assertProfileName(from)))
      throw new CatherdError("E_INPUT_INVALID", `no profile named "${from}" to copy`, {
        fix: "catherd profile list",
      });
    const doc = from === undefined ? defaultProfileDoc(name) : readProfileDoc(from);
    const v = validate(doc, name, host);
    if (v.errors.length) return unsaved(v);
    return { saved: true, ...v, diff: [], ...saveAndLink(name, doc, host) };
  });
}

/** Writes the default profile under `name`, replacing what is there (`catherd init` when asked to). */
export function resetProfile(name: string, host: OrchestrationHost): Saved {
  return locked(() => {
    assertProfileName(name);
    const doc = defaultProfileDoc(name);
    const v = validate(doc, name, host);
    if (v.errors.length) return unsaved(v);
    return { saved: true, ...v, diff: [], ...saveAndLink(name, doc, host) };
  });
}

/**
 * Spec §7.3 `delete`: never the active profile or a repo-bound one; its agent files go with it. A binding
 * whose repo no longer exists does not count: it is pruned with the profile.
 */
export function deleteProfile(name: string, _host: OrchestrationHost): Synced {
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
    const projects = readProjects();
    const mine = Object.keys(projects.bindings).filter((repo) => projects.bindings[repo] === name);
    const bound = mine.filter((repo) => existsSync(repo));
    if (bound.length)
      throw new CatherdError("E_INPUT_INVALID", `"${name}" is bound to ${bound.join(", ")}`, {
        fix: "run catherd profile use --repo --clear (or use <name> --repo) inside each of those repos",
      });
    const text = readFileSync(profileFile(name), "utf8");
    rmSync(profileFile(name), { force: true });
    const gone = new Set(mine);
    if (gone.size)
      writeJsonAtomic(projectsFile(), {
        ...projects,
        bindings: Object.fromEntries(Object.entries(projects.bindings).filter(([r]) => !gone.has(r))),
      });
    try {
      return pruneProfileAgents(name);
    } catch (e) {
      writeTextAtomic(profileFile(name), text);
      if (gone.size) writeJsonAtomic(projectsFile(), projects);
      throw e;
    }
  });
}

/** Spec §7.3 `activate(name, repo?)`: the active profile, or the one bound to a repo; relinks the agents. */
export function activate(
  name: string,
  repo: string | null,
  host: OrchestrationHost,
): Synced & { active: string; repo: string | null } {
  return locked(() => {
    assertProfileName(name);
    if (!profileExists(name))
      throw new CatherdError("E_INPUT_INVALID", `no profile named "${name}"`, {
        fix: "catherd profile list",
      });
    nativeAgents(name, host);
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
      return { active: name, repo, ...syncFor(name, host, [name]) };
    } catch (e) {
      if (repo === null) writeJsonAtomic(configFile(), config);
      else writeJsonAtomic(projectsFile(), projects);
      throw e;
    }
  });
}

/** `catherd profile use --repo --clear`: removes `repo`'s binding, so it runs on the active profile again. */
export function unbind(repo: string, host: OrchestrationHost): Synced & { repo: string; was: string } {
  return locked(() => {
    const projects = readProjects();
    const was = projects.bindings[repo];
    if (was === undefined)
      throw new CatherdError("E_INPUT_INVALID", `${repo} is bound to no profile`, {
        fix: "catherd profile list shows the bound repos",
      });
    const bindings = { ...projects.bindings };
    delete bindings[repo];
    writeJsonAtomic(projectsFile(), { ...projects, schema: 1, bindings });
    try {
      return { repo, was, ...syncFor(was, host) };
    } catch (e) {
      writeJsonAtomic(projectsFile(), projects);
      throw e;
    }
  });
}

export function diffNamed(a: string, b: string, host: OrchestrationHost): Change[] {
  return diffProfiles(getProfile(a, host), getProfile(b, host));
}

function viewOf(p: Profile): ProfileView {
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
export function profileService(host: () => HostContext): ProfilePort {
  // without a name, each tool acts on the profile `repo` runs on (the active one outside a repo)
  return {
    withHost: profileService,
    raw: (name, repo = null) => readProfileDoc(name ?? activeName(repo)),
    budgetFor: (repo) => readProfileDoc(activeName(repo)).budget ?? {},
    forRepo: (repo) => viewOf(profileFor(repo, host().host)),
    get(name, repo = null) {
      const here = activeName(repo);
      const p = getProfile(name === undefined ? here : requireProfile(name), host().host);
      return {
        active: activeName(),
        here,
        profiles: listProfiles(),
        profile: viewOf(p),
        enforcement: roleEnforcement(p),
      };
    },
    validate(name, repo = null) {
      const v = validateNamed(
        name === undefined ? activeName(repo) : requireProfile(name),
        repo,
        host().host,
      );
      return { valid: v.errors.length === 0, ...v };
    },
    // a name that does not exist yet starts from the default profile
    set: (name, patch, repo = null) => patchProfile(name ?? activeName(repo), patch, { host: host().host }),
    agentFor: (repo, role, rung) =>
      parseRung(rung).backend === "claude" ? agentName(activeName(repo), role, rung) : null,
  };
}

export function resetHostDefaults(
  name: string,
  host: OrchestrationHost,
  opts: { preview: true; expect?: ProfileDoc } | { preview: false; expect: ProfileDoc },
): Saved & { expect: ProfileDoc } {
  return locked(() => {
    const before = readProfileDoc(name);
    if (!opts.preview && !isDeepStrictEqual(before, opts.expect))
      return {
        ...unsaved({
          errors: [
            {
              path: CHANGED_ON_DISK,
              message: `profile "${name}" changed on disk since it was shown`,
              fix: "preview again and review the changes",
            },
          ],
          warnings: [],
        }),
        expect: before,
      };
    const after = hostDefaultsDoc(before);
    const v = validate(after, name, host);
    if (v.errors.length) return { ...unsaved(v), expect: before };
    const diff = diffProfiles(resolveProfile(before, name, host), resolveProfile(after, name, host));
    return opts.preview
      ? { ...unsaved(v), diff, expect: before }
      : { saved: true, ...v, diff, ...saveAndLink(name, after, host), expect: before };
  });
}
