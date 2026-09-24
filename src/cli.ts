#!/usr/bin/env bun
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineCommand, runMain } from "citty";
import { lockCommand } from "./core/lock.ts";
import { mcpCommand } from "./mcp/commands.ts";
import { catalogCommand } from "./routing/commands.ts";
import { editorRun, initCommand } from "./tui/commands.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export const main = defineCommand({
  meta: { name: "catherd", version: pkg.version, description: "Herds coding agents." },
  subCommands: { lock: lockCommand, catalog: catalogCommand, mcp: mcpCommand, init: initCommand },
  run: editorRun,
});

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runMain(main);
}
