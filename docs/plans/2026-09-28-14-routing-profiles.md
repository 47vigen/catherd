# catherd 1.2, plan 14: routing and profiles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A lane's kind changes which rung it gets, and no profile ever becomes invalid because a rung lacks a score: default bars span several dimensions per kind and difficulty, at percentiles of the day's data; `catalog/scores.json` ships the keyless sources' values, refreshed weekly; a rung without a value takes its nearest stand-in's as `inferred` (a warning, "stand-in to confirm"); a save may repair a profile; `treat-like --suggest|--clear|--reset`; `route`, `catalog_query`, `catalog list`, doctor and the dashboard say where every value came from and what catherd's own runs showed; the 1.2.0 changeset and docs.

**Architecture:** `src/domain/bars.ts` holds the §5.1 table and the §5.2 percentile derivation; `src/services/catalog-refresh.ts` rebuilds `catalog/scores.json` from the keyless sources' cached answers (plan 13's `derive`), spreads published values to other efforts as `adjacent`, derives the bars with their `barsWhy`, and reports what moved; `scripts/catalog-refresh.ts` runs it (the weekly workflow and a release). `src/services/standins.ts` ranks stand-ins (z-scored distance over shared features) and fills `Catalog.inferred`, which `scoresOf` reads after a rung's own values and its treat-like; `loadCatalog` serves it. `src/domain/profile-rules.ts` turns "unscored" into warnings, lists stand-ins to confirm and holds the repair rule; `src/services/treat-likes.ts`, `run-evidence.ts` and `provenance.ts` back the CLI, MCP, doctor and TUI surfaces.

**Tech Stack:** Bun ≥ 1.4, TypeScript, zod 4, citty, `@modelcontextprotocol/sdk`, `@opentui/react`. No new dependency.

**Spec:** `docs/specs/2026-09-28-catherd-1.2-design.md` (§5, §6, §7, §8, §9 TUI/route/doctor, §10, §11), on top of the 1.1 and 1.0 specs; plan 13 (`docs/plans/2026-09-28-13-sources-sync.md`) and its "Rulings on the spec" bind where this plan is silent.

**Pre-validated on scratch `cff7d19..c3a94f2` (branch `plan14-scratch`, built on `main` at `cff7d19`, plan 13 merged with its fix wave): 1620 pass / 0 fail / 10 skip (1630 tests, 151 files, about 4.5 minutes); typecheck, lint and format:check green on every commit; `bun test/pack-smoke.ts` green on the head.** The full suite also ran green on the Task 3 (1581 pass), Task 4 (1589), Task 5 and Task 8 commits. The code below is that scratch build, commit by commit (`git show <task commit>` on `plan14-scratch` reproduces any file).

## Global Constraints

- Layers `domain → infra → adapters → services → entry` (`test/architecture.test.ts`): the bar table and derivation in `src/domain/bars.ts`, the repair rule and "stand-in to confirm" in `src/domain/profile-rules.ts`; ranking, refresh, run evidence, provenance and treat-like removal in `src/services/`.
- ProfileService (`profile-service.ts`) stays the single writer of profiles, config, bindings and agent links; `catalog.override.json` keeps its writer, `catalog-service.ts` (`saveTreatLike`, the new `removeTreatLikes`). Controller ruling C-5.
- The gate: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test`, plus `bun test/pack-smoke.ts` on the head. **No test reaches the network**: every sync in a test uses `recordedFetch` (plan 13's `test/services/source-fixtures.ts`); `test/preload.ts` keeps `CATHERD_NO_SYNC=1`.
- No wall-clock sleeps for correctness; tests that spawn processes pass an explicit `env` with `ANTHROPIC_API_KEY: ""`.
- Commits: conventional, subject ≤ 100 characters, lower-case first word after the scope; check `git log` after each commit (a failed hook leaves the changes uncommitted).
- MCP: 26 tools, unchanged (C-6).
- Spec 1.2 §5.1, verbatim table: `repo_code` copy/build `repo_code`, logic/hard `repo_code, honesty, agentic`; `terminal` copy/build `terminal`, logic/hard `terminal, honesty, agentic`; `ui` copy/build `frontend, repo_code`, logic/hard `frontend, repo_code, honesty, agentic`; `prose` and `research` copy/build `repo_code`, logic/hard `repo_code, honesty`. "`steer` ships with no default bar; it is shown and may be set in a profile."
- Spec 1.2 §5.2: "`copy`: the 25th percentile … `build`: the median. `logic`: the 60th percentile. `hard`: the 75th percentile. Percentiles are taken over rungs whose value is `measured` or better. A profile overrides any threshold through the existing `bars` path, and `null` removes it."
- Spec 1.2 §6.1–§6.4: unscored is a **warning** with an automatic inferred stand-in; "stand-in to confirm" in `profile validate` and `doctor`; "A profile save goes through when it removes at least one error and adds none, even if errors remain. The result lists the errors still open"; "z-scored Euclidean distance over the features both rungs have. A pair sharing fewer than 3 features is not suggested"; `--suggest` top 3 with distance and features; "Before a mapping is removed, catherd names the profile rungs it leaves on an inferred stand-in."
- Spec 1.2 §7: "Values that come from AA are never shipped"; `catalog/ATTRIBUTION.md` "included in the npm package"; the workflow "runs weekly (and on `workflow_dispatch`) … opens or updates a PR titled `chore(catalog): refresh scores` with a patch changeset. The PR body lists the rungs newly scored, the values that moved by more than 5 %, and every bar that moved."
- Spec 1.2 §8: counts "lanes, climbs, `partial`/`blocked`/`refused` replies and verifier FAILs … It does not change scores, bars or routing in 1.2."
- Plan scope: the 1.2.0 changeset is this plan's (one file, minor; plan 13 added none).

## Review Focus

1. **The default worker routes differently on 1.2's bars** (repo_code copy 60.95, build 66.6; terminal copy 40.15; ui build frontend 1617 + repo_code 66.6; logic/hard above every Sol rung). Expected, and pinned in `test/domain/select.test.ts` ("the approved ladder") and `test/services/routing-service.test.ts`: copy and build lanes start on Luna high (its DeepSWE carried from max as `adjacent`), `terminal` lanes on Sol medium, `ui` build on Sol xhigh (its only rung), and every logic/hard lane at the default rung, Sol medium, as in 1.1. The owner should see this list; it follows from the spec's percentiles over a frontier-heavy catalog.
2. **A lower effort carries a higher effort's value** (`adjacent`, both directions, spec §4.3): Luna high's DeepSWE is Luna max's 66.6, Opus low's terminal Opus xhigh's. Expected: routing and validation treat it as the rung's own value at the `adjacent` level; the failover ranker prefers the rung's own effort among ties (Ruling 4), pinned in `test/domain/failover.test.ts` ("prefers the effort nearest the rung's own").
3. **A 1.1 override that wrote a whole bar** (`"bars": {"ui": {"hard": {"repo_code": 70}}}`). Expected: it still parses; it now overrides only `repo_code` and the default's other thresholds stay (C-4). Pinned in `test/domain/bars.test.ts` ("still reads an override that sets a whole bar") and `test/domain/catalog.test.ts`.
4. **A weekly refresh while a source is down.** Expected: nothing is written and the job fails, so no PR drops that source's values (Ruling 11). Pinned in `test/services/catalog-refresh.test.ts` ("writes nothing when a keyless source fails").
5. **No source scores any Claude model on honesty** (Broken Search Tool is OpenAI's). Expected: every Claude rung takes a Sol rung's honesty as `inferred` and shows as a "stand-in to confirm" where bars choose (a worker ladder with Opus, a failover to Opus); never an error. Pinned in `test/domain/profile-rules.test.ts` ("warns on a stand-in that never runs…", "warns when a stand-in spends Claude quota…").

## Rulings on the spec

Controller rulings (from the brief), as decided:

- **C-1 Network:** every keyless source answered in the sandbox on 2026-09-28 (a forced keyless sync at 18:31 UTC). The shipped values and bars in Task 3 are that run's output (`bun scripts/catalog-refresh.ts`); no source needed the fixture fallback. **Do not re-run the script while executing**: the live data moves and the tests pin these values; Task 3 writes the file from the blob it gives (sha256 checked).
- **C-2 Terminal units:** terminal's anchor is the hand-typed Terminal-Bench 4.0 values (`anchor: "shipped"`, like repo_code and honesty), not Epoch's `terminalbench_external`, which is Terminal-Bench 2.0 and shares no rung with them; Epoch's table and AA's `terminalbench_v2_1` are fitted onto that anchor (5 shared rungs, R² ≥ 0.5; Epoch shares 0 today, the synthetic AA fixture 3). Plan 13's `HELD_DIMS` hold is removed: terminal is on one unit. No rung loses a terminal value it has in 1.1; the terminal bars are in TB 4.0 units, from 7 values. — Epoch covers few catalog rungs and a different benchmark version; anchoring on it would have left one rung (Haiku 4.5) to derive bars from. — Cost if wrong: Haiku 4.5 has no terminal value (its Epoch 2.0 score, a different unit, is no longer used) until Epoch covers five anchor rungs.
- **C-3 Default profile:** validates with **no errors and no warnings**, before and after a sync (pinned: `test/domain/profile-rules.test.ts` "passes the default profile…", `test/services/source-sync.test.ts` plan 13's "leave the default profile valid, with no warning…"). Two rulings make it so: Ruling 12 (the worker-miss warning names only a kind the ladder clears no bar of) and Ruling 14 (shipped treat-likes for GPT-6 Luna, whose agentic value no source publishes). Without Ruling 14 the default would show one warning: "stand-in to confirm: gpt-6-luna#high … has no agentic value of its own".
- **C-4 Override bars:** merged per dimension: a number sets that threshold, `null` removes the default's, an unnamed dimension keeps the default's. A 1.1 whole-bar override parses unchanged. — Spec §5.2 "overrides any threshold … `null` removes it". — Cost if wrong: a 1.1 override that meant to drop a dimension by omitting it now keeps it (write `null`).
- **C-5, C-6:** as in Global Constraints.

Rulings of this plan (`what — why — cost if wrong`):

1. **"Measured or better" for the bar pool** is `verified`, `measured`, and a hand-typed `secondary` value (no `source`); `calibrated`, `adjacent`, `inferred` and a synced `secondary` are left out (`measuredOrBetter` in `bars.ts`). — 1.0's `secondary` means "published for this exact rung by someone other than the vendor", which is 1.2's `measured`. — Cost if wrong: with verified values only, the repo_code copy bar would be 67.45 and no default worker rung would clear any repo_code bar.
2. **Percentiles** interpolate linearly between the closest ranks (numpy's default), kept to 4 significant digits; each dimension's threshold at a difficulty is the same in every kind whose bar spans it; a dimension with no pooled value gets no threshold and a `barsWhy` line saying so. `barsWhy` becomes a per-dimension, per-difficulty map (1.1's single string is dropped). — The spec gives percentiles, not a method. — Cost if wrong: thresholds move by a rounding step.
3. **The rebuilt `scores.json`** keeps every hand-typed value (no `source`) except an earlier rebuild's `adjacent` spreads, replaces the keyless values with the sources' current answer (never AA's), spreads every published (non-`inferred`) value to the family's other efforts as `adjacent` (plan 13 Ruling 7 left this to plan 14), and keeps one value per rung and dimension by precedence. A hand `inferred` value loses to an `adjacent` one (Luna high DeepSWE 59.3 → 66.6 from max). Rebuilding the rebuilt file changes nothing. — Spec §4.3 "the same model at another effort, from any source". — Cost if wrong: lower efforts inherit higher efforts' values until a source scores them.
4. **Failover ranking** orders, after Claude billing, by effort distance from the rung's own effort, then cost. `DEFAULT_FAILOVER` is unchanged and is still the ranker's first choice. — Adjacent values tie a model's efforts, and cost alone made Go Luna `none` the best stand-in for Luna high. — Cost if wrong: a cheaper stand-in at another effort ranks second.
5. **Plan 13's derive** anchors only on hand-typed published values (`source` absent, measured or better), never on the shipped keyless ones, and `adjacent()` is exported (its `shipped` set as plan 13's fix wave left it; the rebuild passes an empty set). — The shipped file now carries keyless values: anchoring on them would fit a source onto itself. — Cost if wrong: none known.
6. **Stand-in features** (`standins.ts`): `price` = log10(input + output), `context` = log10(the largest context), `release` (days, from the new `releaseDate` in `models.json`, models.dev's 2026-09-28 dates, and a sync's facts), `effort` (its order), `vendor` and `family` (words: 0 when equal, else 1), the rung's own values per dimension (never borrowed or inferred), and AA's `artificial_analysis_intelligence_index`, `hle`, `scicode`, `lcr`, `cost_per_task`, `median_output_tokens_per_second` as `aa.*` (from `derived.json`'s new `features`). Numbers are z-scored over every canonical rung; the distance is the root mean square over shared features (Euclidean, normalised by the count so pairs sharing different numbers compare); fewer than 3 shared → none. — The spec lists the features; effort is added because without it a family's efforts tie. — Cost if wrong: a different stand-in ranks first; the user confirms it anyway.
7. **Inferred values** are filled per dimension: for each dimension some bar uses (the defaults and the user's override) that a rung has no value for, of its own or through its treat-like, the nearest rung with its own non-`inferred` value there lends it (guesses never chain). `loadCatalog` fills `Catalog.inferred` (`withStandIns`); `scoresOf` reads own → treat-like → inferred. `steer` is never inferred. — Spec §6.1. — Cost if wrong: routing places a rung on a guessed value; it is marked everywhere.
8. **A rung no rung is near enough to** (a listed model with no family: only its effort is known) stays unscored: a warning, and routing skips it. — "A run never stops because a rung is unscored" holds for every catalog family. — Cost if wrong: a role whose only rung is such a model still has "no usable rung" (an error, as in 1.1).
9. **Profile repair:** two errors are the same when path and message match; a profile with no stored file has nothing to repair; it applies to `patchProfile` (`profile set`, `profile_set`, the dashboard's save), not to `new`/`copy`/reset. `profile set` exits 0 on a repair and prints `! saved; N errors are still open:` then the errors; the dashboard's save dialog offers Save under "This save fixes an error and adds none; these stay open:" and its toast says how many remain. — Spec §6.2. — Cost if wrong: exit code only.
10. **treat-like:** the override keeps its `rung → like` format (1.1 reads it); "marked `source: "user"`" is the catalog's marking of override entries, as today. `--clear` refuses a rung with no mapping of the user's (a shipped one is not theirs) with `E_INPUT_INVALID`; `--clear` and `--reset` compute the rungs left on an inferred stand-in (every profile's enabled rungs and failover stand-ins) before removing and print them before the `✓` line; `--suggest` ranks rungs lending a dimension the rung lacks, else any scored rung. — Spec §6.4. — Cost if wrong: output order only.
11. **The refresh script** syncs into a throwaway `CATHERD_HOME`, with no AA key and the TTL ignored; any failed keyless source writes nothing and exits 1; "changed" ignores the file's `version` and `barsWhy` wording; the PR body lists, besides moves over 5 %, values that appear on or leave an already-scored rung, and shipped treat-likes the rebuild dropped. — Never ship a file that lost a source's values. — Cost if wrong: a refresh waits a week for a flaky source.
12. **The worker-miss warning** fires only for a kind none of whose bars the worker's ladder clears ("no worker rung clears any bar for K; those lanes always start at the default rung"). — The logic and hard bars sit at the 60th and 75th percentiles, which a cost-minded ladder is not meant to reach; those lanes start at the default rung and climb, as in 1.1. — Cost if wrong: `validate` no longer says a ladder misses logic/hard; `route`'s provenance shows each lane's thresholds.
13. **"Stand-in to confirm" scope:** rungs of a role with two or more usable rungs (where bars choose) and failover stand-ins; one warning per canonical rung naming its profile rungs, at the first one's path; doctor's `sources` row lists them over the active and linked profiles. — A role with one rung runs it whatever the bars say. — Cost if wrong: an architect or verifier leaning on a guess is not listed.
14. **Shipped treat-likes `gpt-6-luna#<e>` → `gpt-5.6-luna#<e>`** (every effort), the ranker's own nearest stand-in for agentic, with a note; the weekly refresh drops them once Arena scores Luna ("Shipped stand-ins no longer needed" in its PR). — C-3: the default profile shows no warning. — Cost if wrong: a maintainer's confirmation stands in for the user's.
15. **Run evidence:** lanes = distinct (lane, rung, kind) rows of `routes.jsonl` (routes and climbs onto a rung); climbs = climb rows off it (`from ≠ to`); replies = records whose `replyStatus` is `partial`, `blocked` or `refused`, under the kind the lane was routed as when the dispatch started; verifier FAILs = a headless verifier record (status ok) whose reply opens `VERDICT: FAIL`, or a native `agents.jsonl` verifier row with status `failed`, counted on the verifier's own rung under `*` (a milestone's verdict covers several lanes). Keyed by canonical rung; every count also under `*`. — Spec §8 names the counts, not their joins. — Cost if wrong: the FAIL count says how often a verifier rung found fault, not whose work failed.
16. **Provenance:** a value's `source` is the sync source, `shipped` for a hand-typed value, `override` for the user's (`buildCatalog` now stamps override scores); `inferred: true` with `from` marks a treat-like's or a stand-in's value; thresholds only when the route read a bar (kind and difficulty known); speed facts are the family's (`applyFacts` now carries a sync's `speed`); cost is `costOf` under the profile's billing. `RouteAnswer.provenance` is optional; `routes.jsonl` is unchanged. — Spec §5.3. — Cost if wrong: field names in the MCP answer.
17. **Dashboard:** `r` (the existing `catalog.refresh`) now lists every backend's models **and** syncs the sources, then opens a "Sources" list (each source's age and last error); `i` (new) shows the selected rung's values with confidence, source and date, and its runs; `t` (new) opens the treat-like picker on any rung with the three nearest stand-ins first (`suggested`, each with its distance and what it lends); ticking an unscored rung opens the same picker (usually without suggestions: such a rung shares fewer than 3 features). — Spec §9 TUI; the rung detail had no screen. — Cost if wrong: key choices.
18. **`catalog list`** adds, per model, a line with its price and speed facts, and per rung catherd has run, a line with its evidence. — Spec §4.1, §8. — Cost if wrong: output only.
19. **The 90-day drop** stays a precedence rule (plan 13 Ruling 9); the bar pool reads stored levels at rebuild time. — Cost if wrong: none today (all values are recent).
20. **The weekly workflow** runs Mondays 06:17 UTC and on dispatch, force-pushes branch `catalog-refresh`, creates or edits the PR with `gh`, and writes `.changeset/catalog-refresh.md` (`"catherd-cli": patch`); it uses `RELEASE_TOKEN` when set, as `release.yml` does, so the PR gets CI. — Cost if wrong: schedule only.

## Assumes from earlier plans (re-check on the head you execute on)

`main` at `cff7d19` (plan 13 merged, with its four fix-wave commits). The executor re-finds every diff hunk by its context; these plan-13 interfaces are consumed:

- `src/domain/catalog.ts`: `DIMS` (6), `CONFIDENCE`, `RANK`, `ScoreSchema` with `source`/`fit`/`effortAssumed`, `outranks(a, b, now)`, `buildCatalog({ models, scores, synced?, facts?, override?, listed?, secs?, now? })`, `scoresOf` returning `borrowed`, `FamilyFactsSchema` with `releaseDate` and `speed`, `applyFacts` (the fix wave ORs capabilities; Task 4 adds `releaseDate` and Task 8 `speed` to the same return).
- `src/domain/calibration.ts`: `DIM_SOURCES` with `anchor: FieldRef | "shipped"`, `FieldRef`.
- `src/domain/sources.ts`: `DerivedSchema` (Task 4 adds `features`), `EFFORT_ORDER`, `splitSourceRung`, `familyEfforts`, `nearestEffort`.
- `src/services/source-derive.ts`: `derive(raw, ctx)`, `RawAnswers`, `DeriveContext`, `adjacent(families, direct, shipped: Set<string>, now)` (fix wave), `HELD_DIMS` (fix wave; Task 2 removes it).
- `src/services/source-sync.ts`: `syncSources(o)` → `SyncReport { busy, sources, newlyScored, noLongerNeeded, failed, warnings, unmatched }`, `shippedSources()`, `sourcesStatus()`, and the internal `cachedAnswers()` (Task 2 exports it); `fresh()` reads the cache (fix wave).
- `src/services/doctor-sources.ts`: `sourcesCheck(now)`, `ageText(ms)`.
- `src/infra/sources/http.ts`: `SourceTransport`; `src/infra/sources/cache.ts`: `readDerived`.
- `test/services/source-fixtures.ts`: `rawAnswers(fetchedAt, { aa? })`, `recordedFetch({ fail? })`, `shippedContext(now)`; the fixtures keep "Opus 5.5 has no repo_code or terminal value in any keyless source" (plan 13 R-D).
- `catalog/sources.json`: each source's `name` and `attribution` (Task 3's ATTRIBUTION.md and its test quote them).

## Verified facts (scratch build, 2026-09-28)

- The live keyless sync of 2026-09-28 18:31 UTC: agentic fits Arena task outcome (n 45, R² 0.818) and bash recovery (n 45, 0.604); frontend fits Epoch WebDev (n 61, 0.952); repo_code's FrontierCode (2 shared rungs), honesty's Vectara (0) and tool hallucination (2) and terminal's Epoch (0) are not used. Only a price warning (GPT-5.6 Sol on OpenRouter).
- **The derived default bars** (each threshold's `barsWhy` is in the file): `repo_code` copy 60.95, build 66.6, logic 67, hard 70.9 (11 DeepSWE 1.1 values: the hand-typed verified and secondary ones); `terminal` 40.15, 55.8, 57.06, 61.35 (7 Terminal-Bench 4.0 values); `honesty` logic 80.82, hard 95.1 (5 Broken Search Tool values); `agentic` logic 0.08606, hard 0.1077 (8 Arena agent values, measured); `frontend` copy 1539, build 1617, logic 1668, hard 1751 (9 Arena WebDev values, measured).
- The shipped file after Task 3: 262 values (hand-typed, Arena, 2 Epoch), sha256 `cc42feb44126df76d9ac6356b4bb36db86f8388e4716b7ff375ac2d96416bde3`; after Task 5 (the Luna treat-likes): sha256 `bdcf48d7b9fe3ef5214ab18caeca72a4e62a1a69a18df3e3a3bbd570a75e7813`. The Opus 5.5 low/medium/high shipped treat-likes are dropped (those efforts carry xhigh's and max's values).
- The default worker (Luna high, Sol medium, high, xhigh; default Sol medium) on these bars: see Review Focus 1. Sol's agentic value (0.0818) sits just below the logic bar (0.08606).
- Stand-ins on the shipped data: every Claude rung borrows honesty from a Sol rung; GPT-5.6 Terra borrows repo_code, terminal and honesty; Haiku 4.5 at `high`/`max` borrows repo_code and agentic from Sonnet 5 and terminal and honesty from GPT-5.6 Sol.
- The default profile validates `{ errors: [], warnings: [] }` with and without a sync of the recorded answers.
- oxfmt formats `catalog/*.json`, `README.md`, `MIGRATION.md`, `.changeset/*.md` and workflows; `docs/**` and `test/fixtures/**` are ignored. Every diff below is oxfmt's output.

## File Structure

| File | Task | Responsibility |
| --- | --- | --- |
| `src/domain/bars.ts` (new) | 1 | the §5.1 table (`DEFAULT_BAR_DIMS`, `barDimsOf`, `BAR_DIMS`), `percentile`, `measuredOrBetter`, `barPool`, `deriveBars` |
| `src/domain/catalog.ts` | 1, 3, 4, 8 | override bars per dimension (1); `barsWhy` schema and `Catalog.barsWhy` (3); `releaseDate`, `InferredStandIn`, `Catalog.features`/`inferred`, `scoresOf` with `inferred`/`standIns` (4); `Family.speed`, override `source` (8) |
| `src/domain/calibration.ts` | 2 | terminal anchored on the shipped values (C-2) |
| `src/services/source-derive.ts` | 2, 4 | hand-typed anchors, exported `adjacent`, no `HELD_DIMS` (2); AA `features` (4) |
| `src/services/source-sync.ts` | 2 | `cachedAnswers` exported |
| `src/services/catalog-refresh.ts` (new), `scripts/catalog-refresh.ts` (new) | 2 | `rebuildShipped`, `shippedChanged`, `refreshBody`, `refreshShipped`; the script |
| `catalog/scores.json`, `catalog/ATTRIBUTION.md` (new), `test/pack-smoke.ts` | 3, 5 | the shipped values and bars (3); the Luna treat-likes (5) |
| `src/domain/failover.ts`, `src/domain/profile-rules.ts` | 3, 5 | effort-nearest stand-ins, blind-kind warning (3); unscored as warnings, stand-ins to confirm, `repairs`, `inferredScores.note` (5) |
| `src/services/standins.ts` (new), `catalog/models.json`, `src/domain/sources.ts`, `src/services/catalog-service.ts` | 4 | ranking and `withStandIns`; release dates; `Derived.features`; `loadCatalog` serves inferred values |
| `src/services/profile-service.ts`, `src/entry/profile-command.ts`, TUI save dialog, actions, tree, edits, fixtures, `src/entry/mcp/setup-tools.ts` | 5 | repair saves and their output |
| `src/services/treat-likes.ts` (new), `src/services/catalog-service.ts`, `src/entry/catalog-command.ts` | 6 | `--suggest`, `--clear`, `--reset`; `removeTreatLikes`, `canonicalRung`, `loadCatalog({ override })` |
| `src/services/run-evidence.ts` (new) | 7 | `runEvidence`, `evidenceOf`, `evidenceLine` |
| `src/services/provenance.ts` (new), `routing-service.ts`, `ports.ts`, `catalog-service.ts`, `catalog-command.ts`, MCP tool texts | 8 | route and catalog provenance, `catalog list` facts and evidence |
| `src/services/doctor-sources.ts`, `src/services/doctor.ts` | 9 | stand-ins to confirm in the `sources` row |
| `src/entry/tui/commands.ts`, `state.ts`, `effects.ts`, `fixtures.ts`, `profile-edits.ts`, `views/profiles.tsx` | 10 | `r`, `i`, `t` |
| `.github/workflows/catalog-refresh.yml` (new) | 11 | the weekly refresh |
| `.changeset/catherd-1-2.md` (new), `README.md`, `MIGRATION.md`, `docs/dev/live-verification.md` | 12 | the 1.2.0 changeset and docs |

## Parallelism

| Wave | Batches (parallel worktrees) | Depends on | Why disjoint |
| --- | --- | --- | --- |
| A | {1}, {7} | — | `bars.ts` + `catalog.ts` + bars test (1) vs `run-evidence.ts` + its test (7) |
| B | {2} | 1 | derive, calibration, sync, the refresh service and script |
| C | {3}, {11} | 2 | the data task and every test it re-pins (3) vs the workflow and its test (11: reads `scripts/catalog-refresh.ts` from 2) |
| D | {4} | 3 | stand-ins; its frames snapshot follows Task 3's |
| E | {5} | 4 | validation and repair (profile-rules, profile-service, TUI save files, `scores.json`) |
| F | {6}, {9} | 5 | `catalog-service.ts`, `catalog-command.ts`, `treat-likes.ts` (6) vs `doctor-sources.ts`, `doctor.ts` (9) |
| G | {8} | 6, 7 | `catalog-service.ts` and `catalog-command.ts` again, after 6 |
| H | {10} | 5, 8 | TUI files (`fixtures.ts` after 5; `effects.ts` reads 7's and 8's services) |
| I | {12} | all | docs and the changeset |

Shared files, each owned by one task at a time: `src/domain/catalog.ts` (1 → 3 → 4 → 8), `catalog/scores.json` (3 → 5), `src/domain/profile-rules.ts` (3 → 5), `src/services/catalog-service.ts` (4 → 6 → 8), `src/entry/catalog-command.ts` (6 → 8), `src/services/source-derive.ts` (2 → 4), `src/entry/tui/fixtures.ts` and `profile-edits.ts` (5 → 10), `src/entry/mcp/setup-tools.ts` (5 → 8), `test/entry/catalog-command.test.ts` (3 → 6 → 8), `test/services/catalog-service.test.ts` (3 → 8), `test/services/routing-service.test.ts` (3 → 8), `test/domain/profile-rules.test.ts` (3 → 5), `test/entry/tui/profiles.test.tsx` (3 → 10), `test/entry/tui/profile-tree.test.ts` (3 → 5 → 8), the frames snapshot (3 → 4). Mostly sequential: the catalog is one model. For fewer agents: {1, 7}, {2}, {3, 11}, {4, 5}, {6, 9}, {8, 10}, {12}.


---

### Task 1: Default bars per kind and difficulty, from percentiles, overridden per dimension (spec 1.2 §5.1, §5.2; C-4; Rulings 1, 2)

`src/domain/bars.ts` holds spec 1.2 §5.1's table and §5.2's derivation: `percentile` (linear between closest ranks), `measuredOrBetter` (Ruling 1), `barPool` (one value per canonical rung and dimension), `deriveBars` (the bars and a `barsWhy` line per dimension and difficulty). `OverrideSchema.bars` takes `null` per dimension and `buildCatalog` merges an override's bar per dimension (C-4). The shipped bars do not change yet (Task 3 ships them).

**Files:**

- Create: `src/domain/bars.ts`
- Modify: `src/domain/catalog.ts`
- Test (new): `test/domain/bars.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `src/domain/bars.ts`: `DEFAULT_BAR_DIMS: Record<Kind, { A: Dim[]; B: Dim[] }>`, `barDimsOf(kind, difficulty): Dim[]`, `BAR_DIMS: Dim[]` (every dimension a default bar uses: `repo_code, terminal, honesty, agentic, frontend`), `BAR_PERCENTILE`, `percentile(xs, p): number`, `measuredOrBetter(s: Score): boolean`, `barPool(scores): Record<Dim, number[]>`, `type Bars`, `type BarsWhy`, `deriveBars(pool, benchmark: (d) => string, date: string): { bars: Bars; barsWhy: BarsWhy }`. `OverrideSchema.bars` values `number | null`.

- [ ] **Step 1: Write the failing tests**

Create `test/domain/bars.test.ts`:

````ts
import { describe, expect, it } from "bun:test";
import {
  BAR_DIMS,
  barDimsOf,
  barPool,
  deriveBars,
  measuredOrBetter,
  percentile,
} from "../../src/domain/bars.ts";
import { type Dim, DIMS, OverrideSchema, type Score } from "../../src/domain/catalog.ts";
import { DIFFICULTIES, KINDS } from "../../src/domain/lane.ts";
import { shipped } from "./shipped.ts";

const score = (o: Partial<Score> & Pick<Score, "rung" | "dim" | "value">): Score => ({
  benchmark: "b",
  version: "v",
  url: "https://example.com/s",
  date: "2026-09-27",
  confidence: "measured",
  ...o,
});

describe("default bars (spec 1.2 §5.1)", () => {
  it("spans the table's dimensions per kind, Track A then Track B", () => {
    expect(barDimsOf("repo_code", "copy")).toEqual(["repo_code"]);
    expect(barDimsOf("repo_code", "hard")).toEqual(["repo_code", "honesty", "agentic"]);
    expect(barDimsOf("terminal", "build")).toEqual(["terminal"]);
    expect(barDimsOf("terminal", "logic")).toEqual(["terminal", "honesty", "agentic"]);
    expect(barDimsOf("ui", "build")).toEqual(["frontend", "repo_code"]);
    expect(barDimsOf("ui", "logic")).toEqual(["frontend", "repo_code", "honesty", "agentic"]);
    for (const k of ["prose", "research"] as const) {
      expect(barDimsOf(k, "copy")).toEqual(["repo_code"]);
      expect(barDimsOf(k, "hard")).toEqual(["repo_code", "honesty"]);
    }
  });

  it("puts no default bar on steer", () => {
    expect(BAR_DIMS).toEqual(["repo_code", "terminal", "honesty", "agentic", "frontend"]);
    for (const k of KINDS) for (const d of DIFFICULTIES) expect(barDimsOf(k, d)).not.toContain("steer");
  });
});

describe("bar values (spec 1.2 §5.2)", () => {
  it("interpolates percentiles between the closest ranks", () => {
    const xs = [37.2, 54, 56.6, 65.3, 66.6, 66.6, 67, 68.8, 73, 74, 74.2];
    expect(percentile(xs, 25)).toBeCloseTo(60.95, 6);
    expect(percentile(xs, 50)).toBe(66.6);
    expect(percentile(xs, 60)).toBe(67);
    expect(percentile(xs, 75)).toBeCloseTo(70.9, 6);
    expect(percentile([5], 75)).toBe(5);
    expect(percentile([], 50)).toBeNaN();
  });

  it("pools values measured or better, counting a hand-typed secondary value and one value per rung", () => {
    expect(measuredOrBetter(score({ rung: "a#high", dim: "repo_code", value: 1 }))).toBe(true);
    const secondary = score({ rung: "a#high", dim: "repo_code", value: 1, confidence: "secondary" });
    expect(measuredOrBetter(secondary)).toBe(true);
    for (const confidence of ["calibrated", "adjacent", "inferred"] as const)
      expect(measuredOrBetter(score({ rung: "a#high", dim: "repo_code", value: 1, confidence }))).toBe(false);
    // a synced value is never secondary; if one were, it would not be a published number for this rung
    expect(measuredOrBetter({ ...secondary, source: "epoch" })).toBe(false);
    const pool = barPool([
      score({ rung: "a#high", dim: "agentic", value: 0.1 }),
      score({ rung: "a#high", dim: "agentic", value: 0.2 }),
      score({ rung: "a#max", dim: "agentic", value: 0.3, confidence: "adjacent" }),
      score({ rung: "b#high", dim: "agentic", value: 0.4, confidence: "verified" }),
    ]);
    expect(pool.agentic).toEqual([0.1, 0.4]);
    expect(pool.repo_code).toEqual([]);
  });

  it("derives each threshold once per dimension and difficulty, with a why line, and none without data", () => {
    const pool = Object.fromEntries(DIMS.map((d) => [d, [] as number[]])) as Record<Dim, number[]>;
    pool.repo_code = [37.2, 54, 56.6, 65.3, 66.6, 66.6, 67, 68.8, 73, 74, 74.2];
    pool.honesty = [21.8, 22.5, 71.3, 95.1, 98.5];
    const { bars, barsWhy } = deriveBars(pool, (d) => (d === "repo_code" ? "DeepSWE 1.1" : d), "2026-09-28");
    expect(bars.repo_code.copy).toEqual({ repo_code: 60.95 });
    expect(bars.prose.build).toEqual({ repo_code: 66.6 });
    expect(bars.research.logic).toEqual({ repo_code: 67, honesty: 80.82 });
    expect(bars.repo_code.hard).toEqual({ repo_code: 70.9, honesty: 95.1 });
    // no pooled agentic, terminal or frontend value: those thresholds are left out, and said so
    expect(bars.terminal.copy).toEqual({});
    expect(bars.ui.build).toEqual({ repo_code: 66.6 });
    expect(barsWhy.repo_code?.copy).toBe(
      "the 25th percentile of 11 rungs measured or better on DeepSWE 1.1 (2026-09-28): 60.95",
    );
    expect(barsWhy.agentic?.hard).toBe("no rung is measured or better on agentic (2026-09-28): no threshold");
    expect(barsWhy.agentic?.copy).toBeUndefined();
    expect(barsWhy.steer).toBeUndefined();
  });
});

describe("the override's bars (spec 1.2 §5.2)", () => {
  it("overrides the default per dimension: a number sets it, null removes it, the rest stay", () => {
    const base = shipped();
    const o = OverrideSchema.parse({
      bars: { repo_code: { logic: { repo_code: 50, honesty: null, steer: 0.05 } } },
    });
    const mine = shipped({ override: o });
    const want: Record<string, number> = { ...base.bars.repo_code.logic, repo_code: 50, steer: 0.05 };
    delete want.honesty;
    expect(mine.bars.repo_code.logic).toEqual(want);
    expect(mine.bars.repo_code.hard).toEqual(base.bars.repo_code.hard);
  });

  it("still reads an override that sets a whole bar, as 1.1 wrote them", () => {
    const o = OverrideSchema.safeParse({ bars: { ui: { hard: { repo_code: 70, honesty: 95 } } } });
    expect(o.success).toBe(true);
  });
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/domain/bars.test.ts test/domain/catalog.test.ts`
Expected: FAIL — `Cannot find module '../../src/domain/bars.ts'`, and the override test cannot parse a `null` threshold.

- [ ] **Step 3: Implement**

Create `src/domain/bars.ts`:

````ts
import { type Dim, DIMS, type Score } from "./catalog.ts";
import { DIFFICULTIES, type Difficulty, KINDS, type Kind } from "./lane.ts";

/**
 * Spec 1.2 §5.1: the dimensions each kind's default bars span, for Track A (`copy`, `build`) and Track B
 * (`logic`, `hard`). `steer` has no default bar: it is shown, and a user may set one.
 */
export const DEFAULT_BAR_DIMS: Record<Kind, { A: Dim[]; B: Dim[] }> = {
  repo_code: { A: ["repo_code"], B: ["repo_code", "honesty", "agentic"] },
  terminal: { A: ["terminal"], B: ["terminal", "honesty", "agentic"] },
  ui: { A: ["frontend", "repo_code"], B: ["frontend", "repo_code", "honesty", "agentic"] },
  prose: { A: ["repo_code"], B: ["repo_code", "honesty"] },
  research: { A: ["repo_code"], B: ["repo_code", "honesty"] },
};

/** The dimensions a difficulty's default bar spans for a kind. */
export const barDimsOf = (kind: Kind, d: Difficulty): Dim[] =>
  d === "copy" || d === "build" ? DEFAULT_BAR_DIMS[kind].A : DEFAULT_BAR_DIMS[kind].B;

/** Every dimension some default bar uses: the values an enabled rung needs (spec 1.2 §6.1). */
export const BAR_DIMS: Dim[] = DIMS.filter((d) =>
  KINDS.some((k) => DIFFICULTIES.some((x) => barDimsOf(k, x).includes(d))),
);

/** Spec 1.2 §5.2: the percentile of the scored rungs each difficulty's threshold sits at. */
export const BAR_PERCENTILE: Record<Difficulty, number> = { copy: 25, build: 50, logic: 60, hard: 75 };

const PERCENTILE_WORD: Record<Difficulty, string> = {
  copy: "the 25th percentile",
  build: "the median",
  logic: "the 60th percentile",
  hard: "the 75th percentile",
};

/** The `p`th percentile of `xs`, interpolated linearly between the closest ranks; NaN for none. */
export function percentile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return Number.NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = ((s.length - 1) * p) / 100;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (s[lo] as number) + ((s[hi] as number) - (s[lo] as number)) * (pos - lo);
}

/**
 * Spec 1.2 §5.2 "measured or better": a value published for this exact rung in the anchor's unit. That is a
 * `verified` or `measured` value, and a hand-typed `secondary` one (no `source`: the 1.0 word for a value
 * published by someone other than the vendor, which is 1.2's `measured`). Plan 14 Ruling 1.
 */
export const measuredOrBetter = (s: Score): boolean =>
  s.confidence === "verified" ||
  s.confidence === "measured" ||
  (s.confidence === "secondary" && s.source === undefined);

/** Each dimension's values that bars are derived from: one per canonical rung, measured or better. */
export function barPool(scores: readonly Score[]): Record<Dim, number[]> {
  const out = Object.fromEntries(DIMS.map((d) => [d, [] as number[]])) as Record<Dim, number[]>;
  const seen = new Set<string>();
  for (const s of scores) {
    const key = `${s.rung} ${s.dim}`;
    if (!measuredOrBetter(s) || seen.has(key)) continue;
    seen.add(key);
    out[s.dim].push(s.value);
  }
  return out;
}

/** A bar value, kept to four significant digits (DeepSWE 60.95, an Arena rating 1668, agentic 0.08622). */
const tidy = (v: number): number => Number(v.toPrecision(4));

export type Bars = Record<Kind, Record<Difficulty, Partial<Record<Dim, number>>>>;
/** `scores.json` `barsWhy`: per dimension and difficulty, where its threshold came from. */
export type BarsWhy = Partial<Record<Dim, Partial<Record<Difficulty, string>>>>;

/**
 * Spec 1.2 §5.1–§5.2: the default bars. Each dimension's threshold at a difficulty is that difficulty's
 * percentile of the pool (`barPool`), the same in every kind whose bar spans the dimension. A dimension with
 * no pooled value gets no threshold (and a `barsWhy` line saying so). `benchmark` names each dimension's unit
 * and `date` the day the data was read.
 */
export function deriveBars(
  pool: Record<Dim, number[]>,
  benchmark: (d: Dim) => string,
  date: string,
): { bars: Bars; barsWhy: BarsWhy } {
  const value: Partial<Record<Dim, Partial<Record<Difficulty, number>>>> = {};
  const barsWhy: BarsWhy = {};
  for (const dim of BAR_DIMS)
    for (const d of DIFFICULTIES) {
      if (!KINDS.some((k) => barDimsOf(k, d).includes(dim))) continue;
      const xs = pool[dim];
      const why = (barsWhy[dim] ??= {});
      if (xs.length === 0) {
        why[d] = `no rung is measured or better on ${benchmark(dim)} (${date}): no threshold`;
        continue;
      }
      const v = tidy(percentile(xs, BAR_PERCENTILE[d]));
      (value[dim] ??= {})[d] = v;
      why[d] =
        `${PERCENTILE_WORD[d]} of ${xs.length} rungs measured or better on ${benchmark(dim)} (${date}): ${v}`;
    }
  const bars = Object.fromEntries(
    KINDS.map((k) => [
      k,
      Object.fromEntries(
        DIFFICULTIES.map((d) => [
          d,
          Object.fromEntries(
            barDimsOf(k, d).flatMap((dim) => {
              const v = value[dim]?.[d];
              return v === undefined ? [] : [[dim, v]];
            }),
          ),
        ]),
      ),
    ]),
  ) as Bars;
  return { bars, barsWhy };
}
````

Edit `src/domain/catalog.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/catalog.ts b/src/domain/catalog.ts
index 89b5bbf..18dcc06 100644
--- a/src/domain/catalog.ts
+++ b/src/domain/catalog.ts
@@ -138,12 +138,19 @@ export const ScoresFileSchema = z.looseObject({
 });
 export type ScoresFile = z.infer<typeof ScoresFileSchema>;
 
-/** `<config>/catalog.override.json` (spec §3.5): the user's treat-likes, scores and bars. */
+/** An override's bar: per dimension a threshold, or `null` to remove the default's (spec 1.2 §5.2). */
+const OverrideBarSchema = z.partialRecord(z.enum(DIMS), z.number().nullable());
+
+/**
+ * `<config>/catalog.override.json` (spec §3.5): the user's treat-likes, scores and bars. Its bars override
+ * the default bars per dimension (spec 1.2 §5.2): a number sets that threshold, `null` removes it, and a
+ * dimension it does not name keeps the default's.
+ */
 export const OverrideSchema = z.looseObject({
   schema: z.literal(1).default(1),
   treatLike: z.record(CanonicalRung, CanonicalRung).default({}),
   scores: z.array(ScoreSchema).default([]),
-  bars: z.partialRecord(z.enum(KINDS), z.partialRecord(z.enum(DIFFICULTIES), BarSchema)).default({}),
+  bars: z.partialRecord(z.enum(KINDS), z.partialRecord(z.enum(DIFFICULTIES), OverrideBarSchema)).default({}),
 });
 export type Override = z.infer<typeof OverrideSchema>;
 
@@ -264,10 +271,10 @@ export function buildCatalog(o: {
     treatLike[rung] = { like, source: "user" };
   const bars = structuredClone(o.scores.bars) as Bars;
   for (const kind of KINDS)
-    for (const d of DIFFICULTIES) {
-      const bar = o.override?.bars[kind]?.[d];
-      if (bar) bars[kind][d] = bar;
-    }
+    for (const d of DIFFICULTIES)
+      for (const [dim, min] of Object.entries(o.override?.bars[kind]?.[d] ?? {}) as [Dim, number | null][])
+        if (min === null) delete bars[kind][d][dim];
+        else bars[kind][d][dim] = min;
   return {
     families: o.facts ? applyFacts(o.models.families, o.facts) : o.models.families,
     backends: o.models.backends,
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/domain/bars.test.ts test/domain/catalog.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/domain/bars.ts src/domain/catalog.ts test/domain/bars.test.ts
git commit -m "feat(catalog): default bars per kind and difficulty from percentiles, overridden per dimension"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 2: Rebuild the shipped scores and bars from the keyless sources, with a refresh script (spec 1.2 §5.2, §7; C-2; Rulings 3, 5, 11)

`rebuildShipped` turns the keyless sources' cached answers into a new `catalog/scores.json` (Ruling 3) with the bars and `barsWhy` of Task 1, drops a shipped treat-like its rung no longer needs, and reports rungs newly scored, values moved by more than 5 % and bars that moved; `refreshBody` is the refresh PR's body; `refreshShipped` syncs (no AA key, forced) and writes the file only when it changed and no source failed. `scripts/catalog-refresh.ts` runs it in a throwaway `CATHERD_HOME`. Plan 13's derive anchors on hand-typed values only (Ruling 5), terminal's anchor becomes the shipped Terminal-Bench 4.0 values with Epoch fitted onto them (C-2; `HELD_DIMS` goes), and `adjacent` and `cachedAnswers` are exported. The rebuild is not run here: Task 3 ships its output.

**Files:**

- Create: `scripts/catalog-refresh.ts`
- Modify: `src/domain/calibration.ts`
- Create: `src/services/catalog-refresh.ts`
- Modify: `src/services/source-derive.ts`
- Modify: `src/services/source-sync.ts`
- Test (new): `test/services/catalog-refresh.test.ts`
- Test: `test/services/source-derive.test.ts`

**Interfaces:**
- Consumes: Task 1's `barPool`, `deriveBars`, `measuredOrBetter`; plan 13's `derive`, `adjacent`, `syncSources`, `cachedAnswers`, `SourceTransport`, `recordedFetch`, `rawAnswers`, `shippedContext`.
- Produces: `src/services/catalog-refresh.ts`: `interface RefreshReport { date; newlyScored: string[]; moved: { rung; dim; from: number | null; to: number | null }[]; barsMoved: { kind; difficulty; dim; from; to }[]; standInsDropped: string[] }`, `rebuildShipped(raw, { models, scores, sources, now }): { file: ScoresFile; report: RefreshReport }`, `shippedChanged(before, after): boolean`, `refreshBody(report): string`, `refreshShipped({ out, current, models, sources, transport?, now? }): Promise<{ changed; failed; report }>`. `source-derive.ts` exports `adjacent`; `source-sync.ts` exports `cachedAnswers`. `DIM_SOURCES.terminal.anchor === "shipped"`.

- [ ] **Step 1: Write the failing tests**

Create `test/services/catalog-refresh.test.ts`:

````ts
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { barPool, deriveBars, percentile } from "../../src/domain/bars.ts";
import { DIMS, type Score, type ScoresFile, ScoresFileSchema } from "../../src/domain/catalog.ts";
import { EPOCH_URL } from "../../src/infra/sources/epoch.ts";
import {
  rebuildShipped,
  refreshBody,
  refreshShipped,
  shippedChanged,
} from "../../src/services/catalog-refresh.ts";
import { snapshotEnv, tempDir, withHome } from "../helpers.ts";
import { rawAnswers, recordedFetch, shippedContext } from "./source-fixtures.ts";

afterEach(snapshotEnv());

const AT = "2026-09-28T10:00:00.000Z";
const NOW = Date.parse(AT);
const ctx = () => shippedContext(NOW);
const rebuild = (o: { aa?: boolean; scores?: ScoresFile } = {}) => {
  const c = ctx();
  return rebuildShipped(rawAnswers(AT, { aa: o.aa }), { ...c, scores: o.scores ?? c.scores });
};
const find = (f: ScoresFile, rung: string, dim: string): Score | undefined =>
  f.scores.find((s) => s.rung === rung && s.dim === dim);

describe("the shipped scores, rebuilt from the keyless sources (spec 1.2 §7)", () => {
  it("keeps every hand-typed value published for its rung", () => {
    const { file } = rebuild();
    for (const s of ctx().scores.scores)
      if (s.source === undefined && s.confidence !== "inferred" && s.confidence !== "adjacent")
        expect(find(file, s.rung, s.dim)).toEqual(s);
  });

  it("never ships a value from Artificial Analysis, even when its answer is cached", () => {
    const withAa = rebuild({ aa: true }).file;
    expect(withAa.scores.filter((s) => s.source === "artificial-analysis")).toEqual([]);
    expect(withAa).toEqual(rebuild().file);
  });

  it("carries the keyless sources' values with their source, date and confidence", () => {
    const s = find(rebuild().file, "claude-opus-5-5#high", "agentic");
    expect(s).toMatchObject({ value: 0.1215, source: "arena", date: "2026-09-27", confidence: "measured" });
  });

  it("spreads a published value to the family's other efforts, but never an inferred one", () => {
    const { file } = rebuild();
    // Luna is published at max only: its other efforts carry that value as adjacent
    expect(find(file, "gpt-6-luna#high", "repo_code")).toMatchObject({
      value: 66.6,
      confidence: "adjacent",
      note: "DeepSWE has it at max; carried to this effort",
    });
    // Fable's DeepSWE value is inferred (a secondary source that names no effort): it stays on max
    expect(find(file, "claude-fable-5-1#max", "repo_code")?.confidence).toBe("inferred");
    expect(find(file, "claude-fable-5-1#xhigh", "repo_code")).toBeUndefined();
  });

  it("ships one value per rung and dimension, and rebuilding it again changes nothing", () => {
    const { file } = rebuild();
    const keys = file.scores.map((s) => `${s.rung} ${s.dim}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(ScoresFileSchema.safeParse(file).success).toBe(true);
    const again = rebuild({ scores: file });
    expect(shippedChanged(file, again.file)).toBe(false);
    expect(again.report).toMatchObject({ newlyScored: [], moved: [], barsMoved: [], standInsDropped: [] });
  });

  it("derives the default bars from the values measured or better, with a why line each", () => {
    const { file } = rebuild();
    const pool = barPool(file.scores);
    expect(file.bars.repo_code.copy.repo_code).toBe(Number(percentile(pool.repo_code, 25).toPrecision(4)));
    expect(file.bars).toEqual(
      deriveBars(pool, (d) => `${file.benchmarks[d].benchmark} ${file.benchmarks[d].version}`, "2026-09-28")
        .bars,
    );
    expect((file.barsWhy as Record<string, Record<string, string>>).agentic?.hard).toStartWith(
      "the 75th percentile of ",
    );
    for (const kind of Object.values(file.bars))
      for (const bar of Object.values(kind)) expect(Object.keys(bar)).not.toContain("steer");
  });

  it("drops a shipped treat-like its rung no longer needs, and keeps one that still lends", () => {
    const c = ctx();
    const scores = {
      ...c.scores,
      treatLike: {
        ...c.scores.treatLike,
        "claude-opus-5-5#high": { like: "claude-opus-5-5#xhigh", note: "only xhigh and max are published" },
      },
    };
    const { file, report } = rebuild({ scores });
    expect(file.treatLike["claude-opus-5-5#high"]).toBeUndefined();
    expect(file.treatLike["opencode-go/kimi-k3#max"]?.like).toBe("gpt-6-sol#medium");
    expect(report.standInsDropped).toContain("claude-opus-5-5#high");
  });

  it("reports the rungs newly scored, values moved by more than 5 %, and every bar that moved", () => {
    const first = rebuild().file;
    const before: ScoresFile = structuredClone(first);
    before.scores = before.scores
      .filter((s) => s.rung !== "gpt-6-luna#low")
      .map((s) =>
        s.rung === "gpt-6-sol#max" && s.dim === "agentic"
          ? { ...s, value: s.value * 1.1 }
          : s.rung === "gpt-6-sol#max" && s.dim === "steer"
            ? { ...s, value: s.value * 1.01 }
            : s,
      );
    before.bars.terminal.build = { terminal: 1 };
    const { report } = rebuild({ scores: before });
    expect(report.newlyScored).toEqual(["gpt-6-luna#low"]);
    const sol = find(first, "gpt-6-sol#max", "agentic")?.value as number;
    expect(report.moved).toEqual([{ rung: "gpt-6-sol#max", dim: "agentic", from: sol * 1.1, to: sol }]);
    expect(report.barsMoved).toContainEqual({
      kind: "terminal",
      difficulty: "build",
      dim: "terminal",
      from: 1,
      to: first.bars.terminal.build.terminal ?? null,
    });
    const body = refreshBody(report);
    expect(body).toContain("### Rungs newly scored (1)\n\n- `gpt-6-luna#low`");
    expect(body).toContain(`| \`gpt-6-sol#max\` | agentic | ${sol * 1.1} | ${sol} |`);
    expect(body).toContain("### Bars that moved");
  });
});

describe("refreshShipped (scripts/catalog-refresh.ts)", () => {
  it("syncs without a key, and writes the rebuilt file only when it says something new", async () => {
    withHome();
    const out = join(tempDir("catherd-refresh-"), "scores.json");
    const c = ctx();
    let t = NOW;
    const f = recordedFetch();
    const transport = { fetchImpl: f.impl, now: () => t, sleep: async (ms: number) => void (t += ms) };
    const r = await refreshShipped({
      out,
      current: c.scores,
      models: c.models,
      sources: c.sources,
      transport,
    });
    expect(f.urls.some((u) => u.includes("artificialanalysis"))).toBe(false);
    expect(r.failed).toEqual([]);
    const written = ScoresFileSchema.parse(JSON.parse(readFileSync(out, "utf8")));
    expect(r.changed).toBe(shippedChanged(c.scores, written));
    const again = await refreshShipped({
      out: `${out}.2`,
      current: written,
      models: c.models,
      sources: c.sources,
      transport,
    });
    expect(again.changed).toBe(false);
    expect(existsSync(`${out}.2`)).toBe(false);
  });

  it("writes nothing when a keyless source fails", async () => {
    withHome();
    const out = join(tempDir("catherd-refresh-"), "scores.json");
    const c = ctx();
    let t = NOW;
    const f = recordedFetch({ fail: (u) => u === EPOCH_URL });
    const transport = { fetchImpl: f.impl, now: () => t, sleep: async (ms: number) => void (t += ms) };
    const r = await refreshShipped({
      out,
      current: c.scores,
      models: c.models,
      sources: c.sources,
      transport,
    });
    expect(r.failed.map((x) => x.source)).toEqual(["epoch"]);
    expect(r.changed).toBe(false);
    expect(existsSync(out)).toBe(false);
  });

  it("covers every dimension's benchmark name", () => {
    for (const d of DIMS) expect(ctx().scores.benchmarks[d].benchmark.length).toBeGreaterThan(0);
  });
});
````

Edit `test/services/source-derive.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/source-derive.test.ts b/test/services/source-derive.test.ts
index 4b27660..ab5d281 100644
--- a/test/services/source-derive.test.ts
+++ b/test/services/source-derive.test.ts
@@ -90,6 +90,47 @@ describe("anchors and calibration (spec 1.2 §4.1, §4.2)", () => {
     expect(d.scores.some((s) => s.dim === "repo_code")).toBe(false);
   });
 
+  it("anchors terminal on the vendors' Terminal-Bench 4.0 values, fitting Epoch's 2.0 table onto them (C-2)", () => {
+    const d = keyless();
+    // Epoch's Terminal-Bench shares no rung with the shipped values: it is not used, and Haiku gets none
+    expect(d.fits.find((f) => f.field === "terminalbench")).toMatchObject({
+      dim: "terminal",
+      source: "epoch",
+      n: 0,
+      used: false,
+    });
+    expect(d.scores.filter((s) => s.dim === "terminal")).toEqual([]);
+  });
+
+  it("anchors on the hand-typed values only, never on a shipped keyless value", () => {
+    const c = shippedContext(NOW);
+    // a shipped value that came from a source (it carries one) is no anchor: the fits stay as they are
+    const scores = [
+      ...c.scores.scores,
+      ...[
+        "gpt-5.6-terra#max",
+        "gpt-6-astra#max",
+        "claude-sonnet-5#max",
+        "gpt-6-luna#max",
+        "gpt-6-sol#high",
+      ].map((rung) => ({
+        rung,
+        dim: "honesty" as const,
+        value: 50,
+        benchmark: "Vectara",
+        version: "x",
+        url: "https://example.com/v",
+        date: "2026-09-27",
+        confidence: "measured" as const,
+        source: "vectara",
+      })),
+    ];
+    const d = derive(rawAnswers(AT), { ...c, scores: { ...c.scores, scores } });
+    expect(d.fits.filter((f) => f.dim === "honesty")).toEqual(
+      keyless().fits.filter((f) => f.dim === "honesty"),
+    );
+  });
+
   it("calibrates Artificial Analysis onto the shipped anchor, never using it as one (synthetic fixture)", () => {
     const d = derive(rawAnswers(AT, { aa: true }), shippedContext(NOW));
     expect(d.fits.find((f) => f.field === "scicode")).toMatchObject({ dim: "repo_code", n: 5, used: true });
````

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/services/catalog-refresh.test.ts test/services/source-derive.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/catalog-refresh.ts'`; the derive tests expect no terminal value and the Haiku WebDev value.

- [ ] **Step 3: Implement**

Create `scripts/catalog-refresh.ts`:

````ts
#!/usr/bin/env bun
// Spec 1.2 §7: fetch every keyless source, rebuild catalog/scores.json's shipped values and default bars, and
// write the refresh PR's body and patch changeset. .github/workflows/catalog-refresh.yml runs it weekly; a
// maintainer runs it to produce a release's shipped values. It never reads an Artificial Analysis key, and it
// syncs into a throwaway data folder, never the user's own cache.
//
//   bun scripts/catalog-refresh.ts [--body <file>] [--changeset <file>]
//
// Exit 0 when the file changed (and was written) or nothing changed ("no change" on stdout); 1 when a source
// failed, and then nothing is written.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { body: { type: "string" }, changeset: { type: "string" } },
});

const home = mkdtempSync(join(tmpdir(), "catherd-refresh-"));
process.env.CATHERD_HOME = home;
delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;

const { assetPath } = await import("../src/infra/assets.ts");
const { shippedModels, shippedScores } = await import("../src/services/catalog-service.ts");
const { shippedSources } = await import("../src/services/source-sync.ts");
const { refreshBody, refreshShipped } = await import("../src/services/catalog-refresh.ts");

const out = assetPath("catalog/scores.json");
try {
  const r = await refreshShipped({
    out,
    current: shippedScores(),
    models: shippedModels(),
    sources: shippedSources(),
  });
  for (const f of r.failed) console.error(`${f.source}: ${f.error}`);
  if (r.failed.length) {
    console.error("a source failed: catalog/scores.json is left as it is");
    process.exitCode = 1;
  } else if (!r.changed || !r.report) console.log("no change");
  else {
    // the file is written as JSON.stringify writes it; oxfmt gives it the repository's format
    spawnSync("bunx", ["oxfmt", out], { stdio: "inherit" });
    const body = refreshBody(r.report);
    if (values.body) writeFileSync(values.body, body);
    if (values.changeset)
      writeFileSync(
        values.changeset,
        `---\n"catherd-cli": patch\n---\n\nRefresh the shipped model scores and default bars from the public sources (data of ${r.report.date}).\n`,
      );
    console.log(body);
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
````

Edit `src/domain/calibration.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/calibration.ts b/src/domain/calibration.ts
index cea43b5..ceae83d 100644
--- a/src/domain/calibration.ts
+++ b/src/domain/calibration.ts
@@ -15,7 +15,8 @@ export interface FieldRef {
 
 /**
  * Spec 1.2 §4.1: each dimension's anchor, the unit its bars are in, and the sources calibrated onto it.
- * `shipped` is the value `catalog/scores.json` carries (every anchor is keyless, spec 1.2 §4.1).
+ * `shipped` is the hand-typed value `catalog/scores.json` carries, published for that rung (every anchor is
+ * keyless, spec 1.2 §4.1).
  */
 export const DIM_SOURCES: Record<Dim, { anchor: FieldRef | "shipped"; others: FieldRef[] }> = {
   repo_code: {
@@ -35,9 +36,12 @@ export const DIM_SOURCES: Record<Dim, { anchor: FieldRef | "shipped"; others: Fi
       { source: "epoch", field: "frontiercode", benchmark: "FrontierCode (Epoch AI)" },
     ],
   },
+  // plan 14 Ruling C-2: the vendors' Terminal-Bench 4.0 values, not Epoch's Terminal-Bench 2.0, which shares
+  // no rung with them; Epoch is fitted onto them once it covers five of their rungs
   terminal: {
-    anchor: { source: "epoch", field: "terminalbench", benchmark: "Terminal-Bench (Epoch AI)" },
+    anchor: "shipped",
     others: [
+      { source: "epoch", field: "terminalbench", benchmark: "Terminal-Bench (Epoch AI)" },
       {
         source: "artificial-analysis",
         field: "terminalbench_v2_1",
````

Create `src/services/catalog-refresh.ts`:

````ts
import { writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { barPool, deriveBars } from "../domain/bars.ts";
import {
  buildCatalog,
  DIMS,
  type Dim,
  type ModelsFile,
  outranks,
  type Score,
  type ScoresFile,
  scoresOf,
} from "../domain/catalog.ts";
import { DIFFICULTIES, type Difficulty, KINDS, type Kind } from "../domain/lane.ts";
import type { SourcesFile } from "../domain/sources.ts";
import type { SourceTransport } from "../infra/sources/http.ts";
import { adjacent, derive, type RawAnswers } from "./source-derive.ts";
import { cachedAnswers, syncSources } from "./source-sync.ts";

/** Spec 1.2 §7: a value that moved by more than this is listed in the refresh PR. */
const MOVED = 0.05;

export interface RefreshReport {
  /** the day the data was read, `scores.json`'s new `version` */
  date: string;
  /** canonical rungs with no value in the shipped file before, and at least one now */
  newlyScored: string[];
  /** values that moved by more than 5 %, and values that appeared or went away on a rung already scored */
  moved: { rung: string; dim: Dim; from: number | null; to: number | null }[];
  /** every default threshold that moved, appeared or went away */
  barsMoved: { kind: Kind; difficulty: Difficulty; dim: Dim; from: number | null; to: number | null }[];
  /** shipped treat-likes dropped because their rung now has a value of its own on every dimension they lent */
  standInsDropped: string[];
}

const key = (s: Pick<Score, "rung" | "dim">) => `${s.rung} ${s.dim}`;

/** One value per rung and dimension, the one that outranks the others (spec 1.2 §4.3), in file order. */
function best(scores: Score[], now: number): Score[] {
  const out = new Map<string, Score>();
  for (const s of scores) {
    const had = out.get(key(s));
    if (!had || outranks(s, had, now)) out.set(key(s), s);
  }
  return [...out.values()].sort(
    (a, b) => a.rung.localeCompare(b.rung) || DIMS.indexOf(a.dim) - DIMS.indexOf(b.dim),
  );
}

/**
 * Spec 1.2 §5.2, §7: `catalog/scores.json` rebuilt from the keyless sources' answers. It keeps every hand-typed
 * value (one with no `source`), replaces the keyless values with what `raw` says now (Artificial Analysis is
 * never shipped, whatever `raw` holds), spreads every published value to the family's other efforts as
 * `adjacent` (plan 14 Ruling 3), keeps one value per rung and dimension, derives the default bars with their
 * `barsWhy`, and drops a shipped treat-like its rung no longer needs.
 */
export function rebuildShipped(
  raw: RawAnswers,
  ctx: { models: ModelsFile; scores: ScoresFile; sources: SourcesFile; now: number },
): { file: ScoresFile; report: RefreshReport } {
  const date = new Date(ctx.now).toISOString().slice(0, 10);
  const { "artificial-analysis": _aa, ...keyless } = raw;
  // hand-typed values, less the ones an earlier rebuild spread: those are spread again below
  const hand = ctx.scores.scores.filter((s) => s.source === undefined && s.confidence !== "adjacent");
  const synced = derive(keyless, { ...ctx, scores: { ...ctx.scores, scores: hand } }).scores.filter(
    (s) => s.source !== "artificial-analysis" && s.confidence !== "adjacent",
  );
  const direct = best([...hand, ...synced], ctx.now);
  // an inferred value is catherd's guess for its own rung only: it is never carried to another effort
  const spread = adjacent(
    ctx.models.families,
    direct.filter((s) => s.confidence !== "inferred"),
    new Set(),
    ctx.now,
  );
  const scores = best([...direct, ...spread], ctx.now);
  const benchmark = (d: Dim) => {
    const b = ctx.scores.benchmarks[d];
    return `${b.benchmark} ${b.version}`;
  };
  const { bars, barsWhy } = deriveBars(barPool(scores), benchmark, date);

  const draft: ScoresFile = { ...ctx.scores, version: date, scores, bars, barsWhy };
  const c = buildCatalog({ models: ctx.models, scores: { ...draft, treatLike: ctx.scores.treatLike } });
  const treatLike: ScoresFile["treatLike"] = {};
  const standInsDropped: string[] = [];
  for (const [rung, t] of Object.entries(ctx.scores.treatLike))
    if (scoresOf(c, rung)?.borrowed.length) treatLike[rung] = t;
    else standInsDropped.push(rung);
  const file: ScoresFile = { ...draft, treatLike };
  return { file, report: { date, ...diffShipped(ctx.scores, file), standInsDropped } };
}

const rungsOf = (f: ScoresFile) => new Set(f.scores.map((s) => s.rung));

/** What moved between two shipped files (spec 1.2 §7's PR body). */
function diffShipped(
  before: ScoresFile,
  after: ScoresFile,
): Pick<RefreshReport, "newlyScored" | "moved" | "barsMoved"> {
  const had = rungsOf(before);
  const newlyScored = [...rungsOf(after)].filter((r) => !had.has(r)).sort();
  const was = new Map(before.scores.map((s) => [key(s), s.value]));
  const now = new Map(after.scores.map((s) => [key(s), s.value]));
  const moved: RefreshReport["moved"] = [];
  for (const k of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const [rung, dim] = k.split(" ") as [string, Dim];
    if (newlyScored.includes(rung)) continue;
    const from = was.get(k) ?? null;
    const to = now.get(k) ?? null;
    const far =
      from === null || to === null || (from === 0 ? to !== 0 : Math.abs(to - from) / Math.abs(from) > MOVED);
    if (far) moved.push({ rung, dim, from, to });
  }
  const barsMoved: RefreshReport["barsMoved"] = [];
  for (const kind of KINDS)
    for (const difficulty of DIFFICULTIES)
      for (const dim of DIMS) {
        const from = before.bars[kind]?.[difficulty]?.[dim] ?? null;
        const to = after.bars[kind]?.[difficulty]?.[dim] ?? null;
        if (from !== to) barsMoved.push({ kind, difficulty, dim, from, to });
      }
  return { newlyScored, moved, barsMoved };
}

/** Whether the rebuilt file says anything new: its date and `barsWhy` wording alone never count. */
export function shippedChanged(before: ScoresFile, after: ScoresFile): boolean {
  // as the file reads back: no undefined fields, whatever the key order
  const strip = (f: ScoresFile): unknown => JSON.parse(JSON.stringify({ ...f, version: "", barsWhy: null }));
  return !isDeepStrictEqual(strip(before), strip(after));
}

const num = (v: number | null) => (v === null ? "none" : String(v));

/** Spec 1.2 §7: the refresh PR's body: rungs newly scored, values moved by more than 5 %, bars that moved. */
export function refreshBody(r: RefreshReport): string {
  const out = [
    `Weekly refresh of the shipped scores from the keyless public sources (data of ${r.date}).`,
    "",
    "Artificial Analysis values are never shipped. Merging this releases a patch through the Release workflow.",
    "",
    `### Rungs newly scored (${r.newlyScored.length})`,
    "",
    ...(r.newlyScored.length ? r.newlyScored.map((x) => `- \`${x}\``) : ["none"]),
    "",
    `### Values moved by more than 5 % (${r.moved.length})`,
    "",
    ...(r.moved.length
      ? ["| rung | dimension | was | now |", "| --- | --- | --- | --- |"].concat(
          r.moved.map((m) => `| \`${m.rung}\` | ${m.dim} | ${num(m.from)} | ${num(m.to)} |`),
        )
      : ["none"]),
    "",
    `### Bars that moved (${r.barsMoved.length})`,
    "",
    ...(r.barsMoved.length
      ? ["| kind | difficulty | dimension | was | now |", "| --- | --- | --- | --- | --- |"].concat(
          r.barsMoved.map(
            (b) => `| ${b.kind} | ${b.difficulty} | ${b.dim} | ${num(b.from)} | ${num(b.to)} |`,
          ),
        )
      : ["none"]),
  ];
  if (r.standInsDropped.length)
    out.push(
      "",
      "### Shipped stand-ins no longer needed",
      "",
      ...r.standInsDropped.map((x) => `- \`${x}\` now has values of its own`),
    );
  return `${out.join("\n")}\n`;
}

/**
 * Spec 1.2 §7, `scripts/catalog-refresh.ts`: syncs every keyless source now (no Artificial Analysis key, the
 * TTL ignored) into the current data folder, rebuilds the shipped file from the answers and, when it says
 * anything new, writes it to `out`. A keyless source that fails writes nothing: a refresh never ships a file
 * that lost a source's values (plan 14 Ruling 11).
 */
export async function refreshShipped(o: {
  out: string;
  current: ScoresFile;
  models: ModelsFile;
  sources: SourcesFile;
  transport?: SourceTransport;
  now?: () => number;
}): Promise<{ changed: boolean; failed: { source: string; error: string }[]; report: RefreshReport | null }> {
  const now = o.now ?? Date.now;
  const sync = await syncSources({ force: true, aaKey: null, transport: o.transport, now });
  if (sync.failed.length) return { changed: false, failed: sync.failed, report: null };
  const { file, report } = rebuildShipped(cachedAnswers(), {
    models: o.models,
    scores: o.current,
    sources: o.sources,
    now: now(),
  });
  const changed = shippedChanged(o.current, file);
  if (changed) writeFileSync(o.out, `${JSON.stringify(file, null, 2)}\n`);
  return { changed, failed: [], report };
}
````

Edit `src/services/source-derive.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/source-derive.ts b/src/services/source-derive.ts
index a19b426..e0fb987 100644
--- a/src/services/source-derive.ts
+++ b/src/services/source-derive.ts
@@ -1,3 +1,4 @@
+import { measuredOrBetter } from "../domain/bars.ts";
 import { calibrate, DIM_SOURCES, type FieldRef } from "../domain/calibration.ts";
 import {
   DIMS,
@@ -43,12 +44,6 @@ export interface DeriveContext {
 
 /** Spec 1.2 §3.5: a price that differs by more than this is a sync warning. */
 const PRICE_TOLERANCE = 0.1;
-/**
- * Plan 13 R18: dimensions whose fits are computed and recorded but give no synced value. Terminal's anchor
- * (Epoch's Terminal-Bench 2.0) is not the shipped values' unit (Terminal-Bench 4.0), so the shipped terminal
- * values stay authoritative until plan 14 moves terminal onto one unit.
- */
-const HELD_DIMS: ReadonlySet<Dim> = new Set(["terminal"]);
 /** Spec 1.2 §3.5: the models.dev provider that serves a backend key its own catalog. */
 const OPENCODE_KEYS = ["opencode", "opencode-go"] as const;
 
@@ -105,7 +100,7 @@ export function derive(raw: RawAnswers, ctx: DeriveContext): Derived {
   const scores: Score[] = [];
   const fits: FitRow[] = [];
   const push = (dim: Dim, f: FieldRef, k: Keyed, value: number, extra: Partial<Score>) => {
-    if (!k.family || HELD_DIMS.has(dim)) return;
+    if (!k.family) return;
     scores.push({
       rung: `${k.family.id}#${k.effort}`,
       dim,
@@ -125,8 +120,9 @@ export function derive(raw: RawAnswers, ctx: DeriveContext): Derived {
     let anchor: Map<string, number>;
     if (spec.anchor === "shipped") {
       anchor = new Map();
+      // the hand-typed values published for the rung; never the shipped keyless ones (they carry a source)
       for (const s of ctx.scores.scores)
-        if (s.dim === dim && s.confidence !== "inferred") {
+        if (s.dim === dim && s.source === undefined && measuredOrBetter(s)) {
           const { id, effort } = splitSourceRung(s.rung);
           anchor.set(`${map.key(id)}#${effort}`, s.value);
         }
@@ -182,12 +178,17 @@ export function derive(raw: RawAnswers, ctx: DeriveContext): Derived {
 }
 
 /**
- * Spec 1.2 §4.3 `adjacent`: for each family effort a dimension has no value at (neither a direct synced one
- * nor a shipped one above `inferred`, in `shipped` as `<family>#<effort>|<dim>`), the best synced value at the
- * nearest effort that has one (the weaker on a tie). The shipped values are not spread this way: the shipped
- * file already says which efforts it carries, and an adjacent value never overrides one it carries.
+ * Spec 1.2 §4.3 `adjacent`: for each family effort a dimension has no value at (neither one in `direct` nor
+ * one `shipped` names, as `<family>#<effort>|<dim>`), the best value in `direct` at the nearest effort that
+ * has one (the weaker on a tie). A sync spreads only its own values, and never onto a value the shipped file
+ * carries; `rebuildShipped` spreads the shipped file's published values, with an empty `shipped`.
  */
-function adjacent(families: Family[], direct: Score[], shipped: Set<string>, now: number): Score[] {
+export function adjacent(
+  families: Family[],
+  direct: Score[],
+  shipped: ReadonlySet<string>,
+  now: number,
+): Score[] {
   const out: Score[] = [];
   for (const f of families)
     for (const dim of DIMS) {
@@ -208,7 +209,7 @@ function adjacent(families: Family[], direct: Score[], shipped: Set<string>, now
           ...from,
           rung: `${f.id}#${e}`,
           confidence: "adjacent",
-          note: `${from.source} has it at ${near}; carried to this effort`,
+          note: `${from.source ?? from.benchmark} has it at ${near}; carried to this effort`,
         });
       }
     }
````

Edit `src/services/source-sync.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/source-sync.ts b/src/services/source-sync.ts
index 6f77597..0919052 100644
--- a/src/services/source-sync.ts
+++ b/src/services/source-sync.ts
@@ -110,8 +110,8 @@ async function takeLock(background: boolean): Promise<(() => void) | null> {
   }
 }
 
-/** Every cached answer, as `derive` reads them. */
-function cachedAnswers(): RawAnswers {
+/** Every cached answer, as `derive` reads them (and `scripts/catalog-refresh.ts` rebuilds the shipped file). */
+export function cachedAnswers(): RawAnswers {
   const raw: RawAnswers = {};
   for (const id of SOURCE_IDS) {
     const c = readCached(id);
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/services/catalog-refresh.test.ts test/services/source-derive.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add scripts/catalog-refresh.ts src/domain/calibration.ts src/services/catalog-refresh.ts src/services/source-derive.ts src/services/source-sync.ts test/services/catalog-refresh.test.ts test/services/source-derive.test.ts
git commit -m "feat(catalog): rebuild the shipped scores and bars from the keyless sources, with a refresh script"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 3: Ship the keyless sources' scores and the percentile bars, with ATTRIBUTION.md (spec 1.2 §5, §7; C-1, C-2, C-3; Rulings 1–4, 12)

The shipped `catalog/scores.json` becomes the refresh script's output of 2026-09-28 (C-1): the hand-typed values, the Arena and Epoch values with their source, date and confidence, every published value carried to its model's other efforts as `adjacent`, and the derived default bars with their `barsWhy`. `catalog/ATTRIBUTION.md` names each shipped source with its license and attribution line (it ships in the npm package: `catalog` is in `files`; `test/pack-smoke.ts` checks it and `sources.json`). `ScoresFileSchema` reads the new `barsWhy` map and `Catalog` carries it. Two domain rules follow the new bars: the worker-miss warning names only a kind none of whose bars the ladder clears (Ruling 12), and the failover ranker prefers the rung's own effort among ties (Ruling 4). Every test pinned to 1.1's values or bars is re-pinned to the new ones (each hunk says why); the recorded routing changes are Review Focus 1.

**Files:**

- Create: `catalog/ATTRIBUTION.md`
- Modify: `catalog/scores.json`
- Regenerate: `docs/tui-frames.md`
- Modify: `src/domain/catalog.ts`
- Modify: `src/domain/failover.ts`
- Modify: `src/domain/profile-rules.ts`
- Test: `test/domain/catalog.test.ts`
- Test: `test/domain/failover.test.ts`
- Test: `test/domain/profile-rules.test.ts`
- Test: `test/domain/select.test.ts`
- Test: `test/entry/catalog-command.test.ts`
- Regenerate: `test/entry/tui/__snapshots__/frames.test.tsx.snap`
- Test: `test/entry/tui/effects.test.ts`
- Test: `test/entry/tui/profile-tree.test.ts`
- Test: `test/entry/tui/profiles.test.tsx`
- Test: `test/integration/mcp-stdio.test.ts`
- Test: `test/pack-smoke.ts`
- Test: `test/services/catalog-service.test.ts`
- Test: `test/services/routing-service.test.ts`
- Test: `test/services/source-derive.test.ts`
- Test: `test/services/source-sync.test.ts`

**Interfaces:**
- Consumes: Task 2's output (already produced: do not run the script, C-1); Task 1's schema changes.
- Produces: `ScoresFileSchema.barsWhy` (`default({})`), `Catalog.barsWhy`; `rankStandIns` with the effort tie-break; `validateProfile`'s blind-kind warning text `no worker rung clears any bar for <kinds>; those lanes always start at the default rung`.

- [ ] **Step 1: Write the failing tests**

This task's tests are the old tests re-pinned to the shipped data of Step 3, and the new attribution test. Apply every test diff below first.

Edit `test/domain/catalog.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/domain/catalog.test.ts b/test/domain/catalog.test.ts
index d921450..dc8019f 100644
--- a/test/domain/catalog.test.ts
+++ b/test/domain/catalog.test.ts
@@ -1,4 +1,6 @@
 import { describe, expect, it } from "bun:test";
+import { readFileSync } from "node:fs";
+import { join } from "node:path";
 import {
   CONFIDENCE,
   capableFor,
@@ -11,6 +13,7 @@ import {
   type Score,
   scoresOf,
 } from "../../src/domain/catalog.ts";
+import { SourcesFileSchema } from "../../src/domain/sources.ts";
 import { shipped, shippedModels, shippedScores } from "./shipped.ts";
 
 describe("catalog/models.json", () => {
@@ -55,13 +58,20 @@ describe("catalog/models.json", () => {
 });
 
 describe("catalog/scores.json", () => {
-  it("sources every score on its dimension's benchmark, with a url, a date and a confidence", () => {
+  it("sources every hand-typed score on its dimension's benchmark, and every value with a url and a date", () => {
     const f = shippedScores();
+    const sources = new Set(["arena", "vectara", "epoch"]);
     for (const s of f.scores) {
       expect(DIMS).toContain(s.dim);
-      expect(s.benchmark).toBe(f.benchmarks[s.dim].benchmark);
-      expect(s.version).toBe(f.benchmarks[s.dim].version);
       expect(s.url.startsWith("https://")).toBe(true);
+      if (s.source === undefined) {
+        expect(s.benchmark).toBe(f.benchmarks[s.dim].benchmark);
+        expect(s.version).toBe(f.benchmarks[s.dim].version);
+      } else {
+        // spec 1.2 §7: a keyless source's value, dated; never Artificial Analysis
+        expect(sources.has(s.source)).toBe(true);
+        expect(s.version).toBe(s.date);
+      }
     }
   });
 
@@ -72,16 +82,42 @@ describe("catalog/scores.json", () => {
       const [model, effort] = s.rung.split("#");
       const fam = c.families.find((x) => x.id === model);
       expect(fam).toBeDefined();
-      const efforts = Object.values(fam?.on ?? {}).flatMap((b) => b.efforts);
+      // a backend that takes no effort flag runs the model at `default` (Haiku in Claude Code)
+      const efforts = Object.values(fam?.on ?? {}).flatMap((b) =>
+        b.efforts.length ? b.efforts : ["default"],
+      );
       expect(efforts).toContain(effort as string);
     }
     for (const t of Object.values(f.treatLike)) expect(c.scores[t.like]).toBeDefined();
   });
 
-  it("drops the mis-sourced 0.x Opus terminal seeds", () => {
+  it("names every source a shipped value comes from in ATTRIBUTION.md, with its license and attribution line", () => {
+    const text = readFileSync(join(import.meta.dir, "..", "..", "catalog", "ATTRIBUTION.md"), "utf8");
+    const sources = SourcesFileSchema.parse(
+      JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "catalog", "sources.json"), "utf8")),
+    ).sources;
+    const shippedFrom = new Set(shippedScores().scores.flatMap((s) => (s.source ? [s.source] : [])));
+    expect(shippedFrom.size).toBeGreaterThan(0);
+    for (const id of ["arena", "vectara", "epoch", ...shippedFrom]) {
+      const s = sources.find((x) => x.id === id);
+      expect(s?.keyed).toBe(false);
+      expect(text).toContain(`### ${s?.name}`);
+      expect(text).toContain(`- Attribution: ${s?.attribution}`);
+    }
+    expect(shippedFrom.has("artificial-analysis")).toBe(false);
+  });
+
+  it("keeps the vendors' Opus terminal values, and carries them to its other efforts as adjacent", () => {
     const c = shipped();
-    expect(c.scores["claude-opus-5-5#medium"]).toBeUndefined();
-    expect(c.scores["claude-opus-5-5#xhigh"]?.terminal?.value).toBe(66.4);
+    expect(c.scores["claude-opus-5-5#xhigh"]?.terminal).toMatchObject({
+      value: 66.4,
+      confidence: "verified",
+    });
+    expect(c.scores["claude-opus-5-5#medium"]?.terminal).toMatchObject({
+      value: 66.4,
+      confidence: "adjacent",
+      note: "Terminal-Bench has it at xhigh; carried to this effort",
+    });
   });
 });
 
@@ -129,7 +165,7 @@ describe("rungInfo", () => {
 describe("scores, treat-likes and the override", () => {
   it("borrows a treat-like's scores, and lets the user's treat-like and scores win", () => {
     const c = shipped();
-    expect(scoresOf(c, "claude-opus-5-5#high")?.via).toBe("claude-opus-5-5#xhigh");
+    expect(scoresOf(c, "opencode-go/kimi-k3#max")?.via).toBe("gpt-6-sol#medium");
     expect(scoresOf(c, "opencode-go/kimi-k3#default")).toBeNull();
     const o = OverrideSchema.parse({
       treatLike: { "opencode-go/kimi-k3#default": "gpt-6-sol#medium" },
@@ -151,8 +187,9 @@ describe("scores, treat-likes and the override", () => {
     expect(scoresOf(mine, "opencode-go/kimi-k3#default")?.values.repo_code).toBe(56.6);
     expect(mine.treatLike["opencode-go/kimi-k3#default"]?.source).toBe("user");
     expect(mine.scores["gpt-6-luna#high"]?.repo_code?.value).toBe(61);
-    expect(mine.bars.terminal.copy).toEqual({ honesty: 50 });
-    expect(mine.bars.terminal.build).toEqual({ honesty: 90 });
+    // spec 1.2 §5.2: the override sets its threshold, and the default's other thresholds stay
+    expect(mine.bars.terminal.copy).toEqual({ terminal: 40.15, honesty: 50 });
+    expect(mine.bars.terminal.build).toEqual({ terminal: 55.8 });
   });
 
   it("reads a 0.x override file (no schema) without losing its treat-likes", () => {
@@ -219,11 +256,10 @@ describe("confidence and precedence (spec 1.2 §4.3)", () => {
     expect(RANK.verified < RANK.secondary && RANK.secondary < RANK.inferred).toBe(true);
   });
 
-  it("adds agentic, steer and frontend with no shipped bar on them", () => {
+  it("adds agentic, steer and frontend, with no shipped bar on steer", () => {
     expect([...DIMS]).toEqual(["repo_code", "terminal", "honesty", "agentic", "steer", "frontend"]);
     for (const kind of Object.values(shipped().bars))
-      for (const bar of Object.values(kind))
-        for (const d of ["agentic", "steer", "frontend"]) expect(Object.keys(bar)).not.toContain(d);
+      for (const bar of Object.values(kind)) expect(Object.keys(bar)).not.toContain("steer");
   });
 
   it("keeps a better level, else the newer date, and drops a value older than 90 days one level", () => {
@@ -251,7 +287,8 @@ describe("confidence and precedence (spec 1.2 §4.3)", () => {
       score({ rung: "gpt-6-sol#high", dim: "repo_code", value: 70, confidence: "calibrated" }),
       // the shipped 68.8 is verified: a measured value does not
       score({ rung: "gpt-6-sol#max", dim: "repo_code", value: 50 }),
-      score({ rung: "gpt-6-sol#max", dim: "agentic", value: 0.08 }),
+      // the shipped Arena value is measured too, a day older: the newer one wins
+      score({ rung: "gpt-6-sol#max", dim: "agentic", value: 0.08, date: "2026-09-28" }),
     ];
     const c = shipped({ synced, now: NOW });
     expect(c.scores["gpt-6-sol#high"]?.repo_code?.value).toBe(70);
@@ -303,11 +340,14 @@ describe("confidence and precedence (spec 1.2 §4.3)", () => {
   });
 
   it("lends a treat-like's values only on the dimensions a rung has none of its own", () => {
-    const synced = [score({ rung: "claude-opus-5-5#high", dim: "agentic", value: 0.12 })];
-    const s = scoresOf(shipped({ synced, now: NOW }), "claude-opus-5-5#high");
-    expect(s?.values).toEqual({ terminal: 66.4, agentic: 0.12 });
-    expect(s?.via).toBe("claude-opus-5-5#xhigh");
-    expect(s?.borrowed).toEqual(["terminal"]);
+    // Kimi K3 borrows Sol medium's values through the shipped treat-like; a sync scores it on agentic only
+    const synced = [score({ rung: "opencode-go/kimi-k3#max", dim: "agentic", value: 0.12 })];
+    const c = shipped({ synced, now: NOW });
+    const s = scoresOf(c, "opencode-go/kimi-k3#max");
+    const sol = scoresOf(c, "gpt-6-sol#medium");
+    expect(s?.values).toEqual({ ...sol?.values, agentic: 0.12 });
+    expect(s?.via).toBe("gpt-6-sol#medium");
+    expect(s?.borrowed).toEqual(["repo_code", "terminal", "honesty", "steer", "frontend"]);
     expect(scoresOf(shipped(), "gpt-6-sol#max")?.borrowed).toEqual([]);
   });
 });
````

Edit `test/domain/failover.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/domain/failover.test.ts b/test/domain/failover.test.ts
index 9a13198..fb55229 100644
--- a/test/domain/failover.test.ts
+++ b/test/domain/failover.test.ts
@@ -18,12 +18,13 @@ const GO_LUNA = "opencode:opencode-go/gpt-6-luna#high";
 describe("the dims a rung's bars use (spec 1.1 §11)", () => {
   it("are the dims of every bar the rung clears", () => {
     const c = shipped();
-    // Luna high: repo_code 59.3, honesty 71.3 → clears the repo_code-only copy/build bars
-    expect(barDims(c, LUNA)).toEqual(["repo_code"]);
-    // Sol medium clears every bar, which use repo_code and honesty
-    expect(barDims(c, SOL("medium"))).toEqual(["repo_code", "honesty"]);
-    // Opus high borrows xhigh's terminal score only and clears no bar
-    expect(barDims(c, "claude-code:claude-opus-5-5#high")).toEqual([]);
+    // Luna high (repo_code 66.6 and frontend 1593, carried from max) clears the repo_code, prose and research
+    // copy and build bars and the ui copy bar
+    expect(barDims(c, LUNA)).toEqual(["repo_code", "frontend"]);
+    // Sol medium (repo_code 56.6, terminal 43 carried from max) clears the terminal copy bar only
+    expect(barDims(c, SOL("medium"))).toEqual(["terminal"]);
+    // Opus high carries max's and xhigh's values; with no honesty value it clears no Track B bar
+    expect(barDims(c, "claude-code:claude-opus-5-5#high")).toEqual(["repo_code", "terminal", "frontend"]);
     expect(barDims(c, "codex:not-a-model#high")).toEqual([]);
   });
 });
@@ -33,12 +34,13 @@ describe("downgradeDims", () => {
     const c = shipped();
     expect(downgradeDims(c, SOL("medium"), KIMI)).toEqual([]);
     expect(downgradeDims(c, SOL("xhigh"), KIMI)).toEqual(["repo_code"]);
-    expect(downgradeDims(c, SOL("high"), GO_LUNA)).toEqual(["repo_code", "honesty"]);
-    expect(downgradeDims(c, SOL("medium"), "claude-code:claude-opus-5-5#high")).toEqual([
+    expect(downgradeDims(c, SOL("high"), GO_LUNA)).toEqual(["terminal", "frontend"]);
+    expect(downgradeDims(c, SOL("medium"), "claude-code:claude-opus-5-5#high")).toEqual([]);
+    expect(downgradeDims(c, "claude-code:claude-opus-5-5#high", GO_LUNA)).toEqual([
       "repo_code",
-      "honesty",
+      "terminal",
+      "frontend",
     ]);
-    expect(downgradeDims(c, "claude-code:claude-opus-5-5#high", GO_LUNA)).toEqual([]);
   });
 });
 
@@ -49,20 +51,29 @@ describe("rankStandIns", () => {
       "codex:gpt-6-luna#max", // same quota as Luna high
       "opencode:opencode/gpt-6-luna#high", // Zen: metered
       "claude:claude-opus-5-5#high", // native: dispatch cannot start it
-      "claude-code:claude-opus-5-5#high", // no score on repo_code, the bar dim Luna high uses
-      "claude-code:claude-opus-5-5#max", // repo_code 74.2: fits, but on the Claude plan
-      "opencode:opencode-go/gpt-5.6-luna#max",
+      "claude-code:claude-opus-5-5#max", // repo_code 74.2, frontend 1827: fits, but on the Claude plan
+      "opencode:opencode-go/gpt-5.6-luna#max", // frontend 1520, below Luna high's 1593
       GO_LUNA,
       "opencode:opencode-go/nope#high", // unscored
     ];
     expect(rankStandIns(c, DEFAULT_BILLING, LUNA, pool)).toEqual([
       GO_LUNA,
-      "opencode:opencode-go/gpt-5.6-luna#max",
       "claude-code:claude-opus-5-5#max",
     ]);
     expect(rankStandIns(c, DEFAULT_BILLING, "not a rung", pool)).toEqual([]);
   });
 
+  it("prefers the effort nearest the rung's own among a model's efforts, which carry one another's values", () => {
+    const c = shipped();
+    const go = (e: string) => `opencode:opencode-go/gpt-6-luna#${e}`;
+    expect(rankStandIns(c, DEFAULT_BILLING, LUNA, [go("none"), go("max"), go("high"), go("low")])).toEqual([
+      go("high"),
+      go("low"), // two steps away, as max is: the cheaper first
+      go("max"),
+      go("none"),
+    ]);
+  });
+
   it("takes a Zen stand-in when the profile bills Zen on a subscription", () => {
     const c = shipped();
     const zen = "opencode:opencode/gpt-6-sol#high";
@@ -103,14 +114,17 @@ describe("catalogRungs", () => {
 });
 
 describe("DEFAULT_FAILOVER (spec 1.1 §11)", () => {
-  it("is, for each shipped worker rung, the best stand-in the shipped catalog offers, and none without one", () => {
+  it("gives each shipped worker rung a stand-in the shipped catalog accepts, never a Claude-billed one", () => {
     const c = shipped();
-    const expected: Record<string, string> = {};
-    for (const rung of new Set(BUILTIN_ROLES.worker.rungs)) {
-      const best = rankStandIns(c, DEFAULT_BILLING, rung, catalogRungs(c))[0];
-      if (best) expected[rung] = best;
+    // the ranker also accepts Opus (Claude-billed, carrying max's values) for Sol high and xhigh: the default
+    // leaves those without one, so a limit on them pauses the lane (spec 1.1 §11)
+    for (const [rung, standIn] of Object.entries(DEFAULT_FAILOVER)) {
+      expect(BUILTIN_ROLES.worker.rungs).toContain(rung);
+      expect(rankStandIns(c, DEFAULT_BILLING, rung, catalogRungs(c))).toContain(standIn);
+      expect(claudeBilled(standIn)).toBe(false);
     }
-    expect(DEFAULT_FAILOVER).toEqual(expected);
     expect(DEFAULT_FAILOVER).toEqual({ [LUNA]: GO_LUNA, [SOL("medium")]: KIMI });
+    for (const rung of Object.keys(DEFAULT_FAILOVER))
+      expect(rankStandIns(c, DEFAULT_BILLING, rung, catalogRungs(c))[0]).toBe(DEFAULT_FAILOVER[rung]);
   });
 });
````

Edit `test/domain/profile-rules.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/domain/profile-rules.test.ts b/test/domain/profile-rules.test.ts
index d22640d..fd03592 100644
--- a/test/domain/profile-rules.test.ts
+++ b/test/domain/profile-rules.test.ts
@@ -121,8 +121,8 @@ describe("validateProfile", () => {
     });
     expect(v.errors).toEqual([]);
     expect(messages(v.warnings)).toEqual([
+      "downgrade: opencode:opencode-go/kimi-k3#max stands in for codex:gpt-6-astra#high, scoring below it on repo_code, terminal, honesty, agentic, frontend",
       "codex:gpt-6-astra#high is on no enabled role's ladder, so this never runs",
-      "downgrade: claude:claude-opus-5-5#high stands in for codex:gpt-6-sol#high, scoring below it on repo_code, honesty",
       "stand-in claude:claude-opus-5-5#high is a native subagent: the orchestrator must start it, dispatch cannot",
     ]);
   });
@@ -149,24 +149,18 @@ describe("validateProfile", () => {
   });
 
   it("warns on a Claude rung that clears no routing bar on a ladder of several, never on a lone one", () => {
-    const worker = [
-      "codex:gpt-6-sol#medium",
-      "claude-code:claude-opus-5-5#high",
-      "claude:claude-opus-5-5#high",
-      "claude-code:claude-opus-5-5#max",
-    ];
+    // Haiku 4.5 has only a WebDev value (frontend 1338, from Epoch): it clears no bar; Opus clears several
+    const HAIKU = "claude-code:claude-haiku-4-5-20251001#default";
+    const worker = ["codex:gpt-6-sol#medium", HAIKU, "claude-code:claude-opus-5-5#max"];
     const v = check({ roles: { worker: { rungs: worker, defaultRung: null } } });
     expect(v.errors).toEqual([]);
-    expect(v.warnings.filter((w) => w.message.includes("clears no routing bar"))).toEqual(
-      ["claude-code:claude-opus-5-5#high", "claude:claude-opus-5-5#high"].map((rung) => ({
+    expect(v.warnings.filter((w) => w.message.includes("clears no routing bar"))).toEqual([
+      {
         path: "roles.worker.rungs",
-        message: `${rung} clears no routing bar, so a lane starts on it only as the role's default rung and never climbs onto it`,
-      })),
-    );
-    expect(check({ roles: { reviewer: { rungs: ["claude-code:claude-opus-5-5#high"] } } })).toEqual({
-      errors: [],
-      warnings: [],
-    });
+        message: `${HAIKU} clears no routing bar, so a lane starts on it only as the role's default rung and never climbs onto it`,
+      },
+    ]);
+    expect(check({ roles: { reviewer: { rungs: [HAIKU] } } })).toEqual({ errors: [], warnings: [] });
   });
 });
 
@@ -184,7 +178,8 @@ describe("validateProfile: failover and ladder warnings (spec 1.1 §11)", () =>
       {
         path: `failover.${XHIGH}`,
         message: `downgrade: ${KIMI} stands in for ${XHIGH}, scoring below it on repo_code`,
-        fix: `catherd profile set failover.${XHIGH} null`,
+        // Opus xhigh (repo_code 74.2 carried from max): the only stand-in with no downgrade, on the Claude plan
+        fix: `catherd profile set failover.${XHIGH} claude-code:claude-opus-5-5#xhigh`,
       },
     ]);
   });
@@ -222,7 +217,7 @@ describe("validateProfile: failover and ladder warnings (spec 1.1 §11)", () =>
     expect(v.errors).toEqual([]);
     expect(v.warnings).toContainEqual({
       path: "roles.worker.rungs",
-      message: `the ladder goes down at ${LUNA}: it scores below ${XHIGH} on repo_code, honesty`,
+      message: `the ladder goes down at ${LUNA}: it scores below ${XHIGH} on terminal, honesty, frontend`,
       fix: "order roles.worker.rungs weakest first",
     });
     // Luna high → Sol medium: lower on repo_code but higher on honesty, so not down (the default ladder)
@@ -231,14 +226,15 @@ describe("validateProfile: failover and ladder warnings (spec 1.1 §11)", () =>
 });
 
 describe("inferredScores", () => {
-  it("marks both of the default profile's Go stand-ins inferred, and Sol not", () => {
+  it("marks the default profile's Kimi stand-in inferred, and Go Luna and Sol not", () => {
     const c = shipped();
     expect(inferredScores(c, rungInfo(c, "opencode:opencode-go/kimi-k3#max"))).toEqual({
       inferred: true,
       via: "gpt-6-sol#medium",
     });
+    // Go Luna high carries Luna max's published values (adjacent): no longer only catherd's guesses
     expect(inferredScores(c, rungInfo(c, "opencode:opencode-go/gpt-6-luna#high"))).toEqual({
-      inferred: true,
+      inferred: false,
       via: null,
     });
     expect(inferredScores(c, rungInfo(c, "codex:gpt-6-sol#high")).inferred).toBe(false);
````

Edit `test/domain/select.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/domain/select.test.ts b/test/domain/select.test.ts
index 7755ab4..441a1c6 100644
--- a/test/domain/select.test.ts
+++ b/test/domain/select.test.ts
@@ -15,8 +15,13 @@ const LADDER = [
   "codex:gpt-6-sol#high",
   "codex:gpt-6-sol#xhigh",
 ];
-const TRACK_A = { rung: LADDER[0] as string, ladder: LADDER };
-const TRACK_B = { rung: LADDER[1] as string, ladder: LADDER.slice(1) };
+const [LUNA_HIGH, SOL_MEDIUM, SOL_HIGH, SOL_XHIGH] = LADDER as [string, string, string, string];
+/** Track A: Luna high (repo_code 66.6, carried from max) clears the 60.95 copy bar; Sol medium (56.6) does not */
+const TRACK_A = { rung: LUNA_HIGH, ladder: [LUNA_HIGH, SOL_HIGH, SOL_XHIGH] };
+/** the build bar is the median, 66.6: Luna high and Sol xhigh reach it */
+const BUILD = { rung: LUNA_HIGH, ladder: [LUNA_HIGH, SOL_XHIGH] };
+/** nothing clears: the default rung and every rung above it */
+const TRACK_B = { rung: SOL_MEDIUM, ladder: LADDER.slice(1) };
 
 /** Spec §7.2's default worker: the four Codex rungs, default sol#medium, the owner's billing. */
 const worker = (over: Partial<RoutingProfile> = {}, rungs = LADDER): RoutingProfile => ({
@@ -26,9 +31,17 @@ const worker = (over: Partial<RoutingProfile> = {}, rungs = LADDER): RoutingProf
   ...over,
 });
 
-/** Spec §5.2: the approved ladder, re-derived on the 2026-09-25 benchmarks. */
-const approved = (kind: Kind, d: Difficulty) =>
-  kind !== "terminal" && (d === "copy" || d === "build") ? TRACK_A : TRACK_B;
+/**
+ * Spec 1.2 §5: the default worker on the shipped bars of 2026-09-28. Sol reaches no Track B bar (agentic
+ * 0.0818 is below 0.08606, repo_code 66.6 below 67), so logic and hard lanes start at the default rung;
+ * terminal copy needs Terminal-Bench 40.15, which Sol clears (43, carried from max) and Luna (13) does not;
+ * ui build needs frontend 1617 and repo_code 66.6, which only Sol xhigh clears.
+ */
+const approved = (kind: Kind, d: Difficulty) => {
+  if (d === "logic" || d === "hard" || kind === "terminal") return TRACK_B;
+  if (kind === "ui" && d === "build") return { rung: SOL_XHIGH, ladder: [SOL_XHIGH] };
+  return d === "copy" ? TRACK_A : BUILD;
+};
 
 describe("the approved ladder: default worker on the shipped catalog", () => {
   for (const kind of KINDS)
@@ -42,7 +55,7 @@ describe("the approved ladder: default worker on the shipped catalog", () => {
   });
 
   it("holds with the rungs enabled in any order", () => {
-    expect(select(shipped(), worker({}, [...LADDER].reverse()), "worker", "repo_code", "build")).toEqual(
+    expect(select(shipped(), worker({}, [...LADDER].reverse()), "worker", "repo_code", "copy")).toEqual(
       TRACK_A,
     );
   });
@@ -148,21 +161,14 @@ describe("objective speed", () => {
   });
 
   it("starts fast but never climbs onto a weaker rung", () => {
-    const secs = { "gpt-6-sol#medium|repo_code": 200, "gpt-6-luna#high|repo_code": 500 };
+    const secs = { "gpt-6-sol#high|repo_code": 200, "gpt-6-luna#high|repo_code": 500 };
     const d = select(shipped({ secs }), worker({ objective: "speed" }), "worker", "repo_code", "copy");
-    expect(d).toEqual({
-      rung: "codex:gpt-6-sol#medium",
-      ladder: [
-        "codex:gpt-6-sol#medium",
-        "codex:gpt-6-luna#high",
-        "codex:gpt-6-sol#high",
-        "codex:gpt-6-sol#xhigh",
-      ],
-    });
+    // Sol high (65.3) starts; Luna high and Sol xhigh (66.6 each) are at least as strong, cheapest first
+    expect(d).toEqual({ rung: SOL_HIGH, ladder: [SOL_HIGH, LUNA_HIGH, SOL_XHIGH] });
   });
 
   it("keeps the approved pin under cost whatever the timings", () => {
-    const secs = { "gpt-6-sol#medium|*": 1, "gpt-6-luna#high|*": 9999 };
+    const secs = { "gpt-6-sol#high|*": 1, "gpt-6-luna#high|*": 9999 };
     expect(select(shipped({ secs }), worker(), "worker", "repo_code", "copy")).toEqual(TRACK_A);
   });
 });
````

Edit `test/entry/catalog-command.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/entry/catalog-command.test.ts b/test/entry/catalog-command.test.ts
index 85bc111..14a9f60 100644
--- a/test/entry/catalog-command.test.ts
+++ b/test/entry/catalog-command.test.ts
@@ -36,7 +36,7 @@ describe("catherd catalog", () => {
     withHome();
     const text = catherd("list", "--backend", "codex", "--text", "gpt-6-sol");
     expect(text.code).toBe(0);
-    expect(text.out).toContain("codex:gpt-6-sol  5/6 rungs scored  roles ");
+    expect(text.out).toContain("codex:gpt-6-sol  6/6 rungs scored  roles ");
     const json = JSON.parse(catherd("list", "--role", "artist", "--json").out);
     expect(json.models.every((m: { backend: string }) => m.backend === "codex")).toBe(true);
   });
````

Edit `test/entry/tui/effects.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/entry/tui/effects.test.ts b/test/entry/tui/effects.test.ts
index d77f31d..f0dd5f7 100644
--- a/test/entry/tui/effects.test.ts
+++ b/test/entry/tui/effects.test.ts
@@ -164,7 +164,7 @@ describe("the live effects", () => {
   it("saves the staged treat-likes and the patch through the services", async () => {
     withHome();
     const fx = liveEffects();
-    const rung = "opencode:opencode-go/gpt-6-luna#xhigh";
+    const rung = "opencode:opencode/claude-haiku-4-5#high";
     const r = await fx.save(
       "default",
       { roles: { writer: { rungs: [rung] } } },
@@ -174,7 +174,7 @@ describe("the live effects", () => {
     expect(fx.readProfile("default").roles?.writer?.rungs).toEqual([rung]);
     expect(fx.profiles()).toEqual({ names: ["default"], active: "default", here: "default", repo: null });
     const { catalog } = fx.catalog({});
-    expect(catalog.treatLike["gpt-6-luna#xhigh"]).toEqual({
+    expect(catalog.treatLike["claude-haiku-4-5#high"]).toEqual({
       like: "gpt-6-luna#high",
       source: "user",
     });
@@ -199,7 +199,7 @@ describe("the live effects", () => {
     const shown = fx.readProfile("default");
     // another process, while the save's treat-like waits for the catalog lock
     patchProfile("default", { budget: { minutes: 30 } });
-    const rung = "opencode:opencode-go/gpt-6-luna#xhigh";
+    const rung = "opencode:opencode/claude-haiku-4-5#high";
     const r = await fx.save(
       "default",
       { roles: { writer: { rungs: [rung] } } },
````

Edit `test/entry/tui/profile-tree.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/entry/tui/profile-tree.test.ts b/test/entry/tui/profile-tree.test.ts
index 70af53a..9f8fc27 100644
--- a/test/entry/tui/profile-tree.test.ts
+++ b/test/entry/tui/profile-tree.test.ts
@@ -108,9 +108,11 @@ describe("the Profiles tree (spec §9.1)", () => {
       ["max", false],
       ["ultra", false],
     ]);
+    // ultra carries max's published values (adjacent, spec 1.2 §4.3): scored, not dimmed
     expect(row(rows, "rung:worker:codex:gpt-6-sol#ultra")).toMatchObject({
-      value: "unscored · enter: treat like",
-      dim: true,
+      value: "",
+      dim: false,
+      action: { scored: true },
     });
   });
 
@@ -224,13 +226,13 @@ describe("edits", () => {
     expect(standIns[0]).toEqual({ value: "", title: "none", current: false });
     expect(standIns.some((o) => o.value.startsWith("codex:"))).toBe(false);
     expect(standIns.some((o) => o.value === "claude-code:claude-opus-5-5#xhigh")).toBe(true);
-    expect(standIns.find((o) => o.value === "claude-code:claude-opus-5-5#high")?.detail).toBe(
-      "scores borrowed from claude-opus-5-5#xhigh",
-    );
+    // Opus high has values of its own now (carried from xhigh and max): nothing borrowed
+    expect(standIns.find((o) => o.value === "claude-code:claude-opus-5-5#high")?.detail).toBe("");
     expect(standIns.find((o) => o.value === "claude-code:claude-opus-5-5#xhigh")?.detail).toBe("");
     expect(standIns.find((o) => o.value === "opencode:opencode-go/gpt-6-luna#high")?.detail).toBe("");
     const likes = treatLikeOptions(c);
     expect(likes.map((o) => o.value)).toContain("gpt-6-sol#medium");
-    expect(likes.map((o) => o.value)).not.toContain("claude-opus-5-5#high");
+    // a rung that borrows through a treat-like lends nothing of its own
+    expect(likes.map((o) => o.value)).not.toContain("opencode-go/kimi-k3#max");
   });
 });
````

Edit `test/entry/tui/profiles.test.tsx` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/entry/tui/profiles.test.tsx b/test/entry/tui/profiles.test.tsx
index 7d88faa..55990f6 100644
--- a/test/entry/tui/profiles.test.tsx
+++ b/test/entry/tui/profiles.test.tsx
@@ -12,6 +12,7 @@ import {
   useProfileDialogs,
 } from "../../../src/entry/tui/views/profile-actions.ts";
 import { ProfilesView } from "../../../src/entry/tui/views/profiles.tsx";
+import { writeDiscovery } from "../../../src/adapters/discovery.ts";
 import { saveTreatLike } from "../../../src/services/catalog-service.ts";
 import { snapshotEnv, withHome } from "../../helpers.ts";
 import { type Harness, harness } from "./harness.tsx";
@@ -36,11 +37,20 @@ afterEach(async () => {
   h = null;
 });
 
+/**
+ * An unscored rung: a model OpenCode Go lists that catherd has no family, and no stand-in, for (every shipped
+ * family's rung is scored, its own or carried from another effort, spec 1.2 §4.3).
+ */
+const GLM = "opencode:opencode-go/glm-5.3#high";
+
 async function profiles(
   setup: (fx: ReturnType<typeof fixtureEffects>) => void = () => {},
   effects: ReturnType<typeof fixtureEffects> = fixtureEffects(),
 ) {
   withHome();
+  writeDiscovery("opencode", [
+    { id: "opencode-go/glm-5.3", efforts: ["high"], context: 200000, imageIn: false },
+  ]);
   setup(effects);
   h = await harness(
     <Shell width={100} height={35}>
@@ -79,7 +89,7 @@ describe("the Profiles tab", () => {
     const lines = h!.s.frame().split("\n");
     const start = lines.findIndex((l) => l.includes("claude (native subagent)"));
     const group = lines.slice(start + 1, start + 5);
-    expect(group.at(-1)).toContain("claude-haiku-4-5-20251001");
+    expect(group.some((l) => l.includes("claude-haiku-4-5-20251001"))).toBe(true);
     expect(new Set(group.map((l) => l.search(/\d+ of \d+/))).size).toBe(1);
   });
 
@@ -94,18 +104,18 @@ describe("the Profiles tab", () => {
 
   it("maps an unscored rung with the treat-like picker, stages it, and saves both", async () => {
     const fx = await profiles();
-    await find("worker gpt-6-sol ultra");
+    await find("worker glm-5.3 high");
     await h!.s.press("space");
-    expect(h!.s.frame()).toContain("Treat codex:gpt-6-sol#ultra like…");
+    expect(h!.s.frame()).toContain(`Treat ${GLM} like…`);
     await h!.s.type("gpt-6-sol#xhigh");
     await h!.s.press("return");
     expect(h!.s.frame()).toContain("treated like gpt-6-sol#xhigh · unsaved");
     expect(h!.s.frame()).toContain("2 unsaved");
     await h!.s.press("ctrl+s");
-    expect(h!.s.frame()).toContain("treat codex:gpt-6-sol#ultra like gpt-6-sol#xhigh");
+    expect(h!.s.frame()).toContain(`treat ${GLM} like gpt-6-sol#xhigh`);
     await h!.s.press("return");
     expect(fx.writes).toHaveLength(1);
-    expect(fx.writes[0]).toContain('{"codex:gpt-6-sol#ultra":"gpt-6-sol#xhigh"}');
+    expect(fx.writes[0]).toContain(`{"${GLM}":"gpt-6-sol#xhigh"}`);
   });
 
   it("picks a failover stand-in on another quota, marked inferred when it is", async () => {
@@ -122,16 +132,16 @@ describe("the Profiles tab", () => {
   it("offers a rung made usable by a staged treat-like as a failover stand-in", async () => {
     await profiles();
     // an unscored rung on another quota than luna's (a stand-in never shares the quota it stands in for)
-    await find("worker claude-code sonnet low");
+    await find("worker glm-5.3 high");
     await h!.s.press("space");
-    expect(h!.s.frame()).toContain("Treat claude-code:claude-sonnet-5#low like…");
+    expect(h!.s.frame()).toContain(`Treat ${GLM} like…`);
     await h!.s.type("gpt-6-sol#xhigh");
     await h!.s.press("return", "escape");
     await find("failover luna");
     await h!.s.press("return");
     expect(h!.s.frame()).toContain("Stand-in for codex:gpt-6-luna#high");
-    await h!.s.type("sonnet-5#low");
-    expect(h!.s.frame()).toContain("claude-sonnet-5#low");
+    await h!.s.type("glm-5.3#high");
+    expect(h!.s.frame()).toContain("glm-5.3#high");
     expect(h!.s.frame()).not.toContain("No match");
   });
 
@@ -308,33 +318,29 @@ describe("the Profiles tab", () => {
   });
 
   it("unticks a ticked rung that has become unscored, without the treat-like picker", async () => {
-    const ultra = "codex:gpt-6-sol#ultra";
+    const glm = GLM;
     await profiles((f) => {
       const read = f.readProfile;
       f.readProfile = (n) => {
         const doc = read(n);
         const rungs = resolveProfile(doc, n).roles.worker.rungs;
-        return applyPatch(doc, { roles: { worker: { rungs: [...rungs, ultra] } } });
+        return applyPatch(doc, { roles: { worker: { rungs: [...rungs, glm] } } });
       };
     });
-    await find("worker gpt-6-sol ultra");
+    await find("worker glm-5.3 high");
     await h!.s.press("space");
-    expect(h!.s.frame()).not.toContain("Treat codex:gpt-6-sol#ultra like…");
+    expect(h!.s.frame()).not.toContain(`Treat ${GLM} like…`);
     expect(h!.s.frame()).toContain("1 unsaved");
-    expect(h!.app().getState().drafts.default?.doc.roles?.worker?.rungs).not.toContain(ultra);
+    expect(h!.app().getState().drafts.default?.doc.roles?.worker?.rungs).not.toContain(glm);
   });
 
   it("shows a treat-like saved alone (the profile unchanged) as saved, from the catalog read again", async () => {
-    const ultra = "codex:gpt-6-sol#ultra";
+    const glm = GLM;
     const fx = await profiles((f) => {
-      // the profile already ticks ultra, saved while it was treated like a rung (the fixture's save is
+      // the profile already ticks glm, saved while it was treated like a rung (the fixture's save is
       // synchronous up to its write), and reads back as a new object, as a file read does
       const rungs = resolveProfile(defaultProfileDoc(), "default").roles.worker.rungs;
-      void f.save(
-        "default",
-        { roles: { worker: { rungs: [...rungs, ultra] } } },
-        { [ultra]: "gpt-6-sol#xhigh" },
-      );
+      void f.save("default", { roles: { worker: { rungs: [...rungs, glm] } } }, { [glm]: "gpt-6-sol#xhigh" });
       f.writes.length = 0;
       const read = f.readProfile;
       f.readProfile = (n) => structuredClone(read(n));
@@ -345,7 +351,7 @@ describe("the Profiles tab", () => {
         return r;
       };
     });
-    await find("worker gpt-6-sol ultra");
+    await find("worker glm-5.3 high");
     // enter unticks the unscored rung; enter again maps it, ticking it back: only the treat-like is staged
     await h!.s.press("return", "return");
     await h!.s.type("gpt-6-sol#xhigh");
@@ -358,12 +364,12 @@ describe("the Profiles tab", () => {
     // scored through the saved treat-like, not "unscored" from the catalog read before the save
     expect(h!.s.frame()).not.toContain("unsaved");
     expect(h!.s.frame()).not.toContain("unscored");
-    expect(h!.s.frame()).toMatch(/\[x\] ultra +inferred/);
+    expect(h!.s.frame()).toMatch(/\[x\] high +inferred/);
   });
 
   it("takes back a picked treat-like and the tick it brought in one undo", async () => {
     await profiles();
-    await find("worker gpt-6-sol ultra");
+    await find("worker glm-5.3 high");
     await h!.s.press("space");
     await h!.s.type("gpt-6-sol#xhigh");
     await h!.s.press("return");
@@ -436,11 +442,11 @@ describe("the Profiles tab", () => {
 
   it("writes nothing when the profile changes on disk while a staged treat-like is saved, and asks again", async () => {
     const fx = await profiles();
-    await find("worker gpt-6-sol ultra");
+    await find("worker glm-5.3 high");
     await h!.s.press("space");
     await h!.s.type("gpt-6-sol#xhigh");
     await h!.s.press("return", "ctrl+s");
-    expect(h!.s.frame()).toContain("treat codex:gpt-6-sol#ultra like gpt-6-sol#xhigh");
+    expect(h!.s.frame()).toContain(`treat ${GLM} like gpt-6-sol#xhigh`);
     // another process writes the rungs while the treat-like waits for the catalog lock
     const theirs = ["codex:gpt-6-luna#high", "codex:gpt-6-sol#medium"];
     const save = fx.save;
@@ -464,8 +470,8 @@ describe("the Profiles tab", () => {
     expect(h!.s.frame()).toContain("[ Save ]");
     await h!.s.press("return");
     expect(fx.writes).toHaveLength(1);
-    expect(fx.writes[0]).toContain('{"codex:gpt-6-sol#ultra":"gpt-6-sol#xhigh"}');
-    expect(fx.readProfile("default").roles?.worker?.rungs).toContain("codex:gpt-6-sol#ultra");
+    expect(fx.writes[0]).toContain(`{"${GLM}":"gpt-6-sol#xhigh"}`);
+    expect(fx.readProfile("default").roles?.worker?.rungs).toContain(GLM);
     expect(h!.app().getState().dialogs).toEqual([]);
   });
````

Edit `test/integration/mcp-stdio.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/integration/mcp-stdio.test.ts b/test/integration/mcp-stdio.test.ts
index 3ed504c..ca7578f 100644
--- a/test/integration/mcp-stdio.test.ts
+++ b/test/integration/mcp-stdio.test.ts
@@ -206,7 +206,8 @@ describe("catherd mcp over stdio, on the Codex simulator", () => {
       expect(refused.record).toMatchObject({ status: "ok", replyStatus: "refused" });
       expect(refused.hints).toContain("climb: refused");
       const climbed = await call(c, "climb", { run, lane: "M1.L1", reason: "refused" });
-      expect(climbed.data).toMatchObject({ rung: "codex:gpt-6-sol#medium", top: false });
+      // the build ladder is Luna high, then Sol xhigh (spec 1.2 §5.2: the median DeepSWE bar, 66.6)
+      expect(climbed.data).toMatchObject({ rung: "codex:gpt-6-sol#xhigh", top: false });
 
       // failover: Sol medium hits a usage limit; its stand-in Sol high finishes the lane.
       writeProfile({ failover: { "codex:gpt-6-sol#medium": "codex:gpt-6-sol#high" } });
@@ -336,7 +337,8 @@ describe("push over stdio (spec §15)", () => {
         sim.rewrite({
           byRung: {
             "gpt-6-luna#high": { reply: "A done.\nSTATUS: complete — a", holdUntil: a },
-            "gpt-6-sol#medium": { reply: "B done.\nSTATUS: complete — b", holdUntil: b },
+            // Sol xhigh: on the build ladder (Luna high, Sol xhigh) the lanes are routed on
+            "gpt-6-sol#xhigh": { reply: "B done.\nSTATUS: complete — b", holdUntil: b },
           },
         });
         const base = { run, role: "worker", brief: "b" };
@@ -350,7 +352,7 @@ describe("push over stdio (spec §15)", () => {
           ...base,
           name: "worker-M1.L2",
           lane: "M1.L2",
-          rung: "codex:gpt-6-sol#medium",
+          rung: "codex:gpt-6-sol#xhigh",
         });
         writeFileSync(a as string, "");
         // the client keeps working while the first notice is on its way
````

Edit `test/pack-smoke.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/pack-smoke.ts b/test/pack-smoke.ts
index caf848a..3a01b17 100644
--- a/test/pack-smoke.ts
+++ b/test/pack-smoke.ts
@@ -23,6 +23,8 @@ const SHIPPED = [
   "catalog/models.json",
   "catalog/scores.json",
   "catalog/jev.json",
+  "catalog/sources.json",
+  "catalog/ATTRIBUTION.md",
   "plugin/.claude-plugin/plugin.json",
   "plugin/.mcp.json",
   "plugin/bin/catherd-mcp",
````

Edit `test/services/catalog-service.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/catalog-service.test.ts b/test/services/catalog-service.test.ts
index f914dc3..09f9528 100644
--- a/test/services/catalog-service.test.ts
+++ b/test/services/catalog-service.test.ts
@@ -78,7 +78,12 @@ describe("loadCatalog", () => {
       );
     expect(await code(saveTreatLike("a/b#high", "opencode-go/kimi-k3#default"))).toBe("E_CONFIG_INVALID");
     expect(await code(saveTreatLike("gpt-6-sol#high", "gpt-6-sol#high"))).toBe("E_CONFIG_INVALID");
-    expect(await code(saveTreatLike("claude-opus-5-5#high", "claude-opus-5-5#xhigh"))).toBe("ok");
+    // Opus high carries every value Opus xhigh has (adjacent): mapping it there would change nothing
+    expect(await code(saveTreatLike("claude-opus-5-5#high", "claude-opus-5-5#xhigh"))).toBe(
+      "E_CONFIG_INVALID",
+    );
+    // Sol high lends honesty, which Opus has no value for
+    expect(await code(saveTreatLike("claude-opus-5-5#high", "gpt-6-sol#high"))).toBe("ok");
   });
 
   it("saves a backend's own model id under its family's canonical rung, the key routing looks up", async () => {
@@ -142,7 +147,8 @@ describe("loadCatalog", () => {
       (r) => r.rung === "claude-code:claude-sonnet-5#high",
     );
     expect(row?.scores.agentic?.confidence).toBe("measured");
-    expect(row?.scores.repo_code?.confidence).toBe("inferred");
+    // Sonnet has no honesty value: Sol high lends it
+    expect(row?.scores.honesty?.confidence).toBe("inferred");
   });
 
   it("turns a corrupt override into E_CONFIG_INVALID with a fix", () => {
@@ -526,12 +532,16 @@ describe("catalogQuery", () => {
       scores: { repo_code: { value: 65.3, benchmark: "DeepSWE 1.1", confidence: "secondary" } },
       cost: { tier: 0, mode: "chatgpt-plan" },
     });
-    expect(sol?.rungs.find((r) => r.rung === "codex:gpt-6-sol#ultra")?.enabled).toBe(false);
+    // ultra carries max's published values (spec 1.2 §4.3 adjacent)
+    expect(sol?.rungs.find((r) => r.rung === "codex:gpt-6-sol#ultra")).toMatchObject({
+      enabled: true,
+      scores: { repo_code: { value: 68.8, confidence: "adjacent" } },
+    });
     expect(sol?.roles).toContain("artist");
     expect(q({ backend: "claude", text: "opus" }).models[0]?.rungs[2]).toMatchObject({
       rung: "claude:claude-opus-5-5#high",
-      treatLike: { like: "claude-opus-5-5#xhigh", source: "shipped" },
-      scores: { terminal: { value: 66.4, confidence: "inferred" } },
+      treatLike: null,
+      scores: { terminal: { value: 66.4, confidence: "adjacent" } },
     });
     expect(q({ backend: "opencode-go" }).models.map((m) => m.model)).toEqual([
       "opencode-go/gpt-5.6-luna",
````

Edit `test/services/routing-service.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/routing-service.test.ts b/test/services/routing-service.test.ts
index 1a915d3..585a4c3 100644
--- a/test/services/routing-service.test.ts
+++ b/test/services/routing-service.test.ts
@@ -27,7 +27,10 @@ beforeEach(() => {
 
 const fx = (n: string): unknown =>
   JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "jev", n), "utf8"));
-const TRACK_A = { rung: LADDER[0] as string, ladder: LADDER };
+// spec 1.2 §5: build lanes need DeepSWE 66.6 (the median), which Luna high (carried from max) and Sol xhigh
+// clear; copy needs 60.95, which Sol high clears too; no Sol rung clears a logic or hard bar
+const TRACK_A = { rung: LADDER[0] as string, ladder: [LADDER[0] as string, LADDER[3] as string] };
+const COPY = { rung: LADDER[0] as string, ladder: [LADDER[0], LADDER[2], LADDER[3]] as string[] };
 const TRACK_B = { rung: LADDER[1] as string, ladder: LADDER.slice(1) };
 const noWait = { sleep: async () => {}, random: () => 0.5 };
 
@@ -183,8 +186,8 @@ describe("route with Jev", () => {
     const f = fakeFetch({ status: 200, body: fx("route-v2-kind-only.json") });
     const r = req(lane("prose", null));
     const a = await routingService({ key: "k", fetchImpl: f.impl, ...noWait }).route(r);
-    // the default rung, gpt-6-sol#medium, clears repo_code up to hard
-    expect(a).toMatchObject({ ...TRACK_B, source: "jev-kind", kind: "repo_code", difficulty: "hard" });
+    // the default rung, gpt-6-sol#medium, clears no repo_code bar: the default difficulty is build
+    expect(a).toMatchObject({ ...TRACK_A, source: "jev-kind", kind: "repo_code", difficulty: "build" });
     expect(jevRows(r.runDir)[0]?.source).toBe("jev-kind");
   });
 
@@ -248,7 +251,12 @@ describe("route and discovery", () => {
     registerAdapter({ ...codex, listModels: () => (calls++, new Promise(() => {})) });
     const a = await routingService({ discoveryBudgetMs: 5 }).route(req(lane("repo_code", "build")));
     expect(calls).toBe(1);
-    expect(a).toMatchObject({ ...TRACK_B, source: "lane" });
+    // without Luna, only Sol xhigh clears the build bar
+    expect(a).toMatchObject({
+      rung: "codex:gpt-6-sol#xhigh",
+      ladder: ["codex:gpt-6-sol#xhigh"],
+      source: "lane",
+    });
     expect(a.ladder).not.toContain("codex:gpt-6-luna#high");
   });
 });
@@ -305,7 +313,7 @@ describe("route and the profile", () => {
   it("keeps the approved ladder through the default profile the profile service serves", async () => {
     const profile = profileService().forRepo(null);
     const r = routingService();
-    expect(await r.route(req(lane("repo_code", "copy"), { profile }))).toMatchObject(TRACK_A);
+    expect(await r.route(req(lane("repo_code", "copy"), { profile }))).toMatchObject(COPY);
     expect(await r.route(req(lane("terminal", "build"), { profile }))).toMatchObject(TRACK_B);
     expect(await r.route(req(lane("prose", "hard"), { profile }))).toMatchObject(TRACK_B);
   });
````

Edit `test/services/source-derive.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/source-derive.test.ts b/test/services/source-derive.test.ts
index ab5d281..3f9f389 100644
--- a/test/services/source-derive.test.ts
+++ b/test/services/source-derive.test.ts
@@ -143,7 +143,10 @@ describe("anchors and calibration (spec 1.2 §4.1, §4.2)", () => {
 
 describe("adjacent values (spec 1.2 §4.3)", () => {
   it("carries a family's synced value to its other efforts, from the nearest effort", () => {
-    const d = keyless();
+    // over the hand-typed values alone: the shipped file carries the keyless values spread already
+    const c = shippedContext(NOW);
+    const hand = c.scores.scores.filter((s) => s.source === undefined && s.confidence !== "adjacent");
+    const d = derive(rawAnswers(AT), { ...c, scores: { ...c.scores, scores: hand } });
     expect(find(d, "claude-opus-5-5#max", "agentic", "adjacent")).toEqual([
       expect.objectContaining({
         value: 0.1215,
````

Edit `test/services/source-sync.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/source-sync.test.ts b/test/services/source-sync.test.ts
index 2db7056..2b1c8ed 100644
--- a/test/services/source-sync.test.ts
+++ b/test/services/source-sync.test.ts
@@ -12,6 +12,7 @@ import {
   tryLockSync,
 } from "../../src/infra/sources/cache.ts";
 import { AA_MODELS_URL } from "../../src/infra/sources/artificial-analysis.ts";
+import { arenaUrl } from "../../src/infra/sources/arena.ts";
 import { MODELS_DEV_URL } from "../../src/infra/sources/models-dev.ts";
 import { VECTARA_URL } from "../../src/infra/sources/vectara.ts";
 import {
@@ -43,6 +44,24 @@ function clock(start = T0) {
     }),
   };
 }
+/** The recorded answers, with an Arena agent row for GPT-6 Luna (High), which the recording lacks. */
+function withLunaAgent(): typeof fetch {
+  const base = recordedFetch().impl;
+  return (async (input: RequestInfo | URL) => {
+    const res = await base(input);
+    if (String(input) !== arenaUrl("agent")) return res;
+    const body = (await res.json()) as { rows: { row: Record<string, unknown> }[] };
+    const row = {
+      ...body.rows[0]?.row,
+      model_name: "GPT 6 Luna (High)",
+      organization: "openai",
+      score: 0.03,
+    };
+    body.rows.push({ row });
+    return new Response(JSON.stringify(body), { status: 200 });
+  }) as typeof fetch;
+}
+
 const KEYLESS: SourceId[] = [
   "models-dev",
   "openrouter-models",
@@ -72,14 +91,17 @@ describe("the sync (spec 1.2 §3.2, §3.3)", () => {
     expect(r.unmatched.vectara).toEqual(["antgroup/finix_s1_32b", "google/gemini-2.5-pro", "openai/gpt-5.5"]);
   });
 
-  it("reports the rungs newly scored, and routing reads them at once", async () => {
+  it("reports no rung newly scored when the shipped file carries the sources, and routes on a new value at once", async () => {
     withHome();
     const c = clock();
-    const r = await syncSources({ transport: c.transport(recordedFetch().impl), now: c.now, aaKey: null });
-    // Opus 5.5 high had only a shipped treat-like; Arena scores it on its own
-    expect(r.newlyScored).toContain("claude-opus-5-5#high");
-    expect(r.newlyScored).not.toContain("gpt-6-sol#max");
-    expect(loadCatalog({ timings: false }).scores["claude-opus-5-5#high"]?.agentic?.value).toBe(0.1215);
+    // GPT-6 Luna has no Arena agent row in the recorded answers: this one gives Luna high its first agentic value
+    const r = await syncSources({ transport: c.transport(withLunaAgent()), now: c.now, aaKey: null });
+    expect(r.newlyScored).toEqual([]);
+    expect(loadCatalog({ timings: false }).scores["gpt-6-luna#high"]?.agentic).toMatchObject({
+      value: 0.03,
+      confidence: "measured",
+      source: "arena",
+    });
   });
 
   it("fetches a source only when its answer is older than 12 hours, unless forced", async () => {
@@ -183,7 +205,7 @@ describe("the sync (spec 1.2 §3.2, §3.3)", () => {
 
   it("says when the user's stand-in is no longer needed, and never removes it", async () => {
     withHome();
-    // Sol high borrows agentic from a rung only the user scored: Arena's Sol max values cover it after a sync
+    // Luna high borrows agentic from a rung only the user scored; an Arena row for it covers that after a sync
     mkdirSync(dirname(overridePath()), { recursive: true });
     writeFileSync(
       overridePath(),
@@ -203,11 +225,11 @@ describe("the sync (spec 1.2 §3.2, §3.3)", () => {
         ],
       }),
     );
-    await saveTreatLike("gpt-6-sol#high", "yardstick#high");
+    await saveTreatLike("gpt-6-luna#high", "yardstick#high");
     const c = clock();
-    const r = await syncSources({ transport: c.transport(recordedFetch().impl), now: c.now, aaKey: null });
-    expect(r.noLongerNeeded).toEqual([{ rung: "gpt-6-sol#high", like: "yardstick#high" }]);
-    expect(loadCatalog({ timings: false }).treatLike["gpt-6-sol#high"]).toEqual({
+    const r = await syncSources({ transport: c.transport(withLunaAgent()), now: c.now, aaKey: null });
+    expect(r.noLongerNeeded).toEqual([{ rung: "gpt-6-luna#high", like: "yardstick#high" }]);
+    expect(loadCatalog({ timings: false }).treatLike["gpt-6-luna#high"]).toEqual({
       like: "yardstick#high",
       source: "user",
     });
@@ -247,12 +269,16 @@ describe("the shipped values after a sync (plan 13 R7, R18)", () => {
       value: 37.2,
       confidence: "secondary",
     });
-    // Sol none has no shipped or direct value: it takes Sol max's
-    expect(adj("gpt-6-sol#none")).toHaveLength(1);
-    expect(loadCatalog({ timings: false }).scores["gpt-6-sol#none"]?.repo_code?.confidence).toBe("adjacent");
+    // Sol none carries Sol low's DeepSWE value in the shipped file (plan 14): a sync spreads nothing over it
+    expect(adj("gpt-6-sol#none")).toEqual([]);
+    expect(loadCatalog({ timings: false }).scores["gpt-6-sol#none"]?.repo_code).toMatchObject({
+      value: 37.2,
+      confidence: "adjacent",
+      note: "DeepSWE has it at low; carried to this effort",
+    });
   });
 
-  it("keep terminal: a sync scores no rung on it until plan 14 moves it onto one unit (plan 13 R18)", async () => {
+  it("keep terminal: Epoch's Terminal-Bench 2.0 shares no rung with the shipped 4.0 anchor (plan 14 C-2)", async () => {
     withHome();
     const shipped = buildCatalog({ models: shippedModels(), scores: shippedScores() });
     const c = clock();
````

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/domain test/services test/entry test/integration`
Expected: FAIL — the attribution test (`catalog/ATTRIBUTION.md` does not exist) and every test re-pinned to 1.2's values and bars, since `scores.json` is still 1.1's (on the scratch build, 88 tests failed the other way round: 1.1's tests on 1.2's file).

- [ ] **Step 3: Implement**

Write `catalog/scores.json` exactly as the scratch build shipped it (the refresh script's output of 2026-09-28, oxfmt-formatted; 106,549 bytes). Either copy it from the scratch branch (`git show a47d5fc:catalog/scores.json > catalog/scores.json`), or decode it from this gzip+base64 blob:

````bash
base64 -d <<'EOF' | gunzip > catalog/scores.json
H4sIAAAAAAACA+1dW4+bSBp9z68oebTaRDI0YG7OPGUy0WiklWalRMrDarXCUG6zweAF3E0ryn/fArttnDa0y+ZSNuclM22gCs4p
vnOq6qvi+xtCRom7oEtn9J6o4/zPBxonfhSyv0eaopmSMpU0e1QcmtHQXSyd+FvCjn5nv7DfYrqK/uNGHt39VD4xL+V3Slefv34q
iiiOlmpQZXVU/Pxjc3SU0njph05QWdqX7QnSb/mvRwvVZeWw0EUU0iR9qizzrxUNP/xJfoujbzQkn6kTuwvyJYqCMVEVhbD61glJ
F5TMHT9Yx5TETkqPVv3HP79IJkmekpQuievEHnFWrHDPz4iqyqasy9rhrTn3NEx9t/LWPsQ0dEhx1piENCX+chVHD3TJfjh6BwG7
kl0iOf5dQB2PxrOI3YbkOamT0PSwcnaXND6lalKc6cz8wGcwXlrtPI7ClIHySs1f6ex3+pBj7Yf351f6Zlsxa+dRTPOW+6/iwK7q
eM2KZ6W5gbP2qDR3ZgGVDEn9ZeHflxqY5y/zs3YNdH9DTrDOW79hyPb4kja7+30d5+1/tEjTVfL+7u7x8VFyvVB2wnQRRyvfld1o
eTd31ZmuW6rl2obnKqY9c82ZYyiarqnT6cRWpro51Wfe3cfiuf6mKX+t1gn7jyEb7N/PRRtl//ORQSavvHnpSfPWXX79tf0xNwrn
vsceozjD8f7ruActMYw21x4+Mlk4CfFT4qRk6WS/5m9G7FOPpBF7rfyE0Pk8ig9byZn0PL9PL9hRZHVi6+NmXrIdMlYlaYv1/T1r
t3OGD6Prbtsmk7tX2mw1CdbpJCTROt4ey+t6yU7xc3ekbOLMEUoUe6KNLw8+oIOLjl38fcGIahmqrNumPb4oLu9AMrrjw7gKPoLo
EYoirKIcYweCIt4bAz0RiQ3ISW90sJJe0LHvkL/gw7TkioD1Wh+9CndWTw57QGlaSMgsiO7vPFZY8kilB1WVyqjn4N6dg7kfzmkc
U+8ItMSQ0th3ArKkTkhYU1wShySUXe858RPZcMMQZrCHzpImJIyagxrKXSKJPYA/Zy26AVwHqLms+Sbrgyb+c1i5HNZByWYXgA5L
+RpHlHr+eomgKmx3qIIg9Ih6Nn3HaUGnSDBC0C/qjZEMUzdCK0uGuZureWugK2LxAVnpmJCF439bS7pk/OLRubMOUh5KJhNLNmzF
Ok7JlowNM28/rSIWbz/8+a6eFruSluLJ5UPwa0C3q0B3ncCf5TkuR/t6NL/N/YENkh+SZM18EDuexmu6Ozj301KWR00xxbk0yAsY
PdKZRx/Kh5wi4ExNwzBN3VAsU7ENwyidMMtFnAmxPjGmumVMrall6KXjsbYpwVCnuj6Z6Kplm7qmlc7IMTbV7d8/TmkXEdNk9p4a
xydZa4ZhLV3Wmh2GvUabsX3WBl/UekKq3Z9pVg2Lw/3t2SnUqEV+6tyfphoY9D0P1kr7puoGxnz58azRelszZWtSpfWwXxdGjWNz
z1DZ/lSWL5cJItuxyPImM92oxjYQwdrlZEgCLTwZUPe+1J0zlWlI6r7LrHnBxgNrqlEsMUzHmwSoaE4MUiREJeRteRmSLU/eXU5I
jbzrSHg6G1bIcr9KwJUsBVnunoxhyXLDwxgV6QkQ1/66ztypb+g9d9x7PiP3DUrdgThw5r5BrHvhA93ovrrRGSajBdP6DLPR5w9w
bColH1nTJZI0Y6/NuHKAw3jXBDFQ+H4VJRv8LPYV0AF971jfkyhkYeWMXDOj4QW/27W9cg6nu44faJ5uKLoW16NXE/EV3daQeHQe
rNV545auI/OIH9CaoGtMbHmq1qfjD3IQdIcoZ/IQwuZr4A0waopgzGo5GVTIFZ6NYcVroejgTCYRNtpzpRjUPj3CtXgtEuFaJDYQ
rvujgztDAf78BPwQ84Vs1gj7ghGCyN8bIxnGs5uHD3FfxEaNsC8WH4j6nRFyv2I0yKYUrEOHewbTtIYc8V+H7vnjRi+A09SqJTnd
fu+omohVED3l+pI4c5o+yRG70vGLrKT8sU3JSdLYuUuo+/65VPZSBwUWzRJ2FiDd0Fsp5hJTDsVCQtLxYJW1Ga2qpVy1kY7UMRl1
Oq5OZduuf0eGp+NNscE5pQ4dr0UOMn4rMs6VLQEV7ytUQcTF4QIa3hMZ3B8QuupEiVcfHSLcMeDQReFef+iiOFxAF/sigzsjBd3b
18CDuN5KD5c33whi3mPMgp4LRQckvSc+QiY/EPTmoIOc34qcH6UXYi5etIKUC0QGhLwnNjJkkDWMHaT8VqQ8Qw5ZM/tHnIDqoNS4
fTiHpacN4cliGf/nByeQwxrkqndmnFjyBJswt/aV6FeZqbYpmmzAplyHTalkt27VmqmpGG9oq1NVyUi1wTENE8MNnXJR445MlemS
oWG0oQ0yeD86CW9VAxyslQDWim/xAZzVVTkr3p0aYax60A/4KmGogK3qhwver31ObmLdQdWTwxeVIGVSHYWeEz9dhiksTbdtGC5D
sHAKlyEMFXAZPXHB/+VTjN/UYwerIsAQDvcCG1ieqxrFOWM/X1isfrQELkskNmC0+qGDd20NbFYtcjBZApgszkVPsFhXZbH41jzB
YPWkIbBX4nABc9UPGeuABWa4q+agg70SwF4dpwb+6kb81XF6YbCE0xE4LIHIgMXqh40Ma+iahQ4WSwCLlWEV3S1brAzL6BpfS51h
IVzraA7L5DQEJxPU2OFfOKtY6FS15hxrOKmOGLo2Qa+qYzbqthbRFNnQpxN0q1qhg3c9GuJVL5QgXAlEBqJVX2zwrmtBtOqFEkQr
gchAtOqNDf4scQSsvlhBzBKLD4StvgjhzrxE0OqHE4QskdhAwOqLDv5UJkSsnkhByBKKDsSsvvjIMFPYwvRrhrm+DvAcVtRoANBt
4hP/hwD0G0hivDBk1mJXncVoWPJ0sPuyVaTDSXlTi1PqjQlj539rdtAjfljkweW3Q9jNlFP/LiSnMo9xaiOP8RryGGvZrbEqqjJB
9+q4f2yPjwqTk39A6oSk0uH1rNpjosYeWVMWewzNRKeqcSp4vwMAa1ULHZzVZetD2mMGtupGbBVn6iVcVfcCAlMlCBHwVH0wwfsR
AHiqWujgqUTwVFzfIoCnOvtbBHV4D9DmNDiNwJFyfZtOpWUsh2U2mgSTfzt/WIbX0INrEMI1cO7oD+NwXYMx/Gs1MB7TcueTa50G
hmR64AKjMn2Qwb/dLEzWK+DBY4ngsTh3nIXFui6Lxb1MAw6rDyGBwRKGCvirPrjIbiZNm3+wPkOatbD2KEOW9S3bowxp1tegA7BH
wlABe9QtF3ng5V7DZpqy2aw9+sbwfsot0SyI7rdS8awLUrKibiLt6kmkVey77AKJycrKif0kCsXetr8O5mofprazZb8Tp8xAur4T
OKyQp8RPctzzX92AJiXsndDb4M/s1kJiUsnwTlKJPTS7mlX9JBUvq18OneLuz1/HQaXfstSq7ybAb4nlt6rJrVvZPNVkUzctKErT
isK5cgeC0hjK0JNO9YRrNQ/k5KrkhHefaKhJS2rCuWbhRtRkv/fDJTgNVQ+aQQ+hvI15iUq4hxVdG8nS3mDJnaQNx32eEvHmc8N0
t2C6eRO3EayvynefsXs4rHdL1vvotsjQlU9dwAxV6VRVjnIATbkNTeHe3h2K0pKiZJht7kRSMkw3968pGeabb1hUMkw4C6Aq+UfP
uTXFqHrRbneKoBKnak3QoQmNakIlBdUZ34asQhGuQREqua37AIit2kj37lQUKj8cok4mBnK9O+OhxiWZtiJPLc2AS2qYCM6svIkl
a0M0SXxpdfBIzXskvj2yYZGuyCJx7pANh9S1IMAgCUED/FH3PPDmmdqy3aw/ygpR2ERpRl9yl6ROuk7uNFXRdFPVTV2zplNV06dG
2zl6VXgM1Qhxu0i+PanhYZpvqgO0FY2klFbhOShn0CqSwxL35qDkTnM2BrgUpAYpjGJ0OYrBvb80TMAVDWTw7y6NsYxWO29ce0tj
OKNzJjCi0T0VvOn7NzLlw5NrGUSPraAMr9Wl1+JL3ofTuiandZRb+CyRJAUuSwwe4LG6J4L72x1XN2/U4dKVakDhp7r0U7zf7YCh
uiJDxf3VDjiq7gUElkoQIuCpumdiqIuEuSf6Mqzo6t0rZVjSdbteKcOaLvGFAV5JECLglRpngv3777yYURpTJ/2H/y0vZ0PMKI/M
uR+S7iPmV5a+9G1S5Ju93zMXbC6omZ59vrU8jnp07jAXTFhcmvsB/XtC8hD8kVVB/ojYe5LLtx8SdnvkcxT8SsKIPA8BMS81Jj/J
LLMMhJ26lUKSuBGL0ewBV+tZ4CcL9sh5SX7pUYuGN5o5cbJ/yr3tKz2XG62eSn//dJrJ2pqxPfRj3+LWfuDVXMQ85ItrmPljcb76
mt1eDmQv+e8Ja+u2VjryrBcbgTCVl/UsWFusrsZS9t9kO6iobCZ+qkdVLOu5mvJLvXeHtXCWztJZYSehWbrGMGT7FDDLl1iyYrYG
Z6kiU5X3snAxnGu/HshdTMw3AJmUaTyrxZaLM1VrfFlbPijNtMedt/LyDViGOu6g/bPgllxbLGkyXhwFJaZJYa+By48jYvR18XSa
HhUqqhnpgqxonHsDpqIkmrNeF8k9VEKek6FzXZzRlEUlEoVlESVvd8bDfrdFefQC3qKeXMmd8LLiGR+jF0QUpZtKg09RcrNbhoo6
rAaRyrkdnSp0VTxZtZUfsTeH91Ao5atsXVhJLq2nc3ZpZbkon0zehZUVwnzI4f4V/X7qExu1N3HemMIJAyo/PUsRnk4GTox7zqPg
Ifx7QT0Zfrv2UeoGQUh9F+2nm916jJMh7u6+cudxCGPJ5ZwaiaYn3O5Bf5nvLnMr+mqgavsemH89PZC1fjOmfXJbavtemBMu9Ynf
/Hjzf9Ob6jA1oAEA
EOF
sha256sum catalog/scores.json   # cc42feb44126df76d9ac6356b4bb36db86f8388e4716b7ff375ac2d96416bde3
````

The file carries `"version": "2026-09-28"`, 262 values, the bars of "Verified facts" with a `barsWhy` map, and one shipped treat-like (Kimi K3 → Sol medium). Then the other files:

Create `catalog/ATTRIBUTION.md`:

````markdown
# Attribution for the shipped catalog data

`catalog/scores.json` carries model scores from public sources. Each value names its source (`source`), the page
it came from (`url`), its date and its confidence. The weekly `catalog-refresh` workflow rebuilds the values that
come from the keyless sources below; the hand-typed values (no `source`) cite their own vendor or benchmark page in
their `url`.

## Sources whose values are shipped

### Arena (LMArena)

- Data: `lmarena-ai/leaderboard-dataset` on Hugging Face, configs `agent`, `agent_task_outcome_explicit`,
  `agent_bash_recovery_steps`, `agent_steerability`, `agent_tool_hallucination`, `webdev`
- License: CC BY 4.0
- Attribution: Leaderboard data by LMArena, CC BY 4.0, https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset

### Epoch AI benchmarks

- Data: https://epoch.ai/data/benchmark_data.zip (FrontierCode, Terminal-Bench and WebDev Arena tables)
- License: CC BY 4.0; external tables keep their own license
- Attribution: Epoch AI, 'Capabilities & benchmarking'. Published online at epoch.ai. Retrieved from 'https://epoch.ai/benchmarks' (CC BY 4.0)

### Vectara hallucination leaderboard

- Data: the README table of https://github.com/vectara/hallucination-leaderboard
- License: Apache License 2.0
- Attribution: Hallucination Leaderboard by Vectara (Apache License 2.0), https://github.com/vectara/hallucination-leaderboard

## Sources read at run time only

catherd reads these on the user's machine and ships none of their data: models.dev (MIT License,
https://models.dev), the OpenRouter API (https://openrouter.ai) and LiteLLM's
`model_prices_and_context_window.json` (MIT License, https://github.com/BerriAI/litellm).

Artificial Analysis (https://artificialanalysis.ai) is read only with the user's own key, and its values are never
shipped.
````

Edit `src/domain/catalog.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/catalog.ts b/src/domain/catalog.ts
index 18dcc06..d051525 100644
--- a/src/domain/catalog.ts
+++ b/src/domain/catalog.ts
@@ -127,7 +127,13 @@ const BarSchema = z.partialRecord(z.enum(DIMS), z.number());
 type Bars = Record<Kind, Record<Difficulty, Partial<Record<Dim, number>>>>;
 const BarsSchema = z.record(z.enum(KINDS), z.record(z.enum(DIFFICULTIES), BarSchema));
 
-/** `barsWhy` (the reasoning behind the bars) stays in the file as documentation; nothing reads it. */
+/** Spec 1.2 §5.2: per dimension and difficulty, where the default threshold came from. */
+const BarsWhySchema = z.partialRecord(z.enum(DIMS), z.partialRecord(z.enum(DIFFICULTIES), z.string()));
+
+/**
+ * `catalog/scores.json`: the hand-typed and keyless values (spec 1.2 §7), the shipped treat-likes, and the
+ * default bars with the `barsWhy` line of each threshold (spec 1.2 §5.2).
+ */
 export const ScoresFileSchema = z.looseObject({
   schema: z.literal(1),
   version: z.string(),
@@ -135,6 +141,7 @@ export const ScoresFileSchema = z.looseObject({
   scores: z.array(ScoreSchema),
   treatLike: z.record(CanonicalRung, z.object({ like: CanonicalRung, note: z.string() })),
   bars: BarsSchema,
+  barsWhy: BarsWhySchema.default({}),
 });
 export type ScoresFile = z.infer<typeof ScoresFileSchema>;
 
@@ -169,6 +176,8 @@ export interface Catalog {
   scores: Record<string, Partial<Record<Dim, Score>>>;
   treatLike: Record<string, { like: string; source: "shipped" | "user" }>;
   bars: Bars;
+  /** where each default threshold came from (spec 1.2 §5.2), by dimension and difficulty */
+  barsWhy: ScoresFile["barsWhy"];
   /** per backend id, the last `listModels()`; absent when never listed */
   listed: Record<string, { fetchedAt: string; models: Listed[] }>;
   /** `<canonical rung>|<kind or *>` → median seconds, only with ≥ 5 samples (spec §5.2) */
@@ -281,6 +290,7 @@ export function buildCatalog(o: {
     scores,
     treatLike,
     bars,
+    barsWhy: o.scores.barsWhy,
     listed: o.listed ?? {},
     secs: o.secs ?? {},
   };
````

Edit `src/domain/failover.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/failover.ts b/src/domain/failover.ts
index 0c516e9..c937113 100644
--- a/src/domain/failover.ts
+++ b/src/domain/failover.ts
@@ -2,6 +2,7 @@ import { billingKeyOf, type Catalog, DIMS, type Dim, rungInfo, scoresOf } from "
 import { type BillingMode, compareCost, type Cost, costOf, DEFAULT_BILLING } from "./cost.ts";
 import { type Rung, tryParseRung } from "./ids.ts";
 import { DIFFICULTIES, KINDS } from "./lane.ts";
+import { EFFORT_ORDER } from "./sources.ts";
 
 /**
  * Spec §7.1 and §4.5: a stand-in on the same quota would be out of quota too. The billing key names the
@@ -72,7 +73,9 @@ const costFor = (c: Catalog, billing: Partial<Record<string, BillingMode>>, rung
  * Spec 1.1 §11: the rungs of `pool` that can stand in for `rung`, best first. A stand-in is on another
  * quota, scored, paid from a plan or subscription under `billing` (a metered one spends money nobody chose
  * to), startable by `dispatch` (not a native `claude:` subagent), and no downgrade on the rung's bar dims.
- * Claude-billed stand-ins rank last, then the cheapest first.
+ * Claude-billed stand-ins rank last, then the effort nearest the rung's own (a model's efforts carry one
+ * another's values as `adjacent`, spec 1.2 §4.3, so the cheapest would otherwise be its lowest effort; plan 14
+ * Ruling 4), then the cheapest.
  */
 export function rankStandIns(
   c: Catalog,
@@ -88,14 +91,24 @@ export function rankStandIns(
     if (costFor(c, billing, x).tier === 1) return false;
     return downgradeDims(c, rung, x).length === 0;
   });
+  const gap = (x: string) => effortGap(from.effort, tryParseRung(x)?.effort ?? "");
   return fits.sort(
     (a, b) =>
       Number(claudeBilled(a)) - Number(claudeBilled(b)) ||
+      gap(a) - gap(b) ||
       compareCost(costFor(c, billing, a), costFor(c, billing, b)) ||
       a.localeCompare(b),
   );
 }
 
+/** How many effort steps apart two efforts are; an effort that is no effort word (`default`) is far from all. */
+function effortGap(a: string, b: string): number {
+  const i = (EFFORT_ORDER as readonly string[]).indexOf(a);
+  const j = (EFFORT_ORDER as readonly string[]).indexOf(b);
+  if (a === b) return 0;
+  return i < 0 || j < 0 ? EFFORT_ORDER.length : Math.abs(i - j);
+}
+
 /** How a family's `on` key or a model id's prefix maps to the backend that runs it. */
 const BACKEND_OF_KEY: Record<string, string> = { "opencode-go": "opencode" };
````

Edit `src/domain/profile-rules.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/profile-rules.ts b/src/domain/profile-rules.ts
index fa86095..bb58f5b 100644
--- a/src/domain/profile-rules.ts
+++ b/src/domain/profile-rules.ts
@@ -170,14 +170,15 @@ export function validateProfile(
             path: `${at}.rungs`,
             message: `${x.rung} clears no routing bar, so a lane starts on it only as the role's default rung and never climbs onto it`,
           });
+    // spec 1.2 §5.2: the logic and hard bars sit at the 60th and 75th percentiles, which a cost-minded ladder
+    // may never reach, and those lanes start at the default rung and climb; only a kind whose every bar the
+    // ladder misses routes blind (plan 14 Ruling 12)
     if (role === "worker" && usable.length > 1) {
-      const missed = KINDS.flatMap((k) =>
-        DIFFICULTIES.filter((d) => !usable.some((x) => clearsBar(c, x, k, d))).map((d) => `${k}/${d}`),
-      );
-      if (missed.length)
+      const blind = KINDS.filter((k) => !DIFFICULTIES.some((d) => usable.some((x) => clearsBar(c, x, k, d))));
+      if (blind.length)
         warnings.push({
           path: `${at}.rungs`,
-          message: `no worker rung clears the bar for ${missed.join(", ")}; those lanes start at the default rung`,
+          message: `no worker rung clears any bar for ${blind.join(", ")}; those lanes always start at the default rung`,
         });
     }
   }
````



- [ ] **Step 4: Regenerate the dashboard's frames**

Run: `CATHERD_WRITE_FRAMES=1 bun test test/entry/tui/frames.test.tsx --update-snapshots`
Expected: PASS; the Profiles frames list Haiku 4.5 among the scored Claude models (it has an Epoch WebDev value) instead of last with `· unscored`.

- [ ] **Step 5: Run the tests and the checks**

Run: `bun test test/domain test/services test/entry test/integration` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail; then the whole gate once (`bun test`): 1581 pass / 10 skip on the scratch commit.

- [ ] **Step 6: Commit**

```bash
git add catalog/ATTRIBUTION.md catalog/scores.json docs/tui-frames.md src/domain/catalog.ts src/domain/failover.ts src/domain/profile-rules.ts test/domain/catalog.test.ts test/domain/failover.test.ts test/domain/profile-rules.test.ts test/domain/select.test.ts test/entry/catalog-command.test.ts test/entry/tui/__snapshots__/frames.test.tsx.snap test/entry/tui/effects.test.ts test/entry/tui/profile-tree.test.ts test/entry/tui/profiles.test.tsx test/integration/mcp-stdio.test.ts test/pack-smoke.ts test/services/catalog-service.test.ts test/services/routing-service.test.ts test/services/source-derive.test.ts test/services/source-sync.test.ts
git commit -m "feat(catalog): ship the keyless sources' scores and the percentile bars, with ATTRIBUTION.md"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 4: Rank stand-ins by similarity and infer the values a rung lacks on a bar's dimension (spec 1.2 §6.1, §6.3, §11; Rulings 6, 7, 8)

`src/services/standins.ts` ranks stand-ins (Ruling 6) and fills `Catalog.inferred` for every rung the catalog can name (Ruling 7); `scoresOf` takes a rung's own value, else its treat-like's, else its inferred stand-in's, and says which (`inferred`, `standIns`). `loadCatalog` serves the catalog with its stand-ins, so routing, validation and every surface read them. `models.json` gains each family's release date (models.dev, 2026-09-28) and `derived.json` AA's stand-in features. The spec §11 test: on the keyless fixture data, Opus 5.5 has no repo_code or terminal value in any source, and gets a stand-in for both.

**Files:**

- Modify: `catalog/models.json`
- Modify: `src/domain/catalog.ts`
- Modify: `src/domain/sources.ts`
- Modify: `src/services/catalog-service.ts`
- Modify: `src/services/source-derive.ts`
- Create: `src/services/standins.ts`
- Regenerate: `test/entry/tui/__snapshots__/frames.test.tsx.snap`
- Test: `test/infra/sources/cache.test.ts`
- Test: `test/services/source-derive.test.ts`
- Test (new): `test/services/standins.test.ts`

**Interfaces:**
- Consumes: Task 3's shipped data; plan 13's `derive`, `DerivedSchema`, `rawAnswers`, `shippedContext`, `EFFORT_ORDER`, `catalogRungs`.
- Produces: `src/services/standins.ts`: `type Features`, `MIN_SHARED_FEATURES = 3`, `interface Suggestion { like; distance; features: string[]; lends: Dim[] }`, `featuresOf(c, canonical)`, `canonicalRungs(c)`, `missingDims(c, canonical, dims?)`, `barDimsIn(c)`, `suggestStandIns(c, canonical, limit = 3): Suggestion[]`, `inferStandIns(c): Catalog["inferred"]`, `withStandIns(c): Catalog`, `leansOnStandIn(c, canonical)`. `src/domain/catalog.ts`: `interface InferredStandIn { like; distance; features }`, `Catalog.features`, `Catalog.inferred`, `Family.releaseDate`, `scoresOf(...)` adds `inferred: Dim[]` and `standIns: Partial<Record<Dim, string>>`; `buildCatalog({ features? })`. `Derived.features`; `source-derive.ts` exports `AA_FEATURES`.

- [ ] **Step 1: Write the failing tests**

Edit `test/infra/sources/cache.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/infra/sources/cache.test.ts b/test/infra/sources/cache.test.ts
index da2d53a..4124c0a 100644
--- a/test/infra/sources/cache.test.ts
+++ b/test/infra/sources/cache.test.ts
@@ -87,6 +87,7 @@ describe("the source cache (spec 1.2 §3.3)", () => {
       ],
       unmatched: { arena: ["Kimi K3"] },
       warnings: [],
+      features: {},
     };
     writeDerived(d);
     expect(readDerived()).toEqual(d);
````

Edit `test/services/source-derive.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/source-derive.test.ts b/test/services/source-derive.test.ts
index 3f9f389..2263ea3 100644
--- a/test/services/source-derive.test.ts
+++ b/test/services/source-derive.test.ts
@@ -131,6 +131,14 @@ describe("anchors and calibration (spec 1.2 §4.1, §4.2)", () => {
     );
   });
 
+  it("keeps Artificial Analysis's stand-in features per rung, and none without its answer (spec 1.2 §6.3)", () => {
+    expect(keyless().features).toEqual({});
+    const d = derive(rawAnswers(AT, { aa: true }), shippedContext(NOW));
+    expect(Object.keys(d.features["gpt-6-sol#max"] ?? {}).sort()).toEqual(
+      ["artificial_analysis_intelligence_index", "hle", "lcr", "scicode"].sort(),
+    );
+  });
+
   it("calibrates Artificial Analysis onto the shipped anchor, never using it as one (synthetic fixture)", () => {
     const d = derive(rawAnswers(AT, { aa: true }), shippedContext(NOW));
     expect(d.fits.find((f) => f.field === "scicode")).toMatchObject({ dim: "repo_code", n: 5, used: true });
````

Create `test/services/standins.test.ts`:

````ts
import { afterEach, describe, expect, it } from "bun:test";
import { buildCatalog, type Catalog, scoresOf } from "../../src/domain/catalog.ts";
import { loadCatalog } from "../../src/services/catalog-service.ts";
import { derive } from "../../src/services/source-derive.ts";
import {
  canonicalRungs,
  featuresOf,
  inferStandIns,
  MIN_SHARED_FEATURES,
  missingDims,
  suggestStandIns,
  withStandIns,
} from "../../src/services/standins.ts";
import { shipped } from "../domain/shipped.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { rawAnswers, shippedContext } from "./source-fixtures.ts";

afterEach(snapshotEnv());

const AT = "2026-09-27T10:00:00.000Z";
const NOW = Date.parse(AT);

/**
 * The catalog as the keyless sources alone described it on 2026-09-27 (spec 1.2 §11): the recorded answers,
 * over the hand-typed values less every Opus 5.5 one (a vendor's own numbers, which no source carries).
 */
function keylessDay(): Catalog {
  const ctx = shippedContext(NOW);
  const hand = ctx.scores.scores.filter(
    (s) => s.source === undefined && s.confidence !== "adjacent" && !s.rung.startsWith("claude-opus-5-5#"),
  );
  const synced = derive(rawAnswers(AT), { ...ctx, scores: { ...ctx.scores, scores: hand } }).scores;
  return withStandIns(
    buildCatalog({
      models: ctx.models,
      scores: { ...ctx.scores, scores: hand, treatLike: {} },
      synced,
      now: NOW,
    }),
  );
}

describe("stand-in ranking (spec 1.2 §6.3)", () => {
  it("gives Opus 5.5 a stand-in for coding and terminal, which no keyless source scores it on", () => {
    const c = keylessDay();
    expect(c.scores["claude-opus-5-5#high"]?.repo_code).toBeUndefined();
    expect(c.scores["claude-opus-5-5#high"]?.terminal).toBeUndefined();
    const s = scoresOf(c, "claude-opus-5-5#high");
    expect(s?.inferred).toEqual(expect.arrayContaining(["repo_code", "terminal"]));
    for (const d of ["repo_code", "terminal"] as const) {
      const stand = c.inferred["claude-opus-5-5#high"]?.[d];
      expect(stand?.features.length).toBeGreaterThanOrEqual(MIN_SHARED_FEATURES);
      expect(s?.standIns[d]).toBe(stand?.like);
      expect(s?.values[d]).toBe(c.scores[stand?.like as string]?.[d]?.value);
    }
    // Arena scores Opus on agentic itself: that value is its own, never a stand-in's
    expect(s?.inferred).not.toContain("agentic");
  });

  it("ranks by a z-scored distance over shared features, nearest first, and says what each would lend", () => {
    const c = keylessDay();
    const top = suggestStandIns(c, "claude-opus-5-5#high");
    expect(top).toHaveLength(3);
    const distances = top.map((x) => x.distance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    for (const x of top) {
      expect(x.features).toEqual(expect.arrayContaining(["price", "context", "vendor", "family", "effort"]));
      expect(x.lends.length).toBeGreaterThan(0);
      expect(x.like).not.toBe("claude-opus-5-5#high");
    }
  });

  it("uses the keyless features without an Artificial Analysis key, and AA's with one", () => {
    const c = keylessDay();
    const f = featuresOf(c, "claude-opus-5-5#high");
    expect(Object.keys(f)).toEqual(
      expect.arrayContaining(["price", "context", "release", "vendor", "family", "effort", "agentic"]),
    );
    expect(Object.keys(f).some((k) => k.startsWith("aa."))).toBe(false);
    const withAa = { ...c, features: { "claude-opus-5-5#high": { hle: 40, scicode: 50 } } };
    expect(featuresOf(withAa, "claude-opus-5-5#high")).toMatchObject({ "aa.hle": 40, "aa.scicode": 50 });
  });

  it("suggests nothing for a rung sharing fewer than three features with any scored rung", () => {
    // a model OpenCode lists that catherd has no family for: only its effort is known
    const c = withStandIns(
      shipped({
        listed: {
          opencode: {
            fetchedAt: AT,
            models: [{ id: "opencode-go/glm-5.3", efforts: ["high"], context: 1, imageIn: false }],
          },
        },
      }),
    );
    expect(canonicalRungs(c)).toContain("opencode-go/glm-5.3#high");
    expect(suggestStandIns(c, "opencode-go/glm-5.3#high")).toEqual([]);
    expect(c.inferred["opencode-go/glm-5.3#high"]).toBeUndefined();
    expect(scoresOf(c, "opencode-go/glm-5.3#high")).toBeNull();
  });

  it("never lends a guess: a stand-in's own inferred value is not borrowed on", () => {
    const c = withStandIns(shipped());
    // Fable max's DeepSWE value is hand-typed as inferred; Fable's other efforts take repo_code elsewhere
    expect(c.scores["claude-fable-5-1#max"]?.repo_code?.confidence).toBe("inferred");
    for (const stand of Object.values(c.inferred))
      expect(stand.repo_code?.like).not.toBe("claude-fable-5-1#max");
  });
});

describe("inferred values in the catalog (spec 1.2 §6.1)", () => {
  it("fills only what a rung lacks on the bars' dimensions, after its own values and its treat-like", () => {
    const c = withStandIns(shipped());
    // Sol has a value on every bar dimension: nothing to infer
    expect(missingDims(c, "gpt-6-sol#medium")).toEqual([]);
    expect(c.inferred["gpt-6-sol#medium"]).toBeUndefined();
    // Kimi K3 borrows everything through its shipped treat-like: nothing to infer either
    expect(c.inferred["opencode-go/kimi-k3#max"]).toBeUndefined();
    // GPT-6 Luna has no agentic value in any source: a stand-in lends one, as inferred
    const luna = scoresOf(c, "gpt-6-luna#high");
    expect(luna?.inferred).toEqual(["agentic"]);
    expect(luna?.standIns.agentic).toBe(c.inferred["gpt-6-luna#high"]?.agentic?.like);
    // steer carries no bar: never inferred
    expect(Object.values(c.inferred).some((x) => x.steer)).toBe(false);
  });

  it("is what loadCatalog serves routing", () => {
    withHome();
    const c = loadCatalog({ timings: false });
    expect(c.inferred).toEqual(inferStandIns({ ...c, inferred: {} }));
    expect(scoresOf(c, "gpt-6-luna#high")?.values.agentic).toBeDefined();
  });
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/services/standins.test.ts test/services/source-derive.test.ts test/infra/sources/cache.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/standins.ts'`; `derive(...).features` is undefined.

- [ ] **Step 3: Implement**

Edit `catalog/models.json` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/catalog/models.json b/catalog/models.json
index 1245964..042a97b 100644
--- a/catalog/models.json
+++ b/catalog/models.json
@@ -20,6 +20,7 @@
       "id": "gpt-6-astra",
       "name": "GPT-6 Astra",
       "vendor": "openai",
+      "releaseDate": "2026-09-04",
       "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
       "price": { "input": 10, "cached": 1, "output": 50 },
       "planWeight": 60,
@@ -43,6 +44,7 @@
       "id": "gpt-6-sol",
       "name": "GPT-6 Sol",
       "vendor": "openai",
+      "releaseDate": "2026-09-22",
       "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
       "price": { "input": 2, "cached": 0.2, "output": 10 },
       "planWeight": 20,
@@ -66,6 +68,7 @@
       "id": "gpt-6-luna",
       "name": "GPT-6 Luna",
       "vendor": "openai",
+      "releaseDate": "2026-09-22",
       "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
       "price": { "input": 0.1, "cached": 0.01, "output": 0.5 },
       "planWeight": 1,
@@ -91,6 +94,7 @@
       "id": "gpt-5.6-sol",
       "name": "GPT-5.6 Sol",
       "vendor": "openai",
+      "releaseDate": "2026-07-09",
       "status": "legacy",
       "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
       "price": { "input": 4, "cached": 0.4, "output": 20 },
@@ -113,6 +117,7 @@
       "id": "gpt-5.6-terra",
       "name": "GPT-5.6 Terra",
       "vendor": "openai",
+      "releaseDate": "2026-07-09",
       "status": "legacy",
       "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
       "price": { "input": 2, "cached": 0.2, "output": 12 },
@@ -135,6 +140,7 @@
       "id": "gpt-5.6-luna",
       "name": "GPT-5.6 Luna",
       "vendor": "openai",
+      "releaseDate": "2026-07-09",
       "status": "legacy",
       "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
       "price": { "input": 0.2, "cached": 0.02, "output": 1.2 },
@@ -162,6 +168,7 @@
       "id": "claude-fable-5-1",
       "name": "Claude Fable 5.1",
       "vendor": "anthropic",
+      "releaseDate": "2026-09-01",
       "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
       "price": { "input": 10, "cached": 0.25, "output": 50 },
       "meteredOnPlan": true,
@@ -185,6 +192,7 @@
       "id": "claude-opus-5-5",
       "name": "Claude Opus 5.5",
       "vendor": "anthropic",
+      "releaseDate": "2026-09-22",
       "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
       "price": { "input": 4, "cached": 0.2, "output": 20 },
       "on": {
@@ -205,6 +213,7 @@
       "id": "claude-sonnet-5",
       "name": "Claude Sonnet 5",
       "vendor": "anthropic",
+      "releaseDate": "2026-06-29",
       "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
       "price": { "input": 2, "cached": 0.2, "output": 10 },
       "on": {
@@ -224,6 +233,7 @@
       "id": "claude-haiku-4-5",
       "name": "Claude Haiku 4.5",
       "vendor": "anthropic",
+      "releaseDate": "2025-10-15",
       "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
       "price": { "input": 1, "cached": 0.1, "output": 5 },
       "on": {
````

Edit `src/domain/catalog.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/catalog.ts b/src/domain/catalog.ts
index d051525..243b002 100644
--- a/src/domain/catalog.ts
+++ b/src/domain/catalog.ts
@@ -73,6 +73,8 @@ const FamilySchema = z.looseObject({
   meteredOnPlan: z.boolean().default(false),
   on: z.partialRecord(z.enum(MODEL_KEYS), BackendModelSchema),
   notes: z.record(z.string(), z.string()).default({}),
+  /** the day the vendor released it (models.dev), a stand-in feature (spec 1.2 §6.3) */
+  releaseDate: z.iso.date().optional(),
 });
 export type Family = z.infer<typeof FamilySchema>;
 
@@ -161,6 +163,15 @@ export const OverrideSchema = z.looseObject({
 });
 export type Override = z.infer<typeof OverrideSchema>;
 
+/** Spec 1.2 §6.1: the rung whose value a rung without one uses on a dimension, as `inferred`. */
+export interface InferredStandIn {
+  like: string;
+  /** spec 1.2 §6.3's distance between the two */
+  distance: number;
+  /** the features that distance rests on */
+  features: string[];
+}
+
 interface Listed {
   id: string;
   efforts: string[];
@@ -182,6 +193,13 @@ export interface Catalog {
   listed: Record<string, { fetchedAt: string; models: Listed[] }>;
   /** `<canonical rung>|<kind or *>` → median seconds, only with ≥ 5 samples (spec §5.2) */
   secs: Record<string, number>;
+  /** canonical rung → the Artificial Analysis stand-in features a sync read for it (spec 1.2 §6.3) */
+  features: Record<string, Record<string, number>>;
+  /**
+   * canonical rung → per dimension it has no value for (of its own or through a treat-like), the stand-in
+   * whose value it uses as `inferred` (spec 1.2 §6.1); filled by the stand-in ranking (services/standins.ts)
+   */
+  inferred: Record<string, Partial<Record<Dim, InferredStandIn>>>;
 }
 
 /**
@@ -231,7 +249,13 @@ export function applyFacts(families: Family[], facts: Record<string, FamilyFacts
           reasoning: f.capabilities.reasoning || got.reasoning,
         }
       : f.capabilities;
-    return { ...f, price: x.price ?? f.price, capabilities, on };
+    return {
+      ...f,
+      price: x.price ?? f.price,
+      capabilities,
+      on,
+      ...(x.releaseDate || f.releaseDate ? { releaseDate: x.releaseDate ?? f.releaseDate } : {}),
+    };
   });
 }
 
@@ -261,6 +285,7 @@ export function buildCatalog(o: {
   override?: Override;
   listed?: Catalog["listed"];
   secs?: Catalog["secs"];
+  features?: Catalog["features"];
   now?: number;
 }): Catalog {
   const now = o.now ?? Date.now();
@@ -293,6 +318,8 @@ export function buildCatalog(o: {
     barsWhy: o.scores.barsWhy,
     listed: o.listed ?? {},
     secs: o.secs ?? {},
+    features: o.features ?? {},
+    inferred: {},
   };
 }
 
@@ -340,8 +367,9 @@ export function rungInfo(c: Catalog, rung: string): RungInfo {
 
 /**
  * The rung's scores: per dimension its own value, else that of the rung it is treated like (a sync may score
- * a rung on some dimensions only). `via` names that rung when it lends any value, `borrowed` the dimensions
- * it lends. null when unscored.
+ * a rung on some dimensions only), else its inferred stand-in's (spec 1.2 §6.1). `via` names the treat-like
+ * when it lends any value and `borrowed` the dimensions it lends; `inferred` the dimensions an inferred
+ * stand-in fills and `standIns` whose values they are. null when it has no value at all.
  */
 export function scoresOf(
   c: Catalog,
@@ -351,22 +379,33 @@ export function scoresOf(
   records: Partial<Record<Dim, Score>>;
   via: string | null;
   borrowed: Dim[];
+  inferred: Dim[];
+  standIns: Partial<Record<Dim, string>>;
 } | null {
   const own = c.scores[canonical] ?? {};
   const like = c.treatLike[canonical]?.like ?? null;
   const lent = like ? (c.scores[like] ?? {}) : {};
+  const guessed = c.inferred[canonical] ?? {};
   const values: Partial<Record<Dim, number>> = {};
   const records: Partial<Record<Dim, Score>> = {};
   const borrowed: Dim[] = [];
+  const inferred: Dim[] = [];
+  const standIns: Partial<Record<Dim, string>> = {};
   for (const d of DIMS) {
-    const r = own[d] ?? lent[d];
+    const stand = guessed[d];
+    const r = own[d] ?? lent[d] ?? (stand ? c.scores[stand.like]?.[d] : undefined);
     if (!r) continue;
     records[d] = r;
     values[d] = r.value;
-    if (!own[d]) borrowed.push(d);
+    if (own[d]) continue;
+    if (lent[d]) borrowed.push(d);
+    else if (stand) {
+      inferred.push(d);
+      standIns[d] = stand.like;
+    }
   }
   if (Object.keys(records).length === 0) return null;
-  return { values, records, via: borrowed.length ? like : null, borrowed };
+  return { values, records, via: borrowed.length ? like : null, borrowed, inferred, standIns };
 }
 
 /** Spec §4 roles: what a rung must offer to be placed on a role. */
````

Edit `src/domain/sources.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/sources.ts b/src/domain/sources.ts
index 3258bf0..58bd56c 100644
--- a/src/domain/sources.ts
+++ b/src/domain/sources.ts
@@ -125,6 +125,8 @@ export const DerivedSchema = z.looseObject({
   fits: z.array(FitRowSchema),
   unmatched: z.record(z.string(), z.array(z.string())),
   warnings: z.array(z.string()),
+  /** canonical rung → the Artificial Analysis stand-in features (spec 1.2 §6.3); a file before plan 14 has none */
+  features: z.record(z.string(), z.record(z.string(), z.number())).default({}),
 });
 export type Derived = z.infer<typeof DerivedSchema>;
````

Edit `src/services/catalog-service.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/catalog-service.ts b/src/services/catalog-service.ts
index deacf44..f3c355a 100644
--- a/src/services/catalog-service.ts
+++ b/src/services/catalog-service.ts
@@ -35,6 +35,7 @@ import { readDerived } from "../infra/sources/cache.ts";
 import { ensurePrivateDir, readVersioned, writeJsonAtomic } from "../infra/store.ts";
 import type { CatalogFilter } from "./ports.ts";
 import { listRuns, readAgentRuns, readRecords, readRoutes } from "./run-store.ts";
+import { withStandIns } from "./standins.ts";
 
 const DAY_MS = 24 * 3_600_000;
 /** Spec §5.2: `secs_per_task` counts once a rung has this many of the user's own runs. */
@@ -122,14 +123,18 @@ export function measuredSecs(base: Catalog): Catalog["secs"] {
 export function loadCatalog(o: { timings?: boolean; repo?: string } = {}): Catalog {
   // spec 1.2 §3.2: whatever the last sync derived; without one (first run, offline), the shipped values alone
   const synced = readDerived();
-  const base = buildCatalog({
-    models: shippedModels(),
-    scores: shippedScores(),
-    synced: synced?.scores,
-    facts: synced?.facts,
-    override: readOverride(),
-    listed: listedModels(o.repo),
-  });
+  // spec 1.2 §6.1: every value a rung lacks on a dimension the bars use comes from its nearest stand-in
+  const base = withStandIns(
+    buildCatalog({
+      models: shippedModels(),
+      scores: shippedScores(),
+      synced: synced?.scores,
+      facts: synced?.facts,
+      features: synced?.features,
+      override: readOverride(),
+      listed: listedModels(o.repo),
+    }),
+  );
   return o.timings === false ? base : { ...base, secs: measuredSecs(base) };
 }
````

Edit `src/services/source-derive.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/source-derive.ts b/src/services/source-derive.ts
index e0fb987..d97834d 100644
--- a/src/services/source-derive.ts
+++ b/src/services/source-derive.ts
@@ -174,9 +174,31 @@ export function derive(raw: RawAnswers, ctx: DeriveContext): Derived {
     fits,
     unmatched: Object.fromEntries(Object.entries(unmatched).map(([s, ids]) => [s, [...ids].sort()])),
     warnings,
+    features: aaFeatures(table),
   };
 }
 
+/** Spec 1.2 §6.3: the Artificial Analysis numbers a stand-in is ranked on, as AA names them. */
+export const AA_FEATURES = [
+  "artificial_analysis_intelligence_index",
+  "hle",
+  "scicode",
+  "lcr",
+  "cost_per_task",
+  "median_output_tokens_per_second",
+] as const;
+
+/** Each catalog rung's AA stand-in features, from the rows `derive` keyed (never shipped: AA is keyed). */
+function aaFeatures(table: Map<string, Map<string, Keyed>>): Derived["features"] {
+  const out: Derived["features"] = {};
+  for (const field of AA_FEATURES)
+    for (const k of table.get(`artificial-analysis.${field}`)?.values() ?? []) {
+      if (!k.family) continue;
+      (out[`${k.family.id}#${k.effort}`] ??= {})[field] = k.row.value;
+    }
+  return out;
+}
+
 /**
  * Spec 1.2 §4.3 `adjacent`: for each family effort a dimension has no value at (neither one in `direct` nor
  * one `shipped` names, as `<family>#<effort>|<dim>`), the best value in `direct` at the nearest effort that
````

Create `src/services/standins.ts`:

````ts
import {
  type Catalog,
  DIMS,
  type Dim,
  type Family,
  type InferredStandIn,
  rungInfo,
  scoresOf,
} from "../domain/catalog.ts";
import { catalogRungs } from "../domain/failover.ts";
import { EFFORT_ORDER } from "../domain/sources.ts";

/**
 * Spec 1.2 §6.3: the features a rung is compared on. Numbers are z-scored across the catalog; `vendor` and
 * `family` are words, the same or not. Keyless: price, context, release date, vendor and family, the effort
 * (plan 14 Ruling 6), and the rung's own values on each dimension (the Arena and Epoch values, with the
 * shipped ones). With an Artificial Analysis key, its index, `hle`, `scicode`, `lcr`, cost per task and
 * tokens/s join them (`Catalog.features`).
 */
export type Features = Record<string, number | string>;

/** Spec 1.2 §6.3: a pair sharing fewer features than this is not suggested. */
export const MIN_SHARED_FEATURES = 3;

export interface Suggestion {
  /** the canonical rung that would stand in */
  like: string;
  distance: number;
  /** the features the distance rests on: those both rungs have */
  features: string[];
  /** the dimensions it would lend: those the rung lacks and it has */
  lends: Dim[];
}

const DAY_MS = 86_400_000;
const family = (c: Catalog, canonical: string): Family | null =>
  c.families.find((f) => f.id === canonical.slice(0, canonical.lastIndexOf("#"))) ?? null;

/** The rung's own value per dimension: a value it borrows, or catherd's guess (`inferred`), never counts. */
function ownValues(c: Catalog, canonical: string): Partial<Record<Dim, number>> {
  const out: Partial<Record<Dim, number>> = {};
  for (const d of DIMS) {
    const s = c.scores[canonical]?.[d];
    if (s && s.confidence !== "inferred") out[d] = s.value;
  }
  return out;
}

/** Spec 1.2 §6.3: a canonical rung's features, from its family, its effort, its own values and AA's. */
export function featuresOf(c: Catalog, canonical: string): Features {
  const out: Features = {};
  const f = family(c, canonical);
  if (f) {
    out.price = Math.log10(f.price.input + f.price.output + 1e-6);
    const contexts = Object.values(f.on).flatMap((m) => (m ? [m.context] : []));
    if (contexts.length) out.context = Math.log10(Math.max(...contexts));
    if (f.releaseDate) out.release = Date.parse(f.releaseDate) / DAY_MS;
    const vendor = (f as { vendor?: unknown }).vendor;
    if (typeof vendor === "string") out.vendor = vendor;
    out.family = f.id;
  }
  const effort = (EFFORT_ORDER as readonly string[]).indexOf(canonical.slice(canonical.lastIndexOf("#") + 1));
  if (effort >= 0) out.effort = effort;
  for (const [d, v] of Object.entries(ownValues(c, canonical))) out[d] = v;
  for (const [k, v] of Object.entries(c.features[canonical] ?? {})) out[`aa.${k}`] = v;
  return out;
}

/** Every canonical rung the catalog can name, and every one it holds a value for. */
export function canonicalRungs(c: Catalog): string[] {
  const out = new Set(Object.keys(c.scores));
  for (const r of catalogRungs(c)) {
    try {
      out.add(rungInfo(c, r).canonical);
    } catch {
      // catalogRungs only names parseable rungs
    }
  }
  return [...out].sort();
}

interface Scale {
  mean: number;
  sd: number;
}

/** Each numeric feature's mean and spread over `all`; a feature with no spread tells rungs apart by nothing. */
function scales(all: Features[]): Map<string, Scale> {
  const values = new Map<string, number[]>();
  for (const f of all)
    for (const [k, v] of Object.entries(f))
      if (typeof v === "number") values.set(k, [...(values.get(k) ?? []), v]);
  const out = new Map<string, Scale>();
  for (const [k, xs] of values) {
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
    if (sd > 0) out.set(k, { mean, sd });
  }
  return out;
}

/**
 * Spec 1.2 §6.3: the z-scored Euclidean distance over the features both have, as a root mean square so pairs
 * sharing different numbers of features compare (plan 14 Ruling 6); a word counts 0 when equal, else 1. Null
 * when they share fewer than MIN_SHARED_FEATURES.
 */
function distance(a: Features, b: Features, z: Map<string, Scale>): { d: number; shared: string[] } | null {
  const shared: string[] = [];
  let sum = 0;
  for (const [k, va] of Object.entries(a)) {
    const vb = b[k];
    if (vb === undefined) continue;
    if (typeof va === "string" || typeof vb === "string") {
      shared.push(k);
      sum += va === vb ? 0 : 1;
      continue;
    }
    const s = z.get(k);
    if (!s) continue;
    shared.push(k);
    sum += ((va - vb) / s.sd) ** 2;
  }
  if (shared.length < MIN_SHARED_FEATURES) return null;
  return { d: Math.sqrt(sum / shared.length), shared };
}

/** The dimensions the bars use that `canonical` has no value for, of its own or through a treat-like. */
export function missingDims(c: Catalog, canonical: string, dims: readonly Dim[] = barDimsIn(c)): Dim[] {
  const own = c.scores[canonical] ?? {};
  const like = c.treatLike[canonical]?.like;
  const lent = like ? (c.scores[like] ?? {}) : {};
  return dims.filter((d) => !own[d] && !lent[d]);
}

/** Every dimension some bar of the catalog (the defaults, with the user's override) has a threshold on. */
export function barDimsIn(c: Catalog): Dim[] {
  const used = new Set<string>();
  for (const kind of Object.values(c.bars))
    for (const bar of Object.values(kind))
      for (const [d, min] of Object.entries(bar)) if (min !== undefined) used.add(d);
  return DIMS.filter((d) => used.has(d));
}

class Ranker {
  private readonly all = new Map<string, Features>();
  private readonly z: Map<string, Scale>;
  constructor(private readonly c: Catalog) {
    for (const r of canonicalRungs(c)) this.all.set(r, featuresOf(c, r));
    this.z = scales([...this.all.values()]);
  }
  /** The rungs with an own value on any of `dims`, nearest first; each with what it would lend. */
  rank(canonical: string, dims: readonly Dim[]): Suggestion[] {
    const mine = this.all.get(canonical) ?? featuresOf(this.c, canonical);
    const out: Suggestion[] = [];
    for (const [other, f] of this.all) {
      if (other === canonical) continue;
      const own = ownValues(this.c, other);
      const lends = dims.filter((d) => own[d] !== undefined);
      if (lends.length === 0) continue;
      const got = distance(mine, f, this.z);
      if (got) out.push({ like: other, distance: Number(got.d.toFixed(4)), features: got.shared, lends });
    }
    return out.sort((a, b) => a.distance - b.distance || a.like.localeCompare(b.like));
  }
}

/**
 * Spec 1.2 §6.4 `treat-like --suggest`: the `limit` nearest rungs that would lend `canonical` a value it lacks
 * on a dimension the bars use (any scored rung when it lacks none), with their distance and features.
 */
export function suggestStandIns(c: Catalog, canonical: string, limit = 3): Suggestion[] {
  const lacking = missingDims(c, canonical);
  return new Ranker(c).rank(canonical, lacking.length ? lacking : DIMS).slice(0, limit);
}

/**
 * Spec 1.2 §6.1: for every rung the catalog can name, per dimension the bars use that it has no value for
 * (of its own or through a treat-like), its nearest stand-in with a value there. A rung no rung is near
 * enough to (fewer than MIN_SHARED_FEATURES shared) gets none on that dimension.
 */
export function inferStandIns(c: Catalog): Catalog["inferred"] {
  const dims = barDimsIn(c);
  const ranker = new Ranker(c);
  const out: Catalog["inferred"] = {};
  for (const canonical of canonicalRungs(c)) {
    const lacking = missingDims(c, canonical, dims);
    for (const d of lacking) {
      const best = ranker.rank(canonical, [d])[0];
      if (!best) continue;
      const entry: InferredStandIn = { like: best.like, distance: best.distance, features: best.features };
      (out[canonical] ??= {})[d] = entry;
    }
  }
  return out;
}

/** The catalog with its inferred stand-ins filled in: what routing, validation and the surfaces read. */
export function withStandIns(c: Catalog): Catalog {
  return { ...c, inferred: inferStandIns(c) };
}

/** Whether `canonical` leans on an inferred stand-in for any value (`scoresOf`'s `inferred`). */
export const leansOnStandIn = (c: Catalog, canonical: string): boolean =>
  (scoresOf(c, canonical)?.inferred.length ?? 0) > 0;
````

- [ ] **Step 4: Regenerate the dashboard's frames**

Run: `CATHERD_WRITE_FRAMES=1 bun test test/entry/tui/frames.test.tsx --update-snapshots`
Expected: PASS; the 120-column Profiles frames mark the opencode Haiku efforts as scored (inferred) instead of unscored.

- [ ] **Step 5: Run the tests and the checks**

Run: `bun test test/services/standins.test.ts test/services/source-derive.test.ts test/infra/sources/cache.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail; then the whole gate once: 1589 pass / 10 skip on the scratch commit.

- [ ] **Step 6: Commit**

```bash
git add catalog/models.json src/domain/catalog.ts src/domain/sources.ts src/services/catalog-service.ts src/services/source-derive.ts src/services/standins.ts test/entry/tui/__snapshots__/frames.test.tsx.snap test/infra/sources/cache.test.ts test/services/source-derive.test.ts test/services/standins.test.ts
git commit -m "feat(catalog): rank stand-ins by similarity and infer the values a rung lacks on a bar's dimension"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 5: Unscored rungs warn with stand-ins to confirm, and a save may repair a profile (spec 1.2 §6.1, §6.2, §11; C-3; Rulings 9, 13, 14)

`validateProfile` no longer errs on an unscored rung or failover stand-in: a rung with no value and no stand-in is a warning (routing skips it), and a rung leaning on an inferred stand-in is a "stand-in to confirm" (Ruling 13). `repairs(before, after)` is spec §6.2's rule; `patchProfile` saves a repair and returns the errors still open, `profile set` prints them, the dashboard's save dialog offers Save for it, and `profile_set`'s description says so. `inferredScores` gains `note` ("agentic, steer borrowed from X" when the rung has values of its own), shown by `profile show` and the dashboard. `scores.json` gains the GPT-6 Luna treat-likes (Ruling 14), so the default profile has no warning (C-3).

**Files:**

- Modify: `catalog/scores.json`
- Modify: `src/domain/profile-rules.ts`
- Modify: `src/entry/mcp/setup-tools.ts`
- Modify: `src/entry/profile-command.ts`
- Modify: `src/entry/tui/fixtures.ts`
- Modify: `src/entry/tui/profile-edits.ts`
- Modify: `src/entry/tui/profile-tree.ts`
- Modify: `src/entry/tui/views/profile-actions.ts`
- Modify: `src/entry/tui/views/save-dialog.tsx`
- Modify: `src/services/profile-service.ts`
- Test: `test/domain/profile-rules.test.ts`
- Test: `test/entry/profile-command.test.ts`
- Test: `test/entry/tui/dialogs.test.tsx`
- Test: `test/entry/tui/profile-tree.test.ts`
- Test: `test/services/profile-service.test.ts`
- Test: `test/services/standins.test.ts`

**Interfaces:**
- Consumes: Task 4's `withStandIns`, `scoresOf(...).inferred/standIns`; `candidates`, `routingProfileOf`.
- Produces: `src/domain/profile-rules.ts`: `repairs(before: Validation | null, after: Validation): boolean`, `interface StandInToConfirm { canonical; rungs: string[]; path; dims: { dim; like }[] }`, `standInsToConfirm(p, c, backends): StandInToConfirm[]`, `standInMessage(x)`, `inferredScores(c, info)` → `{ inferred; via; note }`. `SavePreview.repair`. `StandIn.note` in `profile-command.ts`.

- [ ] **Step 1: Write the failing tests**

Edit `test/domain/profile-rules.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/domain/profile-rules.test.ts b/test/domain/profile-rules.test.ts
index fd03592..0f5030b 100644
--- a/test/domain/profile-rules.test.ts
+++ b/test/domain/profile-rules.test.ts
@@ -6,11 +6,19 @@ import {
   type ProfilePatch,
   resolveProfile,
 } from "../../src/domain/profile.ts";
-import { inferredScores, validateProfile } from "../../src/domain/profile-rules.ts";
+import {
+  inferredScores,
+  repairs,
+  standInsToConfirm,
+  validateProfile,
+} from "../../src/domain/profile-rules.ts";
+import { withStandIns } from "../../src/services/standins.ts";
 import { shipped } from "./shipped.ts";
 
 const BACKENDS = ["codex", "claude-code", "opencode", "claude"];
-const check = (patch: ProfilePatch = {}, c = shipped()) =>
+/** The catalog as loadCatalog serves it: the shipped files, with each rung's inferred stand-ins. */
+const catalog = (o: Parameters<typeof shipped>[0] = {}) => withStandIns(shipped(o));
+const check = (patch: ProfilePatch = {}, c = catalog()) =>
   validateProfile(resolveProfile(applyPatch(defaultProfileDoc(), patch), "p"), c, BACKENDS);
 const messages = (issues: { message: string }[]) => issues.map((i) => i.message);
 
@@ -34,15 +42,16 @@ describe("validateProfile", () => {
     expect(check({ roles: { writer: { rungs: [], enabled: false } } }).errors).toEqual([]);
   });
 
-  it("refuses an unscored rung until a treat-like maps it", () => {
+  it("warns, never errs, on an unscored rung no rung is near enough to stand in for (spec 1.2 §6.1)", () => {
     const rung = "opencode:opencode-go/glm-5.3#high";
     const bad = check({ roles: { reviewer: { rungs: ["codex:gpt-6-sol#high", rung] } } });
-    expect(bad.errors).toContainEqual({
+    expect(bad.errors).toEqual([]);
+    expect(bad.warnings).toContainEqual({
       path: "roles.reviewer.rungs",
-      message: `${rung} is unscored`,
+      message: `${rung} is unscored and no rung is near enough to stand in for it: routing skips it`,
       fix: `map it with: catherd catalog treat-like ${rung} <a scored rung>; catalog_query lists them`,
     });
-    const liked = shipped({
+    const liked = catalog({
       override: {
         schema: 1,
         treatLike: { "opencode-go/glm-5.3#high": "gpt-6-sol#high" },
@@ -50,9 +59,37 @@ describe("validateProfile", () => {
         bars: {},
       },
     });
-    expect(check({ roles: { reviewer: { rungs: ["codex:gpt-6-sol#high", rung] } } }, liked).errors).toEqual(
-      [],
-    );
+    const mapped = check({ roles: { reviewer: { rungs: ["codex:gpt-6-sol#high", rung] } } }, liked);
+    expect(mapped.errors).toEqual([]);
+    expect(messages(mapped.warnings).some((m) => m.includes("unscored"))).toBe(false);
+  });
+
+  it("lists a rung that leans on an inferred stand-in as a stand-in to confirm, once, where bars choose", () => {
+    // GPT-5.6 Terra has no repo_code, terminal or honesty value: its nearest stand-ins lend them
+    const terra = "opencode:opencode/gpt-5.6-terra#high";
+    const v = check({
+      roles: { worker: { rungs: ["codex:gpt-6-sol#medium", "codex:gpt-5.6-terra#high"] } },
+      failover: { "codex:gpt-6-sol#medium": terra },
+      billing: { opencode: "subscription" },
+    });
+    expect(v.errors).toEqual([]);
+    const c = catalog();
+    const lent = c.inferred["gpt-5.6-terra#high"];
+    expect(v.warnings.filter((w) => w.message.startsWith("stand-in to confirm"))).toEqual([
+      {
+        path: "roles.worker.rungs",
+        message: `stand-in to confirm: gpt-5.6-terra#high (codex:gpt-5.6-terra#high, ${terra}) has no repo_code, terminal or honesty value of its own; routing uses ${lent?.repo_code?.like}'s repo_code, ${lent?.terminal?.like}'s terminal, ${lent?.honesty?.like}'s honesty (inferred)`,
+        fix: "confirm or replace it: catherd catalog treat-like --suggest codex:gpt-5.6-terra#high, then catherd catalog treat-like codex:gpt-5.6-terra#high <a rung>",
+      },
+    ]);
+    // a role with one rung runs it whatever the bars say: nothing to confirm there
+    expect(
+      standInsToConfirm(
+        resolveProfile(applyPatch(defaultProfileDoc(), { roles: { reviewer: { rungs: [terra] } } }), "p"),
+        c,
+        BACKENDS,
+      ),
+    ).toEqual([]);
   });
 
   it("refuses a rung on a backend catherd cannot run yet, a bad effort, and an incapable model", () => {
@@ -86,22 +123,23 @@ describe("validateProfile", () => {
     ]);
   });
 
-  it("refuses a stand-in that is unscored or on the same quota, native claude and claude-code counting as one", () => {
-    const e = messages(
-      check({
-        failover: {
-          "codex:gpt-6-sol#high": "codex:gpt-6-luna#high",
-          "codex:gpt-6-sol#medium": "opencode:opencode-go/glm-5.3#high",
-          "claude:claude-opus-5-5#high": "claude-code:claude-opus-5-5#high",
-        },
-        roles: { architect: { rungs: ["claude:claude-opus-5-5#high"] } },
-      }).errors,
-    );
+  it("refuses a stand-in on the same quota, native claude and claude-code counting as one, and warns on an unscored one", () => {
+    const v = check({
+      failover: {
+        "codex:gpt-6-sol#high": "codex:gpt-6-luna#high",
+        "codex:gpt-6-sol#medium": "opencode:opencode-go/glm-5.3#high",
+        "claude:claude-opus-5-5#high": "claude-code:claude-opus-5-5#high",
+      },
+      roles: { architect: { rungs: ["claude:claude-opus-5-5#high"] } },
+    });
+    const e = messages(v.errors);
     expect(e).toEqual([
-      "stand-in opencode:opencode-go/glm-5.3#high is unscored",
       "stand-in codex:gpt-6-luna#high draws on the same quota as codex:gpt-6-sol#high, which is out when codex:gpt-6-sol#high hits its limit",
       "stand-in claude-code:claude-opus-5-5#high draws on the same quota as claude:claude-opus-5-5#high, which is out when claude:claude-opus-5-5#high hits its limit",
     ]);
+    expect(messages(v.warnings)).toContain(
+      "stand-in opencode:opencode-go/glm-5.3#high is unscored and no rung is near enough to stand in for it",
+    );
   });
 
   it("lets Go and Zen stand in for each other, since they bill apart", () => {
@@ -124,6 +162,8 @@ describe("validateProfile", () => {
       "downgrade: opencode:opencode-go/kimi-k3#max stands in for codex:gpt-6-astra#high, scoring below it on repo_code, terminal, honesty, agentic, frontend",
       "codex:gpt-6-astra#high is on no enabled role's ladder, so this never runs",
       "stand-in claude:claude-opus-5-5#high is a native subagent: the orchestrator must start it, dispatch cannot",
+      // no source publishes a Claude honesty value: Opus uses Sol's, inferred
+      "stand-in to confirm: claude-opus-5-5#high has no honesty value of its own; routing uses gpt-6-sol#high's honesty (inferred)",
     ]);
   });
 
@@ -204,11 +244,16 @@ describe("validateProfile: failover and ladder warnings (spec 1.1 §11)", () =>
         message: `stand-in ${OPUS_MAX} spends Claude quota, while ${GO_LUNA} could stand in on another plan`,
         fix: `catherd profile set failover.${LUNA} ${GO_LUNA}`,
       },
+      {
+        path: `failover.${LUNA}`,
+        message:
+          "stand-in to confirm: claude-opus-5-5#max has no honesty value of its own; routing uses gpt-6-sol#max's honesty (inferred)",
+        fix: `confirm or replace it: catherd catalog treat-like --suggest ${OPUS_MAX}, then catherd catalog treat-like ${OPUS_MAX} <a rung>`,
+      },
     ]);
     // with Go metered, nothing else is paid from a plan: the Claude stand-in is the only one
-    expect(check({ billing: { "opencode-go": "metered" }, failover: { [LUNA]: OPUS_MAX } }).warnings).toEqual(
-      [],
-    );
+    const metered = check({ billing: { "opencode-go": "metered" }, failover: { [LUNA]: OPUS_MAX } }).warnings;
+    expect(messages(metered).some((m) => m.includes("spends Claude quota"))).toBe(false);
   });
 
   it("warns where a ladder goes down: a rung scoring below the one before it and above it nowhere", () => {
@@ -217,7 +262,7 @@ describe("validateProfile: failover and ladder warnings (spec 1.1 §11)", () =>
     expect(v.errors).toEqual([]);
     expect(v.warnings).toContainEqual({
       path: "roles.worker.rungs",
-      message: `the ladder goes down at ${LUNA}: it scores below ${XHIGH} on terminal, honesty, frontend`,
+      message: `the ladder goes down at ${LUNA}: it scores below ${XHIGH} on terminal, honesty, agentic, steer, frontend`,
       fix: "order roles.worker.rungs weakest first",
     });
     // Luna high → Sol medium: lower on repo_code but higher on honesty, so not down (the default ladder)
@@ -226,17 +271,41 @@ describe("validateProfile: failover and ladder warnings (spec 1.1 §11)", () =>
 });
 
 describe("inferredScores", () => {
-  it("marks the default profile's Kimi stand-in inferred, and Go Luna and Sol not", () => {
-    const c = shipped();
+  it("marks both of the default profile's Go stand-ins inferred, saying what each borrows, and Sol not", () => {
+    const c = catalog();
     expect(inferredScores(c, rungInfo(c, "opencode:opencode-go/kimi-k3#max"))).toEqual({
       inferred: true,
       via: "gpt-6-sol#medium",
+      note: "scores borrowed from gpt-6-sol#medium",
     });
-    // Go Luna high carries Luna max's published values (adjacent): no longer only catherd's guesses
+    // Go Luna high has values of its own; the shipped treat-like lends only what no source publishes
     expect(inferredScores(c, rungInfo(c, "opencode:opencode-go/gpt-6-luna#high"))).toEqual({
-      inferred: false,
-      via: null,
+      inferred: true,
+      via: "gpt-5.6-luna#high",
+      note: "agentic, steer borrowed from gpt-5.6-luna#high",
     });
     expect(inferredScores(c, rungInfo(c, "codex:gpt-6-sol#high")).inferred).toBe(false);
+    // an inferred stand-in counts as catherd's guess too
+    expect(inferredScores(c, rungInfo(c, "codex:gpt-5.6-terra#high"))).toMatchObject({
+      inferred: true,
+      via: null,
+    });
+  });
+});
+
+describe("profile repair (spec 1.2 §6.2)", () => {
+  const e = (path: string, message: string) => ({ path, message });
+  const two = { errors: [e("a", "one"), e("b", "two")], warnings: [] };
+
+  it("lets a save through that removes one of two errors and adds none", () => {
+    expect(repairs(two, { errors: [e("b", "two")], warnings: [] })).toBe(true);
+    expect(repairs(two, { errors: [], warnings: [] })).toBe(true);
+  });
+
+  it("refuses one that adds an error, even while it removes another, or that removes none", () => {
+    expect(repairs(two, { errors: [e("b", "two"), e("c", "three")], warnings: [] })).toBe(false);
+    expect(repairs(two, two)).toBe(false);
+    // a profile that does not exist yet has no errors to repair
+    expect(repairs(null, { errors: [e("a", "one")], warnings: [] })).toBe(false);
   });
 });
````

Edit `test/entry/profile-command.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/entry/profile-command.test.ts b/test/entry/profile-command.test.ts
index 8a63341..9828675 100644
--- a/test/entry/profile-command.test.ts
+++ b/test/entry/profile-command.test.ts
@@ -1,6 +1,7 @@
 import { afterEach, describe, expect, it } from "bun:test";
 import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
 import { join } from "node:path";
+import { defaultProfileDoc } from "../../src/domain/profile.ts";
 import { claudeAgentsDir } from "../../src/infra/paths.ts";
 import { activeName, getProfile, profilesDir } from "../../src/services/profile-store.ts";
 import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
@@ -29,8 +30,10 @@ describe("catherd profile show", () => {
       "  reviewer     read-only, enforced          codex:gpt-6-sol#high",
     );
     expect(lines.find((l) => l.startsWith("  architect"))).toContain("read-only, advisory");
-    // Go's Luna has scores of its own (inferred ones): no label; Kimi K3 has none, so it borrows Sol medium's
-    expect(r.out).toContain("  codex:gpt-6-luna#high → opencode:opencode-go/gpt-6-luna#high\n");
+    // Go's Luna has scores of its own and borrows only agentic and steer; Kimi K3 has none, so it borrows Sol's
+    expect(r.out).toContain(
+      "  codex:gpt-6-luna#high → opencode:opencode-go/gpt-6-luna#high (agentic, steer borrowed from gpt-5.6-luna#high)\n",
+    );
     expect(r.out).toContain(
       "  codex:gpt-6-sol#medium → opencode:opencode-go/kimi-k3#max (scores borrowed from gpt-6-sol#medium)\n",
     );
@@ -57,6 +60,7 @@ describe("catherd profile show", () => {
       to: "opencode:opencode-go/kimi-k3#max",
       inferred: true,
       via: "gpt-6-sol#medium",
+      note: "scores borrowed from gpt-6-sol#medium",
     });
   });
 });
@@ -88,6 +92,28 @@ describe("catherd profile set", () => {
     expect(existsSync(join(profilesDir(), "default.json"))).toBe(false);
   });
 
+  it("saves a repair of an invalid profile, and lists the errors still open (spec 1.2 §6.2)", () => {
+    withHome();
+    mkdirSync(profilesDir(), { recursive: true });
+    const doc = defaultProfileDoc();
+    const broken = {
+      ...doc,
+      roles: { ...doc.roles, worker: { ...doc.roles?.worker, enabled: false } },
+      failover: { "codex:gpt-6-sol#high": "codex:gpt-6-luna#high" },
+    };
+    writeFileSync(join(profilesDir(), "default.json"), JSON.stringify(broken));
+    const r = catherd(["set", "roles.worker.enabled", "true"]);
+    expect(r.code).toBe(0);
+    expect(r.out).toStartWith(
+      [
+        "✓ roles.worker.enabled: false → true",
+        "! saved; 1 error is still open:",
+        "✗ failover.codex:gpt-6-sol#high: stand-in codex:gpt-6-luna#high draws on the same quota as codex:gpt-6-sol#high, which is out when codex:gpt-6-sol#high hits its limit",
+      ].join("\n"),
+    );
+    expect(getProfile("default").roles.worker.enabled).toBe(true);
+  });
+
   it("refuses an unknown path with exit 2", () => {
     withHome();
     const r = catherd(["set", "roles.worker.colour", "red"]);
@@ -161,7 +187,7 @@ describe("catherd profile use, new, copy, rm, list, diff", () => {
     expect([r.code, r.out]).toEqual([1, ""]);
     const [line, fix, rest] = r.err.split("\n");
     expect(line).toStartWith("error E_CONFIG_INVALID: the profile was not saved: roles.reviewer.rungs: ");
-    expect(line).toContain("codex:gpt-6-sol#turbo is unscored");
+    expect(line).toContain('gpt-6-sol has no effort "turbo" on codex');
     expect(fix).toStartWith("fix: ");
     expect(rest).toBe("");
     expect(existsSync(join(profilesDir(), "x.json"))).toBe(false);
@@ -242,7 +268,11 @@ describe("catherd profile validate", () => {
     writeFileSync(join(profilesDir(), "bad.json"), JSON.stringify(doc));
     const r = catherd(["validate", "bad"]);
     expect(r.code).toBe(1);
-    expect(r.out).toContain("✗ roles.reviewer.rungs: codex:gpt-6-sol#turbo is unscored\n");
+    expect(r.out).toContain('✗ roles.reviewer.rungs: gpt-6-sol has no effort "turbo" on codex');
+    // spec 1.2 §6.1: unscored is a warning, never an error
+    expect(r.out).toContain(
+      "! roles.reviewer.rungs: codex:gpt-6-sol#turbo is unscored and no rung is near enough to stand in for it: routing skips it\n",
+    );
     expect(r.out).toContain(
       "! roles.verifier.access: verifier runs read-only; catherd's default for it is full\n",
     );
````

Edit `test/entry/tui/dialogs.test.tsx` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/entry/tui/dialogs.test.tsx b/test/entry/tui/dialogs.test.tsx
index 22c2254..e0dcf86 100644
--- a/test/entry/tui/dialogs.test.tsx
+++ b/test/entry/tui/dialogs.test.tsx
@@ -4,7 +4,7 @@ import { fixtureEffects } from "../../../src/entry/tui/fixtures.ts";
 import { useApp, useDialogHandler } from "../../../src/entry/tui/providers/app.tsx";
 import { DataProvider } from "../../../src/entry/tui/providers/data.tsx";
 import { useCommandLayer } from "../../../src/entry/tui/providers/keymap.tsx";
-import { defaultProfileDoc, type ProfilePatch } from "../../../src/domain/profile.ts";
+import { applyPatch, defaultProfileDoc, type ProfilePatch } from "../../../src/domain/profile.ts";
 import {
   type Action,
   type AppState,
@@ -227,6 +227,28 @@ describe("SaveDialog (spec §9.2)", () => {
     expect(answers).toEqual(["save"]);
   });
 
+  it("offers Save for a repair: a save that fixes one error of an invalid profile and adds none (spec 1.2 §6.2)", async () => {
+    const effects = fixtureEffects();
+    // the stored profile has two errors: the writer has no rung, and a stand-in shares its rung's quota
+    const read = effects.readProfile;
+    effects.readProfile = (n) =>
+      applyPatch(read(n), {
+        roles: { writer: { rungs: [] } },
+        failover: { "codex:gpt-6-sol#high": "codex:gpt-6-luna#high" },
+      });
+    // the draft names a stand-in on another quota: one error fixed, none added
+    const answers = await save(
+      { failover: { "codex:gpt-6-sol#high": "opencode:opencode-go/kimi-k3#max" } },
+      effects,
+    );
+    const f = h!.s.frame();
+    expect(f).toContain("This save fixes an error and adds none; these stay open:");
+    expect(f).toContain("✗ roles.writer.rungs: the writer role has no usable rung");
+    expect(f).toContain("[ Save ]  [ Save & make active ]  [ Cancel ]");
+    await h!.s.press("return");
+    expect(answers).toEqual(["save"]);
+  });
+
   it("answers activate from the second button, and cancels from the third", async () => {
     const answers = await save({ budget: { usd: 5 } });
     await h!.s.press("right", "return");
@@ -280,9 +302,6 @@ describe("SaveDialog (spec §9.2)", () => {
     const f = h!.s.frame();
     for (const e of [
       "✗ roles.worker.enabled: the worker cannot be disabled",
-      "✗ roles.architect.rungs: codex:nope#high is unscored",
-      "✗ roles.verifier.rungs: claude:nope#low is unscored",
-      "✗ roles.reviewer.rungs: codex:zzz#high is unscored",
       "✗ roles.reviewer.rungs: the reviewer role has no usable rung",
     ])
       expect(f).toContain(e);
````

Edit `test/entry/tui/profile-tree.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/entry/tui/profile-tree.test.ts b/test/entry/tui/profile-tree.test.ts
index 9f8fc27..54c5366 100644
--- a/test/entry/tui/profile-tree.test.ts
+++ b/test/entry/tui/profile-tree.test.ts
@@ -135,7 +135,9 @@ describe("the Profiles tree (spec §9.1)", () => {
       "→ kimi-k3#max (scores borrowed from gpt-6-sol#medium)",
     );
     expect(row(rows, "failover:codex:gpt-6-sol#high").value).toBe("none");
-    expect(row(rows, "failover:codex:gpt-6-luna#high").value).toBe("→ gpt-6-luna#high");
+    expect(row(rows, "failover:codex:gpt-6-luna#high").value).toBe(
+      "→ gpt-6-luna#high (agentic, steer borrowed from gpt-5.6-luna#high)",
+    );
   });
 
   it("puts a validation issue on the row it is about", () => {
@@ -229,7 +231,9 @@ describe("edits", () => {
     // Opus high has values of its own now (carried from xhigh and max): nothing borrowed
     expect(standIns.find((o) => o.value === "claude-code:claude-opus-5-5#high")?.detail).toBe("");
     expect(standIns.find((o) => o.value === "claude-code:claude-opus-5-5#xhigh")?.detail).toBe("");
-    expect(standIns.find((o) => o.value === "opencode:opencode-go/gpt-6-luna#high")?.detail).toBe("");
+    expect(standIns.find((o) => o.value === "opencode:opencode-go/gpt-6-luna#high")?.detail).toBe(
+      "agentic, steer borrowed from gpt-5.6-luna#high",
+    );
     const likes = treatLikeOptions(c);
     expect(likes.map((o) => o.value)).toContain("gpt-6-sol#medium");
     // a rung that borrows through a treat-like lends nothing of its own
````

Edit `test/services/profile-service.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/profile-service.test.ts b/test/services/profile-service.test.ts
index 2ef053e..2cfef8f 100644
--- a/test/services/profile-service.test.ts
+++ b/test/services/profile-service.test.ts
@@ -116,6 +116,38 @@ describe("patchProfile", () => {
     expect(JSON.parse(readFileSync(file("default"), "utf8")).roles.reviewer.access).toBe("network-off");
   });
 
+  it("saves a repair: a patch that removes one of two errors and adds none, listing the one still open", () => {
+    withHome();
+    mkdirSync(profilesDir(), { recursive: true });
+    const doc = defaultProfileDoc();
+    // two errors, as a hand edit (or a catherd before 1.2) could leave them
+    const broken = { ...doc, roles: { ...doc.roles, worker: { ...doc.roles?.worker, enabled: false } } };
+    writeFileSync(
+      file("default"),
+      JSON.stringify({ ...broken, failover: { "codex:gpt-6-sol#high": "codex:gpt-6-luna#high" } }),
+    );
+    expect(validateNamed("default").errors).toHaveLength(2);
+    const r = patchProfile("default", { roles: { worker: { enabled: true } } });
+    expect(r.saved).toBe(true);
+    expect(r.errors.map((e) => e.message)).toEqual([
+      "stand-in codex:gpt-6-luna#high draws on the same quota as codex:gpt-6-sol#high, which is out when codex:gpt-6-sol#high hits its limit",
+    ]);
+    expect(JSON.parse(readFileSync(file("default"), "utf8")).roles.worker.enabled).toBe(true);
+  });
+
+  it("refuses a patch that adds an error, even one that removes another", () => {
+    withHome();
+    mkdirSync(profilesDir(), { recursive: true });
+    const doc = defaultProfileDoc();
+    const broken = { ...doc, roles: { ...doc.roles, worker: { ...doc.roles?.worker, enabled: false } } };
+    writeFileSync(file("default"), JSON.stringify(broken));
+    const before = readFileSync(file("default"), "utf8");
+    const r = patchProfile("default", { roles: { worker: { enabled: true }, writer: { rungs: [] } } });
+    expect(r.saved).toBe(false);
+    expect(r.errors.map((e) => e.message)).toEqual(["the writer role has no usable rung"]);
+    expect(readFileSync(file("default"), "utf8")).toBe(before);
+  });
+
   it("writes nothing when the result is invalid, and returns the errors", () => {
     withHome();
     patchProfile("default", {});
````

Edit `test/services/standins.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/standins.test.ts b/test/services/standins.test.ts
index 9ba45cc..13e030e 100644
--- a/test/services/standins.test.ts
+++ b/test/services/standins.test.ts
@@ -116,10 +116,12 @@ describe("inferred values in the catalog (spec 1.2 §6.1)", () => {
     expect(c.inferred["gpt-6-sol#medium"]).toBeUndefined();
     // Kimi K3 borrows everything through its shipped treat-like: nothing to infer either
     expect(c.inferred["opencode-go/kimi-k3#max"]).toBeUndefined();
-    // GPT-6 Luna has no agentic value in any source: a stand-in lends one, as inferred
-    const luna = scoresOf(c, "gpt-6-luna#high");
-    expect(luna?.inferred).toEqual(["agentic"]);
-    expect(luna?.standIns.agentic).toBe(c.inferred["gpt-6-luna#high"]?.agentic?.like);
+    // GPT-6 Luna's missing agentic value comes from its shipped treat-like, not a guess
+    expect(scoresOf(c, "gpt-6-luna#high")?.inferred).toEqual([]);
+    // GPT-5.6 Terra has no repo_code, terminal or honesty value: stand-ins lend them, as inferred
+    const terra = scoresOf(c, "gpt-5.6-terra#high");
+    expect(terra?.inferred).toEqual(["repo_code", "terminal", "honesty"]);
+    expect(terra?.standIns.repo_code).toBe(c.inferred["gpt-5.6-terra#high"]?.repo_code?.like);
     // steer carries no bar: never inferred
     expect(Object.values(c.inferred).some((x) => x.steer)).toBe(false);
   });
@@ -128,6 +130,6 @@ describe("inferred values in the catalog (spec 1.2 §6.1)", () => {
     withHome();
     const c = loadCatalog({ timings: false });
     expect(c.inferred).toEqual(inferStandIns({ ...c, inferred: {} }));
-    expect(scoresOf(c, "gpt-6-luna#high")?.values.agentic).toBeDefined();
+    expect(scoresOf(c, "gpt-5.6-terra#high")?.values.repo_code).toBeDefined();
   });
 });
````

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/domain/profile-rules.test.ts test/services/profile-service.test.ts test/services/standins.test.ts test/entry/profile-command.test.ts test/entry/tui/dialogs.test.tsx test/entry/tui/profile-tree.test.ts`
Expected: FAIL — `repairs` and `standInsToConfirm` are not exported; unscored rungs are still errors; a repair is refused.

- [ ] **Step 3: Implement**

`catalog/scores.json`'s diff adds six treat-likes after Kimi K3's (oxfmt keeps the file's format); `sha256sum catalog/scores.json` afterwards: `bdcf48d7b9fe3ef5214ab18caeca72a4e62a1a69a18df3e3a3bbd570a75e7813`.

Edit `catalog/scores.json` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/catalog/scores.json b/catalog/scores.json
index d9d8640..b2c8608 100644
--- a/catalog/scores.json
+++ b/catalog/scores.json
@@ -3029,6 +3029,30 @@
     "opencode-go/kimi-k3#max": {
       "like": "gpt-6-sol#medium",
       "note": "the default profile's OpenCode Go stand-in for Sol; no DeepSWE 1.1, Terminal-Bench 4.0 or honesty score is published for it"
+    },
+    "gpt-6-luna#none": {
+      "like": "gpt-5.6-luna#none",
+      "note": "no Arena agent score is published for GPT-6 Luna; GPT-5.6 Luna at the same effort stands in for agentic and steer (the nearest stand-in, spec 1.2 §6.3)"
+    },
+    "gpt-6-luna#low": {
+      "like": "gpt-5.6-luna#low",
+      "note": "no Arena agent score is published for GPT-6 Luna; GPT-5.6 Luna at the same effort stands in for agentic and steer (the nearest stand-in, spec 1.2 §6.3)"
+    },
+    "gpt-6-luna#medium": {
+      "like": "gpt-5.6-luna#medium",
+      "note": "no Arena agent score is published for GPT-6 Luna; GPT-5.6 Luna at the same effort stands in for agentic and steer (the nearest stand-in, spec 1.2 §6.3)"
+    },
+    "gpt-6-luna#high": {
+      "like": "gpt-5.6-luna#high",
+      "note": "no Arena agent score is published for GPT-6 Luna; GPT-5.6 Luna at the same effort stands in for agentic and steer (the nearest stand-in, spec 1.2 §6.3)"
+    },
+    "gpt-6-luna#xhigh": {
+      "like": "gpt-5.6-luna#xhigh",
+      "note": "no Arena agent score is published for GPT-6 Luna; GPT-5.6 Luna at the same effort stands in for agentic and steer (the nearest stand-in, spec 1.2 §6.3)"
+    },
+    "gpt-6-luna#max": {
+      "like": "gpt-5.6-luna#max",
+      "note": "no Arena agent score is published for GPT-6 Luna; GPT-5.6 Luna at the same effort stands in for agentic and steer (the nearest stand-in, spec 1.2 §6.3)"
     }
   },
   "bars": {
````

Edit `src/domain/profile-rules.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/profile-rules.ts b/src/domain/profile-rules.ts
index bb58f5b..21aaaf8 100644
--- a/src/domain/profile-rules.ts
+++ b/src/domain/profile-rules.ts
@@ -1,5 +1,6 @@
 import {
   type Catalog,
+  type Dim,
   capableFor,
   effortOffered,
   ROLE_NEEDS,
@@ -37,6 +38,71 @@ export interface Validation {
 
 const TREAT_LIKE_FIX = (rung: string) =>
   `map it with: catherd catalog treat-like ${rung} <a scored rung>; catalog_query lists them`;
+const SUGGEST_FIX = (rung: string) =>
+  `confirm or replace it: catherd catalog treat-like --suggest ${rung}, then catherd catalog treat-like ${rung} <a rung>`;
+
+/** Spec 1.2 §6.2: two findings are the same one when they name the same path with the same message. */
+const sameIssue = (a: Issue, b: Issue): boolean => a.path === b.path && a.message === b.message;
+
+/**
+ * Spec 1.2 §6.2: a save that leaves errors goes through when it removes at least one of the errors the
+ * profile had and adds none. `before` is the stored profile's validation, null when it does not exist yet.
+ */
+export function repairs(before: Validation | null, after: Validation): boolean {
+  if (after.errors.length === 0) return true;
+  if (!before) return false;
+  const added = after.errors.some((e) => !before.errors.some((b) => sameIssue(b, e)));
+  const removed = before.errors.some((b) => !after.errors.some((e) => sameIssue(b, e)));
+  return removed && !added;
+}
+
+/** Spec 1.2 §6.1 "stand-in to confirm": a rung whose values on some bar dimensions are an inferred stand-in's. */
+export interface StandInToConfirm {
+  canonical: string;
+  /** the profile's rungs that run it, and where the first one is */
+  rungs: string[];
+  path: string;
+  dims: { dim: Dim; like: string }[];
+}
+
+/**
+ * Spec 1.2 §6.1: the profile's rungs that lean on an inferred stand-in, one entry per canonical rung. Only
+ * where bars choose: rungs of a role with more than one usable rung, and failover stand-ins; a role with one
+ * rung runs it whatever the bars say (plan 14 Ruling 13).
+ */
+export function standInsToConfirm(p: Profile, c: Catalog, backends: readonly string[]): StandInToConfirm[] {
+  const seen = new Map<string, StandInToConfirm>();
+  const add = (rung: string, path: string) => {
+    const r = tryParseRung(rung);
+    if (!r || !backends.includes(r.backend)) return;
+    const info = rungInfo(c, rung);
+    const s = scoresOf(c, info.canonical);
+    if (!s || s.inferred.length === 0) return;
+    const had = seen.get(info.canonical);
+    if (had) {
+      if (!had.rungs.includes(rung)) had.rungs.push(rung);
+      return;
+    }
+    const dims = s.inferred.map((dim) => ({ dim, like: s.standIns[dim] as string }));
+    seen.set(info.canonical, { canonical: info.canonical, rungs: [rung], path, dims });
+  };
+  for (const role of ROLES) {
+    const rc = p.roles[role];
+    if (!rc.enabled || candidates(c, routingProfileOf(p, role), role).length < 2) continue;
+    for (const rung of rc.rungs) add(rung, `roles.${role}.rungs`);
+  }
+  for (const [from, to] of Object.entries(p.failover)) add(to, `failover.${from}`);
+  return [...seen.values()];
+}
+
+/** One "stand-in to confirm" warning's words. */
+export function standInMessage(x: StandInToConfirm): string {
+  const words = (xs: string[]) =>
+    xs.length < 3 ? xs.join(" or ") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`;
+  const lent = x.dims.map((d) => `${d.like}'s ${d.dim}`).join(", ");
+  const also = x.rungs.length > 1 ? ` (${x.rungs.join(", ")})` : "";
+  return `stand-in to confirm: ${x.canonical}${also} has no ${words(x.dims.map((d) => d.dim))} value of its own; routing uses ${lent} (inferred)`;
+}
 
 export const routingProfileOf = (p: Profile, role: Role): RoutingProfile => ({
   objective: p.objective,
@@ -44,22 +110,35 @@ export const routingProfileOf = (p: Profile, role: Role): RoutingProfile => ({
   role: p.roles[role],
 });
 
-/** Whether a rung's scores are catherd's guess: borrowed through a treat-like, or only `inferred` ones. */
-export function inferredScores(c: Catalog, info: RungInfo): { inferred: boolean; via: string | null } {
+/**
+ * Whether a rung's scores are catherd's guess: borrowed through a treat-like, filled by an inferred stand-in
+ * (spec 1.2 §6.1), or only `inferred` ones. `note` says what a treat-like lends: "scores borrowed from X"
+ * when the rung has no value of its own, else the dimensions it borrows (a rung a sync scored on some).
+ */
+export function inferredScores(
+  c: Catalog,
+  info: RungInfo,
+): { inferred: boolean; via: string | null; note: string | null } {
   const s = scoresOf(c, info.canonical);
-  if (!s) return { inferred: false, via: null };
+  if (!s) return { inferred: false, via: null, note: null };
   const records = Object.values(s.records);
-  return { inferred: s.via !== null || records.every((r) => r.confidence === "inferred"), via: s.via };
+  const guessed =
+    s.via !== null || s.inferred.length > 0 || records.every((r) => r.confidence === "inferred");
+  const all = s.borrowed.length + s.inferred.length === records.length;
+  const note = s.via ? `${all ? "scores" : s.borrowed.join(", ")} borrowed from ${s.via}` : null;
+  return { inferred: guessed, via: s.via, note };
 }
 
 /**
- * Spec §7.1. Errors: the worker disabled; an enabled role with no usable rung; an unscored rung without a
- * treat-like; a failover stand-in unscored or on the same quota; a rung whose backend catherd cannot run
- * (`backends` lists those it can, `claude` included). Everything else worth knowing is a warning: an access
- * mode other than the role's default, an effort or model the last listing does not offer, a stand-in
- * that never runs, and (spec 1.1 §11) a stand-in that downgrades its rung, one that spends Claude quota
- * while another plan could stand in, and a ladder that goes down. With the stored `doc` `p` came from, a value this catherd does not know is also a
- * warning, one that says how the value is read.
+ * Spec §7.1. Errors: the worker disabled; an enabled role with no usable rung; a failover stand-in on the
+ * same quota; a rung whose backend catherd cannot run (`backends` lists those it can, `claude` included).
+ * Everything else worth knowing is a warning: an access mode other than the role's default, an effort or
+ * model the last listing does not offer, a stand-in that never runs, (spec 1.1 §11) a stand-in that
+ * downgrades its rung, one that spends Claude quota while another plan could stand in, and a ladder that goes
+ * down, and (spec 1.2 §6.1) an unscored rung or stand-in, never an error: a rung that leans on an inferred
+ * stand-in is a "stand-in to confirm", and one with no value and no stand-in is skipped by routing. With the
+ * stored `doc` `p` came from, a value this catherd does not know is also a warning, one that says how the
+ * value is read.
  */
 export function validateProfile(
   p: Profile,
@@ -133,7 +212,11 @@ export function validateProfile(
           message: `${r.backend}'s last listing does not offer ${r.model}; routing skips it`,
         });
       if (!scoresOf(c, info.canonical))
-        errors.push({ path: `${at}.rungs`, message: `${rung} is unscored`, fix: TREAT_LIKE_FIX(rung) });
+        warnings.push({
+          path: `${at}.rungs`,
+          message: `${rung} is unscored and no rung is near enough to stand in for it: routing skips it`,
+          fix: TREAT_LIKE_FIX(rung),
+        });
     }
     rc.rungs.forEach((rung, i) => {
       const prev = rc.rungs[i - 1];
@@ -206,7 +289,11 @@ export function validateProfile(
       continue;
     }
     if (!scoresOf(c, rungInfo(c, to).canonical))
-      errors.push({ path: at, message: `stand-in ${to} is unscored`, fix: TREAT_LIKE_FIX(to) });
+      warnings.push({
+        path: at,
+        message: `stand-in ${to} is unscored and no rung is near enough to stand in for it`,
+        fix: TREAT_LIKE_FIX(to),
+      });
     if (quotaOf(a) === quotaOf(b))
       errors.push({
         path: at,
@@ -236,5 +323,7 @@ export function validateProfile(
     if (!ladders.has(from))
       warnings.push({ path: at, message: `${from} is on no enabled role's ladder, so this never runs` });
   }
+  for (const x of standInsToConfirm(p, c, backends))
+    warnings.push({ path: x.path, message: standInMessage(x), fix: SUGGEST_FIX(x.rungs[0] as string) });
   return { errors, warnings };
 }
````

Edit `src/entry/mcp/setup-tools.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/mcp/setup-tools.ts b/src/entry/mcp/setup-tools.ts
index 500f474..5c24d9f 100644
--- a/src/entry/mcp/setup-tools.ts
+++ b/src/entry/mcp/setup-tools.ts
@@ -95,7 +95,7 @@ export function registerSetupTools(server: McpServer, deps: Deps): void {
     "profile_set",
     {
       description:
-        "Apply a patch to a profile (without a name: the profile this repo runs on, as in profile_get; a new name starts from the default profile): objective, jev.use, billing, roles (enabled, access, network, rungs, defaultRung), harness isolation per backend, failover, budget, timeouts, preflight.confirm, lock.heavy and notify. Lists replace, maps merge, and null removes a key. An unknown key is refused. It validates first and writes nothing when invalid; otherwise it saves, rewrites the agent files and relinks them. Returns the errors and warnings, the diff, and newSessionNeededFor: the agents that apply from the next Claude Code session.",
+        "Apply a patch to a profile (without a name: the profile this repo runs on, as in profile_get; a new name starts from the default profile): objective, jev.use, billing, roles (enabled, access, network, rungs, defaultRung), harness isolation per backend, failover, budget, timeouts, preflight.confirm, lock.heavy and notify. Lists replace, maps merge, and null removes a key. An unknown key is refused. It validates first and writes nothing when invalid, unless the patch repairs an invalid profile: it fixes at least one of its errors and adds none, and then it saves with `errors` listing those still open. A save rewrites the agent files and relinks them. Returns saved, the errors and warnings, the diff, and newSessionNeededFor: the agents that apply from the next Claude Code session.",
       inputSchema: { name: PROFILE, repo: REPO, patch: ProfilePatchSchema },
     },
     (a) => handle(async () => deps.profiles.set(a.name, a.patch, await toplevel(a.repo))),
````

Edit `src/entry/profile-command.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/profile-command.ts b/src/entry/profile-command.ts
index a1af8a3..da82598 100644
--- a/src/entry/profile-command.ts
+++ b/src/entry/profile-command.ts
@@ -38,6 +38,8 @@ export interface StandIn {
   to: string;
   inferred: boolean;
   via: string | null;
+  /** what the treat-like lends, as `profile show` says it */
+  note: string | null;
 }
 
 /** Spec §7.2: each stand-in; `via` names the rung whose scores it borrows (spec 1.1 §11). */
@@ -46,7 +48,7 @@ export function standIns(p: Profile, c: Catalog): StandIn[] {
     try {
       return { from, to, ...inferredScores(c, rungInfo(c, to)) };
     } catch {
-      return { from, to, inferred: false, via: null };
+      return { from, to, inferred: false, via: null, note: null };
     }
   });
 }
@@ -93,8 +95,7 @@ export function formatProfile(
   const harness = Object.entries(p.harness).filter(runs);
   lines.push(`harness ${harness.map(([k, h]) => `${k} ${h.isolated ? "isolated" : "native"}`).join(" · ")}`);
   lines.push(o.standIns.length ? "failover" : "failover none");
-  for (const s of o.standIns)
-    lines.push(`  ${s.from} → ${s.to}${s.via ? ` (scores borrowed from ${s.via})` : ""}`);
+  for (const s of o.standIns) lines.push(`  ${s.from} → ${s.to}${s.note ? ` (${s.note})` : ""}`);
   const budget = Object.entries(p.budget).map(([k, v]) => (k === "usd" ? `$${v}` : `${v} ${k}`));
   lines.push(`budget ${budget.join(" · ") || "no cap"}`);
   lines.push(`timeouts idle ${p.timeouts.idleMin} min · wall ${p.timeouts.wallMin} min`);
@@ -265,7 +266,12 @@ const set = defineCommand({
     if (!r.saved) throw refused(r.errors);
     if (r.diff.length === 0) console.log("no change");
     for (const c of r.diff) console.log(`${mark("ok")} ${formatChange(c)}`);
-    printIssues([], r.warnings);
+    // spec 1.2 §6.2: a save that repairs part of an invalid profile goes through; it lists what is still open
+    if (r.errors.length)
+      console.log(
+        `${mark("warn")} saved; ${r.errors.length} ${r.errors.length === 1 ? "error is" : "errors are"} still open:`,
+      );
+    printIssues(r.errors, r.warnings);
     printSynced(r);
   },
 });
````

Edit `src/entry/tui/fixtures.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/tui/fixtures.ts b/src/entry/tui/fixtures.ts
index a89db07..475273d 100644
--- a/src/entry/tui/fixtures.ts
+++ b/src/entry/tui/fixtures.ts
@@ -6,7 +6,7 @@ import {
   type ProfileDoc,
   resolveProfile,
 } from "../../domain/profile.ts";
-import { validateProfile } from "../../domain/profile-rules.ts";
+import { repairs, validateProfile } from "../../domain/profile-rules.ts";
 import { catalogQuery, loadCatalog } from "../../services/catalog-service.ts";
 import type { RunRecord } from "../../domain/record.ts";
 import type { DoctorReport } from "../../services/doctor.ts";
@@ -425,9 +425,12 @@ export function fixtureEffects(o: FixtureOptions = {}): Effects & {
     staged: Record<string, string> = {},
   ) => {
     const p = resolveProfile(after, name);
-    const v = validateProfile(p, withStaged(loadCatalog({ timings: false }), staged), BACKENDS);
+    const c = withStaged(loadCatalog({ timings: false }), staged);
+    const v = validateProfile(p, c, BACKENDS);
+    // spec 1.2 §6.2, as the ProfileService rules: a save that repairs part of an invalid profile goes through
+    const was = docs.has(name) ? validateProfile(resolveProfile(before, name), c, BACKENDS) : null;
     return {
-      saved: v.errors.length === 0,
+      saved: repairs(was, v),
       ...v,
       diff: diffProfiles(resolveProfile(before, name), p),
       linked: [],
````

Edit `src/entry/tui/profile-edits.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/tui/profile-edits.ts b/src/entry/tui/profile-edits.ts
index afb5ce0..effb07b 100644
--- a/src/entry/tui/profile-edits.ts
+++ b/src/entry/tui/profile-edits.ts
@@ -113,12 +113,12 @@ export function failoverOptions(
       if (!(r.enabled || usable(r.rung)) || r.rung.startsWith("claude:")) continue;
       const q = quotaOf(parseRung(r.rung));
       if (q === quota) continue;
-      const via = inferredScores(c, rungInfo(c, r.rung)).via;
+      const note = inferredScores(c, rungInfo(c, r.rung)).note;
       out.push({
         value: r.rung,
         title: shortRung(r.rung),
         group: m.billing,
-        detail: via ? `scores borrowed from ${via}` : "",
+        detail: note ?? "",
         current: r.rung === cur,
       });
     }
````

Edit `src/entry/tui/profile-tree.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/tui/profile-tree.ts b/src/entry/tui/profile-tree.ts
index 4f0700a..bcd7e59 100644
--- a/src/entry/tui/profile-tree.ts
+++ b/src/entry/tui/profile-tree.ts
@@ -350,8 +350,8 @@ export function buildRows(i: TreeInput): Row[] {
     let mark = "";
     if (to) {
       try {
-        const via = inferredScores(i.catalog, rungInfo(i.catalog, to)).via;
-        mark = via ? ` (scores borrowed from ${via})` : "";
+        const note = inferredScores(i.catalog, rungInfo(i.catalog, to)).note;
+        mark = note ? ` (${note})` : "";
       } catch {
         mark = "";
       }
````

Edit `src/entry/tui/views/profile-actions.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/tui/views/profile-actions.ts b/src/entry/tui/views/profile-actions.ts
index 33551c3..ff4e562 100644
--- a/src/entry/tui/views/profile-actions.ts
+++ b/src/entry/tui/views/profile-actions.ts
@@ -314,7 +314,15 @@ export function useProfileDialogs(): void {
     } catch (e) {
       fail(app, e);
     }
-    app.toast({ variant: "success", message: `Saved profile ${p.name}` });
+    // spec 1.2 §6.2: a save that repaired part of an invalid profile says what is still open
+    app.toast(
+      r.errors.length
+        ? {
+            variant: "warning",
+            message: `Saved profile ${p.name}; ${r.errors.length} ${r.errors.length === 1 ? "error" : "errors"} still open`,
+          }
+        : { variant: "success", message: `Saved profile ${p.name}` },
+    );
     sessionsNeeded(app, r.newSessionNeededFor);
     if (value === "activate") activateNow(app, data, p.name, shown);
   });
````

Edit `src/entry/tui/views/save-dialog.tsx` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/tui/views/save-dialog.tsx b/src/entry/tui/views/save-dialog.tsx
index 22718e8..e28e1c8 100644
--- a/src/entry/tui/views/save-dialog.tsx
+++ b/src/entry/tui/views/save-dialog.tsx
@@ -9,7 +9,7 @@ import {
   patchBetween,
   resolveProfile,
 } from "../../../domain/profile.ts";
-import type { Validation } from "../../../domain/profile-rules.ts";
+import { repairs, type Validation } from "../../../domain/profile-rules.ts";
 import type { Effects } from "../effects.ts";
 import { useApp } from "../providers/app.tsx";
 import { useData, useLoad } from "../providers/data.tsx";
@@ -36,6 +36,8 @@ export interface SavePreview {
   changes: Change[];
   treatLikes: [string, string][];
   validation: Validation;
+  /** spec 1.2 §6.2: the save leaves errors but removes one of the stored profile's and adds none */
+  repair: boolean;
   agentsAdded: string[];
   agentsRemoved: string[];
 }
@@ -54,10 +56,13 @@ function previewSave(
   const { catalog } = fx.catalog(after.billing);
   const a = new Set(fx.agents(before));
   const b = new Set(fx.agents(after));
+  const staged = withStaged(catalog, d.treatLikes);
+  const validation = fx.validate(after, staged);
   return {
     changes: diffProfiles(before, after),
     treatLikes: Object.entries(d.treatLikes),
-    validation: fx.validate(after, withStaged(catalog, d.treatLikes)),
+    validation,
+    repair: validation.errors.length > 0 && repairs(fx.validate(before, staged), validation),
     agentsAdded: [...b].filter((x) => !a.has(x)),
     agentsRemoved: [...a].filter((x) => !b.has(x)),
   };
@@ -200,7 +205,8 @@ export function SaveDialog(props: { dialog: Save }) {
     setChanged(true);
     return { same: false, now: doc };
   };
-  const blocked = error !== null || (preview?.validation.errors.length ?? 0) > 0;
+  // spec 1.2 §6.2: a save that repairs part of an invalid profile is offered; any other error leaves Cancel
+  const blocked = error !== null || ((preview?.validation.errors.length ?? 0) > 0 && !preview?.repair);
   // spec §9.2's order: Save / Save & make active / Cancel; errors leave only Cancel
   const labels = blocked ? ["Cancel"] : ["Save", "Save & make active", "Cancel"];
   const [focused, setFocusedState] = useState(0);
@@ -272,7 +278,9 @@ export function SaveDialog(props: { dialog: Save }) {
         ],
       },
       {
-        head: [[]],
+        head: preview.repair
+          ? [[], ...text("This save fixes an error and adds none; these stay open:", "warning")]
+          : [[]],
         hold: "error",
         more: (n) => `… and ${n} more ${n === 1 ? "error" : "errors"}`,
         items: preview.validation.errors.map((e) =>
````

Edit `src/services/profile-service.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/profile-service.ts b/src/services/profile-service.ts
index ebc7482..21582c1 100644
--- a/src/services/profile-service.ts
+++ b/src/services/profile-service.ts
@@ -15,7 +15,7 @@ import {
   type ProfilePatch,
   resolveProfile,
 } from "../domain/profile.ts";
-import { type Validation, validateProfile } from "../domain/profile-rules.ts";
+import { repairs, type Validation, validateProfile } from "../domain/profile-rules.ts";
 import { ROLES } from "../domain/roles.ts";
 import { withFileLockSync } from "../infra/filelock.ts";
 import { configDir } from "../infra/paths.ts";
@@ -85,10 +85,12 @@ const unsaved = (v: Validation): Saved => ({
 export const CHANGED_ON_DISK = "profile";
 
 /**
- * Spec §7.3 `patch` (profile_set, `catherd profile set`): validates first and writes nothing when invalid.
- * A profile that does not exist yet starts from the default profile. With `expect` (the profile as a
- * preview read it), it writes nothing when the profile under the lock is no longer that one: the patch
- * would land on values the preview never showed.
+ * Spec §7.3 `patch` (profile_set, `catherd profile set`, the TUI's save): validates first and writes
+ * nothing when invalid, unless the save repairs the profile (spec 1.2 §6.2): it removes at least one error
+ * the stored profile had and adds none. Then it saves, and the result's `errors` are those still open. A
+ * profile that does not exist yet starts from the default profile. With `expect` (the profile as a preview
+ * read it), it writes nothing when the profile under the lock is no longer that one: the patch would land on
+ * values the preview never showed.
  */
 export function patchProfile(
   name: string | undefined,
@@ -112,7 +114,7 @@ export function patchProfile(
     const after = applyPatch(before, patch);
     const resolved = resolveProfile(after, n);
     const v = validate(after, n);
-    if (v.errors.length) return unsaved(v);
+    if (v.errors.length && !repairs(profileExists(n) ? validate(before, n) : null, v)) return unsaved(v);
     const diff = diffProfiles(resolveProfile(before, n), resolved);
     return { saved: true, ...v, diff, ...saveAndLink(n, after) };
   });
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/domain/profile-rules.test.ts test/services/profile-service.test.ts test/services/standins.test.ts test/entry/profile-command.test.ts test/entry/tui/dialogs.test.tsx test/entry/tui/profile-tree.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add catalog/scores.json src/domain/profile-rules.ts src/entry/mcp/setup-tools.ts src/entry/profile-command.ts src/entry/tui/fixtures.ts src/entry/tui/profile-edits.ts src/entry/tui/profile-tree.ts src/entry/tui/views/profile-actions.ts src/entry/tui/views/save-dialog.tsx src/services/profile-service.ts test/domain/profile-rules.test.ts test/entry/profile-command.test.ts test/entry/tui/dialogs.test.tsx test/entry/tui/profile-tree.test.ts test/services/profile-service.test.ts test/services/standins.test.ts
git commit -m "feat(profiles): unscored rungs warn with stand-ins to confirm, and a save may repair a profile"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 6: treat-like --suggest, --clear and --reset, naming the rungs left on a stand-in (spec 1.2 §6.4; C-5; Ruling 10)

`catherd catalog treat-like` takes `<rung> <like>` as before, or exactly one of `--suggest <rung>` (the three nearest stand-ins with distance, what they lend and the features they rest on; `--json`), `--clear <rung>` and `--reset`. The override stays written by `catalog-service.ts` (`removeTreatLikes`); `src/services/treat-likes.ts` computes, before removing, every profile's rungs a removal leaves on an inferred stand-in (it reads profiles through `profile-store.ts`, which already imports `catalog-service.ts`, so the orchestration lives in its own file). Acceptance 2 of spec §11 is pinned: clearing every user mapping leaves the profile valid, with warnings.

**Files:**

- Modify: `src/entry/catalog-command.ts`
- Modify: `src/services/catalog-service.ts`
- Create: `src/services/treat-likes.ts`
- Test: `test/entry/catalog-command.test.ts`
- Test (new): `test/services/treat-likes.test.ts`

**Interfaces:**
- Consumes: Task 4's `suggestStandIns`; Task 5's warnings; `listProfiles`, `getProfile`.
- Produces: `catalog-service.ts`: `canonicalRung(rung): string`, `removeTreatLikes(rungs: string[] | "all"): Promise<[string, string][]>`, `loadCatalog({ override? })`. `src/services/treat-likes.ts`: `interface LeftOnStandIn { profile; rung; dims: Dim[] }`, `leftOnStandIns(removed: string[] | "all")`, `suggestFor(rung)`, `clearTreatLike(rung)`, `resetTreatLikes()`. `catalog-command.ts`: `leftLines`, `suggestLines`.

- [ ] **Step 1: Write the failing tests**

Edit `test/entry/catalog-command.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/entry/catalog-command.test.ts b/test/entry/catalog-command.test.ts
index 14a9f60..8598647 100644
--- a/test/entry/catalog-command.test.ts
+++ b/test/entry/catalog-command.test.ts
@@ -76,6 +76,81 @@ describe("catherd catalog", () => {
     expect(catherd("list", "--backend", "codex").code).toBe(0);
   });
 
+  it("suggests the three nearest stand-ins, and clears and resets the user's mappings (spec 1.2 §6.4)", () => {
+    withHome();
+    const s = catherd("treat-like", "--suggest", "codex:gpt-5.6-terra#high");
+    expect(s.code).toBe(0);
+    const lines = s.out.trimEnd().split("\n");
+    expect(lines[0]).toBe(
+      "gpt-5.6-terra#high has no repo_code, terminal, honesty value of its own; the nearest stand-ins:",
+    );
+    expect(
+      lines.slice(1, 4).every((l) => /^ {2}[123]\. \S+#\S+ {2}distance \d+\.\d\d {2}lends \S/.test(l)),
+    ).toBe(true);
+    expect(lines[4]).toBe("map one: catherd catalog treat-like codex:gpt-5.6-terra#high <rung>");
+    expect(
+      JSON.parse(catherd("treat-like", "--suggest", "codex:gpt-5.6-terra#high", "--json").out).suggestions,
+    ).toHaveLength(3);
+
+    expect(catherd("treat-like", "codex:gpt-5.6-terra#high", "gpt-6-sol#high").code).toBe(0);
+    const cleared = catherd("treat-like", "--clear", "codex:gpt-5.6-terra#high");
+    expect([cleared.code, cleared.out]).toEqual([
+      0,
+      "✓ gpt-5.6-terra#high is no longer treated like gpt-6-sol#high\n",
+    ]);
+    const again = catherd("treat-like", "--clear", "codex:gpt-5.6-terra#high");
+    expect([again.code, again.err.split("\n")[0]]).toEqual([
+      2,
+      "error E_INPUT_INVALID: gpt-5.6-terra#high has no treat-like of yours to clear",
+    ]);
+    expect(catherd("treat-like", "codex:gpt-5.6-terra#high", "gpt-6-sol#high").code).toBe(0);
+    const reset = catherd("treat-like", "--reset");
+    expect([reset.code, reset.out]).toEqual([
+      0,
+      "✓ removed 1 treat-like: gpt-5.6-terra#high → gpt-6-sol#high\n",
+    ]);
+    expect(catherd("treat-like", "--reset").out).toBe("no treat-like of yours to remove\n");
+  });
+
+  it("names the profile rungs a cleared mapping leaves on an inferred stand-in", () => {
+    withHome();
+    const worker = ["codex:gpt-6-luna#high", "codex:gpt-6-sol#medium", "codex:gpt-5.6-terra#high"];
+    const set = Bun.spawnSync(
+      [process.execPath, CLI, "profile", "set", "roles.worker.rungs", worker.join(",")],
+      {
+        env: { ...process.env, PATH: "/nonexistent", ANTHROPIC_API_KEY: "" },
+        stdout: "pipe",
+        stderr: "pipe",
+      },
+    );
+    expect(set.exitCode).toBe(0);
+    expect(catherd("treat-like", "codex:gpt-5.6-terra#high", "gpt-6-sol#high").code).toBe(0);
+    const r = catherd("treat-like", "--clear", "gpt-5.6-terra#high");
+    expect(r.out).toBe(
+      [
+        "! default: codex:gpt-5.6-terra#high is left on an inferred stand-in for repo_code, terminal, honesty",
+        "✓ gpt-5.6-terra#high is no longer treated like gpt-6-sol#high",
+        "",
+      ].join("\n"),
+    );
+  });
+
+  it("refuses treat-like with neither a pair nor one of its flags, or with two of them, with exit 2", () => {
+    withHome();
+    for (const args of [
+      [],
+      ["codex:gpt-6-sol#high"],
+      ["--reset", "--clear", "a#high"],
+      ["a#high", "b#high", "--reset"],
+    ]) {
+      const r = catherd("treat-like", ...args);
+      expect([r.code, r.err.split("\n")[0]]).toEqual([
+        2,
+        "error E_INPUT_INVALID: treat-like takes <rung> <like>, or one of --suggest, --clear, --reset",
+      ]);
+    }
+  });
+
   it("refuses a treat-like for a rung that is already scored, with exit 1", () => {
     withHome();
     const r = catherd("treat-like", "codex:gpt-6-sol#high", "gpt-6-sol#xhigh");
````

Create `test/services/treat-likes.test.ts`:

````ts
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isCatherdError } from "../../src/domain/errors.ts";
import { loadCatalog, overridePath, saveTreatLike } from "../../src/services/catalog-service.ts";
import { patchProfile } from "../../src/services/profile-service.ts";
import { validateNamed } from "../../src/services/profile-store.ts";
import {
  clearTreatLike,
  leftOnStandIns,
  resetTreatLikes,
  suggestFor,
} from "../../src/services/treat-likes.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

const TERRA = "codex:gpt-5.6-terra#high";
const DEFAULT_WORKER = [
  "codex:gpt-6-luna#high",
  "codex:gpt-6-sol#medium",
  "codex:gpt-6-sol#high",
  "codex:gpt-6-sol#xhigh",
];

/** GPT-5.6 Terra, which no source scores on repo_code, terminal or honesty, on the default worker's ladder. */
async function terraOnTheLadder(): Promise<void> {
  withHome();
  patchProfile("default", { roles: { worker: { rungs: [...DEFAULT_WORKER, TERRA] } } });
  await saveTreatLike(TERRA, "gpt-6-sol#high");
}

describe("treat-like --suggest (spec 1.2 §6.4)", () => {
  it("names the three nearest stand-ins, with what they lend and the features they rest on", () => {
    withHome();
    const r = suggestFor(TERRA);
    expect(r.canonical).toBe("gpt-5.6-terra#high");
    expect(r.lacking).toEqual(["repo_code", "terminal", "honesty"]);
    expect(r.suggestions).toHaveLength(3);
    for (const s of r.suggestions) {
      expect(s.features.length).toBeGreaterThanOrEqual(3);
      expect(s.lends.length).toBeGreaterThan(0);
    }
  });
});

describe("treat-like --clear and --reset (spec 1.2 §6.4)", () => {
  it("removes the user's mapping, naming first the profile rungs it leaves on an inferred stand-in", async () => {
    await terraOnTheLadder();
    expect(leftOnStandIns(["gpt-5.6-terra#high"])).toEqual([
      { profile: "default", rung: TERRA, dims: ["repo_code", "terminal", "honesty"] },
    ]);
    const r = await clearTreatLike(TERRA);
    expect(r).toEqual({
      rung: "gpt-5.6-terra#high",
      like: "gpt-6-sol#high",
      left: [{ profile: "default", rung: TERRA, dims: ["repo_code", "terminal", "honesty"] }],
    });
    expect(JSON.parse(readFileSync(overridePath(), "utf8")).treatLike).toEqual({});
    expect(loadCatalog({ timings: false }).treatLike["gpt-5.6-terra#high"]).toBeUndefined();
  });

  it("refuses to clear a treat-like that is not the user's", async () => {
    withHome();
    const e = await clearTreatLike("opencode:opencode-go/kimi-k3#max").then(
      () => null,
      (x: unknown) => x,
    );
    expect(isCatherdError(e) && e.code).toBe("E_INPUT_INVALID");
    expect(isCatherdError(e) && e.message).toBe(
      "opencode-go/kimi-k3#max has no treat-like of yours to clear",
    );
    expect(loadCatalog({ timings: false }).treatLike["opencode-go/kimi-k3#max"]?.source).toBe("shipped");
  });

  it("removes every user mapping, keeping the override's scores and the shipped treat-likes", async () => {
    await terraOnTheLadder();
    await saveTreatLike("opencode:opencode-go/glm-5.3#high", "gpt-6-sol#medium");
    const cur = JSON.parse(readFileSync(overridePath(), "utf8"));
    const mine = {
      rung: "gpt-6-sol#high",
      dim: "steer",
      value: 0.2,
      benchmark: "mine",
      version: "1",
      url: "https://example.com/mine",
      date: "2026-09-27",
      confidence: "verified",
    };
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(overridePath(), JSON.stringify({ ...cur, scores: [mine] }));
    const r = await resetTreatLikes();
    expect(r.removed).toEqual([
      ["gpt-5.6-terra#high", "gpt-6-sol#high"],
      ["opencode-go/glm-5.3#high", "gpt-6-sol#medium"],
    ]);
    expect(r.left).toEqual([{ profile: "default", rung: TERRA, dims: ["repo_code", "terminal", "honesty"] }]);
    const after = JSON.parse(readFileSync(overridePath(), "utf8"));
    expect([after.treatLike, after.scores]).toEqual([{}, [mine]]);
    expect(loadCatalog({ timings: false }).treatLike["opencode-go/kimi-k3#max"]?.source).toBe("shipped");
  });

  it("leaves the profile valid, with warnings, when every user mapping is cleared (spec 1.2 §11)", async () => {
    await terraOnTheLadder();
    const mapped = validateNamed("default");
    expect(mapped.errors).toEqual([]);
    expect(mapped.warnings.some((w) => w.message.startsWith("stand-in to confirm"))).toBe(false);
    await resetTreatLikes();
    const v = validateNamed("default");
    expect(v.errors).toEqual([]);
    expect(
      v.warnings.some((w) =>
        w.message.startsWith(
          "stand-in to confirm: gpt-5.6-terra#high has no repo_code, terminal or honesty value",
        ),
      ),
    ).toBe(true);
  });

  it("says there is nothing to remove", async () => {
    withHome();
    expect(await resetTreatLikes()).toEqual({ removed: [], left: [] });
  });
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/services/treat-likes.test.ts test/entry/catalog-command.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/treat-likes.ts'`; the CLI refuses `--suggest`.

- [ ] **Step 3: Implement**

Edit `src/entry/catalog-command.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/catalog-command.ts b/src/entry/catalog-command.ts
index 59f1b18..0544d7b 100644
--- a/src/entry/catalog-command.ts
+++ b/src/entry/catalog-command.ts
@@ -11,6 +11,7 @@ import {
 } from "../services/catalog-service.ts";
 import { readDerived } from "../infra/sources/cache.ts";
 import { type SyncReport, syncSources } from "../services/source-sync.ts";
+import { clearTreatLike, type LeftOnStandIn, resetTreatLikes, suggestFor } from "../services/treat-likes.ts";
 import { exitCodeOf, JSON_ARG, mark, printError } from "./cli-kit.ts";
 
 /**
@@ -137,19 +138,92 @@ const list = defineCommand({
   },
 });
 
+/** Spec 1.2 §6.4: the profile rungs a removal leaves on an inferred stand-in, one line each. */
+export function leftLines(left: LeftOnStandIn[], plain = false): string[] {
+  return left.map(
+    (l) =>
+      `${mark("warn", plain)} ${l.profile}: ${l.rung} is left on an inferred stand-in for ${l.dims.join(", ")}`,
+  );
+}
+
+/** Spec 1.2 §6.4 `--suggest`: the three nearest stand-ins, each with its distance and the features it rests on. */
+export function suggestLines(r: ReturnType<typeof suggestFor>, rung: string): string[] {
+  const head = r.lacking.length
+    ? `${r.canonical} has no ${r.lacking.join(", ")} value of its own; the nearest stand-ins:`
+    : `${r.canonical} has every value the bars use; the nearest scored rungs:`;
+  if (r.suggestions.length === 0)
+    return [
+      `${r.canonical}: no scored rung shares 3 features with it; map it by hand: catherd catalog treat-like ${rung} <rung>`,
+    ];
+  return [
+    head,
+    ...r.suggestions.map(
+      (s, i) =>
+        `  ${i + 1}. ${s.like}  distance ${s.distance.toFixed(2)}  lends ${s.lends.join(", ")}  on ${s.features.join(", ")}`,
+    ),
+    `map one: catherd catalog treat-like ${rung} <rung>`,
+  ];
+}
+
 const treatLike = defineCommand({
-  meta: { name: "treat-like", description: "Score an unscored rung as a scored one" },
+  meta: {
+    name: "treat-like",
+    description:
+      "Score an unscored rung as a scored one; --suggest ranks stand-ins, --clear and --reset remove your mappings",
+  },
   args: {
     rung: {
       type: "positional",
-      required: true,
+      required: false,
       description: "the unscored rung, backend:model#effort or model#effort",
     },
-    like: { type: "positional", required: true, description: "the scored rung whose scores it borrows" },
+    like: { type: "positional", required: false, description: "the scored rung whose scores it borrows" },
+    suggest: { type: "string", description: "list the 3 nearest stand-ins for this rung" },
+    clear: { type: "string", description: "remove your treat-like for this rung" },
+    reset: { type: "boolean", description: "remove every treat-like of yours" },
+    ...JSON_ARG,
   },
   async run({ args }) {
     try {
-      const r = await saveTreatLike(args.rung, args.like);
+      const modes = [
+        args.suggest !== undefined,
+        args.clear !== undefined,
+        args.reset === true,
+        args.rung !== undefined,
+      ];
+      if (modes.filter(Boolean).length !== 1 || (args.rung !== undefined && args.like === undefined))
+        throw new CatherdError(
+          "E_INPUT_INVALID",
+          "treat-like takes <rung> <like>, or one of --suggest, --clear, --reset",
+          {
+            fix: "catherd catalog treat-like <rung> <like> | --suggest <rung> | --clear <rung> | --reset",
+          },
+        );
+      if (args.suggest !== undefined) {
+        const r = suggestFor(args.suggest);
+        if (args.json) console.log(JSON.stringify(r, null, 2));
+        else for (const l of suggestLines(r, args.suggest)) console.log(l);
+        return;
+      }
+      if (args.clear !== undefined) {
+        const r = await clearTreatLike(args.clear);
+        if (args.json) return console.log(JSON.stringify(r, null, 2));
+        for (const l of leftLines(r.left)) console.log(l);
+        console.log(`${mark("ok")} ${r.rung} is no longer treated like ${r.like}`);
+        return;
+      }
+      if (args.reset) {
+        const r = await resetTreatLikes();
+        if (args.json) return console.log(JSON.stringify(r, null, 2));
+        for (const l of leftLines(r.left)) console.log(l);
+        console.log(
+          r.removed.length
+            ? `${mark("ok")} removed ${r.removed.length} treat-like${r.removed.length === 1 ? "" : "s"}: ${r.removed.map(([a, b]) => `${a} → ${b}`).join(", ")}`
+            : "no treat-like of yours to remove",
+        );
+        return;
+      }
+      const r = await saveTreatLike(args.rung as string, args.like as string);
       console.log(`✓ ${r.rung} is treated like ${r.like}`);
     } catch (e) {
       fail(e);
@@ -157,7 +231,7 @@ const treatLike = defineCommand({
   },
 });
 
-/** Spec §8 and 1.2 §9: `catherd catalog refresh|list|sync|treat-like <rung> <like>`. */
+/** Spec §8 and 1.2 §9: `catherd catalog refresh|list|sync|treat-like <rung> <like> | --suggest|--clear|--reset`. */
 export const catalogCommand = defineCommand({
   meta: { name: "catalog", description: "The model catalog" },
   subCommands: { refresh, list, sync, "treat-like": treatLike },
````

Edit `src/services/catalog-service.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/catalog-service.ts b/src/services/catalog-service.ts
index f3c355a..d63a9d7 100644
--- a/src/services/catalog-service.ts
+++ b/src/services/catalog-service.ts
@@ -118,9 +118,10 @@ export function measuredSecs(base: Catalog): Catalog["secs"] {
 
 /**
  * The shipped catalog with every listing (in `repo` for a backend listed per repository), the user's
- * override and, unless `timings: false`, own timings.
+ * override (or `override` in its place: what a change to it would make) and, unless `timings: false`, own
+ * timings.
  */
-export function loadCatalog(o: { timings?: boolean; repo?: string } = {}): Catalog {
+export function loadCatalog(o: { timings?: boolean; repo?: string; override?: Override } = {}): Catalog {
   // spec 1.2 §3.2: whatever the last sync derived; without one (first run, offline), the shipped values alone
   const synced = readDerived();
   // spec 1.2 §6.1: every value a rung lacks on a dimension the bars use comes from its nearest stand-in
@@ -131,7 +132,7 @@ export function loadCatalog(o: { timings?: boolean; repo?: string } = {}): Catal
       synced: synced?.scores,
       facts: synced?.facts,
       features: synced?.features,
-      override: readOverride(),
+      override: o.override ?? readOverride(),
       listed: listedModels(o.repo),
     }),
   );
@@ -288,6 +289,30 @@ export async function saveTreatLike(rung: string, like: string): Promise<{ rung:
   return { rung: from, like: to };
 }
 
+/** A rung given as `backend:model#effort` or `model#effort`, as the canonical rung the override keys it by. */
+export const canonicalRung = (rung: string): string => canonicalOf(loadCatalog({ timings: false }), rung);
+
+/**
+ * Spec 1.2 §6.4 `treat-like --clear|--reset`: removes the user's treat-likes for `rungs` (canonical), or every
+ * one with `"all"`, from catalog.override.json; the shipped ones are not the user's to remove. Returns the
+ * mappings removed. Leaves the override's other fields as they are.
+ */
+export async function removeTreatLikes(rungs: string[] | "all"): Promise<[string, string][]> {
+  if (!existsSync(overridePath())) return [];
+  let removed: [string, string][] = [];
+  await withFileLock(overridePath(), () => {
+    const cur = readOverride();
+    const gone = Object.entries(cur.treatLike).filter(([r]) => rungs === "all" || rungs.includes(r));
+    removed = gone;
+    if (gone.length === 0) return;
+    const treatLike = Object.fromEntries(
+      Object.entries(cur.treatLike).filter(([r]) => !gone.some(([g]) => g === r)),
+    );
+    writeJsonAtomic(overridePath(), { ...cur, schema: 1, treatLike });
+  });
+  return removed;
+}
+
 /** The backend a billing or harness key bills or isolates: `opencode-go` is a provider of the opencode backend. */
 export const backendOfKey = (key: string) => (key === "opencode-go" ? "opencode" : key);
````

Create `src/services/treat-likes.ts`:

````ts
import { type Dim, scoresOf, rungInfo } from "../domain/catalog.ts";
import { CatherdError } from "../domain/errors.ts";
import { tryParseRung } from "../domain/ids.ts";
import { ROLES } from "../domain/roles.ts";
import { canonicalRung, loadCatalog, readOverride, removeTreatLikes } from "./catalog-service.ts";
import { getProfile, listProfiles } from "./profile-store.ts";
import { type Suggestion, suggestStandIns } from "./standins.ts";

/** A profile's rung that would lean on an inferred stand-in (spec 1.2 §6.4). */
export interface LeftOnStandIn {
  profile: string;
  rung: string;
  /** the dimensions an inferred stand-in would fill */
  dims: Dim[];
}

/**
 * Spec 1.2 §6.4: the rungs of every profile (enabled roles' rungs and failover stand-ins) that would lean on an
 * inferred stand-in once the user's treat-likes for `removed` (canonical rungs, or all of them) are gone.
 */
export function leftOnStandIns(removed: string[] | "all"): LeftOnStandIn[] {
  const cur = readOverride();
  const treatLike = Object.fromEntries(
    Object.entries(cur.treatLike).filter(([r]) => removed !== "all" && !removed.includes(r)),
  );
  const gone = removed === "all" ? Object.keys(cur.treatLike) : removed;
  const c = loadCatalog({ timings: false, override: { ...cur, treatLike } });
  const out: LeftOnStandIn[] = [];
  for (const profile of listProfiles()) {
    const p = getProfile(profile);
    const rungs = new Set([
      ...ROLES.filter((r) => p.roles[r].enabled).flatMap((r) => p.roles[r].rungs),
      ...Object.values(p.failover),
    ]);
    for (const rung of rungs) {
      if (!tryParseRung(rung)) continue;
      const canonical = rungInfo(c, rung).canonical;
      if (!gone.includes(canonical)) continue;
      const dims = scoresOf(c, canonical)?.inferred ?? [];
      if (dims.length) out.push({ profile, rung, dims });
    }
  }
  return out;
}

/** Spec 1.2 §6.4 `--suggest`: the rung, in canonical form, and its three nearest stand-ins. */
export function suggestFor(rung: string): { canonical: string; lacking: Dim[]; suggestions: Suggestion[] } {
  const c = loadCatalog({ timings: false });
  const canonical = canonicalRung(rung);
  const s = scoresOf(c, canonical);
  return {
    canonical,
    lacking: s ? s.inferred : [],
    suggestions: suggestStandIns(c, canonical),
  };
}

/**
 * Spec 1.2 §6.4 `--clear`: removes the user's treat-like for `rung`, naming first the profile rungs it
 * leaves on an inferred stand-in. A shipped treat-like is not the user's to remove.
 */
export async function clearTreatLike(
  rung: string,
): Promise<{ rung: string; like: string; left: LeftOnStandIn[] }> {
  const canonical = canonicalRung(rung);
  const like = readOverride().treatLike[canonical];
  if (!like)
    throw new CatherdError("E_INPUT_INVALID", `${canonical} has no treat-like of yours to clear`, {
      fix: "catherd catalog list shows each rung's treat-like; a shipped one is not yours to clear",
    });
  const left = leftOnStandIns([canonical]);
  await removeTreatLikes([canonical]);
  return { rung: canonical, like, left };
}

/** Spec 1.2 §6.4 `--reset`: removes every treat-like of the user's, naming first the rungs left on a stand-in. */
export async function resetTreatLikes(): Promise<{ removed: [string, string][]; left: LeftOnStandIn[] }> {
  const left = leftOnStandIns("all");
  return { removed: await removeTreatLikes("all"), left };
}
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/services/treat-likes.test.ts test/entry/catalog-command.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/entry/catalog-command.ts src/services/catalog-service.ts src/services/treat-likes.ts test/entry/catalog-command.test.ts test/services/treat-likes.test.ts
git commit -m "feat(catalog): treat-like --suggest, --clear and --reset, naming the rungs left on a stand-in"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 7: Run evidence per rung and kind from every repo's run records (spec 1.2 §8; Ruling 15)

`runEvidence(c)` counts, from every repo's runs on this machine, lanes, climbs, `partial`/`blocked`/`refused` replies and verifier FAILs per canonical rung and kind (and over every kind), and `evidenceLine` words them ("12 lanes, 2 climbed, 1 partial"). Nothing routes on it. Task 8 and Task 10 show it.

**Files:**

- Create: `src/services/run-evidence.ts`
- Test (new): `test/services/run-evidence.test.ts`

**Interfaces:**
- Consumes: `listRuns`, `readRoutes`, `readRecords`, `readAgentRuns`, `routeAt`, `replyVerdict` (milestones.ts), `rungInfo`.
- Produces: `src/services/run-evidence.ts`: `interface Evidence { lanes; climbed; partial; blocked; refused; fails }`, `type EvidenceTable = Record<string, Evidence>` (`<canonical>|<kind or *>`), `runEvidence(c): EvidenceTable`, `evidenceOf(t, canonical, kind = null): Evidence | null` (the kind's, else `*`), `evidenceLine(e): string | null`.

- [ ] **Step 1: Write the failing tests**

Create `test/services/run-evidence.test.ts`:

````ts
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Kind } from "../../src/domain/lane.ts";
import type { RouteRow } from "../../src/domain/route.ts";
import { loadCatalog } from "../../src/services/catalog-service.ts";
import { evidenceLine, evidenceOf, runEvidence } from "../../src/services/run-evidence.ts";
import { appendAgentRun, appendRecord, appendRoute, type Run } from "../../src/services/run-store.ts";
import { snapshotEnv, tempRepo } from "../helpers.ts";
import { createRun } from "../../src/services/run-store.ts";
import { freshRun, makeRecord } from "./helpers.ts";

afterEach(snapshotEnv());

const LUNA = "codex:gpt-6-luna#high";
const SOL = "codex:gpt-6-sol#medium";

const row = (o: Partial<RouteRow> & Pick<RouteRow, "lane" | "rung">): RouteRow => ({
  at: "2026-09-28T10:00:00.000Z",
  role: "worker",
  ladder: [LUNA, SOL],
  source: "route",
  decidedBy: "lane",
  from: null,
  reason: null,
  kind: "repo_code",
  difficulty: "build",
  ...o,
});

function lane(run: Run, id: string, kind: Kind, climbTo?: string): void {
  appendRoute(run, row({ lane: id, rung: LUNA, kind }));
  if (climbTo)
    appendRoute(
      run,
      row({
        lane: id,
        rung: climbTo,
        kind,
        source: "climb",
        from: LUNA,
        reason: "blocked",
        at: "2026-09-28T10:30:00.000Z",
      }),
    );
}

describe("run evidence (spec 1.2 §8)", () => {
  it("counts lanes, climbs and replies per rung and kind, and over every kind, across every repo's runs", async () => {
    const { run } = freshRun();
    lane(run, "M1.L1", "repo_code", SOL);
    lane(run, "M1.L2", "repo_code");
    lane(run, "M1.L3", "terminal");
    await appendRecord(
      run,
      makeRecord({
        dispatchId: "A",
        lane: "M1.L1",
        rung: LUNA,
        replyStatus: "blocked",
        startedAt: "2026-09-28T10:01:00.000Z",
      }),
    );
    await appendRecord(
      run,
      makeRecord({
        dispatchId: "B",
        lane: "M1.L2",
        rung: LUNA,
        replyStatus: "partial",
        startedAt: "2026-09-28T10:01:00.000Z",
      }),
    );
    // a second repo on this machine counts too
    const other = createRun({ repo: tempRepo(), title: "o", aLines: ["A1"], version: "0.0.0-test" });
    lane(other, "M1.L1", "repo_code");
    const t = runEvidence(loadCatalog({ timings: false }));
    expect(t["gpt-6-luna#high|repo_code"]).toEqual({
      lanes: 3,
      climbed: 1,
      partial: 1,
      blocked: 1,
      refused: 0,
      fails: 0,
    });
    expect(t["gpt-6-luna#high|terminal"]).toMatchObject({ lanes: 1, climbed: 0 });
    expect(t["gpt-6-luna#high|*"]).toMatchObject({ lanes: 4, climbed: 1, partial: 1, blocked: 1 });
    expect(t["gpt-6-sol#medium|repo_code"]).toMatchObject({ lanes: 1, climbed: 0 });
    expect(evidenceLine(evidenceOf(t, "gpt-6-luna#high", "repo_code"))).toBe(
      "3 lanes, 1 climbed, 1 partial, 1 blocked",
    );
    expect(evidenceLine(evidenceOf(t, "gpt-6-luna#high", "ui"))).toBe(
      "4 lanes, 1 climbed, 1 partial, 1 blocked",
    );
    expect(evidenceLine(evidenceOf(t, "gpt-6-astra#max"))).toBeNull();
  });

  it("counts a verifier's FAILs on the rung that gave them, headless or native", async () => {
    const { run } = freshRun();
    const reply = "roles/verifier-M1/V1/reply.md";
    mkdirSync(dirname(join(run.dir, reply)), { recursive: true });
    writeFileSync(join(run.dir, reply), "VERDICT: FAIL\nA1 FAIL bun test\nSTATUS: complete — checked");
    await appendRecord(
      run,
      makeRecord({
        dispatchId: "V1",
        name: "verifier-M1",
        role: "verifier",
        lane: null,
        rung: SOL,
        replyPath: reply,
      }),
    );
    appendAgentRun(run, {
      at: "2026-09-28T11:00:00.000Z",
      name: "verifier-M1",
      role: "verifier",
      rung: "claude:claude-opus-5-5#low",
      agent: null,
      totalTokens: 10,
      costUsd: null,
      secs: 60,
      status: "failed",
    });
    const t = runEvidence(loadCatalog({ timings: false }));
    expect(t["gpt-6-sol#medium|*"]).toMatchObject({ fails: 1, lanes: 0 });
    expect(t["claude-opus-5-5#low|*"]).toMatchObject({ fails: 1 });
    expect(evidenceLine(t["gpt-6-sol#medium|*"] ?? null)).toBe("0 lanes, 1 verifier FAIL");
  });

  it("is empty with no runs", () => {
    freshRun();
    expect(runEvidence(loadCatalog({ timings: false }))).toEqual({});
  });
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/services/run-evidence.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/run-evidence.ts'`.

- [ ] **Step 3: Implement**

Create `src/services/run-evidence.ts`:

````ts
import { type Catalog, rungInfo } from "../domain/catalog.ts";
import type { Kind } from "../domain/lane.ts";
import { routeAt } from "../domain/route.ts";
import { replyVerdict } from "./milestones.ts";
import { listRuns, readAgentRuns, readRecords, readRoutes } from "./run-store.ts";

/** Spec 1.2 §8: what catherd's own runs say about a rung, for one kind or every kind (`*`). */
export interface Evidence {
  /** lanes routed to it, or climbed onto it */
  lanes: number;
  /** lanes that climbed off it */
  climbed: number;
  partial: number;
  blocked: number;
  refused: number;
  /** verifier FAILs it gave, as a verifier (plan 14 Ruling 15) */
  fails: number;
}

/** `<canonical rung>|<kind or *>` → its evidence. Shown by route, catalog list and the TUI; never routes. */
export type EvidenceTable = Record<string, Evidence>;

const VERDICT_FAIL = /^VERDICT: FAIL\b/;
const zero = (): Evidence => ({ lanes: 0, climbed: 0, partial: 0, blocked: 0, refused: 0, fails: 0 });

/**
 * Spec 1.2 §8: for each rung and kind, from the run records of every repo on this machine: the lanes routed or
 * climbed onto it, the climbs off it, its `partial`, `blocked` and `refused` replies (under the kind its lane
 * was routed as when the dispatch started), and the verifier FAILs it gave. Every count also goes under `*`.
 * It never changes scores, bars or routing (1.3's, once there is data).
 */
export function runEvidence(c: Catalog): EvidenceTable {
  const out: EvidenceTable = {};
  const canonicalOf = (rung: string): string | null => {
    try {
      return rungInfo(c, rung).canonical;
    } catch {
      return null;
    }
  };
  const bump = (rung: string, kind: Kind | null, field: keyof Evidence) => {
    const canonical = canonicalOf(rung);
    if (!canonical) return;
    for (const k of kind ? [kind, "*"] : ["*"]) (out[`${canonical}|${k}`] ??= zero())[field] += 1;
  };
  for (const run of listRuns().runs) {
    const routes = readRoutes(run);
    // a lane counts once per rung it was on, under the kind of the row that put it there
    const seen = new Set<string>();
    for (const r of routes) {
      const key = `${r.lane} ${r.rung} ${r.kind ?? "*"}`;
      if (!seen.has(key)) {
        seen.add(key);
        bump(r.rung, r.kind, "lanes");
      }
      if (r.source === "climb" && r.from && r.from !== r.rung) bump(r.from, r.kind, "climbed");
    }
    for (const rec of readRecords(run).records) {
      const kind = rec.lane ? (routeAt(routes, rec.lane, rec.startedAt)?.kind ?? null) : null;
      if (rec.replyStatus === "partial" || rec.replyStatus === "blocked" || rec.replyStatus === "refused")
        bump(rec.rung, kind, rec.replyStatus);
      if (rec.role === "verifier" && rec.status === "ok" && VERDICT_FAIL.test(replyVerdict(run, rec) ?? ""))
        bump(rec.rung, null, "fails");
    }
    for (const a of readAgentRuns(run))
      if (a.role === "verifier" && a.status === "failed") bump(a.rung, null, "fails");
  }
  return out;
}

/** A rung's evidence for `kind`, else over every kind; null when catherd never ran it. */
export function evidenceOf(t: EvidenceTable, canonical: string, kind: Kind | null = null): Evidence | null {
  return (kind ? t[`${canonical}|${kind}`] : undefined) ?? t[`${canonical}|*`] ?? null;
}

/** Spec 1.2 §8's words: "12 lanes, 2 climbed, 1 partial"; null when there is nothing to say. */
export function evidenceLine(e: Evidence | null): string | null {
  if (!e) return null;
  const parts = [`${e.lanes} ${e.lanes === 1 ? "lane" : "lanes"}`];
  if (e.climbed) parts.push(`${e.climbed} climbed`);
  if (e.partial) parts.push(`${e.partial} partial`);
  if (e.blocked) parts.push(`${e.blocked} blocked`);
  if (e.refused) parts.push(`${e.refused} refused`);
  if (e.fails) parts.push(`${e.fails} verifier ${e.fails === 1 ? "FAIL" : "FAILs"}`);
  return parts.join(", ");
}
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/services/run-evidence.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/services/run-evidence.ts test/services/run-evidence.test.ts
git commit -m "feat(catalog): run evidence per rung and kind from every repo's run records"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 8: Route and catalog_query show each value's source, confidence and run evidence (spec 1.2 §5.3, §8, §9; Rulings 16, 18)

`src/services/provenance.ts` says, for a rung, every value it has with confidence, source, benchmark, date and whose it is (`inferred`, `from`), and for a lane each threshold of its bar with the value used and whether it clears, plus the rung's speed and cost facts and its run evidence. `route` returns it as `provenance` (MCP `route` gets it through `RouteResult`), `catalog_query` rows carry `source`, `date`, `from` per score, `evidence` per rung and `price`/`speed` per model, and `catalog list` prints a facts line and evidence lines. `buildCatalog` stamps the user's override scores with `source: "override"`; `applyFacts` carries a sync's `speed`. Acceptance 3 of spec §11 is pinned: a `terminal` lane and a `ui` lane route by the terminal and frontend bars and name each value's source.

**Files:**

- Modify: `src/domain/catalog.ts`
- Modify: `src/entry/catalog-command.ts`
- Modify: `src/entry/mcp/lane-tools.ts`
- Modify: `src/entry/mcp/setup-tools.ts`
- Modify: `src/services/catalog-service.ts`
- Modify: `src/services/ports.ts`
- Create: `src/services/provenance.ts`
- Modify: `src/services/routing-service.ts`
- Test: `test/entry/catalog-command.test.ts`
- Test: `test/entry/tui/profile-tree.test.ts`
- Test: `test/services/catalog-service.test.ts`
- Test: `test/services/routing-service.test.ts`

**Interfaces:**
- Consumes: Task 7's `runEvidence`, `evidenceOf`, `evidenceLine`; Task 4's `scoresOf(...).standIns`; `costOf`.
- Produces: `src/services/provenance.ts`: `interface ValueUsed { dim; value; confidence; source; benchmark; date; url; inferred; from }`, `interface Threshold { dim; min; used; clears; why }`, `interface Provenance { rung; canonical; thresholds; values; speed; cost; evidence: { kind; all } }`, `valuesUsed(c, canonical)`, `provenanceOf(c, rung, kind, difficulty, billing, evidence)`, `valueWords(v)`. `RouteAnswer.provenance?`. `CatalogModel.price`, `.speed`; rung rows `.evidence`, scores' `source`/`date`/`from`. `Family.speed?`.

- [ ] **Step 1: Write the failing tests**

Edit `test/entry/catalog-command.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/entry/catalog-command.test.ts b/test/entry/catalog-command.test.ts
index 8598647..4d2b22e 100644
--- a/test/entry/catalog-command.test.ts
+++ b/test/entry/catalog-command.test.ts
@@ -3,7 +3,7 @@ import { mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
 import { writeDiscovery } from "../../src/adapters/discovery.ts";
-import { syncLines } from "../../src/entry/catalog-command.ts";
+import { formatModel, syncLines } from "../../src/entry/catalog-command.ts";
 import { overridePath } from "../../src/services/catalog-service.ts";
 import type { SyncReport } from "../../src/services/source-sync.ts";
 import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
@@ -31,12 +31,58 @@ function catherdIn(cwd: string | undefined, path: string, ...args: string[]) {
   return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
 }
 
+describe("formatModel (spec 1.2 §4.1, §8)", () => {
+  it("adds the price and speed facts, and each rung catherd has run with its evidence", () => {
+    withHome();
+    const m = {
+      id: "gpt-6-sol",
+      name: "GPT-6 Sol",
+      backend: "codex",
+      model: "gpt-6-sol",
+      billing: "codex",
+      efforts: ["medium", "high"],
+      context: 272000,
+      capabilities: null,
+      roles: ["worker" as const],
+      listed: null,
+      notes: {},
+      price: { input: 2, cached: 0.2, output: 10 },
+      speed: { "openrouter.throughput_last_30m": 81.234 },
+      rungs: [
+        {
+          rung: "codex:gpt-6-sol#medium",
+          enabled: true,
+          scores: {},
+          treatLike: null,
+          cost: {} as never,
+          evidence: null,
+        },
+        {
+          rung: "codex:gpt-6-sol#high",
+          enabled: true,
+          scores: {},
+          treatLike: null,
+          cost: {} as never,
+          evidence: "12 lanes, 2 climbed, 1 partial",
+        },
+      ],
+    };
+    expect(formatModel(m).split("\n")).toEqual([
+      "codex:gpt-6-sol  2/2 rungs scored  roles worker",
+      "  $2/$10 per M tokens in/out · openrouter.throughput_last_30m 81.23",
+      "  #high  12 lanes, 2 climbed, 1 partial",
+    ]);
+  });
+});
+
 describe("catherd catalog", () => {
   it("lists models with their scored rungs, as text or JSON", () => {
     withHome();
     const text = catherd("list", "--backend", "codex", "--text", "gpt-6-sol");
     expect(text.code).toBe(0);
     expect(text.out).toContain("codex:gpt-6-sol  6/6 rungs scored  roles ");
+    // spec 1.2 §4.1: cost and speed are facts, shown beside the scores
+    expect(text.out).toContain("\n  $2/$10 per M tokens in/out\n");
     const json = JSON.parse(catherd("list", "--role", "artist", "--json").out);
     expect(json.models.every((m: { backend: string }) => m.backend === "codex")).toBe(true);
   });
````

Edit `test/entry/tui/profile-tree.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/entry/tui/profile-tree.test.ts b/test/entry/tui/profile-tree.test.ts
index 54c5366..6043992 100644
--- a/test/entry/tui/profile-tree.test.ts
+++ b/test/entry/tui/profile-tree.test.ts
@@ -37,6 +37,8 @@ const GLM: CatalogModel = {
   roles: ["worker", "reviewer"],
   listed: true,
   notes: {},
+  price: null,
+  speed: {},
   rungs: [
     {
       rung: "opencode:opencode-go/glm-6#default",
@@ -44,6 +46,7 @@ const GLM: CatalogModel = {
       scores: {},
       treatLike: null,
       cost: { kind: "metered", value: 0 } as never,
+      evidence: null,
     },
   ],
 };
````

Edit `test/services/catalog-service.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/catalog-service.test.ts b/test/services/catalog-service.test.ts
index 09f9528..e2c5c89 100644
--- a/test/services/catalog-service.test.ts
+++ b/test/services/catalog-service.test.ts
@@ -529,7 +529,9 @@ describe("catalogQuery", () => {
     const high = sol?.rungs.find((r) => r.rung === "codex:gpt-6-sol#high");
     expect(high).toMatchObject({
       enabled: true,
-      scores: { repo_code: { value: 65.3, benchmark: "DeepSWE 1.1", confidence: "secondary" } },
+      scores: {
+        repo_code: { value: 65.3, benchmark: "DeepSWE 1.1", confidence: "secondary", source: "shipped" },
+      },
       cost: { tier: 0, mode: "chatgpt-plan" },
     });
     // ultra carries max's published values (spec 1.2 §4.3 adjacent)
@@ -549,6 +551,37 @@ describe("catalogQuery", () => {
     ]);
   });
 
+  it("shows each value's confidence, source and date, marks a lent one, and each rung's run evidence (spec 1.2 §5.3, §8)", async () => {
+    const { run } = freshRun();
+    appendRoute(run, {
+      at: "2026-09-28T10:00:00.000Z",
+      lane: "M1.L1",
+      role: "worker",
+      rung: "codex:gpt-6-luna#high",
+      ladder: ["codex:gpt-6-luna#high"],
+      source: "route",
+      decidedBy: "lane",
+      from: null,
+      reason: null,
+      kind: "repo_code",
+      difficulty: "build",
+    });
+    const luna = q({ backend: "codex", text: "gpt-6-luna" }).models[0];
+    expect(luna?.price).toEqual({ input: 0.1, cached: 0.01, output: 0.5 });
+    const high = luna?.rungs.find((r) => r.rung === "codex:gpt-6-luna#high");
+    expect(high?.scores.repo_code).toEqual({
+      value: 66.6,
+      benchmark: "DeepSWE 1.1",
+      confidence: "adjacent",
+      source: "shipped",
+      date: "2026-09-22",
+    });
+    expect(high?.scores.frontend).toMatchObject({ source: "arena", confidence: "adjacent" });
+    expect(high?.scores.agentic).toMatchObject({ confidence: "inferred", from: "gpt-5.6-luna#high" });
+    expect(high?.evidence).toBe("1 lane");
+    expect(luna?.rungs.find((r) => r.rung === "codex:gpt-6-luna#max")?.evidence).toBeNull();
+  });
+
   it("lists a discovered model catherd cannot score, disabled until the user maps it", async () => {
     withHome();
     writeDiscovery(
````

Edit `test/services/routing-service.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/routing-service.test.ts b/test/services/routing-service.test.ts
index 585a4c3..d00f11f 100644
--- a/test/services/routing-service.test.ts
+++ b/test/services/routing-service.test.ts
@@ -86,6 +86,7 @@ describe("route without Jev", () => {
       difficulty: "build",
       questionSet: null,
       jev: null,
+      provenance: expect.objectContaining({ rung: TRACK_A.rung }),
     });
     expect(jevRows(r.runDir)).toEqual([
       expect.objectContaining({
@@ -133,6 +134,56 @@ describe("route without Jev", () => {
   });
 });
 
+describe("route's provenance (spec 1.2 §5.3)", () => {
+  it("reports each threshold of the lane's bar, the value used, its confidence and source, and the why", async () => {
+    const a = await routingService().route(req(lane("repo_code", "build")));
+    expect(a.provenance?.thresholds).toEqual([
+      {
+        dim: "repo_code",
+        min: 66.6,
+        clears: true,
+        used: expect.objectContaining({
+          value: 66.6,
+          confidence: "adjacent",
+          source: "shipped",
+          benchmark: "DeepSWE 1.1",
+          inferred: false,
+          from: null,
+        }),
+        why: expect.stringMatching(/^the median of /),
+      },
+    ]);
+    // Luna's agentic value is lent by the shipped treat-like: marked, with the rung it belongs to
+    expect(a.provenance?.values.find((v) => v.dim === "agentic")).toMatchObject({
+      inferred: true,
+      from: "gpt-5.6-luna#high",
+    });
+    expect(a.provenance?.cost).toEqual(expect.objectContaining({ mode: "chatgpt-plan" }));
+    expect(a.provenance?.evidence).toEqual({ kind: null, all: null });
+  });
+
+  it("picks a terminal lane by the terminal bar, and a ui lane by the frontend bar, saying whose values", async () => {
+    const t = await routingService().route(req(lane("terminal", "copy")));
+    expect(t.rung).toBe("codex:gpt-6-sol#medium");
+    expect(
+      t.provenance?.thresholds.map((x) => [x.dim, x.min, x.used?.value, x.used?.source, x.clears]),
+    ).toEqual([["terminal", 40.15, 43, "shipped", true]]);
+    const u = await routingService().route(req(lane("ui", "build")));
+    expect(u.rung).toBe("codex:gpt-6-sol#xhigh");
+    expect(u.provenance?.thresholds.map((x) => [x.dim, x.min, x.used?.source, x.clears])).toEqual([
+      ["repo_code", 66.6, "shipped", true],
+      ["frontend", 1617, "arena", true],
+    ]);
+  });
+
+  it("shows the default rung's values with no thresholds when the route reads no bar", async () => {
+    const a = await routingService().route(req(null));
+    expect(a.source).toBe("default");
+    expect(a.provenance?.thresholds).toEqual([]);
+    expect(a.provenance?.values.length).toBeGreaterThan(0);
+  });
+});
+
 describe("route with Jev", () => {
   it("takes a confident track over the lane's declaration, and logs the decision but never the lane", async () => {
     const f = fakeFetch({
````

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/services/routing-service.test.ts test/services/catalog-service.test.ts test/entry/catalog-command.test.ts test/entry/tui/profile-tree.test.ts`
Expected: FAIL — `route` has no `provenance`; `catalogQuery` rows lack `source` and `evidence`; `formatModel` prints one line.

- [ ] **Step 3: Implement**

Edit `src/domain/catalog.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/catalog.ts b/src/domain/catalog.ts
index 243b002..694248c 100644
--- a/src/domain/catalog.ts
+++ b/src/domain/catalog.ts
@@ -75,6 +75,8 @@ const FamilySchema = z.looseObject({
   notes: z.record(z.string(), z.string()).default({}),
   /** the day the vendor released it (models.dev), a stand-in feature (spec 1.2 §6.3) */
   releaseDate: z.iso.date().optional(),
+  /** a sync's speed facts (spec 1.2 §4.1), `<source>.<field>` → value; they never carry a bar */
+  speed: z.record(z.string(), z.number()).optional(),
 });
 export type Family = z.infer<typeof FamilySchema>;
 
@@ -255,6 +257,7 @@ export function applyFacts(families: Family[], facts: Record<string, FamilyFacts
       capabilities,
       on,
       ...(x.releaseDate || f.releaseDate ? { releaseDate: x.releaseDate ?? f.releaseDate } : {}),
+      ...(Object.keys(x.speed).length ? { speed: x.speed } : {}),
     };
   });
 }
@@ -297,7 +300,8 @@ export function buildCatalog(o: {
   };
   for (const s of o.scores.scores) put(s, false);
   for (const s of o.synced ?? []) put(s, false);
-  for (const s of o.override?.scores ?? []) put(s, true);
+  // the user's values say so, for route's provenance (spec 1.2 §5.3)
+  for (const s of o.override?.scores ?? []) put({ ...s, source: s.source ?? "override" }, true);
   const treatLike: Catalog["treatLike"] = {};
   for (const [rung, t] of Object.entries(o.scores.treatLike))
     treatLike[rung] = { like: t.like, source: "shipped" };
````

Edit `src/entry/catalog-command.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/catalog-command.ts b/src/entry/catalog-command.ts
index 0544d7b..928a1f8 100644
--- a/src/entry/catalog-command.ts
+++ b/src/entry/catalog-command.ts
@@ -79,10 +79,24 @@ export function formatRefreshed(r: Refreshed, plain = false): string {
   ].join("\n");
 }
 
+/**
+ * One model: its rungs scored and roles, then (spec 1.2 §4.1, §8) its price and speed facts, and each rung
+ * catherd has run, with its evidence.
+ */
 export function formatModel(m: CatalogModel): string {
   const scored = m.rungs.filter((r) => r.enabled).length;
   const listed = m.listed === false ? "  not offered by this account" : "";
-  return `${m.backend}:${m.model}  ${scored}/${m.rungs.length} rungs scored  roles ${m.roles.join(",") || "none"}${listed}`;
+  const lines = [
+    `${m.backend}:${m.model}  ${scored}/${m.rungs.length} rungs scored  roles ${m.roles.join(",") || "none"}${listed}`,
+  ];
+  const facts = [
+    ...(m.price ? [`$${m.price.input}/$${m.price.output} per M tokens in/out`] : []),
+    ...Object.entries(m.speed).map(([k, v]) => `${k} ${Number(v.toPrecision(4))}`),
+  ];
+  if (facts.length) lines.push(`  ${facts.join(" · ")}`);
+  for (const r of m.rungs)
+    if (r.evidence) lines.push(`  #${r.rung.slice(r.rung.lastIndexOf("#") + 1)}  ${r.evidence}`);
+  return lines.join("\n");
 }
 
 /** The repository the command runs in, for per-repository listings; none outside one (global). */
````

Edit `src/entry/mcp/lane-tools.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/mcp/lane-tools.ts b/src/entry/mcp/lane-tools.ts
index 2520c86..00a23a9 100644
--- a/src/entry/mcp/lane-tools.ts
+++ b/src/entry/mcp/lane-tools.ts
@@ -13,7 +13,7 @@ export function registerLaneTools(server: McpServer, deps: Deps): void {
     "route",
     {
       description:
-        "The rung for a lane (from Jev, else the lane file's Kind/Difficulty lines, else the profile default) or, without a lane file, a role's default rung, with the ladder above it. Rungs are backend:model#effort; a claude: rung comes with the agent to run it as. A lane whose Kind: or Difficulty: the catalog does not know is refused with E_LANE_INVALID.",
+        "The rung for a lane (from Jev, else the lane file's Kind/Difficulty lines, else the profile default) or, without a lane file, a role's default rung, with the ladder above it. Rungs are backend:model#effort; a claude: rung comes with the agent to run it as. `provenance` says why: each threshold of the lane's bar with the value used against it, that value's confidence, source and date (`inferred: true` when a treat-like or a stand-in lent it), the rung's speed and cost facts, and catherd's own run evidence for it (shown, never used to route). A lane whose Kind: or Difficulty: the catalog does not know is refused with E_LANE_INVALID.",
       inputSchema: {
         run: z.string(),
         lane_file: z.string().optional(),
````

Edit `src/entry/mcp/setup-tools.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/mcp/setup-tools.ts b/src/entry/mcp/setup-tools.ts
index 5c24d9f..48bfe70 100644
--- a/src/entry/mcp/setup-tools.ts
+++ b/src/entry/mcp/setup-tools.ts
@@ -29,7 +29,7 @@ export function registerSetupTools(server: McpServer, deps: Deps): void {
     "catalog_query",
     {
       description:
-        "Models catherd can place, with capabilities, the roles they can fill, their scored rungs (backend:model#effort), any 'treat like', their cost under the billing of `repo`'s profile, and whether this account's last listing offers them (`listed: false`: it does not); `enabled: false` rungs are unscored. Scored models first. opencode's models are as listed in `repo` (default: this server's directory), as route sees them there.",
+        "Models catherd can place, with capabilities, the roles they can fill, their scored rungs (backend:model#effort), any 'treat like', their cost under the billing of `repo`'s profile, and whether this account's last listing offers them (`listed: false`: it does not); `enabled: false` rungs are unscored. Each score has its confidence, source and date (`from` names the rung a lent value belongs to); each model its price and speed facts, each rung catherd's own run evidence. Scored models first. opencode's models are as listed in `repo` (default: this server's directory), as route sees them there.",
       inputSchema: {
         repo: z.string().min(1).optional(),
         role: z.enum(ROLES).optional(),
````

Edit `src/services/catalog-service.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/catalog-service.ts b/src/services/catalog-service.ts
index d63a9d7..214ce68 100644
--- a/src/services/catalog-service.ts
+++ b/src/services/catalog-service.ts
@@ -35,6 +35,8 @@ import { readDerived } from "../infra/sources/cache.ts";
 import { ensurePrivateDir, readVersioned, writeJsonAtomic } from "../infra/store.ts";
 import type { CatalogFilter } from "./ports.ts";
 import { listRuns, readAgentRuns, readRecords, readRoutes } from "./run-store.ts";
+import { valuesUsed } from "./provenance.ts";
+import { type EvidenceTable, evidenceLine, evidenceOf, runEvidence } from "./run-evidence.ts";
 import { withStandIns } from "./standins.ts";
 
 const DAY_MS = 24 * 3_600_000;
@@ -322,22 +324,34 @@ function rungRows(
   model: string,
   efforts: string[],
   billing: Partial<Record<string, BillingMode>>,
+  evidence: EvidenceTable,
 ) {
   return (efforts.length ? efforts : ["default"]).map((effort) => {
     const rung = `${backend}:${model}#${effort}`;
     const info = rungInfo(c, rung);
     const s = scoresOf(c, info.canonical);
-    const scored: Record<string, { value: number; benchmark: string; confidence: string }> = {};
-    for (const d of DIMS) {
-      const r = s?.records[d];
-      if (r)
-        scored[d] = {
-          value: r.value,
-          benchmark: `${r.benchmark} ${r.version}`,
-          // a value lent by a treat-like is catherd's guess for this rung, whatever its own confidence
-          confidence: s?.borrowed.includes(d) ? "inferred" : r.confidence,
-        };
-    }
+    const scored: Record<
+      string,
+      {
+        value: number;
+        benchmark: string;
+        confidence: string;
+        source: string;
+        date: string;
+        /** spec 1.2 §5.3: the rung a borrowed or inferred value belongs to */
+        from?: string;
+      }
+    > = {};
+    for (const v of valuesUsed(c, info.canonical))
+      scored[v.dim] = {
+        value: v.value,
+        benchmark: v.benchmark,
+        // a value lent by a treat-like or a stand-in is catherd's guess for this rung, whatever its own confidence
+        confidence: v.inferred ? "inferred" : v.confidence,
+        source: v.source,
+        date: v.date,
+        ...(v.from ? { from: v.from } : {}),
+      };
     const like = c.treatLike[info.canonical] ?? null;
     return {
       rung,
@@ -346,6 +360,8 @@ function rungRows(
       scores: scored,
       treatLike: s?.via ? like : null,
       cost: costOf(info.family, effort, billing[info.key] ?? DEFAULT_BILLING[info.key]),
+      /** spec 1.2 §8: catherd's own runs on it, over every kind; never used for routing */
+      evidence: evidenceLine(evidenceOf(evidence, info.canonical)),
     };
   });
 }
@@ -362,6 +378,9 @@ export interface CatalogModel {
   roles: Role[];
   listed: boolean | null;
   notes: Record<string, string>;
+  /** spec 1.2 §4.1: the family's API price, dollars per million tokens, and its speed facts */
+  price: Family["price"] | null;
+  speed: Record<string, number>;
   rungs: ReturnType<typeof rungRows>;
 }
 
@@ -374,6 +393,7 @@ export function catalogQuery(
   billing: Partial<Record<string, BillingMode>> = {},
 ): { total: number; models: CatalogModel[] } {
   const c = loadCatalog({ timings: false, repo: f.repo });
+  const evidence = runEvidence(c);
   const rows: CatalogModel[] = [];
   const known = new Set<string>();
   const entry = (backend: string, model: string, fam: Family | null): CatalogModel => {
@@ -390,7 +410,9 @@ export function catalogQuery(
       roles: ROLES.filter((r) => capableFor(c, probe, r)),
       listed: probe.listed,
       notes: fam?.notes ?? {},
-      rungs: rungRows(c, backend, model, probe.efforts, billing),
+      price: fam?.price ?? null,
+      speed: fam?.speed ?? {},
+      rungs: rungRows(c, backend, model, probe.efforts, billing, evidence),
     };
   };
   for (const fam of c.families)
````

Edit `src/services/ports.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/ports.ts b/src/services/ports.ts
index fcd0b54..4075f3b 100644
--- a/src/services/ports.ts
+++ b/src/services/ports.ts
@@ -1,3 +1,4 @@
+import type { Provenance } from "./provenance.ts";
 import type { Budget } from "../domain/budget.ts";
 import type { SessionEnv } from "../infra/claude-session.ts";
 import type { BillingMode } from "../domain/cost.ts";
@@ -87,6 +88,8 @@ export interface RouteAnswer {
   /** the Jev question set asked, and its summed probabilities, for outcomes.jsonl (spec §5.6) */
   questionSet: string | null;
   jev: RouteJev | null;
+  /** spec 1.2 §5.3, §8: the chosen rung's thresholds, values, sources, facts and run evidence */
+  provenance?: Provenance;
 }
 
 export type { Verdict };
````

Create `src/services/provenance.ts`:

````ts
import { type Catalog, type Confidence, DIMS, type Dim, rungInfo, scoresOf } from "../domain/catalog.ts";
import { type BillingMode, type Cost, costOf, DEFAULT_BILLING } from "../domain/cost.ts";
import type { Difficulty, Kind } from "../domain/lane.ts";
import { type EvidenceTable, evidenceLine, evidenceOf } from "./run-evidence.ts";

/** Spec 1.2 §5.3: one value routing uses for a rung, with where it came from. */
export interface ValueUsed {
  dim: Dim;
  value: number;
  confidence: Confidence;
  /** the source a synced value came from; `shipped` for a hand-typed one, `override` for the user's */
  source: string;
  benchmark: string;
  date: string;
  url: string;
  /** catherd's guess for this rung: lent by a treat-like or an inferred stand-in (spec 1.2 §6.1) */
  inferred: boolean;
  /** the rung the value belongs to, when it is not this one */
  from: string | null;
}

/** Spec 1.2 §5.3: one threshold of the lane's bar, the value used against it, and whether it clears. */
export interface Threshold {
  dim: Dim;
  min: number;
  used: ValueUsed | null;
  clears: boolean;
  /** where the default threshold came from (`barsWhy`) */
  why: string | null;
}

/** Spec 1.2 §5.3, §8: what `route` reports about the rung it chose. */
export interface Provenance {
  rung: string;
  canonical: string;
  /** the lane's bar, threshold by threshold; empty when the route read no bar (the default rung) */
  thresholds: Threshold[];
  /** every value the rung has */
  values: ValueUsed[];
  /** facts that never carry a bar (spec 1.2 §4.1): `<source>.<field>` → value */
  speed: Record<string, number>;
  cost: Cost;
  /** spec 1.2 §8: its runs for the lane's kind (or every kind) and over every kind; never used for routing */
  evidence: { kind: string | null; all: string | null };
}

/** Spec 1.2 §5.3: each value a canonical rung has, with its confidence and source, borrowed ones marked. */
export function valuesUsed(c: Catalog, canonical: string): ValueUsed[] {
  const s = scoresOf(c, canonical);
  if (!s) return [];
  return DIMS.flatMap((dim) => {
    const r = s.records[dim];
    if (!r) return [];
    const from = s.borrowed.includes(dim) ? s.via : (s.standIns[dim] ?? null);
    return [
      {
        dim,
        value: r.value,
        confidence: r.confidence,
        source: r.source ?? "shipped",
        benchmark: `${r.benchmark} ${r.version}`,
        date: r.date,
        url: r.url,
        inferred: from !== null,
        from,
      },
    ];
  });
}

/** Spec 1.2 §5.3: the chosen rung's thresholds for the lane's kind and difficulty, its values and facts. */
export function provenanceOf(
  c: Catalog,
  rung: string,
  kind: Kind | null,
  difficulty: Difficulty | null,
  billing: Partial<Record<string, BillingMode>>,
  evidence: EvidenceTable,
): Provenance {
  const info = rungInfo(c, rung);
  const values = valuesUsed(c, info.canonical);
  const bar = kind && difficulty ? c.bars[kind][difficulty] : {};
  const thresholds: Threshold[] = DIMS.flatMap((dim) => {
    const min = bar[dim];
    if (min === undefined || !kind || !difficulty) return [];
    const used = values.find((v) => v.dim === dim) ?? null;
    return [
      {
        dim,
        min,
        used,
        clears: used !== null && used.value >= min,
        why: c.barsWhy[dim]?.[difficulty] ?? null,
      },
    ];
  });
  return {
    rung,
    canonical: info.canonical,
    thresholds,
    values,
    speed: info.family?.speed ?? {},
    cost: costOf(info.family, info.parsed.effort, billing[info.key] ?? DEFAULT_BILLING[info.key]),
    evidence: {
      kind: evidenceLine(evidenceOf(evidence, info.canonical, kind)),
      all: evidenceLine(evidenceOf(evidence, info.canonical)),
    },
  };
}

/** A value as one line: `repo_code 66.6 (adjacent, shipped DeepSWE 1.1, 2026-09-22)`, marking a guess. */
export function valueWords(v: ValueUsed): string {
  const lent = v.inferred ? `, inferred from ${v.from}` : "";
  return `${v.dim} ${v.value} (${v.confidence}, ${v.source} ${v.benchmark}, ${v.date}${lent})`;
}
````

Edit `src/services/routing-service.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/routing-service.ts b/src/services/routing-service.ts
index 06d8141..6260edd 100644
--- a/src/services/routing-service.ts
+++ b/src/services/routing-service.ts
@@ -24,6 +24,8 @@ import { log } from "../infra/log.ts";
 import { catalogQuery, freshenDiscovery, loadCatalog } from "./catalog-service.ts";
 import { type Asked, askJev, type JevOpts, jevQuestions, logJev } from "./jev-service.ts";
 import type { ProfileView, RouteAnswer, RouteRequest, RoutingPort, Verdict } from "./ports.ts";
+import { provenanceOf } from "./provenance.ts";
+import { runEvidence } from "./run-evidence.ts";
 
 function routingProfile(v: ProfileView, role: Role, spentFraction: number): RoutingProfile {
   const rc = v.roles[role];
@@ -87,8 +89,10 @@ async function route(req: RouteRequest, o: RoutingOpts): Promise<RouteAnswer> {
   await freshenWithin(p.role.rungs, req.repo, o.discoveryBudgetMs ?? DISCOVERY_BUDGET_MS);
   const c = loadCatalog({ repo: req.repo });
   const fallback = () => defaultLadder(c, p, req.role);
-  if (req.laneText === null || candidates(c, p, req.role).length <= 1)
-    return answer(fallback(), "default", null, null, null, null);
+  if (req.laneText === null || candidates(c, p, req.role).length <= 1) {
+    const out = answer(fallback(), "default", null, null, null, null);
+    return { ...out, provenance: provenanceOf(c, out.rung, null, null, p.billing, runEvidence(c)) };
+  }
   const lane = parseLaneHeader(req.laneText);
   let asked: Asked | null = null;
   let judged: ReturnType<typeof judgeRoute> | null = null;
@@ -120,6 +124,7 @@ async function route(req: RouteRequest, o: RoutingOpts): Promise<RouteAnswer> {
         ? answer(select(c, p, req.role, kind, lane.difficulty), "lane", kind, lane.difficulty, asked, jev)
         : answer(fallback(), "default", null, null, asked, jev);
   }
+  out.provenance = provenanceOf(c, out.rung, out.kind, out.difficulty, p.billing, runEvidence(c));
   if (asked) {
     logJev(req.runDir, {
       ...asked.meta,
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/services/routing-service.test.ts test/services/catalog-service.test.ts test/entry/catalog-command.test.ts test/entry/tui/profile-tree.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/domain/catalog.ts src/entry/catalog-command.ts src/entry/mcp/lane-tools.ts src/entry/mcp/setup-tools.ts src/services/catalog-service.ts src/services/ports.ts src/services/provenance.ts src/services/routing-service.ts test/entry/catalog-command.test.ts test/entry/tui/profile-tree.test.ts test/services/catalog-service.test.ts test/services/routing-service.test.ts
git commit -m "feat(routing): route and catalog_query show each value's source, confidence and run evidence"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 9: Doctor's sources row lists the stand-ins to confirm (spec 1.2 §9; Rulings 13, 19)

plan 13 R-B left "the stand-ins to confirm" in doctor's `sources` row to this plan: `standInsToConfirmIn(profiles)` collects them over the active and linked profiles, one per canonical rung, and `sourcesCheck` appends `stand-ins to confirm: <rung> (<dims>), …` to its detail when there are any (the row's state is unchanged: the profile rows carry the warning).

**Files:**

- Modify: `src/services/doctor-sources.ts`
- Modify: `src/services/doctor.ts`
- Test: `test/services/doctor-sources.test.ts`

**Interfaces:**
- Consumes: Task 5's `standInsToConfirm`; `loadCatalog`, `runnableBackends`.
- Produces: `doctor-sources.ts`: `standInsToConfirmIn(profiles: Profile[]): StandInToConfirm[]`, `sourcesCheck(now = Date.now(), confirm: StandInToConfirm[] = [])`.

- [ ] **Step 1: Write the failing tests**

Edit `test/services/doctor-sources.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/doctor-sources.test.ts b/test/services/doctor-sources.test.ts
index e120265..8f2f1d6 100644
--- a/test/services/doctor-sources.test.ts
+++ b/test/services/doctor-sources.test.ts
@@ -1,6 +1,7 @@
 import { afterEach, describe, expect, it } from "bun:test";
 import { MODELS_DEV_URL } from "../../src/infra/sources/models-dev.ts";
-import { ageText, sourcesCheck } from "../../src/services/doctor-sources.ts";
+import { applyPatch, defaultProfileDoc, resolveProfile } from "../../src/domain/profile.ts";
+import { ageText, sourcesCheck, standInsToConfirmIn } from "../../src/services/doctor-sources.ts";
 import { syncSources, TTL_MS } from "../../src/services/source-sync.ts";
 import { snapshotEnv, withHome } from "../helpers.ts";
 import { recordedFetch } from "./source-fixtures.ts";
@@ -81,3 +82,24 @@ describe("doctor's sources row (spec 1.2 §9)", () => {
     ]).toEqual(["1 min", "2 h", "47 h", "5 d"]);
   });
 });
+
+describe("doctor's stand-ins to confirm (spec 1.2 §6.1, §9)", () => {
+  it("lists the rungs that lean on an inferred stand-in, once each, and nothing for the default profile", () => {
+    withHome();
+    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
+    const def = resolveProfile(defaultProfileDoc(), "default");
+    expect(standInsToConfirmIn([def])).toEqual([]);
+    const worker = [...def.roles.worker.rungs, "codex:gpt-5.6-terra#high"];
+    const terra = resolveProfile(
+      applyPatch(defaultProfileDoc(), { roles: { worker: { rungs: worker } } }),
+      "t",
+    );
+    const confirm = standInsToConfirmIn([terra, terra]);
+    expect(confirm.map((x) => [x.canonical, x.dims.map((d) => d.dim)])).toEqual([
+      ["gpt-5.6-terra#high", ["repo_code", "terminal", "honesty"]],
+    ]);
+    expect(sourcesCheck(T0, confirm).detail).toBe(
+      "routing uses the shipped scores; no Artificial Analysis key; stand-ins to confirm: gpt-5.6-terra#high (repo_code, terminal, honesty)",
+    );
+  });
+});
````

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/services/doctor-sources.test.ts test/services/doctor.test.ts`
Expected: FAIL — `standInsToConfirmIn` is not exported.

- [ ] **Step 3: Implement**

Edit `src/services/doctor-sources.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/doctor-sources.ts b/src/services/doctor-sources.ts
index 0d9dc26..cb51526 100644
--- a/src/services/doctor-sources.ts
+++ b/src/services/doctor-sources.ts
@@ -1,4 +1,8 @@
+import type { Profile } from "../domain/profile.ts";
+import { type StandInToConfirm, standInsToConfirm } from "../domain/profile-rules.ts";
+import { loadCatalog } from "./catalog-service.ts";
 import type { Check } from "./doctor-checks.ts";
+import { runnableBackends } from "./profile-store.ts";
 import { sourcesStatus, TTL_MS } from "./source-sync.ts";
 
 const HOUR = 3_600_000;
@@ -11,13 +15,29 @@ export function ageText(ms: number): string {
   return `${Math.round(ms / DAY)} d`;
 }
 
+/** Spec 1.2 §6.1, §9: the stand-ins to confirm across `profiles`, one per canonical rung. */
+export function standInsToConfirmIn(profiles: Profile[]): StandInToConfirm[] {
+  if (profiles.length === 0) return [];
+  const c = loadCatalog({ timings: false });
+  const seen = new Map<string, StandInToConfirm>();
+  for (const p of profiles)
+    for (const x of standInsToConfirm(p, c, runnableBackends()))
+      if (!seen.has(x.canonical)) seen.set(x.canonical, x);
+  return [...seen.values()];
+}
+
+/** `gpt-5.6-terra#high (repo_code, terminal, honesty)`, the rung and the dimensions a stand-in fills. */
+const confirmText = (xs: StandInToConfirm[]): string =>
+  `stand-ins to confirm: ${xs.map((x) => `${x.canonical} (${x.dims.map((d) => d.dim).join(", ")})`).join(", ")}`;
+
 /**
  * Spec 1.2 §9: the `sources` row: each source's age and last error, whether an Artificial Analysis key is
- * set, and its requests left today (`x-ratelimit-remaining` of its last answer). `info` before the first
- * sync (routing uses the shipped scores); a warning when a source fails or has not been fetched for two
- * TTLs (a day), since background syncs would have refreshed it. It reads the sync's state only: no request.
+ * set, its requests left today (`x-ratelimit-remaining` of its last answer), and the linked profiles'
+ * stand-ins to confirm (`confirm`, spec 1.2 §6.1). `info` before the first sync (routing uses the shipped
+ * scores); a warning when a source fails or has not been fetched for two TTLs (a day), since background
+ * syncs would have refreshed it. It reads the sync's state only: no request.
  */
-export function sourcesCheck(now = Date.now()): Check {
+export function sourcesCheck(now = Date.now(), confirm: StandInToConfirm[] = []): Check {
   const s = sourcesStatus();
   const shown = s.sources.filter((x) => x.source !== "artificial-analysis" || s.aaKey);
   const keyless = s.sources.filter((x) => x.source !== "artificial-analysis");
@@ -29,7 +49,7 @@ export function sourcesCheck(now = Date.now()): Check {
       : sameDay
         ? `, ${s.rateLimitRemaining} requests left today`
         : `, ${s.rateLimitRemaining} requests left on ${s.rateLimitAt?.slice(0, 10)}`;
-  const aa = s.aaKey ? `Artificial Analysis key set${left}` : "no Artificial Analysis key";
+  const aa = `${s.aaKey ? `Artificial Analysis key set${left}` : "no Artificial Analysis key"}${confirm.length ? `; ${confirmText(confirm)}` : ""}`;
   const base = { id: "sources", label: "sources" };
   if (keyless.every((x) => x.fetchedAt === null && x.error === null))
     return {
````

Edit `src/services/doctor.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/doctor.ts b/src/services/doctor.ts
index 491359d..37ebf5a 100644
--- a/src/services/doctor.ts
+++ b/src/services/doctor.ts
@@ -9,7 +9,7 @@ import { linkedProfiles } from "./agent-links.ts";
 import { accessChecks } from "./doctor-access.ts";
 import { backendChecks, usedBackends } from "./doctor-backends.ts";
 import { type PushProbe, pushCheck } from "./doctor-push.ts";
-import { sourcesCheck } from "./doctor-sources.ts";
+import { sourcesCheck, standInsToConfirmIn } from "./doctor-sources.ts";
 import {
   agentsCheck,
   type Check,
@@ -191,8 +191,14 @@ export async function doctor(d: DoctorDeps): Promise<DoctorReport> {
     }
   }
 
-  // spec 1.2 §9: the public sources' ages and errors, and the Artificial Analysis key
-  checks.push(guarded("sources", "sources", "catherd catalog sync --force", () => sourcesCheck()));
+  // spec 1.2 §9: the public sources' ages and errors, the Artificial Analysis key, and the active and linked
+  // profiles' stand-ins to confirm
+  const mine = [...(active ? [active] : []), ...profiles.filter((p) => p.name !== active?.name)];
+  checks.push(
+    guarded("sources", "sources", "catherd catalog sync --force", () =>
+      sourcesCheck(Date.now(), standInsToConfirmIn(mine)),
+    ),
+  );
 
   checks.push(pluginCheck(d.version));
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/services/doctor-sources.test.ts test/services/doctor.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/services/doctor-sources.ts src/services/doctor.ts test/services/doctor-sources.test.ts
git commit -m "feat(doctor): the sources row lists the stand-ins to confirm"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 10: Dashboard: r syncs the sources, i shows a rung's values and runs, t suggests stand-ins first (spec 1.2 §9 TUI; Ruling 17)

In the Profiles tab, `r` lists every backend's models and syncs the public sources, then opens a "Sources" list with each source's age and last error; `i` on a rung shows its values with confidence, source and date, and catherd's runs on it; `t` on a rung opens the treat-like picker with the three nearest stand-ins first (the dialog's `suggested`, each with its distance and what it lends). The effects seam gains `syncSources`, `sources`, `suggest` and `rungDetail`, live and in the fixtures.

**Files:**

- Modify: `src/entry/tui/commands.ts`
- Modify: `src/entry/tui/effects.ts`
- Modify: `src/entry/tui/fixtures.ts`
- Modify: `src/entry/tui/profile-edits.ts`
- Modify: `src/entry/tui/state.ts`
- Modify: `src/entry/tui/views/profiles.tsx`
- Test: `test/entry/tui/profiles.test.tsx`

**Interfaces:**
- Consumes: Task 4's `suggestStandIns`, Task 7's run evidence, Task 8's `valuesUsed`, plan 13's `syncSources`, `sourcesStatus`, `ageText`.
- Produces: `Effects.syncSources(): Promise<SyncReport>`, `Effects.sources(): { source; name; age; error }[]`, `Effects.suggest(c, rung): Suggestion[]`, `Effects.rungDetail(c, rung): { values: ValueUsed[]; evidence: string | null }`; `effects.ts` exports `sourceRows`, `rungDetailOf`, `suggestFor`; `fixtures.ts` exports `FIXTURE_SOURCES`; purposes `sources` and `rung`; commands `tree.detail` (`i`) and `tree.treatLike` (`t`); `treatLikeOptions(c, suggestions = [])`.

- [ ] **Step 1: Write the failing tests**

Edit `test/entry/tui/profiles.test.tsx` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/entry/tui/profiles.test.tsx b/test/entry/tui/profiles.test.tsx
index 55990f6..57b02a1 100644
--- a/test/entry/tui/profiles.test.tsx
+++ b/test/entry/tui/profiles.test.tsx
@@ -93,6 +93,43 @@ describe("the Profiles tab", () => {
     expect(new Set(group.map((l) => l.search(/\d+ of \d+/))).size).toBe(1);
   });
 
+  it("syncs the sources and refreshes the catalog with r, then lists each source's age and last error", async () => {
+    const fx = await profiles();
+    await h!.s.press("r");
+    await h!.advance(0);
+    expect(fx.writes).toEqual(["refresh", "sync"]);
+    const f = h!.s.frame();
+    expect(f).toContain("Sources");
+    expect(f).toMatch(/models\.dev +2 h ago/);
+    expect(f).toMatch(/Epoch AI benchmarks +1 d ago · network error/);
+    await h!.s.press("escape");
+    expect(h!.app().getState().dialogs).toEqual([]);
+  });
+
+  it("shows a rung's values with confidence and source, and catherd's runs on it, with i", async () => {
+    await profiles();
+    await find("codex gpt-6-luna high");
+    await h!.s.press("i");
+    const f = h!.s.frame();
+    expect(f).toContain("codex:gpt-6-luna#high");
+    expect(f).toMatch(/repo_code 66\.6 +adjacent · shipped DeepSWE 1\.1/);
+    expect(f).toMatch(/agentic -0\.0075 +inferred from gpt-5\.6-luna#high/);
+    expect(f).toContain("no runs yet");
+  });
+
+  it("opens the treat-like picker with t, the three nearest stand-ins first (spec 1.2 §6.4)", async () => {
+    await profiles();
+    await find("codex gpt-6-sol medium");
+    await h!.s.press("t");
+    const f = h!.s.frame();
+    expect(f).toContain("Treat codex:gpt-6-sol#medium like…");
+    const lines = f.split("\n");
+    const at = lines.findIndex((l) => l.includes("Suggested"));
+    expect(at).toBeGreaterThan(-1);
+    const top = lines.slice(at + 1, at + 4);
+    expect(top.every((l) => /distance \d+\.\d\d · lends/.test(l))).toBe(true);
+  });
+
   it("cycles access with enter, and shows how strongly the backend holds it", async () => {
     const fx = await profiles();
     await find("worker access");
````

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/entry/tui`
Expected: FAIL — `r` writes only `refresh`; `i` and `t` do nothing.

- [ ] **Step 3: Implement**

Edit `src/entry/tui/commands.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/tui/commands.ts b/src/entry/tui/commands.ts
index cbf4983..d289571 100644
--- a/src/entry/tui/commands.ts
+++ b/src/entry/tui/commands.ts
@@ -211,12 +211,12 @@ export const COMMANDS = [
   },
   {
     id: "catalog.refresh",
-    title: "Refresh the model catalog",
+    title: "Sync the public sources and refresh the model catalog",
     group: "Profiles",
     scope: "tab.profiles",
     keys: ["r"],
     palette: true,
-    cli: "catherd catalog refresh",
+    cli: "catherd catalog sync",
   },
   {
     id: "edit.undo",
@@ -305,6 +305,24 @@ export const COMMANDS = [
     short: "change",
   },
   { id: "tree.expand", title: "Expand", group: "Profiles", scope: "row.profiles", keys: ["right", "l"] },
+  {
+    id: "tree.detail",
+    title: "Show the rung's values, sources and runs",
+    group: "Profiles",
+    scope: "row.profiles",
+    keys: ["i"],
+    palette: true,
+    cli: "catherd catalog list --json",
+  },
+  {
+    id: "tree.treatLike",
+    title: "Treat the rung like another…",
+    group: "Profiles",
+    scope: "row.profiles",
+    keys: ["t"],
+    palette: true,
+    cli: "catherd catalog treat-like --suggest <rung>",
+  },
   {
     id: "tree.collapse",
     title: "Collapse, or go to the parent",
````

Edit `src/entry/tui/effects.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/tui/effects.ts b/src/entry/tui/effects.ts
index 17f2b0b..a064c0c 100644
--- a/src/entry/tui/effects.ts
+++ b/src/entry/tui/effects.ts
@@ -2,7 +2,7 @@ import { realpathSync, statSync, watch } from "node:fs";
 import { adapterFor } from "../../adapters/registry.ts";
 import "../../adapters/all.ts";
 import { agentFiles } from "../../domain/agents.ts";
-import type { Catalog } from "../../domain/catalog.ts";
+import { type Catalog, rungInfo } from "../../domain/catalog.ts";
 import { HARNESS_KEYS, type Profile, type ProfileDoc, type ProfilePatch } from "../../domain/profile.ts";
 import { type Validation, validateProfile } from "../../domain/profile-rules.ts";
 import type { Access } from "../../domain/record.ts";
@@ -17,6 +17,11 @@ import {
 } from "../../services/catalog-service.ts";
 import { cancel } from "../../services/dispatch-service.ts";
 import { type DoctorReport, doctor } from "../../services/doctor.ts";
+import { ageText } from "../../services/doctor-sources.ts";
+import { valuesUsed, type ValueUsed } from "../../services/provenance.ts";
+import { evidenceLine, evidenceOf, runEvidence } from "../../services/run-evidence.ts";
+import { type SyncReport, sourcesStatus, syncSources } from "../../services/source-sync.ts";
+import { type Suggestion, suggestStandIns } from "../../services/standins.ts";
 import type { Synced } from "../../services/agent-links.ts";
 import {
   activate,
@@ -139,6 +144,46 @@ export interface Effects {
   create(name: string, from?: string): Saved;
   remove(name: string): Synced;
   refreshCatalog(): Promise<Refreshed[]>;
+  /** spec 1.2 §9 (`r`): syncs the public sources (each at most every 12 hours) */
+  syncSources(): Promise<SyncReport>;
+  /** spec 1.2 §9: each source's name, age and last error, as the `r` dialog shows them */
+  sources(): { source: string; name: string; age: string; error: string | null }[];
+  /** spec 1.2 §6.3: the three nearest stand-ins for a rung, for the treat-like picker */
+  suggest(c: Catalog, rung: string): Suggestion[];
+  /** spec 1.2 §5.3, §8: a rung's values with confidence and source, and catherd's own runs on it */
+  rungDetail(c: Catalog, rung: string): { values: ValueUsed[]; evidence: string | null };
+}
+
+/** Spec 1.2 §9: each source's age and last error, from the sync's state. */
+export function sourceRows(now = Date.now()): ReturnType<Effects["sources"]> {
+  return sourcesStatus().sources.map((s) => ({
+    source: s.source,
+    name: s.name,
+    age: s.fetchedAt ? `${ageText(now - Date.parse(s.fetchedAt))} ago` : "never fetched",
+    error: s.error,
+  }));
+}
+
+/** Spec 1.2 §5.3, §8: what the rung detail shows; an unparseable rung has nothing to show. */
+export function rungDetailOf(c: Catalog, rung: string): ReturnType<Effects["rungDetail"]> {
+  try {
+    const canonical = rungInfo(c, rung).canonical;
+    return {
+      values: valuesUsed(c, canonical),
+      evidence: evidenceLine(evidenceOf(runEvidence(c), canonical)),
+    };
+  } catch {
+    return { values: [], evidence: null };
+  }
+}
+
+/** Spec 1.2 §6.3: a rung's nearest stand-ins; none for a rung that does not parse. */
+export function suggestFor(c: Catalog, rung: string): Suggestion[] {
+  try {
+    return suggestStandIns(c, rungInfo(c, rung).canonical);
+  } catch {
+    return [];
+  }
 }
 
 /** The word for `here`: the bound repo's profile, or the global active one. */
@@ -308,5 +353,9 @@ export function liveEffects(repo: string | null = null): Effects {
     create: createProfile,
     remove: deleteProfile,
     refreshCatalog: () => refreshDiscovery(),
+    syncSources: () => syncSources(),
+    sources: () => sourceRows(),
+    suggest: suggestFor,
+    rungDetail: rungDetailOf,
   };
 }
````

Edit `src/entry/tui/fixtures.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/tui/fixtures.ts b/src/entry/tui/fixtures.ts
index 475273d..664e5f0 100644
--- a/src/entry/tui/fixtures.ts
+++ b/src/entry/tui/fixtures.ts
@@ -17,8 +17,10 @@ import {
   type RoleDetail,
   type RoleRow,
   rowOf,
+  rungDetailOf,
   type SessionRow,
   type SessionRun,
+  suggestFor,
 } from "./effects.ts";
 import { withStaged } from "./profile-tree.ts";
 
@@ -401,6 +403,14 @@ export interface FixtureOptions {
   watchable?: boolean;
 }
 
+/** Spec 1.2 §9: the sources as the `r` dialog shows them, one failing. */
+export const FIXTURE_SOURCES: ReturnType<Effects["sources"]> = [
+  { source: "models-dev", name: "models.dev", age: "2 h ago", error: null },
+  { source: "arena", name: "Arena (LMArena)", age: "2 h ago", error: null },
+  { source: "epoch", name: "Epoch AI benchmarks", age: "1 d ago", error: "network error" },
+  { source: "artificial-analysis", name: "Artificial Analysis", age: "never fetched", error: null },
+];
+
 export function fixtureEffects(o: FixtureOptions = {}): Effects & {
   writes: string[];
   /** what a change to a watched run file does: every open watch hears of it */
@@ -584,5 +594,20 @@ export function fixtureEffects(o: FixtureOptions = {}): Effects & {
       writes.push("refresh");
       return [{ backend: "codex", models: 14, fetchedAt: "2026-09-26T12:00:00.000Z" }];
     },
+    async syncSources() {
+      writes.push("sync");
+      return {
+        busy: false,
+        sources: [],
+        newlyScored: [],
+        noLongerNeeded: [],
+        failed: [],
+        warnings: [],
+        unmatched: {},
+      };
+    },
+    sources: () => FIXTURE_SOURCES,
+    suggest: suggestFor,
+    rungDetail: rungDetailOf,
   };
 }
````

Edit `src/entry/tui/profile-edits.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/tui/profile-edits.ts b/src/entry/tui/profile-edits.ts
index effb07b..b5b49eb 100644
--- a/src/entry/tui/profile-edits.ts
+++ b/src/entry/tui/profile-edits.ts
@@ -1,3 +1,4 @@
+import type { Suggestion } from "../../services/standins.ts";
 import { type Catalog, rungInfo, scoresOf } from "../../domain/catalog.ts";
 import { parseRung, tryParseRung } from "../../domain/ids.ts";
 import { NOTIFY, type Profile, type ProfilePatch } from "../../domain/profile.ts";
@@ -125,14 +126,21 @@ export function failoverOptions(
   return out;
 }
 
-/** The treat-like picker: every rung with scores of its own, by model. */
-export function treatLikeOptions(c: Catalog): SelectOption[] {
+/**
+ * The treat-like picker: every rung with scores of its own, by model; spec 1.2 §6.4: the suggested stand-ins
+ * (`suggestions`, nearest first) say their distance and what they would lend.
+ */
+export function treatLikeOptions(c: Catalog, suggestions: Suggestion[] = []): SelectOption[] {
   return Object.keys(c.scores)
     .filter((canonical) => scoresOf(c, canonical)?.via === null)
     .sort()
-    .map((canonical) => ({
-      value: canonical,
-      title: canonical,
-      group: canonical.slice(0, canonical.lastIndexOf("#")),
-    }));
+    .map((canonical) => {
+      const s = suggestions.find((x) => x.like === canonical);
+      return {
+        value: canonical,
+        title: canonical,
+        group: canonical.slice(0, canonical.lastIndexOf("#")),
+        ...(s ? { detail: `distance ${s.distance.toFixed(2)} · lends ${s.lends.join(", ")}` } : {}),
+      };
+    });
 }
````

Edit `src/entry/tui/state.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/tui/state.ts b/src/entry/tui/state.ts
index c0680ca..ca34fe6 100644
--- a/src/entry/tui/state.ts
+++ b/src/entry/tui/state.ts
@@ -54,6 +54,10 @@ export type Purpose =
   | { type: "start"; role: Role }
   | { type: "treatLike"; rung: string; role: Role | null }
   | { type: "failover"; rung: string }
+  /** spec 1.2 §9: each source's age and last error, after `r` synced them */
+  | { type: "sources" }
+  /** spec 1.2 §9: a rung's values with confidence and source, and its runs */
+  | { type: "rung"; rung: string }
   | { type: "stories" };
 
 export interface SelectOption {
````

Edit `src/entry/tui/views/profiles.tsx` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/tui/views/profiles.tsx b/src/entry/tui/views/profiles.tsx
index afe6f08..91e525b 100644
--- a/src/entry/tui/views/profiles.tsx
+++ b/src/entry/tui/views/profiles.tsx
@@ -1,5 +1,6 @@
 import { useEffect, useMemo, useRef, useState } from "react";
 import { type Profile, resolveProfile } from "../../../domain/profile.ts";
+import type { Role } from "../../../domain/roles.ts";
 import { errorMessage, isCatherdError } from "../../../domain/errors.ts";
 import { hereWord } from "../effects.ts";
 import { useApp, useDialogHandler } from "../providers/app.tsx";
@@ -215,17 +216,7 @@ export function ProfilesView(props: { width: number; height: number }) {
           empty: "no scored rung on another quota",
         },
       });
-    else if (a.type === "rung" && !a.scored)
-      app.dispatch({
-        type: "open",
-        dialog: {
-          kind: "select",
-          purpose: { type: "treatLike", rung: a.rung, role: a.role },
-          title: `Treat ${a.rung} like…`,
-          options: treatLikeOptions(catalog),
-          empty: "no scored rung",
-        },
-      });
+    else if (a.type === "rung" && !a.scored) openTreatLike(a.rung, a.role);
     else if (a.type === "number") {
       const v = numberValue(profile, a.path);
       app.dispatch({
@@ -241,6 +232,49 @@ export function ProfilesView(props: { width: number; height: number }) {
       });
     }
   };
+  /** spec 1.2 §6.4: the treat-like picker, its three nearest stand-ins first */
+  const openTreatLike = (rung: string, role: Role | null) => {
+    if (!catalog) return;
+    const suggestions = app.effects.suggest(catalog, rung);
+    app.dispatch({
+      type: "open",
+      dialog: {
+        kind: "select",
+        purpose: { type: "treatLike", rung, role },
+        title: `Treat ${rung} like…`,
+        options: treatLikeOptions(catalog, suggestions),
+        suggested: suggestions.map((s) => s.like),
+        empty: "no scored rung",
+      },
+    });
+  };
+  /** spec 1.2 §9: the rung's values with confidence and source, and catherd's runs on it */
+  const openDetail = (rung: string) => {
+    if (!catalog) return;
+    const d = app.effects.rungDetail(catalog, rung);
+    app.dispatch({
+      type: "open",
+      dialog: {
+        kind: "select",
+        purpose: { type: "rung", rung },
+        title: rung,
+        options: [
+          ...d.values.map((v) => ({
+            value: v.dim,
+            title: `${v.dim} ${v.value}`,
+            group: "values",
+            detail: `${v.inferred ? `inferred from ${v.from}` : v.confidence} · ${v.source} ${v.benchmark} · ${v.date}`,
+          })),
+          {
+            value: "runs",
+            title: d.evidence ?? "no runs yet",
+            group: "catherd's runs (never used to route)",
+          },
+        ],
+        empty: "no values",
+      },
+    });
+  };
   const primary = (r: Row | null) => {
     const p = current();
     if (!r || !p) return;
@@ -267,10 +301,31 @@ export function ProfilesView(props: { width: number; height: number }) {
     "catalog.refresh": () => {
       // after a failed read, r reads it again (and only that)
       if (failure) return failure.retry();
-      void app.effects.refreshCatalog().then(
-        () => {
+      // spec 1.2 §9: r lists every backend's models and syncs the public sources, then shows each source's
+      // age and last error
+      void Promise.all([app.effects.refreshCatalog(), app.effects.syncSources()]).then(
+        ([, sync]) => {
           loaded.refresh();
-          app.toast({ variant: "success", message: "Catalog refreshed" });
+          app.toast({
+            variant: sync.failed.length ? "warning" : "success",
+            message: sync.busy
+              ? "Catalog refreshed; another sync is running"
+              : `Catalog refreshed${sync.newlyScored.length ? `; ${sync.newlyScored.length} rungs newly scored` : ""}`,
+          });
+          app.dispatch({
+            type: "open",
+            dialog: {
+              kind: "select",
+              purpose: { type: "sources" },
+              title: "Sources",
+              options: app.effects.sources().map((s) => ({
+                value: s.source,
+                title: s.name,
+                detail: s.error ? `${s.age} · ${s.error}` : s.age,
+              })),
+              empty: "no sources",
+            },
+          });
         },
         (e: unknown) => app.toast(errorToast(e)),
       );
@@ -279,6 +334,16 @@ export function ProfilesView(props: { width: number; height: number }) {
     "edit.redo": () => app.dispatch({ type: "redo" }),
   });
   useCommandLayer("row.profiles", {
+    "tree.detail": () => {
+      const a = rowNow()?.action;
+      if (a?.type === "rung") openDetail(a.rung);
+      else app.toast({ variant: "info", message: "Pick a rung (an effort row) to see its values" });
+    },
+    "tree.treatLike": () => {
+      const a = rowNow()?.action;
+      if (a?.type === "rung") openTreatLike(a.rung, a.role);
+      else app.toast({ variant: "info", message: "Pick a rung (an effort row) to map it" });
+    },
     "tree.toggle": () => toggle(rowNow()),
     "tree.open": () => primary(rowNow()),
     "tree.expand": () => {
@@ -313,6 +378,8 @@ export function ProfilesView(props: { width: number; height: number }) {
         : null;
     app.dispatch({ type: "treatLike", rung: p.rung, like: value, ...(tick ? { patch: tick } : {}) });
   });
+  useDialogHandler("sources", () => app.dispatch({ type: "close" }));
+  useDialogHandler("rung", () => app.dispatch({ type: "close" }));
   useDialogHandler("number", (p, value) => {
     if (p.type !== "number") return;
     const r = parseNumber(p.path, value);
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/entry/tui` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/entry/tui/commands.ts src/entry/tui/effects.ts src/entry/tui/fixtures.ts src/entry/tui/profile-edits.ts src/entry/tui/state.ts src/entry/tui/views/profiles.tsx test/entry/tui/profiles.test.tsx
git commit -m "feat(tui): r syncs the sources, i shows a rung's values and runs, t suggests stand-ins first"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 11: The weekly catalog refresh workflow (spec 1.2 §7; Ruling 20)

`.github/workflows/catalog-refresh.yml` runs `scripts/catalog-refresh.ts` weekly and on dispatch, and when `catalog/scores.json` changed, commits it with the patch changeset the script writes and opens or updates the `chore(catalog): refresh scores` PR whose body the script wrote. A test pins its shape.

**Files:**

- Create: `.github/workflows/catalog-refresh.yml`
- Test (new): `test/catalog-refresh-workflow.test.ts`

**Interfaces:**
- Consumes: Task 2's `scripts/catalog-refresh.ts` (`--body`, `--changeset`).
- Produces: nothing other tasks read.

- [ ] **Step 1: Write the failing tests**

Create `test/catalog-refresh-workflow.test.ts`:

````ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const workflow = readFileSync(join(ROOT, ".github", "workflows", "catalog-refresh.yml"), "utf8");
const script = readFileSync(join(ROOT, "scripts", "catalog-refresh.ts"), "utf8");

describe(".github/workflows/catalog-refresh.yml (spec 1.2 §7)", () => {
  it("runs weekly and on demand", () => {
    expect(workflow).toMatch(/schedule:\n\s+# [^\n]*\n\s+- cron: "\d+ \d+ \* \* \d"/);
    expect(workflow).toContain("workflow_dispatch:");
  });

  it("rebuilds the shipped values and bars with the refresh script, never with an AA key", () => {
    expect(workflow).toContain(
      'bun scripts/catalog-refresh.ts --body "$RUNNER_TEMP/body.md" --changeset .changeset/catalog-refresh.md',
    );
    expect(workflow).not.toContain("ARTIFICIAL_ANALYSIS_API_KEY");
    expect(script).toContain("delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;");
    // a throwaway data folder: the refresh never reads or writes a user's cache
    expect(script).toContain("process.env.CATHERD_HOME = home;");
  });

  it("opens or updates one PR, chore(catalog): refresh scores, with a patch changeset, only on a change", () => {
    expect(workflow).toContain("if: steps.refresh.outputs.changed == 'true'");
    expect(workflow.match(/--title "chore\(catalog\): refresh scores"/g)).toHaveLength(2);
    expect(workflow).toContain('git commit -m "chore(catalog): refresh scores"');
    expect(workflow).toContain('--body-file "$RUNNER_TEMP/body.md"');
    expect(script).toContain('"catherd-cli": patch');
  });
});
````

- [ ] **Step 2: Run them to see them fail**

Run: `bun test test/catalog-refresh-workflow.test.ts`
Expected: FAIL — `ENOENT` reading the workflow.

- [ ] **Step 3: Implement**

Create `.github/workflows/catalog-refresh.yml`:

````yaml
name: Catalog refresh

# Spec 1.2 §7: weekly, rebuild the shipped scores and default bars from the keyless public sources (never
# Artificial Analysis) and open or update the "chore(catalog): refresh scores" PR with a patch changeset.
# Merging it releases a patch through the Release workflow.
on:
  schedule:
    # Mondays 06:17 UTC
    - cron: "17 6 * * 1"
  workflow_dispatch:

concurrency: ${{ github.workflow }}

permissions:
  contents: write
  pull-requests: write

jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          # a push by GITHUB_TOKEN triggers no workflow: the PR gets CI only through RELEASE_TOKEN, as the
          # release PR does
          token: ${{ secrets.RELEASE_TOKEN || secrets.GITHUB_TOKEN }}
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - name: Rebuild the shipped scores and bars from the keyless sources
        id: refresh
        run: |
          bun scripts/catalog-refresh.ts --body "$RUNNER_TEMP/body.md" --changeset .changeset/catalog-refresh.md
          if git diff --quiet -- catalog/scores.json; then
            echo "changed=false" >> "$GITHUB_OUTPUT"
          else
            echo "changed=true" >> "$GITHUB_OUTPUT"
          fi
      - name: Open or update the refresh PR
        if: steps.refresh.outputs.changed == 'true'
        env:
          GH_TOKEN: ${{ secrets.RELEASE_TOKEN || secrets.GITHUB_TOKEN }}
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git switch -C catalog-refresh
          git add catalog/scores.json .changeset/catalog-refresh.md
          git commit -m "chore(catalog): refresh scores"
          git push --force origin catalog-refresh
          if [ "$(gh pr view catalog-refresh --json state -q .state 2>/dev/null)" = "OPEN" ]; then
            gh pr edit catalog-refresh --title "chore(catalog): refresh scores" --body-file "$RUNNER_TEMP/body.md"
          else
            gh pr create --head catalog-refresh --base main --title "chore(catalog): refresh scores" \
              --body-file "$RUNNER_TEMP/body.md"
          fi
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/catalog-refresh-workflow.test.ts` then `bun run typecheck && bun run lint && bun run format:check`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/catalog-refresh.yml test/catalog-refresh-workflow.test.ts
git commit -m "ci(catalog): weekly refresh of the shipped scores, opening a patch PR when they change"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```


---

### Task 12: The 1.2.0 changeset, README, upgrading from 1.1, and the 1.2 acceptance steps (spec 1.2 §2, §11)

One minor changeset for 1.2.0 (plans 13 and 14; plan 13 added none), README's commands and a paragraph on bars, stand-ins and provenance, MIGRATION's "From 1.1 to 1.2" (with the default ladder's routing change), and `docs/dev/live-verification.md` §10: the owner's four acceptance steps with exact commands.

**Files:**

- Create: `.changeset/catherd-1-2.md`
- Modify: `MIGRATION.md`
- Modify: `README.md`
- Modify: `docs/dev/live-verification.md`

**Interfaces:**
- Consumes: every task's behaviour, as described.
- Produces: nothing.

- [ ] **Step 1: Implement**

Create `.changeset/catherd-1-2.md`:

````markdown
---
"catherd-cli": minor
---

catherd 1.2: scores and model facts from public sources, bars that span several dimensions, and a profile that never breaks because a rung lacks a score. Run `catherd init` after upgrading (it asks for an optional Artificial Analysis key and syncs), then start a new Claude Code session (see MIGRATION.md, "From 1.1 to 1.2").

- **Public sources.** models.dev, OpenRouter, LiteLLM, Arena (LMArena), Vectara's hallucination leaderboard and Epoch AI, keyless, plus Artificial Analysis with your own free key (`init` asks after Jev's; `ARTIFICIAL_ANALYSIS_API_KEY` wins; it is saved in `credentials.json` and workers never see it). The MCP server syncs them in the background at session start, each at most every 12 hours; `catherd catalog sync [--force] [--unmatched]` and the `catalog_sync` tool (26 MCP tools) sync on demand. A failed source keeps its last good answer; offline, catherd routes on the scores it ships. `CATHERD_NO_SYNC=1` turns the automatic syncs off.
- **Calibration and confidence.** Each dimension has an anchor unit; other sources are fitted onto it (at least 5 shared rungs, R² ≥ 0.5). A value's confidence is `verified`, `measured`, `calibrated`, `adjacent` (the same model at another effort), `secondary` or `inferred`; the override still wins, then the better level, then the newer date, and a value older than 90 days drops a level.
- **New dimensions and bars.** `agentic`, `steer` and `frontend` join `repo_code`, `terminal` and `honesty`. The default bars span several dimensions per kind and difficulty (a `terminal` lane gates on Terminal-Bench, a `ui` lane on WebDev), at the 25th, 50th, 60th and 75th percentiles of the rungs measured or better, each with its `barsWhy` in `scores.json`. Your override's `bars` now override per dimension; `null` removes a threshold.
- **Unscored is a warning.** A rung with no value on a dimension the bars use takes its nearest stand-in's (ranked on price, context, release date, vendor, family, effort and its own values; Artificial Analysis's features with a key) as `inferred`, and `profile validate` and `doctor` list it as a "stand-in to confirm". The error "unscored rung without a treat-like" is gone. A save that fixes one of a profile's errors and adds none now goes through (`profile set`, `profile_set`, the dashboard's save), listing the errors still open.
- **treat-like.** `catherd catalog treat-like --suggest <rung>` ranks the three nearest stand-ins; `--clear <rung>` and `--reset` remove your mappings, naming first the profile rungs left on an inferred stand-in.
- **Why a rung.** `route` reports each threshold of the lane's bar, the value used, its confidence and source (inferred values marked), the rung's speed and cost facts, and catherd's own run evidence ("12 lanes, 2 climbed, 1 partial"), which never changes routing; `catalog_query` and `catalog list` show the same. In the dashboard, `r` in Profiles syncs and shows each source's age and last error, `i` shows a rung's values and runs, and `t` opens the treat-like picker with the three nearest stand-ins first.
- **Shipped scores.** `catalog/scores.json` carries the keyless sources' values with their source, date and confidence (never Artificial Analysis's), attributed in `catalog/ATTRIBUTION.md`; a weekly workflow refreshes them in a `chore(catalog): refresh scores` PR.
````

Edit `MIGRATION.md` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/MIGRATION.md b/MIGRATION.md
index fa93c54..6f7235b 100644
--- a/MIGRATION.md
+++ b/MIGRATION.md
@@ -1,8 +1,69 @@
 # Upgrading catherd
 
+- [From 1.1 to 1.2](#from-11-to-12)
 - [From 1.0 to 1.1](#from-10-to-11)
 - [From 0.x to 1.0](#from-0x-to-10)
 
+## From 1.1 to 1.2
+
+1.2 reads 1.1's profiles, runs, credentials and catalog override as they are. Upgrade the same way as to 1.1, then
+start a new Claude Code session:
+
+```sh
+bun add -g catherd-cli@latest && catherd init
+claude plugin marketplace update catherd && claude plugin update catherd@catherd
+```
+
+`init` asks for an optional [Artificial Analysis](https://artificialanalysis.ai) key after Jev's (Enter skips; it
+is tested, then saved in `credentials.json`) and syncs the public sources. Without a key, routing uses the keyless
+sources and the scores catherd ships.
+
+### Routing reads new bars
+
+The default bars now span several dimensions per kind: `repo_code` lanes gate on DeepSWE, `terminal` lanes on
+Terminal-Bench, `ui` lanes on WebDev and DeepSWE, and logic and hard lanes also on honesty and Arena's agentic
+score. Their thresholds are the 25th, 50th, 60th and 75th percentiles of the rungs measured or better (each
+threshold's reason is in `catalog/scores.json`'s `barsWhy`). On the default worker ladder (Luna high, Sol medium,
+high, xhigh) this means:
+
+- copy and build lanes start on Luna high (its DeepSWE value carried from Luna max), `terminal` lanes on Sol
+  medium, and `ui` build lanes on Sol xhigh;
+- no Sol rung reaches a logic or hard bar (Sol's agentic score is just below the 60th percentile), so those lanes
+  start at the default rung, Sol medium, as they did in 1.1.
+
+A `bars` entry in `catalog.override.json` now changes only the dimensions it names; the default's other
+thresholds stay. Write `null` for a dimension to remove its threshold.
+
+### Unscored rungs never make a profile invalid
+
+- "`<rung>` is unscored" and "stand-in `<rung>` is unscored" are warnings now. A rung that lacks a value on a
+  dimension the bars use takes its nearest stand-in's, marked `inferred`, and `profile validate` and `doctor` list
+  it as a "stand-in to confirm".
+- A save that fixes one of a profile's errors and adds none goes through, and lists the errors still open. Before
+  1.2, a profile with two errors could not be repaired one `profile set` at a time.
+- Your treat-likes keep working. `catherd catalog treat-like --suggest <rung>` shows the three nearest stand-ins,
+  `--clear <rung>` removes one of yours and `--reset` all of them; each first names the profile rungs it leaves on
+  an inferred stand-in.
+- `profile show` and the dashboard say which dimensions a treat-like lends (`agentic, steer borrowed from X`)
+  when the rung has values of its own.
+
+### Scores
+
+`catalog/scores.json` carries the keyless sources' values (Arena, Epoch AI) beside the hand-typed ones, each value
+spread to its model's other efforts as `adjacent` where no effort has its own. The shipped treat-likes for Opus
+5.5 low, medium and high are gone (those efforts carry xhigh's and max's values now); GPT-6 Luna borrows agentic
+and steer from GPT-5.6 Luna at the same effort until Arena scores it.
+
+### Where to look
+
+- `route` returns `provenance`: each threshold, the value used, its confidence, source and date, the rung's speed
+  and cost facts and its run evidence. `catalog_query` and `catherd catalog list` show values' sources and each
+  rung's run evidence.
+- In the dashboard's Profiles tab, `r` syncs the sources (and lists the backends' models) and shows each source's
+  age and last error, `i` shows a rung's values and runs, and `t` opens the treat-like picker with the three
+  nearest stand-ins first.
+- MCP: 26 tools (`catalog_sync` added).
+
 ## From 1.0 to 1.1
 
 1.1 reads 1.0's profiles, runs and settings as they are; nothing is moved or converted. Upgrade with 1.1's own
````

Edit `README.md` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/README.md b/README.md
index e212f14..02abebe 100644
--- a/README.md
+++ b/README.md
@@ -91,6 +91,7 @@ In a terminal:
 | `catherd catalog refresh\|list [--backend <b>] [--role <r>] [--text <t>] [--scored]`      | The models catherd can place, filtered                                                              |
 | `catherd catalog sync [--force] [--unmatched]`                                            | Fetches the public model facts and scores now (below); `--unmatched` lists ids no model matched     |
 | `catherd catalog treat-like <rung> <like>`                                                | Scores an unscored rung as a scored one                                                             |
+| `catherd catalog treat-like --suggest <rung>\|--clear <rung>\|--reset`                    | The three nearest stand-ins for a rung; removes one or every mapping of yours                       |
 | `catherd lock [--slots N] -- <cmd>`                                                       | Runs a heavy command behind the machine-wide semaphore, in its own session (no /dev/tty)            |
 | `catherd mcp`                                                                             | The MCP server on stdio; the plugin starts it, you never need to                                    |
 | `catherd capture-fixtures [--backend <b>] [--out <dir>]`                                  | Contributors: records sanitized test fixtures from real runs (see CONTRIBUTING.md)                  |
@@ -107,7 +108,19 @@ hallucination leaderboard and Epoch AI, plus Artificial Analysis when you give `
 server syncs them in the background when a Claude Code session starts (each source at most every 12 hours, never
 delaying the session), `init` syncs them, and `catherd catalog sync` (or the `catalog_sync` tool) does it on demand.
 Each answer is kept in `~/.local/share/catherd/sources/`; a source that fails keeps its last good answer, and with no
-network and no sync at all catherd routes on the scores it ships.
+network and no sync at all catherd routes on the scores it ships. Those are the keyless sources' values, refreshed
+weekly (`catalog/ATTRIBUTION.md` credits each source); Artificial Analysis values are read with your key only and
+never shipped.
+
+A lane's kind and difficulty pick a bar: a threshold on each dimension it spans (`repo_code`, `terminal`,
+`honesty`, `agentic`, `frontend`; `steer` is shown but has no default bar), and the lane starts on the cheapest
+rung that clears them all. A rung with no value on a dimension takes its nearest stand-in's as `inferred`, and
+`profile validate` and `doctor` list it as a "stand-in to confirm": confirm or replace it with `catherd catalog
+treat-like --suggest <rung>`, then `treat-like <rung> <like>`. `route` says, for the rung it picks, each threshold,
+the value used, its confidence and source, and catherd's own runs on it ("12 lanes, 2 climbed, 1 partial"), which
+it shows but never routes on. A bar of your own goes in `~/.config/catherd/catalog.override.json`, per dimension
+(`"bars": { "ui": { "hard": { "frontend": 1700, "honesty": null } } }`: a number sets a threshold, `null` removes
+the default's).
 
 Run data lives in `~/.local/share/catherd/`, config in `~/.config/catherd/` (both follow
 `XDG_*`).
````

Edit `docs/dev/live-verification.md` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/docs/dev/live-verification.md b/docs/dev/live-verification.md
index 063ca93..62ae2e3 100644
--- a/docs/dev/live-verification.md
+++ b/docs/dev/live-verification.md
@@ -2,7 +2,8 @@
 
 What CI cannot check, because it needs real accounts: the backends' real streams, the Codex sandbox, and
 the Jev key prompt on a real terminal (spec D7, §11.7, §11.8); since 1.1 also the push notices, the worker
-access probes and the release acceptance runs (spec 1.1 §15, sections 7 to 9). Run it on your own machine before a
+access probes and the release acceptance runs (spec 1.1 §15, sections 7 to 9); since 1.2 its acceptance (spec 1.2
+§11, section 10). Run it on your own machine before a
 release, and again after a backend CLI's minor release. Every step says what to look for; write down
 anything that differs and file it with the step's name.
 
@@ -396,3 +397,72 @@ jq -r 'select(.role == "verifier") | "\(.name) \(.status) \((.secs // 0) / 60 |
 Write down: the total minutes, the verifier's minutes and how many gate items it carried over (`carried over
 from <commit>` in its verdict), how many worker replies were `partial` or `blocked`, how many test commands the
 main thread ran itself (MR A: 156), and whether any notice was missing or doubled.
+
+## 10. The 1.2 acceptance (the release PR waits for it)
+
+Spec 1.2 §11. Install the release candidate from `changeset-release/main` and the plugin from the same checkout
+exactly as in section 9 (its "The CLI" and "The plugin" blocks), then run these four in order. Keep your real
+config: the commands below save and restore what they change.
+
+**1. A fresh `init`, with and without an Artificial Analysis key; `doctor` shows every source fresh.**
+
+```sh
+export CATHERD_HOME="$(mktemp -d)"             # a fresh install, apart from your own
+ARTIFICIAL_ANALYSIS_API_KEY= catherd init --no-input --no-global
+catherd doctor --json | jq -r '.checks[] | select(.id == "sources") | "\(.state) \(.word): \(.detail)"'
+```
+
+Look for `ok fresh:` and every keyless source (`models-dev`, `openrouter-models`, `openrouter-endpoints`,
+`litellm`, `arena`, `vectara`, `epoch`) under an hour old, and `no Artificial Analysis key`. Then with your key:
+
+```sh
+export CATHERD_HOME="$(mktemp -d)"
+ARTIFICIAL_ANALYSIS_API_KEY=<your key> catherd init --no-input --no-global
+catherd doctor --json | jq -r '.checks[] | select(.id == "sources") | .detail'
+ls -l "$CATHERD_HOME/config/credentials.json"   # -rw------- ; the key was tested before it was saved
+unset CATHERD_HOME
+```
+
+Look for `artificial-analysis` among the fresh sources and `Artificial Analysis key set, <n> requests left today`.
+
+**2. Clearing every treat-like of yours leaves the profile valid, with warnings.**
+
+```sh
+cp ~/.config/catherd/catalog.override.json /tmp/override.before.json 2>/dev/null
+catherd catalog treat-like --reset
+catherd profile validate; echo "exit $?"
+```
+
+Look for: `--reset` names, before its `removed` line, each profile rung left on an inferred stand-in (none is
+fine when you had no treat-likes); `validate` prints no `✗` line, exits 0, and lists each such rung as `stand-in
+to confirm: …`. Put yours back with `cp /tmp/override.before.json ~/.config/catherd/catalog.override.json`.
+
+**3. A `terminal` lane and a `ui` lane pick by the terminal and frontend bars, and say each value's source.**
+
+In a scratch repository, start a run and route two lanes through the MCP tools from a Claude Code session:
+
+```sh
+scratch="$(mktemp -d)/bars" && mkdir -p "$scratch" && cd "$scratch" && git init -q && git commit -q --allow-empty -m init
+claude -p --output-format json \
+  "/catherd:catherd Start a run titled bars. Write lanes/M1.L1.md with 'Kind: terminal' and 'Difficulty: copy', and lanes/M1.L2.md with 'Kind: ui' and 'Difficulty: build' (each: Owns: a.txt, Fast check: true), then call route for each and print both answers' rung and provenance.thresholds as JSON. Do not dispatch." \
+  | jq -r .result
+```
+
+Look for: the terminal lane's thresholds list only `terminal` (its value's `source` `shipped`, Terminal-Bench
+4.0), the ui lane's `repo_code` and `frontend` (`frontend`'s source `arena`), each with `min`, `used.value`,
+`used.confidence` and `clears`; and the two lanes on different rungs (on the default profile: Sol medium and Sol
+xhigh).
+
+**4. The first weekly refresh PR opens with a readable change list.**
+
+```sh
+gh workflow run catalog-refresh.yml --repo 47vigen/catherd
+sleep 60; gh run list --workflow catalog-refresh.yml --repo 47vigen/catherd --limit 1
+gh pr view catalog-refresh --repo 47vigen/catherd
+```
+
+Look for: the run succeeds; when anything changed, one PR titled `chore(catalog): refresh scores` with a patch
+changeset, whose body lists the rungs newly scored, the values moved by more than 5 % and every bar that moved
+(each as a table), and no Artificial Analysis value; when nothing changed, the run's log ends with `no change`
+and no PR opens.
+
````

- [ ] **Step 2: Run the checks**

Run: `bun run format:check && bun test test/entry/help-text.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add .changeset/catherd-1-2.md MIGRATION.md README.md docs/dev/live-verification.md
git commit -m "docs: catherd 1.2 changeset, README, upgrading from 1.1, and the 1.2 acceptance steps"
git log --oneline -1   # a failed hook leaves the changes uncommitted
```



---

## Self-review (plan writer)

- Spec coverage: §5.1 table (Task 1), §5.2 values and `barsWhy` (1, 2, 3), §5.3 provenance (8), §6.1 warning and stand-in (4, 5), §6.2 repair (5), §6.3 ranking (4), §6.4 treat-like (6, 10), §7 shipped scores, ATTRIBUTION, workflow (2, 3, 11), §8 evidence (7, 8, 10), §9 doctor, TUI, MCP, CLI (5, 6, 8, 9, 10), §10 files (all), §11 tests owned here: stand-in ranking on the fixture data (4), profile repair both ways (5), precedence display (8); acceptance steps (12).
- Placeholders: none; every code step carries the scratch build's code or diff.
- Names checked across tasks: `withStandIns`, `scoresOf(...).inferred/standIns`, `standInsToConfirm`, `repairs`, `valuesUsed`, `provenanceOf`, `runEvidence`, `evidenceOf`, `evidenceLine`, `suggestStandIns`, `removeTreatLikes`, `canonicalRung`.

## After the plan

The controller copies the ledger to `docs/handoff/plan14-ledger.md`, updates `HANDOFF.md`, and after the PR merges holds "chore: release catherd" (1.2.0) for the owner's acceptance (`docs/dev/live-verification.md` §10). Follow-ups for `docs/dev/ideas.md` ("1.2 follow-ups"): adjacent values overstate lower efforts (a per-effort discount, or carrying only upward, once sources score low efforts); the logic and hard bars sit above every Sol rung on the default ladder (the owner's call: percentiles as specced, or a ladder with a stronger top rung); Haiku 4.5's terminal value returns when Epoch's Terminal-Bench covers five anchor rungs; the AA fixtures are still synthetic (plan 13).
