import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ID_PATTERN } from "../../domain/ids.ts";
import { ROLES } from "../../domain/roles.ts";
import type { Deps } from "../../services/ports.ts";
import {
  readKnowledge,
  readRunFile,
  recordAgentRun,
  result,
  setNext,
  startRun,
  writeRunFile,
} from "../../services/run-service.ts";
import { runsSummary, status } from "../../services/summary.ts";
import { handle } from "./result.ts";

export function registerRunTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    "run_start",
    {
      description:
        "Start a catherd run for a git repository: creates its run folder (outside the repo) and state.md. Returns the run id and the folder, and hints when state.md could not be written yet.",
      inputSchema: {
        repo: z.string().min(1),
        title: z.string().min(1),
        a_lines: z.array(z.string().min(1)).min(1),
      },
    },
    (a) => handle(() => startRun(deps, { repo: a.repo, title: a.title, aLines: a.a_lines })),
  );

  server.registerTool(
    "write_run_file",
    {
      description:
        "Write a file in the run folder: plan.md, lanes/Mx.Ly.md, a dossier or notes. The path is relative to the run folder; catherd's own files are refused.",
      inputSchema: { run: z.string(), path: z.string().min(1), content: z.string() },
    },
    (a) => handle(() => writeRunFile(a)),
  );

  server.registerTool(
    "read_run_file",
    {
      description: "Read a file in the run folder, by a path relative to it.",
      inputSchema: { run: z.string(), path: z.string().min(1) },
    },
    (a) => handle(() => readRunFile(a)),
  );

  server.registerTool(
    "status",
    {
      description:
        "catherd's version, and one screen per run: the state.md tail, live roles, totals, reported Claude subagents, Jev fallbacks, budget and landed milestones. Without a run: every run with live roles, else the newest. Reads only.",
      inputSchema: { run: z.string().optional() },
    },
    (a) => handle(() => status(deps, a.run)),
  );

  server.registerTool(
    "result",
    {
      description: "A role's latest dispatch: its state, its record once finished, and its capped reply.",
      inputSchema: { run: z.string(), name: z.string().regex(ID_PATTERN) },
    },
    (a) => handle(() => result(deps, a)),
  );

  server.registerTool(
    "set_next",
    {
      description:
        "Record the run's next step, the last line of state.md: when pausing, or when the plan changes. dispatch, climb and land write state.md themselves. Returns state.md, or a 'state.md not refreshed' hint when git fails (the step is still recorded).",
      inputSchema: { run: z.string(), next: z.string().min(1) },
    },
    (a) => handle(() => setNext(a)),
  );

  server.registerTool(
    "record_agent_run",
    {
      description:
        "After every native Claude subagent (Agent tool) of a run, record what the Agent result reported: total_tokens and duration_ms. The budget counts it.",
      inputSchema: {
        run: z.string(),
        name: z.string().regex(ID_PATTERN),
        role: z.enum(ROLES),
        rung: z.string().min(3),
        total_tokens: z.number().int().nonnegative(),
        duration_ms: z.number().nonnegative().optional(),
        cost_usd: z.number().nonnegative().optional(),
        status: z.enum(["ok", "failed", "cancelled"]).default("ok"),
      },
    },
    (a) =>
      handle(() =>
        recordAgentRun(deps, {
          run: a.run,
          name: a.name,
          role: a.role,
          rung: a.rung,
          totalTokens: a.total_tokens,
          durationMs: a.duration_ms,
          costUsd: a.cost_usd,
          status: a.status,
        }),
      ),
  );

  server.registerTool(
    "read_knowledge",
    {
      description:
        "What past runs of this repo learned, one line per landed milestone that said something. Read it before an architect plans a new run.",
      inputSchema: { repo: z.string().min(1) },
    },
    (a) => handle(() => readKnowledge(a.repo)),
  );

  server.registerTool(
    "runs_summary",
    {
      description:
        "Per role and rung over past runs: runs, ok, refusals, climbs from that rung, seconds and tokens; reported Claude subagent runs; and what the user's harness customizations cost per run. Reads only.",
      inputSchema: {
        run: z.string().optional(),
        repo: z.string().optional(),
        role: z.enum(ROLES).optional(),
        since_days: z.number().positive().optional(),
      },
    },
    (a) => handle(() => runsSummary({ run: a.run, repo: a.repo, role: a.role, sinceDays: a.since_days })),
  );
}
