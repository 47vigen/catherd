import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ID_PATTERN } from "../../domain/ids.ts";
import { gateCheck, gatePass } from "../../services/gate-service.ts";
import { answer, park } from "../../services/questions.ts";
import type { Deps } from "../../services/ports.ts";
import { handle } from "./result.ts";

// Spec 1.1 §7 and §8: the tools the enforced protocol adds.
export function registerProtocolTools(server: McpServer, deps: Deps): void {
  const gate = {
    run: z.string(),
    item: z.string().min(1),
    command: z.string().min(1),
    paths: z.array(z.string().min(1)).min(1),
  };

  server.registerTool(
    "gate_check",
    {
      description:
        "The verifier, before running a gate item: { carried: true, passedAt, commit } when this repo already has a pass of the same command on the same content of paths (repo-relative; . for the whole repo), so it reports the item as carried over from that commit instead of running it; else { carried: false }, and it runs the item. Either way the call is recorded as the verifier's current step, which status and peek show.",
      inputSchema: gate,
    },
    (a) => handle(() => gateCheck(deps, a)),
  );

  server.registerTool(
    "gate_pass",
    {
      description:
        "The verifier, after a gate item passed: records the command, the content hash of paths and the commit, with the evidence (a log path or the decisive line), so a later gate_check on unchanged content carries it over.",
      inputSchema: { ...gate, evidence: z.string().min(1) },
    },
    (a) => handle(() => gatePass(deps, a)),
  );

  server.registerTool(
    "park",
    {
      description:
        "An owner question only the user can answer: parks the milestone (land refuses it until answered) and puts it in front of state.md's next step, instead of stopping the run. Returns the parked milestones and hints: push the full question to the user with PushNotification, and go on with the milestones and runs that do not depend on it.",
      inputSchema: { run: z.string(), milestone: z.string().regex(ID_PATTERN), question: z.string().min(1) },
    },
    (a) => handle(() => park(deps, a)),
  );

  server.registerTool(
    "answer",
    {
      description:
        "The owner answered a parked milestone's question in this session: records the answer and unparks the milestone. status, peek and run_start list the questions still open.",
      inputSchema: { run: z.string(), milestone: z.string().regex(ID_PATTERN), answer: z.string().min(1) },
    },
    (a) => handle(() => answer(deps, a)),
  );
}
