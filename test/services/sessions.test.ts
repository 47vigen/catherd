import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEnv } from "../../src/infra/claude-session.ts";
import { lockHeld } from "../../src/infra/filelock.ts";
import { claudeHome } from "../../src/infra/paths.ts";
import * as store from "../../src/infra/store.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { dispatch, settle, watchersSettled } from "../../src/services/dispatch-service.ts";
import { listDispatches } from "../../src/services/dispatches.ts";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import { startRun } from "../../src/services/run-service.ts";
import { findRun, readRecords, runPaths } from "../../src/services/run-store.ts";
import { claimRun, currentSession, readSessionRows, runOwner } from "../../src/services/sessions.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { simPath, withScenario } from "../sim/scenario.ts";
import { fakeDeps, fakeDispatch, freshRun, testView, writeLane } from "./helpers.ts";

afterEach(() => watchersSettled());
afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

/** A live session's registry file (pid `pid`), and the environment its MCP server would get. */
function session(pid: number, id: string, name: string, host: string | null = null): SessionEnv {
  const dir = join(claudeHome(), "sessions");
  mkdirSync(dir, { recursive: true });
  const socketPath = `/tmp/cc-socks/${pid}.sock`;
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId: id, name, messagingSocketPath: socketPath, status: "idle" }),
  );
  return { sessionId: id, hostSessionId: host, socketPath, token: "t" };
}

