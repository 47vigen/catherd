import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ID_PATTERN } from "../../domain/ids.ts";
import { ROLES } from "../../domain/roles.ts";
import { cancel, dispatch } from "../../services/dispatch-service.ts";
import type { Deps } from "../../services/ports.ts";
import { handle } from "./result.ts";

export function registerDispatchTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    "dispatch",
    {
      description:
        "Start one role on a process backend (codex, claude-code, opencode) and return at launch, in about a second, with { dispatched: { name, role, rung, dispatchId, admittedAt }, hints }; the role runs on. When it finishes, catherd sends this session a <cross-session-message from-name=\"catherd\"> naming the run, the role and its status, and result(run, name) reads the record. Dispatch every independent role one after another, then end your turn. The brief is the text itself. With lane, the lane file's Owns: paths guard against overlapping lanes. thread resumes that role's thread for its own fix round. Refused with a structured error (E_ADMIT_*, E_RUN_BUDGET, E_BACKEND_*) before anything starts. Call it from the main thread.",
      inputSchema: {
        run: z.string(),
        role: z.enum(ROLES),
        name: z.string().regex(ID_PATTERN),
        brief: z.string().min(1),
        rung: z.string().min(3),
        thread: z.string().optional(),
        lane: z.string().regex(ID_PATTERN).optional(),
        next: z.string().optional(),
      },
    },
    (a) => handle(() => dispatch(deps, a)),
  );

  server.registerTool(
    "cancel",
    {
      description:
        "Stop a live dispatch (interrupt, then SIGTERM, then SIGKILL) and return its record, marked cancelled and read, and hints.",
      inputSchema: { run: z.string(), name: z.string().regex(ID_PATTERN) },
    },
    (a) => handle(() => cancel(deps, a.run, a.name)),
  );
}
