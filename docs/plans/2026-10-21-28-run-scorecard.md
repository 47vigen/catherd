# catherd 2.0, plan 28: the run scorecard and the 1.5 baseline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `catherd scorecard prepare|record|compare` measures a catherd version on four fixed tasks (a raqam task, a catherd milestone, a replayed Sanitell task, an injected-failure task): per task, whether it finished with no intervention, the interventions, review rounds, wall-clock time, quota used and whether its result passed on the first try; and it compares a version against the stored 1.5.0 baseline by the spec's pass bar. The last task hands the owner the baseline's commands and stops.

**Architecture:** Types, the task-file schema and the pass bar are pure, in `src/domain/scorecard.ts`. What a run's files say is read by `src/services/scorecard-metrics.ts`, on four small readers exported where their data lives (`reviewRounds` in `milestones.ts`, `runMilestones` in `protocol.ts`, `questionCounts` in `questions.ts`, `quotaByBackend` in `summary.ts`) and on `outcomes.jsonl` through `readOutcomes`/`latestOutcomes`. `src/services/scorecard.ts` prepares a task's reproducible starting point (a clone at a pinned commit, on a throwaway branch, with no remote), scores a finished run (running the task's acceptance through preflight's `runCheck`) and stores rows. `src/entry/scorecard-command.ts` is a contributor command like `capture-fixtures`: fixtures, limit shims and results live in the checkout's `scorecard/` folder, which the npm package does not ship. The fake quota limit is a PATH shim (`scorecard/shim/codex`, `scorecard/shim/claude`) that turns one headless call into the limit stream of catherd's own adapter fixtures; no provider account is touched.

**Tech Stack:** Bun ≥ 1.4, TypeScript, zod 4, citty, POSIX `sh` for the shims. No new dependency.

**Spec:** `docs/specs/2026-10-12-catherd-2.0-design.md`, "Measurement" (Plans table row 28) and "Release" (the scorecard gates `latest`).

**Pre-validation:** spiked the limit shim (a token taken by `mv`, one limited `codex exec`, then pass-through with PATH intact and the exit code kept; a `set -f` around the token loop broke the glob, so it wraps only the PATH split) and fed its output to `codexAdapter.finalize` (status `limit`); ran `test/adapters/codex.contract.test.ts` and `test/adapters/claude-code.contract.test.ts` (28 pass); checked the digest's `· landed <iso>` line, `sessions.jsonl` and the record fields on the real payment-3 run; targeted tests only; the full gate runs at execution.

## Global Constraints

