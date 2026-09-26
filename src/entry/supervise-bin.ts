#!/usr/bin/env bun
// The detached supervisor's entry: it imports only what supervising needs, never src/cli.ts and its TUI.
import { runSupervise } from "./supervise.ts";

const spec = process.argv[2];
if (!spec) {
  console.error("usage: supervise-bin.ts <spec.json>");
  process.exit(2);
}
try {
  await runSupervise(spec);
} catch (e) {
  console.error(`catherd supervisor: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
// exit.json is written: a hook's call the supervisor cut off (a hung `opencode api`) must not keep it alive.
process.exit(0);
