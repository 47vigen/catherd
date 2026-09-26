import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ID_PATTERN } from "../../domain/ids.ts";
import { ROLES } from "../../domain/roles.ts";
import { CLIMB_REASONS } from "../../domain/route.ts";
import { ask, climb, land, route } from "../../services/lane-service.ts";
import type { Deps } from "../../services/ports.ts";
import { preflight } from "../../services/preflight.ts";
import { handle } from "./result.ts";

export function registerLaneTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    "route",
    {
      description:
        "The rung for a lane (from Jev, else the lane file's Kind/Difficulty lines, else the profile default) or, without a lane file, a role's default rung, with the ladder above it. Rungs are backend:model#effort; a claude: rung comes with the agent to run it as.",
      inputSchema: {
        run: z.string(),
        lane_file: z.string().optional(),
        role: z.enum(ROLES).default("worker"),
      },
    },
    (a) => handle(() => route(deps, { run: a.run, laneFile: a.lane_file, role: a.role })),
  );

  server.registerTool(
    "preflight",
    {
      description:
        "Run each lane's fast check once, on the base tree, behind the heavy-command lock, with a 120 s timeout. Each lane is pass, fails-as-expected, skipped (it checks a file the lane creates) or cannot-start; only cannot-start blocks. When the profile asks for confirmation, the first call returns the commands to show the user; call again with confirmed: true.",
      inputSchema: { run: z.string(), confirmed: z.boolean().optional() },
    },
    (a) => handle(() => preflight(deps, { run: a.run, confirmed: a.confirmed })),
  );

  server.registerTool(
    "climb",
    {
      description:
        "Move a routed lane one rung up its ladder and record why. Returns the next rung, or top: true, and any hints. Dispatch the lane again at that rung on a fresh thread. Pass env: true when the environment caused it (a missing service, a broken tool, a usage limit), not the rung.",
      inputSchema: {
        run: z.string(),
        lane: z.string().regex(ID_PATTERN),
        reason: z.enum(CLIMB_REASONS),
        evidence: z.string().optional(),
        env: z.boolean().optional(),
      },
    },
    (a) => handle(() => climb(deps, a)),
  );

  server.registerTool(
    "ask",
    {
      description:
        "Ask Jev one fixed question. finding: state { lane_file, finding } → design | code | unclear. same-defect: state { before, after } → yes | no. Falls back to the default when Jev is unsure or absent. Keep the state short, in English, and free of secrets.",
      inputSchema: {
        run: z.string(),
        question: z.enum(["finding", "same-defect"]),
        state: z.record(z.string(), z.string()),
      },
    },
    (a) => handle(() => ask(deps, a)),
  );

  server.registerTool(
    "land",
    {
      description:
        "Record a landed milestone after you commit it: its five-column ledger row (with the minutes it took) and state.md's last check and next step, with any hints. learned, when given, goes to this repo's knowledge.md.",
      inputSchema: {
        run: z.string(),
        milestone: z.string().min(1),
        what: z.string().min(1),
        commit: z.string().regex(/^[0-9a-f]{7,40}$/),
        evidence: z.string().min(1),
        next: z.string().min(1),
        learned: z.string().min(1).optional(),
      },
    },
    (a) => handle(() => land(deps, a)),
  );
}
