import { describe, expect, it } from "bun:test";
import type { BlockedReason } from "../../src/domain/blocked.ts";
import { type JudgeDecision } from "../../src/domain/judge.ts";
import { approvalQuestion, reapprovalQuestion } from "../../src/domain/plan-doc.ts";
import {
  type Action,
  actionKey,
  confirms,
  failKey,
  judgeInputFor,
  next,
} from "../../src/domain/run-machine.ts";
import type { Finding, MilestonePlan, RunEvent } from "../../src/domain/run-events.ts";
import { liveDispatches, type RunState } from "../../src/domain/run-state.ts";
import {
  endDispatch,
  finishLane,
  type Log,
  makeLog,
  newId,
  PLAN,
  routeMilestone,
  runningLog,
  startDispatch,
  startedFields,
} from "./run-fixtures.ts";

const of = <T extends Action["type"]>(as: Action[], type: T): Extract<Action, { type: T }>[] =>
  as.filter((a): a is Extract<Action, { type: T }> => a.type === type);
const names = (as: Action[]): string[] => of(as, "dispatch").map((a) => a.name);
/** what the machine does after the log's last event */
const last = (log: Log): Action[] => next(log.state(), log.events.at(-1) as RunEvent);
const bug = (text: string, file: string | null, label: "BUG" | "BLOCKER" = "BUG") => ({ label, text, file });

function plan(lanes: number): MilestonePlan[] {
  const ids = Array.from({ length: lanes }, (_, i) => `M1.L${i + 1}`);
  return [
    {
      id: "M1",
      title: "core",
      after: [],
      lanes: ids.map((id, i) => ({
        id,
        role: "worker" as const,
        kind: "repo_code",
        after: [],
        owns: [`src/${String.fromCharCode(97 + i)}/`],
      })),
    },
    {
      id: "M2",
      title: "docs",
      after: ["M1"],
      lanes: [{ id: "M2.L1", role: "writer", kind: "prose", after: [], owns: ["docs/"] }],
    },
  ];
}

function review(log: Log, findings: Finding[], name = "reviewer-M1") {
  const id = startDispatch(log, { name, role: "reviewer", unit: "M1", lane: null });
  return endDispatch(log, id, { name, unit: "M1", findings });
}

/** the classification of a stop that gave no reason, as the effect appends it */
const classified = (log: Log, dispatchId: string, reason: BlockedReason | null) =>
  log.add("stop.classified", { dispatchId, reason });

/** runs the pending lanes of the state to a passing check */
function fixPending(log: Log) {
  for (const l of Object.values(log.state().lanes))
    if (l.status === "pending" && l.milestone === "M1") finishLane(log, l.id);
}

/** M1 through review rounds with `counts` BUG lines each, every one owned by the first lane */
function rounds(counts: number[], o: { lanes?: number } = {}) {
  const log = runningLog(plan(o.lanes ?? 2));
  for (const l of Object.values(log.state().lanes)) if (l.milestone === "M1") finishLane(log, l.id);
  log.add("commit.made", { milestone: "M1", round: 0, commit: "c0" });
  let lines: string[] = [];
  counts.forEach((n, i) => {
    const fs = Array.from({ length: n }, (_, k) =>
      bug(`BUG src/a/f${i}-${k}.ts:1 — problem ${i}-${k} — fix`, `src/a/f${i}-${k}.ts`),
    );
    lines = fs.map((f) => f.text);
    review(log, fs);
    if (log.state().milestones[0]?.status === "fixing") {
      fixPending(log);
      log.add("commit.made", { milestone: "M1", round: i + 1, commit: `c${i + 1}` });
    }
  });
  return { log, state: log.state(), last: last(log), lastOpenLines: lines };
}

describe("the machine: planning", () => {
  it("starts with the dossier, or the architect when an A-line names a plan", () => {
    const a = makeLog();
    a.add("run.started", startedFields);
    expect(names(last(a))).toEqual(["researcher-dossier"]);
    const b = makeLog();
    b.add("run.started", { ...startedFields, aLines: ["A1 x", "plan: docs/p.md"] });
    expect(names(last(b))).toEqual(["architect"]);
    const c = makeLog();
    c.add("run.started", { ...startedFields, plan: ["M1 the plan"] });
    expect(names(last(c))).toEqual(["architect"]);
  });

  it("reads the plan after the architect, then routes the first milestone only", () => {
    const log = makeLog();
    log.add("run.started", startedFields);
    const d = startDispatch(log, { name: "researcher-dossier", role: "researcher", unit: "run", lane: null });
    endDispatch(log, d, { name: "researcher-dossier", unit: "run" });
    expect(names(last(log))).toEqual(["architect"]);
    const a = startDispatch(log, { name: "architect", role: "architect", unit: "run", lane: null });
    endDispatch(log, a, { name: "architect", unit: "run" });
    expect(last(log).map((x) => x.type)).toEqual(["readPlan"]);
    log.add("plan.ready", { milestones: PLAN });
    log.add("plan.approved", { by: "owner" });
    expect(of(last(log), "route")).toEqual([{ type: "route", milestone: "M1", confirmed: false }]);
  });

  it("asks the dossier or the architect once more, then parks the run", () => {
    const log = makeLog();
    log.add("run.started", startedFields);
    for (let i = 0; i < 2; i++) {
      expect(names(last(log))).toEqual(["researcher-dossier"]);
      const d = startDispatch(log, {
        name: "researcher-dossier",
        role: "researcher",
        unit: "run",
        lane: null,
      });
      endDispatch(log, d, { name: "researcher-dossier", unit: "run", status: "failed", replyStatus: null });
    }
    const out = last(log);
    expect(names(out)).toEqual([]);
    expect(of(out, "park")).toMatchObject([{ unit: "run", reason: "effect" }]);
  });

  it("parks the run on a budget refusal", () => {
    const log = makeLog();
    log.add("run.started", startedFields);
    log.add("dispatch.refused", {
      name: "researcher-dossier",
      unit: "run",
      code: "E_RUN_BUDGET",
      message: "spent",
    });
    expect(of(last(log), "park")).toMatchObject([{ unit: "run", reason: "budget" }]);
    expect(names(last(log))).toEqual([]);
    log.add("question.parked", { unit: "run", question: "spent", reason: "budget" });
    log.add("question.answered", { unit: "run", answer: "raised", by: "owner" });
    expect(names(last(log))).toEqual(["researcher-dossier"]);
  });
});

