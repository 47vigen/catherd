import { z } from "zod";
import { type Rung, parseRung } from "./ids.ts";
import type { Role } from "./roles.ts";
import { type IndexFile, slopKey } from "./slopalytics.ts";

/**
 * Spec §7.1 `billing` keys: a rung's backend, except that opencode's Go models (`opencode-go/…`) are billed
 * apart from its Zen models (`opencode/…`).
 */
export const BILLING_KEYS = ["codex", "claude", "claude-code", "opencode-go", "opencode", "cursor"] as const;
export type BillingKey = (typeof BILLING_KEYS)[number];

/** The keys a family's `on` map uses; the native `claude` pseudo-backend runs claude-code's model ids. */
const MODEL_KEYS = ["codex", "claude-code", "opencode-go", "opencode", "cursor"] as const;
type ModelKey = (typeof MODEL_KEYS)[number];

export function billingKeyOf(r: Rung): BillingKey {
  if (r.backend === "opencode" && r.model.startsWith("opencode-go/")) return "opencode-go";
  return r.backend;
}

const modelKeyOf = (k: BillingKey): ModelKey => (k === "claude" ? "claude-code" : k);

const BackendModelSchema = z.object({ id: z.string().min(1) });

/**
 * What catherd knows of a model that Slopalytics does not: its capabilities, how a plan weighs it and the
 * model id each backend runs it under. `vendor` and `status` stay in the data as documentation.
 */
const FamilySchema = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  capabilities: z.object({ toolUse: z.boolean(), imageIn: z.boolean(), reasoning: z.boolean() }),
  /** chatgpt-plan: messages per 5 hours relative to GPT-6 Luna (spec §5.3) */
  planWeight: z.number().positive().optional(),
  /** claude-plan: billed as usage credits, not from the plan's limits */
  meteredOnPlan: z.boolean().default(false),
  on: z.partialRecord(z.enum(MODEL_KEYS), BackendModelSchema),
  notes: z.record(z.string(), z.string()).default({}),
});
export type Family = z.infer<typeof FamilySchema>;

export const ModelsFileSchema = z.looseObject({
  schema: z.literal(1),
  version: z.string(),
  backends: z.record(
    z.string(),
    z.looseObject({
      imageGen: z.object({ tool: z.string(), requires: z.string(), source: z.string() }).optional(),
    }),
  ),
  families: z.array(FamilySchema),
});
export type ModelsFile = z.infer<typeof ModelsFileSchema>;

export interface Listed {
  id: string;
  efforts: string[];
  context: number | null;
  imageIn: boolean;
}

/** One model at one effort on the Slopalytics index: the one number routing ranks on, and what it costs and does. */
export interface Pair {
  intelligence: number;
  price: { input: number; output: number } | null;
  speed: number | null;
  context: number | null;
}

/** Everything routing reads: the shipped families, the Slopalytics index, and each backend's listing. */
export interface Catalog {
  families: Family[];
  backends: ModelsFile["backends"];
  /** Slopalytics family (`slopKey`) → effort → pair */
  index: Record<string, Record<string, Pair>>;
  /** when the proxy fetched the index; null with no index */
  indexedAt: string | null;
  /** ascending intelligences of every indexed pair of the shipped families: what the bars are percentiles of */
  pool: number[];
  /** per backend id, the last `listModels()`; absent when never listed */
  listed: Record<string, { fetchedAt: string; models: Listed[] }>;
}

export function buildCatalog(o: {
  models: ModelsFile;
  index: IndexFile | null;
  listed?: Catalog["listed"];
}): Catalog {
  const index: Catalog["index"] = {};
  for (const r of o.index?.models ?? [])
    (index[slopKey(r.family)] ??= {})[r.effort] = {
      intelligence: r.intelligence,
      price:
        r.inputPrice !== null && r.outputPrice !== null
          ? { input: r.inputPrice, output: r.outputPrice }
          : null,
      speed: r.speed,
      context: r.context,
    };
  const shippedKeys = new Set(o.models.families.map((f) => slopKey(f.id)));
  const pool = [...shippedKeys]
    .flatMap((k) => Object.values(index[k] ?? {}).map((p) => p.intelligence))
    .sort((a, b) => a - b);
  return {
    families: o.models.families,
    backends: o.models.backends,
    index,
    indexedAt: o.index?.fetchedAt ?? null,
    pool,
    listed: o.listed ?? {},
  };
}

