import { describe, expect, it } from "bun:test";
import { fileOf, parseFailLines, parseFindings } from "../../src/domain/findings.ts";

describe("fileOf", () => {
  it("takes the first path or path:line among a finding's first words", () => {
    expect(fileOf("src/a.ts:3 — x — y")).toBe("src/a.ts");
    expect(fileOf("`src/b/c.ts:10-12` — x")).toBe("src/b/c.ts");
    expect(fileOf("README.md — typo")).toBe("README.md");
    expect(fileOf("the wallet is wrong")).toBeNull();
    expect(fileOf("— no file here: src/late.ts")).toBeNull();
  });
});

describe("parseFindings", () => {
  it("reads BLOCKER, BUG and NIT lines with their files, in order, and skips none lines", () => {
    const reply = [
      "I read the diff.",
      "BLOCKER src/a.ts:3 — x — y",
      "- BUG: none",
      "* **NIT** b.md — z",
      "2. BUG n/a",
      "BUG the totals never add up — fix it",
      "STATUS: complete — done",
    ].join("\n");
    expect(parseFindings(reply)).toEqual([
      { label: "BLOCKER", text: "BLOCKER src/a.ts:3 — x — y", file: "src/a.ts" },
      { label: "NIT", text: "* **NIT** b.md — z", file: "b.md" },
      { label: "BUG", text: "BUG the totals never add up — fix it", file: null },
    ]);
  });

  it("finds nothing in a clean reply", () => {
    expect(parseFindings("CLEAN\nSTATUS: complete — no findings")).toEqual([]);
  });
});

describe("parseFailLines", () => {
  it("lists what a failing verifier wrote under its verdict as blockers", () => {
    const reply = [
      "",
      "VERDICT: FAIL",
      "- src/a.test.ts: 2 tests fail (bun test src/a.test.ts)",
      "",
      "2. lint: src/b.ts:4 unused import",
      "STATUS: complete — failed",
    ].join("\n");
    expect(parseFailLines(reply)).toEqual([
      {
        label: "BLOCKER",
        text: "src/a.test.ts: 2 tests fail (bun test src/a.test.ts)",
        file: "src/a.test.ts",
      },
      { label: "BLOCKER", text: "lint: src/b.ts:4 unused import", file: "src/b.ts" },
    ]);
  });
});
