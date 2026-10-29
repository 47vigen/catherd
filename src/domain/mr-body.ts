/** Plan 50, spec D11: what a run's merge request says, read from the run's own records. */
export interface MrBodyInput {
  /** the owner's words: the run title and its A-lines */
  title: string;
  aLines: readonly string[];
  /** the ledger tasks the run finished, by their goals */
  done: readonly string[];
  /** the passing full check this push carries, or null; `inherited` counts the failures the base has too (plan 52) */
  proof: { command: string; sha: string; log: string; inherited?: number } | null;
  /** every architect tool call with its `why`, oldest first, one line each */
  audit: readonly string[];
  /** ledger tasks set impossible or blocked, and findings the architect left open */
  knownIssues: readonly string[];
  /** test files the run's diff deleted, and added lines that skip a test */
  tests: { deleted: readonly string[]; skipped: readonly string[] };
}

const list = (items: readonly string[], none: string): string[] =>
  items.length ? items.map((i) => `- ${i}`) : [`- ${none}`];

/**
 * Spec D11 and its contract line: the problem first in the owner's words, then the change and one proof line; the
 * audit block (every `why`, known issues, deleted or skipped tests) last.
 */
export function mrBody(i: MrBodyInput): string {
  return [
    "## Problem",
    "",
    i.title,
    ...(i.aLines.length ? ["", ...i.aLines.map((a) => `- ${a}`)] : []),
    "",
    "## Change",
    "",
    ...list(i.done, "see the commits"),
    "",
    `Proof: ${i.proof ? `\`${i.proof.command}\` passed${i.proof.inherited ? ` but for ${i.proof.inherited} failure${i.proof.inherited > 1 ? "s" : ""} the base has too,` : ""} on ${i.proof.sha.slice(0, 12)} (${i.proof.log})` : "no full check has passed on this commit yet"}`,
    "",
    "## Audit",
    "",
    "### Known issues",
    "",
    ...list(i.knownIssues, "none"),
    "",
    "### Tests deleted or skipped",
    "",
    ...list(
      [...i.tests.deleted.map((p) => `deleted ${p}`), ...i.tests.skipped.map((l) => `skipped: ${l}`)],
      "none",
    ),
    "",
    "### Change log",
    "",
    ...list(i.audit, "none"),
    "",
  ].join("\n");
}

/** A path that looks like a test file. */
export const isTestPath = (p: string): boolean =>
  /(^|\/)(__tests__|tests?|spec)\/|[._-](test|spec)\.[a-z]+$|_test\.go$/i.test(p);

/** An added diff line that skips a test, in the common frameworks. */
export const SKIP_LINE =
  /\b(?:it|test|describe)\.skip\(|\bx(?:it|describe)\(|\bt\.Skip\(|@pytest\.mark\.skip|@Disabled\b|#\[ignore\]/;
