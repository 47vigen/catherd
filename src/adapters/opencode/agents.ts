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
 * How opencode v2 applies these rules (source at 6585bb7, packages/core/src/…):
 * - the last matching rule wins, and no match asks (permission.ts:87-96); an agent file's rules come after
 *   opencode's defaults and the global config's (config/plugin/agent.ts:84-122);
 * - a pattern matches the whole resource: `*` is any text, newlines included, and a trailing " *" also
 *   matches nothing, so "git diff *" admits "git diff" (util/wildcard.ts:3-13);
 * - the shell tool asks once with one resource per command it parses, command substitutions included, and
 *   a redirect only when it wraps that command alone (tool/plugin/shell.ts:126-140, shell/parse.ts:173-205);
 *   one denied resource denies the call (permission.ts:165-167).
 * So catherd-ro allows a few read commands, then denies any resource with an output flag or shell syntax;
 * the same denies hold if opencode ever matched the command unsplit. Known gap: a redirect after a list or
 * pipeline (`ls && git log > f`) reaches no resource, so read-only stays advisory, as `enforcement` says.
 */
const READ_SHELL = ["git status *", "git diff *", "git log *", "git show *", "ls *", "cat *", "pwd *"];
const SHELL_ESCAPES = [
  "*--output*",
  "*--pre*",
  "* -o*",
  "*;*",
  "*&*",
  "*|*",
  "*>*",
  "*<*",
  "*`*",
  "*$(*",
  "*\n*",
];

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
    ...READ_SHELL.map((c) => rule("shell", c, "allow")),
    // edit, write and patch all ask for `edit` (tool/plugin/edit.ts:181, write.ts:79, patch.ts:197)
    rule("edit", "*", "deny"),
    ...SHELL_ESCAPES.map((c) => rule("shell", c, "deny")),
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
