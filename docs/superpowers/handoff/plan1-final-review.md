# Final review: plan 1 (foundation), 27ae4fb..d55780b

**Scope.** 24 commits on `claude/project-analysis-review-xb3fot` (HEAD d55780b = the working tree, which is clean).

**What I read.**
- Every new `src/` file at HEAD, which is the whole diff apart from `.gitignore` churn.
- The key tests: architecture, contract, e2e, launch, supervisor, filelock, proc and the simulator.
- Spec §3–4, §5.1, §6, §10–11, and the plan's constraints and handoff notes.
- The ledger and all five task and re-review files.

**Checks I ran.** I did not re-run the suite, which the ledger records as 441 pass and 1 known env-only failure. I ran one focused probe on a scratch copy: `supervise()` on `sh -c 'sleep 30 & echo $!; exit 0'`. The `sleep` is still alive after exit.json says `exited` (see I1).

## Strengths

**The supervisor's failure paths are well hardened** (src/infra/supervisor.ts:95-196):
- A spawn failure is recorded as `lost` with the error in stderr, and the fds are closed in `finally`.
- Hooks are bounded, and throws or timeouts fall back to safe values (`bounded`, :53-67).
- A throw from `onLine` skips the line.
- `stopGroup` always ends with a group-only SIGKILL and never falls back to the bare pid (:79-91).
- Streaming UTF-8 decoding is handled.
- Each of these has a test (test/infra/supervisor.test.ts:106-216).

**The file lock is sound for normal operation** (src/infra/filelock.ts):
- Reclaim is serialised through a `.reclaim` marker, with a re-read under the marker and a `sameHolder` check (:68-83).
- A 5 s lease covers unparsable locks and crashed reclaimers.
- A real multi-process test with crashers backs this (test/infra/filelock.test.ts:88-115).
- The pid-1 correction is right: pid 1 is a valid identity, and only `killGroup` refuses it (src/infra/proc.ts:26-40).

**Layering holds.**
- `supervise-bin.ts` has a TUI-free import closure, and a test walks the import graph to prove it (test/infra/launch.test.ts:96).
- The architecture test is shown to fire in both directions (test/architecture.test.ts:48-70).

**The Codex adapter follows §6.1.**
- The argv and the order of `--` are correct, and the thread is validated before any argv is built (src/adapters/codex/index.ts:32-59).
- Tokens follow "input includes cached".
- A run fails only on `turn.failed` or on a non-zero exit with no reply.
- The isolated home tolerates broken links and vanished images, and finalize creates nothing.

**The domain types are clean and pure.**
- Owned paths are canonicalised (src/domain/lane.ts:36-48).
- Dispatch ids are monotonic ULIDs.
- `ZERO_TOKENS` is typed as frozen.
- `RunRecordSchema` matches §4.3 field for field.

**Test hygiene is good on env.** Every file that writes `process.env` or calls `withHome()` uses `afterEach(snapshotEnv())`. The e2e test drives the real detached launcher against the simulator.

## Issues

### Critical

None.

### Important

**I1. A natural exit does not sweep the group, so group members outlive a run recorded as ended.** MUST FIX.
- **Where:** src/infra/supervisor.ts:182-187.
- **What:** `stopGroup` runs only `if (reason !== null && !done)`. On the ordinary `exited` path, and when the leader exits during `interrupt` or in the poll that set `reason`, nothing signals the group. The probe confirms it: a same-group `sleep 30` is alive after exit.json says `exited`.
- **Why it matters:**
  - The fix-2 commit claims "leaves no live worker", and that claim fails on the most common path.
  - Plan 2 computes `changedOwned` and `violations` from `git status` after finalize, and then lands. A surviving tool process (a watcher, or a test runner the agent started) keeps editing the tree after the record is written.
  - Worktree removal also trips on it.
- **Fix:**
  - After `const code = await child.exited;` (:187), add `if (groupAlive(child.pid)) await stopGroup(child.pid, spec.killGraceMs, spec.pollMs);`.
  - `kill(-pgid)` is safe while the group is non-empty, because Linux and macOS never allocate a pid that is still in use as a pgid.
  - Capture `code` and `signalCode` before the sweep so the leader's own status is recorded.
  - Add a test: `sh -c 'sleep 30 & echo $!; exit 0'`, then assert the member is dead once supervise resolves.

