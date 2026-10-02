import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostSessionRef } from "../../src/domain/host.ts";
import { readDelivery, writeDeliveryAttempt } from "../../src/infra/delivery.ts";
import { awaitsCollect } from "../../src/infra/dispatch-dir.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { dispatch, watchersSettled } from "../../src/services/dispatch-service.ts";
import { latestDispatch, type Dispatch } from "../../src/services/dispatches.ts";
import { pushFromEnd } from "../../src/services/end-push.ts";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import { finishedNotice, startNotifier } from "../../src/services/notifier.ts";
import { result } from "../../src/services/run-service.ts";
import type { Run } from "../../src/services/run-store.ts";
import { claimRun } from "../../src/services/sessions.ts";
import { snapshotEnv } from "../helpers.ts";
import { simPath, withScenario } from "../sim/scenario.ts";
import { fakeDeps, fakeDispatch, freshRun, waitFor, writeLane } from "./helpers.ts";

afterEach(() => watchersSettled());
afterEach(snapshotEnv());
beforeEach(() => {
  resetReadiness();
  // the preload turns the supervisor's push off for every other test
  delete process.env.CATHERD_NO_END_PUSH;
});

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
const OWNER = "0199c011-1234-7000-8000-000000000001";
const target: HostSessionRef = { host: "codex", sessionId: OWNER, hostSessionId: null, name: null };
const codexDeps = (sessionId = OWNER) =>
  fakeDeps({ host: { host: "codex", session: { ...target, sessionId }, conflict: null } });
const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };

/** A Codex-owned run with one finished, unrecorded dispatch, as its supervisor sees it once the worker exited. */
async function ended(events = "ok-with-reconnect.jsonl"): Promise<{ run: Run; d: Dispatch }> {
  const { run } = freshRun("Push it");
  await claimRun(codexDeps(), run);
  const d = await fakeDispatch(
    run,
    {},
    {
      proc: "dead",
      exit,
      events: readFileSync(join(FX, events), "utf8"),
      reply: "Done.\nSTATUS: complete — ok",
      collect: true,
    },
  );
  return { run, d };
}

function recorder() {
  const sent: { target: HostSessionRef; content: string }[] = [];
  return {
    sent,
    sendCodex: async (t: HostSessionRef, content: string) => {
      sent.push({ target: t, content });
      return { outcome: "accepted" as const, msgId: `m-${sent.length}` };
    },
  };
}

describe("push from where a role ends (plan 22)", () => {
  it("queues the server's notice to the Codex owner under the per-event receipt; the server then sends nothing", async () => {
    const { run, d } = await ended();
    const r = recorder();
    expect(await pushFromEnd(d.dir, { graceMs: 0, sendCodex: r.sendCodex })).toBe("accepted");
    const record = await finalizeDispatch(run, d);
    const notice = finishedNotice(run, d, record);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.target.sessionId).toBe(OWNER);
    expect(r.sent[0]?.content).toContain(`thread: ${record.thread}`);
    expect(r.sent[0]?.content).toContain(`Event: ${notice.eventId}`);
    // one attempt, claimed as submitting before the send and settled to its receipt
    expect(readDelivery(d.dir)).toMatchObject([
      { status: "accepted", msgId: "m-1", eventIds: [notice.eventId] },
    ]);
    // the owner's server reattaches and settles the same record: the receipt stops a second delivery
    const server = recorder();
    const n = startNotifier(codexDeps(), { coalesceMs: 0, sendCodex: server.sendCodex });
    try {
      n.onSettled({ run, d, record, hints: [], started: null, pause: null, stateHints: [] });
      await n.scan();
      await n.idle();
    } finally {
      n.stop();
    }
    expect(server.sent).toEqual([]);
    // queue acceptance is not collection
    expect(awaitsCollect(d.dir)).toBe(true);
  });

  it("sends nothing when the server's push was accepted first", async () => {
    const { run, d } = await ended();
    const record = await finalizeDispatch(run, d);
    const eventId = finishedNotice(run, d, record).eventId;
    writeDeliveryAttempt(d.dir, {
      attemptId: "server",
      target,
      eventIds: [eventId],
      at: new Date().toISOString(),
      status: "accepted",
      msgId: "from-server",
      reason: null,
    });
    const r = recorder();
    expect(await pushFromEnd(d.dir, { graceMs: 0, sendCodex: r.sendCodex })).toBe("delivered");
    expect(r.sent).toEqual([]);
  });

  it("leaves a usage limit to the owner's server, which fails it over first", async () => {
    const { d } = await ended("limit.jsonl");
    const r = recorder();
    expect(await pushFromEnd(d.dir, { graceMs: 0, sendCodex: r.sendCodex })).toBe("limit");
    expect(r.sent).toEqual([]);
  });

  it("does nothing, at once, for a run no Codex thread owns, a record already read, or when turned off", async () => {
    const { run } = freshRun("Claude");
    await claimRun(
      fakeDeps({ session: { sessionId: "s-me", hostSessionId: null, socketPath: null, token: null } }),
      run,
    );
    const d = await fakeDispatch(
      run,
      {},
      { proc: "dead", exit, reply: "x\nSTATUS: complete — ok", collect: true },
    );
    const r = recorder();
    // a grace it would wait out in full: the test's timeout says it never does
    expect(await pushFromEnd(d.dir, { graceMs: 60_000, sendCodex: r.sendCodex })).toBe("not-codex");
    const read = await ended();
    await finalizeDispatch(read.run, read.d);
    await result(codexDeps(), { run: read.run.id, name: read.d.admit.name });
    expect(await pushFromEnd(read.d.dir, { graceMs: 0, sendCodex: r.sendCodex })).toBe("read");
    process.env.CATHERD_NO_END_PUSH = "1";
    const off = await ended();
    expect(await pushFromEnd(off.d.dir, { graceMs: 0, sendCodex: r.sendCodex })).toBe("off");
    expect(r.sent).toEqual([]);
  });

  it("runs from the detached supervisor: codex queue --remote unix:// --thread <owner> when the worker exits", async () => {
    const { run } = freshRun("Push it");
    writeLane(run, "M1.L1", ["src/a.ts"]);
    process.env.PATH = simPath();
    process.env.CATHERD_END_PUSH_GRACE_MS = "0";
    Object.assign(
      process.env,
      withScenario({
        queue: "accepted",
        eventsFile: join(FX, "ok-with-reconnect.jsonl"),
        reply: "Done.\nSTATUS: complete — ok",
      }).env,
    );
    const deps = codexDeps();
    await dispatch(deps, {
      run: run.id,
      role: "worker",
      name: "worker-M1.L1",
      brief: "Read lanes/M1.L1.md",
      rung: "codex:gpt-6-luna#high",
      lane: "M1.L1",
    });
    const d = latestDispatch(run, "worker-M1.L1") as Dispatch;
    // no MCP server notifier runs in this test: only the supervisor can have queued it
    const accepted = await waitFor(() => readDelivery(d.dir).find((a) => a.status === "accepted"));
    expect(accepted).toMatchObject({
      target: { host: "codex", sessionId: OWNER },
      msgId: "01a0f547-7947-7972-90a0-a7ad547170e0",
    });
  });
});
