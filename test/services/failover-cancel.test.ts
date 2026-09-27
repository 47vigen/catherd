import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCatherdError } from "../../src/domain/errors.ts";
import { dispatchPaths, readExit } from "../../src/infra/dispatch-dir.ts";
import * as backends from "../../src/services/backends.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import {
  cancel,
  dispatch,
  type DispatchInput,
  orphanLimits,
  wait,
  watchersSettled,
} from "../../src/services/dispatch-service.ts";
import { isAlive, processStartTime } from "../../src/infra/proc.ts";
import { writeJsonAtomic } from "../../src/infra/store.ts";
import { latestDispatch, listDispatches, liveDispatches, readProc } from "../../src/services/dispatches.ts";
import { readRecords, runPaths } from "../../src/services/run-store.ts";
import { readNotes } from "../../src/services/state.ts";
import type { Deps } from "../../src/services/ports.ts";
import { snapshotEnv } from "../helpers.ts";
import { type CodexScenario, simPath, withScenario } from "../sim/scenario.ts";
import {
  deadProcess,
  fakeDeps,
  fakeDispatch,
  fakeGit,
  freshRun,
  runRole,
  testView,
  waitFor,
  writeLane,
} from "./helpers.ts";

afterEach(() => watchersSettled());
afterEach(snapshotEnv());
beforeEach(() => {
  resetReadiness();
  orphanLimits.killGraceMs = 10_000;
});

const orphans: Bun.Subprocess[] = [];
afterEach(() => {
  for (const p of orphans.splice(0)) p.kill("SIGKILL");
});

/** A worker left running in its own process group, as a dead supervisor leaves one. */
function orphan(script: string): Bun.Subprocess {
  const p = Bun.spawn(["sh", "-c", script], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
  });
  orphans.push(p);
  return p;
}

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
const LIMIT = { eventsFile: join(FX, "limit.jsonl"), exitCode: 1 };
const DONE = { reply: "Done.\nSTATUS: complete — ok", touch: [{ path: "src/a.ts", content: "fixed" }] };
const FAILOVER = { "codex:gpt-6-sol#medium": "codex:gpt-6-sol#high" };

function setup(s: CodexScenario, failover: Record<string, string> = FAILOVER) {
  const { repo, run } = freshRun();
  process.env.PATH = simPath();
  Object.assign(process.env, withScenario(s).env);
  writeLane(run, "M1.L1", ["src/a.ts"]);
  return { repo, run, deps: fakeDeps({ view: testView({ failover }) }) };
}

const input = (run: string, over: Partial<DispatchInput> = {}): DispatchInput => ({
  run,
  role: "worker",
  name: "worker-M1.L1",
  brief: "Read lanes/M1.L1.md",
  rung: "codex:gpt-6-sol#medium",
  lane: "M1.L1",
  ...over,
});

