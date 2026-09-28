import { describe, expect, it } from "bun:test";
import {
  BAR_DIMS,
  barDimsOf,
  barPool,
  deriveBars,
  measuredOrBetter,
  percentile,
} from "../../src/domain/bars.ts";
import { type Dim, DIMS, OverrideSchema, type Score } from "../../src/domain/catalog.ts";
import { DIFFICULTIES, KINDS } from "../../src/domain/lane.ts";
import { shipped } from "./shipped.ts";

const score = (o: Partial<Score> & Pick<Score, "rung" | "dim" | "value">): Score => ({
  benchmark: "b",
  version: "v",
  url: "https://example.com/s",
  date: "2026-09-27",
  confidence: "measured",
  ...o,
});

describe("default bars (spec 1.2 §5.1)", () => {
  it("spans the table's dimensions per kind, Track A then Track B", () => {
    expect(barDimsOf("repo_code", "copy")).toEqual(["repo_code"]);
    expect(barDimsOf("repo_code", "hard")).toEqual(["repo_code", "honesty", "agentic"]);
    expect(barDimsOf("terminal", "build")).toEqual(["terminal"]);
    expect(barDimsOf("terminal", "logic")).toEqual(["terminal", "honesty", "agentic"]);
    expect(barDimsOf("ui", "build")).toEqual(["frontend", "repo_code"]);
    expect(barDimsOf("ui", "logic")).toEqual(["frontend", "repo_code", "honesty", "agentic"]);
    for (const k of ["prose", "research"] as const) {
      expect(barDimsOf(k, "copy")).toEqual(["repo_code"]);
      expect(barDimsOf(k, "hard")).toEqual(["repo_code", "honesty"]);
    }
  });

  it("puts no default bar on steer", () => {
    expect(BAR_DIMS).toEqual(["repo_code", "terminal", "honesty", "agentic", "frontend"]);
    for (const k of KINDS) for (const d of DIFFICULTIES) expect(barDimsOf(k, d)).not.toContain("steer");
  });
});

describe("bar values (spec 1.2 §5.2)", () => {
  it("interpolates percentiles between the closest ranks", () => {
    const xs = [37.2, 54, 56.6, 65.3, 66.6, 66.6, 67, 68.8, 73, 74, 74.2];
    expect(percentile(xs, 25)).toBeCloseTo(60.95, 6);
    expect(percentile(xs, 50)).toBe(66.6);
    expect(percentile(xs, 60)).toBe(67);
    expect(percentile(xs, 75)).toBeCloseTo(70.9, 6);
    expect(percentile([5], 75)).toBe(5);
    expect(percentile([], 50)).toBeNaN();
  });

  it("pools values measured or better, counting a hand-typed secondary value and one value per rung", () => {
    expect(measuredOrBetter(score({ rung: "a#high", dim: "repo_code", value: 1 }))).toBe(true);
    const secondary = score({ rung: "a#high", dim: "repo_code", value: 1, confidence: "secondary" });
    expect(measuredOrBetter(secondary)).toBe(true);
    for (const confidence of ["calibrated", "adjacent", "inferred"] as const)
      expect(measuredOrBetter(score({ rung: "a#high", dim: "repo_code", value: 1, confidence }))).toBe(false);
    // a synced value is never secondary; if one were, it would not be a published number for this rung
    expect(measuredOrBetter({ ...secondary, source: "epoch" })).toBe(false);
    const pool = barPool([
      score({ rung: "a#high", dim: "agentic", value: 0.1 }),
      score({ rung: "a#high", dim: "agentic", value: 0.2 }),
      score({ rung: "a#max", dim: "agentic", value: 0.3, confidence: "adjacent" }),
      score({ rung: "b#high", dim: "agentic", value: 0.4, confidence: "verified" }),
    ]);
    expect(pool.agentic).toEqual([0.1, 0.4]);
    expect(pool.repo_code).toEqual([]);
  });

  it("derives each threshold once per dimension and difficulty, with a why line, and none without data", () => {
    const pool = Object.fromEntries(DIMS.map((d) => [d, [] as number[]])) as Record<Dim, number[]>;
    pool.repo_code = [37.2, 54, 56.6, 65.3, 66.6, 66.6, 67, 68.8, 73, 74, 74.2];
    pool.honesty = [21.8, 22.5, 71.3, 95.1, 98.5];
    const { bars, barsWhy } = deriveBars(pool, (d) => (d === "repo_code" ? "DeepSWE 1.1" : d), "2026-09-28");
    expect(bars.repo_code.copy).toEqual({ repo_code: 60.95 });
    expect(bars.prose.build).toEqual({ repo_code: 66.6 });
    expect(bars.research.logic).toEqual({ repo_code: 67, honesty: 80.82 });
    expect(bars.repo_code.hard).toEqual({ repo_code: 70.9, honesty: 95.1 });
    // no pooled agentic, terminal or frontend value: those thresholds are left out, and said so
    expect(bars.terminal.copy).toEqual({});
    expect(bars.ui.build).toEqual({ repo_code: 66.6 });
    expect(barsWhy.repo_code?.copy).toBe(
      "the 25th percentile of 11 rungs measured or better on DeepSWE 1.1 (2026-09-28): 60.95",
    );
    expect(barsWhy.agentic?.hard).toBe("no rung is measured or better on agentic (2026-09-28): no threshold");
    expect(barsWhy.agentic?.copy).toBeUndefined();
    expect(barsWhy.steer).toBeUndefined();
  });
});

describe("the override's bars (spec 1.2 §5.2)", () => {
  it("overrides the default per dimension: a number sets it, null removes it, the rest stay", () => {
    const base = shipped();
    const o = OverrideSchema.parse({
      bars: { repo_code: { logic: { repo_code: 50, honesty: null, steer: 0.05 } } },
    });
    const mine = shipped({ override: o });
    const want: Record<string, number> = { ...base.bars.repo_code.logic, repo_code: 50, steer: 0.05 };
    delete want.honesty;
    expect(mine.bars.repo_code.logic).toEqual(want);
    expect(mine.bars.repo_code.hard).toEqual(base.bars.repo_code.hard);
  });

  it("still reads an override that sets a whole bar, as 1.1 wrote them", () => {
    const o = OverrideSchema.safeParse({ bars: { ui: { hard: { repo_code: 70, honesty: 95 } } } });
    expect(o.success).toBe(true);
  });
});
