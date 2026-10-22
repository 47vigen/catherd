import { z } from "zod";
import { CatherdError } from "../domain/errors.ts";
import type { HostContext } from "../domain/host.ts";
import { BILLING_MODES } from "../domain/cost.ts";
import { pairOf } from "../domain/catalog.ts";
import { ROLES, type Role } from "../domain/roles.ts";
import { catalogQuery, loadCatalog, type IndexedPair } from "./catalog-service.ts";
import { backendChecks, usedBackends } from "./doctor-backends.ts";
import { indexCheck } from "./doctor-checks.ts";
import type { Deps, ProfileSaved } from "./ports.ts";
import { profileFor } from "./profile-store.ts";

// The panel's Setup page (spec 2.0 decision 25): backends with their doctor status, and each role's rungs picked
// from the indexed pairs. Every write goes through the ProfilePort.

export const CheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  state: z.enum(["ok", "warn", "fail", "skip", "info"]),
  word: z.string(),
  detail: z.string(),
  fix: z.string().optional(),
});
export const IssueSchema = z.object({ path: z.string(), message: z.string(), fix: z.string().optional() });
export const IndexedPairSchema = z.object({
  rung: z.string(),
  intelligence: z.number(),
  price: z.object({ input: z.number(), output: z.number() }).nullable(),
  speed: z.number().nullable(),
  context: z.number().nullable(),
  cost: z.object({
    tier: z.union([z.literal(0), z.literal(1)]),
    value: z.number().nullable(),
    mode: z.enum(BILLING_MODES),
  }),
  evidence: z.string().nullable(),
});
export const ProfileSavedSchema = z.object({
  saved: z.boolean(),
  errors: z.array(IssueSchema),
  warnings: z.array(IssueSchema),
  diff: z.array(z.object({ path: z.string(), before: z.unknown(), after: z.unknown() })),
  linked: z.array(z.string()),
  pruned: z.array(z.string()),
  newSessionNeededFor: z.array(z.string()),
});
export const SetupViewSchema = z.object({
  repo: z.string().nullable(),
  profile: z.object({ name: z.string(), active: z.string(), profiles: z.array(z.string()) }),
  catalog: CheckSchema,
  backends: z.array(CheckSchema),
  issues: z.object({ errors: z.array(IssueSchema), warnings: z.array(IssueSchema) }),
  roles: z.array(
    z.object({
      role: z.enum(ROLES),
      enabled: z.boolean(),
      /** the profile leaves this role's rungs to the session's host, which the panel cannot see */
      hostSet: z.boolean(),
      rungs: z.array(z.object({ rung: z.string(), intelligence: z.number().nullable() })),
      offered: z.array(IndexedPairSchema),
    }),
  ),
});
export type SetupView = z.infer<typeof SetupViewSchema>;

/** Read only: a panel with no host lists the host-set roles as such, instead of failing the whole list. */
const READ_AS: HostContext = { host: "claude-code", session: null, conflict: null };

/** The roles a profile leaves to the host, when the panel has none: they cannot resolve, so they cannot be saved. */
function hostSetRoles(deps: Deps, repo: string | null): Set<Role> {
  if (deps.host.host !== "unknown") return new Set();
  const profiles = deps.profiles.withHost?.(() => READ_AS) ?? deps.profiles;
  const stored = profiles.raw?.(undefined, repo);
  const g = profiles.get(undefined, repo);
  return new Set(
    ROLES.filter(
      (role) =>
        (role === "architect" || role === "verifier") &&
        stored !== undefined &&
        stored.roles?.[role]?.rungs === undefined &&
        (g.profile.roles[role]?.enabled ?? false),
    ),
  );
}

/** What the Setup page shows: the profile `repo` runs on (the active one without a repo). */
export async function setupView(deps: Deps, repo: string | null): Promise<SetupView> {
  const unknown = deps.host.host === "unknown";
  const profiles = (unknown ? deps.profiles.withHost?.(() => READ_AS) : undefined) ?? deps.profiles;
  const g = profiles.get(undefined, repo);
  const p = profileFor(repo, unknown ? READ_AS.host : deps.host.host);
  const issues = profiles.validate(undefined, repo);
  const hostSetOf = hostSetRoles(deps, repo);
  const hostSet = (role: Role): boolean => hostSetOf.has(role);
  const catalog = loadCatalog({ repo: repo ?? undefined });
  const intelligence = (rung: string) => pairOf(catalog, rung)?.intelligence ?? null;
  return {
    repo,
    profile: { name: g.here, active: g.active, profiles: g.profiles },
    catalog: indexCheck(),
    backends: await backendChecks(usedBackends([p]), [p]),
    issues: { errors: issues.errors, warnings: issues.warnings },
    roles: ROLES.map((role) => {
      const r = g.profile.roles[role];
      const offered = new Map<string, IndexedPair>();
      for (const m of catalogQuery({ role, limit: 1000, repo: repo ?? undefined }, g.profile.billing).models)
        for (const x of m.rungs) offered.set(x.rung, x);
      return {
        role,
        enabled: r?.enabled ?? false,
        hostSet: hostSet(role),
        rungs: (hostSet(role) ? [] : (r?.rungs ?? [])).map((rung) => ({
          rung,
          intelligence: intelligence(rung),
        })),
        offered: [...offered.values()].sort(
          (a, b) => b.intelligence - a.intelligence || a.rung.localeCompare(b.rung),
        ),
      };
    }),
  };
}

/** Unique, rising intelligence with unindexed last; ties keep the previous order, then the pick order. */
export function orderRungs(
  rungs: string[],
  previous: string[],
  intelligence: (r: string) => number | null,
): string[] {
  const at = (list: string[], r: string) => {
    const i = list.indexOf(r);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...new Set(rungs)].sort(
    (a, b) =>
      (intelligence(a) ?? Infinity) - (intelligence(b) ?? Infinity) ||
      at(previous, a) - at(previous, b) ||
      at(rungs, a) - at(rungs, b),
  );
}

/** Saves a role's rungs, in ladder order, through the profile service (its validation is the gate). */
export function setRoleRungs(deps: Deps, repo: string | null, role: Role, rungs: string[]): ProfileSaved {
  if (hostSetRoles(deps, repo).size > 0)
    throw new CatherdError(
      "E_INPUT_INVALID",
      "no orchestration host is known, so the rungs cannot be saved",
      {
        fix: "start the panel with --host codex|claude-code, or run catherd init",
      },
    );
  const current = deps.profiles.get(undefined, repo).profile.roles[role]?.rungs ?? [];
  const catalog = loadCatalog({ repo: repo ?? undefined });
  const ordered = orderRungs(rungs, current, (r) => pairOf(catalog, r)?.intelligence ?? null);
  return deps.profiles.set(undefined, { roles: { [role]: { rungs: ordered } } }, repo);
}
