import { z } from "zod";
import type { BackendAdapter } from "../adapters/backend.ts";
import type { HostContext } from "../domain/host.ts";
import { BILLING_MODES } from "../domain/cost.ts";
import { pairOf } from "../domain/catalog.ts";
import { NOTIFY, roleTimeouts } from "../domain/profile.ts";
import { ACCESS } from "../domain/record.ts";
import { DEFAULT_ACCESS, ROLES, type Role } from "../domain/roles.ts";
import { catalogQuery, loadCatalog, shippedModels } from "./catalog-service.ts";
import { adapterFor } from "../adapters/registry.ts";
import { ADAPTER_IDS } from "../domain/ids.ts";
import { backendChecks, usedBackends } from "./doctor-backends.ts";
import { indexCheck } from "./doctor-checks.ts";
import type { Deps } from "./ports.ts";
import { cachedProbe } from "./probe-cache.ts";
import { activeName, profileFor, readConfig, readProjects } from "./profile-store.ts";

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
  /** the name of the newer version that hides this model on its backend by default; null when it is current */
  newer: z.string().nullable(),
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
/** Every profile setting, resolved (defaults filled): what the profile editor starts from. */
export const SettingsSchema = z.object({
  budget: z.object({
    minutes: z.number().optional(),
    tokens: z.number().optional(),
    usd: z.number().optional(),
  }),
  timeouts: z.object({ idleMin: z.number(), wallMin: z.number() }),
  failover: z.record(z.string(), z.string()),
  maxEffort: z.record(z.string(), z.string()),
  heavy: z.union([z.number().int(), z.literal("cpus/2")]),
  memory: z.object({ reserveMb: z.number(), perMilestoneMb: z.number(), floorMb: z.number() }),
  preflightConfirm: z.boolean(),
  landAutoMerge: z.boolean(),
  notify: z.array(z.enum(NOTIFY)),
  billing: z.record(z.string(), z.enum(BILLING_MODES)),
  isolated: z.record(z.string(), z.boolean()),
});
export const SetupViewSchema = z.object({
  repo: z.string().nullable(),
  host: z.enum(["claude-code", "codex", "unknown"]),
  /** every bound repo, plus the one the panel was asked about */
  repos: z.array(z.object({ path: z.string(), profile: z.string() })),
  profile: z.object({
    name: z.string(),
    active: z.string(),
    profiles: z.array(z.string()),
    bindings: z.record(z.string(), z.string()),
  }),
  /** when the oldest backend probe shown was taken */
  probedAt: z.string().nullable(),
  /** a backend probe outlived the wait and still runs; ask again to see it */
  pending: z.boolean(),
  settings: SettingsSchema,
  notifyUrl: z.string().nullable(),
  /** the stored document, sent back with a save as `expect` */
  doc: z.record(z.string(), z.unknown()),
  catalog: CheckSchema,
  backends: z.array(CheckSchema),
  issues: z.object({ errors: z.array(IssueSchema), warnings: z.array(IssueSchema) }),
  roles: z.array(
    z.object({
      role: z.enum(ROLES),
      enabled: z.boolean(),
      access: z.enum(ACCESS),
      network: z.boolean(),
      /** the role's own timeouts over the profile's; null when it sets none */
      timeouts: z.object({ idleMin: z.number(), wallMin: z.number() }).nullable(),
      /** the profile leaves this role's rungs to the session's host, which the panel cannot see */
      hostSet: z.boolean(),
      rungs: z.array(z.object({ rung: z.string(), intelligence: z.number().nullable() })),
      offered: z.array(IndexedPairSchema),
    }),
  ),
});
export type SetupView = z.infer<typeof SetupViewSchema>;

/** How long Setup waits for a cold backend probe before it answers with "checking" and lets the probe finish;
 * `probe` is a seam for tests. */
