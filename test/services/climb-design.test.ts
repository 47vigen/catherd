import { afterEach, describe, expect, it } from "bun:test";
import { isCatherdError } from "../../src/domain/errors.ts";
import { climb, route } from "../../src/services/lane-service.ts";
import { readRoutes } from "../../src/services/run-store.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun, LADDER, testView, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());

async function routed(jev: "auto" | "off" = "auto") {
  const { run } = freshRun();
  writeLane(run, "M1.L1", ["src/a.ts"]);
  const deps = fakeDeps({ view: testView({ jev: { use: jev } }) });
  const asked: string[] = [];
  deps.routing.finding = async (_dir, _lane, finding) => {
    asked.push(finding);
    return {
      value: finding.includes("plan says") ? "design" : "code",
      probability: 0.9,
      confidence: null,
      source: "jev",
    };
  };
  await route(deps, { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
  return { run, deps, asked };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "climbed";
  } catch (e) {
    if (isCatherdError(e)) return `${e.code}: ${e.fix}`;
    throw e;
  }
}

const REFUSED = "E_CLIMB_DESIGN: send it to the architect (ask/architect delta), not up the ladder";

describe("climb only for capability (spec 1.1 §9)", () => {
  it("refuses a climb Jev calls a design finding, and records nothing", async () => {
    const { run, deps, asked } = await routed();
    const evidence = "the plan says M1.L1 returns a list, M1.L2 expects a map";
    expect(await code(climb(deps, { run: run.id, lane: "M1.L1", reason: "blocker", evidence }))).toBe(
      REFUSED,
    );
    expect(asked).toEqual([evidence]);
    expect(readRoutes(run).filter((r) => r.source === "climb")).toEqual([]);
  });

  it("climbs when Jev calls it code, and without evidence asks nothing", async () => {
    const { run, deps, asked } = await routed();
    const r = await climb(deps, {
      run: run.id,
      lane: "M1.L1",
      reason: "blocker",
      evidence: "off by one in parse()",
    });
    expect(r.rung).toBe(LADDER[1] as string);
    await climb(deps, { run: run.id, lane: "M1.L1", reason: "check-failed-twice" });
    expect(asked).toEqual(["off by one in parse()"]);
  });

  it("refuses ownership evidence on a blocked climb without Jev, and never asks Jev when it is off", async () => {
    const { run, deps, asked } = await routed("off");
    for (const evidence of ["needs src/b.ts, outside lane ownership", "src/b.ts is owned by M1.L2"])
      expect(await code(climb(deps, { run: run.id, lane: "M1.L1", reason: "blocked", evidence }))).toBe(
        REFUSED,
      );
    expect(
      await code(
        climb(deps, { run: run.id, lane: "M1.L1", reason: "blocked", evidence: "the plan says so" }),
      ),
    ).toBe("climbed");
    expect(asked).toEqual([]);
  });

  it("refuses a climb of an unrouted lane before asking Jev anything", async () => {
    const { run, deps, asked } = await routed();
    writeLane(run, "M1.L2", ["src/b.ts"]);
    const e = await code(
      climb(deps, { run: run.id, lane: "M1.L2", reason: "blocker", evidence: "the plan says a map" }),
    );
    expect(e).toStartWith("E_LANE_INVALID: ");
    expect(asked).toEqual([]);
  });

  it("never refuses a climb the environment caused", async () => {
    const { run, deps, asked } = await routed();
    const r = await climb(deps, {
      run: run.id,
      lane: "M1.L1",
      reason: "blocked",
      evidence: "docker socket owned by root",
      env: true,
    });
    expect(r.top).toBe(false);
    expect(asked).toEqual([]);
  });
});
