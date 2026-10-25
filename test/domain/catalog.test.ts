import { describe, expect, it } from "bun:test";
import { IndexFileSchema } from "../../src/domain/slopalytics.ts";
import { capableFor, pairOf, rungInfo, successorOf } from "../../src/domain/catalog.ts";
import { fixtureIndex, indexOf, shipped, shippedModels } from "./shipped.ts";

describe("catalog/models.json", () => {
  it("seeds the families with their per-backend model ids, and nothing a backend or Slopalytics knows", () => {
    const ids = shippedModels().families.map((f) => f.id);
    expect(ids).toEqual([
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-sonnet-5",
      "claude-haiku-5-5",
      "claude-4-5-haiku",
      "grok-4-7",
      "grok-4-6",
      "grok-4-5",
      "gemini-3-8-flash",
      "gemini-3-7-flash",
      "gemini-3-6-flash",
      "gemini-3-1-pro-preview",
    ]);
    const sol = shippedModels().families.find((f) => f.id === "gpt-6-sol");
    expect(sol?.on.codex).toEqual({ id: "gpt-6-sol" });
    expect(sol?.on.opencode?.id).toBe("opencode/gpt-6-sol");
    expect(sol?.planWeight).toBe(20);
    for (const f of shippedModels().families) {
      expect(f).not.toHaveProperty("price");
      expect(f).not.toHaveProperty("releaseDate");
      expect(f).not.toHaveProperty("predecessor");
      expect(f).not.toHaveProperty("speed");
      for (const m of Object.values(f.on)) expect(Object.keys(m)).toEqual(["id"]);
    }
  });

  it("marks Codex image generation as needing a ChatGPT login", () => {
    expect(shippedModels().backends.codex?.imageGen?.requires).toBe("chatgpt-login");
  });

  it("names a family the recorded index files under the same Slopalytics key, except the unindexed few", () => {
    const keys = new Set(fixtureIndex().models.map((m) => m.family));
    const c = shipped();
    const missing = c.families.filter(
      (f) => !Object.keys(c.index).includes(rungInfo(c, `codex:${f.id}#default`).slop),
    );
    // every family in the fixture's keep list is indexed
    expect(missing.map((f) => f.id)).toEqual([]);
    expect(keys.has("claude-4-5-haiku")).toBe(true);
  });
});

