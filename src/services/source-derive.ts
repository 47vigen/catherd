import { measuredOrBetter } from "../domain/bars.ts";
import { calibrate, DIM_SOURCES, type FieldRef } from "../domain/calibration.ts";
import {
  DIMS,
  type Dim,
  type Family,
  type FamilyFacts,
  type ModelsFile,
  outranks,
  type Score,
  type ScoresFile,
} from "../domain/catalog.ts";
import {
  defaultEffortOf,
  type Derived,
  familyEfforts,
  type FitRow,
  idMapper,
  type IdMapper,
  nearestEffort,
  type SourceId,
  type SourcesFile,
  splitSourceRung,
} from "../domain/sources.ts";
import { type AaAnswer, parseArtificialAnalysis } from "../infra/sources/artificial-analysis.ts";
import { parseArena } from "../infra/sources/arena.ts";
import { parseEpoch } from "../infra/sources/epoch.ts";
import { LITELLM_EFFORTS, parseLiteLlm } from "../infra/sources/litellm.ts";
import { modelsDevFacts } from "../infra/sources/models-dev.ts";
import { parseOpenRouterEndpoints } from "../infra/sources/openrouter-endpoints.ts";
import { type OpenRouterModel, parseOpenRouterModels } from "../infra/sources/openrouter-models.ts";
import type { SourceRow } from "../infra/sources/rows.ts";
import { parseVectara } from "../infra/sources/vectara.ts";

/** Each source's cached answer (its `data`) with its fetch time; a source never fetched is absent. */
export type RawAnswers = Partial<Record<SourceId, { fetchedAt: string; data: unknown }>>;

export interface DeriveContext {
  models: ModelsFile;
  scores: ScoresFile;
  sources: SourcesFile;
  now: number;
}

/** Spec 1.2 §3.5: a price that differs by more than this is a sync warning. */
const PRICE_TOLERANCE = 0.1;
/** Spec 1.2 §3.5: the models.dev provider that serves a backend key its own catalog. */
const OPENCODE_KEYS = ["opencode", "opencode-go"] as const;

interface Keyed {
  key: string;
  family: Family | null;
  effort: string;
  assumed: boolean;
  row: SourceRow;
}

