import { describe, expect, it } from "bun:test";
import {
  type Action,
  actionKey,
  confirms,
  type DecideAction,
  decidedName,
  next,
} from "../../src/domain/run-machine.ts";
import { HARNESS_NOTE } from "../../src/domain/harness.ts";
import { type Finding, issueLine, type MilestonePlan, type RunEvent } from "../../src/domain/run-events.ts";
import {
  activeMilestones,
  ADMIT_WAITS,
  findingKey,
  floorOf,
  HOLD_MS,
  liveDispatches,
  ownerOfFile,
  REDECIDE_LIMIT,
  reduce,
  replay,
  softCap,
  SOURCE_PLAN_NOTE,
  STATUS_ASK,
  VERDICT_ASK,
} from "../../src/domain/run-state.ts";
import {
  PLAN,
  decide,
  endDispatch,
  finishLane,
  makeLog,
  routeMilestone,
  runningLog,
  settled,
  START,
  startDispatch,
  startedFields,
} from "./run-fixtures.ts";

const bug = (text: string, file: string | null, label: "BUG" | "BLOCKER" = "BUG") => ({ label, text, file });

const of = <T extends Action["type"]>(as: Action[], type: T): Extract<Action, { type: T }>[] =>
  as.filter((a): a is Extract<Action, { type: T }> => a.type === type);

const SOL = "codex:gpt-6-sol#medium";
const SOL_HIGH = "codex:gpt-6-sol#high";
const LUNA = "codex:gpt-6-luna#high";

/** M1 routed, and its first lane decided on SOL: its failures have a rung to count against */
function decidedLog() {
  const log = runningLog();
  decide(log, "worker-M1.L1", SOL);
  return log;
}

/** M1's two lanes with no `After:` between them */
const independent: MilestonePlan[] = [
  {
    id: "M1",
    title: "t",
    after: [],
    lanes: [
      { id: "M1.L1", role: "worker", kind: "repo_code", after: [], owns: ["src/a/"] },
      { id: "M1.L2", role: "worker", kind: "repo_code", after: [], owns: ["src/b/"] },
    ],
  },
];

/** M1's lanes done and committed: its review starts */
function reviewing() {
  const log = runningLog();
  finishLane(log, "M1.L1");
  finishLane(log, "M1.L2");
  log.add("commit.made", { milestone: "M1", round: 0, commit: "c0" });
  return log;
}

function review(log: ReturnType<typeof makeLog>, findings: Finding[]) {
  const id = startDispatch(log, { name: "reviewer-M1", role: "reviewer", unit: "M1", lane: null });
  endDispatch(log, id, { name: "reviewer-M1", unit: "M1", findings });
}

/** the daemon's check of `head` ran: green unless `findings` or `missing` say otherwise */
function checked(
  log: ReturnType<typeof makeLog>,
  head: string,
  o: { findings?: Finding[]; missing?: string[]; checkOnly?: boolean; verdictCarried?: boolean } = {},
) {
  return log.add("milestone.checked", {
    milestone: "M1",
    head,
    command: "bun test",
    missing: o.missing ?? [],
    findings: o.findings ?? [],
    uncovered: ["A1 it works"],
    checkOnly: o.checkOnly ?? false,
    verdictCarried: o.verdictCarried ?? false,
    startedAt: "2026-10-21T10:00:00.000Z",
    durationMs: 1000,
    waitedMs: 0,
  });
}

