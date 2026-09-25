import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { processStartTime } from "../../src/infra/proc.ts";
import { writeJsonAtomic } from "../../src/infra/store.ts";
import {
  dispatchState,
  latestDispatch,
  launchPath,
  liveDispatches,
  pendingDispatches,
  STARTING_GRACE_MS,
} from "../../src/services/dispatches.ts";
import { appendRecord, runPaths } from "../../src/services/run-store.ts";
import { readNotes, updateState } from "../../src/services/state.ts";
import { snapshotEnv } from "../helpers.ts";
import { deadProcess, fakeDispatch, freshRun, makeRecord } from "./helpers.ts";

afterEach(snapshotEnv());

describe("dispatch liveness", () => {
  it("is starting when just admitted, and finished once the grace passes with no launch", async () => {
    const { run } = freshRun();
    const d = await fakeDispatch(run);
    expect(dispatchState(d)).toBe("starting");
    expect(dispatchState(d, Date.now() + STARTING_GRACE_MS + 1)).toBe("finished");
  });

  it("follows the launched supervisor, then proc.json, then exit.json", async () => {
    const { run } = freshRun();
    const d = await fakeDispatch(run);
    writeJsonAtomic(launchPath(d.dir), {
      schema: 1,
      supervisorPid: process.pid,
      supervisorStartTime: processStartTime(process.pid),
    });
    expect(dispatchState(d)).toBe("starting");
    const running = await fakeDispatch(run, { name: "b" }, { proc: "self" });
    expect(dispatchState(running)).toBe("running");
    const done = await fakeDispatch(
      run,
      { name: "c" },
      {
        proc: "self",
        exit: { code: 0, signal: null, reason: "exited", endedAt: new Date().toISOString() },
      },
    );
    expect(dispatchState(done)).toBe("finished");
    const dead = await fakeDispatch(run, { name: "d" }, { proc: "dead" });
    expect(dispatchState(dead)).toBe("finished");
  });

  it("does not take a reused pid for a live worker", async () => {
    const { run } = freshRun();
    const d = await fakeDispatch(
      run,
      {},
      {
        proc: {
          pid: process.pid,
          startTime: "an earlier process",
          supervisorPid: await deadProcess(),
          supervisorStartTime: "x",
        },
      },
    );
    expect(dispatchState(d)).toBe("finished");
  });

  it("lists live dispatches without the recorded or finished ones, and follows the latest pointer", async () => {
    const { run } = freshRun();
    const a = await fakeDispatch(run, { name: "a" }, { proc: "self" });
    const b = await fakeDispatch(run, { name: "b" }, { proc: "self" });
    await fakeDispatch(run, { name: "c" }, { proc: "dead" });
    await appendRecord(run, makeRecord({ dispatchId: b.admit.dispatchId, name: "b" }));
    expect(liveDispatches(run).map((d) => d.admit.name)).toEqual(["a"]);
    expect(pendingDispatches(run).map((d) => [d.admit.name, d.state])).toEqual([
      ["a", "running"],
      ["c", "finished"],
    ]);
    const a2 = await fakeDispatch(run, { name: "a" }, { proc: "dead" });
    expect(latestDispatch(run, "a")?.admit.dispatchId).toBe(a2.admit.dispatchId);
    writeFileSync(join(run.dir, "roles", "a", "latest"), a.admit.dispatchId);
    expect(latestDispatch(run, "a")?.admit.dispatchId).toBe(a.admit.dispatchId);
    expect(latestDispatch(run, "nobody")).toBeNull();
  });

  it("skips a dispatch folder whose admit.json is torn", async () => {
    const { run } = freshRun();
    const d = await fakeDispatch(run, {}, { proc: "self" });
    writeFileSync(join(d.dir, "admit.json"), '{"schema":1,"run');
    expect(liveDispatches(run)).toEqual([]);
  });
});

describe("state.md", () => {
  it("renders HEAD, dirty files with their owners, the running roles and the next step", async () => {
    const { repo, run } = freshRun("Add login");
    writeFileSync(join(repo, "a.ts"), "x");
    const d = await fakeDispatch(run, { owns: ["a.ts"] }, { proc: "self" });
    const text = await updateState(run, { next: "review M1" });
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    expect(text).toContain(`HEAD ${head}`);
    expect(text).toContain("- a.ts (worker-M1.L1)");
    expect(text).toContain(
      `- worker-M1.L1 · codex:gpt-6-sol#medium · thread new · since ${d.admit.admittedAt.slice(11, 16)} · roles/worker-M1.L1/${d.admit.dispatchId}/brief.md`,
    );
    expect(readFileSync(runPaths(run.dir).state, "utf8")).toBe(text);
    expect(text.trimEnd().split("\n").at(-1)).toBe("Next: wait for worker-M1.L1; then review M1");
  });

  it("shows HEAD none in a repo with no commit yet", async () => {
    const { run } = freshRun();
    execFileSync("git", ["update-ref", "-d", "HEAD"], { cwd: run.meta.repo });
    expect(await updateState(run)).toContain("HEAD none");
  });

  it("fails loudly, and writes nothing, when git fails rather than show a clean tree", async () => {
    const { run } = freshRun();
    const bin = mkdtempSync(join(tmpdir(), "catherd-fakegit-"));
    writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 128\n");
    chmodSync(join(bin, "git"), 0o755);
    process.env.PATH = `${bin}:${process.env.PATH}`;
    await expect(updateState(run, { next: "x" })).rejects.toMatchObject({ code: "E_IO_UNEXPECTED" });
    expect(existsSync(runPaths(run.dir).stateJson)).toBe(false);
  });

  it("keeps each note across rewrites, and loses none to concurrent writers", async () => {
    const { run } = freshRun();
    await Promise.all([
      updateState(run, { next: "land M1" }),
      updateState(run, { lastCheck: "bun test 12/12" }),
      updateState(run, (n) => ({ lastLandedAt: n.lastLandedAt ?? "2026-09-25T10:00:00.000Z" })),
    ]);
    expect(readNotes(run)).toEqual({
      schema: 1,
      next: "land M1",
      lastCheck: "bun test 12/12",
      lastLandedAt: "2026-09-25T10:00:00.000Z",
    });
    const text = readFileSync(runPaths(run.dir).state, "utf8");
    expect(text).toContain("Last check: bun test 12/12");
    expect(text.trimEnd().split("\n").at(-1)).toBe("Next: land M1");
  });
});
