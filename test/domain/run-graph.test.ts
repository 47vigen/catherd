import { describe, expect, it } from "bun:test";
import type { RunRecord } from "../../src/domain/record.ts";
import type { ParkReason } from "../../src/domain/run-events.ts";
import {
  deriveRunModel,
  diffRunModel,
  nodeForUnit,
  type RunModel,
  RunModelSchema,
} from "../../src/domain/run-graph.ts";
import type { MilestoneStatus } from "../../src/domain/run-state.ts";
import { makeRecord } from "./make-record.ts";
import {
  endDispatch,
  finishLane,
  type Log,
  makeLog,
  PLAN,
  routeMilestone,
  runningLog,
  startDispatch,
  startedFields,
} from "./run-fixtures.ts";

function model(log: Log, records: RunRecord[] = []): RunModel {
  const m = deriveRunModel({ run: "r1", state: log.state(), events: log.events, records });
  return RunModelSchema.parse(m);
}
const ids = (m: RunModel): string[] => m.nodes.map((n) => n.id);
const node = (m: RunModel, id: string) => {
  const n = m.nodes.find((x) => x.id === id);
  if (!n) throw new Error(`no node ${id}: ${ids(m).join(", ")}`);
  return n;
};
const edgeSet = (m: RunModel): string[] => m.edges.map((e) => `${e.from} > ${e.to}`).sort();

describe("the graph's shape", () => {
  it("before the plan the graph is the run, the plan and the milestones to come", () => {
    const log = makeLog();
    log.add("run.started", startedFields);
    startDispatch(log, { name: "architect", role: "architect", unit: "run", lane: null });
    const m = model(log);
    expect(ids(m)).toEqual(["start", "architect", "later"]);
    expect(node(m, "start").status).toBe("done");
    expect(node(m, "architect").status).toBe("running");
    expect(node(m, "later").status).toBe("pending");
    expect(node(m, "later").now).toBe("Known once the plan is ready");
    expect(edgeSet(m)).toEqual(["architect > later", "start > architect"]);
  });

  it("plan.ready draws each milestone's steps as pending, in protocol order", () => {
    const log = makeLog();
    log.add("run.started", startedFields);
    log.add("plan.ready", { milestones: PLAN });
    const m = model(log);
    expect(ids(m)).toEqual([
      "start",
      "architect",
      "M1/route",
      "M1/preflight",
      "M1/lane/M1.L1",
      "M1/check/M1.L1",
      "M1/lane/M1.L2",
      "M1/check/M1.L2",
      "M1/commit",
      "M1/review",
      "M1/verify",
      "M1/land",
      "M2/route",
      "M2/preflight",
      "M2/lane/M2.L1",
      "M2/check/M2.L1",
      "M2/commit",
      "M2/review",
      "M2/verify",
      "M2/land",
      "judge",
      "report",
      "end",
    ]);
    expect(edgeSet(m)).toEqual(
      [
        "start > architect",
        "architect > M1/route",
        "M1/route > M1/preflight",
        "M1/preflight > M1/lane/M1.L1",
        "M1/lane/M1.L1 > M1/check/M1.L1",
        "M1/check/M1.L1 > M1/lane/M1.L2",
        "M1/lane/M1.L2 > M1/check/M1.L2",
        "M1/check/M1.L2 > M1/commit",
        "M1/commit > M1/review",
        "M1/review > M1/verify",
        "M1/verify > M1/land",
        "M1/land > M2/route",
        "M2/route > M2/preflight",
        "M2/preflight > M2/lane/M2.L1",
        "M2/lane/M2.L1 > M2/check/M2.L1",
        "M2/check/M2.L1 > M2/commit",
        "M2/commit > M2/review",
        "M2/review > M2/verify",
        "M2/verify > M2/land",
        "M2/land > judge",
        "judge > report",
        "report > end",
      ].sort(),
    );
    expect(m.nodes.filter((n) => n.status === "pending").length).toBe(21);
    expect(node(m, "M1/lane/M1.L1").title).toBe("M1.L1 worker");
    expect(node(m, "M1/lane/M1.L1").now).toBe("Starts after M1 preflight");
    expect(node(m, "M2/route").now).toBe("Starts after M1 land");
  });

  it("a lane's after runs from the earlier lane's check", () => {
    const m = model(runningLog());
    const edges = edgeSet(m);
    expect(edges).toContain("M1/check/M1.L1 > M1/lane/M1.L2");
    expect(edges).not.toContain("M1/preflight > M1/lane/M1.L2");
    expect(edges).not.toContain("M1/check/M1.L1 > M1/commit");
    expect(node(m, "M1/lane/M1.L2").now).toBe("Starts after M1.L1 fast check");
  });

  it("an integrate node appears for a base run", () => {
    const m = model(runningLog(PLAN, "main"));
    expect(ids(m)).toContain("M1/integrate");
    expect(edgeSet(m)).toContain("M1/verify > M1/integrate");
    expect(edgeSet(m)).toContain("M1/integrate > M1/land");
  });
});

