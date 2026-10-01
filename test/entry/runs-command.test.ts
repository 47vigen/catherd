import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatRun, redrawMs } from "../../src/entry/runs-command.ts";
import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { appendRecord, createRun, runPaths } from "../../src/services/run-store.ts";
import type { RunSummary } from "../../src/services/summary.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { SRC } from "../import-graph.ts";
import { fakeDispatch, freshRun, makeRecord } from "../services/helpers.ts";
import { saveJevKey } from "../../src/services/jev-service.ts";

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
  delivery: [],
  id: "20260925-1200-app",
  title: "app",
  repo: "/r/app",
  createdAt: "2026-09-25T12:00:00.000Z",
  session: null,
  continuedIn: null,
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
  harness: [
    { backend: "claude-code", native: 0, isolated: 1 },
    { backend: "codex", native: 2, isolated: 0 },
  ],
  budget: { fraction: 0.5, minutes: { spent: 30, cap: 60 } },
  milestones: ["M1 | the parser | abc123 | 12 | bun test"],
  verifier: null,
  questions: [],
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
      "  harness claude-code 0 native, 1 isolated · codex 2 native, 0 isolated",
      "  budget 30/60 min (50%)",
      "  jev 3 decision(s), 1 fallback(s)",
      "  landed M1 | the parser | abc123 | 12 | bun test",
      "  | Next: dispatch M1.L2",
      "  ! runs.jsonl: skipped 1 unreadable row(s)",
    ]);
  });
});

