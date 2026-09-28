import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CatherdError, isCatherdError } from "../../src/domain/errors.ts";
import { assertLaneHeader, LANE_HEADER_FIX } from "../../src/domain/lane.ts";
import { admit } from "../../src/services/admission.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { route } from "../../src/services/lane-service.ts";
import { preflight } from "../../src/services/preflight.ts";
import { snapshotEnv } from "../helpers.ts";
import { simPath, withScenario } from "../sim/scenario.ts";
import { fakeDeps, freshRun, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

async function refused(p: Promise<unknown> | (() => unknown)): Promise<CatherdError> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    if (isCatherdError(e)) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

const header = (kind: string, difficulty: string) =>
  `# M1.L1 — t\nOwns: src/a.ts\nFast check: true\n${kind}${difficulty}`;

describe("lane headers (spec 1.1 §6)", () => {
  it("accepts the catalog's kinds and difficulties, with emphasis and backticks", () => {
    expect(
      assertLaneHeader(header("**Kind:** `ui`\n", "Difficulty: hard\n"), "lanes/M1.L1.md"),
    ).toMatchObject({ kind: "ui", difficulty: "hard" });
  });

  it("refuses an unknown or missing Kind or Difficulty, naming each, with the allowed values as the fix", async () => {
    const e = await refused(() =>
      assertLaneHeader(header("Kind: code\n", "Difficulty: easy\n"), "lanes/M1.L1.md"),
    );
    expect(e.code).toBe("E_LANE_INVALID");
    expect(e.message).toBe(
      'lanes/M1.L1.md: Kind "code" is not one the catalog knows; Difficulty "easy" is not one the catalog knows',
    );
    expect(e.fix).toBe(LANE_HEADER_FIX);
    expect(LANE_HEADER_FIX).toContain("Kind: repo_code|terminal|ui|prose|research");
    expect(LANE_HEADER_FIX).toContain("Difficulty: copy|build|logic|hard");
    const missing = await refused(() => assertLaneHeader(header("", ""), "lanes/M1.L1.md"));
    expect(missing.message).toBe("lanes/M1.L1.md: no Kind: line; no Difficulty: line");
  });

  it("route refuses such a lane before asking anyone", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"], "true", "Kind: code\nDifficulty: easy\n");
    const e = await refused(route(fakeDeps(), { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" }));
    expect(e.code).toBe("E_LANE_INVALID");
  });

  it("dispatch (admission) refuses it", async () => {
    const { run } = freshRun();
    process.env.PATH = simPath();
    Object.assign(process.env, withScenario({}).env);
    writeLane(run, "M1.L1", ["src/a.ts"], "true", "Kind: repo_code\n");
    const e = await refused(
      admit(fakeDeps(), run, {
        role: "worker",
        name: "worker-M1.L1",
        brief: "b",
        rung: "codex:gpt-6-luna#high",
        thread: null,
        lane: "M1.L1",
        failoverFrom: null,
      }),
    );
    expect([e.code, e.message]).toEqual(["E_LANE_INVALID", "lanes/M1.L1.md: no Difficulty: line"]);
  });

  it("preflight refuses before running any check, naming every bad lane", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"], "touch ran-l1");
    writeLane(run, "M1.L2", ["src/b.ts"], "true", "Kind: code\nDifficulty: build\n");
    writeLane(run, "M1.L3", ["src/c.ts"], "true", "Difficulty: build\n");
    const e = await refused(preflight(fakeDeps(), { run: run.id }));
    expect(e.code).toBe("E_LANE_INVALID");
    expect(e.message).toBe(
      'lanes/M1.L2.md: Kind "code" is not one the catalog knows; lanes/M1.L3.md: no Kind: line',
    );
    expect(await Bun.file(`${run.meta.repo}/ran-l1`).exists()).toBe(false);
  });
});
