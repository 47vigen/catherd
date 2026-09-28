import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AA_MODELS_URL,
  aaFreeUrl,
  aaRung,
  fetchArtificialAnalysis,
  parseArtificialAnalysis,
  testAaKey,
} from "../../../src/infra/sources/artificial-analysis.ts";
import { fakeFetch } from "../../fake-fetch.ts";

const FX = join(import.meta.dir, "..", "..", "fixtures", "sources");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FX, name), "utf8"));
const AT = "2026-09-28T10:00:00.000Z";
const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), random: () => 0.5 };
};
const limit = (n: number) => ({ "x-ratelimit-remaining": String(n) });

describe("Artificial Analysis (spec 1.2 §3.1; fixtures synthetic, see their README)", () => {
  it("reads the effort from the slug, a bare slug meaning max", () => {
    expect(aaRung("gpt-6-astra-xhigh")).toBe("gpt-6-astra#xhigh");
    expect(aaRung("claude-fable-5-1-medium")).toBe("claude-fable-5-1#medium");
    expect(aaRung("gpt-6-astra")).toBe("gpt-6-astra#max");
    expect(aaRung("claude-4-5-haiku")).toBe("claude-4-5-haiku#max");
  });

  it("reads the models path with the user's key in x-api-key, and the requests left", async () => {
    const f = fakeFetch({
      status: 200,
      body: fixture("artificial-analysis-models.json"),
      headers: limit(98),
    });
    const a = await fetchArtificialAnalysis("aa-key-0123456789", { fetchImpl: f.impl, ...clock() });
    expect([a.path, a.pages.length, a.rateLimitRemaining]).toEqual(["models", 1, 98]);
    expect(f.sent[0]?.url).toBe(AA_MODELS_URL);
    expect(f.sent[0]?.headers.get("x-api-key")).toBe("aa-key-0123456789");
  });

  it("falls back to the free path's pages when the models path answers 403 or 404", async () => {
    for (const status of [403, 404]) {
      const f = fakeFetch(
        { status, body: {}, headers: limit(97) },
        { status: 200, body: fixture("artificial-analysis-free-1.json"), headers: limit(96) },
        { status: 200, body: fixture("artificial-analysis-free-2.json"), headers: limit(95) },
      );
      const a = await fetchArtificialAnalysis("k", { fetchImpl: f.impl, ...clock() });
      expect([a.path, a.pages.length, a.rateLimitRemaining]).toEqual(["free", 1, 95]);
      expect(f.sent.map((s) => s.url)).toEqual([AA_MODELS_URL, aaFreeUrl(1), aaFreeUrl(2)]);
    }
  });

  it("fails on a 401 without trying the free path", async () => {
    const f = fakeFetch({ status: 401, body: {}, headers: limit(90) });
    const e = await fetchArtificialAnalysis("bad", { fetchImpl: f.impl, ...clock() }).catch((x) => x);
    expect([e.message, e.status, f.sent.length]).toEqual(["http 401", 401, 1]);
  });

  it("tests a key with one request to the free path: 200 ok, 401 refused, anything else unchecked", async () => {
    const ok = fakeFetch({ status: 200, body: { data: [] }, headers: limit(99) });
    expect(await testAaKey("k", { fetchImpl: ok.impl, ...clock() })).toEqual({
      result: "ok",
      rateLimitRemaining: 99,
    });
    expect(ok.sent.map((s) => s.url)).toEqual([aaFreeUrl(1)]);
    const no = fakeFetch({ status: 401, body: {} });
    expect((await testAaKey("k", { fetchImpl: no.impl, ...clock() })).result).toBe("refused");
    const down = fakeFetch(new TypeError("fetch failed"));
    expect(await testAaKey("k", { fetchImpl: down.impl, ...clock() })).toMatchObject({
      result: "unchecked",
      error: "network error",
    });
  });

  it("gives a row per slug and number: evaluations, prices, speed and cost per task", () => {
    const rows = parseArtificialAnalysis(
      { path: "models", pages: [fixture("artificial-analysis-models.json")], rateLimitRemaining: null },
      AT,
    );
    const of = (rung: string) =>
      Object.fromEntries(rows.filter((r) => r.rung === rung).map((r) => [r.field, r.value]));
    expect(of("gpt-6-astra#xhigh")).toMatchObject({
      livecodebench: 0.86,
      terminalbench_v2_1: 0.61,
      tau2: 0.88,
      price_1m_input_tokens: 10,
      median_output_tokens_per_second: 71.5,
    });
    // a model released days ago: four evaluations and its price, and no null speed
    expect(of("claude-opus-5-5#high")).toEqual({
      artificial_analysis_intelligence_index: 53.6,
      hle: 0.33,
      scicode: 0.6,
      lcr: 0.69,
      price_1m_blended_3_to_1: 8,
      price_1m_input_tokens: 4,
      price_1m_output_tokens: 20,
    });
    expect(rows[0]).toMatchObject({
      date: "2026-09-28",
      url: "https://artificialanalysis.ai/models/gpt-6-astra-xhigh",
    });
    const free = parseArtificialAnalysis(
      { path: "free", pages: [fixture("artificial-analysis-free-1.json")], rateLimitRemaining: null },
      AT,
    );
    expect(free.find((r) => r.rung === "claude-4-5-haiku#max" && r.field === "cost_per_task")?.value).toBe(
      0.05,
    );
  });
});
