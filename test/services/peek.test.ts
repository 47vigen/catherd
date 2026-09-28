import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigDir, type SessionEnv } from "../../src/infra/claude-session.ts";
import { awaitsCollect } from "../../src/infra/dispatch-dir.ts";
import { watchersSettled } from "../../src/services/dispatch-service.ts";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import { lastActivity, peek } from "../../src/services/peek.ts";
import { appendAgentRun, createRun } from "../../src/services/run-store.ts";
import { claimRun, runOwner } from "../../src/services/sessions.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { fakeDeps, fakeDispatch, freshRun } from "./helpers.ts";

afterEach(() => watchersSettled());
afterEach(snapshotEnv());

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
const OK_LINES = readFileSync(join(FX, "ok-with-reconnect.jsonl"), "utf8").split("\n").filter(Boolean);
const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };

function session(pid: number, id: string): SessionEnv {
  const dir = join(claudeConfigDir(), "sessions");
  mkdirSync(dir, { recursive: true });
  const socketPath = `/tmp/cc-socks/${pid}.sock`;
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId: id, messagingSocketPath: socketPath }),
  );
  return { sessionId: id, hostSessionId: null, socketPath, token: null };
}

describe("peek (spec §3.7)", () => {
  it("shows each live role with its rung, elapsed time and last command, file edit or message line", async () => {
    const { run } = freshRun("Jobs screen");
    // the worker has run a command so far
    await fakeDispatch(run, {}, { proc: "self", events: `${OK_LINES.slice(0, 5).join("\n")}\n` });
    const { runs } = await peek(fakeDeps(), { run: run.id });
    expect(runs[0]?.live).toEqual([
      {
        name: "worker-M1.L1",
        role: "worker",
        rung: "codex:gpt-6-sol#medium",
        state: "running",
        secs: expect.any(Number),
        lastEvent: "$ /bin/zsh -lc 'cat CLAUDE.md'",
      },
    ]);
  });

  it("reads back past events without one to the last activity, and caps it at 160 characters", async () => {
    const { run } = freshRun();
    const d = await fakeDispatch(run, {}, { proc: "self", events: `${OK_LINES.join("\n")}\n` });
    // the turn.completed line says nothing: the agent message before it is the last activity
    expect(lastActivity(d)).toBe("Done.");
    const long = JSON.stringify({
      type: "item.started",
      item: { id: "i", type: "command_execution", command: "x".repeat(400) },
    });
    const e = await fakeDispatch(
      run,
      { name: "worker-M1.L2", lane: "M1.L2" },
      { proc: "self", events: `${long}\n` },
    );
    const a = lastActivity(e) as string;
    expect(a.length).toBe(160);
    expect(a.endsWith("…")).toBe(true);
    expect(lastActivity(await fakeDispatch(run, { name: "w3", lane: null }, { proc: "self" }))).toBeNull();
  });

  it("lists each finished record not yet read as its message's first line, and never marks it read", async () => {
    const { run } = freshRun("Jobs screen");
    const d = await fakeDispatch(
      run,
      {},
      { proc: "dead", exit, reply: "ok\nSTATUS: complete — ok", collect: true },
    );
    await finalizeDispatch(run, d);
    const first = await peek(fakeDeps(), { run: run.id });
    expect(first.runs[0]?.unread).toEqual([
      {
        name: "worker-M1.L1",
        dispatchId: d.admit.dispatchId,
        header: expect.stringMatching(
          /^catherd · Jobs screen · worker-M1\.L1 worker · codex:gpt-6-sol#medium · \w+ · /,
        ),
      },
    ]);
    expect(awaitsCollect(d.dir)).toBe(true);
    expect((await peek(fakeDeps(), { run: run.id })).runs[0]?.unread).toHaveLength(1);
  });

  it("shows the latest native run and the run's next step, and narrows to one role by name", async () => {
    const { run } = freshRun();
    appendAgentRun(run, {
      at: "2026-09-28T10:00:00.000Z",
      name: "verifier-M1",
      role: "verifier",
      rung: "claude:claude-opus-5-5#low",
      agent: null,
      totalTokens: 10,
      costUsd: null,
      secs: 60,
      status: "ok",
      lane: null,
    });
    await fakeDispatch(run, {}, { proc: "self" });
    await fakeDispatch(run, { name: "reviewer-M1", role: "reviewer", lane: null }, { proc: "self" });
    const all = (await peek(fakeDeps(), { run: run.id })).runs[0];
    expect(all?.native).toEqual({
      name: "verifier-M1",
      role: "verifier",
      rung: "claude:claude-opus-5-5#low",
      status: "ok",
      at: "2026-09-28T10:00:00.000Z",
    });
    expect(all?.next).toBe("plan the milestones");
    expect(all?.live.map((l) => l.name).sort()).toEqual(["reviewer-M1", "worker-M1.L1"]);
    const one = (await peek(fakeDeps(), { run: run.id, name: "reviewer-M1" })).runs[0];
    expect(one?.live.map((l) => l.name)).toEqual(["reviewer-M1"]);
    expect(one?.native).toBeNull();
  });

  it("without a run, shows the runs this session owns, else the newest; with one, takes it over", async () => {
    const { repo, run: older } = freshRun("older");
    const newer = createRun({
      repo,
      title: "newer",
      aLines: ["A1"],
      version: "0",
      now: new Date(Date.now() + 60_000),
    });
    const me = fakeDeps({ session: session(301, "s-me") });
    expect((await peek(me, {})).runs.map((r) => r.title)).toEqual(["newer"]);
    await claimRun(me, older);
    expect((await peek(me, {})).runs.map((r) => r.title)).toEqual(["older"]);
    const other = fakeDeps({ session: session(302, "s-other") });
    await peek(other, { run: newer.id });
    expect(runOwner(newer)?.sessionId).toBe("s-other");
    // peek without a run changes no owner
    await peek(me, {});
    expect(runOwner(newer)?.sessionId).toBe("s-other");
  });

  it("says how to start when there is no run", async () => {
    withHome();
    expect(await peek(fakeDeps(), {})).toEqual({
      runs: [],
      hints: ["no runs yet: run_start(repo, title, a_lines) starts one"],
    });
  });
});
