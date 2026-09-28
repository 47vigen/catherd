import { describe, expect, it } from "bun:test";
import {
  CONFIDENCE,
  capableFor,
  DIMS,
  effectiveRank,
  OverrideSchema,
  outranks,
  RANK,
  rungInfo,
  type Score,
  scoresOf,
} from "../../src/domain/catalog.ts";
import { shipped, shippedModels, shippedScores } from "./shipped.ts";

describe("catalog/models.json", () => {
  it("seeds the spec's families with canonical and per-backend ids", () => {
    const ids = shippedModels().families.map((f) => f.id);
    expect(ids).toEqual([
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
    const sol = shippedModels().families.find((f) => f.id === "gpt-6-sol");
    expect(sol?.on.codex).toEqual({
      id: "gpt-6-sol",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      context: 272000,
    });
    expect(sol?.on.opencode?.id).toBe("opencode/gpt-6-sol");
  });

  it("gives every Codex model the 272K default context and Haiku no effort in Claude Code", () => {
    for (const f of shippedModels().families) if (f.on.codex) expect(f.on.codex.context).toBe(272000);
    const haiku = shippedModels().families.find((f) => f.id === "claude-haiku-4-5");
    expect(haiku?.on["claude-code"]).toEqual({
      id: "claude-haiku-4-5-20251001",
      efforts: [],
      context: 200000,
    });
  });

  it("keeps ultra out of Luna and marks Codex image generation as needing a ChatGPT login", () => {
    const luna = shippedModels().families.find((f) => f.id === "gpt-6-luna");
    expect(luna?.on.codex?.efforts).not.toContain("ultra");
    expect(shippedModels().backends.codex?.imageGen?.requires).toBe("chatgpt-login");
  });
});

describe("catalog/scores.json", () => {
  it("sources every score on its dimension's benchmark, with a url, a date and a confidence", () => {
    const f = shippedScores();
    for (const s of f.scores) {
      expect(DIMS).toContain(s.dim);
      expect(s.benchmark).toBe(f.benchmarks[s.dim].benchmark);
      expect(s.version).toBe(f.benchmarks[s.dim].version);
      expect(s.url.startsWith("https://")).toBe(true);
    }
  });

  it("scores only rungs of known families and efforts, and treat-likes onto scored rungs", () => {
    const c = shipped();
    const f = shippedScores();
    for (const s of f.scores) {
      const [model, effort] = s.rung.split("#");
      const fam = c.families.find((x) => x.id === model);
      expect(fam).toBeDefined();
      const efforts = Object.values(fam?.on ?? {}).flatMap((b) => b.efforts);
      expect(efforts).toContain(effort as string);
    }
    for (const t of Object.values(f.treatLike)) expect(c.scores[t.like]).toBeDefined();
  });

  it("drops the mis-sourced 0.x Opus terminal seeds", () => {
    const c = shipped();
    expect(c.scores["claude-opus-5-5#medium"]).toBeUndefined();
    expect(c.scores["claude-opus-5-5#xhigh"]?.terminal?.value).toBe(66.4);
  });
});

describe("rungInfo", () => {
  it("maps a backend's model id to its family and canonical rung", () => {
    const c = shipped();
    expect(rungInfo(c, "opencode:opencode/gpt-6-sol#high")).toMatchObject({
      key: "opencode",
      canonical: "gpt-6-sol#high",
      context: 1050000,
      listed: null,
    });
    expect(rungInfo(c, "opencode:opencode-go/gpt-6-luna#high").key).toBe("opencode-go");
    expect(rungInfo(c, "claude:claude-opus-5-5#high")).toMatchObject({
      key: "claude",
      canonical: "claude-opus-5-5#high",
      efforts: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(rungInfo(c, "claude-code:claude-haiku-4-5-20251001#default").canonical).toBe(
      "claude-haiku-4-5#default",
    );
  });

  it("takes efforts from the backend's listing, and says when the listing lacks the model", () => {
    const listed = {
      codex: {
        fetchedAt: "2026-09-25T00:00:00.000Z",
        models: [{ id: "gpt-6-sol", efforts: ["low", "medium"], context: 272000, imageIn: true }],
      },
    };
    const c = shipped({ listed });
    expect(rungInfo(c, "codex:gpt-6-sol#high").efforts).toEqual(["low", "medium"]);
    expect(rungInfo(c, "codex:gpt-6-luna#high").listed).toBe(false);
    expect(rungInfo(c, "codex:gpt-6-sol#high").listed).toBe(true);
  });

  it("names an unknown model by its own id", () => {
    expect(rungInfo(shipped(), "opencode:opencode-go/kimi-k3#default")).toMatchObject({
      family: null,
      canonical: "opencode-go/kimi-k3#default",
    });
  });
});

describe("scores, treat-likes and the override", () => {
  it("borrows a treat-like's scores, and lets the user's treat-like and scores win", () => {
    const c = shipped();
    expect(scoresOf(c, "claude-opus-5-5#high")?.via).toBe("claude-opus-5-5#xhigh");
    expect(scoresOf(c, "opencode-go/kimi-k3#default")).toBeNull();
    const o = OverrideSchema.parse({
      treatLike: { "opencode-go/kimi-k3#default": "gpt-6-sol#medium" },
      scores: [
        {
          rung: "gpt-6-luna#high",
          dim: "repo_code",
          value: 61,
          benchmark: "DeepSWE",
          version: "1.1",
          url: "https://example.com/mine",
          date: "2026-09-25",
          confidence: "verified",
        },
      ],
      bars: { terminal: { copy: { honesty: 50 } } },
    });
    const mine = shipped({ override: o });
    expect(scoresOf(mine, "opencode-go/kimi-k3#default")?.values.repo_code).toBe(56.6);
    expect(mine.treatLike["opencode-go/kimi-k3#default"]?.source).toBe("user");
    expect(mine.scores["gpt-6-luna#high"]?.repo_code?.value).toBe(61);
    expect(mine.bars.terminal.copy).toEqual({ honesty: 50 });
    expect(mine.bars.terminal.build).toEqual({ honesty: 90 });
  });

  it("reads a 0.x override file (no schema) without losing its treat-likes", () => {
    const o = OverrideSchema.parse({ treatLike: { "a/b#high": "gpt-6-sol#high" }, entries: {} });
    expect(o.schema).toBe(1);
    expect(o.treatLike).toEqual({ "a/b#high": "gpt-6-sol#high" });
  });
});

describe("capableFor", () => {
  it("places the artist only on a backend with image generation", () => {
    const c = shipped();
    expect(capableFor(c, rungInfo(c, "codex:gpt-6-sol#medium"), "artist")).toBe(true);
    expect(capableFor(c, rungInfo(c, "claude-code:claude-opus-5-5#high"), "artist")).toBe(false);
    expect(capableFor(c, rungInfo(c, "claude-code:claude-opus-5-5#high"), "ui-reviewer")).toBe(true);
  });

  it("reads image input for an unknown model from its listing", () => {
    const listed = {
      opencode: {
        fetchedAt: "2026-09-25T00:00:00.000Z",
        models: [{ id: "opencode-go/kimi-k3", efforts: [], context: 262144, imageIn: false }],
      },
    };
    const c = shipped({ listed });
    expect(capableFor(c, rungInfo(c, "opencode:opencode-go/kimi-k3#default"), "worker")).toBe(true);
    expect(capableFor(c, rungInfo(c, "opencode:opencode-go/kimi-k3#default"), "ui-reviewer")).toBe(false);
  });

  it("reads a native claude rung's image input from claude-code's listing, as rungInfo does", () => {
    const listed = {
      "claude-code": {
        fetchedAt: "2026-09-25T00:00:00.000Z",
        models: [{ id: "claude-next-7", efforts: [], context: 200000, imageIn: true }],
      },
    };
    const c = shipped({ listed });
    expect(rungInfo(c, "claude:claude-next-7#default").listed).toBe(true);
    expect(capableFor(c, rungInfo(c, "claude:claude-next-7#default"), "ui-reviewer")).toBe(true);
    expect(capableFor(c, rungInfo(c, "claude-code:claude-next-7#default"), "ui-reviewer")).toBe(true);
  });
});

describe("confidence and precedence (spec 1.2 §4.3)", () => {
  const NOW = Date.parse("2026-09-28T12:00:00.000Z");
  const score = (o: Partial<Score> & Pick<Score, "rung" | "dim" | "value">): Score => ({
    benchmark: "b",
    version: "v",
    url: "https://example.com/s",
    date: "2026-09-27",
    confidence: "measured",
    ...o,
  });

  it("orders the six levels best first, keeping the 1.0 names", () => {
    expect([...CONFIDENCE]).toEqual([
      "verified",
      "measured",
      "calibrated",
      "adjacent",
      "secondary",
      "inferred",
    ]);
    expect(RANK.verified < RANK.secondary && RANK.secondary < RANK.inferred).toBe(true);
  });

  it("adds agentic, steer and frontend with no shipped bar on them", () => {
    expect([...DIMS]).toEqual(["repo_code", "terminal", "honesty", "agentic", "steer", "frontend"]);
    for (const kind of Object.values(shipped().bars))
      for (const bar of Object.values(kind))
        for (const d of ["agentic", "steer", "frontend"]) expect(Object.keys(bar)).not.toContain(d);
  });

  it("keeps a better level, else the newer date, and drops a value older than 90 days one level", () => {
    const old = score({ rung: "r#high", dim: "agentic", value: 1, date: "2026-06-01" });
    const fresh = score({ rung: "r#high", dim: "agentic", value: 2, date: "2026-09-27" });
    expect(effectiveRank(old, NOW)).toBe(RANK.calibrated);
    expect(effectiveRank(fresh, NOW)).toBe(RANK.measured);
    expect(outranks(fresh, old, NOW)).toBe(true);
    const newer = score({ rung: "r#high", dim: "agentic", value: 3, date: "2026-09-28" });
    expect(outranks(newer, fresh, NOW)).toBe(true);
    expect(outranks(fresh, newer, NOW)).toBe(false);
    const inferred = score({
      rung: "r#high",
      dim: "agentic",
      value: 4,
      confidence: "inferred",
      date: "2025-01-01",
    });
    expect(effectiveRank(inferred, NOW)).toBe(RANK.inferred);
  });

  it("layers synced values over the shipped ones by level, and lets the override win whatever its level", () => {
    const synced = [
      // the shipped 65.3 is secondary: a calibrated value beats it
      score({ rung: "gpt-6-sol#high", dim: "repo_code", value: 70, confidence: "calibrated" }),
      // the shipped 68.8 is verified: a measured value does not
      score({ rung: "gpt-6-sol#max", dim: "repo_code", value: 50 }),
      score({ rung: "gpt-6-sol#max", dim: "agentic", value: 0.08 }),
    ];
    const c = shipped({ synced, now: NOW });
    expect(c.scores["gpt-6-sol#high"]?.repo_code?.value).toBe(70);
    expect(c.scores["gpt-6-sol#max"]?.repo_code?.value).toBe(68.8);
    expect(c.scores["gpt-6-sol#max"]?.agentic?.value).toBe(0.08);
    const override = OverrideSchema.parse({
      scores: [
        score({
          rung: "gpt-6-sol#high",
          dim: "repo_code",
          value: 1,
          confidence: "inferred",
          date: "2020-01-01",
        }),
      ],
    });
    expect(shipped({ synced, override, now: NOW }).scores["gpt-6-sol#high"]?.repo_code?.value).toBe(1);
  });

  it("reads a 1.0 override's three levels, and keeps a synced value's provenance", () => {
    for (const confidence of ["verified", "secondary", "inferred"] as const)
      expect(
        OverrideSchema.safeParse({
          scores: [score({ rung: "a#high", dim: "repo_code", value: 1, confidence })],
        }).success,
      ).toBe(true);
    const fit = { source: "epoch", field: "frontiercode", a: 100, b: 3, r2: 0.8, n: 6 };
    const synced = [
      score({
        rung: "a#high",
        dim: "repo_code",
        value: 1,
        confidence: "calibrated",
        source: "epoch",
        fit,
        effortAssumed: true,
      }),
    ];
    expect(shipped({ synced, now: NOW }).scores["a#high"]?.repo_code).toMatchObject({
      source: "epoch",
      fit,
      effortAssumed: true,
    });
  });

  it("ships one value per rung and dimension, so the date rule never reorders the shipped file", () => {
    const keys = shippedScores().scores.map((s) => `${s.rung} ${s.dim}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("lends a treat-like's values only on the dimensions a rung has none of its own", () => {
    const synced = [score({ rung: "claude-opus-5-5#high", dim: "agentic", value: 0.12 })];
    const s = scoresOf(shipped({ synced, now: NOW }), "claude-opus-5-5#high");
    expect(s?.values).toEqual({ terminal: 66.4, agentic: 0.12 });
    expect(s?.via).toBe("claude-opus-5-5#xhigh");
    expect(s?.borrowed).toEqual(["terminal"]);
    expect(scoresOf(shipped(), "gpt-6-sol#max")?.borrowed).toEqual([]);
  });
});
