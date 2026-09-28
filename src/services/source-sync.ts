import { buildCatalog, type Catalog, DIMS } from "../domain/catalog.ts";
import { CatherdError, errorMessage } from "../domain/errors.ts";
import {
  type Derived,
  SOURCE_IDS,
  type SourceId,
  type SourcesFile,
  SourcesFileSchema,
} from "../domain/sources.ts";
import { assetPath } from "../infra/assets.ts";
import { log } from "../infra/log.ts";
import { type AaAnswer, fetchArtificialAnalysis } from "../infra/sources/artificial-analysis.ts";
import { fetchArena } from "../infra/sources/arena.ts";
import {
  readCached,
  readDerived,
  readSyncState,
  tryLockSync,
  writeCached,
  writeDerived,
  writeSyncState,
} from "../infra/sources/cache.ts";
import { fetchEpoch } from "../infra/sources/epoch.ts";
import { rateLimitRemaining, SourceError, type SourceTransport } from "../infra/sources/http.ts";
import { fetchLiteLlm } from "../infra/sources/litellm.ts";
import { fetchModelsDev } from "../infra/sources/models-dev.ts";
import { fetchOpenRouterEndpoints } from "../infra/sources/openrouter-endpoints.ts";
import { fetchOpenRouterModels } from "../infra/sources/openrouter-models.ts";
import { fetchVectara } from "../infra/sources/vectara.ts";
import { readVersioned } from "../infra/store.ts";
import { readOverride, shippedModels, shippedScores } from "./catalog-service.ts";
import { aaKey } from "./credentials.ts";
import { derive, openRouterIds, type RawAnswers } from "./source-derive.ts";

/** Spec 1.2 §3.2: one TTL for every source. */
export const TTL_MS = 12 * 3_600_000;
/** A source whose last attempt failed waits this long before a background sync tries it again. */
const BACKOFF_MS = 3_600_000;
/** How long a foreground sync waits for one already running. */
const LOCK_WAIT_MS = 120_000;

let sourcesFile: SourcesFile | null = null;
/** `catalog/sources.json`: the sources, their licenses and attribution lines, the aliases. */
export const shippedSources = (): SourcesFile =>
  (sourcesFile ??= readVersioned(assetPath("catalog/sources.json"), SourcesFileSchema, 1));

export interface SyncOptions {
  /** ignore the TTL (and a failing source's backoff) */
  force?: boolean;
  /** the MCP server's boot sync: skips when another sync runs, and gives a failing source an hour's rest */
  background?: boolean;
  /** how every source is fetched; tests replace it */
  transport?: SourceTransport;
  /** the Artificial Analysis key; default: the env's, else the saved one */
  aaKey?: string | null;
  now?: () => number;
}

export interface SourceOutcome {
  source: SourceId;
  /** fetched now; fresh (within the TTL); failed (the last good answer kept); skipped (no key, or backing off) */
  state: "fetched" | "fresh" | "failed" | "skipped";
  /** when the answer in the cache was fetched; null when there is none */
  fetchedAt: string | null;
  error?: string;
  detail?: string;
}

export interface SyncReport {
  /** another sync held the lock (a background sync never waits): nothing was done */
  busy: boolean;
  sources: SourceOutcome[];
  /** canonical rungs with no value of their own before this sync and at least one after */
  newlyScored: string[];
  /** the user's treat-likes whose rung now has its own value on every dimension the stand-in lent */
  noLongerNeeded: { rung: string; like: string }[];
  failed: { source: SourceId; error: string }[];
  /** the cross-checks that failed (spec 1.2 §3.5) */
  warnings: string[];
  /** each source's ids no family matched (spec 1.2 §3.4) */
  unmatched: Record<string, string[]>;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The catalog as routing would read it with `derived` as the synced layer. */
const catalogWith = (derived: Derived | null, now: number): Catalog =>
  buildCatalog({
    models: shippedModels(),
    scores: shippedScores(),
    synced: derived?.scores,
    facts: derived?.facts,
    override: readOverride(),
    now,
  });

const scored = (c: Catalog): Set<string> =>
  new Set(Object.entries(c.scores).flatMap(([rung, dims]) => (Object.keys(dims).length ? [rung] : [])));

async function takeLock(background: boolean): Promise<(() => void) | null> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const release = tryLockSync();
    if (release || background) return release;
    if (Date.now() > deadline)
      throw new CatherdError("E_IO_LOCK", "another catalog sync is still running", {
        fix: "wait for it to finish, then run catherd catalog sync again",
      });
    await Bun.sleep(200);
  }
}

