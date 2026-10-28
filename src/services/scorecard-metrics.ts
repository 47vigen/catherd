import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sessionKey } from "../domain/host.ts";
import { type Interventions, interventionTotal } from "../domain/scorecard.ts";
import type { RunEvent } from "../domain/run-events.ts";
import { coveredMs, natural } from "../domain/util.ts";
import { landedMilestones } from "./milestones.ts";
import { pauseSpans } from "./pause.ts";
import { parkedSpans, questionCounts } from "./questions.ts";
import { replay } from "../domain/run-state.ts";
import { isDaemonRun, readEvents } from "./run-events-store.ts";
import { laneIds, listRuns, readAgentRuns, readRecords, type Run, supersededBy } from "./run-store.ts";
import { readSessionRows } from "./sessions.ts";

// Plan 28: what a finished run's own files say about how much it needed a person. Read-only.

/**
 * A daemon run's own events (plan 36, ruling 12): the owner's answers and the questions still open are parks (a
 * judge's answer is not), every answer is shown, and an owner's cancel or plan approval each count.
 */
function eventCounts(run: Run): { parks: number; answers: number; cancels: number; approvals: number } {
  const events = readEvents(run);
  const n = (f: (e: RunEvent) => boolean) => events.filter(f).length;
  // one snapshot: an answer written between two reads would otherwise count nowhere
  const open = Object.keys(replay(events, run.id).questions).length;
  return {
    parks: n((e) => e.type === "question.answered" && e.by === "owner") + open,
    answers: n((e) => e.type === "question.answered"),
    cancels: n((e) => e.type === "cancel.requested"),
    // plan 48: no run waits for a plan approval
    approvals: 0,
  };
}

/** A 1.5 run keeps its questions in questions.jsonl and has no cancel or plan approval to count. */
const oldCounts = (run: Run) => {
  const { questions, answers } = questionCounts(run);
  return { parks: questions, answers, cancels: 0, approvals: 0 };
};

/** The interventions a run needed by `end` (epoch ms), counted from its records (plan 28, ruling 4). */
export function interventionsOf(run: Run, end: number, chat: number): Interventions {
  const daemon = isDaemonRun(run);
  const { parks, answers, cancels, approvals } = daemon ? eventCounts(run) : oldCounts(run);
  const keys = [...(run.meta.startedBy ? [run.meta.startedBy] : []), ...readSessionRows(run)].map(sessionKey);
  const takeovers = keys.filter((k, i) => i > 0 && k !== keys[i - 1]).length;
  // a daemon run admits every dispatch without a session
  const manualDispatches = daemon ? readRecords(run).records.filter((r) => r.sessionId).length : 0;
  const from = Date.parse(run.meta.createdAt);
  const pauses = pauseSpans(run).filter((s) => s.from >= from && s.from <= end).length;
  const superseded = listRuns([run.meta.repo]).runs.filter((r) => supersededBy(r)?.by === run.id).length;
  const i = { parks, answers, takeovers, manualDispatches, pauses, superseded, chat, cancels, approvals };
  return { ...i, total: interventionTotal(i) };
}

/** When the run ended, in epoch ms: its last landing, else its last record or native agent run, else its start. */
export function runEnd(run: Run): number {
  const last = landedMilestones(run).at(-1);
  if (last) {
    const file = join(run.dir, "digests", `${last}.md`);
    const at = existsSync(file) ? / · landed (\S+)\s*$/m.exec(readFileSync(file, "utf8"))?.[1] : undefined;
    const ms = at ? Date.parse(at) : NaN;
    if (!Number.isNaN(ms)) return ms;
  }
  const times = [...readRecords(run).records.map((r) => r.endedAt), ...readAgentRuns(run).map((a) => a.at)]
    .map((t) => Date.parse(t))
    .filter((t) => !Number.isNaN(t));
  return times.length ? Math.max(...times) : Date.parse(run.meta.createdAt);
}

/** Plan 28: the milestones the run's lane files name, in number order (a 1.5 or early 2.0 run's). */
export const runMilestones = (run: Run): string[] =>
  [...new Set(laneIds(run).map((lane) => lane.split(".")[0] as string))].sort(natural);

/** The ms of the run, up to `end`, that it spent parked on the owner or paused; overlaps once. */
export const pausedMs = (run: Run, end: number): number =>
  coveredMs(Date.parse(run.meta.createdAt), end, [
    ...runMilestones(run).flatMap((m) => parkedSpans(run, m)),
    ...pauseSpans(run),
  ]);

/** A failover stand-in (failoverFrom set) ended ok and was not blocked or refused. */
export const failoverRecovered = (run: Run): boolean =>
  readRecords(run).records.some(
    (r) =>
      r.failoverFrom !== null &&
      r.status === "ok" &&
      r.replyStatus !== "blocked" &&
      r.replyStatus !== "refused",
  );
