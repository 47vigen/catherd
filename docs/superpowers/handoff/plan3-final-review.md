# Final review: plan 3 (claude-code and opencode v2 adapters), 6885432..bd64b93

Reviewer seat: whole-branch final review, plus the task reviews for Tasks 5, 7, 8, 10 and 11, a scoped re-review of the Task 6 fix rounds, a root cause for the intermittent dispatch test, and triage of the deferred items. The review was read-only. I did it in passes: the service and bridge diff, then each adapter, then capture and the live tests, then the tests.

**Method.** I extracted every fenced `ts` block from task briefs 5, 7, 8, 10 and 11 and compared each one, whitespace-normalised, with the file at HEAD.
- Every block matches the file exactly, with two expected exceptions:
  - The `src/adapters/opencode/index.ts` import line differs, because Task 8 adds `Tokens` to it.
  - The "replace this" old-text blocks no longer appear, because they were replaced.
- I read every source file the diff touches.
- `bun test` at HEAD gives 690 pass, 10 skip and 1 fail. The failure is the known `test/tui/theme.test.ts` one on Bun 1.3.11.

## Strengths

- **Claims are tied to evidence.** The opencode permission semantics are cited to opencode source file:line (`src/adapters/opencode/agents.ts:17-23`). The test ports `Wildcard.match`, `evaluate` and the any-deny rule line for line, instead of making up a matcher (`test/adapters/opencode-agents.test.ts:10-35`). Each escape is checked both split into commands and unsplit.
- **The no-shell ruling fixes the root cause.** It removes a whole class of problem (redirects that no rule can see) instead of adding more deny patterns. The skill tells orchestrators the consequence (`plugin/skills/catherd/SKILL.md:84`), and a test guards that line.
- **Service hooks are bounded and fail soft.**
  - `prepare` is capped at 60 s, with a stated rationale (`src/services/admission.ts:78-104`).
  - `settle` is cut off after 20 s and falls back to the stream outcome (`src/services/finalize.ts:77-114`).
  - Every CLI query goes through `runCli`, which requires a timeout, scrubs secrets and gives no stdin (`src/adapters/cli.ts:14-46`).
  - `supervise-bin` now exits explicitly, so a hung hook child cannot keep it alive (`src/entry/supervise-bin.ts:10-17`).
- **No secret reaches disk or argv.**
  - Briefs always go by `stdinPath`.
  - `plan().env` holds only `XDG_CONFIG_HOME` (opencode isolated) or nothing.
  - The discovery cache holds model ids only.
  - Captures pass through `sanitize` (secret values, key shapes, emails, home and tmp paths, longest first).
  - I grepped the committed claude-code and opencode fixtures. They contain no home paths, keys or emails, and `apiKeySource` is `"none"`.
- **claude-code full access as root is refused** before anything is written (`src/adapters/claude-code/index.ts:105-112`). It is allowed only under `IS_SANDBOX`, which matches the CLI's own rule. The root test really runs in this container (uid 0).
- **Isolated opencode never touches the user's config.** `prepare` writes agents only under `<data>/opencode-home/config` and skips `opencode reload` (`src/adapters/opencode/index.ts:100-102`). The run gets `--standalone` plus `XDG_CONFIG_HOME` (`:67,70`). Tests always run under a per-test `XDG_CONFIG_HOME` (`test/helpers.ts:10`).
- **Go→Zen requires the same model and the same variant** (`src/adapters/opencode/index.ts:221-227`). The stand-in then goes through admission again, and `prepare` re-checks the variant. A refusal becomes a `failover: … refused` hint, not a throw (`src/services/dispatch-service.ts:140-156`).
- **Stand-in resolution has one source of truth.** `standInFor` is used by both admission and failover (`src/services/backends.ts:35-47`).

## Issues

### Critical

None.

### Important

