import { closeSync, existsSync, openSync, readFileSync } from "node:fs";

export interface ChildOpts {
  cwd: string;
  env: Record<string, string | undefined>;
  /** file to feed on stdin; stdin is /dev/null without it */
  stdinFile?: string;
  stdoutFile: string;
  stderrFile: string;
  /** called with each batch of new stdout lines, every pollMs */
  onLines?: (lines: string[]) => void;
  pollMs?: number;
  /** called every tickMs while the child runs */
  onTick?: () => void;
  tickMs?: number;
  /** called once, right after the child starts */
  onSpawn?: (c: { pid: number; kill: () => void }) => void;
}

export interface ChildResult {
  code: number | null;
  pid: number | null;
  signal: NodeJS.Signals | null;
}

export function readLines(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim());
}

/** Kills the whole process group a detached child leads (pgid === pid on POSIX). */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

/**
 * The child gets raw file descriptors, not a pipe through this process, so no stream passes
 * through catherd: with `detached: true` it starts its own process group (POSIX `setsid()`),
 * outlives catherd, and `reconcileLive` reads its files after a restart.
 */
export async function runChild(cmd: string, args: string[], o: ChildOpts): Promise<ChildResult> {
  if (!Bun.which(cmd, { PATH: o.env?.PATH ?? process.env.PATH ?? "" })) {
    throw new Error(`catherd: ${cmd} is not on PATH; install it, or untick its models in the profile`);
  }
  const stdin = o.stdinFile ? openSync(o.stdinFile, "r") : "ignore";
  const stdout = openSync(o.stdoutFile, "w");
  const stderr = openSync(o.stderrFile, "w");
  const proc = Bun.spawn([cmd, ...args], {
    cwd: o.cwd,
    env: o.env,
    stdin,
    stdout,
    stderr,
    detached: true,
  });
  for (const fd of [stdin, stdout, stderr]) if (typeof fd === "number") closeSync(fd);
  const pid = proc.pid;
  if (pid) o.onSpawn?.({ pid, kill: () => killGroup(pid) });
  let seen = 0;
  const drain = () => {
    const lines = readLines(o.stdoutFile);
    if (lines.length > seen) {
      o.onLines?.(lines.slice(seen));
      seen = lines.length;
    }
  };
  const poll = o.onLines ? setInterval(drain, o.pollMs ?? 1000) : null;
  const tick = o.onTick ? setInterval(o.onTick, o.tickMs ?? 60_000) : null;
  let code: number | null;
  try {
    code = await proc.exited;
  } finally {
    if (poll) clearInterval(poll);
    if (tick) clearInterval(tick);
  }
  if (o.onLines) drain();
  if (!pid) throw new Error(`catherd: could not start ${cmd}`);
  return { code, pid, signal: proc.signalCode ?? null };
}
