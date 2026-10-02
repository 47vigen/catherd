import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replyContract, withReplyContract } from "../../src/domain/role-prompts.ts";
import { ROLES } from "../../src/domain/roles.ts";
import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { dispatch, watchersSettled } from "../../src/services/dispatch-service.ts";
import { climb, route } from "../../src/services/lane-service.ts";
import { readRoleRoutes, readRoutes } from "../../src/services/run-store.ts";
import { snapshotEnv } from "../helpers.ts";
import { simPath, withScenario } from "../sim/scenario.ts";
import { briefFor, fakeDeps, freshRun, LADDER, writeLane } from "./helpers.ts";

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
      expect(replyContract(role)).toEndWith(
        "The last line of your reply is: STATUS: complete|partial|blocked|refused — <one line why>",
      );
    // plan 22: a worker stops what it started before replying; plan 23: it may also say flaky, put the
    // environment on an ENV: line, and leaves acceptance built from HEAD to the verifier
    const worker = replyContract("worker");
    expect(worker).toStartWith("Before you reply, leave nothing running");
    expect(worker).toContain("Do not commit. Acceptance items that build from HEAD");
    expect(worker).toContain("add a line ENV: <what>");
    expect(worker).toContain(
      "The last line of your reply is: STATUS: complete|partial|blocked|refused|flaky — ",
    );
    expect(replyContract("verifier")).toStartWith(
      "The first line of your reply is VERDICT: PASS or VERDICT: FAIL, or VERDICT: BLOCKED: environment",
    );
  });

  it("appends it once, as the brief's last paragraph", () => {
    const once = withReplyContract("reviewer", "Review M1.\n\n");
    expect(once).toBe(`Review M1.\n\n${replyContract("reviewer")}\n`);
    expect(withReplyContract("reviewer", once)).toBe(once);
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

describe("dispatch routes an unrouted lane first (spec 1.1 §6)", () => {
  it("routes it, and keeps the caller's rung when the routed ladder holds it", async () => {
    const { run, deps } = setup();
    const s = await dispatch(deps, {
      run: run.id,
      role: "worker",
      name: "worker-M1.L1",
      brief: "b",
      rung: L1,
      lane: "M1.L1",
    });
    expect(readRoutes(run).map((r) => [r.lane, r.source, r.rung])).toEqual([["M1.L1", "route", L0]]);
    expect(s.dispatched.rung).toBe(L1);
    expect(s.hints).toEqual([]);
  });

  it("starts at the routed rung, with a hint, when the caller's rung is off the routed ladder", async () => {
    const { run, deps } = setup();
    deps.view.roles.worker = {
      enabled: true,
      access: "workspace-write",
      rungs: [...LADDER, "codex:gpt-6-luna#low"],
    };
    deps.routing.route = async () => ({
      rung: L1,
      ladder: LADDER.slice(1),
      source: "lane",
      kind: "repo_code",
      difficulty: "logic",
      questionSet: null,
      jev: null,
      jevSaid: null,
      why: "the lane's Kind/Difficulty, repo_code/logic",
    });
    const s = await dispatch(deps, {
      run: run.id,
      role: "worker",
      name: "worker-M1.L1",
      brief: "b",
      rung: "codex:gpt-6-luna#low",
      lane: "M1.L1",
    });
    expect(s.dispatched.rung).toBe(L1);
    expect(s.hints).toContain(`codex:gpt-6-luna#low is not on M1.L1's routed ladder: dispatched at ${L1}`);
  });

  it("on codex, routes an off-ladder native Claude rung to a runnable one instead of refusing it", async () => {
    const { run, deps } = setup();
    deps.host = { host: "codex", session: null, conflict: null };
    const s = await dispatch(deps, {
      run: run.id,
      role: "worker",
      name: "worker-M1.L1",
      brief: "b",
      rung: "claude:claude-opus-5-5#high",
      lane: "M1.L1",
    });
    expect(s.dispatched.rung).toBe(L0);
    expect(s.hints).toContain(
      `claude:claude-opus-5-5#high is not on M1.L1's routed ladder: dispatched at ${L0}`,
    );
  });

  it("does not route a lane again, nor a role without a lane", async () => {
    const { run, deps } = setup();
    await route(deps, { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
    await dispatch(deps, {
      run: run.id,
      role: "worker",
      name: "worker-M1.L1",
      brief: "b",
      rung: L2,
      lane: "M1.L1",
    });
    await dispatch(deps, {
      run: run.id,
      role: "reviewer",
      name: "reviewer-M1",
      brief: "b",
      rung: "codex:gpt-6-sol#high",
    });
    expect(readRoutes(run)).toHaveLength(1);
  });

  it("refuses what admission would refuse before routing: no Jev call, no route row (1.1 follow-ups)", async () => {
    const { run, deps } = setup();
    let asked = 0;
    const routeOf = deps.routing.route;
    deps.routing.route = (q) => {
      asked++;
      return routeOf(q);
    };
    const go = (over: Record<string, unknown>) =>
      dispatch(deps, {
        run: run.id,
        role: "worker",
        name: "w",
        brief: "b",
        rung: L0,
        lane: "M1.L1",
        ...over,
      }).then(
        () => "ok",
        (e: { code?: string }) => e.code ?? String(e),
      );
    expect(await go({ lane: "M1.L9" })).toBe("E_LANE_INVALID");
    deps.profiles.forRepo = () => ({
      ...fakeDeps().profiles.forRepo(run.meta.repo),
      roles: { ...fakeDeps().profiles.forRepo(run.meta.repo).roles, artist: { enabled: false } as never },
    });
    expect(await go({ role: "artist" })).toBe("E_ADMIT_RUNG");
    expect([asked, readRoutes(run)]).toEqual([0, []]);
  });

  it("routes a lane once when two dispatches of it start together", async () => {
    const { run, deps } = setup();
    writeLane(run, "M1.L2", ["src/b.ts"]);
    let asked = 0;
    const routeOf = deps.routing.route;
    deps.routing.route = async (q) => {
      asked++;
      await Bun.sleep(0);
      return routeOf(q);
    };
    const one = (name: string) =>
      dispatch(deps, { run: run.id, role: "worker", name, brief: "b", rung: L0, lane: "M1.L2" }).then(
        () => "ok",
        (e: { code?: string }) => e.code ?? String(e),
      );
    const outcomes = await Promise.all([one("worker-M1.L2"), one("worker-M1.L2-again")]);
    expect(asked).toBe(1);
    expect(readRoutes(run).filter((r) => r.lane === "M1.L2")).toHaveLength(1);
    // the second is then refused for the lane the first runs, as before
    expect(outcomes.sort()).toEqual(["E_ADMIT_OVERLAP", "ok"]);
  });
});

describe("dispatch takes rung optionally on a lane (spec 1.5 plan 24)", () => {
  it("routes an unrouted lane and runs it at the routed rung, then at the rung its climb gave", async () => {
    const { run, deps } = setup();
    const first = await dispatch(deps, {
      run: run.id,
      role: "worker",
      name: "worker-M1.L1",
      brief: "b",
      lane: "M1.L1",
    });
    expect(first.dispatched.rung).toBe(L0);
    expect(first.hints).toEqual([]);
    await watchersSettled();
    await climb(deps, { run: run.id, lane: "M1.L1", reason: "check-failed-twice" });
    const again = await dispatch(deps, {
      run: run.id,
      role: "worker",
      name: "worker-M1.L1-r2",
      brief: "b",
      lane: "M1.L1",
    });
    expect(again.dispatched.rung).toBe(L1);
  });

  it("refuses a role outside a lane with no rung, naming route", async () => {
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
      fix: 'route(run, role: "reviewer") gives the role\'s rung; pass it as rung',
    });
  });

  it("records a lane-less dispatch's rung, and whether route or the coordinator chose it", async () => {
    const { run, deps } = setup();
    await route(deps, { run: run.id, role: "reviewer" });
    const routed = deps.view.roles.reviewer?.rungs[0] as string;
    await dispatch(deps, { run: run.id, role: "reviewer", name: "reviewer-M1", brief: "b", rung: routed });
    await dispatch(deps, { run: run.id, role: "worker", name: "worker-spike", brief: "b", rung: L2 });
    expect(readRoleRoutes(run).map((r) => [r.source, r.role, r.name, r.rung, r.decidedBy, r.why])).toEqual([
      ["route", "reviewer", null, routed, "default", "the role's default rung"],
      ["dispatch", "reviewer", "reviewer-M1", routed, "default", "the rung route gave the reviewer"],
      [
        "dispatch",
        "worker",
        "worker-spike",
        L2,
        "orchestrator",
        "the coordinator's rung; the worker was never routed",
      ],
    ]);
    expect(readRoutes(run)).toEqual([]);
  });
});
