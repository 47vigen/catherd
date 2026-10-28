# Plan 48 — the reducer, caps and stall (architect-led runs, stage 1, slice 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Never read the whole plan: take your task brief.

Setup: bun install --frozen-lockfile

**Goal:** the architect drives every run this build starts. Plan 47's machine (`architectNext`) becomes the only
machine and the reducer of spec D4; the 2.0 milestone pipeline, the judge, the admission order wait and the blind
rerun of a red check are deleted, with the `engine` switch. A run gets D10's caps (wall time, attempts per ledger
task), a same-rung retry with nothing new is refused as stalled, and a worker may stop `impossible`. A run an earlier
build started is read and never driven (D16).

**Architecture:** `RunState` shrinks to the run's own part (goal, questions, pause, holds, owed reports, caps) plus
plan 47's `arch`; `apply` folds `applyArchitect` first, then the run's own events, then `checkWall` (the D10 wall
cap, which may add an inbox item, stop new tasks or set `finishing`). The daemon calls `architectNext` only. The
effects keep `dispatch`, `watch`, `cancel`, `report`, `notify`, `remind`, `finish` and `runCheck`. The event schema
version goes to 2: a `run.started` at version 1 marks an earlier build's run (`RunState.earlier`), which the machine,
the daemon, the client's write calls and the architect's tools refuse. The attempts cap and the stall rule are checked
where the architect asks for a retry, in `delegate_task`.

**Tech stack:** Bun ≥ 1.4 (`bun:sqlite`), TypeScript, zod, the MCP SDK; the panel in `web/` (React, generated
openapi client, Playwright e2e).

**Spec:** `docs/specs/2026-10-27-architect-led-runs-design.md` — D4 (the reducer), D10 (caps, stall, impossible),
D16 (an earlier build's run), the deletion table rows "Milestone and round transitions", "Judge", "Admission tick",
"Auto-rerun", and the stage table, stage 1.

## Global Constraints

- Version stays 2.0 (unreleased): the plan's one changeset is `"catherd-cli": minor` (R15).
- Deletion follows replacement: nothing that plans 49–51 replace is deleted here (decision model and ladders: 49;
  landing, the land gate, `milestones.ts`, the verifier role lock: 50; reviews, the ui-reviewer, metric views: 51).
- Gate only behaviour. No acceptance line, test or contract text judges commit subjects, test-first proof or file
  scope. The architect may do anything; caps and the stall rule refuse a dispatch, never a change.
- Layers `domain → infra → adapters → services → entry` (`test/architecture.test.ts`). `bun:sqlite` stays in
  `src/infra/db.ts`.
- The panel's run model keeps its schema (`RunModelSchema`, node kinds `lane`, `review`, `verify`, `check`,
  `architect`, `start`, `end`): the panel needs no code change. Its generated client changes twice (the profile's
  `engine` goes, `caps` arrives); regenerate it, never hand-edit it.
- Tests never reach the network and never sleep on the wall clock for correctness; spawned processes get
  `ANTHROPIC_API_KEY: ""`.
- No personal hosts, product names or absolute home paths in code, tests or docs (`test/scorecard-fixtures.test.ts`).
- The full root suite takes about 350–400 s: `catherd lock -- bun test`. The panel's gate runs in `web/`; its e2e
  (`bun run build && bunx playwright test`) is run once, in M3.

## Review Focus

1. An earlier build's run is never driven: `architectNext` returns `[]`, `ensureDaemon` returns `"earlier"`,
   `runDaemon` returns `"ended"` without appending, `answer`/`cancel`/`pause`/`resume` and every architect tool refuse
   it; `status`, `result` and the panel still read it (Task 3, Task 5).
2. Nothing the deleted machine owned is still wanted by a live caller: grep for every symbol in the deletion lists;
   `bun run typecheck` and `bun run lint` (unused imports are errors) prove it.
3. The wall cap always ends: 80% wakes once, 100% stops new tasks and still wakes the architect, 100% plus 10 minutes
   sets `finishing`; the wake timer points at the next mark and stays null while paused (Task 7).
4. The stall rule refuses only a same-rung retry of a failed attempt with nothing new since; a clean end, another
   rung, a ledger edit, an owner answer or a check result each lift it (Task 8).
5. The panel: a new run draws `start → architect → task/<id> | check/<id> → end`; an earlier build's run draws one
   node per role it ran (`task/<dispatch name>`), so its dispatches stay inspectable (Task 4).

## What already exists

- Plan 47 (`docs/plans/2026-10-28-47-architect-loop.md`): `src/domain/architect-state.ts` (`ArchState`,
  `applyArchitect`, `emptyArch`, `taskAttempts`, `STANDING_CAP`, `WRITER_CAP`, `FAILED_TURNS_MAX`, the idle rule),
  `src/domain/architect-machine.ts` (`architectNext`), `src/services/architect-tools.ts` (`delegate_task`,
  `task_status`, `check`, `ledger`, `ask_owner`, `finish`, …), `src/services/architect-run.ts` (`wakeBrief`,
  `taskBrief`, `writeArchitectReport`), `src/services/ledger-store.ts`, `src/domain/ledger.ts` (`ledgerView`).
- The 2.0 pipeline beside it: `src/domain/run-state.ts` (≈2 200 lines: milestones, rounds, floors, lane status,
  decisions, the judge), `src/domain/run-machine.ts` (`next` and its action builders), `src/services/run-effects.ts`
  (≈1 500 lines), `src/services/run-briefs.ts` (one brief kind per pipeline step), `src/domain/judge.ts`,
  `src/services/run-report.ts`, `src/domain/run-graph.ts` (milestone nodes).
- `src/domain/run-events.ts` — `EVENTS_SCHEMA` 1, `ACTION_TYPES` (21 actions), `PARK_REASONS` spreads
  `BLOCKED_REASONS`, `run.started.engine` (`"2.0" | "architect"`).
- `src/services/run-events-store.ts` — `decode`, `readEvents`, `replayRun`, `runEngine`; `src/infra/db.ts`
  `insertEvent`, `ensureRunRow`.
- `src/services/daemon.ts` — `ensureDaemon`, `runDaemon` (`take`: `reduce`, `confirms`, `next` or `architectNext`).
- `src/services/run-client.ts` — `runStart` (reads `profile.engine`), `answerUnit`, `cancelRun`, pause and resume.
- `src/domain/profile.ts` `engine`; `src/services/admission.ts` (the architect's `workspace-write` on the architect
  engine, `E_ADMIT_ORDER`); `src/services/milestone-check.ts` (the rerun at lines ≈243–262, `waivedOn`);
  `src/services/team.ts` `teamWait`.
