# SDD ledger — plan: docs/superpowers/plans/2026-09-26-07-hardening-release.md
--- session 4 (2026-09-26) ---
Plan 6 merged (PR #9 → main 6195f4e). Branch claude/great-dijkstra-85qdx7 restarted at 6195f4e.
Ruling (OWNER): Codex fix rounds capped at 4 per PR.
Ruling: open question 1 default No (no ~/.config/typesafe/api_key read; MIGRATION says init asks once); open question 2 default: live kit BEFORE merging the release PR — owner unanswered — cost: release waits on owner.
Delta re-check + preflight dispatched (worktree at 6195f4e): fix anchors changed since b77f0de, reconcile T10 pty with main, add Task 14 (Codex r6 deferred: activate scope re-check; revert re-reads disk).
Plan re-check committed: b43c050 (cherry-pick of 3bc10c0); replay 1035 pass. Waves: {1,3,4,5,6,10,13,14} → {2} → {7,8} → {9,11} → {12}.
Preflight (in writer report): 0 interface conflicts; ordering rows kept. Rulings adopted:
Ruling: T10 coverage floor via test/coverage-floor.ts over lcov totals (Bun's coverageThreshold is per-file) at 88/85 — spec §11 floor met — cost: one script.
Ruling: edited ci.yml not actionlinted locally; first CI run is the check — actionlint unavailable — cost: a CI fix commit.
Ruling: T14 activate keeps a small re-read→write window (no binding CAS in service); writes exactly the confirmed scope; service CAS is 1.0.x — cost: rare stale scope.
Ruling: T14 revert with unreadable file keeps the draft + toast — cost: none.
Ruling: Save & make active with changed binding saves, then re-asks activation — spec §9.2 activation is its own confirmation — cost: none.
Ruling: T14 base comparison JSON vs deep-equal mismatch harmless; T14 may change plan-6 Effects interface; T6 open enums not TUI-tested (1.0.x).
Wave 1 batches (worktrees, reset b43c050): A=T1, B=T3, C=T4, D=T5, E=T6, F=T10, G=T13+T14.
T5 cherry-picked b43c050..d961192 (5b2ccfe).
T3 cherry-picked d961192..feef112 (a80cf8e).
T4 cherry-picked feef112..72f6601 (4c2544d). Checked T3/T4/T5 commits: only own files (scratchpad collision contained).
T1 cherry-picked 72f6601..db355ea (e2bd95e). Draft PR #10 opened. Ruling: future worker prompts say scratch files go inside the worktree (shared scratchpad collided twice) — cost: none.
T2 dispatched (worktree, reset db355ea). Review T1,T3,T4,T5 dispatched (b43c050..db355ea).
T6 cherry-picked db355ea..4af64a8 (ffcacc2).
T10 done (66bde08, local branch t10-hold). Ruling: cherry-pick T10 right after T9 — macOS legs red until T9 — cost: CI matrix untested on the branch until wave 4.
T13,T14 cherry-picked 4af64a8..c6bd319 (c1185d7,9b0f78a).
Wave1a review (wave1a-review.md): T1,T3,T4,T5 ✅ approved. Minors → final: T1 supervisor.ts:274 race timer not cleared (_supervise lingers ≤10 s); ignored interrupt gets two kill graces (20 s); T3 test pgid=process.pid risk, scrub stats every spec.json per MCP start; T4 toolOf null for output-validation message; T5 corrupt credentials warns every jevKey() call (once per process). ⚠️ supervise.ts wiring of item/sinceMs is Task 2; doctor key-file row is Task 8.
Task 1: complete (e2bd95e→db355ea). Task 3: complete. Task 4: complete. Task 5: complete.
Wave1b review: T6 ✅ approved, T10 ✅ approved. Minors → final: TUI validate doesn't pass stored doc (no unknown-value warnings in TUI); DEFAULT_BILLING own-property check; orphaned JSDoc on validateProfile; release PR opened with GITHUB_TOKEN gets no pull_request CI (publish still gated by release rerun); pack smoke temp dir not deleted, raw stack on non-JSON doctor output.
Task 6: complete (4af64a8). Task 10: complete (66bde08, held on t10-hold until T9).
T2 cherry-picked c6bd319..57b6c9c (a734b3c).
Wave 3: T7, T8 dispatched (worktrees, reset 57b6c9c). T2 review dispatched.
Wave1c review: T13 ✅, T14 ✅ approved. Minors → final: bare '<leader>' key not refused; T14 untested paths (revert when profile deleted; re-ask when repo already bound to same profile). Task 13: complete. Task 14: complete. (SHA note: cherry-picks change SHAs — expected.)
T2 review: ✅ approved. Minors: detached runCli → ctrl+c doesn't reach in-flight CLI queries (bounded by timeout); codex sh doc comment. Task 2: complete.
T7 cherry-picked 57b6c9c..a06ea21 (aeb6cdc).
T8 cherry-picked a06ea21..6b8b4f1 (527e481).
Wave 4: T9, T11 dispatched (worktrees, reset 6b8b4f1). T7/T8 review dispatched (57b6c9c..6b8b4f1).
Wave3 review: T7 ✅, T8 ✅ approved. Minors → final: run-debug tail quadratic on long last lines; cli.test --plain lock finally reads maybe-missing pid file; T8 stdout path untested; mismatch names first profile only; fallback fix wording; unreadable-credentials test doesn't check detail. Task 7: complete. Task 8: complete.
T11 cherry-picked 6b8b4f1..87fbf37 (ca40d14).
T9 + T10 cherry-picked 87fbf37..eb74f56 (9e71022, 66bde08). Risk: tmux -S socket under long macOS TMPDIR may exceed sun_path (104) — watch macOS legs.
Gate at eb74f56: 1034 pass 10 skip 0 fail. T12 dispatched (worktree, reset eb74f56). T9/T11 review dispatched (6b8b4f1..82deb81).
macOS CI (eb74f56) red: 5 fails — ps not on narrow PATH (proc.ts spawns "ps") → locks fail → initSetup, catherd catalog. Fix 0a47e7b: /bin/ps absolute + null on failure + tests.
T12 cherry-picked df2b299 (c7e2cf1). Task 12: pending review.
Wave4 review: T9 ✅ approved; T11 ✅ needs fixes — Important: live kit lacks codex login status stream check → controller fix eef6b4e (+ CATHERD_HOME locks note). PTY socket long-TMPDIR guard → controller fix 22c753f. Minors → final: capture timeout test doesn't prove group kill; capture leaves group members after normal exit; long lines in doc.
Task 9: complete. Task 11: complete (with eef6b4e).
All 14 tasks implemented. Gate at 22c753f: 1037 pass 0 fail. Final whole-branch review dispatched (6195f4e..22c753f).
CI at 22c753f: all 5 green (ubuntu+macos × 1.4.0/latest, package audit+pack smoke). macOS ps fix confirmed.
Final review (final-review.md): With fixes — I1 supervisor: exit during isBusy at idle limit recorded as idle-timeout; I2 MIGRATION.md says codex-home/opencode-home deletable. Minors M1 release PR gets no CI (GITHUB_TOKEN) — owner's call; M2 billing warning for unused backend; M3 stacked JSDoc; M4 ctrl+c doesn't reach in-flight CLI query (1.0.x).
Ruling: one fix wave = I1, I2, M2, M3; M1 documented for the owner (close/reopen the release PR is a no-go for me per rules — instead I'll note it; publish is still gated by release.yml's CI job); M4 → 1.0.x — cost: small.
Final fix wave cherry-picked: e1dfcc4 (I1 supervisor done-after-busy + test), 13ff876 (I2 MIGRATION exact folders), d3e1ee9 (M3), 8d17deb (M2 billing warn only for used backend + test). Controller read the diffs; Ruling: no separate re-review (small, each with RED/GREEN) — cost: low.
Task 12: complete (reviewed in final review). PLAN 7 IMPLEMENTATION COMPLETE → PR ready for Codex (cap 4 rounds).
