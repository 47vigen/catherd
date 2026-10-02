import { type Catalog, type Confidence, DIMS, type Dim, rungInfo, scoresOf } from "../domain/catalog.ts";
import { type BillingMode, type Cost, costOf, DEFAULT_BILLING } from "../domain/cost.ts";
import type { Difficulty, Kind } from "../domain/lane.ts";
import { type EvidenceTable, evidenceLine, evidenceOf } from "./run-evidence.ts";

/** Spec 1.2 §5.3: one value routing uses for a rung, with where it came from. */
export interface ValueUsed {
  dim: Dim;
  value: number;
  confidence: Confidence;
  /** the source a synced value came from; `shipped` for a hand-typed one, `override` for the user's */
  source: string;
  benchmark: string;
  date: string;
  url: string;
  /** catherd's guess for this rung: lent by a treat-like or an inferred stand-in (spec 1.2 §6.1) */
  inferred: boolean;
  /** the rung the value belongs to, when it is not this one */
  from: string | null;
}

/** Spec 1.2 §5.3: one threshold of the lane's bar, the value used against it, and whether it clears. */
export interface Threshold {
  dim: Dim;
  min: number;
  used: ValueUsed | null;
  clears: boolean;
  /** where the default threshold came from (`barsWhy`) */
  why: string | null;
}

/** Spec 1.2 §5.3, §8: what `route` reports about the rung it chose. */
export interface Provenance {
  rung: string;
  canonical: string;
  /** the lane's bar, threshold by threshold; empty when the route read no bar (the default rung) */
  thresholds: Threshold[];
  /** every value the rung has */
  values: ValueUsed[];
  /** facts that never carry a bar (spec 1.2 §4.1): `<source>.<field>` → value */
  speed: Record<string, number>;
  cost: Cost;
  /**
   * spec 1.2 §8: its runs for the lane's kind (or every kind) and over every kind; never used for routing;
   * null when the runs could not be read
   */
  evidence: { kind: string | null; all: string | null } | null;
}

/** Spec 1.2 §5.3: each value a canonical rung has, with its confidence and source, borrowed ones marked. */
export function valuesUsed(c: Catalog, canonical: string): ValueUsed[] {
  const s = scoresOf(c, canonical);
  if (!s) return [];
  return DIMS.flatMap((dim) => {
    const r = s.records[dim];
    if (!r) return [];
    const from = s.borrowed.includes(dim) ? s.via : (s.standIns[dim] ?? null);
    return [
      {
        dim,
        value: r.value,
        confidence: r.confidence,
        source: r.source ?? "shipped",
        benchmark: `${r.benchmark} ${r.version}`,
        date: r.date,
        url: r.url,
        inferred: from !== null,
        from,
      },
    ];
  });
}

/** Spec 1.2 §5.3: the chosen rung's thresholds for the lane's kind and difficulty, its values and facts. */
export function provenanceOf(
  c: Catalog,
  rung: string,
  kind: Kind | null,
  difficulty: Difficulty | null,
  billing: Partial<Record<string, BillingMode>>,
  evidence: EvidenceTable | null,
): Provenance {
  const info = rungInfo(c, rung);
  const values = valuesUsed(c, info.canonical);
  const bar = kind && difficulty ? c.bars[kind][difficulty] : {};
  const thresholds: Threshold[] = DIMS.flatMap((dim) => {
    const min = bar[dim];
    if (min === undefined || !kind || !difficulty) return [];
    const used = values.find((v) => v.dim === dim) ?? null;
    return [
      {
        dim,
        min,
        used,
        clears: used !== null && used.value >= min,
        // a threshold the user's override set is theirs, whatever the default's why says (1.2 minor)
        why: c.userBars?.includes(`${kind}/${difficulty}/${dim}`)
          ? "your override"
          : (c.barsWhy[dim]?.[difficulty] ?? null),
      },
    ];
  });
  return {
    rung,
    canonical: info.canonical,
    thresholds,
    values,
    speed: info.family?.speed ?? {},
    cost: costOf(info.family, info.parsed.effort, billing[info.key] ?? DEFAULT_BILLING[info.key]),
    evidence: evidence && {
      kind: evidenceLine(evidenceOf(evidence, info.canonical, kind)),
      all: evidenceLine(evidenceOf(evidence, info.canonical)),
    },
  };
}
