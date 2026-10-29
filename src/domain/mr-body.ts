/** Plan 50, spec D11: what a run's merge request says, read from the run's own records. */
export interface MrBodyInput {
  /** the owner's words: the run title and its A-lines */
  title: string;
  aLines: readonly string[];
  /** the ledger tasks the run finished, by their goals */
  done: readonly string[];
  /** the passing full check this push carries, or null; `inherited` counts the failures the base has too (plan 52) */
  proof: {
    command: string;
    sha: string;
    log: string;
    inherited?: number;
  } | null;
  /** every architect tool call with its `why`, oldest first, one line each */
  audit: readonly string[];
  /** ledger tasks set impossible or blocked, and findings the architect left open */
  knownIssues: readonly string[];
  /** test files the run's diff deleted, test cases it removed, existing test files it took lines out of, added skips */
  tests: TestChanges;
  /** plan 54, spec D9: each oracle change the architect accepted, with its reason */
  oracle: readonly string[];
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
  ...t.removed.slice(0, 20).map((r) => `removed or renamed ${r}`),
  ...(t.removed.length > 20 ? [`and ${t.removed.length - 20} more removed or renamed`] : []),
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
    "### Oracle overrides",
    "",
    ...list(i.oracle, "none"),
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

const HEADER_LINE =
  /^(?:index |--- |\+\+\+ |(?:new|deleted) file mode|(?:old|new) mode|(?:dis)?similarity index|rename |copy |Binary files|GIT binary patch)/;

/**
 * Plan 54: the test cases a `git diff -U0` removes from test files, as `<path>: <name>`: a declaration on a `-` line
 * whose name no `+` line of the same file declares again (an edited or reordered test is not removed; one moved to
 * another file shows as removed, which the wording allows). The path is
 * the `+++ b/` line's (`--- a/` for a deletion); run git with `core.quotePath=false`, a quoted path is skipped.
 */
export function removedTests(diff: string): string[] {
  const files = new Map<string, { minus: string[]; plus: Set<string> }>();
  let cur = null as { minus: string[]; plus: Set<string> } | null;
  let header = false;
  let from: string | null = null;
  const open = (path: string | null) => {
    if (path === null || !isTestPath(path)) return;
    cur = files.get(path) ?? { minus: [], plus: new Set() };
    files.set(path, cur);
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = null;
      header = true;
      from = null;
      continue;
    }
    // a file's header ends at its first line that is none of the header's; hunk lines are content
    if (header && HEADER_LINE.test(line)) {
      if (line.startsWith("--- ")) from = /^--- a\/(.+?)\t?$/.exec(line)?.[1] ?? null;
      else if (line.startsWith("+++ ")) open(/^\+\+\+ (?:b\/(.+?)\t?|\/dev\/null)$/.exec(line)?.[1] ?? from);
      continue;
    }
    header = false;
    const m = TEST_NAME.exec(line.slice(1));
    const name = m?.[2] ?? m?.[3] ?? m?.[4];
    if (!name) continue;
    if (line.startsWith("+")) cur?.plus.add(name);
    else if (line.startsWith("-")) cur?.minus.push(name);
  }
  return [...files].flatMap(([path, f]) => f.minus.filter((n) => !f.plus.has(n)).map((n) => `${path}: ${n}`));
}
