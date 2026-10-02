#!/usr/bin/env bun
import { HOST_ARG } from "./entry/host-arg.ts";
import type { ArgsDef } from "citty";
import { errorMessage } from "./domain/errors.ts";
import { runtimeRefusal } from "./domain/runtime.ts";

// Spec §3.1: refuse an old Bun before anything else loads.
const refusal = runtimeRefusal(typeof Bun === "undefined" ? undefined : Bun.version);
if (refusal) {
  for (const line of refusal) console.error(line);
  process.exit(1);
}

const { realpathSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");
const { defineCommand, renderUsage, runCommand, parseArgs } = await import("citty");
const { CatherdError, isCatherdError } = await import("./domain/errors.ts");
const { EXIT, exitCodeOf, printError, stripAnsi } = await import("./entry/cli-kit.ts");
const { VERSION } = await import("./infra/version.ts");

type Command = ReturnType<typeof defineCommand>;

/** The dashboard's flags, typed as any command's args so `main` stays a plain `Command`. */
const dashboardArgs: ArgsDef = {
  ...HOST_ARG,
  plain: {
    type: "boolean",
    description: "the dashboard in ASCII without colour (NO_COLOR also drops colour)",
  },
  "reduced-motion": { type: "boolean", description: "the dashboard without animation" },
};

/**
 * Spec §8. Every subcommand loads lazily, so `mcp`, `lock` and `_supervise` never load OpenTUI or React
 * (spec §3.1); a bare `catherd` opens the TUI.
 */
export const main: Command = defineCommand({
  meta: {
    name: "catherd",
    version: VERSION,
    description: "Herds coding agents",
  },
  args: dashboardArgs,
  subCommands: {
    init: () => import("./entry/init-command.ts").then((m) => m.initCommand),
    status: () => import("./entry/runs-command.ts").then((m) => m.statusCommand),
    watch: () => import("./entry/runs-command.ts").then((m) => m.watchCommand),
    runs: () => import("./entry/runs-command.ts").then((m) => m.runsCommand),
    profile: () => import("./entry/profile-command.ts").then((m) => m.profileCommand),
    doctor: () => import("./entry/doctor-command.ts").then((m) => m.doctorCommand),
    catalog: () => import("./entry/catalog-command.ts").then((m) => m.catalogCommand),
    knowledge: () => import("./entry/knowledge-command.ts").then((m) => m.knowledgeCommand),
    workspace: () => import("./entry/workspace-command.ts").then((m) => m.workspaceCommand),
    lock: () => import("./entry/lock-command.ts").then((m) => m.lockCommand),
    "run-file": () => import("./entry/role-cli-command.ts").then((m) => m.runFileCommand),
    gate: () => import("./entry/role-cli-command.ts").then((m) => m.gateCommand),
    pause: () => import("./entry/pause-command.ts").then((m) => m.pauseCommand),
    resume: () => import("./entry/pause-command.ts").then((m) => m.resumeCommand),
    "capture-fixtures": () =>
      import("./entry/capture-fixtures-command.ts").then((m) => m.captureFixturesCommand),
    mcp: () => import("./entry/mcp/command.ts").then((m) => m.mcpCommand),
    _supervise: () => import("./entry/supervise-command.ts").then((m) => m.superviseCommand),
  },
  // citty runs this after any subcommand too; only a bare `catherd` loads and opens the dashboard
  async run(ctx) {
    if (ctx.args._.length > 0) return;
    await (await import("./entry/tui/run.tsx")).tuiRun(ctx);
  },
});

const resolve = async <T>(v: T | Promise<T> | (() => T | Promise<T>)): Promise<T> =>
  typeof v === "function" ? await (v as () => T | Promise<T>)() : await v;

/** The deepest command `argv` names and its parent: what `--help` and a usage error describe. */
async function commandFor(argv: string[]): Promise<[Command, Command | undefined, string[]]> {
  let cmd = main;
  let parent: Command | undefined;
  const path: string[] = [];
  let remaining = argv;
  while (true) {
    const defs = await resolve(cmd.args ?? {});
    const navigationArgs: ArgsDef = Object.fromEntries(
      Object.entries(defs).map(([key, def]) => [
        key,
        { ...def, required: false, ...(def.type === "enum" ? { type: "string" as const } : {}) },
      ]),
    ) as ArgsDef;
    const a = parseArgs(remaining, navigationArgs)._[0];
    if (!a) break;
    const subs = cmd.subCommands ? await resolve(cmd.subCommands) : undefined;
    const next = subs?.[a];
    if (!next) break;
    parent = cmd;
    cmd = (await resolve(next)) as Command;
    path.push(a);
    remaining = remaining.slice(remaining.indexOf(a) + 1);
  }
  return [cmd, parent, path];
}

/** runCli takes `--verbose` before any command, so every command's help lists it. */
const VERBOSE_ARG: ArgsDef = {
  verbose: { type: "boolean", description: "log at debug level (CATHERD_LOG=debug)" },
};

/**
 * `--help` for the command `path` names (spec §8): `catherd <path>` with the version at every depth, the
 * usage line a command spells out itself, and no colour codes when piped or under NO_COLOR.
 */
async function helpText(cmd: Command, path: string[]): Promise<string> {
  const shown = { ...cmd, args: { ...(await resolve(cmd.args ?? {})), ...VERBOSE_ARG } };
  const parent = path.length
    ? defineCommand({ meta: { name: ["catherd", ...path.slice(0, -1)].join(" "), version: VERSION } })
    : undefined;
  let text = await renderUsage(shown, parent);
  const usage = path[0] === "lock" ? (await import("./entry/lock-command.ts")).LOCK_USAGE : undefined;
  if (usage) text = text.replace(/^(\S*USAGE\S*) .*$/m, (_, head: string) => `${head} ${usage}`);
  return process.stdout.isTTY && !process.env.NO_COLOR ? text : stripAnsi(text);
}

/** citty's "Unknown command x." worded as catherd's own messages: lower case, no full stop (audit N5). */
const cittyWording = (m: string): string => `${m.charAt(0).toLowerCase()}${m.slice(1)}`.replace(/\.$/, "");

const isCliError = (e: unknown): e is Error & { code: string } => e instanceof Error && e.name === "CLIError";

/** Runs `catherd <argv>` and returns its exit code (spec §8). */
export async function runCli(argv: string[]): Promise<number> {
  // catherd's own flags are those before `--`; everything after belongs to the command `lock` runs
  const dashdash = argv.indexOf("--");
  const head = dashdash < 0 ? argv : argv.slice(0, dashdash);
  if (head.includes("--verbose")) process.env.CATHERD_LOG = "debug";
  const own = head.filter((a) => a !== "--verbose");
  const rawArgs = [...own, ...(dashdash < 0 ? [] : argv.slice(dashdash))];
  if (own.length === 1 && (own[0] === "--version" || own[0] === "-v")) {
    console.log(VERSION);
    return EXIT.ok;
  }
  if (own.includes("--help") || own.includes("-h")) {
    const [cmd, , path] = await commandFor(own);
    console.log(`${await helpText(cmd, path)}\n`);
    return EXIT.ok;
  }
  try {
    const command = parseArgs(own, dashboardArgs)._[0];
    // a bare `catherd` opens the dashboard, which takes only its own flags: a typo is not a terminal problem
    const flag = (a: string) => (a.startsWith("--") ? (a.slice(2).split("=")[0] ?? "") : "");
    // citty negates a boolean as `--no-<name>`
    const known = (name: string) =>
      Object.hasOwn(dashboardArgs, name) ||
      (name.startsWith("no-") && dashboardArgs[name.slice(3)]?.type === "boolean");
    const unknown =
      command === undefined
        ? own.find((a, i) => a.startsWith("-") && !known(flag(a)) && own[i - 1] !== "--host")
        : undefined;
    if (unknown !== undefined) {
      printError(new CatherdError("E_INPUT_INVALID", `unknown option ${unknown}`, { fix: "catherd --help" }));
      return EXIT.usage;
    }
    // `lock` forwards signals to its command itself; everything else stops at once on Ctrl-C. The command is
    // the first word that is not a flag: `catherd --plain lock -- …` is `lock` too.
    if (command !== "lock") process.once("SIGINT", () => process.exit(EXIT.interrupted));
    const parsed = parseArgs(own, dashboardArgs);
    if (parsed.host !== undefined) {
      const forwarded = own.filter(
        (a, i) => a !== "--host" && own[i - 1] !== "--host" && !a.startsWith("--host="),
      );
      rawArgs.splice(
        0,
        rawArgs.length,
        ...forwarded,
        "--host",
        String(parsed.host),
        ...(dashdash < 0 ? [] : argv.slice(dashdash)),
      );
    }
    await runCommand(main, { rawArgs });
    return Number(process.exitCode ?? EXIT.ok);
  } catch (e) {
    if (isCliError(e)) {
      const [, , path] = await commandFor(own);
      printError(
        new CatherdError("E_INPUT_INVALID", cittyWording(stripAnsi(e.message)), {
          fix: `catherd ${[...path, "--help"].join(" ")}`,
        }),
      );
      return EXIT.usage;
    }
    if (isCatherdError(e)) {
      printError(e);
      return exitCodeOf(e);
    }
    printError({
      code: "E_IO_UNEXPECTED",
      message: errorMessage(e),
      fix: "this is a catherd bug: report it with this message and the output of the same command with --verbose",
    });
    return EXIT.error;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