**I2. The Codex probe and discovery calls block synchronously, have no timeout, and pass the full env.** MUST FIX.
- **Where:** src/adapters/codex/index.ts:26-30.
- **What:** `Bun.spawnSync(["codex", …], { env: process.env })` has no `timeout`. `codex login status` and `codex debug models` can touch the network, and a hang freezes the calling process's event loop indefinitely. The caller will be the MCP server, since plan 2's admission needs "ready per the last probe" (§4.4). It also hands `TYPESAFE_API_KEY` to the backend CLI, against §10.4 "secrets never reach workers".
- **Fix:**
  - Add a helper `scrubSecrets(env)` in src/infra/env.ts. Reuse it in `workerEnv`, in `launchSupervisor` (src/infra/launch.ts:11-12, which duplicates the loop today) and in `sh()`.
  - Give `sh()` a timeout (`timeout: 15_000`, with `killSignal: "SIGKILL"`).
  - Preferably make `sh()` async with `Bun.spawn`, since `probe` and `listModels` already return promises.
  - Treat a timeout as "not installed / not logged in", with a problem entry.

### Minor (new in this review; earlier minors are triaged in the table below)

1. **The `SpawnPlan` comment is wrong about who merges the env.** MUST FIX (a one-line doc fix on the seam plan 2 builds on).
   - **Where:** src/adapters/backend.ts:37.
   - **What:** The comment says "the supervisor merges them over the scrubbed parent env". The supervisor passes `spec.env` through verbatim (supervisor.ts:112). The spec writer must call `workerEnv(process.env, plan.env, plan.cwd)`, and that call is also the only place `PWD` is set and secrets are scrubbed.
   - **Fix:** Say "the spec writer (RunService) merges them with `workerEnv`".
2. **Spec deviation from §5.1: Codex passes a `default` effort to the CLI.**
   - **Where:** src/adapters/codex/index.ts:40-42.
   - **What:** §5.1 says effort `default` means no effort flag, but the adapter always emits `-c model_reasoning_effort=default`, which Codex rejects. `parseRung` accepts `#default` (test/domain/ids.test.ts covers the opencode form).
   - **Fix:** `...(r.rung.effort === "default" ? [] : ["-c", \`model_reasoning_effort=${r.rung.effort}\`])`, plus one test. CAN WAIT (plan 4, where the catalog generates rungs), but it is a one-liner.
3. **Spec deviation from §3.3: proc.json has no `pgid` and no reader.**
   - **Where:** supervisor.ts:139-146.
   - **What:** proc.json is written without `pgid`, which equals `pid` because of setsid. No `ProcFileSchema` or `readProc` sits next to `ExitFileSchema`. Plan 2's reconciler is the first reader and will otherwise invent the shape.
   - **Fix:** Add both in src/infra/dispatch-dir.ts (a loose schema with `schema: 1`), and either write `pgid` or amend §3.3. CAN WAIT (plan 2, first task).
4. **Deviation from §3.1 and §3.3 in the process entry point.**
   - **What:**
     - Workers run as `bun src/entry/supervise-bin.ts <spec>`, not `catherd _supervise <spec>`.
     - The `_supervise` subcommand in src/cli.ts:22 is now a second, unused entry that does load the TUI through cli.ts's static imports.
     - src/infra/launch.ts:7 names an `entry/` file by URL, so infra knows an upper layer in a way the architecture test cannot see.
   - **Verdict:** Justified by review B I4. Record it in the spec at plan 5. Then either remove the cli subcommand or keep it and document it as "manual/debug only". The cleaner option is for plan 2's service to pass the entry path into `launchSupervisor`.
5. **A transient `ps` failure makes a live process look dead.**
   - **Where:** src/infra/proc.ts:35.
   - **What:** When `kill(pid,0)` succeeds but `processStartTime` returns null (a transient `ps` failure on macOS), `isAlive` answers false. A live lock holder is then reclaimed, and a live worker is judged dead by the reconciler.
   - **Fix:** When a recorded start time exists but the current one cannot be read, answer true. That is conservative: a stuck lock times out with `E_IO_LOCK` instead of admitting a second holder. CAN WAIT (plan 7, macOS CI). This is the same item as rereview-1 #6.
