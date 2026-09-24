import { lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, sep } from "node:path";
import { configDir } from "../paths.ts";
import { modelOf } from "../routing/catalog.ts";
import { type Catalog, type Profile, ROLES, type Role, type RungId, rungOf, splitRung } from "../types.ts";
import { activeProfileName, saveProfile } from "./profile.ts";
import { ROLE_PROMPTS } from "./role-prompts.ts";

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export function agentName(role: Role, rung: RungId): string {
  const { model, effort } = splitRung(rung);
  return `catherd-${role}-${slug(model)}-${effort}`;
}

export function claudeAgentsDir(): string {
  return process.env.CATHERD_CLAUDE_AGENTS_DIR ?? join(homedir(), ".claude", "agents");
}

function render(role: Role, rung: RungId): string {
  const { model, effort } = splitRung(rung);
  const p = ROLE_PROMPTS[role];
  return [
    "---",
    `name: ${agentName(role, rung)}`,
    `description: Internal ${role} role of the catherd orchestrator, on ${model} at ${effort} effort. Dispatched only by the catherd skill while a run is in flight. Never for a plain request, even one that names this role.`,
    `model: ${model}`,
    `effort: ${effort}`,
    `disallowedTools: ${p.disallowedTools.join(", ")}`,
    "---",
    "",
    p.body,
    "",
  ].join("\n");
}

const lstatOrNull = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

export function writeClaudeAgents(
  p: Profile,
  c: Catalog,
): { written: string[]; linked: string[]; pruned: string[] } {
  const root = join(configDir(), "agents");
  const dir = join(root, p.name);
  const files = new Map<string, string>();
  for (const role of ROLES) {
    const rc = p.roles[role];
    if (!rc?.enabled) continue;
    for (const [model, efforts] of Object.entries(rc.models)) {
      if (modelOf(c, model)?.backend !== "claude") continue;
      for (const effort of efforts) {
        const rung = rungOf(model, effort);
        files.set(join(dir, `${agentName(role, rung)}.md`), render(role, rung));
      }
    }
  }

  const active = p.name === activeProfileName();
  const target = claudeAgentsDir();
  const ours = `${root}${sep}`;
  const isOurs = (link: string) => {
    const st = lstatOrNull(link);
    return !st || (st.isSymbolicLink() && readlinkSync(link).startsWith(ours));
  };
  if (active) {
    for (const f of files.keys()) {
      const link = join(target, basename(f));
      if (!isOurs(link))
        throw new Error(`catherd: ${link} exists and is not catherd's; move it away and save again`);
    }
  }

  mkdirSync(dir, { recursive: true });
  for (const [f, text] of files) writeFileSync(f, text);
  for (const f of readdirSync(dir)) if (!files.has(join(dir, f))) rmSync(join(dir, f));
  const written = [...files.keys()];
  if (!active) return { written, linked: [], pruned: [] };

  mkdirSync(target, { recursive: true });
  const linked: string[] = [];
  for (const f of written) {
    const link = join(target, basename(f));
    rmSync(link, { force: true });
    symlinkSync(f, link);
    linked.push(link);
  }
  const pruned: string[] = [];
  for (const name of readdirSync(target)) {
    const link = join(target, name);
    if (!lstatOrNull(link)?.isSymbolicLink()) continue;
    const to = readlinkSync(link);
    if (to.startsWith(ours) && !files.has(to)) {
      rmSync(link);
      pruned.push(link);
    }
  }
  return { written, linked, pruned };
}

export function saveProfileAndAgents(
  p: Profile,
  c: Catalog,
): { written: string[]; linked: string[]; pruned: string[] } {
  const r = writeClaudeAgents(p, c);
  saveProfile(p);
  return r;
}

/** Read-only count of catherd's own symlinks in `claudeAgentsDir()`, for the dashboard's
 * "Claude agents" status row — unlike `writeClaudeAgents`, this never touches the filesystem. */
export function countLinkedAgents(): number {
  const target = claudeAgentsDir();
  const ours = `${join(configDir(), "agents")}${sep}`;
  if (!lstatOrNull(target)) return 0;
  return readdirSync(target).filter((name) => {
    const st = lstatOrNull(join(target, name));
    return st?.isSymbolicLink() && readlinkSync(join(target, name)).startsWith(ours);
  }).length;
}
