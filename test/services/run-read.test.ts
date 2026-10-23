import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { tryLock } from "../../src/infra/filelock.ts";
import type { RunEventInput } from "../../src/domain/run-events.ts";
import { PLAN, newId, startedFields } from "../domain/run-fixtures.ts";
import { beat, daemonLauncher, daemonLockTarget } from "../../src/services/daemon.ts";
import { appendEvent } from "../../src/services/run-events-store.ts";
import {
  ParkedViewSchema,
  RunViewSchema,
  TimelineEntrySchema,
  listRunViews,
  parkedQuestions,
  runTimeline,
  runView,
} from "../../src/services/run-read.ts";
import { createRun, type Run } from "../../src/services/run-store.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { fakeDeps, freshRun } from "./helpers.ts";

afterEach(snapshotEnv());
const real = daemonLauncher.launch;
let launched: string[] = [];
beforeEach(() => {
  launched = [];
  daemonLauncher.launch = (id: string) => {
    launched.push(id);
    return 1;
  };
});
afterEach(() => {
  daemonLauncher.launch = real;
});

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const deps = () => fakeDeps({ now: () => NOW });

async function seed(run: Run, ...more: RunEventInput[]): Promise<void> {
  await appendEvent(run, { type: "run.started", ...startedFields }, new Date(NOW - 60_000));
  await appendEvent(run, { type: "plan.ready", milestones: PLAN }, new Date(NOW - 50_000));
  await appendEvent(run, { type: "plan.approved", by: "owner" }, new Date(NOW - 50_000));
  for (const e of more) await appendEvent(run, e, new Date(NOW - 10_000));
}

