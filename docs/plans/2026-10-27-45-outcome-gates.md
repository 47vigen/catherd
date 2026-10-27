# Plan 45 — outcome gates: no walls, a team channel, gates that judge the product

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Never read the whole plan: take your task brief.

Setup: bun install --frozen-lockfile

**Goal:** a run spends its time on the product, not on walls and process: a lane changes whatever its task needs and reports what it changed outside its Owns and why, lanes tell each other what they changed through a team channel, the architect may change the plan at any point, and no gate judges commit messages, test-first evidence or which files changed.

**Architecture:** delete the enforcement paths instead of adding exceptions (the test guard, `out_of_scope`, the coverage and `Test:`-line refusals, the restated-line refusal, the mid-run re-approval), keep Owns as a scheduling hint, and add one small service, the team channel (`src/services/team.ts`), whose tool contract is ported from T3 Code. Then the decision model's fallback picks the level that is enough rather than the cheapest, a red Check gives the fix round a few lean findings, and the Cursor backend retires.

**Tech stack:** Bun ≥ 1.4, TypeScript, zod.

**Spec:** `docs/specs/2026-10-12-catherd-2.0-design.md` (decisions 3, 8 and 14 change here; Task 9 notes it) and `docs/specs/2026-10-26-decision-model-design.md` ("The questions": the pick rule, changed in Task 6). Plan 45 is the bridge to an architect-led redesign that a separate spec will define: it keeps only what survives that redesign.

Source: the owner's verdict on six real runs (P5, P6, P8, private-media, kit, pin-bump, 2026-10-25..27): quality is fine, the runs are too slow, and the strictness is pointless ("the final output matters, not the shape of commits"). Measured worker time: first build 516 min, blocked or failed dispatches 448 min (check_broken 177 min ×24, needs_user 106 ×12, out_of_scope 65 ×5), rework 349 min; about 6 of 9 verifier FAILs were process audits (~3 h). Owner decisions of 2026-10-27, binding: remove enforcement rather than loosen it ("team members work freely and report at the end: I changed X, and here is why"); lanes talk through a team channel (CooperBench, arXiv 2601.13295: open peer chat ~30 % worse; a completed-change notice recovered 82 % of conflicts, arXiv 2609.25396), so between lanes messages are queued and only the architect and the owner steer a running turn; the architect is the brain of the run and is free mid-run; the verifier-beside-the-Check and the review-finding dedupe are dropped (the redesign replaces the per-milestone verifier and the judge); isolation per writer belongs to the redesign; Cursor retires.

## Global Constraints

- catherd is a public repository. No code default, test, fixture or doc names a personal host of the owner.
- Tests never reach the network, never sleep on the wall clock for correctness (`team_wait` tests use `timeoutMs: 0`), and the opencode tests go through the sim on `PATH` (test/sim/opencode).
- Old runs replay: every event type and field in today's schema stays parseable. `dispatch.ended.testEdits` stays in the schema and is read by no one; `out_of_scope` stays in `BLOCKED_REASONS` (events, `PARK_REASONS`, the panel's generated types); a profile that names a Cursor rung loads.
- Layers `domain → infra → adapters → services → entry` (test/architecture.test.ts). New files: src/services/team.ts, test/services/team.test.ts.
- web/ is untouched and web/openapi.json does not change (the panel keeps its Cursor icon for old runs' rows).
- Copy: plain English; "Owns" is a hint, never "the files you own" in a brief.
- Commits: conventional, subject ≤ 100 characters, lower-case first word; no strict subject for executors. The full root suite takes about 180 s: `catherd lock -- bun test`.

## Review Focus

1. Two lanes that change the same file outside their Owns at the same time, in the shared milestone tree: nothing fails or blocks; each worker's reply lists the file on an EXTRA: line with its reason, the reviewer sees both, and a lane that reads the other's `changed …` notice before its edit builds on it (Task 1, Task 2, Task 4; Ruling R1).
2. A partial reply that names a sibling's file only in passing ("waits on src/b/settings.ts" for a reason of its own): the lane waits for that sibling, then its fast check decides; it is not marked done unchecked (Task 1, "a partial or unexplained stop that names a running sibling waits for it").
3. An opencode service that refuses the steer prompt (old v2, wrong body, service down): `team_send` from the architect returns `queued`, the message stays in the queue and in the target's next brief, and nothing throws (Task 2, the opencode steer test's `apiFails` case).
4. A run started before this plan with a `testEdits` line, an `out_of_scope` park, or a `question.parked` re-approval: it replays; the old park still waits for the owner's answer (Task 1, Task 4, Task 5).
5. A profile whose only worker rung is Cursor's: it loads, the role falls back to its default rungs, and `profile.migrated` logs the note once (Task 8).

## What already exists

- src/domain/run-state.ts — `onEnded` lane branch with the test guard (1133–1140: `testEdits` → `thread = null`, "Restore these test files", `failedOn`), `laneStopped` (905–950: `check_broken` with `foreign` → `laneDone`; `out_of_scope` parks), `waitForSiblings` (986–995), `laneEnded` (998–1044: waits only for `reason === "check_broken"`; a partial reply → `failedOn`, `thread = null`), `completeRound`, `fixRound`, judge `dismissed by the judge:` known issues (~1350).
- src/domain/blocked.ts — `BLOCKED_REASONS` (with `out_of_scope`), `parseBlockedReason`, `BLOCKED_LINE`, `foreignFailure`, `siblingLanesNamed`. src/domain/decision.ts — `VERDICT_OPTIONS.stop` (67), `pickLevel` (266–300: the cumulative sum runs from the top level down).
- src/domain/test-guard.ts — `TEST_PATH`, `guardedEdits` (plan 44 D11), used only by src/services/run-effects.ts:24 and :192.
- src/services/run-effects.ts — `FINDINGS_PER_ITEM = 20` (91), `widenedAfter` (306), `endedEvent` (150–213: `siblings` only when `reason === "check_broken"`), `readPlan` (768–802: `changedDecisions` and `widenedAfter` park `question.parked` `approval` before `plan.ready`), `machineCheck` (finding text `` `item` fails: line — in <every file> `` at ~973).
- src/domain/plan-doc.ts — `CHECK_COVERED` (25), `coverageProblems` (123–150), `depthProblems` (168: three sections, a `### Task` heading, a `Test:` line per task, a rejected alternative per decision, a path in What already exists), `reapprovalQuestion` (206), `changedDecisions` (224). src/domain/plan-lint.ts — `HISTORY` (146), `lintPlan` (164).
- src/services/plan-input.ts — `uncoveredALines` (166), `planProblems` (198: coverage, untagged, unowned, depth when no plan input), `roleALines` (244). src/services/preflight.ts — the daemon-run coverage refusal (332–354). src/services/run-service.ts — `writeRunFile` refuses a lane that restates an A-line (239–243). src/domain/lane.ts — `restatedALine` (186).
- src/services/run-briefs.ts — `LANE_HEADER` (71, "Two lanes of one milestone never own the same file."), `workerBrief`, `reviewPlan` (228: EXTRA and undeclared outside files, "Files changed outside their lane:"), `briefFor` (435). src/domain/role-prompts.ts — `WORKER_REPLY` (32), `architect`, `verifier` ("commit history" at ~90), `worker` (107–125: "Change only the files you own", the commit-message reject clause), `reviewer`, the architect's done-when line (~241).
- src/domain/role-tools.ts — `roleMcpTools` (28). src/domain/brief.ts — `cliForm` (29), `roleNotes`. src/entry/mcp/role-server.ts — `buildRoleServer` (`read_run_file`, `write_run_file`, the gate tools). src/entry/role-cli-command.ts — `runFileCommand` (45), `gateCommand` (162); src/cli.ts:49–50 registers them. src/domain/role-scope.ts — `roleScopeFromEnv(env, { scratch })`.
- src/adapters/backend.ts — `BackendAdapter.interrupt?` (160). src/adapters/opencode/index.ts — `opencodeApi(method, path)` (49, `opencode api <method> <path>`), `interrupt` (317). test/sim/opencode — the `api` routes; test/sim/sim-scenarios.ts — `OpencodeScenario`.
- src/services/dispatches.ts — `readThread(dir)`, `roleDir(run, name)`. src/services/run-events-store.ts — `replayRun`. src/infra/filelock.ts — `withFileLockSync`. src/infra/store.ts — `appendPrivate`.
- src/domain/profile.ts — `DEFAULT_MAX_EFFORT` (233, has `cursor:claude-opus-5-5`), `migrateProfileDoc` (451, run on every profile by `migrateProfiles` in src/services/profile-service.ts:81, notes logged as `profile.migrated`).
- Cursor: src/adapters/cursor/ (index, events, models, home), src/adapters/all.ts, src/domain/ids.ts `ADAPTER_IDS` (15), src/domain/catalog.ts `BILLING_KEYS`, `MODEL_KEYS` (10, 14), src/domain/cost.ts (15), src/domain/run-graph.ts (141), src/services/capture.ts (`AUTO`, three cases), src/services/gate-env.ts (`CURSOR_CONFIG_DIR`, `CURSOR_DATA_DIR`), catalog/models.json (13 entries), README.md (§ Cursor, the backend list, `CURSOR_API_KEY`), plugin/skills/catherd-setup/SKILL.md, docs/dev/live-verification.md, CLAUDE.md ("Cursor stays"). 2.0 removed Grok Build and Antigravity in 060e3206 (a profile naming one failed `profile validate`; MIGRATION.md "Grok Build and Antigravity are removed").
- T3 Code (MIT, github.com/pingdotgg/t3code): apps/server/src/mcp/toolkits/orchestrator/tools.ts (`t3_thread_send` with `mode: auto|queue|steer|restart`, `t3_thread_read` with small `limit`/`maxCharsPerItem` and `afterPosition` paging, `t3_thread_wait` with `timeoutMs`), packages/provider-opencode/src/server/v2/adapter.ts (`supportsActiveSteering: true`; a steer is `client.session.prompt({ sessionID, id, text, delivery: "steer" })`). The opencode v2.1.2 binary lists the routes `/api/session/:sessionID/prompt` and `/api/session/:sessionID/inbox`.

