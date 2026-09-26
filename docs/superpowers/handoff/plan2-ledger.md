# SDD ledger — plan: docs/superpowers/plans/2026-09-25-02-run-service.md
Spec: docs/superpowers/specs/2026-09-25-catherd-1.0-design.md
Base: 9deaebc (main 67c0947 + plan commit). Plan code pre-validated by its writer in a scratch copy.
Batches: A1={1,2,3} → A2={4,5,6,7} → parallel worktrees B1={8,9,13,10} and B2={12,11} → C1={14} → parallel C2={15}, C3={16}. Reviews per batch, overlapped with the next batch.
Ruling: bundle sequential tasks per agent and overlap each batch's review with the next batch's implementation (user directive: fewer tokens, faster) — costs rework in later batches if a review finds an interface defect.
Ruling (plan writer): profile_set takes 1.0 rungs + failover + budget; other profile fields read as spec defaults until plan 5; one failover hop; dispatch blocks until finish; new codes E_RUN_COMMIT, E_RUN_NOT_LIVE, E_IO_PATH, E_IO_UNEXPECTED, E_INPUT_INVALID; preflight never-as-root and log file → plan 7; jev.jsonl header → plan 4; watch shows no 1.0 runs until plan 6 — accepted — costs a gap in those surfaces until their plans.
Plan-1 carry-overs owned by plan 2 (from plan-1 final review): supervisor SIGTERM/SIGHUP handler; unparsable spec → exit.json; readExit hiding newer schema; kill orphaned workers whose supervisor died; supervisor died before proc.json; stale claim recovery; proc.json schema+reader; JSONL headers at run creation; Codex isBusy. Check which plan 2 covers during review C1; add a fix task for the rest.
Batch A1 (T1-3): 9deaebc..d20608e implemented
Review A1: T1 approved; T2 Important (statusSnapshot/commitExists/gitHead treat git timeout/failure as clean/absent/"none"); T3 approved; 16 minors in review-A1.md.
Task 1: complete (review clean) · Task 3: complete (review clean)
Ruling: fold minors dispatchHints false "climb: unchanged" for read-only roles and parsePorcelainZ work-tree renames into the T2 fix round — later dispatch tasks build on both — costs a slightly larger fix.
Task 2: fix round 1 queued until batch A2 commits (same tree)
Ruling: test/helpers.ts withHome() also sets CATHERD_CLAUDE_AGENTS_DIR=<home>/claude-agents, so no test can write the real ~/.claude/agents (plan T4 test leaked; removed the two stray symlinks) — costs nothing
Batch A2 (T4-7): d20608e..16a60e0 implemented
Review A2: T4-T7 approved; 20 minors (review-A2.md). Notable deferred: bridge profile save unlocked (plan 5); listRuns throws on unreadable repo dir; readAgentRuns drops bad rows silently; proc.json null startTime loses reuse guard; updateState writes state.json before git (interacts with git fix); newer-schema runs.jsonl throws (reconcile/status must catch); budgetOf double read. → final review triage.
Task 4: complete · Task 5: complete · Task 6: complete · Task 7: complete (review clean)
Task 2: fix round 1/5 commits 16a60e0..b19267a (re-review bundled into batch-B review)
Ruling (git contract change carried into later tasks): git() → GitResult {ok|failed|timed-out}; gitHead → string|null (render "none" only for display); statusSnapshot and commitExists(timeout) throw E_IO_UNEXPECTED; updateState rejects on git failure. Later tasks adapt the brief code: (a) finalize catches E_IO_UNEXPECTED from statusSnapshot, still writes the RunRecord with changedOwned/violations [] and adds hint "git-unavailable: changed files unknown"; (b) a failed state.md refresh never fails dispatch/climb/land — catch, and add hint "state.md not refreshed: <message>"; (c) land with a commit check that times out returns the E_IO_UNEXPECTED error to the caller — costs brief deviations the reviewers must accept.
Batches B1={8,9,13,10} and B2={12,11} dispatched in parallel worktrees from b19267a
Batch B2 (T12,T11): cherry-picked b19267a..4da2dad
Review B2: T2 fix 3/3 ADDRESSED (Task 2: complete); T11 approved; T12 Important I1 (runCheck waits on pipes forever when a check detaches a process; holds a heavy slot). 17 minors in review-B2.md.
Ruling: extend git-contract ruling (b) to startRun and setNext (a failed state.md refresh returns a hint, never fails the call, never leaves an orphaned run) and keep climb's Next note on refresh failure like land (m10, m8) — consistent behaviour across all state writers — costs a small fix.
Task 11: fix round 1/5 (m10, m8) · Task 12: fix round 1/5 (I1)
Batch B1 (T8,9,13,10) done in worktree-agent-abfe32f9b019768aa (db969cf..17bd35b); cherry-pick after the B2 fix commits land. Notes: RunRecord gained optional gitUnavailable; ruling (b) applied to cancel+reconcile too; climb/land must respect gitUnavailable (check in review).
Review B1: T8,T9,T13,T10 comply; no Critical/Important; 13 minors (review-B1.md). Carry to plan-2 final fix wave: dispatch loses next note (pause) on git failure; launch-before-next-refresh (un-live window); cancel when supervisor dead + worker alive; failover hides limited run hints; launch.json write failure marks live run lost; unify 3 state-refresh helpers in state.ts; spec §4.3/§4.4 add gitUnavailable + hints. Adapter-chosen failover stand-in → plan 3 (opencode).
Task 8: complete · Task 9: complete · Task 13: complete · Task 10: complete (review clean)
Task 11/12: fix round 1 commits 4da2dad..d1d6418 (re-review bundled with Task 14 review)
Batch B1 cherry-picked d1d6418..86f40c2
Task 14: implemented 86f40c2..aa55823
Task 16: done in worktree-agent-abd33f7e0c9b915fd (738687b); cherry-pick after Task 15 commits
Review C1: B2 fix 3/3 ADDRESSED (Tasks 11, 12: complete); T14 complies; I1 (zod input rejection bypasses {code,message,fix}) → plan-2 final fix wave; 8 minors incl. f1 killGroup reaped pid after drain, set_next plain-text hint, profile_set strips unknown keys, lock signals (group, double SIGINT, SIGHUP), lock fallback warning, rung pattern flag-shaped model, Bun>=1.4 startup guard missing (→ plan 5 CLI or plan-2 final wave), dispatch/cancel hints not tested over MCP.
Task 14: complete (I1 carried into final fix wave)
Task 15: implemented a626db6 (tests only; restart steps made stricter with SIGKILL)
Task 16: cherry-picked -> f78dde9
Ruling: fold the Task 15 and Task 16 task reviews into the plan-2 final whole-branch review (tests-only and docs-only diffs) — costs a less focused look at those two
Flake noted: test/tui/matrix.test.tsx treat-like failed once in a full run (0.x TUI, replaced in plan 6)
Plan-2 final review: after fixes. MUST FIX: I1 spec.json env secrets (0644); I2 SDK zod errors unstructured; I3 cancel/dispatch hang with dead supervisor; m1 single state-refresh helper + next-after-launch; m2 failover keeps hints. T15, T16: pass (Task 15: complete · Task 16: complete). CAN WAIT per final-review.md triage table.
Final fix wave dispatched
Final fix wave f78dde9..7d0dbe5
Re-review final: 5/5 ADDRESSED, no new breakage; 7 deferred minors (rereview-final.md): null startTime orphan cancel pid-only, pgid not checked vs worker pid, backend.ts env comment stale, cancel/exit race records cancelled, orphan exit.json always SIGTERM, tool-not-found labelled E_INPUT_INVALID, old spec.json not cleaned → plan 7 hardening (comment fix → plan 3).
Plan 2: all tasks complete; final review clean after one fix wave
