# SDD ledger — plan: docs/plans/2026-10-02-24-routing-cost.md
Conflict read (controller): overlaps handed to replay worker (dispatch-service routing block vs plan 22 thread check, lane-service vs plan 23 env-hint climb refusal, SKILL tables, ports, profile-rules). Controller rulings: reach warning only on explicit validate; shipped rebuild keeps spreading adjacent both ways (entry trimmed in ideas.md).
Replay: p24-replay 98f6710..3384098 on 451b369 (plan 23 pre-fix). Gate 2186/19/0.
- Ruling: `route` stays callable by roles (not in COORDINATOR_TOOLS) — the spec's coordinator-tool list does not name it and plan 21 pins it; a role's route call can only append a lane-less routes.jsonl row, never take ownership — cost: a stray route row from a role in routes.jsonl.
- Ruling: plan 24 R5 accepted (logic/hard start no lower than build's start) — spec bullet — cost: default ui logic/hard start at Sol xhigh.
Final review: 0 C / 1 I / 9 M. Ruling: Minor 4 (idleQuotas false 'never starts' warning on lane-less roles on every save/doctor/TUI) upgraded to Important — a wrong warning with a wrong fix line on ordinary profiles is user-visible noise — cost: one more fix. Fix wave on 3384098.
Fix wave 1d5d599..9a9e961 on 3384098 (I1 ladders built as a monotone chain, Ruling 4 reworded; I4 idle-quota warning for the worker only and fix names the billing key, Ruling 8 reworded; minors → ideas). Worker gate 2189/19/0. Fix touched 2 source files → no re-review (CLAUDE.md: re-review only when > ~3 files).
- Ruling: idle-quota ("never starts") warning applies to the worker only — lane-less roles start on one rung so any second quota would always warn, and they never climb — cost: a reviewer rung that never runs is not named.
Rebased onto main 8880bb8 (conflicts: dispatch-service imports merged; ideas.md both kept) + plan 23 ledger 61abb85. Gate 2205/19/0. PR #49 opened ready.
Codex round (61abb85): P2 single-rung lane loses declared header (4168781505) = review M3; fixer on 61abb85.
Codex P2 fix d85f28c pushed (worker gate 2206/19/0); thread replied+resolved. Note: plan 25/26 rebase worker builds on 61abb85 — cherry-pick its result on top of d85f28c (ideas.md conflict likely).
MERGED #49 as 2bc5797 (squash).
