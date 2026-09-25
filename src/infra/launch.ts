import { closeSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI_PATH = fileURLToPath(new URL("../cli.ts", import.meta.url));

/** Starts `catherd _supervise <spec>` in its own session and returns at once; it outlives this process. */
export function launchSupervisor(specPath: string): number {
  const log = openSync(join(dirname(specPath), "supervisor.log"), "a");
  const p = Bun.spawn([process.execPath, CLI_PATH, "_supervise", specPath], {
    stdin: "ignore",
    stdout: log,
    stderr: log,
    detached: true,
    env: process.env,
  });
  closeSync(log);
  p.unref();
  return p.pid;
}
