# catherd 1.3, plan 15: the groundwork and the Cursor adapter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything the three 1.3 backends share (spec 1.3 §3), then Cursor as catherd's fourth worker backend (§4), with the catalog families that score its models (§7.1, §7.2), and its docs and live-kit section (§8, §10, live-verification §11). Groundwork: admission enforces `resume.sameAccessOnly`; `ADAPTER_IDS` gains `antigravity` and every derived enum follows; `capture-fixtures` passes stdin only when a plan reads it and can capture a resumed thread; a CLI the OS cannot execute is "installed but cannot run", and a logged-out backend never reaches a dispatch; an isolated worker whose HOME moves keeps catherd's dirs and the user's caches; doctor's access row says "not tested" where a backend has no sandbox runner; an isolated backend that needs an API key is a validation error without it. Cursor: `cursor-agent` (or a Cursor `agent`) ≥ 2026.09.28, login through `models`, stdin briefs, stream-json events, per-access isolated homes with their own `sandbox.json`, doctor's access probes through the hidden `sandbox run`, and the `name:agent` info row.

**Architecture:** the groundwork lives where each concern already is: `src/services/admission.ts` (sameAccessOnly), `src/services/backends.ts` (`probeBackend`: cannot-run), `src/services/capture.ts` (`captureOne`, stdin, resume), `src/adapters/access.ts` (`movedHomeEnv`), `src/services/doctor-access.ts` (not tested, a sandbox's own fixes), `src/services/profile-store.ts` (`validateHere`: isolation keys), and new optional fields on `BackendAdapter` (`install`, `Probe.info`, `AccessShell.fixes`, `isolationKey`, `prepare`'s `network`). Cursor is one folder, `src/adapters/cursor/` (`events.ts`, `models.ts`, `home.ts`, `index.ts`), registered in `src/adapters/all.ts`, with a simulator `test/sim/cursor-agent`, synthetic fixtures under `test/fixtures/adapters/cursor/` that cite the research, and the contract suite. The catalog gains eight families with `on.cursor`, plus `on.cursor` on three shipped ones; source sync keys an effortless family's values at `#default` and finds a family under its vendor's dotted id; `catalogRungs` names a model with no effort at `#default`, so Composer gets inferred stand-ins.

**Tech Stack:** Bun ≥ 1.4, TypeScript, zod 4, citty, `@modelcontextprotocol/sdk`, `@opentui/react`. No new dependency.

**Spec:** `docs/specs/2026-09-29-catherd-1.3-design.md` §2, §3, §4, §7, §8, §9 (every recommendation followed), §10; research `docs/research/2026-09-29-cursor-grok-antigravity.md` §2, §5, §6.3, §7, §8. 1.0 plan 8 Part A (`docs/plans/2026-09-26-08-cursor-grok.md`) is superseded; its A-tasks were read as prior art.

**No changeset.** Plan 15 ships nothing on its own: 1.3.0 is one release with Grok (plan 16) and Antigravity (plan 17), held for the live kit (spec §9 Q1). The last of the three plans adds the 1.3.0 changeset and `MIGRATION.md`'s "From 1.2 to 1.3".

**Pre-validated on scratch branch `plan15-scratch` (built on `main` at `a444e1b`, 1.2.1): every task below is that branch's commit, in order, each built test-first; the full gate is green on the head: 1698 pass / 17 skip / 0 fail (1715 tests, 157 files, about 3.8 minutes); typecheck, lint and format:check green.** Baseline on `a444e1b`: 1620 pass / 14 skip / 0 fail (1634 tests, 151 files). `git show <task commit>` on `plan15-scratch` reproduces any file; the commits are listed under "Verified facts".

## Global Constraints

- Layers `domain → infra → adapters → services → entry` (`test/architecture.test.ts`). Cursor's code stays in `src/adapters/cursor/`; the generic changes stay in the service that owns each concern. ProfileService stays the single writer of profiles, config, bindings and agent links.
- The gate: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test`. **No test reaches the network or a real CLI**: Cursor runs only as `test/sim/cursor-agent` on a PATH the test sets (`simPath()`, or a PATH of the sim dir, Bun's dir, `/usr/bin` and `/bin`); every test that could reach Anthropic deletes `ANTHROPIC_API_KEY` in-process or passes `ANTHROPIC_API_KEY: ""` to a spawned process, and spawned processes get an explicit `env`. Tests that touch `CURSOR_API_KEY` set or delete it under `snapshotEnv()`.
- No wall-clock sleeps for correctness. The live test (`test/live/cursor.live.test.ts`) runs only with `CATHERD_LIVE=1`.
- The shell may export `FORCE_COLOR`; it changes some expected output. Run tests with it unset (`env -u FORCE_COLOR bun test …`).
- Commits: conventional, subject ≤ 100 characters, lower-case first word after the scope, body lines ≤ 100; check `git log` after each commit (a failed hook leaves the changes uncommitted).
- Spec 1.3 §3.2, verbatim: "Admission refuses to resume a thread whose last record ran under another access, with `E_ADMIT_THREAD` and the fix "dispatch a fresh thread (omit `thread`)". The check runs before anything is written."
- Spec 1.3 §3.3: "`capture-fixtures` passes stdin only when the adapter's `plan()` sets `stdinPath`"; "Probes never open a browser or block on login … Admission refuses a rung whose backend probes as logged out (`E_BACKEND_NOT_LOGGED_IN`, with the login command)"; "A spawn that fails with `ENOEXEC` / "exec format error" reports "installed but cannot run on this OS", with the reinstall command"; "Each adapter sets its CLI's auto-update off for workers: Cursor: hidden `--disable-auto-update`".
- Spec 1.3 §3.4: `accessShell` returns "no way to run a shell in <backend>'s sandbox without a model turn", and doctor's `access:<backend>` row is `skip` / `not tested`.
- Spec 1.3 §4.2 argv: `-p --output-format stream-json --trust --workspace <repo> --model <slug> --disable-auto-update <access flags> [--resume <chat>]`, the brief on stdin, `NO_OPEN_BROWSER=1`; §4.3 access: read-only `--mode ask --sandbox enabled` (advisory), workspace-write `--sandbox enabled` (enforced), full `--force --sandbox disabled --approve-mcps`; §4.4 isolation `HOME=<data>/cursor-home` plus `CURSOR_API_KEY`, `prepare` refusing without the key.
- Spec 1.3 §7.3 and §8: a new backend's rungs are never default stand-ins for the shipped rungs, and a new backend is off in the default profile until the user puts a rung on it. Plan 14's C-3 holds: the default profile validates with no errors and no warnings.
- MCP: 26 tools, unchanged.

## Review Focus

1. **A dispatch that resumes a thread under another access** (spec §3.2). Expected: refused with `E_ADMIT_THREAD` only when the adapter declares `resume.sameAccessOnly` (none of the four shipped adapters does today; Grok will); before any record or dispatch dir is written. Pinned in `test/services/adapter-hooks.test.ts` ("refuses to resume a thread under another access before anything runs…", "resumes under any access on a backend that applies each run's own flags").
2. **Cursor's reply is the text after its last tool call**, not `result.result` (which concatenates every assistant segment and breaks the `STATUS:` line, spec §3.1). Pinned in `test/adapters/cursor-events.test.ts` and the contract suite; the fixtures are synthetic (live kit §11 step 1 replaces them).
3. **Native Cursor workspace-write runs without `--force`** (Ruling C-edit). If plain edits do not apply there, every Cursor worker writes nothing and the run reports `ok` with no change; live kit §11 step 2 decides it before the release.
4. **Isolated Cursor homes are per access** (`<data>/cursor-home/<access>`, plus `workspace-write-offline`) with one shared `chats` dir linked into each, because Cursor reads `sandbox.json` per home (Ruling 5). A resume under another access must still find its chat. Pinned in `test/adapters/cursor.test.ts` ("isolates with catherd's own HOME per access…", "needs CURSOR_API_KEY to isolate, and writes each isolated home's sandbox.json with a shared chats dir").
5. **`catalogRungs` now names `#default` for a model with no effort** (Ruling 17). It adds `claude-code:claude-haiku-4-5-20251001#default` and every Cursor bare slug to the failover pool and the stand-in ranker; every pinned failover and stand-in test is unchanged.
6. **Doctor on every machine now shows a `backend:cursor` row** (`skip missing`, "no profile uses it") like the other backends'. Pinned in `test/services/doctor.test.ts`.

## Rulings on the spec

Controller ruling, from the spec:

- **C-edit** (spec §4.3): `workspace-write` runs `--sandbox enabled` without `--force`, so plain edits are assumed to apply headless under the sandbox. — The docs disagree and no login was available to run it (research §2.6). — Cost if wrong: a native Cursor worker writes nothing; the fix is `--force --sandbox enabled` with a `permissions.deny` list and enforcement `advisory`. Live kit §11 step 2.

Rulings of this plan (`what — why — cost if wrong`); each one a live check names is in `docs/dev/live-verification.md` §11:

