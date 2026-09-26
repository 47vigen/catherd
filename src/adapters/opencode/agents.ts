import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Access } from "../../domain/record.ts";
import { dataDir } from "../../infra/paths.ts";

/** Spec §6.3: one catherd agent per access mode. */
export const OPENCODE_AGENT: Record<Access, "catherd-ro" | "catherd-worker" | "catherd-full"> = {
  "read-only": "catherd-ro",
  "workspace-write": "catherd-worker",
  full: "catherd-full",
};

const rule = (action: string, resource: string, effect: "allow" | "deny") =>
  `  - { action: ${JSON.stringify(action)}, resource: ${JSON.stringify(resource)}, effect: ${effect} }`;

/**
 * Why catherd-ro has no shell (opencode v2 at 6585bb7, packages/core/src/…): the last matching rule wins
 * (permission.ts:87-96) over a whole-resource wildcard (util/wildcard.ts:3-13), and the shell tool asks with
 * one resource per parsed command (tool/plugin/shell.ts:126-140, shell/parse.ts:173-205). A redirect after a
 * list or pipeline reaches no resource (`ls && cat a > b` asks for "ls" and "cat a"), so no allowlist of
 * read commands is read-only. The role reads with read, glob and grep; its brief names the files.
 */
/**
 * opencode v2 agent files (research 2026-09-25-opencode.md §4.5). Later rules win; every run passes
 * `--auto`, so an "ask" left by opencode's defaults never aborts the run, and an explicit deny still holds.
 * No body: the agent keeps opencode's own system prompt.
 */
export const OPENCODE_AGENT_FILES: Record<string, string> = {
  "catherd-ro": [
    "---",
    "description: catherd read-only roles (architect, reviewer, researcher). Written by catherd.",
    "mode: primary",
    "permissions:",
    rule("*", "*", "deny"),
    ...["read", "glob", "grep", "webfetch", "websearch"].map((a) => rule(a, "*", "allow")),
    // edit, write and patch all ask for `edit` (tool/plugin/edit.ts:181, write.ts:79, patch.ts:197)
    rule("edit", "*", "deny"),
    rule("shell", "*", "deny"),
    "---",
    "",
  ].join("\n"),
  "catherd-worker": [
    "---",
    "description: catherd workspace-write roles (worker, writer, artist). Written by catherd.",
    "mode: primary",
    "permissions:",
    rule("*", "*", "allow"),
    ...["git commit*", "git push*", "git reset --hard*"].map((c) => rule("shell", c, "deny")),
    rule("question", "*", "deny"),
    "---",
    "",
  ].join("\n"),
  "catherd-full": [
    "---",
    "description: catherd full-access roles (verifier, ui-reviewer). Written by catherd.",
    "mode: primary",
    "permissions:",
    rule("*", "*", "allow"),
    rule("question", "*", "deny"),
    "---",
    "",
  ].join("\n"),
};

/** The XDG config root opencode reads: the user's, or catherd's own for isolated runs. */
export const userConfigRoot = (): string => process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
export const isolatedConfigRoot = (): string => join(dataDir(), "opencode-home", "config");

export const agentsDir = (root: string): string => join(root, "opencode", "agents");

/** Writes any catherd agent file that is missing or differs; true when one changed. Never touches other agents. */
export function installAgents(root: string): boolean {
  const dir = agentsDir(root);
  mkdirSync(dir, { recursive: true });
  let changed = false;
  for (const [name, text] of Object.entries(OPENCODE_AGENT_FILES)) {
    const file = join(dir, `${name}.md`);
    if (existsSync(file) && readFileSync(file, "utf8") === text) continue;
    writeFileSync(file, text);
    changed = true;
  }
  return changed;
}

/** For `doctor`: the catherd agents that are missing or out of date under `root`. */
export function staleAgents(root: string): string[] {
  return Object.entries(OPENCODE_AGENT_FILES)
    .filter(([name, text]) => {
      const file = join(agentsDir(root), `${name}.md`);
      return !existsSync(file) || readFileSync(file, "utf8") !== text;
    })
    .map(([name]) => name);
}
