import { expect, test } from "bun:test";
import { deriveRunFlow } from "../../src/domain/run-flow.ts";

test("an empty live run is idle from its start", () => {
  const start = "2026-01-01T00:00:00.000Z";
  const flow = deriveRunFlow({
    startedAt: start,
    now: Date.parse(start) + 1000,
    events: [],
    records: [],
    ledgerTasks: [],
    checks: [],
  });
  expect(flow.idle).toEqual([{ startedAt: start, endedAt: null, reason: "gap", evidenceSeqs: [] }]);
});

import type { RunEvent } from "../../src/domain/run-events.ts";
const base = Date.parse("2026-01-01T00:00:00.000Z");
const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
const event = (seq: number, seconds: number, fields: object) =>
  ({ v: 2, seq, at: at(seconds), ...fields }) as RunEvent;
const start = (seq: number, seconds: number, id: string, rung = "codex:gpt-6#high") =>
  event(seq, seconds, {
    type: "dispatch.started",
    dispatchId: id,
    name: id,
    role: "worker",
    unit: id,
    lane: null,
    rung,
    thread: null,
  });
const done = (
  seq: number,
  seconds: number,
  id: string,
  status = "ok",
  replyStatus: string | null = "complete",
) =>
  event(seq, seconds, {
    type: "dispatch.ended",
    dispatchId: id,
    name: id,
    unit: id,
    status,
    replyStatus,
    reason: null,
    why: "done",
    thread: null,
    head: null,
    environment: null,
    verdict: null,
    findings: [],
    replyPath: "",
  });
const derive = (events: RunEvent[], seconds = 1815) =>
  deriveRunFlow({
    startedAt: at(0),
    now: base + seconds * 1000,
    events,
    records: [],
    ledgerTasks: [],
    checks: [],
  });

test("idle is the complement of roles, split by check, owner and quota evidence", () => {
  const events = [
    start(1, 1, "T1"),
    event(2, 2, {
      type: "check.requested",
      checkId: "C1",
      scope: "fast",
      base: false,
      command: "test",
      by: "architect",
      why: "proof",
    }),
    done(3, 4, "T1"),
    event(4, 7, {
      type: "check.done",
      checkId: "C1",
      exit: 1,
      failures: ["old"],
      preExisting: ["old"],
      verdict: "inherited",
      cached: false,
      minutes: 1,
      logPath: "log",
    }),
    event(5, 8, { type: "question.parked", unit: "run", question: "Which?", reason: "owner" }),
    event(6, 10, { type: "question.answered", unit: "run", answer: "yes", by: "owner" }),
    start(7, 10, "T2"),
    done(8, 11, "T2", "limit", null),
    event(9, 1815, { type: "run.ended", outcome: "done", reportPath: null }),
  ];
  const flow = derive(events);
  expect(flow.idle.map((i) => [i.startedAt, i.endedAt, i.reason, i.evidenceSeqs])).toEqual([
    [at(0), at(1), "gap", []],
    [at(4), at(7), "check", [2]],
    [at(7), at(8), "gap", []],
    [at(8), at(10), "owner", [5]],
    [at(11), at(1811), "quota", [8]],
    [at(1811), at(1815), "gap", []],
  ]);
  expect(flow.checks[0]).toMatchObject({
    startedAt: at(2),
    endedAt: at(7),
    exit: 1,
    inheritedFailures: 1,
    newFailures: 0,
  });
  expect(flow.quotaHolds[0]).toMatchObject({ startedAt: at(11), endedAt: at(1811), evidenceSeqs: [8] });
});

test("a stopped run freezes open roles, questions and checks", () => {
  const flow = derive(
    [
      start(1, 1, "T1"),
      event(2, 2, {
        type: "check.requested",
        checkId: "C1",
        scope: "fast",
        base: true,
        command: "test",
        by: "owner",
        why: "proof",
      }),
      event(3, 3, { type: "question.parked", unit: "run", question: "why", reason: "owner" }),
      event(4, 5, { type: "run.ended", outcome: "cancelled", reportPath: null }),
    ],
    10,
  );
  expect(flow.dispatches[0]).toMatchObject({ status: "running", endedAt: at(5) });
  expect(flow.checks[0]).toMatchObject({ startedAt: at(2), endedAt: at(5), failureCount: null, base: true });
  expect(flow.ownerWaits[0]?.endedAt).toBe(at(5));
  expect(flow.asOf).toBe(at(5));
});

