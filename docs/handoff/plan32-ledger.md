# progress: plan 32 (role briefs, reply contract, plan as input)

Ruling: Task 3's "<task> occurs zero times" test checks the section tag "<task>\n" — the plan's own worker copy contains the placeholder "DESIGN: <task> — …", so a bare "<task>" cannot be absent — cost if wrong: none (the real section always opens with a newline).
Ruling: PlanDoc gains `text` (the whole file) so depthProblems/decisions see sections that follow the tasks — the plan's shape lacked it; sections in the architect's order sit before the first milestone anyway — cost if wrong: none.
Ruling: test/domain/judge.test.ts still called withReplyContract (Ruling 21 said no caller); its assertion now pins the judge's `<reply_contract>` section instead — cost if wrong: none.
Ruling: the architect's "Lanes inside each milestone" part stays as item 5 of the no-plan list (tasks, owned files, fast check), since lane files and fast checks are still the architect's job — the plan's "then today's speed, edge-case and out-of-scope parts" omitted lanes — cost if wrong: one prompt paragraph.
Ruling: RunState gains `revise: string[]` (the notes of the architect's next dispatch: the owner's change request, or a readPlan problem), cleared by plan.ready/plan.approved; the approval park and the revision dispatch are level-triggered in `advance` (not react-only) — the daemon only re-derives level-triggered actions after a restart — cost if wrong: one state field.
Ruling: a readPlan failure parks on the 3rd failure (PLAN_REVISIONS = 2 re-dispatches) while other effects keep MAX_TRIES = 2 — the plan says "twice, parks on the third" but plan 30's MAX_TRIES is 2 — cost: one constant.
Ruling: existing fixtures that fed plan.ready on a plan-less run now add plan.approved{owner} after it (run-fixtures, run-machine/run-state/run-read/session-tools tests) — the new transition makes that run wait in approval — cost: none.
Ruling: readPlan's coverage check lists only lane-level problems (no Tasks line, bad ref); a task of the owner's plan with neither signature nor test is left to preflight, since the architect cannot fix it (Ruling 11's last clause) — cost if wrong: one filter.
Ruling: a task-level preflight refusal is reported under the milestone id as its `lane` (coverageProblems gives ""), so the park question reads "M1: p.md Task 4 …" — cost: none.
Gate: typecheck, lint, format:check green; bun test 2027 pass / 18 skip / 1 fail (panel-server "saves a role's rungs" timed out at 5 s under load; passes alone, 13/13). doctor flake did not fire.

## Review fixes

Final review: 0 C / 3 I fixed, 2 minors fixed. One commit each, each test failing first on the old code.

- I1 `coverageProblems` checked signature-or-test on every task of every plan file, so one unrelated task (plan 36's Tasks 9 and 12, publish and promote steps) refused every milestone. It now checks only the tasks the lanes resolve to (`d714e04`).
- I2 In phase `running`, a refused `readPlan` re-dispatched the milestone's architect with the old delta and then parked as `effect`. The failure message now joins the delta of every milestone that has one (`87907cb`).
- I3 `doc.tasks.find` took the first match when one file held a task number twice (plan 07: `## Task 13 —` and `### Task 13:`). `resolveTask` now refuses it, naming the file and the number (`fdc3e8e`).
- M1 `question.parked` and `plan.ready` were two appends, so a crash between them could lose the owner's change request. `appendEvents` validates the batch whole and writes it in one append under the events lock (`bae730f`).
- M2 The guard on `plan-approved.md` and `plan-input/` was case-sensitive; macOS disks are not. It compares lower-cased paths (`095512e`).

Ruling: the single-write batch is the atomicity the log supports (a torn tail is cut on the next read), not a transaction — cost if wrong: none.
Ruling: preflight's daemon-run test now names Task 4 through a second lane, since an unnamed task no longer refuses — cost: none.
Follow-ups noted in `docs/dev/ideas.md` (2.0 follow-ups): `decisionLines` reads only the `D<n>` line; the `labelled` parser splits at the first ` - `.
