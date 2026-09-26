import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ADAPTER_IDS, type DiscoveredModel } from "../adapters/backend.ts";
import { discovered, readDiscovery, writeDiscovery } from "../adapters/discovery.ts";
import { adapterFor } from "../adapters/registry.ts";
import "../adapters/all.ts";
import {
  buildCatalog,
  type Catalog,
  capableFor,
  DIMS,
  type Family,
  type ModelsFile,
  ModelsFileSchema,
  type Override,
  OverrideSchema,
  rungInfo,
  type ScoresFile,
  ScoresFileSchema,
  scoresOf,
} from "../domain/catalog.ts";
import { costOf, DEFAULT_BILLING, type BillingMode } from "../domain/cost.ts";
import { CatherdError } from "../domain/errors.ts";
import { parseRung } from "../domain/ids.ts";
import type { Kind } from "../domain/lane.ts";
import { currentRoute } from "../domain/route.ts";
import { ROLES, type Role } from "../domain/roles.ts";
import { assetPath } from "../infra/assets.ts";
import { withFileLock } from "../infra/filelock.ts";
import { configDir } from "../infra/paths.ts";
import { readVersioned, writeJsonAtomic } from "../infra/store.ts";
import type { CatalogFilter } from "./ports.ts";
import { listRuns, readRecords, readRoutes } from "./run-store.ts";

const DAY_MS = 24 * 3_600_000;
/** Spec §5.2: `secs_per_task` counts once a rung has this many of the user's own runs. */
export const MIN_SAMPLES = 5;

let models: ModelsFile | null = null;
let scores: ScoresFile | null = null;
export const shippedModels = (): ModelsFile =>
  (models ??= readVersioned(assetPath("catalog/models.json"), ModelsFileSchema, 1));
export const shippedScores = (): ScoresFile =>
  (scores ??= readVersioned(assetPath("catalog/scores.json"), ScoresFileSchema, 1));

export const overridePath = (): string => join(configDir(), "catalog.override.json");

export function readOverride(): Override {
  const file = overridePath();
  return existsSync(file) ? readVersioned(file, OverrideSchema, 1) : OverrideSchema.parse({});
}

