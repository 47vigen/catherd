import { describe, expect, it } from "bun:test";
import { median, reviewerRows, runMetrics } from "../../src/domain/run-metrics.ts";

const T = Date.parse("2026-10-28T10:00:00.000Z");
const min = (n: number) => T + n * 60_000;
const d = (from: number, to: number, o: object = {}) => ({
  role: "worker",
  startedAt: min(from),
  endedAt: min(to),
  status: "ok",
  replyStatus: "complete",
  reason: null,
  costUsd: 0.5,
  ...o,
});
const base = {
  start: T,
  end: min(100),
  pauses: [],
  dispatches: [],
  checkMinutes: null,
  rounds: {},
  climbs: 0,
  standingStartSec: [],
  ownerQuestions: 0,
  verifierFails: 0,
};

describe("a run's metrics (plan 51, spec D17)", () => {
  it("counts idle time, concurrency and blocked minutes by reason, with pauses left out", () => {
    const m = runMetrics({
      ...base,
      // 0–40 two roles at once, 40–50 one blocked, 60–80 paused with nothing running
      dispatches: [
        d(0, 40),
        d(0, 40),
        d(40, 50, { replyStatus: "blocked", reason: "needs_user", costUsd: null }),
        d(90, 95, { status: "timeout", replyStatus: null }),
      ],
      pauses: [{ from: min(60), to: min(80) }],
      checkMinutes: 16,
    });
    expect(m.wallMin).toBe(80);
    // busy 0–50 and 90–95: 55 of 80 unpaused minutes
    expect(m.idlePct).toBe(31.3);
    expect(m.concurrency).toBe(1.19);
    expect(m.blockedMin).toEqual({ needs_user: 10, timeout: 5 });
    expect(m.checkShare).toBe(0.2);
    expect(m.costUsd).toBe(1.5);
  });

  it("sums review rounds per task, takes the median standing-role start, and reads no check rows as null", () => {
    const m = runMetrics({ ...base, rounds: { L1: 3, L2: 1 }, standingStartSec: [4, 30, 2] });
    expect(m.rounds).toEqual({ perTask: { L1: 3, L2: 1 }, max: 3, total: 4 });
    expect(m.standingStartSec).toBe(4);
    expect(m.checkShare).toBeNull();
    expect(m.costUsd).toBeNull();
    expect(median([])).toBeNull();
    expect(median([1, 2, 3, 10])).toBe(2.5);
  });
});

describe("the reviewer rungs (plan 51, spec D8)", () => {
  it("shows each rung's findings, how they were handled, and the bugs its reviews missed", () => {
    const rows = reviewerRows(
      [
        {
          taskId: "r/T2",
          rung: "codex:gpt#high",
          findings: [{ label: "IMPORTANT" }, { label: "NIT" }],
          handled: { 1: "fix" },
        },
        { taskId: "r/T4", rung: "codex:gpt#high", findings: [], handled: {} },
        {
          taskId: "r/T5",
          rung: "claude-code:opus#medium",
          findings: [{ label: "PRE-EXISTING" }],
          handled: {},
        },
      ],
      [{ review: "r/T4" }, { review: null }],
    );
    expect(rows).toEqual([
      {
        rung: "codex:gpt#high",
        reviews: 2,
        findings: { IMPORTANT: 1, NIT: 1 },
        handled: { fix: 1, unlogged: 1 },
        missed: 1,
      },
      {
        rung: "claude-code:opus#medium",
        reviews: 1,
        findings: { "PRE-EXISTING": 1 },
        handled: { unlogged: 1 },
        missed: 0,
      },
      { rung: "(no review named)", reviews: 0, findings: {}, handled: {}, missed: 1 },
    ]);
  });
});
