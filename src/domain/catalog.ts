import { z } from "zod";
import { type Rung, parseRung } from "./ids.ts";
import { DIFFICULTIES, type Difficulty, KINDS, type Kind } from "./lane.ts";
import type { Role } from "./roles.ts";

/**
 * Spec §5.2 and 1.2 §5.1: the scored dimensions, each in its anchor's unit. `agentic`, `steer` and `frontend`
 * (1.2) carry no shipped bar yet.
 */
export const DIMS = ["repo_code", "terminal", "honesty", "agentic", "steer", "frontend"] as const;
export type Dim = (typeof DIMS)[number];

/**
 * Spec 1.2 §4.3: how a value was obtained, best first. The 1.0 levels (`verified`, `secondary`,
 * `inferred`) keep their names, so an older override file stays valid.
 */
export const CONFIDENCE = [
  "verified",
  "measured",
  "calibrated",
  "adjacent",
  "secondary",
  "inferred",
] as const;
export type Confidence = (typeof CONFIDENCE)[number];
export const RANK = Object.fromEntries(CONFIDENCE.map((c, i) => [c, i])) as Record<Confidence, number>;
/** Spec 1.2 §4.3: a value older than this many days counts one level lower. */
export const STALE_DAYS = 90;
const DAY_MS = 86_400_000;

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
  "antigravity",
] as const;
export type BillingKey = (typeof BILLING_KEYS)[number];

/** The keys a family's `on` map uses; the native `claude` pseudo-backend runs claude-code's model ids. */
const MODEL_KEYS = [
  "codex",
  "claude-code",
  "opencode-go",
  "opencode",
  "cursor",
  "grok",
  "antigravity",
] as const;
type ModelKey = (typeof MODEL_KEYS)[number];

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

/** `vendor` and `status` (current or legacy) stay in the data as documentation; nothing reads them. */
const FamilySchema = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  capabilities: z.object({ toolUse: z.boolean(), imageIn: z.boolean(), reasoning: z.boolean() }),
  /** API list price, dollars per million tokens */
  price: z.object({ input: z.number(), cached: z.number(), output: z.number() }),
  /** chatgpt-plan: messages per 5 hours relative to GPT-6 Luna (spec §5.3) */
  planWeight: z.number().positive().optional(),
  /** claude-plan: billed as usage credits, not from the plan's limits */
  meteredOnPlan: z.boolean().default(false),
  on: z.partialRecord(z.enum(MODEL_KEYS), BackendModelSchema),
  notes: z.record(z.string(), z.string()).default({}),
  /** the day the vendor released it (models.dev), a stand-in feature (spec 1.2 §6.3) */
  releaseDate: z.iso.date().optional(),
  /** a sync's speed facts (spec 1.2 §4.1), `<source>.<field>` → value; they never carry a bar */
  speed: z.record(z.string(), z.number()).optional(),
});
export type Family = z.infer<typeof FamilySchema>;

/** `sources` (where the data came from) stays in the file as documentation; nothing reads it. */
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

