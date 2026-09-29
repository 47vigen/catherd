import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCatalog,
  CONFIDENCE,
  capableFor,
  DIMS,
  effectiveRank,
  ModelsFileSchema,
  OverrideSchema,
  outranks,
  RANK,
  rungInfo,
  type Score,
  scoresOf,
} from "../../src/domain/catalog.ts";
import { SourcesFileSchema } from "../../src/domain/sources.ts";
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
      "claude-sonnet-5-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "grok-4-7",
      "grok-4-6",
      "grok-4-5",
      "composer-2-5",
      "gemini-3-8-flash",
      "gemini-3-7-flash",
      "gemini-3-6-flash",
      "gemini-3-1-pro",
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
  it("sources every hand-typed score on its dimension's benchmark, and every value with a url and a date", () => {
    const f = shippedScores();
    const sources = new Set(["arena", "vectara", "epoch"]);
    for (const s of f.scores) {
      expect(DIMS).toContain(s.dim);
      expect(s.url.startsWith("https://")).toBe(true);
      if (s.source === undefined) {
        expect(s.benchmark).toBe(f.benchmarks[s.dim].benchmark);
        expect(s.version).toBe(f.benchmarks[s.dim].version);
      } else {
        // spec 1.2 §7: a keyless source's value, dated; never Artificial Analysis
        expect(sources.has(s.source)).toBe(true);
        expect(s.version).toBe(s.date);
      }
    }
  });

  it("scores only rungs of known families and efforts, and treat-likes onto scored rungs", () => {
    const c = shipped();
    const f = shippedScores();
    for (const s of f.scores) {
      const [model, effort] = s.rung.split("#");
      const fam = c.families.find((x) => x.id === model);
      expect(fam).toBeDefined();
      // a backend that takes no effort flag runs the model at `default` (Haiku in Claude Code)
      const efforts = Object.values(fam?.on ?? {}).flatMap((b) =>
        b.efforts.length ? b.efforts : ["default"],
      );
      expect(efforts).toContain(effort as string);
    }
    for (const t of Object.values(f.treatLike)) expect(c.scores[t.like]).toBeDefined();
  });

  it("names every source a shipped value comes from in ATTRIBUTION.md, with its license and attribution line", () => {
    const text = readFileSync(join(import.meta.dir, "..", "..", "catalog", "ATTRIBUTION.md"), "utf8");
    const sources = SourcesFileSchema.parse(
      JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "catalog", "sources.json"), "utf8")),
    ).sources;
    const shippedFrom = new Set(shippedScores().scores.flatMap((s) => (s.source ? [s.source] : [])));
    expect(shippedFrom.size).toBeGreaterThan(0);
    for (const id of ["arena", "vectara", "epoch", ...shippedFrom]) {
      const s = sources.find((x) => x.id === id);
      expect(s?.keyed).toBe(false);
      expect(text).toContain(`### ${s?.name}`);
      expect(text).toContain(`- Attribution: ${s?.attribution}`);
    }
    expect(shippedFrom.has("artificial-analysis")).toBe(false);
  });

  it("keeps the vendors' Opus terminal values, and carries them to its other efforts as adjacent", () => {
    const c = shipped();
    expect(c.scores["claude-opus-5-5#xhigh"]?.terminal).toMatchObject({
      value: 66.4,
      confidence: "verified",
    });
    expect(c.scores["claude-opus-5-5#medium"]?.terminal).toMatchObject({
      value: 66.4,
      confidence: "adjacent",
      note: "Terminal-Bench has it at xhigh; carried to this effort",
    });
  });
});

describe("Cursor's families (spec 1.3 §7.1)", () => {
  const fam = (id: string) => shippedModels().families.find((f) => f.id === id);

  it("gives the Grok, Composer and Gemini families a Cursor id, a keyless price and a release date", () => {
    expect(fam("grok-4-7")).toMatchObject({
      price: { input: 2, cached: 0.5, output: 6 },
      releaseDate: "2026-09-21",
      on: { cursor: { id: "grok-4.7", efforts: [], context: 200000 } },
    });
    expect(fam("gemini-3-1-pro")?.price).toEqual({ input: 2, cached: 0.2, output: 12 });
    expect(fam("gemini-3-8-flash")?.on.cursor?.id).toBe("gemini-3.8-flash");
    // no keyless source prices Composer: Grok 4.7's, the same Cursor pool, stands in
    expect(fam("composer-2-5")?.price).toEqual(fam("grok-4-7")?.price);
    expect(fam("composer-2-5")?.on.cursor).toEqual({ id: "composer-2.5", efforts: [], context: 200000 });
  });

  it("reads a Cursor slug as its family's canonical rung, the shipped families included", () => {
    const c = shipped();
    expect(rungInfo(c, "cursor:gpt-6-sol#xhigh")).toMatchObject({
      key: "cursor",
      canonical: "gpt-6-sol#xhigh",
      efforts: ["low", "high", "xhigh"],
    });
    expect(rungInfo(c, "cursor:claude-opus-5-5-thinking#high").canonical).toBe("claude-opus-5-5#high");
    expect(rungInfo(c, "cursor:composer-2.5#default").canonical).toBe("composer-2-5#default");
    expect(rungInfo(c, "cursor:grok-4.7#default").family?.id).toBe("grok-4-7");
  });
});

