import { describe, expect, it } from "bun:test";
import { architectNext } from "../../src/domain/architect-machine.ts";
import { STANDING_CAP, WRITER_CAP } from "../../src/domain/architect-state.ts";
import type { Role } from "../../src/domain/roles.ts";
import type { Action } from "../../src/domain/run-machine.ts";
import { endDispatch, type Log, makeLog, newId, startDispatch, startedFields } from "./run-fixtures.ts";

const RUNG = "codex:gpt-6-sol#high";

function architectRun(): Log {
  const log = makeLog();
  log.add("run.started", { ...startedFields, engine: "architect" });
  return log;
}

/** An architect turn starts, covering the digest up to the last event. */
function turn(log: Log, n: number, thread: string | null = null): string {
  const dispatchId = newId();
  log.add("dispatch.started", {
    dispatchId,
    name: `architect-${n}`,
    role: "architect",
    unit: "run",
    lane: null,
    rung: "claude-code:claude-opus-5-5#high",
    thread,
    upTo: log.events.at(-1)?.seq ?? 0,
  });
  return dispatchId;
}

function delegate(log: Log, taskId: string, role: Role = "worker", by = "architect-1"): void {
  log.add("task.delegated", {
    taskId,
    role,
    rung: RUNG,
    thread: null,
    ledgerTask: null,
    by,
    why: `do ${taskId}`,
  });
}

/** The actions after the last event. */
function after(log: Log): Action[] {
  return architectNext(log.state(), log.events.at(-1) as never);
}

const names = (actions: Action[]) => actions.flatMap((a) => (a.type === "dispatch" ? [a.name] : []));
const wakeOf = (actions: Action[]) =>
  actions.find((a) => a.type === "dispatch" && a.role === "architect") as
    | Extract<Action, { type: "dispatch" }>
    | undefined;