- `src/domain/budget.ts` and `admission.ts`'s `E_RUN_BUDGET`: the cost cap D10 names already refuses a dispatch.
- Test helpers: `test/domain/run-fixtures.ts` (`makeLog`, `startDispatch`, `endDispatch`, `startedFields`, and the
  2.0 `PLAN`, `runningLog`, `finishLane`, `decide`, `settled`), `test/services/helpers.ts` (`freshRun`, `fakeDeps`,
  `testView`), `test/services/fixture-run.ts` (`seedFixtureRun`: a real 2.0 run at events version 1),
  `test/panel-e2e-serve.ts` (the e2e seed).

## Contracts

```ts
// src/domain/run-events.ts (Task 1)
/** Version 2: the reducer's vocabulary. A run started at 1 was written by an earlier build. */
export const EVENTS_SCHEMA = 2;
// v: z.number().int().min(1).max(EVENTS_SCHEMA)
export const ACTION_TYPES = ["dispatch", "watch", "cancel", "report", "notify", "remind", "finish", "runCheck"] as const;
// run.started: engine is optional and read only on an earlier build's run; caps (Task 7)
ev("run.started", { repo, title, aLines, plan, base,
  engine: z.enum(["2.0", "architect"]).optional(),
  rolesOff: z.array(role).optional(),
  caps: z.object({ wallMin: z.number().positive(), attempts: z.number().int().positive() }).optional() });
// dispatch.ended loses foreign, siblings, testEdits; dispatch.started loses judgeKind

// src/services/run-events-store.ts (Task 1)
/** undefined: an earlier build's event this build does not know, skipped on read. */
function decode(row): RunEvent | null | undefined;
/** Spec D16: the run's `run.started` is older than EVENTS_SCHEMA, or the run is still on files. */
export function isEarlierRun(run: Run): boolean;

// src/domain/run-state.ts (Task 2, Task 7)
export interface RunState {
  v: 1; run: string; seq: number; at: string;
  phase: "planning" | "running" | "ended"; outcome: "done" | "cancelled" | "failed" | null;
  title: string; base: string | null; aLines: string[]; plan: string[]; rolesOff: Role[];
  earlier: boolean;               // spec D16
  caps: Caps; startedAt: string | null; pausedMs: number;   // Task 7
  arch: ArchState;                // never null
  dispatches: Record<string, DispatchView>; questions: Record<string, OpenQuestion>;
  holds: Record<string, string>; failedEffects: Record<string, number>;
  cancelling: boolean; paused: string | null; held: string | null; wakeAt: string | null;
  owed: Record<string, OwedReport>;
}
export { HOLD_MS, MAX_TRIES, REMIND_AFTER_MS, remindDue, emptyState, liveDispatches, recomputeWake, reduce, replay };

// src/domain/run-machine.ts (Task 2)
export type BriefKind = "wake" | "task";
export type Action = RemindAction | DispatchAction | WatchAction | CancelAction | ReportAction | NotifyAction
  | FinishAction /* { outcome; bare?: true } */ | RunCheckAction;
export { ACTIONS_MATCH_EVENTS, actionKey, unitOf, failKey, confirms, owedActions };   // `next` is deleted

// src/domain/caps.ts (Task 7, new)
export interface Caps { wallMin: number; attempts: number }
export const DEFAULT_CAPS: Caps = { wallMin: 720, attempts: 4 };
export const CAP_WARN = 0.8;
export const CAP_GRACE_MS = 10 * 60_000;

// src/domain/architect-state.ts (Task 7, Task 8)
interface ArchTask { /* plan 47's fields */ endedSeq: number | null }
interface ArchState { /* plan 47's fields */ wall: "ok" | "warned" | "capped"; newsSeq: number }
export function wallMs(s: RunState): number;
export function nextWallMark(s: RunState): string | null;
export function checkWall(s: RunState, e: RunEvent): boolean;   // true when it changed the state
export const attemptsOn: (a: ArchState, ledgerTask: string) => ArchTask[];
export function stalled(s: RunState, ledgerTask: string, rung: string): ArchTask | null;

// src/domain/profile.ts, src/services/ports.ts (Task 7)
interface Profile { /* … */ caps: Caps }           // doc key `caps: { wallMin?, attempts? }`, patch `caps.*`
interface ProfileView { /* … */ caps?: Caps }

// src/domain/blocked.ts (Task 8)
export const BLOCKED_REASONS = [/* plan 45's six */, "impossible"] as const;   // STOP_REASONS unchanged
```

## Rulings

Each is `R<n>: what — why — cost if wrong`. They bind every task.

- R1: the `engine` switch is deleted, not defaulted: every run this build starts is an architect run, the profile's
  `engine` key is ignored (`ProfileDocSchema` keeps it loose so an old file still reads) and `profile set engine` is
  refused by the strict patch schema — two engines side by side only served plan 47's measurement, which the owner
  closed by asking for deletion — a profile that still says `engine: "2.0"` silently runs the architect.
- R2: D16 is decided by the event schema version: `EVENTS_SCHEMA` goes to 2, a `run.started` written at 1 (or a run
  still on files) is an earlier build's run; this build replays what it can parse, skips the 2.0 events it no longer
  knows, never drives it (`architectNext` → `[]`, `ensureDaemon` → `"earlier"`, `runDaemon` → `"ended"`), refuses
  `answer`, `cancel`, `pause`, `resume` and every architect tool on it naming the version that started it (from its
  `daemon.started`), and still serves `status`, `result`, the timeline and the panel — the version field already
  exists and is what an older build checks — an earlier build's run in flight must be finished with its own build.
- R3: an older build that reads a run this build started refuses it with its existing `E_RUNTIME_TOO_OLD` (its
  `RunEventSchema` caps `v` at 1); nothing is back-ported — that is the old build's own rule — a downgrade cannot
  touch a 2.0-architect run.
- R4: the 2.0 events (25 types, listed in Task 1) leave the union outright rather than as legacy variants; `decode`
  returns `undefined` for an unparseable event below `EVENTS_SCHEMA` and the readers skip it — the reducer never
  needs them and a narrower union makes every switch exhaustive — an earlier run's timeline shows fewer lines.
