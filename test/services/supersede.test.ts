import { afterEach, expect, it } from "bun:test";
import { join } from "node:path";
import { admit } from "../../src/services/admission.ts";
import { startRun, supersedeRun } from "../../src/services/run-service.ts";
import { createRun, supersededBy } from "../../src/services/run-store.ts";
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
