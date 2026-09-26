# catherd 1.0 — Plan 7: hardening, a Linux and macOS CI matrix, live-test docs and the 1.0 release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the hardening items plans 1–5 deferred to plan 7 (the process model's races and identity checks, busy detection for quiet tool calls, preflight as root, the MCP log's missing rows, Jev's cached answers and unreadable key file, profiles written by a newer catherd, the CLI's signal handling), make the suite pass on macOS and run CI on {Linux, macOS} × {Bun 1.4.0, latest} with a coverage floor, an audit and an npm pack smoke, give the owner an exact live-verification kit, and release catherd-cli 1.0.0 through Changesets.

**Architecture:** No new layer and no new module in `src/` besides test helpers: each fix lands in the module that owns the behaviour (`src/infra/{proc,supervisor}.ts`, the adapters, `src/services/{dispatch-service,reconcile,preflight,jev-service,lane-service,doctor,capture,run-debug}.ts`, `src/domain/{profile,profile-rules}.ts`, `src/entry/{cli,mcp/*,capture-fixtures}.ts`). Two small interfaces grow: a stream line can tell the supervisor that a tool call opened or closed (`EventDelta.item`, `LineInfo.item`), and `isBusy` learns when the run started; a probe can say how a CLI is logged in (`Probe.login`, `Probe.billing`). CI is `.github/workflows/ci.yml` (a matrix job and a package job), which `release.yml` calls before the Changesets step, so nothing is published unless the whole matrix is green.

**Tech Stack:** Bun ≥ 1.4 (`bun test`, `bun pm pack`, `bun audit`, `bunfig.toml` coverage threshold), TypeScript 7 (`tsc --noEmit`), zod 4, citty 0.2, `@modelcontextprotocol/sdk` 1.30, oxlint, oxfmt, GitHub Actions (`oven-sh/setup-bun@v2`, `changesets/action@v2`), Dependabot, tmux (the TUI's PTY test). No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-09-25-catherd-1.0-design.md` — §3.3 (the process model), §3.4 (schemas, unknown fields), §6 (the backends: busy, interrupt, isolation), §10.2 (the log), §10.3 (`doctor`), §10.4 (preflight never as root, secrets), §11 (testing: live tests, fixture capture, hygiene and the coverage floor), §12 (CI and release) and §14 (risks), with D2 (the clean break) and D7 (live verification on the owner's machine). The carry-overs come from `docs/superpowers/handoff/HANDOFF.md` ("Plan 7 (hardening)"), `docs/superpowers/handoff/plan4-ledger.md`, the plan-5 ledger (`docs/superpowers/handoff/plan5-ledger.md` and the session ledger it was copied from) and the reviews they cite (`plan1-final-review.md`, `plan2-rereview-final.md`, `plan3-final-review.md`). Plans 1–6 (`docs/superpowers/plans/2026-09-2{5,6}-0*.md`) built everything this plan stands on; plan 6 (the TUI) lands before this plan runs.

## Global Constraints

