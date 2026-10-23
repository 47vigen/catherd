import { describe, expect, it } from "bun:test";
import * as failLines from "../../src/domain/fail-lines.ts";
import { andTail, checkFailLines, newFails } from "../../src/domain/fail-lines.ts";

describe("check failing lines", () => {
  it("andTail names what follows the first &&", () => {
    expect(andTail("a && b && c")).toBe("b && c");
    expect(andTail("bun test")).toBeNull();
    expect(andTail("a &&")).toBeNull();
  });
  it("strips colour, timings and counters, so two runs compare equal", () => {
    const a = checkFailLines("\x1b[31mFAIL\x1b[0m src/a.test.ts > adds [12.3ms]\nok 1 fine\n");
    expect(a).toEqual(checkFailLines("FAIL src/a.test.ts > adds (40 ms)\n"));
    expect(a).toEqual(["FAIL src/a.test.ts > adds"]);
  });
  it("keeps a vulnerability by its id, and the usual failure markers", () => {
    expect(
      checkFailLines(
        "Vulnerability #1: GO-2026-0042\n--- FAIL: TestX\nnot ok 3 y\npanic: boom\nerror: z\n(fail) w\n",
      ),
    ).toEqual([
      "vulnerability GO-2026-0042",
      "--- FAIL: TestX",
      "not ok 3 y",
      "panic: boom",
      "error: z",
      "(fail) w",
    ]);
  });
  it("no cap", () => {
    const out = Array.from({ length: 90 }, (_, i) => `FAIL t${i} ${"x".repeat(400)}`).join("\n");
    expect(checkFailLines(out)).toHaveLength(90);
    expect(checkFailLines(out)[0]).toHaveLength(300);
  });
  it("names the lines the base does not have", () => {
    expect(newFails(["FAIL a", "FAIL b"], ["FAIL a"])).toEqual(["FAIL b"]);
    expect(newFails(["FAIL a"], null)).toEqual(["FAIL a"]);
  });
});

describe("check items", () => {
  it("checkItems splits top-level && and keeps quoted &&", () => {
    expect(failLines.checkItems('a && b "x && y"')).toEqual(["a", 'b "x && y"']);
    expect(failLines.checkItems("bun test")).toEqual(["bun test"]);
    expect(failLines.checkItems("a 'x && y' && b")).toEqual(["a 'x && y'", "b"]);
  });
  it("checkItems keeps a subshell whole", () => {
    expect(failLines.checkItems('a && (cd web && b) && "x && y"')).toEqual([
      "a",
      "(cd web && b)",
      '"x && y"',
    ]);
    expect(failLines.checkItems("(cd web && bun run gen) && (cd web && bun test)")).toEqual([
      "(cd web && bun run gen)",
      "(cd web && bun test)",
    ]);
  });
  it("keeps nested parentheses and escaped quotes balanced", () => {
    const nested = String.raw`a "x \" && y" && (b && (c && d)) && e`;
    expect(failLines.checkItems(nested)).toEqual([String.raw`a "x \" && y"`, "(b && (c && d))", "e"]);
    expect(failLines.checkItems(String.raw`a \&\& b && c`)).toEqual([String.raw`a \&\& b`, "c"]);
    expect(andTail('a "x && y" && (b && c) && d')).toBe("(b && c) && d");
    expect(andTail('a "x && y"')).toBeNull();
  });
});

describe("failure normalization", () => {
  it("the same failure in two runs normalises equal", () => {
    const a =
      "FAIL verifier-M1 20261023-105527-run-audit-fixes-plan-39 /tmp/first/project/check.ts port 41234";
    const b = "FAIL verifier-M3 20261024-225501-another-run /var/tmp/second/project/check.ts port 52011";
    expect(failLines.normalizeFailLine(a)).toBe(failLines.normalizeFailLine(b));
    expect(checkFailLines(a)).toEqual(checkFailLines(b));
    expect(failLines.normalizeFailLine(a)).toBe("FAIL <role> <run> <tmp> port <port>");
  });
  it("normalizes absolute paths and address ports without hiding distinct failures", () => {
    expect(failLines.normalizeFailLine("error: worker-M1.L1 /workspace/one/a.ts 127.0.0.1:41234")).toBe(
      "error: <role> <path> 127.0.0.1:<port>",
    );
    expect(checkFailLines("FAIL one /workspace/a\nFAIL two /workspace/b")).toEqual([
      "FAIL one <path>",
      "FAIL two <path>",
    ]);
    expect(failLines.FAIL_DISPLAY_CAP).toBe(60);
  });
});
