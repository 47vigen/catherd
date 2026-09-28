import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeHome } from "../../src/infra/paths.ts";
import { appendLedger, appendRecord, createRun, runPaths } from "../../src/services/run-store.ts";
import { roleDetail, sessionDetail, sessionRows } from "../../src/services/runs-page.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { fakeDeps, fakeDispatch, makeRecord, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };

/** Two runs of one live session (this process stands in for it), one of them continued by another session. */
async function twoRuns() {
  withHome();
  const repo = tempRepo();
  mkdirSync(join(claudeHome(), "sessions"), { recursive: true });
  writeFileSync(
    join(claudeHome(), "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: "s-auth", name: "auth build" }),
  );
  const startedBy = { sessionId: "s-auth", hostSessionId: null, name: "auth build" };
  const at = (m: number) => new Date(Date.now() - m * 60_000);
  const jobs = createRun({
    repo,
    title: "Jobs screen",
    aLines: ["A1"],
    version: "0",
    now: at(10),
    startedBy,
  });
  const moved = createRun({
    repo,
    title: "Auth refactor",
    aLines: ["A1"],
    version: "0",
    now: at(20),
    startedBy,
  });
  writeFileSync(
    runPaths(moved.dir).sessions,
    `{"kind":"sessions","schema":1}\n${JSON.stringify({ sessionId: "s-kit", hostSessionId: null, name: "kit follow-up", at: new Date().toISOString() })}\n`,
  );
  appendLedger(jobs, "M0 | scaffold the jobs screen | 3f2a9c1 | 9 | bun test");
  writeLane(jobs, "M1.L1", ["src/a.ts"]);
  writeLane(jobs, "M1.L2", ["src/b.ts"]);
  writeLane(jobs, "M2.L1", ["src/c.ts"]);
  const live = await fakeDispatch(
    jobs,
    { name: "worker-M1.L2", lane: "M1.L2" },
    { proc: "self", events: `${readLines("ok-with-reconnect.jsonl").slice(0, 5).join("\n")}\n` },
  );
  const done = await fakeDispatch(jobs, {}, { proc: "dead", exit, reply: "Done.\nSTATUS: complete — ok" });
  await appendRecord(jobs, makeRecord({ runId: jobs.id, dispatchId: done.admit.dispatchId, secs: 190 }));
  return { jobs, moved, live, done };
}

const readLines = (f: string) => readFileSync(join(FX, f), "utf8").split("\n").filter(Boolean);

describe("the runs page (spec §4)", () => {
  it("lists the sessions, newest activity first, with their runs, live roles and landings", async () => {
    await twoRuns();
    const { rows } = sessionRows(fakeDeps());
    expect(rows).toEqual([
      {
        key: "s-auth",
        name: "auth build",
        live: true,
        runs: 2,
        liveRoles: 1,
        landed: 1,
        lastActivity: expect.any(String),
      },
      {
        key: "s-kit",
        name: "kit follow-up",
        live: false,
        runs: 1,
        liveRoles: 0,
        landed: 0,
        lastActivity: expect.any(String),
      },
    ]);
  });

  it("opens a session: its runs newest first, their milestones, every role, live ones first", async () => {
    const { jobs, moved, live, done } = await twoRuns();
    const s = sessionDetail(fakeDeps(), "s-auth");
    expect(s.runs.map((r) => [r.title, r.continued, r.continuedIn])).toEqual([
      ["Jobs screen", null, null],
      ["Auth refactor", "elsewhere", "kit follow-up"],
    ]);
    expect(s.dirs.sort()).toEqual([jobs.dir, moved.dir].sort());
    const j = s.runs[0];
    expect(j?.milestones).toEqual([
      { name: "M0", landed: true, what: "scaffold the jobs screen" },
      { name: "M1", landed: false, what: "" },
      { name: "M2", landed: false, what: "" },
    ]);
    expect(j?.roles).toEqual([
      {
        run: jobs.id,
        dispatchId: live.admit.dispatchId,
        name: "worker-M1.L2",
        role: "worker",
        rung: "codex:gpt-6-sol#medium",
        status: "running",
        live: true,
        since: live.admit.admittedAt,
        secs: null,
        lastEvent: "$ /bin/zsh -lc 'cat CLAUDE.md'",
        replyStatus: null,
      },
      {
        run: jobs.id,
        dispatchId: done.admit.dispatchId,
        name: "worker-M1.L1",
        role: "worker",
        rung: "codex:gpt-6-sol#medium",
        status: "ok",
        live: false,
        since: done.admit.admittedAt,
        secs: 190,
        lastEvent: null,
        replyStatus: "complete",
      },
    ]);
  });

  it("opens a role: its brief, reply and record", async () => {
    const { jobs, done } = await twoRuns();
    const r = roleDetail(fakeDeps(), jobs.id, done.admit.dispatchId);
    expect(r).toMatchObject({
      run: jobs.id,
      runTitle: "Jobs screen",
      name: "worker-M1.L1",
      state: "finished",
      brief: "brief",
      reply: "Done.\nSTATUS: complete — ok",
      record: { dispatchId: done.admit.dispatchId, status: "ok" },
    });
    expect(() => roleDetail(fakeDeps(), jobs.id, "nope")).toThrow(/no dispatch nope/);
  });

  it("puts 1.0 runs under earlier runs, last", async () => {
    await twoRuns();
    const repo = tempRepo();
    createRun({ repo, title: "old", aLines: ["A1"], version: "0" });
    const { rows } = sessionRows(fakeDeps());
    expect(rows.at(-1)).toMatchObject({ key: null, name: "earlier runs", runs: 1 });
    expect(sessionDetail(fakeDeps(), null).runs.map((r) => r.title)).toEqual(["old"]);
  });
});
