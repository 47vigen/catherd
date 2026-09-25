import { readFileSync } from "node:fs";

/** A string that differs between two processes that held the same pid: /proc starttime, else `ps lstart`. */
export function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22 (starttime); the command name in field 2 may hold spaces, so split after its ')'.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    // lstart is printed in the local time zone and locale: pin both so every process agrees.
    const ps = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    const out = ps.success ? ps.stdout.toString("utf8").trim() : "";
    return out || null;
  }
}

/**
 * Only an integer >= 1 names one real process: 0 and negatives address groups. Pid 1 is valid
 * (catherd may be a container's entrypoint); only killGroup refuses it, since kill(-1) signals everything.
 */
export const isValidPid = (pid: unknown): pid is number => Number.isInteger(pid) && (pid as number) >= 1;

export function isAlive(pid: number, startTime: string | null): boolean {
  if (!isValidPid(pid)) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  return startTime === null || processStartTime(pid) === startTime;
}

/** Signals the process group a detached child leads (pgid === pid), falling back to the pid alone. */
export function killGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!isValidPid(pid) || pid === 1) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}
