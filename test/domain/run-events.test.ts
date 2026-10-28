import { describe, expect, it } from "bun:test";
import { describeEvent, EVENTS_SCHEMA, RunEventSchema, type RunEvent } from "../../src/domain/run-events.ts";
import { endDispatch, makeLog, startDispatch, startedFields } from "./run-fixtures.ts";

const finding = { label: "BUG" as const, text: "BUG src/a.ts:3 — x — y", file: "src/a.ts" };
const why = "the wallet needs a test first";

/** one fixture per member of the union */
function oneOfEach(): RunEvent[] {
  const log = makeLog();
  log.add("run.started", startedFields);
  log.add("daemon.started", { pid: 1, version: "2.0.0" });
  const id = startDispatch(log, { name: "T1", unit: "T1" });
  log.add("dispatch.refused", { name: "T2", unit: "T2", code: "E_RUNG_HELD", message: "held" });
  endDispatch(log, id, { name: "T1", unit: "T1", findings: [finding] });
  log.add("pause.lifted", {});
  log.add("question.parked", { unit: "run", question: "deploy?", reason: "owner", why });
  log.add("question.reminded", { unit: "run", n: 1 });
  log.add("question.answered", { unit: "run", answer: "yes", by: "owner" });
  log.add("run.paused", { by: "owner" });
  log.add("run.resumed", { by: "owner" });
  log.add("cancel.requested", { by: "owner" });
  log.add("effect.failed", { action: "runCheck", unit: "C1", message: "boom" });
  log.add("report.posted", { kind: "parked", unit: "run", text: "parked" });
  log.add("lock.waiting", { unit: "C1", lock: "heavy", holder: null, ahead: 1 });
  log.add("tick", {});
  log.add("task.delegated", {
    taskId: "T1",
    role: "worker",
    rung: "codex:gpt-6-sol#high",
    thread: null,
    ledgerTask: "L1",
    by: "architect-1",
    why,
  });
  log.add("task.cancelled", { taskId: "T1", by: "architect-1", why });
  log.add("task.read", { taskId: "T1" });
  log.add("check.requested", {
    checkId: "C1",
    command: "bun test",
    scope: "full",
    base: false,
    fresh: false,
    by: "architect-1",
    why,
  });
  log.add("check.done", {
    checkId: "C1",
    exit: 1,
    failures: ["(fail) a"],
    preExisting: [],
    cached: false,
    minutes: 1,
    logPath: "checks/C1.log",
  });
  log.add("ledger.changed", { tasks: ["L1"], progress: true, by: "architect-1", why });
  log.add("thread.sent", { to: "T1", n: 3, delivery: "queued", by: "architect-1", why });
  log.add("run.finishing", { verdict: "done", by: "architect-1", why });
  log.add("run.ended", { outcome: "done", reportPath: "report.md" });
  return log.events;
}

describe("run events (plan 48: the reducer's vocabulary, spec D4)", () => {
  it("parses every event type, and refuses an unknown type or a newer v", () => {
    const all = oneOfEach();
    expect(new Set(all.map((e) => e.type)).size).toBe(all.length);
    for (const e of all) expect(RunEventSchema.parse(e)).toEqual(e);
    const first = all[0] as RunEvent;
    expect(RunEventSchema.safeParse({ ...first, type: "tock" }).success).toBe(false);
    expect(RunEventSchema.safeParse({ ...first, v: EVENTS_SCHEMA + 1 }).success).toBe(false);
    expect(RunEventSchema.safeParse({ ...first, seq: 0 }).success).toBe(false);
  });

  it("describes each event in one line and never quotes a reply", () => {
    const log = makeLog();
    const id = startDispatch(log, { name: "T1", unit: "T1" });
    const ended = endDispatch(log, id, { name: "T1", unit: "T1", why: "line one\nsecret reply body" });
    expect(describeEvent(ended, () => "codex:gpt-6-sol#medium")).toBe(
      "T1 ended ok (complete) on codex:gpt-6-sol#medium",
    );
    expect(describeEvent(ended)).toBe("T1 ended ok (complete)");
    for (const e of oneOfEach()) {
      const line = describeEvent(e);
      expect(line.includes("\n")).toBe(false);
      expect(line.length).toBeGreaterThan(0);
    }
    const delegated = oneOfEach().find((e) => e.type === "task.delegated") as RunEvent;
    expect(describeEvent(delegated)).toBe(
      `architect-1 delegated T1 to the worker on codex:gpt-6-sol#high: ${why}`,
    );
  });

  it("still parses an earlier build's run.started, whose engine it ignores, and drops the pipeline's events (D16)", () => {
    const old = makeLog(undefined, 1);
    const started = old.add("run.started", { ...startedFields, engine: "2.0" });
    expect(RunEventSchema.parse(started)).toMatchObject({ v: 1, engine: "2.0" });
    for (const gone of ["plan.ready", "plan.approved", "milestone.landed", "judge.decided", "decision.made"])
      expect(RunEventSchema.safeParse({ v: 1, seq: 2, at: started.at, type: gone }).success).toBe(false);
    expect(RunEventSchema.safeParse({ ...started, engine: "3.0" }).success).toBe(false);
  });
});

describe("an earlier run's ui-reviewer (plan 51, spec D16)", () => {
  it("reads its dispatch and its task as the reviewer's", () => {
    const base = { v: EVENTS_SCHEMA, seq: 2, at: "2026-10-27T10:00:00.000Z" };
    const started = RunEventSchema.parse({
      ...base,
      type: "dispatch.started",
      dispatchId: "D1",
      name: "T3",
      role: "ui-reviewer",
      unit: "T3",
      lane: null,
      rung: "codex:gpt-6-sol#medium",
      thread: null,
    });
    expect(started).toMatchObject({ role: "reviewer" });
    const delegated = RunEventSchema.parse({
      ...base,
      type: "task.delegated",
      taskId: "T3",
      role: "ui-reviewer",
      rung: "codex:gpt-6-sol#medium",
      thread: null,
      ledgerTask: null,
      by: "architect-1",
      why: "screens",
    });
    expect(delegated).toMatchObject({ role: "reviewer" });
  });
});
