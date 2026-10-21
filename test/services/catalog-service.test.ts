import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BackendAdapter } from "../../src/adapters/backend.ts";
import { readDiscovery, writeDiscovery } from "../../src/adapters/discovery.ts";
import { adapterFor, registerAdapter } from "../../src/adapters/registry.ts";
import { logFile } from "../../src/infra/log.ts";
import { indexPath } from "../../src/infra/paths.ts";
import { readIndexFile } from "../../src/infra/slopalytics.ts";
import {
  catalogQuery,
  freshenDiscovery,
  loadCatalog,
  refreshDiscovery,
  resetFreshen,
  startIndex,
  writeRunIndex,
} from "../../src/services/catalog-service.ts";
import { appendRoute } from "../../src/services/run-store.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { freshRun } from "./helpers.ts";

afterEach(snapshotEnv());

const codex = adapterFor("codex") as BackendAdapter;
let listCalls = 0;
function fakeCodexListing(models: { id: string; efforts: string[] }[]): void {
  listCalls = 0;
  registerAdapter({
    ...codex,
    listModels: async () => {
      listCalls++;
      return models.map((m) => ({ ...m, context: 272000, imageIn: true }));
    },
  });
}
beforeEach(() => resetFreshen());
afterEach(() => registerAdapter(codex));

const T0 = Date.parse("2026-09-25T10:00:00.000Z");
const q = (o: Partial<Parameters<typeof catalogQuery>[0]> = {}) => catalogQuery({ limit: 500, ...o });

describe("loadCatalog", () => {
  it("reads the machine's index and each backend's listing", () => {
    withHome();
    writeDiscovery(
      "opencode",
      [{ id: "opencode-go/kimi-k3", efforts: [], context: 262144, imageIn: false }],
      T0,
    );
    const c = loadCatalog();
    expect(c.listed.opencode?.models.map((m) => m.id)).toEqual(["opencode-go/kimi-k3"]);
    expect(c.indexedAt).toBe("2026-10-13T20:47:14.735Z");
    expect(c.index["gpt-6-sol"]?.high?.intelligence).toBeGreaterThan(40);
  });

  it("reads no index as an empty catalog, never an error", () => {
    withHome();
    rmSync(indexPath());
    const c = loadCatalog();
    expect(c.indexedAt).toBeNull();
    expect(c.pool).toEqual([]);
    expect(c.families.length).toBeGreaterThan(0);
  });
});

describe("a run's pinned index", () => {
  const runDir = () => mkdtempSync(join(process.env.CATHERD_HOME as string, "run-"));

  it("loads the run's index over the machine's, and the machine's when the run has none", () => {
    withHome();
    const dir = runDir();
    const machine = readIndexFile(indexPath());
    if (!machine) throw new Error("no seeded index");
    const pinned = { ...machine, fetchedAt: "2026-10-01T00:00:00.000Z" };
    expect(loadCatalog({ runDir: dir }).indexedAt).toBe(machine.fetchedAt);
    writeRunIndex(dir, pinned);
    expect(readIndexFile(join(dir, "slopalytics.json"))).toEqual(pinned);
    expect(loadCatalog({ runDir: dir }).indexedAt).toBe("2026-10-01T00:00:00.000Z");
    expect(loadCatalog().indexedAt).toBe(machine.fetchedAt);
  });

  it("writes nothing for no index", () => {
    withHome();
    const dir = runDir();
    writeRunIndex(dir, null);
    expect(readIndexFile(join(dir, "slopalytics.json"))).toBeNull();
  });

  it("starts on one read of the machine's index: the catalog and the index it was built on", async () => {
    withHome();
    const { catalog, index } = await startIndex("/nowhere");
    expect(index?.fetchedAt).toBe(catalog.indexedAt as string);
    rmSync(indexPath());
    expect((await startIndex("/nowhere")).index).toBeNull();
  });
});

