import { scrubSecrets } from "../infra/env.ts";

export interface CliResult {
  ok: boolean;
  out: string;
  err: string;
}

/**
 * Runs `bin <args>` without catherd's secrets and with no stdin; null when `bin` is not on PATH. A call
 * past `timeoutMs` is killed and reported as failed, so a wedged CLI never stalls its caller.
 */
export async function runCli(
  bin: string,
  args: string[],
  o: { timeoutMs: number; env?: Record<string, string> },
): Promise<CliResult | null> {
  if (!Bun.which(bin, { PATH: process.env.PATH ?? "" })) return null;
  const p = Bun.spawn([bin, ...args], {
    env: { ...scrubSecrets(process.env), ...o.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
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
      p.kill("SIGKILL");
      return { ok: false, out: "", err: `${bin} ${args.join(" ")} timed out after ${o.timeoutMs} ms` };
    }
    const [code, out, err] = done;
    return { ok: code === 0, out, err };
  } finally {
    clearTimeout(timer);
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