describe("session identity and run ownership (spec §3.3)", () => {
  it("records the starting session in meta.json and makes it the owner", async () => {
    withHome();
    const repo = tempRepo();
    const deps = fakeDeps({ session: session(101, "s-a", "auth build", "desktop-1") });
    const { run } = await startRun(deps, { repo, title: "t", aLines: ["A1"] });
    const r = findRun(run);
    expect(r.meta.startedBy).toEqual({
      host: "claude-code",
      sessionId: "s-a",
      hostSessionId: "desktop-1",
      name: "auth build",
    });
    expect(runOwner(r)).toEqual({ host: "claude-code", sessionId: "s-a", since: expect.any(String) });
    expect(readSessionRows(r)).toEqual([
      {
        host: "claude-code",
        sessionId: "s-a",
        hostSessionId: "desktop-1",
        name: "auth build",
        at: expect.any(String),
      },
    ]);
  });

  it("records nothing outside Claude Code", async () => {
    withHome();
    const repo = tempRepo();
    const { run } = await startRun(fakeDeps(), { repo, title: "t", aLines: ["A1"] });
    const r = findRun(run);
    expect(r.meta.startedBy).toBeUndefined();
    expect(runOwner(r)).toBeNull();
    expect(existsSync(runPaths(r.dir).sessions)).toBe(false);
  });

  it("reads the live session id from the registry, not the one the environment had before /clear", () => {
    withHome();
    const env = session(102, "after-clear", "renamed");
    const deps = fakeDeps({ session: { ...env, sessionId: "before-clear" } });
    expect(currentSession(deps)).toEqual({
      host: "claude-code",
      sessionId: "after-clear",
      hostSessionId: null,
      name: "renamed",
    });
    // no registry file: the environment's id, no name
    expect(currentSession(fakeDeps({ session: { ...env, socketPath: "/nowhere", sessionId: "x" } }))).toEqual(
      {
        host: "claude-code",
        sessionId: "x",
        hostSessionId: null,
        name: null,
      },
    );
  });

  it("moves the run to a session that continues it, once, and keeps the trail in sessions.jsonl", async () => {
    const { run } = freshRun();
    const a = fakeDeps({ session: session(103, "s-a", "first") });
    const b = fakeDeps({ session: session(104, "s-b", "second") });
    expect(await claimRun(a, run)).toBe(true);
    expect(await claimRun(a, run)).toBe(false);
    expect(await claimRun(b, run)).toBe(true);
    expect(runOwner(run)?.sessionId).toBe("s-b");
    expect(readSessionRows(run).map((r) => r.sessionId)).toEqual(["s-a", "s-b"]);
    // the owner lives in state.json beside the notes, which keep their fields
    expect(JSON.parse(readFileSync(runPaths(run.dir).stateJson, "utf8"))).toMatchObject({
      schema: 1,
      owner: { sessionId: "s-b" },
    });
  });

  it("repairs a trail a crash left without the owner's row, once, when the owner calls again", async () => {
    const { run } = freshRun();
    const a = fakeDeps({ session: session(107, "s-a", "first") });
    const b = fakeDeps({ session: session(108, "s-b", "second") });
    expect(await claimRun(a, run)).toBe(true);
    // the crash: state.json names s-b, the trail never got its row
    const notes = JSON.parse(readFileSync(runPaths(run.dir).stateJson, "utf8"));
    writeFileSync(
      runPaths(run.dir).stateJson,
      JSON.stringify({ ...notes, owner: { sessionId: "s-b", since: new Date().toISOString() } }),
    );
    expect(readSessionRows(run).map((r) => r.sessionId)).toEqual(["s-a"]);
    expect(await claimRun(b, run)).toBe(false);
    expect(readSessionRows(run).map((r) => r.sessionId)).toEqual(["s-a", "s-b"]);
    expect(await claimRun(b, run)).toBe(false);
    expect(readSessionRows(run).map((r) => r.sessionId)).toEqual(["s-a", "s-b"]);
    // a trail lost whole comes back with its owner's row
    rmSync(runPaths(run.dir).sessions);
    expect(await claimRun(b, run)).toBe(false);
    expect(await claimRun(b, run)).toBe(false);
    expect(readSessionRows(run).map((r) => r.sessionId)).toEqual(["s-b"]);
  });

  it("appends the trail row under the state.json lock, so its last row is always the owner", async () => {
    const { run } = freshRun();
    const held: boolean[] = [];
    const real = store.appendJsonl;
    const spy = spyOn(store, "appendJsonl").mockImplementation((file, row) => {
      if (file === runPaths(run.dir).sessions) held.push(lockHeld(runPaths(run.dir).stateJson));
      real(file, row);
    });
    try {
      await claimRun(fakeDeps({ session: session(105, "s-a", "first") }), run);
      await claimRun(fakeDeps({ session: session(106, "s-b", "second") }), run);
    } finally {
      spy.mockRestore();
    }
    expect(held).toEqual([true, true]);
    expect(readSessionRows(run).at(-1)?.sessionId).toBe(runOwner(run)?.sessionId as string);
  });

  it("stamps the dispatching session on admit.json and the record, and takes the run over on dispatch", async () => {
    const { run } = freshRun();
    process.env.PATH = simPath();
    Object.assign(process.env, withScenario({ reply: "ok\nSTATUS: complete — ok" }).env);
    writeLane(run, "M1.L1", ["src/a.ts"]);
    const deps = fakeDeps({ session: session(105, "s-d", "dispatcher") });
    await dispatch(deps, {
      run: run.id,
      role: "worker",
      name: "worker-M1.L1",
      brief: "b",
      rung: "codex:gpt-6-luna#high",
      lane: "M1.L1",
    });
    await watchersSettled();
    expect(listDispatches(run)[0]?.admit.sessionId).toBe("s-d");
    expect(readRecords(run).records[0]?.sessionId).toBe("s-d");
    expect(runOwner(run)?.sessionId).toBe("s-d");
  });

  it("gives a failover stand-in the limited dispatch's session, whoever fails it over", async () => {
    const { run } = freshRun();
    process.env.PATH = simPath();
    Object.assign(process.env, withScenario({ reply: "ok\nSTATUS: complete — ok" }).env);
    writeLane(run, "M1.L1", ["src/a.ts"]);
    const exit = { code: 1, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };
    const events = readFileSync(
      join(import.meta.dir, "..", "fixtures", "adapters", "codex", "limit.jsonl"),
      "utf8",
    );
    const d = await fakeDispatch(
      run,
      { sessionId: "s-owner" },
      { proc: "dead", exit, events, collect: true },
    );
    const record = await finalizeDispatch(run, d);
    expect(record.sessionId).toBe("s-owner");
    const other = fakeDeps({
      view: testView({ failover: { "codex:gpt-6-sol#medium": "codex:gpt-6-sol#high" } }),
      session: session(106, "s-other", "another"),
    });
    const s = await settle(other, run, d, record);
    const stand = listDispatches(run).find((x) => x.admit.dispatchId === s.started?.dispatchId);
    expect(stand?.admit.sessionId).toBe("s-owner");
  });
});

