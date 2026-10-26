import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendAdapter } from "../../src/adapters/backend.ts";
import { writeDiscovery } from "../../src/adapters/discovery.ts";
import { adapterFor, registerAdapter } from "../../src/adapters/registry.ts";
import { decisionState } from "../../src/domain/decision.ts";
import { writeIndexFile } from "../../src/infra/slopalytics.ts";
import { indexPath } from "../../src/infra/paths.ts";
import { resetFreshen, writeRunIndex } from "../../src/services/catalog-service.ts";
import { decisionQuestions } from "../../src/services/decision-service.ts";
import type { DecideRequest, ProfileView } from "../../src/services/ports.ts";
import { routingService } from "../../src/services/routing-service.ts";
import { indexOf } from "../domain/shipped.ts";
import { fakeFetch } from "../fake-fetch.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { LADDER, testView } from "./helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => {
  withHome();
  resetFreshen();
  delete process.env.CATHERD_DECISION_KEY;
  // claude-code lists models through Anthropic's API when this is set
  delete process.env.ANTHROPIC_API_KEY;
  // no backend CLI answers a listing here: discovery stays empty
  process.env.PATH = "/nonexistent";
});

const noWait = { sleep: async () => {}, random: () => 0.5 };

const view = (role: "worker" | "reviewer", rungs: string[]): ProfileView =>
  testView({ roles: { ...testView().roles, [role]: { enabled: true, access: "workspace-write", rungs } } });

// inside withHome()'s CATHERD_HOME, so a test leaves nothing behind in the system temp dir's root
const runDir = () => mkdtempSync(join(process.env.CATHERD_HOME as string, "run-"));

function req(over: Partial<DecideRequest> = {}): DecideRequest {
  return {
    runDir: runDir(),
    repo: "/nowhere",
    profile: view("worker", LADDER),
    role: "worker",
    name: "M1.L1",
    unit: "M1.L1",
    floor: null,
    strict: false,
    exclude: [],
    held: [],
    usage: {},
    state: decisionState({
      role: "worker",
      unit: "M1.L1",
      round: 0,
      isFix: false,
      floorRung: null,
      rungs: [],
      previous: [],
      spentFraction: 0,
      slack: null,
      brief: "Add GET /jobs like src/users.ts.",
    }),
    ...over,
  };
}

/** A decision model that always answers with the lowest level, whatever the number of levels. */
const lowest = (levels = 3) =>
  fakeFetch({
    status: 200,
    body: {
      model: "test-decider",
      answers: {
        difficulty: {
          type: "score",
          score: 0,
          probabilities: Object.fromEntries(
            Array.from({ length: levels }, (_, k) => [String(k), k === 0 ? 0.9 : 0.1 / (levels - 1)]),
          ),
          confidence: 0.9,
        },
        ...Object.fromEntries(
          Object.keys(decisionQuestions().sets.difficulty.nouls).map((id) => [
            id,
            { type: "noul", noul: 0.05 },
          ]),
        ),
      },
      usage: { input_tokens: 10, output_tokens: 2 },
    },
  });
const svc = (over: { discoveryBudgetMs?: number; levels?: number } = {}) =>
  routingService({ key: "k", fetchImpl: lowest(over.levels).impl, ...noWait, ...over });

const readJsonIndex = () => JSON.parse(readFileSync(indexPath(), "utf8"));

describe("decide and a run's pinned index", () => {
  it("decides a run on its pinned index after the machine's index lost the pair", async () => {
    const r = req({ role: "reviewer", profile: view("reviewer", ["codex:gpt-6-sol#high"]) });
    writeRunIndex(r.runDir, indexOf({ "gpt-6-sol#high": 42 }));
    // the machine's index, refreshed since, no longer has Sol high
    writeIndexFile(indexPath(), indexOf({ "gpt-6-luna#high": 33 }));
    expect(await svc().decide(r)).toMatchObject({ ok: true, rung: "codex:gpt-6-sol#high" });
    expect(await svc().decide({ ...r, runDir: runDir() })).toMatchObject({ ok: false, rungs: [] });
  });
});

