import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir } from "../../infra/paths.ts";

export const userCodexHome = (): string => process.env.CODEX_HOME || join(homedir(), ".codex");

/** Where isolated runs keep their Codex home; computing it creates nothing. */
export const isolatedCodexHomePath = (): string => join(dataDir(), "codex-home");

/** Isolated runs only: `--ignore-user-config` alone still loads the global AGENTS.md, so the home goes too. */
export function isolatedCodexHome(): string {
  const home = isolatedCodexHomePath();
  mkdirSync(home, { recursive: true });
  const auth = join(userCodexHome(), "auth.json");
  const link = join(home, "auth.json");
  if (!existsSync(auth)) return home;
  // lstat, not existsSync: a broken link "does not exist" yet still blocks symlinkSync with EEXIST.
  const current = lstatSync(link, { throwIfNoEntry: false });
  if (current?.isSymbolicLink() && readlinkSync(link) !== auth) unlinkSync(link);
  else if (current) return home;
  symlinkSync(auth, link);
  return home;
}

function mtimeMs(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null; // vanished between readdir and stat
  }
}

export function generatedImages(home: string, thread: string | null, sinceMs: number): string[] {
  if (!thread) return [];
  const dir = join(home, "generated_images", thread);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(png|webp|jpe?g)$/i.test(f))
    .map((f) => join(dir, f))
    .filter((f) => {
      const m = mtimeMs(f);
      return m !== null && m >= sinceMs - 1000;
    })
    .sort();
}
