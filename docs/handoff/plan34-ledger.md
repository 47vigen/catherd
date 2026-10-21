Plan: docs/plans/2026-10-21-34-knowledge-digest.md (plan 34, knowledge digest)

Ruling: commit trailer says "Claude Sonnet 5.5" — the brief file and the session attribution reminder both name it; the dispatch message said "Opus 5.5" — I am Sonnet 5.5 — cost if wrong: trailer text only
Ruling: no `rules` park, no rulesQuestion/pickChanges, no `finish.rules`; `finish{ outcome, proposals? }` only — the owner answer folded into the plan (the run's end never waits) — none
Ruling: the machine finishes with `proposals: []` after a judge that proposed nothing, and with no `proposals` key after a failed judge (state.rulesReview.failed tells the report apart) — fits "no change" vs "no review" report lines — none
Ruling: phone notice text unchanged (notifyMessage promises run, unit and command only); the proposals count rides in the `finished` report line instead — Task 6's "phone notice says how many" served the park version — none
Ruling: `writeRunReport(run, s, events, audits, proposals?)`; `## Rules review` text: "Standing rules to review: apply any of these with the command under it." — replaces the park-era "answer with the numbers" wording — none
Ruling: a verifier PASS's NITs enter known issues only when its HEAD names the milestone commit (the landing branch of reduce), not for a PASS about another commit — such a PASS is no verdict on the milestone — a NIT of a mismatched PASS is lost; a fresh verifier repeats it
Ruling: `preflight.done.lint` is a zod default, so RunEvent's output type requires it; existing test fixtures that built preflight.done got `lint: []` — plan says default [] and a round-trip test — none
Ruling: coverage-problem early return of preflight carries lint warnings but not `stuck` results (they surface at the next preflight) — coverage already blocks — none
Ruling: research answers are appended in workerBrief (the lane/fix body); the integrate worker (same brief kinds) gets none — it resolves merge conflicts — none

## Review fixes

Final review 1 C / 1 I fixed, 1 minor fixed. One commit, each test failing first on the old code (`8b18594`).

- C1 A refused `judge-rules` dispatch on unit `run` (E_RUN_BUDGET, E_ADMIT_RUNG, any other code) and the `effect.failed` limit on `judge@run` set `stuck.run` and parked the run. Now the review is marked failed (`{ changes: [], failed: true }`) and the run finishes.
- I1 A usage limit or E_ALL_HELD/E_ADMIT_PAUSED on the rules judge held the run up to 30 minutes each time. Now any refusal and a limit end mark the review failed at once, with no hold and no retry.
- M1 `RULE_LINE` was case-insensitive and read prose such as "Add a note" as a rule. It now matches the contract's upper-case `ADD` and `REMOVE` only.

Ruling: the owner's rule is that the rules review is advisory and never holds the run's end; any refusal of the rules judge counts, not only the listed codes — cost if wrong: a review lost to a transient refusal.
Follow-ups noted in `docs/dev/ideas.md` (2.0 follow-ups): the `" — "` splitter cuts a rule containing it; the report has no cap on known issues, standing rules or research blocks.
