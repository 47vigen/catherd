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

/** Spec §3.5: `<data>/discovery/<backend>.json`, the last listModels() with fetchedAt. */
export const discoveryPath = (backend: string): string => join(discoveryDir(), `${backend}.json`);

/** The cached listing, or null when there is none or it cannot be read. */
export function readDiscovery(backend: string): DiscoveryFile | null {
  try {
    return readVersioned(discoveryPath(backend), DiscoverySchema, 1);
  } catch {
    return null;
  }
}

export function writeDiscovery(backend: string, models: DiscoveredModel[], now = Date.now()): DiscoveryFile {
  const file: DiscoveryFile = { schema: 1, backend, fetchedAt: new Date(now).toISOString(), models };
  writeJsonAtomic(discoveryPath(backend), file);
  return file;
}

/**
 * The cached models while younger than `maxAgeMs` and listing `need` (when given); otherwise a fresh
 * `list()`, cached when it is not empty. An empty fresh list falls back to the stale cache.
 */
export async function discovered(
  backend: string,
  list: () => Promise<DiscoveredModel[]>,
  o: { maxAgeMs: number; need?: string; now?: number },
): Promise<DiscoveredModel[]> {
  const now = o.now ?? Date.now();
  const cached = readDiscovery(backend);
  const fresh = cached !== null && now - Date.parse(cached.fetchedAt) < o.maxAgeMs;
  if (cached && fresh && (o.need === undefined || cached.models.some((m) => m.id === o.need)))
    return cached.models;
  const models = await list();
  if (models.length === 0) return cached?.models ?? [];
  return writeDiscovery(backend, models, now).models;
}
