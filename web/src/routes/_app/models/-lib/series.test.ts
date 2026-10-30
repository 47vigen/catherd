import type { CatalogEntry } from "../../../../client";
import { frontierOf, logTicks, seriesOf, shadesOf, standouts } from "./series";

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
  superseded: false,
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

  it("a hidden model has no series; a lab's stronger model is drawn deeper, and hiding one recolours nothing", () => {
    const m = [
      model("weak", "openai", [pt("low", 1, 20)]),
      model("strong", "openai", [pt("low", 2, 60)]),
      model("mid", "openai", [pt("low", 3, 40)]),
    ];
    expect(shadesOf(m)).toEqual(
      new Map([
        ["strong", 900],
        ["mid", 500],
        ["weak", 100],
      ]),
    );
    const all = seriesOf(m, NONE, "log").series;
    expect(all.find((s) => s.id === "strong")!.color).toBe("var(--brand-openai)");
    expect(all.find((s) => s.id === "weak")!.color).toContain("color-mix");
    const some = seriesOf(m, new Set(["mid"]), "log").series;
    expect(some.map((s) => s.id)).toEqual(["weak", "strong"]);
    expect(some[0]!.color).toBe(all[0]!.color);
  });

  it("a model a newer version replaces takes the faintest step and leaves the range to the current ones", () => {
    const old = { ...model("old", "openai", [pt("low", 1, 50)]), superseded: true };
    const shades = shadesOf([
      old,
      model("new", "openai", [pt("low", 1, 60)]),
      model("low", "openai", [pt("low", 1, 10)]),
    ]);
    expect([shades.get("new"), shades.get("low"), shades.get("old")]).toEqual([900, 100, 100]);
  });

  it("a lab with one model draws it in the brand itself", () => {
    expect(shadesOf([model("only", "google", [pt("low", 1)])]).get("only")).toBe(900);
  });
});

describe("logTicks", () => {
  it("covers the range in powers of ten", () => {
    expect(logTicks(0.02, 5.9)).toEqual([0.01, 0.1, 1, 10]);
  });

  it("spans at least one decade when the costs sit on one boundary", () => {
    expect(logTicks(1, 1)).toEqual([1, 10]);
  });
});

test("the frontier keeps only points nothing beats for less money", () => {
  const s = (name: string, points: [number, number][]) => ({
    id: name,
    name,
    brand: "openai" as const,
    color: "",
    points: points.map(([usd, intelligence], i) => ({ effort: `e${i}`, usd, intelligence, measured: true })),
  });
  const f = frontierOf([
    s("a", [
      [0.1, 30],
      [1, 50],
    ]),
    s("b", [
      [0.5, 20],
      [0.6, 55],
      [2, 54],
    ]),
  ]);
  expect(f.map((p) => [p.model, p.usd])).toEqual([
    ["a", 0.1],
    ["b", 0.6],
  ]);
});

test("the best value is the cheapest current point within 90% of the strongest", () => {
  const m = (id: string, points: [number | null, number][], superseded = false) => ({
    id,
    name: id,
    lab: "openai",
    backends: [],
    superseded,
    points: points.map(([usd, intelligence], i) => ({ effort: `e${i}`, rung: "", usd, intelligence, measured: true })),
  });
  const { top, value } = standouts([
    m("big", [[5, 60]]),
    m("mid", [
      [0.8, 55],
      [0.3, 40],
    ]),
    m("old", [[0.1, 59]], true),
  ]);
  expect(top?.model).toBe("big");
  expect([value?.model, value?.usd]).toEqual(["mid", 0.8]);
});
