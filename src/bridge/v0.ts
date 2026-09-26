// The 0.x catalog, routing and profile code behind the 1.0 ports, translating `model#effort` rungs
// to `backend:model#effort`. Plan 4 replaces the routing half, plan 5 the profile half; then this
// file goes. Only the entry layer may import it (test/architecture.test.ts).
import { existsSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import diff from "microdiff";
import { adapterFor } from "../adapters/registry.ts";
import "../adapters/all.ts";
import { BUDGET_CHEAP_AT } from "../domain/budget.ts";
import { CatherdError, isCatherdError } from "../domain/errors.ts";
import { parseRung } from "../domain/ids.ts";
import { parseLaneHeader } from "../domain/lane.ts";
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
import { capableFor, loadCatalog, modelOf } from "../routing/catalog.ts";
import { askFinding, askSameDefect, route as route0 } from "../routing/route.ts";
import { candidates, defaultLadder, select } from "../routing/select.ts";
import type { ProfilePatch, ProfilePort, ProfileView, RoutingPort } from "../services/ports.ts";
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
  for (const role of ROLES)
    roles[role] = {
      enabled: p.roles[role].enabled,
      access: DEFAULT_ACCESS[role],
      rungs: candidates(p, c, role).map(forRole(c, role)),
    };
  return {
    name: p.name,
    roles,
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
  };
}

const BINARY: Record<string, string> = { codex: "codex", opencode: "opencode", "claude-code": "claude" };

export function v0Routing(): RoutingPort {
  return {
    async route(req) {
      const { p, c } = v0(() => ({ p: loadProfile(activeProfileName(req.repo)), c: loadCatalog() }));
      const cheap = req.spentFraction >= BUDGET_CHEAP_AT ? { ...p, objective: "cost" as const } : p;
      const out = (d: { rung: string; ladder: string[] }) => ({
        rung: forRole(c, req.role)(d.rung),
        ladder: d.ladder.map(forRole(c, req.role)),
      });
      if (req.laneText === null)
        return {
          source: "default",
          kind: null,
          difficulty: null,
          ...out(v0(() => defaultLadder(cheap, c, req.role))),
        };
      const d = await route0({
        runDir: req.runDir,
        profile: p,
        catalog: c,
        role: req.role,
        laneText: req.laneText,
        budget: { spentFraction: req.spentFraction },
      }).catch((e: unknown) => {
        throw asConfigError(e);
      });
      if (d.source === "jev") return { source: "jev", kind: d.kind, difficulty: d.difficulty, ...out(d) };
      const { kind, difficulty } = parseLaneHeader(req.laneText);
      if (kind && difficulty)
        return {
          source: "lane",
          kind,
          difficulty,
          ...out(v0(() => select(cheap, c, req.role, kind, difficulty))),
        };
      return { source: "default", kind: null, difficulty: null, ...out(d) };
    },

    agentFor(role, rung) {
      const r = parseRung(rung);
      return r.backend === "claude" ? agentName(role, `${r.model}#${r.effort}`) : null;
    },

    finding: (runDir, laneText, finding) => askFinding(runDir, laneText, finding),
    sameDefect: (runDir, before, after) => askSameDefect(runDir, before, after),

    catalog(f) {
      const c = v0(() => loadCatalog());
      const needle = f.text?.toLowerCase();
      const installed = (b: string) =>
        b === "claude" || (adapterFor(b) !== null && Bun.which(BINARY[b] ?? b) !== null);
      const models = c.models
        .filter(
          (m) =>
            (!f.role || capableFor(f.role, m)) &&
            (!f.backend || m.backend === f.backend) &&
            (!needle || m.id.toLowerCase().includes(needle)),
        )
        .map((m) => {
          const scored = c.entries.filter((e) => modelPart(e.rung) === m.id);
          const like = Object.entries(c.treatLike).filter(([k]) => modelPart(k) === m.id);
          return {
            id: m.id,
            backend: m.backend,
            installed: installed(m.backend),
            efforts: m.efforts,
            capabilities: m.capabilities,
            roles: ROLES.filter((r) => capableFor(r, m)),
            scored: scored.map((e) => ({ rung: toRung1(c, e.rung), scores: e.scores, costRank: e.costRank })),
            treatLike: mapRungs(Object.fromEntries(like), (r) => toRung1(c, r)),
          };
        })
        .filter((m) => !f.scoredOnly || m.scored.length > 0 || Object.keys(m.treatLike).length > 0)
        .sort((x, y) => y.scored.length - x.scored.length || x.id.localeCompare(y.id));
      return { total: models.length, models: models.slice(0, f.limit) };
    },
  };
}