## Contracts

```ts
// src/domain/blocked.ts (Task 4)
export const STOP_REASONS = ["needs_user", "too_hard", "provider_error", "no_access", "check_broken"] as const;
// parseBlockedReason reads STOP_REASONS only; BLOCKED_LINE lists them; VERDICT_OPTIONS.stop = [...STOP_REASONS, "other"]

// src/domain/plan-doc.ts (Task 3)
export const PROCESS_LINE: RegExp; // an A-line about commit subjects or history, test-first evidence, or file scope

// src/services/team.ts (Task 2)
export interface TeamMessage { n: number; at: string; from: string; to: string; text: string }
export const TEAM_FILE = "team.jsonl"; // in the run folder, one JSON line per message, 0600
export function teamMessages(run: Run): TeamMessage[]; // a torn line is skipped
export async function teamSend(
  i: { run: string; from: string; to: string; text: string }, // to: a lane id, a role, a dispatch name, or "all"
  o?: { steer?: (backend: string, thread: string, text: string) => Promise<boolean> },
): Promise<{ n: number; delivery: "steered" | "queued" }>;
export function teamRead(i: { run: string; since?: number; limit?: number; maxChars?: number }): {
  messages: TeamMessage[]; next: number | null }; // limit 1–20 (10), maxChars 1–2000 (500), cut ends in "…"
export async function teamWait(
  i: { run: string; lane: string; timeoutMs?: number; since?: number }, // timeoutMs 0–300000 (60000)
  o?: { pollMs?: number },
): Promise<{ lane: string; status: string; timedOut: boolean; posted: TeamMessage[] }>;
export function teamFor(run: Run, d: { name: string; unit: string; role: string; since: string | null }): string[];
// lines "- #<n> <from> → <to>: <text, cut at 500>", the last 10 sent to the name, unit, role or "all", by others, after `since`

// src/adapters/backend.ts (Task 2)
// BackendAdapter += steer?(thread: string, text: string): Promise<boolean>; // only opencode has it

// src/domain/role-tools.ts (Task 2)
// worker, writer += "team_send", "team_read", "team_wait"; architect += "team_send", "team_read"
// CLI forms (src/domain/brief.ts cliForm): catherd team send <run> --to <lane|role|all> (the message on stdin);
//   catherd team read <run> [--since <n>] [--limit <n>]; catherd team wait <run> --lane <lane> [--timeout-ms <ms>]
```

## Rulings

Each is `Ruling: <what> — <why> — <cost if wrong>`. They bind every task; the owner's decisions above bind them.

