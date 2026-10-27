# plan 45 — outcome gates (branch outcome-gates, base f4b5e0dc)

Wave 1: A = Task 1 then 5; B = Task 4 then 6; C = Task 2; D = Task 3.
T3 cd89acdb cherry-picked
T4 51c55f1c, T6 f3c199da cherry-picked
T1 82ae3668, T5 302665f0 cherry-picked
T2 76a5e2c6 cherry-picked; wave 1 gate green (2846 pass, 0 fail)
Extra: 01e2687a submodules borrow objects from the main checkout (--reference --dissociate; 61 s -> 5 s on a slow link, 6.5 -> 5.7 s on the box)
T7 f3a1cdea cherry-picked; wave 2 gate green (2840 pass, 0 fail)
T8 22a6b2c0, T9 68e65fb7 cherry-picked; wave 3 gate: 1 fail, web/openapi.json still listed cursor -> e6866962 regenerated
Final review (opus-medium): 0 Critical, 4 Important (I1 cursor defaultRung, I2 PROCESS_LINE too wide, I3 codex tool timeout vs team_wait, I4 writer wall) + minors; fixed in 885cc98e..43b1554c; remaining minors in ideas.md
Ruling: a retired-rung dispatch finalizes as failed/E_LOST — record statuses have no "lost" — a dashboard counting E_LOST as a backend failure misreads one upgrade
Ruling: web/src keeps the Cursor provider icon — plan 45 leaves web/ alone and old run history still names cursor — a stale icon only
Codex bot round (one): 2 P2 fixed — 650ed193 nested submodules get --init; 2a7199bc team watermark is the last message number rendered into the brief (teamSeen), old events fall back to startedAt
