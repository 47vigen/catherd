import { effortWord } from "../../domain/sources.ts";
import { rateLimitRemaining, SourceError, type SourceTransport, sourceGet } from "./http.ts";
import { isoDay, num, type SourceRow } from "./rows.ts";

/** Spec 1.2 §3.1: the legacy v2 route a free key reads today, one row per effort. */
export const AA_MODELS_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";
/** Spec 1.2 §3.1: the fallback when the first path answers 403 or 404, a page at a time. */
export const aaFreeUrl = (page: number): string =>
  `https://artificialanalysis.ai/api/v2/language/models/free?page=${page}`;
export const AA_PAGE = "https://artificialanalysis.ai";
/** The free path had 4 pages on 2026-09-27; this bounds a runaway pagination. */
const MAX_FREE_PAGES = 10;

/** What catherd caches for Artificial Analysis: the path that answered, each page, the requests left. */
export interface AaAnswer {
  path: "models" | "free";
  pages: unknown[];
  rateLimitRemaining: number | null;
}

/**
 * Spec 1.2 §3.1: the models path with the user's key; on a 403 or 404 there, the free path's pages until an
 * empty page or the last one. Throws a SourceError (carrying the last answer's headers) on any other failure.
 */
export async function fetchArtificialAnalysis(key: string, t: SourceTransport = {}): Promise<AaAnswer> {
  const o = { ...t, headers: { "x-api-key": key } };
  try {
    const r = await sourceGet(AA_MODELS_URL, o);
    const body = r.json() as { data?: unknown } | null;
    // (1.2 minor) an answer of the wrong shape is a failure: the last good one stays
    if (!Array.isArray(body?.data) || body.data.length === 0)
      throw new SourceError("Artificial Analysis answered no models", r.status, r.headers);
    return { path: "models", pages: [body], rateLimitRemaining: rateLimitRemaining(r.headers) };
  } catch (e) {
    if (!(e instanceof SourceError) || (e.status !== 403 && e.status !== 404)) throw e;
  }
  const pages: unknown[] = [];
  let remaining: number | null = null;
  for (let page = 1; page <= MAX_FREE_PAGES; page++) {
    const r = await sourceGet(aaFreeUrl(page), o);
    remaining = rateLimitRemaining(r.headers) ?? remaining;
    const body = r.json() as { data?: unknown; pagination?: { total_pages?: unknown } } | null;
    if (!Array.isArray(body?.data) || body.data.length === 0) break;
    pages.push(body);
    const total = num(body.pagination?.total_pages);
    if (total !== null && page >= total) break;
  }
  if (pages.length === 0) throw new SourceError("Artificial Analysis answered an empty first page");
  return { path: "free", pages, rateLimitRemaining: remaining };
}

/**
 * Spec 1.2 §9: tests a key with one request to the free path's first page. `ok` on a 200, `refused` on a 401;
 * anything else (a network error, a 5xx) leaves the key `unchecked`.
 */
export async function testAaKey(
  key: string,
  t: SourceTransport = {},
): Promise<{ result: "ok" | "refused" | "unchecked"; error?: string; rateLimitRemaining: number | null }> {
  try {
    // spec 1.2 §9: one request, never retried (a 429 or 5xx leaves the key unchecked)
    const r = await sourceGet(aaFreeUrl(1), {
      attemptMs: 10_000,
      deadlineMs: 20_000,
      ...t,
      retries: 0,
      headers: { "x-api-key": key },
    });
    return { result: "ok", rateLimitRemaining: rateLimitRemaining(r.headers) };
  } catch (e) {
    const err = e instanceof SourceError ? e : new SourceError(String(e));
    return {
      result: err.status === 401 ? "refused" : "unchecked",
      error: err.message,
      rateLimitRemaining: rateLimitRemaining(err.headers),
    };
  }
}

/** Spec 1.2 §3.4: an AA slug as `<id>#<effort>`: its effort suffix, and `max` for a bare slug. */
export function aaRung(slug: string): string {
  const m = /^(.*)-([a-z]+)$/.exec(slug);
  const effort = m ? effortWord(m[2] as string) : null;
  return m && effort ? `${m[1]}#${effort}` : `${slug}#max`;
}

const TOP = [
  "median_output_tokens_per_second",
  "median_time_to_first_token_seconds",
  "cost_per_task",
] as const;

/**
 * One row per slug and number: every evaluation (`livecodebench`, `terminalbench_v2_1`, the indexes, …), every
 * price, speed and `cost_per_task`, named as AA names them. Nulls are left out.
 */
export function parseArtificialAnalysis(answer: AaAnswer, fetchedAt: string): SourceRow[] {
  const rows: SourceRow[] = [];
  const date = isoDay(fetchedAt);
  for (const page of answer.pages) {
    const data = (page as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) continue;
    for (const m of data as Record<string, unknown>[]) {
      if (typeof m?.slug !== "string") continue;
      const rung = aaRung(m.slug);
      const url = `${AA_PAGE}/models/${m.slug}`;
      const push = (field: string, v: unknown) => {
        const value = num(v);
        if (value !== null) rows.push({ rung, field, value, date, url });
      };
      for (const group of ["evaluations", "pricing"] as const) {
        const g = m[group];
        if (g && typeof g === "object") for (const [field, v] of Object.entries(g)) push(field, v);
      }
      for (const field of TOP) push(field, m[field]);
    }
  }
  return rows;
}
