import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { newDispatchId } from "../../src/domain/ids.ts";
import type { RunRecord } from "../../src/domain/record.ts";
import type { RunEvent, RunEventInput } from "../../src/domain/run-events.ts";
import type { Action } from "../../src/domain/run-machine.ts";
import { logFile } from "../../src/infra/log.ts";
import { readJsonl } from "../../src/infra/store.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { launcher, watchersSettled } from "../../src/services/dispatch-service.ts";
import { liveDispatches } from "../../src/services/dispatches.ts";
import * as failoverRungs from "../../src/services/failover-rungs.ts";
import { openQuestions } from "../../src/services/questions.ts";
import { preflightUser } from "../../src/services/preflight.ts";
import { endedEvent, milestoneChecker, planOf, realEffects } from "../../src/services/run-effects.ts";
import {
  appendCheckRecord,
  type CheckRecord,
  machineGate,
  readChecks,
} from "../../src/services/milestone-check.ts";
import { heavyLimits } from "../../src/infra/heavy-lock.ts";
import { addKnowledge, knowledgePath } from "../../src/services/run-service.ts";
import { reapprovalQuestion } from "../../src/domain/plan-doc.ts";
import { appendEvent, readEvents, replayRun } from "../../src/services/run-events-store.ts";
import { writeRunReport } from "../../src/services/run-report.ts";
import { appendRecord, type Run, runPaths } from "../../src/services/run-store.ts";
import { commitInClone, repoWithOrigin, snapshotEnv, tempDir, tempRepo, withHome } from "../helpers.ts";
import { appendLedger, createRun } from "../../src/services/run-store.ts";
import { next } from "../../src/domain/run-machine.ts";
import { branchPusher, claimTree, memoryReader, treeDir, treeOf } from "../../src/services/milestone-tree.ts";
import { listDispatches } from "../../src/services/dispatches.ts";
import { PLAN, startedFields } from "../domain/run-fixtures.ts";
import { simPath, withScenario, type CodexScenario } from "../sim/scenario.ts";
import { withClaudeScenario } from "../sim/sim-scenarios.ts";
import {
  branchRun,
  fakeDeps,
  fakeDispatch,
  freshRun,
  makeRecord,
  passGate,
  testView,
  waitFor,
  writeLane,
} from "./helpers.ts";

afterEach(() => watchersSettled());
afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "claude-code");
const role = (access: "read-only" | "workspace-write", rungs: string[]) => ({
  enabled: true,
  access,
  rungs,
});

function setup(s: CodexScenario = { reply: "Done.\nSTATUS: complete — ok" }, view = testView()) {
  const { repo, run } = freshRun();
  process.env.PATH = simPath();
  const sim = withScenario(s);
  Object.assign(process.env, sim.env);
  view.roles.judge = role("read-only", ["codex:gpt-6-sol#high"]);
  view.roles.verifier = role("workspace-write", ["codex:gpt-6-sol#high"]);
  view.roles.researcher = role("read-only", ["codex:gpt-6-sol#high"]);
  const deps = fakeDeps({ view });
  return { repo, run, sim, deps, fx: realEffects(deps, run) };
}

const types = (run: Run): string[] => readEvents(run).map((e) => e.type);
const lastOf = <T extends RunEvent["type"]>(run: Run, type: T) =>
  readEvents(run).findLast((e): e is Extract<RunEvent, { type: T }> => e.type === type);

async function seed(run: Run, ...more: RunEventInput[]): Promise<void> {
  await appendEvent(run, { type: "run.started", ...startedFields });
  await appendEvent(run, { type: "plan.ready", milestones: PLAN });
  for (const e of more) await appendEvent(run, e);
}

const DEEP = [
  "# P",
  "## What already exists",
  "- `src/a.ts` — `a(): void` — the thing",
  "## Contracts",
  "`b(x: number): string`",
  "## Decisions",
  "D1 — use a map — rejected: an array — slower",
  "D2 — keep it flat — rejected: nesting — simpler",
  "## M1 — core",
  "- A1 it works",
  "### Task 1: do it",
  "Test: `test/a.test.ts` — asserts a",
  "",
].join("\n");

/** lanes that name a task of a plan.md deep enough to back them (preflight refuses any other) */
const WITH_TASK = "Kind: repo_code\nDifficulty: build\nTasks: 1\n";
function backed(run: Run): void {
  writeFileSync(join(run.dir, "plan.md"), DEEP);
}

const dispatchAction = (over: Partial<Extract<Action, { type: "dispatch" }>> = {}): Action => ({
  type: "dispatch",
  unit: "M1.L1",
  name: "worker-M1.L1",
  role: "worker",
  lane: "M1.L1",
  rung: "codex:gpt-6-luna#high",
  thread: null,
  failoverFrom: null,
  brief: "lane",
  notes: [],
  ...over,
});

const git = (repo: string, ...a: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], {
    cwd: repo,
    encoding: "utf8",
  });

function writeFile(repo: string, path: string, text = "x\n"): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

function withReply(run: Run, over: Partial<RunRecord>, reply: string): RunRecord {
  const dispatchId = over.dispatchId ?? newDispatchId();
  const name = over.name ?? "reviewer-M1";
  const replyPath = `roles/${name}/${dispatchId}/reply.md`;
  mkdirSync(join(run.dir, dirname(replyPath)), { recursive: true });
  writeFileSync(join(run.dir, replyPath), reply);
  return makeRecord({
    runId: run.id,
    dispatchId,
    name,
    replyPath,
    lane: null,
    ...over,
  });
}

