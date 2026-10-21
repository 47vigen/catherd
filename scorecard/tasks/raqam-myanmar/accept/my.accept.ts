import { describe, expect, it } from "vitest";
import { normalizeDigits } from "../core/normalizer.js";
import { MY_LOCALE_CODES } from "./index.js";
import { LOCALE_CODES } from "./my.js";

describe("raqam/locales/my (scorecard acceptance)", () => {
  it("reads Myanmar digits as ASCII", () => {
    expect(normalizeDigits("၁၂၃၄၅၆၇၈၉၀")).toBe("1234567890");
  });
  it("names its locale codes, re-exported from the locales index", () => {
    expect(LOCALE_CODES).toEqual(["my", "my-MM"]);
    expect(MY_LOCALE_CODES).toBe(LOCALE_CODES);
  });
});
