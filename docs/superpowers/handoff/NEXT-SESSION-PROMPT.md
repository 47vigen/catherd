# Prompt for the next session

Paste everything below the line into a new Claude Code session on `47vigen/catherd`.

---

You are continuing the catherd 1.0 rewrite on autopilot. Plans 1–3 are already merged into `main`.
You drive everything that remains through to release, with no check-ins: write plans, implement,
review, fix, open PRs, handle bot reviews, merge, and release. The owner granted this in these words:
"I want you to do anything you want, completely on autopilot from here: approving, releasing, merging,
anything. Do it until everything is done." Ask the owner only about a decision that is truly theirs to
make, such as a product choice the spec does not answer or an action you cannot undo outside the repo.
Record every other ambiguity as a ruling and keep going.

## 0. Set up the environment (do this first)

1. Install the superpowers plugin and use its skills throughout:
   ```
   claude plugin marketplace add anthropics/claude-plugins-official
   claude plugin install superpowers@claude-plugins-official
   ```
   If skills don't show up until a reload, ask the owner to run `/reload-skills` once, then continue.
   Follow `superpowers:using-superpowers`: invoke any skill that applies before acting.
2. Make sure Bun is at least 1.4 (`bun --version`). On 1.3.x, `test/tui/theme.test.ts` fails. If
   `bun upgrade` fails, download the release binary, copy it to `~/.bun/bin/bun.new`, then
   `mv -f bun.new bun`, because a direct copy fails with "Text file busy". Never commit a `bun.lock`
   that an older Bun rewrote.
3. Create two agent definitions, `~/.claude/agents/opus-low.md` and `opus-medium.md`
   (`model: claude-opus-5-5`, `effort: low` or `medium`, all tools), for workers. Custom agent types do
   not load mid-session. Until they do, use general-purpose agents with `model: "opus"`.
4. Run `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test`
   on `main`. It must be green before you start.

## 1. Read, in this order

1. `docs/superpowers/handoff/HANDOFF.md`: current state, the wave order for plans 4 and 5, the process that
   worked, the plan-5 rulings, and carry-overs for plans 5–7. **Start here.**
2. `docs/superpowers/specs/2026-09-25-catherd-1.0-design.md`: the binding spec, already approved and amended
   by the owner. The spec is the authority; a plan argues from it; your rulings settle what neither answers.
3. `docs/research/2026-09-25-*.md`, only when a plan or task needs it: audit, opencode, opencode-tui, tui,
   models, jev, cursor-grok.
4. The ledgers and final reviews of plans 1–3 in `docs/superpowers/handoff/`, only when you touch code a
   carry-over names.

## 2. What catherd is (short)

catherd is a Bun/TypeScript CLI, MCP server and Claude Code plugin that herds coding agents. Claude
plans and verifies. Workers write the code: Codex, OpenCode Go/Zen, or headless `claude-code`; Cursor
CLI arrives in 1.1 and Grok CLI in 1.2. Jev (TypeSafe) optionally routes model and effort "rungs"
written as `backend:model#effort`. The 1.0 layers are `domain → infra → adapters → services → entry`,
enforced by `test/architecture.test.ts`. Workers run under a detached supervisor, and all store writes
are atomic, locked and schema-versioned. Owner decisions already made:
- Audience: the owner's team plus public open-source quality.
- 1.0 is a clean break from 0.x.
- Claude runs both native and headless.
- The TUI is modelled on the opencode TUI: `@opentui/react`, `@opentui/keymap`, a `ctrl+p` palette, a
  `ctrl+x` leader and 16 theme tokens.
- Access mode can be set per profile and per role.
- Releases: 1.0, then Cursor in 1.1, then Grok in 1.2, versioned with Changesets.
- The owner holds OpenCode Go, Claude and Codex accounts.

## 3. Remaining work, in order

1. **Plan 4:** `docs/superpowers/plans/2026-09-25-04-catalog-routing.md` (11 tasks).
2. **Plan 5:** `docs/superpowers/plans/2026-09-25-05-profiles-cli-doctor.md` (14 tasks).
3. **Plan 6 (TUI), to write:** spec §9 plus `docs/research/2026-09-25-opencode-tui.md` and
   `docs/research/2026-09-25-keymap-proto/`. The TUI was the worst part of the MVP, so make it feel as
   solid as opencode's: keyboard-first, predictable shortcuts, no surprises.
4. **Plan 7 (hardening + release 1.0), to write:** every plan-7 carry-over in HANDOFF.md, a Linux + macOS
   CI matrix, live-test docs, the Changesets release of 1.0, and tag/publish per the repo's release
   tooling.
