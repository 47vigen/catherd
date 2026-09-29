import { join } from "node:path";
import type { Access } from "../../domain/record.ts";
import { dataDir } from "../../infra/paths.ts";
import { ensurePrivateDir, writeJsonAtomic } from "../../infra/store.ts";
import { movedHomeEnv, writableRoots } from "../access.ts";

/** Where isolated agy runs keep their homes; computing it creates nothing. */
export const isolatedAgyRoot = (): string => join(dataDir(), "agy-home");

/**
 * Spec 1.3 §6.4: an isolated run's HOME. agy reads its permission rules from the one `settings.json` of its home,
 * so each access (and a workspace-write role without network) gets its own home, and lanes of different access run
 * side by side. A conversation lives in the home it started in; `resume.sameAccessOnly` keeps it there.
 */
export const isolatedAgyHome = (access: Access, network = true): string =>
  join(isolatedAgyRoot(), access === "workspace-write" && !network ? "workspace-write-offline" : access);

/**
 * The env of an isolated run: the moved HOME, which relocates every agy file, the settings among them (research
 * §4.7 [run]), with catherd's own dirs and the toolchain caches kept.
 */
export const agyHomeEnv = (access: Access, network = true): Record<string, string> =>
  movedHomeEnv(isolatedAgyHome(access, network));

/**
 * The `settings.json` of an isolated home (spec 1.3 §6.3, §6.4; research §4.7, §4.8): the Gemini API as the
 * provider, so GEMINI_API_KEY signs it in; read-only denies every write and command; workspace-write allows
 * catherd's writable roots (mounted read-write in the sandbox) and, unless the role has no network, every URL;
 * `full` runs with every tool approved and needs no rule.
 */
export function agySettings(access: Access, network = true): Record<string, unknown> {
  const provider = { modelProvider: "gemini" };
  if (access === "read-only") return { ...provider, permissions: { deny: ["write_file(*)", "command(*)"] } };
  if (access === "full") return provider;
  const allow = [...writableRoots().map((r) => `write_file(${r})`), ...(network ? ["read_url(*)"] : [])];
  return { ...provider, permissions: { allow } };
}

/** Makes the isolated home for `access` and writes its settings; catherd never writes the user's own. */
export function prepareAgyHome(access: Access, network = true): string {
  const home = isolatedAgyHome(access, network);
  const dir = join(home, ".gemini", "antigravity-cli");
  ensurePrivateDir(dir);
  writeJsonAtomic(join(dir, "settings.json"), agySettings(access, network));
  return home;
}