/** Every backend's last listing (spec §3.5 `<data>/discovery/<backend>.json`). */
export function listedModels(): Catalog["listed"] {
  const out: Catalog["listed"] = {};
  for (const id of ADAPTER_IDS) {
    const d = readDiscovery(id);
    if (d) out[id] = { fetchedAt: d.fetchedAt, models: d.models };
  }
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/**
 * Spec §5.2: the median seconds of the user's own successful runs per canonical rung and lane kind
 * (`|*` over every kind), kept only with at least MIN_SAMPLES runs.
 */
export function measuredSecs(base: Catalog): Catalog["secs"] {
  const groups = new Map<string, number[]>();
  const add = (k: string, secs: number) => groups.set(k, [...(groups.get(k) ?? []), secs]);
  for (const run of listRuns().runs) {
    const routes = readRoutes(run);
    for (const r of readRecords(run).records) {
      if (r.status !== "ok") continue;
      let canonical: string;
      try {
        canonical = rungInfo(base, r.rung).canonical;
      } catch {
        continue;
      }
      const kind: Kind | null = r.lane ? (currentRoute(routes, r.lane)?.kind ?? null) : null;
      add(`${canonical}|*`, r.secs);
      if (kind) add(`${canonical}|${kind}`, r.secs);
    }
  }
  const secs: Catalog["secs"] = {};
  for (const [k, xs] of groups) if (xs.length >= MIN_SAMPLES) secs[k] = median(xs);
  return secs;
}

/** The shipped catalog with every listing, the user's override and, unless `timings: false`, own timings. */
export function loadCatalog(o: { timings?: boolean } = {}): Catalog {
  const base = buildCatalog({
    models: shippedModels(),
    scores: shippedScores(),
    override: readOverride(),
    listed: listedModels(),
  });
  return o.timings === false ? base : { ...base, secs: measuredSecs(base) };
}

export interface Refreshed {
  backend: string;
  models: number;
  fetchedAt: string | null;
  error?: string;
}

/** Spec §5.2: `init`, `doctor` and `catherd catalog refresh` list every backend's models now. */
export async function refreshDiscovery(o: { backends?: string[]; now?: number } = {}): Promise<Refreshed[]> {
  const out: Refreshed[] = [];
  for (const id of o.backends ?? ADAPTER_IDS) {
    const adapter = adapterFor(id);
    if (!adapter) continue;
    let listed: DiscoveredModel[] = [];
    try {
      listed = await adapter.listModels();
    } catch (e) {
      out.push({ backend: id, models: 0, fetchedAt: readDiscovery(id)?.fetchedAt ?? null, error: String(e) });
      continue;
    }
    if (listed.length === 0) {
      out.push({
        backend: id,
        models: 0,
        fetchedAt: readDiscovery(id)?.fetchedAt ?? null,
        error: "listed no models; the previous listing is kept",
      });
      continue;
    }
    const f = writeDiscovery(id, listed, o.now);
    out.push({ backend: id, models: f.models.length, fetchedAt: f.fetchedAt });
  }
  return out;
}

const tried = new Map<string, number>();
/** Forget which backends this process already tried to list (tests). */
export const resetFreshen = (): void => tried.clear();

/**
 * Spec §5.2: `route` lists a backend again at most daily. A backend this process failed to list is not
 * tried again for an hour, so a missing or wedged CLI never slows every route. Due backends are listed
 * in parallel, so the slowest listing bounds the wait, not their sum.
 */
export async function freshenDiscovery(rungs: string[], now = Date.now()): Promise<void> {
  const backends = new Set<string>();
  for (const r of rungs) {
    try {
      const b = parseRung(r).backend;
      backends.add(b === "claude" ? "claude-code" : b);
    } catch {}
  }
  const due: Promise<unknown>[] = [];
  for (const b of backends) {
    const adapter = adapterFor(b);
    if (!adapter || now - (tried.get(b) ?? Number.NEGATIVE_INFINITY) < 3_600_000) continue;
    const cached = readDiscovery(b);
    if (cached && now - Date.parse(cached.fetchedAt) < DAY_MS) continue;
    tried.set(b, now);
    due.push(discovered(b, () => adapter.listModels(), { maxAgeMs: DAY_MS, now }));
  }
  // a failed listing keeps the last one (and the hour's backoff above)
  await Promise.allSettled(due);
}

/** A rung given as `backend:model#effort` or as a canonical `model#effort`, in canonical form. */
function canonicalOf(c: Catalog, rung: string): string {
  if (!rung.includes(":")) return rung;
  return rungInfo(c, rung).canonical;
}

/** Spec §5.2 "treat like": the user maps an unscored rung onto a scored one in catalog.override.json. */
export async function saveTreatLike(rung: string, like: string): Promise<{ rung: string; like: string }> {
  const c = loadCatalog({ timings: false });
  const from = canonicalOf(c, rung);
  const to = canonicalOf(c, like);
  if (!c.scores[to])
    throw new CatherdError("E_CONFIG_INVALID", `${like} has no scores of its own to lend`, {
      fix: "treat it like a scored rung; catalog_query lists them",
    });
  if (from === to)
    throw new CatherdError("E_CONFIG_INVALID", `${rung} cannot be treated like itself`, {
      fix: "name a different, scored rung",
    });
  mkdirSync(dirname(overridePath()), { recursive: true });
  await withFileLock(overridePath(), () => {
    const cur = readOverride();
    writeJsonAtomic(overridePath(), { ...cur, schema: 1, treatLike: { ...cur.treatLike, [from]: to } });
  });
  return { rung: from, like: to };
}

const backendOfKey = (key: string) => (key === "opencode-go" ? "opencode" : key);

function rungRows(
  c: Catalog,
  backend: string,
  model: string,
  efforts: string[],
  billing: Partial<Record<string, BillingMode>>,
) {
  return (efforts.length ? efforts : ["default"]).map((effort) => {
    const rung = `${backend}:${model}#${effort}`;
    const info = rungInfo(c, rung);
    const s = scoresOf(c, info.canonical);
    const scored: Record<string, { value: number; benchmark: string; confidence: string }> = {};
    for (const d of DIMS) {
      const r = s?.records[d];
      if (r)
        scored[d] = {
          value: r.value,
          benchmark: `${r.benchmark} ${r.version}`,
          confidence: s?.via ? "inferred" : r.confidence,
        };
    }
    const like = c.treatLike[info.canonical] ?? null;
    return {
      rung,
      enabled: s !== null,
      ...(s === null ? { why: "unscored: map it with catherd catalog treat-like <rung> <scored rung>" } : {}),
      scores: scored,
      treatLike: s?.via ? like : null,
      cost: costOf(info.family, effort, billing[info.key] ?? DEFAULT_BILLING[info.key]),
    };
  });
}

export interface CatalogModel {
  id: string;
  name: string | null;
  backend: string;
  model: string;
  billing: string;
  efforts: string[];
  context: number | null;
  capabilities: Family["capabilities"] | null;
  roles: Role[];
  listed: boolean | null;
  notes: Record<string, string>;
  rungs: ReturnType<typeof rungRows>;
}

/** Spec §4.8 `catalog_query`: shipped families on each backend, plus listed models catherd cannot score. */
export function catalogQuery(
  f: CatalogFilter,
  billing: Partial<Record<string, BillingMode>> = {},
): { total: number; models: CatalogModel[] } {
  const c = loadCatalog({ timings: false });
  const rows: CatalogModel[] = [];
  const known = new Set<string>();
  const entry = (backend: string, model: string, fam: Family | null): CatalogModel => {
    const probe = rungInfo(c, `${backend}:${model}#default`);
    return {
      id: fam?.id ?? model,
      name: fam?.name ?? null,
      backend,
      model,
      billing: probe.key,
      efforts: probe.efforts,
      context: probe.context,
      capabilities: fam?.capabilities ?? null,
      roles: ROLES.filter((r) => capableFor(c, probe, r)),
      listed: probe.listed,
      notes: fam?.notes ?? {},
      rungs: rungRows(c, backend, model, probe.efforts, billing),
    };
  };
  for (const fam of c.families)
    for (const [key, on] of Object.entries(fam.on)) {
      const backends = key === "claude-code" ? ["claude", "claude-code"] : [backendOfKey(key)];
      for (const b of backends) rows.push(entry(b, on.id, fam));
      known.add(`${backendOfKey(key)}:${on.id}`);
    }
  for (const [backend, l] of Object.entries(c.listed))
    for (const m of l.models) if (!known.has(`${backend}:${m.id}`)) rows.push(entry(backend, m.id, null));
  const needle = f.text?.toLowerCase();
  const kept = rows
    .filter(
      (m) =>
        (!f.role || m.roles.includes(f.role)) &&
        (!f.backend || m.backend === f.backend || m.billing === f.backend) &&
        (!needle || `${m.id} ${m.model} ${m.name ?? ""}`.toLowerCase().includes(needle)) &&
        (!f.scoredOnly || m.rungs.some((r) => r.enabled)),
    )
    .sort(
      (a, b) =>
        Number(b.rungs.some((r) => r.enabled)) - Number(a.rungs.some((r) => r.enabled)) ||
        a.id.localeCompare(b.id) ||
        a.backend.localeCompare(b.backend),
    );
  return { total: kept.length, models: kept.slice(0, f.limit) };
}
