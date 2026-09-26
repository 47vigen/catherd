# catherd 1.0 — handoff (2026-09-26)

This file carries the working state of the 1.0 rewrite from one agent session to the next.
Read it after the spec, before touching any plan.

## Where things stand

| Plan | File | State |
| ---- | ---- | ----- |
| 1 foundation | `docs/superpowers/plans/2026-09-25-01-foundation.md` | merged (PR #3) |
| 2 run service + MCP | `…-02-run-service.md` | merged (PR #4) |
| 3 adapters (claude-code, opencode v2, capture kit) | `…-03-adapters.md` | merged (PR #5) |
| 4 catalog + routing (Jev route-v2, outcomes) | `…-04-catalog-routing.md` | written, pre-validated in a scratch copy, **not started** |
| 5 profiles, CLI, doctor, init | `…-05-profiles-cli-doctor.md` | written, pre-validated (864 pass / 10 skip on main+plan-4 replay), **not started** |
| 6 TUI (opencode-style, `@opentui/keymap`) | — | to write |
| 7 hardening, CI matrix, release 1.0 (Changesets) | — | to write |
| 8 Cursor CLI (1.1), Grok CLI (1.2) | — | to write |

Authority order: spec `docs/superpowers/specs/2026-09-25-catherd-1.0-design.md` → plan → rulings.
Research behind the spec: `docs/research/2026-09-25-*.md` (audit, opencode, opencode-tui, tui, models, jev, cursor-grok).

## Waves

- Plan 4 (11 tasks): {1,4,5,6} → {2,8} → {3,7} → {9} → {10,11}
- Plan 5 (14 tasks): {1,7} → {2,3,8} → {4} → {5} → {6,9,10,11,12} → {13,14}

## Process that worked (keep it)

- superpowers `subagent-driven-development`, adapted by user directive: bundle tasks per agent, run
  independent batches in parallel git worktrees, subagents on Opus 5.5 at low/medium effort
  (agent types `opus-low` / `opus-medium` if they exist, else general-purpose with model `opus`).
- Worktrees start at `main`: every batch agent must `git reset --hard <branch sha>` first.
- Agents write their full report to a file and return a short status; the controller cherry-picks batches
  into the branch, then one review per batch (overlapped with the next wave's implementation),
  fix rounds with scoped re-reviews, one final whole-branch review with one fix wave and its re-review.
- Then: PR ready → Codex bot review → fix findings, reply on and resolve every thread → CI green → merge.
- Ledger per plan in `.superpowers/sdd/<plan>/progress.md` (gitignored); rulings as
  `Ruling: <what> — <why> — <cost if wrong>`.
- Commit subjects ≤ 100 chars (commitlint). Never commit a `bun.lock` rewritten by an older Bun.
- Checks: `bun run typecheck && bun run lint && bun run format:check && bun test`. Bun ≥ 1.4 required
  (1.3.x fails `test/tui/theme.test.ts`).
- Tests that spawn processes must pass `env` explicitly (Bun children do not see later `process.env` edits).
  `withHome()` in `test/helpers.ts` sets `CATHERD_HOME` and `CATHERD_CLAUDE_AGENTS_DIR`.

## Plan-5 writer rulings (already reflected in the plan)

- Native vs headless Claude is the rung's backend (`claude:` vs `claude-code:`); no extra per-role field.
- Default failover: Luna → Go's own GPT-6 Luna; the three Sol rungs → Go Kimi K3 #max via a shipped
  treat-like to sol#medium; shown as inferred, nothing extra stored.
- "Same backend" for a stand-in means same quota: `claude` + `claude-code` are one; Go and Zen are two.
- Profile names `[a-z0-9-]`, ≤ 32 chars. One sync lock for profiles, config, projects, agent files, links.
- A 0.x file is refused with fix "run catherd init"; `init` moves 0.x files to a backup folder (no migration).
- `doctor` sorts checks into fail/warn/skip; exit 3 on any fail. `watch` without `--once` redraws plain text until plan 6.
- Unproven: `codex sandbox <os> --full-auto` vs a real Codex CLI; the hidden Jev-key prompt on a real TTY.

## Carry-overs for later plans

- **Plan 7 (hardening):** test "finalizes a waiting dispatch as lost…" has the same short-timing-window
  pattern fixed in d99e0e0 — make it event-driven; runCli grandchild kill; macOS realpath and transient `ps`
  failure; Codex has no `isBusy` (long silent tool calls read as idle-timeout — track open item pairs);
  opencode `isBusy` has no time bound / checks only the first non-idle; preflight never-as-root; log file;
  null `startTime` orphan cancel is pid-only; pgid not checked vs worker pid; cancel/exit race records
  cancelled; orphan exit.json always SIGTERM; tool-not-found labelled E_INPUT_INVALID; old spec.json not
  cleaned; supervisor.test.ts:172 timing; macOS + Linux CI matrix.
- **Plan 5:** failover-key rewrite for native roles; `_supervise` hidden; lazy imports (supervisor still loads
  OpenTUI via `src/cli.ts` until then); role prompts (researcher asked for suite time without a shell).
- **Plan 6:** `watch` shows 1.0 runs; TUI per spec §9 (reference: opencode TUI — `ctrl+p` palette,
  `ctrl+x` leader, 16 theme tokens, stay on `@opentui/react`); keymap prototype in
  `docs/research/2026-09-25-keymap-proto/`.
- **Live verification (needs the user's machine):** fixture capture with `CATHERD_LIVE=1` for OpenCode Go,
  Claude and Codex (`src/entry/capture-fixtures.ts`, default out `test/fixtures/adapters`).

Detailed ledgers, rulings and final reviews of plans 1–3 are in this folder (`plan*-ledger.md`,
`plan*-final-review.md`, `plan*-rereview-final.md`, `plan3-progress.md`).
