import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendAdapter } from "../../src/adapters/backend.ts";
import { writeDiscovery } from "../../src/adapters/discovery.ts";
import { adapterFor, registerAdapter } from "../../src/adapters/registry.ts";
import { readJsonl } from "../../src/infra/store.ts";
import { overridePath, resetFreshen } from "../../src/services/catalog-service.ts";
import { runPaths } from "../../src/services/run-store.ts";
import type { JevRow } from "../../src/services/jev-service.ts";
import type { ProfileView, RouteRequest } from "../../src/services/ports.ts";
import { profileService } from "../../src/services/profile-service.ts";
import { routingService } from "../../src/services/routing-service.ts";
import { fakeFetch } from "../fake-fetch.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { freshRun, LADDER, testView } from "./helpers.ts";

/** the PATH a real run needs (it is a repository); beforeEach takes every CLI off PATH */
const PATH_AT_LOAD = process.env.PATH;

afterEach(snapshotEnv());
beforeEach(() => {
  withHome();
  resetFreshen();
  delete process.env.TYPESAFE_API_KEY;
  // claude-code lists models through Anthropic's API when this is set
  delete process.env.ANTHROPIC_API_KEY;
  // no backend CLI answers a listing here: discovery stays empty
  process.env.PATH = "/nonexistent";
});

const fx = (n: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "jev", n), "utf8"));
// spec 1.2 §5: build lanes need DeepSWE 66.6 (the median), which Luna high (carried from max) and Sol xhigh
// clear; copy needs 60.95, which Sol high clears too, but it scores below Luna high, so a ladder that only goes
// up (spec 1.5 plan 24) leaves it off; no Sol rung clears a logic or hard bar
const TRACK_A = { rung: LADDER[0] as string, ladder: [LADDER[0] as string, LADDER[3] as string] };
const COPY = TRACK_A;
const TRACK_B = { rung: LADDER[1] as string, ladder: LADDER.slice(1) };
const noWait = { sleep: async () => {}, random: () => 0.5 };

const view = (over: Partial<ProfileView> = {}) =>
  testView({
    roles: {
      ...testView().roles,
      worker: {
        enabled: true,
        access: "workspace-write",
        rungs: LADDER,
        defaultRung: "codex:gpt-6-sol#medium",
      },
    },
    ...over,
  });

const lane = (kind: string | null, difficulty: string | null, body = "Add GET /jobs like src/users.ts.") =>
  [
    "# M1.L1 — jobs",
    "Owns: src/jobs.ts",
    "Fast check: bun test",
    ...(kind ? [`Kind: ${kind}`] : []),
    ...(difficulty ? [`Difficulty: ${difficulty}`] : []),
    body,
  ].join("\n");

// inside withHome()'s CATHERD_HOME, so a test leaves nothing behind in the system temp dir's root
const runDir = () => mkdtempSync(join(process.env.CATHERD_HOME as string, "run-"));

function req(laneText: string | null, over: Partial<RouteRequest> = {}): RouteRequest {
  return {
    runDir: runDir(),
    host: "claude-code",
    repo: "/nowhere",
    profile: view(),
    role: "worker",
    lane: laneText === null ? null : "M1.L1",
    laneText,
    spentFraction: 0,
    ...over,
  };
}

const jevRows = (dir: string) => readJsonl<JevRow>(join(dir, "jev.jsonl")).rows;

