import type { Engine } from "./profile.ts";
import { roleContract } from "./role-prompts.ts";
import { ARCHITECT_TOOLS, roleMcpTools } from "./role-tools.ts";
import type { Role } from "./roles.ts";

/** The tags of a brief's four parts, in order (plan 44 D1). Part 1 is the role's; the daemon supplies the other three. */
export const BRIEF_PARTS = ["role-contract", "run-facts", "unit-context", "this-round"] as const;

/** Parts 2 to 4 of a brief: the run's facts, the unit's context and this round's task. */
export interface BriefParts {
  facts: string[];
  unit: string[];
  round: string[];
}

/** What composing a brief needs besides its parts: who the role is and the lane file as it stands. */
export interface BriefContext {
  run: string;
  name: string;
  role: Role;
  /** the catherd version whose `lock` a worker's text names */
  version: string;
  /** a resumed thread holds the role, facts and unit already, so only this round goes */
  resumed: boolean;
  /** the lane file as it stands, header and body */
  lane: { id: string; text: string } | null;
  /** plan 47: the run's engine; absent is 2.0 */
  engine?: Engine;
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
      return `catherd gate pass ${run} --milestone <M> --item <item> --command <command> --paths <path,…> --evidence <evidence>`;
    case "gate_run":
      return `catherd gate run ${run} --milestone <M> --command <command> [--at <base checkout>]`;
    case "team_send":
      return `catherd team send ${run} --to <lane|role|all> (the message on stdin)`;
    case "team_read":
      return `catherd team read ${run} [--since <n>] [--limit <n>]`;
    case "team_wait":
      return `catherd team wait ${run} --lane <lane> [--timeout-ms <ms>]`;
    default:
      // plan 47: the architect engine's tools, one command for all of them
      return (ARCHITECT_TOOLS as readonly string[]).includes(tool)
        ? `catherd call ${run} ${tool} (its arguments as JSON on stdin)`
        : tool;
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

/** Who the role is, where its temp files go, and how it reaches its run's files and gate: the CLI forms, on any backend. */
export function roleNotes(c: Pick<BriefContext, "run" | "name" | "role" | "engine">): string {
  const cli = roleMcpTools(c.role, c.engine)
    .map((t) => cliForm(t, c.run))
    .join("; ");
  return [
    `catherd: you are ${c.name} of run ${c.run}. Put temporary files in $TMPDIR, never in /tmp.`,
    `Your catherd commands, from your shell: ${cli}.`,
  ].join("\n");
}

const tag = (name: string, texts: readonly string[]) => {
  const body = texts.filter(Boolean).join("\n\n");
  return `<${name}>\n${body}${body ? "\n" : ""}</${name}>`;
};

/**
 * The brief a role reads (plan 44): its contract, the run's facts and its notes, the unit's context and its lane
 * file, and this round's task, each in its tag. A resumed thread has the first three already, so it gets this round
 * and a pointer to its lane file.
 */
export function composeBrief(parts: BriefParts, c: BriefContext): string {
  if (c.resumed) {
    const pointer = c.lane
      ? `Your lane file is lanes/${c.lane.id}.md (catherd run-file read ${c.run} lanes/${c.lane.id}.md).`
      : "";
    return `${tag("this-round", [...parts.round, pointer])}\n`;
  }
  return `${[
    tag("role-contract", [roleContract(c.role, c.version, c.engine)]),
    tag("run-facts", [...parts.facts, roleNotes(c)]),
    tag("unit-context", [...parts.unit, c.lane ? laneBlock(c.lane.id, c.lane.text) : ""]),
    tag("this-round", parts.round),
  ].join("\n\n")}\n`;
}
