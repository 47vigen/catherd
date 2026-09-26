// 0.x shim, removed by plan 6: the 0.x TUI (dashboard, editor, init) and src/core edit profiles in the 0.x
// shape (`roles[role].models`, rungs without a backend). This translates that shape to and from the 1.0
// profile service, the single writer, so the TUI never writes a 0.x file over a 1.0 one. Every 1.0 field
// the 0.x shape lacks (access, billing, jev, timeouts, per-role Claude backend…) is kept from the stored
// profile on save.
import type { Catalog as Catalog1 } from "../domain/catalog.ts";
import { parseRung } from "../domain/ids.ts";
import {
  applyPatch,
  defaultProfileDoc,
  type Profile as Profile1,
  type ProfilePatch,
  resolveProfile,
} from "../domain/profile.ts";
import { validateProfile as validate1 } from "../domain/profile-rules.ts";
import { ROLES, type Role } from "../domain/roles.ts";
import { loadCatalog as loadCatalog1 } from "../services/catalog-service.ts";
import * as svc from "../services/profile-service.ts";
import type { Catalog, Profile, RoleConfig } from "../types.ts";

export const countLinkedAgents = svc.countLinkedAgents;
export const listProfiles = svc.listProfiles;
export const deleteProfile = (name: string): void => void svc.deleteProfile(name);
export const activeProfileName = (repo?: string): string => svc.activeName(repo ?? null);
export const setActiveProfile = (name: string, repo?: string): void => void svc.activate(name, repo ?? null);

const rung0 = (rung1: string): string => {
  const r = parseRung(rung1);
  return `${r.model}#${r.effort}`;
};

/** A 1.0 profile in the 0.x shape: rungs lose their backend, grouped by model in ladder order. */
export function toV0(p: Profile1): Profile {
  const roles = {} as Record<Role, RoleConfig>;
  for (const role of ROLES) {
    const rc = p.roles[role];
    const models: Record<string, string[]> = {};
    for (const r of rc.rungs) {
      try {
        const { model, effort } = parseRung(r);
        (models[model] ??= []).push(effort);
      } catch {
        // a rung the 0.x shape cannot hold; validate reports it
      }
    }
    roles[role] = {
      enabled: rc.enabled,
      models,
      ...(rc.defaultRung ? { defaultRung: rung0(rc.defaultRung) } : {}),
    };
  }
  const failover = Object.fromEntries(Object.entries(p.failover).map(([a, b]) => [rung0(a), rung0(b)]));
  return {
    name: p.name,
    objective: p.objective,
    roles,
    harness: {
      codex: { isolated: p.harness.codex?.isolated ?? false },
      opencode: { isolated: p.harness.opencode?.isolated ?? false },
    },
    lock: p.lock,
    notify: p.notify,
    failover,
    // 0.x reads a missing budget as "no cap"; an empty one would count as a cap of nothing
    ...(Object.keys(p.budget).length ? { budget: p.budget } : {}),
  };
}

const parses = (rung1: string): boolean => {
  try {
    parseRung(rung1);
    return true;
  } catch {
    return false;
  }
};

const sameRung = (rung1: string, r0: string): boolean => {
  try {
    return rung0(rung1) === r0;
  } catch {
    return false;
  }
};

/**
 * The backend a 0.x `model#effort` runs on: the one the stored role already uses for that model, else the
 * 1.0 catalog's (a Claude model: native for architect and verifier, headless otherwise, spec D3).
 */
function backendFor(c: Catalog1, before: Profile1, role: Role | null, model: string): string {
  const own = (role ? before.roles[role].rungs : Object.keys(before.failover)).find((r) => {
    try {
      return parseRung(r).model === model;
    } catch {
      return false;
    }
  });
  if (own) return parseRung(own).backend;
  if (model.includes("/")) return "opencode";
  if (!c.families.some((f) => f.on["claude-code"]?.id === model)) return "codex";
  return role === "architect" || role === "verifier" ? "claude" : "claude-code";
}

