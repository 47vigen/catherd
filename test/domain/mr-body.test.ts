import { describe, expect, it } from "bun:test";
import { isTestPath, mrBody, removedTests, SKIP_LINE } from "../../src/domain/mr-body.ts";

describe("the merge request body (plan 50, spec D11)", () => {
  const body = mrBody({
    title: "Split the wallet",
    aLines: ["A1 a refund keeps its currency"],
    done: ["T1 the split"],
    proof: { command: "bun test", sha: "0123456789abcdef", log: "checks/C2.log" },
    audit: ["architect-2 delegated T1 to the worker on codex:a#high: the split first"],
    knownIssues: ["L3 impossible: the provider has no sandbox"],
    tests: {
      deleted: ["src/old.test.ts"],
      removed: ["src/pay.test.ts: refunds keep their currency"],
      rewritten: ["src/fee.test.ts (-3 lines)"],
      skipped: ['it.skip("flaky")'],
    },
  });

  it("leads with the problem in the owner's words, then the change and one proof line, the audit last", () => {
    const at = (s: string) => body.indexOf(s);
    expect(body.startsWith("## Problem\n\nSplit the wallet\n\n- A1 a refund keeps its currency")).toBe(true);
    expect(at("## Change")).toBeLessThan(at("Proof: `bun test` passed on 0123456789ab (checks/C2.log)"));
    expect(at("Proof:")).toBeLessThan(at("## Audit"));
    for (const line of [
      "- L3 impossible: the provider has no sandbox",
      "### Tests deleted, removed, rewritten or skipped",
      "- deleted src/old.test.ts",
      "- removed src/pay.test.ts: refunds keep their currency",
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
      proof: { command: "bun test", sha: "0123456789abcdef", log: "checks/C2.log", inherited: 2 },
      audit: [],
      knownIssues: [],
      tests: { deleted: [], removed: [], rewritten: [], skipped: [] },
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
});
