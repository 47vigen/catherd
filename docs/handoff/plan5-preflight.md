# Pre-flight scan — plan 5 (profiles, CLI, doctor) against plan 4 as implemented

Scanned: HEAD `f6f3f89` (plan 4 + fix rounds) and the in-flight final-review fix wave in
`.claude/worktrees/agent-ab92f942737b9f809` (`c3105fa 03f9000 417a91c c4d3742 0e58b65` on top of `f6f3f89`).
Every "replace X with Y" anchor in the 14 briefs was checked against the current file; unless listed
below, the anchor text exists verbatim and the consumed signature matches (ports.ts `ProfilePort`/`RoutingPort`,
`catalog: (filter) => catalogQuery(filter)`, `catalogQuery(f, billing = {})`, the five `agentFor(...)` call sites
with `run` in scope, `lock.ts`'s `v0Profiles().forRepo(null).heavy`, `server.ts`'s imports and `defaultDeps`,
`ids.ts` `parseRung`, the `scores.json` treat-like block, `setNext`, the codex `sh(...)`, `failoverFor?` in
`backend.ts`, the sim's `if (args[0] !== "exec")`, `JevResponse` fields used by Task 7's log row, the 20 MCP
tools Task 13 counts, `RunSummary` fields Task 10 prints, `formatRefreshed`, `tui/commands.ts` exports).
Probed on the shipped catalog: the default profile's worker ladder clears every bar (no warning), each
single-rung role has exactly one candidate, Claude rungs score only `terminal` and clear no bar.

## (a) Plan-5 code vs the current branch

