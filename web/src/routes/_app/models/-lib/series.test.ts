import type { CatalogEntry } from "../../../../client";
import { logTicks, seriesOf } from "./series";

const pt = (effort: string, usd: number | null, intelligence = 50) => ({
  effort,
  rung: `x:m#${effort}`,
  intelligence,
  usd,
  measured: usd !== null,
});
const model = (id: string, lab: string | null, points: CatalogEntry["points"]): CatalogEntry => ({
  id,
  name: null,
  lab,
  backends: ["codex"],
  points,
});
const NONE = new Set<string>();

describe("seriesOf", () => {
  it("a model's points follow its efforts and a point with no cost is left out and counted", () => {
    const m = [
      model("a", "openai", [pt("low", 0.1), pt("high", null), pt("max", 1)]),
      model("b", "google", [pt("low", 2)]),
    ];
    const { series, dropped } = seriesOf(m, NONE, "log");
    expect(series[0]!.points.map((p) => p.effort)).toEqual(["low", "max"]);
    expect(dropped).toBe(1);
  });

  it("the log scale leaves out a cost of 0, the linear scale keeps it", () => {
    const m = [model("a", "openai", [pt("low", 0), pt("high", 1)])];
    expect(seriesOf(m, NONE, "log")).toMatchObject({ dropped: 1 });
    const linear = seriesOf(m, NONE, "linear");
    expect(linear.dropped).toBe(0);
    expect(linear.series[0]!.points).toHaveLength(2);
  });

  it("a hidden model has no series; models of one lab get different dashes", () => {
    const m = [
      model("a", "openai", [pt("low", 1)]),
      model("b", "openai", [pt("low", 2)]),
      model("c", "openai", [pt("low", 3)]),
    ];
    const all = seriesOf(m, NONE, "log").series;
    expect(new Set(all.map((s) => s.dash)).size).toBe(3);
    const some = seriesOf(m, new Set(["b"]), "log").series;
    expect(some.map((s) => s.id)).toEqual(["a", "c"]);
    expect(some[1]!.dash).toBe(all[2]!.dash);
  });
});

describe("logTicks", () => {
  it("covers the range in powers of ten", () => {
    expect(logTicks(0.02, 5.9)).toEqual([0.01, 0.1, 1, 10]);
  });
});
