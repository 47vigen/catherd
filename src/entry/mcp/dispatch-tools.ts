import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ID_PATTERN } from "../../domain/ids.ts";
import { ROLES } from "../../domain/roles.ts";
import { cancel, dispatch, type Progress, wait } from "../../services/dispatch-service.ts";
import type { Deps } from "../../services/ports.ts";
import { handle } from "./result.ts";

type Notify = (n: {
  method: "notifications/progress";
  params: { progressToken: string | number; progress: number; message: string };
}) => Promise<void>;

/** Progress notifications that can never fail a wait: the client may be gone (audit C8). */
export function progressTo(token: string | number | undefined, send: Notify): Progress | undefined {
  if (token === undefined) return undefined;
  let n = 0;
  return (message) => {
    try {
      send({
        method: "notifications/progress",
        params: { progressToken: token, progress: ++n, message },
      }).catch(() => {}); // the client is gone: progress is best effort
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
        "Start one role on a process backend (codex, claude-code, opencode) and return at launch, in about a second, with { dispatched: { name, role, rung, dispatchId, admittedAt }, hints }; the role runs on, and wait(run) collects its record. Dispatch every independent role one after another, then call wait. The brief is the text itself. With lane, the lane file's Owns: paths guard against overlapping lanes. thread resumes that role's thread for its own fix round. Refused with a structured error (E_ADMIT_*, E_RUN_BUDGET, E_BACKEND_*) before anything starts. Call it from the main thread.",
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
    "wait",
    {
      description:
        "Block until at least one of the run's uncollected dispatches has finished (only those in names, when given; every one of them with all: true), reporting progress meanwhile, and return { records, started, running, hints }. records holds each finished role's { record, hints }, each returned by one wait only; a role that hit a usage limit has its failover stand-in launched, listed in started. running names every uncollected role this call did not return, still running or already finished, stand-ins included: act on the records, then wait again while running is not empty. Returns at once, with a hint, when nothing is uncollected. Call it from the main thread.",
      inputSchema: {
        run: z.string(),
        names: z.array(z.string().regex(ID_PATTERN)).optional(),
        all: z.boolean().optional(),
      },
    },
    (a, extra) =>
      handle(() =>
        wait(
          deps,
          a,
          progressTo(extra._meta?.progressToken, (n) => extra.sendNotification(n)),
          // a wait its caller cancelled collects nothing: the record would go to no one
          extra.signal,
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