- Layers `domain → infra → adapters → services → entry` (`test/architecture.test.ts`): `scorecard.ts` (domain), `scorecard-metrics.ts` and `scorecard.ts` (services), `scorecard-command.ts` (entry). Shims and fixtures are outside `src/`.
- The gate: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test` (`FORCE_COLOR` unset). Tests that could reach the network delete `ANTHROPIC_API_KEY` (in-process) or pass `ANTHROPIC_API_KEY: ""` (spawned); spawned processes get an explicit `env`. No wall-clock sleep for correctness. No test clones from the network: every `prepare` test uses a local `tempRepo()` as its source.
- Commits: conventional, subject ≤ 100 characters, lower-case first word after the scope (`feat(scorecard): …`); check `git log` after each commit.
- Binding values from the spec, verbatim:
  - "**Four fixed tasks:** a small raqam task, a catherd milestone, a past Sanitell task replayed at its original commit on a throwaway branch, and an injected-failure task (a fake quota limit plus a broken test)."
  - "**Recorded per task:** whether it finished with no intervention, the number of interventions, review rounds, wall-clock time, quota used, and whether the MR passed on the first try. Built on `outcomes.jsonl` and `summary.ts`."
  - "**Pass bar:** all four tasks finish with zero interventions; the injected-failure task recovers by itself; and wall-clock time is no worse than 1.5. Quota is reported, not gated."
  - "**Baseline:** taken on 1.5.0 before any 2.0 change, then after each plan."
  - "The run scorecard is the gate for 2.0. It is not the catalog benchmarks, which are deleted."
  - "2.0.0 ships on the `beta` dist-tag and runs the scorecard there. It becomes `latest` once the scorecard passes."
- Owner rules: the fake limit goes through a test seam or env var, never a real provider account; the baseline spends the owner's subscriptions for hours and is never run automatically (Task 8 prints the commands and stops); interventions are countable from records.
- A fixture clone never has a remote, so nothing a scorecard run does can be pushed.
- Changeset: `catherd-cli`, part of 2.0.0, major (plans 28–35).

## Review Focus

1. **The operator gives up on a run that never lands** (stalled, or the 4-hour cap). Expected: scored unfinished, wall-clock to its last activity, no first try, no throw. Task 4: "scores a run that never landed as unfinished, its wall-clock to its last record".
2. **The prepared repo holds two runs** (the operator restarted, or one superseded the other). Expected: `record` refuses with both ids unless `--run` names one; a superseded predecessor counts as an intervention. Task 4: "refuses a folder with two runs unless run names one, and counts the run it superseded".
3. **A fixture drifted** (inject text gone or doubled, the commit not in the source). Expected: `prepare` refuses before `prepared.json` exists, naming the file or commit. Task 4: "applies each inject edit once and commits it; refuses an edit whose text is not there exactly once" and "refuses a task with no source when none is given, and a commit the source lacks".
4. **The shim never fired** (the profile's workers are native subagents). Expected: the injected task is not recovered, and `compare` says why. Task 1: "fails an injected task that never hit a limit, or whose stand-in did not end ok"; Task 4: "reports the injected limits the shim took and whether a stand-in ended ok".
5. **An acceptance file would land on a file the run wrote, or the check fails.** Expected: never overwrite the run's file; remove every copied file whatever the check did. Task 4: "copies the accept files in for acceptance and removes them after, even when the check fails; refuses one whose path the run already has".

## Rulings

`Ruling: <what> — <why> — <cost if wrong>`:

1. Ruling: the scorecard is a contributor command, `catherd scorecard prepare|record|compare`, reading the checkout's `scorecard/` through `assetPath` (as `capture-fixtures` reads `test/fixtures`); `scorecard/` is not in `package.json` `files` — fixtures name private commits and shims are test seams; only a maintainer measures — an installed package cannot score, and says to run it from a checkout.
2. Ruling: the baseline runs on the installed catherd 1.5.0 (CLI and plugin) and is scored from the checkout; each row stores its run's `meta.catherdVersion` — "before any 2.0 change" is about the code that runs the task; the scorer only reads files — none: a row from the wrong version shows it.
3. Ruling: "the MR passed on the first try", for a fixture with no remote, is: every milestone landed exactly once and the task's acceptance passes on the run's final tree, with the fixture's hidden `accept/` tests copied in — a throwaway clone opens no MR; hidden tests fail a run that wrote none — a CI-only failure (an image build) goes unseen.
4. Ruling: an intervention is a park (each `question` row of `questions.jsonl`), a takeover (each change of owner session after the first, from `meta.startedBy` and `sessions.jsonl`), a manual dispatch (only in a daemon run, one with `events.jsonl`: each record carrying a `sessionId`), a pause begun during the run (`pauseSpans`), a run this one superseded, or a chat message the operator typed after the start prompt (`record --chat <n>`). Answers are shown, not added (each closes a counted park); a daemon revival is not counted — in 1.5 another session's dispatch first claims the run (`claimRun`), so it is a takeover; any catherd call revives a 2.0 daemon — a chat nudge the operator forgets to report is missed.
5. Ruling: wall-clock runs from `meta.createdAt` to the last landing (the last landed milestone's digest line `· landed <iso>`), else to the last record or native agent row; parked and paused minutes are shown beside it, not subtracted — a zero-intervention run has none, and subtracting hides a stop's cost — none.
6. Ruling: "no worse than 1.5" compares the four tasks' summed wall-clock with the baseline's sum, 10 % tolerance (`WALL_TOLERANCE`); per-task deltas are shown, not gated — one run per task cannot tell 5 % from noise; a sum is steadier — a regression under 10 % passes.
7. Ruling: review rounds are a milestone's full reviewer passes (`reviewer-<M>` record or native row, ended ok, not `STATUS: partial`) since its lanes started, summed over milestones (`reviewerAttempts`) — a partial pass is completed by the next full one — none.
8. Ruling: quota used is tokens per backend (input, cached, output, runs, limit records) from `runs.jsonl` plus native Claude subagents' reported tokens; money is not shown — the owner runs on subscriptions — a metered backend's dollars are missing.
9. Ruling: the fake limit is a PATH shim plus token files: `prepare` lays out `limits/tokens/<n>`; `scorecard/shim/codex` (on `exec`) or `scorecard/shim/claude` (on `-p`/`--print`) takes a token by `mv` and prints catherd's `test/fixtures/adapters/<backend>/limit.jsonl` with exit 1; without a token it runs the next binary of that name on PATH and leaves PATH intact, so the conductor, the MCP server and the workers keep the shim — no provider is called while a limit is injected, and the contract tests already classify that stream as `limit` — a profile whose headless calls are neither codex nor claude-code is never limited (Review Focus 4).
10. Ruling: the injected task's "broken test" is a stale test: the fixture commits a test pinning that Lao digits stay as typed, and the plan's change (Lao built in) breaks it, so the gate fails until a fix round corrects it; not a failure already in the base — spec decision 18 lets base failures through in 2.0, so a base failure would measure a deliberate rule, not recovery — if the owner meant a base failure, only the `inject` edit changes.
11. Ruling: the fixtures are raqam's Myanmar locale plugin at raqam `6795167` (main); a two-lane catherd milestone from two 1.5 follow-ups in `docs/dev/ideas.md` ("BLOCKER: none" counts as an open blocker; `Allow:` misses a hit printed as `./path`) at `2061e6e` (1.5.0); Sanitell payment plan 3 (run `20260929-124103-payment-plan-3-kit-auth-apps`, catherd 1.2.1, 2 lanes, 50 min, landed `249e6a2f`) replayed at `0296d87585d6288998f7b845a501ebdf2a5c1cad`, the parent of its first commit `e0f006bf`, whose tree holds the plan; and Lao digits at raqam `6795167` for the injected task — small, real, each gate runs on the owner's machine — none: a later fix on main does not touch a fixture's commit.
12. Ruling: the Sanitell task stores no source (`source: null`); its `prepare` needs `--source` — catherd is public and the platform's host is private — the operator types one path.
13. Ruling: a prepared task is `<data dir>/scorecard/<task>-<YYYYMMDD-HHMMSS>/` (`--dir` moves the root): `repo/` (on branch `scorecard/<task>`, origin removed), `plan.md` (a fixture plan, beside the repo so a run cannot commit it), `limits/` (injected task) and `prepared.json`, written last — a run's repo must be its own toplevel; a half-prepared folder must not look ready — none.
14. Ruling: results are committed as `scorecard/results/<label>.json` (labels `1.5.0`, `plan-29` … `plan-35`, `2.0.0-beta.<n>`, matching `^[a-z0-9][a-z0-9.-]{0,40}$`), one row per task, a re-record replacing that row; `--results <dir>` moves them — plan 36 reads the baseline, so it travels with the repo — none.
15. Ruling: the four tasks run one at a time, each in a fresh Claude Code session from the printed start line, the owner's default profile unchanged between measurements, 4 hours at most per task (`docs/dev/scorecard.md`) — parallel tasks share quota and machine — a measurement takes up to 16 hours.
16. Ruling: acceptance runs as `runCheck(repo, acceptance, timeout, await checkEnvFor(repo))` (own process group, allowlisted login environment plus the repo's gate env) on the tree the run left, recording `HEAD` — catherd's existing way to run a repo's check without credentials — a check needing a variable outside the allowlist fails until `catherd knowledge env set` supplies it.
17. Ruling: the changeset is major, "part of 2.0.0"; the release PR it opens stays unmerged until plan 36 — 2.0.0 ships on `beta` only after plans 28–35 — none.

## Cross-plan interfaces

Plan 28 runs first, on today's code. What it reads from a run; later plans keep it or extend `src/services/scorecard-metrics.ts`:

- `runs.jsonl`: `backend`, `tokens`, `status` (`limit`), `failoverFrom` (set on a failover stand-in), `sessionId`, `endedAt`, `replyStatus`.
- `<run>/events.jsonl` exists exactly for a daemon run (spec decision 2); only its presence is read.
- `questions.jsonl` rows `{ at, milestone, kind: "question" | "answer", text }` per park and answer. Plan 30 keeps writing them for a milestone (its Ruling 16) but parks a lane only in `events.jsonl` and names `question.answered{ by: "owner" }` the intervention: plan 30 (or 36) extends `interventionsOf` so that in a daemon run the parks count is the `question.answered` events with `by: "owner"` (a judge's answer is no intervention), and adds `cancel.requested{ by: "owner" }` and `plan.approved{ by: "owner" }` to the total.
- A daemon dispatch is admitted without a `sessionId`, or `interventionsOf` counts it as manual.
- `ledger.md` (`landedMilestones`), `digests/<M>.md` with `· landed <iso>`, `lanes/M<n>.L<k>.md` (`runMilestones`), reviewer names `reviewer-<M>`, `sessions.jsonl`, `outcomes.jsonl` rows' `lane`, `landed`, `climbs`.
- `test/fixtures/adapters/codex/limit.jsonl` and `test/fixtures/adapters/claude-code/limit.jsonl` stay (the shims print them).
- The daemon inherits the MCP server's environment (`PATH`, `CATHERD_SCORECARD_LIMITS`), so the shim reaches its workers.

Produces for plans 29–36: `catherd scorecard prepare <task> [--source] [--dir] [--no-setup] [--json]`; `catherd scorecard record <dir> --label <l> [--run] [--chat] [--results] [--json]`; `catherd scorecard compare <label> [--baseline <l>] [--results] [--json]` (exit 0 pass, 1 fail; baseline default `1.5.0`); `scorecard/results/<label>.json` (`ScorecardFile`); `passBar`, `SCORECARD_TASKS`, `interventionsOf`. Plan 36 gates `latest` on `catherd scorecard compare 2.0.0-beta.<n>` exiting 0.

## Spec coverage

| Spec bullet ("Measurement") | Task |
| --- | --- |
| Four fixed tasks, each a task file and a reproducible start | 4 (prepare), 5 (fixtures) |
| Injected failure: a fake quota limit plus a broken test | 3 (shim), 4 (limits, inject), 5 (`injected-lao`) |
| Per task: finished with no intervention, interventions, rounds, wall-clock, quota, first try | 2, 4 |
| Built on `outcomes.jsonl` and `summary.ts` | 2 (`quotaByBackend`), 4 (`latestOutcomes`) |
| Pass bar; quota not gated | 1 (`passBar`), 6 (`compare`) |
| Baseline on 1.5.0, then after each plan | 6 (docs), 8 |
| Release: `latest` once the scorecard passes | Cross-plan interfaces (plan 36) |

## Parallelism

| Wave | Tasks | Files |
| --- | --- | --- |
| 1 | 1 ∥ 3 | 1: `src/domain/scorecard.ts`, `test/domain/scorecard.test.ts` (new) · 3: `scorecard/shim/codex`, `scorecard/shim/claude`, `test/scorecard-shim.test.ts` (new) |
| 2 | 2 | `src/services/{milestones,protocol,questions,summary}.ts`, `src/services/scorecard-metrics.ts`, `test/services/scorecard-metrics.test.ts` (new) |
| 3 | 4 | `src/services/scorecard.ts`, `test/services/scorecard.test.ts` (new) |
| 4 | 5 ∥ 6 | 5: `scorecard/tasks/**`, `scorecard/results/.gitkeep` (new), `.oxfmtrc.json`, `test/scorecard-fixtures.test.ts` (new) · 6: `src/entry/scorecard-command.ts`, `docs/dev/scorecard.md`, `test/entry/scorecard-command.test.ts` (new), `src/cli.ts`, `README.md`, `CONTRIBUTING.md` |
| 5 | 7 | `docs/dev/ideas.md`, `.changeset/run-scorecard.md` (new) |
| 6 | 8 | the owner's go; then `scorecard/results/1.5.0.json` |

Run the full gate once on the combined head after each wave.

## Tasks

### Task 1: types, task schema and pass bar

**Files:** Create `src/domain/scorecard.ts`; Test `test/domain/scorecard.test.ts`

**Interfaces:**
- Consumes: `CatherdError` (`src/domain/errors.ts`), zod.
- Produces:
  ```ts
  export const SCORECARD_TASKS = ["raqam-myanmar", "catherd-findings", "sanitell-payment-3", "injected-lao"] as const;
  export type ScorecardTaskId = (typeof SCORECARD_TASKS)[number];
  export const INJECTED_TASK: ScorecardTaskId = "injected-lao";
  export const WALL_TOLERANCE = 0.1;
  export const ScorecardTaskSchema; export type ScorecardTask = z.infer<typeof ScorecardTaskSchema>;
  export interface Interventions { parks: number; answers: number; takeovers: number; manualDispatches: number;
    pauses: number; superseded: number; chat: number; total: number }
  export interface QuotaRow { backend: string; runs: number; input: number; cached: number; output: number; limits: number }
  export interface TaskScore {
    task: ScorecardTaskId; run: string; catherdVersion: string; startCommit: string; head: string | null;
    milestones: string[]; landed: string[]; finished: boolean; interventions: Interventions; reviewRounds: number;
    lanes: { total: number; landed: number; climbs: number }; wallMinutes: number; pausedMinutes: number;
    quota: { backends: QuotaRow[]; claudeAgentTokens: number };
    acceptance: { passed: boolean; code: number | null; timedOut: boolean; tail: string[] };
    firstTry: boolean; injected: { limits: number; standInOk: boolean } | null; recordedAt: string;
  }
  export interface ScorecardFile { schema: 1; label: string; tasks: Partial<Record<ScorecardTaskId, TaskScore>> }
  export const ScorecardFileSchema; // z.looseObject({ schema: z.literal(1), label: z.string(), tasks: z.record(z.string(), z.unknown()) })
  export function assertLabel(label: string): string;
  export function interventionTotal(i: Omit<Interventions, "total">): number;
  export function recovered(s: TaskScore): boolean;
  export interface Verdict { pass: boolean; failures: string[]; wall: { now: number; baseline: number | null } }
  export function passBar(current: ScorecardFile, baseline: ScorecardFile | null): Verdict;
  ```

`ScorecardTaskSchema` is a `z.strictObject`; every field required unless a default is named: `schema: z.literal(1)`; `id: z.enum(SCORECARD_TASKS)`; `title`, `goal`: `z.string().min(1)`; `source: z.string().min(1).nullable()` (null: `--source` required); `commit: z.string().regex(/^[0-9a-f]{40}$/)`; `plan: z.union([z.strictObject({ file }), z.strictObject({ repoPath })])` (non-empty strings); `inject: z.strictObject({ message, edits: z.array(z.strictObject({ path, find, replace })).min(1) }).nullable()`, default `null`; `limits: z.number().int().min(0)`, default `0`; `setup: z.array(z.string().min(1))`, default `[]`; `acceptance: z.string().min(1)`; `acceptanceTimeoutMin: z.number().int().positive()`; `acceptFiles: z.array(z.strictObject({ from, to }))`, default `[]`; `prompt: z.string().includes("{plan}")`.

- [ ] **Step 1: Write the failing tests.** Helpers: `score(task, over?)` builds a finished, zero-intervention `TaskScore` at 60 min (the injected task with `injected: { limits: 1, standInOk: true }`); `all(min)` maps every task to `score(t, { wallMinutes: min })`; `file(label, tasks)`; `ivs(over)` builds `Interventions` with `total` from `interventionTotal`.
  - "refuses a short commit, a prompt without {plan}, and an unknown task id": a valid object parses with `{ limits: 0, setup: [], acceptFiles: [], inject: null }`; `{ commit: "6795167" }`, `{ prompt: "do it" }`, `{ id: "nope" }` each fail `safeParse`.
  - "takes a version or plan label and refuses a path": `"1.5.0"`, `"plan-29"`, `"2.0.0-beta.3"` pass through; `""`, `"../x"`, `"A"`, `"a/b"` throw `E_INPUT_INVALID`.
  - "adds parks, takeovers, manual dispatches, pauses, superseded runs and chat, not answers": `{ parks: 1, answers: 5, takeovers: 2, manualDispatches: 3, pauses: 1, superseded: 1, chat: 2 }` → `10`.
  - "passes four finished tasks with no intervention, a recovered injected task and wall-clock within 10 % of the baseline": `passBar(file("plan-29", all(66)), file("1.5.0", all(60)))` equals `{ pass: true, failures: [], wall: { now: 264, baseline: 240 } }`.
  - "fails a missing task, an unfinished one and one with interventions, naming each": without `raqam-myanmar`, `catherd-findings` with `finished: false`, `sanitell-payment-3` with one park → failures exactly `["raqam-myanmar: not recorded", "catherd-findings: not finished", "sanitell-payment-3: 1 intervention(s)"]`.
  - "fails an injected task that never hit a limit, or whose stand-in did not end ok": `injected` of `{ limits: 0, standInOk: true }`, `{ limits: 1, standInOk: false }` and `null` each give exactly `["injected-lao: did not recover by itself"]`.
  - "fails a wall-clock more than 10 % over the baseline's total, and any comparison without a full baseline": `all(67)` against `all(60)` → `["wall-clock 268 min against the baseline's 240 min (more than 10 % slower)"]`; a `null` baseline → `["no full baseline to compare wall-clock against"]`; a baseline holding one task → `pass: false`.
  - "never gates quota, review rounds or the first try": every task with `reviewRounds: 9`, `firstTry: false`, `claudeAgentTokens: 9e9` against `all(60)` → `pass: true`.
- [ ] **Step 2: Run** `bun test test/domain/scorecard.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement.** `assertLabel` throws `E_INPUT_INVALID` "`<label>` is not a scorecard label", fix "a version or plan name: 1.5.0, plan-29, 2.0.0-beta.1", unless `/^[a-z0-9][a-z0-9.-]{0,40}$/`. `recovered(s)`: `s.injected !== null && s.injected.limits > 0 && s.injected.standInOk && s.finished && s.interventions.total === 0`. `passBar`, per task in `SCORECARD_TASKS` order: missing → `"<t>: not recorded"` (nothing more for it); else not finished → `"<t>: not finished"`; else `total > 0` → `"<t>: <n> intervention(s)"`; then the injected task, when recorded and not `recovered` → `"injected-lao: did not recover by itself"`; then `now` = sum of the recorded tasks' minutes, `baseline` = the baseline's sum only when it holds all four (else `null` and `"no full baseline to compare wall-clock against"`), and `now > baseline * (1 + WALL_TOLERANCE)` → `"wall-clock <now> min against the baseline's <baseline> min (more than 10 % slower)"`, minutes rounded to whole numbers in the message.
- [ ] **Step 4: Run** the same — Expected: PASS.
- [ ] **Step 5: Commit** `feat(scorecard): task schema, scores and the pass bar`

---

### Task 2: what a run's files say

**Files:** Modify `src/services/milestones.ts` (after `partialReviewer`, which ends at line 98), `src/services/protocol.ts` (after `laneIds`, lines 41-50), `src/services/questions.ts` (after `rows`, lines 26-29), `src/services/summary.ts` (after `runsSummary`); Create `src/services/scorecard-metrics.ts`; Test `test/services/scorecard-metrics.test.ts`

**Interfaces:**
- Consumes: Task 1's `Interventions`, `QuotaRow`, `interventionTotal`; `readRecords`, `readAgentRuns`, `listRuns`, `supersededBy`, `runPaths`, `Run` (`run-store.ts`); `readSessionRows` (`sessions.ts`); `sessionKey` (`domain/host.ts`); `pauseSpans` (`pause.ts`); `parkedSpans` (`questions.ts`); `landedMilestones` (`milestones.ts`); `coveredMs` (`domain/util.ts`); `RunRecord`.
- Produces:
  ```ts
  export function reviewRounds(run: Run, m: string): number;                     // milestones.ts
  export function runMilestones(run: Run): string[];                             // protocol.ts
  export function questionCounts(run: Run): { questions: number; answers: number }; // questions.ts
  export function quotaByBackend(records: RunRecord[]): QuotaRow[];              // summary.ts
  // scorecard-metrics.ts
  export function interventionsOf(run: Run, end: number, chat: number): Interventions;
  export function runEnd(run: Run): number;                // epoch ms
  export function pausedMs(run: Run, end: number): number;
  export function failoverRecovered(run: Run): boolean;
  ```

- [ ] **Step 1: Write the failing tests** (`afterEach(snapshotEnv())`; `freshRun()`, `appendRecord(run, makeRecord({...}))`, `writeLane`, `park`/`answer` with `fakeDeps()`, `pauseMachine`/`resumeMachine`, rows by `ensureJsonlHeader` + `appendJsonl`; fixed ISO times):
  - "counts the milestone's full reviews since its lanes started, a partial one not": a lane dispatch of M1 at 10:00; `reviewer-M1` records ok at 09:00, 10:10 (`replyStatus: "partial"`), 10:20 and 10:40; `reviewer-M10` at 10:30 → `reviewRounds(run, "M1")` is `2`.
  - "lists the milestones its lane files name, in number order": lanes `M10.L1`, `M2.L1`, `M2.L2` → `["M2", "M10"]`.
  - "sums tokens and limits per backend, sorted by backend": two codex records (one `status: "limit"`) and one claude-code → `[{ backend: "claude-code", runs: 1, input: 5, cached: 0, output: 2, limits: 0 }, { backend: "codex", runs: 2, input: 10, cached: 4, output: 1, limits: 1 }]`.
  - "counts each park once, its answer shown but not added": park then answer M1 → `{ parks: 1, answers: 1, total: 1 }`.
  - "counts each change of owner session after the start as a takeover": `startedBy` A; `sessions.jsonl` rows A, B, B, A → `takeovers: 2`.
  - "counts no manual dispatch in a 1.5 run; in a run with events.jsonl, every record a session admitted": a record with `sessionId: "s-1"` and one without → `0`; after writing an empty `events.jsonl` → `1`.
  - "counts a pause that began during the run, not one before it": a machine pause and resume before `createdAt`, another inside the run → `pauses: 1`.
  - "adds the operator's chat count, and each run this one superseded": a second run in the repo superseded by this one, `chat` 2 → `{ chat: 2, superseded: 1, total: 3 }`.
  - "ends a run at its last landing, else at its last record or native agent run": ledger row M1 and `digests/M1.md` holding `Commit abc1234 · 5 min · landed 2026-09-25T11:00:00.000Z`, a record ending 11:30 → 11:00; with no ledger row → 11:30; with an `agents.jsonl` row at 11:45 → 11:45.
  - "adds parked and paused minutes inside the run, overlaps once": a park 10:10–10:20 and a pause 10:15–10:30 in a run from 10:00, end 11:00 → `20 * 60_000`.
  - "is true only when a stand-in (failoverFrom set) ended ok and was not blocked": a limit record → `false`; a stand-in with `replyStatus: "blocked"` → `false`; a stand-in ok → `true`.
- [ ] **Step 2: Run** `bun test test/services/scorecard-metrics.test.ts` — Expected: FAIL (exports missing).
- [ ] **Step 3: Implement.**
  - `reviewRounds`: `reviewerAttempts(run, m, milestoneStart(run, m)).filter((a) => !a.partial).length`.
  - `runMilestones`: `[...new Set(laneIds(run).map(milestoneOf))].sort(byNumber)`.
  - `questionCounts`: `rows(run)` counted by `kind`.
  - `quotaByBackend`: one row per `backend`, `localeCompare` order; `limits` counts `status === "limit"`.
  - `interventionsOf`: parks and answers from `questionCounts`; takeovers over the key sequence `[meta.startedBy (when set), ...readSessionRows(run)]` by `sessionKey`, counting each element whose key differs from the one before; manual dispatches only when `existsSync(join(run.dir, "events.jsonl"))`, counting records with a `sessionId`; pauses: `pauseSpans(run)` with `from` in `[Date.parse(meta.createdAt), end]`; superseded: runs of `listRuns([run.meta.repo])` with `supersededBy(r)?.by === run.id`; `total` from `interventionTotal`.
  - `runEnd`: the last of `landedMilestones(run)`, its `digests/<M>.md` matched by `/ · landed (\S+)\s*$/m`; else the latest record `endedAt` or agent row `at`; else `createdAt`.
  - `pausedMs`: `coveredMs(createdAt, end, [...runMilestones(run).flatMap((m) => parkedSpans(run, m)), ...pauseSpans(run)])`.
  - `failoverRecovered`: some record with `failoverFrom !== null`, `status === "ok"`, `replyStatus` neither `blocked` nor `refused`.
- [ ] **Step 4: Run** `bun test test/services/scorecard-metrics.test.ts test/services/protocol.test.ts test/services/summary-reconcile.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(scorecard): read interventions, rounds, wall-clock and quota from a run`

---

### Task 3: the fake quota limit

**Files:** Create `scorecard/shim/codex`, `scorecard/shim/claude` (mode 755); Test `test/scorecard-shim.test.ts`

**Interfaces:**
- Consumes: `test/fixtures/adapters/codex/limit.jsonl`, `test/fixtures/adapters/claude-code/limit.jsonl`; `codexAdapter`, `claudeCodeAdapter`; `parseRung`.
- Produces: the env seam `CATHERD_SCORECARD_LIMITS=<dir>`, holding `tokens/<n>` (one file per limit to inject) and `taken/` (where each injected limit moves its token).

The codex shim, as spiked. The claude shim differs only in the binary name, the fixture path (`claude-code/limit.jsonl`) and the trigger: any argument equal to `-p` or `--print`.

```sh
#!/bin/sh
# catherd scorecard: while $CATHERD_SCORECARD_LIMITS holds a token, one `codex exec` ends in a usage limit
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "$1" = exec ] && [ -n "$CATHERD_SCORECARD_LIMITS" ]; then
  for t in "$CATHERD_SCORECARD_LIMITS"/tokens/*; do
    [ -e "$t" ] || break
    if mv "$t" "$CATHERD_SCORECARD_LIMITS/taken/" 2>/dev/null; then
      cat "$here/../../test/fixtures/adapters/codex/limit.jsonl"
      exit 1
    fi
  done
fi
real=
set -f; IFS=:
for d in $PATH; do
  [ "$d" = "$here" ] && continue
  if [ -x "$d/codex" ]; then real=$d/codex; break; fi
done
unset IFS; set +f
[ -n "$real" ] || { echo "codex: not found on PATH" >&2; exit 127; }
exec "$real" "$@"
```

- [ ] **Step 1: Write the failing tests.** Each spawns a shim by absolute path with an explicit `env`: `PATH` = the shim dir, then a temp dir holding a fake `codex` and `claude` (`#!/bin/sh`, printing `real $*` and exiting 7), then `/usr/bin:/bin`; `ANTHROPIC_API_KEY: ""`; `CATHERD_SCORECARD_LIMITS` = a temp dir with `tokens/1` and `taken/`. `finished(rung, r)` builds a `FinishedRun` as `test/adapters/contract.ts:107-121` does, from the stdout lines and `exit.code`.
  - "ends one %s call in a limit the adapter reads as a limit, then runs the real CLI" (`it.each` over `["codex", ["exec", "-m", "gpt-6-sol"], codexAdapter, "codex:gpt-6-sol#medium"]` and `["claude", ["-p", "--output-format", "stream-json"], claudeCodeAdapter, "claude-code:claude-opus-5-5#low"]`): the first call exits 1 and `adapter.finalize(...)` is `limit`; `taken/` holds `["1"]`; the second call with an extra `"a b"` argument returns `[7, "real <args> a b\n"]`.
  - "passes through every call that is not a headless run, and every call without the env": `codex --version` and `claude --version` print `real --version`; `codex exec` with `CATHERD_SCORECARD_LIMITS` unset exits 7; `tokens/` still holds `["1"]`.
  - "keeps PATH as it was for the CLI it runs": a fake that prints `$PATH` prints a value starting with the shim dir.
  - "says the CLI is missing, with exit 127, when only the shim is on PATH".
  - "is executable": both shims have an execute bit.
- [ ] **Step 2: Run** `bun test test/scorecard-shim.test.ts` — Expected: FAIL.
- [ ] **Step 3: Write both shims; `chmod 755`; `git add --chmod=+x scorecard/shim/codex scorecard/shim/claude`.**
- [ ] **Step 4: Run** the same — Expected: PASS.
- [ ] **Step 5: Commit** `test(scorecard): a PATH shim that injects one usage limit`

---

### Task 4: prepare, score and store

**Files:** Create `src/services/scorecard.ts`; Test `test/services/scorecard.test.ts`

**Interfaces:**
- Consumes: Task 1 (all); Task 2 (all); `runCheck`, `checkEnvFor` (`preflight.ts`); `git`, `gitHead` (`infra/git.ts`); `assetPath`; `dataDir`; `writeJsonAtomic`, `readVersioned`, `ensurePrivateDir` (`infra/store.ts`); `findRun`, `listRuns`, `readRecords`, `readAgentRuns`, `readOutcomes`, `supersededBy`; `latestOutcomes` (`domain/route.ts`); `landedMilestones`; `openQuestions`.
- Produces:
  ```ts
  export const scorecardRoot = (): string | null;        // assetPath("scorecard") when it exists
  export const defaultPreparedRoot = (): string;         // join(dataDir(), "scorecard")
  export function loadTask(id: string, root: string): ScorecardTask;
  export interface Prepared { schema: 1; task: ScorecardTaskId; dir: string; repo: string; plan: string;
    startCommit: string; limits: string | null; shim: string | null; preparedAt: string; prompt: string }
  export async function prepareTask(i: { task: ScorecardTask; root: string; into: string; source?: string;
    now: Date; setup: boolean }): Promise<Prepared>;
  export function readPrepared(dir: string): Prepared;
  export async function scoreTask(i: { dir: string; root: string; run?: string; chat?: number; now: number }): Promise<TaskScore>;
  export const resultsFile = (dir: string, label: string): string;   // join(dir, `${assertLabel(label)}.json`)
  export function readScorecard(file: string): ScorecardFile | null; // null when absent
  export function saveTaskScore(file: string, label: string, s: TaskScore): ScorecardFile;
  ```

**Behavior:**

- `loadTask(id, root)`: an id outside `SCORECARD_TASKS` → `E_INPUT_INVALID` "no scorecard task <id>", fix `catherd scorecard prepare raqam-myanmar|catherd-findings|sanitell-payment-3|injected-lao`; else `readVersioned(join(root, "tasks", id, "task.json"), ScorecardTaskSchema, 1)`, and `E_CONFIG_INVALID` when its `id` is not the folder's.
- `prepareTask`, in order; nothing outside `into`, and `prepared.json` last:
  1. `source = i.source ?? task.source`; null → `E_INPUT_INVALID` "<id> names no source", fix `catherd scorecard prepare <id> --source <path or URL>`.
  2. `ensurePrivateDir(dirname(into))`, then `mkdirSync(into)` (an existing folder → `E_INPUT_INVALID`).
  3. `git(into, ["clone", "--quiet", "--no-checkout", source, "repo"], 30 * 60_000)`; `git(repo, ["checkout", "--quiet", "-b", "scorecard/<id>", commit])` (failure → `E_INPUT_INVALID` "<source> has no commit <commit>"); `git(repo, ["remote", "remove", "origin"])`.
  4. `inject`: each edit's file must contain `find` exactly once (else `E_CONFIG_INVALID` "<path>: the inject text is there <n> times, not once", fix "update scorecard/tasks/<id>/task.json"); replace; `git add -A`; `git -c user.name=catherd-scorecard -c user.email=scorecard@catherd.invalid commit --quiet -m <message>`.
  5. `plan`: `{ file }` is copied from `root/tasks/<id>/<file>` to `into/plan.md`; `{ repoPath }` must exist in `repo` (else `E_CONFIG_INVALID`) and is used in place.
  6. `limits > 0`: `into/limits/tokens/1..n` and `into/limits/taken/`, `shim = join(root, "shim")`; else both null.
  7. `setup` (when `i.setup`): each command through `runCheck(repo, cmd, 30 * 60_000, await checkEnvFor(repo))`; a failure or timeout → `E_IO_UNEXPECTED` "setup `<cmd>` failed in <repo>: <last tail line>", fix "fix it and run it in <repo>, or prepare again"; the folder stays, without `prepared.json`.
  8. `startCommit = await gitHead(repo)`; `prompt` = `task.prompt` with `{plan}` → the plan path and `{acceptance}` → `task.acceptance`; `writeJsonAtomic(join(into, "prepared.json"), …)`.
- `readPrepared(dir)`: `readVersioned` of `prepared.json`; absent → `E_INPUT_INVALID` "<dir> is not a prepared scorecard task", fix `catherd scorecard prepare <task>`.
- `scoreTask`:
  1. The run: `findRun(i.run)` when given (its `meta.repo` must be `prepared.repo`, else `E_INPUT_INVALID`); else the runs of `listRuns([prepared.repo])` created at or after `preparedAt` and not superseded: none → `E_INPUT_INVALID` "no run in <repo> yet"; several → `E_INPUT_INVALID` "<repo> has runs <id>, <id>", fix `catherd scorecard record <dir> --label <l> --run <id>`.
  2. `milestones = runMilestones(run)`, `landed = landedMilestones(run)`; `finished = milestones.length > 0 && every milestone landed && openQuestions(run).length === 0 && !supersededBy(run)`.
  3. `end = runEnd(run)`; `wallMinutes` and `pausedMinutes` (`pausedMs`) to one decimal.
  4. Acceptance: any `acceptFiles[].to` already in `repo` → `E_INPUT_INVALID` "<to> already exists in the run's tree"; copy each from `root/tasks/<id>/<from>`; `runCheck(repo, task.acceptance, acceptanceTimeoutMin * 60_000, await checkEnvFor(repo))` in a `try`, the copies removed in its `finally`; `passed = code === 0 && !timedOut`.
  5. `firstTry = acceptance.passed && finished && new Set(landed).size === landed.length`.
  6. `lanes` from `latestOutcomes(readOutcomes(run))`: rows, rows with `landed`, summed `climbs.length`.
  7. `quota = { backends: quotaByBackend(records), claudeAgentTokens: Σ readAgentRuns(run).totalTokens }`.
  8. `injected = task.limits > 0 ? { limits: readdirSync(<limits>/taken).length, standInOk: failoverRecovered(run) } : null`.
  9. `interventions = interventionsOf(run, end, i.chat ?? 0)`; `reviewRounds` = Σ `reviewRounds(run, m)`; `head = await gitHead(repo)`; `catherdVersion = run.meta.catherdVersion`; `recordedAt = new Date(i.now).toISOString()`.
- `saveTaskScore`: reads the file or starts `{ schema: 1, label, tasks: {} }`, sets `tasks[s.task]`, `ensurePrivateDir(dirname(file))`, `writeJsonAtomic`, returns the file.

- [ ] **Step 1: Write the failing tests** (`afterEach(snapshotEnv())`, `withHome()`; a temp `root` with `tasks/<id>/task.json` written from `taskFor(over)`, whose defaults are `id: "raqam-myanmar"`, `plan: { file: "plan.md" }`, `acceptance: "true"`, `prompt: "do {plan} then {acceptance}"`, `commit` = the source's second commit; the source is a `tempRepo()` whose second commit adds `a.txt` (`"one\ntwo\n"`) and `docs/plan.md`; runs are made in the prepared repo with `createRun({ repo, title, aLines, version: "0.0.0-test" })`):
  - "clones the source at the task's commit onto scorecard/<task>, with no remote, and writes prepared.json last": branch `scorecard/raqam-myanmar`; `git remote` prints nothing; `startCommit` is the commit; `readPrepared(into)` equals the result; `prompt` is `` `do ${join(into, "plan.md")} then true` ``.
  - "applies each inject edit once and commits it; refuses an edit whose text is not there exactly once": `two` → `2` gives `a.txt` `"one\n2\n"` and a last commit subject `test: x`; `find` of `"three"` (0 times) and `"o"` (twice) each reject `E_CONFIG_INVALID`, leaving no `prepared.json`.
  - "copies a file plan beside the repo, and refuses a repoPath plan missing at the commit": `{ repoPath: "docs/plan.md" }` → `plan` is `into/repo/docs/plan.md`; `docs/none.md` → `E_CONFIG_INVALID`.
  - "lays out one token per limit and names the shim for an injected task": `limits: 2` → `tokens/` holds `["1", "2"]`; `shim` is `root/shim`.
  - "refuses a task with no source when none is given, and a commit the source lacks": `E_INPUT_INVALID`; `"f".repeat(40)` → `/has no commit/`.
  - "runs the task's setup in the clone, and stops with its tail when a command fails": `echo ok > setup.txt` leaves `repo/setup.txt`; `echo broke; exit 3` → `/setup `echo broke; exit 3` failed.*broke/`.
  - "scores a landed run: finished, its review rounds, wall-clock to its landing, acceptance passed and a first try": lane M1.L1, a `reviewer-M1` record ok, ledger row M1, its digest landed 50 min after `createdAt`, acceptance `test -f a.txt` → `{ finished: true, reviewRounds: 1, wallMinutes: 50, firstTry: true, interventions: { total: 0 }, acceptance: { passed: true }, catherdVersion: "0.0.0-test", injected: null }`.
  - "scores a run that never landed as unfinished, its wall-clock to its last record": one record ending 20 min in, no ledger row → `{ finished: false, firstTry: false, wallMinutes: 20 }`.
  - "refuses a folder with two runs unless run names one, and counts the run it superseded": runs A and B → the message names both; `run: B.id` → `superseded: 0`; once A is superseded by B, no `run` picks B with `superseded: 1`.
  - "copies the accept files in for acceptance and removes them after, even when the check fails; refuses one whose path the run already has": `acceptFiles [{ from: "accept/ok.txt", to: "accept-ok.txt" }]`, acceptance `test -f accept-ok.txt && exit 4` → `passed: false`, `code: 4`, no `accept-ok.txt` left; a run-written `accept-ok.txt` → `/already exists/`, its content unchanged.
  - "reports the injected limits the shim took and whether a stand-in ended ok": `limits: 1`, `taken/1`, a limit record then an ok stand-in with `failoverFrom` → `injected: { limits: 1, standInOk: true }`.
  - "writes one row per task under its label, replacing that task's earlier row; refuses a label that is not a plain name": three saves (raqam at 1 min, injected, raqam at 2 min) → keys `["injected-lao", "raqam-myanmar"]`, raqam's `wallMinutes` 2; `resultsFile(dir, "../x")` throws.
  - "loads a task by its id and refuses an unknown one with the four names".
- [ ] **Step 2: Run** `bun test test/services/scorecard.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement `src/services/scorecard.ts` as above.**
- [ ] **Step 4: Run** `bun test test/services/scorecard.test.ts test/architecture.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(scorecard): prepare a task, score its run and store the row`

---

### Task 5: the four fixtures

**Files:** Create `scorecard/tasks/raqam-myanmar/{task.json,plan.md,accept/my.accept.ts}`, `scorecard/tasks/catherd-findings/{task.json,plan.md,accept/findings.accept.ts}`, `scorecard/tasks/sanitell-payment-3/task.json`, `scorecard/tasks/injected-lao/{task.json,plan.md,accept/lo.accept.ts}`, `scorecard/results/.gitkeep`; Modify `.oxfmtrc.json` (`ignorePatterns` gains `"scorecard/tasks/**"`: fixture files keep their target repo's style); Test `test/scorecard-fixtures.test.ts`

**Interfaces:** Consumes Task 1's `SCORECARD_TASKS`, `INJECTED_TASK` and Task 4's `loadTask`. Produces the four tasks' files.

`PROMPT`, shared by the raqam, catherd and injected tasks:

> `Use catherd to implement the plan at {plan} in this repository, unattended: ask me only what nobody else can answer. The gate is: {acceptance}. Do not push or open a merge request.`

**raqam-myanmar** — `task.json`: title "raqam: a Myanmar locale plugin"; goal "`import \"raqam/locales/my\"` makes every field read Myanmar digits"; `source` `"https://github.com/47vigen/raqam.git"`; `commit` `"67951678b7cdb115b9f00eb63b3ea7f91a1c464d"`; `plan` `{ "file": "plan.md" }`; `setup` `["pnpm install --frozen-lockfile"]`; `acceptance` `"pnpm typecheck && pnpm test && pnpm lint && pnpm build && test -f dist/locales/my.js"`; `acceptanceTimeoutMin` 20; `acceptFiles` `[{ "from": "accept/my.accept.ts", "to": "src/locales/my.accept.test.ts" }]`; `prompt` `PROMPT`.

`plan.md` (one milestone, one task):
- What exists: `src/locales/th.ts` (`registerLocale({ digitBlocks: [[0x0e50, 0x0e59]] })`; `export const LOCALE_CODES = ["th", "th-TH"] as const`); `src/locales/index.ts` re-exports each as `<XX>_LOCALE_CODES`; `tsup.config.ts:37-41` lists the locale entries; `package.json` exports `./locales/*` by wildcard (no change); `src/locales/locale-integration.test.tsx` imports every plugin.
- Task 1: `src/locales/my.ts` registers `[[0x1040, 0x1049]]` (Myanmar ၀–၉) and exports `LOCALE_CODES = ["my", "my-MM"] as const`, doc comment shaped like th.ts's; `src/locales/index.ts` adds `export { LOCALE_CODES as MY_LOCALE_CODES } from "./my.js";` and names Myanmar in its comment; `tsup.config.ts` adds `"locales/my": "src/locales/my.ts"`; README.md:127 and the table in `docs/content/docs/guides/locales.mdx` (line 39) add Myanmar `my`; `.changeset/myanmar-locale.md`, `"raqam": minor`, "Adds the Myanmar locale plugin, `raqam/locales/my`.".
- Tests, in `locale-integration.test.tsx`: `import "./my.js"`; `normalizeDigits("၁၂၃၄")` is `"1234"`; `MY_LOCALE_CODES` equals `["my", "my-MM"]`.

`accept/my.accept.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeDigits } from "../core/normalizer.js";
import { MY_LOCALE_CODES } from "./index.js";
import { LOCALE_CODES } from "./my.js";

describe("raqam/locales/my (scorecard acceptance)", () => {
  it("reads Myanmar digits as ASCII", () => {
    expect(normalizeDigits("၁၂၃၄၅၆၇၈၉၀")).toBe("1234567890");
  });
  it("names its locale codes, re-exported from the locales index", () => {
    expect(LOCALE_CODES).toEqual(["my", "my-MM"]);
    expect(MY_LOCALE_CODES).toBe(LOCALE_CODES);
  });
});
```

**catherd-findings** — `task.json`: title "catherd: two review-gate misreads"; goal "a reviewer's `BLOCKER: none` is no finding, and a `./path` hit matches its `Allow:` entry"; `source` `"https://github.com/47vigen/catherd.git"`; `commit` `"2061e6e61c7252738869590cca37d78239dabd60"` (1.5.0); `plan` `{ "file": "plan.md" }`; `setup` `["bun install --frozen-lockfile"]`; `acceptance` `"bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test"`; `acceptanceTimeoutMin` 30; `acceptFiles` `[{ "from": "accept/findings.accept.ts", "to": "test/scorecard-accept.test.ts" }]`; `prompt` `PROMPT`.

`plan.md` (one milestone, two independent lanes):
- Lane 1, `src/services/milestones.ts:100` (`FINDING`): a line whose text after the label and an optional colon is `none`, `n/a` or `-`, in any case, is no finding; `countFindings` and the digest's `findingLines` (`src/services/protocol.ts:205-214`) read `FINDING` and need no other change. Test in `test/services/protocol.test.ts`, "reads BLOCKER: none, BUG: n/a and NIT: - as no finding": `countFindings` of the reply `BLOCKER: none\nBUG: n/a\n- NIT: -\nBUG: the parser drops a field\nSTATUS: complete — reviewed` is `{ BLOCKER: 0, BUG: 1, NIT: 0 }`.
- Lane 2, `src/domain/lane.ts:143-158` (`onlyAllowedHits`): the hit's path and the entry's path are compared after `normalizeOwned`; a hit path that does not normalize (`../x.md`) is not allowed. Test in `test/domain/lane.test.ts`, `describe("onlyAllowedHits")`: `./docs/a.md:3:x` is allowed by `docs/a.md`; `../docs/a.md:3:x` is not.
- Both entries leave `docs/dev/ideas.md`; `.changeset/review-gate-misreads.md`, `"catherd-cli": patch`.

`accept/findings.accept.ts` — formatted and linted as a test of this repo: copy it to `test/scorecard-accept.test.ts`, run `bunx oxfmt test/scorecard-accept.test.ts && bunx oxlint --deny-warnings test/scorecard-accept.test.ts` (expected: no lint output), copy it back, delete the copy:

```ts
import { expect, it } from "bun:test";
import { onlyAllowedHits } from "../src/domain/lane.ts";
import { FINDING } from "../src/services/milestones.ts";

it("reads a finding line that says none as no finding (scorecard acceptance)", () => {
  for (const line of ["BLOCKER: none", "BUG: n/a", "- NIT: -", "BLOCKER: None"]) expect(FINDING.exec(line)).toBeNull();
  expect(FINDING.exec("BUG: the parser drops a field")?.[1]).toBe("BUG");
});

it("matches a ./path hit against its Allow: entry (scorecard acceptance)", () => {
  expect(onlyAllowedHits(["./docs/a.md:3:x"], ["docs/a.md"])).toBe(true);
  expect(onlyAllowedHits(["./docs/b.md:3:x"], ["docs/a.md"])).toBe(false);
});
```

**sanitell-payment-3** — `task.json`: title "Sanitell: payment plan 3, kit/auth apps (replayed)"; goal "a customer is signed in, never a person; an sso_session belongs to one app; the listener mounts a customer app beside the panel"; `source` `null`; `commit` `"0296d87585d6288998f7b845a501ebdf2a5c1cad"`; `plan` `{ "repoPath": "docs/plans/2026-09-28-payment-3-kit-auth-apps.md" }`; `setup` `["pnpm install --frozen-lockfile"]`; `acceptanceTimeoutMin` 90; no `acceptFiles`; `acceptance`:

```sh
export DOCKER_HOST=$(docker context inspect --format '{{.Endpoints.docker.Host}}') TURBO_TELEMETRY_DISABLED=1 && (cd packages/kit && task check) && (cd services/auth && task check) && (cd services/notification && task check) && (cd services/verification && task check) && node tooling/dupes/dupes.mjs && node tooling/links/links.mjs && for m in packages/kit/store/migrations services/auth/internal/store/migrations services/notification/internal/store/migrations services/verification/internal/store/migrations; do test -z "$(ls $m | sed 's/_.*//' | sort | uniq -d)" || exit 1; done
```

and `prompt` (the original run's A-lines, rewritten for a clone with no remote):

> `Use catherd to implement Tasks 1–5 of {plan} in this repository, unattended. A1 The plan is final; do not redesign: every decision in it is confirmed (contracts §12 D1–D21, §14 binding, §14.6 codes, spec decisions 25–29). A2 docs/plans/2026-09-28-payment-0-contracts.md is the source of truth for names; a plan-versus-contracts conflict is a design finding, never a worker's call. A3 Every task is implemented with its tests; skip the plan's git commit steps, the run commits. A4 The gate is: {acceptance}. A5 Heavy commands run behind catherd lock --, one at a time; no Vite dev server. A6 English in code; no secrets, no .env files. Do not push or open a merge request.`

**injected-lao** — `task.json`: title "raqam: Lao digits out of the box (injected failure)"; goal "every field reads Lao digits with no locale import"; `source` `"https://github.com/47vigen/raqam.git"`; `commit` `"67951678b7cdb115b9f00eb63b3ea7f91a1c464d"`; `plan` `{ "file": "plan.md" }`; `limits` 1; `setup` `["pnpm install --frozen-lockfile"]`; `acceptance` `"pnpm typecheck && pnpm test && pnpm lint"`; `acceptanceTimeoutMin` 20; `acceptFiles` `[{ "from": "accept/lo.accept.ts", "to": "src/core/lo.accept.test.ts" }]`; `prompt` `PROMPT`; `inject`:

```json
{ "message": "test(core): lao digits stay as typed",
  "edits": [{ "path": "src/core/normalizer.test.ts",
    "find": "  it(\"preserves non-digit characters\", () => {",
    "replace": "  it(\"leaves Lao digits as typed\", () => {\n    expect(normalizeDigits(\"\\u0ed1\\u0ed2\\u0ed3\")).toBe(\"\\u0ed1\\u0ed2\\u0ed3\");\n  });\n\n  it(\"preserves non-digit characters\", () => {" }] }
