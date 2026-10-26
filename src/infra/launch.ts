import { closeSync, existsSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROLE_ENV } from "../domain/role-scope.ts";
import { scrubSecrets } from "./env.ts";
import { log as logRow } from "./log.ts";
import { PRIVATE_FILE } from "./store.ts";

/** A thin executable that supervises one spec; it never loads src/cli.ts. */
export const SUPERVISE_ENTRY = fileURLToPath(new URL("../entry/supervise-bin.ts", import.meta.url));

/** The thin executable that drives one run; like the supervisor's, it never loads src/cli.ts. */
export const DAEMON_ENTRY = fileURLToPath(new URL("../entry/daemon-bin.ts", import.meta.url));

/** The thin executable that runs one milestone check (plan 30b); like the others it never loads src/cli.ts. */
export const CHECK_ENTRY = fileURLToPath(new URL("../entry/check-bin.ts", import.meta.url));

/** This process's Bun while it exists (an upgrade can remove it), else `bun` on PATH. */
export function bunBinary(execPath = process.execPath, which = Bun.which): string {
  return existsSync(execPath) ? execPath : (which("bun") ?? execPath);
}

/**
 * Starts `entry args` in its own session, its output appended to `logFile`, and returns at once: the process
 * outlives this one.
 */
export function launchDetached(
  entry: string,
  args: string[],
  logFile: string,
  env: Record<string, string>,
): number {
  const log = openSync(logFile, "a", PRIVATE_FILE);
  const p = Bun.spawn([bunBinary(), entry, ...args], {
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

/** Starts `supervise-bin.ts <spec>` in its own session and returns at once; it outlives this process. */
export function launchSupervisor(specPath: string): number {
  const pid = launchDetached(
    SUPERVISE_ENTRY,
    [specPath],
    join(dirname(specPath), "supervisor.log"),
    scrubSecrets(process.env),
  );
  logRow("info", "launch", { spec: specPath, pid });
  return pid;
}

/**
 * The daemon's env (spec 2.0, plan 30 ruling 4): the launching process's own, so Jev's key reaches its routing,
 * without the session identity of whoever launched it, and never a role's scope: it is nobody's role.
 */
export function daemonEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env = scrubSecrets(base);
  if (base.TYPESAFE_API_KEY !== undefined) env.TYPESAFE_API_KEY = base.TYPESAFE_API_KEY;
  if (base.CATHERD_DECISION_KEY !== undefined) env.CATHERD_DECISION_KEY = base.CATHERD_DECISION_KEY;
  delete env[ROLE_ENV];
  return env;
}

/** Starts `daemon-bin.ts <run id>` for a run; its log is `<run dir>/daemon.log`. */
export function launchDaemon(runId: string, runDir: string): number {
  const pid = launchDetached(DAEMON_ENTRY, [runId], join(runDir, "daemon.log"), daemonEnv());
  logRow("info", "launch", { daemon: runId, pid });
  return pid;
}

/** Starts `check-bin.ts <flight file>` detached, so a tool timeout that kills its caller does not lose the check. */
export function launchCheckWorker(flight: string): number {
  const pid = launchDetached(
    CHECK_ENTRY,
    [flight],
    join(dirname(flight), "worker.log"),
    scrubSecrets(process.env),
  );
  logRow("info", "launch", { check: flight, pid });
  return pid;
}
