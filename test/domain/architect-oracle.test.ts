import { describe, expect, it } from "bun:test";
import { heldOracles, oracleOverrides } from "../../src/domain/architect-state.ts";
import { describeEvent } from "../../src/domain/run-events.ts";
import { endDispatch, makeLog, startDispatch, startedFields } from "./run-fixtures.ts";

const ORACLE = { paths: ["test/pay.test.ts"], diff: "tasks/T1/oracle.diff" };

function worked(by = "architect-1", oracle: typeof ORACLE | null = ORACLE) {
  const log = makeLog();
  log.add("run.started", startedFields);
  log.add("task.delegated", {
    taskId: "T1",
    role: "worker",
    rung: "codex:gpt-6-sol#high",
    thread: null,
    ledgerTask: "L1",
    by,
    why: "pay",
    snapshot: "a".repeat(40),
  });
  const id = startDispatch(log, { name: "T1", unit: "T1" });
  endDispatch(log, id, { name: "T1", unit: "T1", ...(oracle ? { oracle } : {}) });
  return log;
}

describe("the oracle rule (plan 54, spec D9)", () => {
  it("holds a task whose writer changed its oracle, and says so in a digest line that wakes the architect", () => {
    const s = worked("T9").state();
    expect(heldOracles(s.arch).map((t) => t.taskId)).toEqual(["T1"]);
    const item = s.arch.inbox.findLast((i) => i.taskId === "T1");
    expect(item?.wakes).toBe(true);
    expect(item?.text).toContain(
      "HELD: it changed test/pay.test.ts, the oracle of ledger L1 (diff tasks/T1/oracle.diff): accept it with oracle_accept and a reason, or send the task back to restore it; land final waits for one or the other",
    );
  });

  it("releases a hold the architect accepts, and lists the override with its reason", () => {
    const log = worked();
    const e = log.add("oracle.accepted", {
      taskId: "T1",
      by: "architect-2",
      why: "the test asserted the old fee",
    });
    const s = log.state();
    expect(heldOracles(s.arch)).toEqual([]);
    expect(oracleOverrides(s.arch)).toEqual([
      "T1 (L1) changed test/pay.test.ts: the test asserted the old fee",
    ]);
    expect(describeEvent(e)).toBe("architect-2 accepted T1's oracle change: the test asserted the old fee");
  });

  it("holds nothing when the oracle was left alone", () => {
    const s = worked("architect-1", null).state();
    expect(heldOracles(s.arch)).toEqual([]);
    expect(s.arch.inbox.find((i) => i.taskId === "T1")?.text).not.toContain("HELD");
  });
});
