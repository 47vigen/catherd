# Plan 7 final whole-branch review (6195f4e..22c753f)

Reviewer: Senior Code Reviewer (final pass). Range: 18 commits, 76 files (+2497 / −369), package
`final-review.diff`. Read-only on the checkout; verification ran in a worktree at `22c753f`
(`/tmp/review-p7`).

## What I verified by running it

- `bun run typecheck && bun run lint && bun run format:check`: clean.
- `bun test` (Bun 1.4.2, Linux, as root): **1037 pass, 10 skip, 0 fail** (105 files, 168 s).
- `bun test --coverage --coverage-reporter=lcov` then `bun test/coverage-floor.ts`: **93.1 % of functions,
  93.9 % of lines** over `src/`, above the 85 / 88 floor.
- `bun test/pack-smoke.ts`: every `ok`. The tarball holds `src/`, `catalog/{models,scores,jev}.json`,
  `plugin/` (with `.claude-plugin/plugin.json`, `.mcp.json`, the two commands and two skills),
  `THIRD_PARTY_NOTICES.md`, `README.md`, `LICENSE`, `package.json`, and nothing from `test/`, `docs/`,
  `scripts/`, `.github/` or `.changeset/`. The installed MCP server answers `tools/list`.
- PR #10 check runs on the head: all five green (`ubuntu-latest` and `macos-latest` × Bun `1.4.0` and
  `latest`, plus `package · audit and npm pack smoke`).
- The only `src/` path read through `assetPath` apart from `catalog/*` is `test/fixtures/adapters` in
  `capture-fixtures`. It is optional by design (Ruling 18: exit 2 with `--out` asked for), so the package
  ships everything the runtime reads. `mcpHandshake` spawns the local `src/cli.ts`, not `bunx
  catherd-cli@<version>`, so the pack smoke on the release commit (version 1.0.0, not yet on npm) passes
  before publishing.

## Strengths

