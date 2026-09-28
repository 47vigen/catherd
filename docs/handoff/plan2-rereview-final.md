# Re-review: plan 2 final fix wave (f78dde9..7d0dbe5)

Scope: the five commits c3841e3, d0cbfff, c1cd536, aedb58d and 7d0dbe5, checked against fix-final-findings.md and fix-final-report.md. This was a read-only review. I did not re-run the suite; the report gives 530 pass, 1 known env-only failure, and stdio 4/4 three times.

## Verdicts

| # | Verdict | Evidence |
|---|---|---|
| I1 spec.json env leak | ADDRESSED | src/services/admission.ts:154-172 writes `env: { ...plan.env, PWD: plan.cwd }` with `{ mode: 0o600 }`. src/infra/store.ts:20-30 opens the tmp file with the mode and `fchmodSync` sets it before the write. src/entry/supervise.ts:14-15 builds `workerEnv(process.env, read.env, read.cwd)` at spawn time. Tests: test/services/admission.test.ts:75, test/infra/store.test.ts:35, test/services/dispatch.test.ts:54. |
| I2 structured input errors | ADDRESSED | src/entry/mcp/result.ts:29-41 adds `sdkToolError`, and src/entry/mcp/server.ts:25-28 installs it. Test: test/entry/mcp.test.ts:66, with three inputs, each checked for code, message, fix and raw text. |
| I3 dead-supervisor cancel and wait | ADDRESSED | `stopOrphan` is at src/services/dispatch-service.ts:186-203 and is called from `cancel` at :214. The finalize fallback is at src/services/finalize.ts:80-86. The wait path was already handled by src/services/dispatches.ts:97-101, where the supervisor and the worker are both dead, so the dispatch is finished. Tests: test/services/failover-cancel.test.ts:164 and :182. |
| m1 one refresh helper, refresh after launch | ADDRESSED | The helper is at src/services/state.ts:72-100. lane-service.ts, reconcile.ts:22-23 and :63, and run-service.ts:21 use it; no local copies remain. src/services/dispatch-service.ts:56-57 launches before `refresh`, and :86-94 passes `next` into that refresh after the launch. Tests: failover-cancel.test.ts:116, dispatch.test.ts:40, and dispatch.test.ts:219, which was updated. |
| m2 failover keeps violation hints | ADDRESSED | src/services/dispatch-service.ts:166-169. Test: test/services/failover-cancel.test.ts:63. |

## Named risks

1. **No server secret on disk; spec.json is 0600.** Holds.
   - spec.json `env` holds only the adapter's overrides. Codex's only override is the path `CODEX_HOME` (src/adapters/codex/index.ts:86), plus PWD.
   - launch.json, proc.json and exit.json (admission.ts:183, supervisor.ts:98 and :139) carry pids, times and reasons, but no env.
   - supervisor.log receives only the supervisor's own stdout and stderr, which never print the env (supervise-bin.ts, supervisor.ts:120).
   - The worker's env is equivalent to what it was before the fix. The supervisor's env is `scrubSecrets(process.env)` (src/infra/launch.ts:17), and `workerEnv` scrubs that env again and adds the overrides, so TYPESAFE_API_KEY stays out. dispatch.test.ts:54 guards this end to end.
2. **The dead-supervisor cancel never signals a process other than the worker, and never pid ≤ 1.** Holds, with one caveat (deferred minor 1).
   - `stopOrphan` returns early if there is no proc.json, if exit.json exists, or if the supervisor is alive by pid and start time.
   - Before each signal it checks `isAlive(proc.pid, proc.startTime)`: before the SIGTERM (dispatch-service.ts:190) and before the SIGKILL (:194).
   - `killGroup` refuses a pid that is not valid (below 1) and refuses pid 1 (src/infra/proc.ts:39-40).
   - If the supervisor's start time is unreadable, a reused supervisor pid makes the supervisor look alive. That errs toward doing nothing, which is the safe direction.
3. **"Cancel requested + no exit.json ⇒ cancelled" cannot recast a normal finish.** Holds.
   - A supervisor that sees the worker finish writes exit.json before it exits (supervisor.ts:98), and `readExit` takes precedence over the fallback (finalize.ts:81).
   - The cancel file is written only by `cancel`, and only for a live dispatch (dispatch-service.ts:207-213). Every dispatch folder is fresh, so a stand-in never inherits the file.
   - The fallback applies only when the supervisor died without writing exit.json. One narrow window remains (deferred minor 2).
4. **Structured input errors leave the SDK's success path intact.** Holds.
   - In SDK 1.30.1 (node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:100-142), `createToolError` is called only from the catch block of the CallToolRequest handler. The success path returns `result` directly.
   - No catherd tool declares an `outputSchema`, so `validateToolOutput` is a no-op for the plain `ok()` results.
   - Errors thrown inside a handler are already caught by `handle` and never reach the override.
   - UrlElicitationRequired is still re-thrown before the override is reached.

## New Critical/Important breakage in these commits

None found.

## Deferred minor

1. When `proc.startTime` is null, the identity check falls back to pid alone. That happens only if /proc and `ps` both failed, or the worker was already gone when proc.json was written. A crashed supervisor plus a reused worker pid would then let `stopOrphan` SIGTERM an unrelated pid, so it could also require `proc.startTime !== null`. dispatchState has the same convention and predates these commits.
2. `stopOrphan` signals `proc.pgid ?? proc.pid` but checks identity only on `proc.pid`. The supervisor always writes `pgid === pid`, so this matters only if proc.json is corrupt or edited; asserting `pgid === pid` would close it.
3. A worker that exits by itself between `requestCancel` and `stopOrphan`'s liveness check, while its supervisor is dead, is recorded as `cancelled`. Before this change it was recorded as `lost`, which the Codex adapter records as `ok` when a reply exists. The user did ask for the cancel, so this is acceptable.
4. The orphan exit.json always records `signal: "SIGTERM"`, even when the SIGKILL was needed (dispatch-service.ts:195-200).
5. The doc comment on `SpawnPlan` is now stale (src/adapters/backend.ts:37-41). It still says the caller runs `workerEnv(process.env, …)` and that the supervisor passes the env through unchanged, but the supervisor now builds it.
6. `sdkToolError` also maps SDK "Tool X not found/disabled", which the SDK raises as InvalidParams, to E_INPUT_INVALID. For those errors the fix text "correct the argument the message names" is slightly off.
7. Nothing scrubs or chmods spec.json files written before d0cbfff, which may still hold the full env.
