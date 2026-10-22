import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newDispatchId } from "../../src/domain/ids.ts";
import { appendJsonl, ensureJsonlHeader, writeJsonAtomic } from "../../src/infra/store.ts";
import { reviewRounds } from "../../src/services/milestones.ts";
import { pauseMachine, resumeMachine } from "../../src/services/pause.ts";
import { runMilestones } from "../../src/services/protocol.ts";
import { answer, park, questionCounts } from "../../src/services/questions.ts";
import { appendEvent } from "../../src/services/run-events-store.ts";
import {
  appendAgentRun,
  appendLedger,
  appendRecord,
  createRun,
  listRuns,
  type Run,
  runPaths,
  supersededFile,
} from "../../src/services/run-store.ts";
import {
  failoverRecovered,
  interventionsOf,
  pausedMs,
  runEnd,
} from "../../src/services/scorecard-metrics.ts";
import { quotaByBackend } from "../../src/services/summary.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { fakeDeps, fakeDispatch, freshRun, makeRecord, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());

const t = (hhmm: string) => `2026-09-25T${hhmm}:00.000Z`;
const ms = (hhmm: string) => Date.parse(t(hhmm));

const rec = (run: Run, over: Parameters<typeof makeRecord>[0] = {}) =>
  appendRecord(run, makeRecord({ runId: run.id, dispatchId: newDispatchId(), ...over }));

/** A run created at `hhmm` in a fresh repo and home. */
function runAt(hhmm: string, o: Partial<Parameters<typeof createRun>[0]> = {}): { repo: string; run: Run } {
  withHome();
  const repo = tempRepo();
  return {
    repo,
    run: createRun({ repo, title: "t", aLines: [], version: "0.0.0-test", now: new Date(t(hhmm)), ...o }),
  };
}

