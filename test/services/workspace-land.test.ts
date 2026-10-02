import { afterEach, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { admitPath } from "../../src/services/dispatches.ts";
import { land } from "../../src/services/lane-service.ts";
import { landedMilestones } from "../../src/services/milestones.ts";
import { appendAgentRun, appendRecord, runPaths } from "../../src/services/run-store.ts";
import { withWorkspaceAdmission } from "../../src/services/workspace-admission.ts";
import { startWorkspace, startWorkspaceChild } from "../../src/services/workspace-service.ts";
import { workspaceChildren } from "../../src/services/workspace-store.ts";
import { snapshotEnv, tempDir, tempRepo, withHome } from "../helpers.ts";
import { fakeDeps, fakeDispatch, makeRecord } from "./helpers.ts";

afterEach(snapshotEnv());

async function setup() {
  withHome();
  const deps = fakeDeps();
  const repo = tempRepo();
  const { workspace } = await startWorkspace(deps, {
    root: tempDir("catherd-workspace-land-"),
    repos: { app: repo },
    title: "Completion admission",
    aLines: [],
    budget: { tokens: 1 },
    steps: [{ id: "app", repo: "app", title: "App", aLines: [] }],
  });
  await startWorkspaceChild(deps, { workspace: workspace.id, step: "app" });
  const run = workspaceChildren(workspace)[0]!;
  for (const role of ["reviewer", "verifier"])
    appendAgentRun(run, {
      at: new Date(deps.now()).toISOString(),
      name: `${role}-M1`,
      role,
      rung: "claude:claude-opus-5-5#high",
      agent: null,
      totalTokens: 0,
      costUsd: null,
      secs: 0,
      status: "ok",
      lane: null,
    });
  const input = {
    run: run.id,
    milestone: "M1",
    what: "App complete",
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    evidence: "Reviewed and verified",
    next: "Done",
  };
  return { deps, run, input };
}

for (const proc of ["self", "dead"] as const)
  it(`refuses landing with an unrecorded ${proc === "self" ? "live" : "finished"} dispatch`, async () => {
    const { deps, run, input } = await setup();
    await fakeDispatch(run, { lane: null }, { proc });
    await expect(land(deps, input)).rejects.toMatchObject({ code: "E_LAND_GATE" });
    expect(landedMilestones(run)).toEqual([]);
  });

it("waits for concurrent admission and checks its dispatch before landing", async () => {
  const { deps, run, input } = await setup();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const admission = withWorkspaceAdmission(run, deps.now, async () => {
    entered();
    await blocked;
    await fakeDispatch(run, { lane: null }, { proc: "self" });
  });
  await started;
  let settled = false;
  const landing = land(deps, input).then(
    () => {
      settled = true;
      return null;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await Bun.sleep(75);
    expect(settled).toBe(false);
  } finally {
    release();
    await admission;
  }
  expect(await landing).toMatchObject({ code: "E_LAND_GATE" });
  expect(landedMilestones(run)).toEqual([]);
});

it("allows landing after a finished dispatch has been collected", async () => {
  const { deps, run, input } = await setup();
  const dispatch = await fakeDispatch(run, { lane: null }, { proc: "dead" });
  await appendRecord(run, makeRecord({ runId: run.id, dispatchId: dispatch.admit.dispatchId, lane: null }));
  await expect(land(deps, input)).resolves.toHaveProperty("ledger");
  await expect(withWorkspaceAdmission(run, deps.now, async () => true)).rejects.toMatchObject({
    code: "E_INPUT_INVALID",
  });
});

it("refuses landing with corrupted dispatch records", async () => {
  const { deps, run, input } = await setup();
  appendFileSync(runPaths(run.dir).runs, "{broken-record\n");
  await expect(land(deps, input)).rejects.toMatchObject({ code: "E_RUN_CORRUPT" });
  expect(landedMilestones(run)).toEqual([]);
});

it("refuses landing when admitted dispatch metadata cannot be read", async () => {
  const { deps, run, input } = await setup();
  const dispatch = await fakeDispatch(run, { lane: null }, { proc: "dead" });
  writeFileSync(admitPath(dispatch.dir), "{broken-admission");
  await expect(land(deps, input)).rejects.toMatchObject({ code: "E_RUN_CORRUPT" });
  expect(landedMilestones(run)).toEqual([]);
});

it("refuses landing when newer native verdict evidence is unreadable", async () => {
  const { deps, run, input } = await setup();
  appendFileSync(runPaths(run.dir).agents, '{"name":"verifier-M1","status":"failed",broken\n');
  await expect(land(deps, input)).rejects.toMatchObject({ code: "E_RUN_CORRUPT" });
  expect(landedMilestones(run)).toEqual([]);
});

it("allows verified work to land after the shared budget is spent", async () => {
  const { deps, run, input } = await setup();
  appendAgentRun(run, {
    at: new Date(deps.now()).toISOString(),
    name: "research",
    role: "reviewer",
    rung: "claude:claude-opus-5-5#high",
    agent: null,
    totalTokens: 1,
    costUsd: null,
    secs: 0,
    status: "ok",
    lane: null,
  });
  await expect(land(deps, input)).resolves.toHaveProperty("ledger");
  expect(landedMilestones(run)).toEqual(["M1"]);
});