5. **Plan 8, to write:** Cursor CLI adapter (release 1.1), then Grok CLI adapter (release 1.2), using
   `docs/research/2026-09-25-cursor-grok.md`. Each goes through the same adapter contract suite
   (`test/adapters/contract.ts`), a simulator in `test/sim/`, and live tests gated by `CATHERD_LIVE=1`.
6. **Hand the owner a live-verification kit.** The owner runs it on their own machine with their Go,
   Claude and Codex accounts: `src/entry/capture-fixtures.ts` captures fixtures into
   `test/fixtures/adapters`. It must also check `codex sandbox --full-auto` and the hidden Jev-key
   prompt on a real TTY. Write it up as a short doc with exact commands.

Write each new plan with `superpowers:writing-plans`, using a plan-writer subagent. Have the writer
pre-validate the plan by building every task in a scratch copy, and commit the plan before you execute it.

## 4. How to execute each plan

This is the proven loop from plans 1–3. It is `superpowers:subagent-driven-development`, adapted by an
owner directive to save tokens and wall-clock time.

- **One branch and one PR per plan**, branched from the latest `main`. Open the PR as a draft and subscribe
  to its activity.
- **Keep a ledger** at `.superpowers/sdd/<plan>/progress.md` (gitignored). Its first line names the plan.
  Record every decision as `Ruling: <what> — <why> — <cost if wrong>`. After any context compaction, trust
  the ledger and `git log`, and never re-dispatch completed tasks.
- **Pre-flight scan:** before the first dispatch, check the plan for conflicts between tasks and against the
  spec. Rule on each one in the ledger.
- **Bundle and parallelise:** follow the plan's wave table. Give each batch of 1–3 sequential tasks to one
  agent. Run a wave's independent batches in parallel, each in its own git worktree
  (`isolation: "worktree"`). Worktrees start at `main`, so every batch agent must first run
  `git reset --hard <current branch sha>`.
- **Worker models:** Opus 5.5 at low effort for transcription-grade tasks where the plan contains the code;
  medium effort for integration or judgment work and for reviews. Always set the model explicitly.
- **Agent contract:** give each agent the task brief file, from the skill's `scripts/task-brief`, plus only
  the interfaces it needs. The agent writes its full report to a file and returns only status, commits, a
  one-line test summary and concerns. Agents never spawn subagents.
- **Integrate:** cherry-pick each finished batch into the plan branch, resolving conflicts yourself. Keep
  commit subjects to 100 characters or fewer (commitlint).
- **Review:** give each batch one review, using the review package from `scripts/review-package` with the
  batch's recorded BASE. Overlap that review with the next wave's implementation. Findings go through fix
  rounds with scoped re-reviews: rounds 1–3 resume the same implementer; rounds 4–5 use a fresh one on a
  stronger tier. Park non-blocking minors in the ledger for the final review.
- **Finish the plan:** after the last wave, run one whole-branch final review, then one fix wave and its
  scoped re-review. Then mark the PR ready and wait for the Codex bot review. Verify each finding
  (`superpowers:receiving-code-review`), fix it or reply why not, and resolve every thread. Once CI is
  green on the head, merge. For a flaky test, find the root cause: "flake" is never an answer, and you
  never skip or disable a test.
- **Verify before claiming:** run the full check chain (typecheck, lint, format:check, `bun test`) before
  every push (`superpowers:verification-before-completion`).

## 5. Constraints and lessons learned

- Tests that spawn processes must pass `env` explicitly, because Bun children don't see later `process.env`
  edits. `withHome()` in `test/helpers.ts` isolates `CATHERD_HOME` and `CATHERD_CLAUDE_AGENTS_DIR`, so no
  test may touch the real `~/.claude/agents` or `~/.local/share/catherd`.
- Tests must be event-driven, never timing-window-based: wait for the file or state that proves the
  condition, as the fix in d99e0e0 does.
- Secrets never reach disk or workers: `spec.json` holds overrides only (mode 0600), and `workerEnv`
  strips `TYPESAFE_API_KEY`.
- Read-only roles get no shell on opencode (`catherd-ro`) or on claude-code.
- OpenCode means **OpenCode Go and Zen** through the opencode v2 CLI, not OpenRouter. Don't fetch full
  model catalogs you don't need.
- Every Claude model (Fable, Opus, Sonnet, Haiku, …) and every Codex model must be selectable. Model lists
  come from `docs/research/2026-09-25-models.md` and the plan-4 catalog.
- Never put model identifiers in commits, PR titles or bodies, or code comments. End commits with the
  session's attribution lines.

## 6. Reporting

Keep chat output to one line per milestone: batch merged, review verdict, PR opened or merged, release
cut. At the end, give the owner a short report covering what shipped (1.0, 1.1, 1.2), links to the PRs
and releases, and the live-verification steps they still need to run on their machine.
