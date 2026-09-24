import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readJsonFile } from "../files.ts";
import { configDir } from "../paths.ts";
import { saveProfileAndAgents } from "../profile/agents.ts";
import { activeProfileName, setActiveProfile } from "../profile/profile.ts";
import type { Catalog, Profile } from "../types.ts";

// `saveTreatLike` lives in `src/routing/catalog.ts` (OVERRIDES cross-plan fix 5); this module
// adds the writers INTERFACES has none for: profile delete, name validation, and save-and-activate.
const ProjectsSchema = z.record(z.string(), z.string());

export function deleteProfile(name: string): void {
  if (name === activeProfileName()) {
    throw new Error(
      `"${name}" is the active profile; save another profile first, which makes that one active`,
    );
  }
  const projectsFile = join(configDir(), "projects.json");
  const bound = Object.entries(existsSync(projectsFile) ? readJsonFile(ProjectsSchema, projectsFile) : {})
    .filter(([, profile]) => profile === name)
    .map(([repo]) => repo);
  if (bound.length > 0) throw new Error(`"${name}" is bound to ${bound.join(", ")}`);
  rmSync(join(configDir(), "profiles", `${name}.json`), { force: true });
  rmSync(join(configDir(), "agents", name), { recursive: true, force: true });
}

export function nameError(name: string, taken: string[]): string | null {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) return "Use lowercase letters, digits and dashes, up to 32.";
  if (taken.includes(name)) return `"${name}" already exists.`;
  return null;
}

export function saveAndActivate(p: Profile, c: Catalog): void {
  saveProfileAndAgents(p, c);
  setActiveProfile(p.name);
}
