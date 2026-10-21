import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DiscoveredModel } from "../adapters/backend.ts";
import { discovered, listingRepo, readDiscovery, writeDiscovery } from "../adapters/discovery.ts";
import { adapterFor } from "../adapters/registry.ts";
import "../adapters/all.ts";
import {
  buildCatalog,
  type Catalog,
  capableFor,
  type Family,
  type ModelsFile,
  ModelsFileSchema,
  type Pair,
  rungInfo,
} from "../domain/catalog.ts";
import { type BillingMode, type Cost, costOf, DEFAULT_BILLING } from "../domain/cost.ts";
import { errorMessage } from "../domain/errors.ts";
import { ADAPTER_IDS, tryParseRung } from "../domain/ids.ts";
import { ROLES, type Role } from "../domain/roles.ts";
import { assetPath } from "../infra/assets.ts";
import { log } from "../infra/log.ts";
import { withFileLock } from "../infra/filelock.ts";
import { indexPath } from "../infra/paths.ts";
import { type IndexFile, IndexFileSchema } from "../domain/slopalytics.ts";
import { fetchProxy, readIndexFile, writeIndexFile } from "../infra/slopalytics.ts";
import { PRIVATE_DIR, readVersioned } from "../infra/store.ts";
import type { CatalogFilter } from "./ports.ts";
import { type EvidenceTable, evidenceLine, evidenceOf, runEvidence } from "./run-evidence.ts";

const DAY_MS = 24 * 3_600_000;

let models: ModelsFile | null = null;
export const shippedModels = (): ModelsFile =>
  (models ??= readVersioned(assetPath("catalog/models.json"), ModelsFileSchema, 1));

/**
 * Every backend's last listing (spec §3.5 `<data>/discovery/<backend>.json`); for a backend listed per
 * repository, its listing in `repo` (none without one).
 */
function listedModels(repo?: string): Catalog["listed"] {
  const out: Catalog["listed"] = {};
  for (const id of ADAPTER_IDS) {
    const d = readDiscovery(id, listingRepo(id, repo));
    if (d) out[id] = { fetchedAt: d.fetchedAt, models: d.models };
  }
  return out;
}

const RUN_INDEX = "slopalytics.json";

/**
 * The shipped families on the Slopalytics index (the run's own pin when `runDir` holds one, else the machine's),
 * with every listing (in `repo` for a per-repo backend).
 */
export function loadCatalog(o: { repo?: string; runDir?: string } = {}): Catalog {
  const pin = o.runDir === undefined ? null : join(o.runDir, RUN_INDEX);
  // a missing pin falls back to the machine's index; one that exists but cannot be read is an error, not a fallback
  const pinned = pin !== null && existsSync(pin) ? readVersioned(pin, IndexFileSchema, 1) : null;
  return buildCatalog({
    models: shippedModels(),
    index: pinned ?? readIndexFile(indexPath()),
    listed: listedModels(o.repo),
  });
}

/**
 * What a run starts on: the index refreshed if it is due, read once, with the catalog built on exactly that
 * read, so the start check and the pin written after it cannot disagree.
 */
export async function startIndex(repo: string): Promise<{ catalog: Catalog; index: IndexFile | null }> {
  await refreshIndex({ auto: true });
  const index = readIndexFile(indexPath());
  return { catalog: buildCatalog({ models: shippedModels(), index, listed: listedModels(repo) }), index };
}

/** Pins `index` into the run: later routes of the run read it, whatever the machine's index becomes. */
export function writeRunIndex(runDir: string, index: IndexFile | null): void {
  if (index) writeIndexFile(join(runDir, RUN_INDEX), index);
}

export interface Refreshed {
  backend: string;
  models: number;
  fetchedAt: string | null;
  error?: string;
  /** the command that fixes `error`, when the backend's probe names one */
  fix?: string;
}

/** Spec §5.2: `init`, `doctor` and `catherd catalog refresh` list every backend's models now. */
export async function refreshDiscovery(
  o: { backends?: string[]; now?: number; repo?: string } = {},
): Promise<Refreshed[]> {
  const out: Refreshed[] = [];
  for (const id of o.backends ?? ADAPTER_IDS) {
    const adapter = adapterFor(id);
    if (!adapter) continue;
    const repo = listingRepo(id, o.repo);
    let listed: DiscoveredModel[] = [];
    try {
      listed = await adapter.listModels(repo);
    } catch (e) {
      out.push({
        backend: id,
        models: 0,
        fetchedAt: readDiscovery(id, repo)?.fetchedAt ?? null,
        error: String(e),
      });
      continue;
    }
    if (listed.length === 0) {
      // a CLI that is missing (or not ready) lists nothing: say why, and keep only a listing that exists
      const problem = (await adapter.probe().catch(() => null))?.problems[0];
      const fetchedAt = readDiscovery(id, repo)?.fetchedAt ?? null;
      out.push({
        backend: id,
        models: 0,
        fetchedAt,
        error: `${problem?.message ?? "listed no models"}${fetchedAt === null ? "" : "; the previous listing is kept"}`,
        ...(problem?.fix ? { fix: problem.fix } : {}),
      });
      continue;
    }
    const f = writeDiscovery(id, listed, o.now, repo);
    out.push({ backend: id, models: f.models.length, fetchedAt: f.fetchedAt });
  }
  return out;
}

