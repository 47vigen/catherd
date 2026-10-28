import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BLOCKED_LINE } from "../../src/domain/blocked.ts";
import { replyContract } from "../../src/domain/role-prompts.ts";
import { ROLES } from "../../src/domain/roles.ts";
import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { dispatch, watchersSettled } from "../../src/services/dispatch-service.ts";
import { snapshotEnv } from "../helpers.ts";
import { simPath, withScenario } from "../sim/scenario.ts";
import { briefFor, fakeDeps, freshRun, LADDER, writeLane } from "./helpers.ts";

afterEach(() => watchersSettled());
afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

const [L0, L1] = LADDER as [string, string, string];
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

describe("dispatch never decides (plan 44 D31, plan 50)", () => {
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

  it("runs a lane at the rung passed, and writes no routes.jsonl", async () => {
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
    expect(existsSync(join(run.dir, "routes.jsonl"))).toBe(false);
  });

  it("refuses a dispatch with no rung, in a lane or not", async () => {
    const { run, deps } = setup();
    for (const over of [{}, { role: "reviewer", name: "reviewer-M1", lane: undefined }]) {
      const err = await dispatch(deps, {
        run: run.id,
        role: "worker",
        name: "worker-M1.L1",
        brief: "b",
        lane: "M1.L1",
        ...over,
      } as never).catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: "E_INPUT_INVALID",
        fix: "pass rung: the coordinator names the rung of every dispatch",
      });
    }
  });

  it("refuses a native Claude rung on codex, as admission would", async () => {
    const { run, deps } = setup();
    deps.host = { host: "codex", session: null, conflict: null };
    expect(await go(deps, run, { rung: "claude:claude-opus-5-5#high" })).toBe("E_CONFIG_INVALID");
  });
});
