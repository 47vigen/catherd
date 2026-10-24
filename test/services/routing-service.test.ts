import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendAdapter } from "../../src/adapters/backend.ts";
import { writeDiscovery } from "../../src/adapters/discovery.ts";
import { adapterFor, registerAdapter } from "../../src/adapters/registry.ts";
import { readJsonl } from "../../src/infra/store.ts";
import { indexPath } from "../../src/infra/paths.ts";
import { writeIndexFile } from "../../src/infra/slopalytics.ts";
import { resetFreshen, writeRunIndex } from "../../src/services/catalog-service.ts";
import { indexOf } from "../domain/shipped.ts";
import { appendOutcome, appendRoute, runPaths } from "../../src/services/run-store.ts";
import type { OutcomeRow, RouteRow } from "../../src/domain/route.ts";
import type { MilestonePlan } from "../../src/domain/run-events.ts";
import { appendEvents } from "../../src/services/run-events-store.ts";
import { CHORE_WHY } from "../../src/domain/track-record.ts";
import type { JevRow } from "../../src/services/jev-service.ts";
import type { Bars } from "../../src/domain/bars.ts";
import type { ProfileView, RouteRequest } from "../../src/services/ports.ts";
import { profileService } from "../../src/services/profile-service.ts";
import { JEV_PARALLEL, routingService } from "../../src/services/routing-service.ts";
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
// the bars are the 20th, 45th, 60th and 65th percentiles of the shipped pool (copy 30.0, build 38.8, logic
// 42.3, hard 44.1 on the recorded index): Luna high (32.9) clears copy, Sol medium (39.81) clears build, Sol
// high (42.40) clears logic, and Sol xhigh clears hard; a ladder only climbs (spec 1.5 plan 24)
const TRACK_A = { rung: LADDER[1] as string, ladder: LADDER.slice(1) };
const COPY = { rung: LADDER[0] as string, ladder: LADDER };
const TRACK_B = { rung: LADDER[2] as string, ladder: LADDER.slice(2) };
const HARD = { rung: LADDER[3] as string, ladder: LADDER.slice(3) };
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

