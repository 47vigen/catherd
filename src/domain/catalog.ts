import { z } from "zod";
import { type Rung, parseRung } from "./ids.ts";
import { DIFFICULTIES, type Difficulty, KINDS, type Kind } from "./lane.ts";
import type { Role } from "./roles.ts";

/** Spec §5.2: the scored dimensions, each on one named benchmark. */
export const DIMS = ["repo_code", "terminal", "honesty"] as const;
export type Dim = (typeof DIMS)[number];

/**
 * Spec §7.1 `billing` keys: a rung's backend, except that opencode's Go models (`opencode-go/…`) are billed
 * apart from its Zen models (`opencode/…`).
 */
export const BILLING_KEYS = [
  "codex",
  "claude",
  "claude-code",
  "opencode-go",
  "opencode",
  "cursor",
  "grok",
] as const;
export type BillingKey = (typeof BILLING_KEYS)[number];

/** The keys a family's `on` map uses; the native `claude` pseudo-backend runs claude-code's model ids. */
export const MODEL_KEYS = ["codex", "claude-code", "opencode-go", "opencode", "cursor", "grok"] as const;
export type ModelKey = (typeof MODEL_KEYS)[number];

export function billingKeyOf(r: Rung): BillingKey {
  if (r.backend === "opencode" && r.model.startsWith("opencode-go/")) return "opencode-go";
  return r.backend;
}

const modelKeyOf = (k: BillingKey): ModelKey => (k === "claude" ? "claude-code" : k);

const BackendModelSchema = z.object({
  id: z.string().min(1),
  efforts: z.array(z.string().min(1)),
  context: z.number().int().positive(),
});

const FamilySchema = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  vendor: z.enum(["openai", "anthropic"]),
  status: z.enum(["current", "legacy"]).default("current"),
  capabilities: z.object({ toolUse: z.boolean(), imageIn: z.boolean(), reasoning: z.boolean() }),
  /** API list price, dollars per million tokens */
  price: z.object({ input: z.number(), cached: z.number(), output: z.number() }),
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
  sources: z.record(z.string(), z.string()),
  backends: z.record(
    z.string(),
    z.looseObject({
      imageGen: z.object({ tool: z.string(), requires: z.string(), source: z.string() }).optional(),
    }),
  ),
  families: z.array(FamilySchema),
});
export type ModelsFile = z.infer<typeof ModelsFileSchema>;

