/**
 * Spec 1.2 §3.3: what a score source's parser returns, one number each. `rung` is the source's own model id,
 * with `#<effort>` when the source names one (catherd's effort word); `date` is the day the source measured or
 * published it, else the day it was fetched; `url` is where the value can be checked.
 */
export interface SourceRow {
  rung: string;
  field: string;
  value: number;
  date: string;
  url: string;
}

/** The `YYYY-MM-DD` of an ISO time. */
export const isoDay = (iso: string): string => iso.slice(0, 10);

/** `candidate` when it is an http(s) URL, else `fallback`. */
export const urlOr = (candidate: unknown, fallback: string): string =>
  typeof candidate === "string" && /^https?:\/\//.test(candidate.trim()) && URL.canParse(candidate.trim())
    ? candidate.trim()
    : fallback;

/** `v` as a finite number (numbers and numeric strings), else null. */
export function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/** One row per rung and field: a source that lists a model twice (Epoch: one row per agent) keeps the highest. */
export function keepHighest(rows: SourceRow[]): SourceRow[] {
  const best = new Map<string, SourceRow>();
  for (const r of rows) {
    const k = `${r.rung}\u0000${r.field}`;
    const had = best.get(k);
    if (!had || r.value > had.value) best.set(k, r);
  }
  return [...best.values()];
}
