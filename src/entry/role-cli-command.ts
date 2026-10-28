import { defineCommand } from "citty";
import { CatherdError } from "../domain/errors.ts";
import { roleScopeFromEnv } from "../domain/role-scope.ts";
import { assertRoleMay } from "../services/role-access.ts";
import { readRunFile, writeRunFile } from "../services/run-service.ts";
import { teamRead, teamSend } from "../services/team.ts";
import { ARCHITECT_TOOLS } from "../domain/role-tools.ts";
import { callArchitectTool } from "../services/architect-tools.ts";
import { latestDispatch } from "../services/dispatches.ts";
import { findRun } from "../services/run-store.ts";
import "../adapters/all.ts";
import { printJson } from "./cli-kit.ts";
import { defaultDeps } from "./deps.ts";

/**
 * Spec 1.5 plan 21: the role server's operations as commands any role can run from its shell, on a backend
 * whose harness has no role server (opencode) or when no MCP tool is listed. In a role
 * (CATHERD_ROLE, or its scratch TMPDIR) they are bound to its own run and its role's operations.
 */
const scope = () => roleScopeFromEnv(process.env);

const RUN_PATH = {
  run: { type: "positional", required: true, description: "the run id" },
  path: { type: "positional", required: true, description: "a path relative to the run folder" },
} as const;

const read = defineCommand({
  meta: { name: "read", description: "Print a file of the run folder (read_run_file)" },
  args: RUN_PATH,
  run({ args }) {
    assertRoleMay(scope(), args.run, "read_run_file");
    const text = readRunFile({ run: args.run, path: args.path });
    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  },
});

const write = defineCommand({
  meta: { name: "write", description: "Write stdin to a file of the run folder (write_run_file)" },
  args: RUN_PATH,
  async run({ args }) {
    assertRoleMay(scope(), args.run, "write_run_file");
    const content = await Bun.stdin.text();
    printJson(writeRunFile({ run: args.run, path: args.path, content }));
  },
});

export const runFileCommand = defineCommand({
  meta: { name: "run-file", description: "Read or write a run's plan, lanes, dossier and notes" },
  subCommands: { read, write },
});

const TEAM_RUN = { run: { type: "positional", required: true, description: "the run id" } } as const;

const intArg = (name: string, v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0)
    throw new CatherdError("E_INPUT_INVALID", `--${name} "${v}" is not a whole number`, {
      fix: `pass --${name} 10`,
    });
  return n;
};

const teamSendCmd = defineCommand({
  meta: { name: "send", description: "Send stdin as one message to a lane, a role or all (team_send)" },
  args: {
    ...TEAM_RUN,
    to: { type: "string", required: true, description: "a lane (M1.L2), a role, or all" },
  },
  async run({ args }) {
    const s = scope();
    assertRoleMay(s, args.run, "team_send");
    const text = await Bun.stdin.text();
    printJson(await teamSend({ run: args.run, from: s?.name ?? "owner", to: args.to, text }));
  },
});

const teamReadCmd = defineCommand({
  meta: { name: "read", description: "Print the run's team messages, a small page at a time (team_read)" },
  args: {
    ...TEAM_RUN,
    since: { type: "string", description: "the message number to read after (the last page's next)" },
    limit: { type: "string", description: "how many messages, 1 to 20" },
  },
  run({ args }) {
    assertRoleMay(scope(), args.run, "team_read");
    printJson(
      teamRead({ run: args.run, since: intArg("since", args.since), limit: intArg("limit", args.limit) }),
    );
  },
});

export const teamCommand = defineCommand({
  meta: { name: "team", description: "The run's team channel: send, read" },
  subCommands: { send: teamSendCmd, read: teamReadCmd },
});

/**
 * Plan 47: the architect engine's tools as one command, `catherd call <run> <tool>`, the arguments as JSON on stdin,
 * for a role whose harness has no role server. In a role it is bound to its own run and its role's tools; outside a
 * role (the owner's terminal) it acts with the architect's tools, as the owner.
 */
export const callCommand = defineCommand({
  meta: {
    name: "call",
    description: "Call an architect-engine tool of a run; its arguments as JSON on stdin",
  },
  args: {
    run: { type: "positional", required: true, description: "the run id" },
    tool: { type: "positional", required: true, description: `one of ${ARCHITECT_TOOLS.join(", ")}` },
  },
  async run({ args }) {
    const tool = ARCHITECT_TOOLS.find((t) => t === args.tool);
    if (!tool)
      throw new CatherdError("E_INPUT_INVALID", `no tool ${args.tool}`, {
        fix: `use one of ${ARCHITECT_TOOLS.join(", ")}`,
      });
    const s = scope();
    assertRoleMay(s, args.run, tool);
    const run = findRun(args.run);
    const text = (await Bun.stdin.text()).trim();
    let input: unknown = {};
    try {
      input = text ? JSON.parse(text) : {};
    } catch {
      throw new CatherdError("E_INPUT_INVALID", "stdin is not JSON", {
        fix: `echo '{"why": "..."}' | catherd call ${args.run} ${tool}`,
      });
    }
    const role = s ? latestDispatch(run, s.name)?.admit.role : undefined;
    const caller = s && role ? { name: s.name, role } : { name: "owner", role: "architect" as const };
    printJson(await callArchitectTool({ deps: defaultDeps(), run, caller }, tool, input));
  },
});
