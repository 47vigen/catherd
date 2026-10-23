import { describe, expect, it } from "bun:test";
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
  it("keeps at most 60 lines of at most 300 characters", () => {
    const out = Array.from({ length: 80 }, (_, i) => `FAIL t${i} ${"x".repeat(400)}`).join("\n");
    expect(checkFailLines(out)).toHaveLength(60);
    expect(checkFailLines(out)[0]).toHaveLength(300);
  });
  it("names the lines the base does not have", () => {
    expect(newFails(["FAIL a", "FAIL b"], ["FAIL a"])).toEqual(["FAIL b"]);
    expect(newFails(["FAIL a"], null)).toEqual(["FAIL a"]);
  });
});
