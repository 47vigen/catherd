import type { RunRecord } from "../../src/domain/record.ts";

/** A valid v1 RunRecord for tests; `over` replaces any field. */
export function makeRecord(over: Partial<RunRecord> = {}): RunRecord {
  return {
    schema: 1,
    runId: "r1",
    dispatchId: "01J0000000000000000000000A",
    name: "worker-M1.L1",
    role: "worker",
    lane: "M1.L1",
    backend: "codex",
    rung: "codex:gpt-6-sol#medium",
    attempt: 1,
    failoverFrom: null,
    thread: "t-1",
    status: "ok",
    startedAt: "2026-09-25T10:00:00.000Z",
    endedAt: "2026-09-25T10:01:00.000Z",
    secs: 60,
    exitCode: 0,
    signal: null,
    cliVersion: "0.157.0",
    tokens: { input: 100, cached: 40, output: 10 },
    costUsd: null,
    changedOwned: ["src/a.ts"],
    violations: [],
    replyStatus: "complete",
    replyWhy: "done",
    threadHeavy: false,
    access: "workspace-write",
    isolated: false,
    images: [],
    error: null,
    replyPath: "roles/worker-M1.L1/01J0000000000000000000000A/reply.md",
    ...over,
  };
}