1. **opencode `limitRetry` looks at every message in the session, not the latest one** (`src/adapters/opencode/index.ts:169-176`, used at `:199` and `:212`).
   - **What happens.** The loop returns a limit for any message whose `retry.error` or `error` has type `provider.quota` or `provider.rate-limit`. Old completed messages keep their `error`.
   - **When it hurts.** Take a session that once hit a Go quota and is later resumed with the same `thread`. This is exactly the "paused: resume when the user says so" flow.
     - `isBusy` then always says not busy. A long silent tool step (a test suite, for example) is idle-killed after `idleMin`.
     - `settle` turns any later `failed` or `timeout` into `limit`. That triggers a spurious failover to metered Zen, or a false pause.
   - **Spec.** §6.3 says "an in-progress retry on **the latest** message".
   - **Fix.** Inspect only the newest assistant entry: skip a leading `{type:"idle"}` marker and take the first message. In `settle`, count it only if the message is newer than `run.startedAtMs`. Add a session test with an older errored message and a clean newest message, and expect "busy", respectively "failed".
2. **The claude-code read-only Bash allowlist has the same escapes the Task 6 review rated Important for catherd-ro** (`src/adapters/claude-code/index.ts:34`).
   - **What happens.** `Bash(rg *)` admits `rg --pre=<cmd>`, which is arbitrary execution. `Bash(git diff *)`, `Bash(git log *)` and `Bash(git show *)` admit `--output=<file>`, which is an arbitrary write, including outside the repo, where finalize's violation diff cannot see it.
   - **Why it matters.** Enforcement is advisory (spec §6.2), but after the no-shell ruling for opencode the two backends are inconsistent on a named risk.
   - **Fix.**
     - Drop `rg`, since the Grep tool covers search.
     - Add `--disallowedTools` entries for `Bash(* --output*)` and `Bash(*--pre*)`, after checking that claude 2.1.282 accepts a mid-pattern `*`. If it does not, also drop `git diff/log/show` from `READ_SHELL`.
     - Add a unit test on `CLAUDE_ACCESS["read-only"]`.
     - Owner: re-capture `read-only-write` live.
3. **The intermittent dispatch test has a wall-clock race in the test, not the code** (`test/services/dispatch.test.ts:139-141`). The root cause and fix are below. The fix is test-only and cheap, and without it CI will flake.

### Minor

1. `src/adapters/opencode/index.ts:209-218`: isolated runs execute on a `--standalone` server, but `isBusy` and `interrupt` call `opencode api` on the user's background service.
   - Totals still work, because the DB is shared (research §2.4).
   - `/api/session/active` there should not list a standalone session, so isolated runs are always "not busy", and the interrupt is likely a no-op. Stopping the run falls to the process-group kill.
   - The live cancel test (`test/live/opencode.live.test.ts:72`) runs isolated, so it does not exercise the "interrupted server-side" behaviour its name claims.
   - Fix: verify live. Either run that test non-isolated, or document that isolated runs rely on the group kill. → plan 7.
2. `src/adapters/opencode/index.ts:225`: the Go→Zen stand-in for `#default` is accepted without checking that both models' default variants match. The stand-in uses the same variant only in name. → plan 4.
3. `src/adapters/opencode/index.ts:105-113` with `src/adapters/discovery.ts:149`: when the re-list fails (it comes back empty) and the stale cache lacks `need`, `prepare` reports "opencode does not list X", although the real cause is that listing failed. Return `[]` or say that listing failed. → plan 4.
4. `src/services/capture.ts:82,86`: captures run non-isolated.
   - `prepare` installs catherd agents into the owner's real opencode config and runs `opencode reload`.
   - claude runs with the owner's hooks, plugins and MCP servers. The `system/init` event will list those names in fixtures meant for committing; `sanitize` does not strip them.
   - Fix: capture with `isolated: true` (claude `--safe-mode`, opencode standalone). → plan 7.
