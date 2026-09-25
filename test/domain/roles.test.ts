import { describe, expect, it } from "bun:test";
import { claudeBackendFor, ROLES } from "../../src/domain/roles.ts";

describe("claudeBackendFor", () => {
  it("runs architect and verifier as native subagents and every other role headless", () => {
    expect(ROLES.filter((r) => claudeBackendFor(r) === "claude")).toEqual(["architect", "verifier"]);
    expect(claudeBackendFor("worker")).toBe("claude-code");
  });
});
