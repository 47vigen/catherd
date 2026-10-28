import { describe, expect, it } from "bun:test";
import { architectNext } from "../../src/domain/architect-machine.ts";
import { stalled } from "../../src/domain/architect-state.ts";
import { CAP_GRACE_MS, DEFAULT_CAPS } from "../../src/domain/caps.ts";
import { parseBlockedReason } from "../../src/domain/blocked.ts";
import type { Action } from "../../src/domain/run-machine.ts";
import { endDispatch, type Log, makeLog, START, startDispatch, startedFields } from "./run-fixtures.ts";

const RUNG = "codex:gpt-6-sol#high";
const MIN = 60_000;
const at = (ms: number): string => new Date(Date.parse(START) + ms).toISOString();

/** A run whose wall cap is `wallMin` minutes, started at START. */
function capped(wallMin: number): Log {
  const log = makeLog();
  log.add("run.started", { ...startedFields, caps: { wallMin, attempts: 4 } }, START);
  return log;
}

function delegate(log: Log, taskId: string, ledgerTask: string | null = null, rung = RUNG): void {
  log.add("task.delegated", {
    taskId,
    role: "worker",
    rung,
    thread: null,
    ledgerTask,
    by: "architect-1",
    why: "w",
  });
}

const after = (log: Log): Action[] => architectNext(log.state(), log.events.at(-1) as never);
const started = (actions: Action[]) => actions.flatMap((a) => (a.type === "dispatch" ? [a.name] : []));
const inbox = (log: Log) => log.state().arch.inbox.map((i) => i.text);

describe("spec D10: the wall cap", () => {
  it("pins the profile's caps, D10's defaults when the run names none", () => {
    expect(capped(60).state().caps).toEqual({ wallMin: 60, attempts: 4 });
    const plain = makeLog();
    plain.add("run.started", startedFields);
    expect(plain.state().caps).toEqual(DEFAULT_CAPS);
    expect(DEFAULT_CAPS).toEqual({ wallMin: 720, attempts: 4 });
  });

  it("wakes the architect at 80%, starts no new task at 100%, and stops the run after the grace", () => {
    const log = capped(100);
    expect(log.state().wakeAt).toBe(at(80 * MIN));
    log.add("tick", {}, at(80 * MIN));
    expect(inbox(log).at(-1)).toContain("80% of the run's wall time");
    expect(log.state().wakeAt).toBe(at(100 * MIN));
    log.add("tick", {}, at(100 * MIN));
    expect(inbox(log).at(-1)).toContain("is spent. No new task starts");
    delegate(log, "T1");
    const capActions = after(log);
    expect(started(capActions)).toEqual(["architect-1"]);
    log.add("tick", {}, at(100 * MIN + CAP_GRACE_MS));
    expect(log.state().arch.finishing).toMatchObject({
      verdict: "stopped",
      why: expect.stringContaining("cap"),
    });
    expect(after(log)).toContainEqual({ type: "finish", outcome: "failed" });
  });

  it("counts no paused time", () => {
    const log = capped(100);
    log.add("run.paused", { by: "owner" }, at(10 * MIN));
    expect(log.state().wakeAt).toBeNull();
    log.add("run.resumed", { by: "owner" }, at(70 * MIN));
    expect(log.state().wakeAt).toBe(at(140 * MIN));
    log.add("tick", {}, at(100 * MIN));
    expect(inbox(log).some((t) => t.includes("80%"))).toBe(false);
  });
});

describe("spec D10: stall and impossible", () => {
  it("a failed attempt with nothing new since stalls a retry on the same rung, not on another", () => {
    const log = capped(720);
    delegate(log, "T1", "L1");
    const id = startDispatch(log, { name: "T1", unit: "T1" });
    endDispatch(log, id, {
      name: "T1",
      unit: "T1",
      replyStatus: "blocked",
      reason: "too_hard",
      why: "the parser loops",
    });
    expect(stalled(log.state(), "L1", RUNG)?.taskId).toBe("T1");
    expect(stalled(log.state(), "L1", "codex:gpt-6-luna#high")).toBeNull();
    expect(stalled(log.state(), "L2", RUNG)).toBeNull();
    log.add("ledger.changed", { tasks: ["L1"], progress: false, by: "architect-2", why: "split the parser" });
    expect(stalled(log.state(), "L1", RUNG)).toBeNull();
  });

  it("only a ledger edit of that task lifts its stall: progress and another task's edit do not", () => {
    const log = capped(720);
    delegate(log, "T1", "L1");
    const id = startDispatch(log, { name: "T1", unit: "T1" });
    endDispatch(log, id, { name: "T1", unit: "T1", replyStatus: "blocked", why: "loops" });
    log.add("ledger.changed", { tasks: [], progress: true, by: "architect-2", why: "progress" });
    log.add("ledger.changed", { tasks: ["L2"], progress: false, by: "architect-2", why: "other task" });
    expect(stalled(log.state(), "L1", RUNG)?.taskId).toBe("T1");
    log.add("ledger.changed", { tasks: ["L1"], progress: false, by: "architect-2", why: "split it" });
    expect(stalled(log.state(), "L1", RUNG)).toBeNull();
  });

  it("a quota end is not a stall", () => {
    const log = capped(720);
    delegate(log, "T1", "L1");
    const id = startDispatch(log, { name: "T1", unit: "T1" });
    endDispatch(log, id, { name: "T1", unit: "T1", status: "limit", replyStatus: null, why: "quota" });
    expect(stalled(log.state(), "L1", RUNG)).toBeNull();
  });

  it("a clean end never stalls, and each end names its attempt against the cap", () => {
    const log = capped(720);
    delegate(log, "T1", "L1");
    const id = startDispatch(log, { name: "T1", unit: "T1" });
    endDispatch(log, id, { name: "T1", unit: "T1" });
    expect(stalled(log.state(), "L1", RUNG)).toBeNull();
    expect(inbox(log).at(-1)).toContain("attempt 1 of 4 on L1");
  });

  it("a worker may stop impossible, and the architect reads the reason", () => {
    expect(parseBlockedReason("impossible: the API has no such field")).toEqual({
      reason: "impossible",
      why: "the API has no such field",
    });
    const log = capped(720);
    delegate(log, "T1");
    const id = startDispatch(log, { name: "T1", unit: "T1" });
    endDispatch(log, id, {
      name: "T1",
      unit: "T1",
      replyStatus: "blocked",
      reason: "impossible",
      why: "no field",
    });
    expect(inbox(log).at(-1)).toContain("ended ok/blocked (impossible)");
  });
});
