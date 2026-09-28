import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startMcpServer } from "../../src/entry/mcp/server.ts";
import { backgroundSync, type SyncReport } from "../../src/services/source-sync.ts";
import { fakeFetch } from "../fake-fetch.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { call, mcpClient } from "../mcp-helpers.ts";
import { fakeDeps } from "../services/helpers.ts";

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
