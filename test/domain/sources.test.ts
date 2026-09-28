import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultEffortOf,
  effortWord,
  familyEfforts,
  idMapper,
  nearestEffort,
  normalizeId,
  SOURCE_IDS,
  SourcesFileSchema,
  splitSourceRung,
} from "../../src/domain/sources.ts";
import { shippedModels } from "./shipped.ts";

const sourcesFile = () =>
  SourcesFileSchema.parse(
    JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "catalog", "sources.json"), "utf8")),
  );

describe("catalog/sources.json (spec 1.2 §3.1, §3.4)", () => {
  it("lists every source once, with its license and attribution line; only Artificial Analysis needs a key", () => {
    const f = sourcesFile();
    expect(f.sources.map((s) => s.id)).toEqual([...SOURCE_IDS]);
    for (const s of f.sources) {
      expect(s.license.length).toBeGreaterThan(0);
      expect(s.attribution.length).toBeGreaterThan(0);
    }
    expect(f.sources.filter((s) => s.keyed).map((s) => s.id)).toEqual(["artificial-analysis"]);
  });

  it("names a default effort for every shipped family", () => {
    const f = sourcesFile();
    for (const fam of shippedModels().families) expect(f.defaultEffort[fam.id]).toBeDefined();
    const haiku = shippedModels().families.find((x) => x.id === "claude-haiku-4-5");
    expect(haiku && defaultEffortOf(f, haiku)).toBe("default");
    expect(haiku && defaultEffortOf({ ...f, defaultEffort: {} }, haiku)).toBe("high");
  });
});

describe("id and effort mapping (spec 1.2 §3.4)", () => {
  it("lowercases, drops a vendor prefix and writes dots and blanks as dashes", () => {
    expect(normalizeId("gpt-5.6-sol")).toBe("gpt-5-6-sol");
    expect(normalizeId("openai/gpt-6-sol")).toBe("gpt-6-sol");
    expect(normalizeId("GPT 5.6 Sol")).toBe("gpt-5-6-sol");
    expect(normalizeId("anthropic/claude-opus-5.5")).toBe("claude-opus-5-5");
    expect(normalizeId("Claude Opus 5.5")).toBe("claude-opus-5-5");
  });

  it("reads an effort word in any case, and nothing else", () => {
    expect(effortWord("xHigh")).toBe("xhigh");
    expect(effortWord("MAX")).toBe("max");
    expect(effortWord("unknown")).toBeNull();
    expect(effortWord("32K")).toBeNull();
  });

  it("splits a parser's rung into its id and effort", () => {
    expect(splitSourceRung("gpt-6-sol#max")).toEqual({ id: "gpt-6-sol", effort: "max" });
    expect(splitSourceRung("openai/gpt-6-sol")).toEqual({ id: "openai/gpt-6-sol", effort: null });
  });

  it("maps source ids onto families directly, by a backend's own id and through the alias table", () => {
    const m = idMapper(shippedModels().families, sourcesFile().aliases);
    const fam = (id: string) => m.family(id)?.id ?? null;
    expect(fam("GPT 5.6 Sol")).toBe("gpt-5.6-sol");
    expect(fam("openai/gpt-6-sol")).toBe("gpt-6-sol");
    expect(fam("anthropic/claude-opus-5.5")).toBe("claude-opus-5-5");
    expect(fam("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(fam("claude-4-5-haiku")).toBe("claude-haiku-4-5");
    expect(fam("opencode-go/gpt-6-luna")).toBe("gpt-6-luna");
    expect(m.key("claude-4-5-haiku")).toBe("claude-haiku-4-5");
  });

  it("never guesses: an id with no family, alias or backend id maps to none", () => {
    const m = idMapper(shippedModels().families, sourcesFile().aliases);
    for (const id of [
      "gemini-3.8-flash",
      "claude-opus-5",
      "gpt-6-sol-pro",
      "openai/gpt-6-sol:batch",
      "kimi-k3",
    ])
      expect(m.family(id)).toBeNull();
  });

  it("lists a family's efforts weakest first and finds the nearest, the weaker on a tie", () => {
    const sol = shippedModels().families.find((f) => f.id === "gpt-6-sol");
    expect(sol && familyEfforts(sol)).toEqual(["none", "low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(nearestEffort("high", ["max", "medium"])).toBe("medium");
    expect(nearestEffort("xhigh", ["max", "medium"])).toBe("max");
    expect(nearestEffort("low", ["max"])).toBe("max");
    expect(nearestEffort("high", [])).toBeNull();
    expect(nearestEffort("default", ["max"])).toBeNull();
  });
});
