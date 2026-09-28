import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ModelsFileSchema, ScoresFileSchema } from "../../src/domain/catalog.ts";
import { SourcesFileSchema } from "../../src/domain/sources.ts";
import { AA_MODELS_URL, aaFreeUrl } from "../../src/infra/sources/artificial-analysis.ts";
import { ARENA_CONFIGS, arenaUrl } from "../../src/infra/sources/arena.ts";
import { EPOCH_URL } from "../../src/infra/sources/epoch.ts";
import { LITELLM_URL } from "../../src/infra/sources/litellm.ts";
import { MODELS_DEV_URL } from "../../src/infra/sources/models-dev.ts";
import { openRouterEndpointsUrl } from "../../src/infra/sources/openrouter-endpoints.ts";
import { OPENROUTER_MODELS_URL } from "../../src/infra/sources/openrouter-models.ts";
import { VECTARA_URL } from "../../src/infra/sources/vectara.ts";
import { unzip } from "../../src/infra/sources/zip.ts";
import type { DeriveContext, RawAnswers } from "../../src/services/source-derive.ts";

// The recorded answers of test/fixtures/sources, as a sync caches them and as the network would serve them.

const ROOT = join(import.meta.dir, "..", "..");
export const FX = join(ROOT, "test", "fixtures", "sources");
const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
export const fixtureJson = (name: string): unknown => json(join(FX, name));
export const epochZip = (): Uint8Array => new Uint8Array(readFileSync(join(FX, "epoch.zip")));

/** The shipped catalog files, as the sync reads them. */
export const shippedContext = (now: number): DeriveContext => ({
  models: ModelsFileSchema.parse(json(join(ROOT, "catalog", "models.json"))),
  scores: ScoresFileSchema.parse(json(join(ROOT, "catalog", "scores.json"))),
  sources: SourcesFileSchema.parse(json(join(ROOT, "catalog", "sources.json"))),
  now,
});

/** Every source's recorded answer as the cache holds it; Artificial Analysis only with `aa`. */
export function rawAnswers(fetchedAt: string, o: { aa?: boolean } = {}): RawAnswers {
  const epoch = Object.fromEntries(
    [...unzip(epochZip())]
      .filter(([n]) => n.endsWith(".csv"))
      .map(([n, d]) => [n, new TextDecoder().decode(d)]),
  );
  return {
    "models-dev": { fetchedAt, data: fixtureJson("models-dev.json") },
    "openrouter-models": { fetchedAt, data: fixtureJson("openrouter-models.json") },
    "openrouter-endpoints": { fetchedAt, data: fixtureJson("openrouter-endpoints.json") },
    litellm: { fetchedAt, data: fixtureJson("litellm.json") },
    arena: {
      fetchedAt,
      data: Object.fromEntries(ARENA_CONFIGS.map((c) => [c, fixtureJson(`arena-${c}.json`)])),
    },
    vectara: { fetchedAt, data: readFileSync(join(FX, "vectara-README.md"), "utf8") },
    epoch: { fetchedAt, data: epoch },
    ...(o.aa
      ? {
          "artificial-analysis": {
            fetchedAt,
            data: {
              path: "models",
              pages: [fixtureJson("artificial-analysis-models.json")],
              rateLimitRemaining: 98,
            },
          },
        }
      : {}),
  };
}

/** Each source URL's recorded answer: a body, or raw bytes for Epoch's zip. */
export function recordedAnswers(): Map<
  string,
  { body?: unknown; bytes?: Uint8Array; headers?: Record<string, string> }
> {
  const endpoints = fixtureJson("openrouter-endpoints.json") as Record<string, unknown>;
  const answers = new Map<string, { body?: unknown; bytes?: Uint8Array; headers?: Record<string, string> }>([
    [MODELS_DEV_URL, { body: fixtureJson("models-dev.json") }],
    [OPENROUTER_MODELS_URL, { body: fixtureJson("openrouter-models.json") }],
    [LITELLM_URL, { body: fixtureJson("litellm.json") }],
    [VECTARA_URL, { bytes: new TextEncoder().encode(readFileSync(join(FX, "vectara-README.md"), "utf8")) }],
    [EPOCH_URL, { bytes: epochZip() }],
    [
      AA_MODELS_URL,
      { body: fixtureJson("artificial-analysis-models.json"), headers: { "x-ratelimit-remaining": "98" } },
    ],
    [aaFreeUrl(1), { body: fixtureJson("artificial-analysis-free-1.json") }],
  ]);
  for (const c of ARENA_CONFIGS) answers.set(arenaUrl(c), { body: fixtureJson(`arena-${c}.json`) });
  for (const [id, body] of Object.entries(endpoints)) answers.set(openRouterEndpointsUrl(id), { body });
  return answers;
}

/**
 * A fetch that serves the recorded answers by URL (404 for any other URL, as OpenRouter answers an id it
 * does not know), and records each URL asked for. `fail` makes chosen URLs throw a network error.
 */
export function recordedFetch(o: { fail?: (url: string) => boolean } = {}): {
  impl: typeof fetch;
  urls: string[];
} {
  const answers = recordedAnswers();
  const urls: string[] = [];
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    if (o.fail?.(url)) throw new TypeError("fetch failed");
    const a = answers.get(url);
    if (!a) return new Response("{}", { status: 404 });
    const body = a.bytes ? new Blob([a.bytes.slice()]) : JSON.stringify(a.body);
    return new Response(body, { status: 200, headers: a.headers });
  };
  return { impl: impl as typeof fetch, urls };
}
