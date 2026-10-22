import { describe, expect, it } from "bun:test";
import { describeEvent, type RunEvent } from "../../src/domain/run-events.ts";
import { type Action, next } from "../../src/domain/run-machine.ts";
import { endDispatch, type Log, runningLog, startDispatch } from "./run-fixtures.ts";

const of = <T extends Action["type"]>(as: Action[], type: T): Extract<Action, { type: T }>[] =>
  as.filter((a): a is Extract<Action, { type: T }> => a.type === type);
const last = (log: Log): Action[] => next(log.state(), log.events.at(-1) as RunEvent);

describe("per-run pause", () => {
  it("a paused run issues no dispatch or judge, and the resume issues them at once", () => {
    const log = runningLog();
    expect(of(last(log), "dispatch").map((a) => a.name)).toContain("worker-M1.L1");
    log.add("run.paused", { by: "owner" });
    expect(log.state().paused).toBe(log.events.at(-1)?.at as string);
    expect(last(log).filter((a) => a.type === "dispatch" || a.type === "judge")).toEqual([]);
    log.add("run.resumed", { by: "owner" });
    expect(log.state().paused).toBeNull();
    expect(of(last(log), "dispatch").map((a) => a.name)).toContain("worker-M1.L1");
  });

  it("a pause lets a live role finish and its check and commit run", () => {
    const log = runningLog();
    const id = startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    log.add("run.paused", { by: "owner" });
    endDispatch(log, id, { name: "worker-M1.L1", unit: "M1.L1" });
    expect(of(last(log), "fastCheck").map((a) => a.lane)).toEqual(["M1.L1"]);
  });

  it("cancel works while paused", () => {
    const log = runningLog();
    startDispatch(log, { name: "worker-M1.L1", unit: "M1.L1" });
    log.add("run.paused", { by: "owner" });
    log.add("cancel.requested", { by: "owner" });
    expect(last(log).map((a) => a.type)).toEqual(["cancel"]);
  });

  it("a pause is described in one line", () => {
    const log = runningLog();
    expect(describeEvent(log.add("run.paused", { by: "owner" }))).toBe("run paused by the owner");
    expect(describeEvent(log.add("run.resumed", { by: "owner" }))).toBe("run resumed by the owner");
  });
});
