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

/** The temp dir by its real path (macOS: /var/folders/… is /private/var/folders/…); sandboxes compare real paths. */
export function realTmpdir(): string {
  try {
    return realpathSync(tmpdir());
  } catch {
    return tmpdir();
  }
}

/** The directories a workspace-write worker writes besides the repo: the heavy-lock dir and the temp dir. */
export const writableRoots = (): string[] => [locksDir(), realTmpdir()];

/**
 * The local Docker socket a worker may talk to: `DOCKER_HOST` when it names a unix socket, else the first
 * of the usual paths that exists (OrbStack and Docker Desktop link /var/run/docker.sock; Colima does not).
 */
export function dockerSocket(): string | null {
  const host = process.env.DOCKER_HOST;
  if (host?.startsWith("unix://")) return host.slice("unix://".length);
  for (const p of [
    "/var/run/docker.sock",
    join(homedir(), ".orbstack", "run", "docker.sock"),
    join(homedir(), ".docker", "run", "docker.sock"),
    join(homedir(), ".colima", "default", "docker.sock"),
  ])
    if (existsSync(p)) return p;
  return null;
}
