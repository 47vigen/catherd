# SDD ledger — plan: docs/superpowers/plans/2026-09-25-01-foundation.md
Spec: docs/superpowers/specs/2026-09-25-catherd-1.0-design.md
Branch: claude/project-analysis-review-xb3fot. Execution: subagent-driven, full autonomy granted by the user (approve, merge, release).
Models: implementers haiku (plan carries full code) → escalate sonnet/opus; task reviewers sonnet; final review fable.

## Pre-flight scan
| Pair / task | Produces → consumes | Finding |
|---|---|---|
| T1→T2 | CatherdError, E_LANE_INVALID code | consistent |
| T3→T6,T7 | ExitInfo/EXIT_REASONS in domain/record.ts | consistent (moved to domain in self-review) |
| T4→T10,T11 | snapshotEnv in test/helpers.ts | consistent |
| T5→T7 | processStartTime, killGroup | consistent |
| T6→T7,T9,T10 | BackendAdapter, dispatchPaths, readExit, tryClaim, workerEnv | consistent |
| T7→T9 | SuperviseSpecSchema, supervise(spec, hooks) | consistent |
| T8→T10,T11 | withScenario/simPath, fixtures dir test/fixtures/adapters/codex | consistent |
| T9→T10 | registry + adapters/all.ts (empty in T9, filled in T10) | consistent |
| T10→T11 | codexAdapter; contract expects env.PWD undefined, flag thread refused | consistent |
| T1 self | ids test vs ID_PATTERN/parseRung | agrees |
| T2 self | "Owns: not-this.ts" body line after header; field() returns first match | agrees |
| T4 self | readJsonl header on line 0 only | agrees |
| T7 self | cancel test relies on ignored TERM inherited by sleep | agrees |
| T9 self | supervisor process loads src/cli.ts which still statically imports the 0.x TUI (slow start, still correct) | Ruling: accept for plan 1 — lazy imports are plan 5 (spec §3.1) — costs ~300 ms per dispatch start until then |
| T11 self | macOS /private/var realpath note | Ruling: CI is ubuntu for now; if macOS CI (plan 7) trips it, compare realpaths — costs one small fix later |
Ruling: added `.superpowers/` to .gitignore so SDD workspaces stay out of commits — costs nothing.
Ruling: local Bun is 1.3.11 (< 1.4 floor); tests run on it here, CI runs latest Bun — a Bun-version-only difference (like test/tui/theme.test.ts) is not a task defect — costs a CI round if wrong.

