import { homedir } from "node:os";
import { join } from "node:path";

function root(kind: "config" | "data"): string {
  const home = process.env.CATHERD_HOME;
  if (home) return join(home, kind);
  if (kind === "config") return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "catherd");
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "catherd");
}

export const configDir = (): string => root("config");
export const dataDir = (): string => root("data");

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
export const runsDir = (toplevel: string): string => join(repoDir(toplevel), "runs");
export const logsDir = (): string => join(dataDir(), "logs");
export const discoveryDir = (): string => join(dataDir(), "discovery");
export const locksDir = (): string => join(dataDir(), "locks");
