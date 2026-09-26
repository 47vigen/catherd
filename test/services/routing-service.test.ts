import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v0Profiles } from "../../src/bridge/v0.ts";
import { readJsonl } from "../../src/infra/store.ts";
import { resetFreshen } from "../../src/services/catalog-service.ts";
import type { JevRow } from "../../src/services/jev-service.ts";
import type { ProfileView, RouteRequest } from "../../src/services/ports.ts";
import { routingService } from "../../src/services/routing-service.ts";
import { fakeFetch } from "../fake-fetch.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { LADDER, testView } from "./helpers.ts";

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
const TRACK_A = { rung: LADDER[0] as string, ladder: LADDER };
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

function req(laneText: string | null, over: Partial<RouteRequest> = {}): RouteRequest {
  return {
    runDir: mkdtempSync(join(tmpdir(), "catherd-route-")),
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

describe("route with Jev", () => {
  it("takes a confident track over the lane's declaration, and logs the decision but never the lane", async () => {
    const f = fakeFetch({
      status: 200,
      body: fx("route-v2-track-b.json"),
      headers: { "x-typesafe-request-id": "req_1" },
    });
    const r = req(
      lane("repo_code", "build", "Fix the race in the job queue; key: sk-abcdefghijklmnopqrstuv"),
    );
    const a = await routingService({ key: "k", fetchImpl: f.impl, ...noWait }).route(r);
    expect(a).toMatchObject({ ...TRACK_B, source: "jev", kind: "repo_code", difficulty: "hard" });
    expect(a.questionSet).toMatch(/^route-v2#[0-9a-f]{8}$/);
    expect(a.jev).toMatchObject({ pA: 0.05, pB: 0.95, pKind: 0.96, nouls: { unclear_cause: 0.88 } });
    const sent = JSON.stringify(f.sent[0]?.body);
    expect(sent).toContain("Fix the race");
    expect(sent).not.toContain("sk-abc");
    expect(sent).not.toContain("Difficulty: build");
    const [row] = jevRows(r.runDir);
    expect(row).toMatchObject({
      source: "jev",
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

  it("keeps the approved ladder through the default profile the bridge serves", async () => {
    const profile = v0Profiles().forRepo(null);
    const r = routingService();
    expect(await r.route(req(lane("repo_code", "copy"), { profile }))).toMatchObject(TRACK_A);
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
    });
  });
});

describe("finding and same-defect", () => {
  it("answers at p ≥ 0.83 and 0.85, falls back otherwise, and logs each call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "catherd-ask-"));
    const yes = fakeFetch({ status: 200, body: fx("finding-design.json") });
    const r = routingService({ key: "k", fetchImpl: yes.impl, ...noWait });
    expect(await r.finding(dir, lane("repo_code", "build"), "The API shape cannot work")).toEqual({
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
        )
      ).source,
    ).toBe("default");
    expect(await routingService({ key: null }).sameDefect(dir, "a", "b")).toMatchObject({
      value: "no",
      source: "default",
    });
    expect(jevRows(dir).map((x) => [x.call, x.source])).toEqual([
      ["finding", "jev"],
      ["finding", "default"],
      ["same-defect", "default"],
    ]);
  });
});
