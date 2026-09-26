import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BackendAdapter } from "../../src/adapters/backend.ts";
import { readDiscovery, writeDiscovery } from "../../src/adapters/discovery.ts";
import { adapterFor, registerAdapter } from "../../src/adapters/registry.ts";
import { isCatherdError } from "../../src/domain/errors.ts";
import {
  catalogQuery,
  freshenDiscovery,
  loadCatalog,
  measuredSecs,
  overridePath,
  refreshDiscovery,
  resetFreshen,
  saveTreatLike,
} from "../../src/services/catalog-service.ts";
import { appendAgentRun, appendRecord, appendRoute } from "../../src/services/run-store.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { freshRun, makeRecord } from "./helpers.ts";

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
const q = (o: Partial<Parameters<typeof catalogQuery>[0]> = {}) =>
  catalogQuery({ scoredOnly: false, limit: 500, ...o });

describe("loadCatalog", () => {
  it("merges the shipped layers, each backend's listing and the user's override", async () => {
    withHome();
    writeDiscovery(
      "opencode",
      [{ id: "opencode-go/kimi-k3", efforts: [], context: 262144, imageIn: false }],
      T0,
    );
    await saveTreatLike("opencode:opencode-go/kimi-k3#default", "codex:gpt-6-sol#medium");
    const c = loadCatalog();
    expect(c.listed.opencode?.models.map((m) => m.id)).toEqual(["opencode-go/kimi-k3"]);
    expect(c.treatLike["opencode-go/kimi-k3#default"]).toEqual({ like: "gpt-6-sol#medium", source: "user" });
    expect(JSON.parse(readFileSync(overridePath(), "utf8"))).toMatchObject({
      schema: 1,
      treatLike: { "opencode-go/kimi-k3#default": "gpt-6-sol#medium" },
    });
  });

  it("keeps a 0.x override's other fields when saving a treat-like", async () => {
    withHome();
    await saveTreatLike("a/b#high", "gpt-6-sol#high");
    const cur = JSON.parse(readFileSync(overridePath(), "utf8"));
    writeFileSync(overridePath(), JSON.stringify({ ...cur, entries: { "x#high": { costRank: 9 } } }));
    await saveTreatLike("c/d#high", "gpt-6-sol#xhigh");
    expect(JSON.parse(readFileSync(overridePath(), "utf8")).entries).toEqual({ "x#high": { costRank: 9 } });
  });

  it("refuses a treat-like onto an unscored rung or onto itself", async () => {
    withHome();
    const code = (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        (e) => (isCatherdError(e) ? e.code : String(e)),
      );
    expect(await code(saveTreatLike("a/b#high", "opencode-go/kimi-k3#default"))).toBe("E_CONFIG_INVALID");
    expect(await code(saveTreatLike("gpt-6-sol#high", "gpt-6-sol#high"))).toBe("E_CONFIG_INVALID");
    expect(await code(saveTreatLike("claude-opus-5-5#high", "claude-opus-5-5#xhigh"))).toBe("ok");
  });

  it("refuses a malformed rung and leaves the override file byte-for-byte unchanged", async () => {
    withHome();
    await saveTreatLike("a/b#high", "gpt-6-sol#high");
    const before = readFileSync(overridePath(), "utf8");
    for (const [rung, like] of [
      ["foo", "gpt-6-sol#high"],
      ["a b#high", "gpt-6-sol#high"],
      ["x#y#z", "gpt-6-sol#high"],
    ] as const) {
      const e = await saveTreatLike(rung, like).then(
        () => null,
        (x) => x,
      );
      expect(isCatherdError(e) && e.code).toBe("E_INPUT_INVALID");
      expect(readFileSync(overridePath(), "utf8")).toBe(before);
    }
    expect(() => loadCatalog()).not.toThrow();
  });

  it("refuses a treat-like for a rung that has scores of its own", async () => {
    withHome();
    const e = await saveTreatLike("gpt-6-sol#high", "gpt-6-sol#xhigh").then(
      () => null,
      (x) => x,
    );
    expect(isCatherdError(e) && e.code).toBe("E_CONFIG_INVALID");
    expect(isCatherdError(e) && e.message).toBe(
      "gpt-6-sol#high has scores of its own; a treat-like would not change it",
    );
  });

  it("turns a corrupt override into E_CONFIG_INVALID with a fix", () => {
    withHome();
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(overridePath(), "{nope");
    try {
      loadCatalog();
      throw new Error("expected a throw");
    } catch (e) {
      expect(isCatherdError(e) && e.code).toBe("E_CONFIG_INVALID");
    }
  });
});

