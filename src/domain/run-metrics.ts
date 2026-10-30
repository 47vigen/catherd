import { z } from "zod";
import { coveredMs, type Span } from "./util.ts";

/**
 * Spec D17 (plan 51): one run's stage-1 metrics, from its own rows. Pure: the service reads the rows, this does the
 * arithmetic. Times are epoch ms; pauses are left out of every share.
 */
export interface MetricDispatch {
  role: string;
  startedAt: number;
  endedAt: number;
  status: string;
  replyStatus: string | null;
  /** the blocked reason a blocked or refused reply named, else null */
  reason: string | null;
  costUsd: number | null;
  /**
   * plan 55, spec D5: catherd sent the task back after its merge (`merge_conflict`, `merge_red`): its minutes are lost
   * time however it ended, so isolation's own cost shows beside stage 1's blocked minutes
   */
  rework?: string;
}

export interface MetricInput {
  start: number;
  end: number;
  pauses: readonly Span[];
  dispatches: readonly MetricDispatch[];
  /** minutes the run's checks ran (cached passes left out); null when the run kept no check rows */
  checkMinutes: number | null;
  /** plan 53: when each check ran (cached passes left out), fast ones marked */
  checkSpans?: readonly (Span & { fast: boolean })[];
  /** review rounds per ledger task (or per milestone, for an earlier run) */
  rounds: Readonly<Record<string, number>>;
  climbs: number;
  /** seconds from each standing-role task's delegation to its start */
  standingStartSec: readonly number[];
  ownerQuestions: number;
  verifierFails: number;
}

export const RunMetricsSchema = z.object({
  wallMin: z.number(),
  /** share of the unpaused wall time with no role running (baseline 36%) */
  idlePct: z.number(),
  /** role minutes per wall minute (baseline 0.7–0.94) */
  concurrency: z.number(),
  /**
   * minutes of dispatches that ended blocked, refused, failed, timed out or on a limit, by reason; plan 55: and of the
   * dispatches a merge sent back (`merge_conflict`, `merge_red`)
   */
  blockedMin: z.record(z.string(), z.number()),
  /** check minutes as a share of the wall time; null without check rows */
  checkShare: z.number().nullable(),
  /** plan 53, spec D6: fast-check minutes as a share of the wall time; null without check rows (absent before plan 53) */
  fastCheckShare: z.number().nullable().optional(),
  /** plan 53: the share of the wall time a check ran with no role running: what the run waited on checks */
  checkWaitShare: z.number().nullable().optional(),
  rounds: z.object({ perTask: z.record(z.string(), z.number()), max: z.number(), total: z.number() }),
  climbs: z.number(),
  costUsd: z.number().nullable(),
  /** median seconds from a standing-role call to its start; null with none */
  standingStartSec: z.number().nullable(),
  ownerQuestions: z.number(),
  verifierFails: z.number(),
});
export type RunMetrics = z.infer<typeof RunMetricsSchema>;

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The middle value, or the mean of the two middle ones; null for none. */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Why a dispatch was lost time, or null when it ended complete. */
function lostReason(d: MetricDispatch): string | null {
  if (d.rework) return d.rework;
  if (d.replyStatus === "blocked" || d.replyStatus === "refused") return d.reason ?? d.replyStatus;
  if (d.status === "failed" || d.status === "timeout" || d.status === "limit") return d.status;
  return null;
}

export function runMetrics(i: MetricInput): RunMetrics {
  const paused = coveredMs(i.start, i.end, i.pauses);
  const wall = Math.max(0, i.end - i.start - paused);
  const spans = i.dispatches.map((d) => ({ from: d.startedAt, to: d.endedAt }));
  // busy and unpaused: the union of both, less the pauses
  const busy = coveredMs(i.start, i.end, [...spans, ...i.pauses]) - paused;
  const roleMs = spans.reduce((n, s) => n + coveredMs(i.start, i.end, [s]), 0);
  const blockedMin: Record<string, number> = {};
  for (const d of i.dispatches) {
    const why = lostReason(d);
    if (why) blockedMin[why] = round1((blockedMin[why] ?? 0) + (d.endedAt - d.startedAt) / 60_000);
  }
  const checks = i.checkSpans ?? [];
  const fastMs = checks.filter((c) => c.fast).reduce((n, c) => n + coveredMs(i.start, i.end, [c]), 0);
  const waitMs = coveredMs(i.start, i.end, [...spans, ...i.pauses, ...checks]) - paused - busy;
  const share = (ms: number): number | null =>
    i.checkMinutes === null || wall === 0 ? null : round2(ms / wall);
  const priced = i.dispatches.filter((d) => d.costUsd !== null);
  const rounds = Object.values(i.rounds);
  return {
    wallMin: round1(wall / 60_000),
    idlePct: wall > 0 ? round1(100 * (1 - busy / wall)) : 0,
    concurrency: wall > 0 ? round2(roleMs / wall) : 0,
    blockedMin,
    checkShare: share(i.checkMinutes === null ? 0 : i.checkMinutes * 60_000),
    fastCheckShare: share(fastMs),
    checkWaitShare: share(waitMs),
    rounds: {
      perTask: { ...i.rounds },
      max: rounds.length ? Math.max(...rounds) : 0,
      total: rounds.reduce((n, r) => n + r, 0),
    },
    climbs: i.climbs,
    costUsd: priced.length ? round2(priced.reduce((n, d) => n + (d.costUsd as number), 0)) : null,
    standingStartSec: median(i.standingStartSec),
    ownerQuestions: i.ownerQuestions,
    verifierFails: i.verifierFails,
  };
}

/** Spec D8: a reviewer rung's record over runs, so its noise and its misses show per rung. */
export interface ReviewerRow {
  rung: string;
  reviews: number;
  /** findings by severity: `IMPORTANT`, `NIT`, `PRE-EXISTING` (and an earlier build's `BLOCKER`, `BUG`) */
  findings: Record<string, number>;
  /** findings by how the architect handled them; `unlogged` when it logged nothing */
  handled: Record<string, number>;
  /** bugs a review on this rung missed and something later caught */
  missed: number;
}

export function reviewerRows(
  reviews: readonly {
    taskId: string;
    rung: string;
    findings: readonly { label: string }[];
    handled: Readonly<Record<number, string>>;
  }[],
  missed: readonly { review: string | null }[],
): ReviewerRow[] {
  const rows = new Map<string, ReviewerRow>();
  const row = (rung: string): ReviewerRow => {
    let r = rows.get(rung);
    if (!r) rows.set(rung, (r = { rung, reviews: 0, findings: {}, handled: {}, missed: 0 }));
    return r;
  };
  const rungOf = new Map(reviews.map((r) => [r.taskId, r.rung]));
  for (const rv of reviews) {
    const r = row(rv.rung);
    r.reviews++;
    rv.findings.forEach((f, i) => {
      r.findings[f.label] = (r.findings[f.label] ?? 0) + 1;
      const how = rv.handled[i + 1] ?? "unlogged";
      r.handled[how] = (r.handled[how] ?? 0) + 1;
    });
  }
  for (const m of missed) row((m.review && rungOf.get(m.review)) || "(no review named)").missed++;
  return [...rows.values()].sort((a, b) => b.reviews - a.reviews);
}
