import { describe, expect, it } from "bun:test";
import { DEFAULT_BILLING } from "../../src/domain/cost.ts";
import {
  barDims,
  catalogRungs,
  claudeBilled,
  downgradeDims,
  rankStandIns,
} from "../../src/domain/failover.ts";
import { BUILTIN_ROLES, DEFAULT_FAILOVER } from "../../src/domain/profile.ts";
import { shipped } from "./shipped.ts";

const LUNA = "codex:gpt-6-luna#high";
const SOL = (e: string) => `codex:gpt-6-sol#${e}`;
const KIMI = "opencode:opencode-go/kimi-k3#max";
const GO_LUNA = "opencode:opencode-go/gpt-6-luna#high";

describe("the dims a rung's bars use (spec 1.1 §11)", () => {
  it("are the dims of every bar the rung clears", () => {
    const c = shipped();
    // Luna high: repo_code 59.3, honesty 71.3 → clears the repo_code-only copy/build bars
    expect(barDims(c, LUNA)).toEqual(["repo_code"]);
    // Sol medium clears every bar, which use repo_code and honesty
    expect(barDims(c, SOL("medium"))).toEqual(["repo_code", "honesty"]);
    // Opus high borrows xhigh's terminal score only and clears no bar
    expect(barDims(c, "claude-code:claude-opus-5-5#high")).toEqual([]);
    expect(barDims(c, "codex:not-a-model#high")).toEqual([]);
  });
});

describe("downgradeDims", () => {
  it("names each bar dim the stand-in scores below the rung on, a missing score counting as below", () => {
    const c = shipped();
    expect(downgradeDims(c, SOL("medium"), KIMI)).toEqual([]);
    expect(downgradeDims(c, SOL("xhigh"), KIMI)).toEqual(["repo_code"]);
    expect(downgradeDims(c, SOL("high"), GO_LUNA)).toEqual(["repo_code", "honesty"]);
    expect(downgradeDims(c, SOL("medium"), "claude-code:claude-opus-5-5#high")).toEqual([
      "repo_code",
      "honesty",
    ]);
    expect(downgradeDims(c, "claude-code:claude-opus-5-5#high", GO_LUNA)).toEqual([]);
  });
});

describe("rankStandIns", () => {
  it("keeps stand-ins on another quota, scored, paid from a plan and no downgrade; Claude-billed last", () => {
    const c = shipped();
    const pool = [
      "codex:gpt-6-luna#max", // same quota as Luna high
      "opencode:opencode/gpt-6-luna#high", // Zen: metered
      "claude:claude-opus-5-5#high", // native: dispatch cannot start it
      "claude-code:claude-opus-5-5#high", // no score on repo_code, the bar dim Luna high uses
      "claude-code:claude-opus-5-5#max", // repo_code 74.2: fits, but on the Claude plan
      "opencode:opencode-go/gpt-5.6-luna#max",
      GO_LUNA,
      "opencode:opencode-go/nope#high", // unscored
    ];
    expect(rankStandIns(c, DEFAULT_BILLING, LUNA, pool)).toEqual([
      GO_LUNA,
      "opencode:opencode-go/gpt-5.6-luna#max",
      "claude-code:claude-opus-5-5#max",
    ]);
    expect(rankStandIns(c, DEFAULT_BILLING, "not a rung", pool)).toEqual([]);
  });

  it("takes a Zen stand-in when the profile bills Zen on a subscription", () => {
    const c = shipped();
    const zen = "opencode:opencode/gpt-6-sol#high";
    expect(rankStandIns(c, DEFAULT_BILLING, SOL("high"), [zen])).toEqual([]);
    expect(rankStandIns(c, { ...DEFAULT_BILLING, opencode: "subscription" }, SOL("high"), [zen])).toEqual([
      zen,
    ]);
  });

  it("marks the rungs that draw on the Claude plan", () => {
    expect(claudeBilled("claude:claude-opus-5-5#high")).toBe(true);
    expect(claudeBilled("claude-code:claude-sonnet-5#high")).toBe(true);
    expect(claudeBilled(KIMI)).toBe(false);
    expect(claudeBilled("nope")).toBe(false);
  });
});

describe("catalogRungs", () => {
  it("lists every shipped family rung, every listed model's efforts, and opencode treat-likes", () => {
    const c = shipped({
      listed: {
        opencode: {
          fetchedAt: "2026-09-28T00:00:00.000Z",
          models: [{ id: "opencode-go/glm-5.3", efforts: ["high"], context: 1, imageIn: false }],
        },
      },
    });
    const all = catalogRungs(c);
    expect(all).toContain("codex:gpt-6-sol#xhigh");
    expect(all).toContain("claude-code:claude-opus-5-5#max");
    expect(all).toContain("opencode:opencode-go/gpt-6-luna#high");
    expect(all).toContain("opencode:opencode/claude-opus-5-5#high");
    expect(all).toContain("opencode:opencode-go/glm-5.3#high");
    expect(all).toContain(KIMI);
    expect(all.some((r) => r.startsWith("opencode:claude-opus-5-5#"))).toBe(false);
    expect(all).toEqual([...new Set(all)].sort());
  });
});

describe("DEFAULT_FAILOVER (spec 1.1 §11)", () => {
  it("is, for each shipped worker rung, the best stand-in the shipped catalog offers, and none without one", () => {
    const c = shipped();
    const expected: Record<string, string> = {};
    for (const rung of new Set(BUILTIN_ROLES.worker.rungs)) {
      const best = rankStandIns(c, DEFAULT_BILLING, rung, catalogRungs(c))[0];
      if (best) expected[rung] = best;
    }
    expect(DEFAULT_FAILOVER).toEqual(expected);
    expect(DEFAULT_FAILOVER).toEqual({ [LUNA]: GO_LUNA, [SOL("medium")]: KIMI });
  });
});
