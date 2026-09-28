# SDD ledger — plan: docs/plans/2026-09-28-10-push-sessions.md
BASE(plan docs head)=4b8d460c55c5ba6ddb50efe88a328cba19dd1fe4
Ruling: tasks are the writer's pre-validated scratch commits (plan text generated from them and re-applied identically) cherry-picked by the controller instead of re-transcribed by workers — identical code, saves a transcription pass per task — cost if wrong: none; reviews, fix rounds and the final review run as normal.
Ruling: Task 1 edits spec §3.1/§3.9 wording to match the binary (errata) — factual correction backed by the static spike — owner can revert the wording.
Batch2 (T4-5) review: spec OK; Important I1 notifier flush chain has no catch (rejection kills later notices / unhandled); I2 adopt skips finished-unrecorded dispatches on takeover (no settle/notice/failover). 6 minors (in review-batch2.md). ⚠ headless claude-code workers inherit CLAUDE_CODE_SESSION_ID/HOST_SESSION_ID -> live-verification list.
CI red: macOS (both Bun) test/entry/tui/effects.test.ts "watches run folders…" times out (FSEvents). Goes to T11 fix round.
Task 6: complete (review clean, batch3)
Task 7: complete (review clean, batch3)
Task 6/7: minor (deferred): 6 minors in review-batch3.md (stall.json write inside supervision try -> lost on write error; stallChecked not reset when busy; codexActivity twice; "edit " with no paths; claude tool activity only name; stale catch comment)
Carry to plan 11 preflight: peek must gain parked questions, verifier step and protocol next (plan 10 Ruling 15).
Batch5 (T11) review: spec OK; Important (plan-mandated) I1 data.tsx:120 sessionRows scans all runs every 2 s on every tab, unmemoised (1.0 §9.4); I2 esc back resets cursor to first row (runs.tsx, test pins it).
Ruling: fix both T11 Importants despite the plan text — 1.0 spec §9.4 (memoised polling) and the owner TUI rule (predictable) outrank the plan — cost if wrong: small extra TUI code.
Task 11: minor (deferred): 6 minors in review-batch5.md.
Batch4 (T8-10) review: spec OK; Important: session-view.ts:99-109 continuedIn from last non-starter session in history instead of current owner ([s-a,s-b,s-a] case); live roles counted under several sessions.
Task 8-10: minor (deferred): 8 minors in review-batch4.md; doctor-push gone socket -> failed advice and CLAUDE_CONFIG_DIR fix text folded into the fix round (cheap, user-visible).
Batch1 (T1-3) review: spec OK; Important (plan Ruling 7): reconcile on every server start fails over every unread limit in every run/repo, no age/owner check -> surprise stand-ins.
Ruling: auto-settle (failover) of a limit happens only for runs the server's session owns (start scan, notifier) and when a session claims a run (run_start/dispatch/peek): the claim settles that run's finished-unrecorded and unread-unsettled limits and notifies — this fixes batch1 I and batch2 I2 with one rule and follows spec §3.3/§3.4 ownership — cost if wrong: an unowned 1.0 limit waits until someone opens the run.
Task 1-3: minor (deferred): 7 minors in review-batch1.md; SKILL.md:62 "Wait for it" folded into the fix.
Fix round 1: fixer A (services) + fixer B (TUI + macOS watch) in parallel worktrees from 85884d3.
Fix round 1 B cherry-picked: b38ef47 16c65bd 0eefeb4 (pushed for macOS CI).
CI green on 0eefeb4 incl. macOS (watch fix confirmed).
Fix round 1 A cherry-picked 8f01c87..ac213b3; gate 1271 pass 0 fail; pushed. Re-review dispatched; final review dispatched concurrently on ac213b3.
Ruling: final review runs concurrently with the fix-round re-review (same head) — saves an hour — if the re-review finds breakage, the final review's fix wave absorbs it.
Ruling (fixer A concern): outside Claude Code runs have no owner, so leftover limits wait for result/peek — follows the owner-only settle ruling — a non-Claude-Code MCP client sees a limit without automatic failover after a restart.
Task 1-5,8-11: fix round 1/5 (8 addressed, 0 open — A1-A5, B1-B3; commits 85884d3..ac213b3)
Task 1: complete (commits 4b8d460..ac213b3, review clean after fix round 1)
Task 2: complete
Task 3: complete
Task 4: complete
Task 5: complete
Task 8: complete
Task 9: complete
Task 10: complete
Task 11: complete
Fix1 minor (deferred): watch() in dispatch-service settles/fails over with no ownership check (launching server may fail over after another session claimed; failover-once prevents duplicates); render-time ref write runs.tsx:468; probe-late-event weak watch test; failed doctor path only via hand-made outcome; T11 minors 3 and 6 open.
CI red macOS on ac213b3: doctor-push refusing test used an empty regular file (macOS: not ECONNREFUSED). Controller fix: stale socket from a SIGKILLed listener; pushed.
Final review: With fixes. Important: dashboard/CLI cancel never announced (cancel marks read always). Must-fix minors: supervisor stall.json write in try (+stallChecked reset), session-view test back-dates wrong files, sessions.jsonl append outside state lock. New minors 1-8 (final-review.md).
Ruling: ledger wording corrected — outside Claude Code a leftover limit after a restart is never auto-failed over; result marks it read with its limit hint — cost: a non-CC client re-dispatches by hand.
Ruling: final fix wave also takes new minors 1,3,4,6,7 (cheap, consistency); 5 stays by the claim ruling; 8 is plan 12 (MIGRATION, live-verification) — tracked.
Final fix wave cherry-picked 49a8a68..2e3b897 (8 commits); gate 1281 pass 0 fail; pushed.
Final fix wave re-review: 8/8 addressed. Controller fixed weak stall-write test (546e5f8).
Carry to plan 12 changeset/MIGRATION: catherd lock -- <cmd> children no longer see CLAUDE_CODE_SESSION_ID/HOST_SESSION_ID.
Plan 10 review complete; bot rounds next.
Codex r1 on 546e5f8: P1 changeset — replied (plan 12 adds it), resolved. P2 x3 (ownership recheck at delivery; recovery for current owner on peek; repair trail after interrupted claim) → fixer.
Codex r1 fixes cherry-picked ca573a7 d03e5ac 4592d8b; gate 1284 pass; pushed. Concern logged: same-owner peek re-settles an unread unannounced record each call (notifier dedups).
Codex r2 on 4592d8b: 2 P2 (cross-process notice dedup claim before send; supervisor busy at half-time should restart quiet interval) → fixer.
Codex r2 fixes 96c43cf e5957c4; gate 1287 pass; pushed; threads replied+resolved; round 3 requested.
Codex r3 on e5957c4: 1 P2 (ownership change during in-flight send) → fixer. Ruling: re-check ownership after claim and before writing notified.json; a duplicate to the old session is acceptable, a lost notice is not.
Codex r3 fixes cherry-picked (notifier unmarked on in-flight ownership move; retry held claim).
Codex r3 thread replied+resolved; round 4 (last under the cap) requested on a14c567.
CI red ubuntu Bun latest on a14c567: doctor test "fails on a credentials file others can read" reached the real Jev API (pre-existing leak since plan 7), timed out. Controller fix: run() defaults to a fake Jev transport; pushed.
Codex r4 (cap) on a14c567: 2 P2 (peek awaits recovery; failover lock timeout treated as pause) → fixer. After this: no round 5 (cap); merge on green.
CI red ubuntu latest (coverage) on c45cd49: my stall-write "tried" assertion too tight (0.5 s quiet vs 400 ms half-idle). Widened to 2 s / 2400 ms; pushed.
Codex r4 fixes 2a969f4 c46c3b3 (peek backgrounds recovery; lock timeout leaves limit to holder); gate 1291 pass; pushed. Cap reached: no round 5.