describe("the machine: a milestone's lanes", () => {
  it("parks a milestone whose preflight cannot start a check, and asks for confirmation", () => {
    const log = makeLog();
    log.add("run.started", startedFields);
    log.add("plan.ready", { milestones: PLAN });
    log.add("plan.approved", { by: "owner" });
    log.add("lanes.routed", { milestone: "M1", lanes: [{ lane: "M1.L1", rung: "r", ladder: ["r"] }] });
    log.add("preflight.done", {
      milestone: "M1",
      blocking: [{ lane: "M1.L1", note: "no docker" }],
      confirm: null,
      lint: [],
    });
    expect(of(last(log), "park")).toMatchObject([{ unit: "M1", reason: "preflight" }]);
    expect(of(last(log), "park")[0]?.question).toContain("no docker");
    log.add("question.parked", { unit: "M1", question: "q", reason: "preflight" });
    log.add("question.answered", { unit: "M1", answer: "fixed", by: "owner" });
    expect(of(last(log), "route")).toEqual([{ type: "route", milestone: "M1", confirmed: true }]);

    const c = makeLog();
    c.add("run.started", startedFields);
    c.add("plan.ready", { milestones: PLAN });
    c.add("plan.approved", { by: "owner" });
    c.add("lanes.routed", { milestone: "M1", lanes: [] });
    c.add("preflight.done", { milestone: "M1", blocking: [], confirm: ["bun test"], lint: [] });
    expect(of(last(c), "park")).toMatchObject([{ unit: "M1", reason: "confirm" }]);
  });

  it("holds a lane until its After: lanes are done", () => {
    const log = runningLog();
    const out = last(log);
    expect(names(out)).toEqual(["worker-M1.L1"]);
    expect(of(out, "dispatch")[0]).toMatchObject({
      unit: "M1.L1",
      lane: "M1.L1",
      brief: "lane",
      rung: "codex:gpt-6-sol#medium",
      thread: null,
    });
    finishLane(log, "M1.L1");
    expect(names(last(log))).toEqual(["worker-M1.L2"]);
  });

  it("does not start two lanes that own the same paths", () => {
    const p = plan(2);
    (p[0] as MilestonePlan).lanes[1]!.owns = ["src/a/sub/"];
    const log = runningLog(p);
    expect(names(last(log))).toEqual(["worker-M1.L1", "worker-M1.L2"].slice(0, 2));
    startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    expect(names(last(log))).toEqual([]);
  });

  it("checks a lane after a clean reply; a first failure resumes its thread with the tail, a second climbs", () => {
    const log = runningLog();
    const w = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    endDispatch(log, w, { name: "worker-M1.L1", unit: "M1.L1", thread: "t-1" });
    expect(last(log)).toEqual([{ type: "fastCheck", lane: "M1.L1" }]);
    log.add("check.ran", { lane: "M1.L1", exit: 1, tail: "1 failed", foreign: [] });
    let d = of(last(log), "dispatch")[0];
    expect(d).toMatchObject({ name: "worker-M1.L1", thread: "t-1", brief: "fix" });
    expect(d?.notes.join("\n")).toContain("1 failed");
    const w2 = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1", thread: "t-1" });
    endDispatch(log, w2, { name: "worker-M1.L1", unit: "M1.L1", thread: "t-1" });
    log.add("check.ran", { lane: "M1.L1", exit: 1, tail: "still", foreign: [] });
    expect(last(log)).toEqual([{ type: "climb", lane: "M1.L1", reason: "check-failed-twice" }]);
    log.add("lane.climbed", { lane: "M1.L1", rung: "codex:gpt-6-sol#high", top: false });
    d = of(last(log), "dispatch")[0];
    expect(d).toMatchObject({ rung: "codex:gpt-6-sol#high", thread: null });
  });

  it("retries a failed lane once on its rung, then climbs; out of rungs asks the judge", () => {
    const log = runningLog();
    const fail = () => {
      const w = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
      endDispatch(log, w, { name: "worker-M1.L1", unit: "M1.L1", status: "timeout", replyStatus: null });
      // a timeout names no reason: Jev is asked, and with Jev off or unsure the answer is none
      expect(last(log)).toEqual([{ type: "classify", dispatchId: w }]);
      classified(log, w, null);
    };
    fail();
    expect(of(last(log), "dispatch")[0]).toMatchObject({
      thread: null,
      rung: "codex:gpt-6-sol#medium",
      failoverFrom: null,
    });
    fail();
    expect(last(log)).toEqual([{ type: "climb", lane: "M1.L1", reason: "unchanged" }]);
    log.add("lane.climbed", { lane: "M1.L1", rung: "codex:gpt-6-sol#high", top: true });
    const j = of(last(log), "judge");
    expect(j).toHaveLength(1);
    expect(j[0]?.input).toMatchObject({ kind: "unexpected", unit: "M1.L1" });
    expect(j[0]?.input.context).toContain("top rung");
  });

  it("asks the judge about a needs_user reply, and acts on each of its verbs", () => {
    const base = () => {
      const log = runningLog();
      const w = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
      endDispatch(log, w, {
        name: "worker-M1.L1",
        unit: "M1.L1",
        replyStatus: "blocked",
        reason: "needs_user",
        why: "needs_user: needs the api key",
      });
      return log;
    };
    const log = base();
    const out = last(log);
    expect(of(out, "judge")[0]?.input).toMatchObject({ kind: "question", unit: "M1.L1" });
    expect(of(out, "judge")[0]?.input.context).toContain("roles/worker-M1.L1/");
    const id = of(out, "judge")[0]!.input.id;
    const decide = (decision: JudgeDecision, l: Log = log) => {
      const j = startDispatch(l, {
        name: `judge-${id}`,
        role: "judge",
        unit: "M1.L1",
        lane: null,
        judgeKind: "question",
      });
      l.add("judge.decided", { id, unit: "M1.L1", kind: "question", decision, dispatchId: j });
      endDispatch(l, j, { name: `judge-${id}`, unit: "M1.L1" });
      return last(l);
    };
    // each verb on a fresh run
    let l = base();
    expect(of(decide({ verb: "answer", answer: "use v2" }, l), "dispatch")[0]).toMatchObject({
      name: "worker-M1.L1",
      brief: "fix",
    });
    expect(l.state().lanes["M1.L1"]?.notes).toEqual(["The judge answered: use v2"]);
    l = base();
    expect(of(decide({ verb: "ask_owner", question: "which key?" }, l), "park")).toMatchObject([
      { unit: "M1.L1", question: "which key?", reason: "needs_user" },
    ]);
    l = base();
    expect(of(decide({ verb: "retry", why: "flaky" }, l), "dispatch")[0]).toMatchObject({
      name: "worker-M1.L1",
    });
    l = base();
    expect(decide({ verb: "climb", why: "too hard" }, l)).toEqual([
      { type: "climb", lane: "M1.L1", reason: "blocked" },
    ]);
    l = base();
    decide({ verb: "skip", why: "not needed" }, l);
    expect(l.state().lanes["M1.L1"]?.status).toBe("done");
    expect(l.state().milestones[0]?.knownIssues).toEqual(["M1.L1 skipped: not needed"]);
  });

  it("asks the judge once more after an unreadable reply, then parks", () => {
    const log = runningLog();
    const w = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    endDispatch(log, w, {
      name: "worker-M1.L1",
      unit: "M1.L1",
      replyStatus: "refused",
      reason: "needs_user",
    });
    const first = of(last(log), "judge")[0]!;
    const j = startDispatch(log, {
      name: `judge-${first.input.id}`,
      role: "judge",
      unit: "M1.L1",
      lane: null,
      judgeKind: "question",
    });
    log.add("judge.failed", { id: first.input.id, unit: "M1.L1", why: "unreadable" });
    expect(last(log)).toEqual([]);
    endDispatch(log, j, { name: `judge-${first.input.id}`, unit: "M1.L1" });
    const again = of(last(log), "judge");
    expect(again).toHaveLength(1);
    expect(again[0]?.input.id).toBe(first.input.id);
    const j2 = startDispatch(log, {
      name: `judge-${first.input.id}`,
      role: "judge",
      unit: "M1.L1",
      lane: null,
      judgeKind: "question",
    });
    log.add("judge.failed", { id: first.input.id, unit: "M1.L1", why: "unreadable again" });
    endDispatch(log, j2, { name: `judge-${first.input.id}`, unit: "M1.L1" });
    expect(of(last(log), "park")).toMatchObject([{ unit: "M1.L1", reason: "judge" }]);
    expect(of(last(log), "judge")).toEqual([]);
  });

  it("re-runs a parked lane on its rung with the answer, and resumes a parked milestone where it stood", () => {
    const log = runningLog();
    const w = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    endDispatch(log, w, {
      name: "worker-M1.L1",
      unit: "M1.L1",
      replyStatus: "blocked",
      reason: "needs_user",
    });
    log.add("question.parked", { unit: "M1.L1", question: "q", reason: "needs_user" });
    expect(of(last(log), "judge")).toEqual([]);
    log.add("question.answered", { unit: "M1.L1", answer: "use v2", by: "owner" });
    const d = of(last(log), "dispatch")[0];
    expect(d).toMatchObject({ name: "worker-M1.L1", rung: "codex:gpt-6-sol#medium", brief: "fix" });
    expect(d?.notes).toEqual(["The owner answered: use v2"]);
    log.add("question.parked", { unit: "M1", question: "which db?", reason: "needs_user" });
    expect(names(last(log))).toEqual([]);
    log.add("question.answered", { unit: "M1", answer: "pg", by: "owner" });
    expect(liveDispatches(log.state())).toEqual([]);
    expect(log.state().milestones[0]?.status).toBe("lanes");
  });
});