## Tasks
Task 1: dispatched (BASE 333edf8, implementer haiku)
Ruling (user directive 2026-09-25): bundle tasks and run independent batches in parallel in isolated worktrees; subagents on Opus 5.5 (low/medium effort). Batches after T1: A = {T2+T3}, {T4+T5}, {T8} in parallel; B = T6+T7+T9; C = T10+T11. One reviewer per batch — overrides the skill's "never parallel implementers" because worktrees isolate them — costs a merge step per batch if wrong.
Ruling: custom opus-low/opus-medium agent types do not load mid-session; use general-purpose with model "opus" (effort not settable this session) — costs somewhat more tokens per dispatch.
Task 1: implemented 333edf8..97b6f13 (review folded into batch A1 review)
Batch A dispatched in parallel worktrees from 97b6f13: A1=T2+T3, A2=T4+T5, A3=T8 (opus)
Batch A3 (T8): cherry-picked 57b28be from worktree 5446685
Batch A1 (T2+T3): cherry-picked, head 6e1fccc
Batch A2 (T4+T5): cherry-picked 6e1fccc..560959b
Review A (T1,T2,T3,T8) dispatched on 333edf8..6e1fccc; review A2 (T4+T5) dispatched on 6e1fccc..560959b
Batch B (T6+T7+T9) dispatched in worktree from 560959b
Review A: T1 ✅ approved; T2 spec ✅ quality changes (I1: normalizeOwned keeps "." / "./" / "//" segments so overlap misses them; "." accepted as owning nothing); T3 ✅ approved; T8 ✅ approved; 22 minors in review-A.md.
Ruling: fold three load-bearing minors into the T2 fix round (ZERO_TOKENS typed Readonly; architecture test also catches side-effect imports and top-level 0.x files src/paths.ts, files.ts, version.ts (cli.ts exempt as the 0.x entry point); newDispatchId monotonic within a millisecond) — cheaper now than after later tasks build on them — costs one slightly larger fix diff.
Task 1: complete (333edf8..97b6f13, review clean)
Task 3: complete (e6ee05c..6e1fccc, review clean)
Task 8: complete (f7e6c0a..57b28be, review clean)
Task 2: minor (deferred): remaining Task 2/3/8 minors listed in review-A.md for final review triage
Review A2: T4 spec ✅ quality changes (I: append after a truncated tail merges into the fragment); T5 spec ✅ quality changes (C: reclaim renames whatever is at the lock path → two holders; I: ps lstart locale/TZ-dependent; I: pid ≤ 1 / non-integer unguarded). 15 minors in review-A2.md.
Ruling: also fold "empty/unparsable lock older than 5 s counts as stale" (implementer concern) into the T5 fix, since the reclaim rewrite touches the same code — costs nothing extra.
Fix round 1/5 for T2+T4+T5 dispatched as one fix agent (FIX_BASE 560959b)
Batch B (T6+T7+T9): cherry-picked 560959b..65d17e5
Fix round 1 agent dispatched on main tree (base 65d17e5); review B dispatched on 560959b..65d17e5; batch C (T10+T11) dispatched in worktree from 65d17e5
Ruling: batch-B concern (supervisor still loads OpenTUI via static cli.ts imports) accepted until plan 5 lazy imports — costs startup time per dispatch
Batch C (T10+T11) done in worktree-agent-ab343d4bb5bf0f46c (874fbd4, 3e17d41); cherry-pick after fix round 1 commits land
Ruling: runAdapterContract takes (adapter, rung, cases) as the verbatim code does; plan interface line was wrong — later plans use the 3-arg form — costs nothing
Review B: T6 ✅ approved; T7 changes (I1 no try/finally → no exit.json on spawn/hook failure; I2 unbounded isBusy/interrupt; I3 SIGKILL only if leader alive); T9 changes (I4 supervisor loads OpenTUI via cli.ts). 15 minors in review-B.md.
Task 6: complete (review clean)
Ruling: fold into fix round 2: UTF-8 streaming decode, done re-check after interrupt, supervisor env scrub, launch-test bound, and the three batch-C codex edge cases — all touch files already in the round — costs a larger fix diff
Fix round 2 (T7,T9,T10) queued behind fix round 1 (shares no files, but runs on the same tree)
Task 2/4/5: fix round 1/5 commits 65d17e5..863ce63 (awaiting re-review)
Task 2/4/5: fix round 1/5 (8 addressed, 1 new — N1 pid 1 rejected by readHolder/isAlive; commits 65d17e5..863ce63)
Task 2: complete (fix round 1, review clean)
Task 4: complete (fix round 1, review clean)
Task 5: fix round 2/5 dispatched (N1), resumed implementer
Deferred minors from rereview-1.md: 6 (stale-marker stat/rm race, paused reclaimer >5s, extensionless import, endsMidLine stat/open race, older now, macOS ps failure)
Task 5: fix round 2/5 commit 863ce63..4cbe2a0 (re-review bundled with fix-2 re-review)
Batch C + fix round 2 cherry-picked 4cbe2a0..d55780b
Review C dispatched (T10+T11 task review + fix-2 re-review + N1 re-review) on 863ce63..d55780b
Plan 2 writer dispatched in parallel (docs/superpowers/plans/2026-09-25-02-run-service.md)
Full suite on d55780b: 441 pass, 1 fail (known theme test, Bun 1.3.11); typecheck/lint/format clean
Review C: T10 PASS, T11 PASS; fix-2 11/11 ADDRESSED; N1 ADDRESSED; 14 deferred minors in review-C.md
Task 5: complete (fix rounds 1-2, review clean)
Task 7: complete (fix round 1, review clean)
Task 9: complete (fix round 1, review clean)
Task 10: complete (f15b853 + fix 9c107c2, review clean)
Task 11: complete (a0146b7, review clean)
Final review dispatched (opus) on 27ae4fb..d55780b
Final review: after fixes — I1 group sweep on natural exit, I2 codex sh timeout+env, backend.ts comment; spec deviations effort default, proc.json pgid, spec note. CAN WAIT items assigned: SIGTERM/SIGHUP handler, unparsable spec exit.json, readExit newer-schema → plan 2; supervise-bin explicit exit, contract-suite gaps → plan 3; pid1/null lock → plan 7. Plan-2 first-task list in final-review.md.
Ruling: fold both spec deviations and the spec note into the single final fix wave — all small and adjacent — costs nothing
Final fix wave d55780b..b1cac9a
