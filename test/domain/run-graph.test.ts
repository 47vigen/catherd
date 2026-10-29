import { describe, expect, it } from "bun:test";
import type { RunRecord } from "../../src/domain/record.ts";
import { deriveRunModel, diffRunModel, type RunModel, RunModelSchema } from "../../src/domain/run-graph.ts";
import { endDispatch, type Log, makeLog, startDispatch, startedFields } from "./run-fixtures.ts";

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
const why = "it is next";

function started(): Log {
  const log = makeLog();
  log.add("run.started", startedFields);
  return log;
}
const delegate = (log: Log, taskId: string, role: "worker" | "reviewer" | "researcher" = "worker") =>
  log.add("task.delegated", {
    taskId,
    role,
    rung: "codex:gpt-6-sol#high",
    thread: null,
    ledgerTask: null,
    by: "architect-1",
    why,
  });

describe("the run model of an architect run (plan 48, spec D4)", () => {
  it("draws the start, the architect, each task and check it asked for, and the end, with the panel's kinds", () => {
    const log = started();
    const turn = startDispatch(log, { name: "architect-1", role: "architect", unit: "run" });
    delegate(log, "T1");
    delegate(log, "T2", "reviewer");
    log.add("check.requested", {
      checkId: "C1",
      command: "bun test",
      scope: "full",
      base: false,
      fresh: false,
      by: "architect-1",
      why,
    });
    const m = model(log);
    expect(ids(m)).toEqual(["start", "architect", "task/T1", "task/T2", "check/C1", "end"]);
    expect(node(m, "task/T1")).toMatchObject({ kind: "lane", lane: "T1", role: "worker", milestone: null });
    expect(node(m, "task/T2").kind).toBe("review");
    expect(node(m, "check/C1")).toMatchObject({ kind: "check", status: "running" });
    expect(node(m, "architect")).toMatchObject({ status: "running" });
    expect(node(m, "architect").attempts[0]).toMatchObject({ dispatchId: turn, label: "turn 1" });
    expect(m.edges).toContainEqual({ from: "architect", to: "task/T1" });
  });

  it("places a task's dispatch on its node, a check's result on the check, and an owner question on the task", () => {
    const log = started();
    delegate(log, "T1");
    const id = startDispatch(log, { name: "T1", unit: "T1" });
    expect(node(model(log), "task/T1").status).toBe("running");
    endDispatch(log, id, { name: "T1", unit: "T1" });
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
      minutes: 2,
      logPath: "checks/C1.log",
    });
    log.add("question.parked", { unit: "T1", question: "deploy it?", reason: "owner", why });
    const m = model(log);
    expect(node(m, "task/T1")).toMatchObject({ status: "parked", question: { unit: "T1" } });
    expect(node(m, "check/C1")).toMatchObject({ status: "failed" });
    expect(node(m, "check/C1").attempts[0]).toMatchObject({ kind: "check", exit: 1, secs: 120 });
  });

  it("draws a check whose every failure the base has too as passed, as land counts it (plan 52)", () => {
    const log = started();
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
      preExisting: ["(fail) a"],
      cached: false,
      minutes: 2,
      logPath: "checks/C1.log",
      verdict: "inherited",
    });
    const c = node(model(log), "check/C1");
    expect(c.status).toBe("done");
    expect(c.attempts[0]).toMatchObject({ label: "passed (inherited failures)", exit: 1 });
    expect(c.attempts[0]?.text).toContain("passed but for failures the base has too");
  });

  it("an ended run closes the architect and skips what never started", () => {
    const log = started();
    delegate(log, "T1");
    log.add("task.cancelled", { taskId: "T1", by: "architect-1", why });
    log.add("run.ended", { outcome: "done", reportPath: "report.md" });
    const m = model(log);
    expect(node(m, "end").status).toBe("done");
    expect(node(m, "architect").status).toBe("done");
    expect(node(m, "task/T1").status).toBe("cancelled");
  });
});

describe("diffRunModel", () => {
  it("returns only what changed, and the edges when they change", () => {
    const log = started();
    delegate(log, "T1");
    const a = model(log);
    const id = startDispatch(log, { name: "T1", unit: "T1" });
    const b = model(log);
    const patch = diffRunModel(a, b);
    expect(patch.nodes.map((n) => n.id)).toEqual(["task/T1"]);
    expect(patch.edges).toBeNull();
    expect(patch.removed).toEqual([]);
    endDispatch(log, id, { name: "T1", unit: "T1" });
    delegate(log, "T2");
    const c = model(log);
    expect(diffRunModel(b, c).edges).toEqual(c.edges);
  });
});
