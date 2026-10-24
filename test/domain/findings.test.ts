import { describe, expect, it } from "bun:test";
import { fileOf, filesOf, parseFailLines, parseFindings } from "../../src/domain/findings.ts";

describe("fileOf", () => {
  it("takes the first path or path:line among a finding's first words", () => {
    expect(fileOf("src/a.ts:3 — x — y")).toBe("src/a.ts");
    expect(fileOf("`src/b/c.ts:10-12` — x")).toBe("src/b/c.ts");
    expect(fileOf("README.md — typo")).toBe("README.md");
    expect(fileOf("the wallet is wrong")).toBeNull();
    expect(fileOf("— no file here: src/late.ts")).toBeNull();
  });

  it("comma and L line lists keep their path", () => {
    expect(fileOf("BUG src/domain/run-state.ts:152,401,522 — x")).toBe("src/domain/run-state.ts");
    expect(fileOf("src/a.ts:L12")).toBe("src/a.ts");
  });
});

describe("filesOf", () => {
  it("lists every file of a multi-file finding, in order", () => {
    expect(filesOf("BLOCKER src/a.ts:3 and src/b/c.ts:10-12, README.md, then src/d.ts:L7 — x")).toEqual([
      "src/a.ts",
      "src/b/c.ts",
      "README.md",
      "src/d.ts",
    ]);
  });

  it("reads the L and comma forms of a line range", () => {
    expect(filesOf("src/a.ts:L12-L20 and src/b.ts:1,2,3")).toEqual(["src/a.ts", "src/b.ts"]);
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
  it("lists the FAIL and BUG lines a failing verifier wrote under its verdict as blockers", () => {
    const reply = [
      "",
      "VERDICT: FAIL",
      "- FAIL src/a.test.ts: 2 tests fail (bun test src/a.test.ts)",
      "",
      "2. BUG lint: src/b.ts:4 unused import",
      "STATUS: complete — failed",
    ].join("\n");
    expect(parseFailLines(reply)).toEqual([
      {
        label: "BLOCKER",
        text: "FAIL src/a.test.ts: 2 tests fail (bun test src/a.test.ts)",
        file: "src/a.test.ts",
      },
      { label: "BLOCKER", text: "BUG lint: src/b.ts:4 unused import", file: "src/b.ts" },
    ]);
  });

  it("a FAIL reply keeps only its failing lines", () => {
    const fails = Array.from({ length: 14 }, (_, i) => `FAIL src/c${i}.ts:${i + 1} — case ${i} breaks`);
    const reply = [
      "VERDICT: FAIL",
      "A1 PASS — bun test: 12 pass",
      "HEAD: abc",
      "**Gate items**",
      "A2 FAIL — src/a.ts:3 is wrong",
      "- **FAIL** src/b.ts:4 — also wrong",
      ...fails,
      "STATUS: complete — failed",
    ].join("\n");
    const found = parseFailLines(reply);
    expect(found).toHaveLength(16);
    expect(found.every((f) => f.text.includes("FAIL"))).toBe(true);
    expect(found[0]).toEqual({ label: "BLOCKER", text: "A2 FAIL — src/a.ts:3 is wrong", file: "src/a.ts" });
  });
});