describe("decide with every rung above the floor held", () => {
  it("answers held, not exhausted or no rung, so the decision waits", async () => {
    const held = { ok: false, exhausted: false, held: true, rungs: [] };
    expect(await svc().decide(req({ held: ["codex"] }))).toMatchObject(held);
    const strict = req({ held: ["codex"], floor: "codex:gpt-6-sol#high", strict: true });
    expect(await svc().decide(strict)).toMatchObject(held);
    // nothing above the floor at all is still the top of the ladder
    const top = req({ held: ["codex"], floor: "codex:gpt-6-sol#xhigh", strict: true });
    expect(await svc().decide(top)).toMatchObject({ ok: false, exhausted: true });
    // a refused rung is not a hold: nothing to wait for
    const refused = req({ exclude: LADDER, floor: "codex:gpt-6-sol#high", strict: true });
    expect(await svc().decide(refused)).toMatchObject({ ok: false, exhausted: true });
  });
});

describe("checkStart", () => {
  it("names the roles the index cannot fill, and returns the index it read", async () => {
    const view = testView();
    const ok = await routingService().checkStart(view, "/nowhere");
    expect(ok.unusable).toEqual([]);
    expect(ok.index?.models.length).toBeGreaterThan(0);
    writeIndexFile(indexPath(), indexOf({ "gpt-6-luna#high": 33 }));
    const lost = await routingService().checkStart(view, "/nowhere");
    // Luna high is the writer's rung; the worker keeps Luna high, the reviewer's Sol high is gone
    expect(lost.unusable).toEqual(["architect", "reviewer"]);
    expect(lost.causes).toEqual({ architect: "index", reviewer: "index" });
    expect(lost.index).toEqual(indexOf({ "gpt-6-luna#high": 33 }));
  });

  it("leaves the index file as it was when it is fresh and under CATHERD_NO_SYNC=1", async () => {
    process.env.CATHERD_NO_SYNC = "1";
    const before = JSON.stringify(readJsonIndex());
    await routingService().checkStart(testView(), "/nowhere");
    expect(JSON.stringify(readJsonIndex())).toBe(before);
  });
});

describe("decide and discovery", () => {
  const codex = adapterFor("codex") as BackendAdapter;
  afterEach(() => registerAdapter(codex));

  it("decides on the cached listing when the daily listing does not answer within the budget", async () => {
    // a day-old listing without gpt-6-luna: due for a refresh, and still what a decision reads meanwhile
    const stale = Date.now() - 2 * 24 * 3_600_000;
    const sol = { id: "gpt-6-sol", efforts: ["medium", "high", "xhigh"], context: 272000, imageIn: true };
    writeDiscovery("codex", [sol], stale);
    let calls = 0;
    registerAdapter({ ...codex, listModels: () => (calls++, new Promise(() => {})) });
    const a = await svc({ discoveryBudgetMs: 5 }).decide(req());
    expect(calls).toBe(1);
    // without Luna, the levels are the Sol efforts the cached listing offers
    expect(a).toMatchObject({ ok: true, rung: "codex:gpt-6-sol#medium" });
    expect(a.ok && a.levelRungs.flat()).toEqual([
      "codex:gpt-6-sol#medium",
      "codex:gpt-6-sol#high",
      "codex:gpt-6-sol#xhigh",
    ]);
  });
});

describe("decide and a repository's listing", () => {
  const opencode = adapterFor("opencode") as BackendAdapter;
  afterEach(() => registerAdapter(opencode));

  it("decides on the opencode listing of the repository, not another's", async () => {
    const m = (id: string) => ({ id, efforts: ["high"], context: 1000, imageIn: false });
    registerAdapter({
      ...opencode,
      // the project config in /work/a enables only Luna
      listModels: async (repo?: string) =>
        repo === "/work/a" ? [m("opencode/gpt-6-luna")] : [m("opencode/gpt-6-luna"), m("opencode/gpt-6-sol")],
    });
    const rungs = ["opencode:opencode/gpt-6-luna#high", "opencode:opencode/gpt-6-sol#high"];
    const profile = view("worker", rungs);
    const inA = await svc().decide(req({ repo: "/work/a", profile }));
    expect(inA.ok && inA.levelRungs).toEqual([["opencode:opencode/gpt-6-luna#high"]]);
    const inB = await svc({ levels: 2 }).decide(req({ repo: "/work/b", profile }));
    expect(inB.ok && inB.levelRungs.flat()).toEqual(rungs);
  });
});
