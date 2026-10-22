I wrote `plan.md` and one lane file. Both tasks edit the same two files, and Task 2 calls Task 1's function, so they go in one lane.

**M1 — capitalize and titleCase** (A1, A2, A3) — full check: `bun test`
- M1.L1 — Task 1 (`capitalize`), then Task 2 (`titleCase`) — owns `src/text.ts`, `src/text.test.ts` — fast check: `bun test src/text.test.ts`

The plan leaves two things open, so I decided them in the lane file:
- `titleCase` reuses the `words` function that already exists in `src/text.ts`.
- The existing `words`, `slugify` and `truncate` code and their tests stay as they are.

The lane file also lists the edge cases its tests must cover: `""`, `"éa"`, and `"  a  b "` with extra spaces. The repo has no linter and no tsconfig, so the fast check is the test file alone. I did not run `bun test` here.

STATUS: complete — plan.md and lanes/M1.L1.md are written; the one lane covers Tasks 1 and 2 whole and owns files no other lane touches.