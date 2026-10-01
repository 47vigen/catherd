import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

/**
 * Points CATHERD_HOME, the Claude agents dir and Claude Code's config dir at a fresh temp dir for the duration of
 * one test, and takes away the Claude Code session a suite may run in: no test ever messages a real session.
 * Doctor's access probes aim at a closed local port and a docker that does not exist.
 */
export function withHome(): string {
  const home = mkdtempSync(join(tmpdir(), "catherd-home-"));
  process.env.CATHERD_HOME = home;
  // they win over CATHERD_HOME, and an isolated worker running this suite inherits them (movedHomeEnv)
  delete process.env.CATHERD_DATA_DIR;
  delete process.env.CATHERD_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = join(home, "xdg-config");
  // saving a profile links agents into ~/.claude/agents; a test must never touch the real one
  process.env.CATHERD_CLAUDE_AGENTS_DIR = join(home, "claude-agents");
  process.env.CLAUDE_CONFIG_DIR = join(home, "claude-config");
  // doctor's access probes: a closed local port and no docker, so no doctor call reaches the registry or the daemon
  process.env.CATHERD_PROBE_URL = "http://127.0.0.1:9/";
  process.env.CATHERD_PROBE_DOCKER = "catherd-no-docker";
  // the Codex home whose config.toml a worker's writable_roots are read from: never the developer's own
  process.env.CODEX_HOME = join(home, "codex");
  // grok's home, whose sandbox.toml a native workspace-write prepare edits: never the developer's own
  process.env.GROK_HOME = join(home, "grok-home");
  for (const k of [
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "CATHERD_ORCHESTRATION_HOST",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_HOST_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
  ])
    delete process.env[k];
  return home;
}

/**
 * A fresh temp dir, by its real path. macOS's temp dir is behind a symlink (/var → /private/var), and git,
 * `pwd` and a child's cwd all report the real path, so a test comparing paths must start from it.
 */
export const tempDir = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

/** A fresh git repo with one commit, for runner and snapshot tests. */
export function tempRepo(): string {
  const dir = tempDir("catherd-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

/**
 * Every dir and file under `root` (itself included) that its group or others may read, write or enter,
 * as `<path relative to root> <octal mode>`; symlinks are skipped. Empty when all of it is private.
 */
export function openModes(root: string): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) return;
    if (st.mode & 0o077) out.push(`${relative(root, p) || "."} ${(st.mode & 0o777).toString(8)}`);
    if (st.isDirectory()) for (const f of readdirSync(p)) walk(join(p, f));
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** Permission bits mean nothing on Windows: mode tests skip there. */
export const noPosixModes = process.platform === "win32";

/** Call at module scope as `afterEach(snapshotEnv())`: restores process.env key by key after each test. */
export function snapshotEnv(): () => void {
  const saved = { ...process.env };
  return () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  };
}

/** True once `pid` has exited: gone, or a zombie nobody has reaped yet (a container's pid 1 may never reap). */
export function exited(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  const ps = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
    env: process.env,
  });
  const stat = ps.stdout.toString().trim();
  return stat === "" || stat.startsWith("Z");
}
