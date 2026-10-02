import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { probePush } from "../../services/doctor-push.ts";
import type { Deps } from "../../services/ports.ts";
import { handle } from "./result.ts";

export function registerPushTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    "test_push",
    {
      description:
        "Send this session one labeled smoke message through catherd's push (Claude Code's peer inbox, or the native Codex queue for this thread) and return the receipt: { outcome, enqueue, processing, msgId, detail }. A receipt proves the host accepted it, never that the model read it. For a check from inside a session, where a shell cannot name the Codex thread; catherd doctor --test-push --thread <uuid> is the shell's form.",
      inputSchema: {},
    },
    () => handle(() => probePush(deps.host, process.env)),
  );
}