describe("dispatching", () => {
  it("dispatches a lane, appending started then ended", async () => {
    const { run, deps, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"]);
    await seed(run);
    await fx.run(dispatchAction(), replayRun(run));
    const [started, ended] = readEvents(run).slice(2);
    expect(started).toMatchObject({
      type: "dispatch.started",
      name: "worker-M1.L1",
      rung: "codex:gpt-6-luna#high",
      lane: "M1.L1",
    });
    expect(ended).toMatchObject({
      type: "dispatch.ended",
      name: "worker-M1.L1",
      status: "ok",
      replyStatus: "complete",
      dispatchId: (started as { dispatchId: string }).dispatchId,
    });
    expect(liveDispatches(run, deps.now())).toEqual([]);
  });

  it("a cheap dispatch starts on the profile's cheapest rung", async () => {
    const { run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"]);
    await seed(run);
    await fx.run(
      dispatchAction({ rung: "codex:gpt-6-sol#medium", thread: null, cheap: true }),
      replayRun(run),
    );
    expect(lastOf(run, "dispatch.started")).toMatchObject({
      rung: "codex:gpt-6-luna#high",
      thread: null,
    });
  });

  it("a cheap dispatch with nothing cheaper keeps the lane's rung", async () => {
    const view = testView();
    view.roles.worker = role("workspace-write", ["codex:gpt-6-sol#medium"]);
    const { run, fx } = setup(undefined, view);
    writeLane(run, "M1.L1", ["src/a/"]);
    await seed(run);
    await fx.run(dispatchAction({ rung: "codex:gpt-6-sol#medium", cheap: true }), replayRun(run));
    expect(lastOf(run, "dispatch.started")).toMatchObject({ rung: "codex:gpt-6-sol#medium" });
  });

  it("dispatches headless, mapping claude: to claude-code:", async () => {
    const { run, fx } = setup();
    const sim = withClaudeScenario({ eventsFile: join(FX, "ok.jsonl") });
    Object.assign(process.env, sim.env);
    await seed(run);
    await fx.run(
      dispatchAction({
        unit: "run",
        name: "architect",
        role: "architect",
        lane: null,
        rung: "claude:claude-opus-5-5#high",
        brief: "architect",
      }),
      replayRun(run),
    );
    expect(lastOf(run, "dispatch.started")).toMatchObject({
      rung: "claude-code:claude-opus-5-5#high",
    });
    expect(lastOf(run, "dispatch.ended")).toMatchObject({
      name: "architect",
      status: "ok",
    });
    expect(sim.recorded().args).toContain("claude-opus-5-5");
  });

  it("turns an admission refusal into dispatch.refused with its code", async () => {
    const { run, repo, fx } = setup({ reply: "x" }, testView({ budget: { tokens: 300 } }));
    writeLane(run, "M1.L1", ["src/a/"]);
    await appendRecord(
      run,
      makeRecord({
        runId: run.id,
        name: "spent",
        lane: null,
        tokens: { input: 500, cached: 0, output: 0 },
      }),
    );
    await seed(run);
    await fx.run(dispatchAction(), replayRun(run));
    expect(lastOf(run, "dispatch.refused")).toMatchObject({
      name: "worker-M1.L1",
      unit: "M1.L1",
      code: "E_RUN_BUDGET",
    });
    expect(types(run)).not.toContain("dispatch.started");
    expect(existsSync(repo)).toBe(true);
  });

  it("an off-ladder rung is routed again", async () => {
    const { run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"]);
    await seed(run);
    await fx.run(dispatchAction({ rung: "codex:gpt-6-terra#max" }), replayRun(run));
    expect(lastOf(run, "lanes.routed")).toMatchObject({
      milestone: "M1",
      lanes: [{ lane: "M1.L1", rung: "codex:gpt-6-luna#high" }],
    });
    expect(lastOf(run, "dispatch.started")).toMatchObject({ rung: "codex:gpt-6-luna#high" });
    expect(types(run)).not.toContain("dispatch.refused");
  });

  it("a role off the profile is still refused", async () => {
    const view = testView();
    view.roles.worker = { enabled: false, access: "workspace-write", rungs: [] };
    const { run, fx } = setup(undefined, view);
    writeLane(run, "M1.L1", ["src/a/"]);
    await seed(run);
    await fx.run(dispatchAction({ rung: "codex:gpt-6-terra#max" }), replayRun(run));
    expect(lastOf(run, "dispatch.refused")).toMatchObject({ code: "E_ADMIT_RUNG" });
    expect(types(run)).not.toContain("lanes.routed");
    expect(types(run)).not.toContain("dispatch.started");
  });

  it("refuses with E_ALL_HELD when every rung of the role is on a held quota", async () => {
    const { run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"]);
    await seed(run);
    const s = replayRun(run);
    const until = new Date(Date.now() + 600_000).toISOString();
    s.holds = Object.fromEntries(
      ["codex", "opencode-go", "opencode", "claude-code", "cursor"].map((q) => [q, until]),
    );
    s.at = new Date().toISOString();
    await fx.run(dispatchAction({ failoverFrom: "codex:gpt-6-luna#high" }), s);
    expect(lastOf(run, "dispatch.refused")).toMatchObject({
      code: "E_ALL_HELD",
    });
  });

  describe("failover rows (plan 33)", () => {
    const failoverRows = (run: Run) =>
      readJsonl<{ source?: string }>(runPaths(run.dir).routes).rows.filter((r) => r?.source === "failover");
    const stateWithHolds = (run: Run, holds: Record<string, string>) => {
      const s = replayRun(run);
      s.holds = holds;
      s.at = new Date().toISOString();
      return s;
    };
    const until = () => new Date(Date.now() + 600_000).toISOString();

    it("writes a failover row for a failover, with the stand-in it chose", async () => {
      const { run, fx } = setup();
      const spy = spyOn(failoverRungs, "failoverRung").mockReturnValue("codex:gpt-6-sol#medium");
      try {
        writeLane(run, "M1.L1", ["src/a/"]);
        await seed(run);
        await fx.run(
          dispatchAction({
            lane: "M1.L1",
            failoverFrom: "opencode:opencode-go/gpt-6-luna#high",
          }),
          stateWithHolds(run, { "opencode-go": until() }),
        );
        expect(failoverRows(run)).toEqual([
          expect.objectContaining({
            lane: "M1.L1",
            role: "worker",
            name: "worker-M1.L1",
            from: "opencode:opencode-go/gpt-6-luna#high",
            rung: "codex:gpt-6-sol#medium",
            why: "failed over from opencode:opencode-go/gpt-6-luna#high to codex:gpt-6-sol#medium",
            held: ["opencode-go"],
          }),
        ]);
      } finally {
        spy.mockRestore();
      }
    });

    it("writes a failover row with no rung when every stand-in is held, then waits", async () => {
      const { run, fx } = setup();
      const spy = spyOn(failoverRungs, "failoverRung").mockReturnValue(null);
      try {
        writeLane(run, "M1.L1", ["src/a/"]);
        await seed(run);
        await fx.run(
          dispatchAction({ failoverFrom: "codex:gpt-6-sol#medium" }),
          stateWithHolds(run, { codex: until() }),
        );
        expect(failoverRows(run)).toEqual([
          expect.objectContaining({
            rung: null,
            why: "no stand-in for codex:gpt-6-sol#medium: every candidate is held or below it",
            held: ["codex"],
          }),
        ]);
        expect(lastOf(run, "dispatch.refused")).toMatchObject({
          code: "E_ALL_HELD",
        });
      } finally {
        spy.mockRestore();
      }
    });

    it("lists only the live holds on a failover row, not an expired one", async () => {
      const { run, fx } = setup();
      const spy = spyOn(failoverRungs, "failoverRung").mockReturnValue(null);
      try {
        writeLane(run, "M1.L1", ["src/a/"]);
        await seed(run);
        await fx.run(
          dispatchAction({ failoverFrom: "codex:gpt-6-sol#medium" }),
          stateWithHolds(run, {
            codex: until(),
            cursor: new Date(Date.now() - 600_000).toISOString(),
          }),
        );
        expect(failoverRows(run)).toEqual([expect.objectContaining({ held: ["codex"] })]);
      } finally {
        spy.mockRestore();
      }
    });

    it("writes a failover row when a lane-less role's routed rung sits on a held quota", async () => {
      const { run, fx } = setup();
      const spy = spyOn(failoverRungs, "failoverRung").mockReturnValue(
        "opencode:opencode-go/gpt-6-luna#high",
      );
      try {
        writeLane(run, "M1.L1", ["src/a/"]);
        await seed(run);
        await fx.run(
          dispatchAction({ lane: null, rung: "codex:gpt-6-luna#high" }),
          stateWithHolds(run, { codex: until() }),
        );
        expect(failoverRows(run)).toEqual([
          expect.objectContaining({
            lane: null,
            from: "codex:gpt-6-luna#high",
            rung: "opencode:opencode-go/gpt-6-luna#high",
            held: ["codex"],
          }),
        ]);
      } finally {
        spy.mockRestore();
      }
    });

    it("writes no failover row for a dispatch that is not a failover", async () => {
      const { run, fx } = setup();
      writeLane(run, "M1.L1", ["src/a/"]);
      await seed(run);
      await fx.run(dispatchAction(), replayRun(run));
      expect(failoverRows(run)).toEqual([]);
    });
  });

  it("asks the judge as a dispatch of role judge, and appends its decision before its end", async () => {
    const { run, fx } = setup({
      reply: "DECISION: answer\nANSWER: use the existing helper\nSTATUS: complete — ok",
    });
    writeLane(run, "M1.L1", ["src/a/"]);
    await seed(run);
    await fx.run(
      {
        type: "judge",
        input: {
          id: "9",
          kind: "question",
          unit: "M1.L1",
          context: "Lane M1.L1 stopped.",
          findings: [],
          lanes: [{ id: "M1.L1", owns: ["src/a/"] }],
        },
      },
      replayRun(run),
    );
    expect(types(run).slice(2)).toEqual(["dispatch.started", "judge.decided", "dispatch.ended"]);
    expect(readEvents(run)[2]).toMatchObject({
      role: "judge",
      name: "judge-9",
      judgeKind: "question",
    });
    expect(lastOf(run, "judge.decided")).toMatchObject({
      id: "9",
      unit: "M1.L1",
      kind: "question",
      decision: { verb: "answer", answer: "use the existing helper" },
    });
  });

  it("reports a judge reply it cannot read as judge.failed", async () => {
    const { run, fx } = setup({
      reply: "I think it is fine.\nSTATUS: complete — ok",
    });
    writeLane(run, "M1.L1", ["src/a/"]);
    await seed(run);
    await fx.run(
      {
        type: "judge",
        input: {
          id: "3",
          kind: "unexpected",
          unit: "M1.L1",
          context: "c",
          findings: [],
          lanes: [],
        },
      },
      replayRun(run),
    );
    expect(types(run).slice(2)).toEqual(["dispatch.started", "judge.failed", "dispatch.ended"]);
  });

  it("watches a dispatch a dead daemon started, and ends it", async () => {
    const { run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"]);
    const d = await fakeDispatch(
      run,
      { name: "worker-M1.L1", lane: "M1.L1", owns: ["src/a/"] },
      {
        proc: "dead",
        exit: {
          code: 0,
          signal: null,
          reason: "exited",
          endedAt: new Date().toISOString(),
        },
        reply: "Done.\nSTATUS: complete — ok",
        events: "",
        collect: true,
      },
    );
    await seed(run, {
      type: "dispatch.started",
      dispatchId: d.admit.dispatchId,
      name: "worker-M1.L1",
      role: "worker",
      unit: "M1.L1",
      lane: "M1.L1",
      rung: d.admit.rung,
      thread: null,
    });
    await fx.run({ type: "watch", dispatchId: d.admit.dispatchId }, replayRun(run));
    expect(lastOf(run, "dispatch.ended")).toMatchObject({
      dispatchId: d.admit.dispatchId,
      status: "ok",
    });
    // a second watch of an ended dispatch does nothing
    await fx.run({ type: "watch", dispatchId: d.admit.dispatchId }, replayRun(run));
    expect(types(run).filter((t) => t === "dispatch.ended")).toHaveLength(1);
  });

  it("adopts a finished dispatch the log never heard of instead of launching its name again", async () => {
    const { run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"]);
    const d = await fakeDispatch(
      run,
      { name: "worker-M1.L1", lane: "M1.L1", owns: ["src/a/"] },
      {
        proc: "dead",
        exit: {
          code: 0,
          signal: null,
          reason: "exited",
          endedAt: new Date().toISOString(),
        },
        reply: "Done.\nSTATUS: complete — ok",
        events: "",
        collect: true,
      },
    );
    await seed(run);
    await fx.run(dispatchAction(), replayRun(run));
    const id = d.admit.dispatchId;
    expect(types(run).slice(2)).toEqual(["dispatch.started", "dispatch.ended"]);
    expect(lastOf(run, "dispatch.started")).toMatchObject({ dispatchId: id });
    expect(lastOf(run, "dispatch.ended")).toMatchObject({
      dispatchId: id,
      status: "ok",
    });
    expect(replayRun(run).lanes["M1.L1"]?.status).toBe("checking");
  });

  it("launches nothing when the run is cancelled while the dispatch is being admitted", async () => {
    const { run, deps, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"]);
    await seed(run);
    const host = deps.host;
    // the last thing admission reads before it writes admit.json: the cancel lands right there
    Object.defineProperty(deps, "host", {
      get() {
        if (types(run).includes("cancel.requested") === false)
          void appendEvent(run, { type: "cancel.requested", by: "owner" });
        return host;
      },
    });
    const launches: string[] = [];
    const real = launcher.launch;
    launcher.launch = (d) => void launches.push(d.admit.name);
    try {
      await fx.run(dispatchAction(), replayRun(run));
    } finally {
      launcher.launch = real;
    }
    expect(launches).toEqual([]);
    expect(types(run).slice(2)).toEqual(["cancel.requested", "dispatch.refused"]);
    expect(lastOf(run, "dispatch.refused")).toMatchObject({
      name: "worker-M1.L1",
      code: "E_RUN_CANCELLED",
    });
    expect(replayRun(run).stuck).toEqual({});
    expect(liveDispatches(run, deps.now())).toEqual([]);
  });

  it("does not decide a judge's answer twice when the daemon died before dispatch.ended", async () => {
    const { run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"]);
    const d = await fakeDispatch(
      run,
      { name: "judge-9", role: "judge", lane: null, owns: [] },
      {
        proc: "dead",
        exit: {
          code: 0,
          signal: null,
          reason: "exited",
          endedAt: new Date().toISOString(),
        },
        reply: "DECISION: answer\nANSWER: use the existing helper\nSTATUS: complete — ok",
        events: "",
        collect: true,
      },
    );
    await seed(
      run,
      {
        type: "dispatch.started",
        dispatchId: d.admit.dispatchId,
        name: "judge-9",
        role: "judge",
        unit: "M1.L1",
        lane: null,
        rung: d.admit.rung,
        thread: null,
        judgeKind: "question",
      },
      {
        type: "judge.decided",
        id: "9",
        unit: "M1.L1",
        kind: "question",
        decision: { verb: "answer", answer: "use the existing helper" },
        dispatchId: d.admit.dispatchId,
      },
    );
    await fx.run({ type: "watch", dispatchId: d.admit.dispatchId }, replayRun(run));
    expect(types(run).slice(2)).toEqual(["dispatch.started", "judge.decided", "dispatch.ended"]);
  });

  it("cancels a live dispatch, which then ends cancelled", async () => {
    const { run, fx } = setup({
      reply: "x",
      holdUntil: join(freshHold(), "never"),
    });
    writeLane(run, "M1.L1", ["src/a/"]);
    await seed(run);
    const running = fx.run(dispatchAction(), replayRun(run));
    const started = await waitFor(() => lastOf(run, "dispatch.started"));
    await fx.run({ type: "cancel", dispatchIds: [started.dispatchId] }, replayRun(run));
    await running;
    expect(lastOf(run, "dispatch.ended")).toMatchObject({
      status: "cancelled",
    });
  });
});

function freshHold(): string {
  const dir = join(process.env.CATHERD_HOME ?? "", "hold");
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("what a dispatch said", () => {
  it("reads a reviewer's findings with their files, skipping none lines", () => {
    const { run } = freshRun();
    const record = withReply(
      run,
      { role: "reviewer" },
      "BLOCKER src/a.ts:3 — x — y\nBUG: none\nNIT b.md — z\nSTATUS: complete — done",
    );
    expect(endedEvent(run, record, "M1")).toMatchObject({
      type: "dispatch.ended",
      unit: "M1",
      verdict: null,
      findings: [
        { label: "BLOCKER", file: "src/a.ts" },
        { label: "NIT", file: "b.md" },
      ],
    });
  });

  it("reads a verifier's verdict as pass, fail or blocked", () => {
    const { run } = freshRun();
    const ended = (reply: string, over: Partial<RunRecord> = {}) =>
      endedEvent(run, withReply(run, { role: "verifier", name: "verifier-M1", ...over }, reply), "M1");
    expect(ended("VERDICT: PASS\nSTATUS: complete — ok")).toMatchObject({
      verdict: "pass",
      findings: [],
    });
    expect(ended("VERDICT: FAIL\n- FAIL bun test src/a fails\nSTATUS: complete — failed")).toMatchObject({
      verdict: "fail",
      findings: [{ label: "BLOCKER", text: "FAIL bun test src/a fails", file: "src/a" }],
    });
    expect(ended("VERDICT: FAIL\n- src/a.test.ts: 2 tests fail\nSTATUS: complete — failed")).toMatchObject({
      verdict: "fail",
      findings: [
        {
          label: "BLOCKER",
          text: "verifier FAIL listed no failing line: src/a.test.ts: 2 tests fail",
          file: "src/a.test.ts",
        },
      ],
    });
    expect(
      ended("VERDICT: BLOCKED: environment — docker ps says no daemon\nSTATUS: blocked — env"),
    ).toMatchObject({
      verdict: "blocked",
      environment: "docker ps says no daemon",
    });
    // plan 34: a PASS lists its NITs, and "NIT: none" is no issue
    expect(
      ended("VERDICT: PASS\nNIT src/v.ts:1 — v — w\nNIT: none\nHEAD: abc\nSTATUS: complete — ok"),
    ).toMatchObject({
      verdict: "pass",
      findings: [{ label: "NIT", text: "NIT src/v.ts:1 — v — w", file: "src/v.ts" }],
    });
    // a verdict wrapped in markdown is no verdict: the milestone gets a fix round, never a landing
    expect(ended("**VERDICT: PASS**\nSTATUS: complete — ok")).toMatchObject({
      verdict: "fail",
    });
    expect(ended("", { status: "failed" })).toMatchObject({ verdict: null });
  });
});

describe("what a stop says (30b)", () => {
  it("puts the reply's reason and HEAD on dispatch.ended", () => {
    const { run } = freshRun();
    const stopped = withReply(
      run,
      {
        role: "worker",
        name: "worker-M1.L1",
        lane: "M1.L1",
        replyStatus: "blocked",
        replyWhy: "too_hard: no luck",
      },
      "nothing\nSTATUS: blocked — too_hard: no luck",
    );
    expect(endedEvent(run, stopped, "M1.L1")).toMatchObject({
      reason: "too_hard",
      head: null,
    });
    const head = "0123456789abcdef0123456789abcdef01234567";
    const verdict = withReply(
      run,
      { role: "verifier", name: "verifier-M1", head },
      `VERDICT: PASS\nHEAD: ${head}\nSTATUS: complete — ok`,
    );
    expect(endedEvent(run, verdict, "M1")).toMatchObject({
      verdict: "pass",
      head,
      reason: null,
    });
    // a complete reply has no reason, whatever its why says
    const done = withReply(run, { role: "worker", replyStatus: "complete", replyWhy: "too_hard" }, "x");
    expect(endedEvent(run, done, "M1.L1")).toMatchObject({ reason: null });
  });

  it("check.ran names the blamed sibling lanes", async () => {
    const { run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a.ts"], "echo 'src/a.ts:1 error'; echo 'src/b.ts:3 error'; exit 1");
    writeLane(run, "M1.L2", ["src/b.ts"]);
    await seed(run);
    await fx.run({ type: "fastCheck", lane: "M1.L1" }, replayRun(run));
    expect(lastOf(run, "check.ran")).toMatchObject({
      exit: 1,
      foreign: [],
      siblings: ["M1.L2"],
    });
  });

  it("names only sibling files as foreign, for a check_broken lane and for its failed fast check", async () => {
    const { run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a.ts"], "echo 'src/b.ts:3 error: unused'; exit 1");
    writeLane(run, "M1.L2", ["src/b.ts"]);
    await seed(run);
    const broken = withReply(
      run,
      {
        role: "worker",
        name: "worker-M1.L1",
        lane: "M1.L1",
        replyStatus: "blocked",
        replyWhy: "check_broken: src/b.ts:3 fails",
      },
      "src/b.ts:3 error\nSTATUS: blocked — check_broken: src/b.ts:3 fails",
    );
    expect(endedEvent(run, broken, "M1.L1")).toMatchObject({
      reason: "check_broken",
      foreign: ["src/b.ts"],
      siblings: ["M1.L2"],
    });
    await fx.run({ type: "fastCheck", lane: "M1.L1" }, replayRun(run));
    expect(lastOf(run, "check.ran")).toMatchObject({
      exit: 1,
      foreign: ["src/b.ts"],
    });
  });
});

describe("classifying a stop (30b)", () => {
  const stoppedRun = async (deps: ReturnType<typeof setup>["deps"], run: Run) => {
    await seed(run);
    const r = withReply(
      run,
      {
        role: "worker",
        name: "worker-M1.L1",
        lane: "M1.L1",
        replyStatus: "blocked",
        replyWhy: "stuck",
      },
      "stuck\nSTATUS: blocked — stuck",
    );
    await appendRecord(run, r);
    return r.dispatchId;
  };

  it("classifies a stop with no reason through Jev, once", async () => {
    const { run, deps, fx } = setup();
    let calls = 0;
    deps.routing.stopCause = async () => (
      calls++,
      { value: "needs_user", probability: 0.91, confidence: 0.5, source: "jev" }
    );
    const dispatchId = await stoppedRun(deps, run);
    await fx.run({ type: "classify", dispatchId }, replayRun(run));
    expect(lastOf(run, "stop.classified")).toEqual(
      expect.objectContaining({ dispatchId, reason: "needs_user" }),
    );
    expect(calls).toBe(1);
  });

  it("classifies to null with Jev off, for other, or for an unsure answer", async () => {
    const { run, deps, fx } = setup();
    deps.routing.stopCause = async () => ({
      value: "other",
      probability: 0.9,
      confidence: 1,
      source: "jev",
    });
    const dispatchId = await stoppedRun(deps, run);
    await fx.run({ type: "classify", dispatchId }, replayRun(run));
    expect(lastOf(run, "stop.classified")?.reason).toBeNull();
    deps.routing.stopCause = async () => ({
      value: "too_hard",
      probability: 0.5,
      confidence: 1,
      source: "default",
    });
    await fx.run({ type: "classify", dispatchId }, replayRun(run));
    expect(lastOf(run, "stop.classified")?.reason).toBeNull();
    // off: the routing port answers its default without a call, and the effect still appends null
    deps.view.jev = { use: "off" };
    let usedOff = false;
    deps.routing.stopCause = async (_d, _s, _r, use) => {
      usedOff = use === "off";
      return {
        value: "other",
        probability: null,
        confidence: null,
        source: "default",
      };
    };
    await fx.run({ type: "classify", dispatchId }, replayRun(run));
    expect(lastOf(run, "stop.classified")?.reason).toBeNull();
    expect(usedOff).toBe(true);
  });
});

describe("planning", () => {
  it("builds the plan from lanes/*.md and plan.md's milestone headings", () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a/"]);
    writeLane(
      run,
      "M1.L2",
      ["src/b/", "src/b2.ts"],
      "true",
      "Kind: repo_code\nDifficulty: build\nAfter: M1.L1\n",
    );
    writeLane(run, "M1.L10", ["src/c/"]);
    writeLane(run, "M2.L1", ["docs/"], "true", "Kind: prose\nDifficulty: copy\n");
    writeLane(run, "M3.L1", ["notes/"], "true", "Kind: research\nDifficulty: copy\n");
    writeFileSync(
      join(run.dir, "plan.md"),
      "# plan\n\n## M1 — the wallet core\nfull check: bun test\n\n## M2 — the docs\nAfter: M1\nfull check: true\n",
    );
    const plan = planOf(run);
    expect(plan.map((m) => [m.id, m.title, m.after])).toEqual([
      ["M1", "the wallet core", []],
      ["M2", "the docs", ["M1"]],
      ["M3", "M3", []],
    ]);
    expect(plan[0]?.lanes.map((l) => l.id)).toEqual(["M1.L1", "M1.L2", "M1.L10"]);
    expect(plan[0]?.lanes[1]).toEqual({
      id: "M1.L2",
      role: "worker",
      kind: "repo_code",
      after: ["M1.L1"],
      owns: ["src/b/", "src/b2.ts"],
    });
    expect(plan[1]?.lanes[0]).toMatchObject({ role: "writer", kind: "prose" });
    expect(plan[2]?.lanes[0]).toMatchObject({
      role: "researcher",
      kind: "research",
    });
  });

  it("fails with a reason when the architect wrote no lane files", async () => {
    const { run, fx } = setup();
    await seed(run);
    await fx.run({ type: "readPlan" }, replayRun(run));
    expect(lastOf(run, "effect.failed")).toMatchObject({
      action: "readPlan",
      unit: "run",
      message: "the architect wrote no lane files",
    });
  });

  it("reads the plan into plan.ready", async () => {
    const { run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"], "true", "Kind: repo_code\nDifficulty: build\nTasks: 1\n");
    writeFileSync(join(run.dir, "plan.md"), DEEP);
    await appendEvent(run, { type: "run.started", ...startedFields });
    await fx.run({ type: "readPlan" }, replayRun(run));
    expect(lastOf(run, "plan.ready")?.milestones).toMatchObject([{ id: "M1", lanes: [{ id: "M1.L1" }] }]);
  });

  function dependencyPlan(run: Run, after: string): void {
    for (const id of ["M1", "M2", "M3"]) writeLane(run, `${id}.L1`, [`src/${id}/`], "true", WITH_TASK);
    writeFileSync(join(run.dir, "plan.md"), `${DEEP}\n## M2 — next\nAfter: ${after}\n## M3 — independent\n`);
  }

  it("a plan.md After wider than the owner's plan parks for approval", async () => {
    const { run, fx } = setup();
    dependencyPlan(run, "M1, M3");
    mkdirSync(join(run.dir, "plan-input"));
    writeFileSync(join(run.dir, "plan-input", "owner.md"), `${DEEP}\n## M2 — next\nAfter: M1\n`);
    await appendEvent(run, {
      type: "run.started",
      ...startedFields,
      plan: ["owner.md"],
    });
    await fx.run({ type: "readPlan" }, replayRun(run));
    const question = lastOf(run, "question.parked");
    expect(question).toMatchObject({ unit: "run", reason: "approval" });
    expect(question?.question).toContain("M2");
    expect(question?.question).toContain("M3");
    expect(types(run).slice(-2)).toEqual(["question.parked", "plan.ready"]);
  });

  it("keeps first-read dependency approval pending when the owner requests revision", async () => {
    const { run, fx } = setup();
    dependencyPlan(run, "M1, M3");
    mkdirSync(join(run.dir, "plan-input"));
    writeFileSync(join(run.dir, "plan-input", "owner.md"), `${DEEP}\n## M2 — next\nAfter: M1\n`);
    await appendEvent(run, {
      type: "run.started",
      ...startedFields,
      plan: ["owner.md"],
    });
    await fx.run({ type: "readPlan" }, replayRun(run));
    expect(replayRun(run).phase).toBe("approval");
    await appendEvent(run, {
      type: "question.answered",
      unit: "run",
      answer: "remove M3",
      by: "owner",
    });
    const actions = next(replayRun(run), lastOf(run, "question.answered")!);
    expect(actions.some((a) => a.type === "route")).toBe(false);
    expect(actions).toContainEqual(expect.objectContaining({ type: "dispatch", name: "architect" }));
  });

  it("uses an approved dependency section instead of the older owner input", async () => {
    const { run, fx } = setup();
    dependencyPlan(run, "M1, M3");
    mkdirSync(join(run.dir, "plan-input"));
    writeFileSync(join(run.dir, "plan-input", "owner.md"), `${DEEP}\n## M2 — next\nAfter: M1\n`);
    await appendEvent(run, {
      type: "run.started",
      ...startedFields,
      plan: ["owner.md"],
    });
    await fx.run({ type: "readPlan" }, replayRun(run));
    writeFileSync(join(run.dir, "plan-approved.md"), readFileSync(join(run.dir, "plan.md")));
    await appendEvent(run, { type: "plan.approved", by: "owner" });
    const before = readEvents(run).length;
    await fx.run({ type: "readPlan" }, replayRun(run));
    expect(
      readEvents(run)
        .slice(before)
        .map((e) => e.type),
    ).toEqual(["plan.ready"]);
  });

  it("an After equal to the owner's plan does not park", async () => {
    const { run, fx } = setup();
    dependencyPlan(run, "M1");
    mkdirSync(join(run.dir, "plan-input"));
    writeFileSync(join(run.dir, "plan-input", "owner.md"), readFileSync(join(run.dir, "plan.md")));
    await appendEvent(run, {
      type: "run.started",
      ...startedFields,
      plan: ["owner.md"],
    });
    await fx.run({ type: "readPlan" }, replayRun(run));
    expect(lastOf(run, "question.parked")).toBeUndefined();
    expect(lastOf(run, "plan.ready")).toBeDefined();
  });

  it("compares After to plan-approved.md without plan inputs, allowing narrower dependencies", async () => {
    const { run, fx } = setup();
    dependencyPlan(run, "M1");
    writeFileSync(join(run.dir, "plan-approved.md"), readFileSync(join(run.dir, "plan.md")));
    await appendEvent(run, { type: "run.started", ...startedFields });
    dependencyPlan(run, "none");
    await fx.run({ type: "readPlan" }, replayRun(run));
    expect(lastOf(run, "question.parked")).toBeUndefined();
    dependencyPlan(run, "M1, M3");
    await fx.run({ type: "readPlan" }, replayRun(run));
    expect(lastOf(run, "question.parked")?.question).toContain("M2 now waits for M3");
  });

  it("fails readPlan with the plan's problems, and reads it once it is deep enough", async () => {
    const { run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"]);
    writeFileSync(join(run.dir, "plan.md"), "# P\n## M1 — core\n");
    await appendEvent(run, { type: "run.started", ...startedFields });
    await fx.run({ type: "readPlan" }, replayRun(run));
    const failed = lastOf(run, "effect.failed");
    expect(failed).toMatchObject({ action: "readPlan", unit: "run" });
    expect(failed?.message).toStartWith("the plan needs: lanes/M1.L1.md has no Tasks: line");
    expect(failed?.message).toContain('plan.md has no "## Contracts" section');
    expect(lastOf(run, "plan.ready")).toBeUndefined();
    writeLane(run, "M1.L1", ["src/a/"], "true", "Kind: repo_code\nDifficulty: build\nTasks: 1\n");
    writeFileSync(join(run.dir, "plan.md"), DEEP);
    await fx.run({ type: "readPlan" }, replayRun(run));
    expect(lastOf(run, "plan.ready")).toBeDefined();
  });

  it("sends a plan that leaves an A-line without a milestone back to the architect, naming it", async () => {
    const { run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"], "true", WITH_TASK);
    writeLane(run, "M2.L1", ["src/b/"], "true", WITH_TASK);
    writeFileSync(join(run.dir, "plan.md"), `${DEEP.replace("- A1 it works\n", "")}\n## M2 — docs\n`);
    await appendEvent(run, { type: "run.started", ...startedFields });
    await fx.run({ type: "readPlan" }, replayRun(run));
    expect(lastOf(run, "effect.failed")?.message).toContain("A1 is cited under no milestone");
    expect(lastOf(run, "plan.ready")).toBeUndefined();
  });

  it("refuses a plan whose lane After: lines make milestones wait on each other, until the run parks", async () => {
    const { run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"], "true", `${WITH_TASK}After: M2.L1\n`);
    writeLane(run, "M2.L1", ["src/b/"], "true", `${WITH_TASK}After: M1.L1\n`);
    backed(run);
    await appendEvent(run, { type: "run.started", ...startedFields });
    for (let i = 0; i < 3; i++) await fx.run({ type: "readPlan" }, replayRun(run));
    expect(lastOf(run, "effect.failed")?.message).toContain("cycle M1 → M2 → M1");
    expect(lastOf(run, "plan.ready")).toBeUndefined();
    expect(replayRun(run).stuck.run?.question).toContain("cycle M1 → M2 → M1");
  });

  it("refuses a plan whose milestone waits on one the plan does not have", async () => {
    const { run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"], "true", `${WITH_TASK}After: M7\n`);
    backed(run);
    await appendEvent(run, { type: "run.started", ...startedFields });
    await fx.run({ type: "readPlan" }, replayRun(run));
    expect(lastOf(run, "effect.failed")?.message).toContain("M1: After: M7 is no milestone of the plan");
    expect(lastOf(run, "plan.ready")).toBeUndefined();
  });

  it("parks again for approval when an architect change edits a decision, and not otherwise", async () => {
    const { run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"], "true", "Kind: repo_code\nDifficulty: build\nTasks: 1\n");
    writeFileSync(join(run.dir, "plan.md"), DEEP);
    await appendEvent(run, { type: "run.started", ...startedFields });
    // no plan-approved.md: nothing to compare with
    await fx.run({ type: "readPlan" }, replayRun(run));
    expect(types(run).filter((t) => t === "question.parked")).toEqual([]);
    writeFileSync(join(run.dir, "plan-approved.md"), DEEP);
    // a task text edit: no stop
    writeFileSync(join(run.dir, "plan.md"), DEEP.replace("asserts a", "asserts a, b"));
    await fx.run({ type: "readPlan" }, replayRun(run));
    expect(types(run).filter((t) => t === "question.parked")).toEqual([]);
    // a decision edit: parks first, then plan.ready
    writeFileSync(join(run.dir, "plan.md"), DEEP.replace("D2 — keep it flat", "D2 — nest it"));
    await fx.run({ type: "readPlan" }, replayRun(run));
    const tail = readEvents(run).slice(-2);
    expect(tail.map((e) => e.type)).toEqual(["question.parked", "plan.ready"]);
    expect(tail[0]).toMatchObject({
      unit: "run",
      reason: "approval",
      question: reapprovalQuestion(run.id, ["D2"]),
    });
  });
});

describe("routing, checking, committing, landing", () => {
  it("routes and preflights one milestone's lanes", async () => {
    const { run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"], "true", WITH_TASK);
    writeLane(run, "M1.L2", ["src/b/"], "true", WITH_TASK);
    backed(run);
    await seed(run);
    await fx.run({ type: "route", milestone: "M1", confirmed: false }, replayRun(run));
    expect(lastOf(run, "lanes.routed")).toMatchObject({
      milestone: "M1",
      lanes: [{ lane: "M1.L1", rung: "codex:gpt-6-luna#high" }, { lane: "M1.L2" }],
    });
    expect(lastOf(run, "preflight.done")).toMatchObject({
      milestone: "M1",
      blocking: [],
      confirm: null,
    });
  });

  it("copies preflight's lint onto preflight.done (plan 34)", async () => {
    const { run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"], "true", WITH_TASK);
    writeLane(run, "M1.L2", ["src/b/"], "true", WITH_TASK);
    backed(run);
    await seed(run);
    await fx.run({ type: "route", milestone: "M1", confirmed: false }, replayRun(run));
    // plan 40 D11: a milestone with no Check: line is warned, never refused
    expect(lastOf(run, "preflight.done")?.lint).toEqual([
      "M1.L1: Owns names whole folders (src/a/): name the files, unless the lane creates the folder",
      "M1.L2: Owns names whole folders (src/b/): name the files, unless the lane creates the folder",
      "M1: no Check: line: the verifier must run the whole gate by hand",
    ]);
  });

  it("asks for confirmation when the profile wants the commands confirmed first", async () => {
    const { run, fx } = setup({ reply: "x" }, testView({ preflight: { confirm: true } }));
    writeLane(run, "M1.L1", ["src/a/"], "bun test src/a", WITH_TASK);
    writeLane(run, "M1.L2", ["src/b/"], "true", WITH_TASK);
    backed(run);
    await seed(run);
    await fx.run({ type: "route", milestone: "M1", confirmed: false }, replayRun(run));
    expect(lastOf(run, "preflight.done")?.confirm).toEqual(["M1.L1: bun test src/a", "M1.L2: true"]);
  });

  it("names a lane whose check cannot start as blocking", async () => {
    const { run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"], "no-such-command-anywhere", WITH_TASK);
    writeLane(run, "M1.L2", ["src/b/"], "true", WITH_TASK);
    backed(run);
    await seed(run);
    const uid = spyOn(preflightUser, "uid").mockReturnValue(1000);
    try {
      await fx.run({ type: "route", milestone: "M1", confirmed: false }, replayRun(run));
      expect(lastOf(run, "preflight.done")?.blocking).toMatchObject([{ lane: "M1.L1" }]);
    } finally {
      uid.mockRestore();
    }
  });

  it("runs a fast check and reports its exit and tail", async () => {
    const { run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"], "echo red-line >&2; exit 3");
    writeLane(run, "M1.L2", ["src/b/"], "echo green");
    await seed(run);
    await fx.run({ type: "fastCheck", lane: "M1.L1" }, replayRun(run));
    await fx.run({ type: "fastCheck", lane: "M1.L2" }, replayRun(run));
    const [red, green] = readEvents(run).filter((e) => e.type === "check.ran");
    expect(red).toMatchObject({ lane: "M1.L1", exit: 3 });
    expect((red as { tail: string }).tail).toContain("red-line");
    expect(green).toMatchObject({ lane: "M1.L2", exit: 0 });
  });

  it("check.ran carries its start, duration and wait, and the duration fits between its neighbours", async () => {
    const { run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"], "sleep 0.2");
    await seed(run);
    await fx.run({ type: "fastCheck", lane: "M1.L1" }, replayRun(run));
    const events = readEvents(run);
    const at = events.findIndex((e) => e.type === "check.ran");
    const ran = events[at] as Extract<RunEvent, { type: "check.ran" }>;
    expect(ran).toMatchObject({ lane: "M1.L1", exit: 0 });
    expect(Date.parse(ran.startedAt ?? "")).toBeGreaterThan(0);
    expect(ran.durationMs).toBeGreaterThanOrEqual(150);
    expect(ran.waitedMs).toBeGreaterThanOrEqual(0);
    expect(ran.durationMs).toBeLessThanOrEqual(
      Date.parse(ran.at) - Date.parse((events[at - 1] as RunEvent).at),
    );
  });

  it("fastCheck records the worktree identity it checked", async () => {
    const { run, fx } = await treesSetup();
    writeLane(run, "M1.L1", ["src/a/"], "echo red-line >&2; exit 3");
    writeLane(run, "M1.L2", ["src/b/"], "");
    const { tree } = await claimM(run, "M1");
    await treeReady(run, "M1");

    await fx.run({ type: "fastCheck", lane: "M1.L1" }, replayRun(run));
    const first = lastOf(run, "check.ran");
    expect(first).toMatchObject({ lane: "M1.L1", exit: 3 });
    expect(typeof first?.tree).toBe("string");
    await fx.run({ type: "fastCheck", lane: "M1.L1" }, replayRun(run));
    expect(lastOf(run, "check.ran")?.tree).toBe(first?.tree);

    writeFile(tree, "src/a/new.ts", "changed\n");
    await fx.run({ type: "fastCheck", lane: "M1.L1" }, replayRun(run));
    const changed = lastOf(run, "check.ran");
    expect(changed).toMatchObject({ lane: "M1.L1", exit: 3 });
    expect(typeof changed?.tree).toBe("string");
    expect(changed?.tree).not.toBe(first?.tree);

    await fx.run({ type: "fastCheck", lane: "M1.L2" }, replayRun(run));
    const unchecked = lastOf(run, "check.ran");
    expect(unchecked).toMatchObject({
      lane: "M1.L2",
      exit: 0,
      tail: "the lane has no fast check",
    });
    expect(unchecked).not.toHaveProperty("tree");
  });

  it("counts an absence check whose only hits are the lane's Allow: exceptions as passed", async () => {
    const { run, fx } = setup();
    writeLane(
      run,
      "M1.L1",
      ["src/a/"],
      "echo 'src/x.ts:3: foo'; exit 1",
      "Kind: repo_code\nDifficulty: build\nAllow: src/x.ts:3\n",
    );
    writeLane(
      run,
      "M1.L2",
      ["src/b/"],
      "echo 'src/x.ts:9: foo'; exit 1",
      "Kind: repo_code\nDifficulty: build\nAllow: src/x.ts:3\n",
    );
    await seed(run);
    await fx.run({ type: "fastCheck", lane: "M1.L1" }, replayRun(run));
    await fx.run({ type: "fastCheck", lane: "M1.L2" }, replayRun(run));
    expect(readEvents(run).filter((e) => e.type === "check.ran")).toMatchObject([{ exit: 0 }, { exit: 1 }]);
  });

  it("commits only the milestone's owned and changed paths", async () => {
    const { run, repo, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"]);
    writeLane(run, "M1.L2", ["src/b2.ts"]);
    writeFile(repo, "src/a/x.ts");
    writeFile(repo, "src/b2.ts");
    writeFile(repo, "stray.txt");
    await seed(run);
    await fx.run({ type: "commit", milestone: "M1", round: 0 }, replayRun(run));
    const made = lastOf(run, "commit.made");
    expect(made).toMatchObject({
      milestone: "M1",
      round: 0,
      commit: git(repo, "rev-parse", "HEAD").trim(),
    });
    expect(git(repo, "log", "-1", "--format=%s")).toBe("feat: the wallet core\n");
    expect(git(repo, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort()).toEqual([
      "src/a/x.ts",
      "src/b2.ts",
    ]);
    expect(git(repo, "status", "--porcelain")).toBe("?? stray.txt\n");
  });

  it("leaves work that was already staged outside the milestone's paths staged", async () => {
    const { run, repo, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"]);
    writeFile(repo, "src/a/x.ts");
    writeFile(repo, "other.ts");
    git(repo, "add", "other.ts");
    await seed(run);
    await fx.run({ type: "commit", milestone: "M1", round: 0 }, replayRun(run));
    expect(git(repo, "show", "--name-only", "--format=", "HEAD")).toBe("src/a/x.ts\n");
    expect(git(repo, "status", "--porcelain")).toBe("A  other.ts\n");
  });

  it("commits a fix round under a fix subject, adding what a record says the lane changed", async () => {
    const { run, repo, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"]);
    writeLane(run, "M1.L2", ["src/b/"]);
    writeFile(repo, "src/a/x.ts");
    writeFile(repo, "elsewhere.ts");
    await appendRecord(
      run,
      makeRecord({
        runId: run.id,
        name: "worker-M1.L1",
        lane: "M1.L1",
        changedOwned: [],
        violations: ["elsewhere.ts"],
      }),
    );
    await seed(run);
    await fx.run({ type: "commit", milestone: "M1", round: 2 }, replayRun(run));
    expect(git(repo, "log", "-1", "--format=%s")).toBe("fix: the wallet core, review round 2\n");
    expect(git(repo, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean).sort()).toEqual([
      "elsewhere.ts",
      "src/a/x.ts",
    ]);
  });

  it("names HEAD when nothing is left to commit", async () => {
    const { run, repo, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"]);
    await seed(run);
    await fx.run({ type: "commit", milestone: "M1", round: 1 }, replayRun(run));
    expect(lastOf(run, "commit.made")?.commit).toBe(git(repo, "rev-parse", "HEAD").trim());
  });

  it("an ignored Owns path does not fail the commit", async () => {
    const { repo, run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/", "ignored.txt"]);
    writeFile(repo, ".gitignore", "ignored.txt\n");
    writeFile(repo, "ignored.txt");
    writeFile(repo, "src/a/x.ts");
    await seed(run);
    await fx.run({ type: "commit", milestone: "M1", round: 0 }, replayRun(run));
    expect(types(run)).not.toContain("commit.failed");
    expect(lastOf(run, "commit.made")).toMatchObject({
      milestone: "M1",
      round: 0,
    });
    expect(git(repo, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean)).toEqual([
      "src/a/x.ts",
    ]);
  });

  it("reports a failing hook with its output", async () => {
    const { run, repo, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"]);
    writeFile(repo, "src/a/x.ts");
    const hook = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho 'lint says no' >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    await seed(run);
    await fx.run({ type: "commit", milestone: "M1", round: 0 }, replayRun(run));
    expect(types(run)).not.toContain("commit.made");
    expect(lastOf(run, "commit.failed")?.tail).toContain("lint says no");
  });

  it("lands through land(), and reports its refusal with code and fix", async () => {
    const { run, repo, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"]);
    writeFile(repo, "src/a/x.ts");
    const commit =
      (git(repo, "add", "-A"), git(repo, "commit", "-q", "-m", "c"), git(repo, "rev-parse", "HEAD").trim());
    await seed(run, { type: "commit.made", milestone: "M1", round: 0, commit });
    const action: Action = {
      type: "land",
      milestone: "M1",
      knownIssues: ["a nit stays"],
    };
    await fx.run(action, replayRun(run));
    expect(lastOf(run, "land.refused")).toMatchObject({
      milestone: "M1",
      code: "E_LAND_GATE",
    });
    expect(lastOf(run, "land.refused")?.fix).not.toBe("");
    await passGate(run, "M1");
    await daemonPass(run, "M1");
    await fx.run(action, replayRun(run));
    const landed = lastOf(run, "milestone.landed");
    expect(landed).toMatchObject({
      milestone: "M1",
      commit,
      knownIssues: ["a nit stays"],
    });
    expect(existsSync(landed?.digestPath ?? "")).toBe(true);
    expect(readFileSync(join(run.dir, "ledger.md"), "utf8")).toContain(
      `verifier-M1 PASS on ${commit.slice(0, 12)}`,
    );
  });

  it("climbs a lane one rung and says whether it reached the top", async () => {
    const { run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"]);
    writeLane(run, "M1.L2", ["src/b/"]);
    await seed(run);
    await fx.run({ type: "route", milestone: "M1", confirmed: false }, replayRun(run));
    await fx.run({ type: "climb", lane: "M1.L1", reason: "unchanged" }, replayRun(run));
    expect(lastOf(run, "lane.climbed")).toMatchObject({
      lane: "M1.L1",
      rung: "codex:gpt-6-sol#medium",
      top: false,
    });
  });
});

/** A run whose repo has a bare origin and whose base is main; M1's lane file and one commit of its own. */
async function baseSetup() {
  const { repo, origin } = repoWithOrigin();
  const s = setup();
  withHome();
  const run = createRun({
    repo,
    title: "t",
    aLines: ["A1 it works"],
    version: "0.0.0-test",
  });
  const fx = realEffects(s.deps, run);
  writeLane(run, "M1.L1", ["src/a/"]);
  writeFile(repo, "src/a/x.ts", "mine\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "c");
  const commit = git(repo, "rev-parse", "HEAD").trim();
  await appendEvent(run, {
    type: "run.started",
    ...startedFields,
    base: "main",
  });
  await appendEvent(run, { type: "plan.ready", milestones: PLAN });
  await appendEvent(run, {
    type: "commit.made",
    milestone: "M1",
    round: 0,
    commit,
  });
  return { repo, origin, run, fx, commit };
}
const land1: Action = { type: "land", milestone: "M1", knownIssues: [] };

/**
 * The daemon's verdict on the milestone's commit, as its log holds it: a clean reviewer, then the verifier's PASS. A
 * daemon run's land gate reads these (plan 40 D1), beside the records `passGate` writes.
 */
async function daemonPass(run: Run, m: string): Promise<void> {
  const head = replayRun(run).milestones.find((x) => x.id === m)?.commit ?? null;
  for (const [name, role, verdict] of [
    [`reviewer-${m}`, "reviewer", null],
    [`verifier-${m}`, "verifier", "pass"],
  ] as const) {
    const dispatchId = newDispatchId();
    await appendEvent(run, {
      type: "dispatch.started",
      dispatchId,
      name,
      role,
      unit: m,
      lane: null,
      rung: "codex:gpt-6-sol#high",
      thread: null,
    });
    await appendEvent(run, {
      type: "dispatch.ended",
      dispatchId,
      name,
      unit: m,
      status: "ok",
      replyStatus: "complete",
      reason: null,
      why: "done",
      thread: null,
      head,
      environment: null,
      verdict,
      findings: [],
      foreign: [],
      replyPath: "",
    });
  }
}

describe("a run with a base branch (30b)", () => {
  it("land reports base.behind when origin moved, and lands when it did not", async () => {
    const { repo, origin, run, fx, commit } = await baseSetup();
    commitInClone(origin, "moved");
    await fx.run(land1, replayRun(run));
    expect(types(run)).toContain("base.behind");
    expect(types(run)).not.toContain("milestone.landed");
    expect(types(run)).not.toContain("land.refused");
    // the base is in: the merge is what lands
    await fx.run({ type: "integrate", milestone: "M1" }, replayRun(run));
    const merged = lastOf(run, "integrate.done");
    expect(merged?.commit).toBe(git(repo, "rev-parse", "HEAD").trim());
    expect(git(repo, "log", "-1", "--format=%P").trim().split(" ")).toHaveLength(2);
    expect(git(repo, "log", "-1", "--format=%s")).toBe("Merge origin/main into main\n");
    await passGate(run, "M1");
    await appendEvent(run, {
      type: "commit.made",
      milestone: "M1",
      round: 1,
      commit: merged?.commit ?? "",
    });
    await daemonPass(run, "M1");
    await fx.run(land1, replayRun(run));
    expect(lastOf(run, "milestone.landed")).toMatchObject({
      milestone: "M1",
      commit: merged?.commit,
      branch: "main",
    });
    expect(commit).not.toBe(merged?.commit);
  });

  it("lands without a merge when origin did not move", async () => {
    const { run, fx, commit } = await baseSetup();
    await passGate(run, "M1");
    await daemonPass(run, "M1");
    await fx.run(land1, replayRun(run));
    expect(types(run)).not.toContain("base.behind");
    expect(lastOf(run, "milestone.landed")).toMatchObject({
      milestone: "M1",
      commit,
    });
  });

  it("land evidence keeps the outcome when a stale land action runs after cancellation", async () => {
    const { run, fx } = await baseSetup();
    await passGate(run, "M1");
    await daemonPass(run, "M1");
    const beforeFinish = replayRun(run);
    await fx.run({ type: "finish", outcome: "cancelled" }, beforeFinish);
    await fx.run(land1, beforeFinish);
    expect(lastOf(run, "milestone.landed")).toMatchObject({ milestone: "M1" });
    const text = readFileSync(join(run.dir, "state.md"), "utf8");
    expect(text).toContain("cancelled");
    expect(text).not.toContain("the daemon continues");
  });

  it("works from the last fetch when origin cannot be reached, and says so", async () => {
    const { repo, run, fx } = await baseSetup();
    git(repo, "remote", "set-url", "origin", join(repo, "no-such-origin"));
    await passGate(run, "M1");
    await daemonPass(run, "M1");
    await fx.run(land1, replayRun(run));
    expect(lastOf(run, "milestone.landed")).toMatchObject({ milestone: "M1" });
    expect(readFileSync(join(run.dir, "ledger.md"), "utf8")).toContain(
      "fetch of origin/main failed: using the copy from the last fetch",
    );
  });

  it("integrate updates submodules", async () => {
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
    process.env.GIT_CONFIG_VALUE_0 = "always";
    const { repo, origin, run, fx } = await baseSetup();
    const sub = tempRepo();
    const bump = (name: string): string => {
      const clone = tempDir("catherd-clone-");
      git(clone, "clone", "-q", origin, ".");
      if (existsSync(join(clone, ".gitmodules"))) git(clone, "submodule", "update", "-q", "--init");
      else git(clone, "submodule", "add", "-q", sub, "libs/sub");
      git(join(clone, "libs/sub"), "fetch", "-q", "origin");
      git(join(clone, "libs/sub"), "checkout", "-q", "FETCH_HEAD");
      git(clone, "add", "-A");
      git(clone, "commit", "-q", "-m", name);
      git(clone, "push", "-q", "origin", "HEAD:main");
      return git(join(clone, "libs/sub"), "rev-parse", "HEAD").trim();
    };
    bump("add sub");
    await fx.run({ type: "integrate", milestone: "M1" }, replayRun(run));
    writeFileSync(join(sub, "next.txt"), "n");
    git(sub, "add", "-A");
    git(sub, "commit", "-q", "-m", "next");
    const moved = bump("move sub");
    await fx.run({ type: "integrate", milestone: "M1" }, replayRun(run));
    expect(types(run).filter((t) => t === "integrate.done")).toHaveLength(2);
    expect(git(join(repo, "libs/sub"), "rev-parse", "HEAD").trim()).toBe(moved);
  });

  it("sends conflicts to the integrate worker's files, and commits the resolved merge", async () => {
    const { repo, origin, run, fx } = await baseSetup();
    commitInClone(origin, "theirs", { path: "src/a/x.ts", text: "theirs\n" });
    await fx.run(land1, replayRun(run));
    await fx.run({ type: "integrate", milestone: "M1" }, replayRun(run));
    expect(lastOf(run, "integrate.conflict")).toMatchObject({
      milestone: "M1",
      files: ["src/a/x.ts"],
    });
    expect(types(run)).not.toContain("integrate.done");
    // the worker resolved it and left it uncommitted; the commit effect finishes the merge
    writeFile(repo, "src/a/x.ts", "both\n");
    await fx.run({ type: "commit", milestone: "M1", round: 1 }, replayRun(run));
    const made = lastOf(run, "commit.made");
    expect(made?.commit).toBe(git(repo, "rev-parse", "HEAD").trim());
    expect(git(repo, "log", "-1", "--format=%P").trim().split(" ")).toHaveLength(2);
    expect(git(repo, "show", "HEAD:src/a/x.ts")).toBe("both\n");
    expect(replayRun(run).milestones[0]).toMatchObject({
      status: "verifying",
      integrateFiles: [],
    });
  });

  it("refuses to commit a merge whose files still hold conflict markers", async () => {
    const { repo, origin, run, fx } = await baseSetup();
    commitInClone(origin, "theirs", { path: "src/a/x.ts", text: "theirs\n" });
    await fx.run(land1, replayRun(run));
    await fx.run({ type: "integrate", milestone: "M1" }, replayRun(run));
    // the worker left the markers in: the file is not resolved
    await fx.run({ type: "commit", milestone: "M1", round: 1 }, replayRun(run));
    expect(types(run).filter((t) => t === "commit.made")).toHaveLength(1);
    expect(lastOf(run, "commit.failed")?.tail).toContain("src/a/x.ts");
    expect(git(repo, "rev-parse", "-q", "--verify", "MERGE_HEAD").trim()).not.toBe("");
    expect(replayRun(run).stuck["M1"]).toMatchObject({ reason: "commit" });
  });

  it("checks whether origin's base holds the landed commit, and says nothing until it does", async () => {
    const { repo, run, fx } = await baseSetup();
    await passGate(run, "M1");
    await daemonPass(run, "M1");
    await fx.run(land1, replayRun(run));
    await fx.run({ type: "checkMerged", milestone: "M1" }, replayRun(run));
    expect(types(run)).not.toContain("milestone.merged");
    git(repo, "push", "-q", "origin", "HEAD:main");
    await fx.run({ type: "checkMerged", milestone: "M1" }, replayRun(run));
    expect(lastOf(run, "milestone.merged")).toMatchObject({ milestone: "M1" });
  });

  it("parks a push question by its event alone: no 1.5 question to hold the pause", async () => {
    const { run, fx } = await baseSetup();
    await fx.run({ type: "park", unit: "M1", question: "push it", reason: "push" }, replayRun(run));
    expect(lastOf(run, "question.parked")).toMatchObject({
      unit: "M1",
      reason: "push",
    });
    expect(openQuestions(run)).toEqual([]);
  });
});

describe("parking, reporting, finishing", () => {
  it("parks a milestone in questions.jsonl too, so land refuses it", async () => {
    const { run, repo, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"]);
    writeFile(repo, "src/a/x.ts");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "c");
    const commit = git(repo, "rev-parse", "HEAD").trim();
    await seed(run, { type: "commit.made", milestone: "M1", round: 0, commit });
    await fx.run(
      {
        type: "park",
        unit: "M1",
        question: "which currency?",
        reason: "needs_user",
      },
      replayRun(run),
    );
    expect(lastOf(run, "question.parked")).toMatchObject({
      unit: "M1",
      question: "which currency?",
      reason: "needs_user",
    });
    expect(openQuestions(run).map((q) => q.milestone)).toEqual(["M1"]);
    await passGate(run, "M1");
    await fx.run({ type: "land", milestone: "M1", knownIssues: [] }, replayRun(run));
    expect(lastOf(run, "land.refused")?.message).toContain("parked");
  });

  it("parks a lane or the run by its event alone", async () => {
    const { run, fx } = setup();
    await seed(run);
    await fx.run({ type: "park", unit: "M1.L1", question: "q", reason: "judge" }, replayRun(run));
    expect(openQuestions(run)).toEqual([]);
    expect(lastOf(run, "question.parked")).toMatchObject({ unit: "M1.L1" });
  });

  it("posts a report and leaves notify to its own task", async () => {
    const { run, fx } = setup();
    await seed(run);
    await fx.run({ type: "report", kind: "landed", unit: "M1", text: "M1 landed" }, replayRun(run));
    await fx.run({ type: "notify", unit: "M1", moment: "milestone" }, replayRun(run));
    expect(types(run).slice(2)).toEqual(["report.posted"]);
  });

  it("the remind effect sends and records once", async () => {
    const { run, fx } = setup(undefined, testView({ notify: ["blocked"] }));
    await seed(run, {
      type: "question.parked",
      unit: "M1",
      question: "help?",
      reason: "needs_user",
    });
    const state = replayRun(run);
    delete process.env.CATHERD_NO_END_PUSH;
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
    try {
      await fx.run({ type: "remind", unit: "M1", n: 1 }, state);
      await fx.run({ type: "remind", unit: "M1", n: 1 }, state);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(lastOf(run, "question.reminded")).toMatchObject({
        unit: "M1",
        n: 1,
      });
      expect(types(run).filter((t) => t === "question.reminded")).toHaveLength(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does not apply a reminder to a question replaced while its notice sends", async () => {
    const { run, fx } = setup(undefined, testView({ notify: ["blocked"] }));
    await seed(run, {
      type: "question.parked",
      unit: "M1",
      question: "old",
      reason: "needs_user",
    });
    const state = replayRun(run);
    delete process.env.CATHERD_NO_END_PUSH;
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => {
      await appendEvent(run, {
        type: "question.answered",
        unit: "M1",
        answer: "done",
        by: "owner",
      });
      // Same timestamp too: the event sequence identifies the replacement.
      await appendEvent(
        run,
        {
          type: "question.parked",
          unit: "M1",
          question: "old",
          reason: "needs_user",
        },
        new Date(state.questions.M1!.at),
      );
      return new Response("ok");
    }) as unknown as typeof fetch);
    try {
      await fx.run({ type: "remind", unit: "M1", n: 1 }, state);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(replayRun(run).questions.M1?.reminded).toBe(0);
      expect(lastOf(run, "question.reminded")).toBeUndefined();
      await fx.run({ type: "remind", unit: "M1", n: 1 }, state);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("a cancelled run's state.md does not say the daemon continues", async () => {
    const { run, fx } = setup();
    await seed(run);
    writeFileSync(
      join(run.dir, "state.json"),
      JSON.stringify({
        schema: 1,
        next: "the daemon continues after M1",
        lastCheck: null,
        lastLandedAt: null,
      }),
    );
    await fx.run({ type: "finish", outcome: "cancelled" }, replayRun(run));
    const text = readFileSync(join(run.dir, "state.md"), "utf8");
    expect(text).toContain("cancelled");
    expect(text).not.toContain("the daemon continues");
  });

  it("finishes by writing the report and run.ended", async () => {
    const { run, fx } = setup();
    await seed(run);
    await fx.run({ type: "finish", outcome: "cancelled" }, replayRun(run));
    const ended = lastOf(run, "run.ended");
    expect(ended).toMatchObject({
      outcome: "cancelled",
      reportPath: join(run.dir, "report.md"),
    });
    expect(readFileSync(join(run.dir, "report.md"), "utf8")).toContain("# wallet");
  });

  it("finishes with the rules proposals in the report and writes knowledge.md never (plan 34)", async () => {
    const { run, repo, fx } = setup();
    await addKnowledge(repo, "[worker] keep");
    const file = (await knowledgePath(repo)).path;
    const before = readFileSync(file, "utf8");
    await seed(run);
    const proposals = [
      {
        op: "add" as const,
        text: "[worker] run bun test <file>",
        why: "M1 round 2",
      },
      { op: "remove" as const, text: "use the v1 client", why: "stale" },
    ];
    await fx.run({ type: "finish", outcome: "done", proposals }, replayRun(run));
    const text = readFileSync(join(run.dir, "report.md"), "utf8");
    expect(text).toContain("catherd knowledge add '[worker] run bun test <file>'");
    expect(text).toContain("catherd knowledge rm 'use the v1 client'");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(lastOf(run, "run.ended")).toMatchObject({ outcome: "done" });
  });

  it("treats red baselines as blockers rather than audit-only evidence", async () => {
    const { run, repo, fx } = setup();
    const head = "a".repeat(40);
    await seed(run, {
      type: "milestone.landed",
      milestone: "M1",
      commit: head,
      knownIssues: [],
      digestPath: join(run.dir, "digest-M1.md"),
    });
    const row = {
      at: "2026-10-21T10:00:00.000Z",
      run: run.id,
      milestone: "M1",
      command: "bun test",
      durationMs: 1,
      log: "/x.log",
    };
    appendCheckRecord(repo, {
      ...row,
      head: "b".repeat(40),
      exit: 1,
      fails: ["FAIL x"],
      baseline: true,
    });
    appendCheckRecord(repo, {
      ...row,
      head,
      exit: 1,
      fails: ["FAIL x"],
      secrets: "clean",
    });
    const gate = await machineGate(run, "M1", head);
    expect(gate.missing).toContainEqual(expect.stringContaining("pre-existing"));
    expect(gate.missing).toContainEqual(expect.stringContaining("FAIL x"));
    expect(gate.audit).toEqual([]);
    await fx.run({ type: "finish", outcome: "done" }, replayRun(run));
    expect(readFileSync(join(run.dir, "report.md"), "utf8")).not.toMatch(
      /## Audit\n\n- M1 \(check\): .*pre-existing/,
    );
  });

  it("writes report.md with each digest, the known issues and every judge decision under Audit", async () => {
    const { run } = freshRun();
    const digest = join(run.dir, "digest-M1.md");
    writeFileSync(digest, "M1 added the wallet core.\n");
    await seed(
      run,
      {
        type: "milestone.landed",
        milestone: "M1",
        commit: "a".repeat(40),
        knownIssues: ["a nit in src/a.ts"],
        digestPath: digest,
      },
      {
        type: "judge.decided",
        id: "4",
        unit: "M1",
        kind: "triage",
        decision: {
          verb: "route",
          routes: [{ finding: 1, to: "M1.L1", why: "owns it" }],
        },
        dispatchId: "D1",
      },
    );
    const path = writeRunReport(run, replayRun(run), readEvents(run));
    const text = readFileSync(path, "utf8");
    expect(text).toContain("# wallet");
    expect(text).toContain("M1 added the wallet core.");
    expect(text).toMatch(/## Known issues\n\n- M1: a nit in src\/a\.ts/);
    expect(text).toMatch(/## Audit\n\n- M1 \(triage\): route: 1 -> M1\.L1/);
  });

  it("never throws: an unexpected error becomes effect.failed", async () => {
    const { run, fx } = setup();
    await seed(run);
    await fx.run({ type: "route", milestone: "M1", confirmed: false }, replayRun(run));
    expect(lastOf(run, "effect.failed")).toMatchObject({
      action: "route",
      unit: "M1",
    });
    await fx.run({ type: "integrate", milestone: "M1" }, replayRun(run));
    expect(lastOf(run, "effect.failed")?.message).toContain("no base branch");
  });
});

// plan 35: a milestone per branch
const realRead = memoryReader.read;
const realPush = branchPusher.push;
const realFree = heavyLimits.freeMb;
afterEach(() => {
  memoryReader.read = realRead;
  branchPusher.push = realPush;
  heavyLimits.freeMb = realFree;
});

/** a base run (meta.base and run.started.base) on a local bare origin, with the effects of a fake-backed profile */
async function treesSetup(view = testView()) {
  const s = setup(undefined, view);
  const b = branchRun();
  await appendEvent(b.run, {
    type: "run.started",
    ...startedFields,
    base: "main",
  });
  await appendEvent(b.run, { type: "plan.ready", milestones: PLAN });
  return { ...b, deps: s.deps, fx: realEffects(s.deps, b.run) };
}
const treeReady = (run: Run, m: string, at?: Date) =>
  appendEvent(
    run,
    {
      type: "tree.ready",
      milestone: m,
      tree: treeDir(run, m),
      branch: `t-${m.toLowerCase()}`,
      base: "main",
      hints: [],
    },
    at,
  );
const claimM = (run: Run, m: string) => claimTree(fakeDeps(), run, m, { known: false });
const act = (type: "claimTree" | "pushBranch", milestone: string): Action => ({
  type,
  milestone,
});

describe("a milestone per branch (plan 35)", () => {
  // the claims below test memory alone: the host's free disk must not decide them (plan 40 D14 has its own test)
  beforeEach(() => {
    heavyLimits.freeMb = () => Number.POSITIVE_INFINITY;
  });

  it("low disk defers a second milestone, and never the first", async () => {
    const { run, fx } = await treesSetup();
    memoryReader.read = () => 9000;
    heavyLimits.freeMb = () => 1000;
    await fx.run(act("claimTree", "M1"), replayRun(run));
    expect(lastOf(run, "tree.ready")).toMatchObject({ milestone: "M1" });
    await fx.run(act("claimTree", "M2"), replayRun(run));
    expect(lastOf(run, "tree.deferred")).toMatchObject({
      milestone: "M2",
      availableMb: 1000,
      needMb: 4096,
      resource: "disk",
    });
    expect(existsSync(treeDir(run, "M2"))).toBe(false);
  });

  it("claims a tree when memory allows, and defers with the numbers when it does not", async () => {
    const { run, deps, fx } = await treesSetup();
    await treeReady(run, "M1", new Date(deps.now() - 10 * 60_000)); // M1 has worked for ten minutes
    memoryReader.read = () => 5000; // 5000 − 2048 < 3072
    await fx.run(act("claimTree", "M2"), replayRun(run));
    expect(lastOf(run, "tree.deferred")).toMatchObject({
      milestone: "M2",
      availableMb: 5000,
      needMb: 5120,
    });
    expect(existsSync(treeDir(run, "M2"))).toBe(false);
    memoryReader.read = () => 9000;
    await fx.run(act("claimTree", "M2"), replayRun(run));
    expect(lastOf(run, "tree.ready")).toMatchObject({
      milestone: "M2",
      branch: "t-m2",
      base: "main",
    });
    expect(existsSync(treeDir(run, "M2"))).toBe(true);
  });

  it("always claims the first milestone, whatever the memory reads", async () => {
    const { run, fx } = await treesSetup();
    memoryReader.read = () => 0;
    await fx.run(act("claimTree", "M1"), replayRun(run));
    expect(lastOf(run, "tree.ready")).toMatchObject({
      milestone: "M1",
      branch: "t-m1",
    });
  });

  it("admits by the run profile's memory limits", async () => {
    const roomy = testView({
      limits: {
        memory: { reserveMb: 1024, perMilestoneMb: 3072, floorMb: 3072 },
      },
    });
    const a = await treesSetup(roomy);
    await treeReady(a.run, "M1", new Date(a.deps.now() - 10 * 60_000));
    memoryReader.read = () => 5000; // the defaults defer here: 5000 − 2048 < 3072
    await a.fx.run(act("claimTree", "M2"), replayRun(a.run));
    expect(lastOf(a.run, "tree.ready")).toMatchObject({ milestone: "M2" });
    const tight = testView({
      limits: {
        memory: { reserveMb: 8192, perMilestoneMb: 3072, floorMb: 3072 },
      },
    });
    const b = await treesSetup(tight);
    await treeReady(b.run, "M1", new Date(b.deps.now() - 10 * 60_000));
    memoryReader.read = () => 9000;
    await b.fx.run(act("claimTree", "M2"), replayRun(b.run));
    expect(lastOf(b.run, "tree.deferred")).toMatchObject({
      availableMb: 9000,
      needMb: 11264,
    });
  });

  it("turns a refused claim into effect.failed with its message", async () => {
    const { repo, run, fx } = await treesSetup();
    git(repo, "branch", "t-m1");
    await fx.run(act("claimTree", "M1"), replayRun(run));
    expect(lastOf(run, "effect.failed")).toMatchObject({
      action: "claimTree",
      unit: "M1",
    });
    expect(lastOf(run, "effect.failed")?.message).toMatch(/not this run's/);
  });

  it("pushes a landed milestone's branch with a fake git, and records it", async () => {
    const { repo, origin, run, fx } = await treesSetup();
    git(repo, "remote", "set-url", "origin", "git@github.com:o/r.git");
    await treeReady(run, "M1");
    await appendEvent(run, {
      type: "milestone.landed",
      milestone: "M1",
      commit: "c0abcdef0123",
      knownIssues: [],
      digestPath: "/r/digests/M1.md",
      branch: "t-m1",
    });
    const pushed: [string, string][] = [];
    branchPusher.push = async (tree, branch) => void pushed.push([tree, branch]);
    await fx.run(act("pushBranch", "M1"), replayRun(run));
    expect(pushed).toEqual([[treeDir(run, "M1"), "t-m1"]]);
    expect(lastOf(run, "branch.pushed")).toEqual(
      expect.objectContaining({
        milestone: "M1",
        branch: "t-m1",
        remote: "origin",
        mr: "gh pr create --base main --head t-m1 --body-file /r/digests/M1.md",
      }),
    );
    // a failing push records effect.failed and no branch.pushed
    const before = types(run).filter((t) => t === "branch.pushed").length;
    branchPusher.push = async () => {
      throw new Error("remote refused");
    };
    await fx.run(act("pushBranch", "M1"), replayRun(run));
    expect(types(run).filter((t) => t === "branch.pushed")).toHaveLength(before);
    expect(lastOf(run, "effect.failed")).toMatchObject({
      action: "pushBranch",
      unit: "M1",
    });
    // catherd made no other git write: origin has no branch of the milestone
    expect(git(origin, "branch", "--list", "t-m1").trim()).toBe("");
  });

  it("dispatches, fast-checks and commits a base-run milestone in its tree", async () => {
    const { repo, run, fx } = await treesSetup();
    writeLane(run, "M1.L1", ["src/a/"], "test -f marker");
    const { tree } = await claimM(run, "M1");
    await treeReady(run, "M1");
    writeFile(tree, "marker", "m");
    writeFile(tree, "src/a/x.ts", "mine\n");
    await fx.run(dispatchAction(), replayRun(run));
    expect(listDispatches(run).map((d) => d.admit.repo)).toEqual([tree]);
    await fx.run({ type: "fastCheck", lane: "M1.L1" }, replayRun(run));
    expect(lastOf(run, "check.ran")).toMatchObject({ lane: "M1.L1", exit: 0 });
    const repoHead = git(repo, "rev-parse", "HEAD").trim();
    await fx.run({ type: "commit", milestone: "M1", round: 0 }, replayRun(run));
    expect(lastOf(run, "commit.made")?.commit).toBe(git(tree, "rev-parse", "HEAD").trim());
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(repoHead);
    expect(git(tree, "show", "--name-only", "--format=", "HEAD")).toContain("src/a/x.ts");
  });

  it("parks a milestone whose claimed tree is gone instead of working in the main checkout", async () => {
    const { repo, run, fx } = await treesSetup();
    writeLane(run, "M1.L1", ["src/a/"]);
    const { tree } = await claimM(run, "M1");
    await treeReady(run, "M1");
    rmSync(tree, { recursive: true, force: true });
    writeFile(repo, "src/a/x.ts", "stray\n"); // would be committed if the commit ran in the repo
    const head = git(repo, "rev-parse", "HEAD").trim();
    const index = git(repo, "status", "--porcelain");
    await fx.run(dispatchAction(), replayRun(run));
    expect(lastOf(run, "dispatch.refused")).toMatchObject({
      code: "E_TREE",
      unit: "M1.L1",
    });
    expect(listDispatches(run)).toEqual([]);
    for (let i = 0; i < 3; i++) await fx.run({ type: "commit", milestone: "M1", round: 0 }, replayRun(run));
    expect(lastOf(run, "effect.failed")).toMatchObject({
      action: "commit",
      unit: "M1",
    });
    expect(lastOf(run, "effect.failed")?.message).toContain("is gone");
    expect(replayRun(run).stuck.M1?.reason).toBe("effect");
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(head);
    expect(git(repo, "status", "--porcelain")).toBe(index);
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
  });

  it("integrates in the milestone's tree, on its branch", async () => {
    const { origin, run, fx } = await treesSetup();
    const { tree } = await claimM(run, "M1");
    await treeReady(run, "M1");
    commitInClone(origin, "moved");
    await fx.run({ type: "integrate", milestone: "M1" }, replayRun(run));
    expect(lastOf(run, "integrate.done")?.commit).toBe(git(tree, "rev-parse", "HEAD").trim());
    expect(git(tree, "log", "-1", "--format=%s").trim()).toBe("Merge origin/main into t-m1");
  });

  it("removes a merged milestone's clean tree, keeps a dirty one, and appends milestone.merged either way", async () => {
    const { run, fx } = await treesSetup();
    const m1 = await claimM(run, "M1");
    const m2 = await claimM(run, "M2");
    await treeReady(run, "M1");
    await treeReady(run, "M2");
    // M1 is merged for git: its commit is in origin's base
    writeFile(m1.tree, "one.txt", "1");
    git(m1.tree, "add", "-A");
    git(m1.tree, "commit", "-q", "-m", "one");
    const c1 = git(m1.tree, "rev-parse", "HEAD").trim();
    git(m1.tree, "push", "-q", "origin", "HEAD:main");
    appendLedger(run, `M1 | w | ${c1} | 1 | ok`);
    await appendEvent(run, {
      type: "milestone.landed",
      milestone: "M1",
      commit: c1,
      knownIssues: [],
      digestPath: "d",
    });
    await fx.run({ type: "checkMerged", milestone: "M1" }, replayRun(run));
    expect(existsSync(m1.tree)).toBe(false);
    expect(lastOf(run, "milestone.merged")).toMatchObject({ milestone: "M1" });
    // M2 is merged for the owner (a squash merge), and holds an untracked file
    await appendEvent(run, {
      type: "milestone.landed",
      milestone: "M2",
      commit: "c2abcdef",
      knownIssues: [],
      digestPath: "d",
    });
    await appendEvent(run, {
      type: "question.parked",
      unit: "M2",
      question: "q",
      reason: "push",
    });
    await appendEvent(run, {
      type: "question.answered",
      unit: "M2",
      answer: "merged by squash",
      by: "owner",
    });
    writeFile(m2.tree, "unsaved.txt", "mine");
    await fx.run({ type: "checkMerged", milestone: "M2" }, replayRun(run));
    expect(existsSync(join(m2.tree, "unsaved.txt"))).toBe(true);
    expect(lastOf(run, "milestone.merged")).toMatchObject({ milestone: "M2" });
    expect(replayRun(run).milestones.map((m) => m.status)).toEqual(["merged", "merged"]);
  });

  it("parks a landed milestone for its push, naming its branch, the push answer, the push command, the digest and the precheck", async () => {
    const { run, fx } = await treesSetup();
    const { tree } = await claimM(run, "M1");
    await treeReady(run, "M1");
    const landed = await appendEvent(run, {
      type: "milestone.landed",
      milestone: "M1",
      commit: "c0abcdef0123456",
      knownIssues: [],
      digestPath: "/r/digests/M1.md",
      branch: "t-m1",
    });
    const park = next(replayRun(run), landed).find((a) => a.type === "park");
    if (park?.type !== "park") throw new Error("no park");
    await fx.run(park, replayRun(run));
    const q = lastOf(run, "question.parked");
    expect(q).toMatchObject({ unit: "M1", reason: "push" });
    for (const part of [
      "M1 landed on t-m1 at c0abcdef0123.",
      "Answer push and catherd pushes it",
      `git -C ${tree} push -u origin t-m1`,
      "/r/digests/M1.md",
      `git -C ${tree} fetch -q origin main && git -C ${tree} merge-base --is-ancestor origin/main HEAD`,
      "merge commit",
    ])
      expect(q?.question).toContain(part);
  });

  it("a run without base dispatches, checks and commits in the repo", async () => {
    const { repo, run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"], "test -f marker");
    await seed(run);
    writeFile(repo, "marker", "m");
    writeFile(repo, "src/a/x.ts", "mine\n");
    await fx.run(dispatchAction(), replayRun(run));
    expect(listDispatches(run).map((d) => d.admit.repo)).toEqual([repo]);
    await fx.run({ type: "fastCheck", lane: "M1.L1" }, replayRun(run));
    expect(lastOf(run, "check.ran")).toMatchObject({ exit: 0 });
    await fx.run({ type: "commit", milestone: "M1", round: 0 }, replayRun(run));
    expect(lastOf(run, "commit.made")?.commit).toBe(git(repo, "rev-parse", "HEAD").trim());
    expect(existsSync(join(run.dir, "trees"))).toBe(false);
  });
});

describe("planOf with milestone dependencies (plan 35)", () => {
  it("lists the milestones a milestone's lanes name, beside its heading's After:", () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["a.ts"]);
    writeLane(run, "M2.L1", ["b.ts"], "true", "Kind: repo_code\nDifficulty: build\nAfter: M1\n");
    writeLane(run, "M3.L1", ["c.ts"], "true", "Kind: repo_code\nDifficulty: build\nAfter: M2.L1\n");
    writeFileSync(runPaths(run.dir).plan, "# P\n\n## M1 — a\n\n## M2 — b\n\n## M3 — c\nAfter: M1\n");
    expect(planOf(run).map((m) => [m.id, m.after])).toEqual([
      ["M1", []],
      ["M2", ["M1"]],
      ["M3", ["M1", "M2"]],
    ]);
  });
});

/**
 * The milestone check, replaced: each call answers `exit` and `fails` for the commit it runs on and writes the record a
 * worker would, so the machine's gate reads it. `calls` keeps each request.
 */
function stubCheck(
  run: Run,
  answer: (i: { at?: string; command: string }) => {
    exit: number;
    fails: string[];
    failFiles?: Record<string, string[]>;
  },
  calls: { at?: string; command: string }[] = [],
): void {
  milestoneChecker.run = async (i) => {
    calls.push({ at: i.at, command: i.command });
    const { exit, fails, failFiles } = answer(i);
    const record: CheckRecord = {
      at: new Date().toISOString(),
      run: run.id,
      milestone: i.milestone,
      command: i.command,
      head: git(i.at ?? treeOf(run, i.milestone), "rev-parse", "HEAD").trim(),
      exit,
      durationMs: 1,
      fails,
      ...(failFiles ? { failFiles } : {}),
      log: "",
      ...(i.at !== undefined ? { baseline: true as const } : { secrets: "clean" }),
    };
    appendCheckRecord(run.meta.repo, record);
    return { running: false, cached: false, record, missing: [], audit: [] };
  };
}

/** A base run (meta.base set, so its baseline is origin's main) whose M1 has one commit that origin's main lacks. */
async function committedBaseRun() {
  const s = await treesSetup();
  writeLane(s.run, "M1.L1", ["src/a/"]);
  writeFile(s.repo, "src/a/x.ts");
  git(s.repo, "add", "-A");
  git(s.repo, "commit", "-q", "-m", "c");
  const commit = git(s.repo, "rev-parse", "HEAD").trim();
  await appendEvent(s.run, {
    type: "commit.made",
    milestone: "M1",
    round: 0,
    commit,
  });
  return { ...s, commit };
}

describe("the daemon's machine check (plan 40 D1, D4, D13)", () => {
  const realCheck = milestoneChecker.run;
  afterEach(() => {
    milestoneChecker.run = realCheck;
  });

  it("a base that moved is merged before the check, and no check runs", async () => {
    const { origin, run, fx, commit } = await baseSetup();
    const calls: { at?: string; command: string }[] = [];
    stubCheck(run, () => ({ exit: 0, fails: [] }), calls);
    commitInClone(origin, "moved");
    await fx.run({ type: "machineCheck", milestone: "M1", commit }, replayRun(run));
    expect(types(run)).toContain("base.behind");
    expect(types(run)).not.toContain("milestone.checked");
    expect(calls).toEqual([]);
  });

  it("a red check gives findings from its fresh lines", async () => {
    const { repo, run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"]);
    writeFileSync(runPaths(run.dir).plan, "# P\n## M1 — core\nCheck: bun test\n");
    await seed(run);
    const head = git(repo, "rev-parse", "HEAD").trim();
    stubCheck(run, () => ({ exit: 1, fails: ["test/a.test.ts:3 expected 2"] }));
    await fx.run({ type: "machineCheck", milestone: "M1", commit: head }, replayRun(run));
    expect(lastOf(run, "milestone.checked")).toMatchObject({
      milestone: "M1",
      head,
      command: "bun test",
      checkOnly: false,
      uncovered: ["A1 it works"],
      findings: [
        {
          label: "BLOCKER",
          text: "`bun test` fails: test/a.test.ts:3 expected 2",
          file: "test/a.test.ts",
        },
      ],
    });
  });

  it("a red check's finding names the failing files", async () => {
    const { repo, run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"]);
    writeFileSync(runPaths(run.dir).plan, "# P\n## M1 — core\nCheck: bun test\n");
    await seed(run);
    const head = git(repo, "rev-parse", "HEAD").trim();
    stubCheck(run, () => ({
      exit: 1,
      fails: ["(fail) a > b"],
      failFiles: { "(fail) a > b": ["test/a.test.ts"] },
    }));
    await fx.run({ type: "machineCheck", milestone: "M1", commit: head }, replayRun(run));
    expect(lastOf(run, "milestone.checked")?.findings).toEqual([
      {
        label: "BLOCKER",
        text: "`bun test` fails: (fail) a > b — in test/a.test.ts",
        file: "test/a.test.ts",
      },
    ]);
  });

  it("a failing item with no baseline gets one from the base, on a tree removed after", async () => {
    const { repo, run, fx, commit } = await committedBaseRun();
    writeFileSync(runPaths(run.dir).plan, "# P\n## M1 — core\nCheck: bun test\n");
    const calls: { at?: string; command: string }[] = [];
    stubCheck(run, () => ({ exit: 1, fails: ["red"] }), calls);
    await fx.run({ type: "machineCheck", milestone: "M1", commit }, replayRun(run));
    const baselines = calls.filter((c) => c.at !== undefined);
    expect(baselines).toHaveLength(1);
    expect(existsSync(baselines[0]?.at as string)).toBe(false);
    expect(
      readChecks(repo)
        .filter((r) => r.baseline)
        .map((r) => r.head),
    ).toEqual([git(repo, "rev-parse", "origin/main").trim()]);
    // the base fails on the same line, so nothing on the commit is fresh
    expect(lastOf(run, "milestone.checked")?.findings).toEqual([]);
  });

  it("a baseline check that throws fails the effect, and its tree is removed", async () => {
    const { run, fx, commit } = await committedBaseRun();
    writeFileSync(runPaths(run.dir).plan, "# P\n## M1 — core\nCheck: bun test\n");
    stubCheck(run, (i) => {
      if (i.at !== undefined) throw new Error("the base check broke");
      return { exit: 1, fails: ["red"] };
    });
    await fx.run({ type: "machineCheck", milestone: "M1", commit }, replayRun(run));
    expect(lastOf(run, "effect.failed")).toMatchObject({
      action: "machineCheck",
      unit: "M1",
    });
    expect(existsSync(join(runPaths(run.dir).scratch, "base-M1"))).toBe(false);
  });

  it("a baseline tree that cannot be set up leaves its item without a baseline, its lines fresh", async () => {
    const { run, fx, commit } = await committedBaseRun();
    writeFileSync(runPaths(run.dir).plan, "# P\nSetup: exit 3\n## M1 — core\nCheck: bun test\n");
    const calls: { at?: string; command: string }[] = [];
    stubCheck(run, () => ({ exit: 1, fails: ["red"] }), calls);
    await fx.run({ type: "machineCheck", milestone: "M1", commit }, replayRun(run));
    expect(calls.every((c) => c.at === undefined)).toBe(true);
    expect(types(run)).not.toContain("effect.failed");
    expect(readFileSync(logFile(), "utf8")).toContain("exited 3");
    expect(lastOf(run, "milestone.checked")?.findings).toEqual([
      { label: "BLOCKER", text: "`bun test` fails: red", file: null },
    ]);
  });

  it("a plan with no Check runs no check, and leaves every delivered line to the verifier, marked or not", async () => {
    const { repo, deps } = setup();
    // A2 is marked `(Check)`, yet no Check runs: a plan with no Check leaves it to the verifier too
    const run = createRun({
      repo,
      title: "t",
      aLines: ["A1 it works", "A2 it also works (Check)"],
      version: "0.0.0-test",
    });
    const fx = realEffects(deps, run);
    writeLane(run, "M1.L1", ["src/a/"]);
    writeFileSync(runPaths(run.dir).plan, "# P\n## M1 — core\n- A1 it works\n");
    await seed(run);
    const calls: { at?: string; command: string }[] = [];
    stubCheck(run, () => ({ exit: 0, fails: [] }), calls);
    const commit = git(repo, "rev-parse", "HEAD").trim();
    await fx.run({ type: "machineCheck", milestone: "M1", commit }, replayRun(run));
    expect(calls).toEqual([]);
    expect(lastOf(run, "milestone.checked")).toMatchObject({
      milestone: "M1",
      command: null,
      missing: [],
      findings: [],
      uncovered: ["A1 it works", "A2 it also works (Check)"],
      checkOnly: false,
    });
  });
});
