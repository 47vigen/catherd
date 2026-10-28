import { type Catalog, rungInfo } from "../domain/catalog.ts";
import type { Kind } from "../domain/lane.ts";
import { replyVerdict } from "./verifier-reply.ts";
import { listRuns, readAgentRuns, readRecords } from "./run-store.ts";

/** Spec 1.2 §8: what catherd's own runs say about a rung, for one kind or every kind (`*`). */
export interface Evidence {
  /** dispatches that ran on it (plan 50: a lane's or a task's; route rows are gone, so no kind) */
  lanes: number;
  partial: number;
  blocked: number;
  refused: number;
  /** verifier FAILs it gave, as a verifier (plan 14 Ruling 15) */
  fails: number;
}

/** `<canonical rung>|<kind or *>` → its evidence. Shown by route and catalog list; never routes. */
export type EvidenceTable = Record<string, Evidence>;

const VERDICT_FAIL = /^VERDICT: FAIL\b/;
const zero = (): Evidence => ({ lanes: 0, partial: 0, blocked: 0, refused: 0, fails: 0 });

/**
 * Spec 1.2 §8: for each rung, from the run records of every repo on this machine: the dispatches that ran on it,
 * its `partial`, `blocked` and `refused` replies, and the verifier FAILs it gave, all under `*` (plan 50: the
 * route rows that named a lane's kind are gone).
 * It never changes scores or routing (1.3's, once there is data).
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
    for (const rec of readRecords(run).records) {
      bump(rec.rung, null, "lanes");
      if (rec.replyStatus === "partial" || rec.replyStatus === "blocked" || rec.replyStatus === "refused")
        bump(rec.rung, null, rec.replyStatus);
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
  if (e.partial) parts.push(`${e.partial} partial`);
  if (e.blocked) parts.push(`${e.blocked} blocked`);
  if (e.refused) parts.push(`${e.refused} refused`);
  if (e.fails) parts.push(`${e.fails} verifier ${e.fails === 1 ? "FAIL" : "FAILs"}`);
  return parts.join(", ");
}
