import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  capableFor,
  entryFor,
  isScored,
  loadCatalog,
  modelOf,
  overridePath,
  saveTreatLike,
} from "../src/routing/catalog.ts";
import type { Score } from "../src/domain/catalog.ts";
import { readOverride } from "../src/services/catalog-service.ts";
import type { CatalogEntry, CatalogModel } from "../src/types.ts";
import { withHome } from "./helpers.ts";

const saved = { ...process.env };
beforeEach(() => withHome());
afterEach(() => {
  process.env = { ...saved };
});

function writeOverride(o: unknown): void {
  mkdirSync(join(overridePath(), ".."), { recursive: true });
  writeFileSync(overridePath(), typeof o === "string" ? o : JSON.stringify(o));
}

const coder: CatalogModel = {
  id: "openrouter/acme/coder-1",
  backend: "opencode",
  efforts: ["default"],
  capabilities: { toolCall: true, imageIn: false, imageOut: false, reasoning: true, context: 131072 },
};

describe("catalog", () => {
  test("ships the Codex and Claude models by hand, with the seed scores", () => {
    const c = loadCatalog();
    expect(modelOf(c, "gpt-6-luna")).toMatchObject({
      backend: "codex",
      efforts: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(modelOf(c, "gpt-6-sol")?.capabilities).toEqual({
      toolCall: true,
      imageIn: true,
      imageOut: true,
      reasoning: true,
      context: 400000,
    });
    expect(modelOf(c, "claude-opus-5-5")).toMatchObject({
      backend: "claude",
      efforts: ["low", "medium", "high"],
    });
    expect(entryFor(c, "gpt-6-luna#high")).toEqual({
      rung: "gpt-6-luna#high",
      scores: { repo_code: 59.3, terminal: 4.5, honesty: 71.3, secs_per_task: 563 },
      costRank: 1,
    });
    expect(entryFor(c, "claude-opus-5-5#high")?.scores).toEqual({ terminal: 56.6 });
    expect(c.entries.map((e) => [e.rung, e.costRank])).toEqual([
      ["gpt-6-luna#high", 1],
      ["gpt-6-sol#medium", 2],
      ["gpt-6-sol#high", 3],
      ["gpt-6-sol#xhigh", 4],
      ["claude-opus-5-5#low", 5],
      ["claude-opus-5-5#medium", 6],
      ["claude-opus-5-5#high", 7],
    ]);
  });

  test("leaves luna#xhigh and luna#max unscored on purpose", () => {
    const c = loadCatalog();
    expect(isScored(c, "gpt-6-luna#xhigh")).toBe(false);
    expect(isScored(c, "gpt-6-luna#max")).toBe(false);
    expect(isScored(c, "gpt-6-sol#xhigh")).toBe(true);
  });

  test("applies overrides to scores, bars, models and treat-like", () => {
    writeOverride({
      entries: { "gpt-6-sol#high": { scores: { repo_code: 70 } } },
      bars: { terminal: { hard: { terminal: 25 } } },
      models: {
        [coder.id]: { backend: coder.backend, efforts: coder.efforts, capabilities: coder.capabilities },
      },
      treatLike: { "openrouter/acme/coder-1#default": "gpt-6-sol#medium" },
    });
    const c = loadCatalog();
    expect(entryFor(c, "gpt-6-sol#high")?.scores).toEqual({
      repo_code: 70,
      terminal: 26.3,
      honesty: 95.1,
      secs_per_task: 391,
    });
    expect(c.bars.terminal.hard).toEqual({ terminal: 25 });
    expect(c.bars.terminal.logic).toEqual({ terminal: 15 });
    expect(modelOf(c, coder.id)).toEqual(coder);
    expect(entryFor(c, "openrouter/acme/coder-1#default")).toEqual({
      ...(entryFor(c, "gpt-6-sol#medium") as CatalogEntry),
      rung: "openrouter/acme/coder-1#default",
    });
    expect(isScored(c, "openrouter/acme/coder-1#default")).toBe(true);
  });

  test("merges a partial model override into the existing model", () => {
    writeOverride({ models: { "gpt-6-sol": { capabilities: { context: 272000 } } } });
    expect(modelOf(loadCatalog(), "gpt-6-sol")?.capabilities).toEqual({
      toolCall: true,
      imageIn: true,
      imageOut: true,
      reasoning: true,
      context: 272000,
    });
  });

  test("skips a treat-like onto a rung only the 1.0 catalog scores", () => {
    writeOverride({
      schema: 1,
      treatLike: { "openrouter/acme/coder-1#default": "gpt-6-astra#xhigh" },
      scores: [],
    });
    expect(loadCatalog().treatLike).toEqual({});
  });

  test("needs a costRank for a new entry, and every capability for a new model", () => {
    writeOverride({ entries: { "gpt-6-luna#medium": { scores: { repo_code: 50 } } } });
    expect(() => loadCatalog()).toThrow(/new entry "gpt-6-luna#medium" needs a costRank/);
    writeOverride({
      models: { "x/y": { backend: "opencode", efforts: ["default"], capabilities: { toolCall: true } } },
    });
    expect(() => loadCatalog()).toThrow(/new model "x\/y" needs a backend, efforts and every capability/);
  });

  test("names the file and the field when the override is malformed", () => {
    writeOverride({ entries: { "gpt-6-sol#high": { costRank: "cheap" } } });
    expect(() => loadCatalog()).toThrow(/catalog\.override\.json is invalid[\s\S]*costRank/);
    writeOverride("{ not json");
    expect(() => loadCatalog()).toThrow(/catalog\.override\.json is not readable JSON/);
  });

  test("checks what a role needs", () => {
    const c = loadCatalog();
    const sol = modelOf(c, "gpt-6-sol") as CatalogModel;
    const opus = modelOf(c, "claude-opus-5-5") as CatalogModel;
    expect(capableFor("artist", sol)).toBe(true);
    expect(capableFor("artist", opus)).toBe(false);
    expect(capableFor("ui-reviewer", opus)).toBe(true);
    expect(capableFor("ui-reviewer", coder)).toBe(false);
    expect(capableFor("worker", { ...sol, capabilities: { ...sol.capabilities, toolCall: false } })).toBe(
      false,
    );
  });

  test("saveTreatLike merges into catalog.override.json, keeping the rest", async () => {
    writeOverride({ bars: { terminal: { hard: { terminal: 25 } } } });
    await saveTreatLike("openrouter/acme/coder-1#default", "gpt-6-sol#medium");
    const c = loadCatalog();
    expect(c.bars.terminal.hard).toEqual({ terminal: 25 });
    expect(c.treatLike["openrouter/acme/coder-1#default"]).toBe("gpt-6-sol#medium");
  });

  test("saveTreatLike keeps the 1.0 schema, scores and treat-likes the TUI does not know", async () => {
    const score = {
      rung: "gpt-6-astra#xhigh",
      dim: "repo_code",
      value: 71,
      benchmark: "SWE-bench Pro",
      version: "1",
      url: "https://example.com/swe-bench-pro",
      date: "2026-09-01",
      confidence: "inferred",
    };
    writeOverride({
      schema: 1,
      treatLike: { "opencode-go/kimi-k3#default": "gpt-6-astra#xhigh" },
      scores: [score],
    });
    await saveTreatLike("openrouter/acme/coder-1#default", "gpt-6-sol#medium");
    const saved = JSON.parse(readFileSync(overridePath(), "utf8"));
    expect(saved).toEqual({
      schema: 1,
      treatLike: {
        "opencode-go/kimi-k3#default": "gpt-6-astra#xhigh",
        "openrouter/acme/coder-1#default": "gpt-6-sol#medium",
      },
      scores: [score],
    });
    expect(readOverride().scores).toEqual([score as Score]);
    expect(existsSync(`${overridePath()}.lock`)).toBe(false);
  });

  test("saveTreatLike refuses a target with no scores of its own", async () => {
    await expect(saveTreatLike("openrouter/acme/coder-1#default", "gpt-6-luna#max")).rejects.toThrow(
      /treated like "gpt-6-luna#max", which has no scores/,
    );
  });
});
