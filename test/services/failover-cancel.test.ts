import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCatherdError } from "../../src/domain/errors.ts";
import { dispatchPaths, readExit } from "../../src/infra/dispatch-dir.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { cancel, dispatch, type DispatchInput } from "../../src/services/dispatch-service.ts";
import { isAlive } from "../../src/infra/proc.ts";
import { latestDispatch, liveDispatches, readProc } from "../../src/services/dispatches.ts";
import { readRecords, runPaths } from "../../src/services/run-store.ts";
import { snapshotEnv } from "../helpers.ts";
import { type CodexScenario, simPath, withScenario } from "../sim/scenario.ts";
import { fakeDeps, fakeGit, freshRun, testView, waitFor, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

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
  it("reruns a fresh round's own brief on the stand-in, and records both runs", async () => {
    const { run, deps } = setup({ byRung: { "gpt-6-sol#medium": LIMIT, "gpt-6-sol#high": DONE } });
    const { record, hints } = await dispatch(deps, input(run.id));
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

  it("hands a fix round's stand-in the lane file and the fix brief by path, both of which exist", async () => {
    const { run, deps } = setup({ byRung: { "gpt-6-sol#medium": LIMIT, "gpt-6-sol#high": DONE } });
    const { record } = await dispatch(
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
    const { record, hints } = await dispatch(deps, input(run.id));
    expect(record.status).toBe("limit");
    expect(hints.at(-1)).toMatch(/^failover: codex:gpt-6-sol#high refused: E_RUN_BUDGET/);
    expect(readRecords(run).records).toHaveLength(1);
    expect(readFileSync(runPaths(run.dir).state, "utf8")).toContain("Next: paused: codex usage limit");
  });

  it("names the agent when the stand-in is a native Claude rung, without pausing", async () => {
    const { run, deps } = setup(LIMIT, { "codex:gpt-6-sol#medium": "claude:claude-opus-5-5#high" });
    const { record, hints } = await dispatch(deps, input(run.id));
    expect(record.status).toBe("limit");
    expect(hints.at(-1)).toBe(
      'failover: run worker-M1.L1 as Agent(subagent_type: "catherd-worker-claude-opus-5-5-high"), standing in for codex:gpt-6-sol#medium',
    );
    expect(readFileSync(runPaths(run.dir).state, "utf8")).not.toContain("paused");
  });
});

describe("cancel", () => {
  it("stops a live dispatch, records it once as cancelled, and the waiting dispatch returns the same record", async () => {
    const { run, deps } = setup({ hangMs: 30_000 });
    const pending = dispatch(deps, input(run.id));
    await waitFor(() => liveDispatches(run).find((d) => d.state === "running"));
    const { record } = await cancel(deps, run.id, "worker-M1.L1");
    expect(record.status).toBe("cancelled");
    expect((await pending).record.dispatchId).toBe(record.dispatchId);
    expect(readRecords(run).records).toHaveLength(1);
    expect(liveDispatches(run)).toEqual([]);
  });

  it("still records a cancel when git breaks mid-run, and says what it could not see", async () => {
    const { run, deps } = setup({ hangMs: 30_000 });
    const pending = dispatch(deps, input(run.id));
    await waitFor(() => liveDispatches(run).find((d) => d.state === "running"));
    fakeGit("exit 128");
    const { record, hints } = await cancel(deps, run.id, "worker-M1.L1");
    expect(record).toMatchObject({ status: "cancelled", changedOwned: [], gitUnavailable: true });
    expect(hints).toHaveLength(2);
    expect(hints[0]).toBe("git-unavailable: changed files unknown");
    expect(hints[1]).toMatch(/^state\.md not refreshed: git status failed in /);
    expect((await pending).record.dispatchId).toBe(record.dispatchId);
    expect(readRecords(run).records).toHaveLength(1);
  });

  it("stops a worker whose supervisor died, records it as cancelled, and the waiting dispatch returns", async () => {
    const { run, deps } = setup({ hangMs: 60_000 });
    const pending = dispatch(deps, input(run.id));
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
    expect((await pending).record.dispatchId).toBe(record.dispatchId);
    expect(readRecords(run).records).toHaveLength(1);
  }, 30_000);

  it("finalizes a waiting dispatch as lost once its supervisor died and then its worker ended", async () => {
    const { run, deps } = setup({ hangMs: 1_500 });
    const pending = dispatch(deps, input(run.id));
    const live = await waitFor(() => liveDispatches(run).find((d) => d.state === "running"));
    const proc = await waitFor(() => readProc(live.dir));
    process.kill(proc.supervisorPid, "SIGKILL");
    const { record } = await pending;
    expect(record).toMatchObject({ status: "failed", exitCode: null, error: { message: "lost, exit null" } });
    expect(readExit(live.dir)).toBeNull();
    expect(readRecords(run).records).toHaveLength(1);
  }, 30_000);

  it("refuses a name with no live dispatch", async () => {
    const { run, deps } = setup({});
    const e = await cancel(deps, run.id, "worker-M1.L1").catch((x: unknown) => x);
    expect(isCatherdError(e) && e.code).toBe("E_RUN_NOT_LIVE");
  });
});
