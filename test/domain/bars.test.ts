import { describe, expect, it } from "bun:test";
import {
  BAR_PERCENTILE,
  BarsSchema,
  barInversions,
  barOf,
  effectiveBars,
  percentile,
  percentilesOf,
} from "../../src/domain/bars.ts";
import { DIFFICULTIES } from "../../src/domain/lane.ts";
import { indexOf, shipped } from "./shipped.ts";

describe("percentile", () => {
  it("interpolates between the closest ranks, and is NaN for none", () => {
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
    expect(percentile([10, 20, 30, 40, 50], 60)).toBeCloseTo(34, 9);
    expect(percentile([40, 10, 30, 20], 25)).toBe(17.5);
    expect(Number.isNaN(percentile([], 50))).toBe(true);
  });
});

describe("barOf", () => {
  // luna family pairs 10..50 under shipped families only: gpt-6-luna, gpt-6-sol
  const pool = shipped({
    index: indexOf({
      "gpt-6-luna#low": 10,
      "gpt-6-luna#high": 20,
      "gpt-6-sol#low": 30,
      "gpt-6-sol#medium": 40,
      "gpt-6-sol#high": 50,
      "not-shipped#high": 99,
    }),
  });

  it("sets each difficulty's bar at its percentile of the pool", () => {
    expect(pool.pool).toEqual([10, 20, 30, 40, 50]);
    expect(DIFFICULTIES.map((d) => barOf(pool, d))).toEqual([18, 28, 34, 36]);
  });

  it("puts every bar at 0 with an empty pool", () => {
    const none = shipped({ index: null });
    expect(DIFFICULTIES.map((d) => barOf(none, d))).toEqual([0, 0, 0, 0]);
  });

  it("takes other percentiles when given", () => {
    expect(barOf(pool, "hard", { ...BAR_PERCENTILE, hard: 50 })).toBe(30);
  });

  it("ranks the recorded index's bars in difficulty order", () => {
    const c = shipped();
    const bars = DIFFICULTIES.map((d) => barOf(c, d));
    expect(bars).toEqual([...bars].sort((a, b) => a - b));
    expect(bars[0]).toBeGreaterThan(0);
  });
});

describe("the bar percentiles", () => {
  it("ships copy 20, build 45, logic 60, hard 65", () =>
    expect(BAR_PERCENTILE).toEqual({ copy: 20, build: 45, logic: 60, hard: 65 }));

  it("lays a role's bars over the profile's over the shipped percentiles, one difficulty at a time", () => {
    expect(percentilesOf({})).toEqual(BAR_PERCENTILE);
    expect(percentilesOf({ bars: { logic: 70 } })).toEqual({ ...BAR_PERCENTILE, logic: 70, hard: 70 });
    expect(BarsSchema.safeParse({ hard: 150 }).success).toBe(false);
  });

  it("reads a stored inversion as non-decreasing: each bar is at least the easier one", () => {
    expect(effectiveBars({ bars: { logic: 30 } })).toEqual({ ...BAR_PERCENTILE, logic: 30 });
    expect(barInversions(effectiveBars({ bars: { logic: 30 } }))).toEqual([["build", "logic"]]);
    expect(percentilesOf({ bars: { logic: 30 } })).toEqual({ copy: 20, build: 45, logic: 45, hard: 65 });
    expect(percentilesOf({ bars: { copy: 80 } })).toEqual({ copy: 80, build: 80, logic: 80, hard: 80 });
    expect(barInversions(BAR_PERCENTILE)).toEqual([]);
  });
});
