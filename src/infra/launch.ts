import { closeSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SECRET_ENV } from "./env.ts";

/** A thin executable that supervises one spec; unlike src/cli.ts it never loads the TUI. */
export const SUPERVISE_ENTRY = fileURLToPath(new URL("../entry/supervise-bin.ts", import.meta.url));

/** Starts `supervise-bin.ts <spec>` in its own session and returns at once; it outlives this process. */
export function launchSupervisor(specPath: string): number {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !SECRET_ENV.has(k)) env[k] = v;
  const log = openSync(join(dirname(specPath), "supervisor.log"), "a");
  const p = Bun.spawn([process.execPath, SUPERVISE_ENTRY, specPath], {
    stdin: "ignore",
    stdout: log,
    stderr: log,
    detached: true,
    env,
  });
  closeSync(log);
  p.unref();
  return p.pid;
}
