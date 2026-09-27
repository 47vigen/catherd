import { describe, expect, it } from "bun:test";
import { isPlain, median, slug } from "../../src/domain/util.ts";

describe("util", () => {
  it("slugs to lower-case words joined by one dash, none at the ends", () => {
    expect(slug("Claude Opus 5.5")).toBe("claude-opus-5-5");
    expect(slug("--Fix: the  CLI!--")).toBe("fix-the-cli");
    expect(slug("***")).toBe("");
  });

  it("takes the middle value, the mean of the two middle ones for an even count, null for none", () => {
    expect(median([])).toBeNull();
    expect(median([7])).toBe(7);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    const xs = [3, 1];
    median(xs);
    expect(xs).toEqual([3, 1]);
  });

  it("calls only non-null, non-array objects plain", () => {
    expect(isPlain({ a: 1 })).toBe(true);
    expect(isPlain([])).toBe(false);
    expect(isPlain(null)).toBe(false);
    expect(isPlain("x")).toBe(false);
  });
});
