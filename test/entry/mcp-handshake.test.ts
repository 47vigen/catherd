import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, startMcpServer } from "../../src/entry/mcp/server.ts";
import { appendRecord, readRecords, runPaths } from "../../src/services/run-store.ts";
import { claimRun, runOwner } from "../../src/services/sessions.ts";
import { call } from "../mcp-helpers.ts";
import { fakeDeps, fakeDispatch, freshRun, makeRecord, waitFor } from "../services/helpers.ts";
import * as git from "../../src/infra/git.ts";
import { findRun } from "../../src/services/run-store.ts";
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCHER, mcpHandshake } from "../../src/entry/mcp/handshake.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import * as codexQueue from "../../src/infra/codex-queue.ts";
import { type Notifier } from "../../src/services/notifier.ts";
import * as notifier from "../../src/services/notifier.ts";
import { settle } from "../../src/services/dispatch-service.ts";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import { readDelivery } from "../../src/infra/delivery.ts";

afterEach(snapshotEnv());

it("observes both native request threads for future completion and invalidates membership on reinitialize/close", async () => {
  const { run } = freshRun();
  const deps = fakeDeps();
  const first = "0199c011-1234-7000-8000-000000000001",
    second = "0199c011-1234-7000-8000-000000000002";
  const refs = [first, second].map((sessionId) => ({
    host: "codex" as const,
    sessionId,
    hostSessionId: null,
    name: null,
  }));
  const nextRun = (await import("../../src/services/run-store.ts")).createRun({
    repo: run.meta.repo,
    title: "second",
    aLines: ["A1"],
    version: "0",
  });
  await claimRun(fakeDeps({ host: { host: "codex", session: refs[0]!, conflict: null } }), run);
  await claimRun(fakeDeps({ host: { host: "codex", session: refs[1]!, conflict: null } }), nextRun);
  const contexts: import("../../src/services/ports.ts").Deps[] = [];
  const active: Notifier[] = [];
  const originalStart = notifier.startNotifier;
  const start = spyOn(notifier, "startNotifier").mockImplementation((context) => {
    contexts.push(context);
    const n = originalStart(context, { coalesceMs: 0 });
    active.push(n);
    return n;
  });
  const send = spyOn(codexQueue, "sendToCodexQueue").mockResolvedValue({
    outcome: "accepted",
    msgId: "observed",
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "codex-mcp-client", version: "0" });
  try {
    await startMcpServer({ transport: serverSide, deps, sync: async () => {} });
    await client.connect(clientSide);
    await client.listTools();
    for (const threadId of [first, second])
      await client.callTool({ name: "status", arguments: {}, _meta: { threadId } });
    expect(deps.host).toEqual({ host: "codex", session: null, conflict: null });
    expect(contexts.flatMap((c) => (c.host.session ? [c.host.session.sessionId] : []))).toEqual([
      first,
      second,
    ]);
    for (const r of [run, nextRun]) {
      const d = await fakeDispatch(
        r,
        { name: "worker-M1.L1" },
        {
          proc: "dead",
          collect: true,
          exit: { code: 0, signal: null, reason: "exited", endedAt: new Date().toISOString() },
        },
      );
      await settle(deps, r, d, await finalizeDispatch(r, d));
      await Promise.all(active.map((n) => n.idle()));
      expect(readDelivery(d.dir).at(-1)?.status).toBe("accepted");
    }
    expect(send.mock.calls.map((args) => args[0].sessionId)).toEqual([first, second]);
    await client.notification({ method: "notifications/initialized" });
    await client.listTools();
    expect(contexts.slice(0, 3).every((c) => c.host.host === "unknown")).toBe(true);
    const d = await fakeDispatch(
      run,
      { name: "worker-M1.L2" },
      {
        proc: "dead",
        collect: true,
        exit: { code: 0, signal: null, reason: "exited", endedAt: new Date().toISOString() },
      },
    );
    await settle(deps, run, d, await finalizeDispatch(run, d));
    await Promise.all(active.map((n) => n.idle()));
    expect(send).toHaveBeenCalledTimes(2);
    await client.callTool({ name: "status", arguments: {}, _meta: { threadId: "invalid" } });
    await Promise.all(active.map((n) => n.idle()));
    expect(send).toHaveBeenCalledTimes(2);
    await client.callTool({ name: "status", arguments: {}, _meta: { threadId: first } });
    await Promise.all(active.map((n) => n.idle()));
    expect(send).toHaveBeenCalledTimes(3);
    await client.close();
    expect(contexts.every((c) => c.host.host === "unknown")).toBe(true);
  } finally {
    for (const n of active) n.stop();
    await client.close();
    start.mockRestore();
    send.mockRestore();
  }
});