- Runtime Bun ≥ 1.4, no build step; `.ts` files imported with explicit `.ts` extensions. "A runtime guard at startup checks `Bun.version >= 1.4.0` and exits 1 with the upgrade command." `bun run typecheck`, `bun run lint` (`oxlint --deny-warnings src test`) and `bun run format:check` (oxfmt, print width 110) stay clean after every task; run `bun run format` before checking. The code blocks below are shown formatted; `bun run format` settles any difference in wrapping.
- §3.1: "The dependency order, lowest first, is `domain` (pure types, schemas, errors, routing; no I/O) → `infra` → `adapters` → `services` → `entry`. A layer imports only from layers below it". "A backend is one folder under `src/adapters/<id>/` plus its fixtures. No other module names a backend." (`doctor` learns about a login only through the generic `Probe` fields.)
- §3.3: the supervisor "enforces the idle and wall timeouts (idle asks the adapter whether the run is busy first) and escalates SIGTERM → SIGKILL after 10 s, calling `adapter.interrupt` first when present"; "writes `exit.json` `{ code, signal, endedAt, reason: "exited"|"idle-timeout"|"wall-timeout"|"cancelled" }` atomically when the worker ends"; "`proc.json` `{ pid, pgid, startTime }` …, so a reused pid is never mistaken for the worker".
- §3.4: "Readers reject a newer schema with `E_CONFIG_NEWER_SCHEMA` and a "upgrade catherd" fix; unknown fields are preserved on rewrite."
- §6.3: "Totals from `opencode api GET /api/session/<id>` …; busy from `/api/session/active`; `interrupt` via `POST /api/session/<id>/interrupt`. Empty or failed API output counts as **not busy**." "an in-progress retry on the latest message is surfaced early".
- §10.2: "Logged: every MCP tool call with duration and outcome, every spawn (argv and env keys, never values), reconciles, Jev calls."
- §10.4: "Secrets never reach workers or logs; credential files are mode 600." "`preflight` runs with a timeout and a stripped env, lists its commands in the report, never as root, and can require confirmation."
- §11: "Live (`CATHERD_LIVE=1`, owner's machine): one cheap task per backend (Codex Luna low, claude-code Haiku, opencode `space-bunny-free` or Go) and one tiny orchestrated run on a sample repo." "Fixture capture: `catherd capture-fixtures` records real streams, strips secrets and home paths, and writes `test/fixtures/adapters/<backend>/<cli-version>/` by default (`--out`)." "Hygiene: no wall-clock sleeps (fake clock or deterministic flush), an isolated `CATHERD_HOME` per test, no global env mutation, a coverage floor in CI."
- §12: "CI matrix {ubuntu, macOS} × {Bun 1.4.0, latest}: typecheck, lint, format, all non-live tests, the architecture test, `tui-frames.md` freshness, dependency audit." "Releases through Changesets, gated on green CI; a marketplace tag per version; the plugin pins its exact package version." "`npm pack` smoke: install the tarball in an empty directory, run `--version`, `doctor --json`, and an MCP `initialize` + `tools/list` handshake." "OpenTUI is pinned exactly; other dependencies stay on latest with the lockfile and automated update PRs." "`MIGRATION.md` for 0.2 → 1.0: run `catherd init`; old run folders are not read."
- D2: "**Clean break.** 1.0 is a new major; `init` rebuilds everything; no 0.2 migration code." D7: "Live verification runs on the owner's machine (OpenCode Go, Claude plan, Codex with ChatGPT login) through a fixture-capture kit; CI runs on simulators and recorded fixtures."
- Tests: an isolated `CATHERD_HOME` per test (`withHome()` or `freshRun()`), `afterEach(snapshotEnv())` in every file that sets an env var, no network (backend CLIs are the simulators or `PATH=/nonexistent`; every test that reaches discovery deletes `ANTHROPIC_API_KEY`, or blanks it in a spawned process's env), never the real `~/.claude`. **A test that spawns a process passes `env` explicitly**: Bun hands a child its start-up environment, not later `process.env` changes. No test waits a fixed time for correctness: it waits on a file, a line of output or a process state with a deadline (`waitFor`), and a worker script may be slow on purpose, never the test.
- Other plans' ground: plan 6 lands first and owns `src/entry/tui/`; plan 7 touches nothing there, and `src/tui`, `src/core` and `src/routing` no longer exist. Plan 5's final fix wave also lands first and edits `src/services/profile-service.ts`, `src/services/doctor.ts`, `src/entry/mcp/setup-tools.ts`, `src/entry/prompt.ts`, `src/entry/profile-command.ts`, `src/entry/runs-command.ts` and `README.md`: in those files find each block to replace by its text, not its line number, and keep whatever that wave added around it.
- Commits: Conventional Commits, subjects ≤ 100 characters, never starting with a capital. Never commit a `bun.lock` rewritten by an older Bun. Style: short doc comments only where the why is not obvious.

## Review Focus

1. **A worker ends on its own at the moment the user cancels it, or its idle or wall limit arrives.** Expected: the run is recorded as it ended, with its exit code and reply, not as cancelled or timed out. Task 1 pins it: "records a worker that ended on its own as exited, though a cancel arrived after it ended".
2. **A Codex worker runs a long, silent command (a twenty-minute test suite prints nothing).** Expected: no idle kill while the command runs; the wall limit still applies. Task 1 pins the supervisor ("keeps a run with a tool call open busy, however quiet, and idles it once the call closes"); Task 2 pins it end to end through the real supervisor entry ("keeps a Codex run busy while a tool call it started is still running, however quiet").
3. **A profile written by a newer catherd carries a value this one does not know** (a new access mode, a new billing mode). Expected: every command still reads the profile, reads the value the cautious way, keeps it through any save, and `validate` says what it was read as. Task 6 pins it: "reads each one the cautious way instead of refusing the profile", "names each one with what it is read as, and keeps it through a patch", and through the service, "reads a profile a newer catherd wrote, warns about the values it does not know, and keeps them".
4. **catherd runs as root** (a container, a CI box). Expected: preflight never runs a lane's check as root; it says so in the report and does not block the run. Task 4 pins it: "never runs a check as root, unless IS_SANDBOX says the machine is disposable (spec §10.4)".
5. **`credentials.json` is corrupt or was written by a newer catherd.** Expected: routing goes on without Jev (it is optional), the log says why, and `catherd doctor` names the file and the fix instead of a bare "no key". Task 5 pins the service ("reads an unreadable credentials file as no key, logs why, and names the problem"); Task 8 pins the doctor row ("warns on a credentials file it cannot read, which Jev takes for no key").

## Rulings on the spec

1. **CI's Bun versions follow §12: `1.4.0` and `latest`.** The spec asks for both, so neither is pinned away: `1.4.0` is the floor the runtime guard accepts (a test on it proves the floor), and `latest` meets a new Bun before users do; `bun.lock` keeps every other version fixed. The release job uses `latest` too: it only installs and runs Changesets, after the whole matrix passed.
2. **Release is gated on CI by calling it.** `ci.yml` runs on pull requests and as a reusable workflow (`workflow_call`); `release.yml` calls it as its first job and the Changesets step `needs` it. Pushes to `main` run CI once, inside Release. The "marketplace tag per version" is the `v<version>` tag and GitHub release that `changesets/action` pushes when it publishes; the marketplace itself stays on the default branch, whose `plugin/.mcp.json` the version PR stamps with the exact package version.
3. **The exit a worker reached first is the one recorded.** In the supervisor's loop, a worker whose exit is already known when the loop wakes is recorded as `exited`, even if a cancel file or a limit appeared during the same poll. After a server-side `interrupt`, the CLI gets the kill grace to end by itself before any signal (the test at `supervisor.test.ts:172` becomes deterministic this way: the worker has seconds, not 100 ms). The orphan side (the supervisor already dead, the worker ends between `cancel`'s request and its check) stays `cancelled`, as plan 2's re-review judged: no supervisor saw an exit code, and the user asked for the cancel.
4. **A quiet tool call keeps a run busy.** A stream line may open or close a tool call (`EventDelta.item: { id, open }`); the supervisor keeps the open ids and treats a run with one open as busy without asking the adapter. Codex reports `item.started` / `item.completed`. A tool call that never closes leaves only the wall limit (90 minutes by default) to stop the run: that is the spec's "idle asks whether busy", and the wall limit is the backstop.
5. **opencode's busy check reads the newest assistant message, from this run only.** `isBusy(thread, cwd, sinceMs)` gets the run's start from the supervisor; a usage limit on a message older than the run no longer makes a resumed session look idle, and entries before the newest assistant message (an `idle` marker, a user message) are skipped.
6. **`runCli` runs each CLI in its own process group** and kills the group on its timeout, so a grandchild holding the pipes dies with it; the Codex adapter's own copy of that function is replaced by `runCli` (it gains `cwd`). `capture-fixtures` kills its run's group the same way.
7. **An orphaned worker catherd cannot identify is never signalled.** Without a recorded start time, or with a `pgid` other than the worker's own pid (a proc.json that is corrupt or edited), `cancel` writes the `cancelled` exit.json with `signal: null` and signals nothing: the pid may be someone else's by now. When it does signal, it signals the worker's own group and records the last signal it sent (`SIGKILL` after the grace), not always `SIGTERM`.
8. **A start time that cannot be read now counts as the same process** (`sameProcess`): on macOS `ps` can fail for a moment, and a live lock holder or worker must not be taken for dead. The cost is a lock that times out with `E_IO_LOCK` rather than a second holder.
9. **Preflight never runs a check as root.** As root, each lane with a check is `skipped` with a note naming spec §10.4 and the fix, which does not block the run. `IS_SANDBOX` (set on a disposable machine) is the one exception, the same rule the claude-code adapter applies to full access as root (plan 3).
10. **An unknown tool stays `E_INPUT_INVALID`,** with a fix that fits it: call a tool the server lists, or update the plugin with catherd (a skill from a newer catherd). No new error code for one message. Every call the SDK rejects before a handler runs gets its `tool` log row (tool name parsed from the SDK's message, no duration, since none was measured).
11. **An unreadable `credentials.json` means no key, loudly.** `jevKey()` still returns null (Jev is optional, D1), logs a `warn` `jev` row, and `savedJevKey()` hands the error to `doctor`, whose `credentials` row becomes `! unreadable` with the reader's own fix (`fix or delete <file>`).
12. **Logged Jev answers are checked like fresh ones.** A cached row whose answers do not pass `parseReply` (hand-edited, cut short, a different question set) is skipped and Jev is asked again.
13. **A milestone name no routed lane starts with is a hint, not an error:** `land` records the ledger row as before and adds `land: no routed lane is in milestone "<m>" (routed: …); check its name: no lane outcome was recorded`, when the run has routed lanes and none matched.
14. **Stored enum values are open; each is read the cautious way** (spec §3.4's forward compatibility). The stored schema takes any string for `objective`, `jev.use`, `billing.*`, `roles.*.access` and `notify[]`; `resolveProfile` reads an unknown `access` as `read-only`, `jev.use` as `off` (no lane text leaves the machine on a setting this catherd cannot read), a billing mode as the key's default (`metered` for a key with none), `objective` as `cost`, and skips an unknown notify moment; `validate` warns for each; the patch schema stays strict, so catherd itself only writes values it knows.
15. **The 1.0 package contents are right once plan 6 adds `THIRD_PARTY_NOTICES.md` to `files`.** `bin` (`src/cli.ts` with a `bun` shebang), `engines` (`bun >=1.4`) and `files` (`src`, `catalog`, `plugin`, plus npm's own `package.json`, `README.md`, `LICENSE`) carry everything the CLI, the supervisor entry and the plugin read at runtime; `CHANGELOG.md` and `MIGRATION.md` stay on GitHub, not in the tarball. The pack smoke checks the list on every CI run.
16. **Coverage floor: 88 % of lines and 85 % of functions** in `bunfig.toml`, checked on the Linux/latest leg with `bun test --coverage`. The suite measured 93.7 % of lines and 90.8 % of functions (plans 1–5 with Tasks 1–9 applied, before plan 6). Plan 6 replaces the TUI and its tests: if the floor fails after plan 6, set each value to the measured one minus two points, rounded down to a whole percent, in the same task.
17. **Dependabot** opens weekly update PRs for Bun dependencies (grouped) and GitHub Actions, with Conventional Commit prefixes; `@opentui/*` is ignored, since an OpenTUI update means regenerating the TUI frames by hand.
18. **`capture-fixtures` records isolated runs** (Codex in catherd's own `CODEX_HOME`, claude with `--safe-mode`, opencode on a standalone server), since its output is committed; a run past the timeout is recorded with reason `wall-timeout`; the meta file's strings are sanitized before JSON escapes them. Its default `--out` is the catherd checkout's own `test/fixtures/adapters` wherever it runs from; an installed package has no such folder and asks for `--out` (exit 2).
19. **`doctor` reports how Codex is logged in** from `codex login status` (`ChatGPT` or `API key`, never the key), and warns when a linked profile bills Codex as something else than that login implies (`chatgpt-plan` against an API key, which bills per token). The check already refreshed discovery and tested the Jev key (plan 5): that part was done.

## Verified facts this plan relies on

- **Every task was built and run in a scratch copy of `main` at `e1ffa6c`** (plans 1–5), in the order 1–12, each task's new tests seen failing without its source change and passing with it. At the end, on Bun 1.4.2: `bun run typecheck`, `bun run lint` and `bun run format:check` clean, `bun test` 956 pass, 10 skip, 0 fail. The same tree on **Bun 1.4.0** (the release zip, with the `bunx` link that `setup-bun` installs): 956 pass, 0 fail.
- **macOS was not available.** Its temp dir is behind a symlink (`/var` → `/private/var`); running the suite with `TMPDIR` pointing through a symlink reproduces that class: 12 tests failed on `e1ffa6c` (paths compared unresolved) and none fail after Task 9. `/proc`, `setsid` and `ps` differences were found by reading every test: Task 9 covers each. **UNVERIFIED on a real Mac:** anything else macOS does differently; the CI matrix is where that shows first.
- `actionlint` 1.7.7 reports nothing on the new `ci.yml` and `release.yml`. `changesets/action@v2`'s inputs (`version-script`, `publish-script`, `pr-title`, `commit-message`, `create-github-releases` default true) were read from its `action.yml`.
- The pack smoke ran here: `bun pm pack` → `bun add <tarball>` in an empty project → `catherd --version` and `catherd doctor --json`, whose `mcp` row answered `tools/list` with 20 tools (with a stand-in `THIRD_PARTY_NOTICES.md`, which plan 6 creates). `bun audit` (Bun 1.4.2) finds no advisory. A `coverageThreshold` in `bunfig.toml` makes `bun test --coverage` exit 1 below it and changes nothing without `--coverage`.
- `bunx changeset status` lists `catherd-cli` for a major bump; `bun run version-packages` then writes `1.0.0` to `package.json`, `plugin/.claude-plugin/plugin.json`, `plugin/.mcp.json` and the skill, and a `## 1.0.0` / `### Major Changes` entry to `CHANGELOG.md` (tried and undone; the release PR does it for real).
- The SDK (`@modelcontextprotocol/sdk` 1.30.1) reports a call it rejects before any handler through `createToolError(message)` with the texts `Tool <name> not found`, `Tool <name> disabled` and `Input validation error: Invalid arguments for tool <name>: …` (`dist/esm/server/mcp.js`).
- 0.x linked agents from `<config>/agents/<profile>/` into `~/.claude/agents` as `catherd-<role>-<model>-<effort>.md` (read at `f0ee214:src/profile/agents.ts`), so 1.0's relink prunes them as catherd's own links; 0.x also read the Jev key from `~/.config/typesafe/api_key` (`f0ee214:src/routing/jev.ts`), which 1.0 does not.
- **UNVERIFIED:** whether `codex login status` prints on stdout or stderr (codex-rs prints the login lines with `eprintln!` as far as this writer knows; the adapter reads both, the simulator uses stderr), and `codex sandbox <os> --full-auto` on a real Codex CLI (plan 5's note): `docs/live-verification.md` has the owner check both.

## File Structure

```
src/infra/proc.ts                       (modify) sameProcess: a start time that cannot be read counts as the same process
src/infra/supervisor.ts                 (modify) LineInfo.item (open tool calls), isBusy(thread, sinceMs), exit wins a late cancel, grace after interrupt
src/adapters/backend.ts                 (modify) EventDelta.item; isBusy(…, sinceMs); Probe.login, Probe.billing
src/adapters/cli.ts                     (modify) runCli: own process group, killed whole on timeout; cwd
src/adapters/codex/index.ts             (modify) sh through runCli; parse reports item.started/completed; probe reports the login
src/adapters/opencode/index.ts          (modify) isBusy reads the newest assistant message of this run
src/entry/supervise.ts                  (modify) passes item and the run's start to the supervisor
src/services/dispatch-service.ts        (modify) stopOrphan: identified workers only, the signal recorded; orphanLimits
src/services/reconcile.ts               (modify) scrubOldSpecs
src/services/preflight.ts               (modify) never as root (preflightUser)
src/entry/mcp/result.ts, server.ts      (modify) toolOf, the unknown tool's fix; a log row for every SDK-rejected call
src/services/jev-service.ts             (modify) savedJevKey; jevKey logs an unreadable file; cached answers checked
src/services/lane-service.ts            (modify) land's milestone hint
src/domain/profile.ts                   (modify) stored enums open, STORED_FALLBACK, unknownValues
src/domain/profile-rules.ts             (modify) validateProfile(p, c, backends, doc?) warns on unknown values
src/services/profile-service.ts         (modify) validateNamed and validate pass the stored document
src/cli.ts                              (modify) the Ctrl-C exemption keys on the command, not argv[0]
src/services/run-debug.ts               (modify) tail reads from the end
src/services/doctor.ts                  (modify) the login and billing on backend rows; credentials unreadable
src/services/capture.ts                 (modify) isolated, group kill, wall-timeout reason, meta sanitized before JSON
src/entry/capture-fixtures.ts           (modify) defaultOut: the checkout's fixtures, else --out is required
.github/workflows/ci.yml                (replace) the matrix job and the package job
.github/workflows/release.yml           (replace) calls ci.yml first
.github/dependabot.yml, bunfig.toml     (new)
.changeset/catherd-1-0.md, MIGRATION.md, docs/live-verification.md   (new)
docs/manual-tests.md, README.md         (modify)
test/helpers.ts                         (modify) exited(pid), tempDir(prefix); tempRepo by its real path
test/pack-smoke.ts                      (new) the npm pack smoke CI runs (not a bun test file)
test/sim/{codex,scenario.ts}            (modify) holdUntil; login state on stderr, the API-key login
test/adapters/cli.test.ts, test/services/run-debug.test.ts   (new)
test/{infra,adapters,services,entry,sim,domain,integration}/…   (modify) as each task says
```

## Parallelism

Tasks that share no files and whose inputs exist can run in parallel worktrees; each merges before its dependents start.

| Wave | Tasks | Needs |
|---|---|---|
| 1 | 1 (supervisor, proc), 3 (orphan cancel, old specs), 4 (preflight root, MCP log), 5 (Jev, land), 6 (profile values), 10 (CI) | plans 1–6 |
| 2 | 2 (adapters: busy, runCli) | 1 (`LineInfo`, `isBusy(thread, sinceMs)`) |
| 3 | 7 (CLI signals, run-debug), 8 (doctor: login, credentials) | 7: 2 (`exited`) · 8: 2 (`codex/index.ts`, `backend.ts`), 3 (`test/sim/codex`, `scenario.ts`), 5 (`savedJevKey`) |
| 4 | 9 (macOS), 11 (capture, live docs) | 9: 1, 2, 4, 8 (the files it edits) · 11: 8 (the docs name doctor's login row) |
| 5 | 12 (release 1.0) | every task: it releases them |

Task 10's `ci.yml` needs nothing else to exist, but its first macOS run is only green once Task 9 is in; merge 10 before 9 if you like, and expect the macOS legs red until 9 lands. Tasks 2 and 8 both edit `src/adapters/backend.ts` and `src/adapters/codex/index.ts` (different blocks; 2 first). Tasks 3 and 8 both edit `test/sim/codex` and `test/sim/scenario.ts` (different blocks). Tasks 4 and 9 both edit `test/services/preflight.test.ts` (different tests). Tasks 1 and 9 both edit `test/infra/supervisor.test.ts` (9 after 1).

---

### Task 1: The supervisor: the first exit wins, quiet tool calls stay busy, a grace after interrupt; `ps` failures

Spec §3.3 and Rulings 3, 4 and 8. Four carry-overs meet in `src/infra/supervisor.ts` and `src/infra/proc.ts`: the cancel/exit race (a worker that exits during a poll was recorded `cancelled` when a cancel file appeared in the same poll), Codex's missing busy signal (the supervisor half: a line can open or close a tool call), the timing window in `supervisor.test.ts:172` (the test gave a worker 100 ms to leave after an interrupt; the supervisor now gives it the kill grace, waiting on its exit rather than a clock) and plan 1's "a transient `ps` failure makes a live process look dead". `isBusy` also learns when the run started, for opencode (Task 2).

**Files:**
- Modify: `src/infra/proc.ts`, `src/infra/supervisor.ts`
- Test: `test/infra/proc.test.ts`, `test/infra/supervisor.test.ts`

**Interfaces:**
- Consumes: `waitFor` (`test/services/helpers.ts`).
- Produces: `sameProcess(recorded: string | null, current: string | null): boolean` (`src/infra/proc.ts`); `interface LineInfo { final?: boolean; thread?: string; item?: { id: string; open: boolean } }` and `SuperviseHooks { onLine?(line): LineInfo; isBusy?(thread: string | null, sinceMs: number): Promise<boolean>; interrupt?(thread) }` (`src/infra/supervisor.ts`). Task 2 wires the adapters to them.

- [ ] **Step 1: Write the failing tests**

In `test/infra/proc.test.ts`, replace:

```ts
import { describe, expect, it, spyOn } from "bun:test";
import { isAlive, killGroup, processStartTime } from "../../src/infra/proc.ts";

describe("proc", () => {
  it("identifies a live process by pid and start time", () => {
```

with:

```ts
import { describe, expect, it, spyOn } from "bun:test";
import { isAlive, killGroup, processStartTime, sameProcess } from "../../src/infra/proc.ts";

describe("proc", () => {
  it("identifies a live process by pid and start time", () => {
```

In `test/infra/proc.test.ts`, replace:

```ts
    expect(isAlive(process.pid, "0-not-the-real-start")).toBe(false);
  });

  it("reports a dead pid as not alive", async () => {
    const p = Bun.spawn(["true"]);
    await p.exited;
```

with:

```ts
    expect(isAlive(process.pid, "0-not-the-real-start")).toBe(false);
  });

  it("takes a live pid whose start time cannot be read now for the same process (a transient ps failure)", () => {
    expect(sameProcess("Mon Sep 28 10:00:00 2026", null)).toBe(true);
    expect(sameProcess("Mon Sep 28 10:00:00 2026", "Mon Sep 28 10:00:00 2026")).toBe(true);
    expect(sameProcess("Mon Sep 28 10:00:00 2026", "Mon Sep 28 10:05:00 2026")).toBe(false);
    expect(sameProcess(null, "anything")).toBe(true);
  });

  it("reports a dead pid as not alive", async () => {
    const p = Bun.spawn(["true"]);
    await p.exited;
```

In `test/infra/supervisor.test.ts`, replace:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchPaths, readExit, requestCancel } from "../../src/infra/dispatch-dir.ts";
import { type SuperviseSpec, supervise } from "../../src/infra/supervisor.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());
// the supervisor logs each spawn (spec §10.2): keep the rows out of the real data dir
```

with:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchPaths, readExit, requestCancel } from "../../src/infra/dispatch-dir.ts";
import { type SuperviseSpec, supervise } from "../../src/infra/supervisor.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { waitFor } from "../services/helpers.ts";

afterEach(snapshotEnv());
// the supervisor logs each spawn (spec §10.2): keep the rows out of the real data dir
```

In `test/infra/supervisor.test.ts`, replace:

```ts
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("does not kill a worker that exited while being interrupted", async () => {
    const s = spec(`while [ ! -f stop ]; do sleep 0.02; done; exit 7`, { idleMs: 100, killGraceMs: 2000 });
    const exit = await supervise(s, {
      interrupt: async () => {
        writeFileSync(join(s.dispatchDir, "stop"), "");
        await Bun.sleep(300);
      },
    });
    expect(exit).toMatchObject({ code: 7, signal: null, reason: "idle-timeout" });
  });
});

describe("supervise signals the whole group", () => {
  it("SIGKILLs a group member that ignores SIGTERM even when the leader exits", async () => {
    const s = spec(`(trap '' TERM; sleep 30) & echo $!; sleep 30`, { killGraceMs: 150 });
```

with:

```ts
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("gives an interrupted worker the kill grace to end on its own, and sends no signal when it does", async () => {
    const s = spec(`while [ ! -f stop ]; do sleep 0.02; done; exit 7`, { idleMs: 100, killGraceMs: 10_000 });
    const t0 = Date.now();
    const exit = await supervise(s, {
      interrupt: async () => writeFileSync(join(s.dispatchDir, "stop"), ""),
    });
    expect(exit).toMatchObject({ code: 7, signal: null, reason: "idle-timeout" });
    // it ended when the worker did, not when the grace ran out
    expect(Date.now() - t0).toBeLessThan(5_000);
  });
});

describe("supervise follows the worker's own account", () => {
  it("keeps a run with a tool call open busy, however quiet, and idles it once the call closes", async () => {
    const s = spec("echo open; sleep 0.5; echo close; sleep 30", { idleMs: 100 });
    const seen: string[] = [];
    const exit = await supervise(s, {
      onLine: (l) => {
        seen.push(l);
        return l === "open" || l === "close" ? { item: { id: "item_1", open: l === "open" } } : {};
      },
    });
    expect(exit.reason).toBe("idle-timeout");
    // the idle limit (100 ms) passed five times while the call was open, and the run lived on
    expect(seen).toEqual(["open", "close"]);
  });

  it("asks isBusy with the time the run started", async () => {
    const t0 = Date.now();
    let since = 0;
    await supervise(spec("sleep 30", { idleMs: 100 }), {
      isBusy: async (_thread, sinceMs) => {
        since = sinceMs;
        return false;
      },
    });
    expect(since).toBeGreaterThanOrEqual(t0);
    expect(since).toBeLessThanOrEqual(Date.now());
  });

  it("records a worker that ended on its own as exited, though a cancel arrived after it ended", async () => {
    const s = spec("exit 5", { pollMs: 200 });
    const running = supervise(s);
    const proc = dispatchPaths(s.dispatchDir).proc;
    const { pid } = await waitFor(
      () => existsSync(proc) && (JSON.parse(readFileSync(proc, "utf8")) as { pid: number }),
    );
    // reaped: this process runs the supervisor, so its exit is already known to it
    await waitFor(() => gone(pid));
    requestCancel(s.dispatchDir);
    expect(await running).toMatchObject({ code: 5, signal: null, reason: "exited" });
  });
});

/** True once `pid` no longer exists at all (reaped). */
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

describe("supervise signals the whole group", () => {
  it("SIGKILLs a group member that ignores SIGTERM even when the leader exits", async () => {
    const s = spec(`(trap '' TERM; sleep 30) & echo $!; sleep 30`, { killGraceMs: 150 });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/infra/supervisor.test.ts test/infra/proc.test.ts`
Expected: FAIL — `proc.test.ts` cannot import `sameProcess`; in `supervisor.test.ts` the interrupted worker is killed after 100 ms (`signal: "SIGTERM"` instead of `code: 7`), the quiet tool call is idle-killed before `close` (`seen` is `["open"]`), `isBusy` gets no start time, and the worker that exited is recorded `cancelled`.

- [ ] **Step 3: Write the implementation**

In `src/infra/proc.ts`, replace:

```ts
 */
export const isValidPid = (pid: unknown): pid is number => Number.isInteger(pid) && (pid as number) >= 1;

export function isAlive(pid: number, startTime: string | null): boolean {
  if (!isValidPid(pid)) return false;
  try {
```

with:

```ts
 */
export const isValidPid = (pid: unknown): pid is number => Number.isInteger(pid) && (pid as number) >= 1;

/**
 * Whether a live pid is still the process recorded with `recorded`. A start time that cannot be read now
 * (`ps` fails for a moment on macOS) counts as the same process: a live lock holder or worker is never
 * taken for dead, and the worst case is a lock that times out with E_IO_LOCK instead.
 */
export const sameProcess = (recorded: string | null, current: string | null): boolean =>
  recorded === null || current === null || current === recorded;

export function isAlive(pid: number, startTime: string | null): boolean {
  if (!isValidPid(pid)) return false;
  try {
```

In `src/infra/proc.ts`, replace:

```ts
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  return startTime === null || processStartTime(pid) === startTime;
}

/** Signals the process group a detached child leads (pgid === pid), falling back to the pid alone. */
```

with:

```ts
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  return startTime === null || sameProcess(startTime, processStartTime(pid));
}

/** Signals the process group a detached child leads (pgid === pid), falling back to the pid alone. */
```

In `src/infra/supervisor.ts`, replace:

```ts
});
export type SuperviseSpec = z.infer<typeof SuperviseSpecSchema>;

export interface SuperviseHooks {
  onLine?(line: string): { final?: boolean; thread?: string };
  isBusy?(thread: string | null): Promise<boolean>;
  interrupt?(thread: string | null): Promise<void>;
}
```

with:

```ts
});
export type SuperviseSpec = z.infer<typeof SuperviseSpecSchema>;

/** What one stream line tells the supervisor: the terminal event, the thread, a tool call opening or closing. */
export interface LineInfo {
  final?: boolean;
  thread?: string;
  /** a tool call the CLI started (`open`) or finished: while one is open the run is busy, however quiet */
  item?: { id: string; open: boolean };
}

export interface SuperviseHooks {
  onLine?(line: string): LineInfo;
  /** `sinceMs`: when this run started, so a backend can ignore what an earlier run on the thread left */
  isBusy?(thread: string | null, sinceMs: number): Promise<boolean>;
  interrupt?(thread: string | null): Promise<void>;
}
```

In `src/infra/supervisor.ts`, replace:

```ts
    const started = Date.now();
    let lastActivity = started;
    let finalAt: number | null = null;
    const stream = { offset: 0, rest: "", decoder: new TextDecoder("utf-8") };

    while (!done && reason === null) {
```

with:

```ts
    const started = Date.now();
    let lastActivity = started;
    let finalAt: number | null = null;
    const open = new Set<string>();
    const stream = { offset: 0, rest: "", decoder: new TextDecoder("utf-8") };

    while (!done && reason === null) {
```

In `src/infra/supervisor.ts`, replace:

```ts
      const lines = readNew(p.events, stream);
      if (lines.length) lastActivity = Date.now();
      for (const line of lines) {
        let d: { final?: boolean; thread?: string } | undefined;
        try {
          d = hooks.onLine?.(line);
        } catch {
```

with:

```ts
      const lines = readNew(p.events, stream);
      if (lines.length) lastActivity = Date.now();
      for (const line of lines) {
        let d: LineInfo | undefined;
        try {
          d = hooks.onLine?.(line);
        } catch {
```

In `src/infra/supervisor.ts`, replace:

```ts
        }
        if (d?.thread) thread = d.thread;
        if (d?.final) finalAt ??= Date.now();
      }
      const now = Date.now();
      if (existsSync(p.cancel)) reason = "cancelled";
      else if (now - started >= spec.wallMs) reason = "wall-timeout";
      else if (finalAt !== null && spec.graceAfterFinalMs !== null && now - finalAt >= spec.graceAfterFinalMs)
        reason = "after-final";
      else if (now - lastActivity >= spec.idleMs) {
        if (await bounded(() => hooks.isBusy?.(thread), hookMs, false)) lastActivity = Date.now();
        else reason = "idle-timeout";
      }
    }
```

with:

```ts
        }
        if (d?.thread) thread = d.thread;
        if (d?.final) finalAt ??= Date.now();
        if (d?.item) {
          if (d.item.open) open.add(d.item.id);
          else open.delete(d.item.id);
        }
      }
      // a worker that ended on its own is recorded as it ended, even if a cancel or a limit arrived meanwhile
      if (done) break;
      const now = Date.now();
      if (existsSync(p.cancel)) reason = "cancelled";
      else if (now - started >= spec.wallMs) reason = "wall-timeout";
      else if (finalAt !== null && spec.graceAfterFinalMs !== null && now - finalAt >= spec.graceAfterFinalMs)
        reason = "after-final";
      else if (now - lastActivity >= spec.idleMs) {
        if (open.size > 0 || (await bounded(() => hooks.isBusy?.(thread, started), hookMs, false)))
          lastActivity = Date.now();
        else reason = "idle-timeout";
      }
    }
```

In `src/infra/supervisor.ts`, replace:

```ts

  let stopped = false;
  if (reason !== null && !done) {
    if (reason !== "after-final" && failure === null)
      await bounded(() => hooks.interrupt?.(thread), hookMs, undefined);
    if (!done) {
      await stopGroup(child.pid, spec.killGraceMs, spec.pollMs);
      stopped = true;
```

with:

```ts

  let stopped = false;
  if (reason !== null && !done) {
    if (reason !== "after-final" && failure === null && hooks.interrupt) {
      await bounded(() => hooks.interrupt?.(thread), hookMs, undefined);
      // a server-side stop lets the CLI end on its own: it gets the kill grace before any signal
      await Promise.race([child.exited, Bun.sleep(spec.killGraceMs)]);
    }
    if (!done) {
      await stopGroup(child.pid, spec.killGraceMs, spec.pollMs);
      stopped = true;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/infra/supervisor.test.ts test/infra/proc.test.ts test/infra/filelock.test.ts test/services/dispatches-state.test.ts`
Expected: PASS (the last two use `isAlive` and must not change).

- [ ] **Step 5: Check and commit**

Run: `bun run format && bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: clean; the full suite passes.

```bash
git add src/infra/proc.ts src/infra/supervisor.ts test/infra/proc.test.ts test/infra/supervisor.test.ts
git commit -m "fix(supervisor): the first exit wins, open tool calls keep a run busy, a grace after interrupt"
```

---

### Task 2: The adapters: Codex's open tool calls, opencode busy by this run's newest reply, `runCli` kills its whole group

Rulings 4, 5 and 6: the adapter half of Task 1 and plan 3's two runner carry-overs. The Codex adapter reports each `item.started` and `item.completed` as an open or closed tool call, and `src/entry/supervise.ts` passes it to the supervisor with the run's start; opencode's `isBusy` reads the newest assistant message and ignores a usage limit older than the run; `runCli` runs every CLI query in its own process group and kills the group on its timeout, and Codex's private copy of it goes. `test/helpers.ts` gets `exited(pid)`, which also counts a zombie nobody reaped as gone (a container's pid 1 may never reap), for this and later tasks.

**Files:**
- Modify: `src/adapters/backend.ts`, `src/adapters/cli.ts`, `src/adapters/codex/index.ts`, `src/adapters/opencode/index.ts`, `src/entry/supervise.ts`, `test/helpers.ts`
- Create: `test/adapters/cli.test.ts`
- Test: `test/adapters/codex.test.ts`, `test/adapters/opencode-session.test.ts`, `test/entry/supervise-bin.test.ts`

**Interfaces:**
- Consumes: Task 1 (`LineInfo.item`, `isBusy(thread, sinceMs)`); `killGroup` (`src/infra/proc.ts`).
- Produces: `EventDelta.item?: { id: string; open: boolean }`; `BackendAdapter.isBusy?(thread, cwd, sinceMs?: number)`; `runCli(bin, args, { timeoutMs, env?, cwd? })`; `exited(pid: number): boolean` (`test/helpers.ts`), used by Tasks 7 and 9.

- [ ] **Step 1: Write the failing tests**

`test/adapters/cli.test.ts` (new):

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../../src/adapters/cli.ts";
import { exited, snapshotEnv, withHome } from "../helpers.ts";
import { waitFor } from "../services/helpers.ts";

afterEach(snapshotEnv());

describe("runCli", () => {
  it("runs in the directory it is given", async () => {
    withHome();
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "catherd-cli-")));
    expect(await runCli("pwd", [], { timeoutMs: 10_000, cwd: dir })).toEqual({
      ok: true,
      out: `${dir}\n`,
      err: "",
    });
  });

  it("kills everything the CLI started when it times out, so nothing keeps holding its pipes", async () => {
    withHome();
    const pidFile = join(mkdtempSync(join(tmpdir(), "catherd-cli-")), "pid");
    const t0 = Date.now();
    // the CLI exits at once, but a child it left behind keeps stdout open
    const r = await runCli("sh", ["-c", `sleep 30 & echo $! > ${pidFile}`], { timeoutMs: 300 });
    expect(r).toMatchObject({ ok: false, err: expect.stringContaining("timed out after 300 ms") });
    expect(Date.now() - t0).toBeLessThan(5_000);
    const child = Number(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim()));
    await waitFor(() => exited(child), 5_000);
  });
});
```

In `test/adapters/codex.test.ts`, replace:

```ts
  ...over,
});

describe("codex plan", () => {
  it("sends the brief on stdin, sets model, effort and sandbox, and ends positionals after --", () => {
    const p = codexAdapter.plan(req());
```

with:

```ts
  ...over,
});

describe("codex parse", () => {
  it("reports a tool call opening and closing, so a quiet one keeps the run busy", () => {
    const [started, completed] = lines("ok-with-reconnect.jsonl").filter((l) => l.includes('"id":"item_1"'));
    expect(codexAdapter.parse(started as string)).toMatchObject({ item: { id: "item_1", open: true } });
    expect(codexAdapter.parse(completed as string)).toMatchObject({ item: { id: "item_1", open: false } });
    expect(codexAdapter.parse('{"type":"turn.started"}').item).toBeUndefined();
  });
});

describe("codex plan", () => {
  it("sends the brief on stdin, sets model, effort and sandbox, and ends positionals after --", () => {
    const p = codexAdapter.plan(req());
```

In `test/adapters/opencode-session.test.ts`, replace:

```ts
    expect(await opencodeAdapter.isBusy?.(SES, "/repo")).toBe(true);
  });

  it("interrupts the session on the service", async () => {
    const to = join(mkdtempSync(join(tmpdir(), "catherd-int-")), "ids");
    onSim({ interruptsTo: to });
```

with:

```ts
    expect(await opencodeAdapter.isBusy?.(SES, "/repo")).toBe(true);
  });

  it("stays busy when the newest assistant message's usage limit is older than this run", async () => {
    const limited = { type: "provider.quota", message: "Go limit" };
    onSim({
      active: { [SES]: { type: "running" } },
      messages: [{ type: "assistant", time: { created: 1_000 }, retry: { attempt: 2, error: limited } }],
    });
    expect(await opencodeAdapter.isBusy?.(SES, "/repo", 5_000)).toBe(true);
    expect(await opencodeAdapter.isBusy?.(SES, "/repo", 500)).toBe(false);
  });

  it("reads the newest assistant message, whatever entry comes before it", async () => {
    onSim({
      active: { [SES]: { type: "running" } },
      messages: [
        { type: "user", time: { created: 3_000 } },
        {
          type: "assistant",
          time: { created: 2_000 },
          retry: { attempt: 1, error: { type: "provider.rate-limit", message: "slow down" } },
        },
      ],
    });
    expect(await opencodeAdapter.isBusy?.(SES, "/repo")).toBe(false);
  });

  it("interrupts the session on the service", async () => {
    const to = join(mkdtempSync(join(tmpdir(), "catherd-int-")), "ids");
    onSim({ interruptsTo: to });
```

In `test/entry/supervise-bin.test.ts`, replace:

```ts
    const proc = JSON.parse(readFileSync(p.proc, "utf8")) as { supervisorStartTime: string | null };
    expect(await until(() => !isAlive(pid, proc.supervisorStartTime), 3_000)).toBe(true);
  }, 30_000);
});
```

with:

```ts
    const proc = JSON.parse(readFileSync(p.proc, "utf8")) as { supervisorStartTime: string | null };
    expect(await until(() => !isAlive(pid, proc.supervisorStartTime), 3_000)).toBe(true);
  }, 30_000);

  it("keeps a Codex run busy while a tool call it started is still running, however quiet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "catherd-supbin-"));
    const p = dispatchPaths(dir);
    const item = (type: string) => `'{"type":"${type}","item":{"id":"item_1","type":"command_execution"}}'`;
    writeJsonAtomic(p.spec, {
      schema: 1,
      backend: "codex",
      dispatchDir: dir,
      cmd: "sh",
      // one second of silence inside the tool call: over three times the idle limit
      args: [
        "-c",
        `echo '{"type":"thread.started","thread_id":"t-busy"}'; echo ${item("item.started")}; sleep 1; echo ${item("item.completed")}`,
      ],
      env: { PATH: process.env.PATH ?? "" },
      cwd: dir,
      stdinPath: null,
      idleMs: 300,
      wallMs: 60_000,
      killGraceMs: 200,
      graceAfterFinalMs: null,
      pollMs: 20,
    });
    launchSupervisor(p.spec);
    expect(await until(() => readExit(dir), 20_000)).toMatchObject({ code: 0, reason: "exited" });
  }, 30_000);
});
```

Append to `test/helpers.ts` (at the end of the file; plan 6 removed `fakeBinPath` from it):

```ts
/** True once `pid` has exited: gone, or a zombie nobody has reaped yet (a container's pid 1 may never reap). */
export function exited(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  const ps = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
    env: process.env,
  });
  const stat = ps.stdout.toString().trim();
  return stat === "" || stat.startsWith("Z");
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/adapters/cli.test.ts test/adapters/codex.test.ts test/adapters/opencode-session.test.ts test/entry/supervise-bin.test.ts`
Expected: FAIL, six tests — `runCli` ignores `cwd` and, on its timeout, leaves the `sleep` its CLI started alive (the test waits 5 s for it to go, then fails); Codex's `parse` has no `item`; opencode's `isBusy` counts the old limit and reads the user message first; the quiet Codex run is idle-killed (`reason: "idle-timeout"`).

- [ ] **Step 3: Write the implementation**

In `src/adapters/backend.ts`, replace:

```ts
  retrying?: boolean;
  /** the stream's terminal event: the supervisor may kill a CLI that lingers after it */
  final?: boolean;
}

export interface FinishedRun {
```

with:

```ts
  retrying?: boolean;
  /** the stream's terminal event: the supervisor may kill a CLI that lingers after it */
  final?: boolean;
  /** a tool call starting (`open`) or ending: while one is open the run is busy, however quiet */
  item?: { id: string; open: boolean };
}

export interface FinishedRun {
```

In `src/adapters/backend.ts`, replace:

```ts
  errors: { limit: RegExp[]; tooOld: RegExp[] };
  resume: { supported: boolean; sameAccessOnly: boolean; threadPattern: RegExp };
  interrupt?(thread: string, cwd: string): Promise<void>;
  isBusy?(thread: string, cwd: string): Promise<boolean>;
  /** Spec §4.5: this backend's own stand-in for a rung on a usage limit, when the profile names none. */
  failoverFor?(rung: Rung, repo?: string): Rung | null;
  /**
```

with:

```ts
  errors: { limit: RegExp[]; tooOld: RegExp[] };
  resume: { supported: boolean; sameAccessOnly: boolean; threadPattern: RegExp };
  interrupt?(thread: string, cwd: string): Promise<void>;
  /** `sinceMs`: when this run started, so what an earlier run on the thread left behind does not count */
  isBusy?(thread: string, cwd: string, sinceMs?: number): Promise<boolean>;
  /** Spec §4.5: this backend's own stand-in for a rung on a usage limit, when the profile names none. */
  failoverFor?(rung: Rung, repo?: string): Rung | null;
  /**
```

In `src/adapters/cli.ts`, replace:

```ts
import { scrubSecrets } from "../infra/env.ts";
import { log } from "../infra/log.ts";

export interface CliResult {
  ok: boolean;
```

with:

```ts
import { scrubSecrets } from "../infra/env.ts";
import { log } from "../infra/log.ts";
import { killGroup } from "../infra/proc.ts";

export interface CliResult {
  ok: boolean;
```

In `src/adapters/cli.ts`, replace:

```ts

/**
 * Runs `bin <args>` without catherd's secrets and with no stdin; null when `bin` is not on PATH. A call
 * past `timeoutMs` is killed and reported as failed, so a wedged CLI never stalls its caller.
 */
export async function runCli(
  bin: string,
  args: string[],
  o: { timeoutMs: number; env?: Record<string, string> },
): Promise<CliResult | null> {
  if (!Bun.which(bin, { PATH: process.env.PATH ?? "" })) return null;
  log("debug", "spawn", { argv: [bin, ...args], env: o.env ?? {} });
  const p = Bun.spawn([bin, ...args], {
    env: { ...scrubSecrets(process.env), ...o.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
```

with:

```ts

/**
 * Runs `bin <args>` without catherd's secrets and with no stdin; null when `bin` is not on PATH. A call
 * past `timeoutMs` is killed with every process it started (it runs in its own process group) and is
 * reported as failed, so neither a wedged CLI nor a child holding its pipes stalls the caller.
 */
export async function runCli(
  bin: string,
  args: string[],
  o: { timeoutMs: number; env?: Record<string, string>; cwd?: string },
): Promise<CliResult | null> {
  if (!Bun.which(bin, { PATH: process.env.PATH ?? "" })) return null;
  log("debug", "spawn", { argv: [bin, ...args], env: o.env ?? {} });
  const p = Bun.spawn([bin, ...args], {
    cwd: o.cwd,
    env: { ...scrubSecrets(process.env), ...o.env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
```

In `src/adapters/cli.ts`, replace:

```ts
      late,
    ]);
    if (!done) {
      p.kill("SIGKILL");
      return { ok: false, out: "", err: `${bin} ${args.join(" ")} timed out after ${o.timeoutMs} ms` };
    }
    const [code, out, err] = done;
```

with:

```ts
      late,
    ]);
    if (!done) {
      killGroup(p.pid, "SIGKILL");
      return { ok: false, out: "", err: `${bin} ${args.join(" ")} timed out after ${o.timeoutMs} ms` };
    }
    const [code, out, err] = done;
```

In `src/adapters/codex/index.ts`, replace:

```ts
  type RunRequest,
  type SpawnPlan,
} from "../backend.ts";
import { scrubSecrets } from "../../infra/env.ts";
import { CODEX_LIMIT, CODEX_TOO_OLD, foldCodexEvents, parseCodexLine } from "./events.ts";
import { generatedImages, isolatedCodexHome, isolatedCodexHomePath, userCodexHome } from "./home.ts";
```

with:

```ts
  type RunRequest,
  type SpawnPlan,
} from "../backend.ts";
import { type CliResult, runCli } from "../cli.ts";
import { CODEX_LIMIT, CODEX_TOO_OLD, foldCodexEvents, parseCodexLine } from "./events.ts";
import { generatedImages, isolatedCodexHome, isolatedCodexHomePath, userCodexHome } from "./home.ts";
```

In `src/adapters/codex/index.ts`, replace:

```ts
export const codexShell = { timeoutMs: 15_000 };

/** Runs `codex <args>` without catherd's secrets; a run past the timeout is killed and counts as failed. */
async function sh(args: string[], cwd?: string): Promise<{ ok: boolean; out: string; err: string } | null> {
  if (!Bun.which("codex", { PATH: process.env.PATH ?? "" })) return null;
  const p = Bun.spawn(["codex", ...args], {
    cwd,
    env: scrubSecrets(process.env),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), codexShell.timeoutMs);
  });
  try {
    const done = await Promise.race([
      Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]),
      late,
    ]);
    if (!done) {
      p.kill("SIGKILL");
      return {
        ok: false,
        out: "",
        err: `codex ${args.join(" ")} timed out after ${codexShell.timeoutMs} ms`,
      };
    }
    const [code, out, err] = done;
    return { ok: code === 0, out, err };
  } finally {
    clearTimeout(timer);
  }
}

function plan(r: RunRequest): SpawnPlan {
  if (r.thread !== null && !THREAD.test(r.thread))
```

with:

```ts
export const codexShell = { timeoutMs: 15_000 };

/** Runs `codex <args>` without catherd's secrets; a run past the timeout is killed and counts as failed. */
const sh = (args: string[], cwd?: string): Promise<CliResult | null> =>
  runCli("codex", args, { timeoutMs: codexShell.timeoutMs, cwd });

function plan(r: RunRequest): SpawnPlan {
  if (r.thread !== null && !THREAD.test(r.thread))
```

In `src/adapters/codex/index.ts`, replace:

```ts
    const e = parseCodexLine(line);
    if (!e) return {};
    const f = foldCodexEvents([line]);
    return {
      ...(f.thread ? { thread: f.thread } : {}),
      ...(e.type === "turn.completed" ? { tokens: f.tokens } : {}),
      lastEvent: f.lastEvent ?? undefined,
      ...(f.turnFailed ? { failure: f.failure ?? "turn failed" } : {}),
```

with:

```ts
    const e = parseCodexLine(line);
    if (!e) return {};
    const f = foldCodexEvents([line]);
    // a tool call runs between item.started and item.completed, often printing nothing: the run is busy
    const id = typeof e.item?.id === "string" ? e.item.id : null;
    const open = e.type === "item.started" ? true : e.type === "item.completed" ? false : null;
    return {
      ...(f.thread ? { thread: f.thread } : {}),
      ...(id !== null && open !== null ? { item: { id, open } } : {}),
      ...(e.type === "turn.completed" ? { tokens: f.tokens } : {}),
      lastEvent: f.lastEvent ?? undefined,
      ...(f.turnFailed ? { failure: f.failure ?? "turn failed" } : {}),
```

In `src/adapters/opencode/index.ts`, replace:

```ts
}

/**
 * A usage limit the latest message is retrying on or failed with (v2 keeps `retry: {attempt, at, error}`
 * on it), or null. Messages come newest first, after an `idle` marker once the session stopped; older
 * messages keep their errors, so only the newest counts, and with `sinceMs` only if it is that recent.
 */
function limitRetry(messages: unknown, sinceMs?: number): string | null {
  if (!Array.isArray(messages)) return null;
  const m = (messages[0]?.type === "idle" ? messages[1] : messages[0]) as Record<string, any> | undefined;
  const err = m?.retry?.error ?? m?.error;
  if (!OPENCODE_LIMIT_TYPES.includes(err?.type)) return null;
  if (sinceMs !== undefined && !(m?.time?.created >= sinceMs)) return null;
```

with:

```ts
}

/**
 * A usage limit the latest assistant message is retrying on or failed with (v2 keeps `retry: {attempt, at,
 * error}` on it), or null. Messages come newest first, after an `idle` marker once the session stopped;
 * older messages keep their errors, so only the newest assistant message counts, and with `sinceMs` only
 * if this run wrote it.
 */
function limitRetry(messages: unknown, sinceMs?: number): string | null {
  if (!Array.isArray(messages)) return null;
  const m = messages.find((x) => x?.type === "assistant") as Record<string, any> | undefined;
  const err = m?.retry?.error ?? m?.error;
  if (!OPENCODE_LIMIT_TYPES.includes(err?.type)) return null;
  if (sinceMs !== undefined && !(m?.time?.created >= sinceMs)) return null;
```

In `src/adapters/opencode/index.ts`, replace:

```ts
 * Busy while the service lists the session as running, unless it is only waiting out a usage limit.
 * Empty or failed API output counts as not busy (spec §6.3), so a hung run still times out.
 */
async function isBusy(thread: string): Promise<boolean> {
  const active = (await opencodeApi("GET", "/api/session/active"))?.data;
  if (!active || typeof active !== "object" || !(thread in active)) return false;
  const messages = (await opencodeApi("GET", `/api/session/${thread}/message`))?.data;
  return Array.isArray(messages) && limitRetry(messages) === null;
}

/** Killing the v2 client does not stop its session; the service must be told (research §2.4). */
```

with:

```ts
 * Busy while the service lists the session as running, unless it is only waiting out a usage limit.
 * Empty or failed API output counts as not busy (spec §6.3), so a hung run still times out.
 */
async function isBusy(thread: string, sinceMs?: number): Promise<boolean> {
  const active = (await opencodeApi("GET", "/api/session/active"))?.data;
  if (!active || typeof active !== "object" || !(thread in active)) return false;
  const messages = (await opencodeApi("GET", `/api/session/${thread}/message`))?.data;
  return Array.isArray(messages) && limitRetry(messages, sinceMs) === null;
}

/** Killing the v2 client does not stop its session; the service must be told (research §2.4). */
```

In `src/adapters/opencode/index.ts`, replace:

```ts
  errors: { limit: OPENCODE_LIMIT, tooOld: OPENCODE_TOO_OLD },
  resume: { supported: true, sameAccessOnly: false, threadPattern: THREAD },
  interrupt: (thread) => interrupt(thread),
  isBusy: (thread) => isBusy(thread),
  failoverFor,
  graceAfterFinalMs: null,
};
```

with:

```ts
  errors: { limit: OPENCODE_LIMIT, tooOld: OPENCODE_TOO_OLD },
  resume: { supported: true, sameAccessOnly: false, threadPattern: THREAD },
  interrupt: (thread) => interrupt(thread),
  isBusy: (thread, _cwd, sinceMs) => isBusy(thread, sinceMs),
  failoverFor,
  graceAfterFinalMs: null,
};
```

In `src/entry/supervise.ts`, replace:

```ts
  await supervise(spec, {
    onLine: (line) => {
      const d = a?.parse(line) ?? {};
      return { final: d.final, thread: d.thread };
    },
    isBusy: busy ? (thread) => (thread ? busy(thread, spec.cwd) : Promise.resolve(false)) : undefined,
    interrupt: stop ? (thread) => (thread ? stop(thread, spec.cwd) : Promise.resolve()) : undefined,
  });
}
```

with:

```ts
  await supervise(spec, {
    onLine: (line) => {
      const d = a?.parse(line) ?? {};
      return { final: d.final, thread: d.thread, item: d.item };
    },
    isBusy: busy
      ? (thread, sinceMs) => (thread ? busy(thread, spec.cwd, sinceMs) : Promise.resolve(false))
      : undefined,
    interrupt: stop ? (thread) => (thread ? stop(thread, spec.cwd) : Promise.resolve()) : undefined,
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/adapters test/entry/supervise-bin.test.ts test/services/doctor.test.ts`
Expected: PASS (`doctor.test.ts` drives the Codex probe and `codex sandbox` through the new `sh`).

- [ ] **Step 5: Check and commit**

Run: `bun run format && bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: clean; the full suite passes.

```bash
git add src/adapters src/entry/supervise.ts test/helpers.ts test/adapters test/entry/supervise-bin.test.ts
git commit -m "fix(adapters): codex reports open tool calls, opencode busy by this run, runCli kills its group"
```

---

### Task 3: Cancelling an orphan: identified workers only, the signal recorded; old spec.json files scrubbed

Plan 2's re-review minors (Ruling 7): `stopOrphan` signalled by pid alone when proc.json had no start time, signalled `proc.pgid` while checking only `proc.pid`, and always wrote `signal: "SIGTERM"`. Also "old spec.json not cleaned": builds before the plan-2 fix wrote every env value of the MCP server into a world-readable spec.json; `reconcileAll` (every MCP server start) now blanks such a file's env and makes it 0600. And the timing window in "finalizes a waiting dispatch as lost…": the simulated worker lived 1.5 s, and on a slow machine it ended before the test killed its supervisor; now it waits for a file the test writes once the supervisor is dead.

**Files:**
- Modify: `src/services/dispatch-service.ts`, `src/services/reconcile.ts`, `test/sim/codex`, `test/sim/scenario.ts`
- Test: `test/services/failover-cancel.test.ts`, `test/services/summary-reconcile.test.ts`

**Interfaces:**
- Consumes: `killGroup`, `isAlive`, `processStartTime`; `listDispatches`, `dispatchPaths`, `writeJsonAtomic`; the test helpers `fakeDispatch`, `deadProcess`, `freshRun`.
- Produces: `orphanLimits = { killGraceMs }` (`src/services/dispatch-service.ts`, tests shorten it); `scrubOldSpecs(run: Run): number` (`src/services/reconcile.ts`); the Codex simulator's `holdUntil?: string` scenario key.

- [ ] **Step 1: Write the failing tests**

In `test/services/failover-cancel.test.ts`, replace:

```ts
import { isCatherdError } from "../../src/domain/errors.ts";
import { dispatchPaths, readExit } from "../../src/infra/dispatch-dir.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { cancel, dispatch, type DispatchInput } from "../../src/services/dispatch-service.ts";
import { isAlive } from "../../src/infra/proc.ts";
import { latestDispatch, liveDispatches, readProc } from "../../src/services/dispatches.ts";
import { readRecords, runPaths } from "../../src/services/run-store.ts";
import { readNotes } from "../../src/services/state.ts";
import { snapshotEnv } from "../helpers.ts";
import { type CodexScenario, simPath, withScenario } from "../sim/scenario.ts";
import { fakeDeps, fakeGit, freshRun, testView, waitFor, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
const LIMIT = { eventsFile: join(FX, "limit.jsonl"), exitCode: 1 };
```

with:

```ts
import { isCatherdError } from "../../src/domain/errors.ts";
import { dispatchPaths, readExit } from "../../src/infra/dispatch-dir.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { cancel, dispatch, type DispatchInput, orphanLimits } from "../../src/services/dispatch-service.ts";
import { isAlive, processStartTime } from "../../src/infra/proc.ts";
import { writeJsonAtomic } from "../../src/infra/store.ts";
import { latestDispatch, liveDispatches, readProc } from "../../src/services/dispatches.ts";
import { readRecords, runPaths } from "../../src/services/run-store.ts";
import { readNotes } from "../../src/services/state.ts";
import { snapshotEnv } from "../helpers.ts";
import { type CodexScenario, simPath, withScenario } from "../sim/scenario.ts";
import {
  deadProcess,
  fakeDeps,
  fakeDispatch,
  fakeGit,
  freshRun,
  testView,
  waitFor,
  writeLane,
} from "./helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => {
  resetReadiness();
  orphanLimits.killGraceMs = 10_000;
});

const orphans: Bun.Subprocess[] = [];
afterEach(() => {
  for (const p of orphans.splice(0)) p.kill("SIGKILL");
});

/** A worker left running in its own process group, as a dead supervisor leaves one. */
function orphan(script: string): Bun.Subprocess {
  const p = Bun.spawn(["sh", "-c", script], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
  });
  orphans.push(p);
  return p;
}

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
const LIMIT = { eventsFile: join(FX, "limit.jsonl"), exitCode: 1 };
```

In `test/services/failover-cancel.test.ts`, replace:

```ts
  }, 30_000);

  it("finalizes a waiting dispatch as lost once its supervisor died and then its worker ended", async () => {
    const { run, deps } = setup({ hangMs: 1_500 });
    const pending = dispatch(deps, input(run.id));
    const live = await waitFor(() => liveDispatches(run).find((d) => d.state === "running"));
    const proc = await waitFor(() => readProc(live.dir));
    process.kill(proc.supervisorPid, "SIGKILL");
    const { record } = await pending;
    expect(record).toMatchObject({ status: "failed", exitCode: null, error: { message: "lost, exit null" } });
    expect(readExit(live.dir)).toBeNull();
    expect(readRecords(run).records).toHaveLength(1);
  }, 30_000);

  it("refuses a name with no live dispatch", async () => {
    const { run, deps } = setup({});
    const e = await cancel(deps, run.id, "worker-M1.L1").catch((x: unknown) => x);
```

with:

```ts
  }, 30_000);

  it("finalizes a waiting dispatch as lost once its supervisor died and then its worker ended", async () => {
    // the worker ends only when the test says so: after its supervisor is gone, never before
    const release = join(mkdtempSync(join(tmpdir(), "catherd-hold-")), "release");
    const { run, deps } = setup({ holdUntil: release });
    const pending = dispatch(deps, input(run.id));
    const live = await waitFor(() => liveDispatches(run).find((d) => d.state === "running"));
    const proc = await waitFor(() => readProc(live.dir));
    process.kill(proc.supervisorPid, "SIGKILL");
    await waitFor(() => !isAlive(proc.supervisorPid, proc.supervisorStartTime));
    writeFileSync(release, "");
    const { record } = await pending;
    expect(record).toMatchObject({ status: "failed", exitCode: null, error: { message: "lost, exit null" } });
    expect(readExit(live.dir)).toBeNull();
    expect(readRecords(run).records).toHaveLength(1);
  }, 30_000);

  it("records SIGKILL when an orphaned worker outlasts its SIGTERM grace", async () => {
    orphanLimits.killGraceMs = 300;
    const { run, deps } = setup({});
    const worker = orphan("trap '' TERM; while :; do sleep 0.05; done");
    const dead = await deadProcess();
    const d = await fakeDispatch(
      run,
      {},
      {
        proc: {
          pid: worker.pid,
          startTime: processStartTime(worker.pid),
          supervisorPid: dead,
          supervisorStartTime: "gone",
        },
      },
    );
    const { record } = await cancel(deps, run.id, d.admit.name);
    expect(record.status).toBe("cancelled");
    expect(readExit(d.dir)).toMatchObject({ reason: "cancelled", signal: "SIGKILL" });
    expect(await worker.exited).toBe(137);
  });

  it("never signals an orphaned worker it cannot identify, and still records the cancel", async () => {
    const { run, deps } = setup({});
    const dead = await deadProcess();
    const unidentified = [
      // no start time: the pid alone may belong to another process by now
      (pid: number) => ({ startTime: null, pgid: pid }),
      // a process group that is not the one the worker leads
      (pid: number) => ({ startTime: processStartTime(pid), pgid: process.pid }),
    ];
    for (const who of unidentified) {
      const worker = orphan("sleep 30");
      const d = await fakeDispatch(run, { name: `worker-${worker.pid}` });
      writeJsonAtomic(dispatchPaths(d.dir).proc, {
        schema: 1,
        pid: worker.pid,
        ...who(worker.pid),
        supervisorPid: dead,
        supervisorStartTime: "gone",
        startedAt: d.admit.admittedAt,
      });
      const { record } = await cancel(deps, run.id, d.admit.name);
      expect(record.status).toBe("cancelled");
      expect(readExit(d.dir)).toMatchObject({ reason: "cancelled", signal: null });
      expect(isAlive(worker.pid, null)).toBe(true);
    }
  });

  it("refuses a name with no live dispatch", async () => {
    const { run, deps } = setup({});
    const e = await cancel(deps, run.id, "worker-M1.L1").catch((x: unknown) => x);
```

In `test/services/summary-reconcile.test.ts`, replace:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { runsDir } from "../../src/infra/paths.ts";
import { processStartTime } from "../../src/infra/proc.ts";
import { reconcileAll } from "../../src/services/reconcile.ts";
```

with:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { writeJsonAtomic } from "../../src/infra/store.ts";
import { runsDir } from "../../src/infra/paths.ts";
import { processStartTime } from "../../src/infra/proc.ts";
import { reconcileAll } from "../../src/services/reconcile.ts";
```

In `test/services/summary-reconcile.test.ts`, replace:

```ts
    expect(readRecords(run).records.map((x) => x.dispatchId)).toEqual([d.admit.dispatchId]);
  });

  it("writes one record when two reconcilers race over the same dispatches", async () => {
    const { run } = freshRun();
    for (const name of ["a", "b", "c"])
```

with:

```ts
    expect(readRecords(run).records.map((x) => x.dispatchId)).toEqual([d.admit.dispatchId]);
  });

  it("blanks and closes a spec.json an older build left readable to others, and leaves a 0600 one", async () => {
    const { run } = freshRun();
    const old = await fakeDispatch(run, {}, { proc: "dead", exit: finished() });
    const fresh = await fakeDispatch(
      run,
      { name: "worker-M1.L2", lane: "M1.L2" },
      { proc: "dead", exit: finished() },
    );
    const oldSpec = dispatchPaths(old.dir).spec;
    writeFileSync(oldSpec, JSON.stringify({ schema: 1, env: { OPENAI_API_KEY: "sk-live-1234567890" } }));
    chmodSync(oldSpec, 0o644);
    writeJsonAtomic(dispatchPaths(fresh.dir).spec, { schema: 1, env: { CODEX_HOME: "/x" } }, { mode: 0o600 });
    await reconcileAll(fakeDeps());
    expect(statSync(oldSpec).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(oldSpec, "utf8"))).toEqual({ schema: 1, env: {} });
    expect(JSON.parse(readFileSync(dispatchPaths(fresh.dir).spec, "utf8")).env).toEqual({ CODEX_HOME: "/x" });
  });

  it("writes one record when two reconcilers race over the same dispatches", async () => {
    const { run } = freshRun();
    for (const name of ["a", "b", "c"])
```

In `test/sim/codex`, replace:

```ts
#!/usr/bin/env bun
// Codex CLI simulator for catherd's tests: behaviour comes from the JSON scenario in CATHERD_SIM_SCENARIO.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const s = JSON.parse(readFileSync(process.env.CATHERD_SIM_SCENARIO ?? "", "utf8")) as Record<string, any>;
```

with:

```ts
#!/usr/bin/env bun
// Codex CLI simulator for catherd's tests: behaviour comes from the JSON scenario in CATHERD_SIM_SCENARIO.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const s = JSON.parse(readFileSync(process.env.CATHERD_SIM_SCENARIO ?? "", "utf8")) as Record<string, any>;
```

In `test/sim/codex`, replace:

```ts
  if (s.eventsFile) process.stdout.write(readFileSync(s.eventsFile, "utf8"));
  if (s.reply !== undefined && out) writeFileSync(out, s.reply);
  if (s.hangMs) await Bun.sleep(s.hangMs);
  process.exit(s.exitCode ?? 0);
}, s.delayMs ?? 0);
```

with:

```ts
  if (s.eventsFile) process.stdout.write(readFileSync(s.eventsFile, "utf8"));
  if (s.reply !== undefined && out) writeFileSync(out, s.reply);
  if (s.hangMs) await Bun.sleep(s.hangMs);
  if (s.holdUntil) while (!existsSync(s.holdUntil)) await Bun.sleep(20);
  process.exit(s.exitCode ?? 0);
}, s.delayMs ?? 0);
```

In `test/sim/scenario.ts`, replace:

```ts
  exitCode?: number;
  delayMs?: number;
  hangMs?: number;
  /** `codex login status` sleeps this long before answering */
  loginHangMs?: number;
  /** every invocation appends `{ args, envKeys }` here as one JSON line */