const readJsonIndex = () => JSON.parse(readFileSync(indexPath(), "utf8"));
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
      ...TRACK_A,
      source: "default",
      questionSet: null,
    });
    expect(await routingService().route(req(lane(null, null)))).toMatchObject({
      ...TRACK_A,
      source: "default",
    });
  });

  it("never asks Jev for a role with one usable rung", async () => {
    const f = fakeFetch({ status: 200, body: fx("route-v2-track-a.json") });
    const r = req(lane("repo_code", "build"), { role: "reviewer" });
    expect(await routingService({ key: "k", fetchImpl: f.impl }).route(r)).toMatchObject({
      rung: "codex:gpt-6-sol#high",
      source: "lane",
      kind: "repo_code",
      difficulty: "build",
    });
    expect(f.sent).toHaveLength(0);
  });

  it("keeps a one-rung role's declared Kind/Difficulty and says when its rung misses the bar", async () => {
    const f = fakeFetch({ status: 200, body: fx("route-v2-track-a.json") });
    const r = req(lane("repo_code", "hard"), { role: "reviewer" });
    const a = await routingService({ key: "k", fetchImpl: f.impl }).route(r);
    expect(a).toMatchObject({
      rung: "codex:gpt-6-sol#high",
      source: "lane",
      kind: "repo_code",
      difficulty: "hard",
      noClear: expect.stringContaining("no rung clears hard (bar 43.4); best is codex:gpt-6-sol#high (42.4)"),
    });
    expect(a.why).toStartWith("the lane's Kind/Difficulty, repo_code/hard; no rung clears hard");
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

describe("route's provenance", () => {
  it("reports the rung's intelligence, the bar it was held to and whether it clears, the cost and the index's age", async () => {
    const a = await routingService().route(req(lane("repo_code", "build")));
    expect(a.provenance).toMatchObject({
      rung: TRACK_A.rung,
      canonical: "gpt-6-sol#medium",
      bar: { difficulty: "build", percentile: 45, clears: true },
    });
    const p = a.provenance;
    expect(p?.intelligence).toBeGreaterThanOrEqual(p?.bar?.min ?? Infinity);
    expect(typeof p?.indexedAt).toBe("string");
    expect(p?.cost).toEqual(expect.objectContaining({ mode: "chatgpt-plan" }));
    expect(p?.evidence).toEqual({ kind: null, all: null });
  });

  it("holds every kind to the same intelligence bar: the difficulty alone sets it", async () => {
    const t = await routingService().route(req(lane("terminal", "copy")));
    const u = await routingService().route(req(lane("ui", "copy")));
    expect(t.provenance?.bar).toEqual(u.provenance?.bar);
    expect(t.rung).toBe(u.rung);
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

  it("shows the default rung's intelligence with no bar when the route reads none", async () => {
    const a = await routingService().route(req(null));
    expect(a.source).toBe("default");
    expect(a.provenance?.bar).toBeNull();
    expect(a.provenance?.intelligence).toBeGreaterThan(0);
  });
});

const plan = (milestones: [string, string[]][]): MilestonePlan[] =>
  milestones.map(([id, after]) => ({
    id,
    title: id,
    after,
    lanes: [{ id: `${id}.L1`, role: "worker", kind: "repo_code", after: [], owns: [`src/${id}/`] }],
  }));

/** a run dir whose events hold a plan.ready: M1 → M2 → M3 and M1 → M4 (M2.L1 is critical, M4.L1 has slack 2) */
function planned(): string {
  const dir = runDir();
  const e = {
    v: 1,
    seq: 1,
    at: "2026-10-24T10:00:00.000Z",
    type: "plan.ready",
    milestones: plan([
      ["M1", []],
      ["M2", ["M1"]],
      ["M3", ["M2"]],
      ["M4", ["M1"]],
    ]),
  };
  writeFileSync(join(dir, "events.jsonl"), `${JSON.stringify(e)}\n`);
  return dir;
}

describe("route by chore, slack, record and the critical path", () => {
  it("a chore lane starts on the cheapest rung", async () => {
    const f = fakeFetch({ status: 200, body: fx("route-v2-track-a.json") });
    const r = req(`${lane("repo_code", "hard")}\nChore: yes`);
    const a = await routingService({ key: "k", fetchImpl: f.impl }).route(r);
    expect(a).toMatchObject({ rung: LADDER[0], ladder: LADDER, difficulty: "hard", source: "lane" });
    expect(a.why).toContain(CHORE_WHY);
    expect(jevRows(r.runDir)).toEqual([]);
    expect(f.sent).toHaveLength(0);
  });

  it("a chore lane with no kind says only that it is a chore", async () => {
    const a = await routingService().route(req(`# M1.L1\nChore: yes`));
    expect(a).toMatchObject({ rung: LADDER[0], source: "default", why: CHORE_WHY });
  });

  it("a lane with slack routes on the easier bar", async () => {
    const a = await routingService().route(
      req(lane("repo_code", "build"), { runDir: planned(), lane: "M4.L1" }),
    );
    expect(a).toMatchObject({ rung: LADDER[0], difficulty: "build" });
    expect(a.why).toContain("slack 2: held to copy's bar");
  });

  it("a critical lane starts no lower than the default rung", async () => {
    const dir = planned();
    // sol#high as the default: the cheapest rung that clears build (sol#medium) is below it
    const high = view({
      roles: {
        ...view().roles,
        worker: { enabled: true, access: "workspace-write", rungs: LADDER, defaultRung: LADDER[2] },
      },
    });
    const a = await routingService().route(
      req(lane("repo_code", "build"), { runDir: dir, lane: "M2.L1", profile: high }),
    );
    expect(a).toMatchObject({ rung: LADDER[2], difficulty: "build" });
    expect(a.why).toContain("critical path: no lower than the default rung");
    const copy = await routingService().route(
      req(lane("repo_code", "copy"), { runDir: dir, lane: "M2.L1", profile: high }),
    );
    expect(copy.rung).toBe(COPY.rung);
    expect(copy.why).not.toContain("critical path");
  });

  it("a lane not in the plan, or a corrupt events file, routes as today", async () => {
    const dir = planned();
    const late = await routingService().route(
      req(lane("repo_code", "build"), { runDir: dir, lane: "M9.L1" }),
    );
    expect(late).toMatchObject({ ...TRACK_A, why: expect.stringContaining("first rung in objective order") });
    const bad = runDir();
    writeFileSync(join(bad, "events.jsonl"), "not json\n{}\n");
    expect(await routingService().route(req(lane("repo_code", "build"), { runDir: bad }))).toMatchObject(
      TRACK_A,
    );
  });

  describe("with recorded outcomes", () => {
    const AT = "2026-10-24T10:00:00.000Z";
    const rungs = [LADDER[0], LADDER[1]] as [string, string];
    /** one past run whose finished build lanes are `[rung, lanes, lanes that landed on the first pass]` */
    async function record(...specs: [string, number, number][]): Promise<void> {
      const { run } = freshRun();
      const lanes = specs.flatMap(([rung, n, first]) =>
        Array.from({ length: n }, (_, i) => ({ id: `M1.L${rung.length}x${i}`, rung, one: i < first })),
      );
      await appendEvents(run, [
        {
          type: "plan.ready",
          milestones: [
            {
              id: "M1",
              title: "m",
              after: [],
              lanes: lanes.map((l) => ({ id: l.id, role: "worker", kind: "repo_code", after: [], owns: [] })),
            },
          ],
        },
        ...lanes.flatMap((l) =>
          Array.from({ length: l.one ? 1 : 2 }, (_, k) => ({
            type: "dispatch.started" as const,
            dispatchId: `${l.id}-${k}`,
            name: `worker-${l.id}`,
            role: "worker" as const,
            unit: l.id,
            lane: l.id,
            rung: l.rung,
            thread: null,
          })),
        ),
      ]);
      for (const l of lanes) {
        const r: RouteRow = {
          at: AT,
          lane: l.id,
          role: "worker",
          rung: l.rung,
          ladder: [l.rung],
          source: "route",
          decidedBy: "lane",
          from: null,
          reason: null,
          kind: "repo_code",
          difficulty: "build",
        };
        const o: OutcomeRow = {
          at: AT,
          lane: l.id,
          questionSet: null,
          jevProbs: null,
          source: "lane",
          startRung: l.rung,
          finalRung: l.rung,
          climbs: [],
          landed: true,
          start_ok: true,
          min_ok_index: 0,
          envCaused: false,
        };
        appendRoute(run, r);
        appendOutcome(run, o);
      }
    }

    it("a cheaper rung with a better record is learned", async () => {
      await record([rungs[1] as string, 5, 3], [rungs[0] as string, 5, 5]);
      const a = await routingService().route(req(lane("repo_code", "build")));
      expect(a.rung).toBe(rungs[0]);
      expect(a.why).toContain(`learned from build lanes: ${rungs[0]} 5/5 first pass`);
      expect(a.why).toContain(`against ${rungs[1]} 3/5 first pass`);
      // a critical lane with the same record keeps the default rung
      const c = await routingService().route(
        req(lane("repo_code", "build"), { runDir: planned(), lane: "M2.L1" }),
      );
      expect(c.rung).toBe(TRACK_A.rung);
      expect(c.why).toContain("critical path");
    });

    it("learns nothing from fewer than five lanes on the start rung", async () => {
      await record([rungs[1] as string, 4, 2], [rungs[0] as string, 5, 5]);
      expect((await routingService().route(req(lane("repo_code", "build")))).rung).toBe(TRACK_A.rung);
    });
  });
});

describe("route and a run's pinned index", () => {
  it("routes a run on its pinned index after the machine's index lost the pair", async () => {
    const r = req(lane("repo_code", "build"), { role: "reviewer" });
    writeRunIndex(r.runDir, indexOf({ "gpt-6-sol#high": 42 }));
    // the machine's index, refreshed since, no longer has Sol high
    writeIndexFile(indexPath(), indexOf({ "gpt-6-luna#high": 33 }));
    expect((await routingService().route(r)).rung).toBe("codex:gpt-6-sol#high");
    await expect(routingService().route({ ...r, runDir: runDir() })).rejects.toMatchObject({
      code: "E_CONFIG_INVALID",
    });
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

describe("route with Jev", () => {
  it("routes a Kind-only lane on its kind as the lane's when Jev is sure of nothing", async () => {
    const r = req(lane("prose", null));
    const svc = routingService({
      key: "k",
      fetchImpl: fakeFetch({ status: 200, body: fx("route-v2-unsure.json") }).impl,
      ...noWait,
    });
    expect(await svc.route(r)).toMatchObject({
      ...TRACK_A,
      source: "lane",
      kind: "prose",
      difficulty: "build",
    });
    expect(jevRows(r.runDir)[0]?.source).toBe("lane");
    expect(await routingService().route(req(lane("prose", null)))).toMatchObject({
      source: "lane",
      kind: "prose",
      difficulty: "build",
    });
  });
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
      ...TRACK_A,
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

  it("routes a lane with no header as logic when Jev says it crosses services (floorLogic)", async () => {
    const body = fx("route-v2-track-a.json") as { answers: Record<string, { noul?: number }> };
    (body.answers.cross_boundary as { noul: number }).noul = 0.9;
    const r = req(lane(null, null));
    const a = await routingService({
      key: "k",
      fetchImpl: fakeFetch({ status: 200, body }).impl,
      ...noWait,
    }).route(r);
    expect(a).toMatchObject({ source: "jev", kind: "repo_code", difficulty: "logic" });
    expect(jevRows(r.runDir)[0]?.why).toBe("P(A) 0.9 ≥ 0.8; floor logic: cross_boundary 0.9");
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
    // without Luna, the ladder is the Sol efforts the cached listing offers
    expect(a).toMatchObject({
      rung: "codex:gpt-6-sol#medium",
      ladder: ["codex:gpt-6-sol#medium", "codex:gpt-6-sol#high", "codex:gpt-6-sol#xhigh"],
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
    ).toBe("codex:gpt-6-sol#medium");
    // under the speed objective and with budget to spare, the fastest clearing rung leads instead
    expect(
      (await r.route(req(lane("repo_code", "build"), { profile: view(secs), spentFraction: 0 }))).rung,
    ).not.toBe("codex:gpt-6-sol#medium");
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
    expect(await r.route(req(lane("terminal", "build"), { profile }))).toMatchObject(TRACK_A);
    expect(await r.route(req(lane("prose", "hard"), { profile }))).toMatchObject(HARD);
  });

  it("under budget pressure a worker still starts at medium or above", async () => {
    writeIndexFile(
      indexPath(),
      indexOf({
        "gpt-6-luna#high": 30,
        "gpt-6-sol#low": 35,
        "gpt-6-sol#medium": 36,
        "gpt-6-sol#high": 42,
        "gpt-6-sol#xhigh": 46,
      }),
    );
    const r = req(lane("repo_code", "copy"), {
      spentFraction: 0.9,
      profile: view({
        roles: {
          ...view().roles,
          worker: { ...view().roles.worker!, rungs: ["codex:gpt-6-sol#low", ...LADDER] },
        },
      }),
    });
    const a = await routingService({ ...noWait }).route(r);
    expect(a.rung).toBe("codex:gpt-6-sol#medium");
    expect(a.ladder).not.toContain("codex:gpt-6-sol#low");
  });

  it("routes a role on its own bar over the profile's, one difficulty at a time", async () => {
    writeIndexFile(
      indexPath(),
      indexOf({
        "gpt-6-luna#high": 30,
        "gpt-6-sol#medium": 36,
        "gpt-6-sol#high": 42,
        "gpt-6-sol#xhigh": 46,
      }),
    );
    const worker = (bars?: Bars) => ({ ...view().roles.worker!, ...(bars ? { bars } : {}) });
    const on = (o: Partial<ProfileView>) =>
      routingService({ ...noWait }).route(req(lane("repo_code", "logic"), { profile: view(o) }));
    expect((await on({ bars: { build: 30, logic: 30 } })).rung).toBe("codex:gpt-6-sol#medium");
    expect(
      (
        await on({
          bars: { build: 30, logic: 30 },
          roles: { ...view().roles, worker: worker({ logic: 60 }) },
        })
      ).rung,
    ).toBe("codex:gpt-6-sol#high");
    const a = await on({ roles: { ...view().roles, worker: worker({ build: 30, logic: 30 }) } });
    expect(a).toMatchObject({ rung: "codex:gpt-6-sol#medium" });
    expect(a.provenance?.bar).toMatchObject({ difficulty: "logic", percentile: 30, clears: true });
    expect((await on({})).provenance?.bar).toMatchObject({ percentile: 60 });
  });

  it("refuses a role with no usable rung with a fix", async () => {
    const p = view({
      roles: {
        artist: { enabled: true, access: "workspace-write", rungs: ["claude-code:claude-opus-5-5#high"] },
      },
    });
    await expect(routingService().route(req(null, { role: "artist", profile: p }))).rejects.toMatchObject({
      code: "E_CONFIG_INVALID",
      fix: expect.stringContaining("catherd catalog list --role artist"),
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

describe("stopCause", () => {
  it("names the reason of a stop when sure, falls back to other otherwise, and asks nothing with Jev off", async () => {
    const dir = runDir();
    const yes = fakeFetch({ status: 200, body: fx("stop-needs-user.json") });
    const r = routingService({ key: "k", fetchImpl: yes.impl, ...noWait });
    expect(await r.stopCause(dir, "ok, STATUS blocked", "which database?", "auto")).toMatchObject({
      value: "needs_user",
      source: "jev",
    });
    expect(await routingService({ key: null }).stopCause(dir, "failed", "x", "auto")).toMatchObject({
      value: "other",
      source: "default",
    });
    const asked: string[] = [];
    const fail = (async (input: RequestInfo | URL): Promise<Response> => {
      asked.push(String(input));
      throw new Error("Jev was asked with jev.use off");
    }) as typeof fetch;
    expect(
      await routingService({ key: "k", fetchImpl: fail, ...noWait }).stopCause(dir, "failed", "x", "off"),
    ).toMatchObject({ value: "other", source: "default" });
    expect(asked).toEqual([]);
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
  // Luna xhigh on Codex and on OpenCode Go is one model: equal intelligence on two quotas
  const CODEX_LUNA = "codex:gpt-6-luna#xhigh";
  const GO_LUNA = "opencode:opencode-go/gpt-6-luna#xhigh";
  const rungs = [CODEX_LUNA, GO_LUNA, ...LADDER.slice(1)];
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
    expect(a.rung).toBe(CODEX_LUNA);
    const b = await r.route(req(lane("repo_code", "copy"), { profile: profile(), usage: { codex: 2 } }));
    expect(b.rung).toBe(GO_LUNA);
    expect(b.ladder).toContain(CODEX_LUNA);
  });
});

describe("batch route (spec 1.5 plan 24)", () => {
  it("asks Jev about at most JEV_PARALLEL lanes at a time", async () => {
    let active = 0;
    let most = 0;
    const impl = (async () => {
      active++;
      most = Math.max(most, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      return new Response(JSON.stringify(fx("route-v2-track-a.json")), { status: 200 });
    }) as unknown as typeof fetch;
    const svc = routingService({ key: "k", fetchImpl: impl, ...noWait });
    const dir = runDir();
    const ids = Array.from({ length: JEV_PARALLEL + 2 }, (_, i) => `M1.L${i + 1}`);
    const out = await svc.routeMany(ids.map((id) => ({ ...req(lane(null, null)), runDir: dir, lane: id })));
    expect(most).toBe(JEV_PARALLEL);
    expect(out.map((a) => a.source)).toEqual(ids.map(() => "jev"));
    expect(jevRows(dir).map((r) => r.lane)).toEqual(ids);
  });
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
    const CODEX_LUNA = "codex:gpt-6-luna#xhigh";
    const GO_LUNA = "opencode:opencode-go/gpt-6-luna#xhigh";
    const profile = view({
      roles: {
        ...testView().roles,
        worker: {
          enabled: true,
          access: "workspace-write",
          rungs: [CODEX_LUNA, GO_LUNA, ...LADDER.slice(1)],
          defaultRung: "codex:gpt-6-sol#medium",
        },
      },
    });
    const one = () => req(lane("repo_code", "copy"), { profile });
    const out = await routingService().routeMany([one(), one(), one()]);
    expect(out.map((a) => a.rung)).toEqual([CODEX_LUNA, GO_LUNA, CODEX_LUNA]);
    expect(out[1]?.tie).toMatch(
      /opencode-go has the most headroom \(dispatches in this run: codex 1, opencode-go 0\)$/,
    );
  });
});