- **The release is gated the way Ruling 2 says.** `ci.yml` is `pull_request` + `workflow_call`, and
  `release.yml`'s `release` job `needs: ci`. Nothing reaches `changesets/action` (and so `changeset
  publish`) unless all four matrix legs and the package job pass. `concurrency` keeps releases from
  overlapping. There is one changeset (`major`) and no `pre.json`, so 0.2.1 goes to 1.0.0. The
  `version-packages` script stamps `plugin.json`, `.mcp.json` and the skill, and `plugin.test.ts` checks
  that they agree.
- **The coverage floor is honest.** The plan found that Bun's `coverageThreshold` applies per file, and
  `test/coverage-floor.ts` sums the lcov totals over `src/` instead. An lcov report with no `src/` rows
  fails the check (the ratio reads as 0), so a broken report cannot pass silently.
- **Supervisor races fixed where they live.** The exit wins when it is already known at wake-up
  (`if (done) break` before the cancel and limit checks). Open tool-call ids are kept in a `Set` and
  short-circuit `isBusy`. The grace after `interrupt` runs only when there is an interrupt hook, so Codex
  and claude-code cancel exactly as before. The old 100 ms test is now deterministic (10 s grace, and it
  asserts the worker ended early).
- **Orphan cancel is conservative, and it says so on disk.** An orphan is signalled only when it has a
  start time and `pgid === pid`. It signals the worker's own group, and `exit.json` records the last
  signal actually sent, or `null`.
- **Cross-platform work is thorough and was proven on real macOS CI.** `/bin/ps` is called by absolute
  path, and `psStartTime` returns null rather than throwing. `sameProcess` treats an unreadable start time
  as the same process. `tempDir()` resolves the real path. The `/proc` test uses a `skipIf` that states its
  reason. The zombie-aware `exited()` works on both platforms. The pty socket directory falls back to
  `/tmp` when `TMPDIR` is long.
- **Test hygiene improved.** The 800 ms SIGINT sleep became a wait for the `initialize` reply. The double
  Ctrl-C test waits for the first signal's trap before sending the second. `waitFor(exited)` replaces
  `sleep 100; dead()`. `holdUntil` replaces `hangMs`. No new test waits a fixed time for correctness. The
  new spawns pass `env` explicitly, and the preflight suite pins the uid, so it passes as root.
- **Forward compatibility is done cleanly.** The stored schema is open, the patch schema stays strict, and
  every unknown value falls back the cautious way (`read-only`, Jev `off`, the key's default billing).
  `validate` warns with what each value is read as.
- **The TUI confirmations match Ruling 20.** The activate prompt carries its scope and re-asks with a
  "Changed since…" line. A discard rebases the history onto the file as it is on disk (each snapshot's
  patch is applied again over the new base). An unreadable file keeps the draft and shows a toast.
- **The live kit is concrete.** Each step gives the exact command and what to look for. It covers `codex
  login status` stream and wording (the plan's open UNVERIFIED item) and both outcomes of the sandbox
  probe.

## Issues

### Critical

None.

### Important

**I1. The first exit does not always win: a worker that ends while the idle check's `isBusy` call is in
flight is recorded as `idle-timeout`.**
`src/infra/supervisor.ts:196-200`.

- The loop checks `done` once, before the limit checks. The idle branch then awaits
  `bounded(() => hooks.isBusy?.(thread, started), hookMs, false)`, which can take up to
  `hookMs = min(10 s, idleMs)`. For opencode this is two `opencode api` calls.
- If the worker exits during that await and `isBusy` answers false, the loop sets
  `reason = "idle-timeout"`. After the loop, `reason !== null && !done` is false, so nothing is signalled.
  But `finish()` records `reason: "idle-timeout"` with the worker's real exit code.
- Every adapter's `finalize` maps `idle-timeout` to status `timeout` before it looks at the exit code or
  the reply (for example `src/adapters/opencode/index.ts:136-140`). A run that finished successfully is
  then recorded as timed out.
- This is exactly Review Focus 1 ("or its idle or wall limit arrives … recorded as it ended"). The
  window is narrow (an opencode run silent for `idleMs` that ends during the busy probe), but it can
  happen, and the fix is one line.
- **Fix:** after the await, re-check before choosing a reason:
  ```ts
  else if (now - lastActivity >= spec.idleMs) {
    const busy = open.size > 0 || (await bounded(() => hooks.isBusy?.(thread, started), hookMs, false));
    if (done) break; // it ended on its own while we asked
    if (busy) lastActivity = Date.now();
    else reason = "idle-timeout";
  }
  ```
  Add a test with an `isBusy` hook that writes a file the worker waits on, then awaits the worker's exit
  before returning `false`. Expect `reason: "exited"`.

**I2. MIGRATION.md tells users to delete 1.0's own data folders.**
`MIGRATION.md`, "What it leaves alone".

- The doc says: "every folder except `repos`, `logs`, `locks` and `discovery` is 0.x run data; delete it
  when you no longer need it."
- 1.0 also keeps `codex-home/` in the same data directory (`src/adapters/codex/home.ts:18`). It holds the
  isolated Codex home, with the sessions an isolated thread resumes from and the `generated_images/` that
  `finalize` reads (`src/adapters/codex/index.ts:85`).
- 1.0 also keeps `opencode-home/` (`src/adapters/opencode/agents.ts:68`), the isolated opencode config
  root.
- A user who follows the doc loses isolated Codex threads, and breaks a run in flight if one is running.
  MIGRATION.md accuracy is a stated focus for the release PR.
- **Fix:** name all six 1.0 folders ("except `repos`, `logs`, `locks`, `discovery`, `codex-home` and
  `opencode-home`"). Better, list what 0.x left: 0.x kept runs at `<data>/<repo-slug>/`
  (`f0ee214:src/paths.ts` `runsRoot`), so "the folders named after your repositories' paths (such as
  `home-you-src-app`) are 0.x runs". Keep this list in step with `src/infra/paths.ts` and the adapters'
  isolated homes.

### Minor

**M1. The release PR is merged without any CI, and the marketplace points at 1.0.0 before npm has it.**
`.github/workflows/release.yml`. This extends the deferred T10 item.

- The version PR opened with `GITHUB_TOKEN` gets no `pull_request` run. Its merge lands the stamped
  `plugin/.mcp.json` (`catherd-cli@1.0.0`) on `main`, which is the marketplace branch.
- CI then runs, taking minutes, and only then does the package publish. During that window, and forever
  if a matrix leg fails on `main` (for example a pty flake on macOS), `claude plugin update` installs a
  plugin whose `bunx catherd-cli@1.0.0` does not resolve.
- Publishing itself is correctly gated, so nothing broken reaches npm. This is the design in Ruling 2.
- **Fix, owner's choice, not blocking:**
  - Close and reopen the release PR (a human event triggers `pull_request` CI) and wait for green before
    merging.
  - Or give `changesets/action` a PAT or GitHub App token so the PR gets CI.
  - Note it in the handoff either way.

**M2. The doctor billing warning fires for a backend no profile uses.**
`src/services/doctor.ts:143-155`.

- Every profile resolves `billing.codex` to the default `chatgpt-plan`.
- A user who has Codex logged in with an API key but routes nothing to Codex gets `! billing` on the
  `codex` row. The row tells them to set a profile value that has no effect on their runs.
- It is harmless, since `warn` does not change the exit code, but it is noise.
- **Fix:** only compare when `used.has(id)`, or when the profile's stored doc sets `billing.<id>`
  explicitly. Name every mismatching profile, not only the first (this overlaps the deferred T8 item).

**M3. Two doc comments are stacked on `validateProfile`.**
`src/domain/profile-rules.ts:~62-70`. The old one ("…a stand-in that never runs.") now floats above the
new one. Trivial: merge the two comments. Worth doing in the same fix commit as I1 and I2.

**M4. A Ctrl-C does not reach an in-flight `runCli` child anymore.**
`src/adapters/cli.ts:29` (`detached: true`). This is the deferred T2 item, made more precise here.

- The child is in its own process group, so the terminal's SIGINT misses it.
- The CLI's SIGINT handler calls `process.exit(130)`, which also drops the `setTimeout` that would have
  killed it.
- A wedged probe (`codex login status`, `opencode api …`) started by `catherd doctor` or the TUI then
  outlives catherd with no time limit. Before this change, it died with the terminal's SIGINT.
- **Fix (1.0.x):** keep a module-level set of live `runCli` pids and `killGroup` them on process `exit`.
  An `exit` listener runs synchronously even after `process.exit`.

## Deferred-minors triage

| Item | Decision | Why |
|---|---|---|
| T1: `supervisor.ts` race `Bun.sleep(killGraceMs)` not cleared, so `_supervise` lingers ≤ 10 s | Stay deferred (1.0.x) | `exit.json` is already written; nothing waits for the supervisor pid to die. Fix with a cleared `setTimeout` when convenient. |
| T1: an ignored `interrupt` gets two kill graces (20 s before SIGKILL) | Stay deferred | Only for opencode with an unresponsive service; bounded; the spec's order (interrupt, then SIGTERM, then SIGKILL after 10 s) holds. |
| T3: test uses `pgid = process.pid` in the "never signals" case | Stay deferred | Dangerous only if the code regresses, and the test would then fail loudly. Swap in the pgid of a spawned sleeper in 1.0.x. |
| T3: `scrubOldSpecs` stats every `spec.json` on each MCP start | Stay deferred | One `stat` per dispatch per server start; cheap at realistic run counts. |
| T4: `toolOf` returns null for an output-validation message | Stay deferred | The log row still says `ok: false` with its code; only the tool name is missing. |
| T5: an unreadable `credentials.json` warns on every `jevKey()` call | Stay deferred | Log noise only, and the doctor row is the user-facing signal. Memoize per process in 1.0.x. |
| T6: the TUI's validate does not pass the stored doc (no unknown-value warnings in the TUI) | Stay deferred | The CLI's `validate` and `doctor` warn; values are still read cautiously and kept. Ruling said 1.0.x. |
| T6: `DEFAULT_BILLING[key]` without an own-property check | Stay deferred | Reachable only with a hand-written billing key like `constructor` holding an unknown value. |
| T6: orphaned JSDoc on `validateProfile` | **Fix with I1/I2** (M3) | Trivial, in a file already being touched. |
| T10: the release PR gets no `pull_request` CI | Stay deferred, **documented** (M1) | Publishing is still gated by `release.yml`'s `needs: ci`. The owner should re-trigger CI on the release PR before merging. |
| T10: pack-smoke temp dir not deleted; raw stack on non-JSON doctor output | Stay deferred | CI runners are ephemeral; the failure is still a failure. |
| T13: a bare `<leader>` key is not refused | Stay deferred | Goes with the 1.0.x key-syntax check (the "Not in this plan" item). |
| T14: revert when the profile was deleted, and re-ask when the repo is already bound to the same profile, are untested | Stay deferred | Both follow code paths that are covered (the error toast, and the "already" toast in `askActivate`). |
| T2: detached `runCli` means Ctrl-C does not reach in-flight queries | Stay deferred (M4) | Needs an exit hook; only wedged CLIs are affected. |
| T2: the Codex `sh` doc comment | Stay deferred | Still accurate enough. |
| T7: `run-debug` `tail` is quadratic on a very long last line | Stay deferred | Needs a many-MB line without a newline. Cap `buf` (for example at 1 MB) in 1.0.x. |
| T7: the `cli.test` `--plain lock` `finally` reads a pid file that may be missing | Stay deferred | Masks the real failure message only when the test already fails. |
| T8: stdout path untested; mismatch names only the first profile; fallback fix wording; the unreadable-credentials test does not check the detail | Stay deferred | Cosmetic or coverage gaps; the behaviour is right. |
| T11: the capture timeout test does not prove the group kill; capture leaves group members after a normal exit; long lines in the doc | Stay deferred | Owner-run tool; `killGroup` itself is tested elsewhere; `format:check` passes. |

## Declined to judge

- **Branch protection on `main`:** repository settings, not visible from code. It decides whether M1's
  release PR can be merged at all.
- **Whether `bunx changeset publish` with npm OIDC trusted publishing works:** the publish steps predate
  this plan (they published 0.1.0 and 0.2.x), and this plan only added `needs: ci`.
- **`changesets/action@v2`, `actions/checkout@v7`, `setup-node@v7` inputs and versions:** unchanged
  apart from the gate, and the plan read `action.yml`.
- **`config.json` without a `"schema"` field being moved aside by `init` as 0.x:** a hand-written
  `{"keybinds":…}` file is affected. This is plan 5/6 behaviour and a user of `init` output already has
  `schema: 1`.
- **claude's `--safe-mode` and Codex's `codex sandbox <os> --full-auto` on real CLIs:** marked
  UNVERIFIED in the plan and assigned to the owner's live kit.
- **Whether `codex login status` prints on stdout or stderr:** the adapter reads both; the live kit step
  1 records it.
- **Plan 1–5 minors listed under "Not in this plan":** explicitly 1.0.x by the plan.
- **`IS_SANDBOX=0` counting as a sandbox (any non-empty value):** mirrors the claude-code adapter's
  existing rule (plan 3); consistency is the plan's stated choice.
- **Whether the live kit is run before or after merging the release PR:** an open owner question in the
  ledger (default: before).
- **opencode's isolated `isBusy` against the background service:** 1.0.x per "Not in this plan".

## Verdict

**With fixes.** I1 (the idle-check race against Review Focus 1) and I2 (MIGRATION.md's deletion advice)
should land before the release PR is opened. Both are small, and M3 can ride along. Everything else is
safe to defer. The release gating, package contents, 1.0.0 changeset and cross-platform CI are sound and
were verified.
