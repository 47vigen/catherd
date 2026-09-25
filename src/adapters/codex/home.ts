import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir } from "../../infra/paths.ts";

export const userCodexHome = (): string => process.env.CODEX_HOME || join(homedir(), ".codex");

/** Isolated runs only: `--ignore-user-config` alone still loads the global AGENTS.md, so the home goes too. */
export function isolatedCodexHome(): string {
  const home = join(dataDir(), "codex-home");
  mkdirSync(home, { recursive: true });
  const auth = join(userCodexHome(), "auth.json");
  const link = join(home, "auth.json");
  if (!existsSync(link) && existsSync(auth)) symlinkSync(auth, link);
  return home;
}

export function generatedImages(home: string, thread: string | null, sinceMs: number): string[] {
  if (!thread) return [];
  const dir = join(home, "generated_images", thread);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(png|webp|jpe?g)$/i.test(f))
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).mtimeMs >= sinceMs - 1000)
    .sort();
}