```

At `6795167` the injected test passes (`normalizeDigits` falls back to `parseInt`, which reads no Lao digit); the plan's change breaks it, and the gate fails until the run fixes that stale test (Ruling 10).

`plan.md` (one milestone, one task; it does not mention the stale test):
- What exists: `src/core/normalizer.ts:7-14` `BUILTIN_DIGIT_BLOCKS` (Thai `[0x0e50, 0x0e59]` is built in); `src/core/normalizer.test.ts` has one test per built-in script.
- Task 1: `[0x0ed0, 0x0ed9], // Lao (laoo)` after Thai in `BUILTIN_DIGIT_BLOCKS`; test "converts Lao digits": `normalizeDigits("໐໑໒໓໔໕໖໗໘໙")` is `"0123456789"`; `docs/content/docs/api/core-utilities.mdx:107` names Lao among the built-in scripts; `.changeset/lao-digits.md`, `"raqam": minor`, "Reads Lao digits with no locale import.".

`accept/lo.accept.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeDigits } from "./normalizer.js";

describe("Lao digits (scorecard acceptance)", () => {
  it("reads Lao digits as ASCII with no locale import", () => {
    expect(normalizeDigits("໐໑໒໓໔໕໖໗໘໙")).toBe("0123456789");
  });
});
```

