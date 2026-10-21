import { describe, expect, it } from "bun:test";
import {
  activeMilestones,
  findingKey,
  HOLD_MS,
  liveDispatches,
  ownerOfFile,
  reduce,
  replay,
  softCap,
} from "../../src/domain/run-state.ts";
import {
  PLAN,
  endDispatch,
  finishLane,
  makeLog,
  runningLog,
  startDispatch,
  startedFields,
} from "./run-fixtures.ts";

const bug = (text: string, file: string | null, label: "BUG" | "BLOCKER" = "BUG") => ({ label, text, file });

/** M1's lanes done and committed: its review starts */
function reviewing() {
  const log = runningLog();
  finishLane(log, "M1.L1");
  finishLane(log, "M1.L2");
  log.add("commit.made", { milestone: "M1", round: 0, commit: "c0" });
  return log;
}

function review(log: ReturnType<typeof makeLog>, findings: ReturnType<typeof bug>[]) {
  const id = startDispatch(log, { name: "reviewer-M1", role: "reviewer", unit: "M1", lane: null });
  endDispatch(log, id, { name: "reviewer-M1", unit: "M1", findings });
}

describe("run state", () => {
  it("replays the plan into milestones and lanes in plan order", () => {
    const log = makeLog();
    log.add("run.started", startedFields);
    log.add("plan.ready", { milestones: PLAN });
    log.add("plan.approved", { by: "owner" });
    const s = log.state();
    expect(s.phase).toBe("running");
    expect(s.milestones.map((m) => [m.id, m.status])).toEqual([
      ["M1", "waiting"],
      ["M2", "waiting"],
    ]);
    expect(s.lanes["M1.L2"]).toMatchObject({
      status: "pending",
      attempts: 0,
      after: ["M1.L1"],
      milestone: "M1",
    });
    expect(Object.keys(s.lanes)).toEqual(["M1.L1", "M1.L2", "M2.L1"]);
  });

  it("holds a plan the owner did not give in approval until it is approved", () => {
    const log = makeLog();
    log.add("run.started", startedFields);
    log.add("plan.ready", { milestones: PLAN });
    expect(log.state().phase).toBe("approval");
    log.add("question.parked", { unit: "run", question: "approve?", reason: "approval" });
    expect(log.state().questions.run).toMatchObject({ reason: "approval" });
    log.add("plan.approved", { by: "owner" });
    expect(log.state()).toMatchObject({ phase: "running", questions: {} });
  });

  it("runs a plan the owner gave, or named in a plan: A-line, without the stop", () => {
    for (const started of [
      { ...startedFields, plan: ["/p.md"] },
      { ...startedFields, aLines: ["plan: p.md"] },
    ]) {
      const log = makeLog();
      log.add("run.started", started);
      log.add("plan.ready", { milestones: PLAN });
      expect(log.state().phase).toBe("running");
    }
  });

  it("asks again when an approval is parked mid-run, and keeps what the owner asked for as the architect's notes", () => {
    const log = runningLog();
    log.add("question.parked", { unit: "run", question: "again?", reason: "approval" });
    expect(log.state().phase).toBe("approval");
    log.add("question.answered", { unit: "run", answer: "keep D2", by: "owner" });
    expect(log.state().revise).toEqual(["The owner asked for these changes to plan.md: keep D2"]);
    expect(log.state().notes).toEqual([]);
    log.add("plan.ready", { milestones: PLAN });
    expect(log.state().revise).toEqual([]);
  });

  it("keeps a landed lane and adds a new lane as pending when the plan is read again", () => {
    const log = runningLog();
    finishLane(log, "M1.L1");
    const again = structuredClone(PLAN);
    again[0]?.lanes.push({ id: "M1.L3", role: "worker", kind: "repo_code", after: [], owns: ["src/c/"] });
    log.add("plan.ready", { milestones: again });
    log.add("plan.approved", { by: "owner" });
    const s = log.state();
    expect(s.lanes["M1.L1"]?.status).toBe("done");
    expect(s.lanes["M1.L3"]?.status).toBe("pending");
    expect(s.milestones[0]?.status).toBe("lanes");
  });

  it("holds a quota for 30 minutes after a limit, and clears it on a clean finish on that quota", () => {
    const log = runningLog();
    const w1 = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1", rung: "codex:gpt-6-sol#medium" });
    endDispatch(log, w1, {
      name: "worker-M1.L1",
      unit: "M1.L1",
      status: "limit",
      replyStatus: null,
      at: "2026-10-21T10:00:00.000Z",
    });
    let s = log.state();
    expect(s.holds.codex).toBe("2026-10-21T10:30:00.000Z");
    expect(HOLD_MS).toBe(30 * 60_000);
    expect(s.wakeAt).toBe("2026-10-21T10:30:00.000Z");
    expect(s.lanes["M1.L1"]).toMatchObject({ status: "pending", failoverFrom: "codex:gpt-6-sol#medium" });
    const w2 = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1", rung: "codex:gpt-6-luna#high" });
    endDispatch(log, w2, { name: "worker-M1.L1", unit: "M1.L1" });
    s = log.state();
    expect(s.holds.codex).toBeUndefined();
    expect(s.wakeAt).toBeNull();
  });

  it("drops an expired hold on a tick", () => {
    const log = runningLog();
    const w = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    endDispatch(log, w, {
      name: "worker-M1.L1",
      unit: "M1.L1",
      status: "limit",
      replyStatus: null,
      at: "2026-10-21T10:00:00.000Z",
    });
    log.add("tick", {}, "2026-10-21T10:31:00.000Z");
    expect(log.state().holds).toEqual({});
  });

  it("keeps a parked unit's question until it is answered, and where the milestone stood", () => {
    const log = runningLog();
    log.add("question.parked", { unit: "M1", question: "which db?", reason: "needs_user" });
    let s = log.state();
    expect(s.milestones[0]).toMatchObject({ status: "parked", parkedFrom: "lanes" });
    expect(s.questions.M1).toMatchObject({ question: "which db?", reason: "needs_user" });
    expect(activeMilestones(s)).toEqual([]);
    log.add("question.answered", { unit: "M1", answer: "postgres", by: "owner" });
    s = log.state();
    expect(s.milestones[0]).toMatchObject({ status: "lanes", parkedFrom: null });
    expect(s.questions).toEqual({});
    expect(activeMilestones(s).map((m) => m.id)).toEqual(["M1"]);
  });

  it("parks a lane, and runs it again with the owner's answer on its notes", () => {
    const log = runningLog();
    const w = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    endDispatch(log, w, {
      name: "worker-M1.L1",
      unit: "M1.L1",
      replyStatus: "blocked",
      reason: "needs_user",
    });
    expect(log.state().lanes["M1.L1"]?.status).toBe("parked");
    log.add("question.parked", { unit: "M1.L1", question: "q", reason: "needs_user" });
    log.add("question.answered", { unit: "M1.L1", answer: "use v2", by: "owner" });
    expect(log.state().lanes["M1.L1"]).toMatchObject({
      status: "pending",
      notes: ["The owner answered: use v2"],
    });
  });

  it("counts a lane's attempts since its latest climb", () => {
    const log = runningLog();
    for (let i = 0; i < 2; i++) {
      const w = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
      endDispatch(log, w, { name: "worker-M1.L1", unit: "M1.L1", status: "failed", replyStatus: null });
      // the stop names no reason: the lane waits for its classification, which says none
      expect(log.state().lanes["M1.L1"]?.classify).toMatchObject({ dispatchId: w });
      log.add("stop.classified", { dispatchId: w, reason: null });
    }
    expect(log.state().lanes["M1.L1"]).toMatchObject({
      attempts: 2,
      climbReason: "unchanged",
      status: "pending",
    });
    log.add("lane.climbed", { lane: "M1.L1", rung: "codex:gpt-6-sol#high", top: false });
    expect(log.state().lanes["M1.L1"]).toMatchObject({
      attempts: 0,
      rung: "codex:gpt-6-sol#high",
      climbReason: null,
      thread: null,
    });
  });

  it("checks a lane after an ok end, and counts a failed check on the lane", () => {
    const log = runningLog();
    const w = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    endDispatch(log, w, { name: "worker-M1.L1", unit: "M1.L1", thread: "t-9" });
    expect(log.state().lanes["M1.L1"]).toMatchObject({ status: "checking", thread: "t-9" });
    log.add("check.ran", { lane: "M1.L1", exit: 1, tail: "1 failed", foreign: [] });
    expect(log.state().lanes["M1.L1"]).toMatchObject({ status: "pending", checkFails: 1, thread: "t-9" });
    expect(log.state().lanes["M1.L1"]?.notes[0]).toContain("1 failed");
    log.add("check.ran", { lane: "M1.L1", exit: 1, tail: "1 failed", foreign: [] });
    expect(log.state().lanes["M1.L1"]).toMatchObject({ checkFails: 2, climbReason: "check-failed-twice" });
    expect(log.state().lanes["M1.L1"]?.notes).toHaveLength(1);
  });

  it("records a review round's counts, open findings and keys", () => {
    const log = reviewing();
    expect(log.state().milestones[0]).toMatchObject({
      status: "review",
      awaiting: ["reviewer-M1"],
      commit: "c0",
    });
    review(log, [
      bug("BUG src/a/x.ts:3 — null deref", "src/a/x.ts"),
      bug("BUG docs/z.md — typo", "docs/z.md"),
    ]);
    const s = log.state();
    const m = s.milestones[0]!;
    expect(m).toMatchObject({ status: "fixing", counts: [2] });
    expect(m.keys).toEqual([["src/a/x.ts null deref", "docs/z.md typo"]]);
    // the owned finding went to its lane; the unowned one waits for the judge
    expect(s.lanes["M1.L1"]).toMatchObject({ status: "pending", fixedRound: 1 });
    expect(s.lanes["M1.L1"]?.notes).toEqual(["BUG src/a/x.ts:3 — null deref"]);
    expect(m.open.map((f) => f.file)).toEqual(["docs/z.md"]);
  });

  it("goes to the verifier when the review is clean, and waits for a second pass on a partial one", () => {
    const log = reviewing();
    const id = startDispatch(log, { name: "reviewer-M1", role: "reviewer", unit: "M1", lane: null });
    endDispatch(log, id, { name: "reviewer-M1", unit: "M1", replyStatus: "partial" });
    expect(log.state().milestones[0]).toMatchObject({ status: "review", awaiting: ["reviewer-M1-2"] });
    const id2 = startDispatch(log, { name: "reviewer-M1-2", role: "reviewer", unit: "M1", lane: null });
    endDispatch(log, id2, { name: "reviewer-M1-2", unit: "M1" });
    expect(log.state().milestones[0]).toMatchObject({ status: "verifying", counts: [0] });
  });

  it("stops converging and keeps the open lines as known issues, or parks on a BLOCKER", () => {
    const log = reviewing();
    const same = [bug("BUG src/a/x.ts:3 — null deref", "src/a/x.ts")];
    review(log, same);
    finishLane(log, "M1.L1");
    log.add("commit.made", { milestone: "M1", round: 1, commit: "c1" });
    review(log, same);
    // r = 2 and not fewer than before: stop, the lines are known issues
    expect(log.state().milestones[0]).toMatchObject({ status: "verifying", knownIssues: [same[0]?.text] });

    const b = reviewing();
    const blocker = bug("BLOCKER src/a/x.ts:1 — lost data", "src/a/x.ts", "BLOCKER");
    review(b, [blocker]);
    finishLane(b, "M1.L1");
    b.add("commit.made", { milestone: "M1", round: 1, commit: "c1" });
    review(b, [blocker]);
    const s = b.state();
    expect(s.milestones[0]?.status).toBe("review");
    expect(s.stuck.M1).toMatchObject({ reason: "blocker" });
  });

  it("takes a verifier's FAIL lines in as BLOCKERs", () => {
    const log = reviewing();
    review(log, []);
    const v = startDispatch(log, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
    endDispatch(log, v, {
      name: "verifier-M1",
      unit: "M1",
      verdict: "fail",
      findings: [{ label: "BLOCKER", text: "FAIL: bun test", file: null }],
    });
    const m = log.state().milestones[0]!;
    expect(m.counts).toEqual([0, 1]);
    expect(m.status).toBe("fixing");
    expect(m.open.map((f) => f.label)).toEqual(["BLOCKER"]);
  });

  it("lands on a verifier PASS and records the landing", () => {
    const log = reviewing();
    review(log, []);
    const v = startDispatch(log, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
    endDispatch(log, v, { name: "verifier-M1", unit: "M1", verdict: "pass", head: "c0" });
    expect(log.state().milestones[0]?.status).toBe("landing");
    log.add("milestone.landed", {
      milestone: "M1",
      commit: "c0",
      knownIssues: ["k"],
      digestPath: "digests/M1.md",
    });
    expect(log.state().milestones[0]).toMatchObject({ status: "landed", knownIssues: ["k"] });
    expect(activeMilestones(log.state()).map((m) => m.id)).toEqual(["M2"]);
  });

  it("lists live dispatches, and a refusal waits", () => {
    const log = runningLog();
    startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    expect(liveDispatches(log.state()).map((d) => d.name)).toEqual(["worker-M1.L1"]);
    log.add(
      "dispatch.refused",
      { name: "worker-M1.L2", unit: "M1.L2", code: "E_ADMIT_PAUSED", message: "paused" },
      "2026-10-21T10:00:00.000Z",
    );
    expect(log.state().waiting["worker-M1.L2"]).toBe("2026-10-21T10:05:00.000Z");
    expect(log.state().wakeAt).toBe("2026-10-21T10:05:00.000Z");
  });

  it("parks a unit whose name is refused as a duplicate again and again", () => {
    const log = runningLog();
    const refuse = () =>
      log.add("dispatch.refused", {
        name: "worker-M1.L1",
        unit: "M1.L1",
        code: "E_ADMIT_DUPLICATE",
        message: "already running",
      });
    refuse();
    refuse();
    expect(log.state().stuck["M1.L1"]).toBeUndefined();
    refuse();
    expect(log.state().stuck["M1.L1"]).toMatchObject({ reason: "effect" });
  });

  it("reduce is pure: the state it was given is untouched", () => {
    const log = runningLog();
    const before = log.state();
    const copy = structuredClone(before);
    const e = { v: 1, seq: 99, at: START_AT, type: "cancel.requested", by: "owner" } as const;
    const after = reduce(before, e);
    expect(before).toEqual(copy);
    expect(after.cancelling).toBe(true);
    expect(replay(log.events, "r1").milestones.map((m) => m.id)).toEqual(["M1", "M2"]);
  });

  it("softCap is max(3, 2 + ceil(lanes / 3))", () =>
    expect([1, 3, 4, 6, 7, 9, 10].map(softCap)).toEqual([3, 3, 4, 4, 5, 5, 6]));

  it("findingKey drops the label, line numbers and case", () =>
    expect(findingKey("BUG src/a.ts:12-14 — Null deref in handler")).toBe(
      findingKey("- **BUG** src/a.ts:40 null deref in handler"),
    ));

  it("names a file's owning lane by its longest Owns: entry", () => {
    const lanes = [
      { id: "L1", owns: ["src/"] },
      { id: "L2", owns: ["src/b/", "x.ts"] },
    ];
    expect([
      ownerOfFile("src/b/c.ts", lanes),
      ownerOfFile("src/a.ts", lanes),
      ownerOfFile("x.ts", lanes),
      ownerOfFile("y.ts", lanes),
      ownerOfFile(null, lanes),
    ]).toEqual(["L2", "L1", "L2", null, null]);
  });
});

const START_AT = "2026-10-21T11:00:00.000Z";
