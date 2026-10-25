import { billingKeyOf, type Catalog, pairOf, rungInfo, successorOf } from "./catalog.ts";
import { type BillingMode, compareCost, type Cost, costOf, DEFAULT_BILLING } from "./cost.ts";
import { type Rung, tryParseRung } from "./ids.ts";

/**
 * Spec §7.1 and §4.5: a stand-in on the same quota would be out of quota too. The billing key names the
 * quota, except that the native `claude` path and headless `claude-code` both draw on the Claude plan.
 */
export const quotaOf = (r: Rung): string => (billingKeyOf(r) === "claude" ? "claude-code" : billingKeyOf(r));

/** Whether a rung draws on the Claude plan (native `claude:` or headless `claude-code:`). */
export function claudeBilled(rung: string): boolean {
  const r = tryParseRung(rung);
  return r !== null && quotaOf(r) === "claude-code";
}

/** A rung's intelligence index; null when it is not a rung or not indexed. */
export const intelligenceOf = (c: Catalog, rung: string): number | null =>
  pairOf(c, rung)?.intelligence ?? null;

/** Spec 1.1 §11: `standIn` is a downgrade when the rung is indexed and the stand-in is not, or is less intelligent. */
export function downgrade(c: Catalog, rung: string, standIn: string): boolean {
  const a = intelligenceOf(c, rung);
  const b = intelligenceOf(c, standIn);
  return a !== null && (b === null || b < a);
}

/** Spec 1.1 §11 "the ladder goes down": the later rung (`upper`) is less intelligent than `lower`. */
export function ladderDrop(c: Catalog, lower: string, upper: string): boolean {
  const a = intelligenceOf(c, lower);
  const b = intelligenceOf(c, upper);
  return a !== null && b !== null && b < a;
}

const costFor = (c: Catalog, billing: Partial<Record<string, BillingMode>>, rung: string): Cost => {
  const info = rungInfo(c, rung);
  return costOf(info.family, info.pair, info.parsed.effort, billing[info.key] ?? DEFAULT_BILLING[info.key]);
};

/**
 * Spec 1.1 §11: the rungs of `pool` that can stand in for `rung`, best first. A stand-in is on another
 * quota, indexed, paid from a plan or subscription under `billing` (a metered one spends money nobody chose
 * to), startable by `dispatch` (not a native `claude:` subagent), and never less intelligent than the rung
 * (a rung with no index of its own keeps every stand-in). Claude-billed stand-ins rank last, then the
 * nearest intelligence above the rung's own, then the cheapest.
 */
export function rankStandIns(
  c: Catalog,
  billing: Partial<Record<string, BillingMode>>,
  rung: string,
  pool: readonly string[],
): string[] {
  const from = tryParseRung(rung);
  if (!from) return [];
  const own = intelligenceOf(c, rung);
  const fits = [...new Set(pool)].filter((x) => {
    const r = tryParseRung(x);
    const i = r ? intelligenceOf(c, x) : null;
    if (!r || r.backend === "claude" || quotaOf(r) === quotaOf(from) || i === null) return false;
    if (costFor(c, billing, x).tier === 1) return false;
    return own === null || i >= own;
  });
  const gap = (x: string) => (own === null ? 0 : (intelligenceOf(c, x) as number) - own);
  return fits.sort(
    (a, b) =>
      Number(claudeBilled(a)) - Number(claudeBilled(b)) ||
      gap(a) - gap(b) ||
      compareCost(costFor(c, billing, a), costFor(c, billing, b)) ||
      a.localeCompare(b),
  );
}

/** How a family's `on` key maps to the backend that runs it. */
const BACKEND_OF_KEY: Record<string, string> = { "opencode-go": "opencode" };

/**
 * Every indexed rung catherd can name: each shipped family's model on each backend at each effort the index
 * (or the backend's listing) gives it, and each listed model at each listed effort. Sorted, without duplicates.
 * A model a newer version replaces on its backend is left out: no stand-in is picked from an older version.
 */
export function catalogPairs(c: Catalog): string[] {
  const out = new Set<string>();
  const add = (backend: string, model: string, efforts: readonly string[]) => {
    if (successorOf(c, `${backend}:${model}#default`)) return;
    for (const e of [...efforts, "default"]) {
      const rung = `${backend}:${model}#${e}`;
      if (pairOf(c, rung)) out.add(rung);
    }
  };
  for (const f of c.families)
    for (const [key, m] of Object.entries(f.on)) {
      if (!m) continue;
      const backend = BACKEND_OF_KEY[key] ?? key;
      add(backend, m.id, rungInfo(c, `${backend}:${m.id}#default`).efforts);
    }
  for (const [backend, l] of Object.entries(c.listed))
    for (const m of l.models) add(backend, m.id, m.efforts);
  return [...out].sort();
}
