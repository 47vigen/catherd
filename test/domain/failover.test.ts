import { describe, expect, it } from "bun:test";
import { DEFAULT_BILLING } from "../../src/domain/cost.ts";
import {
  barDims,
  catalogRungs,
  claudeBilled,
  downgradeDims,
  rankStandIns,
} from "../../src/domain/failover.ts";
import { BUILTIN_ROLES, DEFAULT_FAILOVER, PAIRED_FAILOVER } from "../../src/domain/profile.ts";
import { shipped } from "./shipped.ts";

const LUNA = "codex:gpt-6-luna#high";
const SOL = (e: string) => `codex:gpt-6-sol#${e}`;
const KIMI = "opencode:opencode-go/kimi-k3#max";
const GO_LUNA = "opencode:opencode-go/gpt-6-luna#high";

describe("the dims a rung's bars use (spec 1.1 §11)", () => {
  it("are the dims of every bar the rung clears", () => {
    const c = shipped();
    // Luna high (repo_code 66.6 and frontend 1593, carried from max) clears the repo_code, prose and research
    // copy and build bars and the ui copy bar
    expect(barDims(c, LUNA)).toEqual(["repo_code", "frontend"]);
    // Sol medium (repo_code 56.6, terminal 43 carried from max) clears the terminal copy bar only
    expect(barDims(c, SOL("medium"))).toEqual(["terminal"]);
    // Opus high carries max's and xhigh's values; with no honesty value it clears no Track B bar
    expect(barDims(c, "claude-code:claude-opus-5-5#high")).toEqual(["repo_code", "terminal", "frontend"]);
    expect(barDims(c, "codex:not-a-model#high")).toEqual([]);
  });
});

describe("downgradeDims", () => {
  it("names each bar dim the stand-in scores below the rung on, a missing score counting as below", () => {
    const c = shipped();
    expect(downgradeDims(c, SOL("medium"), KIMI)).toEqual([]);
    expect(downgradeDims(c, SOL("xhigh"), KIMI)).toEqual(["repo_code"]);
    expect(downgradeDims(c, SOL("high"), GO_LUNA)).toEqual(["terminal", "frontend"]);
    expect(downgradeDims(c, SOL("medium"), "claude-code:claude-opus-5-5#high")).toEqual([]);
    expect(downgradeDims(c, "claude-code:claude-opus-5-5#high", GO_LUNA)).toEqual([
      "repo_code",
      "terminal",
      "frontend",
    ]);
  });
});

describe("rankStandIns", () => {
  it("keeps stand-ins on another quota, scored, paid from a plan and no downgrade; Claude-billed last", () => {
    const c = shipped();
    const pool = [
      "codex:gpt-6-luna#max", // same quota as Luna high
      "opencode:opencode/gpt-6-luna#high", // Zen: metered
      "claude:claude-opus-5-5#high", // native: dispatch cannot start it
      "claude-code:claude-opus-5-5#max", // repo_code 74.2, frontend 1827: fits, but on the Claude plan
      "opencode:opencode-go/gpt-5.6-luna#max", // frontend 1520, below Luna high's 1593
      GO_LUNA,
      "opencode:opencode-go/nope#high", // unscored
    ];
    expect(rankStandIns(c, DEFAULT_BILLING, LUNA, pool)).toEqual([
      GO_LUNA,
      "claude-code:claude-opus-5-5#max",
    ]);
    expect(rankStandIns(c, DEFAULT_BILLING, "not a rung", pool)).toEqual([]);
  });

  it("prefers the effort nearest the rung's own among a model's efforts, which carry one another's values", () => {
    const c = shipped();
    const go = (e: string) => `opencode:opencode-go/gpt-6-luna#${e}`;
    expect(rankStandIns(c, DEFAULT_BILLING, LUNA, [go("none"), go("max"), go("high"), go("low")])).toEqual([
      go("high"),
      go("low"), // two steps away, as max is: the cheaper first
      go("max"),
      go("none"),
    ]);
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
    // a model with no effort has one rung, #default (spec 1.3 §7.1)
    expect(all).toContain("cursor:composer-2.5#default");
    expect(all).toContain("claude-code:claude-haiku-4-5-20251001#default");
    // spec 1.3 §5.2: grok's efforts are the catalog's (grok lists none); Cursor's Grok slugs have none
    expect(all).toContain("grok:grok-4.7#low");
    expect(all).toContain("grok:grok-4.5#xhigh");
    expect(all).toContain("cursor:grok-4.7#default");
    expect(all).toContain(KIMI);
    expect(all.some((r) => r.startsWith("opencode:claude-opus-5-5#"))).toBe(false);
    expect(all).toEqual([...new Set(all)].sort());
  });
});

describe("DEFAULT_FAILOVER (spec 1.1 §11)", () => {
  it("gives each shipped worker rung a stand-in the shipped catalog accepts, never a Claude-billed one", () => {
    const c = shipped();
    // the ranker also accepts Opus (Claude-billed, carrying max's values) for Sol high and xhigh: the default
    // leaves those without one, so a limit on them pauses the lane (spec 1.1 §11)
    for (const [rung, standIn] of Object.entries(DEFAULT_FAILOVER)) {
      expect(BUILTIN_ROLES.worker.rungs).toContain(rung);
      expect(rankStandIns(c, DEFAULT_BILLING, rung, catalogRungs(c))).toContain(standIn);
      expect(claudeBilled(standIn)).toBe(false);
    }
    expect(DEFAULT_FAILOVER).toEqual({ [LUNA]: GO_LUNA, [SOL("medium")]: KIMI });
    for (const rung of Object.keys(DEFAULT_FAILOVER))
      expect(rankStandIns(c, DEFAULT_BILLING, rung, catalogRungs(c))[0]).toBe(DEFAULT_FAILOVER[rung]);
  });
});

describe("PAIRED_FAILOVER (spec 1.3 §7.3)", () => {
  it("pairs each Grok rung with the same model on Cursor, both ways, and nothing a shipped role runs", () => {
    const c = shipped();
    expect(PAIRED_FAILOVER["grok:grok-4.7#low"]).toBe("cursor:grok-4.7#default");
    expect(PAIRED_FAILOVER["grok:grok-4.5#xhigh"]).toBe("cursor:grok-4.5#default");
    expect(PAIRED_FAILOVER["cursor:grok-4.6#default"]).toBe("grok:grok-4.6#high");
    expect(PAIRED_FAILOVER["grok:grok-4.7#default"]).toBe("cursor:grok-4.7#default"); // Codex, PR #31
    expect(Object.keys(PAIRED_FAILOVER)).toHaveLength(18);
    const shippedRungs = new Set(Object.values(BUILTIN_ROLES).flatMap((r) => r.rungs));
    for (const [from, to] of Object.entries(PAIRED_FAILOVER)) {
      // a `#default` rung runs with no effort flag on any backend, so it need not be a listed effort
      if (!from.endsWith("#default")) expect(catalogRungs(c)).toContain(from);
      expect(catalogRungs(c)).toContain(to);
      expect(from.split(":")[0]).not.toBe(to.split(":")[0]);
      expect(shippedRungs.has(from)).toBe(false);
    }
  });
});
