# SDD ledger — plan: docs/superpowers/plans/2026-09-26-06-tui.md
--- session 4 (2026-09-26) ---
Branch claude/great-dijkstra-85qdx7 at main d0f6fd8. Bun 1.4.2. Gate green (950 pass, 10 skip).
Ruling: inside a repo bound to another profile, the TUI opens on and labels the profile that repo runs on (`here`), and "Save & make active" there binds the repo (`activate(name, repo)`); outside a repo it acts on the global active profile — same rule plan 5 applied to CLI and MCP — cost if wrong: one label and one activate call to change. (handoff)
Ruling: cancelling a live run is ctrl+d twice (esc only backs out); Profiles frames read the shipped catalog; PTY test skips without tmux — writer rulings kept (handoff) — cost: none known.
Ruling: open question 1 (read ~/.config/typesafe/api_key) defaults to No; open question 2 defaults to live kit BEFORE merging the release PR — owner unanswered at handoff — cost: MIGRATION note / release waits on owner.
Ruling: wave 1 (Tasks 1, 2, 4: pure theme/text, commands, reducer+patchBetween) dispatches in parallel with the read-only pre-flight scan; scan rulings bind wave 2 onward and any wave-1 finding enters that task's fix round — the plan was replayed green twice and wave 1 does not touch the repo-scoped ruling's surface — cost if wrong: one fix round on a wave-1 task.
Dispatched: preflight (read-only), T1, T2, T4 (worktrees, reset d0f6fd8). Plan-8 writer dispatched (worktree, docs only).
T2 cherry-picked d0f6fd8398a28d0ff8f3b0227c6c56e89e70b26b..44aa207 (4c758a1). Concern THIRD_PARTY_NOTICES → Task 13 creates it.
T1,T4 cherry-picked 44aa207..6ebb07f (b9f291d,0c75fde).
Draft PR #9 opened, subscribed; hourly check-in trig_01KzmBwSvd79nCdQx2ofsrre. Wave-1 review dispatched (6ebb07f). T3, T5 dispatched (reset 6ebb07f).
T5 cherry-picked 6ebb07f..83f0801 (0ffb35d).
T3 cherry-picked 83f0801..42147d1 (86da4e8).
Preflight: see preflight.md (0 interface conflicts; R1–R30 repo ruling; D1–D9; S1–S4). Rulings adopted:
Ruling: repo ruling implemented as preflight R1–R29 (Effects.profiles() = {names, active(global), here, repo(bound or null)}, liveEffects(repo) resolved once in openTui via gitToplevel(cwd), activate(name, bound()), fixtures repo/bindings, "this repo" label via hereWord) — mirrors plan 5's ProfilePort {active, here} — cost: labels/one condition.
Ruling: in a repo with NO binding, making a profile active sets the global profile and binds nothing (bound() null) — matches `catherd profile use` default (global) and avoids binding every repo the TUI opens in — cost if wrong: one condition in liveEffects/fixtures.
Ruling: D1 fix — stampOf also covers the profiles folder and projects.json mtimes so a saved budget refreshes run %s — cheap — cost: a few extra stats per poll.
Ruling: D2 accept — treat-likes written before a refused patch stay in catalog.override.json (user chose them; validation must read them first, Ruling 6); say so in effects.save's doc comment — cost: a stray treat-like after a refused save, visible and reversible.
Ruling: D4 (one import), D5 (dedupe kept lines in AppApi.keep), D6 (test title "second button"), D7 (TuiOptions.tty so the test never reads the real TTY), D8 (README --plain wording) all fixed in their tasks — reviewer-level defects — cost: none.
Ruling: R30 applied by controller (commands.ts twin "catherd profile use <name> [--repo]") in d9c1353.
Wave-1 review (wave1-review.md): T1 ✅ approved; T2 ✅ approved; T4 ✅ needs fixes (Important: show kept a clean draft over a newer file).
Ruling: T4 fix — `show` keeps a draft only when dirtyCount > 0 (a clean draft restarts from the file just read, losing only a redo stack) — staleness is the worse bug — cost: redo lost after undo-to-clean then leaving the profile. Controller fix d9c1353 with RED/GREEN test.
Task 1: complete (14791fc). Minor (deferred): wrap drops doubled/leading spaces.
Task 2: complete (44aa207 + R30 in d9c1353). Minor (deferred, final): resolveKeybinds lets ctrl+x (leader) be bound, no key syntax check; printable key rebound to dialog/row command silently dropped.
Task 4: complete (6ebb07f + d9c1353 fix).
Task 5: complete (83f0801, approved). Minor (deferred → check in T10 review): failoverOptions filters r.enabled, ignoring staged treat-likes unless caller passes withStaged catalog; held-rung for other role shown unscored; tests miss firstMatch/numberValue/two Claude groups/inferred mark.
T6 dispatched (worktree, reset d9c1353, with R1–R11, D1, D2). T3 review dispatched (83f0801..42147d1).
Task 3 review: ✅ spec; Needs fixes (plan-mandated Important: afterEach destroy outside act → warnings). Ruling: fix — controller bdcb21f (await screen.close(); 0 warnings, 5 pass) — cost none.
Task 3: complete (42147d1 + bdcb21f). Minor (deferred, final): filter layer gated on any focused editor; no leader-timeout/useKeymapVersion test; render.tsx orphan JSDoc, dead NAMED.tab, single-modifier key parser. ⚠️ focus-scoped layers/priorities: plan Ruling 2 replaces targetRef with modes+guards (resolved). ⚠️ lazy import: Task 12 test guards it.
T6 cherry-picked bdcb21f..27d72ad (b364acc).
T6 review dispatched (bdcb21f..27d72ad). T7 dispatched (worktree, reset 27d72ad, R12 R13 D5).
Task 6 review: ✅ spec; Needs fixes: I1 stampOf lacks configFile (global activate), I2 fixtureRow duplicates rowOf (plan-mandated). Ruling: fix both (controller 3a5207e, RED/GREEN stamp test) — cost none.
Task 6: complete (27d72ad + 3a5207e). Minor (deferred, final): memoRuns cache never drops deleted runs; fixture create with unknown from returns silently.
T7 cherry-picked 3a5207e..9155d4f (af724b8).
T7 review dispatched (3a5207e..9155d4f). T8 dispatched (worktree, reset 9155d4f, R14). T7 worktree kept for fix round.
Task 7: complete (9155d4f, approved). Minor (deferred, final — flag to final reviewer): List move reads render-time index so two keys in one tick lose a move (Review Focus 2 spirit); footer leader chord 2nd key muted; keymap mode only set in dispatch; same toast object queued twice never clears; "3 s hold" test doesn't check hold; keep dedupe collapses blank separators. ⚠️ DataProvider must wrap every useData caller in Task 11 App (check in T11 review).
T8 cherry-picked 9155d4f..fc17939 (df3e60c).
T8 review dispatched (9155d4f..fc17939). T9 (R15–R18, D3) and T10 (R19–R24, D4) dispatched in parallel (worktrees, reset fc17939).
Ruling: Task 10 passes withStaged(catalog, draft.treatLikes) to failoverOptions/startOptions + test — Task 5 minor, plan Ruling 6 stages treat-likes — cost: none.
T8 review: ✅ spec; Needs fixes — Important: save dialog agent-file list unbounded, buttons off-screen at 80×24 (plan-mandated). Ruling: fix — shared row budget + "… and N more" + 80×24 test; also strengthen picker every-letter test. Fix round 1 dispatched (resume implementer, reset fc17939). Minors deferred (final): ctrl+d warning outlives 5s arm (no fake-clock test); DialogHost key keeps cursor/filter across same-purpose replace.
T9 cherry-picked fc17939..ef64488 (ca35a9b).
T9 review: ❌ spec (plan-mandated gap: cursor move doesn't disarm ctrl+d cancel, Ruling 3). Fix round 1 dispatched (resume, reset ef64488) + R17 profile:<name> test. Minors deferred (final): budget colour threshold test, stateParts pad edge, repo paths truncated not wrapped, errors after first load hidden, React keys may repeat. Check T10 profile-list delete disarms on move.
T10 cherry-picked ef64488..e1038b4 (8491cb8,c997871).
T10 review dispatched (ef64488..e1038b4).
T8 fix1 cherry-picked e1038b4..14c5ece (546c7c5).
T8 re-review dispatched (e1038b4..14c5ece).
T8 re-review: finding 1,2 addressed; NEW Important: error issues can be cut entirely (Ruling 8). Fix round 2 dispatched (resume, reset 14c5ece).
T10 review: ✅ spec; Needs fixes — Important (plan-mandated): kept filter snaps cursor to first match after every edit. Ruling: fix + minors (untick unscored, treat-like one undo step, post-save read error toast) — owner's 'no surprises' — cost: small. Fix round 1 dispatched (resume, reset 14c5ece).
T9 fix1 cherry-picked 14c5ece..423a4e5 (ddf359e).
T9 re-review dispatched (14c5ece..423a4e5). Note: esc leaving run view dispatches run:null → armed cleared (ok).
Task 9: complete (ef64488 + 423a4e5 fix1; re-review all addressed).
T8 fix2 cherry-picked 423a4e5..3c31c18 (7783f45).
T8 re-review 2 dispatched (423a4e5..3c31c18).
T10 fix1 cherry-picked 3c31c18..dff3ecf (1a8122b).
T10 re-review dispatched (3c31c18..dff3ecf). T11 dispatched (worktree, reset dff3ecf, R25 R26 D6) in parallel with T8/T10 re-reviews — Ruling: start T11 before the two scoped re-reviews close — disjoint files; any re-review fix rebases trivially — cost: a snapshot regen if a fix changes a frame.
Task 8: complete (fc17939 + 14c5ece fix1 + 3c31c18 fix2; re-review 2 all addressed). Minor deferred: on very short screens error tail can be trimmed for save-failure.
Task 10: complete (e1038b4 + dff3ecf fix1; re-review all addressed). Minor deferred (final): after post-save read failure the draft still shows edits unsaved + success toast follows error toast.
T11 cherry-picked dff3ecf..9fc3a39 (2184f9a).
T11 review dispatched (dff3ecf..9fc3a39). T12 dispatched (worktree, reset 9fc3a39, R27 R28 D7).
Task 11: complete (9fc3a39, approved). Minor → final fix wave (usability, owner's "solid as opencode"): palette/help show only 3 rows at 80×24 (select dialog height cap); palette key column ragged; toast "change(s)"; storybook not reset between stories; footer invariant checks last non-blank line not row h; frames docs test order-dependent under -t; coverage ] ? rebound key in palette.
T12 cherry-picked 9fc3a39..d456997 (697cafd).
T12 review dispatched (9fc3a39..d456997). T13 dispatched (worktree, reset d456997, D8 R29).
Controller tmux look (real `catherd`, 100×30, at d456997): tabs, tree, stage+ctrl+s dialog, q-dirty confirm, ctrl+p palette, ctrl+c×2 all behave. Polish for final fix wave (owner: "solid as opencode"): (P1) palette/help key+CLI columns ragged, and only ~6 rows at 30 lines (3 at 24) — align columns, use the height; (P2) dialog footer shows only "enter choose" — should also list esc/move keys; (P3) toast "change(s)" → proper plural; (P4) Status heavy-lock dir path truncated with … (spec: paths wrap); (P5) tree model column misaligns for long names (claude-haiku-4-5-20251001) — pad to longest.
T12 review: ✅ spec, Approved w/ Important (plan-mandated): PTY test env not explicit (tmux server env leak). Ruling: fix + minors (run.test env, renderer destroy on error, watch --help flags). Fix round 1 dispatched (resume, reset d456997). Minor deferred: terminal check runs twice.
Plan 8 doc: adc06be kept on local branch plan8-doc (land with plan 7's PR after re-check). See .superpowers/sdd/plan8/writer-report.md
Ruling: plan 8 doc cherry-picked onto PR #9 branch (ee75b27) — the only branch we may push; a local-only commit could be lost with the container — cost: PR #9 carries one docs file outside plan 6's scope.
T13 cherry-picked ee75b27..591e2f2 (6cbea5a).
T13 review dispatched (trimmed diff ee75b27..591e2f2).
Task 13: complete (591e2f2, approved). Controller gate at 591e2f2: 949 pass 10 skip 0 fail, 66 snapshots. Minor → final fix wave: docs/dependencies.md stale runChild/runOpencode/fake-opencode lines; docs/ideas.md & docs/manual-tests.md point at deleted paths; init TTY welcome branch untested.
All 13 tasks implemented; T12 fix round 1 pending.
T12 fix1 cherry-picked 591e2f2..b77f0de (dfaa926).
Task 12: complete (d456997 + b77f0de fix1; controller-verified the 4-file fix, focused 7 pass, gate 949 pass). Ruling: no separate re-reviewer for T12 fix1 — small, controller read the diff and ran tests; final review covers it — cost: low.
Final whole-branch review dispatched (d0f6fd8..b77f0de).
Final review (final-review.md): With fixes — I1 burst keys act on drawn state; I2 `/` focus one render late (letters run commands); I3 error toast cuts fix, vanishes 4s; I4 render error leaves user stuck. Minors M1–M12 + triage.
Ruling: one fix wave (final-fix-wave.md) = I1–I4, M1–M12, docs #19, P1–P5; error toasts with a fix stay until next key — owner's keyboard-first "no surprises" bar — cost: a bigger fix wave (one worker).
Final fix wave dispatched (worktree, reset b77f0de). Plan 7 re-check writer dispatched in parallel (worktree, at b77f0de; docs only). Ruling: re-check plan 7 before plan 6 merges — the fix wave touches only TUI files/docs; saves wall-clock — cost: one small re-diff if the fix wave moves an anchor.
Final fix wave cherry-picked b77f0de..160453a (18 commits d24081d..7bab94b).
Final fix wave re-review dispatched (b77f0de..160453a).
Controller tmux look #2 (80×24, 160453a): palette fills panel, aligned; dialog footer hints; tree aligned. DEFECT (Focus 4): --plain toast bleeds through the tab row ('|31Runsaved change…'). Ruling: no-colour toasts draw in reverse video (opaque, like the plain selection) — fix with the re-review round — cost: small.
Final re-review: all I1–I4, M1–M12, docs, P1–P5 addressed; flushSync safe. Open: Important toast bleed (both modes); minors runs first-read error hidden, padEnd doc misplaced. Round 2 dispatched (resume fix worker, reset 160453a): opaque toasts (surfaceRaised bg / reverse video) + tests.
Plan 7 re-check: f13c93e (13 tasks; new T13 resolveKeybinds refuses leader/printable on dialog/filter; T10 per-test tmux server; coverage floor holds 88/85, measured 93.63/90.40 at b77f0de; replay 979 pass). Cherry-picked onto PR #9 as f570ed1 (docs only) — Ruling: keep plan docs safe on the pushed branch — cost: PR #9 carries plan-7 doc edit.
Plan-7 writer found: TUI drops the j sent right after Profiles shows ROLES (PTY flake root cause). Added to fix round 2 as Important. HANDOFF says plan 7 has 12 tasks → update at handoff edit.
Fix round 2 cherry-picked f570ed1..f85ff6f (15bde24 opaque toasts, 53ab985 runs errors, 5b5ceea padEnd doc, 34fd93f List snap effect reads selectedRef (dropped key root cause), 64910c4 PTY per-case tmux server + wait for exit code; load 144/0). NOTE plan 7 T10 also adds per-test tmux server — preflight must reconcile.
Final fix wave round 2: controller-verified (gate 981 pass; tmux plain toast clean; list.tsx diff read). Ruling: no separate re-review for round 2 — small, pinned by RED/GREEN tests and load run 144/0 — cost: low. PLAN 6 IMPLEMENTATION COMPLETE → PR ready for Codex review.
