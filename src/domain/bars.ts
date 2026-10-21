import { z } from "zod";
import type { Catalog } from "./catalog.ts";
import { DIFFICULTIES, type Difficulty } from "./lane.ts";

/** The percentile of the shipped models' intelligences each difficulty's bar sits at. */
export const BAR_PERCENTILE: Record<Difficulty, number> = { copy: 20, build: 45, logic: 60, hard: 65 };

/** A profile's or a role's own percentiles (0 to 100), one difficulty at a time; a difficulty left out keeps its shipped percentile. */
export const BarsSchema = z.partialRecord(z.enum(DIFFICULTIES), z.number().min(0).max(100));
export type Bars = z.infer<typeof BarsSchema>;

/** The percentiles in force as stored: the shipped ones, with `p.bars` laid over them; they may decrease. */
export const effectiveBars = (p: { bars?: Bars }): Record<Difficulty, number> => ({
  ...BAR_PERCENTILE,
  ...p.bars,
});

/** Each pair `[easier, harder]` of neighbouring difficulties whose percentile goes down. */
export const barInversions = (at: Record<Difficulty, number>): [Difficulty, Difficulty][] =>
  DIFFICULTIES.slice(1).flatMap((d, i): [Difficulty, Difficulty][] =>
    at[d] < at[DIFFICULTIES[i] as Difficulty] ? [[DIFFICULTIES[i] as Difficulty, d]] : [],
  );

/** The percentiles a route reads: the effective ones made non-decreasing, so a harder lane never routes weaker. */
export function percentilesOf(p: { bars?: Bars }): Record<Difficulty, number> {
  const at = effectiveBars(p);
  let floor = 0;
  for (const d of DIFFICULTIES) at[d] = floor = Math.max(at[d], floor);
  return at;
}

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
