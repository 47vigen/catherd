import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { db, insertCheck } from "../../src/infra/db.ts";
import * as state from "../../src/domain/run-state.ts";
import { appendEvent } from "../../src/services/run-events-store.ts";
import { metricsOf, parsedOf, reviewerReport } from "../../src/services/run-metrics.ts";
import { endDispatch, makeLog, startDispatch, startedFields } from "../domain/run-fixtures.ts";
import { snapshotEnv } from "../helpers.ts";
import { freshRun } from "./helpers.ts";

afterEach(snapshotEnv());

describe("a run's metrics from its own rows (plan 51, spec D17)", () => {
  it("counts review rounds per ledger task, rung climbs, check minutes, and a review's misses", async () => {
    const { run } = freshRun();
    const log = makeLog();
    log.add("run.started", { ...startedFields });
    const turn = startDispatch(log, { name: "architect-1", role: "architect", unit: "run" });
    const task = (taskId: string, role: string, rung: string) =>
      log.add("task.delegated", {
        taskId,
        role: role as never,
        rung,
        thread: null,
        ledgerTask: "L1",
        by: "architect-1",
        why: "w",
      });
    task("T1", "worker", "codex:gpt-6-luna#high");
    task("T2", "reviewer", "codex:gpt-6-sol#high");
    task("T3", "worker", "codex:gpt-6-sol#medium");
    task("T4", "reviewer", "codex:gpt-6-sol#high");
    const review = startDispatch(log, {
      name: "T2",
      role: "reviewer",
      unit: "T2",
      rung: "codex:gpt-6-sol#high",
    });
    endDispatch(log, review, {
      name: "T2",
      unit: "T2",
      findings: [{ label: "IMPORTANT", text: "x", file: null }],
    });
    log.add("review.missed", {
      ledgerTask: "L1",
      review: "T2",
      bug: "loses the refund",
      caughtBy: "verifier",
      by: "architect-1",
      why: "w",
    });
    endDispatch(log, turn, { name: "architect-1", unit: "run" });
    for (const { v: _v, seq: _s, at: _a, ...e } of log.events) await appendEvent(run, e as never);
    insertCheck(db(), run.id, {
      checkId: "C1",
      scope: "full",
      ref: "worktree",
      tree: null,
      command: "bun test",
      base: false,
      exit: 0,
      failures: [],
      minutes: 6,
      cached: false,
      at: new Date().toISOString(),
    });
    const m = metricsOf(run, Date.parse(run.meta.createdAt) + 60 * 60_000);
    expect(m.rounds).toEqual({ perTask: { L1: 2 }, max: 2, total: 2 });
    expect(m.climbs).toBe(1);
    expect(m.checkShare).toBe(0.1);
    // plan 53: no role ran beside it, and it was a full check
    expect([m.fastCheckShare, m.checkWaitShare]).toEqual([0, 0.1]);
    const report = reviewerReport([run]);
    expect(report.rungs).toEqual([
      {
        rung: "codex:gpt-6-sol#high",
        reviews: 1,
        findings: { IMPORTANT: 1 },
        handled: { unlogged: 1 },
        missed: 1,
      },
    ]);
    expect(report.missed).toMatchObject([
      { run: run.id, ledgerTask: "L1", caughtBy: "verifier", bug: "loses the refund" },
    ]);
  });

  it("counts an architect turn that moved to another rung after a quota limit as a climb (plan 52)", async () => {
    const { run } = freshRun();
    const log = makeLog();
    log.add("run.started", startedFields);
    const turn = (n: number, rung: string, status: "ok" | "limit") =>
      endDispatch(log, startDispatch(log, { name: `architect-${n}`, role: "architect", unit: "run", rung }), {
        name: `architect-${n}`,
        unit: "run",
        status,
      });
    turn(1, "codex:gpt-6-astra#xhigh", "limit");
    turn(2, "claude-code:claude-opus-5-5#high", "ok");
    turn(3, "claude-code:claude-opus-5-5#high", "ok");
    for (const { v: _v, seq: _s, at: _a, ...e } of log.events) await appendEvent(run, e as never);
    expect(metricsOf(run, Date.parse(run.meta.createdAt) + 60_000).climbs).toBe(1);
  });

  it("does not replay a run its caller already replayed", async () => {
    const { run } = freshRun();
    await appendEvent(run, { type: "run.started", ...startedFields });
    const parsed = new Map([[run.id, parsedOf(run)]]);
    const spy = spyOn(state, "replay");
    try {
      metricsOf(run, Date.now(), parsed.get(run.id));
      reviewerReport([run], parsed);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