describe("attempts", () => {
  it("a fix round adds attempts to lane, check, commit and review, never an edge", () => {
    const log = runningLog();
    const before = edgeSet(model(log));
    finishLane(log, "M1.L1");
    finishLane(log, "M1.L2");
    log.add("commit.made", { milestone: "M1", round: 0, commit: "c0".repeat(20) });
    const r1 = startDispatch(log, { name: "reviewer-M1", role: "reviewer", unit: "M1", lane: null });
    endDispatch(log, r1, {
      name: "reviewer-M1",
      unit: "M1",
      findings: [{ label: "BLOCKER", text: "BLOCKER src/a/x.ts wrong", file: "src/a/x.ts" }],
    });
    finishLane(log, "M1.L1");
    log.add("commit.made", { milestone: "M1", round: 1, commit: "c1".repeat(20) });
    const r2 = startDispatch(log, { name: "reviewer-M1", role: "reviewer", unit: "M1", lane: null });
    endDispatch(log, r2, { name: "reviewer-M1", unit: "M1" });
    const m = model(log);
    expect(node(m, "M1/lane/M1.L1").attempts.map((a) => a.label)).toEqual(["round 1", "round 0"]);
    expect(node(m, "M1/check/M1.L1").attempts.length).toBe(2);
    expect(node(m, "M1/commit").attempts.map((a) => a.commit?.slice(0, 2))).toEqual(["c1", "c0"]);
    expect(node(m, "M1/review").attempts.map((a) => a.label)).toEqual(["round 1", "round 0"]);
    expect(edgeSet(m)).toEqual(before);
    expect(m.dispatches.map((d) => d.name)).toEqual([
      "reviewer-M1",
      "worker-M1.L1",
      "reviewer-M1",
      "worker-M1.L2",
      "worker-M1.L1",
    ]);
  });

  it("a failover and a climb label their attempts", () => {
    const log = runningLog();
    const a = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    endDispatch(log, a, { name: "worker-M1.L1", unit: "M1.L1", status: "limit", replyStatus: null });
    const b = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1", rung: "codex:gpt-6.1-sol#high" });
    endDispatch(log, b, { name: "worker-M1.L1", unit: "M1.L1" });
    log.add("lane.climbed", { lane: "M1.L1", rung: "codex:gpt-6.1-sol#xhigh", top: false });
    const records = [
      makeRecord({ dispatchId: a, status: "limit", replyStatus: null }),
      makeRecord({ dispatchId: b, failoverFrom: "codex:gpt-6-sol#medium", rung: "codex:gpt-6.1-sol#high" }),
    ];
    const lane = node(model(log, records), "M1/lane/M1.L1");
    expect(lane.attempts.map((x) => x.label)).toEqual([
      "climbed to codex:gpt-6.1-sol#xhigh",
      "failover from codex:gpt-6-sol#medium",
      "round 0",
    ]);
    expect(lane.attempts.map((x) => x.status)).toEqual(["done", "done", "failed"]);
    expect(lane.attempts[1]?.failoverFrom).toBe("codex:gpt-6-sol#medium");
  });

  it("a mid-run judge is an attempt with a judge badge on its unit's node; only the rules judge is the end node", () => {
    const log = runningLog();
    const t = startDispatch(log, {
      name: "judge-t1",
      role: "judge",
      unit: "M1",
      lane: null,
      judgeKind: "triage",
    });
    const q = startDispatch(log, {
      name: "judge-q1",
      role: "judge",
      unit: "M1.L1",
      lane: null,
      judgeKind: "question",
    });
    const r = startDispatch(log, {
      name: "judge-rules",
      role: "judge",
      unit: "run",
      lane: null,
      judgeKind: "rules",
    });
    const m = model(log);
    expect(node(m, "M1/review").attempts.map((a) => [a.label, a.judge, a.dispatchId])).toEqual([
      ["judge (triage)", "triage", t],
    ]);
    expect(node(m, "M1/lane/M1.L1").attempts.map((a) => [a.label, a.judge, a.dispatchId])).toEqual([
      ["judge (question)", "question", q],
    ]);
    expect(node(m, "judge").attempts.map((a) => [a.label, a.dispatchId])).toEqual([["rules", r]]);
    expect(node(m, "judge").status).toBe("running");
  });
});

