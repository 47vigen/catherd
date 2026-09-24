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

export function repoSlug(repoRoot: string): string {
  return repoRoot.replace(/^\/+/, "").replaceAll("/", "-");
}

export function runsRoot(repoRoot: string): string {
  return join(dataDir(), repoSlug(repoRoot));
}
