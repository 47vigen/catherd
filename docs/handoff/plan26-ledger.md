# SDD ledger — plan: docs/plans/2026-10-02-26-minors-sweep.md
Conflict read (controller): overlaps handed to replay worker (dispatch routing lock vs plans 22/24, gate-service contentHash vs plan 23, Task 2 files vs 22/23/25, doctor vs 21–23, profile-rules/failover vs 24, TUI vs 22).
Replay: p26-replay 71f7294..412c104 on c30e053 (plan 25 pre-fix). Gate 2260/19/0.
- Ruling: refuseBeforeRouting reads the pinned profile (runProfile) like admission — plan 25's pin wins — cost: none.
- Ruling: a dispatch that waited on the route lock and finds the lane routed behaves as an already-routed lane (no ladder check) — plan 24 semantics — cost: none.
On rebase: plan 23 fix wave's dirty-lockfile hashing must also set `dirty` (so gate pass names `+uncommitted` when only a lockfile is dirty).
Final review: 0 C / 1 I / 4 M. Fix wave on 412c104.
Fix wave 592514d..61959e2 on 412c104 (I1 pre-routing uses liveDispatches; minors → ideas). Worker gate 2261/19/0. One source file → no re-review.
Rebased onto main 0d356a6 (one conflict: run-service.ts startRun — kept plan 25's locked from-sequence, added startHead to createRun). + dc8ae59 doctor 30 s timeouts (two whole-doctor tests hit 5 s on the slow sandbox; per plan 26's own ruling) + plan 25 ledger 8bcd5bb. Gate 2292/19/2 (the two timeouts) → 62/62 after fix.
PR #51 opened ready.
Codex round (8bcd5bb): P2 doctor sandbox repos not filtered by checked profiles (4169529986); P2 pathVersion no timeout (4169529977) = review M3. Fixer on 8bcd5bb.
Codex P2 fixes pushed (worker gate 2296/19/0).
MERGED #51 as ddb56fe (squash).
