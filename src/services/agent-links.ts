import type { OrchestrationHost } from "../domain/host.ts";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { basename, join, sep } from "node:path";
import { type AgentFile, agentFiles } from "../domain/agents.ts";
import { CatherdError } from "../domain/errors.ts";
import { claudeAgentsDir } from "../infra/paths.ts";
import { ensurePrivateDir, writeTextAtomic } from "../infra/store.ts";
import { VERSION } from "../infra/version.ts";
import { activeName, agentsRoot, getProfile, profileExists, readProjects } from "./profile-store.ts";

// Spec §7.3: the agent files and their links in Claude Code's agents dir. Only profile-service.ts writes
// them, under its profiles lock.

const lstatOrNull = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};
const ours = (): string => `${agentsRoot()}${sep}`;
/** A link catherd made: a symlink into `<config>/agents/`. Nothing else in the agents dir is ever touched. */
const isOurLink = (path: string): boolean => {
  const st = lstatOrNull(path);
  return st !== null && st.isSymbolicLink() && readlinkSync(path).startsWith(ours());
};

/** Spec §7.3: the active profile and every repo-bound one are linked at once. */
export function linkedProfiles(): string[] {
  const names = new Set([activeName(), ...Object.values(readProjects().bindings)]);
  return [...names].filter(profileExists).sort();
}

export interface Planned {
  files: Map<string, AgentFile[]>;
  links: Map<string, string>;
}

export function plan(host: OrchestrationHost, extra: string[] = [], selected?: string[]): Planned {
  const files = new Map<string, AgentFile[]>();
  for (const name of new Set(selected ?? [...linkedProfiles(), ...extra.filter(profileExists)]))
    files.set(name, agentFiles(getProfile(name, host), VERSION));
  const links = new Map<string, string>();
  for (const name of linkedProfiles())
    for (const f of files.get(name) ?? [])
      links.set(join(claudeAgentsDir(), `${f.name}.md`), join(agentsRoot(), name, `${f.name}.md`));
  return { files, links };
}

/** Refuses before anything is written when a planned link would replace a file catherd does not own. */
function assertNoConflict(p: Planned): void {
  for (const link of p.links.keys())
    if (lstatOrNull(link) && !isOurLink(link))
      throw new CatherdError("E_CONFIG_INVALID", `${link} exists and is not catherd's`, {
        fix: `move ${link} away, then run the command again`,
      });
}

export interface Synced {
  linked: string[];
  pruned: string[];
  /** agents whose link is new or whose file changed: Claude Code reads them only at a session's start */
  newSessionNeededFor: string[];
}

/**
 * Writes the planned agent files and links, prunes catherd's stale ones, and says what changed. The
 * ownership check runs before the first write, so no caller can replace a file catherd does not own.
 */
export function apply(p: Planned, removed: string[] = []): Synced {
  assertNoConflict(p);
  const changed = new Set<string>();
  for (const [name, files] of p.files) {
    const dir = join(agentsRoot(), name);
    ensurePrivateDir(dir);
    const keep = new Set(files.map((f) => `${f.name}.md`));
    for (const f of files) {
      const path = join(dir, `${f.name}.md`);
      if (!existsSync(path) || readFileSync(path, "utf8") !== f.text) {
        writeTextAtomic(path, f.text);
        changed.add(path);
      }
    }
    for (const f of readdirSync(dir)) if (!keep.has(f)) rmSync(join(dir, f), { force: true });
  }
  for (const name of removed) rmSync(join(agentsRoot(), name), { recursive: true, force: true });

  const target = claudeAgentsDir();
  const newSession: string[] = [];
  if (p.links.size > 0) mkdirSync(target, { recursive: true });
  for (const [link, file] of p.links) {
    const fresh = !isOurLink(link) || readlinkSync(link) !== file;
    if (fresh) {
      rmSync(link, { force: true });
      symlinkSync(file, link);
    }
    if (fresh || changed.has(file)) newSession.push(basename(link, ".md"));
  }
  const pruned: string[] = [];
  if (existsSync(target))
    for (const entry of readdirSync(target)) {
      const link = join(target, entry);
      if (isOurLink(link) && !p.links.has(link)) {
        rmSync(link, { force: true });
        pruned.push(entry);
      }
    }
  return {
    linked: [...p.links.keys()].map((l) => basename(l, ".md")).sort(),
    pruned: pruned.sort(),
    // a removed agent is still loaded in the running Claude Code session until a new one starts
    newSessionNeededFor: [...newSession, ...pruned.map((e) => basename(e, ".md"))].sort(),
  };
}

/** What `doctor` compares: each link that should exist, and whether it and its file are current. */
export function agentLinkState(
  host: OrchestrationHost,
  selected?: string[],
): { missing: string[]; stale: string[]; ok: string[] } {
  const p = plan(host, [], selected);
  if (selected) for (const name of p.files.keys()) if (!selected.includes(name)) p.files.delete(name);
  const out = { missing: [] as string[], stale: [] as string[], ok: [] as string[] };
  for (const [name, files] of p.files)
    for (const f of files) {
      const link = join(claudeAgentsDir(), `${f.name}.md`);
      if (!p.links.has(link)) continue;
      const file = join(agentsRoot(), name, `${f.name}.md`);
      if (!isOurLink(link)) out.missing.push(f.name);
      else if (readlinkSync(link) !== file || !existsSync(file) || readFileSync(file, "utf8") !== f.text)
        out.stale.push(f.name);
      else out.ok.push(f.name);
    }
  return out;
}
