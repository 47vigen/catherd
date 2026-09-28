# catherd 1.2, plan 13: sources and sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** catherd reads model facts and scores from public sources: one fetcher and parser per source (models.dev, OpenRouter models and endpoints, LiteLLM, Arena, Vectara, Epoch AI, Artificial Analysis), a 12 h cache with a lock and a background sync at MCP server boot, id and effort mapping, calibration onto each dimension's anchor, six confidence levels with precedence, the Artificial Analysis key in `init`, `catherd catalog sync`, the `catalog_sync` tool (26 tools) and doctor's `sources` row. Routing reads what the sync derived; offline it reads the shipped values.

**Architecture:** Parsers in `src/infra/sources/<source>.ts` return `{ rung, field, value, date, url }` rows (the score sources) or typed facts (models.dev, OpenRouter, LiteLLM), on a shared request (`sourceGet`, the Jev client's retry policy via the extracted `retryingFetch`) and cache (`<data>/sources/<source>.json`, `state.json`, a sync lock). `src/services/source-derive.ts` is pure: it maps source ids onto the catalog's families, takes each dimension's anchor as `measured`, fits every other source onto it (`src/domain/calibration.ts`) as `calibrated`, spreads synced values to a family's other efforts as `adjacent`, and builds the families' facts and the cross-check warnings. `src/services/source-sync.ts` fetches what is due, caches it, writes `derived.json` and `calibration.json`, and reports what changed; `loadCatalog` layers `derived.json` between the shipped files and the user's override with the precedence of spec 1.2 §4.3.

**Tech Stack:** Bun ≥ 1.4 (`fetch`, `Bun.inflateSync`), TypeScript, zod 4, citty, `@modelcontextprotocol/sdk`. No new dependency (plan 13 R-F).

**Spec:** `docs/specs/2026-09-28-catherd-1.2-design.md` (§3, §4, §9, §10, §11), on top of the 1.1 and 1.0 specs; background and curl evidence in `docs/dev/ideas.md` ("Scores and catalog from public sources").

**Pre-validated on scratch `ee661e4..31d04e0` (worktree branch `plan13-scratch`, head `31d04e0`): 1551 pass / 0 fail / 10 skip (1561 tests, 145 files, about 4 minutes); typecheck, lint and format:check green; `bun test/pack-smoke.ts` green.** The code below is that scratch build, commit by commit, built on `main` (`ee661e4`, catherd 1.1.0 plus the 1.2 spec). Two scratch commits (`ca6a83b`, `31d04e0`) are folded into Tasks 11 and 12 here.

## Global Constraints

- Layers `domain → infra → adapters → services → entry` (`test/architecture.test.ts`): parsers and the cache in `src/infra/sources/`, mapping, calibration and merge in `src/services/source-derive.ts` with pure helpers in `src/domain/sources.ts` and `src/domain/calibration.ts` (plan 13 R-G).
- The gate: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test`. **No test reaches the network** (plan 13 R-E): every fetch is injected (`fakeFetch`, or `recordedFetch` serving `test/fixtures/sources/`), and `test/preload.ts` sets `CATHERD_NO_SYNC=1` for every test process and every process a test starts with its env (Task 11). Tests that spawn processes pass an explicit `env`; spawned `init` passes `ARTIFICIAL_ANALYSIS_API_KEY: ""` as it passes `TYPESAFE_API_KEY: ""`.
- No wall-clock sleeps for correctness: tests move an injected clock; the only real wait is the foreground sync polling for another sync's lock.
- Commits: conventional, subject ≤ 100 characters, **lower-case first word after the scope** (`feat(sources): the Arena…`, not `…: Arena…`); check `git log` after each commit (a failed hook leaves the changes uncommitted).
- Spec 1.2 §3.1: the endpoints, verbatim: `https://models.dev/api.json`; `https://openrouter.ai/api/v1/models`; `https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints`; `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`; `https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=<c>&split=latest&length=100` for `agent`, `agent_task_outcome_explicit`, `agent_bash_recovery_steps`, `agent_steerability`, `agent_tool_hallucination`, `webdev`; `https://raw.githubusercontent.com/vectara/hallucination-leaderboard/main/README.md`; `https://epoch.ai/data/benchmark_data.zip`; `https://artificialanalysis.ai/api/v2/data/llms/models` with header `x-api-key`, and on 403 or 404 `https://artificialanalysis.ai/api/v2/language/models/free?page=N`.
- Spec 1.2 §3.2–§3.3: "Background, at MCP server boot … without awaiting it"; "One TTL for every source, 12 hours"; "A lock file in `<data>/sources/`"; `--force` ignores the TTL; "Each raw answer is written atomically to `<data>/sources/<source>.json` with its fetch time. A source that fails keeps its last good file"; "A failed background sync logs at debug level".
- Spec 1.2 §3.4: "lowercase, `.` → `-` … then an alias table in `catalog/sources.json`"; "A model with no effort in its name maps to the family's default effort and the value is marked `effortAssumed: true`"; "An unmatched id is never guessed. `catherd catalog sync --unmatched` lists them."
- Spec 1.2 §3.5: models.dev fills facts; "a price that differs by more than 10 % is a sync warning. The shipped `models.json` stays the floor".
- Spec 1.2 §4.2: "at least 5 shared rungs"; "a fit with R² < 0.5 is not used"; fits in `<data>/sources/calibration.json`.
- Spec 1.2 §4.3: levels `verified, measured, calibrated, adjacent, secondary, inferred`; the override always wins; "Between two values at the same level, the newer `date` wins"; "A value older than 90 days drops one level"; values keep `benchmark`, `version`, `url`, `date` and their source; the 1.0 levels stay valid in override files.
- Spec 1.2 §9: `init` after Jev: env wins, else saved, else a prompt (Enter skips); tested with one request to `/language/models/free?page=1`, "a 200 saves it, a 401 does not, and neither stops `init`. Then `init` runs a foreground sync"; `credentials.json` `artificialAnalysisApiKey`, mode 600; `ARTIFICIAL_ANALYSIS_API_KEY` joins `SECRET_ENV`; doctor's `sources` row "each source's age and last error, the AA key presence and requests left today (`x-ratelimit-remaining`)"; "A `catalog_sync` tool (26 tools in total) returns rungs newly scored, stand-ins no longer needed, and the sources that failed"; CLI `catherd catalog sync [--force] [--unmatched]`.
- Plan scope boundary (plan 13 R-A, R-B): plan 14 owns bar values and multi-dimension default bars, unscored-as-warning, profile repair, stand-in ranking, `treat-like --suggest|--clear|--reset`, provenance in `route`/`catalog_query`, run evidence, the TUI (`r` key, picker), shipped keyless scores and `ATTRIBUTION.md`, the weekly workflow, doctor's "stand-ins to confirm" and the 1.2.0 changeset. This plan adds no changeset. **Every existing profile and the shipped defaults validate exactly as today**, before and after a sync (pinned in Task 11).

## Review Focus

1. **A laptop offline, or a source that hangs, when a Claude Code session starts.** Expected: the MCP handshake and the first tool call answer at once; routing uses the last good answers, else the shipped values. Pinned in Task 12 ("never delays the handshake or a tool call, even when every source hangs") and Task 11 ("with no network and no cache, routing reads the shipped values").
2. **Two Claude Code sessions opened together.** Expected: one sync fetches; the other's background sync does nothing and never waits. Pinned in Task 11 ("does nothing in the background while another sync holds the lock").
3. **A crash or a full disk mid-write, leaving a cache file or `derived.json` unreadable.** Expected: it reads as absent (routing on the shipped values), and the next sync writes it again. Pinned in Task 4 ("reads an unreadable cache file as none…") and Task 11 (`readDerived` on a broken file).
4. **A revoked or exhausted Artificial Analysis key.** Expected: AA fails alone with its error, the other sources go on, the background sync gives it an hour's rest (the key has 100 requests a day), and `init` never saves a refused key. Pinned in Task 8 ("fails on a 401 without trying the free path"), Task 11 ("gives a failing source an hour's rest in the background…") and Task 14 ("…keeps a refused or unchecked one out").
5. **A user's hand treat-like for a rung a sync now scores on some dimensions only** (Kimi K3 on Arena, Opus 5.5 high). Expected: the rung keeps borrowing the dimensions it still lacks, its profile stays valid, and the treat-like is never removed. Pinned in Task 1 ("lends a treat-like's values only on the dimensions a rung has none of its own"), Task 11 ("says when the user's stand-in is no longer needed, and never removes it") and Task 11 ("leave the default profile valid, with no warning, before and after a sync").

## Rulings on the spec

Controller rulings (from the brief):

- **R-A:** plan 13 adds `agentic`, `steer`, `frontend` to `DIMS` with no bars and no change to the default bars; `catalog/scores.json`'s `benchmarks` map gains the three keys (zod 4's `z.record(z.enum(DIMS), …)` is exhaustive). Plan 14 owns the rest (see Global Constraints). Every existing profile and the shipped defaults validate exactly as today.
- **R-B:** doctor's "stand-ins to confirm" is plan 14; this plan's `sources` row has ages, errors, the AA key and requests left.
- **R-C:** fixtures recorded 2026-09-28 in the sandbox, cut to the rows the tests need with real structure and values; `test/fixtures/sources/README.md` has each curl line; the two AA fixtures are **synthetic** (no key here) and marked "re-record with a key".
- **R-D:** the fixtures keep "Opus 5.5 has no repo_code or terminal value in any keyless source" (pinned in Tasks 6, 7, 10).
- **R-E:** no test reaches the network; the boot test's fetch never resolves; requests honour `HTTPS_PROXY`/`HTTP_PROXY` as the Jev client does (both use Bun's `fetch`, which reads them) with the Jev client's retry policy (`retryingFetch`, extracted from `jevRequest` unchanged).
- **R-F:** Epoch's zip is read by a 48-line central-directory reader over `Bun.inflateSync`; no dependency.
- **R-G:** the layers as in Global Constraints; credentials through the credentials module (`src/services/credentials.ts`, split out of `jev-service.ts`).
- **R-H:** OpenRouter endpoints: one request per catalog family that maps to an OpenRouter id (four on the fixture data), not per OpenRouter model.

Rulings of this plan (`what — why — cost if wrong`):

1. **Id normalization also drops a `vendor/` prefix and folds blank runs to `-`**, and a source id matches a family by the family's id or any backend's own id (`opencode-go/gpt-6-luna`, `claude-haiku-4-5-20251001`), then through the aliases. — Vectara and OpenRouter prefix vendors, Arena's agent boards use display names ("GPT 5.6 Sol"); a backend's own id is an exact match, not a guess. — Cost if wrong: a vendor-prefixed id of another family could collide (none today).
2. **A family's default effort is `catalog/sources.json` `defaultEffort`** (OpenAI families `medium`, Anthropic `high`, as OpenRouter's `reasoning.default_effort` said on 2026-09-28; Haiku `default`, its Claude Code rung having no effort); an unlisted family means `high`. — The spec names "the family's default effort" but models.json has none. — Cost if wrong: an effortless value (Vectara, Epoch `_unknown`) lands on a neighbouring effort, marked `effortAssumed`.
3. **Epoch's effort** is the word after the last `_` when it is an effort, else the row's `Reasoning effort` column (FrontierCode), else none (`_unknown`, `_32K`). — FrontierCode's `_unknown` rows name the effort in that column. — Cost if wrong: a few values on the assumed default effort instead.
4. **Arena names:** an effort is a `(Max)`/`(xHigh)`/`(High)` parenthesis or a trailing `-max`/`-xhigh`/`-high` (WebDev's ids); a `(… harness)` note is dropped; any other parenthesis stays in the name. — WebDev writes `gpt-5.6-sol-xhigh (codex-harness)`. — Cost if wrong: such a row is listed unmatched.
5. **Units:** Epoch's fractions (FrontierCode, Terminal-Bench) are read in percent like the shipped values; Terminal-Bench keeps each model's best agent; every other value stays in its source's unit (Arena's net improvement near 0.1, its WebDev rating near 1800). — Calibration maps a source onto its anchor; bars on the new dims are plan 14's. — Cost if wrong: display only, until plan 14 sets bars.
6. **Calibration pairs** are every id both sources hold (normalized id and effort), not only catalog families; the shipped anchor excludes shipped `inferred` values. — More points in the same unit; an inferred value is catherd's guess. — Cost if wrong: a fit could lean on models catherd never routes.
7. **`adjacent` spreads synced values only** (never the shipped ones), to every effort the family offers, from the nearest effort with a value (the weaker on a tie), keeping its source and fit; `default` rungs get none. — The shipped file already says which efforts it carries; spreading it would change routing with no sync. — Cost if wrong: fewer adjacent values until plan 14 regenerates the shipped file.
8. **A treat-like lends per dimension:** `scoresOf` takes a rung's own value on each dimension and the stand-in's on the rest; `via` is set only when something is borrowed; `saveTreatLike` refuses only a rung that already has every dimension the stand-in would lend; `catalog_query` marks only borrowed values `inferred`. — A sync may score a rung on agentic only (Opus 5.5 high, Kimi K3); an all-or-nothing rule would drop its borrowed repo_code and break the default Sol medium failover. Identical to 1.1 on the shipped data (no rung there has both). — Cost if wrong: labels in plan 14 must read `borrowed`.
9. **The 90-day drop and the date rule decide precedence only** (`effectiveRank`, `outranks`); a value's stored confidence is unchanged, and a stale `inferred` stays `inferred`. — Display of confidence is plan 14's; the rule is about which value wins. — Cost if wrong: plan 14 shows the stored level.
10. **Facts:** models.dev's vendor entry (`family.vendor`) gives price and capabilities; its `opencode` and `opencode-go` providers give those backends' efforts (added to the shipped ones: the floor) and context; Codex and Claude Code keep the shipped efforts and context (their CLIs differ from the APIs: Codex's `ultra`, its 272K context). Speed facts (`openrouter.<field>`, `artificial-analysis.<field>` at the family's default effort) are stored for plan 14. A sync adds no family: an id with none is unmatched. — The backend's own listing still decides what is callable. — Cost if wrong: a CLI effort models.dev knows first is picked up only through discovery.
11. **Cache layout:** one file per source: Arena's six configs in one, OpenRouter's per-id endpoints in one, Epoch's three CSV tables (not its 2 MB zip), AA as `{ path, pages, rateLimitRemaining }`; `state.json` keeps each source's `fetchedAt`, last attempt, error and AA's `x-ratelimit-remaining`; `derived.json` the synced values, facts, fits, unmatched ids and warnings; `calibration.json` the fits. Cache files are written compact (models.dev is 5 MB). — "one file per source" (spec §3.3). — Cost if wrong: layout only.
12. **A source whose last attempt failed rests an hour in the background**; the foreground and `--force` always try. An OpenRouter id that answers 404 is left out; any other endpoints failure fails that source. — AA's 100 requests a day; a failing source would otherwise be hit at every session start. — Cost if wrong: a source recovers up to an hour later.
13. **The lock:** a background sync that finds it held does nothing (`busy`); a foreground one waits up to 120 s, then re-reads the TTL. — "stops two sessions opened together from fetching twice". — Cost if wrong: a foreground sync may wait.
14. **"Newly scored"** = canonical rungs with no value of their own before the sync and at least one after; **"stand-in no longer needed"** = a user treat-like whose rung now has its own value on every dimension the stand-in lends (and did not before). Never removed. — Only then does removing it lose nothing. — Cost if wrong: reported later than a looser rule would.
15. **An AA key that cannot be checked** (no network, a 5xx) is not saved either; `init` says why and to run `init` again. Piped `init` reads a line for the AA question after Jev's (Jev, AA, profile, replace). — "a 200 saves it". — Cost if wrong: an offline `init` needs a second run.
16. **`CATHERD_NO_SYNC=1`** turns off the automatic syncs (MCP boot, `init`); `catherd catalog sync` and `catalog_sync` still run. `test/preload.ts` sets it (bunfig.toml), and `test/pack-smoke.ts` passes it. — No test may reach the network, and spawned `catherd mcp`/`init` would otherwise sync. — Cost if wrong: one env var in README.
17. **doctor's `sources` row:** `info not synced` before the first sync (routing uses the shipped scores); `warn failing` when a source's last attempt failed; `warn stale` when a keyless source is older than two TTLs (a day of sessions would have refreshed it); else `ok fresh`. AA's requests read "left today" when read today, else "left on <date>". It reads `state.json` only. — Never-synced is not a fault. — Cost if wrong: row wording.
18. **Terminal's anchor is Epoch's Terminal-Bench** (spec §4.1) while the shipped terminal values are Terminal-Bench 4.0: a shipped `verified`/`secondary` value wins by level; plan 14 regenerates the shipped values on the anchor. Today only Haiku 4.5 gets an Epoch terminal value, and no terminal bar exists. — Scope. — Cost if wrong: mixed units on terminal until plan 14.
19. **`catalog_sync` takes an optional `Deps.sync`** (tests inject one) and returns `newlyScored`, `standInsNoLongerNeeded`, `failed`, `sources`, `warnings` (and `busy` when another sync ran). — Same port pattern as the other tools. — Cost if wrong: none.
20. **`catherd catalog sync` exits 1 only when a source failed and none was fetched or fresh**; `--unmatched` prints each source's unmatched ids from `derived.json`; `--json` prints the report. — Like `catalog refresh`. — Cost if wrong: exit code only.
21. **Sources are fetched with a 30 s attempt and a 60 s deadline** (models.dev, LiteLLM and Epoch are 2–5 MB) and a `catherd-cli/<version>` user agent. — "one timeout per source". — Cost if wrong: a slow link times out a big source.
22. **CSV is read by a 30-line RFC 4180 parser** (quoted commas, `""`, line breaks in a field). — Epoch's notes hold line breaks; no dependency. — Cost if wrong: none known.

## Assumes

- `main` at `ee661e4` (1.1.0 released; plan 12 merged). No other plan runs between.
- Spec 1.2 §11 "Stand-in ranking on the 2026-09-27 fixture data" is plan 14's test; this plan's fixtures keep the property it needs (R-D).
- The executor re-checks the diff anchors if `main` moved: Tasks 1, 9, 11, 12, 13, 14 edit existing files by diff; every hunk is re-found by its context.

## Verified facts (scratch build, 2026-09-28)

- Every keyless source answered in the sandbox on 2026-09-28; both AA paths answer 401 without a key. OpenRouter's endpoints report `latency_last_30m` and `throughput_last_30m` as null to an anonymous caller (the fixture keeps the nulls; a synthetic answer in Task 5's test covers numbers).
- Bun's `fetch` reads the proxy env vars; this sandbox sets lowercase `https_proxy`, which wins over `HTTPS_PROXY`, so a test cannot fence the network by env alone: hence injected fetches and `CATHERD_NO_SYNC`.
- Epoch's zip has 88 entries at its root (`frontiercode_external.csv`, …); FrontierCode's `_unknown` rows carry the effort in `Reasoning effort`; Terminal-Bench lists one row per agent, under two spellings for Haiku 4.5.
- On the fixtures, the keyless derive gives: agentic fits Arena task outcome (n 12, R² 0.764) and bash recovery (n 12, R² 0.661) used; frontend fits Epoch WebDev (n 10, R² 0.997) used; repo_code fits Epoch FrontierCode rejected (2 shared rungs), honesty fits Vectara (0) and Arena tool hallucination (2) rejected. With the synthetic AA fixture, AA `scicode` fits repo_code (n 5) and `livecodebench` does not (4). No keyless value for Opus 5.5 on repo_code or terminal.
- Unmatched on the fixtures: Arena `Claude Opus 5`, `Gemini 3.8 Flash`, `Kimi K3`, `claude-opus-5`, `glm-5.3`, `kimi-k3`, `muse-spark-1.3`; Vectara `antgroup/finix_s1_32b`, `google/gemini-2.5-pro`, `openai/gpt-5.5`; Epoch `claude-opus-5`, `glm-5.3`, `gpt-5.5`, `kimi-k3`.
- models.dev, OpenRouter and LiteLLM agree on every catalog family's price on 2026-09-28 (no warning on the fixtures).
- A first sync of the fixtures makes `claude-opus-5-5#high` (a shipped treat-like until then) newly scored; the default profile validates with `{ errors: [], warnings: [] }` before and after it.
- A sync of the fixtures makes 15 requests: models.dev, OpenRouter models, LiteLLM, 6 Arena configs, Vectara, Epoch, and 4 OpenRouter endpoints (`openai/gpt-6-sol`, `openai/gpt-6-luna`, `anthropic/claude-opus-5.5`, `anthropic/claude-haiku-4.5`).
- oxfmt ignores `test/fixtures/**` and `docs/**`; it reflows README tables (Task 12's README diff is its output).
- Full suite: about 4 minutes; 1551 pass / 10 skip on the scratch head.

## File Structure

| File | Task | Responsibility |
| --- | --- | --- |
| `src/domain/catalog.ts` | 1, 10 | `DIMS` + 3, `CONFIDENCE`/`RANK`, provenance fields, `effectiveRank`/`outranks`, the synced layer in `buildCatalog`, per-dimension `scoresOf`; `FamilyFactsSchema`, `applyFacts` (10) |
| `catalog/scores.json` | 1 | `benchmarks` for the three new dims |
| `src/services/catalog-service.ts` | 1, 11 | treat-like refusal per dimension, `inferred` per borrowed dim; `loadCatalog` reads `derived.json`, exports the shipped loaders (11) |
| `src/domain/sources.ts` (new), `catalog/sources.json` (new) | 2, 10 | source ids, `SourcesFileSchema`, effort words, `normalizeId`, `idMapper`, `familyEfforts`, `nearestEffort`; `DerivedSchema` (10) |
| `src/domain/calibration.ts` (new) | 3 | `DIM_SOURCES` (anchor and others per dim), `fitLine`, `calibrate` |
| `src/infra/jev-client.ts` | 4 | `retryingFetch` extracted; `jevRequest` on it |
| `src/infra/sources/http.ts`, `rows.ts`, `cache.ts` (new), `src/infra/paths.ts` | 4, 11 | `sourceGet`, `SourceError`, `rateLimitRemaining`; `SourceRow` and helpers; cache, state, lock; `derived.json`/`calibration.json` (11) |
| `src/infra/sources/models-dev.ts`, `openrouter-models.ts`, `openrouter-endpoints.ts`, `litellm.ts` (new) | 5 | the fact sources |
| `src/infra/sources/arena.ts`, `vectara.ts` (new) | 6 | Arena's six configs, Vectara's table |
| `src/infra/sources/epoch.ts`, `zip.ts`, `csv.ts` (new) | 7 | Epoch's tables, the zip and CSV readers |
| `src/infra/sources/artificial-analysis.ts` (new) | 8 | AA's two paths, the key test, the parser |
| `src/services/credentials.ts` (new), `src/services/jev-service.ts`, `src/infra/env.ts` | 9 | `credentials.json` for both keys, `aaKey`, `SECRET_ENV` |
| `src/services/source-derive.ts` (new) | 10 | mapping, anchors, calibration, `adjacent`, facts, cross-checks, OpenRouter ids |
| `src/services/source-sync.ts` (new), `bunfig.toml`, `test/preload.ts` (new) | 11 | the sync, `backgroundSync`, `sourcesStatus`; `CATHERD_NO_SYNC` in tests |
| `src/entry/catalog-command.ts`, `src/entry/mcp/setup-tools.ts`, `src/entry/mcp/server.ts`, `src/services/ports.ts`, `README.md`, `test/pack-smoke.ts` | 12 | `catalog sync`, `syncLines`, `catalog_sync`, the boot sync, docs |
| `src/services/doctor-sources.ts` (new), `src/services/doctor.ts` | 13 | the `sources` row |
| `src/entry/init-command.ts`, `README.md` | 14 | `aaStep`, `syncStep` |
| `test/fixtures/sources/*` (new) | 4–8 | the recorded (and two synthetic) answers, README |
| `test/services/source-fixtures.ts` (new) | 10 | `rawAnswers`, `recordedFetch`, `shippedContext` |

## Parallelism

| Wave | Batches (parallel worktrees) | Depends on | Why disjoint |
| --- | --- | --- | --- |
| A | {1}, {2, 4}, {9} | — | catalog domain + catalog-service + scores.json (1) vs `domain/sources.ts`, `sources.json`, `infra/sources/{http,rows,cache}.ts`, jev-client, paths, fixtures README (2, 4: 4's cache imports 2's `SourceId`) vs credentials, jev-service, env (9) |
| B | {3}, {5}, {6}, {7}, {8} | A (3 needs 1's `DIMS` and 2's `SourceId`; 5–8 need 2 and 4) | calibration.ts vs one source file set each, each with its own fixtures and test file |
| C | {10} | A, B | catalog.ts (facts), sources.ts (`DerivedSchema`), source-derive, its fixtures helper |
| D | {11} | C, 9 | source-sync, catalog-service `loadCatalog`, cache.ts derived files, bunfig, preload |
| E | {12}, {13} | D | catalog-command, MCP server and setup tools, ports, README, pack-smoke, mcp tests (12) vs doctor, doctor-sources and their tests (13) |
| F | {14} | 12 (`syncLines`), 11 | init-command, init tests, README's requirements bullet |

Shared files, each owned by one task at a time: `src/domain/catalog.ts` (1, then 10), `src/domain/sources.ts` (2, then 10), `src/infra/sources/cache.ts` and `test/infra/sources/cache.test.ts` (4, then 11), `src/services/catalog-service.ts` (1, then 11), `README.md` (12, then 14). No task edits `src/cli.ts` (`catalog sync` is a subcommand of `catalog`). The MCP tool registry (`setup-tools.ts`) and `doctor.ts` are touched by one task each. Batching for fewer agents: wave A as above; wave B as {3, 5} and {6, 7, 8}; then {10, 11}, {12, 13}, {14}.

---

### Task 1: Six confidence levels, value provenance, three new dimensions (spec 1.2 §4.3, §5.1; R-A)

`DIMS` gains `agentic`, `steer`, `frontend` with no bar; `Score.confidence` takes the six levels of spec 1.2 §4.3 (the 1.0 names kept) and optional provenance (`source`, `fit`, `effortAssumed`); `buildCatalog` layers `synced` values between the shipped file and the override by `outranks` (better level, then newer date; 90 days drops a level); `scoresOf` lends a treat-like per dimension (Ruling 8).

**Files:**
- Modify: `catalog/scores.json`
- Modify: `src/domain/catalog.ts`
- Modify: `src/services/catalog-service.ts`
- Modify: `test/domain/catalog.test.ts`
- Modify: `test/domain/shipped.ts`
- Modify: `test/services/catalog-service.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `src/domain/catalog.ts`: `DIMS` (6), `CONFIDENCE`, `type Confidence`, `RANK: Record<Confidence, number>`, `STALE_DAYS = 90`, `FitSchema`/`type Fit` (`{ source, field, a, b, r2, n }`), `ScoreSchema` (exported; optional `source`, `fit`, `effortAssumed`), `effectiveRank(s: Score, now: number): number`, `outranks(a: Score, b: Score, now: number): boolean`, `buildCatalog({ models, scores, synced?: Score[], override?, listed?, secs?, now?: number })`, `scoresOf(c, canonical)` now also returning `borrowed: Dim[]`. `test/domain/shipped.ts`'s `shipped()` accepts `synced` and `now`.

- [ ] **Step 1: Write the failing tests**

Edit `test/domain/catalog.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/domain/catalog.test.ts b/test/domain/catalog.test.ts
index 67e72a7..d921450 100644
--- a/test/domain/catalog.test.ts
+++ b/test/domain/catalog.test.ts
@@ -1,5 +1,16 @@
 import { describe, expect, it } from "bun:test";
-import { capableFor, DIMS, OverrideSchema, rungInfo, scoresOf } from "../../src/domain/catalog.ts";
+import {
+  CONFIDENCE,
+  capableFor,
+  DIMS,
+  effectiveRank,
+  OverrideSchema,
+  outranks,
+  RANK,
+  rungInfo,
+  type Score,
+  scoresOf,
+} from "../../src/domain/catalog.ts";
 import { shipped, shippedModels, shippedScores } from "./shipped.ts";
 
 describe("catalog/models.json", () => {
@@ -184,3 +195,119 @@ describe("capableFor", () => {
     expect(capableFor(c, rungInfo(c, "claude-code:claude-next-7#default"), "ui-reviewer")).toBe(true);
   });
 });
+
+describe("confidence and precedence (spec 1.2 §4.3)", () => {
+  const NOW = Date.parse("2026-09-28T12:00:00.000Z");
+  const score = (o: Partial<Score> & Pick<Score, "rung" | "dim" | "value">): Score => ({
+    benchmark: "b",
+    version: "v",
+    url: "https://example.com/s",
+    date: "2026-09-27",
+    confidence: "measured",
+    ...o,
+  });
+
+  it("orders the six levels best first, keeping the 1.0 names", () => {
+    expect([...CONFIDENCE]).toEqual([
+      "verified",
+      "measured",
+      "calibrated",
+      "adjacent",
+      "secondary",
+      "inferred",
+    ]);
+    expect(RANK.verified < RANK.secondary && RANK.secondary < RANK.inferred).toBe(true);
+  });
+
+  it("adds agentic, steer and frontend with no shipped bar on them", () => {
+    expect([...DIMS]).toEqual(["repo_code", "terminal", "honesty", "agentic", "steer", "frontend"]);
+    for (const kind of Object.values(shipped().bars))
+      for (const bar of Object.values(kind))
+        for (const d of ["agentic", "steer", "frontend"]) expect(Object.keys(bar)).not.toContain(d);
+  });
+
+  it("keeps a better level, else the newer date, and drops a value older than 90 days one level", () => {
+    const old = score({ rung: "r#high", dim: "agentic", value: 1, date: "2026-06-01" });
+    const fresh = score({ rung: "r#high", dim: "agentic", value: 2, date: "2026-09-27" });
+    expect(effectiveRank(old, NOW)).toBe(RANK.calibrated);
+    expect(effectiveRank(fresh, NOW)).toBe(RANK.measured);
+    expect(outranks(fresh, old, NOW)).toBe(true);
+    const newer = score({ rung: "r#high", dim: "agentic", value: 3, date: "2026-09-28" });
+    expect(outranks(newer, fresh, NOW)).toBe(true);
+    expect(outranks(fresh, newer, NOW)).toBe(false);
+    const inferred = score({
+      rung: "r#high",
+      dim: "agentic",
+      value: 4,
+      confidence: "inferred",
+      date: "2025-01-01",
+    });
+    expect(effectiveRank(inferred, NOW)).toBe(RANK.inferred);
+  });
+
+  it("layers synced values over the shipped ones by level, and lets the override win whatever its level", () => {
+    const synced = [
+      // the shipped 65.3 is secondary: a calibrated value beats it
+      score({ rung: "gpt-6-sol#high", dim: "repo_code", value: 70, confidence: "calibrated" }),
+      // the shipped 68.8 is verified: a measured value does not
+      score({ rung: "gpt-6-sol#max", dim: "repo_code", value: 50 }),
+      score({ rung: "gpt-6-sol#max", dim: "agentic", value: 0.08 }),
+    ];
+    const c = shipped({ synced, now: NOW });
+    expect(c.scores["gpt-6-sol#high"]?.repo_code?.value).toBe(70);
+    expect(c.scores["gpt-6-sol#max"]?.repo_code?.value).toBe(68.8);
+    expect(c.scores["gpt-6-sol#max"]?.agentic?.value).toBe(0.08);
+    const override = OverrideSchema.parse({
+      scores: [
+        score({
+          rung: "gpt-6-sol#high",
+          dim: "repo_code",
+          value: 1,
+          confidence: "inferred",
+          date: "2020-01-01",
+        }),
+      ],
+    });
+    expect(shipped({ synced, override, now: NOW }).scores["gpt-6-sol#high"]?.repo_code?.value).toBe(1);
+  });
+
+  it("reads a 1.0 override's three levels, and keeps a synced value's provenance", () => {
+    for (const confidence of ["verified", "secondary", "inferred"] as const)
+      expect(
+        OverrideSchema.safeParse({
+          scores: [score({ rung: "a#high", dim: "repo_code", value: 1, confidence })],
+        }).success,
+      ).toBe(true);
+    const fit = { source: "epoch", field: "frontiercode", a: 100, b: 3, r2: 0.8, n: 6 };
+    const synced = [
+      score({
+        rung: "a#high",
+        dim: "repo_code",
+        value: 1,
+        confidence: "calibrated",
+        source: "epoch",
+        fit,
+        effortAssumed: true,
+      }),
+    ];
+    expect(shipped({ synced, now: NOW }).scores["a#high"]?.repo_code).toMatchObject({
+      source: "epoch",
+      fit,
+      effortAssumed: true,
+    });
+  });
+
+  it("ships one value per rung and dimension, so the date rule never reorders the shipped file", () => {
+    const keys = shippedScores().scores.map((s) => `${s.rung} ${s.dim}`);
+    expect(new Set(keys).size).toBe(keys.length);
+  });
+
+  it("lends a treat-like's values only on the dimensions a rung has none of its own", () => {
+    const synced = [score({ rung: "claude-opus-5-5#high", dim: "agentic", value: 0.12 })];
+    const s = scoresOf(shipped({ synced, now: NOW }), "claude-opus-5-5#high");
+    expect(s?.values).toEqual({ terminal: 66.4, agentic: 0.12 });
+    expect(s?.via).toBe("claude-opus-5-5#xhigh");
+    expect(s?.borrowed).toEqual(["terminal"]);
+    expect(scoresOf(shipped(), "gpt-6-sol#max")?.borrowed).toEqual([]);
+  });
+});
````

Edit `test/domain/shipped.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/domain/shipped.ts b/test/domain/shipped.ts
index 535df22..d3be83f 100644
--- a/test/domain/shipped.ts
+++ b/test/domain/shipped.ts
@@ -5,6 +5,7 @@ import {
   type Catalog,
   ModelsFileSchema,
   type Override,
+  type Score,
   ScoresFileSchema,
 } from "../../src/domain/catalog.ts";
 
@@ -14,9 +15,15 @@ const read = (name: string): unknown =>
 export const shippedModels = () => ModelsFileSchema.parse(read("models.json"));
 export const shippedScores = () => ScoresFileSchema.parse(read("scores.json"));
 
-/** The shipped catalog, with optional listings, override and timings layered on. */
+/** The shipped catalog, with optional synced values, listings, override and timings layered on. */
 export function shipped(
-  o: { listed?: Catalog["listed"]; override?: Override; secs?: Catalog["secs"] } = {},
+  o: {
+    listed?: Catalog["listed"];
+    override?: Override;
+    secs?: Catalog["secs"];
+    synced?: Score[];
+    now?: number;
+  } = {},
 ): Catalog {
   return buildCatalog({ models: shippedModels(), scores: shippedScores(), ...o });
 }
````

Edit `test/services/catalog-service.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/catalog-service.test.ts b/test/services/catalog-service.test.ts
index 6c9b0cc..f914dc3 100644
--- a/test/services/catalog-service.test.ts
+++ b/test/services/catalog-service.test.ts
@@ -120,6 +120,31 @@ describe("loadCatalog", () => {
     );
   });
 
+  it("takes a treat-like for a rung scored on only some of the dimensions it would borrow", async () => {
+    withHome();
+    mkdirSync(dirname(overridePath()), { recursive: true });
+    const agentic = {
+      rung: "claude-sonnet-5#high",
+      dim: "agentic",
+      value: 0.05,
+      benchmark: "Arena agent, net improvement",
+      version: "2026-09-27",
+      url: "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset",
+      date: "2026-09-27",
+      confidence: "measured",
+    };
+    writeFileSync(overridePath(), JSON.stringify({ schema: 1, scores: [agentic] }));
+    expect(await saveTreatLike("claude-sonnet-5#high", "gpt-6-sol#high")).toEqual({
+      rung: "claude-sonnet-5#high",
+      like: "gpt-6-sol#high",
+    });
+    const row = q({ backend: "claude-code", text: "sonnet" }).models[0]?.rungs.find(
+      (r) => r.rung === "claude-code:claude-sonnet-5#high",
+    );
+    expect(row?.scores.agentic?.confidence).toBe("measured");
+    expect(row?.scores.repo_code?.confidence).toBe("inferred");
+  });
+
   it("turns a corrupt override into E_CONFIG_INVALID with a fix", () => {
     withHome();
     mkdirSync(dirname(overridePath()), { recursive: true });
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/domain/catalog.test.ts test/services/catalog-service.test.ts`
Expected: FAIL: `CONFIDENCE`, `effectiveRank`, `outranks` are not exported by `src/domain/catalog.ts` (and `shipped()` rejects `synced`).

- [ ] **Step 3: Implement**

Edit `catalog/scores.json` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/catalog/scores.json b/catalog/scores.json
index 5ef2480..7980b0a 100644
--- a/catalog/scores.json
+++ b/catalog/scores.json
@@ -7,7 +7,10 @@
     "honesty": {
       "benchmark": "OpenAI Broken Search Tool, 100 minus the failure rate",
       "version": "GPT-6 system card appendix 11.6.4.2"
-    }
+    },
+    "agentic": { "benchmark": "Arena agent, net improvement", "version": "lmarena-ai/leaderboard-dataset" },
+    "steer": { "benchmark": "Arena agent steerability", "version": "lmarena-ai/leaderboard-dataset" },
+    "frontend": { "benchmark": "Arena WebDev rating", "version": "lmarena-ai/leaderboard-dataset" }
   },
   "scores": [
     {
````

Edit `src/domain/catalog.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/catalog.ts b/src/domain/catalog.ts
index dde1e23..1c134d9 100644
--- a/src/domain/catalog.ts
+++ b/src/domain/catalog.ts
@@ -3,10 +3,31 @@ import { type Rung, parseRung } from "./ids.ts";
 import { DIFFICULTIES, type Difficulty, KINDS, type Kind } from "./lane.ts";
 import type { Role } from "./roles.ts";
 
-/** Spec §5.2: the scored dimensions, each on one named benchmark. */
-export const DIMS = ["repo_code", "terminal", "honesty"] as const;
+/**
+ * Spec §5.2 and 1.2 §5.1: the scored dimensions, each in its anchor's unit. `agentic`, `steer` and `frontend`
+ * (1.2) carry no shipped bar yet.
+ */
+export const DIMS = ["repo_code", "terminal", "honesty", "agentic", "steer", "frontend"] as const;
 export type Dim = (typeof DIMS)[number];
 
+/**
+ * Spec 1.2 §4.3: how a value was obtained, best first. The 1.0 levels (`verified`, `secondary`,
+ * `inferred`) keep their names, so an older override file stays valid.
+ */
+export const CONFIDENCE = [
+  "verified",
+  "measured",
+  "calibrated",
+  "adjacent",
+  "secondary",
+  "inferred",
+] as const;
+export type Confidence = (typeof CONFIDENCE)[number];
+export const RANK = Object.fromEntries(CONFIDENCE.map((c, i) => [c, i])) as Record<Confidence, number>;
+/** Spec 1.2 §4.3: a value older than this many days counts one level lower. */
+export const STALE_DAYS = 90;
+const DAY_MS = 86_400_000;
+
 /**
  * Spec §7.1 `billing` keys: a rung's backend, except that opencode's Go models (`opencode-go/…`) are billed
  * apart from its Zen models (`opencode/…`).
@@ -72,7 +93,18 @@ export type ModelsFile = z.infer<typeof ModelsFileSchema>;
 /** A canonical rung: `<canonical model id>#<effort>`, the key scores and treat-likes use. */
 export const CanonicalRung = z.string().regex(/^[^:#\s]+#[^#\s]+$/, "a canonical rung is model#effort");
 
-const ScoreSchema = z.object({
+/** Spec 1.2 §4.2: `anchor = a·x + b`, fitted on `n` rungs both sources cover, with its R². */
+export const FitSchema = z.object({
+  source: z.string(),
+  field: z.string(),
+  a: z.number(),
+  b: z.number(),
+  r2: z.number(),
+  n: z.number().int(),
+});
+export type Fit = z.infer<typeof FitSchema>;
+
+export const ScoreSchema = z.object({
   rung: CanonicalRung,
   dim: z.enum(DIMS),
   value: z.number(),
@@ -80,8 +112,14 @@ const ScoreSchema = z.object({
   version: z.string(),
   url: z.url(),
   date: z.iso.date(),
-  confidence: z.enum(["verified", "secondary", "inferred"]),
+  confidence: z.enum(CONFIDENCE),
   note: z.string().optional(),
+  /** spec 1.2 §4.3: the source a synced value came from (absent: the shipped file or the user's override) */
+  source: z.string().optional(),
+  /** a calibrated value: the fit that mapped it onto the anchor */
+  fit: FitSchema.optional(),
+  /** the source named no effort, so the family's default effort was assumed (spec 1.2 §3.4) */
+  effortAssumed: z.boolean().optional(),
 });
 export type Score = z.infer<typeof ScoreSchema>;
 
@@ -130,22 +168,42 @@ export interface Catalog {
   secs: Record<string, number>;
 }
 
-const RANK: Record<Score["confidence"], number> = { verified: 0, secondary: 1, inferred: 2 };
+/** Spec 1.2 §4.3: the level a value counts at: its own, one lower once it is older than STALE_DAYS. */
+export function effectiveRank(s: Score, now: number): number {
+  const stale = now - Date.parse(s.date) > STALE_DAYS * DAY_MS;
+  return Math.min(RANK[s.confidence] + (stale ? 1 : 0), CONFIDENCE.length - 1);
+}
+
+/** Spec 1.2 §4.3: `a` beats `b` at a better level, or at the same level with a newer date. */
+export function outranks(a: Score, b: Score, now: number): boolean {
+  const ra = effectiveRank(a, now);
+  const rb = effectiveRank(b, now);
+  return ra < rb || (ra === rb && a.date > b.date);
+}
 
+/**
+ * The catalog routing reads: the shipped files, the synced values (spec 1.2 §3), each backend's listing and
+ * the user's override, which always wins. Between shipped and synced values the better level wins, then the
+ * newer date (spec 1.2 §4.3); `now` dates the 90-day drop.
+ */
 export function buildCatalog(o: {
   models: ModelsFile;
   scores: ScoresFile;
+  synced?: Score[];
   override?: Override;
   listed?: Catalog["listed"];
   secs?: Catalog["secs"];
+  now?: number;
 }): Catalog {
+  const now = o.now ?? Date.now();
   const scores: Catalog["scores"] = {};
   const put = (s: Score, force: boolean) => {
     const cur = (scores[s.rung] ??= {});
     const had = cur[s.dim];
-    if (force || !had || RANK[s.confidence] < RANK[had.confidence]) cur[s.dim] = s;
+    if (force || !had || outranks(s, had, now)) cur[s.dim] = s;
   };
   for (const s of o.scores.scores) put(s, false);
+  for (const s of o.synced ?? []) put(s, false);
   for (const s of o.override?.scores ?? []) put(s, true);
   const treatLike: Catalog["treatLike"] = {};
   for (const [rung, t] of Object.entries(o.scores.treatLike))
@@ -211,18 +269,35 @@ export function rungInfo(c: Catalog, rung: string): RungInfo {
   };
 }
 
-/** The rung's scores: its own, else those of the rung it is treated like. null when unscored. */
+/**
+ * The rung's scores: per dimension its own value, else that of the rung it is treated like (a sync may score
+ * a rung on some dimensions only). `via` names that rung when it lends any value, `borrowed` the dimensions
+ * it lends. null when unscored.
+ */
 export function scoresOf(
   c: Catalog,
   canonical: string,
-): { values: Partial<Record<Dim, number>>; records: Partial<Record<Dim, Score>>; via: string | null } | null {
-  const own = c.scores[canonical];
-  const via = own ? null : (c.treatLike[canonical]?.like ?? null);
-  const records = own ?? (via ? c.scores[via] : undefined);
-  if (!records || Object.keys(records).length === 0) return null;
+): {
+  values: Partial<Record<Dim, number>>;
+  records: Partial<Record<Dim, Score>>;
+  via: string | null;
+  borrowed: Dim[];
+} | null {
+  const own = c.scores[canonical] ?? {};
+  const like = c.treatLike[canonical]?.like ?? null;
+  const lent = like ? (c.scores[like] ?? {}) : {};
   const values: Partial<Record<Dim, number>> = {};
-  for (const d of DIMS) if (records[d]) values[d] = records[d].value;
-  return { values, records, via };
+  const records: Partial<Record<Dim, Score>> = {};
+  const borrowed: Dim[] = [];
+  for (const d of DIMS) {
+    const r = own[d] ?? lent[d];
+    if (!r) continue;
+    records[d] = r;
+    values[d] = r.value;
+    if (!own[d]) borrowed.push(d);
+  }
+  if (Object.keys(records).length === 0) return null;
+  return { values, records, via: borrowed.length ? like : null, borrowed };
 }
 
 /** Spec §4 roles: what a rung must offer to be placed on a role. */
````

Edit `src/services/catalog-service.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/catalog-service.ts b/src/services/catalog-service.ts
index 29756e4..9e1f23d 100644
--- a/src/services/catalog-service.ts
+++ b/src/services/catalog-service.ts
@@ -250,7 +250,9 @@ export async function saveTreatLike(rung: string, like: string): Promise<{ rung:
     throw new CatherdError("E_CONFIG_INVALID", `${rung} cannot be treated like itself`, {
       fix: "name a different, scored rung",
     });
-  if (c.scores[from])
+  // a rung a sync scored on some dimensions may still borrow the others; one with every value `to` lends may not
+  const own = c.scores[from] ?? {};
+  if (DIMS.filter((d) => c.scores[to]?.[d]).every((d) => own[d]))
     throw new CatherdError(
       "E_CONFIG_INVALID",
       `${from} has scores of its own; a treat-like would not change it`,
@@ -297,7 +299,8 @@ function rungRows(
         scored[d] = {
           value: r.value,
           benchmark: `${r.benchmark} ${r.version}`,
-          confidence: s?.via ? "inferred" : r.confidence,
+          // a value lent by a treat-like is catherd's guess for this rung, whatever its own confidence
+          confidence: s?.borrowed.includes(d) ? "inferred" : r.confidence,
         };
     }
     const like = c.treatLike[info.canonical] ?? null;
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun run format && bun test test/domain/catalog.test.ts test/services/catalog-service.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS (48 tests, 0 fail).

- [ ] **Step 5: Commit**

````bash
git add catalog/scores.json src/domain/catalog.ts src/services/catalog-service.ts test/domain/catalog.test.ts test/domain/shipped.ts test/services/catalog-service.test.ts
git commit -m "feat(catalog): six confidence levels, value provenance and three new dimensions"
````

---

### Task 2: Source ids, effort mapping and `catalog/sources.json` (spec 1.2 §3.4; Rulings 1, 2)

The pure id and effort rules and the shipped table of sources (with license and attribution line), aliases and default efforts.

**Files:**
- Create: `catalog/sources.json`
- Create: `src/domain/sources.ts`
- Create: `test/domain/sources.test.ts`

**Interfaces:**
- Consumes: `type Family` (catalog.ts).
- Produces: `src/domain/sources.ts`: `SOURCE_IDS` (the 8 ids), `type SourceId`, `SourcesFileSchema`/`type SourcesFile` (`{ schema, version, sources[{ id, name, url, license, attribution, keyed }], aliases, defaultEffort }`), `EFFORT_ORDER`, `effortWord(s): string | null`, `normalizeId(id): string`, `splitSourceRung(rung): { id, effort: string | null }`, `interface IdMapper { key(id): string; family(id): Family | null }`, `idMapper(families, aliases): IdMapper`, `defaultEffortOf(sources, family): string`, `familyEfforts(f): string[]`, `nearestEffort(target, have): string | null`.

- [ ] **Step 1: Write the failing tests**

Create `test/domain/sources.test.ts`:

````ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultEffortOf,
  effortWord,
  familyEfforts,
  idMapper,
  nearestEffort,
  normalizeId,
  SOURCE_IDS,
  SourcesFileSchema,
  splitSourceRung,
} from "../../src/domain/sources.ts";
import { shippedModels } from "./shipped.ts";

const sourcesFile = () =>
  SourcesFileSchema.parse(
    JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "catalog", "sources.json"), "utf8")),
  );

describe("catalog/sources.json (spec 1.2 §3.1, §3.4)", () => {
  it("lists every source once, with its license and attribution line; only Artificial Analysis needs a key", () => {
    const f = sourcesFile();
    expect(f.sources.map((s) => s.id)).toEqual([...SOURCE_IDS]);
    for (const s of f.sources) {
      expect(s.license.length).toBeGreaterThan(0);
      expect(s.attribution.length).toBeGreaterThan(0);
    }
    expect(f.sources.filter((s) => s.keyed).map((s) => s.id)).toEqual(["artificial-analysis"]);
  });

  it("names a default effort for every shipped family", () => {
    const f = sourcesFile();
    for (const fam of shippedModels().families) expect(f.defaultEffort[fam.id]).toBeDefined();
    const haiku = shippedModels().families.find((x) => x.id === "claude-haiku-4-5");
    expect(haiku && defaultEffortOf(f, haiku)).toBe("default");
    expect(haiku && defaultEffortOf({ ...f, defaultEffort: {} }, haiku)).toBe("high");
  });
});

describe("id and effort mapping (spec 1.2 §3.4)", () => {
  it("lowercases, drops a vendor prefix and writes dots and blanks as dashes", () => {
    expect(normalizeId("gpt-5.6-sol")).toBe("gpt-5-6-sol");
    expect(normalizeId("openai/gpt-6-sol")).toBe("gpt-6-sol");
    expect(normalizeId("GPT 5.6 Sol")).toBe("gpt-5-6-sol");
    expect(normalizeId("anthropic/claude-opus-5.5")).toBe("claude-opus-5-5");
    expect(normalizeId("Claude Opus 5.5")).toBe("claude-opus-5-5");
  });

  it("reads an effort word in any case, and nothing else", () => {
    expect(effortWord("xHigh")).toBe("xhigh");
    expect(effortWord("MAX")).toBe("max");
    expect(effortWord("unknown")).toBeNull();
    expect(effortWord("32K")).toBeNull();
  });

  it("splits a parser's rung into its id and effort", () => {
    expect(splitSourceRung("gpt-6-sol#max")).toEqual({ id: "gpt-6-sol", effort: "max" });
    expect(splitSourceRung("openai/gpt-6-sol")).toEqual({ id: "openai/gpt-6-sol", effort: null });
  });

  it("maps source ids onto families directly, by a backend's own id and through the alias table", () => {
    const m = idMapper(shippedModels().families, sourcesFile().aliases);
    const fam = (id: string) => m.family(id)?.id ?? null;
    expect(fam("GPT 5.6 Sol")).toBe("gpt-5.6-sol");
    expect(fam("openai/gpt-6-sol")).toBe("gpt-6-sol");
    expect(fam("anthropic/claude-opus-5.5")).toBe("claude-opus-5-5");
    expect(fam("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(fam("claude-4-5-haiku")).toBe("claude-haiku-4-5");
    expect(fam("opencode-go/gpt-6-luna")).toBe("gpt-6-luna");
    expect(m.key("claude-4-5-haiku")).toBe("claude-haiku-4-5");
  });

  it("never guesses: an id with no family, alias or backend id maps to none", () => {
    const m = idMapper(shippedModels().families, sourcesFile().aliases);
    for (const id of [
      "gemini-3.8-flash",
      "claude-opus-5",
      "gpt-6-sol-pro",
      "openai/gpt-6-sol:batch",
      "kimi-k3",
    ])
      expect(m.family(id)).toBeNull();
  });

  it("lists a family's efforts weakest first and finds the nearest, the weaker on a tie", () => {
    const sol = shippedModels().families.find((f) => f.id === "gpt-6-sol");
    expect(sol && familyEfforts(sol)).toEqual(["none", "low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(nearestEffort("high", ["max", "medium"])).toBe("medium");
    expect(nearestEffort("xhigh", ["max", "medium"])).toBe("max");
    expect(nearestEffort("low", ["max"])).toBe("max");
    expect(nearestEffort("high", [])).toBeNull();
    expect(nearestEffort("default", ["max"])).toBeNull();
  });
});
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/domain/sources.test.ts`
Expected: FAIL: `Cannot find module "../../src/domain/sources.ts"`.

- [ ] **Step 3: Implement**

Create `catalog/sources.json`:

````json
{
  "schema": 1,
  "version": "2026-09-28",
  "sources": [
    {
      "id": "models-dev",
      "name": "models.dev",
      "url": "https://models.dev/api.json",
      "license": "MIT",
      "attribution": "Model facts from models.dev (MIT License), https://models.dev",
      "keyed": false
    },
    {
      "id": "openrouter-models",
      "name": "OpenRouter models",
      "url": "https://openrouter.ai/api/v1/models",
      "license": "public API",
      "attribution": "Model listings from the OpenRouter API, https://openrouter.ai",
      "keyed": false
    },
    {
      "id": "openrouter-endpoints",
      "name": "OpenRouter endpoints",
      "url": "https://openrouter.ai/api/v1/models",
      "license": "public API",
      "attribution": "Endpoint latency and throughput from the OpenRouter API, https://openrouter.ai",
      "keyed": false
    },
    {
      "id": "litellm",
      "name": "LiteLLM",
      "url": "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
      "license": "MIT",
      "attribution": "Prices from LiteLLM's model_prices_and_context_window.json (MIT License), https://github.com/BerriAI/litellm",
      "keyed": false
    },
    {
      "id": "arena",
      "name": "Arena (LMArena)",
      "url": "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset",
      "license": "CC-BY-4.0",
      "attribution": "Leaderboard data by LMArena, CC BY 4.0, https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset",
      "keyed": false
    },
    {
      "id": "vectara",
      "name": "Vectara hallucination leaderboard",
      "url": "https://github.com/vectara/hallucination-leaderboard",
      "license": "Apache-2.0",
      "attribution": "Hallucination Leaderboard by Vectara (Apache License 2.0), https://github.com/vectara/hallucination-leaderboard",
      "keyed": false
    },
    {
      "id": "epoch",
      "name": "Epoch AI benchmarks",
      "url": "https://epoch.ai/data/benchmark_data.zip",
      "license": "CC-BY-4.0; external tables keep their own license",
      "attribution": "Epoch AI, 'Capabilities & benchmarking'. Published online at epoch.ai. Retrieved from 'https://epoch.ai/benchmarks' (CC BY 4.0)",
      "keyed": false
    },
    {
      "id": "artificial-analysis",
      "name": "Artificial Analysis",
      "url": "https://artificialanalysis.ai/api/v2/data/llms/models",
      "license": "free key, internal use, attribution; read with the user's own key and never shipped",
      "attribution": "Data from Artificial Analysis, https://artificialanalysis.ai",
      "keyed": true
    }
  ],
  "aliases": {
    "claude-4-5-haiku": "claude-haiku-4-5",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5"
  },
  "defaultEffort": {
    "gpt-6-astra": "medium",
    "gpt-6-sol": "medium",
    "gpt-6-luna": "medium",
    "gpt-5.6-sol": "medium",
    "gpt-5.6-terra": "medium",
    "gpt-5.6-luna": "medium",
    "claude-fable-5-1": "high",
    "claude-opus-5-5": "high",
    "claude-sonnet-5": "high",
    "claude-haiku-4-5": "default"
  }
}
````

Create `src/domain/sources.ts`:

````ts
import { z } from "zod";
import type { Family } from "./catalog.ts";

/** Spec 1.2 §3.1: the sources `catherd catalog sync` reads, one cache file each in `<data>/sources/`. */
export const SOURCE_IDS = [
  "models-dev",
  "openrouter-models",
  "openrouter-endpoints",
  "litellm",
  "arena",
  "vectara",
  "epoch",
  "artificial-analysis",
] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

/** `catalog/sources.json`: each source with its license and attribution line, the id aliases, default efforts. */
export const SourcesFileSchema = z.looseObject({
  schema: z.literal(1),
  version: z.string(),
  sources: z.array(
    z.object({
      id: z.enum(SOURCE_IDS),
      name: z.string(),
      url: z.url(),
      license: z.string(),
      attribution: z.string(),
      keyed: z.boolean(),
    }),
  ),
  /** a source's irregular model id → the catalog's id (spec 1.2 §3.4) */
  aliases: z.record(z.string(), z.string()),
  /** family id → the effort a source that names none means; a family not listed means `high` */
  defaultEffort: z.record(z.string(), z.string()),
});
export type SourcesFile = z.infer<typeof SourcesFileSchema>;

/** Effort words as catherd writes them, weakest first; a source's spelling (`xHigh`, `MAX`) is folded onto these. */
export const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** `s` as a catherd effort word (`xHigh` → `xhigh`), or null when it is not one. */
export function effortWord(s: string): string | null {
  const w = s.trim().toLowerCase();
  return (EFFORT_ORDER as readonly string[]).includes(w) ? w : null;
}

/**
 * Spec 1.2 §3.4: a source's model id in catherd's form: without a `vendor/` prefix, lower case, and each run
 * of dots and blanks as one `-` (`openai/gpt-5.6-sol` and `GPT 5.6 Sol` → `gpt-5-6-sol`).
 */
export function normalizeId(id: string): string {
  return id
    .slice(id.lastIndexOf("/") + 1)
    .trim()
    .toLowerCase()
    .replace(/[\s.]+/g, "-")
    .replace(/-+/g, "-");
}

/** A parser's `rung`: `<source's model id>#<effort>`, or the bare id when the source names no effort. */
export function splitSourceRung(rung: string): { id: string; effort: string | null } {
  const hash = rung.lastIndexOf("#");
  return hash < 0 ? { id: rung, effort: null } : { id: rung.slice(0, hash), effort: rung.slice(hash + 1) };
}

export interface IdMapper {
  /** the id pairs are keyed by: normalized, then through the alias table */
  key(id: string): string;
  /** the catalog family a source id names, directly, by a backend's own id or through an alias; never guessed */
  family(id: string): Family | null;
}

/** Spec 1.2 §3.4: matches a source's ids to the catalog's families. */
export function idMapper(families: Family[], aliases: Record<string, string>): IdMapper {
  const alias = new Map(Object.entries(aliases).map(([from, to]) => [normalizeId(from), normalizeId(to)]));
  const byKey = new Map<string, Family>();
  for (const f of families) {
    for (const on of Object.values(f.on)) if (on) byKey.set(normalizeId(on.id), f);
    byKey.set(normalizeId(f.id), f);
  }
  const key = (id: string) => {
    const n = normalizeId(id);
    return alias.get(n) ?? n;
  };
  return { key, family: (id) => byKey.get(key(id)) ?? null };
}

/** Spec 1.2 §3.4: the effort a source that names none means for `family`. */
export const defaultEffortOf = (sources: SourcesFile, family: Family): string =>
  sources.defaultEffort[family.id] ?? "high";

const order = (e: string) => (EFFORT_ORDER as readonly string[]).indexOf(e);

/** Every effort the family offers on any backend, weakest first (spec 1.2 §4.3 `adjacent`). */
export function familyEfforts(f: Family): string[] {
  const all = new Set<string>();
  for (const on of Object.values(f.on)) for (const e of on?.efforts ?? []) all.add(e);
  return [...all].filter((e) => order(e) >= 0).sort((a, b) => order(a) - order(b));
}

/** The effort of `have` nearest `target` (the weaker one on a tie); null when `have` holds no effort word. */
export function nearestEffort(target: string, have: string[]): string | null {
  const t = order(target);
  let best: string | null = null;
  for (const e of have) {
    const i = order(e);
    if (i < 0 || t < 0) continue;
    const b = best === null ? Number.POSITIVE_INFINITY : Math.abs(order(best) - t);
    if (Math.abs(i - t) < b || (Math.abs(i - t) === b && i < order(best as string))) best = e;
  }
  return best;
}
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun run format && bun test test/domain/sources.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

````bash
git add catalog/sources.json src/domain/sources.ts test/domain/sources.test.ts
git commit -m "feat(catalog): source ids, effort mapping and catalog/sources.json"
````

---

### Task 3: Calibration onto each dimension's anchor (spec 1.2 §4.1, §4.2; Ruling 6)

Each dimension's anchor and the sources calibrated onto it, the least-squares fit and the rule that uses it (≥ 5 shared rungs, R² ≥ 0.5). Needs Task 1 (`DIMS`) and Task 2 (`SourceId`).

**Files:**
- Create: `src/domain/calibration.ts`
- Create: `test/domain/calibration.test.ts`

**Interfaces:**
- Consumes: `type Dim`, `DIMS` (Task 1); `type SourceId` (Task 2).
- Produces: `src/domain/calibration.ts`: `MIN_SHARED = 5`, `MIN_R2 = 0.5`, `interface FieldRef { source: SourceId; field: string; benchmark: string }`, `DIM_SOURCES: Record<Dim, { anchor: FieldRef | "shipped"; others: FieldRef[] }>`, `interface LineFit { a, b, r2, n }`, `fitLine(pairs): LineFit | null`, `calibrate(anchor: Map<string, number>, other: Map<string, number>): { fit: LineFit | null; n: number; used: boolean; why?: string }`. The field names are the parsers' (Tasks 5–8): Arena's config names, Vectara `factual_consistency`, Epoch `frontiercode`/`terminalbench`/`webdev`, AA's own evaluation keys.

- [ ] **Step 1: Write the failing tests**

Create `test/domain/calibration.test.ts`:

````ts
import { describe, expect, it } from "bun:test";
import { calibrate, DIM_SOURCES, fitLine, MIN_R2, MIN_SHARED } from "../../src/domain/calibration.ts";
import { DIMS } from "../../src/domain/catalog.ts";

const map = (xs: [string, number][]) => new Map(xs);

describe("calibration (spec 1.2 §4.2)", () => {
  it("fits anchor = a·x + b by least squares, with its R²", () => {
    const f = fitLine([
      [0.1, 30],
      [0.2, 50],
      [0.3, 70],
    ]);
    expect(f?.a).toBeCloseTo(200, 6);
    expect(f?.b).toBeCloseTo(10, 6);
    expect(f?.r2).toBeCloseTo(1, 6);
    expect(fitLine([[1, 2]])).toBeNull();
    expect(
      fitLine([
        [1, 2],
        [1, 3],
      ]),
    ).toBeNull();
  });

  it("uses a source that shares five rungs with the anchor and fits with R² ≥ 0.5", () => {
    expect([MIN_SHARED, MIN_R2]).toEqual([5, 0.5]);
    const anchor = map([
      ["a#high", 50],
      ["b#high", 60],
      ["c#high", 70],
      ["d#high", 80],
      ["e#high", 90],
      ["only-anchor#high", 10],
    ]);
    const other = map([
      ["a#high", 0.5],
      ["b#high", 0.61],
      ["c#high", 0.69],
      ["d#high", 0.8],
      ["e#high", 0.9],
      ["only-other#high", 0.1],
    ]);
    const r = calibrate(anchor, other);
    expect(r.used).toBe(true);
    expect(r.n).toBe(5);
    expect(r.fit?.r2).toBeGreaterThan(0.99);
    expect((r.fit?.a ?? 0) * 0.7 + (r.fit?.b ?? 0)).toBeCloseTo(70, 0);
  });

  it("rejects a source with fewer than five shared rungs, and one whose fit has R² below 0.5", () => {
    const anchor = map([
      ["a#high", 50],
      ["b#high", 60],
      ["c#high", 70],
      ["d#high", 80],
      ["e#high", 90],
    ]);
    const four = calibrate(
      anchor,
      map([...anchor].slice(0, 4).map(([k, v]) => [k, v / 100] as [string, number])),
    );
    expect(four).toEqual({ fit: null, n: 4, used: false, why: "4 shared rungs; a fit needs 5" });
    const noise = calibrate(
      anchor,
      map([
        ["a#high", 3],
        ["b#high", 1],
        ["c#high", 4],
        ["d#high", 1],
        ["e#high", 3],
      ]),
    );
    expect(noise.used).toBe(false);
    expect(noise.fit?.r2).toBeLessThan(0.5);
    expect(noise.why).toStartWith("R² ");
  });

  it("anchors every dimension on a keyless source or the shipped file, never on Artificial Analysis", () => {
    expect(Object.keys(DIM_SOURCES)).toEqual([...DIMS]);
    for (const d of DIMS) {
      const a = DIM_SOURCES[d].anchor;
      expect(a === "shipped" || a.source !== "artificial-analysis").toBe(true);
    }
  });
});
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/domain/calibration.test.ts`
Expected: FAIL: `Cannot find module "../../src/domain/calibration.ts"`.

- [ ] **Step 3: Implement**

Create `src/domain/calibration.ts`:

````ts
import type { Dim } from "./catalog.ts";
import type { SourceId } from "./sources.ts";

/** Spec 1.2 §4.2: a source needs this many rungs shared with the anchor for a dimension. */
export const MIN_SHARED = 5;
/** Spec 1.2 §4.2: a fit below this R² is not used. */
export const MIN_R2 = 0.5;

/** One number a source parser returns: `field` of `source`, and the benchmark it names. */
export interface FieldRef {
  source: SourceId;
  field: string;
  benchmark: string;
}

/**
 * Spec 1.2 §4.1: each dimension's anchor, the unit its bars are in, and the sources calibrated onto it.
 * `shipped` is the value `catalog/scores.json` carries (every anchor is keyless, spec 1.2 §4.1).
 */
export const DIM_SOURCES: Record<Dim, { anchor: FieldRef | "shipped"; others: FieldRef[] }> = {
  repo_code: {
    anchor: "shipped",
    others: [
      {
        source: "artificial-analysis",
        field: "livecodebench",
        benchmark: "LiveCodeBench (Artificial Analysis)",
      },
      { source: "artificial-analysis", field: "scicode", benchmark: "SciCode (Artificial Analysis)" },
      {
        source: "artificial-analysis",
        field: "artificial_analysis_coding_index",
        benchmark: "Artificial Analysis Coding Index",
      },
      { source: "epoch", field: "frontiercode", benchmark: "FrontierCode (Epoch AI)" },
    ],
  },
  terminal: {
    anchor: { source: "epoch", field: "terminalbench", benchmark: "Terminal-Bench (Epoch AI)" },
    others: [
      {
        source: "artificial-analysis",
        field: "terminalbench_v2_1",
        benchmark: "Terminal-Bench 2.1 (Artificial Analysis)",
      },
    ],
  },
  honesty: {
    anchor: "shipped",
    others: [
      { source: "vectara", field: "factual_consistency", benchmark: "Vectara factual consistency rate" },
      { source: "arena", field: "agent_tool_hallucination", benchmark: "Arena agent tool hallucination" },
    ],
  },
  agentic: {
    anchor: { source: "arena", field: "agent", benchmark: "Arena agent, net improvement" },
    others: [
      { source: "arena", field: "agent_task_outcome_explicit", benchmark: "Arena agent task outcome" },
      { source: "arena", field: "agent_bash_recovery_steps", benchmark: "Arena agent bash recovery" },
      { source: "artificial-analysis", field: "tau2", benchmark: "tau2-bench (Artificial Analysis)" },
    ],
  },
  steer: {
    anchor: { source: "arena", field: "agent_steerability", benchmark: "Arena agent steerability" },
    others: [],
  },
  frontend: {
    anchor: { source: "arena", field: "webdev", benchmark: "Arena WebDev rating" },
    others: [{ source: "epoch", field: "webdev", benchmark: "WebDev Arena (Epoch AI)" }],
  },
};

export interface LineFit {
  a: number;
  b: number;
  r2: number;
  n: number;
}

/** Least squares `anchor = a·x + b` over `[x, anchor]` pairs; null with fewer than 2 pairs or no spread in x. */
export function fitLine(pairs: readonly (readonly [number, number])[]): LineFit | null {
  const n = pairs.length;
  if (n < 2) return null;
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
    syy += (y - my) ** 2;
  }
  if (sxx === 0) return null;
  const a = sxy / sxx;
  const b = my - a * mx;
  const res = pairs.reduce((s, [x, y]) => s + (y - (a * x + b)) ** 2, 0);
  return { a, b, r2: syy === 0 ? 0 : 1 - res / syy, n };
}

/**
 * Spec 1.2 §4.2: the fit of `other` onto `anchor` over the keys both hold, and whether it may be used: at
 * least MIN_SHARED shared rungs and an R² of at least MIN_R2. `why` says why not.
 */
export function calibrate(
  anchor: ReadonlyMap<string, number>,
  other: ReadonlyMap<string, number>,
): { fit: LineFit | null; n: number; used: boolean; why?: string } {
  const pairs: [number, number][] = [];
  for (const [k, x] of other) {
    const y = anchor.get(k);
    if (y !== undefined) pairs.push([x, y]);
  }
  const n = pairs.length;
  if (n < MIN_SHARED)
    return { fit: null, n, used: false, why: `${n} shared rungs; a fit needs ${MIN_SHARED}` };
  const fit = fitLine(pairs);
  if (!fit) return { fit: null, n, used: false, why: "the source gives every shared rung the same value" };
  if (fit.r2 < MIN_R2) return { fit, n, used: false, why: `R² ${fit.r2.toFixed(2)} is below ${MIN_R2}` };
  return { fit, n, used: true };
}
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun run format && bun test test/domain/calibration.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

````bash
git add src/domain/calibration.ts test/domain/calibration.test.ts
git commit -m "feat(catalog): calibration fits onto each dimension's anchor"
````

---

### Task 4: The request, cache, state and lock every source shares (spec 1.2 §3.2, §3.3; R-E, Rulings 11, 21)

`retryingFetch` is `jevRequest`'s loop, unchanged, over any URL and returning bytes; `jevRequest` becomes a thin wrapper (its tests pass untouched). `sourceGet` fetches a source with a 30 s attempt and 60 s deadline. The cache writes each answer atomically (mode 600) with its fetch time; `state.json` holds attempts and errors; one sync holds `<data>/sources/sync.lock`. Also the fixtures README (every fixture's curl line; the files arrive in Tasks 5–8). Needs Task 2 (`SourceId`).

**Files:**
- Modify: `src/infra/jev-client.ts`
- Modify: `src/infra/paths.ts`
- Create: `src/infra/sources/cache.ts`
- Create: `src/infra/sources/http.ts`
- Create: `src/infra/sources/rows.ts`
- Create: `test/fixtures/sources/README.md`
- Create: `test/infra/sources/cache.test.ts`
- Create: `test/infra/sources/http.test.ts`
- Create: `test/infra/sources/rows.test.ts`

**Interfaces:**
- Consumes: `type SourceId` (Task 2); `tryLock` (infra/filelock.ts); `writeTextAtomic`, `writeJsonAtomic`, `readVersioned`, `ensurePrivateDir` (infra/store.ts).
- Produces: `src/infra/jev-client.ts`: `type FetchOutcome`, `retryingFetch(url, { method, headers: (attempt) => Record<string,string>, body? }, JevTransport & { errorOf? }): Promise<FetchOutcome>`. `src/infra/sources/http.ts`: `type SourceTransport` (= `JevTransport`), `class SourceError(message, status: number | null, headers: Headers | null)`, `interface SourceResponse { status; headers; bytes; text(); json() }`, `sourceGet(url, SourceTransport & { headers? }): Promise<SourceResponse>`, `rateLimitRemaining(h: Headers | null): number | null`. `src/infra/sources/rows.ts`: `interface SourceRow { rung; field; value; date; url }`, `isoDay`, `urlOr`, `num`, `keepHighest`. `src/infra/sources/cache.ts`: `cachePath(id)`, `type Cached`, `readCached(id): Cached | null`, `writeCached(id, data, fetchedAt: number, meta?)`, `type SyncState`, `statePath`, `readSyncState()`, `writeSyncState(s)`, `tryLockSync(): (() => void) | null`. `src/infra/paths.ts`: `sourcesDir()`.

- [ ] **Step 1: Add the fixtures**

Create `test/fixtures/sources/README.md`:

````markdown
# Source fixtures (spec 1.2 §3, §11)

One recorded answer per source, cut to the rows the tests read. Each keeps the source's own structure and values;
only whole rows, whole models and a few long unused fields (descriptions, OpenRouter's parameter lists, models.dev's
`experimental` block and cost tiers) were cut. No test reaches the network: the parsers read these files, and the
sync tests serve them through an injected fetch.

Recorded on 2026-09-28 from the sandbox, through its proxy:

| File | Recorded with | Cut to |
| --- | --- | --- |
| `models-dev.json` | `curl -sS https://models.dev/api.json` | providers `openai`, `anthropic`, `opencode`, `opencode-go`; 9 models |
| `openrouter-models.json` | `curl -sS https://openrouter.ai/api/v1/models` | 6 models; the fields id, canonical_slug, name, created, context_length, pricing, top_provider, reasoning |
| `openrouter-endpoints.json` | `curl -sS https://openrouter.ai/api/v1/models/openai/gpt-6-sol/endpoints` and `…/anthropic/claude-opus-5.5/endpoints` | the first two endpoints of each, keyed by the model's OpenRouter id (the shape catherd caches) |
| `litellm.json` | `curl -sS https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` | 6 entries, the price, context, provider and effort fields |
| `arena-<config>.json` | `curl -sS 'https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=<config>&split=latest&length=100'` for `agent`, `agent_task_outcome_explicit`, `agent_bash_recovery_steps`, `agent_steerability`, `agent_tool_hallucination`, `webdev` | 12 rows (14 for `webdev`); `features` dropped |
| `vectara-README.md` | `curl -sS https://raw.githubusercontent.com/vectara/hallucination-leaderboard/main/README.md` | the text up to the table, 6 of its rows |
| `epoch/*.csv`, `epoch.zip` | `curl -sS -o epoch.zip https://epoch.ai/data/benchmark_data.zip` | `frontiercode_external.csv` (9 rows), `terminalbench_external.csv` (14), `webdev_arena_external.csv` (11), zipped again with deflate (`epoch.zip`) |

On 2026-09-28 no keyless source above has a `repo_code` or `terminal` value for Claude Opus 5.5: Arena's agent
boards have "Claude Opus 5.5 (High)" (agentic, steer, honesty), Arena WebDev has `claude-opus-5.5-max` (frontend),
and Epoch's FrontierCode and Terminal-Bench tables have no Opus 5.5 row. Plan 14's stand-in test relies on it.

## Artificial Analysis: synthetic, re-record with a key

The sandbox has no Artificial Analysis key (both paths answer 401), so these two files are **synthetic**: built from
the fields `docs/dev/ideas.md` documents (one row per effort, the bare slug meaning `max`), with made-up values.
Re-record them with a key and adjust the tests' expected values:

| File | Record with |
| --- | --- |
| `artificial-analysis-models.json` | `curl -sS -H "x-api-key: $ARTIFICIAL_ANALYSIS_API_KEY" https://artificialanalysis.ai/api/v2/data/llms/models` |
| `artificial-analysis-free-1.json`, `artificial-analysis-free-2.json` | `curl -sS -H "x-api-key: $ARTIFICIAL_ANALYSIS_API_KEY" 'https://artificialanalysis.ai/api/v2/language/models/free?page=1'` (and `page=2`) |
````

- [ ] **Step 2: Write the failing tests**

Create `test/infra/sources/cache.test.ts`:

````ts
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sourcesDir } from "../../../src/infra/paths.ts";
import {
  cachePath,
  readCached,
  readSyncState,
  tryLockSync,
  writeCached,
  writeSyncState,
} from "../../../src/infra/sources/cache.ts";
import { noPosixModes, snapshotEnv, withHome } from "../../helpers.ts";

afterEach(snapshotEnv());

const T0 = Date.parse("2026-09-28T10:00:00.000Z");

describe("the source cache (spec 1.2 §3.3)", () => {
  it("keeps each source's answer with its fetch time in <data>/sources/<source>.json", () => {
    withHome();
    expect(readCached("vectara")).toBeNull();
    writeCached("vectara", "| table |", T0, { note: 1 });
    expect(cachePath("vectara")).toBe(`${sourcesDir()}/vectara.json`);
    expect(readCached("vectara")).toEqual({
      schema: 1,
      source: "vectara",
      fetchedAt: "2026-09-28T10:00:00.000Z",
      data: "| table |",
      meta: { note: 1 },
    });
  });

  it.skipIf(noPosixModes)("writes it at mode 600", () => {
    withHome();
    writeCached("arena", {}, T0);
    expect(statSync(cachePath("arena")).mode & 0o777).toBe(0o600);
  });

  it("reads an unreadable cache file as none, so the next sync writes it again", () => {
    withHome();
    mkdirSync(dirname(cachePath("epoch")), { recursive: true });
    writeFileSync(cachePath("epoch"), "{not json");
    expect(readCached("epoch")).toBeNull();
  });

  it("keeps each source's last attempt and error in state.json, empty before the first sync", () => {
    withHome();
    expect(readSyncState()).toEqual({ schema: 1, sources: {} });
    writeSyncState({
      schema: 1,
      sources: {
        arena: { lastAttemptAt: "2026-09-28T10:00:00.000Z", error: "http 503", rateLimitRemaining: null },
      },
    });
    expect(readSyncState().sources.arena?.error).toBe("http 503");
  });

  it("lets one sync hold the lock at a time", () => {
    withHome();
    const release = tryLockSync();
    expect(release).not.toBeNull();
    expect(tryLockSync()).toBeNull();
    release?.();
    const again = tryLockSync();
    expect(again).not.toBeNull();
    again?.();
  });
});
````

Create `test/infra/sources/http.test.ts`:

````ts
import { describe, expect, it } from "bun:test";
import { rateLimitRemaining, SourceError, sourceGet } from "../../../src/infra/sources/http.ts";
import { VERSION } from "../../../src/infra/version.ts";
import { fakeFetch } from "../../fake-fetch.ts";

/** A fake clock: sleeping advances it, so retries never wait for real. */
function clock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), random: () => 0.5 };
}

describe("sourceGet (spec 1.2 §3.3)", () => {
  it("gets a source with catherd's user agent and any header it needs, and reads its JSON", async () => {
    const f = fakeFetch({ status: 200, body: { data: [1] } });
    const r = await sourceGet("https://example.com/a.json", {
      fetchImpl: f.impl,
      headers: { "x-api-key": "k" },
      ...clock(),
    });
    expect(r.json()).toEqual({ data: [1] });
    expect(f.sent[0]?.headers.get("user-agent")).toBe(
      `catherd-cli/${VERSION} (+https://github.com/47vigen/catherd)`,
    );
    expect(f.sent[0]?.headers.get("x-api-key")).toBe("k");
  });

  it("retries a 503 as the Jev client does, then gives up with the status and headers", async () => {
    const f = fakeFetch({ status: 503, body: {}, headers: { "x-ratelimit-remaining": "7" } });
    const e = await sourceGet("https://example.com/a.json", { fetchImpl: f.impl, ...clock() }).catch(
      (x) => x,
    );
    expect(e).toBeInstanceOf(SourceError);
    expect([e.message, e.status, f.sent.length]).toEqual(["http 503", 503, 3]);
    expect(rateLimitRemaining(e.headers)).toBe(7);
  });

  it("never retries a 403 or 404, and names a body that is not JSON", async () => {
    const f = fakeFetch({ status: 404, body: {} });
    const e = await sourceGet("https://example.com/a.json", { fetchImpl: f.impl, ...clock() }).catch(
      (x) => x,
    );
    expect([e.message, f.sent.length]).toEqual(["http 404", 1]);
    const html = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    const r = await sourceGet("https://example.com/a", { fetchImpl: html, ...clock() });
    expect(r.text()).toBe("<html>");
    expect(() => r.json()).toThrow("unexpected response (not JSON)");
  });

  it("times out a source that never answers", async () => {
    const f = fakeFetch("hang");
    const e = await sourceGet("https://example.com/a.json", {
      fetchImpl: f.impl,
      ...clock(),
      attemptMs: 10,
      retries: 0,
    }).catch((x) => x);
    expect(e.message).toBe("timeout");
  });

  it("reads x-ratelimit-remaining only when the answer has a number there", () => {
    expect(rateLimitRemaining(new Headers({ "x-ratelimit-remaining": "98" }))).toBe(98);
    expect(rateLimitRemaining(new Headers({ "x-ratelimit-remaining": " " }))).toBeNull();
    expect(rateLimitRemaining(new Headers())).toBeNull();
    expect(rateLimitRemaining(null)).toBeNull();
  });
});
````

Create `test/infra/sources/rows.test.ts`:

````ts
import { describe, expect, it } from "bun:test";
import { isoDay, keepHighest, num, urlOr } from "../../../src/infra/sources/rows.ts";

describe("parser helpers (spec 1.2 §3.3)", () => {
  it("reads numbers and numeric strings, nothing else", () => {
    expect([num(1.5), num("0.25"), num(""), num("x"), num(null), num(Number.NaN)]).toEqual([
      1.5,
      0.25,
      null,
      null,
      null,
      null,
    ]);
  });

  it("keeps an http(s) URL and falls back on anything else", () => {
    expect(urlOr(" https://a.example/x ", "https://b.example")).toBe("https://a.example/x");
    expect(urlOr("Terminal-Bench v2 Leaderboard", "https://b.example")).toBe("https://b.example");
    expect(urlOr(undefined, "https://b.example")).toBe("https://b.example");
    expect(isoDay("2026-09-28T10:00:00.000Z")).toBe("2026-09-28");
  });

  it("keeps the highest value per rung and field", () => {
    const row = (rung: string, value: number) => ({
      rung,
      field: "f",
      value,
      date: "2026-09-28",
      url: "https://a",
    });
    expect(
      keepHighest([row("a", 1), row("a", 3), row("b", 2), row("a", 2)]).map((r) => [r.rung, r.value]),
    ).toEqual([
      ["a", 3],
      ["b", 2],
    ]);
  });
});
````

- [ ] **Step 3: Run them and see them fail**

Run: `bun test test/infra/sources`
Expected: FAIL: `Cannot find module "../../../src/infra/sources/http.ts"` (and the cache and rows modules).

- [ ] **Step 4: Implement**

Edit `src/infra/jev-client.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/infra/jev-client.ts b/src/infra/jev-client.ts
index aff8048..070acf2 100644
--- a/src/infra/jev-client.ts
+++ b/src/infra/jev-client.ts
@@ -1,5 +1,6 @@
 // Spec §5.5 transport: a thin client (the official SDK is 0.x and Node-targeted) with the SDK's retry
-// semantics (research 2026-09-25-jev.md §4, §5.6).
+// semantics (research 2026-09-25-jev.md §4, §5.6). The public sources of spec 1.2 §3.3 reuse its policy
+// through `retryingFetch`.
 
 export const JEV_BASE = "https://api.typesafe.ai/v1";
 
@@ -20,6 +21,19 @@ export type JevResponse =
   | { ok: true; body: unknown; requestId: string | null; latencyMs: number; attempts: number }
   | { ok: false; error: string; status: number | null; latencyMs: number; attempts: number };
 
+/** What `retryingFetch` got: the body's bytes on a 2xx, else the last error and status. */
+export type FetchOutcome =
+  | { ok: true; status: number; headers: Headers; bytes: Uint8Array; latencyMs: number; attempts: number }
+  | {
+      ok: false;
+      error: string;
+      status: number | null;
+      /** the last answer's headers, when there was an answer */
+      headers: Headers | null;
+      latencyMs: number;
+      attempts: number;
+    };
+
 const RETRY_AFTER_MAX_MS = 10_000;
 const retryable = (status: number) => status === 408 || status === 429 || status >= 500;
 
@@ -64,25 +78,30 @@ function httpError(status: number, text: string): string {
 }
 
 /**
- * `method path` against the Jev API with a bearer key: 10 s per attempt, up to two retries on 408, 429,
- * 5xx, a network error or a timeout, honouring Retry-After, and never past the 25 s deadline. The attempt
- * timer covers the whole exchange, body included, and aborts the request when it fires.
+ * `url` with the Jev client's retry policy: `attemptMs` per attempt (10 s), up to `retries` (two) retries on
+ * 408, 429, 5xx, a network error or a timeout, honouring Retry-After, and never past `deadlineMs` (25 s). The
+ * attempt timer covers the whole exchange, body included, and aborts the request when it fires. `headers`
+ * builds each attempt's headers from its number (1 first); `errorOf` names a failed status (`http <status>`).
+ * Bun's fetch honours HTTPS_PROXY and HTTP_PROXY.
  */
-export async function jevRequest(
-  method: "GET" | "POST",
-  path: string,
-  key: string,
-  body: unknown,
-  o: JevTransport = {},
-): Promise<JevResponse> {
+export async function retryingFetch(
+  url: string,
+  init: { method: "GET" | "POST"; headers: (attempt: number) => Record<string, string>; body?: string },
+  o: JevTransport & { errorOf?: (status: number, text: string) => string } = {},
+): Promise<FetchOutcome> {
   const now = o.now ?? Date.now;
   const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
   const random = o.random ?? Math.random;
   const fetchImpl = o.fetchImpl ?? globalThis.fetch;
+  const errorOf = o.errorOf ?? ((status: number) => `http ${status}`);
   const start = now();
   const deadline = start + (o.deadlineMs ?? 25_000);
   const retries = o.retries ?? 2;
-  let last: { error: string; status: number | null } = { error: "network error", status: null };
+  let last: { error: string; status: number | null; headers: Headers | null } = {
+    error: "network error",
+    status: null,
+    headers: null,
+  };
   let attempt = 0;
   for (;;) {
     attempt++;
@@ -100,52 +119,37 @@ export async function jevRequest(
       );
     });
     const exchange = async () => {
-      const res = await fetchImpl(`${JEV_BASE}${path}`, {
-        method,
-        headers: {
-          authorization: `Bearer ${key}`,
-          ...(body === undefined ? {} : { "content-type": "application/json" }),
-          ...(attempt > 1 ? { "x-typesafe-retry-count": String(attempt - 1) } : {}),
-        },
-        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
+      const res = await fetchImpl(url, {
+        method: init.method,
+        headers: init.headers(attempt),
+        ...(init.body === undefined ? {} : { body: init.body }),
         signal: ctl.signal,
       });
-      const text = res.ok ? await res.text() : await res.text().catch(() => "");
-      return { res, text };
+      if (res.ok) return { res, bytes: new Uint8Array(await res.arrayBuffer()), text: "" };
+      return { res, bytes: new Uint8Array(), text: await res.text().catch(() => "") };
     };
     let wait: number | null = null;
     try {
       const r = await Promise.race([exchange(), timeout]);
       if (r === "timeout") {
-        last = { error: "timeout", status: null };
+        last = { error: "timeout", status: null, headers: null };
       } else if (r.res.ok) {
-        let parsed: unknown = null;
-        try {
-          parsed = JSON.parse(r.text);
-        } catch {
-          return {
-            ok: false,
-            error: "unexpected response",
-            status: r.res.status,
-            latencyMs: now() - start,
-            attempts: attempt,
-          };
-        }
         return {
           ok: true,
-          body: parsed,
-          requestId: r.res.headers.get("x-typesafe-request-id"),
+          status: r.res.status,
+          headers: r.res.headers,
+          bytes: r.bytes,
           latencyMs: now() - start,
           attempts: attempt,
         };
       } else {
-        last = { error: httpError(r.res.status, r.text), status: r.res.status };
+        last = { error: errorOf(r.res.status, r.text), status: r.res.status, headers: r.res.headers };
         if (!retryable(r.res.status))
           return { ok: false, ...last, latencyMs: now() - start, attempts: attempt };
         wait = retryAfterMs(r.res.headers, now());
       }
     } catch {
-      last = { error: "network error", status: null };
+      last = { error: "network error", status: null, headers: null };
     } finally {
       clearTimeout(timer);
       ctl.abort();
@@ -153,10 +157,54 @@ export async function jevRequest(
     if (attempt > retries) break;
     const pause = wait ?? backoffMs(attempt, random);
     if (now() + pause >= deadline) {
-      last = { error: `deadline (${last.error})`, status: last.status };
+      last = { ...last, error: `deadline (${last.error})` };
       break;
     }
     await sleep(pause);
   }
   return { ok: false, ...last, latencyMs: now() - start, attempts: attempt };
 }
+
+/** `method path` against the Jev API with a bearer key, under `retryingFetch`'s policy. */
+export async function jevRequest(
+  method: "GET" | "POST",
+  path: string,
+  key: string,
+  body: unknown,
+  o: JevTransport = {},
+): Promise<JevResponse> {
+  const r = await retryingFetch(
+    `${JEV_BASE}${path}`,
+    {
+      method,
+      headers: (attempt) => ({
+        authorization: `Bearer ${key}`,
+        ...(body === undefined ? {} : { "content-type": "application/json" }),
+        ...(attempt > 1 ? { "x-typesafe-retry-count": String(attempt - 1) } : {}),
+      }),
+      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
+    },
+    { ...o, errorOf: httpError },
+  );
+  if (!r.ok)
+    return { ok: false, error: r.error, status: r.status, latencyMs: r.latencyMs, attempts: r.attempts };
+  let parsed: unknown = null;
+  try {
+    parsed = JSON.parse(new TextDecoder().decode(r.bytes));
+  } catch {
+    return {
+      ok: false,
+      error: "unexpected response",
+      status: r.status,
+      latencyMs: r.latencyMs,
+      attempts: r.attempts,
+    };
+  }
+  return {
+    ok: true,
+    body: parsed,
+    requestId: r.headers.get("x-typesafe-request-id"),
+    latencyMs: r.latencyMs,
+    attempts: r.attempts,
+  };
+}
````

Edit `src/infra/paths.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/infra/paths.ts b/src/infra/paths.ts
index 1f5f383..13b5942 100644
--- a/src/infra/paths.ts
+++ b/src/infra/paths.ts
@@ -36,3 +36,5 @@ export const runsDir = (toplevel: string): string => join(repoDir(toplevel), "ru
 export const logsDir = (): string => join(dataDir(), "logs");
 export const discoveryDir = (): string => join(dataDir(), "discovery");
 export const locksDir = (): string => join(dataDir(), "locks");
+/** Spec 1.2 §3.3: each source's last good answer, the sync state and lock, and what the sync derived. */
+export const sourcesDir = (): string => join(dataDir(), "sources");
````

Create `src/infra/sources/cache.ts`:

````ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { errorMessage } from "../../domain/errors.ts";
import type { SourceId } from "../../domain/sources.ts";
import { tryLock } from "../filelock.ts";
import { log } from "../log.ts";
import { sourcesDir } from "../paths.ts";
import { ensurePrivateDir, readVersioned, writeJsonAtomic, writeTextAtomic } from "../store.ts";

// Spec 1.2 §3.3: `<data>/sources/<source>.json` holds a source's last good answer with its fetch time; a
// failed fetch never touches it. `state.json` holds each source's last attempt and error.

export const cachePath = (id: SourceId): string => join(sourcesDir(), `${id}.json`);

const CachedSchema = z.looseObject({
  schema: z.literal(1),
  source: z.string(),
  fetchedAt: z.iso.datetime(),
  /** the answer as fetched (Epoch: the CSV tables catherd reads out of its zip) */
  data: z.unknown(),
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type Cached = z.infer<typeof CachedSchema>;

/** A source's last good answer; null when there is none, or when it cannot be read (the next sync rewrites it). */
export function readCached(id: SourceId): Cached | null {
  const file = cachePath(id);
  if (!existsSync(file)) return null;
  try {
    return readVersioned(file, CachedSchema, 1);
  } catch (e) {
    log("debug", "sources", { source: id, error: errorMessage(e) });
    return null;
  }
}

/** Writes a source's answer atomically (mode 600), compact: models.dev alone is 5 MB. */
export function writeCached(
  id: SourceId,
  data: unknown,
  fetchedAt: number,
  meta: Record<string, unknown> = {},
): Cached {
  const c: Cached = { schema: 1, source: id, fetchedAt: new Date(fetchedAt).toISOString(), data, meta };
  writeTextAtomic(cachePath(id), `${JSON.stringify(c)}\n`);
  return c;
}

const StateSchema = z.looseObject({
  schema: z.literal(1),
  sources: z
    .record(
      z.string(),
      z.looseObject({
        lastAttemptAt: z.iso.datetime(),
        error: z.string().nullable(),
        /** Artificial Analysis: `x-ratelimit-remaining` of its last answer */
        rateLimitRemaining: z.number().nullable().default(null),
      }),
    )
    .default({}),
});
export type SyncState = z.infer<typeof StateSchema>;

export const statePath = (): string => join(sourcesDir(), "state.json");

/** Each source's last attempt; empty when never synced or unreadable. */
export function readSyncState(): SyncState {
  const empty: SyncState = { schema: 1, sources: {} };
  if (!existsSync(statePath())) return empty;
  try {
    return readVersioned(statePath(), StateSchema, 1);
  } catch (e) {
    log("debug", "sources", { state: errorMessage(e) });
    return empty;
  }
}

export const writeSyncState = (s: SyncState): void => writeJsonAtomic(statePath(), s);

/** Spec 1.2 §3.2: one sync at a time on this machine. Its release, or null while another live process syncs. */
export function tryLockSync(): (() => void) | null {
  ensurePrivateDir(sourcesDir());
  return tryLock(join(sourcesDir(), "sync"));
}
````

Create `src/infra/sources/http.ts`:

````ts
import { type JevTransport, retryingFetch } from "../jev-client.ts";
import { VERSION } from "../version.ts";

/** How a source is fetched; tests replace `fetchImpl` and the clock, so no test reaches the network. */
export type SourceTransport = JevTransport;

/** A source request that failed: the error, and the status and headers of the last answer when there was one. */
export class SourceError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly headers: Headers | null = null,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

export interface SourceResponse {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
  text(): string;
  /** the body as JSON; a SourceError when it is not */
  json(): unknown;
}

/** Spec 1.2 §3.3: one timeout per source; the big files (models.dev, LiteLLM, Epoch) need more than Jev's 10 s. */
const ATTEMPT_MS = 30_000;
const DEADLINE_MS = 60_000;

/**
 * Spec 1.2 §3.3: GET `url` with the Jev client's retry policy and the source's own timeout (30 s an attempt,
 * 60 s in all, unless the transport says otherwise). Throws a SourceError on any failure.
 */
export async function sourceGet(
  url: string,
  o: SourceTransport & { headers?: Record<string, string> } = {},
): Promise<SourceResponse> {
  const { headers = {}, ...t } = o;
  const r = await retryingFetch(
    url,
    {
      method: "GET",
      headers: () => ({
        "user-agent": `catherd-cli/${VERSION} (+https://github.com/47vigen/catherd)`,
        ...headers,
      }),
    },
    { attemptMs: ATTEMPT_MS, deadlineMs: DEADLINE_MS, ...t },
  );
  if (!r.ok) throw new SourceError(r.error, r.status, r.headers);
  const { bytes, status } = r;
  const text = () => new TextDecoder().decode(bytes);
  return {
    status,
    headers: r.headers,
    bytes,
    text,
    json() {
      try {
        return JSON.parse(text());
      } catch {
        throw new SourceError("unexpected response (not JSON)", status, r.headers);
      }
    },
  };
}

/** `x-ratelimit-remaining` of an answer, when it has one (Artificial Analysis, spec 1.2 §9). */
export function rateLimitRemaining(h: Headers | null): number | null {
  const raw = h?.get("x-ratelimit-remaining")?.trim();
  const v = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(v) ? v : null;
}
````

Create `src/infra/sources/rows.ts`:

````ts
/**
 * Spec 1.2 §3.3: what a score source's parser returns, one number each. `rung` is the source's own model id,
 * with `#<effort>` when the source names one (catherd's effort word); `date` is the day the source measured or
 * published it, else the day it was fetched; `url` is where the value can be checked.
 */
export interface SourceRow {
  rung: string;
  field: string;
  value: number;
  date: string;
  url: string;
}

/** The `YYYY-MM-DD` of an ISO time. */
export const isoDay = (iso: string): string => iso.slice(0, 10);

/** `candidate` when it is an http(s) URL, else `fallback`. */
export const urlOr = (candidate: unknown, fallback: string): string =>
  typeof candidate === "string" && /^https?:\/\//.test(candidate.trim()) && URL.canParse(candidate.trim())
    ? candidate.trim()
    : fallback;

/** `v` as a finite number (numbers and numeric strings), else null. */
export function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/** One row per rung and field: a source that lists a model twice (Epoch: one row per agent) keeps the highest. */
export function keepHighest(rows: SourceRow[]): SourceRow[] {
  const best = new Map<string, SourceRow>();
  for (const r of rows) {
    const k = `${r.rung}\u0000${r.field}`;
    const had = best.get(k);
    if (!had || r.value > had.value) best.set(k, r);
  }
  return [...best.values()];
}
````

- [ ] **Step 5: Run the tests and the checks**

Run: `bun run format && bun test test/infra/sources && bun test test/infra/jev-client.test.ts test/services/jev-service.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS (13 tests); also run `bun test test/infra/jev-client.test.ts test/services/jev-service.test.ts`: PASS (unchanged tests on the refactored client).

- [ ] **Step 6: Commit**

````bash
git add src/infra/jev-client.ts src/infra/paths.ts src/infra/sources/cache.ts src/infra/sources/http.ts src/infra/sources/rows.ts test/fixtures/sources/README.md test/infra/sources/cache.test.ts test/infra/sources/http.test.ts test/infra/sources/rows.test.ts
git commit -m "feat(sources): the request, cache, state and lock every source shares"
````

---

### Task 5: models.dev, OpenRouter and LiteLLM (spec 1.2 §3.1, §3.5; R-H)

The fact sources: each a fetcher and a parser into typed facts (efforts are lists, so these return facts rather than rows; the endpoints parser returns rows). Needs Task 4.

**Files:**
- Create: `src/infra/sources/litellm.ts`
- Create: `src/infra/sources/models-dev.ts`
- Create: `src/infra/sources/openrouter-endpoints.ts`
- Create: `src/infra/sources/openrouter-models.ts`
- Create: `test/fixtures/sources/litellm.json`
- Create: `test/fixtures/sources/models-dev.json`
- Create: `test/fixtures/sources/openrouter-endpoints.json`
- Create: `test/fixtures/sources/openrouter-models.json`
- Create: `test/infra/sources/facts.test.ts`

**Interfaces:**
- Consumes: `sourceGet`, `SourceError`, `type SourceTransport` (Task 4, http.ts); `num`, `isoDay`, `type SourceRow` (Task 4, rows.ts); `median` (domain/util.ts).
- Produces: `models-dev.ts`: `MODELS_DEV_URL`, `fetchModelsDev(t)`, `interface ModelFacts { efforts: string[] | null; context; output; price: { input, cached, output } | null; toolUse; imageIn; reasoning; releaseDate }`, `modelsDevFacts(raw, provider, id): ModelFacts | null`. `openrouter-models.ts`: `OPENROUTER_MODELS_URL`, `fetchOpenRouterModels(t)`, `interface OpenRouterModel { id; context; price: { input, output, cached } | null; efforts; defaultEffort }`, `perMillion(v): number | null`, `parseOpenRouterModels(raw): OpenRouterModel[]`. `openrouter-endpoints.ts`: `openRouterEndpointsUrl(id)`, `fetchOpenRouterEndpoints(ids, t): Promise<Record<string, unknown>>`, `ENDPOINT_FIELDS`, `parseOpenRouterEndpoints(raw, fetchedAt): SourceRow[]`. `litellm.ts`: `LITELLM_URL`, `fetchLiteLlm(t)`, `LITELLM_EFFORTS`, `interface LiteLlmModel { id; provider; price; context; efforts }`, `parseLiteLlm(raw): LiteLlmModel[]`.

- [ ] **Step 1: Add the fixtures**

Create `test/fixtures/sources/litellm.json`:

````json
{
"gpt-6-sol":{
"cache_read_input_token_cost":2e-07,
"input_cost_per_token":2e-06,
"litellm_provider":"openai",
"max_input_tokens":922000,
"max_output_tokens":128000,
"mode":"chat",
"output_cost_per_token":1e-05,
"supports_function_calling":true,
"supports_max_reasoning_effort":true,
"supports_minimal_reasoning_effort":false,
"supports_none_reasoning_effort":true,
"supports_xhigh_reasoning_effort":true
},
"gpt-6-luna":{
"cache_read_input_token_cost":1e-08,
"input_cost_per_token":1e-07,
"litellm_provider":"openai",
"max_input_tokens":922000,
"max_output_tokens":128000,
"mode":"chat",
"output_cost_per_token":5e-07,
"supports_function_calling":true,
"supports_max_reasoning_effort":true,
"supports_minimal_reasoning_effort":false,
"supports_none_reasoning_effort":true,
"supports_xhigh_reasoning_effort":true
},
"claude-opus-5-5":{
"cache_read_input_token_cost":2e-07,
"input_cost_per_token":4e-06,
"litellm_provider":"anthropic",
"max_input_tokens":1000000,
"max_output_tokens":128000,
"mode":"chat",
"output_cost_per_token":2e-05,
"supports_function_calling":true,
"supports_xhigh_reasoning_effort":true,
"supports_max_reasoning_effort":true
},
"claude-haiku-4-5":{
"cache_read_input_token_cost":1e-07,
"input_cost_per_token":1e-06,
"litellm_provider":"anthropic",
"max_input_tokens":200000,
"max_output_tokens":64000,
"mode":"chat",
"output_cost_per_token":5e-06,
"supports_function_calling":true
},
"azure/gpt-6-sol":{
"cache_read_input_token_cost":2e-07,
"input_cost_per_token":2e-06,
"litellm_provider":"azure",
"max_input_tokens":922000,
"max_output_tokens":128000,
"mode":"chat",
"output_cost_per_token":1e-05,
"supports_function_calling":true,
"supports_max_reasoning_effort":true,
"supports_minimal_reasoning_effort":false,
"supports_none_reasoning_effort":true,
"supports_xhigh_reasoning_effort":true
},
"openrouter/anthropic/claude-opus-5.5":{
"cache_read_input_token_cost":2e-07,
"input_cost_per_token":4e-06,
"litellm_provider":"openrouter",
"max_input_tokens":1000000,
"max_output_tokens":128000,
"mode":"chat",
"output_cost_per_token":2e-05,
"supports_function_calling":true
}
}
````

Create `test/fixtures/sources/models-dev.json`:

````json
{
"openai":{
"id":"openai",
"env":["OPENAI_API_KEY"],
"npm":"@ai-sdk/openai",
"name":"OpenAI",
"doc":"https://platform.openai.com/docs/models",
"models":{"gpt-6-sol":{"id":"gpt-6-sol","name":"GPT-6 Sol","family":"gpt-sol","attachment":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["none","low","medium","high","xhigh","max"]}],"tool_call":true,"structured_output":true,"temperature":false,"knowledge":"2026-04-20","release_date":"2026-09-22","last_updated":"2026-09-22","modalities":{"input":["text","image","pdf"],"output":["text"]},"open_weights":false,"limit":{"context":1050000,"input":922000,"output":128000},"cost":{"input":2,"output":10,"cache_read":0.2,"cache_write":2.5},"canonical_model_id":"openai/gpt-6-sol"},"gpt-6-luna":{"id":"gpt-6-luna","name":"GPT-6 Luna","family":"gpt-luna","attachment":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["none","low","medium","high","xhigh","max"]}],"tool_call":true,"structured_output":true,"temperature":false,"knowledge":"2026-05-18","release_date":"2026-09-22","last_updated":"2026-09-22","modalities":{"input":["text","image","pdf"],"output":["text"]},"open_weights":false,"limit":{"context":1050000,"input":922000,"output":128000},"cost":{"input":0.1,"output":0.5,"cache_read":0.01,"cache_write":0.125},"canonical_model_id":"openai/gpt-6-luna"},"gpt-5.6-sol":{"id":"gpt-5.6-sol","name":"GPT-5.6 Sol","family":"gpt-sol","attachment":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["none","low","medium","high","xhigh","max"]}],"tool_call":true,"structured_output":true,"temperature":false,"knowledge":"2026-02-16","release_date":"2026-07-09","last_updated":"2026-07-09","modalities":{"input":["text","image","pdf"],"output":["text"]},"open_weights":false,"limit":{"context":1050000,"input":922000,"output":128000},"cost":{"input":4,"output":20,"cache_read":0.4,"cache_write":5},"canonical_model_id":"openai/gpt-5.6-sol"}}
},
"anthropic":{
"id":"anthropic",
"env":["ANTHROPIC_API_KEY"],
"npm":"@ai-sdk/anthropic",
"name":"Anthropic",
"doc":"https://docs.anthropic.com/en/docs/about-claude/models",
"models":{"claude-opus-5-5":{"id":"claude-opus-5-5","name":"Claude Opus 5.5","family":"claude-opus","attachment":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["low","medium","high","xhigh","max"]}],"tool_call":true,"structured_output":true,"temperature":false,"knowledge":"2026-06","release_date":"2026-09-22","last_updated":"2026-09-22","modalities":{"input":["text","image","pdf"],"output":["text"]},"open_weights":false,"limit":{"context":1000000,"output":128000},"cost":{"input":4,"output":20,"cache_read":0.2,"cache_write":5},"canonical_model_id":"anthropic/claude-opus-5-5"},"claude-haiku-4-5":{"id":"claude-haiku-4-5","name":"Claude Haiku 4.5 (latest)","family":"claude-haiku","attachment":true,"reasoning":true,"reasoning_options":[{"type":"budget_tokens","min":1024}],"tool_call":true,"structured_output":true,"temperature":true,"knowledge":"2025-02-28","release_date":"2025-10-15","last_updated":"2025-10-15","modalities":{"input":["text","image","pdf"],"output":["text"]},"open_weights":false,"limit":{"context":200000,"output":64000},"cost":{"input":1,"output":5,"cache_read":0.1,"cache_write":1.25},"canonical_model_id":"anthropic/claude-haiku-4-5"}}
},
"opencode":{
"id":"opencode",
"env":["OPENCODE_API_KEY"],
"npm":"@ai-sdk/openai-compatible",
"api":"https://opencode.ai/zen/v1",
"name":"OpenCode Zen",
"doc":"https://opencode.ai/docs/zen",
"models":{"gpt-6-sol":{"id":"gpt-6-sol","name":"GPT-6 Sol","family":"gpt-sol","attachment":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["none","low","medium","high","xhigh","max"]}],"tool_call":true,"structured_output":true,"temperature":false,"knowledge":"2026-04-20","release_date":"2026-09-22","last_updated":"2026-09-22","modalities":{"input":["text","image","pdf"],"output":["text"]},"open_weights":false,"limit":{"context":1050000,"input":922000,"output":128000},"provider":{"npm":"@ai-sdk/openai"},"cost":{"input":2,"output":10,"cache_read":0.2,"cache_write":2.5},"canonical_model_id":"openai/gpt-6-sol"},"claude-opus-5-5":{"id":"claude-opus-5-5","name":"Claude Opus 5.5","family":"claude-opus","attachment":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["low","medium","high","xhigh","max"]}],"tool_call":true,"temperature":false,"knowledge":"2026-06","release_date":"2026-09-22","last_updated":"2026-09-22","modalities":{"input":["text","image","pdf"],"output":["text"]},"open_weights":false,"limit":{"context":1000000,"output":128000},"provider":{"npm":"@ai-sdk/anthropic"},"cost":{"input":4,"output":20,"cache_read":0.2,"cache_write":5},"canonical_model_id":"anthropic/claude-opus-5-5"}}
},
"opencode-go":{
"id":"opencode-go",
"env":["OPENCODE_API_KEY"],
"npm":"@ai-sdk/openai-compatible",
"api":"https://opencode.ai/zen/go/v1",
"name":"OpenCode Go",
"doc":"https://opencode.ai/docs/go",
"models":{"gpt-6-luna":{"id":"gpt-6-luna","name":"GPT-6 Luna","family":"gpt-luna","attachment":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["none","low","medium","high","xhigh","max"]}],"tool_call":true,"structured_output":true,"temperature":false,"knowledge":"2026-05-18","release_date":"2026-09-22","last_updated":"2026-09-22","modalities":{"input":["text","image","pdf"],"output":["text"]},"open_weights":false,"limit":{"context":1050000,"input":922000,"output":128000},"provider":{"npm":"@ai-sdk/openai"},"cost":{"input":0.1,"output":0.5,"cache_read":0.01,"cache_write":0.125},"canonical_model_id":"openai/gpt-6-luna"},"kimi-k3":{"id":"kimi-k3","name":"Kimi K3","family":"kimi-k3","attachment":true,"reasoning":true,"reasoning_options":[{"type":"effort","values":["max"]}],"tool_call":true,"interleaved":{"field":"reasoning_content"},"structured_output":true,"temperature":false,"release_date":"2026-07-16","last_updated":"2026-07-16","modalities":{"input":["text","image","video"],"output":["text"]},"open_weights":true,"limit":{"context":1048576,"output":131072},"cost":{"input":3,"output":15,"cache_read":0.3},"canonical_model_id":"moonshotai/kimi-k3"}}
}
}
````

Create `test/fixtures/sources/openrouter-endpoints.json`:

````json
{
"openai/gpt-6-sol":{
"data":{"id":"openai/gpt-6-sol","name":"OpenAI: GPT-6 Sol","created":1790100775,"architecture":{"tokenizer":"GPT","instruct_type":null,"modality":"text+image+file->text","input_modalities":["file","image","text"],"output_modalities":["text"]},"endpoints":[{"name":"OpenAI | openai/gpt-6-sol-20260922","model_id":"openai/gpt-6-sol","model_name":"OpenAI: GPT-6 Sol","context_length":1050000,"pricing":{"prompt":"0.000001","completion":"0.000005","web_search":"0.01","input_cache_read":"0.0000001","input_cache_write":"0.00000125","discount":0,"overrides":[{"min_prompt_tokens":272000,"prompt":"0.000002","completion":"0.0000075","input_cache_read":"0.0000002","input_cache_write":"0.0000025"}]},"provider_name":"OpenAI","tag":"openai/flex","quantization":"unknown","max_completion_tokens":128000,"max_prompt_tokens":922000,"status":0,"uptime_last_30m":99.87737584304108,"uptime_last_5m":100,"uptime_last_1d":99.98343517632334,"latency_last_30m":null,"throughput_last_30m":null},{"name":"OpenAI | openai/gpt-6-sol-20260922","model_id":"openai/gpt-6-sol","model_name":"OpenAI: GPT-6 Sol","context_length":1050000,"pricing":{"prompt":"0.000002","completion":"0.00001","web_search":"0.01","input_cache_read":"0.0000002","input_cache_write":"0.0000025","discount":0,"overrides":[{"min_prompt_tokens":272000,"prompt":"0.000004","completion":"0.000015","input_cache_read":"0.0000004","input_cache_write":"0.000005"}]},"provider_name":"OpenAI","tag":"openai","quantization":"unknown","max_completion_tokens":128000,"max_prompt_tokens":922000,"status":0,"uptime_last_30m":99.97978535724786,"uptime_last_5m":99.95243380371016,"uptime_last_1d":99.96879470862275,"latency_last_30m":null,"throughput_last_30m":null}]}
},
"anthropic/claude-opus-5.5":{
"data":{"id":"anthropic/claude-opus-5.5","name":"Anthropic: Claude Opus 5.5","created":1790094732,"architecture":{"tokenizer":"Claude","instruct_type":null,"modality":"text+image+file->text","input_modalities":["text","image","file"],"output_modalities":["text"]},"endpoints":[{"name":"Amazon Bedrock | anthropic/claude-opus-5.5-20260921","model_id":"anthropic/claude-opus-5.5","model_name":"Anthropic: Claude Opus 5.5","context_length":1000000,"pricing":{"prompt":"0.000004","completion":"0.00002","web_search":"0.01","input_cache_read":"0.0000002","input_cache_write":"0.000005","input_cache_write_1h":"0.000008","discount":0},"provider_name":"Amazon Bedrock","tag":"amazon-bedrock","quantization":"unknown","max_completion_tokens":128000,"max_prompt_tokens":null,"status":-2,"uptime_last_30m":82.33502538071066,"uptime_last_5m":95.41751527494908,"uptime_last_1d":97.40418623722012,"latency_last_30m":null,"throughput_last_30m":null},{"name":"Azure | anthropic/claude-opus-5.5-20260921","model_id":"anthropic/claude-opus-5.5","model_name":"Anthropic: Claude Opus 5.5","context_length":1000000,"pricing":{"prompt":"0.000004","completion":"0.00002","web_search":"0.01","input_cache_read":"0.0000002","input_cache_write":"0.000005","input_cache_write_1h":"0.000008","discount":0},"provider_name":"Azure","tag":"azure/global","quantization":"unknown","max_completion_tokens":128000,"max_prompt_tokens":null,"status":0,"uptime_last_30m":100,"uptime_last_5m":100,"uptime_last_1d":99.98216979838158,"latency_last_30m":null,"throughput_last_30m":null}]}
}
}
````

Create `test/fixtures/sources/openrouter-models.json`:

````json
{
"data":[
{"id":"openai/gpt-6-luna","canonical_slug":"openai/gpt-6-luna-20260922","name":"OpenAI: GPT-6 Luna","created":1790100786,"context_length":1050000,"pricing":{"prompt":"0.0000001","completion":"0.0000005","web_search":"0.01","input_cache_read":"0.00000001","input_cache_write":"0.000000125","overrides":[{"min_prompt_tokens":272000,"prompt":"0.0000002","completion":"0.00000075","input_cache_read":"0.00000002","input_cache_write":"0.00000025"}]},"top_provider":{"context_length":1050000,"max_completion_tokens":128000,"is_moderated":true},"reasoning":{"mandatory":false,"default_enabled":true,"supported_efforts":["max","xhigh","high","medium","low","none"],"default_effort":"medium"}},
{"id":"openai/gpt-6-sol-pro","canonical_slug":"openai/gpt-6-sol-pro-20260922","name":"OpenAI: GPT-6 Sol Pro","created":1790100781,"context_length":1050000,"pricing":{"prompt":"0.000002","completion":"0.00001","web_search":"0.01","input_cache_read":"0.0000002","input_cache_write":"0.0000025","overrides":[{"min_prompt_tokens":272000,"prompt":"0.000004","completion":"0.000015","input_cache_read":"0.0000004","input_cache_write":"0.000005"}]},"top_provider":{"context_length":1050000,"max_completion_tokens":128000,"is_moderated":true},"reasoning":{"mandatory":false,"default_enabled":true,"supported_efforts":["max","xhigh","high","medium","low","none"],"default_effort":"medium"}},
{"id":"openai/gpt-6-sol","canonical_slug":"openai/gpt-6-sol-20260922","name":"OpenAI: GPT-6 Sol","created":1790100775,"context_length":1050000,"pricing":{"prompt":"0.000002","completion":"0.00001","web_search":"0.01","input_cache_read":"0.0000002","input_cache_write":"0.0000025","overrides":[{"min_prompt_tokens":272000,"prompt":"0.000004","completion":"0.000015","input_cache_read":"0.0000004","input_cache_write":"0.000005"}]},"top_provider":{"context_length":1050000,"max_completion_tokens":128000,"is_moderated":true},"reasoning":{"mandatory":false,"default_enabled":true,"supported_efforts":["max","xhigh","high","medium","low","none"],"default_effort":"medium"}},
{"id":"openai/gpt-6-sol:batch","canonical_slug":"openai/gpt-6-sol-20260922","name":"OpenAI: GPT-6 Sol (batch)","created":1790100775,"context_length":1050000,"pricing":{"prompt":"0.000001","completion":"0.000005","web_search":"0.01","input_cache_read":"0.0000001","input_cache_write":"0.00000125","overrides":[{"min_prompt_tokens":272000,"prompt":"0.000002","completion":"0.0000075","input_cache_read":"0.0000002","input_cache_write":"0.0000025"}]},"top_provider":{"context_length":1050000,"max_completion_tokens":128000,"is_moderated":true},"reasoning":{"mandatory":false,"default_enabled":true,"supported_efforts":["max","xhigh","high","medium","low","none"],"default_effort":"medium"}},
{"id":"anthropic/claude-opus-5.5","canonical_slug":"anthropic/claude-opus-5.5-20260921","name":"Anthropic: Claude Opus 5.5","created":1790094732,"context_length":1000000,"pricing":{"prompt":"0.000004","completion":"0.00002","web_search":"0.01","input_cache_read":"0.0000002","input_cache_write":"0.000005","input_cache_write_1h":"0.000008"},"top_provider":{"context_length":1000000,"max_completion_tokens":128000,"is_moderated":true},"reasoning":{"mandatory":true,"supported_efforts":["max","xhigh","high","medium","low"],"default_effort":"high"}},
{"id":"anthropic/claude-haiku-4.5","canonical_slug":"anthropic/claude-4.5-haiku-20251001","name":"Anthropic: Claude Haiku 4.5","created":1760547638,"context_length":200000,"pricing":{"prompt":"0.000001","completion":"0.000005","web_search":"0.01","input_cache_read":"0.0000001","input_cache_write":"0.00000125","input_cache_write_1h":"0.000002"},"top_provider":{"context_length":200000,"max_completion_tokens":64000,"is_moderated":true},"reasoning":{"mandatory":false}}
]
}
````

- [ ] **Step 2: Write the failing tests**

Create `test/infra/sources/facts.test.ts`:

````ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LITELLM_URL, parseLiteLlm } from "../../../src/infra/sources/litellm.ts";
import { MODELS_DEV_URL, modelsDevFacts } from "../../../src/infra/sources/models-dev.ts";
import {
  fetchOpenRouterEndpoints,
  openRouterEndpointsUrl,
  parseOpenRouterEndpoints,
} from "../../../src/infra/sources/openrouter-endpoints.ts";
import {
  OPENROUTER_MODELS_URL,
  parseOpenRouterModels,
  perMillion,
} from "../../../src/infra/sources/openrouter-models.ts";
import { fakeFetch } from "../../fake-fetch.ts";

const FX = join(import.meta.dir, "..", "..", "fixtures", "sources");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FX, name), "utf8"));
const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), random: () => 0.5 };
};

describe("models.dev (spec 1.2 §3.1, §3.5)", () => {
  it("reads a model's efforts, limits, price, tool calling, image input and release date", () => {
    expect(MODELS_DEV_URL).toBe("https://models.dev/api.json");
    expect(modelsDevFacts(fixture("models-dev.json"), "openai", "gpt-6-sol")).toEqual({
      efforts: ["none", "low", "medium", "high", "xhigh", "max"],
      context: 1050000,
      output: 128000,
      price: { input: 2, cached: 0.2, output: 10 },
      toolUse: true,
      imageIn: true,
      reasoning: true,
      releaseDate: "2026-09-22",
    });
    expect(modelsDevFacts(fixture("models-dev.json"), "opencode-go", "kimi-k3")?.efforts).toEqual(["max"]);
  });

  it("has no effort list for a model priced by thinking budget, and nothing for an absent model", () => {
    const raw = fixture("models-dev.json");
    expect(modelsDevFacts(raw, "anthropic", "claude-haiku-4-5")?.efforts).toBeNull();
    expect(modelsDevFacts(raw, "anthropic", "claude-nope")).toBeNull();
    expect(modelsDevFacts(raw, "nope", "gpt-6-sol")).toBeNull();
    expect(modelsDevFacts(null, "openai", "gpt-6-sol")).toBeNull();
  });
});

describe("OpenRouter models (spec 1.2 §3.1)", () => {
  it("reads id, context, price per million tokens and efforts, variants included", () => {
    expect(OPENROUTER_MODELS_URL).toBe("https://openrouter.ai/api/v1/models");
    const models = parseOpenRouterModels(fixture("openrouter-models.json"));
    expect(models.map((m) => m.id).sort()).toEqual([
      "anthropic/claude-haiku-4.5",
      "anthropic/claude-opus-5.5",
      "openai/gpt-6-luna",
      "openai/gpt-6-sol",
      "openai/gpt-6-sol-pro",
      "openai/gpt-6-sol:batch",
    ]);
    expect(models.find((m) => m.id === "openai/gpt-6-sol")).toEqual({
      id: "openai/gpt-6-sol",
      context: 1050000,
      price: { input: 2, output: 10, cached: 0.2 },
      efforts: ["max", "xhigh", "high", "medium", "low", "none"],
      defaultEffort: "medium",
    });
    expect(parseOpenRouterModels({ data: [{ nope: 1 }] })).toEqual([]);
    expect(parseOpenRouterModels("x")).toEqual([]);
    expect(perMillion("0.0000025")).toBe(2.5);
  });
});

describe("OpenRouter endpoints (spec 1.2 §3.1, plan 13 R-H)", () => {
  it("fetches one answer per id, leaving out an id OpenRouter no longer knows", async () => {
    const f = fakeFetch({ status: 200, body: { data: { endpoints: [] } } }, { status: 404, body: {} });
    const got = await fetchOpenRouterEndpoints(["openai/gpt-6-sol", "openai/gone"], {
      fetchImpl: f.impl,
      ...clock(),
    });
    expect(f.sent.map((s) => s.url)).toEqual([
      openRouterEndpointsUrl("openai/gpt-6-sol"),
      openRouterEndpointsUrl("openai/gone"),
    ]);
    expect(Object.keys(got)).toEqual(["openai/gpt-6-sol"]);
    expect(openRouterEndpointsUrl("openai/gpt-6-sol")).toBe(
      "https://openrouter.ai/api/v1/models/openai/gpt-6-sol/endpoints",
    );
  });

  it("fails the source, naming the id, on any other failure", async () => {
    const f = fakeFetch({ status: 401, body: {} });
    const e = await fetchOpenRouterEndpoints(["openai/gpt-6-sol"], { fetchImpl: f.impl, ...clock() }).catch(
      (x) => x,
    );
    expect(e.message).toBe("openai/gpt-6-sol: http 401");
  });

  it("gives each id the median over its endpoints of each statistic they report", () => {
    const rows = parseOpenRouterEndpoints(
      fixture("openrouter-endpoints.json") as Record<string, unknown>,
      "2026-09-28T10:00:00.000Z",
    );
    // latency and throughput were null on every endpoint that day: no row, never a zero
    expect(rows.map((r) => [r.rung, r.field])).toEqual([
      ["openai/gpt-6-sol", "uptime_last_30m"],
      ["anthropic/claude-opus-5.5", "uptime_last_30m"],
    ]);
    expect(rows[0]?.value).toBeCloseTo((99.87737584304108 + 99.97978535724786) / 2, 9);
    expect(rows[0]).toMatchObject({ date: "2026-09-28", url: "https://openrouter.ai/openai/gpt-6-sol" });
    const synthetic = {
      "openai/gpt-6-sol": {
        data: {
          endpoints: [{ latency_last_30m: { p50: 400 }, throughput_last_30m: 60 }, { latency_last_30m: 600 }],
        },
      },
    };
    expect(
      parseOpenRouterEndpoints(synthetic, "2026-09-28T10:00:00.000Z").map((r) => [r.field, r.value]),
    ).toEqual([
      ["latency_last_30m", 500],
      ["throughput_last_30m", 60],
    ]);
  });
});

describe("LiteLLM (spec 1.2 §3.1)", () => {
  it("reads the first-party entries' price, context and effort flags", () => {
    expect(LITELLM_URL).toBe(
      "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
    );
    const models = parseLiteLlm(fixture("litellm.json"));
    expect(models.map((m) => m.id)).toEqual([
      "gpt-6-sol",
      "gpt-6-luna",
      "claude-opus-5-5",
      "claude-haiku-4-5",
    ]);
    expect(models[0]).toEqual({
      id: "gpt-6-sol",
      provider: "openai",
      price: { input: 2, output: 10, cached: 0.2 },
      context: 922000,
      efforts: { none: true, minimal: false, xhigh: true, max: true },
    });
    expect(models[3]?.efforts).toEqual({});
    expect(parseLiteLlm(null)).toEqual([]);
  });
});
````

- [ ] **Step 3: Run them and see them fail**

Run: `bun test test/infra/sources/facts.test.ts`
Expected: FAIL: `Cannot find module "../../../src/infra/sources/litellm.ts"`.

- [ ] **Step 4: Implement**

Create `src/infra/sources/litellm.ts`:

````ts
import { z } from "zod";
import { type SourceTransport, sourceGet } from "./http.ts";
import { perMillion } from "./openrouter-models.ts";
import { num } from "./rows.ts";

/** Spec 1.2 §3.1: price and effort support, a cross-check only (MIT). */
export const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export const fetchLiteLlm = async (t: SourceTransport = {}): Promise<unknown> =>
  (await sourceGet(LITELLM_URL, t)).json();

/** The efforts LiteLLM flags per model (`supports_<effort>_reasoning_effort`). */
export const LITELLM_EFFORTS = ["none", "minimal", "low", "xhigh", "max"] as const;

export interface LiteLlmModel {
  id: string;
  provider: string;
  /** dollars per million tokens */
  price: { input: number; output: number; cached: number | null } | null;
  context: number | null;
  /** effort → whether LiteLLM says the model supports it; absent when it does not say */
  efforts: Partial<Record<(typeof LITELLM_EFFORTS)[number], boolean>>;
}

/** Spec 1.2 §3.5: the vendors' own APIs, whose prices the catalog's are. */
const FIRST_PARTY = new Set(["openai", "anthropic"]);

const EntrySchema = z.looseObject({ litellm_provider: z.string() });

/** The first-party entries of LiteLLM's price file: an OpenAI or Anthropic provider, a key with no `/`. */
export function parseLiteLlm(raw: unknown): LiteLlmModel[] {
  if (!raw || typeof raw !== "object") return [];
  const out: LiteLlmModel[] = [];
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const e = EntrySchema.safeParse(v);
    if (!e.success || !FIRST_PARTY.has(e.data.litellm_provider) || id.includes("/")) continue;
    const entry = e.data as Record<string, unknown>;
    const input = perMillion(entry.input_cost_per_token);
    const output = perMillion(entry.output_cost_per_token);
    const efforts: LiteLlmModel["efforts"] = {};
    for (const effort of LITELLM_EFFORTS) {
      const flag = entry[`supports_${effort}_reasoning_effort`];
      if (typeof flag === "boolean") efforts[effort] = flag;
    }
    out.push({
      id,
      provider: e.data.litellm_provider,
      price:
        input !== null && output !== null
          ? { input, output, cached: perMillion(entry.cache_read_input_token_cost) }
          : null,
      context: num(entry.max_input_tokens),
      efforts,
    });
  }
  return out;
}
````

Create `src/infra/sources/models-dev.ts`:

````ts
import { z } from "zod";
import { type SourceTransport, sourceGet } from "./http.ts";
import { num } from "./rows.ts";

/** Spec 1.2 §3.1: efforts, context, output limit, price, tool calling, modalities, release date (MIT). */
export const MODELS_DEV_URL = "https://models.dev/api.json";

export const fetchModelsDev = async (t: SourceTransport = {}): Promise<unknown> =>
  (await sourceGet(MODELS_DEV_URL, t)).json();

/** What catherd reads of one models.dev model; each field null when the source does not say. */
export interface ModelFacts {
  efforts: string[] | null;
  context: number | null;
  output: number | null;
  /** dollars per million tokens */
  price: { input: number; cached: number; output: number } | null;
  toolUse: boolean | null;
  imageIn: boolean | null;
  reasoning: boolean | null;
  releaseDate: string | null;
}

const ModelSchema = z.looseObject({
  reasoning: z.boolean().optional(),
  reasoning_options: z
    .array(z.looseObject({ type: z.string(), values: z.array(z.string()).optional() }))
    .optional(),
  tool_call: z.boolean().optional(),
  release_date: z.string().optional(),
  modalities: z.looseObject({ input: z.array(z.string()).optional() }).optional(),
  limit: z.looseObject({ context: z.unknown(), output: z.unknown() }).optional(),
  cost: z.looseObject({ input: z.unknown(), output: z.unknown(), cache_read: z.unknown() }).optional(),
});

/**
 * Spec 1.2 §3.5: `provider`'s model `id` in models.dev's api.json (a provider id such as `openai` or
 * `opencode-go`, and the model id within it); null when absent or unreadable.
 */
export function modelsDevFacts(raw: unknown, provider: string, id: string): ModelFacts | null {
  const p = (raw as Record<string, { models?: Record<string, unknown> }> | null)?.[provider];
  const parsed = ModelSchema.safeParse(p?.models?.[id]);
  if (!parsed.success) return null;
  const m = parsed.data;
  const efforts = m.reasoning_options?.find((o) => o.type === "effort")?.values ?? null;
  const input = num(m.cost?.input);
  const output = num(m.cost?.output);
  return {
    efforts,
    context: num(m.limit?.context),
    output: num(m.limit?.output),
    price:
      input !== null && output !== null ? { input, cached: num(m.cost?.cache_read) ?? input, output } : null,
    toolUse: m.tool_call ?? null,
    imageIn: m.modalities?.input ? m.modalities.input.includes("image") : null,
    reasoning: m.reasoning ?? null,
    releaseDate: m.release_date ?? null,
  };
}
````

Create `src/infra/sources/openrouter-endpoints.ts`:

````ts
import { median } from "../../domain/util.ts";
import { SourceError, type SourceTransport, sourceGet } from "./http.ts";
import { isoDay, num, type SourceRow } from "./rows.ts";

/** Spec 1.2 §3.1: per provider, uptime, latency and throughput over the last 30 minutes. */
export const openRouterEndpointsUrl = (id: string): string =>
  `https://openrouter.ai/api/v1/models/${id}/endpoints`;

/**
 * Plan 13 R-H: one request per OpenRouter id (one per catalog family OpenRouter lists), in parallel. An id
 * OpenRouter no longer knows (404) is left out; any other failure fails the source, which keeps its last answer.
 */
export async function fetchOpenRouterEndpoints(
  ids: readonly string[],
  t: SourceTransport = {},
): Promise<Record<string, unknown>> {
  const got = await Promise.all(
    ids.map(async (id) => {
      try {
        return [id, (await sourceGet(openRouterEndpointsUrl(id), t)).json()] as const;
      } catch (e) {
        if (e instanceof SourceError && e.status === 404) return null;
        throw e instanceof SourceError ? new SourceError(`${id}: ${e.message}`, e.status, e.headers) : e;
      }
    }),
  );
  return Object.fromEntries(got.filter((x) => x !== null));
}

export const ENDPOINT_FIELDS = ["latency_last_30m", "throughput_last_30m", "uptime_last_30m"] as const;

/** A statistic as a number, or as a percentile object (`{ p50: … }`) some answers carry. */
const stat = (v: unknown): number | null =>
  v !== null && typeof v === "object" ? num((v as { p50?: unknown }).p50) : num(v);

/** One row per OpenRouter id and field: the median over its endpoints that report the field. */
export function parseOpenRouterEndpoints(raw: Record<string, unknown>, fetchedAt: string): SourceRow[] {
  const rows: SourceRow[] = [];
  for (const [id, answer] of Object.entries(raw)) {
    const endpoints = (answer as { data?: { endpoints?: unknown[] } } | null)?.data?.endpoints;
    if (!Array.isArray(endpoints)) continue;
    for (const field of ENDPOINT_FIELDS) {
      const xs = endpoints
        .map((e) => stat((e as Record<string, unknown> | null)?.[field]))
        .filter((x): x is number => x !== null);
      const value = median(xs);
      if (value !== null)
        rows.push({ rung: id, field, value, date: isoDay(fetchedAt), url: `https://openrouter.ai/${id}` });
    }
  }
  return rows;
}
````

Create `src/infra/sources/openrouter-models.ts`:

````ts
import { z } from "zod";
import { type SourceTransport, sourceGet } from "./http.ts";
import { num } from "./rows.ts";

/** Spec 1.2 §3.1: price and context cross-check; a model appears here the day it ships. */
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export const fetchOpenRouterModels = async (t: SourceTransport = {}): Promise<unknown> =>
  (await sourceGet(OPENROUTER_MODELS_URL, t)).json();

export interface OpenRouterModel {
  /** `author/slug`, as the endpoints path takes it */
  id: string;
  context: number | null;
  /** dollars per million tokens */
  price: { input: number; output: number; cached: number | null } | null;
  efforts: string[] | null;
  defaultEffort: string | null;
}

const ModelSchema = z.looseObject({
  id: z.string(),
  context_length: z.unknown(),
  pricing: z
    .looseObject({ prompt: z.unknown(), completion: z.unknown(), input_cache_read: z.unknown() })
    .optional(),
  reasoning: z
    .looseObject({ supported_efforts: z.array(z.string()).optional(), default_effort: z.string().optional() })
    .optional(),
});

/** A per-token price (a number or decimal string) per million tokens, without float noise (0.000002 × 1e6). */
export const perMillion = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n * 1e12) / 1e6;
};

/** Every model of OpenRouter's `/models` answer; a malformed entry is skipped. */
export function parseOpenRouterModels(raw: unknown): OpenRouterModel[] {
  const data = (raw as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: OpenRouterModel[] = [];
  for (const entry of data) {
    const m = ModelSchema.safeParse(entry);
    if (!m.success) continue;
    const input = perMillion(m.data.pricing?.prompt);
    const output = perMillion(m.data.pricing?.completion);
    out.push({
      id: m.data.id,
      context: num(m.data.context_length),
      price:
        input !== null && output !== null
          ? { input, output, cached: perMillion(m.data.pricing?.input_cache_read) }
          : null,
      efforts: m.data.reasoning?.supported_efforts ?? null,
      defaultEffort: m.data.reasoning?.default_effort ?? null,
    });
  }
  return out;
}
````

- [ ] **Step 5: Run the tests and the checks**

Run: `bun run format && bun test test/infra/sources/facts.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

````bash
git add src/infra/sources/litellm.ts src/infra/sources/models-dev.ts src/infra/sources/openrouter-endpoints.ts src/infra/sources/openrouter-models.ts test/fixtures/sources/litellm.json test/fixtures/sources/models-dev.json test/fixtures/sources/openrouter-endpoints.json test/fixtures/sources/openrouter-models.json test/infra/sources/facts.test.ts
git commit -m "feat(sources): models.dev, OpenRouter and LiteLLM fetchers and parsers"
````

---

### Task 6: Arena and Vectara (spec 1.2 §3.1, §3.4; Ruling 4; R-D)

The score sources whose rows are Arena's six boards and Vectara's README table. Needs Tasks 2 and 4.

**Files:**
- Create: `src/infra/sources/arena.ts`
- Create: `src/infra/sources/vectara.ts`
- Create: `test/fixtures/sources/arena-agent.json`
- Create: `test/fixtures/sources/arena-agent_bash_recovery_steps.json`
- Create: `test/fixtures/sources/arena-agent_steerability.json`
- Create: `test/fixtures/sources/arena-agent_task_outcome_explicit.json`
- Create: `test/fixtures/sources/arena-agent_tool_hallucination.json`
- Create: `test/fixtures/sources/arena-webdev.json`
- Create: `test/fixtures/sources/vectara-README.md`
- Create: `test/infra/sources/scores.test.ts`

**Interfaces:**
- Consumes: `effortWord` (Task 2); `sourceGet`, `type SourceTransport` (Task 4); `isoDay`, `num`, `type SourceRow` (Task 4).
- Produces: `arena.ts`: `ARENA_CONFIGS`, `type ArenaConfig`, `ARENA_PAGE`, `arenaUrl(config)`, `fetchArena(t): Promise<Record<ArenaConfig, unknown>>`, `arenaRung(name): string`, `parseArena(raw, fetchedAt): SourceRow[]` (field = config; value = `score`, WebDev's `rating`). `vectara.ts`: `VECTARA_URL`, `VECTARA_PAGE`, `fetchVectara(t): Promise<string>`, `vectaraDate(markdown): string | null`, `parseVectara(markdown, fetchedAt): SourceRow[]` (fields `factual_consistency`, `hallucination_rate`).

- [ ] **Step 1: Add the fixtures**

Create `test/fixtures/sources/arena-agent.json`:

````json
{
"rows":[
{"row_idx":0,"row":{"model_name":"Claude Fable 5.1 (Max)","organization":"anthropic","license":"Proprietary","score":0.13839990014470238,"score_ci_lower":0.12083588775442125,"score_ci_upper":0.1559639125349835,"observation_count":1607622.0,"session_count":15034.0,"rank":1,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":1,"row":{"model_name":"Claude Opus 5.5 (High)","organization":"anthropic","license":"Proprietary","score":0.12152186656915857,"score_ci_lower":0.09829913777431899,"score_ci_upper":0.14474459536399814,"observation_count":601488.0,"session_count":4933.0,"rank":2,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":2,"row":{"model_name":"GPT 6 Astra (Max)","organization":"openai","license":"Proprietary","score":0.10310889661525366,"score_ci_lower":0.08020010331021185,"score_ci_upper":0.12601768992029547,"observation_count":856373.0,"session_count":11476.0,"rank":3,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":3,"row":{"model_name":"Claude Opus 5 (Max)","organization":"anthropic","license":"Proprietary","score":0.09578968030737584,"score_ci_lower":0.08123664077796418,"score_ci_upper":0.11034271983678749,"observation_count":2786102.0,"session_count":21746.0,"rank":4,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":4,"row":{"model_name":"Claude Opus 5 (High)","organization":"anthropic","license":"Proprietary","score":0.09467146855339552,"score_ci_lower":0.08120987217483433,"score_ci_upper":0.10813306493195671,"observation_count":3275096.0,"session_count":26740.0,"rank":5,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":5,"row":{"model_name":"GPT 6 Sol (Max)","organization":"openai","license":"Proprietary","score":0.08183729030802717,"score_ci_lower":0.05839882808280848,"score_ci_upper":0.10527575253324585,"observation_count":847109.0,"session_count":5251.0,"rank":6,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":8,"row":{"model_name":"GPT 5.6 Sol (xHigh)","organization":"openai","license":"Proprietary","score":0.062119153812473155,"score_ci_lower":0.049708932783384174,"score_ci_upper":0.07452937484156213,"observation_count":3873747.0,"session_count":34109.0,"rank":9,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":9,"row":{"model_name":"Claude Sonnet 5 (High)","organization":"anthropic","license":"Proprietary","score":0.04820715663394468,"score_ci_lower":0.03237023131577708,"score_ci_upper":0.06404408195211228,"observation_count":3335748.0,"session_count":31574.0,"rank":10,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":13,"row":{"model_name":"Kimi K3 (Max)","organization":"moonshot","license":"Kimi K3 license","score":0.042383834838122685,"score_ci_lower":0.03708187113222013,"score_ci_upper":0.047685798544025236,"observation_count":11064160.0,"session_count":129565.0,"rank":14,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":14,"row":{"model_name":"Gemini 3.8 Flash (High)","organization":"google","license":"Proprietary","score":0.04074286209009309,"score_ci_lower":0.031933028652799414,"score_ci_upper":0.04955269552738677,"observation_count":3574279.0,"session_count":32496.0,"rank":15,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":24,"row":{"model_name":"GPT 5.6 Terra (xHigh)","organization":"openai","license":"Proprietary","score":0.007096287361366728,"score_ci_lower":-0.0038151542397505556,"score_ci_upper":0.01800772896248401,"observation_count":1401901.0,"session_count":22169.0,"rank":25,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":27,"row":{"model_name":"GPT 5.6 Luna (xHigh)","organization":"openai","license":"Proprietary","score":-0.007503749892856182,"score_ci_lower":-0.014284935471160436,"score_ci_upper":-0.000722564314551929,"observation_count":3421380.0,"session_count":40442.0,"rank":28,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]}
],
"num_rows_total":45,
"num_rows_per_page":100,
"partial":false
}
````

Create `test/fixtures/sources/arena-agent_bash_recovery_steps.json`:

````json
{
"rows":[
{"row_idx":0,"row":{"model_name":"Claude Opus 5 (Max)","organization":"anthropic","license":"Proprietary","score":0.12650536489414965,"score_ci_lower":0.11859018503044993,"score_ci_upper":0.13442054475784937,"observation_count":57491.0,"session_count":null,"rank":1,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":1,"row":{"model_name":"Claude Opus 5 (High)","organization":"anthropic","license":"Proprietary","score":0.11769920683208657,"score_ci_lower":0.11016712853425364,"score_ci_upper":0.1252312851299195,"observation_count":74101.0,"session_count":null,"rank":2,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":2,"row":{"model_name":"Claude Fable 5.1 (Max)","organization":"anthropic","license":"Proprietary","score":0.11732205484424973,"score_ci_lower":0.10887482275161729,"score_ci_upper":0.12576928693688216,"observation_count":34158.0,"session_count":null,"rank":3,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":3,"row":{"model_name":"Claude Opus 5.5 (High)","organization":"anthropic","license":"Proprietary","score":0.10643321410205542,"score_ci_lower":0.09315874600083486,"score_ci_upper":0.11970768220327598,"observation_count":13519.0,"session_count":null,"rank":4,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":6,"row":{"model_name":"GPT 6 Sol (Max)","organization":"openai","license":"Proprietary","score":0.0810506173969412,"score_ci_lower":0.06311562126775247,"score_ci_upper":0.09898561352612992,"observation_count":17497.0,"session_count":null,"rank":7,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":8,"row":{"model_name":"Claude Sonnet 5 (High)","organization":"anthropic","license":"Proprietary","score":0.06511154694118138,"score_ci_lower":0.054666800449825824,"score_ci_upper":0.07555629343253692,"observation_count":121034.0,"session_count":null,"rank":9,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":10,"row":{"model_name":"GPT 6 Astra (Max)","organization":"openai","license":"Proprietary","score":0.06199654732672122,"score_ci_lower":0.04902838518845601,"score_ci_upper":0.07496470946498643,"observation_count":23134.0,"session_count":null,"rank":11,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":20,"row":{"model_name":"Kimi K3 (Max)","organization":"moonshot","license":"Kimi K3 license","score":0.040530744378348915,"score_ci_lower":0.03565605419093255,"score_ci_upper":0.04540543456576528,"observation_count":311464.0,"session_count":null,"rank":21,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":23,"row":{"model_name":"GPT 5.6 Sol (xHigh)","organization":"openai","license":"Proprietary","score":0.02632380199263462,"score_ci_lower":0.0157075277797067,"score_ci_upper":0.03694007620556254,"observation_count":86049.0,"session_count":null,"rank":24,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":24,"row":{"model_name":"GPT 5.6 Terra (xHigh)","organization":"openai","license":"Proprietary","score":0.02386621111770304,"score_ci_lower":0.010829855216908092,"score_ci_upper":0.03690256701849799,"observation_count":42930.0,"session_count":null,"rank":25,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":26,"row":{"model_name":"GPT 5.6 Luna (xHigh)","organization":"openai","license":"Proprietary","score":0.021848765461454756,"score_ci_lower":0.013510229882302046,"score_ci_upper":0.030187301040607465,"observation_count":92102.0,"session_count":null,"rank":27,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":30,"row":{"model_name":"Gemini 3.8 Flash (High)","organization":"google","license":"Proprietary","score":0.0001792260127422285,"score_ci_lower":-0.005745153611468656,"score_ci_upper":0.006103605636953113,"observation_count":187146.0,"session_count":null,"rank":31,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]}
],
"num_rows_total":45,
"num_rows_per_page":100,
"partial":false
}
````

Create `test/fixtures/sources/arena-agent_steerability.json`:

````json
{
"rows":[
{"row_idx":0,"row":{"model_name":"Claude Opus 5.5 (High)","organization":"anthropic","license":"Proprietary","score":0.14497945317497501,"score_ci_lower":0.09700577439660366,"score_ci_upper":0.19295313195334637,"observation_count":2559.0,"session_count":null,"rank":1,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":1,"row":{"model_name":"GPT 6 Sol (Max)","organization":"openai","license":"Proprietary","score":0.13348947400253236,"score_ci_lower":0.08564426077130045,"score_ci_upper":0.18133468723376428,"observation_count":2354.0,"session_count":null,"rank":2,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":3,"row":{"model_name":"Claude Opus 5 (High)","organization":"anthropic","license":"Proprietary","score":0.10836585221771333,"score_ci_lower":0.08212573685203035,"score_ci_upper":0.13460596758339632,"observation_count":25563.0,"session_count":null,"rank":4,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":5,"row":{"model_name":"Claude Fable 5.1 (Max)","organization":"anthropic","license":"Proprietary","score":0.0831828979683999,"score_ci_lower":0.04570933250915208,"score_ci_upper":0.12065646342764771,"observation_count":6265.0,"session_count":null,"rank":6,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":6,"row":{"model_name":"Claude Opus 5 (Max)","organization":"anthropic","license":"Proprietary","score":0.08061076001157291,"score_ci_lower":0.05150645382263372,"score_ci_upper":0.1097150662005121,"observation_count":17597.0,"session_count":null,"rank":7,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":7,"row":{"model_name":"Claude Sonnet 5 (High)","organization":"anthropic","license":"Proprietary","score":0.07442675920794206,"score_ci_lower":0.04146661260860898,"score_ci_upper":0.10738690580727514,"observation_count":22464.0,"session_count":null,"rank":8,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":9,"row":{"model_name":"GPT 5.6 Sol (xHigh)","organization":"openai","license":"Proprietary","score":0.06559158625034178,"score_ci_lower":0.04152456426790141,"score_ci_upper":0.08965860823278216,"observation_count":30564.0,"session_count":null,"rank":10,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":10,"row":{"model_name":"Gemini 3.8 Flash (High)","organization":"google","license":"Proprietary","score":0.045156297612344354,"score_ci_lower":0.02591293699398882,"score_ci_upper":0.06439965823069989,"observation_count":19797.0,"session_count":null,"rank":11,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":12,"row":{"model_name":"GPT 5.6 Terra (xHigh)","organization":"openai","license":"Proprietary","score":0.042335123326595114,"score_ci_lower":0.02112317644489607,"score_ci_upper":0.06354707020829416,"observation_count":22807.0,"session_count":null,"rank":13,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":19,"row":{"model_name":"GPT 5.6 Luna (xHigh)","organization":"openai","license":"Proprietary","score":0.018491180056671386,"score_ci_lower":0.004362871593309366,"score_ci_upper":0.03261948852003341,"observation_count":38639.0,"session_count":null,"rank":20,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":24,"row":{"model_name":"Kimi K3 (Max)","organization":"moonshot","license":"Kimi K3 license","score":-0.004359005204819522,"score_ci_lower":-0.015646303779263106,"score_ci_upper":0.006928293369624064,"observation_count":109319.0,"session_count":null,"rank":25,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":29,"row":{"model_name":"GPT 6 Astra (Max)","organization":"openai","license":"Proprietary","score":-0.020955303844742756,"score_ci_lower":-0.07219679629310058,"score_ci_upper":0.030286188603615066,"observation_count":3768.0,"session_count":null,"rank":30,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]}
],
"num_rows_total":45,
"num_rows_per_page":100,
"partial":false
}
````

Create `test/fixtures/sources/arena-agent_task_outcome_explicit.json`:

````json
{
"rows":[
{"row_idx":0,"row":{"model_name":"Claude Fable 5.1 (Max)","organization":"anthropic","license":"Proprietary","score":0.1751407336889227,"score_ci_lower":0.1472377424250743,"score_ci_upper":0.20304372495277107,"observation_count":7753.0,"session_count":null,"rank":1,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":1,"row":{"model_name":"Claude Opus 5.5 (High)","organization":"anthropic","license":"Proprietary","score":0.15498022915458975,"score_ci_lower":0.11130867928392352,"score_ci_upper":0.198651779025256,"observation_count":2547.0,"session_count":null,"rank":2,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":2,"row":{"model_name":"GPT 6 Astra (Max)","organization":"openai","license":"Proprietary","score":0.12929446121165156,"score_ci_lower":0.09362694993679582,"score_ci_upper":0.1649619724865073,"observation_count":5924.0,"session_count":null,"rank":3,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":4,"row":{"model_name":"GPT 6 Sol (Max)","organization":"openai","license":"Proprietary","score":0.12037406528416139,"score_ci_lower":0.0778897491916973,"score_ci_upper":0.16285838137662548,"observation_count":2689.0,"session_count":null,"rank":5,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":6,"row":{"model_name":"Claude Opus 5 (Max)","organization":"anthropic","license":"Proprietary","score":0.10441403916792258,"score_ci_lower":0.07542477782279587,"score_ci_upper":0.13340330051304927,"observation_count":14912.0,"session_count":null,"rank":7,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":7,"row":{"model_name":"Gemini 3.8 Flash (High)","organization":"google","license":"Proprietary","score":0.09571310502330566,"score_ci_lower":0.07803553515286499,"score_ci_upper":0.11339067489374632,"observation_count":20566.0,"session_count":null,"rank":8,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":8,"row":{"model_name":"Kimi K3 (Max)","organization":"moonshot","license":"Kimi K3 license","score":0.09504405025872631,"score_ci_lower":0.08406046265410774,"score_ci_upper":0.10602763786334488,"observation_count":96237.0,"session_count":null,"rank":9,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":11,"row":{"model_name":"Claude Opus 5 (High)","organization":"anthropic","license":"Proprietary","score":0.07086987837982561,"score_ci_lower":0.042864546928585885,"score_ci_upper":0.09887520983106535,"observation_count":20191.0,"session_count":null,"rank":12,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":20,"row":{"model_name":"GPT 5.6 Sol (xHigh)","organization":"openai","license":"Proprietary","score":0.029173041158642388,"score_ci_lower":0.004085625225566894,"score_ci_upper":0.05426045709171788,"observation_count":26541.0,"session_count":null,"rank":21,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":22,"row":{"model_name":"Claude Sonnet 5 (High)","organization":"anthropic","license":"Proprietary","score":0.0071897880109327295,"score_ci_lower":-0.025646205711435673,"score_ci_upper":0.04002578173330113,"observation_count":21914.0,"session_count":null,"rank":23,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":30,"row":{"model_name":"GPT 5.6 Luna (xHigh)","organization":"openai","license":"Proprietary","score":-0.04204742576913667,"score_ci_lower":-0.0578936181709762,"score_ci_upper":-0.026201233367297138,"observation_count":30898.0,"session_count":null,"rank":31,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":33,"row":{"model_name":"GPT 5.6 Terra (xHigh)","organization":"openai","license":"Proprietary","score":-0.06161047196895264,"score_ci_lower":-0.0867179105684231,"score_ci_upper":-0.03650303336948219,"observation_count":17478.0,"session_count":null,"rank":34,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]}
],
"num_rows_total":45,
"num_rows_per_page":100,
"partial":false
}
````

Create `test/fixtures/sources/arena-agent_tool_hallucination.json`:

````json
{
"rows":[
{"row_idx":3,"row":{"model_name":"GPT 5.6 Sol (xHigh)","organization":"openai","license":"Proprietary","score":0.0035476967572378726,"score_ci_lower":0.0032698674159777714,"score_ci_upper":0.0038255260984979738,"observation_count":3721472.0,"session_count":null,"rank":4,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":6,"row":{"model_name":"GPT 5.6 Terra (xHigh)","organization":"openai","license":"Proprietary","score":0.003547696756726282,"score_ci_lower":0.003269867415466247,"score_ci_upper":0.0038255260979863166,"observation_count":1312131.0,"session_count":null,"rank":7,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":8,"row":{"model_name":"GPT 6 Astra (Max)","organization":"openai","license":"Proprietary","score":0.00354769675620048,"score_ci_lower":0.003269867414940504,"score_ci_upper":0.0038255260974604565,"observation_count":822018.0,"session_count":null,"rank":9,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":9,"row":{"model_name":"GPT 6 Sol (Max)","organization":"openai","license":"Proprietary","score":0.0035476967561436368,"score_ci_lower":0.0032698674148836826,"score_ci_upper":0.003825526097403591,"observation_count":823817.0,"session_count":null,"rank":10,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":10,"row":{"model_name":"GPT 5.6 Luna (xHigh)","organization":"openai","license":"Proprietary","score":0.0035476967560370554,"score_ci_lower":0.0032698674147771042,"score_ci_upper":0.0038255260972970065,"observation_count":3248318.0,"session_count":null,"rank":11,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":11,"row":{"model_name":"Kimi K3 (Max)","organization":"moonshot","license":"Kimi K3 license","score":0.0035476967559375794,"score_ci_lower":0.003269867414677625,"score_ci_upper":0.003825526097197534,"observation_count":10509498.0,"session_count":null,"rank":12,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":17,"row":{"model_name":"Claude Fable 5.1 (Max)","organization":"anthropic","license":"Proprietary","score":0.003483929737036817,"score_ci_lower":0.0031799444349747226,"score_ci_upper":0.003787915039098912,"observation_count":1557043.0,"session_count":null,"rank":18,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":19,"row":{"model_name":"Claude Opus 5 (Max)","organization":"anthropic","license":"Proprietary","score":0.0033900725953728283,"score_ci_lower":0.003081558522862051,"score_ci_upper":0.003698586667883606,"observation_count":2690337.0,"session_count":null,"rank":20,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":22,"row":{"model_name":"Claude Opus 5.5 (High)","organization":"anthropic","license":"Proprietary","score":0.0031980865584557705,"score_ci_lower":0.002659047499476644,"score_ci_upper":0.003737125617434897,"observation_count":582023.0,"session_count":null,"rank":23,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":23,"row":{"model_name":"Claude Opus 5 (High)","organization":"anthropic","license":"Proprietary","score":0.0031736940229620814,"score_ci_lower":0.0028592085194307786,"score_ci_upper":0.003488179526493384,"observation_count":3147261.0,"session_count":null,"rank":24,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":26,"row":{"model_name":"Gemini 3.8 Flash (High)","organization":"google","license":"Proprietary","score":0.002065228979937217,"score_ci_lower":0.0014036931325220716,"score_ci_upper":0.0027267648273523624,"observation_count":3339313.0,"session_count":null,"rank":27,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]},
{"row_idx":27,"row":{"model_name":"Claude Sonnet 5 (High)","organization":"anthropic","license":"Proprietary","score":0.0018323024046793535,"score_ci_lower":0.0008766578666804439,"score_ci_upper":0.002787946942678263,"observation_count":3163571.0,"session_count":null,"rank":28,"category":"overall","leaderboard_publish_date":"2026-09-27"},"truncated_cells":[]}
],
"num_rows_total":45,
"num_rows_per_page":100,
"partial":false
}
````

Create `test/fixtures/sources/arena-webdev.json`:

````json
{
"rows":[
{"row_idx":0,"row":{"model_name":"claude-opus-5.5-max","organization":"anthropic","license":"Proprietary","rating":1826.7306745084245,"rating_lower":1808.3764250901447,"rating_upper":1845.084923926704,"variance":87.69545306424777,"vote_count":1607,"rank":1,"category":"overall","leaderboard_publish_date":"2026-09-25"},"truncated_cells":[]},
{"row_idx":1,"row":{"model_name":"gpt-6-astra-max","organization":"openai","license":"Proprietary","rating":1791.6525596749589,"rating_lower":1780.285480927704,"rating_upper":1803.0196384222138,"variance":33.635784028252935,"vote_count":4908,"rank":2,"category":"overall","leaderboard_publish_date":"2026-09-25"},"truncated_cells":[]},
{"row_idx":2,"row":{"model_name":"claude-fable-5.1-max","organization":"anthropic","license":"Proprietary","rating":1751.4867509630722,"rating_lower":1741.1685748469208,"rating_upper":1761.8049270792237,"variance":27.7146686541031,"vote_count":5313,"rank":3,"category":"overall","leaderboard_publish_date":"2026-09-25"},"truncated_cells":[]},
{"row_idx":3,"row":{"model_name":"claude-opus-5-max","organization":"anthropic","license":"Proprietary","rating":1692.5373139199987,"rating_lower":1685.8757999805507,"rating_upper":1699.1988278594467,"variance":11.551801031006057,"vote_count":15627,"rank":4,"category":"overall","leaderboard_publish_date":"2026-09-25"},"truncated_cells":[]},
{"row_idx":4,"row":{"model_name":"gpt-6-sol-max","organization":"openai","license":"Proprietary","rating":1680.9724563881532,"rating_lower":1666.4681565732392,"rating_upper":1695.476756203067,"variance":54.76427652630693,"vote_count":2019,"rank":5,"category":"overall","leaderboard_publish_date":"2026-09-25"},"truncated_cells":[]},
{"row_idx":6,"row":{"model_name":"claude-opus-5-high","organization":"anthropic","license":"Proprietary","rating":1661.8817615282483,"rating_lower":1656.006509610279,"rating_upper":1667.7570134462176,"variance":8.985801152845546,"vote_count":18930,"rank":7,"category":"overall","leaderboard_publish_date":"2026-09-25"},"truncated_cells":[]},
{"row_idx":8,"row":{"model_name":"kimi-k3-max","organization":"moonshot","license":"Kimi K3 license","rating":1659.8729180873972,"rating_lower":1653.2878862830962,"rating_upper":1666.4579498916983,"variance":11.288066822442289,"vote_count":14739,"rank":9,"category":"overall","leaderboard_publish_date":"2026-09-25"},"truncated_cells":[]},
{"row_idx":14,"row":{"model_name":"muse-spark-1.3 (xHigh)","organization":"meta","license":"Proprietary","rating":1626.4699243598252,"rating_lower":1617.0171034637328,"rating_upper":1635.9227452559176,"variance":23.260908697559646,"vote_count":5043,"rank":15,"category":"overall","leaderboard_publish_date":"2026-09-25"},"truncated_cells":[]},
{"row_idx":17,"row":{"model_name":"glm-5.3-max","organization":"zai","license":"MIT","rating":1619.078984091177,"rating_lower":1610.366935198374,"rating_upper":1627.7910329839801,"variance":19.75806573838952,"vote_count":6410,"rank":18,"category":"overall","leaderboard_publish_date":"2026-09-25"},"truncated_cells":[]},
{"row_idx":19,"row":{"model_name":"gpt-5.6-sol-xhigh (codex-harness)","organization":"openai","license":"Proprietary","rating":1617.3524740259538,"rating_lower":1611.1603299626622,"rating_upper":1623.5446180892454,"variance":9.981272711815413,"vote_count":15764,"rank":20,"category":"overall","leaderboard_publish_date":"2026-09-25"},"truncated_cells":[]},
{"row_idx":23,"row":{"model_name":"gpt-6-luna-max","organization":"openai","license":"Proprietary","rating":1592.646721210178,"rating_lower":1578.1497290257992,"rating_upper":1607.1437133945565,"variance":54.709107191721024,"vote_count":1903,"rank":24,"category":"overall","leaderboard_publish_date":"2026-09-25"},"truncated_cells":[]},
{"row_idx":35,"row":{"model_name":"claude-sonnet-5-high","organization":"anthropic","license":"Proprietary","rating":1538.9131567383743,"rating_lower":1532.5359499315111,"rating_upper":1545.2903635452376,"variance":10.586802711099862,"vote_count":12862,"rank":36,"category":"overall","leaderboard_publish_date":"2026-09-25"},"truncated_cells":[]},
{"row_idx":41,"row":{"model_name":"gpt-5.6-terra-xhigh (codex-harness)","organization":"openai","license":"Proprietary","rating":1520.5492993967744,"rating_lower":1513.7580528811022,"rating_upper":1527.3405459124463,"variance":12.006123556022937,"vote_count":11194,"rank":42,"category":"overall","leaderboard_publish_date":"2026-09-25"},"truncated_cells":[]},
{"row_idx":42,"row":{"model_name":"gpt-5.6-luna-xhigh (codex-harness)","organization":"openai","license":"Proprietary","rating":1519.887506464861,"rating_lower":1513.2222108122658,"rating_upper":1526.5528021174562,"variance":11.564920570586182,"vote_count":11419,"rank":43,"category":"overall","leaderboard_publish_date":"2026-09-25"},"truncated_cells":[]}
],
"num_rows_total":568,
"num_rows_per_page":100,
"partial":false
}
````

Create `test/fixtures/sources/vectara-README.md`:

````markdown
# Hallucination Leaderboard

Public LLM leaderboard computed using Vectara's Hallucination Evaluation Model, also known as HHEM. This evaluates how often an LLM introduces hallucinations when summarizing a document. We plan to update this regularly as our model and the LLMs get updated over time.

Feel free to check out the [interactive hallucination leaderboard](https://huggingface.co/spaces/vectara/leaderboard) on Hugging Face. 

If you are interested in previous versions os this leaderboard:
1. First version based on HHEM-1.0, it is available [here](https://github.com/vectara/hallucination-leaderboard/tree/hhem-1.0-final)
2. Most recent version, based on the previous dataset is available [here](https://github.com/vectara/hallucination-leaderboard/tree/hhem-2.3-old-dataset)

<table style="border-collapse: collapse;">
  <tr>
    <td style="text-align: center; vertical-align: middle; border: none;">
      <img src="img/candle.png" width="50" height="50">
    </td>
    <td style="text-align: left; vertical-align: middle; border: none;">
      In loving memory of <a href="https://www.ivinsfuneralhome.com/obituaries/Simon-Mark-Hughes?obId=30000023">Simon Mark Hughes</a>...
    </td>
  </tr>
</table>

<!-- LEADERBOARD_START -->
Last updated on September 22, 2026

![Plot: hallucination rates of various LLMs](./img/top25_hallucination_rates_2026-09-22.png)

|Model|Hallucination Rate|Factual Consistency Rate|Answer Rate|Average Summary Length (Words)|
|----|----:|----:|----:|----:|
|antgroup/finix_s1_32b|1.8 %|98.2 %|99.5 %|172.4|
|openai/gpt-6-sol|6.5 %|93.5 %|100.0 %|71.4|
|google/gemini-2.5-pro|7.0 %|93.0 %|99.1 %|106.4|
|openai/gpt-6-astra|8.7 %|91.3 %|100.0 %|148.5|
|openai/gpt-5.5|9.3 %|90.7 %|100.0 %|129.6|
|anthropic/claude-haiku-4-5-20251001|9.8 %|90.2 %|99.5 %|115.1|

(the rest of the README is cut from this fixture)
````

- [ ] **Step 2: Write the failing tests**

Create `test/infra/sources/scores.test.ts`:

````ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARENA_CONFIGS,
  ARENA_PAGE,
  arenaRung,
  arenaUrl,
  fetchArena,
  parseArena,
} from "../../../src/infra/sources/arena.ts";
import { parseVectara, VECTARA_PAGE, VECTARA_URL, vectaraDate } from "../../../src/infra/sources/vectara.ts";
import { fakeFetch } from "../../fake-fetch.ts";

const FX = join(import.meta.dir, "..", "..", "fixtures", "sources");
const text = (name: string) => readFileSync(join(FX, name), "utf8");
const arenaFixture = () =>
  Object.fromEntries(ARENA_CONFIGS.map((c) => [c, JSON.parse(text(`arena-${c}.json`))]));
const AT = "2026-09-28T10:00:00.000Z";

describe("Arena (spec 1.2 §3.1)", () => {
  it("reads the effort from a (Max)/(xHigh)/(High) suffix or a trailing -max, and drops a harness note", () => {
    expect(arenaRung("Claude Opus 5.5 (High)")).toBe("Claude Opus 5.5#high");
    expect(arenaRung("GPT 5.6 Sol (xHigh)")).toBe("GPT 5.6 Sol#xhigh");
    expect(arenaRung("claude-opus-5.5-max")).toBe("claude-opus-5.5#max");
    expect(arenaRung("gpt-5.6-sol-xhigh (codex-harness)")).toBe("gpt-5.6-sol#xhigh");
    expect(arenaRung("muse-spark-1.3 (xHigh)")).toBe("muse-spark-1.3#xhigh");
    expect(arenaRung("DeepSeek V4 Pro (High) (0813)")).toBe("DeepSeek V4 Pro (0813)#high");
    expect(arenaRung("Qwen3.8 Max")).toBe("Qwen3.8 Max");
    expect(arenaRung("gemini-3.5-flash-lite")).toBe("gemini-3.5-flash-lite");
  });

  it("fetches the six configs of the leaderboard dataset", async () => {
    const f = fakeFetch({ status: 200, body: { rows: [] } });
    const got = await fetchArena({ fetchImpl: f.impl });
    expect(Object.keys(got)).toEqual([...ARENA_CONFIGS]);
    expect(f.sent.map((s) => s.url)).toEqual(ARENA_CONFIGS.map(arenaUrl));
    expect(arenaUrl("agent")).toBe(
      "https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=agent&split=latest&length=100",
    );
  });

  it("gives one row per model and config: the agent boards' score, WebDev's rating, dated by the board", () => {
    const rows = parseArena(arenaFixture(), AT);
    expect(rows).toHaveLength(5 * 12 + 14);
    expect(rows.find((r) => r.field === "agent" && r.rung === "Claude Opus 5.5#high")).toEqual({
      rung: "Claude Opus 5.5#high",
      field: "agent",
      value: 0.12152186656915857,
      date: "2026-09-27",
      url: ARENA_PAGE,
    });
    expect(rows.find((r) => r.field === "webdev" && r.rung === "claude-opus-5.5#max")).toMatchObject({
      value: 1826.7306745084245,
      date: "2026-09-25",
    });
    expect(rows.find((r) => r.field === "webdev" && r.rung === "gpt-5.6-sol#xhigh")?.value).toBe(
      1617.3524740259538,
    );
  });

  it("reads no coding or terminal board: Opus 5.5 is on the agent boards and WebDev only (plan 13 R-D)", () => {
    const opus = parseArena(arenaFixture(), AT).filter(
      (r) => r.rung.toLowerCase().includes("opus 5.5") || r.rung.includes("opus-5.5"),
    );
    expect(opus.map((r) => r.field).sort()).toEqual([...ARENA_CONFIGS].sort());
  });

  it("skips a row without a name or a number, and a config missing from the answer", () => {
    const raw = { agent: { rows: [{ row: { model_name: "A (Max)", score: "x" } }, { row: { score: 1 } }] } };
    expect(parseArena(raw, AT)).toEqual([]);
  });
});

describe("Vectara (spec 1.2 §3.1)", () => {
  it("reads the table's factual consistency and hallucination rate, dated by its Last updated line", () => {
    expect(VECTARA_URL).toBe(
      "https://raw.githubusercontent.com/vectara/hallucination-leaderboard/main/README.md",
    );
    const rows = parseVectara(text("vectara-README.md"), AT);
    expect(rows).toHaveLength(12);
    expect(rows.filter((r) => r.rung === "openai/gpt-6-sol")).toEqual([
      {
        rung: "openai/gpt-6-sol",
        field: "factual_consistency",
        value: 93.5,
        date: "2026-09-22",
        url: VECTARA_PAGE,
      },
      {
        rung: "openai/gpt-6-sol",
        field: "hallucination_rate",
        value: 6.5,
        date: "2026-09-22",
        url: VECTARA_PAGE,
      },
    ]);
    expect(rows.some((r) => r.rung === "anthropic/claude-haiku-4-5-20251001")).toBe(true);
  });

  it("dates by the fetch when the README has no Last updated line, and reads nothing without a table", () => {
    expect(vectaraDate("Last updated on September 22, 2026")).toBe("2026-09-22");
    expect(vectaraDate("no date")).toBeNull();
    const table =
      "|Model|Hallucination Rate|Factual Consistency Rate|\n|---|---:|---:|\n|a/b|2.0 %|98.0 %|\n";
    expect(parseVectara(table, AT).map((r) => r.date)).toEqual(["2026-09-28", "2026-09-28"]);
    expect(parseVectara("# nothing here", AT)).toEqual([]);
  });
});
````

- [ ] **Step 3: Run them and see them fail**

Run: `bun test test/infra/sources/scores.test.ts`
Expected: FAIL: `Cannot find module "../../../src/infra/sources/arena.ts"`.

- [ ] **Step 4: Implement**

Create `src/infra/sources/arena.ts`:

````ts
import { effortWord } from "../../domain/sources.ts";
import { type SourceTransport, sourceGet } from "./http.ts";
import { isoDay, num, type SourceRow } from "./rows.ts";

/** Spec 1.2 §3.1: the Agent Arena boards and WebDev (CC-BY-4.0). */
export const ARENA_CONFIGS = [
  "agent",
  "agent_task_outcome_explicit",
  "agent_bash_recovery_steps",
  "agent_steerability",
  "agent_tool_hallucination",
  "webdev",
] as const;
export type ArenaConfig = (typeof ARENA_CONFIGS)[number];

export const ARENA_PAGE = "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset";

export const arenaUrl = (config: ArenaConfig): string =>
  `https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=${config}&split=latest&length=100`;

/** Every config, in parallel; one failure fails the source, which keeps its last answer. */
export async function fetchArena(t: SourceTransport = {}): Promise<Record<ArenaConfig, unknown>> {
  const got = await Promise.all(
    ARENA_CONFIGS.map(async (c) => [c, (await sourceGet(arenaUrl(c), t)).json()]),
  );
  return Object.fromEntries(got) as Record<ArenaConfig, unknown>;
}

/**
 * Spec 1.2 §3.4: an Arena model name as `<name>#<effort>`: the effort from a `(Max)`/`(xHigh)`/`(High)`
 * suffix, or from a trailing `-max`/`-xhigh`/`-high` (WebDev's ids). A harness note such as
 * `(codex-harness)` is dropped; any other parenthesis stays part of the name.
 */
export function arenaRung(name: string): string {
  let rest = name.replace(/\s*\([^()]*harness\)/gi, "").trim();
  let effort: string | null = null;
  rest = rest
    .replace(/\s*\(([^()]*)\)/g, (whole, inner: string) => {
      const e = effort === null ? effortWord(inner) : null;
      if (e === null) return whole;
      effort = e;
      return "";
    })
    .trim();
  if (effort === null) {
    const m = /^(.*)-([A-Za-z]+)$/.exec(rest);
    const e = m ? effortWord(m[2] as string) : null;
    if (m && e) {
      effort = e;
      rest = m[1] as string;
    }
  }
  return effort === null ? rest : `${rest}#${effort}`;
}

interface ArenaRow {
  model_name?: unknown;
  score?: unknown;
  rating?: unknown;
  leaderboard_publish_date?: unknown;
}

/**
 * One row per model and config: `field` is the config, `value` the agent boards' `score` (net improvement) or
 * WebDev's `rating`, dated by the board's publish date.
 */
export function parseArena(raw: Record<string, unknown>, fetchedAt: string): SourceRow[] {
  const rows: SourceRow[] = [];
  for (const config of ARENA_CONFIGS) {
    const list = (raw[config] as { rows?: { row?: ArenaRow }[] } | undefined)?.rows;
    if (!Array.isArray(list)) continue;
    for (const { row } of list) {
      if (!row || typeof row.model_name !== "string") continue;
      const value = num(config === "webdev" ? row.rating : row.score);
      if (value === null) continue;
      const published = typeof row.leaderboard_publish_date === "string" ? row.leaderboard_publish_date : "";
      rows.push({
        rung: arenaRung(row.model_name),
        field: config,
        value,
        date: /^\d{4}-\d{2}-\d{2}$/.test(published) ? published : isoDay(fetchedAt),
        url: ARENA_PAGE,
      });
    }
  }
  return rows;
}
````

Create `src/infra/sources/vectara.ts`:

````ts
import { type SourceTransport, sourceGet } from "./http.ts";
import { isoDay, num, type SourceRow } from "./rows.ts";

/** Spec 1.2 §3.1: the leaderboard is a markdown table in the repository's README (Apache-2.0). */
export const VECTARA_URL =
  "https://raw.githubusercontent.com/vectara/hallucination-leaderboard/main/README.md";
export const VECTARA_PAGE = "https://github.com/vectara/hallucination-leaderboard";

export const fetchVectara = async (t: SourceTransport = {}): Promise<string> =>
  (await sourceGet(VECTARA_URL, t)).text();

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** "Last updated on September 22, 2026" as `2026-09-22`; null when the README has no such line. */
export function vectaraDate(markdown: string): string | null {
  const m = /Last updated on ([A-Za-z]+) (\d{1,2}), (\d{4})/.exec(markdown);
  const month = m ? MONTHS.indexOf((m[1] as string).toLowerCase()) : -1;
  if (!m || month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${(m[2] as string).padStart(2, "0")}`;
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/**
 * Two rows per model of the README's table: `factual_consistency` and `hallucination_rate`, in percent. The
 * model keeps its `vendor/` prefix and names no effort.
 */
export function parseVectara(markdown: string, fetchedAt: string): SourceRow[] {
  const lines = markdown.split("\n");
  const head = lines.findIndex((l) => /^\|\s*Model\s*\|/i.test(l));
  if (head < 0) return [];
  const columns = cells(lines[head] as string).map((c) => c.toLowerCase());
  const at = (name: string) => columns.findIndex((c) => c.startsWith(name));
  const [consistency, hallucination] = [at("factual consistency"), at("hallucination rate")];
  const date = vectaraDate(markdown) ?? isoDay(fetchedAt);
  const rows: SourceRow[] = [];
  for (const line of lines.slice(head + 2)) {
    if (!line.trim().startsWith("|")) break;
    const c = cells(line);
    const model = c[0];
    if (!model) continue;
    for (const [field, i] of [
      ["factual_consistency", consistency],
      ["hallucination_rate", hallucination],
    ] as const) {
      const value = i < 0 ? null : num((c[i] ?? "").replace("%", ""));
      if (value !== null) rows.push({ rung: model, field, value, date, url: VECTARA_PAGE });
    }
  }
  return rows;
}
````

- [ ] **Step 5: Run the tests and the checks**

Run: `bun run format && bun test test/infra/sources/scores.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

````bash
git add src/infra/sources/arena.ts src/infra/sources/vectara.ts test/fixtures/sources/arena-agent.json test/fixtures/sources/arena-agent_bash_recovery_steps.json test/fixtures/sources/arena-agent_steerability.json test/fixtures/sources/arena-agent_task_outcome_explicit.json test/fixtures/sources/arena-agent_tool_hallucination.json test/fixtures/sources/arena-webdev.json test/fixtures/sources/vectara-README.md test/infra/sources/scores.test.ts
git commit -m "feat(sources): the Arena and Vectara fetchers and parsers"
````

---

### Task 7: Epoch AI, with a zip reader over `Bun.inflateSync` (spec 1.2 §3.1; R-F; Rulings 3, 5, 22)

Epoch serves one zip of CSVs; catherd reads three tables from it (and caches those, Ruling 11). The fixture zip is rebuilt from the three CSV fixtures by a command in Step 1 (it is binary). Needs Tasks 2 and 4.

**Files:**
- Create: `src/infra/sources/csv.ts`
- Create: `src/infra/sources/epoch.ts`
- Create: `src/infra/sources/zip.ts`
- Create: `test/fixtures/sources/epoch.zip`
- Create: `test/fixtures/sources/epoch/frontiercode_external.csv`
- Create: `test/fixtures/sources/epoch/terminalbench_external.csv`
- Create: `test/fixtures/sources/epoch/webdev_arena_external.csv`
- Create: `test/infra/sources/epoch.test.ts`

**Interfaces:**
- Consumes: `effortWord` (Task 2); `sourceGet`, `SourceError`, `type SourceTransport` (Task 4); `isoDay`, `keepHighest`, `num`, `urlOr`, `type SourceRow` (Task 4).
- Produces: `zip.ts`: `unzip(bytes, want?): Map<string, Uint8Array>`. `csv.ts`: `parseCsv(text): Record<string, string>[]`. `epoch.ts`: `EPOCH_URL`, `EPOCH_PAGE`, `EPOCH_TABLES` (`frontiercode`, `terminalbench`, `webdev`: file, score column, `fraction`, `dated`), `fetchEpoch(t): Promise<Record<string, string>>` (file name → CSV text), `epochRung(version, effortColumn?)`, `parseEpoch(tables, fetchedAt): SourceRow[]`.

- [ ] **Step 1: Add the fixtures**

Create `test/fixtures/sources/epoch/frontiercode_external.csv`:

````csv
Model version,Main score,Harness,Reasoning effort,Release date,Organization,Country,Training compute (FLOP),Training compute notes,Name,Aggregation,Source,Notes
claude-opus-5_max,0.5338,claude-code,medium,2026-07-24,Anthropic,United States of America,,,Claude Opus 5,Mean@5,https://cognition.com/frontiercode,
gpt-6-astra_max,0.5326,codex,max,2026-09-03,OpenAI,United States of America,1.0001e+27,"per OpenAI and affiliates (e.g. Nvidia), 6 Astra was trained on at least 100,000 GB200s in Abilene, Texas (so 100,000 in ""Hardware quantity"" is a lower bound/underestimate).

This suggests around 1e27 FLOP (corresponding to ~100k GB200s over 90 days at 25% FP8 MFU). See more detailed estimate in this notebook, yielding a CI of ~[5e26, 2e27] FLOP.
https://colab.research.google.com/drive/1DRlugIQs-_zoV66AJT1gQg6I1-NX7NqN ",GPT-6 Astra,Mean@5,https://cognition.com/frontiercode,
claude-fable-5-1_medium,0.5091,claude-code,medium,2026-09-01,Anthropic,United States of America,,,Claude Fable 5.1,Mean@5,https://cognition.com/frontiercode,
gpt-5.6-sol_unknown,0.47490000000000004,codex,max,2026-07-09,OpenAI,United States of America,,,GPT-5.6 Sol,Mean@5,https://cognition.com/frontiercode,
kimi-k3_unknown,0.44170000000000004,mini-swe-agent,none,2026-07-16,Moonshot,China,2.0001e+25,"Based on peer models such as Kimi K2.6 and DeepSeek V4 Pro, plausibly was trained on roughly 30T tokens (likely between 15T and 60T). Using the heuristic that C = 6ND, 30T pretraining tokens would imply ~1.9e25 FLOP. This is a somewhat uncertain estimate (more uncertain than estimates based on disclosed active params and token counts, but comparable to estimates based on disclosed GPU-hours).

K3 was likely pretrained on over 1e25 FLOP. Speculatively, K3's relatively large size compared to other Chinese models may have reduced the training token budget vs smaller models.",Kimi K3,Mean@5,https://cognition.com/frontiercode,
claude-sonnet-5_unknown,0.42730000000000007,claude-code,xhigh,2026-06-30,Anthropic,United States of America,,,Claude Sonnet 5,Mean@5,https://cognition.com/frontiercode,
gpt-5.6-terra_unknown,0.4131,codex,max,2026-07-09,OpenAI,United States of America,,,GPT-5.6 Terra,Mean@5,https://cognition.com/frontiercode,
glm-5.3_max,0.40140000000000003,chisel,max,2026-08-14,Z.ai (Zhipu AI),China,,,GLM 5.3,Mean@5,https://cognition.com/frontiercode,
gpt-5.6-luna_unknown,0.3981,codex,max,2026-07-09,OpenAI,United States of America,,,GPT-5.6 Luna,Mean@5,https://cognition.com/frontiercode,
````

Create `test/fixtures/sources/epoch/terminalbench_external.csv`:

````csv
Model version,Agent,Accuracy mean,Release date,Organization,Country,Training compute (FLOP),Training compute notes,Accuracy SE,Agent Org,Model Org,Run date,Notes,Source,Source Link,Created,Name,id
gpt-5.5_unknown,NexAU-AHE,0.847191011236,2026-04-23,OpenAI,United States of America,,,0.020892351283,china-qijizhifeng,OpenAI,2026-04-23,,https://www.tbench.ai/leaderboard/terminal-bench/2.0,,2026-05-28T16:41:48.000Z,GPT-5.5,recdZ2Aq4dSe9MUj6
gpt-5.5_unknown,Capy,0.8314606741570001,2026-04-23,OpenAI,United States of America,,,0.021123213002000003,Capy,OpenAI,2026-04-23,,https://www.tbench.ai/leaderboard/terminal-bench/2.0,,2026-05-28T16:41:48.000Z,GPT-5.5,recGwko1gzRhNX0ub
gpt-5.5_unknown,Codex CLI,0.822471910112,2026-04-23,OpenAI,United States of America,,,0.022241606381,OpenAI,OpenAI,2026-04-23,,https://www.tbench.ai/leaderboard/terminal-bench/2.0,,2026-05-04T14:49:47.000Z,GPT-5.5,recp64pC4XBYynZdL
gpt-5.5_unknown,Codex,0.8200000000000001,2026-04-23,OpenAI,United States of America,,,0.022000000000000002,OpenAI,OpenAI,2026-04-23,,https://www.tbench.ai/leaderboard/terminal-bench/2.0,,2026-04-23T21:29:38.000Z,GPT-5.5,recJA7K9RNsgzOaAU
gpt-5.5_unknown,clnkr,0.660674157303,2026-04-23,OpenAI,United States of America,,,0.024915582762000003,clnkr,OpenAI,2026-04-23,,https://www.tbench.ai/leaderboard/terminal-bench/2.0,,2026-05-28T16:41:50.000Z,GPT-5.5,recmgPXDch3lXoWZy
claude-haiku-4-5-20251001_unknown,Goose,0.35505617977500004,2025-10-15,Anthropic,United States of America,,,0.028882201141000003,Block,Anthropic,2025-10-15,,https://www.tbench.ai/leaderboard/terminal-bench/2.0,,2026-03-06T20:47:50.000Z,Claude Haiku 4.5,recYFtwkZx7UpcnlV
claude-haiku-4-5-20251001_unknown,Mini-SWE-Agent,0.298314606742,2025-10-15,Anthropic,United States of America,,,0.025133613407,Princeton,Anthropic,2025-10-15,,https://www.tbench.ai/leaderboard/terminal-bench/2.0,,2026-03-06T20:47:53.000Z,Claude Haiku 4.5,rec7okc2EI7syaupc
claude-haiku-4-5-20251001, Mini-SWE-Agent ,0.298,2025-10-15,Anthropic,United States of America,,,0.025, Princeton , Anthropic   ,2025-11-03,,Terminal-Bench v2 Leaderboard,https://www.tbench.ai/leaderboard/terminal-bench/2.0,2025-11-18T19:32:42.000Z,,recjYJxgaZXKRW8nE
claude-haiku-4-5-20251001_unknown,Terminus 2,0.283146067416,2025-10-15,Anthropic,United States of America,,,0.028755985528000003,Terminal-Bench,Anthropic,2025-10-15,,https://www.tbench.ai/leaderboard/terminal-bench/2.0,,2026-03-06T20:47:54.000Z,Claude Haiku 4.5,recTafF90BHib6N1S
claude-haiku-4-5-20251001, Terminus 2     ,0.283,2025-10-15,Anthropic,United States of America,,,0.029, Stanford  , Anthropic   ,2025-10-31,,Terminal-Bench v2 Leaderboard,https://www.tbench.ai/leaderboard/terminal-bench/2.0,2025-11-18T19:32:42.000Z,,recBFoPPbvHLqQkIF
claude-haiku-4-5-20251001_unknown,Claude Code,0.275280898876,2025-10-15,Anthropic,United States of America,,,0.027754722523000003,Anthropic,Anthropic,2025-10-15,,https://www.tbench.ai/leaderboard/terminal-bench/2.0,,2026-03-06T20:47:54.000Z,Claude Haiku 4.5,recPD1bwT2Dp0439M
claude-haiku-4-5-20251001, Claude Code    ,0.275,2025-10-15,Anthropic,United States of America,,,0.028, Anthropic , Anthropic   ,2025-11-04,,Terminal-Bench v2 Leaderboard,https://www.tbench.ai/leaderboard/terminal-bench/2.0,2025-11-18T19:32:42.000Z,,reca6RNNkwrVNSBgQ
claude-haiku-4-5-20251001_unknown,OpenHands,0.139325842697,2025-10-15,Anthropic,United States of America,,,0.027329168928,OpenHands,Anthropic,2025-10-15,,https://www.tbench.ai/leaderboard/terminal-bench/2.0,,2026-03-06T20:48:00.000Z,Claude Haiku 4.5,recjGQE5ZmhLlLmjS
claude-haiku-4-5-20251001, OpenHands      ,0.139,2025-10-15,Anthropic,United States of America,,,0.027, OpenHands , Anthropic   ,2025-11-02,,Terminal-Bench v2 Leaderboard,https://www.tbench.ai/leaderboard/terminal-bench/2.0,2025-11-18T19:32:42.000Z,,rec2PAXFlaUXgbf7W
````

Create `test/fixtures/sources/epoch/webdev_arena_external.csv`:

````csv
Model version,Arena Score,Release date,Organization,Country,Training compute (FLOP),Training compute notes,Score 95% CI,Votes,Last updated,Source,Source link (site from table),Notes,95% CI High,95% CI Low,id
gpt-6-astra_max,1800.28,2026-09-03,OpenAI,United States of America,1.0001e+27,"per OpenAI and affiliates (e.g. Nvidia), 6 Astra was trained on at least 100,000 GB200s in Abilene, Texas (so 100,000 in ""Hardware quantity"" is a lower bound/underestimate).

This suggests around 1e27 FLOP (corresponding to ~100k GB200s over 90 days at 25% FP8 MFU). See more detailed estimate in this notebook, yielding a CI of ~[5e26, 2e27] FLOP.
https://colab.research.google.com/drive/1DRlugIQs-_zoV66AJT1gQg6I1-NX7NqN ",,2281,,https://arena.ai/leaderboard,https://web.lmarena.ai/leaderboard,,1816.76,1783.81,rec5pxBoPZ09DjlAl
claude-fable-5-1_max,1758.05,2026-09-01,Anthropic,United States of America,,,,3036,,https://arena.ai/leaderboard,https://web.lmarena.ai/leaderboard,,1771.65,1744.44,recW7c6YS46DN6aYk
claude-opus-5_max,1686.99,2026-07-24,Anthropic,United States of America,,,,12087,,https://arena.ai/leaderboard,https://web.lmarena.ai/leaderboard,,1694.48,1679.51,recNUvyfQc6Bik8Uv
kimi-k3_max,1674.26,2026-07-16,Moonshot,China,2.0001e+25,"Based on peer models such as Kimi K2.6 and DeepSeek V4 Pro, plausibly was trained on roughly 30T tokens (likely between 15T and 60T). Using the heuristic that C = 6ND, 30T pretraining tokens would imply ~1.9e25 FLOP. This is a somewhat uncertain estimate (more uncertain than estimates based on disclosed active params and token counts, but comparable to estimates based on disclosed GPU-hours).

K3 was likely pretrained on over 1e25 FLOP. Speculatively, K3's relatively large size compared to other Chinese models may have reduced the training token budget vs smaller models.",,4547,,https://arena.ai/leaderboard,https://web.lmarena.ai/leaderboard,,1685.47,1663.05,recDg44iIUtAe2RhI
claude-opus-5_high,1660.45,2026-07-24,Anthropic,United States of America,,,,12566,,https://arena.ai/leaderboard,https://web.lmarena.ai/leaderboard,,1667.4,1653.5,recbSCzHPr3UAWM3V
gpt-5.6-sol_xhigh,1617.32,2026-07-09,OpenAI,United States of America,,,,11916,,https://arena.ai/leaderboard,https://web.lmarena.ai/leaderboard,,1624.28,1610.36,recG5CUO9e2GOfiiz
glm-5.3_max,1614.45,2026-08-14,Z.ai (Zhipu AI),China,,,,3725,,https://arena.ai/leaderboard,https://web.lmarena.ai/leaderboard,,1625.29,1603.61,recGUmCEUF1DKCZhV
claude-sonnet-5_high,1536.72,2026-06-30,Anthropic,United States of America,,,,9296,,https://arena.ai/leaderboard,https://web.lmarena.ai/leaderboard,,1543.87,1529.57,recP9GzaDk8uq0RYS
gpt-5.6-terra_xhigh,1521.25,2026-07-09,OpenAI,United States of America,,,,7694,,https://arena.ai/leaderboard,https://web.lmarena.ai/leaderboard,,1529.0,1513.49,recOxZA3Y5CtVv4tH
gpt-5.6-luna_xhigh,1518.87,2026-07-09,OpenAI,United States of America,,,,7828,,https://arena.ai/leaderboard,https://web.lmarena.ai/leaderboard,,1526.48,1511.27,recOBEMJmw7esCPWt
claude-haiku-4-5-20251001,1286.0,2025-10-15,Anthropic,United States of America,,,=+9/-9,8276,2026-01-05,WebDev Arena Leaderboard,https://web.lmarena.ai/leaderboard,,,,rec4L4znR9E7Yeb7E
````

Build `test/fixtures/sources/epoch.zip` from the three CSVs (deflated, as epoch.ai serves it, plus a README entry the reader must skip):

````bash
cd test/fixtures/sources && python3 -c "import zipfile; z=zipfile.ZipFile('epoch.zip','w',zipfile.ZIP_DEFLATED); [z.write('epoch/'+n, n) for n in ['frontiercode_external.csv','terminalbench_external.csv','webdev_arena_external.csv']]; z.writestr('README.md', '## Licensing\nCC BY 4.0\n'); z.close()" && cd -
````

- [ ] **Step 2: Write the failing tests**

Create `test/infra/sources/epoch.test.ts`:

````ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCsv } from "../../../src/infra/sources/csv.ts";
import {
  EPOCH_PAGE,
  EPOCH_TABLES,
  EPOCH_URL,
  epochRung,
  fetchEpoch,
  parseEpoch,
} from "../../../src/infra/sources/epoch.ts";
import { unzip } from "../../../src/infra/sources/zip.ts";

const FX = join(import.meta.dir, "..", "..", "fixtures", "sources");
const zipBytes = () => new Uint8Array(readFileSync(join(FX, "epoch.zip")));
const AT = "2026-09-28T10:00:00.000Z";
const zipFetch = (bytes: Uint8Array) =>
  (async () =>
    new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), { status: 200 })) as unknown as typeof fetch;

describe("the zip reader (plan 13 R-F)", () => {
  it("reads the deflated entries it is asked for, by name", () => {
    const all = unzip(zipBytes());
    expect([...all.keys()].sort()).toEqual([
      "README.md",
      "frontiercode_external.csv",
      "terminalbench_external.csv",
      "webdev_arena_external.csv",
    ]);
    const one = unzip(zipBytes(), (n) => n === "README.md");
    expect(new TextDecoder().decode(one.get("README.md"))).toContain("CC BY 4.0");
    expect(new TextDecoder().decode(all.get("frontiercode_external.csv"))).toBe(
      readFileSync(join(FX, "epoch", "frontiercode_external.csv"), "utf8"),
    );
  });

  it("refuses bytes that are not a zip", () => {
    expect(() => unzip(new TextEncoder().encode("<html>not a zip</html>"))).toThrow("not a zip archive");
  });
});

describe("CSV", () => {
  it("reads quoted commas, doubled quotes and line breaks inside a field, and CRLF rows", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\r\n\r\n3,\n')).toEqual([
      { a: "x, y", b: 'say "hi"\nthere' },
      { a: "3", b: "" },
    ]);
    expect(parseCsv("")).toEqual([]);
  });
});

describe("Epoch AI (spec 1.2 §3.1)", () => {
  it("reads the effort after the last _, else the Reasoning effort column; _unknown names none", () => {
    expect(epochRung("gpt-6-astra_max")).toBe("gpt-6-astra#max");
    expect(epochRung("gpt-5.6-sol_unknown", "max")).toBe("gpt-5.6-sol#max");
    expect(epochRung("claude-opus-5_max", "medium")).toBe("claude-opus-5#max");
    expect(epochRung("claude-opus-4-5-20251101_32K")).toBe("claude-opus-4-5-20251101");
    expect(epochRung("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5-20251001");
  });

  it("fetches the zip and keeps the three tables it reads", async () => {
    expect(EPOCH_URL).toBe("https://epoch.ai/data/benchmark_data.zip");
    const tables = await fetchEpoch({ fetchImpl: zipFetch(zipBytes()) });
    expect(Object.keys(tables).sort()).toEqual(
      Object.values(EPOCH_TABLES)
        .map((t) => t.file)
        .sort(),
    );
  });

  it("fails the source on an answer that is not a zip", async () => {
    const html = new TextEncoder().encode("<html>");
    expect((await fetchEpoch({ fetchImpl: zipFetch(html) }).catch((e) => e)).message).toBe(
      "the answer is not a readable zip: not a zip archive",
    );
  });

  it("gives FrontierCode and Terminal-Bench in percent, WebDev as its rating, the best agent per model", () => {
    const tables = Object.fromEntries(
      [...unzip(zipBytes())].map(([name, data]) => [name, new TextDecoder().decode(data)]),
    );
    const rows = parseEpoch(tables, AT);
    const at = (field: string, rung: string) => rows.find((r) => r.field === field && r.rung === rung);
    expect(at("frontiercode", "gpt-5.6-sol#max")).toEqual({
      rung: "gpt-5.6-sol#max",
      field: "frontiercode",
      value: 47.49,
      date: "2026-09-28",
      url: "https://cognition.com/frontiercode",
    });
    // five Terminal-Bench rows for Haiku 4.5 under two spellings: the best, dated by its run
    expect(at("terminalbench", "claude-haiku-4-5-20251001")).toMatchObject({
      value: 35.5056,
      date: "2025-10-15",
    });
    expect(at("webdev", "claude-fable-5-1#max")).toMatchObject({
      value: 1758.05,
      url: "https://arena.ai/leaderboard",
    });
    expect(rows.filter((r) => r.field === "terminalbench")).toHaveLength(2);
    expect(rows.every((r) => r.url.startsWith("https://"))).toBe(true);
    expect(EPOCH_PAGE).toBe("https://epoch.ai/benchmarks");
  });

  it("has no Opus 5.5 row in FrontierCode or Terminal-Bench (plan 13 R-D)", () => {
    const tables = Object.fromEntries(
      [...unzip(zipBytes())].map(([name, data]) => [name, new TextDecoder().decode(data)]),
    );
    expect(parseEpoch(tables, AT).filter((r) => r.rung.startsWith("claude-opus-5-5"))).toEqual([]);
  });
});
````

- [ ] **Step 3: Run them and see them fail**

Run: `bun test test/infra/sources/epoch.test.ts`
Expected: FAIL: `Cannot find module "../../../src/infra/sources/csv.ts"`.

- [ ] **Step 4: Implement**

Create `src/infra/sources/csv.ts`:

````ts
/**
 * RFC 4180 CSV as one object per row, keyed by the header row: quoted fields may hold commas, `""` and line
 * breaks (Epoch's notes do); CRLF and LF both end a row; blank lines are skipped.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      records.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    records.push(row);
  }
  const rows = records.filter((r) => r.some((c) => c !== ""));
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}
````

Create `src/infra/sources/epoch.ts`:

````ts
import { effortWord } from "../../domain/sources.ts";
import { parseCsv } from "./csv.ts";
import { SourceError, type SourceTransport, sourceGet } from "./http.ts";
import { isoDay, keepHighest, num, type SourceRow, urlOr } from "./rows.ts";
import { unzip } from "./zip.ts";

/** Spec 1.2 §3.1: one CSV per benchmark in a zip (CC-BY; external tables keep their own license). */
export const EPOCH_URL = "https://epoch.ai/data/benchmark_data.zip";
export const EPOCH_PAGE = "https://epoch.ai/benchmarks";

/**
 * The tables catherd reads, by field: the file, its score column, whether that score is a fraction (read in
 * percent, as the shipped values are), and the column that dates a row, if any.
 */
export const EPOCH_TABLES = {
  frontiercode: { file: "frontiercode_external.csv", score: "Main score", fraction: true, dated: null },
  terminalbench: {
    file: "terminalbench_external.csv",
    score: "Accuracy mean",
    fraction: true,
    dated: "Run date",
  },
  webdev: { file: "webdev_arena_external.csv", score: "Arena Score", fraction: false, dated: "Last updated" },
} as const;
type EpochField = keyof typeof EPOCH_TABLES;
const FIELDS = Object.keys(EPOCH_TABLES) as EpochField[];

/** The zip's tables catherd reads, by file name (the answer catherd caches); a missing one fails the source. */
export async function fetchEpoch(t: SourceTransport = {}): Promise<Record<string, string>> {
  const r = await sourceGet(EPOCH_URL, t);
  const wanted = new Set<string>(FIELDS.map((f) => EPOCH_TABLES[f].file));
  let files: Map<string, Uint8Array>;
  try {
    files = unzip(r.bytes, (name) => wanted.has(name));
  } catch (e) {
    throw new SourceError(`the answer is not a readable zip: ${(e as Error).message}`, r.status);
  }
  const out: Record<string, string> = {};
  for (const name of wanted) {
    const data = files.get(name);
    if (!data) throw new SourceError(`the zip has no ${name}`, r.status);
    out[name] = new TextDecoder().decode(data);
  }
  return out;
}

/**
 * Spec 1.2 §3.4: Epoch's `Model version` as `<id>#<effort>`: the effort after the last `_` (`gpt-6-astra_max`),
 * else the row's `Reasoning effort` column; `_unknown` and suffixes that are not efforts (`_32K`) name none.
 */
export function epochRung(version: string, effortColumn = ""): string {
  const cut = version.lastIndexOf("_");
  const id = cut < 0 ? version : version.slice(0, cut);
  const effort = (cut < 0 ? null : effortWord(version.slice(cut + 1))) ?? effortWord(effortColumn);
  return effort ? `${id}#${effort}` : id;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** One row per model and table, the highest where a model has several (Terminal-Bench: one per agent). */
export function parseEpoch(tables: Record<string, string>, fetchedAt: string): SourceRow[] {
  const rows: SourceRow[] = [];
  for (const field of FIELDS) {
    const t = EPOCH_TABLES[field];
    const text = tables[t.file];
    if (typeof text !== "string") continue;
    for (const r of parseCsv(text)) {
      const version = (r["Model version"] ?? "").trim();
      const raw = num(r[t.score]);
      if (!version || raw === null) continue;
      const dated = t.dated ? (r[t.dated] ?? "").trim() : "";
      rows.push({
        rung: epochRung(version, r["Reasoning effort"] ?? ""),
        field,
        value: t.fraction ? Math.round(raw * 1e6) / 1e4 : raw,
        date: DAY.test(dated) ? dated : isoDay(fetchedAt),
        url: urlOr(r.Source, urlOr(r["Source Link"] ?? r["Source link (site from table)"], EPOCH_PAGE)),
      });
    }
  }
  return keepHighest(rows);
}
````

Create `src/infra/sources/zip.ts`:

````ts
// Plan 13 R-F: Epoch ships its tables as one zip. Reading it needs only the central directory and
// raw deflate (`Bun.inflateSync`), so there is no dependency for it.

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/**
 * The files of a zip archive whose names `want` accepts, by name: stored (method 0) or deflated (8). Throws
 * on a malformed archive or another method. ZIP64 archives are not read (Epoch's is 2 MB).
 */
export function unzip(
  bytes: Uint8Array,
  want: (name: string) => boolean = () => true,
): Map<string, Uint8Array> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  // the end record is 22 bytes plus a comment of up to 64 KiB
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--)
    if (dv.getUint32(i, true) === EOCD) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("not a zip archive");
  const count = dv.getUint16(end + 10, true);
  let at = dv.getUint32(end + 16, true);
  const decode = new TextDecoder();
  const out = new Map<string, Uint8Array>();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(at, true) !== CENTRAL) throw new Error("a malformed zip directory");
    const method = dv.getUint16(at + 10, true);
    const size = dv.getUint32(at + 20, true);
    const nameLen = dv.getUint16(at + 28, true);
    const extraLen = dv.getUint16(at + 30, true);
    const commentLen = dv.getUint16(at + 32, true);
    const local = dv.getUint32(at + 42, true);
    const name = decode.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    if (dv.getUint32(local, true) !== LOCAL) throw new Error(`a malformed zip entry: ${name}`);
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, Bun.inflateSync(data.slice()));
    else throw new Error(`zip method ${method} is not read: ${name}`);
  }
  return out;
}
````

- [ ] **Step 5: Run the tests and the checks**

Run: `bun run format && bun test test/infra/sources/epoch.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

````bash
git add src/infra/sources/csv.ts src/infra/sources/epoch.ts src/infra/sources/zip.ts test/fixtures/sources/epoch.zip test/fixtures/sources/epoch/frontiercode_external.csv test/fixtures/sources/epoch/terminalbench_external.csv test/fixtures/sources/epoch/webdev_arena_external.csv test/infra/sources/epoch.test.ts
git commit -m "feat(sources): the Epoch fetcher and parser, with a zip reader over Bun.inflateSync"
````

---

### Task 8: Artificial Analysis: two paths, the key test, the parser (spec 1.2 §3.1, §9; R-C)

The keyed source. Its two fixtures are **synthetic** (R-C); keep their `synthetic` field. Needs Tasks 2 and 4.

**Files:**
- Create: `src/infra/sources/artificial-analysis.ts`
- Create: `test/fixtures/sources/artificial-analysis-free-1.json`
- Create: `test/fixtures/sources/artificial-analysis-free-2.json`
- Create: `test/fixtures/sources/artificial-analysis-models.json`
- Create: `test/infra/sources/artificial-analysis.test.ts`

**Interfaces:**
- Consumes: `effortWord` (Task 2); `sourceGet`, `SourceError`, `rateLimitRemaining`, `type SourceTransport` (Task 4); `isoDay`, `num`, `type SourceRow` (Task 4).
- Produces: `artificial-analysis.ts`: `AA_MODELS_URL`, `aaFreeUrl(page)`, `AA_PAGE`, `interface AaAnswer { path: "models" | "free"; pages: unknown[]; rateLimitRemaining: number | null }`, `fetchArtificialAnalysis(key, t): Promise<AaAnswer>`, `testAaKey(key, t): Promise<{ result: "ok" | "refused" | "unchecked"; error?: string; rateLimitRemaining: number | null }>`, `aaRung(slug): string`, `parseArtificialAnalysis(answer: AaAnswer, fetchedAt): SourceRow[]` (fields named as AA names them: `livecodebench`, `terminalbench_v2_1`, `tau2`, `scicode`, the indexes, prices, `median_output_tokens_per_second`, `cost_per_task`, …).

- [ ] **Step 1: Add the fixtures**

Create `test/fixtures/sources/artificial-analysis-free-1.json`:

````json
{
"synthetic":"built from the fields docs/dev/ideas.md documents, with made-up values; re-record with a key (README.md)",
"data":[
{"slug":"gpt-6-astra-xhigh","name":"GPT-6 Astra (xhigh)","release_date":"2026-09-03","model_creator":{"name":"OpenAI","slug":"openai"},"evaluations":{"artificial_analysis_intelligence_index":61.2,"artificial_analysis_coding_index":58.4,"artificial_analysis_agentic_index":63.0},"cost_per_task":0.92,"pricing":{"price_1m_input_tokens":10,"price_1m_output_tokens":50},"median_output_tokens_per_second":71.5,"median_time_to_first_token_seconds":9.2},
{"slug":"claude-opus-5-5-high","name":"Claude Opus 5.5 (high)","release_date":"2026-09-22","model_creator":{"name":"Anthropic","slug":"anthropic"},"evaluations":{"artificial_analysis_intelligence_index":53.6},"cost_per_task":0.41,"pricing":{"price_1m_input_tokens":4,"price_1m_output_tokens":20},"median_output_tokens_per_second":null,"median_time_to_first_token_seconds":null},
{"slug":"claude-4-5-haiku","name":"Claude 4.5 Haiku","release_date":"2025-10-15","model_creator":{"name":"Anthropic","slug":"anthropic"},"evaluations":{"artificial_analysis_intelligence_index":37.4,"artificial_analysis_coding_index":33.1,"artificial_analysis_agentic_index":35.2},"cost_per_task":0.05,"pricing":{"price_1m_input_tokens":1,"price_1m_output_tokens":5},"median_output_tokens_per_second":102.7,"median_time_to_first_token_seconds":0.7}
],
"pagination":{"page":1,"total_pages":2}
}
````

Create `test/fixtures/sources/artificial-analysis-free-2.json`:

````json
{
"synthetic":"built from the fields docs/dev/ideas.md documents; re-record with a key (README.md)",
"data":[],
"pagination":{"page":2,"total_pages":2}
}
````

Create `test/fixtures/sources/artificial-analysis-models.json`:

````json
{
"status":200,
"synthetic":"built from the fields docs/dev/ideas.md documents, with made-up values; re-record with a key (README.md)",
"data":[
{"id":"syn-0001","name":"GPT-6 Astra (xhigh)","slug":"gpt-6-astra-xhigh","release_date":"2026-09-03","model_creator":{"name":"OpenAI","slug":"openai"},"evaluations":{"artificial_analysis_intelligence_index":61.2,"artificial_analysis_coding_index":58.4,"livecodebench":0.86,"scicode":0.62,"hle":0.41,"lcr":0.74,"tau2":0.88,"terminalbench_v2_1":0.61,"terminalbench_hard":0.44},"pricing":{"price_1m_blended_3_to_1":20,"price_1m_input_tokens":10,"price_1m_output_tokens":50},"median_output_tokens_per_second":71.5,"median_time_to_first_token_seconds":9.2},
{"id":"syn-0002","name":"GPT-6 Astra","slug":"gpt-6-astra","release_date":"2026-09-03","model_creator":{"name":"OpenAI","slug":"openai"},"evaluations":{"artificial_analysis_intelligence_index":62.0,"artificial_analysis_coding_index":59.1,"livecodebench":0.87,"scicode":0.63,"hle":0.43,"lcr":0.75,"tau2":0.89,"terminalbench_v2_1":0.63,"terminalbench_hard":0.46},"pricing":{"price_1m_blended_3_to_1":20,"price_1m_input_tokens":10,"price_1m_output_tokens":50},"median_output_tokens_per_second":64.0,"median_time_to_first_token_seconds":14.8},
{"id":"syn-0003","name":"Claude Fable 5.1","slug":"claude-fable-5-1","release_date":"2026-09-01","model_creator":{"name":"Anthropic","slug":"anthropic"},"evaluations":{"artificial_analysis_intelligence_index":58.3,"artificial_analysis_coding_index":55.0,"livecodebench":0.8,"scicode":0.61,"hle":0.37,"lcr":0.71,"tau2":0.9,"terminalbench_v2_1":0.58,"terminalbench_hard":0.41},"pricing":{"price_1m_blended_3_to_1":20,"price_1m_input_tokens":10,"price_1m_output_tokens":50},"median_output_tokens_per_second":58.1,"median_time_to_first_token_seconds":11.0},
{"id":"syn-0004","name":"Claude Fable 5.1 (medium)","slug":"claude-fable-5-1-medium","release_date":"2026-09-01","model_creator":{"name":"Anthropic","slug":"anthropic"},"evaluations":{"artificial_analysis_intelligence_index":48.9,"artificial_analysis_coding_index":47.2,"livecodebench":0.71,"scicode":0.59,"hle":0.28,"lcr":0.65,"tau2":0.84,"terminalbench_v2_1":0.49,"terminalbench_hard":0.33},"pricing":{"price_1m_blended_3_to_1":20,"price_1m_input_tokens":10,"price_1m_output_tokens":50},"median_output_tokens_per_second":61.3,"median_time_to_first_token_seconds":4.2},
{"id":"syn-0005","name":"GPT-5.6 Sol","slug":"gpt-5-6-sol","release_date":"2026-07-09","model_creator":{"name":"OpenAI","slug":"openai"},"evaluations":{"artificial_analysis_intelligence_index":57.1,"artificial_analysis_coding_index":56.0,"livecodebench":0.84,"scicode":0.58,"hle":0.35,"lcr":0.7,"tau2":0.86,"terminalbench_v2_1":0.52,"terminalbench_hard":0.37},"pricing":{"price_1m_blended_3_to_1":8,"price_1m_input_tokens":4,"price_1m_output_tokens":20},"median_output_tokens_per_second":88.0,"median_time_to_first_token_seconds":12.5},
{"id":"syn-0006","name":"GPT-5.6 Luna","slug":"gpt-5-6-luna","release_date":"2026-07-09","model_creator":{"name":"OpenAI","slug":"openai"},"evaluations":{"artificial_analysis_intelligence_index":49.5,"artificial_analysis_coding_index":47.9,"livecodebench":0.78,"scicode":0.52,"hle":0.24,"lcr":0.6,"tau2":0.8,"terminalbench_v2_1":0.4,"terminalbench_hard":0.26},"pricing":{"price_1m_blended_3_to_1":0.45,"price_1m_input_tokens":0.2,"price_1m_output_tokens":1.2},"median_output_tokens_per_second":190.4,"median_time_to_first_token_seconds":3.1},
{"id":"syn-0007","name":"GPT-6 Luna","slug":"gpt-6-luna","release_date":"2026-09-22","model_creator":{"name":"OpenAI","slug":"openai"},"evaluations":{"artificial_analysis_intelligence_index":50.2,"artificial_analysis_coding_index":48.8,"livecodebench":0.77,"scicode":0.53,"hle":0.25,"lcr":0.62,"tau2":0.81,"terminalbench_v2_1":0.39,"terminalbench_hard":0.25},"pricing":{"price_1m_blended_3_to_1":0.2,"price_1m_input_tokens":0.1,"price_1m_output_tokens":0.5},"median_output_tokens_per_second":240.0,"median_time_to_first_token_seconds":2.4},
{"id":"syn-0008","name":"GPT-6 Sol","slug":"gpt-6-sol","release_date":"2026-09-22","model_creator":{"name":"OpenAI","slug":"openai"},"evaluations":{"artificial_analysis_intelligence_index":47.5,"hle":0.3,"scicode":0.57,"lcr":0.66},"pricing":{"price_1m_blended_3_to_1":4,"price_1m_input_tokens":2,"price_1m_output_tokens":10},"median_output_tokens_per_second":null,"median_time_to_first_token_seconds":null},
{"id":"syn-0009","name":"Claude Opus 5.5 (high)","slug":"claude-opus-5-5-high","release_date":"2026-09-22","model_creator":{"name":"Anthropic","slug":"anthropic"},"evaluations":{"artificial_analysis_intelligence_index":53.6,"hle":0.33,"scicode":0.6,"lcr":0.69},"pricing":{"price_1m_blended_3_to_1":8,"price_1m_input_tokens":4,"price_1m_output_tokens":20},"median_output_tokens_per_second":null,"median_time_to_first_token_seconds":null},
{"id":"syn-0010","name":"Claude 4.5 Haiku","slug":"claude-4-5-haiku","release_date":"2025-10-15","model_creator":{"name":"Anthropic","slug":"anthropic"},"evaluations":{"artificial_analysis_intelligence_index":37.4,"artificial_analysis_coding_index":33.1,"livecodebench":0.52,"scicode":0.38,"hle":0.08,"lcr":0.44,"tau2":0.63,"terminalbench_v2_1":0.29,"terminalbench_hard":0.14},"pricing":{"price_1m_blended_3_to_1":2,"price_1m_input_tokens":1,"price_1m_output_tokens":5},"median_output_tokens_per_second":102.7,"median_time_to_first_token_seconds":0.7},
{"id":"syn-0011","name":"Gemini 3.8 Flash","slug":"gemini-3-8-flash","release_date":"2026-08-20","model_creator":{"name":"Google","slug":"google"},"evaluations":{"artificial_analysis_intelligence_index":52.0,"artificial_analysis_coding_index":49.0,"livecodebench":0.8,"scicode":0.55},"pricing":{"price_1m_blended_3_to_1":1,"price_1m_input_tokens":0.5,"price_1m_output_tokens":3},"median_output_tokens_per_second":210.0,"median_time_to_first_token_seconds":1.9}
]
}
````

- [ ] **Step 2: Write the failing tests**

Create `test/infra/sources/artificial-analysis.test.ts`:

````ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AA_MODELS_URL,
  aaFreeUrl,
  aaRung,
  fetchArtificialAnalysis,
  parseArtificialAnalysis,
  testAaKey,
} from "../../../src/infra/sources/artificial-analysis.ts";
import { fakeFetch } from "../../fake-fetch.ts";

const FX = join(import.meta.dir, "..", "..", "fixtures", "sources");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FX, name), "utf8"));
const AT = "2026-09-28T10:00:00.000Z";
const clock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), random: () => 0.5 };
};
const limit = (n: number) => ({ "x-ratelimit-remaining": String(n) });

describe("Artificial Analysis (spec 1.2 §3.1; fixtures synthetic, see their README)", () => {
  it("reads the effort from the slug, a bare slug meaning max", () => {
    expect(aaRung("gpt-6-astra-xhigh")).toBe("gpt-6-astra#xhigh");
    expect(aaRung("claude-fable-5-1-medium")).toBe("claude-fable-5-1#medium");
    expect(aaRung("gpt-6-astra")).toBe("gpt-6-astra#max");
    expect(aaRung("claude-4-5-haiku")).toBe("claude-4-5-haiku#max");
  });

  it("reads the models path with the user's key in x-api-key, and the requests left", async () => {
    const f = fakeFetch({
      status: 200,
      body: fixture("artificial-analysis-models.json"),
      headers: limit(98),
    });
    const a = await fetchArtificialAnalysis("aa-key-0123456789", { fetchImpl: f.impl, ...clock() });
    expect([a.path, a.pages.length, a.rateLimitRemaining]).toEqual(["models", 1, 98]);
    expect(f.sent[0]?.url).toBe(AA_MODELS_URL);
    expect(f.sent[0]?.headers.get("x-api-key")).toBe("aa-key-0123456789");
  });

  it("falls back to the free path's pages when the models path answers 403 or 404", async () => {
    for (const status of [403, 404]) {
      const f = fakeFetch(
        { status, body: {}, headers: limit(97) },
        { status: 200, body: fixture("artificial-analysis-free-1.json"), headers: limit(96) },
        { status: 200, body: fixture("artificial-analysis-free-2.json"), headers: limit(95) },
      );
      const a = await fetchArtificialAnalysis("k", { fetchImpl: f.impl, ...clock() });
      expect([a.path, a.pages.length, a.rateLimitRemaining]).toEqual(["free", 1, 95]);
      expect(f.sent.map((s) => s.url)).toEqual([AA_MODELS_URL, aaFreeUrl(1), aaFreeUrl(2)]);
    }
  });

  it("fails on a 401 without trying the free path", async () => {
    const f = fakeFetch({ status: 401, body: {}, headers: limit(90) });
    const e = await fetchArtificialAnalysis("bad", { fetchImpl: f.impl, ...clock() }).catch((x) => x);
    expect([e.message, e.status, f.sent.length]).toEqual(["http 401", 401, 1]);
  });

  it("tests a key with one request to the free path: 200 ok, 401 refused, anything else unchecked", async () => {
    const ok = fakeFetch({ status: 200, body: { data: [] }, headers: limit(99) });
    expect(await testAaKey("k", { fetchImpl: ok.impl, ...clock() })).toEqual({
      result: "ok",
      rateLimitRemaining: 99,
    });
    expect(ok.sent.map((s) => s.url)).toEqual([aaFreeUrl(1)]);
    const no = fakeFetch({ status: 401, body: {} });
    expect((await testAaKey("k", { fetchImpl: no.impl, ...clock() })).result).toBe("refused");
    const down = fakeFetch(new TypeError("fetch failed"));
    expect(await testAaKey("k", { fetchImpl: down.impl, ...clock() })).toMatchObject({
      result: "unchecked",
      error: "network error",
    });
  });

  it("gives a row per slug and number: evaluations, prices, speed and cost per task", () => {
    const rows = parseArtificialAnalysis(
      { path: "models", pages: [fixture("artificial-analysis-models.json")], rateLimitRemaining: null },
      AT,
    );
    const of = (rung: string) =>
      Object.fromEntries(rows.filter((r) => r.rung === rung).map((r) => [r.field, r.value]));
    expect(of("gpt-6-astra#xhigh")).toMatchObject({
      livecodebench: 0.86,
      terminalbench_v2_1: 0.61,
      tau2: 0.88,
      price_1m_input_tokens: 10,
      median_output_tokens_per_second: 71.5,
    });
    // a model released days ago: four evaluations and its price, and no null speed
    expect(of("claude-opus-5-5#high")).toEqual({
      artificial_analysis_intelligence_index: 53.6,
      hle: 0.33,
      scicode: 0.6,
      lcr: 0.69,
      price_1m_blended_3_to_1: 8,
      price_1m_input_tokens: 4,
      price_1m_output_tokens: 20,
    });
    expect(rows[0]).toMatchObject({
      date: "2026-09-28",
      url: "https://artificialanalysis.ai/models/gpt-6-astra-xhigh",
    });
    const free = parseArtificialAnalysis(
      { path: "free", pages: [fixture("artificial-analysis-free-1.json")], rateLimitRemaining: null },
      AT,
    );
    expect(free.find((r) => r.rung === "claude-4-5-haiku#max" && r.field === "cost_per_task")?.value).toBe(
      0.05,
    );
  });
});
````

- [ ] **Step 3: Run them and see them fail**

Run: `bun test test/infra/sources/artificial-analysis.test.ts`
Expected: FAIL: `Cannot find module "../../../src/infra/sources/artificial-analysis.ts"`.

- [ ] **Step 4: Implement**

Create `src/infra/sources/artificial-analysis.ts`:

````ts
import { effortWord } from "../../domain/sources.ts";
import { rateLimitRemaining, SourceError, type SourceTransport, sourceGet } from "./http.ts";
import { isoDay, num, type SourceRow } from "./rows.ts";

/** Spec 1.2 §3.1: the legacy v2 route a free key reads today, one row per effort. */
export const AA_MODELS_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";
/** Spec 1.2 §3.1: the fallback when the first path answers 403 or 404, a page at a time. */
export const aaFreeUrl = (page: number): string =>
  `https://artificialanalysis.ai/api/v2/language/models/free?page=${page}`;
export const AA_PAGE = "https://artificialanalysis.ai";
/** The free path had 4 pages on 2026-09-27; this bounds a runaway pagination. */
const MAX_FREE_PAGES = 10;

/** What catherd caches for Artificial Analysis: the path that answered, each page, the requests left. */
export interface AaAnswer {
  path: "models" | "free";
  pages: unknown[];
  rateLimitRemaining: number | null;
}

/**
 * Spec 1.2 §3.1: the models path with the user's key; on a 403 or 404 there, the free path's pages until an
 * empty page or the last one. Throws a SourceError (carrying the last answer's headers) on any other failure.
 */
export async function fetchArtificialAnalysis(key: string, t: SourceTransport = {}): Promise<AaAnswer> {
  const o = { ...t, headers: { "x-api-key": key } };
  try {
    const r = await sourceGet(AA_MODELS_URL, o);
    return { path: "models", pages: [r.json()], rateLimitRemaining: rateLimitRemaining(r.headers) };
  } catch (e) {
    if (!(e instanceof SourceError) || (e.status !== 403 && e.status !== 404)) throw e;
  }
  const pages: unknown[] = [];
  let remaining: number | null = null;
  for (let page = 1; page <= MAX_FREE_PAGES; page++) {
    const r = await sourceGet(aaFreeUrl(page), o);
    remaining = rateLimitRemaining(r.headers) ?? remaining;
    const body = r.json() as { data?: unknown; pagination?: { total_pages?: unknown } } | null;
    if (!Array.isArray(body?.data) || body.data.length === 0) break;
    pages.push(body);
    const total = num(body.pagination?.total_pages);
    if (total !== null && page >= total) break;
  }
  return { path: "free", pages, rateLimitRemaining: remaining };
}

/**
 * Spec 1.2 §9: tests a key with one request to the free path's first page. `ok` on a 200, `refused` on a 401;
 * anything else (a network error, a 5xx) leaves the key `unchecked`.
 */
export async function testAaKey(
  key: string,
  t: SourceTransport = {},
): Promise<{ result: "ok" | "refused" | "unchecked"; error?: string; rateLimitRemaining: number | null }> {
  try {
    const r = await sourceGet(aaFreeUrl(1), {
      attemptMs: 10_000,
      deadlineMs: 20_000,
      ...t,
      headers: { "x-api-key": key },
    });
    return { result: "ok", rateLimitRemaining: rateLimitRemaining(r.headers) };
  } catch (e) {
    const err = e instanceof SourceError ? e : new SourceError(String(e));
    return {
      result: err.status === 401 ? "refused" : "unchecked",
      error: err.message,
      rateLimitRemaining: rateLimitRemaining(err.headers),
    };
  }
}

/** Spec 1.2 §3.4: an AA slug as `<id>#<effort>`: its effort suffix, and `max` for a bare slug. */
export function aaRung(slug: string): string {
  const m = /^(.*)-([a-z]+)$/.exec(slug);
  const effort = m ? effortWord(m[2] as string) : null;
  return m && effort ? `${m[1]}#${effort}` : `${slug}#max`;
}

const TOP = [
  "median_output_tokens_per_second",
  "median_time_to_first_token_seconds",
  "cost_per_task",
] as const;

/**
 * One row per slug and number: every evaluation (`livecodebench`, `terminalbench_v2_1`, the indexes, …), every
 * price, speed and `cost_per_task`, named as AA names them. Nulls are left out.
 */
export function parseArtificialAnalysis(answer: AaAnswer, fetchedAt: string): SourceRow[] {
  const rows: SourceRow[] = [];
  const date = isoDay(fetchedAt);
  for (const page of answer.pages) {
    const data = (page as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) continue;
    for (const m of data as Record<string, unknown>[]) {
      if (typeof m?.slug !== "string") continue;
      const rung = aaRung(m.slug);
      const url = `${AA_PAGE}/models/${m.slug}`;
      const push = (field: string, v: unknown) => {
        const value = num(v);
        if (value !== null) rows.push({ rung, field, value, date, url });
      };
      for (const group of ["evaluations", "pricing"] as const) {
        const g = m[group];
        if (g && typeof g === "object") for (const [field, v] of Object.entries(g)) push(field, v);
      }
      for (const field of TOP) push(field, m[field]);
    }
  }
  return rows;
}
````

- [ ] **Step 5: Run the tests and the checks**

Run: `bun run format && bun test test/infra/sources/artificial-analysis.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

````bash
git add src/infra/sources/artificial-analysis.ts test/fixtures/sources/artificial-analysis-free-1.json test/fixtures/sources/artificial-analysis-free-2.json test/fixtures/sources/artificial-analysis-models.json test/infra/sources/artificial-analysis.test.ts
git commit -m "feat(sources): the Artificial Analysis fetcher, key test and parser"
````

---

### Task 9: The Artificial Analysis key in `credentials.json`, a secret workers never see (spec 1.2 §9; R-G)

`credentials.json` handling moves out of `jev-service.ts` into `src/services/credentials.ts` for both keys (`jev-service.ts` re-exports `credentialsPath` and keeps `savedJevKey`/`saveJevKey`, so no caller changes); `ARTIFICIAL_ANALYSIS_API_KEY` joins `SECRET_ENV`; `registerSavedSecrets` registers the AA key too. Independent of Tasks 1–8.

**Files:**
- Modify: `src/infra/env.ts`
- Create: `src/services/credentials.ts`
- Modify: `src/services/jev-service.ts`
- Modify: `test/infra/env.test.ts`
- Create: `test/services/credentials.test.ts`

**Interfaces:**
- Consumes: `readVersioned`, `writeJsonAtomic` (infra/store.ts); `addSecret`, `log` (infra/log.ts).
- Produces: `src/services/credentials.ts`: `credentialsPath()`, `type CredentialField = "typesafeApiKey" | "artificialAnalysisApiKey"`, `savedCredential(field): { key: string | null; problem: CatherdError | null }`, `saveCredential(field, key)`, `aaKey(env = process.env): string | null`, `saveAaKey(key)`.

- [ ] **Step 1: Write the failing tests**

Edit `test/infra/env.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/infra/env.test.ts b/test/infra/env.test.ts
index f566a72..bfbb833 100644
--- a/test/infra/env.test.ts
+++ b/test/infra/env.test.ts
@@ -37,6 +37,15 @@ describe("scrubSecrets", () => {
   });
 });
 
+describe("the Artificial Analysis key (spec 1.2 §9)", () => {
+  it("is catherd's own secret: no process catherd starts gets it", () => {
+    expect(scrubSecrets({ PATH: "/bin", ARTIFICIAL_ANALYSIS_API_KEY: "aa-0123456789" })).toEqual({
+      PATH: "/bin",
+    });
+    expect(workerEnv({ ARTIFICIAL_ANALYSIS_API_KEY: "aa-0123456789" }, {}, "/r")).toEqual({ PWD: "/r" });
+  });
+});
+
 describe("restoreTmpdir (spec 1.1 §12)", () => {
   it("gives the server the TMPDIR the user had before the launcher pointed it at bunx's cache", () => {
     const env: Record<string, string | undefined> = {
````

Create `test/services/credentials.test.ts`:

````ts
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { knownSecrets } from "../../src/infra/log.ts";
import { aaKey, credentialsPath, saveAaKey, savedCredential } from "../../src/services/credentials.ts";
import { jevKey, registerSavedSecrets, saveJevKey } from "../../src/services/jev-service.ts";
import { noPosixModes, snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

describe("the Artificial Analysis key (spec 1.2 §9)", () => {
  it("comes from ARTIFICIAL_ANALYSIS_API_KEY first, else the saved key, else none", () => {
    withHome();
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    expect(aaKey()).toBeNull();
    saveAaKey(" aa-saved-0123456789 ");
    expect(aaKey()).toBe("aa-saved-0123456789");
    process.env.ARTIFICIAL_ANALYSIS_API_KEY = "aa-env-0123456789";
    expect(aaKey()).toBe("aa-env-0123456789");
  });

  it("is saved beside the Jev key in credentials.json, each keeping the other", () => {
    withHome();
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    saveJevKey("tsk-0123456789abcdef");
    saveAaKey("aa-0123456789abcdef");
    saveJevKey("tsk-fedcba9876543210");
    expect(JSON.parse(readFileSync(credentialsPath(), "utf8"))).toEqual({
      schema: 1,
      typesafeApiKey: "tsk-fedcba9876543210",
      artificialAnalysisApiKey: "aa-0123456789abcdef",
    });
    expect(jevKey()).toBe("tsk-fedcba9876543210");
  });

  it.skipIf(noPosixModes)("keeps credentials.json at mode 600", () => {
    withHome();
    saveAaKey("aa-0123456789abcdef");
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
  });

  it("reads an unparsable credentials.json as no key, and refuses to overwrite it", () => {
    withHome();
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    mkdirSync(dirname(credentialsPath()), { recursive: true });
    writeFileSync(credentialsPath(), "{not json");
    expect(aaKey()).toBeNull();
    expect(savedCredential("artificialAnalysisApiKey").problem?.code).toBe("E_CONFIG_INVALID");
    expect(() => saveAaKey("aa-0123456789abcdef")).toThrow("is not valid JSON");
  });

  it("is registered with the log redactor with the Jev key", () => {
    withHome();
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    saveAaKey("aa-redact-0123456789");
    registerSavedSecrets();
    expect(knownSecrets({})).toContain("aa-redact-0123456789");
  });
});
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/services/credentials.test.ts test/infra/env.test.ts`
Expected: FAIL: `Cannot find module "../../src/services/credentials.ts"`, and `scrubSecrets` keeps `ARTIFICIAL_ANALYSIS_API_KEY`.

- [ ] **Step 3: Implement**

Edit `src/infra/env.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/infra/env.ts b/src/infra/env.ts
index 48ef8f2..41ca9cf 100644
--- a/src/infra/env.ts
+++ b/src/infra/env.ts
@@ -6,6 +6,8 @@
  */
 const SECRET_ENV = new Set([
   "TYPESAFE_API_KEY",
+  // spec 1.2 §9: the user's Artificial Analysis key reads scores for catherd alone
+  "ARTIFICIAL_ANALYSIS_API_KEY",
   "CLAUDE_CODE_MESSAGING_SOCKET",
   "CLAUDE_CODE_MESSAGING_TOKEN",
   "CLAUDE_CODE_SESSION_ID",
````

Create `src/services/credentials.ts`:

````ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CatherdError, isCatherdError } from "../domain/errors.ts";
import { log } from "../infra/log.ts";
import { configDir } from "../infra/paths.ts";
import { readVersioned, writeJsonAtomic } from "../infra/store.ts";

// Spec §10.4 and 1.2 §9: `<config>/credentials.json`, mode 600, holds catherd's own keys: Jev's
// (`typesafeApiKey`) and Artificial Analysis's (`artificialAnalysisApiKey`). The schema is a loose object,
// so a key one catherd does not know survives another's rewrite.

export const credentialsPath = (): string => join(configDir(), "credentials.json");

const CredentialsSchema = z.looseObject({
  schema: z.literal(1).default(1),
  typesafeApiKey: z.string().optional(),
  artificialAnalysisApiKey: z.string().optional(),
});
export type CredentialField = "typesafeApiKey" | "artificialAnalysisApiKey";

/** How to repair a credentials file catherd cannot read: `init` alone refuses to overwrite it. */
const credentialsFix = (): string =>
  `delete ${credentialsPath()} and run catherd init, or write it as {"schema": 1, "typesafeApiKey": "<your key>"}`;
const readCredentials = () =>
  readVersioned(credentialsPath(), CredentialsSchema, 1, { fix: credentialsFix() });

/** A key saved in credentials.json, or why that file cannot be read (unparsable, newer schema). */
export function savedCredential(field: CredentialField): {
  key: string | null;
  problem: CatherdError | null;
} {
  if (!existsSync(credentialsPath())) return { key: null, problem: null };
  try {
    return { key: readCredentials()[field]?.trim() || null, problem: null };
  } catch (e) {
    return {
      key: null,
      problem: isCatherdError(e)
        ? e
        : new CatherdError("E_CONFIG_INVALID", String(e), { fix: credentialsFix() }),
    };
  }
}

/**
 * Keeps every other credential, and the file at mode 600 (spec §10.4). A missing file starts empty; an
 * unreadable or newer-schema one is refused (it throws) rather than overwritten.
 */
export function saveCredential(field: CredentialField, key: string): void {
  const cur: z.infer<typeof CredentialsSchema> = existsSync(credentialsPath())
    ? readCredentials()
    : { schema: 1 };
  writeJsonAtomic(credentialsPath(), { ...cur, schema: 1, [field]: key.trim() }, { mode: 0o600 });
}

/**
 * Spec 1.2 §9: `ARTIFICIAL_ANALYSIS_API_KEY`, else the saved key; null when neither has one. The key is
 * optional, so a credentials file that cannot be read means no key here; it is logged.
 */
export function aaKey(env: Record<string, string | undefined> = process.env): string | null {
  const fromEnv = env.ARTIFICIAL_ANALYSIS_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const { key, problem } = savedCredential("artificialAnalysisApiKey");
  if (problem) log("warn", "sources", { error: `no Artificial Analysis key: ${problem.message}` });
  return key;
}

export const saveAaKey = (key: string): void => saveCredential("artificialAnalysisApiKey", key);
````

Edit `src/services/jev-service.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/jev-service.ts b/src/services/jev-service.ts
index 2c3adfd..613e2d5 100644
--- a/src/services/jev-service.ts
+++ b/src/services/jev-service.ts
@@ -1,7 +1,5 @@
-import { existsSync } from "node:fs";
 import { join } from "node:path";
-import { z } from "zod";
-import { CatherdError, isCatherdError } from "../domain/errors.ts";
+import type { CatherdError } from "../domain/errors.ts";
 import type { RouteSource } from "../domain/route.ts";
 import {
   canonicalJson,
@@ -17,45 +15,28 @@ import {
 import { assetPath } from "../infra/assets.ts";
 import { type JevTransport, jevRequest } from "../infra/jev-client.ts";
 import { addSecret, log } from "../infra/log.ts";
-import { configDir } from "../infra/paths.ts";
-import { appendJsonl, ensureJsonlHeader, readJsonl, readVersioned, writeJsonAtomic } from "../infra/store.ts";
+import { appendJsonl, ensureJsonlHeader, readJsonl, readVersioned } from "../infra/store.ts";
+import { aaKey, credentialsPath, saveCredential, savedCredential } from "./credentials.ts";
+
+export { credentialsPath };
 
 let file: JevFile | null = null;
 /** catalog/jev.json: the question sets and their rules (spec §5.5). */
 export const jevQuestions = (): JevFile =>
   (file ??= readVersioned(assetPath("catalog/jev.json"), JevFileSchema, 1));
 
-export const credentialsPath = (): string => join(configDir(), "credentials.json");
-const CredentialsSchema = z.looseObject({
-  schema: z.literal(1).default(1),
-  typesafeApiKey: z.string().optional(),
-});
-
-/** Registers the saved Jev key with the redactor, for a process that reads logs without ever calling Jev. */
+/**
+ * Registers the saved keys (Jev's and Artificial Analysis's) with the redactor, for a process that reads
+ * logs without ever using them.
+ */
 export function registerSavedSecrets(): void {
   addSecret(jevKey());
+  addSecret(aaKey());
 }
 
-/** How to repair a credentials file catherd cannot read: `init` alone refuses to overwrite it. */
-const credentialsFix = (): string =>
-  `delete ${credentialsPath()} and run catherd init, or write it as {"schema": 1, "typesafeApiKey": "<your key>"}`;
-const readCredentials = () =>
-  readVersioned(credentialsPath(), CredentialsSchema, 1, { fix: credentialsFix() });
-
 /** The key saved in credentials.json, or why that file cannot be read (unparsable, newer schema). */
-export function savedJevKey(): { key: string | null; problem: CatherdError | null } {
-  if (!existsSync(credentialsPath())) return { key: null, problem: null };
-  try {
-    return { key: readCredentials().typesafeApiKey?.trim() || null, problem: null };
-  } catch (e) {
-    return {
-      key: null,
-      problem: isCatherdError(e)
-        ? e
-        : new CatherdError("E_CONFIG_INVALID", String(e), { fix: credentialsFix() }),
-    };
-  }
-}
+export const savedJevKey = (): { key: string | null; problem: CatherdError | null } =>
+  savedCredential("typesafeApiKey");
 
 /**
  * Spec §5.5: `TYPESAFE_API_KEY`, else `<config>/credentials.json`; null when neither has one. Jev is
@@ -70,16 +51,8 @@ export function jevKey(): string | null {
   return key;
 }
 
-/**
- * Keeps any other credential, and the file at mode 600 (spec §10.4). A missing file starts empty; an
- * unreadable or newer-schema one is refused (it throws) rather than overwritten.
- */
-export function saveJevKey(key: string): void {
-  const cur: z.infer<typeof CredentialsSchema> = existsSync(credentialsPath())
-    ? readCredentials()
-    : { schema: 1 };
-  writeJsonAtomic(credentialsPath(), { ...cur, schema: 1, typesafeApiKey: key.trim() }, { mode: 0o600 });
-}
+/** Saves the Jev key in credentials.json, keeping every other credential (`saveCredential`). */
+export const saveJevKey = (key: string): void => saveCredential("typesafeApiKey", key);
 
 /** A key works when Jev lists its models: no inference, and no dependence on a question set. */
 export async function testJevKey(key: string, o: JevTransport = {}): Promise<boolean> {
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun run format && bun test test/services/credentials.test.ts test/infra/env.test.ts && bun test test/services/jev-service.test.ts test/services/doctor.test.ts test/entry/init-command.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS; also `bun test test/services/jev-service.test.ts test/services/doctor.test.ts test/entry/init-command.test.ts` passes unchanged.

- [ ] **Step 5: Commit**

````bash
git add src/infra/env.ts src/services/credentials.ts src/services/jev-service.ts test/infra/env.test.ts test/services/credentials.test.ts
git commit -m "feat(sources): the Artificial Analysis key in credentials.json, a secret workers never see"
````

---

### Task 10: Map, calibrate and merge the cached answers (spec 1.2 §3.4, §3.5, §4; Rulings 6, 7, 10; R-D, R-H)

`derive` is pure: cached answers plus the shipped files in, synced values, facts, fits, unmatched ids and warnings out. `applyFacts` lays facts over the families with the shipped file as the floor. Needs Tasks 1–8.

**Files:**
- Modify: `src/domain/catalog.ts`
- Modify: `src/domain/sources.ts`
- Create: `src/services/source-derive.ts`
- Create: `test/services/source-derive.test.ts`
- Create: `test/services/source-fixtures.ts`

**Interfaces:**
- Consumes: Tasks 1–8's exports (see their Interfaces).
- Produces: `src/domain/catalog.ts`: `FamilyFactsSchema`/`type FamilyFacts` (`{ price?, capabilities?, on: { [modelKey]: { efforts?, context? } }, releaseDate?, speed: Record<string, number> }`), `applyFacts(families, facts): Family[]`, `buildCatalog({ …, facts? })`. `src/domain/sources.ts`: `FitRowSchema`/`type FitRow`, `DerivedSchema`/`type Derived` (`{ schema: 1, builtAt, scores: Score[], facts, fits: FitRow[], unmatched: Record<string, string[]>, warnings: string[] }`). `src/services/source-derive.ts`: `type RawAnswers = Partial<Record<SourceId, { fetchedAt: string; data: unknown }>>`, `interface DeriveContext { models; scores; sources; now }`, `derive(raw, ctx): Derived`, `openRouterIds(orModelsData, { models, sources }): string[]`. `test/services/source-fixtures.ts`: `FX`, `fixtureJson(name)`, `epochZip()`, `shippedContext(now)`, `rawAnswers(fetchedAt, { aa? })`, `recordedAnswers()`, `recordedFetch({ fail? }): { impl; urls }` (404 for an unknown URL).

- [ ] **Step 1: Write the failing tests**

Create `test/services/source-derive.test.ts`:

````ts
import { describe, expect, it } from "bun:test";
import { applyFacts, buildCatalog } from "../../src/domain/catalog.ts";
import { derive, openRouterIds } from "../../src/services/source-derive.ts";
import { fixtureJson, rawAnswers, shippedContext } from "./source-fixtures.ts";

const AT = "2026-09-28T10:00:00.000Z";
const NOW = Date.parse(AT);
const keyless = () => derive(rawAnswers(AT), shippedContext(NOW));
const find = (d: ReturnType<typeof derive>, rung: string, dim: string, confidence: string) =>
  d.scores.filter((s) => s.rung === rung && s.dim === dim && s.confidence === confidence);

describe("id and effort mapping (spec 1.2 §3.4)", () => {
  it("lists every source id no family matched, never guessing one", () => {
    expect(keyless().unmatched).toEqual({
      arena: [
        "Claude Opus 5",
        "Gemini 3.8 Flash",
        "Kimi K3",
        "claude-opus-5",
        "glm-5.3",
        "kimi-k3",
        "muse-spark-1.3",
      ],
      vectara: ["antgroup/finix_s1_32b", "google/gemini-2.5-pro", "openai/gpt-5.5"],
      epoch: ["claude-opus-5", "glm-5.3", "gpt-5.5", "kimi-k3"],
    });
  });

  it("maps a source that names no effort onto the family's default effort, marked assumed", () => {
    // Epoch's Terminal-Bench names Haiku 4.5 by its dated id and no effort: Haiku's default is `default`
    expect(find(keyless(), "claude-haiku-4-5#default", "terminal", "measured")).toEqual([
      {
        rung: "claude-haiku-4-5#default",
        dim: "terminal",
        value: 35.5056,
        benchmark: "Terminal-Bench (Epoch AI)",
        version: "2025-10-15",
        url: "https://www.tbench.ai/leaderboard/terminal-bench/2.0",
        date: "2025-10-15",
        confidence: "measured",
        source: "epoch",
        effortAssumed: true,
      },
    ]);
  });
});

describe("anchors and calibration (spec 1.2 §4.1, §4.2)", () => {
  it("takes the anchor's own values as measured", () => {
    expect(find(keyless(), "claude-opus-5-5#high", "agentic", "measured")).toEqual([
      {
        rung: "claude-opus-5-5#high",
        dim: "agentic",
        value: 0.1215,
        benchmark: "Arena agent, net improvement",
        version: "2026-09-27",
        url: "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset",
        date: "2026-09-27",
        confidence: "measured",
        source: "arena",
      },
    ]);
    expect(find(keyless(), "claude-opus-5-5#max", "frontend", "measured")[0]?.value).toBe(1826.7307);
  });

  it("fits a source sharing five or more rungs and uses it at R² ≥ 0.5, storing each fit", () => {
    const d = keyless();
    const fit = (source: string, field: string) =>
      d.fits.find((f) => f.source === source && f.field === field);
    expect(fit("arena", "agent_task_outcome_explicit")).toMatchObject({ dim: "agentic", n: 12, used: true });
    expect(fit("arena", "agent_task_outcome_explicit")?.r2).toBeCloseTo(0.7638, 3);
    expect(fit("epoch", "webdev")).toMatchObject({ dim: "frontend", n: 10, used: true });
    const cal = find(d, "claude-fable-5-1#max", "frontend", "calibrated")[0];
    expect(cal?.source).toBe("epoch");
    expect(cal?.fit).toMatchObject({ source: "epoch", field: "webdev", n: 10 });
    expect(cal?.value).toBeCloseTo((cal?.fit?.a ?? 0) * 1758.05 + (cal?.fit?.b ?? 0), 3);
  });

  it("rejects a source that shares fewer than five rungs with the anchor", () => {
    const d = keyless();
    // FrontierCode shares GPT-5.6 Sol max and Luna max with the shipped DeepSWE values, nothing more
    expect(d.fits.find((f) => f.field === "frontiercode")).toEqual({
      dim: "repo_code",
      source: "epoch",
      field: "frontiercode",
      n: 2,
      a: null,
      b: null,
      r2: null,
      used: false,
      why: "2 shared rungs; a fit needs 5",
    });
    expect(d.scores.some((s) => s.dim === "repo_code")).toBe(false);
  });

  it("calibrates Artificial Analysis onto the shipped anchor, never using it as one (synthetic fixture)", () => {
    const d = derive(rawAnswers(AT, { aa: true }), shippedContext(NOW));
    expect(d.fits.find((f) => f.field === "scicode")).toMatchObject({ dim: "repo_code", n: 5, used: true });
    expect(d.fits.find((f) => f.field === "livecodebench")).toMatchObject({ n: 4, used: false });
    expect(d.scores.filter((s) => s.source === "artificial-analysis" && s.confidence === "measured")).toEqual(
      [],
    );
  });
});

describe("adjacent values (spec 1.2 §4.3)", () => {
  it("carries a family's synced value to its other efforts, from the nearest effort", () => {
    const d = keyless();
    expect(find(d, "claude-opus-5-5#max", "agentic", "adjacent")).toEqual([
      expect.objectContaining({
        value: 0.1215,
        source: "arena",
        note: "arena has it at high; carried to this effort",
      }),
    ]);
    // Sol has Arena values at max only: every other effort takes them
    expect(find(d, "gpt-6-sol#low", "steer", "adjacent")[0]?.value).toBe(0.1335);
  });

  it("never spreads the shipped values, and leaves Opus 5.5 without a coding or terminal value (plan 13 R-D)", () => {
    const d = keyless();
    expect(find(d, "gpt-6-luna#low", "repo_code", "adjacent")).toEqual([]);
    expect(
      d.scores.filter(
        (s) => s.rung.startsWith("claude-opus-5-5#") && ["repo_code", "terminal"].includes(s.dim),
      ),
    ).toEqual([]);
  });
});

describe("catalog facts (spec 1.2 §3.5)", () => {
  it("takes price, capabilities and the opencode efforts and context from models.dev", () => {
    expect(keyless().facts["gpt-6-sol"]).toEqual({
      price: { input: 2, cached: 0.2, output: 10 },
      capabilities: { toolUse: true, imageIn: true, reasoning: true },
      on: { opencode: { efforts: ["none", "low", "medium", "high", "xhigh", "max"], context: 1050000 } },
      releaseDate: "2026-09-22",
      speed: { "openrouter.uptime_last_30m": (99.87737584304108 + 99.97978535724786) / 2 },
    });
  });

  it("keeps the shipped file as the floor when laying the facts over the families", () => {
    const ctx = shippedContext(NOW);
    const facts = { "gpt-6-sol": { on: { opencode: { efforts: ["low", "turbo"] } }, speed: {} } };
    const sol = applyFacts(ctx.models.families, facts).find((f) => f.id === "gpt-6-sol");
    expect(sol?.on.opencode?.efforts).toEqual(["none", "low", "medium", "high", "xhigh", "max", "turbo"]);
    expect(sol?.on.codex?.efforts).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(sol?.price).toEqual({ input: 2, cached: 0.2, output: 10 });
    const c = buildCatalog({ models: ctx.models, scores: ctx.scores, facts, now: NOW });
    expect(c.families.find((f) => f.id === "gpt-6-sol")?.on.opencode?.efforts).toContain("turbo");
  });

  it("warns when OpenRouter or LiteLLM prices a family more than 10 % apart, or disagrees on an effort", () => {
    expect(keyless().warnings).toEqual([]);
    const raw = rawAnswers(AT);
    const or = structuredClone(fixtureJson("openrouter-models.json")) as {
      data: { id: string; pricing: { prompt: string } }[];
    };
    const sol = or.data.find((m) => m.id === "openai/gpt-6-sol");
    if (sol) sol.pricing.prompt = "0.0000025";
    const ll = structuredClone(fixtureJson("litellm.json")) as Record<string, Record<string, unknown>>;
    if (ll["gpt-6-luna"]) ll["gpt-6-luna"].supports_minimal_reasoning_effort = true;
    const d = derive(
      { ...raw, "openrouter-models": { fetchedAt: AT, data: or }, litellm: { fetchedAt: AT, data: ll } },
      shippedContext(NOW),
    );
    expect(d.warnings).toEqual([
      "gpt-6-sol: input price $2/M on models.dev, $2.5/M on OpenRouter (more than 10 % apart)",
      "gpt-6-luna: LiteLLM says effort minimal is supported; models.dev does not list it",
    ]);
  });

  it("finds one OpenRouter id per catalog family OpenRouter lists (plan 13 R-H)", () => {
    expect(openRouterIds(fixtureJson("openrouter-models.json"), shippedContext(NOW))).toEqual([
      "openai/gpt-6-sol",
      "openai/gpt-6-luna",
      "anthropic/claude-opus-5.5",
      "anthropic/claude-haiku-4.5",
    ]);
  });
});
````

Create `test/services/source-fixtures.ts`:

````ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ModelsFileSchema, ScoresFileSchema } from "../../src/domain/catalog.ts";
import { SourcesFileSchema } from "../../src/domain/sources.ts";
import { AA_MODELS_URL, aaFreeUrl } from "../../src/infra/sources/artificial-analysis.ts";
import { ARENA_CONFIGS, arenaUrl } from "../../src/infra/sources/arena.ts";
import { EPOCH_URL } from "../../src/infra/sources/epoch.ts";
import { LITELLM_URL } from "../../src/infra/sources/litellm.ts";
import { MODELS_DEV_URL } from "../../src/infra/sources/models-dev.ts";
import { openRouterEndpointsUrl } from "../../src/infra/sources/openrouter-endpoints.ts";
import { OPENROUTER_MODELS_URL } from "../../src/infra/sources/openrouter-models.ts";
import { VECTARA_URL } from "../../src/infra/sources/vectara.ts";
import { unzip } from "../../src/infra/sources/zip.ts";
import type { DeriveContext, RawAnswers } from "../../src/services/source-derive.ts";

// The recorded answers of test/fixtures/sources, as a sync caches them and as the network would serve them.

const ROOT = join(import.meta.dir, "..", "..");
export const FX = join(ROOT, "test", "fixtures", "sources");
const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
export const fixtureJson = (name: string): unknown => json(join(FX, name));
export const epochZip = (): Uint8Array => new Uint8Array(readFileSync(join(FX, "epoch.zip")));

/** The shipped catalog files, as the sync reads them. */
export const shippedContext = (now: number): DeriveContext => ({
  models: ModelsFileSchema.parse(json(join(ROOT, "catalog", "models.json"))),
  scores: ScoresFileSchema.parse(json(join(ROOT, "catalog", "scores.json"))),
  sources: SourcesFileSchema.parse(json(join(ROOT, "catalog", "sources.json"))),
  now,
});

/** Every source's recorded answer as the cache holds it; Artificial Analysis only with `aa`. */
export function rawAnswers(fetchedAt: string, o: { aa?: boolean } = {}): RawAnswers {
  const epoch = Object.fromEntries(
    [...unzip(epochZip())]
      .filter(([n]) => n.endsWith(".csv"))
      .map(([n, d]) => [n, new TextDecoder().decode(d)]),
  );
  return {
    "models-dev": { fetchedAt, data: fixtureJson("models-dev.json") },
    "openrouter-models": { fetchedAt, data: fixtureJson("openrouter-models.json") },
    "openrouter-endpoints": { fetchedAt, data: fixtureJson("openrouter-endpoints.json") },
    litellm: { fetchedAt, data: fixtureJson("litellm.json") },
    arena: {
      fetchedAt,
      data: Object.fromEntries(ARENA_CONFIGS.map((c) => [c, fixtureJson(`arena-${c}.json`)])),
    },
    vectara: { fetchedAt, data: readFileSync(join(FX, "vectara-README.md"), "utf8") },
    epoch: { fetchedAt, data: epoch },
    ...(o.aa
      ? {
          "artificial-analysis": {
            fetchedAt,
            data: {
              path: "models",
              pages: [fixtureJson("artificial-analysis-models.json")],
              rateLimitRemaining: 98,
            },
          },
        }
      : {}),
  };
}

/** Each source URL's recorded answer: a body, or raw bytes for Epoch's zip. */
export function recordedAnswers(): Map<
  string,
  { body?: unknown; bytes?: Uint8Array; headers?: Record<string, string> }
> {
  const endpoints = fixtureJson("openrouter-endpoints.json") as Record<string, unknown>;
  const answers = new Map<string, { body?: unknown; bytes?: Uint8Array; headers?: Record<string, string> }>([
    [MODELS_DEV_URL, { body: fixtureJson("models-dev.json") }],
    [OPENROUTER_MODELS_URL, { body: fixtureJson("openrouter-models.json") }],
    [LITELLM_URL, { body: fixtureJson("litellm.json") }],
    [VECTARA_URL, { bytes: new TextEncoder().encode(readFileSync(join(FX, "vectara-README.md"), "utf8")) }],
    [EPOCH_URL, { bytes: epochZip() }],
    [
      AA_MODELS_URL,
      { body: fixtureJson("artificial-analysis-models.json"), headers: { "x-ratelimit-remaining": "98" } },
    ],
    [aaFreeUrl(1), { body: fixtureJson("artificial-analysis-free-1.json") }],
  ]);
  for (const c of ARENA_CONFIGS) answers.set(arenaUrl(c), { body: fixtureJson(`arena-${c}.json`) });
  for (const [id, body] of Object.entries(endpoints)) answers.set(openRouterEndpointsUrl(id), { body });
  return answers;
}

/**
 * A fetch that serves the recorded answers by URL (404 for any other URL, as OpenRouter answers an id it
 * does not know), and records each URL asked for. `fail` makes chosen URLs throw a network error.
 */
export function recordedFetch(o: { fail?: (url: string) => boolean } = {}): {
  impl: typeof fetch;
  urls: string[];
} {
  const answers = recordedAnswers();
  const urls: string[] = [];
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    if (o.fail?.(url)) throw new TypeError("fetch failed");
    const a = answers.get(url);
    if (!a) return new Response("{}", { status: 404 });
    const body = a.bytes ? new Blob([a.bytes.slice()]) : JSON.stringify(a.body);
    return new Response(body, { status: 200, headers: a.headers });
  };
  return { impl: impl as typeof fetch, urls };
}
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/services/source-derive.test.ts`
Expected: FAIL: `Cannot find module "../../src/services/source-derive.ts"`.

- [ ] **Step 3: Implement**

Edit `src/domain/catalog.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/catalog.ts b/src/domain/catalog.ts
index 1c134d9..5cd0124 100644
--- a/src/domain/catalog.ts
+++ b/src/domain/catalog.ts
@@ -168,6 +168,48 @@ export interface Catalog {
   secs: Record<string, number>;
 }
 
+/**
+ * Spec 1.2 §3.5: what a sync learned about a family. `price`, `capabilities` and the opencode backends'
+ * `efforts` and `context` come from models.dev; `speed` holds facts that never carry a bar (spec 1.2 §4.1),
+ * as `<source>.<field>` → value.
+ */
+export const FamilyFactsSchema = z.object({
+  price: z.object({ input: z.number(), cached: z.number(), output: z.number() }).optional(),
+  capabilities: z.object({ toolUse: z.boolean(), imageIn: z.boolean(), reasoning: z.boolean() }).optional(),
+  on: z
+    .partialRecord(
+      z.enum(MODEL_KEYS),
+      z.object({ efforts: z.array(z.string()).optional(), context: z.number().int().positive().optional() }),
+    )
+    .default({}),
+  releaseDate: z.string().optional(),
+  speed: z.record(z.string(), z.number()).default({}),
+});
+export type FamilyFacts = z.infer<typeof FamilyFactsSchema>;
+
+/**
+ * Spec 1.2 §3.5: the families with a sync's facts laid over them. The shipped file stays the floor: a fact
+ * the sync lacks keeps the shipped one, and a backend keeps every effort it ships with.
+ */
+export function applyFacts(families: Family[], facts: Record<string, FamilyFacts>): Family[] {
+  return families.map((f) => {
+    const x = facts[f.id];
+    if (!x) return f;
+    const on = { ...f.on };
+    for (const key of MODEL_KEYS) {
+      const cur = on[key];
+      const got = x.on[key];
+      if (!cur || !got) continue;
+      on[key] = {
+        ...cur,
+        efforts: [...cur.efforts, ...(got.efforts ?? []).filter((e) => !cur.efforts.includes(e))],
+        context: got.context ?? cur.context,
+      };
+    }
+    return { ...f, price: x.price ?? f.price, capabilities: x.capabilities ?? f.capabilities, on };
+  });
+}
+
 /** Spec 1.2 §4.3: the level a value counts at: its own, one lower once it is older than STALE_DAYS. */
 export function effectiveRank(s: Score, now: number): number {
   const stale = now - Date.parse(s.date) > STALE_DAYS * DAY_MS;
@@ -190,6 +232,7 @@ export function buildCatalog(o: {
   models: ModelsFile;
   scores: ScoresFile;
   synced?: Score[];
+  facts?: Record<string, FamilyFacts>;
   override?: Override;
   listed?: Catalog["listed"];
   secs?: Catalog["secs"];
@@ -217,7 +260,7 @@ export function buildCatalog(o: {
       if (bar) bars[kind][d] = bar;
     }
   return {
-    families: o.models.families,
+    families: o.facts ? applyFacts(o.models.families, o.facts) : o.models.families,
     backends: o.models.backends,
     scores,
     treatLike,
````

Edit `src/domain/sources.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/sources.ts b/src/domain/sources.ts
index 799f96a..3258bf0 100644
--- a/src/domain/sources.ts
+++ b/src/domain/sources.ts
@@ -1,5 +1,5 @@
 import { z } from "zod";
-import type { Family } from "./catalog.ts";
+import { DIMS, type Family, FamilyFactsSchema, ScoreSchema } from "./catalog.ts";
 
 /** Spec 1.2 §3.1: the sources `catherd catalog sync` reads, one cache file each in `<data>/sources/`. */
 export const SOURCE_IDS = [
@@ -98,6 +98,36 @@ export function familyEfforts(f: Family): string[] {
   return [...all].filter((e) => order(e) >= 0).sort((a, b) => order(a) - order(b));
 }
 
+/** Spec 1.2 §4.2: one source's fit onto a dimension's anchor, used or not, and why not. */
+export const FitRowSchema = z.object({
+  dim: z.enum(DIMS),
+  source: z.string(),
+  field: z.string(),
+  n: z.number().int(),
+  a: z.number().nullable(),
+  b: z.number().nullable(),
+  r2: z.number().nullable(),
+  used: z.boolean(),
+  why: z.string().optional(),
+});
+export type FitRow = z.infer<typeof FitRowSchema>;
+
+/**
+ * `<data>/sources/derived.json`: what a sync made of the cached answers. `scores` are the synced values the
+ * catalog layers over the shipped ones (`measured`, `calibrated`, `adjacent`), `facts` each family's facts,
+ * `unmatched` each source's ids no family matched (never guessed), `warnings` the cross-checks that failed.
+ */
+export const DerivedSchema = z.looseObject({
+  schema: z.literal(1),
+  builtAt: z.iso.datetime(),
+  scores: z.array(ScoreSchema),
+  facts: z.record(z.string(), FamilyFactsSchema),
+  fits: z.array(FitRowSchema),
+  unmatched: z.record(z.string(), z.array(z.string())),
+  warnings: z.array(z.string()),
+});
+export type Derived = z.infer<typeof DerivedSchema>;
+
 /** The effort of `have` nearest `target` (the weaker one on a tie); null when `have` holds no effort word. */
 export function nearestEffort(target: string, have: string[]): string | null {
   const t = order(target);
````

Create `src/services/source-derive.ts`:

````ts
import { calibrate, DIM_SOURCES, type FieldRef } from "../domain/calibration.ts";
import {
  DIMS,
  type Dim,
  type Family,
  type FamilyFacts,
  type ModelsFile,
  outranks,
  type Score,
  type ScoresFile,
} from "../domain/catalog.ts";
import {
  defaultEffortOf,
  type Derived,
  familyEfforts,
  type FitRow,
  idMapper,
  type IdMapper,
  nearestEffort,
  type SourceId,
  type SourcesFile,
  splitSourceRung,
} from "../domain/sources.ts";
import { type AaAnswer, parseArtificialAnalysis } from "../infra/sources/artificial-analysis.ts";
import { parseArena } from "../infra/sources/arena.ts";
import { parseEpoch } from "../infra/sources/epoch.ts";
import { LITELLM_EFFORTS, parseLiteLlm } from "../infra/sources/litellm.ts";
import { modelsDevFacts } from "../infra/sources/models-dev.ts";
import { parseOpenRouterEndpoints } from "../infra/sources/openrouter-endpoints.ts";
import { type OpenRouterModel, parseOpenRouterModels } from "../infra/sources/openrouter-models.ts";
import type { SourceRow } from "../infra/sources/rows.ts";
import { parseVectara } from "../infra/sources/vectara.ts";

/** Each source's cached answer (its `data`) with its fetch time; a source never fetched is absent. */
export type RawAnswers = Partial<Record<SourceId, { fetchedAt: string; data: unknown }>>;

export interface DeriveContext {
  models: ModelsFile;
  scores: ScoresFile;
  sources: SourcesFile;
  now: number;
}

/** Spec 1.2 §3.5: a price that differs by more than this is a sync warning. */
const PRICE_TOLERANCE = 0.1;
/** Spec 1.2 §3.5: the models.dev provider that serves a backend key its own catalog. */
const OPENCODE_KEYS = ["opencode", "opencode-go"] as const;

interface Keyed {
  key: string;
  family: Family | null;
  effort: string;
  assumed: boolean;
  row: SourceRow;
}

/** The score sources' rows, by source (spec 1.2 §3.3). */
function scoreRows(raw: RawAnswers): [SourceId, SourceRow[]][] {
  const out: [SourceId, SourceRow[]][] = [];
  const { arena, vectara, epoch } = raw;
  const aa = raw["artificial-analysis"];
  if (arena) out.push(["arena", parseArena(arena.data as Record<string, unknown>, arena.fetchedAt)]);
  if (vectara) out.push(["vectara", parseVectara(String(vectara.data), vectara.fetchedAt)]);
  if (epoch) out.push(["epoch", parseEpoch(epoch.data as Record<string, string>, epoch.fetchedAt)]);
  if (aa) out.push(["artificial-analysis", parseArtificialAnalysis(aa.data as AaAnswer, aa.fetchedAt)]);
  return out;
}

const round = (v: number) => Math.round(v * 1e4) / 1e4;

/**
 * Spec 1.2 §3.4–§4.3: what the cached answers say. Each score source's ids are mapped onto the catalog's
 * families (unmatched ones listed, never guessed), each dimension's anchor gives `measured` values, every
 * other source is fitted onto the anchor and gives `calibrated` values when the fit may be used, and an
 * effort no source covers takes the nearest covered effort's value as `adjacent`. models.dev gives the facts;
 * OpenRouter and LiteLLM only cross-check them.
 */
export function derive(raw: RawAnswers, ctx: DeriveContext): Derived {
  const map = idMapper(ctx.models.families, ctx.sources.aliases);
  const unmatched: Record<string, Set<string>> = {};
  const table = new Map<string, Map<string, Keyed>>();
  for (const [source, rows] of scoreRows(raw))
    for (const row of rows) {
      const { id, effort } = splitSourceRung(row.rung);
      const family = map.family(id);
      if (!family) (unmatched[source] ??= new Set()).add(id);
      const e = effort ?? (family ? defaultEffortOf(ctx.sources, family) : "");
      const key = `${map.key(family?.id ?? id)}#${e}`;
      const field = `${source}.${row.field}`;
      const at = table.get(field) ?? new Map<string, Keyed>();
      table.set(field, at);
      const had = at.get(key);
      if (!had || row.value > had.row.value)
        at.set(key, { key, family, effort: e, assumed: effort === null && family !== null, row });
    }
  const valuesOf = (f: FieldRef) =>
    new Map([...(table.get(`${f.source}.${f.field}`)?.values() ?? [])].map((k) => [k.key, k.row.value]));

  const scores: Score[] = [];
  const fits: FitRow[] = [];
  const push = (dim: Dim, f: FieldRef, k: Keyed, value: number, extra: Partial<Score>) => {
    if (!k.family) return;
    scores.push({
      rung: `${k.family.id}#${k.effort}`,
      dim,
      value: round(value),
      benchmark: f.benchmark,
      version: k.row.date,
      url: k.row.url,
      date: k.row.date,
      confidence: "measured",
      source: f.source,
      ...(k.assumed ? { effortAssumed: true } : {}),
      ...extra,
    });
  };
  for (const dim of DIMS) {
    const spec = DIM_SOURCES[dim];
    let anchor: Map<string, number>;
    if (spec.anchor === "shipped") {
      anchor = new Map();
      for (const s of ctx.scores.scores)
        if (s.dim === dim && s.confidence !== "inferred") {
          const { id, effort } = splitSourceRung(s.rung);
          anchor.set(`${map.key(id)}#${effort}`, s.value);
        }
    } else {
      const ref = spec.anchor;
      anchor = valuesOf(ref);
      for (const k of table.get(`${ref.source}.${ref.field}`)?.values() ?? [])
        push(dim, ref, k, k.row.value, {});
    }
    for (const other of spec.others) {
      const values = valuesOf(other);
      if (values.size === 0) continue;
      const r = calibrate(anchor, values);
      fits.push({
        dim,
        source: other.source,
        field: other.field,
        n: r.n,
        a: r.fit?.a ?? null,
        b: r.fit?.b ?? null,
        r2: r.fit?.r2 ?? null,
        used: r.used,
        ...(r.why ? { why: r.why } : {}),
      });
      const fit = r.used ? r.fit : null;
      if (!fit) continue;
      for (const k of table.get(`${other.source}.${other.field}`)?.values() ?? [])
        push(dim, other, k, fit.a * k.row.value + fit.b, {
          confidence: "calibrated",
          fit: { source: other.source, field: other.field, a: fit.a, b: fit.b, r2: fit.r2, n: fit.n },
        });
    }
  }
  scores.push(...adjacent(ctx.models.families, scores, ctx.now));

  const { facts, warnings } = factsOf(raw, ctx, map);
  return {
    schema: 1,
    builtAt: new Date(ctx.now).toISOString(),
    scores,
    facts,
    fits,
    unmatched: Object.fromEntries(Object.entries(unmatched).map(([s, ids]) => [s, [...ids].sort()])),
    warnings,
  };
}

/**
 * Spec 1.2 §4.3 `adjacent`: for each family effort a dimension has no synced value at, the best synced value
 * at the nearest effort that has one (the weaker on a tie). The shipped values are not spread this way: the
 * shipped file already says which efforts it carries.
 */
function adjacent(families: Family[], direct: Score[], now: number): Score[] {
  const out: Score[] = [];
  for (const f of families)
    for (const dim of DIMS) {
      const byEffort = new Map<string, Score>();
      for (const s of direct) {
        const { id, effort } = splitSourceRung(s.rung);
        if (id !== f.id || s.dim !== dim || effort === null) continue;
        const had = byEffort.get(effort);
        if (!had || outranks(s, had, now)) byEffort.set(effort, s);
      }
      if (byEffort.size === 0) continue;
      for (const e of familyEfforts(f)) {
        if (byEffort.has(e)) continue;
        const near = nearestEffort(e, [...byEffort.keys()]);
        const from = near ? byEffort.get(near) : undefined;
        if (!near || !from) continue;
        out.push({
          ...from,
          rung: `${f.id}#${e}`,
          confidence: "adjacent",
          note: `${from.source} has it at ${near}; carried to this effort`,
        });
      }
    }
  return out;
}

const differs = (a: number, b: number) => b !== 0 && Math.abs(a - b) / b > PRICE_TOLERANCE;
const money = (n: number) => `$${n}/M`;

/** Spec 1.2 §3.5: models.dev's facts per family, OpenRouter's speed facts, and the cross-check warnings. */
function factsOf(
  raw: RawAnswers,
  ctx: DeriveContext,
  map: IdMapper,
): { facts: Record<string, FamilyFacts>; warnings: string[] } {
  const md = raw["models-dev"]?.data;
  const orModels = raw["openrouter-models"] ? parseOpenRouterModels(raw["openrouter-models"].data) : [];
  const liteLlm = raw.litellm ? parseLiteLlm(raw.litellm.data) : [];
  const endpoints = raw["openrouter-endpoints"];
  const speedRows = endpoints
    ? parseOpenRouterEndpoints(endpoints.data as Record<string, unknown>, endpoints.fetchedAt)
    : [];
  const aa = raw["artificial-analysis"];
  const aaRows = aa ? parseArtificialAnalysis(aa.data as AaAnswer, aa.fetchedAt) : [];
  const facts: Record<string, FamilyFacts> = {};
  const warnings: string[] = [];
  for (const f of ctx.models.families) {
    const x: FamilyFacts = { on: {}, speed: {} };
    const vendor = (f as { vendor?: unknown }).vendor;
    const own = md && typeof vendor === "string" ? modelsDevFacts(md, vendor, f.id) : null;
    if (own?.price) x.price = own.price;
    if (own && own.toolUse !== null && own.imageIn !== null && own.reasoning !== null)
      x.capabilities = { toolUse: own.toolUse, imageIn: own.imageIn, reasoning: own.reasoning };
    if (own?.releaseDate) x.releaseDate = own.releaseDate;
    for (const key of OPENCODE_KEYS) {
      const on = f.on[key];
      const got = md && on ? modelsDevFacts(md, key, on.id.slice(on.id.indexOf("/") + 1)) : null;
      if (got)
        x.on[key] = {
          ...(got.efforts ? { efforts: got.efforts } : {}),
          ...(got.context ? { context: got.context } : {}),
        };
    }
    for (const r of speedRows) if (map.family(r.rung) === f) x.speed[`openrouter.${r.field}`] = r.value;
    const defaultRung = `${map.key(f.id)}#${defaultEffortOf(ctx.sources, f)}`;
    for (const r of aaRows) {
      const { id, effort } = splitSourceRung(r.rung);
      if (map.family(id) !== f || `${map.key(f.id)}#${effort}` !== defaultRung) continue;
      if (/^median_|^cost_per_task$/.test(r.field)) x.speed[`artificial-analysis.${r.field}`] = r.value;
    }
    if (x.price || x.capabilities || x.releaseDate || Object.keys(x.on).length || Object.keys(x.speed).length)
      facts[f.id] = x;
    if (own?.price) warnings.push(...priceWarnings(f, own.price, orModels, liteLlm, map));
    if (own?.efforts) warnings.push(...effortWarnings(f, own.efforts, liteLlm, map));
  }
  return { facts, warnings };
}

/** The first entry of `list` whose id maps to `f` (OpenRouter's `:batch` variants never do). */
const entryFor = <T extends { id: string }>(list: T[], f: Family, map: IdMapper): T | undefined =>
  list.find((m) => map.family(m.id) === f);

function priceWarnings(
  f: Family,
  price: { input: number; output: number },
  orModels: OpenRouterModel[],
  liteLlm: ReturnType<typeof parseLiteLlm>,
  map: IdMapper,
): string[] {
  const out: string[] = [];
  for (const [name, other] of [
    ["OpenRouter", entryFor(orModels, f, map)?.price],
    ["LiteLLM", entryFor(liteLlm, f, map)?.price],
  ] as const) {
    if (!other) continue;
    for (const side of ["input", "output"] as const)
      if (differs(other[side], price[side]))
        out.push(
          `${f.id}: ${side} price ${money(price[side])} on models.dev, ${money(other[side])} on ${name} (more than 10 % apart)`,
        );
  }
  return out;
}

function effortWarnings(
  f: Family,
  efforts: string[],
  liteLlm: ReturnType<typeof parseLiteLlm>,
  map: IdMapper,
): string[] {
  const entry = entryFor(liteLlm, f, map);
  if (!entry) return [];
  const out: string[] = [];
  for (const e of LITELLM_EFFORTS) {
    const says = entry.efforts[e];
    if (says === undefined || says === efforts.includes(e)) continue;
    out.push(
      `${f.id}: LiteLLM says effort ${e} is ${says ? "" : "not "}supported; models.dev ${says ? "does not list" : "lists"} it`,
    );
  }
  return out;
}

/** Plan 13 R-H: the OpenRouter id of each catalog family OpenRouter lists, one each, for the endpoints fetch. */
export function openRouterIds(
  orModelsData: unknown,
  ctx: Pick<DeriveContext, "models" | "sources">,
): string[] {
  const map = idMapper(ctx.models.families, ctx.sources.aliases);
  const models = parseOpenRouterModels(orModelsData);
  return ctx.models.families.flatMap((f) => {
    const m = entryFor(models, f, map);
    return m ? [m.id] : [];
  });
}
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun run format && bun test test/services/source-derive.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

````bash
git add src/domain/catalog.ts src/domain/sources.ts src/services/source-derive.ts test/services/source-derive.test.ts test/services/source-fixtures.ts
git commit -m "feat(sources): map, calibrate and merge the cached answers into synced values and facts"
````

---

### Task 11: The sync: TTL, lock, last good answers, routing on what it derived (spec 1.2 §3.2, §3.3, §11; Rulings 11–14, 16)

`syncSources` fetches what is due in parallel (OpenRouter's endpoints after its model list, R-H), caches each answer, keeps a failed source's last good one, writes `derived.json`/`calibration.json`, and reports; `backgroundSync` is its never-throwing, never-waiting boot form (off with `CATHERD_NO_SYNC=1`); `loadCatalog` reads `derived.json`. `bunfig.toml` preloads `test/preload.ts`, which sets `CATHERD_NO_SYNC=1` for the whole suite. The scratch commit `ca6a83b` (the default-profile test) is folded in.

**Files:**
- Create: `bunfig.toml`
- Modify: `src/infra/sources/cache.ts`
- Modify: `src/services/catalog-service.ts`
- Create: `src/services/source-sync.ts`
- Modify: `test/infra/sources/cache.test.ts`
- Create: `test/preload.ts`
- Create: `test/services/source-sync.test.ts`

**Interfaces:**
- Consumes: `derive`, `openRouterIds`, `type RawAnswers` (Task 10); every fetcher (Tasks 5–8); the cache (Task 4); `aaKey` (Task 9); `buildCatalog` (Tasks 1, 10); `validateNamed` (profile-store, tests).
- Produces: `src/infra/sources/cache.ts`: `SyncState` entries gain `fetchedAt: string | null`; `derivedPath()`, `calibrationPath()`, `readDerived(): Derived | null` (re-parsed only when the file changes), `writeDerived(d)`. `src/services/catalog-service.ts`: exports `shippedModels`, `shippedScores`, `readOverride`. `src/services/source-sync.ts`: `TTL_MS`, `shippedSources()`, `interface SyncOptions { force?; background?; transport?; aaKey?: string | null; now? }`, `interface SourceOutcome { source; state: "fetched" | "fresh" | "failed" | "skipped"; fetchedAt; error?; detail? }`, `interface SyncReport { busy; sources; newlyScored: string[]; noLongerNeeded: { rung; like }[]; failed: { source; error }[]; warnings; unmatched }`, `syncSources(o): Promise<SyncReport>`, `backgroundSync(o): Promise<SyncReport | null>`, `interface SourceStatus`, `sourcesStatus(): { sources; aaKey: boolean; rateLimitRemaining; rateLimitAt }`.

- [ ] **Step 1: Write the failing tests**

Edit `test/infra/sources/cache.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/infra/sources/cache.test.ts b/test/infra/sources/cache.test.ts
index d3707c3..da2d53a 100644
--- a/test/infra/sources/cache.test.ts
+++ b/test/infra/sources/cache.test.ts
@@ -1,13 +1,17 @@
 import { afterEach, describe, expect, it } from "bun:test";
-import { mkdirSync, statSync, writeFileSync } from "node:fs";
+import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
 import { dirname } from "node:path";
 import { sourcesDir } from "../../../src/infra/paths.ts";
 import {
   cachePath,
+  calibrationPath,
+  derivedPath,
   readCached,
+  readDerived,
   readSyncState,
   tryLockSync,
   writeCached,
+  writeDerived,
   writeSyncState,
 } from "../../../src/infra/sources/cache.ts";
 import { noPosixModes, snapshotEnv, withHome } from "../../helpers.ts";
@@ -50,12 +54,53 @@ describe("the source cache (spec 1.2 §3.3)", () => {
     writeSyncState({
       schema: 1,
       sources: {
-        arena: { lastAttemptAt: "2026-09-28T10:00:00.000Z", error: "http 503", rateLimitRemaining: null },
+        arena: {
+          fetchedAt: null,
+          lastAttemptAt: "2026-09-28T10:00:00.000Z",
+          error: "http 503",
+          rateLimitRemaining: null,
+        },
       },
     });
     expect(readSyncState().sources.arena?.error).toBe("http 503");
   });
 
+  it("keeps derived.json beside calibration.json, and reads a changed file again", () => {
+    withHome();
+    expect(readDerived()).toBeNull();
+    const d = {
+      schema: 1 as const,
+      builtAt: "2026-09-28T10:00:00.000Z",
+      scores: [],
+      facts: {},
+      fits: [
+        {
+          dim: "agentic" as const,
+          source: "arena",
+          field: "agent_bash_recovery_steps",
+          n: 12,
+          a: 1,
+          b: 0,
+          r2: 0.7,
+          used: true,
+        },
+      ],
+      unmatched: { arena: ["Kimi K3"] },
+      warnings: [],
+    };
+    writeDerived(d);
+    expect(readDerived()).toEqual(d);
+    expect(JSON.parse(readFileSync(calibrationPath(), "utf8"))).toEqual({
+      schema: 1,
+      builtAt: "2026-09-28T10:00:00.000Z",
+      fits: d.fits,
+    });
+    writeDerived({ ...d, warnings: ["gpt-6-sol: input price differs"] });
+    expect(readDerived()?.warnings).toEqual(["gpt-6-sol: input price differs"]);
+    writeFileSync(derivedPath(), "{broken");
+    expect(readDerived()).toBeNull();
+  });
+
   it("lets one sync hold the lock at a time", () => {
     withHome();
     const release = tryLockSync();
````

Create `test/preload.ts`:

````ts
// Loaded before every test file (bunfig.toml). The MCP server's boot sync and `init`'s sync would fetch the
// public sources (spec 1.2 §3.2); no test may reach the network, and every process a test starts with its
// env inherits this. A test of the sync itself deletes it and injects a fetch.
process.env.CATHERD_NO_SYNC = "1";
````

Create `test/services/source-sync.test.ts`:

````ts
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildCatalog } from "../../src/domain/catalog.ts";
import type { SourceId } from "../../src/domain/sources.ts";
import {
  calibrationPath,
  cachePath,
  derivedPath,
  readCached,
  readDerived,
  tryLockSync,
} from "../../src/infra/sources/cache.ts";
import { AA_MODELS_URL } from "../../src/infra/sources/artificial-analysis.ts";
import { MODELS_DEV_URL } from "../../src/infra/sources/models-dev.ts";
import { VECTARA_URL } from "../../src/infra/sources/vectara.ts";
import {
  loadCatalog,
  overridePath,
  saveTreatLike,
  shippedModels,
  shippedScores,
} from "../../src/services/catalog-service.ts";
import { validateNamed } from "../../src/services/profile-store.ts";
import { backgroundSync, sourcesStatus, syncSources, TTL_MS } from "../../src/services/source-sync.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { recordedFetch } from "./source-fixtures.ts";

afterEach(snapshotEnv());

const T0 = Date.parse("2026-09-28T10:00:00.000Z");
/** A clock the test moves; retries never wait for real. */
function clock(start = T0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => void (t += ms),
    transport: (impl: typeof fetch) => ({
      fetchImpl: impl,
      now: () => t,
      sleep: async (ms: number) => void (t += ms),
      random: () => 0.5,
    }),
  };
}
const KEYLESS: SourceId[] = [
  "models-dev",
  "openrouter-models",
  "openrouter-endpoints",
  "litellm",
  "arena",
  "vectara",
  "epoch",
];

describe("the sync (spec 1.2 §3.2, §3.3)", () => {
  it("fetches every keyless source, caches each answer with its fetch time, and derives the synced values", async () => {
    withHome();
    const c = clock();
    const f = recordedFetch();
    const r = await syncSources({ transport: c.transport(f.impl), now: c.now, aaKey: null });
    expect(r.busy).toBe(false);
    expect(r.sources.filter((s) => s.state === "fetched").map((s) => s.source)).toEqual(KEYLESS);
    expect(r.sources.find((s) => s.source === "artificial-analysis")).toMatchObject({ state: "skipped" });
    // 1 + 1 + 1 + 6 Arena configs + 1 + 1 + one endpoints request per family OpenRouter lists (4)
    expect(f.urls).toHaveLength(15);
    expect(f.urls).not.toContain(AA_MODELS_URL);
    expect(readCached("vectara")?.fetchedAt).toBe("2026-09-28T10:00:00.000Z");
    expect(existsSync(derivedPath())).toBe(true);
    expect(JSON.parse(readFileSync(calibrationPath(), "utf8")).fits.length).toBeGreaterThan(0);
    expect(r.failed).toEqual([]);
    expect(r.unmatched.vectara).toEqual(["antgroup/finix_s1_32b", "google/gemini-2.5-pro", "openai/gpt-5.5"]);
  });

  it("reports the rungs newly scored, and routing reads them at once", async () => {
    withHome();
    const c = clock();
    const r = await syncSources({ transport: c.transport(recordedFetch().impl), now: c.now, aaKey: null });
    // Opus 5.5 high had only a shipped treat-like; Arena scores it on its own
    expect(r.newlyScored).toContain("claude-opus-5-5#high");
    expect(r.newlyScored).not.toContain("gpt-6-sol#max");
    expect(loadCatalog({ timings: false }).scores["claude-opus-5-5#high"]?.agentic?.value).toBe(0.1215);
  });

  it("fetches a source only when its answer is older than 12 hours, unless forced", async () => {
    withHome();
    const c = clock();
    await syncSources({ transport: c.transport(recordedFetch().impl), now: c.now, aaKey: null });
    c.advance(TTL_MS - 1);
    const again = recordedFetch();
    const r = await syncSources({ transport: c.transport(again.impl), now: c.now, aaKey: null });
    expect(again.urls).toEqual([]);
    expect(r.sources.filter((s) => s.state === "fresh").map((s) => s.source)).toEqual(KEYLESS);
    const forced = recordedFetch();
    await syncSources({ force: true, transport: c.transport(forced.impl), now: c.now, aaKey: null });
    expect(forced.urls).toHaveLength(15);
    c.advance(TTL_MS);
    const due = recordedFetch();
    await syncSources({ transport: c.transport(due.impl), now: c.now, aaKey: null });
    expect(due.urls).toHaveLength(15);
  });

  it("keeps a failed source's last good answer, records the error and goes on", async () => {
    withHome();
    const c = clock();
    await syncSources({ transport: c.transport(recordedFetch().impl), now: c.now, aaKey: null });
    const good = readFileSync(cachePath("vectara"), "utf8");
    c.advance(TTL_MS);
    const r = await syncSources({
      transport: c.transport(recordedFetch({ fail: (u) => u === VECTARA_URL }).impl),
      now: c.now,
      aaKey: null,
    });
    expect(r.failed).toEqual([{ source: "vectara", error: "network error" }]);
    expect(r.sources.find((s) => s.source === "vectara")).toMatchObject({
      state: "failed",
      fetchedAt: "2026-09-28T10:00:00.000Z",
    });
    expect(readFileSync(cachePath("vectara"), "utf8")).toBe(good);
    expect(r.sources.filter((s) => s.state === "fetched")).toHaveLength(KEYLESS.length - 1);
    expect(sourcesStatus().sources.find((s) => s.source === "vectara")?.error).toBe("network error");
  });

  it("gives a failing source an hour's rest in the background, never in the foreground", async () => {
    withHome();
    const c = clock();
    const down = (u: string) => u === MODELS_DEV_URL;
    await syncSources({
      transport: c.transport(recordedFetch({ fail: down }).impl),
      now: c.now,
      aaKey: null,
    });
    c.advance(60_000);
    const bg = recordedFetch();
    const r = await syncSources({
      background: true,
      transport: c.transport(bg.impl),
      now: c.now,
      aaKey: null,
    });
    expect(bg.urls).toEqual([]);
    expect(r.sources.find((s) => s.source === "models-dev")?.state).toBe("skipped");
    const fg = recordedFetch();
    await syncSources({ transport: c.transport(fg.impl), now: c.now, aaKey: null });
    expect(fg.urls).toEqual([MODELS_DEV_URL]);
  });

  it("does nothing in the background while another sync holds the lock", async () => {
    withHome();
    const release = tryLockSync();
    const f = recordedFetch();
    const r = await syncSources({ background: true, transport: clock().transport(f.impl), aaKey: null });
    release?.();
    expect([r.busy, f.urls.length]).toEqual([true, 0]);
  });

  it("says when the user's stand-in is no longer needed, and never removes it", async () => {
    withHome();
    // Sol high borrows agentic from a rung only the user scored: Arena's Sol max values cover it after a sync
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(
      overridePath(),
      JSON.stringify({
        schema: 1,
        scores: [
          {
            rung: "yardstick#high",
            dim: "agentic",
            value: 0.05,
            benchmark: "mine",
            version: "1",
            url: "https://example.com/mine",
            date: "2026-09-27",
            confidence: "verified",
          },
        ],
      }),
    );
    await saveTreatLike("gpt-6-sol#high", "yardstick#high");
    const c = clock();
    const r = await syncSources({ transport: c.transport(recordedFetch().impl), now: c.now, aaKey: null });
    expect(r.noLongerNeeded).toEqual([{ rung: "gpt-6-sol#high", like: "yardstick#high" }]);
    expect(loadCatalog({ timings: false }).treatLike["gpt-6-sol#high"]).toEqual({
      like: "yardstick#high",
      source: "user",
    });
  });

  it("reads Artificial Analysis with the key and keeps its requests left", async () => {
    withHome();
    const c = clock();
    const f = recordedFetch();
    const r = await syncSources({ transport: c.transport(f.impl), now: c.now, aaKey: "aa-key-0123456789" });
    expect(r.sources.find((s) => s.source === "artificial-analysis")?.state).toBe("fetched");
    expect(f.urls).toContain(AA_MODELS_URL);
    process.env.ARTIFICIAL_ANALYSIS_API_KEY = "aa-key-0123456789";
    expect(sourcesStatus()).toMatchObject({
      aaKey: true,
      rateLimitRemaining: 98,
      rateLimitAt: "2026-09-28T10:00:00.000Z",
    });
  });
});

describe("the shipped defaults after a sync (plan 13 R-A)", () => {
  it("leave the default profile valid, with no warning, before and after a sync of the recorded answers", async () => {
    withHome();
    expect(validateNamed("default")).toEqual({ errors: [], warnings: [] });
    const c = clock();
    await syncSources({ transport: c.transport(recordedFetch().impl), now: c.now, aaKey: null });
    expect(validateNamed("default")).toEqual({ errors: [], warnings: [] });
  });
});

describe("offline (spec 1.2 §11)", () => {
  it("with no network and no cache, routing reads the shipped values", async () => {
    withHome();
    const c = clock();
    const r = await syncSources({
      transport: c.transport(recordedFetch({ fail: () => true }).impl),
      now: c.now,
      aaKey: null,
    });
    expect(r.failed.map((x) => x.source)).toEqual(KEYLESS);
    expect(readDerived()).toBeNull();
    const shipped = buildCatalog({ models: shippedModels(), scores: shippedScores() });
    const c2 = loadCatalog({ timings: false });
    expect(c2.scores).toEqual(shipped.scores);
    expect(c2.families).toEqual(shipped.families);
  });
});

describe("the background sync (spec 1.2 §3.2)", () => {
  it("is off with CATHERD_NO_SYNC=1, as in every test", async () => {
    withHome();
    expect(process.env.CATHERD_NO_SYNC).toBe("1");
    const f = recordedFetch();
    expect(await backgroundSync({ transport: clock().transport(f.impl), aaKey: null })).toBeNull();
    expect(f.urls).toEqual([]);
  });

  it("runs otherwise, and never throws", async () => {
    withHome();
    delete process.env.CATHERD_NO_SYNC;
    const c = clock();
    const r = await backgroundSync({ transport: c.transport(recordedFetch().impl), now: c.now, aaKey: null });
    expect(r?.sources.filter((s) => s.state === "fetched")).toHaveLength(KEYLESS.length);
  });
});
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/services/source-sync.test.ts test/infra/sources/cache.test.ts`
Expected: FAIL: `Cannot find module "../../src/services/source-sync.ts"`, and `readDerived` is not exported by cache.ts.

- [ ] **Step 3: Implement**

Create `bunfig.toml`:

````toml
[test]
# spec 1.2 §3.2: no test process, and no process a test starts with its env, syncs the public sources
preload = ["./test/preload.ts"]
````

Edit `src/infra/sources/cache.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/infra/sources/cache.ts b/src/infra/sources/cache.ts
index dc6919d..a030e37 100644
--- a/src/infra/sources/cache.ts
+++ b/src/infra/sources/cache.ts
@@ -1,8 +1,8 @@
-import { existsSync } from "node:fs";
+import { existsSync, statSync } from "node:fs";
 import { join } from "node:path";
 import { z } from "zod";
 import { errorMessage } from "../../domain/errors.ts";
-import type { SourceId } from "../../domain/sources.ts";
+import { type Derived, DerivedSchema, type SourceId } from "../../domain/sources.ts";
 import { tryLock } from "../filelock.ts";
 import { log } from "../log.ts";
 import { sourcesDir } from "../paths.ts";
@@ -53,6 +53,8 @@ const StateSchema = z.looseObject({
     .record(
       z.string(),
       z.looseObject({
+        /** when the cached answer was fetched (its TTL runs from here); null before a first success */
+        fetchedAt: z.iso.datetime().nullable().default(null),
         lastAttemptAt: z.iso.datetime(),
         error: z.string().nullable(),
         /** Artificial Analysis: `x-ratelimit-remaining` of its last answer */
@@ -84,3 +86,39 @@ export function tryLockSync(): (() => void) | null {
   ensurePrivateDir(sourcesDir());
   return tryLock(join(sourcesDir(), "sync"));
 }
+
+export const derivedPath = (): string => join(sourcesDir(), "derived.json");
+/** Spec 1.2 §4.2: every fit with its R², used or not. */
+export const calibrationPath = (): string => join(sourcesDir(), "calibration.json");
+
+let memo: { mtimeMs: number; size: number; file: string; derived: Derived | null } | null = null;
+
+/**
+ * What the last sync derived; null when never synced or unreadable (routing then reads the shipped values
+ * alone). Read on every catalog load, so it is parsed again only when the file changes.
+ */
+export function readDerived(): Derived | null {
+  const file = derivedPath();
+  let st: { mtimeMs: number; size: number };
+  try {
+    st = statSync(file);
+  } catch {
+    return null;
+  }
+  if (memo?.file === file && memo.mtimeMs === st.mtimeMs && memo.size === st.size) return memo.derived;
+  let derived: Derived | null = null;
+  try {
+    derived = readVersioned(file, DerivedSchema, 1);
+  } catch (e) {
+    log("debug", "sources", { derived: errorMessage(e) });
+  }
+  memo = { file, mtimeMs: st.mtimeMs, size: st.size, derived };
+  return derived;
+}
+
+/** Writes derived.json and calibration.json atomically. */
+export function writeDerived(d: Derived): void {
+  memo = null;
+  writeTextAtomic(derivedPath(), `${JSON.stringify(d)}\n`);
+  writeJsonAtomic(calibrationPath(), { schema: 1, builtAt: d.builtAt, fits: d.fits });
+}
````

Edit `src/services/catalog-service.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/catalog-service.ts b/src/services/catalog-service.ts
index 9e1f23d..deacf44 100644
--- a/src/services/catalog-service.ts
+++ b/src/services/catalog-service.ts
@@ -31,6 +31,7 @@ import { assetPath } from "../infra/assets.ts";
 import { withFileLock } from "../infra/filelock.ts";
 import { log } from "../infra/log.ts";
 import { configDir } from "../infra/paths.ts";
+import { readDerived } from "../infra/sources/cache.ts";
 import { ensurePrivateDir, readVersioned, writeJsonAtomic } from "../infra/store.ts";
 import type { CatalogFilter } from "./ports.ts";
 import { listRuns, readAgentRuns, readRecords, readRoutes } from "./run-store.ts";
@@ -41,14 +42,14 @@ const MIN_SAMPLES = 5;
 
 let models: ModelsFile | null = null;
 let scores: ScoresFile | null = null;
-const shippedModels = (): ModelsFile =>
+export const shippedModels = (): ModelsFile =>
   (models ??= readVersioned(assetPath("catalog/models.json"), ModelsFileSchema, 1));
-const shippedScores = (): ScoresFile =>
+export const shippedScores = (): ScoresFile =>
   (scores ??= readVersioned(assetPath("catalog/scores.json"), ScoresFileSchema, 1));
 
 export const overridePath = (): string => join(configDir(), "catalog.override.json");
 
-function readOverride(): Override {
+export function readOverride(): Override {
   const file = overridePath();
   return existsSync(file) ? readVersioned(file, OverrideSchema, 1) : OverrideSchema.parse({});
 }
@@ -119,9 +120,13 @@ export function measuredSecs(base: Catalog): Catalog["secs"] {
  * override and, unless `timings: false`, own timings.
  */
 export function loadCatalog(o: { timings?: boolean; repo?: string } = {}): Catalog {
+  // spec 1.2 §3.2: whatever the last sync derived; without one (first run, offline), the shipped values alone
+  const synced = readDerived();
   const base = buildCatalog({
     models: shippedModels(),
     scores: shippedScores(),
+    synced: synced?.scores,
+    facts: synced?.facts,
     override: readOverride(),
     listed: listedModels(o.repo),
   });
````

Create `src/services/source-sync.ts`:

````ts
import { existsSync } from "node:fs";
import { buildCatalog, type Catalog, DIMS } from "../domain/catalog.ts";
import { CatherdError, errorMessage } from "../domain/errors.ts";
import {
  type Derived,
  SOURCE_IDS,
  type SourceId,
  type SourcesFile,
  SourcesFileSchema,
} from "../domain/sources.ts";
import { assetPath } from "../infra/assets.ts";
import { log } from "../infra/log.ts";
import { type AaAnswer, fetchArtificialAnalysis } from "../infra/sources/artificial-analysis.ts";
import { fetchArena } from "../infra/sources/arena.ts";
import {
  cachePath,
  derivedPath,
  readCached,
  readDerived,
  readSyncState,
  tryLockSync,
  writeCached,
  writeDerived,
  writeSyncState,
} from "../infra/sources/cache.ts";
import { fetchEpoch } from "../infra/sources/epoch.ts";
import { rateLimitRemaining, SourceError, type SourceTransport } from "../infra/sources/http.ts";
import { fetchLiteLlm } from "../infra/sources/litellm.ts";
import { fetchModelsDev } from "../infra/sources/models-dev.ts";
import { fetchOpenRouterEndpoints } from "../infra/sources/openrouter-endpoints.ts";
import { fetchOpenRouterModels } from "../infra/sources/openrouter-models.ts";
import { fetchVectara } from "../infra/sources/vectara.ts";
import { readVersioned } from "../infra/store.ts";
import { readOverride, shippedModels, shippedScores } from "./catalog-service.ts";
import { aaKey } from "./credentials.ts";
import { derive, openRouterIds, type RawAnswers } from "./source-derive.ts";

/** Spec 1.2 §3.2: one TTL for every source. */
export const TTL_MS = 12 * 3_600_000;
/** A source whose last attempt failed waits this long before a background sync tries it again. */
const BACKOFF_MS = 3_600_000;
/** How long a foreground sync waits for one already running. */
const LOCK_WAIT_MS = 120_000;

let sourcesFile: SourcesFile | null = null;
/** `catalog/sources.json`: the sources, their licenses and attribution lines, the aliases. */
export const shippedSources = (): SourcesFile =>
  (sourcesFile ??= readVersioned(assetPath("catalog/sources.json"), SourcesFileSchema, 1));

export interface SyncOptions {
  /** ignore the TTL (and a failing source's backoff) */
  force?: boolean;
  /** the MCP server's boot sync: skips when another sync runs, and gives a failing source an hour's rest */
  background?: boolean;
  /** how every source is fetched; tests replace it */
  transport?: SourceTransport;
  /** the Artificial Analysis key; default: the env's, else the saved one */
  aaKey?: string | null;
  now?: () => number;
}

export interface SourceOutcome {
  source: SourceId;
  /** fetched now; fresh (within the TTL); failed (the last good answer kept); skipped (no key, or backing off) */
  state: "fetched" | "fresh" | "failed" | "skipped";
  /** when the answer in the cache was fetched; null when there is none */
  fetchedAt: string | null;
  error?: string;
  detail?: string;
}

export interface SyncReport {
  /** another sync held the lock (a background sync never waits): nothing was done */
  busy: boolean;
  sources: SourceOutcome[];
  /** canonical rungs with no value of their own before this sync and at least one after */
  newlyScored: string[];
  /** the user's treat-likes whose rung now has its own value on every dimension the stand-in lent */
  noLongerNeeded: { rung: string; like: string }[];
  failed: { source: SourceId; error: string }[];
  /** the cross-checks that failed (spec 1.2 §3.5) */
  warnings: string[];
  /** each source's ids no family matched (spec 1.2 §3.4) */
  unmatched: Record<string, string[]>;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** The catalog as routing would read it with `derived` as the synced layer. */
const catalogWith = (derived: Derived | null, now: number): Catalog =>
  buildCatalog({
    models: shippedModels(),
    scores: shippedScores(),
    synced: derived?.scores,
    facts: derived?.facts,
    override: readOverride(),
    now,
  });

const scored = (c: Catalog): Set<string> =>
  new Set(Object.entries(c.scores).flatMap(([rung, dims]) => (Object.keys(dims).length ? [rung] : [])));

async function takeLock(background: boolean): Promise<(() => void) | null> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const release = tryLockSync();
    if (release || background) return release;
    if (Date.now() > deadline)
      throw new CatherdError("E_IO_LOCK", "another catalog sync is still running", {
        fix: "wait for it to finish, then run catherd catalog sync again",
      });
    await Bun.sleep(200);
  }
}

/** Every cached answer, as `derive` reads them. */
function cachedAnswers(): RawAnswers {
  const raw: RawAnswers = {};
  for (const id of SOURCE_IDS) {
    const c = readCached(id);
    if (c) raw[id] = { fetchedAt: c.fetchedAt, data: c.data };
  }
  return raw;
}

/**
 * Spec 1.2 §3.2, §3.3: fetches every source whose cached answer is older than the TTL (every source with
 * `force`), all in parallel, and writes each answer atomically with its fetch time. A source that fails keeps
 * its last good answer; the sync records the error and goes on. Then it derives the synced values from every
 * cached answer. One sync runs at a time: a background sync skips when another holds the lock, a foreground
 * one waits for it.
 */
export async function syncSources(o: SyncOptions = {}): Promise<SyncReport> {
  const now = o.now ?? Date.now;
  const release = await takeLock(o.background === true);
  if (!release)
    return {
      busy: true,
      sources: [],
      newlyScored: [],
      noLongerNeeded: [],
      failed: [],
      warnings: [],
      unmatched: {},
    };
  try {
    const before = catalogWith(readDerived(), now());
    const state = readSyncState();
    const key = o.aaKey === undefined ? aaKey() : o.aaKey;
    const t = o.transport ?? {};
    const outcomes = new Map<SourceId, SourceOutcome>();
    const fetchedAt = (id: SourceId) => state.sources[id]?.fetchedAt ?? null;
    const fresh = (id: SourceId) => {
      const at = fetchedAt(id);
      return !o.force && at !== null && existsSync(cachePath(id)) && now() - Date.parse(at) < TTL_MS;
    };
    const resting = (id: SourceId) => {
      const s = state.sources[id];
      return o.background && !o.force && s?.error && now() - Date.parse(s.lastAttemptAt) < BACKOFF_MS;
    };

    const run = async (id: SourceId, fetcher: () => Promise<unknown>): Promise<void> => {
      if (fresh(id)) return void outcomes.set(id, { source: id, state: "fresh", fetchedAt: fetchedAt(id) });
      if (resting(id))
        return void outcomes.set(id, {
          source: id,
          state: "skipped",
          fetchedAt: fetchedAt(id),
          detail: "failed within the hour; the next sync tries again",
        });
      const at = now();
      const prev = state.sources[id];
      try {
        const data = await fetcher();
        writeCached(id, data, at);
        const limit = id === "artificial-analysis" ? (data as AaAnswer).rateLimitRemaining : null;
        state.sources[id] = {
          fetchedAt: iso(at),
          lastAttemptAt: iso(at),
          error: null,
          rateLimitRemaining: limit,
        };
        outcomes.set(id, { source: id, state: "fetched", fetchedAt: iso(at) });
      } catch (e) {
        const error = errorMessage(e);
        const limit = e instanceof SourceError ? rateLimitRemaining(e.headers) : null;
        state.sources[id] = {
          fetchedAt: prev?.fetchedAt ?? null,
          lastAttemptAt: iso(at),
          error,
          rateLimitRemaining: limit ?? prev?.rateLimitRemaining ?? null,
        };
        outcomes.set(id, { source: id, state: "failed", fetchedAt: prev?.fetchedAt ?? null, error });
        log(o.background ? "debug" : "warn", "sources", { source: id, error });
      }
    };

    const orModels = run("openrouter-models", () => fetchOpenRouterModels(t));
    const jobs: Promise<void>[] = [
      orModels,
      run("models-dev", () => fetchModelsDev(t)),
      run("litellm", () => fetchLiteLlm(t)),
      run("arena", () => fetchArena(t)),
      run("vectara", () => fetchVectara(t)),
      run("epoch", () => fetchEpoch(t)),
      // plan 13 R-H: one request per catalog family OpenRouter lists, so it waits for OpenRouter's model list
      orModels.then(() =>
        run("openrouter-endpoints", async () => {
          const list = readCached("openrouter-models");
          if (!list) throw new Error("no OpenRouter model list to take the ids from");
          const ids = openRouterIds(list.data, { models: shippedModels(), sources: shippedSources() });
          return fetchOpenRouterEndpoints(ids, t);
        }),
      ),
    ];
    if (key) jobs.push(run("artificial-analysis", () => fetchArtificialAnalysis(key, t)));
    else
      outcomes.set("artificial-analysis", {
        source: "artificial-analysis",
        state: "skipped",
        fetchedAt: fetchedAt("artificial-analysis"),
        detail: "no key: catherd init, or export ARTIFICIAL_ANALYSIS_API_KEY",
      });
    await Promise.all(jobs);
    writeSyncState(state);

    const changed = [...outcomes.values()].some((x) => x.state === "fetched");
    const raw = cachedAnswers();
    if ((changed || !existsSync(derivedPath())) && Object.keys(raw).length > 0)
      writeDerived(
        derive(raw, {
          models: shippedModels(),
          scores: shippedScores(),
          sources: shippedSources(),
          now: now(),
        }),
      );
    const derived = readDerived();
    const after = catalogWith(derived, now());
    const had = scored(before);
    const noLongerNeeded = Object.entries(after.treatLike).flatMap(([rung, t]) => {
      if (t.source !== "user") return [];
      const lends = DIMS.filter((d) => after.scores[t.like]?.[d]);
      const covered = (c: Catalog) => lends.length > 0 && lends.every((d) => c.scores[rung]?.[d]);
      return covered(after) && !covered(before) ? [{ rung, like: t.like }] : [];
    });
    const sources = SOURCE_IDS.map((id) => outcomes.get(id)).filter(
      (x): x is SourceOutcome => x !== undefined,
    );
    return {
      busy: false,
      sources,
      newlyScored: [...scored(after)].filter((r) => !had.has(r)).sort(),
      noLongerNeeded,
      failed: sources.flatMap((s) =>
        s.state === "failed" ? [{ source: s.source, error: s.error ?? "" }] : [],
      ),
      warnings: derived?.warnings ?? [],
      unmatched: derived?.unmatched ?? {},
    };
  } finally {
    release();
  }
}

/**
 * Spec 1.2 §3.2: the MCP server's boot sync, started without awaiting it. It never throws (a failure is
 * logged at debug) and never waits for another sync. `CATHERD_NO_SYNC=1` turns it off (tests, air-gapped
 * machines), as it does `init`'s sync; `catherd catalog sync` still runs.
 */
export function backgroundSync(o: SyncOptions = {}): Promise<SyncReport | null> {
  if (process.env.CATHERD_NO_SYNC === "1") return Promise.resolve(null);
  return syncSources({ ...o, background: true }).catch((e: unknown) => {
    log("debug", "sources", { error: errorMessage(e) });
    return null;
  });
}

export interface SourceStatus {
  source: SourceId;
  name: string;
  /** when its cached answer was fetched; null when never */
  fetchedAt: string | null;
  error: string | null;
}

/** Spec 1.2 §9 doctor: each source's last fetch and error, the AA key, and AA's requests left. */
export function sourcesStatus(): {
  sources: SourceStatus[];
  aaKey: boolean;
  rateLimitRemaining: number | null;
  rateLimitAt: string | null;
} {
  const state = readSyncState();
  const aa = state.sources["artificial-analysis"];
  return {
    sources: shippedSources().sources.map((s) => ({
      source: s.id,
      name: s.name,
      fetchedAt: state.sources[s.id]?.fetchedAt ?? null,
      error: state.sources[s.id]?.error ?? null,
    })),
    aaKey: aaKey() !== null,
    rateLimitRemaining: aa?.rateLimitRemaining ?? null,
    rateLimitAt: aa?.rateLimitRemaining === null || aa === undefined ? null : aa.lastAttemptAt,
  };
}
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun run format && bun test test/services/source-sync.test.ts test/infra/sources/cache.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS (12 + 6 tests). Then run the **whole suite once** (`bun test`): the preload must leave every other test as it was (about 1535 pass at this point, 0 fail).

- [ ] **Step 5: Commit**

````bash
git add bunfig.toml src/infra/sources/cache.ts src/services/catalog-service.ts src/services/source-sync.ts test/infra/sources/cache.test.ts test/preload.ts test/services/source-sync.test.ts
git commit -m "feat(sources): the sync, with its TTL, lock, last good answers, and routing on what it derived"
````

---

### Task 12: `catherd catalog sync`, the `catalog_sync` tool and the MCP server's boot sync (spec 1.2 §3.2, §9; Rulings 19, 20)

The CLI subcommand (and `syncLines`, which `init` reuses in Task 14), the 26th MCP tool through an optional `Deps.sync`, and `startMcpServer` starting `backgroundSync` right after `connect` without awaiting it (it takes a test transport and sync). README documents the command, the sync and the two env vars; `test/pack-smoke.ts` passes `CATHERD_NO_SYNC=1` (scratch commit `31d04e0`, folded in).

**Files:**
- Modify: `README.md`
- Modify: `src/entry/catalog-command.ts`
- Modify: `src/entry/mcp/server.ts`
- Modify: `src/entry/mcp/setup-tools.ts`
- Modify: `src/services/ports.ts`
- Modify: `test/entry/catalog-command.test.ts`
- Create: `test/entry/mcp-sync.test.ts`
- Modify: `test/entry/mcp.test.ts`
- Modify: `test/pack-smoke.ts`

**Interfaces:**
- Consumes: `syncSources`, `backgroundSync`, `type SyncReport` (Task 11); `readDerived` (Task 11).
- Produces: `src/entry/catalog-command.ts`: `syncLines(r: SyncReport, plain?): string[]` and the `sync` subcommand (`--force`, `--unmatched`, `--json`). `src/services/ports.ts`: `Deps.sync?: (o: { force: boolean }) => Promise<SyncReport>`. `src/entry/mcp/server.ts`: `startMcpServer(o: { transport?: Transport; sync?: () => Promise<unknown> } = {})`. MCP tool `catalog_sync({ force = false })` → `{ newlyScored, standInsNoLongerNeeded, failed, sources, warnings, busy? }`.

- [ ] **Step 1: Write the failing tests**

Edit `test/entry/catalog-command.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/entry/catalog-command.test.ts b/test/entry/catalog-command.test.ts
index 71fa215..85bc111 100644
--- a/test/entry/catalog-command.test.ts
+++ b/test/entry/catalog-command.test.ts
@@ -3,7 +3,9 @@ import { mkdtempSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
 import { writeDiscovery } from "../../src/adapters/discovery.ts";
+import { syncLines } from "../../src/entry/catalog-command.ts";
 import { overridePath } from "../../src/services/catalog-service.ts";
+import type { SyncReport } from "../../src/services/source-sync.ts";
 import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
 
 afterEach(snapshotEnv());
@@ -117,3 +119,43 @@ describe("catherd catalog", () => {
     expect(text).not.toContain("previous listing");
   });
 });
+
+describe("catherd catalog sync (spec 1.2 §9)", () => {
+  it("takes --force, --unmatched and --json", () => {
+    withHome();
+    const r = catherd("sync", "--help");
+    expect(r.code).toBe(0);
+    for (const flag of ["--force", "--unmatched", "--json"]) expect(r.out).toContain(flag);
+  });
+
+  it("prints a line per source, then the rungs newly scored, the stand-ins no longer needed and the warnings", () => {
+    const report: SyncReport = {
+      busy: false,
+      sources: [
+        { source: "models-dev", state: "fetched", fetchedAt: "2026-09-28T10:00:00.000Z" },
+        { source: "arena", state: "fresh", fetchedAt: "2026-09-28T04:00:00.000Z" },
+        { source: "vectara", state: "failed", fetchedAt: "2026-09-27T10:00:00.000Z", error: "http 503" },
+        { source: "epoch", state: "failed", fetchedAt: null, error: "network error" },
+        { source: "artificial-analysis", state: "skipped", fetchedAt: null, detail: "no key: catherd init" },
+      ],
+      newlyScored: ["claude-opus-5-5#high"],
+      noLongerNeeded: [{ rung: "gpt-6-sol#high", like: "yardstick#high" }],
+      failed: [],
+      warnings: ["gpt-6-sol: input price $2/M on models.dev, $2.5/M on OpenRouter (more than 10 % apart)"],
+      unmatched: {},
+    };
+    expect(syncLines(report, true)).toEqual([
+      "+ models-dev: fetched",
+      "- arena: fresh (fetched 2026-09-28T04:00:00.000Z)",
+      "! vectara: http 503; keeps the answer fetched 2026-09-27T10:00:00.000Z",
+      "! epoch: network error; no earlier answer",
+      "- artificial-analysis: no key: catherd init",
+      "newly scored: claude-opus-5-5#high",
+      "stand-in no longer needed: gpt-6-sol#high has values of its own for what yardstick#high lent it",
+      "! gpt-6-sol: input price $2/M on models.dev, $2.5/M on OpenRouter (more than 10 % apart)",
+    ]);
+    expect(syncLines({ ...report, busy: true })).toEqual([
+      "- sources: another sync is running; its results apply when it ends",
+    ]);
+  });
+});
````

Create `test/entry/mcp-sync.test.ts`:

````ts
import { afterEach, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startMcpServer } from "../../src/entry/mcp/server.ts";
import { backgroundSync, type SyncReport } from "../../src/services/source-sync.ts";
import { fakeFetch } from "../fake-fetch.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { call, mcpClient } from "../mcp-helpers.ts";
import { fakeDeps } from "../services/helpers.ts";

afterEach(snapshotEnv());

const REPORT: SyncReport = {
  busy: false,
  sources: [{ source: "arena", state: "fetched", fetchedAt: "2026-09-28T10:00:00.000Z" }],
  newlyScored: ["claude-opus-5-5#high"],
  noLongerNeeded: [{ rung: "gpt-6-sol#high", like: "yardstick#high" }],
  failed: [{ source: "vectara", error: "http 503" }],
  warnings: [],
  unmatched: { arena: ["Kimi K3"] },
};

describe("catalog_sync (spec 1.2 §9)", () => {
  it("syncs, forced when asked, and returns the rungs newly scored, the stand-ins no longer needed and what failed", async () => {
    withHome();
    const asked: { force: boolean }[] = [];
    const c = await mcpClient({
      ...fakeDeps(),
      sync: async (o) => {
        asked.push(o);
        return REPORT;
      },
    });
    const r = await call(c, "catalog_sync", { force: true });
    expect(asked).toEqual([{ force: true }]);
    expect(r.data).toEqual({
      newlyScored: ["claude-opus-5-5#high"],
      standInsNoLongerNeeded: [{ rung: "gpt-6-sol#high", like: "yardstick#high" }],
      failed: [{ source: "vectara", error: "http 503" }],
      sources: REPORT.sources,
      warnings: [],
    });
    await call(c, "catalog_sync");
    expect(asked[1]).toEqual({ force: false });
  });

  it("says so when another sync was running", async () => {
    withHome();
    const c = await mcpClient({ ...fakeDeps(), sync: async () => ({ ...REPORT, busy: true }) });
    expect((await call(c, "catalog_sync")).data.busy).toBe(
      "another sync was running; call catalog_sync again",
    );
  });
});

describe("the boot sync (spec 1.2 §3.2)", () => {
  it("never delays the handshake or a tool call, even when every source hangs", async () => {
    withHome();
    delete process.env.CATHERD_NO_SYNC;
    const hang = fakeFetch("hang");
    let started = false;
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await startMcpServer({
      transport: serverSide,
      sync: () => {
        started = true;
        return backgroundSync({ transport: { fetchImpl: hang.impl }, aaKey: null });
      },
    });
    const client = new Client({ name: "catherd-test", version: "0.0.0" });
    await client.connect(clientSide);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("catalog_sync");
    expect((await call(client, "status")).isError).toBe(false);
    expect(started).toBe(true);
    // the sync is under way, its requests unanswered
    expect(hang.sent.length).toBeGreaterThan(0);
    await client.close();
  });
});
````

Edit `test/entry/mcp.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/entry/mcp.test.ts b/test/entry/mcp.test.ts
index 3684558..040b1dd 100644
--- a/test/entry/mcp.test.ts
+++ b/test/entry/mcp.test.ts
@@ -12,7 +12,7 @@ import { fakeDeps, fakeGit, freshRun, writeLane } from "../services/helpers.ts";
 
 afterEach(snapshotEnv());
 
-/** Spec §4.8 and the 1.1 spec §14 (plan 10: `wait` removed, `peek` added), exactly. */
+/** Spec §4.8, the 1.1 spec §14 (plan 10: `wait` removed, `peek` added) and 1.2 §9 (`catalog_sync`), exactly. */
 const TOOLS = [
   "run_start",
   "route",
@@ -32,6 +32,7 @@ const TOOLS = [
   "record_agent_run",
   "runs_summary",
   "catalog_query",
+  "catalog_sync",
   "profile_get",
   "profile_validate",
   "profile_set",
@@ -42,9 +43,10 @@ const TOOLS = [
 ];
 
 describe("MCP server", () => {
-  it("lists exactly the 1.1 tools", async () => {
+  it("lists exactly the 1.2 tools, 26 of them", async () => {
     freshRun();
     const c = await mcpClient();
+    expect(TOOLS).toHaveLength(26);
     expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
     const described = (name: string) =>
       c.listTools().then((l) => l.tools.find((t) => t.name === name)?.description ?? "");
````

Edit `test/pack-smoke.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/pack-smoke.ts b/test/pack-smoke.ts
index 746e3f6..caf848a 100644
--- a/test/pack-smoke.ts
+++ b/test/pack-smoke.ts
@@ -70,7 +70,10 @@ const env = {
   CLAUDE_CONFIG_DIR: join(home, "claude"),
   CATHERD_CLAUDE_AGENTS_DIR: join(home, "claude-agents"),
   TYPESAFE_API_KEY: "",
+  ARTIFICIAL_ANALYSIS_API_KEY: "",
   ANTHROPIC_API_KEY: "",
+  // the server doctor starts would sync the public sources in the background (spec 1.2 §3.2): not here
+  CATHERD_NO_SYNC: "1",
   // never the Claude Code session this may run in: doctor's push row would message it
   CLAUDE_CODE_SESSION_ID: "",
   CLAUDE_CODE_MESSAGING_SOCKET: "",
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/entry/mcp-sync.test.ts test/entry/mcp.test.ts test/entry/catalog-command.test.ts`
Expected: FAIL: `syncLines` is not exported by catalog-command.ts; `catalog_sync` is not listed; `startMcpServer` takes no transport.

- [ ] **Step 3: Implement**

Edit `README.md` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/README.md b/README.md
index b36064e..8016e06 100644
--- a/README.md
+++ b/README.md
@@ -87,6 +87,7 @@ In a terminal:
 | `catherd status [run]`, `catherd watch [--once] [--interval <s>]`                         | Where runs stand, grouped by the Claude Code session that drove them                                |
 | `catherd runs list [--repo <path>]\|show <id> [--debug [--name <n>]]\|cancel <id> <name>` | Past runs, by session; `--debug` adds exit.json and the stderr and event tails, `--name` one role's |
 | `catherd catalog refresh\|list [--backend <b>] [--role <r>] [--text <t>] [--scored]`      | The models catherd can place, filtered                                                              |
+| `catherd catalog sync [--force] [--unmatched]`                                            | Fetches the public model facts and scores now (below); `--unmatched` lists ids no model matched     |
 | `catherd catalog treat-like <rung> <like>`                                                | Scores an unscored rung as a scored one                                                             |
 | `catherd lock [--slots N] -- <cmd>`                                                       | Runs a heavy command behind the machine-wide semaphore, in its own session (no /dev/tty)            |
 | `catherd mcp`                                                                             | The MCP server on stdio; the plugin starts it, you never need to                                    |
@@ -99,21 +100,30 @@ on the profile the repo you are in runs on: the one bound to it, else the active
 `~/.local/share/catherd/logs/`, kept for 7 days with secrets redacted. The dashboard takes `--plain` (ASCII, no colour)
 and `--reduced-motion`; `doctor` and `init` take `--plain` for ASCII glyphs too. `NO_COLOR` drops colour, never glyphs.
 
+Model facts and scores also come from public sources: models.dev, OpenRouter, LiteLLM, Arena (LMArena), Vectara's
+hallucination leaderboard and Epoch AI, plus Artificial Analysis when you give `catherd init` a free key. The MCP
+server syncs them in the background when a Claude Code session starts (each source at most every 12 hours, never
+delaying the session), `init` syncs them, and `catherd catalog sync` (or the `catalog_sync` tool) does it on demand.
+Each answer is kept in `~/.local/share/catherd/sources/`; a source that fails keeps its last good answer, and with no
+network and no sync at all catherd routes on the scores it ships.
+
 Run data lives in `~/.local/share/catherd/`, config in `~/.config/catherd/` (both follow
 `XDG_*`).
 
 ### Environment variables
 
-| Variable                    | What it does                                                                                          |
-| --------------------------- | ----------------------------------------------------------------------------------------------------- |
-| `TYPESAFE_API_KEY`          | The Jev key, instead of the one `catherd init` saves                                                  |
-| `CATHERD_HOME`              | Puts config and data under `$CATHERD_HOME/config` and `$CATHERD_HOME/data` instead of XDG             |
-| `CATHERD_LOG`               | Log level: `off`, `error`, `warn`, `info` (default) or `debug` (what `--verbose` sets)                |
-| `CATHERD_LOCK_SLOTS`        | `catherd lock`'s slot count when `--slots` is not given (before the profile's `lock.heavy`)           |
-| `CATHERD_REDUCED_MOTION`    | Any value: the dashboard's `--reduced-motion`                                                         |
-| `CATHERD_NO_KITTY`          | Any value: turns off the kitty keyboard protocol in the dashboard, for terminals it breaks            |
-| `CATHERD_CLAUDE_AGENTS_DIR` | Where catherd links its Claude agents (default: `$CLAUDE_CONFIG_DIR/agents`, else `~/.claude/agents`) |
-| `NO_COLOR`                  | Drops colour (the dashboard's and `--help`'s; piped `--help` has none either)                         |
+| Variable                      | What it does                                                                                                |
+| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
+| `TYPESAFE_API_KEY`            | The Jev key, instead of the one `catherd init` saves                                                        |
+| `ARTIFICIAL_ANALYSIS_API_KEY` | An Artificial Analysis key for `catalog sync`, instead of the one `catherd init` saves                      |
+| `CATHERD_NO_SYNC`             | `1`: no automatic sync of the public sources (at MCP server start and in `init`); `catalog sync` still runs |
+| `CATHERD_HOME`                | Puts config and data under `$CATHERD_HOME/config` and `$CATHERD_HOME/data` instead of XDG                   |
+| `CATHERD_LOG`                 | Log level: `off`, `error`, `warn`, `info` (default) or `debug` (what `--verbose` sets)                      |
+| `CATHERD_LOCK_SLOTS`          | `catherd lock`'s slot count when `--slots` is not given (before the profile's `lock.heavy`)                 |
+| `CATHERD_REDUCED_MOTION`      | Any value: the dashboard's `--reduced-motion`                                                               |
+| `CATHERD_NO_KITTY`            | Any value: turns off the kitty keyboard protocol in the dashboard, for terminals it breaks                  |
+| `CATHERD_CLAUDE_AGENTS_DIR`   | Where catherd links its Claude agents (default: `$CLAUDE_CONFIG_DIR/agents`, else `~/.claude/agents`)       |
+| `NO_COLOR`                    | Drops colour (the dashboard's and `--help`'s; piped `--help` has none either)                               |
 
 For development only: `CATHERD_STORY=1` opens the dashboard's storybook, and `CATHERD_LIVE=1` enables the live
 tests (CONTRIBUTING.md has the rest).
````

Edit `src/entry/catalog-command.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/catalog-command.ts b/src/entry/catalog-command.ts
index 0d5037d..59f1b18 100644
--- a/src/entry/catalog-command.ts
+++ b/src/entry/catalog-command.ts
@@ -9,8 +9,66 @@ import {
   refreshDiscovery,
   saveTreatLike,
 } from "../services/catalog-service.ts";
+import { readDerived } from "../infra/sources/cache.ts";
+import { type SyncReport, syncSources } from "../services/source-sync.ts";
 import { exitCodeOf, JSON_ARG, mark, printError } from "./cli-kit.ts";
 
+/**
+ * Spec 1.2 §9: a sync, one line per source (fetched, fresh, skipped, or failed with the answer it kept),
+ * then the rungs newly scored, the user's stand-ins no longer needed and the cross-check warnings.
+ */
+export function syncLines(r: SyncReport, plain = false): string[] {
+  if (r.busy) return ["- sources: another sync is running; its results apply when it ends"];
+  const out: string[] = [];
+  for (const s of r.sources) {
+    if (s.state === "fetched") out.push(`${mark("ok", plain)} ${s.source}: fetched`);
+    else if (s.state === "fresh") out.push(`- ${s.source}: fresh (fetched ${s.fetchedAt})`);
+    else if (s.state === "skipped") out.push(`- ${s.source}: ${s.detail}`);
+    else
+      out.push(
+        `${mark("warn", plain)} ${s.source}: ${s.error}; ${s.fetchedAt ? `keeps the answer fetched ${s.fetchedAt}` : "no earlier answer"}`,
+      );
+  }
+  if (r.newlyScored.length) out.push(`newly scored: ${r.newlyScored.join(", ")}`);
+  for (const n of r.noLongerNeeded)
+    out.push(`stand-in no longer needed: ${n.rung} has values of its own for what ${n.like} lent it`);
+  for (const w of r.warnings) out.push(`${mark("warn", plain)} ${w}`);
+  return out;
+}
+
+const sync = defineCommand({
+  meta: {
+    name: "sync",
+    description:
+      "Fetch the public model facts and scores now (each source at most every 12 hours unless --force) and show what changed",
+  },
+  args: {
+    force: { type: "boolean", description: "fetch every source, however fresh" },
+    unmatched: {
+      type: "boolean",
+      description: "also list each source's ids that match no model in the catalog",
+    },
+    ...JSON_ARG,
+  },
+  async run({ args }) {
+    try {
+      const r = await syncSources({ force: args.force === true });
+      if (args.json) console.log(JSON.stringify(r, null, 2));
+      else for (const l of syncLines(r)) console.log(l);
+      if (args.unmatched && !args.json) {
+        const unmatched = readDerived()?.unmatched ?? {};
+        if (Object.keys(unmatched).length === 0) console.log("unmatched: none");
+        for (const [source, ids] of Object.entries(unmatched))
+          console.log(`unmatched in ${source}: ${ids.join(", ")}`);
+      }
+      const got = r.sources.some((s) => s.state === "fetched" || s.state === "fresh");
+      process.exitCode = r.failed.length && !got ? 1 : 0;
+    } catch (e) {
+      fail(e);
+    }
+  },
+});
+
 /** One backend's refresh: its model count, else why it listed none, then its fix on a line of its own. */
 export function formatRefreshed(r: Refreshed, plain = false): string {
   if (!r.error) return `${mark("ok", plain)} ${r.backend}: ${r.models} models`;
@@ -99,8 +157,8 @@ const treatLike = defineCommand({
   },
 });
 
-/** Spec §8: `catherd catalog refresh|list|treat-like <rung> <like>`. */
+/** Spec §8 and 1.2 §9: `catherd catalog refresh|list|sync|treat-like <rung> <like>`. */
 export const catalogCommand = defineCommand({
   meta: { name: "catalog", description: "The model catalog" },
-  subCommands: { refresh, list, "treat-like": treatLike },
+  subCommands: { refresh, list, sync, "treat-like": treatLike },
 });
````

Edit `src/entry/mcp/server.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/mcp/server.ts b/src/entry/mcp/server.ts
index 9cfa34a..46b0bd7 100644
--- a/src/entry/mcp/server.ts
+++ b/src/entry/mcp/server.ts
@@ -1,11 +1,13 @@
 import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
+import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
 import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
 import { errorMessage } from "../../domain/errors.ts";
 import { log } from "../../infra/log.ts";
 import { startNotifier } from "../../services/notifier.ts";
 import type { Deps } from "../../services/ports.ts";
 import { reconcileAll } from "../../services/reconcile.ts";
+import { backgroundSync } from "../../services/source-sync.ts";
 import { defaultDeps } from "../deps.ts";
 import { registerDispatchTools } from "./dispatch-tools.ts";
 import { registerLaneTools } from "./lane-tools.ts";
@@ -60,9 +62,13 @@ export function buildServer(deps: Deps = defaultDeps()): McpServer {
 
 /**
  * Spec §4.7: connect first, so the client never waits on a scan; then reconcile every run. Spec §3.4: the notifier
- * starts before reconcile, so what reconcile settles is announced, and scans for the rest once it is done.
+ * starts before reconcile, so what reconcile settles is announced, and scans for the rest once it is done. Spec
+ * 1.2 §3.2: the source sync starts once connected and is never awaited, so neither the handshake nor a tool call
+ * waits on the network. Tests pass their own transport and sync.
  */
-export async function startMcpServer(): Promise<void> {
+export async function startMcpServer(
+  o: { transport?: Transport; sync?: () => Promise<unknown> } = {},
+): Promise<void> {
   const deps = defaultDeps();
   // which of the session's variables this server got (never their values): the live check of spec §3.9
   log("info", "session", {
@@ -72,7 +78,11 @@ export async function startMcpServer(): Promise<void> {
     token: Boolean(deps.session?.token),
   });
   const notifier = startNotifier(deps);
-  await buildServer(deps).connect(new StdioServerTransport());
+  await buildServer(deps).connect(o.transport ?? new StdioServerTransport());
+  const sync = o.sync ?? (() => backgroundSync());
+  void Promise.resolve()
+    .then(sync)
+    .catch((e: unknown) => log("debug", "sources", { error: errorMessage(e) }));
   try {
     const r = await reconcileAll(deps);
     const shown = r.warnings.length;
````

Edit `src/entry/mcp/setup-tools.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/mcp/setup-tools.ts b/src/entry/mcp/setup-tools.ts
index b04ec4a..500f474 100644
--- a/src/entry/mcp/setup-tools.ts
+++ b/src/entry/mcp/setup-tools.ts
@@ -5,6 +5,7 @@ import { PROFILE_NAME, ProfilePatchSchema } from "../../domain/profile.ts";
 import { ROLES } from "../../domain/roles.ts";
 import { gitToplevel } from "../../infra/git.ts";
 import type { Deps } from "../../services/ports.ts";
+import { syncSources } from "../../services/source-sync.ts";
 import { handle } from "./result.ts";
 
 const PROFILE = z.string().regex(PROFILE_NAME).optional();
@@ -49,6 +50,27 @@ export function registerSetupTools(server: McpServer, deps: Deps): void {
       }),
   );
 
+  server.registerTool(
+    "catalog_sync",
+    {
+      description:
+        "Fetch the public model facts and scores now (models.dev, OpenRouter, LiteLLM, Arena, Vectara, Epoch AI, and Artificial Analysis with the user's key): each source at most every 12 hours unless `force`. Returns the rungs newly scored, the user's treat-likes no longer needed (their rung now has values of its own), the sources that failed (each keeps its last good answer) and each source's state. route and catalog_query read the result at once.",
+      inputSchema: { force: z.boolean().default(false) },
+    },
+    (a) =>
+      handle(async () => {
+        const r = await (deps.sync ?? ((o) => syncSources(o)))({ force: a.force });
+        return {
+          newlyScored: r.newlyScored,
+          standInsNoLongerNeeded: r.noLongerNeeded,
+          failed: r.failed,
+          sources: r.sources,
+          warnings: r.warnings,
+          ...(r.busy ? { busy: "another sync was running; call catalog_sync again" } : {}),
+        };
+      }),
+  );
+
   server.registerTool(
     "profile_get",
     {
````

Edit `src/services/ports.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/ports.ts b/src/services/ports.ts
index 17c4e6e..fcd0b54 100644
--- a/src/services/ports.ts
+++ b/src/services/ports.ts
@@ -8,6 +8,7 @@ import type { Role } from "../domain/roles.ts";
 import type { Change, ProfilePatch } from "../domain/profile.ts";
 import type { Issue } from "../domain/profile-rules.ts";
 import type { RouteJev, RouteSource } from "../domain/route.ts";
+import type { SyncReport } from "./source-sync.ts";
 
 /** What the run lifecycle reads from a profile. Rungs are `backend:model#effort`; a role's in ladder order. */
 export interface ProfileView {
@@ -132,4 +133,6 @@ export interface Deps {
   /** the Claude Code session this process serves (spec §3.3), from its environment; null outside one */
   session: SessionEnv | null;
   now: () => number;
+  /** spec 1.2 §3.2 `catalog_sync`; default: the real sync (tests inject one that never reaches the network) */
+  sync?: (o: { force: boolean }) => Promise<SyncReport>;
 }
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun run format && bun test test/entry/mcp-sync.test.ts test/entry/mcp.test.ts test/entry/catalog-command.test.ts && bun test test/entry/help-text.test.ts test/skills.test.ts test/plugin.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS (20 tests); `bun test test/entry/help-text.test.ts test/skills.test.ts test/plugin.test.ts` passes; `bun test/pack-smoke.ts` passes (it needs the npm registry, as before).

- [ ] **Step 5: Commit**

````bash
git add README.md src/entry/catalog-command.ts src/entry/mcp/server.ts src/entry/mcp/setup-tools.ts src/services/ports.ts test/entry/catalog-command.test.ts test/entry/mcp-sync.test.ts test/entry/mcp.test.ts test/pack-smoke.ts
git commit -m "feat(sources): catalog sync, the catalog_sync tool and the MCP server's boot sync"
````

---

### Task 13: doctor's `sources` row (spec 1.2 §9; R-B; Ruling 17)

One row after Jev's, from `state.json` only (no request): each source's age and last error, the AA key and its requests left. Before a first sync it is `info` (every doctor test runs in a fresh home, so the readiness test's map gains `sources: "info not synced"`).

**Files:**
- Create: `src/services/doctor-sources.ts`
- Modify: `src/services/doctor.ts`
- Create: `test/services/doctor-sources.test.ts`
- Modify: `test/services/doctor.test.ts`

**Interfaces:**
- Consumes: `sourcesStatus`, `TTL_MS` (Task 11); `type Check`, `guarded` (doctor-checks.ts).
- Produces: `src/services/doctor-sources.ts`: `ageText(ms): string`, `sourcesCheck(now = Date.now()): Check` (id `sources`).

- [ ] **Step 1: Write the failing tests**

Create `test/services/doctor-sources.test.ts`:

````ts
import { afterEach, describe, expect, it } from "bun:test";
import { MODELS_DEV_URL } from "../../src/infra/sources/models-dev.ts";
import { ageText, sourcesCheck } from "../../src/services/doctor-sources.ts";
import { syncSources, TTL_MS } from "../../src/services/source-sync.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { recordedFetch } from "./source-fixtures.ts";

afterEach(snapshotEnv());

const T0 = Date.parse("2026-09-28T10:00:00.000Z");
const transport = (impl: typeof fetch) => ({
  fetchImpl: impl,
  now: () => T0,
  sleep: async () => {},
  random: () => 0.5,
});
const sync = (o: { aaKey?: string | null; fail?: (u: string) => boolean } = {}) =>
  syncSources({
    transport: transport(recordedFetch({ fail: o.fail }).impl),
    now: () => T0,
    aaKey: o.aaKey ?? null,
  });

describe("doctor's sources row (spec 1.2 §9)", () => {
  it("is info before the first sync: routing uses the shipped scores", () => {
    withHome();
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    expect(sourcesCheck(T0)).toEqual({
      id: "sources",
      label: "sources",
      state: "info",
      word: "not synced",
      detail: "routing uses the shipped scores; no Artificial Analysis key",
      fix: "catherd catalog sync",
    });
  });

  it("gives each source's age once synced", async () => {
    withHome();
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    await sync();
    expect(sourcesCheck(T0 + 2 * 3_600_000)).toEqual({
      id: "sources",
      label: "sources",
      state: "ok",
      word: "fresh",
      detail:
        "models-dev 2 h, openrouter-models 2 h, openrouter-endpoints 2 h, litellm 2 h, arena 2 h, vectara 2 h, epoch 2 h; no Artificial Analysis key",
    });
  });

  it("warns on a failing source, naming its error, and on one not fetched for a day", async () => {
    withHome();
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
    await sync({ fail: (u) => u === MODELS_DEV_URL });
    const r = sourcesCheck(T0);
    expect(r).toMatchObject({ state: "warn", word: "failing", fix: "catherd catalog sync --force" });
    expect(r.detail).toStartWith("models-dev never (network error), openrouter-models 1 min,");
    expect(sourcesCheck(T0 + 2 * TTL_MS + 1)).toMatchObject({ state: "warn", word: "failing" });
    withHome();
    await sync();
    expect(sourcesCheck(T0 + 2 * TTL_MS + 1)).toMatchObject({ state: "warn", word: "stale" });
  });

  it("shows the Artificial Analysis key, its age and the requests left today", async () => {
    withHome();
    process.env.ARTIFICIAL_ANALYSIS_API_KEY = "aa-key-0123456789";
    await sync({ aaKey: "aa-key-0123456789" });
    expect(sourcesCheck(T0).detail).toEndWith(
      "epoch 1 min, artificial-analysis 1 min; Artificial Analysis key set, 98 requests left today",
    );
    expect(sourcesCheck(T0 + 24 * 3_600_000).detail).toEndWith("98 requests left on 2026-09-28");
  });

  it("prints ages in minutes, hours, then days", () => {
    expect([
      ageText(10_000),
      ageText(90 * 60_000),
      ageText(47 * 3_600_000),
      ageText(5 * 24 * 3_600_000),
    ]).toEqual(["1 min", "2 h", "47 h", "5 d"]);
  });
});
````

Edit `test/services/doctor.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/doctor.test.ts b/test/services/doctor.test.ts
index 4f445e4..2e462a0 100644
--- a/test/services/doctor.test.ts
+++ b/test/services/doctor.test.ts
@@ -105,6 +105,7 @@ describe("doctor", () => {
       "backend:claude-code": "ok ready",
       "backend:opencode": "ok ready",
       jev: "warn no key",
+      sources: "info not synced",
       plugin: "ok ready",
       agents: "ok ready",
       mcp: "ok ready",
@@ -336,8 +337,10 @@ describe("doctor", () => {
     expect(at("sandbox:codex")).toBeLessThan(at("access:codex"));
     expect(at("access:opencode")).toBeLessThan(at("access:full"));
     expect(at("access:full")).toBeLessThan(at("access:advisory"));
-    // the per-backend probes are ok/warn/skip, never info; only the shipped defaults' access modes are
+    // the per-backend probes are ok/warn/skip, never info; only the shipped defaults' access modes are,
+    // and the sources before a first sync (spec 1.2 §9)
     expect(r.checks.filter((c) => c.state === "info").map((c) => c.id)).toEqual([
+      "sources",
       "access:full",
       "access:advisory",
     ]);
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/services/doctor-sources.test.ts test/services/doctor.test.ts`
Expected: FAIL: `Cannot find module "../../src/services/doctor-sources.ts"`; doctor has no `sources` row.

- [ ] **Step 3: Implement**

Create `src/services/doctor-sources.ts`:

````ts
import type { Check } from "./doctor-checks.ts";
import { sourcesStatus, TTL_MS } from "./source-sync.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** An age as doctor prints it: minutes under an hour, hours under two days, else days. */
export function ageText(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < 2 * DAY) return `${Math.round(ms / HOUR)} h`;
  return `${Math.round(ms / DAY)} d`;
}

/**
 * Spec 1.2 §9: the `sources` row: each source's age and last error, whether an Artificial Analysis key is
 * set, and its requests left today (`x-ratelimit-remaining` of its last answer). `info` before the first
 * sync (routing uses the shipped scores); a warning when a source fails or has not been fetched for two
 * TTLs (a day), since background syncs would have refreshed it. It reads the sync's state only: no request.
 */
export function sourcesCheck(now = Date.now()): Check {
  const s = sourcesStatus();
  const shown = s.sources.filter((x) => x.source !== "artificial-analysis" || s.aaKey);
  const keyless = s.sources.filter((x) => x.source !== "artificial-analysis");
  const sameDay =
    s.rateLimitAt !== null && s.rateLimitAt.slice(0, 10) === new Date(now).toISOString().slice(0, 10);
  const left =
    s.rateLimitRemaining === null
      ? ""
      : sameDay
        ? `, ${s.rateLimitRemaining} requests left today`
        : `, ${s.rateLimitRemaining} requests left on ${s.rateLimitAt?.slice(0, 10)}`;
  const aa = s.aaKey ? `Artificial Analysis key set${left}` : "no Artificial Analysis key";
  const base = { id: "sources", label: "sources" };
  if (keyless.every((x) => x.fetchedAt === null && x.error === null))
    return {
      ...base,
      state: "info",
      word: "not synced",
      detail: `routing uses the shipped scores; ${aa}`,
      fix: "catherd catalog sync",
    };
  const parts = shown.map(
    (x) =>
      `${x.source} ${x.fetchedAt ? ageText(now - Date.parse(x.fetchedAt)) : "never"}${x.error ? ` (${x.error})` : ""}`,
  );
  const failing = shown.some((x) => x.error !== null);
  const stale = keyless.some((x) => x.fetchedAt === null || now - Date.parse(x.fetchedAt) > 2 * TTL_MS);
  const warn = failing || stale;
  return {
    ...base,
    state: warn ? "warn" : "ok",
    word: failing ? "failing" : stale ? "stale" : "fresh",
    detail: `${parts.join(", ")}; ${aa}`,
    ...(warn ? { fix: "catherd catalog sync --force" } : {}),
  };
}
````

Edit `src/services/doctor.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/doctor.ts b/src/services/doctor.ts
index 20d5984..491359d 100644
--- a/src/services/doctor.ts
+++ b/src/services/doctor.ts
@@ -9,6 +9,7 @@ import { linkedProfiles } from "./agent-links.ts";
 import { accessChecks } from "./doctor-access.ts";
 import { backendChecks, usedBackends } from "./doctor-backends.ts";
 import { type PushProbe, pushCheck } from "./doctor-push.ts";
+import { sourcesCheck } from "./doctor-sources.ts";
 import {
   agentsCheck,
   type Check,
@@ -190,6 +191,9 @@ export async function doctor(d: DoctorDeps): Promise<DoctorReport> {
     }
   }
 
+  // spec 1.2 §9: the public sources' ages and errors, and the Artificial Analysis key
+  checks.push(guarded("sources", "sources", "catherd catalog sync --force", () => sourcesCheck()));
+
   checks.push(pluginCheck(d.version));
 
   checks.push(
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun run format && bun test test/services/doctor-sources.test.ts test/services/doctor.test.ts && bun test test/entry/doctor-command.test.ts test/entry/tui && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS (5 + 37 tests); `bun test test/entry/doctor-command.test.ts test/entry/tui` passes.

- [ ] **Step 5: Commit**

````bash
git add src/services/doctor-sources.ts src/services/doctor.ts test/services/doctor-sources.test.ts test/services/doctor.test.ts
git commit -m "feat(sources): doctor's sources row, with each source's age, its errors and the AA key"
````

---

### Task 14: `init` asks for the Artificial Analysis key after Jev's, then syncs (spec 1.2 §9; Rulings 15, 16)

`aaStep` mirrors `jevStep` (env, saved, prompt; tested; never stops `init`); `syncStep` runs the foreground sync and prints `syncLines`, or says it is off under `CATHERD_NO_SYNC=1` (every spawned `init` in the suite). Piped answers gain a line for the AA question, so three existing tests' stdin gain an empty line. README's requirements gain the optional AA key.

**Files:**
- Modify: `README.md`
- Modify: `src/entry/init-command.ts`
- Modify: `test/entry/init-command.test.ts`

**Interfaces:**
- Consumes: `testAaKey` (Task 8); `aaKey`, `saveAaKey` (Task 9); `syncSources`, `type SyncReport` (Task 11); `syncLines` (Task 12).
- Produces: `src/entry/init-command.ts`: `aaStep(ask, d: { testAaKey?, saveAaKey? } = {}, plain = false)`, `syncStep(o: { plain?; sync?: () => Promise<SyncReport> } = {})`.

- [ ] **Step 1: Write the failing tests**

Edit `test/entry/init-command.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/entry/init-command.test.ts b/test/entry/init-command.test.ts
index ec5b656..8264bb8 100644
--- a/test/entry/init-command.test.ts
+++ b/test/entry/init-command.test.ts
@@ -2,10 +2,19 @@ import { afterEach, describe, expect, it, spyOn } from "bun:test";
 import { existsSync, mkdirSync, writeFileSync } from "node:fs";
 import { writeDiscovery } from "../../src/adapters/discovery.ts";
 import { dirname, join } from "node:path";
-import { globalStep, jevStep, PLUGIN_STEPS, welcomeLines } from "../../src/entry/init-command.ts";
+import {
+  aaStep,
+  globalStep,
+  jevStep,
+  PLUGIN_STEPS,
+  syncStep,
+  welcomeLines,
+} from "../../src/entry/init-command.ts";
 import type { Prompter } from "../../src/entry/prompt.ts";
 import { VERSION } from "../../src/infra/version.ts";
+import { aaKey, saveAaKey } from "../../src/services/credentials.ts";
 import { credentialsPath, saveJevKey } from "../../src/services/jev-service.ts";
+import type { SyncReport } from "../../src/services/source-sync.ts";
 import { patchProfile } from "../../src/services/profile-service.ts";
 import { activeName, getProfile } from "../../src/services/profile-store.ts";
 import { noPosixModes, openModes, snapshotEnv, withHome } from "../helpers.ts";
@@ -23,6 +32,7 @@ function init(args: string[], stdin = "") {
       // bun's global bin is test/bin too, so init finds "this version installed globally" and never runs bun add -g
       BUN_INSTALL_BIN: join(import.meta.dir, "..", "bin"),
       TYPESAFE_API_KEY: "",
+      ARTIFICIAL_ANALYSIS_API_KEY: "",
       ANTHROPIC_API_KEY: "",
     },
     stdin: new TextEncoder().encode(stdin),
@@ -191,13 +201,18 @@ describe("catherd init", () => {
     expect(getProfile("default").budget).toEqual({ usd: 9 });
   }, 60_000);
 
-  it("reads piped answers: an empty key skips Jev, a name picks the profile, y replaces it", () => {
+  it("reads piped answers: empty keys skip Jev and Artificial Analysis, a name picks the profile, y replaces it", () => {
     const home = withHome();
     process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
     patchProfile("team", { budget: { usd: 9 } });
-    const r = init([], "\nteam\ny\n");
+    const r = init([], "\n\nteam\ny\n");
     expect(r.code).toBe(0);
     expect(r.out).toContain("TypeSafe API key for Jev (optional; Enter skips): \n- Jev: no key;");
+    expect(r.out).toContain(
+      "Artificial Analysis API key (optional; Enter skips): \n- Artificial Analysis: no key; scores come from the keyless sources",
+    );
+    // the suite sets CATHERD_NO_SYNC=1 (test/preload.ts): init says so instead of reaching the network
+    expect(r.out).toContain("- sources: not synced (CATHERD_NO_SYNC=1); catherd catalog sync fetches them\n");
     expect(r.out).toContain("✓ profile team written from the defaults, and active\n");
     expect([activeName(), getProfile("team").budget]).toEqual(["team", {}]);
   }, 60_000);
@@ -206,7 +221,7 @@ describe("catherd init", () => {
     const home = withHome();
     process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
     saveJevKey("ts-live-0123456789abcdef");
-    const r = init([], "ts-live-0123456789abcdef\nteam\n");
+    const r = init([], "ts-live-0123456789abcdef\n\nteam\n");
     expect(r.code).toBe(0);
     expect(r.out).toContain("✓ profile team written from the defaults, and active\n");
     expect(`${r.out}${r.err}`).not.toContain("0123456789abcdef");
@@ -232,7 +247,7 @@ describe("catherd init", () => {
       join(dirname(credentialsPath()), "profiles", "team.json"),
       JSON.stringify({ name: "team" }),
     );
-    const r = init([], "\nteam\n");
+    const r = init([], "\n\nteam\n");
     expect(r.code).toBe(0);
     expect(r.out).not.toContain("Replace profile");
     expect(r.out).toContain("profiles/team.json\n✓ profile team written from the defaults, and active\n");
@@ -285,3 +300,128 @@ describe("catherd init", () => {
     ]);
   });
 });
+
+/** What a step printed, line by line. */
+async function printed(f: () => Promise<void>): Promise<string[]> {
+  const lines: string[] = [];
+  const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void lines.push(a.join(" ")));
+  try {
+    await f();
+  } finally {
+    log.mockRestore();
+  }
+  return lines;
+}
+const typed = (key: string): Prompter => ({ ask: async () => "", secret: async () => key, close() {} });
+
+describe("aaStep (spec 1.2 §9)", () => {
+  it("takes ARTIFICIAL_ANALYSIS_API_KEY first, then the saved key, asking nothing", async () => {
+    withHome();
+    process.env.ARTIFICIAL_ANALYSIS_API_KEY = "aa-env-0123456789";
+    let skipped = 0;
+    const ask: Prompter = { ...typed("x"), skip: () => void skipped++ };
+    expect(await printed(() => aaStep(ask))).toEqual([
+      "✓ Artificial Analysis: using ARTIFICIAL_ANALYSIS_API_KEY",
+    ]);
+    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
+    saveAaKey("aa-saved-0123456789");
+    expect(await printed(() => aaStep(ask))).toEqual(["✓ Artificial Analysis: using the saved key"]);
+    expect(skipped).toBe(2);
+  });
+
+  it("skips on Enter, saves a key that answers, and keeps a refused or unchecked one out", async () => {
+    withHome();
+    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
+    expect(await printed(() => aaStep(typed("")))).toEqual([
+      "- Artificial Analysis: no key; scores come from the keyless sources (add one later with catherd init)",
+    ]);
+    const refused = await printed(() =>
+      aaStep(typed("aa-bad-0123456789"), { testAaKey: async () => ({ result: "refused" }) }),
+    );
+    expect(refused).toEqual(["! Artificial Analysis: the key was refused (401), so it was not saved"]);
+    const offline = await printed(() =>
+      aaStep(typed("aa-key-0123456789"), {
+        testAaKey: async () => ({ result: "unchecked", error: "network error" }),
+      }),
+    );
+    expect(offline).toEqual([
+      "! Artificial Analysis: the key could not be checked (network error), so it was not saved; run catherd init again to retry",
+    ]);
+    expect(existsSync(credentialsPath())).toBe(false);
+    const ok = await printed(() =>
+      aaStep(typed("aa-good-0123456789"), { testAaKey: async () => ({ result: "ok" }) }),
+    );
+    expect(ok).toEqual(["✓ Artificial Analysis: the key answers; saved with mode 600"]);
+    expect(aaKey()).toBe("aa-good-0123456789");
+  });
+
+  it("goes on when credentials.json refuses the key, saying why and how to fix it", async () => {
+    withHome();
+    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY;
+    mkdirSync(dirname(credentialsPath()), { recursive: true });
+    writeFileSync(credentialsPath(), "{not json");
+    const lines = await printed(() =>
+      aaStep(typed("aa-key-0123456789"), { testAaKey: async () => ({ result: "ok" }) }),
+    );
+    expect(lines[0]).toStartWith(
+      `! Artificial Analysis: could not save the key: ${credentialsPath()} is not valid JSON`,
+    );
+    expect(lines[1]).toStartWith(`    fix: delete ${credentialsPath()} and run catherd init`);
+  });
+});
+
+describe("syncStep (spec 1.2 §9)", () => {
+  const report: SyncReport = {
+    busy: false,
+    sources: [{ source: "arena", state: "fetched", fetchedAt: "2026-09-28T10:00:00.000Z" }],
+    newlyScored: [],
+    noLongerNeeded: [],
+    failed: [],
+    warnings: [],
+    unmatched: {},
+  };
+
+  it("syncs in the foreground and prints what catalog sync prints", async () => {
+    withHome();
+    delete process.env.CATHERD_NO_SYNC;
+    expect(await printed(() => syncStep({ sync: async () => report }))).toEqual([
+      "syncing the public model sources…",
+      "✓ arena: fetched",
+    ]);
+  });
+
+  it("never stops init: a sync that throws is a ! line with its fix", async () => {
+    withHome();
+    delete process.env.CATHERD_NO_SYNC;
+    const lines = await printed(() =>
+      syncStep({
+        sync: async () => {
+          throw new Error("disk full");
+        },
+      }),
+    );
+    expect(lines).toEqual([
+      "syncing the public model sources…",
+      "! sources: disk full",
+      "    fix: catherd catalog sync",
+    ]);
+  });
+
+  it("is skipped with CATHERD_NO_SYNC=1", async () => {
+    withHome();
+    process.env.CATHERD_NO_SYNC = "1";
+    let ran = false;
+    const lines = await printed(() =>
+      syncStep({
+        sync: async () => {
+          ran = true;
+          return report;
+        },
+      }),
+    );
+    expect([ran, lines]).toEqual([
+      false,
+      ["- sources: not synced (CATHERD_NO_SYNC=1); catherd catalog sync fetches them"],
+    ]);
+  });
+});
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/entry/init-command.test.ts`
Expected: FAIL: `aaStep` and `syncStep` are not exported; the piped tests see the AA question take the profile's line.

- [ ] **Step 3: Implement**

Edit `README.md` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/README.md b/README.md
index 8016e06..e212f14 100644
--- a/README.md
+++ b/README.md
@@ -35,6 +35,8 @@ of work, climbing a ladder only when a cheaper rung falls short.
     (the npm package `opencode-ai` is v1 and is not supported)
   - Claude Code's `claude` CLI 2.1.282 or newer, for headless `claude-code:` rungs
 - Optional: a TypeSafe API key for Jev, in `TYPESAFE_API_KEY` or saved by `catherd init`
+- Optional: a free [Artificial Analysis](https://artificialanalysis.ai) API key for more scores, in
+  `ARTIFICIAL_ANALYSIS_API_KEY` or saved by `catherd init`; its numbers are read for you alone and never shipped
 
 `catherd doctor` checks each backend's version and login and prints the fix for anything missing. The default
 profile runs its workers on Codex; without Codex, doctor's fix also names how to move those roles to a backend
````

Edit `src/entry/init-command.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/init-command.ts b/src/entry/init-command.ts
index f273c69..7b4cd98 100644
--- a/src/entry/init-command.ts
+++ b/src/entry/init-command.ts
@@ -4,11 +4,14 @@ import { errorMessage, isCatherdError } from "../domain/errors.ts";
 import { configDir } from "../infra/paths.ts";
 import { VERSION } from "../infra/version.ts";
 import { doctor } from "../services/doctor.ts";
+import { testAaKey } from "../infra/sources/artificial-analysis.ts";
+import { aaKey, saveAaKey } from "../services/credentials.ts";
 import { jevKey, saveJevKey, testJevKey } from "../services/jev-service.ts";
+import { type SyncReport, syncSources } from "../services/source-sync.ts";
 import { reinstallCommand } from "../services/doctor-checks.ts";
 import { ensureGlobal, type GlobalInstallDeps, realGlobalInstall } from "../services/global-install.ts";
 import { hasProfileFile, type InitResult, initSetup, moveLegacy } from "../services/setup.ts";
-import { formatRefreshed } from "./catalog-command.ts";
+import { formatRefreshed, syncLines } from "./catalog-command.ts";
 import { mark as markOf } from "./cli-kit.ts";
 import { formatReport } from "./doctor-command.ts";
 import { mcpHandshake } from "./mcp/handshake.ts";
@@ -65,6 +68,71 @@ export async function jevStep(
   }
 }
 
+/**
+ * Spec 1.2 §9: the Artificial Analysis key step, after Jev's. ARTIFICIAL_ANALYSIS_API_KEY wins, else the saved
+ * key, else a prompt (Enter skips). A typed key is tested with one request: a 200 saves it, a 401 does not,
+ * and a key that cannot be checked (no network) is not saved either. It never stops `init`.
+ */
+export async function aaStep(
+  ask: Prompter | null,
+  d: {
+    testAaKey?: (key: string) => Promise<{ result: "ok" | "refused" | "unchecked"; error?: string }>;
+    saveAaKey?: (key: string) => void;
+  } = {},
+  plain = false,
+): Promise<void> {
+  const mark = (state: State) => markOf(state, plain);
+  if (process.env.ARTIFICIAL_ANALYSIS_API_KEY?.trim()) {
+    ask?.skip?.();
+    return console.log(`${mark("ok")} Artificial Analysis: using ARTIFICIAL_ANALYSIS_API_KEY`);
+  }
+  if (aaKey()) {
+    ask?.skip?.();
+    return console.log(`${mark("ok")} Artificial Analysis: using the saved key`);
+  }
+  const key = ask ? await ask.secret("Artificial Analysis API key (optional; Enter skips): ") : "";
+  if (!key)
+    return console.log(
+      "- Artificial Analysis: no key; scores come from the keyless sources (add one later with catherd init)",
+    );
+  const t = await (d.testAaKey ?? testAaKey)(key).catch((e: unknown) => ({
+    result: "unchecked" as const,
+    error: errorMessage(e),
+  }));
+  if (t.result === "refused")
+    return console.log(`${mark("warn")} Artificial Analysis: the key was refused (401), so it was not saved`);
+  if (t.result === "unchecked")
+    return console.log(
+      `${mark("warn")} Artificial Analysis: the key could not be checked (${t.error ?? "no answer"}), so it was not saved; run catherd init again to retry`,
+    );
+  try {
+    (d.saveAaKey ?? saveAaKey)(key);
+    console.log(`${mark("ok")} Artificial Analysis: the key answers; saved with mode 600`);
+  } catch (e) {
+    console.log(
+      `${mark("warn")} Artificial Analysis: could not save the key: ${errorMessage(e).split("\n").join(" ")}`,
+    );
+    if (isCatherdError(e) && e.fix) console.log(`    fix: ${e.fix}`);
+  }
+}
+
+/**
+ * Spec 1.2 §9: `init` syncs the public sources in the foreground, after the keys. It never stops `init`;
+ * CATHERD_NO_SYNC=1 skips it.
+ */
+export async function syncStep(o: { plain?: boolean; sync?: () => Promise<SyncReport> } = {}): Promise<void> {
+  const plain = o.plain === true;
+  if (process.env.CATHERD_NO_SYNC === "1")
+    return console.log("- sources: not synced (CATHERD_NO_SYNC=1); catherd catalog sync fetches them");
+  console.log("syncing the public model sources…");
+  try {
+    for (const l of syncLines(await (o.sync ?? (() => syncSources()))(), plain)) console.log(l);
+  } catch (e) {
+    console.log(`${markOf("warn", plain)} sources: ${errorMessage(e).split("\n").join(" ")}`);
+    console.log("    fix: catherd catalog sync");
+  }
+}
+
 /**
  * Spec 1.1 §12: installs the global CLI at this version (the plugin's launcher then needs no bunx), and
  * says "installing catherd…" before the resolve. It never stops `init`: a failure is a `!` line and its fix.
@@ -124,7 +192,7 @@ export const initCommand = defineCommand({
   meta: {
     name: "init",
     description:
-      "First run: the global catherd command, the Jev key, the default profile, its agents, and a readiness report. Piped, it reads the answers from stdin one per line, a line per question even when this machine skips it (the Jev key, the profile, whether to replace it), and waits for stdin to close; --no-input asks nothing",
+      "First run: the global catherd command, the Jev key, the Artificial Analysis key, a sync of the public model sources, the default profile, its agents, and a readiness report. Piped, it reads the answers from stdin one per line, a line per question even when this machine skips it (the Jev key, the Artificial Analysis key, the profile, whether to replace it), and waits for stdin to close; --no-input asks nothing",
   },
   args: {
     // citty reads --no-input as input: false, whatever the flag is named; naming it no-input shows it as is
@@ -148,6 +216,8 @@ export const initCommand = defineCommand({
       console.log(`catherd ${VERSION}: setting up in ${configDir()}`);
       await globalStep(VERSION, { skip: (args as { global?: boolean }).global === false, plain });
       await jevStep(ask, {}, plain);
+      await aaStep(ask, {}, plain);
+      await syncStep({ plain });
       if (args.profile !== undefined) ask?.skip?.();
       const name = assertProfileName(
         args.profile ?? (ask ? (await ask.ask("Profile to set up [default]: ")) || "default" : "default"),
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun run format && bun test test/entry/init-command.test.ts && bun test test/entry/help-text.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS (32 tests with help-text); then the full gate.

- [ ] **Step 5: Commit**

````bash
git add README.md src/entry/init-command.ts test/entry/init-command.test.ts
git commit -m "feat(sources): init asks for the Artificial Analysis key after Jev's, then syncs the sources"
````

---

## Self-review (plan writer)

- **Spec coverage (plan 13's share):** §3.1 sources: Tasks 5–8; §3.2 background at boot, TTL, lock, on demand: Tasks 11, 12, 14; §3.3 fetch and cache: Tasks 4, 11; §3.4 id and effort mapping, unmatched: Tasks 2, 10, 12 (`--unmatched`); §3.5 facts and the 10 % cross-check: Task 10; §4.1–§4.2 anchors and calibration: Tasks 3, 10; §4.3 levels, precedence, provenance: Task 1; §5.1 `DIMS` (no bars): Task 1; §9 init, credentials, doctor, MCP, CLI: Tasks 9, 12, 13, 14; §10 files: as listed; §11 tests: one fixture per source (4–8), mapping (2, 10), calibration (3, 10), precedence (1), offline (11), boot handshake (12). Plan 14's parts are listed in Global Constraints.
- **Placeholders:** none; every step has its code or command. The AA fixtures are synthetic by design (R-C).
- **Type consistency:** `SyncReport`, `SourceOutcome`, `Derived`, `RawAnswers`, `SourceRow` and the field names in `DIM_SOURCES` are the ones the parsers emit (checked by the scratch build's tests).
- **Review Focus:** each of the five lines has its test in the owning task.

## After the plan

The controller lists the two synthetic AA fixtures in the PR body for the owner to re-record with a key, and adds nothing to the changelog (plan 14 writes the 1.2.0 changeset).
