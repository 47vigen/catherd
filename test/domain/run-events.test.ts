import { describe, expect, it } from "bun:test";
import { describeEvent, RunEventSchema, type RunEvent } from "../../src/domain/run-events.ts";
import { PLAN, endDispatch, makeLog, startDispatch, startedFields } from "./run-fixtures.ts";

const finding = { label: "BUG" as const, text: "BUG src/a.ts:3 — x — y", file: "src/a.ts" };

/** one fixture per member of the union */
function oneOfEach(): RunEvent[] {
  const log = makeLog();
  log.add("run.started", startedFields);
  log.add("daemon.started", { pid: 1, version: "2.0.0" });
  log.add("plan.ready", { milestones: PLAN });
  log.add("plan.approved", { by: "owner" });
  log.add("lanes.routed", {
    milestone: "M1",
    lanes: [{ lane: "M1.L1", rung: "codex:gpt-6-sol#medium", ladder: ["codex:gpt-6-sol#medium"] }],
  });
  log.add("preflight.done", {
    milestone: "M1",
    blocking: [{ lane: "M1.L1", note: "no docker" }],
    confirm: null,
    lint: [],
  });
  const id = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
  log.add("dispatch.refused", { name: "worker-M1.L2", unit: "M1.L2", code: "E_ALL_HELD", message: "held" });
  endDispatch(log, id, { name: "worker-M1.L1", unit: "M1.L1", findings: [finding] });
  log.add("check.ran", { lane: "M1.L1", exit: 1, tail: "boom", foreign: [] });
  log.add("commit.made", { milestone: "M1", round: 0, commit: "abc1234" });
  log.add("commit.failed", { milestone: "M1", round: 1, tail: "hook failed" });
  log.add("lane.climbed", { lane: "M1.L1", rung: "codex:gpt-6-sol#high", top: false });
  log.add("stop.classified", { dispatchId: id, reason: "needs_user" });
  log.add("judge.decided", {
    id: "9",
    unit: "M1.L1",
    kind: "question",
    decision: { verb: "answer", answer: "use v2" },
    dispatchId: id,
  });
  log.add("judge.failed", { id: "9", unit: "M1.L1", why: "unreadable" });
  log.add("question.parked", { unit: "M1", question: "which one?", reason: "confirm" });
  log.add("question.answered", { unit: "M1", answer: "this", by: "owner" });
  log.add("milestone.landed", {
    milestone: "M1",
    commit: "abc1234",
    knownIssues: [],
    digestPath: "digests/M1.md",
  });
  log.add("land.refused", { milestone: "M1", code: "E_LAND_GATE", message: "no reviewer", fix: "run it" });
  log.add("milestone.merged", { milestone: "M1" });
  log.add("base.behind", { milestone: "M1" });
  log.add("integrate.done", { milestone: "M1", commit: "def5678" });
  log.add("integrate.conflict", { milestone: "M1", files: ["a.ts"] });
  log.add("tree.ready", { milestone: "M1", tree: "/t/M1", branch: "t-m1", base: "main", hints: [] });
  log.add("tree.deferred", { milestone: "M2", availableMb: 3100, needMb: 5120 });
  log.add("branch.pushed", {
    milestone: "M1",
    branch: "t-m1",
    remote: "origin",
    mr: "gh pr create --base main",
  });
  log.add("cancel.requested", { by: "owner" });
  log.add("effect.failed", { action: "commit", unit: "M1", message: "boom" });
  log.add("report.posted", { kind: "landed", unit: "M1", text: "landed" });
  log.add("milestone.checked", {
    milestone: "M1",
    head: "abc1234",
    command: "bun test",
    missing: [],
    findings: [],
    uncovered: [],
    checkOnly: false,
    verdictCarried: false,
    startedAt: "2026-10-21T10:00:00.000Z",
    durationMs: 1200,
    waitedMs: 0,
  });
  log.add("lock.waiting", { unit: "M1.L1", lock: "heavy", holder: null, ahead: 1 });
  log.add("tick", {});
  log.add("run.ended", { outcome: "done", reportPath: "report.md" });
  return log.events;
}

