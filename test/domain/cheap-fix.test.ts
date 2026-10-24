import { describe, expect, it } from "bun:test";
import { mechanicalFix, mechanicalNote } from "../../src/domain/cheap-fix.ts";

const check = (tail: string) => `The fast check failed (exit 1); its last lines:\n${tail}`;

describe("mechanicalNote", () => {
  it("NIT, lint and type-check notes are mechanical", () => {
    expect(mechanicalNote("NIT src/a.ts:3 — rename x")).toBe(true);
    expect(mechanicalNote("BUG src/a.ts:3 — the comment restates the code")).toBe(true);
    expect(mechanicalNote(check("src/a.ts(3,1): error TS2304: Cannot find name 'x'."))).toBe(true);
  });

  it("a BLOCKER, a logic BUG, a failing test or an answer is not", () => {
    expect(mechanicalNote("BLOCKER src/a.ts:1 — unused import")).toBe(false);
    expect(mechanicalNote("BUG completed refunds keep refund_requested_at")).toBe(false);
    expect(mechanicalNote(check("(fail) a > b\n  expect(received).toBe(1)"))).toBe(false);
    expect(mechanicalNote("The owner answered: fix the lint")).toBe(false);
    expect(mechanicalNote("The judge answered: NIT it")).toBe(false);
  });

  it("a tail mixing a type error and a failing test is not", () => {
    expect(mechanicalNote(check("error TS2304: x\n(fail) a > b"))).toBe(false);
  });
});

describe("mechanicalFix", () => {
  it("needs every note and at least one", () => {
    expect(mechanicalFix([])).toBe(false);
    expect(mechanicalFix(["NIT a", "NIT b"])).toBe(true);
    expect(mechanicalFix(["NIT a", "BLOCKER b"])).toBe(false);
  });
});