describe("measuredSecs", () => {
  it("takes the median of at least five successful runs per canonical rung and kind", async () => {
    const { run } = freshRun();
    appendRoute(run, {
      at: "2026-09-25T10:00:00.000Z",
      lane: "M1.L1",
      role: "worker",
      rung: "codex:gpt-6-sol#high",
      ladder: ["codex:gpt-6-sol#high"],
      source: "route",
      decidedBy: "lane",
      from: null,
      reason: null,
      kind: "terminal",
      difficulty: "logic",
    });
    const secs = [100, 300, 200, 500, 400];
    for (const [i, s] of secs.entries())
      await appendRecord(run, makeRecord({ dispatchId: `D${i}`, rung: "codex:gpt-6-sol#high", secs: s }));
    for (const [i, s] of [10, 20, 30, 40].entries())
      await appendRecord(run, makeRecord({ dispatchId: `E${i}`, rung: "codex:gpt-6-luna#high", secs: s }));
    await appendRecord(
      run,
      makeRecord({ dispatchId: "F", rung: "codex:gpt-6-sol#high", secs: 9999, status: "failed" }),
    );
    const m = measuredSecs(loadCatalog({ timings: false }));
    expect(m).toEqual({ "gpt-6-sol#high|*": 300, "gpt-6-sol#high|terminal": 300 });
    expect(loadCatalog().secs).toEqual(m);
  });

  it("counts each run under the kind its lane was routed as when it started, not the newest route", async () => {
    const { run } = freshRun();
    const route = (at: string, kind: "terminal" | "prose") =>
      appendRoute(run, {
        at,
        lane: "M1.L1",
        role: "worker",
        rung: "codex:gpt-6-sol#high",
        ladder: ["codex:gpt-6-sol#high"],
        source: "route",
        decidedBy: "lane",
        from: null,
        reason: null,
        kind,
        difficulty: "logic",
      });
    route("2026-09-25T10:00:00.000Z", "terminal");
    for (const [i, s] of [100, 300, 200, 500, 400].entries())
      await appendRecord(
        run,
        makeRecord({
          dispatchId: `D${i}`,
          rung: "codex:gpt-6-sol#high",
          secs: s,
          startedAt: `2026-09-25T10:0${i + 1}:00.000Z`,
        }),
      );
    route("2026-09-25T11:00:00.000Z", "prose");
    const m = measuredSecs(loadCatalog({ timings: false }));
    expect(m).toEqual({ "gpt-6-sol#high|*": 300, "gpt-6-sol#high|terminal": 300 });
  });
  it("times native claude: subagent runs from agents.jsonl under all kinds", async () => {
    const { run } = freshRun();
    const agent = (secs: number | null, status: "ok" | "failed" = "ok") =>
      appendAgentRun(run, {
        at: "2026-09-25T10:00:00.000Z",
        name: "architect",
        role: "architect",
        rung: "claude:claude-opus-5-5#high",
        agent: null,
        totalTokens: 100,
        costUsd: null,
        secs,
        status,
      });
    for (const s of [50, 10, 30, 20, 40]) agent(s);
    agent(null);
    agent(9999, "failed");
    const m = measuredSecs(loadCatalog({ timings: false }));
    expect(m).toEqual({ "claude-opus-5-5#high|*": 30 });
  });

  it("counts an agent row that names its lane under that lane's kind too", async () => {
    const { run } = freshRun();
    appendRoute(run, {
      at: "2026-09-25T10:00:00.000Z",
      lane: "M1.L1",
      role: "worker",
      rung: "claude:claude-opus-5-5#high",
      ladder: ["claude:claude-opus-5-5#high"],
      source: "route",
      decidedBy: "lane",
      from: null,
      reason: null,
      kind: "prose",
      difficulty: "logic",
    });
    for (const [i, s] of [50, 10, 30, 20, 40].entries())
      appendAgentRun(run, {
        at: `2026-09-25T10:1${i}:00.000Z`,
        name: "w",
        role: "worker",
        rung: "claude:claude-opus-5-5#high",
        agent: null,
        totalTokens: 100,
        costUsd: null,
        secs: s,
        status: "ok",
        lane: "M1.L1",
      });
    const m = measuredSecs(loadCatalog({ timings: false }));
    expect(m).toEqual({ "claude-opus-5-5#high|*": 30, "claude-opus-5-5#high|prose": 30 });
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
  it("lists each family on each backend with its rungs, scores, cost and roles", () => {
    withHome();
    const sol = q({ backend: "codex", text: "gpt-6-sol" }).models[0];
    expect(sol).toMatchObject({
      id: "gpt-6-sol",
      backend: "codex",
      model: "gpt-6-sol",
      billing: "codex",
      listed: null,
    });
    const high = sol?.rungs.find((r) => r.rung === "codex:gpt-6-sol#high");
    expect(high).toMatchObject({
      enabled: true,
      scores: { repo_code: { value: 65.3, benchmark: "DeepSWE 1.1", confidence: "secondary" } },
      cost: { tier: 0, mode: "chatgpt-plan" },
    });
    expect(sol?.rungs.find((r) => r.rung === "codex:gpt-6-sol#ultra")?.enabled).toBe(false);
    expect(sol?.roles).toContain("artist");
    expect(q({ backend: "claude", text: "opus" }).models[0]?.rungs[2]).toMatchObject({
      rung: "claude:claude-opus-5-5#high",
      treatLike: { like: "claude-opus-5-5#xhigh", source: "shipped" },
      scores: { terminal: { value: 66.4, confidence: "inferred" } },
    });
    expect(q({ backend: "opencode-go" }).models.map((m) => m.model)).toEqual([
      "opencode-go/gpt-5.6-luna",
      "opencode-go/gpt-6-luna",
    ]);
  });

  it("lists a discovered model catherd cannot score, disabled until the user maps it", async () => {
    withHome();
    writeDiscovery(
      "opencode",
      [{ id: "opencode-go/kimi-k3", efforts: [], context: 262144, imageIn: false }],
      T0,
    );
    const kimi = q({ text: "kimi" }).models[0];
    expect(kimi).toMatchObject({
      id: "opencode-go/kimi-k3",
      name: null,
      billing: "opencode-go",
      listed: true,
    });
    expect(kimi?.rungs).toEqual([
      expect.objectContaining({ rung: "opencode:opencode-go/kimi-k3#default", enabled: false }),
    ]);
    expect(q({ scoredOnly: true, text: "kimi" }).total).toBe(0);
    await saveTreatLike("opencode:opencode-go/kimi-k3#default", "gpt-6-sol#medium");
    expect(q({ scoredOnly: true, text: "kimi" }).models[0]?.rungs[0]).toMatchObject({
      enabled: true,
      scores: { repo_code: { value: 56.6, confidence: "inferred" } },
    });
  });

  it("lists opencode as it is listed in the given repository, and globally without one", () => {
    withHome();
    writeDiscovery(
      "opencode",
      [{ id: "opencode-go/kimi-k3", efforts: [], context: 262144, imageIn: false }],
      T0,
      "/work/a",
    );
    expect(q({ text: "kimi", repo: "/work/a" }).total).toBe(1);
    expect(q({ text: "kimi", repo: "/work/b" }).total).toBe(0);
    expect(q({ text: "kimi" }).total).toBe(0);
  });

  it("filters by role and limits the list", () => {
    withHome();
    expect(q({ role: "artist" }).models.every((m) => m.backend === "codex")).toBe(true);
    expect(q({ limit: 2 }).models).toHaveLength(2);
  });
});
