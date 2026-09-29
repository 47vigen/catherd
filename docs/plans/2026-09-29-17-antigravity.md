# catherd 1.3, plan 17: the Antigravity adapter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Google's Antigravity CLI (`agy`) as catherd's backend `antigravity` (spec 1.3 §6): `agy` ≥ 1.2.13, logged in when `agy models` answers (never `agy -p` while signed out: it opens a browser), `-p` naming the brief file, stream-json events, `ok` only on a `SUCCESS` result, per-access isolated homes on `GEMINI_API_KEY` with catherd's own `settings.json`, read-only roles only isolated (§9 Q2), doctor's `quota:antigravity`; the four Gemini families on `antigravity` and the Gemini failover pairs with Cursor (§7.1, §7.3); docs, live verification §13, and the one `minor` changeset that ships plans 15–17 as 1.3.0 (§2).

**Architecture:** the adapter is one folder, `src/adapters/antigravity/` (`events.ts`, `models.ts`, `home.ts`, `index.ts`), registered in `src/adapters/all.ts`, with a simulator `test/sim/agy`, synthetic fixtures under `test/fixtures/adapters/antigravity/` that cite the research, and the contract suite. Two optional `BackendAdapter` fields carry what is new to the contract: `isolatedOnly` (the accesses a backend holds only when isolated; `validateHere` and `prepare` refuse them natively) and `quota()` (doctor's quota row). The Gemini failover pairs are a domain table (`sameModelStandIn`) that `standInFor` falls back to; `adjacent` carries a family's values to `#default` for a backend that runs it without an effort. The effort fold Cursor's listing uses moves to `src/adapters/discovery.ts`, shared.

**Tech Stack:** Bun ≥ 1.4, TypeScript, zod 4, citty, `@modelcontextprotocol/sdk`, `@opentui/react`. No new dependency.

**Spec:** `docs/specs/2026-09-29-catherd-1.3-design.md` §2, §3 (done by plan 15), §6, §7.1, §7.3, §8, §9 (every recommendation followed: Q2 read-only only isolated, Q3 never the user's `~/.gemini`, Q4 billing from the probe, Q5 no model turn in doctor, Q6 isolation needs the key, Q7 the README note), §10; research `docs/research/2026-09-29-cursor-grok-antigravity.md` §4 (all), §5, §7, §8 (agy list). Plan 15 (`docs/plans/2026-09-29-15-groundwork-cursor.md`) is this plan's base: its rulings, helpers (`movedHomeEnv`, `E_BACKEND_CANNOT_RUN`, isolation keys, the logged-out refusal, "not tested" access rows, the capture stdin rule) and the Cursor effort fold are consumed as they are.

**Carries the 1.3.0 release.** Plans 15, 16 (Grok) and 17 each open one PR; plan 17 merges last, so its Task 9 adds the one `minor` changeset and `MIGRATION.md`'s "From 1.2 to 1.3" (spec §2, §9 Q1). The release PR is held for the owner's live acceptance (live verification §11–§13).

**Pre-validated on scratch branch `plan17-scratch`, built on `plan15-scratch` at `194c6d4` (main `a444e1b` plus plan 15, gate green): every task below is that branch's commit, in order, each built test-first; the full gate is green on the head (counts under "Verified facts").** `git show <task commit>` on `plan17-scratch` reproduces any file.

## Global Constraints

- Layers `domain → infra → adapters → services → entry` (`test/architecture.test.ts`). agy's code stays in `src/adapters/antigravity/`; the generic changes stay in the service that owns each concern. ProfileService stays the single writer of profiles, config, bindings and agent links.
- The gate: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test`. **No test reaches the network or a real CLI, and no test reads or writes the user's `~/.gemini`**: agy runs only as `test/sim/agy` on a PATH the test sets (`simPath()`, or the sim dir, Bun's dir, `/usr/bin` and `/bin`), and every test that probes or runs it first sets `process.env.HOME` to a temp dir (the probe and the simulator read `$HOME/.gemini/antigravity-cli/settings.json`). Tests that touch `GEMINI_API_KEY` set or delete it under `snapshotEnv()`. Every test that could reach Anthropic deletes `ANTHROPIC_API_KEY` in-process or passes `ANTHROPIC_API_KEY: ""` to a spawned process; spawned processes get an explicit `env`. **Never run a real `agy`**: signed out, it opens the owner's browser.
- No wall-clock sleeps for correctness. The live test (`test/live/antigravity.live.test.ts`) runs only with `CATHERD_LIVE=1`.
- The shell may export `FORCE_COLOR`; run tests with it unset (`env -u FORCE_COLOR bun test …`).
- Commits: conventional, subject ≤ 100 characters, lower-case first word after the scope, body lines ≤ 100; check `git log` after each commit (a failed hook leaves the changes uncommitted).
- Spec 1.3 §6.2, verbatim: `agy -p "<fixed line: read and follow the brief in <briefPath>; your final message is your reply>" --output-format stream-json --model <slug> [--effort low|medium|high|max] --disable-slash-commands <access flags> [--conversation <thread>]`, cwd the repo, stdin none, env `AGY_CLI_DISABLE_AUTO_UPDATE=true`; "No `--print-timeout`: catherd's own wall timeout governs."
- Spec 1.3 §6.1: "**`agy -p` must never run while logged out**, because it opens a browser (research §4.8)." §6.5: "`ok` only when `result.status` is `SUCCESS`."
- Spec 1.3 §9 Q2: "refuse read-only roles on native agy (`profile validate` error: "isolate antigravity, or put this role on another backend"). Isolated agy gets deny rules." §9 Q3: catherd never writes `~/.gemini/antigravity-cli/settings.json`.
- Spec 1.3 §7.3 and §8: a new backend's rungs are never default stand-ins for the shipped rungs, and a new backend is off in the default profile until the user puts a rung on it. Plan 14's C-3 holds: the default profile validates with no errors and no warnings.
- Plan 16 (Grok) is written in parallel on the same base. Edits to the files both touch (`src/adapters/all.ts`, `catalog/models.json`, `src/domain/failover.ts`'s `SAME_MODEL`, `docs/dev/live-verification.md`, `README.md`, `test/services/doctor.test.ts`, the harness lists in `test/entry/*`) are small and additive: keep every line of both on a conflict.
- MCP: 26 tools, unchanged.

## Review Focus

1. **A signed-out agy never runs `-p`** (spec §6.1). Expected: the probe runs only `--version` and `agy models`; readiness refuses a signed-out agy (`E_BACKEND_NOT_LOGGED_IN`) unless `GEMINI_API_KEY` is set, and then `prepare` refuses every native run; doctor asks `/usage` only of a signed-in agy. Pinned by the simulator's `browserTo` file never appearing: `test/adapters/antigravity.test.ts` ("refuses a logged-out agy with the login fix, from `agy models` alone…"), `test/services/antigravity-dispatch.test.ts` ("refuses a logged-out agy before anything runs…", "runs isolated on GEMINI_API_KEY alone…"), `test/services/doctor.test.ts` ("fails a logged-out agy a role runs on… and asks it no quota").
2. **A read-only role never runs on native agy** (§9 Q2): a validation error in `validateHere` (the role's rungs and its failover stand-ins) and a refusal in `prepare` (`E_ADMIT_RUNG`, for a profile saved before). The implicit Gemini pair (Ruling 18) is not validated: a read-only role's Cursor Gemini rung that hits a limit is refused at `prepare` when it fails over onto native agy, and the lane pauses as with no stand-in.
3. **The reply is `result.response`**, never the `text_delta`s run together, and **an exit 0 without a `SUCCESS` result is `failed`** (an expired print timeout exits 0 with partial output, research §4.4). Pinned in `test/adapters/antigravity.test.ts` and the contract suite; the fixtures are synthetic (live §13 step 2 replaces them).
4. **Gemini's scores move** (Ruling 17): with `on.antigravity` efforts, a sync keys Gemini values at their source effort and spreads them to `#low`, `#medium` and `#default`; Cursor's bare Gemini slugs keep a value through `#default`. Pinned in `test/services/source-derive.test.ts` and `test/services/source-sync.test.ts` (`newlyScored`).
5. **An isolated home's settings are catherd's alone** (`<data>/agy-home/<access>/.gemini/antigravity-cli/settings.json`), per access, and the user's `~/.gemini` is only ever read (the probe's API-key route). The shape `{ modelProvider, permissions: { allow | deny } }` is unverified (Ruling 10): if agy ignores it, an isolated read-only worker can write. Live §13 step 5 decides it before the release.

## Rulings on the spec

Every vendor behaviour research §4 marks UNVERIFIED, [bin] or changelog-only is a ruling here (`what — why — cost if wrong`), and the live check that decides it is a step in `docs/dev/live-verification.md` §13:

1. **The prompt route is `-p "<pointer line>"`**: `Read the brief in <briefPath> and follow it. Your final message is your reply.`, `stdinPath: null`. The brief's text stays in its file; argv carries its path (1.0 §4.4's rule is about the text). — Spec §6.2 makes it the default; research §7.3. — Cost if wrong: agy does not read the file and the worker does nothing useful; the fallback is `--input-format stream-json` with a one-line NDJSON `{"event":"user","message":{"content":…}}` file that `prepare` writes beside the brief, as `stdinPath`. Live §13 steps 2 and 3.
2. **Every event's payload sits under the key its `event` names** (`{"event":"result","result":{…}}`, as the one [run] line has it); a flat payload is read too (`bodyOf`). — Research §4.4. — Cost if wrong: another nesting parses as no events, and every run reads "no result event". Live §13 step 2.
3. **Reply = `result.response`; tokens: `input_tokens` as reported unless `cache_read_tokens` exceeds it (then it is uncached and they add back), `cached = cache_read_tokens`, `output = output_tokens + thinking_tokens`; `costUsd: null`; the thread is `conversation_id`.** — Spec §6.5; whether `input_tokens` includes cache reads is unverified. — Cost if wrong: an uncached input larger than its cache reads is undercounted (a `ponytail:` comment); live §13 step 2.
4. **Status**: the exit reason first (cancelled, timeout); then `SUCCESS` → `ok`; `CANCELED`/`INTERRUPTED` → `cancelled`; exit 2 or `flags provided but not defined` → `cli-too-old`; `RESOURCE_EXHAUSTED`, `quota`, `spend cap` or `credits` in the `AGY_ERROR:` line or `result.error` → `limit`; anything else `failed` (an exit 0 with no `SUCCESS` result among them). The message: an auth failure's error with the login fix, else the `AGY_ERROR` message, the too-old line, `result.error`, "agy ended the run <STATUS>", the last stderr line, or "no result event (…)". — Spec §6.5. — Cost if wrong: a real quota text outside these words reads `failed` and no failover happens; live §13 step 8.
5. **`AGY_ERROR:` fields are unverified**: the line's text is matched whole, and its `message` (or `error.message`, or `error`) is the error message, else the raw text. — Research §4.4 (changelog 1.2.6, 1.2.10). — Cost if wrong: a less readable message; live §13 step 8.
6. **The listing's format is unverified**: each line's first word, past a list bullet, is a slug when it is lower-case and holds a digit; slugs that differ by one of agy's `--effort` words (`low`, `medium`, `high`, `max`) fold into one model (the shared fold); a model listed only bare offers `default` and all four (the flag picks the variant, research §4.5), one listed with suffixes offers those, plus `default` when its bare slug is listed too. argv is always `--model <bare> [--effort <e>]`. — Spec §6.6. — Cost if wrong: a listing of display names reads empty, and `prepare` then lets every rung through (the run says what is wrong); an effort agy lacks for a model fails the run with its message. Live §13 step 1.
7. **Logged in means `agy models` answered** (exit 0); "Please sign in" or "authentication failed" in its output is signed out; anything else is unknown (`loggedIn: null`). Signed out is `E_BACKEND_NOT_LOGGED_IN` unless `GEMINI_API_KEY` is set; then the probe reports no problem (isolated runs sign in by key) and `prepare` refuses every native run from the probe's result, kept in the module (`nativeLogin`). — Spec §3.3, §6.1; the key alone does nothing without `modelProvider: "gemini"` (research §4.8). — Cost if wrong: none known; with `GEMINI_API_KEY` set, a signed-out probe is kept for the readiness TTL, so a sign-in made meanwhile reaches native runs within 10 min.
8. **Login and billing**: `login` "Google" and `billing` `subscription`, or "API key" and `metered` when the user's own settings name `modelProvider: "gemini"` and `GEMINI_API_KEY` is set (read, never written). `DEFAULT_BILLING.antigravity` stays `metered` (plan 15 Ruling 21): doctor's billing row gives a Google-login user the one-line fix. — Spec §9 Q4. — Cost if wrong: until the user follows the fix, a Google-login rung ranks as metered.
9. **`agy` must be on PATH**; there is no `~/.local/bin/agy` fallback, and the install fix says to put `~/.local/bin` on PATH. — Spec §6.1 asks to accept the install script's path, but a probe that looks there would run a real agy in every test on the owner's machine, and Cursor's installer needs the same PATH entry. — Cost if wrong: a user without `~/.local/bin` on PATH sees "agy is not on PATH" with that fix.
10. **Isolated homes are per access**: `<data>/agy-home/{read-only,workspace-write,workspace-write-offline,full}`, `HOME` moved there by `movedHomeEnv` (catherd's dirs and the toolchain caches kept), with `.gemini/antigravity-cli/settings.json` = `{ modelProvider: "gemini" }` plus read-only `permissions.deny: ["write_file(*)", "command(*)"]`, workspace-write `permissions.allow: ["write_file(<root>)" for each writableRoots(), "read_url(*)" unless network is off]`, full nothing more. Conversations are not shared across homes (agy keeps them in SQLite): a resume after the role's `network` setting changed does not find its conversation. — Spec §6.3, §6.4; research §4.7 ("Paths allowed under write_file are mounted read-write"). — Cost if wrong: the settings shape, `read_url(*)` or the deny rules are not agy's (unverified); an isolated read-only worker can write; live §13 step 5.
11. **Access flags**: read-only none (isolated only), workspace-write `--sandbox --dangerously-skip-permissions`, full `--dangerously-skip-permissions`. `--sandbox` still confines shell under `--dangerously-skip-permissions` (spec §6.3's ruling "yes"). Enforcement: read-only `advisory`, workspace-write `advisory` (the file tools, every one approved, are not sandboxed), full `enforced`. — Spec §6.3 says "enforced for shell; advisory for file tools"; the table has one value, and the file tools decide it. — Cost if wrong: if the sandbox lets shell out under the skip flag, isolated workspace-write needs `toolPermission: "proceed-in-sandbox"` in its settings; live §13 step 4.
12. **§9 Q2 as `BackendAdapter.isolatedOnly: ["read-only"]`**: `isolatedOnlyErrors` (services, in `validateHere`) errors on each enabled role at that access whose rung or failover stand-in runs natively on the backend, fix "isolate antigravity (catherd profile set harness.antigravity.isolated true), or put this role on another backend"; `prepare` refuses the same (`E_ADMIT_RUNG`) for a profile saved earlier. — Cost if wrong: none known; the implicit pair (Ruling 18) is not validated (Review Focus 2).
13. **Doctor's quota**: `BackendAdapter.quota()`; agy's runs `agy -p /usage --output-format json` and shows the reply's `response` lines joined (≤ 200 characters); doctor calls it only when the probe says `loggedIn: true`, and shows no row when it fails. — Spec §6.6; research §4.8 (changelog 1.1.11, unverified live). — Cost if wrong: if `/usage` spends a turn, each doctor spends a little quota; live §13 step 8.
14. **Resume**: `resume.sameAccessOnly: true` (admission refuses another access, plan 15's §3.2 check); `--conversation <id>` from the recorded repo; a conversation id matches `^[A-Za-z0-9][\w-]{7,127}$` (never flag-shaped). — Spec §6.2; research §4.6. — Cost if wrong: a stricter check than agy needs; live §13 step 6.
15. **`graceAfterFinalMs: 30_000`, no `--print-timeout`**: agy leaves daemon background tasks running after its result (research §4.4), and the grace kill of the process group stops them. — Spec §6.2, §6.5. — Cost if wrong: none known.
16. **Catalog ids on agy** are Cursor's ids (`gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.1-pro`); efforts are the Gemini API's thinking levels, Flash `low, medium, high`, 3.1 Pro `low, high` (agy's `max` is not listed until the listing shows it); context 1,048,576. — Research §4.5 [doc] (slugs `gemini-3.8-flash-high`, `gemini-3.1-pro-high`); spec §6.6. — Cost if wrong: validation errors "has no effort" on an effort agy has, or `prepare` refuses a listed one; live §13 step 1.
17. **`#default` for a bare backend**: `adjacent` carries a family's value to `#default` when the family has efforts and some backend runs it without one (Cursor's Gemini), from the value nearest the family's default effort; `derive` and `rebuildShipped` pass `defaultEffortOf`. — Plan 15 Ruling 18 re-keys a family's values once it has efforts, which would leave `cursor:gemini-*#default` unscored after this plan. The rule is generic, so plan 16's Grok families get it with no change. — Cost if wrong: Cursor's default Gemini variant is scored like the family's `high` effort.
18. **Spec §7.3's pairs as `sameModelStandIn`**, not `DEFAULT_FAILOVER` entries: a table in `src/domain/failover.ts` (`antigravity` ↔ `cursor` for the four Gemini ids), consulted by `standInFor` after the profile's and the adapter's stand-in, at `#default` both ways (Cursor names no effort for these; agy's `#default` is its own default). — A `DEFAULT_FAILOVER` entry is written into the default profile, where "on no enabled role's ladder" and "stand-in to confirm" warnings break C-3; spec §3.1 keeps `failoverFor` unimplemented. Plan 16 adds its Grok row to the same table. — Cost if wrong: `profile show` and the dashboard do not list the implicit pair (admission and failover use it).
19. **Isolation note** = spec §6.4's text; `isolationKey: "GEMINI_API_KEY"` (plan 15's validation and TUI row apply); `AGY_CLI_DISABLE_AUTO_UPDATE=true` on every agy call. — Cost if wrong: none known; live §13 step 10.
20. **Capture and live rung `antigravity:gemini-3.8-flash#low`** (spec §6.6). Capture runs isolated (it needs `GEMINI_API_KEY`): `ok` (workspace-write: a write, a read, a shell call), `resume` (read-only), `read-only-write` (the deny rules). The live test runs native workspace-write with a resume, and isolated read-only when `GEMINI_API_KEY` is set. — Cost if wrong: none.
21. **Tests never meet a real agy or the user's `~/.gemini`**: every test that probes or runs the simulator sets `HOME` to a temp dir, PATH holds the simulators only. — Cost if wrong: none.
22. **Tests that need a backend with no adapter keep `grok`** (it has none on this base). On the merged head after plan 16, every adapter id has an adapter: move those tests (`test/services/admission.test.ts`, `test/services/budget-backends.test.ts`, `test/entry/capture-fixtures-command.test.ts`) to `unregisterAdapter` around a real id, or to whatever plan 16 chose. — Cost if wrong: those tests fail on the merged head until moved.
23. **The 1.3.0 changeset and "From 1.2 to 1.3" describe all three backends**; their Grok bullets were written without plan 16's code, so the executor reconciles them with plan 16 as merged. — Spec §2. — Cost if wrong: release notes that misdescribe Grok.
24. **`foldEffortSlugs` and `stripAnsi` move to `src/adapters/discovery.ts`**, shared by Cursor's and agy's listings; Cursor's behaviour is unchanged (its tests pass as they are). — Cost if wrong: none.
25. **Native workspace-write's defaults are said in the README**, not in doctor's `access:antigravity` row, which stays plan 15's generic "not tested" (no sandbox runner, spec §3.4, §9 Q5). — Cost if wrong: a user reads why their native agy worker has no network in the README instead of doctor.

## Assumes from earlier plans (re-check on the head you execute on)

`plan15-scratch` at `194c6d4` (main `a444e1b` plus plan 15), i.e. plan 15 merged. The executor re-finds every diff hunk by its context. These interfaces are consumed as plan 15 left them:

- `src/adapters/backend.ts`: `BackendAdapter` (`install`, `isolationKey`, `isolationNote`, `prepare`'s `network`, `resume.sameAccessOnly`), `Probe` (`login`, `billing`, `info`), `DiscoveredModel`, `RunRequest`, `SpawnPlan`.
- `src/adapters/access.ts`: `movedHomeEnv(home)`, `writableRoots()`; `src/adapters/cli.ts`: `runCli`, `jsonOf`; `src/adapters/discovery.ts`: `discovered`, `readDiscovery`; `src/adapters/cursor/models.ts`: `parseCursorModels`, `CURSOR_EFFORTS`.
- `src/services/backends.ts`: `readyAdapter`, `standInFor`, `probeBackend`; `src/services/profile-store.ts`: `validateHere`, `isolationKeyErrors`; `src/services/doctor-backends.ts`: `backendChecks` (info rows); `src/services/doctor-access.ts`: the "not tested" row; `src/services/capture.ts`: `CAPTURE_CASES`, `captureFixtures` (stdin only when `stdinPath` is set).
- `src/services/source-derive.ts`: `derive`, `adjacent`; `src/services/catalog-refresh.ts`: `rebuildShipped`; `src/domain/sources.ts`: `defaultEffortOf`, `familyEfforts`, `nearestEffort`; `src/domain/failover.ts`: `catalogRungs` (`#default` for a model with no effort).
- `catalog/models.json`: the Gemini families plan 15 added with `on.cursor`; `catalog/sources.json` `defaultEffort` Gemini `high`.
- `test/services/adapter-hooks.test.ts`: `fake()` (a stand-in adapter under Cursor's id); `test/services/doctor.test.ts`: `machine()`; `test/sim/sim-scenarios.ts`: `write`, the Cursor scenario; `test/adapters/contract.ts`: `runAdapterContract`.
- Plan 16 (Grok) may merge before this plan (the release order is 15, 16, 17). On that head, rebase: keep plan 16's lines in `all.ts`, `catalog/models.json`, `SAME_MODEL`, the doctor table and the harness lists (`"backend:grok"` next to `"backend:antigravity"`, `grok native` in `profile show`'s harness line), and apply Ruling 22.

## Verified facts (scratch build, 2026-09-29)

- Baseline on `plan15-scratch` `194c6d4`: 1698 pass / 17 skip / 0 fail (1715 tests, 157 files). Head of `plan17-scratch`: **1761 pass / 19 skip / 0 fail (1780 tests, 163 files)**: 63 new passing tests and 2 new skips (the live test without `CATHERD_LIVE`); typecheck, lint and format:check green; the full gate ran on the head (about 4 minutes).
- Each task's own tests failed before its code and passed after (Task 2's with the simulator moved away, Task 5's contract suite with `index.ts` moved away), with typecheck, lint and format:check green at each commit. Tasks 8 and 9 are docs only.
- `plan17-scratch` commits, one per task: 1 `3e5cd4b`, 2 `dab6691`, 3 `f77f09b`, 4 `679458a`, 5 `ecaf971`, 6 `dff6dd5`, 7 `f195361`, 8 `c3bcf34`, 9 `705fd48`.
- The full suite after Task 6's registration failed only in the two harness lists (`profile show`'s harness line and the dashboard's effects), which Task 6 updates; the default profile still validates with no errors and no warnings (C-3), and every pinned failover and stand-in test is unchanged.
- The frames change of Task 4 is the Profiles tree's Antigravity group ("↓ 65 more" → "↓ 70 more" in two 80×24 frames); the 120×40 snapshots move the same way.
- oxfmt formats `catalog/*.json`, `README.md`, `MIGRATION.md` and `.changeset/*.md`; `docs/**`, `test/fixtures/**` and `test/sim/agy` (no extension) are not formatted.
- Not validated here: anything a signed-in `agy` does (no login, and no real `agy` may run); the merge with plan 16 (written in parallel on the same base); the changeset's and MIGRATION's Grok bullets against plan 16's code.

## File Structure

| File | Task | Responsibility |
| --- | --- | --- |
| `src/adapters/antigravity/events.ts`, `models.ts` (new), `src/adapters/discovery.ts`, `src/adapters/cursor/models.ts`, `test/fixtures/adapters/antigravity/*` (new) | 1 | events, tokens, status words, `AGY_ERROR`; the listing; the shared effort fold |
| `test/sim/agy` (new), `test/sim/sim-scenarios.ts` | 2 | the simulator |
| `src/adapters/backend.ts`, `src/services/profile-store.ts`, `src/services/doctor-backends.ts` | 3 | `isolatedOnly`, `quota`; `isolatedOnlyErrors`; the quota row |
| `catalog/models.json`, `src/domain/failover.ts`, `src/services/backends.ts`, `src/services/source-derive.ts`, `src/services/catalog-refresh.ts`, the frames | 4 | `on.antigravity`; `sameModelStandIn`, `standInFor`; `#default` carried |
| `src/adapters/antigravity/home.ts`, `index.ts` (new) | 5 | homes and settings; the adapter |
| `src/adapters/all.ts` | 6 | registration |
| `src/services/capture.ts`, `test/live/antigravity.live.test.ts` (new) | 7 | capture cases; the live test |
| `README.md`, `plugin/skills/catherd-setup/SKILL.md`, `docs/dev/live-verification.md` | 8 | docs and §13 |
| `.changeset/catherd-1-3.md` (new), `MIGRATION.md` | 9 | the 1.3.0 release note |

## Parallelism

| Wave | Batches (parallel worktrees) | Depends on | Why disjoint |
| --- | --- | --- | --- |
| A | {1, 2}, {3, 4} | — | agy's parsers, fixtures and simulator, new files but `discovery.ts` and Cursor's `models.ts` (1 → 2: the simulator's tests read Task 1's fixtures); the contract fields, validation, doctor, catalog and failover (3 → 4: both add tests to `adapter-hooks.test.ts`) |
| B | {5} | 1–3 | the adapter reads Task 1's parsers, Task 2's simulator and Task 3's fields |
| C | {6} | 4, 5 | registration; its doctor and dispatch tests run the adapter on the catalog's Gemini rungs |
| D | {7}, {8, 9} | 6 | capture cases and the live test (7) vs docs and the release note (8, 9) |

Shared files, each owned by one task at a time: `test/services/adapter-hooks.test.ts` (3 → 4), `src/adapters/backend.ts` (3 only), `test/sim/sim-scenarios.ts` (2 only), `test/services/doctor.test.ts` (6 only), the frames snapshot (4 only). For fewer agents: {1, 2, 3, 4}, {5, 6}, {7, 8, 9}.


---

### Task 1: Read agy's stream-json events and its model listing (spec 1.3 §6.5, §6.6; Rulings 2–6, 24)

`src/adapters/antigravity/events.ts` parses one stream line (events keyed by `event`, the payload under the event's own key or flat), folds a run (thread from `conversation_id`, the `result`'s status, response, error and tokens), names events for activity, reads the `AGY_ERROR:` stderr line, and holds the limit, too-old and auth patterns. `models.ts` parses `agy models` and folds effort-suffixed slugs with the effort fold Cursor's listing already uses, moved to `src/adapters/discovery.ts` (`foldEffortSlugs`, `stripAnsi`). The fixtures are synthetic but for `logged-out.jsonl` ([run]); their README cites the research section each one follows.

**Files:**

- Create: `src/adapters/antigravity/events.ts`
- Create: `src/adapters/antigravity/models.ts`
- Modify: `src/adapters/cursor/models.ts`
- Modify: `src/adapters/discovery.ts`
- Test (new): `test/adapters/antigravity-events.test.ts`
- Create: `test/fixtures/adapters/antigravity/README.md`
- Create: `test/fixtures/adapters/antigravity/empty.jsonl`
- Create: `test/fixtures/adapters/antigravity/error.jsonl`
- Create: `test/fixtures/adapters/antigravity/logged-out.jsonl`
- Create: `test/fixtures/adapters/antigravity/models.txt`
- Create: `test/fixtures/adapters/antigravity/ok.jsonl`
- Create: `test/fixtures/adapters/antigravity/partial.jsonl`
- Create: `test/fixtures/adapters/antigravity/resume.jsonl`

**Interfaces:**
- Produces: `parseAgyLine`, `bodyOf`, `agyTokens`, `eventName`, `agyActivity`, `agyError(stderr): { text, message } | null`, `isLimit`, `isTooOld`, `isAuthFailure`, `foldAgyEvents(lines): AgyFold` (`{ thread, result: { status, response, error, tokens } | null, lastEvent }`), `AGY_LIMIT`, `AGY_TOO_OLD` (events.ts); `AGY_EFFORTS`, `parseAgyModels(text): DiscoveredModel[]` (models.ts); `foldEffortSlugs(slugs, suffixes): Map<string, Set<string>>`, `stripAnsi(text)` (discovery.ts).
- Consumes: `DiscoveredModel` (`src/adapters/backend.ts`), `Tokens`, `ZERO_TOKENS` (`src/domain/record.ts`).

- [ ] **Step 1: Write the failing tests**

Create `test/adapters/antigravity-events.test.ts`:

````ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  agyActivity,
  agyError,
  agyTokens,
  eventName,
  foldAgyEvents,
  isAuthFailure,
  isLimit,
  isTooOld,
  parseAgyLine,
} from "../../src/adapters/antigravity/events.ts";
import { parseAgyModels } from "../../src/adapters/antigravity/models.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "antigravity");
const lines = (n: string) =>
  readFileSync(join(FX, n), "utf8")
    .split("\n")
    .filter((l) => l.trim());

describe("agy events (spec 1.3 §6.5)", () => {
  it("takes the thread and the reply from the result, and its tokens with thinking as output", () => {
    const f = foldAgyEvents(lines("ok.jsonl"));
    expect(f.thread).toBe("3f2a9c4e-8b1d-4e6f-a5c7-9d0e1f2a3b4c");
    // the reply is result.response, never the text deltas run together
    expect(f.result).toEqual({
      status: "SUCCESS",
      response: "Done.\nSTATUS: complete — wrote src/a.ts",
      error: "",
      tokens: { input: 15989, cached: 9728, output: 335 },
    });
    expect(f.lastEvent).toBe("result/SUCCESS");
  });

  it("counts input as reported, unless the cache reads exceed it: then it is uncached and they add back", () => {
    expect(
      agyTokens({ input_tokens: 15989, output_tokens: 25, thinking_tokens: 310, cache_read_tokens: 9728 }),
    ).toEqual({ input: 15989, cached: 9728, output: 335 });
    expect(agyTokens({ input_tokens: 800, output_tokens: 12, cache_read_tokens: 14000 })).toEqual({
      input: 14800,
      cached: 14000,
      output: 12,
    });
    expect(agyTokens(undefined)).toEqual({ input: 0, cached: 0, output: 0 });
  });

  it("names events by kind, step type and state, and reads a payload nested under its event or flat", () => {
    const l = lines("ok.jsonl");
    expect(l.map((x) => eventName(parseAgyLine(x) ?? {})).slice(0, 5)).toEqual([
      "init",
      "step_update/user_input/DONE",
      "step_update/agent_response/ACTIVE",
      "step_update/agent_response/DONE",
      "step_update/tool/ACTIVE",
    ]);
    expect(eventName({ event: "step_update", step_type: "tool", state: "DONE" })).toBe(
      "step_update/tool/DONE",
    );
  });

  it("says what the worker is doing: a command, a file it reads or edits, its text", () => {
    const at = (i: number) => agyActivity(parseAgyLine(lines("ok.jsonl")[i] as string) ?? {});
    expect([at(2), at(4), at(6), at(8), at(5), at(10)]).toEqual([
      "I'll read the lane file.",
      "read lanes/M1.L1.md",
      "edit src/a.ts",
      "$ bun test",
      undefined,
      undefined,
    ]);
  });

  it("reads the AGY_ERROR line, and tells a quota stop, a CLI too old and a login that is missing", () => {
    const stderr =
      'warning: retrying\nAGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"retryable":false,"error_id":"e-7f3a","message":"Weekly quota exhausted for Gemini 3.8 Flash."}\n';
    expect(agyError(stderr)).toEqual({
      text: '{"status":"RESOURCE_EXHAUSTED","code":429,"retryable":false,"error_id":"e-7f3a","message":"Weekly quota exhausted for Gemini 3.8 Flash."}',
      message: "Weekly quota exhausted for Gemini 3.8 Flash.",
    });
    expect(agyError("AGY_ERROR: not json\n")).toEqual({ text: "not json", message: "not json" });
    expect(agyError("nothing here")).toBeNull();
    expect(isLimit("RESOURCE_EXHAUSTED")).toBe(true);
    expect(isLimit("the daily spend cap of the project was reached")).toBe(true);
    expect(isLimit("You are out of AI credits")).toBe(true);
    expect(isLimit("model request failed")).toBe(false);
    expect(isTooOld("flags provided but not defined: -disable-slash-commands")).toBe(true);
    expect(isAuthFailure("authentication failed or timed out")).toBe(true);
    expect(isAuthFailure("Error: Please sign in to view available models.")).toBe(true);
  });

  it("reads no result from a run that ended before one, and ignores lines that are not events", () => {
    const f = foldAgyEvents(lines("partial.jsonl"));
    expect([f.thread, f.result]).toEqual(["9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", null]);
    expect(parseAgyLine('{"type":"x"}')).toBeNull();
    expect(parseAgyLine("Authentication required")).toBeNull();
  });
});

describe("agy models (spec 1.3 §6.6)", () => {
  it("folds effort slugs, gives a bare-only model every --effort, and skips headers and tips", () => {
    const models = parseAgyModels(readFileSync(join(FX, "models.txt"), "utf8"));
    expect(models.map((m) => [m.id, m.efforts])).toEqual([
      ["gemini-3.8-flash", ["default", "high"]],
      ["gemini-3.7-flash", ["default", "low", "medium", "high", "max"]],
      ["gemini-3.6-flash", ["default", "low", "medium", "high", "max"]],
      ["gemini-3.1-pro", ["low", "high"]],
      ["claude-sonnet-4-6", ["default", "low", "medium", "high", "max"]],
      ["gpt-oss-120b", ["default", "low", "medium", "high", "max"]],
    ]);
  });

  it("reads nothing from a listing that asks for a sign-in", () => {
    expect(
      parseAgyModels(
        "Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.\n",
      ),
    ).toEqual([]);
  });
});
````

Create `test/fixtures/adapters/antigravity/README.md`:

````markdown
# Antigravity fixtures (spec 1.3 §6, §10): synthetic

No `agy` was signed in when these were written (research `docs/research/2026-09-29-cursor-grok-antigravity.md` §0),
so every file here but `logged-out.jsonl` is **synthetic**: built from the Antigravity CLI docs (Wayback snapshots
2026-09-16..25) and `agy changelog` of 1.2.13, as research §4 cites them. `catherd capture-fixtures --backend
antigravity` on a machine with `GEMINI_API_KEY` records real ones under `<cli-version>/`
(`docs/dev/live-verification.md` §13); compare them with these and correct what differs.

| File | Follows | What is not verified |
| --- | --- | --- |
| `ok.jsonl` | §4.4 [doc HL]: one `init` (`cwd`, `tools`, `permission_mode`, `model`), `step_update` events (`conversation_id`, `step_index`, `state` ACTIVE/DONE, `step_type` `user_input`/`agent_response`/`tool`/`checkpoint`, `tool_name`, `text_delta`, `usage`, `tool_info`), exactly one `result`; the payload nested under the event's name as in the [run] `result` line | the nesting of `init` and `step_update`; `tool_info`'s fields (`path`, `command`); the tool names; whether `result.response` is the final message only; whether `input_tokens` includes the cache reads |
| `resume.jsonl` | §4.6: a resumed conversation keeps its id and prints only the new response | the whole stream; a resume's `usage` (here cache reads above the input, read as uncached) |
| `logged-out.jsonl` | §4.4 **[run]**: the exact line a logged-out `agy -p … --output-format stream-json` printed after its 60 s browser wait, exit 1 | — |
| `error.jsonl` | §4.4: a model failure mid-turn ends with an `ERROR` result, exit 3, and an `AGY_ERROR: {…}` line on stderr (changelog 1.2.6, 1.2.10) | the `AGY_ERROR` field names (the tests use `status`, `code`, `retryable`, `error_id`, `message`) |
| `partial.jsonl` | §4.4: an expired `--print-timeout` exits 0 with partial output and a stderr warning (changelog 1.1.28); catherd never passes one | the warning's text; whether a `result` follows |
| `empty.jsonl` | §4.4 [run]: an unknown flag prints the Go `flag` usage on stderr, exit 2, nothing on stdout | — |
| `models.txt` | §4.5 [run]: `Fetching available models...` first; slugs may embed the effort (`gemini-3.8-flash-high`, `gemini-3.1-pro-high`); the plans' models [doc models] | the whole listing format past its first line |

The stderr texts the tests pair with them: `flags provided but not defined` §4.4 [run], "Please sign in to view
available models" §4.5 [run], "authentication failed or timed out" §4.4 [run]; the quota texts (`RESOURCE_EXHAUSTED`,
quota, spend cap, credits) follow §4.8 and the changelog, and are a guess until a real quota stop is captured.
````

Create `test/fixtures/adapters/antigravity/empty.jsonl` empty (0 bytes).

Create `test/fixtures/adapters/antigravity/error.jsonl`:

````text
{"event":"init","init":{"cwd":"<repo>","tools":["read_file","write_file","run_command"],"permission_mode":"default","model":"gemini-3.8-flash"}}
{"event":"step_update","step_update":{"conversation_id":"5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716","step_index":0,"state":"DONE","step_type":"user_input"}}
{"event":"result","result":{"conversation_id":"5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716","status":"ERROR","response":"","error":"model request failed","duration_seconds":2.4,"num_turns":1,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}
````

Create `test/fixtures/adapters/antigravity/logged-out.jsonl`:

````text
{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}
````

Create `test/fixtures/adapters/antigravity/models.txt`:

````text
Fetching available models...

Available models:
  * gemini-3.8-flash (default)
  - gemini-3.8-flash-high
  - gemini-3.7-flash
  - gemini-3.6-flash
  - gemini-3.1-pro-low
  - gemini-3.1-pro-high
  - claude-sonnet-4-6
  - gpt-oss-120b

Use --model <name> to pick one.
````

Create `test/fixtures/adapters/antigravity/ok.jsonl`:

````text
{"event":"init","init":{"cwd":"<repo>","tools":["read_file","write_file","run_command"],"permission_mode":"default","model":"gemini-3.8-flash"}}
{"event":"step_update","step_update":{"conversation_id":"3f2a9c4e-8b1d-4e6f-a5c7-9d0e1f2a3b4c","step_index":0,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{"conversation_id":"3f2a9c4e-8b1d-4e6f-a5c7-9d0e1f2a3b4c","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"I'll read the lane file.","usage":{"input_tokens":5200,"output_tokens":9,"thinking_tokens":120,"cache_read_tokens":4096,"total_tokens":5329}}}
{"event":"step_update","step_update":{"conversation_id":"3f2a9c4e-8b1d-4e6f-a5c7-9d0e1f2a3b4c","step_index":1,"state":"DONE","step_type":"agent_response"}}
{"event":"step_update","step_update":{"conversation_id":"3f2a9c4e-8b1d-4e6f-a5c7-9d0e1f2a3b4c","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"read_file","tool_info":{"path":"lanes/M1.L1.md"}}}
{"event":"step_update","step_update":{"conversation_id":"3f2a9c4e-8b1d-4e6f-a5c7-9d0e1f2a3b4c","step_index":2,"state":"DONE","step_type":"tool","tool_name":"read_file","tool_info":{"path":"lanes/M1.L1.md"}}}
{"event":"step_update","step_update":{"conversation_id":"3f2a9c4e-8b1d-4e6f-a5c7-9d0e1f2a3b4c","step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"write_file","tool_info":{"path":"src/a.ts"}}}
{"event":"step_update","step_update":{"conversation_id":"3f2a9c4e-8b1d-4e6f-a5c7-9d0e1f2a3b4c","step_index":3,"state":"DONE","step_type":"tool","tool_name":"write_file","tool_info":{"path":"src/a.ts"}}}
{"event":"step_update","step_update":{"conversation_id":"3f2a9c4e-8b1d-4e6f-a5c7-9d0e1f2a3b4c","step_index":4,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"command":"bun test"}}}
{"event":"step_update","step_update":{"conversation_id":"3f2a9c4e-8b1d-4e6f-a5c7-9d0e1f2a3b4c","step_index":4,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"command":"bun test"}}}
{"event":"step_update","step_update":{"conversation_id":"3f2a9c4e-8b1d-4e6f-a5c7-9d0e1f2a3b4c","step_index":5,"state":"DONE","step_type":"checkpoint"}}
{"event":"step_update","step_update":{"conversation_id":"3f2a9c4e-8b1d-4e6f-a5c7-9d0e1f2a3b4c","step_index":6,"state":"ACTIVE","step_type":"agent_response","text_delta":"Done.\nSTATUS: complete — wrote src/a.ts","usage":{"input_tokens":10789,"output_tokens":16,"thinking_tokens":190,"cache_read_tokens":5632,"total_tokens":10995}}}
{"event":"step_update","step_update":{"conversation_id":"3f2a9c4e-8b1d-4e6f-a5c7-9d0e1f2a3b4c","step_index":6,"state":"DONE","step_type":"agent_response"}}
{"event":"result","result":{"conversation_id":"3f2a9c4e-8b1d-4e6f-a5c7-9d0e1f2a3b4c","status":"SUCCESS","response":"Done.\nSTATUS: complete — wrote src/a.ts","error":"","duration_seconds":14.2,"num_turns":2,"usage":{"input_tokens":15989,"output_tokens":25,"thinking_tokens":310,"cache_read_tokens":9728,"total_tokens":26052}}}
````

Create `test/fixtures/adapters/antigravity/partial.jsonl`:

````text
{"event":"init","init":{"cwd":"<repo>","tools":["read_file","write_file","run_command"],"permission_mode":"default","model":"gemini-3.8-flash"}}
{"event":"step_update","step_update":{"conversation_id":"9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d","step_index":0,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{"conversation_id":"9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d","step_index":1,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"command":"bun test"}}}
````

Create `test/fixtures/adapters/antigravity/resume.jsonl`:

````text
{"event":"init","init":{"cwd":"<repo>","tools":["read_file","write_file","run_command"],"permission_mode":"default","model":"gemini-3.8-flash"}}
{"event":"step_update","step_update":{"conversation_id":"7c6b5a49-3928-4716-8a5b-4c3d2e1f0a9b","step_index":7,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{"conversation_id":"7c6b5a49-3928-4716-8a5b-4c3d2e1f0a9b","step_index":8,"state":"ACTIVE","step_type":"agent_response","text_delta":"Fixed.\nSTATUS: complete — fixed the bug"}}
{"event":"result","result":{"conversation_id":"7c6b5a49-3928-4716-8a5b-4c3d2e1f0a9b","status":"SUCCESS","response":"Fixed.\nSTATUS: complete — fixed the bug","error":"","duration_seconds":3.1,"num_turns":1,"usage":{"input_tokens":800,"output_tokens":12,"thinking_tokens":0,"cache_read_tokens":14000,"total_tokens":14812}}}
````

- [ ] **Step 2: Run them to see them fail**

Run: `env -u FORCE_COLOR bun test test/adapters/antigravity-events.test.ts`
Expected: FAIL: the modules do not exist.

- [ ] **Step 3: Implement**

Create `src/adapters/antigravity/events.ts`:

````ts
import { type Tokens, ZERO_TOKENS } from "../../domain/record.ts";

export interface AgyResult {
  /** SUCCESS, ERROR, CANCELED, INTERRUPTED, INVALID, WAITING or RUNNING (research §4.4) */
  status: string;
  /** the reply: the final message only (spec 1.3 §6.5; the live kit confirms it) */
  response: string;
  error: string;
  tokens: Tokens;
}

export interface AgyFold {
  thread: string | null;
  result: AgyResult | null;
  lastEvent: string | null;
}

/** A quota, spend cap or credits stop (spec 1.3 §6.5; research §4.4, §4.8: the texts are the changelog's). */
export const AGY_LIMIT = [/RESOURCE_EXHAUSTED/, /quota/i, /spend cap/i, /credits/i];
/** What an older agy prints for a flag catherd passes (Go `flag`, exit 2; research §4.4 [run]). */
export const AGY_TOO_OLD = [/flags? provided but not defined/i];
/** research §4.4 [run] (the logged-out result's error) and §4.5 [run] (`agy models` logged out) */
const AGY_AUTH = [/authentication failed/i, /please sign in/i];

type Event = Record<string, any>;

/** One stream line: an object keyed by `event` (research §4.4: `event`, not `type`); null for anything else. */
export function parseAgyLine(line: string): Event | null {
  if (!line.trim().startsWith("{")) return null;
  try {
    const e = JSON.parse(line) as unknown;
    return e && typeof e === "object" && !Array.isArray(e) && typeof (e as Event).event === "string"
      ? (e as Event)
      : null;
  } catch {
    return null;
  }
}

/**
 * An event's payload: under the key its `event` names, as the logged-out `result` line has it (research §4.4
 * [run]), else the event itself (the headless doc lists the fields flat).
 */
export const bodyOf = (e: Event): Event => {
  const inner = e[e.event as string];
  return inner && typeof inner === "object" && !Array.isArray(inner) ? (inner as Event) : e;
};

/**
 * Spec 1.3 §6.5: input as reported, cached = cache reads, output = output + thinking. Whether `input_tokens`
 * includes the cache reads is unverified (research §4.4): when the reads exceed it, it cannot, so they add back.
 * ponytail: a run whose uncached input happens to exceed its cache reads still undercounts; the live capture decides.
 */
export function agyTokens(u: Event | undefined): Tokens {
  if (!u) return { ...ZERO_TOKENS };
  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  const cached = n("cache_read_tokens");
  const input = n("input_tokens");
  return {
    input: cached > input ? input + cached : input,
    cached,
    output: n("output_tokens") + n("thinking_tokens"),
  };
}

export function eventName(e: Event): string {
  const b = bodyOf(e);
  if (e.event === "step_update") return `step_update/${b.step_type ?? "?"}/${b.state ?? "?"}`;
  if (e.event === "result") return `result/${b.status ?? "?"}`;
  return String(e.event);
}

/** Spec §3.7: a command the worker runs, a file it reads or edits, or its message. */
export function agyActivity(e: Event): string | undefined {
  if (e.event !== "step_update") return undefined;
  const b = bodyOf(e);
  if (b.step_type === "agent_response")
    return typeof b.text_delta === "string" && b.text_delta ? b.text_delta : undefined;
  if (b.step_type !== "tool" || b.state !== "ACTIVE") return undefined;
  const name = String(b.tool_name ?? "tool");
  const info = (b.tool_info ?? {}) as Event;
  if (typeof info.command === "string") return `$ ${info.command}`;
  const path = info.path ?? info.file_path;
  if (typeof path === "string") return `${/read|view/i.test(name) ? "read" : "edit"} ${path}`;
  return name;
}

/**
 * The `AGY_ERROR: {…}` line a model or agent failure prints on stderr (research §4.4: the canonical status,
 * the HTTP/gRPC code, retryability and an error id; the field names are unverified): its text, and its
 * `message` when it is JSON that has one.
 */
export function agyError(stderr: string): { text: string; message: string } | null {
  const line = stderr
    .split("\n")
    .findLast((l) => l.startsWith("AGY_ERROR:"))
    ?.slice("AGY_ERROR:".length)
    .trim();
  if (line === undefined) return null;
  try {
    const j = JSON.parse(line) as Event;
    const m = j?.message ?? j?.error?.message ?? j?.error;
    return { text: line, message: typeof m === "string" && m ? m : line };
  } catch {
    return { text: line, message: line };
  }
}

export const isLimit = (text: string): boolean => AGY_LIMIT.some((r) => r.test(text));
export const isTooOld = (text: string): boolean => AGY_TOO_OLD.some((r) => r.test(text));
export const isAuthFailure = (text: string): boolean => AGY_AUTH.some((r) => r.test(text));

export function foldAgyEvents(lines: string[]): AgyFold {
  const f: AgyFold = { thread: null, result: null, lastEvent: null };
  for (const line of lines) {
    const e = parseAgyLine(line);
    if (!e) continue;
    const b = bodyOf(e);
    f.lastEvent = eventName(e);
    if (typeof b.conversation_id === "string" && b.conversation_id) f.thread ??= b.conversation_id;
    if (e.event === "result")
      f.result = {
        status: String(b.status ?? ""),
        response: typeof b.response === "string" ? b.response : "",
        error: typeof b.error === "string" ? b.error : "",
        tokens: agyTokens(b.usage),
      };
  }
  return f;
}
````

Create `src/adapters/antigravity/models.ts`:

````ts
import type { DiscoveredModel } from "../backend.ts";
import { foldEffortSlugs, stripAnsi } from "../discovery.ts";

/** `agy --effort` (research §4.3 [run]: "(low|medium|high|max)"); `#default` passes none. */
export const AGY_EFFORTS = ["low", "medium", "high", "max"];

/** A slug: lower-case, with a digit (`gemini-3.8-flash`, `gpt-oss-120b`); headers and tips start upper-case. */
const SLUG = /^[a-z][a-z0-9._-]*$/;

/**
 * `agy models` (spec 1.3 §6.6). Its format is unverified: 1.2.13 rejects the changelog's `--output-format json`
 * (research §4.5), so each line's first word is read as a slug when it looks like one, past a list bullet. Slugs
 * that differ by an `--effort` word fold into one model (`gemini-3.8-flash-high`) with the efforts listed, and
 * `default` when the bare slug is listed too; a model listed only bare offers every `--effort`, which picks
 * the variant (research §4.5).
 */
export function parseAgyModels(text: string): DiscoveredModel[] {
  const slugs = stripAnsi(text)
    .split("\n")
    .map(
      (l) =>
        l
          .trim()
          .replace(/^[*•-]\s+/, "")
          .split(/\s/)[0] ?? "",
    )
    .filter((w) => SLUG.test(w) && /\d/.test(w));
  return [...foldEffortSlugs(slugs, AGY_EFFORTS)].map(([id, efforts]) => ({
    id,
    efforts:
      efforts.size === 1 && efforts.has("default")
        ? ["default", ...AGY_EFFORTS]
        : ["default", ...AGY_EFFORTS].filter((e) => efforts.has(e)),
    context: null,
    imageIn: false,
  }));
}
````

Modify `src/adapters/discovery.ts` (re-find each hunk by its context):

````diff
@@ -85,3 +85,24 @@ export async function discovered(
   if (models.length === 0) return cached?.models ?? [];
   return writeDiscovery(backend, models, now, o.repo).models;
 }
+
+/**
+ * Spec 1.3 §4.6, §6.6: a listing's slugs by model, those that differ only by one of `suffixes` (`gpt-6-sol-xhigh`,
+ * `gemini-3.8-flash-high`) folded into one; each model's efforts hold the suffixes it was listed with, and
+ * `default` when its bare slug is listed too.
+ */
+export function foldEffortSlugs(slugs: string[], suffixes: readonly string[]): Map<string, Set<string>> {
+  const byModel = new Map<string, Set<string>>();
+  for (const slug of slugs) {
+    const effort = suffixes.find((e) => slug.endsWith(`-${e}`));
+    const model = effort ? slug.slice(0, -(effort.length + 1)) : slug;
+    const efforts = byModel.get(model) ?? new Set<string>();
+    efforts.add(effort ?? "default");
+    byModel.set(model, efforts);
+  }
+  return byModel;
+}
+
+/** A listing may be coloured: ESC `[` … a letter. */
+const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
+export const stripAnsi = (text: string): string => text.replace(ANSI, "");
````

Modify `src/adapters/cursor/models.ts` (re-find each hunk by its context):

````diff
@@ -1,10 +1,9 @@
 import type { DiscoveredModel } from "../backend.ts";
+import { foldEffortSlugs, stripAnsi } from "../discovery.ts";
 
 /** Effort suffixes Cursor puts on a legacy slug (`gpt-6-sol-xhigh`); any other suffix names a model. */
 export const CURSOR_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
 
-/** The listing may be coloured: ESC `[` … a letter. */
-const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
 const LINE = /^\s*([a-z0-9][a-z0-9._-]*)\s+-\s+\S/;
 
 /** Spec 1.3 §4.6: an effort is its own slug; `default` is the bare one, with no effort suffix. */
@@ -18,20 +17,11 @@ export const cursorSlug = (model: string, effort: string): string =>
  * to run. Bracket variant strings are never listed, so they are never built.
  */
 export function parseCursorModels(text: string): DiscoveredModel[] {
-  const slugs = text
-    .replace(ANSI, "")
+  const slugs = stripAnsi(text)
     .split("\n")
     .map((l) => LINE.exec(l)?.[1])
     .filter((s): s is string => s !== undefined);
-  const byModel = new Map<string, Set<string>>();
-  for (const slug of slugs) {
-    const effort = CURSOR_EFFORTS.find((e) => slug.endsWith(`-${e}`));
-    const model = effort ? slug.slice(0, -(effort.length + 1)) : slug;
-    const efforts = byModel.get(model) ?? new Set<string>();
-    efforts.add(effort ?? "default");
-    byModel.set(model, efforts);
-  }
-  return [...byModel].map(([id, efforts]) => ({
+  return [...foldEffortSlugs(slugs, CURSOR_EFFORTS)].map(([id, efforts]) => ({
     id,
     efforts: ["default", ...CURSOR_EFFORTS].filter((e) => efforts.has(e)),
     context: null,
````

- [ ] **Step 4: Run the tests and the checks**

Run: `env -u FORCE_COLOR bun test test/adapters/antigravity-events.test.ts test/adapters/cursor-events.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/antigravity/events.ts src/adapters/antigravity/models.ts src/adapters/cursor/models.ts src/adapters/discovery.ts test/adapters/antigravity-events.test.ts test/fixtures/adapters/antigravity/README.md test/fixtures/adapters/antigravity/empty.jsonl test/fixtures/adapters/antigravity/error.jsonl test/fixtures/adapters/antigravity/logged-out.jsonl test/fixtures/adapters/antigravity/models.txt test/fixtures/adapters/antigravity/ok.jsonl test/fixtures/adapters/antigravity/partial.jsonl test/fixtures/adapters/antigravity/resume.jsonl
git commit -m "feat(antigravity): read agy's stream-json events and its model listing" -m "Spec 1.3 §6.5, §6.6. The effort fold moves to discovery.ts, shared with Cursor's listing." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 2: An agy simulator driven by a scenario file (spec 1.3 §10; Ruling 21)

`test/sim/agy` answers `--version`, `models` ("Please sign in" on stderr, exit 1, unless signed in: the scenario's Google login, or `GEMINI_API_KEY` with `modelProvider: "gemini"` in `$HOME`'s settings), `-p /usage` without a turn, and `-p` runs: it parses Go-style flags (one or two dashes, `-name=value`), refuses an unknown flag or a bad `--effort` with exit 2, and, signed out, records that it would open a browser (`browserTo`) and prints the [run] ERROR result. A run replays an events file under the conversation it was given (`--conversation`) or a fixed one, and records argv, the prompt, cwd, HOME, the settings under HOME and a few env values. `withAgyScenario` writes its scenario (`CATHERD_SIM_AGY`).

**Files:**

- Create: `test/sim/agy`
- Create: `test/sim/agy.test.ts`
- Test: `test/sim/sim-scenarios.ts`

**Interfaces:**
- Produces: `AgyScenario` (`loggedIn`, `modelsFile`, `modelsExit`, `unknownFlags`, `stderr`, `browserTo`, `usage`, `usageExit`, `usageTo`, plus `Common`), `withAgyScenario(s)`; the recorded run gains `settings`. The fixed new conversation id is `00000000-0000-4000-8000-0000000a9e1d`.
- Consumes: Task 1's fixtures.

- [ ] **Step 1: Write the failing tests**

Create `test/sim/agy.test.ts`:

````ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempDir } from "../helpers.ts";
import { simPath } from "./scenario.ts";
import { withAgyScenario } from "./sim-scenarios.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "antigravity");
const CONV = "7c6b5a49-3928-4716-8a5b-4c3d2e1f0a9b";

function agy(args: string[], env: Record<string, string>, cwd?: string) {
  const p = Bun.spawnSync(["agy", ...args], {
    env: { PATH: simPath(), ANTHROPIC_API_KEY: "", HOME: tempDir("catherd-agyhome-"), ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    cwd,
  });
  return { code: p.exitCode, out: p.stdout.toString("utf8"), err: p.stderr.toString("utf8") };
}

/** A HOME whose agy settings name the Gemini API as the provider (research §4.8). */
function keyHome(): string {
  const home = mkdtempSync(join(tmpdir(), "catherd-agykey-"));
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  writeFileSync(join(home, ".gemini", "antigravity-cli", "settings.json"), '{"modelProvider":"gemini"}');
  return home;
}

const SIGN_IN =
  "Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n";

describe("agy simulator (research §4)", () => {
  it("answers --version and models, and fails models fast when logged out unless the key and provider are set", () => {
    const s = withAgyScenario({ modelsFile: join(FX, "models.txt") });
    expect(agy(["--version"], s.env).out).toBe("1.2.13\n");
    expect(agy(["models"], s.env).out).toContain("gemini-3.8-flash-high");
    expect(agy(["models", "--output-format", "json"], s.env).code).toBe(2);
    const out = withAgyScenario({ loggedIn: false, modelsFile: join(FX, "models.txt") });
    expect(agy(["models"], out.env)).toEqual({
      code: 1,
      out: "Fetching available models...\n",
      err: SIGN_IN,
    });
    // the key alone does nothing (research §4.8); with modelProvider "gemini" it signs in
    expect(agy(["models"], { ...out.env, GEMINI_API_KEY: "k" }).code).toBe(1);
    expect(agy(["models"], { ...out.env, GEMINI_API_KEY: "k", HOME: keyHome() }).code).toBe(0);
  });

  it("replays the events under the resumed conversation in its cwd, and records the prompt, HOME and settings", () => {
    const repo = tempDir("catherd-simrepo-");
    const home = keyHome();
    const s = withAgyScenario({
      eventsFile: join(FX, "resume.jsonl"),
      touch: [{ path: "a.ts", content: "x" }],
    });
    const r = agy(["-p", "Read the brief", "--output-format", "stream-json"], { ...s.env, HOME: home }, repo);
    expect(r.code).toBe(0);
    expect(r.out).toContain('"conversation_id":"00000000-0000-4000-8000-0000000a9e1d"');
    expect(r.out).toContain(`"cwd":"${repo}"`);
    expect(readFileSync(join(repo, "a.ts"), "utf8")).toBe("x");
    expect(s.recorded()).toMatchObject({
      stdin: "Read the brief",
      home,
      settings: { modelProvider: "gemini" },
    });
    const again = agy(["--prompt=b", "-output-format", "stream-json", "--conversation", CONV], s.env, repo);
    expect(again.out).toContain(`"conversation_id":"${CONV}"`);
  });

  it("opens the browser and waits when a logged-out run starts, then prints the ERROR result", () => {
    const browserTo = join(tempDir("catherd-browser-"), "opened");
    const s = withAgyScenario({ loggedIn: false, browserTo });
    const r = agy(["-p", "hi", "--output-format", "stream-json"], s.env);
    expect(r.code).toBe(1);
    expect(r.out).toContain('"error":"authentication failed or timed out"');
    expect(readFileSync(browserTo, "utf8")).toBe("opened\n");
  });

  it("refuses an unknown flag and a bad effort with exit 2, and answers /usage without a turn", () => {
    const s = withAgyScenario({ unknownFlags: ["--disable-slash-commands"] });
    const old = agy(["-p", "hi", "--disable-slash-commands"], s.env);
    expect(old.code).toBe(2);
    expect(old.err).toStartWith("flags provided but not defined: -disable-slash-commands\n");
    expect(agy(["-p", "hi", "--effort", "xhigh"], s.env).code).toBe(2);
    const usage = agy(["-p", "/usage", "--output-format", "json"], s.env);
    expect(JSON.parse(usage.out)).toMatchObject({
      status: "SUCCESS",
      response: expect.stringContaining("Weekly"),
    });
    expect(existsSync(s.dir) && !s.ran()).toBe(true); // /usage started no run
  });
});
````

Modify `test/sim/sim-scenarios.ts` (re-find each hunk by its context):

````diff
@@ -13,6 +13,8 @@ interface Recorded {
   home?: string | null;
   /** a few env values the CLI saw, by name (cursor-agent: NO_OPEN_BROWSER, CURSOR_*, CATHERD_*_DIR) */
   vars?: Record<string, string>;
+  /** agy: the settings.json under the HOME it ran with, null when there is none */
+  settings?: unknown;
   envKeys: string[];
 }
 
@@ -111,6 +113,28 @@ export interface CursorScenario extends Common {
   sandboxArgsTo?: string;
 }
 
+export interface AgyScenario extends Common {
+  /** a Google login answers (default true); GEMINI_API_KEY with modelProvider "gemini" in HOME's settings does too */
+  loggedIn?: boolean;
+  /** what `agy models` prints after its first line: this file's text */
+  modelsFile?: string;
+  /** the exit code of a logged-in `agy models` (default 0) */
+  modelsExit?: number;
+  /** flags this "older" agy does not know (`--disable-slash-commands`) */
+  unknownFlags?: string[];
+  /** written to stderr after the events */
+  stderr?: string;
+  /** each time a logged-out `-p` would open the browser, a line is appended here */
+  browserTo?: string;
+  /** what `agy -p /usage --output-format json` prints (default: a weekly quota line) */
+  usage?: unknown;
+  /** `-p /usage` fails with this exit code */
+  usageExit?: number;
+  /** `-p /usage` appends its arguments here, one JSON line per call */
+  usageTo?: string;
+}
+
+export const withAgyScenario = (s: AgyScenario) => write("CATHERD_SIM_AGY", s);
 export const withClaudeScenario = (s: ClaudeScenario) => write("CATHERD_SIM_CLAUDE", s);
 export const withCursorScenario = (s: CursorScenario) => write("CATHERD_SIM_CURSOR", s);
 export const withOpencodeScenario = (s: OpencodeScenario) => write("CATHERD_SIM_OPENCODE", s);
````

- [ ] **Step 2: Run them to see them fail**

Run: `env -u FORCE_COLOR bun test test/sim/agy.test.ts`
Expected: FAIL: `agy` is not on the test PATH (the simulator does not exist yet).

- [ ] **Step 3: Implement**

Create `test/sim/agy` (executable: `chmod +x`):

````ts
#!/usr/bin/env bun
// Antigravity CLI (agy) simulator for catherd's tests (research 2026-09-29 §4): behaviour comes from the JSON
// scenario in CATHERD_SIM_AGY.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const s = JSON.parse(readFileSync(process.env.CATHERD_SIM_AGY ?? "", "utf8")) as Record<string, any>;
const args = process.argv.slice(2);
const say = (text: string) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
const fail = (text: string, code = 1): never => {
  process.stderr.write(`${text}\n`);
  process.exit(code);
};
const home = process.env.HOME ?? "";
const settingsFile = join(home, ".gemini", "antigravity-cli", "settings.json");
const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, "utf8")) : null;
// research §4.8: a Google login (the scenario's), or GEMINI_API_KEY with modelProvider "gemini" in the settings
const loggedIn =
  s.loggedIn !== false || (!!process.env.GEMINI_API_KEY && settings?.modelProvider === "gemini");

if (args[0] === "--version" || args[0] === "-version") {
  say(s.version ?? "1.2.13");
  process.exit(0);
}
if (args[0] === "models") {
  // research §4.5 [run]: `--output-format` is not a flag of `models` in 1.2.13
  if (args.length > 1) fail(`flags provided but not defined: ${args[1]}`, 2);
  say("Fetching available models...");
  if (!loggedIn)
    fail("Error: Please sign in to view available models. Launch the CLI without arguments to sign in.");
  if (s.modelsFile) process.stdout.write(readFileSync(s.modelsFile, "utf8"));
  process.exit(s.modelsExit ?? 0);
}

// Go `flag`: one or two dashes; `-name value` or `-name=value`
const VALUE = [
  "p",
  "print",
  "prompt",
  "output-format",
  "input-format",
  "model",
  "effort",
  "mode",
  "add-dir",
  "conversation",
  "print-timeout",
  "json-schema",
  "agent",
  "project",
  "log-file",
];
const BOOL = ["sandbox", "dangerously-skip-permissions", "disable-slash-commands", "c", "continue", "new-project"];
const CHOICES: Record<string, string[]> = {
  effort: ["low", "medium", "high", "max"],
  "output-format": ["text", "json", "stream-json"],
  "input-format": ["text", "stream-json"],
};
const opts: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i] as string;
  if (!a.startsWith("-")) fail(`sim: unexpected argument ${a}`, 2);
  const [name, inline] = a.replace(/^--?/, "").split(/=(.*)/s) as [string, string | undefined];
  if ((s.unknownFlags ?? []).includes(`--${name}`) || (!VALUE.includes(name) && !BOOL.includes(name)))
    fail(`flags provided but not defined: -${name}\nUsage of agy:\n  -p string\n    \tprompt`, 2);
  opts[name] = VALUE.includes(name) ? (inline ?? args[++i] ?? "") : "true";
  const allowed = CHOICES[name];
  if (allowed && !allowed.includes(opts[name] as string))
    fail(`invalid value "${opts[name]}" for flag -${name}: must be one of ${allowed.join("|")}`, 2);
}
const prompt = opts.p ?? opts.print ?? opts.prompt;
if (prompt === undefined) fail("sim: only print mode is simulated", 2);
const json = opts["output-format"] ?? "text";

if (!loggedIn) {
  // research §4.8 [run]: headless does not fail fast; it opens the browser and waits 60 s
  if (s.browserTo) appendFileSync(s.browserTo, "opened\n");
  process.stderr.write("Authentication required. Please visit the URL to log in: https://accounts.google.com/o/oauth2/auth?sim\n");
  say(
    '{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}',
  );
  process.exit(1);
}

// research §4.8: `/usage` answers without an agent turn
if (prompt === "/usage" && !opts["disable-slash-commands"]) {
  if (s.usageTo) appendFileSync(s.usageTo, `${JSON.stringify(args)}\n`);
  if (s.usageExit) fail("Error: could not read usage", s.usageExit);
  say(
    JSON.stringify(
      s.usage ?? {
        conversation_id: "",
        status: "SUCCESS",
        response: "Weekly quota: 62% left, resets Monday 09:00",
        error: "",
      },
    ),
  );
  process.exit(0);
}
if (json !== "stream-json") fail("sim: only stream-json runs are simulated", 2);

const PICKED = ["AGY_CLI_DISABLE_AUTO_UPDATE", "CATHERD_DATA_DIR", "CATHERD_CONFIG_DIR"];
writeFileSync(
  s.recordTo,
  JSON.stringify({
    args,
    stdin: prompt,
    cwd: process.cwd(),
    pwd: process.env.PWD ?? null,
    xdgConfig: process.env.XDG_CONFIG_HOME ?? null,
    home: process.env.HOME ?? null,
    vars: Object.fromEntries(PICKED.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]]]))),
    settings,
    envKeys: Object.keys(process.env),
  }),
);
const conversation = opts.conversation ?? "00000000-0000-4000-8000-0000000a9e1d";
setTimeout(async () => {
  for (const t of s.touch ?? []) {
    mkdirSync(dirname(join(process.cwd(), t.path)), { recursive: true });
    writeFileSync(join(process.cwd(), t.path), t.content);
  }
  if (s.eventsFile)
    process.stdout.write(
      readFileSync(s.eventsFile, "utf8")
        .replace(/"conversation_id":"[^"]+"/g, `"conversation_id":"${conversation}"`)
        .replaceAll("<repo>", process.cwd()),
    );
  if (s.stderr) process.stderr.write(s.stderr);
  // research §4.4: agy leaves daemon background tasks running after its result
  if (s.hangMs) await Bun.sleep(s.hangMs);
  process.exit(s.exitCode ?? 0);
}, s.delayMs ?? 0);
````

- [ ] **Step 4: Run the tests and the checks**

Run: `env -u FORCE_COLOR bun test test/sim/agy.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add test/sim/agy test/sim/agy.test.ts test/sim/sim-scenarios.ts
git commit -m "test(sim): an agy simulator driven by a scenario file" -m "Spec 1.3 §10. A logged-out run records that it would open the browser." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 3: A read-only role on a backend that holds it only isolated, and doctor's quota row (spec 1.3 §9 Q2, §6.6; Rulings 12, 13)

Two optional `BackendAdapter` fields. `isolatedOnly: Access[]` names the access modes a backend holds a role to only when isolated; `isolatedOnlyErrors(p)` (services, beside `isolationKeyErrors`) errors on each enabled role at such an access whose rung, or a failover stand-in of one, runs on that backend natively, and `validateHere` adds them (so `profile validate`, `profile set`, `profile_set` and the dashboard's save refuse it). `quota(): Promise<string | null>` is the plan quota in the CLI's words; doctor's backend rows add `quota:<id>` (info) only for a CLI whose probe says it is logged in, and nothing when it throws or returns null. Tested on the fake adapter that stands under Cursor's id.

**Files:**

- Modify: `src/adapters/backend.ts`
- Modify: `src/services/doctor-backends.ts`
- Modify: `src/services/profile-store.ts`
- Test: `test/services/adapter-hooks.test.ts`

**Interfaces:**
- Produces: `BackendAdapter.isolatedOnly?: Access[]`, `BackendAdapter.quota?(): Promise<string | null>`; `isolatedOnlyErrors(p: Profile): Issue[]` in `src/services/profile-store.ts`; the doctor row `{ id: "quota:<id>", label: "<id> quota", state: "info", word: "quota", detail }`.
- Consumes: `validateHere`, `isolationKeyErrors`, `backendChecks` as plan 15 left them.

- [ ] **Step 1: Write the failing tests**

Modify `test/services/adapter-hooks.test.ts` (re-find each hunk by its context):

````diff
@@ -12,7 +12,7 @@ import { accessChecks } from "../../src/services/doctor-access.ts";
 import { backendChecks } from "../../src/services/doctor-backends.ts";
 import { resolveProfile } from "../../src/domain/profile.ts";
 import { patchProfile } from "../../src/services/profile-service.ts";
-import { isolationKeyErrors } from "../../src/services/profile-store.ts";
+import { isolatedOnlyErrors, isolationKeyErrors } from "../../src/services/profile-store.ts";
 import { locksDir } from "../../src/infra/paths.ts";
 import { roleDir } from "../../src/services/dispatches.ts";
 import {
@@ -361,6 +361,82 @@ describe("an isolated backend's API key (spec 1.3 §8)", () => {
   });
 });
 
+describe("a backend that holds an access only when isolated (spec 1.3 §9 Q2)", () => {
+  const reviewerOn = (
+    harness: Record<string, { isolated: boolean }>,
+    failover: Record<string, string> = {},
+  ) =>
+    resolveProfile(
+      {
+        schema: 1,
+        roles: { reviewer: { rungs: ["codex:gpt-6-sol#high"] }, writer: { rungs: ["cursor:go-m1#default"] } },
+        harness,
+        failover,
+      },
+      "p",
+    );
+  const NATIVE = {
+    path: "failover.codex:gpt-6-sol#high",
+    message: "cursor:go-m1#default: native cursor cannot hold the reviewer role to read-only",
+    fix: "isolate cursor (catherd profile set harness.cursor.isolated true), or put this role on another backend",
+  };
+
+  it("is an error for a role at that access on the native harness, a failover stand-in's included", () => {
+    fake({ isolatedOnly: ["read-only"] });
+    // the writer (workspace-write) runs natively as it likes; the reviewer fails over onto the backend
+    expect(isolatedOnlyErrors(reviewerOn({}))).toEqual([]);
+    expect(isolatedOnlyErrors(reviewerOn({}, { "codex:gpt-6-sol#high": "cursor:go-m1#default" }))).toEqual([
+      NATIVE,
+    ]);
+    expect(
+      isolatedOnlyErrors(
+        reviewerOn({ cursor: { isolated: true } }, { "codex:gpt-6-sol#high": "cursor:go-m1#default" }),
+      ),
+    ).toEqual([]);
+    const onIt = resolveProfile({ schema: 1, roles: { reviewer: { rungs: ["cursor:go-m1#default"] } } }, "p");
+    expect(isolatedOnlyErrors(onIt)).toEqual([{ ...NATIVE, path: "roles.reviewer.rungs" }]);
+    fake();
+    expect(isolatedOnlyErrors(onIt)).toEqual([]);
+  });
+
+  it("refuses a save that puts a read-only role on the backend's native harness", () => {
+    withHome();
+    fake({ isolatedOnly: ["read-only"] });
+    const r = patchProfile("default", { roles: { reviewer: { rungs: ["cursor:go-m1#default"] } } });
+    expect(r.saved).toBe(false);
+    expect(r.errors).toContainEqual({ ...NATIVE, path: "roles.reviewer.rungs" });
+  });
+});
+
+describe("doctor's quota row (spec 1.3 §6.6)", () => {
+  it("shows the quota a logged-in backend reports, and nothing when it is logged out or cannot say", async () => {
+    process.env.PATH = "/nonexistent";
+    let asked = 0;
+    const quota = async () => {
+      asked++;
+      return "Weekly quota: 62% left";
+    };
+    fake({ quota });
+    expect((await backendChecks(new Map(), [])).find((r) => r.id === "quota:cursor")).toEqual({
+      id: "quota:cursor",
+      label: "cursor quota",
+      state: "info",
+      word: "quota",
+      detail: "Weekly quota: 62% left",
+    });
+    const loggedOut = { installed: true, version: "1.0.0", versionOk: true, loggedIn: false, problems: [] };
+    fake({ quota, probe: async () => loggedOut });
+    expect((await backendChecks(new Map(), [])).some((r) => r.id === "quota:cursor")).toBe(false);
+    expect(asked).toBe(1);
+    fake({
+      quota: async () => {
+        throw new Error("no answer");
+      },
+    });
+    expect((await backendChecks(new Map(), [])).some((r) => r.id === "quota:cursor")).toBe(false);
+  });
+});
+
 describe("a backend that keeps a thread's access (spec 1.3 §3.2)", () => {
   const KEEPS = { supported: true, sameAccessOnly: true, threadPattern: /^th-\d+$/ };
 
````

- [ ] **Step 2: Run them to see them fail**

Run: `env -u FORCE_COLOR bun test test/services/adapter-hooks.test.ts`
Expected: FAIL: `isolatedOnlyErrors` is not exported.

- [ ] **Step 3: Implement**

Modify `src/adapters/backend.ts` (re-find each hunk by its context):

````diff
@@ -162,6 +162,13 @@ export interface BackendAdapter {
    * the user's login (`CURSOR_API_KEY`); an isolated profile without it does not validate.
    */
   isolationKey?: string;
+  /**
+   * Spec 1.3 §9 Q2: the access modes this backend holds a role to only when isolated (agy has no read-only flag;
+   * its deny rules live in the settings catherd writes in its own home). A native role at one does not validate.
+   */
+  isolatedOnly?: Access[];
+  /** Spec 1.3 §6.6: the plan quota left, in the CLI's words, read without spending a model turn (doctor's row). */
+  quota?(): Promise<string | null>;
   graceAfterFinalMs: number | null;
 }
 
````

Modify `src/services/profile-store.ts` (re-find each hunk by its context):

````diff
@@ -138,10 +138,39 @@ export function isolationKeyErrors(
   return out;
 }
 
-/** Spec §7.1 validation on this machine: the backends catherd can run here, and the keys isolation needs. */
+/**
+ * Spec 1.3 §9 Q2: each enabled role whose rung, or a failover stand-in of one, runs natively on a backend that
+ * holds the role's access only when isolated (agy has no read-only flag).
+ */
+export function isolatedOnlyErrors(p: Profile): Issue[] {
+  const out: Issue[] = [];
+  for (const role of ROLES) {
+    const rc = p.roles[role];
+    if (!rc.enabled) continue;
+    const runs = [
+      ...rc.rungs.map((r) => [r, `roles.${role}.rungs`]),
+      ...rc.rungs.flatMap((r) => (p.failover[r] ? [[p.failover[r], `failover.${r}`]] : [])),
+    ] as [string, string][];
+    for (const [rung, path] of runs) {
+      const b = tryParseRung(rung)?.backend;
+      if (!b || p.harness[b]?.isolated || !adapterFor(b)?.isolatedOnly?.includes(rc.access)) continue;
+      out.push({
+        path,
+        message: `${rung}: native ${b} cannot hold the ${role} role to ${rc.access}`,
+        fix: `isolate ${b} (catherd profile set harness.${b}.isolated true), or put this role on another backend`,
+      });
+    }
+  }
+  return out;
+}
+
+/**
+ * Spec §7.1 validation on this machine: the backends catherd can run here, the keys isolation needs, and the
+ * accesses a backend holds only when isolated.
+ */
 export function validateHere(p: Profile, c: Catalog, doc?: ProfileDoc): Validation {
   const v = validateProfile(p, c, runnableBackends(), doc);
-  return { ...v, errors: [...v.errors, ...isolationKeyErrors(p)] };
+  return { ...v, errors: [...v.errors, ...isolationKeyErrors(p), ...isolatedOnlyErrors(p)] };
 }
 
 /** `repo`: the git toplevel whose listing route reads (opencode lists its models per repository). */
````

Modify `src/services/doctor-backends.ts` (re-find each hunk by its context):

````diff
@@ -128,6 +128,10 @@ export async function backendChecks(
             }
           : { id: `backend:${id}`, label: id, state: "ok", word: "ready", detail },
       );
+      // spec 1.3 §6.6: asked only of a logged-in CLI (a logged-out agy -p would open a browser)
+      const quota = probe.loggedIn && a.quota ? await a.quota().catch(() => null) : null;
+      if (quota)
+        checks.push({ id: `quota:${id}`, label: `${id} quota`, state: "info", word: "quota", detail: quota });
       continue;
     }
     checks.push({
````

- [ ] **Step 4: Run the tests and the checks**

Run: `env -u FORCE_COLOR bun test test/services/adapter-hooks.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/backend.ts src/services/doctor-backends.ts src/services/profile-store.ts test/services/adapter-hooks.test.ts
git commit -m "feat(profile): a read-only role on a backend that holds it only isolated, and doctor's quota row" -m "Spec 1.3 §9 Q2 and §6.6: BackendAdapter.isolatedOnly and quota()." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 4: Gemini on Antigravity, a bare slug's `#default` rung, and the Gemini failover pairs (spec 1.3 §6.6, §7.1, §7.3; Rulings 16–18)

The four Gemini families gain `on.antigravity` (same ids as Cursor's, efforts from the Gemini API's thinking levels, 1M context), and `sources.antigravity` names where they come from. Giving a family efforts re-keys its source values at their efforts (plan 15 Ruling 18), which would leave Cursor's bare Gemini slugs (`#default`) unscored: `adjacent` now also carries a value to `#default` for a family that some backend runs without an effort, from the value nearest the family's default effort (`derive` and `rebuildShipped` pass `defaultEffortOf`). `sameModelStandIn` (domain) pairs the same model on Antigravity and Cursor at `#default`, and `standInFor` falls back to it after the profile's and the adapter's stand-in. Regenerate the frames: `CATHERD_WRITE_FRAMES=1 env -u FORCE_COLOR bun test test/entry/tui/frames.test.tsx --update-snapshots` (the Profiles tree gains the Antigravity group: "↓ 65 more" becomes "↓ 70 more").

**Files:**

- Modify: `catalog/models.json`
- Modify: `docs/tui-frames.md`
- Modify: `src/domain/failover.ts`
- Modify: `src/services/backends.ts`
- Modify: `src/services/catalog-refresh.ts`
- Modify: `src/services/source-derive.ts`
- Test: `test/domain/catalog.test.ts`
- Test: `test/domain/failover.test.ts`
- Test: `test/entry/tui/__snapshots__/frames.test.tsx.snap`
- Test: `test/services/adapter-hooks.test.ts`
- Test: `test/services/source-derive.test.ts`
- Test: `test/services/source-sync.test.ts`

**Interfaces:**
- Produces: `sameModelStandIn(r: Rung): Rung | null` in `src/domain/failover.ts` (a `SAME_MODEL` table of `{ backends: [a, b], model: RegExp }` rows; plan 16 adds its Grok row); `adjacent(families, direct, shipped, now, defaultEffort = () => "high")`; `on.antigravity` on `gemini-3-8-flash`, `gemini-3-7-flash`, `gemini-3-6-flash` (`low, medium, high`) and `gemini-3-1-pro` (`low, high`), each `context: 1048576`.
- Consumes: `standInFor` (`src/services/backends.ts`), `defaultEffortOf`, `familyEfforts`, `nearestEffort` (`src/domain/sources.ts`).

- [ ] **Step 1: Write the failing tests**

Modify `test/domain/catalog.test.ts` (re-find each hunk by its context):

````diff
@@ -161,6 +161,46 @@ describe("Cursor's families (spec 1.3 §7.1)", () => {
   });
 });
 
+describe("Antigravity's families (spec 1.3 §6.6, §7.1)", () => {
+  const fam = (id: string) => shippedModels().families.find((f) => f.id === id);
+
+  it("gives the four Gemini families an agy id, the Gemini API's thinking levels and its 1M context", () => {
+    for (const [id, agy] of [
+      ["gemini-3-8-flash", "gemini-3.8-flash"],
+      ["gemini-3-7-flash", "gemini-3.7-flash"],
+      ["gemini-3-6-flash", "gemini-3.6-flash"],
+    ] as const)
+      expect(fam(id)?.on.antigravity).toEqual({
+        id: agy,
+        efforts: ["low", "medium", "high"],
+        context: 1048576,
+      });
+    expect(fam("gemini-3-1-pro")?.on.antigravity).toEqual({
+      id: "gemini-3.1-pro",
+      efforts: ["low", "high"],
+      context: 1048576,
+    });
+    // Cursor keeps its own ids, efforts and window
+    expect(fam("gemini-3-8-flash")?.on.cursor).toEqual({
+      id: "gemini-3.8-flash",
+      efforts: [],
+      context: 200000,
+    });
+  });
+
+  it("reads an agy rung as its family's canonical rung, billed under antigravity", () => {
+    expect(rungInfo(shipped(), "antigravity:gemini-3.8-flash#low")).toMatchObject({
+      key: "antigravity",
+      canonical: "gemini-3-8-flash#low",
+      efforts: ["low", "medium", "high"],
+      context: 1048576,
+    });
+    expect(rungInfo(shipped(), "antigravity:gemini-3.1-pro#default").canonical).toBe(
+      "gemini-3-1-pro#default",
+    );
+  });
+});
+
 describe("rungInfo", () => {
   it("maps a backend's model id to its family and canonical rung", () => {
     const c = shipped();
````

Modify `test/domain/failover.test.ts` (re-find each hunk by its context):

````diff
@@ -6,7 +6,9 @@ import {
   claudeBilled,
   downgradeDims,
   rankStandIns,
+  sameModelStandIn,
 } from "../../src/domain/failover.ts";
+import { parseRung } from "../../src/domain/ids.ts";
 import { BUILTIN_ROLES, DEFAULT_FAILOVER } from "../../src/domain/profile.ts";
 import { shipped } from "./shipped.ts";
 
@@ -116,6 +118,26 @@ describe("catalogRungs", () => {
   });
 });
 
+describe("the same model on the other backend (spec 1.3 §7.3)", () => {
+  const pair = (rung: string) => {
+    const r = sameModelStandIn(parseRung(rung));
+    return r && `${r.backend}:${r.model}#${r.effort}`;
+  };
+
+  it("pairs Gemini on Antigravity with Gemini on Cursor, both ways, at the vendor's default effort", () => {
+    expect(pair("antigravity:gemini-3.8-flash#high")).toBe("cursor:gemini-3.8-flash#default");
+    expect(pair("antigravity:gemini-3.1-pro#low")).toBe("cursor:gemini-3.1-pro#default");
+    expect(pair("cursor:gemini-3.6-flash#default")).toBe("antigravity:gemini-3.6-flash#default");
+  });
+
+  it("never pairs a shipped backend's rung, nor a model the other backend does not serve", () => {
+    expect(pair("codex:gpt-6-sol#high")).toBeNull();
+    expect(pair("cursor:gpt-6-sol#high")).toBeNull();
+    expect(pair("antigravity:claude-sonnet-4-6#default")).toBeNull();
+    expect(pair("opencode:opencode/gemini-3.8-flash#high")).toBeNull();
+  });
+});
+
 describe("DEFAULT_FAILOVER (spec 1.1 §11)", () => {
   it("gives each shipped worker rung a stand-in the shipped catalog accepts, never a Claude-billed one", () => {
     const c = shipped();
````

Modify `test/services/source-derive.test.ts` (re-find each hunk by its context):

````diff
@@ -52,6 +52,23 @@ describe("a family with no effort (spec 1.3 §7.1)", () => {
   });
 });
 
+describe("a family one backend runs without an effort (spec 1.3 §7.1)", () => {
+  it("carries the value at the family's default effort to #default, which Cursor and agy's bare model run", () => {
+    const d = keyless();
+    const high = d.scores.filter((s) => s.rung === "gemini-3-8-flash#high");
+    expect(high.length).toBeGreaterThan(0);
+    const bare = d.scores.filter((s) => s.rung === "gemini-3-8-flash#default");
+    // one value per dimension #high has, the best of its values there
+    expect(new Set(bare.map((s) => s.dim))).toEqual(new Set(high.map((s) => s.dim)));
+    for (const s of bare) {
+      expect(s).toMatchObject({ confidence: "adjacent", note: expect.stringContaining("has it at high;") });
+      expect(high.some((h) => h.dim === s.dim && h.value === s.value)).toBe(true);
+    }
+    // every backend of GPT-6 Sol names an effort: no #default
+    expect(d.scores.some((s) => s.rung === "gpt-6-sol#default")).toBe(false);
+  });
+});
+
 describe("anchors and calibration (spec 1.2 §4.1, §4.2)", () => {
   it("takes the anchor's own values as measured", () => {
     expect(find(keyless(), "claude-opus-5-5#high", "agentic", "measured")).toEqual([
````

Modify `test/services/source-sync.test.ts` (re-find each hunk by its context):

````diff
@@ -96,8 +96,14 @@ describe("the sync (spec 1.2 §3.2, §3.3)", () => {
     const c = clock();
     // GPT-6 Luna has no Arena agent row in the recorded answers: this one gives Luna high its first agentic value
     const r = await syncSources({ transport: c.transport(withLunaAgent()), now: c.now, aaKey: null });
-    // Gemini 3.8 Flash's family is new in 1.3: the weekly refresh ships its values, the recorded file has none
-    expect(r.newlyScored).toEqual(["gemini-3-8-flash#default"]);
+    // Gemini 3.8 Flash's family is new in 1.3: the weekly refresh ships its values, the recorded file has none;
+    // Arena's value at high spreads to agy's other efforts and to #default (Cursor's bare slug, spec 1.3 §7.1)
+    expect(r.newlyScored).toEqual([
+      "gemini-3-8-flash#default",
+      "gemini-3-8-flash#high",
+      "gemini-3-8-flash#low",
+      "gemini-3-8-flash#medium",
+    ]);
     expect(loadCatalog({ timings: false }).scores["gpt-6-luna#high"]?.agentic).toMatchObject({
       value: 0.03,
       confidence: "measured",
````

Modify `test/services/adapter-hooks.test.ts` (re-find each hunk by its context):

````diff
@@ -108,6 +108,13 @@ describe("the adapter's default stand-in (spec §4.5)", () => {
     expect(standInFor({}, "not a rung")).toBeNull();
   });
 
+  it("is the same model on the other backend for a Gemini rung, when nothing else stands in (spec 1.3 §7.3)", () => {
+    expect(standInFor({}, "antigravity:gemini-3.8-flash#high")).toBe("cursor:gemini-3.8-flash#default");
+    expect(standInFor({}, "cursor:gemini-3.8-flash#default")).toBe("antigravity:gemini-3.8-flash#default");
+    const own = { "antigravity:gemini-3.8-flash#high": "codex:gpt-6-luna#high" };
+    expect(standInFor(own, "antigravity:gemini-3.8-flash#high")).toBe("codex:gpt-6-luna#high");
+  });
+
   it("passes admission for a ladder rung, and no other rung of that backend does", async () => {
     fake();
     const { run, deps } = setup();
````

- [ ] **Step 2: Run them to see them fail**

Run: `env -u FORCE_COLOR bun test test/domain/catalog.test.ts test/domain/failover.test.ts test/services/source-derive.test.ts test/services/source-sync.test.ts test/services/adapter-hooks.test.ts`
Expected: FAIL: `sameModelStandIn` is not exported, the families have no `on.antigravity`, and no `#default` value is carried.

- [ ] **Step 3: Implement**

Last, regenerate the frames snapshot and `docs/tui-frames.md` with the command in this task's introduction; do not edit either by hand.

Modify `catalog/models.json` (re-find each hunk by its context):

````diff
@@ -5,7 +5,8 @@
     "claude": "https://platform.claude.com/docs/en/models/overview (2026-09-25); efforts https://platform.claude.com/docs/en/build-with-claude/effort; prices https://platform.claude.com/docs/en/about-claude/pricing",
     "codex": "codex debug models --bundled, Codex CLI 0.157.0 (2026-09-25); prices https://developers.openai.com/api/docs/pricing; plan weights https://learn.chatgpt.com/docs/pricing",
     "opencode": "opencode models <provider> --verbose on 1.18.32 and the v2 model.list (2026-09-25); https://opencode.ai/docs/zen, https://opencode.ai/docs/go",
-    "cursor": "cursor-agent models on 2026.09.28-64d2043 (research 2026-09-29 §2.4; ids to confirm in the live kit, docs/dev/live-verification.md §11); prices https://openrouter.ai/api/v1/models and https://models.dev/api.json (2026-09-28)"
+    "cursor": "cursor-agent models on 2026.09.28-64d2043 (research 2026-09-29 §2.4; ids to confirm in the live kit, docs/dev/live-verification.md §11); prices https://openrouter.ai/api/v1/models and https://models.dev/api.json (2026-09-28)",
+    "antigravity": "agy 1.2.13 docs (models, and slugs such as gemini-3.8-flash-high; research 2026-09-29 §4.5) and the Gemini API's thinking levels; ids and efforts to confirm in the live kit, docs/dev/live-verification.md §13"
   },
   "backends": {
     "codex": {
@@ -315,7 +316,10 @@
       "releaseDate": "2026-09-02",
       "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
       "price": { "input": 0.75, "cached": 0.075, "output": 3.75 },
-      "on": { "cursor": { "id": "gemini-3.8-flash", "efforts": [], "context": 200000 } }
+      "on": {
+        "cursor": { "id": "gemini-3.8-flash", "efforts": [], "context": 200000 },
+        "antigravity": { "id": "gemini-3.8-flash", "efforts": ["low", "medium", "high"], "context": 1048576 }
+      }
     },
     {
       "id": "gemini-3-7-flash",
@@ -324,7 +328,10 @@
       "releaseDate": "2026-08-13",
       "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
       "price": { "input": 0.75, "cached": 0.075, "output": 3.75 },
-      "on": { "cursor": { "id": "gemini-3.7-flash", "efforts": [], "context": 200000 } }
+      "on": {
+        "cursor": { "id": "gemini-3.7-flash", "efforts": [], "context": 200000 },
+        "antigravity": { "id": "gemini-3.7-flash", "efforts": ["low", "medium", "high"], "context": 1048576 }
+      }
     },
     {
       "id": "gemini-3-6-flash",
@@ -333,7 +340,10 @@
       "releaseDate": "2026-07-21",
       "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
       "price": { "input": 0.75, "cached": 0.075, "output": 3.75 },
-      "on": { "cursor": { "id": "gemini-3.6-flash", "efforts": [], "context": 200000 } }
+      "on": {
+        "cursor": { "id": "gemini-3.6-flash", "efforts": [], "context": 200000 },
+        "antigravity": { "id": "gemini-3.6-flash", "efforts": ["low", "medium", "high"], "context": 1048576 }
+      }
     },
     {
       "id": "gemini-3-1-pro",
@@ -342,7 +352,10 @@
       "releaseDate": "2026-02-19",
       "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
       "price": { "input": 2, "cached": 0.2, "output": 12 },
-      "on": { "cursor": { "id": "gemini-3.1-pro", "efforts": [], "context": 200000 } }
+      "on": {
+        "cursor": { "id": "gemini-3.1-pro", "efforts": [], "context": 200000 },
+        "antigravity": { "id": "gemini-3.1-pro", "efforts": ["low", "high"], "context": 1048576 }
+      }
     }
   ]
 }
````

Modify `src/domain/failover.ts` (re-find each hunk by its context):

````diff
@@ -109,6 +109,27 @@ function effortGap(a: string, b: string): number {
   return i < 0 || j < 0 ? EFFORT_ORDER.length : Math.abs(i - j);
 }
 
+/**
+ * Spec 1.3 §7.3: the same model on two backends bills to two pools. Each pair names its two backends and the
+ * models both serve under one id; only the new backends pair, so their rungs never stand in for the shipped ones.
+ */
+const SAME_MODEL: { backends: [Rung["backend"], Rung["backend"]]; model: RegExp }[] = [
+  { backends: ["antigravity", "cursor"], model: /^gemini-3\.(8|7|6)-flash$|^gemini-3\.1-pro$/ },
+];
+
+/**
+ * The same model on the pair's other backend, at that vendor's default effort (Cursor names none for these),
+ * or null. A limit's stand-in when neither the profile nor the adapter names one.
+ */
+export function sameModelStandIn(r: Rung): Rung | null {
+  for (const { backends, model } of SAME_MODEL) {
+    const i = backends.indexOf(r.backend);
+    if (i >= 0 && model.test(r.model))
+      return { backend: backends[1 - i] as Rung["backend"], model: r.model, effort: "default" };
+  }
+  return null;
+}
+
 /** How a family's `on` key or a model id's prefix maps to the backend that runs it. */
 const BACKEND_OF_KEY: Record<string, string> = { "opencode-go": "opencode" };
 
````

Modify `src/services/backends.ts` (re-find each hunk by its context):

````diff
@@ -2,6 +2,7 @@ import type { BackendAdapter, Probe } from "../adapters/backend.ts";
 import { adapterFor } from "../adapters/registry.ts";
 import "../adapters/all.ts";
 import { CatherdError } from "../domain/errors.ts";
+import { sameModelStandIn } from "../domain/failover.ts";
 import { formatRung, tryParseRung } from "../domain/ids.ts";
 
 const READY_TTL_MS = 10 * 60_000;
@@ -67,13 +68,13 @@ export async function readyAdapter(backend: string): Promise<{ adapter: BackendA
 
 /**
  * Spec §4.5: a rung's stand-in on a usage limit: the profile's, else its backend's default (for `repo`,
- * when given), else none.
+ * when given), else the same model on the backend it pairs with (spec 1.3 §7.3), else none.
  */
 export function standInFor(failover: Record<string, string>, rung: string, repo?: string): string | null {
   const own = failover[rung];
   if (own) return own;
   const r = tryParseRung(rung);
   if (!r) return null;
-  const byAdapter = adapterFor(r.backend)?.failoverFor?.(r, repo) ?? null;
+  const byAdapter = adapterFor(r.backend)?.failoverFor?.(r, repo) ?? sameModelStandIn(r);
   return byAdapter && formatRung(byAdapter);
 }
````

Modify `src/services/source-derive.ts` (re-find each hunk by its context):

````diff
@@ -171,7 +171,9 @@ export function derive(raw: RawAnswers, ctx: DeriveContext): Derived {
       const family = map.family(id);
       if (family && effort !== null) shipped.add(`${family.id}#${effort}|${s.dim}`);
     }
-  scores.push(...adjacent(ctx.models.families, scores, shipped, ctx.now));
+  scores.push(
+    ...adjacent(ctx.models.families, scores, shipped, ctx.now, (f) => defaultEffortOf(ctx.sources, f)),
+  );
 
   const { facts, warnings } = factsOf(raw, ctx, map);
   return {
@@ -211,13 +213,16 @@ function aaFeatures(table: Map<string, Map<string, Keyed>>): Derived["features"]
  * Spec 1.2 §4.3 `adjacent`: for each family effort a dimension has no value at (neither one in `direct` nor
  * one `shipped` names, as `<family>#<effort>|<dim>`), the best value in `direct` at the nearest effort that
  * has one (the weaker on a tie). A sync spreads only its own values, and never onto a value the shipped file
- * carries; `rebuildShipped` spreads the shipped file's published values, with an empty `shipped`.
+ * carries; `rebuildShipped` spreads the shipped file's published values, with an empty `shipped`. A family that
+ * one backend runs without an effort (Cursor's bare slug, spec 1.3 §7.1) also gets `#default`, carried from the
+ * value nearest `defaultEffort(family)`.
  */
 export function adjacent(
   families: Family[],
   direct: Score[],
   shipped: ReadonlySet<string>,
   now: number,
+  defaultEffort: (f: Family) => string = () => "high",
 ): Score[] {
   const out: Score[] = [];
   for (const f of families)
@@ -230,9 +235,11 @@ export function adjacent(
         if (!had || outranks(s, had, now)) byEffort.set(effort, s);
       }
       if (byEffort.size === 0) continue;
-      for (const e of familyEfforts(f)) {
+      const efforts = familyEfforts(f);
+      const bare = efforts.length > 0 && Object.values(f.on).some((o) => o && o.efforts.length === 0);
+      for (const e of bare ? [...efforts, "default"] : efforts) {
         if (byEffort.has(e) || shipped.has(`${f.id}#${e}|${dim}`)) continue;
-        const near = nearestEffort(e, [...byEffort.keys()]);
+        const near = nearestEffort(e === "default" ? defaultEffort(f) : e, [...byEffort.keys()]);
         const from = near ? byEffort.get(near) : undefined;
         if (!near || !from) continue;
         out.push({
````

Modify `src/services/catalog-refresh.ts` (re-find each hunk by its context):

````diff
@@ -12,7 +12,7 @@ import {
   scoresOf,
 } from "../domain/catalog.ts";
 import { DIFFICULTIES, type Difficulty, KINDS, type Kind } from "../domain/lane.ts";
-import type { SourcesFile } from "../domain/sources.ts";
+import { defaultEffortOf, type SourcesFile } from "../domain/sources.ts";
 import type { SourceTransport } from "../infra/sources/http.ts";
 import { adjacent, derive, type RawAnswers } from "./source-derive.ts";
 import { cachedAnswers, syncSources } from "./source-sync.ts";
@@ -72,6 +72,7 @@ export function rebuildShipped(
     direct.filter((s) => s.confidence !== "inferred"),
     new Set(),
     ctx.now,
+    (f) => defaultEffortOf(ctx.sources, f),
   );
   const scores = best([...direct, ...spread], ctx.now);
   const benchmark = (d: Dim) => {
````



- [ ] **Step 4: Run the tests and the checks**

Run: `env -u FORCE_COLOR bun test test/domain test/services/source-derive.test.ts test/services/source-sync.test.ts test/services/catalog-refresh.test.ts test/services/catalog-service.test.ts test/services/adapter-hooks.test.ts test/entry/tui/frames.test.tsx` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add catalog/models.json docs/tui-frames.md src/domain/failover.ts src/services/backends.ts src/services/catalog-refresh.ts src/services/source-derive.ts test/domain/catalog.test.ts test/domain/failover.test.ts test/entry/tui/__snapshots__/frames.test.tsx.snap test/services/adapter-hooks.test.ts test/services/source-derive.test.ts test/services/source-sync.test.ts
git commit -m "feat(catalog): gemini on antigravity, a bare slug's default rung, and the gemini failover pairs" -m "Spec 1.3 §6.6, §7.1, §7.3. Gemini fails over between antigravity and cursor" -m "at the vendor's default effort." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 5: The agy adapter: plan, probe, prepare, finalize, quota and the contract suite (spec 1.3 §6; Rulings 1, 4, 7–15, 19)

`src/adapters/antigravity/home.ts` holds the isolated homes (one per access, plus `workspace-write-offline`) and the settings catherd writes in them; `index.ts` is the adapter. `plan` points `-p` at the brief file, `stdinPath: null`; `probe` runs `--version` and `agy models` only (never `-p`), and remembers whether agy's own login answered; `prepare` refuses native read-only (Q2), an isolated run without `GEMINI_API_KEY`, a native run when the probe found agy signed out, and a model or effort agy does not list; `finalize` is `ok` only on a `SUCCESS` result; `quota` runs `agy -p /usage --output-format json`. Not registered yet (Task 6).

**Files:**

- Create: `src/adapters/antigravity/home.ts`
- Create: `src/adapters/antigravity/index.ts`
- Test (new): `test/adapters/antigravity.contract.test.ts`
- Test (new): `test/adapters/antigravity.test.ts`

**Interfaces:**
- Produces: `antigravityAdapter`, `AGY_ACCESS`, `AGY_MIN_VERSION` (`1.2.13`), `AGY_INSTALL`, `agyPrompt(briefPath)`, `agyShell` (`{ timeoutMs: 30_000 }`), `isolatedAgyHome(access, network)`, `isolatedAgyRoot()` (index.ts); `agyHomeEnv`, `agySettings(access, network)`, `prepareAgyHome(access, network)` (home.ts).
- Consumes: Task 1's parsers, Task 2's simulator, Task 3's `isolatedOnly` and `quota`; `movedHomeEnv`, `writableRoots` (`src/adapters/access.ts`), `runCli`, `jsonOf` (`src/adapters/cli.ts`), `discovered` (`src/adapters/discovery.ts`), `runAdapterContract` (`test/adapters/contract.ts`).

- [ ] **Step 1: Write the failing tests**

Create `test/adapters/antigravity.test.ts`:

````ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writableRoots } from "../../src/adapters/access.ts";
import {
  AGY_ACCESS,
  agyPrompt,
  agyShell,
  antigravityAdapter,
  isolatedAgyHome,
  isolatedAgyRoot,
} from "../../src/adapters/antigravity/index.ts";
import type { FinishedRun, RunRequest } from "../../src/adapters/backend.ts";
import { readDiscovery } from "../../src/adapters/discovery.ts";
import { isCatherdError } from "../../src/domain/errors.ts";
import { parseRung } from "../../src/domain/ids.ts";
import { configDir, dataDir } from "../../src/infra/paths.ts";
import { snapshotEnv, tempDir, withHome } from "../helpers.ts";
import { withAgyScenario, type AgyScenario } from "../sim/sim-scenarios.ts";

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "antigravity");
const SIM = join(import.meta.dir, "..", "sim", "agy");
/** The simulators, Bun and the system tools, and nothing of this machine's own: never a real agy. */
const SIMS = [dirname(SIM), dirname(process.execPath), "/usr/bin", "/bin"].join(":");
const lines = (n: string) =>
  readFileSync(join(FX, n), "utf8")
    .split("\n")
    .filter((l) => l.trim());
afterEach(snapshotEnv());
afterEach(() => {
  agyShell.timeoutMs = 30_000;
});
// a HOME of the test's own: the probe reads ~/.gemini's settings and the simulator reads HOME's, never the user's
beforeEach(() => {
  process.env.HOME = tempDir("catherd-agyhome-");
  delete process.env.GEMINI_API_KEY;
});

/** The simulator on PATH with scenario `s`; returns the scenario's handle. */
function sim(s: AgyScenario = {}) {
  process.env.PATH = SIMS;
  const x = withAgyScenario({ modelsFile: join(FX, "models.txt"), ...s });
  Object.assign(process.env, x.env);
  return x;
}

const req = (over: Partial<RunRequest> = {}): RunRequest => ({
  rung: parseRung("antigravity:gemini-3.8-flash#high"),
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
const exit = (code: number | null, reason: "exited" | "cancelled" | "wall-timeout" = "exited") => ({
  exit: { code, signal: null, reason, endedAt: "x" },
});

async function code(p: Promise<unknown> | undefined): Promise<string> {
  try {
    await p;
  } catch (e) {
    return isCatherdError(e) ? e.code : String(e);
  }
  return "ok";
}

const LOGIN_FIX =
  "run agy once to sign in with Google, or export GEMINI_API_KEY=<key> and catherd profile set harness.antigravity.isolated true";

describe("agy plan (spec 1.3 §6.2, §6.3)", () => {
  it("points -p at the brief file, prints stream-json, turns slash commands and auto-update off, stdin none", () => {
    process.env.PATH = SIMS;
    expect(antigravityAdapter.plan(req())).toEqual({
      cmd: "agy",
      args: [
        "-p",
        "Read the brief in /d/brief.md and follow it. Your final message is your reply.",
        "--output-format",
        "stream-json",
        "--model",
        "gemini-3.8-flash",
        "--effort",
        "high",
        "--disable-slash-commands",
        "--sandbox",
        "--dangerously-skip-permissions",
      ],
      env: { AGY_CLI_DISABLE_AUTO_UPDATE: "true" },
      cwd: "/repo",
      stdinPath: null,
    });
    expect(agyPrompt("/x/brief.md")).toBe(
      "Read the brief in /x/brief.md and follow it. Your final message is your reply.",
    );
  });

  it("maps each access, passes no --effort for #default, and resumes a conversation", () => {
    expect(AGY_ACCESS).toEqual({
      "read-only": [],
      "workspace-write": ["--sandbox", "--dangerously-skip-permissions"],
      full: ["--dangerously-skip-permissions"],
    });
    const thread = "7c6b5a49-3928-4716-8a5b-4c3d2e1f0a9b";
    const p = antigravityAdapter.plan(
      req({ rung: parseRung("antigravity:gemini-3.8-flash#default"), thread }),
    );
    expect(p.args).not.toContain("--effort");
    expect(p.args).not.toContain("--print-timeout");
    expect(p.args.slice(-2)).toEqual(["--conversation", thread]);
  });

  it("isolates under catherd's own HOME per access, with catherd's dirs kept, and writes nothing to plan", () => {
    withHome();
    const env = antigravityAdapter.plan(req({ isolated: true })).env;
    const home = isolatedAgyHome("workspace-write", true);
    expect(home).toBe(join(isolatedAgyRoot(), "workspace-write"));
    expect(env).toMatchObject({
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      HOME: home,
      CATHERD_CONFIG_DIR: configDir(),
      CATHERD_DATA_DIR: dataDir(),
    });
    expect(antigravityAdapter.plan(req({ isolated: true, network: false })).env.HOME).toBe(
      join(isolatedAgyRoot(), "workspace-write-offline"),
    );
    expect(existsSync(isolatedAgyRoot())).toBe(false);
  });
});

describe("agy finalize (spec 1.3 §6.5)", () => {
  it("is ok only on a SUCCESS result, with its response as the reply, though the grace kill ended the CLI", () => {
    expect(antigravityAdapter.finalize(finished(lines("ok.jsonl")))).toMatchObject({
      status: "ok",
      thread: "3f2a9c4e-8b1d-4e6f-a5c7-9d0e1f2a3b4c",
      reply: "Done.\nSTATUS: complete — wrote src/a.ts",
      tokens: { input: 15989, cached: 9728, output: 335 },
      costUsd: null,
      error: null,
    });
    const killed = finished(lines("ok.jsonl"), {
      exit: { code: null, signal: "SIGTERM", reason: "exited", endedAt: "x" },
    });
    expect(antigravityAdapter.finalize(killed).status).toBe("ok");
  });

  it("gives the logged-out result the login fix, and keeps the request's thread", () => {
    const thread = "7c6b5a49-3928-4716-8a5b-4c3d2e1f0a9b";
    const o = antigravityAdapter.finalize(
      finished(lines("logged-out.jsonl"), { request: req({ thread }), ...exit(1) }),
    );
    expect(o).toMatchObject({
      status: "failed",
      thread,
      error: { code: "failed", message: `authentication failed or timed out (fix: ${LOGIN_FIX})` },
    });
    expect(o.reply).toBeUndefined();
  });

  it("reads the AGY_ERROR line: a quota stop is a limit, any other error fails with its message", () => {
    const quota =
      'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"retryable":false,"error_id":"e-7f3a","message":"Weekly quota exhausted for Gemini 3.8 Flash."}\n';
    const at = (stderr: string) =>
      antigravityAdapter.finalize(finished(lines("error.jsonl"), { stderr, ...exit(3) }));
    expect(at(quota)).toMatchObject({
      status: "limit",
      error: { code: "limit", message: "Weekly quota exhausted for Gemini 3.8 Flash." },
    });
    expect(
      at('AGY_ERROR: {"status":"FAILED_PRECONDITION","message":"daily spend cap reached"}\n').status,
    ).toBe("limit");
    expect(at('AGY_ERROR: {"status":"INTERNAL","code":500,"message":"backend error"}\n')).toMatchObject({
      status: "failed",
      error: { message: "backend error" },
    });
    expect(at("").error?.message).toBe("model request failed");
  });

  it("reads exit 2 as a CLI too old, a partial print-timeout run as failed, and a cancel or timeout as such", () => {
    const old = antigravityAdapter.finalize(
      finished([], {
        stderr: "flags provided but not defined: -disable-slash-commands\nUsage of agy:\n  -p string\n",
        ...exit(2),
      }),
    );
    expect(old).toMatchObject({
      status: "cli-too-old",
      error: { message: "flags provided but not defined: -disable-slash-commands" },
    });
    const partial = antigravityAdapter.finalize(
      finished(lines("partial.jsonl"), { stderr: "warning: print timeout reached; output is partial\n" }),
    );
    expect(partial).toMatchObject({
      status: "failed",
      thread: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      error: { message: "warning: print timeout reached; output is partial" },
    });
    const canceled = lines("ok.jsonl").at(-1)?.replace('"SUCCESS"', '"CANCELED"') as string;
    expect(antigravityAdapter.finalize(finished([canceled], exit(1))).status).toBe("cancelled");
    expect(antigravityAdapter.finalize(finished([], exit(null, "cancelled"))).status).toBe("cancelled");
    expect(antigravityAdapter.finalize(finished([], exit(null, "wall-timeout"))).status).toBe("timeout");
    expect(antigravityAdapter.finalize(finished([], exit(1))).error?.message).toBe(
      "no result event (exited, exit 1)",
    );
  });
});

describe("agy parse (spec 1.3 §6.5)", () => {
  it("marks the result final with its tokens, and a limit in a failed result", () => {
    expect(antigravityAdapter.parse(lines("ok.jsonl").at(-1) as string)).toMatchObject({
      final: true,
      thread: "3f2a9c4e-8b1d-4e6f-a5c7-9d0e1f2a3b4c",
      tokens: { input: 15989, cached: 9728, output: 335 },
      lastEvent: "result/SUCCESS",
    });
    const quota = JSON.stringify({ event: "result", result: { status: "ERROR", error: "quota exhausted" } });
    expect(antigravityAdapter.parse(quota)).toMatchObject({
      final: true,
      limit: true,
      failure: "quota exhausted",
    });
  });

  it("opens and closes an item per tool step, and reads each request's input from its usage", () => {
    const l = lines("ok.jsonl");
    expect(antigravityAdapter.parse(l[8] as string)).toMatchObject({
      item: { id: "step-4", open: true },
      activity: "$ bun test",
    });
    expect(antigravityAdapter.parse(l[9] as string)).toMatchObject({ item: { id: "step-4", open: false } });
    expect(antigravityAdapter.parse(l[2] as string)).toMatchObject({
      requestInput: 5200,
      activity: "I'll read the lane file.",
    });
    const init = antigravityAdapter.parse(l[0] as string);
    expect([init.item, init.final, init.thread]).toEqual([undefined, undefined, undefined]);
  });
});

describe("agy probe (spec 1.3 §6.1, §3.3)", () => {
  it("reads the version and a Google login that answers `agy models`, billed as a subscription", async () => {
    sim();
    expect(await antigravityAdapter.probe()).toEqual({
      installed: true,
      version: "1.2.13",
      versionOk: true,
      loggedIn: true,
      login: "Google",
      billing: "subscription",
      problems: [],
    });
  });

  it("reads the API key route of the user's own settings as metered", async () => {
    sim({ loggedIn: false });
    const dir = join(process.env.HOME as string, ".gemini", "antigravity-cli");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), '{"modelProvider":"gemini"}');
    process.env.GEMINI_API_KEY = "key-for-test";
    expect(await antigravityAdapter.probe()).toMatchObject({
      loggedIn: true,
      login: "API key",
      billing: "metered",
    });
  });

  it("refuses a logged-out agy with the login fix, from `agy models` alone: never a run, never a browser", async () => {
    const browserTo = join(tempDir("catherd-browser-"), "opened");
    const s = sim({ loggedIn: false, browserTo, version: "1.2.9" });
    const p = await antigravityAdapter.probe();
    expect(p).toMatchObject({ installed: true, version: "1.2.9", versionOk: false, loggedIn: false });
    expect(p.problems.map((x) => [x.code, x.message, x.fix])).toEqual([
      [
        "E_BACKEND_TOO_OLD",
        "agy 1.2.9 is older than 1.2.13",
        "brew upgrade --cask antigravity-cli, or run the install script again",
      ],
      ["E_BACKEND_NOT_LOGGED_IN", "agy is not signed in (agy models says: Please sign in)", LOGIN_FIX],
    ]);
    expect(existsSync(browserTo)).toBe(false);
    expect(s.ran()).toBe(false);
    // with GEMINI_API_KEY an isolated run can still go: no problem, and native runs are refused at prepare
    process.env.GEMINI_API_KEY = "key-for-test";
    expect((await antigravityAdapter.probe()).problems.map((x) => x.code)).toEqual(["E_BACKEND_TOO_OLD"]);
  });

  it("says agy is not on PATH, with the install command", async () => {
    process.env.PATH = "/nonexistent";
    expect((await antigravityAdapter.probe()).problems[0]).toEqual({
      code: "E_BACKEND_MISSING",
      message: "agy is not on PATH",
      fix: "curl -fsSL https://antigravity.google/cli/install.sh | bash (it installs ~/.local/bin/agy: put that dir on PATH), or brew install --cask antigravity-cli",
    });
  });
});

describe("agy models, prepare and quota (spec 1.3 §6.3, §6.4, §6.6)", () => {
  const prep = (
    rung: string,
    access: "read-only" | "workspace-write" | "full" = "workspace-write",
    isolated = false,
    network = true,
  ) => code(antigravityAdapter.prepare?.({ rung: parseRung(rung), access, isolated, repo: "/r", network }));

  it("lists models from `agy models`, and refuses a model or effort agy does not list, before anything runs", async () => {
    withHome();
    sim();
    expect((await antigravityAdapter.listModels()).find((m) => m.id === "gemini-3.1-pro")?.efforts).toEqual([
      "low",
      "high",
    ]);
    await antigravityAdapter.probe();
    expect(await prep("antigravity:gemini-3.8-flash#high")).toBe("ok");
    expect(await prep("antigravity:gemini-3.8-flash#low")).toBe("E_BACKEND_MODEL_UNKNOWN");
    expect(await prep("antigravity:gemini-3.7-flash#max")).toBe("ok");
    expect(await prep("antigravity:gemini-9#high")).toBe("E_BACKEND_MODEL_UNKNOWN");
    expect(readDiscovery("antigravity")?.models.length).toBe(6);
  });

  it("refuses a read-only role on native agy, which has no read-only mode (spec 1.3 §9 Q2)", async () => {
    withHome();
    sim();
    await antigravityAdapter.probe();
    expect(await prep("antigravity:gemini-3.8-flash#high", "read-only")).toBe("E_ADMIT_RUNG");
    expect(await prep("antigravity:gemini-3.8-flash#high", "full")).toBe("ok");
  });

  it("refuses a native run once the probe found agy logged out: it would open a browser", async () => {
    withHome();
    sim({ loggedIn: false });
    process.env.GEMINI_API_KEY = "key-for-test";
    await antigravityAdapter.probe();
    expect(await prep("antigravity:gemini-3.8-flash#high")).toBe("E_BACKEND_NOT_LOGGED_IN");
    // isolated, the key signs it in
    expect(await prep("antigravity:gemini-3.8-flash#high", "workspace-write", true)).toBe("ok");
  });

  it("needs GEMINI_API_KEY to isolate, and writes each isolated home's settings: the provider and the access rules", async () => {
    withHome();
    sim();
    await antigravityAdapter.probe();
    expect(await prep("antigravity:gemini-3.8-flash#high", "workspace-write", true)).toBe(
      "E_BACKEND_NOT_LOGGED_IN",
    );
    expect(existsSync(isolatedAgyRoot())).toBe(false);
    process.env.GEMINI_API_KEY = "key-for-test";
    const settings = (access: "read-only" | "workspace-write" | "full", network = true) =>
      JSON.parse(
        readFileSync(
          join(isolatedAgyHome(access, network), ".gemini", "antigravity-cli", "settings.json"),
          "utf8",
        ),
      );
    expect(await prep("antigravity:gemini-3.8-flash#high", "workspace-write", true)).toBe("ok");
    expect(settings("workspace-write")).toEqual({
      modelProvider: "gemini",
      permissions: { allow: [...writableRoots().map((r) => `write_file(${r})`), "read_url(*)"] },
    });
    expect(await prep("antigravity:gemini-3.8-flash#high", "workspace-write", true, false)).toBe("ok");
    expect(settings("workspace-write", false).permissions.allow).not.toContain("read_url(*)");
    expect(await prep("antigravity:gemini-3.8-flash#high", "read-only", true)).toBe("ok");
    expect(settings("read-only")).toEqual({
      modelProvider: "gemini",
      permissions: { deny: ["write_file(*)", "command(*)"] },
    });
    expect(await prep("antigravity:gemini-3.8-flash#high", "full", true)).toBe("ok");
    expect(settings("full")).toEqual({ modelProvider: "gemini" });
  });

  it("reads the quota through `/usage` without a turn, and nothing when agy cannot say", async () => {
    const usageTo = join(tempDir("catherd-usage-"), "args");
    sim({ usageTo });
    expect(await antigravityAdapter.quota?.()).toBe("Weekly quota: 62% left, resets Monday 09:00");
    expect(JSON.parse(readFileSync(usageTo, "utf8").trim())).toEqual([
      "-p",
      "/usage",
      "--output-format",
      "json",
    ]);
    sim({ usageExit: 1 });
    expect(await antigravityAdapter.quota?.()).toBeNull();
  });
});
````

Create `test/adapters/antigravity.contract.test.ts`:

````ts
import { join } from "node:path";
import { antigravityAdapter } from "../../src/adapters/antigravity/index.ts";
import { runAdapterContract } from "./contract.ts";

const fx = (n: string) => join(import.meta.dir, "..", "fixtures", "adapters", "antigravity", n);

// Synthetic but for the logged-out line, from the docs and the 1.2.13 changelog (research §4.4;
// test/fixtures/adapters/antigravity/README.md), until capture-fixtures records real ones.
runAdapterContract(
  antigravityAdapter,
  "antigravity:gemini-3.8-flash#high",
  [
    {
      name: "a SUCCESS result after a read, a write and a command",
      fixture: fx("ok.jsonl"),
      expect: {
        status: "ok",
        thread: "3f2a9c4e-8b1d-4e6f-a5c7-9d0e1f2a3b4c",
        tokens: { input: 15989, cached: 9728, output: 335 },
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
      name: "a resumed conversation",
      fixture: fx("resume.jsonl"),
      expect: {
        status: "ok",
        thread: "7c6b5a49-3928-4716-8a5b-4c3d2e1f0a9b",
        tokens: { input: 14800, cached: 14000, output: 12 },
      },
    },
    {
      name: "an ERROR result with an AGY_ERROR line",
      fixture: fx("error.jsonl"),
      exitCode: 3,
      stderr: 'AGY_ERROR: {"status":"INTERNAL","code":500,"retryable":true,"message":"backend error"}\n',
      expect: { status: "failed", thread: "5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716" },
    },
    {
      name: "a quota stop",
      fixture: fx("error.jsonl"),
      exitCode: 3,
      stderr:
        'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"retryable":false,"message":"Weekly quota exhausted for Gemini 3.8 Flash."}\n',
      expect: { status: "limit" },
    },
    {
      name: "the sign-in that timed out (logged out)",
      fixture: fx("logged-out.jsonl"),
      stderr:
        "Authentication required. Please visit the URL to log in: https://accounts.google.com/o/oauth2/auth?x\n",
      expect: { status: "failed", thread: null },
    },
    {
      name: "a flag this agy does not know (exit 2)",
      fixture: fx("empty.jsonl"),
      exitCode: 2,
      stderr: "flags provided but not defined: -disable-slash-commands\nUsage of agy:\n",
      expect: { status: "cli-too-old" },
    },
    {
      name: "the partial output of a print timeout (exit 0, no result)",
      fixture: fx("partial.jsonl"),
      exitCode: 0,
      stderr: "warning: print timeout reached; output is partial\n",
      expect: { status: "failed", thread: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d" },
    },
  ],
  {
    subcommands: [],
    valueFlags: ["-p", "--output-format", "--model", "--effort", "--conversation"],
    thread: "7c6b5a49-3928-4716-8a5b-4c3d2e1f0a9b",
  },
);
````

- [ ] **Step 2: Run them to see them fail**

Run: `env -u FORCE_COLOR bun test test/adapters/antigravity.test.ts test/adapters/antigravity.contract.test.ts`
Expected: FAIL: `src/adapters/antigravity/index.ts` does not exist.

- [ ] **Step 3: Implement**

Create `src/adapters/antigravity/home.ts`:

````ts
import { join } from "node:path";
import type { Access } from "../../domain/record.ts";
import { dataDir } from "../../infra/paths.ts";
import { ensurePrivateDir, writeJsonAtomic } from "../../infra/store.ts";
import { movedHomeEnv, writableRoots } from "../access.ts";

/** Where isolated agy runs keep their homes; computing it creates nothing. */
export const isolatedAgyRoot = (): string => join(dataDir(), "agy-home");

/**
 * Spec 1.3 §6.4: an isolated run's HOME. agy reads its permission rules from the one `settings.json` of its home,
 * so each access (and a workspace-write role without network) gets its own home, and lanes of different access run
 * side by side. A conversation lives in the home it started in; `resume.sameAccessOnly` keeps it there.
 */
export const isolatedAgyHome = (access: Access, network = true): string =>
  join(isolatedAgyRoot(), access === "workspace-write" && !network ? "workspace-write-offline" : access);

/**
 * The env of an isolated run: the moved HOME, which relocates every agy file, the settings among them (research
 * §4.7 [run]), with catherd's own dirs and the toolchain caches kept.
 */
export const agyHomeEnv = (access: Access, network = true): Record<string, string> =>
  movedHomeEnv(isolatedAgyHome(access, network));

/**
 * The `settings.json` of an isolated home (spec 1.3 §6.3, §6.4; research §4.7, §4.8): the Gemini API as the
 * provider, so GEMINI_API_KEY signs it in; read-only denies every write and command; workspace-write allows
 * catherd's writable roots (mounted read-write in the sandbox) and, unless the role has no network, every URL;
 * `full` runs with every tool approved and needs no rule.
 */
export function agySettings(access: Access, network = true): Record<string, unknown> {
  const provider = { modelProvider: "gemini" };
  if (access === "read-only") return { ...provider, permissions: { deny: ["write_file(*)", "command(*)"] } };
  if (access === "full") return provider;
  const allow = [...writableRoots().map((r) => `write_file(${r})`), ...(network ? ["read_url(*)"] : [])];
  return { ...provider, permissions: { allow } };
}

/** Makes the isolated home for `access` and writes its settings; catherd never writes the user's own. */
export function prepareAgyHome(access: Access, network = true): string {
  const home = isolatedAgyHome(access, network);
  const dir = join(home, ".gemini", "antigravity-cli");
  ensurePrivateDir(dir);
  writeJsonAtomic(join(dir, "settings.json"), agySettings(access, network));
  return home;
}
````

Create `src/adapters/antigravity/index.ts`:

````ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CatherdError } from "../../domain/errors.ts";
import type { Rung } from "../../domain/ids.ts";
import type { Access, RunStatus } from "../../domain/record.ts";
import {
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
import { jsonOf, runCli } from "../cli.ts";
import { discovered } from "../discovery.ts";
import {
  AGY_LIMIT,
  AGY_TOO_OLD,
  agyActivity,
  agyError,
  agyTokens,
  bodyOf,
  eventName,
  foldAgyEvents,
  isAuthFailure,
  isLimit,
  isTooOld,
  parseAgyLine,
} from "./events.ts";
import { agyHomeEnv, prepareAgyHome } from "./home.ts";
import { parseAgyModels } from "./models.ts";

export { isolatedAgyHome, isolatedAgyRoot } from "./home.ts";

/** Spec 1.3 §6.1: the version whose help, exit codes and changelog were read (research §4). */
export const AGY_MIN_VERSION = "1.2.13";
export const AGY_INSTALL =
  "curl -fsSL https://antigravity.google/cli/install.sh | bash (it installs ~/.local/bin/agy: put that dir on PATH), or brew install --cask antigravity-cli";
/** A conversation id: a UUID in the docs' examples; never flag-shaped. */
const THREAD = /^[A-Za-z0-9][\w-]{7,127}$/;
const DAY_MS = 24 * 60 * 60_000;
const LOGIN_FIX =
  "run agy once to sign in with Google, or export GEMINI_API_KEY=<key> and catherd profile set harness.antigravity.isolated true";
/** research §4.2: the background self-updater must not swap the binary under a lane (spec 1.3 §3.3) */
const ENV = { AGY_CLI_DISABLE_AUTO_UPDATE: "true" };

/** How long an `agy` query (version, models, `/usage`) may take; `agy models` took ~10 s logged out (research §4.5). */
export const agyShell = { timeoutMs: 30_000 };

/**
 * Spec 1.3 §6.2: the fixed line `-p` carries. The brief stays in its file and argv holds only its path; agy reads
 * no stdin when a prompt comes by flag (research §4.3).
 */
export const agyPrompt = (briefPath: string): string =>
  `Read the brief in ${briefPath} and follow it. Your final message is your reply.`;

/**
 * Spec 1.3 §6.3. read-only has no flag: it runs only isolated, under deny rules in catherd's settings (§9 Q2).
 * workspace-write runs shell in agy's sandbox with every tool approved (headless soft-denies what it would ask).
 */
export const AGY_ACCESS: Record<Access, string[]> = {
  "read-only": [],
  "workspace-write": ["--sandbox", "--dangerously-skip-permissions"],
  full: ["--dangerously-skip-permissions"],
};

/**
 * Whether the last probe found agy's own login signed out (null: not probed, or it could not tell). A native run
 * then would open a browser and wait (research §4.8), so `prepare` refuses it; an isolated one signs in by key.
 */
let nativeLogin: boolean | null = null;

function plan(r: RunRequest): SpawnPlan {
  if (r.thread !== null && !THREAD.test(r.thread))
    throw new CatherdError("E_ADMIT_THREAD", `"${r.thread}" is not an agy conversation id`, {
      fix: "pass the thread from the earlier RunRecord",
    });
  const { model, effort } = r.rung;
  return {
    cmd: "agy",
    args: [
      "-p",
      agyPrompt(r.briefPath),
      "--output-format",
      "stream-json",
      "--model",
      model,
      ...(effort === "default" ? [] : ["--effort", effort]),
      "--disable-slash-commands",
      ...AGY_ACCESS[r.access],
      // conversations are scoped by cwd: a resume runs in the recorded repo (research §4.6)
      ...(r.thread === null ? [] : ["--conversation", r.thread]),
    ],
    env: { ...ENV, ...(r.isolated ? agyHomeEnv(r.access, r.network !== false) : {}) },
    cwd: r.repo,
    stdinPath: null,
  };
}

async function listModels(): Promise<DiscoveredModel[]> {
  const r = await runCli("agy", ["models"], { ...agyShell, env: ENV });
  return r?.ok ? parseAgyModels(r.out) : [];
}

/**
 * Spec 1.3 §6.3, §6.4, §9 Q2: read-only runs only isolated; an isolated run needs GEMINI_API_KEY and gets its
 * home and settings; a native one needs agy's own login; the rung's model and effort must be ones agy lists.
 */
async function prepare(req: {
  rung: Rung;
  access: Access;
  isolated: boolean;
  network?: boolean;
}): Promise<void> {
  if (!req.isolated && req.access === "read-only")
    throw new CatherdError("E_ADMIT_RUNG", "native agy has no read-only mode", {
      fix: "catherd profile set harness.antigravity.isolated true (it needs GEMINI_API_KEY), or put this role on another backend",
    });
  if (req.isolated) {
    if (!process.env.GEMINI_API_KEY)
      throw new CatherdError("E_BACKEND_NOT_LOGGED_IN", "an isolated antigravity run needs GEMINI_API_KEY", {
        fix: "export GEMINI_API_KEY=<key>, or catherd profile set harness.antigravity.isolated false",
      });
    prepareAgyHome(req.access, req.network !== false);
  } else if (nativeLogin === false)
    throw new CatherdError(
      "E_BACKEND_NOT_LOGGED_IN",
      "agy is not signed in: a native run would open a browser",
      {
        fix: LOGIN_FIX,
      },
    );
  const { model, effort } = req.rung;
  const models = await discovered("antigravity", listModels, { maxAgeMs: DAY_MS, need: model });
  if (models.length === 0) return; // agy listed nothing: let the run itself say what is wrong
  const m = models.find((x) => x.id === model);
  if (!m)
    throw new CatherdError("E_BACKEND_MODEL_UNKNOWN", `agy does not list ${model}`, {
      fix: "run agy models; a rung names the model without its effort suffix",
    });
  if (!m.efforts.includes(effort))
    throw new CatherdError("E_BACKEND_MODEL_UNKNOWN", `agy lists no ${model} at effort ${effort}`, {
      fix: `use one of: ${m.efforts.map((e) => `antigravity:${model}#${e}`).join(", ")}`,
    });
}

function finalize(run: FinishedRun): Outcome {
  const f = foldAgyEvents(run.eventLines);
  const res = f.result;
  const stopped = run.exit.reason;
  const err = agyError(run.stderr);
  const stderrLines = run.stderr.trim().split("\n").filter(Boolean);
  const status: RunStatus =
    stopped === "cancelled"
      ? "cancelled"
      : stopped === "idle-timeout" || stopped === "wall-timeout"
        ? "timeout"
        : res?.status === "SUCCESS"
          ? "ok"
          : res?.status === "CANCELED" || res?.status === "INTERRUPTED"
            ? "cancelled"
            : run.exit.code === 2 || isTooOld(run.stderr)
              ? "cli-too-old"
              : isLimit(`${err?.text ?? ""}\n${res?.error ?? ""}`)
                ? "limit"
                : "failed";
  const message =
    res?.error && isAuthFailure(res.error)
      ? `${res.error} (fix: ${LOGIN_FIX})`
      : (err?.message ??
        stderrLines.find(isTooOld) ??
        (res?.error ||
          (res && res.status !== "SUCCESS" ? `agy ended the run ${res.status}` : "") ||
          stderrLines.at(-1) ||
          `no result event (${stopped}, exit ${run.exit.code ?? run.exit.signal})`));
  return {
    status,
    thread: f.thread ?? run.request.thread,
    tokens: res?.tokens ?? agyTokens(undefined),
    costUsd: null,
    images: [],
    error: status === "ok" ? null : { code: status, message },
    ...(status === "ok" ? { reply: res?.response ?? "" } : {}),
  };
}

function parse(line: string): EventDelta {
  const e = parseAgyLine(line);
  if (!e) return {};
  const b = bodyOf(e);
  const d: EventDelta = { lastEvent: eventName(e) };
  const activity = agyActivity(e);
  if (activity) d.activity = activity;
  if (typeof b.conversation_id === "string" && b.conversation_id) d.thread = b.conversation_id;
  if (e.event === "step_update") {
    if (b.usage) d.requestInput = agyTokens(b.usage).input;
    // a tool step runs between ACTIVE and DONE, often printing nothing: the run is busy
    if (b.step_type === "tool" && typeof b.step_index === "number")
      d.item = { id: `step-${b.step_index}`, open: b.state === "ACTIVE" };
  }
  if (e.event === "result") {
    d.final = true;
    d.tokens = agyTokens(b.usage);
    if (b.status !== "SUCCESS") {
      d.failure = String(b.error || b.status || "error");
      if (isLimit(d.failure)) d.limit = true;
    }
  }
  return d;
}

/** The user's own agy settings (read, never written: the desktop app shares them, spec 1.3 §9 Q3). */
function userSettings(): Record<string, unknown> | null {
  const file = join(process.env.HOME || homedir(), ".gemini", "antigravity-cli", "settings.json");
  if (!existsSync(file)) return null;
  const j = jsonOf(readFileSync(file, "utf8"));
  return j && typeof j === "object" ? (j as Record<string, unknown>) : null;
}

/**
 * Spec 1.3 §6.1, §3.3. Logged in: `agy models` answered. It fails fast when logged out, where `agy -p` would open
 * a browser and wait (research §4.5, §4.8), so the probe never runs `-p`. Logged out is a problem unless
 * GEMINI_API_KEY is set, which an isolated run signs in with; `prepare` then refuses the native runs.
 */
async function probe(): Promise<Probe> {
  const v = await runCli("agy", ["--version"], { ...agyShell, env: ENV });
  if (!v)
    return {
      installed: false,
      version: null,
      versionOk: false,
      loggedIn: null,
      problems: [{ code: "E_BACKEND_MISSING", message: "agy is not on PATH", fix: AGY_INSTALL }],
    };
  const version = extractVersion(v.out);
  const versionOk = version !== null && compareVersions(version, AGY_MIN_VERSION) >= 0;
  const m = await runCli("agy", ["models"], { ...agyShell, env: ENV });
  nativeLogin = m?.ok ? true : isAuthFailure(`${m?.out ?? ""}\n${m?.err ?? ""}`) ? false : null;
  // research §4.8: GEMINI_API_KEY signs agy in only with modelProvider "gemini" in its settings
  const byKey =
    nativeLogin === true && userSettings()?.modelProvider === "gemini" && !!process.env.GEMINI_API_KEY;
  const problems: Probe["problems"] = [];
  if (!versionOk)
    problems.push({
      code: "E_BACKEND_TOO_OLD",
      message: `agy ${version ?? "?"} is older than ${AGY_MIN_VERSION}`,
      fix: "brew upgrade --cask antigravity-cli, or run the install script again",
    });
  if (nativeLogin === false && !process.env.GEMINI_API_KEY)
    problems.push({
      code: "E_BACKEND_NOT_LOGGED_IN",
      message: "agy is not signed in (agy models says: Please sign in)",
      fix: LOGIN_FIX,
    });
  return {
    installed: true,
    version,
    versionOk,
    loggedIn: nativeLogin,
    // spec 1.3 §9 Q4: a Google login draws on the plan's quota; the key bills the Gemini API project
    ...(nativeLogin
      ? {
          login: byKey ? "API key" : "Google",
          billing: byKey ? ("metered" as const) : ("subscription" as const),
        }
      : {}),
    problems,
  };
}

/**
 * Spec 1.3 §6.6: `agy -p "/usage" --output-format json` answers without an agent turn (research §4.8; unverified
 * live). Doctor calls it only when the probe found agy logged in. The reply's lines, joined; null when it fails.
 */
async function quota(): Promise<string | null> {
  const r = await runCli("agy", ["-p", "/usage", "--output-format", "json"], { ...agyShell, env: ENV });
  if (!r?.ok) return null;
  const j = jsonOf(r.out) as Record<string, unknown> | null;
  const text = typeof j?.response === "string" ? j.response : r.out;
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" · ")
      .slice(0, 200) || null
  );
}

export const antigravityAdapter: BackendAdapter = {
  id: "antigravity",
  minVersion: AGY_MIN_VERSION,
  install: AGY_INSTALL,
  probe,
  listModels,
  prepare,
  plan,
  parse,
  finalize,
  // read-only: deny rules in catherd's settings, never a flag; workspace-write: shell in the sandbox, but the file
  // tools, every one approved, are not confined by it (research §4.7)
  enforcement: { "read-only": "advisory", "workspace-write": "advisory", full: "enforced" },
  errors: { limit: AGY_LIMIT, tooOld: AGY_TOO_OLD },
  // until the live kit shows a resume takes the new run's permissions (research §4.6)
  resume: { supported: true, sameAccessOnly: true, threadPattern: THREAD },
  isolationNote:
    "native Antigravity shares its settings and permission rules with the Antigravity desktop app",
  isolationKey: "GEMINI_API_KEY",
  isolatedOnly: ["read-only"],
  quota,
  // agy leaves daemon background tasks (dev servers) running after its result (research §4.4)
  graceAfterFinalMs: 30_000,
};
````

- [ ] **Step 4: Run the tests and the checks**

Run: `env -u FORCE_COLOR bun test test/adapters/antigravity.test.ts test/adapters/antigravity.contract.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/antigravity/home.ts src/adapters/antigravity/index.ts test/adapters/antigravity.contract.test.ts test/adapters/antigravity.test.ts
git commit -m "feat(antigravity): the agy adapter: plan, probe, prepare, finalize, quota and contract suite" -m "Spec 1.3 §6. A native run needs agy's own login and never a read-only role;" -m "an isolated one signs in with GEMINI_API_KEY under catherd's settings." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 6: Register the agy adapter, with doctor's quota, isolation and access rows (spec 1.3 §6.6, §8)

`all.ts` registers `antigravityAdapter`. Every machine's doctor now shows `backend:antigravity` (`skip missing` where agy is not on PATH); a profile with a role on it adds `quota:antigravity`, `isolation:antigravity` and `access:antigravity skip not tested`. The harness lists (`profile show`, the dashboard's effects) gain `antigravity`. A dispatch test runs the simulator end to end.

**Files:**

- Modify: `src/adapters/all.ts`
- Test: `test/entry/profile-command.test.ts`
- Test: `test/entry/tui/effects.test.ts`
- Test (new): `test/services/antigravity-dispatch.test.ts`
- Test: `test/services/doctor.test.ts`

**Interfaces:**
- Consumes: Task 5's adapter; `fakeDeps`, `freshRun`, `runRole`, `testView`, `writeLane` (`test/services/helpers.ts`); `machine()` in `test/services/doctor.test.ts` gains an `agy` scenario.

- [ ] **Step 1: Write the failing tests**

Create `test/services/antigravity-dispatch.test.ts`:

````ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedAgyHome } from "../../src/adapters/antigravity/index.ts";
import { replyContract } from "../../src/domain/role-prompts.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { dispatch, type DispatchInput } from "../../src/services/dispatch-service.ts";
import { snapshotEnv, tempDir } from "../helpers.ts";
import { simPath } from "../sim/scenario.ts";
import { type AgyScenario, withAgyScenario } from "../sim/sim-scenarios.ts";
import { fakeDeps, freshRun, runRole, testView, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "antigravity");
const FLASH = "antigravity:gemini-3.8-flash#high";

function setup(s: AgyScenario, access: "read-only" | "workspace-write" = "workspace-write") {
  const { repo, run } = freshRun();
  process.env.PATH = simPath();
  // the simulator reads HOME's agy settings: never the user's own
  process.env.HOME = tempDir("catherd-agyhome-");
  delete process.env.GEMINI_API_KEY;
  const sim = withAgyScenario({ modelsFile: join(FX, "models.txt"), ...s });
  Object.assign(process.env, sim.env);
  writeLane(run, "M1.L1", ["src/a.ts"]);
  const view = testView();
  view.roles.worker = { enabled: true, access, rungs: [FLASH] };
  return { repo, run, sim, deps: fakeDeps({ view }) };
}

const input = (run: string, over: Partial<DispatchInput> = {}): DispatchInput => ({
  run,
  role: "worker",
  name: "worker-M1.L1",
  brief: "---\nRead lanes/M1.L1.md",
  rung: FLASH,
  lane: "M1.L1",
  ...over,
});

const code = async (p: Promise<unknown>) => ((await p.catch((x: unknown) => x)) as { code?: string }).code;

describe("dispatch on agy (simulator)", () => {
  it("runs in the repo with -p naming the brief file, the effort flag, and the result's reply and tokens", async () => {
    const { repo, run, sim, deps } = setup({
      eventsFile: join(FX, "ok.jsonl"),
      touch: [{ path: "src/a.ts", content: "new" }],
    });
    const { record } = await runRole(deps, input(run.id));
    expect(record).toMatchObject({
      status: "ok",
      backend: "antigravity",
      replyStatus: "complete",
      tokens: { input: 15989, cached: 9728, output: 335 },
      changedOwned: ["src/a.ts"],
      cliVersion: "1.2.13",
      thread: "00000000-0000-4000-8000-0000000a9e1d",
    });
    const seen = sim.recorded();
    const brief = /^Read the brief in (\S+) and follow it\. Your final message is your reply\.$/.exec(
      seen.stdin,
    )?.[1];
    expect(readFileSync(brief as string, "utf8")).toBe(
      `---\nRead lanes/M1.L1.md\n\n${replyContract("worker")}\n`,
    );
    expect(seen.args.slice(2)).toEqual([
      "--output-format",
      "stream-json",
      "--model",
      "gemini-3.8-flash",
      "--effort",
      "high",
      "--disable-slash-commands",
      "--sandbox",
      "--dangerously-skip-permissions",
    ]);
    expect([seen.cwd, seen.vars?.AGY_CLI_DISABLE_AUTO_UPDATE]).toEqual([repo, "true"]);
  });

  it("refuses a logged-out agy before anything runs, and never opens the browser", async () => {
    const browserTo = join(tempDir("catherd-browser-"), "opened");
    const { run, sim, deps } = setup({ loggedIn: false, browserTo, eventsFile: join(FX, "ok.jsonl") });
    expect(await code(dispatch(deps, input(run.id)))).toBe("E_BACKEND_NOT_LOGGED_IN");
    expect([sim.ran(), existsSync(browserTo)]).toEqual([false, false]);
  });

  it("runs isolated on GEMINI_API_KEY alone under catherd's HOME and settings, and refuses a native run then", async () => {
    const browserTo = join(tempDir("catherd-browser-"), "opened");
    const { run, sim, deps } = setup({ loggedIn: false, browserTo, eventsFile: join(FX, "ok.jsonl") });
    process.env.GEMINI_API_KEY = "key-for-test";
    expect(await code(dispatch(deps, input(run.id)))).toBe("E_BACKEND_NOT_LOGGED_IN");
    deps.view.isolated = { antigravity: true };
    const { record } = await runRole(deps, input(run.id, { name: "worker-M1.L1b" }));
    expect(record).toMatchObject({ status: "ok", isolated: true });
    expect(sim.recorded()).toMatchObject({
      home: isolatedAgyHome("workspace-write"),
      settings: { modelProvider: "gemini", permissions: { allow: expect.arrayContaining(["read_url(*)"]) } },
    });
    expect(existsSync(browserTo)).toBe(false);
  });

  it("refuses a read-only role on native agy before anything runs (spec 1.3 §9 Q2)", async () => {
    const { run, sim, deps } = setup({ eventsFile: join(FX, "ok.jsonl") }, "read-only");
    expect(await code(dispatch(deps, input(run.id)))).toBe("E_ADMIT_RUNG");
    expect(sim.ran()).toBe(false);
  });

  it("records a quota stop as a limit, so failover can move the role", async () => {
    const { run, deps } = setup({
      eventsFile: join(FX, "error.jsonl"),
      exitCode: 3,
      stderr: 'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","code":429,"message":"Weekly quota exhausted."}\n',
    });
    const { record } = await runRole(deps, input(run.id));
    expect(record.status).toBe("limit");
  });
});
````

Modify `test/services/doctor.test.ts` (re-find each hunk by its context):

````diff
@@ -22,11 +22,13 @@ import { credentialsPath, saveJevKey } from "../../src/services/jev-service.ts";
 import { activate, createProfile, patchProfile } from "../../src/services/profile-service.ts";
 import { configFile } from "../../src/services/profile-store.ts";
 import { fakeFetch } from "../fake-fetch.ts";
-import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
+import { snapshotEnv, tempDir, tempRepo, withHome } from "../helpers.ts";
 import { type CodexScenario, withScenario } from "../sim/scenario.ts";
 import {
+  type AgyScenario,
   type CursorScenario,
   type OpencodeScenario,
+  withAgyScenario,
   withClaudeScenario,
   withCursorScenario,
   withOpencodeScenario,
@@ -55,7 +57,13 @@ const fx = (p: string) => JSON.parse(readFileSync(join(FX, p), "utf8"));
 
 /** A machine with the simulated CLIs `bins` on PATH (all three by default), the codex sandbox allowing writes. */
 function machine(
-  o: { codex?: CodexScenario; opencode?: OpencodeScenario; cursor?: CursorScenario; bins?: string[] } = {},
+  o: {
+    codex?: CodexScenario;
+    opencode?: OpencodeScenario;
+    cursor?: CursorScenario;
+    agy?: AgyScenario;
+    bins?: string[];
+  } = {},
 ): string {
   const home = withHome();
   process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
@@ -72,8 +80,10 @@ function machine(
     withClaudeScenario({}).env,
     withOpencodeScenario({ models: fx("opencode/models.json").data, ...o.opencode }).env,
     withCursorScenario({ modelsFile: join(FX, "cursor", "models.txt"), ...o.cursor }).env,
+    withAgyScenario({ modelsFile: join(FX, "antigravity", "models.txt"), ...o.agy }).env,
   );
   delete process.env.CURSOR_API_KEY;
+  delete process.env.GEMINI_API_KEY;
   return home;
 }
 
@@ -115,6 +125,7 @@ describe("doctor", () => {
       "backend:claude-code": "ok ready",
       "backend:opencode": "ok ready",
       "backend:cursor": "skip missing",
+      "backend:antigravity": "skip missing",
       jev: "warn no key",
       sources: "info not synced",
       plugin: "ok ready",
@@ -167,6 +178,46 @@ describe("doctor", () => {
     });
   });
 
+  it("shows agy's version, Google login, listing and quota, its isolation note and its untested access", async () => {
+    machine({ bins: ["codex", "claude", "opencode", "agy"] });
+    // the probe reads HOME's agy settings: never the user's own
+    process.env.HOME = tempDir("catherd-userhome-");
+    installPlugin(VERSION);
+    const saved = patchProfile("default", {
+      roles: { writer: { rungs: ["antigravity:gemini-3.8-flash#high"] } },
+    });
+    expect(saved.saved).toBe(true);
+    const r = await run();
+    expect(check(r, "backend:antigravity")).toMatchObject({
+      state: "warn",
+      word: "billing",
+      detail:
+        "1.2.13 · Google login · profile default bills antigravity as metered, but this login is subscription · 6 models",
+      fix: "catherd profile set billing.antigravity subscription --profile default",
+    });
+    expect(check(r, "quota:antigravity")).toMatchObject({
+      state: "info",
+      detail: "Weekly quota: 62% left, resets Monday 09:00",
+    });
+    expect(check(r, "isolation:antigravity")?.detail).toBe(
+      "native Antigravity shares its settings and permission rules with the Antigravity desktop app",
+    );
+    expect(check(r, "access:antigravity")).toMatchObject({ state: "skip", word: "not tested" });
+    expect(r.ready).toBe(true);
+  });
+
+  it("fails a logged-out agy a role runs on, with the login fix, and asks it no quota", async () => {
+    const usageTo = join(tempDir("catherd-usage-"), "args");
+    machine({ bins: ["codex", "claude", "opencode", "agy"], agy: { loggedIn: false, usageTo } });
+    process.env.HOME = tempDir("catherd-userhome-");
+    installPlugin(VERSION);
+    patchProfile("default", { roles: { writer: { rungs: ["antigravity:gemini-3.8-flash#high"] } } });
+    const r = await run();
+    expect(check(r, "backend:antigravity")).toMatchObject({ state: "fail", word: "not logged in" });
+    expect(check(r, "quota:antigravity")).toBeUndefined();
+    expect(existsSync(usageTo)).toBe(false);
+  });
+
   it("fails on a backend a role runs on, but only warns on one a failover stand-in alone uses", async () => {
     ready();
     process.env.PATH = process.env.PATH?.replace(/^[^:]+/, (bin) => {
````

Modify `test/entry/profile-command.test.ts` (re-find each hunk by its context):

````diff
@@ -38,7 +38,9 @@ describe("catherd profile show", () => {
       "  codex:gpt-6-sol#medium → opencode:opencode-go/kimi-k3#max (scores borrowed from gpt-6-sol#medium)\n",
     );
     expect(r.out).not.toContain("treated like");
-    expect(r.out).toContain("harness codex native · claude-code native · opencode native · cursor native\n");
+    expect(r.out).toContain(
+      "harness codex native · claude-code native · opencode native · cursor native · antigravity native\n",
+    );
     expect(r.out).not.toContain("grok");
   });
 
````

Modify `test/entry/tui/effects.test.ts` (re-find each hunk by its context):

````diff
@@ -216,7 +216,7 @@ describe("the live effects", () => {
   it("names the harnesses, the native agents and each rung's enforcement", () => {
     withHome();
     const fx = liveEffects();
-    expect([...fx.harnesses].sort()).toEqual(["claude-code", "codex", "cursor", "opencode"]);
+    expect([...fx.harnesses].sort()).toEqual(["antigravity", "claude-code", "codex", "cursor", "opencode"]);
     const p = resolveProfile(defaultProfileDoc(), "default");
     expect(fx.agents(p)).toContain("catherd-default-architect-claude-opus-5-5-high");
     expect(fx.enforcement("codex:gpt-6-sol#high", "workspace-write")).toBe("enforced");
````

- [ ] **Step 2: Run them to see them fail**

Run: `env -u FORCE_COLOR bun test test/services/antigravity-dispatch.test.ts test/services/doctor.test.ts test/entry/profile-command.test.ts test/entry/tui/effects.test.ts`
Expected: FAIL: `antigravity:` rungs are refused `E_BACKEND_MISSING` (no adapter registered), and doctor has no `backend:antigravity` row.

- [ ] **Step 3: Implement**

Modify `src/adapters/all.ts` (re-find each hunk by its context):

````diff
@@ -1,3 +1,4 @@
+import { antigravityAdapter } from "./antigravity/index.ts";
 import { claudeCodeAdapter } from "./claude-code/index.ts";
 import { codexAdapter } from "./codex/index.ts";
 import { cursorAdapter } from "./cursor/index.ts";
@@ -8,3 +9,4 @@ registerAdapter(codexAdapter);
 registerAdapter(claudeCodeAdapter);
 registerAdapter(opencodeAdapter);
 registerAdapter(cursorAdapter);
+registerAdapter(antigravityAdapter);
````

- [ ] **Step 4: Run the tests and the checks**

Run: `env -u FORCE_COLOR bun test test/services/antigravity-dispatch.test.ts test/services/doctor.test.ts test/entry/profile-command.test.ts test/entry/tui/effects.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/all.ts test/entry/profile-command.test.ts test/entry/tui/effects.test.ts test/services/antigravity-dispatch.test.ts test/services/doctor.test.ts
git commit -m "feat(antigravity): register the agy adapter, with doctor's quota, isolation and access rows" -m "Spec 1.3 §6.6, §8." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 7: Capture cases for agy's work, resume and read-only, and a live test behind CATHERD_LIVE (spec 1.3 §6.6, §10; Ruling 20)

`capture-fixtures --backend antigravity` records three cases, isolated on `GEMINI_API_KEY` (`antigravity:gemini-3.8-flash#low`): `ok` (workspace-write: a write, a read and a shell call), `resume` (read-only: a hello, then a recall on the same conversation), `read-only-write` (catherd's deny rules). `test/live/antigravity.live.test.ts` runs only with `CATHERD_LIVE=1`: native workspace-write with a resume, and isolated read-only when `GEMINI_API_KEY` is set.

**Files:**

- Modify: `src/services/capture.ts`
- Test: `test/entry/capture-fixtures-command.test.ts`
- Test (new): `test/live/antigravity.live.test.ts`
- Test: `test/services/capture.test.ts`

**Interfaces:**
- Consumes: `captureFixtures`, `CAPTURE_CASES` (`src/services/capture.ts`); Task 6's registration.

- [ ] **Step 1: Write the failing tests**

Modify `test/services/capture.test.ts` (re-find each hunk by its context):

````diff
@@ -7,10 +7,11 @@ import { opencodeShell } from "../../src/adapters/opencode/index.ts";
 import { formatCaptured } from "../../src/entry/capture-fixtures-command.ts";
 import { resetReadiness } from "../../src/services/backends.ts";
 import { captureFixtures, captureOne } from "../../src/services/capture.ts";
-import { snapshotEnv, withHome } from "../helpers.ts";
+import { snapshotEnv, tempDir, withHome } from "../helpers.ts";
 import { simPath } from "../sim/scenario.ts";
 import {
   type OpencodeModel,
+  withAgyScenario,
   withClaudeScenario,
   withCursorScenario,
   withOpencodeScenario,
@@ -111,6 +112,39 @@ describe("capture-fixtures", () => {
     expect(readFileSync(join(out, "cursor", "2026.09.28", "ok.jsonl"), "utf8")).not.toContain(SECRET);
   });
 
+  it("captures agy's work, resume and read-only cases isolated on the API key, the resume on the first conversation", async () => {
+    withHome();
+    process.env.PATH = simPath();
+    // the simulator reads HOME's agy settings: never the user's own; no Google login, the key alone
+    process.env.HOME = tempDir("catherd-agyhome-");
+    process.env.GEMINI_API_KEY = SECRET;
+    const listing = join(tempDir("catherd-agylist-"), "models.txt");
+    writeFileSync(listing, "Fetching available models...\n  gemini-3.8-flash\n");
+    const sim = withAgyScenario({
+      loggedIn: false,
+      modelsFile: listing,
+      eventsFile: join(FX, "antigravity", "ok.jsonl"),
+    });
+    Object.assign(process.env, sim.env);
+    const out = mkdtempSync(join(tmpdir(), "catherd-fixtures-"));
+    const results = await captureFixtures({ outDir: out, backends: ["antigravity"] });
+    expect(results.map((r) => [r.backend, r.name, r.status])).toEqual([
+      ["antigravity", "ok", "captured"],
+      ["antigravity", "resume", "captured"],
+      ["antigravity", "read-only-write", "captured"],
+    ]);
+    const resumed = JSON.parse(readFileSync(join(out, "antigravity", "1.2.13", "resume.json"), "utf8"));
+    expect(resumed).toMatchObject({
+      rung: "antigravity:gemini-3.8-flash#low",
+      resumed: "00000000-0000-4000-8000-0000000a9e1d",
+      outcome: { status: "ok", thread: "00000000-0000-4000-8000-0000000a9e1d" },
+    });
+    expect(sim.recorded()).toMatchObject({
+      settings: { permissions: { deny: ["write_file(*)", "command(*)"] } },
+    });
+    expect(readFileSync(join(out, "antigravity", "1.2.13", "ok.jsonl"), "utf8")).not.toContain(SECRET);
+  });
+
   it("records the totals the opencode service settles on, not only what the stream said", async () => {
     withHome();
     process.env.PATH = simPath();
````

Modify `test/entry/capture-fixtures-command.test.ts` (re-find each hunk by its context):

````diff
@@ -13,7 +13,7 @@ describe("catherd capture-fixtures", () => {
     });
     expect(p.exitCode).toBe(2);
     expect(p.stderr.toString()).toBe(
-      'error E_INPUT_INVALID: no capture cases for backend "grok"\nfix: catherd capture-fixtures --backend codex|claude-code|opencode|cursor\n',
+      'error E_INPUT_INVALID: no capture cases for backend "grok"\nfix: catherd capture-fixtures --backend codex|claude-code|opencode|cursor|antigravity\n',
     );
   });
 
````

Create `test/live/antigravity.live.test.ts`:

````ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resetReadiness } from "../../src/services/backends.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun, runRole, testView } from "../services/helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

// Spec 1.3 §6.6 and docs/dev/live-verification.md §13: agy on PATH, signed in with Google for the native tests
// (catherd refuses a logged-out agy before it can open a browser), GEMINI_API_KEY for the isolated one.
const FLASH = "antigravity:gemini-3.8-flash#low";

function live(access: "read-only" | "workspace-write", isolated = false) {
  const { repo, run } = freshRun("live antigravity");
  const view = testView({ isolated: { antigravity: isolated } });
  view.roles.worker = { enabled: true, access, rungs: [FLASH] };
  return { repo, run, deps: fakeDeps({ view }) };
}

const STATUS = "The last line of your reply is exactly: STATUS: complete — done";

describe.skipIf(!process.env.CATHERD_LIVE)("live agy", () => {
  it("writes in the repo on workspace-write, and resumes the conversation it started (research §4.6)", async () => {
    const { repo, run, deps } = live("workspace-write");
    const first = await runRole(deps, {
      run: run.id,
      role: "worker",
      name: "worker-1",
      rung: FLASH,
      brief: `Create a file named out.txt containing the word hi. ${STATUS}`,
    });
    expect(first.record).toMatchObject({ status: "ok", replyStatus: "complete", backend: "antigravity" });
    expect(first.record.tokens.input).toBeGreaterThan(0);
    expect(existsSync(join(repo, "out.txt"))).toBe(true);
    const again = await runRole(deps, {
      run: run.id,
      role: "worker",
      name: "worker-2",
      rung: FLASH,
      thread: first.record.thread ?? undefined,
      brief: `Which file did you create earlier in this conversation? Name it. ${STATUS}`,
    });
    expect(again.record.thread).toBe(first.record.thread);
    expect(readFileSync(again.record.replyPath, "utf8")).toContain("out.txt");
  }, 600_000);

  it.skipIf(!process.env.GEMINI_API_KEY)(
    "keeps an isolated read-only role from writing: catherd's deny rules (advisory)",
    async () => {
      const { repo, run, deps } = live("read-only", true);
      const { record } = await runRole(deps, {
        run: run.id,
        role: "worker",
        name: "worker-3",
        rung: FLASH,
        brief:
          "Create a file named out.txt containing hi. If you cannot, say why. The last line of your reply is: STATUS: complete|blocked — <why>",
      });
      expect(record).toMatchObject({ status: "ok", isolated: true });
      expect(existsSync(join(repo, "out.txt"))).toBe(false);
    },
    300_000,
  );
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `env -u FORCE_COLOR bun test test/services/capture.test.ts test/entry/capture-fixtures-command.test.ts`
Expected: FAIL: no capture cases for antigravity (and the fix line lacks it).

- [ ] **Step 3: Implement**

Modify `src/services/capture.ts` (re-find each hunk by its context):

````diff
@@ -37,6 +37,8 @@ const HAIKU = "claude-code:claude-haiku-4-5-20251001#default";
 /** spec 1.3 §4.6: `auto` has no family; only the live kit and the capture run it */
 const AUTO = "cursor:auto#default";
 const BUNNY = "opencode:opencode/space-bunny-free#default";
+/** spec 1.3 §6.6: the cheapest Gemini effort; capture runs isolated, on GEMINI_API_KEY */
+const FLASH_LOW = "antigravity:gemini-3.8-flash#low";
 
 /** Spec §11.7–8: one cheap run per backend, plus a read-only role trying to write where enforcement is advisory. */
 const CAPTURE_CASES: CaptureCase[] = [
@@ -49,6 +51,17 @@ const CAPTURE_CASES: CaptureCase[] = [
   { backend: "cursor", name: "ok", rung: AUTO, access: "workspace-write", brief: WORK },
   { backend: "cursor", name: "resume", rung: AUTO, access: "read-only", brief: SAY_HELLO, resume: RECALL },
   { backend: "cursor", name: "read-only-write", rung: AUTO, access: "read-only", brief: TRY_WRITE },
+  // spec 1.3 §6.6: the same three on agy; read-only runs under catherd's deny rules (research §8 agy 2, 5, 6)
+  { backend: "antigravity", name: "ok", rung: FLASH_LOW, access: "workspace-write", brief: WORK },
+  {
+    backend: "antigravity",
+    name: "resume",
+    rung: FLASH_LOW,
+    access: "read-only",
+    brief: SAY_HELLO,
+    resume: RECALL,
+  },
+  { backend: "antigravity", name: "read-only-write", rung: FLASH_LOW, access: "read-only", brief: TRY_WRITE },
 ];
 export const CAPTURE_BACKENDS = [...new Set(CAPTURE_CASES.map((c) => c.backend))];
 
````

- [ ] **Step 4: Run the tests and the checks**

Run: `env -u FORCE_COLOR bun test test/services/capture.test.ts test/entry/capture-fixtures-command.test.ts test/live/antigravity.live.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/services/capture.ts test/entry/capture-fixtures-command.test.ts test/live/antigravity.live.test.ts test/services/capture.test.ts
git commit -m "test(antigravity): capture cases for work, resume and read-only, and a live test behind CATHERD_LIVE" -m "Spec 1.3 §6.6, §10." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 8: Docs: the README, the setup skill and live verification §13 (spec 1.3 §8, §9 Q7, §10)

The README gains agy in the requirements, an Antigravity section (rungs, the no-browser rule, billing, failover, native vs isolated, read-only only isolated) with spec §9 Q7's terms note, and `GEMINI_API_KEY` in the environment table. The setup skill names `antigravity` among the billing keys and harnesses and its isolation key. `docs/dev/live-verification.md` gains §13 from research §8's agy list, one step per plan ruling a live check decides. Docs only: no test.

**Files:**

- Modify: `README.md`
- Modify: `docs/dev/live-verification.md`
- Modify: `plugin/skills/catherd-setup/SKILL.md`

**Interfaces:**
- Consumes: nothing new.

- [ ] **Step 1: Implement**

Modify `README.md` (re-find each hunk by its context):

````diff
@@ -6,15 +6,15 @@
  (")(")
 ```
 
-Autopilot builds from your own Claude Code session. Claude plans and verifies, Codex, opencode, Cursor or
-headless Claude Code workers write the code, and [Jev](https://typesafe.ai) picks the model and effort for each piece
+Autopilot builds from your own Claude Code session. Claude plans and verifies, Codex, opencode, Cursor,
+Antigravity or headless Claude Code workers write the code, and [Jev](https://typesafe.ai) picks the model and effort for each piece
 of work, climbing a ladder only when a cheaper rung falls short.
 
 - **Your harness, as you set it up.** Every role runs in its vendor's own CLI with your config,
   hooks, skills and `AGENTS.md`. Isolation is an opt-in toggle per profile and harness, for when
   you'd rather save the tokens your customizations cost.
 - **Claude roles stay native.** `claude:` rungs run as ordinary Claude Code subagents; Codex,
-  opencode, Cursor and headless `claude-code:` rungs run through catherd's MCP server.
+  opencode, Cursor, Antigravity and headless `claude-code:` rungs run through catherd's MCP server.
 - **Survives restarts.** Workers are detached processes writing straight to disk, so a dropped
   MCP server never loses a run.
 - **Results come to you.** Roles run side by side while you keep talking to Claude; each one that finishes
@@ -36,6 +36,9 @@ of work, climbing a ladder only when a cheaper rung falls short.
   - Claude Code's `claude` CLI 2.1.282 or newer, for headless `claude-code:` rungs
   - Cursor's CLI, `cursor-agent` 2026.09.28 or newer: `curl https://cursor.com/install -fsS | bash`, then
     `cursor-agent login` (below)
+  - Google's Antigravity CLI, `agy` 1.2.13 or newer: `brew install --cask antigravity-cli`, or
+    `curl -fsSL https://antigravity.google/cli/install.sh | bash` (with `~/.local/bin` on PATH), then run `agy` once
+    to sign in (below)
 - Optional: a TypeSafe API key for Jev, in `TYPESAFE_API_KEY` or saved by `catherd init`
 - Optional: a free [Artificial Analysis](https://artificialanalysis.ai) API key for more scores, in
   `ARTIFICIAL_ANALYSIS_API_KEY` or saved by `catherd init`; its numbers are read for you alone and never shipped
@@ -61,6 +64,27 @@ usage, so a Cursor rung ranks as `metered`.
   move to another home. catherd runs Cursor under its own HOME with its own `sandbox.json`, which gives a worker
   catherd's writable roots.
 
+### Antigravity
+
+An Antigravity rung names the model `agy models` lists, without an effort suffix; the effort is agy's `--effort`
+(`low`, `medium`, `high` or `max`), and `#default` passes none: `antigravity:gemini-3.8-flash#low`. No profile uses
+Antigravity until you put a rung on it. catherd never runs `agy -p` while agy is signed out, since agy would open a
+browser and wait; `catherd doctor` says so, with the fix. A Google login draws on your plan's quota (doctor shows
+what is left); `GEMINI_API_KEY` bills the Gemini API project. Gemini rungs fail over between Antigravity and Cursor
+when either runs out, unless your profile names another stand-in.
+
+- **Native** (the default) runs with your Google login and your `~/.gemini` settings, which the Antigravity desktop
+  app shares and catherd never edits. `workspace-write` runs shell commands in agy's sandbox, which reaches the
+  workspace, temp and build caches but no network unless your own `read_url` rules grant it; the file tools are not
+  confined (`advisory`). agy has no read-only mode, so a read-only role (the reviewer, the architect) cannot run on
+  native Antigravity: `profile validate` refuses it.
+- **Isolated** (`catherd profile set harness.antigravity.isolated true`) needs `GEMINI_API_KEY`. catherd runs agy
+  under its own HOME, with its own settings: the Gemini API as the provider, write and command deny rules for
+  read-only roles, and catherd's writable roots and the network for `workspace-write`.
+
+Whether Google's plan terms allow an orchestrator to drive `agy` on a consumer plan is not settled here. The API-key
+route is the one meant for automation; check the terms before you rely on a plan login.
+
 ## Install
 
 ```sh
@@ -153,6 +177,7 @@ Run data lives in `~/.local/share/catherd/`, config in `~/.config/catherd/` (bot
 | `ARTIFICIAL_ANALYSIS_API_KEY` | An Artificial Analysis key for `catalog sync`, instead of the one `catherd init` saves                      |
 | `CATHERD_NO_SYNC`             | `1`: no automatic sync of the public sources (at MCP server start and in `init`); `catalog sync` still runs |
 | `CURSOR_API_KEY`              | Cursor's API key: logs `cursor-agent` in, and is what an isolated Cursor role runs on                       |
+| `GEMINI_API_KEY`              | The Gemini API key an isolated Antigravity role runs on (agy reads it only with its Gemini API provider)    |
 | `CATHERD_HOME`                | Puts config and data under `$CATHERD_HOME/config` and `$CATHERD_HOME/data` instead of XDG                   |
 | `CATHERD_LOG`                 | Log level: `off`, `error`, `warn`, `info` (default) or `debug` (what `--verbose` sets)                      |
 | `CATHERD_LOCK_SLOTS`          | `catherd lock`'s slot count when `--slots` is not given (before the profile's `lock.heavy`)                 |
````

Modify `plugin/skills/catherd-setup/SKILL.md` (re-find each hunk by its context):

````diff
@@ -21,7 +21,7 @@ You tune the user's catherd profile in conversation. A profile says, per role, w
 Ask these, one at a time, each with its recommended answer:
 
 1. **Their order of speed, cost and quality.** Recommend cost first, the default `objective`: catherd climbs a rung when a cheap one cannot do the work, so the lanes that need speed get it anyway, and the reviewer and the verifier hold quality either way.
-2. **The subscriptions they hold:** a ChatGPT plan (Codex), a Claude plan, OpenCode Go, Zen credit or API keys. They set `billing` per key (`codex`, `claude`, `claude-code`, `opencode-go`, `opencode`, `cursor`): `chatgpt-plan`, `claude-plan`, `subscription` or `metered`. Recommend leaning on subscriptions before metered spend, and on Claude last among the workers, since it spends the same quota as this conversation.
+2. **The subscriptions they hold:** a ChatGPT plan (Codex), a Claude plan, OpenCode Go, Zen credit or API keys. They set `billing` per key (`codex`, `claude`, `claude-code`, `opencode-go`, `opencode`, `cursor`, `antigravity`): `chatgpt-plan`, `claude-plan`, `subscription` or `metered`. Recommend leaning on subscriptions before metered spend, and on Claude last among the workers, since it spends the same quota as this conversation.
 3. **The kind of work they orchestrate:** front-end screens, back-end services, terminal and ops work, docs. Recommend from their own runs when `runs_summary` has any.
 
 ## 2. Read the facts before proposing
@@ -59,7 +59,7 @@ Each proposal has three parts: the change, a worked example from their facts, an
 
 **Budget and timeouts.** `budget` (`minutes`, `tokens`, `usd`) is a soft cap: from 80 % routing starts at the cheapest rung that clears the bar, and at 100 % no new role starts. `timeouts.idleMin` (15) stops a role that has gone quiet, `timeouts.wallMin` (90) one that runs too long. `preflight.confirm: true` makes `preflight` show its commands for the user to approve first.
 
-**Harness isolation.** For each harness they use (`codex`, `claude-code`, `opencode`, `cursor`), offer `harness.<name>.isolated` with its harness line from `runs_summary` (Codex has none: it reports no per-request input, so say there is no figure for it instead of offering one) and this tradeoff: "native keeps your hooks, skills and AGENTS.md; isolated saves ~N tokens per run, but the role loses them." Recommend native. When they have no isolated runs yet, the number is the median first-turn input of their native runs: say that isolation would save some part of it, not all of it. When there are no runs at all, say there is no number yet, and recommend native until there is.
+**Harness isolation.** For each harness they use (`codex`, `claude-code`, `opencode`, `cursor`, `antigravity`), offer `harness.<name>.isolated` with its harness line from `runs_summary` (Codex has none: it reports no per-request input, so say there is no figure for it instead of offering one) and this tradeoff: "native keeps your hooks, skills and AGENTS.md; isolated saves ~N tokens per run, but the role loses them." Recommend native. When they have no isolated runs yet, the number is the median first-turn input of their native runs: say that isolation would save some part of it, not all of it. When there are no runs at all, say there is no number yet, and recommend native until there is.
 
 ## 4. Write it
 
@@ -70,6 +70,6 @@ Each proposal has three parts: the change, a worked example from their facts, an
 
 ## 5. Say what applies when
 
-- Codex, claude-code, opencode and Cursor changes, access and isolation included, apply at the next dispatch, even in a run already under way. Isolating Cursor needs `CURSOR_API_KEY` in the environment catherd runs in; `profile_validate` refuses it without.
+- Codex, claude-code, opencode, Cursor and Antigravity changes, access and isolation included, apply at the next dispatch, even in a run already under way. Isolating Cursor needs `CURSOR_API_KEY` in the environment catherd runs in, and isolating Antigravity `GEMINI_API_KEY`; `profile_validate` refuses either without. A read-only role (reviewer, architect, researcher) can run on Antigravity only isolated: agy has no read-only mode.
 - An agent listed in `newSessionNeededFor` applies from the next Claude Code session: Claude Code reads agent files when a session starts. Other Claude changes apply now.
 - Editing a profile that is not the active one writes its agent files but links none; they apply once it becomes active (`catherd profile use <name>`), or in a repo it is bound to (`catherd profile use <name> --repo`).
````

Modify `docs/dev/live-verification.md` (re-find each hunk by its context):

````diff
@@ -3,7 +3,7 @@
 What CI cannot check, because it needs real accounts: the backends' real streams, the Codex sandbox, and
 the Jev key prompt on a real terminal (spec D7, §11.7, §11.8); since 1.1 also the push notices, the worker
 access probes and the release acceptance runs (spec 1.1 §15, sections 7 to 9); since 1.2 its acceptance (spec 1.2
-§11, section 10); since 1.3 the Cursor adapter (spec 1.3 §10, section 11). Run it on your own machine before a
+§11, section 10); since 1.3 the Cursor adapter (spec 1.3 §10, section 11) and the Antigravity adapter (section 13). Run it on your own machine before a
 release, and again after a backend CLI's minor release. Every step says what to look for; write down
 anything that differs and file it with the step's name.
 
@@ -586,3 +586,116 @@ Look for: `ok`, and the access row naming which of the five probes pass under yo
 
 **11. Auto-update stays off during a run.** During step 5, `ls -l ~/.local/bin/cursor-agent` before and after:
 the link does not change mid-run (`--disable-auto-update` is hidden, spec 1.3 §9 Q8).
+
+## 13. Antigravity (1.3, plan 17)
+
+Spec 1.3 §6 and §10, research 2026-09-29 §8 (Antigravity). Nothing below that needs a model turn has been seen live:
+plan 17's rulings name what each step confirms. Write down every difference, with the step's number; a step that
+fails its "look for" is a ruling to revisit before the release. **Never run `agy -p` signed out**: it opens a
+browser and waits 60 s (research §4.8).
+
+**Setup.** Install agy 1.2.13 or newer (`brew install --cask antigravity-cli`), run `agy` once and sign in with
+Google. For the isolated steps also create a Gemini API key and `export GEMINI_API_KEY=<key>` in that shell only.
+
+```sh
+agy --version                          # 1.2.13 or newer
+catherd doctor --json | jq -r '.checks[] | select(.id | test("antigravity")) | "\(.id) \(.state) \(.word): \(.detail)"'
+```
+
+Look for: `backend:antigravity ok ready: 1.2.13 · Google login · <n> models` (or `warn billing` while the profile
+still bills `antigravity` as `metered`), `quota:antigravity info` with your plan's quota (Ruling on `/usage`),
+`isolation:antigravity`, and `access:antigravity skip not tested` for a profile with a workspace-write role on it.
+
+**1. The model listing (Rulings on the listing format and the effort fold).**
+
+```sh
+agy models
+catherd catalog refresh && catherd catalog list --backend antigravity
+```
+
+Look for: the listing's format (plan 17 reads each line's first word as a slug); whether slugs carry an effort
+suffix (`gemini-3.8-flash-high`) or not; and the ids of the four Gemini families in `catalog/models.json`
+`on.antigravity` (`gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.1-pro`) with their efforts
+(catherd assumes `low, medium, high` for Flash and `low, high` for Pro). Write down every difference; each fixes
+`on.antigravity` or `parseAgyModels`. Also try `agy models --output-format json`: if it now works, the parser can
+read it instead.
+
+**2. A headless run with the pointer prompt (Ruling on the prompt route and the stream).**
+
+```sh
+catherd capture-fixtures --backend antigravity --out /tmp/agy-fixtures
+ls /tmp/agy-fixtures/antigravity/*/
+```
+
+Needs `GEMINI_API_KEY` (capture runs isolated). Look for three cases captured: `ok`, `resume`, `read-only-write`.
+In `ok.jsonl`: one `init`, `step_update` events (is each payload nested under `step_update`, as the `result` line
+is?), `tool` steps with `tool_name` and `tool_info`, and exactly one `result` with `status: "SUCCESS"`, a
+`conversation_id`, and `usage`. In `ok.json`: `outcome.status` `ok`, and non-zero tokens. Check that
+`result.response` is the final message only, and whether `input_tokens` includes `cache_read_tokens`. Copy the
+three streams over `test/fixtures/adapters/antigravity/` (keeping the synthetic ones' names) and run
+`bun test test/adapters/antigravity*.test.ts`; a failure there is a parser ruling to revisit.
+
+**3. The stdin route (the prompt route's fallback).** In a scratch repo:
+
+```sh
+scratch="$(mktemp -d)" && cd "$scratch" && git init -q && git commit -q --allow-empty -m init
+printf '%s\n' '{"event":"user","message":{"content":"Reply with the word hello."}}' > in.jsonl
+agy --input-format stream-json --output-format stream-json --model gemini-3.8-flash --disable-slash-commands < in.jsonl | tail -1
+```
+
+Look for: a `SUCCESS` result that says hello. Note it either way; catherd uses the pointer prompt of step 2, and
+this route replaces it only if step 2 shows agy ignoring the brief file.
+
+**4. `--sandbox --dangerously-skip-permissions` still confines shell (Ruling on workspace-write).**
+
+```sh
+agy -p 'Run the shell command: touch /tmp/catherd-agy-outside.txt. Then run: touch inside.txt. Report each result.' \
+  --output-format stream-json --model gemini-3.8-flash --disable-slash-commands --sandbox --dangerously-skip-permissions | tail -1
+ls /tmp/catherd-agy-outside.txt inside.txt
+```
+
+Look for: `inside.txt` exists and `/tmp/catherd-agy-outside.txt` does not (then `rm` it if it does). If the outside
+write went through, the ruling fails: isolated `workspace-write` must use `toolPermission: "proceed-in-sandbox"`
+in catherd's settings, and native `workspace-write` stays advisory (spec 1.3 §6.3). Then ask for a `write_file`
+outside the repo the same way: the file tools are expected **not** to be confined (enforcement `advisory`).
+
+**5. The isolated deny rules hold headless (Ruling on the settings file and read-only).**
+
+```sh
+CATHERD_LIVE=1 bun test test/live/antigravity.live.test.ts
+cat ~/.local/share/catherd/agy-home/read-only/.gemini/antigravity-cli/settings.json
+```
+
+Look for: both tests pass (the isolated one only with `GEMINI_API_KEY`): the read-only role wrote no `out.txt`. The
+settings hold `modelProvider: "gemini"` and `permissions.deny: ["write_file(*)", "command(*)"]`; if agy ignores
+that shape, find the documented one and correct `agySettings`. Note where `denied_actions` appear in the stream.
+
+**6. Resume keeps the conversation (Ruling on `sameAccessOnly`).** Step 5's first test resumes the conversation it
+started and the reply names `out.txt`. By hand, resume one of step 2's conversation ids with a changed `--sandbox`
+(add or drop it): if agy takes the new flags, `resume.sameAccessOnly` can become `false`.
+
+**7. The Keychain login under another HOME (Ruling on isolation keys).**
+
+```sh
+HOME="$(mktemp -d)" agy models
+```
+
+Look for: `Please sign in` (the login does not follow a moved HOME, so isolation needs the key, spec 1.3 §9 Q6).
+If it lists models instead, note it: isolation could then run on the Google login.
+
+**8. A quota stop and `/usage` (Rulings on the limit texts and doctor's quota).**
+
+```sh
+agy -p "/usage" --output-format json
+```
+
+Look for: an answer with no agent turn (no `step_update`; nothing spent in the quota it prints). If a quota stop can
+be hit (a small Gemini API spend cap), save its stderr: the `AGY_ERROR:` line's fields, and check that
+`catherd runs show <id>` records the role as `limit`.
+
+**9. Plan terms (spec 1.3 §9 Q7).** On a network that reaches antigravity.google, read the Antigravity terms for
+whether an orchestrator may drive `agy` on a consumer plan, and record the answer here. Until then the README
+points automation at the API-key route.
+
+**10. Auto-update stays off during a run.** During step 5, `agy --version` before and after is the same, with
+`AGY_CLI_DISABLE_AUTO_UPDATE=true` in the worker's env (spec 1.3 §3.3).
````

- [ ] **Step 2: Run the tests and the checks**

Run: `bun run format:check` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/dev/live-verification.md plugin/skills/catherd-setup/SKILL.md
git commit -m "docs(antigravity): readme, the setup skill and live verification section 13" -m "Spec 1.3 §8, §9 Q7, §10." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 9: The 1.3.0 changeset and "From 1.2 to 1.3" (spec 1.3 §2; Ruling 23)

Plan 17 merges last of plans 15–17, so it carries the one `minor` changeset that makes the three one 1.3.0 release, and `MIGRATION.md`'s note (nothing to migrate). **Before committing on the merged head, reconcile the Grok bullets with plan 16 as it merged** (its access modes, isolation key, failover pair); the text here was written without plan 16's code.

**Files:**

- Create: `.changeset/catherd-1-3.md`
- Modify: `MIGRATION.md`

**Interfaces:**
- Consumes: nothing new.

- [ ] **Step 1: Implement**

Create `.changeset/catherd-1-3.md`:

````markdown
---
"catherd-cli": minor
---

catherd 1.3: three new worker backends, Cursor, Grok Build and Antigravity, each off until a profile puts a rung on it. Nothing to migrate: upgrade, run `catherd doctor`, and start a new Claude Code session (see MIGRATION.md, "From 1.2 to 1.3").

- **Cursor (`cursor:`).** `cursor-agent` 2026.09.28 or newer, briefs on stdin, the effort as the slug's suffix (`cursor:gpt-6-sol#xhigh`). `workspace-write` runs in Cursor's sandbox without `--force`; doctor runs the five access probes through its sandbox runner. Isolated runs need `CURSOR_API_KEY` and get their own `sandbox.json`.
- **Grok Build (`grok:`).** xAI's `grok` CLI on a Grok login or `XAI_API_KEY`; see the README's Grok section for its access modes and isolation.
- **Antigravity (`antigravity:`).** Google's `agy` 1.2.13 or newer, on a Google login (plan quota) or `GEMINI_API_KEY` (the Gemini API project). catherd never runs `agy -p` while agy is signed out, since it would open a browser. agy has no read-only mode: a read-only role runs on it only isolated, where catherd's own settings deny writes and commands; `profile validate` refuses it natively. Doctor shows the plan quota left (`quota:antigravity`).
- **Generic groundwork.** Admission refuses to resume a thread under another access on a backend that keeps a thread's access. A CLI the OS cannot execute is "installed but cannot run", with the reinstall command. A logged-out backend never reaches a dispatch. An isolated backend that needs an API key does not validate without it, and the dashboard's harness row says so. Doctor's access row says "not tested" where a backend has no sandbox runner.
- **Catalog.** Grok 4.7, 4.6 and 4.5, Composer 2.5, and Gemini 3.8, 3.7 and 3.6 Flash and 3.1 Pro join the families, so the public sources score them; a model a backend runs with no effort is scored at `#default`. Gemini fails over between Antigravity and Cursor (and Grok between Grok Build and Cursor) when neither the profile nor the backend names another stand-in; the new backends never stand in for the shipped ones.
````

Modify `MIGRATION.md` (re-find each hunk by its context):

````diff
@@ -1,9 +1,34 @@
 # Upgrading catherd
 
+- [From 1.2 to 1.3](#from-12-to-13)
 - [From 1.1 to 1.2](#from-11-to-12)
 - [From 1.0 to 1.1](#from-10-to-11)
 - [From 0.x to 1.0](#from-0x-to-10)
 
+## From 1.2 to 1.3
+
+1.3 reads 1.2's profiles, runs, credentials and catalog as they are; nothing is moved or converted, and `init` asks
+nothing new. Upgrade the same way as to 1.2, then start a new Claude Code session:
+
+```sh
+bun add -g catherd-cli@latest && catherd doctor
+claude plugin marketplace update catherd && claude plugin update catherd@catherd
+```
+
+- Three backends join: Cursor (`cursor:`), Grok Build (`grok:`) and Antigravity (`antigravity:`). Each is off until a
+  profile puts a rung on it; the default profile is unchanged. The README's backend sections say how each logs in,
+  what each access mode runs, and what isolation needs.
+- `catherd doctor` shows a `backend:` row for each, missing or not, and for a backend a profile uses, its
+  `isolation:` and `access:` rows. `quota:antigravity` shows a signed-in agy's plan quota.
+- Isolating Cursor, Grok or Antigravity needs its API key (`CURSOR_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`) in the
+  environment catherd runs in: a profile that isolates one without it no longer validates.
+- A read-only role (architect, reviewer, researcher by default) cannot run on native Antigravity, which has no
+  read-only mode: isolate it, or put the role on another backend.
+- A thread resumed under another access than it started with is refused on a backend that keeps a thread's access
+  (Grok, Antigravity), with the fix "dispatch a fresh thread".
+- After the next sync, Gemini, Grok and Composer rungs have scores of their own. Gemini rungs fail over between
+  Antigravity and Cursor on a usage limit unless your profile names another stand-in.
+
 ## From 1.1 to 1.2
 
 1.2 reads 1.1's profiles, runs, credentials and catalog override as they are. Upgrade the same way as to 1.1, then
````

- [ ] **Step 2: Run the tests and the checks**

Run: `bun run format:check` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 3: Commit**

```bash
git add .changeset/catherd-1-3.md MIGRATION.md
git commit -m "docs: catherd 1.3 changeset and upgrading from 1.2" -m "Spec 1.3 §2: the one minor changeset for 1.3.0, carried by the last of plans 15-17 to merge." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