export const setupProbes = { waitMs: 1500, probe: cachedProbe };

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
export async function setupView(
  deps: Deps,
  repo: string | null,
  o?: { fresh?: boolean },
): Promise<SetupView> {
  const unknown = deps.host.host === "unknown";
  const profiles = (unknown ? deps.profiles.withHost?.(() => READ_AS) : undefined) ?? deps.profiles;
  const g = profiles.get(undefined, repo);
  const p = profileFor(repo, unknown ? READ_AS.host : deps.host.host);
  const issues = profiles.validate(undefined, repo);
  const hostSetOf = hostSetRoles(deps, repo);
  const hostSet = (role: Role): boolean => hostSetOf.has(role);
  const catalog = loadCatalog({ repo: repo ?? undefined });
  const intelligence = (rung: string) => pairOf(catalog, rung)?.intelligence ?? null;
  const probedAt: string[] = [];
  // Every probe starts at once and shares one deadline; one that outlives it is shown as "checking" and finishes
  // behind the answer, into the cache the next read serves.
  const started = new Map<string, ReturnType<typeof cachedProbe>>();
  const used = usedBackends([p]);
  for (const id of ADAPTER_IDS) {
    // backendChecks does not probe a headless Claude the Codex host's profile never uses
    if (deps.host.host === "codex" && id === "claude-code" && !used.has(id)) continue;
    const a = adapterFor(id);
    if (a) started.set(id, setupProbes.probe(a, { force: o?.fresh }));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), setupProbes.waitMs);
  });
  const late = new Set<string>();
  const probe = async (a: BackendAdapter) => {
    const r = await Promise.race([started.get(a.id) ?? setupProbes.probe(a, { force: o?.fresh }), deadline]);
    if (r === null) {
      late.add(a.id);
      return { installed: true, version: null, versionOk: true, loggedIn: null, problems: [] };
    }
    probedAt.push(r.probedAt);
    return r;
  };
  const checked = await backendChecks(used, [p], undefined, deps.host.host, probe, false).finally(() =>
    clearTimeout(timer),
  );
  const backends = checked.map((c) =>
    late.has(c.id.replace(/^backend:/, ""))
      ? {
          id: c.id,
          label: c.label,
          state: "info" as const,
          word: "checking",
          detail: "still checking this backend",
        }
      : c,
  );
  const bindings = readProjects().bindings;
  const v = g.profile;
  return {
    repo,
    host: deps.host.host,
    repos: [
      ...Object.entries(bindings).map(([path, profile]) => ({ path, profile })),
      ...(repo !== null && !(repo in bindings) ? [{ path: repo, profile: activeName(repo) }] : []),
    ],
    profile: { name: g.here, active: g.active, profiles: g.profiles, bindings },
    probedAt: probedAt.toSorted()[0] ?? null,
    pending: late.size > 0,
    settings: {
      budget: v.budget,
      timeouts: v.timeouts,
      failover: v.failover,
      maxEffort: v.maxEffort ?? {},
      heavy: v.heavy,
      memory: v.limits.memory,
      preflightConfirm: v.preflight.confirm,
      landAutoMerge: v.land.autoMerge,
      notify: v.notify as (typeof NOTIFY)[number][],
      billing: v.billing as Record<string, (typeof BILLING_MODES)[number]>,
      isolated: v.isolated as Record<string, boolean>,
    },
    notifyUrl: readConfig().notify?.url ?? null,
    doc: { ...profiles.raw?.(undefined, repo) },
    catalog: indexCheck(),
    backends,
    issues: { errors: issues.errors, warnings: issues.warnings },
    roles: ROLES.map((role) => {
      const r = g.profile.roles[role];
      const offered = new Map<string, z.infer<typeof IndexedPairSchema>>();
      const query = { role, older: true, limit: 1000, repo: repo ?? undefined };
      for (const m of catalogQuery(query, g.profile.billing).models) {
        const by = m.supersededBy;
        const newer = by === null ? null : (shippedModels().families.find((f) => f.id === by)?.name ?? by);
        for (const x of m.rungs) offered.set(x.rung, { ...x, newer });
      }
      return {
        role,
        enabled: r?.enabled ?? false,
        access: r?.access ?? DEFAULT_ACCESS[role],
        network: r?.network !== false,
        timeouts: r?.timeouts ? roleTimeouts(v, r) : null,
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