describe("discovery refresh", () => {
  it("refreshes every adapter now, keeping the last listing when one lists nothing", async () => {
    withHome();
    fakeCodexListing([{ id: "gpt-6-sol", efforts: ["low"] }]);
    const r = await refreshDiscovery({ backends: ["codex"], now: T0 });
    expect(r).toEqual([{ backend: "codex", models: 1, fetchedAt: "2026-09-25T10:00:00.000Z" }]);
    fakeCodexListing([]);
    const again = await refreshDiscovery({ backends: ["codex"], now: T0 + 1000 });
    expect(again[0]).toMatchObject({ models: 0, fetchedAt: "2026-09-25T10:00:00.000Z" });
    expect(readDiscovery("codex")?.models).toHaveLength(1);
  });

  it("says a backend that is not installed is missing, not that its listing was kept", async () => {
    withHome();
    registerAdapter({
      ...codex,
      listModels: async () => [],
      probe: async () => ({
        installed: false,
        version: null,
        versionOk: false,
        loggedIn: null,
        problems: [
          { code: "E_BACKEND_MISSING", message: "codex is not on PATH", fix: "npm i -g @openai/codex" },
        ],
      }),
    });
    expect(await refreshDiscovery({ backends: ["codex"], now: T0 })).toEqual([
      {
        backend: "codex",
        models: 0,
        fetchedAt: null,
        error: "codex is not on PATH",
        fix: "npm i -g @openai/codex",
      },
    ]);
  });

  it("says the previous listing is kept only when there is one", async () => {
    withHome();
    registerAdapter({
      ...codex,
      listModels: async () => [],
      probe: async () => ({
        installed: true,
        version: "0.157.0",
        versionOk: true,
        loggedIn: true,
        problems: [],
      }),
    });
    expect((await refreshDiscovery({ backends: ["codex"], now: T0 }))[0]?.error).toBe("listed no models");
    writeDiscovery("codex", [{ id: "gpt-6-sol", efforts: [], context: null, imageIn: false }], T0);
    expect((await refreshDiscovery({ backends: ["codex"], now: T0 }))[0]?.error).toBe(
      "listed no models; the previous listing is kept",
    );
  });

  it("lists again on route at most daily, and not again within the hour after a failure", async () => {
    withHome();
    // the claude rung reaches claudeCodeAdapter.listModels(), which calls the Models API with a key
    delete process.env.ANTHROPIC_API_KEY;
    fakeCodexListing([{ id: "gpt-6-sol", efforts: ["low", "medium"] }]);
    await freshenDiscovery(["codex:gpt-6-sol#medium", "claude:claude-opus-5-5#high"], T0);
    expect(listCalls).toBe(1);
    await freshenDiscovery(["codex:gpt-6-sol#medium"], T0 + 2 * 3_600_000);
    expect(listCalls).toBe(1);
    await freshenDiscovery(["codex:gpt-6-sol#medium"], T0 + 25 * 3_600_000);
    expect(listCalls).toBe(2);
    fakeCodexListing([]);
    resetFreshen();
    const late = T0 + 50 * 3_600_000;
    await freshenDiscovery(["codex:gpt-6-sol#medium"], late);
    await freshenDiscovery(["codex:gpt-6-sol#medium"], late + 60_000);
    expect(listCalls).toBe(1);
  });

  it("logs a failed listing at debug and keeps routing", async () => {
    withHome();
    process.env.CATHERD_LOG = "debug";
    registerAdapter({
      ...codex,
      listModels: async () => {
        throw new Error("codex listing broke");
      },
    });
    await freshenDiscovery(["codex:gpt-6-sol#medium"], T0);
    const rows = readFileSync(logFile(), "utf8")
      .split("\n")
      .filter((l) => l.includes('"discovery"'))
      .map((l) => JSON.parse(l));
    expect(rows).toEqual([
      expect.objectContaining({ level: "debug", backend: "codex", error: "codex listing broke" }),
    ]);
  });

  it("lists the due backends in parallel", async () => {
    withHome();
    const opencode = adapterFor("opencode") as BackendAdapter;
    const started: string[] = [];
    const release: (() => void)[] = [];
    const lister = (id: string, model: string) => () =>
      new Promise<{ id: string; efforts: string[]; context: number; imageIn: boolean }[]>((resolve) => {
        started.push(id);
        release.push(() => resolve([{ id: model, efforts: [], context: 1000, imageIn: false }]));
      });
    registerAdapter({ ...codex, listModels: lister("codex", "gpt-6-sol") });
    registerAdapter({ ...opencode, listModels: lister("opencode", "opencode-go/kimi-k3") });
    try {
      const done = freshenDiscovery(["codex:gpt-6-sol#medium", "opencode:opencode-go/kimi-k3#default"], T0);
      // both listings start before either answers
      await Promise.resolve();
      expect(started.sort()).toEqual(["codex", "opencode"]);
      for (const r of release) r();
      await done;
      expect(readDiscovery("codex")?.models.map((m) => m.id)).toEqual(["gpt-6-sol"]);
      expect(readDiscovery("opencode")?.models.map((m) => m.id)).toEqual(["opencode-go/kimi-k3"]);
    } finally {
      registerAdapter(opencode);
    }
  });
});

