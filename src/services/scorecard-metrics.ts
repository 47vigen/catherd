import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sessionKey } from "../domain/host.ts";
import { type Interventions, interventionTotal } from "../domain/scorecard.ts";
import { coveredMs } from "../domain/util.ts";
import { landedMilestones } from "./milestones.ts";
import { pauseSpans } from "./pause.ts";
import { runMilestones } from "./protocol.ts";
import { parkedSpans, questionCounts } from "./questions.ts";
import { listRuns, readAgentRuns, readRecords, type Run, supersededBy } from "./run-store.ts";
import { readSessionRows } from "./sessions.ts";

// Plan 28: what a finished run's own files say about how much it needed a person. Read-only.

/** The interventions a run needed by `end` (epoch ms), counted from its records (plan 28, ruling 4). */
export function interventionsOf(run: Run, end: number, chat: number): Interventions {
  const { questions, answers } = questionCounts(run);
  const keys = [...(run.meta.startedBy ? [run.meta.startedBy] : []), ...readSessionRows(run)].map(sessionKey);
  const takeovers = keys.filter((k, i) => i > 0 && k !== keys[i - 1]).length;
  // events.jsonl exists exactly for a daemon run, where every dispatch is admitted without a session
  const daemon = existsSync(join(run.dir, "events.jsonl"));
  const manualDispatches = daemon ? readRecords(run).records.filter((r) => r.sessionId).length : 0;
  const from = Date.parse(run.meta.createdAt);
  const pauses = pauseSpans(run).filter((s) => s.from >= from && s.from <= end).length;
  const superseded = listRuns([run.meta.repo]).runs.filter((r) => supersededBy(r)?.by === run.id).length;
  const i = { parks: questions, answers, takeovers, manualDispatches, pauses, superseded, chat };
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