- [ ] **Step 1: Write the failing tests** (`ROOT = join(import.meta.dir, "..", "scorecard")`):
  - "loads every task under its own id, and the four are the scorecard's tasks": `readdirSync(ROOT/tasks)` sorted equals `SCORECARD_TASKS` sorted; `loadTask(id, ROOT).id` is `id` for each.
  - "pins each task to its commit, and only the Sanitell task to no source": `[commit, source]` per id equals `raqam-myanmar` and `injected-lao` → `["67951678b7cdb115b9f00eb63b3ea7f91a1c464d", "https://github.com/47vigen/raqam.git"]`, `catherd-findings` → `["2061e6e61c7252738869590cca37d78239dabd60", "https://github.com/47vigen/catherd.git"]`, `sanitell-payment-3` → `["0296d87585d6288998f7b845a501ebdf2a5c1cad", null]`.
  - "has every plan and accept file a task names".
  - "injects a limit and a stale test into the injected task only": `[limits > 0, inject !== null]` is `[true, true]` for `INJECTED_TASK`, `[false, false]` for the others.
  - "names no private host in any fixture": no file under `scorecard/tasks` or `docs/` names a private host.
- [ ] **Step 2: Run** `bun test test/scorecard-fixtures.test.ts` — Expected: FAIL.
- [ ] **Step 3: Write the fixture files, `scorecard/results/.gitkeep` (empty) and the `.oxfmtrc.json` pattern.**
- [ ] **Step 4: Run** `bun test test/scorecard-fixtures.test.ts && bun run format:check` — Expected: PASS.
- [ ] **Step 5: Commit** `test(scorecard): the four fixed tasks`

