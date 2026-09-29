import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CatherdError } from "../../domain/errors.ts";
import type { Access } from "../../domain/record.ts";
import { dataDir } from "../../infra/paths.ts";
import { writeTextAtomic } from "../../infra/store.ts";
import { movedHomeEnv, writableRoots } from "../access.ts";

/** The user's GROK_HOME: grok's config, login, sessions and sandbox profiles. */
export const userGrokHome = (): string => process.env.GROK_HOME || join(homedir(), ".grok");

/** Where isolated grok runs keep their HOME; computing it creates nothing. */
export const isolatedGrokRoot = (): string => join(dataDir(), "grok-home");

/** The Claude Code and Cursor compatibility toggles of grok's config reference (research §3.8). */
const COMPAT = ["CLAUDE", "CURSOR"].flatMap((tool) =>
  ["AGENTS", "RULES", "SKILLS", "MCPS", "HOOKS"].map((what) => `GROK_${tool}_${what}_ENABLED`),
);

/**
 * Spec 1.3 §5.4: an isolated run's env. GROK_HOME and the toggles alone still load the user's Claude Code
 * plugins, agents and permission rules (research §3.8 [run]), so HOME moves too, and GROK_HOME lives in it.
 */
export function grokHomeEnv(): Record<string, string> {
  const home = isolatedGrokRoot();
  return {
    ...movedHomeEnv(home),
    GROK_HOME: join(home, ".grok"),
    GROK_MEMORY: "0",
    ...Object.fromEntries(COMPAT.map((k) => [k, "0"])),
  };
}

/** What stops grok's kernel read-only profile here (research §3.6); tests point it elsewhere. */
export const grokHost = { platform: process.platform as string, dockerSocket: "/var/run/docker.sock" };

/** The tools a read-only role keeps where grok's read-only profile refuses to start (spec 1.3 §5.3). */
export const READ_TOOLS = "read_file,grep,list_dir,web_search,web_fetch";

/**
 * Spec 1.3 §5.3: grok refuses `read-only` (and every profile extending it) on a Mac whose docker socket is a
 * symlink (Docker Desktop, OrbStack, Colima; research §3.6 [run]), so a read-only role there runs in the
 * `workspace` profile with only the read tools: advisory, where the kernel profile is enforced.
 */
export function readOnlyRefused(): boolean {
  return (
    grokHost.platform === "darwin" &&
    lstatSync(grokHost.dockerSocket, { throwIfNoEntry: false })?.isSymbolicLink() === true
  );
}

/** Spec 1.3 §5.3: the sandbox profile (and, where read-only cannot apply, the tool filter) of each access. */
export function grokAccess(access: Access, network = true): string[] {
  if (access === "full") return ["--sandbox", "off"];
  if (access === "workspace-write") return ["--sandbox", network ? "catherd-ws" : "catherd-ws-offline"];
  return readOnlyRefused() ? ["--sandbox", "workspace", "--tools", READ_TOOLS] : ["--sandbox", "read-only"];
}

/**
 * catherd's sandbox profiles: `workspace` plus catherd's writable roots (literal directories; research §3.6),
 * and the same without child network (Linux only; macOS has no child-network control).
 */
export function catherdProfiles(): Record<string, Record<string, unknown>> {
  const read_write = writableRoots();
  return {
    "catherd-ws": { extends: "workspace", read_write },
    "catherd-ws-offline": { extends: "workspace", read_write, restrict_network: true },
  };
}

const BEGIN = "# >>> catherd";
const END = "# <<< catherd";
const HEADER = `${BEGIN}'s sandbox profiles for its grok workers: catherd rewrites this block, so edit outside it`;

const tomlError = (text: string): string | null => {
  try {
    Bun.TOML.parse(text);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

/**
 * `text` (a sandbox.toml) with catherd's marked block set to `profiles`: the old block cut out, the new one
 * appended. Outside the block only trailing blank lines change. `why` when catherd must not write: the file
 * is not TOML, defines a `catherd-*` profile of its own, or has lost the block's end marker.
 */
export function withCatherdProfiles(
  text: string,
  profiles = catherdProfiles(),
): { text: string } | { why: string } {
  const start = text.indexOf(BEGIN);
  const end = start === -1 ? -1 : text.indexOf(END, start);
  if (start !== -1 && end === -1)
    return { why: `catherd's block has lost its end marker (${END}): delete the block` };
  // the block goes with the blank line catherd put before it
  const rest =
    start === -1
      ? text
      : text.slice(0, start).replace(/\n\n$/, "\n") + text.slice(end + END.length).replace(/^\r?\n/, "");
  const bad = tomlError(rest);
  if (bad) return { why: `it is not valid TOML (${bad})` };
  const own = Object.keys((Bun.TOML.parse(rest) as { profiles?: object }).profiles ?? {}).find((k) =>
    k.startsWith("catherd-"),
  );
  if (own) return { why: `it has a [profiles.${own}] of its own: rename it, catherd's tables are catherd-*` };
  const head = rest.trimEnd();
  const out = `${head ? `${head}\n\n` : ""}${HEADER}\n${Bun.TOML.stringify({ profiles })}${END}\n`;
  const after = tomlError(out);
  return after ? { why: `it is not valid TOML with catherd's tables added (${after})` } : { text: out };
}

/**
 * Spec 1.3 §5.3, §9 Q3: puts catherd's `[profiles.catherd-*]` tables into `home`'s sandbox.toml (grok reads
 * custom profiles only there or in the repo's `.grok/`), keeping the file's mode; the rest of the file is the
 * user's. Throws E_CONFIG_INVALID, touching nothing, when catherd must not write it.
 */
export function writeGrokProfiles(home: string): void {
  const path = join(home, "sandbox.toml");
  // a link (a dotfiles repo) stays a link: the atomic rename goes to the file it points at
  const file = lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ? realpathSync(path) : path;
  const was = existsSync(file) ? readFileSync(file, "utf8") : "";
  const next = withCatherdProfiles(was);
  if ("why" in next)
    throw new CatherdError("E_CONFIG_INVALID", `catherd will not edit ${file}: ${next.why}`, {
      fix: `fix ${file}, or isolate grok (catherd profile set harness.grok.isolated true)`,
    });
  if (next.text === was) return;
  writeTextAtomic(file, next.text, { mode: existsSync(file) ? statSync(file).mode & 0o777 : 0o600 });
}
