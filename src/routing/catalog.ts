import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createFetch } from "ofetch";
import { z } from "zod";
import { assetPath, readJsonFile } from "../files.ts";
import { configDir, dataDir } from "../paths.ts";
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

const OverrideSchema = z.object({
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

const SnapshotSchema = z.object({
  fetchedAt: z.string(),
  models: z.record(z.string(), Caps.extend({ efforts: z.array(z.string()) })),
});
export type ModelsDevSnapshot = {
  fetchedAt: string;
  models: Record<string, Capabilities & { efforts: string[] }>;
};

export const snapshotPath = (): string => join(dataDir(), "models-dev.json");
export const overridePath = (): string => join(configDir(), "catalog.override.json");

export function loadCatalog(): Catalog {
  const c: Catalog = readJsonFile(CatalogSchema, assetPath("catalog/catalog.json"));
  const snapshot = [snapshotPath(), assetPath("catalog/models-dev.json")].find((f) => existsSync(f));
  if (snapshot) {
    const known = new Set(c.models.map((m) => m.id));
    for (const [id, { efforts, ...capabilities }] of Object.entries(
      readJsonFile(SnapshotSchema, snapshot).models,
    )) {
      if (!known.has(id))
        c.models.push({ id, backend: "opencode", efforts: ["default", ...efforts], capabilities });
    }
  }
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
  for (const [rung, like] of Object.entries(o.treatLike ?? {})) {
    if (!c.entries.some((e) => e.rung === like)) {
      throw new Error(`catherd: ${file}: "${rung}" is treated like "${like}", which has no scores`);
    }
    c.treatLike[rung] = like;
  }
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

/** Merges one "treat like" into <config>/catalog.override.json, keeping every other field. */
export function saveTreatLike(rung: RungId, like: RungId): void {
  const base = loadCatalog();
  if (!base.entries.some((e) => e.rung === like)) {
    throw new Error(`catherd: ${overridePath()}: "${rung}" is treated like "${like}", which has no scores`);
  }
  const file = overridePath();
  const current: CatalogOverride = existsSync(file) ? readJsonFile(OverrideSchema, file) : {};
  const next: CatalogOverride = { ...current, treatLike: { ...current.treatLike, [rung]: like } };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
}

export const MODELS_DEV_URL = "https://models.dev/api.json";

interface ModelsDevModel {
  tool_call?: boolean;
  reasoning?: boolean;
  status?: string;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number };
  reasoning_options?: { type: string; values?: string[] }[];
}
export type ModelsDevApi = Record<string, { models?: Record<string, ModelsDevModel> } | undefined>;

export function trimModelsDev(api: ModelsDevApi, fetchedAt: string): ModelsDevSnapshot {
  const models: ModelsDevSnapshot["models"] = {};
  for (const [provider, p] of Object.entries(api)) {
    for (const [id, m] of Object.entries(p?.models ?? {})) {
      const imageOut = m.modalities?.output?.includes("image") ?? false;
      if (m.status === "deprecated" || !(m.tool_call || imageOut)) continue;
      models[`${provider}/${id}`] = {
        toolCall: m.tool_call ?? false,
        imageIn: m.modalities?.input?.includes("image") ?? false,
        imageOut,
        reasoning: m.reasoning ?? false,
        context: m.limit?.context ?? 0,
        efforts: m.reasoning_options?.find((r) => r.type === "effort")?.values ?? [],
      };
    }
  }
  return { fetchedAt, models };
}

export async function refreshModelsDev(
  o: { fetchImpl?: typeof fetch; to?: string } = {},
): Promise<{ models: number }> {
  const api = await createFetch({ fetch: o.fetchImpl ?? globalThis.fetch })<ModelsDevApi>(MODELS_DEV_URL, {
    retry: 2,
    retryDelay: 1000,
    timeout: 60_000,
  });
  const snap = trimModelsDev(typeof api === "object" && api !== null ? api : {}, new Date().toISOString());
  const count = Object.keys(snap.models).length;
  if (count === 0) throw new Error("catherd: models.dev returned no models; the previous snapshot is kept");
  const to = o.to ?? snapshotPath();
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(`${to}.tmp`, `${JSON.stringify(snap)}\n`);
  renameSync(`${to}.tmp`, to);
  return { models: count };
}
