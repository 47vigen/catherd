# Re-review: final-review fix wave, plan 1 (d55780b..b1cac9a)

Scope: the six findings in fix-final-findings.md, checked against the diff and the named risks.
I read the diff once and did not run git commands or the test suite. The fix report gives 446 pass
and 1 known env-only failure.

## Verdicts

1. **I1: group members left behind after the worker exits on its own. ADDRESSED.**
   - Fix: `src/infra/supervisor.ts:183-194`. A `stopped` flag is set only after `stopGroup` has run.
     After `await child.exited`, `if (!stopped && groupAlive(child.pid)) await stopGroup(...)` runs
     before `finish()` writes exit.json. The code and signal still come from the worker, and the
     reason stays `"exited"`.
   - Test: `test/infra/supervisor.test.ts:205` runs `sleep 30 & echo $!; exit 0`. It asserts exit
     and exit.json are `{code:0, reason:"exited"}` and that the background pid is dead.
2. **I2: codex `sh()` had no timeout and passed the full env. ADDRESSED.**
   - `scrubSecrets` is at `src/infra/env.ts:5`. `workerEnv` (`env.ts:16`) and `src/infra/launch.ts:17`
     reuse it.
   - `sh()` (`src/adapters/codex/index.ts:31-60`) is now async. It uses `Bun.spawn` with
     `env: scrubSecrets(process.env)` and `stdin: "ignore"`, and races a timer against
     `exited`/stdout/stderr. On a timeout it sends SIGKILL and returns `ok:false`.
   - The timeout can be overridden through `codexShell.timeoutMs` (`index.ts:28`).
   - `probe()` and `listModels()` await `sh()` (`:187`, `:201`, `:217-218`).
   - Tests:
     - `test/adapters/codex.test.ts:172`: a hung login returns in under 2 s with `loggedIn:false`.
     - `codex.test.ts:187`: the simulator records the env, TYPESAFE_API_KEY is absent and
       OPENAI_API_KEY is present.
     - `test/infra/env.test.ts:29`: a unit test for `scrubSecrets`.
   - The layering is legal: adapters (rank 2) import infra (rank 1), per `test/architecture.test.ts:6`.
3. **Minor: the SpawnPlan comment. ADDRESSED.** `src/adapters/backend.ts:37-41` now names
   `workerEnv(process.env, plan.env, plan.cwd)` as the caller's job, and says the supervisor passes the
   env it is given unchanged.
4. **Effort `default` means no effort flag. ADDRESSED.**
   - Fix: `src/adapters/codex/index.ts:72-73` leaves out `-c model_reasoning_effort=…` when
     `rung.effort === "default"`.
   - Test: `test/adapters/codex.test.ts:64` covers a fresh run and a resumed one.
5. **proc.json records `pgid`. ADDRESSED.**
   - Fix: `src/infra/supervisor.ts:142` writes `pgid: child.pid`. The child is spawned with
     `detached: true` (`:116`), so its pid is its pgid.
   - Test: `test/infra/supervisor.test.ts:38`.
6. **Spec §3.3 text. ADDRESSED.** `docs/superpowers/specs/2026-09-25-catherd-1.0-design.md:101-102` names
   `src/entry/supervise-bin.ts <spec.json>` as a thin entry that never loads the TUI. It notes that
   `catherd _supervise` runs the same code, for manual use.

## Named-risk checks

- **Post-exit stop does not delay exit.json when the group is gone: OK.**
  - `groupAlive` (`supervisor.ts:69-76`) is `kill(-pgid, 0)`. ESRCH returns false, so `stopGroup` is
    skipped and `finish()` runs at once.
  - The path through `stopGroup` is bounded by `killGraceMs`, and its loop exits early once the group
    is empty.
  - When the stop sequence already ran (`stopped = true`), the group is not stopped a second time.
- **No signal to a pid ≤ 1 or an unrelated group: OK.**
  - `child.pid` comes from a successful `Bun.spawn`, so it is always a real pid greater than 1. A spawn
    failure returns at `:124` before this code.
  - `killGroup` also refuses a pid ≤ 1 (`src/infra/proc.ts:40`).
  - The post-exit stop runs only while `kill(-pgid,0)` succeeds. At that point the group still has
    members, and the kernel does not hand out that id while the group exists.
  - Every signal in `stopGroup` goes to the group, `-pgid`. The one exception is `killGroup`'s
    fallback to the bare pid (see deferred minor 2).
- **Async codex `sh()` leaves no timer or process behind on success: OK.**
  - `timer` is assigned synchronously in the Promise executor, and `finally` clears it on every path.
  - On success, `p.exited` has resolved, so the child has been reaped.
  - `Promise.race` subscribes to the `Promise.all`, so a later stream rejection is not unhandled.
- **`sh()` fails closed on a timeout: OK.**
  - The child gets SIGKILL and `sh()` returns `{ok:false, out:""}`.
  - In `probe()`, a timed-out login gives `loggedIn:false`, and a timed-out `--version` gives
    `versionOk:false`.
  - In `listModels()`, `""` fails `JSON.parse` and the result is `[]`.
- **`scrubSecrets` keeps the user's backend credentials: OK.**
  - `SECRET_ENV` is still only `TYPESAFE_API_KEY` (`env.ts:2`). `scrubSecrets` drops only those keys
    and keys that are unset.
  - `OPENAI_API_KEY` survives, which `env.test.ts:29` and `codex.test.ts:187` both assert.

## New Critical/Important breakage in the fix diff

None.

## Deferred minor

1. Zombie members still count as alive. If a zombie-only group is left behind on a host whose pid 1
   does not reap orphans, `groupAlive` stays true, and the post-exit `stopGroup` waits the full
   `killGraceMs` (at most 10 s) before exit.json is written. The delay is bounded, and the fix report
   already discloses it.
2. `killGroup`'s fallback to the bare pid (`proc.ts:44-48`) can now run after the leader has been
   reaped. This happens if the group empties between `groupAlive` and the SIGTERM. The pid could only
   belong to someone else after a pid wraparound within microseconds. `stopGroup`'s own SIGKILL is
   group-only, and its comment says "never the bare pid".
3. A `codex --version` that times out is reported as `E_BACKEND_TOO_OLD` ("codex ? is older than …"),
   not as a timeout. It fails closed, but the message is misleading.
4. `listModels()` can take up to twice the timeout (30 s) when `debug models` and `debug models --bundled`
   both hang.
5. On a timeout, only `codex` gets SIGKILL, not any children it started. The pending stream reads hold
   the pipe fds until those children exit. `sh()` still returns; the fix report discloses this.
