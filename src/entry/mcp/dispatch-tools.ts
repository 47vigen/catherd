import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ID_PATTERN } from "../../domain/ids.ts";
import { ROLES } from "../../domain/roles.ts";
import { cancel, dispatch } from "../../services/dispatch-service.ts";
import { peek } from "../../services/peek.ts";
import type { Deps } from "../../services/ports.ts";
import { wait } from "../../services/wait-service.ts";
import { handle } from "./result.ts";

export function registerDispatchTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    "dispatch",
    {
      description:
        "Start one role on a process backend (codex, claude-code, opencode) and return at launch, in about a second, with { dispatched: { name, role, rung, dispatchId, admittedAt }, hints }; the role runs on. When it finishes, catherd sends this session a <cross-session-message from-name=\"catherd\"> naming the run, the role and its status, and result(run, name) reads the record. Dispatch every independent role one after another; on Codex, call wait for their names to continue without relying on queued input waking the session. Claude Code can end its turn for the peer-inbox notice. The brief is the text itself; dispatch appends the role's reply contract (reply length and the STATUS line), so do not write it. With lane, the lane file's Owns: paths guard against overlapping lanes, and a lane not yet routed is routed first (a rung off its routed ladder starts at the routed rung, with a hint). thread resumes that role's thread for its own fix round. Refused with a structured error (E_ADMIT_*, E_RUN_BUDGET, E_BACKEND_*) before anything starts. Call it from the main thread.",
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
        "Wait up to 50 seconds for the first unread finished result among the named dispatches of a run. Snapshots each name's latest dispatch at entry and follows only its linked automatic failovers; unrelated replacements require a new wait. Returns ready, timeout or cancelled with completed and pending names and dispatch IDs. ready always includes an unread record; timeout with no pending names means all targets were already collected. Does not collect results, adopt ownership or dispatch work. After ready, call result(run, name) for each completed name before the next transition. A timeout permits another bounded wait for pending work; accepted queue input alone does not prove processing.",
      inputSchema: {
        run: z.string(),
        names: z.array(z.string().regex(ID_PATTERN)).min(1),
        timeout_ms: z.number().int().min(0).max(50_000).default(50_000),
      },
    },
    (a, extra) => handle(() => wait(deps, a, extra.signal)),
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
