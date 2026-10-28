import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BLOCKED_LINE } from "../../src/domain/blocked.ts";
import { replyContract } from "../../src/domain/role-prompts.ts";
import { ROLES } from "../../src/domain/roles.ts";
import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { dispatch, watchersSettled } from "../../src/services/dispatch-service.ts";
import { readRoleRoutes, readRoutes } from "../../src/services/run-store.ts";
import { snapshotEnv } from "../helpers.ts";
import { simPath, withScenario } from "../sim/scenario.ts";
import { briefFor, climb, fakeDeps, freshRun, LADDER, route, writeLane } from "./helpers.ts";

afterEach(() => watchersSettled());
afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

const [L0, L1, L2] = LADDER as [string, string, string];
const OK_EVENTS = join(import.meta.dir, "..", "fixtures", "adapters", "codex", "ok-with-reconnect.jsonl");

function setup() {
  const { run } = freshRun();
  process.env.PATH = simPath();
  Object.assign(process.env, withScenario({ eventsFile: OK_EVENTS, reply: "done" }).env);
  writeLane(run, "M1.L1", ["src/a.ts"]);
  return { run, deps: fakeDeps() };
}

describe("the reply contract (spec 1.1 §6)", () => {
  it("ends every role's contract with the STATUS line", () => {
    for (const role of ROLES.filter((r) => r !== "worker"))
      expect(replyContract(role)).toContain(
        "The last line of your reply is: STATUS: complete|partial|blocked|refused — <one line why>",
      );
    // plan 30b: every contract says how to stop, after its STATUS line
    for (const role of ROLES) {
      const c = replyContract(role);
      expect(c).toContain(BLOCKED_LINE);
      expect(c.indexOf(BLOCKED_LINE)).toBeGreaterThan(c.indexOf("STATUS: "));
    }
    // plan 22: a worker stops what it started before replying; plan 23: it may also say flaky, put the
    // environment on an ENV: line, and leaves acceptance built from HEAD to the verifier
    const worker = replyContract("worker");
    expect(worker).toStartWith("Before you reply, leave nothing running");
    expect(worker).toContain("Do not commit. Acceptance items that build from HEAD");
    expect(worker).toContain("add a line ENV: <what>");
    expect(worker).toContain("EXTRA: <path> — <why>");
    expect(worker).toContain(
      "The last line of your reply is: STATUS: complete|partial|blocked|refused|flaky — ",
    );
    expect(replyContract("verifier")).toStartWith(
      "The first line of your reply is VERDICT: PASS or VERDICT: FAIL, or VERDICT: BLOCKED: environment",
    );
  });

  it("dispatch writes it into the brief the role reads", async () => {
    const { run, deps } = setup();
    const s = await dispatch(deps, {
      run: run.id,
      role: "worker",
      name: "worker-M1.L1",
      brief: "Read lanes/M1.L1.md",
      rung: L0,
      lane: "M1.L1",
    });
    const dir = join(run.dir, "roles", "worker-M1.L1", s.dispatched.dispatchId);
    expect(readFileSync(dispatchPaths(dir).brief, "utf8")).toBe(briefFor(run, "Read lanes/M1.L1.md"));
  });
});

