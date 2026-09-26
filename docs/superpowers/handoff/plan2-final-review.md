# Final whole-branch review: plan 2 (the run service and MCP tools)

- **Range:** 9deaebc..f78dde9 (21 commits, 82 files, +6255/−1958), branch claude/project-analysis-review-xb3fot.
- **Requirements:** plan docs/superpowers/plans/2026-09-25-02-run-service.md; spec §3.1, §3.3–3.5, §4 (including §4.8), §10.1 and §10.4; the rulings in progress.md; git-contract-note.md.
- **Method:** the reviewer template (requesting-code-review/code-reviewer.md). I reviewed the diff myself, in five passes by area:
  1. domain and infra;
  2. services;
  3. entry, MCP and the bridge;
  4. tests;
  5. the plugin and the stamp script.

  For each pass I read the files at HEAD, not only the hunks. Batch reviews A1, A2, B1, B2 and C1 already went line by line, so I spent most of the time on how the tasks fit together and on the items still open.
- **Read-only:** I changed nothing in the repository and did not re-run the suite, as instructed (it is green locally, and the theme test failure is environment-only). I needed no focused test. Each finding below rests on code I read at HEAD, plus the MCP SDK 1.30.1 source for I2.

## Strengths

- **The layers are clean.** The domain layer is pure: routes, budget, hints, change splitting and the state render. Infra is small and has timeouts everywhere. The services depend on ports (`ProfilePort`, `RoutingPort`, `Deps`), and only the entry layer imports the 0.x bridge. The architecture test enforces this. The MCP tools really are thin: each one is `handle(() => service(args))` (src/entry/mcp/*.ts).
- **Admission is correct under concurrency.** Duplicate-name, path-aware overlap, budget, attempt number and the before-snapshot are all checked, and the dispatch made live, under one admission lock (src/services/admission.ts:107-171). The stdio integration test proves it with two parallel overlapping dispatches and two parallel duplicates.
- **Exactly one record per dispatch, by design.** An exclusive `claim`, a waiter that reads the other finalizer's record, takeover of a stale claim after 30 s, and a dedupe in `appendRecord` under the runs.jsonl lock (src/services/finalize.ts:193-208, src/services/run-store.ts:171-180). The test with two restarted servers reconciling one dispatch pins it down.
- **The git contract is sound.** `GitResult` separates `ok`, `failed` and `timed-out` (src/infra/git.ts:7-39). A broken git never reads as a clean tree. `gitUnavailable` on the record suppresses the false `climb: unchanged` hint (src/domain/hints.ts:9-18). The ruling (b) `refreshState` in lane-service keeps the notes even when state.md cannot be rewritten.
- **Liveness is safe against reused pids.** Every liveness check compares the pid and its start time. `launch.json` covers the gap between launch and proc.json, so a supervisor that dies before writing proc.json is finalized as `lost` (src/services/dispatches.ts:94-104).
- **Preflight cannot hang.** A check that detaches a grandchild onto the pipes is drained within 500 ms, then its group is killed, so it can no longer hold a heavy slot forever (src/services/preflight.ts:90-129), and a regression test covers it.
- **The integration test is honest.** T15 found that two restart tests passed without testing anything, and fixed them with a real SIGKILL crash plus "no record yet" assertions (test/integration/mcp-stdio.test.ts:52-62, 250-256, 323-325).
- **Reads stay pure, and corruption is tolerated.** `status`, `summarizeRun` and `runsSummary` write nothing (tree-equality test). A corrupt meta.json becomes a warning, and a torn JSONL tail is skipped and counted.

## Issues

### Critical

None.

### Important

**I1. Every dispatch writes the user's whole environment, secrets included, to a world-readable file. Must fix.**
- **Where:** src/services/admission.ts:153-167 (`env: workerEnv(process.env, plan.env, plan.cwd)` at :159). The file is written by src/infra/store.ts:18-29 (`openSync(tmp, "w")`, mode 0666 minus umask, so usually 0644).
- **What:** spec.json in every dispatch folder holds every env value of the MCP server: `OPENAI_API_KEY`, `GITHUB_TOKEN`, cloud credentials and the like. Only `TYPESAFE_API_KEY` is removed (src/infra/env.ts:2). The file lives under `~/.local/share/catherd/repos/.../roles/<name>/<id>/spec.json` and is kept for good, one copy per dispatch.
- **Why it matters:** §10.4 says secrets never reach logs, and credential files are mode 600. §10.2 says spawns log env keys, never values. On macOS, a home folder is 0755 by default, so any local account can read these files. 0.x never wrote env values to disk, so this is a regression brought in by plan 2.
- **Fix (preferred):** spec.json carries only the overrides (`plan.env` plus `PWD`). `runSupervise` builds the child env as `workerEnv(process.env, spec.env, spec.cwd)`. It already inherits `scrubSecrets(process.env)` from `launchSupervisor` (src/infra/launch.ts:10-22). Update src/entry/supervise.ts:9-22 and the admission test at test/services/admission.test.ts:69-70, and add an assertion that a sentinel env value (for example `FOO_API_KEY=s3cret`) does not appear in spec.json.
- **Fix (minimum):** write spec.json with mode 0600, through a mode option on `writeTextAtomic`, and create dispatch folders as 0700.

**I2. A tool input that fails validation does not come back as `{code, message, fix}`. Must fix (it carries C1's I1).**
- **Where:** every `inputSchema` in src/entry/mcp/*.ts. The MCP SDK (node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:124-160) checks the input before `handle` runs, and on failure returns only the text `MCP error -32602: Input validation error…`, with no `structuredContent`.
- **Why it matters:** §4.8 and §10.1 promise structured errors, and the skill says "Every error is `{ code, message, fix }`" (SKILL.md:59). For example, `land` with `commit: "HEAD"` or an uppercase hash never reaches the service's own E_RUN_COMMIT fix. The same happens with a flag-shaped name or lane, or a bad role or climb reason.
- **Fix, either of these:**
  - In `buildServer` (src/entry/mcp/server.ts:51-58), replace the McpServer's `createToolError`: `(server as unknown as {createToolError: (m: string) => CallToolResult}).createToolError = (m) => fail(new CatherdError(m.includes("Input validation error") ? "E_INPUT_INVALID" : "E_IO_UNEXPECTED", m, {fix: "correct the named argument and call again"}))`. Guard it with a test, so an SDK upgrade that renames the method fails loudly.
  - Or register permissive shapes and parse `z.object(shape).strict()` inside `handle`.
- **Test:** add one to test/entry/mcp.test.ts, for example `dispatch` with `name: "--x"`, expecting `error.code === "E_INPUT_INVALID"` and a non-empty `fix`.

**I3. `cancel`, and the waiting `dispatch`, hang for as long as a worker runs after its supervisor died. Must fix (a plan-1 carry-over plan 2 owns).**
- **Where:**
  - src/services/dispatches.ts:97-100 keeps the state `running` while the worker is alive, even with its supervisor dead.
  - src/services/dispatch-service.ts:180-181 writes the `cancel` file, which only the supervisor reads, and then waits with no bound.
  - The supervisor has no SIGTERM or SIGHUP handler (src/infra/supervisor.ts:95-203). So a `pkill`, an OOM kill or a SIGKILL leaves a worker with no idle or wall timeout, and no one to act on a cancel.
- **Why it matters:** the orchestrator's main thread blocks on `cancel` until the worker exits by itself. The one tool meant to stop a runaway role cannot stop it.
- **Fix:** in `cancel`, when `readProc(live.dir)` shows the supervisor is dead and the worker is alive:
  1. `killGroup(proc.pgid ?? proc.pid, "SIGTERM")`;
  2. wait `KILL_GRACE_MS`;
  3. SIGKILL the group;
  4. write exit.json `{reason: "cancelled", code: null, signal: "SIGTERM"}`;
  5. finalize.

  Test it by SIGKILLing the supervisor of a hanging simulated role and expecting a `cancelled` record within the grace period. The supervisor's own signal handler (set `reason = "lost"` and fall through to `stopGroup`) is cheap and worth doing at the same time, but it can wait for plan 7 (see the triage).

### Minor

- **m1. Must fix, because it is part of the same edit.** src/services/dispatch-service.ts:40-47 and src/services/reconcile.ts:16-23 are the second and third copies of `refreshState`.
  - The dispatch copy loses the `next` note and the §4.5 `paused: <backend> usage limit` note whenever git fails, because `updateState` throws before it writes state.json. lane-service's copy (src/services/lane-service.ts:29-51) keeps the notes.
  - Fix: move lane-service's `refreshState` into src/services/state.ts, and use it in dispatch-service, reconcile, run-service and lane-service. While in dispatch-service, also pass `i.next` into `runToEnd`'s post-launch refresh instead of refreshing before the launch at :87. That removes the window between launch and the next refresh at no extra cost.
- **m2. Must fix, a one-line change.** src/services/dispatch-service.ts:158-163: a successful failover drops the limited run's `violation:` and `git-unavailable` hints. The stand-in's before-snapshot is taken after the limited run's writes, so those violations never surface, and `land` can commit out-of-lane edits unreviewed. Fix: add `...hintsFor(run, d, limited).filter((h) => /^(violation|git-unavailable):/.test(h))` to the success hints.
- m3. src/services/summary.ts:96-101: a run whose runs.jsonl, agents.jsonl or roles folder throws (a newer schema, EACCES) fails the whole `status()`, and `status()` is the skill's mandatory first call. Fix: wrap `summarizeRun` in a try/catch per run and turn a failure into a warning. Plan 7.
- m4. src/services/run-store.ts:123: `readdirSync(runs)` is unguarded, so one unreadable repo folder breaks `listRuns`, and every `findRun` with it. Plan 7.
- m5. src/services/run-store.ts:137-148 and summary.ts:97: every tool call scans every run's meta.json in every repo, and `status()` with no run summarizes every run in every repo. That is fine now and grows linearly. A run id also does not include the repo, so the same title in the same second in two repos collides. Plan 7 (index or scope by repo).
- m6. src/services/admission.ts:175-194: a failed `launch.json` write after a successful `launchSupervisor` marks a live dispatch `lost`. Only a failure of `launchSupervisor` itself should do that. Plan 7.
- m7. src/domain/hints.ts:8: `failed: read <dir>/stderr` points at an empty file when the supervisor itself failed (for example an unparsable spec), because that error is in `supervisor.log`. Mention both files. Plan 7.
- m8. src/entry/mcp/run-tools.ts:78 and src/services/run-service.ts:63-66: `set_next` returns its hint as plain text, while every other tool returns `hints[]`. Plan 7, with a change to the skill.
- m9. src/entry/mcp/setup-tools.ts:94: the `PATCH` object drops unknown keys without saying so, and `RUNG` accepts a model shaped like a flag. Use `.strict()` once I2 makes the rejection structured. Plan 5 (ProfileService).
- m10. src/entry/lock.ts:51-61: signals go to the child's pid only, not its group. A tty Ctrl-C reaches the child twice, and SIGHUP is not handled. The fallback to half the cores is silent at :192-196. Plan 5 (CLI).
- m11. Spec drift: §4.3 lacks `gitUnavailable?`, and §4.4's hint list lacks `git-unavailable`, `state.md not refreshed:` and `failover:`. §10.1's family list lacks `E_INPUT_*`, and it lacks the new E_RUN_COMMIT, E_RUN_NOT_LIVE, E_IO_PATH and E_IO_UNEXPECTED. Update the spec doc, in the fix wave or in plan 7.
- m12. The skill's error list (plugin/skills/catherd/SKILL.md:59-65) does not name E_RUN_COMMIT, E_LANE_INVALID, E_RUN_NOT_LIVE or E_INPUT_INVALID. The generic rule ("act on the fix") covers them. Optional.

## Task 15 review (test/integration/mcp-stdio.test.ts, a626db6)

**Spec: ✅ compliant.**
- It covers every step of §11 item 4, in order: run_start, route, preflight, dispatch refused, climb, failover, land with knowledge, the budget stop, cancel, and a server restart mid-run followed by reconcile.
- It covers the §11 item 5 regressions through the real stdio server: parallel overlap, parallel duplicate, two concurrent reconcilers, a corrupt meta.json and a torn runs.jsonl tail.
- Every deviation from the brief makes the tests stricter. The report explains them, and the measurements back them up: the SIGKILL crash, the "no record before the new server" assertions, and waiting on `exit.json` instead of a fixed sleep.

**Quality: ✅ approved, Minor only.**
- (a) :328 keeps a fixed `Bun.sleep(500)` before its final count. That is acceptable, since it only widens the window for a duplicate to show up, but §11 hygiene prefers no wall-clock sleeps.
- (b) The lifecycle test is one 120 s `it`. A failure there points at the step's assertion, not at a test name. Splitting it is optional.
- (c) Nothing tests an input-validation error, or cancel with a dead supervisor, over stdio. Add both with the I2 and I3 fixes. The in-memory MCP test is enough for I2.
- (d) The timing margin (a role that runs 2 s after it is seen live) is documented.

## Task 16 review (plugin/skills/catherd/SKILL.md and scripts/stamp-plugin-version.mjs, f78dde9)

**Spec: ✅ compliant.**
- A whitespace-insensitive diff against the brief's skill text shows only the six deviations the report lists. Each makes the skill match the real tool shapes:
  - the optional inputs of `record_agent_run`;
  - the `hints` that `cancel` returns;
  - the `backend` and `agent` that `climb` returns;
  - the rule to read `hints`;
  - `E_ADMIT_RUNG` for a role that is off, which admission.ts:68-72 throws;
  - `cli-too-old` pointing at its hint.
- The skill checks the version in its first `status()`. It writes every rung as `backend:model#effort`, names all four preflight outcomes, and reports every native subagent through `record_agent_run`.
- The stamp script now stamps both pins, and plugin.test.ts checks that.

**Quality: ✅ approved, Minor only.**
- (a) The stamp regex `catherd-cli@\d[^\s`)"]*` would swallow a trailing `.` or `,` after a pin. Both pins are followed by a backtick today, and skills.test.ts would catch a drift, so this is acceptable.
- (b) Until I2 is fixed, the skill's claim "Every error is `{ code, message, fix }`" is false for invalid input.
- (c) See m12.

## Triage of the open and deferred items

| # | Item (source) | Decision | Owner / note |
|---|---|---|---|
| 1 | I1: zod input errors bypass `{code,message,fix}` (C1) | **MUST FIX BEFORE MERGE** | This review's I2. Small; a §4.8 contract that the skill states. |
| 2 | Dispatch loses the `next` and pause notes on a git failure (B1) | **MUST FIX BEFORE MERGE** | m1. One shared helper. |
| 3 | The un-live window between launch and the `next` refresh (B1) | CAN WAIT: plan 7 | Git runs in parallel (at most 15 s) plus at most 10 s of lock wait, under the 30 s grace. Fold it into m1 for free. |
| 4 | Cancel when the supervisor is dead and the worker lives (B1) | **MUST FIX BEFORE MERGE** | I3. |
| 5 | Failover hides the limited run's hints (B1) | **MUST FIX BEFORE MERGE** | m2. One line; violations must surface. |
| 6 | A launch.json write failure marks a live run lost (B1) | CAN WAIT: plan 7 | m6. Needs a disk fault. |
| 7 | Three copies of the state-refresh helper (B1, C1) | **MUST FIX BEFORE MERGE** | The same edit as #2. |
| 8 | `set_next` returns a plain-text hint (C1) | CAN WAIT: plan 7 | m8. |
| 9 | `catherd lock` signal handling (C1) | CAN WAIT: plan 5 | m10. CLI. |
| 10 | No Bun ≥ 1.4 startup guard (C1) | CAN WAIT: plan 5 | CLI and doctor. The suite runs on 1.3.11. |
| 11 | A newer-schema runs.jsonl breaks status (A2, B1) | CAN WAIT: plan 7 | m3. No schema 2 exists before then. Reconcile already catches it per run. |
| 12 | `listRuns` throws on an unreadable repo folder (A2) | CAN WAIT: plan 7 | m4. |
| 13 | `readAgentRuns` drops bad rows silently (A2) | CAN WAIT: plan 7 | It should count them as `readRecords` does, and log them once §10.2 logging exists. |
| 14 | Supervisor SIGTERM/SIGHUP handler (plan-1 carry-over) | CAN WAIT: plan 7 | I3's cancel path covers the user-facing hang. Recommended in the same fix wave if cheap. |
| 15 | Unparsable spec → exit.json (plan-1) | CAN WAIT: plan 7 | Covered in effect: the supervisor dies, `launch.json` shows it dead, and the dispatch is finalized `lost`. m7 fixes the pointer to stderr. |
| 16 | `readExit` hides a newer schema (plan-1) | CAN WAIT: plan 7 | src/infra/dispatch-dir.ts:41-48. Only a mix of versions triggers it. |
| 17 | Orphaned workers whose supervisor died (plan-1) | **MUST FIX BEFORE MERGE** (via cancel) | I3. An automatic reaper can wait for plan 7. |
| 18 | Supervisor dead before proc.json (plan-1) | COVERED | `launch.json` plus the start-time check (dispatches.ts:101-103). |
| 19 | Stale claim recovery (plan-1) | COVERED | `CLAIM_STALE_MS` plus the dedupe in `appendRecord` (finalize.ts:34-43, 193-208). |
| 20 | Codex `isBusy` (plan-1) | CAN WAIT: plan 3 | Without it, a quiet command longer than `idleMin` (15 min) is killed as idle. |
| 21 | JSONL headers at run creation (plan-1) | COVERED | runs, routes and agents at `createRun` (run-store.ts:91-93). jev is ruled into plan 4. harness gets its header when first written. |
| 22 | proc.json schema and reader (plan-1) | CAN WAIT: plan 7 | `readProc` is unvalidated `JSON.parse` (dispatches.ts:80-88). |
| 23 | Adapter-chosen failover stand-in refused at admission (B1) | CAN WAIT: plan 3 | admission.ts:77 must allow `failoverFor` when opencode lands. |
| 24 | Bridge profile saves unlocked; `timeouts` and `confirm` hard-coded (A2) | CAN WAIT: plan 5 | ProfileService. |

## Declined to judge

- A dispatch that keeps running after the client cancels the MCP request (Esc). That matches the ruling that dispatch blocks until finish, and `cancel` exists for stopping a role.
- An MCP server that stays alive after stdin EOF while its own dispatch runs (T15 report). Harmless under the claim, and the host kills it. A spec decision, not a defect.
- `catherd lock` failing inside a Codex workspace-write sandbox, where the locks folder is not writable. 0.x behaved the same way, and §10.3 assigns this check to doctor (plan 5).
- Tool timeouts on the host side for a long blocking `dispatch`. This follows the plan-writer's ruling ("dispatch blocks until finish") together with progress every 30 s.
- `profile_set` not covering `timeouts`, `access`, `jev` and `billing`, `never-as-root` in preflight, and the log file. These are ruled into plans 5 and 7.
- The 0.x `watch` TUI shows no 1.0 runs. This is ruled into plan 6.

## Verdict

**Ready to merge: after fixes.** The architecture, concurrency and record integrity are solid, and tests cover them well. Before merging, fix:
- I1: env values persisted in spec.json;
- I2: structured input-validation errors;
- I3: a cancel that works when the supervisor is dead;
- m1 + m2: one state-refresh helper that keeps the next and pause notes, and violations surfaced after a failover.

Each is a small change with a focused test. Everything else can go to plans 3, 5 and 7, as the triage table says.
