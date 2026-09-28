import { replyContract } from "../../src/domain/role-prompts.ts";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCatherdError } from "../../src/domain/errors.ts";
import * as dispatchDir from "../../src/infra/dispatch-dir.ts";
import { awaitsCollect, dispatchPaths, readExit } from "../../src/infra/dispatch-dir.ts";
import * as backends from "../../src/services/backends.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import {
  cancel,
  dispatch,
  type DispatchInput,
  failoverLock,
  orphanLimits,
  type Settled,
  settle,
  settledHooks,
  watchersSettled,
} from "../../src/services/dispatch-service.ts";
import { isAlive, processStartTime } from "../../src/infra/proc.ts";
import { writeJsonAtomic } from "../../src/infra/store.ts";
import { launchSupervisor } from "../../src/infra/launch.ts";
import { admit } from "../../src/services/admission.ts";
import {
  type Dispatch,
  latestDispatch,
  launchPath,
  listDispatches,
  liveDispatches,
  readFailover,
  readProc,
} from "../../src/services/dispatches.ts";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import { reconcileAll } from "../../src/services/reconcile.ts";
import { result } from "../../src/services/run-service.ts";
import { readRecords, type Run, runPaths } from "../../src/services/run-store.ts";
import { claimRun } from "../../src/services/sessions.ts";
import { readNotes } from "../../src/services/state.ts";
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
const FAILED_OVER = "limit: codex:gpt-6-sol#medium hit a usage limit; failed over to codex:gpt-6-sol#high";

function setup(s: CodexScenario, failover: Record<string, string> = FAILOVER) {
  const { repo, run } = freshRun();
  process.env.PATH = simPath();
  Object.assign(process.env, withScenario(s).env);
  writeLane(run, "M1.L1", ["src/a.ts"]);
  return { repo, run, deps: fakeDeps({ view: testView({ failover }) }) };
}

