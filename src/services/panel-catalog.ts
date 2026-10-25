import { z } from "zod";
import { pairOf } from "../domain/catalog.ts";
import { taskUsd } from "../domain/cost.ts";
import { catalogQuery, loadCatalog } from "./catalog-service.ts";

// The panel's Models page: every model catherd can place, with its measured (or estimated) cost per task and its
// intelligence at each effort. Display only; routing never reads it.

export const EFFORT_ORDER = [
  "none",
  "minimal",
  "low",
  "medium",
  "default",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export const ModelPointSchema = z.object({
  effort: z.string(),
  rung: z.string(),
  intelligence: z.number(),
  /** measured cost per task, else the list-price estimate, else null */
  usd: z.number().nullable(),
  measured: z.boolean(),
});
export const CatalogEntrySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  lab: z.string().nullable(),
  backends: z.array(z.string()),
  /** a newer version replaces it on every backend that offers it: the page starts with it switched off */
  superseded: z.boolean(),
  points: z.array(ModelPointSchema),
});
export const CatalogViewSchema = z.object({
  indexedAt: z.string().nullable(),
  models: z.array(CatalogEntrySchema),
});
export type CatalogView = z.infer<typeof CatalogViewSchema>;

const rank = (effort: string) => {
  const i = (EFFORT_ORDER as readonly string[]).indexOf(effort);
  return i < 0 ? EFFORT_ORDER.length : i;
};

export function catalogView(repo?: string): CatalogView {
  const c = loadCatalog({ repo });
  const byId = new Map<string, z.infer<typeof CatalogEntrySchema>>();
  const offered = new Set<string>();
  const current = new Set<string>();
  for (const m of catalogQuery({ older: true, limit: 10_000, repo }).models) {
    if (m.listed !== false) offered.add(m.id);
    if (m.listed !== false && m.supersededBy === null) current.add(m.id);
    let e = byId.get(m.id);
    if (!e)
      byId.set(m.id, (e = { id: m.id, name: m.name, lab: null, backends: [], superseded: true, points: [] }));
    if (!e.backends.includes(m.backend)) e.backends.push(m.backend);
    for (const r of m.rungs) {
      const effort = r.rung.slice(r.rung.lastIndexOf("#") + 1);
      if (e.points.some((p) => p.effort === effort)) continue;
      const pair = pairOf(c, r.rung);
      e.lab ??= pair?.lab ?? null;
      const measured = pair?.costUsd != null;
      const usd = measured ? (pair?.costUsd ?? null) : r.price ? taskUsd(r.price, effort) : null;
      e.points.push({ effort, rung: r.rung, intelligence: r.intelligence, usd, measured });
    }
  }
  const models = [...byId.values()].filter((e) => offered.has(e.id));
  for (const e of models) {
    e.superseded = !current.has(e.id);
    e.points.sort((a, b) => rank(a.effort) - rank(b.effort));
  }
  return { indexedAt: c.indexedAt, models };
}
