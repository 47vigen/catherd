import { type Dim, scoresOf, rungInfo } from "../domain/catalog.ts";
import { CatherdError } from "../domain/errors.ts";
import { tryParseRung } from "../domain/ids.ts";
import { ROLES } from "../domain/roles.ts";
import { canonicalRung, loadCatalog, readOverride, removeTreatLikes } from "./catalog-service.ts";
import { getProfile, listProfiles } from "./profile-store.ts";
import { type Suggestion, suggestStandIns } from "./standins.ts";

/** A profile's rung that would lean on an inferred stand-in, or be left with no value at all (spec 1.2 §6.4). */
export interface LeftOnStandIn {
  profile: string;
  rung: string;
  /** the dimensions an inferred stand-in would fill; empty when the rung is left unscored */
  dims: Dim[];
  /** no value of its own and no stand-in near enough: routing skips it */
  unscored: boolean;
}

/**
 * Spec 1.2 §6.4: the rungs of every profile (enabled roles' rungs and failover stand-ins) that would lean on an
 * inferred stand-in, or be left with no value at all, once the user's treat-likes for `removed` (canonical
 * rungs, or all of them) are gone. Never removed silently.
 */
export function leftOnStandIns(removed: string[] | "all"): LeftOnStandIn[] {
  const cur = readOverride();
  const treatLike = Object.fromEntries(
    Object.entries(cur.treatLike).filter(([r]) => removed !== "all" && !removed.includes(r)),
  );
  const gone = removed === "all" ? Object.keys(cur.treatLike) : removed;
  const c = loadCatalog({ timings: false, override: { ...cur, treatLike } });
  const out: LeftOnStandIn[] = [];
  for (const profile of listProfiles()) {
    const p = getProfile(profile);
    const rungs = new Set([
      ...ROLES.filter((r) => p.roles[r].enabled).flatMap((r) => p.roles[r].rungs),
      ...Object.values(p.failover),
    ]);
    for (const rung of rungs) {
      if (!tryParseRung(rung)) continue;
      const canonical = rungInfo(c, rung).canonical;
      if (!gone.includes(canonical)) continue;
      const s = scoresOf(c, canonical);
      if (!s) out.push({ profile, rung, dims: [], unscored: true });
      else if (s.inferred.length) out.push({ profile, rung, dims: s.inferred, unscored: false });
    }
  }
  return out;
}

/** Spec 1.2 §6.4 `--suggest`: the rung, in canonical form, and its three nearest stand-ins. */
export function suggestFor(rung: string): { canonical: string; lacking: Dim[]; suggestions: Suggestion[] } {
  const c = loadCatalog({ timings: false });
  const canonical = canonicalRung(rung);
  const s = scoresOf(c, canonical);
  return {
    canonical,
    lacking: s ? s.inferred : [],
    suggestions: suggestStandIns(c, canonical),
  };
}

/**
 * Spec 1.2 §6.4 `--clear`: removes the user's treat-like for `rung`, naming first the profile rungs it
 * leaves on an inferred stand-in. A shipped treat-like is not the user's to remove.
 */
export async function clearTreatLike(
  rung: string,
): Promise<{ rung: string; like: string; left: LeftOnStandIn[] }> {
  const canonical = canonicalRung(rung);
  const like = readOverride().treatLike[canonical];
  if (!like)
    throw new CatherdError("E_INPUT_INVALID", `${canonical} has no treat-like of yours to clear`, {
      fix: "catherd catalog list shows each rung's treat-like; a shipped one is not yours to clear",
    });
  const left = leftOnStandIns([canonical]);
  await removeTreatLikes([canonical]);
  return { rung: canonical, like, left };
}

/** Spec 1.2 §6.4 `--reset`: removes every treat-like of the user's, naming first the rungs left on a stand-in. */
export async function resetTreatLikes(): Promise<{ removed: [string, string][]; left: LeftOnStandIn[] }> {
  const left = leftOnStandIns("all");
  return { removed: await removeTreatLikes("all"), left };
}