test("shared quota holds extend and successful completion clears them, with priority changes", () => {
  const events = [
    start(1, 1, "A"),
    done(2, 2, "A", "limit", null),
    start(3, 3, "B"),
    done(4, 4, "B", "limit", null),
    event(5, 5, { type: "question.parked", unit: "run", question: "q", reason: "owner" }),
    event(6, 6, { type: "question.answered", unit: "run", answer: "yes", by: "owner" }),
    start(7, 7, "C"),
    done(8, 8, "C"),
    event(9, 9, { type: "run.ended", outcome: "done", reportPath: null }),
  ];
  const flow = derive(events, 9);
  expect(flow.quotaHolds).toHaveLength(1);
  expect(flow.quotaHolds[0]).toMatchObject({
    startedAt: at(2),
    endedAt: at(8),
    until: at(1804),
    evidenceSeqs: [2, 4],
  });
  expect(flow.idle.map((i) => [i.startedAt, i.endedAt, i.reason, i.evidenceSeqs])).toEqual([
    [at(0), at(1), "gap", []],
    [at(2), at(3), "quota", [2]],
    [at(4), at(5), "quota", [2, 4]],
    [at(5), at(6), "owner", [5]],
    [at(6), at(7), "quota", [2, 4]],
    [at(8), at(9), "gap", []],
  ]);
});

test("only explicit current ledger links assign roles and rung changes compare the same role", () => {
  const delegate = (
    seq: number,
    second: number,
    taskId: string,
    ledgerTask: string | null,
    role = "worker",
  ) =>
    event(seq, second, {
      type: "task.delegated",
      taskId,
      role,
      ledgerTask,
      rung: "codex:gpt-6#high",
      thread: null,
      by: "architect-1",
      why: `why ${taskId}`,
    });
  const events = [
    event(1, 0, {
      type: "dispatch.started",
      dispatchId: "a",
      name: "architect-1",
      role: "architect",
      unit: "run",
      lane: null,
      rung: "codex:gpt-6#high",
      thread: null,
    }),
    delegate(2, 1, "T1", "L1"),
    start(3, 2, "T1"),
    done(4, 3, "T1"),
    delegate(5, 4, "T2", "L1"),
    start(6, 5, "T2", "codex:gpt-6#low"),
    delegate(7, 6, "T3", "removed"),
    start(8, 7, "T3"),
    delegate(9, 8, "T4", null),
    start(10, 9, "T4"),
    event(11, 10, {
      type: "ledger.changed",
      tasks: [],
      progress: false,
      by: "someone-else",
      why: "unmatched",
    }),
  ];
  const ledgerTasks = [
    { id: "L2", goal: "empty", state: "todo" as const, depends: [], oracle: [] },
    { id: "L1", goal: "work", state: "todo" as const, depends: ["L2"], oracle: [] },
  ];
  const snapshot = JSON.stringify({ events, ledgerTasks });
  const flow = deriveRunFlow({
    startedAt: at(0),
    now: base + 12000,
    events,
    records: [],
    ledgerTasks,
    checks: [],
  });
  expect(flow.tasks.map((t) => [t.id, t.dispatchIds])).toEqual([
    ["L2", []],
    ["L1", ["T1", "T2"]],
  ]);
  expect(flow.dispatches.find((d) => d.name === "T2")).toMatchObject({
    climbFrom: "codex:gpt-6#high",
    why: "why T2",
  });
  expect(flow.dispatches.find((d) => d.name === "T3")?.ledgerTask).toBe("removed");
  expect(flow.causes.at(-1)?.turnDispatchId).toBeNull();
  expect(flow.architect[0]?.causeSeqs).toEqual([2, 5, 7, 9]);
  expect(JSON.stringify({ events, ledgerTasks })).toBe(snapshot);
});

test("record-only activity has stored times and no invented provenance", async () => {
  const { makeRecord } = await import("./make-record.ts");
  const record = makeRecord({ dispatchId: "old", name: "T1", startedAt: at(1), endedAt: at(4) });
  const delegation = event(1, 0, {
    type: "task.delegated",
    taskId: "T1",
    role: "worker",
    ledgerTask: "L1",
    rung: record.rung,
    thread: null,
    by: "owner",
    why: "delegated",
  });
  const flow = deriveRunFlow({
    startedAt: at(0),
    now: base + 5000,
    events: [delegation],
    records: [record],
    ledgerTasks: [],
    checks: [],
  });
  expect(flow.dispatches[0]).toMatchObject({
    startedAt: at(1),
    endedAt: at(4),
    taskId: null,
    ledgerTask: null,
    why: record.replyWhy,
  });
});

test("overlapping roles mask waits and an open tail stays open", () => {
  const events = [
    start(1, 1, "A"),
    start(2, 2, "B"),
    event(3, 3, {
      type: "check.requested",
      checkId: "C",
      scope: "fast",
      base: false,
      command: "test",
      by: "owner",
      why: "check",
    }),
    event(4, 4, { type: "question.parked", unit: "run", question: "q", reason: "owner" }),
    done(5, 5, "A"),
    done(6, 6, "B"),
    event(7, 7, { type: "question.answered", unit: "run", answer: "a", by: "owner" }),
  ];
  const flow = derive(events, 10);
  expect(flow.idle.map((i) => [i.startedAt, i.endedAt, i.reason, i.evidenceSeqs])).toEqual([
    [at(0), at(1), "gap", []],
    [at(6), at(7), "owner", [4]],
    [at(7), null, "check", [3]],
  ]);
  expect(flow.checks[0]).toMatchObject({ startedAt: at(3), endedAt: null, failureCount: null });
});
