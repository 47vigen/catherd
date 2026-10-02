import { afterEach, expect, it } from "bun:test";
import { admit, type AdmitInput } from "../../src/services/admission.ts";
import {
  machinePauseFile,
  pauseIntervals,
  pauseMachine,
  pauseWorkspace,
  resumeMachine,
  resumeWorkspace,
} from "../../src/services/pause.ts";
import { status } from "../../src/services/summary.ts";
import {
  startWorkspace,
  startWorkspaceChild,
  workspaceStatus,
} from "../../src/services/workspace-service.ts";
import { workspaceChildren } from "../../src/services/workspace-store.ts";
import { snapshotEnv, tempDir, tempRepo } from "../helpers.ts";
import { fakeDeps, freshRun } from "./helpers.ts";

afterEach(snapshotEnv());

const input: AdmitInput = {
  role: "worker",
  name: "worker-M1.L1",
  brief: "the lane",
  rung: "codex:gpt-6-luna#high",
  thread: null,
  lane: null,
  failoverFrom: null,
};

/** A rung off every test ladder: admission refuses it right after the pause check, before any backend. */
const offLadder: AdmitInput = { ...input, rung: "codex:gpt-6-sol#ultra" };

const T0 = Date.parse("2026-10-02T10:00:00.000Z");

it("refuses every dispatch on the machine with the reason until resumed, and status shows it first", async () => {
  const { run } = freshRun();
  const deps = fakeDeps({ now: () => T0 });
  pauseMachine(T0, "the VPN takes the default route");
  await expect(admit(deps, run, input)).rejects.toMatchObject({
    code: "E_ADMIT_PAUSED",
    message: expect.stringContaining("the VPN takes the default route"),
    fix: expect.stringContaining("catherd resume --machine"),
  });
  const s = status(deps, run.id);
  expect(Object.keys(s)[0]).toBe("paused");
  expect(s.paused).toEqual([
    { scope: "machine", reason: "the VPN takes the default route", since: new Date(T0).toISOString() },
  ]);
  expect(resumeMachine(T0 + 60_000).resumed?.reason).toBe("the VPN takes the default route");
  expect(status(deps, run.id).paused).toEqual([]);
  // admission goes on past the pause, to the next check (this rung is not on the ladder)
  await expect(admit(deps, run, offLadder)).rejects.toMatchObject({ code: "E_ADMIT_RUNG" });
  expect(pauseIntervals(machinePauseFile())).toEqual([
    { from: new Date(T0).toISOString(), to: new Date(T0 + 60_000).toISOString() },
  ]);
});

it("refuses a pause without a reason", () => {
  freshRun();
  expect(() => pauseMachine(T0, "  ")).toThrow("a pause needs a reason");
});

it("pauses a workspace's children only, child starts included, until workspace_resume", async () => {
  const { run: outside } = freshRun();
  const deps = fakeDeps({ now: () => T0 });
  const { workspace } = await startWorkspace(deps, {
    root: tempDir("catherd-pause-"),
    repos: { a: tempRepo(), b: tempRepo() },
    title: "Paused together",
    aLines: [],
    steps: [
      { id: "a", repo: "a", title: "A", aLines: [] },
      { id: "b", repo: "b", title: "B", aLines: [] },
    ],
  });
  await startWorkspaceChild(deps, { workspace: workspace.id, step: "a" });
  const a = workspaceChildren(workspace)[0]!;
  pauseWorkspace(T0, { workspace: workspace.id, reason: "Docker is down" });
  await expect(admit(deps, a, input)).rejects.toMatchObject({ code: "E_ADMIT_PAUSED" });
  await expect(startWorkspaceChild(deps, { workspace: workspace.id, step: "b" })).rejects.toMatchObject({
    code: "E_ADMIT_PAUSED",
    fix: expect.stringContaining(`workspace_resume(${workspace.id})`),
  });
  await expect(admit(deps, outside, offLadder)).rejects.toMatchObject({ code: "E_ADMIT_RUNG" });
  expect((await workspaceStatus(deps, workspace.id)).paused).toMatchObject([{ reason: "Docker is down" }]);
  expect(status(deps, a.id).paused).toMatchObject([{ scope: "workspace", workspace: workspace.id }]);
  resumeWorkspace(T0, { workspace: workspace.id });
  expect((await startWorkspaceChild(deps, { workspace: workspace.id, step: "b" })).run).toBeTruthy();
});
