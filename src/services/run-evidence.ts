import { type Catalog, rungInfo } from "../domain/catalog.ts";
import type { Kind } from "../domain/lane.ts";
import { routeAt } from "../domain/route.ts";
import { replyVerdict } from "./milestones.ts";
import { listRuns, readAgentRuns, readRecords, readRoutes } from "./run-store.ts";

/** Spec 1.2 §8: what catherd's own runs say about a rung, for one kind or every kind (`*`). */
export interface Evidence {
  /** lanes routed to it, or climbed onto it */
  lanes: number;
  /** lanes that climbed off it */
  climbed: number;
  partial: number;
  blocked: number;
  refused: number;
  /** verifier FAILs it gave, as a verifier (plan 14 Ruling 15) */
  fails: number;
}

/** `<canonical rung>|<kind or *>` → its evidence. Shown by route, catalog list and the TUI; never routes. */
export type EvidenceTable = Record<string, Evidence>;

const VERDICT_FAIL = /^VERDICT: FAIL\b/;
const zero = (): Evidence => ({ lanes: 0, climbed: 0, partial: 0, blocked: 0, refused: 0, fails: 0 });

/**
 * Spec 1.2 §8: for each rung and kind, from the run records of every repo on this machine: the lanes routed or
 * climbed onto it, the climbs off it, its `partial`, `blocked` and `refused` replies (under the kind its lane
 * was routed as when the dispatch started), and the verifier FAILs it gave. Every count also goes under `*`.
 * It never changes scores, bars or routing (1.3's, once there is data).
 */
export function runEvidence(c: Catalog): EvidenceTable {
  const out: EvidenceTable = {};
  const canonicalOf = (rung: string): string | null => {
    try {
      return rungInfo(c, rung).canonical;
    } catch {
      return null;
    }
  };
  const bump = (rung: string, kind: Kind | null, field: keyof Evidence) => {
    const canonical = canonicalOf(rung);
    if (!canonical) return;
    for (const k of kind ? [kind, "*"] : ["*"]) (out[`${canonical}|${k}`] ??= zero())[field] += 1;
  };
  for (const run of listRuns().runs) {
    const routes = readRoutes(run);
    // a lane counts once per rung it was on, under the kind of the row that put it there
    const seen = new Set<string>();
    for (const r of routes) {
      const key = `${r.lane} ${r.rung} ${r.kind ?? "*"}`;
      if (!seen.has(key)) {
        seen.add(key);
        bump(r.rung, r.kind, "lanes");
      }
      if (r.source === "climb" && r.from && r.from !== r.rung) bump(r.from, r.kind, "climbed");
    }
    for (const rec of readRecords(run).records) {
      const kind = rec.lane ? (routeAt(routes, rec.lane, rec.startedAt)?.kind ?? null) : null;
      if (rec.replyStatus === "partial" || rec.replyStatus === "blocked" || rec.replyStatus === "refused")
        bump(rec.rung, kind, rec.replyStatus);
      if (rec.role === "verifier" && rec.status === "ok" && VERDICT_FAIL.test(replyVerdict(run, rec) ?? ""))
        bump(rec.rung, null, "fails");
    }
    for (const a of readAgentRuns(run))
      if (a.role === "verifier" && a.status === "failed") bump(a.rung, null, "fails");
  }
  return out;
}

/** A rung's evidence for `kind`, else over every kind; null when catherd never ran it. */
export function evidenceOf(t: EvidenceTable, canonical: string, kind: Kind | null = null): Evidence | null {
  return (kind ? t[`${canonical}|${kind}`] : undefined) ?? t[`${canonical}|*`] ?? null;
}

/** Spec 1.2 §8's words: "12 lanes, 2 climbed, 1 partial"; null when there is nothing to say. */
export function evidenceLine(e: Evidence | null): string | null {
  if (!e) return null;
  const parts = [`${e.lanes} ${e.lanes === 1 ? "lane" : "lanes"}`];
  if (e.climbed) parts.push(`${e.climbed} climbed`);
  if (e.partial) parts.push(`${e.partial} partial`);
  if (e.blocked) parts.push(`${e.blocked} blocked`);
  if (e.refused) parts.push(`${e.refused} refused`);
  if (e.fails) parts.push(`${e.fails} verifier ${e.fails === 1 ? "FAIL" : "FAILs"}`);
  return parts.join(", ");
}
