import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Points CATHERD_HOME, and the Claude agents dir, at a fresh temp dir for the duration of one test. */
export function withHome(): string {
  const home = mkdtempSync(join(tmpdir(), "catherd-home-"));
  process.env.CATHERD_HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, "xdg-config");
  // saving a profile links agents into ~/.claude/agents; a test must never touch the real one
  process.env.CATHERD_CLAUDE_AGENTS_DIR = join(home, "claude-agents");
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