- R1 — Ruling: Owns is a hint. The test guard, the `Restore these test files` note and `out_of_scope` go; Owns still splits the work, schedules it (admission's `E_ADMIT_OVERLAP` and the machine's `clash` keep two lanes whose declared Owns overlap from running at once) and tells a refusal from work. Two lanes that edit one undeclared file at the same moment get no lock: the change notice on the team channel and the reviewer's outside-files list handle it (owner: "let them talk to each other") — the cheapest answer to a rare case, at the cost that a lost hunk is found by the fast check or the reviewer, one fix round later, not prevented.
- R2 — Ruling: PR #103's sibling attribution stays as it is in `splitChanges` (a path a running sibling owns is not the lane's violation); with the guard gone it only shapes the reviewer's outside-files list — no code of #103 is reverted — a file a sibling owns and this lane edited is listed under neither lane, and the reviewer reads it in the diff anyway.
- R3 — Ruling: `out_of_scope` stays in `BLOCKED_REASONS` (the event schema, `PARK_REASONS` and the panel's generated types), and `laneStopped` keeps its old branch for replay; no role is offered it, `parseBlockedReason` and the classifier do not return it — a reply that still says `out_of_scope` is classified like any unexplained stop — one reason more in the schema than any role can give.
- R4 — Ruling: `foreignFailure` and the fast check's failure handling do not change; a failure in a file no lane owns is the worker's to fix, and the brief says so — with the walls gone the measured P5/P8 lint-in-other-files blocks are a worker fixing a format error, not a stop — a worker that cannot fix another lane's half-written file stops `check_broken` naming it and waits (R5). Pre-existing failures in a fast check are not detected (the milestone Check has baselines; the fast check never had).
- R5 — Ruling: a lane waits for the sibling its stop names when the stop is `check_broken`, a `partial` reply, or a `blocked` reply whose reason is not named; `endedEvent` computes `siblings` for every blocked or partial lane reply. The P6 M50.L3 run (6 dispatches in 3 minutes) is not on this machine, so its log could not be read; in the code, `waitForSiblings` (plan 40) already holds a `check_broken` stop that names a sibling's file, while a partial reply and an unparsed blocked reason went straight to `failedOn` and a fresh dispatch: those are the spinning paths this fixes — if P6's lane named the sibling only by a symbol (`settings.Operator`) and no file, no path catches it; the brief now tells the worker to name the file and use `catherd team wait`.
- R6 — Ruling: no plan lint for "a lane uses a name another lane creates" or "a fast check builds from HEAD"; both go into the architect's brief and the lane header — the owner allows lint only where it removes a measured round trip, and neither is cheaply detectable (`tooling/acceptance.sh` hides its `git archive`) — the architect may still miss an `After:` line; the sibling wait (R5) then bounds the cost.
- R7 — Ruling: a process A-line (`PROCESS_LINE`: commit subject, message, title or history; in its own commit; red run, red evidence, red before, failed before, before the code; TDD; tests first; "<the diff|change|milestone|lane|work> must/may/should not touch|change|modify|edit"; "touches/changes/modifies only") is judged by no one: `uncoveredALines` and `roleALines` drop it, so the verifier never gets it (a milestone left with only process lines is `checkOnly`) and no worker reads it; plan lint's existing commit-history warning becomes the process warning, still advice only. Behavioural lines that merely mention files ("the CLI does not modify files outside the target directory") do not match — a regex can still drop a real line phrased like a scope rule; the reviewer still reads every A-line of the milestone.
- R8 — Ruling: the team channel is a run file (`team.jsonl`), three tools named after T3 Code's (`team_send`, `team_read`, `team_wait`, MIT, THIRD_PARTY_NOTICES.md) on catherd's own role server and CLI, and the daemon's brief of every dispatch carries the messages sent to it since its last start (T3's `queue`). Between lanes a message is always `queued`; only the architect (`architect`, `architect-*`) and the owner (a CLI with no role scope) `steer` — owner decision from the CooperBench evidence — a lane that never calls `team_read` sees a sibling's notice only on its next dispatch.
- R9 — Ruling: live steering is in scope for opencode only: `steer(thread, text)` is `opencode api POST /api/session/<id>/prompt -d '{"text":…,"delivery":"steer"}'`, the shape T3 Code's opencode v2 adapter sends through its SDK; a failed call returns false and the message stays queued. Claude Code (`claude -p --input-format stream-json` with stdin held open by the supervisor) and Codex (`codex app-server` instead of `codex exec`) need a long-lived session per role and a supervisor change: a named follow-up in ideas.md, about a plan each — the body shape is inferred, not verified against a live service: docs/dev/live-verification.md gets the check; until it passes, an architect's steer on opencode may silently fall back to the queue.
- R10 — Ruling: `team_wait` polls `replayRun` and `team.jsonl` once a second inside the caller's tool call, up to 300 s — the lightest wait on today's stack — a worker that waits the full 300 s holds its turn; the brief tells it to end blocked `check_broken` instead when the sibling's code is still not there.
- R11 — Ruling: the architect is free mid-run. `coverageProblems` (a lane must name a resolvable task, a named task needs a signature or a test), the preflight refusal built on it, the `Test:`-line and `### Task`-heading checks of `depthProblems`, `restatedALine`, and the mid-run re-approval (`changedDecisions`, `reapprovalQuestion`, `widenedAfter`) are deleted. What stays: the owner's one approval of an architect-written plan before any code (its three sections and the rejected alternative per decision, checked only while the run is `planning`), and the A-line checks that keep every acceptance line judged (owner tag, a milestone for each) — they protect the product, not the process. A task the architect adds mid-run lives in its lane file's body — a bad mid-run plan is not stopped by catherd; the reviewer and the Check are the gate.
- R12 — Ruling: the decision model's fallback is the smallest level k with P(difficulty ≤ k) ≥ `minConfidence`, summed from the bottom (owner); the probe fixture's expected levels move from 2, 2, 1, 0 to 3, 3, 2, 1 — the measured share of level-0 picks was architect 100 %, ui-reviewer 100 %, judge 90 %, reviewer 79 %, worker 35 % — more dispatches start on stronger, dearer rungs.
- R13 — Ruling: a red milestone Check gives at most 5 findings per item (was 20), each naming at most 3 of the files its line was seen in (P8 worker-M1.L5: 46 bullets, 81 KB, one root cause); the whole log stays in the check record and the fix brief's failing-check tail — a second independent failure past the fifth line waits one round.
- R14 — Ruling: Cursor retires the way 2.0 retired Grok Build and Antigravity (git keeps it), except for the profile: the brief asked that a profile naming Cursor load cleanly, so `migrateProfileDoc` drops each Cursor rung, failover entry, `billing.cursor`, `harness.cursor` and `maxEffort` key with a note (a role whose only rung was Cursor's takes its default), where 2.0 made such a profile fail `profile validate`. Old runs' records keep their `cursor:` rungs and are read through `tryParseRung` (null) — a Cursor user's role silently moves to its default rungs, logged once as `profile.migrated`.
- R15 — Ruling: the changeset is `minor` for `catherd-cli`: the behaviour changes are loosening, old runs and profiles load, and Cursor retires "for now" with a migration — removing a backend is breaking for a Cursor user; MIGRATION.md says so in its own section.
- R16 — Ruling: dropped from this plan by the owner (the redesign replaces the per-milestone verifier and the judge): the verifier dispatched beside the milestone Check, and the review-finding dedupe (`reviewer-M-2` re-reporting, re-raised dismissed findings). Both go to ideas.md as superseded, with their evidence — P8's 282 idle minutes while the Check ran, and P8 M3's duplicate round, stay unfixed until the redesign.

## Parallelism

- M1: L1, L2, L3, L4 at once; L5 after L1 (run-effects.ts); L6 after L4 (decision.ts). Critical path L1 → L5.
- M2 (after M1): L1.
- M3 (after M2): L1, alone (the owner asked for Cursor in its own wave).
- M4 (after M3): L1.

## M1 — No walls, a team channel, gates that judge the product

A1 — a lane that edits a test or any file outside its Owns keeps its thread and goes to its fast check; no brief says "Restore these test files" (Check).
A2 — a `check_broken`, `partial` or reason-less `blocked` lane stop that names a sibling not done yet waits for it (Check).
A3 — `team_send`, `team_read` and `team_wait` work from the CLI and the role server, a lane's message is queued, the architect's and the owner's steer a running opencode lane, and every dispatch's brief carries the messages sent to it (Check).
A4 — no verifier or worker reads an A-line about commit messages, test-first evidence or file scope (Check).
A5 — no role contract tells a worker to stay in its files, offers `out_of_scope`, or asks a gate to judge process (Check).
A6 — a red Check gives at most 5 findings per item, each naming at most 3 files (Check).
A7 — the decision model's fallback picks the smallest level with P(≤ k) ≥ min (Check).

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 1: Lane ends: no test guard, and a stop that names a sibling waits for it

Files: src/domain/run-state.ts, src/services/run-effects.ts, src/domain/run-events.ts, src/domain/test-guard.ts (delete), test/domain/test-guard.test.ts (delete), test/domain/run-fixtures.ts, test/domain/run-state.test.ts, test/services/run-effects.test.ts

Delete the guard block in `onEnded` (run-state.ts 1133–1140), the `guardedEdits` import and `testEdits` in `endedEvent`, and test-guard.ts with its test. `testEdits` stays in the `dispatch.ended` schema, its comment "plan 44 D11, read by no one since plan 45 (Owns is a hint): kept so older lines still parse". In `endedEvent`, `siblings` is computed for every lane reply whose `replyStatus` is `blocked`, `refused` or `partial` (was: only `reason === "check_broken"`); `foreign` is unchanged. In `laneEnded`, the sibling wait runs when `reason === "check_broken"`, or when `reason === null` and the end is `ok` with `replyStatus` `partial` or `blocked`:

```ts
const short = x.status === "ok" && (x.replyStatus === "partial" || x.replyStatus === "blocked");
if ((reason === "check_broken" || (reason === null && short)) && waitForSiblings(s, l, x.siblings)) {
```

`endDispatch` in run-fixtures.ts takes `siblings?: string[]` and passes it on.

- [ ] Write the tests; run `bun test test/domain/run-state.test.ts test/services/run-effects.test.ts`: the three below fail.

Test: test/domain/run-state.test.ts — "a lane that edited a test outside its Owns keeps its thread and goes to its check" (replaces "a lane that edited a foreign test file is sent back") — an end with `testEdits: ["test/b.test.ts"]` → lane `{ status: "checking", thread: "t-1", notes: [] }`, no `floors["worker-M1.L1"]`.
Test: test/domain/run-state.test.ts — "a partial or unexplained stop that names a running sibling waits for it, keeping its thread" — plan `independent`, M1.L2 running; M1.L1 ends `partial` with `siblings: ["M1.L2"]` → `{ status: "checking", waitOn: ["M1.L2"], thread: "t-1" }` and no floor; a `blocked` end with `reason: null` then `stop.classified { reason: null }` → the same wait.
Test: test/services/run-effects.test.ts — "a lane end never names test edits: files outside the Owns are the reviewer's to read" (replaces "a lane end names its foreign test edits") — `violations: ["test/b.test.ts", "docs/x.md"]` → no `testEdits` property.
Test: test/services/run-effects.test.ts — "a partial lane end names the sibling lanes its reply names" — lanes M1.L1 (`src/a.ts`), M1.L2 (`src/b.ts`), a partial reply naming `src/b.ts` → `{ reason: null, foreign: [], siblings: ["M1.L2"] }`.

- [ ] Implement; the same command passes; `bun run typecheck && bun run lint`.
- [ ] Commit: `feat(run): owns is a hint, and a stop that names a sibling waits for it`

### Task 2: The team channel, and the outside-files report

Files: src/services/team.ts (new), src/domain/role-tools.ts, src/domain/brief.ts, src/entry/role-cli-command.ts, src/cli.ts, src/entry/mcp/role-server.ts, src/adapters/backend.ts, src/adapters/opencode/index.ts, src/services/run-briefs.ts, THIRD_PARTY_NOTICES.md, test/services/team.test.ts (new), test/sim/opencode, test/sim/sim-scenarios.ts, test/adapters/opencode-session.test.ts, test/entry/role-mcp.test.ts, test/domain/brief.test.ts, test/services/run-briefs.test.ts

team.ts per Contracts. `teamSend` trims the text to one line (whitespace runs to one space, at most 2 000 characters), refuses an empty text or a target that is not `all` and not an `ID_PATTERN` id (or holds `..`) with `E_INPUT_INVALID`, numbers the message under `withFileLockSync(team.jsonl)` and appends it with `appendPrivate`. It returns `queued` unless the sender steers (`owner`, `architect`, or a name starting `architect-`) and the target is a lane whose state is `running`; then it finds that lane's live dispatch in `replayRun(run).dispatches` (`lane === to`, `ended === null`), its thread (`readThread(join(roleDir(run, name), dispatchId)) ?? dispatch.thread`) and backend (`tryParseRung(rung).backend`), and calls `o.steer ?? steerVia` with `` `${from} (catherd team #${n}): ${text}` ``; `steerVia` is `adapterFor(backend)?.steer?.(thread, text)`, false on a throw. `teamWait` throws `E_INPUT_INVALID` for a lane the run does not have, returns at once when the lane is not `running` or a sender whose name ends `-<lane>` posted after `since` (default: the count when the wait began), else polls every `pollMs` (1 000) until `timeoutMs`. The file's doc comment names the T3 Code origin.

The opencode adapter's `opencodeApi(method, path, body?)` passes `-d <JSON>` when a body is given; `steer` is

```ts
async function steer(thread: string, text: string): Promise<boolean> {
  return (await opencodeApi("POST", `/api/session/${thread}/prompt`, { text, delivery: "steer" })) !== null;
}
```

registered as `steer: (thread, text) => steer(thread, text)` beside `interrupt`. The sim answers `POST /api/session/<id>/prompt` with `{"data":{"id":"msg_sim"}}` and appends `<id>\t<body>` to `steersTo`.

Role tools and CLI forms per Contracts. `catherd team send|read|wait` lives in role-cli-command.ts as `teamCommand` (each subcommand calls `assertRoleMay(scope(), run, "<tool>")`; `from` is the role scope's name, else `owner`), registered in src/cli.ts as `team`. The role server registers each team tool when `roleMcpTools` lists it, `from` = `roleScopeFromEnv(process.env, { scratch: true })?.name ?? context.role`, with these descriptions:

- team_send: "Send one short message to a lane of your run (M1.L2), a role (architect), or all: what you changed that others use (file, what, why), or a question for the architect. It is queued: the target reads it with team_read, and its next brief carries it. The architect's and the owner's messages reach a running lane at once where its backend allows."
- team_read: "Read your run's team messages. Keep reads small: low `limit` (1 to 20) and `maxChars`. Page with `since=next`."
- team_wait: "Wait until a lane stops running or posts a message. A lane that is not running: at once. On timeout (`timeoutMs`, up to 300000), go on with your work or call again."

role-cli-command.ts and role-server.ts import `../adapters/all.ts` so the steer finds the opencode adapter.

run-briefs.ts: `briefFor` appends, after the round and before the owner's answers, `Your team sent you these (catherd team read for the rest):\n<teamFor lines>` when there are any, `since` the `startedAt` of the latest dispatch with this name. `LANE_HEADER`'s last line "Two lanes of one milestone never own the same file." becomes three lines:

- "Owns is a hint, not a wall: it splits the work and schedules it (two lanes whose Owns overlap never run at the same time), and a worker changes whatever its task needs and reports each file outside its Owns. Give each file to one lane."
- "A lane that uses a name another lane of its milestone creates names that lane on its After: line."
- "A fast check tests the working tree, never a build from the committed HEAD (git archive, an image built from a commit): workers do not commit, so such a command goes in the milestone's Check."

`reviewPlan`'s heading becomes "Files changed outside their lane's Owns, with each worker's reason; such a change is no finding by itself:".

THIRD_PARTY_NOTICES.md gains, before the Bifrost section, "## T3 Code by T3 Tools Inc., MIT, https://github.com/pingdotgg/t3code, tool contract ported (not synced)": one paragraph naming src/services/team.ts and the three tools, what was ported (names, parameter shapes, `auto` delivery, small paged reads, a wait with a timeout, the opencode `delivery: "steer"` prompt), and the MIT text with "Copyright (c) 2026 T3 Tools Inc.".

- [ ] Write the tests; run `bun test test/services/team.test.ts test/adapters/opencode-session.test.ts test/entry/role-mcp.test.ts test/domain/brief.test.ts test/services/run-briefs.test.ts`: the new and changed tests fail.

Test: test/services/team.test.ts — a fixture run (events `run.started`, `plan.ready` with lanes M1.L3 and M1.L4, a `dispatch.started` per running lane with thread `ses_<lane>` on `codex:gpt-6-sol#high`):
- "team_send numbers each message and queues it between lanes, running or not" — L3 → L4 (running) `{ n: 1, delivery: "queued" }`; L4 → L3 `{ n: 2, delivery: "queued" }`; → all `{ n: 3 }`; an empty text and the target `../etc` reject with `E_INPUT_INVALID`.
- "only the architect and the owner steer a running lane mid-turn; a lane's message is queued" — with a fake `steer` returning true: from `worker-M1.L3` → `queued`, from `architect-M1-1` → `steered`, from `owner` → `steered`; the fake saw `["codex", "ses_M1.L4", "architect-M1-1 (catherd team #2): use Operator"]` and the owner's, nothing for the worker.
- "team_read pages small: since, limit and a per-message cut" — four messages; `limit: 3, maxChars: 10` → n 1–3, the first text `note 1 xxx…`, `next: 3`; `since: 3` → n 4, `next: null`.
- "team_wait returns at once for a lane that is not running, and times out on one that is" — `timeoutMs: 0`: M1.L3 → `{ status: "pending", timedOut: false }`; M1.L4 → `{ status: "running", timedOut: true, posted: [] }`; after `worker-M1.L4` sends, `since: 0` → `{ timedOut: false, posted: [{ n: 1, from: "worker-M1.L4" }] }`; lane M9.L1 rejects `E_INPUT_INVALID`.
- "a dispatch's brief carries the messages sent to it, its role or everyone, after its last start" — `teamFor(run, { name: "worker-M1.L3", unit: "M1.L3", role: "worker", since: null })` → the lines `worker-M1.L4 → M1.L3: for L3` and `worker-M1.L4 → all: for all`, not the reviewer's, not its own; `since` in 2999 → `[]`.
Test: test/adapters/opencode-session.test.ts — "steers a team message into the running session, and says false when the service fails (plan 45)" — sim with `steersTo` → `steer(SES, "worker-M1.L4: Operator is in")` is true and the file holds `` `${SES}\t${JSON.stringify({ text, delivery: "steer" })}\n` ``; with `apiFails` → false.
Test: test/entry/role-mcp.test.ts — "exposes only each role's allowed tools" — worker gains `team_send`, `team_read`, `team_wait`; architect gains `team_send`, `team_read`.
Test: test/domain/brief.test.ts — the worker's commands line ends `catherd knowledge show; catherd team send ${RUN} --to <lane|role|all> (the message on stdin); catherd team read ${RUN} [--since <n>] [--limit <n>]; catherd team wait ${RUN} --lane <lane> [--timeout-ms <ms>].`
Test: test/services/run-briefs.test.ts — "a worker's brief carries the team messages sent to it since its last start" — `Your team sent you these (catherd team read for the rest):\n- #1 worker-M1.L2 → M1.L1: Operator is in src/b/settings.ts`, not the verifier's message; "the architect's brief carries the questions sent to it" — `- #1 worker-M1.L1 → architect: Task 3 needs a field Operator: whose lane?`; "the lane header says Owns is a hint and names the After and fast-check rules" — the three lines, not "Two lanes of one milestone never own the same file."; the reviewer test's heading assertion becomes the new heading.

- [ ] Implement; the same command passes; `bun run typecheck && bun run lint && bun test test/architecture.test.ts`.
- [ ] Commit: `feat(team): a team channel between a run's roles, ported from t3 code's thread tools`

### Task 3: Process A-lines are judged by no one

Files: src/domain/plan-doc.ts, src/domain/plan-lint.ts, src/services/plan-input.ts, test/domain/plan-lint.test.ts, test/services/plan-input.test.ts, test/services/preflight.test.ts

```ts
export const PROCESS_LINE =
  /\bcommit (?:subject|message|title)s?\b|\bcommit history\b|\bin its own commit\b|\balone in (?:its|a) commit\b|\bred (?:run|evidence)\b|\bred before\b|\bbefore (?:the|its) (?:code|implementation)\b|\bfailed before\b|\bTDD\b|\btests? (?:written )?first\b|\b(?:diff|change|milestone|lane|work)\b[^.]{0,40}?\b(?:must|may|should) not (?:touch|change|modify|edit)\b|\b(?:touches|changes|modifies) only\b/i;
```

`HISTORY` in plan-lint.ts goes; `lintPlan` warns with `PROCESS_LINE`: `${milestone}: ${id} is about process (${words}), not the product: no gate judges it`. `uncoveredALines` also drops `PROCESS_LINE` lines; `roleALines` (milestone branch) too.

- [ ] Write the tests; run `bun test test/domain/plan-lint.test.ts test/services/plan-input.test.ts test/services/preflight.test.ts`: they fail.

Test: test/domain/plan-lint.test.ts — the three existing history assertions read the new warning (`M1: A8 is about process (failed before), not the product: no gate judges it`, `(TDD)` twice); new "commit subjects, red evidence and file-scope lines are process; behaviour is not" — lines A1 "each commit subject reads exactly `feat(kit): add pin`", A2 "red evidence: the new tests fail before the implementation", A3 "this diff may not touch files outside packages/kit", A4 "the CLI does not modify files outside the target directory", A5 "`bun test` passes" → warnings for A1 (`commit subject`), A2 (`red evidence`), A3 (`diff may not touch`) only.
Test: test/services/plan-input.test.ts — "uncoveredALines leaves process lines to no one" — A1 x, A2 commit subject, A3 red evidence → `["A1 — x"]`; "no role reads a process line among its A-lines" — `roleALines(run, "worker", "M1.L1")` → `["A1 — x"]`.
Test: test/services/preflight.test.ts:420 — the plan's lint line reads `M1: A1 is about process (failed before), not the product: no gate judges it`.

- [ ] Implement; the same command passes.
- [ ] Commit: `feat(plan): no gate judges an a-line about process`

### Task 4: Contracts without walls or process audits

Files: src/domain/role-prompts.ts, src/domain/blocked.ts, src/domain/decision.ts, test/domain/verifier-prompt.test.ts, test/domain/blocked.test.ts

blocked.ts: `STOP_REASONS` per Contracts; `parseBlockedReason` finds in `STOP_REASONS`; `BLOCKED_LINE` drops `out_of_scope (…)` and its `check_broken` reads "check_broken (the check cannot pass for a reason outside your task, such as a sibling's code that is not there yet; name each failing file:line)". decision.ts: `VERDICT_OPTIONS.stop = [...STOP_REASONS, "other"]`.

role-prompts.ts, exact copy:

- `WORKER_REPLY`: after "…never commit to get them to run." insert "When your fast check itself builds from HEAD, do not run it: say so, and report STATUS: complete for your part."; "Name each file outside your lane that you had to change on a line of its own: EXTRA: <path> — <why>." becomes "End with your report of each file you changed outside your lane's Owns, one line each with its reason: EXTRA: <path> — <why>."
- worker, line 1: "…the lane file to read, the files your lane is expected to change (its Owns), and your fast check."
- worker: "Change only the files you own. Run your fast check until it passes." becomes "Your lane's Owns is where its work is expected, not a wall: change whatever your task needs, anywhere, and fix what your change breaks in any file (a test, a caller, a lint or format error). Run your fast check until it passes."
- worker: "When a check cannot pass for a reason outside your lane, stop and reply blocked with that reason." becomes "A check that fails for a reason your work did not cause and you cannot fix plainly (a sibling's code that is not there yet, a broken environment): stop and reply blocked with that reason."
- worker: the EXTRA paragraph ("When your lane cannot build without a change to a file it does not own…") becomes "Your sibling lanes work in the same tree at the same time. Read your team's messages with catherd team read <run> when you start and before you change a file outside your Owns. When you finish a change others use (a name, a signature, a moved file), send a short notice: catherd team send <run> --to all, the message on stdin, as `changed <what> in <file>: <why>`. Send a question about the plan to the architect (--to architect). Messages wait in the target's queue; none interrupts a running worker. To wait for a sibling's code, use catherd team wait <run> --lane <lane>; when it is still not there, end blocked with check_broken naming its file, and catherd runs you again once that sibling is done."
- worker fix round: "A finding about commit messages, trailers or branch history, or about work this milestone never owned (a stale diff: another milestone landed meanwhile), is not yours: reject it. Change only the files the findings name, plus their tests." becomes "A finding about work this milestone never owned (a stale diff: another milestone landed meanwhile) is not yours: reject it."
- verifier: the "An acceptance line is judged from the tree only when…" line becomes "Judge the product, never the process: a line about commit messages or history, the order of the work (tests first, a red run) or which files a change touched is not yours to FAIL; report it `A<n> PASS — process, not judged`. An acceptance line is judged from the tree only when it is about the tree itself (a submodule pin, a file's contents); every other line needs a RAN line."
- reviewer: append to the "Rules that come from your own tool…" line: " Neither is the order of the work (tests first). A file changed outside its lane's Owns is no finding by itself: judge the change, with the reason its worker gave."
- architect: after the plan-files paragraph, a new paragraph "Acceptance lines are about the product: what it does, through its entry points. Never write one about commit messages or history (catherd writes the commits), the order of the work (tests first, a red run), or which files a change may touch (the reviewer reads every changed file): no gate judges such a line."; the lane item "the files it owns (two lanes of one milestone never share a file);" becomes "the files it is expected to change, its Owns: a hint for splitting and scheduling the work, not a wall (two lanes whose Owns overlap never run at the same time, so give each file to one lane);"; the fast-check item gains "It tests the working tree: a command that builds from the committed HEAD (git archive, an image built from a commit) goes in the milestone's Check, never in a fast check, since workers do not commit."; "8. Out of scope: what no worker may touch." becomes "8. Out of scope: what this work does not deliver."; the lane-file sentence "…the decisions and edge cases it relies on (copied, not referenced), and the out-of-scope lines." becomes "…the decisions and edge cases it relies on (copied, not referenced). Never copy execution rules (test-first steps, cleanup or lock rituals) or out-of-scope lists into a lane file: workers follow the repository's own rules and change what their task needs."; the `After:` clause reads "when the lane compiles against another lane's changes, such as a type, field or function another lane of the milestone creates (catherd dispatches it only once those finish)".

- [ ] Write the tests; run `bun test test/domain/verifier-prompt.test.ts test/domain/blocked.test.ts`: they fail.

Test: test/domain/verifier-prompt.test.ts — new describe "plan 45: no walls, and gates judge the product": the worker prompt contains none of "Change only the files you own", "Change only the files the findings name", "commit messages, trailers or branch history", "the files you must not touch", and contains "Your lane's Owns is where its work is expected, not a wall", "catherd team read", "as `changed <what> in <file>: <why>`", "--to architect", "When your fast check itself builds from HEAD", "EXTRA: <path> — <why>"; the verifier's has no "commit history" and has "Judge the product, never the process"; the architect's has no "what no worker may touch" and has "Never write one about commit messages" and "Never copy execution rules"; the reviewer's has "A file changed outside its lane's Owns is no finding by itself". The existing "judges from the tree only the lines about the tree" asserts "(a submodule pin, a file's contents)".
Test: test/domain/blocked.test.ts — "lists the five reasons a role may give in the prompt line, in order, and no out_of_scope" — `STOP_REASONS` in order in `BLOCKED_LINE`; no `out_of_scope` in it; `parseBlockedReason("out_of_scope: needs src/x.ts")` is null; `BLOCKED_REASONS` still has `out_of_scope`.

- [ ] Implement; the same command passes, and `bun test test/domain test/services/dispatch-protocol.test.ts test/skills.test.ts test/plugin.test.ts`.
- [ ] Commit: `feat(briefs): contracts with no walls and no process audits`

### Task 5: A red Check gives lean findings

Files: src/services/run-effects.ts, test/services/run-effects.test.ts

`FINDINGS_PER_ITEM = 5`; a new `FILES_PER_FINDING = 3` (doc: "plan 45: a finding names this many of the files its line was seen in; one root cause showed in dozens"); the finding text is `` `${item}` fails: ${line}${of.length ? ` — in ${of.slice(0, FILES_PER_FINDING).join(", ")}` : ""} ``.

- [ ] Write the test; `bun test test/services/run-effects.test.ts -t "at most 5 findings"` fails.

Test: test/services/run-effects.test.ts — "a red check gives at most 5 findings an item, each naming at most 3 files" — `stubCheck` with 8 failing lines, each in `test/a…e.test.ts` → 5 findings, the first `` `bun test` fails: (fail) case 0 — in test/a.test.ts, test/b.test.ts, test/c.test.ts ``.

- [ ] Implement; `bun test test/services/run-effects.test.ts` passes.
- [ ] Commit: `fix(check): a red check gives the fix round five lean findings per item`

### Task 6: The decision model picks the level that is enough

Files: src/domain/decision.ts, docs/specs/2026-10-26-decision-model-design.md, test/domain/decision.test.ts, test/fixtures/decision/probe-states.json

`pickLevel`'s fallback sums from the bottom; the rule string is `P(≤k)`:

```ts
let sum = 0;
for (let k = 0; k < n && !pick; k++) {
  sum = round6(sum + p(k));
  if (sum >= min) pick = { level: k, p: sum, rule: `P(≤${k}) ${sum} ≥ ${min}` };
}
```

The doc comment and the spec ("The questions", ~line 135) read: "When none is, catherd takes the lowest level k that is enough with probability at least the bar: the smallest k with P(difficulty ≤ k) ≥ the bar, summed from the bottom (plan 45; it summed from the top before, which picked the optimistic low end)." In probe-states.json change only the four `expected` values (lines 8, 31, 54, 77) to 3, 3, 2, 1; do not reformat the file.

- [ ] Write the test; `bun test test/domain/decision.test.ts` fails.

Test: test/domain/decision.test.ts — "a sure level wins, else the lowest level that is enough with probability min" (replaces "…the cumulative from the top") — the spread `{3: .54, 4: .16, 2: .2, 1: .08, 0: .02}` → `{ level: 3, rule: "P(≤3) 0.84 ≥ 0.8" }`; `{0: .66, 1: .2, 2: .1, 3: .03, 4: .01}` → 1; P8's architect `{0: .42, 1: .58}` on 2 levels → 1; `{1: .85}` → 1; `{1: .1, 2: .7}` → 2; `{}` → 2; one level → 0. "the probe states pick as recorded" passes on the new fixture values.

- [ ] Implement; the same command passes.
- [ ] Commit: `fix(decision): the fallback picks the lowest level that is enough, summed from the bottom`

### M1 lanes

- M1.L1 — Task 1 — owns src/domain/run-state.ts, src/services/run-effects.ts, src/domain/run-events.ts, src/domain/test-guard.ts, test/domain/test-guard.test.ts, test/domain/run-fixtures.ts, test/domain/run-state.test.ts, test/services/run-effects.test.ts — fast check: `bun test test/domain/run-state.test.ts test/services/run-effects.test.ts test/services/writer-attribution.test.ts test/domain/run-events.test.ts && bun run typecheck && bun run lint`
- M1.L2 — Task 2 — owns the files Task 2 lists — fast check: `bun test test/services/team.test.ts test/adapters/opencode-session.test.ts test/entry test/domain/brief.test.ts test/services/run-briefs.test.ts test/architecture.test.ts && bun run typecheck && bun run lint`
- M1.L3 — Task 3 — owns src/domain/plan-doc.ts, src/domain/plan-lint.ts, src/services/plan-input.ts, test/domain/plan-lint.test.ts, test/services/plan-input.test.ts, test/services/preflight.test.ts — fast check: `bun test test/domain/plan-lint.test.ts test/services/plan-input.test.ts test/services/preflight.test.ts && bun run typecheck && bun run lint`
- M1.L4 — Task 4 — owns src/domain/role-prompts.ts, src/domain/blocked.ts, test/domain/verifier-prompt.test.ts, test/domain/blocked.test.ts, and the `stop` line of src/domain/decision.ts — fast check: `bun test test/domain && bun run typecheck && bun run lint`
- M1.L5 — Task 5 — after M1.L1 — owns src/services/run-effects.ts, test/services/run-effects.test.ts — fast check: `bun test test/services/run-effects.test.ts && bun run typecheck`
- M1.L6 — Task 6 — after M1.L4 — owns src/domain/decision.ts, docs/specs/2026-10-26-decision-model-design.md, test/domain/decision.test.ts, test/fixtures/decision/probe-states.json — fast check: `bun test test/domain/decision.test.ts && bun run typecheck`

## M2 — The architect is free mid-run

A1 — a lane with no `Tasks:` line, or one naming a task no plan file has, or a task with no `Test:` line, starts (Check).
A2 — an architect change mid-run (a decision line, a wider `After:`) takes effect with no approval park; the first approval of an architect-written plan stays (Check).
A3 — a lane file may restate an A-line (Check).

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 7: Delete the plan walls

Files: src/domain/plan-doc.ts, src/services/plan-input.ts, src/services/preflight.ts, src/services/run-effects.ts, src/services/run-service.ts, src/domain/lane.ts, src/domain/role-prompts.ts, test/domain/plan-doc.test.ts, test/domain/lane.test.ts, test/domain/run-machine.test.ts, test/domain/verifier-prompt.test.ts, test/services/plan-input.test.ts, test/services/preflight.test.ts, test/services/run-effects.test.ts, test/services/run-files.test.ts

Delete: `coverageProblems` (plan-doc.ts) and the preflight block that calls it (preflight.ts 332–354, with the `planDocs` and `isDaemonRun` imports it alone used); in `depthProblems` the `### Task` heading line and the per-task `Test:` line; `reapprovalQuestion`, `changedDecisions`; `widenedAfter` (run-effects.ts 306) and in `readPlan` everything between the problems check and the end, which becomes `await append({ type: "plan.ready", milestones });` (the `appendEvents` and `planDocs` imports go if unused); `restatedALine` with `RESTATED_WORDS` and `fold` (lane.ts) and its call in `writeRunFile` (run-service.ts 239–243). `planProblems` keeps the untagged and unowned A-line checks, drops coverage, and runs `depthProblems` only when the run has no plan input and `replayRun(run).phase === "planning"`. Its doc: "What the architect must fix before the plan is read: an untagged A-line, an A-line no milestone owns, and, with no plan input and before the owner approved it, plan.md's depth. A lane's tasks are its own business (plan 45)." `readPlan`'s doc: "The architect's plan into `plan.ready`, once nothing in it keeps a milestone from starting. A gap is `effect.failed`: its architect is sent back with it. A change mid-run takes effect with no new approval (plan 45)."

role-prompts.ts (architect): "the run waits for the owner's approval of your plan.md, its one planned stop; after that, a change to a decision line (D<n>) waits for the owner's approval again, so change one only when the code forces it." becomes "the run waits for the owner's approval of your plan.md, its one planned stop. After that you may add, change, split or drop tasks, lanes and milestones whenever the run needs it, with no approval: a task you add lives in its lane file's body, and its Tasks: line may name none. Say what you changed and why."; item 4 drops "A task without a test is refused."; the architect's done-when line (~241) ends "…with no plan given, plan.md has What already exists, Contracts and Decisions." (no "and every task its signatures and a Test: line").

- [ ] Write the tests; run `bun test test/domain/plan-doc.test.ts test/domain/lane.test.ts test/domain/run-machine.test.ts test/domain/verifier-prompt.test.ts test/services/plan-input.test.ts test/services/preflight.test.ts test/services/run-effects.test.ts test/services/run-files.test.ts`: the new and changed tests fail.

Test: test/services/preflight.test.ts — "starts a lane with no task, a task the plan does not have, and a task with no test" (replaces "refuses a lane with no task and a task with neither a signature nor a test, naming each") — M1.L1 with no Tasks (its check touches a marker), M1.L2 with `Tasks: 4, 9203` on a plan whose Task 4 is prose → not blocked, both `pass`, the marker exists. "refuses before the confirm list…" becomes "asks for the confirm list and passes" (the refusal half goes).
Test: test/services/plan-input.test.ts — "asks nothing of a lane's tasks, and plan.md's depth only before the owner approved it" (replaces "lists every lane's coverage problem…") — no-Tasks and `Tasks: 9203` lanes → no problem besides "under no milestone"; a bare plan.md in `planning` → `plan.md has no "## Contracts" section` and no `### Task <n>:` problem; after `plan.ready` and `plan.approved` → no `plan.md` problem.
Test: test/services/run-effects.test.ts — "never parks for approval again: an architect change mid-run takes effect" (replaces "parks again for approval when an architect change edits a decision…") — a decision edit after `plan-approved.md` → the last event is `plan.ready` and no `question.parked`; delete "a plan.md After wider than the owner's plan parks for approval", "keeps first-read dependency approval pending when the owner requests revision" and "compares After to plan-approved.md…"; "fails readPlan with the plan's problems…" expects the message to start `the plan needs: plan.md has no "## What already exists" section` and hold no `Tasks:`.
Test: test/services/run-files.test.ts — "a lane file may restate an A-line: the architect writes what it needs" (replaces "…is refused") — the restating lane is written (`bytes > 0`).
Test: test/domain/verifier-prompt.test.ts — the architect's prompt has no "waits for the owner's approval again" and no "A task without a test is refused", and has "add, change, split or drop tasks, lanes and milestones".
Test: test/domain/plan-doc.test.ts — delete the coverage, `changedDecisions` and `reapprovalQuestion` cases; the depth case expects no `### Task <n>:` heading problem and no `Task 1 has no test` line. test/domain/lane.test.ts — delete the `restatedALine` describe. test/domain/run-machine.test.ts — the re-approval park test parks with `approvalQuestion("r1")`.

- [ ] Implement; the same command passes; `bun run typecheck && bun run lint`.
- [ ] Commit: `feat(plan): the architect changes the plan mid-run with no refusal and no park`

### M2 lanes

- M2.L1 — Task 7 — owns the files Task 7 lists — fast check: `bun test test/domain test/services/plan-input.test.ts test/services/preflight.test.ts test/services/run-effects.test.ts test/services/run-files.test.ts && bun run typecheck && bun run lint`

## M3 — Cursor retires

A1 — no Cursor adapter, rung backend, billing key, capture case or doc section is left; git keeps them (Check).
A2 — a profile that names Cursor loads, its Cursor rungs and keys dropped with a note each (Check).

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 8: Remove the Cursor backend

Files: src/domain/profile.ts, src/adapters/cursor/ (delete), src/adapters/all.ts, src/domain/ids.ts, src/domain/catalog.ts, src/domain/cost.ts, src/domain/run-graph.ts, src/domain/role-tools.ts (comment), src/domain/profile-rules.ts (comment), src/adapters/access.ts, src/adapters/backend.ts (comments), src/services/capture.ts, src/services/gate-env.ts, src/services/doctor-backends.ts (comment), src/entry/role-cli-command.ts (comment), catalog/models.json, README.md, plugin/skills/catherd-setup/SKILL.md, docs/dev/live-verification.md, CLAUDE.md, MIGRATION.md, and the tests: test/adapters/cursor.contract.test.ts, test/adapters/cursor.test.ts, test/adapters/cursor-events.test.ts, test/live/cursor.live.test.ts, test/sim/cursor.test.ts, test/sim/cursor-agent (delete), test/services/cursor-dispatch.test.ts (delete), test/sim/sim-scenarios.ts, test/domain/profile.test.ts, test/domain/ids.test.ts, test/domain/profile-rules.test.ts, test/domain/select.test.ts, test/domain/catalog.test.ts, test/domain/failover.test.ts, test/services/adapter-hooks.test.ts, test/services/admission.test.ts, test/services/budget-backends.test.ts, test/services/gate-env.test.ts, test/services/capture.test.ts, test/services/doctor.test.ts, test/services/doctor-backends.test.ts, test/services/panel-setup.test.ts, test/services/panel-catalog.test.ts, test/services/catalog-service.test.ts, test/services/failover-rungs.test.ts, test/services/transcript.test.ts, test/services/run-effects.test.ts, test/entry/profile-command.test.ts, test/entry/capture-fixtures-command.test.ts, test/timings.json, and every test/fixtures file `rg -il cursor test/fixtures` lists that a test reads only for Cursor

First the migration, with its test red, then the deletion. `migrateProfileDoc` ends with `retireCursor(out, notes)`: for each role whose `rungs` hold a `cursor:` rung, the kept rungs stay with one note per dropped rung, `dropped <rung> from roles.<role>.rungs: Cursor is retired`; a role left with none loses `rungs` with the note `dropped roles.<role>.rungs: its only rung was Cursor's, so the role takes the default`; `failover` entries whose key or value is a `cursor:` rung, `billing.cursor`, `harness.cursor` and `maxEffort` keys starting `cursor:` are deleted, each with `dropped <map>.<key>: Cursor is retired`. `DEFAULT_MAX_EFFORT` loses `cursor:claude-opus-5-5`.

Then delete src/adapters/cursor/ and its registration; `ADAPTER_IDS = ["codex", "claude-code", "opencode"]`; `BILLING_KEYS` and `MODEL_KEYS` lose `cursor`; cost.ts and run-graph.ts lose their `cursor` rows; capture.ts loses `AUTO` and its three Cursor cases; gate-env.ts loses `CURSOR_CONFIG_DIR` and `CURSOR_DATA_DIR`; catalog/models.json loses its Cursor entries; comments that name Cursor as an example name opencode or drop the example. `bun run typecheck` then lists every test to edit: a test that exercises a generic adapter hook under the `cursor` id (test/services/adapter-hooks.test.ts, admission.test.ts, budget-backends.test.ts) moves its fake adapter to the `opencode` id and re-registers `opencodeAdapter` after each test; a test that only covers Cursor goes; an expected id list loses `cursor`; test/domain/ids.test.ts "knows the three backends by their ids, and none of the removed ones" adds `tryParseRung("cursor:auto#default")` → null. Generic hooks that only Cursor used (`isolationKey`) stay: deleting them is the redesign's call.

Docs: README.md drops § Cursor, Cursor from the backend lists and the install list, its `CURSOR_API_KEY` row, and "`opencode` and `cursor` have no output clamp" reads "`opencode` has no output clamp"; the setup skill's harness list loses `cursor`; live-verification.md marks its Cursor sections retired in plan 45; CLAUDE.md's "Cursor stays; Grok Build and Antigravity were removed in 2.0 (git keeps them)." becomes "Cursor was retired on 2026-10-27 (plan 45), as Grok Build and Antigravity were in 2.0; git keeps them."; MIGRATION.md gains, above "Grok Build and Antigravity are removed", "### Cursor is retired (plan 45)": a profile that names a Cursor rung loads with it dropped and a `profile.migrated` note; a role whose only rung was Cursor's takes its default; `CURSOR_API_KEY` is no longer read; old runs keep their records.

- [ ] Write the migration test; `bun test test/domain/profile.test.ts -t "Cursor retired"` fails.

Test: test/domain/profile.test.ts — "Cursor retired (plan 45)" › "a profile that names Cursor loads with its Cursor rungs and keys dropped, each with a note" — worker `["cursor:auto#default", "codex:gpt-6-sol#high"]`, reviewer `["cursor:gpt-6#high"]`, a failover each way, `billing.cursor`, `harness.cursor`, `maxEffort["cursor:claude-opus-5-5"]` → worker `["codex:gpt-6-sol#high"]`, reviewer has no `rungs`, `failover`, `harness`, `maxEffort` are `{}`, `billing` is `{ codex: "plan" }`; the notes hold `dropped cursor:auto#default from roles.worker.rungs: Cursor is retired` and `dropped roles.reviewer.rungs: its only rung was Cursor's, so the role takes the default`; a second migration has no notes. "a fresh default profile carries the shipped effort caps" expects no `cursor:` key.

- [ ] Implement the migration; the test passes. Delete the backend; `bun run typecheck` and the test edits until `bun run typecheck && bun run lint && bun test` pass; `rg -il cursor src catalog plugin README.md` lists only comments that name the retirement.
- [ ] Commit: `feat(backends): retire cursor; a profile that names it drops its cursor rungs`

### M3 lanes

- M3.L1 — Task 8 — owns the files Task 8 lists — fast check: `bun run typecheck && bun run lint && bun test test/domain test/adapters test/services/adapter-hooks.test.ts test/services/admission.test.ts test/services/doctor.test.ts test/services/capture.test.ts`

## M4 — Docs, ideas and the changeset

A1 — README, the 2.0 spec's notes, ideas.md and HANDOFF say what plan 45 changed; the changeset names catherd-cli (Check).

Check: bun install --frozen-lockfile && bun run format:check && grep -q catherd-cli .changeset/plan-45-outcome-gates.md

### Task 9: ideas.md, docs, HANDOFF and the changeset

Files: docs/dev/ideas.md, README.md, docs/specs/2026-10-12-catherd-2.0-design.md, docs/dev/live-verification.md, docs/handoff/HANDOFF.md, .changeset/plan-45-outcome-gates.md

ideas.md — remove the entries this plan did: "A lane misses the tests that pin the behaviour it changes" (run audit 15), "Lanes still break callers no lane owns (run audit 11)", "A re-approval question shows no diff"; "A harness clamp for opencode and cursor" names opencode only. Add "### From plan 45 (outcome gates)": live steering for Claude Code (stream-json input with the supervisor holding stdin, about a plan) and Codex (`codex app-server`, about a plan) (R9); the verifier beside the milestone Check, superseded by the redesign (R16, P8: 282 of 735 min idle while the Check ran); the review-finding dedupe and re-raised dismissed findings, superseded by the redesign (R16, P8 M3, P6 M50/M51/M53); a symbol-only sibling block that names no file (R5); isolation per writer, the redesign's (owner).

README.md — where it describes lanes, Owns and stops: Owns is a hint, a worker reports outside files on `EXTRA:` lines, `out_of_scope` is gone, the team channel (`catherd team send|read|wait`, queued between lanes, the architect and the owner steer opencode), the architect changes the plan mid-run with no re-approval. docs/specs/2026-10-12-catherd-2.0-design.md — a dated note under decisions 3, 8 and 14: plan 45 removed `out_of_scope` and the test guard, and retired Cursor. live-verification.md — a new section: an architect's `catherd team send` to a running opencode lane arrives mid-turn (`delivery: steered`), and the body shape `{text, delivery: "steer"}` is accepted by opencode ≥ 2.1. HANDOFF.md — a row "45 outcome gates | `docs/plans/2026-10-27-45-outcome-gates.md` | written (owner decisions 2026-10-27; review dedupe and the parallel verifier dropped for the redesign)".

The changeset (R15):

```md
---
"catherd-cli": minor
---

Runs stop paying for walls and process. A lane's Owns is a hint: a worker changes whatever its task needs and reports each file outside its Owns on an `EXTRA:` line with its reason, which the reviewer reads; the test guard and the `out_of_scope` stop are gone. A stop that names a sibling's file waits for that sibling instead of being dispatched again. Lanes talk through a team channel (`catherd team send|read|wait`, and the same tools on the role server, after T3 Code's thread tools): messages between lanes are queued, and the architect's and the owner's reach a running opencode lane at once. No gate judges an acceptance line about commit messages, test-first evidence or file scope. The architect may add, change, split or drop tasks, lanes and milestones mid-run with no approval park. A red Check gives at most five findings per item. The decision model's fallback picks the lowest level that is enough, summed from the bottom.

Cursor is retired: a profile that names a Cursor rung loads with it dropped and a note.
```

- [ ] Write the files; `bun run format:check` passes.
- [ ] Commit: `docs: plan 45 in the readme, ideas, handoff and changeset`

### M4 lanes

- M4.L1 — Task 9 — prose — owns the files Task 9 lists — fast check: `bun run format:check && grep -q catherd-cli .changeset/plan-45-outcome-gates.md`

## Edge cases

- A lane whose `testEdits` event comes from a daemon older than this plan: replayed, ignored.
- A `team_send` to `all` from the architect: queued (only a lane target is steered).
- A `team_send` to a lane id the run does not have: written and queued (the id may be a lane the architect adds next).
- `team.jsonl` with a torn last line (a crash mid-append): the line is skipped, the next message numbers after the good ones.
- A steer to an opencode lane whose dispatch has not written `thread.json` yet and started fresh: no thread, queued.
- A `partial` reply that names a sibling already `done`: no wait; the old `failedOn` path runs.
- Two lanes that wait on each other: `waitForSiblings`'s `holdsFor` lets only one wait (plan 40), as before.
- A plan whose every A-line is a process line and whose Check exists: `checkOnly`, no verifier.
- A profile whose `failover` maps a Codex rung to a Cursor rung: the entry goes; the Codex rung has no stand-in until the owner sets one.

## Out of scope

- The verifier beside the milestone Check and the review-finding dedupe (R16), isolation per writer, live steering on Claude Code and Codex (R9): ideas.md, for the redesign.
- Profile and model choices, flaky-test handling, the panel (`web/`), the Check command's own content.
