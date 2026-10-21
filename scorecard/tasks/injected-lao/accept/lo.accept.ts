import { describe, expect, it } from "vitest";
import { normalizeDigits } from "./normalizer.js";

describe("Lao digits (scorecard acceptance)", () => {
  it("reads Lao digits as ASCII with no locale import", () => {
    expect(normalizeDigits("໐໑໒໓໔໕໖໗໘໙")).toBe("0123456789");
  });
});