const tried = new Map<string, number>();
/** Forget which backends (and repositories) this process already tried to list (tests). */
export const resetFreshen = (): void => tried.clear();

/**
 * Spec §5.2: `route` lists a backend again at most daily. A backend this process failed to list is not
 * tried again for an hour, so a missing or wedged CLI never slows every route. Due backends are listed
 * in parallel, so the slowest listing bounds the wait, not their sum. A backend listed per repository is
 * listed, cached and backed off in `repo`.
 */
export async function freshenDiscovery(rungs: string[], now = Date.now(), repo?: string): Promise<void> {
  const backends = new Set<string>();
  for (const r of rungs) {
    const b = tryParseRung(r)?.backend;
    if (b) backends.add(b === "claude" ? "claude-code" : b); // validate reports a bad rung
  }
  const due: { backend: string; listing: Promise<unknown> }[] = [];
  for (const b of backends) {
    const adapter = adapterFor(b);
    const where = listingRepo(b, repo);
    const key = where === undefined ? b : `${b} ${where}`;
    if (!adapter || now - (tried.get(key) ?? Number.NEGATIVE_INFINITY) < 3_600_000) continue;
    const cached = readDiscovery(b, where);
    if (cached && now - Date.parse(cached.fetchedAt) < DAY_MS) continue;
    tried.set(key, now);
    due.push({
      backend: b,
      listing: discovered(b, () => adapter.listModels(where), { maxAgeMs: DAY_MS, now, repo: where }),
    });
  }
  // a failed listing keeps the last one (and the hour's backoff above); the log says why it failed
  const settled = await Promise.allSettled(due.map((d) => d.listing));
  settled.forEach((r, i) => {
    if (r.status === "rejected")
      log("debug", "discovery", { backend: due[i]?.backend, error: errorMessage(r.reason) });
  });
}

/** The backend a billing or harness key bills or isolates: `opencode-go` is a provider of the opencode backend. */
export const backendOfKey = (key: string) => (key === "opencode-go" ? "opencode" : key);

/** One indexed pair as `catalog_query` and `catalog list` show it. */
export interface IndexedPair {
  rung: string;
  intelligence: number;
  price: Pair["price"];
  speed: number | null;
  context: number | null;
  cost: Cost;
  /** spec 1.2 §8: catherd's own runs on it, over every kind; never used for routing */
  evidence: string | null;
}

export interface CatalogModel {
  id: string;
  name: string | null;
  backend: string;
  model: string;
  billing: string;
  efforts: string[];
  capabilities: Family["capabilities"] | null;
  roles: Role[];
  listed: boolean | null;
  notes: Record<string, string>;
  rungs: IndexedPair[];
}

function pairsOf(
  c: Catalog,
  backend: string,
  model: string,
  billing: Partial<Record<string, BillingMode>>,
  evidence: EvidenceTable,
): IndexedPair[] {
  const probe = rungInfo(c, `${backend}:${model}#default`);
  const efforts = [...new Set([...probe.efforts, "default"])];
  return efforts
    .flatMap((effort) => {
      const rung = `${backend}:${model}#${effort}`;
      const info = rungInfo(c, rung);
      const pair = info.pair;
      if (!pair) return [];
      return [
        {
          rung,
          intelligence: pair.intelligence,
          price: pair.price,
          speed: pair.speed,
          context: info.context,
          cost: costOf(info.family, pair, effort, billing[info.key] ?? DEFAULT_BILLING[info.key]),
          evidence: evidenceLine(evidenceOf(evidence, info.canonical)),
        },
      ];
    })
    .sort((a, b) => a.intelligence - b.intelligence);
}

/**
 * Spec §4.8 `catalog_query`: the indexed pairs of the shipped families on each backend, and of the listed models
 * catherd has no family for; a model with no indexed pair is not listed. A backend listed per repository as it
 * is listed in `f.repo` (a git toplevel), as `route` reads it.
 */
