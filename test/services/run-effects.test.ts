import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { newDispatchId } from "../../src/domain/ids.ts";
import type { RunRecord } from "../../src/domain/record.ts";
import type { RunEvent, RunEventInput } from "../../src/domain/run-events.ts";
import type { Action } from "../../src/domain/run-machine.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { launcher, watchersSettled } from "../../src/services/dispatch-service.ts";
import { liveDispatches } from "../../src/services/dispatches.ts";
import { openQuestions } from "../../src/services/questions.ts";
import { failoverRung } from "../../src/services/failover-rungs.ts";
import { endedEvent, ownerOf, planOf, realEffects } from "../../src/services/run-effects.ts";
import { appendEvent, readEvents, replayRun } from "../../src/services/run-events-store.ts";
import { writeRunReport } from "../../src/services/run-report.ts";
import { appendRecord, type Run } from "../../src/services/run-store.ts";
import { snapshotEnv } from "../helpers.ts";
import { PLAN, startedFields } from "../domain/run-fixtures.ts";
import { simPath, withScenario, type CodexScenario } from "../sim/scenario.ts";
import { withClaudeScenario } from "../sim/sim-scenarios.ts";
import {
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
const role = (access: "read-only" | "workspace-write", rungs: string[]) => ({ enabled: true, access, rungs });

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
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, encoding: "utf8" });

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
  return makeRecord({ runId: run.id, dispatchId, name, replyPath, lane: null, ...over });
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
    expect(lastOf(run, "dispatch.started")).toMatchObject({ rung: "claude-code:claude-opus-5-5#high" });
    expect(lastOf(run, "dispatch.ended")).toMatchObject({ name: "architect", status: "ok" });
    expect(sim.recorded().args).toContain("claude-opus-5-5");
  });

  it("turns an admission refusal into dispatch.refused with its code", async () => {
    const { run, repo, fx } = setup({ reply: "x" }, testView({ budget: { tokens: 300 } }));
    writeLane(run, "M1.L1", ["src/a/"]);
    await appendRecord(
      run,
      makeRecord({ runId: run.id, name: "spent", lane: null, tokens: { input: 500, cached: 0, output: 0 } }),
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

  it("refuses with E_ALL_HELD when every rung of the role is on a held quota", async () => {
    const { run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"]);
    await seed(run);
    const s = replayRun(run);
    s.holds = { codex: new Date(Date.now() + 600_000).toISOString() };
    s.at = new Date().toISOString();
    await fx.run(dispatchAction({ failoverFrom: "codex:gpt-6-luna#high" }), s);
    expect(lastOf(run, "dispatch.refused")).toMatchObject({ code: "E_ALL_HELD" });
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
    expect(readEvents(run)[2]).toMatchObject({ role: "judge", name: "judge-9", judgeKind: "question" });
    expect(lastOf(run, "judge.decided")).toMatchObject({
      id: "9",
      unit: "M1.L1",
      kind: "question",
      decision: { verb: "answer", answer: "use the existing helper" },
    });
  });

  it("reports a judge reply it cannot read as judge.failed", async () => {
    const { run, fx } = setup({ reply: "I think it is fine.\nSTATUS: complete — ok" });
    writeLane(run, "M1.L1", ["src/a/"]);
    await seed(run);
    await fx.run(
      {
        type: "judge",
        input: { id: "3", kind: "unexpected", unit: "M1.L1", context: "c", findings: [], lanes: [] },
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
        exit: { code: 0, signal: null, reason: "exited", endedAt: new Date().toISOString() },
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
    expect(lastOf(run, "dispatch.ended")).toMatchObject({ dispatchId: d.admit.dispatchId, status: "ok" });
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
        exit: { code: 0, signal: null, reason: "exited", endedAt: new Date().toISOString() },
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
    expect(lastOf(run, "dispatch.ended")).toMatchObject({ dispatchId: id, status: "ok" });
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
    expect(lastOf(run, "dispatch.refused")).toMatchObject({ name: "worker-M1.L1", code: "E_RUN_CANCELLED" });
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
        exit: { code: 0, signal: null, reason: "exited", endedAt: new Date().toISOString() },
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
    const { run, fx } = setup({ reply: "x", holdUntil: join(freshHold(), "never") });
    writeLane(run, "M1.L1", ["src/a/"]);
    await seed(run);
    const running = fx.run(dispatchAction(), replayRun(run));
    const started = await waitFor(() => lastOf(run, "dispatch.started"));
    await fx.run({ type: "cancel", dispatchIds: [started.dispatchId] }, replayRun(run));
    await running;
    expect(lastOf(run, "dispatch.ended")).toMatchObject({ status: "cancelled" });
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
    expect(ended("VERDICT: PASS\nSTATUS: complete — ok")).toMatchObject({ verdict: "pass", findings: [] });
    expect(ended("VERDICT: FAIL\n- bun test src/a fails\nSTATUS: complete — failed")).toMatchObject({
      verdict: "fail",
      findings: [{ label: "BLOCKER", text: "bun test src/a fails", file: "src/a" }],
    });
    expect(
      ended("VERDICT: BLOCKED: environment — docker ps says no daemon\nSTATUS: blocked — env"),
    ).toMatchObject({
      verdict: "blocked",
      environment: "docker ps says no daemon",
    });
    // a verdict wrapped in markdown is no verdict: the milestone gets a fix round, never a landing
    expect(ended("**VERDICT: PASS**\nSTATUS: complete — ok")).toMatchObject({ verdict: "fail" });
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
    expect(endedEvent(run, stopped, "M1.L1")).toMatchObject({ reason: "too_hard", head: null });
    const head = "0123456789abcdef0123456789abcdef01234567";
    const verdict = withReply(
      run,
      { role: "verifier", name: "verifier-M1", head },
      `VERDICT: PASS\nHEAD: ${head}\nSTATUS: complete — ok`,
    );
    expect(endedEvent(run, verdict, "M1")).toMatchObject({ verdict: "pass", head, reason: null });
    // a complete reply has no reason, whatever its why says
    const done = withReply(run, { role: "worker", replyStatus: "complete", replyWhy: "too_hard" }, "x");
    expect(endedEvent(run, done, "M1.L1")).toMatchObject({ reason: null });
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
    expect(endedEvent(run, broken, "M1.L1")).toMatchObject({ reason: "check_broken", foreign: ["src/b.ts"] });
    await fx.run({ type: "fastCheck", lane: "M1.L1" }, replayRun(run));
    expect(lastOf(run, "check.ran")).toMatchObject({ exit: 1, foreign: ["src/b.ts"] });
  });
});

describe("classifying a stop (30b)", () => {
  const stoppedRun = async (deps: ReturnType<typeof setup>["deps"], run: Run) => {
    await seed(run);
    const r = withReply(
      run,
      { role: "worker", name: "worker-M1.L1", lane: "M1.L1", replyStatus: "blocked", replyWhy: "stuck" },
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
      return { value: "other", probability: null, confidence: null, source: "default" };
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
    expect(plan[2]?.lanes[0]).toMatchObject({ role: "researcher", kind: "research" });
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
    writeLane(run, "M1.L1", ["src/a/"]);
    await appendEvent(run, { type: "run.started", ...startedFields });
    await fx.run({ type: "readPlan" }, replayRun(run));
    expect(lastOf(run, "plan.ready")?.milestones).toMatchObject([{ id: "M1", lanes: [{ id: "M1.L1" }] }]);
  });

  it("names a file's owning lane by its longest Owns: entry", () => {
    const lanes = [
      { id: "M1.L1", owns: ["src/"] },
      { id: "M1.L2", owns: ["src/wallet/", "README.md"] },
    ];
    expect(ownerOf("src/wallet/a.ts", lanes)).toBe("M1.L2");
    expect(ownerOf("src/other.ts", lanes)).toBe("M1.L1");
    expect(ownerOf("README.md", lanes)).toBe("M1.L2");
    expect(ownerOf("lib/x.ts", lanes)).toBeNull();
    expect(ownerOf(null, lanes)).toBeNull();
  });
});

describe("routing, checking, committing, landing", () => {
  it("routes and preflights one milestone's lanes", async () => {
    const { run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"]);
    writeLane(run, "M1.L2", ["src/b/"]);
    await seed(run);
    await fx.run({ type: "route", milestone: "M1", confirmed: false }, replayRun(run));
    expect(lastOf(run, "lanes.routed")).toMatchObject({
      milestone: "M1",
      lanes: [{ lane: "M1.L1", rung: "codex:gpt-6-luna#high" }, { lane: "M1.L2" }],
    });
    expect(lastOf(run, "preflight.done")).toMatchObject({ milestone: "M1", blocking: [], confirm: null });
  });

  it("asks for confirmation when the profile wants the commands confirmed first", async () => {
    const { run, fx } = setup({ reply: "x" }, testView({ preflight: { confirm: true } }));
    writeLane(run, "M1.L1", ["src/a/"], "bun test src/a");
    writeLane(run, "M1.L2", ["src/b/"]);
    await seed(run);
    await fx.run({ type: "route", milestone: "M1", confirmed: false }, replayRun(run));
    expect(lastOf(run, "preflight.done")?.confirm).toEqual(["M1.L1: bun test src/a", "M1.L2: true"]);
  });

  it("names a lane whose check cannot start as blocking", async () => {
    const { run, fx } = setup();
    writeLane(run, "M1.L1", ["src/a/"], "no-such-command-anywhere");
    writeLane(run, "M1.L2", ["src/b/"]);
    await seed(run);
    await fx.run({ type: "route", milestone: "M1", confirmed: false }, replayRun(run));
    expect(lastOf(run, "preflight.done")?.blocking).toMatchObject([{ lane: "M1.L1" }]);
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
    expect(made).toMatchObject({ milestone: "M1", round: 0, commit: git(repo, "rev-parse", "HEAD").trim() });
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
    const action: Action = { type: "land", milestone: "M1", knownIssues: ["a nit stays"] };
    await fx.run(action, replayRun(run));
    expect(lastOf(run, "land.refused")).toMatchObject({ milestone: "M1", code: "E_LAND_GATE" });
    expect(lastOf(run, "land.refused")?.fix).not.toBe("");
    await passGate(run, "M1");
    await fx.run(action, replayRun(run));
    const landed = lastOf(run, "milestone.landed");
    expect(landed).toMatchObject({ milestone: "M1", commit, knownIssues: ["a nit stays"] });
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
      { type: "park", unit: "M1", question: "which currency?", reason: "needs_user" },
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

  it("finishes by writing the report and run.ended", async () => {
    const { run, fx } = setup();
    await seed(run);
    await fx.run({ type: "finish", outcome: "cancelled" }, replayRun(run));
    const ended = lastOf(run, "run.ended");
    expect(ended).toMatchObject({ outcome: "cancelled", reportPath: join(run.dir, "report.md") });
    expect(readFileSync(join(run.dir, "report.md"), "utf8")).toContain("# wallet");
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
        decision: { verb: "route", routes: [{ finding: 1, to: "M1.L1", why: "owns it" }] },
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
    expect(lastOf(run, "effect.failed")).toMatchObject({ action: "route", unit: "M1" });
    await fx.run({ type: "integrate", milestone: "M1" }, replayRun(run));
    expect(lastOf(run, "effect.failed")).toMatchObject({
      action: "integrate",
      unit: "M1",
      message: "integrate needs catherd 30b",
    });
  });
});

describe("failover", () => {
  it("takes a stand-in on a quota that is not held, and a Claude rung only when nothing else is free", () => {
    const stand = "claude-code:claude-opus-5-5#high";
    const { run, deps } = setup({ reply: "x" }, testView({ failover: { "codex:gpt-6-luna#high": stand } }));
    expect(failoverRung(deps, run, "worker", "codex:gpt-6-luna#high", [])).toBe("codex:gpt-6-sol#medium");
    expect(failoverRung(deps, run, "worker", "codex:gpt-6-luna#high", ["codex"])).toBe(stand);
    expect(failoverRung(deps, run, "worker", "codex:gpt-6-luna#high", ["codex", "claude-code"])).toBeNull();
  });
});
