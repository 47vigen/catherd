import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, startMcpServer } from "../../src/entry/mcp/server.ts";
import { appendRecord, readRecords, runPaths } from "../../src/services/run-store.ts";
import { claimRun, runOwner } from "../../src/services/sessions.ts";
import { call } from "../mcp-helpers.ts";
import { fakeDeps, fakeDispatch, freshRun, makeRecord, waitFor } from "../services/helpers.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCHER, mcpHandshake } from "../../src/entry/mcp/handshake.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

const BIN = join(import.meta.dir, "..", "bin");

describe("doctor's MCP handshake (spec 1.1 §12)", () => {
  it("starts the server through the plugin's launcher", () => {
    expect(LAUNCHER).toBe(join(import.meta.dir, "..", "..", "plugin", "bin", "catherd-mcp"));
  });

  it("answers tools/list through the launcher, which runs the catherd on PATH at its version", async () => {
    // the server reconciles every run it can see: give it a catherd home of its own, never the developer's
    withHome();
    // test/bin/catherd is this checkout: the launcher takes it for the global install
    process.env.PATH = `${BIN}:${join(process.execPath, "..")}:/usr/bin:/bin`;
    process.env.ANTHROPIC_API_KEY = "";
    const h = await mcpHandshake();
    expect(h.ok).toBe(true);
    expect(h.tools).toContain("status");
  }, 60_000);

  it("keeps what the server printed on stderr when it does not start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "catherd-handshake-"));
    const broken = join(dir, "catherd-mcp");
    writeFileSync(
      broken,
      "#!/bin/sh\necho \"error: Cannot find module 'zod' from '/x/src/cli.ts'\" >&2\nexit 1\n",
    );
    chmodSync(broken, 0o755);
    const h = await mcpHandshake({ launcher: broken });
    expect(h.ok).toBe(false);
    expect(h.stderr).toContain("Cannot find module 'zod'");
  }, 60_000);
});

describe("MCP initialization ownership boundary", () => {
  it("initialize_before_scan: startup recovery waits for initialized and reads live host evidence", async () => {
    const { run } = freshRun();
    const d = await fakeDispatch(
      run,
      {},
      {
        proc: "dead",
        exit: {
          code: 0,
          signal: null,
          reason: "exited",
          endedAt: new Date().toISOString(),
        },
      },
    );
    const deps = fakeDeps();
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await startMcpServer({ transport: serverSide, deps, sync: async () => {} });
    expect(readRecords(run).records).toHaveLength(0);
    expect(deps.host).toEqual({ host: "unknown", session: null, conflict: null });
    const id = "0199c011-1234-7000-8000-000000000001";
    process.env.CODEX_THREAD_ID = id;
    const client = new Client({ name: "codex-mcp-client", version: "0" });
    try {
      await client.connect(clientSide);
      await client.listTools();
      expect(deps.host).toMatchObject({ host: "codex", session: { sessionId: id } });
      await waitFor(() => readRecords(run).records[0]);
      expect(readRecords(run).records[0]?.dispatchId).toBe(d.admit.dispatchId);
      expect(runOwner(run)).toBeNull();
    } finally {
      await client.close();
    }
    expect(deps.host).toEqual({ host: "unknown", session: null, conflict: null });
  });

  it("unknown_readonly: unknown and conflicting initialized clients can inspect and collect without taking ownership", async () => {
    for (const clientName of ["catherd-test", "codex-mcp-client"]) {
      const { run } = freshRun();
      const deps = fakeDeps({
        session: { sessionId: "s-owner", hostSessionId: null, socketPath: null, token: null },
      });
      await claimRun(deps, run);
      const before = readFileSync(runPaths(run.dir).stateJson, "utf8");
      const d = await fakeDispatch(run, {}, { collect: true });
      await appendRecord(run, makeRecord({ runId: run.id, dispatchId: d.admit.dispatchId }));
      deps.host = { host: "unknown", session: null, conflict: null };
      if (clientName === "codex-mcp-client") process.env.CLAUDE_CODE_SESSION_ID = "s-other";
      const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
      const server = buildServer(deps);
      await server.connect(serverSide);
      const client = new Client({ name: clientName, version: "0" });
      try {
        await client.connect(clientSide);
        expect((await client.listTools()).tools.some((t) => t.name === "result")).toBe(true);
        expect((await call(client, "status", { run: run.id })).isError).toBe(false);
        expect((await call(client, "peek", { run: run.id })).isError).toBe(false);
        expect(
          (await call(client, "result", { run: run.id, name: d.admit.name })).data.record.dispatchId,
        ).toBe(d.admit.dispatchId);
        expect(readFileSync(runPaths(run.dir).stateJson, "utf8")).toBe(before);
        expect(deps.host.host).toBe("unknown");
        expect(Boolean(deps.host.conflict)).toBe(clientName === "codex-mcp-client");
      } finally {
        await client.close();
      }
    }
  });
});
