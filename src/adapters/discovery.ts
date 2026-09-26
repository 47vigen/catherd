import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { discoveryDir } from "../infra/paths.ts";
import { readVersioned, writeJsonAtomic } from "../infra/store.ts";
import type { DiscoveredModel } from "./backend.ts";

const DiscoverySchema = z.looseObject({
  schema: z.literal(1),
  backend: z.string(),
  fetchedAt: z.string(),
  models: z.array(
    z.object({
      id: z.string(),
      efforts: z.array(z.string()),
      context: z.number().nullable(),
      imageIn: z.boolean(),
    }),
  ),
});
export type DiscoveryFile = z.infer<typeof DiscoverySchema>;

/**
 * Spec §3.5: `<data>/discovery/<backend>.json`, the last listModels() with fetchedAt. A listing made for
 * one repository (a backend whose models depend on where it runs) is kept apart, under `repos/`.
 */
export const discoveryPath = (backend: string, repo?: string): string =>
  repo === undefined
    ? join(discoveryDir(), `${backend}.json`)
    : join(
        discoveryDir(),
        "repos",
        `${backend}-${createHash("sha256").update(repo).digest("hex").slice(0, 16)}.json`,
      );

/** Backends whose listing depends on the repository they run in (opencode's project config enables models). */
const PER_REPO: ReadonlySet<string> = new Set(["opencode"]);

/** The repository `backend`'s listing is kept for: `repo` for a backend listed per repository, else none. */
export const listingRepo = (backend: string, repo?: string): string | undefined =>
  PER_REPO.has(backend) ? repo : undefined;

/** The cached listing (for `repo` when given), or null when there is none or it cannot be read. */
export function readDiscovery(backend: string, repo?: string): DiscoveryFile | null {
  try {
    return readVersioned(discoveryPath(backend, repo), DiscoverySchema, 1);
  } catch {
    return null;
  }
}

export function writeDiscovery(
  backend: string,
  models: DiscoveredModel[],
  now = Date.now(),
  repo?: string,
): DiscoveryFile {
  const file: DiscoveryFile = {
    schema: 1,
    backend,
    ...(repo === undefined ? {} : { repo }),
    fetchedAt: new Date(now).toISOString(),
    models,
  };
  writeJsonAtomic(discoveryPath(backend, repo), file);
  return file;
}

/**
 * The cached models (for `repo` when given) while younger than `maxAgeMs` and listing `need` (when
 * given); otherwise a fresh `list()`, cached when it is not empty. An empty fresh list falls back to the
 * stale cache.
 */
export async function discovered(
  backend: string,
  list: () => Promise<DiscoveredModel[]>,
  o: { maxAgeMs: number; need?: string; now?: number; repo?: string },
): Promise<DiscoveredModel[]> {
  const now = o.now ?? Date.now();
  const cached = readDiscovery(backend, o.repo);
  const fresh = cached !== null && now - Date.parse(cached.fetchedAt) < o.maxAgeMs;
  if (cached && fresh && (o.need === undefined || cached.models.some((m) => m.id === o.need)))
    return cached.models;
  const models = await list();
  if (models.length === 0) return cached?.models ?? [];
  return writeDiscovery(backend, models, now, o.repo).models;
}