describe("Antigravity's families (spec 1.3 §6.6, §7.1)", () => {
  const fam = (id: string) => shippedModels().families.find((f) => f.id === id);

  it("gives the four Gemini families an agy id, the Gemini API's thinking levels and its 1M context", () => {
    for (const [id, agy] of [
      ["gemini-3-8-flash", "gemini-3.8-flash"],
      ["gemini-3-7-flash", "gemini-3.7-flash"],
      ["gemini-3-6-flash", "gemini-3.6-flash"],
    ] as const)
      expect(fam(id)?.on.antigravity).toEqual({
        id: agy,
        efforts: ["low", "medium", "high"],
        context: 1048576,
      });
    expect(fam("gemini-3-1-pro")?.on.antigravity).toEqual({
      id: "gemini-3.1-pro",
      efforts: ["low", "high"],
      context: 1048576,
    });
    // Cursor keeps its own ids, efforts and window
    expect(fam("gemini-3-8-flash")?.on.cursor).toEqual({
      id: "gemini-3.8-flash",
      efforts: [],
      context: 200000,
    });
  });

  it("reads an agy rung as its family's canonical rung, billed under antigravity", () => {
    expect(rungInfo(shipped(), "antigravity:gemini-3.8-flash#low")).toMatchObject({
      key: "antigravity",
      canonical: "gemini-3-8-flash#low",
      efforts: ["low", "medium", "high"],
      context: 1048576,
    });
    expect(rungInfo(shipped(), "antigravity:gemini-3.1-pro#default").canonical).toBe(
      "gemini-3-1-pro#default",
    );
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

  it("maps an antigravity rung through a family's on.antigravity, billed under its own key (spec 1.3 §3.3)", () => {
    const models = shippedModels();
    const flash = {
      id: "flash-x",
      name: "Flash X",
      capabilities: { toolUse: true, imageIn: true, reasoning: true },
      price: { input: 1, cached: 0.1, output: 4 },
      on: { antigravity: { id: "flash-x-cli", efforts: ["low", "high"], context: 1000000 } },
    };
    const c = buildCatalog({
      models: ModelsFileSchema.parse({ ...models, families: [...models.families, flash] }),
      scores: shippedScores(),
    });
    expect(rungInfo(c, "antigravity:flash-x-cli#low")).toMatchObject({
      key: "antigravity",
      canonical: "flash-x#low",
      efforts: ["low", "high"],
    });
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
    expect(scoresOf(c, "opencode-go/kimi-k3#max")?.via).toBe("gpt-6-sol#medium");
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
    // spec 1.2 §5.2: the override sets its threshold, and the default's other thresholds stay
    expect(mine.bars.terminal.copy).toEqual({ terminal: 40.15, honesty: 50 });
    expect(mine.bars.terminal.build).toEqual({ terminal: 55.8 });
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

  it("adds agentic, steer and frontend, with no shipped bar on steer", () => {
    expect([...DIMS]).toEqual(["repo_code", "terminal", "honesty", "agentic", "steer", "frontend"]);
    for (const kind of Object.values(shipped().bars))
      for (const bar of Object.values(kind)) expect(Object.keys(bar)).not.toContain("steer");
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
      // the shipped Arena value is measured too, a day older: the newer one wins
      score({ rung: "gpt-6-sol#max", dim: "agentic", value: 0.08, date: "2026-09-28" }),
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

  it("names every override value's source as the override, even one copied with a synced source", () => {
    const override = OverrideSchema.parse({
      scores: [score({ rung: "gpt-6-sol#high", dim: "repo_code", value: 1, source: "arena" })],
    });
    expect(shipped({ override, now: NOW }).scores["gpt-6-sol#high"]?.repo_code?.source).toBe("override");
  });

  it("ships one value per rung and dimension, so the date rule never reorders the shipped file", () => {
    const keys = shippedScores().scores.map((s) => `${s.rung} ${s.dim}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("lends a treat-like's values only on the dimensions a rung has none of its own", () => {
    // Kimi K3 borrows Sol medium's values through the shipped treat-like; a sync scores it on agentic only
    const synced = [score({ rung: "opencode-go/kimi-k3#max", dim: "agentic", value: 0.12 })];
    const c = shipped({ synced, now: NOW });
    const s = scoresOf(c, "opencode-go/kimi-k3#max");
    const sol = scoresOf(c, "gpt-6-sol#medium");
    expect(s?.values).toEqual({ ...sol?.values, agentic: 0.12 });
    expect(s?.via).toBe("gpt-6-sol#medium");
    expect(s?.borrowed).toEqual(["repo_code", "terminal", "honesty", "steer", "frontend"]);
    expect(scoresOf(shipped(), "gpt-6-sol#max")?.borrowed).toEqual([]);
  });
});
