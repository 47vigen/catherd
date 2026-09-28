# SDD ledger — plan: docs/plans/2026-09-28-11-access-protocol.md
Preflight: preflight.md (9 conflicts vs plan 10 head 85884d3; resolved in a throwaway → 1314 pass).
Ruling: P1 resolve the nine conflicts per preflight §3: plan 10 code wins, plan 11 adds only its lines — plan 10 merges first — rework if a plan-11 line is dropped.
Ruling: P2 dispatch description keeps plan 10 wording + reply-contract and auto-route clauses, no `wait` — spec §6/§14 — none.
Ruling: P3 Task 11 updates the MCP peek description (questions, verifier step, protocol) — spec §3.7 — none.
Ruling: P4 no invented run_start resume path; run_start returns Protocol next + checklist for its run, re-entry on an existing run is `peek(run)` once (skill says so) — run_start has no resume mode in 1.0/1.1 code — if the owner expected run_start on an existing run, a follow-up adds it.
Ruling: P5 Task 12 skill keeps plan 10's sentences it lacks, "and"→"or" typo at land gate line, keeps plan 10's negative test strings — both plans' intent — none.
Ruling: P6 live-verification §4 is plan 11's; plan 12 §8 points at it — no duplicate — none.
Ruling: P7 (differs from preflight): the runs-page digest view is added to plan 12 as an extra task (spec §10 requires it) — not a gap in 1.1 — small TUI task.
Ruling: P8-P11 accepted: workers get their conflict rows; re-check cherry-pick on merged main before dispatch; wave order stands; workers check 0 fail not absolute counts; plan 12 re-anchors doctor hunks after plan 11.
Plan 11 port worker dispatched (worktree, base 546e5f8 = plan 10 head).
Ruling: plan 11 is executed on plan 10's head before plan 10 merges (commits later replayed onto main, identical trees) — plan 10 is in bot review, saves hours — cost if wrong: a rebase if plan 10 changes in bot rounds (small).
Port done: HEAD 091a8cd on 546e5f8 (worktree agent-a014d6119ffb580ea), 1338 pass. Task commits T1 b1379fb T2 508e040 T3 1f602a2 T4 1ad6d11 T5 01148b2 T6 d9f2906 T7 c892530 T8 fe2eca6 T9 8e68ebc T10 9a1a584 T11 4171fdd T12 091a8cd.
Ruling: tasks are the writer's pre-validated commits ported by one worker (conflicts per preflight) — same ruling as plan 10 — none.
Batch5 (T10): spec OK; I1 milestone id unvalidated → digest path traversal + write after ledger; I2 (plan-mandated) lane counted dispatched by any dispatch ever → Protocol next wrong after climb/failed.
Ruling: fix T10 I2 despite plan text — spec §10 (re-entry must name the true next step) — small.
Task 1: complete (review clean)
Task 2: complete (review clean)
Task 1-2: minor (deferred): 7 in review-batch1.md (lock dir/docker socket not realpathed — macOS docker.sock symlink; tcp DOCKER_HOST falls back to sockets; profile show padding; etc.)
Batch6 (T11-12): spec ❌ 2 gaps; I1 SKILL.md:65 E_ADMIT_DUPLICATE lost plan-10 sentence ("Wait for it"); I2 peek description "answer them before anything else" contradicts §8 (owner answers). 8 minors (skill peek/result rows lost details, "A single role" line dropped, resume "Before dispatching anything" dropped, no test for peek without run) — fold the skill ones into the fix.
Batch2 (T3-4): spec OK; I1 doctor-access runProbes ensurePrivateDir(locksDir()) unguarded → doctor rejects with no report. Minors 8; fold in: HTTPS probe treats proxy 403/407 as success; timeout reported as "no output".
Task 7: complete (review clean)
Task 8: complete (review clean)
Task 9: complete (review clean)
Task 7-9: minor (deferred): 8 in review-batch4.md; fold into fix round: gate path that exists nowhere hashes "missing" and carries forever (refuse or never carry); answer + failed state.json save leaves parked prefix unclearable. Carry-check: land accepts a verdict with "carried over" lines (verifierPassed, T6).
Task 5: complete (review clean)
Task 6: complete (review clean)
Task 5-6: minor (deferred): 7 in review-batch3.md; fold: reviewer-M10 satisfies M1 (word boundary), .txt counts as doc (requirements.txt).
Fix round 1 dispatched (one fixer, base 091a8cd).
Fix round 1 done 091a8cd..272522b (1351 pass); re-review dispatched.
Tasks 3,4,10,11,12: fix round 1/5 (10 addressed, 0 open; commits 091a8cd..272522b)
Task 3: complete
Task 4: complete
Task 10: complete
Task 11: complete
Task 12: complete
Fix1 minor (deferred): re-route or climb past top rung leaves Protocol next at "dispatch" indefinitely; laneDone reads records per lane; peek.ts shadowed r, double readNotes, reentry.ts wrap.
Final review: With fixes. 7 Important (doctor probes on uninstalled backends + tests reach real registry/docker; probe "why" = stdout tail; reviewer on claude: rung can't satisfy gate; verifier FAIL counted as verdict; docs pattern matches nested docs/; codex writable_roots override drops user's roots; Claude --settings merge unverified). Must-fix minors: climb past top rung loops Protocol next; empty commit range accepted by skip.
Ruling: fix all 7 + the 2 must-fix minors + the cheap recommended minors in one wave; codex writable_roots → union with the user's top-level [sandbox_workspace_write].writable_roots from CODEX_HOME/config.toml (profiles: documented limitation + live check) — native harness rule — a user profile's roots may still be dropped.
Ruling: Claude headless --settings carries sandbox.enabled:true only when the user's settings have it on, plus a live step in live-verification §4 — keeps the user's sandbox — shallow-merge behaviour unverified until the owner runs §4.
Ruling: also fix the pre-existing flaky "catherd status and watch --once" (0s vs 1s) in the same wave; the doctor Jev-network flake is fixed on the plan 10 branch (c45cd49).
Final fix wave done 272522b..b29d5e4 (8 commits, 1362 pass x2). Deviations: grouped commits; isolated codex runs get no user roots (--ignore-user-config).
Final fix wave re-review: 14/14 addressed, no new Critical/Important. Minors (deferred): ~/.claude/settings.local.json read at user scope (Claude may not read it) — edge case; **VERDICT: PASS** markdown counts as no verdict (fails safe); doctor claude access row uses cwd not bound repos.
Plan 11 review complete; replay onto main in progress.
Replayed onto main: 9707a70..ef53a18 (29 commits, 1372 pass x2). Controller fix d0cc462 (no user-level settings.local.json).
PR #16 Codex r1 on 3cea949: P1 skip accepts stale commit; P2 gate hash ignores mode; P2 digest misses headless verifier → fixer.
PR16 Codex r1 fixes 4e243bb 3c205e0 9ad9ac8 4ba7cde pushed; local gate 1 fail = git commit SIGTERM under load (peek.test passes alone 2x); threads replied+resolved; round 2 requested.
PR16 Codex r2 on 4ba7cde: 4 P2 (committed mode in gate hash; docker probe with network off; digest steps scoped to milestone; milestone name boundary) → fixer.
PR16 Codex r2 fixes 6bf8a0d 1db0c05 9841899 f4f3da0 pushed (full gate 2 timeouts in notifier.test under load; file passes alone 2x).
PR16 Codex r3 on f4f3da0: P1 explicit network_access=false; P2 ignored inputs in gate hash → fixer. Ruling: ignored/untracked explicitly named paths hashed by content (dir walk cap 10k files); "." does not cover ignored files (documented) — hashing node_modules would be too slow — cost: a gate relying on an unnamed ignored file can carry stale.
PR16 Codex r3 fixes df260ca ce127c4 (codex network_access=false explicit; claude allowLocalBinding false; ignored gate paths hashed from disk) gate 1380 pass; pushed.
PR16 r3 threads replied+resolved; round 4 (last under cap) requested.
PR16 Codex r4 (cap) on ce127c4: P1 latest verifier verdict wins; P2 symlink gate inputs hash target content → fixer. No round 5; merge on green.
PR16 Codex r4 fixes 1cd6566 e43482c; gate 1383 pass. Cap reached: no round 5.