describe("rungInfo", () => {
  it("maps a backend's model id to its family and canonical rung", () => {
    const c = shipped();
    expect(rungInfo(c, "opencode:opencode/gpt-6-sol#high")).toMatchObject({
      key: "opencode",
      canonical: "gpt-6-sol#high",
      listed: null,
    });
    expect(rungInfo(c, "opencode:opencode-go/gpt-6-luna#high").key).toBe("opencode-go");
    expect(rungInfo(c, "claude:claude-opus-5-5#high")).toMatchObject({
      key: "claude",
      canonical: "claude-opus-5-5#high",
    });
    expect(rungInfo(c, "claude:claude-opus-5-5#high").efforts.sort()).toEqual([
      "high",
      "low",
      "max",
      "medium",
      "xhigh",
    ]);
    expect(rungInfo(c, "claude-code:claude-haiku-4-5-20251001#default").canonical).toBe(
      "claude-4-5-haiku#default",
    );
  });

  it("indexes a pair by its Slopalytics family and effort, a dotted id included", () => {
    const c = shipped({ index: indexOf({ "gpt-6-1-sol#high": 50 }) });
    expect(rungInfo(c, "codex:gpt-6.1-sol#high")).toMatchObject({
      slop: "gpt-6-1-sol",
      pair: { intelligence: 50 },
    });
  });

  it("matches a listed model with no family by its own name, its provider dropped; Composer has none", () => {
    const c = shipped({ index: indexOf({ "kimi-k3#max": 43 }) });
    expect(pairOf(c, "opencode:opencode-go/kimi-k3#max")?.intelligence).toBe(43);
    expect(pairOf(c, "cursor:composer-2.5#default")).toBeNull();
    expect(pairOf(c, "cursor:cursor-grok-4.6#high")).toBeNull(); // grok-4-6 is not in this index
    expect(rungInfo(c, "opencode:opencode-go/kimi-k3#max").family).toBeNull();
  });

  it("maps #default to the family's default record, else its only one", () => {
    const c = shipped({
      index: indexOf({
        "claude-4-5-haiku#default": 17,
        "claude-4-5-haiku#none": 15,
        "gemini-3-6-flash#high": 34,
        "gpt-6-sol#low": 34,
        "gpt-6-sol#high": 42,
      }),
    });
    expect(pairOf(c, "claude-code:claude-haiku-4-5-20251001#default")?.intelligence).toBe(17);
    expect(pairOf(c, "cursor:gemini-3.6-flash#default")?.intelligence).toBe(34);
    expect(pairOf(c, "codex:gpt-6-sol#default")).toBeNull();
    expect(pairOf(c, "codex:gpt-6-sol#ultra")).toBeNull();
    expect(pairOf(c, "not a rung")).toBeNull();
  });

  it("takes efforts from the backend's listing, else from the index; an effort the index lacks has no pair", () => {
    const listed = {
      codex: {
        fetchedAt: "2026-09-25T00:00:00.000Z",
        models: [{ id: "gpt-6-sol", efforts: ["low", "medium"], context: 272000, imageIn: true }],
      },
    };
    const index = indexOf({ "gpt-6-sol#low": 30, "gpt-6-sol#high": 42 });
    const c = shipped({ listed, index });
    expect(rungInfo(c, "codex:gpt-6-sol#high").efforts).toEqual(["low", "medium"]);
    expect(rungInfo(c, "codex:gpt-6-luna#high").listed).toBe(false);
    expect(rungInfo(c, "codex:gpt-6-sol#high").listed).toBe(true);
    expect(rungInfo(c, "codex:gpt-6-sol#medium").pair).toBeNull();
    expect(rungInfo(c, "codex:gpt-6-sol#medium").context).toBe(272000);
    expect(rungInfo(shipped({ index }), "codex:gpt-6-sol#low").efforts).toEqual(["low", "high"]);
  });

  it("takes the context from the listing, else the pair", () => {
    const index = indexOf({ "gpt-6-sol#high": { intelligence: 42, context: 1_050_000 } });
    expect(rungInfo(shipped({ index }), "codex:gpt-6-sol#high").context).toBe(1_050_000);
  });
});

