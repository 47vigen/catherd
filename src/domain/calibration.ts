import type { Dim } from "./catalog.ts";
import type { SourceId } from "./sources.ts";

/** Spec 1.2 §4.2: a source needs this many rungs shared with the anchor for a dimension. */
export const MIN_SHARED = 5;
/** Spec 1.2 §4.2: a fit below this R² is not used. */
export const MIN_R2 = 0.5;

/** One number a source parser returns: `field` of `source`, and the benchmark it names. */
export interface FieldRef {
  source: SourceId;
  field: string;
  benchmark: string;
}

/**
 * Spec 1.2 §4.1: each dimension's anchor, the unit its bars are in, and the sources calibrated onto it.
 * `shipped` is the hand-typed value `catalog/scores.json` carries, published for that rung (every anchor is
 * keyless, spec 1.2 §4.1).
 */
export const DIM_SOURCES: Record<Dim, { anchor: FieldRef | "shipped"; others: FieldRef[] }> = {
  repo_code: {
    anchor: "shipped",
    others: [
      {
        source: "artificial-analysis",
        field: "livecodebench",
        benchmark: "LiveCodeBench (Artificial Analysis)",
      },
      { source: "artificial-analysis", field: "scicode", benchmark: "SciCode (Artificial Analysis)" },
      {
        source: "artificial-analysis",
        field: "artificial_analysis_coding_index",
        benchmark: "Artificial Analysis Coding Index",
      },
      { source: "epoch", field: "frontiercode", benchmark: "FrontierCode (Epoch AI)" },
    ],
  },
  // plan 14 Ruling C-2: the vendors' Terminal-Bench 4.0 values, not Epoch's Terminal-Bench 2.0, which shares
  // no rung with them; Epoch is fitted onto them once it covers five of their rungs
  terminal: {
    anchor: "shipped",
    others: [
      { source: "epoch", field: "terminalbench", benchmark: "Terminal-Bench (Epoch AI)" },
      {
        source: "artificial-analysis",
        field: "terminalbench_v2_1",
        benchmark: "Terminal-Bench 2.1 (Artificial Analysis)",
      },
    ],
  },
  honesty: {
    anchor: "shipped",
    others: [
      { source: "vectara", field: "factual_consistency", benchmark: "Vectara factual consistency rate" },
      { source: "arena", field: "agent_tool_hallucination", benchmark: "Arena agent tool hallucination" },
    ],
  },
  agentic: {
    anchor: { source: "arena", field: "agent", benchmark: "Arena agent, net improvement" },
    others: [
      { source: "arena", field: "agent_task_outcome_explicit", benchmark: "Arena agent task outcome" },
      { source: "arena", field: "agent_bash_recovery_steps", benchmark: "Arena agent bash recovery" },
      { source: "artificial-analysis", field: "tau2", benchmark: "tau2-bench (Artificial Analysis)" },
    ],
  },
  steer: {
    anchor: { source: "arena", field: "agent_steerability", benchmark: "Arena agent steerability" },
    others: [],
  },
  frontend: {
    anchor: { source: "arena", field: "webdev", benchmark: "Arena WebDev rating" },
    others: [{ source: "epoch", field: "webdev", benchmark: "WebDev Arena (Epoch AI)" }],
  },
};

export interface LineFit {
  a: number;
  b: number;
  r2: number;
  n: number;
}

/** Least squares `anchor = a·x + b` over `[x, anchor]` pairs; null with fewer than 2 pairs or no spread in x. */
export function fitLine(pairs: readonly (readonly [number, number])[]): LineFit | null {
  const n = pairs.length;
  if (n < 2) return null;
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
    syy += (y - my) ** 2;
  }
  if (sxx === 0) return null;
  const a = sxy / sxx;
  const b = my - a * mx;
  const res = pairs.reduce((s, [x, y]) => s + (y - (a * x + b)) ** 2, 0);
  return { a, b, r2: syy === 0 ? 0 : 1 - res / syy, n };
}

/**
 * Spec 1.2 §4.2: the fit of `other` onto `anchor` over the keys both hold, and whether it may be used: at
 * least MIN_SHARED shared rungs and an R² of at least MIN_R2. `why` says why not.
 */
export function calibrate(
  anchor: ReadonlyMap<string, number>,
  other: ReadonlyMap<string, number>,
): { fit: LineFit | null; n: number; used: boolean; why?: string } {
  const pairs: [number, number][] = [];
  for (const [k, x] of other) {
    const y = anchor.get(k);
    if (y !== undefined) pairs.push([x, y]);
  }
  const n = pairs.length;
  if (n < MIN_SHARED)
    return { fit: null, n, used: false, why: `${n} shared rungs; a fit needs ${MIN_SHARED}` };
  const fit = fitLine(pairs);
  if (!fit) return { fit: null, n, used: false, why: "the source gives every shared rung the same value" };
  if (fit.r2 < MIN_R2) return { fit, n, used: false, why: `R² ${fit.r2.toFixed(2)} is below ${MIN_R2}` };
  return { fit, n, used: true };
}
