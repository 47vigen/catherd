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
 * `home`: another root than the isolated runs' (doctor's sandbox check runs in a scratch one).
 */
export function grokHomeEnv(home = isolatedGrokRoot()): Record<string, string> {
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

/** The `read_write` roots of each profile in catherd's block as it stands, by profile name. */
function blockRoots(block: string): Record<string, string[]> {
  try {
    const p =
      (Bun.TOML.parse(block) as { profiles?: Record<string, { read_write?: unknown }> }).profiles ?? {};
    return Object.fromEntries(
      Object.entries(p).map(([k, v]) => [
        k,
        Array.isArray(v.read_write) ? v.read_write.filter((r): r is string => typeof r === "string") : [],
      ]),
    );
  } catch {
    return {};
  }
}

/**
 * `profiles` with each one's `read_write` merged into the block's current roots: those that still exist, in
 * their order, then the new ones. Two catherd homes on one machine (another CATHERD_HOME, other lock dirs) then
 * converge on one block instead of rewriting each other's.
 */
function mergedProfiles(
  profiles: Record<string, Record<string, unknown>>,
  was: Record<string, string[]>,
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(profiles).map(([name, p]) => {
      const mine = Array.isArray(p.read_write) ? (p.read_write as string[]) : [];
      const kept = (was[name] ?? []).filter((r) => existsSync(r));
      const roots = [...new Set([...kept, ...mine])];
      return [name, { ...p, read_write: roots }];
    }),
  );
}

/**
 * `text` (a sandbox.toml) with catherd's marked block set to `profiles`: rewritten where it stands, or appended
 * when there is none. A rewrite in place keeps every line outside the block, and what each line belongs to: a
 * bare key the user put after the block stays in the table it was in. The block's existing roots that still
 * exist stay (mergedProfiles). `why` when catherd must not write: the file is not TOML, defines a `catherd-*`
 * profile of its own, or has lost the block's end marker.
 */
export function withCatherdProfiles(
  text: string,
  profiles = catherdProfiles(),
): { text: string } | { why: string } {
  const start = text.indexOf(BEGIN);
  const end = start === -1 ? -1 : text.indexOf(END, start);
  if (start !== -1 && end === -1)
    return { why: `catherd's block has lost its end marker (${END}): delete the block` };
  const after = start === -1 ? "" : text.slice(end + END.length).replace(/^\r?\n/, "");
  // the file without the block, for the checks: the block goes with the blank line catherd put before it
  const rest = start === -1 ? text : text.slice(0, start).replace(/\n\n$/, "\n") + after;
  const bad = tomlError(rest);
  if (bad) return { why: `it is not valid TOML (${bad})` };
  const own = Object.keys((Bun.TOML.parse(rest) as { profiles?: object }).profiles ?? {}).find((k) =>
    k.startsWith("catherd-"),
  );
  if (own) return { why: `it has a [profiles.${own}] of its own: rename it, catherd's tables are catherd-*` };
  const was = start === -1 ? {} : blockRoots(text.slice(start, end));
  const block = `${HEADER}\n${Bun.TOML.stringify({ profiles: mergedProfiles(profiles, was) })}${END}\n`;
  const head = rest.trimEnd();
  const out =
    start === -1 ? `${head ? `${head}\n\n` : ""}${block}` : `${text.slice(0, start)}${block}${after}`;
  const broken = tomlError(out);
  return broken ? { why: `it is not valid TOML with catherd's tables added (${broken})` } : { text: out };
}

/**
 * Spec 1.3 §5.3, §9 Q3: puts catherd's `[profiles.catherd-*]` tables into `home`'s sandbox.toml (grok reads
 * custom profiles only there or in the repo's `.grok/`), keeping the file's mode; the rest of the file is the
 * user's. Throws E_CONFIG_INVALID, touching nothing, when catherd must not write it.
 */
export function writeGrokProfiles(home: string): void {
  const path = join(home, "sandbox.toml");
  const refuse = (file: string, why: string) =>
    new CatherdError("E_CONFIG_INVALID", `catherd will not edit ${file}: ${why}`, {
      fix: `fix ${file}, or isolate grok (catherd profile set harness.grok.isolated true)`,
    });
  // a link (a dotfiles repo) stays a link: the atomic rename goes to the file it points at
  let file = path;
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
    try {
      file = realpathSync(path);
    } catch (e) {
      throw refuse(path, `it is a link catherd cannot follow (${(e as NodeJS.ErrnoException).code ?? e})`);
    }
  let was = "";
  try {
    was = existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch (e) {
    throw refuse(file, `catherd cannot read it (${(e as NodeJS.ErrnoException).code ?? e})`);
  }
  const next = withCatherdProfiles(was);
  if ("why" in next) throw refuse(file, next.why);
  if (next.text === was) return;
  try {
    writeTextAtomic(file, next.text, { mode: existsSync(file) ? statSync(file).mode & 0o777 : 0o600 });
  } catch (e) {
    // a read-only store (a Nix home, say) or a folder catherd may not write
    throw refuse(file, `catherd cannot write it (${(e as NodeJS.ErrnoException).code ?? e})`);
  }
}