5. `src/services/capture.ts:102-118`:
   - A capture killed by the timeout is recorded with `reason: "exited"`. It should be `wall-timeout`.
   - `p.kill` hits only the direct child, which is the same `runCli` grandchild issue.
   - The meta JSON is sanitised after `JSON.stringify`, so a secret containing `"` or `\` would not match its escaped form.
   → plan 7.
6. `src/entry/capture-fixtures.ts:253`: a developer-only command that spends real tokens is exposed in the user CLI. Its `--out` default is relative to the cwd, so running it in a user's project writes `test/fixtures/` there. Hide it or require `--out`. → plan 7.
7. `src/adapters/opencode/agents.ts:17-28`: two consecutive JSDoc blocks. The first is orphaned and neither attaches to `OPENCODE_AGENT_FILES` cleanly. Merge them. Nit.
8. Test hygiene:
   - `test/fixtures/adapters/opencode/ro-denied.jsonl` was captured while catherd-ro still had a shell. Its shape is still valid, but no fixture shows a no-shell catherd-ro.
   - Its name also differs from capture's `read-only-write` case.
   - The prepare-timeout test uses 50 ms of real time (`test/services/adapter-hooks.test.ts:132`), against the §11 "no wall-clock sleeps" rule.
   - After a full run, two `test/sim/opencode api …` processes from `test/entry/supervise-bin.test.ts` (`apiHangMs: 30_000`) outlive the suite by about 30 s, because the orphaned hook children are never killed.
   → plan 7.
9. The opencode contract suite has no resume fixture and no retry fixture (§11.2). The retry signal is API-only by design (plan note 10). → plan 7, via capture.

## Declined to judge

- **`--safe-mode` and `--permission-prompts none` as real claude 2.1.282 flags.** Set aside: the plan writer's live verification is recorded, and I had no CLI. The simulator encodes them.
- **opencode `permissions:` frontmatter key and `opencode reload` semantics.** Same reason: recorded as verified on 2.0.16.
- **opencode's "retry surfaced early" read as idle-timeout plus `settle`, rather than a `retrying` delta.** This is an explicit, reasoned deviation in the plan (note 10). v2 prints nothing while it retries.
- **Session-total minus prior-records accounting for opencode.** Accepted by ruling. Rework is owned by plan 5.
- **`--auto` letting catherd-ro read `.env` inside the repo.** That is the user's repo data reaching the model, not a catherd secret reaching disk or argv. Out of scope for §10.4.

## Task verdicts (task reviewer seat)

| Task | Spec | Quality | Verdict |
|---|---|---|---|
| **T5** claude-code | ✅ Matches the brief byte for byte. §6.2 is met: `-p --output-format stream-json --verbose --model <full id> --effort`, brief on stdin, `--session-id`/`--resume`, per-access permission flags, totals from `result`, aliases refused. Isolation uses `--safe-mode` per the ruling. | Important 2 (read-only `rg`/`--output`). | **Pass with fix** |
| **T7** opencode v2 | ✅ §6.3 is met: v2 probe with the v2 installer fix, `run --format json --auto --agent … -m model#variant`, Zen and Go discovery with one retry, variants validated in `prepare`, Go→Zen default. | Minor 1–3. | **Pass** |
| **T8** session API and supervisor exit | ✅ Totals from `/api/session/<id>`, busy from `/active` (empty means not busy), `interrupt` by POST. `supervise-bin` exits. | Important 1 (`limitRetry` scans every message). | **Pass with fix** |
| **T10** capture-fixtures | ✅ §11.8 is met: real streams, secrets and home paths stripped, `test/fixtures/<backend>/<cli-version>/`. | Minor 4–6. | **Pass** |
| **T11** live tests | ✅ §11.7 per backend is met: claude-code on Haiku, opencode on `space-bunny-free`, gated by `CATHERD_LIVE`. The "tiny orchestrated run on a sample repo" is not in this plan. → plan 7. | Minor 1 (the isolated cancel test does not exercise the server-side interrupt). | **Pass** |

