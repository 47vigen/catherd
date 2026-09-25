import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Points CATHERD_HOME at a fresh temp dir for the duration of one test. */
export function withHome(): string {
  const home = mkdtempSync(join(tmpdir(), "catherd-home-"));
  process.env.CATHERD_HOME = home;
  process.env.XDG_CONFIG_HOME = join(home, "xdg-config");
  return home;
}

/** A fresh git repo with one commit, for runner and snapshot tests. */
export function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "catherd-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

/** PATH with the fake codex/opencode executables first. */
export function fakeBinPath(): string {
  return `${join(import.meta.dir, "fixtures", "bin")}:${process.env.PATH}`;
}

/** Call at module scope as `afterEach(snapshotEnv())`: restores process.env key by key after each test. */
export function snapshotEnv(): () => void {
  const saved = { ...process.env };
  return () => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  };
}
