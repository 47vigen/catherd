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
  /** test files the run's diff deleted, test cases it removed, existing test files it took lines out of, added skips */
  tests: TestChanges;
}

/** Plan 54, spec D9: what a run did to its tests, each list already formatted. */
export interface TestChanges {
  deleted: readonly string[];
  /** `<path>: <test name>` */
  removed: readonly string[];
  /** `<path> (-<n> lines)` */
  rewritten: readonly string[];
  skipped: readonly string[];
}

/** One line per test change, for the MR body and the verifier's brief. */
export const testChangeLines = (t: TestChanges): string[] => [
  ...t.deleted.map((p) => `deleted ${p}`),
  ...t.removed.map((r) => `removed ${r}`),
  ...t.rewritten.map((r) => `rewritten ${r}`),
  ...t.skipped.map((l) => `skipped: ${l}`),
];

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
    "### Tests deleted, removed, rewritten or skipped",
    "",
    ...list(testChangeLines(i.tests), "none"),
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

/** A test's declaration: its name in it/test/describe, Go's `func TestX`, or Python's `def test_x`. */
const TEST_NAME =
  /^\s*(?:(?:it|test|describe)(?:\.\w+)?\(\s*(["'`])(.+?)\1|func\s+(Test\w+)\(|def\s+(test_\w+)\()/;

/**
 * Plan 54: the test cases a `git diff -U0` removes from test files, as `<path>: <name>`: a declaration on a `-` line
 * whose name no `+` line of the same file declares again (a moved or edited test is not removed).
 */
export function removedTests(diff: string): string[] {
  const files = new Map<string, { minus: string[]; plus: Set<string> }>();
  let cur: { minus: string[]; plus: Set<string> } | null = null;
  for (const line of diff.split("\n")) {
    const head = /^diff --git a\/(.+?) b\//.exec(line);
    if (head) {
      const path = head[1] as string;
      cur = isTestPath(path) ? { minus: [], plus: new Set() } : null;
      if (cur) files.set(path, cur);
      continue;
    }
    if (!cur || line.startsWith("---") || line.startsWith("+++")) continue;
    const m = TEST_NAME.exec(line.slice(1));
    const name = m?.[2] ?? m?.[3] ?? m?.[4];
    if (!name) continue;
    if (line.startsWith("-")) cur.minus.push(name);
    else if (line.startsWith("+")) cur.plus.add(name);
  }
  return [...files].flatMap(([path, f]) => f.minus.filter((n) => !f.plus.has(n)).map((n) => `${path}: ${n}`));
}