## Re-review: Task 6 fix rounds (7557995, d9d840c, c2d852a)

| Finding | Verdict | Evidence |
|---|---|---|
| T6 Important: the catherd-ro shell allowlist lets it write and exec (`rg --pre`, `git --output`, chaining) | **ADDRESSED** | 7557995 derived the real semantics from opencode source: last match wins, whole-resource wildcard, one resource per parsed command. It then found the residual list/pipeline redirect gap that no rule can close. c2d852a applies the ruling. catherd-ro is now `*:* deny`, then allow read/glob/grep/webfetch/websearch, then `edit * deny` and `shell * deny` (`agents.ts:30-42`). `opencode-agents.test.ts` shows all 17 escapes, the 8 former reads and `ls && cat a > b` denied, split and unsplit, with edit and subagent denied. The skill line is added and tested. |
| No-shell ruling (progress.md) | **ADDRESSED** | There is no shell allow rule, and a test asserts it. catherd-worker and catherd-full are unchanged, as ruled. |
| Folded T2 Minor: `prepare` has no timeout | **ADDRESSED** | `prepared()` races `prepare` against `prepareLimits.timeoutMs` (60 s) and refuses with `E_IO_UNEXPECTED` plus a fix naming the backend. Nothing is written on refusal (tested). A 60 s cap instead of 15 s is justified: the slowest bounded opencode path takes about 46.5 s. |

## The intermittent test: "keeps the lane's Owns as they were at admission…"

**Root cause: a wall-clock timing assumption in the test.** It is not shared state, and it is not a code race.

- The test starts `dispatch`, sleeps 100 ms, then rewrites `lanes/M1.L1.md` to `Owns: docs/` (`test/services/dispatch.test.ts:139-141`). It assumes admission has already read the Owns by then.
- Admission reads them at `src/services/admission.ts:138`, after `await readyAdapter("codex")` (`:133`).
- `beforeEach(resetReadiness)` forces that probe to run. The probe makes two sequential simulator spawns, `codex --version` and `codex login status`, and each one is a fresh `bun` process.

I measured the time from the start of `dispatch` until the dispatch is listed, using a scratch copy of the test:
- **88 ms** unloaded, only 12 ms under the test's 100 ms budget.
- **198–246 ms** with 6 busy loops on this 4-core box.

When admission is late, the rewrite lands first. Admission then correctly snapshots `docs/`, `src/a.ts` becomes a violation, and `changedOwned` is `[]`. In a full `bun test`, the load comes from detached supervisors and simulator children left by earlier files. For example, the `supervise-bin` test leaves `opencode api` sims alive for 30 s.

A second, rarer failure mode exists: `writeLane` uses a non-atomic `writeFileSync`. If it coincides with `laneOwns`' read, admission can see a torn file and throw `E_LANE_INVALID`.

**Reproduction:**
- Alone: 5/5 pass.
- Under CPU load: **10/10 fail**, with `Expected ["src/a.ts"]` and `Received []`.

**The code is correct.** Owns are snapshotted into `admit.json` at admission, and finalize uses `d.admit.owns`. An edit made before admission rightly takes effect.

**Fix (test only).** Wait for the admission record instead of sleeping:

```ts
const pending = dispatch(deps, input(run.id));
const d = await waitFor(() => listDispatches(run)[0]);   // admit.json written: Owns are fixed
expect(existsSync(dispatchPaths(d.dir).exit)).toBe(false); // the rewrite really is mid-run
writeLane(run, "M1.L1", ["docs/"]);
```

This needs `listDispatches` from `src/services/dispatches.ts` and `waitFor` from `./helpers.ts`. Optionally raise the simulator's `delayMs` from 400 to 1000 so the mid-run guard has margin. I verified this version in a scratch test: 8/8 pass under the same load, and the rewrite was mid-run every time.

## Triage of deferred items

