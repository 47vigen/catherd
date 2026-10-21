import type { Catalog } from "./catalog.ts";
import type { Difficulty } from "./lane.ts";

/** The percentile of the shipped models' intelligences each difficulty's bar sits at. */
export const BAR_PERCENTILE: Record<Difficulty, number> = { copy: 25, build: 50, logic: 60, hard: 75 };

/** The `p`th percentile of `xs`, interpolated linearly between the closest ranks; NaN for none. */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = ((s.length - 1) * p) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (s[lo] as number) + ((s[hi] as number) - (s[lo] as number)) * (pos - lo);
}

/** A difficulty's bar: an intelligence percentile of the catalog's pool, 0 when there is no index. */
export function barOf(c: Catalog, d: Difficulty, at: Record<Difficulty, number> = BAR_PERCENTILE): number {
  return c.pool.length === 0 ? 0 : percentile(c.pool, at[d]);
}
