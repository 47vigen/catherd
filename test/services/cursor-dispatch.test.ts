import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedCursorHome } from "../../src/adapters/cursor/index.ts";
import { replyContract } from "../../src/domain/role-prompts.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { dispatch, type DispatchInput } from "../../src/services/dispatch-service.ts";
import { snapshotEnv } from "../helpers.ts";
import { simPath } from "../sim/scenario.ts";
import { type CursorScenario, withCursorScenario } from "../sim/sim-scenarios.ts";
import { fakeDeps, freshRun, runRole, testView, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "cursor");
const SOL = "cursor:gpt-6-sol#xhigh";

function setup(s: CursorScenario, rungs = [SOL]) {
  const { repo, run } = freshRun();
  process.env.PATH = simPath();
  delete process.env.CURSOR_API_KEY;
  const sim = withCursorScenario({ modelsFile: join(FX, "models.txt"), ...s });
  Object.assign(process.env, sim.env);
  writeLane(run, "M1.L1", ["src/a.ts"]);
  const view = testView();
  view.roles.worker = { enabled: true, access: "workspace-write", rungs };
  return { repo, run, sim, deps: fakeDeps({ view }) };
}

const input = (run: string, over: Partial<DispatchInput> = {}): DispatchInput => ({
  run,
  role: "worker",
  name: "worker-M1.L1",
  brief: "---\nRead lanes/M1.L1.md",
  rung: SOL,
  lane: "M1.L1",
  ...over,
});

describe("dispatch on cursor-agent (simulator)", () => {
  it("runs in the repo with the brief on stdin, the effort as the slug's suffix, and the result's tokens", async () => {
    const { repo, run, sim, deps } = setup({
      eventsFile: join(FX, "ok.jsonl"),
      touch: [{ path: "src/a.ts", content: "new" }],
    });
    const { record } = await runRole(deps, input(run.id));
    expect(record).toMatchObject({
      status: "ok",
      backend: "cursor",
      tokens: { input: 15989, cached: 9728, output: 25 },
      changedOwned: ["src/a.ts"],
      cliVersion: "2026.09.28",
    });
    expect(record.thread).toMatch(/^[0-9a-f-]{36}$/);
    expect(sim.recorded()).toMatchObject({
      stdin: `---\nRead lanes/M1.L1.md\n\n${replyContract("worker")}\n`,
    });
    expect(sim.recorded().args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--trust",
      "--workspace",
      repo,
      "--model",
      "gpt-6-sol-xhigh",
      "--disable-auto-update",
      "--sandbox",
      "enabled",
    ]);
    expect(sim.recorded().vars?.NO_OPEN_BROWSER).toBe("1");
  });

  it("refuses an effort Cursor does not list before anything runs", async () => {
    const { run, sim, deps } = setup({ eventsFile: join(FX, "ok.jsonl") }, ["cursor:gpt-6-sol#medium"]);
    const e = await dispatch(deps, input(run.id, { rung: "cursor:gpt-6-sol#medium" })).catch(
      (x: unknown) => x,
    );
    expect((e as { code?: string }).code).toBe("E_BACKEND_MODEL_UNKNOWN");
    expect(sim.ran()).toBe(false);
  });

  it("refuses an isolated run without CURSOR_API_KEY, and runs one with it under its own HOME", async () => {
    const { run, sim, deps } = setup({ eventsFile: join(FX, "ok.jsonl") });
    deps.view.isolated = { cursor: true };
    const e = await dispatch(deps, input(run.id)).catch((x: unknown) => x);
    expect((e as { code?: string }).code).toBe("E_BACKEND_NOT_LOGGED_IN");
    expect(sim.ran()).toBe(false);
    process.env.CURSOR_API_KEY = "k";
    const { record } = await runRole(deps, input(run.id, { name: "worker-M1.L1b" }));
    const home = isolatedCursorHome("workspace-write");
    expect(record).toMatchObject({ status: "ok", isolated: true });
    expect(sim.recorded().home).toBe(home);
    expect(JSON.parse(readFileSync(join(home, ".cursor", "sandbox.json"), "utf8"))).toMatchObject({
      type: "workspace_readwrite",
    });
    expect(existsSync(join(home, ".cursor", "chats"))).toBe(true);
  });

  it("records a usage limit as a limit, so failover can move the role", async () => {
    const { run, deps } = setup({
      eventsFile: join(FX, "no-result.jsonl"),
      exitCode: 1,
      stderr: "ActionRequiredError: You've hit your usage limit (PRO_USER_USAGE_LIMIT)\n",
    });
    const { record } = await runRole(deps, input(run.id));
    expect(record.status).toBe("limit");
  });
});
