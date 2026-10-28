import { listDispatches } from "./dispatches.ts";
import { nonBlankLines } from "../infra/store.ts";
import { readAgentRuns, readRecords, type Run, runPaths } from "./run-store.ts";

// Plan 50: what an earlier run's own files say about its milestones (a 1.5 or early 2.0 run's ledger.md and its
// reviewers), for the scorecard, the run views and workspace runs. Kept from milestones.ts, whose land gate is deleted.

/** Where a milestone name may end inside a longer name: the end, '-', '.', '_' or whitespace (M1-fix, M1.2). */
const MILESTONE_END = String.raw`(?=$|[-._\s])`;
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `name` is milestone `m`'s reviewer: reviewer-<m>, the milestone ending as in a word (reviewer-M10 is not M1's). */
const reviewsMilestone = (name: string, m: string): boolean =>
  new RegExp(`^reviewer-${escapeRe(m)}${MILESTONE_END}`).test(name);

const inMilestone = (lane: string | null | undefined, m: string): boolean =>
  typeof lane === "string" && lane.startsWith(`${m}.`);

/** When the milestone's lanes started: its earliest lane dispatch; null when none exists. */
function milestoneStart(run: Run, m: string): string | null {
  const times = listDispatches(run)
    .filter((d) => inMilestone(d.admit.lane, m))
    .map((d) => d.admit.admittedAt)
    .filter((t) => !Number.isNaN(Date.parse(t)));
  return times.sort()[0] ?? null;
}

const since = (at: string, start: string | null) => start === null || Date.parse(at) >= Date.parse(start);

/** Plan 28: the milestone's full reviewer passes since its lanes started (a partial pass is not a round). */
export function reviewRounds(run: Run, m: string): number {
  const start = milestoneStart(run, m);
  return [
    ...readRecords(run).records.filter(
      (r) =>
        reviewsMilestone(r.name, m) &&
        r.status === "ok" &&
        since(r.endedAt, start) &&
        r.replyStatus !== "partial",
    ),
    ...readAgentRuns(run).filter(
      (a) =>
        a.role === "reviewer" &&
        reviewsMilestone(a.name, m) &&
        a.status === "ok" &&
        since(a.at, start) &&
        a.replyStatus !== "partial",
    ),
  ].length;
}

/** The commits of the landed milestones, oldest first, from the ledger. */
export function landedCommits(run: Run): string[] {
  return nonBlankLines(runPaths(run.dir).ledger)
    .slice(1)
    .map((row) => row.split(" | ")[2]?.trim() ?? "")
    .filter((c) => /^[0-9a-f]{7,40}$/.test(c));
}

/** The commit the ledger holds for `m`, its latest landing; null when it never landed or the row has no commit. */
export function landedCommitOf(run: Run, m: string): string | null {
  const rows = nonBlankLines(runPaths(run.dir).ledger)
    .slice(1)
    .map((row) => row.split(" | "))
    .filter((cells) => cells[0]?.trim() === m);
  const commit = rows.at(-1)?.[2]?.trim() ?? "";
  return /^[0-9a-f]{7,40}$/.test(commit) ? commit : null;
}

/** The milestones the ledger holds, in landing order. */
export function landedMilestones(run: Run): string[] {
  return nonBlankLines(runPaths(run.dir).ledger)
    .slice(1)
    .map((row) => row.split(" | ")[0]?.trim() ?? "")
    .filter(Boolean);
}