/** What the catalog knows about one `backend:model#effort` rung. */
export interface RungInfo {
  rung: string;
  parsed: Rung;
  key: BillingKey;
  family: Family | null;
  /** `<family id or backend model id>#<effort>`: the key run evidence uses */
  canonical: string;
  /** the model's Slopalytics family key */
  slop: string;
  efforts: string[];
  context: number | null;
  /** true when the backend's last listing has it, false when that listing lacks it, null with no listing */
  listed: boolean | null;
  /** the rung's index entry; null when it is not indexed */
  pair: Pair | null;
}

function familyOf(c: Catalog, r: Rung): Family | null {
  const mk = modelKeyOf(billingKeyOf(r));
  return c.families.find((f) => f.on[mk]?.id === r.model) ?? null;
}

/** The backend's listing; the native `claude` backend has none of its own: it runs claude-code's models. */
const listingOf = (c: Catalog, backend: string) => c.listed[backend === "claude" ? "claude-code" : backend];

/**
 * A rung's catalog facts; `rung` must parse (E_ADMIT_RUNG otherwise). Its pair is the index's record for the
 * model's Slopalytics family at its effort; `#default` takes the family's `default` record, else its only one.
 */
export function rungInfo(c: Catalog, rung: string): RungInfo {
  const parsed = parseRung(rung);
  const key = billingKeyOf(parsed);
  const family = familyOf(c, parsed);
  const slop = slopKey(family?.id ?? parsed.model);
  const listing = listingOf(c, parsed.backend);
  const found = listing?.models.find((m) => m.id === parsed.model);
  const indexed = c.index[slop] ?? {};
  const only = Object.values(indexed);
  const pair =
    indexed[parsed.effort] ?? (parsed.effort === "default" && only.length === 1 ? (only[0] as Pair) : null);
  return {
    rung,
    parsed,
    key,
    family,
    canonical: `${family?.id ?? parsed.model}#${parsed.effort}`,
    slop,
    efforts: found?.efforts ?? Object.keys(indexed),
    context: found?.context ?? pair?.context ?? null,
    listed: listing && listing.models.length > 0 ? found !== undefined : null,
    pair,
  };
}

/** The rung's index entry; null when it is not a rung or not indexed. */
export function pairOf(c: Catalog, rung: string): Pair | null {
  try {
    return rungInfo(c, rung).pair;
  } catch {
    return null;
  }
}

/** Spec §4 roles: what a rung must offer to be placed on a role. */
export const ROLE_NEEDS: Record<Role, { toolUse?: true; imageIn?: true; imageGen?: true }> = {
  architect: { toolUse: true },
  verifier: { toolUse: true },
  worker: { toolUse: true },
  reviewer: { toolUse: true },
  "ui-reviewer": { toolUse: true, imageIn: true },
  artist: { imageGen: true },
  writer: { toolUse: true },
  researcher: { toolUse: true },
  judge: { toolUse: true },
};

/**
 * A listed model catherd has no family for can use tools (opencode's providers serve coding models) and reports
 * its own image input; image generation is a backend capability (spec §5.2: Codex's tool).
 */
export function capableFor(c: Catalog, info: RungInfo, role: Role): boolean {
  const need = ROLE_NEEDS[role];
  const listedImage = listingOf(c, info.parsed.backend)?.models.find(
    (m) => m.id === info.parsed.model,
  )?.imageIn;
  const caps = info.family?.capabilities ?? {
    toolUse: true,
    imageIn: listedImage ?? false,
    reasoning: false,
  };
  if (need.toolUse && !caps.toolUse) return false;
  if (need.imageIn && !caps.imageIn) return false;
  if (need.imageGen && !c.backends[info.parsed.backend]?.imageGen) return false;
  return true;
}

/** An effort the rung's model offers; `default` (no effort flag, spec §5.1) always is. */
export const effortOffered = (info: RungInfo): boolean =>
  info.parsed.effort === "default" || info.efforts.includes(info.parsed.effort);