describe("the architect engine's machine (plan 47, spec D1 and D4)", () => {
  it("wakes the architect at the start, on a fresh thread, with the digest up to the start", () => {
    const log = architectRun();
    expect(log.state()).toMatchObject({ engine: "architect", phase: "running" });
    expect(wakeOf(after(log))).toMatchObject({
      name: "architect-1",
      brief: "wake",
      thread: null,
      rung: null,
      upTo: 1,
    });
  });

  it("starts what the architect delegated within the writer and standing-role caps, and never wakes it mid-turn", () => {
    const log = architectRun();
    turn(log, 1);
    for (let i = 1; i <= 5; i++) delegate(log, `T${i}`);
    for (let i = 6; i <= 10; i++) delegate(log, `T${i}`, "researcher");
    const started = names(after(log));
    expect(started).toEqual(["T1", "T2", "T3", "T4", "T6", "T7", "T8", "T9"]);
    expect(started.length).toBe(WRITER_CAP + STANDING_CAP);
    expect(after(log).find((a) => a.type === "dispatch")).toMatchObject({
      unit: "T1",
      lane: null,
      brief: "task",
      rung: RUNG,
    });
  });

  it("queues what happens during a turn and wakes it once the turn ends, on its own thread", () => {
    const log = architectRun();
    const a1 = turn(log, 1);
    delegate(log, "T1");
    const t1 = startDispatch(log, { name: "T1", unit: "T1", lane: null, rung: RUNG });
    endDispatch(log, a1, { name: "architect-1", unit: "run", thread: "th-a" });
    expect(wakeOf(after(log))).toBeUndefined();
    const end = endDispatch(log, t1, { name: "T1", unit: "T1", why: "wallet written" });
    expect(wakeOf(after(log))).toMatchObject({ name: "architect-2", thread: "th-a", upTo: end.seq });
    expect(log.state().arch?.inbox.map((i) => i.text)).toEqual([
      `T1 (worker) ended ok/complete: wallet written; reply ${end.replyPath}`,
    ]);
    turn(log, 2, "th-a");
    expect(log.state().arch?.inbox).toEqual([]);
  });

  it("names a worker's standing-role task in the next digest without waking the architect", () => {
    const log = architectRun();
    const a1 = turn(log, 1);
    delegate(log, "T1");
    const t1 = startDispatch(log, { name: "T1", unit: "T1", lane: null, rung: RUNG });
    endDispatch(log, a1, { name: "architect-1", unit: "run", thread: "th-a" });
    delegate(log, "T2", "researcher", "T1");
    const t2 = startDispatch(log, { name: "T2", unit: "T2", role: "researcher", lane: null, rung: RUNG });
    endDispatch(log, t2, { name: "T2", unit: "T2" });
    expect(wakeOf(after(log))).toBeUndefined();
    expect(log.state().arch?.inbox.map((i) => i.wakes)).toEqual([false, false]);
    endDispatch(log, t1, { name: "T1", unit: "T1" });
    expect(wakeOf(after(log))).toBeDefined();
  });

  it("wakes once when nothing runs, and stops the run when the next turn starts nothing either", () => {
    const log = architectRun();
    endDispatch(log, turn(log, 1), { name: "architect-1", unit: "run", thread: "th-a" });
    expect(log.state().arch?.inbox.at(-1)?.text).toStartWith("idle:");
    expect(wakeOf(after(log))).toMatchObject({ name: "architect-2" });
    endDispatch(log, turn(log, 2, "th-a"), { name: "architect-2", unit: "run", thread: "th-a" });
    expect(after(log)).toContainEqual({ type: "finish", outcome: "failed" });
  });

  it("two idle turns in a row stop the run even when each writes a progress ledger entry", () => {
    const log = architectRun();
    const progress = () =>
      log.add("ledger.changed", { tasks: [], progress: true, by: "architect", why: "progress" });
    const a1 = turn(log, 1);
    progress();
    endDispatch(log, a1, { name: "architect-1", unit: "run", thread: "th-a" });
    expect(wakeOf(after(log))).toMatchObject({ name: "architect-2" });
    const a2 = turn(log, 2, "th-a");
    progress();
    endDispatch(log, a2, { name: "architect-2", unit: "run", thread: "th-a" });
    expect(after(log)).toContainEqual({ type: "finish", outcome: "failed" });
  });

  it("an idle turn between busy turns does not count: idle turns must be consecutive", () => {
    const log = architectRun();
    endDispatch(log, turn(log, 1), { name: "architect-1", unit: "run", thread: "th-a" });
    const a2 = turn(log, 2, "th-a");
    log.add("effect.failed", { action: "runCheck", unit: "C9", message: "boom" });
    endDispatch(log, a2, { name: "architect-2", unit: "run", thread: "th-a" });
    expect(log.state().arch?.idle).toBe(0);
  });

  it("a task cancelled while queued stays cancelled when its dispatch starts, and the dispatch is stopped", () => {
    const log = architectRun();
    turn(log, 1);
    delegate(log, "T1");
    log.add("task.cancelled", { taskId: "T1", by: "architect-1", why: "not needed" });
    const t1 = startDispatch(log, { name: "T1", unit: "T1", lane: null, rung: RUNG });
    expect(log.state().arch?.tasks.T1).toMatchObject({ state: "cancelled", dispatchId: t1 });
    expect(after(log)).toContainEqual({ type: "cancel", dispatchIds: [t1] });
    for (let i = 2; i <= 5; i++) delegate(log, `T${i}`);
    expect(names(after(log))).toEqual(["T2", "T3", "T4", "T5"]);
  });

  it("starts a fresh thread after a failed turn or a daemon restart, and stops after three failed turns", () => {
    const log = architectRun();
    endDispatch(log, turn(log, 1), { name: "architect-1", unit: "run", status: "timeout", thread: "th-a" });
    expect(wakeOf(after(log))).toMatchObject({ thread: null, notes: ["your last turn ended timeout"] });
    const a2 = turn(log, 2);
    delegate(log, "T1", "worker", "architect-2");
    endDispatch(log, a2, { name: "architect-2", unit: "run", thread: "th-b" });
    log.add("daemon.started", { pid: 1, version: "t" });
    expect(log.state().arch?.fresh).toBe("the daemon restarted");
    for (const n of [3, 4, 5])
      endDispatch(log, turn(log, n), { name: `architect-${n}`, unit: "run", status: "failed" });
    expect(after(log)).toContainEqual({ type: "finish", outcome: "failed" });
  });

  it("runs a requested check and wakes the architect with its result", () => {
    const log = architectRun();
    const a1 = turn(log, 1);
    log.add("check.requested", {
      checkId: "C1",
      command: "bun test",
      scope: "full",
      base: false,
      fresh: false,
      by: "architect-1",
      why: "w",
    });
    expect(after(log)).toContainEqual({ type: "runCheck", checkId: "C1" });
    endDispatch(log, a1, { name: "architect-1", unit: "run", thread: "th-a" });
    expect(wakeOf(after(log))).toBeUndefined();
    log.add("check.done", {
      checkId: "C1",
      exit: 1,
      failures: ["(fail) a"],
      preExisting: [],
      cached: false,
      minutes: 1,
      logPath: "checks/C1.log",
    });
    expect(after(log)).not.toContainEqual({ type: "runCheck", checkId: "C1" });
    expect(wakeOf(after(log))).toBeDefined();
  });

  it("finishing stops the tasks still running, then ends the run with the verdict's outcome", () => {
    const log = architectRun();
    const a1 = turn(log, 1);
    delegate(log, "T1");
    const t1 = startDispatch(log, { name: "T1", unit: "T1", lane: null, rung: RUNG });
    log.add("run.finishing", { verdict: "done", by: "architect-1", why: "shipped" });
    expect(after(log)).toContainEqual({ type: "cancel", dispatchIds: [t1] });
    endDispatch(log, t1, { name: "T1", unit: "T1", status: "cancelled" });
    expect(after(log)).toContainEqual({ type: "finish", outcome: "done" });
    endDispatch(log, a1, { name: "architect-1", unit: "run" });
    expect(wakeOf(after(log))).toBeUndefined();
  });

  it("an owner's cancel stops every role, the architect's turn included, then ends cancelled", () => {
    const log = architectRun();
    const a1 = turn(log, 1);
    log.add("cancel.requested", { by: "owner" });
    expect(after(log)).toContainEqual({ type: "cancel", dispatchIds: [a1] });
    endDispatch(log, a1, { name: "architect-1", unit: "run", status: "cancelled" });
    expect(after(log)).toContainEqual({ type: "finish", outcome: "cancelled" });
  });

  it("a pause holds new tasks and turns; reading a finished task drops its digest line", () => {
    const log = architectRun();
    const a1 = turn(log, 1);
    delegate(log, "T1");
    log.add("run.paused", { by: "owner" });
    expect(names(after(log))).toEqual([]);
    log.add("run.resumed", { by: "owner" });
    const t1 = startDispatch(log, { name: "T1", unit: "T1", lane: null, rung: RUNG });
    endDispatch(log, t1, { name: "T1", unit: "T1" });
    log.add("task.read", { taskId: "T1" });
    endDispatch(log, a1, { name: "architect-1", unit: "run" });
    expect(log.state().arch?.inbox.some((i) => i.taskId === "T1")).toBe(false);
  });

  it("an owner's answer wakes the architect; a 2.0 run has no architect state", () => {
    const log = architectRun();
    const a1 = turn(log, 1);
    log.add("question.parked", { unit: "run", question: "deploy to production?", reason: "owner", why: "w" });
    endDispatch(log, a1, { name: "architect-1", unit: "run", thread: "th-a" });
    expect(wakeOf(after(log))).toBeUndefined();
    log.add("question.answered", { unit: "run", answer: "no", by: "owner" });
    expect(log.state().questions).toEqual({});
    expect(wakeOf(after(log))).toBeDefined();
    const old = makeLog();
    old.add("run.started", startedFields);
    expect(old.state()).toMatchObject({ engine: "2.0", arch: null, phase: "planning" });
  });
});
