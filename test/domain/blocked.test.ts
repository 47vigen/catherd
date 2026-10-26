import { describe, expect, it } from "bun:test";
import {
  BLOCKED_LINE,
  BLOCKED_REASONS,
  foreignFailure,
  siblingLanesNamed,
  parseBlockedReason,
} from "../../src/domain/blocked.ts";

describe("blocked reasons", () => {
  it("reads a blocked reply's reason and its why", () => {
    expect(parseBlockedReason("check_broken: lint fails in src/b.ts")).toEqual({
      reason: "check_broken",
      why: "lint fails in src/b.ts",
    });
    expect(parseBlockedReason("`needs-user` — keep v1?")).toEqual({
      reason: "needs_user",
      why: "keep v1?",
    });
    expect(parseBlockedReason("the tests do not pass")).toBeNull();
    expect(parseBlockedReason(null)).toBeNull();
  });

  it("names only sibling files, from two path segments", () => {
    expect(
      foreignFailure("src/b.ts:3:1 error unused import", ["src/a.ts"], ["src/b.ts", "src/c.ts"]),
    ).toEqual(["src/b.ts"]);
    expect(foreignFailure("FAIL pkg/x/y.go:3", ["src/a.ts"], ["pkg/x/"])).toEqual(["pkg/x"]);
    expect(foreignFailure("FAIL web/pkg/x/y.go:3", ["src/a.ts"], ["web/pkg/x/**"])).toEqual(["web/pkg/x"]);
    expect(foreignFailure("timeout after 120 s", ["src/a.ts"], ["src/b.ts"])).toEqual([]);
  });

  it("a sibling named beside an own file is still named", () => {
    const siblings = [
      { id: "M1.L2", owns: ["src/b.ts"] },
      { id: "M1.L3", owns: ["src/c.ts"] },
    ];
    expect(siblingLanesNamed("src/a.ts:1 error\nsrc/b.ts:3 error", siblings)).toEqual(["M1.L2"]);
    expect(siblingLanesNamed("timeout", siblings)).toEqual([]);
  });

  it("is not foreign when the log also names an own file", () => {
    expect(foreignFailure("src/b.ts:3 x\na.ts(4,2): error", ["src/a.ts"], ["src/b.ts"])).toEqual([]);
  });

  it("lists the six reasons in the prompt line, in order", () => {
    expect(BLOCKED_LINE).toContain("STATUS: blocked — <reason>: <why>");
    const at = BLOCKED_REASONS.map((r) => BLOCKED_LINE.indexOf(`${r} (`));
    expect(at.every((x, i) => x > (at[i - 1] ?? -1))).toBe(true);
  });
});
