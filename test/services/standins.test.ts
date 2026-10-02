import { afterEach, describe, expect, it } from "bun:test";
import { buildCatalog, type Catalog, scoresOf } from "../../src/domain/catalog.ts";
import { loadCatalog } from "../../src/services/catalog-service.ts";
import { derive } from "../../src/services/source-derive.ts";
import {
  canonicalRungs,
  featuresOf,
  inferStandIns,
  MIN_SHARED_FEATURES,
  missingDims,
  suggestStandIns,
  withStandIns,
} from "../../src/services/standins.ts";
import { shipped, shippedModels, shippedScores } from "../domain/shipped.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { rawAnswers, shippedContext } from "./source-fixtures.ts";

afterEach(snapshotEnv());

const AT = "2026-09-27T10:00:00.000Z";
const NOW = Date.parse(AT);

/**
 * The catalog as the keyless sources alone described it on 2026-09-27 (spec 1.2 §11): the recorded answers,
 * over the hand-typed values less every Opus 5.5 one (a vendor's own numbers, which no source carries).
 */
function keylessDay(): Catalog {
  const ctx = shippedContext(NOW);
  const hand = ctx.scores.scores.filter(
    (s) => s.source === undefined && s.confidence !== "adjacent" && !s.rung.startsWith("claude-opus-5-5#"),
  );
  const synced = derive(rawAnswers(AT), { ...ctx, scores: { ...ctx.scores, scores: hand } }).scores;
  return withStandIns(
    buildCatalog({
      models: ctx.models,
      scores: { ...ctx.scores, scores: hand, treatLike: {} },
      synced,
      now: NOW,
    }),
  );
}

