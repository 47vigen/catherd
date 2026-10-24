# Plan 40 — run efficiency: the orchestration core

Setup: bun install --frozen-lockfile

Source: the four run-efficiency studies of 2026-10-24 (prompts, verifier time, rework, throughput) over the credit, platform, plan-38 and plan-39 runs. The verifier babysat a deterministic check (66 % of its wall time), a PASS was thrown away on every base move, accept and land refusal, findings were routed lossily, locks starved runs, and every role got every plan's preamble. Priority: the daemon runs the Check, no wasted re-verification, locks, findings routing, lane state, plan lint, baselines, host safety, briefs, Codex usage.

## What already exists

- src/services/milestone-check.ts — `CheckRecordSchema` (28–44), `runLogged` (111–122, child env has no `CATHERD_LOCK_HELD`), `execMilestoneCheck(job)` (146–201; `start = Date.now()` at 154 is before the locks at 163–175), `acceptedLandQuestions` (204–219, exact `accept` at 213), `machineGate(run, m, head): Promise<{ missing; audit }>` (292–371), `checkLimits` (374), `runMilestoneCheck(i, o?)` (421–437, one record per `checkItems` item), `runCheckItem` (439–558, cache keyed run+milestone+command+HEAD at 467–486), `checkWorker(flight)` (561–573), `checkBase(run, m?)`, `baselineFor(toplevel, command, base)`.
- src/infra/heavy-lock.ts — `LOCK_HELD_ENV` (14), `heavyLimits` (23–28), `withHeavySlot` (50–58), `withHeavySlotWithin` (64–98: load gate 75–78, then every waiter polls `tryLock` at 500 ms, no order), `withRoleLock(role, owner, fn, o)` (130–165: a holder of the owning run joins whenever any holder lives, 144; no bound, no event).
- src/domain/run-state.ts — `MilestoneState` (120–172), `LaneState` (76–118), `laneDone` (491–507, clears `notes`), `completeRound` (512–551), `fixRound` (554–586, one owner per finding via `ownerOfFile(f.file, …)`), `laneStopped` check_broken (654–663), `laneEnded` (673–701, `checking` at 694), `mergedIn` (704–712), verifier end (781–827), `onJudged` route (873–890), `onAnswered` (927–980, bare `accept` at 972, `else m.status = from` at 979), `dispatch.refused` (1066–1098, default park as `effect` at 1095), `check.ran` (1102–1139), `land.refused` (1244–1263, first refusal → fresh verifier), `base.behind` (1394–1403).
- src/domain/run-machine.ts — `Action`, `actionKey`, `unitOf`, `confirms` (143–197), `waitsForSibling` (294–304, direct dependents only), `afterReady` (310–321), `laneActions` (323–375), `fixActions` (406–425, triage judge in the same tick as the routed worker), `milestoneActions` "verifying" (468–486), `PAUSED_STEPS` (682–690).
- src/domain/run-events.ts — `ACTION_TYPES` (42–63), `FindingSchema`, `check.ran` (161–167), `tree.deferred` (205), `describeEvent` (237–318).
- src/services/run-effects.ts — `endedEvent` (95–136, `parseFailLines` at 112), `fastCheck` (530–563), `commit` (586–646; `git add -A` forgives only "did not match any files", 605–609), `landIt` (648–689, base checked only here, 654–660), `integrate` (692–713), `claim` (735–758), `perform` (775–890), `effectLimits` (55). Test seams follow `branchPusher`/`memoryReader` in src/services/milestone-tree.ts (20, 26).
- src/services/milestone-tree.ts — `setupOf(run)` (55–67), `setUp(deps, run, tree)` (70–92, submodules then the plan's `Setup:` in a heavy slot), `claimTree`.
- src/services/lane-service.ts — `gate(run, m, commit, skip)` (345–490): verifier verdict (400–434), verdict HEAD must prefix the landed commit (436–453), `machineGate` (454–462), gates.jsonl items need a pass whose commit prefixes the landed head (463–488).
- src/services/gate-service.ts — `recordedItems(run, m)` (370–392, `passed` = a pass on the current content hash of the item's paths), `carryingPass`, `gateItemInputs`.
- src/domain/findings.ts — `PATH` (6, no `:L12`, no `:1,2,3`), `fileOf` (12–19, first path of the first 4 tokens), `parseFailLines(reply, max = 12)` (35–47, every line below the verdict, PASS lines included).
- src/domain/fail-lines.ts — `checkItems(command)` (45–188, splits at every top-level `&&`, so `cd d && cmd` runs `cmd` at the root), `newFails`, `checkFailLines`.
- src/domain/plan-doc.ts — `TASK_HEADING` (19, `### Task 1.3` parses as task 1), `TASK_REF` (20), `isApproval` (152), `milestoneCheck(planText, id)` (204–214).
- src/domain/plan-lint.ts — `lintLanes(lanes, known, finished)`, `milestoneProblems`. src/services/preflight.ts — `CHECK_TIMEOUT_MS = 120_000` (51), lint call (311–320), slot + `runCheck` (377–381).
- src/services/admission.ts — `unfinishedAfter` from dispatch records (233–240), run-wide `E_ADMIT_OVERLAP` (297–308), `composeBrief(…, { context: planContext(run, i.role) … })` (354–364). src/services/protocol.ts — `laneDone` (82–108), `unfinishedAfter` (123–130).
- src/services/plan-input.ts — `PLAN_CONTEXT_MAX` (22), `planContext(run, role)` (88–102: every file's preamble, a taskless file whole, past 100 000 chars a "read them all" pointer), `milestoneTasks`, `deliveredALines`, `numberedALines`.
- src/services/run-briefs.ts — `ALINES` (27–32, run-wide), `workerBrief` (209–233), `reviewBrief` recheck (305–329), `verifyBrief` (361–397), `judgeBrief` (460–498). src/domain/brief.ts — `BriefContext` (6–20), `composeBrief` (83–106). src/domain/role-prompts.ts — verifier body (73–97, `...VERIFIER_GATE_RULES` at 89), `SECTIONS` (206), `roleSections` (260–276). src/domain/gate-brief.ts — `VERIFIER_GATE_RULES` (9–15, "Stay in the foreground" at 12), `gateNotes` (30–47, repeats the rules at 32). src/services/verifier-brief.ts — `verifierBrief`.
- src/adapters/codex/events.ts:64–67 — sums every `turn.completed.usage`, which is thread-cumulative on a resumed thread. src/services/finalize.ts — `priorOn` (111–122), `settled` (125–143); src/adapters/opencode/index.ts:276 — `settle` subtracts `prior`, the pattern to copy.
- Full root suite: about 180 s.

## Contracts

```ts
// src/domain/plan-doc.ts
export const TASK_HEADING: RegExp; // ids 3, 3a, 1.3, 1.3a
export const TASK_REF: RegExp; // the same ids, optional `<file>#`
export function isAccept(answer: string): boolean; // first word `accept`, any case
export function milestoneSection(planText: string, id: string): string | null; // `## <id>` line to the next `## `
export function baselineItems(planText: string, id: string): string[]; // `Baseline: <check item>` of the section and the preamble
export const CHECK_COVERED: RegExp; // an A-line ending `(Check)` (a trailing `.` allowed)

// src/domain/fail-lines.ts
export function coveredDir(item: string): string | null; // `(cd d && …)` or `cd d && …` → "d/"; else null (whole tree)

// src/domain/findings.ts
export function filesOf(text: string): string[]; // every path token: path, path:12, path:12-20, path:L12, path:1,2,3
export function parseFailLines(reply: string): Finding[]; // FAIL / BLOCKER / BUG / `A<n> … FAIL` lines only, no cap

// src/domain/plan-lint.ts
export function lintPlan(planText: string, milestone: string, aLines: string[]): string[];

// src/infra/heavy-lock.ts
export interface LockWait { lock: string; holder: string | null; ahead: number; waitedMs: number } // lock: "heavy" | "role-<role>"
// heavyLimits += { roleWaitMs: 1_800_000, diskReserveMb: 4096, freeMb: () => number }
// withHeavySlot, withHeavySlotWithin, withRoleLock: o.onWait?: (w: LockWait) => void; FIFO tickets

// src/services/milestone-check.ts
// CheckRecordSchema += { startedAt?: string; waitedMs?: number; carriedFrom?: string }; durationMs = execution only
// checkLimits += { itemMs: 1_800_000 }; runMilestoneCheck(i, o?: { onWait?: (w: LockWait | null) => void })
export async function freshFailures(run: Run, m: string, head: string): Promise<{ item: string; lines: string[] }[]>;
export async function missingBaselines(run: Run, m: string, head: string): Promise<string[]>; // failing items with no base record
export async function verdictCarries(run: Run, m: string, from: string, to: string): Promise<boolean>;

// src/services/plan-input.ts
export function uncoveredALines(run: Run, m: string): string[]; // the delivered A-lines (full text) without (Check)
export function planContext(run: Run, role: Role, milestone?: string | null): string | null;

// src/domain/run-events.ts — plan 42 (the panel) displays these
// ACTION_TYPES += "machineCheck"
// check.ran += { startedAt?: string; durationMs?: number; waitedMs?: number; siblings?: string[] } // siblings: M5
// dispatch.ended += { siblings?: string[] } (M5); tree.deferred += { resource?: "memory" | "disk" }
type MilestoneChecked = { type: "milestone.checked"; milestone: string; head: string; command: string | null;
  missing: string[]; findings: Finding[]; uncovered: string[]; checkOnly: boolean; verdictCarried: boolean;
  startedAt: string; durationMs: number; waitedMs: number };
type LockWaiting = { type: "lock.waiting"; unit: string; lock: string; holder: string | null; ahead: number };

// src/domain/run-machine.ts
type MachineCheckAction = { type: "machineCheck"; milestone: string; commit: string }; // key machineCheck:<m>

// src/domain/run-state.ts
interface MilestoneState { /* … */ checkedOn: string | null; verifierPassedOn: string | null; uncovered: string[];
  checkOnly: boolean; disputes: number; disputing: boolean }
interface LaneState { /* … */ queued: string[]; waitOn: string[] } // M5
export const ADMIT_WAITS = 12; // M5

// src/domain/brief.ts — BriefContext += { resumed: boolean } (M6)
// src/domain/role-prompts.ts — SECTIONS = ["context","role","team","task","done_when","reply_contract"]; roleSections o.only?
```

## Decisions

- D1 — The daemon runs the milestone's Check itself (a `machineCheck` action through `runMilestoneCheck`'s detached worker) before any verifier. Red: a fix round from the fresh failing lines, with no LLM. Green: the LLM verifier runs only for the A-lines the Check does not cover, and its brief says the Check passed — rejected: the verifier running gate_run — it waited on a command for 66 % of its time, and 24–48 % of its dispatches added nothing.
- D2 — An A-line is covered when its line ends with `(Check)`. A milestone that has a Check and delivers at least one A-line, all of them covered, lands on the green Check with no LLM verifier. A milestone that delivers none keeps its verifier — rejected: guessing coverage from wording — it cannot be tested.
- D3 — Carry rules, superseding plan 39 D3. (a) A machine record carries to a new HEAD only for an item that covers one directory (`coveredDir`), when `git diff --name-only old new` touches nothing under it; a whole-tree item reruns on each HEAD, which now costs no LLM time. (b) A verifier PASS carries from A to B when `git diff --name-only A B` touches none of the milestone's paths (its lanes' Owns plus what its lanes' records changed). (c) A gates.jsonl item carries by its content hash (`recordedItems().passed`), not by commit prefix — rejected: carrying whole-tree items by disjoint paths — a base change can break the milestone without touching its files.
- D4 — The base is merged before a base-run milestone's first machine check: `machineCheck` emits `base.behind` — rejected: only at land — 10 credit re-verifies followed a late integrate.
- D5 — `accept…` (first word accept, any case) waives. On a blocker after a verifier FAIL on this commit it stands for the verifier's PASS. After a review-cap blocker the verifier still runs, since none ran. On a land park it waives the named baseline lines — rejected: accept always skipping the verifier — code no verifier saw would land.
- D6 — A first `land.refused` clears `checkedOn` and returns to verifying: the daemon reruns only the items with no record on the head (the per-item cache) and lands on the verdict it has. A second refusal parks — rejected: a fresh verifier (today) — 8 re-verifies, 1.4 h, all PASS.
- D7 — Locks use FIFO tickets in `locks/queue-<lock>.json`, and only the oldest live ticket takes a slot. The role lock refuses a same-owner join while an older ticket of another owner waits. Past `heavyLimits.roleWaitMs` a waiter enters anyway and says so. A daemon wait is one `lock.waiting` event — rejected: a lock server — file locks already reclaim dead holders.
- D8 — `CATHERD_LOCK_HELD=1` is in the env of every check catherd runs under a slot (lane fast check, milestone check item, preflight), so a nested `catherd lock` runs at once — rejected: rewriting commands — they are the owner's text.
- D9 — `checkItems` joins a bare `cd <dir>` item with every item after it, since the shell runs them in `<dir>`. There is no lint for it — rejected: refusing `cd x &&` — it is valid shell, and the split was catherd's bug.
- D10 — Dotted task ids (`### Task 1.3`, `Tasks: 1.3`) are ids — rejected: refusing them — the owner's format is theirs, and the refusal came after a 20-minute architect.
- D11 — The plan lint gives preflight warnings, never a refusal: a milestone with no `Check:`; a Check item that is a shell loop (one budget for many packages); an A-line about commit history; an Owns entry git ignores. `commit()` treats an ignored Owns path as absent — rejected: refusing the plan — the owner's A-lines are not the architect's to edit.
- D12 — A milestone check item runs at most `checkLimits.itemMs` (30 min). Then its group is killed and it is recorded failed with a `timed out` line — rejected: 600 s — a full suite on a loaded host needs more, and the wait costs no LLM.
- D13 — A plan `Baseline: <check item>` line accepts that item's pre-existing failing lines with no park; a new line still fails. A milestone section's line covers that milestone, a preamble line covers every milestone. A review round that stops on BLOCKERs no lane owns (A-line disputes) goes to the triage judge once before an owner park. If the judge dismisses them all, they become known issues and the milestone goes on — rejected: a profile waiver list — a plan line travels with the plan.
- D14 — Host: a heavy slot waits, as long as the load gate at most, while free disk in catherd's data dir is under `heavyLimits.diskReserveMb` (4096). `claimTree` defers a second working milestone (`tree.deferred`, `resource: "disk"`). Preflight's check timeout becomes 600 s, the fast check's own limit — rejected: profile knobs — none was asked for.
- D15 — `<context>` holds the preambles of the plan files the dispatch's milestone takes tasks from. Of a taskless plan file it holds the `## ` sections those tasks cite, by `§<n>` or by heading text. Run-level roles keep every preamble. Past `PLAN_CONTEXT_MAX` it is cut with a note naming the cut file — rejected: per-role section filters — the Contracts and Decisions names cross milestones.
- D16 — A resumed dispatch (`thread` set) gets only `<task>` and `<reply_contract>`: the new lines and the lane file — rejected: a diff against the thread's last brief — the thread holds it already.
- D17 — Section order is `context, role, team, task, done_when, reply_contract`, so all roles of a milestone share the longest prefix — rejected: `team` first — it is 1.4 KB, and the context is up to 57 KB.
- D18 — Verifier, ui-reviewer and judge briefs carry only their milestone's A-lines (the delivered ids, plus lines with no id). `VERIFIER_GATE_RULES` live only in the role body — rejected: keeping gateNotes' copy — 2.7 KB repeated in every verifier brief.
- D19 — A Codex dispatch's tokens are its last `turn.completed.usage` minus what earlier records on its thread counted, through the `settle` hook — rejected: summing per dispatch (today) — recorded tokens and cost were about 2× real.
- D20 — `filesOf` reads `path:12`, `path:12-20`, `path:L12` and `path:1,2,3`. A finding that names files of several lanes goes to each of them — rejected: the first path only — the other lanes never heard of it.
- D21 — A judge route to a lane that is running or checking is queued (`LaneState.queued`), and becomes its notes when that try ends — rejected: cancelling the running try — it may be fixing the same file.
- D22 — A daemon run's admission reads the replayed lane state for `After:`. `E_ADMIT_ORDER` and `E_ADMIT_OVERLAP` wait `REFUSAL_WAIT_MS`, and park only after `ADMIT_WAITS` refusals in a row. Overlap counts only dispatches in the same working tree — rejected: parking as `effect` (today) — 112 min on a critical path.
- D23 — `waitsForSibling` ignores every transitive dependent. A failed fast check (the daemon's, or a worker's `check_broken`) whose output names a file of a sibling lane that is not done is a cross-lane wait. The lane goes to `checking` with `waitOn`, and its fast check reruns once those lanes are done; no try is counted — rejected: marking it done or check_broken — it is neither.
- D24 — run-state.ts, run-machine.ts and run-events.ts change in M4 and M5 only, one lane each, and M5 runs after M4 — rejected: side-by-side milestones — they would conflict in the reducer.

## M1 — Plan text: tasks, check items, findings, lint

A1 — dotted task ids parse; `cd d && cmd` runs as one check item; `filesOf` and `parseFailLines` as in Contracts; preflight lints the plan's Check, A-lines and ignored Owns, gives its check 600 s and sets `CATHERD_LOCK_HELD`.
A2 — the root gate is green (Check).
A3 — web/ is untouched.
A4 — each fix has a test that fails without the fix.
A7 — the diff adds no home-directory path and no private host name.

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 1: Plan-doc readers

Files: src/domain/plan-doc.ts, test/domain/plan-doc.test.ts

```ts
export const TASK_HEADING = /^#{2,4}[ \t]+Task[ \t]+(\d+(?:\.\d+)*[a-z]?)\b[ \t]*[:.—–-]?[ \t]*(.*)$/gim;
export const TASK_REF = /^(?:([^\s#,]+)#)?(\d+(?:\.\d+)*[a-z]?)$/;
export function isAccept(answer: string): boolean;
export function milestoneSection(planText: string, id: string): string | null;
export function baselineItems(planText: string, id: string): string[];
export const CHECK_COVERED = /\(Check\)\s*\.?\s*$/i;
```

`### Task 1. Title` (a dot then a space) still parses as task 1. The preamble is the text above the first `## M<n>`.

Test: test/domain/plan-doc.test.ts — "a dotted task id is its own task" — `### Task 1.3: x` and `### Task 1.4: y` give ids 1.3 and 1.4; `resolveTask(docs, "1.3")` finds the first.
Test: test/domain/plan-doc.test.ts — "isAccept takes accept with text after it" — `accept`, `Accept.`, `accept: A8 is judged from the tree` → true; `do not accept`, `acceptance` → false.
Test: test/domain/plan-doc.test.ts — "baselineItems reads the section and the preamble" — a preamble line and an M2 line → M2 gets both, M1 only the preamble's.
Test: test/domain/plan-doc.test.ts — "milestoneSection stops at the next ## heading" — M1's text holds its own Check line only.

### Task 2: Check items keep a leading cd with its command

Files: src/domain/fail-lines.ts, test/domain/fail-lines.test.ts

```ts
export function coveredDir(item: string): string | null;
```

A top-level item that is exactly `cd <word>` joins itself and every later item into one item, so `a && cd d && b && c` gives `a` and `cd d && b && c`.

Test: test/domain/fail-lines.test.ts — "a leading cd runs with the rest" — `bun install && cd services/credit && task acceptance` → `bun install`, `cd services/credit && task acceptance`.
Test: test/domain/fail-lines.test.ts — "coveredDir names the subshell's folder" — `(cd web && bun run test)` → `web/`; `cd a/b && x` → `a/b/`; `bun test` → null.

### Task 3: Finding paths and verifier fail lines

Files: src/domain/findings.ts, test/domain/findings.test.ts

```ts
export function filesOf(text: string): string[];
export function fileOf(text: string): string | null; // the first of filesOf over the first 4 tokens
export function parseFailLines(reply: string): Finding[];
```

`parseFailLines` keeps a line below the verdict only when, after a list marker and bold, it starts with FAIL, BLOCKER or BUG, or is `A<n> … FAIL …`. Each is a BLOCKER, with `file` from `fileOf`. It has no cap.

Test: test/domain/findings.test.ts — "comma and L line lists keep their path" — `BUG src/domain/run-state.ts:152,401,522 — x` → `src/domain/run-state.ts`; `src/a.ts:L12` → `src/a.ts`.
Test: test/domain/findings.test.ts — "filesOf lists every file of a multi-file finding" — four paths in one finding → four entries, in order.
Test: test/domain/findings.test.ts — "a FAIL reply keeps only its failing lines" — `A1 PASS`, `HEAD: abc`, `**Gate items**`, two `FAIL …` lines and 14 more `FAIL` lines → 16 findings, no PASS or heading line.

### Task 4: Plan lint and preflight

Files: src/domain/plan-lint.ts, src/services/preflight.ts, test/domain/plan-lint.test.ts, test/services/preflight.test.ts

```ts
export function lintPlan(planText: string, milestone: string, aLines: string[]): string[];
const CHECK_TIMEOUT_MS = 600_000; // preflight.ts: the daemon's fast check limit
```

lintPlan warns: `<m>: no Check: line: the verifier must run the whole gate by hand`; `<m>: Check item \`<item>\` is a shell loop: one 30-minute budget for every package; write one item per package`; `<m>: <A-id> asks for commit history (<words>): catherd commits tests and code together; it is judged from the tree`. The history words are `before (the|its) code`, `red before`, `failed before`, `in its own commit`, `alone in (its|a) commit`, `TDD` and `commit history`, matched case-insensitively. The A-lines it reads are the milestone section's lines starting `A<n>` plus `aLines`. preflight appends `lintPlan(plan.md, milestone, run.meta.aLines)` to `lint` when `i.milestone` is set, and per lane Owns entry that `git check-ignore -q` matches in the tree: `<lane>: Owns <p> is ignored by git: catherd cannot commit it`. Its `runCheck` env adds `[LOCK_HELD_ENV]: "1"`.

Test: test/domain/plan-lint.test.ts — "a loop item and a history A-line are warned" — `Check: for p in a b; do x; done && y` and `A8 — tests failed before the code` → two warnings naming the item and A8.
Test: test/domain/plan-lint.test.ts — "a milestone without Check: is warned" — one warning.
Test: test/services/preflight.test.ts — "an ignored Owns entry is a lint warning" — `.gitignore` holds `gen/`, a lane owns `gen/client.ts` → `lint` names it, and the milestone is not blocked.
Test: test/services/preflight.test.ts — "a preflight check runs with CATHERD_LOCK_HELD" — the check `printenv CATHERD_LOCK_HELD` prints 1.

### M1 lanes

- M1.L1 — Task 1 — owns src/domain/plan-doc.ts, test/domain/plan-doc.test.ts — fast check: `bun test test/domain/plan-doc.test.ts && bun run typecheck && bun run lint`
- M1.L2 — Task 2 — owns src/domain/fail-lines.ts, test/domain/fail-lines.test.ts — fast check: `bun test test/domain/fail-lines.test.ts && bun run typecheck && bun run lint`
- M1.L3 — Task 3 — owns src/domain/findings.ts, test/domain/findings.test.ts — fast check: `bun test test/domain/findings.test.ts && bun run typecheck && bun run lint`
- M1.L4 — Task 4 — after M1.L1, M1.L2 — owns src/domain/plan-lint.ts, src/services/preflight.ts, test/domain/plan-lint.test.ts, test/services/preflight.test.ts — fast check: `bun test test/domain/plan-lint.test.ts test/services/preflight.test.ts && bun run typecheck && bun run lint`

## M2 — Locks, check timing and disk

A1 — FIFO heavy slots and role lock with a bounded role wait and wait info; a disk reserve gate; milestone check children run with `CATHERD_LOCK_HELD`; `durationMs` counts execution only and records carry `startedAt` and `waitedMs`; an item stops at 30 min.
A2 — the root gate is green (Check).
A3 — web/ is untouched.
A4 — each fix has a test that fails without the fix.
A7 — the diff adds no home-directory path and no private host name.

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 5: FIFO locks, bounded role wait, disk gate

Files: src/infra/heavy-lock.ts, test/infra/heavy-lock.test.ts

```ts
export interface LockWait { lock: string; holder: string | null; ahead: number; waitedMs: number }
export const heavyLimits: { loadWaitMs; loadPollMs; load; cores; roleWaitMs: number; diskReserveMb: number; freeMb: () => number };
```

A waiter appends a ticket `{ pid, startTime, token, at, owner? }` to `locks/queue-heavy.json` (or `queue-role-<role>.json`) under `withFileLock`, and drops dead tickets on each look. Only the oldest live heavy ticket tries the slots; the ticket is removed once it holds one, or when `waitMs` runs out. The role lock lets a same-owner join only while no older live ticket of another owner waits. After `roleWaitMs` the waiter enters anyway. `onWait` gets the holder (`state.owner` or the slot's), how many tickets are ahead, and the time waited. `freeMb` is `statfsSync(locksDir())` in MB. Before the slot loop a waiter also waits, within the load gate's deadline, while `freeMb() < diskReserveMb`. Existing `() => void` callers keep compiling.

Test: test/infra/heavy-lock.test.ts — "slots go in arrival order" — one slot held, waiters B then C → B runs before C on release.
Test: test/infra/heavy-lock.test.ts — "a busy run cannot keep the role lock from an earlier waiter" — owner run:a holds, run:b waits, a second run:a holder arrives later → run:b enters before it.
Test: test/infra/heavy-lock.test.ts — "a role wait past roleWaitMs enters anyway" — `roleWaitMs: 50` → fn runs while the other owner still holds.
Test: test/infra/heavy-lock.test.ts — "onWait names the holder and the queue ahead" — `ahead` 1, `holder` the owner.
Test: test/infra/heavy-lock.test.ts — "low disk holds a slot within the load deadline" — `freeMb` stub under the reserve, then above → onWait called, fn runs once.

### Task 6: Milestone check env, timing, item budget, wait info

Files: src/services/milestone-check.ts, test/services/milestone-check-run.test.ts, test/services/milestone-check.test.ts

```ts
CheckRecordSchema += { startedAt: z.string().optional(), waitedMs: z.number().optional(), carriedFrom: z.string().optional() };
export const checkLimits = { waitMs: 600_000, pollMs: 1_000, graceMs: 30_000, itemMs: 1_800_000 };
export async function runMilestoneCheck(i, o?: { onWait?: (w: LockWait | null) => void }): Promise<GateRunResult>;
```

`runLogged` spawns with `{ ...env, [LOCK_HELD_ENV]: "1" }`, kills its group (`killGroup`) after `checkLimits.itemMs`, and then appends `catherd: timed out after <n> min` to the log and records exit 124. `startedAt` and the duration start inside `guarded`, after the locks; `waitedMs` is the time before. The worker writes the latest `LockWait` into its flight file as `waiting`, and `runMilestoneCheck` passes it to `onWait` on each poll (null while not waiting). `carriedFrom` is written by Task 9.

Test: test/services/milestone-check-run.test.ts — "a nested catherd lock sees CATHERD_LOCK_HELD" — the item `printenv CATHERD_LOCK_HELD` logs 1.
Test: test/services/milestone-check-run.test.ts — "durationMs leaves out the lock wait" — the role lock is held by another owner until the test releases it, the item is `true` → `durationMs` < `waitedMs`, and `startedAt` is after the release.
Test: test/services/milestone-check-run.test.ts — "an item past itemMs is recorded timed out" — `itemMs: 200`, `sleep 5` → exit 124, a `timed out` fail line.

### M2 lanes

- M2.L1 — Task 5 — owns src/infra/heavy-lock.ts, test/infra/heavy-lock.test.ts — fast check: `bun test test/infra/heavy-lock.test.ts && bun run typecheck && bun run lint`
- M2.L2 — Task 6 — after M2.L1 — owns src/services/milestone-check.ts, test/services/milestone-check-run.test.ts, test/services/milestone-check.test.ts — fast check: `bun test test/services/milestone-check-run.test.ts test/services/milestone-check.test.ts && bun run typecheck && bun run lint`

## M3 — Codex usage per dispatch

A1 — a resumed Codex dispatch records only its own tokens.
A2 — the root gate is green (Check).
A3 — web/ is untouched.
A4 — each fix has a test that fails without the fix.
A7 — the diff adds no home-directory path and no private host name.

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 7: Codex deltas

Files: src/adapters/codex/events.ts, src/adapters/codex/index.ts, test/adapters/codex.test.ts

```ts
// foldCodexEvents: tokens = the LAST turn.completed usage (thread totals), not their sum
async function settle(o: Outcome, run: FinishedRun, prior: Spent): Promise<Outcome>; // registered as codex's `settle`
```

`settle` returns `o` unchanged when `run.request.thread === null`. Otherwise it returns `tokens` = `o.tokens` minus `prior.tokens`, each part clamped at 0, the way opencode's `minus` does.

Test: test/adapters/codex.test.ts — "a fresh thread records its last usage" — two `turn.completed` with 100 then 250 input → 250.
Test: test/adapters/codex.test.ts — "a resumed dispatch records the delta" — usage 5 568 331 input, prior 4 430 000 → 1 138 331; cached and output likewise.

### M3 lanes

- M3.L1 — Task 7 — owns src/adapters/codex/events.ts, src/adapters/codex/index.ts, test/adapters/codex.test.ts — fast check: `bun test test/adapters/codex.test.ts && bun run typecheck && bun run lint`

## M4 — The daemon runs the Check

After: M1, M2

A1 — the daemon integrates the base, runs the milestone Check, routes red to a fix round without an LLM, and dispatches the verifier only for uncovered A-lines; no re-verification after accept, land refusal or a merge that misses the milestone's paths; plan `Baseline:` waivers; A-line disputes go to the judge once; `check.ran` and `milestone.checked` carry start time and duration.
A2 — the root gate is green (Check).
A3 — web/ is untouched.
A4 — each fix has a test that fails without the fix.
A5 — no panel API change (web/openapi.json unchanged).
A7 — the diff adds no home-directory path and no private host name.

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 8: The verifying flow in the reducer and machine

Files: src/domain/run-events.ts, src/domain/run-state.ts, src/domain/run-machine.ts, test/domain/run-events.test.ts, test/domain/run-state.test.ts, test/domain/run-machine.test.ts

```ts
// run-events.ts: "machineCheck" in ACTION_TYPES; events milestone.checked, lock.waiting (Contracts);
// check.ran += startedAt?, durationMs?, waitedMs?; tree.deferred += resource?: "memory" | "disk"
// run-machine.ts: { type: "machineCheck"; milestone; commit } — actionKey machineCheck:<m>, unitOf m,
//   confirmed by milestone.checked and base.behind; in PAUSED_STEPS
// run-state.ts: MilestoneState += checkedOn, verifierPassedOn, uncovered, checkOnly, disputes, disputing (mergePlan defaults)
```

`milestoneActions` "verifying": when `checkedOn !== commit` it owes `machineCheck`; when `commit === verifierFailedOn` it parks, as today; otherwise it owes the verifier. `milestone.checked` with `head !== m.commit`, or outside "verifying", changes nothing. When it has findings: `checkedOn = null`, `m.open = findings`, `completeRound`. When it has missing lines but no findings: `stuck` reason "land", with the missing lines verbatim and "answer accept to land with these pre-existing failures, or name the fix". When green: `checkedOn = head`, and `uncovered` and `checkOnly` are stored; it lands when `verifierPassedOn === head || verdictCarried || checkOnly`, else stays verifying. A verifier PASS sets `verifierPassedOn = m.commit`. `onAnswered`, on a blocker with `isAccept`: if `verifierFailedOn === m.commit` (read before line 964 clears it), it sets `verifierPassedOn = m.commit`. Then known issues and `verifying`, with landing when `checkedOn === commit`. `land.refused` (first): `checkedOn = null`, status verifying, `verifierPassedOn` kept. `mergedIn` keeps `verifierPassedOn`. `completeRound`, when it stops on BLOCKERs that `ownerOfFile` gives no lane and `disputes === 0`: `disputes += 1`, `disputing = true`, status "fixing", `open = found`, so the triage judge gets them. `onJudged` route while `disputing`: dismissed texts go to `knownIssues` as `dismissed by the judge: <text>`; with no route to a lane or the architect it sets `verifierPassedOn = commit` when `verifierFailedOn === commit`, then verifying; `disputing = false`. `lock.waiting` changes no state. `describeEvent` covers both new events, and `tree.deferred` with `resource: "disk"` reads "waits for disk" there and in its owed memory report.

Test: test/domain/run-state.test.ts — "a green check lands a check-only milestone" — commit.made, review clean, milestone.checked green with checkOnly → landing; no verifier is owed.
Test: test/domain/run-state.test.ts — "a red check is a fix round with no verifier" — findings with a file owned by L1 → L1 pending with the finding; no verifier dispatch is owed.
Test: test/domain/run-state.test.ts — "accept after a verifier FAIL lands without a new verifier" — FAIL on c1, blocker park, answer `accept: A8 is judged from the tree`, check green on c1 → landing.
Test: test/domain/run-state.test.ts — "accept after a review-cap blocker still verifies" — the blocker comes from review rounds → verifying, verifier owed.
Test: test/domain/run-state.test.ts — "a first land refusal reruns the check, not the verifier" — PASS on c1, land.refused → machineCheck owed; green again → landing.
Test: test/domain/run-state.test.ts — "a carried verdict lands the merge commit" — PASS on c1, integrate.done c2, milestone.checked c2 green with verdictCarried → landing.
Test: test/domain/run-state.test.ts — "unowned BLOCKERs at the cap go to the judge once" — stop with two file-less BLOCKERs → triage judge owed, no park; all dismissed → verifying, known issues hold both; the second time → blocker park.
Test: test/domain/run-machine.test.ts — "verifying owes machineCheck before the verifier" — checkedOn null → `machineCheck`; paused → none.
Test: test/domain/run-events.test.ts — "milestone.checked and lock.waiting parse and describe" — both validate and have a describeEvent line.

### Task 9: Gate records that carry, baselines, the land gate

Files: src/services/milestone-check.ts, src/services/plan-input.ts, src/services/lane-service.ts, test/services/milestone-check.test.ts, test/services/milestone-check-run.test.ts, test/services/plan-input.test.ts, test/services/land-gate.test.ts, test/services/workspace-land.test.ts

```ts
export async function freshFailures(run: Run, m: string, head: string): Promise<{ item: string; lines: string[] }[]>;
export async function missingBaselines(run: Run, m: string, head: string): Promise<string[]>;
export async function verdictCarries(run: Run, m: string, from: string, to: string): Promise<boolean>;
export function uncoveredALines(run: Run, m: string): string[]; // plan-input.ts
```

`runCheckItem`, when not forced and with no record on this head, looks for this run's latest exit-0 record of the item on another head. When `coveredDir(item)` is set and `git diff --name-only <old> <head>` has no path under it, it appends a copy with `head` and `carriedFrom: old` and answers it as cached. `acceptedLandQuestions` uses `isAccept`. `machineGate` adds an audit line instead of a missing one for a failing item in `baselineItems(plan.md, m)`, when the base record is red and has every failing line. `freshFailures` gives, per failing item on `head`, the lines its base record lacks (all lines with no base record). `missingBaselines` gives the failing items that have no base record. `verdictCarries` is true when `git diff --name-only from to` holds no file under the milestone's paths: its lane files' Owns, plus `changedOwned` and `violations` of its lanes' records. `uncoveredALines` takes the delivered ids (`deliveredALines`), each with its text from the plan.md section line that starts with it, else the run's A-line, and keeps those not matching `CHECK_COVERED`. In `gate()`, for a daemon run (`isDaemonRun`), the replayed milestone state settles the verdict in place of the `verdict?.passed` requirement and the HEAD checks at 436–453: it passes when `verifierPassedOn` equals the landed commit, or `verdictCarries(verifierPassedOn, landed)`, or `checkOnly && checkedOn === landed`; a BLOCKED latest verdict still refuses. Runs without events keep today's checks. The gates.jsonl loop accepts `item.passed` (the content-hash carry) and no longer asks for a commit prefix.

Test: test/services/milestone-check-run.test.ts — "a folder item carries across a commit outside it" — a pass of `(cd web && true)` on c1, c2 changes only src/ → cached record on c2 with carriedFrom c1; a c3 that changes web/ → runs.
Test: test/services/milestone-check.test.ts — "a plan Baseline line waives pre-existing lines" — plan.md M1 `Baseline: bun test`, base and head both red with the same lines → missing empty, audit names it; one new line → missing.
Test: test/services/milestone-check.test.ts — "accept with text waives a land park" — answer `accept, known red base` → waived.
Test: test/services/milestone-check.test.ts — "verdictCarries ignores files outside the milestone" — the diff touches only a sibling milestone's file → true; one owned file → false.
Test: test/services/plan-input.test.ts — "uncoveredALines drops lines marked (Check)" — `A1 — x`, `A2 — the root gate is green (Check).` → only A1.
Test: test/services/land-gate.test.ts — "a check-only milestone lands with no verifier record" — replayed checkOnly, checkedOn = landed, green machine records → lands.
Test: test/services/land-gate.test.ts — "a gate item passed on unchanged content carries to a new head" — pass on c1, c2 leaves its paths unchanged → lands.
Test: test/services/land-gate.test.ts — "an owner accept stands for the verifier's PASS" — FAIL on c1, then accept → lands c1.

### Task 10: The machineCheck effect and the check events

Files: src/services/run-effects.ts, src/services/milestone-tree.ts, test/services/run-effects.test.ts, test/services/daemon.test.ts, test/services/milestone-tree.test.ts

```ts
export const milestoneChecker = { run: runMilestoneCheck }; // the seam a test replaces
export async function baseTree(deps: Deps, run: Run, m: string): Promise<{ dir: string; remove: () => Promise<void> }>; // milestone-tree.ts
```

`machineCheck(a, s)`, in a base run, fetches the base first and appends `base.behind` when `origin/<base>` is not an ancestor of `a.commit`. With no Check line it appends `milestone.checked` with `command: null` and every delivered line in `uncovered`. Otherwise it calls `milestoneChecker.run` until it answers not running. Each failing item from `missingBaselines` is run once on `baseTree` (a detached worktree of `checkBase(run, m)` under the run's scratch, set up by `setUp`) with `at`, and the tree is removed after. A first `onWait` with a `LockWait` appends one `lock.waiting`. Then it appends `milestone.checked`: `missing` from `machineGate`; one BLOCKER finding per fresh line (`` `<item>` fails: <line> ``, `file: fileOf(line)`, at most 20 per item); `uncovered` and `checkOnly` (`command !== null`, at least one delivered line, none uncovered); `verdictCarried` from `verdictCarries(verifierPassedOn, commit)` when that is set and differs; and the start, the duration and the summed wait. `fastCheck` adds `[LOCK_HELD_ENV]: "1"`, `startedAt`, `durationMs` (the `runCheck` only) and `waitedMs` to `check.ran`, and one `lock.waiting` per wait. `commit` also forgives `The following paths are ignored`. `claim` appends `tree.deferred` with `resource: "disk"` when another milestone is working and `heavyLimits.freeMb() < heavyLimits.diskReserveMb`.

Test: test/services/run-effects.test.ts — "a base that moved is merged before the check" — origin ahead → `base.behind`, and the checker is not called.
Test: test/services/run-effects.test.ts — "a red check gives findings from its fresh lines" — stub records a failing item with one line the base lacks → milestone.checked with that BLOCKER and its file.
Test: test/services/run-effects.test.ts — "a failing item with no baseline gets one from the base" — the checker is called with `at` once, and the worktree is gone after.
Test: test/services/run-effects.test.ts — "check.ran carries its start, duration and wait" — fields present, durationMs ≤ the event spacing.
Test: test/services/run-effects.test.ts — "an ignored Owns path does not fail the commit" — `.gitignore` holds an owned path → `commit.made`.
Test: test/services/run-effects.test.ts — "low disk defers a second milestone" — freeMb stub under the reserve, one milestone working → `tree.deferred` resource disk.
Test: test/services/daemon.test.ts — "a check-only milestone lands with no verifier dispatch" — fake checker green, all A-lines `(Check)` → milestone.landed, no `verifier-M1` dispatch.

### Task 11: The verifier's brief and the gate rules

Files: src/services/run-briefs.ts, src/domain/gate-brief.ts, src/domain/role-prompts.ts, src/services/verifier-brief.ts, test/services/run-briefs.test.ts, test/domain/verifier-prompt.test.ts, test/services/verifier-brief.test.ts, test/domain/agents.test.ts

When `m.checkedOn === m.commit`, `verifyBrief` says: `catherd ran this milestone's Check (<command>) on <commit12> and it passed: do not run it again. Judge only these acceptance lines, which the Check does not show:` and then `m.uncovered`. It drops the line "Run the milestone's full check…". With no Check it keeps today's text. `VERIFIER_GATE_RULES` lose "Stay in the foreground…", and rule 2 says gate_run is only for a milestone with no Check line. `gateNotes` no longer lists the rules, only the run's facts. The verifier body, step 1, says the Check is catherd's: the verifier runs only what its acceptance lines need, each heavy command in `catherd lock --role verifier --`. The architect body (lines 35, 42) says to end an A-line the milestone's Check proves on its own with `(Check)`.

Test: test/services/run-briefs.test.ts — "a checked milestone's verifier brief lists only uncovered lines" — checkedOn = commit, uncovered [A1] → names A1 and "do not run it again", not the A2 text.
Test: test/services/verifier-brief.test.ts — "the gate rules appear once" — a composed verifier brief holds the first rule's text once.
Test: test/domain/verifier-prompt.test.ts — "the verifier is not told to stay in the foreground" — no "Stay in the foreground".

### M4 lanes

- M4.L1 — Task 8 — owns src/domain/run-events.ts, src/domain/run-state.ts, src/domain/run-machine.ts, test/domain/run-events.test.ts, test/domain/run-state.test.ts, test/domain/run-machine.test.ts — fast check: `bun test test/domain/run-events.test.ts test/domain/run-state.test.ts test/domain/run-machine.test.ts && bun run typecheck && bun run lint`
- M4.L2 — Task 9 — after M4.L1 — owns src/services/milestone-check.ts, src/services/plan-input.ts, src/services/lane-service.ts, test/services/milestone-check.test.ts, test/services/milestone-check-run.test.ts, test/services/plan-input.test.ts, test/services/land-gate.test.ts, test/services/workspace-land.test.ts — fast check: `bun test test/services/milestone-check.test.ts test/services/milestone-check-run.test.ts test/services/plan-input.test.ts test/services/land-gate.test.ts test/services/workspace-land.test.ts && bun run typecheck && bun run lint`
- M4.L3 — Task 10 — after M4.L1, M4.L2 — owns src/services/run-effects.ts, src/services/milestone-tree.ts, test/services/run-effects.test.ts, test/services/daemon.test.ts, test/services/milestone-tree.test.ts — fast check: `bun test test/services/run-effects.test.ts test/services/daemon.test.ts test/services/milestone-tree.test.ts && bun run typecheck && bun run lint`
- M4.L4 — Task 11 — after M4.L1 — owns src/services/run-briefs.ts, src/domain/gate-brief.ts, src/domain/role-prompts.ts, src/services/verifier-brief.ts, test/services/run-briefs.test.ts, test/domain/verifier-prompt.test.ts, test/services/verifier-brief.test.ts, test/domain/agents.test.ts — fast check: `bun test test/services/run-briefs.test.ts test/domain/verifier-prompt.test.ts test/services/verifier-brief.test.ts test/domain/agents.test.ts && bun run typecheck && bun run lint`

## M5 — Lanes and findings routing

After: M1, M4

A1 — a multi-file finding reaches every owning lane; a judge route to a running lane is kept; admission and the reducer agree on a finished lane; order and overlap refusals wait; transitive dependents never hold a lane; a sibling's half-written file is a cross-lane wait.
A2 — the root gate is green (Check).
A3 — web/ is untouched.
A4 — each fix has a test that fails without the fix.
A5 — no panel API change (web/openapi.json unchanged).
A7 — the diff adds no home-directory path and no private host name.

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 12: Routing, waits and sibling blame in the reducer

Files: src/domain/run-events.ts, src/domain/run-state.ts, src/domain/run-machine.ts, test/domain/run-state.test.ts, test/domain/run-machine.test.ts

```ts
// run-events.ts: check.ran += siblings?: string[]; dispatch.ended += siblings?: string[]
// run-state.ts: LaneState += queued: string[], waitOn: string[] (mergePlan defaults); export const ADMIT_WAITS = 12;
```

`fixRound` sends a finding to every lane that owns one of `filesOf(f.text)` (else `f.file`); it is unowned only when none does. `onJudged` route, for a target that is "running" or "checking": `queued.push(text)`, with no status change. `laneDone`, when `queued` is not empty, sets `notes = queued`, `queued = []`, status "pending", `attempts = 0`, and does not settle. `dispatch.refused` `E_ADMIT_ORDER` and `E_ADMIT_OVERLAP` wait `REFUSAL_WAIT_MS` under the key `admit:<name>@<unit>`, and park as `effect` at `ADMIT_WAITS`; `dispatch.started` clears the key. On `check.ran` failing, or a `check_broken` stop, the `siblings` that are not done become `waitOn`: status "checking", no `checkFails` or `stopRun` added. `laneActions` skips the fast check of a "checking" lane while any `waitOn` lane is not done; `laneDone` clears `waitOn`. `waitsForSibling` excludes every lane whose `after` reaches `l.id` transitively.

Test: test/domain/run-state.test.ts — "a finding naming two lanes' files goes to both" — L1 and L2 each get the note.
Test: test/domain/run-state.test.ts — "a route to a running lane is kept for its next round" — worker started, judge routes, worker ends ok, check passes → the lane is pending with the routed note, not done.
Test: test/domain/run-state.test.ts — "an order refusal waits, and parks only at the limit" — 11 refusals → no park; the 12th → park effect.
Test: test/domain/run-state.test.ts — "a failure in a running sibling's file waits for it" — L1's check fails, siblings [M1.L2] running → L1 checking, waitOn [M1.L2]; L2 done → fastCheck owed for L1.
Test: test/domain/run-machine.test.ts — "a transitive dependent never holds a check_broken lane" — L2 After L1, L3 After L2, L1 check_broken → L1 is dispatched again.

### Task 13: Sibling blame in the effects

Files: src/domain/blocked.ts, src/services/run-effects.ts, test/domain/blocked.test.ts, test/services/run-effects.test.ts

```ts
export function siblingLanesNamed(log: string, siblings: { id: string; owns: string[] }[]): string[]; // blocked.ts
```

It gives the ids of the sibling lanes whose Owns entries the failing output names, by the tail rule `foreignFailure` uses, whether or not the lane's own files are named too. `fastCheck` and `endedEvent` (for `check_broken`) put it on `siblings`, from the milestone's lane files (`laneOwnsOf` widened to give ids).

Test: test/domain/blocked.test.ts — "a sibling named beside an own file is still named" — output names `src/a.ts` (own) and `src/b.ts` (L2's) → [M1.L2].
Test: test/services/run-effects.test.ts — "check.ran names the blamed sibling lanes" — `siblings` holds the lane id.

### Task 14: Admission reads the reducer

Files: src/services/protocol.ts, src/services/admission.ts, test/services/protocol.test.ts, test/services/admission.test.ts

`unfinishedAfter`, for a daemon run (`isDaemonRun`), names an `After:` lane as unfinished when `replayRun(run).lanes[a]?.status !== "done"` and its milestone has not landed; other runs keep the records rule. The overlap loop compares only pending dispatches with `d.admit.repo === cwd`.

Test: test/services/protocol.test.ts — "a lane the reducer marked done is finished for admission" — L1 ended blocked check_broken with foreign files (done in state) → `unfinishedAfter(run, "M1.L4")` is [].
Test: test/services/admission.test.ts — "lanes in different worktrees never overlap" — same Owns, two trees → admitted.

### M5 lanes

- M5.L1 — Task 12 — owns src/domain/run-events.ts, src/domain/run-state.ts, src/domain/run-machine.ts, test/domain/run-state.test.ts, test/domain/run-machine.test.ts — fast check: `bun test test/domain/run-state.test.ts test/domain/run-machine.test.ts && bun run typecheck && bun run lint`
- M5.L2 — Task 13 — after M5.L1 — owns src/domain/blocked.ts, src/services/run-effects.ts, test/domain/blocked.test.ts, test/services/run-effects.test.ts — fast check: `bun test test/domain/blocked.test.ts test/services/run-effects.test.ts && bun run typecheck && bun run lint`
- M5.L3 — Task 14 — owns src/services/protocol.ts, src/services/admission.ts, test/services/protocol.test.ts, test/services/admission.test.ts — fast check: `bun test test/services/protocol.test.ts test/services/admission.test.ts && bun run typecheck && bun run lint`

## M6 — Briefs and context

After: M4, M5

A1 — `<context>` holds only the milestone's plan files' preambles and cited sections, with no read-everything pointer; a resumed dispatch gets only its new task; verifier, ui-reviewer and judge see only their milestone's A-lines; the shared context comes first.
A2 — the root gate is green (Check).
A3 — web/ is untouched.
A4 — each fix has a test that fails without the fix.
A5 — no panel API change (web/openapi.json unchanged).
A7 — the diff adds no home-directory path and no private host name.

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 15: Context per milestone

Files: src/services/plan-input.ts, test/services/plan-input.test.ts

```ts
export function planContext(run: Run, role: Role, milestone?: string | null): string | null;
```

With a milestone: the files are the docs of `milestoneTasks(run, milestone)`, and each one's preamble goes in. A taskless file gives only its `## ` sections whose heading starts with `<n>.` or `§<n>` for a `§<n>` a task cites, or whose heading text a task quotes. Without a milestone (run-level roles): every preamble, as today. Over `PLAN_CONTEXT_MAX` the text is cut there, with `[… <n> characters of <file> cut: read it with read_run_file]`.

Test: test/services/plan-input.test.ts — "a milestone gets only its plan files' preambles" — two plan files, M2's tasks from b.md → b's preamble only.
Test: test/services/plan-input.test.ts — "a taskless file gives only the cited sections" — a task cites `contract §3` → `## 3. …` only.
Test: test/services/plan-input.test.ts — "no read-everything pointer past the cap" — 120 000 characters → cut text with one cut note naming its file.

### Task 16: A resumed brief and the section order

Files: src/domain/brief.ts, src/domain/role-prompts.ts, test/domain/brief.test.ts, test/domain/judge.test.ts, test/adapters/access.test.ts

```ts
export const SECTIONS = ["context", "role", "team", "task", "done_when", "reply_contract"] as const;
export function roleSections(role, version, o?: { context?: string | null; task?: string; only?: readonly (typeof SECTIONS)[number][] }): string;
// BriefContext += { resumed: boolean }; composeBrief: resumed → only task and reply_contract
```

Test: test/domain/brief.test.ts — "a resumed brief carries only the task and the reply contract" — no `<role>`, `<team>`, `<context>`, `<done_when>`.
Test: test/domain/brief.test.ts — "the context comes first" — `<context>` precedes `<role>`.

### Task 17: Task text for resumed dispatches and per-milestone A-lines

Files: src/services/run-briefs.ts, test/services/run-briefs.test.ts

A fix brief whose action has a `thread` (resumed) is the fix lines, the failing check tail and the fast checks; it leaves out the A-lines, the Owns line and the plan tasks. A resumed recheck is the open lines and the rejections, with no `reviewPlan`. A resumed ui-reviewer gets `Re-check the screens commit <c12> changed, in the same format.` The verifier, ui-reviewer and judge briefs print the A-lines delivered by the unit's milestone (`deliveredALines`), plus the lines with no id, instead of `ALINES(run)`.

Test: test/services/run-briefs.test.ts — "a resumed fix brief has no plan tasks or A-lines" — thread set → no `<plan-task`, no "The A-lines".
Test: test/services/run-briefs.test.ts — "a judge sees only its milestone's A-lines" — A1 in M1, A2 in M2, a judge on M2 → A2 only.

### Task 18: Admission passes the milestone and the resume

Files: src/services/admission.ts, test/services/admission.test.ts, test/services/dispatch-thread.test.ts

`composeBrief` gets `resumed: i.thread !== null`, and `planContext(run, i.role, milestone)` gets the lane's milestone, or `milestoneOfName(i.name)` for a lane-less role.

Test: test/services/admission.test.ts — "a resumed dispatch's brief.md has no role section" — thread given → brief.md starts with `<task>`.
Test: test/services/admission.test.ts — "a lane's context comes from its own milestone" — two plan files → only its file's preamble in brief.md.

### M6 lanes

- M6.L1 — Task 15 — owns src/services/plan-input.ts, test/services/plan-input.test.ts — fast check: `bun test test/services/plan-input.test.ts && bun run typecheck && bun run lint`
- M6.L2 — Task 16 — owns src/domain/brief.ts, src/domain/role-prompts.ts, test/domain/brief.test.ts, test/domain/judge.test.ts, test/adapters/access.test.ts — fast check: `bun test test/domain/brief.test.ts test/domain/judge.test.ts test/adapters/access.test.ts && bun run typecheck && bun run lint`
- M6.L3 — Task 17 — owns src/services/run-briefs.ts, test/services/run-briefs.test.ts — fast check: `bun test test/services/run-briefs.test.ts && bun run typecheck && bun run lint`
- M6.L4 — Task 18 — after M6.L1, M6.L2 — owns src/services/admission.ts, test/services/admission.test.ts, test/services/dispatch-thread.test.ts — fast check: `bun test test/services/admission.test.ts test/services/dispatch-thread.test.ts && bun run typecheck && bun run lint`

## M7 — ideas.md and the changeset

After: M1, M2, M3, M4, M5, M6

A1 — docs/dev/ideas.md drops what plan 40 fixed and lists what it left, each with its evidence.
A2 — the root gate is green (Check).
A7 — the diff adds no home-directory path and no private host name.
A8 — a catherd-cli patch changeset names the user-visible changes: the `(Check)` and `Baseline:` plan lines, dotted task ids, the daemon-run Check.

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 19: ideas.md and changeset

Files: docs/dev/ideas.md, .changeset/plan-40-run-efficiency.md

ideas.md drops: "Admission and the reducer disagree…", "A lane's repo-wide typecheck sees a sibling's half-done edits", "The report's known issues can be a verifier reply cut into lines", "The architect writes a fast check over a path the formatter ignores", and from the run-audit bullet findings 11, 13, 14 (the verifier queue part) and 23 (Codex cumulative usage). It adds each Out-of-scope item below that is not plan 41 or 42, and every new catherd defect the M1–M6 lanes and reviews reported (the orchestrator lists them in this lane's brief), each with its evidence and no run path.

Test: none (prose) — the fast check asserts the changeset names catherd-cli.

### M7 lanes

- M7.L1 — Task 19 — after M1, M2, M3, M4, M5, M6 — owns docs/dev/ideas.md, .changeset/plan-40-run-efficiency.md — fast check: `grep -q catherd-cli .changeset/plan-40-run-efficiency.md && bun run format:check`

## Edge cases

- A plan with no `Check:` for a milestone: `milestone.checked` with `command: null`, and the verifier does the whole gate as today.
- A milestone that delivers no A-line: never check-only; its verifier runs.
- `milestone.checked` for an older head (a fix commit landed meanwhile) changes nothing; the next tick owes a new check.
- A daemon restart during a machine check: the flight file is live, and `runMilestoneCheck` waits for that same worker.
- A baseline worktree that cannot be set up: the item stays without a base record, its lines count as fresh, and the effect logs why.
- A carried machine record keeps the old record's exit and lines; `carriedFrom` says where it came from.
- An owner answer `accepted` or `acceptance criteria…` is not an accept (the first word must be `accept`).
- A dispute judge that routes a finding to a lane: one more fix round; the next stop parks as today (`disputes` is 1).
- A lock holder that dies: its ticket and slot are dropped on the next look, as slots are today.
- A role-lock waiter past `roleWaitMs`: it runs beside the holder, and its `LockWait` says so.
- Codex records written before the fix on the same thread: `prior` over-counts, and the delta clamps at 0.
- Old events without the new optional fields replay unchanged; old `MilestoneState` and `LaneState` get defaults in `mergePlan`.
- A queued route to a lane that a judge `skip` then closes: the queued notes are dropped with the lane.
- `cd` inside a subshell is already one item; only a bare top-level `cd <dir>` item joins the rest.
- A resumed dispatch whose thread the adapter refuses (`E_ADMIT_THREAD`): no brief is written, as today; the failover dispatch has no thread and gets the full brief.

## Out of scope

- The cheap-model routing tier and the opencode fixes (plan 41). All panel and web/ work, including showing `check.ran` timing, `milestone.checked` and `lock.waiting` (plan 42). The DeepSeek harness experiment.
- Left for ideas.md (M7): the ui-reviewer dispatched with no way to log in, or on screens that are stubs; a missing `STATUS:` line read as clean; a retry when idle for load-induced timeouts; `git submodule update` after `integrate`; a judge refused `E_ADMIT_PAUSED` that never comes back; a squash merge that does not advance the base for dependants; one push and merge answer per milestone; a per-run `pause --run` scope; milestones started by remaining critical path; tearing down compose stacks a gate started; an owner ruling that never reaches later lane briefs; the daemon alerting or restarting after ENOSPC; `status` printing one collected line per dispatch; a merge that deletes the run's base branch; skipping the daemon's fast-check rerun when the worker's passing run is recorded.
- Changing the reviewer's contract, the softCap, or the per-milestone serial pipeline (review, then the check, then the verifier).
