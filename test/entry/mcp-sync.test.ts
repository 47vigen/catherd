import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startMcpServer } from "../../src/entry/mcp/server.ts";
import { bootLockTarget } from "../../src/infra/boot-lock.ts";
import { locksDir } from "../../src/infra/paths.ts";
import { processStartTime } from "../../src/infra/proc.ts";
import { watching, watchersSettled } from "../../src/services/dispatch-service.ts";
import * as reconcile from "../../src/services/reconcile.ts";
import { createRun, readRecords } from "../../src/services/run-store.ts";
import { claimRun } from "../../src/services/sessions.ts";
import { backgroundSync, type SyncReport } from "../../src/services/source-sync.ts";
import { fakeFetch } from "../fake-fetch.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { call, mcpClient } from "../mcp-helpers.ts";
import { deadProcess, fakeDeps, fakeDispatch, freshRun, waitFor } from "../services/helpers.ts";

afterEach(snapshotEnv());

const REPORT: SyncReport = {
  busy: false,
  sources: [{ source: "arena", state: "fetched", fetchedAt: "2026-09-28T10:00:00.000Z" }],
  newlyScored: ["claude-opus-5-5#high"],
  noLongerNeeded: [{ rung: "gpt-6-sol#high", like: "yardstick#high" }],
  failed: [{ source: "vectara", error: "http 503" }],
  warnings: [],
  unmatched: { arena: ["Kimi K3"] },
};

describe("catalog_sync (spec 1.2 §9)", () => {
  it("syncs, forced when asked, and returns the rungs newly scored, the stand-ins no longer needed and what failed", async () => {
    withHome();
    const asked: { force: boolean; wait?: boolean }[] = [];
    const c = await mcpClient({
      ...fakeDeps(),
      sync: async (o) => {
        asked.push(o);
        return REPORT;
      },
    });
    const r = await call(c, "catalog_sync", { force: true });
    // (1.2 minor) the tool never waits on a running sync: it answers busy
    expect(asked).toEqual([{ force: true, wait: false }]);
    expect(r.data).toEqual({
      newlyScored: ["claude-opus-5-5#high"],
      standInsNoLongerNeeded: [{ rung: "gpt-6-sol#high", like: "yardstick#high" }],
      failed: [{ source: "vectara", error: "http 503" }],
      sources: REPORT.sources,
      warnings: [],
    });
    await call(c, "catalog_sync");
    expect(asked[1]).toEqual({ force: false, wait: false });
  });

  it("says so when another sync was running", async () => {
    withHome();
    const c = await mcpClient({ ...fakeDeps(), sync: async () => ({ ...REPORT, busy: true }) });
    expect((await call(c, "catalog_sync")).data.busy).toBe(
      "another sync was running; call catalog_sync again",
    );
  });
});