---

### Task 6: `catherd scorecard`, and its docs

**Files:** Create `src/entry/scorecard-command.ts`, `docs/dev/scorecard.md`; Modify `src/cli.ts:44-63` (one `subCommands` entry after `"capture-fixtures"`), `README.md:217` (a row after `capture-fixtures`), `CONTRIBUTING.md` (one paragraph after the capture-fixtures paragraph, lines 150-155); Test `test/entry/scorecard-command.test.ts`

**Interfaces:**
- Consumes: Task 4 (all); Task 1's `passBar`, `SCORECARD_TASKS`; `printJson`, `JSON_ARG`, `mark`, `refuseInRole`, `printError`, `exitCodeOf` (`cli-kit.ts`).
- Produces: `export const scorecardCommand` (citty: `prepare`, `record`, `compare`); `export function formatPrepared(p: Prepared, label?: string): string[]`; `export function formatComparison(current: ScorecardFile, baseline: ScorecardFile | null, v: Verdict): string[]`.

Every subcommand outside a checkout (`scorecardRoot()` null) → `E_INPUT_INVALID` "this catherd is not a source checkout", fix "run it from a catherd checkout: bun src/cli.ts scorecard …". `prepare` and `record` first call `refuseInRole(process.env, "catherd scorecard <sub>")`.

