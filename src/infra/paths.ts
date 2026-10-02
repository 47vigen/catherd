import { homedir } from "node:os";
import { join } from "node:path";

function root(kind: "config" | "data"): string {
  // set for an isolated worker whose XDG_CONFIG_HOME or HOME points elsewhere, so its `catherd lock` reads
  // this config and takes this lock dir
  if (kind === "config" && process.env.CATHERD_CONFIG_DIR) return process.env.CATHERD_CONFIG_DIR;
  if (kind === "data" && process.env.CATHERD_DATA_DIR) return process.env.CATHERD_DATA_DIR;
  const home = process.env.CATHERD_HOME;
  if (home) return join(home, kind);
  if (kind === "config") return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "catherd");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "catherd");
}

export const configDir = (): string => root("config");
export const dataDir = (): string => root("data");

/** Claude Code's own folder, as Claude Code finds it (`CLAUDE_CONFIG_DIR`, else `~/.claude`). */
export const claudeHome = (): string => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

/** Where Claude Code reads user agents; catherd links its agent files here (spec §7.3). */
export const claudeAgentsDir = (): string =>
  process.env.CATHERD_CLAUDE_AGENTS_DIR || join(claudeHome(), "agents");

/** A readable slug of the repo's git toplevel plus 8 hex chars of its hash: `/a-b/c` ≠ `/a/b-c`. */
export function repoKey(toplevel: string): string {
  const slug =
    toplevel
      .replace(/^\/+/, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .slice(0, 60) || "root";
  const hash = new Bun.CryptoHasher("sha256").update(toplevel).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

export const repoDir = (toplevel: string): string => join(dataDir(), "repos", repoKey(toplevel));

/**
 * One repository however it is cloned or checked out (spec 1.5 "Knowledge keyed by git origin"):
 * `git@github.com:a/b.git`, `https://user@github.com/a/b` and `ssh://git@github.com/a/b.git/` are all
 * `github.com/a/b`. The host is lower-cased; the path keeps its case.
 */
export function normalizeOrigin(url: string): string {
  let s = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(s);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `${scp[1]}/${scp[2]}`;
  else s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^[^@/]+@/, "");
  const [host = "", ...path] = s.split("/");
  return [host.toLowerCase().replace(/:\d+$/, ""), ...path].join("/");
}

/** Where what runs of one repository learned lives, keyed by its origin, whatever worktree it runs in. */
export const originDir = (url: string): string =>
  join(dataDir(), "repos", `origin-${repoKey(normalizeOrigin(url))}`);
export const runsDir = (toplevel: string): string => join(repoDir(toplevel), "runs");
export const logsDir = (): string => join(dataDir(), "logs");
export const discoveryDir = (): string => join(dataDir(), "discovery");
export const locksDir = (): string => join(dataDir(), "locks");
/** Spec 1.2 §3.3: each source's last good answer, the sync state and lock, and what the sync derived. */
export const sourcesDir = (): string => join(dataDir(), "sources");
