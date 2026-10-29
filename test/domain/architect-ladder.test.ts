import { describe, expect, it } from "bun:test";
import { ladderRung, unheldRung } from "../../src/domain/architect-state.ts";
import type { Role } from "../../src/domain/roles.ts";
import { endDispatch, type Log, makeLog, startDispatch, startedFields } from "./run-fixtures.ts";

const LADDER = ["codex:gpt-6-luna#high", "codex:gpt-6-sol#medium", "codex:gpt-6-sol#high"] as const;
const [LOW, MID, TOP] = LADDER;

function run(): Log {
  const log = makeLog();
  log.add("run.started", startedFields);
  return log;
}

/** One attempt on L1: delegated, started and ended as `end` says. */
function attempt(
  log: Log,
  taskId: string,
  rung: string,
  end: Parameters<typeof endDispatch>[2] extends infer O ? Omit<O & object, "name" | "unit"> : never,
  role: Role = "worker",
): void {
  log.add("task.delegated", {
    taskId,
    role,
    rung,
    thread: null,
    ledgerTask: "L1",
    by: "architect-1",
    why: "w",
  });
  const id = startDispatch(log, { name: taskId, unit: taskId, role, rung });
  endDispatch(log, id, { name: taskId, unit: taskId, ...end });
}

const next = (log: Log, ledgerTask: string | null = "L1", role: Role = "worker") =>
  ladderRung(log.state().arch, role, ledgerTask, LADDER, LOW);

describe("spec D7: the ladder's default, climbed on observed failure", () => {
  it("starts on the default with no ledger task or no earlier attempt", () => {
    const log = run();
    expect(next(log, null)).toBe(LOW);
    expect(next(log)).toBe(LOW);
  });

  it("climbs one rung after a failed, timed-out or too-hard attempt, and stays at the top", () => {
    const log = run();
    attempt(log, "T1", LOW, { status: "failed", replyStatus: null });
    expect(next(log)).toBe(MID);
    attempt(log, "T2", MID, { status: "timeout", replyStatus: null });
    expect(next(log)).toBe(TOP);
    attempt(log, "T3", TOP, { replyStatus: "blocked", reason: "too_hard" });
    expect(next(log)).toBe(TOP);
  });

  it("never climbs for a stop outside the rung: provider error, no access, needs user, a quota limit", () => {
    for (const end of [
      { replyStatus: "blocked" as const, reason: "provider_error" as const },
      { replyStatus: "blocked" as const, reason: "no_access" as const },
      { replyStatus: "blocked" as const, reason: "needs_user" as const },
      { status: "limit" as const, replyStatus: null },
    ]) {
      const log = run();
      attempt(log, "T1", MID, end);
      expect(next(log)).toBe(MID);
    }
  });

  it("climbs the worker's rung after a review of its attempt found a BLOCKER, and not after a NIT", () => {
    const log = run();
    attempt(log, "T1", LOW, {});
    attempt(
      log,
      "T2",
      "codex:gpt-6-sol#high",
      {
        findings: [{ label: "NIT", text: "naming", file: null }],
      },
      "reviewer",
    );
    expect(next(log)).toBe(LOW);
    attempt(
      log,
      "T3",
      "codex:gpt-6-sol#high",
      {
        findings: [{ label: "BLOCKER", text: "loses the refund", file: "src/pay.ts" }],
      },
      "reviewer",
    );
    expect(next(log)).toBe(MID);
  });

  it("reads the attempt that ended last, not the one delegated last (parallel attempts)", () => {
    const log = run();
    for (const [taskId, rung] of [
      ["T1", LOW],
      ["T2", MID],
    ] as const)
      log.add("task.delegated", {
        taskId,
        role: "worker",
        rung,
        thread: null,
        ledgerTask: "L1",
        by: "architect-1",
        why: "w",
      });
    const one = startDispatch(log, { name: "T1", unit: "T1", rung: LOW });
    const two = startDispatch(log, { name: "T2", unit: "T2", rung: MID });
    endDispatch(log, two, { name: "T2", unit: "T2", status: "failed", replyStatus: null });
    endDispatch(log, one, { name: "T1", unit: "T1" });
    expect(next(log)).toBe(LOW);
  });

  it("goes back to the default when the last attempt's rung left the ladder", () => {
    const log = run();
    attempt(log, "T1", "codex:gone#high", { status: "failed", replyStatus: null });
    expect(next(log)).toBe(LOW);
  });

  it("never lets a reviewer's BLOCKER climb the reviewer's own re-review", () => {
    const log = run();
    attempt(
      log,
      "T1",
      MID,
      { findings: [{ label: "BLOCKER", text: "loses the refund", file: "src/pay.ts" }] },
      "reviewer",
    );
    expect(next(log, "L1", "reviewer")).toBe(MID);
  });

  it("never lets another role's failure climb a worker", () => {
    const log = run();
    attempt(log, "T1", LOW, {});
    attempt(log, "T2", MID, { status: "failed", replyStatus: null }, "researcher");
    expect(next(log)).toBe(LOW);
  });

  it("never climbs for a lost dispatch (a daemon restart), which no stronger rung would fix", () => {
    const log = run();
    attempt(log, "T1", MID, { status: "failed", replyStatus: null, lost: true });
    expect(next(log)).toBe(MID);
  });
});

describe("plan 52: a held quota moves a no-rung pick along the ladder", () => {
  it("keeps the pick when its quota is free, else takes the next free rung up, then from the bottom", () => {
    const [LUNA, SONNET, SOL] = [
      "codex:gpt-6-luna#high",
      "claude-code:claude-sonnet-5-5#high",
      "codex:gpt-6-sol#high",
    ];
    const ladder = [LUNA, SONNET, SOL];
    const s = run().state();
    expect(unheldRung(ladder, SOL, s)).toBe(SOL);
    s.holds.codex = new Date(Date.parse(s.at) + 60_000).toISOString();
    expect(unheldRung(ladder, SOL, s)).toBe(SONNET);
    expect(unheldRung(ladder, LUNA, s)).toBe(SONNET);
    s.holds["claude-code"] = s.holds.codex;
    expect(unheldRung(ladder, LUNA, s)).toBeNull();
    s.holds.codex = s.at;
    expect(unheldRung(ladder, SONNET, s)).toBe(SOL);
  });
});