- `prepare <task> [--source <path or URL>] [--dir <root>] [--no-setup] [--json]`: `into = join(dir ?? defaultPreparedRoot(), "<task>-<YYYYMMDD-HHMMSS>")`; prints `formatPrepared`.
- `record <dir> --label <l> [--run <id>] [--chat <n>] [--results <dir>] [--json]`: `--chat` must be a non-negative integer (else `E_INPUT_INVALID`); `scoreTask`, then `saveTaskScore(resultsFile(results ?? join(scorecardRoot(), "results"), label), …)`; prints the task's row of `formatComparison` and the file written.
- `compare <label> [--baseline <l>] [--results <dir>] [--json]`: baseline default `1.5.0`; no current file → `E_INPUT_INVALID` "no scorecard <label> yet", fix `catherd scorecard record <dir> --label <label>`; a missing baseline is `null`; prints `formatComparison`; exit 0 on pass, 1 on fail; `--json` prints `{ current, baseline, verdict }`.

`formatPrepared(p, label = "<label>")`, exactly:

```
✓ <task> prepared in <dir> at <startCommit, 8 characters>
  start:  cd <repo> && claude
  prompt: <prompt>
  record: catherd scorecard record <dir> --label <label>
```

An injected task's start line is `  start:  cd <repo> && CATHERD_SCORECARD_LIMITS=<limits> PATH="<shim>:$PATH" claude`.

