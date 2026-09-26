# Prompt for the next session

Paste everything below the line into a new Claude Code session on `47vigen/catherd`.

---

You are continuing the catherd 1.0 rewrite on autopilot. Plans 1–4 are merged into `main`, and plan 5 is
partly merged: tasks 1, 2, 3, 7 and 8 are on `main`. You drive everything that remains through to release, with
no check-ins: write plans, implement, review, fix, open PRs, handle bot reviews, merge, and release. The owner
granted this in these words: "I want you to do anything you want, completely on autopilot from here:
approving, releasing, merging, anything. Do it until everything is done." Ask the owner only about a decision
that is truly theirs to make, such as a product choice the spec does not answer or an action you cannot undo
outside the repo. Record every other ambiguity as a ruling and keep going.

## 0. Set up the environment (do this first)

1. Install the superpowers plugin and use its skills throughout:
   ```
   claude plugin marketplace add anthropics/claude-plugins-official
   claude plugin install superpowers@claude-plugins-official
   ```
   If the skills are not in your skill list after installing, read them directly from
   `~/.claude/plugins/cache/claude-plugins-official/superpowers/*/skills/` (start with
   `using-superpowers`, `subagent-driven-development`, `writing-plans`, `requesting-code-review`). Their
   helper scripts live in `subagent-driven-development/scripts/` (`sdd-workspace`, `task-brief`,
   `review-package`). Follow `superpowers:using-superpowers`: use any skill that applies before acting.
