import { CatherdError } from "../domain/errors.ts";
import { git } from "../infra/git.ts";
import { nonBlankLines } from "../infra/store.ts";
import { listDispatches } from "./dispatches.ts";
import { readAgentRuns, readRecords, readRoutes, type Run, runPaths } from "./run-store.ts";

// Spec 1.1 §6 and §10: what a milestone has been through, read from the run's own records. `land` gates on
// it, and the protocol's next step is derived from it.

/** `name` names milestone `m` as a word: verifier-M1 and M1-verifier do, verifier-M10 does not. */
export const namesMilestone = (name: string, m: string): boolean =>
  new RegExp(`(^|[^A-Za-z0-9])${m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^0-9])`).test(name);

const inMilestone = (lane: string | null | undefined, m: string): boolean =>
  typeof lane === "string" && lane.startsWith(`${m}.`);

/**
 * When the milestone's lanes started: its earliest route row or lane dispatch; null when neither exists
 * (a milestone with no lanes, such as a docs pass), and every record of the run then counts.
 */
export function milestoneStart(run: Run, m: string): string | null {
  const times = [
    ...readRoutes(run)
      .filter((r) => inMilestone(r.lane, m))
      .map((r) => r.at),
    ...listDispatches(run)
      .filter((d) => inMilestone(d.admit.lane, m))
      .map((d) => d.admit.admittedAt),
  ].filter((t) => !Number.isNaN(Date.parse(t)));
  return times.sort()[0] ?? null;
}

const since = (at: string, start: string | null) => start === null || Date.parse(at) >= Date.parse(start);

/** A reviewer record for the milestone since its lanes started: a dispatch named reviewer-<m>…, status ok. */
export function reviewerPassed(run: Run, m: string, start = milestoneStart(run, m)): boolean {
  return readRecords(run).records.some(
    (r) => r.name.startsWith(`reviewer-${m}`) && r.status === "ok" && since(r.endedAt, start),
  );
}

/**
 * A verifier verdict for the milestone since its lanes started: a record_agent_run row with role verifier
 * whose name names the milestone, status ok; or a headless verifier's dispatch record of the same shape.
 */
export function verifierPassed(run: Run, m: string, start = milestoneStart(run, m)): boolean {
  const native = readAgentRuns(run).some(
    (a) => a.role === "verifier" && a.status === "ok" && namesMilestone(a.name, m) && since(a.at, start),
  );
  return (
    native ||
    readRecords(run).records.some(
      (r) =>
        r.role === "verifier" && r.status === "ok" && namesMilestone(r.name, m) && since(r.endedAt, start),
    )
  );
}

/** The commits of the landed milestones, oldest first, from the ledger. */
export function landedCommits(run: Run): string[] {
  return nonBlankLines(runPaths(run.dir).ledger)
    .slice(1)
    .map((row) => row.split(" | ")[2]?.trim() ?? "")
    .filter((c) => /^[0-9a-f]{7,40}$/.test(c));
}

/** The milestones the ledger holds, in landing order. */
export function landedMilestones(run: Run): string[] {
  return nonBlankLines(runPaths(run.dir).ledger)
    .slice(1)
    .map((row) => row.split(" | ")[0]?.trim() ?? "")
    .filter(Boolean);
}

/**
 * The files the milestone's commit range changed: from the previous landed commit (else the commit's own
 * parent) to `commit`. Throws E_IO_UNEXPECTED when git cannot say.
 */
export async function milestoneFiles(run: Run, commit: string): Promise<string[]> {
  const base = landedCommits(run).at(-1);
  const repo = run.meta.repo;
  const r = base
    ? await git(repo, ["diff", "--name-only", base, commit])
    : await git(repo, ["show", "--name-only", "--format=", "--first-parent", commit]);
  if (r.kind !== "ok")
    throw new CatherdError("E_IO_UNEXPECTED", `git could not list the files ${commit} changed`, {
      fix: `check that git works in ${repo}`,
    });
  return r.out.split("\n").filter(Boolean);
}

const DOC = /(^|\/)docs\/|\.(md|mdx|markdown|txt|rst|adoc)$/i;
const SOURCE =
  /\.(ts|tsx|js|jsx|mjs|cjs|go|py|rs|java|kt|kts|swift|rb|php|c|h|cc|cpp|hpp|cs|m|scala|sh|bash|zsh|sql|vue|svelte|css|scss|sass|less|html|dart|ex|exs|erl|zig|lua)$/i;

export const isDocPath = (p: string): boolean => DOC.test(p);
export const isSourcePath = (p: string): boolean => SOURCE.test(p) && !isDocPath(p);
