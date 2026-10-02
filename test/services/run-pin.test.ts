import { afterEach, beforeEach, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { admit } from "../../src/services/admission.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { pinChanges, readPin, repin, runProfile } from "../../src/services/run-pin.ts";
import { startRun } from "../../src/services/run-service.ts";
import { findRun, runPaths } from "../../src/services/run-store.ts";
import { refreshState } from "../../src/services/state.ts";
import { summarizeRun } from "../../src/services/summary.ts";
import { snapshotEnv } from "../helpers.ts";
import { simPath, withScenario } from "../sim/scenario.ts";
import { fakeDeps, freshRun, testView, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());
beforeEach(resetReadiness);

async function pinnedRun() {
  const { repo } = freshRun();
  const deps = fakeDeps();
  const started = await startRun(deps, { repo, title: "pinned", aLines: ["A1 it works"] });
  return { deps, run: findRun(started.run) };
}

it("run_start pins the profile, each role's access and each backend's isolation", async () => {
  const { run } = await pinnedRun();
  expect(readPin(run)).toMatchObject({
    profile: "test",
    access: { worker: "workspace-write", reviewer: "read-only" },
    isolated: {},
  });
});

it("keeps the pinned values when the repo's profile changes, and says what changed", async () => {
  const { deps, run } = await pinnedRun();
  const pinned = testView();
  // the owner switched the active profile and turned isolation on while the run was paused
  Object.assign(deps.view, {
    name: "just-claude",
    isolated: { codex: true },
    roles: { ...deps.view.roles, worker: { ...deps.view.roles.worker!, access: "full" } },
  });
  deps.profiles.get = (name) => ({
    active: "just-claude",
    here: "just-claude",
    profiles: ["test", "just-claude"],
    profile: name === "test" ? pinned : deps.view,
    enforcement: {},
  });
  expect(pinChanges(deps, run)).toEqual([
    "profile: pinned test, the repo now runs on just-claude",
    "worker access: pinned workspace-write, now full",
    "codex isolated: pinned false, now true",
  ]);
  const view = runProfile(deps, run);
  expect(view.name).toBe("test");
  expect(view.roles.worker?.access).toBe("workspace-write");
  expect(view.isolated.codex === true).toBe(false);
  expect(summarizeRun(deps, run).warnings).toContainEqual(
    "pinned: codex isolated: pinned false, now true; dispatch keeps the pinned value (run_pin re-pins)",
  );
  // a dispatch admitted now runs on the pinned access and isolation
  process.env.PATH = simPath();
  Object.assign(process.env, withScenario({}).env);
  writeLane(run, "M1.L1", ["src/a.ts"]);
  const { d } = await admit(deps, run, {
    role: "worker",
    name: "worker-M1.L1",
    brief: "b",
    rung: "codex:gpt-6-luna#high",
    thread: null,
    lane: "M1.L1",
    failoverFrom: null,
  });
  expect(d.admit).toMatchObject({ access: "workspace-write", isolated: false });
  // re-pinning follows the repo, and nothing differs any more
  const r = await repin(deps, { run: run.id });
  expect(r.changed).toHaveLength(3);
  expect(r.pin.profile).toBe("just-claude");
  expect(pinChanges(deps, run)).toEqual([]);
  expect(runProfile(deps, run).isolated.codex).toBe(true);
});

it("logs the changes in state.md, and drops the line once re-pinned", async () => {
  const { deps, run } = await pinnedRun();
  await refreshState(run, { pinChanges: ["codex isolated: pinned false, now true"] });
  expect(readFileSync(runPaths(run.dir).state, "utf8")).toContain(
    "Pinned: codex isolated: pinned false, now true (dispatch keeps the pinned values; run_pin re-pins)",
  );
  await repin(deps, { run: run.id });
  expect(readFileSync(runPaths(run.dir).state, "utf8")).not.toContain("Pinned:");
});

it("reads the repo's profile for a run with no pin (before 1.5)", () => {
  const { run } = freshRun();
  const deps = fakeDeps();
  expect(readPin(run)).toBeNull();
  expect(runProfile(deps, run)).toBe(deps.view);
  expect(pinChanges(deps, run)).toEqual([]);
});
