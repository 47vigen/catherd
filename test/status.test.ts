import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";
import { appendRoute } from "../src/core/lanes.ts";
import { appendJsonl, appendLedger, appendRunRecord, createRun, writeLive } from "../src/core/runstore.ts";
import { budgetStatus, formatBudget, formatSummary, runsSummary, summarizeRun } from "../src/core/status.ts";
import { defaultProfile, saveProfile } from "../src/tui/profile-shim.ts";
import { fakeRecord } from "./records.ts";
import { tempRepo, withHome } from "./helpers.ts";

describe("summarizeRun", () => {
  beforeEach(() => withHome());

  test("sums records, counts Jev fallbacks, lists live roles, landed milestones and the harness cost", () => {
    const run = createRun(tempRepo(), "Jobs screen", ["A1 jobs list"]);
    appendRunRecord(run.dir, fakeRecord("worker-M1.L1", { costUsd: 0.5 }));
    appendRunRecord(run.dir, fakeRecord("worker-M1.L2", { status: "failed", secs: 60 }));
    writeFileSync(
      join(run.dir, "jev.jsonl"),
      `${JSON.stringify({ schema: 1, kind: "jev" })}\n${JSON.stringify({ q: "difficulty", source: "jev" })}\n${JSON.stringify({ q: "finding", source: "default" })}\n`,
    );
    appendLedger(run.dir, "M1 | jobs list | abc1234 | vitest 12/12");
    appendJsonl(join(run.dir, "harness.jsonl"), {
      at: "x",
      name: "worker-M1.L1",
      backend: "codex",
      isolated: false,
      firstTurnInput: 52_000,
    });
    writeLive(run.dir, {
      name: "reviewer-M1",
      role: "reviewer",
      backend: "codex",
      rung: "gpt-6-sol#high",
      pid: process.pid,
      thread: null,
      startedAt: new Date(Date.now() - 65_000).toISOString(),
      cwd: run.meta.repo,
      ownedFiles: [],
      before: {},
      isolated: false,
    });

    const s = summarizeRun(run);

    expect(s.title).toBe("Jobs screen");
    expect(s.totals).toEqual({
      runs: 2,
      ok: 1,
      notOk: ["worker-M1.L2 (failed)"],
      secs: 180,
      tokens: { input: 2000, cached: 1000, output: 200 },
      costUsd: 0.5,
    });
    expect(s.jev).toEqual({ decisions: 2, fallbacks: 1 });
    expect(s.milestones).toEqual(["M1 | jobs list | abc1234 | vitest 12/12"]);
    expect(s.live.map((l) => l.name)).toEqual(["reviewer-M1"]);
    expect(s.live[0]?.secs).toBeGreaterThanOrEqual(65);
    expect(s.stateTail.at(-1)).toMatch(/^Next: /);
    expect(s.harness.map((h) => h.nativeMedian)).toEqual([52_000]);

    const screen = formatSummary(s);
    expect(screen).toContain("== Jobs screen");
    expect(screen).toContain("reviewer-M1  gpt-6-sol#high  01:0");
    expect(screen).toContain("2 runs · 1 ok · 3 min");
    expect(screen).toContain("not ok: worker-M1.L2 (failed)");
    expect(screen).toContain("-- jev  2 decisions · 1 fell back\n");
    expect(screen).toContain("-- harness  codex native: median first-turn input ~52k tokens over 1 run");
    expect(screen).toContain("  M1 | jobs list | abc1234 | vitest 12/12");
  });

  test("counts a lane-sourced Jev row as a fallback, like the 1.0 summary", () => {
    const run = createRun(tempRepo(), "Lane fallback", []);
    writeFileSync(
      join(run.dir, "jev.jsonl"),
      `${[
        { schema: 1, kind: "jev" },
        { call: "route", source: "jev" },
        { call: "route", source: "lane" },
        { call: "route", source: "default" },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n")}\n`,
    );
    const s = summarizeRun(run);
    expect(s.jev).toEqual({ decisions: 3, fallbacks: 2 });
    expect(formatSummary(s)).toContain("-- jev  3 decisions · 2 fell back");
  });

  test("reads a run with no records, Jev calls, harness rows or ledger rows", () => {
    const s = summarizeRun(createRun(tempRepo(), "empty", []));
    expect(s.totals.runs).toBe(0);
    expect(s.jev).toEqual({ decisions: 0, fallbacks: 0 });
    expect(s.milestones).toEqual([]);
    expect(s.harness).toEqual([]);
    const screen = formatSummary(s);
    expect(screen).toContain("-- running\n  none");
    expect(screen).toContain("-- harness  no data yet");
  });
});

