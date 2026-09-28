import { afterEach, describe, expect, it } from "bun:test";
import { MODELS_DEV_URL } from "../../src/infra/sources/models-dev.ts";
import { applyPatch, defaultProfileDoc, resolveProfile } from "../../src/domain/profile.ts";
import { ageText, sourcesCheck, standInsToConfirmIn } from "../../src/services/doctor-sources.ts";
import { syncSources, TTL_MS } from "../../src/services/source-sync.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { recordedFetch } from "./source-fixtures.ts";

afterEach(snapshotEnv());

const T0 = Date.parse("2026-09-28T10:00:00.000Z");
const transport = (impl: typeof fetch) => ({
  fetchImpl: impl,
  now: () => T0,
  sleep: async () => {},
  random: () => 0.5,
});
const sync = (o: { aaKey?: string | null; fail?: (u: string) => boolean } = {}) =>
  syncSources({
    transport: transport(recordedFetch({ fail: o.fail }).impl),
    now: () => T0,
    aaKey: o.aaKey ?? null,
  });

describe("doctor's sources row (spec 1.2 §9)", () => {
  it("is info before the first sync: routing uses the shipped scores", () => {
    withHome();
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    expect(sourcesCheck(T0)).toEqual({
      id: "sources",
      label: "sources",
      state: "info",
      word: "not synced",
      detail: "routing uses the shipped scores; no Artificial Analysis key",
      fix: "catherd catalog sync",
    });
  });

  it("gives each source's age once synced", async () => {
    withHome();
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    await sync();
    expect(sourcesCheck(T0 + 2 * 3_600_000)).toEqual({
      id: "sources",
      label: "sources",
      state: "ok",
      word: "fresh",
      detail:
        "models-dev 2 h, openrouter-models 2 h, openrouter-endpoints 2 h, litellm 2 h, arena 2 h, vectara 2 h, epoch 2 h; no Artificial Analysis key",
    });
  });

  it("warns on a failing source, naming its error, and on one not fetched for a day", async () => {
    withHome();
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    await sync({ fail: (u) => u === MODELS_DEV_URL });
    const r = sourcesCheck(T0);
    expect(r).toMatchObject({ state: "warn", word: "failing", fix: "catherd catalog sync --force" });
    expect(r.detail).toStartWith("models-dev never (network error), openrouter-models 1 min,");
    expect(sourcesCheck(T0 + 2 * TTL_MS + 1)).toMatchObject({ state: "warn", word: "failing" });
    withHome();
    await sync();
    expect(sourcesCheck(T0 + 2 * TTL_MS + 1)).toMatchObject({ state: "warn", word: "stale" });
  });

  it("shows the Artificial Analysis key, its age and the requests left today", async () => {
    withHome();
    process.env.ARTIFICIAL_ANALYSIS_API_KEY = "aa-key-0123456789";
    await sync({ aaKey: "aa-key-0123456789" });
    expect(sourcesCheck(T0).detail).toEndWith(
      "epoch 1 min, artificial-analysis 1 min; Artificial Analysis key set, 98 requests left today",
    );
    expect(sourcesCheck(T0 + 24 * 3_600_000).detail).toEndWith("98 requests left on 2026-09-28");
  });

  it("prints ages in minutes, hours, then days", () => {
    expect([
      ageText(10_000),
      ageText(90 * 60_000),
      ageText(47 * 3_600_000),
      ageText(5 * 24 * 3_600_000),
    ]).toEqual(["1 min", "2 h", "47 h", "5 d"]);
  });
});

describe("doctor's stand-ins to confirm (spec 1.2 §6.1, §9)", () => {
  it("lists the rungs that lean on an inferred stand-in, once each, and nothing for the default profile", () => {
    withHome();
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    const def = resolveProfile(defaultProfileDoc(), "default");
    expect(standInsToConfirmIn([def])).toEqual([]);
    const worker = [...def.roles.worker.rungs, "codex:gpt-5.6-terra#high"];
    const terra = resolveProfile(
      applyPatch(defaultProfileDoc(), { roles: { worker: { rungs: worker } } }),
      "t",
    );
    const confirm = standInsToConfirmIn([terra, terra]);
    expect(confirm.map((x) => [x.canonical, x.dims.map((d) => d.dim)])).toEqual([
      ["gpt-5.6-terra#high", ["repo_code", "terminal", "honesty"]],
    ]);
    expect(sourcesCheck(T0, confirm).detail).toBe(
      "routing uses the shipped scores; no Artificial Analysis key; stand-ins to confirm: gpt-5.6-terra#high (repo_code, terminal, honesty)",
    );
  });
});
