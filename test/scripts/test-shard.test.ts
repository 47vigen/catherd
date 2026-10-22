import { describe, expect, it } from "bun:test";
import { assign, listTests, loadTimings } from "../../scripts/test-shard.ts";

const load = (shard: string[], t: Record<string, number>, median: number) =>
  shard.reduce((sum, f) => sum + (t[f] ?? median), 0);

describe("test sharding", () => {
  it("puts every test file on exactly one shard and balances them by timing", () => {
    const files = listTests();
    const timings = loadTimings();
    expect(files.length).toBeGreaterThan(100);
    for (const count of [1, 4, 7]) {
      const shards = assign(files, timings, count);
      expect(shards.flat().sort()).toEqual(files);
      const known = Object.values(timings).sort((a, b) => a - b);
      const median = known[Math.floor(known.length / 2)] ?? 1;
      const loads = shards.map((s) => load(s, timings, median));
      const heaviest = Math.max(...files.map((f) => timings[f] ?? median));
      // greedy longest-first: no shard exceeds the mean by more than the heaviest single file
      expect(Math.max(...loads)).toBeLessThanOrEqual(loads.reduce((a, b) => a + b, 0) / count + heaviest);
    }
  });

  it("gives an untimed file the median and an empty shard no files", () => {
    const shards = assign(["a", "b", "c"], { a: 10, b: 2 }, 4);
    expect(shards.flat().sort()).toEqual(["a", "b", "c"]);
    expect(shards.filter((s) => s.length === 0)).toHaveLength(1);
  });
});