| # | Where | Conflict | Severity |
|---|---|---|---|
| A1 | T5 (`ports.ts`, `routing-service.ts`, `lane-service.ts`, `test/services/helpers.ts`) | Carry-over: `finding`/`sameDefect` ask Jev even when the repo's profile has `jev.use: "off"`. No brief touches it; `RoutingPort.finding/sameDefect` take no profile, `lane-service.ask` has `run` in scope. Spec §5.5 "`off`" = no Jev. | Important |
| A2 | T12 `test/services/doctor.test.ts` `machine()`, T12 `doctor-command.test.ts`, T13 `setup.test.ts` and `init-command.test.ts` (spawn env spreads `process.env`) | `refreshDiscovery` lists `claude-code` through Anthropic's Models API whenever `ANTHROPIC_API_KEY` is set (plan-4 T6); `PATH=/nonexistent` does not stop it. None of these tests deletes/blanks the key → live network with the owner's key, and `doctor`'s claude-code row detail depends on the account. Violates the "no network" constraint. | Important |
| A3 | T13 `init-command.ts` `jevStep` | `saveJevKey` now throws on a newer-schema or unparsable `credentials.json` (plan-4 fix `62e22f1`) while `jevKey()` returns null for it, so init prompts, then aborts with exit 1 before writing the profile or printing the report (Ruling 11 says init always finishes, exit 0). The fix wave made the TUI init catch it (`c4d3742`); the CLI init does not. | Important |
| A4 | T8 runner vs plan-4 `src/entry/catalog-command.ts` `fail()` | `catalog` catches its own `CatherdError`s and sets exit 1, so `catherd catalog treat-like foo …` (the fix wave's new `E_INPUT_INVALID` from `canonicalOf`) exits 1, not 2 (Ruling 14, §8 usage). The fix wave's new test pins exit 1. It also prints a multi-line message (no ANSI strip / newline join). | Minor |
| A5 | T5 replaces `src/entry/mcp/setup-tools.ts` | Drops plan-4's `catalog_query` wording "`enabled: false` rungs are unscored" (plan-4 preflight C3); keeps the `listed` meaning. | Minor |
| A6 | Fix wave vs T5/T6 files | Fix wave edits files plan 5 edits: `test/integration/mcp-stdio.test.ts` (T5: other hunks), `src/tui/init.tsx` (T6: import line only), `test/tui/matrix.test.tsx` (T6 re-seeds `Harness`; the new "failed treat-like save" test navigates rows with the Harness), `src/services/routing-service.ts` (T5 catalog line; A1 edits the verdict lines now using `VERDICT_OPTIONS`), `src/domain/jev.ts`. Textually disjoint, but plan 5 was never replayed on them. | Minor (ordering) |
| A7 | T1 `catalog/scores.json` shipped treat-like `opencode-go/kimi-k3#max` | Fix wave `c3105fa` validates *saved* treat-likes only (canonical shape, rung unscored); the shipped key passes both. No conflict, recorded so T1's reviewer need not re-check. | None |

## (b) Per-task and task-pair rows

| # | Tasks | Shared file / interface | Finding |
|---|---|---|---|
| B1 | 9, 10, 12 (wave 5), 13 (wave 6) | `src/cli.ts` `subCommands` | Each adds lines; T10 also replaces `watch`, T13 replaces `init`. Plan says keep every line; merge in wave order 9→10→12, then 13. |
| B2 | 10 → 13 | `src/tui/commands.ts` | T10 deletes `watchCommand`/`Watch`; T13 replaces the file (no `watch`, keeps `isBare`, `mount`, `editorRun` that `test/tui/commands.test.ts` imports). Consistent. |
| B3 | 7 → 5 | `src/entry/mcp/server.ts` | T7 adds imports + `logToolCalls`; T5 deletes `v0Profiles`/`VERSION` imports and `defaultDeps`. Disjoint hunks; T5's anchors survive T7. |
| B4 | 7 → 8 | `test/infra/launch.test.ts` | Sequential waves (1, 2). OK. |
| B5 | 4 → 5 | `src/services/profile-service.ts` | T5 appends `viewOf`/`profileService` and two imports. `Saved` (T4) ≡ `ProfileSaved` (T5) member-for-member. OK. |
| B6 | 5 → 11 | `src/entry/lock.ts` | T5 swaps the bridge for `profileFor`; T11 replaces the file. OK. |
| B7 | 1, 5 | `ProfilePatch` | T5 re-exports T1's zod type from `ports.ts` (services → domain, allowed). OK. |
| B8 | 2 (+ carry-over) | Default profile vs bars | Carry-over satisfied: T1 places Claude only as architect/verifier single rungs. But nothing warns when a user puts a Claude rung on a multi-rung ladder, where it can start only as `defaultRung` and is never climbed onto. |
| B9 | 12 → 13 | `doctor`, `formatReport`, `mcpHandshake` | T13's expected row text (`✓ ready              MCP server — answers tools/list with 20 tools`) depends on T12's `formatCheck` padding; 20 tools matches today's count. OK. |
| B10 | 6 + fix wave | `test/tui/matrix.test.tsx`, `test/tui/init.test.tsx` | T6's Step 4 runs `test/tui`; it must also keep the fix wave's two new tests green (see A6). |
| B11 | 3 → 6 | `role-prompts` | T3 copies to `src/domain`; `src/profile/role-prompts.ts` stays until T6 deletes it; no other importer. OK. |
| B12 | 5 | `microdiff` | Only `src/bridge/v0.ts` imports it; `package.json:31`, `docs/dependencies.md:24` present. OK. |

## (c) Same-wave file collisions — {1,7} → {2,3,8} → {4} → {5} → {6,9,10,11,12} → {13,14}

| Wave | Collision |
|---|---|
| {1,7} | none |
| {2,3,8} | none |
| {4} | — |
| {5} | — |
| {6,9,10,11,12} | `src/cli.ts` (9, 10, 12) only — additive lines (B1). No other shared file: 6 = tui/core/profile tests; 9 = profile-command; 10 = runs-command, run-debug, tui/commands; 11 = lock; 12 = doctor, handshake, backend.ts, codex adapter, sim. |
| {13,14} | none (13: setup, prompt, init-command, cli.ts, tui/commands; 14: skills, run-service, run-tools, README, 3 tests). |

## (d) Spec contradictions

| # | Spec | Plan | Note |
|---|---|---|---|
| D1 | §7.1 "stand-in … on the same **backend**" | Ruling 3: same **quota** (billing key; `claude` ≡ `claude-code`; Go ≠ Zen) | Plan is right; spec text lags. |
| D2 | §7.1 example `"failover": {}` | §7.2 / Ruling 4: default carries four Go stand-ins; a missing `failover` resolves to `{}` | Reconciled by Ruling 4; example reads as "no failover". |
| D3 | §7.2 "best-matching Go model **by treat-like**" | Luna → Go's own `gpt-6-luna` (family scores, all `inferred`), Sol → Kimi K3 via treat-like | Ruling 2 marks both inferred; OK. |
| D4 | §5.5 `jev.use: "off"` disables Jev | Plan honours it only in `route` (plan 4) | = A1. |
| D5 | §10.2 redactor removes `*_KEY`/`*_TOKEN` values "everywhere" | Ruling 13: only values ≥ 8 chars (plus `_SECRET`/`_PASSWORD`) | Short values stay; defensible, spec silent. |
| D6 | §8 usage errors exit 2 | plan-4 `catalog` exits 1 on `E_INPUT_INVALID` | = A4. |
| D7 | D2 "`init` rebuilds everything" | Ruling 11: `--no-input` keeps an existing 1.0 profile | Only 0.x files are moved; spec wording broader. |
| D8 | §3.5 data layout | adds `<config>/profiles.lock`, `<config>/0.x-backup-<stamp>/` | Doc drift. |
| D9 | §9.1 `init` is a TUI screen | Ruling 10/11: plain-prompt init now, TUI wizard in plan 6 | Deferral, stated in plan. |

## Proposed rulings

- Ruling: Task 5 makes `finding` and `sameDefect` honour the repo profile's `jev.use` — `lane-service.ask` passes `deps.profiles.forRepo(run.meta.repo).jev.use` to the routing port (new last parameter `use: "auto" | "off"`), and `routing-service`'s `verdict` returns `judgeVerdict(rule, set, VERDICT_OPTIONS[set], null)` without calling `askJev` or writing a jev.jsonl row when it is `"off"`; the `fakeDeps` fakes take the extra argument; add a routing-service test "never asks Jev for finding or same-defect with jev.use off" (a fake fetch that fails the test if called) — spec §5.5 `off` means no Jev, and the plan-4 ledger carried this to plan 5 — cost if wrong: every `ask` of a user who turned Jev off still sends lane text to TypeSafe.
- Ruling: Tasks 12 and 13 delete `ANTHROPIC_API_KEY` in every test that reaches `refreshDiscovery` (`machine()` in doctor.test.ts, doctor-command.test.ts, both setup.test.ts cases) and blank it (`ANTHROPIC_API_KEY: ""`) in the env of every spawned `catherd` (init-command.test.ts `init()`, doctor-command spawns) — plan-4 T6 made the claude-code listing an HTTP call whenever the key is set, and plan 5 was replayed on a machine without one — cost if wrong: on the owner's machine these tests call api.anthropic.com with the real key and can time out or change the claude-code row.
- Ruling: Task 13's `jevStep` wraps `saveJevKey` in try/catch and prints `! Jev: could not save the key: <message>` with its fix, then continues to the profile, the report and the plugin steps (exit 0), mirroring the fix wave's TUI change `c4d3742`; add one init-command case with an unparsable `credentials.json` — Ruling 11 says init always finishes — cost if wrong: a corrupt credentials file makes `catherd init` stop before writing the default profile.
- Ruling: Task 8 changes plan-4 `catalog-command.ts` `fail()` to `printError(e); process.exitCode = exitCodeOf(e);` (cli-kit), and the fix wave's "malformed rung" test expects exit 2 — Ruling 14 / §8: `E_INPUT_INVALID` is a usage error in every command — cost if wrong: one command answers bad input with exit 1 and a multi-line error, which scripts cannot tell from a failure.
- Ruling: Task 5's new `catalog_query` description keeps "`enabled: false` rungs are unscored" after the `listed` clause — plan-4 preflight C3 put it there for the setup skill — cost if wrong: documentation only; the skill may offer an unscored rung and get a validate error.
- Ruling: plan 5 starts only after the fix wave (`c3105fa..0e58b65`) is cherry-picked onto the branch, and Task 6's reviewer runs `test/tui/matrix.test.tsx` and `test/tui/init.test.tsx` including the two fix-wave tests; Task 5's implementer rebases its `routing-service.ts` edits onto `VERDICT_OPTIONS` — plan 5 was never replayed against those five commits and three of its tasks edit the same files — cost if wrong: a cherry-pick conflict or a red fix-wave test inside a plan-5 wave.
- Ruling: Task 2 adds one warning: for an enabled role with more than one candidate, each Claude (`claude:`/`claude-code:`) candidate that clears no bar gets "`<rung>` clears no routing bar (no honesty score), so a lane starts on it only as the role's default rung and never climbs onto it" — the plan-4 ledger's carry-over (Claude rungs never clear shipped bars); single-rung roles are exempt, so the default profile still validates clean — cost if wrong: a user who adds Claude to the worker ladder silently never gets it; skipping it costs nothing today.
- Ruling: file one spec edit with Task 14 (docs task): §7.1 "on the same backend" → "on the same quota (billing key; native `claude` and `claude-code` share the Claude plan)", §3.5 lists `profiles.lock` and `0.x-backup-<stamp>/`, and §5.5 says `off` also skips `finding`/`same-defect` — D1, D4, D8 — cost if wrong: documentation drift only.