describe("one MCP server runs the boot sync and reconcile (plan 22, single-flight)", () => {
  async function server(syncs: string[], label: string): Promise<Client> {
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await startMcpServer({
      transport: serverSide,
      deps: fakeDeps(),
      sync: async () => {
        syncs.push(label);
      },
    });
    const client = new Client({ name: "catherd-test", version: "0.0.0" });
    await client.connect(clientSide);
    // a tool call: the boot work of `initialized` has started by its answer
    expect((await call(client, "status")).isError).toBe(false);
    return client;
  }

  it("lets a second server skip both while the first is alive, and the next lead once it closes", async () => {
    withHome();
    const reconciles = spyOn(reconcile, "reconcileAll");
    try {
      const syncs: string[] = [];
      const first = await server(syncs, "first");
      await waitFor(() => reconciles.mock.calls.length === 1);
      const second = await server(syncs, "second");
      expect(syncs).toEqual(["first"]);
      expect(reconciles.mock.calls).toHaveLength(1);
      expect(readFileSync(`${bootLockTarget()}.lock`, "utf8")).toContain(`"pid":${process.pid}`);
      await first.close();
      const third = await server(syncs, "third");
      await waitFor(() => reconciles.mock.calls.length === 2);
      expect(syncs).toEqual(["first", "third"]);
      await second.close();
      await third.close();
    } finally {
      reconciles.mockRestore();
    }
  });

  it("still watches the live roles of the runs its own session owns when another server leads", async () => {
    const { repo, run } = freshRun();
    const deps = fakeDeps({
      session: { sessionId: "s-me", hostSessionId: null, socketPath: null, token: null },
    });
    expect(await claimRun(deps, run)).toBe(true);
    // a role whose server is gone (the coordinator's server restarted): nothing in this process watches it yet
    const worker = Bun.spawn(["sh", "-c", "read x"], {
      stdin: "pipe",
      env: { PATH: process.env.PATH ?? "" },
    });
    const proc = {
      pid: worker.pid,
      startTime: processStartTime(worker.pid),
      supervisorPid: await deadProcess(),
      supervisorStartTime: "gone",
    };
    const mine = await fakeDispatch(run, {}, { proc, reply: "Done.\nSTATUS: complete — ok" });
    // a run this session does not own is the lead's to reconcile
    const other = createRun({ repo, title: "theirs", aLines: ["A1 it works"], version: "0.0.0-test" });
    const theirs = await fakeDispatch(other, {}, { proc });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await startMcpServer({ transport: serverSide, deps, sync: async () => {}, bootLock: () => null });
    const client = new Client({ name: "claude-code", version: "0.0.0" });
    await client.connect(clientSide);
    try {
      await waitFor(() => watching.has(mine.admit.dispatchId));
      expect(watching.has(theirs.admit.dispatchId)).toBe(false);
      worker.stdin.end();
      await worker.exited;
      await watchersSettled();
      expect(readRecords(run).records.map((r) => r.dispatchId)).toEqual([mine.admit.dispatchId]);
    } finally {
      worker.kill("SIGKILL");
      await client.close();
    }
  });

  it("records the roles of its own session's runs that finished while it was away when another server leads (PR #47 P1)", async () => {
    const { repo, run } = freshRun();
    const deps = fakeDeps({
      session: { sessionId: "s-me", hostSessionId: null, socketPath: null, token: null },
    });
    expect(await claimRun(deps, run)).toBe(true);
    const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };
    const files = { proc: "dead" as const, exit, collect: true, reply: "Done.\nSTATUS: complete — ok" };
    // finished, unrecorded: its server died before it finalized, and the lead reconciled only at its own boot
    const mine = await fakeDispatch(run, {}, files);
    // a run this session does not own is the lead's to reconcile
    const other = createRun({ repo, title: "theirs", aLines: ["A1 it works"], version: "0.0.0-test" });
    await fakeDispatch(other, {}, files);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await startMcpServer({ transport: serverSide, deps, sync: async () => {}, bootLock: () => null });
    const client = new Client({ name: "claude-code", version: "0.0.0" });
    await client.connect(clientSide);
    try {
      await waitFor(() => readRecords(run).records.length > 0);
      await watchersSettled();
      expect(readRecords(run).records.map((r) => r.dispatchId)).toEqual([mine.admit.dispatchId]);
      expect(readRecords(other).records).toEqual([]);
    } finally {
      await client.close();
    }
  });

  it("takes the lock over from a server that died holding it", async () => {
    withHome();
    mkdirSync(locksDir(), { recursive: true });
    writeFileSync(
      `${bootLockTarget()}.lock`,
      JSON.stringify({ pid: await deadProcess(), startTime: "gone" }),
    );
    const syncs: string[] = [];
    const c = await server(syncs, "after a crash");
    await waitFor(() => syncs.length === 1);
    await c.close();
  });
});

describe("the boot sync (spec 1.2 §3.2)", () => {
  it("never delays the handshake or a tool call, even when every source hangs", async () => {
    withHome();
    delete process.env.CATHERD_NO_SYNC;
    const hang = fakeFetch("hang");
    let started = false;
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await startMcpServer({
      transport: serverSide,
      sync: () => {
        started = true;
        return backgroundSync({ transport: { fetchImpl: hang.impl }, aaKey: null });
      },
    });
    const client = new Client({ name: "catherd-test", version: "0.0.0" });
    await client.connect(clientSide);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("catalog_sync");
    expect((await call(client, "status")).isError).toBe(false);
    expect(started).toBe(true);
    // the sync is under way, its requests unanswered
    expect(hang.sent.length).toBeGreaterThan(0);
    await client.close();
  });
});