describe("stand-in ranking (spec 1.2 §6.3)", () => {
  it("gives Opus 5.5 a stand-in for coding and terminal, which no keyless source scores it on", () => {
    const c = keylessDay();
    expect(c.scores["claude-opus-5-5#high"]?.repo_code).toBeUndefined();
    expect(c.scores["claude-opus-5-5#high"]?.terminal).toBeUndefined();
    const s = scoresOf(c, "claude-opus-5-5#high");
    expect(s?.inferred).toEqual(expect.arrayContaining(["repo_code", "terminal"]));
    for (const d of ["repo_code", "terminal"] as const) {
      const stand = c.inferred["claude-opus-5-5#high"]?.[d];
      expect(stand?.features.length).toBeGreaterThanOrEqual(MIN_SHARED_FEATURES);
      expect(s?.standIns[d]).toBe(stand?.like);
      expect(s?.values[d]).toBe(c.scores[stand?.like as string]?.[d]?.value);
    }
    // Arena scores Opus on agentic itself: that value is its own, never a stand-in's
    expect(s?.inferred).not.toContain("agentic");
  });

  it("ranks by a z-scored distance over shared features, nearest first, and says what each would lend", () => {
    const c = keylessDay();
    const top = suggestStandIns(c, "claude-opus-5-5#high");
    expect(top).toHaveLength(3);
    const distances = top.map((x) => x.distance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    for (const x of top) {
      expect(x.features).toEqual(expect.arrayContaining(["price", "context", "vendor", "family", "effort"]));
      expect(x.lends.length).toBeGreaterThan(0);
      expect(x.like).not.toBe("claude-opus-5-5#high");
    }
  });

  it("uses the keyless features without an Artificial Analysis key, and AA's with one", () => {
    const c = keylessDay();
    const f = featuresOf(c, "claude-opus-5-5#high");
    expect(Object.keys(f)).toEqual(
      expect.arrayContaining(["price", "context", "release", "vendor", "family", "effort", "agentic"]),
    );
    expect(Object.keys(f).some((k) => k.startsWith("aa."))).toBe(false);
    const withAa = { ...c, features: { "claude-opus-5-5#high": { hle: 40, scicode: 50 } } };
    expect(featuresOf(withAa, "claude-opus-5-5#high")).toMatchObject({ "aa.hle": 40, "aa.scicode": 50 });
  });

  it("suggests nothing for a rung sharing fewer than three features with any scored rung", () => {
    // a model OpenCode lists that catherd has no family for: only its effort is known
    const c = withStandIns(
      shipped({
        listed: {
          opencode: {
            fetchedAt: AT,
            models: [{ id: "opencode-go/glm-5.3", efforts: ["high"], context: 1, imageIn: false }],
          },
        },
      }),
    );
    expect(canonicalRungs(c)).toContain("opencode-go/glm-5.3#high");
    expect(suggestStandIns(c, "opencode-go/glm-5.3#high")).toEqual([]);
    expect(c.inferred["opencode-go/glm-5.3#high"]).toBeUndefined();
    expect(scoresOf(c, "opencode-go/glm-5.3#high")).toBeNull();
  });

  it("never lends a guess: a stand-in's own inferred value is not borrowed on", () => {
    const c = withStandIns(shipped());
    // Fable max's DeepSWE value is hand-typed as inferred; Fable's other efforts take repo_code elsewhere
    expect(c.scores["claude-fable-5-1#max"]?.repo_code?.confidence).toBe("inferred");
    for (const stand of Object.values(c.inferred))
      expect(stand.repo_code?.like).not.toBe("claude-fable-5-1#max");
  });
});

describe("inferred values in the catalog (spec 1.2 §6.1)", () => {
  it("fills only what a rung lacks on the bars' dimensions, after its own values and its treat-like", () => {
    const c = withStandIns(shipped());
    // Sol has a value on every bar dimension: nothing to infer
    expect(missingDims(c, "gpt-6-sol#medium")).toEqual([]);
    expect(c.inferred["gpt-6-sol#medium"]).toBeUndefined();
    // Kimi K3 borrows everything through its shipped treat-like: nothing to infer either
    expect(c.inferred["opencode-go/kimi-k3#max"]).toBeUndefined();
    // GPT-6 Luna's missing agentic value comes from its shipped treat-like, not a guess
    expect(scoresOf(c, "gpt-6-luna#high")?.inferred).toEqual([]);
    // GPT-5.6 Terra has no repo_code, terminal or honesty value: stand-ins lend them, as inferred
    const terra = scoresOf(c, "gpt-5.6-terra#high");
    expect(terra?.inferred).toEqual(["repo_code", "terminal", "honesty"]);
    expect(terra?.standIns.repo_code).toBe(c.inferred["gpt-5.6-terra#high"]?.repo_code?.like);
    // steer carries no bar: never inferred
    expect(Object.values(c.inferred).some((x) => x.steer)).toBe(false);
  });

  it("is what loadCatalog serves routing", () => {
    withHome();
    const c = loadCatalog({ timings: false });
    expect(c.inferred).toEqual(inferStandIns({ ...c, inferred: {} }));
    expect(scoresOf(c, "gpt-5.6-terra#high")?.values.repo_code).toBeDefined();
  });
});

describe("a new release of a family line (spec 1.5 plan 24)", () => {
  it("takes at least its predecessor's value at the same effort until a value of its own arrives", () => {
    const models = shippedModels();
    // as if GPT-5.6 Terra succeeded GPT-5.6 Luna
    for (const f of models.families) if (f.id === "gpt-5.6-terra") f.predecessor = "gpt-5.6-luna";
    const c = withStandIns(buildCatalog({ models, scores: shippedScores() }));
    const terra = scoresOf(c, "gpt-5.6-terra#high");
    // repo_code: Luna's 67 beats the nearest stand-in's guess, so the predecessor stands in
    expect(c.inferred["gpt-5.6-terra#high"]?.repo_code).toEqual({
      like: "gpt-5.6-luna#high",
      distance: 0,
      features: ["predecessor"],
    });
    expect(terra?.values.repo_code).toBe(67);
    // terminal and honesty: the nearest stand-in's values are higher than Luna's (13, 21.8), so they stay
    expect(terra?.standIns.terminal).not.toBe("gpt-5.6-luna#high");
    expect(terra?.values.terminal).toBeGreaterThan(13);
    expect(terra?.standIns.honesty).not.toBe("gpt-5.6-luna#high");
  });

  it("ships GPT-6.1 Sol as GPT-6 Sol's successor, which stands in for it without the treat-like", () => {
    expect(shippedModels().families.find((f) => f.id === "gpt-6.1-sol")?.predecessor).toBe("gpt-6-sol");
    const scores = shippedScores();
    const treatLike = Object.fromEntries(
      Object.entries(scores.treatLike).filter(([rung]) => !rung.startsWith("gpt-6.1-sol#")),
    );
    const c = withStandIns(buildCatalog({ models: shippedModels(), scores: { ...scores, treatLike } }));
    expect(scoresOf(c, "gpt-6.1-sol#high")?.standIns.repo_code).toBe("gpt-6-sol#high");
    expect(scoresOf(c, "gpt-6.1-sol#high")?.values.repo_code).toBe(
      scoresOf(c, "gpt-6-sol#high")?.values.repo_code,
    );
  });
});
