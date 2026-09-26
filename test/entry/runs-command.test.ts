import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatRun } from "../../src/entry/runs-command.ts";
import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { appendRecord, runPaths } from "../../src/services/run-store.ts";
import type { RunSummary } from "../../src/services/summary.ts";
import { snapshotEnv } from "../helpers.ts";
import { SRC } from "../import-graph.ts";
import { fakeDispatch, freshRun, makeRecord } from "../services/helpers.ts";

afterEach(snapshotEnv());

function catherd(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), ...args], {
    env: { ...process.env, NO_COLOR: "1", ANTHROPIC_API_KEY: "", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
  id: "20260925-1200-app",
  title: "app",
  repo: "/r/app",
  createdAt: "2026-09-25T12:00:00.000Z",
  stateTail: ["Next: dispatch M1.L2"],
  live: [
    { name: "worker-M1.L1", rung: "codex:gpt-6-sol#medium", state: "running", secs: 42, dispatchId: "01J" },
  ],
  totals: {
    runs: 3,
    ok: 2,
    notOk: ["reviewer-M1 (failed)"],
    tokens: { input: 120_000, cached: 90_000, output: 8_000 },
    costUsd: 0.5,
    wallMinutes: 30,
  },
  agents: { runs: 1, totalTokens: 50_000, costUsd: 0 },
  jev: { decisions: 3, fallbacks: 1 },
  budget: { fraction: 0.5, minutes: { spent: 30, cap: 60 } },
  milestones: ["M1 | the parser | abc123 | 12 | bun test"],
  warnings: ["runs.jsonl: skipped 1 unreadable row(s)"],
  ...over,
});

describe("formatRun", () => {
  it("shows what is live, what finished, the spend, the budget and the landings", () => {
    expect(formatRun(summary(), Date.parse("2026-09-25T12:30:00Z"))).toEqual([
      "run 20260925-1200-app  app",
      "  repo /r/app · started 2026-09-25T12:00:00.000Z · 30 min",
      "  live worker-M1.L1  codex:gpt-6-sol#medium  running 42s",
      "  done 3 role run(s), 2 ok; not ok: reviewer-M1 (failed)",
      "  tokens 120,000 in (90,000 cached) · 8,000 out · $0.50 · native agents 1 run(s), 50,000 tokens (reported)",
      "  budget 30/60 min (50%)",
      "  jev 3 decision(s), 1 fallback(s)",
      "  landed M1 | the parser | abc123 | 12 | bun test",
      "  | Next: dispatch M1.L2",
      "  ! runs.jsonl: skipped 1 unreadable row(s)",
    ]);
  });
});

describe("catherd status and watch --once", () => {
  it("prints the run with a live role, as text or JSON", async () => {
    const { run } = freshRun("parser");
    await fakeDispatch(run, {}, { proc: "self" });
    await appendRecord(run, makeRecord({ runId: run.id, name: "reviewer-M1", role: "reviewer", lane: null }));
    const text = catherd(["status"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain(`run ${run.id}  parser\n`);
    expect(text.out).toContain("  live worker-M1.L1  codex:gpt-6-sol#medium  running");
    expect(text.out).toContain("  done 1 role run(s), 1 ok\n");
    const j = JSON.parse(catherd(["watch", "--once", "--json"]).out);
    expect(j.runs.map((r: { id: string }) => r.id)).toEqual([run.id]);
    expect(catherd(["watch", "--once"]).out).toBe(text.out);
  });

  it("names an unknown run with exit 1", () => {
    freshRun();
    const r = catherd(["status", "nope"]);
    expect([r.code, r.err]).toEqual([
      1,
      'error E_RUN_NOT_FOUND: no run "nope"\nfix: status() lists the runs\n',
    ]);
  });

  it("keeps redrawing until Ctrl-C, then exits 130", async () => {
    freshRun();
    const p = Bun.spawn([process.execPath, join(SRC, "cli.ts"), "watch", "--interval", "1"], {
      env: { ...process.env, ANTHROPIC_API_KEY: "" },
      stdout: "pipe",
      stderr: "ignore",
    });
    const reader = p.stdout.getReader();
    let seen = "";
    while (!seen.includes("updated")) seen += new TextDecoder().decode((await reader.read()).value);
    p.kill("SIGINT");
    expect(await p.exited).toBe(130);
  });
});

describe("catherd runs", () => {
  it("lists runs newest first, filters by repo, and warns about a run it cannot read", async () => {
    const { run } = freshRun("parser");
    await fakeDispatch(run, {}, { proc: "self" });
    mkdirSync(join(runPaths(run.dir).meta, "..", "..", "broken"), { recursive: true });
    const r = catherd(["runs", "list"]);
    expect(r.out).toContain(`${run.id}  1 live  0 role run(s)  parser  ${run.meta.repo}\n`);
    expect(r.out).toContain("! skipped run broken:");
    expect(JSON.parse(catherd(["runs", "list", "--repo", "/", "--json"]).out).runs).toEqual([]);
  });

  it("shows a run's records, and with --debug each dispatch's exit and tails, secrets redacted", async () => {
    const { run } = freshRun("parser");
    const d = await fakeDispatch(
      run,
      {},
      {
        exit: { code: 1, signal: null, reason: "exited", endedAt: "2026-09-25T12:01:00.000Z" },
        events: '{"type":"turn.failed"}\n',
      },
    );
    writeFileSync(dispatchPaths(d.dir).stderr, "boom\nauth failed for sk-live-0123456789abc\n");
    await appendRecord(run, makeRecord({ runId: run.id, dispatchId: d.admit.dispatchId, status: "failed" }));
    const r = catherd(["runs", "show", run.id, "--debug"], { OPENAI_API_KEY: "sk-live-0123456789abc" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("  worker-M1.L1  codex:gpt-6-sol#medium  failed/complete  60s  110 tokens\n");
    expect(r.out).toContain(`--- worker-M1.L1 ${d.admit.dispatchId} (codex:gpt-6-sol#medium`);
    expect(r.out).toContain(
      'exit.json: {"code":1,"signal":null,"reason":"exited","endedAt":"2026-09-25T12:01:00.000Z"}',
    );
    expect(r.out).toContain("stderr (last 2 lines):\n  boom\n  auth failed for [redacted]\n");
    expect(r.out).toContain('events (last 1 lines):\n  {"type":"turn.failed"}\n');
    expect(r.out).not.toContain("sk-live-0123456789abc");
  });

  it("refuses to cancel a role that is not live, with exit 1", () => {
    const { run } = freshRun();
    const r = catherd(["runs", "cancel", run.id, "worker-M1.L1"]);
    expect([r.code, r.err.split("\n")[0]]).toEqual([
      1,
      "error E_RUN_NOT_LIVE: worker-M1.L1 has no live dispatch",
    ]);
  });
});
