import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { dispatch, type DispatchInput } from "../../src/services/dispatch-service.ts";
import { latestDispatch } from "../../src/services/dispatches.ts";
import { snapshotEnv } from "../helpers.ts";
import { simPath } from "../sim/scenario.ts";
import { type ClaudeScenario, withClaudeScenario } from "../sim/sim-scenarios.ts";
import { fakeDeps, freshRun, testView, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "claude-code");
const RUNG = "claude-code:claude-sonnet-5#high";

function setup(s: ClaudeScenario) {
  const { repo, run } = freshRun();
  process.env.PATH = simPath();
  const sim = withClaudeScenario(s);
  Object.assign(process.env, sim.env);
  writeLane(run, "M1.L1", ["src/a.ts"]);
  const view = testView();
  view.roles.worker = { enabled: true, access: "workspace-write", rungs: [RUNG] };
  return { repo, run, sim, deps: fakeDeps({ view }) };
}

const input = (run: string, over: Partial<DispatchInput> = {}): DispatchInput => ({
  run,
  role: "worker",
  name: "worker-M1.L1",
  brief: "---\nRead lanes/M1.L1.md",
  rung: RUNG,
  lane: "M1.L1",
  ...over,
});

describe("dispatch on claude-code (simulator)", () => {
  it("runs headless to a record with the session, tokens, cost and the streamed reply", async () => {
    const { repo, run, sim, deps } = setup({
      eventsFile: join(FX, "retry.jsonl"),
      touch: [{ path: "src/a.ts", content: "new" }],
    });
    const { record, hints } = await dispatch(deps, input(run.id));
    const seen = sim.recorded();
    const session = seen.args[seen.args.indexOf("--session-id") + 1];
    expect(record).toMatchObject({
      status: "ok",
      backend: "claude-code",
      thread: session,
      tokens: { input: 20912, cached: 20000, output: 14 },
      costUsd: 0.0142,
      changedOwned: ["src/a.ts"],
      replyStatus: "complete",
      replyWhy: "retried once",
      cliVersion: "2.1.282",
    });
    expect(hints).toEqual([]);
    expect(seen).toMatchObject({ stdin: "---\nRead lanes/M1.L1.md", cwd: repo, pwd: repo });
    const d = latestDispatch(run, "worker-M1.L1");
    expect(readFileSync(dispatchPaths(d?.dir ?? "").reply, "utf8")).toBe(
      "Done.\nSTATUS: complete — retried once",
    );
  });

  it("resumes a fix round on the same session", async () => {
    const thread = "670d1ec2-db2b-471f-a1a5-3cda1416c061";
    const { run, sim, deps } = setup({ eventsFile: join(FX, "resume.jsonl") });
    const { record } = await dispatch(deps, input(run.id, { thread, brief: "Fix: BUG src/a.ts:1" }));
    expect(record).toMatchObject({ status: "ok", thread });
    expect(sim.recorded().args).toContain("--resume");
  });

  it("records a usage limit as limit and pauses the run, having no stand-in", async () => {
    const { run, deps } = setup({ eventsFile: join(FX, "limit.jsonl"), exitCode: 1 });
    const { record, hints } = await dispatch(deps, input(run.id));
    expect(record.status).toBe("limit");
    expect(hints.join("\n")).toContain("limit");
  });

  it("refuses an alias rung at admission, before anything runs", async () => {
    const { run, sim, deps } = setup({ eventsFile: join(FX, "ok.jsonl") });
    deps.view.roles.worker = { enabled: true, access: "workspace-write", rungs: ["claude-code:opus#high"] };
    const e = await dispatch(deps, input(run.id, { rung: "claude-code:opus#high" })).catch((x: unknown) => x);
    expect((e as { code?: string }).code).toBe("E_BACKEND_MODEL_UNKNOWN");
    expect(sim.ran()).toBe(false);
  });
});
