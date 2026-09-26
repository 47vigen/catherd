import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assetPath } from "../../src/infra/assets.ts";

describe("assetPath", () => {
  it("finds the shipped catalog from the package root", () => {
    expect(assetPath("catalog/models.json")).toBe(
      join(import.meta.dir, "..", "..", "catalog", "models.json"),
    );
    expect(existsSync(assetPath("catalog/scores.json"))).toBe(true);
  });
});