| Item (source) | Decision | Owner |
|---|---|---|
| Important 1: `limitRetry` scans all messages (this review) | **MUST FIX BEFORE MERGE** | plan 3 |
| Important 2: claude-code read-only `rg`/`--output` (this review) | **MUST FIX BEFORE MERGE** (drop `rg` at least; the `--output` denies are subject to verifying the rule syntax) | plan 3 |
| Important 3: flaky Owns test (this review) | **MUST FIX BEFORE MERGE** (test-only) | plan 3 |
| Capture default dir: `test/fixtures/<backend>/<version>/` vs `test/fixtures/adapters/` (progress.md) | CAN WAIT. No capture is committed yet. Recommendation: default `--out test/fixtures/adapters`, so captures land at `test/fixtures/adapters/<backend>/<version>/` next to the curated contract fixtures they feed, away from the 0.x `test/fixtures/{codex,opencode}` that go with `src/core`. Amend §11.8 to match. Moving captures into `adapters/` would otherwise be a manual step. | 7 |
| T9: failover keys rewritten to `claude-code:` for native roles (W1, ruled) | CAN WAIT | 5 |
| T2: adapter stand-in admissible without `failoverFrom` (W1) | CAN WAIT (the budget still gates it) | 4 |
| T2: `failoverFor` throw not caught in `standInFor` (W1) | CAN WAIT (cheap; wrap in try) | 7 |
| T2: `prepare` outside the admission lock (W1) | CAN WAIT | 7 |
| T2: dead `claude` branch in `failover` (W1) | CAN WAIT | 5 |
| T2 and fix round: 50 ms real sleeps in hook tests (W1 and this review) | CAN WAIT | 7 |
| T4: stale fallback with no age cap, future `fetchedAt` reads fresh, `list()` throw not handled (W1), and Minor 3 here | CAN WAIT | 4 |
| T4: `runCli`, supervisor and capture kill only the direct child (W1, ruled), and the lingering sims | CAN WAIT | 7 |
| T6: `installAgents` non-atomic write (W1) | CAN WAIT (identical content, low odds) | 7 |
| T6: worker denies bypassable (`git -C . push`) (W1) | CAN WAIT (advisory; doctor warns) | 7 |
| T1: bare `-` before `--` not flagged; §11.2 fixture categories (codex too-old/resume, opencode resume/retry) (W1 and Minor 9) | CAN WAIT | 7 |
| T3: simulator gaps (claude positionals and `--`, `.model-calls` reset, opencode empty stdout with exit 0) (W1) | CAN WAIT | 7 |
| T9: bridge test tmpdir not cleaned (W1) | CAN WAIT | 7 |
| Minor 1: isolated opencode `isBusy` and `interrupt` target the background service | CAN WAIT (verify live) | 7 |
| Minor 2: Go→Zen `#default` variant equality | CAN WAIT | 4 |
| Minor 4–6: capture isolation, kill reason, CLI exposure | CAN WAIT | 7 |
| claude-code `isolated` is never set (the view has only codex and opencode) | CAN WAIT | 5 |
| Routing should know that read-only on opencode has no shell (reviewer "read the diff") | CAN WAIT | 4 |
| Carry-overs: supervise-bin exit, backend.ts env comment | Done (T8, T1) | — |

## Assessment

**Ready to merge: after fixes.** The fixes are Important 1–3: a few lines in `limitRetry`, `rg` dropped from claude-code read-only (with a unit test), and the Owns test waiting on `admit.json`.

**Reasoning.** The adapters match their briefs and spec §6.2, §6.3, §4.5 and D3, and the named risks hold: no secret in argv or on disk, root refused full access, isolated opencode config untouched, and the stand-in required to have the same model and variant. The Task 6 security finding is properly closed. Three small defects remain:
- one spec-visible bug that mis-classifies resumed opencode sessions,
- one read-only escape that is inconsistent with the Task 6 ruling,
- one test race that will flake CI.

All three are cheap to fix and should land before merge. Everything else can wait for plans 4, 5 and 7.
