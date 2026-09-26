import { closeSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scrubSecrets } from "./env.ts";
import { log as logRow } from "./log.ts";

/** A thin executable that supervises one spec; unlike src/cli.ts it never loads the TUI. */
export const SUPERVISE_ENTRY = fileURLToPath(new URL("../entry/supervise-bin.ts", import.meta.url));

/** Starts `supervise-bin.ts <spec>` in its own session and returns at once; it outlives this process. */
export function launchSupervisor(specPath: string): number {
  const log = openSync(join(dirname(specPath), "supervisor.log"), "a");
  const p = Bun.spawn([process.execPath, SUPERVISE_ENTRY, specPath], {
    stdin: "ignore",
    stdout: log,
    stderr: log,
    detached: true,
    env: scrubSecrets(process.env),
  });
  closeSync(log);
  p.unref();
  logRow("info", "launch", { spec: specPath, pid: p.pid });
  return p.pid;
}
