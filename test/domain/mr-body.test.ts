import { describe, expect, it } from "bun:test";
import { isTestPath, mrBody, removedTests, SKIP_LINE, testChangeLines } from "../../src/domain/mr-body.ts";

describe("the merge request body (plan 50, spec D11)", () => {
  const body = mrBody({
    title: "Split the wallet",
    aLines: ["A1 a refund keeps its currency"],
    done: ["T1 the split"],
    proof: {
      command: "bun test",
      sha: "0123456789abcdef",
      log: "checks/C2.log",
    },
    audit: ["architect-2 delegated T1 to the worker on codex:a#high: the split first"],
    knownIssues: ["L3 impossible: the provider has no sandbox"],
    tests: {
      deleted: ["src/old.test.ts"],
      removed: ["src/pay.test.ts: refunds keep their currency"],
      rewritten: ["src/fee.test.ts (-3 lines)"],
      skipped: ['it.skip("flaky")'],
    },
    oracle: ["T1 (L1) changed test/pay.test.ts: the test asserted the old fee"],
  });

  it("leads with the problem in the owner's words, then the change and one proof line, the audit last", () => {
    const at = (s: string) => body.indexOf(s);
    expect(body.startsWith("## Problem\n\nSplit the wallet\n\n- A1 a refund keeps its currency")).toBe(true);
    expect(at("## Change")).toBeLessThan(at("Proof: `bun test` passed on 0123456789ab (checks/C2.log)"));
    expect(at("Proof:")).toBeLessThan(at("## Audit"));
    for (const line of [
      "- L3 impossible: the provider has no sandbox",
      "### Oracle overrides",
      "- T1 (L1) changed test/pay.test.ts: the test asserted the old fee",
      "### Tests deleted, removed, rewritten or skipped",
      "- deleted src/old.test.ts",
      "- removed or renamed src/pay.test.ts: refunds keep their currency",
      "- rewritten src/fee.test.ts (-3 lines)",
      '- skipped: it.skip("flaky")',
      "- architect-2 delegated T1 to the worker on codex:a#high: the split first",
    ])
      expect(at(line)).toBeGreaterThan(at("## Audit"));
  });

  it("says how many failures a passing-with-inherited proof leaves to the base (plan 52)", () => {
    const b = mrBody({
      title: "t",
      aLines: [],
      done: [],
      proof: {
        command: "bun test",
        sha: "0123456789abcdef",
        log: "checks/C2.log",
        inherited: 2,
      },
      audit: [],
      knownIssues: [],
      tests: { deleted: [], removed: [], rewritten: [], skipped: [] },
      oracle: [],
    });
    expect(b).toContain(
      "Proof: `bun test` passed but for 2 failures the base has too, on 0123456789ab (checks/C2.log)",
    );
  });

  it("says when no full check has passed, and none for an empty list", () => {
    const empty = mrBody({
      title: "t",
      aLines: [],
      done: [],
      proof: null,
      audit: [],
      knownIssues: [],
      tests: { deleted: [], removed: [], rewritten: [], skipped: [] },
      oracle: [],
    });
    expect(empty).toContain("Proof: no full check has passed on this commit yet");
    expect(empty).toContain("### Known issues\n\n- none");
  });

  it("knows a test path and a skipped test", () => {
    expect(["src/a.test.ts", "test/x.ts", "pkg/a_test.go", "web/e2e/b.spec.ts"].every(isTestPath)).toBe(true);
    expect(["src/a.ts", "docs/testing.md"].some(isTestPath)).toBe(false);
    expect(
      ['  it.skip("x", () => {', "func TestX(t *testing.T) { t.Skip()", "@pytest.mark.skip"].every((l) =>
        SKIP_LINE.test(l),
      ),
    ).toBe(true);
    expect(SKIP_LINE.test('it("skips nothing", () => {')).toBe(false);
  });

  it("names a test case the diff removes, and not one it only moved or edited (plan 54)", () => {
    const diff = [
      "diff --git a/src/pay.test.ts b/src/pay.test.ts",
      "--- a/src/pay.test.ts",
      "+++ b/src/pay.test.ts",
      '-  it("refunds keep their currency", () => {',
      '-  test("moves", () => {',
      '+  test("moves", () => {',
      "-    expect(a).toBe(1);",
      "diff --git a/src/pay.ts b/src/pay.ts",
      "--- a/src/pay.ts",
      "+++ b/src/pay.ts",
      '-  it("is no test file", () => {',
      "diff --git a/pkg/a_test.go b/pkg/a_test.go",
      "--- a/pkg/a_test.go",
      "+++ /dev/null",
      "-func TestGone(t *testing.T) {",
      "diff --git a/tests/test_fee.py b/tests/test_fee.py",
      "--- a/tests/test_fee.py",
      "+++ b/tests/test_fee.py",
      "-def test_fee_rounds():",
    ].join("\n");
    expect(removedTests(diff)).toEqual([
      "src/pay.test.ts: refunds keep their currency",
      "pkg/a_test.go: TestGone",
      "tests/test_fee.py: test_fee_rounds",
    ]);
  });

  it("takes a removed test's file from the +++ line and never from the file before it (plan 54)", () => {
    const diff = [
      "diff --git a/src/pay.test.ts b/src/pay.test.ts",
      "--- a/src/pay.test.ts",
      "+++ b/src/pay.test.ts",
      '-it("one", () => {',
      'diff --git "a/src/\\303\\251.test.ts" "b/src/\\303\\251.test.ts"',
      '--- "a/src/\\303\\251.test.ts"',
      '+++ "b/src/\\303\\251.test.ts"',
      '-it("quoted", () => {',
      "diff --git a/src/é.test.ts b/src/é.test.ts",
      "--- a/src/é.test.ts",
      "+++ b/src/é.test.ts",
      '-it("two", () => {',
      "diff --git a/src/b c.test.ts b/src/b c.test.ts",
      "--- a/src/b c.test.ts\t",
      "+++ /dev/null",
      '-it("three", () => {',
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
      '-it("four", () => {',
    ].join("\n");
    expect(removedTests(diff)).toEqual([
      "src/pay.test.ts: one",
      "src/é.test.ts: two",
      "src/b c.test.ts: three",
    ]);
  });

  it("counts a test name added anywhere in the diff as moved (plan 54)", () => {
    const diff = [
      "diff --git a/a.test.ts b/a.test.ts",
      "--- a/a.test.ts",
      "+++ b/a.test.ts",
      '-it("moved", () => {',
      '-it("gone", () => {',
      "diff --git a/b.test.ts b/b.test.ts",
      "--- a/b.test.ts",
      "+++ b/b.test.ts",
      '+it("moved", () => {',
    ].join("\n");
    expect(removedTests(diff)).toEqual(["a.test.ts: gone"]);
  });

  it("lists at most 20 removed tests and counts the rest, worded removed or renamed (plan 54)", () => {
    const removed = Array.from({ length: 23 }, (_, n) => `a.test.ts: t${n}`);
    const lines = testChangeLines({
      deleted: [],
      removed,
      rewritten: [],
      skipped: [],
    });
    expect(lines).toHaveLength(21);
    expect(lines[0]).toBe("removed or renamed a.test.ts: t0");
    expect(lines[20]).toBe("and 3 more removed or renamed");
  });
});
