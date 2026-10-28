import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CatherdError, isCatherdError } from "../../src/domain/errors.ts";
import { assertLaneHeader, LANE_HEADER_FIX } from "../../src/domain/lane.ts";
import { admit } from "../../src/services/admission.ts";
import { resetReadiness } from "../../src/services/backends.ts";
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

  it("a Chore value other than yes or no is refused", async () => {
    const e = await refused(() =>
      assertLaneHeader(header("Kind: ui\n", "Difficulty: hard\nChore: maybe\n"), "lanes/M1.L1.md"),
    );
    expect(e.code).toBe("E_LANE_INVALID");
    expect(e.message).toContain('Chore "maybe"');
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
});