/** A canonical rung: `<canonical model id>#<effort>`, the key scores and treat-likes use. */
export const CanonicalRung = z.string().regex(/^[^:#\s]+#[^#\s]+$/, "a canonical rung is model#effort");

/** Spec 1.2 §4.2: `anchor = a·x + b`, fitted on `n` rungs both sources cover, with its R². */
export const FitSchema = z.object({
  source: z.string(),
  field: z.string(),
  a: z.number(),
  b: z.number(),
  r2: z.number(),
  n: z.number().int(),
});
export type Fit = z.infer<typeof FitSchema>;

export const ScoreSchema = z.object({
  rung: CanonicalRung,
  dim: z.enum(DIMS),
  value: z.number(),
  benchmark: z.string(),
  version: z.string(),
  url: z.url(),
  date: z.iso.date(),
  confidence: z.enum(CONFIDENCE),
  note: z.string().optional(),
  /** spec 1.2 §4.3: the source a synced value came from (absent: the shipped file or the user's override) */
  source: z.string().optional(),
  /** a calibrated value: the fit that mapped it onto the anchor */
  fit: FitSchema.optional(),
  /** the source named no effort, so the family's default effort was assumed (spec 1.2 §3.4) */
  effortAssumed: z.boolean().optional(),
});
export type Score = z.infer<typeof ScoreSchema>;

const BarSchema = z.partialRecord(z.enum(DIMS), z.number());
type Bars = Record<Kind, Record<Difficulty, Partial<Record<Dim, number>>>>;
const BarsSchema = z.record(z.enum(KINDS), z.record(z.enum(DIFFICULTIES), BarSchema));

/** Spec 1.2 §5.2: per dimension and difficulty, where the default threshold came from. */
const BarsWhySchema = z.partialRecord(z.enum(DIMS), z.partialRecord(z.enum(DIFFICULTIES), z.string()));

/**
 * `catalog/scores.json`: the hand-typed and keyless values (spec 1.2 §7), the shipped treat-likes, and the
 * default bars with the `barsWhy` line of each threshold (spec 1.2 §5.2).
 */
export const ScoresFileSchema = z.looseObject({
  schema: z.literal(1),
  version: z.string(),
  benchmarks: z.record(z.enum(DIMS), z.object({ benchmark: z.string(), version: z.string() })),
  scores: z.array(ScoreSchema),
  treatLike: z.record(CanonicalRung, z.object({ like: CanonicalRung, note: z.string() })),
  bars: BarsSchema,
  barsWhy: BarsWhySchema.default({}),
});
export type ScoresFile = z.infer<typeof ScoresFileSchema>;

/** An override's bar: per dimension a threshold, or `null` to remove the default's (spec 1.2 §5.2). */
const OverrideBarSchema = z.partialRecord(z.enum(DIMS), z.number().nullable());

/**
 * `<config>/catalog.override.json` (spec §3.5): the user's treat-likes, scores and bars. Its bars override
 * the default bars per dimension (spec 1.2 §5.2): a number sets that threshold, `null` removes it, and a
 * dimension it does not name keeps the default's.
 */
export const OverrideSchema = z.looseObject({
  schema: z.literal(1).default(1),
  treatLike: z.record(CanonicalRung, CanonicalRung).default({}),
  scores: z.array(ScoreSchema).default([]),
  bars: z.partialRecord(z.enum(KINDS), z.partialRecord(z.enum(DIFFICULTIES), OverrideBarSchema)).default({}),
});
export type Override = z.infer<typeof OverrideSchema>;

/** Spec 1.2 §6.1: the rung whose value a rung without one uses on a dimension, as `inferred`. */
export interface InferredStandIn {
  like: string;
  /** spec 1.2 §6.3's distance between the two */
  distance: number;
  /** the features that distance rests on */
  features: string[];
}

interface Listed {
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
  /** where each default threshold came from (spec 1.2 §5.2), by dimension and difficulty */
  barsWhy: ScoresFile["barsWhy"];
  /** per backend id, the last `listModels()`; absent when never listed */
  listed: Record<string, { fetchedAt: string; models: Listed[] }>;
  /** `<canonical rung>|<kind or *>` → median seconds, only with ≥ 5 samples (spec §5.2) */
  secs: Record<string, number>;
  /** canonical rung → the Artificial Analysis stand-in features a sync read for it (spec 1.2 §6.3) */
  features: Record<string, Record<string, number>>;
  /**
   * canonical rung → per dimension it has no value for (of its own or through a treat-like), the stand-in
   * whose value it uses as `inferred` (spec 1.2 §6.1); filled by the stand-in ranking (services/standins.ts)
   */
  inferred: Record<string, Partial<Record<Dim, InferredStandIn>>>;
  /** the thresholds the user's override set or removed, as `<kind>/<difficulty>/<dim>` (route says "your override") */
  userBars?: string[];
}

/**
 * Spec 1.2 §3.5: what a sync learned about a family. `price`, `capabilities` and the opencode backends'
 * `efforts` and `context` come from models.dev; `speed` holds facts that never carry a bar (spec 1.2 §4.1),
 * as `<source>.<field>` → value.
 */
export const FamilyFactsSchema = z.object({
  price: z.object({ input: z.number(), cached: z.number(), output: z.number() }).optional(),
  capabilities: z.object({ toolUse: z.boolean(), imageIn: z.boolean(), reasoning: z.boolean() }).optional(),
  on: z
    .partialRecord(
      z.enum(MODEL_KEYS),
      z.object({ efforts: z.array(z.string()).optional(), context: z.number().int().positive().optional() }),
    )
    .default({}),
  releaseDate: z.string().optional(),
  speed: z.record(z.string(), z.number()).default({}),
});
export type FamilyFacts = z.infer<typeof FamilyFactsSchema>;

/**
 * Spec 1.2 §3.5: the families with a sync's facts laid over them. The shipped file stays the floor: a fact
 * the sync lacks keeps the shipped one, and a backend keeps every effort it ships with.
 */
export function applyFacts(families: Family[], facts: Record<string, FamilyFacts>): Family[] {
  return families.map((f) => {
    const x = facts[f.id];
    if (!x) return f;
    const on = { ...f.on };
    for (const key of MODEL_KEYS) {
      const cur = on[key];
      const got = x.on[key];
      if (!cur || !got) continue;
      on[key] = {
        ...cur,
        efforts: [...cur.efforts, ...(got.efforts ?? []).filter((e) => !cur.efforts.includes(e))],
        context: got.context ?? cur.context,
      };
    }
    // a sync may add a capability, never remove one the shipped file gives (the floor)
    const got = x.capabilities;
    const capabilities = got
      ? {
          toolUse: f.capabilities.toolUse || got.toolUse,
          imageIn: f.capabilities.imageIn || got.imageIn,
          reasoning: f.capabilities.reasoning || got.reasoning,
        }
      : f.capabilities;
    return {
      ...f,
      price: x.price ?? f.price,
      capabilities,
      on,
      ...(x.releaseDate || f.releaseDate ? { releaseDate: x.releaseDate ?? f.releaseDate } : {}),
      ...(Object.keys(x.speed).length ? { speed: x.speed } : {}),
    };
  });
}

/** Spec 1.2 §4.3: the level a value counts at: its own, one lower once it is older than STALE_DAYS. */
export function effectiveRank(s: Score, now: number): number {
  const stale = now - Date.parse(s.date) > STALE_DAYS * DAY_MS;
  return Math.min(RANK[s.confidence] + (stale ? 1 : 0), CONFIDENCE.length - 1);
}

/** Spec 1.2 §4.3: `a` beats `b` at a better level, or at the same level with a newer date. */
export function outranks(a: Score, b: Score, now: number): boolean {
  const ra = effectiveRank(a, now);
  const rb = effectiveRank(b, now);
  return ra < rb || (ra === rb && a.date > b.date);
}

/**
 * The catalog routing reads: the shipped files, the synced values (spec 1.2 §3), each backend's listing and
 * the user's override, which always wins. Between shipped and synced values the better level wins, then the
 * newer date (spec 1.2 §4.3); `now` dates the 90-day drop.
 */
export function buildCatalog(o: {
  models: ModelsFile;
  scores: ScoresFile;
  synced?: Score[];
  facts?: Record<string, FamilyFacts>;
  override?: Override;
  listed?: Catalog["listed"];
  secs?: Catalog["secs"];
  features?: Catalog["features"];
  now?: number;
}): Catalog {
  const now = o.now ?? Date.now();
  const scores: Catalog["scores"] = {};
  const put = (s: Score, force: boolean) => {
    const cur = (scores[s.rung] ??= {});
    const had = cur[s.dim];
    if (force || !had || outranks(s, had, now)) cur[s.dim] = s;
  };
  for (const s of o.scores.scores) put(s, false);
  for (const s of o.synced ?? []) put(s, false);
  // the user's values say so whatever source they were copied with, for route's provenance (spec 1.2 §5.3)
  for (const s of o.override?.scores ?? []) put({ ...s, source: "override" }, true);
  const treatLike: Catalog["treatLike"] = {};
  for (const [rung, t] of Object.entries(o.scores.treatLike))
    treatLike[rung] = { like: t.like, source: "shipped" };
  for (const [rung, like] of Object.entries(o.override?.treatLike ?? {}))
    treatLike[rung] = { like, source: "user" };
  const bars = structuredClone(o.scores.bars) as Bars;
  const userBars: string[] = [];
  for (const kind of KINDS)
    for (const d of DIFFICULTIES)
      for (const [dim, min] of Object.entries(o.override?.bars[kind]?.[d] ?? {}) as [Dim, number | null][]) {
        userBars.push(`${kind}/${d}/${dim}`);
        if (min === null) delete bars[kind][d][dim];
        else bars[kind][d][dim] = min;
      }
  return {
    families: o.facts ? applyFacts(o.models.families, o.facts) : o.models.families,
    backends: o.models.backends,
    scores,
    treatLike,
    bars,
    barsWhy: o.scores.barsWhy,
    listed: o.listed ?? {},
    secs: o.secs ?? {},
    features: o.features ?? {},
    inferred: {},
    userBars,
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

function familyOf(c: Catalog, r: Rung): Family | null {
  const mk = modelKeyOf(billingKeyOf(r));
  return c.families.find((f) => f.on[mk]?.id === r.model) ?? null;
}

/** The backend's listing; the native `claude` backend has none of its own: it runs claude-code's models. */
const listingOf = (c: Catalog, backend: string) => c.listed[backend === "claude" ? "claude-code" : backend];

/** A rung's catalog facts; `rung` must parse (E_ADMIT_RUNG otherwise). */
export function rungInfo(c: Catalog, rung: string): RungInfo {
  const parsed = parseRung(rung);
  const key = billingKeyOf(parsed);
  const family = familyOf(c, parsed);
  const shipped = family?.on[modelKeyOf(key)];
  const listing = listingOf(c, parsed.backend);
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

/**
 * The rung's scores: per dimension its own value, else that of the rung it is treated like (a sync may score
 * a rung on some dimensions only), else its inferred stand-in's (spec 1.2 §6.1). `via` names the treat-like
 * when it lends any value and `borrowed` the dimensions it lends; `inferred` the dimensions an inferred
 * stand-in fills and `standIns` whose values they are. null when it has no value at all.
 */
export function scoresOf(
  c: Catalog,
  canonical: string,
): {
  values: Partial<Record<Dim, number>>;
  records: Partial<Record<Dim, Score>>;
  via: string | null;
  borrowed: Dim[];
  inferred: Dim[];
  standIns: Partial<Record<Dim, string>>;
} | null {
  const own = c.scores[canonical] ?? {};
  const like = c.treatLike[canonical]?.like ?? null;
  const lent = like ? (c.scores[like] ?? {}) : {};
  const guessed = c.inferred[canonical] ?? {};
  const values: Partial<Record<Dim, number>> = {};
  const records: Partial<Record<Dim, Score>> = {};
  const borrowed: Dim[] = [];
  const inferred: Dim[] = [];
  const standIns: Partial<Record<Dim, string>> = {};
  for (const d of DIMS) {
    const stand = guessed[d];
    const r = own[d] ?? lent[d] ?? (stand ? c.scores[stand.like]?.[d] : undefined);
    if (!r) continue;
    records[d] = r;
    values[d] = r.value;
    if (own[d]) continue;
    if (lent[d]) borrowed.push(d);
    else if (stand) {
      inferred.push(d);
      standIns[d] = stand.like;
    }
  }
  if (Object.keys(records).length === 0) return null;
  return { values, records, via: borrowed.length ? like : null, borrowed, inferred, standIns };
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
