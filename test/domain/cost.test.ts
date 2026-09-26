import { describe, expect, it } from "bun:test";
import {
  CHATGPT_UNIT_USD,
  compareCost,
  costOf,
  DEFAULT_BILLING,
  effortFactor,
  taskUsd,
} from "../../src/domain/cost.ts";
import { shippedModels } from "./shipped.ts";

const fam = (id: string) => {
  const f = shippedModels().families.find((x) => x.id === id);
  if (!f) throw new Error(id);
  return f;
};

describe("cost rank (spec §5.3)", () => {
  it("keeps the chatgpt-plan unit equal to one GPT-6 Luna task at medium", () => {
    expect(taskUsd(fam("gpt-6-luna").price, "medium")).toBeCloseTo(CHATGPT_UNIT_USD, 6);
  });

  it("weights ChatGPT-plan rungs by the official quota: Luna 1, Sol 20, Astra 60, times the effort", () => {
    const v = (id: string, e: string) => costOf(fam(id), e, "chatgpt-plan").value as number;
    expect(v("gpt-6-sol", "medium") / v("gpt-6-luna", "medium")).toBeCloseTo(20, 6);
    expect(v("gpt-6-astra", "medium") / v("gpt-6-luna", "medium")).toBeCloseTo(60, 6);
    expect(v("gpt-6-luna", "high")).toBeLessThan(v("gpt-6-sol", "medium"));
    expect(v("gpt-6-sol", "ultra")).toBeGreaterThan(v("gpt-6-sol", "max"));
  });

  it("ranks Claude-plan rungs by API price, with Fable metered", () => {
    const opus = costOf(fam("claude-opus-5-5"), "high", "claude-plan");
    const haiku = costOf(fam("claude-haiku-4-5"), "default", "claude-plan");
    const fable = costOf(fam("claude-fable-5-1"), "low", "claude-plan");
    expect([opus.tier, haiku.tier, fable.tier]).toEqual([0, 0, 1]);
    expect(compareCost(haiku, opus)).toBeLessThan(0);
  });

  it("puts every subscription rung before any metered rung, whatever the value", () => {
    const zenLuna = costOf(fam("gpt-6-luna"), "low", "metered");
    const solMax = costOf(fam("gpt-6-sol"), "max", "chatgpt-plan");
    const goLuna = costOf(fam("gpt-6-luna"), "high", "subscription");
    expect(compareCost(solMax, zenLuna)).toBeLessThan(0);
    expect(compareCost(goLuna, zenLuna)).toBeLessThan(0);
  });

  it("orders an unknown model last in its tier, and an unknown effort as medium", () => {
    const unknown = costOf(null, "high", "subscription");
    expect(unknown).toEqual({ tier: 0, value: null, mode: "subscription" });
    expect(compareCost(costOf(fam("gpt-6-sol"), "max", "subscription"), unknown)).toBeLessThan(0);
    expect(effortFactor("thinking")).toBe(1);
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
