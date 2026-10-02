# SDD ledger — plan: docs/plans/2026-10-02-25-runs-programs-lanes.md
Conflict read (controller): overlaps handed to replay worker (admission, preflight Allow: on plan 23's rework, finalize owns union with plan 21's implicit Owns, summary status selection with plan 22's rule, lock-command with plan 23 activity, knowledge-by-origin carrying gate-env.json, routing reading the pinned profile). Thread check is plan 22's.
Replay: p25-replay 607c217..c30e053 on 3384098 (plan 24 pre-fix). Gate 2234/19/0.
- Ruling: new tools workspace_budget, workspace_pause, workspace_resume, lane_set, owns_add, run_pin are coordinator tools (role scope) — they write run/workspace state — cost: none.
- Ruling: gate-env.json follows knowledge into the origin-keyed folder and migrates on read (4bc5f12) — plan 23's env must survive plan 25's re-keying — cost: readGateEnv & friends became async.
Carry to plan 27: README knowledge row and ideas.md "Shipped in 1.0" line still describe slug-keyed knowledge; gates.jsonl stays toplevel-keyed (worktrees don't share carried passes) → ideas.md.
Final review: 1 C / 4 I / 8 M (final-review.md). Fix wave on c30e053.
Fix wave 1eb448a..8d42dbd on c30e053 (C1 pin.json server-owned; I2 overlap vs current Owns in admission and owns_add; I3 every header field read only from the header block; I4 lock reports activity while waiting; I5 supersede under admission lock, any cycle refused; rulings 10–12, 15–17 updated; minors → ideas). Worker gate 2241/19/1 (doctor-command NO_COLOR timeout under load; 11/11 alone).
- Ruling: every lane header field is read only from the header block under the title (worker deviation, extends I3 beyond After/Allow) — one consistent rule, and the skill's template puts headers there — cost: a lane with header lines after body text loses them (none expected).
Scoped re-review: C1, I2–I5 ADDRESSED (incl. extensions), no new breakage.
Rebased onto main 2bc5797 clean + ledger 42f6dee. Gate 2262/19/0. PR #50 opened ready.
Codex round (42f6dee): P1 role can `catherd pause --machine` (4169264847); P2 run_start(from) orphan replacement (4169264855); P2 origin key drops non-default ports (4169264862). Fixer on 42f6dee.
- Ruling: P1 fix also guards every orchestrator-writing CLI (runs cancel/supersede/pin, profile set, knowledge env set) with E_ROLE_SCOPE, closing plan 21 review Minor 7 — same hole, same helper — cost: a user running catherd inside a role shell by hand is refused (intended).
Codex fixes pushed 4ef2e71 9606b2b aae7b32  (worker gate 2266/19/0). Ruling: knowledge add refused for roles (roles only read_knowledge; land writes knowledge) — cost: a role can't add a fact by CLI.
MERGED #50 as 0d356a6 (squash).