describe("route without Jev", () => {
  it("routes by the lane file's Kind and Difficulty, and logs the fallback", async () => {
    const r = req(lane("repo_code", "build"));
    expect(await routingService().route(r)).toEqual({
      ...TRACK_A,
      source: "lane",
      kind: "repo_code",
      difficulty: "build",
      questionSet: null,
      jev: null,
      jevSaid: null,
      why: "the lane's Kind/Difficulty, repo_code/build; the first rung in objective order that clears it",
      provenance: expect.objectContaining({ rung: TRACK_A.rung }),
    });
    expect(jevRows(r.runDir)).toEqual([
      expect.objectContaining({
        call: "route-v2",
        lane: "M1.L1",
        source: "lane",
        why: "no key",
        answers: null,
      }),
    ]);
    expect(await routingService().route(req(lane("repo_code", "logic")))).toMatchObject({
      ...TRACK_B,
      source: "lane",
    });
  });

  it("falls back to the default rung without a lane file or a declared kind", async () => {
    expect(await routingService().route(req(null))).toMatchObject({
      ...TRACK_B,
      source: "default",
      questionSet: null,
    });
    expect(await routingService().route(req(lane(null, null)))).toMatchObject({
      ...TRACK_B,
      source: "default",
    });
  });

  it("never asks Jev for a role with one usable rung", async () => {
    const f = fakeFetch({ status: 200, body: fx("route-v2-track-a.json") });
    const r = req(lane("repo_code", "build"), { role: "reviewer" });
    expect(await routingService({ key: "k", fetchImpl: f.impl }).route(r)).toMatchObject({
      rung: "codex:gpt-6-sol#high",
      source: "default",
    });
    expect(f.sent).toHaveLength(0);
  });

  it("does not ask Jev when the profile turns it off", async () => {
    const f = fakeFetch({ status: 200, body: fx("route-v2-track-b.json") });
    const r = req(lane("repo_code", "build"), { profile: view({ jev: { use: "off" } }) });
    expect(await routingService({ key: "k", fetchImpl: f.impl }).route(r)).toMatchObject({ source: "lane" });
    expect(f.sent).toHaveLength(0);
    expect(jevRows(r.runDir)).toEqual([]);
  });
});

describe("route's provenance (spec 1.2 §5.3)", () => {
  it("reports each threshold of the lane's bar, the value used, its confidence and source, and the why", async () => {
    const a = await routingService().route(req(lane("repo_code", "build")));
    expect(a.provenance?.thresholds).toEqual([
      {
        dim: "repo_code",
        min: 66.6,
        clears: true,
        used: expect.objectContaining({
          value: 66.6,
          confidence: "adjacent",
          source: "shipped",
          benchmark: "DeepSWE 1.1",
          inferred: false,
          from: null,
        }),
        why: expect.stringMatching(/^the median of /),
      },
    ]);
    // Luna's agentic value is lent by the shipped treat-like: marked, with the rung it belongs to
    expect(a.provenance?.values.find((v) => v.dim === "agentic")).toMatchObject({
      inferred: true,
      from: "gpt-5.6-luna#high",
    });
    expect(a.provenance?.cost).toEqual(expect.objectContaining({ mode: "chatgpt-plan" }));
    expect(a.provenance?.evidence).toEqual({ kind: null, all: null });
  });

  it("picks a terminal lane by the terminal bar, and a ui lane by the frontend bar, saying whose values", async () => {
    const t = await routingService().route(req(lane("terminal", "copy")));
    expect(t.rung).toBe("codex:gpt-6-sol#medium");
    expect(
      t.provenance?.thresholds.map((x) => [x.dim, x.min, x.used?.value, x.used?.source, x.clears]),
    ).toEqual([["terminal", 40.15, 43, "shipped", true]]);
    const u = await routingService().route(req(lane("ui", "build")));
    expect(u.rung).toBe("codex:gpt-6-sol#xhigh");
    expect(u.provenance?.thresholds.map((x) => [x.dim, x.min, x.used?.source, x.clears])).toEqual([
      ["repo_code", 66.6, "shipped", true],
      ["frontend", 1617, "arena", true],
    ]);
  });

  it("says a threshold is the user's override, not the default's why (1.2 minor)", async () => {
    mkdirSync(join(overridePath(), ".."), { recursive: true });
    writeFileSync(
      overridePath(),
      JSON.stringify({ schema: 1, bars: { repo_code: { build: { repo_code: 60 } } } }),
    );
    const a = await routingService().route(req(lane("repo_code", "build")));
    expect(a.provenance?.thresholds).toEqual([
      expect.objectContaining({ dim: "repo_code", min: 60, why: "your override" }),
    ]);
  });

  it("routes with no evidence when a run on this machine cannot be read (1.2 minor)", async () => {
    process.env.PATH = PATH_AT_LOAD;
    const { run } = freshRun();
    process.env.PATH = "/nonexistent";
    // a routes.jsonl that is a directory: reading it throws
    rmSync(runPaths(run.dir).routes, { force: true });
    mkdirSync(runPaths(run.dir).routes);
    const a = await routingService().route(req(lane("repo_code", "build")));
    expect(a.rung).toBe(TRACK_A.rung);
    expect(a.provenance?.evidence).toBeNull();
  });

  it("shows the default rung's values with no thresholds when the route reads no bar", async () => {
    const a = await routingService().route(req(null));
    expect(a.source).toBe("default");
    expect(a.provenance?.thresholds).toEqual([]);
    expect(a.provenance?.values.length).toBeGreaterThan(0);
  });
});

