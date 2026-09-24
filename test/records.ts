import type { RunRecord } from "../src/types.ts";

export function fakeRecord(name: string, over: Partial<RunRecord> = {}): RunRecord {
  return {
    name,
    role: "worker",
    backend: "codex",
    rung: "gpt-6-sol#medium",
    thread: "t1",
    status: "ok",
    startedAt: new Date().toISOString(),
    secs: 120,
    pid: 1,
    tokens: { input: 1000, cached: 500, output: 100 },
    costUsd: null,
    changedOwned: ["a.ts"],
    replyStatus: "complete",
    replyWhy: "done",
    threadHeavy: false,
    isolated: false,
    images: [],
    error: null,
    replyPath: "/x.out",
    ...over,
  };
}
