import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { laneOutcome, latestOutcomes, type RouteRow } from "../../src/domain/route.ts";
import { land } from "../../src/services/lane-service.ts";
import {
  readOutcomeRoutes,
  readOutcomes,
  readRoutes,
  type Run,
  runPaths,
} from "../../src/services/run-store.ts";
import { snapshotEnv } from "../helpers.ts";
import { climb, fakeDeps, freshRun, LADDER, passGate, route, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());

const head = (repo: string) =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

/** A lane's route as a daemon-less run's coordinator left it: kind and difficulty from the lane file. */
const routed = (deps: ReturnType<typeof fakeDeps>, run: Run, lane: string) =>
  route(deps, {
    run: run.id,
    laneFile: `lanes/${lane}.md`,
    role: "worker",
    row: { decidedBy: "lane", kind: "repo_code", difficulty: "build" },
  });

async function landM1(deps: ReturnType<typeof fakeDeps>, run: Run, commit: string) {
  await passGate(run, "M1");
  return land(deps, { run: run.id, milestone: "M1", what: "jobs", commit, evidence: "ok", next: "M2" });
}

describe("outcomes.jsonl (spec §5.6)", () => {
  it("writes one row per routed lane of a landed milestone, excluding environment climbs from start_ok", async () => {
    const { repo, run } = freshRun();
    const deps = fakeDeps();
    for (const id of ["M1.L1", "M1.L2", "M2.L1"]) {
      writeLane(run, id, [`src/${id}.ts`]);
      await routed(deps, run, id);
    }
    await climb(deps, { run: run.id, lane: "M1.L1", reason: "blocked", evidence: "no database", env: true });
    await climb(deps, { run: run.id, lane: "M1.L2", reason: "check-failed-twice" });
    await landM1(deps, run, head(repo));
    const rows = readOutcomes(run);
    expect(rows.map((o) => o.lane)).toEqual(["M1.L1", "M1.L2"]);
    expect(rows[0]).toMatchObject({
      source: "lane",
      startRung: LADDER[0],
      finalRung: LADDER[1],
      climbs: [{ from: LADDER[0], to: LADDER[1], reason: "blocked: no database", env: true }],
      landed: true,
      start_ok: true,
      min_ok_index: 1,
      envCaused: true,
    });
    expect(rows[1]).toMatchObject({ start_ok: false, min_ok_index: 1, envCaused: false });
    const first = readFileSync(runPaths(run.dir).outcomes, "utf8").split("\n")[0] as string;
    expect(JSON.parse(first)).toEqual({ schema: 1, kind: "outcomes" });
  });

  it("says so when no routed lane is in the landed milestone, as a typo in its name would", async () => {
    const { repo, run } = freshRun();
    const deps = fakeDeps();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    await routed(deps, run, "M1.L1");
    await passGate(run, "m1");
    const typo = await land(deps, {
      run: run.id,
      milestone: "m1",
      what: "jobs",
      commit: head(repo),
      evidence: "ok",
      next: "M2",
    });
    expect(typo.hints).toEqual([
      'land: no routed lane is in milestone "m1" (routed: M1.L1); check its name: no lane outcome was recorded',
    ]);
    expect(readOutcomes(run)).toEqual([]);
    expect((await landM1(deps, run, head(repo))).hints).toBeUndefined();
    expect(readOutcomes(run).map((o) => o.lane)).toEqual(["M1.L1"]);
  });

  it("writes an open row when a lane climbs past its top rung", async () => {
    const { run } = freshRun();
    const deps = fakeDeps();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    await routed(deps, run, "M1.L1");
    for (let i = 0; i < LADDER.length; i++)
      await climb(deps, { run: run.id, lane: "M1.L1", reason: "blocker" });
    const [o] = readOutcomes(run);
    expect(o).toMatchObject({ landed: false, start_ok: false, min_ok_index: null, finalRung: LADDER.at(-1) });
    expect(o?.climbs).toHaveLength(LADDER.length - 1);
  });

  it("keeps a lane's newer row when it is written twice: last row per lane wins", async () => {
    const { repo, run } = freshRun();
    const deps = fakeDeps();
    for (const id of ["M1.L1", "M1.L2"]) {
      writeLane(run, id, [`src/${id}.ts`]);
      await routed(deps, run, id);
    }
    for (let i = 0; i < LADDER.length; i++)
      await climb(deps, { run: run.id, lane: "M1.L1", reason: "blocker" });
    await landM1(deps, run, head(repo));
    const rows = readOutcomes(run);
    expect(rows.map((o) => [o.lane, o.landed])).toEqual([
      ["M1.L1", false],
      ["M1.L1", true],
      ["M1.L2", true],
    ]);
    const latest = latestOutcomes(rows);
    expect(latest.map((o) => [o.lane, o.landed])).toEqual([
      ["M1.L1", true],
      ["M1.L2", true],
    ]);
    expect(latest[0]).toBe(rows[1] as (typeof rows)[number]);
  });

  it("starts from the lane's last route, and ignores lanes never routed", () => {
    const row = (over: Partial<RouteRow>): RouteRow => ({
      at: "t",
      lane: "M1.L1",
      role: "worker",
      rung: "a",
      ladder: ["a", "b"],
      source: "route",
      decidedBy: "lane",
      from: null,
      reason: null,
      kind: "repo_code",
      difficulty: "build",
      ...over,
    });
    const rows = [
      row({}),
      row({ source: "climb", from: "a", rung: "b", reason: "blocker" }),
      row({ rung: "b", ladder: ["b"] }),
    ];
    expect(laneOutcome(rows, "M1.L1", true, "t")).toMatchObject({
      startRung: "b",
      climbs: [],
      start_ok: true,
      min_ok_index: 0,
    });
    expect(laneOutcome(rows, "M9.L9", true, "t")).toBeNull();
  });

  it("counts an env climb past the top rung as envCaused, without listing the no-op climb", () => {
    const row = (over: Partial<RouteRow>): RouteRow => ({
      at: "t",
      lane: "M1.L1",
      role: "worker",
      rung: "b",
      ladder: ["a", "b"],
      source: "route",
      decidedBy: "lane",
      from: null,
      reason: null,
      kind: "repo_code",
      difficulty: "build",
      ...over,
    });
    const rows = [row({}), row({ source: "climb", from: "b", rung: "b", reason: "blocked", env: true })];
    expect(laneOutcome(rows, "M1.L1", false, "t")).toMatchObject({
      finalRung: "b",
      climbs: [],
      landed: false,
      start_ok: false,
      min_ok_index: null,
      envCaused: true,
    });
    const capability = [row({}), row({ source: "climb", from: "b", rung: "b", reason: "refused" })];
    expect(laneOutcome(capability, "M1.L1", true, "t")).toMatchObject({ start_ok: false, envCaused: false });
  });
});

