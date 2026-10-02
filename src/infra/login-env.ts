import { scrubSecrets } from "./env.ts";

// Plan 23: what a login shell of the user's sees (DOCKER_HOST for OrbStack or rootless Docker, a proxy, a
// toolchain's PATH), which a server started by a desktop app or a plugin launcher may not inherit.
// `$SHELL -lc env` is run once per process and kept.

/** How long the login shell may take; one that hangs (a prompt in a profile) counts as an empty env. */
export const loginShell = { timeoutMs: 5_000 };

let captured: Record<string, string> | null = null;

/** Parses `env -0` output, or plain `env` lines from a shell whose env has no -0. */
export function parseEnv(out: string): Record<string, string> {
  const env: Record<string, string> = {};
  const rows = out.includes("\0") ? out.split("\0") : out.split("\n");
  for (const row of rows) {
    const eq = row.indexOf("=");
    if (eq > 0) env[row.slice(0, eq)] = row.slice(eq + 1);
  }
  return env;
}

function capture(): Record<string, string> {
  const shell = process.env.SHELL || "/bin/sh";
  try {
    const r = Bun.spawnSync([shell, "-lc", "env -0 2>/dev/null || env"], {
      env: scrubSecrets(process.env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: loginShell.timeoutMs,
    });
    return r.exitCode === 0 ? scrubSecrets(parseEnv(r.stdout.toString())) : {};
  } catch {
    return {};
  }
}

/** The user's login environment, without catherd's secrets; empty when the shell cannot say. Captured once. */
export function loginEnv(): Record<string, string> {
  captured ??= capture();
  return captured;
}

/** Forgets the captured env (tests, which change SHELL). */
export function resetLoginEnv(): void {
  captured = null;
}
