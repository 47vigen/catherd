import { readFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";

const MB = 2 ** 20;

const sysctlLevel = (): string | null => {
  try {
    const r = Bun.spawnSync(["sysctl", "-n", "kern.memorystatus_level"]);
    return r.exitCode === 0 ? r.stdout.toString() : null;
  } catch {
    return null;
  }
};

const procMeminfo = (): string | null => {
  try {
    return readFileSync("/proc/meminfo", "utf8");
  } catch {
    return null;
  }
};

/**
 * The memory the machine could give a new process, in MB. macOS reports almost nothing through `os.freemem()`
 * (it counts cache as used), so it is the kernel's free percentage of the total; Linux has `MemAvailable`;
 * anything unreadable falls back to `os.freemem()`. Never throws.
 */
export function availableMemoryMb(
  o: {
    platform?: NodeJS.Platform;
    sysctl?: () => string | null;
    meminfo?: () => string | null;
  } = {},
): number {
  const platform = o.platform ?? process.platform;
  if (platform === "darwin") {
    const level = Number.parseInt((o.sysctl ?? sysctlLevel)() ?? "", 10);
    if (Number.isInteger(level) && level >= 0 && level <= 100)
      return Math.floor(((level / 100) * totalmem()) / MB);
  } else if (platform === "linux") {
    const kb = /^MemAvailable:\s+(\d+) kB$/m.exec((o.meminfo ?? procMeminfo)() ?? "")?.[1];
    if (kb !== undefined) return Math.floor(Number(kb) / 1024);
  }
  return Math.floor(freemem() / MB);
}
