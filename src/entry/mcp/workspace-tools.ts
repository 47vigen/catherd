import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WORKSPACE_LIMIT, WorkspaceBudgetSchema, WorkspaceIdSchema } from "../../domain/workspace.ts";
import type { Deps } from "../../services/ports.ts";
import { workspaceContract } from "../../services/workspace-admission.ts";
import {
  inspectWorkspace,
  startWorkspace,
  startWorkspaceChild,
  workspaceStatus,
} from "../../services/workspace-service.ts";
import { handle } from "./result.ts";

const id = WorkspaceIdSchema;
const repos = z
  .record(id, z.string().min(1))
  .refine((r) => Object.keys(r).length <= WORKSPACE_LIMIT)
  .optional();
const aLines = z.array(z.string().min(1)).min(1).max(100);

export function registerWorkspaceTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    "workspace_inspect",
    {
      description:
        "Resolve explicit workspace members from catherd.workspace.json or a supplied repo map. The root may be a plain directory. Reads only; never scans unrelated repositories.",
      inputSchema: { root: z.string().min(1), repos },
    },
    (a) => handle(() => inspectWorkspace(a.root, a.repos)),
  );
  server.registerTool(
    "workspace_start",
    {
      description:
        "Snapshot a workspace's selected repositories, step dependency graph and optional shared budget. Returns workspace.id and dir. Child single-repo runs are created later with workspace_child_start; no commits or pushes are performed.",
      inputSchema: {
        root: z.string().min(1),
        title: z.string().min(1),
        a_lines: aLines,
        repos,
        steps: z
          .array(
            z.object({
              id,
              repo: id,
              title: z.string().min(1),
              a_lines: aLines,
              depends_on: z.array(id).max(WORKSPACE_LIMIT).optional(),
              milestone: id.optional(),
            }),
          )
          .min(1)
          .max(WORKSPACE_LIMIT),
        budget: WorkspaceBudgetSchema.optional(),
      },
    },
    (a) =>
      handle(() =>
        startWorkspace(deps, {
          root: a.root,
          title: a.title,
          aLines: a.a_lines,
          repos: a.repos,
          budget: a.budget,
          steps: a.steps.map((s) => ({
            id: s.id,
            repo: s.repo,
            title: s.title,
            aLines: s.a_lines,
            dependsOn: s.depends_on,
            milestone: s.milestone,
          })),
        }),
      ),
  );
  server.registerTool(
    "workspace_contract",
    {
      description:
        "Read or write the workspace's shared contract before any child run exists. Once a child is created the contract is frozen and copied into each child as workspace-contract.md.",
      inputSchema: { workspace: z.string().min(1), content: z.string().optional() },
    },
    (a) => handle(() => workspaceContract(a)),
  );
  server.registerTool(
    "workspace_child_start",
    {
      description:
        "Create or return a step's single-repo run once its dependencies have landed their declared milestone. Returns run, dir and the frozen contract path. Use the existing route, dispatch, verification and land tools on this child run.",
      inputSchema: { workspace: z.string().min(1), step: id },
    },
    (a) => handle(() => startWorkspaceChild(deps, a)),
  );
  server.registerTool(
    "workspace_status",
    {
      description:
        "Read a workspace's step readiness, child run ids, landed milestones, aggregate spending and shared budget. Reads only; never starts children automatically.",
      inputSchema: { workspace: z.string().min(1) },
    },
    (a) => handle(() => workspaceStatus(deps, a.workspace)),
  );
}
