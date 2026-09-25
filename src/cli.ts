#!/usr/bin/env bun
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineCommand, runMain } from "citty";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

/** Every subcommand loads lazily, so `mcp`, `lock` and `_supervise` never load OpenTUI or React (spec §3.1). */
export const main = defineCommand({
  meta: { name: "catherd", version: pkg.version, description: "Herds coding agents." },
  subCommands: {
    lock: () => import("./entry/lock.ts").then((m) => m.lockCommand),
    catalog: () => import("./routing/commands.ts").then((m) => m.catalogCommand),
    mcp: () => import("./entry/mcp/command.ts").then((m) => m.mcpCommand),
    init: () => import("./tui/commands.ts").then((m) => m.initCommand),
    watch: () => import("./tui/commands.ts").then((m) => m.watchCommand),
    _supervise: () => import("./entry/supervise.ts").then((m) => m.superviseCommand),
  },
  // citty runs this after any subcommand too; only a bare `catherd` opens the dashboard.
  async run(ctx) {
    if (!ctx.rawArgs.every((a) => a.startsWith("-"))) return;
    await (await import("./tui/commands.ts")).editorRun(ctx);
  },
});

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runMain(main);
}
