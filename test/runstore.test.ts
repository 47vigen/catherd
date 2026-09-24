import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import {
  appendLedger,
  appendRunRecord,
  createRun,
  listRuns,
  openRun,
  readRunRecords,
  rolePaths,
  rotateRound,
  writeState,
} from "../src/core/runstore.ts";
import type { RunRecord } from "../src/types.ts";
import { withHome } from "./helpers.ts";

const rec = (name: string): RunRecord => ({
  name,
  role: "worker",
  backend: "codex",
  rung: "gpt-6-sol#medium",
  thread: "t1",
  status: "ok",
  startedAt: "2026-09-24T10:00:00Z",
  secs: 60,
  pid: 1,
  tokens: { input: 1, cached: 0, output: 1 },
  costUsd: null,
  changedOwned: ["a.ts"],
  replyStatus: "complete",
  replyWhy: "done",
  threadHeavy: false,
  isolated: false,
  images: [],
  error: null,
  replyPath: "/x",
});

describe("runstore", () => {
  beforeEach(() => withHome());

  test("creates a run folder with meta, lanes dir and an initial state", () => {
    const run = createRun("/r/app", "Add jobs screen", ["A1 jobs page lists jobs"]);
    expect(run.id).toMatch(/^\d{8}-\d{6}-add-jobs-screen$/);
    expect(existsSync(join(run.dir, "lanes"))).toBe(true);
    expect(existsSync(join(run.dir, "roles"))).toBe(true);
    expect(readFileSync(join(run.dir, "state.md"), "utf8")).toContain("A1 jobs page lists jobs");
    expect(openRun("/r/app", run.id).meta.title).toBe("Add jobs screen");
  });

  test("appends and reads run records", () => {
    const run = createRun("/r/app", "t", []);
    appendRunRecord(run.dir, rec("worker-M1.L1"));
    appendRunRecord(run.dir, rec("worker-M1.L2"));
    expect(readRunRecords(run.dir).map((r) => r.name)).toEqual(["worker-M1.L1", "worker-M1.L2"]);
  });

  test("rotates the previous round of a role to .r1, then .r2", () => {
    const run = createRun("/r/app", "t", []);
    const p = rolePaths(run.dir, "worker-M1.L1");
    writeFileSync(p.out, "round 0");
    writeFileSync(p.jsonl, "{}");
    rotateRound(run.dir, "worker-M1.L1");
    expect(existsSync(p.out)).toBe(false);
    expect(readFileSync(join(run.dir, "roles", "worker-M1.L1.r1.out"), "utf8")).toBe("round 0");
    writeFileSync(p.out, "round 1");
    rotateRound(run.dir, "worker-M1.L1");
    expect(readFileSync(join(run.dir, "roles", "worker-M1.L1.r2.out"), "utf8")).toBe("round 1");
  });

  test("renders state.md with the next step on the last line", () => {
    const run = createRun("/r/app", "t", []);
    writeState(run.dir, {
      head: "abc1234",
      dirty: [{ path: "a.ts", owner: "worker-M1.L1" }],
      running: [
        { name: "worker-M1.L1", rung: "gpt-6-sol#medium", thread: "t1", brief: "roles/w.md", since: "10:00" },
      ],
      lastCheck: "bun test 12/12",
      next: "wait for worker-M1.L1, then review M1",
    });
    const lines = readFileSync(join(run.dir, "state.md"), "utf8").trimEnd().split("\n");
    expect(lines.at(-1)).toBe("Next: wait for worker-M1.L1, then review M1");
    expect(lines.join("\n")).toContain("worker-M1.L1 · gpt-6-sol#medium · thread t1 · since 10:00");
  });

  test("appends ledger rows and never rewrites them", () => {
    const run = createRun("/r/app", "t", []);
    appendLedger(run.dir, "M1 | jobs list | abc1234 | 38 | bun test 12/12");
    appendLedger(run.dir, "M2 | filters | def5678 | 20 | bun test 20/20");
    expect(readFileSync(join(run.dir, "ledger.md"), "utf8").trim().split("\n").slice(-2)).toEqual([
      "M1 | jobs list | abc1234 | 38 | bun test 12/12",
      "M2 | filters | def5678 | 20 | bun test 20/20",
    ]);
  });

  test("lists runs of every repo, newest first", () => {
    createRun("/r/a", "first", []);
    createRun("/r/b", "second", []);
    expect(
      listRuns()
        .map((r) => r.meta.title)
        .sort(),
    ).toEqual(["first", "second"]);
  });
});
