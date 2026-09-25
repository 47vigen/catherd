import { describe, expect, it } from "bun:test";
import { CatherdError, isCatherdError } from "../../src/domain/errors.ts";
import { assertId, formatRung, newDispatchId, parseRung } from "../../src/domain/ids.ts";

describe("CatherdError", () => {
  it("carries a code and a fix, and serialises without the stack", () => {
    const e = new CatherdError("E_ADMIT_RUNG", "bad rung", { fix: "use backend:model#effort" });
    expect(isCatherdError(e)).toBe(true);
    expect(e).toBeInstanceOf(Error);
    expect(e.toJSON()).toEqual({
      code: "E_ADMIT_RUNG",
      message: "bad rung",
      fix: "use backend:model#effort",
    });
  });
});

describe("parseRung", () => {
  it("splits backend at the first colon and effort at the last #", () => {
    expect(parseRung("codex:gpt-6-sol#high")).toEqual({
      backend: "codex",
      model: "gpt-6-sol",
      effort: "high",
    });
    expect(parseRung("opencode:opencode-go/kimi-k3#default")).toEqual({
      backend: "opencode",
      model: "opencode-go/kimi-k3",
      effort: "default",
    });
    expect(parseRung("claude:claude-opus-5-5#high").backend).toBe("claude");
  });

  it("round-trips through formatRung", () => {
    expect(formatRung(parseRung("claude-code:claude-sonnet-5#max"))).toBe("claude-code:claude-sonnet-5#max");
  });

  it.each(["gpt-6-sol#high", "codex:#high", "codex:gpt-6-sol#", "codex:gpt-6-sol", "nope:m#e", ""])(
    "rejects %p with E_ADMIT_RUNG",
    (bad) => {
      try {
        parseRung(bad);
        throw new Error("expected a throw");
      } catch (e) {
        expect(isCatherdError(e) && e.code).toBe("E_ADMIT_RUNG");
      }
    },
  );
});

describe("assertId", () => {
  it("accepts file-safe ids and rejects separators, dots first, and empties", () => {
    expect(assertId("lane", "M1.L2")).toBe("M1.L2");
    for (const bad of ["../x", "a/b", ".hidden", "", "a b", "-flag"]) {
      expect(() => assertId("lane", bad)).toThrow(CatherdError);
    }
  });
});

describe("newDispatchId", () => {
  it("is 26 Crockford base32 chars and sorts by time", () => {
    const a = newDispatchId(1_000);
    const b = newDispatchId(2_000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
    expect(newDispatchId(5)).not.toBe(newDispatchId(5));
  });

  it("stays strictly increasing within one millisecond and when the clock steps back", () => {
    const ids = Array.from({ length: 1000 }, () => newDispatchId(7_000));
    ids.push(newDispatchId(6_000), newDispatchId(7_000));
    for (let i = 1; i < ids.length; i++) expect((ids[i - 1] as string) < (ids[i] as string)).toBe(true);
    for (const id of ids) expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
