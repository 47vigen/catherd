# catherd — agent instructions

catherd is a Bun/TypeScript CLI, MCP server and Claude Code plugin that herds coding agents: Claude plans and
verifies, Codex, opencode or headless Claude Code workers write the code, and Jev (TypeSafe) optionally picks each
lane's model and effort ("rungs", written `backend:model#effort`). npm package `catherd-cli`, command `catherd`, plugin
`catherd@catherd` from this repo's marketplace.

## Where things are

- `docs/specs/`: design specs. `docs/specs/2026-09-25-catherd-1.0-design.md` is binding.
- `docs/plans/`: implementation plans, `YYYY-MM-DD-NN-<name>.md`. **New plans go here**, never under
  `docs/superpowers/` (overrides the superpowers `writing-plans` default).
- `docs/handoff/`: `HANDOFF.md` (the state of every plan; read it first), per-plan ledgers, preflights and final
  reviews, and `process/` (the worker, reviewer and re-reviewer contracts).
- `docs/dev/`: maintainer docs. `ideas.md` is the backlog: every improvement idea from real runs lands there first,
  with its evidence; a picked-up idea moves into a plan. `reports/` holds real-run reports.
- `docs/research/`: dated research behind the spec. Read it only when a plan or task points at it.
- Authority order: spec → plan → rulings.

## Code

- Layers `domain → infra → adapters → services → entry`, enforced by `test/architecture.test.ts`.
- Workers run under a detached supervisor; every store write is atomic, locked and schema-versioned.
- ProfileService is the single writer of profiles, config, repo bindings and Claude agent links.
- A missing profile name means the profile the current repo runs on.
- The gate: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test`.
- Tests that could reach the network delete `ANTHROPIC_API_KEY` (in-process) or pass `ANTHROPIC_API_KEY: ""`
  (spawned); spawned processes get an explicit `env`. Never use wall-clock sleeps for correctness.
- Bun ≥ 1.4. Never commit a `bun.lock` an older Bun rewrote.
- Commits: conventional (commitlint), subject ≤ 100 characters, lower-case first word. A failed hook leaves the
  changes uncommitted, so check `git log`.

## Owner decisions that stand

- Audience: the owner's team, with public open-source quality. 1.0 was a clean break from 0.x.
- Roles run in each vendor CLI exactly as the user configured it (native harness); isolation is only the profile's
  per-backend toggle.
- Claude runs native (subagents) and headless (`claude-code:` rungs). Access is set per profile and per role.
- The TUI follows opencode's: `@opentui/react`, `@opentui/keymap`, a `ctrl+p` palette, a `ctrl+x` leader, 16 theme
  tokens; keyboard-first, predictable, no surprises.
- Releases are versioned with Changesets; the Release workflow opens "chore: release catherd", and merging it
  publishes to npm through OIDC and stamps the plugin version.
- Cursor CLI and Grok CLI adapters are planned (`docs/plans/2026-09-26-08-cursor-grok.md`), on hold until the owner
  says.

## Autopilot: executing plans end to end

When the owner hands over a batch of work on autopilot ("do everything through to release"), drive it with no
check-ins: write plans, implement, review, fix, open PRs, handle bot reviews, merge and release. Ask the owner only
about a decision that is truly theirs (a product choice the spec does not answer, or an action that cannot be undone
outside the repo). Record every other ambiguity as a ruling and keep going.

### Start of a session

1. Use the superpowers skills throughout (`using-superpowers` first, then `subagent-driven-development`,
   `writing-plans`, `requesting-code-review`). Their helper scripts are in
   `subagent-driven-development/scripts/`: `sdd-workspace PLAN`, `task-brief PLAN N`, `review-package PLAN BASE
HEAD`. If the skills are not listed, read them from `~/.claude/plugins/cache/claude-plugins-official/superpowers/*/skills/`.
2. The dispatch contracts must be in `.superpowers/sdd/` (gitignored): `cp docs/handoff/process/*.md
.superpowers/sdd/`.
3. Run the gate on `main`; it must be green before any work starts.
4. Read, in order: `docs/handoff/HANDOFF.md`, the spec, the ledgers HANDOFF points at, then the plan you execute
   (its Global Constraints, Review Focus, Rulings and Parallelism sections). Never make a worker read a whole plan;
   give it its task brief.
5. The harness names one development branch. Restart it on the latest `main` before each plan
   (`git fetch origin main && git checkout -B <branch> origin/main`) and push with `--force-with-lease`.

In a cloud session the sandbox starts empty; the environment's setup script (`scripts/cloud-setup.sh`, pasted into
the environment settings) installs Bun, the superpowers plugin and the worker agents, and copies the contracts. If a
step of it failed, do it by hand before starting.

### Writing a plan

With `superpowers:writing-plans`, through a plan-writer subagent. The writer pre-validates the plan by building every
task in a scratch copy, and the plan is committed before it is executed. A plan writer may run while the previous
plan is still in review, since it touches only docs.

### Executing a plan (subagent-driven, adapted to save tokens and time)

- **One PR per plan**, from the branch restarted on `main`. Open it as a draft when the first batch lands and
  subscribe to its activity; schedule an hourly check-in while it is open and delete it after the merge.
- **Ledger** at `.superpowers/sdd/<plan>/progress.md`; its first line names the plan. Record every decision as
  `Ruling: <what> — <why> — <cost if wrong>`. After a context compaction, trust the ledger and `git log`, and never
  re-dispatch completed tasks. Copy the ledger to `docs/handoff/planN-ledger.md` before the plan merges, and update
  `HANDOFF.md`.
- **Pre-flight scan** before the first dispatch, by a read-only agent: conflicts between tasks, against the spec and
  against the code as it is. Rule on each and hand the rulings to the workers in a notes file.
- **Bundle and parallelise** by the plan's wave table. One agent per batch of 1–3 sequential tasks, each in its own
  worktree (`isolation: "worktree"`); worktrees start at `main`, so each agent first runs `git reset --hard <current
branch sha>`. A worktree agent's final message is its report: save it, cherry-pick its commits onto the branch and
  run the full gate on the combined head. Keep a worker's worktree until its review passes. Start the next wave while
  the last is in review when the files are disjoint. Worker scratch files stay inside the worker's worktree.
- **Reviews:** one task review per batch (the `review-package` diff and `reviewer-contract.md`); fix rounds resume the
  implementer with the findings and a new reset SHA, then a scoped re-review (`re-reviewer-contract.md`). Fix
  one-line findings yourself, with a test. Then one final whole-branch review (superpowers'
  `requesting-code-review/code-reviewer.md`, with a "Declined to judge" list), one fix wave and its re-review.
- **Bot rounds:** mark the PR ready; the Codex bot reviews it. Fix every finding with a test that fails first, or
  reply why not; reply on each thread naming the fixing commit and resolve it; re-trigger with `@codex review` right
  after each push. At most 4 rounds per PR unless the owner lifts the cap. Merge when CI is green.
- **Worker models:** Opus 5.5, always set explicitly: `opus-low` for transcription-grade tasks where the plan holds
  the code, `opus-medium` for integration or judgment work and for reviews (agents in `~/.claude/agents/`; until a
  reload loads them, use general-purpose agents with `model: "opus"`).
- **Release:** a plan's last task adds its changeset. After that PR merges, merge the "chore: release catherd" PR
  unless the owner asked to hold it for live verification (`docs/dev/live-verification.md`); in that case give the
  owner the exact commands and wait.
