import { defineCommand } from "citty";
import { CatherdError } from "../domain/errors.ts";
import { ID_PATTERN } from "../domain/ids.ts";
import { roleScopeFromEnv } from "../domain/role-scope.ts";
import { gateCheckOrList, gatePass } from "../services/gate-service.ts";
import { assertRoleMay } from "../services/role-access.ts";
import { readRunFile, writeRunFile } from "../services/run-service.ts";
import { printJson } from "./cli-kit.ts";
import { defaultDeps } from "./deps.ts";

/**
 * Spec 1.5 plan 21: the role server's operations as commands any role can run from its shell, on a backend
 * whose harness has no role server (opencode, Cursor, Grok Build, agy) or when no MCP tool is listed. In a role
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
  args: { ...GATE, evidence: { type: "string", required: true, description: "what showed it passed" } },
  async run({ args }) {
    assertRoleMay(scope(), args.run, "gate_pass");
    printJson(
      await gatePass(defaultDeps(), {
        run: args.run,
        item: args.item,
        command: args.command,
        paths: pathsOf(args.paths),
        evidence: args.evidence,
      }),
    );
  },
});

export const gateCommand = defineCommand({
  meta: { name: "gate", description: "A verifier's gate evidence: check an item, record a pass" },
  subCommands: { check, pass },
});
