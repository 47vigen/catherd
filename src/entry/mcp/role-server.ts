import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { ID_PATTERN } from "../../domain/ids.ts";
import { ROLE_MCP_SERVER, type RoleMcpContext, roleMcpTools } from "../../domain/role-tools.ts";
import { log } from "../../infra/log.ts";
import { gateCheck, gatePass } from "../../services/gate-service.ts";
import type { Deps } from "../../services/ports.ts";
import { readKnowledge, readRunFile, writeRunFile } from "../../services/run-service.ts";
import { findRun } from "../../services/run-store.ts";
import { defaultDeps } from "../deps.ts";
import { handle, sdkToolError, toolOf } from "./result.ts";

/** A role can reach only its run artifacts and, for a verifier, that run's gate evidence. */
export function buildRoleServer(context: RoleMcpContext, deps: Deps = defaultDeps()): McpServer {
  const run = findRun(context.run);
  const server = new McpServer({ name: ROLE_MCP_SERVER, version: deps.version });
  const tools = new Set(roleMcpTools(context.role));
  const boundRun = z.literal(run.id);
  const runFile = { run: boundRun, path: z.string().min(1) };
  const call = async (tool: string, f: () => unknown) => {
    const started = Date.now();
    const result = await handle(f);
    log(result.isError ? "warn" : "info", "tool", {
      tool,
      ms: Date.now() - started,
      ok: !result.isError,
      code: result.isError ? (result.structuredContent as { code?: string } | undefined)?.code : undefined,
    });
    return result;
  };
  (server as unknown as { createToolError: typeof sdkToolError }).createToolError = (message) => {
    const result = sdkToolError(message);
    log("warn", "tool", {
      tool: toolOf(message),
      ok: false,
      code: (result.structuredContent as { code?: string } | undefined)?.code,
    });
    return result;
  };

  server.registerTool(
    "read_run_file",
    {
      description: "Read an artifact from this role's run folder, using a run-relative path.",
      inputSchema: runFile,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (a) => call("read_run_file", () => readRunFile(a)),
  );
  server.registerTool(
    "read_knowledge",
    {
      description: "Read what past runs learned about this role's repository.",
      inputSchema: { repo: z.literal(run.meta.repo) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (a) => call("read_knowledge", () => readKnowledge(a.repo)),
  );
  if (tools.has("write_run_file"))
    server.registerTool(
      "write_run_file",
      {
        description: "Write a plan, lane, dossier or note in this run; catherd's own files are protected.",
        inputSchema: { ...runFile, content: z.string() },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      (a) => call("write_run_file", () => writeRunFile(a)),
    );
  if (tools.has("gate_check")) {
    const gate = {
      run: boundRun,
      item: z.string().min(1),
      command: z.string().min(1),
      paths: z.array(z.string().min(1)).min(1),
    };
    server.registerTool(
      "gate_check",
      {
        description:
          "Check whether this run's gate item passed on unchanged content; records the current step.",
        inputSchema: { ...gate, milestone: z.string().regex(ID_PATTERN).optional() },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      (a) => call("gate_check", () => gateCheck(deps, a)),
    );
    server.registerTool(
      "gate_pass",
      {
        description: "Record this run's passed gate item with the evidence, command and content hash.",
        inputSchema: { ...gate, evidence: z.string().min(1) },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      (a) => call("gate_pass", () => gatePass(deps, a)),
    );
  }
  return server;
}

/** Role servers have no orchestrator ownership, notifier, reconciliation or background catalog sync. */
export async function startRoleMcpServer(
  context: RoleMcpContext,
  o: { deps?: Deps; transport?: Transport } = {},
): Promise<void> {
  const server = buildRoleServer(context, o.deps);
  await server.connect(o.transport ?? new StdioServerTransport());
}
