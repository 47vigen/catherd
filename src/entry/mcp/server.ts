import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { log } from "../../infra/log.ts";
import { v0Profiles } from "../../bridge/v0.ts";
import { VERSION } from "../../infra/version.ts";
import type { Deps } from "../../services/ports.ts";
import { reconcileAll } from "../../services/reconcile.ts";
import { routingService } from "../../services/routing-service.ts";
import { registerDispatchTools } from "./dispatch-tools.ts";
import { registerLaneTools } from "./lane-tools.ts";
import { sdkToolError } from "./result.ts";
import { registerRunTools } from "./run-tools.ts";
import { registerSetupTools } from "./setup-tools.ts";

export function defaultDeps(): Deps {
  return {
    profiles: v0Profiles(),
    routing: routingService(),
    version: VERSION,
    pollMs: 250,
    tickMs: Number(process.env.CATHERD_TICK_MS) || 30_000,
    now: Date.now,
  };
}

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
  // method as plain text; test/entry/mcp.test.ts fails loudly if an SDK upgrade renames it.
  (server as unknown as { createToolError: typeof sdkToolError }).createToolError = sdkToolError;
  registerRunTools(server, deps);
  registerLaneTools(server, deps);
  registerDispatchTools(server, deps);
  registerSetupTools(server, deps);
  return server;
}

/** Spec §4.7: connect first, so the client never waits on a scan; then reconcile every run. */
export async function startMcpServer(deps: Deps = defaultDeps()): Promise<void> {
  await buildServer(deps).connect(new StdioServerTransport());
  try {
    const r = await reconcileAll(deps);
    const shown = r.warnings.length;
    for (const w of r.warnings) console.error(`catherd: ${w}`);
    void r.done.then(() => {
      for (const w of r.warnings.slice(shown)) console.error(`catherd: ${w}`);
    });
  } catch (e) {
    console.error(`catherd: reconcile failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
