# SDD ledger — plan: docs/plans/2026-09-28-14-routing-profiles.md

Session 6 (1.2 autopilot). Plan written by an opus-medium writer on plan13-scratch, then replayed onto main cff7d19
(plan 13 merged, PR #22): scratch cff7d19..c3a94f2 (branch plan14-scratch), 1620 pass/0 fail/10 skip, pack-smoke green.
Plan doc 2062f27 → cherry-picked onto the branch. 12 tasks.

Controller review of the writer's rulings (conflict read):
- Ruling: accept plan C-2 (terminal anchored on the hand-typed Terminal-Bench 4.0 values, not Epoch
  terminalbench_external as spec §4.1 says) — Epoch shares 0 catalog rungs and is TB 2.0; spec's intent is bars in
  one keyless unit with data (repo_code and honesty anchor on hand values the same way) — cost if wrong: owner wants
  the Epoch anchor; terminal bars re-derived when Epoch covers the catalog. Listed in the PR for the owner.
- Ruling: accept plan R1 (bar pool counts hand-typed `secondary` as measured-or-better, spec §5.2 says measured or
  better) — 1.0 `secondary` = published for this exact rung, i.e. 1.2 `measured`; verified-only leaves no default worker
  rung clearing any repo_code bar — cost if wrong: bars move up; listed in the PR.
- Ruling: accept plan R3 (adjacent spreads fill only efforts with no value; hand secondary values stay, checked in the
  scratch: gpt-6-sol#low repo_code 37.2 secondary kept; a hand `inferred` loses to adjacent, e.g. Luna high 59.3 → 66.6)
  — spec §4.3 ranks adjacent above secondary/inferred — cost if wrong: lower efforts look as strong as max until a
  source scores them; Review Focus 2; listed in the PR.
- Ruling: accept R12/R14 (worker-miss warning only for a kind with no bar cleared; shipped Luna treat-likes) — C-3
  demands a warning-free default profile — cost if wrong: a maintainer's pick stands in for the user's for Luna agentic.
- Conflict read: shared files are sequenced 1→3→4→8 (catalog.ts), 3→5 (scores.json, profile-rules), 4→6→8
  (catalog-service), 6→8 (catalog-command), 5→10 (TUI fixtures), 5→8 (setup-tools); test 11 reads task 2's script.
  Tasks come from a gate-green scratch; no conflict found.
- Ruling: batching wave 1 {1,2,3,4,5} + {7}; wave 2 {6,8,10,12} + {9,11}, opus-low, files from `git show c3a94f2:` —
  the chain is sequential in the plan anyway; 11's test needs task 2's script — cost if wrong: a longer wave 1.
- Wave 1 dispatched on 578f1cd: {1,2,3,4,5}, {7}.
Task 7: complete (bdb81fa; identical to scratch; worker gate 1562 pass)
Task 1–5: complete (3ce9d27..f55cf07 = scratch commits; scores.json sha256 checks; worker gate 1596 pass + pack-smoke)
- Wave 2 dispatched on ac3a39a: {6,8,10,12}, {9,11}.
- Wave 1 gate on ac3a39a:  1599 pass  0 fail 
Task 9, 11: complete (35fa169, 4c1c937 = scratch 54ac929, 8a97143; worker gate 1603 pass)
Task 6, 8, 10, 12: complete (5146d94, ab648c8, ab12591, 198969f = scratch; worker gate 1616 pass + pack-smoke)
- PR https://github.com/47vigen/catherd/pull/23 opened ready on 04a48e2 (branch == scratch c3a94f2 in code); subscribed; hourly check-in routine. Final review dispatched (opus-medium).
- Full gate + pack-smoke on 04a48e2:  1620 pass  0 fail  EXIT 0
- Final review (opus-medium) on 04a48e2: 0 Critical, 2 Important, 10 Minor. Verdict: fix I1, I2.
  - I1 treat-like --clear/--reset skip rungs left with NO value (no-family model: scoresOf null) — spec §6.4 "names
    the profile rungs it leaves", "never removed silently".
  - I2 piped init's new line order (Jev, AA, profile, replace) undocumented; README:57 still 1.1 order.
  - Ruling: fix both in one wave with Codex's findings; Minors → ideas.md "1.2 follow-ups".
- Codex round 1 (04a48e2): 3 P2 — C1 override source, C2 treat-like create --json, C3 text catalog list lacks provenance — all correctness; fix wave dispatched (opus-medium) with I1, I2. Minors → ideas.md.
- Checked: full suite under a throwaway HOME writes no catherd file (tests isolated). A stray real-home sync (20:11, all timeouts) and 2 agent symlinks in ~/.claude/agents came from worker manual probes; sandbox-only, cleaned after the fix wave.
- Fix wave: d4b6a73 (C1), c9624c0 (I1), ef90a2a (C2), b02e688 (C3), b57b77e (I2), each RED→GREEN; worker gate 1624 pass + pack-smoke.
  Cherry-picked onto 69e87a8; scoped re-review dispatched (10 files).
- Re-review of the fix wave: all 5 ADDRESSED, no new C/I; 3 minors → ideas.md.
- Codex threads replied (3bcd81d, 224bce6, be15172) and resolved. One bot round done (CLAUDE.md cap).
- Next: merge on green CI, then hold "chore: release catherd" (1.2.0) and post the acceptance commands on it.