describe("redrawMs", () => {
  it("defaults to 2 s and clamps to the 1 s floor, 0 included", () => {
    expect([undefined, "0", "0.5", "5"].map(redrawMs)).toEqual([2000, 1000, 1000, 5000]);
  });

  it("refuses an interval that is not a number of seconds (audit N10)", () => {
    for (const bad of ["", "x", "-3", "2s"])
      expect(() => redrawMs(bad)).toThrow(expect.objectContaining({ code: "E_INPUT_INVALID" }));
  });

  it("makes watch exit 2 on a bad --interval, before it prints anything", () => {
    withHome();
    expect(catherd(["watch", "--once", "--interval", "abc"])).toEqual({
      code: 2,
      out: "",
      err: 'error E_INPUT_INVALID: --interval takes a number of seconds, not "abc"\nfix: catherd watch --interval <seconds>\n',
    });
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
    // two CLI spawns read the wall clock apart: the elapsed times may tick between them, nothing else
    const clockless = (out: string) =>
      out.replace(/running \d+s/g, "running <n>s").replace(/ · \d+ min\n/g, " · <n> min\n");
    expect(clockless(catherd(["watch", "--once"]).out)).toBe(clockless(text.out));
  });

  it("names an unknown run with exit 1", () => {
    freshRun();
    const r = catherd(["status", "nope"]);
    expect([r.code, r.err]).toEqual([1, 'error E_RUN_NOT_FOUND: no run "nope"\nfix: catherd runs list\n']);
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
    while (!seen.includes("updated")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`watch exited before its first redraw: ${seen}`);
      seen += new TextDecoder().decode(chunk.value);
    }
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
    expect(JSON.parse(catherd(["runs", "list", "--repo", tempRepo(), "--json"]).out).runs).toEqual([]);
    expect(JSON.parse(catherd(["runs", "list", "--repo", run.meta.repo, "--json"]).out).runs).toHaveLength(1);
  });

  it("groups the runs by the session that drove them, as status does, and --json gains the session", () => {
    const { run: old } = freshRun("before 1.1");
    const moved = createRun({
      repo: old.meta.repo,
      title: "kit clean-up",
      aLines: ["A1"],
      version: "0",
      startedBy: { sessionId: "s-a", hostSessionId: "desktop-1", name: "auth build" },
    });
    writeFileSync(
      runPaths(moved.dir).sessions,
      `{"kind":"sessions","schema":1}\n${JSON.stringify({ sessionId: "s-b", hostSessionId: null, name: "follow-up", at: new Date().toISOString() })}\n`,
    );
    const text = catherd(["runs", "list"]).out;
    expect(text).toContain("session · idle  follow-up\n");
    expect(text).toContain(
      `  ${moved.id}  idle  0 role run(s)  kit clean-up  ${moved.meta.repo}  (continued here)\n`,
    );
    expect(text).toContain("session · idle  auth build\n");
    expect(text).toContain("(continued in follow-up)\n");
    expect(text.trimEnd().split("\n").at(-1)).toContain("before 1.1");
    expect(text).toContain("earlier runs\n");
    const rows = JSON.parse(catherd(["runs", "list", "--json"]).out).runs as {
      id: string;
      session: unknown;
      continuedIn: string | null;
    }[];
    expect(rows.find((r) => r.id === moved.id)).toMatchObject({
      session: { sessionId: "s-a", hostSessionId: "desktop-1", name: "auth build", live: false },
      continuedIn: "follow-up",
    });
    expect(rows.find((r) => r.id === old.id)?.session).toBeNull();
    const status = catherd(["status", moved.id]).out;
    expect(status.startsWith("session · idle  auth build\n")).toBe(true);
    expect(status).toContain(`run ${moved.id}  kit clean-up  (continued in follow-up)\n`);
  });

  it("refuses --repo outside a git repository with exit 2", () => {
    freshRun();
    const r = catherd(["runs", "list", "--repo", "/"]);
    expect([r.code, r.err.split("\n")[0]]).toEqual([
      2,
      "error E_INPUT_INVALID: / is not inside a git repository",
    ]);
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

  it("redacts the summary and the records too, not only the dispatches, as JSON and as text", async () => {
    const { run } = freshRun("parser");
    const secret = "sk-live-0123456789abc";
    writeFileSync(runPaths(run.dir).state, `# state\nNext: retry after auth failed for ${secret}\n`);
    await appendRecord(run, makeRecord({ runId: run.id, replyWhy: `auth failed for ${secret}` }));
    for (const format of [["--json"], []]) {
      const r = catherd(["runs", "show", run.id, "--debug", ...format], { OPENAI_API_KEY: secret });
      expect(r.code).toBe(0);
      expect(r.out).toContain("auth failed for [redacted]");
      expect(r.out).not.toContain(secret);
    }
  });

  it("redacts the state.md tail in status and watch --once, as runs show does", () => {
    const { run } = freshRun("parser");
    const secret = "sk-live-0123456789abc";
    writeFileSync(runPaths(run.dir).state, `# state\nNext: retry after auth failed for ${secret}\n`);
    for (const argv of [
      ["status", run.id],
      ["status", "--json"],
      ["watch", "--once"],
    ]) {
      const r = catherd(argv, { OPENAI_API_KEY: secret });
      expect(r.code).toBe(0);
      expect(r.out).toContain("auth failed for [redacted]");
      expect(r.out).not.toContain(secret);
    }
  });

  it("redacts the saved Jev key, which a fresh process never registered by calling Jev", async () => {
    const { run } = freshRun("parser");
    const key = "ts-live-0123456789abcdef";
    saveJevKey(key);
    const d = await fakeDispatch(run, {}, {});
    writeFileSync(dispatchPaths(d.dir).stderr, `echoed ${key}\n`);
    await appendRecord(run, makeRecord({ runId: run.id, replyWhy: `saw ${key}` }));
    const r = catherd(["runs", "show", run.id, "--debug", "--json"], { TYPESAFE_API_KEY: "" });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain(key);
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

import { writeDeliveryAttempt } from "../../src/infra/delivery.ts";
import { awaitsCollect } from "../../src/infra/dispatch-dir.ts";
import { claimRun, runOwner } from "../../src/services/sessions.ts";
import { fakeDeps } from "../services/helpers.ts";
import { simPath, withScenario } from "../sim/scenario.ts";

it("retry_requires_explicit_decision, canonical stored event and validated current owner", async () => {
  const { run } = freshRun();
  const target = {
    host: "codex" as const,
    sessionId: "01a0f53b-a47d-7350-83a4-c3430e453404",
    hostSessionId: null,
    name: null,
  };
  const deps = fakeDeps({ host: { host: "codex", session: target, conflict: null } });
  await claimRun(deps, run);
  const before = runOwner(run);
  const d = await fakeDispatch(run, {}, { collect: true });
  await appendRecord(run, makeRecord({ runId: run.id, dispatchId: d.admit.dispatchId }));
  const eventId = JSON.stringify([run.id, d.admit.dispatchId, "finished"]);
  writeDeliveryAttempt(d.dir, {
    attemptId: "one",
    target,
    eventIds: [eventId],
    at: "2026-10-01T12:00:00.000Z",
    status: "ambiguous",
    msgId: null,
    reason: "unknown",
  });
  const envTo = join(process.env.CATHERD_HOME!, "retry-calls");
  const s = withScenario({ queue: "accepted", envTo });
  const env = {
    ...s.env,
    PATH: simPath(),
    CODEX_THREAD_ID: target.sessionId,
    CATHERD_ORCHESTRATION_HOST: "codex",
  };
  const args = ["runs", "retry-push", run.id, d.admit.name, "--event", eventId];
  expect(catherd(args, env).code).toBe(2);
  expect(catherd([...args, "--acknowledge-possible-duplicate"], { ...env, CODEX_THREAD_ID: "" }).code).toBe(
    2,
  );
  expect(
    catherd(
      [
        "runs",
        "retry-push",
        run.id,
        d.admit.name,
        "--event",
        JSON.stringify(["other", d.admit.dispatchId, "finished"]),
        "--acknowledge-possible-duplicate",
      ],
      env,
    ).code,
  ).toBe(2);
  const retry = catherd([...args, "--acknowledge-possible-duplicate", "--json"], env);
  expect(retry.code).toBe(0);
  expect(JSON.parse(retry.out)).toMatchObject({ eventId, delivery: "enqueue-accepted" });
  const sent = () =>
    readFileSync(envTo, "utf8")
      .trim()
      .split("\n")
      .map((s) => JSON.parse(s))
      .filter((c) => c.args.includes("--message"));
  expect(sent()).toHaveLength(1);
  expect(catherd([...args, "--acknowledge-possible-duplicate"], env).code).toBe(0);
  expect(sent()).toHaveLength(1);
  expect(awaitsCollect(d.dir)).toBe(true);
  expect(runOwner(run)).toEqual(before);
  const status = JSON.parse(catherd(["status", run.id, "--json"], env).out);
  expect(status.runs[0].delivery[0]).toMatchObject({ eventId, delivery: "enqueue-accepted" });
  expect(status.host.host).toBe("codex");
  expect(status.queue.server).toBe("unverified");
  const textStatus = catherd(["status", run.id], env).out;
  expect(textStatus).toContain("host codex");
  // a one-shot status never waits on the Codex CLI: doctor reports the queue capability
  expect(textStatus).toContain("queue unchecked · Native codex queue is not checked by this command");
});

it("a one-shot status on codex never runs the Codex CLI for the queue capability", async () => {
  const { run } = freshRun();
  const envTo = join(process.env.CATHERD_HOME!, "status-calls");
  const s = withScenario({ queue: "accepted", envTo });
  const env = {
    ...s.env,
    PATH: simPath(),
    CODEX_THREAD_ID: "01a0f53b-a47d-7350-83a4-c3430e453404",
    CATHERD_ORCHESTRATION_HOST: "codex",
  };
  const r = catherd(["status", run.id, "--json"], env);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out).queue).toMatchObject({
    cli: false,
    reason: expect.stringContaining("catherd doctor"),
  });
  expect(existsSync(envTo)).toBe(false);
});