describe("run events", () => {
  it("check.ran parses with and without tree", () => {
    const log = makeLog();
    const check = log.add("check.ran", { lane: "M1.L1", exit: 1, tail: "boom", foreign: [] });
    expect(RunEventSchema.parse(check)).toEqual(check);
    for (const tree of ["abc", null]) {
      expect(RunEventSchema.parse({ ...check, tree })).toEqual({ ...check, tree });
    }
    expect(RunEventSchema.safeParse({ ...check, tree: 3 }).success).toBe(false);
  });

  it("parses every event type, and refuses an unknown type or a newer v", () => {
    const all = oneOfEach();
    expect(new Set(all.map((e) => e.type)).size).toBe(all.length);
    for (const e of all) expect(RunEventSchema.parse(e)).toEqual(e);
    const first = all[0] as RunEvent;
    expect(RunEventSchema.safeParse({ ...first, type: "tock" }).success).toBe(false);
    expect(RunEventSchema.safeParse({ ...first, v: 2 }).success).toBe(false);
    expect(RunEventSchema.safeParse({ ...first, seq: 0 }).success).toBe(false);
  });

  it("describes each event in one line and never quotes a reply", () => {
    const log = makeLog();
    const id = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    const ended = endDispatch(log, id, {
      name: "worker-M1.L1",
      unit: "M1.L1",
      why: "line one\nsecret reply body",
    });
    expect(describeEvent(ended, () => "codex:gpt-6-sol#medium")).toBe(
      "worker-M1.L1 ended ok (complete) on codex:gpt-6-sol#medium",
    );
    expect(describeEvent(ended)).toBe("worker-M1.L1 ended ok (complete)");
    for (const e of oneOfEach()) {
      const line = describeEvent(e);
      expect(line.includes("\n")).toBe(false);
      expect(line.length).toBeGreaterThan(0);
    }
  });

  it("describes a milestone's worktree, a memory wait and a push (plan 35)", () => {
    const lines = oneOfEach().map((e) => describeEvent(e));
    expect(lines).toContain("M1 has its worktree on branch t-m1");
    expect(lines).toContain("M2 waits for memory: 3100 MB available, 5120 MB needed");
    expect(lines).toContain("M1's branch t-m1 is pushed to origin");
  });

  it("milestone.checked and lock.waiting parse and describe (plan 40)", () => {
    const log = makeLog();
    const green = log.add("milestone.checked", {
      milestone: "M1",
      head: "abc1234def",
      command: "bun test",
      missing: [],
      findings: [],
      uncovered: ["A1 it works"],
      checkOnly: true,
      verdictCarried: false,
      startedAt: "2026-10-21T10:00:00.000Z",
      durationMs: 1200,
      waitedMs: 300,
    });
    const waiting = log.add("lock.waiting", { unit: "M1.L1", lock: "heavy", holder: "M2.L2", ahead: 2 });
    expect(RunEventSchema.parse(green)).toEqual(green);
    expect(RunEventSchema.parse(waiting)).toEqual(waiting);
    expect(describeEvent(green)).toBe("M1 check passed at abc1234 (covers every A-line)");
    expect(describeEvent(waiting)).toBe("M1.L1 waits for the heavy lock, held by M2.L2 (2 ahead)");
    expect(describeEvent({ ...green, findings: [finding] })).toBe("M1 check failed at abc1234: 1 finding(s)");
    expect(describeEvent({ ...green, missing: ["test/x.test.ts:4"] })).toBe(
      "M1 check at abc1234: 1 line(s) with no baseline",
    );
    expect(describeEvent({ ...green, command: null, checkOnly: false })).toBe(
      "M1 has no check; its verifier gates it",
    );
    expect(describeEvent({ ...waiting, holder: null })).toBe("M1.L1 waits for the heavy lock (2 ahead)");
  });

  it("parses a disk deferral and the timings of a check (plan 40)", () => {
    const log = makeLog();
    const disk = log.add("tree.deferred", {
      milestone: "M2",
      availableMb: 1024,
      needMb: 4096,
      resource: "disk",
    });
    expect(RunEventSchema.parse(disk)).toEqual(disk);
    expect(describeEvent(disk)).toBe("M2 waits for disk: 1024 MB available, 4096 MB needed");
    const ran = log.add("check.ran", {
      lane: "M1.L1",
      exit: 0,
      tail: "",
      foreign: [],
      startedAt: "2026-10-21T10:00:00.000Z",
      durationMs: 900,
      waitedMs: 0,
    });
    expect(RunEventSchema.parse(ran)).toEqual(ran);
  });

  it("reads a preflight.done without lint as no lint, and counts lint in its line (plan 34)", () => {
    const base = {
      v: 1,
      seq: 1,
      at: "2026-10-21T10:00:00.000Z",
      type: "preflight.done",
      milestone: "M1",
      blocking: [],
      confirm: null,
    };
    const old = RunEventSchema.parse(base);
    if (old.type !== "preflight.done") throw new Error("unexpected");
    expect(old.lint).toEqual([]);
    expect(describeEvent(old)).toBe("M1 preflight passed");
    const withLint = RunEventSchema.parse({ ...base, lint: ["a", "b"] });
    expect(describeEvent(withLint)).toBe("M1 preflight passed · 2 lint warning(s)");
  });
});