describe("failover", () => {
  it("is done by wait: the limit is recorded, its stand-in launched and not awaited", async () => {
    const release = join(mkdtempSync(join(tmpdir(), "catherd-hold-")), "release");
    const { run, deps } = setup({
      byRung: { "gpt-6-sol#medium": LIMIT, "gpt-6-sol#high": { ...DONE, holdUntil: release } },
    });
    await dispatch(deps, input(run.id));
    const w = await wait(deps, { run: run.id });
    expect(w.records.map((r) => r.record.status)).toEqual(["limit"]);
    expect(w.records[0]?.hints).toEqual([
      "limit: codex:gpt-6-sol#medium hit a usage limit; failed over to codex:gpt-6-sol#high",
    ]);
    const stand = latestDispatch(run, "worker-M1.L1");
    expect(w.started).toEqual([
      {
        name: "worker-M1.L1",
        role: "worker",
        rung: "codex:gpt-6-sol#high",
        dispatchId: stand?.admit.dispatchId as string,
        admittedAt: stand?.admit.admittedAt as string,
      },
    ]);
    expect(w.running).toEqual(["worker-M1.L1"]);
    expect(readRecords(run).records.map((r) => r.status)).toEqual(["limit"]);
    expect(readNotes(run).next).not.toMatch(/^paused/);
    writeFileSync(release, "");
    const next = await wait(deps, { run: run.id });
    expect(next.records[0]?.record).toMatchObject({
      status: "ok",
      rung: "codex:gpt-6-sol#high",
      failoverFrom: "codex:gpt-6-sol#medium",
    });
    expect(next.running).toEqual([]);
  });

  it("is never done by the watcher that finalizes a role at exit, only by wait, once (I-2)", async () => {
    const { run, deps } = setup(LIMIT, FAILOVER);
    await dispatch(deps, input(run.id));
    await waitFor(() => readRecords(run).records.length === 1);
    await watchersSettled();
    expect(listDispatches(run)).toHaveLength(1);
    expect(readNotes(run).next).not.toMatch(/^paused/);
    const w = await wait(deps, { run: run.id });
    expect(w.started.map((s) => s.rung)).toEqual(["codex:gpt-6-sol#high"]);
  });

  it("still returns the limited record, paused, when the failover throws an unexpected error (I-3)", async () => {
    const { run, deps } = setup(LIMIT);
    await dispatch(deps, input(run.id));
    const spy = spyOn(backends, "standInFor").mockImplementation(() => {
      throw new Error("profile vanished");
    });
    try {
      const w = await wait(deps, { run: run.id });
      expect(w.records.map((r) => r.record.status)).toEqual(["limit"]);
      expect(w.records[0]?.hints.at(-1)).toBe("failover: profile vanished");
    } finally {
      spy.mockRestore();
    }
    expect(readNotes(run).next).toBe("paused: codex usage limit; resume when the user says so");
    expect((await wait(deps, { run: run.id })).records).toEqual([]);
  });

  it("reruns a fresh round's own brief on the stand-in, and records both runs", async () => {
    const { run, deps } = setup({ byRung: { "gpt-6-sol#medium": LIMIT, "gpt-6-sol#high": DONE } });
    const { record, hints } = await runRole(deps, input(run.id));
    expect(record).toMatchObject({
      status: "ok",
      rung: "codex:gpt-6-sol#high",
      failoverFrom: "codex:gpt-6-sol#medium",
      attempt: 2,
      changedOwned: ["src/a.ts"],
    });
    expect(hints[0]).toBe(
      "limit: codex:gpt-6-sol#medium hit a usage limit; failed over to codex:gpt-6-sol#high",
    );
    expect(readRecords(run).records.map((r) => r.status)).toEqual(["limit", "ok"]);
    const stand = latestDispatch(run, "worker-M1.L1");
    expect(stand?.admit.thread).toBeNull();
    expect(readFileSync(dispatchPaths(stand?.dir ?? "").brief, "utf8")).toBe("Read lanes/M1.L1.md");
  });

  it("keeps the limited run's violations in the hints after a successful failover", async () => {
    const { run, deps } = setup({
      byRung: {
        "gpt-6-sol#medium": { ...LIMIT, touch: [{ path: "src/other.ts", content: "out of lane" }] },
        "gpt-6-sol#high": DONE,
      },
    });
    const { record, hints } = await runRole(deps, input(run.id));
    expect(record.status).toBe("ok");
    expect(readRecords(run).records[0]?.violations).toEqual(["src/other.ts"]);
    expect(hints).toEqual([
      "limit: codex:gpt-6-sol#medium hit a usage limit; failed over to codex:gpt-6-sol#high",
      "violation: src/other.ts",
    ]);
  });

  it("hands a fix round's stand-in the lane file and the fix brief by path, both of which exist", async () => {
    const { run, deps } = setup({ byRung: { "gpt-6-sol#medium": LIMIT, "gpt-6-sol#high": DONE } });
    const { record } = await runRole(
      deps,
      input(run.id, { thread: "t-earlier-thread", brief: "Fix: BUG src/a.ts:3 — off by one" }),
    );
    expect(record.status).toBe("ok");
    const stand = latestDispatch(run, "worker-M1.L1");
    const brief = readFileSync(dispatchPaths(stand?.dir ?? "").brief, "utf8");
    const paths = [...brief.matchAll(/: (\/\S+)/g)].map((m) => m[1] as string);
    expect(paths).toHaveLength(2);
    for (const p of paths) expect(existsSync(p)).toBe(true);
    expect(readFileSync(paths[1] as string, "utf8")).toBe("Fix: BUG src/a.ts:3 — off by one");
  });

  it("puts the stand-in through the budget again, and pauses when it is refused", async () => {
    const events = join(mkdtempSync(join(tmpdir(), "catherd-fx-")), "limit-after-work.jsonl");
    writeFileSync(
      events,
      [
        '{"type":"thread.started","thread_id":"t-spent"}',
        '{"type":"turn.completed","usage":{"input_tokens":5000,"cached_input_tokens":0,"output_tokens":100}}',
        '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. Try again later."}}',
        "",
      ].join("\n"),
    );
    const { run, deps } = setup({
      byRung: { "gpt-6-sol#medium": { eventsFile: events, exitCode: 1 }, "gpt-6-sol#high": DONE },
    });
    deps.view.budget = { tokens: 1000 };
    const { record, hints } = await runRole(deps, input(run.id));
    expect(record.status).toBe("limit");
    expect(hints.at(-1)).toMatch(/^failover: codex:gpt-6-sol#high refused: E_RUN_BUDGET/);
    expect(readRecords(run).records).toHaveLength(1);
    expect(readFileSync(runPaths(run.dir).state, "utf8")).toContain("Next: paused: codex usage limit");
  });

  it("keeps the paused note in state.json when git breaks before state.md can be refreshed", async () => {
    const { run, deps } = setup(LIMIT, {});
    // git breaks once the worker has ended (its exit.json exists), not after a guessed delay: waiting for
    // the ~1 s "running" window instead missed it whenever this process stalled >1.1 s, and then hung
    const roles = runPaths(run.dir).roles;
    fakeGit(`for e in '${roles}'/*/*/exit.json; do [ -f "$e" ] && exit 128; done\nexec "$REAL_GIT" "$@"`);
    const { record, hints } = await runRole(deps, input(run.id));
    expect(record).toMatchObject({ status: "limit", gitUnavailable: true });
    expect(hints.at(-1)).toMatch(/^state\.md not refreshed: /);
    expect(readNotes(run).next).toBe("paused: codex usage limit; resume when the user says so");
  });

  it("names the agent when the stand-in is a native Claude rung, without pausing", async () => {
    const { run, deps } = setup(LIMIT, { "codex:gpt-6-sol#medium": "claude:claude-opus-5-5#high" });
    const { record, hints } = await runRole(deps, input(run.id));
    expect(record.status).toBe("limit");
    expect(hints.at(-1)).toBe(
      'failover: run worker-M1.L1 as Agent(subagent_type: "catherd-worker-claude-opus-5-5-high"), standing in for codex:gpt-6-sol#medium',
    );
    expect(readFileSync(runPaths(run.dir).state, "utf8")).not.toContain("paused");
  });
});

/** A cancelled record reaches at most the wait already in flight, never a later one (M-1). */
async function collectedOnce(
  run: { id: string },
  deps: Deps,
  pending: ReturnType<typeof wait>,
  id: string,
): Promise<void> {
  expect((await pending).records.every((r) => r.record.dispatchId === id)).toBe(true);
  expect((await wait(deps, { run: run.id })).records).toEqual([]);
}

describe("cancel", () => {
  it("collects the record it returns, so the next wait does not return it again (M-1)", async () => {
    const { run, deps } = setup({ hangMs: 30_000 });
    await dispatch(deps, input(run.id));
    await waitFor(() => liveDispatches(run).find((d) => d.state === "running"));
    const { record } = await cancel(deps, run.id, "worker-M1.L1");
    expect(record.status).toBe("cancelled");
    expect(await wait(deps, { run: run.id })).toMatchObject({ records: [], running: [] });
  });

  it("stops a live dispatch, records it once as cancelled, and and no later wait returns it again", async () => {
    const { run, deps } = setup({ hangMs: 30_000 });
    await dispatch(deps, input(run.id));
    const pending = wait(deps, { run: run.id });
    await waitFor(() => liveDispatches(run).find((d) => d.state === "running"));
    const { record } = await cancel(deps, run.id, "worker-M1.L1");
    expect(record.status).toBe("cancelled");
    await collectedOnce(run, deps, pending, record.dispatchId);
    expect(readRecords(run).records).toHaveLength(1);
    expect(liveDispatches(run)).toEqual([]);
  });

  it("still records a cancel when git breaks mid-run, and says what it could not see", async () => {
    const { run, deps } = setup({ hangMs: 30_000 });
    await dispatch(deps, input(run.id));
    const pending = wait(deps, { run: run.id });
    await waitFor(() => liveDispatches(run).find((d) => d.state === "running"));
    fakeGit("exit 128");
    const { record, hints } = await cancel(deps, run.id, "worker-M1.L1");
    expect(record).toMatchObject({ status: "cancelled", changedOwned: [], gitUnavailable: true });
    expect(hints).toHaveLength(2);
    expect(hints[0]).toBe("git-unavailable: changed files unknown");
    expect(hints[1]).toMatch(/^state\.md not refreshed: git status failed in /);
    await collectedOnce(run, deps, pending, record.dispatchId);
    expect(readRecords(run).records).toHaveLength(1);
  });

  it("stops a worker whose supervisor died, records it as cancelled, and the wait in flight returns", async () => {
    const { run, deps } = setup({ hangMs: 60_000 });
    await dispatch(deps, input(run.id));
    const pending = wait(deps, { run: run.id });
    const live = await waitFor(() => liveDispatches(run).find((d) => d.state === "running"));
    const proc = await waitFor(() => readProc(live.dir));
    process.kill(proc.supervisorPid, "SIGKILL");
    await waitFor(() => !isAlive(proc.supervisorPid, proc.supervisorStartTime));
    expect(isAlive(proc.pid, proc.startTime)).toBe(true);
    const started = Date.now();
    const { record } = await cancel(deps, run.id, "worker-M1.L1");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(record.status).toBe("cancelled");
    expect(isAlive(proc.pid, proc.startTime)).toBe(false);
    expect(readExit(live.dir)).toMatchObject({ reason: "cancelled", signal: "SIGTERM" });
    await collectedOnce(run, deps, pending, record.dispatchId);
    expect(readRecords(run).records).toHaveLength(1);
  }, 30_000);

  it("finalizes a waiting dispatch as lost once its supervisor died and then its worker ended", async () => {
    // the worker ends only when the test says so: after its supervisor is gone, never before
    const release = join(mkdtempSync(join(tmpdir(), "catherd-hold-")), "release");
    const { run, deps } = setup({ holdUntil: release });
    await dispatch(deps, input(run.id));
    const pending = wait(deps, { run: run.id });
    const live = await waitFor(() => liveDispatches(run).find((d) => d.state === "running"));
    const proc = await waitFor(() => readProc(live.dir));
    process.kill(proc.supervisorPid, "SIGKILL");
    await waitFor(() => !isAlive(proc.supervisorPid, proc.supervisorStartTime));
    writeFileSync(release, "");
    const record = (await pending).records[0]?.record;
    expect(record).toMatchObject({ status: "failed", exitCode: null, error: { message: "lost, exit null" } });
    expect(readExit(live.dir)).toBeNull();
    expect(readRecords(run).records).toHaveLength(1);
  }, 30_000);

  it("records SIGKILL when an orphaned worker outlasts its SIGTERM grace", async () => {
    orphanLimits.killGraceMs = 300;
    const { run, deps } = setup({});
    const worker = orphan("trap '' TERM; while :; do sleep 0.05; done");
    const dead = await deadProcess();
    const d = await fakeDispatch(
      run,
      {},
      {
        proc: {
          pid: worker.pid,
          startTime: processStartTime(worker.pid),
          supervisorPid: dead,
          supervisorStartTime: "gone",
        },
      },
    );
    const { record } = await cancel(deps, run.id, d.admit.name);
    expect(record.status).toBe("cancelled");
    expect(readExit(d.dir)).toMatchObject({ reason: "cancelled", signal: "SIGKILL" });
    expect(await worker.exited).toBe(137);
  });

  it("never signals an orphaned worker it cannot identify, and still records the cancel", async () => {
    const { run, deps } = setup({});
    const dead = await deadProcess();
    const unidentified = [
      // no start time: the pid alone may belong to another process by now
      (pid: number) => ({ startTime: null, pgid: pid }),
      // a process group that is not the one the worker leads
      (pid: number) => ({ startTime: processStartTime(pid), pgid: process.pid }),
    ];
    for (const who of unidentified) {
      const worker = orphan("sleep 30");
      const d = await fakeDispatch(run, { name: `worker-${worker.pid}` });
      writeJsonAtomic(dispatchPaths(d.dir).proc, {
        schema: 1,
        pid: worker.pid,
        ...who(worker.pid),
        supervisorPid: dead,
        supervisorStartTime: "gone",
        startedAt: d.admit.admittedAt,
      });
      const { record } = await cancel(deps, run.id, d.admit.name);
      expect(record.status).toBe("cancelled");
      expect(readExit(d.dir)).toMatchObject({ reason: "cancelled", signal: null });
      expect(isAlive(worker.pid, null)).toBe(true);
    }
  });

  it("refuses a name with no live dispatch", async () => {
    const { run, deps } = setup({});
    const e = await cancel(deps, run.id, "worker-M1.L1").catch((x: unknown) => x);
    expect(isCatherdError(e) && e.code).toBe("E_RUN_NOT_LIVE");
  });
});
