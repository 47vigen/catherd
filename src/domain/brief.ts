import { replyContract } from "./role-prompts.ts";
import { ROLE_MCP_SERVER, roleMcpTools } from "./role-tools.ts";
import type { Role } from "./roles.ts";

/** What admission adds to a role's brief, besides its reply contract (spec 1.5 plan 21). */
export interface BriefContext {
  run: string;
  name: string;
  role: Role;
  /** the lane file as it stands at admission, header and body */
  lane: { id: string; text: string } | null;
  /** the role's scratch folder, its TMPDIR, on a backend that grants it */
  scratch: string | null;
  /** whether the role's harness lists the catherd_role tools */
  roleServer: boolean;
}

/** The CLI form of each role server tool, which any role can run from its shell. */
function cliForm(tool: string, run: string): string {
  switch (tool) {
    case "read_run_file":
      return `catherd run-file read ${run} <path>`;
    case "write_run_file":
      return `catherd run-file write ${run} <path> (the content on stdin)`;
    case "read_knowledge":
      return "catherd knowledge show";
    case "gate_check":
      return `catherd gate check ${run} --milestone <M> --item <item> --command <command> --paths <path,…>`;
    case "gate_pass":
      return `catherd gate pass ${run} --item <item> --command <command> --paths <path,…> --evidence <evidence>`;
    default:
      return tool;
  }
}

const LANE_OPEN = (id: string) => `<lane-file path="lanes/${id}.md">`;
const LANE_CLOSE = "</lane-file>";

/**
 * The lane file inlined (spec 1.5 plan 21): an isolated headless worker cannot read the run folder, so its Owns,
 * fast check and body travel in the brief itself.
 */
export function laneBlock(id: string, text: string): string {
  return [
    `Your lane file, lanes/${id}.md, as it stood when you were dispatched:`,
    LANE_OPEN(id),
    text.trimEnd(),
    LANE_CLOSE,
  ].join("\n");
}

/** Who the role is, where its temp files go, and how it reaches its run's files and gate. */
export function roleNotes(c: BriefContext): string {
  const tools = roleMcpTools(c.role);
  const lines = [`catherd: you are ${c.name} of run ${c.run}.`];
  if (c.scratch)
    lines.push(
      `Your scratch folder is ${c.scratch}, which is your $TMPDIR: put temporary files, logs and builds there, never in /tmp. catherd removes it with the run, so anything the orchestrator must keep goes in your reply.`,
    );
  const cli = tools.map((t) => cliForm(t, c.run)).join("; ");
  lines.push(
    c.roleServer
      ? `Your catherd tools: ${tools.map((t) => `mcp__${ROLE_MCP_SERVER}__${t}`).join(", ")}. If they are not listed, run the same from your shell: ${cli}.`
      : `Your catherd commands, from your shell: ${cli}.`,
  );
  return lines.join("\n");
}

/**
 * The brief admission writes: the orchestrator's text, the lane file, the role's notes, then its reply contract,
 * each once. A failover stand-in that reruns an earlier brief gets the lane file as it stands now and its own notes,
 * never two copies.
 */
export function composeBrief(brief: string, c: BriefContext): string {
  const contract = replyContract(c.role);
  let body = brief.trimEnd();
  if (body.endsWith(contract)) body = body.slice(0, -contract.length).trimEnd();
  if (c.lane) {
    const open = LANE_OPEN(c.lane.id);
    const start = body.lastIndexOf(open);
    const end = body.indexOf(LANE_CLOSE, start);
    if (start >= 0 && end >= 0) {
      const lead = body.lastIndexOf("\n\n", start);
      body = `${body.slice(0, lead >= 0 ? lead : start)}${body.slice(end + LANE_CLOSE.length)}`.trimEnd();
    }
  }
  const notesStart = body.lastIndexOf("\n\ncatherd: you are ");
  if (notesStart >= 0) body = body.slice(0, notesStart).trimEnd();
  const parts = [body, ...(c.lane ? [laneBlock(c.lane.id, c.lane.text)] : []), roleNotes(c), contract];
  return `${parts.filter(Boolean).join("\n\n")}\n`;
}
