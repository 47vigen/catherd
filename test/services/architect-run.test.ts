import { describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DispatchAction } from "../../src/domain/run-machine.ts";
import { taskBrief, wakeBrief, writeArchitectReport } from "../../src/services/architect-run.ts";
import { writeLedger } from "../../src/services/ledger-store.ts";
import { PLAN_INPUT_DIR } from "../../src/services/plan-input.ts";
import { endDispatch, makeLog, newId, startDispatch, startedFields } from "../domain/run-fixtures.ts";
import { freshRun } from "./helpers.ts";

const wake = (o: Partial<DispatchAction> = {}): DispatchAction => ({
  type: "dispatch",
  unit: "run",
  name: "architect-1",
  role: "architect",
  lane: null,
  rung: null,
  thread: null,
  failoverFrom: null,
  brief: "wake",
  notes: [],
  ...o,
});

describe("the architect's briefs (plan 47, spec D1 and D12)", () => {
  it("first turn: the goal, the plan files as input, the plan lint once, the digest and the slots last", () => {
    const { run } = freshRun();
    mkdirSync(join(run.dir, PLAN_INPUT_DIR), { recursive: true });
    writeFileSync(join(run.dir, PLAN_INPUT_DIR, "PLAN.md"), "# P\n\n## M1 — core\n\nno check here\n");
    const log = makeLog();
    log.add("run.started", { ...startedFields, plan: ["/repo/PLAN.md"] });
    const { unit, round } = wakeBrief(run, log.state(), wake({ upTo: 1 }));
    expect(unit.join("\n")).toContain("The run's goal: wallet.");
    expect(unit.join("\n")).toContain("plan-input/PLAN.md");
    expect(unit.join("\n")).toContain("PLAN.md: M1: no Check: line");
    expect(round).toEqual([
      "What happened since your last turn:\n- #1 the run started: wallet",
      "Writers running: 0 of 4. Standing roles (researcher, writer) running: 0 of 4. Tasks queued: 0. Checks queued or running: 0.",
    ]);
  });

  it("a fresh thread after a turn says why and to check the ledger against git; only events up to upTo", () => {
    const { run } = freshRun();
    const log = makeLog();
    log.add("run.started", { ...startedFields });
    const a1 = newId();
    log.add("dispatch.started", {
      dispatchId: a1,
      name: "architect-1",
      role: "architect",
      unit: "run",
      lane: null,
      rung: "codex:m#high",
      thread: null,
      upTo: 1,
    });
    log.add("check.requested", {
      checkId: "C1",
      command: "true",
      scope: "full",
      base: false,
      fresh: false,
      by: "architect-1",
      why: "w",
    });
    log.add("check.done", {
      checkId: "C1",
      exit: 0,
      failures: [],
      preExisting: [],
      cached: false,
      minutes: 0,
      logPath: "checks/C1.log",
    });
    log.add("check.requested", {
      checkId: "C2",
      command: "true",
      scope: "full",
      base: false,
      fresh: false,
      by: "architect-1",
      why: "w",
    });
    log.add("check.done", {
      checkId: "C2",
      exit: 0,
      failures: [],
      preExisting: [],
      cached: true,
      minutes: 0,
      logPath: "checks/C2.log",
    });
    const { round } = wakeBrief(
      run,
      log.state(),
      wake({ name: "architect-2", notes: ["the daemon restarted"], upTo: 4 }),
    );
    expect(round[0]).toBe(
      "This is a fresh thread (the daemon restarted): read the ledger, then compare it with git log and the tree before you act.",
    );
    expect(round[1]).toContain("C1 (full) passed");
    expect(round[1]).not.toContain("C2");
  });

  it("a researcher task writes its answer to research/<id>.md; a worker reports each file with its reason", () => {
    const { run } = freshRun();
    const log = makeLog();
    log.add("run.started", { ...startedFields });
    log.add("task.delegated", {
      taskId: "T1",
      role: "researcher",
      rung: "codex:m#high",
      thread: null,
      ledgerTask: null,
      by: "T0",
      why: "w",
    });
    const t = (name: string) =>
      taskBrief(run, log.state(), { ...wake(), name, unit: name, role: "researcher", brief: "task" });
    expect(t("T1").round.join("\n")).toContain(`catherd run-file write ${run.id} research/T1.md`);
    expect(t("T1").round[0]).toBe(
      "You are task T1, a researcher delegated by T0. You have no lane file: this task is your whole brief.",
    );
    expect(t("T9").round.join("\n")).toContain("EXTRA: <path> — <why>");
  });
});

describe("a task's fast check in its brief (plan 53)", () => {
  it("names the check catherd runs when the task ends complete, and nothing without one", () => {
    const { run } = freshRun();
    const log = makeLog();
    log.add("run.started", { ...startedFields });
    const task = {
      role: "worker",
      rung: "codex:m#high",
      thread: null,
      ledgerTask: null,
      by: "architect-1",
      why: "w",
    };
    log.add("task.delegated", { ...task, taskId: "T1", check: "bun test test/a.test.ts" } as never);
    log.add("task.delegated", { ...task, taskId: "T2" } as never);
    const t = (name: string) =>
      taskBrief(run, log.state(), { ...wake(), name, unit: name, role: "worker", brief: "task" }).round.join(
        "\n",
      );
    expect(t("T1")).toContain(
      "Your fast check: `bun test test/a.test.ts`. catherd runs it on the run's tree when you end complete",
    );
    expect(t("T2")).not.toContain("fast check");
  });

  it("tells a task in its own tree its branch, that catherd commits and merges it, and where its check runs (plan 55)", () => {
    const { run } = freshRun("wallet");
    const log = makeLog();
    log.add("run.started", { ...startedFields, base: "main", trees: "writer" });
    log.add("task.delegated", {
      taskId: "T1",
      role: "worker",
      rung: "codex:m#high",
      thread: null,
      ledgerTask: null,
      by: "architect-1",
      why: "w",
      check: "bun test a",
      tree: "T1",
    });
    const brief = taskBrief(run, log.state(), {
      ...wake(),
      name: "T1",
      unit: "T1",
      role: "worker",
      brief: "task",
    }).round.join("\n");
    expect(brief).toContain(`on branch \`catherd/${run.id}/T1\`, cut from the run's branch \`wallet\``);
    expect(brief).toContain("Leave your work uncommitted: when you end complete, catherd commits it");
    expect(brief).toContain(
      "catherd runs it in your tree, merged with the run's branch, when you end complete",
    );
  });
});

describe("the architect run's report (plan 48)", () => {
  it("lists each ledger task's attempts and the why of every ask_owner", async () => {
    const { run } = freshRun();
    writeLedger(run, { tasks: { add: [{ id: "L1", goal: "the parser" }] } }, new Date());
    const log = makeLog();
    log.add("run.started", startedFields);
    log.add("task.delegated", {
      taskId: "T1",
      role: "worker",
      rung: "codex:gpt-6-sol#high",
      thread: null,
      ledgerTask: "L1",
      by: "architect-1",
      why: "w",
    });
    const id = startDispatch(log, { name: "T1", unit: "T1" });
    endDispatch(log, id, { name: "T1", unit: "T1", replyStatus: "blocked", reason: "impossible" });
    log.add("question.parked", {
      unit: "run",
      question: "drop L1?",
      reason: "owner",
      why: "L1 cannot be done",
    });
    const report = readFileSync(writeArchitectReport(run, log.state(), log.events), "utf8");
    expect(report).toContain("- L1 [todo] the parser (1 attempt)");
    expect(report).toContain("question.parked (architect): L1 cannot be done");
  });
});
