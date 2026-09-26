import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { assetPath, readJsonFile } from "../files.ts";
import { withFileLock } from "../infra/filelock.ts";
import { writeJsonAtomic } from "../infra/store.ts";
import { configDir } from "../paths.ts";
import {
  type Capabilities,
  type Catalog,
  type CatalogEntry,
  type CatalogModel,
  DIFFICULTIES,
  KINDS,
  ROLE_NEEDS,
  type Role,
  type RungId,
} from "../types.ts";

const Caps = z.object({
  toolCall: z.boolean(),
  imageIn: z.boolean(),
  imageOut: z.boolean(),
  reasoning: z.boolean(),
  context: z.number(),
});
const Model = z.object({
  id: z.string().min(1),
  backend: z.enum(["codex", "opencode", "claude"]),
  efforts: z.array(z.string().min(1)).min(1),
  capabilities: Caps,
});
const Scores = z.object({
  repo_code: z.number().optional(),
  terminal: z.number().optional(),
  honesty: z.number().optional(),
  secs_per_task: z.number().optional(),
});
const Bar = z.object({
  repo_code: z.number().optional(),
  terminal: z.number().optional(),
  honesty: z.number().optional(),
});
const Rung = z.string().regex(/^.+#[^#]+$/, "expected model#effort");

const CatalogSchema = z.object({
  version: z.string(),
  models: z.array(Model),
  entries: z.array(z.object({ rung: Rung, scores: Scores, costRank: z.number() })),
  bars: z.record(z.enum(KINDS), z.record(z.enum(DIFFICULTIES), Bar)),
  treatLike: z.record(Rung, Rung),
});

// Loose: the 1.0 catalog service writes `schema` and `scores[]` to the same file, which a 0.x save keeps.
const OverrideSchema = z.looseObject({
  models: z
    .record(
      z.string().min(1),
      z
        .object({ backend: Model.shape.backend, efforts: Model.shape.efforts, capabilities: Caps.partial() })
        .partial(),
    )
    .optional(),
  entries: z
    .record(Rung, z.object({ scores: Scores.optional(), costRank: z.number().optional() }))
    .optional(),
  bars: z.partialRecord(z.enum(KINDS), z.partialRecord(z.enum(DIFFICULTIES), Bar)).optional(),
  treatLike: z.record(Rung, Rung).optional(),
});
export type CatalogOverride = z.infer<typeof OverrideSchema>;

export const overridePath = (): string => join(configDir(), "catalog.override.json");

/**
 * 0.x shim: the 0.x profile validation and TUI read catalog/catalog.json until plans 5 and 6. The 1.0
 * catalog is src/services/catalog-service.ts; the models.dev snapshot is gone (spec §5.2).
 */
export function loadCatalog(): Catalog {
  const c: Catalog = readJsonFile(CatalogSchema, assetPath("catalog/catalog.json"));
  return existsSync(overridePath()) ? applyOverride(c, readJsonFile(OverrideSchema, overridePath())) : c;
}

function applyOverride(c: Catalog, o: CatalogOverride): Catalog {
  const file = overridePath();
  for (const [id, m] of Object.entries(o.models ?? {})) {
    const cur = modelOf(c, id);
    if (cur) {
      if (m.backend) cur.backend = m.backend;
      if (m.efforts) cur.efforts = m.efforts;
      cur.capabilities = { ...cur.capabilities, ...m.capabilities };
      continue;
    }
    const full = Model.safeParse({ id, ...m });
    if (!full.success)
      throw new Error(`catherd: ${file}: new model "${id}" needs a backend, efforts and every capability`);
    c.models.push(full.data);
  }
  for (const [rung, e] of Object.entries(o.entries ?? {})) {
    const cur = c.entries.find((x) => x.rung === rung);
    if (cur) {
      cur.scores = { ...cur.scores, ...e.scores };
      cur.costRank = e.costRank ?? cur.costRank;
    } else if (e.costRank === undefined) {
      throw new Error(`catherd: ${file}: new entry "${rung}" needs a costRank`);
    } else {
      c.entries.push({ rung, scores: e.scores ?? {}, costRank: e.costRank });
    }
  }
  for (const kind of KINDS) {
    for (const d of DIFFICULTIES) {
      const bar = o.bars?.[kind]?.[d];
      if (bar) c.bars[kind][d] = bar;
    }
  }
  // `catherd catalog treat-like` may name a rung only the 1.0 catalog scores; 0.x skips it
  for (const [rung, like] of Object.entries(o.treatLike ?? {}))
    if (c.entries.some((e) => e.rung === like)) c.treatLike[rung] = like;
  return c;
}

export function modelOf(c: Catalog, id: string): CatalogModel | undefined {
  return c.models.find((m) => m.id === id);
}

export function capableFor(role: Role, m: CatalogModel): boolean {
  return Object.entries(ROLE_NEEDS[role]).every(([k, need]) => {
    const have = m.capabilities[k as keyof Capabilities];
    return typeof need === "number" ? Number(have) >= need : have === need;
  });
}

export function entryFor(c: Catalog, rung: RungId): CatalogEntry | undefined {
  const own = c.entries.find((e) => e.rung === rung);
  if (own) return own;
  const like = c.treatLike[rung];
  const borrowed = like === undefined ? undefined : c.entries.find((e) => e.rung === like);
  return borrowed && { ...borrowed, rung };
}

export function isScored(c: Catalog, rung: RungId): boolean {
  return entryFor(c, rung) !== undefined;
}

/**
 * Merges one "treat like" into <config>/catalog.override.json, keeping every other field (the 1.0
 * `schema` and `scores[]` too), under the same lock and atomic write as the 1.0 catalog service.
 */
export async function saveTreatLike(rung: RungId, like: RungId): Promise<void> {
  const base = loadCatalog();
  if (!base.entries.some((e) => e.rung === like)) {
    throw new Error(`catherd: ${overridePath()}: "${rung}" is treated like "${like}", which has no scores`);
  }
  const file = overridePath();
  mkdirSync(dirname(file), { recursive: true });
  await withFileLock(file, () => {
    const current: CatalogOverride = existsSync(file) ? readJsonFile(OverrideSchema, file) : {};
    writeJsonAtomic(file, { ...current, treatLike: { ...current.treatLike, [rung]: like } });
  });
}