/** A canonical rung: `<canonical model id>#<effort>`, the key scores and treat-likes use. */
const CanonicalRung = z.string().regex(/^[^:#\s]+#[^#\s]+$/, "a canonical rung is model#effort");

export const ScoreSchema = z.object({
  rung: CanonicalRung,
  dim: z.enum(DIMS),
  value: z.number(),
  benchmark: z.string(),
  version: z.string(),
  url: z.url(),
  date: z.iso.date(),
  confidence: z.enum(["verified", "secondary", "inferred"]),
  note: z.string().optional(),
});
export type Score = z.infer<typeof ScoreSchema>;

const BarSchema = z.partialRecord(z.enum(DIMS), z.number());
export type Bars = Record<Kind, Record<Difficulty, Partial<Record<Dim, number>>>>;
const BarsSchema = z.record(z.enum(KINDS), z.record(z.enum(DIFFICULTIES), BarSchema));

export const ScoresFileSchema = z.looseObject({
  schema: z.literal(1),
  version: z.string(),
  benchmarks: z.record(z.enum(DIMS), z.object({ benchmark: z.string(), version: z.string() })),
  scores: z.array(ScoreSchema),
  treatLike: z.record(CanonicalRung, z.object({ like: CanonicalRung, note: z.string() })),
  bars: BarsSchema,
});
export type ScoresFile = z.infer<typeof ScoresFileSchema>;

/** `<config>/catalog.override.json` (spec §3.5): the user's treat-likes, scores and bars. */
export const OverrideSchema = z.looseObject({
  schema: z.literal(1).default(1),
  treatLike: z.record(CanonicalRung, CanonicalRung).default({}),
  scores: z.array(ScoreSchema).default([]),
  bars: z.partialRecord(z.enum(KINDS), z.partialRecord(z.enum(DIFFICULTIES), BarSchema)).default({}),
});
export type Override = z.infer<typeof OverrideSchema>;

export interface Listed {
  id: string;
  efforts: string[];
  context: number | null;
  imageIn: boolean;
}

/** Everything routing reads, merged from the three layers plus the user's override and own timings. */
export interface Catalog {
  families: Family[];
  backends: ModelsFile["backends"];
  /** canonical rung → its best-sourced value per dimension (the override's win) */
  scores: Record<string, Partial<Record<Dim, Score>>>;
  treatLike: Record<string, { like: string; source: "shipped" | "user" }>;
  bars: Bars;
  /** per backend id, the last `listModels()`; absent when never listed */
  listed: Record<string, { fetchedAt: string; models: Listed[] }>;
  /** `<canonical rung>|<kind or *>` → median seconds, only with ≥ 5 samples (spec §5.2) */
  secs: Record<string, number>;
}

const RANK: Record<Score["confidence"], number> = { verified: 0, secondary: 1, inferred: 2 };

export function buildCatalog(o: {
  models: ModelsFile;
  scores: ScoresFile;
  override?: Override;
  listed?: Catalog["listed"];
  secs?: Catalog["secs"];
}): Catalog {
  const scores: Catalog["scores"] = {};
  const put = (s: Score, force: boolean) => {
    const cur = (scores[s.rung] ??= {});
    const had = cur[s.dim];
    if (force || !had || RANK[s.confidence] < RANK[had.confidence]) cur[s.dim] = s;
  };
  for (const s of o.scores.scores) put(s, false);
  for (const s of o.override?.scores ?? []) put(s, true);
  const treatLike: Catalog["treatLike"] = {};
  for (const [rung, t] of Object.entries(o.scores.treatLike))
    treatLike[rung] = { like: t.like, source: "shipped" };
  for (const [rung, like] of Object.entries(o.override?.treatLike ?? {}))
    treatLike[rung] = { like, source: "user" };
  const bars = structuredClone(o.scores.bars) as Bars;
  for (const kind of KINDS)
    for (const d of DIFFICULTIES) {
      const bar = o.override?.bars[kind]?.[d];
      if (bar) bars[kind][d] = bar;
    }
  return {
    families: o.models.families,
    backends: o.models.backends,
    scores,
    treatLike,
    bars,
    listed: o.listed ?? {},
    secs: o.secs ?? {},
  };
}

/** What the catalog knows about one `backend:model#effort` rung. */
export interface RungInfo {
  rung: string;
  parsed: Rung;
  key: BillingKey;
  family: Family | null;
  /** `<family id or backend model id>#<effort>`: the key scores, treat-likes and timings use */
  canonical: string;
  efforts: string[];
  context: number | null;
  /** true when the backend's last listing has it, false when that listing lacks it, null with no listing */
  listed: boolean | null;
}

export function familyOf(c: Catalog, r: Rung): Family | null {
  const mk = modelKeyOf(billingKeyOf(r));
  return c.families.find((f) => f.on[mk]?.id === r.model) ?? null;
}

/** A rung's catalog facts; `rung` must parse (E_ADMIT_RUNG otherwise). */
export function rungInfo(c: Catalog, rung: string): RungInfo {
  const parsed = parseRung(rung);
  const key = billingKeyOf(parsed);
  const family = familyOf(c, parsed);
  const shipped = family?.on[modelKeyOf(key)];
  // the native `claude` backend has no listing of its own: it runs claude-code's models
  const listing = c.listed[parsed.backend === "claude" ? "claude-code" : parsed.backend];
  const found = listing?.models.find((m) => m.id === parsed.model);
  return {
    rung,
    parsed,
    key,
    family,
    canonical: `${family?.id ?? parsed.model}#${parsed.effort}`,
    efforts: found?.efforts ?? shipped?.efforts ?? [],
    context: found?.context ?? shipped?.context ?? null,
    listed: listing && listing.models.length > 0 ? found !== undefined : null,
  };
}

/** The rung's scores: its own, else those of the rung it is treated like. null when unscored. */
export function scoresOf(
  c: Catalog,
  canonical: string,
): { values: Partial<Record<Dim, number>>; records: Partial<Record<Dim, Score>>; via: string | null } | null {
  const own = c.scores[canonical];
  const via = own ? null : (c.treatLike[canonical]?.like ?? null);
  const records = own ?? (via ? c.scores[via] : undefined);
  if (!records || Object.keys(records).length === 0) return null;
  const values: Partial<Record<Dim, number>> = {};
  for (const d of DIMS) if (records[d]) values[d] = records[d].value;
  return { values, records, via };
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
};

/**
 * A listed model catherd has no family for can use tools (Zen and Go serve coding models) and reports
 * its own image input; image generation is a backend capability (spec §5.2: Codex's tool).
 */
export function capableFor(c: Catalog, info: RungInfo, role: Role): boolean {
  const need = ROLE_NEEDS[role];
  const listedImage = c.listed[info.parsed.backend]?.models.find((m) => m.id === info.parsed.model)?.imageIn;
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
