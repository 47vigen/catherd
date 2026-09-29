import { billingKeyOf, type Catalog, DIMS, type Dim, rungInfo, scoresOf } from "./catalog.ts";
import { type BillingMode, compareCost, type Cost, costOf, DEFAULT_BILLING } from "./cost.ts";
import { type Rung, tryParseRung } from "./ids.ts";
import { DIFFICULTIES, KINDS } from "./lane.ts";
import { EFFORT_ORDER } from "./sources.ts";

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
export function valuesOf(c: Catalog, rung: string): Partial<Record<Dim, number>> | null {
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

/**
 * Spec 1.1 §11 "the ladder goes down": the dims both rungs are scored on where `upper` (the later rung)
 * scores below `lower`, when it scores above it on none of them. Empty when it does not go down.
 */
export function ladderDropDims(c: Catalog, lower: string, upper: string): Dim[] {
  const a = valuesOf(c, lower);
  const b = valuesOf(c, upper);
  if (!a || !b) return [];
  const shared = DIMS.filter((d) => a[d] !== undefined && b[d] !== undefined);
  if (shared.some((d) => (b[d] as number) > (a[d] as number))) return [];
  return shared.filter((d) => (b[d] as number) < (a[d] as number));
}

const costFor = (c: Catalog, billing: Partial<Record<string, BillingMode>>, rung: string): Cost => {
  const info = rungInfo(c, rung);
  return costOf(info.family, info.parsed.effort, billing[info.key] ?? DEFAULT_BILLING[info.key]);
};

/**
 * Spec 1.1 §11: the rungs of `pool` that can stand in for `rung`, best first. A stand-in is on another
 * quota, scored, paid from a plan or subscription under `billing` (a metered one spends money nobody chose
 * to), startable by `dispatch` (not a native `claude:` subagent), and no downgrade on the rung's bar dims.
 * Claude-billed stand-ins rank last, then the effort nearest the rung's own (a model's efforts carry one
 * another's values as `adjacent`, spec 1.2 §4.3, so the cheapest would otherwise be its lowest effort; plan 14
 * Ruling 4), then the cheapest.
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
  const gap = (x: string) => effortGap(from.effort, tryParseRung(x)?.effort ?? "");
  return fits.sort(
    (a, b) =>
      Number(claudeBilled(a)) - Number(claudeBilled(b)) ||
      gap(a) - gap(b) ||
      compareCost(costFor(c, billing, a), costFor(c, billing, b)) ||
      a.localeCompare(b),
  );
}

/** How many effort steps apart two efforts are; an effort that is no effort word (`default`) is far from all. */
function effortGap(a: string, b: string): number {
  const i = (EFFORT_ORDER as readonly string[]).indexOf(a);
  const j = (EFFORT_ORDER as readonly string[]).indexOf(b);
  if (a === b) return 0;
  return i < 0 || j < 0 ? EFFORT_ORDER.length : Math.abs(i - j);
}

/** How a family's `on` key or a model id's prefix maps to the backend that runs it. */
const BACKEND_OF_KEY: Record<string, string> = { "opencode-go": "opencode" };

/**
 * Every rung the catalog knows how to name: each shipped family's model on each backend at each effort (at
 * `#default` when it has none),
 * each listed model at each effort, and each treat-like whose model is an opencode id (`opencode-go/…`,
 * `opencode/…`), such as the shipped Kimi K3 stand-in. Sorted, without duplicates.
 */
export function catalogRungs(c: Catalog): string[] {
  const out = new Set<string>();
  for (const f of c.families)
    for (const [key, m] of Object.entries(f.on)) {
      if (!m) continue;
      // a model with no effort has one rung, #default (Claude Code's Haiku, Cursor's Composer; spec 1.3 §7.1)
      for (const e of m.efforts.length ? m.efforts : ["default"])
        out.add(`${BACKEND_OF_KEY[key] ?? key}:${m.id}#${e}`);
    }
  for (const [backend, l] of Object.entries(c.listed))
    for (const m of l.models) for (const e of m.efforts) out.add(`${backend}:${m.id}#${e}`);
  for (const canonical of Object.keys(c.treatLike))
    if (/^opencode(-go)?\//.test(canonical)) out.add(`opencode:${canonical}`);
  return [...out].sort();
}
