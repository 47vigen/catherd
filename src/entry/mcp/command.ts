import { defineCommand } from "citty";
import { restoreTmpdir } from "../../infra/env.ts";
import { startMcpServer } from "./server.ts";

export const mcpCommand = defineCommand({
  meta: { name: "mcp", description: "Run the catherd MCP server over stdio" },
  run: () => {
    restoreTmpdir(process.env);
    return startMcpServer();
  },
});
