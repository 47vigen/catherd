import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../../src/infra/db.ts";
import type { MilestonePlan } from "../../src/domain/run-events.ts";
import { eventsFile } from "../../src/services/run-events-store.ts";
import type { Run } from "../../src/services/run-store.ts";
import { TEAM_FILE, teamFor, teamMessages, teamRead, teamSend, teamWait } from "../../src/services/team.ts";
import { makeLog, startDispatch, startedFields } from "../domain/run-fixtures.ts";
import { snapshotEnv } from "../helpers.ts";
import { freshRun } from "./helpers.ts";

afterEach(snapshotEnv());

const PLAN: MilestonePlan[] = [
  {
    id: "M1",
    title: "the core",
    after: [],
    lanes: [
      { id: "M1.L3", role: "worker", kind: "repo_code", after: [], owns: ["src/a/"] },
      { id: "M1.L4", role: "worker", kind: "repo_code", after: [], owns: ["src/b/"] },
    ],
  },
];

/** A run whose M1.L4 runs on `ses_M1.L4` and whose M1.L3 waits. */
function fixture(): Run {
  const { run } = freshRun();
  const log = makeLog();
  log.add("run.started", startedFields);
  log.add("plan.ready", { milestones: PLAN });
  startDispatch(log, {
    name: "worker-M1.L4",
    unit: "M1.L4",
    rung: "codex:gpt-6-sol#high",
    thread: "ses_M1.L4",
  });
  writeFileSync(eventsFile(run), log.events.map((e) => `${JSON.stringify(e)}\n`).join(""));
  return run;
}

const send = (run: Run, from: string, to: string, text: string, o?: Parameters<typeof teamSend>[1]) =>
  teamSend({ run: run.id, from, to, text }, o);

