import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LITELLM_URL, parseLiteLlm } from "../../../src/infra/sources/litellm.ts";
import { MODELS_DEV_URL, modelsDevFacts } from "../../../src/infra/sources/models-dev.ts";
import {
  fetchOpenRouterEndpoints,
  openRouterEndpointsUrl,
  parseOpenRouterEndpoints,
} from "../../../src/infra/sources/openrouter-endpoints.ts";
import {
  OPENROUTER_MODELS_URL,
  parseOpenRouterModels,
  perMillion,
} from "../../../src/infra/sources/openrouter-models.ts";
import { fakeFetch } from "../../fake-fetch.ts";

const FX = join(import.meta.dir, "..", "..", "fixtures", "sources");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FX, name), "utf8"));
const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), random: () => 0.5 };
};

describe("models.dev (spec 1.2 §3.1, §3.5)", () => {
  it("reads a model's efforts, limits, price, tool calling, image input and release date", () => {
    expect(MODELS_DEV_URL).toBe("https://models.dev/api.json");
    expect(modelsDevFacts(fixture("models-dev.json"), "openai", "gpt-6-sol")).toEqual({
      efforts: ["none", "low", "medium", "high", "xhigh", "max"],
      context: 1050000,
      output: 128000,
      price: { input: 2, cached: 0.2, output: 10 },
      toolUse: true,
      imageIn: true,
      reasoning: true,
      releaseDate: "2026-09-22",
    });
    expect(modelsDevFacts(fixture("models-dev.json"), "opencode-go", "kimi-k3")?.efforts).toEqual(["max"]);
  });

  it("has no effort list for a model priced by thinking budget, and nothing for an absent model", () => {
    const raw = fixture("models-dev.json");
    expect(modelsDevFacts(raw, "anthropic", "claude-haiku-4-5")?.efforts).toBeNull();
    expect(modelsDevFacts(raw, "anthropic", "claude-nope")).toBeNull();
    expect(modelsDevFacts(raw, "nope", "gpt-6-sol")).toBeNull();
    expect(modelsDevFacts(null, "openai", "gpt-6-sol")).toBeNull();
  });
});

describe("OpenRouter models (spec 1.2 §3.1)", () => {
  it("reads id, context, price per million tokens and efforts, variants included", () => {
    expect(OPENROUTER_MODELS_URL).toBe("https://openrouter.ai/api/v1/models");
    const models = parseOpenRouterModels(fixture("openrouter-models.json"));
    expect(models.map((m) => m.id).sort()).toEqual([
      "anthropic/claude-haiku-4.5",
      "anthropic/claude-opus-5.5",
      "openai/gpt-6-luna",
      "openai/gpt-6-sol",
      "openai/gpt-6-sol-pro",
      "openai/gpt-6-sol:batch",
    ]);
    expect(models.find((m) => m.id === "openai/gpt-6-sol")).toEqual({
      id: "openai/gpt-6-sol",
      context: 1050000,
      price: { input: 2, output: 10, cached: 0.2 },
      efforts: ["max", "xhigh", "high", "medium", "low", "none"],
      defaultEffort: "medium",
    });
    expect(parseOpenRouterModels({ data: [{ nope: 1 }] })).toEqual([]);
    expect(parseOpenRouterModels("x")).toEqual([]);
    expect(perMillion("0.0000025")).toBe(2.5);
  });
});

describe("OpenRouter endpoints (spec 1.2 §3.1, plan 13 R-H)", () => {
  it("fetches one answer per id, leaving out an id OpenRouter no longer knows", async () => {
    const f = fakeFetch({ status: 200, body: { data: { endpoints: [] } } }, { status: 404, body: {} });
    const got = await fetchOpenRouterEndpoints(["openai/gpt-6-sol", "openai/gone"], {
      fetchImpl: f.impl,
      ...clock(),
    });
    expect(f.sent.map((s) => s.url)).toEqual([
      openRouterEndpointsUrl("openai/gpt-6-sol"),
      openRouterEndpointsUrl("openai/gone"),
    ]);
    expect(Object.keys(got)).toEqual(["openai/gpt-6-sol"]);
    expect(openRouterEndpointsUrl("openai/gpt-6-sol")).toBe(
      "https://openrouter.ai/api/v1/models/openai/gpt-6-sol/endpoints",
    );
  });

  it("fails the source, naming the id, on any other failure", async () => {
    const f = fakeFetch({ status: 401, body: {} });
    const e = await fetchOpenRouterEndpoints(["openai/gpt-6-sol"], { fetchImpl: f.impl, ...clock() }).catch(
      (x) => x,
    );
    expect(e.message).toBe("openai/gpt-6-sol: http 401");
  });

  it("gives each id the median over its endpoints of each statistic they report", () => {
    const rows = parseOpenRouterEndpoints(
      fixture("openrouter-endpoints.json") as Record<string, unknown>,
      "2026-09-28T10:00:00.000Z",
    );
    // latency and throughput were null on every endpoint that day: no row, never a zero
    expect(rows.map((r) => [r.rung, r.field])).toEqual([
      ["openai/gpt-6-sol", "uptime_last_30m"],
      ["anthropic/claude-opus-5.5", "uptime_last_30m"],
    ]);
    expect(rows[0]?.value).toBeCloseTo((99.87737584304108 + 99.97978535724786) / 2, 9);
    expect(rows[0]).toMatchObject({ date: "2026-09-28", url: "https://openrouter.ai/openai/gpt-6-sol" });
    const synthetic = {
      "openai/gpt-6-sol": {
        data: {
          endpoints: [{ latency_last_30m: { p50: 400 }, throughput_last_30m: 60 }, { latency_last_30m: 600 }],
        },
      },
    };
    expect(
      parseOpenRouterEndpoints(synthetic, "2026-09-28T10:00:00.000Z").map((r) => [r.field, r.value]),
    ).toEqual([
      ["latency_last_30m", 500],
      ["throughput_last_30m", 60],
    ]);
  });
});

describe("LiteLLM (spec 1.2 §3.1)", () => {
  it("reads the first-party entries' price, context and effort flags", () => {
    expect(LITELLM_URL).toBe(
      "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
    );
    const models = parseLiteLlm(fixture("litellm.json"));
    expect(models.map((m) => m.id)).toEqual([
      "gpt-6-sol",
      "gpt-6-luna",
      "claude-opus-5-5",
      "claude-haiku-4-5",
    ]);
    expect(models[0]).toEqual({
      id: "gpt-6-sol",
      provider: "openai",
      price: { input: 2, output: 10, cached: 0.2 },
      context: 922000,
      efforts: { none: true, minimal: false, xhigh: true, max: true },
    });
    expect(models[3]?.efforts).toEqual({});
    expect(parseLiteLlm(null)).toEqual([]);
  });
});
