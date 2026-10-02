import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { COORDINATOR_TOOLS } from "../../src/domain/role-scope.ts";
import { buildServer } from "../../src/entry/mcp/server.ts";
import type { Deps } from "../../src/services/ports.ts";
import { claimRun, readSessionRows, runOwner } from "../../src/services/sessions.ts";
import { snapshotEnv } from "../helpers.ts";
import { call } from "../mcp-helpers.ts";
import { fakeDeps, freshRun } from "../services/helpers.ts";

afterEach(snapshotEnv());

const COORDINATOR = "0199c011-1234-7000-8000-00000000c00d";
const ROLE_THREAD = "0199c011-1234-7000-8000-0000000001e5";
const codex = (sessionId: string) => ({
  host: "codex" as const,
  session: { host: "codex" as const, sessionId, hostSessionId: null, name: null },
  conflict: null,
});

/** A Codex client on the full server, each call on `thread` (as Codex sends `_meta.threadId`). */
async function codexClient(deps: Deps): Promise<Client> {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await buildServer(deps).connect(serverSide);
  const client = new Client({ name: "codex-mcp-client", version: "0" });
  await client.connect(clientSide);
  return client;
}

async function codexCall(client: Client, name: string, args: Record<string, unknown>, thread: string) {
  const r = await client.callTool({ name, arguments: args, _meta: { threadId: thread } });
  return r.isError ? (r.structuredContent as { code: string; fix: string }) : null;
}

describe("a role never owns the run nor reaches the coordinator tools (spec 1.5 plan 21, P1)", () => {
  it("claimRun never claims from a process that carries CATHERD_ROLE", async () => {
    const { run } = freshRun();
    expect(await claimRun(fakeDeps({ host: codex(COORDINATOR) }), run)).toBe(true);
    const role = { ...fakeDeps({ host: codex(ROLE_THREAD) }), role: { run: run.id, name: "verifier-M1" } };
    expect(await claimRun(role, run)).toBe(false);
    expect(runOwner(run)?.sessionId).toBe(COORDINATOR);
    expect(readSessionRows(run).map((r) => r.sessionId)).toEqual([COORDINATOR]);
  });

  it("the full server in a role refuses every coordinator tool with E_ROLE_SCOPE, and the run keeps its owner", async () => {
    const { run } = freshRun();
    await claimRun(fakeDeps({ host: codex(COORDINATOR) }), run);
    const deps: Deps = { ...fakeDeps(), role: { run: run.id, name: "verifier-M1" } };
    const client = await codexClient(deps);
    try {
      // the payment run's P1: the verifier's exec thread called peek({run})
      for (const tool of COORDINATOR_TOOLS) {
        const e = await codexCall(client, tool, { run: run.id, content: "x" }, ROLE_THREAD);
        expect([tool, e?.code]).toEqual([tool, "E_ROLE_SCOPE"]);
        expect(e?.fix).toContain(`catherd run-file read ${run.id}`);
      }
      expect(runOwner(run)?.sessionId).toBe(COORDINATOR);
      // its own dispatch it may peek at, without claiming; reads stay open
      expect(await codexCall(client, "peek", { run: run.id, name: "verifier-M1" }, ROLE_THREAD)).toBeNull();
      expect(await codexCall(client, "status", { run: run.id }, ROLE_THREAD)).toBeNull();
      expect(
        await codexCall(client, "read_run_file", { run: run.id, path: "meta.json" }, ROLE_THREAD),
      ).toBeNull();
      expect(runOwner(run)?.sessionId).toBe(COORDINATOR);
      expect(readSessionRows(run).map((r) => r.sessionId)).toEqual([COORDINATOR]);
    } finally {
      await client.close();
    }
  });

  it("without CATHERD_ROLE the same calls work, and peek claims as before", async () => {
    const { run } = freshRun();
    await claimRun(fakeDeps({ host: codex(COORDINATOR) }), run);
    const client = await codexClient(fakeDeps());
    try {
      expect(await codexCall(client, "peek", { run: run.id }, ROLE_THREAD)).toBeNull();
      expect(runOwner(run)?.sessionId).toBe(ROLE_THREAD);
    } finally {
      await client.close();
    }
  });

  it("each coordinator tool's description says it is the orchestrator's", async () => {
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await buildServer(fakeDeps()).connect(serverSide);
    const client = new Client({ name: "catherd-test", version: "0" });
    await client.connect(clientSide);
    try {
      const tools = (await client.listTools()).tools;
      for (const name of COORDINATOR_TOOLS)
        expect(tools.find((t) => t.name === name)?.description).toStartWith(
          "Orchestrator only (a role process gets E_ROLE_SCOPE).",
        );
      expect(tools.find((t) => t.name === "status")?.description).not.toContain("Orchestrator only");
      expect((await call(client, "status")).isError).toBe(false);
    } finally {
      await client.close();
    }
  });
});