describe("questions", () => {
  const rows: [ParkReason, string, string, MilestoneStatus | null][] = [
    ["needs_user", "M1.L1", "M1/lane/M1.L1", null],
    ["too_hard", "M1.L2", "M1/lane/M1.L2", null],
    ["preflight", "M1", "M1/preflight", null],
    ["confirm", "M1", "M1/preflight", null],
    ["commit", "M1", "M1/commit", null],
    ["blocker", "M1", "M1/review", null],
    ["judge", "M1", "M1/review", null],
    ["verifier", "M1", "M1/verify", null],
    ["land", "M1", "M1/land", null],
    ["push", "M1", "M1/land", null],
    ["effect", "M1", "M1/route", "routing"],
    ["effect", "M1", "M1/route", "lanes"],
    ["effect", "M1", "M1/commit", "committing"],
    ["environment", "M1", "M1/review", "review"],
    ["effect", "M1", "M1/review", "fixing"],
    ["environment", "M1", "M1/verify", "verifying"],
    ["effect", "M1", "M1/integrate", "integrating"],
    ["effect", "M1", "M1/land", "landing"],
    ["budget", "M1", "M1/route", "waiting"],
    ["approval", "run", "architect", null],
    ["budget", "run", "start", null],
  ];
  it.each(rows)("a %s question on %s parks %s", (reason, unit, nodeId, from) => {
    const log = runningLog();
    if (from === "integrating") log.add("base.behind", { milestone: "M1" });
    log.add("question.parked", { unit, question: "What now?\nSecond line", reason });
    const state = log.state();
    const ms = state.milestones[0];
    if (from && ms) ms.parkedFrom = from;
    expect(nodeForUnit(state, unit, reason)).toBe(nodeId);
    const m = deriveRunModel({ run: "r1", state, events: log.events, records: [] });
    const n = node(m, nodeId);
    expect(n.status).toBe("parked");
    expect(n.question).toEqual({ unit, reason, question: "What now?\nSecond line" });
    expect(n.now).toBe(
      reason === "approval" ? "Waiting for you to approve the plan" : "Waiting for your answer: What now?",
    );
    expect(m.nodes.filter((x) => x.status === "parked").length).toBe(1);
  });

  it("a run question while the plan is being made parks the plan", () => {
    const log = makeLog();
    log.add("run.started", startedFields);
    log.add("question.parked", { unit: "run", question: "Which repo?", reason: "needs_user" });
    expect(node(model(log), "architect").status).toBe("parked");
  });
});

