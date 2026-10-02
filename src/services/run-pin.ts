import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { errorMessage } from "../domain/errors.ts";
import { ACCESS } from "../domain/record.ts";
import { ROLES } from "../domain/roles.ts";
import { readVersioned, writeJsonAtomic } from "../infra/store.ts";
import type { Deps, ProfileView } from "./ports.ts";
import { findRun, type Run } from "./run-store.ts";
import { refreshState } from "./state.ts";

// Spec 1.5 "Pinned per run": run_start records the profile the run started on, each role's access and each
// backend's isolation. A later change (another active profile, a toggled isolation, a version that changed a
// default) is logged in state.md and status, and dispatch keeps the pinned values until the owner re-pins.

const PinSchema = z.looseObject({
  schema: z.literal(1),
  at: z.string(),
  profile: z.string(),
  access: z.partialRecord(z.enum(ROLES), z.enum(ACCESS)),
  isolated: z.record(z.string(), z.boolean()),
});
export type Pin = z.infer<typeof PinSchema>;

export const pinFile = (run: Run): string => join(run.dir, "pin.json");

/** The run's pin, or null: a run from before 1.5, or a pin that cannot be read (the profile then rules). */
export function readPin(run: Run): Pin | null {
  if (!existsSync(pinFile(run))) return null;
  try {
    return readVersioned(pinFile(run), PinSchema, 1);
  } catch {
    return null;
  }
}

const pinOf = (view: ProfileView, at: string): Pin => ({
  schema: 1,
  at,
  profile: view.name,
  access: Object.fromEntries(
    Object.entries(view.roles).flatMap(([role, rc]) => (rc ? [[role, rc.access]] : [])),
  ),
  isolated: Object.fromEntries(Object.entries(view.isolated).map(([k, v]) => [k, v === true])),
});

/** Records what the run runs on now: the profile its repo runs on, each role's access, each backend's isolation. */
export function writePin(deps: Deps, run: Run): Pin {
  const pin = pinOf(deps.profiles.forRepo(run.meta.repo), new Date(deps.now()).toISOString());
  writeJsonAtomic(pinFile(run), pin);
  return pin;
}

/** The pinned profile's view, or null with why when it can no longer be read (deleted, invalid). */
function pinnedView(deps: Deps, run: Run, pin: Pin): { view: ProfileView | null; why: string | null } {
  const current = deps.profiles.forRepo(run.meta.repo);
  if (current.name === pin.profile) return { view: current, why: null };
  try {
    return { view: deps.profiles.get(pin.profile, run.meta.repo).profile, why: null };
  } catch (e) {
    return { view: null, why: errorMessage(e) };
  }
}

/**
 * The profile a run's dispatch, routing and failover read: its pinned profile, with its pinned access and
 * isolation laid over it. A run with no pin, or whose pinned profile is gone, reads its repo's profile.
 */
export function runProfile(deps: Deps, run: Run): ProfileView {
  const pin = readPin(run);
  if (!pin) return deps.profiles.forRepo(run.meta.repo);
  const view = pinnedView(deps, run, pin).view ?? deps.profiles.forRepo(run.meta.repo);
  const roles: ProfileView["roles"] = {};
  for (const [role, rc] of Object.entries(view.roles) as [
    keyof ProfileView["roles"],
    NonNullable<ProfileView["roles"][keyof ProfileView["roles"]]>,
  ][])
    roles[role] = { ...rc, access: pin.access[role] ?? rc.access };
  // a backend the pin does not name ran with no isolation when the run started
  const backends = new Set([...Object.keys(view.isolated), ...Object.keys(pin.isolated)]);
  const isolated = Object.fromEntries([...backends].map((k) => [k, pin.isolated[k] === true]));
  return { ...view, roles, isolated };
}

/** What changed since the pin, one line each, in words; none while the run's repo still runs as pinned. */
export function pinChanges(deps: Deps, run: Run): string[] {
  const pin = readPin(run);
  if (!pin) return [];
  let now: ProfileView;
  try {
    now = deps.profiles.forRepo(run.meta.repo);
  } catch {
    // a profile that cannot be read is doctor's and profile validate's to report, not a pin change
    return [];
  }
  const out: string[] = [];
  if (now.name !== pin.profile) {
    const { why } = pinnedView(deps, run, pin);
    out.push(
      `profile: pinned ${pin.profile}, the repo now runs on ${now.name}${why ? ` (${pin.profile} cannot be read: ${why}; dispatch reads ${now.name})` : ""}`,
    );
  }
  for (const [role, access] of Object.entries(pin.access)) {
    const was = now.roles[role as keyof ProfileView["roles"]]?.access;
    if (was !== undefined && was !== access) out.push(`${role} access: pinned ${access}, now ${was}`);
  }
  for (const backend of new Set([...Object.keys(pin.isolated), ...Object.keys(now.isolated)])) {
    const isolated = pin.isolated[backend] === true;
    const was = now.isolated[backend] === true;
    if (was !== isolated) out.push(`${backend} isolated: pinned ${isolated}, now ${was}`);
  }
  return out;
}

/** `run_pin`: the owner re-pins the run to what its repo runs on now. Returns the new pin and what it changed. */
export async function repin(
  deps: Deps,
  i: { run: string },
): Promise<{ pin: Pin; changed: string[]; hints?: string[] }> {
  const run = findRun(i.run);
  const changed = pinChanges(deps, run);
  const pin = writePin(deps, run);
  const { hints } = await refreshState(run, { pinChanges: [] });
  return { pin, changed, ...(hints.length ? { hints } : {}) };
}
