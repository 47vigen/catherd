import { afterEach, describe, expect, it } from "bun:test";
import { writeDiscovery } from "../../src/adapters/discovery.ts";
import { pairOf } from "../../src/domain/catalog.ts";
import { taskUsd } from "../../src/domain/cost.ts";
import { rmSync } from "node:fs";
import { indexPath } from "../../src/infra/paths.ts";
import { loadCatalog } from "../../src/services/catalog-service.ts";
import { catalogView, EFFORT_ORDER } from "../../src/services/panel-catalog.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

const entry = (id: string) => catalogView().models.find((m) => m.id === id);

describe("catalogView", () => {
  it("one entry per model, every backend that offers it", () => {
    withHome();
    const all = catalogView().models.filter((m) => m.id === "claude-opus-5-5");
    expect(all).toHaveLength(1);
    expect(all[0]?.backends).toEqual(expect.arrayContaining(["claude", "claude-code"]));
  });

  it("points follow effort order and carry measured cost", () => {
    withHome();
    const points = entry("gpt-6-sol")?.points ?? [];
    const ranks = points.map((p) => EFFORT_ORDER.indexOf(p.effort as (typeof EFFORT_ORDER)[number]));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    const high = points.find((p) => p.effort === "high");
    expect([high?.usd, high?.measured]).toEqual([0.3728406839161857, true]);
  });

  it("a pair with no measured cost is estimated from its list price", () => {
    withHome();
    const p = entry("claude-sonnet-5")?.points.find((x) => x.effort === "none");
    const price = pairOf(loadCatalog(), "opencode:opencode/claude-sonnet-5#none")?.price;
    expect(price).toBeTruthy();
    expect([p?.usd, p?.measured]).toEqual([taskUsd(price!, "none"), false]);
  });

  it("a model no backend offers is left out", () => {
    withHome();
    expect(entry("claude-haiku-5-5")).toBeDefined();
    writeDiscovery("claude-code", [
      { id: "another-model", efforts: ["high"], context: null, imageIn: false },
    ]);
    expect(entry("claude-haiku-5-5")).toBeUndefined();
    expect(entry("gpt-6-sol")).toBeDefined();
  });

  it("keeps a model a newer version replaces, marked superseded only when it is replaced everywhere it is offered", () => {
    withHome();
    expect(entry("gpt-5.6-luna")?.superseded).toBe(true);
    expect(entry("gpt-6-luna")?.superseded).toBe(false);
    // GPT-6.1 Sol replaces GPT-6 Sol on codex only
    expect(entry("gpt-6-sol")?.superseded).toBe(false);
  });

  it("indexedAt is null when nothing was fetched", () => {
    withHome();
    rmSync(indexPath());
    expect(catalogView().indexedAt).toBeNull();
  });
});
