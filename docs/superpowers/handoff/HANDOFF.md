# catherd 1.0 — handoff (2026-09-26, third session)

This file carries the working state of the 1.0 rewrite from one agent session to the next.
Read it after the spec, before touching any plan.

## Where things stand

| Plan | File | State |
| ---- | ---- | ----- |
| 1 foundation | `docs/superpowers/plans/2026-09-25-01-foundation.md` | merged (PR #3) |
| 2 run service + MCP | `…-02-run-service.md` | merged (PR #4) |
| 3 adapters (claude-code, opencode v2, capture kit) | `…-03-adapters.md` | merged (PR #5) |
| 4 catalog + routing (Jev route-v2, outcomes) | `…-04-catalog-routing.md` | merged (PR #6) |
| 5 profiles, CLI, doctor, init | `…-05-profiles-cli-doctor.md` | **merged** (PR #7 tasks 1–3, 7, 8; PR #8 the rest, final review, 3 Codex rounds) |
| 6 TUI (opencode-style, `@opentui/keymap`) | `docs/superpowers/plans/2026-09-26-06-tui.md` | **ready to execute**: re-checked against plan 5 as built, all 13 tasks replayed green (see its "Re-check (2026-09-26)" section) |
| 7 hardening, CI matrix, live-test docs, release 1.0 | `docs/superpowers/plans/2026-09-26-07-hardening-release.md` | being written (a pre-validating plan writer is running) |
| 8 Cursor CLI (1.1), Grok CLI (1.2) | — | to write |

Authority order: spec `docs/superpowers/specs/2026-09-25-catherd-1.0-design.md` → plan → rulings.
Research behind the spec: `docs/research/2026-09-25-*.md` (audit, opencode, opencode-tui, tui, models, jev, cursor-grok).
Plan 5's rulings, reviews and Codex rounds: `plan5-ledger.md` (read it before plan 6/7: several plan-5 rulings
change what later plans consume).

### Plan 5 as built — what later plans must know

- ProfileService (`src/services/profile-service.ts`) is the single locked writer of profiles, `config.json`,
  `projects.json` and agent links. `createProfile`/`resetProfile` validate first and return `saved: false`
  (with `errors`) instead of writing; `createProfile` refuses any existing name including the file-less
  built-in `default`; `apply` refuses to replace a non-catherd file in the agents dir; pruned agents are listed
  in `newSessionNeededFor`; `unbind(repo)` exists; deleting a profile prunes bindings to repos that no longer exist.
- **Repo-scoped resolution everywhere:** a missing profile name means the profile the cwd's repo runs on
  (`activeName(gitToplevel(cwd))`), global active outside a repo — CLI `profile show/list/set/diff/validate`,
  MCP `profile_get/profile_validate/profile_set` (optional `repo` arg; `profile_get` returns `active` = global
  and `here` = resolved), `catalog_query` billing, `lock`, the run engine. `profile list --json` "active" is
  repo-scoped. `catherd profile use --repo --clear` unbinds.
- Exit codes (§8): usage/unknown name 2, failure 1, doctor not ready 3, interrupt 130 (incl. Ctrl-C at an
  `init` prompt). One-line errors via `printError`; the CLI rewrites some MCP-worded fixes (`CLI_FIX`).
- `catherd doctor`: one row per linked profile (`profile`, `profile:<name>`), a `binding:<repo>` fail row for a
  repo bound to a missing profile, guarded checks (a throw becomes a fail row), sandbox probe only for
  workspace-write backends.
- `catherd init` (`src/entry/init-command.ts`, plain prompts, `--no-input`, `--profile`): moves 0.x files to
  `<config>/0.x-backup-<stamp>/` under the profiles lock, always finishes, prints validation errors as `!` lines
  when the default profile does not validate on this machine.
- `runs show` redacts summary, records and debug tails, and registers the saved Jev key first.
- The 0.x dashboard still runs on `src/tui/profile-shim.ts` (keeps rung order/backends/malformed entries);
  plan 6 deletes it with the rest of the 0.x TUI, `src/core` and `src/routing/{jev,catalog,select}.ts`.

### Plan 6 — execute next

Re-checked by a plan writer (commit `9c12e36` on PR #8): every task replayed in wave order on plan 5 as built,
final gate 907 pass / 66 snapshots, `src` left with only `adapters cli.ts domain entry infra services`. Fixes it
made to the plan: profile creation honours `saved: false`; `cli.ts` typing (`ArgsDef`); **the bare-`catherd`
check stays in `cli.ts` before the TUI import** (otherwise every subcommand loads OpenTUI — a test now guards
it); `watch` help text; the init test import line. Waves: {1,2,4} → {3,5} → {6} → {7} → {8} → {9,10} → {11} →
{12} → {13}.

Rulings to apply when executing plan 6 (decided at handoff, record them in the plan-6 ledger):
- Ruling: inside a repo bound to another profile, the TUI opens on and labels the profile that repo runs on
  (`here`), and "Save & make active" there binds the repo (`activate(name, repo)`); outside a repo it acts on the
  global active profile — the same rule plan 5 applied to the CLI and MCP, so the TUI never edits a profile the
  repo does not run on — cost if wrong: one label and one activate call to change.
- Writer rulings kept: cancelling a live run is `ctrl+d` twice (`esc` only backs out); Profiles frame snapshots
  read the shipped catalog (regenerate them and `docs/tui-frames.md` when the catalog changes); the PTY test
  skips without tmux. The PTY smoke test failed once in five full runs in the writer's sandbox — watch it; if it
  flakes in CI, make it event-driven (plan 7 lists it).
- The TUI may want `profile_get`'s new `here` field; validation fix texts say `catherd profile set …` without
  `--profile` (doctor rewrites them per profile; the TUI shows its own actions, so it need not).

## Process that worked (keep it)

- superpowers `subagent-driven-development`, adapted by owner directive: bundle 1–3 tasks per agent, run
  independent batches in parallel git worktrees (`isolation: "worktree"`), workers on Opus 5.5 (`opus-low` /
  `opus-medium` agent types once loaded, else general-purpose with `model: "opus"`).
- Contracts for every dispatch are in `docs/superpowers/handoff/process/` — copy them to `.superpowers/sdd/`
  (gitignored) at session start: `worker-contract.md`, `reviewer-contract.md`, `re-reviewer-contract.md`.
  Dispatch prompts stay short: one line of context, the contract path, the brief path (`task-brief` script),
  the reset SHA, parallel-batch boundaries, and the rulings that bind the task.
- **Worktree agents cannot write outside their worktree.** Their final message IS the report; the controller
  saves it as `task-N-report.md`, cherry-picks the commits onto the branch (SHAs change), then runs
  `review-package` and dispatches the reviewer. Worktrees start at `main`: every agent first runs
  `git reset --hard <branch sha>`.
- **Keep an implementer's worktree until its review passes** — removing it makes the agent un-resumable for the
  fix round (lesson from plan 5 Task 4). Remove finished worktrees (`git worktree remove --force`, then
  `git branch -D worktree-agent-…`) to save disk.
- Run the next wave while the previous batch is in review when files are disjoint (plan 5 ran reviews, fix
  rounds and the next wave concurrently; cherry-pick conflicts were only in `src/cli.ts` `subCommands` —
  keep every line).
- After each cherry-pick of a batch built on an older base, run the full gate on the combined head.
- Tiny review findings (a missing `env`, an un-awaited assertion, one-line fixes): the controller fixes them
  directly with a test instead of a fix round.
- One review per batch, fix rounds by resuming the implementer (`SendMessage`) with a new reset SHA, scoped
  re-reviews, one final whole-branch review (prompt template: `requesting-code-review/code-reviewer.md`, with
  a "Declined to judge" list) with one fix wave and its re-review.
- Then: PR ready → Codex bot review (`@codex review` comment re-triggers) → fix every finding with a RED/GREEN
  test, reply on each thread naming the commit, resolve it → CI green → merge. Plan 4 took 7 rounds, plan 5 took 3.
- One branch per session is imposed by the harness; one PR per plan. After a merge, restart the branch from
  `main` (`git fetch origin main && git checkout -B <branch> origin/main`, push with `--force-with-lease`).
- Ledger per plan in `.superpowers/sdd/<plan>/progress.md` (gitignored); copy it to
  `docs/superpowers/handoff/planN-ledger.md` when the plan merges. Rulings as
  `Ruling: <what> — <why> — <cost if wrong>`.
- Commit subjects ≤ 100 chars, first word lower-case (commitlint; a failed hook leaves the changes staged and
  uncommitted — check `git log` after committing). Never commit a `bun.lock` rewritten by an older Bun.
- Checks: `bun run typecheck && bun run lint && bun run format:check && bun test` (950 pass at handoff).
  Bun ≥ 1.4 required.
- Tests that spawn processes pass `env` explicitly. `withHome()` in `test/helpers.ts` sets `CATHERD_HOME` and
  `CATHERD_CLAUDE_AGENTS_DIR`. Tests that reach claude-code discovery delete `ANTHROPIC_API_KEY` (in-process)
  or pass `ANTHROPIC_API_KEY: ""` (spawned).

## Carry-overs for later plans

- **Plan 7** (see its plan file; the writer was given all of these): the plan-7 hardening list (supervisor /
  runner / cancel races, Codex and opencode `isBusy`, preflight never-as-root, macOS realpath/`ps`, spec.json
  cleanup, timing-based tests → event-driven, incl. `test/entry/lock.test.ts` double-SIGINT and
  `test/entry/cli.test.ts` 800 ms sleep), plan-4 deferred minors (milestone typo in `land`, cached Jev answers
  not schema-validated, `jevKey` null on corrupt credentials), plan-5 deferred minors (closed stored enums
  `billing`/`access`/`notify`, `runDebug` reads whole files for a tail, output-schema double tool-log row
  (latent), doctor `linkedProfiles` still counts bindings to repos that no longer exist, spec §8 synopsis lacks
  `runs show --name` and `catalog list` filters, `init` blocks on a never-closing non-TTY stdin), `doctor`
  reports whether Codex is logged in with ChatGPT, Linux + macOS CI matrix, live-test docs + the owner's
  live-verification kit, Changesets release of 1.0 (0.2.1 → 1.0.0 via `.github/workflows/release.yml`:
  changesets/action opens "chore: release catherd", merging it publishes with npm OIDC).
- **Plan 8:** Cursor CLI adapter (1.1), Grok CLI adapter (1.2) from `docs/research/2026-09-25-cursor-grok.md`,
  each through `test/adapters/contract.ts`, a simulator in `test/sim/`, live tests gated by `CATHERD_LIVE=1`.
- **Live verification (needs the owner's machine):** fixture capture with `CATHERD_LIVE=1` for OpenCode Go,
  Claude and Codex (`src/entry/capture-fixtures.ts`, default out `test/fixtures/adapters`); check
  `codex sandbox <os> --full-auto` and the hidden Jev-key prompt on a real TTY. Plan 7 writes this as a doc.

Detailed ledgers, rulings and reviews of plans 1–5 are in this folder (`plan*-ledger.md`,
`plan*-final-review.md`, `plan*-preflight.md`, `plan5-worker-notes.md`).
