import { afterEach, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { tryLock } from "../../src/infra/filelock.ts";
import { processStartTime } from "../../src/infra/proc.ts";
import { writeJsonAtomic } from "../../src/infra/store.ts";
import { admit } from "../../src/services/admission.ts";
import { latestDispatch } from "../../src/services/dispatches.ts";
import { startRun, supersedeRun } from "../../src/services/run-service.ts";
import * as runStore from "../../src/services/run-store.ts";
import { createRun, runPaths, supersededBy } from "../../src/services/run-store.ts";
import { simPath, withScenario } from "../sim/scenario.ts";
import { status } from "../../src/services/summary.ts";
import { snapshotEnv } from "../helpers.ts";
import { SRC } from "../import-graph.ts";
import { fakeDeps, fakeDispatch, freshRun } from "./helpers.ts";

afterEach(snapshotEnv());

it("run_start with from closes the run it takes over, and status hides it", async () => {
  const { repo, run: planning } = freshRun("planning");
  const deps = fakeDeps();
  const started = await startRun(deps, {
    repo,
    title: "execution",
    aLines: ["A1 it ships"],
    from: planning.id,
  });
  expect(supersededBy(planning)).toMatchObject({ by: started.run });
  // the closed run is newer here, so only the hiding keeps it out of the default view
  const later = createRun({
    repo,
    title: "later planning",
    aLines: [],
    version: "t",
    now: new Date(Date.now() + 60_000),
  });
  await supersedeRun(deps, { run: later.id, by: started.run });
  expect(status(deps).runs.map((r) => r.id)).toEqual([started.run]);
  expect(status(deps, later.id).runs[0]?.supersededBy).toBe(started.run);
});

it("refuses to supersede a run by itself, or one with live roles", async () => {
  const { repo, run } = freshRun();
  const deps = fakeDeps();
  const other = createRun({ repo, title: "other", aLines: [], version: "t" });
  await expect(supersedeRun(deps, { run: run.id, by: run.id })).rejects.toThrow("cannot supersede itself");
  await fakeDispatch(run, { name: "worker-M1.L1" }, { proc: "self" });
  await expect(supersedeRun(deps, { run: run.id, by: other.id })).rejects.toThrow("still has live roles");
  expect(supersededBy(run)).toBeNull();
});

it("refuses a dispatch into a superseded run, naming the run that took over", async () => {
  const { repo, run } = freshRun();
  const deps = fakeDeps();
  const other = createRun({ repo, title: "other", aLines: [], version: "t" });
  await supersedeRun(deps, { run: run.id, by: other.id });
  await expect(
    admit(deps, run, {
      role: "worker",
      name: "worker-M1.L1",
      brief: "b",
      rung: "codex:gpt-6-luna#high",
      thread: null,
      lane: null,
      failoverFrom: null,
    }),
  ).rejects.toMatchObject({ code: "E_RUN_NOT_LIVE", fix: `dispatch in run ${other.id}` });
});

it("refuses a supersede that closes a cycle of any length", async () => {
  const { repo, run: a } = freshRun();
  const deps = fakeDeps();
  const b = createRun({ repo, title: "b", aLines: [], version: "t" });
  const c = createRun({ repo, title: "c", aLines: [], version: "t" });
  await supersedeRun(deps, { run: a.id, by: b.id });
  await supersedeRun(deps, { run: b.id, by: c.id });
  await expect(supersedeRun(deps, { run: c.id, by: a.id })).rejects.toThrow(
    `run ${a.id} is itself superseded by ${c.id}`,
  );
  expect(supersededBy(c)).toBeNull();
});

it("re-checks the supersede under the run's admission lock, so a dispatch never lands in a closed run", async () => {
  const { repo, run } = freshRun();
  process.env.PATH = simPath();
  Object.assign(process.env, withScenario({}).env, { TYPESAFE_API_KEY: "secret" });
  const deps = fakeDeps();
  const other = createRun({ repo, title: "other", aLines: [], version: "t" });
  await supersedeRun(deps, { run: run.id, by: other.id });
  // the early check ran before the supersede landed: only the one under the lock can see it
  const spy = spyOn(runStore, "supersededBy").mockImplementationOnce(() => null);
  try {
    await expect(
      admit(deps, run, {
        role: "worker",
        name: "worker-M1.L1",
        brief: "b",
        rung: "codex:gpt-6-luna#high",
        thread: null,
        lane: null,
        failoverFrom: null,
      }),
    ).rejects.toMatchObject({ code: "E_RUN_NOT_LIVE" });
  } finally {
    spy.mockRestore();
  }
});

it("run_start with from holds the source run's admission from its check to the pointer: no orphan run", async () => {
  const { repo, run: planning } = freshRun("planning");
  const deps = fakeDeps();
  const real = runStore.createRun;
  let admittedMeanwhile = false;
  // a dispatch into the source run tries to get in while the replacement is being created
  const spy = spyOn(runStore, "createRun").mockImplementationOnce((o) => {
    const release = tryLock(runPaths(planning.dir).admission);
    if (release) {
      try {
        void fakeDispatch(planning, { name: "worker-M1.L1" });
        const d = latestDispatch(planning, "worker-M1.L1");
        if (!d) throw new Error("no dispatch");
        writeJsonAtomic(dispatchPaths(d.dir).proc, {
          schema: 1,
          pid: process.pid,
          startTime: processStartTime(process.pid),
          supervisorPid: process.pid,
          supervisorStartTime: processStartTime(process.pid),
          pgid: process.pid,
          startedAt: new Date().toISOString(),
        });
        admittedMeanwhile = true;
      } finally {
        release();
      }
    }
    return real(o);
  });
  try {
    const started = await startRun(deps, { repo, title: "execution", aLines: ["A1"], from: planning.id });
    expect(supersededBy(planning)).toMatchObject({ by: started.run });
  } finally {
    spy.mockRestore();
  }
  expect(admittedMeanwhile).toBe(false);
  expect(runStore.listRuns().runs).toHaveLength(2);
});

it("catherd runs supersede closes a run, and runs list says by which", () => {
  const { repo, run } = freshRun();
  const other = createRun({ repo, title: "other", aLines: [], version: "t" });
  const cli = (...args: string[]) =>
    Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), ...args], {
      env: { ...process.env, NO_COLOR: "1", ANTHROPIC_API_KEY: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
  const r = cli("runs", "supersede", run.id, "--by", other.id);
  expect(r.exitCode).toBe(0);
  expect(r.stdout.toString()).toContain(`${run.id} superseded by ${other.id}`);
  expect(cli("runs", "list").stdout.toString()).toContain(`${run.id}  superseded by ${other.id}`);
});
