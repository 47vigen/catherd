import { billingKeyOf, type Catalog, DIMS, type Dim, rungInfo, scoresOf } from "./catalog.ts";
import { type BillingMode, compareCost, type Cost, costOf, DEFAULT_BILLING } from "./cost.ts";
import { type Rung, tryParseRung } from "./ids.ts";
import { DIFFICULTIES, KINDS } from "./lane.ts";

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

/** A rung's scores by dim, its own or borrowed through a treat-like; null when unscored or not a rung. */
function valuesOf(c: Catalog, rung: string): Partial<Record<Dim, number>> | null {
  try {
    return scoresOf(c, rungInfo(c, rung).canonical)?.values ?? null;
  } catch {
    return null;
  }
}

/** The dims used by the routing bars (kind × difficulty) the rung clears: what makes it fit its lanes. */
export function barDims(c: Catalog, rung: string): Dim[] {
  const v = valuesOf(c, rung);
  if (!v) return [];
  const used = new Set<Dim>();
  for (const kind of KINDS)
    for (const d of DIFFICULTIES) {
      const bar = Object.entries(c.bars[kind][d]).filter(([, min]) => min !== undefined) as [Dim, number][];
      if (bar.every(([dim, min]) => (v[dim] ?? Number.NEGATIVE_INFINITY) >= min))
        for (const [dim] of bar) used.add(dim);
    }
  return DIMS.filter((d) => used.has(d));
}

/**
 * Spec 1.1 §11: the dims, among those the rung's bars use, on which `standIn` scores below `rung` (a
 * missing score counts as below). Empty means the stand-in clears every bar the rung clears, at least as
 * well: no downgrade.
 */
export function downgradeDims(c: Catalog, rung: string, standIn: string): Dim[] {
  const a = valuesOf(c, rung);
  if (!a) return [];
  const b = valuesOf(c, standIn) ?? {};
  return barDims(c, rung).filter((d) => (b[d] ?? Number.NEGATIVE_INFINITY) < (a[d] as number));
}

const costFor = (c: Catalog, billing: Partial<Record<string, BillingMode>>, rung: string): Cost => {
  const info = rungInfo(c, rung);
  return costOf(info.family, info.parsed.effort, billing[info.key] ?? DEFAULT_BILLING[info.key]);
};

/**
 * Spec 1.1 §11: the rungs of `pool` that can stand in for `rung`, best first. A stand-in is on another
 * quota, scored, paid from a plan or subscription under `billing` (a metered one spends money nobody chose
 * to), startable by `dispatch` (not a native `claude:` subagent), and no downgrade on the rung's bar dims.
 * Claude-billed stand-ins rank last, then the cheapest first.
 */
export function rankStandIns(
  c: Catalog,
  billing: Partial<Record<string, BillingMode>>,
  rung: string,
  pool: readonly string[],
): string[] {
  const from = tryParseRung(rung);
  if (!from) return [];
  const fits = [...new Set(pool)].filter((x) => {
    const r = tryParseRung(x);
    if (!r || r.backend === "claude" || quotaOf(r) === quotaOf(from) || !valuesOf(c, x)) return false;
    if (costFor(c, billing, x).tier === 1) return false;
    return downgradeDims(c, rung, x).length === 0;
  });
  return fits.sort(
    (a, b) =>
      Number(claudeBilled(a)) - Number(claudeBilled(b)) ||
      compareCost(costFor(c, billing, a), costFor(c, billing, b)) ||
      a.localeCompare(b),
  );
}

/** How a family's `on` key or a model id's prefix maps to the backend that runs it. */
const BACKEND_OF_KEY: Record<string, string> = { "opencode-go": "opencode" };

/**
 * Every rung the catalog knows how to name: each shipped family's model on each backend at each effort,
 * each listed model at each effort, and each treat-like whose model is an opencode id (`opencode-go/…`,
 * `opencode/…`), such as the shipped Kimi K3 stand-in. Sorted, without duplicates.
 */
export function catalogRungs(c: Catalog): string[] {
  const out = new Set<string>();
  for (const f of c.families)
    for (const [key, m] of Object.entries(f.on)) {
      if (!m) continue;
      for (const e of m.efforts) out.add(`${BACKEND_OF_KEY[key] ?? key}:${m.id}#${e}`);
    }
  for (const [backend, l] of Object.entries(c.listed))
    for (const m of l.models) for (const e of m.efforts) out.add(`${backend}:${m.id}#${e}`);
  for (const canonical of Object.keys(c.treatLike))
    if (/^opencode(-go)?\//.test(canonical)) out.add(`opencode:${canonical}`);
  return [...out].sort();
}
