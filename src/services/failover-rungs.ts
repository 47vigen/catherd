import { claudeBilled, quotaOf } from "../domain/failover.ts";
import { tryParseRung } from "../domain/ids.ts";
import type { Role } from "../domain/roles.ts";
import { standInFor } from "./backends.ts";
import type { Deps } from "./ports.ts";
import { runProfile } from "./run-pin.ts";
import type { Run } from "./run-store.ts";

/**
 * Where a role goes when `rung`'s quota hit a limit (plan 30; 30b widens it to every configured backend): the
 * profile's stand-in for the rung, else another rung of the role's ladder, on a quota that is not `held`; a
 * Claude rung only when nothing else is free. Null when every candidate is held.
 */
export function failoverRung(deps: Deps, run: Run, role: Role, rung: string, held: string[]): string | null {
  const profile = runProfile(deps, run);
  const stand = standInFor(profile.failover, rung, run.meta.repo);
  const candidates = [...new Set([...(stand ? [stand] : []), ...(profile.roles[role]?.rungs ?? [])])]
    .filter((r) => r !== rung)
    .filter((r) => {
      const p = tryParseRung(r);
      return p !== null && !held.includes(quotaOf(p));
    });
  return candidates.find((r) => !claudeBilled(r)) ?? candidates.find(claudeBilled) ?? null;
}
