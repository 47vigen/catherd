import { describe, expect, it } from "bun:test";
import { cutText, isPlain, maskFences, median, slug } from "../../src/domain/util.ts";

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

  it("blanks fenced lines and keeps offsets", () => {
    const text = "# a\n```md\n## b\n```\n~~~\n## c\n~~~\n## d";
    const masked = maskFences(text);
    expect(masked.length).toBe(text.length);
    expect(masked.split("\n").filter((l) => l.startsWith("#"))).toEqual(["# a", "## d"]);
    expect(maskFences("```\nopen\n## x").includes("##")).toBe(false);
  });

  it("cuts at a line, within UTF-8 bytes, closing an open fence", () => {
    const text = "one\n```sh\ntwo\nthree\n```\nfour";
    const cut = cutText(text, 18);
    expect(cut).toBe("one\n```sh\ntwo\n```");
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(18);
    expect(cutText(text, 1000)).toBe(text);
    const wide = `${"\u{1F600}".repeat(10)}`;
    const part = cutText(wide, 10);
    expect(Buffer.byteLength(part)).toBeLessThanOrEqual(10);
    expect(part).toBe("\u{1F600}\u{1F600}");
    expect(cutText("a\nb", 0)).toBe("");
  });
});
