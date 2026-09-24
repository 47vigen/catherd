#!/usr/bin/env bun
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineCommand, runMain } from "citty";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

export const main = defineCommand({
  meta: { name: "catherd", version: pkg.version, description: "Herds coding agents." },
  subCommands: {},
});

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runMain(main);
}
