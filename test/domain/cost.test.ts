import { describe, expect, it } from "bun:test";
import {
  CHATGPT_UNIT_USD,
  compareCost,
  costOf,
  DEFAULT_BILLING,
  effortFactor,
  taskUsd,
  tokensUsd,
} from "../../src/domain/cost.ts";
import type { Pair } from "../../src/domain/catalog.ts";
import { shippedModels } from "./shipped.ts";

const pair = (price: Pair["price"] = { input: 1, output: 5 }): Pair => ({
  intelligence: 40,
  price,
  speed: null,
  context: null,
});
const fam = (id: string) => {
  const f = shippedModels().families.find((x) => x.id === id);
  if (!f) throw new Error(id);
  return f;
};

describe("cost rank (spec §5.3)", () => {
  it("keeps the chatgpt-plan unit equal to one GPT-6 Luna task at medium", () => {
    expect(taskUsd({ input: 0.1, output: 0.5 }, "medium")).toBeCloseTo(CHATGPT_UNIT_USD, 6);
  });

  it("counts cached input at a tenth of the input price", () => {
    expect(taskUsd({ input: 2, output: 10 }, "medium")).toBeCloseTo(0.38, 9);
  });

  it("weights ChatGPT-plan rungs by the official quota: Luna 1, Sol 20, Astra 60, times the effort", () => {
    const v = (id: string, e: string) => costOf(fam(id), pair(), e, "chatgpt-plan").value as number;
    expect(v("gpt-6-sol", "medium") / v("gpt-6-luna", "medium")).toBeCloseTo(20, 6);
    expect(v("gpt-6-astra", "medium") / v("gpt-6-luna", "medium")).toBeCloseTo(60, 6);
    expect(v("gpt-6-luna", "high")).toBeLessThan(v("gpt-6-sol", "medium"));
    expect(v("gpt-6-sol", "ultra")).toBeGreaterThan(v("gpt-6-sol", "max"));
  });

  it("ranks Claude-plan rungs by API price, with Fable metered", () => {
    const opus = costOf(fam("claude-opus-5-5"), pair({ input: 5, output: 25 }), "high", "claude-plan");
    const haiku = costOf(fam("claude-4-5-haiku"), pair({ input: 1, output: 5 }), "default", "claude-plan");
    const fable = costOf(fam("claude-fable-5-1"), pair({ input: 8, output: 40 }), "low", "claude-plan");
    expect([opus.tier, haiku.tier, fable.tier]).toEqual([0, 0, 1]);
    expect(compareCost(haiku, opus)).toBeLessThan(0);
  });

  it("puts every subscription rung before any metered rung, whatever the value", () => {
    const zenLuna = costOf(fam("gpt-6-luna"), pair(), "low", "metered");
    const solMax = costOf(fam("gpt-6-sol"), pair(), "max", "chatgpt-plan");
    const goLuna = costOf(fam("gpt-6-luna"), pair(), "high", "subscription");
    expect(compareCost(solMax, zenLuna)).toBeLessThan(0);
    expect(compareCost(goLuna, zenLuna)).toBeLessThan(0);
  });

  it("prices an unpriced plan or subscription rung at 0 in its tier, and an unknown effort as medium", () => {
    for (const mode of ["subscription", "chatgpt-plan", "claude-plan"] as const)
      expect(costOf(null, null, "high", mode)).toEqual({ tier: 0, value: 0, mode });
    const unpriced = costOf(null, null, "max", "subscription");
    expect(compareCost(unpriced, costOf(fam("gpt-6-luna"), pair(), "low", "subscription"))).toBeLessThan(0);
    expect(compareCost(unpriced, costOf(fam("gpt-6-luna"), pair(), "low", "metered"))).toBeLessThan(0);
    expect(effortFactor("thinking")).toBe(1);
  });

  it("treats a pair with no price as unpriced: last when metered or metered on the Claude plan, 0 otherwise", () => {
    const none = pair(null);
    expect(costOf(fam("gpt-6-sol"), none, "high", "metered")).toEqual({
      tier: 1,
      value: null,
      mode: "metered",
    });
    expect(costOf(fam("claude-fable-5-1"), none, "high", "claude-plan")).toEqual({
      tier: 1,
      value: null,
      mode: "claude-plan",
    });
    expect(costOf(fam("claude-opus-5-5"), none, "high", "claude-plan")).toEqual({
      tier: 0,
      value: 0,
      mode: "claude-plan",
    });
    expect(costOf(fam("gpt-6-luna"), none, "high", "subscription")).toEqual({
      tier: 0,
      value: 0,
      mode: "subscription",
    });
    // a plan weight prices a chatgpt-plan rung with or without a price
    expect(costOf(fam("gpt-6-sol"), none, "medium", "chatgpt-plan").value).toBeGreaterThan(0);
  });

  it("orders an unpriced metered rung last in its tier", () => {
    const unknown = costOf(null, null, "high", "metered");
    expect(unknown).toEqual({ tier: 1, value: null, mode: "metered" });
    expect(compareCost(costOf(fam("gpt-6-sol"), pair(), "max", "metered"), unknown)).toBeLessThan(0);
  });

  it("bills the spec's default keys", () => {
    expect(DEFAULT_BILLING).toMatchObject({
      codex: "chatgpt-plan",
      claude: "claude-plan",
      "claude-code": "claude-plan",
      "opencode-go": "subscription",
      opencode: "metered",
    });
  });
});

it("tokensUsd prices uncached, cache read, cache write and output", () => {
  const price = { input: 2, output: 10 };
  expect(
    tokensUsd(price, { input: 1_000_000, cached: 400_000, cacheWrite: 200_000, output: 100_000 }),
  ).toBeCloseTo(2.38, 9);
  expect(tokensUsd(price, { input: 1_000_000, cached: 400_000, output: 100_000 })).toBeCloseTo(2.28, 9);
});
