import { describe, expect, it } from "bun:test";
import { calibrate, DIM_SOURCES, fitLine, MIN_R2, MIN_SHARED } from "../../src/domain/calibration.ts";
import { DIMS } from "../../src/domain/catalog.ts";

const map = (xs: [string, number][]) => new Map(xs);

describe("calibration (spec 1.2 §4.2)", () => {
  it("fits anchor = a·x + b by least squares, with its R²", () => {
    const f = fitLine([
      [0.1, 30],
      [0.2, 50],
      [0.3, 70],
    ]);
    expect(f?.a).toBeCloseTo(200, 6);
    expect(f?.b).toBeCloseTo(10, 6);
    expect(f?.r2).toBeCloseTo(1, 6);
    expect(fitLine([[1, 2]])).toBeNull();
    expect(
      fitLine([
        [1, 2],
        [1, 3],
      ]),
    ).toBeNull();
  });

  it("uses a source that shares five rungs with the anchor and fits with R² ≥ 0.5", () => {
    expect([MIN_SHARED, MIN_R2]).toEqual([5, 0.5]);
    const anchor = map([
      ["a#high", 50],
      ["b#high", 60],
      ["c#high", 70],
      ["d#high", 80],
      ["e#high", 90],
      ["only-anchor#high", 10],
    ]);
    const other = map([
      ["a#high", 0.5],
      ["b#high", 0.61],
      ["c#high", 0.69],
      ["d#high", 0.8],
      ["e#high", 0.9],
      ["only-other#high", 0.1],
    ]);
    const r = calibrate(anchor, other);
    expect(r.used).toBe(true);
    expect(r.n).toBe(5);
    expect(r.fit?.r2).toBeGreaterThan(0.99);
    expect((r.fit?.a ?? 0) * 0.7 + (r.fit?.b ?? 0)).toBeCloseTo(70, 0);
  });

  it("rejects a source with fewer than five shared rungs, and one whose fit has R² below 0.5", () => {
    const anchor = map([
      ["a#high", 50],
      ["b#high", 60],
      ["c#high", 70],
      ["d#high", 80],
      ["e#high", 90],
    ]);
    const four = calibrate(
      anchor,
      map([...anchor].slice(0, 4).map(([k, v]) => [k, v / 100] as [string, number])),
    );
    expect(four).toEqual({ fit: null, n: 4, used: false, why: "4 shared rungs; a fit needs 5" });
    const noise = calibrate(
      anchor,
      map([
        ["a#high", 3],
        ["b#high", 1],
        ["c#high", 4],
        ["d#high", 1],
        ["e#high", 3],
      ]),
    );
    expect(noise.used).toBe(false);
    expect(noise.fit?.r2).toBeLessThan(0.5);
    expect(noise.why).toStartWith("R² ");
  });

  it("anchors every dimension on a keyless source or the shipped file, never on Artificial Analysis", () => {
    expect(Object.keys(DIM_SOURCES)).toEqual([...DIMS]);
    for (const d of DIMS) {
      const a = DIM_SOURCES[d].anchor;
      expect(a === "shipped" || a.source !== "artificial-analysis").toBe(true);
    }
  });
});
