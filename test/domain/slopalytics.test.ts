import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseProxy, slopKey } from "../../src/domain/slopalytics.ts";

const proxyFixture = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "fixtures", "slopalytics-proxy.json"), "utf8"),
);

describe("slopKey", () => {
  it("keys a model as Slopalytics names its family", () => {
    expect(slopKey("gpt-6.1-sol")).toBe("gpt-6-1-sol");
    expect(slopKey("opencode-go/kimi-k3")).toBe("kimi-k3");
    expect(slopKey("GPT-5.6-Luna")).toBe("gpt-5-6-luna");
  });
});

describe("parseProxy", () => {
  it("keeps a record only with a positive intelligence, and reads a numeric string as a number and a bad one as missing", () => {
    const r = parseProxy(proxyFixture);
    const by = Object.fromEntries(r.models.map((m) => [`${m.family}#${m.effort}`, m]));
    expect(Object.keys(by).sort()).toEqual(["gemini-3-8-flash#low", "gpt-6-sol#high", "kimi-k3#max"]);
    expect(by["gemini-3-8-flash#low"]?.speed).toBeNull();
    expect(by["kimi-k3#max"]?.inputPrice).toBe(3);
    expect(Object.keys(by["gpt-6-sol#high"] as object).sort()).toEqual([
      "context",
      "effort",
      "family",
      "inputPrice",
      "intelligence",
      "outputPrice",
      "speed",
    ]);
    expect(r.fetchedAt).toBe(proxyFixture.fetchedAt);
  });

  it("takes a trimmed finite numeric string, and nothing else, as a number", () => {
    const price = (v: unknown) =>
      parseProxy({ models: [{ family: "m", effort: "high", intelligence: 40, inputPrice: v }] }).models[0]
        ?.inputPrice;
    expect(price(" 2.5 ")).toBe(2.5);
    for (const bad of ["", "  ", "abc", "Infinity", "1,5", true, [3]]) expect(price(bad)).toBeNull();
  });

  it("drops a record with no family or effort, and reads a bad context as missing", () => {
    const r = parseProxy({
      models: [
        { family: "", effort: "high", intelligence: 40 },
        { family: "m", effort: "", intelligence: 40 },
        { family: "m", effort: "low", intelligence: 0 },
        { family: "m", effort: "high", intelligence: 40, context: 1.5, speed: Number.NaN },
      ],
    });
    expect(r.models).toEqual([
      {
        family: "m",
        effort: "high",
        intelligence: 40,
        inputPrice: null,
        outputPrice: null,
        speed: null,
        context: null,
      },
    ]);
    expect(r.fetchedAt).toBeNull();
  });

  it("refuses a body with no models list", () => {
    expect(() => parseProxy({ fetchedAt: "x" })).toThrow("without a models list");
    expect(() => parseProxy(null)).toThrow("without a models list");
  });
});