describe("route with Jev", () => {
  it("keeps the lane's declaration over a confident track, says Jev disagreed, and logs it but never the lane", async () => {
    const f = fakeFetch({
      status: 200,
      body: fx("route-v2-track-b.json"),
      headers: { "x-typesafe-request-id": "req_1" },
    });
    const r = req(
      lane(
        "repo_code",
        "build",
        "Fix the race in the job queue; key: sk-abcdefghijklmnopqrstuv\n```ts\nqueue.drainAll();\n```",
      ),
    );
    const a = await routingService({ key: "k", fetchImpl: f.impl, ...noWait }).route(r);
    // spec 1.5 plan 24: a declared header wins; the route says where Jev disagreed
    expect(a).toMatchObject({
      ...TRACK_A,
      source: "lane",
      kind: "repo_code",
      difficulty: "build",
      jevSaid: "Jev said repo_code/hard",
    });
    expect(a.why).toBe(
      "the lane's Kind/Difficulty, repo_code/build; Jev said repo_code/hard; the first rung in objective order that clears it",
    );
    expect(a.questionSet).toMatch(/^route-v2#[0-9a-f]{8}$/);
    expect(a.jev).toMatchObject({ pA: 0.05, pB: 0.95, pKind: 0.96, nouls: { unclear_cause: 0.88 } });
    const sent = JSON.stringify(f.sent[0]?.body);
    expect(sent).toContain("Fix the race");
    expect(sent).not.toContain("sk-abc");
    expect(sent).not.toContain("Difficulty: build");
    expect(sent).not.toContain("drainAll");
    const [row] = jevRows(r.runDir);
    expect(row).toMatchObject({
      source: "lane",
      requestId: "req_1",
      model: "jev-1.13.0",
      why: "P(B) 0.95 ≥ 0.8",
    });
    expect(JSON.stringify(row)).not.toContain("Fix the race");
  });

  it("uses the lane's declaration in the dead band", async () => {
    const f = fakeFetch({ status: 200, body: fx("route-v2-unsure.json") });
    const r = req(lane("repo_code", "build"));
    const a = await routingService({ key: "k", fetchImpl: f.impl, ...noWait }).route(r);
    expect(a).toMatchObject({ ...TRACK_A, source: "lane", kind: "repo_code" });
    expect(jevRows(r.runDir)[0]?.why).toBe("P(A) 0.55, P(B) 0.45: both below 0.8");
  });

  it("keeps the lane's Kind over a sure kind in the dead band, and says Jev's", async () => {
    const f = fakeFetch({ status: 200, body: fx("route-v2-kind-only.json") });
    const r = req(lane("prose", "build"));
    const a = await routingService({ key: "k", fetchImpl: f.impl, ...noWait }).route(r);
    expect(a).toMatchObject({
      ...TRACK_A,
      source: "lane",
      kind: "prose",
      difficulty: "build",
      jevSaid: "Jev said repo_code/no sure difficulty",
    });
    expect(jevRows(r.runDir)[0]).toMatchObject({ source: "lane", used: `worker ${TRACK_A.rung}` });
  });

  it("keeps a sure kind in the dead band when the lane declares only its Difficulty", async () => {
    const f = fakeFetch({ status: 200, body: fx("route-v2-kind-only.json") });
    const r = req(lane(null, "build"));
    const a = await routingService({ key: "k", fetchImpl: f.impl, ...noWait }).route(r);
    expect(a).toMatchObject({
      ...TRACK_A,
      source: "jev-kind",
      kind: "repo_code",
      difficulty: "build",
      jevSaid: null,
    });
  });

  it("keeps a sure kind in the dead band without a Difficulty line, at the default rung's difficulty", async () => {
    const f = fakeFetch({ status: 200, body: fx("route-v2-kind-only.json") });
    const r = req(lane("prose", null));
    const a = await routingService({ key: "k", fetchImpl: f.impl, ...noWait }).route(r);
    // the lane's Kind wins; the default rung, gpt-6-sol#medium, clears no prose bar: the default difficulty is build
    expect(a).toMatchObject({ ...TRACK_A, source: "jev-kind", kind: "prose", difficulty: "build" });
    expect(a.jevSaid).toBe("Jev said repo_code/no sure difficulty");
    expect(jevRows(r.runDir)[0]?.source).toBe("jev-kind");
  });

  it("falls back as before when neither the kind nor the difficulty is sure", async () => {
    const f = fakeFetch({ status: 200, body: fx("route-v2-unsure.json") });
    const svc = routingService({ key: "k", fetchImpl: f.impl, ...noWait });
    expect(await svc.route(req(lane(null, "build")))).toMatchObject({
      ...TRACK_B,
      source: "default",
      kind: null,
      difficulty: null,
    });
  });

  it("routes a confident track with no declared kind as repo_code", async () => {
    const f = fakeFetch({ status: 200, body: fx("route-v2-track-a.json") });
    const a = await routingService({ key: "k", fetchImpl: f.impl, ...noWait }).route(req(lane(null, null)));
    expect(a).toMatchObject({ ...TRACK_A, source: "jev", kind: "repo_code", difficulty: "build" });
  });

  it("falls back when Jev fails, and answers a repeated route from the run's log", async () => {
    const down = fakeFetch({ status: 401, body: fx("auth-error.json") });
    const r = req(lane(null, null));
    expect(await routingService({ key: "k", fetchImpl: down.impl, ...noWait }).route(r)).toMatchObject({
      source: "default",
    });
    const f = fakeFetch({ status: 200, body: fx("route-v2-track-a.json") });
    const svc = routingService({ key: "k", fetchImpl: f.impl, ...noWait });
    await svc.route(r);
    expect((await svc.route(r)).source).toBe("jev");
    expect(f.sent).toHaveLength(1);
    expect(jevRows(r.runDir).map((x) => [x.cached, x.why])).toEqual([
      [false, "http 401"],
      [false, "P(A) 0.9 ≥ 0.8"],
      [true, "P(A) 0.9 ≥ 0.8"],
    ]);
  });
});

describe("route when Jev never answers", () => {
  it("falls back to the lane's declaration when every attempt times out", async () => {
    const f = fakeFetch("hang");
    const r = req(lane("repo_code", "build"));
    const svc = routingService({ key: "k", fetchImpl: f.impl, attemptMs: 20, deadlineMs: 2_000, ...noWait });
    expect(await svc.route(r)).toMatchObject({ ...TRACK_A, source: "lane" });
    expect(f.sent).toHaveLength(3);
    expect(jevRows(r.runDir)[0]?.why).toBe("timeout");
  });
});

describe("route and discovery", () => {
  const codex = adapterFor("codex") as BackendAdapter;
  afterEach(() => registerAdapter(codex));

  it("routes on the cached listing when the daily listing does not answer within the budget", async () => {
    // a day-old listing without gpt-6-luna: due for a refresh, and still what routing reads meanwhile
    const stale = Date.now() - 2 * 24 * 3_600_000;
    const sol = { id: "gpt-6-sol", efforts: ["medium", "high", "xhigh"], context: 272000, imageIn: true };
    writeDiscovery("codex", [sol], stale);
    let calls = 0;
    registerAdapter({ ...codex, listModels: () => (calls++, new Promise(() => {})) });
    const a = await routingService({ discoveryBudgetMs: 5 }).route(req(lane("repo_code", "build")));
    expect(calls).toBe(1);
    // without Luna, only Sol xhigh clears the build bar
    expect(a).toMatchObject({
      rung: "codex:gpt-6-sol#xhigh",
      ladder: ["codex:gpt-6-sol#xhigh"],
      source: "lane",
    });
    expect(a.ladder).not.toContain("codex:gpt-6-luna#high");
  });
});

describe("route and a repository's listing", () => {
  const opencode = adapterFor("opencode") as BackendAdapter;
  afterEach(() => registerAdapter(opencode));

  it("routes on the opencode listing of the routed repository, not another's", async () => {
    const m = (id: string) => ({ id, efforts: ["high"], context: 1000, imageIn: false });
    registerAdapter({
      ...opencode,
      // the project config in /work/a enables only Luna
      listModels: async (repo?: string) =>
        repo === "/work/a" ? [m("opencode/gpt-6-luna")] : [m("opencode/gpt-6-luna"), m("opencode/gpt-6-sol")],
    });
    const rungs = ["opencode:opencode/gpt-6-luna#high", "opencode:opencode/gpt-6-sol#high"];
    const profile = view({
      roles: { worker: { enabled: true, access: "workspace-write", rungs, defaultRung: rungs[1] } },
    });
    const r = routingService();
    // /work/a does not list the default rung, so the role falls back to the one it lists
    const inA = await r.route(req(null, { repo: "/work/a", profile }));
    expect(inA.ladder).toEqual(["opencode:opencode/gpt-6-luna#high"]);
    const inB = await r.route(req(null, { repo: "/work/b", profile }));
    expect(inB.rung).toBe("opencode:opencode/gpt-6-sol#high");
  });
});

describe("route and the profile", () => {
  it("starts at the cheapest bar-clearing rung from 80 % of the budget, whatever the objective", async () => {
    const secs = { objective: "speed" as const };
    const r = routingService();
    expect(
      (await r.route(req(lane("repo_code", "build"), { profile: view(secs), spentFraction: 0.8 }))).rung,
    ).toBe("codex:gpt-6-luna#high");
  });

  it("routes a role's Claude rung on that role's backend", async () => {
    const p = view({
      roles: {
        reviewer: { enabled: true, access: "read-only", rungs: ["claude-code:claude-opus-5-5#high"] },
        architect: { enabled: true, access: "read-only", rungs: ["claude:claude-opus-5-5#high"] },
      },
    });
    const r = routingService();
    expect((await r.route(req(null, { role: "reviewer", profile: p }))).rung).toBe(
      "claude-code:claude-opus-5-5#high",
    );
    expect((await r.route(req(null, { role: "architect", profile: p }))).rung).toBe(
      "claude:claude-opus-5-5#high",
    );
  });

  it("keeps the approved ladder through the default profile the profile service serves", async () => {
    const profile = profileService(() => ({ host: "claude-code", session: null, conflict: null })).forRepo(
      null,
    );
    const r = routingService();
    expect(await r.route(req(lane("repo_code", "copy"), { profile }))).toMatchObject(COPY);
    expect(await r.route(req(lane("terminal", "build"), { profile }))).toMatchObject(TRACK_B);
    expect(await r.route(req(lane("prose", "hard"), { profile }))).toMatchObject(TRACK_B);
  });

  it("refuses a role with no usable rung with a fix", async () => {
    const p = view({
      roles: {
        artist: { enabled: true, access: "workspace-write", rungs: ["claude-code:claude-opus-5-5#high"] },
      },
    });
    await expect(routingService().route(req(null, { role: "artist", profile: p }))).rejects.toMatchObject({
      code: "E_CONFIG_INVALID",
      fix: expect.stringContaining("treat-like"),
    });
  });
});

describe("finding and same-defect", () => {
  it("answers at p ≥ 0.83 and 0.85, falls back otherwise, and logs each call", async () => {
    const dir = runDir();
    const yes = fakeFetch({ status: 200, body: fx("finding-design.json") });
    const r = routingService({ key: "k", fetchImpl: yes.impl, ...noWait });
    expect(await r.finding(dir, lane("repo_code", "build"), "The API shape cannot work", "auto")).toEqual({
      value: "design",
      probability: 1,
      confidence: 1,
      source: "jev",
    });
    const unsure = fakeFetch({ status: 200, body: fx("finding-unsure.json") });
    expect(
      (
        await routingService({ key: "k", fetchImpl: unsure.impl, ...noWait }).finding(
          dir,
          lane(null, null),
          "x",
          "auto",
        )
      ).source,
    ).toBe("default");
    expect(await routingService({ key: null }).sameDefect(dir, "a", "b", "auto")).toMatchObject({
      value: "no",
      source: "default",
    });
    expect(jevRows(dir).map((x) => [x.call, x.source])).toEqual([
      ["finding", "jev"],
      ["finding", "default"],
      ["same-defect", "default"],
    ]);
  });

  it("never sends a secret or fenced code in a finding or a defect to Jev", async () => {
    const dir = runDir();
    const leak = "Token leaks. key: sk-abcdefghijklmnopqrstuv\n```ts\nqueue.drainAll();\n```";
    const f = fakeFetch({ status: 200, body: fx("finding-design.json") });
    const r = routingService({ key: "k", fetchImpl: f.impl, ...noWait });
    await r.finding(dir, lane("repo_code", "build"), leak, "auto");
    const s = fakeFetch({ status: 200, body: fx("same-defect-yes.json") });
    await routingService({ key: "k", fetchImpl: s.impl, ...noWait }).sameDefect(dir, leak, leak, "auto");
    for (const sent of [f.sent[0]?.body, s.sent[0]?.body].map((b) => JSON.stringify(b))) {
      expect(sent).toContain("Token leaks.");
      expect(sent).not.toContain("sk-abc");
      expect(sent).not.toContain("drainAll");
    }
  });

  it("never asks Jev for finding or same-defect with jev.use off", async () => {
    const dir = runDir();
    // askJev swallows a transport error, so the fake counts its calls and the test checks the count
    const asked: string[] = [];
    const fail = (async (input: RequestInfo | URL): Promise<Response> => {
      asked.push(String(input));
      throw new Error("Jev was asked with jev.use off");
    }) as typeof fetch;
    const r = routingService({ key: "k", fetchImpl: fail, ...noWait });
    expect(await r.finding(dir, lane("repo_code", "build"), "The API shape cannot work", "off")).toEqual({
      value: "code",
      probability: null,
      confidence: null,
      source: "default",
    });
    expect(await r.sameDefect(dir, "a", "a", "off")).toMatchObject({ value: "no", source: "default" });
    expect(asked).toEqual([]);
    expect(jevRows(dir)).toEqual([]);
  });
});

it("refuses a selected native Claude rung from Codex and names exact headless alternative", async () => {
  const r = req(null, { host: "codex", role: "architect" });
  await expect(routingService().route(r)).rejects.toMatchObject({
    code: "E_CONFIG_INVALID",
    fix: expect.stringContaining("claude-code:claude-opus-5-5#high"),
  });
});

it("refuses native dispatch without host evidence while explicit profile stays inspectable", async () => {
  const r = req(null, { host: "unknown", role: "architect" });
  expect(r.profile.roles.architect?.rungs).toEqual(["claude:claude-opus-5-5#high"]);
  await expect(routingService().route(r)).rejects.toMatchObject({
    code: "E_CONFIG_INVALID",
    fix: expect.stringContaining("claude-code:claude-opus-5-5#high"),
  });
});

describe("route and quota headroom (spec 1.5 plan 24)", () => {
  // Luna high on Codex and on OpenCode Go is one model: equal scores on two quotas
  const GO_LUNA = "opencode:opencode-go/gpt-6-luna#high";
  const rungs = [LADDER[0] as string, GO_LUNA, ...LADDER.slice(1)];
  const profile = () =>
    view({
      roles: {
        ...testView().roles,
        worker: { enabled: true, access: "workspace-write", rungs, defaultRung: "codex:gpt-6-sol#medium" },
      },
    });

  it("starts a tie on the quota the run has used least", async () => {
    const r = routingService();
    const a = await r.route(
      req(lane("repo_code", "copy"), { profile: profile(), usage: { "opencode-go": 2 } }),
    );
    expect(a.rung).toBe(LADDER[0] as string);
    const b = await r.route(req(lane("repo_code", "copy"), { profile: profile(), usage: { codex: 2 } }));
    expect(b.rung).toBe(GO_LUNA);
    expect(b.ladder).toContain(LADDER[0] as string);
  });
});

describe("batch route (spec 1.5 plan 24)", () => {
  it("asks Jev about every lane at once, and decides each one", async () => {
    // each answer is held until both questions are in flight: asked one after the other, the first would hang
    const held: (() => void)[] = [];
    let asked = 0;
    const impl = (async () => {
      asked++;
      if (asked < 2) await new Promise<void>((resolve) => held.push(resolve));
      else for (const go of held) go();
      return new Response(JSON.stringify(fx("route-v2-track-a.json")), { status: 200 });
    }) as unknown as typeof fetch;
    const svc = routingService({ key: "k", fetchImpl: impl, attemptMs: 2_000, ...noWait });
    const dir = runDir();
    const one = (id: string) => ({ ...req(lane(null, null)), runDir: dir, lane: id });
    const out = await svc.routeMany([one("M1.L1"), one("M1.L2")]);
    expect(asked).toBe(2);
    expect(out.map((a) => [a.source, a.rung])).toEqual([
      ["jev", TRACK_A.rung],
      ["jev", TRACK_A.rung],
    ]);
    expect(jevRows(dir).map((r) => r.lane)).toEqual(["M1.L1", "M1.L2"]);
  });

  it("spreads lanes that tie over the quotas, each routed start counting as a use", async () => {
    const GO_LUNA = "opencode:opencode-go/gpt-6-luna#high";
    const profile = view({
      roles: {
        ...testView().roles,
        worker: {
          enabled: true,
          access: "workspace-write",
          rungs: [LADDER[0] as string, GO_LUNA, ...LADDER.slice(1)],
          defaultRung: "codex:gpt-6-sol#medium",
        },
      },
    });
    const one = () => req(lane("repo_code", "copy"), { profile });
    const out = await routingService().routeMany([one(), one(), one()]);
    expect(out.map((a) => a.rung)).toEqual([LADDER[0] as string, GO_LUNA, LADDER[0] as string]);
    expect(out[1]?.tie).toMatch(
      /opencode-go has the most headroom \(dispatches in this run: codex 1, opencode-go 0\)$/,
    );
  });
});
