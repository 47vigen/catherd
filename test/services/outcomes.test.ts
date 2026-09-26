import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { laneOutcome, latestOutcomes, type RouteRow } from "../../src/domain/route.ts";
import { climb, land, route } from "../../src/services/lane-service.ts";
import { readOutcomes, readRoutes, runPaths } from "../../src/services/run-store.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun, LADDER, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());

const JEV = { pKind: 0.99, pA: 0.9, pB: 0.1, nouls: { mechanical: 0.2 } };
const head = (repo: string) =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

/** Deps whose route answers Track A from Jev, with its question set and probabilities. */
function jevDeps() {
  const deps = fakeDeps();
  deps.routing.route = async () => ({
    rung: LADDER[0] as string,
    ladder: LADDER,
    source: "jev",
    kind: "repo_code",
    difficulty: "build",
    questionSet: "route-v2#0123abcd",
    jev: JEV,
  });
  return deps;
}

const landM1 = (deps: ReturnType<typeof fakeDeps>, run: string, commit: string) =>
  land(deps, { run, milestone: "M1", what: "jobs", commit, evidence: "ok", next: "M2" });

describe("outcomes.jsonl (spec §5.6)", () => {
  it("keeps the question set and Jev's probabilities with the lane's route", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    const r = await route(jevDeps(), { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
    expect(r).toMatchObject({ questionSet: "route-v2#0123abcd", jev: JEV });
    expect(readRoutes(run)[0]).toMatchObject({
      decidedBy: "jev",
      questionSet: "route-v2#0123abcd",
      jev: JEV,
    });
  });

  it("writes one row per routed lane of a landed milestone, excluding environment climbs from start_ok", async () => {
    const { repo, run } = freshRun();
    const deps = jevDeps();
    for (const id of ["M1.L1", "M1.L2", "M2.L1"]) {
      writeLane(run, id, [`src/${id}.ts`]);
      await route(deps, { run: run.id, laneFile: `lanes/${id}.md`, role: "worker" });
    }
    await climb(deps, { run: run.id, lane: "M1.L1", reason: "blocked", evidence: "no database", env: true });
    await climb(deps, { run: run.id, lane: "M1.L2", reason: "check-failed-twice" });
    await landM1(deps, run.id, head(repo));
    const rows = readOutcomes(run);
    expect(rows.map((o) => o.lane)).toEqual(["M1.L1", "M1.L2"]);
    expect(rows[0]).toMatchObject({
      questionSet: "route-v2#0123abcd",
      jevProbs: JEV,
      source: "jev",
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

  it("writes an open row when a lane climbs past its top rung", async () => {
    const { run } = freshRun();
    const deps = jevDeps();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    await route(deps, { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
    for (let i = 0; i < LADDER.length; i++)
      await climb(deps, { run: run.id, lane: "M1.L1", reason: "blocker" });
    const [o] = readOutcomes(run);
    expect(o).toMatchObject({ landed: false, start_ok: false, min_ok_index: null, finalRung: LADDER.at(-1) });
    expect(o?.climbs).toHaveLength(LADDER.length - 1);
  });

  it("keeps a lane's newer row when it is written twice: last row per lane wins", async () => {
    const { repo, run } = freshRun();
    const deps = jevDeps();
    for (const id of ["M1.L1", "M1.L2"]) {
      writeLane(run, id, [`src/${id}.ts`]);
      await route(deps, { run: run.id, laneFile: `lanes/${id}.md`, role: "worker" });
    }
    for (let i = 0; i < LADDER.length; i++)
      await climb(deps, { run: run.id, lane: "M1.L1", reason: "blocker" });
    await landM1(deps, run.id, head(repo));
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
      questionSet: null,
      jevProbs: null,
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
