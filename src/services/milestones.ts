import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CatherdError } from "../domain/errors.ts";
import type { RunRecord } from "../domain/record.ts";
import { git } from "../infra/git.ts";
import { nonBlankLines } from "../infra/store.ts";
import { listDispatches } from "./dispatches.ts";
import { readAgentRuns, readRecords, readRoutes, type Run, runPaths } from "./run-store.ts";

// Spec 1.1 §6 and §10: what a milestone has been through, read from the run's own records. `land` gates on
// it, and the protocol's next step is derived from it.

/** `name` names milestone `m` as a word: verifier-M1 and M1-verifier do, verifier-M10 does not. */
export const namesMilestone = (name: string, m: string): boolean =>
  new RegExp(`(^|[^A-Za-z0-9])${m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^0-9])`).test(name);

/** `name` is milestone `m`'s reviewer: reviewer-<m> then the end, '-', '.' or '_' (reviewer-M10 is not M1's). */
export const reviewsMilestone = (name: string, m: string): boolean => {
  const head = `reviewer-${m}`;
  return (
    name.startsWith(head) && (name.length === head.length || "-._".includes(name[head.length] as string))
  );
};

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

/** The milestone's reviewer: its dispatch record, or null for a native Claude subagent (record_agent_run). */
export interface MilestoneReviewer {
  name: string;
  at: string;
  record: RunRecord | null;
}

/**
 * The milestone's latest passing reviewer since its lanes started: a dispatch named reviewer-<m>…, status
 * ok; or a record_agent_run row with role reviewer and the same name, status ok. Null when there is none.
 */
export function milestoneReviewer(
  run: Run,
  m: string,
  start = milestoneStart(run, m),
): MilestoneReviewer | null {
  const found: MilestoneReviewer[] = [
    ...readRecords(run)
      .records.filter((r) => reviewsMilestone(r.name, m) && r.status === "ok" && since(r.endedAt, start))
      .map((r) => ({ name: r.name, at: r.endedAt, record: r })),
    ...readAgentRuns(run)
      .filter(
        (a) =>
          a.role === "reviewer" && reviewsMilestone(a.name, m) && a.status === "ok" && since(a.at, start),
      )
      .map((a) => ({ name: a.name, at: a.at, record: null })),
  ];
  return found.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1) ?? null;
}

/** A reviewer record for the milestone since its lanes started (see milestoneReviewer). */
export const reviewerPassed = (run: Run, m: string, start = milestoneStart(run, m)): boolean =>
  milestoneReviewer(run, m, start) !== null;

/** The verifier's contract puts `VERDICT: PASS` or `VERDICT: FAIL` on the reply's first line (role-prompts.ts). */
const VERDICT_PASS = /^VERDICT: PASS\b/;

/** A headless verifier's reply opens with VERDICT: PASS: its first non-blank line; no reply is no verdict. */
export function replyPasses(run: Run, r: RunRecord): boolean {
  const file = join(run.dir, r.replyPath);
  if (!r.replyPath || !existsSync(file)) return false;
  const first = readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  return first !== undefined && VERDICT_PASS.test(first);
}

/**
 * A verifier verdict for the milestone since its lanes started: a record_agent_run row with role verifier
 * whose name names the milestone, status ok (the skill records a FAIL as failed); or a headless verifier's
 * dispatch record of the same shape whose reply opens VERDICT: PASS (status ok means only the CLI exited).
 */
export function verifierPassed(run: Run, m: string, start = milestoneStart(run, m)): boolean {
  const native = readAgentRuns(run).some(
    (a) => a.role === "verifier" && a.status === "ok" && namesMilestone(a.name, m) && since(a.at, start),
  );
  return (
    native ||
    readRecords(run).records.some(
      (r) =>
        r.role === "verifier" &&
        r.status === "ok" &&
        namesMilestone(r.name, m) &&
        since(r.endedAt, start) &&
        replyPasses(run, r),
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

/** `rev`'s full commit hash in the run's repo. Throws E_IO_UNEXPECTED when git cannot say. */
export async function fullCommit(run: Run, rev: string): Promise<string> {
  const r = await git(run.meta.repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  const sha = r.kind === "ok" ? r.out.trim() : "";
  if (!sha)
    throw new CatherdError("E_IO_UNEXPECTED", `git could not resolve ${rev} in ${run.meta.repo}`, {
      fix: `check that git works in ${run.meta.repo}`,
    });
  return sha;
}

/** the repo's own docs/ folder, or a doc extension anywhere: app/docs/page.tsx is code */
const DOC = /^docs\/|\.(md|mdx|markdown|txt|rst|adoc)$/i;
/** .txt files that configure a build or pin dependencies: not docs */
const TXT_MANIFEST = /(^|\/)(requirements[^/]*|constraints[^/]*|CMakeLists)\.txt$/i;
const SOURCE =
  /\.(ts|tsx|js|jsx|mjs|cjs|go|py|rs|java|kt|kts|swift|rb|php|c|h|cc|cpp|hpp|cs|m|scala|sh|bash|zsh|sql|vue|svelte|css|scss|sass|less|html|dart|ex|exs|erl|zig|lua)$/i;

export const isDocPath = (p: string): boolean => DOC.test(p) && !TXT_MANIFEST.test(p);
export const isSourcePath = (p: string): boolean => SOURCE.test(p) && !isDocPath(p);
