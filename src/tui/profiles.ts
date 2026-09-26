import type { Catalog, Profile } from "../types.ts";
import { saveProfileAndAgents, setActiveProfile } from "./profile-shim.ts";

export { deleteProfile } from "./profile-shim.ts";

export function nameError(name: string, taken: string[]): string | null {
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) return "Use lowercase letters, digits and dashes, up to 32.";
  if (taken.includes(name)) return `"${name}" already exists.`;
  return null;
}

export function saveAndActivate(p: Profile, c: Catalog): void {
  saveProfileAndAgents(p, c);
  setActiveProfile(p.name);
}
