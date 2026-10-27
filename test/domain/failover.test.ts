import { describe, expect, it } from "bun:test";
import { DEFAULT_BILLING } from "../../src/domain/cost.ts";
import {
  catalogPairs,
  claudeBilled,
  downgrade,
  intelligenceOf,
  ladderDrop,
  rankStandIns,
} from "../../src/domain/failover.ts";
import { BUILTIN_ROLES, DEFAULT_FAILOVER } from "../../src/domain/profile.ts";
import { indexOf, shipped } from "./shipped.ts";

const LUNA = "codex:gpt-6-luna#high";
const SOL = (e: string) => `codex:gpt-6-sol#${e}`;
const KIMI = "opencode:opencode-go/kimi-k3#max";
const GO_LUNA = "opencode:opencode-go/gpt-6-luna#high";
const OPUS = (e: string) => `claude-code:claude-opus-5-5#${e}`;

/** What a real opencode lists: the Go models the default failover names. */
const GO_LISTING = {
  opencode: {
    fetchedAt: "2026-10-13T00:00:00.000Z",
    models: [
      { id: "opencode-go/kimi-k3", efforts: ["max", "low"], context: 1, imageIn: false },
      {
        id: "opencode-go/gpt-6-luna",
        efforts: ["low", "medium", "high", "xhigh", "max"],
        context: 1,
        imageIn: false,
      },
    ],
  },
};

describe("intelligenceOf", () => {
  it("is the pair's intelligence, and null for an unindexed rung or no rung", () => {
    const c = shipped({ index: indexOf({ "gpt-6-sol#high": 42.5 }) });
    expect(intelligenceOf(c, SOL("high"))).toBe(42.5);
    expect(intelligenceOf(c, SOL("medium"))).toBeNull();
    expect(intelligenceOf(c, "not a rung")).toBeNull();
  });
});

describe("downgrade and ladderDrop (spec 1.1 §11)", () => {
  const c = shipped({ index: indexOf({ "gpt-6-sol#low": 34, "gpt-6-sol#high": 42, "kimi-k3#max": 43 }) });
  it("downgrade is a stand-in below the rung or unindexed, never against an unindexed rung", () => {
    expect(downgrade(c, SOL("high"), SOL("low"))).toBe(true);
    expect(downgrade(c, SOL("high"), KIMI)).toBe(false);
    expect(downgrade(c, SOL("high"), SOL("xhigh"))).toBe(true);
    expect(downgrade(c, SOL("xhigh"), SOL("low"))).toBe(false);
  });

  it("ladderDrop is an upper rung below the lower, and never for the same rung or an unindexed one", () => {
    expect(ladderDrop(c, SOL("high"), SOL("low"))).toBe(true);
    expect(ladderDrop(c, SOL("low"), SOL("high"))).toBe(false);
    expect(ladderDrop(c, SOL("high"), SOL("high"))).toBe(false);
    expect(ladderDrop(c, SOL("high"), SOL("xhigh"))).toBe(false);
  });
});

