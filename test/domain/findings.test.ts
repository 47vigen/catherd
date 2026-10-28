import { describe, expect, it } from "bun:test";
import { fileOf, filesOf, parseFailLines, parseFindings, unlistedFail } from "../../src/domain/findings.ts";

describe("fileOf", () => {
  it("takes the first path or path:line among a finding's first words", () => {
    expect(fileOf("src/a.ts:3 — x — y")).toBe("src/a.ts");
    expect(fileOf("`src/b/c.ts:10-12` — x")).toBe("src/b/c.ts");
    expect(fileOf("README.md — typo")).toBe("README.md");
    expect(fileOf("the wallet is wrong")).toBeNull();
    expect(fileOf("— no file here: src/late.ts")).toBe("src/late.ts");
  });

  it("comma and L line lists keep their path", () => {
    expect(fileOf("BUG src/domain/run-state.ts:152,401,522 — x")).toBe("src/domain/run-state.ts");
    expect(fileOf("src/a.ts:L12")).toBe("src/a.ts");
  });
});

describe("fileOf over the whole text", () => {
  it("a ~ line mark keeps its path and a route is no file", () => {
    const text =
      "BUG /models tooltip — raw float — at web/src/routes/_app/models/-components/CostChart.tsx:~58 — /tmp/shots/m33.png";
    expect(fileOf(text)).toBe("web/src/routes/_app/models/-components/CostChart.tsx");
    expect(filesOf(text)).not.toContain("/models");
    expect(filesOf(text)).toContain("/tmp/shots/m33.png");
  });

  it("fileOf reads past the fourth word", () => {
    expect(fileOf("BUG run graph, Fit to view — hides nodes (`graph/RunGraph.tsx`)")).toBe(
      "graph/RunGraph.tsx",
    );
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

describe("unlistedFail", () => {
  it("quotes the first line a FAIL verdict said, past its HEAD and PASS lines", () => {
    const reply = [
      "VERDICT: FAIL",
      "HEAD: abc",
      "A1 PASS — bun test: 12 pass",
      "- src/a.test.ts: 2 tests fail",
      "STATUS: complete — failed",
    ].join("\n");
    expect(unlistedFail(reply)).toEqual({
      label: "BLOCKER",
      text: "verifier FAIL listed no failing line: src/a.test.ts: 2 tests fail",
      file: "src/a.test.ts",
    });
  });

  it("says so when the FAIL verdict named nothing", () => {
    expect(unlistedFail("VERDICT: FAIL\nSTATUS: complete — failed")).toEqual({
      label: "BLOCKER",
      text: "verifier FAIL listed no failing line: nothing after the verdict",
      file: null,
    });
  });

  it("quotes the line that names a file over a heading above it", () => {
    const reply = [
      "VERDICT: FAIL",
      "**Gate items**",
      "- bun test: 2 red",
      "- src/a.test.ts: 2 tests fail",
      "STATUS: complete — failed",
    ].join("\n");
    expect(unlistedFail(reply)).toEqual({
      label: "BLOCKER",
      text: "verifier FAIL listed no failing line: src/a.test.ts: 2 tests fail",
      file: "src/a.test.ts",
    });
  });

  it("keeps a failing line that also says PASS", () => {
    const reply = ["VERDICT: FAIL", "- src/a.test.ts: 2 PASS, 1 fail"].join("\n");
    expect(unlistedFail(reply)).toEqual({
      label: "BLOCKER",
      text: "verifier FAIL listed no failing line: src/a.test.ts: 2 PASS, 1 fail",
      file: "src/a.test.ts",
    });
  });
});

describe("parseFindings on the spec D8 scale (plan 51)", () => {
  it("reads IMPORTANT, NIT and PRE-EXISTING lines with their bug class, and an earlier build's BUG", () => {
    const reply = [
      "IMPORTANT (unchecked null) src/a.ts:3 — crashes — on an empty cart — guard it",
      "- PRE-EXISTING (paging off by one): src/b.ts:9 — skips a row",
      "NIT none",
      "BUG src/c.ts — old severity",
    ].join("\n");
    expect(parseFindings(reply)).toEqual([
      { label: "IMPORTANT", text: reply.split("\n")[0] as string, file: "src/a.ts", class: "unchecked null" },
      {
        label: "PRE-EXISTING",
        text: "- PRE-EXISTING (paging off by one): src/b.ts:9 — skips a row",
        file: "src/b.ts",
        class: "paging off by one",
      },
      { label: "BUG", text: "BUG src/c.ts — old severity", file: "src/c.ts" },
    ]);
  });
});