describe("the team channel (plan 45)", () => {
  it("keeps a run's messages in the database; an earlier build's team.jsonl stays that run's store (plan 46)", async () => {
    const run = fixture();
    await send(run, "worker-M1.L3", "all", "first");
    expect(existsSync(join(run.dir, TEAM_FILE))).toBe(false);
    expect(db().query("SELECT n, sender, target, text FROM messages WHERE run_id = ?").all(run.id)).toEqual([
      { n: 1, sender: "worker-M1.L3", target: "all", text: "first" },
    ]);
    const old = fixture();
    const line = { n: 1, at: "2026-10-27T10:00:00.000Z", from: "architect", to: "all", text: "old" };
    writeFileSync(join(old.dir, TEAM_FILE), `${JSON.stringify(line)}\n`);
    expect((await send(old, "worker-M1.L3", "all", "next")).n).toBe(2);
    expect(teamMessages(old).map((m) => m.text)).toEqual(["old", "next"]);
    expect(db().query("SELECT count(*) AS n FROM messages WHERE run_id = ?").get(old.id)).toEqual({ n: 0 });
  });

  it("refuses a run whose messages rows and team.jsonl both exist", async () => {
    const run = fixture();
    await send(run, "worker-M1.L3", "all", "first");
    writeFileSync(
      join(run.dir, TEAM_FILE),
      `${JSON.stringify({ n: 1, at: "x", from: "a", to: "all", text: "stray" })}\n`,
    );
    expect(() => teamMessages(run)).toThrow(
      expect.objectContaining({ code: "E_RUN_CORRUPT", message: expect.stringContaining(TEAM_FILE) }),
    );
    await expect(send(run, "worker-M1.L3", "all", "second")).rejects.toMatchObject({ code: "E_RUN_CORRUPT" });
  });

  it("team_send numbers each message and queues it between lanes, running or not", async () => {
    const run = fixture();
    expect(await send(run, "worker-M1.L3", "M1.L4", "src/b/x.ts: I added Operator")).toEqual({
      n: 1,
      delivery: "queued",
    });
    expect(await send(run, "worker-M1.L4", "M1.L3", "thanks")).toEqual({ n: 2, delivery: "queued" });
    expect((await send(run, "worker-M1.L4", "all", "hello   \n  all")).n).toBe(3);
    expect(teamMessages(run).map((m) => m.text)).toEqual([
      "src/b/x.ts: I added Operator",
      "thanks",
      "hello all",
    ]);
    await expect(send(run, "worker-M1.L4", "M1.L3", "  ")).rejects.toMatchObject({ code: "E_INPUT_INVALID" });
    await expect(send(run, "worker-M1.L4", "../etc", "x")).rejects.toMatchObject({ code: "E_INPUT_INVALID" });
  });

  it("only the architect and the owner steer a running lane mid-turn; a lane's message is queued", async () => {
    const run = fixture();
    const seen: string[][] = [];
    const steer = async (backend: string, thread: string, text: string) => {
      seen.push([backend, thread, text]);
      return true;
    };
    expect((await send(run, "worker-M1.L3", "M1.L4", "I changed Foo", { steer })).delivery).toBe("queued");
    expect((await send(run, "architect-M1-1", "M1.L4", "use Operator", { steer })).delivery).toBe("steered");
    expect((await send(run, "owner", "M1.L4", "hurry", { steer })).delivery).toBe("steered");
    expect(seen).toEqual([
      ["codex", "ses_M1.L4", "architect-M1-1 (catherd team #2): use Operator"],
      ["codex", "ses_M1.L4", "owner (catherd team #3): hurry"],
    ]);
  });

  it("team_read pages small: since, limit and a per-message cut", async () => {
    const run = fixture();
    for (const i of [1, 2, 3, 4]) await send(run, "worker-M1.L4", "all", `note ${i} ${"x".repeat(20)}`);
    const first = teamRead({ run: run.id, limit: 3, maxChars: 10 });
    expect(first.messages.map((m) => m.n)).toEqual([1, 2, 3]);
    expect(first.messages[0]?.text).toBe("note 1 xxx…");
    expect(first.next).toBe(3);
    const rest = teamRead({ run: run.id, since: 3 });
    expect(rest.messages.map((m) => m.n)).toEqual([4]);
    expect(rest.next).toBeNull();
  });

  it("team_wait returns at once for a lane that is not running, and times out on one that is", async () => {
    const run = fixture();
    expect(await teamWait({ run: run.id, lane: "M1.L3", timeoutMs: 0 })).toMatchObject({
      status: "pending",
      timedOut: false,
    });
    expect(await teamWait({ run: run.id, lane: "M1.L4", timeoutMs: 0 })).toEqual({
      lane: "M1.L4",
      status: "running",
      timedOut: true,
      posted: [],
    });
    await send(run, "worker-M1.L4", "M1.L3", "Operator is in");
    const r = await teamWait({ run: run.id, lane: "M1.L4", timeoutMs: 0, since: 0 });
    expect(r.timedOut).toBe(false);
    expect(r.posted).toMatchObject([{ n: 1, from: "worker-M1.L4" }]);
    await expect(teamWait({ run: run.id, lane: "M9.L1", timeoutMs: 0 })).rejects.toMatchObject({
      code: "E_INPUT_INVALID",
    });
  });

  it("a dispatch's brief carries the messages sent to it, its role or everyone, after its last start", async () => {
    const run = fixture();
    await send(run, "worker-M1.L4", "M1.L3", "for L3");
    await send(run, "worker-M1.L4", "reviewer", "for the reviewer");
    await send(run, "worker-M1.L3", "all", "my own");
    await send(run, "worker-M1.L4", "all", "for all");
    const d = { name: "worker-M1.L3", unit: "M1.L3", role: "worker" };
    expect(teamFor(run, { ...d, since: null })).toEqual([
      "- #1 worker-M1.L4 → M1.L3: for L3",
      "- #4 worker-M1.L4 → all: for all",
    ]);
    expect(teamFor(run, { ...d, since: "2999-01-01T00:00:00.000Z" })).toEqual([]);
  });

  it("steers a running task by its name, records the kind and the delivery, and queue never steers (plan 47)", async () => {
    const { run } = freshRun();
    const log = makeLog();
    log.add("run.started", startedFields);
    startDispatch(log, {
      name: "T1",
      unit: "T1",
      lane: null,
      rung: "codex:gpt-6-sol#high",
      thread: "ses_T1",
    });
    writeFileSync(eventsFile(run), log.events.map((e) => `${JSON.stringify(e)}\n`).join(""));
    const steer = async () => true;
    expect(
      (await teamSend({ run: run.id, from: "architect", to: "T1", text: "a", mode: "queue" }, { steer }))
        .delivery,
    ).toBe("queued");
    expect(
      (await teamSend({ run: run.id, from: "architect", to: "T1", text: "b", kind: "question" }, { steer }))
        .delivery,
    ).toBe("steered");
    const rows = db()
      .query("SELECT n, kind, mode, delivered_at IS NOT NULL AS delivered FROM messages ORDER BY n")
      .all();
    expect(rows).toEqual([
      { n: 1, kind: "notice", mode: "queue", delivered: 0 },
      { n: 2, kind: "question", mode: "steer", delivered: 1 },
    ]);
    expect(teamRead({ run: run.id, from: "architect" }).messages.map((m) => m.text)).toEqual(["a", "b"]);
    expect(teamRead({ run: run.id, from: "owner" }).messages).toEqual([]);
  });
});