describe("discovery per repository", () => {
  const opencode = adapterFor("opencode") as BackendAdapter;
  afterEach(() => registerAdapter(opencode));
  const model = (id: string) => ({ id, efforts: ["high"], context: 1000, imageIn: false });

  it("lists opencode in the routed repository and keeps each repository's listing apart", async () => {
    withHome();
    const asked: (string | undefined)[] = [];
    registerAdapter({
      ...opencode,
      listModels: async (repo?: string) => {
        asked.push(repo);
        return [model(repo === "/work/a" ? "opencode/gpt-6-luna" : "opencode/gpt-6-sol")];
      },
    });
    fakeCodexListing([{ id: "gpt-6-sol", efforts: ["medium"] }]);
    await freshenDiscovery(["opencode:opencode/gpt-6-luna#high", "codex:gpt-6-sol#medium"], T0, "/work/a");
    expect(asked).toEqual(["/work/a"]);
    expect(readDiscovery("opencode", "/work/a")?.models.map((m) => m.id)).toEqual(["opencode/gpt-6-luna"]);
    expect(readDiscovery("opencode")).toBeNull();
    // codex lists the same models wherever it runs: the global listing
    expect(readDiscovery("codex")?.models.map((m) => m.id)).toEqual(["gpt-6-sol"]);
    expect(loadCatalog({ repo: "/work/a" }).listed.opencode?.models.map((m) => m.id)).toEqual([
      "opencode/gpt-6-luna",
    ]);
    expect(loadCatalog({ repo: "/work/b" }).listed.opencode).toBeUndefined();
    expect(loadCatalog({ repo: "/work/b" }).listed.codex?.models).toHaveLength(1);
    // another repository is due on its own, the same day
    await freshenDiscovery(["opencode:opencode/gpt-6-luna#high"], T0 + 60_000, "/work/b");
    expect(asked).toEqual(["/work/a", "/work/b"]);
    await freshenDiscovery(["opencode:opencode/gpt-6-luna#high"], T0 + 120_000, "/work/a");
    expect(asked).toEqual(["/work/a", "/work/b"]);
  });

  it("backs off an hour per repository after a failed listing", async () => {
    withHome();
    const asked: (string | undefined)[] = [];
    registerAdapter({
      ...opencode,
      listModels: async (repo?: string) => {
        asked.push(repo);
        throw new Error("wedged");
      },
    });
    await freshenDiscovery(["opencode:opencode/gpt-6-luna#high"], T0, "/work/a");
    await freshenDiscovery(["opencode:opencode/gpt-6-luna#high"], T0 + 60_000, "/work/a");
    await freshenDiscovery(["opencode:opencode/gpt-6-luna#high"], T0 + 60_000, "/work/b");
    expect(asked).toEqual(["/work/a", "/work/b"]);
  });
});