/** The patch that turns the stored profile into `p0`, keeping every field the 0.x shape does not have. */
export function patchFromV0(
  p0: Profile,
  before: Profile1,
  c: Catalog1 = loadCatalog1({ timings: false }),
): ProfilePatch {
  const to1 = (role: Role | null, r0: string) => {
    const hash = r0.lastIndexOf("#");
    return `${backendFor(c, before, role, r0.slice(0, hash))}:${r0}`;
  };
  // the stored 1.0 rung for a 0.x one, so a save keeps each rung's backend
  const storedFor = (rungs: string[], r0: string) => rungs.find((r) => sameRung(r, r0));
  const roles: NonNullable<ProfilePatch["roles"]> = {};
  for (const role of ROLES) {
    const rc = p0.roles[role];
    const wanted = Object.entries(rc.models).flatMap(([model, efforts]) =>
      efforts.map((e) => `${model}#${e}`),
    );
    // the 0.x shape groups rungs by model: keep the stored ladder's order and backends for every rung still
    // there, then add the new ones in the editor's order
    const left = [...wanted];
    const rungs: string[] = [];
    for (const r of before.roles[role].rungs) {
      // a rung the 0.x shape cannot hold stays where it is, for validate to report
      if (!parses(r)) {
        rungs.push(r);
        continue;
      }
      const i = left.findIndex((r0) => sameRung(r, r0));
      if (i < 0) continue;
      rungs.push(r);
      left.splice(i, 1);
    }
    rungs.push(...left.map((r0) => to1(role, r0)));
    const dr = rc.defaultRung;
    roles[role] = {
      enabled: rc.enabled,
      rungs,
      defaultRung: dr ? (storedFor(rungs, dr) ?? to1(role, dr)) : null,
    };
  }
  const failover: Record<string, string | null> = Object.fromEntries(
    Object.keys(before.failover).map((k) => [k, null]),
  );
  for (const [a, b] of Object.entries(p0.failover ?? {})) {
    const key = storedFor(Object.keys(before.failover), a) ?? to1(null, a);
    const kept = before.failover[key];
    failover[key] = kept !== undefined && sameRung(kept, b) ? kept : to1(null, b);
  }
  return {
    objective: p0.objective,
    roles,
    harness: {
      codex: { isolated: p0.harness.codex.isolated },
      opencode: { isolated: p0.harness.opencode.isolated },
    },
    lock: p0.lock,
    notify: p0.notify,
    failover,
    budget: {
      minutes: p0.budget?.minutes ?? null,
      tokens: p0.budget?.tokens ?? null,
      usd: p0.budget?.usd ?? null,
    },
  };
}

const stored = (name: string) =>
  svc.profileExists(name) ? svc.readProfileDoc(name) : defaultProfileDoc(name);

/** The default profile in the 0.x shape: where the 0.x editor and init start a new profile. */
export const defaultProfile = (): Profile => toV0(resolveProfile(defaultProfileDoc(), "default"));

export const loadProfile = (name?: string): Profile => toV0(svc.getProfile(name ?? svc.activeName()));

/** 1.0 validation of the 0.x profile as it would be saved; one line per error. */
export function validateProfile(p0: Profile, _c?: Catalog): string[] {
  const doc = stored(p0.name);
  const after = resolveProfile(applyPatch(doc, patchFromV0(p0, resolveProfile(doc, p0.name))), p0.name);
  return validate1(after, loadCatalog1({ timings: false }), svc.runnableBackends()).errors.map(
    (e) => e.message,
  );
}

/** Saves through the profile service, which validates, writes the agent files and relinks them. */
export function saveProfile(p0: Profile): void {
  const doc = stored(p0.name);
  const r = svc.patchProfile(p0.name, patchFromV0(p0, resolveProfile(doc, p0.name)));
  if (!r.saved)
    throw new Error(`catherd: profile "${p0.name}" is invalid: ${r.errors.map((e) => e.message).join("; ")}`);
}

export const saveProfileAndAgents = (p0: Profile, _c?: Catalog): void => saveProfile(p0);