describe("runsSummary", () => {
  beforeEach(() => withHome());

  test("groups every run's records per role and rung, with refusals and climbs from each rung", () => {
    const a = createRun(tempRepo(), "a", []);
    const b = createRun(tempRepo(), "b", []);
    appendRunRecord(a.dir, fakeRecord("worker-M1.L1", { rung: "gpt-6-luna#high", replyStatus: "refused" }));
    appendRunRecord(a.dir, fakeRecord("worker-M1.L1", { rung: "gpt-6-sol#medium" }));
    appendRunRecord(b.dir, fakeRecord("worker-M1.L1", { rung: "gpt-6-luna#high" }));
    appendRunRecord(b.dir, fakeRecord("reviewer-M1", { role: "reviewer", rung: "gpt-6-sol#high" }));
    appendRoute(a.dir, {
      at: "x",
      lane: "M1.L1",
      role: "worker",
      rung: "gpt-6-sol#medium",
      ladder: [],
      source: "climb",
      from: "gpt-6-luna#high",
      reason: "refused",
      kind: null,
      difficulty: null,
      jev: "default",
    });

    const rows = runsSummary();
    const luna = rows.find((r) => r.role === "worker" && r.rung === "gpt-6-luna#high");
    expect(luna).toMatchObject({ runs: 2, ok: 2, refusals: 1, climbsFrom: 1, secs: 240 });
    expect(rows.map((r) => `${r.role} ${r.rung}`)).toEqual([
      "reviewer gpt-6-sol#high",
      "worker gpt-6-luna#high",
      "worker gpt-6-sol#medium",
    ]);
    expect(runsSummary({ run: b.id }).map((r) => r.runs)).toEqual([1, 1]);
    expect(runsSummary({ role: "reviewer" })).toHaveLength(1);
  });
});

describe("budgetStatus", () => {
  const totals = {
    runs: 1,
    ok: 1,
    notOk: [],
    secs: 1_800,
    tokens: { input: 4_000, cached: 0, output: 1_000 },
    costUsd: 2,
  };

  test("is null with no budget set", () => {
    expect(budgetStatus(totals, undefined)).toBeNull();
  });

  test("reports the highest fraction across the caps the profile set", () => {
    const b = budgetStatus(totals, { minutes: 60, usd: 2 });
    expect(b).toEqual({ fraction: 1, minutes: { spent: 30, cap: 60 }, usd: { spent: 2, cap: 2 } });
    expect(formatBudget(b!)).toBe("30/60 min · $2.00/$2.00 (100%)");
  });

  test("treats any spend against a zero cap as exhausted", () => {
    expect(budgetStatus(totals, { tokens: 0 })?.fraction).toBe(1);
    expect(
      budgetStatus({ ...totals, tokens: { input: 0, cached: 0, output: 0 } }, { tokens: 0 })?.fraction,
    ).toBe(0);
  });
});

describe("summarizeRun budget", () => {
  beforeEach(() => withHome());

  test("shows null with no budget, and the spend line once the active profile sets one", () => {
    const run = createRun(tempRepo(), "t", []);
    appendRunRecord(run.dir, fakeRecord("worker-M1.L1", { secs: 1_800 }));
    expect(summarizeRun(run).budget).toBeNull();

    saveProfile({ ...defaultProfile(), budget: { minutes: 60 } });
    const s = summarizeRun(run);
    expect(s.budget).toEqual({ fraction: 0.5, minutes: { spent: 30, cap: 60 } });
    expect(formatSummary(s)).toContain("-- budget  30/60 min (50%)");
  });
});
