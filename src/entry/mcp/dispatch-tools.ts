import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ID_PATTERN } from "../../domain/ids.ts";
import { ROLES } from "../../domain/roles.ts";
import { cancel, dispatch } from "../../services/dispatch-service.ts";
import { peek } from "../../services/peek.ts";
import type { Deps } from "../../services/ports.ts";
import { handle } from "./result.ts";

export function registerDispatchTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    "dispatch",
    {
      description:
        "Start one role on a process backend (codex, claude-code, opencode) and return at launch, in about a second, with { dispatched: { name, role, rung, dispatchId, admittedAt }, hints }; the role runs on. When it finishes, catherd sends this session a <cross-session-message from-name=\"catherd\"> naming the run, the role and its status, and result(run, name) reads the record. Dispatch every independent role one after another, then end your turn. The brief is the text itself; dispatch appends the role's reply contract (reply length and the STATUS line), so do not write it. With lane, the lane file's Owns: paths guard against overlapping lanes, and a lane not yet routed is routed first (a rung off its routed ladder starts at the routed rung, with a hint). thread resumes that role's thread for its own fix round. Refused with a structured error (E_ADMIT_*, E_RUN_BUDGET, E_BACKEND_*) before anything starts. Call it from the main thread.",
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
    "peek",
    {
      description:
        "A look at the runs, without waiting: with run, that run (and this session becomes its owner); without, every run this session owns, else the newest. Per run, first the open owner questions, which are the owner's questions: push them to the owner, relay the owner's answer with answer(run, milestone, answer), and go on with the work that does not depend on them. Then each live role with its rung, seconds since it started and its last event (the last command, file edit or message line); every finished record not yet read, as the first line of catherd's message; the latest native Claude run; the run's next step; protocol, the milestone loop's next step and its six-line checklist; and verifier, the verifier's latest gate step. name narrows it to one role. It never marks a record read: result(run, name) does. Call it when the user asks how it is going, when a decision needs the other roles' state, or once after run_start on a resumed run; never in a loop.",
      inputSchema: {
        run: z.string().optional(),
        name: z.string().regex(ID_PATTERN).optional(),
      },
    },
    (a) => handle(() => peek(deps, a)),
  );

  server.registerTool(
    "cancel",
    {
      description:
        "Stop a live dispatch (interrupt, then SIGTERM, then SIGKILL) and return its record, marked cancelled and read, and hints.",
      inputSchema: { run: z.string(), name: z.string().regex(ID_PATTERN) },
    },
    (a) => handle(() => cancel(deps, a.run, a.name, { read: true })),
  );
}
