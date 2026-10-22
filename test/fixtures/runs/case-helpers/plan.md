# Case helpers — plan

Source: plan-input/2026-10-22-03-case.md (owner-approved). Both tasks change the same two files, so they share one lane.

## M1 — capitalize and titleCase

- A1 `capitalize("hello")` is "Hello" and `capitalize("")` is ""
- A2 `titleCase("  a  b ")` is "A B"
- A3 `bun test` passes

Check: bun test

Tasks: 1, 2

### Lanes

- M1.L1 — capitalize then titleCase in src/text.ts — Owns: src/text.ts, src/text.test.ts — Fast check: `bun test src/text.test.ts`

## Decisions

- D1 — `titleCase` reuses the existing `words` from `src/text.ts` (already strips leading, trailing and repeated whitespace) — rejected: a new split/trim — the plan names `words(s).map(capitalize).join(" ")`.
- D2 — Keep the existing `words`, `slugify`, `truncate` and their tests unchanged — rejected: refactoring them — not in the plan.

## Out of scope

- No changes to `words`, `slugify`, `truncate`, package.json, or docs/.
- No linter or tsconfig: the repo has neither, so the fast check is the test file alone.
