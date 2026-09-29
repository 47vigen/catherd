import { describe, expect, it } from "bun:test";
import { applyFacts, buildCatalog } from "../../src/domain/catalog.ts";
import { derive, openRouterIds } from "../../src/services/source-derive.ts";
import { fixtureJson, rawAnswers, shippedContext } from "./source-fixtures.ts";

const AT = "2026-09-28T10:00:00.000Z";
const NOW = Date.parse(AT);
const keyless = () => derive(rawAnswers(AT), shippedContext(NOW));
const find = (d: ReturnType<typeof derive>, rung: string, dim: string, confidence: string) =>
  d.scores.filter((s) => s.rung === rung && s.dim === dim && s.confidence === confidence);

describe("id and effort mapping (spec 1.2 §3.4)", () => {
  it("lists every source id no family matched, never guessing one", () => {
    expect(keyless().unmatched).toEqual({
      arena: ["Claude Opus 5", "Kimi K3", "claude-opus-5", "glm-5.3", "kimi-k3", "muse-spark-1.3"],
      vectara: ["antgroup/finix_s1_32b", "google/gemini-2.5-pro", "openai/gpt-5.5"],
      epoch: ["claude-opus-5", "glm-5.3", "gpt-5.5", "kimi-k3"],
    });
  });

  it("maps a source that names no effort onto the family's default effort, marked assumed", () => {
    // Epoch's WebDev table names Haiku 4.5 by its dated id and no effort: Haiku's default is `default`
    expect(find(keyless(), "claude-haiku-4-5#default", "frontend", "calibrated")).toEqual([
      expect.objectContaining({
        rung: "claude-haiku-4-5#default",
        dim: "frontend",
        value: 1296.0638,
        benchmark: "WebDev Arena (Epoch AI)",
        date: "2026-01-05",
        source: "epoch",
        effortAssumed: true,
      }),
    ]);
  });
});

describe("a family with no effort (spec 1.3 §7.1)", () => {
  it("keys every source value of an effortless family at #default, whatever effort the source names", () => {
    const raw = rawAnswers(AT);
    const arena = raw.arena?.data as Record<string, { rows: { row: Record<string, unknown> }[] }>;
    const webdev = arena.webdev as { rows: { row: Record<string, unknown> }[] };
    const like = webdev.rows[0]?.row as Record<string, unknown>;
    webdev.rows.push({ row: { ...like, model_name: "Composer 2.5 (None)", rating: 1500 } });
    const d = derive(raw, shippedContext(NOW));
    expect(find(d, "composer-2-5#default", "frontend", "measured")).toEqual([
      expect.objectContaining({ value: 1500, source: "arena" }),
    ]);
    expect(
      d.scores.filter((s) => s.rung.startsWith("composer-2-5#") && s.rung !== "composer-2-5#default"),
    ).toEqual([]);
    expect(d.unmatched.arena).not.toContain("Composer 2.5");
  });
});

