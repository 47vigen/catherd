# Real run report: the sanitell/platform auth build (2026-09-26/27)

catherd 0.2.1 (CLI and plugin), one Claude Desktop session (Opus 5.5) running five catherd runs back to back, Codex
backend only, profile `default` (objective cost, `harness.codex.isolated: true`). The work: six finished auth plans in
`sanitell/platform/docs/plans/2026-09-25-auth-*.md`, prompt "the plans are final; the architect only translates them
into lanes; one branch and MR per plan MR; merge to staging when green". Data: each run's `runs.jsonl`,
`routes.jsonl`, `harness.jsonl`, `ledger.md`, and the session transcript.

## Outcome

16 MRs merged to staging, 607 files, +35.6k / -22.9k lines, 20.3 h wall (12:28 to 09:51 Tehran, stopped by the user
during the fifth run).

| Run | Wall | Milestones | MRs |
|---|---|---|---|
| auth-3-kit MRs 1-4 | 4.7 h | 4 | !36 !37 !39 !40 |
| auth-1-service S1-S5 | 6.7 h | 5 | !38 !41 !42 !43 !44 (S5 held 4.5 h on an owner question about the Harbor project) |
| auth-2-panel MRs 1-5 | 1.8 h | 3 landings | !46 !48 !49 !50 |
| auth-4-notification | 2.0 h of Codex, ~5 h wall | 4 | !52 (acceptance 36/36, real OTP, browser SSO check) |
| auth-5 MR A (verification) | 1.7 h, stopped | 4 of 5 | not pushed; full gate and verification acceptance green |

Kit MR 5 (!51) and the Harbor-paths MR were done by the main thread outside any run.

## Numbers

- **Codex:** 187 dispatches, every one exited ok. 262M input tokens (95 % cached), 1.5M output.
  - sol medium 110 dispatches, avg 2.5 min; sol high 38, avg 4.1 min; luna high 21, avg 2.6 min; sol xhigh 2, avg
    6.5 min; reviewer (sol high) 13, avg 2.6 min; researcher (luna high) 3, avg 4.5 min.
- **Main thread (Opus):** 1,462 turns, 454M cache-read tokens, 2.5M cache-write, 0.76M output, four compactions.
  About 1,000 Bash calls: 156 `go test`/`task check`, 71 pnpm chains, 104 git, 78 glab, 46 sleep/poll loops; 142
  browser batches.
- **Claude agents:** 5 architect calls (one per run; 14 min in the first run), 9 verifier calls (all in the first two
  runs).
- **Codex concurrency over the whole 20.3 h:** two roles at once for 25 min, one role for 8.2 h, **none for 11.7 h**.
- **Jev:** 33 of 55 routes decided by Jev (60 %) in the first two runs; never called in runs 3-5.
- **Climbs:** 8.
- **Worker replies:** 60 of 171 `partial` or `blocked`.

## Findings, causes, fixes

1. **Workers cannot run their own checks.**
   - Evidence: nearly every `partial`/`blocked` reply says the sandbox denied Docker (testcontainers), loopback port
     binding, or the lock (the lock dir is outside the workspace).
   - Effect: workers ship untested code. The Opus main thread ran the tests itself (156 Go, 71 pnpm), and from 04:20
     to 07:30 debugged the notification acceptance suite by editing test files, breaking "the orchestrator never edits
     product files". This is where most Claude tokens went.
   - Fix: the worker sandbox gets network access, the lock dir as a writable root and `DOCKER_HOST`; or a
     `check(run, lane)` tool runs a lane's fast check outside the sandbox, behind the lock, and returns the tail.
2. **Parallel dispatch is serial.**
   - Evidence: four `dispatch` calls sent in one message at 09:20 started at 09:20, 09:22, 09:24 and 09:28. At most
     two roles ever overlapped.
   - Cause: Claude Code runs MCP tool calls that are not read-only one after another.
   - Fix: `dispatch` spawns and returns a handle; `wait(run, any: true)` blocks until the next role finishes. That also
     removes the polling loops (finding 7).
3. **The skill decays after compaction.**
   - Evidence: runs 1-2, started before any compaction, followed the full protocol. Runs 3-5, started after
     compactions, called no `route` (no Jev, no ladder), dispatched no reviewer and no verifier. The main thread ran
     the gates itself. Quality held (acceptance, browser checks), but it came from Opus, not from the roles.
   - Fix: `run_start` returns the per-run checklist; `state.md` names the next protocol step; `land` refuses a
     milestone without a reviewer result and a verifier verdict unless the run says why.
4. **One owner question stops the whole session.**
   - Evidence: the Harbor question held everything for 4.5 h (20:00 to 00:16), though plan 2 did not depend on it.
   - Fix: a blocked milestone parks with a push; independent milestones and runs continue.
5. **Misrouted climbs.**
   - Evidence: of 8 climbs, 4 were right (reviewer BLOCKERs: a non-atomic refresh spend, a TOTP claim after reset, a
     cold directory with no grant). 4 were not capability problems: a plan test contradicting plan code, a file
     outside the lane's ownership, a pin-check quirk. A stronger model cannot fix those.
   - Fix: before climbing a `blocked` reply, `ask(run, "finding")`. `design` or ownership goes to the architect, not
     up the ladder.
6. **The verifier ran in the background.** All nine verifier calls were `run_in_background: true`; the skill requires
   foreground so the gate survives a closed session. Fix: `land` records how the verdict was produced; the skill's
   mistakes table already names this.
7. **Polling.** 46 sleep/until/kill -0 loops on the main thread, which the skill forbids. Cause: waiting on
   backgrounded dispatches. Fix: finding 2's `wait` tool.
8. **Plan in hand costs a full design pass.** The researcher (5 min, 1.1M tokens) re-mapped files the plans already
   named; the architect took 14 min at high effort to split a finished plan. Fix: see "Plan in hand" in `../ideas.md`.
9. **Lint found only at the gate.** Both first-milestone fix rounds were lint findings. Fix: a lane's fast check runs
   the linter on its own packages.
10. **`status` harness line.** It says "codex native" while every dispatch is isolated, and prints "~-528k", because
    it compares against past native runs on tiny repos. Fix: show the current run's mode; compare only same-repo runs.

## What worked

- The build finished with the user away, except for one real owner question. All 16 MRs were opened, merged and
  green in CI.
- Reviewers caught real BLOCKERs and BUGs in most milestones, and every fix was re-checked.
- When code and plan disagreed, the orchestrator stopped and asked instead of guessing (the Harbor project name).
- Decisions (D1 to D23 per run) and deviations were recorded in `plan.md` and in each MR body.
- Mechanics held: a worktree per run, climbs, the CPU lock, state and ledger files, and Codex prompt caching (95 %).
- Newly covered live: a climb (8 of them) and a real multi-milestone, multi-MR build. Still not covered live: an
  opencode lane, quota failover, a budget stop.

## Priority

1. Worker checks (finding 1). 2. Real parallel dispatch plus `wait` (findings 2 and 7). 3. Protocol re-entry after
compaction (finding 3). 4. Park a blocked milestone (finding 4). 5. Climb routing (finding 5). Then the smaller items.
Re-run the rest of plan 5 (MR A's last milestone, then MR B) on the fixed build to compare against this report.
