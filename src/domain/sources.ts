import { z } from "zod";
import type { Family } from "./catalog.ts";

/** Spec 1.2 §3.1: the sources `catherd catalog sync` reads, one cache file each in `<data>/sources/`. */
export const SOURCE_IDS = [
  "models-dev",
  "openrouter-models",
  "openrouter-endpoints",
  "litellm",
  "arena",
  "vectara",
  "epoch",
  "artificial-analysis",
] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

/** `catalog/sources.json`: each source with its license and attribution line, the id aliases, default efforts. */
export const SourcesFileSchema = z.looseObject({
  schema: z.literal(1),
  version: z.string(),
  sources: z.array(
    z.object({
      id: z.enum(SOURCE_IDS),
      name: z.string(),
      url: z.url(),
      license: z.string(),
      attribution: z.string(),
      keyed: z.boolean(),
    }),
  ),
  /** a source's irregular model id → the catalog's id (spec 1.2 §3.4) */
  aliases: z.record(z.string(), z.string()),
  /** family id → the effort a source that names none means; a family not listed means `high` */
  defaultEffort: z.record(z.string(), z.string()),
});
export type SourcesFile = z.infer<typeof SourcesFileSchema>;

/** Effort words as catherd writes them, weakest first; a source's spelling (`xHigh`, `MAX`) is folded onto these. */
export const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** `s` as a catherd effort word (`xHigh` → `xhigh`), or null when it is not one. */
export function effortWord(s: string): string | null {
  const w = s.trim().toLowerCase();
  return (EFFORT_ORDER as readonly string[]).includes(w) ? w : null;
}

/**
 * Spec 1.2 §3.4: a source's model id in catherd's form: without a `vendor/` prefix, lower case, and each run
 * of dots and blanks as one `-` (`openai/gpt-5.6-sol` and `GPT 5.6 Sol` → `gpt-5-6-sol`).
 */
export function normalizeId(id: string): string {
  return id
    .slice(id.lastIndexOf("/") + 1)
    .trim()
    .toLowerCase()
    .replace(/[\s.]+/g, "-")
    .replace(/-+/g, "-");
}

/** A parser's `rung`: `<source's model id>#<effort>`, or the bare id when the source names no effort. */
export function splitSourceRung(rung: string): { id: string; effort: string | null } {
  const hash = rung.lastIndexOf("#");
  return hash < 0 ? { id: rung, effort: null } : { id: rung.slice(0, hash), effort: rung.slice(hash + 1) };
}

export interface IdMapper {
  /** the id pairs are keyed by: normalized, then through the alias table */
  key(id: string): string;
  /** the catalog family a source id names, directly, by a backend's own id or through an alias; never guessed */
  family(id: string): Family | null;
}

/** Spec 1.2 §3.4: matches a source's ids to the catalog's families. */
export function idMapper(families: Family[], aliases: Record<string, string>): IdMapper {
  const alias = new Map(Object.entries(aliases).map(([from, to]) => [normalizeId(from), normalizeId(to)]));
  const byKey = new Map<string, Family>();
  for (const f of families) {
    for (const on of Object.values(f.on)) if (on) byKey.set(normalizeId(on.id), f);
    byKey.set(normalizeId(f.id), f);
  }
  const key = (id: string) => {
    const n = normalizeId(id);
    return alias.get(n) ?? n;
  };
  return { key, family: (id) => byKey.get(key(id)) ?? null };
}

/** Spec 1.2 §3.4: the effort a source that names none means for `family`. */
export const defaultEffortOf = (sources: SourcesFile, family: Family): string =>
  sources.defaultEffort[family.id] ?? "high";

const order = (e: string) => (EFFORT_ORDER as readonly string[]).indexOf(e);

/** Every effort the family offers on any backend, weakest first (spec 1.2 §4.3 `adjacent`). */
export function familyEfforts(f: Family): string[] {
  const all = new Set<string>();
  for (const on of Object.values(f.on)) for (const e of on?.efforts ?? []) all.add(e);
  return [...all].filter((e) => order(e) >= 0).sort((a, b) => order(a) - order(b));
}

/** The effort of `have` nearest `target` (the weaker one on a tie); null when `have` holds no effort word. */
export function nearestEffort(target: string, have: string[]): string | null {
  const t = order(target);
  let best: string | null = null;
  for (const e of have) {
    const i = order(e);
    if (i < 0 || t < 0) continue;
    const b = best === null ? Number.POSITIVE_INFINITY : Math.abs(order(best) - t);
    if (Math.abs(i - t) < b || (Math.abs(i - t) === b && i < order(best as string))) best = e;
  }
  return best;
}