/** Every cached answer, as `derive` reads them. */
function cachedAnswers(): RawAnswers {
  const raw: RawAnswers = {};
  for (const id of SOURCE_IDS) {
    const c = readCached(id);
    if (c) raw[id] = { fetchedAt: c.fetchedAt, data: c.data };
  }
  return raw;
}

/**
 * Spec 1.2 §3.2, §3.3: fetches every source whose cached answer is older than the TTL (every source with
 * `force`), all in parallel, and writes each answer atomically with its fetch time. A source that fails keeps
 * its last good answer; the sync records the error and goes on. Then it derives the synced values from every
 * cached answer. One sync runs at a time: a background sync skips when another holds the lock, a foreground
 * one waits for it.
 */
export async function syncSources(o: SyncOptions = {}): Promise<SyncReport> {
  const now = o.now ?? Date.now;
  const release = await takeLock(o.background === true);
  if (!release)
    return {
      busy: true,
      sources: [],
      newlyScored: [],
      noLongerNeeded: [],
      failed: [],
      warnings: [],
      unmatched: {},
    };
  try {
    const before = catalogWith(readDerived(), now());
    const state = readSyncState();
    const key = o.aaKey === undefined ? aaKey() : o.aaKey;
    const t = o.transport ?? {};
    const outcomes = new Map<SourceId, SourceOutcome>();
    const fetchedAt = (id: SourceId) => state.sources[id]?.fetchedAt ?? null;
    const fresh = (id: SourceId) => {
      const at = fetchedAt(id);
      // a cache file that no longer reads (corrupt, or an older schema) is fetched again
      return !o.force && at !== null && now() - Date.parse(at) < TTL_MS && readCached(id) !== null;
    };
    const resting = (id: SourceId) => {
      const s = state.sources[id];
      return o.background && !o.force && s?.error && now() - Date.parse(s.lastAttemptAt) < BACKOFF_MS;
    };

    const run = async (id: SourceId, fetcher: () => Promise<unknown>): Promise<void> => {
      if (fresh(id)) return void outcomes.set(id, { source: id, state: "fresh", fetchedAt: fetchedAt(id) });
      if (resting(id))
        return void outcomes.set(id, {
          source: id,
          state: "skipped",
          fetchedAt: fetchedAt(id),
          detail: "failed within the hour; the next sync tries again",
        });
      const at = now();
      const prev = state.sources[id];
      try {
        const data = await fetcher();
        writeCached(id, data, at);
        const limit = id === "artificial-analysis" ? (data as AaAnswer).rateLimitRemaining : null;
        state.sources[id] = {
          fetchedAt: iso(at),
          lastAttemptAt: iso(at),
          error: null,
          rateLimitRemaining: limit,
        };
        outcomes.set(id, { source: id, state: "fetched", fetchedAt: iso(at) });
      } catch (e) {
        const error = errorMessage(e);
        const limit = e instanceof SourceError ? rateLimitRemaining(e.headers) : null;
        state.sources[id] = {
          fetchedAt: prev?.fetchedAt ?? null,
          lastAttemptAt: iso(at),
          error,
          rateLimitRemaining: limit ?? prev?.rateLimitRemaining ?? null,
        };
        outcomes.set(id, { source: id, state: "failed", fetchedAt: prev?.fetchedAt ?? null, error });
        log(o.background ? "debug" : "warn", "sources", { source: id, error });
      }
    };

    const orModels = run("openrouter-models", () => fetchOpenRouterModels(t));
    const jobs: Promise<void>[] = [
      orModels,
      run("models-dev", () => fetchModelsDev(t)),
      run("litellm", () => fetchLiteLlm(t)),
      run("arena", () => fetchArena(t)),
      run("vectara", () => fetchVectara(t)),
      run("epoch", () => fetchEpoch(t)),
      // plan 13 R-H: one request per catalog family OpenRouter lists, so it waits for OpenRouter's model list
      orModels.then(() =>
        run("openrouter-endpoints", async () => {
          const list = readCached("openrouter-models");
          if (!list) throw new Error("no OpenRouter model list to take the ids from");
          const ids = openRouterIds(list.data, { models: shippedModels(), sources: shippedSources() });
          return fetchOpenRouterEndpoints(ids, t);
        }),
      ),
    ];
    if (key) jobs.push(run("artificial-analysis", () => fetchArtificialAnalysis(key, t)));
    else
      outcomes.set("artificial-analysis", {
        source: "artificial-analysis",
        state: "skipped",
        fetchedAt: fetchedAt("artificial-analysis"),
        detail: "no key: catherd init, or export ARTIFICIAL_ANALYSIS_API_KEY",
      });
    await Promise.all(jobs);
    writeSyncState(state);

    const changed = [...outcomes.values()].some((x) => x.state === "fetched");
    const raw = cachedAnswers();
    if ((changed || readDerived() === null) && Object.keys(raw).length > 0)
      writeDerived(
        derive(raw, {
          models: shippedModels(),
          scores: shippedScores(),
          sources: shippedSources(),
          now: now(),
        }),
      );
    const derived = readDerived();
    const after = catalogWith(derived, now());
    const had = scored(before);
    const noLongerNeeded = Object.entries(after.treatLike).flatMap(([rung, t]) => {
      if (t.source !== "user") return [];
      const lends = DIMS.filter((d) => after.scores[t.like]?.[d]);
      const covered = (c: Catalog) => lends.length > 0 && lends.every((d) => c.scores[rung]?.[d]);
      return covered(after) && !covered(before) ? [{ rung, like: t.like }] : [];
    });
    const sources = SOURCE_IDS.map((id) => outcomes.get(id)).filter(
      (x): x is SourceOutcome => x !== undefined,
    );
    return {
      busy: false,
      sources,
      newlyScored: [...scored(after)].filter((r) => !had.has(r)).sort(),
      noLongerNeeded,
      failed: sources.flatMap((s) =>
        s.state === "failed" ? [{ source: s.source, error: s.error ?? "" }] : [],
      ),
      warnings: derived?.warnings ?? [],
      unmatched: derived?.unmatched ?? {},
    };
  } finally {
    release();
  }
}

