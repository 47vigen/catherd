import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentsDir, isolatedConfigRoot } from "../../src/adapters/opencode/agents.ts";
import { opencodeShell } from "../../src/adapters/opencode/index.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { dispatch, type DispatchInput } from "../../src/services/dispatch-service.ts";
import { readRecords } from "../../src/services/run-store.ts";
import { snapshotEnv } from "../helpers.ts";
import { simPath } from "../sim/scenario.ts";
import { type OpencodeModel, type OpencodeScenario, withOpencodeScenario } from "../sim/sim-scenarios.ts";
import { fakeDeps, freshRun, testView, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => {
  resetReadiness();
  opencodeShell.retryDelayMs = 0;
});

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "opencode");
const MODELS = JSON.parse(readFileSync(join(FX, "models.json"), "utf8")).data as OpencodeModel[];
const GO = "opencode:opencode-go/kimi-k3#max";
const ZEN = "opencode:opencode/kimi-k3#max";
const TOTALS = {
  cost: 0.12,
  tokens: { input: 7000, output: 60, reasoning: 40, cache: { read: 3000, write: 0 } },
  outcome: "succeeded",
};

function setup(s: OpencodeScenario, rungs = [GO]) {
  const { repo, run } = freshRun();
  process.env.PATH = simPath();
  const sim = withOpencodeScenario({ models: MODELS, session: TOTALS, ...s });
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
  rung: GO,
  lane: "M1.L1",
  ...over,
});

describe("dispatch on opencode v2 (simulator)", () => {
  it("works in the repo through PWD, with the brief on stdin, totals from the API and the last message as reply", async () => {
    const { repo, run, sim, deps } = setup({
      eventsFile: join(FX, "shell-ok.jsonl"),
      touch: [{ path: "src/a.ts", content: "new" }],
    });
    const { record } = await dispatch(deps, input(run.id));
    expect(record).toMatchObject({
      status: "ok",
      backend: "opencode",
      thread: "ses_f2671cde4ffe4VbeG6dKWzM2vi",
      tokens: { input: 10000, cached: 3000, output: 100 },
      costUsd: 0.12,
      changedOwned: ["src/a.ts"],
      cliVersion: "2.0.16",
    });
    expect(sim.recorded()).toMatchObject({ stdin: "---\nRead lanes/M1.L1.md", pwd: repo });
    expect(sim.recorded().args).toEqual([
      "run",
      "--format",
      "json",
      "--auto",
      "--agent",
      "catherd-worker",
      "-m",
      "opencode-go/kimi-k3#max",
    ]);
    expect(readFileSync(join(repo, "src/a.ts"), "utf8")).toBe("new");
  });

  it("fails a Go limit over to the same model on Zen, on a fresh thread, with no failover in the profile", async () => {
    const { run, deps } = setup({
      byModel: {
        "opencode-go/kimi-k3#max": { eventsFile: join(FX, "quota.jsonl"), exitCode: 1 },
        "opencode/kimi-k3#max": { eventsFile: join(FX, "shell-ok.jsonl") },
      },
    });
    const { record, hints } = await dispatch(deps, input(run.id));
    expect(record).toMatchObject({ status: "ok", rung: ZEN, failoverFrom: GO, attempt: 2 });
    expect(hints[0]).toBe(`limit: ${GO} hit a usage limit; failed over to ${ZEN}`);
    expect(readRecords(run).records.map((r) => [r.rung, r.status])).toEqual([
      [GO, "limit"],
      [ZEN, "ok"],
    ]);
  });

  it("refuses a variant the model does not have before anything runs", async () => {
    const { run, sim, deps } = setup({ eventsFile: join(FX, "shell-ok.jsonl") }, [
      "opencode:opencode/big-pickle#high",
    ]);
    const e = await dispatch(deps, input(run.id, { rung: "opencode:opencode/big-pickle#high" })).catch(
      (x: unknown) => x,
    );
    expect((e as { code?: string }).code).toBe("E_BACKEND_MODEL_UNKNOWN");
    expect(sim.ran()).toBe(false);
  });

  it("runs an isolated role on a standalone server that reads catherd's own agents", async () => {
    const { run, sim, deps } = setup({ eventsFile: join(FX, "ok-simple.jsonl") });
    deps.view.isolated = { opencode: true };
    const { record } = await dispatch(deps, input(run.id));
    expect(record).toMatchObject({ status: "ok", isolated: true });
    expect(sim.recorded().args).toContain("--standalone");
    expect(sim.recorded().xdgConfig).toBe(isolatedConfigRoot());
    expect(existsSync(join(agentsDir(isolatedConfigRoot()), "catherd-worker.md"))).toBe(true);
  });

  it("stops a run that goes quiet while the API says nothing, as a timeout, and interrupts its session", async () => {
    const interrupts = join(mkdtempSync(join(tmpdir(), "catherd-int-")), "ids");
    const { run, deps } = setup({
      eventsFile: join(FX, "ok-simple.jsonl"),
      hangMs: 30_000,
      active: {},
      interruptsTo: interrupts,
    });
    deps.view.timeouts = { idleMin: 0.01, wallMin: 5 };
    const { record } = await dispatch(deps, input(run.id));
    expect(record.status).toBe("timeout");
    expect(readFileSync(interrupts, "utf8")).toBe("ses_f2679cc68ffeAfP2dtLA9zEfTh\n");
  }, 30_000);
});
