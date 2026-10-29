import { isStanding } from "../domain/architect-state.ts";
import { parseBlockedReason } from "../domain/blocked.ts";
import {
  type MetricDispatch,
  type ReviewerRow,
  type RunMetrics,
  reviewerRows,
  runMetrics,
} from "../domain/run-metrics.ts";
import { errorMessage } from "../domain/errors.ts";
import type { RunEvent } from "../domain/run-events.ts";
import { replay, type RunState } from "../domain/run-state.ts";
import { db } from "../infra/db.ts";
import { log } from "../infra/log.ts";
import { pauseSpans } from "./pause.ts";
import { reviewRounds } from "./run-history.ts";
import { isDaemonRun, readEvents } from "./run-events-store.ts";
import { readRecords, type Run } from "./run-store.ts";
import { runEnd, runMilestones } from "./scorecard-metrics.ts";

/** A run's events and their replay (a 1.5 run has none): read once, so a caller that has them passes them on. */
export interface Parsed {
  events: RunEvent[];
  s: RunState | null;
}

export function parsedOf(run: Run): Parsed {
  if (!isDaemonRun(run)) return { events: [], s: null };
  const events = readEvents(run);
  return { events, s: replay(events, run.id) };
}

/**
 * Spec D17 (plan 51): a run's metrics, read from its own rows: the dispatch records, its events and its check rows.
 * An earlier run (2.0 milestones, 1.5) reads the same way; what it never recorded is null or 0.
 */
export function metricsOf(run: Run, now: number, parsed: Parsed = parsedOf(run)): RunMetrics {
  const { events, s } = parsed;
  const daemon = s !== null;
  const ended = events.find((e) => e.type === "run.ended");
  const end = ended
    ? Date.parse(ended.at)
    : daemon
      ? s?.phase === "ended"
        ? Date.parse(events.at(-1)?.at ?? "")
        : now
      : runEnd(run);
  const dispatches: MetricDispatch[] = readRecords(run).records.map((r) => ({
    role: r.role,
    startedAt: Date.parse(r.startedAt),
    endedAt: Date.parse(r.endedAt),
    status: r.status,
    replyStatus: r.replyStatus,
    reason: parseBlockedReason(r.replyWhy)?.reason ?? null,
    costUsd: r.costUsd,
  }));
  const arch = s && s.arch.turns > 0 ? s.arch : null;
  const tasks = arch ? Object.values(arch.tasks) : [];
  const rounds: Record<string, number> = {};
  if (arch) {
    for (const t of tasks)
      if (t.role === "reviewer" && t.ledgerTask && t.state !== "cancelled" && t.state !== "refused")
        rounds[t.ledgerTask] = (rounds[t.ledgerTask] ?? 0) + 1;
  } else for (const m of runMilestones(run)) rounds[m] = reviewRounds(run, m);
  // a climb: a ledger task's next attempt by the same role on another rung
  const seen = new Map<string, string>();
  let climbs = 0;
  for (const t of [...tasks].sort((a, b) => a.delegatedSeq - b.delegatedSeq)) {
    if (!t.ledgerTask) continue;
    const key = `${t.ledgerTask}|${t.role}`;
    if (seen.has(key) && seen.get(key) !== t.rung) climbs++;
    seen.set(key, t.rung);
  }
  // plan 52: an architect turn on another rung than the turn before it, which ended on a quota limit
  const turns = Object.values(s?.dispatches ?? {})
    .filter((d) => d.role === "architect")
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  turns.forEach((d, i) => {
    const before = turns[i - 1];
    if (before?.ended?.status === "limit" && before.rung !== d.rung) climbs++;
  });
  const at = new Map(events.map((e) => [e.seq, Date.parse(e.at)]));
  const standingStartSec = tasks.flatMap((t) => {
    const started = t.dispatchId ? s?.dispatches[t.dispatchId]?.startedAt : undefined;
    const asked = at.get(t.delegatedSeq);
    return isStanding(t.role) && started && asked !== undefined
      ? [Math.max(0, (Date.parse(started) - asked) / 1000)]
      : [];
  });
  const checks = db().query("SELECT scope, minutes, cached, at FROM checks WHERE run_id = ?").all(run.id) as {
    scope: string;
    minutes: number;
    cached: number;
    at: string;
  }[];
  const ran = checks.filter((c) => !c.cached);
  return runMetrics({
    start: Date.parse(run.meta.createdAt),
    end: Number.isNaN(end) ? now : end,
    pauses: pauseSpans(run),
    dispatches,
    checkMinutes: checks.length || arch ? ran.reduce((n, c) => n + c.minutes, 0) : null,
    checkSpans: ran.map((c) => ({
      fast: c.scope === "fast",
      from: Date.parse(c.at),
      to: Date.parse(c.at) + c.minutes * 60_000,
    })),
    rounds,
    climbs,
    standingStartSec,
    ownerQuestions: events.filter((e) => e.type === "question.parked").length,
    verifierFails: events.filter((e) => e.type === "dispatch.ended" && e.verdict === "fail").length,
  });
}

/** A run's metrics; a read that fails leaves them out rather than the whole view or index. */
export function safeMetrics(run: Run, now: number, parsed?: Parsed): RunMetrics | null {
  try {
    return metricsOf(run, now, parsed);
  } catch (e) {
    log("warn", "read", { run: run.id, metrics: errorMessage(e) });
    return null;
  }
}

/** One bug a review missed (spec D8's reviewer eval set): where, what, and what caught it. */
export interface MissedBug {
  run: string;
  ledgerTask: string;
  review: string | null;
  bug: string;
  caughtBy: string;
  at: string;
}

/** Spec D8 over `runs`: each reviewer rung's reviews, findings, their handling and misses, and the eval set. */
export function reviewerReport(
  runs: readonly Run[],
  parsed?: ReadonlyMap<string, Parsed>,
): { rungs: ReviewerRow[]; missed: MissedBug[] } {
  const reviews: Parameters<typeof reviewerRows>[0][number][] = [];
  const missed: MissedBug[] = [];
  for (const run of runs) {
    const { events, s } = parsed?.get(run.id) ?? parsedOf(run);
    if (!s) continue;
    // task ids repeat across runs: key each review by run
    for (const t of Object.values(s.arch.tasks))
      if (t.role === "reviewer" && t.state === "ended")
        reviews.push({ ...t, taskId: `${run.id}/${t.taskId}` });
    for (const e of events)
      if (e.type === "review.missed")
        missed.push({
          run: run.id,
          ledgerTask: e.ledgerTask,
          review: e.review ? `${run.id}/${e.review}` : null,
          bug: e.bug,
          caughtBy: e.caughtBy,
          at: e.at,
        });
  }
  return { rungs: reviewerRows(reviews, missed), missed };
}