```

with:

```ts
  exitCode?: number;
  delayMs?: number;
  hangMs?: number;
  /** after its output, `exec` waits until this file exists, then exits */
  holdUntil?: string;
  /** `codex login status` sleeps this long before answering */
  loginHangMs?: number;
  /** every invocation appends `{ args, envKeys }` here as one JSON line */
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/services/failover-cancel.test.ts test/services/summary-reconcile.test.ts`
Expected: FAIL — `failover-cancel.test.ts` cannot import `orphanLimits`; the spec.json test finds mode `644` and the key still in it.

- [ ] **Step 3: Write the implementation**

In `src/services/dispatch-service.ts`, replace:

```ts
  };
}

/**
 * A worker whose supervisor died has no one to read the cancel file: stop its group here (SIGTERM, then
 * SIGKILL after the grace), each signal guarded by the worker's pid and start time, and write the
 * exit.json the supervisor would have. A finalizer that sees the worker gone first reads the cancel file
 * instead (finalize.ts). Nothing happens while the supervisor lives: it acts on the cancel file itself.
 */
async function stopOrphan(deps: Deps, d: Dispatch): Promise<void> {
  const proc = readProc(d.dir);
  if (!proc || readExit(d.dir) || isAlive(proc.supervisorPid, proc.supervisorStartTime)) return;
  const worker = () => isAlive(proc.pid, proc.startTime);
  if (!worker()) return;
  killGroup(proc.pgid ?? proc.pid, "SIGTERM");
  const end = Date.now() + KILL_GRACE_MS;
  while (Date.now() < end && worker()) await Bun.sleep(deps.pollMs);
  if (worker()) killGroup(proc.pgid ?? proc.pid, "SIGKILL");
  writeJsonAtomic(dispatchPaths(d.dir).exit, {
    schema: 1,
    code: null,
    signal: "SIGTERM",
    reason: "cancelled",
    endedAt: new Date().toISOString(),
  });
```

with:

```ts
  };
}

/** How long an orphaned worker gets between SIGTERM and SIGKILL; tests shorten it. */
export const orphanLimits = { killGraceMs: KILL_GRACE_MS };

/**
 * A worker whose supervisor died has no one to read the cancel file: stop its group here (SIGTERM, then
 * SIGKILL after the grace), each signal guarded by the worker's pid and start time, and write the
 * exit.json the supervisor would have, with the signal that ended it. A worker catherd cannot identify
 * (no start time, or a proc.json whose pgid is not the worker's own pid) is never signalled: its pid may
 * belong to someone else by now, so the dispatch is only recorded as cancelled. A finalizer that sees the
 * worker gone first reads the cancel file instead (finalize.ts). Nothing happens while the supervisor
 * lives: it acts on the cancel file itself.
 */
async function stopOrphan(deps: Deps, d: Dispatch): Promise<void> {
  const proc = readProc(d.dir);
  if (!proc || readExit(d.dir) || isAlive(proc.supervisorPid, proc.supervisorStartTime)) return;
  const worker = () => isAlive(proc.pid, proc.startTime);
  if (!worker()) return;
  let signal: NodeJS.Signals | null = null;
  if (proc.startTime !== null && (proc.pgid === undefined || proc.pgid === proc.pid)) {
    signal = "SIGTERM";
    killGroup(proc.pid, signal);
    const end = Date.now() + orphanLimits.killGraceMs;
    while (Date.now() < end && worker()) await Bun.sleep(deps.pollMs);
    if (worker()) {
      signal = "SIGKILL";
      killGroup(proc.pid, signal);
    }
  }
  writeJsonAtomic(dispatchPaths(d.dir).exit, {
    schema: 1,
    code: null,
    signal,
    reason: "cancelled",
    endedAt: new Date().toISOString(),
  });
```

In `src/services/reconcile.ts`, replace:

```ts
import { type Dispatch, pendingDispatches } from "./dispatches.ts";
import { finalizeDispatch, waitForFinish } from "./finalize.ts";
import type { Deps } from "./ports.ts";
import { listRuns, type Run } from "./run-store.ts";
import { refreshState } from "./state.ts";
import { log } from "../infra/log.ts";

export interface ReconcileReport {
  finalized: string[];
```

with:

```ts
import { readFileSync, statSync } from "node:fs";
import { dispatchPaths } from "../infra/dispatch-dir.ts";
import { log } from "../infra/log.ts";
import { writeJsonAtomic } from "../infra/store.ts";
import { type Dispatch, listDispatches, pendingDispatches } from "./dispatches.ts";
import { finalizeDispatch, waitForFinish } from "./finalize.ts";
import type { Deps } from "./ports.ts";
import { listRuns, type Run } from "./run-store.ts";
import { refreshState } from "./state.ts";

/**
 * Builds before the spec.json fix (plan-2 review I1) wrote every env value of the MCP server into
 * spec.json, readable by others. A spec is read once, when its supervisor starts, so such a file loses
 * its env and becomes 0600. Returns how many it scrubbed.
 */
export function scrubOldSpecs(run: Run): number {
  let n = 0;
  for (const d of listDispatches(run)) {
    const file = dispatchPaths(d.dir).spec;
    try {
      if ((statSync(file).mode & 0o077) === 0) continue;
      const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      writeJsonAtomic(file, { ...doc, env: {} }, { mode: 0o600 });
      n++;
    } catch {
      // no spec.json, or one that cannot be read: nothing to scrub
    }
  }
  return n;
}

export interface ReconcileReport {
  finalized: string[];
```

In `src/services/reconcile.ts`, replace:

```ts
  for (const run of runs) {
    let pending;
    try {
      pending = pendingDispatches(run, deps.now());
    } catch (e) {
      warn(run, e);
```

with:

```ts
  for (const run of runs) {
    let pending;
    try {
      const scrubbed = scrubOldSpecs(run);
      if (scrubbed) log("warn", "reconcile", { run: run.id, scrubbedSpecs: scrubbed });
      pending = pendingDispatches(run, deps.now());
    } catch (e) {
      warn(run, e);
```

The Codex simulator waits for the release file after its output (in `test/sim/scenario.ts` and `test/sim/codex`, shown with the tests above); nothing else in `src/` changes.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/services/failover-cancel.test.ts test/services/summary-reconcile.test.ts test/sim/codex.test.ts`
Expected: PASS.

- [ ] **Step 5: Check and commit**

Run: `bun run format && bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: clean; the full suite passes.

```bash
git add src/services/dispatch-service.ts src/services/reconcile.ts test/sim test/services/failover-cancel.test.ts test/services/summary-reconcile.test.ts
git commit -m "fix(cancel): never signal an orphan catherd cannot identify, record SIGKILL; scrub old spec.json"
```

---

### Task 4: Preflight never runs a check as root; every MCP call is logged, an unknown tool gets its own fix

Spec §10.4 ("never as root", Ruling 9) and §10.2 ("every MCP tool call", Ruling 10; plan 5's Task 7 minor). The SDK rejects a call to an unknown tool, or input a tool's schema refuses, before catherd's handler runs; those calls now get their `tool` log row, and the unknown tool's fix says what to do. `preflightUser.uid` lets tests stand in for root; the rest of `preflight.test.ts` runs as a normal user whoever runs the suite, and the MCP stdio integration test sets `IS_SANDBOX` for its server, since a root container runs the suite too.

**Files:**
- Modify: `src/services/preflight.ts`, `src/entry/mcp/result.ts`, `src/entry/mcp/server.ts`
- Test: `test/services/preflight.test.ts`, `test/entry/mcp-log.test.ts`, `test/integration/mcp-stdio.test.ts`

**Interfaces:**
- Consumes: `log` (`src/infra/log.ts`), `CatherdError`.
- Produces: `preflightUser = { uid(): number }` (`src/services/preflight.ts`); `toolOf(message: string): string | null` and `sdkToolError(message): CallToolResult` (`src/entry/mcp/result.ts`).

- [ ] **Step 1: Write the failing tests**

In `test/entry/mcp-log.test.ts`, replace:

```ts
    expect(typeof tools[0].ms).toBe("number");
    expect(readFileSync(logFile(), "utf8")).not.toContain("secret-run-id-value");
  });
});
```

with:

```ts
    expect(typeof tools[0].ms).toBe("number");
    expect(readFileSync(logFile(), "utf8")).not.toContain("secret-run-id-value");
  });

  it("logs a call rejected before any tool runs: bad input, or a tool this server does not have", async () => {
    withHome();
    delete process.env.CATHERD_LOG;
    const c = await mcpClient();
    expect((await call(c, "status", { run: 42 })).error?.code).toBe("E_INPUT_INVALID");
    const unknown = await call(c, "doctor_report");
    expect(unknown.error).toMatchObject({
      code: "E_INPUT_INVALID",
      message: expect.stringContaining("Tool doctor_report not found"),
      fix: expect.stringContaining("tools/list"),
    });
    const tools = readFileSync(logFile(), "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => JSON.parse(l))
      .filter((r) => r.event === "tool");
    expect(tools.map((r) => [r.tool, r.ok, r.code])).toEqual([
      ["status", false, "E_INPUT_INVALID"],
      ["doctor_report", false, "E_INPUT_INVALID"],
    ]);
  });
});
```

In `test/integration/mcp-stdio.test.ts`, replace:

```ts
    PATH: simPath(),
    CATHERD_SIM_SCENARIO: scenarioFile,
    CATHERD_TICK_MS: "200",
  };
}
```

with:

```ts
    PATH: simPath(),
    CATHERD_SIM_SCENARIO: scenarioFile,
    CATHERD_TICK_MS: "200",
    // a root container runs this suite too: preflight runs its checks there only on a disposable machine
    IS_SANDBOX: "1",
  };
}
```

In `test/services/preflight.test.ts`, replace:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryLock } from "../../src/infra/filelock.ts";
import { locksDir } from "../../src/infra/paths.ts";
import { classify, preflight, runCheck } from "../../src/services/preflight.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun, testView, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());

const outcomes = (r: Awaited<ReturnType<typeof preflight>>) =>
  r.needsConfirmation ? [] : r.results.map((x) => [x.lane, x.outcome]);
```

with:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tryLock } from "../../src/infra/filelock.ts";
import { locksDir } from "../../src/infra/paths.ts";
import { classify, preflight, preflightUser, runCheck } from "../../src/services/preflight.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun, testView, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());
// every other test runs its checks as a normal user, whoever runs the suite
const realUid = preflightUser.uid;
beforeEach(() => {
  preflightUser.uid = () => 1000;
});
afterEach(() => {
  preflightUser.uid = realUid;
});

const outcomes = (r: Awaited<ReturnType<typeof preflight>>) =>
  r.needsConfirmation ? [] : r.results.map((x) => [x.lane, x.outcome]);
```

In `test/services/preflight.test.ts`, replace:

```ts
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });

  it("classifies by exit code first, then by a missing command", () => {
    expect(classify({ code: 0, timedOut: false, tail: ["sh: x: command not found"] })).toBe("pass");
    expect(classify({ code: 1, timedOut: false, tail: ["sh: x: command not found"] })).toBe("cannot-start");
```

with:

```ts
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });

  it("never runs a check as root, unless IS_SANDBOX says the machine is disposable (spec §10.4)", async () => {
    const { run } = freshRun();
    const ran = join(run.dir, "ran");
    writeLane(run, "M1.L1", ["src/a.ts"], `touch '${ran}'`);
    preflightUser.uid = () => 0;
    delete process.env.IS_SANDBOX;
    const r = await preflight(fakeDeps(), { run: run.id });
    expect(outcomes(r)).toEqual([["M1.L1", "skipped"]]);
    if (!r.needsConfirmation) expect(r.results[0]?.note).toContain("never runs a lane's check as root");
    expect(existsSync(ran)).toBe(false);
    process.env.IS_SANDBOX = "1";
    expect(outcomes(await preflight(fakeDeps(), { run: run.id }))).toEqual([["M1.L1", "pass"]]);
    expect(existsSync(ran)).toBe(true);
  });

  it("classifies by exit code first, then by a missing command", () => {
    expect(classify({ code: 0, timedOut: false, tail: ["sh: x: command not found"] })).toBe("pass");
    expect(classify({ code: 1, timedOut: false, tail: ["sh: x: command not found"] })).toBe("cannot-start");
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/services/preflight.test.ts test/entry/mcp-log.test.ts`
Expected: FAIL — `preflight.test.ts` cannot import `preflightUser`; the log has no row for the two rejected calls, and the unknown tool's fix says "correct the argument the message names".

- [ ] **Step 3: Write the implementation**

In `src/entry/mcp/result.ts`, replace:

```ts
  }
}

/**
 * The SDK's own tool errors, such as input a tool's schema rejects before `handle` runs, in catherd's
 * shape (spec §4.8): an InvalidParams error is E_INPUT_INVALID, anything else is unexpected.
 */
export const sdkToolError = (message: string): CallToolResult =>
  fail(
    message.startsWith(`MCP error ${ErrorCode.InvalidParams}:`)
      ? new CatherdError("E_INPUT_INVALID", message, {
          fix: "correct the argument the message names, then call again",
        })
      : new Error(message),
  );
```

with:

```ts
  }
}

const UNKNOWN_TOOL = /Tool (\S+) (?:not found|disabled)$/;

/** The tool an SDK error message names ("Tool x not found", "… arguments for tool x: …"), else null. */
export const toolOf = (message: string): string | null =>
  (UNKNOWN_TOOL.exec(message) ?? /for tool (\S+?):/.exec(message))?.[1] ?? null;

/**
 * The SDK's own tool errors, raised before `handle` runs, in catherd's shape (spec §4.8): a call to a tool
 * this server does not have, or input a tool's schema rejects, is E_INPUT_INVALID; anything else is
 * unexpected.
 */
export function sdkToolError(message: string): CallToolResult {
  if (!message.startsWith(`MCP error ${ErrorCode.InvalidParams}:`)) return fail(new Error(message));
  const unknown = UNKNOWN_TOOL.exec(message)?.[1];
  return fail(
    new CatherdError("E_INPUT_INVALID", message, {
      fix: unknown
        ? `call a tool this server lists (tools/list); a skill that needs ${unknown} needs a newer catherd: claude plugin update catherd@catherd`
        : "correct the argument the message names, then call again",
    }),
  );
}
```

In `src/entry/mcp/server.ts`, replace:

```ts
import { defaultDeps } from "../deps.ts";
import { registerDispatchTools } from "./dispatch-tools.ts";
import { registerLaneTools } from "./lane-tools.ts";
import { sdkToolError } from "./result.ts";
import { registerRunTools } from "./run-tools.ts";
import { registerSetupTools } from "./setup-tools.ts";
```

with:

```ts
import { defaultDeps } from "../deps.ts";
import { registerDispatchTools } from "./dispatch-tools.ts";
import { registerLaneTools } from "./lane-tools.ts";
import { sdkToolError, toolOf } from "./result.ts";
import { registerRunTools } from "./run-tools.ts";
import { registerSetupTools } from "./setup-tools.ts";
```

In `src/entry/mcp/server.ts`, replace:

```ts
  const server = new McpServer({ name: "catherd", version: deps.version });
  logToolCalls(server);
  // The SDK validates input before a tool's `handle` runs and reports a failure through this (private)
  // method as plain text; test/entry/mcp.test.ts fails loudly if an SDK upgrade renames it.
  (server as unknown as { createToolError: typeof sdkToolError }).createToolError = sdkToolError;
  registerRunTools(server, deps);
  registerLaneTools(server, deps);
  registerDispatchTools(server, deps);
```

with:

```ts
  const server = new McpServer({ name: "catherd", version: deps.version });
  logToolCalls(server);
  // The SDK validates input before a tool's `handle` runs and reports a failure through this (private)
  // method as plain text; test/entry/mcp.test.ts fails loudly if an SDK upgrade renames it. Such a call
  // never reaches a handler, so it is logged here (spec §10.2: every call), without a duration.
  (server as unknown as { createToolError: typeof sdkToolError }).createToolError = (message) => {
    const r = sdkToolError(message);
    const code = (r.structuredContent as { code?: string } | undefined)?.code;
    log("warn", "tool", { tool: toolOf(message), ok: false, code });
    return r;
  };
  registerRunTools(server, deps);
  registerLaneTools(server, deps);
  registerDispatchTools(server, deps);
```

In `src/services/preflight.ts`, replace:

```ts
    };

export const CHECK_TIMEOUT_MS = 120_000;
const TAIL_LINES = 20;

interface LaneCheck {
```

with:

```ts
    };

export const CHECK_TIMEOUT_MS = 120_000;

/** Whose uid preflight runs under; tests stand in for root with it. */
export const preflightUser = { uid: (): number => process.getuid?.() ?? -1 };

/**
 * Spec §10.4: a lane's check never runs as root. A machine that says it is disposable (IS_SANDBOX, the
 * rule claude itself applies to root) is the one exception.
 */
const refusesRoot = (): boolean => preflightUser.uid() === 0 && !process.env.IS_SANDBOX;
const AS_ROOT =
  "not run: catherd runs as root, and preflight never runs a lane's check as root (spec §10.4); run catherd as a normal user, or set IS_SANDBOX=1 on a disposable machine";
const TAIL_LINES = 20;

interface LaneCheck {
```

In `src/services/preflight.ts`, replace:

```ts
      });
      continue;
    }
    const unborn = l.owns.filter(
      (p) => check.includes(p.replace(/\/$/, "")) && !existsSync(join(run.meta.repo, p)),
    );
```

with:

```ts
      });
      continue;
    }
    if (refusesRoot()) {
      results.push({ lane: l.lane, check, outcome: "skipped", exitCode: null, tail: [], note: AS_ROOT });
      continue;
    }
    const unborn = l.owns.filter(
      (p) => check.includes(p.replace(/\/$/, "")) && !existsSync(join(run.meta.repo, p)),
    );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/services/preflight.test.ts test/entry/mcp-log.test.ts test/entry/mcp.test.ts test/integration/mcp-stdio.test.ts`
Expected: PASS (`mcp.test.ts` still finds the SDK's `createToolError` hook and the E_INPUT_INVALID shape).

- [ ] **Step 5: Check and commit**

Run: `bun run format && bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: clean; the full suite passes.

```bash
git add src/services/preflight.ts src/entry/mcp/result.ts src/entry/mcp/server.ts test/services/preflight.test.ts test/entry/mcp-log.test.ts test/integration/mcp-stdio.test.ts
git commit -m "fix(mcp): log every call the sdk rejects, fix text for an unknown tool; preflight never as root"
```

---

### Task 5: Jev: cached answers checked, an unreadable key file named; `land` flags a milestone no lane is in

Plan 4's three deferred minors (Rulings 11, 12, 13). `savedJevKey()` reads `credentials.json` and hands back the reader's error; `jevKey()` keeps answering null for an unreadable file (Jev is optional) but logs why; Task 8 shows the error in `doctor`. A logged Jev answer goes through `parseReply` again before it is reused. `land` adds a hint when the run has routed lanes but none is in the landed milestone. One existing test lands a milestone with no routed lane, so it now expects that hint too.

**Files:**
- Modify: `src/services/jev-service.ts`, `src/services/lane-service.ts`
- Test: `test/services/jev-service.test.ts`, `test/services/outcomes.test.ts`, `test/services/lanes-run.test.ts`

**Interfaces:**
- Consumes: `parseReply` (`src/domain/jev.ts`), `readVersioned`, `log`, `CatherdError`, `isCatherdError`.
- Produces: `savedJevKey(): { key: string | null; problem: CatherdError | null }` (`src/services/jev-service.ts`), used by Task 8.

- [ ] **Step 1: Write the failing tests**

In `test/services/jev-service.test.ts`, replace:

```ts
  jevKey,
  logJev,
  saveJevKey,
  testJevKey,
} from "../../src/services/jev-service.ts";
import { fakeFetch } from "../fake-fetch.ts";
```

with:

```ts
  jevKey,
  logJev,
  saveJevKey,
  savedJevKey,
  testJevKey,
} from "../../src/services/jev-service.ts";
import { fakeFetch } from "../fake-fetch.ts";
```

In `test/services/jev-service.test.ts`, replace:

```ts
    });
  });

  it("refuses to overwrite a newer-schema or unreadable credentials file", () => {
    withHome();
    saveJevKey("a");
```

with:

```ts
    });
  });

  it("reads an unreadable credentials file as no key, logs why, and names the problem", () => {
    withHome();
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.CATHERD_LOG;
    saveJevKey("a");
    writeFileSync(credentialsPath(), "{not json");
    expect(jevKey()).toBeNull();
    expect(savedJevKey().problem).toMatchObject({
      code: "E_CONFIG_INVALID",
      fix: `fix or delete ${credentialsPath()}`,
    });
    const rows = readFileSync(logFile(), "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => JSON.parse(l));
    expect(rows.filter((r) => r.event === "jev").map((r) => r.error)).toEqual([
      expect.stringContaining(`no key: ${credentialsPath()} is not readable JSON`),
    ]);
  });

  it("refuses to overwrite a newer-schema or unreadable credentials file", () => {
    withHome();
    saveJevKey("a");
```

In `test/services/jev-service.test.ts`, replace:

```ts
    });
  });

  it("answers the same request from this run's log, and asks again for a changed state", async () => {
    const dir = runDir();
    const f = fakeFetch({ status: 200, body: fx("route-v2-track-a.json") });
```

with:

```ts
    });
  });

  it("asks again when the logged answer to the same request does not check out", async () => {
    const dir = runDir();
    const f = fakeFetch({ status: 200, body: fx("route-v2-track-a.json") });
    const first = await askJev(dir, "route-v2", STATE, { key: "k", fetchImpl: f.impl, ...noWait });
    const row = {
      ...first.meta,
      call: "route-v2" as const,
      lane: "M1.L1",
      derived: null,
      used: "x",
      source: "jev" as const,
      why: "ok",
    };
    // a hand-edited row: kind answered with an option the question does not have
    logJev(dir, {
      ...row,
      answers: {
        ...first.answers,
        kind: { type: "choice", choice: "poetry", probabilities: { poetry: 1 }, confidence: 1 },
      },
    });
    const again = await askJev(dir, "route-v2", STATE, { key: "k", fetchImpl: f.impl, ...noWait });
    expect(again.meta.cached).toBe(false);
    expect(again.answers).toEqual(first.answers);
    expect(f.sent).toHaveLength(2);
  });

  it("answers the same request from this run's log, and asks again for a changed state", async () => {
    const dir = runDir();
    const f = fakeFetch({ status: 200, body: fx("route-v2-track-a.json") });
```

In `test/services/outcomes.test.ts`, replace:

```ts
    expect(JSON.parse(first)).toEqual({ schema: 1, kind: "outcomes" });
  });

  it("writes an open row when a lane climbs past its top rung", async () => {
    const { run } = freshRun();
    const deps = jevDeps();
```

with:

```ts
    expect(JSON.parse(first)).toEqual({ schema: 1, kind: "outcomes" });
  });

  it("says so when no routed lane is in the landed milestone, as a typo in its name would", async () => {
    const { repo, run } = freshRun();
    const deps = jevDeps();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    await route(deps, { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
    const typo = await land(deps, {
      run: run.id,
      milestone: "m1",
      what: "jobs",
      commit: head(repo),
      evidence: "ok",
      next: "M2",
    });
    expect(typo.hints).toEqual([
      'land: no routed lane is in milestone "m1" (routed: M1.L1); check its name: no lane outcome was recorded',
    ]);
    expect(readOutcomes(run)).toEqual([]);
    expect((await landM1(deps, run.id, head(repo))).hints).toBeUndefined();
    expect(readOutcomes(run).map((o) => o.lane)).toEqual(["M1.L1"]);
  });

  it("writes an open row when a lane climbs past its top rung", async () => {
    const { run } = freshRun();
    const deps = jevDeps();
```

In `test/services/lanes-run.test.ts`, replace:

```ts
    expect(readFileSync(runPaths(run.dir).state, "utf8")).toBe(state);
    now += 4 * 60_000;
    // the landing time was kept although state.md was not refreshed
    expect(await land(deps, { ...land1, milestone: "M2" })).toMatchObject({ minutes: 4, hints: [hint] });
    expect(readFileSync(runPaths(run.dir).ledger, "utf8").trim().split("\n")).toHaveLength(3);
  });
});
```

with:

```ts
    expect(readFileSync(runPaths(run.dir).state, "utf8")).toBe(state);
    now += 4 * 60_000;
    // the landing time was kept although state.md was not refreshed
    expect(await land(deps, { ...land1, milestone: "M2" })).toMatchObject({
      minutes: 4,
      hints: [hint, expect.stringMatching(/^land: no routed lane is in milestone "M2"/)],
    });
    expect(readFileSync(runPaths(run.dir).ledger, "utf8").trim().split("\n")).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/services/jev-service.test.ts test/services/outcomes.test.ts test/services/lanes-run.test.ts`
Expected: FAIL — `jev-service.test.ts` cannot import `savedJevKey`; the typo landing has no hint; the `lanes-run.test.ts` landing of `M2` has one hint, not two.

- [ ] **Step 3: Write the implementation**

In `src/services/jev-service.ts`, replace:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  canonicalJson,
  type JevAnswers,
```

with:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CatherdError, isCatherdError } from "../domain/errors.ts";
import {
  canonicalJson,
  type JevAnswers,
```

In `src/services/jev-service.ts`, replace:

```ts
  typesafeApiKey: z.string().optional(),
});

/** Spec §5.5: `TYPESAFE_API_KEY`, else `<config>/credentials.json`; null when neither has one. */
export function jevKey(): string | null {
  const env = process.env.TYPESAFE_API_KEY?.trim();
  if (env) return env;
  if (!existsSync(credentialsPath())) return null;
  try {
    return readVersioned(credentialsPath(), CredentialsSchema, 1).typesafeApiKey?.trim() || null;
  } catch {
    return null;
  }
}

/**
```

with:

```ts
  typesafeApiKey: z.string().optional(),
});

/** The key saved in credentials.json, or why that file cannot be read (unparsable, newer schema). */
export function savedJevKey(): { key: string | null; problem: CatherdError | null } {
  if (!existsSync(credentialsPath())) return { key: null, problem: null };
  try {
    return {
      key: readVersioned(credentialsPath(), CredentialsSchema, 1).typesafeApiKey?.trim() || null,
      problem: null,
    };
  } catch (e) {
    return { key: null, problem: isCatherdError(e) ? e : new CatherdError("E_CONFIG_INVALID", String(e)) };
  }
}

/**
 * Spec §5.5: `TYPESAFE_API_KEY`, else `<config>/credentials.json`; null when neither has one. Jev is
 * optional (D1), so a credentials file that cannot be read means no key here; it is logged, and
 * `catherd doctor` says why.
 */
export function jevKey(): string | null {
  const env = process.env.TYPESAFE_API_KEY?.trim();
  if (env) return env;
  const { key, problem } = savedJevKey();
  if (problem) log("warn", "jev", { error: `no key: ${problem.message}` });
  return key;
}

/**
```

In `src/services/jev-service.ts`, replace:

```ts
    attempts: 0,
    cached: false,
  };
  const hit = readJsonl<Partial<JevRow>>(jevLog(runDir)).rows.find((r) => r.key === key && r.answers);
  if (hit?.answers) {
    const model = hit.model ?? null;
    return { answers: hit.answers, why: drift(model, f.model), meta: { ...meta, model, cached: true } };
  }
  const apiKey = o.key === undefined ? jevKey() : o.key;
  if (!apiKey) return { answers: null, why: "no key", meta };
```

with:

```ts
    attempts: 0,
    cached: false,
  };
  // a logged answer is checked like a fresh one: a row edited by hand, or cut short, is asked again
  for (const hit of readJsonl<Partial<JevRow>>(jevLog(runDir)).rows) {
    if (hit.key !== key || !hit.answers) continue;
    const cached = parseReply(questions, { model: hit.model ?? "", answers: hit.answers });
    if (!cached.ok) continue;
    const model = hit.model ?? null;
    return { answers: cached.answers, why: drift(model, f.model), meta: { ...meta, model, cached: true } };
  }
  const apiKey = o.key === undefined ? jevKey() : o.key;
  if (!apiKey) return { answers: null, why: "no key", meta };
```

In `src/services/lane-service.ts`, replace:

```ts
  const { hints } = await refreshState(run, landRow);
  // spec §5.6: every routed lane of the milestone lands with it
  // under the routes lock, so a racing climb cannot slip between the read and the rows
  await withFileLock(runPaths(run.dir).routes, () => {
    const routes = readRoutes(run);
    for (const lane of new Set(routes.map((r) => r.lane)))
      if (lane.startsWith(`${i.milestone}.`)) {
        const o = laneOutcome(routes, lane, true, now.toISOString());
        if (o) appendOutcome(run, o);
      }
  });
  if (i.learned) {
    const file = knowledgeFile(run.meta.repo);
    mkdirSync(dirname(file), { recursive: true });
```

with:

```ts
  const { hints } = await refreshState(run, landRow);
  // spec §5.6: every routed lane of the milestone lands with it
  // under the routes lock, so a racing climb cannot slip between the read and the rows
  let routed: string[] = [];
  let landed = 0;
  await withFileLock(runPaths(run.dir).routes, () => {
    const routes = readRoutes(run);
    routed = [...new Set(routes.map((r) => r.lane))];
    for (const lane of routed)
      if (lane.startsWith(`${i.milestone}.`)) {
        landed++;
        const o = laneOutcome(routes, lane, true, now.toISOString());
        if (o) appendOutcome(run, o);
      }
  });
  // a milestone name no routed lane starts with is most likely a typo: say so rather than record nothing
  if (routed.length > 0 && landed === 0)
    hints.push(
      `land: no routed lane is in milestone "${i.milestone}" (routed: ${routed.slice(0, 5).join(", ")}${routed.length > 5 ? ", …" : ""}); check its name: no lane outcome was recorded`,
    );
  if (i.learned) {
    const file = knowledgeFile(run.meta.repo);
    mkdirSync(dirname(file), { recursive: true });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/services/jev-service.test.ts test/services/outcomes.test.ts test/services/lanes-run.test.ts test/services/routing-service.test.ts`
Expected: PASS (`routing-service.test.ts` reuses logged answers through the same path).

- [ ] **Step 5: Check and commit**

Run: `bun run format && bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: clean; the full suite passes.

```bash
git add src/services/jev-service.ts src/services/lane-service.ts test/services/jev-service.test.ts test/services/outcomes.test.ts test/services/lanes-run.test.ts
git commit -m "fix(jev): check cached answers, name an unreadable key file; land flags a milestone typo"
```

---

### Task 6: Profiles a newer catherd wrote: every value readable, read the cautious way, kept, and named

Plan 5's Task 1 minor and Ruling 14: the stored schema closed `billing`, `access` and `notify` (and `objective`, `jev.use`) to this version's values, so a value a newer catherd wrote made the whole profile unreadable, against spec §3.4. The stored schema now takes any string there; `resolveProfile` reads what it does not know through `STORED_FALLBACK`; `unknownValues(doc)` lists them, and `validateProfile` warns about each when it is given the stored document, which the ProfileService now passes.

**Files:**
- Modify: `src/domain/profile.ts`, `src/domain/profile-rules.ts`, `src/services/profile-service.ts`
- Test: `test/domain/profile.test.ts`, `test/services/profile-service.test.ts`

**Interfaces:**
- Consumes: `BILLING_MODES`, `DEFAULT_BILLING`, `ACCESS`, `DEFAULT_ACCESS`, `NOTIFY`, `ROLES`.
- Produces: `STORED_FALLBACK`, `interface UnknownValue { path; value; readAs }`, `unknownValues(doc: ProfileDoc): UnknownValue[]` (`src/domain/profile.ts`); `validateProfile(p, c, backends, doc?: ProfileDoc)` (`src/domain/profile-rules.ts`). `ProfileDoc`'s `objective`, `jev.use`, `billing` values, `roles.*.access` and `notify` entries become `string`; `Profile` keeps its enum types.

- [ ] **Step 1: Write the failing tests**

In `test/domain/profile.test.ts`, replace:

```ts
  ProfileDocSchema,
  ProfilePatchSchema,
  resolveProfile,
} from "../../src/domain/profile.ts";
import { ROLES } from "../../src/domain/roles.ts";
```

with:

```ts
  ProfileDocSchema,
  ProfilePatchSchema,
  resolveProfile,
  unknownValues,
} from "../../src/domain/profile.ts";
import { ROLES } from "../../src/domain/roles.ts";
```

In `test/domain/profile.test.ts`, replace:

```ts
  });
});

describe("applyPatch", () => {
  it("replaces lists, merges maps, and deletes a key patched to null", () => {
    const doc = defaultProfileDoc();
```

with:

```ts
  });
});

describe("values a newer catherd wrote (spec §3.4)", () => {
  const newer = ProfileDocSchema.parse({
    schema: 1,
    objective: "quality",
    jev: { use: "findings-only" },
    billing: { codex: "chatgpt-pro", grok: "supergrok" },
    roles: { worker: { access: "network-off" } },
    notify: ["finish", "every-lane"],
  });

  it("reads each one the cautious way instead of refusing the profile", () => {
    const p = resolveProfile(newer, "x");
    expect(p.objective).toBe("cost");
    expect(p.jev.use).toBe("off");
    expect(p.billing).toMatchObject({ codex: "chatgpt-plan", grok: "metered" });
    expect(p.roles.worker.access).toBe("read-only");
    expect(p.notify).toEqual(["finish"]);
  });

  it("names each one with what it is read as, and keeps it through a patch", () => {
    expect(unknownValues(newer)).toEqual([
      { path: "objective", value: "quality", readAs: "cost" },
      { path: "jev.use", value: "findings-only", readAs: "off" },
      { path: "billing.codex", value: "chatgpt-pro", readAs: "chatgpt-plan" },
      { path: "billing.grok", value: "supergrok", readAs: "metered" },
      { path: "roles.worker.access", value: "network-off", readAs: "read-only" },
      { path: "notify", value: "every-lane", readAs: "skipped" },
    ]);
    expect(unknownValues(defaultProfileDoc())).toEqual([]);
    const after = applyPatch(newer, { budget: { usd: 5 } });
    expect(after).toMatchObject({
      objective: "quality",
      billing: { codex: "chatgpt-pro" },
      notify: ["finish", "every-lane"],
    });
  });
});

describe("applyPatch", () => {
  it("replaces lists, merges maps, and deletes a key patched to null", () => {
    const doc = defaultProfileDoc();
```

In `test/services/profile-service.test.ts`, replace:

```ts
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { claudeAgentsDir, configDir } from "../../src/infra/paths.ts";
import {
  activate,
```

with:

```ts
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { defaultProfileDoc } from "../../src/domain/profile.ts";
import { claudeAgentsDir, configDir } from "../../src/infra/paths.ts";
import {
  activate,
```

In `test/services/profile-service.test.ts`, replace:

```ts
    ]);
  });

  it("writes nothing when the result is invalid, and returns the errors", () => {
    withHome();
    patchProfile("default", {});
```

with:

```ts
    ]);
  });

  it("reads a profile a newer catherd wrote, warns about the values it does not know, and keeps them", () => {
    withHome();
    mkdirSync(profilesDir(), { recursive: true });
    const doc = defaultProfileDoc();
    writeFileSync(
      file("default"),
      JSON.stringify({
        ...doc,
        roles: { ...doc.roles, reviewer: { ...doc.roles?.reviewer, access: "network-off" } },
      }),
    );
    expect(getProfile("default").roles.reviewer.access).toBe("read-only");
    expect(validateNamed("default").warnings).toContainEqual({
      path: "roles.reviewer.access",
      message:
        '"network-off" is not a value this catherd knows (a newer one wrote it?); it is read as read-only',
      fix: "upgrade catherd (bunx catherd-cli@latest), or set a value this version knows",
    });
    expect(patchProfile("default", { budget: { usd: 5 } }).saved).toBe(true);
    expect(JSON.parse(readFileSync(file("default"), "utf8")).roles.reviewer.access).toBe("network-off");
  });

  it("writes nothing when the result is invalid, and returns the errors", () => {
    withHome();
    patchProfile("default", {});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/domain/profile.test.ts test/services/profile-service.test.ts`
Expected: FAIL — `profile.test.ts` cannot import `unknownValues`; reading the profile with `access: "network-off"` throws `E_CONFIG_INVALID`.

- [ ] **Step 3: Write the implementation**

In `src/domain/profile-rules.ts`, replace:

```ts
} from "./catalog.ts";
import { parseRung, type Rung } from "./ids.ts";
import { DIFFICULTIES, KINDS } from "./lane.ts";
import type { Profile } from "./profile.ts";
import { DEFAULT_ACCESS, ROLES, type Role } from "./roles.ts";
import { candidates, clearsBar, type RoutingProfile } from "./select.ts";
```

with:

```ts
} from "./catalog.ts";
import { parseRung, type Rung } from "./ids.ts";
import { DIFFICULTIES, KINDS } from "./lane.ts";
import { type Profile, type ProfileDoc, unknownValues } from "./profile.ts";
import { DEFAULT_ACCESS, ROLES, type Role } from "./roles.ts";
import { candidates, clearsBar, type RoutingProfile } from "./select.ts";
```

In `src/domain/profile-rules.ts`, replace:

```ts
 * mode other than the role's default, an effort or model the last listing does not offer, a stand-in
 * that never runs.
 */
