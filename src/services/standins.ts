import {
  type Catalog,
  DIMS,
  type Dim,
  type Family,
  type InferredStandIn,
  rungInfo,
  scoresOf,
} from "../domain/catalog.ts";
import { catalogRungs } from "../domain/failover.ts";
import { EFFORT_ORDER } from "../domain/sources.ts";

/**
 * Spec 1.2 §6.3: the features a rung is compared on. Numbers are z-scored across the catalog; `vendor` and
 * `family` are words, the same or not. Keyless: price, context, release date, vendor and family, the effort
 * (plan 14 Ruling 6), and the rung's own values on each dimension (the Arena and Epoch values, with the
 * shipped ones). With an Artificial Analysis key, its index, `hle`, `scicode`, `lcr`, cost per task and
 * tokens/s join them (`Catalog.features`).
 */
export type Features = Record<string, number | string>;

/** Spec 1.2 §6.3: a pair sharing fewer features than this is not suggested. */
export const MIN_SHARED_FEATURES = 3;

/**
 * Spec 1.5 plan 24: a rung stands in only when it has values of its own on at least this many dimensions. A
 * sparse row (GPT-6.1 Sol's one honesty figure) ranks near everything, for it has few features to differ on,
 * and would lend that one value to unrelated rungs.
 */
export const MIN_STANDIN_DIMS = 3;

export interface Suggestion {
  /** the canonical rung that would stand in */
  like: string;
  distance: number;
  /** the features the distance rests on: those both rungs have */
  features: string[];
  /** the dimensions it would lend: those the rung lacks and it has */
  lends: Dim[];
}

const DAY_MS = 86_400_000;
const family = (c: Catalog, canonical: string): Family | null =>
  c.families.find((f) => f.id === canonical.slice(0, canonical.lastIndexOf("#"))) ?? null;

/** The rung's own value per dimension: a value it borrows, or catherd's guess (`inferred`), never counts. */
function ownValues(c: Catalog, canonical: string): Partial<Record<Dim, number>> {
  const out: Partial<Record<Dim, number>> = {};
  for (const d of DIMS) {
    const s = c.scores[canonical]?.[d];
    if (s && s.confidence !== "inferred") out[d] = s.value;
  }
  return out;
}

/** Spec 1.2 §6.3: a canonical rung's features, from its family, its effort, its own values and AA's. */
export function featuresOf(c: Catalog, canonical: string): Features {
  const out: Features = {};
  const f = family(c, canonical);
  if (f) {
    out.price = Math.log10(f.price.input + f.price.output + 1e-6);
    const contexts = Object.values(f.on).flatMap((m) => (m ? [m.context] : []));
    if (contexts.length) out.context = Math.log10(Math.max(...contexts));
    if (f.releaseDate) out.release = Date.parse(f.releaseDate) / DAY_MS;
    const vendor = (f as { vendor?: unknown }).vendor;
    if (typeof vendor === "string") out.vendor = vendor;
    out.family = f.id;
  }
  const effort = (EFFORT_ORDER as readonly string[]).indexOf(canonical.slice(canonical.lastIndexOf("#") + 1));
  if (effort >= 0) out.effort = effort;
  for (const [d, v] of Object.entries(ownValues(c, canonical))) out[d] = v;
  for (const [k, v] of Object.entries(c.features[canonical] ?? {})) out[`aa.${k}`] = v;
  return out;
}

/** Every canonical rung the catalog can name, and every one it holds a value for. */
export function canonicalRungs(c: Catalog): string[] {
  const out = new Set(Object.keys(c.scores));
  for (const r of catalogRungs(c)) {
    try {
      out.add(rungInfo(c, r).canonical);
    } catch {
      // catalogRungs only names parseable rungs
    }
  }
  return [...out].sort();
}

interface Scale {
  mean: number;
  sd: number;
}

/** Each numeric feature's mean and spread over `all`; a feature with no spread tells rungs apart by nothing. */
function scales(all: Features[]): Map<string, Scale> {
  const values = new Map<string, number[]>();
  for (const f of all)
    for (const [k, v] of Object.entries(f))
      if (typeof v === "number") values.set(k, [...(values.get(k) ?? []), v]);
  const out = new Map<string, Scale>();
  for (const [k, xs] of values) {
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
    if (sd > 0) out.set(k, { mean, sd });
  }
  return out;
}

/**
 * Spec 1.2 §6.3: the z-scored Euclidean distance over the features both have, as a root mean square so pairs
 * sharing different numbers of features compare (plan 14 Ruling 6); a word counts 0 when equal, else 1. Null
 * when they share fewer than MIN_SHARED_FEATURES.
 */
function distance(a: Features, b: Features, z: Map<string, Scale>): { d: number; shared: string[] } | null {
  const shared: string[] = [];
  let sum = 0;
  for (const [k, va] of Object.entries(a)) {
    const vb = b[k];
    if (vb === undefined) continue;
    if (typeof va === "string" || typeof vb === "string") {
      shared.push(k);
      sum += va === vb ? 0 : 1;
      continue;
    }
    const s = z.get(k);
    if (!s) continue;
    shared.push(k);
    sum += ((va - vb) / s.sd) ** 2;
  }
  if (shared.length < MIN_SHARED_FEATURES) return null;
  return { d: Math.sqrt(sum / shared.length), shared };
}

