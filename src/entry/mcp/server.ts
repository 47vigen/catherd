import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorMessage } from "../../domain/errors.ts";
import { log } from "../../infra/log.ts";
import { startNotifier } from "../../services/notifier.ts";
import type { Deps } from "../../services/ports.ts";
import { reconcileAll } from "../../services/reconcile.ts";
import { backgroundSync } from "../../services/source-sync.ts";
import { defaultDeps } from "../deps.ts";
import { registerDispatchTools } from "./dispatch-tools.ts";
import { registerLaneTools } from "./lane-tools.ts";
import { registerProtocolTools } from "./protocol-tools.ts";
import { sdkToolError, toolOf } from "./result.ts";
import { registerRunTools } from "./run-tools.ts";
import { registerSetupTools } from "./setup-tools.ts";

type Handler = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;

/** Spec §10.2: every tool call is logged with its duration and outcome (the error code), never its input. */
function logToolCalls(server: McpServer): void {
  const register = server.registerTool.bind(server) as unknown as (
    n: string,
    c: unknown,
    h: Handler,
  ) => unknown;
  (server as unknown as { registerTool: typeof register }).registerTool = (name, config, handler) =>
    register(name, config, async (...args: unknown[]) => {
      const started = Date.now();
      const r = await handler(...args);
      const code = r.isError ? (r.structuredContent as { code?: string } | undefined)?.code : undefined;
      log(r.isError ? "warn" : "info", "tool", {
        tool: name,
        ms: Date.now() - started,
        ok: !r.isError,
        code,
      });
      return r;
    });
}

export function buildServer(deps: Deps = defaultDeps()): McpServer {
  const server = new McpServer({ name: "catherd", version: deps.version });
  logToolCalls(server);
  // The SDK validates input before a tool's `handle` runs and reports a failure through this (private)
  // method as plain text; test/entry/mcp.test.ts fails loudly if an SDK upgrade renames it. The wrapper
  // above never sees such a call, so it is logged here (spec §10.2: every call), by the tool it names.
  (server as unknown as { createToolError: typeof sdkToolError }).createToolError = (message) => {
    const r = sdkToolError(message);
    const code = (r.structuredContent as { code?: string } | undefined)?.code;
    log("warn", "tool", { tool: toolOf(message), ok: false, code });
    return r;
  };
  registerRunTools(server, deps);
  registerLaneTools(server, deps);
  registerDispatchTools(server, deps);
  registerSetupTools(server, deps);
  registerProtocolTools(server, deps);
  return server;
}

/**
 * Spec §4.7: connect first, so the client never waits on a scan; then reconcile every run. Spec §3.4: the notifier
 * starts before reconcile, so what reconcile settles is announced, and scans for the rest once it is done. Spec
 * 1.2 §3.2: the source sync starts once connected and is never awaited, so neither the handshake nor a tool call
 * waits on the network. Tests pass their own transport and sync.
 */
export async function startMcpServer(
  o: { transport?: Transport; sync?: () => Promise<unknown> } = {},
): Promise<void> {
  const deps = defaultDeps();
  // which of the session's variables this server got (never their values): the live check of spec §3.9
  log("info", "session", {
    sessionId: Boolean(deps.session?.sessionId),
    hostSessionId: Boolean(deps.session?.hostSessionId),
    socket: Boolean(deps.session?.socketPath),
    token: Boolean(deps.session?.token),
  });
  const notifier = startNotifier(deps);
  await buildServer(deps).connect(o.transport ?? new StdioServerTransport());
  const sync = o.sync ?? (() => backgroundSync());
  void Promise.resolve()
    .then(sync)
    .catch((e: unknown) => log("debug", "sources", { error: errorMessage(e) }));
  try {
    const r = await reconcileAll(deps);
    const shown = r.warnings.length;
    for (const w of r.warnings) console.error(`catherd: ${w}`);
    void r.done.then(() => {
      for (const w of r.warnings.slice(shown)) console.error(`catherd: ${w}`);
    });
  } catch (e) {
    console.error(`catherd: reconcile failed: ${errorMessage(e)}`);
  }
  // whatever finished unread while no server ran, or finished under another server (spec §3.4)
  void notifier.scan();
}