describe("buildCatalog", () => {
  it("prices a pair only when both prices are there", () => {
    const c = shipped({
      index: indexOf({
        "gpt-6-sol#low": { intelligence: 30, inputPrice: 2, outputPrice: 10 },
        "gpt-6-sol#high": { intelligence: 42, inputPrice: 2 },
      }),
    });
    expect(pairOf(c, "codex:gpt-6-sol#low")?.price).toEqual({ input: 2, output: 10 });
    expect(pairOf(c, "codex:gpt-6-sol#high")?.price).toBeNull();
  });

  it("pools the shipped families' pairs, ascending, and no listed-only model's", () => {
    const c = shipped({
      index: indexOf({
        "gpt-6-sol#high": 42,
        "gpt-6-luna#high": 33,
        "kimi-k3#max": 44,
        "unknown-model#high": 99,
      }),
      listed: {
        opencode: {
          fetchedAt: "2026-09-25T00:00:00.000Z",
          models: [{ id: "opencode-go/kimi-k3", efforts: ["max"], context: 1, imageIn: false }],
        },
      },
    });
    expect(c.pool).toEqual([33, 42]);
    expect(c.indexedAt).toBe("2026-10-13T20:47:14.735Z");
  });

  it("has no pair and an empty pool with no index", () => {
    const c = shipped({ index: null });
    expect(c.pool).toEqual([]);
    expect(c.indexedAt).toBeNull();
    expect(pairOf(c, "codex:gpt-6-sol#high")).toBeNull();
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

  it("a pair carries the index's measured cost and lab", () => {
    const c = shipped({
      index: indexOf({
        "gpt-6-sol#high": { intelligence: 42, cost: 0.37, lab: "openai" },
        "gpt-6-sol#low": 30,
      }),
    });
    expect(pairOf(c, "codex:gpt-6-sol#high")).toMatchObject({ costUsd: 0.37, lab: "openai" });
    expect(pairOf(c, "codex:gpt-6-sol#low")?.costUsd).toBeNull();
  });

  it("an index file without cost parses", () => {
    const old = indexOf({ "gpt-6-sol#high": 42 });
    expect(() => IndexFileSchema.parse(old)).not.toThrow();
  });
});

describe("successorOf", () => {
  const id = (c: ReturnType<typeof shipped>, rung: string) => successorOf(c, rung)?.id ?? null;
  const listing = (...ids: string[]) => ({
    fetchedAt: "2026-10-25T00:00:00.000Z",
    models: ids.map((x) => ({ id: x, efforts: ["high"], context: 1, imageIn: false })),
  });

  it("names the newer family offered on the same backend, following the chain", () => {
    const c = shipped();
    expect(id(c, "codex:gpt-6-sol#high")).toBe("gpt-6.1-sol");
    // GPT-5.6 Sol → GPT-6 Sol is on codex, the nearest offered successor wins
    expect(id(c, "codex:gpt-5.6-sol#high")).toBe("gpt-6-sol");
    expect(id(c, "opencode:opencode-go/gpt-5.6-luna#high")).toBe("gpt-6-luna");
    expect(id(c, "claude:claude-sonnet-5#high")).toBe("claude-sonnet-5-5");
    expect(id(c, "claude-code:claude-haiku-4-5-20251001#default")).toBe("claude-haiku-5-5");
    expect(id(c, "cursor:cursor-grok-4.5#default")).toBe("grok-4-7");
  });

  it("keeps a model current on a backend its successor is not on", () => {
    const c = shipped();
    // GPT-6.1 Sol runs only on codex
    expect(id(c, "opencode:opencode/gpt-6-sol#high")).toBeNull();
    expect(id(c, "cursor:gpt-6-sol#high")).toBeNull();
    // GPT-5.6 Sol on opencode skips nothing: GPT-6 Sol is there
    expect(id(c, "opencode:opencode/gpt-5.6-sol#high")).toBe("gpt-6-sol");
    // Claude Haiku 5.5 runs only on claude-code
    expect(id(c, "opencode:opencode/claude-haiku-4-5#default")).toBeNull();
  });

  it("follows the chain past a successor the backend does not offer", () => {
    const c = shipped();
    const sol6 = c.families.find((f) => f.id === "gpt-6-sol");
    if (!sol6) throw new Error("fixture");
    const families = c.families.map((f) => (f === sol6 ? { ...f, on: { opencode: f.on.opencode } } : f));
    expect(id({ ...c, families }, "codex:gpt-5.6-sol#high")).toBe("gpt-6.1-sol");
  });

  it("keeps a model current when its successor's backend listing lacks the successor", () => {
    const c = shipped({ listed: { codex: listing("gpt-6-sol", "gpt-6-luna") } });
    expect(id(c, "codex:gpt-6-sol#high")).toBeNull();
    expect(id(c, "codex:gpt-5.6-luna#high")).toBe("gpt-6-luna");
  });

  it("is null for a current model, a model with no family, and a rung that does not parse", () => {
    const c = shipped();
    expect(id(c, "codex:gpt-6.1-sol#high")).toBeNull();
    expect(id(c, "codex:gpt-5.6-terra#high")).toBeNull();
    expect(id(c, "opencode:opencode-go/kimi-k3#max")).toBeNull();
    expect(id(c, "nope")).toBeNull();
  });
});
