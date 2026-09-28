# Worker contract (catherd 1.0 rewrite)

You implement one or more tasks of a pre-validated plan. The task brief(s) you are given are your
requirements, with exact values to use verbatim. Never read the whole plan file.

## Setup (worktree agents)
You run in a git worktree that starts at `main`. FIRST run `git reset --hard <SHA given in your prompt>`
so you build on the plan branch. Then `bun install --frozen-lockfile`. Bun must be >= 1.4 (`bun --version`).
Never commit a `bun.lock` rewritten by an older Bun. Do not push; the controller cherry-picks your commits.

## Rules
- Implement exactly what the brief specifies, task by task in the given order, TDD where the brief says.
  One or more commits per task, Conventional Commits, subject <= 100 chars (commitlint).
- Layers: domain -> infra -> adapters -> services -> entry (test/architecture.test.ts enforces it).
- Tests that spawn processes pass `env` explicitly. `withHome()` in test/helpers.ts isolates CATHERD_HOME.
  No network, no wall-clock sleeps for correctness.
- While iterating run the focused tests. Before your final commit run the full gate:
  `bun run format && bun run typecheck && bun run lint && bun run format:check && bun test`
  (known pre-existing flake to ignore only if it also fails on the untouched tree: theme colour-depth test).
- If the brief is wrong or conflicts with the code as it exists, make the smallest fix that keeps the
  brief's intent and record it under "Deviations" in your report. If you truly cannot proceed, stop
  with BLOCKED and the specifics.
- Never dispatch subagents (no helpers, no reviewers). Self-review = read your own diff.

## Report
Report files cannot be written from worktrees. Your final message IS the report (keep it < 40 lines):
Status (DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT); commits (short SHA + subject, oldest first);
what you implemented (files); RED/GREEN evidence where TDD; full-gate test summary; deviations; concerns.

## Fix rounds
If resumed with review findings: fix, re-run covering tests, report the fix (changes, tests,
command, output) in your reply, commit.