describe("dispatch never decides (plan 44 D31)", () => {
  const go = (deps: ReturnType<typeof fakeDeps>, run: { id: string }, over: Record<string, unknown>) =>
    dispatch(deps, {
      run: run.id,
      role: "worker",
      name: "worker-M1.L1",
      brief: "b",
      lane: "M1.L1",
      ...over,
    }).then(
      (s) => s,
      (e: { code?: string }) => e.code ?? String(e),
    );

  it("runs a lane at the rung passed and records it as the coordinator's pick", async () => {
    const { run, deps } = setup();
    const s = await dispatch(deps, {
      run: run.id,
      role: "worker",
      name: "worker-M1.L1",
      brief: "b",
      rung: L1,
      lane: "M1.L1",
    });
    expect(s.dispatched.rung).toBe(L1);
    expect(s.hints).toEqual([]);
    expect(readRoutes(run).map((r) => [r.lane, r.source, r.rung, r.decidedBy])).toEqual([
      ["M1.L1", "route", L1, "orchestrator"],
    ]);
  });

  it("runs a lane without a rung at its current route's, and writes a row only when the rung changes", async () => {
    const { run, deps } = setup();
    await route(deps, { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
    const first = await dispatch(deps, {
      run: run.id,
      role: "worker",
      name: "worker-M1.L1",
      brief: "b",
      lane: "M1.L1",
    });
    expect(first.dispatched.rung).toBe(L0);
    await watchersSettled();
    expect(readRoutes(run)).toHaveLength(1);
    // a climb an earlier catherd made: the lane runs at the rung it gave
    climb(deps, { run: run.id, lane: "M1.L1", reason: "check-failed-twice" });
    const again = await dispatch(deps, {
      run: run.id,
      role: "worker",
      name: "worker-M1.L1-r2",
      brief: "b",
      lane: "M1.L1",
    });
    expect(again.dispatched.rung).toBe(L1);
    await watchersSettled();
    await dispatch(deps, {
      run: run.id,
      role: "worker",
      name: "worker-M1.L1-r3",
      brief: "b",
      rung: L2,
      lane: "M1.L1",
    });
    expect(readRoutes(run).map((r) => [r.source, r.rung, r.decidedBy])).toEqual([
      ["route", L0, "default"],
      ["climb", L1, "default"],
      ["route", L2, "orchestrator"],
    ]);
  });

  it("refuses a lane with no rung and no route, asking the coordinator to pass one", async () => {
    const { run, deps } = setup();
    const err = await dispatch(deps, {
      run: run.id,
      role: "worker",
      name: "worker-M1.L1",
      brief: "b",
      lane: "M1.L1",
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "E_INPUT_INVALID",
      message: "dispatch worker-M1.L1: lane M1.L1 has no rung yet",
    });
    expect((err as { fix: string }).fix).toStartWith("pass rung");
    expect(readRoutes(run)).toEqual([]);
  });

  it("writes no route row for a dispatch admission refuses", async () => {
    const { run, deps } = setup();
    expect(await go(deps, run, { lane: "M1.L9", rung: L0 })).toBe("E_LANE_INVALID");
    deps.profiles.forRepo = () => ({
      ...fakeDeps().profiles.forRepo(run.meta.repo),
      roles: { ...fakeDeps().profiles.forRepo(run.meta.repo).roles, artist: { enabled: false } as never },
    });
    expect(await go(deps, run, { role: "artist", rung: L0 })).toBe("E_ADMIT_RUNG");
    expect(readRoutes(run)).toEqual([]);
  });

  it("refuses a native Claude rung on codex, as admission would", async () => {
    const { run, deps } = setup();
    deps.host = { host: "codex", session: null, conflict: null };
    expect(await go(deps, run, { rung: "claude:claude-opus-5-5#high" })).toBe("E_CONFIG_INVALID");
    expect(readRoutes(run)).toEqual([]);
  });

  it("refuses a role outside a lane with no rung", async () => {
    const { run, deps } = setup();
    const err = await dispatch(deps, {
      run: run.id,
      role: "reviewer",
      name: "reviewer-M1",
      brief: "b",
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "E_INPUT_INVALID",
      message: "dispatch reviewer-M1: a role outside a lane needs a rung",
      fix: "pass rung: the coordinator names the rung of a role outside a lane",
    });
  });

  it("records a lane-less dispatch's rung as the coordinator's", async () => {
    const { run, deps } = setup();
    const rung = deps.view.roles.reviewer?.rungs[0] as string;
    await dispatch(deps, { run: run.id, role: "reviewer", name: "reviewer-M1", brief: "b", rung });
    await dispatch(deps, { run: run.id, role: "worker", name: "worker-spike", brief: "b", rung: L2 });
    expect(readRoleRoutes(run).map((r) => [r.source, r.role, r.name, r.rung, r.decidedBy, r.why])).toEqual([
      ["dispatch", "reviewer", "reviewer-M1", rung, "orchestrator", "the coordinator's rung"],
      ["dispatch", "worker", "worker-spike", L2, "orchestrator", "the coordinator's rung"],
    ]);
    expect(readRoutes(run)).toEqual([]);
  });
});
