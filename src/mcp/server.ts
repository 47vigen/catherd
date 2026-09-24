import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { reconcileLive } from "../core/reconcile.ts";
import { listRuns } from "../core/runstore.ts";
import { VERSION } from "../version.ts";
import { registerDispatch } from "./dispatch.ts";
import { registerLaneTools } from "./lane-tools.ts";
import { registerRunTools } from "./run-tools.ts";
import { registerSetupTools } from "./setup-tools.ts";

export function buildServer(): McpServer {
  const server = new McpServer({ name: "catherd", version: VERSION });
  registerRunTools(server);
  registerLaneTools(server);
  registerDispatch(server);
  registerSetupTools(server);
  return server;
}

export async function startMcpServer(): Promise<void> {
  process.env.CATHERD_TICK_MS ??= "30000";
  for (const run of listRuns()) reconcileLive(run.dir);
  await buildServer().connect(new StdioServerTransport());
}