describe("rankStandIns", () => {
  it("keeps stand-ins on another quota, indexed, plan-paid and at least as intelligent; Claude-billed last", () => {
    const c = shipped();
    const pool = [
      "codex:gpt-6-luna#max", // same quota as Luna high
      "opencode:opencode/gpt-6-luna#high", // Zen: metered
      "claude:claude-opus-5-5#high", // native: dispatch cannot start it
      OPUS("max"), // more intelligent, but on the Claude plan
      "opencode:opencode-go/gpt-6-luna#low", // less intelligent than Luna high
      GO_LUNA,
      "opencode:opencode-go/nope#high", // unindexed
    ];
    expect(rankStandIns(c, DEFAULT_BILLING, LUNA, pool)).toEqual([GO_LUNA, OPUS("max")]);
    expect(rankStandIns(c, DEFAULT_BILLING, "not a rung", pool)).toEqual([]);
  });

  it("prefers the nearest intelligence above the rung, then the cheapest", () => {
    const c = shipped({
      index: indexOf({
        "gpt-6-sol#high": 42,
        "gpt-6-luna#low": 50,
        "gpt-6-luna#medium": { intelligence: 44, inputPrice: 0.1, outputPrice: 0.5 },
        "gpt-6-luna#high": { intelligence: 44, inputPrice: 0.1, outputPrice: 0.5 },
        "gpt-6-luna#xhigh": 60,
      }),
    });
    const go = (e: string) => `opencode:opencode-go/gpt-6-luna#${e}`;
    // medium and high tie on intelligence: the cheaper (medium) first, then the name
    expect(
      rankStandIns(c, DEFAULT_BILLING, SOL("high"), [go("xhigh"), go("low"), go("high"), go("medium")]),
    ).toEqual([go("medium"), go("high"), go("low"), go("xhigh")]);
  });

  it("keeps every stand-in for a rung with no index of its own", () => {
    const c = shipped();
    expect(
      rankStandIns(c, DEFAULT_BILLING, SOL("ultra"), [GO_LUNA, "opencode:opencode-go/gpt-6-luna#low"]),
    ).toEqual(["opencode:opencode-go/gpt-6-luna#low", GO_LUNA]);
  });

  it("takes a Zen stand-in when the profile bills Zen on a subscription", () => {
    const c = shipped();
    const zen = "opencode:opencode/gpt-6-sol#xhigh";
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

describe("catalogPairs", () => {
  it("lists only indexed rungs: every shipped family's efforts, and every listed model's", () => {
    const c = shipped({
      listed: {
        opencode: {
          fetchedAt: "2026-09-28T00:00:00.000Z",
          models: [
            { id: "opencode-go/glm-5.3", efforts: ["high"], context: 1, imageIn: false },
            { id: "opencode-go/kimi-k3", efforts: ["max"], context: 1, imageIn: false },
          ],
        },
      },
    });
    const all = catalogPairs(c);
    expect(all).toContain("opencode:opencode/gpt-6-sol#high");
    expect(all).not.toContain("opencode:opencode/gpt-6-sol#ultra");
    // GPT-6.1 Sol replaces GPT-6 Sol on codex: no stand-in is picked from the older version there
    expect(all).toContain("codex:gpt-6.1-sol#high");
    expect(all).not.toContain("codex:gpt-6-sol#high");
    expect(all).toContain(OPUS("max"));
    expect(all).toContain("opencode:opencode/claude-opus-5-5#high");
    expect(all).toContain(KIMI);
    // a model with no effort has one rung, #default, when the index files it so
    expect(all).toContain("opencode:opencode/claude-haiku-4-5#default");
    expect(all).not.toContain("claude-code:claude-haiku-4-5-20251001#default");
    expect(all).not.toContain("opencode:opencode-go/glm-5.3#high");
    expect(
      all.some((r) => r.startsWith("grok:") || r.startsWith("antigravity:") || r.startsWith("cursor:")),
    ).toBe(false);
    expect(all).toEqual([...new Set(all)].sort());
  });
});

describe("DEFAULT_FAILOVER (spec 1.1 §11)", () => {
  it("gives each shipped worker rung a stand-in the recorded index accepts, never a Claude-billed one", () => {
    const c = shipped({ listed: GO_LISTING });
    const pool = catalogPairs(c);
    expect(DEFAULT_FAILOVER).toEqual({ [LUNA]: GO_LUNA, [SOL("medium")]: KIMI });
    for (const [rung, standIn] of Object.entries(DEFAULT_FAILOVER)) {
      expect(BUILTIN_ROLES.worker.rungs).toContain(rung);
      expect(rankStandIns(c, DEFAULT_BILLING, rung, pool)[0]).toBe(standIn);
      expect(claudeBilled(standIn)).toBe(false);
    }
  });
});
