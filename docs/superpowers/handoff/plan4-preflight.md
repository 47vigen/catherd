# Pre-flight: plan 4 (catalog and routing)

Read-only scan of `docs/superpowers/plans/2026-09-25-04-catalog-routing.md` against the spec (§5, §3.5, §4.1, §8, §11.1) and the tree at `dd730d2`. The briefs match the plan line for line; `task-11-brief.md` also carries the plan's closing "Self-review" and "After this plan" sections, which does no harm. Wave 1 (Tasks 1, 4, 5, 6) is already merged on this branch.

**Result: no same-wave file overlap. 8 conflicts: 3 medium, 5 low.** None of them breaks the replay, because the replay machine had no `ANTHROPIC_API_KEY` and nothing exercised the 0.x TUI writer.

## Pairs that share a file or an interface

| Tasks | Produced → consumed | Finding |
|---|---|---|
| 1 → 2 | `Family` (`price`, `planWeight`, `meteredOnPlan`), `BillingKey`, `shippedModels()` | OK |
| 1 → 3 | `Catalog`, `rungInfo`, `scoresOf`, `capableFor`, `effortOffered`, `Dim`, `shipped()` | OK |
| 1 → 7 | `buildCatalog`, the three schemas, `rungInfo`, `scoresOf`, `capableFor`, `DIMS`, `assetPath` | OK. The service exports its own `shippedModels`/`shippedScores` under the same names as the test helpers in `test/domain/shipped.ts`: two loaders for the same files (low, accept) |
| 1 → 8 | `assetPath` | OK |
| 1 → 3/7/9 | `Catalog.listed`, keyed by backend id | **Conflict (low, C6).** `rungInfo` reads the native `claude` backend's listing from `claude-code`, but `capableFor` looks up `c.listed[info.parsed.backend]` directly, so an unknown model on `claude:` never finds its `imageIn` |
| 1 ↔ 11 | Both write `<config>/catalog.override.json`: the 1.0 `OverrideSchema` (Task 1) and the 0.x loader and writer (Task 11 replaces the whole file) | **Conflict (medium, C2).** Task 11 keeps the 0.x `saveTreatLike` with a strict `z.object` schema, and the TUI still calls it (`src/tui/matrix.tsx:287`). It strips `schema` and the 1.0 `scores[]`, writes without the file lock, and does not write atomically. That breaks the Global Constraint ("unknown fields preserved", "changed only under its file lock"). Review Focus 5 says Task 7 pins "the reverse", but Task 7 only tests that the 1.0 writer keeps 0.x fields. The 0.x writer dropping 1.0 fields is unpinned |
| 2 → 3 | `Cost`, `costOf`, `compareCost`, `DEFAULT_BILLING`, `BillingMode` | OK. `byNull` in `select.ts` repeats `compareCost`'s null-last expression (low, accept) |
| 2 → 7 | `costOf`, `DEFAULT_BILLING`, `BillingMode` | OK |
| 2 → 9 | `BillingMode` in `ProfileView.billing` | OK |
| 3 → 9 | `candidates`, `defaultLadder`, `select`, `RoutingProfile`, `Pick`, and `E_CONFIG_INVALID` on an empty role | OK |
| 4 → 5 | Task 4 creates `rate-limited.json` and `validation-error.json` "for" the transport | **Conflict (low, C7).** No task's test reads either fixture: Task 5 inlines its reply bodies |
| 4 → 8 | `JevFileSchema`, `questionSetId`, `requestKey`, `canonicalJson`, `sha256`, `parseReply`, `SetName`, `JevAnswers`; 0.x fixture `route-confident.json` | OK. `route-confident` fails on `difficulty`, as the test expects |
| 4 → 9 | `laneState`, `scrubSecrets`, `judgeRoute`, `judgeVerdict`, `Verdict` (with `probability`); `finding-*` fixtures | OK |
| 4 → 11 | `judgeRoute`, `laneState` in the live test; 0.x fixtures | Part of C7: after Task 11 deletes `test/jev.test.ts` and `test/route.test.ts`, nothing reads `route-unsure.json` or `same-defect-no.json` |
| 5 → 6 (wave 1) | `test/fake-fetch.ts`: Task 5 replaces the whole file, Task 6 uses the old `{status, body}` replies and `Sent.headers` | OK. The new file is a superset |
| 5 → 8 | `jevRequest`, `JevTransport`, `fakeFetch` reply `headers` | OK |
| 5 → 9 | the `"hang"` reply, `attemptMs`, `deadlineMs` | **Conflict (low, C5).** The test "falls back … once the deadline passes" uses a 2 s deadline, 20 ms attempts and a no-op sleep. It ends on retry exhaustion (`why: "timeout"`, 3 attempts), never on the deadline. Review Focus 1 still cites it as the deadline pin. `route` also runs `freshenDiscovery` before Jev, and that is outside the 25 s budget, so "route never blocks past 25 s" is pinned only at the transport level (Task 5) |
| 6 → 7 | `claudeCodeAdapter.listModels` now calls `https://api.anthropic.com/v1/models` whenever `ANTHROPIC_API_KEY` is set | **Conflict (medium, C1).** The Task 7 test "lists again on route at most daily…" freshens `claude:claude-opus-5-5#high` through the real adapter and never clears the key. On a machine with the key it makes a real request (15 s timeout per page, above bun's 5 s test timeout), which breaks "no network" |
| 6 → 9 | the same | **C1 again.** The Task 9 test "routes a role's Claude rung on that role's backend" freshens claude rungs. Its `beforeEach` clears `TYPESAFE_API_KEY` and `PATH` but not `ANTHROPIC_API_KEY` |
| 6 → 11 | the same | OK. The Task 11 CLI test sets `ANTHROPIC_API_KEY: ""`, so the author knew about the risk |
| 7 → 9 | `loadCatalog`, `freshenDiscovery`, `catalogQuery`, `resetFreshen`; `CatalogFilter`, imported from `ports.ts`, which Task 9 replaces whole | OK: `CatalogFilter` is kept unchanged |
| 7/9 ↔ MCP and skills | `routing.catalog` now returns `CatalogModel` (`listed`, `rungs[].enabled`), not the bridge's `{installed, scored, treatLike}` | **Conflict (medium, C3).** The `catalog_query` description in `src/entry/mcp/setup-tools.ts` still promises "whether catherd can run their backend here". `plugin/skills/catherd-setup/SKILL.md:31` says "A model whose `installed` is false is not offered". That field no longer exists (it is now `undefined`, never `false`), so the setup skill offers every model. No task touches either file |
| 7 → 10 | Task 7's test writes a `RouteRow` literal with no `questionSet`, `jev` or `env`; Task 10 replaces `route.ts` whole | OK: all three are optional |
| 7 → 11 | `refreshDiscovery`, `catalogQuery`, `saveTreatLike`, `Refreshed`, `CatalogModel`, `overridePath` | OK. `overridePath` is defined twice (catalog service and 0.x `routing/catalog.ts`), and both resolve to the same path today |
| 8 → 9 | `askJev`, `logJev`, `jevQuestions`, `JevOpts`, `Asked`, `JevRow` | OK |
| 8 → 11 | `jevKey`, `saveJevKey`, `testJevKey` re-exported for the 0.x `src/tui/init.tsx` and `dashboard.tsx` | OK: the signatures match what the TUI calls (`testJevKey(key) → Promise<boolean>`) |
| 9 → 10 | `route.ts` (Task 9 edits it, Task 10 replaces it whole and keeps `RouteJev`, `questionSet?` and `jev?`); `lane-service.ts` (Task 10's import replacement is a superset of Task 9's); the `RouteAnswer` fields in the `test/services/helpers.ts` fakes | OK |
| 9 → 11 | The bridge imports `loadCatalog` and `modelOf` from `routing/catalog.ts` (Task 11 replaces the file and keeps both) and `candidates` from `routing/select.ts` (kept). `v0Routing` is gone before Task 11 deletes `routing/route.ts` | OK |

## Same-wave pairs

| Wave | Pair | Finding |
|---|---|---|
| 1 | 1, 4, 5, 6 | Disjoint. Task 5 rewrites `test/fake-fetch.ts`, which Task 6 only reads, and the new API is a superset |
| 2 | 2, 8 | Disjoint |
| 3 | 3, 7 | Disjoint: both only create files |
| 5 | 10, 11 | Disjoint. Task 10 has `route.ts`, `run-store.ts`, `lane-service.ts`, `lane-tools.ts` and `plugin/skills/catherd/SKILL.md`; Task 11 has `cli.ts`, `src/routing/*`, `catalog-command.ts`, `package.json`, `bun.lock`, `README.md`, `docs/dependencies.md`, `tui/watch-model.ts` and its deletions |

## Each task against itself

| Task | Finding |
|---|---|
| 1 | Tests match the code, and the files it creates are the files it touches. C6: `capableFor` and `rungInfo` disagree on which listing the native `claude` backend reads |
| 2 | OK. `CHATGPT_UNIT_USD = 0.019` is hard-coded, but a test ties it to `taskUsd(luna, medium)` |
| 3 | OK. I checked all 20 pin cases and the speed-ladder cases by hand against the shipped scores and bars |
| 4 | OK apart from C7: it creates two fixtures that nothing reads |
| 5 | OK |
| 6 | OK. The one env-mutating edit in `claude-code.test.ts` sits in a file that already has `afterEach(snapshotEnv())`. C1 is on the consumer side (Tasks 7 and 9) |
| 7 | C1: the freshen test can reach the network |
| 8 | **Conflict (low, C4).** The test "writes jev.jsonl with a header row, and never the state" logs a row that was never given the state, then asserts `not.toContain("Rename total")`. The header assertion is real; the "never the state" assertion cannot fail |
| 9 | C5: the hang test's name and Review Focus 1 overclaim. C3: `catalog_query`'s description and the setup skill are left stale |
| 10 | OK. `laneOutcome`, the `land`/`climb` hooks and the tests agree; `startsWith("M1.")` does not catch `M10.*` |
| 11 | OK against itself. It keeps the 0.x `saveTreatLike` (C2) and leaves orphaned fixtures behind (C7) |

## The plan against the spec

| Where | Finding |
|---|---|
| §4.1 vs §5.4/§5.6 | **Conflict (low, doc, C8).** Spec §4.1 says `routes.jsonl` holds "route + climb decisions and lane outcomes" and does not list `outcomes.jsonl`. §5.6 and the plan use a separate `outcomes.jsonl`. The plan follows §5.6 but never amends §4.1 |
| §5.5 "Counts and facts … computed in code" | Not covered: no task computes the owned-file count, whether there is a fast check, or the extensions, and nothing logs them for calibration. Low; can be deferred to `jev eval` (1.x) |
| §5.2 "DeepSWE v1.1 / SWE-bench Pro", §5.3 fast mode | Ruling 3 (DeepSWE only) and Ruling 1 (no fast-mode factor) deviate on purpose, with reasons. OK |
| §5.2 approved ladder, §11.1 | Pinned per kind and difficulty (terminal work is always Track B), exactly as 0.x `test/select.test.ts` did. OK |
| §8 exit codes and `--json` | `list` and `refresh` take `--json`; a bad `--role` exits 2; errors print `error E_CODE` then `fix:`. OK |
| Code a reviewer would call a defect | C4 (an assertion that cannot fail). Duplicate logic, judged acceptable: `src/infra/assets.ts` repeats 0.x `src/files.ts` `assetPath` (the layer rule forbids the import); the `claude → claude-code` listing key is mapped in three places (`rungInfo`, `freshenDiscovery`, `modelKeyOf`); `loadCatalog()` in `route` rescans every run of every repo for timings on each route (performance, low) |

## Proposed rulings

- Ruling: In Task 7's catalog-service test and Task 9's routing-service test, have `beforeEach` delete `ANTHROPIC_API_KEY`, as Task 11's CLI test already blanks it — Task 6 made the claude-code listing an HTTP call whenever that variable is set, and both tests freshen claude rungs through the real adapter — cost if wrong: on the owner's machine these tests call api.anthropic.com with the real key and can fail on bun's 5 s timeout.
- Ruling: In Task 11's replacement of `src/routing/catalog.ts`, make the 0.x `OverrideSchema` a `z.looseObject` and have its `saveTreatLike` write through `writeJsonAtomic` inside `withFileLock` (0.x may import infra: Task 11 already has `routing/jev.ts` import from services), and add a `test/catalog.test.ts` case that keeps a 1.0 `scores[]` — the TUI matrix still saves treat-likes through this writer until plan 6 — cost if wrong: a treat-like saved in the TUI silently deletes the user's 1.0 score overrides and races `catherd catalog treat-like`.
- Ruling: Task 9 updates the `catalog_query` description in `src/entry/mcp/setup-tools.ts` and `plugin/skills/catherd-setup/SKILL.md:31` from `installed` to `listed` ("`listed: false`: this account's backend does not offer it"; "`enabled: false` rungs are unscored") — the routing port's catalog answer changes shape in Task 9, and neither file belongs to any task — cost if wrong: the setup skill reads a field that no longer exists, so it offers models whose backend the account cannot run.
- Ruling: In Task 8, either drop "and never the state" from the test name, or build the logged row from a real `askJev(dir, "route-v2", STATE, …)` result and then assert that the file lacks the state's text — the current assertion cannot fail, and Task 9 already pins the log end to end — cost if wrong: a reviewer flags a hollow test and asks for a fix round.
- Ruling: In Task 9, rename the hang test to "falls back to the lane's declaration when every attempt times out". Change Review Focus 1 to cite Task 5's "stops early rather than sleep past the deadline" as the deadline pin, and to say that the discovery refresh before Jev has its own hour-long backoff (Focus 3) and is outside the 25 s budget — the test never reaches the deadline — cost if wrong: a reviewer checking Focus 1 finds the claim unproven and asks for a fake-clock rewrite of a test that already passes.
- Ruling: Fix `capableFor` to read the same listing key as `rungInfo` (`claude` → `claude-code`). Wave 1 is merged, so fold the one-line change into Task 3 or Task 7 — the two functions disagree about the native backend's listing — cost if wrong: a claude-code-listed model with no shipped family loses its image input on `claude:` rungs, so ui-reviewer refuses it; the effect is small today.
- Ruling: Task 11 also deletes `test/fixtures/jev/route-unsure.json`, `same-defect-no.json`, `rate-limited.json` and `validation-error.json`, or Task 5's test is changed to read the last two — after this plan, nothing reads them — cost if wrong: four dead fixtures, a review nit only.
- Ruling: Task 10 adds `outcomes.jsonl` to spec §4.1's run-folder listing and removes "and lane outcomes" from the `routes.jsonl` line; §5.5's "counts and facts computed in code" is accepted as deferred to `jev eval` (1.x), and the spec says so — the spec contradicts itself on where outcomes live — cost if wrong: documentation drift only.
