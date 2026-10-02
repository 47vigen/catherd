import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedGrokRoot } from "../../src/adapters/grok/index.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { dispatch, type DispatchInput } from "../../src/services/dispatch-service.ts";
import { snapshotEnv, tempDir } from "../helpers.ts";
import { simPath } from "../sim/scenario.ts";
import { type GrokScenario, withGrokScenario } from "../sim/sim-scenarios.ts";
import { briefFor, fakeDeps, freshRun, runRole, testView, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "grok");
const RUNG = "grok:grok-4.6#high";

function setup(s: GrokScenario) {
  const { repo, run } = freshRun();
  process.env.PATH = simPath();
  // the user's GROK_HOME, where a native workspace-write run needs catherd-ws: never the real ~/.grok
  process.env.GROK_HOME = tempDir("catherd-grokhome-");
  writeFileSync(join(process.env.GROK_HOME, "auth.json"), "{}"); // the simulator's Grok login
  delete process.env.XAI_API_KEY;
  const sim = withGrokScenario({ ...s });
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

const code = (p: Promise<unknown>) => p.then(() => "ok").catch((e: { code?: string }) => e.code);

describe("dispatch on grok (simulator)", () => {
  it("runs in the repo with the brief by file, catherd's session id as the thread, and end's tokens and cost", async () => {
    const { repo, run, sim, deps } = setup({
      eventsFile: join(FX, "ok.jsonl"),
      touch: [{ path: "src/a.ts", content: "new" }],
    });
    const { record } = await runRole(deps, input(run.id));
    const args = sim.recorded().args;
    const session = args[args.indexOf("-s") + 1] as string;
    expect(record).toMatchObject({
      status: "ok",
      backend: "grok",
      thread: session,
      tokens: { input: 48210, cached: 41000, output: 1893 },
      costUsd: 0.0127,
      changedOwned: ["src/a.ts"],
      cliVersion: "1.0.44",
    });
    expect(sim.recorded().stdin).toBe(briefFor(run, "---\nRead lanes/M1.L1.md", { backend: "grok" }));
    expect(args.slice(0, -2)).toEqual([
      "--prompt-file",
      args[1] as string,
      "--output-format",
      "streaming-json",
      "--cwd",
      repo,
      "-m",
      "grok-4.6",
      "--effort",
      "high",
      "--always-approve",
      "--trust",
      "--no-auto-update",
      "--no-memory",
      "--sandbox",
      "catherd-ws",
    ]);
    expect(sim.recorded().vars?.GROK_DISABLE_AUTOUPDATER).toBe("1");
    const toml = readFileSync(join(process.env.GROK_HOME as string, "sandbox.toml"), "utf8");
    expect(toml).toContain("[profiles.catherd-ws]");
  });

  it("resumes a session on the access it started with, and refuses another before anything runs", async () => {
    const { run, sim, deps } = setup({ eventsFile: join(FX, "ok.jsonl") });
    const first = (await runRole(deps, input(run.id))).record;
    sim.rewrite({ eventsFile: join(FX, "resume.jsonl"), sessionSandbox: "catherd-ws" });
    const again = await runRole(deps, input(run.id, { thread: first.thread ?? "" }));
    expect(again.record).toMatchObject({ status: "ok", thread: first.thread });
    expect(sim.recorded().args.slice(-2)).toEqual(["-r", first.thread as string]);
    expect(sim.recorded().args).not.toContain("--sandbox");
    // spec 1.3 §3.2: grok refuses another sandbox on resume, so admission refuses it first
    deps.view.roles.worker = { enabled: true, access: "read-only", rungs: [RUNG] };
    expect(await code(dispatch(deps, input(run.id, { thread: first.thread ?? "" })))).toBe("E_ADMIT_THREAD");
  });

  it("refuses an isolated run without XAI_API_KEY, and runs one with it under catherd's HOME", async () => {
    const { run, sim, deps } = setup({ eventsFile: join(FX, "ok.jsonl"), loggedIn: false });
    deps.view.isolated = { grok: true };
    expect(await code(dispatch(deps, input(run.id)))).toBe("E_BACKEND_NOT_LOGGED_IN");
    expect(sim.ran()).toBe(false);
    process.env.XAI_API_KEY = "key-for-test";
    const { record } = await runRole(deps, input(run.id, { name: "worker-M1.L1b" }));
    expect(record).toMatchObject({ status: "ok", isolated: true });
    expect(sim.recorded()).toMatchObject({
      home: isolatedGrokRoot(),
      vars: {
        GROK_HOME: join(isolatedGrokRoot(), ".grok"),
        GROK_MEMORY: "0",
        GROK_CLAUDE_HOOKS_ENABLED: "0",
      },
    });
    expect(readFileSync(join(isolatedGrokRoot(), ".grok", "sandbox.toml"), "utf8")).toContain(
      "[profiles.catherd-ws]",
    );
  });

  it("records a plan's rate limit as a limit, so failover can move the role", async () => {
    const { run, deps } = setup({ eventsFile: join(FX, "rate-limit.jsonl"), exitCode: 1 });
    const { record } = await runRole(deps, input(run.id));
    expect(record.status).toBe("limit");
  });
});
