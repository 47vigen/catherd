import { lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { Access } from "../../domain/record.ts";
import { dataDir } from "../../infra/paths.ts";
import { ensurePrivateDir, writeJsonAtomic } from "../../infra/store.ts";
import { movedHomeEnv, writableRoots } from "../access.ts";

/** Where isolated Cursor runs keep their homes; computing it creates nothing. */
export const isolatedCursorRoot = (): string => join(dataDir(), "cursor-home");

/**
 * Spec 1.3 §4.3–§4.4: an isolated run's HOME. Cursor reads its sandbox policy from one `sandbox.json` per home,
 * so each access (and a workspace-write role without network) gets its own home: lanes of different access
 * run side by side without rewriting each other's policy.
 */
export const isolatedCursorHome = (access: Access, network = true): string =>
  join(isolatedCursorRoot(), access === "workspace-write" && !network ? "workspace-write-offline" : access);

/**
 * The env of an isolated run: the moved HOME (the only thing that stops Cursor's hard-coded `~/.claude`,
 * `~/.codex`, `~/.grok` and `~/.agents` reads, research §2.8), and Cursor's config and data dirs inside it, so a
 * CURSOR_CONFIG_DIR or XDG_CONFIG_HOME of the user's cannot point it back.
 */
export function cursorHomeEnv(access: Access, network = true): Record<string, string> {
  const home = isolatedCursorHome(access, network);
  const dot = join(home, ".cursor");
  return { ...movedHomeEnv(home), CURSOR_CONFIG_DIR: dot, CURSOR_DATA_DIR: dot };
}

/**
 * The `sandbox.json` of an isolated home (research §2.6): read-only is the kernel's `workspace_readonly`;
 * workspace-write adds catherd's writable roots and, unless the role has no network, allows it; `full` runs
 * with the sandbox off (`--force --sandbox disabled`) and needs none.
 */
export function cursorSandboxPolicy(access: Access, network = true): Record<string, unknown> | null {
  if (access === "read-only") return { type: "workspace_readonly" };
  if (access === "full") return null;
  return {
    type: "workspace_readwrite",
    additionalReadwritePaths: writableRoots(),
    ...(network ? { networkPolicy: { default: "allow" } } : {}),
  };
}

/**
 * Makes the isolated home for `access` and writes its `sandbox.json`. Every home links one shared `chats`
 * dir: Cursor looks a resumed chat up there, and an id it cannot find silently starts an empty chat
 * (research §2.5), so a thread resumed under another access must find it.
 */
export function prepareCursorHome(access: Access, network = true): string {
  const home = isolatedCursorHome(access, network);
  const dot = join(home, ".cursor");
  ensurePrivateDir(dot);
  const chats = join(isolatedCursorRoot(), "chats");
  mkdirSync(chats, { recursive: true, mode: 0o700 });
  if (!lstatSync(join(dot, "chats"), { throwIfNoEntry: false })) symlinkSync(chats, join(dot, "chats"));
  const policy = cursorSandboxPolicy(access, network);
  if (policy) writeJsonAtomic(join(dot, "sandbox.json"), policy);
  return home;
}