export function catalogQuery(
  f: CatalogFilter,
  billing: Partial<Record<string, BillingMode>> = {},
): { total: number; models: CatalogModel[] } {
  const c = loadCatalog({ repo: f.repo });
  const evidence = runEvidence(c);
  const rows: CatalogModel[] = [];
  const known = new Set<string>();
  const entry = (backend: string, model: string, fam: Family | null) => {
    const rungs = pairsOf(c, backend, model, billing, evidence);
    if (rungs.length === 0) return;
    const probe = rungInfo(c, `${backend}:${model}#default`);
    rows.push({
      id: fam?.id ?? model,
      name: fam?.name ?? null,
      backend,
      model,
      billing: probe.key,
      efforts: rungs.map((r) => r.rung.slice(r.rung.lastIndexOf("#") + 1)),
      capabilities: fam?.capabilities ?? null,
      roles: ROLES.filter((r) => capableFor(c, probe, r)),
      listed: probe.listed,
      notes: fam?.notes ?? {},
      rungs,
    });
  };
  for (const fam of c.families)
    for (const [key, on] of Object.entries(fam.on)) {
      const backends = key === "claude-code" ? ["claude", "claude-code"] : [backendOfKey(key)];
      for (const b of backends) entry(b, on.id, fam);
      known.add(`${backendOfKey(key)}:${on.id}`);
    }
  for (const [backend, l] of Object.entries(c.listed))
    for (const m of l.models) if (!known.has(`${backend}:${m.id}`)) entry(backend, m.id, null);
  const needle = f.text?.toLowerCase();
  const kept = rows
    .filter(
      (m) =>
        (!f.role || m.roles.includes(f.role)) &&
        (!f.backend || m.backend === f.backend || m.billing === f.backend) &&
        (!needle || `${m.id} ${m.model} ${m.name ?? ""}`.toLowerCase().includes(needle)),
    )
    .sort((a, b) => a.id.localeCompare(b.id) || a.backend.localeCompare(b.backend));
  return { total: kept.length, models: kept.slice(0, f.limit) };
}

export interface IndexStatus {
  fetchedAt: string | null;
  checkedAt: string | null;
  pairs: number;
  error: string | null;
}

/** How long a fetched index is trusted before the next automatic refresh. */
export const INDEX_TTL_MS = 3_600_000;

export function indexStatus(): IndexStatus {
  const f = readIndexFile(indexPath());
  return {
    fetchedAt: f?.fetchedAt ?? null,
    checkedAt: f?.checkedAt ?? null,
    pairs: f?.models.length ?? 0,
    error: f?.error?.message ?? null,
  };
}

/**
 * Keeps `<data>/slopalytics.json` fresh: fetched when its last check is over an hour old (or `force`), the last
 * good answer kept when the proxy fails and the error recorded beside it. Never throws. An `auto` refresh
 * (MCP boot, `init`, run start) fetches nothing under `CATHERD_NO_SYNC=1`.
 */
export async function refreshIndex(
  o: { force?: boolean; auto?: boolean; fetch?: typeof fetch; now?: number } = {},
): Promise<IndexStatus> {
  if (o.auto && process.env.CATHERD_NO_SYNC === "1") return indexStatus();
  const now = o.now ?? Date.now();
  // read, fetch and write run under one lock: a refresh that fails reads the file as the one before it left it
  try {
    mkdirSync(dirname(indexPath()), { recursive: true, mode: PRIVATE_DIR });
    await withFileLock(indexPath(), () => refreshLocked(o, now), { timeoutMs: 30_000 });
  } catch (e) {
    log("debug", "catalog", { index: errorMessage(e) });
  }
  return indexStatus();
}

async function refreshLocked(o: { force?: boolean; fetch?: typeof fetch }, now: number): Promise<void> {
  const prev = readIndexFile(indexPath());
  if (!o.force && prev && now - Date.parse(prev.checkedAt) < INDEX_TTL_MS) return;
  const at = new Date(now).toISOString();
  try {
    const got = await fetchProxy({ fetch: o.fetch });
    writeIndexFile(indexPath(), {
      schema: 1,
      checkedAt: at,
      fetchedAt: got.fetchedAt,
      error: null,
      models: got.models,
    });
  } catch (e) {
    const message = errorMessage(e);
    log("debug", "catalog", { index: message });
    writeIndexFile(indexPath(), {
      schema: 1,
      checkedAt: at,
      fetchedAt: prev?.fetchedAt ?? null,
      error: { at, message },
      models: prev?.models ?? [],
    });
  }
}
