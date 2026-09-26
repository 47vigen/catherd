# catherd 1.0 — handoff (2026-09-26, second session)

This file carries the working state of the 1.0 rewrite from one agent session to the next.
Read it after the spec, before touching any plan.

## Where things stand

| Plan | File | State |
| ---- | ---- | ----- |
| 1 foundation | `docs/superpowers/plans/2026-09-25-01-foundation.md` | merged (PR #3) |
| 2 run service + MCP | `…-02-run-service.md` | merged (PR #4) |
| 3 adapters (claude-code, opencode v2, capture kit) | `…-03-adapters.md` | merged (PR #5) |
| 4 catalog + routing (Jev route-v2, outcomes) | `…-04-catalog-routing.md` | merged (PR #6), 7 Codex review rounds |
| 5 profiles, CLI, doctor, init | `…-05-profiles-cli-doctor.md` | **in progress**: tasks 1, 2, 3, 7, 8 merged (PR #7); 4, 5, 6, 9–14 to do |
| 6 TUI (opencode-style, `@opentui/keymap`) | `…-2026-09-26-06-tui.md` if present | **draft only, not pre-validated** (see below) |
| 7 hardening, CI matrix, release 1.0 (Changesets) | — | to write |
| 8 Cursor CLI (1.1), Grok CLI (1.2) | — | to write |

Authority order: spec `docs/superpowers/specs/2026-09-25-catherd-1.0-design.md` → plan → rulings.
Research behind the spec: `docs/research/2026-09-25-*.md` (audit, opencode, opencode-tui, tui, models, jev, cursor-grok).

### Plan 5 — exact state

- Merged to `main` through PR #7 (partial): Task 1 (profile schema v1), Task 7 (log), Task 2 (validation, plus
  the Claude-rung "clears no routing bar" warning ruling), Task 3 (agent files), Task 8 (CLI runner; catalog
  command errors go through `printError`, malformed rung exits 2). Full gate green at merge (884 tests).
- **Reviews pending** (the owner paused the session before they ran): Task 2, Task 3, Task 8. Run a task review
  on each first (`git log` finds the commits by subject: `feat(domain): profile validation…`,
  `feat(domain): native agent files…`, `feat(cli): the Bun 1.4 guard…`) and fix findings on the new branch.
  Tasks 1 and 7 were reviewed clean (minors deferred, listed in `plan5-ledger.md`).
- Remaining waves: {4} → {5} → {6, 9, 10, 11, 12} → {13, 14}. Task 4 needs 1, 2, 3 (all on main).
- Before dispatching, read `plan5-ledger.md` (rulings), `plan5-preflight.md` (the conflict table) and
  `plan5-worker-notes.md` (plan 4 **as built** differs from plan 4 as written — every worker must read it).
  Key pre-flight rulings still to apply: Task 5 makes `finding`/`sameDefect` honour `jev.use: "off"` and keeps
  `catalog_query`'s "`enabled: false` rungs are unscored"; Tasks 12/13 delete/blank `ANTHROPIC_API_KEY` in tests
  that reach `refreshDiscovery`; Task 13 `init` catches a `saveJevKey` failure and finishes; Task 14 files the
  spec edits D1/D4/D8.

### Plan 6 — draft status

A plan writer drafted plan 6 from spec §9, the opencode-TUI research and the keymap prototype, against plan 5
**as written** (plan 5 was not finished). If `docs/superpowers/plans/2026-09-26-06-tui.md` exists it is a draft:
after plan 5 merges, have a plan writer re-check it against the real code and pre-validate every task in a
scratch copy before executing it. If it does not exist, write plan 6 from scratch.

## Waves

- Plan 5 remaining: {4} → {5} → {6,9,10,11,12} → {13,14}. Tasks 9, 10, 12 each add lines to `src/cli.ts`
  (merge in order 9, 10, 12; keep every line). Tasks 10 and 13 both edit `src/tui/commands.ts` (10 first).

## Process that worked (keep it)

- superpowers `subagent-driven-development`, adapted by owner directive: bundle 1–3 tasks per agent, run
  independent batches in parallel git worktrees (`isolation: "worktree"`), workers on Opus 5.5
  (`opus-low` / `opus-medium` agent types if loaded, else general-purpose with `model: "opus"`).
- Contracts used for every dispatch are in `docs/superpowers/handoff/process/` — copy them to
  `.superpowers/sdd/` (gitignored) at session start: `worker-contract.md`, `reviewer-contract.md`
  (superpowers task-reviewer template), `re-reviewer-contract.md`. Dispatch prompts stay short: one line of
  context, the contract path, the brief path (`task-brief` script), the reset SHA, parallel-batch boundaries.
- **Worktree agents cannot write outside their worktree.** Their final message IS the report; the controller
  saves it as `task-N-report.md`, cherry-picks the commits onto the branch (`git cherry-pick <sha>`; the SHA
  changes), then generates the review package (`review-package` script) and dispatches the reviewer.
- Worktrees start at `main`: every batch agent must `git reset --hard <branch sha>` first.
- One review per batch (overlapped with the next wave), fix rounds by resuming the implementer
  (`SendMessage`) with a new reset SHA, scoped re-reviews, one final whole-branch review with one fix wave and
  its re-review. Plan-mandated defects are fixed when real, with a ledger ruling.
- Then: PR ready → Codex bot review (`@codex review` comment re-triggers) → fix every finding (or reply why
  not), reply on and resolve every thread → CI green → merge. Plan 4 took 7 Codex rounds; each found real bugs.
- One branch per session is imposed by the harness; one PR per plan. After a merge, restart the branch from
  `main` (`git checkout -B <branch> origin/main`, push with `--force-with-lease`).
- Ledger per plan in `.superpowers/sdd/<plan>/progress.md` (gitignored); copy it to
  `docs/superpowers/handoff/planN-ledger.md` when the plan merges. Rulings as
  `Ruling: <what> — <why> — <cost if wrong>`.
- Commit subjects ≤ 100 chars and not starting with a capital (commitlint). Never commit a `bun.lock`
  rewritten by an older Bun.
- Checks: `bun run typecheck && bun run lint && bun run format:check && bun test`. Bun ≥ 1.4 required.
- Tests that spawn processes must pass `env` explicitly. `withHome()` in `test/helpers.ts` sets `CATHERD_HOME`
  and `CATHERD_CLAUDE_AGENTS_DIR`. Tests that reach claude-code discovery must delete `ANTHROPIC_API_KEY`
  (plan 4 made that listing an HTTP call when the key is set).
- Remove finished agent worktrees (`git worktree remove --force`) to save disk.

## Carry-overs for later plans

- **Plan 5 (remaining tasks):** failover-key rewrite for native roles; lazy imports (supervisor still loads
  OpenTUI via `src/cli.ts` until Task 8 — now done, verify); role prompts; `finding`/`sameDefect` honour
  `jev.use`; the 0.x profile bridge is removed (Codex P1 on PR #6 about models.dev-only rungs is resolved by
  this). Deferred minors from plan-5 reviews: stored enums (billing mode, access, notify) are closed, so a newer
  value makes a profile unreadable; input-validation failures get no `tool` log row.
- **Plan 4 deferred minors** (see `plan4-ledger.md`): milestone typo in `land` matches no lane silently;
  cached Jev answers not schema-validated; `jevKey` returns null on a corrupt credentials file.
- **Plan 6:** `watch` shows 1.0 runs; TUI per spec §9 (reference: opencode TUI — `ctrl+p` palette,
  `ctrl+x` leader, 16 theme tokens, stay on `@opentui/react`); keymap prototype in
  `docs/research/2026-09-25-keymap-proto/`; move the TUI onto catalog-service/jev-service and retire
  `src/routing/{jev,catalog,select}.ts` and `catalog/catalog.json`; "treat like" picker and `inferred` markers;
  the theme colour-depth test must not read the terminal's environment.
- **Plan 7 (hardening):** test "finalizes a waiting dispatch as lost…" timing window → event-driven; runCli
  grandchild kill; macOS realpath and transient `ps` failure; Codex has no `isBusy` (long silent tool calls read
  as idle-timeout — track open item pairs); opencode `isBusy` has no time bound / checks only the first
  non-idle; preflight never-as-root; null `startTime` orphan cancel is pid-only; pgid not checked vs worker pid;
  cancel/exit race records cancelled; orphan exit.json always SIGTERM; tool-not-found labelled
  E_INPUT_INVALID; old spec.json not cleaned; supervisor.test.ts:172 timing; `doctor` calls `refreshDiscovery`
  and `testJevKey` and reports whether Codex is logged in with ChatGPT; macOS + Linux CI matrix; Changesets
  release of 1.0.
- **Plan 8:** Cursor CLI adapter (1.1), Grok CLI adapter (1.2) from `docs/research/2026-09-25-cursor-grok.md`,
  each through `test/adapters/contract.ts`, a simulator in `test/sim/`, live tests gated by `CATHERD_LIVE=1`.
- **Live verification (needs the owner's machine):** fixture capture with `CATHERD_LIVE=1` for OpenCode Go,
  Claude and Codex (`src/entry/capture-fixtures.ts`, default out `test/fixtures/adapters`); check
  `codex sandbox <os> --full-auto` and the hidden Jev-key prompt on a real TTY. Deliver as a short doc with
  exact commands.

Detailed ledgers, rulings and reviews of plans 1–5 are in this folder (`plan*-ledger.md`,
`plan*-final-review.md`, `plan*-preflight.md`, `plan5-worker-notes.md`).
