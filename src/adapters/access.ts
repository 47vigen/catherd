import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { locksDir } from "../infra/paths.ts";
import type { AccessShell } from "./backend.ts";
import { runCli } from "./cli.ts";

/** How long one access probe may run: an HTTPS fetch through a slow proxy included. */
export const probeShell = { timeoutMs: 20_000 };

/**
 * A probe shell from a fresh scratch dir: `prefix` is the argv before `sh -c <script> _ <args…>` (empty for
 * a backend whose worker shell runs unsandboxed).
 */
export function scratchShell(how: string, prefix: string[]): AccessShell {
  const cwd = mkdtempSync(join(realTmpdir(), "catherd-probe-"));
  const [bin, ...rest] = prefix.length ? prefix : ["sh"];
  const sh = prefix.length ? ["sh"] : [];
  return {
    how,
    run: (script, args) =>
      runCli(bin as string, [...rest, ...sh, "-c", script, "_", ...args], { ...probeShell, cwd }),
    close: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

// Spec §5: what a workspace-write worker may reach besides the repo, as each backend's own flags grant it.

/** `p` by its real path when it exists (macOS: /var/folders/… is /private/var/folders/…), else as given. */
function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** The temp dir by its real path (macOS: /var/folders/… is /private/var/folders/…); sandboxes compare real paths. */
export const realTmpdir = (): string => realOr(tmpdir());

/** The directories a workspace-write worker writes besides the repo: the heavy-lock dir and the temp dir, real paths. */
export const writableRoots = (): string[] => [realOr(locksDir()), realTmpdir()];

/** The usual local Docker sockets, in the order they are tried (OrbStack and Docker Desktop link /var/run/docker.sock). */
export const dockerSocketCandidates = (home = homedir()): string[] => [
  "/var/run/docker.sock",
  join(home, ".orbstack", "run", "docker.sock"),
  join(home, ".docker", "run", "docker.sock"),
  join(home, ".colima", "default", "docker.sock"),
];

/**
 * The local Docker socket a worker may talk to, by its real path: the one `DOCKER_HOST` names when it is a
 * unix socket; none when it names a remote daemon (tcp://, ssh://…), which the user's docker client uses
 * instead of any local socket; else the first of `candidates` that exists.
 */
export function dockerSocket(candidates = dockerSocketCandidates()): string | null {
  const host = process.env.DOCKER_HOST;
  if (host?.startsWith("unix://")) return realOr(host.slice("unix://".length));
  if (host) return null;
  const found = candidates.find((p) => existsSync(p));
  return found ? realOr(found) : null;
}