describe("anchors and calibration (spec 1.2 §4.1, §4.2)", () => {
  it("takes the anchor's own values as measured", () => {
    expect(find(keyless(), "claude-opus-5-5#high", "agentic", "measured")).toEqual([
      {
        rung: "claude-opus-5-5#high",
        dim: "agentic",
        value: 0.1215,
        benchmark: "Arena agent, net improvement",
        version: "2026-09-27",
        url: "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset",
        date: "2026-09-27",
        confidence: "measured",
        source: "arena",
      },
    ]);
    expect(find(keyless(), "claude-opus-5-5#max", "frontend", "measured")[0]?.value).toBe(1826.7307);
  });

  it("fits a source sharing five or more rungs and uses it at R² ≥ 0.5, storing each fit", () => {
    const d = keyless();
    const fit = (source: string, field: string) =>
      d.fits.find((f) => f.source === source && f.field === field);
    expect(fit("arena", "agent_task_outcome_explicit")).toMatchObject({ dim: "agentic", n: 12, used: true });
    expect(fit("arena", "agent_task_outcome_explicit")?.r2).toBeCloseTo(0.7638, 3);
    expect(fit("epoch", "webdev")).toMatchObject({ dim: "frontend", n: 10, used: true });
    const cal = find(d, "claude-fable-5-1#max", "frontend", "calibrated")[0];
    expect(cal?.source).toBe("epoch");
    expect(cal?.fit).toMatchObject({ source: "epoch", field: "webdev", n: 10 });
    expect(cal?.value).toBeCloseTo((cal?.fit?.a ?? 0) * 1758.05 + (cal?.fit?.b ?? 0), 3);
  });

  it("rejects a source that shares fewer than five rungs with the anchor", () => {
    const d = keyless();
    // FrontierCode shares GPT-5.6 Sol max and Luna max with the shipped DeepSWE values, nothing more
    expect(d.fits.find((f) => f.field === "frontiercode")).toEqual({
      dim: "repo_code",
      source: "epoch",
      field: "frontiercode",
      n: 2,
      a: null,
      b: null,
      r2: null,
      used: false,
      why: "2 shared rungs; a fit needs 5",
    });
    expect(d.scores.some((s) => s.dim === "repo_code")).toBe(false);
  });

  it("anchors terminal on the vendors' Terminal-Bench 4.0 values, fitting Epoch's 2.0 table onto them (C-2)", () => {
    const d = keyless();
    // Epoch's Terminal-Bench shares no rung with the shipped values: it is not used, and Haiku gets none
    expect(d.fits.find((f) => f.field === "terminalbench")).toMatchObject({
      dim: "terminal",
      source: "epoch",
      n: 0,
      used: false,
    });
    expect(d.scores.filter((s) => s.dim === "terminal")).toEqual([]);
  });

  it("anchors on the hand-typed values only, never on a shipped keyless value", () => {
    const c = shippedContext(NOW);
    // a shipped value that came from a source (it carries one) is no anchor: the fits stay as they are
    const scores = [
      ...c.scores.scores,
      ...[
        "gpt-5.6-terra#max",
        "gpt-6-astra#max",
        "claude-sonnet-5#max",
        "gpt-6-luna#max",
        "gpt-6-sol#high",
      ].map((rung) => ({
        rung,
        dim: "honesty" as const,
        value: 50,
        benchmark: "Vectara",
        version: "x",
        url: "https://example.com/v",
        date: "2026-09-27",
        confidence: "measured" as const,
        source: "vectara",
      })),
    ];
    const d = derive(rawAnswers(AT), { ...c, scores: { ...c.scores, scores } });
    expect(d.fits.filter((f) => f.dim === "honesty")).toEqual(
      keyless().fits.filter((f) => f.dim === "honesty"),
    );
  });

  it("keeps Artificial Analysis's stand-in features per rung, and none without its answer (spec 1.2 §6.3)", () => {
    expect(keyless().features).toEqual({});
    const d = derive(rawAnswers(AT, { aa: true }), shippedContext(NOW));
    expect(Object.keys(d.features["gpt-6-sol#max"] ?? {}).sort()).toEqual(
      ["artificial_analysis_intelligence_index", "hle", "lcr", "scicode"].sort(),
    );
  });

  it("calibrates Artificial Analysis onto the shipped anchor, never using it as one (synthetic fixture)", () => {
    const d = derive(rawAnswers(AT, { aa: true }), shippedContext(NOW));
    expect(d.fits.find((f) => f.field === "scicode")).toMatchObject({ dim: "repo_code", n: 5, used: true });
    expect(d.fits.find((f) => f.field === "livecodebench")).toMatchObject({ n: 4, used: false });
    expect(d.scores.filter((s) => s.source === "artificial-analysis" && s.confidence === "measured")).toEqual(
      [],
    );
  });
});

describe("adjacent values (spec 1.2 §4.3)", () => {
  it("carries a family's synced value to its other efforts, from the nearest effort", () => {
    // over the hand-typed values alone: the shipped file carries the keyless values spread already
    const c = shippedContext(NOW);
    const hand = c.scores.scores.filter((s) => s.source === undefined && s.confidence !== "adjacent");
    const d = derive(rawAnswers(AT), { ...c, scores: { ...c.scores, scores: hand } });
    expect(find(d, "claude-opus-5-5#max", "agentic", "adjacent")).toEqual([
      expect.objectContaining({
        value: 0.1215,
        source: "arena",
        note: "arena has it at high; carried to this effort",
      }),
    ]);
    // Sol has Arena values at max only: every other effort takes them
    expect(find(d, "gpt-6-sol#low", "steer", "adjacent")[0]?.value).toBe(0.1335);
  });

  it("never spreads the shipped values, and leaves Opus 5.5 without a coding or terminal value (plan 13 R-D)", () => {
    const d = keyless();
    expect(find(d, "gpt-6-luna#low", "repo_code", "adjacent")).toEqual([]);
    expect(
      d.scores.filter(
        (s) => s.rung.startsWith("claude-opus-5-5#") && ["repo_code", "terminal"].includes(s.dim),
      ),
    ).toEqual([]);
  });
});