2. Make sure Bun is at least 1.4 (`bun --version`). `bun upgrade` may refuse to run (it misreads its
   arguments in this container). If so, download
   `https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64.zip`, unzip it, copy the binary to
   `~/.bun/bin/bun.new`, then `mv -f ~/.bun/bin/bun.new ~/.bun/bin/bun` (a direct copy fails with "Text file
   busy"). Never commit a `bun.lock` that an older Bun rewrote.
3. Create `~/.claude/agents/opus-low.md` and `opus-medium.md` (frontmatter: `name`, `description`,
   `model: claude-opus-5-5`, `effort: low` or `medium`) for workers. They may only load after a reload; until
   then use general-purpose agents with `model: "opus"`.
4. Copy the dispatch contracts into the gitignored workspace:
   `mkdir -p .superpowers/sdd && cp docs/superpowers/handoff/process/*.md .superpowers/sdd/`.
5. Run `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test`
   on `main`. It must be green before you start (884 tests at handoff).

## 1. Read, in this order

1. `docs/superpowers/handoff/HANDOFF.md`: current state, exactly where plan 5 stopped, the process that
   worked (including the worktree/report mechanics), and the carry-overs for plans 5–8. **Start here.**
2. `docs/superpowers/specs/2026-09-25-catherd-1.0-design.md`: the binding spec. The spec is the authority; a
   plan argues from it; your rulings settle what neither answers.
3. `docs/superpowers/handoff/plan5-ledger.md`, `plan5-preflight.md` and `plan5-worker-notes.md`: plan 5's
   rulings, its conflict table, and the notes every plan-5 worker must read (plan 4 as built differs from plan
   4 as written).
4. `docs/research/2026-09-25-*.md` only when a plan or task needs it; older ledgers only when you touch code a
   carry-over names.

## 2. What catherd is (short)

catherd is a Bun/TypeScript CLI, MCP server and Claude Code plugin that herds coding agents. Claude plans and
verifies; workers write the code: Codex, OpenCode Go/Zen, or headless `claude-code` (Cursor CLI in 1.1, Grok
CLI in 1.2). Jev (TypeSafe) optionally routes model/effort "rungs" written `backend:model#effort`. Layers are
`domain → infra → adapters → services → entry`, enforced by `test/architecture.test.ts`. Workers run under a
detached supervisor; all store writes are atomic, locked and schema-versioned. Owner decisions already made:
audience is the owner's team plus public open-source quality; 1.0 is a clean break from 0.x; Claude runs both
native and headless; the TUI is modelled on the opencode TUI (`@opentui/react`, `@opentui/keymap`, a `ctrl+p`
palette, a `ctrl+x` leader, 16 theme tokens); access mode can be set per profile and per role; releases are
1.0, then Cursor in 1.1, then Grok in 1.2, versioned with Changesets; the owner holds OpenCode Go, Claude and
Codex accounts.

## 3. Remaining work, in order

1. **Finish plan 5** (`docs/superpowers/plans/2026-09-25-05-profiles-cli-doctor.md`). First run the pending
   task reviews for Tasks 2, 3 and 8 (already on `main`) and fix any findings. Then waves {4} → {5} →
   {6, 9, 10, 11, 12} → {13, 14}, applying the pre-flight rulings in `plan5-ledger.md`. Then the final
   whole-branch review over all of plan 5, the Codex bot rounds, and merge.
2. **Plan 6 (TUI):** `docs/superpowers/plans/2026-09-26-06-tui.md` is written (13 tasks; tasks 1–12
   pre-validated against plan 5 as written). After plan 5 merges, have a plan writer re-check it against the
   real code, pre-validate Tasks 12–13, commit the fixes, then execute it. HANDOFF.md lists its open rulings.
   The TUI was the worst part of the MVP: make it feel as solid as opencode's — keyboard-first, predictable
   shortcuts, no surprises.
3. **Plan 7 (hardening + release 1.0), to write:** every plan-7 carry-over in HANDOFF.md, a Linux + macOS CI
   matrix, live-test docs, the Changesets release of 1.0, and tag/publish per the repo's release tooling.
4. **Plan 8, to write:** Cursor CLI adapter (release 1.1), then Grok CLI adapter (release 1.2), from
   `docs/research/2026-09-25-cursor-grok.md`, each through `test/adapters/contract.ts`, a simulator in
   `test/sim/`, and live tests gated by `CATHERD_LIVE=1`.
5. **Hand the owner a live-verification kit** they run on their own machine with their Go, Claude and Codex
   accounts: `src/entry/capture-fixtures.ts` captures fixtures into `test/fixtures/adapters`; it must also check
   `codex sandbox --full-auto` and the hidden Jev-key prompt on a real TTY. Write it as a short doc with exact
   commands.

Write each new plan with `superpowers:writing-plans`, using a plan-writer subagent. Have the writer
pre-validate the plan by building every task in a scratch copy, and commit the plan before you execute it.

## 4. How to execute each plan

This is the proven loop from plans 1–5 (`superpowers:subagent-driven-development`, adapted by owner directive
to save tokens and wall-clock time). HANDOFF.md has the details; the essentials:

- **One PR per plan**, from a branch restarted on the latest `main`. Open it as a draft, subscribe to its
  activity, and schedule an hourly check-in while it is open.
- **Ledger** at `.superpowers/sdd/<plan>/progress.md` (gitignored); first line names the plan. Record every
  decision as `Ruling: <what> — <why> — <cost if wrong>`. After context compaction, trust the ledger and
  `git log`, and never re-dispatch completed tasks. Copy the ledger into `docs/superpowers/handoff/` when the
  plan merges.
- **Pre-flight scan** (a read-only agent) before the first dispatch: conflicts between tasks, against the spec,
  and against the code as it really is. Rule on each one in the ledger and hand the rulings to the workers in a
  notes file.
- **Bundle and parallelise:** follow the plan's wave table. Give each batch of 1–3 sequential tasks to one agent
  in its own worktree (`isolation: "worktree"`); worktrees start at `main`, so each agent first runs
  `git reset --hard <current branch sha>`. Worktree agents cannot write report files: their final message is
  the report; save it, cherry-pick their commits onto the branch, then review.
- **Reviews:** one task review per batch (overlapped with the next wave), fix rounds by resuming the implementer
  with the findings and a new reset SHA, scoped re-reviews, then one final whole-branch review, one fix wave and
  its re-review. Plan-mandated defects get fixed when real, with a ruling.
- **Then:** mark the PR ready → Codex bot reviews → fix every finding (or reply why not), reply on and resolve
  every thread, re-trigger with a `@codex review` comment → CI green → merge. Expect several rounds.
- **Worker models:** Opus 5.5; low effort for transcription-grade tasks where the plan contains the code, medium
  for integration or judgment work and for reviews. Always set the model explicitly.
- Commit subjects ≤ 100 characters and lower-case first word (commitlint). Tests that could reach the network
  must delete `ANTHROPIC_API_KEY` / set `PATH=/nonexistent`.
