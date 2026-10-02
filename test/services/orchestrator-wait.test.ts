import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeHome } from "../../src/infra/paths.ts";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import {
  ORCHESTRATOR_STALL_MS,
  orchestratorWait,
  WAIT_WINDOW_MS,
  waitingLine,
} from "../../src/services/orchestrator-wait.ts";
import { createRun, type Run } from "../../src/services/run-store.ts";
import { claimRun } from "../../src/services/sessions.ts";
import { status } from "../../src/services/summary.ts";
import { snapshotEnv, tempRepo } from "../helpers.ts";
import { fakeDeps, fakeDispatch, freshRun } from "./helpers.ts";

afterEach(snapshotEnv());

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const THREAD = "0199c011-1234-7000-8000-000000000001";

const codexOwner = (at: number) =>
  fakeDeps({
    host: {
      host: "codex",
      session: { host: "codex", sessionId: THREAD, hostSessionId: null, name: null },
      conflict: null,
    },
    now: () => at,
  });

/** A finished, recorded, unread dispatch that ended at `ended`, admitted by `sessionId` when given. */
async function unreadAt(run: Run, name: string, ended: number, sessionId?: string) {
  const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: iso(ended) };
  const d = await fakeDispatch(
    run,
    { name, lane: null, admittedAt: iso(ended - 60_000), ...(sessionId ? { sessionId, host: "codex" } : {}) },
    { proc: "dead", exit, reply: "Done.\nSTATUS: complete — ok", collect: true },
  );
  await finalizeDispatch(run, d);
  return d;
}

describe("waiting for orchestrator (plan 22, #42 findings 3 and 7)", () => {
  it("shows for a current owner and a recent unread record, and turns stalled after five minutes", async () => {
    const { run } = freshRun("Push it");
    await claimRun(codexOwner(NOW - 2 * HOUR), run);
    await unreadAt(run, "worker-a", NOW - 10 * 60_000, THREAD);
    const w = orchestratorWait(run, NOW);
    expect(w).toMatchObject({ since: iso(NOW - 10 * 60_000), seconds: 600, stalled: true, unread: 1 });
    expect(waitingLine(w, NOW)).toBe("stalled · waiting for orchestrator 600s");
    expect(waitingLine(w, Date.parse(w!.since) + ORCHESTRATOR_STALL_MS - 1000)).toBe(
      "waiting for orchestrator 299s",
    );
  });

  it("never shows for an unread record that ended more than a day ago: an abandoned run is not stalled forever", async () => {
    const { run } = freshRun("Abandoned");
    await claimRun(codexOwner(NOW - 30 * HOUR), run);
    await unreadAt(run, "worker-a", NOW - 25 * HOUR, THREAD);
    expect(orchestratorWait(run, NOW)).toBeNull();
  });

  it("never shows for an owner not seen in a day, and does once one of its dispatches is recent", async () => {
    const { run } = freshRun("Old owner");
    await claimRun(codexOwner(NOW - 3 * 24 * HOUR), run);
    // a record a dashboard cancel left unread, from no session of the owner's
    await unreadAt(run, "worker-a", NOW - HOUR);
    expect(orchestratorWait(run, NOW)).toBeNull();
    await unreadAt(run, "worker-b", NOW - 2 * HOUR, THREAD.toUpperCase());
    expect(orchestratorWait(run, NOW)?.unread).toBe(2);
  });

  it("shows for a live Claude Code owner however long ago it took the run", async () => {
    const { run } = freshRun("Live owner");
    const dir = join(claudeHome(), "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: "s-live" }),
    );
    const deps = fakeDeps({
      session: { sessionId: "s-live", hostSessionId: null, socketPath: null, token: null },
      now: () => NOW - 3 * 24 * HOUR,
    });
    await claimRun(deps, run);
    await unreadAt(run, "worker-a", NOW - HOUR);
    const w = orchestratorWait(run, NOW);
    expect(w?.until).toBe(iso(NOW - HOUR + WAIT_WINDOW_MS));
    // the line ages out on its own, between two recomputes
    expect(waitingLine(w, NOW - HOUR + WAIT_WINDOW_MS)).toBeNull();
  });

  it("status() without a run: the live runs, else the waiting runs, else the newest", async () => {
    const { run: waiting } = freshRun("Waiting");
    await claimRun(codexOwner(Date.now() - HOUR), waiting);
    await unreadAt(waiting, "worker-a", Date.now() - 60_000, THREAD);
    // one home for all three runs
    const another = (title: string) =>
      createRun({ repo: tempRepo(), title, aLines: ["A1 it works"], version: "0.0.0-test" });
    const stale = another("Stale");
    await claimRun(codexOwner(Date.now() - 50 * HOUR), stale);
    await unreadAt(stale, "worker-a", Date.now() - 49 * HOUR, THREAD);
    const deps = fakeDeps();
    expect(status(deps).runs.map((r) => r.id)).toEqual([waiting.id]);
    const live = another("Live");
    await fakeDispatch(live, { name: "worker-l", lane: null }, { proc: "self" });
    expect(status(deps).runs.map((r) => r.id)).toEqual([live.id]);
  });
});
