// The 0.x profile code behind the 1.0 profile port, translating `model#effort` rungs to
// `backend:model#effort`. Routing moved to src/services/routing-service.ts (plan 4); plan 5 replaces
// this file. Only the entry layer may import it (test/architecture.test.ts).
import { existsSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import diff from "microdiff";
import { CatherdError, isCatherdError } from "../domain/errors.ts";
import { parseRung } from "../domain/ids.ts";
import { claudeBackendFor, DEFAULT_ACCESS, type Role, ROLES } from "../domain/roles.ts";
import { agentName, claudeAgentsDir, saveProfileAndAgents } from "../profile/agents.ts";
import {
  activeProfileName,
  defaultProfile,
  listProfiles,
  loadProfile,
  patchProfile,
  type ProfilePatch as Patch0,
  validateProfile,
} from "../profile/profile.ts";
import { loadCatalog, modelOf } from "../routing/catalog.ts";
import { candidates } from "../routing/select.ts";
import type { ProfilePatch, ProfilePort, ProfileView } from "../services/ports.ts";
import type { Catalog, Profile } from "../types.ts";

/** 0.x throws plain Errors for a broken profile or catalog; the ports speak CatherdError. */
function asConfigError(e: unknown): CatherdError {
  if (isCatherdError(e)) return e;
  return new CatherdError("E_CONFIG_INVALID", String((e as Error)?.message ?? e).replace(/^catherd: /, ""), {
    fix: "run profile_validate, then fix the profile with profile_set",
  });
}

function v0<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    throw asConfigError(e);
  }
}

const modelPart = (rung0: string) => rung0.slice(0, rung0.lastIndexOf("#"));

/**
 * The 0.x catalog calls every Claude model `claude`; `claude` says which Claude backend to name instead:
 * a role's (spec D3), `claude-code` for a failover stand-in (dispatch runs it), `claude` when roleless.
 */
export function toRung1(c: Catalog, rung0: string, claude: "claude" | "claude-code" = "claude"): string {
  const model = modelPart(rung0);
  const backend = modelOf(c, model)?.backend ?? (model.includes("/") ? "opencode" : "codex");
  return `${backend === "claude" ? claude : backend}:${rung0}`;
}

const forRole = (c: Catalog, role: Role) => (r: string) => toRung1(c, r, claudeBackendFor(role));

export function toRung0(rung1: string): string {
  const r = parseRung(rung1);
  return `${r.model}#${r.effort}`;
}

const mapRungs = (m: Record<string, string>, f: (r: string) => string) =>
  Object.fromEntries(Object.entries(m).map(([a, b]) => [f(a), f(b)]));

function view(p: Profile, c: Catalog): ProfileView {
  const roles: ProfileView["roles"] = {};
  for (const role of ROLES) {
    const d = p.roles[role].defaultRung;
    roles[role] = {
      enabled: p.roles[role].enabled,
      access: DEFAULT_ACCESS[role],
      rungs: candidates(p, c, role).map(forRole(c, role)),
      ...(d ? { defaultRung: forRole(c, role)(d) } : {}),
    };
  }
  return {
    name: p.name,
    objective: p.objective,
    roles,
    // the 0.x profile stores neither: spec §7.1's defaults until plan 5's schema
    billing: {},
    jev: { use: "auto" },
    isolated: { codex: p.harness.codex.isolated, opencode: p.harness.opencode.isolated },
    failover: mapRungs(p.failover ?? {}, (r) => toRung1(c, r, "claude-code")),
    budget: p.budget ?? {},
    timeouts: { idleMin: 15, wallMin: 90 },
    preflight: { confirm: false },
    heavy: p.lock.heavy,
    notify: p.notify,
  };
}

function modelsOf(rungs: string[]): Record<string, string[]> {
  const m: Record<string, string[]> = {};
  for (const r of rungs) {
    const { model, effort } = parseRung(r);
    (m[model] ??= []).push(effort);
  }
  return m;
}

function applyPatch(before: Profile, patch: ProfilePatch): Profile {
  const roles: NonNullable<Patch0["roles"]> = {};
  for (const role of ROLES) {
    const rc = patch.roles?.[role];
    if (!rc) continue;
    roles[role] = {
      ...(rc.enabled === undefined ? {} : { enabled: rc.enabled }),
      ...(rc.rungs === undefined ? {} : { models: modelsOf(rc.rungs) }),
      ...(rc.defaultRung === undefined ? {} : { defaultRung: toRung0(rc.defaultRung) }),
    };
  }
  const patched = patchProfile(before, {
    objective: patch.objective,
    roles,
    harness: patch.harness,
    lock: patch.lock,
    notify: patch.notify,
  });
  return {
    ...patched,
    ...(patch.failover === undefined ? {} : { failover: mapRungs(patch.failover, toRung0) }),
    ...(patch.budget === undefined ? {} : { budget: patch.budget }),
  };
}

export function v0Profiles(): ProfilePort {
  return {
    forRepo: (repo) => v0(() => view(loadProfile(activeProfileName(repo ?? undefined)), loadCatalog())),
    get: (name) =>
      v0(() => {
        const active = activeProfileName();
        return {
          active,
          profiles: listProfiles(),
          profile: view(loadProfile(name ?? active), loadCatalog()),
        };
      }),
    validate: (name) =>
      v0(() => {
        const errors = validateProfile(loadProfile(name ?? activeProfileName()), loadCatalog());
        return { valid: errors.length === 0, errors };
      }),
    set: (name, patch) =>
      v0(() => {
        const c = loadCatalog();
        const n = name ?? activeProfileName();
        const before: Profile = listProfiles().includes(n)
          ? loadProfile(n)
          : { ...defaultProfile(), name: n };
        const after = applyPatch(before, patch);
        const errors = validateProfile(after, c);
        if (errors.length) return { saved: false, errors, diff: [], newSessionNeededFor: [] };
        const dir = claudeAgentsDir();
        const had = new Set(existsSync(dir) ? readdirSync(dir) : []);
        const agents = saveProfileAndAgents(after, c);
        return {
          saved: true,
          errors: [],
          diff: diff(
            before as unknown as Record<string, unknown>,
            after as unknown as Record<string, unknown>,
          ),
          newSessionNeededFor: agents.linked
            .filter((l) => !had.has(basename(l)))
            .map((l) => basename(l, ".md")),
        };
      }),
    agentFor(role, rung) {
      const r = parseRung(rung);
      return r.backend === "claude" ? agentName(role, `${r.model}#${r.effort}`) : null;
    },
  };
}