it("close invalidates an observed thread and drops its pending coalesced completion", async () => {
  const { run } = freshRun();
  const deps = fakeDeps();
  const threadId = "0199c011-1234-7000-8000-000000000001";
  const target = { host: "codex" as const, sessionId: threadId, hostSessionId: null, name: null };
  await claimRun(fakeDeps({ host: { host: "codex", session: target, conflict: null } }), run);
  const original = notifier.startNotifier;
  const active: Notifier[] = [];
  const contexts: import("../../src/services/ports.ts").Deps[] = [];
  const start = spyOn(notifier, "startNotifier").mockImplementation((context) => {
    contexts.push(context);
    const n = original(context, { coalesceMs: 60_000 });
    active.push(n);
    return n;
  });
  const send = spyOn(codexQueue, "sendToCodexQueue").mockResolvedValue({
    outcome: "accepted",
    msgId: "wrong",
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "codex-mcp-client", version: "0" });
  try {
    await startMcpServer({ transport: serverSide, deps, sync: async () => {} });
    await client.connect(clientSide);
    await client.listTools();
    await client.callTool({ name: "status", arguments: {}, _meta: { threadId } });
    const d = await fakeDispatch(
      run,
      {},
      {
        proc: "dead",
        collect: true,
        exit: { code: 0, signal: null, reason: "exited", endedAt: new Date().toISOString() },
      },
    );
    await settle(deps, run, d, await finalizeDispatch(run, d));
    await client.close();
    await Promise.all(active.map((n) => n.idle()));
    expect(contexts.every((c) => c.host.host === "unknown")).toBe(true);
    expect(readDelivery(d.dir)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  } finally {
    for (const n of active) n.stop();
    await client.close();
    start.mockRestore();
    send.mockRestore();
  }
});

it("a conflicting native request cannot become a future delivery target", async () => {
  const { run } = freshRun();
  const first = "0199c011-1234-7000-8000-000000000001",
    second = "0199c011-1234-7000-8000-000000000002";
  process.env.CODEX_THREAD_ID = first;
  const deps = fakeDeps();
  await claimRun(
    fakeDeps({
      host: {
        host: "codex",
        session: { host: "codex", sessionId: second, hostSessionId: null, name: null },
        conflict: null,
      },
    }),
    run,
  );
  const original = notifier.startNotifier;
  const active: Notifier[] = [];
  const start = spyOn(notifier, "startNotifier").mockImplementation((context) => {
    const n = original(context, { coalesceMs: 0 });
    active.push(n);
    return n;
  });
  const send = spyOn(codexQueue, "sendToCodexQueue").mockResolvedValue({
    outcome: "accepted",
    msgId: "wrong",
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "codex-mcp-client", version: "0" });
  try {
    await startMcpServer({ transport: serverSide, deps, sync: async () => {} });
    await client.connect(clientSide);
    await client.listTools();
    await client.callTool({ name: "status", arguments: {}, _meta: { threadId: second } });
    const d = await fakeDispatch(
      run,
      {},
      {
        proc: "dead",
        collect: true,
        exit: { code: 0, signal: null, reason: "exited", endedAt: new Date().toISOString() },
      },
    );
    await settle(deps, run, d, await finalizeDispatch(run, d));
    await Promise.all(active.map((n) => n.idle()));
    expect(readDelivery(d.dir)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(deps.host.session?.sessionId).toBe(first);
  } finally {
    await client.close();
    for (const n of active) n.stop();
    start.mockRestore();
    send.mockRestore();
  }
});

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

describe("native Codex request identity", () => {
  it("keeps two thread IDs scoped across overlapping awaited calls and ignores transport sessionId", async () => {
    const { repo } = freshRun();
    const deps = fakeDeps();
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const server = buildServer(deps);
    await server.connect(serverSide);
    const client = new Client({ name: "codex-mcp-client", version: "0" });
    await client.connect(clientSide);
    await client.listTools();
    const first = "0199c011-1234-7000-8000-000000000001";
    const second = "0199c011-1234-7000-8000-000000000002";
    let entered!: () => void;
    const bothEntered = new Promise<void>((r) => {
      entered = r;
    });
    const releases: (() => void)[] = [];
    const original = git.gitToplevel;
    const mocked = spyOn(git, "gitToplevel").mockImplementation(async (path) => {
      if (path === repo && releases.length < 2) {
        await new Promise<void>((r) => {
          releases.push(r);
          if (releases.length === 2) entered();
        });
        return repo;
      }
      return original(path);
    });
    const start = (threadId: string, title: string) =>
      client.callTool({
        name: "run_start",
        arguments: { repo, title, a_lines: ["A1"] },
        _meta: { threadId, sessionId: "transport-session-is-not-the-thread" },
      });
    try {
      const a = start(first, "first");
      const b = start(second, "second");
      await bothEntered;
      releases[1]!();
      const rb = await b;
      releases[0]!();
      const ra = await a;
      const runOf = (r: typeof ra) => findRun(JSON.parse((r.content as { text: string }[])[0]!.text).run);
      expect(runOf(ra).meta.startedBy).toMatchObject({ host: "codex", sessionId: first });
      expect(runOf(rb).meta.startedBy).toMatchObject({ host: "codex", sessionId: second });
      expect(runOwner(runOf(ra))).toMatchObject({ host: "codex", sessionId: first });
      expect(runOwner(runOf(rb))).toMatchObject({ host: "codex", sessionId: second });
      expect(deps.host).toEqual({ host: "codex", session: null, conflict: null });
      await client.callTool({
        name: "peek",
        arguments: { run: runOf(ra).id },
        _meta: { threadId: "invalid" },
      });
      expect(runOwner(runOf(ra))?.sessionId).toBe(first);
    } finally {
      for (const release of releases) release();
      mocked.mockRestore();
      await client.close();
    }
  });
});

it("reinitialization invalidates an awaited request before it can claim ownership", async () => {
  const { repo } = freshRun();
  const deps = fakeDeps();
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const server = buildServer(deps);
  await server.connect(serverSide);
  const client = new Client({ name: "codex-mcp-client", version: "0" });
  await client.connect(clientSide);
  await client.listTools();
  let entered!: () => void;
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  let release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const original = git.gitToplevel;
  const mocked = spyOn(git, "gitToplevel").mockImplementation(async (path) => {
    if (path === repo) {
      entered();
      await barrier;
      return repo;
    }
    return original(path);
  });
  try {
    const pending = client.callTool({
      name: "run_start",
      arguments: { repo, title: "interrupted", a_lines: ["A1"] },
      _meta: { threadId: "0199c011-1234-7000-8000-000000000001" },
    });
    await waiting;
    process.env.CLAUDE_CODE_SESSION_ID = "contradiction";
    server.server.oninitialized!();
    expect(deps.host.conflict).toBeTruthy();
    release();
    const result = await pending;
    const run = findRun(JSON.parse((result.content as { text: string }[])[0]!.text).run);
    expect(run.meta.startedBy).toBeUndefined();
    expect(runOwner(run)).toBeNull();
  } finally {
    release();
    mocked.mockRestore();
    await client.close();
  }
});

it("conflicts when explicit request threadId contradicts a validated connection target", async () => {
  const { repo } = freshRun();
  const first = "0199c011-1234-7000-8000-000000000001";
  const second = "0199c011-1234-7000-8000-000000000002";
  process.env.CODEX_THREAD_ID = first;
  const deps = fakeDeps();
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const server = buildServer(deps);
  await server.connect(serverSide);
  const client = new Client({ name: "codex-mcp-client", version: "0" });
  try {
    await client.connect(clientSide);
    await client.listTools();
    expect(deps.host.session?.sessionId).toBe(first);
    const start = (threadId: string) =>
      client.callTool({
        name: "run_start",
        arguments: { repo, title: threadId, a_lines: ["A1"] },
        _meta: { threadId, sessionId: second },
      });
    const conflicting = await start(second);
    const run = findRun(JSON.parse((conflicting.content as { text: string }[])[0]!.text).run);
    expect(run.meta.startedBy).toBeUndefined();
    expect(runOwner(run)).toBeNull();
    const matching = await start(first);
    const owned = findRun(JSON.parse((matching.content as { text: string }[])[0]!.text).run);
    expect(runOwner(owned)).toMatchObject({ host: "codex", sessionId: first });
  } finally {
    await client.close();
  }
});
