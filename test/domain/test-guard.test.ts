import { describe, expect, it } from "bun:test";
import { guardedEdits, TEST_PATH } from "../../src/domain/test-guard.ts";

describe("the test guard", () => {
  it("a changed test file outside Owns is guarded", () => {
    const changed = ["test/a.test.ts", "src/a.ts", "pkg/x_test.go"];
    expect(guardedEdits(changed, ["src/"])).toEqual(["test/a.test.ts", "pkg/x_test.go"]);
    expect(guardedEdits(changed, ["test/"])).toEqual(["pkg/x_test.go"]);
  });

  it("recognises the test path shapes", () => {
    for (const p of [
      "tests/a.ts",
      "a/__tests__/b.ts",
      "x/spec/y.rb",
      "a.spec.mjs",
      "t/test_a.py",
      "a_test.py",
    ])
      expect(TEST_PATH.test(p)).toBe(true);
    for (const p of ["src/contest/a.ts", "src/latest.ts", "docs/a.md"]) expect(TEST_PATH.test(p)).toBe(false);
  });
});