export function validateProfile(p: Profile, c: Catalog, backends: readonly string[]): Validation {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  if (!p.roles.worker.enabled)
    errors.push({
      path: "roles.worker.enabled",
```

with:

```ts
 * mode other than the role's default, an effort or model the last listing does not offer, a stand-in
 * that never runs.
 */
/**
 * Spec §7.1's errors and warnings for `p`. With the stored `doc` it came from, a value this catherd does
 * not know is a warning that says how it is read.
 */
export function validateProfile(
  p: Profile,
  c: Catalog,
  backends: readonly string[],
  doc?: ProfileDoc,
): Validation {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  for (const u of doc ? unknownValues(doc) : [])
    warnings.push({
      path: u.path,
      message: `"${u.value}" is not a value this catherd knows (a newer one wrote it?); it is read as ${u.readAs}`,
      fix: "upgrade catherd (bunx catherd-cli@latest), or set a value this version knows",
    });
  if (!p.roles.worker.enabled)
    errors.push({
      path: "roles.worker.enabled",
```

In `src/domain/profile.ts`, replace:

```ts
const positive = z.number().positive();

// Stored files: every level is loose, so fields a newer catherd wrote survive a rewrite (spec §3.4), and
// rung strings are checked by validateProfile rather than making the whole file unreadable.
const RoleDocSchema = z.looseObject({
  enabled: z.boolean().optional(),
  access: z.enum(ACCESS).optional(),
  rungs: z.array(z.string()).optional(),
  defaultRung: z.string().optional(),
});
```

with:

```ts
const positive = z.number().positive();

// Stored files: every level is loose, so fields a newer catherd wrote survive a rewrite (spec §3.4), and
// rung strings are checked by validateProfile rather than making the whole file unreadable. The same holds
// for values: a stored enum takes any string, resolveProfile reads one it does not know as STORED_FALLBACK
// says, validateProfile warns, and the file keeps it.
const RoleDocSchema = z.looseObject({
  enabled: z.boolean().optional(),
  access: z.string().optional(),
  rungs: z.array(z.string()).optional(),
  defaultRung: z.string().optional(),
});
```

In `src/domain/profile.ts`, replace:

```ts
export const ProfileDocSchema = z.looseObject({
  schema: z.literal(PROFILE_SCHEMA),
  name: z.string().optional(),
  objective: z.enum(["cost", "speed"]).optional(),
  jev: z.looseObject({ use: z.enum(["auto", "off"]).optional() }).optional(),
  billing: z.record(z.string(), z.enum(BILLING_MODES)).optional(),
  roles: z.record(z.string(), RoleDocSchema).optional(),
  harness: z.record(z.string(), z.looseObject({ isolated: z.boolean().optional() })).optional(),
  failover: z.record(z.string(), z.string()).optional(),
```

with:

```ts
export const ProfileDocSchema = z.looseObject({
  schema: z.literal(PROFILE_SCHEMA),
  name: z.string().optional(),
  objective: z.string().optional(),
  jev: z.looseObject({ use: z.string().optional() }).optional(),
  billing: z.record(z.string(), z.string()).optional(),
  roles: z.record(z.string(), RoleDocSchema).optional(),
  harness: z.record(z.string(), z.looseObject({ isolated: z.boolean().optional() })).optional(),
  failover: z.record(z.string(), z.string()).optional(),
```

In `src/domain/profile.ts`, replace:

```ts
  lock: z
    .looseObject({ heavy: z.union([z.number().int().positive(), z.literal("cpus/2")]).optional() })
    .optional(),
  notify: z.array(z.enum(NOTIFY)).optional(),
});
export type ProfileDoc = z.infer<typeof ProfileDocSchema>;

// a type, not an interface, so the built-in roles can be written into a loose (indexed) document
export type RoleConfig = {
  enabled: boolean;
```

with:

```ts
  lock: z
    .looseObject({ heavy: z.union([z.number().int().positive(), z.literal("cpus/2")]).optional() })
    .optional(),
  notify: z.array(z.string()).optional(),
});
export type ProfileDoc = z.infer<typeof ProfileDocSchema>;

const OBJECTIVES = ["cost", "speed"] as const;
const JEV_USES = ["auto", "off"] as const;
const known = <T extends string>(values: readonly T[], v: string | undefined): v is T =>
  v !== undefined && (values as readonly string[]).includes(v);

/**
 * How a stored value this catherd does not know (a newer one wrote it) is read, always the cautious way:
 * access as read-only, billing as the key's default mode, Jev as off, so nothing is sent or written that
 * the value may not allow; an unknown notify moment is skipped.
 */
export const STORED_FALLBACK = {
  objective: "cost",
  jevUse: "off",
  access: "read-only",
  billing: (key: string): BillingMode => DEFAULT_BILLING[key as BillingKey] ?? "metered",
} as const;

/** A stored value this catherd does not know, with what it is read as. */
export interface UnknownValue {
  path: string;
  value: string;
  readAs: string;
}

/** Every stored enum value in `doc` this catherd does not know (spec §3.4: newer files stay readable). */
export function unknownValues(doc: ProfileDoc): UnknownValue[] {
  const out: UnknownValue[] = [];
  const check = (path: string, values: readonly string[], v: string | undefined, readAs: string) => {
    if (v !== undefined && !values.includes(v)) out.push({ path, value: v, readAs });
  };
  check("objective", OBJECTIVES, doc.objective, STORED_FALLBACK.objective);
  check("jev.use", JEV_USES, doc.jev?.use, STORED_FALLBACK.jevUse);
  for (const [k, v] of Object.entries(doc.billing ?? {}))
    check(`billing.${k}`, BILLING_MODES, v, STORED_FALLBACK.billing(k));
  for (const role of ROLES)
    check(`roles.${role}.access`, ACCESS, doc.roles?.[role]?.access, STORED_FALLBACK.access);
  for (const n of doc.notify ?? []) check("notify", NOTIFY, n, "skipped");
  return out;
}

// a type, not an interface, so the built-in roles can be written into a loose (indexed) document
export type RoleConfig = {
  enabled: boolean;
```

In `src/domain/profile.ts`, replace:

```ts
    const defaultRung = d?.defaultRung ?? (d?.rungs === undefined ? b.defaultRung : undefined);
    roles[role] = {
      enabled: d?.enabled ?? b.enabled,
      access: d?.access ?? DEFAULT_ACCESS[role],
      rungs: [...(d?.rungs ?? b.rungs)],
      ...(defaultRung ? { defaultRung } : {}),
    };
```

with:

```ts
    const defaultRung = d?.defaultRung ?? (d?.rungs === undefined ? b.defaultRung : undefined);
    roles[role] = {
      enabled: d?.enabled ?? b.enabled,
      access:
        d?.access === undefined
          ? DEFAULT_ACCESS[role]
          : known(ACCESS, d.access)
            ? d.access
            : STORED_FALLBACK.access,
      rungs: [...(d?.rungs ?? b.rungs)],
      ...(defaultRung ? { defaultRung } : {}),
    };
```

In `src/domain/profile.ts`, replace:

```ts
    const v = doc.budget?.[k];
    if (v !== undefined) budget[k] = v;
  }
  return {
    name,
    objective: doc.objective ?? "cost",
    jev: { use: doc.jev?.use ?? "auto" },
    billing: { ...DEFAULT_BILLING, ...doc.billing },
    roles,
    harness,
    failover: { ...doc.failover },
```

with:

```ts
    const v = doc.budget?.[k];
    if (v !== undefined) budget[k] = v;
  }
  const billing: Record<string, BillingMode> = { ...DEFAULT_BILLING };
  for (const [k, v] of Object.entries(doc.billing ?? {}))
    billing[k] = known(BILLING_MODES, v) ? v : STORED_FALLBACK.billing(k);
  const use = doc.jev?.use;
  return {
    name,
    objective: known(OBJECTIVES, doc.objective) ? doc.objective : STORED_FALLBACK.objective,
    jev: { use: use === undefined ? "auto" : known(JEV_USES, use) ? use : STORED_FALLBACK.jevUse },
    billing,
    roles,
    harness,
    failover: { ...doc.failover },
```

In `src/domain/profile.ts`, replace:

```ts
    timeouts: { idleMin: doc.timeouts?.idleMin ?? 15, wallMin: doc.timeouts?.wallMin ?? 90 },
    preflight: { confirm: doc.preflight?.confirm ?? false },
    lock: { heavy: doc.lock?.heavy ?? "cpus/2" },
    notify: [...(doc.notify ?? NOTIFY)],
  };
}
```

with:

```ts
    timeouts: { idleMin: doc.timeouts?.idleMin ?? 15, wallMin: doc.timeouts?.wallMin ?? 90 },
    preflight: { confirm: doc.preflight?.confirm ?? false },
    lock: { heavy: doc.lock?.heavy ?? "cpus/2" },
    notify: doc.notify === undefined ? [...NOTIFY] : doc.notify.filter((n) => known(NOTIFY, n)),
  };
}
```

In `src/services/profile-service.ts`, replace:

```ts
  backends.includes(backendOfKey(key));

export function validateNamed(name?: string): Validation {
  return validateProfile(
    getProfile(name ?? activeName()),
    loadCatalog({ timings: false }),
    runnableBackends(),
  );
}

/** Spec D10: how strongly the backend holds a role to its access mode. */
```

with:

```ts
  backends.includes(backendOfKey(key));

export function validateNamed(name?: string): Validation {
  const n = name ?? activeName();
  const doc = readProfileDoc(n);
  return validateProfile(resolveProfile(doc, n), loadCatalog({ timings: false }), runnableBackends(), doc);
}

/** Spec D10: how strongly the backend holds a role to its access mode. */
```

In `src/services/profile-service.ts`, replace:

```ts
}

const validate = (doc: ProfileDoc, name: string): Validation =>
  validateProfile(resolveProfile(doc, name), loadCatalog({ timings: false }), runnableBackends());

export interface Saved extends Synced {
  saved: boolean;
```

with:

```ts
}

const validate = (doc: ProfileDoc, name: string): Validation =>
  validateProfile(resolveProfile(doc, name), loadCatalog({ timings: false }), runnableBackends(), doc);

export interface Saved extends Synced {
  saved: boolean;
```

`validateNamed` and `validate` are the two places plan 5's final fix wave may have reshaped: find them by name and make each pass the stored document as `validateProfile`'s fourth argument. If `bun run typecheck` then names a file under `src/entry/tui/` that reads one of the opened fields from a `ProfileDoc` as its enum type, read it from the resolved `Profile` there instead.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/domain test/services/profile-service.test.ts test/entry/profile-command.test.ts test/entry/mcp-profile.test.ts`
Expected: PASS.

- [ ] **Step 5: Check and commit**

Run: `bun run format && bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: clean; the full suite passes.

```bash
git add src/domain/profile.ts src/domain/profile-rules.ts src/services/profile-service.ts test/domain/profile.test.ts test/services/profile-service.test.ts
git commit -m "fix(profile): read values a newer catherd wrote the cautious way, keep them, and warn"
```

---

### Task 7: The CLI: Ctrl-C belongs to `lock` after any flag; signal tests that wait on events; `runs show --debug` tails from the end

Plan 5's Task 8 notes for plan 7 and its final-review deferral, with the coordinator's addition: the Ctrl-C exemption keyed on `own[0]`, so `catherd --plain lock -- cmd` (plan 6 adds `--plain`) exited 130 at once and left the command running; `cli.test.ts`'s SIGINT test slept 800 ms before signalling; `lock.test.ts`'s double Ctrl-C sent the second signal after a 200 ms sleep, and two signals that arrive together can merge into one, which hung the test; its SIGTERM/SIGHUP test waited for a grandchild that stays a zombie where pid 1 does not reap (it now uses `exited`). `runs show --debug` read whole stderr and event files to print 20 lines.

**Files:**
- Modify: `src/cli.ts`, `src/services/run-debug.ts`
- Create: `test/services/run-debug.test.ts`
- Test: `test/entry/cli.test.ts`, `test/entry/lock.test.ts`

**Interfaces:**
- Consumes: Task 2 (`exited`); `killGroup`; `waitFor`.
- Produces: `tail(file: string, n = TAIL_LINES, chunk = 64 * 1024): string[]` (`src/services/run-debug.ts`, now exported).

- [ ] **Step 1: Write the failing tests**

In `test/entry/cli.test.ts`, replace:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { bunTooOld, MIN_BUN, runtimeRefusal } from "../../src/domain/runtime.ts";
import { VERSION } from "../../src/infra/version.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
```

with:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killGroup } from "../../src/infra/proc.ts";
import { waitFor } from "../services/helpers.ts";
import { bunTooOld, MIN_BUN, runtimeRefusal } from "../../src/domain/runtime.ts";
import { VERSION } from "../../src/infra/version.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
```

In `test/entry/cli.test.ts`, replace:

```ts
    const p = Bun.spawn([process.execPath, CLI, "mcp"], {
      env: { ...process.env, CATHERD_HOME: home },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    });
    await Bun.sleep(800);
    p.kill("SIGINT");
    expect(await p.exited).toBe(130);
  });

  it("never loads OpenTUI or React for mcp, lock or _supervise (spec §3.1)", () => {
    for (const entry of ["entry/mcp/command.ts", "entry/lock.ts", "entry/supervise.ts"]) {
      const g = importGraph(join(SRC, entry));
```

with:

```ts
    const p = Bun.spawn([process.execPath, CLI, "mcp"], {
      env: { ...process.env, CATHERD_HOME: home },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    // Ctrl-C once the server answers: the command is running, not starting
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    };
    p.stdin.write(`${JSON.stringify(initialize)}\n`);
    p.stdin.flush();
    const reader = p.stdout.getReader();
    let seen = "";
    while (!seen.includes('"id":1')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`catherd mcp exited before it answered: ${seen}`);
      seen += new TextDecoder().decode(chunk.value);
    }
    p.kill("SIGINT");
    expect(await p.exited).toBe(130);
  });

  it("leaves Ctrl-C to lock's command even after a flag, and exits with the command's code", async () => {
    const home = withHome();
    const dir = mkdtempSync(join(tmpdir(), "catherd-int-"));
    const [pidFile, heard] = [join(dir, "pid"), join(dir, "heard")];
    const script = `trap 'echo INT >> ${heard}; exit 5' INT; echo $$ > ${pidFile}; while :; do sleep 0.05; done`;
    const p = Bun.spawn(
      [process.execPath, CLI, "--plain", "lock", "--slots", "1", "--", "sh", "-c", script],
      {
        env: { ...process.env, CATHERD_HOME: home },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    try {
      await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim());
      p.kill("SIGINT");
      expect(await p.exited).toBe(5);
      expect(readFileSync(heard, "utf8")).toBe("INT\n");
    } finally {
      // a catherd that exited on its own Ctrl-C leaves the command running: stop it
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (pid > 1) killGroup(pid, "SIGKILL");
    }
  });

  it("never loads OpenTUI or React for mcp, lock or _supervise (spec §3.1)", () => {
    for (const entry of ["entry/mcp/command.ts", "entry/lock.ts", "entry/supervise.ts"]) {
      const g = importGraph(join(SRC, entry));
```

In `test/entry/lock.test.ts`, replace:

```ts
import { join } from "node:path";
import { resolveSlots } from "../../src/entry/lock.ts";
import { heavySlots } from "../../src/infra/heavy-lock.ts";
import { isAlive } from "../../src/infra/proc.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { waitFor } from "../services/helpers.ts";

afterEach(snapshotEnv());
```

with:

```ts
import { join } from "node:path";
import { resolveSlots } from "../../src/entry/lock.ts";
import { heavySlots } from "../../src/infra/heavy-lock.ts";
import { killGroup } from "../../src/infra/proc.ts";
import { exited, snapshotEnv, withHome } from "../helpers.ts";
import { waitFor } from "../services/helpers.ts";

afterEach(snapshotEnv());
```

In `test/entry/lock.test.ts`, replace:

```ts
      const { p, grandchild } = await locked("sleep 30 & echo $! > PIDFILE; wait");
      p.kill(sig);
      expect(await p.exited).toBe(128 + (sig === "SIGTERM" ? 15 : 1));
      await waitFor(() => !isAlive(grandchild, null));
    });

  it("kills a command that ignores Ctrl-C on the second Ctrl-C", async () => {
    const { p } = await locked("trap '' INT; echo $$ > PIDFILE; while :; do sleep 0.1; done");
    p.kill("SIGINT");
    await Bun.sleep(200);
    p.kill("SIGINT");
    expect(await p.exited).toBe(137);
  });
});
```

with:

```ts
      const { p, grandchild } = await locked("sleep 30 & echo $! > PIDFILE; wait");
      p.kill(sig);
      expect(await p.exited).toBe(128 + (sig === "SIGTERM" ? 15 : 1));
      await waitFor(() => exited(grandchild));
    });

  it("kills a command that ignores Ctrl-C on the second Ctrl-C", async () => {
    const heard = join(mkdtempSync(join(tmpdir(), "catherd-lockint-")), "heard");
    // the trap records each Ctrl-C and carries on, as a command that ignores it would
    const { p, grandchild } = await locked(
      `trap 'echo INT >> ${heard}' INT; echo $$ > PIDFILE; while :; do sleep 0.1; done`,
    );
    try {
      p.kill("SIGINT");
      // the second Ctrl-C only once the first reached the command: two signals sent at once may merge into one
      await waitFor(() => existsSync(heard), 5_000);
      p.kill("SIGINT");
      expect(await p.exited).toBe(137);
    } finally {
      killGroup(grandchild, "SIGKILL");
    }
  }, 15_000);
});
```

`test/services/run-debug.test.ts` (new):

```ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tail } from "../../src/services/run-debug.ts";