describe("catalog facts (spec 1.2 §3.5)", () => {
  it("takes price, capabilities and the opencode efforts and context from models.dev", () => {
    expect(keyless().facts["gpt-6-sol"]).toEqual({
      price: { input: 2, cached: 0.2, output: 10 },
      capabilities: { toolUse: true, imageIn: true, reasoning: true },
      on: { opencode: { efforts: ["none", "low", "medium", "high", "xhigh", "max"], context: 1050000 } },
      releaseDate: "2026-09-22",
      speed: { "openrouter.uptime_last_30m": (99.87737584304108 + 99.97978535724786) / 2 },
    });
  });

  it("finds a family under the vendor's own dotted or aliased id (spec 1.3 §7.1)", () => {
    const raw = rawAnswers(AT);
    const md = raw["models-dev"]?.data as Record<string, { models: Record<string, unknown> }>;
    const model = (input: number, output: number) => ({
      reasoning: true,
      tool_call: true,
      release_date: "2026-09-02",
      modalities: { input: ["text", "image"] },
      cost: { input, output, cache_read: input / 10 },
    });
    md.google = { models: { "gemini-3.8-flash": model(0.75, 3.75), "gemini-3.1-pro-preview": model(2, 12) } };
    const d = derive(raw, shippedContext(NOW));
    expect(d.facts["gemini-3-8-flash"]?.price).toEqual({ input: 0.75, cached: 0.075, output: 3.75 });
    expect(d.facts["gemini-3-1-pro"]?.price).toEqual({ input: 2, cached: 0.2, output: 12 });
  });

  it("keeps the shipped file as the floor when laying the facts over the families", () => {
    const ctx = shippedContext(NOW);
    const facts = { "gpt-6-sol": { on: { opencode: { efforts: ["low", "turbo"] } }, speed: {} } };
    const sol = applyFacts(ctx.models.families, facts).find((f) => f.id === "gpt-6-sol");
    expect(sol?.on.opencode?.efforts).toEqual(["none", "low", "medium", "high", "xhigh", "max", "turbo"]);
    expect(sol?.on.codex?.efforts).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(sol?.price).toEqual({ input: 2, cached: 0.2, output: 10 });
    const c = buildCatalog({ models: ctx.models, scores: ctx.scores, facts, now: NOW });
    expect(c.families.find((f) => f.id === "gpt-6-sol")?.on.opencode?.efforts).toContain("turbo");
  });

  it("lets a sync add a capability, never remove one", () => {
    const ctx = shippedContext(NOW);
    const shipped = ctx.models.families.filter((f) => f.id === "gpt-6-sol");
    const [sol] = shipped;
    if (!sol) throw new Error("no gpt-6-sol");
    const noImage = [{ ...sol, capabilities: { ...sol.capabilities, imageIn: false } }];
    const says = (imageIn: boolean) => ({
      "gpt-6-sol": { capabilities: { toolUse: false, imageIn, reasoning: true }, on: {}, speed: {} },
    });
    expect(applyFacts(shipped, says(false))[0]?.capabilities).toEqual(sol.capabilities);
    expect(applyFacts(noImage, says(true))[0]?.capabilities.imageIn).toBe(true);
  });

  it("warns when OpenRouter or LiteLLM prices a family more than 10 % apart, or disagrees on an effort", () => {
    expect(keyless().warnings).toEqual([]);
    const raw = rawAnswers(AT);
    const or = structuredClone(fixtureJson("openrouter-models.json")) as {
      data: { id: string; pricing: { prompt: string } }[];
    };
    const sol = or.data.find((m) => m.id === "openai/gpt-6-sol");
    if (sol) sol.pricing.prompt = "0.0000025";
    const ll = structuredClone(fixtureJson("litellm.json")) as Record<string, Record<string, unknown>>;
    if (ll["gpt-6-luna"]) ll["gpt-6-luna"].supports_minimal_reasoning_effort = true;
    const d = derive(
      { ...raw, "openrouter-models": { fetchedAt: AT, data: or }, litellm: { fetchedAt: AT, data: ll } },
      shippedContext(NOW),
    );
    expect(d.warnings).toEqual([
      "gpt-6-sol: input price $2/M on models.dev, $2.5/M on OpenRouter (more than 10 % apart)",
      "gpt-6-luna: LiteLLM says effort minimal is supported; models.dev does not list it",
    ]);
  });

  it("finds one OpenRouter id per catalog family OpenRouter lists (plan 13 R-H)", () => {
    expect(openRouterIds(fixtureJson("openrouter-models.json"), shippedContext(NOW))).toEqual([
      "openai/gpt-6-sol",
      "openai/gpt-6-luna",
      "anthropic/claude-opus-5.5",
      "anthropic/claude-haiku-4.5",
    ]);
  });
});
