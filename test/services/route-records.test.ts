import { afterEach, describe, expect, it } from "bun:test";
import { route, routeLanes } from "../../src/services/lane-service.ts";
import { readRoleRoutes, readRoutes } from "../../src/services/run-store.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun, LADDER, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());

describe("every role's decision in routes.jsonl (spec 1.5 plan 24)", () => {
  it("records a role routed without a lane, with its source, ladder and why, apart from the lanes", async () => {
    const { run } = freshRun();
    const deps = fakeDeps();
    const r = await route(deps, { run: run.id, role: "worker" });
    expect(r).toEqual({
      lane: null,
      role: "worker",
      rung: LADDER[0] as string,
      ladder: LADDER,
      backend: "codex",
      agent: null,
      why: "the role's default rung",
    });
    expect(readRoleRoutes(run)).toEqual([
      {
        at: expect.any(String),
        lane: null,
        role: "worker",
        name: null,
        rung: LADDER[0] as string,
        ladder: LADDER,
        source: "route",
        decidedBy: "default",
        why: "the role's default rung",
      },
    ]);
    // a role's row has no lane to climb: the lane readers never see it
    expect(readRoutes(run)).toEqual([]);
  });

  it("keeps a lane route's provenance, Jev's disagreement, a no-clear line and a tie in its row", async () => {
    const { run } = freshRun();
    const deps = fakeDeps();
    deps.routing.route = async () => ({
      rung: LADDER[1] as string,
      ladder: LADDER.slice(1),
      source: "lane",
      kind: "repo_code",
      difficulty: "hard",
      questionSet: "route-v2#0123abcd",
      jev: null,
      jevSaid: "Jev said repo_code/build",
      noClear: "no rung clears repo_code/hard; best is codex:gpt-6-sol#xhigh (repo_code 66.6 < 70.9)",
      tie: "tie on repo_code with x: started on y; equal headroom",
      why: "the lane's Kind/Difficulty, repo_code/hard; Jev said repo_code/build",
      provenance: { rung: LADDER[1] as string } as never,
    });
    writeLane(run, "M1.L1", ["src/a.ts"]);
    const r = await route(deps, { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
    expect(r.why).toBe("the lane's Kind/Difficulty, repo_code/hard; Jev said repo_code/build");
    expect(readRoutes(run)[0]).toMatchObject({
      lane: "M1.L1",
      decidedBy: "lane",
      jevSaid: "Jev said repo_code/build",
      noClear: expect.stringMatching(/^no rung clears repo_code\/hard; best is /),
      tie: expect.stringMatching(/^tie on repo_code/),
      provenance: { rung: LADDER[1] },
    });
    expect(readRoleRoutes(run)).toEqual([]);
  });
});

describe("batch route through the lane service (spec 1.5 plan 24)", () => {
  it("routes and records each lane in order, in one call to the routing port", async () => {
    const { run } = freshRun();
    const deps = fakeDeps();
    let batches = 0;
    const single = deps.routing.route;
    deps.routing.routeMany = async (reqs) => {
      batches++;
      return Promise.all(reqs.map((r) => single(r)));
    };
    for (const id of ["M1.L1", "M1.L2"]) writeLane(run, id, [`src/${id}.ts`]);
    const out = await routeLanes(deps, {
      run: run.id,
      laneFiles: ["lanes/M1.L1.md", "lanes/M1.L2.md"],
      role: "worker",
    });
    expect(batches).toBe(1);
    expect(out.map((r) => r.lane)).toEqual(["M1.L1", "M1.L2"]);
    expect(readRoutes(run).map((r) => [r.lane, r.source])).toEqual([
      ["M1.L1", "route"],
      ["M1.L2", "route"],
    ]);
  });

  it("refuses a lane named twice, before asking anything", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    const err = await routeLanes(fakeDeps(), {
      run: run.id,
      laneFiles: ["lanes/M1.L1.md", "lanes/M1.L1.md"],
      role: "worker",
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "E_INPUT_INVALID", message: "route: lane M1.L1 is named twice" });
    expect(readRoutes(run)).toEqual([]);
  });

  it("counts a lane routed but not dispatched as a use of its quota", async () => {
    const { run } = freshRun();
    const deps = fakeDeps();
    const seen: Record<string, number>[] = [];
    const single = deps.routing.route;
    deps.routing.route = async (r) => {
      seen.push(r.usage ?? {});
      return single(r);
    };
    for (const id of ["M1.L1", "M1.L2"]) writeLane(run, id, [`src/${id}.ts`]);
    await route(deps, { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
    await route(deps, { run: run.id, laneFile: "lanes/M1.L2.md", role: "worker" });
    expect(seen).toEqual([{}, { codex: 1 }]);
  });
});
