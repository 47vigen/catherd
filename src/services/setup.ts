import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { configDir } from "../infra/paths.ts";
import { type Refreshed, refreshDiscovery } from "./catalog-service.ts";
import {
  activate,
  configFile,
  profilesDir,
  projectsFile,
  resetProfile,
  type Synced,
} from "./profile-service.ts";

/** A JSON file written by catherd 0.x: readable JSON with no `schema` field. */
function isLegacy(file: string): boolean {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as { schema?: unknown } | null;
    return typeof v === "object" && v !== null && v.schema === undefined;
  } catch {
    return false;
  }
}

/**
 * Spec D2, a clean break: 1.0 never reads a 0.x config.json, projects.json or profile, so `init` moves
 * them to `<config>/0.x-backup-<stamp>/`. Returns the files moved.
 */
export function moveLegacy(now: Date = new Date()): string[] {
  const candidates = [
    configFile(),
    projectsFile(),
    ...(existsSync(profilesDir())
      ? readdirSync(profilesDir())
          .filter((f) => f.endsWith(".json"))
          .map((f) => join(profilesDir(), f))
      : []),
  ].filter((f) => existsSync(f) && isLegacy(f));
  if (candidates.length === 0) return [];
  const backup = join(configDir(), `0.x-backup-${now.toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(join(backup, "profiles"), { recursive: true });
  return candidates.map((f) => {
    const to = join(backup, f.startsWith(profilesDir()) ? join("profiles", basename(f)) : basename(f));
    renameSync(f, to);
    return to;
  });
}

export interface InitResult {
  moved: string[];
  profile: string;
  /** false when a 1.0 profile of that name was kept as it was */
  created: boolean;
  synced: Synced;
  refreshed: Refreshed[];
}

/**
 * Spec §8 `catherd init`, the setup half: moves 0.x files aside, writes the default profile (spec §7.2)
 * unless a 1.0 one exists and `overwrite` is not set, makes it active and links its agents, and lists
 * every backend's models.
 */
export async function initSetup(
  o: { profile?: string; overwrite?: boolean; now?: Date } = {},
): Promise<InitResult> {
  const moved = moveLegacy(o.now);
  const profile = o.profile ?? "default";
  const created = !existsSync(join(profilesDir(), `${profile}.json`)) || o.overwrite === true;
  if (created) resetProfile(profile);
  const synced = activate(profile);
  const refreshed = await refreshDiscovery();
  return { moved, profile, created, synced, refreshed };
}