describe("tail", () => {
  const dir = mkdtempSync(join(tmpdir(), "catherd-tail-"));
  const lines = Array.from({ length: 1000 }, (_, i) => `line ${i} é🐈`);
  const file = join(dir, "stderr");
  writeFileSync(file, `${lines.join("\n")}\n\n  \n`);

  it("reads the last lines from the end, keeping a line and a character split between reads whole", () => {
    // 7-byte reads split lines and multi-byte characters over and over
    expect(tail(file, 20, 7)).toEqual(lines.slice(-20));
    expect(tail(file, 20)).toEqual(lines.slice(-20));
  });

  it("returns every line of a file shorter than asked, and nothing for a missing file", () => {
    expect(tail(file, 5000, 64)).toEqual(lines);
    expect(tail(join(dir, "missing"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/entry/cli.test.ts test/entry/lock.test.ts test/services/run-debug.test.ts`
Expected: FAIL — `run-debug.test.ts` cannot import `tail`; `catherd --plain lock` exits 130 instead of the command's 5 (the command never hears the Ctrl-C). The rewritten `lock.test.ts` and "exits 130 when interrupted" tests pass already: they changed how they wait, not what they check.

- [ ] **Step 3: Write the implementation**

In `src/cli.ts`, replace:

```ts
    await showUsage(cmd, parent);
    return EXIT.ok;
  }
  // `lock` forwards signals to its command itself; everything else stops at once on Ctrl-C.
  if (own[0] !== "lock") process.once("SIGINT", () => process.exit(EXIT.interrupted));
  try {
    await runCommand(main, { rawArgs });
    return Number(process.exitCode ?? EXIT.ok);
```

with:

```ts
    await showUsage(cmd, parent);
    return EXIT.ok;
  }
  // `lock` forwards signals to its command itself; everything else stops at once on Ctrl-C. The command is
  // the first word that is not a flag: `catherd --plain lock -- …` is `lock` too.
  if (own.find((a) => !a.startsWith("-")) !== "lock")
    process.once("SIGINT", () => process.exit(EXIT.interrupted));
  try {
    await runCommand(main, { rawArgs });
    return Number(process.exitCode ?? EXIT.ok);
```

In `src/services/run-debug.ts`, replace:

```ts
import { existsSync, readFileSync } from "node:fs";
import type { ExitInfo, RunRecord } from "../domain/record.ts";
import { dispatchPaths, readExit } from "../infra/dispatch-dir.ts";
import { redact } from "../infra/log.ts";
```

with:

```ts
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { ExitInfo, RunRecord } from "../domain/record.ts";
import { dispatchPaths, readExit } from "../infra/dispatch-dir.ts";
import { redact } from "../infra/log.ts";
```

In `src/services/run-debug.ts`, replace:

```ts
  supervisorTail: string[];
}

function tail(file: string, n = TAIL_LINES): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .slice(-n);
}

/**
```

with:

```ts
  supervisorTail: string[];
}

/**
 * The last `n` non-blank lines of `file`, read backwards `chunk` bytes at a time until they are in hand:
 * a worker's stderr or event stream can be large, and only its end is shown. [] when there is no file.
 */
export function tail(file: string, n = TAIL_LINES, chunk = 64 * 1024): string[] {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return [];
  }
  try {
    let pos = fstatSync(fd).size;
    let buf = Buffer.alloc(0);
    for (;;) {
      const lines = buf.toString("utf8").split("\n");
      // the first line may start mid-line, or mid-character: it counts only once the file's start is read
      if (pos > 0) lines.shift();
      const kept = lines.filter((l) => l.trim());
      if (kept.length >= n || pos === 0) return kept.slice(-n);
      const len = Math.min(chunk, pos);
      pos -= len;
      const part = Buffer.alloc(len);
      readSync(fd, part, 0, len, pos);
      buf = Buffer.concat([part, buf]);
    }
  } finally {
    closeSync(fd);
  }
}

/**
```

The Ctrl-C line in `src/cli.ts` is the one plan 6's Task 12 leaves in place (it adds `--plain` and `--reduced-motion` elsewhere in the file); find it by its comment.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/entry/cli.test.ts test/entry/lock.test.ts test/services/run-debug.test.ts test/entry/runs-command.test.ts`
Expected: PASS; run `test/entry/lock.test.ts` three times in a row to see it hold.

- [ ] **Step 5: Check and commit**

Run: `bun run format && bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: clean; the full suite passes.

```bash
git add src/cli.ts src/services/run-debug.ts test/entry/cli.test.ts test/entry/lock.test.ts test/services/run-debug.test.ts
git commit -m "fix(cli): ctrl-c stays lock's after a flag, event-driven signal tests, debug tails from the end"
```

---

### Task 8: `doctor`: how Codex is logged in, a billing that does not match it, an unreadable credentials file

Rulings 11 and 19. The HANDOFF asked that `doctor` call `refreshDiscovery` and `testJevKey` (plan 5 did: `backendChecks` and the `jev` row) and report whether Codex is logged in with ChatGPT, which it did not. The Codex probe now reads how from `codex login status` and says it through two new optional `Probe` fields, so `doctor` stays backend-agnostic: the login goes on the backend's row, and a linked profile whose billing for that backend differs from what the login implies turns the row into a warning with the `profile set` fix. The `credentials` row warns when the file cannot be read (Task 5's `savedJevKey`). The Codex simulator prints the login state on stderr, as Codex does, and can be logged in with an API key.

**Files:**
- Modify: `src/adapters/backend.ts`, `src/adapters/codex/index.ts`, `src/services/doctor.ts`, `test/sim/codex`, `test/sim/scenario.ts`
- Test: `test/services/doctor.test.ts`, `test/adapters/codex.test.ts`, `test/sim/codex.test.ts`

**Interfaces:**
- Consumes: Task 2 (`sh` through `runCli` in the Codex adapter), Task 5 (`savedJevKey`); `BillingMode` (`src/domain/cost.ts`).
- Produces: `Probe.login?: string` and `Probe.billing?: BillingMode` (`src/adapters/backend.ts`); the Codex simulator's `login?: "chatgpt" | "api-key"` scenario key.

- [ ] **Step 1: Write the failing tests**

In `test/adapters/codex.test.ts`, replace:

```ts
    expect(p.problems[0]).toMatchObject({ code: "E_BACKEND_MISSING", fix: "npm i -g @openai/codex" });
  });

  it("treats a codex login status that hangs as not logged in, within the timeout", async () => {
    const saved = codexShell.timeoutMs;
    codexShell.timeoutMs = 300;
```

with:

```ts
    expect(p.problems[0]).toMatchObject({ code: "E_BACKEND_MISSING", fix: "npm i -g @openai/codex" });
  });

  it("says whether codex is logged in with ChatGPT or an API key, and the billing each implies", async () => {
    process.env.PATH = simPath();
    Object.assign(process.env, withScenario({}).env);
    expect(await codexAdapter.probe()).toMatchObject({
      loggedIn: true,
      login: "ChatGPT",
      billing: "chatgpt-plan",
    });
    Object.assign(process.env, withScenario({ login: "api-key" }).env);
    expect(await codexAdapter.probe()).toMatchObject({
      loggedIn: true,
      login: "API key",
      billing: "metered",
    });
    Object.assign(process.env, withScenario({ loggedIn: false }).env);
    const out = await codexAdapter.probe();
    expect([out.loggedIn, out.login, out.billing]).toEqual([false, undefined, undefined]);
  });

  it("treats a codex login status that hangs as not logged in, within the timeout", async () => {
    const saved = codexShell.timeoutMs;
    codexShell.timeoutMs = 300;
```

In `test/services/doctor.test.ts`, replace:

```ts
      "access:full": "warn warning",
      "access:advisory": "warn warning",
    });
    expect(check(r, "backend:codex")?.detail).toMatch(/^0\.157\.0 · \d+ models$/);
    expect(check(r, "agents")?.detail).toBe("2 linked");
    expect(check(r, "access:full")?.detail).toBe("no sandbox for: verifier (default), ui-reviewer (default)");
  });
```

with:

```ts
      "access:full": "warn warning",
      "access:advisory": "warn warning",
    });
    expect(check(r, "backend:codex")?.detail).toMatch(/^0\.157\.0 · ChatGPT login · \d+ models$/);
    expect(check(r, "agents")?.detail).toBe("2 linked");
    expect(check(r, "access:full")?.detail).toBe("no sandbox for: verifier (default), ui-reviewer (default)");
  });
```

In `test/services/doctor.test.ts`, replace:

```ts
    });
  });

  it("fails without the plugin, or with a plugin of another version", async () => {
    machine();
    patchProfile("default", {});
```

with:

```ts
    });
  });

  it("says how Codex is logged in, and warns when a profile bills that login as something else", async () => {
    machine({ codex: { login: "api-key" } });
    installPlugin(VERSION);
    patchProfile("default", {});
    const r = await run();
    expect(check(r, "backend:codex")).toMatchObject({
      state: "warn",
      word: "billing",
      detail: expect.stringMatching(
        /^0\.157\.0 · API key login · profile default bills codex as chatgpt-plan, but this login is metered/,
      ),
      fix: "catherd profile set billing.codex metered --profile default",
    });
    expect(JSON.stringify(r)).not.toContain("sk-proj");
    patchProfile("default", { billing: { codex: "metered" } });
    expect(check(await run(), "backend:codex")).toMatchObject({ state: "ok", word: "ready" });
  });

  it("fails without the plugin, or with a plugin of another version", async () => {
    machine();
    patchProfile("default", {});
```

In `test/services/doctor.test.ts`, replace:

```ts
    });
  });

  it("turns a corrupt catalog override into a fail row with its fix, not a throw", async () => {
    ready();
    writeFileSync(overridePath(), "{ not json");
```

with:

```ts
    });
  });

  it("warns on a credentials file it cannot read, which Jev takes for no key", async () => {
    ready();
    saveJevKey("tsk-test-key-0123456789");
    writeFileSync(credentialsPath(), "{ not json");
    const r = await run();
    expect(check(r, "credentials")).toMatchObject({
      state: "warn",
      word: "unreadable",
      fix: `fix or delete ${credentialsPath()}`,
    });
    expect(check(r, "jev")).toMatchObject({ state: "warn", word: "no key" });
  });

  it("turns a corrupt catalog override into a fail row with its fix, not a throw", async () => {
    ready();
    writeFileSync(overridePath(), "{ not json");
```

In `test/sim/codex`, replace:

```ts
}
if (args[0] === "login" && args[1] === "status") {
  if (s.loginHangMs) await Bun.sleep(s.loginHangMs);
  say(s.loggedIn === false ? "Not logged in" : "Logged in using ChatGPT");
  process.exit(s.loggedIn === false ? 1 : 0);
}
if (args[0] === "debug" && args[1] === "models") {
```

with:

```ts
}
if (args[0] === "login" && args[1] === "status") {
  if (s.loginHangMs) await Bun.sleep(s.loginHangMs);
  // codex prints the login state on stderr
  process.stderr.write(
    s.loggedIn === false
      ? "Not logged in\n"
      : s.login === "api-key"
        ? "Logged in using an API key - sk-proj-***ABCD\n"
        : "Logged in using ChatGPT\n",
  );
  process.exit(s.loggedIn === false ? 1 : 0);
}
if (args[0] === "debug" && args[1] === "models") {
```

In `test/sim/codex.test.ts`, replace:

```ts
  it("answers --version, login status and debug models from the scenario", () => {
    const s = withScenario({ version: "0.157.0", loggedIn: false, models: { models: [{ slug: "m" }] } });
    expect(run(["--version"], s.env).out.trim()).toBe("codex-cli 0.157.0");
    expect(run(["login", "status"], s.env).code).toBe(1);
    expect(JSON.parse(run(["debug", "models"], s.env).out)).toEqual({ models: [{ slug: "m" }] });
  });
```

with:

```ts
  it("answers --version, login status and debug models from the scenario", () => {
    const s = withScenario({ version: "0.157.0", loggedIn: false, models: { models: [{ slug: "m" }] } });
    expect(run(["--version"], s.env).out.trim()).toBe("codex-cli 0.157.0");
    expect(run(["login", "status"], s.env)).toMatchObject({ code: 1, err: "Not logged in\n" });
    expect(run(["login", "status"], withScenario({ login: "api-key" }).env).err).toContain(
      "using an API key",
    );
    expect(JSON.parse(run(["debug", "models"], s.env).out)).toEqual({ models: [{ slug: "m" }] });
  });
```

In `test/sim/scenario.ts`, replace:

```ts
export interface CodexScenario {
  version?: string;
  loggedIn?: boolean;
  models?: unknown;
  eventsFile?: string;
  reply?: string;
```

with:

```ts
export interface CodexScenario {
  version?: string;
  loggedIn?: boolean;
  /** how `codex login status` says it is logged in (default ChatGPT) */
  login?: "chatgpt" | "api-key";
  models?: unknown;
  eventsFile?: string;
  reply?: string;
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/services/doctor.test.ts test/adapters/codex.test.ts test/sim/codex.test.ts`
Expected: FAIL — the backend row's detail has no login (`0.157.0 · 14 models`), the API-key login is `✓ ready`, the unreadable credentials file is `✓ ready`, the probe has no `login`, and the simulator prints its login state on stdout.

- [ ] **Step 3: Write the implementation**

In `src/adapters/backend.ts`, replace:

```ts
import type { ErrorCode } from "../domain/errors.ts";
import type { Rung } from "../domain/ids.ts";
import type { Access, ExitInfo, RunStatus, Tokens } from "../domain/record.ts";

export type { ExitInfo, ExitReason } from "../domain/record.ts";
```

with:

```ts
import type { ErrorCode } from "../domain/errors.ts";
import type { Rung } from "../domain/ids.ts";
import type { BillingMode } from "../domain/cost.ts";
import type { Access, ExitInfo, RunStatus, Tokens } from "../domain/record.ts";

export type { ExitInfo, ExitReason } from "../domain/record.ts";
```

In `src/adapters/backend.ts`, replace:

```ts
  versionOk: boolean;
  /** null when the CLI offers no way to ask */
  loggedIn: boolean | null;
  problems: { code: ErrorCode; message: string; fix: string }[];
}
```

with:

```ts
  versionOk: boolean;
  /** null when the CLI offers no way to ask */
  loggedIn: boolean | null;
  /** how the CLI is logged in, in a word or two ("ChatGPT", "API key"), when it says */
  login?: string;
  /** the billing mode that login implies, when it implies one: doctor compares it with the profiles' */
  billing?: BillingMode;
  problems: { code: ErrorCode; message: string; fix: string }[];
}
```

In `src/adapters/codex/index.ts`, replace:

```ts
    };
  const version = extractVersion(v.out);
  const versionOk = version !== null && compareVersions(version, CODEX_MIN_VERSION) >= 0;
  const loggedIn = (await sh(["login", "status"]))?.ok ?? false;
  const problems: Probe["problems"] = [];
  if (!versionOk)
    problems.push({
```

with:

```ts
    };
  const version = extractVersion(v.out);
  const versionOk = version !== null && compareVersions(version, CODEX_MIN_VERSION) >= 0;
  const status = await sh(["login", "status"]);
  const loggedIn = status?.ok ?? false;
  // how: `Logged in using ChatGPT`, or `… using an API key - <masked key>` (read, never kept); on stdout
  // or stderr, depending on the version
  const how = `${status?.out ?? ""}\n${status?.err ?? ""}`;
  const login = !loggedIn
    ? null
    : /using ChatGPT/i.test(how)
      ? "ChatGPT"
      : /API key/i.test(how)
        ? "API key"
        : null;
  const problems: Probe["problems"] = [];
  if (!versionOk)
    problems.push({
```

In `src/adapters/codex/index.ts`, replace:

```ts
    });
  if (!loggedIn)
    problems.push({ code: "E_BACKEND_NOT_LOGGED_IN", message: "codex is not logged in", fix: "codex login" });
  return { installed: true, version, versionOk, loggedIn, problems };
}

async function listModels(): Promise<DiscoveredModel[]> {
```

with:

```ts
    });
  if (!loggedIn)
    problems.push({ code: "E_BACKEND_NOT_LOGGED_IN", message: "codex is not logged in", fix: "codex login" });
  return {
    installed: true,
    version,
    versionOk,
    loggedIn,
    ...(login ? { login, billing: login === "ChatGPT" ? "chatgpt-plan" : "metered" } : {}),
    problems,
  };
}

