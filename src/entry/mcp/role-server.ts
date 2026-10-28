import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import "../../adapters/all.ts";
import { ID_PATTERN } from "../../domain/ids.ts";
import { roleScopeFromEnv } from "../../domain/role-scope.ts";
import {
  ARCHITECT_TOOLS,
  ROLE_MCP_SERVER,
  type RoleMcpContext,
  roleMcpTools,
} from "../../domain/role-tools.ts";
import { ARCHITECT_TOOL_SPECS, callArchitectTool } from "../../services/architect-tools.ts";
import { log } from "../../infra/log.ts";
import { gateCheckOrList, gatePass } from "../../services/gate-service.ts";
import { runMilestoneCheck } from "../../services/milestone-check.ts";
import type { Deps } from "../../services/ports.ts";
import { readKnowledge, readRunFile, writeRunFile } from "../../services/run-service.ts";
import { findRun } from "../../services/run-store.ts";
import { teamRead, teamSend } from "../../services/team.ts";
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
      description:
        "Read what past runs learned about this role's repository. Takes no argument: it reads the run's own repository.",
      // #42 finding 4: `.`, the pwd or /tmp vs /private/tmp never matched a literal; any repo given is ignored
      inputSchema: { repo: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => call("read_knowledge", () => readKnowledge(run.meta.repo)),
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
          "Check whether this run's gate item passed on unchanged content; records the current step. With only run and milestone, lists the items already checked for that milestone in this run, each with its command and whether it passed: reuse those names and re-check the failed ones first.",
        inputSchema: {
          run: boundRun,
          item: gate.item.optional(),
          command: gate.command.optional(),
          paths: gate.paths.optional(),
          milestone: z.string().regex(ID_PATTERN).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      (a) => call("gate_check", () => gateCheckOrList(deps, a)),
    );
    server.registerTool(
      "gate_pass",
      {
        description: "Record this run's passed gate item with the evidence, command and content hash.",
        inputSchema: { ...gate, evidence: z.string().min(1), milestone: z.string().regex(ID_PATTERN) },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      (a) => call("gate_pass", () => gatePass(deps, a)),
    );
  }
  if (tools.has("gate_run"))
    server.registerTool(
      "gate_run",
      {
        description:
          "The verifier's full check of a milestone, run by catherd on the committed HEAD in a detached worker under the verifier lock and a heavy slot: { running: false, record (exit, failing lines, log, secrets, rerunOf), missing, audit } once done; land reads that record. The same run, milestone, command and HEAD answers the recorded result (force: true runs it again). Refused while tracked files are uncommitted. Past 10 minutes it answers { running: true }: call it again to wait for the same run. at: a checkout of the run's base you prepared, to record the base's own failures, which then do not block.",
        inputSchema: {
          run: boundRun,
          milestone: z.string().regex(ID_PATTERN),
          command: z.string().min(1),
          at: z.string().min(1).optional(),
          force: z.boolean().optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      (a) => call("gate_run", () => runMilestoneCheck(a)),
    );
  const from = () => roleScopeFromEnv(process.env, { scratch: true })?.name ?? context.role;
  if (tools.has("team_send"))
    server.registerTool(
      "team_send",
      {
        description:
          "Send one short message to a lane of your run (M1.L2), a role (architect), or all: what you changed that others use (file, what, why), or a question for the architect. It is queued: the target reads it with team_read, and its next brief carries it. The architect's and the owner's messages reach a running lane at once where its backend allows.",
        inputSchema: { run: boundRun, to: z.string().min(1), text: z.string().min(1) },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      (a) => call("team_send", () => teamSend({ ...a, from: from() })),
    );
  if (tools.has("team_read"))
    server.registerTool(
      "team_read",
      {
        description:
          "Read your run's team messages. Keep reads small: low `limit` (1 to 20) and `maxChars`. Page with `since=next`.",
        inputSchema: {
          run: boundRun,
          since: z.number().int().min(0).optional(),
          limit: z.number().int().min(1).max(20).optional(),
          maxChars: z.number().int().min(1).max(2000).optional(),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      (a) => call("team_read", () => teamRead(a)),
    );
  // plan 47: the architect's tools, from the same specs `catherd call` runs
  for (const tool of ARCHITECT_TOOLS) {
    if (!tools.has(tool)) continue;
    const spec = ARCHITECT_TOOL_SPECS[tool];
    server.registerTool(
      tool,
      {
        description: spec.description,
        inputSchema: spec.shape,
        annotations: { readOnlyHint: spec.readOnly, destructiveHint: false, openWorldHint: false },
      },
      (a: unknown) =>
        call(tool, () =>
          callArchitectTool({ deps, run, caller: { name: from(), role: context.role } }, tool, a),
        ),
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
