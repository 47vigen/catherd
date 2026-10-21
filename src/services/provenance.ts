import { barOf, BAR_PERCENTILE } from "../domain/bars.ts";
import { type Catalog, type Pair, rungInfo } from "../domain/catalog.ts";
import { type BillingMode, type Cost, costOf, DEFAULT_BILLING } from "../domain/cost.ts";
import type { Difficulty, Kind } from "../domain/lane.ts";
import { type EvidenceTable, evidenceLine, evidenceOf } from "./run-evidence.ts";

/** What `route` reports about the rung it chose: the one number it ranked on, the bar, and what it costs. */
export interface Provenance {
  rung: string;
  canonical: string;
  /** the rung's Slopalytics intelligence index; null when it is not indexed */
  intelligence: number | null;
  /** the difficulty's bar, with the percentile it sits at; null when the route read no bar (the default rung) */
  bar: { difficulty: Difficulty; percentile: number; min: number; clears: boolean } | null;
  price: Pair["price"];
  /** tokens per second; null when Slopalytics has none */
  speed: number | null;
  cost: Cost;
  /** when the proxy fetched the index the route read; null with no index */
  indexedAt: string | null;
  /** spec 1.2 §8: its runs for the lane's kind (or every kind) and over every kind; null when they could not be read */
  evidence: { kind: string | null; all: string | null } | null;
}

/** The chosen rung's intelligence, the difficulty's bar and whether it clears it, its price, speed and cost. */
export function provenanceOf(
  c: Catalog,
  rung: string,
  kind: Kind | null,
  difficulty: Difficulty | null,
  billing: Partial<Record<string, BillingMode>>,
  evidence: EvidenceTable | null,
): Provenance {
  const info = rungInfo(c, rung);
  const intelligence = info.pair?.intelligence ?? null;
  const min = difficulty ? barOf(c, difficulty) : null;
  return {
    rung,
    canonical: info.canonical,
    intelligence,
    bar:
      difficulty && min !== null
        ? {
            difficulty,
            percentile: BAR_PERCENTILE[difficulty],
            min,
            clears: intelligence !== null && intelligence >= min,
          }
        : null,
    price: info.pair?.price ?? null,
    speed: info.pair?.speed ?? null,
    cost: costOf(info.family, info.pair, info.parsed.effort, billing[info.key] ?? DEFAULT_BILLING[info.key]),
    indexedAt: c.indexedAt,
    evidence: evidence && {
      kind: evidenceLine(evidenceOf(evidence, info.canonical, kind)),
      all: evidenceLine(evidenceOf(evidence, info.canonical)),
    },
  };
}
