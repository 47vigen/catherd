const LABEL = /\b(BLOCKER|BUG|NIT)\b/;
const BUG_MECHANICAL =
  /\b(lint|linter|format|formatting|prettier|type[- ]?check|typecheck|naming|rename|comment|unused)\b/i;
const CHECK_NOTE = /^The fast check failed/;
const CHECK_MECHANICAL =
  /error TS\d+|typecheck|lint|oxlint|eslint|biome|oxfmt|prettier|golangci-lint|gofmt|go vet/;
const CHECK_TEST_FAIL = /\(fail\)|✗|--- FAIL|FAIL |panic:|expect\(/;

/**
 * A fix a cheaper rung can do: a NIT; a BUG whose text is about lint, format, type check, naming, a comment or an
 * unused symbol; a fast-check failure note whose tail names a lint, format or type-check failure and no failing test.
 */
export function mechanicalNote(note: string): boolean {
  if (/^The (owner|judge) answered:/.test(note)) return false;
  if (CHECK_NOTE.test(note)) return CHECK_MECHANICAL.test(note) && !CHECK_TEST_FAIL.test(note);
  const label = LABEL.exec(note)?.[1];
  if (label === "NIT") return true;
  return label === "BUG" && BUG_MECHANICAL.test(note);
}

/** Non-empty, and every note mechanical. */
export function mechanicalFix(notes: readonly string[]): boolean {
  return notes.length > 0 && notes.every(mechanicalNote);
}
