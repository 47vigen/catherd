# Prompt for the next session

Paste everything below the line into a new Claude Code session on `47vigen/catherd`.

---

You are continuing the catherd 1.0 rewrite on autopilot. Plans 1–5 are merged into `main`. Plan 6 (the TUI) is
written, re-checked against the real code and ready to execute. Plan 7 (hardening, CI matrix, live-test docs,
release 1.0) is written and pre-validated, but needs an anchor re-check after plan 6 merges. Plan 8 (Cursor 1.1,
Grok 1.2) is still to write.

You drive everything that remains through to release, with no check-ins: write plans, implement, review, fix,
open PRs, handle bot reviews, merge and release. The owner granted this in these words: "I want you to do
anything you want, completely on autopilot from here: approving, releasing, merging, anything. Do it until
everything is done."

Ask the owner only about a decision that is truly theirs to make, such as a product choice the spec does not
answer or an action you cannot undo outside the repo. Record every other ambiguity as a ruling and keep going.

## 0. Set up the environment (do this first)

1. Install the superpowers plugin and use its skills throughout:
   ```
   claude plugin marketplace add anthropics/claude-plugins-official
   claude plugin install superpowers@claude-plugins-official
   ```
   If the skills are not in your skill list after installing, read them directly from
   `~/.claude/plugins/cache/claude-plugins-official/superpowers/*/skills/`. Start with `using-superpowers`,
   `subagent-driven-development`, `writing-plans` and `requesting-code-review`.

   Their helper scripts are in `subagent-driven-development/scripts/`:
   - `sdd-workspace PLAN` prints the plan's workspace.
   - `task-brief PLAN N` extracts one task's brief.
   - `review-package PLAN BASE HEAD` writes the diff file a reviewer reads.

   Follow `superpowers:using-superpowers`: use any skill that applies before acting.
2. Make sure Bun is at least 1.4 (`bun --version`). `bun upgrade` may refuse to run, because it misreads its
   arguments in this container. If it does:
   - Download `https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64.zip` and unzip it.
   - Copy the binary to `~/.bun/bin/bun.new`, then run `mv -f ~/.bun/bin/bun.new ~/.bun/bin/bun`. A direct
     copy fails with "Text file busy".

   Never commit a `bun.lock` that an older Bun rewrote.
3. Create `~/.claude/agents/opus-low.md` and `~/.claude/agents/opus-medium.md` for workers. Give each the
   frontmatter `name`, `description`, `model: claude-opus-5-5`, and `effort: low` or `effort: medium`. They
   load only after a reload; until then use general-purpose agents with `model: "opus"`.
4. Copy the dispatch contracts into the gitignored workspace:
   `mkdir -p .superpowers/sdd && cp docs/superpowers/handoff/process/*.md .superpowers/sdd/`.
5. On `main`, run `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test`.
   It must be green before you start: about 950 pass at handoff.
6. Your harness names one development branch. Restart it on the latest `main` before each plan:
   `git fetch origin main && git checkout -B <branch> origin/main`, then push with `--force-with-lease`.

## 1. Read, in this order

1. `docs/superpowers/handoff/HANDOFF.md`. **Start here.** It covers:
   - the current state of every plan, and what plan 5 as built means for plans 6 and 7;
   - the rulings to apply when executing plan 6;
   - the process that worked, with its lessons;
   - the carry-overs;
   - two open owner questions, each with the default to apply.
2. `docs/superpowers/specs/2026-09-25-catherd-1.0-design.md`, the binding spec. The spec is the authority, a
   plan argues from it, and your rulings settle what neither answers.
3. `docs/superpowers/handoff/plan5-ledger.md`: plan 5's rulings, reviews and Codex rounds. Several of them
   change what later plans consume.
4. The plan you are about to execute. Read its Global Constraints, Review Focus, Rulings and Parallelism
   sections. Never make a worker read a whole plan; give it its task brief.
5. `docs/research/2026-09-25-*.md`, but only when a plan or task needs it.

## 2. What catherd is (short)

catherd is a Bun/TypeScript CLI, MCP server and Claude Code plugin that herds coding agents.
- Claude plans and verifies. Workers write the code: Codex, OpenCode Go/Zen, or headless `claude-code`.
  Cursor CLI arrives in 1.1 and Grok CLI in 1.2.
- Jev (TypeSafe) optionally routes model/effort "rungs", written `backend:model#effort`.
- Layers are `domain → infra → adapters → services → entry`, enforced by `test/architecture.test.ts`.
- Workers run under a detached supervisor. All store writes are atomic, locked and schema-versioned.
- ProfileService is the single writer of profiles, config, repo bindings and Claude agent links.
- A missing profile name means the profile the current repo runs on.

Owner decisions already made:
- The audience is the owner's team, with public open-source quality.
- 1.0 is a clean break from 0.x.
- Claude runs both native and headless.
- The TUI is modelled on the opencode TUI: `@opentui/react`, `@opentui/keymap`, a `ctrl+p` palette, a `ctrl+x`
  leader and 16 theme tokens.
- Access mode can be set per profile and per role.
- Releases go 1.0, then Cursor in 1.1, then Grok in 1.2, versioned with Changesets.
- The owner holds OpenCode Go, Claude and Codex accounts.

## 3. Remaining work, in order