describe("the read api", () => {
  it("shows phase, milestones, live roles, parked questions, holds and the daemon's health", async () => {
    const { run } = freshRun("wallet");
    const id = newId();
    await seed(
      run,
      {
        type: "lanes.routed",
        milestone: "M1",
        lanes: [
          { lane: "M1.L1", rung: "codex:gpt-6-sol#medium", ladder: [] },
          { lane: "M1.L2", rung: "codex:gpt-6-sol#medium", ladder: [] },
        ],
      },
      { type: "preflight.done", milestone: "M1", blocking: [], confirm: null, lint: [] },
      {
        type: "dispatch.started",
        dispatchId: id,
        name: "worker-M1.L1",
        role: "worker",
        unit: "M1.L1",
        lane: "M1.L1",
        rung: "codex:gpt-6-sol#medium",
        thread: null,
      },
      { type: "question.parked", unit: "M1.L2", question: "which currency?", reason: "needs_user" },
    );
    const lock = tryLock(daemonLockTarget(run));
    try {
      beat(run, deps(), 6);
      const v = runView(deps(), run.id);
      expect(RunViewSchema.parse(v)).toEqual(v);
      expect(v).toMatchObject({
        id: run.id,
        title: "wallet",
        engine: "2.0",
        phase: "running",
        outcome: null,
        daemon: { alive: true, pid: process.pid, beatAgeSec: 0 },
        milestones: [
          { id: "M1", status: "lanes", commit: null },
          { id: "M2", status: "waiting" },
        ],
        live: [{ name: "worker-M1.L1", role: "worker", rung: "codex:gpt-6-sol#medium", unit: "M1.L1" }],
        holds: [],
        last: "M1.L2 parked (needs_user): which currency?",
      });
      expect(v.parked).toEqual([
        {
          run: run.id,
          runTitle: "wallet",
          unit: "M1.L2",
          question: "which currency?",
          reason: "needs_user",
          at: new Date(NOW - 10_000).toISOString(),
          command: `catherd answer ${run.id} M1.L2 "<answer>"`,
        },
      ]);
      expect(launched).toEqual([]);
    } finally {
      lock?.();
    }
  });

  it("counts the run's time without its pauses, and stops counting while one is open", async () => {
    withHome();
    const run = createRun({
      repo: tempRepo(),
      title: "t",
      aLines: [],
      version: "0.0.0-test",
      now: new Date(NOW - 60_000),
    });
    await seed(run);
    await appendEvent(run, { type: "run.paused", by: "owner" }, new Date(NOW - 40_000));
    await appendEvent(run, { type: "run.resumed", by: "owner" }, new Date(NOW - 30_000));
    expect(runView(deps(), run.id)).toMatchObject({
      elapsedSec: 50,
      countingSince: new Date(NOW).toISOString(),
    });
    await appendEvent(run, { type: "run.paused", by: "owner" }, new Date(NOW - 20_000));
    expect(runView(deps(), run.id)).toMatchObject({ elapsedSec: 30, countingSince: null });
  });

  it("shows a quota's hold", async () => {
    const { run } = freshRun();
    const id = newId();
    await seed(
      run,
      {
        type: "dispatch.started",
        dispatchId: id,
        name: "worker-M1.L1",
        role: "worker",
        unit: "M1.L1",
        lane: "M1.L1",
        rung: "codex:gpt-6-sol#medium",
        thread: null,
      },
      {
        type: "dispatch.ended",
        dispatchId: id,
        name: "worker-M1.L1",
        unit: "M1.L1",
        status: "limit",
        replyStatus: null,
        reason: null,
        why: "",
        thread: null,
        head: null,
        environment: null,
        verdict: null,
        findings: [],
        foreign: [],
        replyPath: "",
      },
    );
    expect(runView(deps(), run.id).holds).toEqual([
      { quota: "codex", until: new Date(NOW - 10_000 + 30 * 60_000).toISOString() },
    ]);
  });

  it("lists a 1.5 run read-only as engine 1.5", () => {
    const { run } = freshRun("old");
    const v = runView(deps(), run.id);
    expect(RunViewSchema.parse(v)).toEqual(v);
    expect(v).toMatchObject({ engine: "1.5", phase: null, daemon: { alive: false, pid: null } });
    expect(runTimeline(run.id)).toEqual([]);
    expect(launched).toEqual([]);
  });

  it("returns the timeline from a seq, one line per event", async () => {
    const { run } = freshRun();
    await seed(run, { type: "report.posted", kind: "started", unit: "run", text: "x".repeat(500) });
    const all = runTimeline(run.id);
    expect(all.map((e) => [e.seq, e.type])).toEqual([
      [1, "run.started"],
      [2, "plan.ready"],
      [3, "plan.approved"],
      [4, "report.posted"],
    ]);
    expect(all.every((e) => TimelineEntrySchema.safeParse(e).success)).toBe(true);
    expect(all[1]?.text).toBe("plan ready: M1, M2");
    expect(all[3]?.text).toBe("report (started) on run");
    expect(runTimeline(run.id, 4).map((e) => e.seq)).toEqual([4]);
    expect(runTimeline(run.id, 1, 2)).toHaveLength(2);
  });

  it("lists every run's parked questions with the command that answers each", async () => {
    const { repo, run } = freshRun("first");
    const other = createRun({ repo, title: "second", aLines: [], version: "0.0.0-test" });
    await seed(run, { type: "question.parked", unit: "M1", question: "q1", reason: "judge" });
    await seed(other, { type: "question.parked", unit: "M2.L1", question: "q2", reason: "needs_user" });
    const done = createRun({ repo: tempRepo(), title: "done", aLines: [], version: "0.0.0-test" });
    await seed(done, { type: "question.parked", unit: "M1", question: "old", reason: "judge" });
    await appendEvent(done, { type: "run.ended", outcome: "done", reportPath: null }, new Date(NOW));
    const all = parkedQuestions();
    expect(all.map((p) => p.question).sort()).toEqual(["q1", "q2"]);
    expect(all.every((p) => ParkedViewSchema.safeParse(p).success)).toBe(true);
    expect(parkedQuestions({ run: other.id })).toMatchObject([
      { unit: "M2.L1", command: `catherd answer ${other.id} M2.L1 "<answer>"` },
    ]);
  });

  it("revives the daemon of an unfinished run on every read, and not an ended one", async () => {
    const { repo, run } = freshRun("live");
    await seed(run);
    runView(deps(), run.id);
    expect(launched).toEqual([run.id]);
    const done = createRun({ repo, title: "done", aLines: [], version: "0.0.0-test" });
    await seed(done);
    await appendEvent(done, { type: "run.ended", outcome: "done", reportPath: null }, new Date(NOW));
    launched = [];
    const views = listRunViews(deps());
    expect(views.map((v) => v.title).sort()).toEqual(["done", "live"]);
    expect(launched).toEqual([run.id]);
    expect(listRunViews(deps(), { limit: 1 })).toHaveLength(1);
  });
});