`formatComparison`: the heading `scorecard <label> against <baseline label, or "no baseline">`; a line per task in `SCORECARD_TASKS` order, `<task>  <catherdVersion>  finished <yes|no>  interventions <n>  rounds <n>  wall <m> min (<baseline m> min)  first try <yes|no>  quota <k in>/<k out>` (`-` for a task not recorded, `?` for a missing baseline value); then `PASS`, or one `FAIL: <failure>` line per failure.

`docs/dev/scorecard.md` (the operator's protocol): what the scorecard is (spec "Measurement": the gate for 2.0, not the deleted benchmarks); the four tasks, a line each with Ruling 11's facts; what each column counts (Rulings 3–8, interventions in full); the pass bar and its tolerance (Ruling 6); the operator rules (one task at a time; a fresh Claude Code session from the printed start line; paste the prompt and touch nothing; every message typed into the session afterwards is counted with `--chat`; stop at 4 hours, or when nothing moved for 30 minutes, and record the run as it stands; the default profile unchanged between measurements); the version under test (baseline: `catherd --version` and the plugin both 1.5.0; after plan N: the merged main through the beta channel, `catherd-cli@beta` and the `plugin-beta` marketplace, label `plan-N`); and Task 8's commands.

README row: `` | `catherd scorecard prepare <task>`, `record <dir> --label <l>`, `compare <label>` | Contributors: measures a catherd version on four fixed tasks against the 1.5.0 baseline (docs/dev/scorecard.md) | ``.

- [ ] **Step 1: Write the failing tests** (`withHome()`; spawns use `{ ...process.env, ANTHROPIC_API_KEY: "", NO_COLOR: "1" }` as `test/entry/cli.test.ts` does; the formatters run in-process):
  - "prints the folder, the start line, the prompt and the record command": `formatPrepared` of a raqam `Prepared` in `/p/d` at `67951678…`, prompt `do /p/d/plan.md`, label `1.5.0` equals `["✓ raqam-myanmar prepared in /p/d at 67951678", "  start:  cd /p/d/repo && claude", "  prompt: do /p/d/plan.md", "  record: catherd scorecard record /p/d --label 1.5.0"]`.
  - "starts the injected task's session with the shim first on PATH and the limits dir": line 2 is `'  start:  cd /p/d/repo && CATHERD_SCORECARD_LIMITS=/p/d/limits PATH="/c/scorecard/shim:$PATH" claude'`.
  - "compares a label against its baseline, row by row, and ends with the verdict": line 0 `scorecard plan-29 against 1.5.0`; the raqam line contains `wall 66 min (60 min)`; the last line `PASS`.
  - "refuses an unknown task with the four names, and exits 2": `[2, "error E_INPUT_INVALID: no scorecard task nope\nfix: catherd scorecard prepare raqam-myanmar|catherd-findings|sanitell-payment-3|injected-lao\n"]`.
  - "compare exits 1 on a failing scorecard, 0 on a passing one, and 2 for a label never recorded" (`--results` a temp dir filled by `saveTaskScore`).
  - "refuses a negative chat count, and refuses to run in a role's shell": `--chat -1` exits 2; with the role env `test/entry/role-cli-command.test.ts` builds for `CATHERD_ROLE`, `prepare` prints `E_ROLE_SCOPE`.
  - "lists scorecard in the top-level help": `catherd --help` contains `scorecard`.
- [ ] **Step 2: Run** `bun test test/entry/scorecard-command.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement; register `scorecard: () => import("./entry/scorecard-command.ts").then((m) => m.scorecardCommand)` in `src/cli.ts`; write the docs, the README row and the CONTRIBUTING paragraph.**
- [ ] **Step 4: Run** `bun test test/entry/scorecard-command.test.ts test/entry/cli.test.ts test/entry/help-text.test.ts test/wait-residue.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `feat(scorecard): the scorecard command and the operator's protocol`

---

### Task 7: the backlog and the changeset

**Files:** Modify `docs/dev/ideas.md` ("Live coverage still missing"); Create `.changeset/run-scorecard.md`

No backlog entry closes: "`catherd bench`" (under "Later") replays tasks under different profiles, which the scorecard does not, and the two entries the catherd fixture fixes stay open on main (the fixture replays 1.5.0).

- [ ] **Step 1:** In "Live coverage still missing", after its first sentence, add: "Quota failover runs live in the scorecard's `injected-lao` task (`docs/dev/scorecard.md`) from the 1.5.0 baseline on; it leaves this list once a recorded scorecard shows the stand-in ending ok."
- [ ] **Step 2:** `.changeset/run-scorecard.md`:

```md
---
"catherd-cli": major
---

Part of 2.0.0. `catherd scorecard prepare|record|compare` measures a catherd version on four fixed tasks (a raqam
task, a catherd milestone, a replayed Sanitell task and an injected-failure task) and compares it against the 1.5.0
baseline: finished with no intervention, interventions, review rounds, wall-clock time, quota used and a first-try
pass. It is a contributor command that runs from a source checkout (`docs/dev/scorecard.md`).
```

- [ ] **Step 3: Run the full gate** — Expected: green.
- [ ] **Step 4: Commit** `docs(scorecard): live failover coverage and the changeset`. The release PR this opens stays unmerged until plan 36 (Ruling 17).

---

### Task 8: the 1.5.0 baseline — stop for the owner's go

No code. Four real tasks on the owner's subscriptions, up to 16 hours: the controller prints these commands to the owner and **stops**. It never starts a task itself.

- [ ] **Step 1: Hand the owner the commands, with the expected output:**

```sh
# the version under test: both say 1.5.0
catherd --version
claude plugin list | grep catherd

# the scorer: this checkout at main after plan 28
CK=<the catherd checkout>; cd "$CK" && git pull && bun install --frozen-lockfile

# one task at a time, in this order: prepare, then in a new terminal run its start line, paste its prompt,
# touch nothing until the run lands or 4 hours pass, then record
bun src/cli.ts scorecard prepare raqam-myanmar
bun src/cli.ts scorecard record <printed dir> --label 1.5.0 [--chat <messages typed into the session>]
bun src/cli.ts scorecard prepare catherd-findings
bun src/cli.ts scorecard record <printed dir> --label 1.5.0
bun src/cli.ts scorecard prepare sanitell-payment-3 --source <your clone>
bun src/cli.ts scorecard record <printed dir> --label 1.5.0
bun src/cli.ts scorecard prepare injected-lao   # its start line sets CATHERD_SCORECARD_LIMITS and the shim
bun src/cli.ts scorecard record <printed dir> --label 1.5.0

bun src/cli.ts scorecard compare 1.5.0          # four rows; FAIL lines are expected for a baseline
```

Expected: each `prepare` ends with `formatPrepared`'s four lines; each `record` prints its row and `scorecard/results/1.5.0.json`; `compare` prints four rows.

- [ ] **Step 2: Wait for the owner's go and his report.** Plan 29 may proceed meanwhile (the baseline runs the installed 1.5.0, not main).
- [ ] **Step 3: On his report,** commit `scorecard/results/1.5.0.json` on a branch from `main` (`chore(scorecard): the 1.5.0 baseline`), open its PR, and save the four rows and the `FAIL` lines to Honcho.

## Owner questions

None blocks the plan. Two rulings are his to overturn: the wall-clock tolerance (Ruling 6: 10 % on the four tasks' sum) and the reading of "a broken test" as a stale test the change breaks, not a failure already in the base (Ruling 10). Task 8 needs his go and up to 16 hours of his subscriptions.
