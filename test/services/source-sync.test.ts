import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildCatalog } from "../../src/domain/catalog.ts";
import type { SourceId } from "../../src/domain/sources.ts";
import {
  calibrationPath,
  cachePath,
  derivedPath,
  readCached,
  readDerived,
  tryLockSync,
} from "../../src/infra/sources/cache.ts";
import { AA_MODELS_URL } from "../../src/infra/sources/artificial-analysis.ts";
import { arenaUrl } from "../../src/infra/sources/arena.ts";
import { MODELS_DEV_URL } from "../../src/infra/sources/models-dev.ts";
import { VECTARA_URL } from "../../src/infra/sources/vectara.ts";
import {
  loadCatalog,
  overridePath,
  saveTreatLike,
  shippedModels,
  shippedScores,
} from "../../src/services/catalog-service.ts";
import { validateNamed } from "../../src/services/profile-store.ts";
import { backgroundSync, sourcesStatus, syncSources, TTL_MS } from "../../src/services/source-sync.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { fixtureJson, recordedFetch } from "./source-fixtures.ts";

afterEach(snapshotEnv());

const T0 = Date.parse("2026-09-28T10:00:00.000Z");
/** A clock the test moves; retries never wait for real. */
function clock(start = T0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => void (t += ms),
    transport: (impl: typeof fetch) => ({
      fetchImpl: impl,
      now: () => t,
      sleep: async (ms: number) => void (t += ms),
      random: () => 0.5,
    }),
  };
}
/** The recorded answers, with an Arena agent row for GPT-6 Luna (High), which the recording lacks. */
function withLunaAgent(): typeof fetch {
  const base = recordedFetch().impl;
  return (async (input: RequestInfo | URL) => {
    const res = await base(input);
    if (String(input) !== arenaUrl("agent")) return res;
    const body = (await res.json()) as { rows: { row: Record<string, unknown> }[] };
    const row = {
      ...body.rows[0]?.row,
      model_name: "GPT 6 Luna (High)",
      organization: "openai",
      score: 0.03,
    };
    body.rows.push({ row });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

const KEYLESS: SourceId[] = [
  "models-dev",
  "openrouter-models",
  "openrouter-endpoints",
  "litellm",
  "arena",
  "vectara",
  "epoch",
];

describe("the sync (spec 1.2 §3.2, §3.3)", () => {
  it("fetches every keyless source, caches each answer with its fetch time, and derives the synced values", async () => {
    withHome();
    const c = clock();
    const f = recordedFetch();
    const r = await syncSources({ transport: c.transport(f.impl), now: c.now, aaKey: null });
    expect(r.busy).toBe(false);
    expect(r.sources.filter((s) => s.state === "fetched").map((s) => s.source)).toEqual(KEYLESS);
    expect(r.sources.find((s) => s.source === "artificial-analysis")).toMatchObject({ state: "skipped" });
    // 1 + 1 + 1 + 6 Arena configs + 1 + 1 + one endpoints request per family OpenRouter lists (4)
    expect(f.urls).toHaveLength(15);
    expect(f.urls).not.toContain(AA_MODELS_URL);
    expect(readCached("vectara")?.fetchedAt).toBe("2026-09-28T10:00:00.000Z");
    expect(existsSync(derivedPath())).toBe(true);
    expect(JSON.parse(readFileSync(calibrationPath(), "utf8")).fits.length).toBeGreaterThan(0);
    expect(r.failed).toEqual([]);
    expect(r.unmatched.vectara).toEqual(["antgroup/finix_s1_32b", "google/gemini-2.5-pro", "openai/gpt-5.5"]);
  });

  it("reports no rung newly scored when the shipped file carries the sources, and routes on a new value at once", async () => {
    withHome();
    const c = clock();
    // GPT-6 Luna has no Arena agent row in the recorded answers: this one gives Luna high its first agentic value
    const r = await syncSources({ transport: c.transport(withLunaAgent()), now: c.now, aaKey: null });
    // Gemini 3.8 Flash's family is new in 1.3: the weekly refresh ships its values, the recorded file has none.
    // Both backends list low, medium and high, so Arena's value at high spreads to those and not to #default.
    expect(r.newlyScored).toEqual([
      "gemini-3-8-flash#high",
      "gemini-3-8-flash#low",
      "gemini-3-8-flash#medium",
    ]);
    expect(loadCatalog({ timings: false }).scores["gpt-6-luna#high"]?.agentic).toMatchObject({
      value: 0.03,
      confidence: "measured",
      source: "arena",
    });
  });

  it("fetches a source only when its answer is older than 12 hours, unless forced", async () => {
    withHome();
    const c = clock();
    await syncSources({ transport: c.transport(recordedFetch().impl), now: c.now, aaKey: null });
    c.advance(TTL_MS - 1);
    const again = recordedFetch();
    const r = await syncSources({ transport: c.transport(again.impl), now: c.now, aaKey: null });
    expect(again.urls).toEqual([]);
    expect(r.sources.filter((s) => s.state === "fresh").map((s) => s.source)).toEqual(KEYLESS);
    const forced = recordedFetch();
    await syncSources({ force: true, transport: c.transport(forced.impl), now: c.now, aaKey: null });
    expect(forced.urls).toHaveLength(15);
    c.advance(TTL_MS);
    const due = recordedFetch();
    await syncSources({ transport: c.transport(due.impl), now: c.now, aaKey: null });
    expect(due.urls).toHaveLength(15);
  });

  it("fetches again a source whose cache file is corrupt, even within the TTL", async () => {
    withHome();
    const c = clock();
    await syncSources({ transport: c.transport(recordedFetch().impl), now: c.now, aaKey: null });
    writeFileSync(cachePath("vectara"), "{ not json");
    c.advance(60_000);
    const again = recordedFetch();
    const r = await syncSources({ transport: c.transport(again.impl), now: c.now, aaKey: null });
    expect(again.urls).toEqual([VECTARA_URL]);
    expect(r.sources.find((s) => s.source === "vectara")?.state).toBe("fetched");
    expect(readCached("vectara")).not.toBeNull();
  });

  it("rebuilds a corrupt derived.json when every source is fresh", async () => {
    withHome();
    const c = clock();
    await syncSources({ transport: c.transport(recordedFetch().impl), now: c.now, aaKey: null });
    writeFileSync(derivedPath(), "{ not json");
    expect(readDerived()).toBeNull();
    c.advance(60_000);
    const again = recordedFetch();
    const r = await syncSources({ transport: c.transport(again.impl), now: c.now, aaKey: null });
    expect(again.urls).toEqual([]);
    expect(r.sources.filter((s) => s.state === "fresh").map((s) => s.source)).toEqual(KEYLESS);
    expect(readDerived()?.scores.length).toBeGreaterThan(0);
  });

  it("keeps a failed source's last good answer, records the error and goes on", async () => {
    withHome();
    const c = clock();
    await syncSources({ transport: c.transport(recordedFetch().impl), now: c.now, aaKey: null });
    const good = readFileSync(cachePath("vectara"), "utf8");
    c.advance(TTL_MS);
    const r = await syncSources({
      transport: c.transport(recordedFetch({ fail: (u) => u === VECTARA_URL }).impl),
      now: c.now,
      aaKey: null,
    });
    expect(r.failed).toEqual([{ source: "vectara", error: "network error" }]);
    expect(r.sources.find((s) => s.source === "vectara")).toMatchObject({
      state: "failed",
      fetchedAt: "2026-09-28T10:00:00.000Z",
    });
    expect(readFileSync(cachePath("vectara"), "utf8")).toBe(good);
    expect(r.sources.filter((s) => s.state === "fetched")).toHaveLength(KEYLESS.length - 1);
    expect(sourcesStatus().sources.find((s) => s.source === "vectara")?.error).toBe("network error");
  });

  it("gives a failing source an hour's rest in the background, never in the foreground", async () => {
    withHome();
    const c = clock();
    const down = (u: string) => u === MODELS_DEV_URL;
    await syncSources({
      transport: c.transport(recordedFetch({ fail: down }).impl),
      now: c.now,
      aaKey: null,
    });
    c.advance(60_000);
    const bg = recordedFetch();
    const r = await syncSources({
      background: true,
      transport: c.transport(bg.impl),
      now: c.now,
      aaKey: null,
    });
    expect(bg.urls).toEqual([]);
    expect(r.sources.find((s) => s.source === "models-dev")?.state).toBe("skipped");
    const fg = recordedFetch();
    await syncSources({ transport: c.transport(fg.impl), now: c.now, aaKey: null });
    expect(fg.urls).toEqual([MODELS_DEV_URL]);
  });

  it("does nothing in the background while another sync holds the lock", async () => {
    withHome();
    const release = tryLockSync();
    const f = recordedFetch();
    const r = await syncSources({ background: true, transport: clock().transport(f.impl), aaKey: null });
    release?.();
    expect([r.busy, f.urls.length]).toEqual([true, 0]);
  });

  it("says when the user's stand-in is no longer needed, and never removes it", async () => {
    withHome();
    // Luna high borrows agentic from a rung only the user scored; an Arena row for it covers that after a sync
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(
      overridePath(),
      JSON.stringify({
        schema: 1,
        scores: [
          {
            rung: "yardstick#high",
            dim: "agentic",
            value: 0.05,
            benchmark: "mine",
            version: "1",
            url: "https://example.com/mine",
            date: "2026-09-27",
            confidence: "verified",
          },
        ],
      }),
    );
    await saveTreatLike("gpt-6-luna#high", "yardstick#high");
    const c = clock();
    const r = await syncSources({ transport: c.transport(withLunaAgent()), now: c.now, aaKey: null });
    expect(r.noLongerNeeded).toEqual([{ rung: "gpt-6-luna#high", like: "yardstick#high" }]);
    expect(loadCatalog({ timings: false }).treatLike["gpt-6-luna#high"]).toEqual({
      like: "yardstick#high",
      source: "user",
    });
  });

  it("reads Artificial Analysis with the key and keeps its requests left", async () => {
    withHome();
    const c = clock();
    const f = recordedFetch();
    const r = await syncSources({ transport: c.transport(f.impl), now: c.now, aaKey: "aa-key-0123456789" });
    expect(r.sources.find((s) => s.source === "artificial-analysis")?.state).toBe("fetched");
    expect(f.urls).toContain(AA_MODELS_URL);
    process.env.ARTIFICIAL_ANALYSIS_API_KEY = "aa-key-0123456789";
    expect(sourcesStatus()).toMatchObject({
      aaKey: true,
      rateLimitRemaining: 98,
      rateLimitAt: "2026-09-28T10:00:00.000Z",
    });
  });
});

describe("the shipped values after a sync (plan 13 R7, R18)", () => {
  it("are never overwritten by an adjacent value; a rung with no value of its own still gets one", async () => {
    withHome();
    const c = clock();
    await syncSources({
      transport: c.transport(recordedFetch().impl),
      now: c.now,
      aaKey: "aa-key-0123456789",
    });
    const synced = readDerived()?.scores ?? [];
    const adj = (rung: string) =>
      synced.filter((s) => s.rung === rung && s.dim === "repo_code" && s.confidence === "adjacent");
    // AA's SciCode fits repo_code at Sol max; Sol low keeps its shipped DeepSWE value
    expect(adj("gpt-6-sol#low")).toEqual([]);
    expect(loadCatalog({ timings: false }).scores["gpt-6-sol#low"]?.repo_code).toMatchObject({
      value: 37.2,
      confidence: "secondary",
    });
    // Sol none carries Sol low's DeepSWE value in the shipped file (plan 14): a sync spreads nothing over it
    expect(adj("gpt-6-sol#none")).toEqual([]);
    expect(loadCatalog({ timings: false }).scores["gpt-6-sol#none"]?.repo_code).toMatchObject({
      value: 37.2,
      confidence: "adjacent",
      note: "DeepSWE has it at low; carried to this effort",
    });
  });

  it("keep terminal: Epoch's Terminal-Bench 2.0 shares no rung with the shipped 4.0 anchor (plan 14 C-2)", async () => {
    withHome();
    const shipped = buildCatalog({ models: shippedModels(), scores: shippedScores() });
    const c = clock();
    await syncSources({
      transport: c.transport(recordedFetch().impl),
      now: c.now,
      aaKey: "aa-key-0123456789",
    });
    const synced = readDerived()?.scores ?? [];
    expect(synced.filter((s) => s.dim === "terminal" && s.source === "epoch")).toEqual([]);
    expect(synced.filter((s) => s.dim === "terminal")).toEqual([]);
    // the fit onto Epoch's Terminal-Bench is still computed and recorded
    expect(readDerived()?.fits.some((f) => f.dim === "terminal")).toBe(true);
    const after = loadCatalog({ timings: false });
    for (const rung of Object.keys(shipped.scores).concat(["claude-haiku-4-5#default"]))
      expect(after.scores[rung]?.terminal).toEqual(shipped.scores[rung]?.terminal);
  });
});

describe("the shipped defaults after a sync (plan 13 R-A)", () => {
  it("leave the default profile valid, with no warning, before and after a sync of the recorded answers", async () => {
    withHome();
    expect(validateNamed("default", null, "claude-code")).toEqual({ errors: [], warnings: [] });
    const c = clock();
    await syncSources({ transport: c.transport(recordedFetch().impl), now: c.now, aaKey: null });
    expect(validateNamed("default", null, "claude-code")).toEqual({ errors: [], warnings: [] });
  });

  it("keep every shipped capability when models.dev denies one (spec 1.2 §3.5: the shipped file is the floor)", async () => {
    withHome();
    const md = structuredClone(fixtureJson("models-dev.json")) as Record<
      string,
      { models: Record<string, { modalities?: { input?: string[] } }> }
    >;
    const sol = md.openai?.models["gpt-6-sol"];
    if (!sol) throw new Error("fixture lacks openai/gpt-6-sol");
    sol.modalities = { input: ["text"] };
    const base = recordedFetch().impl;
    const impl = (async (input: RequestInfo | URL) =>
      String(input) === MODELS_DEV_URL
        ? new Response(JSON.stringify(md), { status: 200 })
        : base(input)) as typeof fetch;
    const c = clock();
    await syncSources({ transport: c.transport(impl), now: c.now, aaKey: null });
    expect(readDerived()?.facts["gpt-6-sol"]?.capabilities?.imageIn).toBe(false);
    const fam = loadCatalog({ timings: false }).families.find((f) => f.id === "gpt-6-sol");
    expect(fam?.capabilities).toEqual({ toolUse: true, imageIn: true, reasoning: true });
    expect(validateNamed("default", null, "claude-code")).toEqual({ errors: [], warnings: [] });
  });
});

describe("offline (spec 1.2 §11)", () => {
  it("with no network and no cache, routing reads the shipped values", async () => {
    withHome();
    const c = clock();
    const r = await syncSources({
      transport: c.transport(recordedFetch({ fail: () => true }).impl),
      now: c.now,
      aaKey: null,
    });
    expect(r.failed.map((x) => x.source)).toEqual(KEYLESS);
    expect(readDerived()).toBeNull();
    const shipped = buildCatalog({ models: shippedModels(), scores: shippedScores() });
    const c2 = loadCatalog({ timings: false });
    expect(c2.scores).toEqual(shipped.scores);
    expect(c2.families).toEqual(shipped.families);
  });
});

describe("the background sync (spec 1.2 §3.2)", () => {
  it("is off with CATHERD_NO_SYNC=1, as in every test", async () => {
    withHome();
    expect(process.env.CATHERD_NO_SYNC).toBe("1");
    const f = recordedFetch();
    expect(await backgroundSync({ transport: clock().transport(f.impl), aaKey: null })).toBeNull();
    expect(f.urls).toEqual([]);
  });

  it("runs otherwise, and never throws", async () => {
    withHome();
    delete process.env.CATHERD_NO_SYNC;
    const c = clock();
    const r = await backgroundSync({ transport: c.transport(recordedFetch().impl), now: c.now, aaKey: null });
    expect(r?.sources.filter((s) => s.state === "fetched")).toHaveLength(KEYLESS.length);
  });
});
