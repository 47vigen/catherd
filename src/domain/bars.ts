import { type Dim, DIMS, type Score } from "./catalog.ts";
import { DIFFICULTIES, type Difficulty, KINDS, type Kind } from "./lane.ts";

/**
 * Spec 1.2 §5.1: the dimensions each kind's default bars span, for Track A (`copy`, `build`) and Track B
 * (`logic`, `hard`). `steer` has no default bar: it is shown, and a user may set one.
 */
export const DEFAULT_BAR_DIMS: Record<Kind, { A: Dim[]; B: Dim[] }> = {
  repo_code: { A: ["repo_code"], B: ["repo_code", "honesty", "agentic"] },
  terminal: { A: ["terminal"], B: ["terminal", "honesty", "agentic"] },
  ui: { A: ["frontend", "repo_code"], B: ["frontend", "repo_code", "honesty", "agentic"] },
  prose: { A: ["repo_code"], B: ["repo_code", "honesty"] },
  research: { A: ["repo_code"], B: ["repo_code", "honesty"] },
};

/** The dimensions a difficulty's default bar spans for a kind. */
export const barDimsOf = (kind: Kind, d: Difficulty): Dim[] =>
  d === "copy" || d === "build" ? DEFAULT_BAR_DIMS[kind].A : DEFAULT_BAR_DIMS[kind].B;

/** Every dimension some default bar uses: the values an enabled rung needs (spec 1.2 §6.1). */
export const BAR_DIMS: Dim[] = DIMS.filter((d) =>
  KINDS.some((k) => DIFFICULTIES.some((x) => barDimsOf(k, x).includes(d))),
);

/** Spec 1.2 §5.2: the percentile of the scored rungs each difficulty's threshold sits at. */
export const BAR_PERCENTILE: Record<Difficulty, number> = { copy: 25, build: 50, logic: 60, hard: 75 };

const PERCENTILE_WORD: Record<Difficulty, string> = {
  copy: "the 25th percentile",
  build: "the median",
  logic: "the 60th percentile",
  hard: "the 75th percentile",
};

/** The `p`th percentile of `xs`, interpolated linearly between the closest ranks; NaN for none. */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = ((s.length - 1) * p) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (s[lo] as number) + ((s[hi] as number) - (s[lo] as number)) * (pos - lo);
}

/**
 * Spec 1.2 §5.2 "measured or better": a value published for this exact rung in the anchor's unit. That is a
 * `verified` or `measured` value, and a hand-typed `secondary` one (no `source`: the 1.0 word for a value
 * published by someone other than the vendor, which is 1.2's `measured`). Plan 14 Ruling 1.
 */
export const measuredOrBetter = (s: Score): boolean =>
  s.confidence === "verified" ||
  s.confidence === "measured" ||
  (s.confidence === "secondary" && s.source === undefined);

/** Each dimension's values that bars are derived from: one per canonical rung, measured or better. */
export function barPool(scores: readonly Score[]): Record<Dim, number[]> {
  const out = Object.fromEntries(DIMS.map((d) => [d, [] as number[]])) as Record<Dim, number[]>;
  const seen = new Set<string>();
  for (const s of scores) {
    const key = `${s.rung} ${s.dim}`;
    if (!measuredOrBetter(s) || seen.has(key)) continue;
    seen.add(key);
    out[s.dim].push(s.value);
  }
  return out;
}

/** A bar value, kept to four significant digits (DeepSWE 60.95, an Arena rating 1668, agentic 0.08622). */
const tidy = (v: number): number => Number(v.toPrecision(4));

export type Bars = Record<Kind, Record<Difficulty, Partial<Record<Dim, number>>>>;
/** `scores.json` `barsWhy`: per dimension and difficulty, where its threshold came from. */
export type BarsWhy = Partial<Record<Dim, Partial<Record<Difficulty, string>>>>;

/**
 * Spec 1.2 §5.1–§5.2: the default bars. Each dimension's threshold at a difficulty is that difficulty's
 * percentile of the pool (`barPool`), the same in every kind whose bar spans the dimension. A dimension with
 * no pooled value gets no threshold (and a `barsWhy` line saying so). `benchmark` names each dimension's unit
 * and `date` the day the data was read.
 */
export function deriveBars(
  pool: Record<Dim, number[]>,
  benchmark: (d: Dim) => string,
  date: string,
): { bars: Bars; barsWhy: BarsWhy } {
  const value: Partial<Record<Dim, Partial<Record<Difficulty, number>>>> = {};
  const barsWhy: BarsWhy = {};
  for (const dim of BAR_DIMS)
    for (const d of DIFFICULTIES) {
      if (!KINDS.some((k) => barDimsOf(k, d).includes(dim))) continue;
      const xs = pool[dim];
      const why = (barsWhy[dim] ??= {});
      if (xs.length === 0) {
        why[d] = `no rung is measured or better on ${benchmark(dim)} (${date}): no threshold`;
        continue;
      }
      const v = tidy(percentile(xs, BAR_PERCENTILE[d]));
      (value[dim] ??= {})[d] = v;
      why[d] =
        `${PERCENTILE_WORD[d]} of ${xs.length} rungs measured or better on ${benchmark(dim)} (${date}): ${v}`;
    }
  const bars = Object.fromEntries(
    KINDS.map((k) => [
      k,
      Object.fromEntries(
        DIFFICULTIES.map((d) => [
          d,
          Object.fromEntries(
            barDimsOf(k, d).flatMap((dim) => {
              const v = value[dim]?.[d];
              return v === undefined ? [] : [[dim, v]];
            }),
          ),
        ]),
      ),
    ]),
  ) as Bars;
  return { bars, barsWhy };
}
