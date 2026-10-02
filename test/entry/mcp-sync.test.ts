import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startMcpServer } from "../../src/entry/mcp/server.ts";
import { bootLockTarget } from "../../src/infra/boot-lock.ts";
import { locksDir } from "../../src/infra/paths.ts";
import * as reconcile from "../../src/services/reconcile.ts";
import { backgroundSync, type SyncReport } from "../../src/services/source-sync.ts";
import { fakeFetch } from "../fake-fetch.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { call, mcpClient } from "../mcp-helpers.ts";
import { deadProcess, fakeDeps, waitFor } from "../services/helpers.ts";

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
    const asked: { force: boolean }[] = [];
    const c = await mcpClient({
      ...fakeDeps(),
      sync: async (o) => {
        asked.push(o);
        return REPORT;
      },
    });
    const r = await call(c, "catalog_sync", { force: true });
    expect(asked).toEqual([{ force: true }]);
    expect(r.data).toEqual({
      newlyScored: ["claude-opus-5-5#high"],
      standInsNoLongerNeeded: [{ rung: "gpt-6-sol#high", like: "yardstick#high" }],
      failed: [{ source: "vectara", error: "http 503" }],
      sources: REPORT.sources,
      warnings: [],
    });
    await call(c, "catalog_sync");
    expect(asked[1]).toEqual({ force: false });
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
