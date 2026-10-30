import type { CatalogEntry } from "../../../../client";
import { type Brand, brandOf, brandShade, type Shade } from "../../../../lib/brand";
import { modelName } from "../../../../lib/model-name";

export interface Series {
  id: string;
  name: string;
  brand: Brand;
  /** the line's colour: its lab's brand, deeper for the lab's stronger models */
  color: string;
  points: { effort: string; usd: number; intelligence: number; measured: boolean }[];
}

export const brandOfModel = (m: CatalogEntry): Brand => brandOf(m.lab ?? m.id);
export const nameOfModel = (m: CatalogEntry): string => m.name ?? modelName(m.id);

/** A model's best score over its efforts. */
export const peak = (m: CatalogEntry) => Math.max(0, ...m.points.map((p) => p.intelligence));

/**
 * Each model's palette step within its lab: the lab's strongest current model (by its best score) is 900, its
 * weakest 100, the rest spread evenly between, so a lab's lines sit as far apart as the palette allows. A model a
 * newer version replaces is off by default and takes the faintest step, 100, instead of a step a current model
 * needs. Every model counts, shown or not, so switching one recolours nothing.
 */
export function shadesOf(models: CatalogEntry[]): Map<string, Shade> {
  const byLab = new Map<Brand, CatalogEntry[]>();
  for (const m of models) if (!m.superseded) byLab.set(brandOfModel(m), [...(byLab.get(brandOfModel(m)) ?? []), m]);
  const out = new Map<string, Shade>(models.filter((m) => m.superseded).map((m) => [m.id, 100]));
  for (const lab of byLab.values()) {
    const ranked = lab.toSorted((a, b) => peak(b) - peak(a));
    ranked.forEach((m, i) => {
      const t = ranked.length === 1 ? 0 : i / (ranked.length - 1);
      out.set(m.id, (Math.round((900 - 800 * t) / 100) * 100) as Shade);
    });
  }
  return out;
}

/** One line per shown model; a point with no cost (or a cost ≤ 0 on the log axis) is left out and counted. */
export function seriesOf(
  models: CatalogEntry[],
  hidden: ReadonlySet<string>,
  scale: "log" | "linear",
): { series: Series[]; dropped: number } {
  const shades = shadesOf(models);
  const series: Series[] = [];
  let dropped = 0;
  for (const m of models) {
    const brand = brandOfModel(m);
    if (hidden.has(m.id)) continue;
    const points: Series["points"] = [];
    for (const p of m.points) {
      if (p.usd === null || (scale === "log" && p.usd <= 0)) dropped++;
      else points.push({ effort: p.effort, usd: p.usd, intelligence: p.intelligence, measured: p.measured });
    }
    if (points.length > 0)
      series.push({ id: m.id, name: nameOfModel(m), brand, color: brandShade(brand, shades.get(m.id)!), points });
  }
  return { series, dropped };
}

/** Powers of ten covering [min, max]. */
export function logTicks(min: number, max: number): number[] {
  const lo = Math.floor(Math.log10(min));
  const hi = Math.max(Math.ceil(Math.log10(max)), lo + 1);
  return Array.from({ length: hi - lo + 1 }, (_, i) => 10 ** (lo + i));
}

export interface FrontierPoint {
  usd: number;
  intelligence: number;
  model: string;
  effort: string;
}

/** The points nothing beats on both counts: no other point is as smart for less money. Cheapest first. */
export function frontierOf(series: Series[]): FrontierPoint[] {
  const all = series
    .flatMap((s) =>
      s.points.map((p) => ({ usd: p.usd, intelligence: p.intelligence, model: s.name, effort: p.effort })),
    )
    .sort((a, b) => a.usd - b.usd || b.intelligence - a.intelligence);
  const out: FrontierPoint[] = [];
  for (const p of all) if (p.intelligence > (out.at(-1)?.intelligence ?? -Infinity)) out.push(p);
  return out;
}

/** The current models' strongest point, and the cheapest point within `share` of it: the one worth the money. */
export function standouts(models: CatalogEntry[], share = 0.9) {
  const points = models
    .filter((m) => !m.superseded)
    .flatMap((m) => m.points.map((p) => ({ model: nameOfModel(m), ...p })));
  const top = points.toSorted((a, b) => b.intelligence - a.intelligence)[0];
  const value = top
    ? points
        .filter((p) => p.usd !== null && p.intelligence >= top.intelligence * share)
        .toSorted((a, b) => a.usd! - b.usd!)[0]
    : undefined;
  return { top, value };
}

/** The efforts the catalog uses, in their natural order. */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "default"] as const;
export const effortsOf = (models: CatalogEntry[]) => {
  const used = new Set(models.flatMap((m) => m.points.map((p) => p.effort)));
  return [
    ...EFFORTS.filter((e) => used.has(e)),
    ...[...used].filter((e) => !(EFFORTS as readonly string[]).includes(e)),
  ];
};
