import { checkEnv } from "../infra/env.ts";
import { loginEnv } from "../infra/login-env.ts";
import { killGroup } from "../infra/proc.ts";
import { readGateEnv, resolveGateEnv } from "./gate-env.ts";
import { TAIL_LINES } from "./run-debug.ts";

// Plan 50: how catherd runs a check command (the architect's checks, a run tree's Setup:, the scorecard), kept
// from the 2.0 preflight, which is deleted.

/** How many output lines a check keeps in full for its failure lines; past it, only the tail. */
const ALLOW_LINES = 1_000;

/** How long the pipes may stay open after the check's own process exits. */
export const DRAIN_MS = 500;

/** Reads a pipe chunk by chunk, so what arrived is kept when the reading stops early. */
export function collect(stream: ReadableStream<Uint8Array>): {
  done: Promise<void>;
  text: () => string;
  stop: () => void;
} {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      text += decoder.decode(value, { stream: true });
    }
  })().catch(() => {
    // a pipe that breaks ends the reading; what arrived is kept
  });
  // cancelling a pipe that is already closed has nothing to report
  return { done, text: () => text, stop: () => void reader.cancel().catch(() => {}) };
}

/**
 * Runs `check` with `sh -c` in its own process group, with an allowlisted env (no credentials), killing the
 * group on timeout. A process the check leaves behind (even in a new session) may hold the pipes open: once
 * the check exits, the pipes get DRAIN_MS to close, then the reading stops with what arrived.
 */
export async function runCheck(
  repo: string,
  check: string,
  timeoutMs: number,
  env: Record<string, string> = checkEnv(process.env, repo),
): Promise<{ code: number | null; timedOut: boolean; tail: string[]; lines: string[] }> {
  const p = Bun.spawn(["sh", "-c", check], {
    cwd: repo,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(p.pid, "SIGKILL");
  }, timeoutMs);
  const out = collect(p.stdout);
  const err = collect(p.stderr);
  try {
    // the timeout kills the group, so the check's own process always exits
    const code = await p.exited;
    clearTimeout(timer); // the check is done: a slow drain is not a timeout
    const drained = await Promise.race([
      Promise.all([out.done, err.done]).then(() => true),
      Bun.sleep(DRAIN_MS).then(() => false),
    ]);
    if (!drained) killGroup(p.pid, "SIGKILL"); // leftovers still in the check's group
    // every line, up to a bound, for the failing lines; the tail is what the report shows
    const all = `${out.text()}${err.text()}`.split("\n").filter((l) => l.trim());
    const lines = all.length <= ALLOW_LINES ? all : [];
    return { code: timedOut ? null : code, timedOut, tail: all.slice(-TAIL_LINES), lines };
  } finally {
    clearTimeout(timer);
    out.stop();
    err.stop();
  }
}

/**
 * Plan 23: a check that failed on the machine, not on the code: no Docker (or none at DOCKER_HOST), no DNS, a
 * permission the sandbox or the OS denied. Such a check cannot start; it never fails as expected.


/**
 * Plan 23: a check runs in the user's login environment (DOCKER_HOST and the rest a login shell sets), through
 * the allowlist, plus the repo's gate environment. A login PATH comes first, with the server's own after it.
 */
export async function checkEnvFor(repo: string): Promise<Record<string, string>> {
  const login = loginEnv();
  const base: Record<string, string | undefined> = { ...process.env, ...login };
  const path = [
    ...new Set([...(login.PATH ?? "").split(":"), ...(process.env.PATH ?? "").split(":")].filter(Boolean)),
  ];
  if (path.length) base.PATH = path.join(":");
  return { ...checkEnv(base, repo), ...resolveGateEnv(await readGateEnv(repo), base).env };
}
