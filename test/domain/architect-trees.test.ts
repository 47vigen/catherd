import { describe, expect, it } from "bun:test";
import { architectNext } from "../../src/domain/architect-machine.ts";
import { continuedTree, fastCheckFor, mergeFor, treeBusy } from "../../src/domain/architect-state.ts";
import type { Action } from "../../src/domain/run-machine.ts";
import { describeEvent } from "../../src/domain/run-events.ts";
import { endDispatch, type Log, makeLog, startDispatch, startedFields } from "./run-fixtures.ts";

const RUNG = "codex:gpt-6-sol#high";
const ok = { status: "ok", replyStatus: "complete" };

function treesRun(): Log {
  const log = makeLog();
  log.add("run.started", { ...startedFields, base: "main", trees: "writer" });
  return log;
}

/** A worker task delegated into `tree` (its own id for a new tree, absent for the run's tree), and started. */
function work(
  log: Log,
  taskId: string,
  o: { tree?: string; ledgerTask?: string; check?: string } = {},
): void {
  log.add("task.delegated", {
    taskId,
    role: "worker",
    rung: RUNG,
    thread: null,
    ledgerTask: o.ledgerTask ?? null,
    by: "architect-1",
    why: "w",
    ...(o.tree ? { tree: o.tree } : {}),
    ...(o.check ? { check: o.check } : {}),
  });
  startDispatch(log, { name: taskId, unit: taskId });
}

const ask = (log: Log, mergeId: string, taskId: string, by = "catherd") =>
  log.add("merge.requested", { mergeId, taskId, by, why: `${taskId} ended complete` });

const after = (log: Log): Action[] => architectNext(log.state(), log.events.at(-1) as never);