/**
 * Spec 1.2 §3.2: the MCP server's boot sync, started without awaiting it. It never throws (a failure is
 * logged at debug) and never waits for another sync. `CATHERD_NO_SYNC=1` turns it off (tests, air-gapped
 * machines), as it does `init`'s sync; `catherd catalog sync` still runs.
 */
export function backgroundSync(o: SyncOptions = {}): Promise<SyncReport | null> {
  if (process.env.CATHERD_NO_SYNC === "1") return Promise.resolve(null);
  return syncSources({ ...o, background: true }).catch((e: unknown) => {
    log("debug", "sources", { error: errorMessage(e) });
    return null;
  });
}

export interface SourceStatus {
  source: SourceId;
  name: string;
  /** when its cached answer was fetched; null when never */
  fetchedAt: string | null;
  error: string | null;
}

/** Spec 1.2 §9 doctor: each source's last fetch and error, the AA key, and AA's requests left. */
export function sourcesStatus(): {
  sources: SourceStatus[];
  aaKey: boolean;
  rateLimitRemaining: number | null;
  rateLimitAt: string | null;
} {
  const state = readSyncState();
  const aa = state.sources["artificial-analysis"];
  return {
    sources: shippedSources().sources.map((s) => ({
      source: s.id,
      name: s.name,
      fetchedAt: state.sources[s.id]?.fetchedAt ?? null,
      error: state.sources[s.id]?.error ?? null,
    })),
    aaKey: aaKey() !== null,
    rateLimitRemaining: aa?.rateLimitRemaining ?? null,
    rateLimitAt: aa?.rateLimitRemaining === null || aa === undefined ? null : aa.lastAttemptAt,
  };
}