6. **The launch log path is rebuilt, and its fd leaks on a spawn error.** src/infra/launch.ts:13-21 rebuilds `supervisor.log` instead of using `dispatchPaths(dirname(spec)).supervisorLog`, and leaks the log fd if `Bun.spawn` throws. Use a `try/finally`. CAN WAIT (plan 2). This is the same item as review-B T9-2.
7. **The file lock is non-reentrant, and a missing directory surfaces as a raw error.**
   - **Where:** src/infra/filelock.ts:85-100.
   - **What:** A nested `withFileLock` on the same target in the same process always waits the full `timeoutMs` and then throws `E_IO_LOCK`, because the holder (itself) is alive. A missing parent directory throws a raw ENOENT (A2 T5-M3).
   - **Fix:** Document "non-reentrant" in the doc comment, and `mkdirSync(dirname(lock), {recursive:true})` before the loop. CAN WAIT (plan 2, the first caller).
8. **Two tests are timing-sensitive, and the lock workers pick up `bun` from PATH.**
   - test/infra/supervisor.test.ts:172 relies on the sh loop exiting within `hookMs` = 100 ms of the stop file.
   - test/infra/filelock.test.ts:98 and :105 spawn `"bun"` from PATH rather than `process.execPath`, so on a multi-Bun CI runner the workers may run on a different Bun.
   - **Fix:** raise `idleMs` to 1000 in the first test, and use `process.execPath` in the second. CAN WAIT (plan 7).
9. **§11 hygiene is only partly met.** Tests still mutate the global `process.env` (restored by `snapshotEnv`), use real sleeps, and never remove their `mkdtemp` dirs. The plan's own constraints relaxed the first two, so this is noted rather than a defect. CAN WAIT (plan 7: a shared `tempDir()` with `afterAll` cleanup).

## Plan-2 obligations (not plan-1 defects; plan 2's RunService must own them explicitly)

- **Supervisor dead, worker alive.** An unhandled SIGTERM, a SIGKILL or an OOM kill of the supervisor leaves the worker running with no idle or wall enforcement, and nobody reads `cancel`. The spec rule in §3.3 ("finished when … supervisor dead and worker gone") would call such a run live indefinitely. The reconciler and `cancel` must kill the group through proc.json (`pid` + `startTime`) and record `lost`.
- **A launched supervisor that died before writing proc.json** (an unparsable or newer spec, a Bun crash). There is no proc.json, so there is no `supervisorPid`. Have `launchSupervisor` return `{pid, startTime}` and persist it, or treat "no proc.json after N s" as `lost`.
- **A stale `claim`.** `tryClaim` is a bare `wx` file (dispatch-dir.ts:22-31). A finalizer that crashes after claiming blocks finalization forever, which is the §11.4 "server restart mid-run" case. Write the claimer's `{pid,startTime}` into the claim and re-finalize when the claimer is dead and no record exists.
- **`readExit` hides a newer-schema exit.json.** It returns null for one (dispatch-dir.ts:41-48). The reconciler must not read that as "not finished, so lost". Rethrow `E_CONFIG_NEWER_SCHEMA` and swallow only a missing or partial file.
- **JSONL header race.** Create the `runs.jsonl`, `routes.jsonl` and `jev.jsonl` headers when the run folder is created, under the admission lock, so the `ensureJsonlHeader` versus `appendJsonl` first-creation race (A2 T4-M1) cannot occur.
- **Codex has no `isBusy`.** A Codex tool call that runs silently for more than `idleMin` (a long test suite) is killed as `idle-timeout`, and finalize maps that to `timeout` (index.ts:68) even if a reply follows. Consider tracking open `item.started` / `item.completed` pairs from `parse` as busy.

## Deferred-minor triage

MUST = fix before merge. The plan number named in the CAN WAIT column owns the item.

