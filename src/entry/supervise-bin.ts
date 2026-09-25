#!/usr/bin/env bun
// The detached supervisor's entry: it imports only what supervising needs, never src/cli.ts and its TUI.
import { runSupervise } from "./supervise.ts";

const spec = process.argv[2];
if (!spec) {
  console.error("usage: supervise-bin.ts <spec.json>");
  process.exit(2);
}
await runSupervise(spec);
