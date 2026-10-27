import { defineCommand } from "citty";
import { CatherdError } from "../domain/errors.ts";
import { ID_PATTERN } from "../domain/ids.ts";
import { roleScopeFromEnv } from "../domain/role-scope.ts";
import { gateCheckOrList, gatePass } from "../services/gate-service.ts";
import { DISPATCH_ID_ENV, activityReporter } from "../infra/lock-activity.ts";
import { runMilestoneCheck } from "../services/milestone-check.ts";
import { assertRoleMay } from "../services/role-access.ts";
import { readRunFile, writeRunFile } from "../services/run-service.ts";
import { teamRead, teamSend, teamWait } from "../services/team.ts";
import "../adapters/all.ts";
import { printJson } from "./cli-kit.ts";
import { defaultDeps } from "./deps.ts";

/**
 * Spec 1.5 plan 21: the role server's operations as commands any role can run from its shell, on a backend
 * whose harness has no role server (opencode, Cursor) or when no MCP tool is listed. In a role
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

const GATE = {
  run: { type: "positional", required: true, description: "the run id" },
  item: { type: "string", required: true, description: "the gate item's name" },
  command: { type: "string", required: true, description: "the command that checks it" },
  paths: { type: "string", required: true, description: "the repo paths it depends on, comma-separated" },
} as const;

const pathsOf = (s: string): string[] => {
  const paths = s
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paths.length)
    throw new CatherdError("E_INPUT_INVALID", "--paths names no path", {
      fix: "pass --paths src,package.json",
    });
  return paths;
};

const check = defineCommand({
  meta: { name: "check", description: "Whether a gate item passed on unchanged content (gate_check)" },
  // plan 23: with only the run and --milestone, it lists the milestone's recorded items (as gate_check does)
  args: {
    run: GATE.run,
    item: { ...GATE.item, required: false },
    command: { ...GATE.command, required: false },
    paths: { ...GATE.paths, required: false },
    milestone: { type: "string", description: "the milestone you verify, like M1" },
  },
  async run({ args }) {
    assertRoleMay(scope(), args.run, "gate_check");
    if (args.milestone !== undefined && !ID_PATTERN.test(args.milestone))
      throw new CatherdError("E_INPUT_INVALID", `bad milestone "${args.milestone}"`, {
        fix: "pass --milestone M1",
      });
    printJson(
      await gateCheckOrList(defaultDeps(), {
        run: args.run,
        item: args.item,
        command: args.command,
        paths: args.paths === undefined ? undefined : pathsOf(args.paths),
        ...(args.milestone ? { milestone: args.milestone } : {}),
      }),
    );
  },
});

const pass = defineCommand({
  meta: { name: "pass", description: "Record a passed gate item with its evidence (gate_pass)" },
  args: {
    ...GATE,
    evidence: { type: "string", required: true, description: "what showed it passed" },
    milestone: { type: "string", description: "the milestone you verify, like M1" },
  },
  async run({ args }) {
    if (!args.milestone || !ID_PATTERN.test(args.milestone))
      throw new CatherdError("E_INPUT_INVALID", "gate pass needs a milestone", {
        fix: "call gate_check for this item, then pass --milestone M1",
      });
    assertRoleMay(scope(), args.run, "gate_pass");
    printJson(
      await gatePass(defaultDeps(), {
        run: args.run,
        item: args.item,
        command: args.command,
        paths: pathsOf(args.paths),
        evidence: args.evidence,
        milestone: args.milestone,
      }),
    );
  },
});

const runCheck = defineCommand({
  meta: {
    name: "run",
    description: "Run the milestone's full check on the committed HEAD, detached (gate_run)",
  },
  args: {
    run: GATE.run,
    milestone: { type: "string", required: true, description: "the milestone you verify, like M1" },
    command: GATE.command,
    at: { type: "string", description: "a checkout of the run's base, to record the base's own failures" },
    force: { type: "boolean", description: "run it again although a record of this HEAD exists" },
  },
  async run({ args }) {
    assertRoleMay(scope(), args.run, "gate_run");
    if (!ID_PATTERN.test(args.milestone))
      throw new CatherdError("E_INPUT_INVALID", `bad milestone "${args.milestone}"`, {
        fix: "pass --milestone M1",
      });
    // a shell tool call may be cut off; the check goes on, and this ticks the dispatch's activity while it waits
    const reporter = activityReporter(process.env[DISPATCH_ID_ENV]);
    try {
      const r = await runMilestoneCheck(
        {
          run: args.run,
          milestone: args.milestone,
          command: args.command,
          ...(args.at ? { at: args.at } : {}),
          ...(args.force ? { force: true } : {}),
        },
        reporter ? { onWait: reporter.tick } : {},
      );
      printJson(r);
      if (!r.running && r.missing.length > 0) process.exitCode = 1;
    } finally {
      reporter?.done();
    }
  },
});

export const gateCommand = defineCommand({
  meta: {
    name: "gate",
    description: "A verifier's gate evidence: check an item, record a pass, run the check",
  },
  subCommands: { check, pass, run: runCheck },
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

const teamWaitCmd = defineCommand({
  meta: { name: "wait", description: "Wait until a lane stops running or posts a message (team_wait)" },
  args: {
    ...TEAM_RUN,
    lane: { type: "string", required: true, description: "the lane to wait on, like M1.L2" },
    "timeout-ms": { type: "string", description: "how long to wait, up to 300000" },
  },
  async run({ args }) {
    assertRoleMay(scope(), args.run, "team_wait");
    printJson(
      await teamWait({ run: args.run, lane: args.lane, timeoutMs: intArg("timeout-ms", args["timeout-ms"]) }),
    );
  },
});

export const teamCommand = defineCommand({
  meta: { name: "team", description: "The run's team channel: send, read, wait" },
  subCommands: { send: teamSendCmd, read: teamReadCmd, wait: teamWaitCmd },
});