| Source | Item | Ruling | Owner and reason |
|---|---|---|---|
| C-9 | Group sweep on every exit path | **MUST** | This review's I1. A live group member corrupts plan 2's `changedOwned` and landing. |
| C-10 | No SIGTERM/SIGHUP handler | CAN WAIT | Plan 2. SIGHUP never arrives, because setsid means there is no controlling tty. The reconciler must handle a SIGKILLed supervisor anyway (see obligations). A handler that runs `stopGroup` + `finish` is a cheap add in plan 2. |
| C-11 | Unparsable spec leaves no exit.json | CAN WAIT | Plan 2. Plan 2 writes the spec, and the reconciler reads "no proc.json / supervisor gone" as `lost`. Optionally catch in supervise-bin and write `lost` to `dirname(spec)`. |
| C-12 | supervise-bin never exits explicitly | CAN WAIT | Plan 3, the first adapter with `isBusy` or `interrupt` (opencode). Add `process.exit(0)` after `await runSupervise`. Codex has no hooks today. |
| C-1, C-2 | Codex `sh()`: no timeout, full env | **MUST** | This review's I2. The MCP event loop can hang, and a secret reaches the backend CLI. |
| C-3 | `tooOld` can override a successful run | CAN WAIT | Plan 3, the error-taxonomy review alongside the fixture capture. |
| C-4 | Isolated-home symlink EEXIST race; relative CODEX_HOME | CAN WAIT | Plan 7. Catch EEXIST, and `resolve()` CODEX_HOME. |
| C-5 | Contract 2-arg vs 3-arg | CAN WAIT | Resolved by the ruling. Plan 3 uses the 3-arg form. |
| C-6, C-7 | Contract lacks assertions for `--`, `E_ADMIT_THREAD` and `turn.failed` | CAN WAIT | Plan 3, before the second adapter lands. Codex itself is covered (codex.test.ts:57, :77, :85, :114). |
| C-8 | e2e checks the scrub in the spec file, not in the env the sim saw | CAN WAIT | Plan 3 (the sim records env keys) or plan 2 (integration). |
| C-13 | supervisor.test.ts:172 timing | CAN WAIT | Plan 7 (see Minor 8). |
| C-14 | A `{pid:1,startTime:null}` lock can never be reclaimed | CAN WAIT | Plan 7, or never. It needs `/proc/1/stat` to be unreadable to pid 1 itself, which does not happen. |
| B-T6-1 | `SpawnPlan` env comment | **MUST** | Minor 1. A one-line fix on the seam plan 2 builds on for scrubbing and `PWD`. |
| B-T6-2 | `compareVersions` returns NaN on non-numeric input | CAN WAIT | Plan 3 (opencode `2.0.16` and prerelease strings). Parse with `extractVersion` inside. |
| B-T6-3 | `Outcome.error.code` is `string` | CAN WAIT | Plan 2 (the RunRecord mapping). |
| B-T6-4 | `readExit` swallows a newer schema | CAN WAIT | Plan 2 (see obligations). |
| B-T6-5 | `tryClaim` has no stale-claim rule | CAN WAIT | Plan 2 (see obligations). This one matters for crash recovery. |
| B-T7-2 | `readSync` byte count is ignored | CAN WAIT | Plan 7. |
| B-T7-3 | Idle counts only complete stdout lines | CAN WAIT | Plan 3 (claude-code and opencode streams). See also the obligation on Codex `isBusy`. |
| B-T7-5 | No signal handler | CAN WAIT | Same as C-10. |
| B-T9-2 | Log path duplicated; fd leaks | CAN WAIT | Plan 2 (Minor 6). |
| B-T9-3 | `_supervise` not `hidden` | CAN WAIT | Plan 5 (CLI surface; see Minor 4). |
| RR1-1 | Stale-marker stat/rm race | CAN WAIT | Plan 7. It needs a crash plus a microsecond window. |
| RR1-2 | A reclaimer paused for more than 5 s | CAN WAIT | Plan 7. Put a nonce in the marker and re-check it before `rm`. |
| RR1-3 | Extensionless import is not flagged | CAN WAIT | Plan 7. The repo uses `.ts` everywhere. |
| RR1-4 | `endsMidLine` stat/open race | CAN WAIT | Plan 7. JSONL files are never removed. |
| RR1-5 | `newDispatchId(now)` with an earlier `now` | CAN WAIT | Never; it is by design. |
| RR1-6 | macOS transient `ps` failure reads as dead | CAN WAIT | Plan 7 (Minor 5). |
| A-M3 | Architecture test never asserts non-empty files | CAN WAIT | Plan 7. |
| A-M5 | `parseRung` does not trim or restrict its charset | CAN WAIT | Plan 5 (profile validation). Also reject a model or effort that starts with `-` or contains whitespace. |
| A-M6 | `assertId` test does not check the code | CAN WAIT | Plan 7. |
| A-M7 | Header parse has no boundary (a body `Owns:` line) | CAN WAIT | Plan 2 (lane admission). Stop at the first blank line. |
| A-M8 | Title regex crosses a newline | CAN WAIT | Plan 2. Use `[ \t]+`. |
| A-M9 | Kind/Difficulty values are case-sensitive | CAN WAIT | Plan 2. |
| A-M10 | Globs in `Owns:` are taken literally | CAN WAIT | Plan 2. §4.2 says "never globs", so reject `*?[` with `E_LANE_INVALID`. Otherwise E_ADMIT_OVERLAP is silently bypassed. |
| A-M12 | Nested `tokens` and `error` strip unknown keys | CAN WAIT | Plan 2, if it rewrites records; otherwise plan 7. |
| A-M13 | Strict enums reject a newer status | CAN WAIT | Plan 2 decides whether to parse runs.jsonl rows strictly. |
| A-M14 | No non-negative or `cached ≤ input` check on tokens | CAN WAIT | Plan 7. |
| A-M15 | STATUS line needs a dash and a reason, and rejects `**STATUS:**` | CAN WAIT | Plan 2 (climb hints). Make `— why` optional. |
| A-M16 | `sampleRecord` exported from a test file | CAN WAIT | No importer today (checked). Plan 7. |
| A-M17 | No en-dash test | CAN WAIT | Plan 7. |
| A-M18 | Sim calls `process.exit` right after an async stdout write | CAN WAIT | Plan 3 (simulators), before macOS CI. |
| A-M19 | Sim cannot emit a partial stream and then stall | CAN WAIT | Plan 2 (the idle-timeout integration test in §11.4). |
| A-M20 | Sim recognises only `-o` | CAN WAIT | Plan 3. |
| A-M21 | `recorded()` throws a raw ENOENT | CAN WAIT | Plan 3. |
| A-M22 | Sim test gaps and temp litter | CAN WAIT | Plan 3. |
| A2-T4-M1 | `ensureJsonlHeader` first-creation race | CAN WAIT | Plan 2 (create headers at run-folder creation). |
| A2-T4-M2 | `isHeader` requires exactly 2 keys | CAN WAIT | Plan 7, before the 1.0 release, so 1.0 readers recognise a future richer header. |
| A2-T4-M3 | No directory fsync; tmp not unlinked or swept | CAN WAIT | Plan 7. |
| A2-T4-M4 | ENOENT reported as "not readable JSON" | CAN WAIT | Plan 2 (its callers read meta.json). |
| A2-T4-M5 | Relative CATHERD_HOME/XDG used as-is | CAN WAIT | Plan 2. A relative home gives the isolated `CODEX_HOME` a path that resolves against the repo cwd. `resolve()` CATHERD_HOME and ignore a relative XDG value. |
| A2-T4-M6 | Vacuous throw test | CAN WAIT | Plan 7. |
| A2-T4-M7 | Coverage gaps; temp litter | CAN WAIT | Plan 7. |
| A2-T5-M1 | A zombie reads as alive | CAN WAIT | Plan 2 (the reconciler's liveness check matters for PID-1 containers without an init). |
| A2-T5-M3 | Lock does not create the target directory | CAN WAIT | Plan 2 (Minor 7). |
| A2-T5-M4 | `me()` spawns `ps` on every lock (macOS) | CAN WAIT | Plan 7. Cache it. |
| A2-T5-M5 | `lstart` has 1 s resolution | CAN WAIT | Plan 7. Document it. |
| A2-T5-M6 | Timeout tests match `/lock/`, not the code | CAN WAIT | Plan 7 (filelock.test.ts:39, :59, :68, :81). |
| A2-T5-M7 | `killGroup` test checks only the leader | CAN WAIT | Covered in effect by supervisor.test.ts:185. Plan 7. |

## Declined to judge

- 0.x modules and `src/cli.ts` beyond the one added line: out of scope, and the plan requires them to stay untouched.
- The `test/tui/theme.test.ts` failure on Bun 1.3.11: already ruled env-only, and CI is green.
- Whether real Codex `exec` lingers after its last `turn.completed`, and so needs `graceAfterFinalMs`: this cannot be verified without the live CLI. The plan chose `null` deliberately (two-turns fixture), which is a §6 "grace kill" deviation for plan 3's fixture capture to settle.
- Startup cost and memory of one Bun supervisor per dispatch: performance, not correctness, for plan 1.
- Windows: out of scope. Spec §12 names only Linux and macOS.

## Verdict

**Ready to merge: after fixes.** Fix three items first, all small and local:
- I1: sweep the group on every exit path.
- I2: Codex `sh()` gets a timeout and a scrubbed env.
- Minor 1: correct the `SpawnPlan` env comment.

Nothing else blocks the merge. Plan 2 should take the "Plan-2 obligations" list as explicit tasks.
