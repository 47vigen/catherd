import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replyContract, withReplyContract } from "../../src/domain/role-prompts.ts";
import { ROLES } from "../../src/domain/roles.ts";
import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { dispatch, watchersSettled } from "../../src/services/dispatch-service.ts";
import { route } from "../../src/services/lane-service.ts";
import { readRoutes } from "../../src/services/run-store.ts";
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
});
