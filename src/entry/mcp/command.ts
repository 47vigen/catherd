import { defineCommand } from "citty";
import { startMcpServer } from "./server.ts";

export const mcpCommand = defineCommand({
  meta: { name: "mcp", description: "Run the catherd MCP server over stdio" },
  run: () => startMcpServer(),
});