1. **Logged in means `cursor-agent models` answered** (exit 0); an auth failure in its output is logged out; anything else (a timeout, a network error) is unknown (`loggedIn: null`), which admission does not refuse. — Spec §4.1; `status` reports token presence (research §2.9). — Cost if wrong: a flaky network reads as "unknown" and the run itself reports the auth error. Live §11 setup.
2. **The generic "logged out" refusal is the adapter's `E_BACKEND_NOT_LOGGED_IN` probe problem**, not a guard on `loggedIn === false`. — opencode probes logged out yet runs its free Zen models; a generic guard broke its capture. — Cost if wrong: an adapter that reports `loggedIn: false` without a problem is not refused (every shipped adapter reports the problem).
3. **`E_BACKEND_CANNOT_RUN`** (new code): a probe that throws with `ENOEXEC`, `exec format error`, or Bun's `posix_spawn` form reads as installed, version unknown, with the message "`<id>` is installed but cannot run on this OS: `<path>`" and the adapter's new `install` string as the fix; doctor's word is "cannot run". — Spec §3.3. — Cost if wrong: Linux's error text differs from the two forms matched (only macOS was seen, research §3.1) and the row says "unreadable" instead.
4. **Hidden flags** `--disable-auto-update` (every worker run) and `cursor-agent sandbox run -- sh -c …` (doctor's probes) are used. — Spec §9 Q8. — Cost if wrong: a vendor removes one; the run fails on an unknown option (`cli-too-old`) or doctor's access row becomes "not tested". Live §11 steps 9 and 11.
5. **Isolated Cursor homes are per access**, `<data>/cursor-home/{read-only,workspace-write,workspace-write-offline,full}`, each with `.cursor/` holding its own `sandbox.json` and a symlink `chats → <data>/cursor-home/chats`; `CURSOR_CONFIG_DIR` and `CURSOR_DATA_DIR` point at that `.cursor`. — `sandbox.json` is read per home, and lanes of different access run side by side; an unknown chat id silently starts empty (research §2.5), so every home must see every chat. — Cost if wrong: Cursor refuses a symlinked chats dir or keys chats elsewhere; an isolated resume under another access starts empty. Live §11 steps 5 and 8.
6. **`movedHomeEnv`** (shared, `src/adapters/access.ts`): a worker whose HOME moves gets `CATHERD_CONFIG_DIR`, `CATHERD_DATA_DIR` (new: `root("data")` honours it), `GOPATH` and the toolchain cache vars pointed at the user's real ones; other dotfiles (`~/.npmrc`, `~/.gitconfig`) stay behind (a `ponytail:` comment). — 1.1 §5's lock dir and warm caches must survive the move. — Cost if wrong: a registry login in `~/.npmrc` is missing in an isolated Cursor worker.
7. **The sandbox policy an isolated home writes**: read-only `{type: workspace_readonly}`; workspace-write `{type: workspace_readwrite, additionalReadwritePaths: writableRoots(), networkPolicy: {default: allow}}`, without `networkPolicy` when the role's network is off; full none. `prepare` gets `network` (new optional field; admission passes `rc.network !== false`, capture `true`). — Spec §4.3. — Cost if wrong: field names differ from Cursor's schema (read from the bundle); live §11 step 8.
8. **Native Cursor gets the user's own `~/.cursor/sandbox.json`**, never edited (spec §9 Q3); doctor's access probes run through `sandbox run` under it, without `--allow-paths`, so the row says what a native worker gets; `AccessShell.fixes` (new) gives Cursor's own fix per probe. Isolated runs are not probed separately. — Cost if wrong: `sandbox run` ignores `sandbox.json` and the row misreports; live §11 step 9.
9. **Reply = the assistant text after the last tool call**; tokens = `result.usage` (`inputTokens + cacheReadTokens + cacheWriteTokens` as input, `cacheReadTokens` as cached, `outputTokens`); the thread = `system/init.session_id`; `retry/starting` is `retrying`. — Spec §3.1, research §2.3. — Cost if wrong: the fixtures are synthetic; live §11 step 1 captures real ones.
10. **Status mapping**: a `result` that is not an error is `ok`; otherwise `unknown option`/`OUTDATED_CLIENT` → `cli-too-old` (checked before limit), `usage limit`/`rate limit`/`too many requests`/`ActionRequiredError`/`USAGE_LIMIT`/`RATE_LIMIT` → `limit`, a team policy ("administrator has disabled") → `failed`; an auth failure's message gets the login fix. `graceAfterFinalMs` 30 s: the CLI may linger after `result` (research §2.3). — Cost if wrong: a real limit reads `failed` and no failover happens; live §11 step 10.
11. **Enforcement**: read-only `advisory` (also when isolated: the adapter's table is per access), workspace-write `enforced`, full `enforced` (as Codex's). — Spec §4.3 says isolated read-only is enforced; the table has no isolation axis. — Cost if wrong: the TUI and `profile show` understate an isolated read-only Cursor role.
12. **`cursorBin`**: `cursor-agent` when on PATH, else `agent`; the probe accepts it only when `--version` prints Cursor's `YYYY.MM.DD-<hash>`; the version kept is the date (`2026.09.28`). `name:agent` is an info row when `agent` resolves (realpath) to another program than `cursor-agent`; that `agent` is never run then. — Spec §4.1, §4.7. — Cost if wrong: none known.
13. **Probe `login`** is `"Cursor"` or `"API key"` (doctor appends " login", so the row reads "Cursor login"); billing `metered` is reported only under `CURSOR_API_KEY`; a Cursor login leaves the profile's billing (default `metered`, spec §9 Q4). — Cost if wrong: a plan with large included usage ranks as metered.
14. **Isolation keys** (spec §8, §9 Q6): `BackendAdapter.isolationKey` (Cursor: `CURSOR_API_KEY`); `validateHere` (services) errors on `harness.<id>.isolated: true` when catherd's own environment lacks the key, with the fix "`export <KEY>=<key>`, or `catherd profile set harness.<id>.isolated false`"; the domain's `validateProfile` does not read the environment. The TUI's harness row adds "(it needs <KEY>)" and the adapter's isolation note. — Cost if wrong: a profile validated on another machine is not checked there.
15. **Doctor's access row with no runner**: `skip`, "not tested", detail "no way to run a shell in `<id>`'s sandbox without a model turn; the live kit (docs/dev/live-verification.md) runs the five probes as one worker turn". — Spec §3.4, §9 Q5. — Cost if wrong: none (Grok and agy use it).
16. **Catalog ids on Cursor** are the synthetic listing's (research §2.4): `gpt-6-sol` (efforts `low, high, xhigh`), `gpt-6-luna` (`high`), `claude-opus-5-5-thinking` (`high`), `grok-4.7`, `grok-4.6`, `grok-4.5`, `composer-2.5`, `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.1-pro` (no effort: `#default` runs the bare slug). The other shipped families get no `on.cursor` until the owner's listing names them; every Cursor context is 200K (Cursor's default window outside Max Mode). — Spec §4.6: "ids confirmed from the owner's listing in the live kit". — Cost if wrong: validation warns "last listing does not offer …" and `prepare` refuses with `E_BACKEND_MODEL_UNKNOWN`; live §11 step 6.
17. **A model with no effort has one rung, `#default`**: `catalogRungs` names it, so Composer (and every bare Cursor slug) enters the stand-in ranker and gets inferred values. — Spec §7.2: "Composer 2.5 … get[s] 1.2 §6.3's inferred stand-ins … a warning, never an error"; without it a Composer-only role is "no usable rung". — Cost if wrong: the failover pool also gains Haiku's Claude Code `#default` (no pinned test moved).
18. **An effortless family keys every source value at `#default`** (`derive`), whatever effort the source names; `effortAssumed` is not set for it. — Epoch names Composer's effort `none`, Arena Grok's `xhigh`; the family has one rung. — Cost if wrong: a bare Cursor Grok or Gemini slug is scored by the source's own effort (Arena's Grok 4.7 is `xhigh`); plans 16 and 17 add real efforts through `on.grok`/`on.antigravity`, which re-keys them.
19. **Composer's price is Grok 4.7's** ($2 / $0.50 / $6 per M; no keyless source prices Composer, research §5), `imageIn: true`, no release date. `defaultEffort`: Grok and Gemini `high`, Composer `default`. Alias `gemini-3.1-pro-preview → gemini-3-1-pro` (every source names the preview). models.dev's facts for a family are found under the vendor's own id that maps to it (`gemini-3.8-flash` for `gemini-3-8-flash`). — Cost if wrong: Composer ranks at Grok's cost.
20. **Spec §7.3's failover pairs are deferred to plans 16 and 17.** Their partner backends (`grok`, `antigravity`) have no adapter in plan 15; a `DEFAULT_FAILOVER` entry onto them errors "catherd cannot run grok yet" and breaks C-3. — Cost if wrong: none; plan 16 adds Grok ↔ Cursor, plan 17 Gemini ↔ Cursor.
21. **`DEFAULT_BILLING.antigravity` is `metered`** until plan 17's probe reads the login (spec §9 Q4). — Cost if wrong: none in plan 15 (no adapter).
22. **`init` is unchanged**: it detects no backend and asks nothing new (spec §8); Cursor is off until a rung names it.
23. **Tests that need a backend with no adapter use `grok`** (it was `cursor`); plan 16 moves them to `antigravity`. The capture-fixtures "no cases" test keeps `grok`.
24. **Capture cases** run `cursor:auto#default` isolated (so they need `CURSOR_API_KEY`): `ok` (write, read, shell; workspace-write), `resume` (a hello, then a recall on the same chat), `read-only-write` (ask mode). No capture case writes outside its scratch dir; the sandbox-outside check is live §11 step 3. — Cost if wrong: none.

## Assumes from earlier plans (re-check on the head you execute on)

`main` at `a444e1b` (1.2.1, with Claude Sonnet 5.5 in the catalog) and the docs PR `docs/backends-1.3` (spec, research, HANDOFF) merged, which touches no code. The executor re-finds every diff hunk by its context. These interfaces are consumed as they are on `a444e1b`:

- `src/adapters/backend.ts`: `BackendAdapter` (`probe`, `plan`, `parse`, `finalize`, `listModels`, `prepare?`, `accessShell?`, `resume.sameAccessOnly`, `enforcement`, `isolationNote?`, `graceAfterFinalMs?`), `Probe`, `AccessShell` (`label`, `run`), `RunRequest`, `SpawnPlan` (`stdinPath`).
- `src/adapters/access.ts`: `writableRoots()`, `realTmpdir()`, `toolchainCaches()`, `scratchShell(label, prefix)`; `src/adapters/cli.ts`: `runCli`, `extractVersion`, `compareVersions`; `src/adapters/discovery.ts`: `discovered(backend, list, { maxAgeMs, need })`.
- `src/services/admission.ts`: `admit`, `recordsOnThread`, `prepared`; `src/services/backends.ts`: `readyAdapter`, `resetReadiness`; `src/services/doctor-access.ts`: `accessChecks`, `runProbes`; `src/services/capture.ts`: `captureFixtures`.
- `src/services/source-derive.ts`: `derive`, `factsOf`; `src/domain/sources.ts`: `idMapper`, `familyEfforts`, `defaultEffortOf`; `src/domain/failover.ts`: `catalogRungs`.
- `test/services/helpers.ts`: `freshRun`, `fakeDeps`, `testView`, `runRole`, `writeLane`; `test/sim/scenario.ts`: `simPath()`, `withScenario`; `test/sim/sim-scenarios.ts`: `write(env, scenario)` and the Claude/opencode scenarios.

## Verified facts (scratch build, 2026-09-29)

- Baseline on `a444e1b`: 1620 pass / 14 skip / 0 fail (1634 tests, 151 files). Head of `plan15-scratch`: 1698 pass / 17 skip / 0 fail (1715 tests, 157 files): 78 new passing tests and 3 new skips (the live test without `CATHERD_LIVE`). Each task's own tests failed before its code and passed after, with typecheck, lint and format:check green at each commit; the full gate ran on the head of both builds (below).
- `plan15-scratch` commits, one per task: 1 `90e28b3`, 2 `a9cbebb`, 3 `f050b5c`, 4 `3b72605`, 5 `811765e`, 6 `39bbaf3`, 7 `c8fac1d`, 8 `7e1fc0c`, 9 `3caf318`, 10 `4c55d24`, 11 `261fc26`, 12 `033b6c7`, 13 `8792ae9`, 14 `194c6d4`.
- The first build of this plan was on `docs/backends-1.3` at `58440c8` (1.2.0 code): baseline 1620 pass / 14 skip / 0 fail (1634 tests, 151 files), head 1698 pass / 17 skip / 0 fail (1715 tests, 157 files). It was then cherry-picked onto `a444e1b`; only Task 11 conflicted (the frames snapshot and `docs/tui-frames.md`, regenerated; `catalog/models.json` merged cleanly after Sonnet 5.5).
- A derive over the owner's cached answers (`~/.local/share/catherd/sources/`, fetched 2026-09-28) with this catalog: every Grok and Gemini family is scored at `#default` on `agentic` (Arena agent, measured, and task outcome, calibrated), `steer` (measured) and `frontend` (Arena WebDev, measured; Epoch WebDev, calibrated; Grok 4.7 Arena only). Composer gets no keyless value (Epoch FrontierCode is not used: it shares 2 rungs with the anchor, plan 14), so it leans on inferred stand-ins. No price warning for the new families; models.dev facts found for all seven non-Composer families. Still `unmatched` (no family): `gemini-3-flash`, `gemini-3-pro`, `gemini-3.5-flash(-lite)`, `grok-4.20-*`, `grok-4.3`, `grok-4-1*`, `grok-code-fast-1` and `grok-build-0.1`.
- Prices (OpenRouter / models.dev, 2026-09-28), $/M input / cached / output: Grok 4.7 and 4.6 2 / 0.5 / 6, Grok 4.5 2 / 0.3 / 6 (context 500K); Gemini 3.8, 3.7, 3.6 Flash 0.75 / 0.075 / 3.75 (1,048,576); Gemini 3.1 Pro 2 / 0.2 / 12. Release dates from models.dev: Grok 4.7 2026-09-21, 4.6 2026-08-12, 4.5 2026-07-08; Gemini 3.8 Flash 2026-09-02, 3.7 2026-08-13, 3.6 2026-07-21, 3.1 Pro 2026-02-19.
- A Cursor-only writer (`cursor:composer-2.5#default`) saves with a "stand-in to confirm" warning only after Ruling 17; before it, `patchProfile` refused it ("the writer role has no usable rung").
- oxfmt formats `catalog/*.json` and `README.md`; `docs/**` and `test/fixtures/**` are ignored. `catalog/models.json` keeps its layout: an object or array stays on one line when it fits in 110 columns.

## File Structure

| File | Task | Responsibility |
| --- | --- | --- |
| `src/domain/ids.ts`, `src/domain/catalog.ts`, `src/domain/cost.ts`, `src/entry/tui/profile-tree.ts` | 1 | `antigravity` in `ADAPTER_IDS`, `BILLING_KEYS`, `MODEL_KEYS`, `DEFAULT_BILLING`, the TUI's group order |
| `src/services/admission.ts` | 2, 10 | sameAccessOnly (2); `prepare`'s `network` (10) |
| `src/adapters/backend.ts` | 3, 6, 7, 10 | `install`, `Probe.info` (3, 10); `AccessProbeId`, `AccessShell.fixes` (6); `isolationKey` (7); `prepare`'s `network` (10) |
| `src/services/backends.ts`, `src/services/doctor-backends.ts`, `src/domain/errors.ts`, the three adapters' `install` | 3, 12 | `probeBackend`, `E_BACKEND_CANNOT_RUN` (3); doctor's info rows (12) |
| `src/services/capture.ts` | 4, 10, 13 | `captureOne`, stdin, resume (4); `network` (10); Cursor's cases (13) |
| `src/adapters/access.ts`, `src/infra/paths.ts` | 5 | `cacheVars`, `movedHomeEnv`; `CATHERD_DATA_DIR` |
| `src/services/doctor-access.ts` | 6 | not tested; a sandbox's own fixes |
| `src/services/profile-store.ts`, `profile-service.ts`, `src/entry/tui/effects.ts`, `fixtures.ts`, `views/profiles.tsx` | 7 | `isolationKeyErrors`, `validateHere`; the harness row |
| `src/adapters/cursor/events.ts`, `models.ts` (new), `test/fixtures/adapters/cursor/*` (new) | 8 | events, tokens, status words; the listing |
| `test/sim/cursor-agent` (new), `test/sim/sim-scenarios.ts` | 9 | the simulator |
| `src/adapters/cursor/home.ts`, `index.ts` (new) | 10 | homes and `sandbox.json`; the adapter |
| `catalog/models.json`, `catalog/sources.json`, `src/services/source-derive.ts` | 11 | families, aliases, default efforts; effortless keying, vendor ids |
| `src/adapters/all.ts`, `src/domain/failover.ts` | 12 | registration; `#default` rungs |
| `test/live/cursor.live.test.ts` (new) | 13 | the live test |
| `README.md`, `plugin/skills/catherd-setup/SKILL.md`, `docs/dev/live-verification.md` | 14 | docs and §11 |

## Parallelism

| Wave | Batches (parallel worktrees) | Depends on | Why disjoint |
| --- | --- | --- | --- |
| A | {1}, {2, 3, 6, 7}, {4}, {5}, {8, 9}, {11} | — | ids and enums (1); admission, backends, doctor, profile store, all in `backend.ts` and `adapter-hooks.test.ts` (2 → 3 → 6 → 7, in order); capture (4); access and paths (5); Cursor's parsers and simulator, new files only (8 → 9); catalog data and derive (11) |
| B | {10} | 2–9 | the adapter reads every A interface; touches `backend.ts`, `admission.ts`, `capture.ts`, `adapter-hooks.test.ts` after A |
| C | {12} | 10, 11 | registration; the doctor test runs a Composer rung (11) |
| D | {13}, {14} | 12 | capture cases and the live test (13) vs docs (14) |

Shared files, each owned by one task at a time: `src/adapters/backend.ts` (3 → 6 → 7 → 10), `test/services/adapter-hooks.test.ts` (2 → 3 → 6 → 7 → 10 → 12), `src/services/capture.ts` and `test/services/capture.test.ts` (4 → 10 → 13), `src/services/admission.ts` (2 → 10), `src/services/doctor-backends.ts` (3 → 12), `src/adapters/cursor/index.ts` (10 → 12), `test/sim/sim-scenarios.ts` (9 only), the frames snapshot (11 only). For fewer agents: {1, 2, 3, 6, 7}, {4, 5, 8, 9, 11}, {10}, {12, 13, 14}.


---

### Task 1: `antigravity` joins the adapter ids, with its billing, model and harness keys (spec 1.3 §3.3; Ruling 21)

`ADAPTER_IDS` gains `antigravity`, and every enum derived from it follows: `RUNG_BACKENDS` (derived), `BILLING_KEYS` and `MODEL_KEYS` in `catalog.ts`, `DEFAULT_BILLING` (`metered`, Ruling 21), and the TUI's group order. No adapter yet: `antigravity:` rungs parse and a profile may name them; admission refuses them as missing.

**Files:**

- Modify: `src/domain/catalog.ts`
- Modify: `src/domain/cost.ts`
- Modify: `src/domain/ids.ts`
- Modify: `src/entry/tui/profile-tree.ts`
- Test: `test/domain/catalog.test.ts`
- Test: `test/domain/ids.test.ts`
- Test: `test/domain/profile.test.ts`

**Interfaces:**
- Produces: `ADAPTER_IDS` = `codex, claude-code, opencode, cursor, grok, antigravity`; `BILLING_KEYS`, `MODEL_KEYS` with `antigravity`; `DEFAULT_BILLING.antigravity = "metered"`.

- [ ] **Step 1: Write the failing tests**

Modify `test/domain/catalog.test.ts`:

````diff
@@ -2,10 +2,12 @@ import { describe, expect, it } from "bun:test";
 import { readFileSync } from "node:fs";
 import { join } from "node:path";
 import {
+  buildCatalog,
   CONFIDENCE,
   capableFor,
   DIMS,
   effectiveRank,
+  ModelsFileSchema,
   OverrideSchema,
   outranks,
   RANK,
@@ -155,6 +157,26 @@ describe("rungInfo", () => {
     expect(rungInfo(c, "codex:gpt-6-sol#high").listed).toBe(true);
   });
 
+  it("maps an antigravity rung through a family's on.antigravity, billed under its own key (spec 1.3 §3.3)", () => {
+    const models = shippedModels();
+    const flash = {
+      id: "flash-x",
+      name: "Flash X",
+      capabilities: { toolUse: true, imageIn: true, reasoning: true },
+      price: { input: 1, cached: 0.1, output: 4 },
+      on: { antigravity: { id: "flash-x-cli", efforts: ["low", "high"], context: 1000000 } },
+    };
+    const c = buildCatalog({
+      models: ModelsFileSchema.parse({ ...models, families: [...models.families, flash] }),
+      scores: shippedScores(),
+    });
+    expect(rungInfo(c, "antigravity:flash-x-cli#low")).toMatchObject({
+      key: "antigravity",
+      canonical: "flash-x#low",
+      efforts: ["low", "high"],
+    });
+  });
+
   it("names an unknown model by its own id", () => {
     expect(rungInfo(shipped(), "opencode:opencode-go/kimi-k3#default")).toMatchObject({
       family: null,
````

Modify `test/domain/ids.test.ts`:

````diff
@@ -1,6 +1,13 @@
 import { describe, expect, it } from "bun:test";
 import { CatherdError, errorMessage, isCatherdError } from "../../src/domain/errors.ts";
-import { assertId, formatRung, newDispatchId, parseRung, tryParseRung } from "../../src/domain/ids.ts";
+import {
+  ADAPTER_IDS,
+  assertId,
+  formatRung,
+  newDispatchId,
+  parseRung,
+  tryParseRung,
+} from "../../src/domain/ids.ts";
 
 describe("CatherdError", () => {
   it("carries a code and a fix, and serialises without the stack", () => {
@@ -43,6 +50,16 @@ describe("parseRung", () => {
     expect(tryParseRung("nope:x#high")).toBeNull();
   });
 
+  it("knows the three 1.3 backends by their ids (spec 1.3 §3.3)", () => {
+    expect(ADAPTER_IDS).toEqual(["codex", "claude-code", "opencode", "cursor", "grok", "antigravity"]);
+    expect(parseRung("antigravity:gemini-3.8-flash#low")).toEqual({
+      backend: "antigravity",
+      model: "gemini-3.8-flash",
+      effort: "low",
+    });
+    expect(tryParseRung("agy:gemini-3.8-flash#low")).toBeNull();
+  });
+
   it("round-trips through formatRung", () => {
     expect(formatRung(parseRung("claude-code:claude-sonnet-5#max"))).toBe("claude-code:claude-sonnet-5#max");
   });
````

Modify `test/domain/profile.test.ts`:

````diff
@@ -95,6 +95,17 @@ describe("resolveProfile", () => {
     expect(p.billing.cursor).toBe("metered");
   });
 
+  it("gives antigravity a billing mode and a harness toggle, off and metered until the user says (spec 1.3 §3.3)", () => {
+    const p = resolveProfile({ schema: 1 }, "bare");
+    expect(p.billing.antigravity).toBe("metered");
+    expect(p.harness.antigravity).toEqual({ isolated: false });
+    const patch = { billing: { antigravity: "subscription" }, harness: { antigravity: { isolated: true } } };
+    expect(ProfilePatchSchema.parse(patch)).toEqual(patch as never);
+    expect(patchAt("harness.antigravity.isolated", "true")).toEqual({
+      harness: { antigravity: { isolated: true } },
+    });
+  });
+
   it("takes a partial role's missing fields from the built-in one, but not its default rung", () => {
     const p = resolveProfile(
       {
````

- [ ] **Step 2: Run them to see them fail**

Run: `env -u FORCE_COLOR bun test test/domain/catalog.test.ts test/domain/ids.test.ts test/domain/profile.test.ts`
Expected: FAIL: `antigravity` is not a backend: `parseRung` throws and the schemas reject the key.

- [ ] **Step 3: Implement**

Modify `src/domain/catalog.ts`:

````diff
@@ -40,11 +40,20 @@ export const BILLING_KEYS = [
   "opencode",
   "cursor",
   "grok",
+  "antigravity",
 ] as const;
 export type BillingKey = (typeof BILLING_KEYS)[number];
 
 /** The keys a family's `on` map uses; the native `claude` pseudo-backend runs claude-code's model ids. */
-const MODEL_KEYS = ["codex", "claude-code", "opencode-go", "opencode", "cursor", "grok"] as const;
+const MODEL_KEYS = [
+  "codex",
+  "claude-code",
+  "opencode-go",
+  "opencode",
+  "cursor",
+  "grok",
+  "antigravity",
+] as const;
 type ModelKey = (typeof MODEL_KEYS)[number];
 
 export function billingKeyOf(r: Rung): BillingKey {
````

Modify `src/domain/cost.ts`:

````diff
@@ -13,6 +13,7 @@ export const DEFAULT_BILLING: Record<BillingKey, BillingMode> = {
   opencode: "metered",
   cursor: "metered",
   grok: "metered",
+  antigravity: "metered",
 };
 
 /**
````

Modify `src/domain/ids.ts`:

````diff
@@ -11,8 +11,8 @@ export function assertId(kind: string, value: string): string {
   return value;
 }
 
-/** The backends that run as a process through a `BackendAdapter` (cursor and grok: plan 8). */
-export const ADAPTER_IDS = ["codex", "claude-code", "opencode", "cursor", "grok"] as const;
+/** The backends that run as a process through a `BackendAdapter` (spec 1.3: cursor, grok and antigravity). */
+export const ADAPTER_IDS = ["codex", "claude-code", "opencode", "cursor", "grok", "antigravity"] as const;
 
 /** `claude` is the native Claude Code subagent path (no process); the rest are adapters. */
 const RUNG_BACKENDS = [...ADAPTER_IDS, "claude"] as const;
````

Modify `src/entry/tui/profile-tree.ts`:

````diff
@@ -75,7 +75,16 @@ export function withStaged(c: Catalog, staged: Record<string, string>): Catalog
   return { ...c, treatLike };
 }
 
-const GROUP_ORDER = ["claude", "claude-code", "codex", "opencode-go", "opencode", "cursor", "grok"];
+const GROUP_ORDER = [
+  "claude",
+  "claude-code",
+  "codex",
+  "opencode-go",
+  "opencode",
+  "cursor",
+  "grok",
+  "antigravity",
+];
 const GROUP_NOTE: Record<string, string> = { claude: "native subagent", "claude-code": "headless" };
 
 interface ModelEntry {
````

- [ ] **Step 4: Run the tests and the checks**

Run: `env -u FORCE_COLOR bun test test/domain/catalog.test.ts test/domain/ids.test.ts test/domain/profile.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/domain/catalog.ts src/domain/cost.ts src/domain/ids.ts src/entry/tui/profile-tree.ts test/domain/catalog.test.ts test/domain/ids.test.ts test/domain/profile.test.ts
git commit -m "feat(ids): antigravity joins the adapter ids, with its billing, model and harness keys"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 2: Admission refuses to resume a thread under another access when the backend keeps one (spec 1.3 §3.2)

After admission finds the thread's first record (`recordsOnThread`), and before the lane check or `prepare`, a backend that declares `resume.sameAccessOnly` refuses a resume whose role runs another access than the thread started with. Nothing is written first. No shipped adapter declares it yet; the test registers a fake one.

**Files:**

- Modify: `src/services/admission.ts`
- Test: `test/services/adapter-hooks.test.ts`

**Interfaces:**
- Produces: `E_ADMIT_THREAD`: "`<id>` keeps the access a thread started with: `<thread>` ran `<a>`, and the `<role>` role runs `<b>`", fix "dispatch a fresh thread (omit `thread`)".

- [ ] **Step 1: Write the failing tests**

Modify `test/services/adapter-hooks.test.ts`:

````diff
@@ -194,6 +194,49 @@ describe("prepare", () => {
   });
 });
 
+describe("a backend that keeps a thread's access (spec 1.3 §3.2)", () => {
+  const KEEPS = { supported: true, sameAccessOnly: true, threadPattern: /^th-\d+$/ };
+
+  it("refuses to resume a thread under another access before anything runs, and resumes it under the same", async () => {
+    const seen: unknown[] = [];
+    fake({ resume: KEEPS, prepare: async (r) => void seen.push(r) });
+    const { run, deps } = setup();
+    deps.view.roles.reviewer = { enabled: true, access: "read-only", rungs: ["cursor:go-m1#default"] };
+    await appendRecord(
+      run,
+      makeRecord({ dispatchId: "D0", backend: "cursor", rung: "cursor:go-m1#default", thread: "th-7" }),
+    );
+    let err: unknown;
+    await admit(deps, run, input({ role: "reviewer", name: "reviewer-1", thread: "th-7" })).catch(
+      (e: unknown) => (err = e),
+    );
+    expect(isCatherdError(err) && err.toJSON()).toEqual({
+      code: "E_ADMIT_THREAD",
+      message:
+        "cursor keeps the access a thread started with: th-7 ran workspace-write, and the reviewer role runs read-only",
+      fix: "dispatch a fresh thread (omit `thread`)",
+    });
+    expect(seen).toEqual([]);
+    expect(existsSync(roleDir(run, "reviewer-1"))).toBe(false);
+    expect(await refusal(admit(deps, run, input({ thread: "th-7" })))).toBe("admitted");
+    // a thread catherd has no record of is the backend's to refuse
+    expect(await refusal(admit(deps, run, input({ name: "w2", thread: "th-9" })))).toBe("admitted");
+  });
+
+  it("resumes under any access on a backend that applies each run's own flags", async () => {
+    fake();
+    const { run, deps } = setup();
+    deps.view.roles.reviewer = { enabled: true, access: "read-only", rungs: ["cursor:go-m1#default"] };
+    await appendRecord(
+      run,
+      makeRecord({ dispatchId: "D0", backend: "cursor", rung: "cursor:go-m1#default", thread: "th-7" }),
+    );
+    expect(
+      await refusal(admit(deps, run, input({ role: "reviewer", name: "reviewer-1", thread: "th-7" }))),
+    ).toBe("admitted");
+  });
+});
+
 describe("finalize's overlap window", () => {
   it("counts a lane that ended between this dispatch's admission and its worker's start as another's", async () => {
     const { run } = freshRun();
````

- [ ] **Step 2: Run them to see them fail**

Run: `env -u FORCE_COLOR bun test test/services/adapter-hooks.test.ts`
Expected: FAIL: the fake adapter's resume under another access is admitted.

- [ ] **Step 3: Implement**

Modify `src/services/admission.ts`:

````diff
@@ -162,12 +162,19 @@ export async function admit(
     throw new CatherdError("E_ADMIT_THREAD", `"${i.thread}" is not a ${adapter.id} thread id`, {
       fix: "pass the thread from the role's earlier record, or none for a fresh thread",
     });
+  // a resumed thread lives in the home it started in (CODEX_HOME), whatever the profile says now
+  const started = i.thread === null ? undefined : recordsOnThread(run, rung.backend, i.thread).at(-1);
+  // spec 1.3 §3.2: a backend that fixes a thread's access when it starts it refuses another on resume
+  if (started && adapter.resume.sameAccessOnly && started.access !== rc.access)
+    throw new CatherdError(
+      "E_ADMIT_THREAD",
+      `${adapter.id} keeps the access a thread started with: ${i.thread} ran ${started.access}, and the ${i.role} role runs ${rc.access}`,
+      { fix: "dispatch a fresh thread (omit `thread`)" },
+    );
   const owns = i.lane === null ? [] : laneOwns(run, i.lane);
   const id = newDispatchId();
   const dir = join(roleDir(run, i.name), id);
   const p = dispatchPaths(dir);
-  // a resumed thread lives in the home it started in (CODEX_HOME), whatever the profile says now
-  const started = i.thread === null ? undefined : recordsOnThread(run, rung.backend, i.thread).at(-1);
   const isolated = started?.isolated ?? profile.isolated[rung.backend] ?? false;
   await prepared(adapter, { rung, access: rc.access, isolated, repo: run.meta.repo });
   const plan = adapter.plan({
````

- [ ] **Step 4: Run the tests and the checks**

Run: `env -u FORCE_COLOR bun test test/services/adapter-hooks.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/services/admission.ts test/services/adapter-hooks.test.ts
git commit -m "fix(admission): refuse to resume a thread under another access when its backend keeps one"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 3: A CLI the OS cannot execute, and a logged-out one, never reach a dispatch (spec 1.3 §3.3; Rulings 2, 3)

`probeBackend(adapter)` (new, `backends.ts`) wraps `adapter.probe()`: a throw with `ENOEXEC`, `exec format error` or Bun's `posix_spawn '<path>'` form becomes an installed-but-cannot-run probe with `E_BACKEND_CANNOT_RUN` and the adapter's new `install` string as its fix. `readyAdapter` and doctor's backend rows use it; doctor's word is "cannot run". A logged-out backend is refused through its own `E_BACKEND_NOT_LOGGED_IN` problem (Ruling 2). Codex, claude-code and opencode get their `install` strings; the catherd skill lists the new error code.

**Files:**

- Modify: `plugin/skills/catherd/SKILL.md`
- Modify: `src/adapters/backend.ts`
- Modify: `src/adapters/claude-code/index.ts`
- Modify: `src/adapters/codex/index.ts`
- Modify: `src/adapters/opencode/index.ts`
- Modify: `src/domain/errors.ts`
- Modify: `src/services/backends.ts`
- Modify: `src/services/doctor-backends.ts`
- Test: `test/services/adapter-hooks.test.ts`

**Interfaces:**
- Produces: `BackendAdapter.install?: string`; `probeBackend(adapter): Promise<Probe>`; `ErrorCode` `E_BACKEND_CANNOT_RUN`.

- [ ] **Step 1: Write the failing tests**

Modify `test/services/adapter-hooks.test.ts`:

````diff
@@ -2,11 +2,12 @@ import { afterEach, beforeEach, describe, expect, it } from "bun:test";
 import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
 import { join } from "node:path";
 import type { BackendAdapter, Outcome } from "../../src/adapters/backend.ts";
-import { registerAdapter, unregisterAdapter } from "../../src/adapters/registry.ts";
+import { adapterFor, registerAdapter, unregisterAdapter } from "../../src/adapters/registry.ts";
 import { CatherdError, isCatherdError } from "../../src/domain/errors.ts";
 import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
 import { type AdmitInput, admit, prepareLimits } from "../../src/services/admission.ts";
-import { resetReadiness, standInFor } from "../../src/services/backends.ts";
+import { probeBackend, readyAdapter, resetReadiness, standInFor } from "../../src/services/backends.ts";
+import { backendChecks } from "../../src/services/doctor-backends.ts";
 import { roleDir } from "../../src/services/dispatches.ts";
 import {
   claimSeams,
@@ -194,6 +195,91 @@ describe("prepare", () => {
   });
 });
 
+describe("a backend that cannot run or is logged out (spec 1.3 §3.3)", () => {
+  /** What Bun's spawn throws for a binary built for another OS (seen on macOS: a Linux ELF). */
+  const execFormat = (how: "code" | "message") =>
+    how === "code"
+      ? Object.assign(new Error("ENOEXEC: unknown error, posix_spawn '/home/u/.grok/bin/grok'"), {
+          code: "ENOEXEC",
+        })
+      : new Error("spawn /home/u/.grok/bin/grok: exec format error");
+
+  it("reports a CLI the OS cannot execute as installed but unable to run, with the reinstall command", async () => {
+    for (const how of ["code", "message"] as const) {
+      resetReadiness();
+      fake({
+        install: "curl -fsSL https://example.invalid/install.sh | bash",
+        probe: async () => {
+          throw execFormat(how);
+        },
+      });
+      const p = await probeBackend(adapterFor("cursor") as BackendAdapter);
+      expect(p).toEqual({
+        installed: true,
+        version: null,
+        versionOk: false,
+        loggedIn: null,
+        problems: [
+          {
+            code: "E_BACKEND_CANNOT_RUN",
+            message: `cursor is installed but cannot run on this OS: ${how === "code" ? "/home/u/.grok/bin/grok" : "exec format error"}`,
+            fix: "curl -fsSL https://example.invalid/install.sh | bash",
+          },
+        ],
+      });
+      let err: unknown;
+      await readyAdapter("cursor").catch((e: unknown) => (err = e));
+      expect(isCatherdError(err) && err.code).toBe("E_BACKEND_CANNOT_RUN");
+    }
+    // any other failure of a probe is not this one
+    fake({
+      probe: async () => {
+        throw new Error("boom");
+      },
+    });
+    expect(probeBackend(adapterFor("cursor") as BackendAdapter)).rejects.toThrow("boom");
+  });
+
+  it("shows it in doctor's backend row as cannot run, with the reinstall command", async () => {
+    process.env.PATH = "/nonexistent";
+    fake({
+      probe: async () => {
+        throw execFormat("code");
+      },
+    });
+    const rows = await backendChecks(new Map(), []);
+    expect(rows.find((r) => r.id === "backend:cursor")).toMatchObject({
+      state: "skip",
+      word: "cannot run",
+      fix: "reinstall cursor for this OS",
+    });
+  });
+
+  it("refuses a backend whose probe finds it logged out, before anything runs (never a browser login)", async () => {
+    let probed = 0;
+    fake({
+      probe: async () => {
+        probed++;
+        return {
+          installed: true,
+          version: "1.0.0",
+          versionOk: true,
+          loggedIn: false,
+          problems: [
+            { code: "E_BACKEND_NOT_LOGGED_IN", message: "cursor is not logged in", fix: "cursor login" },
+          ],
+        };
+      },
+    });
+    const { run, deps } = setup();
+    expect(await refusal(admit(deps, run, input()))).toBe("E_BACKEND_NOT_LOGGED_IN");
+    expect(existsSync(roleDir(run, "worker-1"))).toBe(false);
+    // a failing probe is never kept: once logged in, the next dispatch goes
+    expect(await refusal(admit(deps, run, input()))).toBe("E_BACKEND_NOT_LOGGED_IN");
+    expect(probed).toBe(2);
+  });
+});
+
 describe("a backend that keeps a thread's access (spec 1.3 §3.2)", () => {
   const KEEPS = { supported: true, sameAccessOnly: true, threadPattern: /^th-\d+$/ };
 
````

- [ ] **Step 2: Run them to see them fail**

Run: `env -u FORCE_COLOR bun test test/services/adapter-hooks.test.ts`
Expected: FAIL: the probe's spawn error propagates as `E_IO_UNEXPECTED` / a thrown error, and the new code does not exist.

- [ ] **Step 3: Implement**

Modify `plugin/skills/catherd/SKILL.md`:

````diff
@@ -65,7 +65,7 @@ The catherd MCP tools ship with this plugin. They appear as `mcp__plugin_catherd
 - `E_ADMIT_DUPLICATE`: that role name is already running. It reports through a catherd message when it finishes; `peek(run, name)` shows it now, and `cancel` stops it.
 - `E_ADMIT_RUNG`: the rung is not on that role's ladder, it is a `claude:` rung, or the profile turns the role off. Use the rung `route` returned; run a `claude:` rung as its agent; skip a role that is off.
 - `E_RUN_BUDGET`: the run's budget is spent (a soft cap: roles already running finish). Pause, report and push.
-- `E_BACKEND_MISSING`, `E_BACKEND_NOT_LOGGED_IN`, `E_BACKEND_TOO_OLD`: tell the user the `fix`, word for word, then pause.
+- `E_BACKEND_MISSING`, `E_BACKEND_NOT_LOGGED_IN`, `E_BACKEND_TOO_OLD`, `E_BACKEND_CANNOT_RUN`: tell the user the `fix`, word for word, then pause.
 - `E_LANE_INVALID`: a lane file's `Kind:` or `Difficulty:` is missing or not one the catalog knows. Fix the header (the `fix` lists the values), or have the architect fix it, then call again.
 - `E_LAND_GATE`: the milestone has no reviewer record or no verifier verdict since its lanes started, it is parked, or its `skip` does not hold. Run what the message names, then land again.
 - `E_CLIMB_DESIGN`: the evidence points at the plan, not the rung. Send it to the architect (an `ask` finding, then an architect delta), not up the ladder.
````

Modify `src/adapters/backend.ts`:

````diff
@@ -110,6 +110,8 @@ export interface Spent {
 export interface BackendAdapter {
   id: AdapterId;
   minVersion: string;
+  /** the command that installs (or reinstalls) the CLI, for a probe problem's fix */
+  install?: string;
   probe(): Promise<Probe>;
   /** The models the backend offers; in `repo` when given, for a backend whose listing depends on it. */
   listModels(repo?: string): Promise<DiscoveredModel[]>;
````

Modify `src/adapters/claude-code/index.ts`:

````diff
@@ -302,6 +302,7 @@ async function probe(): Promise<Probe> {
 export const claudeCodeAdapter: BackendAdapter = {
   id: "claude-code",
   minVersion: CLAUDE_MIN_VERSION,
+  install: "npm i -g @anthropic-ai/claude-code",
   probe,
   listModels: () => listClaudeModels(),
   prepare,
````

Modify `src/adapters/codex/index.ts`:

````diff
@@ -251,6 +251,7 @@ function codexActivity(e: Record<string, any>): string | undefined {
 export const codexAdapter: BackendAdapter = {
   id: "codex",
   minVersion: CODEX_MIN_VERSION,
+  install: "npm i -g @openai/codex",
   probe,
   listModels,
   plan,
````

Modify `src/adapters/opencode/index.ts`:

````diff
@@ -314,6 +314,7 @@ async function probe(): Promise<Probe> {
 export const opencodeAdapter: BackendAdapter = {
   id: "opencode",
   minVersion: OPENCODE_MIN_VERSION,
+  install: OPENCODE_INSTALL,
   probe,
   listModels,
   prepare,
````

Modify `src/domain/errors.ts`:

````diff
@@ -5,6 +5,7 @@ export type ErrorCode =
   | "E_BACKEND_MISSING"
   | "E_BACKEND_TOO_OLD"
   | "E_BACKEND_NOT_LOGGED_IN"
+  | "E_BACKEND_CANNOT_RUN"
   | "E_BACKEND_MODEL_UNKNOWN"
   | "E_RUN_NOT_FOUND"
   | "E_RUN_CORRUPT"
````

Modify `src/services/backends.ts`:

````diff
@@ -10,6 +10,39 @@ const ready = new Map<string, { at: number; probe: Probe }>();
 /** Forget every cached probe (tests, and after the user fixes a backend). */
 export const resetReadiness = (): void => ready.clear();
 
+/** Spec 1.3 §3.3: what Bun's spawn throws for a binary built for another OS (a Linux build on macOS). */
+function execFormatError(e: unknown): string | null {
+  if (!(e instanceof Error)) return null;
+  if ((e as { code?: unknown }).code !== "ENOEXEC" && !/exec format error/i.test(e.message)) return null;
+  return /posix_spawn '([^']+)'/.exec(e.message)?.[1] ?? "exec format error";
+}
+
+/**
+ * The adapter's probe, with a CLI on PATH that the OS cannot execute reported as installed but unable to run
+ * (spec 1.3 §3.3), with the reinstall command; any other failure of the probe is thrown.
+ */
+export async function probeBackend(adapter: BackendAdapter): Promise<Probe> {
+  try {
+    return await adapter.probe();
+  } catch (e) {
+    const why = execFormatError(e);
+    if (why === null) throw e;
+    return {
+      installed: true,
+      version: null,
+      versionOk: false,
+      loggedIn: null,
+      problems: [
+        {
+          code: "E_BACKEND_CANNOT_RUN",
+          message: `${adapter.id} is installed but cannot run on this OS: ${why}`,
+          fix: adapter.install ?? `reinstall ${adapter.id} for this OS`,
+        },
+      ],
+    };
+  }
+}
+
 /**
  * Spec §4.4: the adapter for `backend` once its last probe says it is ready. A ready probe is kept
  * for 10 minutes; a failing one is never kept, so a fixed backend works on the next dispatch.
@@ -23,8 +56,10 @@ export async function readyAdapter(backend: string): Promise<{ adapter: BackendA
     });
   const hit = ready.get(backend);
   if (hit && now - hit.at < READY_TTL_MS) return { adapter, probe: hit.probe };
-  const probe = await adapter.probe();
+  const probe = await probeBackend(adapter);
   const problem = probe.problems[0];
+  // spec 1.3 §3.3: a probe that finds the CLI logged out lists E_BACKEND_NOT_LOGGED_IN, so a dispatch never
+  // reaches it (agy opens a browser and waits); logged out alone is no problem where a CLI runs without a login
   if (problem) throw new CatherdError(problem.code, problem.message, { fix: problem.fix });
   ready.set(backend, { at: now, probe });
   return { adapter, probe };
````

Modify `src/services/doctor-backends.ts`:

````diff
@@ -4,6 +4,7 @@ import "../adapters/all.ts";
 import { ADAPTER_IDS, tryParseRung } from "../domain/ids.ts";
 import type { Profile } from "../domain/profile.ts";
 import { ROLES, type Role } from "../domain/roles.ts";
+import { probeBackend } from "./backends.ts";
 import { refreshDiscovery } from "./catalog-service.ts";
 import { type Check, errText, fixOf } from "./doctor-checks.ts";
 
@@ -30,6 +31,7 @@ const PROBLEM_WORD: Record<string, string> = {
   E_BACKEND_MISSING: "missing",
   E_BACKEND_TOO_OLD: "too old",
   E_BACKEND_NOT_LOGGED_IN: "not logged in",
+  E_BACKEND_CANNOT_RUN: "cannot run",
 };
 
 /**
@@ -91,7 +93,7 @@ export async function backendChecks(
   for (const id of ADAPTER_IDS) {
     const a = adapterFor(id);
     if (!a) continue;
-    const probe: Probe = await a.probe().catch((e: unknown) => ({
+    const probe: Probe = await probeBackend(a).catch((e: unknown) => ({
       installed: false,
       version: null,
       versionOk: false,
````

- [ ] **Step 4: Run the tests and the checks**

Run: `env -u FORCE_COLOR bun test test/services/adapter-hooks.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add plugin/skills/catherd/SKILL.md src/adapters/backend.ts src/adapters/claude-code/index.ts src/adapters/codex/index.ts src/adapters/opencode/index.ts src/domain/errors.ts src/services/backends.ts src/services/doctor-backends.ts test/services/adapter-hooks.test.ts
git commit -m "feat(backends): a CLI the OS cannot execute, and a logged-out one, never reach a dispatch"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 4: Capture passes stdin only when the plan reads it, and captures a resumed thread (spec 1.3 §3.3)

`capture.ts` splits one run into `runOnce(adapter, request, timeoutMs)` (stdin `Bun.file(plan.stdinPath)` only when the plan sets it, else `ignore`) and an exported `captureOne(adapter, version, case, outDir, timeoutMs)`. A case with `resume` runs its first brief, then resumes the first run's thread in the same scratch repo with the second brief and captures that run; the meta file records `resumed` (the thread) and the captured brief.

**Files:**

- Modify: `src/services/capture.ts`
- Test: `test/services/capture.test.ts`

**Interfaces:**
- Produces: `CaptureCase.resume?: string`; `captureOne(...)`; meta `resumed`.

- [ ] **Step 1: Write the failing tests**

Modify `test/services/capture.test.ts`:

````diff
@@ -2,10 +2,11 @@ import { afterEach, beforeEach, describe, expect, it } from "bun:test";
 import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
 import { homedir, tmpdir } from "node:os";
 import { join } from "node:path";
+import type { BackendAdapter } from "../../src/adapters/backend.ts";
 import { opencodeShell } from "../../src/adapters/opencode/index.ts";
 import { formatCaptured } from "../../src/entry/capture-fixtures-command.ts";
 import { resetReadiness } from "../../src/services/backends.ts";
-import { captureFixtures } from "../../src/services/capture.ts";
+import { captureFixtures, captureOne } from "../../src/services/capture.ts";
 import { snapshotEnv, withHome } from "../helpers.ts";
 import { simPath } from "../sim/scenario.ts";
 import { type OpencodeModel, withClaudeScenario, withOpencodeScenario } from "../sim/sim-scenarios.ts";
@@ -128,3 +129,82 @@ describe("capture-fixtures", () => {
     );
   });
 });
+
+/**
+ * A backend whose CLI is `sh`: it saves what it read on stdin to `<seen>/<thread or "new">`, and says which
+ * thread it ran on; `stdin` says whether its plan asks for the brief there.
+ */
+function shellBackend(seen: string, stdin: boolean): BackendAdapter {
+  return {
+    id: "cursor",
+    minVersion: "0.0.0",
+    probe: async () => ({ installed: true, version: "1.0.0", versionOk: true, loggedIn: true, problems: [] }),
+    listModels: async () => [],
+    plan: (r) => ({
+      cmd: "sh",
+      args: ["-c", 'cat > "$1/$2"', "_", seen, r.thread ?? "new"],
+      env: {},
+      cwd: r.repo,
+      stdinPath: stdin ? r.briefPath : null,
+    }),
+    parse: () => ({}),
+    finalize: (run) => ({
+      status: "ok",
+      thread: run.request.thread ?? "th-1",
+      tokens: { input: 0, cached: 0, output: 0 },
+      costUsd: null,
+      images: [],
+      error: null,
+    }),
+    enforcement: { "read-only": "advisory", "workspace-write": "advisory", full: "advisory" },
+    errors: { limit: [], tooOld: [] },
+    resume: { supported: true, sameAccessOnly: false, threadPattern: /^th-\d+$/ },
+    graceAfterFinalMs: null,
+  };
+}
+
+describe("a capture case (spec 1.3 §3.3)", () => {
+  const CASE = { backend: "cursor", name: "ok", rung: "cursor:m#default", access: "read-only" as const };
+
+  it("passes the brief on stdin only to a CLI whose plan asks for it", async () => {
+    withHome();
+    for (const stdin of [true, false]) {
+      const seen = mkdtempSync(join(tmpdir(), "catherd-seen-"));
+      const out = mkdtempSync(join(tmpdir(), "catherd-fixtures-"));
+      const r = await captureOne(
+        shellBackend(seen, stdin),
+        "1.0.0",
+        { ...CASE, brief: "BRIEF" },
+        out,
+        10_000,
+      );
+      expect(r.status).toBe("captured");
+      expect(readFileSync(join(seen, "new"), "utf8")).toBe(stdin ? "BRIEF" : "");
+    }
+  });
+
+  it("captures a resume: a first run in the scratch repo, then its thread resumed there with the second brief", async () => {
+    withHome();
+    const seen = mkdtempSync(join(tmpdir(), "catherd-seen-"));
+    const out = mkdtempSync(join(tmpdir(), "catherd-fixtures-"));
+    const r = await captureOne(
+      shellBackend(seen, true),
+      "1.0.0",
+      { ...CASE, name: "resume", brief: "FIRST", resume: "SECOND" },
+      out,
+      10_000,
+    );
+    expect(r.status).toBe("captured");
+    expect([readFileSync(join(seen, "new"), "utf8"), readFileSync(join(seen, "th-1"), "utf8")]).toEqual([
+      "FIRST",
+      "SECOND",
+    ]);
+    const meta = JSON.parse(readFileSync(join(out, "cursor", "1.0.0", "resume.json"), "utf8"));
+    expect(meta).toMatchObject({
+      case: "resume",
+      brief: "SECOND",
+      resumed: "th-1",
+      outcome: { thread: "th-1" },
+    });
+  });
+});
````

- [ ] **Step 2: Run them to see them fail**

Run: `env -u FORCE_COLOR bun test test/services/capture.test.ts`
Expected: FAIL: `captureOne` is not exported, and every CLI gets the brief on stdin.

- [ ] **Step 3: Implement**

Modify `src/services/capture.ts`:

````diff
@@ -1,7 +1,7 @@
 import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
 import { homedir, tmpdir } from "node:os";
 import { join } from "node:path";
-import type { BackendAdapter, FinishedRun } from "../adapters/backend.ts";
+import type { BackendAdapter, FinishedRun, Outcome, RunRequest } from "../adapters/backend.ts";
 import { isCatherdError } from "../domain/errors.ts";
 import { parseRung } from "../domain/ids.ts";
 import type { Access } from "../domain/record.ts";
@@ -21,6 +21,8 @@ interface CaptureCase {
   rung: string;
   access: Access;
   brief: string;
+  /** a second brief that resumes the first run's thread in the same repo; the resumed run is captured */
+  resume?: string;
 }
 
 const SAY_HELLO =
@@ -79,12 +81,71 @@ function cleanStrings(v: unknown, clean: (s: string) => string): unknown {
   return v;
 }
 
+/** One run as an isolated dispatch would start it (plan, the worker env), without the supervisor. */
+async function runOnce(
+  adapter: BackendAdapter,
+  request: RunRequest,
+  timeoutMs: number,
+): Promise<{ run: FinishedRun; events: string; stderr: string; o: Outcome }> {
+  const plan = adapter.plan(request);
+  const startedAtMs = Date.now();
+  const p = Bun.spawn([plan.cmd, ...plan.args], {
+    cwd: plan.cwd,
+    env: workerEnv(process.env, plan.env, plan.cwd),
+    // spec 1.3 §3.3: the brief goes on stdin only to a CLI whose plan reads it there (grok reads a file)
+    stdin: plan.stdinPath ? Bun.file(plan.stdinPath) : "ignore",
+    stdout: "pipe",
+    stderr: "pipe",
+    // its own group, so a timeout stops whatever the CLI started too, as the supervisor does
+    detached: true,
+  });
+  let timedOut = false;
+  const timer = setTimeout(() => {
+    timedOut = true;
+    killGroup(p.pid, "SIGKILL");
+  }, timeoutMs);
+  // as preflight does: a process the CLI left behind (in its own session) may hold the pipes open
+  const out = collect(p.stdout);
+  const err = collect(p.stderr);
+  const code = await p.exited;
+  clearTimeout(timer);
+  const drained = await Promise.race([
+    Promise.all([out.done, err.done]).then(() => true),
+    Bun.sleep(DRAIN_MS).then(() => false),
+  ]);
+  if (!drained) killGroup(p.pid, "SIGKILL"); // leftovers still in the CLI's group
+  out.stop();
+  err.stop();
+  const events = out.text();
+  const stderr = err.text();
+  const run: FinishedRun = {
+    request,
+    eventLines: events.split("\n").filter((l) => l.trim()),
+    reply: "",
+    stderr,
+    exit: {
+      code: p.signalCode ? null : code,
+      signal: p.signalCode ?? null,
+      reason: timedOut ? "wall-timeout" : "exited",
+      endedAt: new Date().toISOString(),
+    },
+    startedAtMs,
+  };
+  // as a dispatch records it: the backend's own totals and limits, on a fresh thread (nothing prior)
+  const o = await settled(adapter, adapter.finalize(run), run, () => ({
+    tokens: { input: 0, cached: 0, output: 0 },
+    costUsd: 0,
+  }));
+  return { run, events, stderr, o };
+}
+
 /**
  * Runs one case the way an isolated dispatch would (prepare, plan, the worker env), without the
  * supervisor. Isolated, so the stream names none of the owner's own hooks, plugins, MCP servers or config:
- * the fixtures are committed.
+ * the fixtures are committed. A case with `resume` runs its brief, then resumes that thread in the same
+ * scratch repo with `resume`, and captures the resumed run.
  */
-async function captureOne(
+export async function captureOne(
   adapter: BackendAdapter,
   version: string,
   c: CaptureCase,
@@ -97,7 +158,7 @@ async function captureOne(
     writeFileSync(briefPath, c.brief);
     const rung = parseRung(c.rung);
     await adapter.prepare?.({ rung, access: c.access, isolated: true, repo });
-    const request = {
+    const request: RunRequest = {
       rung,
       access: c.access,
       thread: null,
@@ -107,54 +168,20 @@ async function captureOne(
       replyPath: join(work, "reply.md"),
       dispatchDir: work,
     };
-    const plan = adapter.plan(request);
-    const startedAtMs = Date.now();
-    const p = Bun.spawn([plan.cmd, ...plan.args], {
-      cwd: plan.cwd,
-      env: workerEnv(process.env, plan.env, plan.cwd),
-      stdin: Bun.file(briefPath),
-      stdout: "pipe",
-      stderr: "pipe",
-      // its own group, so a timeout stops whatever the CLI started too, as the supervisor does
-      detached: true,
-    });
-    let timedOut = false;
-    const timer = setTimeout(() => {
-      timedOut = true;
-      killGroup(p.pid, "SIGKILL");
-    }, timeoutMs);
-    // as preflight does: a process the CLI left behind (in its own session) may hold the pipes open
-    const out = collect(p.stdout);
-    const err = collect(p.stderr);
-    const code = await p.exited;
-    clearTimeout(timer);
-    const drained = await Promise.race([
-      Promise.all([out.done, err.done]).then(() => true),
-      Bun.sleep(DRAIN_MS).then(() => false),
-    ]);
-    if (!drained) killGroup(p.pid, "SIGKILL"); // leftovers still in the CLI's group
-    out.stop();
-    err.stop();
-    const events = out.text();
-    const stderr = err.text();
-    const run: FinishedRun = {
-      request,
-      eventLines: events.split("\n").filter((l) => l.trim()),
-      reply: "",
-      stderr,
-      exit: {
-        code: p.signalCode ? null : code,
-        signal: p.signalCode ?? null,
-        reason: timedOut ? "wall-timeout" : "exited",
-        endedAt: new Date().toISOString(),
-      },
-      startedAtMs,
-    };
-    // as a dispatch records it: the backend's own totals and limits, on a fresh thread (nothing prior)
-    const o = await settled(adapter, adapter.finalize(run), run, () => ({
-      tokens: { input: 0, cached: 0, output: 0 },
-      costUsd: 0,
-    }));
+    let captured = await runOnce(adapter, request, timeoutMs);
+    const resumed = c.resume === undefined ? null : captured.o.thread;
+    if (c.resume !== undefined) {
+      if (!resumed)
+        return {
+          backend: c.backend,
+          name: c.name,
+          status: "skipped",
+          reason: `the first run left no thread to resume (${captured.o.error?.message ?? captured.o.status})`,
+        };
+      writeFileSync(briefPath, c.resume);
+      captured = await runOnce(adapter, { ...request, thread: resumed }, timeoutMs);
+    }
+    const { run, events, stderr, o } = captured;
     const scrub: Scrub = {
       secrets: secretEnvValues(process.env),
       paths: [
@@ -180,7 +207,8 @@ async function captureOne(
           rung: c.rung,
           access: c.access,
           isolated: true,
-          brief: c.brief,
+          brief: c.resume ?? c.brief,
+          ...(resumed ? { resumed } : {}),
           exitCode: run.exit.code,
           reason: run.exit.reason,
           capturedAt: new Date().toISOString(),
````

- [ ] **Step 4: Run the tests and the checks**

Run: `env -u FORCE_COLOR bun test test/services/capture.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/services/capture.ts test/services/capture.test.ts
git commit -m "feat(capture): stdin only when the plan reads it, and a case that captures a resumed thread"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 5: An isolated worker whose HOME moves keeps catherd's dirs and the user's caches (Ruling 6)

`movedHomeEnv(home, env?, realHome?)` (new, `access.ts`) is the env for a worker whose HOME is catherd's: `HOME`, `CATHERD_CONFIG_DIR`, `CATHERD_DATA_DIR`, `GOPATH` and the toolchain cache vars (`cacheVars`, now shared with `toolchainCaches`) pointed at the user's real ones. `paths.ts` reads `CATHERD_DATA_DIR` for `root("data")`, as it reads `CATHERD_CONFIG_DIR`.

**Files:**

- Modify: `src/adapters/access.ts`
- Modify: `src/infra/paths.ts`
- Test: `test/adapters/access.test.ts`
- Test: `test/infra/paths.test.ts`

**Interfaces:**
- Produces: `cacheVars(env, home)`, `movedHomeEnv(home, env = process.env, realHome = env.HOME || homedir())`; `dataDir()` honours `CATHERD_DATA_DIR`.

- [ ] **Step 1: Write the failing tests**

Modify `test/adapters/access.test.ts`:

````diff
@@ -5,6 +5,7 @@ import { tmpdir } from "node:os";
 import {
   dockerSocket,
   dockerSocketCandidates,
+  movedHomeEnv,
   realTmpdir,
   toolchainCaches,
   writableRoots,
@@ -14,7 +15,7 @@ import { claudeCodeAdapter, claudeSandboxOn } from "../../src/adapters/claude-co
 import { codexAdapter } from "../../src/adapters/codex/index.ts";
 import { parseRung } from "../../src/domain/ids.ts";
 import { applyPatch, defaultProfileDoc, patchAt, resolveProfile } from "../../src/domain/profile.ts";
-import { locksDir } from "../../src/infra/paths.ts";
+import { configDir, dataDir, locksDir } from "../../src/infra/paths.ts";
 import { admit } from "../../src/services/admission.ts";
 import { resetReadiness } from "../../src/services/backends.ts";
 import { snapshotEnv, tempDir, withHome } from "../helpers.ts";
@@ -69,6 +70,28 @@ describe("worker access grants (spec §5)", () => {
     expect(writableRoots()).toContain(realpathSync(gocache));
   });
 
+  it("moves an isolated worker's HOME, keeping catherd's own dirs and the user's toolchain caches (spec 1.3 §4.4)", () => {
+    withHome();
+    const mac = process.platform === "darwin";
+    const env = movedHomeEnv("/iso/home", { HOME: "/u", GOPATH: "/u/gp:/u/gp2" }, "/u");
+    expect(env).toEqual({
+      HOME: "/iso/home",
+      CATHERD_CONFIG_DIR: configDir(),
+      CATHERD_DATA_DIR: dataDir(),
+      GOPATH: "/u/gp:/u/gp2",
+      GOCACHE: mac ? "/u/Library/Caches/go-build" : "/u/.cache/go-build",
+      GOMODCACHE: "/u/gp/pkg/mod",
+      npm_config_store_dir: mac ? "/u/Library/pnpm/store" : "/u/.local/share/pnpm/store",
+      BUN_INSTALL_CACHE_DIR: "/u/.bun/install/cache",
+      npm_config_cache: "/u/.npm",
+    });
+    // a worker that runs `catherd lock` under that env takes the lock dir catherd itself uses
+    const locks = locksDir();
+    delete process.env.CATHERD_HOME;
+    Object.assign(process.env, env);
+    expect(locksDir()).toBe(locks);
+  });
+
   it("finds the Docker socket DOCKER_HOST names", () => {
     process.env.DOCKER_HOST = "unix:///tmp/some/docker.sock";
     expect(dockerSocket()).toBe("/tmp/some/docker.sock");
````

Modify `test/infra/paths.test.ts`:

````diff
@@ -1,6 +1,6 @@
 import { afterEach, describe, expect, it } from "bun:test";
 import { join } from "node:path";
-import { configDir, dataDir, repoKey, runsDir } from "../../src/infra/paths.ts";
+import { configDir, dataDir, locksDir, repoKey, runsDir } from "../../src/infra/paths.ts";
 import { snapshotEnv, withHome } from "../helpers.ts";
 
 afterEach(snapshotEnv());
@@ -18,4 +18,13 @@ describe("paths", () => {
     withHome();
     expect(runsDir("/x/y")).toBe(join(dataDir(), "repos", repoKey("/x/y"), "runs"));
   });
+
+  it("keeps catherd's own dirs for a worker whose HOME moved, from CATHERD_CONFIG_DIR and CATHERD_DATA_DIR", () => {
+    withHome();
+    delete process.env.CATHERD_HOME;
+    process.env.HOME = "/elsewhere";
+    process.env.CATHERD_CONFIG_DIR = "/c";
+    process.env.CATHERD_DATA_DIR = "/d";
+    expect([configDir(), dataDir(), locksDir()]).toEqual(["/c", "/d", join("/d", "locks")]);
+  });
 });
````

- [ ] **Step 2: Run them to see them fail**

Run: `env -u FORCE_COLOR bun test test/adapters/access.test.ts test/infra/paths.test.ts`
Expected: FAIL: `movedHomeEnv` does not exist and `CATHERD_DATA_DIR` is ignored.

- [ ] **Step 3: Implement**

Modify `src/adapters/access.ts`:

````diff
@@ -1,7 +1,7 @@
 import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
 import { homedir, tmpdir } from "node:os";
 import { join } from "node:path";
-import { locksDir } from "../infra/paths.ts";
+import { configDir, dataDir, locksDir } from "../infra/paths.ts";
 import type { AccessShell } from "./backend.ts";
 import { runCli } from "./cli.ts";
 
@@ -63,6 +63,23 @@ const effectiveCaches = (query: ToolQuery): string[] =>
     ? (asked ??= [...query("go", ["env", "GOCACHE", "GOMODCACHE"]), ...query("pnpm", ["store", "path"])])
     : [...query("go", ["env", "GOCACHE", "GOMODCACHE"]), ...query("pnpm", ["store", "path"])];
 
+/** Each toolchain cache's env variable and its value: the env's, else the tool's default under `home`. */
+function cacheVars(env: Record<string, string | undefined>, home: string): Record<string, string> {
+  const mac = process.platform === "darwin";
+  const cache = env.XDG_CACHE_HOME || join(home, ".cache");
+  const data = env.XDG_DATA_HOME || join(home, ".local", "share");
+  const gopath = (env.GOPATH || join(home, "go")).split(":")[0] as string;
+  return {
+    GOCACHE: env.GOCACHE || (mac ? join(home, "Library", "Caches", "go-build") : join(cache, "go-build")),
+    GOMODCACHE: env.GOMODCACHE || join(gopath, "pkg", "mod"),
+    npm_config_store_dir:
+      env.npm_config_store_dir ||
+      (mac ? join(home, "Library", "pnpm", "store") : join(data, "pnpm", "store")),
+    BUN_INSTALL_CACHE_DIR: env.BUN_INSTALL_CACHE_DIR || join(home, ".bun", "install", "cache"),
+    npm_config_cache: env.npm_config_cache || join(home, ".npm"),
+  };
+}
+
 /**
  * The toolchain caches a worker's checks write, where they exist: Go's build and module caches and the pnpm store
  * (as the tools themselves report them, else their defaults), Bun's install cache and npm's cache. Without them a
@@ -73,21 +90,31 @@ export function toolchainCaches(
   home = env.HOME || homedir(),
   query: ToolQuery = queryTool,
 ): string[] {
-  const mac = process.platform === "darwin";
-  const cache = env.XDG_CACHE_HOME || join(home, ".cache");
-  const data = env.XDG_DATA_HOME || join(home, ".local", "share");
-  const gopath = (env.GOPATH || join(home, "go")).split(":")[0] as string;
-  const paths = [
-    ...effectiveCaches(query),
-    env.GOCACHE || (mac ? join(home, "Library", "Caches", "go-build") : join(cache, "go-build")),
-    env.GOMODCACHE || join(gopath, "pkg", "mod"),
-    env.npm_config_store_dir || (mac ? join(home, "Library", "pnpm", "store") : join(data, "pnpm", "store")),
-    env.BUN_INSTALL_CACHE_DIR || join(home, ".bun", "install", "cache"),
-    env.npm_config_cache || join(home, ".npm"),
-  ];
+  const paths = [...effectiveCaches(query), ...Object.values(cacheVars(env, home))];
   return [...new Set(paths.filter((p) => existsSync(p)).map(realOr))];
 }
 
+/**
+ * Spec 1.3 §4.4: the env of an isolated worker whose CLI is isolated by a HOME of catherd's (Cursor reads
+ * `~/.claude` whatever its own config dir says). catherd's own config and data stay put, so a `catherd lock`
+ * in the worker takes the same lock dir, and so do the toolchain caches `writableRoots` grants, which would
+ * otherwise start cold under the new HOME, where no sandbox lets the worker write.
+ * ponytail: only these caches follow; other dotfiles (~/.npmrc, ~/.gitconfig, ~/.cargo) stay behind.
+ */
+export function movedHomeEnv(
+  home: string,
+  env: Record<string, string | undefined> = process.env,
+  realHome = env.HOME || homedir(),
+): Record<string, string> {
+  return {
+    HOME: home,
+    CATHERD_CONFIG_DIR: configDir(),
+    CATHERD_DATA_DIR: dataDir(),
+    GOPATH: env.GOPATH || join(realHome, "go"),
+    ...cacheVars(env, realHome),
+  };
+}
+
 /**
  * The directories a workspace-write worker writes besides the repo: the heavy-lock dir, the temp dir and the
  * toolchain caches that exist, real paths.
````

Modify `src/infra/paths.ts`:

````diff
@@ -2,8 +2,10 @@ import { homedir } from "node:os";
 import { join } from "node:path";
 
 function root(kind: "config" | "data"): string {
-  // set for an isolated worker whose XDG_CONFIG_HOME points elsewhere, so its `catherd lock` reads this config
+  // set for an isolated worker whose XDG_CONFIG_HOME or HOME points elsewhere, so its `catherd lock` reads
+  // this config and takes this lock dir
   if (kind === "config" && process.env.CATHERD_CONFIG_DIR) return process.env.CATHERD_CONFIG_DIR;
+  if (kind === "data" && process.env.CATHERD_DATA_DIR) return process.env.CATHERD_DATA_DIR;
   const home = process.env.CATHERD_HOME;
   if (home) return join(home, kind);
   if (kind === "config") return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "catherd");
````

- [ ] **Step 4: Run the tests and the checks**

Run: `env -u FORCE_COLOR bun test test/adapters/access.test.ts test/infra/paths.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/access.ts src/infra/paths.ts test/adapters/access.test.ts test/infra/paths.test.ts
git commit -m "feat(access): an isolated worker whose HOME moves keeps catherd's dirs and the user's caches"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 6: Doctor's access row: not tested where no sandbox runner exists, and a sandbox's own fixes (spec 1.3 §3.4; Ruling 15)

A backend without `accessShell` gets an `access:<id>` row `skip` / `not tested` naming the live kit, instead of no row. `AccessShell.fixes` (new, optional) lets a sandbox give its own fix per probe; `fixFor` reads it first. `AccessProbeId` names the five probes.

**Files:**

- Modify: `src/adapters/backend.ts`
- Modify: `src/services/doctor-access.ts`
- Test: `test/services/adapter-hooks.test.ts`

**Interfaces:**
- Produces: `AccessProbeId`; `AccessShell.fixes?: Partial<Record<AccessProbeId, string>>`.

- [ ] **Step 1: Write the failing tests**

Modify `test/services/adapter-hooks.test.ts`:

````diff
@@ -7,7 +7,10 @@ import { CatherdError, isCatherdError } from "../../src/domain/errors.ts";
 import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
 import { type AdmitInput, admit, prepareLimits } from "../../src/services/admission.ts";
 import { probeBackend, readyAdapter, resetReadiness, standInFor } from "../../src/services/backends.ts";
+import { accessChecks } from "../../src/services/doctor-access.ts";
 import { backendChecks } from "../../src/services/doctor-backends.ts";
+import { resolveProfile } from "../../src/domain/profile.ts";
+import { locksDir } from "../../src/infra/paths.ts";
 import { roleDir } from "../../src/services/dispatches.ts";
 import {
   claimSeams,
@@ -15,7 +18,7 @@ import {
   settleLimits,
   takeOverStaleClaim,
 } from "../../src/services/finalize.ts";
-import { snapshotEnv, tempRepo } from "../helpers.ts";
+import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
 import { appendRecord, createRun, readRecords } from "../../src/services/run-store.ts";
 import { gitLimits } from "../../src/infra/git.ts";
 import { processStartTime } from "../../src/infra/proc.ts";
@@ -280,6 +283,49 @@ describe("a backend that cannot run or is logged out (spec 1.3 §3.3)", () => {
   });
 });
 
+describe("doctor's access probes on a new backend (spec 1.3 §3.4)", () => {
+  const onIt = [resolveProfile({ schema: 1, roles: { worker: { rungs: ["cursor:go-m1#default"] } } }, "p")];
+
+  it("says a backend with no sandbox runner is not tested, and why, without spending a model turn", async () => {
+    fake();
+    const rows = await accessChecks(onIt, new Set(["cursor"]));
+    expect(rows.filter((r) => r.id === "access:cursor")).toEqual([
+      {
+        id: "access:cursor",
+        label: "cursor worker access",
+        state: "skip",
+        word: "not tested",
+        detail:
+          "no way to run a shell in cursor's sandbox without a model turn; the live kit (docs/dev/live-verification.md) runs the five probes as one worker turn",
+      },
+    ]);
+  });
+
+  it("gives a failed probe the sandbox's own fix when its shell names one", async () => {
+    withHome();
+    process.env.CATHERD_PROBE_DOCKER = "catherd-no-docker-here";
+    fake({
+      accessShell: async () => ({
+        how: "cursor's sandbox",
+        run: async (_script, args) =>
+          args[0] === locksDir()
+            ? { ok: false, out: "", err: "touch: Operation not permitted" }
+            : { ok: true, out: "", err: "" },
+        close: () => {},
+        fixes: { lock: "add it to additionalReadwritePaths in ~/.cursor/sandbox.json" },
+      }),
+    });
+    const row = (await accessChecks(onIt, new Set(["cursor"]))).find((r) => r.id === "access:cursor");
+    expect(row).toMatchObject({
+      id: "access:cursor",
+      state: "warn",
+      word: "blocked",
+      detail: "in cursor's sandbox, a worker cannot: lock-dir write (touch: Operation not permitted)",
+      fix: "lock-dir write: add it to additionalReadwritePaths in ~/.cursor/sandbox.json",
+    });
+  });
+});
+
 describe("a backend that keeps a thread's access (spec 1.3 §3.2)", () => {
   const KEEPS = { supported: true, sameAccessOnly: true, threadPattern: /^th-\d+$/ };
 
````

- [ ] **Step 2: Run them to see them fail**

Run: `env -u FORCE_COLOR bun test test/services/adapter-hooks.test.ts`
Expected: FAIL: no row for a backend without a runner; the generic fix is printed.

- [ ] **Step 3: Implement**

Modify `src/adapters/backend.ts`:

````diff
@@ -18,12 +18,17 @@ export interface Probe {
   problems: { code: ErrorCode; message: string; fix: string }[];
 }
 
+/** Doctor's five access probes (spec 1.1 §5). */
+export type AccessProbeId = "lock" | "temp" | "loopback" | "https" | "docker";
+
 /** A worker's shell for doctor's probes: `run` is `sh -c <script> _ <args…>`; `close` removes its scratch dir. */
 export interface AccessShell {
   /** how it runs, for the doctor rows: "codex sandbox", "an unsandboxed shell" */
   how: string;
   run(script: string, args: string[]): Promise<CliResult | null>;
   close(): void;
+  /** how to grant what this sandbox refused, per probe, when the backend's own config grants it */
+  fixes?: Partial<Record<AccessProbeId, string>>;
 }
 
 export interface DiscoveredModel {
@@ -139,6 +144,7 @@ export interface BackendAdapter {
   /**
    * Spec §5 and §12: a shell that runs a command the way this backend's workspace-write worker runs one,
    * with the grants the worker gets, for doctor's access probes; a string says why it cannot be tested here.
+   * Absent: the CLI has no way to run a shell in its sandbox without a model turn (spec 1.3 §3.4).
    */
   accessShell?(o: { network: boolean }): Promise<AccessShell | string>;
   /** Spec §10.3: why this backend's isolation is weak; doctor warns when a profile uses it. */
````

Modify `src/services/doctor-access.ts`:

````diff
@@ -1,5 +1,5 @@
 import { realTmpdir } from "../adapters/access.ts";
-import type { AccessShell } from "../adapters/backend.ts";
+import type { AccessProbeId, AccessShell } from "../adapters/backend.ts";
 import { adapterFor } from "../adapters/registry.ts";
 import "../adapters/all.ts";
 import { tryParseRung } from "../domain/ids.ts";
@@ -12,7 +12,7 @@ import type { Check } from "./doctor-checks.ts";
 // Spec §5 and §12: the five access probes doctor runs per backend that serves a workspace-write role, each
 // in that backend's worker shell with the grants a worker gets, and the rows that report them.
 
-export type ProbeId = "lock" | "temp" | "loopback" | "https" | "docker";
+export type ProbeId = AccessProbeId;
 
 /**
  * What the probes reach: npm's ping, through HTTPS_PROXY when it is set (Bun's fetch honours it), and
@@ -131,8 +131,13 @@ export async function runProbes(shell: AccessShell, network: boolean): Promise<P
   return out;
 }
 
-/** The fix for a failed probe, per backend: Codex's sandbox holds catherd's grants; the others run unsandboxed. */
-function fixFor(backend: string, id: ProbeId): string {
+/**
+ * The fix for a failed probe: the sandbox's own when its shell names one; Codex's sandbox holds catherd's grants;
+ * the others run unsandboxed.
+ */
+function fixFor(backend: string, id: ProbeId, shell: AccessShell): string {
+  const own = shell.fixes?.[id];
+  if (own) return own;
   if (backend === "codex") {
     const override =
       "catherd passes this grant to Codex itself (with your top-level [sandbox_workspace_write] writable_roots added): check that no --profile or managed requirements.toml overrides it";
@@ -173,7 +178,7 @@ export async function accessChecks(profiles: Profile[], installed: ReadonlySet<s
   const checks: Check[] = [];
   for (const [id, network] of workspaceWriteNetwork(profiles)) {
     const a = adapterFor(id);
-    if (!a?.accessShell) continue;
+    if (!a) continue;
     if (!installed.has(id)) {
       checks.push({
         id: `access:${id}`,
@@ -184,7 +189,9 @@ export async function accessChecks(profiles: Profile[], installed: ReadonlySet<s
       });
       continue;
     }
-    const shell = await a.accessShell({ network }).catch((e: unknown) => String(e));
+    const shell = a.accessShell
+      ? await a.accessShell({ network }).catch((e: unknown) => String(e))
+      : `no way to run a shell in ${id}'s sandbox without a model turn; the live kit (docs/dev/live-verification.md) runs the five probes as one worker turn`;
     if (id === "codex")
       checks.push(
         typeof shell === "string"
@@ -217,7 +224,7 @@ export async function accessChecks(profiles: Profile[], installed: ReadonlySet<s
             state: "warn",
             word: "blocked",
             detail: `in ${shell.how}, a worker cannot: ${failed.map((r) => `${r.label} (${r.why})`).join("; ")}`,
-            fix: failed.map((r) => `${r.label}: ${fixFor(id, r.id)}`).join("\n"),
+            fix: failed.map((r) => `${r.label}: ${fixFor(id, r.id, shell)}`).join("\n"),
           }
         : {
             ...base,
````

- [ ] **Step 4: Run the tests and the checks**

Run: `env -u FORCE_COLOR bun test test/services/adapter-hooks.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/backend.ts src/services/doctor-access.ts test/services/adapter-hooks.test.ts
git commit -m "feat(doctor): access not tested where no sandbox runner exists, and a sandbox's own fixes"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 7: An isolated backend needs its API key, and the harness row says so (spec 1.3 §8, §9 Q6; Ruling 14)

`BackendAdapter.isolationKey` names the env var an isolated run needs. `validateHere(p, catalog, doc?)` (`profile-store.ts`) adds `isolationKeyErrors` (catherd's own env) to `validateProfile`; `validateNamed`, `ProfileService.validate` and the TUI's validate use it, so `patchProfile` refuses `harness.<id>.isolated true` without the key. The TUI's `Effects.isolation(h)` returns the adapter's note and key; the isolated row's about line adds "(it needs KEY)" and the note (`isolationAbout`).

**Files:**

- Modify: `src/adapters/backend.ts`
- Modify: `src/entry/tui/effects.ts`
- Modify: `src/entry/tui/fixtures.ts`
- Modify: `src/entry/tui/views/profiles.tsx`
- Modify: `src/services/profile-service.ts`
- Modify: `src/services/profile-store.ts`
- Test: `test/entry/tui/profiles.test.tsx`
- Test: `test/services/adapter-hooks.test.ts`

**Interfaces:**
- Produces: `BackendAdapter.isolationKey?: string`; `isolationKeyErrors(p, env)`, `validateHere(p, c, doc?)`; `Effects.isolation(h): { note?: string; key?: string }`; `isolationAbout(i)`.

- [ ] **Step 1: Write the failing tests**

Modify `test/entry/tui/profiles.test.tsx`:

````diff
@@ -11,7 +11,7 @@ import {
   openRevert,
   useProfileDialogs,
 } from "../../../src/entry/tui/views/profile-actions.ts";
-import { ProfilesView } from "../../../src/entry/tui/views/profiles.tsx";
+import { isolationAbout, ProfilesView } from "../../../src/entry/tui/views/profiles.tsx";
 import { writeDiscovery } from "../../../src/adapters/discovery.ts";
 import { saveTreatLike } from "../../../src/services/catalog-service.ts";
 import { snapshotEnv, withHome } from "../../helpers.ts";
@@ -800,3 +800,12 @@ describe("keys that land in one tick (Review Focus 2)", () => {
     expect(fx.writes).toEqual(["create cheap"]);
   });
 });
+
+describe("the harness row's line (spec 1.3 §8)", () => {
+  it("names the API key isolation needs and what the native mode loads, when the backend says", () => {
+    expect(isolationAbout({})).toBe("space runs the backend with catherd's own config instead of yours");
+    expect(isolationAbout({ note: "native X loads your Y", key: "X_API_KEY" })).toBe(
+      "space runs the backend with catherd's own config instead of yours (it needs X_API_KEY); native X loads your Y",
+    );
+  });
+});
````

Modify `test/services/adapter-hooks.test.ts`:

````diff
@@ -10,6 +10,8 @@ import { probeBackend, readyAdapter, resetReadiness, standInFor } from "../../sr
 import { accessChecks } from "../../src/services/doctor-access.ts";
 import { backendChecks } from "../../src/services/doctor-backends.ts";
 import { resolveProfile } from "../../src/domain/profile.ts";
+import { patchProfile } from "../../src/services/profile-service.ts";
+import { isolationKeyErrors } from "../../src/services/profile-store.ts";
 import { locksDir } from "../../src/infra/paths.ts";
 import { roleDir } from "../../src/services/dispatches.ts";
 import {
@@ -326,6 +328,36 @@ describe("doctor's access probes on a new backend (spec 1.3 §3.4)", () => {
   });
 });
 
+describe("an isolated backend's API key (spec 1.3 §8)", () => {
+  const isolated = resolveProfile({ schema: 1, harness: { cursor: { isolated: true } } }, "p");
+  const MISSING = {
+    path: "harness.cursor.isolated",
+    message: "an isolated cursor run needs CURSOR_API_KEY, which catherd's environment does not have",
+    fix: "export CURSOR_API_KEY=<key>, or catherd profile set harness.cursor.isolated false",
+  };
+
+  it("is an error while an isolated backend's key is not set, and nothing once it is or while native", () => {
+    fake({ isolationKey: "CURSOR_API_KEY" });
+    expect(isolationKeyErrors(isolated, {})).toEqual([MISSING]);
+    expect(isolationKeyErrors(isolated, { CURSOR_API_KEY: "k" })).toEqual([]);
+    expect(isolationKeyErrors(resolveProfile({ schema: 1 }, "p"), {})).toEqual([]);
+    // a backend that isolates without a key of its own
+    fake();
+    expect(isolationKeyErrors(isolated, {})).toEqual([]);
+  });
+
+  it("refuses a save that isolates the backend with no key, naming the export", () => {
+    withHome();
+    fake({ isolationKey: "CURSOR_API_KEY" });
+    delete process.env.CURSOR_API_KEY;
+    const r = patchProfile("default", { harness: { cursor: { isolated: true } } });
+    expect(r.saved).toBe(false);
+    expect(r.errors).toContainEqual(MISSING);
+    process.env.CURSOR_API_KEY = "key-for-test";
+    expect(patchProfile("default", { harness: { cursor: { isolated: true } } }).saved).toBe(true);
+  });
+});
+
 describe("a backend that keeps a thread's access (spec 1.3 §3.2)", () => {
   const KEEPS = { supported: true, sameAccessOnly: true, threadPattern: /^th-\d+$/ };
 
````

- [ ] **Step 2: Run them to see them fail**

Run: `env -u FORCE_COLOR bun test test/entry/tui/profiles.test.tsx test/services/adapter-hooks.test.ts`
Expected: FAIL: `validateHere` and `isolationAbout` do not exist; the isolated save goes through.

- [ ] **Step 3: Implement**

Modify `src/adapters/backend.ts`:

````diff
@@ -149,6 +149,11 @@ export interface BackendAdapter {
   accessShell?(o: { network: boolean }): Promise<AccessShell | string>;
   /** Spec §10.3: why this backend's isolation is weak; doctor warns when a profile uses it. */
   isolationNote?: string;
+  /**
+   * Spec 1.3 §8: the env variable an isolated run logs in with, when isolation moves the CLI's home away from
+   * the user's login (`CURSOR_API_KEY`); an isolated profile without it does not validate.
+   */
+  isolationKey?: string;
   graceAfterFinalMs: number | null;
 }
 
````

Modify `src/entry/tui/effects.ts`:

````diff
@@ -4,7 +4,7 @@ import "../../adapters/all.ts";
 import { agentFiles } from "../../domain/agents.ts";
 import { type Catalog, rungInfo } from "../../domain/catalog.ts";
 import { HARNESS_KEYS, type Profile, type ProfileDoc, type ProfilePatch } from "../../domain/profile.ts";
-import { type Validation, validateProfile } from "../../domain/profile-rules.ts";
+import type { Validation } from "../../domain/profile-rules.ts";
 import type { Access } from "../../domain/record.ts";
 import { VERSION } from "../../infra/version.ts";
 import {
@@ -39,7 +39,7 @@ import {
   projectsFile,
   readProfileDoc,
   readProjects,
-  runnableBackends,
+  validateHere,
 } from "../../services/profile-store.ts";
 import { listRuns, type Run, runPaths } from "../../services/run-store.ts";
 import {
@@ -121,6 +121,8 @@ export interface Effects {
   enforcement(rung: string, access: Access): "enforced" | "advisory";
   /** the harnesses a profile can isolate */
   harnesses: readonly string[];
+  /** spec 1.3 §8: what a harness's native mode loads, and the API key its isolation needs, when it says */
+  isolation(harness: string): { note?: string; key?: string };
   /** the native agents a profile links, by name */
   agents(p: Profile): string[];
   /**
@@ -341,9 +343,16 @@ export function liveEffects(repo: string | null = null): Effects {
         models: catalogQuery({ scoredOnly: false, limit: Number.MAX_SAFE_INTEGER }, billing).models,
       };
     },
-    validate: (p, c) => validateProfile(p, c, runnableBackends()),
+    validate: (p, c) => validateHere(p, c),
     enforcement: enforcementOf,
     harnesses,
+    isolation(h) {
+      const a = adapterFor(h);
+      return {
+        ...(a?.isolationNote ? { note: a.isolationNote } : {}),
+        ...(a?.isolationKey ? { key: a.isolationKey } : {}),
+      };
+    },
     agents: (p) => agentFiles(p, VERSION).map((f) => f.name),
     async save(name, patch, treatLikes, shown) {
       for (const [rung, like] of Object.entries(treatLikes)) await saveTreatLike(rung, like);
````

Modify `src/entry/tui/fixtures.ts`:

````diff
@@ -523,6 +523,7 @@ export function fixtureEffects(o: FixtureOptions = {}): Effects & {
     validate: (p, c) => validateProfile(p, c, BACKENDS),
     enforcement: (rung) => (rung.startsWith("codex:") ? "enforced" : "advisory"),
     harnesses: ["codex", "claude-code", "opencode"],
+    isolation: () => ({}),
     agents: (p) =>
       (["architect", "verifier"] as const)
         .filter((r) => p.roles[r].enabled)
````

Modify `src/entry/tui/views/profiles.tsx`:

````diff
@@ -41,6 +41,10 @@ const ABOUT: Partial<Record<RowAction["type"], string>> = {
   notify: "space turns this notification on or off",
 };
 
+/** Spec 1.3 §8: a harness row's line: what isolating it needs, and what its native mode loads. */
+export const isolationAbout = (i: { note?: string; key?: string }): string =>
+  [`${ABOUT.isolated}${i.key ? ` (it needs ${i.key})` : ""}`, i.note].filter(Boolean).join("; ");
+
 /**
  * The profiles poll failed after a good read (its error is newer than the value it keeps): one error line
  * and, when the failure says, its fix; none once a read succeeds again.
@@ -411,7 +415,16 @@ export function ProfilesView(props: { width: number; height: number }) {
         },
         ...(row.issue.fix ? [{ text: ` fix: ${row.issue.fix}`, tone: "muted" as const }] : []),
       ]
-    : [{ text: ` ${(row && ABOUT[row.action.type]) ?? ""}`, tone: "muted" as const }];
+    : [
+        {
+          text: ` ${
+            row?.action.type === "isolated"
+              ? isolationAbout(app.effects.isolation(row.action.harness))
+              : ((row && ABOUT[row.action.type]) ?? "")
+          }`,
+          tone: "muted" as const,
+        },
+      ];
   const aboutLines = about
     .flatMap((p) => wrap(p.text, props.width).map((text) => ({ ...p, text })))
     .slice(0, 2);
````

Modify `src/services/profile-service.ts`:

````diff
@@ -15,7 +15,7 @@ import {
   type ProfilePatch,
   resolveProfile,
 } from "../domain/profile.ts";
-import { repairs, type Validation, validateProfile } from "../domain/profile-rules.ts";
+import { repairs, type Validation } from "../domain/profile-rules.ts";
 import { ROLES } from "../domain/roles.ts";
 import { withFileLockSync } from "../infra/filelock.ts";
 import { configDir } from "../infra/paths.ts";
@@ -37,7 +37,7 @@ import {
   readProjects,
   requireProfile,
   roleEnforcement,
-  runnableBackends,
+  validateHere,
   validateNamed,
 } from "./profile-store.ts";
 
@@ -67,7 +67,7 @@ function saveAndLink(name: string, doc: ProfileDoc): Synced {
 }
 
 const validate = (doc: ProfileDoc, name: string): Validation =>
-  validateProfile(resolveProfile(doc, name), loadCatalog({ timings: false }), runnableBackends(), doc);
+  validateHere(resolveProfile(doc, name), loadCatalog({ timings: false }), doc);
 
 /** What a save returns: the port's ProfileSaved (one type for the CLI, the TUI and the MCP tools). */
 export type Saved = ProfileSaved;
````

Modify `src/services/profile-store.ts`:

````diff
@@ -14,7 +14,8 @@ import {
   ProfileDocSchema,
   resolveProfile,
 } from "../domain/profile.ts";
-import { type Validation, validateProfile } from "../domain/profile-rules.ts";
+import { type Issue, type Validation, validateProfile } from "../domain/profile-rules.ts";
+import type { Catalog } from "../domain/catalog.ts";
 import type { Access } from "../domain/record.ts";
 import { ROLES, type Role } from "../domain/roles.ts";
 import { configDir } from "../infra/paths.ts";
@@ -116,12 +117,39 @@ export const runnableBackends = (): string[] => ["claude", ...ADAPTER_IDS.filter
 export const keyRunnable = (key: string, backends: string[] = runnableBackends()): boolean =>
   backends.includes(backendOfKey(key));
 
+/**
+ * Spec 1.3 §8: each backend `p` isolates whose isolated run logs in with an API key that is not in `env` (the
+ * environment catherd runs, and starts workers, in).
+ */
+export function isolationKeyErrors(
+  p: Profile,
+  env: Record<string, string | undefined> = process.env,
+): Issue[] {
+  const out: Issue[] = [];
+  for (const [id, h] of Object.entries(p.harness)) {
+    const key = h.isolated ? adapterFor(id)?.isolationKey : undefined;
+    if (key && !env[key])
+      out.push({
+        path: `harness.${id}.isolated`,
+        message: `an isolated ${id} run needs ${key}, which catherd's environment does not have`,
+        fix: `export ${key}=<key>, or catherd profile set harness.${id}.isolated false`,
+      });
+  }
+  return out;
+}
+
+/** Spec §7.1 validation on this machine: the backends catherd can run here, and the keys isolation needs. */
+export function validateHere(p: Profile, c: Catalog, doc?: ProfileDoc): Validation {
+  const v = validateProfile(p, c, runnableBackends(), doc);
+  return { ...v, errors: [...v.errors, ...isolationKeyErrors(p)] };
+}
+
 /** `repo`: the git toplevel whose listing route reads (opencode lists its models per repository). */
 export function validateNamed(name?: string, repo: string | null = null): Validation {
   const n = name ?? activeName(repo);
   const doc = readProfileDoc(n);
   const catalog = loadCatalog({ timings: false, ...(repo === null ? {} : { repo }) });
-  return validateProfile(resolveProfile(doc, n), catalog, runnableBackends(), doc);
+  return validateHere(resolveProfile(doc, n), catalog, doc);
 }
 
 /** Spec D10: how strongly the backend holds a role to its access mode. */
````

- [ ] **Step 4: Run the tests and the checks**

Run: `env -u FORCE_COLOR bun test test/entry/tui/profiles.test.tsx test/services/adapter-hooks.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/backend.ts src/entry/tui/effects.ts src/entry/tui/fixtures.ts src/entry/tui/views/profiles.tsx src/services/profile-service.ts src/services/profile-store.ts test/entry/tui/profiles.test.tsx test/services/adapter-hooks.test.ts
git commit -m "feat(profile): an isolated backend needs its API key, and the harness row says so"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 8: Read cursor-agent's stream-json events and its model listing (spec 1.3 §4.2, §4.5, §4.6; Rulings 9, 10)

`src/adapters/cursor/events.ts` parses one stream-json line, folds a run's events (thread from `system/init`, reply = assistant text after the last tool call, tokens from `result.usage`, the `result`'s error flag and text), names events for activity (`tool_call/<phase>/<tool>`, else `type/subtype`), and holds the limit, policy, too-old and auth patterns. `models.ts` parses the `models` listing and folds effort-suffixed slugs; `cursorSlug(model, effort)` builds the slug back. The fixtures are synthetic; their README cites the research section each one follows.

**Files:**

- Create: `src/adapters/cursor/events.ts`
- Create: `src/adapters/cursor/models.ts`
- Test (new): `test/adapters/cursor-events.test.ts`
- Create: `test/fixtures/adapters/cursor/README.md`
- Create: `test/fixtures/adapters/cursor/empty.jsonl`
- Create: `test/fixtures/adapters/cursor/models.txt`
- Create: `test/fixtures/adapters/cursor/no-result.jsonl`
- Create: `test/fixtures/adapters/cursor/ok.jsonl`
- Create: `test/fixtures/adapters/cursor/resume.jsonl`

**Interfaces:**
- Produces: `parseCursorLine`, `foldCursorEvents(lines): CursorFold`, `cursorTokens`, `eventName`, `cursorActivity`, `isLimit`, `isTooOld`, `isAuthFailure`, `CURSOR_LIMIT`, `CURSOR_POLICY`, `CURSOR_TOO_OLD`; `CURSOR_EFFORTS`, `cursorSlug`, `parseCursorModels(text): DiscoveredModel[]`.

- [ ] **Step 1: Write the failing tests**

Create `test/adapters/cursor-events.test.ts`:

````ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cursorActivity,
  cursorTokens,
  eventName,
  foldCursorEvents,
  isAuthFailure,
  isLimit,
  isTooOld,
  parseCursorLine,
} from "../../src/adapters/cursor/events.ts";
import { cursorSlug, parseCursorModels } from "../../src/adapters/cursor/models.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "cursor");
const lines = (n: string) =>
  readFileSync(join(FX, n), "utf8")
    .split("\n")
    .filter((l) => l.trim());

describe("cursor events (spec 1.3 §4.5)", () => {
  it("takes the thread from system/init, the reply after the last tool call, tokens from result", () => {
    const f = foldCursorEvents(lines("ok.jsonl"));
    expect(f.thread).toBe("2b7c9e41-5d3a-4f86-9c1e-7a0b3d5e8f21");
    // result.result runs every segment together; the reply is the text after the last tool call
    expect(f.reply).toBe("Done.\nSTATUS: complete — wrote src/a.ts");
    expect(f.result).toEqual({
      isError: false,
      text: "I'll read the lane file.Done.\nSTATUS: complete — wrote src/a.ts",
      tokens: { input: 15989, cached: 9728, output: 25 },
    });
    expect(f.lastEvent).toBe("result/success");
  });

  it("adds cache reads and writes back into input (inputTokens is uncached only), and reads no usage as zero", () => {
    expect(
      cursorTokens({ inputTokens: 1200, outputTokens: 12, cacheReadTokens: 14000, cacheWriteTokens: 300 }),
    ).toEqual({ input: 15500, cached: 14000, output: 12 });
    expect(cursorTokens(undefined)).toEqual({ input: 0, cached: 0, output: 0 });
  });

  it("names events by type, and tool calls by phase and tool", () => {
    expect(eventName({ type: "tool_call", subtype: "started", tool_call: { writeToolCall: {} } })).toBe(
      "tool_call/started/writeToolCall",
    );
    expect(eventName({ type: "system", subtype: "init" })).toBe("system/init");
    expect(eventName({ type: "retry", subtype: "starting" })).toBe("retry/starting");
  });

  it("says what the worker is doing: a command, a file it reads or edits, its text", () => {
    const at = (i: number) => cursorActivity(parseCursorLine(lines("ok.jsonl")[i] as string) ?? {});
    expect([at(3), at(4), at(6), at(10), at(2)]).toEqual([
      "I'll read the lane file.",
      "read lanes/M1.L1.md",
      "edit src/a.ts",
      "$ bun test",
      undefined,
    ]);
  });

  it("tells a usage limit from a team policy, and reads a CLI too old and a login that is missing", () => {
    expect(isLimit("ActionRequiredError: You've hit your usage limit")).toBe(true);
    expect(isLimit("Error: PRO_USER_USAGE_LIMIT")).toBe(true);
    expect(isLimit("RATE_LIMITED_TOO_MANY_REQUESTS")).toBe(true);
    expect(isLimit("Error: Your team administrator has disabled the 'Run Everything' option.")).toBe(false);
    expect(isLimit("Error: Your team administrator has disabled headless Cursor CLI usage.")).toBe(false);
    expect(isLimit("Model is not available")).toBe(false);
    expect(isTooOld("error: unknown option '--disable-auto-update'")).toBe(true);
    expect(isTooOld("ActionRequiredError: OUTDATED_CLIENT")).toBe(true);
    expect(isAuthFailure("Error: Authentication required. Please run 'agent login' first")).toBe(true);
  });

  it("reads no final result from a run that failed before one", () => {
    const f = foldCursorEvents(lines("no-result.jsonl"));
    expect([f.thread, f.result, f.reply]).toEqual(["7d6c5b4a-3928-4716-8a5b-4c3d2e1f0a9b", null, null]);
  });
});

describe("cursor models (spec 1.3 §4.6)", () => {
  it("folds effort slugs into one model, lists default only for a bare slug, and skips other lines", () => {
    const models = parseCursorModels(readFileSync(join(FX, "models.txt"), "utf8"));
    expect(models.map((m) => [m.id, m.efforts])).toEqual([
      ["auto", ["default"]],
      ["composer-2.5", ["default"]],
      ["composer-2.5-fast", ["default"]],
      ["gpt-6-sol", ["default", "low", "high", "xhigh"]],
      ["gpt-6-luna", ["high"]],
      ["claude-opus-5-5-thinking", ["high"]],
      ["grok-4.7", ["default"]],
      ["gemini-3.8-flash", ["default"]],
    ]);
  });

  it("ignores colour codes, and an account with no models", () => {
    const esc = String.fromCharCode(27);
    expect(
      parseCursorModels(
        `${esc}[2mAvailable models${esc}[0m\n${esc}[1mgpt-6-sol-low - GPT-6 Sol Low${esc}[0m\n`,
      ),
    ).toEqual([{ id: "gpt-6-sol", efforts: ["low"], context: null, imageIn: false }]);
    expect(parseCursorModels("No models available for this account.\n")).toEqual([]);
  });

  it("runs a rung's effort as the model's suffixed slug, and default as the bare slug", () => {
    expect(cursorSlug("gpt-6-sol", "xhigh")).toBe("gpt-6-sol-xhigh");
    expect(cursorSlug("composer-2.5", "default")).toBe("composer-2.5");
  });
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `env -u FORCE_COLOR bun test test/adapters/cursor-events.test.ts`
Expected: FAIL: the modules do not exist.

- [ ] **Step 3: Implement**

Create `src/adapters/cursor/events.ts`:

````ts
import { type Tokens, ZERO_TOKENS } from "../../domain/record.ts";

export interface CursorResult {
  isError: boolean;
  text: string;
  tokens: Tokens;
}

export interface CursorFold {
  thread: string | null;
  /**
   * The assistant text after the last tool call, as Cursor's text format prints it; `result.result` runs every
   * segment together, which would bury the STATUS line (spec 1.3 §3.1, research §2.3). null: no assistant text.
   */
  reply: string | null;
  result: CursorResult | null;
  lastEvent: string | null;
}

/**
 * A usage or rate limit (research §2.3: `ActionRequiredError` and the server's codes; the user-facing text
 * comes from the server). A team policy looks like one but never passes by waiting (CURSOR_POLICY).
 */
export const CURSOR_LIMIT = [
  /usage limit/i,
  /rate limit/i,
  /too many requests/i,
  /ActionRequiredError/,
  /USAGE_LIMIT/,
  /RATE_LIMIT/,
];
export const CURSOR_POLICY = [/administrator has disabled/i];
/** What an older `cursor-agent` prints for a flag catherd passes (commander, exit 1), or the server's verdict. */
export const CURSOR_TOO_OLD = [/unknown option/i, /OUTDATED_CLIENT/];
/** research §2.2 [run]: no login and no CURSOR_API_KEY, on stderr, before any event */
const CURSOR_AUTH = [/Authentication required/i];

type Event = Record<string, any>;

export function parseCursorLine(line: string): Event | null {
  if (!line.trim().startsWith("{")) return null;
  try {
    const e = JSON.parse(line) as unknown;
    return e && typeof e === "object" && !Array.isArray(e) ? (e as Event) : null;
  } catch {
    return null;
  }
}

/**
 * Spec §4.3's convention from `result.usage` (camelCase): `inputTokens` is uncached only (research §2.3,
 * `max(total - cacheRead - cacheWrite, 0)`), so input adds cache reads and writes back.
 */
export function cursorTokens(u: Event | undefined): Tokens {
  if (!u) return { ...ZERO_TOKENS };
  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  const cached = n("cacheReadTokens");
  return { input: n("inputTokens") + cached + n("cacheWriteTokens"), cached, output: n("outputTokens") };
}

const textOf = (e: Event): string =>
  ((e.message?.content ?? []) as Event[])
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");

/** A tool call's tool: `readToolCall`, `writeToolCall`, or a `function`'s name. */
function toolOf(e: Event): { name: string; args: Event } {
  const [kind, call] = Object.entries((e.tool_call ?? {}) as Event)[0] ?? ["?", {}];
  if (kind !== "function") return { name: kind, args: (call?.args ?? {}) as Event };
  let args: Event = {};
  try {
    args = typeof call?.arguments === "string" ? JSON.parse(call.arguments) : (call?.arguments ?? {});
  } catch {
    // arguments that are not JSON: the name alone
  }
  return { name: String(call?.name ?? "function"), args };
}

export function eventName(e: Event): string {
  if (e.type === "tool_call")
    return `tool_call/${e.subtype ?? "?"}/${Object.keys(e.tool_call ?? {})[0] ?? "?"}`;
  return e.subtype ? `${e.type}/${e.subtype}` : String(e.type ?? "?");
}

/** Spec §3.7: a command the worker runs, a file it reads or edits, or its message. */
export function cursorActivity(e: Event): string | undefined {
  if (e.type === "assistant") return textOf(e) || undefined;
  if (e.type !== "tool_call" || e.subtype !== "started") return undefined;
  const { name, args } = toolOf(e);
  if (typeof args.command === "string") return `$ ${args.command}`;
  if (typeof args.path === "string") return `${name === "readToolCall" ? "read" : "edit"} ${args.path}`;
  return name;
}

export const isLimit = (text: string): boolean =>
  CURSOR_LIMIT.some((r) => r.test(text)) && !CURSOR_POLICY.some((r) => r.test(text));
export const isTooOld = (text: string): boolean => CURSOR_TOO_OLD.some((r) => r.test(text));
export const isAuthFailure = (text: string): boolean => CURSOR_AUTH.some((r) => r.test(text));

export function foldCursorEvents(lines: string[]): CursorFold {
  const f: CursorFold = { thread: null, reply: null, result: null, lastEvent: null };
  for (const line of lines) {
    const e = parseCursorLine(line);
    if (!e) continue;
    f.lastEvent = eventName(e);
    if (typeof e.session_id === "string" && e.session_id) f.thread ??= e.session_id;
    if (e.type === "tool_call") f.reply = null;
    else if (e.type === "assistant") {
      const t = textOf(e);
      if (t) f.reply = (f.reply ?? "") + t;
    } else if (e.type === "result")
      f.result = {
        isError: e.is_error === true,
        text: typeof e.result === "string" ? e.result : "",
        tokens: cursorTokens(e.usage),
      };
  }
  return f;
}
````

Create `src/adapters/cursor/models.ts`:

````ts
import type { DiscoveredModel } from "../backend.ts";

/** Effort suffixes Cursor puts on a legacy slug (`gpt-6-sol-xhigh`); any other suffix names a model. */
export const CURSOR_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The listing may be coloured: ESC `[` … a letter. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
const LINE = /^\s*([a-z0-9][a-z0-9._-]*)\s+-\s+\S/;

/** Spec 1.3 §4.6: an effort is its own slug; `default` is the bare one, with no effort suffix. */
export const cursorSlug = (model: string, effort: string): string =>
  effort === "default" ? model : `${model}-${effort}`;

/**
 * `cursor-agent models` prints `<slug> - <Display Name>` lines under a header, with ` (current, default)`
 * markers and a tip (research §2.4). Slugs that differ only by an effort suffix fold into one model; its
 * efforts list `default` when the bare slug is listed too, since only then does a `#default` rung have a slug
 * to run. Bracket variant strings are never listed, so they are never built.
 */
export function parseCursorModels(text: string): DiscoveredModel[] {
  const slugs = text
    .replace(ANSI, "")
    .split("\n")
    .map((l) => LINE.exec(l)?.[1])
    .filter((s): s is string => s !== undefined);
  const byModel = new Map<string, Set<string>>();
  for (const slug of slugs) {
    const effort = CURSOR_EFFORTS.find((e) => slug.endsWith(`-${e}`));
    const model = effort ? slug.slice(0, -(effort.length + 1)) : slug;
    const efforts = byModel.get(model) ?? new Set<string>();
    efforts.add(effort ?? "default");
    byModel.set(model, efforts);
  }
  return [...byModel].map(([id, efforts]) => ({
    id,
    efforts: ["default", ...CURSOR_EFFORTS].filter((e) => efforts.has(e)),
    context: null,
    imageIn: false,
  }));
}
````

Create `test/fixtures/adapters/cursor/README.md`:

````markdown
# Cursor fixtures (spec 1.3 §4, §10): synthetic

No Cursor CLI was signed in when these were written (research `docs/research/2026-09-29-cursor-grok-antigravity.md`
§0), so every file here is **synthetic**: built from Cursor's docs and the 2026.09.28-64d2043 bundle, as the research
cites them. `catherd capture-fixtures --backend cursor` on a signed-in machine records real ones under
`<cli-version>/` (`docs/dev/live-verification.md` §11); compare them with these and correct what differs.

| File | Follows | What is not verified |
| --- | --- | --- |
| `ok.jsonl` | §2.3 [doc output-format; bin `6949@565224`, `@571182`]: `system/init` (display-name `model`, `permissionMode: "default"`), `user`, `assistant`, `tool_call` started/completed by `call_id` (`readToolCall`, `writeToolCall`, other tools as `function`), the undocumented `thinking` and `retry` events, and `result` whose `result` runs every assistant text together; `usage` camelCase with `inputTokens` uncached only [bin `6949@564048`] | the `function` payload (`name`, `arguments` as a JSON string); whether one message comes as one `assistant` event |
| `resume.jsonl` | §2.5: a resumed chat keeps its `session_id` | the whole stream |
| `no-result.jsonl` | §2.3: a failure has no `result` event, its text on stderr, exit 1; `connection` [bin] | the `connection` payload |
| `empty.jsonl` | §2.2 [run]: no auth, an unknown option, a team policy: nothing on stdout, the text on stderr | — |
| `models.txt` | §2.4 [bin `9517@1021`]: `Available models`, `<id> - <Display Name>` lines with ` (current, default)` markers, a tip | the slugs: whether the account lists effort-suffixed slugs, and Cursor's ids for GPT-6, Claude, Grok and Gemini |

The stderr texts the tests pair with them are quoted from the research: "Authentication required" §2.2 [run], the
commander `unknown option` §2.2 [run], the team policies §2.3 [bin `6949@732783`], `ActionRequiredError` and the
server codes §2.3 [bin `index.js@4146371`] (the user-facing limit text comes from the server and is a guess).
````

Create `test/fixtures/adapters/cursor/empty.jsonl` empty (0 bytes).

Create `test/fixtures/adapters/cursor/models.txt`:

````text
Available models

auto - Auto (current, default)
composer-2.5 - Composer 2.5
composer-2.5-fast - Composer 2.5 Fast
gpt-6-sol - GPT-6 Sol
gpt-6-sol-low - GPT-6 Sol Low
gpt-6-sol-high - GPT-6 Sol High
gpt-6-sol-xhigh - GPT-6 Sol Extra High
gpt-6-luna-high - GPT-6 Luna High
claude-opus-5-5-thinking-high - Claude Opus 5.5 Thinking High
grok-4.7 - Grok 4.7
gemini-3.8-flash - Gemini 3.8 Flash

Tip: use --model <id> (or /model in interactive mode) to switch.
````

Create `test/fixtures/adapters/cursor/no-result.jsonl`:

````text
{"type":"system","subtype":"init","apiKeySource":"login","cwd":"<repo>","session_id":"7d6c5b4a-3928-4716-8a5b-4c3d2e1f0a9b","model":"GPT-6 Sol High","permissionMode":"default"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"---\nRead lanes/M1.L1.md"}]},"session_id":"7d6c5b4a-3928-4716-8a5b-4c3d2e1f0a9b"}
{"type":"connection","subtype":"reconnecting","session_id":"7d6c5b4a-3928-4716-8a5b-4c3d2e1f0a9b"}
````

Create `test/fixtures/adapters/cursor/ok.jsonl`:

````text
{"type":"system","subtype":"init","apiKeySource":"login","cwd":"<repo>","session_id":"2b7c9e41-5d3a-4f86-9c1e-7a0b3d5e8f21","model":"GPT-6 Sol High","permissionMode":"default"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"---\nRead lanes/M1.L1.md"}]},"session_id":"2b7c9e41-5d3a-4f86-9c1e-7a0b3d5e8f21"}
{"type":"thinking","subtype":"delta","text":"The lane file first.","session_id":"2b7c9e41-5d3a-4f86-9c1e-7a0b3d5e8f21"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll read the lane file."}]},"session_id":"2b7c9e41-5d3a-4f86-9c1e-7a0b3d5e8f21"}
{"type":"tool_call","subtype":"started","call_id":"toolu_01","tool_call":{"readToolCall":{"args":{"path":"lanes/M1.L1.md"}}},"session_id":"2b7c9e41-5d3a-4f86-9c1e-7a0b3d5e8f21"}
{"type":"tool_call","subtype":"completed","call_id":"toolu_01","tool_call":{"readToolCall":{"args":{"path":"lanes/M1.L1.md"},"result":{"success":{"content":"# M1.L1","totalLines":5}}}},"session_id":"2b7c9e41-5d3a-4f86-9c1e-7a0b3d5e8f21"}
{"type":"tool_call","subtype":"started","call_id":"toolu_02","tool_call":{"writeToolCall":{"args":{"path":"src/a.ts","fileText":"new"}}},"session_id":"2b7c9e41-5d3a-4f86-9c1e-7a0b3d5e8f21"}
{"type":"tool_call","subtype":"completed","call_id":"toolu_02","tool_call":{"writeToolCall":{"args":{"path":"src/a.ts","fileText":"new"},"result":{"success":{"path":"src/a.ts","linesCreated":1}}}},"session_id":"2b7c9e41-5d3a-4f86-9c1e-7a0b3d5e8f21"}
{"type":"retry","subtype":"starting","attempt":1,"session_id":"2b7c9e41-5d3a-4f86-9c1e-7a0b3d5e8f21"}
{"type":"retry","subtype":"resuming","attempt":1,"session_id":"2b7c9e41-5d3a-4f86-9c1e-7a0b3d5e8f21"}
{"type":"tool_call","subtype":"started","call_id":"toolu_03","tool_call":{"function":{"name":"run_terminal_cmd","arguments":"{\"command\":\"bun test\"}"}},"session_id":"2b7c9e41-5d3a-4f86-9c1e-7a0b3d5e8f21"}
{"type":"tool_call","subtype":"completed","call_id":"toolu_03","tool_call":{"function":{"name":"run_terminal_cmd","arguments":"{\"command\":\"bun test\"}","result":{"success":{"exitCode":0}}}},"session_id":"2b7c9e41-5d3a-4f86-9c1e-7a0b3d5e8f21"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done.\n"}]},"session_id":"2b7c9e41-5d3a-4f86-9c1e-7a0b3d5e8f21"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"STATUS: complete — wrote src/a.ts"}]},"session_id":"2b7c9e41-5d3a-4f86-9c1e-7a0b3d5e8f21"}
{"type":"result","subtype":"success","duration_ms":5234,"duration_api_ms":5234,"is_error":false,"result":"I'll read the lane file.Done.\nSTATUS: complete — wrote src/a.ts","session_id":"2b7c9e41-5d3a-4f86-9c1e-7a0b3d5e8f21","request_id":"9f1e2d3c-4b5a-4968-8776-655443322110","usage":{"inputTokens":5749,"outputTokens":25,"cacheReadTokens":9728,"cacheWriteTokens":512}}
````

Create `test/fixtures/adapters/cursor/resume.jsonl`:

````text
{"type":"system","subtype":"init","apiKeySource":"login","cwd":"<repo>","session_id":"5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716","model":"GPT-6 Sol High","permissionMode":"default"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Fix: BUG src/a.ts:1"}]},"session_id":"5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Fixed.\nSTATUS: complete — fixed the bug"}]},"session_id":"5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716"}
{"type":"result","subtype":"success","duration_ms":2100,"duration_api_ms":2100,"is_error":false,"result":"Fixed.\nSTATUS: complete — fixed the bug","session_id":"5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716","request_id":"1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d","usage":{"inputTokens":1200,"outputTokens":12,"cacheReadTokens":14000,"cacheWriteTokens":300}}
````

- [ ] **Step 4: Run the tests and the checks**

Run: `env -u FORCE_COLOR bun test test/adapters/cursor-events.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/cursor/events.ts src/adapters/cursor/models.ts test/adapters/cursor-events.test.ts test/fixtures/adapters/cursor/README.md test/fixtures/adapters/cursor/empty.jsonl test/fixtures/adapters/cursor/models.txt test/fixtures/adapters/cursor/no-result.jsonl test/fixtures/adapters/cursor/ok.jsonl test/fixtures/adapters/cursor/resume.jsonl
git commit -m "feat(cursor): read cursor-agent's stream-json events and its model listing"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 9: A cursor-agent simulator driven by a scenario file (spec 1.3 §10)

`test/sim/cursor-agent` answers `--version`, `models` (an auth failure unless logged in or `CURSOR_API_KEY` is set), the hidden `sandbox run -- <cmd>` (or no `sandbox` command), and `-p` runs: it validates flags and choices like the real CLI (auth before trust), reads stdin only without a positional prompt, replays an events file with the session id it was given (`--resume`) or a fixed one, and records argv, stdin, cwd, PWD, HOME and the `CURSOR_*`/`CATHERD_*_DIR`/`NO_OPEN_BROWSER` values it saw. `withCursorScenario` writes its scenario (`CATHERD_SIM_CURSOR`).

**Files:**

- Create: `test/sim/cursor-agent`
- Test (new): `test/sim/cursor.test.ts`
- Modify: `test/sim/sim-scenarios.ts`

**Interfaces:**
- Produces: `CursorScenario`, `withCursorScenario(s)`; `Recorded.home`, `Recorded.vars`.

- [ ] **Step 1: Write the failing tests**

Create `test/sim/cursor.test.ts`:

````ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempDir } from "../helpers.ts";
import { simPath } from "./scenario.ts";
import { withCursorScenario } from "./sim-scenarios.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "cursor");
const CHAT = "5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716";

function agent(args: string[], env: Record<string, string>, stdin?: string, cwd?: string) {
  let input: "ignore" | ReturnType<typeof Bun.file> = "ignore";
  if (stdin !== undefined) {
    const f = join(mkdtempSync(join(tmpdir(), "catherd-stdin-")), "in");
    writeFileSync(f, stdin);
    input = Bun.file(f);
  }
  const p = Bun.spawnSync(["cursor-agent", ...args], {
    env: { PATH: simPath(), ANTHROPIC_API_KEY: "", ...env },
    stdin: input,
    stdout: "pipe",
    stderr: "pipe",
    cwd,
  });
  return { code: p.exitCode, out: p.stdout.toString("utf8"), err: p.stderr.toString("utf8") };
}

const AUTH =
  "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\n";

describe("cursor-agent simulator (research §2)", () => {
  it("answers --version and models, and fails models fast when logged out unless a key is set", () => {
    const s = withCursorScenario({ modelsFile: join(FX, "models.txt") });
    expect(agent(["--version"], s.env).out).toBe("2026.09.28-64d2043\n");
    expect(agent(["models"], s.env).out).toContain("gpt-6-sol-xhigh - GPT-6 Sol Extra High");
    const out = withCursorScenario({ loggedIn: false, modelsFile: join(FX, "models.txt") });
    expect(agent(["models"], out.env)).toEqual({ code: 1, out: "", err: AUTH });
    expect(agent(["models"], { ...out.env, CURSOR_API_KEY: "k" }).code).toBe(0);
  });

  it("replays the events under the resumed chat in the workspace, and records stdin, HOME and the hidden flag", () => {
    const repo = tempDir("catherd-simrepo-");
    const s = withCursorScenario({
      eventsFile: join(FX, "resume.jsonl"),
      touch: [{ path: "a.ts", content: "x" }],
    });
    const r = agent(
      ["-p", "--output-format", "stream-json", "--trust", "--workspace", repo, "--disable-auto-update"],
      { ...s.env, HOME: "/iso/home" },
      "---\nBRIEF",
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain('"session_id":"00000000-0000-4000-8000-00000000c0de"');
    expect(r.out).toContain(`"cwd":"${repo}"`);
    expect(readFileSync(join(repo, "a.ts"), "utf8")).toBe("x");
    expect(s.recorded()).toMatchObject({ stdin: "---\nBRIEF", home: "/iso/home" });
    expect(agent(["-p", "--trust", "--resume", CHAT], s.env, "b", repo).out).toContain(
      `"session_id":"${CHAT}"`,
    );
  });

  it("checks the login before the trust, and refuses an untrusted workspace, an unknown flag and a bad value", () => {
    const out = withCursorScenario({ loggedIn: false });
    expect(agent(["-p"], out.env, "b")).toEqual({ code: 1, out: "", err: AUTH });
    const s = withCursorScenario({ unknownFlags: ["--disable-auto-update"] });
    const untrusted = agent(["-p"], s.env, "b");
    expect(untrusted.code).toBe(1);
    expect(untrusted.err).toContain("Workspace Trust Required");
    expect(agent(["-p", "--trust", "--disable-auto-update"], s.env, "b")).toEqual({
      code: 1,
      out: "",
      err: "error: unknown option '--disable-auto-update'\n",
    });
    expect(agent(["-p", "--trust", "--sandbox", "bogus"], s.env, "b").err).toBe(
      "error: option '--sandbox <mode>' argument 'bogus' is invalid. Allowed choices are enabled, disabled.\n",
    );
  });

  it("runs a command in its sandbox with no model turn, refusing what the scenario denies", () => {
    const argsTo = join(mkdtempSync(join(tmpdir(), "catherd-sbx-")), "args.jsonl");
    const s = withCursorScenario({ sandboxDeny: ["/locks"], sandboxArgsTo: argsTo });
    expect(agent(["sandbox", "run", "--", "sh", "-c", 'echo "$1"', "_", "hi"], s.env).out).toBe("hi\n");
    const denied = agent(["sandbox", "run", "--", "sh", "-c", 'touch "$1"', "_", "/x/locks"], s.env);
    expect([denied.code, denied.err]).toEqual([1, "sandbox: Operation not permitted\n"]);
    expect(readFileSync(argsTo, "utf8").trim().split("\n").length).toBe(2);
    const old = withCursorScenario({ sandbox: "missing" });
    expect(agent(["sandbox", "run", "--", "true"], old.env).err).toBe("error: unknown command 'sandbox'\n");
  });
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `env -u FORCE_COLOR bun test test/sim/cursor.test.ts`
Expected: FAIL: the simulator does not exist.

- [ ] **Step 3: Implement**

Create `test/sim/cursor-agent` and make it executable (`chmod +x test/sim/cursor-agent`):

````text
#!/usr/bin/env bun
// Cursor CLI simulator for catherd's tests (research 2026-09-29 §2): behaviour comes from the JSON scenario
// in CATHERD_SIM_CURSOR.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const s = JSON.parse(readFileSync(process.env.CATHERD_SIM_CURSOR ?? "", "utf8")) as Record<string, any>;
const args = process.argv.slice(2);
const say = (text: string) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
const fail = (text: string, code = 1): never => {
  process.stderr.write(`${text}\n`);
  process.exit(code);
};
// research §2.2 [run]: a CLI with no login and no key fails every call that reaches the server, first thing
const loggedIn = s.loggedIn !== false || !!process.env.CURSOR_API_KEY;
const AUTH =
  "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.";

if (args[0] === "--version" || args[0] === "-v") {
  say(s.version ?? "2026.09.28-64d2043");
  process.exit(0);
}
if (args[0] === "models" || args[0] === "--list-models") {
  if (!loggedIn) fail(AUTH);
  if (s.modelsFile) process.stdout.write(readFileSync(s.modelsFile, "utf8"));
  process.exit(s.modelsExit ?? 0);
}
if (args[0] === "sandbox") {
  // the hidden `agent sandbox run [flags] -- <cmd…>` (research §2.6)
  if (s.sandbox === "missing") fail("error: unknown command 'sandbox'");
  if (s.sandboxArgsTo) appendFileSync(s.sandboxArgsTo, `${JSON.stringify(args)}\n`);
  const cmd = args.slice(args.indexOf("--") + 1);
  if ((s.sandboxDeny ?? []).some((d: string) => cmd.join(" ").includes(d)))
    fail("sandbox: Operation not permitted");
  const r = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  process.exit(r.exitCode ?? 1);
}

const VALUE = ["--output-format", "--model", "--mode", "--sandbox", "--workspace", "--resume", "--api-key"];
const BOOL = ["-p", "--print", "--trust", "--force", "-f", "--yolo", "--approve-mcps", "--disable-auto-update"];
const CHOICES: Record<string, string[]> = { "--sandbox": ["enabled", "disabled"], "--mode": ["plan", "ask"] };
const opts: Record<string, string> = {};
const prompt: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i] as string;
  if (!a.startsWith("-")) {
    prompt.push(a);
    continue;
  }
  if ((s.unknownFlags ?? []).includes(a) || (!VALUE.includes(a) && !BOOL.includes(a)))
    fail(`error: unknown option '${a}'`);
  opts[a] = VALUE.includes(a) ? (args[++i] ?? "") : "true";
  const allowed = CHOICES[a];
  if (allowed && !allowed.includes(opts[a] as string))
    fail(
      `error: option '${a} <mode>' argument '${opts[a]}' is invalid. Allowed choices are ${allowed.join(", ")}.`,
    );
}
if (!opts["-p"] && !opts["--print"]) fail("sim: only print mode is simulated", 2);
if (!loggedIn) fail(AUTH);
if (!opts["--trust"] && !opts["--force"] && !opts["--yolo"] && !opts["-f"])
  fail("⚠ Workspace Trust Required\nPass --trust, --yolo, or -f if you trust this directory");

// research §2.2: stdin is read only when there is no positional prompt
let stdin = "";
if (prompt.length === 0)
  try {
    stdin = readFileSync(0, "utf8");
  } catch {
    // no stdin
  }
const workspace = opts["--workspace"] ?? process.cwd();
const PICKED = ["NO_OPEN_BROWSER", "CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR", "CATHERD_DATA_DIR", "CATHERD_CONFIG_DIR"];
writeFileSync(
  s.recordTo,
  JSON.stringify({
    args,
    stdin: [...prompt, stdin].filter(Boolean).join("\n"),
    cwd: process.cwd(),
    pwd: process.env.PWD ?? null,
    xdgConfig: process.env.XDG_CONFIG_HOME ?? null,
    home: process.env.HOME ?? null,
    vars: Object.fromEntries(PICKED.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]]]))),
    envKeys: Object.keys(process.env),
  }),
);
const session = opts["--resume"] ?? "00000000-0000-4000-8000-00000000c0de";
setTimeout(async () => {
  for (const t of s.touch ?? []) {
    mkdirSync(dirname(join(workspace, t.path)), { recursive: true });
    writeFileSync(join(workspace, t.path), t.content);
  }
  if (s.eventsFile)
    process.stdout.write(
      readFileSync(s.eventsFile, "utf8")
        .replace(/"session_id":"[^"]*"/g, `"session_id":"${session}"`)
        .replaceAll("<repo>", workspace),
    );
  if (s.stderr) process.stderr.write(s.stderr);
  // research §2.10: the CLI waits for background shells after its result, with no limit
  if (s.hangMs) await Bun.sleep(s.hangMs);
  process.exit(s.exitCode ?? 0);
}, s.delayMs ?? 0);
````

Modify `test/sim/sim-scenarios.ts`:

````diff
@@ -9,6 +9,10 @@ interface Recorded {
   cwd: string;
   pwd: string | null;
   xdgConfig: string | null;
+  /** HOME as the CLI saw it (cursor-agent) */
+  home?: string | null;
+  /** a few env values the CLI saw, by name (cursor-agent: NO_OPEN_BROWSER, CURSOR_*, CATHERD_*_DIR) */
+  vars?: Record<string, string>;
   envKeys: string[];
 }
 
@@ -88,5 +92,25 @@ function write<S extends Common>(envKey: string, s: S) {
   };
 }
 
+export interface CursorScenario extends Common {
+  /** a server call (`models`, `-p`) answers (default true); CURSOR_API_KEY in the env logs it in too */
+  loggedIn?: boolean;
+  /** what `cursor-agent models` prints: this file's text */
+  modelsFile?: string;
+  /** the exit code of `models` (default 0) */
+  modelsExit?: number;
+  /** flags this "older" CLI does not know */
+  unknownFlags?: string[];
+  /** written to stderr after the events */
+  stderr?: string;
+  /** "missing": a CLI without the hidden `sandbox` command; else `sandbox run` runs the command */
+  sandbox?: "missing";
+  /** `sandbox run` refuses any command whose text holds one of these */
+  sandboxDeny?: string[];
+  /** `sandbox run` appends its arguments here, one JSON line per call */
+  sandboxArgsTo?: string;
+}
+
 export const withClaudeScenario = (s: ClaudeScenario) => write("CATHERD_SIM_CLAUDE", s);
+export const withCursorScenario = (s: CursorScenario) => write("CATHERD_SIM_CURSOR", s);
 export const withOpencodeScenario = (s: OpencodeScenario) => write("CATHERD_SIM_OPENCODE", s);
````

- [ ] **Step 4: Run the tests and the checks**

Run: `env -u FORCE_COLOR bun test test/sim/cursor.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add test/sim/cursor-agent test/sim/cursor.test.ts test/sim/sim-scenarios.ts
git commit -m "test(sim): a cursor-agent simulator driven by a scenario file"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 10: The Cursor adapter: plan, probe, prepare, finalize, access probes and the contract suite (spec 1.3 §4; C-edit; Rulings 1, 4, 5, 7, 8, 10–13)

`src/adapters/cursor/home.ts`: the per-access isolated homes, their env (`movedHomeEnv` plus `CURSOR_CONFIG_DIR`/`CURSOR_DATA_DIR`), their `sandbox.json` and the shared `chats` link. `index.ts`: `cursorBin`, the access table, `plan` (§4.2's argv, the brief on stdin), `listModels`, `prepare` (the API key when isolated, the rung's slug against the listing), `finalize`, `parse`, `probe` (date-hash version, login through `models`, `name:agent` info), `accessShell` through `sandbox run --` with Cursor's own fixes, enforcement, `isolationNote` (spec §4.4's text), `isolationKey`. `BackendAdapter` gains `Probe.info` and `prepare`'s `network`, which admission and capture pass. Not registered yet (Task 12).

**Files:**

- Modify: `src/adapters/backend.ts`
- Create: `src/adapters/cursor/home.ts`
- Create: `src/adapters/cursor/index.ts`
- Modify: `src/services/admission.ts`
- Modify: `src/services/capture.ts`
- Test (new): `test/adapters/cursor.contract.test.ts`
- Test (new): `test/adapters/cursor.test.ts`
- Test: `test/services/adapter-hooks.test.ts`

**Interfaces:**
- Produces: `cursorAdapter`, `CURSOR_MIN_VERSION`, `CURSOR_INSTALL`, `CURSOR_ACCESS`, `cursorBin()`, `cursorShell`; `isolatedCursorRoot()`, `isolatedCursorHome(access, network?)`, `cursorHomeEnv`, `cursorSandboxPolicy`, `prepareCursorHome`; `Probe.info?: { id; label; detail }[]`; `prepare(req)` with `network?: boolean`.

- [ ] **Step 1: Write the failing tests**

Create `test/adapters/cursor.contract.test.ts`:

````ts
import { join } from "node:path";
import { cursorAdapter } from "../../src/adapters/cursor/index.ts";
import { runAdapterContract } from "./contract.ts";

const fx = (n: string) => join(import.meta.dir, "..", "fixtures", "adapters", "cursor", n);

// Synthetic, from the docs and the 2026.09.28 bundle (research §2.3; test/fixtures/adapters/cursor/README.md),
// until capture-fixtures records real ones.
runAdapterContract(
  cursorAdapter,
  "cursor:gpt-6-sol#high",
  [
    {
      name: "a run with a read, a write and a command",
      fixture: fx("ok.jsonl"),
      expect: {
        status: "ok",
        thread: "2b7c9e41-5d3a-4f86-9c1e-7a0b3d5e8f21",
        tokens: { input: 15989, cached: 9728, output: 25 },
        reply: "Done.\nSTATUS: complete — wrote src/a.ts",
      },
    },
    {
      name: "a result, then a CLI that lingers until the grace kill (SIGTERM, 143)",
      fixture: fx("ok.jsonl"),
      exitCode: 143,
      expect: { status: "ok", reply: "Done.\nSTATUS: complete — wrote src/a.ts" },
    },
    {
      name: "a resumed chat",
      fixture: fx("resume.jsonl"),
      expect: {
        status: "ok",
        thread: "5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716",
        tokens: { input: 15500, cached: 14000, output: 12 },
      },
    },
    {
      name: "no result event",
      fixture: fx("no-result.jsonl"),
      expect: { status: "failed", thread: "7d6c5b4a-3928-4716-8a5b-4c3d2e1f0a9b" },
    },
    {
      name: "no login",
      fixture: fx("empty.jsonl"),
      stderr:
        "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\n",
      expect: { status: "failed", thread: null },
    },
    {
      name: "a usage limit before any assistant turn",
      fixture: fx("no-result.jsonl"),
      stderr: "ActionRequiredError: You've hit your usage limit (PRO_USER_USAGE_LIMIT)\n",
      expect: { status: "limit", thread: "7d6c5b4a-3928-4716-8a5b-4c3d2e1f0a9b" },
    },
    {
      name: "a team policy, which is no limit",
      fixture: fx("empty.jsonl"),
      stderr: "Error: Your team administrator has disabled headless Cursor CLI usage.\n",
      expect: { status: "failed" },
    },
    {
      name: "a CLI too old for a flag",
      fixture: fx("empty.jsonl"),
      stderr: "error: unknown option '--disable-auto-update'\n",
      expect: { status: "cli-too-old" },
    },
    {
      name: "a client the server calls outdated",
      fixture: fx("empty.jsonl"),
      stderr: "ActionRequiredError: OUTDATED_CLIENT\n",
      expect: { status: "cli-too-old" },
    },
  ],
  {
    subcommands: [],
    valueFlags: ["--output-format", "--workspace", "--model", "--mode", "--sandbox", "--resume"],
    thread: "5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716",
  },
);
````

Create `test/adapters/cursor.test.ts`:

````ts
import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writableRoots } from "../../src/adapters/access.ts";
import type { AccessShell, FinishedRun, RunRequest } from "../../src/adapters/backend.ts";
import {
  CURSOR_ACCESS,
  cursorAdapter,
  cursorBin,
  cursorShell,
  isolatedCursorHome,
  isolatedCursorRoot,
} from "../../src/adapters/cursor/index.ts";
import { readDiscovery } from "../../src/adapters/discovery.ts";
import { isCatherdError } from "../../src/domain/errors.ts";
import { parseRung } from "../../src/domain/ids.ts";
import { configDir, dataDir } from "../../src/infra/paths.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { withCursorScenario } from "../sim/sim-scenarios.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "cursor");
const SIM = join(import.meta.dir, "..", "sim", "cursor-agent");
/** The simulators, Bun and the system tools, and nothing of this machine's own: its `agent` may be anyone's. */
const SIMS = [dirname(SIM), dirname(process.execPath), "/usr/bin", "/bin"].join(":");
const lines = (n: string) =>
  readFileSync(join(FX, n), "utf8")
    .split("\n")
    .filter((l) => l.trim());
afterEach(snapshotEnv());
afterEach(() => {
  cursorShell.timeoutMs = 15_000;
});

const req = (over: Partial<RunRequest> = {}): RunRequest => ({
  rung: parseRung("cursor:gpt-6-sol#high"),
  access: "workspace-write",
  thread: null,
  isolated: false,
  repo: "/repo",
  briefPath: "/d/brief.md",
  replyPath: "/d/reply.md",
  dispatchDir: "/d",
  ...over,
});

const finished = (eventLines: string[], over: Partial<FinishedRun> = {}): FinishedRun => ({
  request: req(),
  eventLines,
  reply: "",
  stderr: "",
  exit: { code: 0, signal: null, reason: "exited", endedAt: "2026-09-29T00:00:00.000Z" },
  startedAtMs: 0,
  ...over,
});

async function code(p: Promise<unknown> | undefined): Promise<string> {
  try {
    await p;
  } catch (e) {
    return isCatherdError(e) ? e.code : String(e);
  }
  return "ok";
}

/** A PATH holding `name` (a link to the simulator, or a script), the simulators and Bun, for the shebangs. */
function pathWith(name: string, target: string | null, script?: string, sims = false): string {
  const dir = mkdtempSync(join(tmpdir(), "catherd-bin-"));
  if (target) symlinkSync(target, join(dir, name));
  else {
    writeFileSync(join(dir, name), script ?? "");
    chmodSync(join(dir, name), 0o755);
  }
  return [dir, ...(sims ? [dirname(SIM)] : []), dirname(process.execPath), "/usr/bin", "/bin"].join(":");
}

const ANOTHER_AGENT = "#!/bin/sh\necho 'agent 1.0.44 (grok)'\n";

describe("cursor plan (spec 1.3 §4.2, §4.3)", () => {
  it("prints stream-json in the trusted repo, with the effort's slug, auto-update off and the brief on stdin", () => {
    process.env.PATH = SIMS;
    expect(cursorAdapter.plan(req())).toEqual({
      cmd: "cursor-agent",
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--trust",
        "--workspace",
        "/repo",
        "--model",
        "gpt-6-sol-high",
        "--disable-auto-update",
        "--sandbox",
        "enabled",
      ],
      env: { NO_OPEN_BROWSER: "1" },
      cwd: "/repo",
      stdinPath: "/d/brief.md",
    });
  });

  it("maps each access, never --force inside the sandbox, runs #default as the bare slug and resumes a chat", () => {
    expect(CURSOR_ACCESS).toEqual({
      "read-only": ["--mode", "ask", "--sandbox", "enabled"],
      "workspace-write": ["--sandbox", "enabled"],
      full: ["--force", "--sandbox", "disabled", "--approve-mcps"],
    });
    for (const access of ["read-only", "workspace-write"] as const)
      expect(cursorAdapter.plan(req({ access })).args).not.toContain("--force");
    const thread = "5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716";
    const p = cursorAdapter.plan(req({ rung: parseRung("cursor:composer-2.5#default"), thread }));
    expect(p.args[p.args.indexOf("--model") + 1]).toBe("composer-2.5");
    expect(p.args.slice(-2)).toEqual(["--resume", thread]);
  });

  it("isolates with catherd's own HOME per access, Cursor's dirs inside it, and catherd's dirs kept", () => {
    withHome();
    const env = cursorAdapter.plan(req({ isolated: true })).env;
    const home = isolatedCursorHome("workspace-write", true);
    expect(home).toBe(join(isolatedCursorRoot(), "workspace-write"));
    expect(env).toMatchObject({
      NO_OPEN_BROWSER: "1",
      HOME: home,
      CURSOR_CONFIG_DIR: join(home, ".cursor"),
      CURSOR_DATA_DIR: join(home, ".cursor"),
      CATHERD_CONFIG_DIR: configDir(),
      CATHERD_DATA_DIR: dataDir(),
    });
    expect(cursorAdapter.plan(req({ isolated: true, network: false })).env.HOME).toBe(
      join(isolatedCursorRoot(), "workspace-write-offline"),
    );
    expect(cursorAdapter.plan(req({ isolated: true, access: "read-only" })).env.HOME).toBe(
      join(isolatedCursorRoot(), "read-only"),
    );
    expect(existsSync(isolatedCursorRoot())).toBe(false); // plan writes nothing; prepare makes it
  });

  it("falls back to `agent` only when there is no cursor-agent on PATH", () => {
    process.env.PATH = pathWith("agent", SIM);
    expect(cursorBin()).toBe("agent");
    expect(cursorAdapter.plan(req()).cmd).toBe("agent");
  });
});

describe("cursor finalize (spec 1.3 §4.5)", () => {
  it("records the text after the last tool call as the reply, never the run-together result text", () => {
    const o = cursorAdapter.finalize(finished(lines("ok.jsonl")));
    expect(o).toMatchObject({
      status: "ok",
      reply: "Done.\nSTATUS: complete — wrote src/a.ts",
      costUsd: null,
    });
  });

  it("is ok once a result arrived, though catherd killed the lingering CLI after it", () => {
    const o = cursorAdapter.finalize(
      finished(lines("ok.jsonl"), {
        exit: { code: null, signal: "SIGTERM", reason: "exited", endedAt: "x" },
      }),
    );
    expect(o.status).toBe("ok");
  });

  it("says why a run with no result failed, keeps the request's thread, and gives a missing login its fix", () => {
    const thread = "5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716";
    const auth = cursorAdapter.finalize(
      finished([], {
        request: req({ thread }),
        stderr:
          "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\n",
        exit: { code: 1, signal: null, reason: "exited", endedAt: "x" },
      }),
    );
    expect(auth).toMatchObject({
      status: "failed",
      thread,
      error: {
        code: "failed",
        message:
          "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable. (fix: cursor-agent login, or export CURSOR_API_KEY=<key>)",
      },
    });
    expect(auth.reply).toBeUndefined();
    const none = cursorAdapter.finalize(
      finished(lines("no-result.jsonl"), { exit: { code: 1, signal: null, reason: "exited", endedAt: "x" } }),
    );
    expect(none.error?.message).toBe("no result event (exited, exit 1)");
  });

  it("reads a limit, a team policy, a too-old client, a cancel and a timeout as such", () => {
    const at = (stderr: string, reason: "exited" | "cancelled" | "idle-timeout" = "exited") =>
      cursorAdapter.finalize(
        finished(lines("no-result.jsonl"), { stderr, exit: { code: 1, signal: null, reason, endedAt: "x" } }),
      ).status;
    expect(at("ActionRequiredError: FREE_USER_USAGE_LIMIT")).toBe("limit");
    expect(at("Error: Your team administrator has disabled the 'Run Everything' option.")).toBe("failed");
    expect(at("ActionRequiredError: OUTDATED_CLIENT")).toBe("cli-too-old");
    expect(at("", "cancelled")).toBe("cancelled");
    expect(at("", "idle-timeout")).toBe("timeout");
  });
});

describe("cursor parse (spec 1.3 §4.5)", () => {
  it("marks the result final with its tokens, and a limit in a failed result", () => {
    expect(cursorAdapter.parse(lines("ok.jsonl").at(-1) as string)).toMatchObject({
      final: true,
      thread: "2b7c9e41-5d3a-4f86-9c1e-7a0b3d5e8f21",
      tokens: { input: 15989, cached: 9728, output: 25 },
    });
    expect(
      cursorAdapter.parse(
        JSON.stringify({ type: "result", is_error: true, result: "You've hit your usage limit" }),
      ),
    ).toMatchObject({ final: true, limit: true, failure: "You've hit your usage limit" });
  });

  it("reports tool calls opening and closing, a retry, and what the worker is doing", () => {
    const l = lines("ok.jsonl");
    expect(cursorAdapter.parse(l[10] as string)).toMatchObject({
      item: { id: "toolu_03", open: true },
      activity: "$ bun test",
    });
    expect(cursorAdapter.parse(l[11] as string)).toMatchObject({ item: { id: "toolu_03", open: false } });
    expect(cursorAdapter.parse(l[8] as string)).toMatchObject({
      retrying: true,
      lastEvent: "retry/starting",
    });
    const thinking = cursorAdapter.parse(l[2] as string);
    expect([thinking.item, thinking.activity, thinking.final]).toEqual([undefined, undefined, undefined]);
  });
});

describe("cursor probe (spec 1.3 §4.1, §3.3)", () => {
  it("reads the version and a login that answers `models`, without a browser", async () => {
    process.env.PATH = SIMS;
    delete process.env.CURSOR_API_KEY;
    Object.assign(process.env, withCursorScenario({ modelsFile: join(FX, "models.txt") }).env);
    expect(await cursorAdapter.probe()).toEqual({
      installed: true,
      version: "2026.09.28",
      versionOk: true,
      loggedIn: true,
      login: "Cursor login",
      problems: [],
    });
    process.env.CURSOR_API_KEY = "key-for-test";
    expect(await cursorAdapter.probe()).toMatchObject({ login: "API key", billing: "metered" });
  });

  it("reports a CLI too old, and one whose server calls say it is logged out, each with its fix", async () => {
    process.env.PATH = SIMS;
    delete process.env.CURSOR_API_KEY;
    Object.assign(process.env, withCursorScenario({ version: "2026.06.04-5fd875e", loggedIn: false }).env);
    const p = await cursorAdapter.probe();
    expect(p).toMatchObject({ installed: true, version: "2026.06.04", versionOk: false, loggedIn: false });
    expect(p.problems.map((x) => [x.code, x.message, x.fix])).toEqual([
      ["E_BACKEND_TOO_OLD", "cursor-agent 2026.06.04 is older than 2026.09.28", "cursor-agent update"],
      [
        "E_BACKEND_NOT_LOGGED_IN",
        "cursor-agent is not logged in (a server call says: Authentication required)",
        "cursor-agent login, or export CURSOR_API_KEY=<key>",
      ],
    ]);
  });

  it("does not take another program named agent for Cursor's CLI, and says so when both are there", async () => {
    process.env.PATH = pathWith("agent", null, ANOTHER_AGENT);
    const p = await cursorAdapter.probe();
    expect(p.installed).toBe(false);
    expect(p.problems[0]).toMatchObject({
      code: "E_BACKEND_MISSING",
      message: "the agent on PATH is not Cursor's CLI (it says: agent 1.0.44 (grok))",
      fix: "curl https://cursor.com/install -fsS | bash",
    });
    process.env.PATH = "/nonexistent";
    expect((await cursorAdapter.probe()).problems[0]?.message).toBe("cursor-agent is not on PATH");
    // cursor-agent is Cursor, `agent` another program: an info line, nothing to fix, and `agent` never runs
    process.env.PATH = pathWith("agent", null, "#!/bin/sh\nexit 99\n", true);
    Object.assign(process.env, withCursorScenario({ modelsFile: join(FX, "models.txt") }).env);
    const other = realpathSync(Bun.which("agent", { PATH: process.env.PATH }) as string);
    const both = await cursorAdapter.probe();
    expect(both.problems).toEqual([]);
    expect(both.info).toEqual([
      {
        id: "name:agent",
        label: "agent",
        detail: `the agent on PATH (${other}) is another program than cursor-agent; catherd runs cursor-agent`,
      },
    ]);
    // the installer links both names to one binary: nothing to say
    process.env.PATH = pathWith("agent", SIM, undefined, true);
    expect((await cursorAdapter.probe()).info).toBeUndefined();
  });
});

describe("cursor models and prepare (spec 1.3 §4.6, §4.4)", () => {
  it("lists models from `models`, efforts folded", async () => {
    process.env.PATH = SIMS;
    Object.assign(process.env, withCursorScenario({ modelsFile: join(FX, "models.txt") }).env);
    const models = await cursorAdapter.listModels();
    expect(models.find((m) => m.id === "gpt-6-sol")?.efforts).toEqual(["default", "low", "high", "xhigh"]);
  });

  it("refuses a slug Cursor does not list, before anything runs, and caches the listing", async () => {
    withHome();
    process.env.PATH = SIMS;
    Object.assign(process.env, withCursorScenario({ modelsFile: join(FX, "models.txt") }).env);
    const prep = (rung: string) =>
      code(
        cursorAdapter.prepare?.({
          rung: parseRung(rung),
          access: "workspace-write",
          isolated: false,
          repo: "/r",
        }),
      );
    expect(await prep("cursor:gpt-6-sol#xhigh")).toBe("ok");
    expect(await prep("cursor:gpt-6-sol#medium")).toBe("E_BACKEND_MODEL_UNKNOWN");
    expect(await prep("cursor:gpt-6-luna#default")).toBe("E_BACKEND_MODEL_UNKNOWN");
    expect(await prep("cursor:gpt-9#high")).toBe("E_BACKEND_MODEL_UNKNOWN");
    expect(readDiscovery("cursor")?.models.length).toBe(8);
  });

  it("lets a rung through when Cursor lists nothing", async () => {
    withHome();
    process.env.PATH = SIMS;
    Object.assign(process.env, withCursorScenario({ modelsExit: 1 }).env);
    const r = cursorAdapter.prepare?.({
      rung: parseRung("cursor:gpt-9#high"),
      access: "read-only",
      isolated: false,
      repo: "/r",
    });
    expect(await code(r)).toBe("ok");
  });

  it("needs CURSOR_API_KEY to isolate, and writes each isolated home's sandbox.json with a shared chats dir", async () => {
    withHome();
    process.env.PATH = SIMS;
    Object.assign(process.env, withCursorScenario({ modelsFile: join(FX, "models.txt") }).env);
    delete process.env.CURSOR_API_KEY;
    const prep = (access: "read-only" | "workspace-write" | "full", network = true) =>
      code(
        cursorAdapter.prepare?.({
          rung: parseRung("cursor:gpt-6-sol#high"),
          access,
          isolated: true,
          repo: "/r",
          network,
        }),
      );
    expect(await prep("workspace-write")).toBe("E_BACKEND_NOT_LOGGED_IN");
    expect(existsSync(isolatedCursorRoot())).toBe(false);
    process.env.CURSOR_API_KEY = "key-for-test";
    const policy = (access: "read-only" | "workspace-write", network = true) =>
      JSON.parse(readFileSync(join(isolatedCursorHome(access, network), ".cursor", "sandbox.json"), "utf8"));
    expect(await prep("workspace-write")).toBe("ok");
    expect(policy("workspace-write")).toEqual({
      type: "workspace_readwrite",
      additionalReadwritePaths: writableRoots(),
      networkPolicy: { default: "allow" },
    });
    expect(await prep("workspace-write", false)).toBe("ok");
    expect(policy("workspace-write", false)).toEqual({
      type: "workspace_readwrite",
      additionalReadwritePaths: writableRoots(),
    });
    expect(await prep("read-only")).toBe("ok");
    expect(policy("read-only")).toEqual({ type: "workspace_readonly" });
    expect(await prep("full")).toBe("ok");
    expect(existsSync(join(isolatedCursorHome("full", true), ".cursor", "sandbox.json"))).toBe(false);
    // a resume under another access finds its chat: every isolated home shares one chats dir
    const chats = join(isolatedCursorHome("read-only", true), ".cursor", "chats");
    expect(lstatSync(chats).isSymbolicLink()).toBe(true);
    expect(readlinkSync(chats)).toBe(join(isolatedCursorRoot(), "chats"));
    expect(await prep("read-only")).toBe("ok"); // again: the link stays
  });
});

describe("cursor access probes (spec 1.3 §4.7, §3.4)", () => {
  it("runs doctor's probes through the hidden `cursor-agent sandbox run`, naming the sandbox.json fixes", async () => {
    process.env.PATH = SIMS;
    const argsTo = join(mkdtempSync(join(tmpdir(), "catherd-sbx-")), "args.jsonl");
    Object.assign(process.env, withCursorScenario({ sandboxArgsTo: argsTo }).env);
    const shell = (await cursorAdapter.accessShell?.({ network: true })) as AccessShell;
    expect(shell.how).toBe("Cursor's sandbox (cursor-agent sandbox run)");
    expect((await shell.run('echo "$1"', ["hi"]))?.out).toBe("hi\n");
    shell.close();
    expect(JSON.parse(readFileSync(argsTo, "utf8").trim().split("\n").at(-1) as string)).toEqual([
      "sandbox",
      "run",
      "--",
      "sh",
      "-c",
      'echo "$1"',
      "_",
      "hi",
    ]);
    expect(shell.fixes?.lock).toContain("additionalReadwritePaths");
    expect(shell.fixes?.https).toContain("networkPolicy");
  });

  it("says why when this Cursor has no sandbox runner", async () => {
    process.env.PATH = SIMS;
    Object.assign(process.env, withCursorScenario({ sandbox: "missing" }).env);
    expect(await cursorAdapter.accessShell?.({ network: true })).toBe(
      "no Cursor sandbox runner here: cursor-agent sandbox run (hidden) did not run `true`",
    );
  });
});
````

Modify `test/services/adapter-hooks.test.ts`:

````diff
@@ -143,6 +143,7 @@ describe("prepare", () => {
         access: "workspace-write",
         isolated: false,
         repo: run.meta.repo,
+        network: true,
       },
     ]);
     expect(existsSync(roleDir(run, "worker-1"))).toBe(false);
````

- [ ] **Step 2: Run them to see them fail**

Run: `env -u FORCE_COLOR bun test test/adapters/cursor.contract.test.ts test/adapters/cursor.test.ts test/services/adapter-hooks.test.ts`
Expected: FAIL: `src/adapters/cursor/index.ts` does not exist.

- [ ] **Step 3: Implement**

Modify `src/adapters/backend.ts`:

````diff
@@ -16,6 +16,8 @@ export interface Probe {
   /** the billing mode that login implies, when it implies one: doctor compares it with the profiles' */
   billing?: BillingMode;
   problems: { code: ErrorCode; message: string; fix: string }[];
+  /** what doctor shows as information, nothing to fix (spec 1.3 §4.7: an `agent` on PATH that is not Cursor) */
+  info?: { id: string; label: string; detail: string }[];
 }
 
 /** Doctor's five access probes (spec 1.1 §5). */
@@ -124,7 +126,13 @@ export interface BackendAdapter {
    * Refuses a rung this backend cannot run and readies the backend's own config, before admission writes
    * anything (spec §6.3: variants are validated before dispatch). Throws a CatherdError.
    */
-  prepare?(req: { rung: Rung; access: Access; isolated: boolean; repo: string }): Promise<void>;
+  prepare?(req: {
+    rung: Rung;
+    access: Access;
+    isolated: boolean;
+    repo: string;
+    network?: boolean;
+  }): Promise<void>;
   plan(req: RunRequest): SpawnPlan;
   parse(line: string): EventDelta;
   finalize(run: FinishedRun): Outcome;
````

Create `src/adapters/cursor/home.ts`:

````ts
import { lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import type { Access } from "../../domain/record.ts";
import { dataDir } from "../../infra/paths.ts";
import { ensurePrivateDir, writeJsonAtomic } from "../../infra/store.ts";
import { movedHomeEnv, writableRoots } from "../access.ts";

/** Where isolated Cursor runs keep their homes; computing it creates nothing. */
export const isolatedCursorRoot = (): string => join(dataDir(), "cursor-home");

/**
 * Spec 1.3 §4.3–§4.4: an isolated run's HOME. Cursor reads its sandbox policy from one `sandbox.json` per home,
 * so each access (and a workspace-write role without network) gets its own home: lanes of different access
 * run side by side without rewriting each other's policy.
 */
export const isolatedCursorHome = (access: Access, network = true): string =>
  join(isolatedCursorRoot(), access === "workspace-write" && !network ? "workspace-write-offline" : access);

/**
 * The env of an isolated run: the moved HOME (the only thing that stops Cursor's hard-coded `~/.claude`,
 * `~/.codex`, `~/.grok` and `~/.agents` reads, research §2.8), and Cursor's config and data dirs inside it, so a
 * CURSOR_CONFIG_DIR or XDG_CONFIG_HOME of the user's cannot point it back.
 */
export function cursorHomeEnv(access: Access, network = true): Record<string, string> {
  const home = isolatedCursorHome(access, network);
  const dot = join(home, ".cursor");
  return { ...movedHomeEnv(home), CURSOR_CONFIG_DIR: dot, CURSOR_DATA_DIR: dot };
}

/**
 * The `sandbox.json` of an isolated home (research §2.6): read-only is the kernel's `workspace_readonly`;
 * workspace-write adds catherd's writable roots and, unless the role has no network, allows it; `full` runs
 * with the sandbox off (`--force --sandbox disabled`) and needs none.
 */
export function cursorSandboxPolicy(access: Access, network = true): Record<string, unknown> | null {
  if (access === "read-only") return { type: "workspace_readonly" };
  if (access === "full") return null;
  return {
    type: "workspace_readwrite",
    additionalReadwritePaths: writableRoots(),
    ...(network ? { networkPolicy: { default: "allow" } } : {}),
  };
}

/**
 * Makes the isolated home for `access` and writes its `sandbox.json`. Every home links one shared `chats`
 * dir: Cursor looks a resumed chat up there, and an id it cannot find silently starts an empty chat
 * (research §2.5), so a thread resumed under another access must find it.
 */
export function prepareCursorHome(access: Access, network = true): string {
  const home = isolatedCursorHome(access, network);
  const dot = join(home, ".cursor");
  ensurePrivateDir(dot);
  const chats = join(isolatedCursorRoot(), "chats");
  mkdirSync(chats, { recursive: true, mode: 0o700 });
  if (!lstatSync(join(dot, "chats"), { throwIfNoEntry: false })) symlinkSync(chats, join(dot, "chats"));
  const policy = cursorSandboxPolicy(access, network);
  if (policy) writeJsonAtomic(join(dot, "sandbox.json"), policy);
  return home;
}
````

Create `src/adapters/cursor/index.ts`:

````ts
import { realpathSync } from "node:fs";
import { CatherdError } from "../../domain/errors.ts";
import type { Rung } from "../../domain/ids.ts";
import type { Access, RunStatus } from "../../domain/record.ts";
import { scratchShell } from "../access.ts";
import {
  type AccessShell,
  type BackendAdapter,
  compareVersions,
  type DiscoveredModel,
  type EventDelta,
  extractVersion,
  type FinishedRun,
  type Outcome,
  type Probe,
  type RunRequest,
  type SpawnPlan,
} from "../backend.ts";
import { runCli } from "../cli.ts";
import { discovered } from "../discovery.ts";
import {
  CURSOR_LIMIT,
  CURSOR_TOO_OLD,
  cursorActivity,
  cursorTokens,
  eventName,
  foldCursorEvents,
  isAuthFailure,
  isLimit,
  isTooOld,
  parseCursorLine,
} from "./events.ts";
import { cursorHomeEnv, prepareCursorHome } from "./home.ts";
import { cursorSlug, parseCursorModels } from "./models.ts";

export { isolatedCursorHome, isolatedCursorRoot } from "./home.ts";

/** Spec 1.3 §4.1: the version whose help and bundle were read; 2026.06.04 lacks `--add-dir` and more. */
export const CURSOR_MIN_VERSION = "2026.09.28";
export const CURSOR_INSTALL = "curl https://cursor.com/install -fsS | bash";
const THREAD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Cursor's versions are a date and a hash (`2026.09.28-64d2043`); grok's `agent` prints `grok 1.0.44 (…)`. */
const CURSOR_VERSION = /^\s*\d{4}\.\d{1,2}\.\d{1,2}-[0-9a-f]+\b/;
const DAY_MS = 24 * 60 * 60_000;
const LOGIN_FIX = "cursor-agent login, or export CURSOR_API_KEY=<key>";

/** How long a `cursor-agent` query (version, models, a sandbox probe's `true`) may take before it counts as failed. */
export const cursorShell = { timeoutMs: 15_000 };

const which = (bin: string): string | null => Bun.which(bin, { PATH: process.env.PATH ?? "" });

/**
 * Spec 1.3 §4.1: `cursor-agent` first. The installers of Cursor and grok both link `agent` (research §2.1,
 * §3.1), so `agent` is taken only when `cursor-agent` is missing, and the probe checks what it is.
 */
export function cursorBin(): "cursor-agent" | "agent" {
  return which("cursor-agent") ? "cursor-agent" : "agent";
}

/**
 * Spec 1.3 §4.3. Headless without `--force` rejects every approval, and `--sandbox enabled` runs sandboxable
 * commands without one (research §2.6); `--force` turns the sandbox off, so only `full` passes it.
 */
export const CURSOR_ACCESS: Record<Access, string[]> = {
  "read-only": ["--mode", "ask", "--sandbox", "enabled"],
  "workspace-write": ["--sandbox", "enabled"],
  full: ["--force", "--sandbox", "disabled", "--approve-mcps"],
};

function plan(r: RunRequest): SpawnPlan {
  if (r.thread !== null && !THREAD.test(r.thread))
    throw new CatherdError("E_ADMIT_THREAD", `"${r.thread}" is not a Cursor chat id`, {
      fix: "pass the thread from the earlier RunRecord",
    });
  return {
    cmd: cursorBin(),
    args: [
      "-p",
      "--output-format",
      "stream-json",
      "--trust",
      "--workspace",
      r.repo,
      "--model",
      cursorSlug(r.rung.model, r.rung.effort),
      // hidden (research §2.1): no env var turns the self-update off, and it must not swap the binary mid-run
      "--disable-auto-update",
      ...CURSOR_ACCESS[r.access],
      // a resume runs in the recorded repo: Cursor looks a chat up by its cwd (research §2.5)
      ...(r.thread === null ? [] : ["--resume", r.thread]),
    ],
    env: {
      NO_OPEN_BROWSER: "1",
      ...(r.isolated ? cursorHomeEnv(r.access, r.network !== false) : {}),
    },
    cwd: r.repo,
    // research §2.2: stdin is read to EOF when no positional prompt is given
    stdinPath: r.briefPath,
  };
}

async function listModels(): Promise<DiscoveredModel[]> {
  const r = await runCli(cursorBin(), ["models"], { ...cursorShell, env: { NO_OPEN_BROWSER: "1" } });
  return r?.ok ? parseCursorModels(r.out) : [];
}

/**
 * Spec 1.3 §4.4, §4.6: an isolated run needs CURSOR_API_KEY (its HOME holds no login) and gets its home and
 * `sandbox.json`; the rung's slug must be one Cursor lists: the model with that effort suffix, or the bare slug
 * for `#default`.
 */
async function prepare(req: {
  rung: Rung;
  access: Access;
  isolated: boolean;
  network?: boolean;
}): Promise<void> {
  if (req.isolated) {
    if (!process.env.CURSOR_API_KEY)
      throw new CatherdError("E_BACKEND_NOT_LOGGED_IN", "an isolated cursor run needs CURSOR_API_KEY", {
        fix: "export CURSOR_API_KEY=<key>, or catherd profile set harness.cursor.isolated false",
      });
    prepareCursorHome(req.access, req.network !== false);
  }
  const { model, effort } = req.rung;
  const models = await discovered("cursor", listModels, { maxAgeMs: DAY_MS, need: model });
  if (models.length === 0) return; // Cursor listed nothing: let the run itself say what is wrong
  const m = models.find((x) => x.id === model);
  if (!m)
    throw new CatherdError("E_BACKEND_MODEL_UNKNOWN", `Cursor does not list ${model}`, {
      fix: `run ${cursorBin()} models; a rung names the slug without its effort suffix`,
    });
  if (!m.efforts.includes(effort))
    throw new CatherdError("E_BACKEND_MODEL_UNKNOWN", `Cursor lists no ${cursorSlug(model, effort)}`, {
      fix: `use one of: ${m.efforts.map((e) => `cursor:${model}#${e}`).join(", ")}`,
    });
}

function finalize(run: FinishedRun): Outcome {
  const f = foldCursorEvents(run.eventLines);
  const res = f.result;
  const stopped = run.exit.reason;
  const said = [run.stderr, res?.isError ? res.text : ""].join("\n");
  const status: RunStatus =
    stopped === "cancelled"
      ? "cancelled"
      : stopped === "idle-timeout" || stopped === "wall-timeout"
        ? "timeout"
        : res !== null && !res.isError
          ? "ok"
          : isTooOld(said)
            ? "cli-too-old"
            : isLimit(said)
              ? "limit"
              : "failed";
  const lastErr = run.stderr.trim().split("\n").at(-1) ?? "";
  const message =
    res?.isError && res.text
      ? res.text
      : isAuthFailure(lastErr)
        ? `${lastErr} (fix: ${LOGIN_FIX})`
        : lastErr || `no result event (${stopped}, exit ${run.exit.code ?? run.exit.signal})`;
  return {
    status,
    thread: f.thread ?? run.request.thread,
    tokens: res?.tokens ?? cursorTokens(undefined),
    costUsd: null,
    images: [],
    error: status === "ok" ? null : { code: status, message },
    ...(status === "ok" ? { reply: f.reply ?? res?.text ?? "" } : {}),
  };
}

function parse(line: string): EventDelta {
  const e = parseCursorLine(line);
  if (!e) return {};
  const d: EventDelta = { lastEvent: eventName(e) };
  const activity = cursorActivity(e);
  if (activity) d.activity = activity;
  if (typeof e.session_id === "string" && e.session_id) d.thread = e.session_id;
  if (e.type === "retry" && e.subtype === "starting") d.retrying = true;
  // a tool call runs between its started and completed events, often printing nothing: the run is busy
  if (e.type === "tool_call" && typeof e.call_id === "string")
    d.item = { id: e.call_id, open: e.subtype === "started" };
  if (e.type === "result") {
    d.final = true;
    d.tokens = cursorTokens(e.usage);
    if (e.is_error === true) {
      d.failure = String(e.result ?? "error");
      if (isLimit(d.failure)) d.limit = true;
    }
  }
  return d;
}

const realOr = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/**
 * Spec 1.3 §4.1, §4.7. Installed: a `--version` in Cursor's date-hash form (an `agent` that prints another is
 * someone else's). Logged in: `models` answered; `status` reports token presence, not a working login
 * (research §2.9), and `models` fails fast, with no browser, when logged out. An `agent` that is another
 * program than `cursor-agent` is noted, never run.
 */
async function probe(): Promise<Probe> {
  const bin = cursorBin();
  let v: Awaited<ReturnType<typeof runCli>>;
  try {
    v = await runCli(bin, ["--version"], cursorShell);
  } catch (e) {
    // an `agent` that is not Cursor's may not even run here (the owner's is a Linux grok, research §3.1)
    if (bin === "agent") v = { ok: false, out: "", err: String(e) };
    else throw e;
  }
  if (!v || !CURSOR_VERSION.test(v.out)) {
    const says = (v?.out || v?.err || "").trim().split("\n")[0];
    return {
      installed: false,
      version: null,
      versionOk: false,
      loggedIn: null,
      problems: [
        {
          code: "E_BACKEND_MISSING",
          message: v
            ? `the ${bin} on PATH is not Cursor's CLI (it says: ${says})`
            : "cursor-agent is not on PATH",
          fix: CURSOR_INSTALL,
        },
      ],
    };
  }
  const version = extractVersion(v.out);
  const versionOk = version !== null && compareVersions(version, CURSOR_MIN_VERSION) >= 0;
  const m = await runCli(bin, ["models"], { ...cursorShell, env: { NO_OPEN_BROWSER: "1" } });
  const loggedIn = m?.ok ? true : isAuthFailure(`${m?.out ?? ""}\n${m?.err ?? ""}`) ? false : null;
  const apiKey = !!process.env.CURSOR_API_KEY;
  const problems: Probe["problems"] = [];
  if (!versionOk)
    problems.push({
      code: "E_BACKEND_TOO_OLD",
      message: `${bin} ${version ?? "?"} is older than ${CURSOR_MIN_VERSION}`,
      fix: `${bin} update`,
    });
  if (loggedIn === false)
    problems.push({
      code: "E_BACKEND_NOT_LOGGED_IN",
      message: `${bin} is not logged in (a server call says: Authentication required)`,
      fix: LOGIN_FIX,
    });
  const agent = bin === "cursor-agent" ? which("agent") : null;
  const other = agent && realOr(agent) !== realOr(which("cursor-agent") as string) ? realOr(agent) : null;
  return {
    installed: true,
    version,
    versionOk,
    loggedIn,
    ...(loggedIn ? { login: apiKey ? "API key" : "Cursor login" } : {}),
    // an API key bills at API rates; a Cursor login's billing is the profile's (spec 1.3 §9 Q4)
    ...(loggedIn && apiKey ? { billing: "metered" as const } : {}),
    problems,
    ...(other
      ? {
          info: [
            {
              id: "name:agent",
              label: "agent",
              detail: `the agent on PATH (${other}) is another program than cursor-agent; catherd runs cursor-agent`,
            },
          ],
        }
      : {}),
  };
}

/** How a native worker gets what Cursor's sandbox refused: its own sandbox.json, or catherd's when isolated. */
const SANDBOX_FIXES: AccessShell["fixes"] = {
  lock: "a native Cursor worker writes only where ~/.cursor/sandbox.json or the repo's .cursor/sandbox.json lets it: add the directory to additionalReadwritePaths there, or isolate cursor (harness.cursor.isolated), whose sandbox.json catherd writes",
  temp: "add the temp dir to additionalReadwritePaths in ~/.cursor/sandbox.json, or isolate cursor",
  loopback:
    "Cursor's sandbox blocks this bind: allow it in ~/.cursor/sandbox.json's networkPolicy, or isolate cursor",
  https:
    "Cursor's sandbox reaches only the domains networkPolicy allows: add the registry to networkPolicy.allow in ~/.cursor/sandbox.json, or isolate cursor",
  docker:
    "Cursor's sandbox cannot reach the Docker socket: run the Docker checks in the verifier (full access), or give the role full access",
};

/**
 * Spec 1.3 §4.7: doctor's probes run through the hidden `cursor-agent sandbox run`, which runs a command in
 * Cursor's sandbox with no model turn (research §2.6), under the user's own sandbox policy, as a native worker
 * runs.
 */
async function accessShell(): Promise<AccessShell | string> {
  const bin = cursorBin();
  const shell = scratchShell(`Cursor's sandbox (${bin} sandbox run)`, [bin, "sandbox", "run", "--"]);
  if ((await shell.run("true", []))?.ok) return { ...shell, fixes: SANDBOX_FIXES };
  shell.close();
  return `no Cursor sandbox runner here: ${bin} sandbox run (hidden) did not run \`true\``;
}

export const cursorAdapter: BackendAdapter = {
  id: "cursor",
  minVersion: CURSOR_MIN_VERSION,
  install: CURSOR_INSTALL,
  probe,
  listModels,
  prepare,
  plan,
  parse,
  finalize,
  // read-only is enforced by the kernel only in an isolated home's sandbox.json; native it is `--mode ask`
  enforcement: { "read-only": "advisory", "workspace-write": "enforced", full: "enforced" },
  errors: { limit: CURSOR_LIMIT, tooOld: CURSOR_TOO_OLD },
  // each run applies its own flags; "Resuming a conversation recomputes Run Everything" (research §2.5)
  resume: { supported: true, sameAccessOnly: false, threadPattern: THREAD },
  accessShell,
  isolationNote:
    "native Cursor loads your Claude Code hooks, skills, plugins and permission rules, and your Cursor User Rules; isolation cannot remove the User Rules",
  isolationKey: "CURSOR_API_KEY",
  // Cursor waits for background shells after its last turn, with no limit (research §2.10)
  graceAfterFinalMs: 30_000,
};
````

Modify `src/services/admission.ts`:

````diff
@@ -176,7 +176,13 @@ export async function admit(
   const dir = join(roleDir(run, i.name), id);
   const p = dispatchPaths(dir);
   const isolated = started?.isolated ?? profile.isolated[rung.backend] ?? false;
-  await prepared(adapter, { rung, access: rc.access, isolated, repo: run.meta.repo });
+  await prepared(adapter, {
+    rung,
+    access: rc.access,
+    isolated,
+    repo: run.meta.repo,
+    network: rc.network !== false,
+  });
   const plan = adapter.plan({
     rung,
     access: rc.access,
````

Modify `src/services/capture.ts`:

````diff
@@ -157,7 +157,7 @@ export async function captureOne(
     const briefPath = join(work, "brief.md");
     writeFileSync(briefPath, c.brief);
     const rung = parseRung(c.rung);
-    await adapter.prepare?.({ rung, access: c.access, isolated: true, repo });
+    await adapter.prepare?.({ rung, access: c.access, isolated: true, repo, network: true });
     const request: RunRequest = {
       rung,
       access: c.access,
````

- [ ] **Step 4: Run the tests and the checks**

Run: `env -u FORCE_COLOR bun test test/adapters/cursor.contract.test.ts test/adapters/cursor.test.ts test/services/adapter-hooks.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/backend.ts src/adapters/cursor/home.ts src/adapters/cursor/index.ts src/services/admission.ts src/services/capture.ts test/adapters/cursor.contract.test.ts test/adapters/cursor.test.ts test/services/adapter-hooks.test.ts
git commit -m "feat(cursor): the cursor adapter: plan, probe, prepare, finalize, access probes and contract suite"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 11: Grok, Composer and Gemini families, and Cursor ids for the shipped ones (spec 1.3 §7.1, §7.2; Rulings 16, 18, 19)

`catalog/models.json` gains `grok-4-7`, `grok-4-6`, `grok-4-5`, `composer-2-5`, `gemini-3-8-flash`, `gemini-3-7-flash`, `gemini-3-6-flash`, `gemini-3-1-pro` (vendor, release date, capabilities, price, `on.cursor`), and `on.cursor` on GPT-6 Sol, GPT-6 Luna and Claude Opus 5.5; `sources.cursor` says where they came from. `catalog/sources.json` gains the Gemini 3.1 Pro preview alias and the default efforts. `derive` keys an effortless family's values at `#default` (Ruling 18) and finds a family's models.dev facts under the vendor's own id (Ruling 19). Keep the families extensible: plans 16 and 17 add `on.grok` and `on.antigravity` to the same entries.

**Files:**

- Modify: `catalog/models.json`
- Modify: `catalog/sources.json`
- Regenerate: `docs/tui-frames.md`
- Modify: `src/services/source-derive.ts`
- Test: `test/domain/catalog.test.ts`
- Test: `test/domain/sources.test.ts`
- Regenerate: `test/entry/tui/__snapshots__/frames.test.tsx.snap`
- Test: `test/services/source-derive.test.ts`
- Test: `test/services/source-sync.test.ts`

**Interfaces:**
- Produces: the families; `modelsDevId` (internal to `source-derive.ts`).

- [ ] **Step 1: Write the failing tests**

Modify `test/domain/catalog.test.ts`:

````diff
@@ -33,6 +33,14 @@ describe("catalog/models.json", () => {
       "claude-sonnet-5-5",
       "claude-sonnet-5",
       "claude-haiku-4-5",
+      "grok-4-7",
+      "grok-4-6",
+      "grok-4-5",
+      "composer-2-5",
+      "gemini-3-8-flash",
+      "gemini-3-7-flash",
+      "gemini-3-6-flash",
+      "gemini-3-1-pro",
     ]);
     const sol = shippedModels().families.find((f) => f.id === "gpt-6-sol");
     expect(sol?.on.codex).toEqual({
@@ -124,6 +132,35 @@ describe("catalog/scores.json", () => {
   });
 });
 
+describe("Cursor's families (spec 1.3 §7.1)", () => {
+  const fam = (id: string) => shippedModels().families.find((f) => f.id === id);
+
+  it("gives the Grok, Composer and Gemini families a Cursor id, a keyless price and a release date", () => {
+    expect(fam("grok-4-7")).toMatchObject({
+      price: { input: 2, cached: 0.5, output: 6 },
+      releaseDate: "2026-09-21",
+      on: { cursor: { id: "grok-4.7", efforts: [], context: 200000 } },
+    });
+    expect(fam("gemini-3-1-pro")?.price).toEqual({ input: 2, cached: 0.2, output: 12 });
+    expect(fam("gemini-3-8-flash")?.on.cursor?.id).toBe("gemini-3.8-flash");
+    // no keyless source prices Composer: Grok 4.7's, the same Cursor pool, stands in
+    expect(fam("composer-2-5")?.price).toEqual(fam("grok-4-7")?.price);
+    expect(fam("composer-2-5")?.on.cursor).toEqual({ id: "composer-2.5", efforts: [], context: 200000 });
+  });
+
+  it("reads a Cursor slug as its family's canonical rung, the shipped families included", () => {
+    const c = shipped();
+    expect(rungInfo(c, "cursor:gpt-6-sol#xhigh")).toMatchObject({
+      key: "cursor",
+      canonical: "gpt-6-sol#xhigh",
+      efforts: ["low", "high", "xhigh"],
+    });
+    expect(rungInfo(c, "cursor:claude-opus-5-5-thinking#high").canonical).toBe("claude-opus-5-5#high");
+    expect(rungInfo(c, "cursor:composer-2.5#default").canonical).toBe("composer-2-5#default");
+    expect(rungInfo(c, "cursor:grok-4.7#default").family?.id).toBe("grok-4-7");
+  });
+});
+
 describe("rungInfo", () => {
   it("maps a backend's model id to its family and canonical rung", () => {
     const c = shipped();
````

Modify `test/domain/sources.test.ts`:

````diff
@@ -72,10 +72,24 @@ describe("id and effort mapping (spec 1.2 §3.4)", () => {
     expect(m.key("claude-4-5-haiku")).toBe("claude-haiku-4-5");
   });
 
+  it("maps the sources' Grok, Composer and Gemini names onto the 1.3 families (spec 1.3 §7.1)", () => {
+    const m = idMapper(shippedModels().families, sourcesFile().aliases);
+    const fam = (rung: string) => m.family(splitSourceRung(rung).id)?.id ?? null;
+    expect(fam("Grok 4.7#xhigh")).toBe("grok-4-7");
+    expect(fam("x-ai/grok-4.6")).toBe("grok-4-6");
+    expect(fam("grok-4.5")).toBe("grok-4-5");
+    expect(fam("Composer 2.5#none")).toBe("composer-2-5");
+    expect(fam("Gemini 3.8 Flash#high")).toBe("gemini-3-8-flash");
+    expect(fam("google/gemini-3.7-flash")).toBe("gemini-3-7-flash");
+    expect(fam("Gemini 3.1 Pro Preview")).toBe("gemini-3-1-pro");
+    expect(fam("gemini-3-1-pro-preview")).toBe("gemini-3-1-pro");
+    expect(fam("grok-build-0.1")).toBeNull();
+  });
+
   it("never guesses: an id with no family, alias or backend id maps to none", () => {
     const m = idMapper(shippedModels().families, sourcesFile().aliases);
     for (const id of [
-      "gemini-3.8-flash",
+      "gemini-3.9-flash",
       "claude-opus-5",
       "gpt-6-sol-pro",
       "openai/gpt-6-sol:batch",
````

Modify `test/services/source-derive.test.ts`:

````diff
@@ -12,15 +12,7 @@ const find = (d: ReturnType<typeof derive>, rung: string, dim: string, confidenc
 describe("id and effort mapping (spec 1.2 §3.4)", () => {
   it("lists every source id no family matched, never guessing one", () => {
     expect(keyless().unmatched).toEqual({
-      arena: [
-        "Claude Opus 5",
-        "Gemini 3.8 Flash",
-        "Kimi K3",
-        "claude-opus-5",
-        "glm-5.3",
-        "kimi-k3",
-        "muse-spark-1.3",
-      ],
+      arena: ["Claude Opus 5", "Kimi K3", "claude-opus-5", "glm-5.3", "kimi-k3", "muse-spark-1.3"],
       vectara: ["antgroup/finix_s1_32b", "google/gemini-2.5-pro", "openai/gpt-5.5"],
       epoch: ["claude-opus-5", "glm-5.3", "gpt-5.5", "kimi-k3"],
     });
@@ -42,6 +34,24 @@ describe("id and effort mapping (spec 1.2 §3.4)", () => {
   });
 });
 
+describe("a family with no effort (spec 1.3 §7.1)", () => {
+  it("keys every source value of an effortless family at #default, whatever effort the source names", () => {
+    const raw = rawAnswers(AT);
+    const arena = raw.arena?.data as Record<string, { rows: { row: Record<string, unknown> }[] }>;
+    const webdev = arena.webdev as { rows: { row: Record<string, unknown> }[] };
+    const like = webdev.rows[0]?.row as Record<string, unknown>;
+    webdev.rows.push({ row: { ...like, model_name: "Composer 2.5 (None)", rating: 1500 } });
+    const d = derive(raw, shippedContext(NOW));
+    expect(find(d, "composer-2-5#default", "frontend", "measured")).toEqual([
+      expect.objectContaining({ value: 1500, source: "arena" }),
+    ]);
+    expect(
+      d.scores.filter((s) => s.rung.startsWith("composer-2-5#") && s.rung !== "composer-2-5#default"),
+    ).toEqual([]);
+    expect(d.unmatched.arena).not.toContain("Composer 2.5");
+  });
+});
+
 describe("anchors and calibration (spec 1.2 §4.1, §4.2)", () => {
   it("takes the anchor's own values as measured", () => {
     expect(find(keyless(), "claude-opus-5-5#high", "agentic", "measured")).toEqual([
@@ -188,6 +198,22 @@ describe("catalog facts (spec 1.2 §3.5)", () => {
     });
   });
 
+  it("finds a family under the vendor's own dotted or aliased id (spec 1.3 §7.1)", () => {
+    const raw = rawAnswers(AT);
+    const md = raw["models-dev"]?.data as Record<string, { models: Record<string, unknown> }>;
+    const model = (input: number, output: number) => ({
+      reasoning: true,
+      tool_call: true,
+      release_date: "2026-09-02",
+      modalities: { input: ["text", "image"] },
+      cost: { input, output, cache_read: input / 10 },
+    });
+    md.google = { models: { "gemini-3.8-flash": model(0.75, 3.75), "gemini-3.1-pro-preview": model(2, 12) } };
+    const d = derive(raw, shippedContext(NOW));
+    expect(d.facts["gemini-3-8-flash"]?.price).toEqual({ input: 0.75, cached: 0.075, output: 3.75 });
+    expect(d.facts["gemini-3-1-pro"]?.price).toEqual({ input: 2, cached: 0.2, output: 12 });
+  });
+
   it("keeps the shipped file as the floor when laying the facts over the families", () => {
     const ctx = shippedContext(NOW);
     const facts = { "gpt-6-sol": { on: { opencode: { efforts: ["low", "turbo"] } }, speed: {} } };
````

Modify `test/services/source-sync.test.ts`:

````diff
@@ -96,7 +96,8 @@ describe("the sync (spec 1.2 §3.2, §3.3)", () => {
     const c = clock();
     // GPT-6 Luna has no Arena agent row in the recorded answers: this one gives Luna high its first agentic value
     const r = await syncSources({ transport: c.transport(withLunaAgent()), now: c.now, aaKey: null });
-    expect(r.newlyScored).toEqual([]);
+    // Gemini 3.8 Flash's family is new in 1.3: the weekly refresh ships its values, the recorded file has none
+    expect(r.newlyScored).toEqual(["gemini-3-8-flash#default"]);
     expect(loadCatalog({ timings: false }).scores["gpt-6-luna#high"]?.agentic).toMatchObject({
       value: 0.03,
       confidence: "measured",
````

- [ ] **Step 2: Run them to see them fail**

Run: `env -u FORCE_COLOR bun test test/domain/catalog.test.ts test/domain/sources.test.ts test/services/source-derive.test.ts test/services/source-sync.test.ts`
Expected: FAIL: the families are missing, Composer's rows key at `#none`, and Google's `gemini-3.8-flash` gives no facts.

- [ ] **Step 3: Implement**

Modify `catalog/models.json`:

````diff
@@ -1,10 +1,11 @@
 {
   "schema": 1,
-  "version": "2026-09-25",
+  "version": "2026-09-29",
   "sources": {
     "claude": "https://platform.claude.com/docs/en/models/overview (2026-09-25); efforts https://platform.claude.com/docs/en/build-with-claude/effort; prices https://platform.claude.com/docs/en/about-claude/pricing",
     "codex": "codex debug models --bundled, Codex CLI 0.157.0 (2026-09-25); prices https://developers.openai.com/api/docs/pricing; plan weights https://learn.chatgpt.com/docs/pricing",
-    "opencode": "opencode models <provider> --verbose on 1.18.32 and the v2 model.list (2026-09-25); https://opencode.ai/docs/zen, https://opencode.ai/docs/go"
+    "opencode": "opencode models <provider> --verbose on 1.18.32 and the v2 model.list (2026-09-25); https://opencode.ai/docs/zen, https://opencode.ai/docs/go",
+    "cursor": "cursor-agent models on 2026.09.28-64d2043 (research 2026-09-29 §2.4; ids to confirm in the live kit, docs/dev/live-verification.md §11); prices https://openrouter.ai/api/v1/models and https://models.dev/api.json (2026-09-28)"
   },
   "backends": {
     "codex": {
@@ -58,7 +59,8 @@
           "id": "opencode/gpt-6-sol",
           "efforts": ["none", "low", "medium", "high", "xhigh", "max"],
           "context": 1050000
-        }
+        },
+        "cursor": { "id": "gpt-6-sol", "efforts": ["low", "high", "xhigh"], "context": 200000 }
       },
       "notes": {
         "ultra": "maximum reasoning with automatic task delegation to parallel subagents; never in a default ladder"
@@ -87,7 +89,8 @@
           "id": "opencode-go/gpt-6-luna",
           "efforts": ["none", "low", "medium", "high", "xhigh", "max"],
           "context": 1050000
-        }
+        },
+        "cursor": { "id": "gpt-6-luna", "efforts": ["high"], "context": 200000 }
       }
     },
     {
@@ -205,7 +208,8 @@
           "id": "opencode/claude-opus-5-5",
           "efforts": ["low", "medium", "high", "xhigh", "max"],
           "context": 1000000
-        }
+        },
+        "cursor": { "id": "claude-opus-5-5-thinking", "efforts": ["high"], "context": 200000 }
       },
       "notes": { "effort": "the API default effort is medium" }
     },
@@ -261,6 +265,84 @@
         "opencode": { "id": "opencode/claude-haiku-4-5", "efforts": ["high", "max"], "context": 200000 }
       },
       "notes": { "effort": "no effort parameter in Claude Code: its only rung there is #default" }
+    },
+    {
+      "id": "grok-4-7",
+      "name": "Grok 4.7",
+      "vendor": "xai",
+      "releaseDate": "2026-09-21",
+      "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
+      "price": { "input": 2, "cached": 0.5, "output": 6 },
+      "on": { "cursor": { "id": "grok-4.7", "efforts": [], "context": 200000 } },
+      "notes": { "pool": "a Cursor Model in Cursor: billed from Cursor's own pool (research §2.4)" }
+    },
+    {
+      "id": "grok-4-6",
+      "name": "Grok 4.6",
+      "vendor": "xai",
+      "releaseDate": "2026-08-12",
+      "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
+      "price": { "input": 2, "cached": 0.5, "output": 6 },
+      "on": { "cursor": { "id": "grok-4.6", "efforts": [], "context": 200000 } },
+      "notes": { "pool": "a Cursor Model in Cursor: billed from Cursor's own pool (research §2.4)" }
+    },
+    {
+      "id": "grok-4-5",
+      "name": "Grok 4.5",
+      "vendor": "xai",
+      "releaseDate": "2026-07-08",
+      "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
+      "price": { "input": 2, "cached": 0.3, "output": 6 },
+      "on": { "cursor": { "id": "grok-4.5", "efforts": [], "context": 200000 } },
+      "notes": { "pool": "a Cursor Model in Cursor: billed from Cursor's own pool (research §2.4)" }
+    },
+    {
+      "id": "composer-2-5",
+      "name": "Composer 2.5",
+      "vendor": "cursor",
+      "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
+      "price": { "input": 2, "cached": 0.5, "output": 6 },
+      "on": { "cursor": { "id": "composer-2.5", "efforts": [], "context": 200000 } },
+      "notes": {
+        "price": "no keyless source prices Composer (research §5); Grok 4.7's, the same Cursor pool, stands in",
+        "effort": "no effort: its only rung is #default"
+      }
+    },
+    {
+      "id": "gemini-3-8-flash",
+      "name": "Gemini 3.8 Flash",
+      "vendor": "google",
+      "releaseDate": "2026-09-02",
+      "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
+      "price": { "input": 0.75, "cached": 0.075, "output": 3.75 },
+      "on": { "cursor": { "id": "gemini-3.8-flash", "efforts": [], "context": 200000 } }
+    },
+    {
+      "id": "gemini-3-7-flash",
+      "name": "Gemini 3.7 Flash",
+      "vendor": "google",
+      "releaseDate": "2026-08-13",
+      "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
+      "price": { "input": 0.75, "cached": 0.075, "output": 3.75 },
+      "on": { "cursor": { "id": "gemini-3.7-flash", "efforts": [], "context": 200000 } }
+    },
+    {
+      "id": "gemini-3-6-flash",
+      "name": "Gemini 3.6 Flash",
+      "vendor": "google",
+      "releaseDate": "2026-07-21",
+      "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
+      "price": { "input": 0.75, "cached": 0.075, "output": 3.75 },
+      "on": { "cursor": { "id": "gemini-3.6-flash", "efforts": [], "context": 200000 } }
+    },
+    {
+      "id": "gemini-3-1-pro",
+      "name": "Gemini 3.1 Pro",
+      "vendor": "google",
+      "releaseDate": "2026-02-19",
+      "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
+      "price": { "input": 2, "cached": 0.2, "output": 12 },
+      "on": { "cursor": { "id": "gemini-3.1-pro", "efforts": [], "context": 200000 } }
     }
   ]
 }
````

Modify `catalog/sources.json`:

````diff
@@ -69,7 +69,8 @@
   ],
   "aliases": {
     "claude-4-5-haiku": "claude-haiku-4-5",
-    "claude-haiku-4-5-20251001": "claude-haiku-4-5"
+    "claude-haiku-4-5-20251001": "claude-haiku-4-5",
+    "gemini-3.1-pro-preview": "gemini-3-1-pro"
   },
   "defaultEffort": {
     "gpt-6-astra": "medium",
@@ -82,6 +83,14 @@
     "claude-opus-5-5": "high",
     "claude-sonnet-5-5": "high",
     "claude-sonnet-5": "high",
-    "claude-haiku-4-5": "default"
+    "claude-haiku-4-5": "default",
+    "grok-4-7": "high",
+    "grok-4-6": "high",
+    "grok-4-5": "high",
+    "composer-2-5": "default",
+    "gemini-3-8-flash": "high",
+    "gemini-3-7-flash": "high",
+    "gemini-3-6-flash": "high",
+    "gemini-3-1-pro": "high"
   }
 }
````

`docs/tui-frames.md`: regenerate, do not hand-edit: `env -u FORCE_COLOR CATHERD_WRITE_FRAMES=1 bun test test/entry/tui/frames.test.tsx --update-snapshots` rewrites both the snapshot and `docs/tui-frames.md` (the catalog list gains the new rungs).

Modify `src/services/source-derive.ts`:

````diff
@@ -85,14 +85,22 @@ export function derive(raw: RawAnswers, ctx: DeriveContext): Derived {
       const { id, effort } = splitSourceRung(row.rung);
       const family = map.family(id);
       if (!family) (unmatched[source] ??= new Set()).add(id);
-      const e = effort ?? (family ? defaultEffortOf(ctx.sources, family) : "");
+      // spec 1.3 §7.1: a family with no effort (Composer) has one rung, #default, whatever effort a source names
+      const effortless = family !== null && familyEfforts(family).length === 0;
+      const e = effortless ? "default" : (effort ?? (family ? defaultEffortOf(ctx.sources, family) : ""));
       const key = `${map.key(family?.id ?? id)}#${e}`;
       const field = `${source}.${row.field}`;
       const at = table.get(field) ?? new Map<string, Keyed>();
       table.set(field, at);
       const had = at.get(key);
       if (!had || row.value > had.row.value)
-        at.set(key, { key, family, effort: e, assumed: effort === null && family !== null, row });
+        at.set(key, {
+          key,
+          family,
+          effort: e,
+          assumed: effort === null && family !== null && !effortless,
+          row,
+        });
     }
   const valuesOf = (f: FieldRef) =>
     new Map([...(table.get(`${f.source}.${f.field}`)?.values() ?? [])].map((k) => [k.key, k.row.value]));
@@ -261,7 +269,8 @@ function factsOf(
   for (const f of ctx.models.families) {
     const x: FamilyFacts = { on: {}, speed: {} };
     const vendor = (f as { vendor?: unknown }).vendor;
-    const own = md && typeof vendor === "string" ? modelsDevFacts(md, vendor, f.id) : null;
+    const own =
+      md && typeof vendor === "string" ? modelsDevFacts(md, vendor, modelsDevId(md, vendor, f, map)) : null;
     if (own?.price) x.price = own.price;
     if (own && own.toolUse !== null && own.imageIn !== null && own.reasoning !== null)
       x.capabilities = { toolUse: own.toolUse, imageIn: own.imageIn, reasoning: own.reasoning };
@@ -290,6 +299,15 @@ function factsOf(
   return { facts, warnings };
 }
 
+/**
+ * The id of `vendor`'s models.dev model that is `f`: its own id, else the first that maps to it (spec 1.3 §7.1:
+ * `gemini-3-8-flash` is Google's `gemini-3.8-flash`, `gemini-3-1-pro` its aliased `gemini-3.1-pro-preview`).
+ */
+function modelsDevId(md: unknown, vendor: string, f: Family, map: IdMapper): string {
+  const ids = Object.keys((md as Record<string, { models?: object }>)[vendor]?.models ?? {});
+  return ids.includes(f.id) ? f.id : (ids.find((id) => map.family(id) === f) ?? f.id);
+}
+
 /** The first entry of `list` whose id maps to `f` (OpenRouter's `:batch` variants never do). */
 const entryFor = <T extends { id: string }>(list: T[], f: Family, map: IdMapper): T | undefined =>
   list.find((m) => map.family(m.id) === f);
````

`test/entry/tui/__snapshots__/frames.test.tsx.snap`: regenerate, do not hand-edit: `env -u FORCE_COLOR CATHERD_WRITE_FRAMES=1 bun test test/entry/tui/frames.test.tsx --update-snapshots` rewrites both the snapshot and `docs/tui-frames.md` (the catalog list gains the new rungs).

- [ ] **Step 4: Run the tests and the checks**

Run: `env -u FORCE_COLOR bun test test/domain/catalog.test.ts test/domain/sources.test.ts test/services/source-derive.test.ts test/services/source-sync.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add catalog/models.json catalog/sources.json docs/tui-frames.md src/services/source-derive.ts test/domain/catalog.test.ts test/domain/sources.test.ts test/entry/tui/__snapshots__/frames.test.tsx.snap test/services/source-derive.test.ts test/services/source-sync.test.ts
git commit -m "feat(catalog): grok, composer and gemini families, and cursor ids for the shipped ones" \
  -m "Spec 1.3 §7.1. An effortless family keys every source value at #default," \
  -m "and models.dev facts are found under the vendor's own dotted or aliased id."
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 12: Register the Cursor adapter, with doctor's info rows and a model with no effort (spec 1.3 §4.7; Rulings 12, 13, 17, 23)

`all.ts` registers `cursorAdapter`. Doctor adds a probe's `info` rows (state `info`) after its backend row. `catalogRungs` names `#default` for a model with no effort (Ruling 17). The probe's login word becomes `Cursor` (doctor reads "Cursor login"). Tests that used `cursor` as the backend without an adapter use `grok` (Ruling 23); `adapter-hooks.test.ts` restores the real Cursor adapter after its fake; doctor's machine gets a Cursor scenario; `test/services/cursor-dispatch.test.ts` runs dispatch end to end on the simulator.

**Files:**

- Modify: `src/adapters/all.ts`
- Modify: `src/adapters/cursor/index.ts`
- Modify: `src/domain/failover.ts`
- Modify: `src/services/doctor-backends.ts`
- Test: `test/adapters/cursor.test.ts`
- Test: `test/domain/failover.test.ts`
- Test: `test/entry/profile-command.test.ts`
- Test: `test/entry/tui/effects.test.ts`
- Test: `test/services/adapter-hooks.test.ts`
- Test: `test/services/admission.test.ts`
- Test: `test/services/budget-backends.test.ts`
- Test (new): `test/services/cursor-dispatch.test.ts`
- Test: `test/services/doctor.test.ts`

**Interfaces:**
- Produces: Cursor in the registry; doctor's `name:agent` row; `catalogRungs` with `#default`.

- [ ] **Step 1: Write the failing tests**

Modify `test/adapters/cursor.test.ts`:

````diff
@@ -251,7 +251,7 @@ describe("cursor probe (spec 1.3 §4.1, §3.3)", () => {
       version: "2026.09.28",
       versionOk: true,
       loggedIn: true,
-      login: "Cursor login",
+      login: "Cursor",
       problems: [],
     });
     process.env.CURSOR_API_KEY = "key-for-test";
````

Modify `test/domain/failover.test.ts`:

````diff
@@ -107,6 +107,9 @@ describe("catalogRungs", () => {
     expect(all).toContain("opencode:opencode-go/gpt-6-luna#high");
     expect(all).toContain("opencode:opencode/claude-opus-5-5#high");
     expect(all).toContain("opencode:opencode-go/glm-5.3#high");
+    // a model with no effort has one rung, #default (spec 1.3 §7.1)
+    expect(all).toContain("cursor:composer-2.5#default");
+    expect(all).toContain("claude-code:claude-haiku-4-5-20251001#default");
     expect(all).toContain(KIMI);
     expect(all.some((r) => r.startsWith("opencode:claude-opus-5-5#"))).toBe(false);
     expect(all).toEqual([...new Set(all)].sort());
````

Modify `test/entry/profile-command.test.ts`:

````diff
@@ -38,7 +38,8 @@ describe("catherd profile show", () => {
       "  codex:gpt-6-sol#medium → opencode:opencode-go/kimi-k3#max (scores borrowed from gpt-6-sol#medium)\n",
     );
     expect(r.out).not.toContain("treated like");
-    expect(r.out).not.toContain("cursor");
+    expect(r.out).toContain("harness codex native · claude-code native · opencode native · cursor native\n");
+    expect(r.out).not.toContain("grok");
   });
 
   it("marks a role whose network is off (spec §5)", () => {
````

Modify `test/entry/tui/effects.test.ts`:

````diff
@@ -216,7 +216,7 @@ describe("the live effects", () => {
   it("names the harnesses, the native agents and each rung's enforcement", () => {
     withHome();
     const fx = liveEffects();
-    expect([...fx.harnesses].sort()).toEqual(["claude-code", "codex", "opencode"]);
+    expect([...fx.harnesses].sort()).toEqual(["claude-code", "codex", "cursor", "opencode"]);
     const p = resolveProfile(defaultProfileDoc(), "default");
     expect(fx.agents(p)).toContain("catherd-default-architect-claude-opus-5-5-high");
     expect(fx.enforcement("codex:gpt-6-sol#high", "workspace-write")).toBe("enforced");
````

Modify `test/services/adapter-hooks.test.ts`:

````diff
@@ -2,6 +2,7 @@ import { afterEach, beforeEach, describe, expect, it } from "bun:test";
 import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
 import { join } from "node:path";
 import type { BackendAdapter, Outcome } from "../../src/adapters/backend.ts";
+import { cursorAdapter } from "../../src/adapters/cursor/index.ts";
 import { adapterFor, registerAdapter, unregisterAdapter } from "../../src/adapters/registry.ts";
 import { CatherdError, isCatherdError } from "../../src/domain/errors.ts";
 import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
@@ -28,7 +29,8 @@ import { deadProcess, fakeDeps, fakeDispatch, freshRun, makeRecord, testView, wa
 
 afterEach(snapshotEnv());
 afterEach(() => {
-  unregisterAdapter("cursor");
+  // the fake adapter stands under Cursor's id: put the real one back
+  registerAdapter(cursorAdapter);
   claimSeams.beforeTakeover = async () => {};
   settleLimits.timeoutMs = 20_000;
   settleLimits.claimMarginMs = 10_000;
````

Modify `test/services/admission.test.ts`:

````diff
@@ -114,10 +114,10 @@ describe("admission", () => {
       view: testView({ failover: { "codex:gpt-6-sol#high": "codex:gpt-6-astra#high" } }),
     });
     expect(await refusal(admit(deps, run, input({ rung: "codex:gpt-6-astra#high" })))).toBe("admitted");
-    // Cursor has no adapter until 1.1.
-    deps.view.roles.worker?.rungs.push("cursor:gpt-6-sol#default");
+    // Grok has no adapter until plan 16.
+    deps.view.roles.worker?.rungs.push("grok:grok-4.7#default");
     expect(
-      await refusal(admit(deps, run, input({ name: "w2", lane: null, rung: "cursor:gpt-6-sol#default" }))),
+      await refusal(admit(deps, run, input({ name: "w2", lane: null, rung: "grok:grok-4.7#default" }))),
     ).toBe("E_BACKEND_MISSING");
   });
 
````

Modify `test/services/budget-backends.test.ts`:

````diff
@@ -75,7 +75,7 @@ describe("readyAdapter", () => {
   it("refuses a backend with no adapter, and a CLI that is logged out or too old, with its fix", async () => {
     resetReadiness();
     process.env.PATH = simPath();
-    expect((await code(readyAdapter("cursor"))).code).toBe("E_BACKEND_MISSING"); // no adapter until 1.1
+    expect((await code(readyAdapter("grok"))).code).toBe("E_BACKEND_MISSING"); // no adapter until plan 16
     Object.assign(process.env, withScenario({ loggedIn: false }).env);
     expect(await code(readyAdapter("codex"))).toEqual({
       code: "E_BACKEND_NOT_LOGGED_IN",
````

Create `test/services/cursor-dispatch.test.ts`:

````ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedCursorHome } from "../../src/adapters/cursor/index.ts";
import { replyContract } from "../../src/domain/role-prompts.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { dispatch, type DispatchInput } from "../../src/services/dispatch-service.ts";
import { snapshotEnv } from "../helpers.ts";
import { simPath } from "../sim/scenario.ts";
import { type CursorScenario, withCursorScenario } from "../sim/sim-scenarios.ts";
import { fakeDeps, freshRun, runRole, testView, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "cursor");
const SOL = "cursor:gpt-6-sol#xhigh";

function setup(s: CursorScenario, rungs = [SOL]) {
  const { repo, run } = freshRun();
  process.env.PATH = simPath();
  delete process.env.CURSOR_API_KEY;
  const sim = withCursorScenario({ modelsFile: join(FX, "models.txt"), ...s });
  Object.assign(process.env, sim.env);
  writeLane(run, "M1.L1", ["src/a.ts"]);
  const view = testView();
  view.roles.worker = { enabled: true, access: "workspace-write", rungs };
  return { repo, run, sim, deps: fakeDeps({ view }) };
}

const input = (run: string, over: Partial<DispatchInput> = {}): DispatchInput => ({
  run,
  role: "worker",
  name: "worker-M1.L1",
  brief: "---\nRead lanes/M1.L1.md",
  rung: SOL,
  lane: "M1.L1",
  ...over,
});

describe("dispatch on cursor-agent (simulator)", () => {
  it("runs in the repo with the brief on stdin, the effort as the slug's suffix, and the result's tokens", async () => {
    const { repo, run, sim, deps } = setup({
      eventsFile: join(FX, "ok.jsonl"),
      touch: [{ path: "src/a.ts", content: "new" }],
    });
    const { record } = await runRole(deps, input(run.id));
    expect(record).toMatchObject({
      status: "ok",
      backend: "cursor",
      tokens: { input: 15989, cached: 9728, output: 25 },
      changedOwned: ["src/a.ts"],
      cliVersion: "2026.09.28",
    });
    expect(record.thread).toMatch(/^[0-9a-f-]{36}$/);
    expect(sim.recorded()).toMatchObject({
      stdin: `---\nRead lanes/M1.L1.md\n\n${replyContract("worker")}\n`,
    });
    expect(sim.recorded().args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--trust",
      "--workspace",
      repo,
      "--model",
      "gpt-6-sol-xhigh",
      "--disable-auto-update",
      "--sandbox",
      "enabled",
    ]);
    expect(sim.recorded().vars?.NO_OPEN_BROWSER).toBe("1");
  });

  it("refuses an effort Cursor does not list before anything runs", async () => {
    const { run, sim, deps } = setup({ eventsFile: join(FX, "ok.jsonl") }, ["cursor:gpt-6-sol#medium"]);
    const e = await dispatch(deps, input(run.id, { rung: "cursor:gpt-6-sol#medium" })).catch(
      (x: unknown) => x,
    );
    expect((e as { code?: string }).code).toBe("E_BACKEND_MODEL_UNKNOWN");
    expect(sim.ran()).toBe(false);
  });

  it("refuses an isolated run without CURSOR_API_KEY, and runs one with it under its own HOME", async () => {
    const { run, sim, deps } = setup({ eventsFile: join(FX, "ok.jsonl") });
    deps.view.isolated = { cursor: true };
    const e = await dispatch(deps, input(run.id)).catch((x: unknown) => x);
    expect((e as { code?: string }).code).toBe("E_BACKEND_NOT_LOGGED_IN");
    expect(sim.ran()).toBe(false);
    process.env.CURSOR_API_KEY = "k";
    const { record } = await runRole(deps, input(run.id, { name: "worker-M1.L1b" }));
    const home = isolatedCursorHome("workspace-write");
    expect(record).toMatchObject({ status: "ok", isolated: true });
    expect(sim.recorded().home).toBe(home);
    expect(JSON.parse(readFileSync(join(home, ".cursor", "sandbox.json"), "utf8"))).toMatchObject({
      type: "workspace_readwrite",
    });
    expect(existsSync(join(home, ".cursor", "chats"))).toBe(true);
  });

  it("records a usage limit as a limit, so failover can move the role", async () => {
    const { run, deps } = setup({
      eventsFile: join(FX, "no-result.jsonl"),
      exitCode: 1,
      stderr: "ActionRequiredError: You've hit your usage limit (PRO_USER_USAGE_LIMIT)\n",
    });
    const { record } = await runRole(deps, input(run.id));
    expect(record.status).toBe("limit");
  });
});
````

Modify `test/services/doctor.test.ts`:

````diff
@@ -24,7 +24,13 @@ import { configFile } from "../../src/services/profile-store.ts";
 import { fakeFetch } from "../fake-fetch.ts";
 import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
 import { type CodexScenario, withScenario } from "../sim/scenario.ts";
-import { type OpencodeScenario, withClaudeScenario, withOpencodeScenario } from "../sim/sim-scenarios.ts";
+import {
+  type CursorScenario,
+  type OpencodeScenario,
+  withClaudeScenario,
+  withCursorScenario,
+  withOpencodeScenario,
+} from "../sim/sim-scenarios.ts";
 
 afterEach(snapshotEnv());
 
@@ -48,7 +54,9 @@ const SIM = join(import.meta.dir, "..", "sim");
 const fx = (p: string) => JSON.parse(readFileSync(join(FX, p), "utf8"));
 
 /** A machine with the simulated CLIs `bins` on PATH (all three by default), the codex sandbox allowing writes. */
-function machine(o: { codex?: CodexScenario; opencode?: OpencodeScenario; bins?: string[] } = {}): string {
+function machine(
+  o: { codex?: CodexScenario; opencode?: OpencodeScenario; cursor?: CursorScenario; bins?: string[] } = {},
+): string {
   const home = withHome();
   process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
   delete process.env.TYPESAFE_API_KEY;
@@ -63,7 +71,9 @@ function machine(o: { codex?: CodexScenario; opencode?: OpencodeScenario; bins?:
     withScenario({ models: fx("codex/models.json"), sandbox: "allow", ...o.codex }).env,
     withClaudeScenario({}).env,
     withOpencodeScenario({ models: fx("opencode/models.json").data, ...o.opencode }).env,
+    withCursorScenario({ modelsFile: join(FX, "cursor", "models.txt"), ...o.cursor }).env,
   );
+  delete process.env.CURSOR_API_KEY;
   return home;
 }
 
@@ -104,6 +114,7 @@ describe("doctor", () => {
       "backend:codex": "ok ready",
       "backend:claude-code": "ok ready",
       "backend:opencode": "ok ready",
+      "backend:cursor": "skip missing",
       jev: "warn no key",
       sources: "info not synced",
       plugin: "ok ready",
@@ -121,6 +132,41 @@ describe("doctor", () => {
     expect(check(r, "access:full")?.detail).toBe("no sandbox for: verifier (default), ui-reviewer (default)");
   });
 
+  it("shows Cursor's CLI with its version, login and listing, and an agent on PATH that is not Cursor as info", async () => {
+    machine({ bins: ["codex", "claude", "opencode", "cursor-agent"] });
+    installPlugin(VERSION);
+    patchProfile("default", {});
+    const bin = process.env.PATH?.split(":")[0] as string;
+    writeFileSync(join(bin, "agent"), "#!/bin/sh\necho 'agent 1.0 (a build agent)'\n");
+    chmodSync(join(bin, "agent"), 0o755);
+    const r = await run();
+    expect(check(r, "backend:cursor")).toMatchObject({
+      state: "ok",
+      word: "ready",
+      detail: "2026.09.28 · Cursor login · 8 models",
+    });
+    expect(check(r, "name:agent")).toMatchObject({
+      label: "agent",
+      state: "info",
+      detail: expect.stringContaining("another program than cursor-agent"),
+    });
+    expect(r.ready).toBe(true);
+  });
+
+  it("fails a logged-out Cursor a role runs on, with the login fix", async () => {
+    machine({ bins: ["codex", "claude", "opencode", "cursor-agent"], cursor: { loggedIn: false } });
+    installPlugin(VERSION);
+    // Composer is unscored: its inferred stand-ins let the role run (spec 1.3 §7.2)
+    const saved = patchProfile("default", { roles: { writer: { rungs: ["cursor:composer-2.5#default"] } } });
+    expect(saved.saved).toBe(true);
+    const r = await run();
+    expect(check(r, "backend:cursor")).toMatchObject({
+      state: "fail",
+      word: "not logged in",
+      fix: "cursor-agent login, or export CURSOR_API_KEY=<key>",
+    });
+  });
+
   it("fails on a backend a role runs on, but only warns on one a failover stand-in alone uses", async () => {
     ready();
     process.env.PATH = process.env.PATH?.replace(/^[^:]+/, (bin) => {
````

- [ ] **Step 2: Run them to see them fail**

Run: `env -u FORCE_COLOR bun test test/adapters/cursor.test.ts test/domain/failover.test.ts test/entry/profile-command.test.ts test/entry/tui/effects.test.ts test/services/adapter-hooks.test.ts test/services/admission.test.ts test/services/budget-backends.test.ts test/services/cursor-dispatch.test.ts test/services/doctor.test.ts`
Expected: FAIL: doctor has no `backend:cursor` row, `name:agent` is missing, and a Composer-only writer is refused.

- [ ] **Step 3: Implement**

Modify `src/adapters/all.ts`:

````diff
@@ -1,8 +1,10 @@
 import { claudeCodeAdapter } from "./claude-code/index.ts";
 import { codexAdapter } from "./codex/index.ts";
+import { cursorAdapter } from "./cursor/index.ts";
 import { opencodeAdapter } from "./opencode/index.ts";
 import { registerAdapter } from "./registry.ts";
 
 registerAdapter(codexAdapter);
 registerAdapter(claudeCodeAdapter);
 registerAdapter(opencodeAdapter);
+registerAdapter(cursorAdapter);
````

Modify `src/adapters/cursor/index.ts`:

````diff
@@ -260,7 +260,7 @@ async function probe(): Promise<Probe> {
     version,
     versionOk,
     loggedIn,
-    ...(loggedIn ? { login: apiKey ? "API key" : "Cursor login" } : {}),
+    ...(loggedIn ? { login: apiKey ? "API key" : "Cursor" } : {}),
     // an API key bills at API rates; a Cursor login's billing is the profile's (spec 1.3 §9 Q4)
     ...(loggedIn && apiKey ? { billing: "metered" as const } : {}),
     problems,
````

Modify `src/domain/failover.ts`:

````diff
@@ -113,7 +113,8 @@ function effortGap(a: string, b: string): number {
 const BACKEND_OF_KEY: Record<string, string> = { "opencode-go": "opencode" };
 
 /**
- * Every rung the catalog knows how to name: each shipped family's model on each backend at each effort,
+ * Every rung the catalog knows how to name: each shipped family's model on each backend at each effort (at
+ * `#default` when it has none),
  * each listed model at each effort, and each treat-like whose model is an opencode id (`opencode-go/…`,
  * `opencode/…`), such as the shipped Kimi K3 stand-in. Sorted, without duplicates.
  */
@@ -122,7 +123,9 @@ export function catalogRungs(c: Catalog): string[] {
   for (const f of c.families)
     for (const [key, m] of Object.entries(f.on)) {
       if (!m) continue;
-      for (const e of m.efforts) out.add(`${BACKEND_OF_KEY[key] ?? key}:${m.id}#${e}`);
+      // a model with no effort has one rung, #default (Claude Code's Haiku, Cursor's Composer; spec 1.3 §7.1)
+      for (const e of m.efforts.length ? m.efforts : ["default"])
+        out.add(`${BACKEND_OF_KEY[key] ?? key}:${m.id}#${e}`);
     }
   for (const [backend, l] of Object.entries(c.listed))
     for (const m of l.models) for (const e of m.efforts) out.add(`${backend}:${m.id}#${e}`);
````

Modify `src/services/doctor-backends.ts`:

````diff
@@ -103,6 +103,9 @@ export async function backendChecks(
       ],
     }));
     if (probe.installed) installed?.add(id);
+    // spec 1.3 §4.7: what the probe found worth knowing, nothing to fix (an `agent` on PATH that is not Cursor)
+    for (const i of probe.info ?? [])
+      checks.push({ id: i.id, label: i.label, state: "info", word: "info", detail: i.detail });
     const problem = probe.problems[0];
     const use = used.get(id);
     if (!problem) {
````

- [ ] **Step 4: Run the tests and the checks**

Run: `env -u FORCE_COLOR bun test test/adapters/cursor.test.ts test/domain/failover.test.ts test/entry/profile-command.test.ts test/entry/tui/effects.test.ts test/services/adapter-hooks.test.ts test/services/admission.test.ts test/services/budget-backends.test.ts test/services/cursor-dispatch.test.ts test/services/doctor.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/all.ts src/adapters/cursor/index.ts src/domain/failover.ts src/services/doctor-backends.ts test/adapters/cursor.test.ts test/domain/failover.test.ts test/entry/profile-command.test.ts test/entry/tui/effects.test.ts test/services/adapter-hooks.test.ts test/services/admission.test.ts test/services/budget-backends.test.ts test/services/cursor-dispatch.test.ts test/services/doctor.test.ts
git commit -m "feat(cursor): register the cursor adapter, with doctor's info rows and a model with no effort" \
  -m "Spec 1.3 §4.7. catalogRungs names a model with no effort at #default," \
  -m "so Composer gets its inferred stand-ins."
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 13: Capture cases for Cursor's work, resume and ask mode, and a live test behind CATHERD_LIVE (spec 1.3 §4.7, §10; Ruling 24)

Three capture cases on `cursor:auto#default` (`auto` has no family; only the live kit and the capture run it): `ok` (write, read, shell; workspace-write), `resume` (hello, then a recall on the same chat), `read-only-write` (ask mode). `test/live/cursor.live.test.ts` (skipped unless `CATHERD_LIVE=1`; its isolated case also needs `CURSOR_API_KEY`) runs a write and a resume, ask mode, and an isolated run.

**Files:**

- Modify: `src/services/capture.ts`
- Test: `test/entry/capture-fixtures-command.test.ts`
- Test (new): `test/live/cursor.live.test.ts`
- Test: `test/services/capture.test.ts`

**Interfaces:**
- Produces: Cursor in `CAPTURE_BACKENDS`.

- [ ] **Step 1: Write the failing tests**

Modify `test/entry/capture-fixtures-command.test.ts`:

````diff
@@ -13,7 +13,7 @@ describe("catherd capture-fixtures", () => {
     });
     expect(p.exitCode).toBe(2);
     expect(p.stderr.toString()).toBe(
-      'error E_INPUT_INVALID: no capture cases for backend "grok"\nfix: catherd capture-fixtures --backend codex|claude-code|opencode\n',
+      'error E_INPUT_INVALID: no capture cases for backend "grok"\nfix: catherd capture-fixtures --backend codex|claude-code|opencode|cursor\n',
     );
   });
 
````

Create `test/live/cursor.live.test.ts`:

````ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resetReadiness } from "../../src/services/backends.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun, runRole, testView } from "../services/helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

// Spec 1.3 §4.7 and docs/dev/live-verification.md §11: a signed-in cursor-agent on PATH, `auto` (the cheapest
// model Cursor picks). Native: the owner's login and sandbox.json; set CURSOR_API_KEY to also run isolated.
const AUTO = "cursor:auto#default";

function live(access: "read-only" | "workspace-write", isolated = false) {
  const { repo, run } = freshRun("live cursor");
  const view = testView({ isolated: { cursor: isolated } });
  view.roles.worker = { enabled: true, access, rungs: [AUTO] };
  return { repo, run, deps: fakeDeps({ view }) };
}

const STATUS = "The last line of your reply is exactly: STATUS: complete — done";

describe.skipIf(!process.env.CATHERD_LIVE)("live cursor-agent", () => {
  it("writes in the repo on workspace-write, and resumes the chat it started (research §2.5)", async () => {
    const { repo, run, deps } = live("workspace-write");
    const first = await runRole(deps, {
      run: run.id,
      role: "worker",
      name: "worker-1",
      rung: AUTO,
      brief: `Create a file named out.txt containing the word hi. ${STATUS}`,
    });
    expect(first.record).toMatchObject({ status: "ok", replyStatus: "complete", backend: "cursor" });
    expect(first.record.tokens.input).toBeGreaterThan(0);
    expect(existsSync(join(repo, "out.txt"))).toBe(true);
    const again = await runRole(deps, {
      run: run.id,
      role: "worker",
      name: "worker-2",
      rung: AUTO,
      thread: first.record.thread ?? undefined,
      brief: `Which file did you create earlier in this chat? Name it. ${STATUS}`,
    });
    expect(again.record.thread).toBe(first.record.thread);
    expect(readFileSync(again.record.replyPath, "utf8")).toContain("out.txt");
  }, 600_000);

  it("keeps a read-only role from writing: ask mode (advisory)", async () => {
    const { repo, run, deps } = live("read-only");
    const { record } = await runRole(deps, {
      run: run.id,
      role: "worker",
      name: "worker-3",
      rung: AUTO,
      brief:
        "Create a file named out.txt containing hi. If you cannot, say why. The last line of your reply is: STATUS: complete|blocked — <why>",
    });
    expect(record.status).toBe("ok");
    expect(existsSync(join(repo, "out.txt"))).toBe(false);
  }, 300_000);

  it.skipIf(!process.env.CURSOR_API_KEY)(
    "runs isolated under catherd's own HOME with the API key",
    async () => {
      const { run, deps } = live("read-only", true);
      const { record } = await runRole(deps, {
        run: run.id,
        role: "worker",
        name: "worker-4",
        rung: AUTO,
        brief: `Reply with the word hello. ${STATUS}`,
      });
      expect(record).toMatchObject({ status: "ok", isolated: true });
    },
    300_000,
  );
});
````

Modify `test/services/capture.test.ts`:

````diff
@@ -9,7 +9,12 @@ import { resetReadiness } from "../../src/services/backends.ts";
 import { captureFixtures, captureOne } from "../../src/services/capture.ts";
 import { snapshotEnv, withHome } from "../helpers.ts";
 import { simPath } from "../sim/scenario.ts";
-import { type OpencodeModel, withClaudeScenario, withOpencodeScenario } from "../sim/sim-scenarios.ts";
+import {
+  type OpencodeModel,
+  withClaudeScenario,
+  withCursorScenario,
+  withOpencodeScenario,
+} from "../sim/sim-scenarios.ts";
 
 afterEach(snapshotEnv());
 beforeEach(() => {
@@ -80,6 +85,32 @@ describe("capture-fixtures", () => {
     );
   });
 
+  it("captures Cursor's work, resume and read-only cases on auto, the resume on the first run's chat", async () => {
+    withHome();
+    process.env.PATH = simPath();
+    process.env.CURSOR_API_KEY = SECRET;
+    const sim = withCursorScenario({
+      modelsFile: join(FX, "cursor", "models.txt"),
+      eventsFile: join(FX, "cursor", "ok.jsonl"),
+    });
+    Object.assign(process.env, sim.env);
+    const out = mkdtempSync(join(tmpdir(), "catherd-fixtures-"));
+    const results = await captureFixtures({ outDir: out, backends: ["cursor"] });
+    expect(results.map((r) => [r.backend, r.name, r.status])).toEqual([
+      ["cursor", "ok", "captured"],
+      ["cursor", "resume", "captured"],
+      ["cursor", "read-only-write", "captured"],
+    ]);
+    const resumed = JSON.parse(readFileSync(join(out, "cursor", "2026.09.28", "resume.json"), "utf8"));
+    expect(resumed).toMatchObject({
+      rung: "cursor:auto#default",
+      resumed: "00000000-0000-4000-8000-00000000c0de",
+      outcome: { thread: "00000000-0000-4000-8000-00000000c0de" },
+    });
+    expect(sim.recorded().args).toContain("--mode");
+    expect(readFileSync(join(out, "cursor", "2026.09.28", "ok.jsonl"), "utf8")).not.toContain(SECRET);
+  });
+
   it("records the totals the opencode service settles on, not only what the stream said", async () => {
     withHome();
     process.env.PATH = simPath();
````

- [ ] **Step 2: Run them to see them fail**

Run: `env -u FORCE_COLOR bun test test/entry/capture-fixtures-command.test.ts test/live/cursor.live.test.ts test/services/capture.test.ts`
Expected: FAIL: `capture-fixtures --backend cursor` has no cases.

- [ ] **Step 3: Implement**

Modify `src/services/capture.ts`:

````diff
@@ -29,7 +29,13 @@ const SAY_HELLO =
   "Reply with the single word hello. The last line of your reply is exactly: STATUS: complete — said hello";
 const TRY_WRITE =
   "Create a file named out.txt containing the word hi. If you cannot, say why. The last line of your reply is: STATUS: complete|blocked — <one line why>";
+const WORK =
+  "Create a file named notes.txt containing hi, read it back, then run the shell command `git status --short`. The last line of your reply is exactly: STATUS: complete — wrote notes.txt";
+const RECALL =
+  "Which single word did you reply with earlier in this chat? Reply with it. The last line of your reply is exactly: STATUS: complete — recalled";
 const HAIKU = "claude-code:claude-haiku-4-5-20251001#default";
+/** spec 1.3 §4.6: `auto` has no family; only the live kit and the capture run it */
+const AUTO = "cursor:auto#default";
 const BUNNY = "opencode:opencode/space-bunny-free#default";
 
 /** Spec §11.7–8: one cheap run per backend, plus a read-only role trying to write where enforcement is advisory. */
@@ -39,6 +45,10 @@ const CAPTURE_CASES: CaptureCase[] = [
   { backend: "claude-code", name: "read-only-write", rung: HAIKU, access: "read-only", brief: TRY_WRITE },
   { backend: "opencode", name: "ok", rung: BUNNY, access: "read-only", brief: SAY_HELLO },
   { backend: "opencode", name: "read-only-write", rung: BUNNY, access: "read-only", brief: TRY_WRITE },
+  // spec 1.3 §4.7: a read, a write and a shell call; a resumed chat (research §2.5); ask mode trying to write
+  { backend: "cursor", name: "ok", rung: AUTO, access: "workspace-write", brief: WORK },
+  { backend: "cursor", name: "resume", rung: AUTO, access: "read-only", brief: SAY_HELLO, resume: RECALL },
+  { backend: "cursor", name: "read-only-write", rung: AUTO, access: "read-only", brief: TRY_WRITE },
 ];
 export const CAPTURE_BACKENDS = [...new Set(CAPTURE_CASES.map((c) => c.backend))];
 
````

- [ ] **Step 4: Run the tests and the checks**

Run: `env -u FORCE_COLOR bun test test/entry/capture-fixtures-command.test.ts test/live/cursor.live.test.ts test/services/capture.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/services/capture.ts test/entry/capture-fixtures-command.test.ts test/live/cursor.live.test.ts test/services/capture.test.ts
git commit -m "test(cursor): capture cases for work, resume and ask mode, and a live test behind CATHERD_LIVE"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 14: Docs: the README, the setup skill and live verification §11 (spec 1.3 §8, §10)

README: Cursor in the intro, the requirements and a "Cursor" section (rung form, billing, native and isolated), and `CURSOR_API_KEY` in the environment table. The setup skill names the `cursor` billing and harness keys and the isolation key. `docs/dev/live-verification.md` §11 turns research §8's Cursor checks and every ruling's check into steps with what to look for. No changeset (see the header).

**Files:**

- Modify: `README.md`
- Modify: `docs/dev/live-verification.md`
- Modify: `plugin/skills/catherd-setup/SKILL.md`

**Interfaces:**
- Produces: docs only.

- [ ] **Step 1: Write the docs**

Modify `README.md`:

````diff
@@ -6,7 +6,7 @@
  (")(")
 ```
 
-Autopilot builds from your own Claude Code session. Claude plans and verifies, Codex, opencode or
+Autopilot builds from your own Claude Code session. Claude plans and verifies, Codex, opencode, Cursor or
 headless Claude Code workers write the code, and [Jev](https://typesafe.ai) picks the model and effort for each piece
 of work, climbing a ladder only when a cheaper rung falls short.
 
@@ -14,7 +14,7 @@ of work, climbing a ladder only when a cheaper rung falls short.
   hooks, skills and `AGENTS.md`. Isolation is an opt-in toggle per profile and harness, for when
   you'd rather save the tokens your customizations cost.
 - **Claude roles stay native.** `claude:` rungs run as ordinary Claude Code subagents; Codex,
-  opencode and headless `claude-code:` rungs run through catherd's MCP server.
+  opencode, Cursor and headless `claude-code:` rungs run through catherd's MCP server.
 - **Survives restarts.** Workers are detached processes writing straight to disk, so a dropped
   MCP server never loses a run.
 - **Results come to you.** Roles run side by side while you keep talking to Claude; each one that finishes
@@ -34,6 +34,8 @@ of work, climbing a ladder only when a cheaper rung falls short.
   - [opencode](https://opencode.ai) **v2**, 2.0.16 or newer: `curl -fsSL https://opencode.ai/v2/install | bash`
     (the npm package `opencode-ai` is v1 and is not supported)
   - Claude Code's `claude` CLI 2.1.282 or newer, for headless `claude-code:` rungs
+  - Cursor's CLI, `cursor-agent` 2026.09.28 or newer: `curl https://cursor.com/install -fsS | bash`, then
+    `cursor-agent login` (below)
 - Optional: a TypeSafe API key for Jev, in `TYPESAFE_API_KEY` or saved by `catherd init`
 - Optional: a free [Artificial Analysis](https://artificialanalysis.ai) API key for more scores, in
   `ARTIFICIAL_ANALYSIS_API_KEY` or saved by `catherd init`; its numbers are read for you alone and never shipped
@@ -42,6 +44,23 @@ of work, climbing a ladder only when a cheaper rung falls short.
 profile runs its workers on Codex; without Codex, doctor's fix also names how to move those roles to a backend
 you have (`/catherd-setup` in Claude Code, or `catherd profile set roles.<role>.rungs <rung>`).
 
+### Cursor
+
+A Cursor rung names Cursor's own model slug, with the effort as the slug's suffix: `cursor:gpt-6-sol#xhigh` runs
+`gpt-6-sol-xhigh`, and `#default` runs the bare slug (`cursor:composer-2.5#default`). `cursor-agent models` lists
+what your account offers; `catherd catalog refresh` reads it. No profile uses Cursor until you put a rung on it.
+Its Composer and Grok models bill from Cursor's own pool, the other models at API rates after your plan's included
+usage, so a Cursor rung ranks as `metered`.
+
+- **Native** (the default) runs with your login and your Cursor setup. It also loads your Claude Code hooks,
+  skills and plugins, which Cursor reads from `~/.claude`. `workspace-write` runs in Cursor's sandbox under your
+  `~/.cursor/sandbox.json`, which catherd never edits: `catherd doctor` shows which of a worker's checks (the lock
+  dir, temp, loopback, the network, Docker) it allows. `read-only` runs Cursor's ask mode, which asks the model not
+  to write but cannot stop it (`advisory`).
+- **Isolated** (`catherd profile set harness.cursor.isolated true`) needs `CURSOR_API_KEY`, since a login cannot
+  move to another home. catherd runs Cursor under its own HOME with its own `sandbox.json`, which gives a worker
+  catherd's writable roots.
+
 ## Install
 
 ```sh
@@ -133,6 +152,7 @@ Run data lives in `~/.local/share/catherd/`, config in `~/.config/catherd/` (bot
 | `TYPESAFE_API_KEY`            | The Jev key, instead of the one `catherd init` saves                                                        |
 | `ARTIFICIAL_ANALYSIS_API_KEY` | An Artificial Analysis key for `catalog sync`, instead of the one `catherd init` saves                      |
 | `CATHERD_NO_SYNC`             | `1`: no automatic sync of the public sources (at MCP server start and in `init`); `catalog sync` still runs |
+| `CURSOR_API_KEY`              | Cursor's API key: logs `cursor-agent` in, and is what an isolated Cursor role runs on                       |
 | `CATHERD_HOME`                | Puts config and data under `$CATHERD_HOME/config` and `$CATHERD_HOME/data` instead of XDG                   |
 | `CATHERD_LOG`                 | Log level: `off`, `error`, `warn`, `info` (default) or `debug` (what `--verbose` sets)                      |
 | `CATHERD_LOCK_SLOTS`          | `catherd lock`'s slot count when `--slots` is not given (before the profile's `lock.heavy`)                 |
````

Modify `docs/dev/live-verification.md`:

````diff
@@ -3,7 +3,7 @@
 What CI cannot check, because it needs real accounts: the backends' real streams, the Codex sandbox, and
 the Jev key prompt on a real terminal (spec D7, §11.7, §11.8); since 1.1 also the push notices, the worker
 access probes and the release acceptance runs (spec 1.1 §15, sections 7 to 9); since 1.2 its acceptance (spec 1.2
-§11, section 10). Run it on your own machine before a
+§11, section 10); since 1.3 the Cursor adapter (spec 1.3 §10, section 11). Run it on your own machine before a
 release, and again after a backend CLI's minor release. Every step says what to look for; write down
 anything that differs and file it with the step's name.
 
@@ -466,3 +466,123 @@ changeset, whose body lists the rungs newly scored, the values moved by more tha
 (each as a table), and no Artificial Analysis value; when nothing changed, the run's log ends with `no change`
 and no PR opens.
 
+## 11. Cursor (1.3, plan 15)
+
+Spec 1.3 §4 and §10, research 2026-09-29 §8 (Cursor). Every behaviour below that needs a model turn was read from
+the binary or the docs and never seen live: plan 15's rulings name what each step confirms. Write down every
+difference, with the step's number; a step that fails its "look for" is a ruling to revisit before the release.
+
+**Setup.** `cursor-agent update` (catherd needs 2026.09.28 or newer), then `cursor-agent login`. For steps 7 and 8
+also create an API key in the Cursor dashboard and `export CURSOR_API_KEY=<key>` in that shell only.
+
+```sh
+cursor-agent --version                 # 2026.09.28-<hash> or newer
+catherd doctor --json | jq -r '.checks[] | select(.id | test("cursor|agent")) | "\(.id) \(.state) \(.word): \(.detail)"'
+```
+
+Look for: `backend:cursor ok ready: 2026.09.28 · Cursor login · <n> models`; with `agent` on PATH from another
+installer, `name:agent info` (catherd runs `cursor-agent` and never the other `agent`).
+
+**1. A headless run with the brief on stdin (plan 15 Rulings on stdin and `result.usage`).**
+
+```sh
+catherd capture-fixtures --backend cursor --out /tmp/cursor-fixtures
+ls /tmp/cursor-fixtures/cursor/*/
+```
+
+Needs `CURSOR_API_KEY` (capture runs isolated). Look for three cases captured: `ok`, `resume`, `read-only-write`.
+In `ok.jsonl`: a `system/init` with a `session_id`, `tool_call` events for the write, the read and the shell call,
+and a final `result` with `usage` (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`). In
+`ok.json`: `outcome.status` `ok`, non-zero tokens, and the reply is the text after the last tool call. Copy the
+three streams over `test/fixtures/adapters/cursor/` (keeping the synthetic ones' names) and run
+`bun test test/adapters/cursor*.test.ts`; a failure there is a parser ruling to revisit.
+
+**2. Plain edits without `--force` (Ruling C-edit), a sandboxed test run and the registry.**
+
+```sh
+scratch="$(mktemp -d)" && cd "$scratch" && git init -q && git commit -q --allow-empty -m init
+echo 'Create a.txt containing hi, then run `bun --version`, then run `curl -sI https://registry.npmjs.org | head -1`. Report each result.' \
+  | cursor-agent -p --output-format stream-json --trust --workspace "$scratch" --model auto --disable-auto-update --sandbox enabled \
+  | tail -3; ls "$scratch"
+```
+
+Look for: `a.txt` exists (plain edits apply under `--sandbox enabled` without `--force`), a Bun version, and an
+HTTP status line. If `a.txt` is missing, Ruling C-edit fails: `workspace-write` must become `--force --sandbox
+enabled` with a `permissions.deny` list, and its enforcement `advisory` (spec 1.3 §4.3).
+
+**3. `full` writes outside the repo.** Repeat step 2's command with `--force --sandbox disabled --approve-mcps` in
+place of `--sandbox enabled` and the brief `Create /tmp/catherd-outside.txt containing hi.`. Look for the file;
+then `rm /tmp/catherd-outside.txt`. With `--sandbox enabled` instead, the same brief must fail to write it.
+
+**4. `--mode ask` refuses writes and shell calls, and does not stall.**
+
+```sh
+echo 'Create b.txt containing hi and run `touch c.txt`. If you cannot, say why.' \
+  | timeout 300 cursor-agent -p --output-format stream-json --trust --workspace "$scratch" --model auto --disable-auto-update --mode ask --sandbox enabled \
+  | tail -2; ls "$scratch"
+```
+
+Look for: the run ends by itself with a `result`, and neither `b.txt` nor `c.txt` exists.
+
+**5. Resume keeps the chat from the same cwd (the per-access isolated homes share one `chats` dir).**
+
+```sh
+CATHERD_LIVE=1 bun test test/live/cursor.live.test.ts
+```
+
+Look for: all tests pass (the isolated one only with `CURSOR_API_KEY` set). The first test resumes the chat it
+started and the reply names `out.txt`. By hand, resume a chat id from another directory: Cursor silently starts an
+empty chat (research §2.5); note if it errors instead.
+
+**6. The model listing (plan 15's catalog rulings on Cursor ids, efforts and context).**
+
+```sh
+cursor-agent models
+catherd catalog refresh && catherd catalog list --backend cursor
+```
+
+Look for: the slugs of the shipped families in `catalog/models.json` `on.cursor`: `gpt-6-sol` with `-low`,
+`-high`, `-xhigh` suffixes, `gpt-6-luna-high`, `claude-opus-5-5-thinking-high`, `grok-4.7`, `grok-4.6`,
+`grok-4.5`, `composer-2.5`, `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.1-pro`. Write down
+every slug that differs, every other shipped family Cursor lists (Fable, Sonnet, Astra, GPT-5.6), and whether Grok
+and Gemini have effort-suffixed slugs; each fixes `on.cursor` in the catalog. Look up each model's context window in
+Cursor's model docs (catherd assumes 200K for all).
+
+**7. An isolated HOME with the API key loads none of your Claude Code hooks.**
+
+```sh
+home="$(mktemp -d)"; echo 'List the hooks, skills and MCP servers you have loaded. Reply briefly.' \
+  | HOME="$home" cursor-agent -p --output-format stream-json --trust --workspace "$scratch" --model auto --disable-auto-update --sandbox enabled \
+  | tail -2
+```
+
+Look for: the run works on the key alone and names none of your `~/.claude` hooks or skills.
+
+**8. `sandbox.json` in an isolated home is honoured.** Step 5's isolated test wrote the read-only home. For
+workspace-write, `catherd profile set harness.cursor.isolated true` in a scratch profile and run one worker lane
+(`/catherd` in a scratch repo) whose brief also runs `catherd lock -- true`, then:
+
+```sh
+cat ~/.local/share/catherd/cursor-home/read-only/.cursor/sandbox.json        # type workspace_readonly
+cat ~/.local/share/catherd/cursor-home/workspace-write/.cursor/sandbox.json  # workspace_readwrite + catherd's roots
+```
+
+Look for: the read-only run wrote nothing; the worker wrote in the repo and took the lock (a path from
+`additionalReadwritePaths`). Set `harness.cursor.isolated false` again after.
+
+**9. Doctor's access probes through the hidden `sandbox run`.**
+
+```sh
+cursor-agent sandbox run -- sh -c 'echo ok > "$TMPDIR/catherd-probe" && cat "$TMPDIR/catherd-probe"'
+catherd doctor --json | jq -r '.checks[] | select(.id == "access:cursor") | "\(.state) \(.word): \(.detail)"'
+```
+
+Look for: `ok`, and the access row naming which of the five probes pass under your `~/.cursor/sandbox.json`. If
+`sandbox run` is gone (a string instead of a row), the hidden command was removed: the row then says not tested.
+
+**10. A real usage-limit stderr**, if one can be hit: save the stderr and the last events, and check that
+`catherd runs show <id>` records the role as `limit` (the patterns are `usage limit`, `rate limit`,
+`ActionRequiredError`, `USAGE_LIMIT`). A team policy ("administrator has disabled") must record `failed`.
+
+**11. Auto-update stays off during a run.** During step 5, `ls -l ~/.local/bin/cursor-agent` before and after:
+the link does not change mid-run (`--disable-auto-update` is hidden, spec 1.3 §9 Q8).
````

Modify `plugin/skills/catherd-setup/SKILL.md`:

````diff
@@ -21,7 +21,7 @@ You tune the user's catherd profile in conversation. A profile says, per role, w
 Ask these, one at a time, each with its recommended answer:
 
 1. **Their order of speed, cost and quality.** Recommend cost first, the default `objective`: catherd climbs a rung when a cheap one cannot do the work, so the lanes that need speed get it anyway, and the reviewer and the verifier hold quality either way.
-2. **The subscriptions they hold:** a ChatGPT plan (Codex), a Claude plan, OpenCode Go, Zen credit or API keys. They set `billing` per key (`codex`, `claude`, `claude-code`, `opencode-go`, `opencode`): `chatgpt-plan`, `claude-plan`, `subscription` or `metered`. Recommend leaning on subscriptions before metered spend, and on Claude last among the workers, since it spends the same quota as this conversation.
+2. **The subscriptions they hold:** a ChatGPT plan (Codex), a Claude plan, OpenCode Go, Zen credit or API keys. They set `billing` per key (`codex`, `claude`, `claude-code`, `opencode-go`, `opencode`, `cursor`): `chatgpt-plan`, `claude-plan`, `subscription` or `metered`. Recommend leaning on subscriptions before metered spend, and on Claude last among the workers, since it spends the same quota as this conversation.
 3. **The kind of work they orchestrate:** front-end screens, back-end services, terminal and ops work, docs. Recommend from their own runs when `runs_summary` has any.
 
 ## 2. Read the facts before proposing
@@ -59,7 +59,7 @@ Each proposal has three parts: the change, a worked example from their facts, an
 
 **Budget and timeouts.** `budget` (`minutes`, `tokens`, `usd`) is a soft cap: from 80 % routing starts at the cheapest rung that clears the bar, and at 100 % no new role starts. `timeouts.idleMin` (15) stops a role that has gone quiet, `timeouts.wallMin` (90) one that runs too long. `preflight.confirm: true` makes `preflight` show its commands for the user to approve first.
 
-**Harness isolation.** For each harness they use (`codex`, `claude-code`, `opencode`), offer `harness.<name>.isolated` with its harness line from `runs_summary` (Codex has none: it reports no per-request input, so say there is no figure for it instead of offering one) and this tradeoff: "native keeps your hooks, skills and AGENTS.md; isolated saves ~N tokens per run, but the role loses them." Recommend native. When they have no isolated runs yet, the number is the median first-turn input of their native runs: say that isolation would save some part of it, not all of it. When there are no runs at all, say there is no number yet, and recommend native until there is.
+**Harness isolation.** For each harness they use (`codex`, `claude-code`, `opencode`, `cursor`), offer `harness.<name>.isolated` with its harness line from `runs_summary` (Codex has none: it reports no per-request input, so say there is no figure for it instead of offering one) and this tradeoff: "native keeps your hooks, skills and AGENTS.md; isolated saves ~N tokens per run, but the role loses them." Recommend native. When they have no isolated runs yet, the number is the median first-turn input of their native runs: say that isolation would save some part of it, not all of it. When there are no runs at all, say there is no number yet, and recommend native until there is.
 
 ## 4. Write it
 
@@ -70,6 +70,6 @@ Each proposal has three parts: the change, a worked example from their facts, an
 
 ## 5. Say what applies when
 
-- Codex, claude-code and opencode changes, access and isolation included, apply at the next dispatch, even in a run already under way.
+- Codex, claude-code, opencode and Cursor changes, access and isolation included, apply at the next dispatch, even in a run already under way. Isolating Cursor needs `CURSOR_API_KEY` in the environment catherd runs in; `profile_validate` refuses it without.
 - An agent listed in `newSessionNeededFor` applies from the next Claude Code session: Claude Code reads agent files when a session starts. Other Claude changes apply now.
 - Editing a profile that is not the active one writes its agent files but links none; they apply once it becomes active (`catherd profile use <name>`), or in a repo it is bound to (`catherd profile use <name> --repo`).
````

- [ ] **Step 2: Run the tests and the checks**

Run: `bun run format && bun run format:check`
Expected: all files formatted.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/dev/live-verification.md plugin/skills/catherd-setup/SKILL.md
git commit -m "docs(cursor): readme, the setup skill and live verification section 11"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```