describe("host namespaces", () => {
  it("same_id_different_hosts and cross_host_claim keep ownership distinct", async () => {
    const { run } = freshRun();
    const claude = fakeDeps({
      host: {
        host: "claude-code",
        session: { host: "claude-code", sessionId: "same", hostSessionId: null, name: null },
        conflict: null,
      },
    });
    const codex = fakeDeps({
      host: {
        host: "codex",
        session: { host: "codex", sessionId: "same", hostSessionId: null, name: null },
        conflict: null,
      },
    });
    expect(await claimRun(claude, run)).toBe(true);
    expect(await claimRun(codex, run)).toBe(true);
    expect(runOwner(run)).toMatchObject({ host: "codex", sessionId: "same" });
    expect(readSessionRows(run).map((s) => s.host)).toEqual(["claude-code", "codex"]);
    expect(await claimRun(fakeDeps(), run)).toBe(false);
  });
});

it("legacy_host_decode: reads legacy owner, trail and origin without rewriting files", async () => {
  const { run } = freshRun();
  const paths = runPaths(run.dir);
  writeFileSync(
    paths.stateJson,
    JSON.stringify({
      schema: 1,
      next: "",
      lastCheck: null,
      lastLandedAt: null,
      owner: { sessionId: "legacy", since: "then", future: 3 },
    }),
  );
  writeFileSync(
    paths.sessions,
    '{"kind":"sessions","schema":1}\n{"sessionId":"legacy","hostSessionId":null,"name":null,"at":"then","future":3}\n',
  );
  const state = readFileSync(paths.stateJson, "utf8");
  const trail = readFileSync(paths.sessions, "utf8");
  expect(runOwner(run)).toMatchObject({ host: "claude-code", sessionId: "legacy", future: 3 });
  expect(readSessionRows(run)[0]).toMatchObject({ host: "claude-code", future: 3 });
  expect(readFileSync(paths.stateJson, "utf8")).toBe(state);
  expect(readFileSync(paths.sessions, "utf8")).toBe(trail);
});

it("new Codex origins survive another host taking ownership", async () => {
  const { repo } = freshRun();
  process.env.PATH = simPath();
  Object.assign(process.env, withScenario({ reply: "ok\nSTATUS: complete — ok" }).env);
  const deps = fakeDeps({
    host: {
      host: "codex",
      session: { host: "codex", sessionId: "same", hostSessionId: null, name: "Codex" },
      conflict: null,
    },
  });
  const started = await startRun(deps, { repo, title: "Codex", aLines: ["A1"] });
  const run = findRun(started.run);
  expect(run.meta.startedBy).toMatchObject({ host: "codex", sessionId: "same" });
  await dispatch(deps, { run: run.id, role: "worker", name: "w", brief: "b", rung: "codex:gpt-6-luna#high" });
  await watchersSettled();
  await claimRun(
    fakeDeps({ session: { sessionId: "same", hostSessionId: null, socketPath: null, token: null } }),
    run,
  );
  expect(runOwner(run)).toMatchObject({ host: "claude-code", sessionId: "same" });
  expect(listDispatches(run)[0]?.admit).toMatchObject({ host: "codex", sessionId: "same" });
  expect(readRecords(run).records[0]).toMatchObject({ host: "codex", sessionId: "same" });
});
