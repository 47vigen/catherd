import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEnv } from "../../src/infra/claude-session.ts";
import { claudeHome } from "../../src/infra/paths.ts";
import { awaitsCollect, dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import {
  adopt,
  cancel,
  dispatch,
  settle,
  watch,
  watchersSettled,
} from "../../src/services/dispatch-service.ts";
import { processStartTime } from "../../src/infra/proc.ts";
import * as store from "../../src/infra/store.ts";
import {
  type Dispatch,
  listDispatches,
  liveDispatches,
  readFailover,
} from "../../src/services/dispatches.ts";
import * as finalize from "../../src/services/finalize.ts";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import { type Notifier, startNotifier } from "../../src/services/notifier.ts";
import { peek } from "../../src/services/peek.ts";
import { reconcileAll } from "../../src/services/reconcile.ts";
import { result } from "../../src/services/run-service.ts";
import { createRun, readRecords, type Run } from "../../src/services/run-store.ts";
import { claimRun } from "../../src/services/sessions.ts";
import { sendToInbox } from "../../src/infra/peer-inbox.ts";
import { snapshotEnv, tempRepo } from "../helpers.ts";
import { type FakeInbox, fakeInbox } from "../sim/peer-inbox.ts";
import { simPath, withScenario } from "../sim/scenario.ts";
import { deadProcess, fakeDeps, fakeDispatch, freshRun, testView, waitFor, writeLane } from "./helpers.ts";

afterEach(() => watchersSettled());
afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

let inbox: FakeInbox | null = null;
const notifiers: Notifier[] = [];
afterEach(async () => {
  for (const n of notifiers.splice(0)) n.stop();
  await inbox?.close();
  inbox = null;
});

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
const exit = (code = 0) => ({
  code,
  signal: null,
  reason: "exited" as const,
  endedAt: new Date().toISOString(),
});

/** A live session (registry file and environment) whose inbox is the fake one. */
async function sessionWithInbox(id = "s-me", pid = 201): Promise<SessionEnv> {
  inbox = await fakeInbox();
  const dir = join(claudeHome(), "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId: id, name: "auth build", messagingSocketPath: inbox.path }),
  );
  return { sessionId: id, hostSessionId: null, socketPath: inbox.path, token: "child-token" };
}

/** A finished, recorded, unread dispatch of `run`, as a watcher leaves it before its settle. */
async function finished(run: Run, name: string, reply = "Done.\nSTATUS: complete — ok"): Promise<Dispatch> {
  const d = await fakeDispatch(
    run,
    { name, lane: name.replace(/^worker-/, "") },
    { proc: "dead", exit: exit(), reply, collect: true },
  );
  await finalizeDispatch(run, d);
  return d;
}

async function owned(o: { coalesceMs?: number } = {}) {
  const { run } = freshRun("Auth plan 5 MR B");
  const session = await sessionWithInbox();
  const deps = fakeDeps({ session });
  await claimRun(deps, run);
  const n = startNotifier(deps, { coalesceMs: o.coalesceMs ?? 20 });
  notifiers.push(n);
  return { run, deps, n };
}

const recordOf = async (run: Run, d: Dispatch) => finalizeDispatch(run, d);

describe("the notifier (spec §3.4–§3.6)", () => {
  it("announces a finished role of a run this session owns, at later, and writes notified.json", async () => {
    const { run, deps, n } = await owned();
    const d = await finished(run, "worker-M1.L1");
    await settle(deps, run, d, await recordOf(run, d));
    await n.idle();
    const [f] = await (inbox as FakeInbox).received(1);
    expect(f?.priority).toBe("later");
    expect(f?.auth).toEqual({ type: "auth", token: "child-token" });
    const content = f?.message.content ?? "";
    expect(
      content.startsWith(
        '<cross-session-message from-name="catherd">\ncatherd · Auth plan 5 MR B · worker-M1.L1 worker',
      ),
    ).toBe(true);
    expect(content).toContain("· ok · STATUS: complete · ");
    expect(content).toContain(`Record: result(run: "${run.id}", name: "worker-M1.L1")`);
    expect(JSON.parse(readFileSync(dispatchPaths(d.dir).notified, "utf8"))).toMatchObject({
      schema: 1,
      msgId: f?.msg_id,
    });
    // announced, not read: the record stays unread until result reads it
    expect(awaitsCollect(d.dir)).toBe(true);
  });

  it("sends roles that finish within the window as one message", async () => {
    const { run, deps, n } = await owned({ coalesceMs: 200 });
    const a = await finished(run, "worker-M1.L1");
    const b = await finished(run, "worker-M1.L2");
    await settle(deps, run, a, await recordOf(run, a));
    await settle(deps, run, b, await recordOf(run, b));
    await n.idle();
    const [f] = await (inbox as FakeInbox).received(1);
    expect(inbox?.frames).toHaveLength(1);
    expect(f?.message.content).toContain("catherd · Auth plan 5 MR B · 2 roles finished: M1.L1 ok, M1.L2 ok");
  });

  it("sends a role that finishes after the message went as a message of its own", async () => {
    const { run, deps, n } = await owned();
    const a = await finished(run, "worker-M1.L1");
    await settle(deps, run, a, await recordOf(run, a));
    await n.idle();
    const b = await finished(run, "worker-M1.L2");
    await settle(deps, run, b, await recordOf(run, b));
    await n.idle();
    const frames = await (inbox as FakeInbox).received(2);
    expect(frames.map((f) => f.message.content.split("\n")[1]?.split(" · ")[2])).toEqual([
      "worker-M1.L1 worker",
      "worker-M1.L2 worker",
    ]);
  });

  it("never announces a record twice, across a restart (notified.json)", async () => {
    const { run, deps, n } = await owned();
    const d = await finished(run, "worker-M1.L1");
    await settle(deps, run, d, await recordOf(run, d));
    await n.idle();
    n.stop();
    const again = startNotifier(deps, { coalesceMs: 20 });
    notifiers.push(again);
    await again.scan();
    await settle(deps, run, d, await recordOf(run, d));
    await again.idle();
    await (inbox as FakeInbox).received(1);
    expect(inbox?.frames).toHaveLength(1);
  });

  it("sends one message when two servers of the session announce the same record at once (codex r2)", async () => {
    // a replacement server starting while the old one still watches: both see the record due
    const { run, deps, n } = await owned();
    let calls = 0;
    const counted: typeof sendToInbox = (t, c, p) => {
      calls++;
      return sendToInbox(t, c, p);
    };
    n.stop();
    const a = startNotifier(deps, { coalesceMs: 20, send: counted });
    const b = startNotifier(deps, { coalesceMs: 20, send: counted });
    notifiers.push(a, b);
    const d = await finished(run, "worker-M1.L1");
    await settle(deps, run, d, await recordOf(run, d));
    await Promise.all([a.idle(), b.idle()]);
    await (inbox as FakeInbox).received(1);
    expect(calls).toBe(1);
    expect(inbox?.frames).toHaveLength(1);
    expect(existsSync(dispatchPaths(d.dir).notified)).toBe(true);
    expect(existsSync(`${dispatchPaths(d.dir).notified}.lock`)).toBe(false);
  });

  it("frees its claim when the message cannot go, so a later pass sends it", async () => {
    const { run, deps, n } = await owned();
    n.stop();
    let fail = true;
    const flaky: typeof sendToInbox = (t, c, p) =>
      fail ? Promise.resolve({ outcome: "error", reason: "socket gone" }) : sendToInbox(t, c, p);
    const again = startNotifier(deps, { coalesceMs: 20, send: flaky });
    notifiers.push(again);
    const d = await finished(run, "worker-M1.L1");
    await settle(deps, run, d, await recordOf(run, d));
    await again.idle();
    expect(existsSync(dispatchPaths(d.dir).notified)).toBe(false);
    expect(existsSync(`${dispatchPaths(d.dir).notified}.lock`)).toBe(false);
    fail = false;
    await again.scan();
    await again.idle();
    await (inbox as FakeInbox).received(1);
    expect(inbox?.frames).toHaveLength(1);
    expect(existsSync(dispatchPaths(d.dir).notified)).toBe(true);
  });

  it("announces, on start, every unread record of an owned run that no message announced", async () => {
    const { run, deps } = await owned();
    // finished while no server ran: recorded (by reconcile, say) with no notifier to hear it
    notifiers.splice(0).forEach((x) => x.stop());
    const a = await finished(run, "worker-M1.L1");
    const b = await finished(run, "worker-M1.L2");
    const read = await finished(run, "worker-M1.L3");
    await result(deps, { run: run.id, name: "worker-M1.L3" });
    const n = startNotifier(deps, { coalesceMs: 20 });
    notifiers.push(n);
    await n.scan();
    await n.idle();
    const [f] = await (inbox as FakeInbox).received(1);
    expect(inbox?.frames).toHaveLength(1);
    expect(f?.message.content).toContain("2 roles finished: M1.L1 ok, M1.L2 ok");
    expect([a, b, read].map((d) => existsSync(dispatchPaths(d.dir).notified))).toEqual([true, true, false]);
  });

  it("says nothing of a run another session owns, a run no session owns, or a record already read", async () => {
    const { run, deps, n } = await owned();
    const read = await finished(run, "worker-M1.L1");
    await result(deps, { run: run.id, name: "worker-M1.L1" });
    await settle(deps, run, read, await recordOf(run, read));
    const theirs = freshRun("theirs").run;
    await claimRun(
      fakeDeps({ session: { sessionId: "s-other", hostSessionId: null, socketPath: null, token: null } }),
      theirs,
    );
    const t = await finished(theirs, "worker-M1.L1");
    await settle(deps, theirs, t, await recordOf(theirs, t));
    const nobody = freshRun("nobody's").run;
    const x = await finished(nobody, "worker-M1.L1");
    await settle(deps, nobody, x, await recordOf(nobody, x));
    await n.idle();
    expect(inbox?.frames).toEqual([]);
    expect([read, t, x].map((d) => existsSync(dispatchPaths(d.dir).notified))).toEqual([false, false, false]);
  });

  it("tells a session that took a run over about the live roles another session's server launched", async () => {
    const { run } = freshRun("Auth plan 5 MR B");
    // launched by a server that is gone: nothing in this process watches it
    const worker = Bun.spawn(["sh", "-c", "read x"], { stdin: "pipe", env: process.env });
    const d = await fakeDispatch(
      run,
      { sessionId: "s-before" },
      {
        proc: {
          pid: worker.pid,
          startTime: processStartTime(worker.pid),
          supervisorPid: await deadProcess(),
          supervisorStartTime: "gone",
        },
        reply: "Done.\nSTATUS: complete — ok",
        collect: true,
      },
    );
    const deps = fakeDeps({ session: await sessionWithInbox("s-now", 202) });
    const n = startNotifier(deps, { coalesceMs: 20 });
    notifiers.push(n);
    expect(await claimRun(deps, run)).toBe(true);
    adopt(deps, run);
    worker.stdin.end();
    await worker.exited;
    const [f] = await (inbox as FakeInbox).received(1);
    expect(f?.message.content).toContain(`name: "${d.admit.name}"`);
  });

  it("announces a stalled role once, at next, and not once the role has finished", async () => {
    const { run, n } = await owned();
    const live = await fakeDispatch(run, { name: "worker-M1.L1" }, { proc: "self", collect: true });
    n.onStall({ run, d: live, quietMs: 7 * 60_000 });
    n.onStall({ run, d: live, quietMs: 7 * 60_000 });
    const [f] = await (inbox as FakeInbox).received(1);
    expect(f?.priority).toBe("next");
    expect(f?.message.content).toContain(
      "· worker-M1.L1 worker · codex:gpt-6-sol#medium · stalled: no output for 7 min · running ",
    );
    expect(f?.message.content).toContain(`Peek: peek(run: "${run.id}", name: "worker-M1.L1")`);
    expect(existsSync(dispatchPaths(live.dir).stallNotified)).toBe(true);
    n.onStall({ run, d: live, quietMs: 7 * 60_000 });
    const done = await finished(run, "worker-M1.L2");
    n.onStall({ run, d: done, quietMs: 60_000 });
    await n.idle();
    expect(inbox?.frames).toHaveLength(1);
  });

  it("keeps going when writing a message down fails: a later notice still goes out", async () => {
    const { run, deps, n } = await owned();
    const real = store.writeJsonAtomic;
    const spy = spyOn(store, "writeJsonAtomic").mockImplementation((file, value, o) => {
      if (file.endsWith("notified.json")) {
        spy.mockImplementation(real);
        throw new Error("ENOSPC: no space left on device");
      }
      real(file, value, o);
    });
    try {
      const a = await finished(run, "worker-M1.L1");
      await settle(deps, run, a, await recordOf(run, a));
      await n.idle();
      const b = await finished(run, "worker-M1.L2");
      await settle(deps, run, b, await recordOf(run, b));
      await n.idle();
      const frames = await (inbox as FakeInbox).received(2);
      expect(frames[1]?.message.content).toContain(`name: "worker-M1.L2"`);
      expect(existsSync(dispatchPaths(b.dir).notified)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("drops a notice whose record was read before the message went out", async () => {
    const { run, deps, n } = await owned({ coalesceMs: 200 });
    const d = await finished(run, "worker-M1.L1");
    await settle(deps, run, d, await recordOf(run, d));
    // the orchestrator read it (a peek showed it, say) inside the window
    await result(deps, { run: run.id, name: "worker-M1.L1" });
    await n.idle();
    expect(inbox?.frames).toEqual([]);
    expect(existsSync(dispatchPaths(d.dir).notified)).toBe(false);
  });

  it("drops what it queued for a run another session claimed inside the window; the new owner hears it", async () => {
    const { run, deps, n } = await owned({ coalesceMs: 200 });
    const live = await fakeDispatch(run, { name: "worker-M1.L2" }, { proc: "self", collect: true });
    const theirs = await fakeInbox();
    try {
      const dir = join(claudeHome(), "sessions");
      writeFileSync(
        join(dir, "203.json"),
        JSON.stringify({ pid: 203, sessionId: "s-next", name: "next", messagingSocketPath: theirs.path }),
      );
      const next = fakeDeps({
        session: { sessionId: "s-next", hostSessionId: null, socketPath: theirs.path, token: "next-token" },
      });
      const m = startNotifier(next, { coalesceMs: 20 });
      notifiers.push(m);
      const d = await finished(run, "worker-M1.L1");
      await settle(deps, run, d, await recordOf(run, d));
      n.onStall({ run, d: live, quietMs: 7 * 60_000 });
      // the run moves inside the old owner's window: the claim settles the unannounced record again for s-next
      await peek(next, { run: run.id });
      await n.idle();
      await m.idle();
      expect(existsSync(dispatchPaths(live.dir).stallNotified)).toBe(false);
      const [f] = await theirs.received(1);
      expect(inbox?.frames).toEqual([]);
      expect(f?.auth).toEqual({ type: "auth", token: "next-token" });
      expect(f?.message.content).toContain(`name: "worker-M1.L1"`);
      expect(JSON.parse(readFileSync(dispatchPaths(d.dir).notified, "utf8"))).toMatchObject({
        msgId: f?.msg_id,
      });
    } finally {
      // the stalled role ends, so the watcher the claim started settles
      store.writeJsonAtomic(dispatchPaths(live.dir).exit, { schema: 1, ...exit() });
      await theirs.close();
    }
  });

  it("announces a role cancelled from the dashboard or the CLI at later, but not one the MCP cancel returned", async () => {
    const { run, deps, n } = await owned();
    process.env.PATH = simPath();
    Object.assign(process.env, withScenario({ hangMs: 30_000 }).env);
    writeLane(run, "M1.L1", ["src/a.ts"]);
    writeLane(run, "M1.L2", ["src/b.ts"]);
    const go = (lane: string) =>
      dispatch(deps, {
        run: run.id,
        role: "worker",
        name: `worker-${lane}`,
        brief: "b",
        rung: "codex:gpt-6-sol#medium",
        lane,
      });
    const running = (name: string) =>
      waitFor(() => liveDispatches(run).find((d) => d.admit.name === name && d.state === "running"));
    // the TUI's ctrl+d and `catherd runs cancel`: nobody holds the record, so the owner is told
    await go("M1.L1");
    const a = await running("worker-M1.L1");
    await cancel(deps, run.id, "worker-M1.L1");
    const [f] = await (inbox as FakeInbox).received(1);
    expect(f?.priority).toBe("later");
    expect(f?.message.content).toContain("· worker-M1.L1 worker · codex:gpt-6-sol#medium · cancelled ·");
    expect(awaitsCollect(a.dir)).toBe(true);
    await n.idle();
    // the MCP tool: its caller holds the record, so there is nothing to announce
    await go("M1.L2");
    const b = await running("worker-M1.L2");
    await cancel(deps, run.id, "worker-M1.L2", { read: true });
    await watchersSettled();
    await n.idle();
    expect(inbox?.frames).toHaveLength(1);
    expect(awaitsCollect(b.dir)).toBe(false);
  });

  it("announces a blocked or refused reply at next", async () => {
    const { run, deps } = await owned();
    const d = await finished(run, "worker-M1.L1", "Cannot.\nSTATUS: blocked — no network");
    await settle(deps, run, d, await recordOf(run, d));
    const [f] = await (inbox as FakeInbox).received(1);
    expect(f?.priority).toBe("next");
    expect(f?.message.content).toContain("STATUS: blocked");
  });

  it("sends nothing without a session, and the record stays unread", async () => {
    const { run } = freshRun();
    const deps = fakeDeps();
    const n = startNotifier(deps, { coalesceMs: 20 });
    notifiers.push(n);
    const d = await finished(run, "worker-M1.L1");
    await settle(deps, run, d, await recordOf(run, d));
    await n.scan();
    await n.idle();
    expect(existsSync(dispatchPaths(d.dir).notified)).toBe(false);
    expect(awaitsCollect(d.dir)).toBe(true);
  });

  it("writes nothing when the session's socket is gone: the record waits for peek or result", async () => {
    const { run, deps, n } = await owned();
    await inbox?.close();
    inbox = null;
    const d = await finished(run, "worker-M1.L1");
    await settle(deps, run, d, await recordOf(run, d));
    await n.idle();
    expect(existsSync(dispatchPaths(d.dir).notified)).toBe(false);
  });

  it("fails over a usage limit first, then says so at next; the stand-in's record follows at later", async () => {
    const release = join(mkdtempSync(join(tmpdir(), "catherd-hold-")), "release");
    const { run } = freshRun("Auth plan 5 MR B");
    process.env.PATH = simPath();
    Object.assign(
      process.env,
      withScenario({
        byRung: {
          "gpt-6-sol#medium": { eventsFile: join(FX, "limit.jsonl"), exitCode: 1 },
          "gpt-6-sol#high": { reply: "Done.\nSTATUS: complete — ok", holdUntil: release },
        },
      }).env,
    );
    writeLane(run, "M1.L1", ["src/a.ts"]);
    const session = await sessionWithInbox();
    const deps = fakeDeps({
      session,
      view: testView({ failover: { "codex:gpt-6-sol#medium": "codex:gpt-6-sol#high" } }),
    });
    const n = startNotifier(deps, { coalesceMs: 20 });
    notifiers.push(n);
    await dispatch(deps, {
      run: run.id,
      role: "worker",
      name: "worker-M1.L1",
      brief: "b",
      rung: "codex:gpt-6-sol#medium",
      lane: "M1.L1",
    });
    const [limit] = await (inbox as FakeInbox).received(1);
    expect(limit?.priority).toBe("next");
    expect(limit?.message.content).toContain(
      "· limit on codex:gpt-6-sol#medium; failed over to codex:gpt-6-sol#high · no STATUS ·",
    );
    writeFileSync(release, "");
    const frames = await (inbox as FakeInbox).received(2);
    expect(frames[1]?.priority).toBe("later");
    expect(frames[1]?.message.content).toContain("· codex:gpt-6-sol#high · ok · STATUS: complete ·");
  });
});

describe("a claim settles what the run's earlier owner left (spec §3.3/§3.4)", () => {
  const LIMIT = { eventsFile: join(FX, "limit.jsonl"), exitCode: 1 };
  const FAILOVER = { "codex:gpt-6-sol#medium": "codex:gpt-6-sol#high" };
  const other = (sessionId: string) =>
    fakeDeps({ session: { sessionId, hostSessionId: null, socketPath: null, token: null } });

  /** A usage limit recorded, unread and never failed over, as a server that died before settling it left it. */
  async function limitedOnDisk(run: Run): Promise<Dispatch> {
    const d = await fakeDispatch(
      run,
      {},
      { proc: "dead", exit: exit(1), events: readFileSync(LIMIT.eventsFile, "utf8"), collect: true },
    );
    expect((await finalizeDispatch(run, d)).status).toBe("limit");
    return d;
  }

  // a failed test still lets its held stand-in finish, before the file's hook waits for the watchers
  const releases: string[] = [];
  afterEach(() => {
    for (const r of releases.splice(0)) writeFileSync(r, "");
  });

  function scenario(): string {
    const release = join(mkdtempSync(join(tmpdir(), "catherd-hold-")), "release");
    releases.push(release);
    process.env.PATH = simPath();
    Object.assign(
      process.env,
      withScenario({
        byRung: {
          "gpt-6-sol#medium": LIMIT,
          "gpt-6-sol#high": { reply: "Done.\nSTATUS: complete — ok", holdUntil: release },
        },
      }).env,
    );
    return release;
  }

  it("starts no stand-in at start for a limit of a run nobody or another session owns; a claim settles it once", async () => {
    const release = scenario();
    const { run } = freshRun("Auth plan 5 MR B");
    writeLane(run, "M1.L1", ["src/a.ts"]);
    const d = await limitedOnDisk(run);
    const theirs = createRun({
      repo: tempRepo(),
      title: "theirs",
      aLines: ["A1 it works"],
      version: "0.0.0-test",
    });
    writeLane(theirs, "M1.L1", ["src/a.ts"]);
    await claimRun(other("s-other"), theirs);
    const t = await limitedOnDisk(theirs);
    const deps = fakeDeps({ session: await sessionWithInbox(), view: testView({ failover: FAILOVER }) });
    const n = startNotifier(deps, { coalesceMs: 20 });
    notifiers.push(n);
    await reconcileAll(deps);
    await n.scan();
    await n.idle();
    expect([readFailover(d.dir), readFailover(t.dir)]).toEqual([null, null]);
    expect([listDispatches(run).length, listDispatches(theirs).length]).toEqual([1, 1]);
    expect(inbox?.frames).toEqual([]);
    // this session takes the run over: its limit fails over now, once, and this session hears of it
    await peek(deps, { run: run.id });
    expect(readFailover(d.dir)?.standIn?.rung).toBe("codex:gpt-6-sol#high");
    const [f] = await (inbox as FakeInbox).received(1);
    expect(f?.message.content).toContain(
      "· limit on codex:gpt-6-sol#medium; failed over to codex:gpt-6-sol#high ·",
    );
    await peek(deps, { run: run.id });
    await reconcileAll(deps);
    expect(listDispatches(run)).toHaveLength(2);
    expect(listDispatches(theirs)).toHaveLength(1);
    writeFileSync(release, "");
    await watchersSettled();
  });

  it("announces, when a dispatch takes the run over, a record the earlier owner settled but never announced", async () => {
    const release = scenario();
    const { run } = freshRun("Auth plan 5 MR B");
    writeLane(run, "M1.L2", ["src/b.ts"]);
    await claimRun(other("s-before"), run);
    // recorded and settled by the earlier owner's server, which never got to tell its session
    const left = await finished(run, "worker-M1.L1");
    const deps = fakeDeps({ session: await sessionWithInbox("s-now", 204) });
    const n = startNotifier(deps, { coalesceMs: 20 });
    notifiers.push(n);
    await dispatch(deps, {
      run: run.id,
      role: "worker",
      name: "worker-M1.L2",
      brief: "b",
      rung: "codex:gpt-6-sol#high",
      lane: "M1.L2",
    });
    const [f] = await (inbox as FakeInbox).received(1);
    expect(f?.message.content).toContain(`name: "${left.admit.name}"`);
    await n.idle();
    expect(existsSync(dispatchPaths(left.dir).notified)).toBe(true);
    writeFileSync(release, "");
    await watchersSettled();
  });

  it("settles and announces a role that finished unrecorded, unwatched, when this session dispatches again", async () => {
    const release = scenario();
    const { run } = freshRun("Auth plan 5 MR B");
    writeLane(run, "M1.L2", ["src/b.ts"]);
    const deps = fakeDeps({ session: await sessionWithInbox("s-now", 205) });
    await claimRun(deps, run);
    // this session already owns the run; the role's watcher is gone (its finalize threw, say)
    const left = await fakeDispatch(
      run,
      { sessionId: "s-now" },
      { proc: "dead", exit: exit(), reply: "Done.\nSTATUS: complete — ok", collect: true },
    );
    const n = startNotifier(deps, { coalesceMs: 20 });
    notifiers.push(n);
    await dispatch(deps, {
      run: run.id,
      role: "worker",
      name: "worker-M1.L2",
      brief: "b",
      rung: "codex:gpt-6-sol#high",
      lane: "M1.L2",
    });
    expect(readRecords(run).records.map((r) => r.dispatchId)).toEqual([left.admit.dispatchId]);
    const [f] = await (inbox as FakeInbox).received(1);
    expect(f?.message.content).toContain(`name: "${left.admit.name}"`);
    writeFileSync(release, "");
    await watchersSettled();
  });

  it("records, settles and announces, on a peek by its owner, a role whose watcher failed to finalize it", async () => {
    const { run, deps, n } = await owned();
    const d = await fakeDispatch(
      run,
      {},
      { proc: "dead", exit: exit(), reply: "Done.\nSTATUS: complete — ok", collect: true },
    );
    const spy = spyOn(finalize, "finalizeDispatch").mockImplementationOnce(() => {
      throw new Error("EIO: i/o error");
    });
    try {
      watch(deps, run, d);
      await watchersSettled();
    } finally {
      spy.mockRestore();
    }
    expect(readRecords(run).records).toEqual([]);
    // the same session peeks: nothing about the owner changes, the finished role is still taken care of
    await peek(deps, { run: run.id });
    expect(readRecords(run).records.map((r) => r.dispatchId)).toEqual([d.admit.dispatchId]);
    const [f] = await (inbox as FakeInbox).received(1);
    expect(f?.message.content).toContain(`name: "${d.admit.name}"`);
    await n.idle();
    expect(existsSync(dispatchPaths(d.dir).notified)).toBe(true);
    // a second peek finds nothing left: no second message
    await peek(deps, { run: run.id });
    await n.idle();
    expect(inbox?.frames).toHaveLength(1);
  });

  it("records, settles and announces a role that finished unrecorded when a dispatch takes the run over", async () => {
    const release = scenario();
    const { run } = freshRun("Auth plan 5 MR B");
    writeLane(run, "M1.L2", ["src/b.ts"]);
    await claimRun(other("s-before"), run);
    // finished after its server died: no record yet, nobody told
    const left = await fakeDispatch(
      run,
      { sessionId: "s-before" },
      { proc: "dead", exit: exit(), reply: "Done.\nSTATUS: complete — ok", collect: true },
    );
    const deps = fakeDeps({ session: await sessionWithInbox("s-now", 203) });
    const n = startNotifier(deps, { coalesceMs: 20 });
    notifiers.push(n);
    await dispatch(deps, {
      run: run.id,
      role: "worker",
      name: "worker-M1.L2",
      brief: "b",
      rung: "codex:gpt-6-sol#high",
      lane: "M1.L2",
    });
    expect(readRecords(run).records.map((r) => r.dispatchId)).toEqual([left.admit.dispatchId]);
    const [f] = await (inbox as FakeInbox).received(1);
    expect(f?.message.content).toContain(`name: "${left.admit.name}"`);
    await n.idle();
    expect(existsSync(dispatchPaths(left.dir).notified)).toBe(true);
    writeFileSync(release, "");
    await watchersSettled();
  });
});
