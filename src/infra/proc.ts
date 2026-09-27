import { existsSync, readFileSync } from "node:fs";
import { scrubSecrets } from "./env.ts";

/** A string that differs between two processes that held the same pid: /proc starttime, else `ps lstart`. */
export function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22 (starttime); the command name in field 2 may hold spaces, so split after its ')'.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return psStartTime(pid);
  }
}

/** `ps` by absolute path where it lives, so a caller with a narrow PATH (a test, a sandbox) still finds it. */
const PS = existsSync("/bin/ps") ? "/bin/ps" : "ps";

/** `ps lstart` for a pid, or null when ps is missing or fails (macOS has no /proc). */
export function psStartTime(
  pid: number,
  env: Record<string, string | undefined> = process.env,
): string | null {
  try {
    // lstart is printed in the local time zone and locale: pin both so every process agrees.
    const ps = Bun.spawnSync([PS, "-o", "lstart=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...scrubSecrets(env), LC_ALL: "C", TZ: "UTC" },
    });
    const out = ps.success ? ps.stdout.toString("utf8").trim() : "";
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Only an integer >= 1 names one real process: 0 and negatives address groups. Pid 1 is valid
 * (catherd may be a container's entrypoint); only killGroup refuses it, since kill(-1) signals everything.
 */
export const isValidPid = (pid: unknown): pid is number => Number.isInteger(pid) && (pid as number) >= 1;

/**
 * Whether a live pid is still the process recorded with `recorded`. A start time that cannot be read now
 * (`ps` fails for a moment on macOS) counts as the same process: a live lock holder or worker is never
 * taken for dead, and the worst case is a lock that times out with E_IO_LOCK instead.
 */
export const sameProcess = (recorded: string | null, current: string | null): boolean =>
  recorded === null || current === null || current === recorded;

/**
 * For a signal only: the pid is live and its start time reads back exactly as recorded. An unreadable or
 * unrecorded start time is not a match, since the pid may belong to another process by now.
 */
export const surelySame = (recorded: string | null, current: string | null): boolean =>
  recorded !== null && current !== null && current === recorded;

export function isSurelyAlive(pid: number, startTime: string | null): boolean {
  return isAlive(pid, startTime) && surelySame(startTime, processStartTime(pid));
}

export function isAlive(pid: number, startTime: string | null): boolean {
  if (!isValidPid(pid)) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  return startTime === null || sameProcess(startTime, processStartTime(pid));
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