describe("catalogQuery", () => {
  it("lists only indexed pairs, each with its intelligence, price, speed and cost", () => {
    withHome();
    const sol = q({ backend: "codex", text: "gpt-6-sol" }).models.find((m) => m.model === "gpt-6-sol");
    expect(sol).toMatchObject({ id: "gpt-6-sol", backend: "codex", billing: "codex", listed: null });
    expect(sol?.rungs.map((r) => r.rung)).not.toContain("codex:gpt-6-sol#ultra");
    expect(sol?.rungs[0]).toMatchObject({ cost: { tier: 0 } });
    expect(typeof sol?.rungs[0]?.intelligence).toBe("number");
    const high = sol?.rungs.find((r) => r.rung === "codex:gpt-6-sol#high");
    expect(high).toMatchObject({
      price: { input: 2, output: 10 },
      context: 1_050_000,
      cost: { tier: 0, mode: "chatgpt-plan" },
      evidence: null,
    });
    expect(high?.intelligence).toBeCloseTo(42.4, 1);
    expect(typeof high?.speed).toBe("number");
    // the rungs rise with intelligence
    const xs = sol?.rungs.map((r) => r.intelligence) ?? [];
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(sol?.roles).toContain("artist");
    expect(q({ backend: "claude", text: "opus" }).models[0]?.rungs.map((r) => r.rung)).toContain(
      "claude:claude-opus-5-5#high",
    );
    expect(q({ backend: "opencode-go" }).models.map((m) => m.model)).toEqual([
      "opencode-go/gpt-5.6-luna",
      "opencode-go/gpt-6-luna",
    ]);
  });

  it("says a rung's run evidence (spec 1.2 §8)", () => {
    const { run } = freshRun();
    appendRoute(run, {
      at: "2026-09-28T10:00:00.000Z",
      lane: "M1.L1",
      role: "worker",
      rung: "codex:gpt-6-luna#high",
      ladder: ["codex:gpt-6-luna#high"],
      source: "route",
      decidedBy: "lane",
      from: null,
      reason: null,
      kind: "repo_code",
      difficulty: "build",
    });
    const luna = q({ backend: "codex", text: "gpt-6-luna" }).models[0];
    expect(luna?.rungs.find((r) => r.rung === "codex:gpt-6-luna#high")?.evidence).toBe("1 lane");
    expect(luna?.rungs.find((r) => r.rung === "codex:gpt-6-luna#max")?.evidence).toBeNull();
  });

  it("drops a model with no indexed pair", () => {
    withHome();
    writeDiscovery(
      "cursor",
      [
        { id: "composer-2.5", efforts: [], context: 200000, imageIn: false },
        { id: "grok-4.7", efforts: ["low", "high"], context: 200000, imageIn: false },
      ],
      T0,
    );
    const models = q({ backend: "cursor" }).models.map((m) => m.model);
    expect(models).not.toContain("composer-2.5");
    expect(models).toContain("grok-4.7");
    expect(q({ text: "composer" }).total).toBe(0);
  });

  it("lists a listed model catherd has no family for by its Slopalytics name, at its indexed efforts", () => {
    withHome();
    writeDiscovery(
      "opencode",
      [{ id: "opencode-go/kimi-k3", efforts: ["max", "low", "high"], context: 262144, imageIn: false }],
      T0,
    );
    const kimi = q({ text: "kimi" }).models[0];
    expect(kimi).toMatchObject({
      id: "opencode-go/kimi-k3",
      name: null,
      billing: "opencode-go",
      listed: true,
    });
    // the listing offers `high`, the index has no pair for it
    expect(kimi?.rungs.map((r) => r.rung)).toEqual([
      "opencode:opencode-go/kimi-k3#low",
      "opencode:opencode-go/kimi-k3#max",
    ]);
    expect(kimi?.efforts).toEqual(["low", "max"]);
  });

  it("lists opencode as it is listed in the given repository, and globally without one", () => {
    withHome();
    writeDiscovery(
      "opencode",
      [{ id: "opencode-go/kimi-k3", efforts: ["max"], context: 262144, imageIn: false }],
      T0,
      "/work/a",
    );
    expect(q({ text: "kimi", repo: "/work/a" }).total).toBe(1);
    expect(q({ text: "kimi", repo: "/work/b" }).total).toBe(0);
    expect(q({ text: "kimi" }).total).toBe(0);
  });

  it("filters by role, backend and text, and counts the total before the limit", () => {
    withHome();
    expect(q({ role: "artist" }).models.every((m) => m.backend === "codex")).toBe(true);
    const all = q();
    expect(q({ limit: 2 }).models).toHaveLength(2);
    expect(q({ limit: 2 }).total).toBe(all.total);
    expect(q({ text: "luna" }).models.every((m) => `${m.id} ${m.model}`.includes("luna"))).toBe(true);
    expect(q({ backend: "codex" }).models.every((m) => m.backend === "codex")).toBe(true);
  });

  it("reads no index as an empty list, never an error", () => {
    withHome();
    rmSync(indexPath());
    expect(q()).toEqual({ total: 0, models: [] });
  });
});
