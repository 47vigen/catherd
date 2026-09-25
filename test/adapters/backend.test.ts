import { describe, expect, it } from "bun:test";
import { compareVersions, extractVersion } from "../../src/adapters/backend.ts";

describe("versions", () => {
  it("extracts the first semver in a --version line", () => {
    expect(extractVersion("codex-cli 0.157.0")).toBe("0.157.0");
    expect(extractVersion("opencode 2.0.16 (abc)")).toBe("2.0.16");
    expect(extractVersion("no version")).toBeNull();
  });

  it("compares numerically, not lexically", () => {
    expect(compareVersions("0.157.0", "0.99.9")).toBeGreaterThan(0);
    expect(compareVersions("2.0.16", "2.0.16")).toBe(0);
    expect(compareVersions("1.18.32", "2.0.0")).toBeLessThan(0);
  });
});