describe("the machine: review rounds", () => {
  it("commits once every lane is done, then dispatches the reviewer, and the UI reviewer for a ui lane", () => {
    const p = plan(2);
    p[0]!.lanes[1]!.kind = "ui";
    const log = runningLog(p);
    finishLane(log, "M1.L1");
    expect(last(log).some((a) => a.type === "commit")).toBe(false);
    finishLane(log, "M1.L2");
    expect(last(log)).toEqual([{ type: "commit", milestone: "M1", round: 0 }]);
    log.add("commit.made", { milestone: "M1", round: 0, commit: "c0" });
    expect(names(last(log))).toEqual(["reviewer-M1", "ui-reviewer-M1"]);
    expect(of(last(log), "dispatch")[0]).toMatchObject({
      brief: "review",
      unit: "M1",
      lane: null,
      role: "reviewer",
    });
  });

  it("skips a reviewer the profile turns off, and goes on to the verifier when none is left", () => {
    const p = plan(2);
    p[0]!.lanes[1]!.kind = "ui";
    const log = runningLog(p, { ...startedFields, rolesOff: ["ui-reviewer"] });
    finishLane(log, "M1.L1");
    finishLane(log, "M1.L2");
    log.add("commit.made", { milestone: "M1", round: 0, commit: "c0" });
    expect(names(last(log))).toEqual(["reviewer-M1"]);
    const off = runningLog(p, { ...startedFields, rolesOff: ["reviewer", "ui-reviewer"] });
    finishLane(off, "M1.L1");
    finishLane(off, "M1.L2");
    off.add("commit.made", { milestone: "M1", round: 0, commit: "c0" });
    expect(off.state().milestones[0]).toMatchObject({ status: "verifying", awaiting: [], counts: [0] });
  });

  it("asks for a second pass over a partial review", () => {
    const log = runningLog();
    finishLane(log, "M1.L1");
    finishLane(log, "M1.L2");
    log.add("commit.made", { milestone: "M1", round: 0, commit: "c0" });
    const r = startDispatch(log, { name: "reviewer-M1", role: "reviewer", unit: "M1", lane: null });
    endDispatch(log, r, { name: "reviewer-M1", unit: "M1", replyStatus: "partial" });
    expect(of(last(log), "dispatch")[0]).toMatchObject({
      name: "reviewer-M1-2",
      brief: "recheck",
      thread: null,
    });
  });

  it("routes each finding to the lane owning its file and the rest to the judge", () => {
    const log = runningLog(plan(2));
    finishLane(log, "M1.L1");
    finishLane(log, "M1.L2");
    log.add("commit.made", { milestone: "M1", round: 0, commit: "c0" });
    review(log, [
      bug("BUG src/a/x.ts:3 — one", "src/a/x.ts"),
      bug("BUG src/b/y.ts:3 — two", "src/b/y.ts"),
      bug("BUG README.md — three", "README.md"),
    ]);
    const out = last(log);
    expect(names(out)).toEqual(["worker-M1.L1", "worker-M1.L2"]);
    expect(of(out, "dispatch").map((d) => d.notes)).toEqual([
      ["BUG src/a/x.ts:3 — one"],
      ["BUG src/b/y.ts:3 — two"],
    ]);
    expect(of(out, "judge")).toHaveLength(1);
    expect(of(out, "judge")[0]?.input).toMatchObject({
      kind: "triage",
      unit: "M1",
      findings: ["BUG README.md — three"],
    });
    // the judge sends it to lane 2, to the architect, or drops it
    const id = of(out, "judge")[0]!.input.id;
    const j = startDispatch(log, {
      name: `judge-${id}`,
      role: "judge",
      unit: "M1",
      lane: null,
      judgeKind: "triage",
    });
    log.add("judge.decided", {
      id,
      unit: "M1",
      kind: "triage",
      decision: { verb: "route", routes: [{ finding: 1, to: "architect", why: "the plan misses docs" }] },
      dispatchId: j,
    });
    endDispatch(log, j, { name: `judge-${id}`, unit: "M1" });
    const arch = of(last(log), "dispatch").find((d) => d.role === "architect");
    expect(arch).toMatchObject({
      name: "architect-M1-1",
      unit: "M1",
      brief: "architect",
      notes: ["BUG README.md — three"],
    });
    const a = startDispatch(log, { name: "architect-M1-1", role: "architect", unit: "M1", lane: null });
    endDispatch(log, a, { name: "architect-M1-1", unit: "M1" });
    expect(last(log)).toEqual([{ type: "readPlan" }]);
    log.add("plan.ready", { milestones: PLAN });
    log.add("plan.approved", { by: "owner" });
    expect(log.state().milestones[0]?.delta).toEqual([]);
  });

  it("tells a running milestone's architect what the plan check refused, not the old notes again", () => {
    const log = runningLog(plan(2));
    finishLane(log, "M1.L1");
    finishLane(log, "M1.L2");
    log.add("commit.made", { milestone: "M1", round: 0, commit: "c0" });
    review(log, [bug("BUG README.md — three", "README.md")]);
    const id = of(last(log), "judge")[0]!.input.id;
    const j = startDispatch(log, {
      name: `judge-${id}`,
      role: "judge",
      unit: "M1",
      lane: null,
      judgeKind: "triage",
    });
    log.add("judge.decided", {
      id,
      unit: "M1",
      kind: "triage",
      decision: { verb: "route", routes: [{ finding: 1, to: "architect", why: "the plan misses docs" }] },
      dispatchId: j,
    });
    endDispatch(log, j, { name: `judge-${id}`, unit: "M1" });
    const a = startDispatch(log, { name: "architect-M1-1", role: "architect", unit: "M1", lane: null });
    endDispatch(log, a, { name: "architect-M1-1", unit: "M1" });
    log.add("effect.failed", {
      action: "readPlan",
      unit: "run",
      message: "the plan needs: M1.L3 has no Tasks:",
    });
    expect(of(last(log), "dispatch").find((d) => d.role === "architect")).toMatchObject({
      name: "architect-M1-1",
      notes: ["BUG README.md — three", "the plan needs: M1.L3 has no Tasks:"],
    });
  });

  it("keeps fixing while findings shrink and lands the rest as known issues when they stop", () => {
    const r = rounds([3, 2, 2]);
    expect(names(r.last)).toEqual(["verifier-M1"]);
    expect(r.state.milestones[0]?.knownIssues).toEqual(r.lastOpenLines);
  });

  it("lands with the round's NITs and its open lines as known issues, word for word", () => {
    const log = runningLog(plan(1));
    finishLane(log, "M1.L1");
    log.add("commit.made", { milestone: "M1", round: 0, commit: "c0" });
    const open = bug("BUG src/a/x.ts:1 — still wrong — fix", "src/a/x.ts");
    const other = bug("BUG src/a/y.ts:1 — also wrong — fix", "src/a/y.ts");
    review(log, [open, other]);
    fixPending(log);
    log.add("commit.made", { milestone: "M1", round: 1, commit: "c1" });
    const nit = { label: "NIT" as const, text: "**NIT** src/a/z.ts:3 — naming — rename", file: "src/a/z.ts" };
    review(log, [open, other, nit]);
    expect(names(last(log))).toEqual(["verifier-M1"]);
    const v = startDispatch(log, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
    endDispatch(log, v, { name: "verifier-M1", unit: "M1", verdict: "pass", head: "c1" });
    expect(last(log)).toEqual([
      { type: "land", milestone: "M1", knownIssues: [open.text, other.text, nit.text] },
    ]);
  });

  it("stops at the soft cap", () => {
    const r = rounds([9, 7, 5, 3], { lanes: 4 });
    expect(names(r.last)).toEqual(["verifier-M1"]);
    // one round short of the cap, the review goes on
    expect(names(rounds([9, 7, 5], { lanes: 4 }).last)).toEqual(["reviewer-M1"]);
  });

  it("resumes the reviewer on its thread for the next round, with the recheck brief", () => {
    const log = runningLog(plan(1));
    finishLane(log, "M1.L1");
    log.add("commit.made", { milestone: "M1", round: 0, commit: "c0" });
    const r = startDispatch(log, { name: "reviewer-M1", role: "reviewer", unit: "M1", lane: null });
    endDispatch(log, r, {
      name: "reviewer-M1",
      unit: "M1",
      thread: "rv-1",
      findings: [bug("BUG src/a/x.ts:1 — a", "src/a/x.ts")],
    });
    fixPending(log);
    log.add("commit.made", { milestone: "M1", round: 1, commit: "c1" });
    expect(of(last(log), "dispatch")[0]).toMatchObject({
      name: "reviewer-M1",
      brief: "recheck",
      thread: "rv-1",
    });
  });

  it("climbs a fixer whose finding survived its fix, before it fixes", () => {
    const log = runningLog(plan(1));
    finishLane(log, "M1.L1");
    log.add("commit.made", { milestone: "M1", round: 0, commit: "c0" });
    review(log, [
      bug("BUG src/a/x.ts:3 — null deref", "src/a/x.ts"),
      bug("BUG src/a/y.ts:1 — other", "src/a/y.ts"),
    ]);
    expect(names(last(log))).toEqual(["worker-M1.L1"]);
    fixPending(log);
    log.add("commit.made", { milestone: "M1", round: 1, commit: "c1" });
    review(log, [bug("BUG src/a/x.ts:9 — null deref", "src/a/x.ts")]);
    expect(last(log)).toEqual([{ type: "climb", lane: "M1.L1", reason: "same-defect" }]);
    log.add("lane.climbed", { lane: "M1.L1", rung: "codex:gpt-6-sol#high", top: false });
    expect(of(last(log), "dispatch")[0]).toMatchObject({
      rung: "codex:gpt-6-sol#high",
      brief: "fix",
      thread: null,
    });
  });

  it("parks a milestone whose BLOCKER outlives the rounds, and moves on to the next one", () => {
    const log = runningLog(plan(1));
    finishLane(log, "M1.L1");
    log.add("commit.made", { milestone: "M1", round: 0, commit: "c0" });
    const b = bug("BLOCKER src/a/x.ts:1 — data loss", "src/a/x.ts", "BLOCKER");
    review(log, [b]);
    fixPending(log);
    log.add("commit.made", { milestone: "M1", round: 1, commit: "c1" });
    review(log, [b]);
    const out = last(log);
    expect(of(out, "park")).toMatchObject([{ unit: "M1", reason: "blocker" }]);
    log.add("question.parked", { unit: "M1", question: "q", reason: "blocker" });
    // the next milestone does not wait for a parked one it does not depend on
    const p = structuredClone(plan(1));
    p[1]!.after = [];
    log.add("plan.ready", { milestones: p });
    log.add("plan.approved", { by: "owner" });
    expect(of(last(log), "route")).toEqual([{ type: "route", milestone: "M2", confirmed: false }]);
  });

  it("lands on a PASS, fixes and re-verifies on a FAIL, parks on BLOCKED: environment", () => {
    const base = () => {
      const log = runningLog(plan(1));
      finishLane(log, "M1.L1");
      log.add("commit.made", { milestone: "M1", round: 0, commit: "c0" });
      review(log, []);
      return log;
    };
    const verify = (log: Log, o: Omit<Parameters<typeof endDispatch>[2], "name" | "unit">) => {
      expect(names(last(log))).toEqual(["verifier-M1"]);
      const v = startDispatch(log, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
      endDispatch(log, v, { ...o, name: "verifier-M1", unit: "M1" });
      return last(log);
    };
    let log = base();
    expect(verify(log, { verdict: "pass", head: "c0" })).toEqual([
      { type: "land", milestone: "M1", knownIssues: [] },
    ]);
    log = base();
    const fix = verify(log, {
      verdict: "fail",
      findings: [bug("FAIL: bun test — 2 failed", "src/a/x.ts", "BLOCKER")],
    });
    expect(names(fix)).toEqual(["worker-M1.L1"]);
    fixPending(log);
    log.add("commit.made", { milestone: "M1", round: 1, commit: "c1" });
    expect(names(last(log))).toEqual(["reviewer-M1"]);
    review(log, []);
    expect(names(last(log))).toEqual(["verifier-M1"]);
    log = base();
    const park = verify(log, { verdict: "blocked", environment: "docker ps fails" });
    expect(of(park, "park")).toMatchObject([{ unit: "M1", reason: "environment" }]);
    expect(of(park, "park")[0]?.question).toContain("docker ps fails");
    expect(names(park)).toEqual([]);
  });

  it("parks a land refusal and a commit failure", () => {
    const log = runningLog(plan(1));
    finishLane(log, "M1.L1");
    log.add("commit.failed", { milestone: "M1", round: 0, tail: "hook failed" });
    expect(of(last(log), "park")).toMatchObject([{ unit: "M1", reason: "commit" }]);
    expect(of(last(log), "commit")).toEqual([]);
    log.add("question.parked", { unit: "M1", question: "q", reason: "commit" });
    log.add("question.answered", { unit: "M1", answer: "fixed the hook", by: "owner" });
    log.add("report.posted", { kind: "parked", unit: "M1", text: "x" });
    expect(last(log)).toEqual([{ type: "commit", milestone: "M1", round: 0 }]);
    const l = base1();
    l.add("land.refused", { milestone: "M1", code: "E_LAND_GATE", message: "no reviewer", fix: "run it" });
    // the first refusal is most often a verifier that skipped gate_run: a fresh one hears the message
    expect(of(last(l), "park")).toEqual([]);
    expect(of(last(l), "dispatch")[0]).toMatchObject({ name: "verifier-M1", brief: "verify" });
    expect(of(last(l), "dispatch")[0]?.notes.join("\n")).toContain("no reviewer");
    const v = startDispatch(l, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
    endDispatch(l, v, { name: "verifier-M1", unit: "M1", verdict: "pass", head: "c0" });
    expect(of(last(l), "land")).toHaveLength(1);
    l.add("land.refused", { milestone: "M1", code: "E_LAND_GATE", message: "again", fix: "run it" });
    expect(of(last(l), "park")).toMatchObject([{ unit: "M1", reason: "land" }]);
    expect(names(last(l))).toEqual([]);
  });
});

/** lane M1.L<n> of a plan(2) run, dispatched and ended with `o` */
function stop(log: Log, lane: string, o: Omit<Parameters<typeof endDispatch>[2], "name" | "unit">) {
  const name = `worker-${lane}`;
  const w = startDispatch(log, { name, unit: lane });
  endDispatch(log, w, { ...o, name, unit: lane });
  return w;
}
const blocked = (reason: BlockedReason, why: string = reason, foreign: string[] = []) => ({
  replyStatus: "blocked" as const,
  reason,
  why: `${reason}: ${why}`,
  foreign,
});

describe("the machine: stop reasons (spec 2.0 decision 8)", () => {
  it("climbs a too_hard lane, and parks it at the top rung", () => {
    const log = runningLog(plan(2));
    stop(log, "M1.L1", blocked("too_hard"));
    expect(of(last(log), "judge")).toEqual([]);
    expect(of(last(log), "climb")).toEqual([{ type: "climb", lane: "M1.L1", reason: "blocked" }]);
    log.add("lane.climbed", { lane: "M1.L1", rung: "codex:gpt-6-sol#high", top: false });
    expect(of(last(log), "dispatch")[0]).toMatchObject({ rung: "codex:gpt-6-sol#high", thread: null });
    stop(log, "M1.L1", blocked("too_hard"));
    log.add("lane.climbed", { lane: "M1.L1", rung: "codex:gpt-6-sol#high", top: true });
    // a stronger model was the only fix: the owner is asked, not the judge
    expect(of(last(log), "judge")).toEqual([]);
    expect(of(last(log), "park")).toMatchObject([{ unit: "M1.L1", reason: "too_hard" }]);
  });

  it("asks the judge about needs_user, and parks no_access and out_of_scope at once", () => {
    for (const reason of ["no_access", "out_of_scope"] as const) {
      const log = runningLog(plan(2));
      stop(log, "M1.L1", blocked(reason, "the sandbox cannot reach the staging api"));
      const out = last(log);
      expect(of(out, "judge")).toEqual([]);
      expect(names(out)).toEqual(["worker-M1.L2"]);
      expect(of(out, "park")).toMatchObject([{ unit: "M1.L1", reason }]);
      expect(of(out, "park")[0]?.question).toContain("staging api");
    }
    const log = runningLog(plan(2));
    stop(log, "M1.L1", blocked("needs_user", "keep v1?"));
    expect(of(last(log), "judge")[0]?.input).toMatchObject({ kind: "question", unit: "M1.L1" });
    expect(of(last(log), "park")).toEqual([]);
  });

  it("retries a provider_error once on its rung, then fails it over", () => {
    const log = runningLog(plan(2));
    stop(log, "M1.L1", { ...blocked("provider_error"), thread: "t-9" });
    expect(of(last(log), "dispatch").find((d) => d.lane === "M1.L1")).toMatchObject({
      rung: "codex:gpt-6-sol#medium",
      thread: null,
      failoverFrom: null,
    });
    stop(log, "M1.L1", blocked("provider_error"));
    // no limit was hit, so no quota is held: the dispatch fails over all the same
    expect(log.state().holds).toEqual({});
    expect(of(last(log), "dispatch").find((d) => d.lane === "M1.L1")).toMatchObject({
      failoverFrom: "codex:gpt-6-sol#medium",
      thread: null,
    });
    stop(log, "M1.L1", blocked("provider_error"));
    expect(of(last(log), "park")).toMatchObject([{ unit: "M1.L1", reason: "provider_error" }]);
  });

  it("parks a lane that repeated a provider_error when no stand-in is free and nothing is held", () => {
    const log = runningLog(plan(2));
    stop(log, "M1.L1", blocked("provider_error"));
    stop(log, "M1.L1", blocked("provider_error"));
    expect(log.state().holds).toEqual({});
    log.add("dispatch.refused", {
      name: "worker-M1.L1",
      unit: "M1.L1",
      code: "E_ALL_HELD",
      message: "every stand-in is held",
    });
    expect(log.state().stuck["M1.L1"]).toMatchObject({ reason: "provider_error" });
    expect(of(last(log), "park")).toMatchObject([{ unit: "M1.L1", reason: "provider_error" }]);
  });

  it("counts a lane whose check fails only in a sibling's files as done", () => {
    const log = runningLog(plan(2));
    stop(log, "M1.L1", {});
    log.add("check.ran", { lane: "M1.L1", exit: 1, tail: "src/b/x.ts:3 error", foreign: ["src/b"] });
    expect(log.state().lanes["M1.L1"]?.status).toBe("done");
    // the same for a worker that said so itself
    const other = runningLog(plan(2));
    stop(other, "M1.L2", blocked("check_broken", "src/a/x.ts:3 fails", ["src/a"]));
    expect(other.state().lanes["M1.L2"]?.status).toBe("done");
    expect(of(last(other), "judge")).toEqual([]);
  });

  it("holds a check_broken lane while a sibling runs or is untried, retries it once, then parks it", () => {
    const log = runningLog(plan(2));
    stop(log, "M1.L1", blocked("check_broken", "lint fails in src/b/y.ts"));
    // M1.L2 was never tried: L1 waits for it
    expect(names(last(log))).toEqual(["worker-M1.L2"]);
    const w2 = startDispatch(log, { name: "worker-M1.L2", unit: "M1.L2" });
    expect(names(last(log))).toEqual([]);
    endDispatch(log, w2, { name: "worker-M1.L2", unit: "M1.L2" });
    log.add("check.ran", { lane: "M1.L2", exit: 0, tail: "", foreign: [] });
    expect(names(last(log))).toEqual(["worker-M1.L1"]);
    stop(log, "M1.L1", blocked("check_broken", "lint still fails"));
    expect(of(last(log), "park")).toMatchObject([{ unit: "M1.L1", reason: "check_broken" }]);
    expect(names(last(log))).toEqual([]);
  });

  it("does not hold a check_broken lane for a sibling that tried and stopped", () => {
    const log = runningLog(plan(2));
    stop(log, "M1.L2", blocked("no_access"));
    log.add("question.parked", { unit: "M1.L2", question: "q", reason: "no_access" });
    stop(log, "M1.L1", blocked("check_broken"));
    expect(names(last(log))).toEqual(["worker-M1.L1"]);
  });

  it("reruns a verifier's first check_broken and parks the second; BLOCKED: environment still parks first", () => {
    const base = () => {
      const log = runningLog(plan(1));
      finishLane(log, "M1.L1");
      log.add("commit.made", { milestone: "M1", round: 0, commit: "c0" });
      review(log, []);
      return log;
    };
    const verify = (log: Log, o: Omit<Parameters<typeof endDispatch>[2], "name" | "unit">) => {
      const v = startDispatch(log, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
      endDispatch(log, v, { ...o, name: "verifier-M1", unit: "M1" });
      return last(log);
    };
    const broken = { ...blocked("check_broken", "the check needs a db"), verdict: "fail" as const };
    const log = base();
    expect(names(verify(log, broken))).toEqual(["verifier-M1"]);
    expect(of(verify(log, broken), "park")).toMatchObject([{ unit: "M1", reason: "check_broken" }]);
    expect(names(last(log))).toEqual([]);
    // an environment verdict keeps its own park, ahead of the reason
    const env = verify(base(), { ...broken, verdict: "blocked", environment: "docker ps fails" });
    expect(of(env, "park")).toMatchObject([{ unit: "M1", reason: "environment" }]);
  });

  it("asks Jev about a stop with no reason, and acts on the reason it names", () => {
    const log = runningLog(plan(2));
    const w = stop(log, "M1.L1", { replyStatus: "blocked", why: "I could not do it" });
    expect(of(last(log), "classify")).toEqual([{ type: "classify", dispatchId: w }]);
    // the lane waits for the answer; its sibling does not
    expect(names(next(log.state(), log.events.at(-1) as RunEvent))).toEqual(["worker-M1.L2"]);
    classified(log, w, "needs_user");
    expect(of(last(log), "judge")[0]?.input).toMatchObject({ kind: "question", unit: "M1.L1" });
    const t = runningLog(plan(2));
    const w2 = stop(t, "M1.L1", { status: "timeout", replyStatus: null });
    classified(t, w2, "provider_error");
    expect(of(last(t), "dispatch").find((d) => d.lane === "M1.L1")).toMatchObject({ thread: null });
    expect(t.state().lanes["M1.L1"]).toMatchObject({ lastReason: "provider_error", attempts: 0 });
    // an ok end with no STATUS line goes on to its check when Jev says nothing
    const u = runningLog(plan(2));
    const w3 = stop(u, "M1.L1", { replyStatus: null });
    expect(of(last(u), "classify")).toEqual([{ type: "classify", dispatchId: w3 }]);
    classified(u, w3, null);
    expect(of(last(u), "fastCheck")).toEqual([{ type: "fastCheck", lane: "M1.L1" }]);
  });

  it("handles a stop with no reason as 1.5 does when Jev is off", () => {
    const log = runningLog(plan(2));
    const w = stop(log, "M1.L1", { replyStatus: "blocked", why: "the tests fail" });
    expect(of(last(log), "classify")).toEqual([{ type: "classify", dispatchId: w }]);
    classified(log, w, null);
    expect(of(last(log), "judge")).toEqual([]);
    expect(of(last(log), "climb")).toEqual([{ type: "climb", lane: "M1.L1", reason: "blocked" }]);
    // a classification that cannot be made is none
    const f = runningLog(plan(2));
    stop(f, "M1.L1", { replyStatus: "refused" });
    f.add("effect.failed", { action: "classify", unit: "M1.L1", message: "jev down" });
    expect(of(last(f), "climb")).toEqual([{ type: "climb", lane: "M1.L1", reason: "blocked" }]);
    expect(of(last(f), "park")).toEqual([]);
  });

  it("re-verifies a PASS whose HEAD is not the milestone's commit", () => {
    const log = runningLog(plan(1));
    finishLane(log, "M1.L1");
    log.add("commit.made", { milestone: "M1", round: 0, commit: "c0123456789abcdef" });
    review(log, []);
    const v = startDispatch(log, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
    endDispatch(log, v, { name: "verifier-M1", unit: "M1", verdict: "pass", head: "deadbeef" });
    const out = last(log);
    expect(of(out, "land")).toEqual([]);
    expect(of(out, "dispatch")[0]?.notes.join("\n")).toContain("verify c0123456789a");
    // a PASS with no HEAD line is the same
    const v2 = startDispatch(log, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
    endDispatch(log, v2, { name: "verifier-M1", unit: "M1", verdict: "pass" });
    expect(of(last(log), "park")).toMatchObject([{ unit: "M1", reason: "verifier" }]);
    // the right commit, by a prefix, lands
    const ok = base1();
    expect(of(last(ok), "land")).toHaveLength(1);
  });
});

function base1(): Log {
  const log = runningLog(plan(1));
  finishLane(log, "M1.L1");
  log.add("commit.made", { milestone: "M1", round: 0, commit: "c0" });
  review(log, []);
  const v = startDispatch(log, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
  endDispatch(log, v, { name: "verifier-M1", unit: "M1", verdict: "pass", head: "c0" });
  return log;
}

/** base1() in a run with a base branch: the verifier passed M1's commit c0 and the milestone is landing */
function baseRun(): Log {
  const log = runningLog(plan(1), "main");
  finishLane(log, "M1.L1");
  log.add("commit.made", { milestone: "M1", round: 0, commit: "c0" });
  review(log, []);
  const v = startDispatch(log, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
  endDispatch(log, v, { name: "verifier-M1", unit: "M1", verdict: "pass", head: "c0" });
  return log;
}

const landed = (log: Log, branch?: string) =>
  log.add("milestone.landed", {
    milestone: "M1",
    commit: "c0abcdef0123",
    knownIssues: [],
    digestPath: "d",
    ...(branch ? { branch } : {}),
  });

describe("the machine: a run with a base branch (spec 2.0, decision 21)", () => {
  it("integrates a base that moved before landing, then has a fresh verifier gate the merge", () => {
    const log = baseRun();
    expect(of(last(log), "land")).toHaveLength(1);
    log.add("base.behind", { milestone: "M1" });
    let out = last(log);
    expect(of(out, "integrate")).toEqual([{ type: "integrate", milestone: "M1" }]);
    expect(of(out, "land")).toEqual([]);
    log.add("integrate.done", { milestone: "M1", commit: "m1abcdef0123456" });
    out = last(log);
    expect(of(out, "land")).toEqual([]);
    expect(of(out, "dispatch")).toMatchObject([
      {
        name: "verifier-M1",
        role: "verifier",
        brief: "verify",
        notes: [expect.stringContaining("m1abcdef0123")],
      },
    ]);
    expect(log.state().milestones[0]?.commit).toBe("m1abcdef0123456");
    const v = startDispatch(log, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
    endDispatch(log, v, { name: "verifier-M1", unit: "M1", verdict: "pass", head: "m1abcdef0123456" });
    expect(of(last(log), "land")).toHaveLength(1);
  });

  it("sends conflicts to an integrate worker, then commits and re-verifies", () => {
    const log = baseRun();
    log.add("base.behind", { milestone: "M1" });
    log.add("integrate.conflict", { milestone: "M1", files: ["src/a/x.ts", "README.md"] });
    const out = last(log);
    expect(of(out, "integrate")).toEqual([]);
    expect(of(out, "dispatch")).toMatchObject([
      {
        name: "worker-M1-integrate",
        role: "worker",
        lane: null,
        brief: "fix",
        notes: ["src/a/x.ts", "README.md"],
      },
    ]);
    const w = startDispatch(log, { name: "worker-M1-integrate", unit: "M1", lane: null });
    endDispatch(log, w, { name: "worker-M1-integrate", unit: "M1" });
    expect(of(last(log), "commit")).toEqual([{ type: "commit", milestone: "M1", round: 1 }]);
    log.add("commit.made", { milestone: "M1", round: 1, commit: "m2abcdef0123456" });
    const after = last(log);
    expect(of(after, "dispatch")).toMatchObject([{ name: "verifier-M1", brief: "verify" }]);
    expect(names(after)).not.toContain("reviewer-M1");
    expect(log.state().milestones[0]?.integrateFiles).toEqual([]);
  });

  it("parks a landed milestone for its push, and closes the question when origin's base contains it", () => {
    const log = baseRun();
    landed(log, "feat/wallet");
    let out = last(log);
    expect(of(out, "park")).toMatchObject([{ unit: "M1", reason: "push" }]);
    const question = of(out, "park")[0]?.question ?? "";
    expect(question).toContain("M1 landed on feat/wallet at c0abcdef0123");
    expect(question).toContain("git merge-base --is-ancestor origin/main HEAD");
    expect(of(out, "checkMerged")).toEqual([{ type: "checkMerged", milestone: "M1" }]);
    // M2 comes after M1: it waits for the merge, not for the landing
    expect(of(out, "route")).toEqual([]);
    log.add("question.parked", { unit: "M1", question: "q", reason: "push" });
    expect(log.state().milestones[0]?.status).toBe("landed");
    expect(log.state().questions.M1?.reason).toBe("push");
    // while it waits, the machine looks again every ten minutes
    const due = log.state().wakeAt as string;
    log.add("tick", {}, due);
    expect(of(last(log), "checkMerged")).toEqual([{ type: "checkMerged", milestone: "M1" }]);
    expect(Date.parse(log.state().wakeAt as string) - Date.parse(due)).toBe(600_000);
    log.add("milestone.merged", { milestone: "M1" });
    out = last(log);
    expect(log.state().questions.M1).toBeUndefined();
    expect(of(out, "route")).toEqual([{ type: "route", milestone: "M2", confirmed: false }]);
  });

  it("unblocks a dependant of a squash merge only by the owner's answer", () => {
    const log = baseRun();
    landed(log, "feat/wallet");
    log.add("question.parked", { unit: "M1", question: "q", reason: "push" });
    expect(of(last(log), "route")).toEqual([]);
    log.add("question.answered", { unit: "M1", answer: "merged by squash", by: "owner" });
    expect(log.state().milestones[0]?.status).toBe("merged");
    expect(of(last(log), "route")).toEqual([{ type: "route", milestone: "M2", confirmed: false }]);
  });

  it("finishes only when every milestone is merged", () => {
    const log = runningLog(plan(1), "main");
    log.add("milestone.landed", { milestone: "M1", commit: "c1", knownIssues: [], digestPath: "d" });
    log.add("milestone.merged", { milestone: "M1" });
    log.add("milestone.landed", { milestone: "M2", commit: "c2", knownIssues: [], digestPath: "d" });
    expect(of(last(log), "finish")).toEqual([]);
    log.add("milestone.merged", { milestone: "M2" });
    expect(of(last(log), "finish")).toEqual([{ type: "finish", outcome: "done" }]);
  });

  it("a run without base lands as 1.5: no push question, no merge check, dependants wait for landed only", () => {
    const log = base1();
    landed(log);
    const out = last(log);
    expect(of(out, "park")).toEqual([]);
    expect(of(out, "checkMerged")).toEqual([]);
    expect(of(out, "route")).toEqual([{ type: "route", milestone: "M2", confirmed: false }]);
    expect(log.state().wakeAt).toBeNull();
  });
});

describe("the machine: the run", () => {
  it("reports and notifies a landing, then goes on to the next milestone", () => {
    const log = base1();
    log.add("milestone.landed", {
      milestone: "M1",
      commit: "c0abcdef",
      knownIssues: [],
      digestPath: "digests/M1.md",
    });
    const out = last(log);
    expect(of(out, "report")).toMatchObject([{ kind: "landed", unit: "M1" }]);
    expect(of(out, "notify")).toEqual([{ type: "notify", unit: "M1", moment: "milestone" }]);
    expect(of(out, "route")).toEqual([{ type: "route", milestone: "M2", confirmed: false }]);
  });

  it("finishes once every milestone landed, and waits while one is parked", () => {
    const log = runningLog(plan(1));
    log.add("milestone.landed", { milestone: "M1", commit: "c1", knownIssues: [], digestPath: "d" });
    expect(of(last(log), "finish")).toEqual([]);
    log.add("question.parked", { unit: "M2", question: "q", reason: "needs_user" });
    expect(last(log).filter((a) => a.type !== "report" && a.type !== "notify")).toEqual([]);
    log.add("question.answered", { unit: "M2", answer: "go", by: "owner" });
    log.add("milestone.landed", { milestone: "M2", commit: "c2", knownIssues: [], digestPath: "d" });
    expect(of(last(log), "finish")).toEqual([{ type: "finish", outcome: "done" }]);
    for (const [kind, unit] of [
      ["landed", "M1"],
      ["parked", "M2"],
      ["landed", "M2"],
    ] as const)
      log.add("report.posted", { kind, unit, text: "x" });
    log.add("run.ended", { outcome: "done", reportPath: "report.md" });
    const out = last(log);
    expect(of(out, "report")).toMatchObject([{ kind: "finished" }]);
    expect(of(out, "notify")).toEqual([{ type: "notify", unit: "run", moment: "finish" }]);
    expect(of(out, "finish")).toEqual([]);
  });

  it("reports and notifies a park", () => {
    const log = runningLog();
    log.add("question.parked", { unit: "M1", question: "which db?", reason: "needs_user" });
    expect(of(last(log), "report")).toMatchObject([{ kind: "parked", unit: "M1" }]);
    expect(of(last(log), "notify")).toEqual([{ type: "notify", unit: "M1", moment: "blocked" }]);
  });

  it("owes a park's report and notice until report.posted, whatever the next event is", () => {
    const log = runningLog();
    log.add("question.parked", { unit: "M1", question: "which db?", reason: "needs_user" });
    // the daemon died before the report: the revived one sees only its own hello
    log.add("daemon.started", { pid: 1, version: "x" });
    expect(of(last(log), "report")).toMatchObject([{ kind: "parked", unit: "M1" }]);
    expect(of(last(log), "notify")).toEqual([{ type: "notify", unit: "M1", moment: "blocked" }]);
    log.add("report.posted", { kind: "parked", unit: "M1", text: "x" });
    expect(of(last(log), "report")).toEqual([]);
    expect(of(last(log), "notify")).toEqual([]);
  });

  it("issues a unit's report again when it parks a second time in one daemon process", () => {
    const log = runningLog();
    const issued = new Set<string>();
    const feed = () => {
      const e = log.events.at(-1) as RunEvent;
      for (const k of confirms(e)) issued.delete(k);
      return next(log.state(), e).filter((a) => {
        if (issued.has(actionKey(a))) return false;
        issued.add(actionKey(a));
        return true;
      });
    };
    log.add("question.parked", { unit: "M1", question: "q1", reason: "needs_user" });
    expect(of(feed(), "report")).toHaveLength(1);
    log.add("report.posted", { kind: "parked", unit: "M1", text: "x" });
    feed();
    log.add("question.answered", { unit: "M1", answer: "a", by: "owner" });
    feed();
    log.add("question.parked", { unit: "M1", question: "q2", reason: "needs_user" });
    expect(of(feed(), "report")).toMatchObject([{ kind: "parked", unit: "M1" }]);
  });

  it("owes a landing's report and notice until report.posted", () => {
    const log = base1();
    log.add("milestone.landed", { milestone: "M1", commit: "c0abcdef", knownIssues: [], digestPath: "d" });
    log.add("daemon.started", { pid: 1, version: "x" });
    expect(of(last(log), "report")).toMatchObject([{ kind: "landed", unit: "M1" }]);
    expect(of(last(log), "notify")).toEqual([{ type: "notify", unit: "M1", moment: "milestone" }]);
    log.add("report.posted", { kind: "landed", unit: "M1", text: "x" });
    expect(of(last(log), "report")).toEqual([]);
  });

  it("fails a limited lane over, and waits out the hold when every candidate is held", () => {
    const log = runningLog();
    const w = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1", rung: "codex:gpt-6-sol#medium" });
    endDispatch(log, w, {
      name: "worker-M1.L1",
      unit: "M1.L1",
      status: "limit",
      replyStatus: null,
      at: "2026-10-21T10:00:00.000Z",
    });
    const d = of(last(log), "dispatch")[0];
    expect(d).toMatchObject({ name: "worker-M1.L1", failoverFrom: "codex:gpt-6-sol#medium", thread: null });
    log.add(
      "dispatch.refused",
      { name: "worker-M1.L1", unit: "M1.L1", code: "E_ALL_HELD", message: "all held" },
      "2026-10-21T10:00:05.000Z",
    );
    expect(names(last(log))).toEqual([]);
    expect(log.state().wakeAt).toBe("2026-10-21T10:30:00.000Z");
    log.add("tick", {}, "2026-10-21T10:30:01.000Z");
    expect(of(last(log), "dispatch")[0]).toMatchObject({ name: "worker-M1.L1", failoverFrom: null });
  });

  it("cancels every live dispatch, then ends the run cancelled", () => {
    const log = runningLog();
    const a = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    const b = startDispatch(log, { name: "worker-M1.L9", unit: "M1.L9" });
    log.add("cancel.requested", { by: "owner" });
    expect(last(log)).toEqual([{ type: "cancel", dispatchIds: [a, b] }]);
    endDispatch(log, a, { name: "worker-M1.L1", unit: "M1.L1", status: "cancelled", replyStatus: null });
    expect(of(last(log), "cancel")).toEqual([{ type: "cancel", dispatchIds: [b] }]);
    endDispatch(log, b, { name: "worker-M1.L9", unit: "M1.L9", status: "cancelled", replyStatus: null });
    expect(last(log)).toEqual([{ type: "finish", outcome: "cancelled" }]);
    const none = runningLog();
    none.add("cancel.requested", { by: "owner" });
    expect(last(none)).toEqual([{ type: "finish", outcome: "cancelled" }]);
  });

  it("on daemon.started watches each live dispatch and re-issues what was decided but never started", () => {
    const log = runningLog();
    const w = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    log.add("daemon.started", { pid: 2, version: "2.0.0" });
    const out = last(log);
    expect(of(out, "watch")).toEqual([{ type: "watch", dispatchId: w }]);
    expect(names(out)).toEqual([]);
    // a lane decided, never started: the restart dispatches it
    const fresh = runningLog();
    fresh.add("daemon.started", { pid: 2, version: "2.0.0" });
    expect(names(last(fresh))).toEqual(["worker-M1.L1"]);
  });

  it("retries a failed effect once, then parks its unit", () => {
    const log = runningLog();
    log.add("effect.failed", { action: "dispatch", unit: "M1.L1", message: "launch failed" });
    expect(names(last(log))).toEqual(["worker-M1.L1"]);
    expect(of(last(log), "park")).toEqual([]);
    log.add("effect.failed", { action: "dispatch", unit: "M1.L1", message: "launch failed" });
    expect(of(last(log), "park")).toMatchObject([{ unit: "M1.L1", reason: "effect" }]);
    expect(names(last(log))).toEqual([]);
  });
});

describe("the machine: action keys", () => {
  it("gives each action a stable key its confirming event settles", () => {
    const log = runningLog();
    const a = last(log)[0] as Action;
    expect(actionKey(a)).toBe("dispatch:worker-M1.L1");
    const started = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    expect(confirms(log.events.at(-1) as RunEvent)).toContain("dispatch:worker-M1.L1");
    endDispatch(log, started, { name: "worker-M1.L1", unit: "M1.L1" });
    expect(confirms(log.events.at(-1) as RunEvent)).toContain(`watch:${started}`);
    log.add("effect.failed", { action: "dispatch", unit: "M1.L1", message: "x" });
    expect(confirms(log.events.at(-1) as RunEvent)).toEqual([failKey(a)]);
    expect(failKey({ type: "fastCheck", lane: "M1.L1" })).toBe("fastCheck@M1.L1");
  });

  it("never returns a dispatch for a live name, over every state of a run", () => {
    const log = runningLog(plan(2));
    const states: [RunState, RunEvent][] = [];
    const walk = () => states.push([log.state(), log.events.at(-1) as RunEvent]);
    walk();
    const a = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    walk();
    endDispatch(log, a, { name: "worker-M1.L1", unit: "M1.L1" });
    walk();
    log.add("check.ran", { lane: "M1.L1", exit: 0, tail: "", foreign: [] });
    walk();
    startDispatch(log, { name: "worker-M1.L2", unit: "M1.L2" });
    log.add("daemon.started", { pid: 1, version: "2.0.0" });
    walk();
    for (const [s, e] of states) {
      const live = new Set(liveDispatches(s).map((d) => d.name));
      for (const x of next(s, e)) if (x.type === "dispatch") expect(live.has(x.name)).toBe(false);
    }
  });

  it("rebuilds a judge's input from the state alone", () => {
    const log = runningLog();
    const w = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    endDispatch(log, w, {
      name: "worker-M1.L1",
      unit: "M1.L1",
      replyStatus: "blocked",
      reason: "needs_user",
    });
    const out = of(last(log), "judge")[0]!;
    expect(judgeInputFor(log.state(), out.input.id, "question", "M1.L1")).toEqual(out.input);
    expect(newId()).toMatch(/^D\d+$/);
    routeMilestone(makeLog(), PLAN[0] as MilestonePlan);
  });
});

describe("the machine: the owner's approval of the architect's plan", () => {
  /** a run with no plan whose architect (thread t-arch) wrote one that was read */
  function planned(): Log {
    const log = makeLog();
    log.add("run.started", startedFields);
    const d = startDispatch(log, { name: "researcher-dossier", role: "researcher", unit: "run", lane: null });
    endDispatch(log, d, { name: "researcher-dossier", unit: "run" });
    const a = startDispatch(log, {
      name: "architect",
      role: "architect",
      unit: "run",
      lane: null,
      thread: "t-arch",
    });
    endDispatch(log, a, { name: "architect", unit: "run", thread: "t-arch" });
    log.add("plan.ready", { milestones: PLAN });
    return log;
  }
  const ask = (log: Log) =>
    log.add("question.parked", { unit: "run", question: approvalQuestion("r1"), reason: "approval" });
  const noWork = (as: Action[]) =>
    expect(as.filter((a) => ["route", "dispatch", "fastCheck", "commit", "land"].includes(a.type))).toEqual(
      [],
    );

  it("waits in approval for the owner, revises on a change request and routes only after the approval", () => {
    const log = planned();
    expect(log.state().phase).toBe("approval");
    expect(last(log)).toEqual([
      { type: "park", unit: "run", question: approvalQuestion("r1"), reason: "approval" },
    ]);
    ask(log);
    expect(last(log).map((a) => a.type)).toEqual(["report", "notify"]);
    log.add("question.answered", { unit: "run", answer: "rename Ledger to Book", by: "owner" });
    log.add("report.posted", { kind: "parked", unit: "run", text: "posted" });
    expect(last(log).map((a) => a.type)).toEqual(["dispatch"]);
    expect(of(last(log), "dispatch")).toEqual([
      expect.objectContaining({
        type: "dispatch",
        name: "architect",
        brief: "architect",
        thread: "t-arch",
        notes: ["The owner asked for these changes to plan.md: rename Ledger to Book"],
      }),
    ]);
    const a = startDispatch(log, {
      name: "architect",
      role: "architect",
      unit: "run",
      lane: null,
      thread: "t-arch",
    });
    expect(last(log)).toEqual([]);
    endDispatch(log, a, { name: "architect", unit: "run", thread: "t-arch" });
    expect(last(log).map((x) => x.type)).toEqual(["readPlan"]);
    log.add("plan.ready", { milestones: PLAN });
    expect(log.state().phase).toBe("approval");
    expect(last(log).map((x) => x.type)).toEqual(["park"]);
    ask(log);
    log.add("plan.approved", { by: "owner" });
    expect(log.state().phase).toBe("running");
    expect(log.state().questions.run).toBeUndefined();
    expect(of(last(log), "route")).toEqual([{ type: "route", milestone: "M1", confirmed: false }]);
  });

  it("runs a plan given as input with no approval stop", () => {
    const log = makeLog();
    log.add("run.started", { ...startedFields, plan: ["/p.md"] });
    log.add("plan.approved", { by: "input" });
    expect(names(last(log))).toEqual(["architect"]);
    const a = startDispatch(log, { name: "architect", role: "architect", unit: "run", lane: null });
    endDispatch(log, a, { name: "architect", unit: "run" });
    log.add("plan.ready", { milestones: PLAN });
    expect(log.state().phase).toBe("running");
    expect(of(last(log), "route")).toEqual([{ type: "route", milestone: "M1", confirmed: false }]);
  });

  it("sends a plan the readPlan check refused back to the architect twice, then parks the run", () => {
    const log = makeLog();
    log.add("run.started", { ...startedFields, plan: ["/p.md"] });
    log.add("plan.approved", { by: "input" });
    const a = startDispatch(log, {
      name: "architect",
      role: "architect",
      unit: "run",
      lane: null,
      thread: "t-arch",
    });
    endDispatch(log, a, { name: "architect", unit: "run", thread: "t-arch" });
    for (const n of [1, 2]) {
      log.add("effect.failed", { action: "readPlan", unit: "run", message: `the plan needs: gap ${n}` });
      expect(last(log)).toEqual([
        expect.objectContaining({
          type: "dispatch",
          name: "architect",
          thread: "t-arch",
          notes: [`the plan needs: gap ${n}`],
        }),
      ]);
      const b = startDispatch(log, {
        name: "architect",
        role: "architect",
        unit: "run",
        lane: null,
        thread: "t-arch",
      });
      endDispatch(log, b, { name: "architect", unit: "run", thread: "t-arch" });
    }
    log.add("effect.failed", { action: "readPlan", unit: "run", message: "the plan needs: gap 3" });
    expect(names(last(log))).toEqual([]);
    expect(of(last(log), "park")).toMatchObject([{ unit: "run", reason: "effect" }]);
  });

  it("dispatches no lane and no route while the plan waits for approval, over every event", () => {
    const log = planned();
    noWork(last(log));
    ask(log);
    noWork(last(log));
    log.add("tick", {});
    noWork(last(log));
    log.add("daemon.started", { pid: 1, version: "x" });
    noWork(last(log));
  });

  it("stops new lanes on a re-approval park until the owner approves again", () => {
    const log = runningLog();
    expect(log.state().phase).toBe("running");
    log.add("question.parked", {
      unit: "run",
      question: reapprovalQuestion("r1", ["D2"]),
      reason: "approval",
    });
    expect(log.state().phase).toBe("approval");
    noWork(last(log));
    log.add("plan.ready", { milestones: PLAN });
    expect(log.state().phase).toBe("approval");
    expect(last(log).map((a) => a.type)).not.toContain("park");
    noWork(last(log));
    log.add("plan.approved", { by: "owner" });
    expect(log.state().phase).toBe("running");
    expect(names(last(log))).toEqual(["worker-M1.L1"]);
  });

  it("keeps a mid-run architect change that edits no decision running, with no approval stop", () => {
    const log = runningLog();
    log.add("plan.ready", { milestones: PLAN });
    expect(log.state().phase).toBe("running");
    expect(of(last(log), "park")).toEqual([]);
  });
});