describe("scorecard metrics", () => {
  it("counts the milestone's full reviews since its lanes started, a partial one not", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["a.ts"]);
    await fakeDispatch(run, { lane: "M1.L1", admittedAt: t("10:00") });
    const review = (name: string, at: string, over = {}) =>
      rec(run, { name, role: "reviewer", lane: null, endedAt: at, ...over });
    await review("reviewer-M1", t("09:00"));
    await review("reviewer-M1", t("10:10"), { replyStatus: "partial" });
    await review("reviewer-M1", t("10:20"));
    await review("reviewer-M1", t("10:40"));
    await review("reviewer-M10", t("10:30"));
    expect(reviewRounds(run, "M1")).toBe(2);
  });

  it("lists the milestones its lane files name, in number order", () => {
    const { run } = freshRun();
    for (const l of ["M10.L1", "M2.L1", "M2.L2"]) writeLane(run, l, ["a.ts"]);
    expect(runMilestones(run)).toEqual(["M2", "M10"]);
  });

  it("sums tokens and limits per backend, sorted by backend", () => {
    const r = (over: Parameters<typeof makeRecord>[0]) => makeRecord(over);
    expect(
      quotaByBackend([
        r({ backend: "codex", tokens: { input: 4, cached: 1, output: 1 }, status: "limit" }),
        r({ backend: "claude-code", tokens: { input: 5, cached: 0, output: 2 } }),
        r({ backend: "codex", tokens: { input: 6, cached: 3, output: 0 } }),
      ]),
    ).toEqual([
      { backend: "claude-code", runs: 1, input: 5, cached: 0, output: 2, limits: 0 },
      { backend: "codex", runs: 2, input: 10, cached: 4, output: 1, limits: 1 },
    ]);
  });

  it("counts each park once, its answer shown but not added", async () => {
    const { run } = freshRun();
    const deps = fakeDeps();
    await park(deps, { run: run.id, milestone: "M1", question: "which?" });
    await answer(deps, { run: run.id, milestone: "M1", answer: "that" });
    expect(questionCounts(run)).toEqual({ questions: 1, answers: 1 });
    expect(interventionsOf(run, ms("12:00"), 0)).toMatchObject({ parks: 1, answers: 1, total: 1 });
  });

  /** `events` appended to a daemon run, `run.started` first. */
  async function daemonRun(...events: Parameters<typeof appendEvent>[1][]): Promise<Run> {
    const { repo, run } = runAt("10:00");
    await appendEvent(run, {
      type: "run.started",
      repo,
      title: "t",
      aLines: [],
      plan: [],
      base: null,
      engine: "2.0",
    });
    for (const e of events) await appendEvent(run, e);
    return run;
  }
  const parked = (unit: string) =>
    ({ type: "question.parked", unit, question: "which?", reason: "needs_user" }) as const;
  const answered = (unit: string, by: "owner" | "judge") =>
    ({ type: "question.answered", unit, answer: "that", by }) as const;

  it("counts in a daemon run the owner's answers and the questions still open, not the judge's answers", async () => {
    const run = await daemonRun(
      parked("M1.L1"),
      answered("M1.L1", "owner"),
      parked("M1.L2"),
      parked("M1.L3"),
      answered("M1.L3", "judge"),
    );
    expect(interventionsOf(run, ms("12:00"), 0)).toMatchObject({ parks: 2, answers: 2, total: 2 });
  });

  it("adds an owner's cancel and an owner's plan approval, not a plan given as input", async () => {
    const run = await daemonRun(
      { type: "cancel.requested", by: "owner" },
      { type: "plan.approved", by: "owner" },
    );
    expect(interventionsOf(run, ms("12:00"), 0)).toMatchObject({ cancels: 1, approvals: 1, total: 2 });
    const input = await daemonRun({ type: "plan.approved", by: "input" });
    expect(interventionsOf(input, ms("12:00"), 0)).toMatchObject({ cancels: 0, approvals: 0, total: 0 });
  });

  it("reads questions.jsonl only in a 1.5 run", async () => {
    const run = await daemonRun(parked("M1"), answered("M1", "owner"));
    const deps = fakeDeps();
    await park(deps, { run: run.id, milestone: "M1", question: "which?" });
    await answer(deps, { run: run.id, milestone: "M1", answer: "that" });
    expect(interventionsOf(run, ms("12:00"), 0)).toMatchObject({ parks: 1, answers: 1 });
    const { run: old } = freshRun();
    await park(deps, { run: old.id, milestone: "M1", question: "which?" });
    await answer(deps, { run: old.id, milestone: "M1", answer: "that" });
    expect(interventionsOf(old, ms("12:00"), 0)).toMatchObject({
      parks: 1,
      answers: 1,
      cancels: 0,
      approvals: 0,
    });
  });

  it("counts each change of owner session after the start as a takeover", () => {
    const { run } = runAt("10:00", { startedBy: { sessionId: "A", hostSessionId: null, name: null } });
    const p = runPaths(run.dir);
    ensureJsonlHeader(p.sessions, "sessions");
    for (const s of ["A", "B", "B", "A"])
      appendJsonl(p.sessions, {
        host: "claude-code",
        sessionId: s,
        hostSessionId: null,
        name: null,
        at: t("10:30"),
      });
    expect(interventionsOf(run, ms("12:00"), 0).takeovers).toBe(2);
  });

  it("counts no manual dispatch in a 1.5 run; in a run with events.jsonl, every record a session admitted", async () => {
    const { run } = runAt("10:00");
    await rec(run, { sessionId: "s-1" });
    await rec(run);
    expect(interventionsOf(run, ms("12:00"), 0).manualDispatches).toBe(0);
    writeFileSync(join(run.dir, "events.jsonl"), "");
    expect(interventionsOf(run, ms("12:00"), 0).manualDispatches).toBe(1);
  });

  it("counts a pause that began during the run, not one before it", () => {
    const { run } = runAt("10:00");
    pauseMachine(ms("09:00"), "before");
    resumeMachine(ms("09:30"));
    pauseMachine(ms("10:30"), "during");
    resumeMachine(ms("10:40"));
    expect(interventionsOf(run, ms("12:00"), 0).pauses).toBe(1);
  });

  it("adds the operator's chat count, and each run this one superseded", () => {
    const { repo, run: a } = runAt("10:00");
    const b = createRun({ repo, title: "t2", aLines: [], version: "0.0.0-test", now: new Date(t("10:05")) });
    writeJsonAtomic(supersededFile(a), { schema: 1, by: b.id, at: t("10:05") });
    expect(listRuns([repo]).runs).toHaveLength(2);
    expect(interventionsOf(b, ms("12:00"), 2)).toMatchObject({ chat: 2, superseded: 1, total: 3 });
    expect(interventionsOf(a, ms("12:00"), 0).superseded).toBe(0);
  });

  it("ends a run at its last landing, else at its last record or native agent run", async () => {
    const { run } = runAt("10:00");
    mkdirSync(join(run.dir, "digests"), { recursive: true });
    writeFileSync(
      join(run.dir, "digests", "M1.md"),
      `# M1 — x\n\nCommit abc1234 · 5 min · landed ${t("11:00")}\nA-lines: none\n`,
    );
    await rec(run, { endedAt: t("11:30") });
    expect(runEnd(run)).toBe(ms("11:30"));
    appendLedger(run, "M1 | x | abc1234 | 5 | e");
    expect(runEnd(run)).toBe(ms("11:00"));
    // without the ledger row the last record decides; rebuild a second run for that
    const { run: bare } = runAt("10:00");
    await rec(bare, { endedAt: t("11:30") });
    expect(runEnd(bare)).toBe(ms("11:30"));
    appendAgentRun(bare, {
      at: t("11:45"),
      name: "worker-M1.L1",
      role: "worker",
      rung: "claude:claude-opus-5-5#low",
      agent: null,
      totalTokens: 1,
      costUsd: null,
      secs: 1,
      status: "ok",
      lane: "M1.L1",
    });
    expect(runEnd(bare)).toBe(ms("11:45"));
  });

  it("adds parked and paused minutes inside the run, overlaps once", async () => {
    const { run } = runAt("10:00");
    writeLane(run, "M1.L1", ["a.ts"]);
    let now = ms("10:10");
    const deps = fakeDeps({ now: () => now });
    await park(deps, { run: run.id, milestone: "M1", question: "which?" });
    now = ms("10:20");
    await answer(deps, { run: run.id, milestone: "M1", answer: "that" });
    pauseMachine(ms("10:15"), "vpn");
    resumeMachine(ms("10:30"));
    expect(pausedMs(run, ms("11:00"))).toBe(20 * 60_000);
  });

  it("is true only when a stand-in (failoverFrom set) ended ok and was not blocked", async () => {
    const { run } = runAt("10:00");
    await rec(run, { status: "limit" });
    expect(failoverRecovered(run)).toBe(false);
    await rec(run, { failoverFrom: "codex:gpt-6-sol#medium", replyStatus: "blocked" });
    expect(failoverRecovered(run)).toBe(false);
    await rec(run, { failoverFrom: "codex:gpt-6-sol#medium" });
    expect(failoverRecovered(run)).toBe(true);
  });
});