describe("writer trees in the architect's state (plan 55, spec D5)", () => {
  it("pins where writers work: writer trees from run.started, the shared tree for a run before plan 55", () => {
    expect(treesRun().state().trees).toBe("writer");
    const old = makeLog();
    old.add("run.started", startedFields);
    expect(old.state().trees).toBe("shared");
  });

  it("merges a task in its own tree when it ends complete, and fast-checks a task on the run's tree as before", () => {
    const log = treesRun();
    work(log, "T1", { tree: "T1", check: "bun test a" });
    work(log, "T2", { check: "bun test b" });
    expect(mergeFor(log.state(), { name: "T1", ...ok })).toEqual({ mergeId: "M1" });
    // the merge runs the fast check, in the task's tree
    expect(fastCheckFor(log.state(), { name: "T1", ...ok })).toBeNull();
    expect(mergeFor(log.state(), { name: "T1", status: "ok", replyStatus: "partial" })).toBeNull();
    expect(mergeFor(log.state(), { name: "T2", ...ok })).toBeNull();
    expect(fastCheckFor(log.state(), { name: "T2", ...ok })).toMatchObject({ command: "bun test b" });
    ask(log, "M1", "T1");
    expect(mergeFor(log.state(), { name: "T1", ...ok })).toEqual({ mergeId: "M2" });
    log.add("run.finishing", { verdict: "done", by: "architect-1", why: "w" });
    expect(mergeFor(log.state(), { name: "T1", ...ok })).toBeNull();
  });

  it("runs merges one at a time in the order asked, and holds a full check until they are in", () => {
    const log = treesRun();
    work(log, "T1", { tree: "T1" });
    work(log, "T2", { tree: "T2" });
    ask(log, "M1", "T1");
    ask(log, "M2", "T2", "architect-1");
    log.add("check.requested", {
      checkId: "C1",
      command: "bun test",
      scope: "full",
      base: false,
      fresh: false,
      by: "architect-1",
      why: "w",
    });
    const merges = (a: Action[]) => a.filter((x) => x.type === "merge");
    expect(merges(after(log))).toEqual([{ type: "merge", mergeId: "M1" }]);
    expect(after(log)).not.toContainEqual({ type: "runCheck", checkId: "C1" });
    log.add("merge.done", {
      mergeId: "M1",
      taskId: "T1",
      outcome: "merged",
      sha: "a".repeat(40),
      files: ["src/a.ts"],
      message: "merged at aaaaaaaaaaaa: 1 file",
    });
    expect(merges(after(log))).toEqual([{ type: "merge", mergeId: "M2" }]);
    log.add("effect.failed", { action: "merge", unit: "M2", message: "git broke" });
    expect(merges(after(log))).toEqual([]);
    expect(after(log)).toContainEqual({ type: "runCheck", checkId: "C1" });
  });

  describe("a check of a task's tree and that tree's merge never run together (R19)", () => {
    const check = (log: Log, checkId: string, ref: string) =>
      log.add("check.requested", {
        checkId,
        command: "bun test",
        scope: "fast",
        base: false,
        fresh: false,
        by: "architect-1",
        why: "w",
        ref,
      });
    const done = (log: Log) =>
      log.add("merge.done", {
        mergeId: "M1",
        taskId: "T1",
        outcome: "merged",
        sha: "a".repeat(40),
        files: [],
        message: "merged",
      });
    const types = (a: Action[]) => a.map((x) => x.type);

    it("holds a task-ref check while an earlier merge of that tree is queued, then issues it", () => {
      const log = treesRun();
      work(log, "T1", { tree: "T1" });
      work(log, "T2", { tree: "T2" });
      ask(log, "M1", "T1");
      check(log, "C1", "T1");
      check(log, "C2", "T2");
      check(log, "C3", "a".repeat(40));
      const first = after(log);
      expect(first).toContainEqual({ type: "merge", mergeId: "M1" });
      expect(first).not.toContainEqual({ type: "runCheck", checkId: "C1" });
      // another tree's check and a commit's check are unaffected
      expect(first).toContainEqual({ type: "runCheck", checkId: "C2" });
      expect(first).toContainEqual({ type: "runCheck", checkId: "C3" });
      done(log);
      expect(after(log)).toContainEqual({ type: "runCheck", checkId: "C1" });
    });

    it("holds the merge while an earlier task-ref check of that tree is queued, then issues it", () => {
      const log = treesRun();
      work(log, "T1", { tree: "T1" });
      check(log, "C1", "T1");
      ask(log, "M1", "T1");
      const first = after(log);
      expect(first).toContainEqual({ type: "runCheck", checkId: "C1" });
      expect(types(first)).not.toContain("merge");
      log.add("check.done", {
        checkId: "C1",
        exit: 0,
        failures: [],
        preExisting: [],
        cached: false,
        minutes: 0,
        logPath: "checks/C1.log",
      });
      expect(after(log)).toContainEqual({ type: "merge", mergeId: "M1" });
    });
  });

  it("marks every task of a merged tree merged, wakes the architect, and counts the merge as news", () => {
    const log = treesRun();
    work(log, "T1", { tree: "T1", ledgerTask: "L1" });
    endDispatch(log, log.state().arch.tasks.T1?.dispatchId as string, { name: "T1", unit: "T1" });
    work(log, "T2", { tree: "T1", ledgerTask: "L1" });
    ask(log, "M1", "T2");
    log.add("merge.done", {
      mergeId: "M1",
      taskId: "T2",
      outcome: "merged",
      sha: "b".repeat(40),
      files: ["src/a.ts"],
      message: "merged at bbbbbbbbbbbb: 1 file",
    });
    const s = log.state();
    expect([s.arch.tasks.T1?.merged, s.arch.tasks.T2?.merged]).toEqual([true, true]);
    expect(s.arch.newsSeq).toBe(log.events.at(-1)?.seq as number);
    expect(s.arch.inbox.at(-1)).toMatchObject({
      text: "M1 (merge of T2) merged: merged at bbbbbbbbbbbb: 1 file",
      wakes: true,
    });
    expect(describeEvent(log.events.at(-1) as never)).toBe(
      "merge M1 of T2 merged: merged at bbbbbbbbbbbb: 1 file",
    );
  });

  it("holds a merge that changed the task's oracle until the architect accepts it", () => {
    const log = treesRun();
    work(log, "T1", { tree: "T1", ledgerTask: "L1" });
    log.add("merge.done", {
      mergeId: "M1",
      taskId: "T1",
      outcome: "held",
      sha: null,
      files: ["test/pay.test.ts"],
      message: "it changed test/pay.test.ts, the oracle of ledger L1",
      oracle: { paths: ["test/pay.test.ts"], diff: "tasks/T1/oracle.diff" },
    });
    expect(log.state().arch.tasks.T1).toMatchObject({
      merged: false,
      oracle: { paths: ["test/pay.test.ts"], diff: "tasks/T1/oracle.diff", accepted: null },
    });
  });

  it("continues a ledger task's next attempt in its last unmerged tree, and starts a new one after a merge", () => {
    const log = treesRun();
    expect(continuedTree(log.state().arch, "L1")).toBeNull();
    work(log, "T1", { tree: "T1", ledgerTask: "L1" });
    work(log, "T2", { ledgerTask: "L2" });
    expect(treeBusy(log.state().arch, "T1")).toBe(true);
    endDispatch(log, log.state().arch.tasks.T1?.dispatchId as string, { name: "T1", unit: "T1" });
    expect(treeBusy(log.state().arch, "T1")).toBe(false);
    expect(continuedTree(log.state().arch, "L1")).toBe("T1");
    // a task on the run's tree leaves nothing to continue in
    expect(continuedTree(log.state().arch, "L2")).toBeNull();
    expect(continuedTree(log.state().arch, null)).toBeNull();
    log.add("merge.done", {
      mergeId: "M1",
      taskId: "T1",
      outcome: "merged",
      sha: "c".repeat(40),
      files: [],
      message: "m",
    });
    expect(continuedTree(log.state().arch, "L1")).toBeNull();
  });

  it("keeps a tree busy while its merge is queued or running, and frees it only when the merge is done (plan 55 review C1)", () => {
    const log = treesRun();
    work(log, "T1", { tree: "T1", ledgerTask: "L1" });
    endDispatch(log, log.state().arch.tasks.T1?.dispatchId as string, { name: "T1", unit: "T1" });
    ask(log, "M1", "T1");
    expect(treeBusy(log.state().arch, "T1")).toBe(true);
    // the merge's own send-back is the one task that may join its tree
    expect(treeBusy(log.state().arch, "T1", "M1")).toBe(false);
    expect(continuedTree(log.state().arch, "L1")).toBeNull();
    log.add("merge.done", {
      mergeId: "M1",
      taskId: "T1",
      outcome: "conflict",
      sha: null,
      files: ["a.txt"],
      message: "m",
    });
    expect(treeBusy(log.state().arch, "T1")).toBe(false);
    expect(continuedTree(log.state().arch, "L1")).toBe("T1");
  });

  it("marks merged only the tasks delegated before the merge was asked for (plan 55 review C1)", () => {
    const log = treesRun();
    work(log, "T1", { tree: "T1" });
    endDispatch(log, log.state().arch.tasks.T1?.dispatchId as string, { name: "T1", unit: "T1" });
    ask(log, "M1", "T1");
    work(log, "T2", { tree: "T1" });
    log.add("merge.done", {
      mergeId: "M1",
      taskId: "T1",
      outcome: "merged",
      sha: "d".repeat(40),
      files: [],
      message: "m",
    });
    expect([log.state().arch.tasks.T1?.merged, log.state().arch.tasks.T2?.merged]).toEqual([true, false]);
  });

  it("wakes the architect when a task catherd sent back ends, and names the end's checkpoint", () => {
    const log = treesRun();
    log.add("task.delegated", {
      taskId: "T1",
      role: "worker",
      rung: RUNG,
      thread: null,
      ledgerTask: null,
      by: "catherd",
      why: "M1 conflicted",
      tree: "T1",
      cause: "conflict",
    });
    const d = startDispatch(log, { name: "T1", unit: "T1" });
    expect(log.state().arch.tasks.T1?.cause).toBe("conflict");
    endDispatch(log, d, { name: "T1", unit: "T1", checkpoint: "refs/catherd/r/T1/1" });
    expect(log.state().arch.tasks.T1?.checkpoint).toBe("refs/catherd/r/T1/1");
    expect(log.state().arch.inbox.at(-1)).toMatchObject({
      text: expect.stringContaining("checkpoint refs/catherd/r/T1/1"),
      wakes: true,
    });
  });

  it("runs a full check on a commit or a task's tree beside the merges, and names what it checked (plan 55)", () => {
    const log = treesRun();
    work(log, "T1", { tree: "T1" });
    ask(log, "M1", "T1");
    const full = (checkId: string, ref: string) =>
      log.add("check.requested", {
        checkId,
        command: "bun test",
        scope: "full",
        base: false,
        fresh: false,
        by: "architect-1",
        why: "w",
        ref,
      });
    full("C1", "d".repeat(40));
    full("C2", "T1");
    expect(after(log)).toContainEqual({ type: "runCheck", checkId: "C1" });
    // R19: the tree's own merge goes first, being asked for first
    expect(after(log)).not.toContainEqual({ type: "runCheck", checkId: "C2" });
    log.add("merge.done", {
      mergeId: "M1",
      taskId: "T1",
      outcome: "refused",
      sha: null,
      files: [],
      message: "refused",
    });
    expect(after(log)).toContainEqual({ type: "runCheck", checkId: "C2" });
    const done = (checkId: string) =>
      log.add("check.done", {
        checkId,
        exit: 0,
        failures: [],
        preExisting: [],
        cached: false,
        minutes: 1,
        logPath: `checks/${checkId}.log`,
      });
    done("C1");
    expect(log.state().arch.inbox.at(-1)?.text).toStartWith("C1 (full, on dddddddddddd) passed");
    done("C2");
    expect(log.state().arch.inbox.at(-1)?.text).toStartWith("C2 (full, in T1's tree) passed");
  });
});