- R5: `RunState.arch` is never null and `applyArchitect` runs first; the run's own `applyRun` handles only start,
  questions, pause, resume, cancel, ticks, reports and end — one fold, no fallback (plan 47 R2's double write goes) —
  none.
- R6: the run model draws a delegated task as `task/<taskId>` with the existing node kinds (`reviewer`,
  `ui-reviewer` → `review`, `verifier` → `verify`, else `lane`), a check as `check/<checkId>`, and a dispatch no task
  names (an earlier build's) as `task/<dispatch name>` titled `<unit> <role>`; a question goes to its task's node,
  `run` to the architect, an earlier unit to the last role that worked it, else `start` — no panel code change — the
  panel calls a delegated task a lane.
- R7: `run_start` refuses a `base` (E_INPUT_INVALID) until plan 50's integration tree — an architect run works in the
  checkout (plan 47 R10) — a base run cannot start between plans 48 and 50.
- R8: the architect gets `workspace-write` from admission whenever its profile says `read-only`, on every run — plan
  47 R12 without its engine test; plan 49's profile migration writes it — a hand-set `read-only` architect profile
  writes anyway.
- R9: `E_ADMIT_ORDER` (a lane's `After:` order at admission) and the refusal wait (`REFUSAL_WAIT_MS`,
  `ADMIT_WAITS`) are deleted; a dispatch the writer cap holds stays queued and starts in the call that sees a slot
  free — D10 "No admission tick" — a 1.5 coordinator who relied on `After:` must order lanes by hand.
- R10: `milestone-check.ts` never reruns a red check (`rerunOf` stays in the record schema so older records read);
  `waivedOn` (the 2.0 milestone state's check waiver) goes; the land gate, `land`, `questions.jsonl` and the
  answer mirror in `answerUnit` for a milestone park stay for plan 50 — D6 says a red check is information — a flaky
  check now wakes the architect instead of passing quietly.
- R11: the judge is deleted as code (`judge.ts`, `judgeBrief`, the judge's contract, `judge.decided|failed`); the
  `judge` role name stays in `ROLES` and profiles with a one-line retired contract until plan 49's migration drops it
  — deleting the role name now breaks every stored profile — a judge agent file says it is retired.
- R12: the worker's contract becomes task-shaped (no lanes, no Owns, no `team wait`, `STATUS: blocked — impossible`);
  the writer's, reviewer's and verifier's keep their lane wording until plans 50 and 51 rewrite them — those roles'
  briefs change with the single verifier and converging reviews — their prompts mention lanes a run no longer has.
- R13: the wall cap counts the run's time since `run.started` less every pause, from event times only (`tick`s from
  `wakeAt` make the marks fire); 80% pushes one waking inbox line, 100% (`wall: "capped"`) stops queued tasks from
  starting but still wakes the architect, 100% plus `CAP_GRACE_MS` sets `finishing = stopped` and the machine cancels
  what runs and finishes — D10 — a run asleep past its cap stops at the next tick, not before.
- R14: caps come from the profile (`caps.wallMin`, `caps.attempts`) and are pinned in `run.started.caps`; a run
  without it (or an earlier one) uses `DEFAULT_CAPS`; there is no per-run override yet and no `caps` table — the
  event is the run's record, as `rolesOff` is — an owner who wants a longer run edits the profile first.
- R15: cost stays the profile's `budget` (admission's `E_RUN_BUDGET` refusal reaches the architect as a refused
  task); the 80% budget mark is in `capabilities`, not a wake; idle stays plan 47's two-idle-turns rule — both
  already stop a runaway run — the 15-minute idle and a budget wake are ideas.md items.
- R16: the attempts cap and the stall rule live in `delegate_task`, the only place a retry is asked for: a ledger task
  with `caps.attempts` non-cancelled, non-refused tasks is refused; a ledger task whose last ended attempt is not
  `ok/complete`, with no `ledger.changed`, `question.answered` or `check.done` after it, is refused as `stalled` when
  the new rung equals that attempt's — the refusal is the tool's result, which is the architect's wake ("wakes the
  architect with stalled") — a retry without a `ledgerTask` is not counted (the architect is trusted).
- R17: the stall fingerprint is (ledger task, rung, a failed end, no news) rather than a hash of failure lines —
  what the rule must stop is a same-rung retry with nothing learned, which this states exactly — two different
  failures in a row on one rung with no news between are also refused.
- R18: a worker's `impossible` is a `BLOCKED_REASONS` member parsed from its STATUS line (`STOP_REASONS`, which the
  decision model's classifier offers, is unchanged); the end's inbox line says `(impossible, attempt n of N on L…)`;
  the architect marks a ledger task `impossible` with `ledger` and the run with `finish {verdict: "impossible"}`
  (plan 47) — no new event — `PARK_REASONS` is spelled out so the panel's types do not grow.
- R19: the report (`writeArchitectReport`) shows each ledger task's attempts and every `ask_owner` why — two plan-47
  minors this plan touches (ideas.md) — none.
- R20: the events lock stays (`withEventsLock` guards check-then-append in `answer` and `delegate_task`) — plan 46's
  R4 lock is still needed across those awaits — one file lock per run remains.
- R21: one changeset for the plan, in Task 9 — one PR — one `next` snapshot carries all three milestones.

## Edge cases

- A daemon restart mid-turn on a new run: unchanged from plan 47 (`daemon.started` re-watches and sets `fresh`).
- `catherd status` on an earlier build's run whose daemon still runs: read-only view; `answer` refuses with the
  version to use; the earlier build's own daemon keeps driving it.
- An earlier build's run still on files (`events.jsonl`): `isEarlierRun` is true without a database row.
- A pause that spans the 80% mark: the mark moves by the pause; `wakeAt` is null while paused and set again on resume.
- `finish` while capped: the architect's own verdict wins (`finishing ??=`).
- A task delegated while capped stays queued; the architect may cancel it or finish.
- A retry of a ledger task whose last attempt was cancelled or refused: neither counts as an attempt nor as a stall.
- A worker STATUS `blocked — impossible:` with no why: reason `impossible`, why empty; the inbox line says
  `no reason given`.
- `answerUnit` on a milestone park (a 1.5 session's `park`): still mirrored into `questions.jsonl` for the land gate.

## Parallelism

- M1: Task 1, then Tasks 2 and 3 at once (Task 2: domain state and machine; Task 3: daemon, store, client, effects),
  then Tasks 4, 5 and 6 at once (Task 4: run graph and the read side; Task 5: prompts, tools and briefs; Task 6:
  the remaining services and their tests). M1's tasks touch one compile unit: the milestone is green only when all
  six are in; workers rebase on each other's commits before the M1 check.
- M2 (after M1): Tasks 7 and 8 at once (Task 7: caps; Task 8: stall, impossible, the report), both touching
  `architect-state.ts` — Task 8 rebases on Task 7.
- M3 (after M2): Task 9.

Every task's code and tests are built and green in the scratch reference (below); a worker may read the reference file
it is writing, as a check, after writing its own.

## Scratch reference

`.superpowers/plan48-scratch` (gitignored), branch `plan48-scratch` on `plan48-reducer` `952f9da8` (plan 47's head),
one commit per milestone:

- M1 — `af9cb789` refactor(engine): the architect reducer drives every run; delete the 2.0 milestone machine
- M2 — `cebbd30d` feat(engine): spec D10's wall and attempts caps, the stall refusal and a worker's impossible
- M3 — `ee47c1b0` docs(plan-48): migration notes, ideas and the changeset; the panel e2e seeds an architect run

`git -C .superpowers/plan48-scratch show <sha> -- <file>` prints one file's change.

Gate results in the scratch (this machine):

- M1: typecheck, lint, format green; `bun test` 2 311 pass, 3 fail — two were assertions on `v: 1` fixed before the
  commit (`test/services/run-events-store.test.ts`, re-run green), one is `doctor.test.ts` "Codex-only doctor never
  invokes an unused Claude CLI…", which times out on the base `952f9da8` on this machine too (environment, not this
  plan). Web gate green (336 tests).
- M2: typecheck, lint, format green; `bun test` 2 302 pass, 3 fail — the same doctor test, and two load flakes
  (`preflight.test.ts` "returns when the check exits although a process it detached…", `doctor.test.ts` "counts a
  proxy's 407…") that pass when their files run alone. Web gate green (336 tests).
- M3: typecheck, lint, format green (root and web); `test/scorecard-fixtures.test.ts` green; panel e2e 13 of 13.

## M1 — The reducer drives every run; the 2.0 pipeline is deleted

A1 — a run this build starts is driven by the architect with no `engine` field; the profile's `engine` is ignored and
`profile set engine` refused (Check).
A2 — the run state, the machine, the effects and the briefs hold only what the architect loop uses; none of the
symbols this milestone lists remains in `src/` (Check).
A3 — a run an earlier build started is read by `status`, `result` and the panel, and refused by the daemon, `answer`,
`cancel`, `pause`, `resume` and the architect's tools (Check).
A4 — a red check is never rerun by catherd; the judge, the admission order wait and `team wait` are gone (Check).

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test && bun run panel:openapi && git diff --exit-code web/openapi.json && cd web && bun run gen && git diff --exit-code src/client && bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun run test

### Task 1: Events at version 2, and an earlier build's run

Files: src/domain/run-events.ts, src/services/run-events-store.ts, test/domain/run-events.test.ts,
test/domain/run-fixtures.ts, test/services/run-events-store.test.ts, test/services/helpers.ts

`EVENTS_SCHEMA = 2` with its doc comment (R2); `v` up to it. `ACTION_TYPES` is the eight in Contracts;
`LEGACY_ACTION_TYPES` and `MilestonePlanSchema` go. Delete these events and their `describeEvent` cases:
`plan.ready`, `plan.approved`, `lanes.routed`, `preflight.done`, `check.ran`, `milestone.checked`, `commit.made`,
`commit.failed`, `decision.made`, `decision.failed`, `decision.exhausted`, `lane.climbed`, `stop.classified`,
`judge.decided`, `judge.failed`, `milestone.landed`, `land.refused`, `milestone.merged`, `merge.failed`,
`base.behind`, `integrate.done`, `integrate.conflict`, `tree.ready`, `tree.deferred`, `branch.pushed`.
`run.started.engine` becomes `z.enum(["2.0", "architect"]).optional()`, `autoMerge` goes; `dispatch.started` loses
`judgeKind`; `dispatch.ended` loses `foreign`, `siblings`, `testEdits`. The imports of `decision.ts`, `harness.ts`,
`judge.ts` and `profile.ts` go from this file.

`run-events-store.ts`: `decode` returns `undefined` for a row whose `v < EVENTS_SCHEMA` and that does not parse, and
`readEvents`/`readRows` skip it; `lastSeq` falls back to the raw line's `seq`. Replace `runEngine` with `isEarlierRun`
(Contracts): `onFile(run)` or `json_extract(body, '$.v') < EVENTS_SCHEMA` on the run's `run.started` row.

`run-fixtures.ts`: `makeLog(start, v = EVENTS_SCHEMA)`; `startedFields` without `engine`; `startDispatch` takes
`lane` (default null) and `upTo`; `endDispatch` without `foreign`. Delete `PLAN`, `runningLog`, `finishLane`,
`decide`, `settled`, `routeMilestone`. `test/services/helpers.ts` gains `insertEarlier(run)`: a version-1
`run.started` (engine `"2.0"`) written with `insertEvent`.

- [ ] Write the tests; they fail.

Test: test/domain/run-events.test.ts — describe "run events (plan 48: the reducer's vocabulary, spec D4)":
- "parses every event type, and refuses an unknown type or a newer v" — one fixture per member; `v:
  EVENTS_SCHEMA + 1` refused.
- "describes each event in one line and never quotes a reply".
- "still parses an earlier build's run.started, whose engine it ignores, and drops the pipeline's events (D16)" —
  `makeLog(undefined, 1)` with `engine: "2.0"` parses; `plan.ready`, `plan.approved`, `milestone.landed`,
  `judge.decided`, `decision.made` do not; `engine: "3.0"` does not.
Test: test/services/run-events-store.test.ts — the stamp test expects `v: EVENTS_SCHEMA`; "refuses an event a newer
catherd wrote" writes `v: EVENTS_SCHEMA + 1`.

- [ ] Implement; `bunx tsc --noEmit` lists only the files later tasks own.

### Task 2: The run state and the machine

Files: src/domain/run-state.ts, src/domain/run-machine.ts, src/domain/architect-state.ts,
src/domain/architect-machine.ts, test/domain/architect-machine.test.ts, delete test/domain/run-state.test.ts,
test/domain/run-machine.test.ts, test/domain/run-pause.test.ts

`run-state.ts` is rewritten to the Contracts' `RunState` (≈200 lines): `emptyState`, `liveDispatches`,
`recomputeWake` (holds and reminders), `apply` (`applyArchitect`, then `applyRun`: `run.started` sets title, base,
aLines, plan, rolesOff, `earlier = e.v < EVENTS_SCHEMA`, phase `running`, and the inbox line "the run started:
<title>"; `question.parked` and `question.reminded`, `cancel.requested`, `run.paused`, `run.resumed`, `pause.lifted`,
`tick`, `run.ended`, `report.posted`), `reduce`, `replay`. Deleted: `REFUSAL_WAIT_MS`, `ADMIT_WAITS`,
`TOP_RUNG_JUDGES`, `REDECIDE_LIMIT`, `DUPLICATE_LIMIT`, `DECISION_TRIES`, `DECISION_RETRY_MS`, `PLAN_REVISIONS`,
`softCap`, `MilestoneStatus`, `LaneStatus`, `LaneState`, `MilestoneState`, `MadeDecision`, `laneNameOf`, `roleOfName`,
`failedOn`, `floorOf`, `MERGE_CHECK_MS`, `integrateName`, `isDone`, `isFinished`, `lanesOf`, `milestoneOf`,
`activeMilestones`, `ownerOfFile`, `limitedRung`, `hasPlanInput`, `SOURCE_PLAN_NOTE`, `STATUS_ASK`, `VERDICT_ASK`,
`dependsOn`, `siblingMayChange`, and every private reducer case of the deleted events.

`run-machine.ts` (≈130 lines): `BriefKind` `"wake" | "task"`; `DispatchAction` without `decision` (`rung` nullable,
`upTo?`); the `Action` union of Contracts; `ACTIONS_MATCH_EVENTS`, `actionKey`, `unitOf`, `failKey`, `confirms`
(`dispatch.started|refused`, `dispatch.ended`, `question.reminded`, `run.ended`, `report.posted`, `effect.failed`,
`check.done`), `owedActions`. Deleted: `next`, `Decided`, `JudgeAction`, `DecideAction`, `decidedName`, `decided`,
`judgeInputFor`, `onLaneStopped`, `laneActions`, `fixActions`, `reviewActions`, `milestoneActions`, `architectAgain`,
`planningActions`, `approvalActions`, `waitsForSibling`, `afterReady`, `rulesReviewActions`, and their helpers.

`architect-state.ts`: `byArchitect` counts `owner`; `dispatch.refused` with `E_ADMIT_PAUSED` sets `s.held` and leaves
the task queued. `architect-machine.ts`: `if (s.earlier || s.phase === "ended") return []`; nothing starts while
`s.paused` or `s.held`; no `decision` field.

- [ ] Write the test changes; they fail.

Test: test/domain/architect-machine.test.ts — `architectRun()` without `engine`; "wakes the architect at the start…"
expects `{ phase: "running", earlier: false }`; "an owner's answer wakes the architect; an earlier build's run is
never driven (D16)" ends with `makeLog(undefined, 1)` + `run.started` (`engine: "2.0"`) → `earlier: true`, and
`architectNext` on it → `[]`.

- [ ] Implement.

### Task 3: The daemon, the effects, the client and the store's readers

Files: src/services/daemon.ts, src/services/run-effects.ts, src/services/run-client.ts, src/services/run-read.ts,
src/services/run-index.ts, src/services/ledger-store.ts, src/domain/profile.ts, src/services/ports.ts,
src/services/profile-service.ts, src/services/admission.ts, src/domain/errors.ts, src/services/protocol.ts,
test/services/daemon.test.ts, test/services/run-client.test.ts, test/services/run-read.test.ts,
test/services/run-index.test.ts, test/entry/session-tools.test.ts, test/domain/profile.test.ts,
test/services/admission.test.ts, test/services/architect-daemon.test.ts, test/services/architect-effects.test.ts,
test/entry/daemon-bin.test.ts, delete test/services/run-effects.test.ts, test/services/run-daemon.test.ts,
test/services/run-report.test.ts, test/services/land-gate.test.ts, src/services/run-report.ts

`daemon.ts`: `take` calls `architectNext` only; `ensureDaemon` returns `"earlier"` and `runDaemon` returns `"ended"`
for `isEarlierRun`; the `checkMerged` key release goes. `run-effects.ts` (≈330 lines): `Effects`, `effectLimits`
(`checkMs`), `endedEvent` (no `foreign`, no `siblings`), `realEffects` with `start` (no decision, no judge, `cwd`
the run's repo), `settle`, `orphanOf`, `wake`, `perform` over the eight actions; `finish` writes
`writeArchitectReport`, then `run.ended`, `refreshState`, `backupDb`. Deleted: `milestoneChecker`, `ownerOf`,
`planOf`, the judge, decide, route, preflight, commit, land, merge, integrate, claimTree and push effects, and
`run-report.ts` (`writeRunReport`).

`run-client.ts`: `runStart` appends `run.started` without `engine` or `autoMerge` and never `plan.approved`; `base`
refused (R7); one `next` line ("the architect drives the run from its ledger…"). A new `drivenRun(id)` refuses an
earlier build's run (`E_RUN_NOT_LIVE`, the fix naming `npx catherd-cli@<daemon.started version>`) for `answerUnit`,
`cancelRun`, pause and resume. `answerUnit` drops the plan-approval branch and keeps the `questions.jsonl` mirror
for a milestone park (R10). `runResult` and `run-read.ts`/`run-index.ts` take `milestones` from the ledger
(`ledgerOf(run, s)` in `ledger-store.ts`); `rounds` 0. `profile.ts`, `ports.ts`, `profile-service.ts`: `engine`
removed (`ProfileDocSchema` keeps a loose `engine` string). `admission.ts`: the architect's `workspace-write` on every
run (R8); `E_ADMIT_ORDER` and its `unfinishedAfter` call removed (and from `errors.ts`); `protocol.ts` loses its
daemon branch.

- [ ] Write the test changes; they fail.

Test: test/services/daemon.test.ts — "never drives a run an earlier build started: no daemon, no event (plan 48, spec
D16)" — `insertEarlier(run)`; `ensureDaemon` → `"earlier"`; `runDaemon` → `"ended"`; events still only
`run.started`. The 2.0 machine-check describe is deleted.
Test: test/services/run-client.test.ts — "starts an architect run by default: its plan files are input, not an
approval (plan 48)" (no `engine` in `run.started`); "refuses a base, creating no run (landing returns in plan 50)";
"starts a run on its plan files: copies them and records them, approving nothing"; the autoMerge, base-fetch and
plan-approval tests are deleted; `runResult` returns `milestones: []` for a run with no ledger.
Test: test/entry/session-tools.test.ts — `run_start` with plan files appends only `run.started`; "refuses
run_start's base until landing comes back (plan 50)".
Test: test/services/run-read.test.ts, run-index.test.ts — seeds without `plan.ready`/`plan.approved`; the approval
waiting tests and the review-round tests are deleted; `milestones` is `[]` (view) and `{ total: 0, landed: 0 }`
(card); the timeline is `[run.started, report.posted]`.
Test: test/domain/profile.test.ts — `resolveProfile({ engine: "2.0" })` has no `engine`; the patch schema refuses
`engine`. Test: test/services/admission.test.ts — the `After:` order test is deleted.

- [ ] Implement.

### Task 4: The run graph and the panel's read side

Files: src/domain/run-graph.ts, src/services/run-files.ts, src/services/outcome-summary.ts,
src/services/scorecard-metrics.ts, test/domain/run-graph.test.ts, test/services/run-model.test.ts,
test/entry/panel-server.test.ts, test/services/run-files.test.ts, test/services/outcome-summary.test.ts,
test/services/scorecard-metrics.test.ts, test/services/overview.test.ts, test/panel-e2e-serve.ts,
web/e2e/run-page.spec.ts, web/openapi.json, web/src/client/types.gen.ts

`run-graph.ts` keeps every schema; a local `JUDGE_KINDS` keeps the attempt schema's enum. `deriveRunModel` draws per
R6: `start`, `architect`, `task/<taskId>` per `task.delegated`, `task/<dispatch name>` per other non-architect
`dispatch.started`, `check/<checkId>` per `check.requested`, `end`; attempts from `dispatch.started` (on
`task/<dispatch name>`) and `check.done`; `nodeForUnit` per R6; the architect is "driving the run". `run-files.ts`:
`planLane` goes; `checkLogs` names `worker-<lane>` and returns `exit: null`; `runShas` reads `dispatch.ended.head`;
`commitDiff` with a `lane` refuses (no lanes). `outcome-summary.ts`: no `plan.ready`/`ownerOfFile`, findings 0.
`scorecard-metrics.ts`: approvals 0. Regenerate `web/openapi.json` and the client (the profile's `engine` goes).

- [ ] Write the tests; they fail.

Test: test/domain/run-graph.test.ts — describe "the run model of an architect run (plan 48, spec D4)": "draws the
start, the architect, each task and check it asked for, and the end, with the panel's kinds"; "places a task's
dispatch on its node, a check's result on the check, and an owner question on the task"; "an ended run closes the
architect and skips what never started"; and `diffRunModel` "returns only what changed…".
Test: test/services/run-model.test.ts — "an earlier build's run (spec D16): every role it ran draws as a node of its
own, read-only" — `seedFixtureRun()` → nodes `start, architect, task/worker-M1.L1, task/reviewer-M1,
task/verifier-M1, task/judge-rules, end`, all done; worker output tokens `[10630, 7845]`; 7 dispatches; a question
on `M1.L1` names `task/worker-M1.L1`; one on `run` names `architect` with its reply.
Test: test/entry/panel-server.test.ts — node ids `task/worker-M1.L1`; the timeline filter uses
`run.started,dispatch.started`; a commit diff is served for a `dispatch.ended.head`.
Test: test/services/run-files.test.ts — no `check.ran`/`commit.made`; a diff for a role's ended head; `lane` refused.

- [ ] Implement; `bun run panel:openapi && cd web && bun run gen`.

### Task 5: Prompts, role tools and briefs without lanes

Files: src/domain/role-prompts.ts, src/domain/role-tools.ts, src/domain/brief.ts, src/infra/role-mcp.ts,
src/adapters/claude-code/index.ts, src/services/role-access.ts, src/entry/mcp/role-server.ts,
src/entry/role-cli-command.ts, src/services/team.ts, src/services/run-briefs.ts, src/services/architect-tools.ts,
delete src/domain/judge.ts, test/domain/judge.test.ts, test/domain/agents.test.ts, test/domain/verifier-prompt.test.ts,
test/domain/brief.test.ts, test/domain/architect-contract.test.ts, test/entry/role-mcp.test.ts,
test/entry/role-cli-command.test.ts, test/services/team.test.ts, test/services/run-briefs.test.ts,
test/services/verifier-brief.test.ts, test/services/dispatch-protocol.test.ts, test/services/architect-tools.test.ts

`role-prompts.ts`: the 2.0 architect body goes, `BODIES.architect = ARCHITECT_LOOP`; the worker's body is
task-shaped (R12; its lines as in the reference, including `STATUS: blocked — impossible: <why>`); the judge's body is
"The judge role is retired: no catherd run dispatches it."; `CONTRACTS.architect` and `.judge` are `STATUS_LINE`;
`NEXT_LINE.judge` and `DONE_WHEN.judge` empty; `roleContract(role, version)` loses `engine`;
`ARCHITECT_LOOP_NEXT`/`_DONE` fold in. `role-tools.ts`, `brief.ts`, `role-mcp.ts`, the Claude Code adapter,
`role-access.ts`, the role server: no `engine` argument; `roleMcpTools(role)` gives a worker and a writer
`delegate_task`, `task_status`, `thread_wait` and the architect its loop tools on every run; `team_wait` (tool and
CLI form) goes. `team.ts`: `teamWait` deleted; a steer targets the live dispatch named `to`. `run-briefs.ts` (≈80
lines): `READ_RULES`, `LOCK_RULES`, `runFacts`, `briefFor` (wake and task briefs plus team messages), `renderBrief`.
Deleted with it: `CHECK_LOG_TAIL_LINES`, `RESEARCH_ANSWER_CHARS`, `researchAnswers`, `RULES_REVIEW_BRIEF`,
`judgeBrief`, `architectBrief`, `workerBrief`, `reviewBrief`, `verifyBrief`, `integrateBrief`, `researchBrief`,
`briefBody`. `architect-tools.ts`: the earlier-run refusal uses `isEarlierRun`.

- [ ] Write the test changes; they fail.

Test: test/domain/agents.test.ts — the architect agent file starts "You are the architect of a catherd run, and its
brain"; "gives the architect the loop: tools, ledger and turns, and no milestone pipeline (plan 48)" (no "Its first
six lines", "lanes/", "Chore", "decision model", "approval"); the contract-order test skips the judge; the worker
test asserts "implement them as written", the DESIGN line, "STATUS: blocked — impossible: <why>", "Never weaken,
skip or edit a check or a test", "When your brief names a reference file, open it first", "this is a retry", "a
wrong one gets a REJECTED: line"; "tells a judge agent its role is retired (plan 48)". The 2.0 architect tests (lane
header lines, Chore, `(Check)`, fast check, translate a plan, deep plan) are deleted.
Test: test/domain/verifier-prompt.test.ts — "the worker works freely and talks to its team (plan 48: no lanes)".
Test: test/domain/brief.test.ts — a worker's run facts list `catherd call <run> delegate_task|task_status|thread_wait`
and no `team wait`. Test: test/entry/role-mcp.test.ts — a worker's tools are `read_run_file, read_knowledge,
team_send, team_read, delegate_task, task_status, thread_wait`. Test: test/services/dispatch-protocol.test.ts —
every role but the worker ends on the plain STATUS line. Test: test/services/run-briefs.test.ts — describe "a
delegated task's brief (plan 48: the only briefs are a turn's and a task's)": the repo's rules for the role at the
end of part 3, no `lanes/`; team messages to the task carried.

- [ ] Implement.

### Task 6: The remaining services

Files: src/services/milestone-check.ts, src/services/lane-service.ts, src/services/preflight.ts,
src/services/plan-input.ts, delete src/domain/slack.ts, test/domain/slack.test.ts, test/services/milestone-check.test.ts,
test/services/preflight.test.ts, test/services/plan-input.test.ts, test/services/protocol.test.ts,
test/services/notifier.test.ts, test/services/run-events-store.test.ts

`milestone-check.ts`: the rerun goes (`// plan 48, spec D6: a red check is never rerun blind…`, `const r = await
one();`), `waivedOn` and the `replay` import go. `lane-service.ts`: the daemon `replayed` branch and `verdictSettles`
go (`const settled = verdict?.passed === true;`). `preflight.ts`: a base run's preflight reads `landedMilestones`
only. `plan-input.ts`: `planProblems` drops the depth check (it needed `phase === "planning"` and an approval).
`slack.ts` (lane slack) has no caller left.

- [ ] Write the test changes; they fail.

Test: test/services/milestone-check.test.ts — "never reruns a red check blind (plan 48, spec D6)" (a command that
fails once then passes → `exit: 1`, `fails: ["FAIL flaky"]`, no `rerunOf`); the first test expects no `rerunOf`; the
base-has-it rerun test and "an owner accept on a check-red blocker lands that commit" (2.0 `milestone.checked`) are
deleted; `verifiedLog` is `run.started` and a verifier PASS. Test: test/services/preflight.test.ts — "lets a milestone
start after a merged milestone…" is deleted. Test: test/services/plan-input.test.ts — a bare plan.md gets no
`plan.md` depth problem. Test: test/services/protocol.test.ts — the describe "After: on a daemon run (plan 40 D22)"
is deleted.

- [ ] Implement; then the M1 Check, root and web.
- [ ] Commit (suggested): `refactor(engine): the architect reducer drives every run; delete the 2.0 milestone machine`

### M1 lanes

- M1.L1 — Task 1 — owns the files Task 1 lists — fast check: `bun test test/domain/run-events.test.ts test/services/run-events-store.test.ts`
- M1.L2 — Task 2 — after M1.L1 — fast check: `bun test test/domain/architect-machine.test.ts test/domain/architect-*.test.ts`
- M1.L3 — Task 3 — after M1.L1 — fast check: `bun test test/services/daemon.test.ts test/services/run-client.test.ts test/services/run-read.test.ts test/services/run-index.test.ts`
- M1.L4 — Task 4 — after M1.L2 — fast check: `bun test test/domain/run-graph.test.ts test/services/run-model.test.ts test/entry/panel-server.test.ts`
- M1.L5 — Task 5 — after M1.L2 — fast check: `bun test test/domain/agents.test.ts test/domain/verifier-prompt.test.ts test/entry/role-mcp.test.ts test/services/run-briefs.test.ts`
- M1.L6 — Task 6 — after M1.L3 — fast check: `bun test test/services/milestone-check.test.ts test/services/plan-input.test.ts test/services/protocol.test.ts`

Every lane also runs `bun run typecheck && bun run lint`; the milestone is green only with all six in.

## M2 — D10's caps, the stall refusal and `impossible`

A1 — a run pins its profile's caps (`caps.wallMin` 720, `caps.attempts` 4 by default) and the architect is woken at
80% of the wall time; at 100% no new task starts, and 10 minutes later the run stops; paused time is not counted
(Check).
A2 — a retry of a ledger task on the same rung after a failed attempt, with no ledger edit, owner answer or check
result since, is refused as stalled; a ledger task past its attempts is refused (Check).
A3 — a worker may stop `impossible` and the architect reads it in its digest; the report lists each ledger task's
attempts and every ask_owner why (Check).

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test && bun run panel:openapi && git diff --exit-code web/openapi.json && cd web && bun run gen && git diff --exit-code src/client && bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun run test

### Task 7: The wall cap and the caps in the profile

Files: src/domain/caps.ts (new), src/domain/run-events.ts, src/domain/run-state.ts, src/domain/architect-state.ts,
src/domain/architect-machine.ts, src/domain/profile.ts, src/services/ports.ts, src/services/profile-service.ts,
src/services/run-client.ts, test/domain/architect-caps.test.ts (new), test/domain/profile.test.ts,
test/services/run-client.test.ts, web/openapi.json, web/src/client/types.gen.ts

`caps.ts` as in Contracts. `run.started.caps` optional. `RunState` gains `caps`, `startedAt`, `pausedMs`;
`run.started` sets `caps = e.caps ?? DEFAULT_CAPS` and `startedAt`; `run.paused` and `run.resumed` add the closed
pause to `pausedMs` and call `recomputeWake`; `recomputeWake` adds `nextWallMark(s)`; `apply` ends with `if
(checkWall(s, e)) recomputeWake(s)`. In `architect-state.ts`: `wall: "ok"` and `newsSeq: 0` in `emptyArch`;
`wallMs`, `nextWallMark` (null when not running, earlier, paused or finishing; the next mark is 80%, 100% or 100% plus
grace by `wall`), `checkWall` (R13; the inbox lines "cap: 80% of the run's wall time is spent (<h> of <h>): plan to
land what is done and finish." and "cap: the run's wall time (<h>) is spent. No new task starts, and the run stops
in 10 minutes: finish now."; then `finishing = { verdict: "stopped", why: "cap: the run's wall time (<h>) is spent" }`).
`architect-machine.ts` starts no queued task while `wall === "capped"`. `profile.ts`: doc key `caps` (loose),
`Profile.caps` resolved with `DEFAULT_CAPS` (a non-integer `attempts` falls back), the patch schema's `caps`;
`ProfileView.caps?` and `viewOf` pass it; `runStart` pins `caps: runProfile(deps, run).caps ?? DEFAULT_CAPS`.
Regenerate the panel's openapi and client.

- [ ] Write the tests; they fail.

Test: test/domain/architect-caps.test.ts — describe "spec D10: the wall cap":
- "pins the profile's caps, D10's defaults when the run names none".
- "wakes the architect at 80%, starts no new task at 100%, and stops the run after the grace" — `caps: { wallMin: 100
  }`: `wakeAt` at 80 min; a tick there adds the 80% line and moves `wakeAt` to 100 min; a tick there adds the cap
  line; a delegated T1 then is not started but `architect-1` is; a tick at 100 min plus the grace sets `finishing`
  (stopped, "cap"), and `architectNext` gives `finish` `failed`.
- "counts no paused time" — paused at 10 min: `wakeAt` null; resumed at 70: `wakeAt` at 140 min; a tick at 100 min
  adds no 80% line.
Test: test/domain/profile.test.ts — a bare document resolves `caps` `{ wallMin: 720, attempts: 4 }`, `caps: { wallMin:
60 }` → `{ 60, 4 }`; the default document's keys include `caps` after `timeouts`.
Test: test/services/run-client.test.ts — `run.started` carries `caps: { wallMin: 720, attempts: 4 }`.

- [ ] Implement.

### Task 8: Stall, attempts, impossible and the report

Files: src/domain/architect-state.ts, src/domain/blocked.ts, src/domain/run-events.ts, src/services/architect-tools.ts,
src/services/architect-run.ts, test/domain/architect-caps.test.ts, test/services/architect-tools.test.ts,
test/services/architect-run.test.ts

`ArchTask.endedSeq` set by its `dispatch.ended`; `newsSeq` set by `ledger.changed`, `question.answered`, `check.done`
(`thread.sent` gets its own empty case). `attemptsOn`, `stalled` as in Contracts (R16, R17). The task end's inbox
line reads `ended <outcome> (<reason>, attempt <n> of <cap> on <ledger task>)`, each part only when present.
`delegate_task`, after the ledger task check: refuse `ledger task <L> has had its <cap> attempts` (fix: "replan or
split it, ask the owner, or set it impossible with ledger") and `stalled: <T> on <L> ended <outcome> on <rung>, and
nothing new came in since` (fix: "change the rung, edit the ledger with what you learned, ask the owner, or set <L>
impossible"). `blocked.ts`: `impossible` in `BLOCKED_REASONS` and the `BLOCKED_LINE`; `parseBlockedReason` accepts
`[...STOP_REASONS, "impossible"]`; `STOP_REASONS` unchanged (R18). `run-events.ts`: `PARK_REASONS` spelled out with
the old six blocked reasons first. `architect-run.ts`: `ledgerView(ledgerTasks(run), taskAttempts(s.arch))`; a task
line ends `(n attempt[s])`; the change log also lists a `question.parked` with a `why` as `(architect)` (R19).

- [ ] Write the tests; they fail.

Test: test/domain/architect-caps.test.ts — describe "spec D10: stall and impossible":
- "a failed attempt with nothing new since stalls a retry on the same rung, not on another" — then a
  `ledger.changed` lifts it.
- "a clean end never stalls, and each end names its attempt against the cap" — "attempt 1 of 4 on L1".
- "a worker may stop impossible, and the architect reads the reason" — `parseBlockedReason("impossible: …")`; the
  inbox line has "ended ok/blocked (impossible)".
Test: test/services/architect-tools.test.ts — "refuses a same-rung retry with nothing new, and a ledger task past its
attempts (plan 48, spec D10)" — `caps.attempts` 2: T1 blocked → a same-rung retry refused ("stalled"), another rung
→ T2; T2 complete → a third refused ("has had its 2 attempts").
Test: test/services/architect-run.test.ts — "lists each ledger task's attempts and the why of every ask_owner" — "- L1
[todo] the parser (1 attempt)" and "question.parked (architect): L1 cannot be done".

- [ ] Implement; then the M2 Check.
- [ ] Commit (suggested): `feat(engine): spec D10's wall and attempts caps, the stall refusal and a worker's impossible`

### M2 lanes

- M2.L1 — Task 7 — fast check: `bun test test/domain/architect-caps.test.ts test/domain/profile.test.ts test/services/run-client.test.ts`
- M2.L2 — Task 8 — after M2.L1 (shared `architect-state.ts`) — fast check: `bun test test/domain/architect-caps.test.ts test/services/architect-tools.test.ts test/services/architect-run.test.ts`

## M3 — Docs, ideas, the changeset and the panel's e2e

A1 — MIGRATION.md tells an owner what changes for a run and a profile, and how an earlier build's run is finished
(Check).
A2 — ideas.md names what plan 48 left on purpose; the plan-47 minors it fixed are gone from the list (Check).
A3 — the panel's e2e passes on a seed of architect runs (Check).

Check: bun run typecheck && bun run lint && bun run format:check && bun test test/scorecard-fixtures.test.ts && cd web && bun run lint && bun run format:check && bun run build && bunx playwright test

### Task 9: MIGRATION.md, ideas.md, the changeset, the e2e seed

Files: MIGRATION.md, docs/dev/ideas.md, .changeset/plan-48-reducer.md (new), test/panel-e2e-serve.ts,
web/e2e/dashboard.spec.ts, web/e2e/questions.spec.ts, web/e2e/run-page.spec.ts, web/e2e/smoke.spec.ts

MIGRATION.md, "From 1.5 to 2.0": rename "The architect loop, behind a switch (plan 47)" to "The architect loop (plan
47)"; add "The architect drives every run (plan 48)" before "Grok Build and Antigravity are removed": the switch is
gone; the 2.0 pipeline is deleted; an earlier build's run is read, never driven, and finished with
`npx catherd-cli@<version>`; `run_start` refuses a `base` until landing; the caps and `profile set caps.wallMin`; the
stall refusal and `impossible`. ideas.md: a "From plan 48 (the reducer, caps and stall)" section above plan 47's
(the dead 2.0 modules plan 50 deletes, `PARK_REASONS`, the lane-shaped writer/reviewer/verifier contracts, failover
on a hold, the idle and budget marks, the stall rule without a hash, the events lock, the scorecard's rounds and
approvals at 0); remove plan 47's "`ask_owner`'s `why` is missing…" and "The report never shows running or review."
The changeset (`"catherd-cli": minor`) in one paragraph. The e2e seed: plan.md written and T1, T2 delegated per run;
the live dispatch is `T1` (unit `T1`, no lane); the questions are on `T2` with reason `owner`; the specs say `T1
worker`/`T2 worker` (the fixture run's node keeps `M1.L1 worker`) and drop the fixture's fast-check node.

- [ ] Write it; the M3 Check passes.
- [ ] Commit (suggested): `docs(plan-48): migration notes, ideas and the changeset; the panel e2e seeds an architect run`

## Out of scope

- Ladders, escalation, the decision model and the profile migration of D16 (`judge`, `decision`, `bars` dropped;
  rungs to ladders; `caps` and `memory` written): plan 49.
- Landing, the integration tree, a base run, the single verifier, and the deletion of `milestones.ts`,
  `milestone-tree.ts`, `preflight()`, `lane-service.ts`, `gate-service.ts`, the verifier role lock, `protocol.ts`
  and the land parks: plan 50.
- Converging reviews, the ui-reviewer fold, the D17 metric views, `PARK_REASONS` shrinking: plan 51.
- D10's 15-minute idle, a budget wake at 80%, and failover on a held quota (ideas.md).

## Next plans

Unchanged from plan 47's list, with plan 48's leftovers added to plan 50 (the dead 2.0 modules, the answer mirror,
the lane-shaped contracts of the writer and verifier) and plan 51 (`PARK_REASONS`, the reviewer's contract, rounds and
approvals as metric views).
