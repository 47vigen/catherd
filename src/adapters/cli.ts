import { scrubSecrets } from "../infra/env.ts";
import { log } from "../infra/log.ts";
import { killGroup } from "../infra/proc.ts";

export interface CliResult {
  ok: boolean;
  out: string;
  err: string;
}

/** Process groups of CLI calls still running: an exiting catherd (Ctrl-C is exit 130) kills them. */
const live = new Set<number>();
let hooked = false;
function track(pid: number): void {
  live.add(pid);
  if (hooked) return;
  hooked = true;
  // a detached group gets no terminal SIGINT, and process.exit skips the timeout, so kill it on the way out
  process.on("exit", () => {
    for (const g of live) killGroup(g, "SIGKILL");
  });
}

/**
 * Runs `bin <args>` without catherd's secrets and with no stdin; null when `bin` is not on PATH. A call
 * past `timeoutMs` is killed with every process it started (it runs in its own process group) and is
 * reported as failed, so neither a wedged CLI nor a child holding its pipes stalls the caller.
 */
export async function runCli(
  bin: string,
  args: string[],
  o: { timeoutMs: number; env?: Record<string, string>; cwd?: string },
): Promise<CliResult | null> {
  if (!Bun.which(bin, { PATH: process.env.PATH ?? "" })) return null;
  log("debug", "spawn", { argv: [bin, ...args], env: o.env ?? {} });
  const p = Bun.spawn([bin, ...args], {
    cwd: o.cwd,
    env: { ...scrubSecrets(process.env), ...o.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  track(p.pid);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), o.timeoutMs);
  });
  try {
    const done = await Promise.race([
      Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]),
      late,
    ]);
    if (!done) {
      killGroup(p.pid, "SIGKILL");
      return { ok: false, out: "", err: `${bin} ${args.join(" ")} timed out after ${o.timeoutMs} ms` };
    }
    const [code, out, err] = done;
    return { ok: code === 0, out, err };
  } finally {
    clearTimeout(timer);
    live.delete(p.pid);
  }
}

/** The JSON a CLI printed, or null for empty or unreadable output. */
export function jsonOf(out: string | undefined): unknown {
  if (!out?.trim()) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}