/** a judge call on M1 with `routes`: the dispatch that asks it, then its decision */
function triaged(
  log: ReturnType<typeof makeLog>,
  id: string,
  routes: { finding: number; to: string; why: string }[],
) {
  const j = startDispatch(log, {
    name: `judge-${id}`,
    role: "judge",
    unit: "M1",
    lane: null,
    judgeKind: "triage",
  });
  endDispatch(log, j, { name: `judge-${id}`, unit: "M1" });
  log.add("judge.decided", {
    id,
    unit: "M1",
    kind: "triage",
    decision: { verb: "route", routes },
    dispatchId: j,
  });
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

  it("stops for approval when a plan: A-line names no file", () => {
    const log = makeLog();
    log.add("run.started", { ...startedFields, aLines: ["plan:"] });
    log.add("plan.ready", { milestones: PLAN });
    expect(log.state().phase).toBe("approval");
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

  it("a base run keeps every milestone with a tree active, plus the first without one (plan 35)", () => {
    const independent = PLAN.map((m) => ({ ...m, after: [] }));
    const log = makeLog();
    log.add("run.started", { ...startedFields, base: "main" });
    log.add("plan.ready", { milestones: independent });
    expect(activeMilestones(log.state()).map((m) => m.id)).toEqual(["M1"]);
    log.add("tree.ready", { milestone: "M1", tree: "/t/M1", branch: "w-m1", base: "main", hints: [] });
    const s = log.state();
    expect(s.milestones[0]).toMatchObject({ tree: "/t/M1", branch: "w-m1", claimAfter: null });
    expect(s.milestones[0]?.treeAt).toBe(s.at);
    expect(activeMilestones(s).map((m) => m.id)).toEqual(["M1", "M2"]);
    // a run without base: still one
    const plain = makeLog();
    plain.add("run.started", startedFields);
    plain.add("plan.ready", { milestones: independent });
    expect(activeMilestones(plain.state()).map((m) => m.id)).toEqual(["M1"]);
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
    log.add("stop.classified", { dispatchId: w, reason: "needs_user" });
    expect(log.state().lanes["M1.L1"]?.status).toBe("parked");
    log.add("question.parked", { unit: "M1.L1", question: "q", reason: "needs_user" });
    log.add("question.answered", { unit: "M1.L1", answer: "use v2", by: "owner" });
    expect(log.state().lanes["M1.L1"]).toMatchObject({
      status: "pending",
      notes: ["The owner answered: use v2"],
    });
  });

  it("counts a lane's attempts, and two on one rung make its floor strict", () => {
    const log = runningLog();
    for (let i = 0; i < 2; i++) {
      const w = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
      endDispatch(log, w, { name: "worker-M1.L1", unit: "M1.L1", status: "failed", replyStatus: null });
      // the stop names no reason: the lane waits for its classification, which says none
      expect(log.state().lanes["M1.L1"]?.classify).toMatchObject({ dispatchId: w });
      log.add("stop.classified", { dispatchId: w, reason: null });
    }
    expect(log.state().lanes["M1.L1"]).toMatchObject({ attempts: 2, status: "pending" });
    expect(floorOf(log.state(), "worker-M1.L1")).toEqual({ floor: SOL, strict: true });
    // an old run's climb still moves the lane
    log.add("lane.climbed", { lane: "M1.L1", rung: "codex:gpt-6-sol#high", top: false });
    expect(log.state().lanes["M1.L1"]).toMatchObject({
      attempts: 0,
      rung: "codex:gpt-6-sol#high",
      thread: null,
    });
  });

  it("a transport error holds the lane on its rung with a backoff, never classified or climbed, and parks after the hold window", () => {
    const log = runningLog();
    const name = "worker-M1.L1";
    const why =
      "API Error: Couldn't connect through your proxy (ERR_PROXY_TUNNEL) — the proxy refused the tunnel";
    const rung = SOL;
    const t0 = Date.parse(START) + 3_600_000;
    for (const min of [0, 4, 12, 25]) {
      const at = new Date(t0 + min * 60_000).toISOString();
      const w = startDispatch(log, { name, unit: "M1.L1" });
      endDispatch(log, w, { name, unit: "M1.L1", status: "failed", replyStatus: null, why, at });
      const s = log.state();
      expect(s.lanes["M1.L1"]).toMatchObject({
        status: "pending",
        classify: null,
        attempts: 0,
        rung,
      });
      expect(s.floors[name]).toBeUndefined();
      expect(s.waiting[name]! > at).toBe(true);
      expect(s.stuck["M1.L1"]).toBeUndefined();
    }
    const w = startDispatch(log, { name, unit: "M1.L1" });
    endDispatch(log, w, {
      name,
      unit: "M1.L1",
      status: "failed",
      replyStatus: null,
      why: "connect ECONNRESET 10.0.0.1:443",
      at: new Date(t0 + HOLD_MS).toISOString(),
    });
    expect(log.state().lanes["M1.L1"]?.status).toBe("parked");
    expect(log.state().stuck["M1.L1"]).toMatchObject({ reason: "provider_error" });
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
    expect(log.state().lanes["M1.L1"]).toMatchObject({ checkFails: 2 });
    expect(floorOf(log.state(), "worker-M1.L1")).toEqual({ floor: SOL, strict: true });
    expect(log.state().lanes["M1.L1"]?.notes).toHaveLength(1);
  });

  it("a harness failure gets one repair outside the round count", () => {
    const log = runningLog();
    const w = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    endDispatch(log, w, { name: "worker-M1.L1", unit: "M1.L1", thread: "t-9" });
    const tail = "(fail) db > connects";
    log.add("check.ran", { lane: "M1.L1", exit: 1, tail, foreign: [], failureClass: "harness" });
    const l = log.state().lanes["M1.L1"];
    expect(l).toMatchObject({ status: "pending", attempts: 0, checkFails: 0, thread: "t-9" });
    expect(l?.notes[0]).toBe(HARNESS_NOTE);
    expect(l?.notes[1]).toContain(tail);
    log.add("check.ran", { lane: "M1.L1", exit: 1, tail, foreign: [], failureClass: "harness" });
    expect(log.state().stuck["M1.L1"]?.reason).toBe("environment");
    expect(log.state().stuck["M1.L1"]?.question).toContain(tail);
  });

  it("a product failure after a repair clears the signature", () => {
    const log = runningLog();
    const w = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    endDispatch(log, w, { name: "worker-M1.L1", unit: "M1.L1", thread: "t-9" });
    log.add("check.ran", {
      lane: "M1.L1",
      exit: 1,
      tail: "(fail) db > connects",
      foreign: [],
      failureClass: "harness",
    });
    expect(log.state().lanes["M1.L1"]?.harness).not.toBeNull();
    log.add("check.ran", { lane: "M1.L1", exit: 1, tail: "1 failed", foreign: [], failureClass: "product" });
    expect(log.state().lanes["M1.L1"]).toMatchObject({ harness: null, checkFails: 1 });
  });

  it("a harness stop is repaired once, then parks on the same signature", () => {
    const log = runningLog();
    const name = "worker-M1.L1";
    const why = "docker: Cannot connect to the Docker daemon";
    const w = startDispatch(log, { name, unit: "M1.L1", thread: "t-1" });
    endDispatch(log, w, { name, unit: "M1.L1", replyStatus: "blocked", reason: "check_broken", why });
    log.add("stop.classified", { dispatchId: w, reason: "check_broken", failureClass: "harness" });
    expect(log.state().lanes["M1.L1"]).toMatchObject({ status: "pending", attempts: 0, stopRun: 0 });
    expect(log.state().lanes["M1.L1"]?.notes[0]).toBe(HARNESS_NOTE);
    const w2 = startDispatch(log, { name, unit: "M1.L1", thread: "t-1" });
    endDispatch(log, w2, { name, unit: "M1.L1", replyStatus: "blocked", reason: "check_broken", why });
    log.add("stop.classified", { dispatchId: w2, reason: "check_broken", failureClass: "harness" });
    expect(log.state().stuck["M1.L1"]).toMatchObject({ reason: "environment" });
  });

  it("a lane that edited a foreign test file is sent back", () => {
    const log = runningLog();
    const w = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    endDispatch(log, w, { name: "worker-M1.L1", unit: "M1.L1", testEdits: ["test/b.test.ts"] });
    const l = log.state().lanes["M1.L1"];
    expect(l).toMatchObject({ status: "pending", attempts: 1, thread: null });
    expect(l?.notes.join("\n")).toContain("Restore these test files; you do not own them: test/b.test.ts");
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

  it("lists live dispatches, and a paused refusal holds the run", () => {
    const log = runningLog();
    startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    expect(liveDispatches(log.state()).map((d) => d.name)).toEqual(["worker-M1.L1"]);
    log.add(
      "dispatch.refused",
      { name: "worker-M1.L2", unit: "M1.L2", code: "E_ADMIT_PAUSED", message: "paused" },
      "2026-10-21T10:00:00.000Z",
    );
    // a machine pause holds the run until `pause.lifted`: no timed wait
    expect(log.state().waiting["worker-M1.L2"]).toBeUndefined();
    expect(log.state().held).toBe("2026-10-21T10:00:00.000Z");
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

describe("a milestone's NITs (plan 34)", () => {
  const nit = (text: string) => ({
    label: "NIT" as const,
    text,
    file: text.match(/(src\/\S+?):/)?.[1] ?? null,
  });

  it("keeps only the latest round's NITs, and adds them and the verifier's to the known issues on a PASS", () => {
    const log = reviewing();
    review(log, [nit("NIT src/a.ts:9 — old — z")]);
    log.add("commit.made", { milestone: "M1", round: 1, commit: "c1" });
    review(log, [nit("**NIT** src/b.ts:4 — later — z")]);
    expect(log.state().milestones[0]?.nits).toEqual(["**NIT** src/b.ts:4 — later — z"]);
    const v = startDispatch(log, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
    endDispatch(log, v, {
      name: "verifier-M1",
      unit: "M1",
      verdict: "pass",
      head: "c1",
      findings: [nit("NIT src/v.ts:1 — v — w"), nit("**NIT** src/b.ts:4 — later — z")],
    });
    expect(log.state().milestones[0]?.knownIssues).toEqual([
      "**NIT** src/b.ts:4 — later — z",
      "verifier-M1: NIT src/v.ts:1 — v — w",
    ]);
  });

  it("a finding's issue line is its text, with its label put back when the text lost it", () => {
    expect(issueLine({ label: "NIT", text: "- **NIT** a.ts — x", file: "a.ts" })).toBe("- **NIT** a.ts — x");
    expect(issueLine({ label: "NIT", text: "a.ts — x", file: "a.ts" })).toBe("NIT a.ts — x");
  });
});

describe("the rules review (plan 34)", () => {
  it("keeps what the rules judge proposed, and that it failed after two tries", () => {
    const log = runningLog();
    expect(log.state().rulesReview).toBeNull();
    const changes = [{ op: "add" as const, text: "[worker] x", why: "y" }];
    const j = startDispatch(log, {
      name: "judge-rules",
      role: "judge",
      unit: "run",
      lane: null,
      judgeKind: "rules",
    });
    log.add("judge.decided", {
      id: "rules",
      unit: "run",
      kind: "rules",
      decision: { verb: "rules", changes },
      dispatchId: j,
    });
    expect(log.state().rulesReview).toEqual({ changes, failed: false });

    const failed = runningLog();
    for (let k = 0; k < 2; k++) {
      startDispatch(failed, {
        name: "judge-rules",
        role: "judge",
        unit: "run",
        lane: null,
        judgeKind: "rules",
      });
      failed.add("judge.failed", { id: "rules", unit: "run", why: "unreadable" });
    }
    expect(failed.state().rulesReview).toEqual({ changes: [], failed: true });
    expect(failed.state().stuck.run).toBeUndefined();
  });
});

describe("plan 39 orchestration guards", () => {
  it("a verifier FAIL on a commit is not retried on that commit", () => {
    const log = reviewing();
    review(log, []);
    const v = startDispatch(log, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
    const failed = endDispatch(log, v, { name: "verifier-M1", unit: "M1", verdict: "fail", head: "c0" });
    expect(log.state().milestones[0]).toMatchObject({ verifierFailedOn: "c0" });
    expect(next(log.state(), failed).some((a) => a.type === "dispatch" && a.role === "verifier")).toBe(false);
    const state = log.state();
    state.milestones[0]!.status = "verifying";
    expect(next(state, failed).some((a) => a.type === "dispatch" && a.role === "verifier")).toBe(false);
    log.add("commit.made", { milestone: "M1", round: 1, commit: "c1" });
    review(log, []);
    checked(log, "c1");
    expect(settled(log).some((a) => a.type === "dispatch" && a.role === "verifier")).toBe(true);
  });

  it("check_broken parks at once", () => {
    const log = reviewing();
    review(log, []);
    const v = startDispatch(log, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
    const e = endDispatch(log, v, {
      name: "verifier-M1",
      unit: "M1",
      verdict: "fail",
      reason: "check_broken",
    });
    expect(log.state().milestones[0]).toMatchObject({ verifierFailedOn: "c0" });
    expect(next(log.state(), e)).toContainEqual(
      expect.objectContaining({ type: "park", unit: "M1", reason: "check_broken" }),
    );
    log.add("question.parked", { unit: "M1", reason: "check_broken", question: "repair the check" });
    expect(log.state().questions.M1).toMatchObject({ reason: "check_broken" });
  });

  it("an open question is reminded at 30 min, 2 h, 6 h, 24 h and every 24 h", () => {
    const log = runningLog();
    const parked = log.add("question.parked", { unit: "M1", question: "repair?", reason: "environment" });
    expect(log.state().questions.M1).toMatchObject({ reminded: 0 });
    const origin = Date.parse(parked.at);
    for (const [i, offset] of [
      1_800_000, 7_200_000, 21_600_000, 86_400_000, 172_800_000, 259_200_000,
    ].entries()) {
      const due = new Date(origin + offset).toISOString();
      expect(log.state().wakeAt).toBe(due);
      const before = log.add("tick", {}, new Date(origin + offset - 1).toISOString());
      expect(next(log.state(), before).filter((a) => a.type === "remind")).toEqual([]);
      const tick = log.add("tick", {}, due);
      const action = { type: "remind", unit: "M1", n: i + 1 } as const;
      expect(next(log.state(), tick).filter((a) => a.type === "remind")).toEqual([action]);
      expect(actionKey(action)).toBe(`remind:M1:${i + 1}`);
      const reminded = log.add("question.reminded", { unit: "M1", n: i + 1 }, due);
      expect(confirms(reminded)).toEqual([`remind:M1:${i + 1}`]);
      expect(log.state().questions.M1).toMatchObject({ reminded: i + 1 });
      expect(next(log.state(), reminded).filter((a) => a.type === "remind")).toEqual([]);
      const replayed = log.add("question.reminded", { unit: "M1", n: i + 1 }, due);
      expect(next(log.state(), replayed).filter((a) => a.type === "remind")).toEqual([]);
    }
  });

  it("owes one reminder when the daemon wakes after missed slots", () => {
    const log = runningLog();
    const parked = log.add("question.parked", { unit: "M1", question: "repair?", reason: "environment" });
    const at = new Date(Date.parse(parked.at) + 3 * 86_400_000).toISOString();
    const tick = log.add("tick", {}, at);
    expect(next(log.state(), tick).filter((a) => a.type === "remind")).toEqual([
      { type: "remind", unit: "M1", n: 1 },
    ]);
    const reminded = log.add("question.reminded", { unit: "M1", n: 1 }, at);
    expect(next(log.state(), reminded).filter((a) => a.type === "remind")).toEqual([]);
    expect(log.state().wakeAt).toBe(new Date(Date.parse(parked.at) + 4 * 86_400_000).toISOString());
  });

  it("an answered question owes no reminder", () => {
    const log = runningLog();
    log.add("question.parked", { unit: "M1", question: "repair?", reason: "environment" });
    log.add("question.answered", { unit: "M1", answer: "done", by: "owner" });
    const tick = log.add("tick", {}, "2026-10-23T10:00:00.000Z");
    expect(next(log.state(), tick).filter((a) => a.type === "remind")).toEqual([]);
    expect(log.state().wakeAt).toBeNull();
  });

  it("an ended run owes no reminder", () => {
    const log = runningLog();
    log.add("question.parked", { unit: "M1", question: "repair?", reason: "environment" });
    log.add("run.ended", { outcome: "cancelled", reportPath: null });
    const tick = log.add("tick", {}, "2026-10-23T10:00:00.000Z");
    expect(next(log.state(), tick).filter((a) => a.type === "remind")).toEqual([]);
    expect(log.state().wakeAt).toBeNull();
  });
});

describe("repeated fast check failures", () => {
  const check = { lane: "M1.L1", exit: 1, tail: "error: database unavailable [12ms]", foreign: [] };

  it("a worker's uncommitted change frees a repeated failure", () => {
    const log = decidedLog();
    log.add("check.ran", { ...check, tree: "t1" });
    log.add("check.ran", { ...check, tree: "t2" });
    expect(log.state().stuck[check.lane]).toBeUndefined();
    expect(log.state().lanes[check.lane]).toMatchObject({
      lastFailHead: "t2",
      checkFails: 2,
    });
    expect(floorOf(log.state(), "worker-M1.L1").strict).toBe(true);
  });

  it("the same tree and the same failure parks environment", () => {
    for (const commitBetween of [false, true]) {
      const log = decidedLog();
      log.add("check.ran", { ...check, tree: "t1" });
      expect(log.state().lanes[check.lane]?.lastFailHead).toBe("t1");
      if (commitBetween) log.add("commit.made", { milestone: "M1", round: 0, commit: "c1" });
      log.add("check.ran", { ...check, tree: "t1" });
      expect(log.state().stuck[check.lane]?.reason).toBe("environment");
      expect(floorOf(log.state(), "worker-M1.L1").strict).toBe(false);
    }
  });

  it("an unknown tree never parks", () => {
    const log = decidedLog();
    log.add("check.ran", { ...check, tree: null });
    log.add("check.ran", { ...check, tree: null });
    expect(log.state().stuck[check.lane]).toBeUndefined();
    expect(log.state().lanes[check.lane]).toMatchObject({
      lastFailHead: null,
      checkFails: 2,
    });
    expect(floorOf(log.state(), "worker-M1.L1").strict).toBe(true);
  });

  it("an identical check failure on an unchanged head parks without a climb", () => {
    for (const head of [null, "c0"]) {
      const log = decidedLog();
      if (head) log.add("commit.made", { milestone: "M1", round: 0, commit: head });
      log.add("check.ran", check);
      expect(log.state().lanes[check.lane]).toMatchObject({
        lastFails: ["error: database unavailable"],
        lastFailHead: head,
      });
      log.add("check.ran", { ...check, tail: "error: database unavailable [99ms]" });
      const s = log.state();
      expect(s.stuck[check.lane]).toEqual({
        reason: "environment",
        question: expect.stringContaining("error: database unavailable"),
      });
      expect(s.stuck[check.lane]?.question).toContain(check.lane);
      expect(floorOf(s, "worker-M1.L1").strict).toBe(false);
      expect(next(s, log.events.at(-1)!)).toContainEqual(
        expect.objectContaining({ type: "park", unit: check.lane, reason: "environment" }),
      );
    }
  });

  it("a new milestone commit or different failures keep the normal floor", () => {
    for (const change of ["head", "fails"]) {
      const log = decidedLog();
      log.add("check.ran", check);
      if (change === "head") log.add("commit.made", { milestone: "M1", round: 0, commit: "c1" });
      log.add("check.ran", { ...check, tail: change === "fails" ? "error: missing module" : check.tail });
      expect(log.state().stuck[check.lane]).toBeUndefined();
      expect(log.state().lanes[check.lane]).toMatchObject({ checkFails: 2 });
      expect(floorOf(log.state(), "worker-M1.L1").strict).toBe(true);
    }
  });

  it("a sibling milestone commit does not free an unchanged lane head", () => {
    const log = decidedLog();
    log.add("check.ran", check);
    log.add("commit.made", { milestone: "M2", round: 0, commit: "sibling" });
    log.add("check.ran", check);
    expect(log.state().stuck[check.lane]?.reason).toBe("environment");
    expect(floorOf(log.state(), "worker-M1.L1").strict).toBe(false);
  });

  it("a passing check clears the last failure", () => {
    const log = decidedLog();
    log.add("check.ran", check);
    log.add("check.ran", { ...check, exit: 0, tail: "passed" });
    expect(log.state().lanes[check.lane]).toMatchObject({ lastFails: null, lastFailHead: null });
    log.add("check.ran", check);
    expect(log.state().stuck[check.lane]).toBeUndefined();
  });

  it("empty failing lines never count as a repeated environment failure", () => {
    const log = decidedLog();
    log.add("check.ran", { ...check, tail: "no diagnostic" });
    log.add("check.ran", { ...check, tail: "no diagnostic" });
    expect(log.state().stuck[check.lane]).toBeUndefined();
    expect(floorOf(log.state(), "worker-M1.L1").strict).toBe(true);
  });
});

describe("plan 40: the verifying flow", () => {
  it("a green check lands a check-only milestone, and no verifier is owed", () => {
    const log = reviewing();
    review(log, []);
    expect(settled(log)).toContainEqual({
      type: "machineCheck",
      milestone: "M1",
      commit: "c0",
    });
    checked(log, "c0", { checkOnly: true });
    expect(log.state().milestones[0]).toMatchObject({ status: "landing", checkOnly: true, checkedOn: "c0" });
    const out = settled(log);
    expect(out.some((a) => a.type === "dispatch" && a.role === "verifier")).toBe(false);
    expect(out).toContainEqual({ type: "land", milestone: "M1", knownIssues: [] });
  });

  it("a red check is a fix round for its lanes, with no verifier", () => {
    const log = reviewing();
    review(log, []);
    checked(log, "c0", { findings: [bug("BLOCKER src/a/x.ts:3 — the test fails", "src/a/x.ts", "BLOCKER")] });
    expect(log.state().milestones[0]).toMatchObject({ status: "fixing", checkedOn: null });
    expect(log.state().lanes["M1.L1"]).toMatchObject({
      status: "pending",
      notes: ["BLOCKER src/a/x.ts:3 — the test fails"],
    });
    const out = settled(log);
    expect(out.some((a) => a.type === "dispatch" && a.role === "verifier")).toBe(false);
    expect(out).toContainEqual(expect.objectContaining({ type: "dispatch", name: "worker-M1.L1" }));
  });

  it("a check of another commit changes nothing, and the next tick owes a check of the milestone's own", () => {
    const log = reviewing();
    review(log, []);
    const before = log.state().milestones[0];
    checked(log, "c9");
    expect(log.state().milestones[0]).toEqual(before);
    expect(settled(log)).toContainEqual({
      type: "machineCheck",
      milestone: "M1",
      commit: "c0",
    });
  });

  it("accept after a verifier FAIL lands without a new verifier", () => {
    const log = reviewing();
    const owned = (text: string) => bug(`BLOCKER src/a/x.ts:1 — ${text}`, "src/a/x.ts", "BLOCKER");
    review(log, [owned("first"), owned("second")]);
    finishLane(log, "M1.L1");
    log.add("commit.made", { milestone: "M1", round: 1, commit: "c1" });
    review(log, [owned("third")]);
    finishLane(log, "M1.L1");
    log.add("commit.made", { milestone: "M1", round: 2, commit: "c2" });
    review(log, []);
    checked(log, "c2");
    const v = startDispatch(log, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
    endDispatch(log, v, {
      name: "verifier-M1",
      unit: "M1",
      verdict: "fail",
      findings: [owned("A8 is not met")],
    });
    // the fourth round reaches the cap with a BLOCKER a lane owns: the owner decides
    log.add("question.parked", { unit: "M1", question: "A8 is not met", reason: "blocker" });
    log.add("question.answered", { unit: "M1", answer: "accept: A8 is judged from the tree", by: "owner" });
    expect(log.state().milestones[0]).toMatchObject({ status: "landing", verifierPassedOn: "c2" });
    const out = settled(log);
    expect(out.some((a) => a.type === "dispatch" && a.role === "verifier")).toBe(false);
    expect(out).toContainEqual(expect.objectContaining({ type: "land", milestone: "M1" }));
  });

  it("accept after a review-cap blocker still verifies", () => {
    const log = reviewing();
    const blocker = bug("BLOCKER src/a/x.ts:1 — lost data", "src/a/x.ts", "BLOCKER");
    review(log, [blocker]);
    finishLane(log, "M1.L1");
    log.add("commit.made", { milestone: "M1", round: 1, commit: "c1" });
    review(log, [blocker]);
    expect(log.state().milestones[0]).toMatchObject({ status: "review" });
    log.add("question.parked", { unit: "M1", question: "lost data", reason: "blocker" });
    log.add("question.answered", { unit: "M1", answer: "accept", by: "owner" });
    expect(log.state().milestones[0]).toMatchObject({ status: "verifying", verifierPassedOn: null });
    const owed = settled(log);
    expect(owed).toContainEqual({ type: "machineCheck", milestone: "M1", commit: "c1" });
    expect(owed.some((a) => a.type === "dispatch" && a.role === "verifier")).toBe(false);
    checked(log, "c1");
    expect(settled(log)).toContainEqual(expect.objectContaining({ type: "dispatch", role: "verifier" }));
  });

  it("a first land refusal reruns the check, not the verifier", () => {
    const log = reviewing();
    review(log, []);
    checked(log, "c0");
    const v = startDispatch(log, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
    endDispatch(log, v, { name: "verifier-M1", unit: "M1", verdict: "pass", head: "c0" });
    expect(log.state().milestones[0]).toMatchObject({ status: "landing", verifierPassedOn: "c0" });
    log.add("land.refused", {
      milestone: "M1",
      code: "E_LAND_GATE",
      message: "no record",
      fix: "run gate_run",
    });
    expect(log.state().milestones[0]).toMatchObject({
      status: "verifying",
      checkedOn: null,
      verifierPassedOn: "c0",
    });
    const out = settled(log);
    expect(out).toContainEqual({ type: "machineCheck", milestone: "M1", commit: "c0" });
    expect(out.some((a) => a.type === "dispatch")).toBe(false);
    checked(log, "c0");
    expect(log.state().milestones[0]).toMatchObject({ status: "landing" });
  });

  it("a verifier reply with no VERDICT line is asked for one on its thread once, and a second is a FAIL", () => {
    const log = reviewing();
    review(log, []);
    checked(log, "c0");
    const noVerdict = (thread: string) => {
      const v = startDispatch(log, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
      endDispatch(log, v, {
        name: "verifier-M1",
        unit: "M1",
        verdict: "fail",
        findings: [bug("no VERDICT line: Now I run the gate.", null, "BLOCKER")],
        noVerdict: true,
        thread,
      });
    };
    noVerdict("tv-1");
    expect(log.state().milestones[0]).toMatchObject({ status: "verifying", verifierFailedOn: null });
    expect(settled(log)).toContainEqual(
      expect.objectContaining({ type: "dispatch", role: "verifier", thread: "tv-1", notes: [VERDICT_ASK] }),
    );
    noVerdict("tv-1");
    expect(log.state().milestones[0]).toMatchObject({ status: "fixing", verifierFailedOn: "c0" });
  });

  it("a triage judge that dismisses every finding of a verifier FAIL passes that commit", () => {
    const log = reviewing();
    review(log, []);
    checked(log, "c0");
    const v = startDispatch(log, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
    endDispatch(log, v, {
      name: "verifier-M1",
      unit: "M1",
      verdict: "fail",
      findings: [bug("BLOCKER A8 is not met", null, "BLOCKER")],
    });
    expect(log.state().milestones[0]).toMatchObject({
      status: "fixing",
      disputing: false,
      verifierFailedOn: "c0",
    });
    triaged(log, "7", []);
    expect(log.state().milestones[0]).toMatchObject({ status: "landing", verifierPassedOn: "c0" });
    expect(log.state().milestones[0]?.knownIssues).toEqual(["dismissed by the judge: BLOCKER A8 is not met"]);
  });

  it("a second land refusal parks a question that says retry lands again", () => {
    const log = reviewing();
    review(log, []);
    checked(log, "c0");
    const v = startDispatch(log, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
    endDispatch(log, v, { name: "verifier-M1", unit: "M1", verdict: "pass", head: "c0" });
    const refuse = () =>
      log.add("land.refused", { milestone: "M1", code: "E_LAND_DISK", message: "disk full", fix: "free it" });
    refuse();
    checked(log, "c0");
    refuse();
    const q = log.state().stuck.M1;
    expect(q).toMatchObject({ reason: "land" });
    expect(q?.question).toContain("retry to land again, or name the fix");
    log.add("question.parked", { unit: "M1", question: q?.question ?? "", reason: "land" });
    log.add("question.answered", { unit: "M1", answer: "retry", by: "owner" });
    expect(log.state().milestones[0]?.status).toBe("landing");
  });

  it("a carried verdict lands the merge commit", () => {
    const log = runningLog(PLAN, "main");
    finishLane(log, "M1.L1");
    finishLane(log, "M1.L2");
    log.add("commit.made", { milestone: "M1", round: 0, commit: "c0" });
    review(log, []);
    checked(log, "c0");
    const v = startDispatch(log, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
    endDispatch(log, v, { name: "verifier-M1", unit: "M1", verdict: "pass", head: "c0" });
    log.add("base.behind", { milestone: "M1" });
    log.add("integrate.done", { milestone: "M1", commit: "c2" });
    expect(log.state().milestones[0]).toMatchObject({
      status: "verifying",
      commit: "c2",
      verifierPassedOn: "c0",
    });
    checked(log, "c2", { verdictCarried: true });
    expect(log.state().milestones[0]).toMatchObject({
      status: "landing",
      checkedOn: "c2",
      verifierPassedOn: "c0",
    });
  });

  it("a land park the owner accepts waives its missing lines, and the verifier still gates the commit", () => {
    const log = reviewing();
    review(log, []);
    const missing = "M1 check: pre-existing failure in test/old.test.ts:4";
    checked(log, "c0", { missing: [missing] });
    expect(log.state().milestones[0]).toMatchObject({ status: "verifying", checkedOn: null });
    expect(log.state().stuck.M1).toMatchObject({ reason: "land" });
    log.add("question.parked", { unit: "M1", question: "pre-existing", reason: "land" });
    log.add("question.answered", { unit: "M1", answer: "accept", by: "owner" });
    expect(log.state().milestones[0]).toMatchObject({
      status: "verifying",
      checkedOn: "c0",
      knownIssues: [missing],
    });
    expect(settled(log)).toContainEqual(expect.objectContaining({ type: "dispatch", role: "verifier" }));
  });

  it("unowned BLOCKERs at the cap go to the triage judge once, and the second stop parks", () => {
    const log = reviewing();
    review(log, [bug("BLOCKER src/a/x.ts:1 — owned", "src/a/x.ts", "BLOCKER")]);
    finishLane(log, "M1.L1");
    log.add("commit.made", { milestone: "M1", round: 1, commit: "c1" });
    const unowned = [
      bug("BLOCKER A8 is not met", null, "BLOCKER"),
      bug("BLOCKER A9 is untestable", null, "BLOCKER"),
    ];
    review(log, unowned);
    // no lane owns them and the cap is reached: the triage judge reads them, the owner is not asked yet
    expect(log.state().milestones[0]).toMatchObject({ status: "fixing", disputes: 1, disputing: true });
    expect(log.state().stuck).toEqual({});
    expect(settled(log)).toContainEqual(
      expect.objectContaining({
        type: "judge",
        input: expect.objectContaining({ kind: "triage", unit: "M1" }),
      }),
    );
    triaged(log, "7", []);
    // all dismissed: the milestone goes on, with both as known issues
    expect(log.state().milestones[0]).toMatchObject({ status: "verifying", disputing: false, disputes: 1 });
    expect(log.state().milestones[0]?.knownIssues).toEqual([
      "dismissed by the judge: BLOCKER A8 is not met",
      "dismissed by the judge: BLOCKER A9 is untestable",
    ]);
    log.add("commit.made", { milestone: "M1", round: 2, commit: "c2" });
    review(log, unowned);
    expect(log.state().milestones[0]).toMatchObject({ status: "review", disputes: 1 });
    expect(log.state().stuck.M1).toMatchObject({ reason: "blocker" });
  });

  it("a dispute the judge routes to a lane is one more fix round, and its next stop parks", () => {
    const log = reviewing();
    review(log, [bug("BLOCKER src/a/x.ts:1 — owned", "src/a/x.ts", "BLOCKER")]);
    finishLane(log, "M1.L1");
    log.add("commit.made", { milestone: "M1", round: 1, commit: "c1" });
    review(log, [
      bug("BLOCKER A8 is not met", null, "BLOCKER"),
      bug("BLOCKER A9 is untestable", null, "BLOCKER"),
    ]);
    triaged(log, "7", [{ finding: 1, to: "M1.L1", why: "the lane owns it" }]);
    expect(log.state().lanes["M1.L1"]).toMatchObject({ status: "pending" });
    expect(log.state().milestones[0]).toMatchObject({ status: "fixing", disputing: false, disputes: 1 });
    expect(log.state().milestones[0]?.knownIssues).toEqual([
      "dismissed by the judge: BLOCKER A9 is untestable",
    ]);
    finishLane(log, "M1.L1");
    log.add("commit.made", { milestone: "M1", round: 2, commit: "c2" });
    review(log, [
      bug("BLOCKER A8 is still not met", null, "BLOCKER"),
      bug("BLOCKER A10 is new", null, "BLOCKER"),
    ]);
    expect(log.state().milestones[0]).toMatchObject({ status: "review", disputes: 1 });
    expect(log.state().stuck.M1).toMatchObject({ reason: "blocker" });
  });

  it("accept after a check-red blocker verifies, without checking the same commit again", () => {
    const log = reviewing();
    const owned = (text: string) => bug(`BLOCKER src/a/x.ts:1 — ${text}`, "src/a/x.ts", "BLOCKER");
    review(log, [owned("first"), owned("second")]);
    finishLane(log, "M1.L1");
    log.add("commit.made", { milestone: "M1", round: 1, commit: "c1" });
    review(log, []);
    // the check on c1 is red with a BLOCKER a lane owns, and the third failing round reaches the cap
    checked(log, "c1", { findings: [owned("third")] });
    expect(log.state().milestones[0]).toMatchObject({ status: "review", checkedOn: null });
    log.add("question.parked", { unit: "M1", question: "third", reason: "blocker" });
    log.add("question.answered", { unit: "M1", answer: "accept", by: "owner" });
    expect(log.state().milestones[0]).toMatchObject({
      status: "verifying",
      checkedOn: "c1",
      checkWaivedOn: "c1",
    });
    const out = settled(log);
    expect(out.some((a) => a.type === "machineCheck")).toBe(false);
    expect(out).toContainEqual(expect.objectContaining({ type: "dispatch", role: "verifier" }));
    const v = startDispatch(log, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
    endDispatch(log, v, { name: "verifier-M1", unit: "M1", verdict: "pass", head: "c1" });
    expect(log.state().milestones[0]).toMatchObject({ status: "landing" });
  });

  it("a judge's dismissal of a check-red dispute verifies, without checking the same commit again", () => {
    const log = reviewing();
    review(log, [bug("BLOCKER src/a/x.ts:1 — owned", "src/a/x.ts", "BLOCKER")]);
    finishLane(log, "M1.L1");
    log.add("commit.made", { milestone: "M1", round: 1, commit: "c1" });
    review(log, []);
    // the check on c1 is red with BLOCKERs no lane owns, at the cap: the triage judge reads them
    checked(log, "c1", {
      findings: [
        bug("BLOCKER A8 is not met", null, "BLOCKER"),
        bug("BLOCKER A9 is untestable", null, "BLOCKER"),
      ],
    });
    expect(log.state().milestones[0]).toMatchObject({ status: "fixing", disputing: true });
    triaged(log, "7", []);
    expect(log.state().milestones[0]).toMatchObject({
      status: "verifying",
      disputing: false,
      checkedOn: "c1",
      checkWaivedOn: "c1",
    });
    const out = settled(log);
    expect(out.some((a) => a.type === "machineCheck")).toBe(false);
    expect(out).toContainEqual(expect.objectContaining({ type: "dispatch", role: "verifier" }));
  });

  it("a check red at the cap with only BUGs settles them as known issues, and the verifier gates the commit", () => {
    const log = reviewing();
    review(log, [
      bug("BUG src/a/x.ts:1 — two", "src/a/x.ts"),
      bug("BUG src/a/x.ts:2 — two too", "src/a/x.ts"),
    ]);
    finishLane(log, "M1.L1");
    log.add("commit.made", { milestone: "M1", round: 1, commit: "c1" });
    review(log, [bug("BUG src/a/x.ts:3 — one", "src/a/x.ts")]);
    finishLane(log, "M1.L1");
    log.add("commit.made", { milestone: "M1", round: 2, commit: "c2" });
    review(log, []);
    checked(log, "c2", { findings: [bug("BUG src/a/x.ts:4 — the check", "src/a/x.ts")] });
    expect(log.state().milestones[0]).toMatchObject({
      status: "verifying",
      checkedOn: "c2",
      knownIssues: ["BUG src/a/x.ts:4 — the check"],
    });
    const out = settled(log);
    expect(out.some((a) => a.type === "machineCheck")).toBe(false);
    expect(out).toContainEqual(expect.objectContaining({ type: "dispatch", role: "verifier" }));
  });

  it("a disk deferral is owed as a wait for disk", () => {
    const log = runningLog(PLAN, "main");
    log.add("tree.deferred", { milestone: "M1", availableMb: 1024, needMb: 4096, resource: "disk" });
    expect(log.state().owed["memory:M1"]?.text).toMatch(
      /^M1 waits for disk: 1024 MB available, 4096 MB needed/,
    );
  });
});

describe("pending reminder wake scheduling", () => {
  it("does not keep an expired wake while the reminder effect is pending", () => {
    const log = runningLog();
    const parked = log.add("question.parked", { unit: "M1", question: "repair?", reason: "environment" });
    const due = new Date(Date.parse(parked.at) + 1_800_000).toISOString();
    expect(log.state().wakeAt).toBe(due);
    const tick = log.add("tick", {}, due);
    expect(next(log.state(), tick).filter((a) => a.type === "remind")).toEqual([
      { type: "remind", unit: "M1", n: 1 },
    ]);
    expect(log.state().wakeAt).toBeNull();
    const unrelated = log.add("daemon.started", { pid: 123, version: "1.5.0" }, due);
    expect(log.state().wakeAt).toBeNull();
    expect(next(log.state(), unrelated).filter((a) => a.type === "remind")).toEqual([
      { type: "remind", unit: "M1", n: 1 },
    ]);
    log.add("question.reminded", { unit: "M1", n: 1 }, due);
    expect(log.state().wakeAt).toBe(new Date(Date.parse(parked.at) + 7_200_000).toISOString());
  });

  it("keeps a future question's wake while another reminder is due", () => {
    const log = runningLog();
    const first = log.add("question.parked", { unit: "M1", question: "first?", reason: "environment" });
    const second = log.add("question.parked", { unit: "M2", question: "second?", reason: "environment" });
    log.add("tick", {}, new Date(Date.parse(first.at) + 1_800_000).toISOString());
    expect(log.state().wakeAt).toBe(new Date(Date.parse(second.at) + 1_800_000).toISOString());
  });
  it("a finding naming two lanes' files goes to both", () => {
    const log = reviewing();
    review(log, [bug("BUG src/a/x.ts:3 and src/b/y.ts:4 disagree on the id", "src/a/x.ts")]);
    const s = log.state();
    expect(s.lanes["M1.L1"]?.notes).toHaveLength(1);
    expect(s.lanes["M1.L2"]?.notes).toEqual(s.lanes["M1.L1"]?.notes as string[]);
    expect(s.milestones[0]?.open).toEqual([]);
  });

  it("a route to a running lane is kept for its next round", () => {
    const log = reviewing();
    review(log, [bug("BUG src/a/x.ts:3 wrong", "src/a/x.ts"), bug("BUG unrelated to any file", null)]);
    const w = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    expect(log.state().lanes["M1.L1"]?.status).toBe("running");
    triaged(log, "j1", [{ finding: 1, to: "M1.L1", why: "yours" }]);
    expect(log.state().lanes["M1.L1"]).toMatchObject({
      status: "running",
      queued: ["BUG unrelated to any file"],
    });
    endDispatch(log, w, { name: "worker-M1.L1", unit: "M1.L1" });
    log.add("check.ran", { lane: "M1.L1", exit: 0, tail: "", foreign: [] });
    expect(log.state().lanes["M1.L1"]).toMatchObject({
      status: "pending",
      notes: ["BUG unrelated to any file"],
      queued: [],
      attempts: 0,
    });
  });

  it("drops a queued route with the lane a judge skips", () => {
    const log = reviewing();
    review(log, [bug("BUG src/a/x.ts:3 wrong", "src/a/x.ts"), bug("BUG unrelated to any file", null)]);
    startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    triaged(log, "j1", [{ finding: 1, to: "M1.L1", why: "yours" }]);
    const j = startDispatch(log, { name: "judge-j2", role: "judge", unit: "M1.L1", lane: null });
    log.add("judge.decided", {
      id: "j2",
      unit: "M1.L1",
      kind: "unexpected",
      decision: { verb: "skip", why: "no" },
      dispatchId: j,
    });
    expect(log.state().lanes["M1.L1"]).toMatchObject({ status: "done", queued: [] });
  });

  it("an order refusal waits, and parks only at the limit", () => {
    const log = runningLog();
    const refuse = () =>
      log.add("dispatch.refused", {
        name: "worker-M1.L2",
        unit: "M1.L2",
        code: "E_ADMIT_ORDER",
        message: "M1.L1 first",
      });
    for (let i = 1; i < ADMIT_WAITS; i++) refuse();
    expect(log.state().stuck["M1.L2"]).toBeUndefined();
    expect(log.state().waiting["worker-M1.L2"]).toBeDefined();
    refuse();
    expect(log.state().stuck["M1.L2"]).toMatchObject({ reason: "effect" });
  });

  it("a started dispatch clears the admission count", () => {
    const log = runningLog();
    const refuse = () =>
      log.add("dispatch.refused", {
        name: "worker-M1.L1",
        unit: "M1.L1",
        code: "E_ADMIT_OVERLAP",
        message: "x",
      });
    for (let i = 1; i < ADMIT_WAITS; i++) refuse();
    startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    expect(log.state().failedEffects["admit:worker-M1.L1@M1.L1"]).toBeUndefined();
  });

  it("siblings never wait on each other, nor on a lane that follows them", () => {
    const log = runningLog();
    const w1 = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    startDispatch(log, { name: "worker-M1.L2", unit: "M1.L2" });
    endDispatch(log, w1, { name: "worker-M1.L1", unit: "M1.L1" });
    // M1.L2 follows M1.L1: waiting for it would never end
    log.add("check.ran", {
      lane: "M1.L1",
      exit: 1,
      tail: "src/b/x.ts:3 error",
      foreign: [],
      siblings: ["M1.L2"],
    });
    expect(log.state().lanes["M1.L1"]).toMatchObject({ status: "pending", waitOn: [], checkFails: 1 });
    // mutual: M1.L1 waits for the running M1.L2 (a plan where neither follows the other)
    const mutual = runningLog(independent);
    const a1 = startDispatch(mutual, { name: "worker-M1.L1", unit: "M1.L1" });
    const a2 = startDispatch(mutual, { name: "worker-M1.L2", unit: "M1.L2" });
    endDispatch(mutual, a1, { name: "worker-M1.L1", unit: "M1.L1" });
    mutual.add("check.ran", {
      lane: "M1.L1",
      exit: 1,
      tail: "src/b/x.ts:3",
      foreign: [],
      siblings: ["M1.L2"],
    });
    expect(mutual.state().lanes["M1.L1"]).toMatchObject({ status: "checking", waitOn: ["M1.L2"] });
    endDispatch(mutual, a2, { name: "worker-M1.L2", unit: "M1.L2" });
    mutual.add("check.ran", {
      lane: "M1.L2",
      exit: 1,
      tail: "src/a/y.ts:3",
      foreign: [],
      siblings: ["M1.L1"],
    });
    expect(mutual.state().lanes["M1.L2"]).toMatchObject({ status: "pending", waitOn: [], checkFails: 1 });
  });

  it("three siblings never wait on each other in a ring", () => {
    const three: MilestonePlan[] = [
      {
        ...(independent[0] as MilestonePlan),
        lanes: ["a", "b", "c"].map((d, n) => ({
          id: `M1.L${n + 1}`,
          role: "worker",
          kind: "repo_code",
          after: [],
          owns: [`src/${d}/`],
        })),
      },
    ];
    const log = runningLog(three);
    const ids = ["M1.L1", "M1.L2", "M1.L3"];
    const ws = ids.map((id) => startDispatch(log, { name: `worker-${id}`, unit: id }));
    ids.forEach((id, n) => {
      endDispatch(log, ws[n] as string, { name: `worker-${id}`, unit: id });
      log.add("check.ran", {
        lane: id,
        exit: 1,
        tail: "src/x.ts:3 error",
        foreign: [],
        siblings: [ids[(n + 1) % 3] as string],
      });
    });
    expect(ids.map((id) => log.state().lanes[id]?.status)).not.toEqual(["checking", "checking", "checking"]);
    expect(log.state().lanes["M1.L3"]).toMatchObject({ status: "pending", waitOn: [] });
  });

  it("a rerun check forgets what it waited on", () => {
    const log = runningLog(independent);
    const w = startDispatch(log, { name: "worker-M1.L2", unit: "M1.L2" });
    endDispatch(log, w, { name: "worker-M1.L2", unit: "M1.L2" });
    startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    log.add("check.ran", { lane: "M1.L2", exit: 1, tail: "src/a/x.ts:3", foreign: [], siblings: ["M1.L1"] });
    expect(log.state().lanes["M1.L2"]?.waitOn).toEqual(["M1.L1"]);
    log.add("check.ran", { lane: "M1.L2", exit: 1, tail: "src/b/x.ts:1 other", foreign: [] });
    expect(log.state().lanes["M1.L2"]?.waitOn).toEqual([]);
  });

  it("a failure in a running sibling's file waits for it", () => {
    const log = runningLog(independent);
    const w1 = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    const w2 = startDispatch(log, { name: "worker-M1.L2", unit: "M1.L2" });
    endDispatch(log, w1, { name: "worker-M1.L1", unit: "M1.L1" });
    log.add("check.ran", {
      lane: "M1.L1",
      exit: 1,
      tail: "src/b/x.ts:3 error",
      foreign: [],
      siblings: ["M1.L2"],
    });
    expect(log.state().lanes["M1.L1"]).toMatchObject({
      status: "checking",
      waitOn: ["M1.L2"],
      checkFails: 0,
      stopRun: 0,
    });
    const owed = (): string[] =>
      next(log.state(), log.events.at(-1) as never).flatMap((a) => (a.type === "fastCheck" ? [a.lane] : []));
    expect(owed()).not.toContain("M1.L1");
    endDispatch(log, w2, { name: "worker-M1.L2", unit: "M1.L2" });
    log.add("check.ran", { lane: "M1.L2", exit: 0, tail: "", foreign: [] });
    expect(owed()).toContain("M1.L1");
  });
});

describe("plan 43 M3: owners, parks and STATUS asks", () => {
  const lone: MilestonePlan[] = [
    {
      id: "M1",
      title: "t",
      after: [],
      lanes: [{ id: "M1.L1", role: "worker", kind: "repo_code", after: [], owns: ["src/a.ts"] }],
    },
  ];
  /** two independent lanes owning single files */
  const files = (a: string, b: string): MilestonePlan[] => [
    {
      id: "M1",
      title: "t",
      after: [],
      lanes: [
        { id: "M1.L1", role: "worker", kind: "repo_code", after: [], owns: [a] },
        { id: "M1.L2", role: "worker", kind: "repo_code", after: [], owns: [b] },
      ],
    },
  ];
  const owned = (plan: MilestonePlan[]) => {
    const log = runningLog(plan);
    for (const l of plan[0]?.lanes ?? []) finishLane(log, l.id);
    log.add("commit.made", { milestone: "M1", round: 0, commit: "c0" });
    return log;
  };
  const workerNames = (log: ReturnType<typeof makeLog>) =>
    settled(log).flatMap((a) => (a.type === "dispatch" ? [a.name] : []));

  it("a check_broken stop with no sibling at work parks at once", () => {
    const log = runningLog(lone);
    const w = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    endDispatch(log, w, {
      name: "worker-M1.L1",
      unit: "M1.L1",
      replyStatus: "blocked",
      reason: "check_broken",
      why: "test/x.test.ts:12 asserts the old head",
    });
    log.add("stop.classified", { dispatchId: w, reason: "check_broken" });
    const s = log.state();
    expect(s.lanes["M1.L1"]?.status).toBe("parked");
    expect(s.stuck["M1.L1"]?.question).toContain("test/x.test.ts:12 asserts the old head");
    expect(workerNames(log)).toEqual([]);
    // a sibling at work: the lane waits, no park
    const busy = runningLog(independent);
    startDispatch(busy, { name: "worker-M1.L2", unit: "M1.L2" });
    const w2 = startDispatch(busy, { name: "worker-M1.L1", unit: "M1.L1" });
    endDispatch(busy, w2, {
      name: "worker-M1.L1",
      unit: "M1.L1",
      replyStatus: "blocked",
      reason: "check_broken",
      why: "lint fails",
    });
    busy.add("stop.classified", { dispatchId: w2, reason: "check_broken" });
    expect(busy.state().lanes["M1.L1"]?.status).toBe("pending");
    expect(busy.state().stuck["M1.L1"]).toBeUndefined();
  });

  it("a reply with no STATUS line is asked once on the same thread", () => {
    const log = runningLog(lone);
    const w = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    endDispatch(log, w, { name: "worker-M1.L1", unit: "M1.L1", replyStatus: null, thread: "t1" });
    expect(log.state().lanes["M1.L1"]).toMatchObject({
      status: "pending",
      thread: "t1",
      notes: [STATUS_ASK],
      statusAsked: true,
      classify: null,
    });
    const w2 = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1", thread: "t1" });
    endDispatch(log, w2, { name: "worker-M1.L1", unit: "M1.L1", replyStatus: null, thread: "t1" });
    expect(log.state().lanes["M1.L1"]).toMatchObject({
      status: "pending",
      attempts: 1,
      thread: null,
      statusAsked: false,
    });
    // an end with a status clears the ask
    const w3 = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    endDispatch(log, w3, { name: "worker-M1.L1", unit: "M1.L1", replyStatus: null, thread: "t2" });
    const w4 = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1", thread: "t2" });
    endDispatch(log, w4, { name: "worker-M1.L1", unit: "M1.L1", replyStatus: "complete", thread: "t2" });
    expect(log.state().lanes["M1.L1"]).toMatchObject({ statusAsked: false, status: "checking" });
  });

  it("a relative path finds the lane owning its suffix", () => {
    const deep = "web/src/components/graph/RunGraph.tsx";
    const lanes = [
      { id: "M1.L1", owns: ["src/a/"] },
      { id: "M1.L2", owns: [deep] },
    ];
    expect(ownerOfFile("graph/RunGraph.tsx", lanes)).toBe("M1.L2");
    expect(ownerOfFile("raph/RunGraph.tsx", lanes)).toBeNull();
    // an exact owner still beats the suffix rule
    expect(ownerOfFile("src/a/x.ts", lanes)).toBe("M1.L1");
    expect(
      ownerOfFile("graph/RunGraph.tsx", [...lanes, { id: "M1.L3", owns: ["app/graph/RunGraph.tsx"] }]),
    ).toBeNull();
    const log = owned(files("src/a.ts", deep));
    review(log, [bug("BUG (`graph/RunGraph.tsx`) — the node overlaps — fix", null)]);
    expect(log.state().lanes["M1.L2"]).toMatchObject({
      status: "pending",
      notes: ["BUG (`graph/RunGraph.tsx`) — the node overlaps — fix"],
    });
    expect(log.state().lanes["M1.L1"]?.status).toBe("done");
    // two lanes ending in the same path: no owner, the finding stays open for the judge
    const both = owned(files("web/a/graph/RunGraph.tsx", "web/b/graph/RunGraph.tsx"));
    review(both, [bug("BUG (`graph/RunGraph.tsx`) — the node overlaps — fix", null)]);
    expect(both.state().milestones[0]?.open).toHaveLength(1);
    expect(both.state().lanes["M1.L1"]?.status).toBe("done");
    expect(both.state().lanes["M1.L2"]?.status).toBe("done");
  });

  it("a capped BLOCKER that names a lane's file is no dispute", () => {
    const log = owned(lone);
    const blocker = bug("BLOCKER src/a.ts:3 — the export is wrong — fix", null, "BLOCKER");
    review(log, [blocker]);
    expect(log.state().milestones[0]?.status).toBe("fixing");
    finishLane(log, "M1.L1");
    log.add("commit.made", { milestone: "M1", round: 1, commit: "c1" });
    review(log, [blocker]);
    const s = log.state();
    expect(s.milestones[0]).toMatchObject({ status: "review", disputes: 0, disputing: false });
    expect(s.stuck.M1).toMatchObject({ reason: "blocker" });
    expect(next(s, log.events.at(-1)!).some((a) => a.type === "judge")).toBe(false);
  });

  describe("a land park answered by the owner", () => {
    const parked = () => {
      const log = owned(files("src/a.ts", "src/b.ts"));
      review(log, []);
      checked(log, "c0", { missing: ["FAIL x"] });
      log.add("question.parked", { unit: "M1", question: "q", reason: "land" });
      return log;
    };

    it("a named fix starts a fix round", () => {
      const log = parked();
      log.add("question.answered", { unit: "M1", answer: "src/a.ts: drop the stale assertion", by: "owner" });
      const s = log.state();
      expect(s.milestones[0]?.status).toBe("fixing");
      expect(s.lanes["M1.L1"]).toMatchObject({
        status: "pending",
        notes: ["src/a.ts: drop the stale assertion"],
      });
      expect(s.lanes["M1.L2"]?.status).toBe("done");
    });

    it("an answer naming no file goes to the triage judge", () => {
      const log = parked();
      log.add("question.answered", { unit: "M1", answer: "the fixture is stale", by: "owner" });
      expect(log.state().milestones[0]).toMatchObject({
        status: "fixing",
        open: [{ label: "BLOCKER", text: "the fixture is stale" }],
      });
    });

    it("retry runs the check again", () => {
      const log = parked();
      log.add("question.answered", { unit: "M1", answer: "retry", by: "owner" });
      expect(log.state().milestones[0]?.status).toBe("verifying");
      expect(settled(log).filter((a) => a.type === "machineCheck")).toEqual([
        { type: "machineCheck", milestone: "M1", commit: "c0" },
      ]);
    });
  });

  it("accept on a verifier check_broken park lands on a green check", () => {
    const log = owned(lone);
    review(log, []);
    checked(log, "c0");
    const v = startDispatch(log, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
    endDispatch(log, v, { name: "verifier-M1", unit: "M1", verdict: "fail", reason: "check_broken" });
    log.add("question.parked", { unit: "M1", question: "q", reason: "check_broken" });
    log.add("question.answered", { unit: "M1", answer: "accept, the env is flaky", by: "owner" });
    expect(log.state().milestones[0]).toMatchObject({ status: "landing", verifierPassedOn: "c0" });
  });
});

describe("plan 43 M4: digests, hook refusals, the pause hold", () => {
  const digested = (l1: string, l2: string): MilestonePlan[] =>
    PLAN.map((m) =>
      m.id === "M1" ? { ...m, lanes: m.lanes.map((l) => ({ ...l, digest: l.id === "M1.L1" ? l1 : l2 })) } : m,
    );

  it("a replan that edits a done lane's file re-runs it", () => {
    const log = makeLog();
    log.add("run.started", startedFields);
    log.add("plan.ready", { milestones: digested("a", "b") });
    log.add("plan.approved", { by: "owner" });
    routeMilestone(log, PLAN[0] as MilestonePlan);
    finishLane(log, "M1.L1", { thread: "t1" });
    finishLane(log, "M1.L2");
    log.add("commit.made", { milestone: "M1", round: 0, commit: "c0" });
    review(log, [bug("BLOCKER nowhere/x.ts:1 — unowned", "nowhere/x.ts", "BLOCKER")]);
    expect(log.state().milestones[0]?.status).toBe("fixing");
    log.add("plan.ready", { milestones: digested("c", "b") });
    const s = log.state();
    expect(s.lanes["M1.L1"]).toMatchObject({
      status: "pending",
      thread: "t1",
      digest: "c",
      notes: ["The architect changed lanes/M1.L1.md: re-read it and make the change it asks for."],
    });
    expect(s.lanes["M1.L2"]).toMatchObject({ status: "done", digest: "b" });
    const out = settled(log);
    expect(out).toContainEqual(expect.objectContaining({ type: "dispatch", name: "worker-M1.L1" }));
    expect(out.some((a) => a.type === "commit")).toBe(false);
  });

  it("a replan that edits a done lane sends a landing or parked milestone back to fixing", () => {
    const done = () => {
      const log = makeLog();
      log.add("run.started", startedFields);
      log.add("plan.ready", { milestones: digested("a", "b") });
      log.add("plan.approved", { by: "owner" });
      routeMilestone(log, PLAN[0] as MilestonePlan);
      finishLane(log, "M1.L1", { thread: "t1" });
      finishLane(log, "M1.L2");
      log.add("commit.made", { milestone: "M1", round: 0, commit: "c0" });
      review(log, []);
      return log;
    };
    const landing = done();
    checked(landing, "c0");
    const v = startDispatch(landing, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
    endDispatch(landing, v, { name: "verifier-M1", unit: "M1", verdict: "pass", head: "c0" });
    expect(landing.state().milestones[0]?.status).toBe("landing");
    landing.add("plan.ready", { milestones: digested("c", "b") });
    expect(landing.state().milestones[0]?.status).toBe("fixing");
    expect(landing.state().lanes["M1.L1"]).toMatchObject({ status: "pending", thread: "t1" });

    const parked = done();
    parked.add("question.parked", { unit: "M1", question: "q", reason: "blocker" });
    expect(parked.state().milestones[0]).toMatchObject({ status: "parked", parkedFrom: "verifying" });
    parked.add("plan.ready", { milestones: digested("c", "b") });
    expect(parked.state().milestones[0]).toMatchObject({ status: "parked", parkedFrom: "fixing" });
    parked.add("question.answered", { unit: "M1", answer: "retry", by: "owner" });
    expect(parked.state().milestones[0]?.status).toBe("fixing");
  });

  it("a replan with no digest, the same digest or a first digest re-runs nothing", () => {
    const log = makeLog();
    log.add("run.started", startedFields);
    log.add("plan.ready", { milestones: PLAN });
    log.add("plan.approved", { by: "owner" });
    routeMilestone(log, PLAN[0] as MilestonePlan);
    finishLane(log, "M1.L1");
    // no stored digest: the first one is taken, nothing re-runs
    log.add("plan.ready", { milestones: digested("a", "b") });
    expect(log.state().lanes["M1.L1"]).toMatchObject({ status: "done", digest: "a" });
    log.add("plan.ready", { milestones: digested("a", "b") });
    expect(log.state().lanes["M1.L1"]).toMatchObject({ status: "done", digest: "a", notes: [] });
    // a plan without digests keeps the stored one
    log.add("plan.ready", { milestones: PLAN });
    expect(log.state().lanes["M1.L1"]).toMatchObject({ status: "done", digest: "a" });
  });

  describe("a pre-commit hook refusal", () => {
    const committing = () => {
      const log = runningLog(lone);
      finishLane(log, "M1.L1", { thread: "t1" });
      return log;
    };
    const lone: MilestonePlan[] = [
      {
        id: "M1",
        title: "t",
        after: [],
        lanes: [{ id: "M1.L1", role: "worker", kind: "repo_code", after: [], owns: ["src/a.ts"] }],
      },
    ];

    it("goes to the owning lane once", () => {
      const log = committing();
      expect(log.state().milestones[0]?.status).toBe("committing");
      log.add("commit.failed", { milestone: "M1", round: 0, tail: "src/a.ts: not formatted", hook: true });
      let s = log.state();
      expect(s.stuck.M1).toBeUndefined();
      expect(s.milestones[0]).toMatchObject({ status: "fixing", hookFixes: 1 });
      expect(s.lanes["M1.L1"]).toMatchObject({ status: "pending", thread: "t1" });
      expect(s.lanes["M1.L1"]?.notes).toEqual([
        "The pre-commit hook refused the commit:\nsrc/a.ts: not formatted",
      ]);
      // a second refusal before a commit parks as it always did
      finishLane(log, "M1.L1");
      log.add("commit.failed", { milestone: "M1", round: 0, tail: "src/a.ts: still not", hook: true });
      s = log.state();
      expect(s.stuck.M1).toMatchObject({ reason: "commit" });
    });

    it("a refusal without hook, or a commit.made, behaves as before", () => {
      const log = committing();
      log.add("commit.failed", { milestone: "M1", round: 0, tail: "src/a.ts" });
      expect(log.state().stuck.M1).toMatchObject({ reason: "commit" });
      const again = committing();
      again.add("commit.failed", { milestone: "M1", round: 0, tail: "src/a.ts", hook: true });
      finishLane(again, "M1.L1");
      again.add("commit.made", { milestone: "M1", round: 0, commit: "c0" });
      expect(again.state().milestones[0]?.hookFixes).toBe(0);
    });

    it("a refusal naming no lane's file goes to the triage judge", () => {
      const log = committing();
      log.add("commit.failed", { milestone: "M1", round: 0, tail: "lefthook failed", hook: true });
      expect(log.state().milestones[0]).toMatchObject({
        status: "fixing",
        open: [{ label: "BLOCKER", file: null }],
      });
    });
  });

  it("a paused machine holds the run with one refusal", () => {
    const log = runningLog();
    const refuse = (name: string) =>
      log.add("dispatch.refused", { name, unit: name.slice(7), code: "E_ADMIT_PAUSED", message: "paused" });
    refuse("worker-M1.L1");
    refuse("worker-M1.L1");
    const s = log.state();
    expect(s.held).toBe(log.events.find((e) => e.type === "dispatch.refused")?.at ?? null);
    expect(s.waiting).toEqual({});
    const tick = log.add("tick", {});
    const out = next(log.state(), tick);
    expect(out.filter((a) => a.type === "decide" || a.type === "dispatch" || a.type === "judge")).toEqual([]);
    const lifted = log.add("pause.lifted", {});
    expect(log.state().held).toBeNull();
    expect(next(log.state(), lifted)).toContainEqual(
      expect.objectContaining({ type: "decide", next: expect.objectContaining({ name: "worker-M1.L1" }) }),
    );
  });

  it("a plan-check park tells the owner to edit the source plan files", () => {
    const log = makeLog();
    log.add("run.started", startedFields);
    log.add("plan.ready", { milestones: PLAN });
    log.add("plan.approved", { by: "owner" });
    for (let i = 0; i < 3; i++)
      log.add("effect.failed", { action: "readPlan", unit: "run", message: "lane M1.L1 owns nothing" });
    expect(log.state().stuck.run?.question).toBe(
      `readPlan on run failed: lane M1.L1 owns nothing\n${SOURCE_PLAN_NOTE}`,
    );
  });
});

describe("plan 43 M5: catherd merges its own landed milestones", () => {
  const landedLog = (autoMerge: boolean) => {
    const log = makeLog();
    log.add("run.started", { ...startedFields, base: "main", autoMerge });
    log.add("plan.ready", { milestones: PLAN });
    log.add("plan.approved", { by: "owner" });
    log.add("milestone.landed", {
      milestone: "M1",
      commit: "c0abcdef0123",
      knownIssues: [],
      digestPath: "d",
      branch: "feat/wallet",
    });
    return log;
  };
  const last = (log: ReturnType<typeof makeLog>) => next(log.state(), log.events.at(-1) as never);

  it("an autoMerge run's landed milestone is merged by catherd", () => {
    const log = landedLog(true);
    expect(log.state().autoMerge).toBe(true);
    let out = last(log);
    expect(out.filter((a) => a.type === "mergeLanded")).toEqual([{ type: "mergeLanded", milestone: "M1" }]);
    expect(out.filter((a) => a.type === "park" || a.type === "pushBranch")).toEqual([]);
    log.add("milestone.merged", { milestone: "M1", by: "catherd", commit: "e1" });
    out = last(log);
    expect(log.state().milestones[0]?.status).toBe("merged");
    expect(out.filter((a) => a.type === "mergeLanded")).toEqual([]);
    expect(out.filter((a) => a.type === "claimTree")).toEqual([{ type: "claimTree", milestone: "M2" }]);
    expect(confirms(log.events.at(-1) as never)).toContain("mergeLanded:M1");
  });

  it("a failed merge falls back to the push question", () => {
    const log = landedLog(true);
    log.add("merge.failed", { milestone: "M1", error: "CONFLICT (content): src/a.ts" });
    expect(confirms(log.events.at(-1) as never)).toContain("mergeLanded:M1");
    const out = last(log);
    expect(out.filter((a) => a.type === "mergeLanded")).toEqual([]);
    const park = out.find((a) => a.type === "park");
    expect(park).toMatchObject({ unit: "M1", reason: "push" });
    const question = (park as { question: string }).question;
    expect(question).toContain("catherd could not merge it: CONFLICT (content): src/a.ts.");
    expect(question).toContain("chore: merge");
  });

  it("autoMerge turned on later does not change a run that started without it", () => {
    const log = landedLog(false);
    expect(log.state().autoMerge).toBe(false);
    expect(last(log).filter((a) => a.type === "mergeLanded")).toEqual([]);
    expect(last(log).filter((a) => a.type === "park")).toHaveLength(1);
  });
});

describe("plan 44 task 15: floors, decision failures and the top of the ladder", () => {
  const W1 = "worker-M1.L1";
  const owedDecide = (log: ReturnType<typeof makeLog>, name: string) =>
    next(log.state(), log.events.at(-1) as RunEvent).find(
      (a): a is DecideAction => a.type === "decide" && decidedName(a.next) === name,
    );
  /** a time `ms` after the log's last event */
  const after = (log: ReturnType<typeof makeLog>, ms: number): string =>
    new Date(Date.parse(log.events.at(-1)?.at as string) + ms).toISOString();
  /** M1.L1 decided on `rung`, dispatched and ended ok */
  function ran(log: ReturnType<typeof makeLog>, rung: string, o: { thread?: string } = {}) {
    decide(log, W1, rung);
    const id = startDispatch(log, { name: W1, unit: "M1.L1", rung });
    endDispatch(log, id, { name: W1, unit: "M1.L1", thread: o.thread ?? "t1" });
  }
  const checkFails = (log: ReturnType<typeof makeLog>, tail: string) =>
    log.add("check.ran", { lane: "M1.L1", exit: 1, tail, foreign: [] });
  const downAt = (log: ReturnType<typeof makeLog>, at?: string) =>
    log.add(
      "decision.failed",
      {
        name: W1,
        n: 1,
        unit: "M1.L1",
        code: "E_DECISION",
        error: "no usable answer",
        rungs: [SOL, SOL_HIGH],
      },
      at,
    );

  it("a failed fast check is the floor of the fix round", () => {
    const log = runningLog();
    ran(log, LUNA);
    checkFails(log, "error: first");
    expect(owedDecide(log, W1)).toMatchObject({ n: 2, floor: LUNA, strict: false });
    ran(log, LUNA);
    checkFails(log, "error: second");
    expect(owedDecide(log, W1)).toMatchObject({ n: 3, floor: LUNA, strict: true });
    // a pass is an accepted dispatch: the floor goes
    ran(log, SOL_HIGH);
    log.add("check.ran", { lane: "M1.L1", exit: 0, tail: "", foreign: [] });
    expect(floorOf(log.state(), W1)).toEqual({ floor: null, strict: false });
  });

  it("a failure on another rung restarts the count", () => {
    const log = runningLog();
    ran(log, LUNA);
    checkFails(log, "error: first");
    ran(log, SOL_HIGH);
    checkFails(log, "error: second");
    expect(owedDecide(log, W1)).toMatchObject({ floor: SOL_HIGH, strict: false });
  });

  it("a review BLOCKER floors only its lane", () => {
    const log = reviewing();
    review(log, [bug("BLOCKER src/b/x.ts:1 — boom", "src/b/x.ts", "BLOCKER")]);
    expect(owedDecide(log, "worker-M1.L2")).toMatchObject({ floor: SOL, strict: false });
    expect(floorOf(log.state(), W1)).toEqual({ floor: null, strict: false });
    finishLane(log, "M1.L2");
    log.add("commit.made", { milestone: "M1", round: 1, commit: "c1" });
    // the reviewer's recheck has no floor: a worker's BLOCKER is not the reviewer's failure
    expect(owedDecide(log, "reviewer-M1")).toMatchObject({ floor: null, strict: false });
  });

  it("a finding that survived its fix makes the floor strict at once", () => {
    const log = reviewing();
    review(log, [
      bug("BUG src/a/x.ts:3 — null deref", "src/a/x.ts"),
      bug("BUG src/a/y.ts:1 — other", "src/a/y.ts"),
    ]);
    expect(owedDecide(log, W1)).toMatchObject({ floor: SOL, strict: false });
    finishLane(log, "M1.L1");
    log.add("commit.made", { milestone: "M1", round: 1, commit: "c1" });
    review(log, [bug("BUG src/a/x.ts:9 — null deref", "src/a/x.ts")]);
    expect(owedDecide(log, W1)).toMatchObject({ floor: SOL, strict: true });
  });

  it("the owner's fix answer is no floor", () => {
    // a blocker park answered with a fix
    const log = reviewing();
    const blocker = bug("BLOCKER src/a/x.ts:1 — data loss", "src/a/x.ts", "BLOCKER");
    review(log, [blocker]);
    finishLane(log, "M1.L1");
    log.add("commit.made", { milestone: "M1", round: 1, commit: "c1" });
    review(log, [blocker]);
    const q = log.state().stuck.M1;
    expect(q?.reason).toBe("blocker");
    log.add("question.parked", { unit: "M1", question: q?.question as string, reason: "blocker" });
    log.add("question.answered", { unit: "M1", answer: "return early instead", by: "owner" });
    expect(owedDecide(log, W1)).toMatchObject({ floor: null, strict: false });
    // a lane that carried a floor: the owner's word starts it fresh
    const lane = runningLog();
    ran(lane, LUNA);
    checkFails(lane, "error: first");
    expect(floorOf(lane.state(), W1).floor).toBe(LUNA);
    lane.add("question.parked", { unit: "M1.L1", question: "q", reason: "effect" });
    lane.add("question.answered", { unit: "M1.L1", answer: "use the v2 api", by: "owner" });
    expect(owedDecide(lane, W1)).toMatchObject({ floor: null, strict: false });
  });

  it("no rung above a strict floor goes to the judge", () => {
    const log = runningLog();
    ran(log, SOL);
    checkFails(log, "error: first");
    ran(log, SOL);
    checkFails(log, "error: second");
    log.add("decision.exhausted", { name: W1, n: 3, unit: "M1.L1", floor: SOL });
    expect(log.state().lanes["M1.L1"]).toMatchObject({ status: "parked", top: true, awaiting: "unexpected" });
    expect(of(settled(log), "judge")[0]?.input).toMatchObject({ kind: "unexpected", unit: "M1.L1" });
    // the third stands at the top for the owner
    log.add("decision.exhausted", { name: W1, n: 3, unit: "M1.L1", floor: SOL });
    expect(log.state().stuck["M1.L1"]).toBeUndefined();
    log.add("decision.exhausted", { name: W1, n: 3, unit: "M1.L1", floor: SOL });
    expect(log.state().stuck["M1.L1"]).toMatchObject({ reason: "too_hard" });
  });

  it("a too_hard stop with no rung above goes straight to the owner", () => {
    const log = runningLog();
    decide(log, W1, SOL);
    const id = startDispatch(log, { name: W1, unit: "M1.L1", rung: SOL });
    endDispatch(log, id, {
      name: W1,
      unit: "M1.L1",
      replyStatus: "blocked",
      reason: "too_hard",
      why: "too_hard: x",
    });
    log.add("stop.classified", { dispatchId: id, reason: "too_hard" });
    expect(owedDecide(log, W1)).toMatchObject({ floor: SOL, strict: false });
    log.add("decision.exhausted", { name: W1, n: 2, unit: "M1.L1", floor: SOL });
    expect(log.state().stuck["M1.L1"]).toMatchObject({ reason: "too_hard" });
    expect(log.state().lanes["M1.L1"]?.awaiting).toBeNull();
  });

  it("a judge's retry at the top of the ladder runs the rung again", () => {
    const log = runningLog();
    ran(log, SOL);
    checkFails(log, "error: first");
    ran(log, SOL);
    checkFails(log, "error: second");
    log.add("decision.exhausted", { name: W1, n: 3, unit: "M1.L1", floor: SOL });
    const judgeId = "M1.L1-unexpected-0";
    const j = startDispatch(log, {
      name: `judge-${judgeId}`,
      role: "judge",
      unit: "M1.L1",
      lane: null,
      judgeKind: "unexpected",
    });
    log.add("judge.decided", {
      id: judgeId,
      unit: "M1.L1",
      kind: "unexpected",
      decision: { verb: "retry", why: "flaky" },
      dispatchId: j,
    });
    expect(owedDecide(log, W1)).toMatchObject({ floor: SOL, strict: false });
  });

  it("a decision model down parks after three tries", () => {
    const log = runningLog();
    const first = downAt(log);
    expect(log.state().waiting[W1]).toBe(after(log, 60_000));
    expect(owedDecide(log, W1)).toBeUndefined();
    // a minute later the same decision (the same n) is asked again
    log.add("tick", {}, new Date(Date.parse(first.at) + 60_000).toISOString());
    expect(owedDecide(log, W1)).toMatchObject({ n: 1 });
    const second = downAt(log);
    expect(log.state().waiting[W1]).toBe(new Date(Date.parse(second.at) + 60_000).toISOString());
    log.add("tick", {}, new Date(Date.parse(second.at) + 60_000).toISOString());
    expect(owedDecide(log, W1)).toMatchObject({ n: 1 });
    downAt(log);
    const s = log.state();
    expect(s.stuck["M1.L1"]).toMatchObject({ reason: "decision" });
    expect(s.stuck["M1.L1"]?.question).toContain(SOL);
    expect(s.stuck["M1.L1"]?.question).toContain(SOL_HIGH);
    expect(s.stuck["M1.L1"]?.question).toContain("retry");
    expect(s.lanes["M1.L1"]?.status).toBe("parked");
    expect(of(next(s, log.events.at(-1) as RunEvent), "park")).toMatchObject([
      { unit: "M1.L1", reason: "decision" },
    ]);
  });

  /** the lane's decision parked, as the park effect records it */
  function parked() {
    const log = runningLog();
    downAt(log);
    downAt(log);
    downAt(log);
    const q = log.state().stuck["M1.L1"];
    log.add("question.parked", { unit: "M1.L1", question: q?.question as string, reason: "decision" });
    return { log, question: q?.question as string };
  }

  it("the coordinator's rung is the decision", () => {
    const { log } = parked();
    log.add("question.answered", {
      unit: "M1.L1",
      answer: `${SOL_HIGH} — it needs the stronger one`,
      by: "owner",
    });
    expect(owedDecide(log, W1)).toMatchObject({ n: 1, pick: SOL_HIGH });
    expect(log.state().lanes["M1.L1"]?.notes).toEqual([]);
    // the next decision of the name asks the model again
    decide(log, W1, SOL_HIGH);
    startDispatch(log, { name: W1, unit: "M1.L1", rung: SOL_HIGH });
    expect(log.state().picks[W1]).toBeUndefined();
  });

  it("a rung off the list parks the same question again, and retry asks the model again", () => {
    const { log, question } = parked();
    log.add("question.answered", { unit: "M1.L1", answer: LUNA, by: "owner" });
    expect(log.state().stuck["M1.L1"]).toEqual({ reason: "decision", question });
    expect(log.state().lanes["M1.L1"]?.status).toBe("parked");
    expect(owedDecide(log, W1)).toBeUndefined();
    log.add("question.parked", { unit: "M1.L1", question, reason: "decision" });
    log.add("question.answered", { unit: "M1.L1", answer: "retry", by: "owner" });
    expect(owedDecide(log, W1)).toMatchObject({ n: 1, pick: null });
    // the count starts again: one failure waits, it does not park
    downAt(log);
    expect(log.state().stuck["M1.L1"]).toBeUndefined();
  });

  it("a decision with no stand-in waits for a hold to end, like a refused dispatch", () => {
    const log = runningLog();
    const lim = startDispatch(log, { name: W1, unit: "M1.L1", rung: SOL });
    endDispatch(log, lim, { name: W1, unit: "M1.L1", status: "limit", replyStatus: null });
    const failed = log.add("decision.failed", {
      name: W1,
      n: 1,
      unit: "M1.L1",
      code: "E_ALL_HELD",
      error: "every rung is held",
      rungs: [],
    });
    const until = Object.values(log.state().holds)[0] as string;
    expect(until > failed.at).toBe(true);
    expect(log.state().waiting[W1]).toBe(until);
    expect(log.state().stuck["M1.L1"]).toBeUndefined();
  });

  it("a classification the decision model cannot make is tried again, then parked", () => {
    const log = runningLog();
    decide(log, W1, SOL);
    const id = startDispatch(log, { name: W1, unit: "M1.L1", rung: SOL });
    endDispatch(log, id, { name: W1, unit: "M1.L1", status: "failed", replyStatus: null });
    const fail = () => log.add("effect.failed", { action: "classify", unit: "M1.L1", message: "down" });
    fail();
    fail();
    expect(log.state().lanes["M1.L1"]?.classify).toMatchObject({ dispatchId: id });
    fail();
    expect(log.state().stuck["M1.L1"]).toMatchObject({ reason: "decision" });
    log.add("question.parked", {
      unit: "M1.L1",
      question: log.state().stuck["M1.L1"]?.question as string,
      reason: "decision",
    });
    // the owner's answer ends the stop as an unexplained failure of the work
    log.add("question.answered", { unit: "M1.L1", answer: "go on", by: "owner" });
    expect(log.state().lanes["M1.L1"]).toMatchObject({ classify: null, status: "pending", attempts: 1 });
    expect(floorOf(log.state(), W1)).toEqual({ floor: SOL, strict: false });
  });

  it("a stale or refused rung is decided again", () => {
    const refused = runningLog();
    decide(refused, W1, SOL);
    refused.add("dispatch.refused", {
      name: W1,
      unit: "M1.L1",
      code: "E_ADMIT_RUNG",
      message: "no",
      rung: SOL,
    });
    expect(refused.state().decisions[W1]).toBeUndefined();
    expect(owedDecide(refused, W1)).toMatchObject({ n: 2, exclude: [SOL] });
    const stale = runningLog();
    decide(stale, W1, SOL);
    stale.add("dispatch.refused", { name: W1, unit: "M1.L1", code: "E_DECISION_STALE", message: "edited" });
    expect(stale.state().decisions[W1]).toBeUndefined();
    expect(owedDecide(stale, W1)).toMatchObject({ n: 2, exclude: [] });
    const held = runningLog();
    decide(held, W1, SOL);
    held.add("dispatch.refused", { name: W1, unit: "M1.L1", code: "E_RUNG_HELD", message: "quota held" });
    expect(owedDecide(held, W1)).toMatchObject({ n: 2, exclude: [] });
    // the next dispatch of the name forgets what it refused
    decide(refused, W1, SOL_HIGH);
    startDispatch(refused, { name: W1, unit: "M1.L1", rung: SOL_HIGH });
    expect(refused.state().refusedRungs[W1]).toBeUndefined();
  });

  it("a decision dropped again and again parks the unit", () => {
    const log = runningLog();
    for (let i = 0; i < REDECIDE_LIMIT; i++) {
      decide(log, W1, SOL);
      log.add("dispatch.refused", { name: W1, unit: "M1.L1", code: "E_DECISION_STALE", message: "edited" });
    }
    expect(log.state().stuck["M1.L1"]).toMatchObject({ reason: "effect" });
  });

  const digested = (l1: string): MilestonePlan[] =>
    PLAN.map((m) =>
      m.id === "M1"
        ? { ...m, lanes: m.lanes.map((l) => ({ ...l, digest: l.id === "M1.L1" ? l1 : "b" })) }
        : m,
    );

  it("a replan drops a lane's unsent decision", () => {
    const log = makeLog();
    log.add("run.started", startedFields);
    log.add("plan.ready", { milestones: digested("a") });
    log.add("plan.approved", { by: "owner" });
    routeMilestone(log, PLAN[0] as MilestonePlan);
    decide(log, W1, SOL);
    log.add("plan.ready", { milestones: digested("a") });
    expect(log.state().decisions[W1]).toMatchObject({ rung: SOL });
    log.add("plan.ready", { milestones: digested("c") });
    expect(log.state().decisions[W1]).toBeUndefined();
    // made again on the new brief, never sent stale
    expect(owedDecide(log, W1)).toMatchObject({ n: 2 });
  });

  it("an old run with climb events replays and decides", () => {
    const log = makeLog();
    log.add("run.started", startedFields);
    log.add("plan.ready", { milestones: PLAN });
    log.add("plan.approved", { by: "owner" });
    log.add("lanes.routed", {
      milestone: "M1",
      lanes: PLAN[0]!.lanes.map((l) => ({ lane: l.id, rung: SOL, ladder: [SOL, SOL_HIGH] })),
    });
    log.add("preflight.done", { milestone: "M1", blocking: [], confirm: null, lint: [] });
    log.add("lane.climbed", { lane: "M1.L1", rung: SOL_HIGH, top: false });
    log.add("effect.failed", { action: "climb", unit: "M1.L1", message: "no rung above" });
    expect(log.state().lanes["M1.L1"]).toMatchObject({ rung: SOL_HIGH, status: "pending" });
    expect(owedDecide(log, W1)).toMatchObject({ n: 1, floor: null, strict: false });
    // the climb's own top-of-ladder path still applies
    log.add("lane.climbed", { lane: "M1.L1", rung: SOL_HIGH, top: true });
    expect(log.state().lanes["M1.L1"]).toMatchObject({ status: "parked", awaiting: "unexpected" });
  });

  it("a failed judge call floors the judge's own name", () => {
    const log = runningLog();
    const id = "M1.L1-question-0";
    const j = startDispatch(log, {
      name: `judge-${id}`,
      role: "judge",
      unit: "M1.L1",
      lane: null,
      judgeKind: "question",
      rung: LUNA,
    });
    log.add("judge.failed", { id, unit: "M1.L1", why: "unreadable" });
    expect(j).toBeTruthy();
    expect(floorOf(log.state(), `judge-${id}`)).toEqual({ floor: LUNA, strict: false });
  });
});
