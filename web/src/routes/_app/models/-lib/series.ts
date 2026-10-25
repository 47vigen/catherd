import type { CatalogEntry } from "../../../../client";
import { type Brand, brandOf } from "../../../../lib/brand";
import { modelName } from "../../../../lib/model-name";

export interface Series {
  id: string;
  name: string;
  brand: Brand;
  dash: string;
  points: { effort: string; usd: number; intelligence: number; measured: boolean }[];
}

/** Lines of one lab differ by dash, in list order. */
const DASHES = ["", "6 3", "2 3", "8 3 2 3"];

export const brandOfModel = (m: CatalogEntry): Brand => brandOf(m.lab ?? m.id);
export const nameOfModel = (m: CatalogEntry): string => m.name ?? modelName(m.id);

/** One line per shown model; a point with no cost (or a cost ≤ 0 on the log axis) is left out and counted. */
export function seriesOf(
  models: CatalogEntry[],
  hidden: ReadonlySet<string>,
  scale: "log" | "linear",
): { series: Series[]; dropped: number } {
  const seen = new Map<Brand, number>();
  const series: Series[] = [];
  let dropped = 0;
  for (const m of models) {
    const brand = brandOfModel(m);
    const n = seen.get(brand) ?? 0;
    seen.set(brand, n + 1);
    if (hidden.has(m.id)) continue;
    const points: Series["points"] = [];
    for (const p of m.points) {
      if (p.usd === null || (scale === "log" && p.usd <= 0)) dropped++;
      else points.push({ effort: p.effort, usd: p.usd, intelligence: p.intelligence, measured: p.measured });
    }
    if (points.length > 0)
      series.push({ id: m.id, name: nameOfModel(m), brand, dash: DASHES[n % DASHES.length]!, points });
  }
  return { series, dropped };
}

/** Powers of ten covering [min, max]. */
export function logTicks(min: number, max: number): number[] {
  const lo = Math.floor(Math.log10(min));
  const hi = Math.max(Math.ceil(Math.log10(max)), lo + 1);
  return Array.from({ length: hi - lo + 1 }, (_, i) => 10 ** (lo + i));
}
