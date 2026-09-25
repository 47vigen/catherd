import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ID_PATTERN } from "../../domain/ids.ts";
import { ROLES } from "../../domain/roles.ts";
import { cancel, dispatch, type Progress } from "../../services/dispatch-service.ts";
import type { Deps } from "../../services/ports.ts";
import { handle } from "./result.ts";

type Notify = (n: {
  method: "notifications/progress";
  params: { progressToken: string | number; progress: number; message: string };
}) => Promise<void>;

/** Progress notifications that can never fail a dispatch: the client may be gone (audit C8). */
export function progressTo(token: string | number | undefined, send: Notify): Progress | undefined {
  if (token === undefined) return undefined;
  let n = 0;
  return (message) => {
    try {
      send({
        method: "notifications/progress",
        params: { progressToken: token, progress: ++n, message },
      }).catch(() => {});
    } catch {
      // the transport is closed
    }
  };
}

export function registerDispatchTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    "dispatch",
    {
      description:
        "Run one role on a process backend (codex, …) and return its record and hints when it finishes; it reports progress while it runs. The brief is the text itself. With lane, the lane file's Owns: paths guard against overlapping lanes. thread resumes that role's thread for its own fix round. Refused with a structured error (E_ADMIT_*, E_RUN_BUDGET, E_BACKEND_*) before anything starts. Call it from the main thread.",
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
    (a, extra) =>
      handle(() =>
        dispatch(
          deps,
          a,
          progressTo(extra._meta?.progressToken, (n) => extra.sendNotification(n)),
        ),
      ),
  );

  server.registerTool(
    "cancel",
    {
      description:
        "Stop a live dispatch (interrupt, then SIGTERM, then SIGKILL) and return its record, marked cancelled, and hints.",
      inputSchema: { run: z.string(), name: z.string().regex(ID_PATTERN) },
    },
    (a) => handle(() => cancel(deps, a.run, a.name)),
  );
}
