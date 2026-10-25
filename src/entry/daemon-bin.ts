#!/usr/bin/env bun
// The detached run daemon's entry: like the supervisor's it imports only what driving a run needs, never
// src/cli.ts.
import { errorMessage } from "../domain/errors.ts";
import { runDaemon, superviseDaemon } from "../services/daemon.ts";
import { defaultDeps } from "./deps.ts";

const runId = process.argv[2];
if (!runId) {
  console.error("usage: daemon-bin.ts <run id>");
  process.exit(2);
}
try {
  // nobody's role and no Claude Code session: the daemon answers to the run's events
  const result = await superviseDaemon(() =>
    runDaemon({ ...defaultDeps(), session: null, role: null }, runId),
  );
  if (result === "lost-lock") console.error(`catherd daemon: another daemon holds run ${runId}`);
} catch (e) {
  console.error(`catherd daemon: ${errorMessage(e)}`);
  process.exit(1);
}
// the lock is released and the run's events are written: a hook's call left hanging must not keep it alive
process.exit(0);
