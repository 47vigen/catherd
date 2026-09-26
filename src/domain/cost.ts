import type { BillingKey, Family } from "./catalog.ts";

/** Spec §5.3: how the user pays for each billing key. */
export const BILLING_MODES = ["chatgpt-plan", "claude-plan", "subscription", "metered"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

/** Spec §7.1's default `billing`: the owner's Codex/ChatGPT plan, Claude plan and OpenCode Go. */
export const DEFAULT_BILLING: Record<BillingKey, BillingMode> = {
  codex: "chatgpt-plan",
  claude: "claude-plan",
  "claude-code": "claude-plan",
  "opencode-go": "subscription",
  opencode: "metered",
  cursor: "metered",
  grok: "metered",
};

/**
 * Tokens per task relative to `medium`, from GPT-6 Sol's published DeepSWE dollars per task
 * (low 0.16, medium 0.38, high 0.64, xhigh 1.00, max 2.74; research 2026-09-25-models.md §3.1).
 * `ultra` is `max` with parallel subagents: ×4 is catherd's estimate. An unknown variant counts as 1.
 */
export const EFFORT_FACTOR: Record<string, number> = {
  none: 0.3,
  minimal: 0.3,
  low: 0.4,
  medium: 1,
  default: 1,
  high: 1.7,
  xhigh: 2.6,
  max: 7.2,
  ultra: 28.8,
};

/** A reference task at medium effort: uncached input, cached input and output tokens (≈ $0.38 on Sol). */
export const REF_TASK = { input: 60_000, cached: 400_000, output: 18_000 };

export const effortFactor = (effort: string): number => EFFORT_FACTOR[effort] ?? 1;

/** Estimated list-price dollars for one task at `effort`. */
export function taskUsd(price: Family["price"], effort: string): number {
  const perTask =
    REF_TASK.input * price.input + REF_TASK.cached * price.cached + REF_TASK.output * price.output;
  return (perTask / 1_000_000) * effortFactor(effort);
}

/** One GPT-6 Luna task at medium, in list-price dollars: the unit of a chatgpt-plan weight of 1. */
export const CHATGPT_UNIT_USD = 0.019;

export interface Cost {
  /** 0: paid from a subscription; 1: metered. Every tier-0 rung ranks before any tier-1 rung. */
  tier: 0 | 1;
  /** comparable across billing modes, in list-price dollars per task; null when unknown */
  value: number | null;
  mode: BillingMode;
}

/**
 * Spec §5.3. Every mode yields list-price dollars per task, so plans compare with each other:
 * chatgpt-plan scales the official quota weight (Luna 1, Sol 20, Astra 60) by the effort factor;
 * claude-plan uses API prices as the proxy, with Fable metered (catherd cannot tell Pro from Max);
 * Go's share of its monthly dollar limit is dollars / limit, which orders the same as dollars.
 */
export function costOf(family: Family | null, effort: string, mode: BillingMode): Cost {
  if (!family) return { tier: mode === "metered" ? 1 : 0, value: null, mode };
  const usd = taskUsd(family.price, effort);
  switch (mode) {
    case "chatgpt-plan":
      return {
        tier: 0,
        value:
          family.planWeight === undefined ? usd : family.planWeight * CHATGPT_UNIT_USD * effortFactor(effort),
        mode,
      };
    case "claude-plan":
      return { tier: family.meteredOnPlan ? 1 : 0, value: usd, mode };
    case "subscription":
      return { tier: 0, value: usd, mode };
    case "metered":
      return { tier: 1, value: usd, mode };
  }
}

/** Cheaper first: tier, then value, an unknown value last. */
export function compareCost(a: Cost, b: Cost): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.value === null || b.value === null) return (a.value === null ? 1 : 0) - (b.value === null ? 1 : 0);
  return a.value - b.value;
}
