import type { Check } from "./doctor-checks.ts";
import { sourcesStatus, TTL_MS } from "./source-sync.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** An age as doctor prints it: minutes under an hour, hours under two days, else days. */
export function ageText(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < 2 * DAY) return `${Math.round(ms / HOUR)} h`;
  return `${Math.round(ms / DAY)} d`;
}

/**
 * Spec 1.2 §9: the `sources` row: each source's age and last error, whether an Artificial Analysis key is
 * set, and its requests left today (`x-ratelimit-remaining` of its last answer). `info` before the first
 * sync (routing uses the shipped scores); a warning when a source fails or has not been fetched for two
 * TTLs (a day), since background syncs would have refreshed it. It reads the sync's state only: no request.
 */
export function sourcesCheck(now = Date.now()): Check {
  const s = sourcesStatus();
  const shown = s.sources.filter((x) => x.source !== "artificial-analysis" || s.aaKey);
  const keyless = s.sources.filter((x) => x.source !== "artificial-analysis");
  const sameDay =
    s.rateLimitAt !== null && s.rateLimitAt.slice(0, 10) === new Date(now).toISOString().slice(0, 10);
  const left =
    s.rateLimitRemaining === null
      ? ""
      : sameDay
        ? `, ${s.rateLimitRemaining} requests left today`
        : `, ${s.rateLimitRemaining} requests left on ${s.rateLimitAt?.slice(0, 10)}`;
  const aa = s.aaKey ? `Artificial Analysis key set${left}` : "no Artificial Analysis key";
  const base = { id: "sources", label: "sources" };
  if (keyless.every((x) => x.fetchedAt === null && x.error === null))
    return {
      ...base,
      state: "info",
      word: "not synced",
      detail: `routing uses the shipped scores; ${aa}`,
      fix: "catherd catalog sync",
    };
  const parts = shown.map(
    (x) =>
      `${x.source} ${x.fetchedAt ? ageText(now - Date.parse(x.fetchedAt)) : "never"}${x.error ? ` (${x.error})` : ""}`,
  );
  const failing = shown.some((x) => x.error !== null);
  const stale = keyless.some((x) => x.fetchedAt === null || now - Date.parse(x.fetchedAt) > 2 * TTL_MS);
  const warn = failing || stale;
  return {
    ...base,
    state: warn ? "warn" : "ok",
    word: failing ? "failing" : stale ? "stale" : "fresh",
    detail: `${parts.join(", ")}; ${aa}`,
    ...(warn ? { fix: "catherd catalog sync --force" } : {}),
  };
}
