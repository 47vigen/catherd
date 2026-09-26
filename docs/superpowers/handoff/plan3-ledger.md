# SDD ledger — plan: docs/superpowers/plans/2026-09-25-03-adapters.md
Spec: docs/superpowers/specs/2026-09-25-catherd-1.0-design.md · Base 6885432 (main 903bbbb + plan). Plan code pre-validated by its writer (661 pass in scratch; live checks vs claude 2.1.282 and @opencode/cli 2.0.16).
Batches: wave1 parallel worktrees X1={1→2}, X2={3→6}, X3={4}, X4={9} → wave2 parallel Y1={5}, Y2={7→8} → Z={10→11}. One review per batch overlapped with the next wave.
Ruling (plan writer): Claude isolation via --safe-mode (not --bare, which drops OAuth); every fresh claude-code run passes --session-id; claude-code access via dontAsk/acceptEdits/bypassPermissions + allow/deny lists + no permission prompts; full access refused as root unless IS_SANDBOX; opencode agents via frontmatter permissions + 'opencode reload'; isolated opencode via --standalone; Go→Zen only with same model+variant; until plan 5 architect/verifier native, other Claude roles headless, Claude stand-ins headless; opencode totals = session totals minus earlier records on that session — accepted — costs rework in plan 5 if the native/headless default changes.
Carry-overs owned here: supervise-bin explicit exit; contract suite gaps (in Task 1); backend.ts env comment stale (fold into Task 1).
X1 (T1,T2) cherry-picked -> 93035cc; commit subjects shortened for commitlint (100 chars)
X2 (T3,T6) and X3 (T4,T9) cherry-picked -> 9dba616
Y1 (T5) cherry-picked -> b104e9e
Y2 (T7,T8) cherry-picked -> 80ac0b5 (all.ts conflict resolved: codex, claude-code, opencode)
Review W1: T1,T2,T3,T4,T9 pass (minors); T6 Important: catherd-ro shell allowlist escapes (rg --pre, git --output, chaining). 16 minors in review-W1.md.
Task 1: complete · Task 2: complete · Task 3: complete · Task 4: complete · Task 9: complete (review clean)
Ruling: fold T2 minor "prepare has no timeout" into the T6 fix round (bounded by the same runCli timeout) — cheap, same area — costs nothing. T9 failover-key rewrite for native roles → plan 5 (profiles). runCli grandchild kill → plan 7.
Task 6: fix round 1/5 dispatched · Wave Z (T10→T11) dispatched in worktree from 80ac0b5
Z (T10,T11) done in worktree-agent-a01a974a2857ae7d6 (b742bf4, 5037123); cherry-pick after T6 fix lands. Note: capture default dir test/fixtures/<backend>/<version>/ vs contract fixtures test/fixtures/adapters/ → final review
Task 6: fix round 1 commits 80ac0b5..d9d840c (catherd-ro deny rules; prepare bounded at 60 s)
Ruling: catherd-ro gets no shell at all — opencode strips redirects after lists/pipelines from every resource (permission.test.ts:441,452), so no rule set makes a shell read-only; read-only roles use read/grep/glob; skill tells orchestrators to list files for such briefs — costs reviewers on opencode the ability to run git diff
Task 6: fix round 2/5 dispatched (no-shell ruling)
Task 6: fix round 2 commit c2d852a (catherd-ro no shell)
Z (T10,T11) cherry-picked -> bd64b93
Plan-3 final review: after fixes — I1 opencode limitRetry reads old messages; I2 claude-code read-only rg/--output escapes; I3 Owns test timing (100 ms sleep vs probe). T5,T7,T8,T10,T11 pass (after fixes). Task 6 fix rounds ADDRESSED → Task 6: complete.
Ruling: claude-code read-only gets no Bash (same as opencode catherd-ro) — costs claude-code reviewers the ability to run git diff
Ruling: capture default --out = test/fixtures/adapters; spec §11.8 amended — costs nothing
Final fix wave dispatched
Final fix wave bd64b93..b7df77d
Re-review final: 4/4 ADDRESSED; time.created confirmed (opencode schema session-message.ts:35); 4 deferred minors (isBusy no time bound, first non-idle only, capture subfolder vs flat, researcher asked for suite time without shell → role-prompts in plan 5).
Task 5: complete · Task 7: complete · Task 8: complete · Task 10: complete · Task 11: complete
Plan 3: all tasks complete; final review clean after one fix wave