/** The score sources' rows, by source (spec 1.2 §3.3). */
function scoreRows(raw: RawAnswers): [SourceId, SourceRow[]][] {
  const out: [SourceId, SourceRow[]][] = [];
  const { arena, vectara, epoch } = raw;
  const aa = raw["artificial-analysis"];
  if (arena) out.push(["arena", parseArena(arena.data as Record<string, unknown>, arena.fetchedAt)]);
  if (vectara) out.push(["vectara", parseVectara(String(vectara.data), vectara.fetchedAt)]);
  if (epoch) out.push(["epoch", parseEpoch(epoch.data as Record<string, string>, epoch.fetchedAt)]);
  if (aa) out.push(["artificial-analysis", parseArtificialAnalysis(aa.data as AaAnswer, aa.fetchedAt)]);
  return out;
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;

/**
 * Spec 1.2 §3.4–§4.3: what the cached answers say. Each score source's ids are mapped onto the catalog's
 * families (unmatched ones listed, never guessed), each dimension's anchor gives `measured` values, every
 * other source is fitted onto the anchor and gives `calibrated` values when the fit may be used, and an
 * effort no source covers takes the nearest covered effort's value as `adjacent`. models.dev gives the facts;
 * OpenRouter and LiteLLM only cross-check them.
 */
export function derive(raw: RawAnswers, ctx: DeriveContext): Derived {
  const map = idMapper(ctx.models.families, ctx.sources.aliases);
  const unmatched: Record<string, Set<string>> = {};
  const table = new Map<string, Map<string, Keyed>>();
  for (const [source, rows] of scoreRows(raw))
    for (const row of rows) {
      const { id, effort } = splitSourceRung(row.rung);
      const family = map.family(id);
      if (!family) (unmatched[source] ??= new Set()).add(id);
      const e = effort ?? (family ? defaultEffortOf(ctx.sources, family) : "");
      const key = `${map.key(family?.id ?? id)}#${e}`;
      const field = `${source}.${row.field}`;
      const at = table.get(field) ?? new Map<string, Keyed>();
      table.set(field, at);
      const had = at.get(key);
      if (!had || row.value > had.row.value)
        at.set(key, { key, family, effort: e, assumed: effort === null && family !== null, row });
    }
  const valuesOf = (f: FieldRef) =>
    new Map([...(table.get(`${f.source}.${f.field}`)?.values() ?? [])].map((k) => [k.key, k.row.value]));

  const scores: Score[] = [];
  const fits: FitRow[] = [];
  const push = (dim: Dim, f: FieldRef, k: Keyed, value: number, extra: Partial<Score>) => {
    if (!k.family) return;
    scores.push({
      rung: `${k.family.id}#${k.effort}`,
      dim,
      value: round(value),
      benchmark: f.benchmark,
      version: k.row.date,
      url: k.row.url,
      date: k.row.date,
      confidence: "measured",
      source: f.source,
      ...(k.assumed ? { effortAssumed: true } : {}),
      ...extra,
    });
  };
  for (const dim of DIMS) {
    const spec = DIM_SOURCES[dim];
    let anchor: Map<string, number>;
    if (spec.anchor === "shipped") {
      anchor = new Map();
      // the hand-typed values published for the rung; never the shipped keyless ones (they carry a source)
      for (const s of ctx.scores.scores)
        if (s.dim === dim && s.source === undefined && measuredOrBetter(s)) {
          const { id, effort } = splitSourceRung(s.rung);
          anchor.set(`${map.key(id)}#${effort}`, s.value);
        }
    } else {
      const ref = spec.anchor;
      anchor = valuesOf(ref);
      for (const k of table.get(`${ref.source}.${ref.field}`)?.values() ?? [])
        push(dim, ref, k, k.row.value, {});
    }
    for (const other of spec.others) {
      const values = valuesOf(other);
      if (values.size === 0) continue;
      const r = calibrate(anchor, values);
      fits.push({
        dim,
        source: other.source,
        field: other.field,
        n: r.n,
        a: r.fit?.a ?? null,
        b: r.fit?.b ?? null,
        r2: r.fit?.r2 ?? null,
        used: r.used,
        ...(r.why ? { why: r.why } : {}),
      });
      const fit = r.used ? r.fit : null;
      if (!fit) continue;
      for (const k of table.get(`${other.source}.${other.field}`)?.values() ?? [])
        push(dim, other, k, fit.a * k.row.value + fit.b, {
          confidence: "calibrated",
          fit: { source: other.source, field: other.field, a: fit.a, b: fit.b, r2: fit.r2, n: fit.n },
        });
    }
  }
  const shipped = new Set<string>();
  for (const s of ctx.scores.scores)
    if (s.confidence !== "inferred") {
      const { id, effort } = splitSourceRung(s.rung);
      const family = map.family(id);
      if (family && effort !== null) shipped.add(`${family.id}#${effort}|${s.dim}`);
    }
  scores.push(...adjacent(ctx.models.families, scores, shipped, ctx.now));

  const { facts, warnings } = factsOf(raw, ctx, map);
  return {
    schema: 1,
    builtAt: new Date(ctx.now).toISOString(),
    scores,
    facts,
    fits,
    unmatched: Object.fromEntries(Object.entries(unmatched).map(([s, ids]) => [s, [...ids].sort()])),
    warnings,
    features: aaFeatures(table),
  };
}

/** Spec 1.2 §6.3: the Artificial Analysis numbers a stand-in is ranked on, as AA names them. */
export const AA_FEATURES = [
  "artificial_analysis_intelligence_index",
  "hle",
  "scicode",
  "lcr",
  "cost_per_task",
  "median_output_tokens_per_second",
] as const;

/** Each catalog rung's AA stand-in features, from the rows `derive` keyed (never shipped: AA is keyed). */
function aaFeatures(table: Map<string, Map<string, Keyed>>): Derived["features"] {
  const out: Derived["features"] = {};
  for (const field of AA_FEATURES)
    for (const k of table.get(`artificial-analysis.${field}`)?.values() ?? []) {
      if (!k.family) continue;
      (out[`${k.family.id}#${k.effort}`] ??= {})[field] = k.row.value;
    }
  return out;
}

/**
 * Spec 1.2 §4.3 `adjacent`: for each family effort a dimension has no value at (neither one in `direct` nor
 * one `shipped` names, as `<family>#<effort>|<dim>`), the best value in `direct` at the nearest effort that
 * has one (the weaker on a tie). A sync spreads only its own values, and never onto a value the shipped file
 * carries; `rebuildShipped` spreads the shipped file's published values, with an empty `shipped`.
 */
export function adjacent(
  families: Family[],
  direct: Score[],
  shipped: ReadonlySet<string>,
  now: number,
): Score[] {
  const out: Score[] = [];
  for (const f of families)
    for (const dim of DIMS) {
      const byEffort = new Map<string, Score>();
      for (const s of direct) {
        const { id, effort } = splitSourceRung(s.rung);
        if (id !== f.id || s.dim !== dim || effort === null) continue;
        const had = byEffort.get(effort);
        if (!had || outranks(s, had, now)) byEffort.set(effort, s);
      }
      if (byEffort.size === 0) continue;
      for (const e of familyEfforts(f)) {
        if (byEffort.has(e) || shipped.has(`${f.id}#${e}|${dim}`)) continue;
        const near = nearestEffort(e, [...byEffort.keys()]);
        const from = near ? byEffort.get(near) : undefined;
        if (!near || !from) continue;
        out.push({
          ...from,
          rung: `${f.id}#${e}`,
          confidence: "adjacent",
          note: `${from.source ?? from.benchmark} has it at ${near}; carried to this effort`,
        });
      }
    }
  return out;
}

const differs = (a: number, b: number) => b !== 0 && Math.abs(a - b) / b > PRICE_TOLERANCE;
const money = (n: number) => `$${n}/M`;

/** Spec 1.2 §3.5: models.dev's facts per family, OpenRouter's speed facts, and the cross-check warnings. */
function factsOf(
  raw: RawAnswers,
  ctx: DeriveContext,
  map: IdMapper,
): { facts: Record<string, FamilyFacts>; warnings: string[] } {
  const md = raw["models-dev"]?.data;
  const orModels = raw["openrouter-models"] ? parseOpenRouterModels(raw["openrouter-models"].data) : [];
  const liteLlm = raw.litellm ? parseLiteLlm(raw.litellm.data) : [];
  const endpoints = raw["openrouter-endpoints"];
  const speedRows = endpoints
    ? parseOpenRouterEndpoints(endpoints.data as Record<string, unknown>, endpoints.fetchedAt)
    : [];
  const aa = raw["artificial-analysis"];
  const aaRows = aa ? parseArtificialAnalysis(aa.data as AaAnswer, aa.fetchedAt) : [];
  const facts: Record<string, FamilyFacts> = {};
  const warnings: string[] = [];
  for (const f of ctx.models.families) {
    const x: FamilyFacts = { on: {}, speed: {} };
    const vendor = (f as { vendor?: unknown }).vendor;
    const own = md && typeof vendor === "string" ? modelsDevFacts(md, vendor, f.id) : null;
    if (own?.price) x.price = own.price;
    if (own && own.toolUse !== null && own.imageIn !== null && own.reasoning !== null)
      x.capabilities = { toolUse: own.toolUse, imageIn: own.imageIn, reasoning: own.reasoning };
    if (own?.releaseDate) x.releaseDate = own.releaseDate;
    for (const key of OPENCODE_KEYS) {
      const on = f.on[key];
      const got = md && on ? modelsDevFacts(md, key, on.id.slice(on.id.indexOf("/") + 1)) : null;
      if (got)
        x.on[key] = {
          ...(got.efforts ? { efforts: got.efforts } : {}),
          ...(got.context ? { context: got.context } : {}),
        };
    }
    for (const r of speedRows) if (map.family(r.rung) === f) x.speed[`openrouter.${r.field}`] = r.value;
    const defaultRung = `${map.key(f.id)}#${defaultEffortOf(ctx.sources, f)}`;
    for (const r of aaRows) {
      const { id, effort } = splitSourceRung(r.rung);
      if (map.family(id) !== f || `${map.key(f.id)}#${effort}` !== defaultRung) continue;
      if (/^median_|^cost_per_task$/.test(r.field)) x.speed[`artificial-analysis.${r.field}`] = r.value;
    }
    if (x.price || x.capabilities || x.releaseDate || Object.keys(x.on).length || Object.keys(x.speed).length)
      facts[f.id] = x;
    if (own?.price) warnings.push(...priceWarnings(f, own.price, orModels, liteLlm, map));
    if (own?.efforts) warnings.push(...effortWarnings(f, own.efforts, liteLlm, map));
  }
  return { facts, warnings };
}

/** The first entry of `list` whose id maps to `f` (OpenRouter's `:batch` variants never do). */
const entryFor = <T extends { id: string }>(list: T[], f: Family, map: IdMapper): T | undefined =>
  list.find((m) => map.family(m.id) === f);

function priceWarnings(
  f: Family,
  price: { input: number; output: number },
  orModels: OpenRouterModel[],
  liteLlm: ReturnType<typeof parseLiteLlm>,
  map: IdMapper,
): string[] {
  const out: string[] = [];
  for (const [name, other] of [
    ["OpenRouter", entryFor(orModels, f, map)?.price],
    ["LiteLLM", entryFor(liteLlm, f, map)?.price],
  ] as const) {
    if (!other) continue;
    for (const side of ["input", "output"] as const)
      if (differs(other[side], price[side]))
        out.push(
          `${f.id}: ${side} price ${money(price[side])} on models.dev, ${money(other[side])} on ${name} (more than 10 % apart)`,
        );
  }
  return out;
}

function effortWarnings(
  f: Family,
  efforts: string[],
  liteLlm: ReturnType<typeof parseLiteLlm>,
  map: IdMapper,
): string[] {
  const entry = entryFor(liteLlm, f, map);
  if (!entry) return [];
  const out: string[] = [];
  for (const e of LITELLM_EFFORTS) {
    const says = entry.efforts[e];
    if (says === undefined || says === efforts.includes(e)) continue;
    out.push(
      `${f.id}: LiteLLM says effort ${e} is ${says ? "" : "not "}supported; models.dev ${says ? "does not list" : "lists"} it`,
    );
  }
  return out;
}

/** Plan 13 R-H: the OpenRouter id of each catalog family OpenRouter lists, one each, for the endpoints fetch. */
export function openRouterIds(
  orModelsData: unknown,
  ctx: Pick<DeriveContext, "models" | "sources">,
): string[] {
  const map = idMapper(ctx.models.families, ctx.sources.aliases);
  const models = parseOpenRouterModels(orModelsData);
  return ctx.models.families.flatMap((f) => {
    const m = entryFor(models, f, map);
    return m ? [m.id] : [];
  });
}