describe("the outcome beside the route in routes.jsonl (spec 1.5 plan 24)", () => {
  it("writes each landed lane's outcome, climbed or not, with the route's kind and difficulty", async () => {
    const { repo, run } = freshRun();
    const deps = fakeDeps();
    for (const id of ["M1.L1", "M1.L2"]) {
      writeLane(run, id, [`src/${id}.ts`]);
      await routed(deps, run, id);
    }
    await climb(deps, { run: run.id, lane: "M1.L2", reason: "check-failed-twice" });
    await landM1(deps, run, head(repo));
    expect(readOutcomeRoutes(run).map((r) => [r.lane, r.climbed, r.landed, r.kind, r.difficulty])).toEqual([
      ["M1.L1", false, true, "repo_code", "build"],
      ["M1.L2", true, true, "repo_code", "build"],
    ]);
    // the lane readers never see an outcome row: the lane's current route is still its last climb
    expect(readRoutes(run).map((r) => r.source)).toEqual(["route", "route", "climb"]);
  });

  it("writes a lane that ended open on its top rung", async () => {
    const { run } = freshRun();
    const deps = fakeDeps();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    await route(deps, {
      run: run.id,
      laneFile: "lanes/M1.L1.md",
      role: "worker",
      row: {
        rung: LADDER[3] as string,
        ladder: [LADDER[3] as string],
        kind: "repo_code",
        difficulty: "hard",
      },
    });
    await climb(deps, { run: run.id, lane: "M1.L1", reason: "check-failed-twice" });
    expect(readOutcomeRoutes(run)).toEqual([
      expect.objectContaining({
        lane: "M1.L1",
        source: "outcome",
        landed: false,
        climbed: false,
        difficulty: "hard",
      }),
    ]);
  });
});
