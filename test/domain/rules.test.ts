import { describe, expect, it } from "bun:test";
import { ruleRoles, rulesBlock, rulesFor, tagNames } from "../../src/domain/rules.ts";

const L = [
  "- 2026-10-12 by hand: always A",
  "- 2026-10-12 shop: M3 x: [worker, reviewer] only B",
  "[verifier] only C",
  "- 2026-10-12 by hand: [x] done list",
  "- 2026-10-12 t M1: use arr[i] here",
];

describe("standing rules by role", () => {
  it("gives a tagged rule only to its roles, without the tag, and an untagged one to every role", () => {
    expect(rulesFor(L.join("\n"), "worker")).toBe(
      [L[0], "- 2026-10-12 shop: M3 x: only B", L[3], L[4]].join("\n"),
    );
    expect(rulesFor(L.join("\n"), "verifier")).toBe([L[0], "only C", L[3], L[4]].join("\n"));
    expect(rulesFor(L.join("\n"), "writer")).toBe([L[0], L[3], L[4]].join("\n"));
    expect(rulesFor("- 2026-10-21 rules review r1: [judge] J", "judge")).toBe(
      "- 2026-10-21 rules review r1: J",
    );
  });

  it("leaves a bracket group that names no role as text for every role", () => {
    expect(tagNames("- 2026-10-12 by hand: [worker, revewer] x")).toEqual(["worker", "revewer"]);
    expect(ruleRoles("- 2026-10-12 by hand: [worker, revewer] x")).toBeNull();
    expect(ruleRoles(L[4] as string)).toBeNull();
    expect(rulesBlock("", "worker")).toBe("");
    expect(rulesBlock("always A", "worker")).toBe(
      "Standing rules for the worker role in this repo (its knowledge.md):\nalways A",
    );
  });
});