/** The dimensions the bars use that `canonical` has no value for, of its own or through a treat-like. */
export function missingDims(c: Catalog, canonical: string, dims: readonly Dim[] = barDimsIn(c)): Dim[] {
  const own = c.scores[canonical] ?? {};
  const like = c.treatLike[canonical]?.like;
  const lent = like ? (c.scores[like] ?? {}) : {};
  return dims.filter((d) => !own[d] && !lent[d]);
}

/**
 * Every dimension some bar of the catalog (the defaults, with the user's override) has a threshold on: the
 * dimensions a stand-in fills. No shipped bar uses `steer`, so it is never inferred by default; a user's steer
 * bar makes it one (plan 14 Ruling 7, as the code has always read it; spec 1.5 plan 24 aligns the words).
 */
export function barDimsIn(c: Catalog): Dim[] {
  const used = new Set<string>();
  for (const kind of Object.values(c.bars))
    for (const bar of Object.values(kind))
      for (const [d, min] of Object.entries(bar)) if (min !== undefined) used.add(d);
  return DIMS.filter((d) => used.has(d));
}

class Ranker {
  private readonly all = new Map<string, Features>();
  private readonly z: Map<string, Scale>;
  constructor(private readonly c: Catalog) {
    for (const r of canonicalRungs(c)) this.all.set(r, featuresOf(c, r));
    this.z = scales([...this.all.values()]);
  }
  /**
   * The rungs with an own value on any of `dims` (and on at least MIN_STANDIN_DIMS dimensions in all), nearest
   * first; each with what it would lend.
   */
  rank(canonical: string, dims: readonly Dim[]): Suggestion[] {
    const mine = this.all.get(canonical) ?? featuresOf(this.c, canonical);
    const out: Suggestion[] = [];
    for (const [other, f] of this.all) {
      if (other === canonical) continue;
      const own = ownValues(this.c, other);
      if (Object.keys(own).length < MIN_STANDIN_DIMS) continue;
      const lends = dims.filter((d) => own[d] !== undefined);
      if (lends.length === 0) continue;
      const got = distance(mine, f, this.z);
      if (got) out.push({ like: other, distance: Number(got.d.toFixed(4)), features: got.shared, lends });
    }
    return out.sort((a, b) => a.distance - b.distance || a.like.localeCompare(b.like));
  }
}

/**
 * Spec 1.2 §6.4 `treat-like --suggest`: the `limit` nearest rungs that would lend `canonical` a value it lacks
 * on a dimension the bars use (any scored rung when it lacks none), with their distance and features.
 */
export function suggestStandIns(c: Catalog, canonical: string, limit = 3): Suggestion[] {
  const lacking = missingDims(c, canonical);
  return new Ranker(c).rank(canonical, lacking.length ? lacking : DIMS).slice(0, limit);
}

/**
 * Spec 1.5 plan 24: the same effort of the family's predecessor (`Family.predecessor`), when it has a value on
 * `d` of its own; null otherwise.
 */
function predecessorOf(c: Catalog, canonical: string, d: Dim): { like: string; value: number } | null {
  const pred = family(c, canonical)?.predecessor;
  if (!pred) return null;
  const like = `${pred}${canonical.slice(canonical.lastIndexOf("#"))}`;
  const s = c.scores[like]?.[d];
  return s ? { like, value: s.value } : null;
}

/**
 * Spec 1.2 §6.1: for every rung the catalog can name, per dimension the bars use that it has no value for
 * (of its own or through a treat-like), its nearest stand-in with a value there. A rung no rung is near
 * enough to (fewer than MIN_SHARED_FEATURES shared) gets none on that dimension. Spec 1.5 plan 24: a new
 * release of a family line takes at least its predecessor's value at the same effort, so a guess never puts it
 * below the model it replaces (the identity run's GPT-6.1 Sol at 37.2, under GPT-6 Luna).
 */
export function inferStandIns(c: Catalog): Catalog["inferred"] {
  const dims = barDimsIn(c);
  const ranker = new Ranker(c);
  const out: Catalog["inferred"] = {};
  for (const canonical of canonicalRungs(c)) {
    const lacking = missingDims(c, canonical, dims);
    for (const d of lacking) {
      const best = ranker.rank(canonical, [d])[0];
      const pred = predecessorOf(c, canonical, d);
      const nearest = best ? c.scores[best.like]?.[d]?.value : undefined;
      let entry: InferredStandIn | null = best
        ? { like: best.like, distance: best.distance, features: best.features }
        : null;
      if (pred && (nearest === undefined || pred.value >= nearest))
        entry = { like: pred.like, distance: 0, features: ["predecessor"] };
      if (entry) (out[canonical] ??= {})[d] = entry;
    }
  }
  return out;
}

/** The catalog with its inferred stand-ins filled in: what routing, validation and the surfaces read. */
export function withStandIns(c: Catalog): Catalog {
  return { ...c, inferred: inferStandIns(c) };
}

/** Whether `canonical` leans on an inferred stand-in for any value (`scoresOf`'s `inferred`). */
export const leansOnStandIn = (c: Catalog, canonical: string): boolean =>
  (scoresOf(c, canonical)?.inferred.length ?? 0) > 0;