/** Deps of a server whose session owns `run`: reconcile fails over only there (a claim does it for the others). */
async function owned(run: Run) {
  const deps = fakeDeps({
    view: testView({ failover: FAILOVER }),
    session: { sessionId: "s-me", hostSessionId: null, socketPath: null, token: null },
  });
  await claimRun(deps, run);
  return deps;
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

const standInOf = (run: Run) => listDispatches(run).find((d) => d.admit.failoverOf !== undefined);

/** A limited dispatch recorded on disk, as a server that died before settling it left it: unread, no failover. */
async function limitedOnDisk(
  run: Run,
): Promise<{ d: Dispatch; record: Awaited<ReturnType<typeof finalizeDispatch>> }> {
  const exit = { code: 1, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };
  const d = await fakeDispatch(
    run,
    {},
    { proc: "dead", exit, events: readFileSync(LIMIT.eventsFile, "utf8"), collect: true },
  );
  const record = await finalizeDispatch(run, d);
  expect(record.status).toBe("limit");
  return { d, record };
}

describe("failover (spec §3.4: it runs as soon as a limit is settled)", () => {
  it("launches the stand-in as the limit is settled, writes what it did once, and hands it to the hooks", async () => {
    const release = join(mkdtempSync(join(tmpdir(), "catherd-hold-")), "release");
    const { run, deps } = setup({
      byRung: { "gpt-6-sol#medium": LIMIT, "gpt-6-sol#high": { ...DONE, holdUntil: release } },
    });
    const seen: Settled[] = [];
    const hook = (s: Settled) => {
      seen.push(s);
    };
    settledHooks.add(hook);
    try {
      const limited = (await dispatch(deps, input(run.id))).dispatched;
      const stand = await waitFor(() => standInOf(run));
      await waitFor(() => seen.length === 1);
      expect(stand.admit).toMatchObject({ rung: "codex:gpt-6-sol#high", failoverOf: limited.dispatchId });
      expect(seen[0]?.record.status).toBe("limit");
      expect(seen[0]?.hints).toEqual([FAILED_OVER]);
      expect(seen[0]?.started).toMatchObject({ name: "worker-M1.L1", dispatchId: stand.admit.dispatchId });
      const dir = listDispatches(run).find((d) => d.admit.dispatchId === limited.dispatchId)?.dir as string;
      expect(readFailover(dir)).toMatchObject({
        standIn: { dispatchId: stand.admit.dispatchId, rung: "codex:gpt-6-sol#high" },
        hints: [FAILED_OVER],
        pause: null,
      });
      expect(readNotes(run).next).not.toMatch(/^paused/);
      writeFileSync(release, "");
      await watchersSettled();
    } finally {
      settledHooks.delete(hook);
    }
    const r = await result(deps, { run: run.id, name: "worker-M1.L1" });
    expect(r.record).toMatchObject({
      status: "ok",
      rung: "codex:gpt-6-sol#high",
      failoverFrom: "codex:gpt-6-sol#medium",
    });
    expect(r.hints).toEqual([FAILED_OVER]);
  });

  it("still settles the limited record, paused, when the failover throws an unexpected error (I-3)", async () => {
    const release = join(mkdtempSync(join(tmpdir(), "catherd-hold-")), "release");
    const { run, deps } = setup({ ...LIMIT, holdUntil: release });
    // admitted first (admission reads the stand-ins too); the failover, after the limit, throws
    await dispatch(deps, input(run.id));
    const spy = spyOn(backends, "standInFor").mockImplementation(() => {
      throw new Error("profile vanished");
    });
    try {
      writeFileSync(release, "");
      await watchersSettled();
    } finally {
      spy.mockRestore();
    }
    const r = await result(deps, { run: run.id, name: "worker-M1.L1" });
    expect(r.record?.status).toBe("limit");
    expect(r.hints.at(-1)).toBe("failover: profile vanished");
    expect(readNotes(run).next).toBe("paused: codex usage limit; resume when the user says so");
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
    expect(hints[0]).toBe(FAILED_OVER);
    expect(readRecords(run).records.map((r) => r.status)).toEqual(["limit", "ok"]);
    const stand = latestDispatch(run, "worker-M1.L1");
    expect(stand?.admit.thread).toBeNull();
    expect(readFileSync(dispatchPaths(stand?.dir ?? "").brief, "utf8")).toBe(
      `Read lanes/M1.L1.md\n\n${replyContract("worker")}\n`,
    );
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
    expect(hints).toEqual([FAILED_OVER, "violation: src/other.ts"]);
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
    expect(readFileSync(paths[1] as string, "utf8")).toBe(
      `Fix: BUG src/a.ts:3 — off by one\n\n${replyContract("worker")}\n`,
    );
    // spec 1.1 §6: the stand-in's own brief carries the reply contract too
    expect(brief).toEndWith(`${replyContract("worker")}\n`);
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
    // git breaks once the worker has ended (its exit.json exists), not after a guessed delay
    const roles = runPaths(run.dir).roles;
    fakeGit(`for e in '${roles}'/*/*/exit.json; do [ -f "$e" ] && exit 128; done\nexec "$REAL_GIT" "$@"`);
    const { record } = await runRole(deps, input(run.id));
    expect(record).toMatchObject({ status: "limit", gitUnavailable: true });
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

describe("failover's stand-in, tied to its limited dispatch, launched once (N-3)", () => {
  // every held stand-in is released after its test, pass or fail, so no watcher outlives it
  const releases: string[] = [];
  const held = () => {
    const f = join(mkdtempSync(join(tmpdir(), "catherd-hold-")), "release");
    releases.push(f);
    return f;
  };
  afterEach(() => {
    for (const f of releases.splice(0)) writeFileSync(f, "");
  });

  it("reuses the stand-in when a limit is settled a second time: no second launch", async () => {
    const release = held();
    const { run, deps } = setup({
      byRung: { "gpt-6-sol#medium": LIMIT, "gpt-6-sol#high": { ...DONE, holdUntil: release } },
    });
    const limited = (await dispatch(deps, input(run.id))).dispatched;
    const stand = await waitFor(() => standInOf(run));
    const d = listDispatches(run).find((x) => x.admit.dispatchId === limited.dispatchId) as Dispatch;
    await waitFor(() => readFailover(d.dir));
    const record = readRecords(run).records.find((r) => r.dispatchId === limited.dispatchId);
    const again = await settle(deps, run, d, record as NonNullable<typeof record>);
    expect(again.started?.dispatchId).toBe(stand.admit.dispatchId);
    expect(again.hints).toEqual([FAILED_OVER]);
    expect(listDispatches(run)).toHaveLength(2);
  });

  it("starts a stand-in admitted before a crash but never launched, instead of reporting it started (M-5)", async () => {
    const release = held();
    const { run, deps } = setup({ ...DONE, holdUntil: release });
    const { d, record } = await limitedOnDisk(run);
    // the settle that crashed had admitted the stand-in (admit.json, spec.json, the mark) and died before its launch
    const stand = await admit(deps, run, {
      role: "worker",
      name: "worker-M1.L1",
      brief: "Read lanes/M1.L1.md",
      rung: "codex:gpt-6-sol#high",
      thread: null,
      lane: "M1.L1",
      failoverFrom: "codex:gpt-6-sol#medium",
      failoverOf: d.admit.dispatchId,
    });
    const s = await settle(deps, run, d, record);
    expect(s.started?.dispatchId).toBe(stand.d.admit.dispatchId);
    expect(existsSync(launchPath(stand.d.dir))).toBe(true);
    writeFileSync(release, "");
    await watchersSettled();
    expect(readRecords(run).records.map((r) => [r.dispatchId, r.status])).toEqual([
      [d.admit.dispatchId, "limit"],
      [stand.d.admit.dispatchId, "ok"],
    ]);
  });

  it("reuses a stand-in whose settle died between spawning its supervisor and writing launch.json", async () => {
    const release = held();
    const { run, deps } = setup({ ...DONE, holdUntil: release });
    const { d, record } = await limitedOnDisk(run);
    const stand = await admit(deps, run, {
      role: "worker",
      name: "worker-M1.L1",
      brief: "Read lanes/M1.L1.md",
      rung: "codex:gpt-6-sol#high",
      thread: null,
      lane: "M1.L1",
      failoverFrom: "codex:gpt-6-sol#medium",
      failoverOf: d.admit.dispatchId,
    });
    // the settle spawned the supervisor and died before launch.json: the supervisor holds the dispatch
    launchSupervisor(stand.specPath);
    await waitFor(() => existsSync(dispatchPaths(stand.d.dir).supervisorLock));
    const s = await settle(deps, run, d, record);
    expect(s.started?.dispatchId).toBe(stand.d.admit.dispatchId);
    // reused, not launched again: recovery never wrote a launch.json of its own
    expect(existsSync(launchPath(stand.d.dir))).toBe(false);
  });

  it("is settled by the next server's reconcile when its own server died before settling it, once", async () => {
    const release = held();
    const { run } = setup({ ...DONE, holdUntil: release });
    const deps = await owned(run);
    const { d } = await limitedOnDisk(run);
    // reconcile settles before it returns; its `done` would wait for the held stand-in too
    await reconcileAll(deps);
    const first = readFailover(d.dir);
    expect(first?.standIn?.rung).toBe("codex:gpt-6-sol#high");
    const again = await reconcileAll(deps);
    expect(readFailover(d.dir)).toEqual(first);
    expect(listDispatches(run)).toHaveLength(2);
    // the second reconcile watches the stand-in it found running: let it finish inside this test
    writeFileSync(release, "");
    await again.done;
  });

  it("leaves a read limit alone at the next start: failover is for what the orchestrator has not read", async () => {
    const { run } = setup(DONE);
    const deps = await owned(run);
    const { d } = await limitedOnDisk(run);
    await result(deps, { run: run.id, name: "worker-M1.L1" });
    expect(awaitsCollect(d.dir)).toBe(false);
    await reconcileAll(deps);
    expect(readFailover(d.dir)).toBeNull();
    expect(listDispatches(run)).toHaveLength(1);
  });

  it("leaves a limit to the process holding its failover lock: no pause, no hooks on a timeout (codex r4)", async () => {
    const release = held();
    const { run, deps } = setup({ ...DONE, holdUntil: release });
    const { d, record } = await limitedOnDisk(run);
    const seen: Settled[] = [];
    const hook = (s: Settled) => {
      seen.push(s);
    };
    settledHooks.add(hook);
    const holder = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"], env: process.env });
    orphans.push(holder);
    const lock = `${dispatchPaths(d.dir).failover}.lock`;
    const was = failoverLock.timeoutMs;
    failoverLock.timeoutMs = 100;
    try {
      // another server is failing it over and holds the lock past this settle's wait
      writeFileSync(lock, JSON.stringify({ pid: holder.pid, startTime: processStartTime(holder.pid) }));
      const waited = await settle(deps, run, d, record);
      expect(waited.pause).toBeNull();
      expect(waited.started).toBeNull();
      expect(seen).toEqual([]);
      expect(readNotes(run).next).not.toMatch(/^paused/);
      expect(readFailover(d.dir)).toBeNull();
      // the holder's settle is the one that fails it over and is announced
      holder.kill("SIGKILL");
      await holder.exited;
      const s = await settle(deps, run, d, record);
      expect(s.started?.rung).toBe("codex:gpt-6-sol#high");
      expect(seen.map((x) => [x.started?.dispatchId ?? null, x.pause])).toEqual([
        [s.started?.dispatchId ?? null, null],
      ]);
      expect(readNotes(run).next).not.toMatch(/^paused/);
    } finally {
      failoverLock.timeoutMs = was;
      settledHooks.delete(hook);
    }
  });

  it("never hands one limited dispatch's stand-in to another of the same name and rung", async () => {
    const release = held();
    const { run, deps } = setup({ ...DONE, holdUntil: release });
    const a = await limitedOnDisk(run);
    const b = await limitedOnDisk(run);
    const first = await settle(deps, run, a.d, a.record);
    expect(first.started).not.toBeNull();
    // b is not a's: its own stand-in is refused while a's stand-in, of the same name, runs
    const second = await settle(deps, run, b.d, b.record);
    expect(second.started).toBeNull();
    expect(second.hints.at(-1)).toMatch(/^failover: codex:gpt-6-sol#high refused: E_ADMIT_DUPLICATE/);
  });
});

describe("cancel", () => {
  it("says so when result already read the record it returns (N-2)", async () => {
    const { run, deps } = setup({ hangMs: 30_000 });
    await dispatch(deps, input(run.id));
    await waitFor(() => liveDispatches(run).find((d) => d.state === "running"));
    const spy = spyOn(dispatchDir, "tryCollect").mockImplementation(async () => false);
    try {
      const { hints } = await cancel(deps, run.id, "worker-M1.L1", { read: true });
      expect(hints).toContain("worker-M1.L1: result had already read this record");
    } finally {
      spy.mockRestore();
    }
  });

  it("stops a live dispatch, records it once as cancelled, and marks the record read (the MCP tool)", async () => {
    const { run, deps } = setup({ hangMs: 30_000 });
    await dispatch(deps, input(run.id));
    const live = await waitFor(() => liveDispatches(run).find((d) => d.state === "running"));
    const { record } = await cancel(deps, run.id, "worker-M1.L1", { read: true });
    expect(record.status).toBe("cancelled");
    expect(awaitsCollect(live.dir)).toBe(false);
    await watchersSettled();
    expect(readRecords(run).records).toHaveLength(1);
    expect(liveDispatches(run)).toEqual([]);
  });

  it("still records a cancel when git breaks mid-run, and says what it could not see", async () => {
    const { run, deps } = setup({ hangMs: 30_000 });
    await dispatch(deps, input(run.id));
    await waitFor(() => liveDispatches(run).find((d) => d.state === "running"));
    fakeGit("exit 128");
    const { record, hints } = await cancel(deps, run.id, "worker-M1.L1");
    expect(record).toMatchObject({ status: "cancelled", changedOwned: [], gitUnavailable: true });
    expect(hints).toHaveLength(2);
    expect(hints[0]).toBe("git-unavailable: changed files unknown");
    expect(hints[1]).toMatch(/^state\.md not refreshed: git status failed in /);
    await watchersSettled();
    expect(readRecords(run).records).toHaveLength(1);
  });

  it("stops a worker whose supervisor died, and records it as cancelled", async () => {
    const { run, deps } = setup({ hangMs: 60_000 });
    await dispatch(deps, input(run.id));
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
    await watchersSettled();
    expect(readRecords(run).records).toHaveLength(1);
  }, 30_000);

  it("records a dispatch as lost once its supervisor died and then its worker ended", async () => {
    // the worker ends only when the test says so: after its supervisor is gone, never before
    const release = join(mkdtempSync(join(tmpdir(), "catherd-hold-")), "release");
    const { run, deps } = setup({ holdUntil: release });
    await dispatch(deps, input(run.id));
    const live = await waitFor(() => liveDispatches(run).find((d) => d.state === "running"));
    const proc = await waitFor(() => readProc(live.dir));
    process.kill(proc.supervisorPid, "SIGKILL");
    await waitFor(() => !isAlive(proc.supervisorPid, proc.supervisorStartTime));
    writeFileSync(release, "");
    await watchersSettled();
    const record = (await result(deps, { run: run.id, name: "worker-M1.L1" })).record;
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