1. **Plan 6 (TUI)**, `docs/superpowers/plans/2026-09-26-06-tui.md`. Execute it now; no re-check is needed. Its
   waves are {1,2,4} → {3,5} → {6} → {7} → {8} → {9,10} → {11} → {12} → {13}. Apply HANDOFF.md's plan-6
   rulings, including this one: inside a bound repo, the TUI shows and activates that repo's profile. The TUI
   was the worst part of the MVP. Make it feel as solid as opencode's: keyboard-first, predictable shortcuts,
   no surprises. Before the final review, run the real `catherd` and `catherd watch` in tmux and look at them.
2. **Plan 7 (hardening + release 1.0)**, `docs/superpowers/plans/2026-09-26-07-hardening-release.md`.
   - After plan 6 merges, have a plan writer re-check its anchors against `main`, replay its tasks in a scratch
     copy, and commit the fixes. Then execute it.
   - Its last task adds the 1.0.0 changeset. After that PR merges, the Release workflow opens
     "chore: release catherd".
   - Merging that PR publishes to npm. Hold it for the owner's live-verification results, unless the owner
     answered otherwise (HANDOFF.md, open question 2). Tell the owner exactly what to run, which is
     `docs/live-verification.md`, and wait.
3. **Plan 8, to write:** the Cursor CLI adapter (release 1.1), then the Grok CLI adapter (release 1.2), from
   `docs/research/2026-09-25-cursor-grok.md`. Each goes through `test/adapters/contract.ts`, gets a simulator in
   `test/sim/`, and gets live tests gated by `CATHERD_LIVE=1`. Use one PR and one changeset (minor) per release.
4. **The live-verification kit** is plan 7's Task 11 (`docs/live-verification.md`). Once it is on `main`, give
   the owner its exact commands in chat. It covers:
   - fixture capture with `src/entry/capture-fixtures.ts`;
   - `codex login status`;
   - `codex sandbox <os> --full-auto`;
   - the hidden Jev-key prompt on a real TTY.

Write each new plan with `superpowers:writing-plans`, using a plan-writer subagent. Have the writer pre-validate
the plan by building every task in a scratch copy, and commit the plan before you execute it. A plan writer can
run while the previous plan is still in review, since it only touches docs.

## 4. How to execute each plan

This is the proven loop from plans 1–5: `superpowers:subagent-driven-development`, adapted by owner directive to
save tokens and wall-clock time. HANDOFF.md has the details. The essentials:

- **One PR per plan**, from the branch restarted on the latest `main`.
  - Open it as a draft as soon as the first batch lands, and subscribe to its activity.
  - Schedule an hourly check-in with `send_later` while it is open, and delete the check-in after the merge.
- **Ledger** at `.superpowers/sdd/<plan>/progress.md` (gitignored). Its first line names the plan.
  - Record every decision as `Ruling: <what> — <why> — <cost if wrong>`.
  - After context compaction, trust the ledger and `git log`, and never re-dispatch completed tasks.
  - Copy the ledger into `docs/superpowers/handoff/planN-ledger.md` before the plan merges.
- **Pre-flight scan** before the first dispatch, by a read-only agent. It looks for conflicts between tasks,
  against the spec, and against the code as it really is. Rule on each conflict and hand the rulings to the
  workers in a notes file.
- **Bundle and parallelise** by the plan's wave table.
  - Give each batch of 1–3 sequential tasks to one agent in its own worktree (`isolation: "worktree"`).
  - Worktrees start at `main`, so each agent first runs `git reset --hard <current branch sha>`.
  - Worktree agents cannot write report files. Their final message is the report: save it, cherry-pick their
    commits onto the branch, and run the full gate on the combined head.
  - Keep a worker's worktree until its review passes, or the worker cannot be resumed for its fix round.
  - Start the next wave while the last batch is in review when the files are disjoint.
- **Reviews:**
  - One task review per batch, using the `review-package` diff and `.superpowers/sdd/reviewer-contract.md`.
  - Fix rounds resume the implementer with the findings and a new reset SHA. Scoped re-reviews follow, using
    `re-reviewer-contract.md`.
  - Fix one-line findings yourself, with a test.
  - Then run one final whole-branch review, from superpowers' `requesting-code-review/code-reviewer.md`
    template with a "Declined to judge" list, then one fix wave and its re-review.
  - Fix plan-mandated defects when they are real, with a ruling.
- **Then the bot rounds.**
  - Mark the PR ready. The Codex bot reviews it.
  - Fix every finding with a test that fails first and passes after, or reply saying why not.
  - Reply on each thread naming the fixing commit, and resolve it.
  - Re-trigger with an `@codex review` comment. Repeat until a round has no findings, or only findings you have
    answered.
  - Merge once CI is green. Plan 4 took 7 rounds; plan 5 took 3.
- **Worker models:** Opus 5.5. Use low effort for transcription-grade tasks where the plan contains the code,
  and medium for integration or judgment work and for reviews. Always set the model explicitly.
- **Rules:**
  - Commit subjects are at most 100 characters, with a lower-case first word (commitlint). A failed hook leaves
    the changes uncommitted, so check `git log`.
  - Tests that could reach the network delete `ANTHROPIC_API_KEY` (in-process) or pass
    `ANTHROPIC_API_KEY: ""` (spawned). Spawned processes get an explicit `env`.
  - Never use wall-clock sleeps for correctness.
