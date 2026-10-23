import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { indexPath } from "../src/infra/paths.ts";
import { writeIndexFile } from "../src/infra/slopalytics.ts";

/**
 * Points CATHERD_HOME, the Claude agents dir and Claude Code's config dir at a fresh temp dir for the duration of
 * one test, and takes away the Claude Code session a suite may run in: no test ever messages a real session.
 * Doctor's access probes aim at a closed local port and a docker that does not exist.
 */
export function withHome(o: { index?: boolean } = {}): string {
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
  // the recorded Slopalytics index, checked just now (so no test sees it stale), and no test reaches the proxy;
  // a test of the data dir's own creation passes `index: false`, since the seed creates the dir
  if (o.index === false) return home;
  const recorded = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "slopalytics.json"), "utf8"));
  writeIndexFile(indexPath(), { ...recorded, checkedAt: new Date().toISOString() });
  return home;
}

/**
 * A fresh temp dir, by its real path. macOS's temp dir is behind a symlink (/var → /private/var), and git,
 * `pwd` and a child's cwd all report the real path, so a test comparing paths must start from it.
 */
export const tempDir = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

let bunBin: string | undefined;

/**
 * A folder holding only `bun` and `bunx`, for a PATH that must find bun and nothing else: bun's own folder can be
 * /opt/homebrew/bin, which also has the developer's real claude, codex, opencode and gh.
 */
export function bunOnlyBin(): string {
  if (!bunBin) {
    bunBin = tempDir("catherd-bun-bin-");
    for (const name of ["bun", "bunx"]) symlinkSync(process.execPath, join(bunBin, name));
  }
  return bunBin;
}

let repoTemplate: string | undefined;

/** A fresh git repo with one commit, for runner and snapshot tests: a copy of one template built per process. */
export function tempRepo(): string {
  if (!repoTemplate) {
    repoTemplate = tempDir("catherd-repo-template-");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repoTemplate, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    // a CI runner has no global identity, and the daemon commits with whatever the repo gives it
    git("config", "user.name", "t");
    git("config", "user.email", "t@t");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  }
  const dir = tempDir("catherd-repo-");
  cpSync(repoTemplate, dir, { recursive: true });
  return dir;
}

/** A repo with a bare `origin` on its `main`: [repo, origin]. */
export function repoWithOrigin(): { repo: string; origin: string } {
  const repo = tempRepo();
  const origin = tempDir("catherd-origin-");
  execFileSync("git", ["clone", "-q", "--bare", repo, origin], { stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["fetch", "-q", "origin"], { cwd: repo, stdio: "ignore" });
  return { repo, origin };
}

/**
 * Commits to `origin`'s main through a scratch clone (a file when `file` is given, else an empty commit), so the
 * repo behind it has to fetch to see it. Returns the commit.
 */
export function commitInClone(origin: string, name: string, file?: { path: string; text: string }): string {
  const clone = tempDir("catherd-clone-");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      cwd: clone,
      stdio: "ignore",
    });
  execFileSync("git", ["clone", "-q", origin, clone], { stdio: "ignore" });
  if (file) {
    mkdirSync(dirname(join(clone, file.path)), { recursive: true });
    writeFileSync(join(clone, file.path), file.text);
    git("add", "-A");
  }
  git("commit", "-q", "--allow-empty", "-m", name);
  git("push", "-q", "origin", "HEAD:main");
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: clone, encoding: "utf8" }).trim();
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

/** The env of a catherd a test spawns: end push and boot sync off, with no Anthropic key. */
export function spawnEnv(env: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...env, CATHERD_NO_END_PUSH: "1", CATHERD_NO_SYNC: "1", ANTHROPIC_API_KEY: "" };
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
