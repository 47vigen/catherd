import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runCommand } from "citty";
import { assetPath } from "../src/files.ts";
import {
  loadCatalog,
  MODELS_DEV_URL,
  modelOf,
  refreshModelsDev,
  snapshotPath,
  trimModelsDev,
} from "../src/routing/catalog.ts";
import { catalogCommand } from "../src/routing/commands.ts";
import { fakeFetch } from "./fake-fetch.ts";
import { withHome } from "./helpers.ts";

const api = {
  openrouter: {
    id: "openrouter",
    models: {
      "acme/coder-1": {
        id: "acme/coder-1",
        tool_call: true,
        reasoning: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 262144, output: 32768 },
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
        cost: { input: 1, output: 2 },
      },
      "acme/painter": {
        tool_call: false,
        reasoning: false,
        modalities: { input: ["text"], output: ["image"] },
        limit: { context: 8192 },
      },
      "acme/chat-only": {
        tool_call: false,
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 8192 },
      },
      "acme/old": {
        tool_call: true,
        status: "deprecated",
        modalities: { input: ["text"], output: ["text"] },
        limit: { context: 8192 },
      },
    },
  },
  "no-models": { id: "no-models" },
};

const saved = { ...process.env };
const savedFetch = globalThis.fetch;
beforeEach(() => withHome());
afterEach(() => {
  process.env = { ...saved };
  globalThis.fetch = savedFetch;
});

describe("models.dev snapshot", () => {
  test("keeps capabilities and efforts, and drops models that can fill no role", () => {
    expect(trimModelsDev(api, "2026-09-24T00:00:00Z")).toEqual({
      fetchedAt: "2026-09-24T00:00:00Z",
      models: {
        "openrouter/acme/coder-1": {
          toolCall: true,
          imageIn: true,
          imageOut: false,
          reasoning: true,
          context: 262144,
          efforts: ["low", "medium", "high"],
        },
        "openrouter/acme/painter": {
          toolCall: false,
          imageIn: false,
          imageOut: true,
          reasoning: false,
          context: 8192,
          efforts: [],
        },
      },
    });
  });

  test("refreshes the local snapshot, which loadCatalog then prefers", async () => {
    const f = fakeFetch({ status: 200, body: api });
    expect(await refreshModelsDev({ fetchImpl: f.impl })).toEqual({ models: 2 });
    expect(f.sent[0]?.url).toBe(MODELS_DEV_URL);
    expect(existsSync(snapshotPath())).toBe(true);
    expect(modelOf(loadCatalog(), "openrouter/acme/coder-1")?.efforts).toEqual([
      "default",
      "low",
      "medium",
      "high",
    ]);
  });

  test("refuses an answer with no models and keeps the previous snapshot", async () => {
    await refreshModelsDev({ fetchImpl: fakeFetch({ status: 200, body: api }).impl });
    const before = readFileSync(snapshotPath(), "utf8");
    await expect(refreshModelsDev({ fetchImpl: fakeFetch({ status: 200, body: {} }).impl })).rejects.toThrow(
      /no models/,
    );
    expect(readFileSync(snapshotPath(), "utf8")).toBe(before);
  });

  test("runs as `catherd catalog refresh`", async () => {
    globalThis.fetch = fakeFetch({ status: 200, body: api }).impl;
    await runCommand(catalogCommand, { rawArgs: ["refresh"] });
    expect(existsSync(snapshotPath())).toBe(true);
  });

  test("ships a real snapshot as the fallback", () => {
    const shipped = JSON.parse(readFileSync(assetPath("catalog/models-dev.json"), "utf8"));
    expect(Object.keys(shipped.models).length).toBeGreaterThan(1000);
  });
});
