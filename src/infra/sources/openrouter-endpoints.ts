import { median } from "../../domain/util.ts";
import { SourceError, type SourceTransport, sourceGet } from "./http.ts";
import { isoDay, num, type SourceRow } from "./rows.ts";

/** Spec 1.2 §3.1: per provider, uptime, latency and throughput over the last 30 minutes. */
export const openRouterEndpointsUrl = (id: string): string =>
  `https://openrouter.ai/api/v1/models/${id}/endpoints`;

/**
 * Plan 13 R-H: one request per OpenRouter id (one per catalog family OpenRouter lists), in parallel. An id
 * OpenRouter no longer knows (404) is left out; any other failure fails the source, which keeps its last answer.
 */
export async function fetchOpenRouterEndpoints(
  ids: readonly string[],
  t: SourceTransport = {},
): Promise<Record<string, unknown>> {
  const got = await Promise.all(
    ids.map(async (id) => {
      try {
        return [id, (await sourceGet(openRouterEndpointsUrl(id), t)).json()] as const;
      } catch (e) {
        if (e instanceof SourceError && e.status === 404) return null;
        throw e instanceof SourceError ? new SourceError(`${id}: ${e.message}`, e.status, e.headers) : e;
      }
    }),
  );
  return Object.fromEntries(got.filter((x) => x !== null));
}

export const ENDPOINT_FIELDS = ["latency_last_30m", "throughput_last_30m", "uptime_last_30m"] as const;

/** A statistic as a number, or as a percentile object (`{ p50: … }`) some answers carry. */
const stat = (v: unknown): number | null =>
  v !== null && typeof v === "object" ? num((v as { p50?: unknown }).p50) : num(v);

/** One row per OpenRouter id and field: the median over its endpoints that report the field. */
export function parseOpenRouterEndpoints(raw: Record<string, unknown>, fetchedAt: string): SourceRow[] {
  const rows: SourceRow[] = [];
  for (const [id, answer] of Object.entries(raw)) {
    const endpoints = (answer as { data?: { endpoints?: unknown[] } } | null)?.data?.endpoints;
    if (!Array.isArray(endpoints)) continue;
    for (const field of ENDPOINT_FIELDS) {
      const xs = endpoints
        .map((e) => stat((e as Record<string, unknown> | null)?.[field]))
        .filter((x): x is number => x !== null);
      const value = median(xs);
      if (value !== null)
        rows.push({ rung: id, field, value, date: isoDay(fetchedAt), url: `https://openrouter.ai/${id}` });
    }
  }
  return rows;
}
