import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { v0Profiles, v0Routing } from "../../bridge/v0.ts";
import { VERSION } from "../../infra/version.ts";
import type { Deps } from "../../services/ports.ts";
import { reconcileAll } from "../../services/reconcile.ts";
import { registerDispatchTools } from "./dispatch-tools.ts";
import { registerLaneTools } from "./lane-tools.ts";
import { registerRunTools } from "./run-tools.ts";
import { registerSetupTools } from "./setup-tools.ts";

export function defaultDeps(): Deps {
  return {
    profiles: v0Profiles(),
    routing: v0Routing(),
    version: VERSION,
    pollMs: 250,
    tickMs: Number(process.env.CATHERD_TICK_MS) || 30_000,
    now: Date.now,
  };
}

export function buildServer(deps: Deps = defaultDeps()): McpServer {
  const server = new McpServer({ name: "catherd", version: deps.version });
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
