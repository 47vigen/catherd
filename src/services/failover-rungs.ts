import {
  catalogPairs,
  claudeBilled,
  downgrade,
  intelligenceOf,
  quotaOf,
  rankStandIns,
} from "../domain/failover.ts";
import { pairOf } from "../domain/catalog.ts";
import { backendOf as rungBackend, tryParseRung } from "../domain/ids.ts";
import type { Role } from "../domain/roles.ts";
import { effortAllowed } from "../domain/select.ts";
import { standInFor } from "./backends.ts";
import { loadCatalog } from "./catalog-service.ts";
import type { Deps, ProfileView } from "./ports.ts";
import { listProfiles, readProfileDoc } from "./profile-store.ts";
import { runProfile } from "./run-pin.ts";
import type { Run } from "./run-store.ts";

/** The headless twin of a native Claude rung is what the daemon runs: one backend name for both. */
const backendOf = (rung: string): string | null => rungBackend(rung, { claudeCode: true });

/**
 * Every backend the user configured (spec 2.0 decision 6): those of every rung in every saved profile, and of
 * every stand-in a profile's `failover` names, not only the profiles a run uses.
 */
export function configuredBackends(): string[] {
  const out = new Set<string>();
  for (const name of listProfiles()) {
    let doc: ReturnType<typeof readProfileDoc>;
    try {
      doc = readProfileDoc(name);
    } catch {
      continue;
    }
    const rungs = [
      ...Object.values(doc.roles ?? {}).flatMap((r) => r?.rungs ?? []),
      ...Object.values(doc.failover ?? {}),
    ];
    for (const r of rungs) {
      const b = backendOf(r);
      if (b) out.add(b);
    }
  }
  return [...out].sort();
}

/** The backends a limit may move work to: every configured one, and those of the run's own profile. */
export function failoverBackends(profile: ProfileView): Set<string> {
  const backends = new Set(configuredBackends());
  for (const r of [
    ...Object.values(profile.roles).flatMap((x) => x?.rungs ?? []),
    ...Object.values(profile.failover),
  ]) {
    const b = backendOf(r);
    if (b) backends.add(b);
  }
  return backends;
}

const pairsOf = (c: ReturnType<typeof loadCatalog>): { rung: string; intelligence: number }[] =>
  catalogPairs(c).map((rung) => ({
    rung,
    intelligence: (pairOf(c, rung) as { intelligence: number }).intelligence,
  }));

/**
 * Where a unit goes when `rung`'s quota hit a limit (spec 2.0 decision 6): the profile's stand-in when its quota
 * is free and it is not weaker; else the nearest indexed rung of any configured backend on a free quota that is
 * not weaker, a Claude rung last. Never a step down: a rung with no index fails over only to its stand-in, and
 * null means every candidate is held or weaker, so the caller waits for the hold. Plan 33: a stand-in above
 * its model's `maxEffort`, or below medium for a coding worker, is never taken, whatever its quota or cost.
 */
export function failoverRung(deps: Deps, run: Run, role: Role, rung: string, held: string[]): string | null {
  const from = tryParseRung(rung);
  if (!from) return null;
  const profile = runProfile(deps, run);
  const c = loadCatalog({ repo: run.meta.repo, runDir: run.dir });
  const free = (r: string): boolean => {
    const p = tryParseRung(r);
    return (
      p !== null &&
      quotaOf(p) !== quotaOf(from) &&
      !held.includes(quotaOf(p)) &&
      effortAllowed(profile.maxEffort ?? {}, role, r)
    );
  };
  const stand = standInFor(profile.failover, rung, run.meta.repo);
  const explicit = stand !== null && free(stand) && !downgrade(c, rung, stand) ? stand : null;
  if (explicit && !claudeBilled(explicit)) return explicit;
  if (intelligenceOf(c, rung) === null) return explicit;
  const backends = failoverBackends(profile);
  const pool = pairsOf(c)
    .map((p) => p.rung)
    .filter((r) => backends.has(backendOf(r) ?? ""));
  const ranked = rankStandIns(c, profile.billing, rung, pool).filter(free);
  return ranked.find((r) => !claudeBilled(r)) ?? explicit ?? ranked[0] ?? null;
}