async function listModels(): Promise<DiscoveredModel[]> {
```

In `src/services/doctor.ts`, replace:

```ts
import type { JevTransport } from "../infra/jev-client.ts";
import { claudeHome, locksDir } from "../infra/paths.ts";
import { refreshDiscovery } from "./catalog-service.ts";
import { credentialsPath, jevKey, testJevKey } from "./jev-service.ts";
import {
  activeName,
  agentLinkState,
```

with:

```ts
import type { JevTransport } from "../infra/jev-client.ts";
import { claudeHome, locksDir } from "../infra/paths.ts";
import { refreshDiscovery } from "./catalog-service.ts";
import { credentialsPath, jevKey, savedJevKey, testJevKey } from "./jev-service.ts";
import {
  activeName,
  agentLinkState,
```

In `src/services/doctor.ts`, replace:

```ts
  E_BACKEND_NOT_LOGGED_IN: "not logged in",
};

async function backendChecks(used: Map<string, "role" | "failover">): Promise<Check[]> {
  const checks: Check[] = [];
  const ready: string[] = [];
  for (const id of ADAPTER_IDS) {
```

with:

```ts
  E_BACKEND_NOT_LOGGED_IN: "not logged in",
};

async function backendChecks(used: Map<string, "role" | "failover">, profiles: Profile[]): Promise<Check[]> {
  const checks: Check[] = [];
  const ready: string[] = [];
  for (const id of ADAPTER_IDS) {
```

In `src/services/doctor.ts`, replace:

```ts
    const use = used.get(id);
    if (!problem) {
      ready.push(id);
      checks.push({
        id: `backend:${id}`,
        label: id,
        state: "ok",
        word: "ready",
        detail: probe.version ?? "",
      });
      continue;
    }
    checks.push({
```

with:

```ts
    const use = used.get(id);
    if (!problem) {
      ready.push(id);
      const detail = [probe.version, probe.login && `${probe.login} login`].filter(Boolean).join(" · ");
      // a login billed apart from what a profile says (a plan, or per token) ranks that backend's cost wrongly
      const billed = probe.billing && profiles.find((p) => p.billing[id] && p.billing[id] !== probe.billing);
      checks.push(
        billed
          ? {
              id: `backend:${id}`,
              label: id,
              state: "warn",
              word: "billing",
              detail: `${detail} · profile ${billed.name} bills ${id} as ${billed.billing[id]}, but this login is ${probe.billing}`,
              fix: `catherd profile set billing.${id} ${probe.billing} --profile ${billed.name}`,
            }
          : { id: `backend:${id}`, label: id, state: "ok", word: "ready", detail },
      );
      continue;
    }
    checks.push({
```

In `src/services/doctor.ts`, replace:

```ts
  }

  const used = usedBackends(profiles);
  checks.push(...(await backendChecks(used)));

  if (active?.jev.use === "off")
    checks.push({ id: "jev", label: "Jev", state: "skip", word: "off", detail: "off in the profile" });
```

with:

```ts
  }

  const used = usedBackends(profiles);
  checks.push(...(await backendChecks(used, profiles)));

  if (active?.jev.use === "off")
    checks.push({ id: "jev", label: "Jev", state: "skip", word: "off", detail: "off in the profile" });
```

In `src/services/doctor.ts`, replace:

```ts
  const creds = credentialsPath();
  if (existsSync(creds)) {
    const mode = statSync(creds).mode & 0o777;
    checks.push(
      mode & 0o077
        ? {
```

with:

```ts
  const creds = credentialsPath();
  if (existsSync(creds)) {
    const mode = statSync(creds).mode & 0o777;
    // Jev reads an unreadable file as no key (it is optional): here is where the user learns why
    const unreadable = savedJevKey().problem;
    checks.push(
      mode & 0o077
        ? {
```

In `src/services/doctor.ts`, replace:

```ts
            detail: `mode ${mode.toString(8)}`,
            fix: `chmod 600 ${creds}`,
          }
        : { id: "credentials", label: "credentials.json", state: "ok", word: "ready", detail: "mode 600" },
    );
  }
```

with:

```ts
            detail: `mode ${mode.toString(8)}`,
            fix: `chmod 600 ${creds}`,
          }
        : unreadable
          ? {
              id: "credentials",
              label: "credentials.json",
              state: "warn",
              word: "unreadable",
              detail: unreadable.message,
              fix: unreadable.fix ?? `fix or delete ${creds}, then catherd init`,
            }
          : { id: "credentials", label: "credentials.json", state: "ok", word: "ready", detail: "mode 600" },
    );
  }
```

`src/services/doctor.ts` is one of the files plan 5's final fix wave edits: find `backendChecks`, its call and the credentials block by their text.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/services/doctor.test.ts test/adapters test/sim test/entry/doctor-command.test.ts test/entry/init-command.test.ts`
Expected: PASS.

- [ ] **Step 5: Check and commit**

Run: `bun run format && bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: clean; the full suite passes.

```bash
git add src/adapters/backend.ts src/adapters/codex/index.ts src/services/doctor.ts test/sim test/services/doctor.test.ts test/adapters/codex.test.ts
git commit -m "feat(doctor): say how codex is logged in, warn on a billing mismatch and an unreadable key file"
```

---

### Task 9: The suite on macOS: real temp paths, a portable detach, zombie-aware checks, a stated skip

Spec §12's macOS leg (and plan 1's "macOS realpath" ruling). macOS's temp dir is behind a symlink (`/var` → `/private/var`), and git, `pwd` and a child's cwd report the real path, so every test that compares a path it made from `tmpdir()` with one a process reported fails there; `tempDir(prefix)` makes the directory and returns its real path, and `tempRepo()`, the simulator tests and the supervisor test use it. `setsid` is not on macOS: the preflight test that needs a process in its own session makes one with Bun. The supervisor test's `dead()` read `/proc` (and answered "dead" wherever there is none); `exited()` asks `ps`. The launch test that reads a process's environment from `/proc` skips, saying why, instead of returning early as a pass. catherd's own code needs no change: it compares repos by their git toplevel, which is already the real path.

**Files:**
- Modify: `test/helpers.ts`, `test/sim/claude.test.ts`, `test/sim/codex.test.ts`, `test/sim/opencode.test.ts`, `test/infra/supervisor.test.ts`, `test/infra/launch.test.ts`, `test/services/preflight.test.ts`

**Interfaces:**
- Consumes: Task 2 (`exited`).
- Produces: `tempDir(prefix: string): string` (`test/helpers.ts`).

- [ ] **Step 1: See the failures a symlinked temp dir causes**

```bash
mkdir -p /tmp/catherd-real && ln -sfn /tmp/catherd-real /tmp/catherd-link
TMPDIR=/tmp/catherd-link bun test 2>&1 | grep -E '^\(fail\)|^ *[0-9]+ (pass|fail)$'
```

Expected: about a dozen failures, all in tests that compare paths, among them `git > finds the toplevel from a subdirectory…`, `startRun > resolves the repo to its git toplevel…`, `supervise > feeds stdin from a file and sets the working directory`, the three simulator tests that record a cwd, `codex end to end on the simulator…`, `dispatch on claude-code (simulator)…`, `catherd runs > lists runs newest first…` and the MCP stdio test that makes a corrupt run folder.

- [ ] **Step 2: Make the tests portable**

In `test/helpers.ts`, replace:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

with:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

In `test/helpers.ts`, replace:

```ts
  return home;
}

/** A fresh git repo with one commit, for runner and snapshot tests. */
export function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "catherd-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
```

with:

```ts
  return home;
}

/**
 * A fresh temp dir, by its real path. macOS's temp dir is behind a symlink (/var → /private/var), and git,
 * `pwd` and a child's cwd all report the real path, so a test comparing paths must start from it.
 */
export const tempDir = (prefix: string): string => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

/** A fresh git repo with one commit, for runner and snapshot tests. */
export function tempRepo(): string {
  const dir = tempDir("catherd-repo-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
```

In `test/infra/launch.test.ts`, replace:

```ts
    expect(await Bun.file(dispatchPaths(dir).events).text()).toBe("done\n");
  });

  it("does not hand catherd's own secrets to the supervisor", async () => {
    if (!existsSync("/proc/self/environ")) return;
    process.env.TYPESAFE_API_KEY = "catherd-secret";
    process.env.CATHERD_LAUNCH_PROBE = "kept";
    const { dir, spec } = writeSpec("sleep 1");
    const pid = launchSupervisor(spec);
    const environ = await waitFor(() => {
      try {
        const e = readFileSync(`/proc/${pid}/environ`, "utf8");
        return e.includes("CATHERD_LAUNCH_PROBE=") ? e : null;
      } catch {
        return null;
      }
    });
    expect(environ).toContain("CATHERD_LAUNCH_PROBE=kept");
    expect(environ).not.toContain("TYPESAFE_API_KEY");
    await waitFor(() => readExit(dir));
  });

  it("runs a thin entry that never reaches the 0.x TUI or @opentui", () => {
    expect(relative(SRC, SUPERVISE_ENTRY)).toBe("entry/supervise-bin.ts");
```

with:

```ts
    expect(await Bun.file(dispatchPaths(dir).events).text()).toBe("done\n");
  });

  // reads the supervisor's environment from /proc, which macOS does not have
  it.skipIf(!existsSync("/proc/self/environ"))(
    "does not hand catherd's own secrets to the supervisor",
    async () => {
      process.env.TYPESAFE_API_KEY = "catherd-secret";
      process.env.CATHERD_LAUNCH_PROBE = "kept";
      const { dir, spec } = writeSpec("sleep 1");
      const pid = launchSupervisor(spec);
      const environ = await waitFor(() => {
        try {
          const e = readFileSync(`/proc/${pid}/environ`, "utf8");
          return e.includes("CATHERD_LAUNCH_PROBE=") ? e : null;
        } catch {
          return null;
        }
      });
      expect(environ).toContain("CATHERD_LAUNCH_PROBE=kept");
      expect(environ).not.toContain("TYPESAFE_API_KEY");
      await waitFor(() => readExit(dir));
    },
  );

  it("runs a thin entry that never reaches the 0.x TUI or @opentui", () => {
    expect(relative(SRC, SUPERVISE_ENTRY)).toBe("entry/supervise-bin.ts");
```

In `test/infra/supervisor.test.ts`, replace:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchPaths, readExit, requestCancel } from "../../src/infra/dispatch-dir.ts";
import { type SuperviseSpec, supervise } from "../../src/infra/supervisor.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { waitFor } from "../services/helpers.ts";

afterEach(snapshotEnv());
```

with:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dispatchPaths, readExit, requestCancel } from "../../src/infra/dispatch-dir.ts";
import { type SuperviseSpec, supervise } from "../../src/infra/supervisor.ts";
import { exited, snapshotEnv, tempDir, withHome } from "../helpers.ts";
import { waitFor } from "../services/helpers.ts";

afterEach(snapshotEnv());
```

In `test/infra/supervisor.test.ts`, replace:

```ts
beforeEach(() => void withHome());

function spec(script: string, over: Partial<SuperviseSpec> = {}): SuperviseSpec {
  const dir = mkdtempSync(join(tmpdir(), "catherd-sup-"));
  return {
    schema: 1,
    backend: "test",
```

with:

```ts
beforeEach(() => void withHome());

function spec(script: string, over: Partial<SuperviseSpec> = {}): SuperviseSpec {
  const dir = tempDir("catherd-sup-");
  return {
    schema: 1,
    backend: "test",
```

In `test/infra/supervisor.test.ts`, replace:

```ts
  });
});

/** Gone, or a zombie nobody has reaped yet (a container's pid 1 may never reap). */
function dead(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return true;
  }
}

describe("supervise always leaves exit.json and no live worker", () => {
  it("records a binary that cannot be spawned as lost, with the error in stderr", async () => {
    const s = { ...spec(""), cmd: "catherd-no-such-binary-4f2a", args: [] };
```

with:

```ts
  });
});

describe("supervise always leaves exit.json and no live worker", () => {
  it("records a binary that cannot be spawned as lost, with the error in stderr", async () => {
    const s = { ...spec(""), cmd: "catherd-no-such-binary-4f2a", args: [] };
```

In `test/infra/supervisor.test.ts`, replace:

```ts
    expect(exit.reason).toBe("cancelled");
    expect(member).toBeGreaterThan(0);
    expect(readFileSync(events, "utf8").trim()).toBe(String(member));
    await Bun.sleep(100);
    expect(dead(member)).toBe(true);
  });

  it("kills a group member left behind when the worker exits on its own", async () => {
```

with:

```ts
    expect(exit.reason).toBe("cancelled");
    expect(member).toBeGreaterThan(0);
    expect(readFileSync(events, "utf8").trim()).toBe(String(member));
    await waitFor(() => exited(member), 5_000);
  });

  it("kills a group member left behind when the worker exits on its own", async () => {
```

In `test/infra/supervisor.test.ts`, replace:

```ts
    expect(member).toBeGreaterThan(0);
    expect(exit).toMatchObject({ code: 0, signal: null, reason: "exited" });
    expect(readExit(s.dispatchDir)).toMatchObject({ code: 0, reason: "exited" });
    await Bun.sleep(100);
    expect(dead(member)).toBe(true);
  });
});
```

with:

```ts
    expect(member).toBeGreaterThan(0);
    expect(exit).toMatchObject({ code: 0, signal: null, reason: "exited" });
    expect(readExit(s.dispatchDir)).toMatchObject({ code: 0, reason: "exited" });
    await waitFor(() => exited(member), 5_000);
  });
});
```

In `test/services/preflight.test.ts`, replace:

```ts

  it("returns when the check exits although a process it detached still holds the pipes", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"], "setsid sleep 6 & echo started");
    const started = Date.now();
    const r = await preflight(fakeDeps({ view: testView({ heavy: 1 }) }), { run: run.id, timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(2_000);
```

with:

```ts

  it("returns when the check exits although a process it detached still holds the pipes", async () => {
    const { run } = freshRun();
    // a process in its own session (setsid is Linux-only; Bun detaches the same way everywhere)
    const detach = `'${process.execPath}' -e 'Bun.spawn(["sleep", "6"], { detached: true, stdio: ["ignore", "inherit", "inherit"] }).unref()'`;
    writeLane(run, "M1.L1", ["src/a.ts"], `${detach}; echo started`);
    const started = Date.now();
    const r = await preflight(fakeDeps({ view: testView({ heavy: 1 }) }), { run: run.id, timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(2_000);
```

In `test/sim/claude.test.ts`, replace:

```ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simPath } from "./scenario.ts";
import { withClaudeScenario } from "./sim-scenarios.ts";
```

with:

```ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempDir } from "../helpers.ts";
import { simPath } from "./scenario.ts";
import { withClaudeScenario } from "./sim-scenarios.ts";
```

In `test/sim/claude.test.ts`, replace:

```ts
  });

  it("replays the events under the session it was given, records stdin and touches files", () => {
    const repo = mkdtempSync(join(tmpdir(), "catherd-simrepo-"));
    const s = withClaudeScenario({
      eventsFile: join(FX, "ok.jsonl"),
      touch: [{ path: "src/a.ts", content: "x" }],
```

with:

```ts
  });

  it("replays the events under the session it was given, records stdin and touches files", () => {
    const repo = tempDir("catherd-simrepo-");
    const s = withClaudeScenario({
      eventsFile: join(FX, "ok.jsonl"),
      touch: [{ path: "src/a.ts", content: "x" }],
```

In `test/sim/codex.test.ts`, replace:

```ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simPath, withScenario } from "./scenario.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
```

with:

```ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempDir } from "../helpers.ts";
import { simPath, withScenario } from "./scenario.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
```

In `test/sim/codex.test.ts`, replace:

```ts
  });

  it("replays events on exec, writes -o, touches files and records what it saw", () => {
    const repo = mkdtempSync(join(tmpdir(), "catherd-simrepo-"));
    const reply = join(repo, "reply.md");
    const s = withScenario({
      eventsFile: join(FX, "two-turns.jsonl"),
```

with:

```ts
  });

  it("replays events on exec, writes -o, touches files and records what it saw", () => {
    const repo = tempDir("catherd-simrepo-");
    const reply = join(repo, "reply.md");
    const s = withScenario({
      eventsFile: join(FX, "two-turns.jsonl"),
```

In `test/sim/codex.test.ts`, replace:

```ts

describe("codex simulator scenarios", () => {
  it("applies a rung's overrides by model and effort, and reads a rewritten scenario", () => {
    const repo = mkdtempSync(join(tmpdir(), "catherd-simrepo-"));
    const reply = join(repo, "reply.md");
    const exec = (model: string, effort: string | null) => [
      "exec",
```

with:

```ts

describe("codex simulator scenarios", () => {
  it("applies a rung's overrides by model and effort, and reads a rewritten scenario", () => {
    const repo = tempDir("catherd-simrepo-");
    const reply = join(repo, "reply.md");
    const exec = (model: string, effort: string | null) => [
      "exec",
```

In `test/sim/opencode.test.ts`, replace:

```ts
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simPath } from "./scenario.ts";
import { type OpencodeModel, withOpencodeScenario } from "./sim-scenarios.ts";
```

with:

```ts
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempDir } from "../helpers.ts";
import { simPath } from "./scenario.ts";
import { type OpencodeModel, withOpencodeScenario } from "./sim-scenarios.ts";
```

In `test/sim/opencode.test.ts`, replace:

```ts
  });

  it("works in $PWD, not the spawn cwd, reads the brief on stdin and replays the events", () => {
    const repo = mkdtempSync(join(tmpdir(), "catherd-simrepo-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "catherd-elsewhere-"));
    const xdg = configWithAgent();
    const s = withOpencodeScenario({
      models: MODELS,
```

with:

```ts
  });

  it("works in $PWD, not the spawn cwd, reads the brief on stdin and replays the events", () => {
    const repo = tempDir("catherd-simrepo-");
    const elsewhere = tempDir("catherd-elsewhere-");
    const xdg = configWithAgent();
    const s = withOpencodeScenario({
      models: MODELS,
```

- [ ] **Step 3: Run the suite through the symlink, and as usual**

```bash
TMPDIR=/tmp/catherd-link bun test 2>&1 | grep -E '^\(fail\)|^ *[0-9]+ (pass|fail)$'
bun test test/services/preflight.test.ts test/infra/supervisor.test.ts test/infra/launch.test.ts test/sim
```

Expected: `0 fail` through the symlink; the named files pass (the `/proc` test runs on Linux and skips elsewhere).

- [ ] **Step 4: Check and commit**

Run: `bun run format && bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: clean; the full suite passes.

```bash
git add test/helpers.ts test/sim test/infra/supervisor.test.ts test/infra/launch.test.ts test/services/preflight.test.ts
git commit -m "test: pass on macos: real temp paths, a portable detach, zombie-aware checks, a stated skip"
```

---

### Task 10: CI: Linux and macOS on Bun 1.4.0 and latest, a coverage floor, an audit and an npm pack smoke; release gated on it

Spec §12 and Rulings 1, 2, 15, 16, 17. `ci.yml` has two jobs. **check** runs the matrix {`ubuntu-latest`, `macos-latest`} × {Bun `1.4.0`, `latest`} with `fail-fast: false`: tmux (for plan 6's PTY test, which skips without it), install from the lockfile, typecheck, lint, format, and every non-live test (the architecture test and `docs/tui-frames.md`'s freshness are among them); the Linux/latest leg runs `bun test --coverage` against `bunfig.toml`'s floor. **package** runs `bun audit --audit-level=high` and `test/pack-smoke.ts`. `release.yml` calls `ci.yml` and runs Changesets only after it. Dependabot keeps dependencies and actions current, OpenTUI aside.

**Files:**
- Replace: `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- Create: `.github/dependabot.yml`, `bunfig.toml`, `test/pack-smoke.ts`

**Interfaces:**
- Consumes: plan 6's `THIRD_PARTY_NOTICES.md` in `package.json`'s `files` (the smoke checks it ships); `mcpHandshake` through `catherd doctor --json`'s `mcp` row.
- Produces: the `check` and `package` jobs, callable as a workflow (`workflow_call`).

- [ ] **Step 1: Write the pack smoke**

`test/pack-smoke.ts` (new):

```ts
/**
 * Spec §12's npm pack smoke: packs catherd, installs the tarball into an empty project and runs what a user
 * runs first, `catherd --version` and `catherd doctor --json`, whose `mcp` row is the MCP initialize and
 * tools/list handshake against the installed server. Not a `bun test` file: CI's package job runs it with
 * `bun test/pack-smoke.ts`. It needs the npm registry, to install the package's dependencies.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { name: string; version: string };
const work = mkdtempSync(join(tmpdir(), "catherd-pack-"));

/** What the package needs at runtime: the CLI and the supervisor entry, the shipped catalog, the plugin. */
const SHIPPED = [
  "package.json",
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "src/cli.ts",
  "src/entry/supervise-bin.ts",
  "catalog/models.json",
  "catalog/scores.json",
  "catalog/jev.json",
  "plugin/.claude-plugin/plugin.json",
  "plugin/.mcp.json",
];

function run(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
}

function must(ok: boolean, what: string, detail = ""): void {
  if (!ok) {
    console.error(`pack smoke failed: ${what}${detail ? `\n${detail}` : ""}`);
    process.exit(1);
  }
  console.log(`ok  ${what}`);
}

// 1. the tarball holds what catherd needs at runtime, and none of the repository's own files
const packed = run([process.execPath, "pm", "pack", "--destination", work], ROOT);
must(packed.code === 0, "bun pm pack", packed.err);
const tgz = join(work, `${pkg.name}-${pkg.version}.tgz`);
const files = run(["tar", "-tzf", tgz], work).out.split("\n");
for (const f of SHIPPED) must(files.includes(`package/${f}`), `the tarball has ${f}`);
must(
  !files.some((f) => /^package\/(test|docs|scripts|\.github|\.changeset)\//.test(f)),
  "the tarball has no tests, docs, scripts or CI files",
);

// 2. it installs into an empty project
const app = join(work, "app");
mkdirSync(app);
writeFileSync(join(app, "package.json"), JSON.stringify({ name: "catherd-pack-smoke", private: true }));
const added = run([process.execPath, "add", tgz], app);
must(added.code === 0, "bun add <tarball>", added.err);

// 3. it runs in a fresh home, with no backend login and no Jev key needed
const bin = join(app, "node_modules", ".bin", "catherd");
const home = join(work, "home");
const env = {
  CATHERD_HOME: home,
  CLAUDE_CONFIG_DIR: join(home, "claude"),
  CATHERD_CLAUDE_AGENTS_DIR: join(home, "claude-agents"),
  TYPESAFE_API_KEY: "",
  ANTHROPIC_API_KEY: "",
};
const version = run([bin, "--version"], app, env);
must(
  version.out.trim() === pkg.version,
  `catherd --version prints ${pkg.version}`,
  version.out + version.err,
);
const doctor = run([bin, "doctor", "--json"], app, env);
must(doctor.code === 0 || doctor.code === 3, "catherd doctor --json exits 0 or 3 (not ready)", doctor.err);
const report = JSON.parse(doctor.out) as { version: string; checks: { id: string; state: string }[] };
must(report.version === pkg.version, "doctor reports the installed version");
const mcp = report.checks.find((c) => c.id === "mcp");
must(mcp?.state === "ok", "the installed MCP server answers initialize and tools/list", JSON.stringify(mcp));
```

- [ ] **Step 2: Run it**

Run: `bun test/pack-smoke.ts`
Expected: an `ok` line per check, ending with `ok  the installed MCP server answers initialize and tools/list`; exit 0. (It installs the package's dependencies from the npm registry.) If it stops at `the tarball has THIRD_PARTY_NOTICES.md`, plan 6's Task 13 is not in: that file must ship.

- [ ] **Step 3: Write the workflows, Dependabot and the coverage floor**

`.github/workflows/ci.yml` (replace the file):

```yaml
name: CI

# Pull requests run here; main runs this same workflow from release.yml, before anything is released.
on:
  pull_request:
  workflow_call:

permissions:
  contents: read

jobs:
  check:
    # spec §12: {ubuntu, macOS} × {Bun 1.4.0, latest}. 1.4.0 is the floor catherd's runtime guard allows;
    # latest catches a new Bun before users do. bun.lock pins everything else.
    name: ${{ matrix.os }} · Bun ${{ matrix.bun }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
        bun: ["1.4.0", latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v7
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${{ matrix.bun }}
      - name: tmux, for the TUI's terminal test (spec §11.6; it skips without tmux)
        run: |
          command -v tmux && exit 0
          if [ "$RUNNER_OS" = macOS ]; then brew install tmux; else sudo apt-get update && sudo apt-get install -y tmux; fi
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun run lint
      - run: bun run format:check
      # every non-live test: the architecture test and docs/tui-frames.md's freshness are among them
      - if: ${{ !(matrix.os == 'ubuntu-latest' && matrix.bun == 'latest') }}
        run: bun test
      - name: bun test, with the coverage floor in bunfig.toml
        if: ${{ matrix.os == 'ubuntu-latest' && matrix.bun == 'latest' }}
        run: bun test --coverage

  package:
    name: package · audit and npm pack smoke
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - name: dependency audit (spec §12)
        run: bun audit --audit-level=high
      - name: npm pack smoke (spec §12)
        run: bun test/pack-smoke.ts
```

`.github/workflows/release.yml` (replace the file):

```yaml
name: Release

on:
  push:
    branches: [main]

concurrency: ${{ github.workflow }}-${{ github.ref }}

permissions:
  contents: write
  pull-requests: write
  id-token: write

jobs:
  # spec §12: releases are gated on green CI, the whole matrix
  ci:
    uses: ./.github/workflows/ci.yml

  release:
    needs: ci
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - uses: actions/setup-node@v7
        with:
          node-version: lts/*
          registry-url: https://registry.npmjs.org
      # OIDC trusted publishing needs a recent npm; no NPM_TOKEN is used.
      - run: npm install -g npm@latest
      - run: bun install --frozen-lockfile
      # On main with changesets: opens or updates the "chore: release catherd" PR. On that PR's merge:
      # publishes to npm, pushes the v<version> tag (the plugin marketplace's release tag) and a GitHub release.
      - uses: changesets/action@v2
        with:
          version-script: bun run version-packages
          publish-script: bunx changeset publish
          pr-title: "chore: release catherd"
          commit-message: "chore: release catherd"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

`.github/dependabot.yml`:

```yaml
# spec §12: dependencies stay on latest through the lockfile and automated update PRs; OpenTUI is pinned
# exactly and moves only by hand, since an update means regenerating the TUI frames.
version: 2
updates:
  - package-ecosystem: bun
    directory: /
    schedule:
      interval: weekly
    ignore:
      - dependency-name: "@opentui/*"
    groups:
      dependencies:
        patterns: ["*"]
    commit-message:
      prefix: "chore(deps)"
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    commit-message:
      prefix: "ci(deps)"
```

`bunfig.toml`:

```toml
# spec §11 hygiene: CI runs `bun test --coverage` on one leg; below this floor it fails.
# Measured at 90.8 % of functions and 93.7 % of lines before plan 7; the floor leaves room for small drops.
[test]
coverageThreshold = { lines = 0.88, functions = 0.85 }
```

- [ ] **Step 4: Check the workflows and the floor**

```bash
bun -e 'for (const f of [".github/workflows/ci.yml", ".github/workflows/release.yml", ".github/dependabot.yml"]) Bun.YAML.parse(await Bun.file(f).text())'
command -v actionlint && actionlint .github/workflows/ci.yml .github/workflows/release.yml
bun test --coverage 2>&1 | grep -E '^All files|^ *[0-9]+ (pass|fail)$'
bun audit --audit-level=high
```

Expected: the three files parse; `actionlint`, where installed, prints nothing; the coverage run passes with `All files` at or above 85 % of functions and 88 % of lines (Ruling 16 says what to do after plan 6 if not); the audit reports no advisory at high or above.

- [ ] **Step 5: Check and commit**

Run: `bun run format && bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: clean; the full suite passes (`test/pack-smoke.ts` is not a test file and does not run here).

```bash
git add .github bunfig.toml test/pack-smoke.ts
git commit -m "ci: linux and macos on bun 1.4.0 and latest, coverage floor, audit, pack smoke; release after ci"
```

After the branch is pushed, the pull request shows the four `check` legs and `package`: all must be green before merge (the macOS legs need Task 9).

---

### Task 11: The live-verification kit: capture isolated and bounded, and the owner's exact commands

Spec §11.7–8, D7 and Ruling 18, with plan 3's capture minors: captures ran with the owner's own config, so a claude stream's `system/init` listed their hooks and MCP servers in fixtures meant for committing; a capture killed at its timeout was recorded `exited`, killed only the CLI's own process, and its meta file was sanitized after `JSON.stringify` (a secret with a quote or a backslash would not match its escaped form); `--out` defaulted to a path relative to wherever the command ran. `docs/live-verification.md` gives the owner the exact commands for the live tests, the capture, the Codex sandbox and the hidden Jev-key prompt on a real terminal; `docs/manual-tests.md`'s plugin check moves to 1.0.

**Files:**
- Modify: `src/services/capture.ts`, `src/entry/capture-fixtures.ts`, `docs/manual-tests.md`
- Create: `docs/live-verification.md`
- Test: `test/services/capture.test.ts`, `test/entry/capture-fixtures.test.ts`

**Interfaces:**
- Consumes: `killGroup`; `assetPath` (`src/infra/assets.ts`); `printError`, `exitCodeOf` (`src/entry/cli-kit.ts`); Task 8's `ChatGPT login` detail (named in the doc).
- Produces: `defaultOut(): string | null` (`src/entry/capture-fixtures.ts`); each capture's meta gains `isolated: true` and `reason`.

- [ ] **Step 1: Write the failing tests**

In `test/entry/capture-fixtures.test.ts`, replace:

```ts
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { captureFixturesCommand } from "../../src/entry/capture-fixtures.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

describe("catherd capture-fixtures", () => {
  it("refuses a backend it has no cases for, with the fix, and exit 2", () => {
    const p = Bun.spawnSync([process.execPath, CLI, "capture-fixtures", "--backend", "grok"], {
      stdout: "pipe",
      stderr: "pipe",
    });
```

with:

```ts
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { defaultOut } from "../../src/entry/capture-fixtures.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

describe("catherd capture-fixtures", () => {
  it("refuses a backend it has no cases for, with the fix, and exit 2", () => {
    const p = Bun.spawnSync([process.execPath, CLI, "capture-fixtures", "--backend", "grok"], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
```

In `test/entry/capture-fixtures.test.ts`, replace:

```ts
    );
  });

  it("writes under test/fixtures/adapters by default, where the contract fixtures live", () => {
    const args = captureFixturesCommand.args as Record<string, { default?: unknown }>;
    expect(args.out?.default).toBe("test/fixtures/adapters");
  });
});
```

with:

```ts
    );
  });

  it("writes under the checkout's test/fixtures/adapters by default, wherever it runs from", () => {
    expect(defaultOut()).toBe(join(import.meta.dir, "..", "fixtures", "adapters"));
  });
});
```

In `test/services/capture.test.ts`, replace:

```ts
    });
  });

  it("skips a backend that is not ready, saying why", async () => {
    withHome();
    process.env.PATH = simPath();
```

with:

```ts
    });
  });

  it("captures isolated, and stops a run past the timeout with everything it started", async () => {
    withHome();
    process.env.PATH = simPath();
    const recorded = join(mkdtempSync(join(tmpdir(), "catherd-rec-")), "claude.json");
    Object.assign(process.env, withClaudeScenario({ hangMs: 30_000, recordTo: recorded }).env);
    const out = mkdtempSync(join(tmpdir(), "catherd-fixtures-"));
    const t0 = Date.now();
    const results = await captureFixtures({ outDir: out, backends: ["claude-code"], timeoutMs: 500 });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(results.map((r) => r.status)).toEqual(["captured", "captured"]);
    const meta = JSON.parse(readFileSync(join(out, "claude-code", "2.1.282", "ok.json"), "utf8"));
    expect(meta).toMatchObject({ isolated: true, reason: "wall-timeout", exitCode: null });
    expect(JSON.parse(readFileSync(recorded, "utf8")).args).toContain("--safe-mode");
  });

  it("skips a backend that is not ready, saying why", async () => {
    withHome();
    process.env.PATH = simPath();
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/services/capture.test.ts test/entry/capture-fixtures.test.ts`
Expected: FAIL — `capture-fixtures.test.ts` cannot import `defaultOut`; the timed-out capture's meta has neither `isolated` nor `reason`, and claude ran without `--safe-mode`.

- [ ] **Step 3: Write the implementation**

In `src/entry/capture-fixtures.ts`, replace:

```ts
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { CAPTURE_BACKENDS, type Captured, captureFixtures } from "../services/capture.ts";

export function formatCaptured(r: Captured): string {
  return r.status === "captured"
```

with:

```ts
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { CatherdError } from "../domain/errors.ts";
import { assetPath } from "../infra/assets.ts";
import { CAPTURE_BACKENDS, type Captured, captureFixtures } from "../services/capture.ts";
import { exitCodeOf, printError } from "./cli-kit.ts";

/**
 * Spec §11.8: fixtures go to the catherd checkout's test/fixtures/adapters, next to the contract fixtures
 * they feed, wherever the command runs; null for an installed package, which has no tests to feed.
 */
export function defaultOut(): string | null {
  const dir = assetPath("test/fixtures/adapters");
  return existsSync(dir) ? dir : null;
}

export function formatCaptured(r: Captured): string {
  return r.status === "captured"
```

In `src/entry/capture-fixtures.ts`, replace:

```ts
  },
  args: {
    backend: { type: "string", description: `only this backend (${CAPTURE_BACKENDS.join(", ")})` },
    out: { type: "string", description: "fixture root", default: "test/fixtures/adapters" },
  },
  async run({ args }) {
    if (args.backend && !CAPTURE_BACKENDS.includes(args.backend)) {
      console.error(`error E_INPUT_INVALID: no capture cases for backend "${args.backend}"`);
      console.error(`fix: pass --backend ${CAPTURE_BACKENDS.join("|")}`);
```

with:

```ts
  },
  args: {
    backend: { type: "string", description: `only this backend (${CAPTURE_BACKENDS.join(", ")})` },
    out: { type: "string", description: "fixture root (default: this checkout's test/fixtures/adapters)" },
  },
  async run({ args }) {
    const out = args.out ? resolve(args.out) : defaultOut();
    if (!out) {
      const e = new CatherdError("E_INPUT_INVALID", "no --out, and this catherd is not a source checkout", {
        fix: "catherd capture-fixtures --out <dir>",
      });
      printError(e);
      process.exitCode = exitCodeOf(e);
      return;
    }
    if (args.backend && !CAPTURE_BACKENDS.includes(args.backend)) {
      console.error(`error E_INPUT_INVALID: no capture cases for backend "${args.backend}"`);
      console.error(`fix: pass --backend ${CAPTURE_BACKENDS.join("|")}`);
```

In `src/entry/capture-fixtures.ts`, replace:

```ts
      return;
    }
    const results = await captureFixtures({
      outDir: resolve(args.out),
      backends: args.backend ? [args.backend] : undefined,
    });
    for (const r of results) console.log(formatCaptured(r));
```

with:

```ts
      return;
    }
    const results = await captureFixtures({
      outDir: out,
      backends: args.backend ? [args.backend] : undefined,
    });
    for (const r of results) console.log(formatCaptured(r));
```

In `src/services/capture.ts`, replace:

```ts
import { sanitize, type Scrub, secretValues } from "../domain/sanitize.ts";
import { workerEnv } from "../infra/env.ts";
import { git } from "../infra/git.ts";
import { writeJsonAtomic } from "../infra/store.ts";
import { readyAdapter } from "./backends.ts";
import { settled } from "./finalize.ts";
```

with:

```ts
import { sanitize, type Scrub, secretValues } from "../domain/sanitize.ts";
import { workerEnv } from "../infra/env.ts";
import { git } from "../infra/git.ts";
import { killGroup } from "../infra/proc.ts";
import { writeJsonAtomic } from "../infra/store.ts";
import { readyAdapter } from "./backends.ts";
import { settled } from "./finalize.ts";
```

In `src/services/capture.ts`, replace:

```ts
  return { work, repo };
}

/** Runs one case the way a dispatch would (prepare, plan, the worker env), without the supervisor. */
async function captureOne(
  adapter: BackendAdapter,
  version: string,
```

with:

```ts
  return { work, repo };
}

/** Every string in `v`, cleaned: meta values are sanitized before JSON escapes them, not after. */
function cleanStrings(v: unknown, clean: (s: string) => string): unknown {
  if (typeof v === "string") return clean(v);
  if (Array.isArray(v)) return v.map((x) => cleanStrings(x, clean));
  if (v && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanStrings(x, clean)]));
  return v;
}

/**
 * Runs one case the way an isolated dispatch would (prepare, plan, the worker env), without the
 * supervisor. Isolated, so the stream names none of the owner's own hooks, plugins, MCP servers or config:
 * the fixtures are committed.
 */
async function captureOne(
  adapter: BackendAdapter,
  version: string,
```

In `src/services/capture.ts`, replace:

```ts
    const briefPath = join(work, "brief.md");
    writeFileSync(briefPath, c.brief);
    const rung = parseRung(c.rung);
    await adapter.prepare?.({ rung, access: c.access, isolated: false, repo });
    const request = {
      rung,
      access: c.access,
      thread: null,
      isolated: false,
      repo,
      briefPath,
      replyPath: join(work, "reply.md"),
```

with:

```ts
    const briefPath = join(work, "brief.md");
    writeFileSync(briefPath, c.brief);
    const rung = parseRung(c.rung);
    await adapter.prepare?.({ rung, access: c.access, isolated: true, repo });
    const request = {
      rung,
      access: c.access,
      thread: null,
      isolated: true,
      repo,
      briefPath,
      replyPath: join(work, "reply.md"),
```

In `src/services/capture.ts`, replace:

```ts
      stdin: Bun.file(briefPath),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    const [events, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
```

with:

```ts
      stdin: Bun.file(briefPath),
      stdout: "pipe",
      stderr: "pipe",
      // its own group, so a timeout stops whatever the CLI started too, as the supervisor does
      detached: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(p.pid, "SIGKILL");
    }, timeoutMs);
    const [events, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
```

In `src/services/capture.ts`, replace:

```ts
      exit: {
        code: p.signalCode ? null : code,
        signal: p.signalCode ?? null,
        reason: "exited",
        endedAt: new Date().toISOString(),
      },
      startedAtMs,
```

with:

```ts
      exit: {
        code: p.signalCode ? null : code,
        signal: p.signalCode ?? null,
        reason: timedOut ? "wall-timeout" : "exited",
        endedAt: new Date().toISOString(),
      },
      startedAtMs,
```

In `src/services/capture.ts`, replace:

```ts
    writeFileSync(join(dir, `${c.name}.stderr`), clean(stderr));
    writeJsonAtomic(
      join(dir, `${c.name}.json`),
      JSON.parse(
        clean(
          JSON.stringify({
            schema: 1,
            backend: c.backend,
            cliVersion: version,
            case: c.name,
            rung: c.rung,
            access: c.access,
            brief: c.brief,
            exitCode: run.exit.code,
            capturedAt: new Date().toISOString(),
            outcome: {
              status: o.status,
              thread: o.thread,
              tokens: o.tokens,
              costUsd: o.costUsd,
              error: o.error,
            },
          }),
        ),
      ),
    );
    return {
```

with:

```ts
    writeFileSync(join(dir, `${c.name}.stderr`), clean(stderr));
    writeJsonAtomic(
      join(dir, `${c.name}.json`),
      cleanStrings(
        {
          schema: 1,
          backend: c.backend,
          cliVersion: version,
          case: c.name,
          rung: c.rung,
          access: c.access,
          isolated: true,
          brief: c.brief,
          exitCode: run.exit.code,
          reason: run.exit.reason,
          capturedAt: new Date().toISOString(),
          outcome: {
            status: o.status,
            thread: o.thread,
            tokens: o.tokens,
            costUsd: o.costUsd,
            error: o.error,
          },
        },
        clean,
      ),
    );
    return {
```

- [ ] **Step 4: Write the docs**

`docs/live-verification.md` (new):

````markdown
# Live verification

What CI cannot check, because it needs real accounts: the backends' real streams, the Codex sandbox, and
the Jev key prompt on a real terminal (spec D7, §11.7, §11.8). Run it on your own machine before a
release, and again after a backend CLI's minor release. Every step says what to look for; write down
anything that differs and file it with the step's name.

You need: Bun ≥ 1.4, a catherd checkout (`git clone https://github.com/47vigen/catherd && cd catherd &&
bun install`), and the three backends logged in: Codex with your ChatGPT account (`codex login`), Claude
Code with your Claude plan (`claude` once, then `/login`), and opencode v2 (`opencode auth login` for
OpenCode Go; the free Zen model needs no login). Run every command from the checkout. The live tests and
the capture spend a few cents at most: they run Luna at low effort, Haiku, and opencode's free model.

## 1. Readiness

```sh
bun src/cli.ts doctor
```

Look for: `✓ ready` on the `codex`, `claude-code` and `opencode` rows, each with its version and model
count; the `codex` row says `ChatGPT login`. `API key login` there means Codex bills you per token: run
`codex login` and choose ChatGPT, or tell catherd with `catherd profile set billing.codex metered`.

## 2. The live tests

```sh
CATHERD_LIVE=1 bun test test/live/codex.live.test.ts
CATHERD_LIVE=1 bun test test/live/claude-code.live.test.ts
CATHERD_LIVE=1 bun test test/live/opencode.live.test.ts
CATHERD_LIVE=1 TYPESAFE_API_KEY=<your TypeSafe key> bun test test/live/jev.live.test.ts
```

Each file runs in its own temporary `CATHERD_HOME` and a scratch git repository; your config is not
touched. Without `CATHERD_LIVE=1` every live test is skipped (the jev file also needs the key).

Look for: every test passing. In particular: Codex answers and resumes the same thread, and its image tool
returns an image; claude-code reports tokens and a cost, resumes its session, and a read-only role does not
create `out.txt`; opencode runs a brief that starts with `---`, refuses a variant the model lacks, keeps
its read-only agent from writing, and cancels a running session; Jev routes the sample lane to Track A and refuses a fake key.

## 3. Fixture capture

```sh
bun src/cli.ts capture-fixtures
```

It records one cheap run per ready backend (and, for claude-code and opencode, a read-only role trying to
write) into `test/fixtures/adapters/<backend>/<cli-version>/`, with secrets, e-mail addresses and home paths
stripped. Every run is isolated (Codex in a catherd-owned `CODEX_HOME`, Claude with `--safe-mode`, opencode
on a standalone server), so no hook, plugin, MCP server or setting of yours appears in the stream.
`--backend codex` (or `claude-code`, `opencode`) records one backend; `--out <dir>` writes elsewhere.

Look for: a `✓` line per case with `(exit 0)`; then check that nothing personal remains:

```sh
git status --short test/fixtures/adapters
grep -rn -e "$HOME" -e "$(whoami)" test/fixtures/adapters/*/*/ || echo clean
```

Look at every line the `grep` prints (a user name that is also a common word may match harmlessly);
`clean` means there is nothing to look at. Each case's `.json` file holds the settled outcome: `status` is
`ok` in both cases, and in `read-only-write` the reply in the stream says why it could not write. Then run the contract suites against the curated fixtures, and
commit the captured folder:

```sh
bun test test/adapters
git add test/fixtures/adapters && git commit -m "test(fixtures): capture <cli versions> streams"
```

If a stream's shape changed (a new event type, a renamed field, a token count in a new place), the
curated fixture beside it (`test/fixtures/adapters/<backend>/*.jsonl`) no longer shows what the CLI does:
file it against that backend's adapter with both files attached.

## 4. The Codex sandbox and the heavy-lock directory

`catherd doctor` checks that a Codex worker in its `workspace-write` sandbox can write catherd's heavy-lock
directory, so `catherd lock` works inside it (spec §10.3). The check has only run against the simulator.
First see that your Codex has the command, then run the two probes doctor runs (use `linux` in place of
`macos` on Linux):

```sh
codex sandbox --help
cd "$(mktemp -d)"
codex sandbox macos --full-auto -- sh -c true; echo "control: $?"
mkdir -p ~/.local/share/catherd/locks
codex sandbox macos --full-auto -- sh -c 'touch "$1" && rm -f "$1"' _ ~/.local/share/catherd/locks/.probe; echo "lock dir: $?"
cd -
bun src/cli.ts doctor
```

(With `XDG_DATA_HOME` set, the lock directory is `$XDG_DATA_HOME/catherd/locks`.)

Look for: `codex sandbox --help` listing `macos` and `linux` (or `seatbelt` and `landlock`: then say so, the
command changed); `control: 0`. Then either `lock dir: 0` and doctor's `sandbox:codex` row `✓ ready`, or
`lock dir: 1` with `Operation not permitted` and doctor's row `! not writable` with a fix naming
`writable_roots` in `~/.codex/config.toml`. Apply that fix, run the probe again, and look for
`lock dir: 0`. Record which of the two you saw: if Codex refuses the lock directory by default, a later
release should add it to `writable_roots` for workspace-write runs itself (plan 5's follow-up).

## 5. The Jev key prompt on a real terminal

In a new terminal window (a real TTY, not an editor's output pane), with a throwaway home so your own
setup is untouched:

```sh
export CATHERD_HOME="$(mktemp -d)" CATHERD_CLAUDE_AGENTS_DIR="$(mktemp -d)"
unset TYPESAFE_API_KEY
bun src/cli.ts init
```

Look for, one at a time:

1. The prompt `TypeSafe API key for Jev (optional; Enter skips): `.
2. Typing shows one `*` per character and never the character itself; Backspace removes one `*`.
3. Pasting the key (from your password manager) shows stars only.
4. Enter prints `✓ Jev: the key answers; saved with mode 600`, then the profile, the model listing, the
   readiness report and the plugin steps; the command exits 0 (`echo $?`).
5. `stat -f %Lp "$CATHERD_HOME/config/credentials.json"` (macOS) or
   `stat -c %a "$CATHERD_HOME/config/credentials.json"` (Linux) prints `600`.
6. `bun src/cli.ts init` again prints `✓ Jev: using the saved key` and asks nothing about the key.
7. `rm "$CATHERD_HOME/config/credentials.json"; bun src/cli.ts init`, then Ctrl-C at the key prompt: the
   command exits 130 (`echo $?`), and what you type next echoes normally (the terminal is not left in raw
   mode).
8. `printf '\n' | bun src/cli.ts init` skips the key (`- Jev: no key; …`) and finishes without waiting.

Clean up with `rm -rf "$CATHERD_HOME" "$CATHERD_CLAUDE_AGENTS_DIR"; unset CATHERD_HOME CATHERD_CLAUDE_AGENTS_DIR`.

## 6. One orchestrated run

The last check drives the plugin in Claude Code on a sample repository: "the plugin in a fresh Claude
Code session" in [`docs/manual-tests.md`](manual-tests.md).
````

In `docs/manual-tests.md`, replace:

```markdown
# Manual tests

Three checks that need a human at Claude Desktop, because MCP servers and plugins only
load at session start; no automated test can show that. Run them before the first
publish, and again after any Claude Code release that might change MCP call
backgrounding, subagent loading or plugin discovery (see the design spec's Risks
section).

Do these in order: S1 and S2 gate `dispatch` and the Claude agent files that the plugin
smoke test (Task 13) then exercises end to end.

## S1 — a 40-minute MCP call survives from the main thread
```

with:

```markdown
# Manual tests

Three checks that need a human at Claude Desktop, because MCP servers and plugins only
load at session start; no automated test can show that. Run them before each major
release, and again after any Claude Code release that might change MCP call
backgrounding, subagent loading or plugin discovery (see the design spec's Risks
section). The checks that need real backend accounts (live tests, fixture capture, the
Codex sandbox, the Jev key prompt) are in [`live-verification.md`](live-verification.md).

Do these in order: S1 and S2 gate `dispatch` and the Claude agent files that the plugin
check (the last section) then exercises end to end. S1 and S2 were written for 0.x and
still hold for 1.0: they test Claude Code, not catherd.

## S1 — a 40-minute MCP call survives from the main thread
```

In `docs/manual-tests.md`, replace:

```markdown
observable) — it only tells you whether a Claude Code release picked up new files
mid-session, in which case the setup skill's "new session" language can be dropped.

## Task 13 — the plugin in a fresh Claude Desktop session

**What this checks:** that Claude Code actually loads this plugin, starts the MCP
server, registers the generated Claude agents, and that both skills run through the
```

with:

```markdown
observable) — it only tells you whether a Claude Code release picked up new files
mid-session, in which case the setup skill's "new session" language can be dropped.

## The plugin in a fresh Claude Desktop session

**What this checks:** that Claude Code actually loads this plugin, starts the MCP
server, registers the generated Claude agents, and that both skills run through the
```

In `docs/manual-tests.md`, replace:

````markdown
   claude plugin install catherd@catherd
   ```

   Then make sure the real profile's agent files exist, so Claude Code can see them at
   session start:

   ```bash
   bun -e 'import { saveProfileAndAgents } from "./src/profile/agents.ts"; import { loadProfile } from "./src/profile/profile.ts"; import { loadCatalog } from "./src/routing/catalog.ts"; console.log(saveProfileAndAgents(loadProfile(), loadCatalog()));'
   ls -l ~/.claude/agents/catherd-*
   ```

   Look for: the architect and verifier links in that listing.

3. Start a **new** session in the Code tab, in a small throwaway git repository, and
   check, one at a time:
````

with:

````markdown
   claude plugin install catherd@catherd
   ```

   Then make sure a 1.0 profile and its agent files exist, so Claude Code can see them
   at session start (`init` keeps a 1.0 profile you already have, and moves 0.x files
   aside):

   ```bash
   bun src/cli.ts init --no-input
   ls -l ~/.claude/agents/catherd-*
   ```

   Look for: `catherd-default-architect-claude-opus-5-5-high.md` and
   `catherd-default-verifier-claude-opus-5-5-low.md` in that listing (with another
   active profile, its name in place of `default`).

3. Start a **new** session in the Code tab, in a small throwaway git repository, and
   check, one at a time:
````

In `docs/manual-tests.md`, replace:

```markdown
      `plugin/skills/catherd/`, or lists one of them twice, that is a defect against
      the design (skills are already slash-invocable on their own) — record it before
      deciding whether to drop `plugin/commands/`.
   2. Ask: "List the catherd MCP tools you have." Look for: all eighteen tool names
      (`run_start, write_run_file, read_run_file, status, result, set_next, route,
      climb, ask, land, read_knowledge, dispatch, catalog_query, profile_get,
      profile_validate, profile_set, runs_summary, preflight`).
   3. Ask: "Call the catherd status tool." Look for: `catherd: no runs yet`, or the
      runs already on this machine.
   4. Ask: "Which catherd agents can you run?" Look for: both
      `catherd-architect-claude-opus-5-5-high` and
      `catherd-verifier-claude-opus-5-5-low` in the list.
   5. Run `/catherd-setup`. Look for: one question at a time, each with a recommended
      answer; stop it after two answers.
   6. In a repo with a one-file hello script and a test, run `/catherd Add a --shout
```

with:

```markdown
      `plugin/skills/catherd/`, or lists one of them twice, that is a defect against
      the design (skills are already slash-invocable on their own) — record it before
      deciding whether to drop `plugin/commands/`.
   2. Ask: "List the catherd MCP tools you have." Look for: all twenty tool names
      (`run_start, write_run_file, read_run_file, status, result, set_next,
      record_agent_run, read_knowledge, runs_summary, route, climb, ask, land,
      preflight, dispatch, cancel, catalog_query, profile_get, profile_validate,
      profile_set`).
   3. Ask: "Call the catherd status tool." Look for: its `version` equal to your
      checkout's `package.json` version, and `runs` empty on a fresh machine (or the
      runs already on it).
   4. Ask: "Which catherd agents can you run?" Look for: both
      `catherd-default-architect-claude-opus-5-5-high` and
      `catherd-default-verifier-claude-opus-5-5-low` in the list.
   5. Run `/catherd-setup`. Look for: one question at a time, each with a recommended
      answer; stop it after two answers.
   6. In a repo with a one-file hello script and a test, run `/catherd Add a --shout
```

Every command in `docs/live-verification.md` was checked against the code: the four live test files and their `CATHERD_LIVE` / `TYPESAFE_API_KEY` gates (Codex's is plan 6's 1.0 rewrite), `capture-fixtures`' flags and layout, doctor's `sandbox:codex` probe (`sh -c 'touch "$1" && rm -f "$1"'` from a scratch folder, after a `sh -c true` control), `CATHERD_HOME`'s `config/` layout and `init`'s exact lines. `codex sandbox --help` is the one command nobody here has run: the doc says what to report if it differs.

- [ ] **Step 5: Run the tests, check and commit**

Run: `bun test test/services/capture.test.ts test/entry/capture-fixtures.test.ts && bun run format && bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: PASS; clean; the full suite passes.

```bash
git add src/services/capture.ts src/entry/capture-fixtures.ts test/services/capture.test.ts test/entry/capture-fixtures.test.ts docs/live-verification.md docs/manual-tests.md
git commit -m "feat(capture): isolated runs, a timeout kills the group; docs: the live verification kit"
```

---

### Task 12: Release 1.0: the changeset, `MIGRATION.md` and the README's upgrade notes

Spec §12 ("Releases through Changesets", "`MIGRATION.md` for 0.2 → 1.0") and D2. One changeset takes `catherd-cli` from 0.2.1 to 1.0.0 (major) with the CHANGELOG entry; `MIGRATION.md` says exactly what `catherd init` does to a 0.x install and what it leaves alone; the README gets a short "Upgrading from 0.x" section and points developers at the live-verification kit. One test pins what `MIGRATION.md` promises about agent links, the user's own files and the Jev key. Merging this to `main` makes the Release workflow open the "chore: release catherd" PR; merging that PR publishes 1.0.0 (an irreversible step the owner takes).

**Files:**
- Create: `.changeset/catherd-1-0.md`, `MIGRATION.md`
- Modify: `README.md`
- Test: `test/services/setup.test.ts`

**Interfaces:**
- Consumes: `initSetup` (`src/services/setup.ts`), `agentsRoot`, `claudeAgentsDir`, `credentialsPath`, `jevKey`.
- Produces: nothing new in code.

- [ ] **Step 1: Pin the migration's promises**

In `test/services/setup.test.ts`, replace:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeDiscovery } from "../../src/adapters/discovery.ts";
import {
  configFile,
  getProfile,
  patchProfile,
```

with:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { writeDiscovery } from "../../src/adapters/discovery.ts";
import { claudeAgentsDir } from "../../src/infra/paths.ts";
import { credentialsPath, jevKey } from "../../src/services/jev-service.ts";
import {
  agentsRoot,
  configFile,
  getProfile,
  patchProfile,
```

In `test/services/setup.test.ts`, replace:

```ts
    expect(r.refreshed.map((x) => x.backend)).toContain("codex");
  });

  it("writes and activates nothing when the defaults do not validate here, and says why", async () => {
    withHome();
    process.env.PATH = "/nonexistent";
```

with:

```ts
    expect(r.refreshed.map((x) => x.backend)).toContain("codex");
  });

  it("replaces the 0.x agent links with 1.0 ones, never a file of the user's, and keeps the Jev key", async () => {
    withHome();
    process.env.PATH = "/nonexistent";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    legacyFiles();
    // 0.x linked catherd-<role>-<model>-<effort> into the agents dir, from catherd's own config folder
    const old = join(agentsRoot(), "fast", "catherd-architect-claude-opus-5-5-high.md");
    mkdirSync(dirname(old), { recursive: true });
    writeFileSync(old, "a 0.x agent");
    mkdirSync(claudeAgentsDir(), { recursive: true });
    symlinkSync(old, join(claudeAgentsDir(), "catherd-architect-claude-opus-5-5-high.md"));
    writeFileSync(join(claudeAgentsDir(), "mine.md"), "the user's own agent");
    writeFileSync(credentialsPath(), JSON.stringify({ typesafeApiKey: "tsk-0x-key" }));
    await initSetup();
    expect(readdirSync(claudeAgentsDir()).sort()).toEqual([
      "catherd-default-architect-claude-opus-5-5-high.md",
      "catherd-default-verifier-claude-opus-5-5-low.md",
      "mine.md",
    ]);
    expect(jevKey()).toBe("tsk-0x-key");
  });

  it("writes and activates nothing when the defaults do not validate here, and says why", async () => {
    withHome();
    process.env.PATH = "/nonexistent";
```

Run: `bun test test/services/setup.test.ts`
Expected: PASS already: 1.0's relink prunes 0.x links (they point into catherd's own `agents/` folder), never a file it does not own, and `moveLegacy` leaves `credentials.json` where it is. The test keeps `MIGRATION.md` honest.

- [ ] **Step 2: Write the changeset, the migration notes and the README section**

`.changeset/catherd-1-0.md` (new):

```markdown
---
"catherd-cli": major
---

catherd 1.0: a rewrite, and a clean break from 0.x. Run `bunx catherd-cli init` once after upgrading; it moves your 0.x files aside and sets 1.0 up (see MIGRATION.md).

- **Runs that survive.** Every worker runs detached under a supervisor with idle and wall timeouts, writes straight to disk and is recorded exactly once, even when the MCP server restarts mid-run. Admission is atomic, parallel lanes are checked for overlapping files, and a write outside a lane is reported.
- **Three backends behind one adapter:** Codex, headless Claude Code (`claude-code:` rungs, beside native Claude subagents) and opencode v2 (OpenCode Go and Zen). Each has a probe with a minimum version, optional isolation, and per-role access (`read-only`, `workspace-write`, `full`) with how strongly the backend enforces it.
- **A discovery catalog.** catherd lists what each backend offers, scores models from dated sources, ranks cost by how you pay (plan, subscription or per token), and lets you map an unscored model with `treat-like`. Jev is optional: without a key, each lane's own Kind and Difficulty route it.
- **Profiles, schema 1:** per-role ladders, access, failover to a rung on another quota, a budget and timeouts, kept through `catherd profile`, the TUI or `/catherd-setup`; native Claude roles get linked agent files.
- **A full CLI:** `init`, `doctor` (one row per check, each with its fix), `profile`, `status`, `watch`, `runs`, `catalog`, `lock` and `capture-fixtures`, with stable exit codes, one-line errors and a log with secrets redacted.
- **A new TUI** after opencode's: Status, Profiles and Runs tabs, a command palette, and edits that are saved only through a diff.
- **20 MCP tools**, two of them new (`cancel`, `record_agent_run`); every failure is `{ code, message, fix }`.
- Needs Bun 1.4 or newer.
```

`MIGRATION.md` (new):

````markdown
# Upgrading from catherd 0.x to 1.0

1.0 is a clean break: it reads none of 0.x's files and converts nothing. One command sets it up:

```sh
bunx catherd-cli init
```

## What `init` does to a 0.x install

- **Moves your 0.x settings aside.** `config.json`, `projects.json` and every profile in `profiles/` that
  0.x wrote (the ones without a `"schema"` field) go from your config folder (`~/.config/catherd/`,
  `$XDG_CONFIG_HOME/catherd/` or `$CATHERD_HOME/config/`) into `0.x-backup-<date and time>/` inside it.
  Nothing is deleted, and 1.0 never reads that folder again.
- **Writes the 1.0 default profile** and makes it active. Your 0.x choices are not carried over: set them
  again with `catherd profile set`, the TUI (`catherd`) or `/catherd-setup` in Claude Code, with the backup to
  compare against. A 0.x rung like `gpt-6-sol#high` is `codex:gpt-6-sol#high` in 1.0: every rung names its
  backend.
- **Replaces the Claude agents.** 0.x linked `catherd-<role>-<model>-<effort>` into `~/.claude/agents`; 1.0
  links `catherd-<profile>-<role>-<model>-<effort>` and removes the 0.x links. Only catherd's own links are
  touched, never a file of yours. Start a new Claude Code session afterwards: it reads agents only at start.
- **Keeps your Jev key.** `credentials.json` stays where it is, and 1.0 reads it. 0.x also read the key
  from TypeSafe's own file (`~/.config/typesafe/api_key`); 1.0 reads only `TYPESAFE_API_KEY` and
  `credentials.json`, so if your key lived only in that file, `init` asks for it once: paste it there.
- Lists your backends' models and ends with `catherd doctor`'s readiness report and the plugin commands.

`init --no-input` does the same without asking anything.

## What it leaves alone

0.x run folders: 1.0 keeps its runs in `~/.local/share/catherd/repos/` and does not read the old ones. In
`~/.local/share/catherd/` (or `$XDG_DATA_HOME/catherd/`), every folder except `repos`, `logs`, `locks` and
`discovery` is 0.x run data; delete it when you no longer need it.

## Then

1. Update the Claude Code plugin, and start a new session:

   ```sh
   claude plugin marketplace update catherd && claude plugin update catherd@catherd
   ```

2. opencode must be v2 (2.0.16 or newer); 0.x's install hint installed v1:
   `curl -fsSL https://opencode.ai/v2/install | bash`.
3. Check everything with `bunx catherd-cli doctor`: it exits 0 when catherd is ready, and prints the fix
   for every row that is not.

## What else changed

- Bun 1.4 or newer; catherd refuses to start on an older one and says how to upgrade.
- `catherd watch` and the dashboard show 1.0 runs only.
- The MCP server has 20 tools (0.x had 18), and every error is `{ code, message, fix }`; the plugin's skills
  are updated to match, so update the plugin with catherd.
- Exit codes: `0` ok, `1` error, `2` usage, `3` not ready (`doctor`), `130` interrupted.
````

In `README.md`, replace:

````markdown
Run data lives in `~/.local/share/catherd/`, config in `~/.config/catherd/` (both follow
`XDG_*`).

## Develop

```sh
````

with:

````markdown
Run data lives in `~/.local/share/catherd/`, config in `~/.config/catherd/` (both follow
`XDG_*`).

## Upgrading from 0.x

1.0 is a clean break: run `bunx catherd-cli init` once. It moves your 0.x `config.json`, `projects.json` and
profiles into a `0.x-backup-<time>/` folder next to them (it never reads or deletes them), writes the 1.0
default profile, replaces the 0.x Claude agent links with 1.0 ones and keeps your saved Jev key; 0.x run
folders stay where they are, unread. Then update the plugin
(`claude plugin marketplace update catherd && claude plugin update catherd@catherd`) and start a new Claude
Code session. The details are in [MIGRATION.md](MIGRATION.md).

## Develop

```sh
````

In `README.md`, replace:

````markdown
bun run typecheck && bun run lint && bun run format:check
```

Design: [`docs/superpowers/specs/2026-09-25-catherd-1.0-design.md`](docs/superpowers/specs/2026-09-25-catherd-1.0-design.md).
Releases go through [Changesets](https://github.com/changesets/changesets): add one with
`bunx changeset`.
````

with:

````markdown
bun run typecheck && bun run lint && bun run format:check
```

CI runs this on Linux and macOS, on Bun 1.4.0 and the latest Bun. What CI cannot run (the live tests,
fixture capture, the Codex sandbox, the Jev key prompt) is in
[`docs/live-verification.md`](docs/live-verification.md), with the exact commands.

Design: [`docs/superpowers/specs/2026-09-25-catherd-1.0-design.md`](docs/superpowers/specs/2026-09-25-catherd-1.0-design.md).
Releases go through [Changesets](https://github.com/changesets/changesets): add one with
`bunx changeset`.
````

The changeset's first line and bullets become the `## 1.0.0` / `### Major Changes` entry of `CHANGELOG.md`; keep it to what 1.0 ships. `MIGRATION.md`'s paths are catherd's (`src/infra/paths.ts`); the 0.x details are from `f0ee214` (the 0.x agent names and `~/.config/typesafe/api_key`).

- [ ] **Step 3: Check and commit**

Run: `bun run format && bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: clean; the full suite passes.

```bash
git add .changeset/catherd-1-0.md MIGRATION.md README.md test/services/setup.test.ts
git commit -m "chore(release): the catherd 1.0.0 changeset, MIGRATION.md and the readme's upgrade notes"
```

- [ ] **Step 4: See what the release PR will do, then undo it**

With the commit made, so the checkout below restores only what the dry run changed:

```bash
bunx changeset status
bun run version-packages
grep '"version"' package.json plugin/.claude-plugin/plugin.json && grep catherd-cli@ plugin/.mcp.json && head -8 CHANGELOG.md
bun test test/plugin.test.ts
git checkout -- . && git status --short
```

Expected: `status` lists `catherd-cli` under `major`; after `version-packages`, `1.0.0` in `package.json`, `plugin.json` and `.mcp.json` (`catherd-cli@1.0.0`), `CHANGELOG.md` opening with `## 1.0.0` and `### Major Changes`; `plugin.test.ts` passes; after the checkout `git status --short` prints nothing (the changeset is back, the versions are 0.2.1 again). Commit nothing from the dry run: the Release workflow makes these changes in its own PR.

---

## Carry-overs: where each went

Every item the HANDOFF's "Plan 7 (hardening)" list, the plan-4 ledger and the plan-5 ledger sent here, checked against the code at `e1ffa6c`:

| Item | Where |
|---|---|
| "finalizes a waiting dispatch as lost…" timing window | Task 3 (the worker waits for a file) |
| `runCli` grandchild kill | Task 2 (and capture's in Task 11) |
| macOS realpath; transient `ps` failure | Task 9; Task 1 (`sameProcess`) |
| Codex has no `isBusy` | Tasks 1 and 2 (open tool calls) |
| opencode `isBusy`: no time bound, first non-idle only | Task 2 |
| preflight never as root | Task 4 |
| null `startTime` orphan cancel is pid-only; pgid not checked | Task 3 |
| cancel/exit race records cancelled | Task 1 (the supervisor's side); the orphan side stays, Ruling 3 |
| orphan exit.json always SIGTERM | Task 3 |
| tool-not-found labelled `E_INPUT_INVALID` | Task 4 (kept, with its own fix: Ruling 10) |
| old spec.json not cleaned | Task 3 |
| `supervisor.test.ts:172` timing | Task 1 |
| `doctor`: `refreshDiscovery`, `testJevKey` | already done by plan 5 (`src/services/doctor.ts`: `backendChecks`, the `jev` row) |
| `doctor`: Codex logged in with ChatGPT | Task 8 |
| macOS + Linux CI matrix; Changesets release of 1.0 | Tasks 10, 12 |
| live-verification kit | Task 11 |
| plan 4: milestone typo in `land`; cached Jev answers unvalidated; `jevKey` null on a corrupt file | Task 5 (and Task 8's doctor row) |
| plan 5: stored enums closed | Task 6 |
| plan 5: input-validation failures get no `tool` log row | Task 4 |
| plan 5: `cli.test.ts` SIGINT test sleeps 800 ms; SIGINT exemption keys on `own[0]` | Task 7 |
| plan 5: `lock.test.ts` double SIGINT can hang | Task 7 |
| plan 5: `runs show --debug` tail reads whole files | Task 7 |
| plan 3: capture isolation, kill reason, meta sanitized after stringify, `--out` relative to the cwd | Task 11 |

## Not in this plan

- **Plan 5's final-review minors** (the session ledger's "→ final" items: `runs show --name` without `--debug`, `lock`'s `--help` note on its process group, `init` on a non-TTY stdin, the `sandbox:codex` check's scope, `catalog list --role`'s error, `mark()`'s doc comment, `readProfileDoc`'s code for a missing user-named profile, `patchProfile` resolving twice, `ProfileSaved`/`Saved`, `viewOf`'s aliases, `lock.ts`'s exit code on config errors, the architecture test's inline bridge, the `profile_set` "every field" test, the README omissions, `quotaOf` reuse, the "(no honesty score)" wording, `agents.ts`'s empty catch, the `#default` description, the dedup test, doctor's fix text using the global active profile) belong to plan 5's final fix wave, which lands before this plan. Whatever that wave leaves is a 1.0.x item, not a release blocker.
- **Plan 1–3 minors the reviews marked "plan 7" but no carry-over list names** (filelock's stale-marker races, `isHeader`'s two keys, directory fsync, `readAgentRuns` dropping rows silently, a `launch.json` write failure marking a live dispatch lost, the supervisor's own SIGTERM handler, the claude-code simulator's gaps, isolated opencode's `isBusy` against the background service): none is reachable without a crash, a disk fault or an edited file, and each has a reason in its review; they are 1.0.x.
- **Codex adding the heavy-lock directory to `writable_roots` itself** (plan 5's "After this plan"): only after the owner's check in `docs/live-verification.md` step 4 shows Codex refusing it by default.
- **Reading `~/.config/typesafe/api_key`** as a third Jev key source, as 0.x did: spec §5.5 names two sources. `MIGRATION.md` tells a user whose key lived only there that `init` asks for it once.
- **Publishing.** Task 12 prepares the release; merging the "chore: release catherd" PR that the Release workflow opens publishes 1.0.0 to npm and tags `v1.0.0`. That merge is the owner's.

## Self-review

- **Spec coverage.** §3.3: the first exit wins and the grace after interrupt (Task 1), identity before any signal (Tasks 1, 3). §3.4's unknown values (Task 6). §6: Codex busy (Tasks 1, 2), opencode's latest message (Task 2), isolation for captures (Task 11). §10.2: every tool call logged (Task 4). §10.3: the Codex login (Task 8), the credentials file (Task 8). §10.4: preflight never as root (Task 4), secrets off disk (Task 3's old specs, Task 11's meta). §11.7–8: the live kit (Task 11); §11 hygiene: event-driven tests (Tasks 1, 3, 7), the coverage floor (Task 10). §12: the matrix, audit, pack smoke, release gating, marketplace tag, automated update PRs (Task 10), the changeset and `MIGRATION.md` (Task 12). §14 ("vendor CLIs change monthly"): fixtures per CLI version from the capture kit (Task 11). D2 (Task 12), D7 (Task 11).
- **Placeholders.** None: every step carries its code or its exact command, and Ruling 16 gives the exact rule for the one number that plan 6 may move.
- **Types.** `LineInfo.item` and `EventDelta.item` are both `{ id: string; open: boolean }`; `SuperviseHooks.isBusy(thread, sinceMs)` and `BackendAdapter.isBusy(thread, cwd, sinceMs?)` meet in `src/entry/supervise.ts`; `savedJevKey` (Task 5) is what Task 8's doctor reads; `exited` (Task 2) is what Tasks 7 and 9 use; `Probe.billing` is a `BillingMode`, compared with `Profile.billing[id]`.
- **Review Focus.** Each of the five lines names the test that pins it, in its owning task.

## After this plan

- The owner runs `docs/live-verification.md` before merging the release PR (or right after, then 1.0.1 if it finds something), and `docs/manual-tests.md`'s plugin check in a fresh Claude Code session.
- Plan 8: the Cursor CLI adapter (1.1) and the Grok CLI adapter (1.2), each through `test/adapters/contract.ts`, a simulator in `test/sim/` and live tests gated by `CATHERD_LIVE=1`; their `item`-style busy events, where their streams have them, plug into Task 1's supervisor as Codex's do.