describe("statuses", () => {
  it("cancelled: running nodes cancelled, pending skipped", () => {
    const log = runningLog();
    startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    log.add("cancel.requested", { by: "owner" });
    log.add("run.ended", { outcome: "cancelled", reportPath: null });
    const m = model(log);
    expect(node(m, "M1/lane/M1.L1").status).toBe("cancelled");
    expect(node(m, "M1/lane/M1.L1").now).toBe("Cancelled");
    expect(node(m, "M1/commit").status).toBe("skipped");
    expect(node(m, "report").status).toBe("skipped");
    expect(node(m, "end").status).toBe("cancelled");
    expect(node(m, "M1/route").status).toBe("done");
    expect(m.phase).toBe("ended");
    expect(m.outcome).toBe("cancelled");
  });

  it("a failed run fails its running nodes", () => {
    const log = runningLog();
    startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    log.add("run.ended", { outcome: "failed", reportPath: null });
    const m = model(log);
    expect(node(m, "M1/lane/M1.L1").status).toBe("failed");
    expect(node(m, "end").status).toBe("failed");
  });

  it("a role turned off is skipped", () => {
    const log = runningLog(PLAN, { ...startedFields, rolesOff: ["reviewer", "verifier", "judge"] });
    const m = model(log);
    expect(node(m, "M1/review").status).toBe("skipped");
    expect(node(m, "M1/verify").status).toBe("skipped");
    expect(node(m, "judge").status).toBe("skipped");
    expect(node(m, "M1/commit").status).toBe("pending");
    expect(node(m, "M1/review").now).toBe("Skipped");
  });

  it("a failed attempt with nothing running leaves the node failed", () => {
    const log = runningLog();
    const id = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    endDispatch(log, id, { name: "worker-M1.L1", unit: "M1.L1", status: "failed", replyStatus: null });
    const lane = node(model(log), "M1/lane/M1.L1");
    expect(lane.status).toBe("failed");
    expect(lane.now.startsWith("Failed: ")).toBe(true);
  });

  it("a milestone's steps follow its status", () => {
    const log = runningLog();
    finishLane(log, "M1.L1");
    finishLane(log, "M1.L2");
    let m = model(log);
    expect(node(m, "M1/lane/M1.L2").status).toBe("done");
    expect(node(m, "M1/commit").status).toBe("running");
    expect(node(m, "M1/commit").now).toBe("Committing M1");
    expect(node(m, "M1/review").status).toBe("pending");
    log.add("commit.made", { milestone: "M1", round: 0, commit: "c0".repeat(20) });
    m = model(log);
    expect(node(m, "M1/commit").status).toBe("done");
    expect(node(m, "M1/review").status).toBe("running");
  });

  it("a lane being checked is done and its check runs", () => {
    const log = runningLog();
    const id = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    endDispatch(log, id, { name: "worker-M1.L1", unit: "M1.L1" });
    const m = model(log);
    expect(node(m, "M1/lane/M1.L1").status).toBe("done");
    expect(node(m, "M1/check/M1.L1").status).toBe("running");
    expect(node(m, "M1/check/M1.L1").now).toBe("Running the fast check for M1.L1");
  });

  it("the now line names the backend, the role and the unit", () => {
    const log = runningLog();
    startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    const n = node(model(log), "M1/lane/M1.L1");
    expect(n.status).toBe("running");
    expect(n.now).toBe("Codex is writing the code for M1.L1");
    expect(n.rung).toBe("codex:gpt-6-sol#medium");
    const planning = makeLog();
    planning.add("run.started", startedFields);
    startDispatch(planning, {
      name: "architect",
      role: "architect",
      unit: "run",
      lane: null,
      rung: "claude-code:claude-opus-5-5#high",
    });
    expect(node(model(planning), "architect").now).toBe("Claude Code is writing the plan for the run");
  });

  it("a lane that is not dispatched yet carries its routed rung", () => {
    expect(node(model(runningLog()), "M1/lane/M1.L1").rung).toBe("codex:gpt-6-sol#medium");
  });
});

describe("diffRunModel", () => {
  it("returns only what changed", () => {
    const log = runningLog();
    const id = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    endDispatch(log, id, { name: "worker-M1.L1", unit: "M1.L1" });
    const a = model(log);
    log.add("check.ran", { lane: "M1.L1", exit: 0, tail: "", foreign: [] });
    const b = model(log);
    const patch = diffRunModel(a, b);
    expect(patch.nodes.map((n) => n.id)).toEqual(["M1/check/M1.L1"]);
    expect(patch.edges).toBeNull();
    expect(patch.removed).toEqual([]);
    expect(patch.seq).toBe(b.seq);
  });

  it("sends the edges and the removed nodes when they change", () => {
    const log = makeLog();
    log.add("run.started", startedFields);
    const a = model(log);
    log.add("plan.ready", { milestones: PLAN });
    routeMilestone(log, PLAN[0] as never);
    const b = model(log);
    const patch = diffRunModel(a, b);
    expect(patch.removed).toEqual(["later"]);
    expect(patch.edges).toEqual(b.edges);
    expect(patch.nodes.length).toBe(b.nodes.length - 1);
  });
});
