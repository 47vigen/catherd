#!/usr/bin/env bun
import { runtimeRefusal } from "./domain/runtime.ts";

// Spec §3.1: refuse an old Bun before anything else loads.
const refusal = runtimeRefusal(typeof Bun === "undefined" ? undefined : Bun.version);
if (refusal) {
  for (const line of refusal) console.error(line);
  process.exit(1);
}

const { realpathSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");
const { defineCommand, runCommand, showUsage } = await import("citty");
const { CatherdError, isCatherdError } = await import("./domain/errors.ts");
const { EXIT, exitCodeOf, printError } = await import("./entry/cli-kit.ts");
const { VERSION } = await import("./infra/version.ts");

type Command = ReturnType<typeof defineCommand>;

/**
 * Spec §8. Every subcommand loads lazily, so `mcp`, `lock` and `_supervise` never load OpenTUI or React
 * (spec §3.1); a bare `catherd` opens the TUI.
 */
export const main: Command = defineCommand({
  meta: {
    name: "catherd",
    version: VERSION,
    description: "Herds coding agents. Any command takes --verbose: log at debug level (CATHERD_LOG=debug).",
  },
  subCommands: {
    init: () => import("./tui/commands.ts").then((m) => m.initCommand),
    status: () => import("./entry/runs-command.ts").then((m) => m.statusCommand),
    watch: () => import("./entry/runs-command.ts").then((m) => m.watchCommand),
    runs: () => import("./entry/runs-command.ts").then((m) => m.runsCommand),
    profile: () => import("./entry/profile-command.ts").then((m) => m.profileCommand),
    doctor: () => import("./entry/doctor-command.ts").then((m) => m.doctorCommand),
    catalog: () => import("./entry/catalog-command.ts").then((m) => m.catalogCommand),
    lock: () => import("./entry/lock.ts").then((m) => m.lockCommand),
    "capture-fixtures": () => import("./entry/capture-fixtures.ts").then((m) => m.captureFixturesCommand),
    mcp: () => import("./entry/mcp/command.ts").then((m) => m.mcpCommand),
    _supervise: () => import("./entry/supervise.ts").then((m) => m.superviseCommand),
  },
  // citty runs this after any subcommand too; only a bare `catherd` opens the dashboard.
  async run(ctx) {
    if (!ctx.rawArgs.every((a) => a.startsWith("-"))) return;
    await (await import("./tui/commands.ts")).editorRun(ctx);
  },
});

const resolve = async <T>(v: T | Promise<T> | (() => T | Promise<T>)): Promise<T> =>
  typeof v === "function" ? await (v as () => T | Promise<T>)() : await v;

/** The deepest command `argv` names and its parent: what `--help` and a usage error describe. */
async function commandFor(argv: string[]): Promise<[Command, Command | undefined, string[]]> {
  let cmd = main;
  let parent: Command | undefined;
  const path: string[] = [];
  for (const a of argv) {
    if (a.startsWith("-")) continue;
    const subs = cmd.subCommands ? await resolve(cmd.subCommands) : undefined;
    const next = subs?.[a];
    if (!next) break;
    parent = cmd;
    cmd = (await resolve(next)) as Command;
    path.push(a);
  }
  return [cmd, parent, path];
}

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
    const [cmd, parent] = await commandFor(own);
    await showUsage(cmd, parent);
    return EXIT.ok;
  }
  // `lock` forwards signals to its command itself; everything else stops at once on Ctrl-C.
  if (own[0] !== "lock") process.once("SIGINT", () => process.exit(EXIT.interrupted));
  try {
    await runCommand(main, { rawArgs });
    return Number(process.exitCode ?? EXIT.ok);
  } catch (e) {
    if (isCliError(e)) {
      const [, , path] = await commandFor(own);
      printError(
        new CatherdError("E_INPUT_INVALID", e.message, { fix: `catherd ${[...path, "--help"].join(" ")}` }),
      );
      return EXIT.usage;
    }
    if (isCatherdError(e)) {
      printError(e);
      return exitCodeOf(e);
    }
    printError({
      code: "E_IO_UNEXPECTED",
      message: e instanceof Error ? e.message : String(e),
      fix: "this is a catherd bug: report it with this message and the output of the same command with --verbose",
    });
    return EXIT.error;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
