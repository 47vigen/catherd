import { afterEach, beforeEach, expect, it } from "bun:test";
import { admit, type AdmitInput } from "../../src/services/admission.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { appendRecord, createRun } from "../../src/services/run-store.ts";
import { startWorkspace, startWorkspaceChild } from "../../src/services/workspace-service.ts";
import { workspaceChildren } from "../../src/services/workspace-store.ts";
import { snapshotEnv, tempDir, tempRepo, withHome } from "../helpers.ts";
import { simPath, withScenario } from "../sim/scenario.ts";
import { fakeDeps, makeRecord, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());
beforeEach(resetReadiness);

const input: AdmitInput = {
  role: "worker",
  name: "worker-M1.L1",
  brief: "Read the lane dossier",
  rung: "codex:gpt-6-luna#high",
  thread: null,
  lane: "M1.L1",
  failoverFrom: null,
};

it("actual child dispatch admission enforces sibling spend without a parent-tool preflight", async () => {
  withHome();
  const deps = fakeDeps();
  const { workspace } = await startWorkspace(deps, {
    root: tempDir("catherd-dispatch-workspace-"),
    repos: { a: tempRepo(), b: tempRepo() },
    title: "Direct admission",
    aLines: ["Shared budget"],
    budget: { tokens: 100 },
    steps: [
      { id: "a", repo: "a", title: "A", aLines: [] },
      { id: "b", repo: "b", title: "B", aLines: [] },
    ],
  });
  await startWorkspaceChild(deps, { workspace: workspace.id, step: "a" });
  await startWorkspaceChild(deps, { workspace: workspace.id, step: "b" });
  const children = workspaceChildren(workspace);
  const a = children.find((r) => r.meta.workspace?.step === "a")!;
  const b = children.find((r) => r.meta.workspace?.step === "b")!;
  writeLane(b, "M1.L1", ["src/a.ts"]);
  await appendRecord(a, makeRecord({ runId: a.id, tokens: { input: 100, cached: 0, output: 0 } }));
  process.env.PATH = simPath();
  Object.assign(process.env, withScenario({}).env);
  await expect(admit(deps, b, input)).rejects.toMatchObject({ code: "E_RUN_BUDGET" });
});

it("actual admission cannot bypass dependencies with a recovered linked child", async () => {
  withHome();
  const deps = fakeDeps();
  const repos = { a: tempRepo(), b: tempRepo() };
  const { workspace } = await startWorkspace(deps, {
    root: tempDir("catherd-dependency-admit-"),
    repos,
    title: "Dependencies",
    aLines: ["Producer first"],
    steps: [
      { id: "a", repo: "a", title: "A", aLines: [] },
      { id: "b", repo: "b", title: "B", aLines: [], dependsOn: ["a"] },
    ],
  });
  const recovered = createRun({
    repo: repos.b,
    title: "Recovered B",
    aLines: [],
    version: "test",
    workspace: { id: workspace.id, step: "b" },
  });
  writeLane(recovered, "M1.L1", ["src/a.ts"]);
  process.env.PATH = simPath();
  Object.assign(process.env, withScenario({}).env);
  await expect(admit(deps, recovered, input)).rejects.toMatchObject({ code: "E_INPUT_INVALID" });
});
