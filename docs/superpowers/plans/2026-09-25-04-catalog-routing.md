# catherd 1.0 — Plan 4: the catalog and routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 0.x's catalog and routing with spec §5: a three-layer catalog (shipped models, per-backend discovery, sourced scores), a cost rank computed from each backend's billing mode, the ported selection and speed ladder with the approved ladder pinned by a test, Jev's `route-v2` question set with a probability decision rule and a thin retrying client, `outcomes.jsonl`, and `catherd catalog refresh|list|treat-like`, with the 0.x routing modules and the models.dev snapshot removed.

**Architecture:** Pure rules live in the domain layer: `catalog.ts` (schemas, the merge of the layers, rung facts), `cost.ts` (§5.3), `select.ts` (the 0.x algorithm on the new catalog) and `jev.ts` (question-set hashing, the trimmed lane state, answer parsing, the decision rules). The data is shipped as `catalog/models.json`, `catalog/scores.json` and `catalog/jev.json`. `infra/jev-client.ts` is the transport. Three services sit on top: `catalog-service` (loads the layers, the user's override and own timings; refreshes discovery), `jev-service` (key, per-run cache, `jev.jsonl`) and `routing-service`, which implements plan 2's `RoutingPort` and replaces the routing half of `src/bridge/v0.ts`; the bridge keeps only the profile half for plan 5.

**Tech Stack:** Bun ≥ 1.4 (`bun test`), TypeScript 7 (`tsc --noEmit`), zod 4, citty, oxlint, oxfmt. No new dependency; `ofetch` is removed.

**Spec:** `docs/superpowers/specs/2026-09-25-catherd-1.0-design.md` — §5 in full (§5.1 rungs, §5.2 the three layers, §5.3 cost rank, §5.4 routing, §5.5 Jev, §5.6 calibration data), with §3.5 (`discovery/`, `catalog.override.json`, `credentials.json`), §4.1 (`routes.jsonl`, `jev.jsonl`), §4.6 (the 80 % budget rule), §8 (`catherd catalog …`) and §11.1 (the approved-ladder pin). Research: `docs/research/2026-09-25-models.md` (lineups, efforts, contexts, prices, quota weights, every benchmark number and its source), `docs/research/2026-09-25-jev.md` (API contract, the confidence formula, question design, decision rule, transport), `docs/research/2026-09-25-opencode.md` (Zen and Go ids and variants). Plans 1–3 (`docs/superpowers/plans/2026-09-25-0{1,2,3}-*.md`) built everything this plan stands on; it uses plan 3's names: `BackendAdapter.listModels`, `DiscoveredModel`, `readDiscovery`/`writeDiscovery`/`discovered` in `src/adapters/discovery.ts`, `CLAUDE_MODELS`/`CLAUDE_EFFORTS`/`CLAUDE_ALIASES`, `claudeBackendFor`, `standInFor`.

## Global Constraints

- Runtime Bun ≥ 1.4, no build step; `.ts` files imported with explicit `.ts` extensions. `bun run typecheck`, `bun run lint` (`oxlint --deny-warnings src test`) and `bun run format:check` (oxfmt, print width 110) stay clean after every task; run `bun run format` before checking.
- "The dependency order, lowest first, is `domain` (pure types, schemas, errors, routing; no I/O) → `infra` → `adapters` → `services` → `entry`. A layer imports only from layers below it, and never from the 0.x modules (`src/core`, `src/mcp`, `src/routing`, `src/profile`, `src/tui`, `src/types.ts`)." Only `src/entry` imports `src/bridge/v0.ts` (`test/architecture.test.ts`).
- "A rung names its backend: `<backend>:<model>#<effort>`." "`claude` is the native-subagent pseudo-backend (no process; `route` returns the agent name). Effort `default` means "no effort flag"."
- "Every file carries `"schema": 1` (JSON) or a header row (JSONL: first line `{"schema":1,"kind":…}`)." Unknown fields are preserved on rewrite; every JSON write is atomic (`writeJsonAtomic`); `catalog.override.json` is changed only under its file lock.
- "Discovery … Refreshed by `init`, `doctor`, `catalog refresh`, and at most daily on `route`. The 1.4 MB models.dev snapshot is removed."
- Scores: "`{ dim, value, benchmark, version, url, date, confidence: "verified"|"secondary"|"inferred" }`. Dimensions: `repo_code` (DeepSWE v1.1 / SWE-bench Pro), `terminal` (Terminal-Bench 4.0), `honesty` (broken-tool disclosure). Values that could not be sourced are replaced or marked `inferred`."
- "**Bars are re-derived on the new benchmarks so the default profile still yields the approved ladder** (Track A `luna#high → sol#medium → sol#high → sol#xhigh`, Track B `sol#medium → sol#high → sol#xhigh`), pinned by a test."
- "`secs_per_task` … is the median `secs` per canonical rung and kind over the user's own runs, used for `objective: "speed"` once a rung has ≥ 5 samples; below that, rungs order by effort within a model."
- "A discovered model with no scores is listed and **disabled** until the user maps it with "treat like". Shipped data may carry default treat-likes, marked `inferred` and shown as such."
- Cost: "Order: every subscription rung before any metered rung, then by the computed value." "`ultra` rungs are never in a default ladder."
- Jev: "The kind is used when `p_max(kind) ≥ 0.8`. … Track A (copy/build work) when `P(A) ≥ 0.8`, Track B when `P(B) ≥ 0.8`, otherwise the lane file's declaration, else the default. Thresholds live in the data file." "10 s per attempt, two retries with jitter honouring `Retry-After`, 25 s hard deadline; a per-run cache by content hash; the log row records the returned model, usage, `x-typesafe-request-id` and the question-set hash." "`finding` p ≥ 0.83, `same-defect` p ≥ 0.85." "the state is never logged, only its hash." Keys come from `TYPESAFE_API_KEY` or `credentials.json` (mode 600).
- `outcomes.jsonl`: "`{ lane, questionSet, jevProbs, source, startRung, finalRung, climbs: [{from, to, reason}], start_ok, min_ok_index, envCaused }`. Climbs caused by the environment (a missing service, a limit) are marked and excluded from calibration."
- Tests: an isolated `CATHERD_HOME` per test (`withHome()` or `freshRun()`), `afterEach(snapshotEnv())` in every file that sets an env var, no wall-clock sleeps for correctness (a fake clock for Jev's retries), no network (every fetch is injected, and a test that could reach a backend CLI sets `PATH=/nonexistent`).
- Style: short doc comments only where the why is not obvious; Conventional Commits.

## Review Focus

1. **Jev is unreachable or hangs** (TypeSafe paused sign-ups; a key can be revoked; networks stall). Expected: `route` never blocks past the 25 s deadline and falls back to the lane's declaration, logging why. Task 9 pins it: `test/services/routing-service.test.ts` "falls back to the lane's declaration once the deadline passes, and says why" (with Task 5's "stops early rather than sleep past the deadline").
2. **A lane file carries secrets or long code blocks.** Expected: nothing secret or fenced reaches Jev, and `jev.jsonl` holds hashes and answers, never lane text. Task 4 pins the state ("keeps the header as fields and drops header lines, code and secrets from the body"), Task 9 the wire and the log ("takes a confident track over the lane's declaration, and logs the decision but never the lane").
3. **A backend CLI is missing or wedged when `route` refreshes discovery.** Expected: a failed listing is not retried on every `route` (an hour's backoff) and never blocks routing. Task 7 pins it: "lists again on route at most daily, and not again within the hour after a failure".
4. **The account's live listing lacks a rung the profile enables** (Astra not on the user's ChatGPT plan, a retired model). Expected: that rung is skipped rather than dispatched to fail, and a role left with nothing gets `E_CONFIG_INVALID` with a fix. Task 3 pins it: "skips bad, unoffered, unlisted, incapable and unscored rungs, and refuses an empty role".
5. **A treat-like saved by 1.0 names a rung only the 1.0 catalog scores**, while the 0.x profile validation and TUI still read the same `catalog.override.json`. Expected: the 0.x loaders skip it instead of throwing, so profiles keep loading. Task 11 pins it: `test/catalog.test.ts` "skips a treat-like onto a rung only the 1.0 catalog scores"; Task 7 pins the reverse ("keeps a 0.x override's other fields when saving a treat-like").

## Rulings on the spec

1. **One unit for every billing mode.** §5.3's four formulas yield list-price dollars per task, so rungs on different plans compare: `metered`, `claude-plan` and `subscription` use `price × tokens(effort)` (a reference task of 60K uncached input, 400K cached input and 18K output tokens at medium, ≈ $0.38 on Sol, times an effort factor from Sol's published per-effort DeepSWE costs: low 0.4, medium 1, high 1.7, xhigh 2.6, max 7.2; `ultra` = max × 4, catherd's estimate); `chatgpt-plan` uses the official quota weight (Luna 1, Sol 20, Astra 60; GPT-5.6 Sol 30, Terra 15, Luna 1.5 from the same table) × the effort factor × one Luna task in dollars. Go's "share of the monthly dollar limit" is dollars ÷ limit, which orders the same. Fast mode is never used by catherd, so it has no factor.
2. **Fable on `claude-plan` ranks as metered.** catherd cannot tell Pro from Max; ranking Fable after every subscription rung is right on Pro (usage credits) and harmless on Max (where Fable is capped at half the weekly limit).
3. **One benchmark per dimension.** `repo_code` is DeepSWE 1.1 only: SWE-bench Pro has no GPT-6 numbers, and mixing scales would make bars meaningless. `terminal` is Terminal-Bench 4.0, `honesty` OpenAI's Broken Search Tool (100 − failure rate). A test checks every score names its dimension's benchmark.
4. **The re-derived bars.** Track A (copy, build): DeepSWE ≥ 55. Track B (logic, hard): DeepSWE ≥ 55 and honesty ≥ 90 — a worker on logic or hard work must say when a tool fails; Luna (71.3, verified) does not clear it, Sol (95.1, verified) does. Terminal-Bench 4.0 is published per effort only for Opus 5.5, so a terminal bar would clear no Codex rung; terminal lanes gate on honesty and use terminal scores only to order the speed ladder. Luna high's DeepSWE 59.3 (the 0.x seed; only Luna max is published) and Sol's honesty below max (measured at max) are kept, marked `inferred`. The 0.x Opus terminal seeds (a CursorBench mix-up) are dropped; Opus low/medium/high are shipped treat-likes of xhigh, `inferred`.
5. **Scores are per canonical rung, on every backend.** `opencode:opencode/gpt-6-sol#high` scores as `gpt-6-sol#high`, as the spec's canonical keys say. A listed model catherd has no family for is canonically its own id (`opencode-go/kimi-k3#default`) and needs a treat-like.
6. **The route rule.** The `noul`s are asked and logged for calibration only (§5.5 "logged for calibration"); the decision reads the kind's p_max and the summed difficulty levels. A confident track with no confident kind takes the lane's `Kind:`, else `repo_code`; `other` is never a kind. Within Track A the larger of levels 0/1 gives `copy`/`build`, within Track B levels 2/3 give `logic`/`hard` (the bars treat each pair alike). A role with one usable rung never asks Jev.
7. **The per-run cache is `jev.jsonl` itself.** A row carries the request's key (sha256 of the canonical `{model, state, questions}`) and the answers, so a repeated `route` of the same lane in the same run is answered from its own log. `route`'s answer names the question set only when Jev answered.
8. **Calibration rows.** A lane gets an `outcomes.jsonl` row when `land(run, milestone)` lands its milestone (lane ids `<milestone>.*`, spec §4.2's `Mx.Ly`) and when `climb` passes its top rung (ended open). The orchestrator marks environment-caused climbs with a new optional `env: true` on `climb`; `start_ok` ignores those climbs and `envCaused` flags the lane for exclusion. A later landing appends a newer row; readers take the last.
9. **`agentFor` moves to the profile port.** Agent files belong to the ProfileService (§7.3); `RoutingPort.agentFor` becomes `ProfilePort.agentFor`, still served by the bridge's 0.x `agentName` until plan 5.
10. **Profile fields plan 5 will store.** `ProfileView` gains `objective`, per-role `defaultRung`, `billing` and `jev: { use }`. The 0.x profile file stores only `objective` and `defaultRung`, so until plan 5 the bridge serves `billing: {}` (spec §7.1's defaults) and `jev: { use: "auto" }`; `catalog_query` prices rungs with the default billing.
11. **Discovery decides availability.** When a backend's last listing is non-empty and lacks a rung's model, the rung is skipped by routing and shown as `listed: false`. The native `claude` backend reads claude-code's listing. The Models API refresh (`GET /v1/models`, with `ANTHROPIC_API_KEY`) merges into the shipped list, since a Claude-plan login may reach models the key does not; it drops aliases the claude-code adapter refuses. It uses `fetch` directly, like the Jev client: one paginated GET does not justify the Anthropic SDK as a dependency.
12. **What stays of 0.x until plans 5 and 6.** The 0.x profile code (plan 5) and TUI (plan 6) still validate against `catalog/catalog.json` through `src/routing/catalog.ts` and `src/routing/select.ts`; both stay, minus the models.dev snapshot, and 0.x now skips override treat-likes it cannot score. `src/routing/jev.ts` shrinks to a re-export of the 1.0 key functions for the TUI's `init` and dashboard. `src/routing/route.ts`, `src/routing/commands.ts`, `catalog/models-dev.json`, `scripts/snapshot-models-dev.ts` and their tests are deleted. The 0.x profile still refuses rungs its catalog does not score (Astra, Fable, Sonnet, Haiku) until plan 5.
13. **Jev keys.** `~/.config/typesafe/api_key` is not read any more (research: not a TypeSafe convention; the spec names `TYPESAFE_API_KEY` and `credentials.json`). A key is tested with `GET /v1/models`, which spends no inference and does not depend on a question set.
14. **Timings.** `secs` comes from `ok` records only (a failed run's time says nothing about speed), over every run of every repo, keyed by canonical rung and lane kind with an all-kinds median as the fallback. `route` lists a backend at most daily, and a backend this process failed to list is not tried again for an hour.

## Verified facts this plan relies on

- The whole plan was replayed task by task, in order, in a scratch copy of plan 3 as merged (`b7df77d`): each task's own checks pass, and at the end typecheck, lint and format are clean and `bun test` passes except `theme > reads the colour depth from the environment and honours NO_COLOR`, which fails identically on the untouched tree (it reads the terminal's environment).
- Jev's answer shapes (`choice`, `score` with `probabilities` keyed `"0"…`, `noul` with P(yes)), the `x-typesafe-request-id` header, `Retry-After`/`retry-after-ms` and `GET /v1/models` are from the TypeSafe docs as summarised in `docs/research/2026-09-25-jev.md` §1.2 and §4. No live key was available: the `route-v2-*.json` fixtures are synthetic, shaped exactly like the documented responses and the recorded 0.x fixtures.
- The Models API response (`data[]` with `id`, `max_input_tokens`, `capabilities.image_input.supported`, `capabilities.effort.<level>.supported`; `has_more`, `last_id`; `limit`, `after_id`; headers `x-api-key`, `anthropic-version: 2023-06-01`) is from Anthropic's Models API reference.

---

## File Structure

```
catalog/models.json                  families: canonical id, per-backend ids/efforts/contexts, capabilities, price, plan weight, notes; backend capabilities
catalog/scores.json                  sourced scores per canonical rung × dimension, the benchmark per dimension, shipped treat-likes, bars
catalog/jev.json                     question sets route-v2, finding, same-defect with their rules
catalog/catalog.json                 (kept) the 0.x catalog, read by the 0.x profile and TUI until plans 5/6
catalog/models-dev.json              (delete)
src/domain/catalog.ts                schemas, billingKeyOf, buildCatalog, rungInfo, scoresOf, capableFor, effortOffered, ROLE_NEEDS
src/domain/cost.ts                   BillingMode, DEFAULT_BILLING, EFFORT_FACTOR, taskUsd, costOf, compareCost
src/domain/select.ts                 RoutingProfile, candidates, clearsBar, defaultLadder, select (speed ladder)
src/domain/jev.ts                    JevFileSchema, questionSetId, requestKey, laneState, scrubSecrets, parseReply, judgeRoute, judgeVerdict
src/domain/route.ts                  (modify) RouteJev, RouteRow.questionSet/jev/env, OutcomeRow, laneOutcome
src/infra/assets.ts                  assetPath for shipped files
src/infra/jev-client.ts              jevRequest: per-attempt timeout, retries, Retry-After, deadline
src/adapters/claude-code/models-api.ts   listClaudeModels (Models API refresh)
src/adapters/claude-code/index.ts    (modify) listModels → listClaudeModels
src/services/catalog-service.ts      loadCatalog, measuredSecs, refreshDiscovery, freshenDiscovery, saveTreatLike, catalogQuery
src/services/jev-service.ts          jevKey, saveJevKey, testJevKey, askJev, logJev, jevQuestions
src/services/routing-service.ts      routingService(): RoutingPort
src/services/ports.ts                (modify) ProfileView fields, ProfilePort.agentFor, RouteRequest/RouteAnswer, Verdict
src/services/lane-service.ts         (modify) route passes the profile; climb env; outcome rows
src/services/run-store.ts            (modify) outcomes path, appendOutcome, readOutcomes
src/services/summary.ts              (modify) a lane or default source counts as a Jev fallback
src/services/{admission,dispatch-service,run-service}.ts   (modify) deps.profiles.agentFor
src/bridge/v0.ts                     (modify) the profile half only
src/entry/mcp/server.ts              (modify) routingService()
src/entry/mcp/lane-tools.ts          (modify) climb's env
src/entry/catalog-command.ts         `catherd catalog refresh|list|treat-like`
src/cli.ts                           (modify) the catalog subcommand
src/routing/route.ts, commands.ts    (delete)
src/routing/jev.ts                   (replace) re-export shim for the 0.x TUI
src/routing/catalog.ts               (modify) no snapshot; tolerant treat-likes
scripts/snapshot-models-dev.ts       (delete)
plugin/skills/catherd/SKILL.md       (modify) Jev wording, climb env, outcomes.jsonl
test/domain/{shipped.ts,catalog,cost,select,jev}.test.ts, test/infra/{assets,jev-client}.test.ts
test/adapters/claude-models-api.test.ts, test/services/{catalog-service,jev-service,routing-service,outcomes}.test.ts
test/entry/catalog-command.test.ts, test/fixtures/jev/route-v2-*.json, rate-limited.json, validation-error.json
test/fake-fetch.ts (modify), test/services/helpers.ts (modify), test/bridge/v0.test.ts (replace), test/catalog.test.ts (modify)
test/live/jev.live.test.ts (replace); test/route.test.ts, test/jev.test.ts, test/models-dev.test.ts (delete)
```

## Parallelism

Tasks that share no files and whose inputs exist can run in parallel worktrees; each merges before its dependents start.

| Wave | Tasks | Needs |
|---|---|---|
| 1 | 1 (catalog data and schemas), 4 (Jev question sets and rules), 5 (Jev transport), 6 (Claude Models API) | plan 3 |
| 2 | 2 (cost rank), 8 (Jev service) | 2: 1 · 8: 1 (`assetPath`), 4, 5 |
| 3 | 3 (selection and the ladder pin), 7 (catalog service) | 3: 1, 2 · 7: 1, 2 |
| 4 | 9 (routing service replaces the bridge's routing) | 3, 7, 8 |
| 5 | 10 (outcomes and environment climbs), 11 (catalog CLI and the 0.x removals) | 10: 9 · 11: 7, 8, 9 |

Task 5 rewrites `test/fake-fetch.ts`; Task 6 only uses its existing replies, so they run together. Tasks 10 and 11 touch disjoint files (10: `src/domain/route.ts`, `run-store.ts`, `lane-service.ts`, `lane-tools.ts`, the skill; 11: `src/entry/catalog-command.ts`, `src/cli.ts`, `src/routing/`, `package.json`, docs).

---

### Task 1: The catalog data and its schemas

The shipped layers of spec §5.2: `catalog/models.json` (families with canonical and per-backend ids, efforts, contexts, capabilities, prices, plan weights, and the Codex image tool's ChatGPT-login requirement) and `catalog/scores.json` (every score with its benchmark, version, URL, date and confidence; the shipped treat-likes; the bars of Ruling 4), with the domain schemas that merge them with a backend listing and the user's override.

**Files:**
- Create: `catalog/models.json`, `catalog/scores.json`, `src/domain/catalog.ts`, `src/infra/assets.ts`
- Test: `test/domain/shipped.ts`, `test/domain/catalog.test.ts`, `test/infra/assets.test.ts`

**Interfaces:**
- Consumes: `parseRung`, `Rung` (`src/domain/ids.ts`); `KINDS`, `DIFFICULTIES`, `Kind`, `Difficulty` (`src/domain/lane.ts`); `Role` (`src/domain/roles.ts`).
- Produces:
  - `DIMS`, `type Dim = "repo_code" | "terminal" | "honesty"`; `BILLING_KEYS`, `type BillingKey = "codex" | "claude" | "claude-code" | "opencode-go" | "opencode" | "cursor" | "grok"`; `billingKeyOf(r: Rung): BillingKey`.
  - Schemas and types `ModelsFileSchema`/`ModelsFile`, `Family` (`id, name, vendor, status, capabilities {toolUse, imageIn, reasoning}, price {input, cached, output}, planWeight?, meteredOnPlan, on: Partial<Record<ModelKey, {id, efforts, context}>>, notes`), `ScoreSchema`/`Score`, `ScoresFileSchema`/`ScoresFile`, `OverrideSchema`/`Override` (`schema, treatLike: Record<canonical, canonical>, scores, bars`), `Bars`.
  - `interface Listed { id; efforts; context: number | null; imageIn }`; `interface Catalog { families; backends; scores: Record<canonical, Partial<Record<Dim, Score>>>; treatLike: Record<canonical, {like, source: "shipped" | "user"}>; bars; listed: Record<backend, {fetchedAt, models: Listed[]}>; secs: Record<"<canonical>|<kind or *>", number> }`.
  - `buildCatalog(o: { models; scores; override?; listed?; secs? }): Catalog`; `familyOf(c, r: Rung)`; `interface RungInfo { rung; parsed; key; family; canonical; efforts; context; listed: boolean | null }`; `rungInfo(c, rung: string): RungInfo` (throws `E_ADMIT_RUNG` on a bad rung); `scoresOf(c, canonical) → { values, records, via } | null`; `ROLE_NEEDS`; `capableFor(c, info, role): boolean`; `effortOffered(info): boolean`.
  - `assetPath(rel: string): string` (`src/infra/assets.ts`).
  - Test helpers `shippedModels()`, `shippedScores()`, `shipped(o?: { listed?; override?; secs? }): Catalog` (`test/domain/shipped.ts`).

- [ ] **Step 1: Write the failing tests**

`test/domain/shipped.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCatalog,
  type Catalog,
  ModelsFileSchema,
  type Override,
  ScoresFileSchema,
} from "../../src/domain/catalog.ts";

const read = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "catalog", name), "utf8"));

export const shippedModels = () => ModelsFileSchema.parse(read("models.json"));
export const shippedScores = () => ScoresFileSchema.parse(read("scores.json"));

/** The shipped catalog, with optional listings, override and timings layered on. */
export function shipped(
  o: { listed?: Catalog["listed"]; override?: Override; secs?: Catalog["secs"] } = {},
): Catalog {
  return buildCatalog({ models: shippedModels(), scores: shippedScores(), ...o });
}
```

`test/domain/catalog.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { capableFor, DIMS, OverrideSchema, rungInfo, scoresOf } from "../../src/domain/catalog.ts";
import { shipped, shippedModels, shippedScores } from "./shipped.ts";

describe("catalog/models.json", () => {
  it("seeds the spec's families with canonical and per-backend ids", () => {
    const ids = shippedModels().families.map((f) => f.id);
    expect(ids).toEqual([
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
    const sol = shippedModels().families.find((f) => f.id === "gpt-6-sol");
    expect(sol?.on.codex).toEqual({
      id: "gpt-6-sol",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      context: 272000,
    });
    expect(sol?.on.opencode?.id).toBe("opencode/gpt-6-sol");
  });

  it("gives every Codex model the 272K default context and Haiku no effort in Claude Code", () => {
    for (const f of shippedModels().families) if (f.on.codex) expect(f.on.codex.context).toBe(272000);
    const haiku = shippedModels().families.find((f) => f.id === "claude-haiku-4-5");
    expect(haiku?.on["claude-code"]).toEqual({
      id: "claude-haiku-4-5-20251001",
      efforts: [],
      context: 200000,
    });
  });

  it("keeps ultra out of Luna and marks Codex image generation as needing a ChatGPT login", () => {
    const luna = shippedModels().families.find((f) => f.id === "gpt-6-luna");
    expect(luna?.on.codex?.efforts).not.toContain("ultra");
    expect(shippedModels().backends.codex?.imageGen?.requires).toBe("chatgpt-login");
  });
});

describe("catalog/scores.json", () => {
  it("sources every score on its dimension's benchmark, with a url, a date and a confidence", () => {
    const f = shippedScores();
    for (const s of f.scores) {
      expect(DIMS).toContain(s.dim);
      expect(s.benchmark).toBe(f.benchmarks[s.dim].benchmark);
      expect(s.version).toBe(f.benchmarks[s.dim].version);
      expect(s.url.startsWith("https://")).toBe(true);
    }
  });

  it("scores only rungs of known families and efforts, and treat-likes onto scored rungs", () => {
    const c = shipped();
    const f = shippedScores();
    for (const s of f.scores) {
      const [model, effort] = s.rung.split("#");
      const fam = c.families.find((x) => x.id === model);
      expect(fam).toBeDefined();
      const efforts = Object.values(fam?.on ?? {}).flatMap((b) => b.efforts);
      expect(efforts).toContain(effort as string);
    }
    for (const t of Object.values(f.treatLike)) expect(c.scores[t.like]).toBeDefined();
  });

  it("drops the mis-sourced 0.x Opus terminal seeds", () => {
    const c = shipped();
    expect(c.scores["claude-opus-5-5#medium"]).toBeUndefined();
    expect(c.scores["claude-opus-5-5#xhigh"]?.terminal?.value).toBe(66.4);
  });
});

describe("rungInfo", () => {
  it("maps a backend's model id to its family and canonical rung", () => {
    const c = shipped();
    expect(rungInfo(c, "opencode:opencode/gpt-6-sol#high")).toMatchObject({
      key: "opencode",
      canonical: "gpt-6-sol#high",
      context: 1050000,
      listed: null,
    });
    expect(rungInfo(c, "opencode:opencode-go/gpt-6-luna#high").key).toBe("opencode-go");
    expect(rungInfo(c, "claude:claude-opus-5-5#high")).toMatchObject({
      key: "claude",
      canonical: "claude-opus-5-5#high",
      efforts: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(rungInfo(c, "claude-code:claude-haiku-4-5-20251001#default").canonical).toBe(
      "claude-haiku-4-5#default",
    );
  });

  it("takes efforts from the backend's listing, and says when the listing lacks the model", () => {
    const listed = {
      codex: {
        fetchedAt: "2026-09-25T00:00:00.000Z",
        models: [{ id: "gpt-6-sol", efforts: ["low", "medium"], context: 272000, imageIn: true }],
      },
    };
    const c = shipped({ listed });
    expect(rungInfo(c, "codex:gpt-6-sol#high").efforts).toEqual(["low", "medium"]);
    expect(rungInfo(c, "codex:gpt-6-luna#high").listed).toBe(false);
    expect(rungInfo(c, "codex:gpt-6-sol#high").listed).toBe(true);
  });

  it("names an unknown model by its own id", () => {
    expect(rungInfo(shipped(), "opencode:opencode-go/kimi-k3#default")).toMatchObject({
      family: null,
      canonical: "opencode-go/kimi-k3#default",
    });
  });
});

describe("scores, treat-likes and the override", () => {
  it("borrows a treat-like's scores, and lets the user's treat-like and scores win", () => {
    const c = shipped();
    expect(scoresOf(c, "claude-opus-5-5#high")?.via).toBe("claude-opus-5-5#xhigh");
    expect(scoresOf(c, "opencode-go/kimi-k3#default")).toBeNull();
    const o = OverrideSchema.parse({
      treatLike: { "opencode-go/kimi-k3#default": "gpt-6-sol#medium" },
      scores: [
        {
          rung: "gpt-6-luna#high",
          dim: "repo_code",
          value: 61,
          benchmark: "DeepSWE",
          version: "1.1",
          url: "https://example.com/mine",
          date: "2026-09-25",
          confidence: "verified",
        },
      ],
      bars: { terminal: { copy: { honesty: 50 } } },
    });
    const mine = shipped({ override: o });
    expect(scoresOf(mine, "opencode-go/kimi-k3#default")?.values.repo_code).toBe(56.6);
    expect(mine.treatLike["opencode-go/kimi-k3#default"]?.source).toBe("user");
    expect(mine.scores["gpt-6-luna#high"]?.repo_code?.value).toBe(61);
    expect(mine.bars.terminal.copy).toEqual({ honesty: 50 });
    expect(mine.bars.terminal.build).toEqual({ honesty: 90 });
  });

  it("reads a 0.x override file (no schema) without losing its treat-likes", () => {
    const o = OverrideSchema.parse({ treatLike: { "a/b#high": "gpt-6-sol#high" }, entries: {} });
    expect(o.schema).toBe(1);
    expect(o.treatLike).toEqual({ "a/b#high": "gpt-6-sol#high" });
  });
});

describe("capableFor", () => {
  it("places the artist only on a backend with image generation", () => {
    const c = shipped();
    expect(capableFor(c, rungInfo(c, "codex:gpt-6-sol#medium"), "artist")).toBe(true);
    expect(capableFor(c, rungInfo(c, "claude-code:claude-opus-5-5#high"), "artist")).toBe(false);
    expect(capableFor(c, rungInfo(c, "claude-code:claude-opus-5-5#high"), "ui-reviewer")).toBe(true);
  });

  it("reads image input for an unknown model from its listing", () => {
    const listed = {
      opencode: {
        fetchedAt: "2026-09-25T00:00:00.000Z",
        models: [{ id: "opencode-go/kimi-k3", efforts: [], context: 262144, imageIn: false }],
      },
    };
    const c = shipped({ listed });
    expect(capableFor(c, rungInfo(c, "opencode:opencode-go/kimi-k3#default"), "worker")).toBe(true);
    expect(capableFor(c, rungInfo(c, "opencode:opencode-go/kimi-k3#default"), "ui-reviewer")).toBe(false);
  });
});
```

`test/infra/assets.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assetPath } from "../../src/infra/assets.ts";

describe("assetPath", () => {
  it("finds the shipped catalog from the package root", () => {
    expect(assetPath("catalog/models.json")).toBe(
      join(import.meta.dir, "..", "..", "catalog", "models.json"),
    );
    expect(existsSync(assetPath("catalog/scores.json"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/domain/catalog.test.ts test/infra/assets.test.ts`
Expected: FAIL — `Cannot find module '../../src/domain/catalog.ts'` and `Cannot find module '../../src/infra/assets.ts'`.

- [ ] **Step 3: Write the data**

`catalog/models.json` (efforts, contexts and prices from research 2026-09-25-models.md §1.1, §2.1; Zen and Go ids and variants from 2026-09-25-opencode.md §1, §2.1; plan weights from the Codex quota table, §2.4):

```json
{
  "schema": 1,
  "version": "2026-09-25",
  "sources": {
    "claude": "https://platform.claude.com/docs/en/models/overview (2026-09-25); efforts https://platform.claude.com/docs/en/build-with-claude/effort; prices https://platform.claude.com/docs/en/about-claude/pricing",
    "codex": "codex debug models --bundled, Codex CLI 0.157.0 (2026-09-25); prices https://developers.openai.com/api/docs/pricing; plan weights https://learn.chatgpt.com/docs/pricing",
    "opencode": "opencode models <provider> --verbose on 1.18.32 and the v2 model.list (2026-09-25); https://opencode.ai/docs/zen, https://opencode.ai/docs/go"
  },
  "backends": {
    "codex": {
      "imageGen": {
        "tool": "gpt-image-2",
        "requires": "chatgpt-login",
        "source": "https://learn.chatgpt.com/docs/image-generation"
      }
    }
  },
  "families": [
    {
      "id": "gpt-6-astra",
      "name": "GPT-6 Astra",
      "vendor": "openai",
      "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
      "price": { "input": 10, "cached": 1, "output": 50 },
      "planWeight": 60,
      "on": {
        "codex": {
          "id": "gpt-6-astra",
          "efforts": ["low", "medium", "high", "xhigh", "max", "ultra"],
          "context": 272000
        },
        "opencode": {
          "id": "opencode/gpt-6-astra",
          "efforts": ["low", "medium", "high", "xhigh", "max"],
          "context": 1050000
        }
      },
      "notes": {
        "ultra": "maximum reasoning with automatic task delegation to parallel subagents; never in a default ladder"
      }
    },
    {
      "id": "gpt-6-sol",
      "name": "GPT-6 Sol",
      "vendor": "openai",
      "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
      "price": { "input": 2, "cached": 0.2, "output": 10 },
      "planWeight": 20,
      "on": {
        "codex": {
          "id": "gpt-6-sol",
          "efforts": ["low", "medium", "high", "xhigh", "max", "ultra"],
          "context": 272000
        },
        "opencode": {
          "id": "opencode/gpt-6-sol",
          "efforts": ["none", "low", "medium", "high", "xhigh", "max"],
          "context": 1050000
        }
      },
      "notes": {
        "ultra": "maximum reasoning with automatic task delegation to parallel subagents; never in a default ladder"
      }
    },
    {
      "id": "gpt-6-luna",
      "name": "GPT-6 Luna",
      "vendor": "openai",
      "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
      "price": { "input": 0.1, "cached": 0.01, "output": 0.5 },
      "planWeight": 1,
      "on": {
        "codex": {
          "id": "gpt-6-luna",
          "efforts": ["low", "medium", "high", "xhigh", "max"],
          "context": 272000
        },
        "opencode": {
          "id": "opencode/gpt-6-luna",
          "efforts": ["none", "low", "medium", "high", "xhigh", "max"],
          "context": 1050000
        },
        "opencode-go": {
          "id": "opencode-go/gpt-6-luna",
          "efforts": ["none", "low", "medium", "high", "xhigh", "max"],
          "context": 1050000
        }
      }
    },
    {
      "id": "gpt-5.6-sol",
      "name": "GPT-5.6 Sol",
      "vendor": "openai",
      "status": "legacy",
      "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
      "price": { "input": 4, "cached": 0.4, "output": 20 },
      "planWeight": 30,
      "on": {
        "codex": {
          "id": "gpt-5.6-sol",
          "efforts": ["low", "medium", "high", "xhigh", "max", "ultra"],
          "context": 272000
        },
        "opencode": {
          "id": "opencode/gpt-5.6-sol",
          "efforts": ["none", "low", "medium", "high", "xhigh", "max"],
          "context": 1050000
        }
      },
      "notes": { "upgrade": "Codex offers gpt-6-sol as its upgrade" }
    },
    {
      "id": "gpt-5.6-terra",
      "name": "GPT-5.6 Terra",
      "vendor": "openai",
      "status": "legacy",
      "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
      "price": { "input": 2, "cached": 0.2, "output": 12 },
      "planWeight": 15,
      "on": {
        "codex": {
          "id": "gpt-5.6-terra",
          "efforts": ["low", "medium", "high", "xhigh", "max", "ultra"],
          "context": 272000
        },
        "opencode": {
          "id": "opencode/gpt-5.6-terra",
          "efforts": ["none", "low", "medium", "high", "xhigh", "max"],
          "context": 1050000
        }
      },
      "notes": { "upgrade": "Codex offers gpt-6-sol as its upgrade" }
    },
    {
      "id": "gpt-5.6-luna",
      "name": "GPT-5.6 Luna",
      "vendor": "openai",
      "status": "legacy",
      "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
      "price": { "input": 0.2, "cached": 0.02, "output": 1.2 },
      "planWeight": 1.5,
      "on": {
        "codex": {
          "id": "gpt-5.6-luna",
          "efforts": ["low", "medium", "high", "xhigh", "max"],
          "context": 272000
        },
        "opencode": {
          "id": "opencode/gpt-5.6-luna",
          "efforts": ["none", "low", "medium", "high", "xhigh", "max"],
          "context": 1050000
        },
        "opencode-go": {
          "id": "opencode-go/gpt-5.6-luna",
          "efforts": ["none", "low", "medium", "high", "xhigh", "max"],
          "context": 1050000
        }
      },
      "notes": { "upgrade": "Codex offers gpt-6-luna as its upgrade" }
    },
    {
      "id": "claude-fable-5-1",
      "name": "Claude Fable 5.1",
      "vendor": "anthropic",
      "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
      "price": { "input": 10, "cached": 0.25, "output": 50 },
      "meteredOnPlan": true,
      "on": {
        "claude-code": {
          "id": "claude-fable-5-1",
          "efforts": ["low", "medium", "high", "xhigh", "max"],
          "context": 1000000
        },
        "opencode": {
          "id": "opencode/claude-fable-5-1",
          "efforts": ["low", "medium", "high", "xhigh", "max"],
          "context": 1000000
        }
      },
      "notes": {
        "plan": "Pro and Team Standard pay usage credits for Fable; Max includes it up to half the weekly limit"
      }
    },
    {
      "id": "claude-opus-5-5",
      "name": "Claude Opus 5.5",
      "vendor": "anthropic",
      "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
      "price": { "input": 4, "cached": 0.2, "output": 20 },
      "on": {
        "claude-code": {
          "id": "claude-opus-5-5",
          "efforts": ["low", "medium", "high", "xhigh", "max"],
          "context": 1000000
        },
        "opencode": {
          "id": "opencode/claude-opus-5-5",
          "efforts": ["low", "medium", "high", "xhigh", "max"],
          "context": 1000000
        }
      },
      "notes": { "effort": "the API default effort is medium" }
    },
    {
      "id": "claude-sonnet-5",
      "name": "Claude Sonnet 5",
      "vendor": "anthropic",
      "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
      "price": { "input": 2, "cached": 0.2, "output": 10 },
      "on": {
        "claude-code": {
          "id": "claude-sonnet-5",
          "efforts": ["low", "medium", "high", "xhigh", "max"],
          "context": 1000000
        },
        "opencode": {
          "id": "opencode/claude-sonnet-5",
          "efforts": ["low", "medium", "high", "xhigh", "max"],
          "context": 1000000
        }
      }
    },
    {
      "id": "claude-haiku-4-5",
      "name": "Claude Haiku 4.5",
      "vendor": "anthropic",
      "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
      "price": { "input": 1, "cached": 0.1, "output": 5 },
      "on": {
        "claude-code": { "id": "claude-haiku-4-5-20251001", "efforts": [], "context": 200000 },
        "opencode": { "id": "opencode/claude-haiku-4-5", "efforts": ["high", "max"], "context": 200000 }
      },
      "notes": { "effort": "no effort parameter in Claude Code: its only rung there is #default" }
    }
  ]
}
```

`catalog/scores.json` (every value and URL from research 2026-09-25-models.md §3; `inferred` where the research marks a value unverified or carried from another effort):

```json
{
  "schema": 1,
  "version": "2026-09-25",
  "benchmarks": {
    "repo_code": { "benchmark": "DeepSWE", "version": "1.1" },
    "terminal": { "benchmark": "Terminal-Bench", "version": "4.0" },
    "honesty": {
      "benchmark": "OpenAI Broken Search Tool, 100 minus the failure rate",
      "version": "GPT-6 system card appendix 11.6.4.2"
    }
  },
  "scores": [
    {
      "rung": "gpt-6-sol#low",
      "dim": "repo_code",
      "value": 37.2,
      "benchmark": "DeepSWE",
      "version": "1.1",
      "url": "https://kingy.ai/blog/gpt-6-sol-luna-specs-benchmarks-pricing-comparison/",
      "date": "2026-09-22",
      "confidence": "secondary"
    },
    {
      "rung": "gpt-6-sol#medium",
      "dim": "repo_code",
      "value": 56.6,
      "benchmark": "DeepSWE",
      "version": "1.1",
      "url": "https://kingy.ai/blog/gpt-6-sol-luna-specs-benchmarks-pricing-comparison/",
      "date": "2026-09-22",
      "confidence": "secondary"
    },
    {
      "rung": "gpt-6-sol#high",
      "dim": "repo_code",
      "value": 65.3,
      "benchmark": "DeepSWE",
      "version": "1.1",
      "url": "https://kingy.ai/blog/gpt-6-sol-luna-specs-benchmarks-pricing-comparison/",
      "date": "2026-09-22",
      "confidence": "secondary"
    },
    {
      "rung": "gpt-6-sol#xhigh",
      "dim": "repo_code",
      "value": 66.6,
      "benchmark": "DeepSWE",
      "version": "1.1",
      "url": "https://kingy.ai/blog/gpt-6-sol-luna-specs-benchmarks-pricing-comparison/",
      "date": "2026-09-22",
      "confidence": "secondary"
    },
    {
      "rung": "gpt-6-sol#max",
      "dim": "repo_code",
      "value": 68.8,
      "benchmark": "DeepSWE",
      "version": "1.1",
      "url": "https://x.com/OpenAIDevs/status/2102461464279912495",
      "date": "2026-09-22",
      "confidence": "verified"
    },
    {
      "rung": "gpt-6-sol#max",
      "dim": "terminal",
      "value": 43,
      "benchmark": "Terminal-Bench",
      "version": "4.0",
      "url": "https://artificialanalysis.ai/articles/gpt-6-sol-and-luna-push-the-cost-efficiency-frontier",
      "date": "2026-09-22",
      "confidence": "secondary"
    },
    {
      "rung": "gpt-6-sol#max",
      "dim": "honesty",
      "value": 95.1,
      "benchmark": "OpenAI Broken Search Tool, 100 minus the failure rate",
      "version": "GPT-6 system card appendix 11.6.4.2",
      "url": "https://deploymentsafety.openai.com/gpt-6-astra/sec:appendix-sol-luna",
      "date": "2026-09-22",
      "confidence": "verified"
    },
    {
      "rung": "gpt-6-sol#medium",
      "dim": "honesty",
      "value": 95.1,
      "benchmark": "OpenAI Broken Search Tool, 100 minus the failure rate",
      "version": "GPT-6 system card appendix 11.6.4.2",
      "url": "https://deploymentsafety.openai.com/gpt-6-astra/sec:appendix-sol-luna",
      "date": "2026-09-22",
      "confidence": "inferred",
      "note": "measured at max effort; carried to this effort"
    },
    {
      "rung": "gpt-6-sol#high",
      "dim": "honesty",
      "value": 95.1,
      "benchmark": "OpenAI Broken Search Tool, 100 minus the failure rate",
      "version": "GPT-6 system card appendix 11.6.4.2",
      "url": "https://deploymentsafety.openai.com/gpt-6-astra/sec:appendix-sol-luna",
      "date": "2026-09-22",
      "confidence": "inferred",
      "note": "measured at max effort; carried to this effort"
    },
    {
      "rung": "gpt-6-sol#xhigh",
      "dim": "honesty",
      "value": 95.1,
      "benchmark": "OpenAI Broken Search Tool, 100 minus the failure rate",
      "version": "GPT-6 system card appendix 11.6.4.2",
      "url": "https://deploymentsafety.openai.com/gpt-6-astra/sec:appendix-sol-luna",
      "date": "2026-09-22",
      "confidence": "inferred",
      "note": "measured at max effort; carried to this effort"
    },
    {
      "rung": "gpt-6-luna#high",
      "dim": "repo_code",
      "value": 59.3,
      "benchmark": "DeepSWE",
      "version": "1.1",
      "url": "https://kingy.ai/blog/gpt-6-sol-luna-specs-benchmarks-pricing-comparison/",
      "date": "2026-09-22",
      "confidence": "inferred",
      "note": "the 0.x seed; only Luna max (66.6) is published"
    },
    {
      "rung": "gpt-6-luna#max",
      "dim": "repo_code",
      "value": 66.6,
      "benchmark": "DeepSWE",
      "version": "1.1",
      "url": "https://kingy.ai/blog/gpt-6-sol-luna-specs-benchmarks-pricing-comparison/",
      "date": "2026-09-22",
      "confidence": "secondary"
    },
    {
      "rung": "gpt-6-luna#max",
      "dim": "terminal",
      "value": 13,
      "benchmark": "Terminal-Bench",
      "version": "4.0",
      "url": "https://artificialanalysis.ai/articles/gpt-6-sol-and-luna-push-the-cost-efficiency-frontier",
      "date": "2026-09-22",
      "confidence": "secondary"
    },
    {
      "rung": "gpt-6-luna#max",
      "dim": "honesty",
      "value": 71.3,
      "benchmark": "OpenAI Broken Search Tool, 100 minus the failure rate",
      "version": "GPT-6 system card appendix 11.6.4.2",
      "url": "https://deploymentsafety.openai.com/gpt-6-astra/sec:appendix-sol-luna",
      "date": "2026-09-22",
      "confidence": "verified"
    },
    {
      "rung": "gpt-6-luna#high",
      "dim": "honesty",
      "value": 71.3,
      "benchmark": "OpenAI Broken Search Tool, 100 minus the failure rate",
      "version": "GPT-6 system card appendix 11.6.4.2",
      "url": "https://deploymentsafety.openai.com/gpt-6-astra/sec:appendix-sol-luna",
      "date": "2026-09-22",
      "confidence": "inferred",
      "note": "measured at max effort; carried to this effort"
    },
    {
      "rung": "gpt-6-astra#xhigh",
      "dim": "repo_code",
      "value": 74,
      "benchmark": "DeepSWE",
      "version": "1.1",
      "url": "https://deepswe.datacurve.ai/",
      "date": "2026-09-22",
      "confidence": "verified"
    },
    {
      "rung": "gpt-6-astra#high",
      "dim": "terminal",
      "value": 57.9,
      "benchmark": "Terminal-Bench",
      "version": "4.0",
      "url": "https://www-cdn.anthropic.com/fc1b44717c85dc068bc6ba5024219938094694bd/Claude%20Opus%205.5%20System%20Card.pdf",
      "date": "2026-09-22",
      "confidence": "secondary",
      "note": "OpenAI-reported, as quoted in the Opus 5.5 system card"
    },
    {
      "rung": "gpt-6-astra#max",
      "dim": "honesty",
      "value": 98.5,
      "benchmark": "OpenAI Broken Search Tool, 100 minus the failure rate",
      "version": "GPT-6 system card appendix 11.6.4.2",
      "url": "https://deploymentsafety.openai.com/gpt-6-astra/sec:appendix-sol-luna",
      "date": "2026-09-22",
      "confidence": "verified"
    },
    {
      "rung": "gpt-6-astra#xhigh",
      "dim": "honesty",
      "value": 98.5,
      "benchmark": "OpenAI Broken Search Tool, 100 minus the failure rate",
      "version": "GPT-6 system card appendix 11.6.4.2",
      "url": "https://deploymentsafety.openai.com/gpt-6-astra/sec:appendix-sol-luna",
      "date": "2026-09-22",
      "confidence": "inferred",
      "note": "measured at max effort; carried to this effort"
    },
    {
      "rung": "gpt-5.6-sol#max",
      "dim": "repo_code",
      "value": 73,
      "benchmark": "DeepSWE",
      "version": "1.1",
      "url": "https://deepswe.datacurve.ai/",
      "date": "2026-09-22",
      "confidence": "verified"
    },
    {
      "rung": "gpt-5.6-sol#max",
      "dim": "terminal",
      "value": 37.3,
      "benchmark": "Terminal-Bench",
      "version": "4.0",
      "url": "https://www-cdn.anthropic.com/fc1b44717c85dc068bc6ba5024219938094694bd/Claude%20Opus%205.5%20System%20Card.pdf",
      "date": "2026-09-22",
      "confidence": "secondary"
    },
    {
      "rung": "gpt-5.6-sol#max",
      "dim": "honesty",
      "value": 22.5,
      "benchmark": "OpenAI Broken Search Tool, 100 minus the failure rate",
      "version": "GPT-6 system card appendix 11.6.4.2",
      "url": "https://deploymentsafety.openai.com/gpt-6-astra/sec:appendix-sol-luna",
      "date": "2026-09-22",
      "confidence": "verified"
    },
    {
      "rung": "gpt-5.6-luna#max",
      "dim": "repo_code",
      "value": 67,
      "benchmark": "DeepSWE",
      "version": "1.1",
      "url": "https://deepswe.datacurve.ai/",
      "date": "2026-09-22",
      "confidence": "verified"
    },
    {
      "rung": "gpt-5.6-luna#max",
      "dim": "honesty",
      "value": 21.8,
      "benchmark": "OpenAI Broken Search Tool, 100 minus the failure rate",
      "version": "GPT-6 system card appendix 11.6.4.2",
      "url": "https://deploymentsafety.openai.com/gpt-6-astra/sec:appendix-sol-luna",
      "date": "2026-09-22",
      "confidence": "verified"
    },
    {
      "rung": "claude-opus-5-5#max",
      "dim": "repo_code",
      "value": 74.2,
      "benchmark": "DeepSWE",
      "version": "1.1",
      "url": "https://www-cdn.anthropic.com/fc1b44717c85dc068bc6ba5024219938094694bd/Claude%20Opus%205.5%20System%20Card.pdf",
      "date": "2026-09-22",
      "confidence": "verified",
      "note": "vendor-run, mean of 5 trials (system card 8.3)"
    },
    {
      "rung": "claude-opus-5-5#xhigh",
      "dim": "terminal",
      "value": 66.4,
      "benchmark": "Terminal-Bench",
      "version": "4.0",
      "url": "https://www-cdn.anthropic.com/fc1b44717c85dc068bc6ba5024219938094694bd/Claude%20Opus%205.5%20System%20Card.pdf",
      "date": "2026-09-22",
      "confidence": "verified",
      "note": "Claude Code --bare, 5 trials (system card 8.5)"
    },
    {
      "rung": "claude-opus-5-5#max",
      "dim": "terminal",
      "value": 64.8,
      "benchmark": "Terminal-Bench",
      "version": "4.0",
      "url": "https://www-cdn.anthropic.com/fc1b44717c85dc068bc6ba5024219938094694bd/Claude%20Opus%205.5%20System%20Card.pdf",
      "date": "2026-09-22",
      "confidence": "verified"
    },
    {
      "rung": "claude-fable-5-1#max",
      "dim": "terminal",
      "value": 55.8,
      "benchmark": "Terminal-Bench",
      "version": "4.0",
      "url": "https://www-cdn.anthropic.com/fc1b44717c85dc068bc6ba5024219938094694bd/Claude%20Opus%205.5%20System%20Card.pdf",
      "date": "2026-09-22",
      "confidence": "verified"
    },
    {
      "rung": "claude-fable-5-1#max",
      "dim": "repo_code",
      "value": 67.4,
      "benchmark": "DeepSWE",
      "version": "1.1",
      "url": "https://codingfleet.com/blog/deepswe-v11-leaderboard-2026/",
      "date": "2026-09-25",
      "confidence": "inferred",
      "note": "a 5-trial mean from a secondary source that names no effort"
    },
    {
      "rung": "claude-sonnet-5#max",
      "dim": "repo_code",
      "value": 54,
      "benchmark": "DeepSWE",
      "version": "1.1",
      "url": "https://deepswe.datacurve.ai/",
      "date": "2026-09-22",
      "confidence": "verified"
    }
  ],
  "treatLike": {
    "claude-opus-5-5#low": { "like": "claude-opus-5-5#xhigh", "note": "only xhigh and max are published" },
    "claude-opus-5-5#medium": { "like": "claude-opus-5-5#xhigh", "note": "only xhigh and max are published" },
    "claude-opus-5-5#high": { "like": "claude-opus-5-5#xhigh", "note": "only xhigh and max are published" }
  },
  "bars": {
    "repo_code": {
      "copy": { "repo_code": 55 },
      "build": { "repo_code": 55 },
      "logic": { "repo_code": 55, "honesty": 90 },
      "hard": { "repo_code": 55, "honesty": 90 }
    },
    "terminal": {
      "copy": { "honesty": 90 },
      "build": { "honesty": 90 },
      "logic": { "honesty": 90 },
      "hard": { "honesty": 90 }
    },
    "ui": {
      "copy": { "repo_code": 55 },
      "build": { "repo_code": 55 },
      "logic": { "repo_code": 55, "honesty": 90 },
      "hard": { "repo_code": 55, "honesty": 90 }
    },
    "prose": {
      "copy": { "repo_code": 55 },
      "build": { "repo_code": 55 },
      "logic": { "repo_code": 55, "honesty": 90 },
      "hard": { "repo_code": 55, "honesty": 90 }
    },
    "research": {
      "copy": { "repo_code": 55 },
      "build": { "repo_code": 55 },
      "logic": { "repo_code": 55, "honesty": 90 },
      "hard": { "repo_code": 55, "honesty": 90 }
    }
  },
  "barsWhy": "Track A (copy, build) needs DeepSWE 1.1 >= 55, which Luna high and every Sol rung from medium clear. Track B (logic, hard) also needs honesty >= 90: a worker on logic or hard work must say when a tool fails, which Luna (71.3) does not and Sol (95.1) does. Terminal-Bench 4.0 is published per effort only for Opus 5.5, so terminal lanes gate on honesty alone and use terminal scores to order the speed ladder."
}
```

- [ ] **Step 4: Write the schemas and the merge**

`src/infra/assets.ts`:

```ts
import { fileURLToPath } from "node:url";

/** A file shipped in the package, such as `catalog/models.json`; catherd ships its sources unbuilt. */
export const assetPath = (rel: string): string => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
```

`src/domain/catalog.ts`:

```ts
import { z } from "zod";
import { type Rung, parseRung } from "./ids.ts";
import { DIFFICULTIES, type Difficulty, KINDS, type Kind } from "./lane.ts";
import type { Role } from "./roles.ts";

/** Spec §5.2: the scored dimensions, each on one named benchmark. */
export const DIMS = ["repo_code", "terminal", "honesty"] as const;
export type Dim = (typeof DIMS)[number];

/**
 * Spec §7.1 `billing` keys: a rung's backend, except that opencode's Go models (`opencode-go/…`) are billed
 * apart from its Zen models (`opencode/…`).
 */
export const BILLING_KEYS = [
  "codex",
  "claude",
  "claude-code",
  "opencode-go",
  "opencode",
  "cursor",
  "grok",
] as const;
export type BillingKey = (typeof BILLING_KEYS)[number];

/** The keys a family's `on` map uses; the native `claude` pseudo-backend runs claude-code's model ids. */
export const MODEL_KEYS = ["codex", "claude-code", "opencode-go", "opencode", "cursor", "grok"] as const;
export type ModelKey = (typeof MODEL_KEYS)[number];

export function billingKeyOf(r: Rung): BillingKey {
  if (r.backend === "opencode" && r.model.startsWith("opencode-go/")) return "opencode-go";
  return r.backend;
}

const modelKeyOf = (k: BillingKey): ModelKey => (k === "claude" ? "claude-code" : k);

const BackendModelSchema = z.object({
  id: z.string().min(1),
  efforts: z.array(z.string().min(1)),
  context: z.number().int().positive(),
});

const FamilySchema = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  vendor: z.enum(["openai", "anthropic"]),
  status: z.enum(["current", "legacy"]).default("current"),
  capabilities: z.object({ toolUse: z.boolean(), imageIn: z.boolean(), reasoning: z.boolean() }),
  /** API list price, dollars per million tokens */
  price: z.object({ input: z.number(), cached: z.number(), output: z.number() }),
  /** chatgpt-plan: messages per 5 hours relative to GPT-6 Luna (spec §5.3) */
  planWeight: z.number().positive().optional(),
  /** claude-plan: billed as usage credits, not from the plan's limits */
  meteredOnPlan: z.boolean().default(false),
  on: z.partialRecord(z.enum(MODEL_KEYS), BackendModelSchema),
  notes: z.record(z.string(), z.string()).default({}),
});
export type Family = z.infer<typeof FamilySchema>;

export const ModelsFileSchema = z.looseObject({
  schema: z.literal(1),
  version: z.string(),
  sources: z.record(z.string(), z.string()),
  backends: z.record(
    z.string(),
    z.looseObject({
      imageGen: z.object({ tool: z.string(), requires: z.string(), source: z.string() }).optional(),
    }),
  ),
  families: z.array(FamilySchema),
});
export type ModelsFile = z.infer<typeof ModelsFileSchema>;

/** A canonical rung: `<canonical model id>#<effort>`, the key scores and treat-likes use. */
const CanonicalRung = z.string().regex(/^[^:#\s]+#[^#\s]+$/, "a canonical rung is model#effort");

export const ScoreSchema = z.object({
  rung: CanonicalRung,
  dim: z.enum(DIMS),
  value: z.number(),
  benchmark: z.string(),
  version: z.string(),
  url: z.url(),
  date: z.iso.date(),
  confidence: z.enum(["verified", "secondary", "inferred"]),
  note: z.string().optional(),
});
export type Score = z.infer<typeof ScoreSchema>;

const BarSchema = z.partialRecord(z.enum(DIMS), z.number());
export type Bars = Record<Kind, Record<Difficulty, Partial<Record<Dim, number>>>>;
const BarsSchema = z.record(z.enum(KINDS), z.record(z.enum(DIFFICULTIES), BarSchema));

export const ScoresFileSchema = z.looseObject({
  schema: z.literal(1),
  version: z.string(),
  benchmarks: z.record(z.enum(DIMS), z.object({ benchmark: z.string(), version: z.string() })),
  scores: z.array(ScoreSchema),
  treatLike: z.record(CanonicalRung, z.object({ like: CanonicalRung, note: z.string() })),
  bars: BarsSchema,
});
export type ScoresFile = z.infer<typeof ScoresFileSchema>;

/** `<config>/catalog.override.json` (spec §3.5): the user's treat-likes, scores and bars. */
export const OverrideSchema = z.looseObject({
  schema: z.literal(1).default(1),
  treatLike: z.record(CanonicalRung, CanonicalRung).default({}),
  scores: z.array(ScoreSchema).default([]),
  bars: z.partialRecord(z.enum(KINDS), z.partialRecord(z.enum(DIFFICULTIES), BarSchema)).default({}),
});
export type Override = z.infer<typeof OverrideSchema>;

export interface Listed {
  id: string;
  efforts: string[];
  context: number | null;
  imageIn: boolean;
}

/** Everything routing reads, merged from the three layers plus the user's override and own timings. */
export interface Catalog {
  families: Family[];
  backends: ModelsFile["backends"];
  /** canonical rung → its best-sourced value per dimension (the override's win) */
  scores: Record<string, Partial<Record<Dim, Score>>>;
  treatLike: Record<string, { like: string; source: "shipped" | "user" }>;
  bars: Bars;
  /** per backend id, the last `listModels()`; absent when never listed */
  listed: Record<string, { fetchedAt: string; models: Listed[] }>;
  /** `<canonical rung>|<kind or *>` → median seconds, only with ≥ 5 samples (spec §5.2) */
  secs: Record<string, number>;
}

const RANK: Record<Score["confidence"], number> = { verified: 0, secondary: 1, inferred: 2 };

export function buildCatalog(o: {
  models: ModelsFile;
  scores: ScoresFile;
  override?: Override;
  listed?: Catalog["listed"];
  secs?: Catalog["secs"];
}): Catalog {
  const scores: Catalog["scores"] = {};
  const put = (s: Score, force: boolean) => {
    const cur = (scores[s.rung] ??= {});
    const had = cur[s.dim];
    if (force || !had || RANK[s.confidence] < RANK[had.confidence]) cur[s.dim] = s;
  };
  for (const s of o.scores.scores) put(s, false);
  for (const s of o.override?.scores ?? []) put(s, true);
  const treatLike: Catalog["treatLike"] = {};
  for (const [rung, t] of Object.entries(o.scores.treatLike))
    treatLike[rung] = { like: t.like, source: "shipped" };
  for (const [rung, like] of Object.entries(o.override?.treatLike ?? {}))
    treatLike[rung] = { like, source: "user" };
  const bars = structuredClone(o.scores.bars) as Bars;
  for (const kind of KINDS)
    for (const d of DIFFICULTIES) {
      const bar = o.override?.bars[kind]?.[d];
      if (bar) bars[kind][d] = bar;
    }
  return {
    families: o.models.families,
    backends: o.models.backends,
    scores,
    treatLike,
    bars,
    listed: o.listed ?? {},
    secs: o.secs ?? {},
  };
}

/** What the catalog knows about one `backend:model#effort` rung. */
export interface RungInfo {
  rung: string;
  parsed: Rung;
  key: BillingKey;
  family: Family | null;
  /** `<family id or backend model id>#<effort>`: the key scores, treat-likes and timings use */
  canonical: string;
  efforts: string[];
  context: number | null;
  /** true when the backend's last listing has it, false when that listing lacks it, null with no listing */
  listed: boolean | null;
}

export function familyOf(c: Catalog, r: Rung): Family | null {
  const mk = modelKeyOf(billingKeyOf(r));
  return c.families.find((f) => f.on[mk]?.id === r.model) ?? null;
}

/** A rung's catalog facts; `rung` must parse (E_ADMIT_RUNG otherwise). */
export function rungInfo(c: Catalog, rung: string): RungInfo {
  const parsed = parseRung(rung);
  const key = billingKeyOf(parsed);
  const family = familyOf(c, parsed);
  const shipped = family?.on[modelKeyOf(key)];
  // the native `claude` backend has no listing of its own: it runs claude-code's models
  const listing = c.listed[parsed.backend === "claude" ? "claude-code" : parsed.backend];
  const found = listing?.models.find((m) => m.id === parsed.model);
  return {
    rung,
    parsed,
    key,
    family,
    canonical: `${family?.id ?? parsed.model}#${parsed.effort}`,
    efforts: found?.efforts ?? shipped?.efforts ?? [],
    context: found?.context ?? shipped?.context ?? null,
    listed: listing && listing.models.length > 0 ? found !== undefined : null,
  };
}

/** The rung's scores: its own, else those of the rung it is treated like. null when unscored. */
export function scoresOf(
  c: Catalog,
  canonical: string,
): { values: Partial<Record<Dim, number>>; records: Partial<Record<Dim, Score>>; via: string | null } | null {
  const own = c.scores[canonical];
  const via = own ? null : (c.treatLike[canonical]?.like ?? null);
  const records = own ?? (via ? c.scores[via] : undefined);
  if (!records || Object.keys(records).length === 0) return null;
  const values: Partial<Record<Dim, number>> = {};
  for (const d of DIMS) if (records[d]) values[d] = records[d].value;
  return { values, records, via };
}

/** Spec §4 roles: what a rung must offer to be placed on a role. */
export const ROLE_NEEDS: Record<Role, { toolUse?: true; imageIn?: true; imageGen?: true }> = {
  architect: { toolUse: true },
  verifier: { toolUse: true },
  worker: { toolUse: true },
  reviewer: { toolUse: true },
  "ui-reviewer": { toolUse: true, imageIn: true },
  artist: { imageGen: true },
  writer: { toolUse: true },
  researcher: { toolUse: true },
};

/**
 * A listed model catherd has no family for can use tools (Zen and Go serve coding models) and reports
 * its own image input; image generation is a backend capability (spec §5.2: Codex's tool).
 */
export function capableFor(c: Catalog, info: RungInfo, role: Role): boolean {
  const need = ROLE_NEEDS[role];
  const listedImage = c.listed[info.parsed.backend]?.models.find((m) => m.id === info.parsed.model)?.imageIn;
  const caps = info.family?.capabilities ?? {
    toolUse: true,
    imageIn: listedImage ?? false,
    reasoning: false,
  };
  if (need.toolUse && !caps.toolUse) return false;
  if (need.imageIn && !caps.imageIn) return false;
  if (need.imageGen && !c.backends[info.parsed.backend]?.imageGen) return false;
  return true;
}

/** An effort the rung's model offers; `default` (no effort flag, spec §5.1) always is. */
export const effortOffered = (info: RungInfo): boolean =>
  info.parsed.effort === "default" || info.efforts.includes(info.parsed.effort);
```

- [ ] **Step 5: Run them to verify they pass**

Run: `bun run format && bun test test/domain/catalog.test.ts test/infra/assets.test.ts && bun run typecheck && bun run lint && bun test test/architecture.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add catalog/models.json catalog/scores.json src/domain/catalog.ts src/infra/assets.ts test/domain/shipped.ts test/domain/catalog.test.ts test/infra/assets.test.ts
git commit -m "feat(domain): the 1.0 catalog: shipped models, sourced scores, treat-likes and bars"
```

---

### Task 2: The cost rank

Spec §5.3 per billing mode, in one unit (Ruling 1), with Fable metered on a Claude plan (Ruling 2) and subscription rungs always before metered ones.

**Files:**
- Create: `src/domain/cost.ts`
- Test: `test/domain/cost.test.ts`

**Interfaces:**
- Consumes: Task 1's `Family`, `BillingKey`, `shippedModels()`.
- Produces: `BILLING_MODES`, `type BillingMode = "chatgpt-plan" | "claude-plan" | "subscription" | "metered"`; `DEFAULT_BILLING: Record<BillingKey, BillingMode>`; `EFFORT_FACTOR`, `effortFactor(effort)`; `REF_TASK`; `taskUsd(price, effort): number`; `CHATGPT_UNIT_USD`; `interface Cost { tier: 0 | 1; value: number | null; mode: BillingMode }`; `costOf(family: Family | null, effort: string, mode: BillingMode): Cost`; `compareCost(a, b): number`.

- [ ] **Step 1: Write the failing test**

`test/domain/cost.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  CHATGPT_UNIT_USD,
  compareCost,
  costOf,
  DEFAULT_BILLING,
  effortFactor,
  taskUsd,
} from "../../src/domain/cost.ts";
import { shippedModels } from "./shipped.ts";

const fam = (id: string) => {
  const f = shippedModels().families.find((x) => x.id === id);
  if (!f) throw new Error(id);
  return f;
};

describe("cost rank (spec §5.3)", () => {
  it("keeps the chatgpt-plan unit equal to one GPT-6 Luna task at medium", () => {
    expect(taskUsd(fam("gpt-6-luna").price, "medium")).toBeCloseTo(CHATGPT_UNIT_USD, 6);
  });

  it("weights ChatGPT-plan rungs by the official quota: Luna 1, Sol 20, Astra 60, times the effort", () => {
    const v = (id: string, e: string) => costOf(fam(id), e, "chatgpt-plan").value as number;
    expect(v("gpt-6-sol", "medium") / v("gpt-6-luna", "medium")).toBeCloseTo(20, 6);
    expect(v("gpt-6-astra", "medium") / v("gpt-6-luna", "medium")).toBeCloseTo(60, 6);
    expect(v("gpt-6-luna", "high")).toBeLessThan(v("gpt-6-sol", "medium"));
    expect(v("gpt-6-sol", "ultra")).toBeGreaterThan(v("gpt-6-sol", "max"));
  });

  it("ranks Claude-plan rungs by API price, with Fable metered", () => {
    const opus = costOf(fam("claude-opus-5-5"), "high", "claude-plan");
    const haiku = costOf(fam("claude-haiku-4-5"), "default", "claude-plan");
    const fable = costOf(fam("claude-fable-5-1"), "low", "claude-plan");
    expect([opus.tier, haiku.tier, fable.tier]).toEqual([0, 0, 1]);
    expect(compareCost(haiku, opus)).toBeLessThan(0);
  });

  it("puts every subscription rung before any metered rung, whatever the value", () => {
    const zenLuna = costOf(fam("gpt-6-luna"), "low", "metered");
    const solMax = costOf(fam("gpt-6-sol"), "max", "chatgpt-plan");
    const goLuna = costOf(fam("gpt-6-luna"), "high", "subscription");
    expect(compareCost(solMax, zenLuna)).toBeLessThan(0);
    expect(compareCost(goLuna, zenLuna)).toBeLessThan(0);
  });

  it("orders an unknown model last in its tier, and an unknown effort as medium", () => {
    const unknown = costOf(null, "high", "subscription");
    expect(unknown).toEqual({ tier: 0, value: null, mode: "subscription" });
    expect(compareCost(costOf(fam("gpt-6-sol"), "max", "subscription"), unknown)).toBeLessThan(0);
    expect(effortFactor("thinking")).toBe(1);
  });

  it("bills the spec's default keys", () => {
    expect(DEFAULT_BILLING).toMatchObject({
      codex: "chatgpt-plan",
      claude: "claude-plan",
      "claude-code": "claude-plan",
      "opencode-go": "subscription",
      opencode: "metered",
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/domain/cost.test.ts`
Expected: FAIL — `Cannot find module '../../src/domain/cost.ts'`.

- [ ] **Step 3: Implement**

`src/domain/cost.ts`:

```ts
import type { BillingKey, Family } from "./catalog.ts";

/** Spec §5.3: how the user pays for each billing key. */
export const BILLING_MODES = ["chatgpt-plan", "claude-plan", "subscription", "metered"] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

/** Spec §7.1's default `billing`: the owner's Codex/ChatGPT plan, Claude plan and OpenCode Go. */
export const DEFAULT_BILLING: Record<BillingKey, BillingMode> = {
  codex: "chatgpt-plan",
  claude: "claude-plan",
  "claude-code": "claude-plan",
  "opencode-go": "subscription",
  opencode: "metered",
  cursor: "metered",
  grok: "metered",
};

/**
 * Tokens per task relative to `medium`, from GPT-6 Sol's published DeepSWE dollars per task
 * (low 0.16, medium 0.38, high 0.64, xhigh 1.00, max 2.74; research 2026-09-25-models.md §3.1).
 * `ultra` is `max` with parallel subagents: ×4 is catherd's estimate. An unknown variant counts as 1.
 */
export const EFFORT_FACTOR: Record<string, number> = {
  none: 0.3,
  minimal: 0.3,
  low: 0.4,
  medium: 1,
  default: 1,
  high: 1.7,
  xhigh: 2.6,
  max: 7.2,
  ultra: 28.8,
};

/** A reference task at medium effort: uncached input, cached input and output tokens (≈ $0.38 on Sol). */
export const REF_TASK = { input: 60_000, cached: 400_000, output: 18_000 };

export const effortFactor = (effort: string): number => EFFORT_FACTOR[effort] ?? 1;

/** Estimated list-price dollars for one task at `effort`. */
export function taskUsd(price: Family["price"], effort: string): number {
  const perTask =
    REF_TASK.input * price.input + REF_TASK.cached * price.cached + REF_TASK.output * price.output;
  return (perTask / 1_000_000) * effortFactor(effort);
}

/** One GPT-6 Luna task at medium, in list-price dollars: the unit of a chatgpt-plan weight of 1. */
export const CHATGPT_UNIT_USD = 0.019;

export interface Cost {
  /** 0: paid from a subscription; 1: metered. Every tier-0 rung ranks before any tier-1 rung. */
  tier: 0 | 1;
  /** comparable across billing modes, in list-price dollars per task; null when unknown */
  value: number | null;
  mode: BillingMode;
}

/**
 * Spec §5.3. Every mode yields list-price dollars per task, so plans compare with each other:
 * chatgpt-plan scales the official quota weight (Luna 1, Sol 20, Astra 60) by the effort factor;
 * claude-plan uses API prices as the proxy, with Fable metered (catherd cannot tell Pro from Max);
 * Go's share of its monthly dollar limit is dollars / limit, which orders the same as dollars.
 */
export function costOf(family: Family | null, effort: string, mode: BillingMode): Cost {
  if (!family) return { tier: mode === "metered" ? 1 : 0, value: null, mode };
  const usd = taskUsd(family.price, effort);
  switch (mode) {
    case "chatgpt-plan":
      return {
        tier: 0,
        value:
          family.planWeight === undefined ? usd : family.planWeight * CHATGPT_UNIT_USD * effortFactor(effort),
        mode,
      };
    case "claude-plan":
      return { tier: family.meteredOnPlan ? 1 : 0, value: usd, mode };
    case "subscription":
      return { tier: 0, value: usd, mode };
    case "metered":
      return { tier: 1, value: usd, mode };
  }
}

/** Cheaper first: tier, then value, an unknown value last. */
export function compareCost(a: Cost, b: Cost): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.value === null || b.value === null) return (a.value === null ? 1 : 0) - (b.value === null ? 1 : 0);
  return a.value - b.value;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run format && bun test test/domain/cost.test.ts && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/cost.ts test/domain/cost.test.ts
git commit -m "feat(domain): cost rank per billing mode, subscription before metered"
```

---

### Task 3: Selection, the speed ladder, and the approved-ladder pin

0.x's `candidates`/`select`/speed ladder, ported onto the new catalog: rungs are `backend:model#effort`, a rung must be offered by its model and by the backend's listing (Review Focus 4), cost comes from Task 2, and speed from the user's own timings. The approved ladder is pinned for every kind and difficulty on the shipped data.

**Files:**
- Create: `src/domain/select.ts`
- Test: `test/domain/select.test.ts`

**Interfaces:**
- Consumes: Task 1 (`Catalog`, `rungInfo`, `scoresOf`, `capableFor`, `effortOffered`, `Dim`, `shipped()`), Task 2 (`Cost`, `costOf`, `compareCost`, `DEFAULT_BILLING`, `BillingMode`), `CatherdError`.
- Produces: `interface RoutingProfile { objective: "cost" | "speed"; billing: Partial<Record<string, BillingMode>>; role: { enabled: boolean; rungs: string[]; defaultRung?: string } }`; `interface Candidate { rung; info: RungInfo; scores; cost: Cost; secs: number | null }`; `interface Pick { rung: string; ladder: string[] }`; `secsOf(c, canonical, kind | null)`; `candidates(c, p, role, kind?): Candidate[]`; `clearsBar(c, cand, kind, difficulty)`; `defaultLadder(c, p, role): Pick`; `select(c, p, role, kind, difficulty): Pick` (both throw `E_CONFIG_INVALID` for a role with no usable rung).

- [ ] **Step 1: Write the failing test**

`test/domain/select.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { DIFFICULTIES, type Difficulty, KINDS, type Kind } from "../../src/domain/lane.ts";
import { candidates, defaultLadder, type RoutingProfile, select } from "../../src/domain/select.ts";
import { shipped } from "./shipped.ts";

const LADDER = [
  "codex:gpt-6-luna#high",
  "codex:gpt-6-sol#medium",
  "codex:gpt-6-sol#high",
  "codex:gpt-6-sol#xhigh",
];
const TRACK_A = { rung: LADDER[0] as string, ladder: LADDER };
const TRACK_B = { rung: LADDER[1] as string, ladder: LADDER.slice(1) };

/** Spec §7.2's default worker: the four Codex rungs, default sol#medium, the owner's billing. */
const worker = (over: Partial<RoutingProfile> = {}, rungs = LADDER): RoutingProfile => ({
  objective: "cost",
  billing: {},
  role: { enabled: true, rungs, defaultRung: "codex:gpt-6-sol#medium" },
  ...over,
});

/** Spec §5.2: the approved ladder, re-derived on the 2026-09-25 benchmarks. */
const approved = (kind: Kind, d: Difficulty) =>
  kind !== "terminal" && (d === "copy" || d === "build") ? TRACK_A : TRACK_B;

describe("the approved ladder: default worker on the shipped catalog", () => {
  for (const kind of KINDS)
    for (const d of DIFFICULTIES)
      it(`${kind}/${d}`, () => {
        expect(select(shipped(), worker(), "worker", kind, d)).toEqual(approved(kind, d));
      });

  it("falls back to Track B from the default rung", () => {
    expect(defaultLadder(shipped(), worker(), "worker")).toEqual(TRACK_B);
  });

  it("holds with the rungs enabled in any order", () => {
    expect(select(shipped(), worker({}, [...LADDER].reverse()), "worker", "repo_code", "build")).toEqual(
      TRACK_A,
    );
  });
});

describe("select", () => {
  it("runs a single-rung role on that rung, whatever the bar", () => {
    const p = worker({}, ["claude:claude-opus-5-5#high"]);
    expect(select(shipped(), p, "architect", "repo_code", "copy")).toEqual({
      rung: "claude:claude-opus-5-5#high",
      ladder: ["claude:claude-opus-5-5#high"],
    });
  });

  it("skips bad, unoffered, unlisted, incapable and unscored rungs, and refuses an empty role", () => {
    const listed = {
      codex: {
        fetchedAt: "2026-09-25T00:00:00.000Z",
        models: [
          {
            id: "gpt-6-sol",
            efforts: ["low", "medium", "high", "xhigh", "max"],
            context: 272000,
            imageIn: true,
          },
        ],
      },
    };
    const p = worker({}, [
      "nonsense",
      "codex:gpt-6-sol#ultra",
      "codex:gpt-6-luna#high",
      "codex:gpt-6-sol#low",
      "opencode:opencode-go/kimi-k3#default",
      "codex:gpt-6-sol#medium",
    ]);
    expect(candidates(shipped({ listed }), p, "worker").map((x) => x.rung)).toEqual([
      "codex:gpt-6-sol#low",
      "codex:gpt-6-sol#medium",
    ]);
    expect(() =>
      select(shipped(), worker({}, ["claude-code:claude-opus-5-5#high"]), "artist", "ui", "build"),
    ).toThrow(/role "artist" has no enabled, capable, scored rung/);
    expect(candidates(shipped(), { ...worker(), role: { enabled: false, rungs: LADDER } }, "worker")).toEqual(
      [],
    );
  });

  it("places a treat-like rung with the scores it borrows", () => {
    const c = shipped({
      override: {
        schema: 1,
        treatLike: { "opencode-go/kimi-k3#default": "gpt-6-sol#medium" },
        scores: [],
        bars: {},
      },
    });
    const p = worker({}, [...LADDER, "opencode:opencode-go/kimi-k3#default"]);
    expect(select(c, p, "worker", "repo_code", "logic").ladder).toEqual([
      "codex:gpt-6-sol#medium",
      "codex:gpt-6-sol#high",
      "codex:gpt-6-sol#xhigh",
      "opencode:opencode-go/kimi-k3#default",
    ]);
  });

  it("ranks subscription rungs before metered ones, then by cost", () => {
    const p = worker({}, [
      "opencode:opencode/gpt-6-luna#high",
      "codex:gpt-6-sol#xhigh",
      "opencode:opencode-go/gpt-6-luna#high",
    ]);
    expect(candidates(shipped(), p, "worker").map((x) => x.rung)).toEqual([
      "opencode:opencode-go/gpt-6-luna#high",
      "codex:gpt-6-sol#xhigh",
      "opencode:opencode/gpt-6-luna#high",
    ]);
  });
});

describe("objective speed", () => {
  it("orders by effort within a model until a rung has 5 own runs, then by its median seconds", () => {
    const speed = worker({ objective: "speed" });
    expect(candidates(shipped(), speed, "worker").map((x) => x.rung)).toEqual(LADDER);
    const secs = { "gpt-6-sol#medium|*": 264, "gpt-6-sol#high|*": 391 };
    expect(candidates(shipped({ secs }), speed, "worker").map((x) => x.rung)).toEqual([
      "codex:gpt-6-sol#medium",
      "codex:gpt-6-sol#high",
      "codex:gpt-6-luna#high",
      "codex:gpt-6-sol#xhigh",
    ]);
  });

  it("uses the kind's own timings before the all-kinds median", () => {
    const secs = { "gpt-6-sol#high|terminal": 100, "gpt-6-sol#high|*": 900, "gpt-6-sol#medium|*": 300 };
    const order = candidates(shipped({ secs }), worker({ objective: "speed" }), "worker", "terminal");
    expect(order.map((x) => x.rung).slice(0, 2)).toEqual(["codex:gpt-6-sol#high", "codex:gpt-6-sol#medium"]);
  });

  it("starts fast but never climbs onto a weaker rung", () => {
    const secs = { "gpt-6-sol#medium|repo_code": 200, "gpt-6-luna#high|repo_code": 500 };
    const d = select(shipped({ secs }), worker({ objective: "speed" }), "worker", "repo_code", "copy");
    expect(d).toEqual({
      rung: "codex:gpt-6-sol#medium",
      ladder: [
        "codex:gpt-6-sol#medium",
        "codex:gpt-6-luna#high",
        "codex:gpt-6-sol#high",
        "codex:gpt-6-sol#xhigh",
      ],
    });
  });

  it("keeps the approved pin under cost whatever the timings", () => {
    const secs = { "gpt-6-sol#medium|*": 1, "gpt-6-luna#high|*": 9999 };
    expect(select(shipped({ secs }), worker(), "worker", "repo_code", "copy")).toEqual(TRACK_A);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/domain/select.test.ts`
Expected: FAIL — `Cannot find module '../../src/domain/select.ts'`.

- [ ] **Step 3: Implement**

`src/domain/select.ts`:

```ts
import {
  type Catalog,
  capableFor,
  type Dim,
  effortOffered,
  type RungInfo,
  rungInfo,
  scoresOf,
} from "./catalog.ts";
import { type BillingMode, type Cost, compareCost, costOf, DEFAULT_BILLING } from "./cost.ts";
import { CatherdError } from "./errors.ts";
import type { Difficulty, Kind } from "./lane.ts";
import type { Role } from "./roles.ts";

/** What routing reads from a profile for one role. */
export interface RoutingProfile {
  objective: "cost" | "speed";
  billing: Partial<Record<string, BillingMode>>;
  role: { enabled: boolean; rungs: string[]; defaultRung?: string };
}

export interface Candidate {
  rung: string;
  info: RungInfo;
  scores: Partial<Record<Dim, number>>;
  cost: Cost;
  /** median seconds over the user's own runs (≥ 5 samples), else null */
  secs: number | null;
}

export interface Pick {
  rung: string;
  ladder: string[];
}

const byNull = (a: number | null, b: number | null) =>
  a === null || b === null ? (a === null ? 1 : 0) - (b === null ? 1 : 0) : a - b;

export function secsOf(c: Catalog, canonical: string, kind: Kind | null): number | null {
  return c.secs[`${canonical}|${kind ?? "*"}`] ?? c.secs[`${canonical}|*`] ?? null;
}

/**
 * The role's enabled rungs that the catalog can place: parseable, offered by their model, listed by
 * the backend when it has a listing, capable for the role, and scored (their own or a treat-like).
 * Ordered by cost (spec §5.3), or by measured speed with cost breaking ties; with fewer than 5
 * samples a rung has no speed, and cost orders it, which within a model is effort order.
 */
export function candidates(c: Catalog, p: RoutingProfile, role: Role, kind: Kind | null = null): Candidate[] {
  if (!p.role.enabled) return [];
  const out: Candidate[] = [];
  for (const rung of new Set(p.role.rungs)) {
    let info: RungInfo;
    try {
      info = rungInfo(c, rung);
    } catch {
      continue;
    }
    if (!effortOffered(info) || info.listed === false || !capableFor(c, info, role)) continue;
    const s = scoresOf(c, info.canonical);
    if (!s) continue;
    const mode = p.billing[info.key] ?? DEFAULT_BILLING[info.key];
    out.push({
      rung,
      info,
      scores: s.values,
      cost: costOf(info.family, info.parsed.effort, mode),
      secs: secsOf(c, info.canonical, kind),
    });
  }
  const cost = (a: Candidate, b: Candidate) => compareCost(a.cost, b.cost) || byNull(a.secs, b.secs);
  const speed = (a: Candidate, b: Candidate) => byNull(a.secs, b.secs) || compareCost(a.cost, b.cost);
  return out.sort(p.objective === "speed" ? speed : cost);
}

export function clearsBar(c: Catalog, cand: Candidate, kind: Kind, difficulty: Difficulty): boolean {
  return Object.entries(c.bars[kind][difficulty]).every(
    ([dim, min]) => min === undefined || (cand.scores[dim as Dim] ?? Number.NEGATIVE_INFINITY) >= min,
  );
}

function noRung(role: Role): CatherdError {
  return new CatherdError("E_CONFIG_INVALID", `role "${role}" has no enabled, capable, scored rung`, {
    fix: "run profile_validate, then enable a scored rung or map one with catherd catalog treat-like",
  });
}

/** The role's default rung and every candidate above it (the whole list when it has no default). */
export function defaultLadder(c: Catalog, p: RoutingProfile, role: Role): Pick {
  const all = candidates(c, p, role).map((x) => x.rung);
  if (all.length === 0) throw noRung(role);
  const i = Math.max(0, all.indexOf(p.role.defaultRung ?? ""));
  return { rung: all[i] as string, ladder: all.slice(i) };
}

/**
 * Under `objective: "speed"` the objective picks only the start (the fastest bar-clearing rung); the
 * ladder above it is the other bar-clearing rungs at least as strong on the kind's primary dimension,
 * weakest first, cost breaking ties, so a lane never climbs onto a weaker rung. Ported from 0.x.
 */
function speedLadder(clearing: Candidate[], kind: Kind): Pick {
  const start = clearing[0] as Candidate;
  const dim: Dim = kind === "terminal" ? "terminal" : "repo_code";
  const strength = (x: Candidate) => x.scores[dim] ?? Number.NEGATIVE_INFINITY;
  const rest = clearing
    .filter((x) => x !== start && strength(x) >= strength(start))
    .sort((a, b) => strength(a) - strength(b) || compareCost(a.cost, b.cost));
  return { rung: start.rung, ladder: [start, ...rest].map((x) => x.rung) };
}

/** Spec §5.4: the start rung and ladder for a lane of this kind and difficulty (0.x `select`). */
export function select(c: Catalog, p: RoutingProfile, role: Role, kind: Kind, difficulty: Difficulty): Pick {
  const all = candidates(c, p, role, kind);
  if (all.length === 0) throw noRung(role);
  if (all.length === 1) return { rung: all[0]?.rung as string, ladder: [all[0]?.rung as string] };
  const clearing = all.filter((x) => clearsBar(c, x, kind, difficulty));
  if (clearing.length === 0) return defaultLadder(c, p, role);
  return p.objective === "speed"
    ? speedLadder(clearing, kind)
    : { rung: clearing[0]?.rung as string, ladder: clearing.map((x) => x.rung) };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run format && bun test test/domain && bun run typecheck && bun run lint`
Expected: PASS, including all 20 `the approved ladder` cases.

- [ ] **Step 5: Commit**

```bash
git add src/domain/select.ts test/domain/select.test.ts
git commit -m "feat(domain): port select and the speed ladder; pin the approved ladder on the new bars"
```

---

### Task 4: Jev's question sets and decision rules

Spec §5.5 as data and pure functions: `route-v2` (kind as a choice with `other`, difficulty as a four-level score written as situations, the seven atomic nouls), `finding` and `same-defect` with their probability thresholds, each named by a content hash; the trimmed, scrubbed lane state; strict answer parsing; the track-sum rule with its dead band (Ruling 6).

**Files:**
- Create: `catalog/jev.json`, `src/domain/jev.ts`
- Create: `test/fixtures/jev/route-v2-track-a.json`, `test/fixtures/jev/route-v2-track-b.json`, `test/fixtures/jev/route-v2-unsure.json`, `test/fixtures/jev/rate-limited.json`, `test/fixtures/jev/validation-error.json`
- Test: `test/domain/jev.test.ts`

**Interfaces:**
- Consumes: `parseLaneHeader`, `KINDS`, `Kind`, `Difficulty` (`src/domain/lane.ts`); the recorded fixtures `finding-design.json`, `finding-unsure.json`, `same-defect-yes.json`, `auth-error.json`, `route-confident.json`.
- Produces: `JevFileSchema`, `type JevFile`, `type SetName = "route-v2" | "finding" | "same-defect"`, `type JevQuestion`, `type RouteRule`, `type VerdictRule`; `canonicalJson(v)`, `sha256(s)`, `questionSetId(f, name): string` (`<name>#<8 hex>`), `requestKey(model, state, questions): string`; `scrubSecrets(text)`, `BODY_MAX`, `interface LaneState { title; owns; fast_check; body }`, `laneState(text): LaneState`; `type JevAnswer`, `type JevAnswers`, `type ParsedReply`, `parseReply(questions, body): ParsedReply`; `interface RouteJudgement { kind; pKind; track: "A" | "B" | null; difficulty; pA; pB; nouls; rule }`, `judgeRoute(rule, answers)`; `interface Verdict<T> { value; probability; confidence; source: "jev" | "default" }`, `judgeVerdict(rule, id, options, answers)`.

- [ ] **Step 1: Write the fixtures and the failing test**

The `route-v2-*` fixtures are synthetic (no live key was available): shaped exactly like the documented `choice`, `score` and `noul` answers and the recorded 0.x fixtures.

`test/fixtures/jev/route-v2-track-a.json`:

```json
{"model":"jev-1.13.0","answers":{"kind":{"type":"choice","choice":"repo_code","confidence":0.99,"probabilities":{"repo_code":0.99,"terminal":0.0,"ui":0.01,"prose":0.0,"research":0.0,"other":0.0}},"difficulty":{"type":"score","score":0.9,"legend":{"0":"A mechanical change","1":"New code that follows an existing example","2":"New logic","3":"A cause nobody has found yet"},"probabilities":{"0":0.3,"1":0.6,"2":0.08,"3":0.02},"confidence":0.47},"names_pattern":{"type":"noul","noul":0.93},"mechanical":{"type":"noul","noul":0.21},"shared_state":{"type":"noul","noul":0.04},"unclear_cause":{"type":"noul","noul":0.02},"open_design":{"type":"noul","noul":0.11},"cross_boundary":{"type":"noul","noul":0.03},"outside_repo":{"type":"noul","noul":0.05}},"usage":{"input_tokens":812,"output_tokens":210}}
```

`test/fixtures/jev/route-v2-track-b.json`:

```json
{"model":"jev-1.13.0","answers":{"kind":{"type":"choice","choice":"repo_code","confidence":0.95,"probabilities":{"repo_code":0.96,"terminal":0.03,"ui":0.0,"prose":0.0,"research":0.01,"other":0.0}},"difficulty":{"type":"score","score":2.6,"legend":{"0":"A mechanical change","1":"New code that follows an existing example","2":"New logic","3":"A cause nobody has found yet"},"probabilities":{"0":0.01,"1":0.04,"2":0.3,"3":0.65},"confidence":0.53},"names_pattern":{"type":"noul","noul":0.12},"mechanical":{"type":"noul","noul":0.01},"shared_state":{"type":"noul","noul":0.71},"unclear_cause":{"type":"noul","noul":0.88},"open_design":{"type":"noul","noul":0.4},"cross_boundary":{"type":"noul","noul":0.2},"outside_repo":{"type":"noul","noul":0.1}},"usage":{"input_tokens":790,"output_tokens":205}}
```

`test/fixtures/jev/route-v2-unsure.json`:

```json
{"model":"jev-1.13.0","answers":{"kind":{"type":"choice","choice":"terminal","confidence":0.5,"probabilities":{"repo_code":0.35,"terminal":0.58,"ui":0.0,"prose":0.0,"research":0.02,"other":0.05}},"difficulty":{"type":"score","score":1.5,"legend":{"0":"A mechanical change","1":"New code that follows an existing example","2":"New logic","3":"A cause nobody has found yet"},"probabilities":{"0":0.1,"1":0.45,"2":0.35,"3":0.1},"confidence":0.27},"names_pattern":{"type":"noul","noul":0.5},"mechanical":{"type":"noul","noul":0.2},"shared_state":{"type":"noul","noul":0.3},"unclear_cause":{"type":"noul","noul":0.2},"open_design":{"type":"noul","noul":0.5},"cross_boundary":{"type":"noul","noul":0.1},"outside_repo":{"type":"noul","noul":0.6}},"usage":{"input_tokens":801,"output_tokens":207}}
```

`test/fixtures/jev/rate-limited.json`:

```json
{"detail":{"error_type":"rate_limit_error","message":"Rate limit exceeded. Please retry after the time in the Retry-After header."}}
```

`test/fixtures/jev/validation-error.json`:

```json
{"detail":{"error_type":"validation_error","message":"questions.difficulty.criteria: expected an array of 2 to 10 levels"}}
```

`test/domain/jev.test.ts`:

````ts
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BODY_MAX,
  canonicalJson,
  JevFileSchema,
  judgeRoute,
  judgeVerdict,
  laneState,
  parseReply,
  questionSetId,
  requestKey,
  scrubSecrets,
} from "../../src/domain/jev.ts";

const root = join(import.meta.dir, "..", "..");
const jevFile = () =>
  JevFileSchema.parse(JSON.parse(readFileSync(join(root, "catalog", "jev.json"), "utf8")));
const fixture = (n: string): unknown =>
  JSON.parse(readFileSync(join(root, "test", "fixtures", "jev", n), "utf8"));
const route = () => jevFile().sets["route-v2"];

describe("the route-v2 question set", () => {
  it("asks kind as a choice with other, difficulty as a four-level score, and the seven nouls", () => {
    const q = route().questions;
    expect(q.kind?.type).toBe("choice");
    expect(Object.keys(q.kind?.type === "choice" ? q.kind.criteria : {})).toContain("other");
    expect(q.difficulty?.type === "score" && q.difficulty.criteria).toHaveLength(4);
    expect(Object.keys(q).filter((k) => q[k]?.type === "noul")).toEqual([
      "names_pattern",
      "mechanical",
      "shared_state",
      "unclear_cause",
      "open_design",
      "cross_boundary",
      "outside_repo",
    ]);
  });

  it("names each set by a content hash that changes with any question or threshold", () => {
    const f = jevFile();
    const id = questionSetId(f, "route-v2");
    expect(id).toMatch(/^route-v2#[0-9a-f]{8}$/);
    expect(questionSetId(f, "route-v2")).toBe(id);
    f.sets["route-v2"].rule.trackMin = 0.75;
    expect(questionSetId(f, "route-v2")).not.toBe(id);
  });

  it("hashes requests independently of key order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(requestKey("m", { a: 1, b: 2 }, {})).toBe(requestKey("m", { b: 2, a: 1 }, {}));
  });
});

describe("laneState", () => {
  it("keeps the header as fields and drops header lines, code and secrets from the body", () => {
    const s = laneState(
      [
        "# M1.L2 — jobs endpoint",
        "Owns: src/jobs.ts, test/jobs.test.ts",
        "Fast check: bun test test/jobs.test.ts",
        "Kind: repo_code",
        "Difficulty: build",
        "Add GET /jobs like src/users.ts does.",
        "```ts",
        "const secretCode = 1;",
        "```",
        "Use OPENAI_API_KEY=sk-abcdefghijklmnopqrstuv and token: ghp_abcdefghijklmnopqrstuvwxyz0123",
      ].join("\n"),
    );
    expect(s.title).toBe("M1.L2 — jobs endpoint");
    expect(s.owns).toEqual(["src/jobs.ts", "test/jobs.test.ts"]);
    expect(s.fast_check).toBe("bun test test/jobs.test.ts");
    expect(s.body).toContain("Add GET /jobs like src/users.ts does.");
    expect(s.body).toContain("[code omitted]");
    for (const gone of ["secretCode", "sk-abc", "ghp_", "Kind:", "Difficulty:", "Owns:"])
      expect(s.body).not.toContain(gone);
  });

  it("caps the body", () => {
    expect(laneState(`# M1.L1 — x\n${"word ".repeat(5000)}`).body.length).toBe(BODY_MAX + 1);
  });

  it("scrubs private keys and key=value secrets", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----";
    expect(scrubSecrets(`${pem} DB_PASSWORD=hunter22 AKIAABCDEFGHIJKLMNOP`)).toBe(
      "[secret] DB_PASSWORD=[secret] [secret]",
    );
  });
});

describe("parseReply", () => {
  it("reads choice, score and noul answers with the model and usage", () => {
    const r = parseReply(route().questions, fixture("route-v2-track-a.json"));
    expect(r.ok && r.model).toBe("jev-1.13.0");
    expect(r.ok && r.usage).toEqual({ input_tokens: 812, output_tokens: 210 });
    expect(r.ok && r.answers.names_pattern).toEqual({ type: "noul", noul: 0.93 });
  });

  it("refuses a missing answer, a wrong type and a choice outside the criteria", () => {
    const qs = route().questions;
    const body = fixture("route-v2-track-a.json") as { answers: Record<string, unknown> };
    const without = { ...body, answers: { ...body.answers, outside_repo: undefined } };
    expect(parseReply(qs, without)).toEqual({ ok: false, error: "no valid answer to outside_repo" });
    const wrongType = { ...body, answers: { ...body.answers, mechanical: body.answers.kind } };
    expect(parseReply(qs, wrongType)).toEqual({ ok: false, error: "no valid answer to mechanical" });
    const f = fixture("finding-design.json") as { answers: { finding: { choice: string } } };
    f.answers.finding.choice = "maybe";
    expect(parseReply(jevFile().sets.finding.questions, f)).toEqual({
      ok: false,
      error: "no valid answer to finding",
    });
    expect(parseReply(qs, fixture("auth-error.json"))).toEqual({ ok: false, error: "unexpected response" });
  });
});

describe("judgeRoute", () => {
  const judge = (n: string) => {
    const r = parseReply(route().questions, fixture(n));
    if (!r.ok) throw new Error(r.error);
    return judgeRoute(route().rule, r.answers);
  };

  it("puts copy+build mass on Track A even when no single level is confident", () => {
    expect(judge("route-v2-track-a.json")).toMatchObject({
      kind: "repo_code",
      track: "A",
      difficulty: "build",
      pA: 0.9,
      pB: 0.1,
      rule: "P(A) 0.9 ≥ 0.8",
    });
  });

  it("puts logic+hard mass on Track B, hard when level 3 leads", () => {
    expect(judge("route-v2-track-b.json")).toMatchObject({ track: "B", difficulty: "hard", pB: 0.95 });
  });

  it("decides nothing in the dead band, and no kind below kindMin", () => {
    const j = judge("route-v2-unsure.json");
    expect(j).toMatchObject({ kind: null, pKind: 0.58, track: null, difficulty: null, pA: 0.55 });
    expect(j.nouls.outside_repo).toBe(0.6);
  });

  it("decides at exactly the threshold, and never takes other as a kind", () => {
    const rule = route().rule;
    const at = judgeRoute(rule, {
      kind: { type: "choice", choice: "other", confidence: 1, probabilities: { other: 1 } },
      difficulty: {
        type: "score",
        score: 1,
        confidence: 0.5,
        probabilities: { "0": 0.5, "1": 0.3, "2": 0.2 },
      },
    });
    expect([at.kind, at.track, at.difficulty]).toEqual([null, "A", "copy"]);
  });
});

describe("judgeVerdict", () => {
  const f = jevFile();
  const read = (n: string, set: "finding" | "same-defect") => {
    const r = parseReply(f.sets[set].questions, fixture(n));
    return r.ok ? r.answers : null;
  };

  it("takes finding at p ≥ 0.83 and same-defect at p ≥ 0.85, as 0.x did", () => {
    expect(
      judgeVerdict(
        f.sets.finding.rule,
        "finding",
        ["design", "code", "unclear"],
        read("finding-design.json", "finding"),
      ),
    ).toEqual({
      value: "design",
      probability: 1,
      confidence: 1,
      source: "jev",
    });
    expect(
      judgeVerdict(
        f.sets.finding.rule,
        "finding",
        ["design", "code", "unclear"],
        read("finding-unsure.json", "finding"),
      ),
    ).toMatchObject({
      value: "code",
      source: "default",
    });
    expect(
      judgeVerdict(
        f.sets["same-defect"].rule,
        "same-defect",
        ["yes", "no"],
        read("same-defect-yes.json", "same-defect"),
      ).value,
    ).toBe("yes");
  });

  it("falls back without answers", () => {
    expect(judgeVerdict(f.sets["same-defect"].rule, "same-defect", ["yes", "no"], null)).toEqual({
      value: "no",
      probability: null,
      confidence: null,
      source: "default",
    });
  });
});
````

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/domain/jev.test.ts`
Expected: FAIL — `Cannot find module '../../src/domain/jev.ts'` (and `catalog/jev.json` missing).

- [ ] **Step 3: Write the question sets**

`catalog/jev.json` (kind, finding and same-defect keep 0.x's wording; difficulty and the nouls are research 2026-09-25-jev.md §3.3's):

```json
{
  "schema": 1,
  "model": "jev-1.13.0",
  "sets": {
    "route-v2": {
      "questions": {
        "kind": {
          "type": "choice",
          "instructions": "What kind of work does the lane in the state describe?",
          "criteria": {
            "repo_code": "Code and tests inside an application or library repository",
            "terminal": "Shell, build, CI, infrastructure or environment work, where the terminal is the main tool",
            "ui": "User-interface work judged on screen: layout, styling, components",
            "prose": "Writing that is not code: docs, a changelog, release notes, a merge request body",
            "research": "Finding facts to answer a question, with no change to the product",
            "other": "None of the above"
          }
        },
        "difficulty": {
          "type": "score",
          "instructions": "Which situation matches the work the lane in the state asks for?",
          "criteria": [
            "A mechanical change: rename, move, delete or copy existing code, or change constants, with no new behaviour",
            "New code that follows an existing example which the lane names or the repository already has",
            "New logic with state, concurrency, data invariants or tricky edge cases",
            "A cause nobody has found yet, a design across systems to settle, or no example to follow"
          ]
        },
        "names_pattern": {
          "type": "noul",
          "instructions": "Does the lane in the state name an existing file, function, endpoint or test in the repository that the new work should copy or follow?",
          "criteria": {
            "true": "It names a concrete existing example by path or name",
            "false": "It names no existing example, or only says to follow conventions in general"
          }
        },
        "mechanical": {
          "type": "noul",
          "instructions": "Is the work in the lane in the state only mechanical: renaming, moving, deleting or copying code, or changing constants, with no new behaviour?"
        },
        "shared_state": {
          "type": "noul",
          "instructions": "Does the work in the lane in the state involve concurrency, caching, shared mutable state, transactions, or the ordering of events?"
        },
        "unclear_cause": {
          "type": "noul",
          "instructions": "Does the lane in the state ask the worker to find the cause of a bug or failure that the lane does not already explain?"
        },
        "open_design": {
          "type": "noul",
          "instructions": "Does the lane in the state leave an interface, data shape or algorithm for the worker to decide?"
        },
        "cross_boundary": {
          "type": "noul",
          "instructions": "Must the work in the lane in the state keep two or more services, processes or data stores consistent, such as a schema migration together with the code that reads it?"
        },
        "outside_repo": {
          "type": "noul",
          "instructions": "Does the work in the lane in the state depend on something outside the repository: a running service, credentials, network access, hardware or CI configuration?"
        }
      },
      "rule": { "kindMin": 0.8, "trackMin": 0.8, "trackA": ["0", "1"], "trackB": ["2", "3"] }
    },
    "finding": {
      "questions": {
        "finding": {
          "type": "choice",
          "instructions": "A reviewer reported `finding` on the work planned in `lane`. Where is the defect?",
          "criteria": {
            "design": "The plan itself is wrong: its decisions, signatures or data shapes cannot meet the goal",
            "code": "The plan is sound and the code does not implement it correctly",
            "unclear": "The finding does not say enough to tell"
          }
        }
      },
      "rule": { "min": 0.83, "fallback": "code" }
    },
    "same-defect": {
      "questions": {
        "same-defect": {
          "type": "choice",
          "instructions": "Does `after` report the same underlying defect as `before`, even if worded differently or at another line?",
          "criteria": { "yes": "Same underlying defect", "no": "A different defect" }
        }
      },
      "rule": { "min": 0.85, "fallback": "no" }
    }
  }
}
```

- [ ] **Step 4: Implement**

`src/domain/jev.ts`:

```ts
import { z } from "zod";
import { type Difficulty, KINDS, type Kind, parseLaneHeader } from "./lane.ts";

// Spec §5.5 and research 2026-09-25-jev.md: Jev's three question types, catherd's question sets as
// versioned data (catalog/jev.json), the trimmed lane state, and the decision rules.

const ChoiceQ = z.object({
  type: z.literal("choice"),
  instructions: z.string(),
  criteria: z.record(z.string(), z.string()),
});
const ScoreQ = z.object({
  type: z.literal("score"),
  instructions: z.string(),
  criteria: z.array(z.string()).min(2).max(10),
});
const NoulQ = z.object({
  type: z.literal("noul"),
  instructions: z.string(),
  criteria: z.object({ true: z.string(), false: z.string() }).optional(),
});
const QuestionSchema = z.discriminatedUnion("type", [ChoiceQ, ScoreQ, NoulQ]);
export type JevQuestion = z.infer<typeof QuestionSchema>;

const RouteRuleSchema = z.object({
  kindMin: z.number().min(0).max(1),
  trackMin: z.number().gt(0.5).max(1),
  trackA: z.array(z.string()),
  trackB: z.array(z.string()),
});
export type RouteRule = z.infer<typeof RouteRuleSchema>;
const VerdictRuleSchema = z.object({ min: z.number().min(0).max(1), fallback: z.string() });
export type VerdictRule = z.infer<typeof VerdictRuleSchema>;

export const JevFileSchema = z.looseObject({
  schema: z.literal(1),
  model: z.string(),
  sets: z.object({
    "route-v2": z.object({ questions: z.record(z.string(), QuestionSchema), rule: RouteRuleSchema }),
    finding: z.object({ questions: z.record(z.string(), QuestionSchema), rule: VerdictRuleSchema }),
    "same-defect": z.object({ questions: z.record(z.string(), QuestionSchema), rule: VerdictRuleSchema }),
  }),
});
export type JevFile = z.infer<typeof JevFileSchema>;
export type SetName = keyof JevFile["sets"];

/** JSON with object keys sorted at every depth, so equal data always hashes the same. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

export const sha256 = (s: string): string => new Bun.CryptoHasher("sha256").update(s).digest("hex");

/** `<set>#<8 hex>` over the model, questions and rule: any change to one names a new question set. */
export function questionSetId(f: JevFile, name: SetName): string {
  const set = f.sets[name];
  return `${name}#${sha256(canonicalJson({ model: f.model, questions: set.questions, rule: set.rule })).slice(0, 8)}`;
}

/** The per-run cache key of one request. */
export const requestKey = (model: string, state: unknown, questions: unknown): string =>
  sha256(canonicalJson({ model, state, questions }));

const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g,
  /\b([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password)[A-Za-z0-9_]*)\s*[:=]\s*["']?[^\s"']{6,}/gi,
];

/** Known secret shapes replaced by [secret]; a `key = value` pair keeps its key. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const re of SECRETS)
    out = out.replace(re, (m, key?: string) => (typeof key === "string" ? `${key}=[secret]` : "[secret]"));
  return out;
}

/** Research §5.3: code is not what Jev judges, and long state rots its answers. */
export const BODY_MAX = 6000;
const HEADER = /^\s*[*_]*(owns|fast check|kind|difficulty)[*_]*\s*:/i;

export interface LaneState {
  title: string | null;
  owns: string[];
  fast_check: string | null;
  body: string;
}

/**
 * Spec §5.5: `{ title, owns, fast_check, body }`. The body drops the header lines (so Jev never echoes
 * the architect's own Kind/Difficulty), fenced code, and secrets, and is capped at BODY_MAX characters.
 */
export function laneState(text: string): LaneState {
  const h = parseLaneHeader(text);
  const body = text
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "[code omitted]")
    .split("\n")
    .filter((l) => !/^#\s/.test(l) && !HEADER.test(l))
    .join("\n")
    .trim();
  const scrubbed = scrubSecrets(body);
  return {
    title: h.title === null ? null : scrubSecrets(h.title),
    owns: h.owns,
    fast_check: h.fastCheck === null ? null : scrubSecrets(h.fastCheck),
    body: scrubbed.length > BODY_MAX ? `${scrubbed.slice(0, BODY_MAX)}…` : scrubbed,
  };
}

const Prob = z.record(z.string(), z.number().min(0).max(1));
const AnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("choice"), choice: z.string(), probabilities: Prob, confidence: z.number() }),
  z.object({
    type: z.literal("score"),
    score: z.number(),
    probabilities: Prob,
    confidence: z.number(),
  }),
  z.object({ type: z.literal("noul"), noul: z.number().min(0).max(1) }),
]);
export type JevAnswer = z.infer<typeof AnswerSchema>;
export type JevAnswers = Record<string, JevAnswer>;

const ReplySchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
});

export type ParsedReply =
  | {
      ok: true;
      model: string;
      usage: { input_tokens: number; output_tokens: number } | null;
      answers: JevAnswers;
    }
  | { ok: false; error: string };

/** Every question answered, each in its own type and within its options, or an error naming the first. */
export function parseReply(questions: Record<string, JevQuestion>, body: unknown): ParsedReply {
  const r = ReplySchema.safeParse(body);
  if (!r.success) return { ok: false, error: "unexpected response" };
  const answers: JevAnswers = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = AnswerSchema.safeParse(r.data.answers[id]);
    if (!a.success || a.data.type !== q.type) return { ok: false, error: `no valid answer to ${id}` };
    if (a.data.type === "choice" && q.type === "choice" && !Object.hasOwn(q.criteria, a.data.choice))
      return { ok: false, error: `no valid answer to ${id}` };
    answers[id] = a.data;
  }
  return { ok: true, model: r.data.model, usage: r.data.usage ?? null, answers };
}

const pOf = (a: JevAnswer | undefined, option: string): number =>
  a && a.type !== "noul" ? (a.probabilities[option] ?? 0) : 0;

export interface RouteJudgement {
  /** the kind, when p_max ≥ kindMin and it is one of catherd's kinds */
  kind: Kind | null;
  pKind: number | null;
  /** "A" (copy/build) or "B" (logic/hard) on summed probabilities, null in the dead band */
  track: "A" | "B" | null;
  difficulty: Difficulty | null;
  pA: number | null;
  pB: number | null;
  /** the atomic questions, logged for calibration only */
  nouls: Record<string, number>;
  rule: string;
}

/**
 * Spec §5.5's decision rule. Confidence is `(n·p_max − 1)/(n − 1)`, so it means different things for
 * different option counts; the rule reads probabilities instead: the kind at p_max ≥ kindMin, the track
 * when the summed probability of its levels reaches trackMin, and neither in between (the dead band).
 */
export function judgeRoute(rule: RouteRule, answers: JevAnswers): RouteJudgement {
  const k = answers.kind;
  const d = answers.difficulty;
  const nouls: Record<string, number> = {};
  for (const [id, a] of Object.entries(answers)) if (a.type === "noul") nouls[id] = a.noul;
  let kind: Kind | null = null;
  let pKind: number | null = null;
  if (k && k.type === "choice") {
    const [top, p] = Object.entries(k.probabilities).reduce((m, e) => (e[1] > m[1] ? e : m), ["", -1]);
    pKind = p;
    if (p >= rule.kindMin && (KINDS as readonly string[]).includes(top)) kind = top as Kind;
  }
  if (!d || d.type !== "score")
    return { kind, pKind, track: null, difficulty: null, pA: null, pB: null, nouls, rule: "no difficulty" };
  const sum = (levels: string[]) => levels.reduce((s, l) => s + pOf(d, l), 0);
  const pA = sum(rule.trackA);
  const pB = sum(rule.trackB);
  const round = (x: number) => Math.round(x * 1000) / 1000;
  if (pA >= rule.trackMin)
    return {
      kind,
      pKind,
      track: "A",
      difficulty: pOf(d, rule.trackA[0] ?? "") > pOf(d, rule.trackA[1] ?? "") ? "copy" : "build",
      pA: round(pA),
      pB: round(pB),
      nouls,
      rule: `P(A) ${round(pA)} ≥ ${rule.trackMin}`,
    };
  if (pB >= rule.trackMin)
    return {
      kind,
      pKind,
      track: "B",
      difficulty: pOf(d, rule.trackB[1] ?? "") > pOf(d, rule.trackB[0] ?? "") ? "hard" : "logic",
      pA: round(pA),
      pB: round(pB),
      nouls,
      rule: `P(B) ${round(pB)} ≥ ${rule.trackMin}`,
    };
  return {
    kind,
    pKind,
    track: null,
    difficulty: null,
    pA: round(pA),
    pB: round(pB),
    nouls,
    rule: `P(A) ${round(pA)}, P(B) ${round(pB)}: both below ${rule.trackMin}`,
  };
}

export interface Verdict<T extends string> {
  value: T;
  /** the chosen answer's probability, when Jev answered */
  probability: number | null;
  /** Jev's own confidence statistic, when it answered */
  confidence: number | null;
  source: "jev" | "default";
}

/** Spec §5.5: `finding` and `same-defect` keep their 0.x meaning, with thresholds on probability. */
export function judgeVerdict<T extends string>(
  rule: VerdictRule,
  id: string,
  options: readonly T[],
  answers: JevAnswers | null,
): Verdict<T> {
  const a = answers?.[id];
  const fallback = rule.fallback as T;
  if (!a || a.type !== "choice" || !(options as readonly string[]).includes(a.choice))
    return { value: fallback, probability: null, confidence: null, source: "default" };
  const p = a.probabilities[a.choice] ?? 0;
  const sure = p >= rule.min;
  return {
    value: sure ? (a.choice as T) : fallback,
    probability: p,
    confidence: a.confidence,
    source: sure ? "jev" : "default",
  };
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `bun run format && bun test test/domain/jev.test.ts && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add catalog/jev.json src/domain/jev.ts test/domain/jev.test.ts test/fixtures/jev/route-v2-track-a.json test/fixtures/jev/route-v2-track-b.json test/fixtures/jev/route-v2-unsure.json test/fixtures/jev/rate-limited.json test/fixtures/jev/validation-error.json
git commit -m "feat(domain): Jev route-v2 as versioned data, the trimmed lane state and the track-sum rule"
```

---

### Task 5: Jev's transport

The thin client of spec §5.5: 10 s per attempt, two retries on 408/429/5xx/network/timeout with doubling, jittered backoff, `Retry-After` honoured up to 10 s, and a 25 s deadline it never sleeps past; the request id is returned for the log.

**Files:**
- Create: `src/infra/jev-client.ts`
- Modify: `test/fake-fetch.ts` (replace whole: reply headers and a hanging reply)
- Test: `test/infra/jev-client.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `JEV_BASE = "https://api.typesafe.ai/v1"`; `interface JevTransport { fetchImpl?; now?; sleep?; random?; attemptMs?; deadlineMs?; retries? }`; `type JevResponse = { ok: true; body; requestId; latencyMs; attempts } | { ok: false; error; status; latencyMs; attempts }`; `retryAfterMs(h: Headers, now: number): number | null`; `jevRequest(method: "GET" | "POST", path, key, body, o?: JevTransport): Promise<JevResponse>`. Test helper `fakeFetch(...replies)` where a reply is `{ status, body, headers? } | Error | "hang"`.

- [ ] **Step 1: Write the failing test**

Replace `test/fake-fetch.ts`:

```ts
export interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

/** A scripted reply; "hang" never answers until the request is aborted. */
export type Reply = { status: number; body: unknown; headers?: Record<string, string> } | Error | "hang";

/** A fetch that answers from a script: replies are served in order and the last one repeats. */
export function fakeFetch(...replies: Reply[]): { impl: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    sent.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    const r = replies.length > 1 ? replies.shift() : replies[0];
    if (!r) throw new Error("fakeFetch: no reply scripted");
    if (r instanceof Error) throw r;
    if (r === "hang")
      return new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      );
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json", ...r.headers },
    });
  };
  return { impl: impl as typeof fetch, sent };
}
```

`test/infra/jev-client.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { JEV_BASE, jevRequest, retryAfterMs } from "../../src/infra/jev-client.ts";
import { fakeFetch } from "../fake-fetch.ts";

/** A fake clock: sleeping advances it, so retries never wait for real. */
function clock() {
  let t = 1_000_000;
  const waits: number[] = [];
  return {
    waits,
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
    random: () => 0.5,
  };
}

const ok = {
  status: 200,
  body: { model: "jev-1.13.0", answers: {} },
  headers: { "x-typesafe-request-id": "req_1" },
};

describe("jevRequest", () => {
  it("posts with the bearer key and returns the body with the request id", async () => {
    const f = fakeFetch(ok);
    const r = await jevRequest("POST", "/systemone", "k", { a: 1 }, { fetchImpl: f.impl, ...clock() });
    expect(r).toMatchObject({ ok: true, requestId: "req_1", attempts: 1 });
    expect(f.sent[0]?.url).toBe(`${JEV_BASE}/systemone`);
    expect(f.sent[0]?.headers.get("authorization")).toBe("Bearer k");
    expect(f.sent[0]?.body).toEqual({ a: 1 });
  });

  it("retries 408, 429 and 5xx twice with doubling backoff, counting retries in a header", async () => {
    const c = clock();
    const f = fakeFetch({ status: 529, body: {} }, { status: 408, body: {} }, ok);
    const r = await jevRequest("POST", "/systemone", "k", {}, { fetchImpl: f.impl, ...c });
    expect(r.ok && r.attempts).toBe(3);
    expect(c.waits).toEqual([500, 1000]);
    expect(f.sent[2]?.headers.get("x-typesafe-retry-count")).toBe("2");
  });

  it("honours Retry-After up to 10 s", async () => {
    const c = clock();
    const f = fakeFetch({ status: 429, body: {}, headers: { "retry-after": "3" } }, ok);
    expect((await jevRequest("POST", "/systemone", "k", {}, { fetchImpl: f.impl, ...c })).ok).toBe(true);
    expect(c.waits).toEqual([3000]);
    expect(retryAfterMs(new Headers({ "retry-after": "120" }), 0)).toBe(10_000);
    expect(retryAfterMs(new Headers({ "retry-after-ms": "250" }), 0)).toBe(250);
    expect(retryAfterMs(new Headers({ "retry-after": new Date(5_000).toUTCString() }), 3_000)).toBe(2_000);
    expect(retryAfterMs(new Headers(), 0)).toBeNull();
  });

  it("never retries 400, 401, 403, 404 or 422, and names a validation error", async () => {
    for (const status of [400, 401, 403, 404]) {
      const f = fakeFetch({ status, body: {} });
      expect(
        await jevRequest("POST", "/systemone", "k", {}, { fetchImpl: f.impl, ...clock() }),
      ).toMatchObject({
        ok: false,
        error: `http ${status}`,
        attempts: 1,
      });
    }
    const v = fakeFetch({
      status: 422,
      body: { detail: { error_type: "validation_error", message: "bad" } },
    });
    const r = await jevRequest("POST", "/systemone", "k", {}, { fetchImpl: v.impl, ...clock() });
    expect(!r.ok && r.error).toStartWith("http 422: ");
  });

  it("gives up after two retries, and stops early rather than sleep past the deadline", async () => {
    const f = fakeFetch(new TypeError("fetch failed"));
    expect(await jevRequest("POST", "/systemone", "k", {}, { fetchImpl: f.impl, ...clock() })).toMatchObject({
      ok: false,
      error: "network error",
      attempts: 3,
    });
    const slow = fakeFetch({ status: 503, body: {}, headers: { "retry-after": "8" } });
    const c = clock();
    const r = await jevRequest(
      "POST",
      "/systemone",
      "k",
      {},
      { fetchImpl: slow.impl, ...c, deadlineMs: 12_000 },
    );
    expect(r).toMatchObject({ ok: false, error: "deadline (http 503)", attempts: 2 });
    expect(c.waits).toEqual([8000]);
  });

  it("times out a hung attempt and retries it", async () => {
    const f = fakeFetch("hang", ok);
    const r = await jevRequest(
      "POST",
      "/systemone",
      "k",
      {},
      { fetchImpl: f.impl, ...clock(), attemptMs: 20 },
    );
    expect(r).toMatchObject({ ok: true, attempts: 2 });
  });

  it("reports a 200 that is not JSON", async () => {
    const f = fakeFetch({ status: 200, body: "x" });
    const bad = { impl: (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch };
    expect((await jevRequest("GET", "/models", "k", undefined, { fetchImpl: bad.impl, ...clock() })).ok).toBe(
      false,
    );
    expect((await jevRequest("GET", "/models", "k", undefined, { fetchImpl: f.impl, ...clock() })).ok).toBe(
      true,
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/infra/jev-client.test.ts`
Expected: FAIL — `Cannot find module '../../src/infra/jev-client.ts'`.

- [ ] **Step 3: Implement**

`src/infra/jev-client.ts`:

```ts
// Spec §5.5 transport: a thin client (the official SDK is 0.x and Node-targeted) with the SDK's retry
// semantics (research 2026-09-25-jev.md §4, §5.6).

export const JEV_BASE = "https://api.typesafe.ai/v1";

export interface JevTransport {
  fetchImpl?: typeof fetch;
  /** the clock and the wait between attempts; tests replace both */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** per attempt (10 s) */
  attemptMs?: number;
  /** for the whole call, retries included (25 s) */
  deadlineMs?: number;
  retries?: number;
}

export type JevResponse =
  | { ok: true; body: unknown; requestId: string | null; latencyMs: number; attempts: number }
  | { ok: false; error: string; status: number | null; latencyMs: number; attempts: number };

const RETRY_AFTER_MAX_MS = 10_000;
const retryable = (status: number) => status === 408 || status === 429 || status >= 500;

/** `Retry-After` (seconds or an HTTP date) or `retry-after-ms`, capped at 10 s; null when absent. */
export function retryAfterMs(h: Headers, now: number): number | null {
  const ms = Number(h.get("retry-after-ms"));
  if (h.get("retry-after-ms") !== null && Number.isFinite(ms))
    return Math.min(Math.max(ms, 0), RETRY_AFTER_MAX_MS);
  const v = h.get("retry-after");
  if (v === null) return null;
  const secs = Number(v);
  const wait = Number.isFinite(secs) ? secs * 1000 : Date.parse(v) - now;
  return Number.isFinite(wait) ? Math.min(Math.max(wait, 0), RETRY_AFTER_MAX_MS) : null;
}

/** 500 ms doubling per retry, ±25 % jitter. */
const backoffMs = (retry: number, random: () => number) => 500 * 2 ** (retry - 1) * (0.75 + random() * 0.5);

/**
 * `method path` against the Jev API with a bearer key: 10 s per attempt, up to two retries on 408, 429,
 * 5xx, a network error or a timeout, honouring Retry-After, and never past the 25 s deadline.
 */
export async function jevRequest(
  method: "GET" | "POST",
  path: string,
  key: string,
  body: unknown,
  o: JevTransport = {},
): Promise<JevResponse> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const random = o.random ?? Math.random;
  const fetchImpl = o.fetchImpl ?? globalThis.fetch;
  const start = now();
  const deadline = start + (o.deadlineMs ?? 25_000);
  const retries = o.retries ?? 2;
  let last: { error: string; status: number | null } = { error: "network error", status: null };
  let attempt = 0;
  for (;;) {
    attempt++;
    const left = deadline - now();
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.min(o.attemptMs ?? 10_000, Math.max(left, 0)));
    });
    let wait: number | null = null;
    try {
      const res = await Promise.race([
        fetchImpl(`${JEV_BASE}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            ...(attempt > 1 ? { "x-typesafe-retry-count": String(attempt - 1) } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: ctl.signal,
        }),
        timeout,
      ]);
      if (res === "timeout") {
        ctl.abort();
        last = { error: "timeout", status: null };
      } else if (res.ok) {
        const text = await res.text();
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          return {
            ok: false,
            error: "unexpected response",
            status: res.status,
            latencyMs: now() - start,
            attempts: attempt,
          };
        }
        return {
          ok: true,
          body: parsed,
          requestId: res.headers.get("x-typesafe-request-id"),
          latencyMs: now() - start,
          attempts: attempt,
        };
      } else {
        const detail = await res.text().catch(() => "");
        last = {
          error: `http ${res.status}${/validation/i.test(detail) ? `: ${detail.slice(0, 200)}` : ""}`,
          status: res.status,
        };
        if (!retryable(res.status))
          return { ok: false, ...last, latencyMs: now() - start, attempts: attempt };
        wait = retryAfterMs(res.headers, now());
      }
    } catch {
      last = { error: "network error", status: null };
    } finally {
      clearTimeout(timer);
    }
    if (attempt > retries) break;
    const pause = wait ?? backoffMs(attempt, random);
    if (now() + pause >= deadline) {
      last = { error: `deadline (${last.error})`, status: last.status };
      break;
    }
    await sleep(pause);
  }
  return { ok: false, ...last, latencyMs: now() - start, attempts: attempt };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run format && bun test test/infra/jev-client.test.ts test/jev.test.ts && bun run typecheck && bun run lint`
Expected: PASS (the 0.x `test/jev.test.ts` still passes on the extended `fakeFetch`; Task 11 deletes it).

- [ ] **Step 5: Commit**

```bash
git add src/infra/jev-client.ts test/fake-fetch.ts test/infra/jev-client.test.ts
git commit -m "feat(infra): the Jev client: per-attempt timeout, retries with Retry-After, a 25 s deadline"
```

---

### Task 6: Claude's model list from the Models API

Spec §5.2: Claude's discovery is the shipped list, refreshed from `GET /v1/models` when an Anthropic API key is present (Ruling 11).

**Files:**
- Create: `src/adapters/claude-code/models-api.ts`
- Modify: `src/adapters/claude-code/index.ts`, `test/adapters/claude-code.test.ts`
- Test: `test/adapters/claude-models-api.test.ts`

**Interfaces:**
- Consumes: plan 3's `CLAUDE_MODELS`, `CLAUDE_EFFORTS`, `CLAUDE_ALIASES` (`src/adapters/claude-code/models.ts`), `DiscoveredModel`.
- Produces: `ANTHROPIC_MODELS_URL`; `listClaudeModels(o?: { key?: string | null; fetchImpl?; timeoutMs? }): Promise<DiscoveredModel[]>`; `claudeCodeAdapter.listModels` now calls it.

- [ ] **Step 1: Write the failing test**

`test/adapters/claude-models-api.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { ANTHROPIC_MODELS_URL, listClaudeModels } from "../../src/adapters/claude-code/models-api.ts";
import { fakeFetch } from "../fake-fetch.ts";

const effort = (levels: string[]) =>
  Object.fromEntries([["supported", levels.length > 0], ...levels.map((l) => [l, { supported: true }])]);
const api = (id: string, levels: string[], ctx: number) => ({
  id,
  type: "model",
  display_name: id,
  created_at: "2026-09-22T00:00:00Z",
  max_input_tokens: ctx,
  max_tokens: 128000,
  capabilities: { image_input: { supported: true }, effort: effort(levels) },
});

describe("listClaudeModels", () => {
  it("keeps the shipped list without an API key", async () => {
    const f = fakeFetch({ status: 500, body: {} });
    const ms = await listClaudeModels({ key: null, fetchImpl: f.impl });
    expect(ms.map((m) => m.id)).toEqual([
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ]);
    expect(f.sent).toHaveLength(0);
  });

  it("refreshes from the Models API page by page, keeping shipped models it does not list", async () => {
    const f = fakeFetch(
      {
        status: 200,
        body: {
          data: [
            api("claude-opus-5-5", ["low", "medium", "high", "xhigh", "max"], 1_000_000),
            api("claude-haiku-4-5", [], 200_000),
          ],
          has_more: true,
          last_id: "claude-haiku-4-5",
        },
      },
      {
        status: 200,
        body: {
          data: [
            api("claude-haiku-4-5-20251001", [], 200_000),
            api("claude-opus-6", ["low", "max"], 2_000_000),
          ],
          has_more: false,
        },
      },
    );
    const ms = await listClaudeModels({ key: "sk-ant", fetchImpl: f.impl });
    expect(ms.map((m) => m.id)).toEqual([
      "claude-opus-5-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-6",
      "claude-fable-5-1",
      "claude-sonnet-5",
    ]);
    expect(ms.find((m) => m.id === "claude-opus-6")).toEqual({
      id: "claude-opus-6",
      efforts: ["low", "max"],
      context: 2_000_000,
      imageIn: true,
    });
    expect(ms.find((m) => m.id === "claude-haiku-4-5-20251001")?.efforts).toEqual([]);
    expect(f.sent[0]?.url).toBe(`${ANTHROPIC_MODELS_URL}?limit=1000`);
    expect(f.sent[1]?.url).toBe(`${ANTHROPIC_MODELS_URL}?limit=1000&after_id=claude-haiku-4-5`);
    expect(f.sent[0]?.headers.get("x-api-key")).toBe("sk-ant");
    expect(f.sent[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("keeps the shipped list when the API refuses the key or cannot be reached", async () => {
    for (const reply of [{ status: 401, body: {} }, new TypeError("fetch failed")]) {
      const ms = await listClaudeModels({ key: "bad", fetchImpl: fakeFetch(reply).impl });
      expect(ms).toHaveLength(4);
    }
  });
});
```

In `test/adapters/claude-code.test.ts`, keep the shipped-list test off the network: replace

```ts
  it("lists the shipped models with their efforts", async () => {
    const ms = await claudeCodeAdapter.listModels();
```

with

```ts
  it("lists the shipped models with their efforts", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const ms = await claudeCodeAdapter.listModels();
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/adapters/claude-models-api.test.ts`
Expected: FAIL — `Cannot find module '../../src/adapters/claude-code/models-api.ts'`.

- [ ] **Step 3: Implement**

`src/adapters/claude-code/models-api.ts`:

```ts
import type { DiscoveredModel } from "../backend.ts";
import { CLAUDE_ALIASES, CLAUDE_EFFORTS, CLAUDE_MODELS } from "./models.ts";

export const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";

interface ApiModel {
  id?: unknown;
  max_input_tokens?: unknown;
  capabilities?: {
    image_input?: { supported?: unknown };
    effort?: Record<string, { supported?: unknown } | unknown>;
  };
}

const supported = (v: unknown) => (v as { supported?: unknown } | undefined)?.supported === true;

function fromApi(m: ApiModel): DiscoveredModel | null {
  if (typeof m.id !== "string" || !m.id.startsWith("claude-") || m.id in CLAUDE_ALIASES) return null;
  const known = CLAUDE_MODELS.find((k) => k.id === m.id);
  const effort = m.capabilities?.effort;
  return {
    id: m.id,
    // a model without effort support lists no effort, so its only rung is #default (Haiku 4.5)
    efforts: effort ? CLAUDE_EFFORTS.filter((e) => supported(effort[e])) : [...(known?.efforts ?? [])],
    context: typeof m.max_input_tokens === "number" ? m.max_input_tokens : (known?.context ?? null),
    imageIn: m.capabilities?.image_input ? supported(m.capabilities.image_input) : (known?.imageIn ?? false),
  };
}

/**
 * Spec §5.2: Claude's models are the shipped list, refreshed from the Models API when an Anthropic API
 * key is present. The API's entries win; shipped models it does not list stay (a Claude plan login may
 * reach models an API key does not). Any failure keeps the shipped list.
 */
export async function listClaudeModels(
  o: { key?: string | null; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<DiscoveredModel[]> {
  const shipped = CLAUDE_MODELS.map((m) => ({ ...m, efforts: [...m.efforts] }));
  const key = o.key === undefined ? process.env.ANTHROPIC_API_KEY?.trim() || null : o.key;
  if (!key) return shipped;
  const fetchImpl = o.fetchImpl ?? globalThis.fetch;
  const listed: DiscoveredModel[] = [];
  let after: string | null = null;
  try {
    for (let page = 0; page < 20; page++) {
      const url = `${ANTHROPIC_MODELS_URL}?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`;
      const res = await fetchImpl(url, {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
      });
      if (!res.ok) return shipped;
      const body = (await res.json()) as { data?: ApiModel[]; has_more?: unknown; last_id?: unknown };
      for (const m of body.data ?? []) {
        const d = fromApi(m);
        if (d) listed.push(d);
      }
      if (body.has_more !== true || typeof body.last_id !== "string") break;
      after = body.last_id;
    }
  } catch {
    return shipped;
  }
  if (listed.length === 0) return shipped;
  return [...listed, ...shipped.filter((s) => !listed.some((l) => l.id === s.id))];
}
```

In `src/adapters/claude-code/index.ts`, add after `import { CLAUDE_ALIASES, CLAUDE_EFFORTS, CLAUDE_MODELS } from "./models.ts";`:

```ts
import { listClaudeModels } from "./models-api.ts";
```

and replace

```ts
  listModels: async () => CLAUDE_MODELS.map((m) => ({ ...m, efforts: [...m.efforts] })),
```

with

```ts
  listModels: () => listClaudeModels(),
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run format && bun test test/adapters/claude-models-api.test.ts test/adapters/claude-code.test.ts test/adapters/claude-code.contract.test.ts && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/claude-code/models-api.ts src/adapters/claude-code/index.ts test/adapters/claude-models-api.test.ts test/adapters/claude-code.test.ts
git commit -m "feat(adapters): refresh Claude's model list from the Models API when a key is present"
```

---

### Task 7: The catalog service

Loads the three layers with the user's override and own timings, refreshes discovery now (`init`, `doctor`, `catalog refresh`) or at most daily (`route`), saves treat-likes, and answers `catalog_query`, listing discovered models it cannot score as disabled.

**Files:**
- Create: `src/services/catalog-service.ts`
- Test: `test/services/catalog-service.test.ts`

**Interfaces:**
- Consumes: Task 1 (`buildCatalog`, the schemas, `rungInfo`, `scoresOf`, `capableFor`, `DIMS`, `assetPath`), Task 2 (`costOf`, `DEFAULT_BILLING`, `BillingMode`); plan 3's `ADAPTER_IDS`, `DiscoveredModel`, `adapterFor`, `readDiscovery`, `writeDiscovery`, `discovered`; plan 2's `listRuns`, `readRecords`, `readRoutes`, `currentRoute`, `withFileLock`, `readVersioned`, `writeJsonAtomic`, `configDir`, `CatalogFilter`.
- Produces: `MIN_SAMPLES = 5`; `shippedModels()`, `shippedScores()`; `overridePath()`, `readOverride(): Override`; `listedModels()`; `measuredSecs(base: Catalog)`; `loadCatalog(o?: { timings?: boolean }): Catalog`; `interface Refreshed { backend; models; fetchedAt: string | null; error? }`; `refreshDiscovery(o?: { backends?; now? }): Promise<Refreshed[]>`; `freshenDiscovery(rungs: string[], now?): Promise<void>`; `resetFreshen()`; `saveTreatLike(rung, like): Promise<{ rung; like }>` (either rung form; canonical out); `interface CatalogModel { id; name; backend; model; billing; efforts; context; capabilities; roles; listed; notes; rungs: { rung; enabled; why?; scores; treatLike; cost }[] }`; `catalogQuery(f: CatalogFilter, billing?): { total; models: CatalogModel[] }`.

- [ ] **Step 1: Write the failing test**

`test/services/catalog-service.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BackendAdapter } from "../../src/adapters/backend.ts";
import { readDiscovery, writeDiscovery } from "../../src/adapters/discovery.ts";
import { adapterFor, registerAdapter } from "../../src/adapters/registry.ts";
import { isCatherdError } from "../../src/domain/errors.ts";
import {
  catalogQuery,
  freshenDiscovery,
  loadCatalog,
  measuredSecs,
  overridePath,
  refreshDiscovery,
  resetFreshen,
  saveTreatLike,
} from "../../src/services/catalog-service.ts";
import { appendRecord, appendRoute } from "../../src/services/run-store.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { freshRun, makeRecord } from "./helpers.ts";

afterEach(snapshotEnv());

const codex = adapterFor("codex") as BackendAdapter;
let listCalls = 0;
function fakeCodexListing(models: { id: string; efforts: string[] }[]): void {
  listCalls = 0;
  registerAdapter({
    ...codex,
    listModels: async () => {
      listCalls++;
      return models.map((m) => ({ ...m, context: 272000, imageIn: true }));
    },
  });
}
beforeEach(() => resetFreshen());
afterEach(() => registerAdapter(codex));

const T0 = Date.parse("2026-09-25T10:00:00.000Z");
const q = (o: Partial<Parameters<typeof catalogQuery>[0]> = {}) =>
  catalogQuery({ scoredOnly: false, limit: 500, ...o });

describe("loadCatalog", () => {
  it("merges the shipped layers, each backend's listing and the user's override", async () => {
    withHome();
    writeDiscovery(
      "opencode",
      [{ id: "opencode-go/kimi-k3", efforts: [], context: 262144, imageIn: false }],
      T0,
    );
    await saveTreatLike("opencode:opencode-go/kimi-k3#default", "codex:gpt-6-sol#medium");
    const c = loadCatalog();
    expect(c.listed.opencode?.models.map((m) => m.id)).toEqual(["opencode-go/kimi-k3"]);
    expect(c.treatLike["opencode-go/kimi-k3#default"]).toEqual({ like: "gpt-6-sol#medium", source: "user" });
    expect(JSON.parse(readFileSync(overridePath(), "utf8"))).toMatchObject({
      schema: 1,
      treatLike: { "opencode-go/kimi-k3#default": "gpt-6-sol#medium" },
    });
  });

  it("keeps a 0.x override's other fields when saving a treat-like", async () => {
    withHome();
    await saveTreatLike("a/b#high", "gpt-6-sol#high");
    const cur = JSON.parse(readFileSync(overridePath(), "utf8"));
    writeFileSync(overridePath(), JSON.stringify({ ...cur, entries: { "x#high": { costRank: 9 } } }));
    await saveTreatLike("c/d#high", "gpt-6-sol#xhigh");
    expect(JSON.parse(readFileSync(overridePath(), "utf8")).entries).toEqual({ "x#high": { costRank: 9 } });
  });

  it("refuses a treat-like onto an unscored rung or onto itself", async () => {
    withHome();
    const code = (p: Promise<unknown>) =>
      p.then(
        () => "ok",
        (e) => (isCatherdError(e) ? e.code : String(e)),
      );
    expect(await code(saveTreatLike("a/b#high", "opencode-go/kimi-k3#default"))).toBe("E_CONFIG_INVALID");
    expect(await code(saveTreatLike("gpt-6-sol#high", "gpt-6-sol#high"))).toBe("E_CONFIG_INVALID");
    expect(await code(saveTreatLike("claude-opus-5-5#high", "claude-opus-5-5#xhigh"))).toBe("ok");
  });

  it("turns a corrupt override into E_CONFIG_INVALID with a fix", () => {
    withHome();
    mkdirSync(dirname(overridePath()), { recursive: true });
    writeFileSync(overridePath(), "{nope");
    try {
      loadCatalog();
      throw new Error("expected a throw");
    } catch (e) {
      expect(isCatherdError(e) && e.code).toBe("E_CONFIG_INVALID");
    }
  });
});

describe("measuredSecs", () => {
  it("takes the median of at least five successful runs per canonical rung and kind", async () => {
    const { run } = freshRun();
    appendRoute(run, {
      at: "2026-09-25T10:00:00.000Z",
      lane: "M1.L1",
      role: "worker",
      rung: "codex:gpt-6-sol#high",
      ladder: ["codex:gpt-6-sol#high"],
      source: "route",
      decidedBy: "lane",
      from: null,
      reason: null,
      kind: "terminal",
      difficulty: "logic",
    });
    const secs = [100, 300, 200, 500, 400];
    for (const [i, s] of secs.entries())
      await appendRecord(run, makeRecord({ dispatchId: `D${i}`, rung: "codex:gpt-6-sol#high", secs: s }));
    for (const [i, s] of [10, 20, 30, 40].entries())
      await appendRecord(run, makeRecord({ dispatchId: `E${i}`, rung: "codex:gpt-6-luna#high", secs: s }));
    await appendRecord(
      run,
      makeRecord({ dispatchId: "F", rung: "codex:gpt-6-sol#high", secs: 9999, status: "failed" }),
    );
    const m = measuredSecs(loadCatalog({ timings: false }));
    expect(m).toEqual({ "gpt-6-sol#high|*": 300, "gpt-6-sol#high|terminal": 300 });
    expect(loadCatalog().secs).toEqual(m);
  });
});

describe("discovery refresh", () => {
  it("refreshes every adapter now, keeping the last listing when one lists nothing", async () => {
    withHome();
    fakeCodexListing([{ id: "gpt-6-sol", efforts: ["low"] }]);
    const r = await refreshDiscovery({ backends: ["codex"], now: T0 });
    expect(r).toEqual([{ backend: "codex", models: 1, fetchedAt: "2026-09-25T10:00:00.000Z" }]);
    fakeCodexListing([]);
    const again = await refreshDiscovery({ backends: ["codex"], now: T0 + 1000 });
    expect(again[0]).toMatchObject({ models: 0, fetchedAt: "2026-09-25T10:00:00.000Z" });
    expect(readDiscovery("codex")?.models).toHaveLength(1);
  });

  it("lists again on route at most daily, and not again within the hour after a failure", async () => {
    withHome();
    fakeCodexListing([{ id: "gpt-6-sol", efforts: ["low", "medium"] }]);
    await freshenDiscovery(["codex:gpt-6-sol#medium", "claude:claude-opus-5-5#high"], T0);
    expect(listCalls).toBe(1);
    await freshenDiscovery(["codex:gpt-6-sol#medium"], T0 + 2 * 3_600_000);
    expect(listCalls).toBe(1);
    await freshenDiscovery(["codex:gpt-6-sol#medium"], T0 + 25 * 3_600_000);
    expect(listCalls).toBe(2);
    fakeCodexListing([]);
    resetFreshen();
    const late = T0 + 50 * 3_600_000;
    await freshenDiscovery(["codex:gpt-6-sol#medium"], late);
    await freshenDiscovery(["codex:gpt-6-sol#medium"], late + 60_000);
    expect(listCalls).toBe(1);
  });
});

describe("catalogQuery", () => {
  it("lists each family on each backend with its rungs, scores, cost and roles", () => {
    withHome();
    const sol = q({ backend: "codex", text: "gpt-6-sol" }).models[0];
    expect(sol).toMatchObject({
      id: "gpt-6-sol",
      backend: "codex",
      model: "gpt-6-sol",
      billing: "codex",
      listed: null,
    });
    const high = sol?.rungs.find((r) => r.rung === "codex:gpt-6-sol#high");
    expect(high).toMatchObject({
      enabled: true,
      scores: { repo_code: { value: 65.3, benchmark: "DeepSWE 1.1", confidence: "secondary" } },
      cost: { tier: 0, mode: "chatgpt-plan" },
    });
    expect(sol?.rungs.find((r) => r.rung === "codex:gpt-6-sol#ultra")?.enabled).toBe(false);
    expect(sol?.roles).toContain("artist");
    expect(q({ backend: "claude", text: "opus" }).models[0]?.rungs[2]).toMatchObject({
      rung: "claude:claude-opus-5-5#high",
      treatLike: { like: "claude-opus-5-5#xhigh", source: "shipped" },
    });
    expect(q({ backend: "opencode-go" }).models.map((m) => m.model)).toEqual([
      "opencode-go/gpt-5.6-luna",
      "opencode-go/gpt-6-luna",
    ]);
  });

  it("lists a discovered model catherd cannot score, disabled until the user maps it", async () => {
    withHome();
    writeDiscovery(
      "opencode",
      [{ id: "opencode-go/kimi-k3", efforts: [], context: 262144, imageIn: false }],
      T0,
    );
    const kimi = q({ text: "kimi" }).models[0];
    expect(kimi).toMatchObject({
      id: "opencode-go/kimi-k3",
      name: null,
      billing: "opencode-go",
      listed: true,
    });
    expect(kimi?.rungs).toEqual([
      expect.objectContaining({ rung: "opencode:opencode-go/kimi-k3#default", enabled: false }),
    ]);
    expect(q({ scoredOnly: true, text: "kimi" }).total).toBe(0);
    await saveTreatLike("opencode:opencode-go/kimi-k3#default", "gpt-6-sol#medium");
    expect(q({ scoredOnly: true, text: "kimi" }).models[0]?.rungs[0]).toMatchObject({
      enabled: true,
      scores: { repo_code: { value: 56.6, confidence: "inferred" } },
    });
  });

  it("filters by role and limits the list", () => {
    withHome();
    expect(q({ role: "artist" }).models.every((m) => m.backend === "codex")).toBe(true);
    expect(q({ limit: 2 }).models).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/services/catalog-service.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/catalog-service.ts'`.

- [ ] **Step 3: Implement**

`src/services/catalog-service.ts`:

```ts
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ADAPTER_IDS, type DiscoveredModel } from "../adapters/backend.ts";
import { discovered, readDiscovery, writeDiscovery } from "../adapters/discovery.ts";
import { adapterFor } from "../adapters/registry.ts";
import "../adapters/all.ts";
import {
  buildCatalog,
  type Catalog,
  capableFor,
  DIMS,
  type Family,
  type ModelsFile,
  ModelsFileSchema,
  type Override,
  OverrideSchema,
  rungInfo,
  type ScoresFile,
  ScoresFileSchema,
  scoresOf,
} from "../domain/catalog.ts";
import { costOf, DEFAULT_BILLING, type BillingMode } from "../domain/cost.ts";
import { CatherdError } from "../domain/errors.ts";
import { parseRung } from "../domain/ids.ts";
import type { Kind } from "../domain/lane.ts";
import { currentRoute } from "../domain/route.ts";
import { ROLES, type Role } from "../domain/roles.ts";
import { assetPath } from "../infra/assets.ts";
import { withFileLock } from "../infra/filelock.ts";
import { configDir } from "../infra/paths.ts";
import { readVersioned, writeJsonAtomic } from "../infra/store.ts";
import type { CatalogFilter } from "./ports.ts";
import { listRuns, readRecords, readRoutes } from "./run-store.ts";

const DAY_MS = 24 * 3_600_000;
/** Spec §5.2: `secs_per_task` counts once a rung has this many of the user's own runs. */
export const MIN_SAMPLES = 5;

let models: ModelsFile | null = null;
let scores: ScoresFile | null = null;
export const shippedModels = (): ModelsFile =>
  (models ??= readVersioned(assetPath("catalog/models.json"), ModelsFileSchema, 1));
export const shippedScores = (): ScoresFile =>
  (scores ??= readVersioned(assetPath("catalog/scores.json"), ScoresFileSchema, 1));

export const overridePath = (): string => join(configDir(), "catalog.override.json");

export function readOverride(): Override {
  const file = overridePath();
  return existsSync(file) ? readVersioned(file, OverrideSchema, 1) : OverrideSchema.parse({});
}

/** Every backend's last listing (spec §3.5 `<data>/discovery/<backend>.json`). */
export function listedModels(): Catalog["listed"] {
  const out: Catalog["listed"] = {};
  for (const id of ADAPTER_IDS) {
    const d = readDiscovery(id);
    if (d) out[id] = { fetchedAt: d.fetchedAt, models: d.models };
  }
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/**
 * Spec §5.2: the median seconds of the user's own successful runs per canonical rung and lane kind
 * (`|*` over every kind), kept only with at least MIN_SAMPLES runs.
 */
export function measuredSecs(base: Catalog): Catalog["secs"] {
  const groups = new Map<string, number[]>();
  const add = (k: string, secs: number) => groups.set(k, [...(groups.get(k) ?? []), secs]);
  for (const run of listRuns().runs) {
    const routes = readRoutes(run);
    for (const r of readRecords(run).records) {
      if (r.status !== "ok") continue;
      let canonical: string;
      try {
        canonical = rungInfo(base, r.rung).canonical;
      } catch {
        continue;
      }
      const kind: Kind | null = r.lane ? (currentRoute(routes, r.lane)?.kind ?? null) : null;
      add(`${canonical}|*`, r.secs);
      if (kind) add(`${canonical}|${kind}`, r.secs);
    }
  }
  const secs: Catalog["secs"] = {};
  for (const [k, xs] of groups) if (xs.length >= MIN_SAMPLES) secs[k] = median(xs);
  return secs;
}

/** The shipped catalog with every listing, the user's override and, unless `timings: false`, own timings. */
export function loadCatalog(o: { timings?: boolean } = {}): Catalog {
  const base = buildCatalog({
    models: shippedModels(),
    scores: shippedScores(),
    override: readOverride(),
    listed: listedModels(),
  });
  return o.timings === false ? base : { ...base, secs: measuredSecs(base) };
}

export interface Refreshed {
  backend: string;
  models: number;
  fetchedAt: string | null;
  error?: string;
}

/** Spec §5.2: `init`, `doctor` and `catherd catalog refresh` list every backend's models now. */
export async function refreshDiscovery(o: { backends?: string[]; now?: number } = {}): Promise<Refreshed[]> {
  const out: Refreshed[] = [];
  for (const id of o.backends ?? ADAPTER_IDS) {
    const adapter = adapterFor(id);
    if (!adapter) continue;
    let listed: DiscoveredModel[] = [];
    try {
      listed = await adapter.listModels();
    } catch (e) {
      out.push({ backend: id, models: 0, fetchedAt: readDiscovery(id)?.fetchedAt ?? null, error: String(e) });
      continue;
    }
    if (listed.length === 0) {
      out.push({
        backend: id,
        models: 0,
        fetchedAt: readDiscovery(id)?.fetchedAt ?? null,
        error: "listed no models; the previous listing is kept",
      });
      continue;
    }
    const f = writeDiscovery(id, listed, o.now);
    out.push({ backend: id, models: f.models.length, fetchedAt: f.fetchedAt });
  }
  return out;
}

const tried = new Map<string, number>();
/** Forget which backends this process already tried to list (tests). */
export const resetFreshen = (): void => tried.clear();

/**
 * Spec §5.2: `route` lists a backend again at most daily. A backend this process failed to list is not
 * tried again for an hour, so a missing or wedged CLI never slows every route.
 */
export async function freshenDiscovery(rungs: string[], now = Date.now()): Promise<void> {
  const backends = new Set<string>();
  for (const r of rungs) {
    try {
      const b = parseRung(r).backend;
      backends.add(b === "claude" ? "claude-code" : b);
    } catch {}
  }
  for (const b of backends) {
    const adapter = adapterFor(b);
    if (!adapter || now - (tried.get(b) ?? Number.NEGATIVE_INFINITY) < 3_600_000) continue;
    const cached = readDiscovery(b);
    if (cached && now - Date.parse(cached.fetchedAt) < DAY_MS) continue;
    tried.set(b, now);
    try {
      await discovered(b, () => adapter.listModels(), { maxAgeMs: DAY_MS, now });
    } catch {}
  }
}

/** A rung given as `backend:model#effort` or as a canonical `model#effort`, in canonical form. */
function canonicalOf(c: Catalog, rung: string): string {
  if (!rung.includes(":")) return rung;
  return rungInfo(c, rung).canonical;
}

/** Spec §5.2 "treat like": the user maps an unscored rung onto a scored one in catalog.override.json. */
export async function saveTreatLike(rung: string, like: string): Promise<{ rung: string; like: string }> {
  const c = loadCatalog({ timings: false });
  const from = canonicalOf(c, rung);
  const to = canonicalOf(c, like);
  if (!c.scores[to])
    throw new CatherdError("E_CONFIG_INVALID", `${like} has no scores of its own to lend`, {
      fix: "treat it like a scored rung; catalog_query lists them",
    });
  if (from === to)
    throw new CatherdError("E_CONFIG_INVALID", `${rung} cannot be treated like itself`, {
      fix: "name a different, scored rung",
    });
  mkdirSync(dirname(overridePath()), { recursive: true });
  await withFileLock(overridePath(), () => {
    const cur = readOverride();
    writeJsonAtomic(overridePath(), { ...cur, schema: 1, treatLike: { ...cur.treatLike, [from]: to } });
  });
  return { rung: from, like: to };
}

const backendOfKey = (key: string) => (key === "opencode-go" ? "opencode" : key);

function rungRows(
  c: Catalog,
  backend: string,
  model: string,
  efforts: string[],
  billing: Partial<Record<string, BillingMode>>,
) {
  return (efforts.length ? efforts : ["default"]).map((effort) => {
    const rung = `${backend}:${model}#${effort}`;
    const info = rungInfo(c, rung);
    const s = scoresOf(c, info.canonical);
    const scored: Record<string, { value: number; benchmark: string; confidence: string }> = {};
    for (const d of DIMS) {
      const r = s?.records[d];
      if (r)
        scored[d] = {
          value: r.value,
          benchmark: `${r.benchmark} ${r.version}`,
          confidence: s?.via ? "inferred" : r.confidence,
        };
    }
    const like = c.treatLike[info.canonical] ?? null;
    return {
      rung,
      enabled: s !== null,
      ...(s === null ? { why: "unscored: map it with catherd catalog treat-like <rung> <scored rung>" } : {}),
      scores: scored,
      treatLike: s?.via ? like : null,
      cost: costOf(info.family, effort, billing[info.key] ?? DEFAULT_BILLING[info.key]),
    };
  });
}

export interface CatalogModel {
  id: string;
  name: string | null;
  backend: string;
  model: string;
  billing: string;
  efforts: string[];
  context: number | null;
  capabilities: Family["capabilities"] | null;
  roles: Role[];
  listed: boolean | null;
  notes: Record<string, string>;
  rungs: ReturnType<typeof rungRows>;
}

/** Spec §4.8 `catalog_query`: shipped families on each backend, plus listed models catherd cannot score. */
export function catalogQuery(
  f: CatalogFilter,
  billing: Partial<Record<string, BillingMode>> = {},
): { total: number; models: CatalogModel[] } {
  const c = loadCatalog({ timings: false });
  const rows: CatalogModel[] = [];
  const known = new Set<string>();
  const entry = (backend: string, model: string, fam: Family | null): CatalogModel => {
    const probe = rungInfo(c, `${backend}:${model}#default`);
    return {
      id: fam?.id ?? model,
      name: fam?.name ?? null,
      backend,
      model,
      billing: probe.key,
      efforts: probe.efforts,
      context: probe.context,
      capabilities: fam?.capabilities ?? null,
      roles: ROLES.filter((r) => capableFor(c, probe, r)),
      listed: probe.listed,
      notes: fam?.notes ?? {},
      rungs: rungRows(c, backend, model, probe.efforts, billing),
    };
  };
  for (const fam of c.families)
    for (const [key, on] of Object.entries(fam.on)) {
      const backends = key === "claude-code" ? ["claude", "claude-code"] : [backendOfKey(key)];
      for (const b of backends) rows.push(entry(b, on.id, fam));
      known.add(`${backendOfKey(key)}:${on.id}`);
    }
  for (const [backend, l] of Object.entries(c.listed))
    for (const m of l.models) if (!known.has(`${backend}:${m.id}`)) rows.push(entry(backend, m.id, null));
  const needle = f.text?.toLowerCase();
  const kept = rows
    .filter(
      (m) =>
        (!f.role || m.roles.includes(f.role)) &&
        (!f.backend || m.backend === f.backend || m.billing === f.backend) &&
        (!needle || `${m.id} ${m.model} ${m.name ?? ""}`.toLowerCase().includes(needle)) &&
        (!f.scoredOnly || m.rungs.some((r) => r.enabled)),
    )
    .sort(
      (a, b) =>
        Number(b.rungs.some((r) => r.enabled)) - Number(a.rungs.some((r) => r.enabled)) ||
        a.id.localeCompare(b.id) ||
        a.backend.localeCompare(b.backend),
    );
  return { total: kept.length, models: kept.slice(0, f.limit) };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run format && bun test test/services/catalog-service.test.ts && bun run typecheck && bun run lint && bun test test/architecture.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/catalog-service.ts test/services/catalog-service.test.ts
git commit -m "feat(services): the catalog service: layers, override, own timings, discovery refresh, treat-like"
```

---

### Task 8: The Jev service

The key (`TYPESAFE_API_KEY`, else `credentials.json` at mode 600), a key test that spends no inference, one question-set call with the per-run cache (Ruling 7), and `jev.jsonl` with its header row, never holding the state.

**Files:**
- Create: `src/services/jev-service.ts`
- Test: `test/services/jev-service.test.ts`

**Interfaces:**
- Consumes: Task 1 (`assetPath`), Task 4 (`JevFileSchema`, `questionSetId`, `requestKey`, `canonicalJson`, `sha256`, `parseReply`, `SetName`, `JevAnswers`), Task 5 (`jevRequest`, `JevTransport`); `configDir`, `readVersioned`, `writeJsonAtomic`, `appendJsonl`, `ensureJsonlHeader`, `readJsonl`.
- Produces: `jevQuestions(): JevFile`; `credentialsPath()`; `jevKey(): string | null`; `saveJevKey(key): void`; `testJevKey(key, o?): Promise<boolean>`; `interface JevOpts extends JevTransport { key?: string | null }`; `interface JevRow { at; call: SetName; lane; questionSet; key; stateHash; model; requestId; usage; latencyMs; attempts; cached; answers; derived; used; source: "jev" | "lane" | "default"; why }`; `interface Asked { answers: JevAnswers | null; why: string | null; meta }`; `logJev(runDir, row, now?)`; `askJev(runDir, set: SetName, state, o?: JevOpts): Promise<Asked>`.

- [ ] **Step 1: Write the failing test**

`test/services/jev-service.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JEV_BASE } from "../../src/infra/jev-client.ts";
import {
  askJev,
  credentialsPath,
  jevKey,
  logJev,
  saveJevKey,
  testJevKey,
} from "../../src/services/jev-service.ts";
import { fakeFetch } from "../fake-fetch.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

const fx = (n: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "jev", n), "utf8"));
const runDir = () => mkdtempSync(join(tmpdir(), "catherd-jev-"));
const noWait = { sleep: async () => {}, random: () => 0.5 };
const STATE = { title: "M1.L1 — x", owns: ["src/a.ts"], fast_check: "true", body: "Rename total to sum." };

describe("the Jev key", () => {
  it("comes from TYPESAFE_API_KEY, else credentials.json, which is saved at mode 600", () => {
    withHome();
    delete process.env.TYPESAFE_API_KEY;
    expect(jevKey()).toBeNull();
    saveJevKey("  ts-file  ");
    expect(jevKey()).toBe("ts-file");
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(credentialsPath(), "utf8"))).toEqual({
      schema: 1,
      typesafeApiKey: "ts-file",
    });
    process.env.TYPESAFE_API_KEY = "ts-env";
    expect(jevKey()).toBe("ts-env");
  });

  it("reads a 0.x credentials file and keeps its other fields", () => {
    withHome();
    delete process.env.TYPESAFE_API_KEY;
    saveJevKey("a");
    writeFileSync(credentialsPath(), JSON.stringify({ typesafeApiKey: "old", other: 1 }));
    expect(jevKey()).toBe("old");
    saveJevKey("new");
    expect(JSON.parse(readFileSync(credentialsPath(), "utf8"))).toEqual({
      schema: 1,
      typesafeApiKey: "new",
      other: 1,
    });
  });

  it("is tested by listing Jev's models", async () => {
    const f = fakeFetch({ status: 200, body: { data: [] } }, { status: 401, body: fx("auth-error.json") });
    expect(await testJevKey("k", { fetchImpl: f.impl, ...noWait })).toBe(true);
    expect(await testJevKey("k", { fetchImpl: f.impl, ...noWait })).toBe(false);
    expect(f.sent[0]).toMatchObject({ url: `${JEV_BASE}/models`, method: "GET" });
  });
});

describe("askJev", () => {
  it("sends the pinned model, the state and the set's questions, and returns the answers with their metadata", async () => {
    const dir = runDir();
    const f = fakeFetch({
      status: 200,
      body: fx("route-v2-track-a.json"),
      headers: { "x-typesafe-request-id": "req_9" },
    });
    const a = await askJev(dir, "route-v2", STATE, { key: "k", fetchImpl: f.impl, ...noWait });
    expect(f.sent[0]?.body).toMatchObject({ model: "jev-1.13.0", state: STATE });
    const sent = f.sent[0]?.body as { questions: object } | undefined;
    expect(Object.keys(sent?.questions ?? {})).toContain("names_pattern");
    expect(a.why).toBeNull();
    expect(a.answers?.kind?.type).toBe("choice");
    expect(a.meta).toMatchObject({
      questionSet: expect.stringMatching(/^route-v2#[0-9a-f]{8}$/),
      model: "jev-1.13.0",
      requestId: "req_9",
      usage: { input_tokens: 812, output_tokens: 210 },
      attempts: 1,
      cached: false,
    });
  });

  it("answers the same request from this run's log, and asks again for a changed state", async () => {
    const dir = runDir();
    const f = fakeFetch({ status: 200, body: fx("route-v2-track-a.json") });
    const first = await askJev(dir, "route-v2", STATE, { key: "k", fetchImpl: f.impl, ...noWait });
    logJev(dir, {
      ...first.meta,
      call: "route-v2",
      lane: "M1.L1",
      answers: first.answers,
      derived: null,
      used: "x",
      source: "jev",
      why: "ok",
    });
    const again = await askJev(dir, "route-v2", { ...STATE }, { key: "k", fetchImpl: f.impl, ...noWait });
    expect(again.meta.cached).toBe(true);
    expect(again.answers).toEqual(first.answers);
    expect(f.sent).toHaveLength(1);
    await askJev(
      dir,
      "route-v2",
      { ...STATE, body: "Something else." },
      { key: "k", fetchImpl: f.impl, ...noWait },
    );
    expect(f.sent).toHaveLength(2);
  });

  it("gives no answers without a key, on an HTTP error, or on a reply that does not fit the questions", async () => {
    const dir = runDir();
    expect((await askJev(dir, "route-v2", STATE, { key: null })).why).toBe("no key");
    const auth = fakeFetch({ status: 401, body: fx("auth-error.json") });
    expect((await askJev(dir, "route-v2", STATE, { key: "k", fetchImpl: auth.impl, ...noWait })).why).toBe(
      "http 401",
    );
    const old = fakeFetch({ status: 200, body: fx("route-confident.json") });
    expect((await askJev(dir, "route-v2", STATE, { key: "k", fetchImpl: old.impl, ...noWait })).why).toBe(
      "no valid answer to difficulty",
    );
  });

  it("notes answers from a model other than the pinned one", async () => {
    const body = { ...(fx("route-v2-track-a.json") as object), model: "jev-1.14.0" };
    const f = fakeFetch({ status: 200, body });
    const a = await askJev(runDir(), "route-v2", STATE, { key: "k", fetchImpl: f.impl, ...noWait });
    expect(a.answers).not.toBeNull();
    expect(a.why).toBe("answered by jev-1.14.0, not the pinned jev-1.13.0");
  });

  it("writes jev.jsonl with a header row, and never the state", () => {
    const dir = runDir();
    logJev(dir, {
      call: "finding",
      lane: null,
      questionSet: "finding#00000000",
      key: "k",
      stateHash: "h",
      model: null,
      requestId: null,
      usage: null,
      latencyMs: null,
      attempts: 0,
      cached: false,
      answers: null,
      derived: null,
      used: "code",
      source: "default",
      why: "no key",
    });
    const lines = readFileSync(join(dir, "jev.jsonl"), "utf8").trim().split("\n");
    expect(JSON.parse(lines[0] as string)).toEqual({ schema: 1, kind: "jev" });
    expect(lines).toHaveLength(2);
    expect(lines[1]).not.toContain("Rename total");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/services/jev-service.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/jev-service.ts'`.

- [ ] **Step 3: Implement**

`src/services/jev-service.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  canonicalJson,
  type JevAnswers,
  type JevFile,
  JevFileSchema,
  parseReply,
  questionSetId,
  requestKey,
  type SetName,
  sha256,
} from "../domain/jev.ts";
import { assetPath } from "../infra/assets.ts";
import { type JevTransport, jevRequest } from "../infra/jev-client.ts";
import { configDir } from "../infra/paths.ts";
import { appendJsonl, ensureJsonlHeader, readJsonl, readVersioned, writeJsonAtomic } from "../infra/store.ts";

let file: JevFile | null = null;
/** catalog/jev.json: the question sets and their rules (spec §5.5). */
export const jevQuestions = (): JevFile =>
  (file ??= readVersioned(assetPath("catalog/jev.json"), JevFileSchema, 1));

export const credentialsPath = (): string => join(configDir(), "credentials.json");
const CredentialsSchema = z.looseObject({
  schema: z.literal(1).default(1),
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

/** Keeps any other credential, and the file at mode 600 (spec §10.4). */
export function saveJevKey(key: string): void {
  let cur: z.infer<typeof CredentialsSchema> = { schema: 1 };
  try {
    if (existsSync(credentialsPath())) cur = readVersioned(credentialsPath(), CredentialsSchema, 1);
  } catch {}
  writeJsonAtomic(credentialsPath(), { ...cur, schema: 1, typesafeApiKey: key.trim() }, { mode: 0o600 });
}

/** A key works when Jev lists its models: no inference, and no dependence on a question set. */
export async function testJevKey(key: string, o: JevTransport = {}): Promise<boolean> {
  return (await jevRequest("GET", "/models", key, undefined, o)).ok;
}

export interface JevOpts extends JevTransport {
  /** a key to use instead of jevKey(); null means none */
  key?: string | null;
}

/** One jev.jsonl row (spec §5.5): never the state, only its hash. */
export interface JevRow {
  at: string;
  call: SetName;
  lane: string | null;
  questionSet: string;
  key: string;
  stateHash: string;
  model: string | null;
  requestId: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  latencyMs: number | null;
  attempts: number;
  cached: boolean;
  answers: JevAnswers | null;
  derived: Record<string, unknown> | null;
  used: string;
  source: "jev" | "lane" | "default";
  why: string;
}

export interface Asked {
  answers: JevAnswers | null;
  /** why Jev gave no answers ("no key", "http 401", …), or a note on answers from an unpinned model */
  why: string | null;
  meta: Omit<JevRow, "at" | "answers" | "derived" | "used" | "source" | "why" | "call" | "lane">;
}

const jevLog = (runDir: string) => join(runDir, "jev.jsonl");

export function logJev(runDir: string, row: Omit<JevRow, "at">, now = Date.now()): void {
  const f = jevLog(runDir);
  ensureJsonlHeader(f, "jev");
  appendJsonl(f, { at: new Date(now).toISOString(), ...row });
}

/**
 * Asks one question set about `state`. A request this run already had answered (same model, state and
 * questions) is answered from jev.jsonl, so a re-routed lane gets the same decision.
 */
export async function askJev(runDir: string, set: SetName, state: unknown, o: JevOpts = {}): Promise<Asked> {
  const f = jevQuestions();
  const questions = f.sets[set].questions;
  const key = requestKey(f.model, state, questions);
  const meta: Asked["meta"] = {
    questionSet: questionSetId(f, set),
    key,
    stateHash: sha256(canonicalJson(state)),
    model: null,
    requestId: null,
    usage: null,
    latencyMs: null,
    attempts: 0,
    cached: false,
  };
  const hit = readJsonl<Partial<JevRow>>(jevLog(runDir)).rows.find((r) => r.key === key && r.answers);
  if (hit?.answers)
    return { answers: hit.answers, why: null, meta: { ...meta, model: hit.model ?? null, cached: true } };
  const apiKey = o.key === undefined ? jevKey() : o.key;
  if (!apiKey) return { answers: null, why: "no key", meta };
  const res = await jevRequest("POST", "/systemone", apiKey, { model: f.model, state, questions }, o);
  meta.latencyMs = res.latencyMs;
  meta.attempts = res.attempts;
  if (!res.ok) return { answers: null, why: res.error, meta };
  meta.requestId = res.requestId;
  const parsed = parseReply(questions, res.body);
  if (!parsed.ok) return { answers: null, why: parsed.error, meta };
  meta.model = parsed.model;
  meta.usage = parsed.usage;
  const drift = parsed.model === f.model ? null : `answered by ${parsed.model}, not the pinned ${f.model}`;
  return { answers: parsed.answers, why: drift, meta };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `bun run format && bun test test/services/jev-service.test.ts && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/jev-service.ts test/services/jev-service.test.ts
git commit -m "feat(services): the Jev service: key, per-run cache, jev.jsonl with a header and no state"
```

---

### Task 9: The routing service replaces the bridge's routing

`routingService()` implements `RoutingPort` over Tasks 3, 7 and 8 (spec §5.4: Jev → the lane's `Kind:`/`Difficulty:` → the default; the 80 % budget rule; the daily discovery refresh). The ports gain what routing reads from a profile (Ruling 10), `agentFor` moves to the profile port (Ruling 9), `routes.jsonl` keeps the question set and Jev's probabilities, and the bridge keeps only its profile half.

**Files:**
- Create: `src/services/routing-service.ts`
- Modify: `src/services/ports.ts` (replace whole), `src/domain/route.ts`, `src/services/lane-service.ts`, `src/services/admission.ts`, `src/services/dispatch-service.ts`, `src/services/run-service.ts`, `src/services/summary.ts`, `src/bridge/v0.ts` (replace whole), `src/entry/mcp/server.ts`, `test/services/helpers.ts`, `test/bridge/v0.test.ts` (replace whole)
- Test: `test/services/routing-service.test.ts`

**Interfaces:**
- Consumes: Task 3 (`candidates`, `defaultLadder`, `select`, `RoutingProfile`, `Pick`), Task 4 (`laneState`, `scrubSecrets`, `judgeRoute`, `judgeVerdict`, `Verdict`), Task 7 (`loadCatalog`, `freshenDiscovery`, `catalogQuery`, `resetFreshen`), Task 8 (`askJev`, `logJev`, `jevQuestions`, `JevOpts`, `Asked`, `JevRow`); `BUDGET_CHEAP_AT`, `parseLaneHeader`.
- Produces:
  - `ProfileView` gains `objective: "cost" | "speed"`, `roles[r].defaultRung?: string`, `billing: Partial<Record<string, BillingMode>>`, `jev: { use: "auto" | "off" }`; `ProfilePort.agentFor(role, rung): string | null` (removed from `RoutingPort`); `RouteRequest` gains `profile: ProfileView` and `lane: string | null`; `RouteAnswer` gains `questionSet: string | null` and `jev: RouteJev | null`; `Verdict` is Task 4's (with `probability`).
  - `interface RouteJev { pKind; pA; pB; nouls }` and optional `RouteRow.questionSet`, `RouteRow.jev` (`src/domain/route.ts`).
  - `routingService(o?: JevOpts): RoutingPort`; `RouteResult` (lane-service) gains `questionSet` and `jev`.

- [ ] **Step 1: Write the failing test**

`test/services/routing-service.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v0Profiles } from "../../src/bridge/v0.ts";
import { readJsonl } from "../../src/infra/store.ts";
import { resetFreshen } from "../../src/services/catalog-service.ts";
import type { JevRow } from "../../src/services/jev-service.ts";
import type { ProfileView, RouteRequest } from "../../src/services/ports.ts";
import { routingService } from "../../src/services/routing-service.ts";
import { fakeFetch } from "../fake-fetch.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { LADDER, testView } from "./helpers.ts";

afterEach(snapshotEnv());
beforeEach(() => {
  withHome();
  resetFreshen();
  delete process.env.TYPESAFE_API_KEY;
  // no backend CLI answers a listing here: discovery stays empty
  process.env.PATH = "/nonexistent";
});

const fx = (n: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "jev", n), "utf8"));
const TRACK_A = { rung: LADDER[0] as string, ladder: LADDER };
const TRACK_B = { rung: LADDER[1] as string, ladder: LADDER.slice(1) };
const noWait = { sleep: async () => {}, random: () => 0.5 };

const view = (over: Partial<ProfileView> = {}) =>
  testView({
    roles: {
      ...testView().roles,
      worker: {
        enabled: true,
        access: "workspace-write",
        rungs: LADDER,
        defaultRung: "codex:gpt-6-sol#medium",
      },
    },
    ...over,
  });

const lane = (kind: string | null, difficulty: string | null, body = "Add GET /jobs like src/users.ts.") =>
  [
    "# M1.L1 — jobs",
    "Owns: src/jobs.ts",
    "Fast check: bun test",
    ...(kind ? [`Kind: ${kind}`] : []),
    ...(difficulty ? [`Difficulty: ${difficulty}`] : []),
    body,
  ].join("\n");

function req(laneText: string | null, over: Partial<RouteRequest> = {}): RouteRequest {
  return {
    runDir: mkdtempSync(join(tmpdir(), "catherd-route-")),
    repo: "/nowhere",
    profile: view(),
    role: "worker",
    lane: laneText === null ? null : "M1.L1",
    laneText,
    spentFraction: 0,
    ...over,
  };
}

const jevRows = (dir: string) => readJsonl<JevRow>(join(dir, "jev.jsonl")).rows;

describe("route without Jev", () => {
  it("routes by the lane file's Kind and Difficulty, and logs the fallback", async () => {
    const r = req(lane("repo_code", "build"));
    expect(await routingService().route(r)).toEqual({
      ...TRACK_A,
      source: "lane",
      kind: "repo_code",
      difficulty: "build",
      questionSet: null,
      jev: null,
    });
    expect(jevRows(r.runDir)).toEqual([
      expect.objectContaining({
        call: "route-v2",
        lane: "M1.L1",
        source: "lane",
        why: "no key",
        answers: null,
      }),
    ]);
    expect(await routingService().route(req(lane("repo_code", "logic")))).toMatchObject({
      ...TRACK_B,
      source: "lane",
    });
  });

  it("falls back to the default rung without a lane file or a declared kind", async () => {
    expect(await routingService().route(req(null))).toMatchObject({
      ...TRACK_B,
      source: "default",
      questionSet: null,
    });
    expect(await routingService().route(req(lane(null, null)))).toMatchObject({
      ...TRACK_B,
      source: "default",
    });
  });

  it("never asks Jev for a role with one usable rung", async () => {
    const f = fakeFetch({ status: 200, body: fx("route-v2-track-a.json") });
    const r = req(lane("repo_code", "build"), { role: "reviewer" });
    expect(await routingService({ key: "k", fetchImpl: f.impl }).route(r)).toMatchObject({
      rung: "codex:gpt-6-sol#high",
      source: "default",
    });
    expect(f.sent).toHaveLength(0);
  });

  it("does not ask Jev when the profile turns it off", async () => {
    const f = fakeFetch({ status: 200, body: fx("route-v2-track-b.json") });
    const r = req(lane("repo_code", "build"), { profile: view({ jev: { use: "off" } }) });
    expect(await routingService({ key: "k", fetchImpl: f.impl }).route(r)).toMatchObject({ source: "lane" });
    expect(f.sent).toHaveLength(0);
    expect(jevRows(r.runDir)).toEqual([]);
  });
});

describe("route with Jev", () => {
  it("takes a confident track over the lane's declaration, and logs the decision but never the lane", async () => {
    const f = fakeFetch({
      status: 200,
      body: fx("route-v2-track-b.json"),
      headers: { "x-typesafe-request-id": "req_1" },
    });
    const r = req(
      lane("repo_code", "build", "Fix the race in the job queue; key: sk-abcdefghijklmnopqrstuv"),
    );
    const a = await routingService({ key: "k", fetchImpl: f.impl, ...noWait }).route(r);
    expect(a).toMatchObject({ ...TRACK_B, source: "jev", kind: "repo_code", difficulty: "hard" });
    expect(a.questionSet).toMatch(/^route-v2#[0-9a-f]{8}$/);
    expect(a.jev).toMatchObject({ pA: 0.05, pB: 0.95, pKind: 0.96, nouls: { unclear_cause: 0.88 } });
    const sent = JSON.stringify(f.sent[0]?.body);
    expect(sent).toContain("Fix the race");
    expect(sent).not.toContain("sk-abc");
    expect(sent).not.toContain("Difficulty: build");
    const [row] = jevRows(r.runDir);
    expect(row).toMatchObject({
      source: "jev",
      requestId: "req_1",
      model: "jev-1.13.0",
      why: "P(B) 0.95 ≥ 0.8",
    });
    expect(JSON.stringify(row)).not.toContain("Fix the race");
  });

  it("uses the lane's declaration in the dead band", async () => {
    const f = fakeFetch({ status: 200, body: fx("route-v2-unsure.json") });
    const r = req(lane("repo_code", "build"));
    const a = await routingService({ key: "k", fetchImpl: f.impl, ...noWait }).route(r);
    expect(a).toMatchObject({ ...TRACK_A, source: "lane", kind: "repo_code" });
    expect(jevRows(r.runDir)[0]?.why).toBe("P(A) 0.55, P(B) 0.45: both below 0.8");
  });

  it("routes a confident track with no declared kind as repo_code", async () => {
    const f = fakeFetch({ status: 200, body: fx("route-v2-track-a.json") });
    const a = await routingService({ key: "k", fetchImpl: f.impl, ...noWait }).route(req(lane(null, null)));
    expect(a).toMatchObject({ ...TRACK_A, source: "jev", kind: "repo_code", difficulty: "build" });
  });

  it("falls back when Jev fails, and answers a repeated route from the run's log", async () => {
    const down = fakeFetch({ status: 401, body: fx("auth-error.json") });
    const r = req(lane(null, null));
    expect(await routingService({ key: "k", fetchImpl: down.impl, ...noWait }).route(r)).toMatchObject({
      source: "default",
    });
    const f = fakeFetch({ status: 200, body: fx("route-v2-track-a.json") });
    const svc = routingService({ key: "k", fetchImpl: f.impl, ...noWait });
    await svc.route(r);
    expect((await svc.route(r)).source).toBe("jev");
    expect(f.sent).toHaveLength(1);
    expect(jevRows(r.runDir).map((x) => [x.cached, x.why])).toEqual([
      [false, "http 401"],
      [false, "P(A) 0.9 ≥ 0.8"],
      [true, "P(A) 0.9 ≥ 0.8"],
    ]);
  });
});

describe("route when Jev never answers", () => {
  it("falls back to the lane's declaration once the deadline passes, and says why", async () => {
    const f = fakeFetch("hang");
    const r = req(lane("repo_code", "build"));
    const svc = routingService({ key: "k", fetchImpl: f.impl, attemptMs: 20, deadlineMs: 2_000, ...noWait });
    expect(await svc.route(r)).toMatchObject({ ...TRACK_A, source: "lane" });
    expect(f.sent).toHaveLength(3);
    expect(jevRows(r.runDir)[0]?.why).toBe("timeout");
  });
});

describe("route and the profile", () => {
  it("starts at the cheapest bar-clearing rung from 80 % of the budget, whatever the objective", async () => {
    const secs = { objective: "speed" as const };
    const r = routingService();
    expect(
      (await r.route(req(lane("repo_code", "build"), { profile: view(secs), spentFraction: 0.8 }))).rung,
    ).toBe("codex:gpt-6-luna#high");
  });

  it("routes a role's Claude rung on that role's backend", async () => {
    const p = view({
      roles: {
        reviewer: { enabled: true, access: "read-only", rungs: ["claude-code:claude-opus-5-5#high"] },
        architect: { enabled: true, access: "read-only", rungs: ["claude:claude-opus-5-5#high"] },
      },
    });
    const r = routingService();
    expect((await r.route(req(null, { role: "reviewer", profile: p }))).rung).toBe(
      "claude-code:claude-opus-5-5#high",
    );
    expect((await r.route(req(null, { role: "architect", profile: p }))).rung).toBe(
      "claude:claude-opus-5-5#high",
    );
  });

  it("keeps the approved ladder through the default profile the bridge serves", async () => {
    const profile = v0Profiles().forRepo(null);
    const r = routingService();
    expect(await r.route(req(lane("repo_code", "copy"), { profile }))).toMatchObject(TRACK_A);
    expect(await r.route(req(lane("terminal", "build"), { profile }))).toMatchObject(TRACK_B);
    expect(await r.route(req(lane("prose", "hard"), { profile }))).toMatchObject(TRACK_B);
  });

  it("refuses a role with no usable rung with a fix", async () => {
    const p = view({
      roles: {
        artist: { enabled: true, access: "workspace-write", rungs: ["claude-code:claude-opus-5-5#high"] },
      },
    });
    await expect(routingService().route(req(null, { role: "artist", profile: p }))).rejects.toMatchObject({
      code: "E_CONFIG_INVALID",
    });
  });
});

describe("finding and same-defect", () => {
  it("answers at p ≥ 0.83 and 0.85, falls back otherwise, and logs each call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "catherd-ask-"));
    const yes = fakeFetch({ status: 200, body: fx("finding-design.json") });
    const r = routingService({ key: "k", fetchImpl: yes.impl, ...noWait });
    expect(await r.finding(dir, lane("repo_code", "build"), "The API shape cannot work")).toEqual({
      value: "design",
      probability: 1,
      confidence: 1,
      source: "jev",
    });
    const unsure = fakeFetch({ status: 200, body: fx("finding-unsure.json") });
    expect(
      (
        await routingService({ key: "k", fetchImpl: unsure.impl, ...noWait }).finding(
          dir,
          lane(null, null),
          "x",
        )
      ).source,
    ).toBe("default");
    expect(await routingService({ key: null }).sameDefect(dir, "a", "b")).toMatchObject({
      value: "no",
      source: "default",
    });
    expect(jevRows(dir).map((x) => [x.call, x.source])).toEqual([
      ["finding", "jev"],
      ["finding", "default"],
      ["same-defect", "default"],
    ]);
  });
});
```

Replace `test/bridge/v0.test.ts` (the routing tests move to the file above; `agentFor` is now the profile port's):

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toRung0, toRung1, v0Profiles } from "../../src/bridge/v0.ts";
import { isCatherdError } from "../../src/domain/errors.ts";
import { configDir } from "../../src/infra/paths.ts";
import { defaultProfile } from "../../src/profile/profile.ts";
import { loadCatalog } from "../../src/routing/catalog.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

const LUNA_LADDER = [
  "codex:gpt-6-luna#high",
  "codex:gpt-6-sol#medium",
  "codex:gpt-6-sol#high",
  "codex:gpt-6-sol#xhigh",
];
describe("v0 bridge: rungs", () => {
  it("names each rung's backend from the catalog, and back", () => {
    withHome();
    const c = loadCatalog();
    expect(toRung1(c, "gpt-6-sol#high")).toBe("codex:gpt-6-sol#high");
    expect(toRung1(c, "claude-opus-5-5#high")).toBe("claude:claude-opus-5-5#high");
    expect(toRung1(c, "someprovider/some-model#default")).toBe("opencode:someprovider/some-model#default");
    expect(toRung0("opencode:opencode-go/kimi-k3#default")).toBe("opencode-go/kimi-k3#default");
  });

  it("names a Claude model's headless backend when asked, and leaves other backends alone", () => {
    withHome();
    const c = loadCatalog();
    expect(toRung1(c, "claude-opus-5-5#high", "claude-code")).toBe("claude-code:claude-opus-5-5#high");
    expect(toRung1(c, "gpt-6-sol#high", "claude-code")).toBe("codex:gpt-6-sol#high");
  });
});

describe("v0 bridge: native or headless Claude (spec D3)", () => {
  it("keeps architect and verifier native, runs any other role's Claude rungs headless, and dispatches stand-ins", () => {
    withHome();
    const p = v0Profiles();
    const saved = p.set(undefined, {
      roles: { reviewer: { rungs: ["codex:gpt-6-sol#high", "claude-code:claude-opus-5-5#high"] } },
      failover: { "codex:gpt-6-sol#medium": "claude:claude-opus-5-5#high" },
    });
    expect(saved.errors).toEqual([]);
    const v = p.forRepo(null);
    expect(v.roles.architect?.rungs).toEqual(["claude:claude-opus-5-5#high"]);
    expect(v.roles.verifier?.rungs.every((r) => r.startsWith("claude:"))).toBe(true);
    expect(v.roles.reviewer?.rungs).toContain("claude-code:claude-opus-5-5#high");
    expect(v.failover).toEqual({ "codex:gpt-6-sol#medium": "claude-code:claude-opus-5-5#high" });
  });
});

describe("v0 bridge: profiles", () => {
  it("views the default profile with 1.0 rungs, access defaults and timeouts", () => {
    withHome();
    const v = v0Profiles().forRepo(null);
    expect(v.name).toBe("default");
    expect(v.objective).toBe("cost");
    expect(v.jev).toEqual({ use: "auto" });
    expect(v.billing).toEqual({});
    expect(v.roles.worker).toEqual({
      enabled: true,
      access: "workspace-write",
      rungs: LUNA_LADDER,
      defaultRung: "codex:gpt-6-sol#medium",
    });
    expect(v.roles.architect?.rungs).toEqual(["claude:claude-opus-5-5#high"]);
    expect(v.roles.verifier?.access).toBe("full");
    expect(v.timeouts).toEqual({ idleMin: 15, wallMin: 90 });
    expect(v.budget).toEqual({});
  });

  it("saves failover and budget from a 1.0 patch, and refuses a same-backend stand-in", () => {
    withHome();
    const p = v0Profiles();
    const bad = p.set(undefined, { failover: { "codex:gpt-6-sol#medium": "codex:gpt-6-sol#high" } });
    expect(bad.saved).toBe(false);
    expect(bad.errors.join()).toContain("same backend");

    const ok = p.set(undefined, {
      budget: { tokens: 5000 },
      roles: {
        worker: {
          rungs: ["codex:gpt-6-sol#medium", "codex:gpt-6-sol#high"],
          defaultRung: "codex:gpt-6-sol#medium",
        },
      },
    });
    expect(ok.saved).toBe(true);
    const file = JSON.parse(readFileSync(join(configDir(), "profiles", "default.json"), "utf8"));
    expect(file.budget).toEqual({ tokens: 5000 });
    expect(file.roles.worker.models).toEqual({ "gpt-6-sol": ["medium", "high"] });
    expect(p.forRepo(null).roles.worker?.rungs).toEqual(["codex:gpt-6-sol#medium", "codex:gpt-6-sol#high"]);
    expect(p.validate().valid).toBe(true);
  });

  it("reads a failover map written to the profile file in 1.0 form", () => {
    withHome();
    mkdirSync(join(configDir(), "profiles"), { recursive: true });
    writeFileSync(
      join(configDir(), "profiles", "default.json"),
      JSON.stringify({ ...defaultProfile(), failover: { "gpt-6-sol#medium": "gpt-6-sol#high" } }),
    );
    expect(v0Profiles().forRepo(null).failover).toEqual({ "codex:gpt-6-sol#medium": "codex:gpt-6-sol#high" });
  });

  it("turns a missing profile into E_CONFIG_INVALID", () => {
    withHome();
    try {
      v0Profiles().get("nope");
      throw new Error("expected a throw");
    } catch (e) {
      expect(isCatherdError(e) && e.code).toBe("E_CONFIG_INVALID");
    }
  });
});

describe("v0 bridge: agents", () => {
  it("names the native agent of a claude rung only", () => {
    const p = v0Profiles();
    expect(p.agentFor("architect", "claude:claude-opus-5-5#high")).toBe(
      "catherd-architect-claude-opus-5-5-high",
    );
    expect(p.agentFor("worker", "codex:gpt-6-sol#high")).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/services/routing-service.test.ts test/bridge/v0.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/routing-service.ts'`, and `p.agentFor is not a function`.

- [ ] **Step 3: Change the ports and the route row**

Replace `src/services/ports.ts`:

```ts
import type { Budget } from "../domain/budget.ts";
import type { BillingMode } from "../domain/cost.ts";
import type { Verdict } from "../domain/jev.ts";
import type { Difficulty, Kind } from "../domain/lane.ts";
import type { Access } from "../domain/record.ts";
import type { Role } from "../domain/roles.ts";
import type { RouteJev, RouteSource } from "../domain/route.ts";

/** What the run lifecycle reads from a profile. Rungs are `backend:model#effort`; a role's in ladder order. */
export interface ProfileView {
  name: string;
  objective: "cost" | "speed";
  /** `defaultRung`, when set, is where a lane starts without a kind and difficulty (spec §5.4) */
  roles: Partial<Record<Role, { enabled: boolean; access: Access; rungs: string[]; defaultRung?: string }>>;
  /** per billing key (spec §7.1); a missing key bills as DEFAULT_BILLING */
  billing: Partial<Record<string, BillingMode>>;
  jev: { use: "auto" | "off" };
  /** per backend id: run its harness isolated (spec §7.1 `harness`) */
  isolated: Partial<Record<string, boolean>>;
  /** rung → its stand-in on a usage limit (spec §4.5) */
  failover: Record<string, string>;
  budget: Budget;
  timeouts: { idleMin: number; wallMin: number };
  preflight: { confirm: boolean };
  heavy: number | "cpus/2";
  notify: string[];
}

/** `profile_set`'s patch, in 1.0 rungs. */
export interface ProfilePatch {
  objective?: "cost" | "speed";
  roles?: Partial<Record<Role, { enabled?: boolean; rungs?: string[]; defaultRung?: string }>>;
  harness?: Partial<Record<"codex" | "opencode", { isolated: boolean }>>;
  lock?: { heavy: number | "cpus/2" };
  notify?: ("milestone" | "finish" | "blocked")[];
  failover?: Record<string, string>;
  budget?: Budget;
}

export interface ProfilePort {
  /** The profile bound to `repo` (a git toplevel), else the active one; null asks for the active one. */
  forRepo(repo: string | null): ProfileView;
  get(name?: string): { active: string; profiles: string[]; profile: ProfileView };
  validate(name?: string): { valid: boolean; errors: string[] };
  set(
    name: string | undefined,
    patch: ProfilePatch,
  ): { saved: boolean; errors: string[]; diff: unknown[]; newSessionNeededFor: string[] };
  /** The native Claude agent that runs `rung` for `role`; null unless the rung is a `claude:` one. */
  agentFor(role: Role, rung: string): string | null;
}

export interface RouteRequest {
  runDir: string;
  repo: string;
  profile: ProfileView;
  role: Role;
  /** the lane's id, for jev.jsonl; null when routing a role without a lane */
  lane: string | null;
  laneText: string | null;
  spentFraction: number;
}

export interface RouteAnswer {
  rung: string;
  ladder: string[];
  source: RouteSource;
  kind: Kind | null;
  difficulty: Difficulty | null;
  /** the Jev question set asked, and its summed probabilities, for outcomes.jsonl (spec §5.6) */
  questionSet: string | null;
  jev: RouteJev | null;
}

export type { Verdict };

export interface CatalogFilter {
  role?: Role;
  backend?: string;
  text?: string;
  scoredOnly: boolean;
  limit: number;
}

export interface RoutingPort {
  route(req: RouteRequest): Promise<RouteAnswer>;
  finding(runDir: string, laneText: string, finding: string): Promise<Verdict<"design" | "code" | "unclear">>;
  sameDefect(runDir: string, before: string, after: string): Promise<Verdict<"yes" | "no">>;
  catalog(filter: CatalogFilter): { total: number; models: unknown[] };
}

/** Everything a service needs from outside it; the entry layer builds one, tests build fakes. */
export interface Deps {
  profiles: ProfilePort;
  routing: RoutingPort;
  version: string;
  /** how often the supervisor and the dispatch wait poll, in ms */
  pollMs: number;
  /** how often a running dispatch reports progress, in ms (spec §4.4: 30 s) */
  tickMs: number;
  now: () => number;
}
```

In `src/domain/route.ts`, add before `/** One row of routes.jsonl`:

```ts
/** What Jev said about a lane, kept with its route for outcomes.jsonl (spec §5.6). */
export interface RouteJev {
  pKind: number | null;
  pA: number | null;
  pB: number | null;
  nouls: Record<string, number>;
}

```

and in `interface RouteRow`, replace

```ts
  kind: Kind | null;
  difficulty: Difficulty | null;
}
```

with

```ts
  kind: Kind | null;
  difficulty: Difficulty | null;
  /** route rows: the Jev question set asked (null when Jev was not asked) and its probabilities */
  questionSet?: string | null;
  jev?: RouteJev | null;
}
```

- [ ] **Step 4: Write the routing service**

`src/services/routing-service.ts`:

```ts
import { BUDGET_CHEAP_AT } from "../domain/budget.ts";
import {
  type JevAnswers,
  judgeRoute,
  judgeVerdict,
  laneState,
  type SetName,
  scrubSecrets,
} from "../domain/jev.ts";
import { type Difficulty, type Kind, parseLaneHeader } from "../domain/lane.ts";
import type { Role } from "../domain/roles.ts";
import type { RouteJev } from "../domain/route.ts";
import { candidates, defaultLadder, type Pick, type RoutingProfile, select } from "../domain/select.ts";
import { catalogQuery, freshenDiscovery, loadCatalog } from "./catalog-service.ts";
import { type Asked, askJev, type JevOpts, jevQuestions, logJev } from "./jev-service.ts";
import type { ProfileView, RouteAnswer, RouteRequest, RoutingPort, Verdict } from "./ports.ts";

function routingProfile(v: ProfileView, role: Role, spentFraction: number): RoutingProfile {
  const rc = v.roles[role];
  return {
    // spec §4.6: from 80 % of the budget on, start at the cheapest rung that clears the bar
    objective: spentFraction >= BUDGET_CHEAP_AT ? "cost" : v.objective,
    billing: v.billing,
    role: {
      enabled: rc?.enabled ?? false,
      rungs: rc?.rungs ?? [],
      ...(rc?.defaultRung ? { defaultRung: rc.defaultRung } : {}),
    },
  };
}

const answer = (
  pick: Pick,
  source: RouteAnswer["source"],
  kind: Kind | null,
  difficulty: Difficulty | null,
  asked: Asked | null,
  jev: RouteJev | null,
): RouteAnswer => ({
  ...pick,
  source,
  kind,
  difficulty,
  questionSet: asked?.answers ? asked.meta.questionSet : null,
  jev,
});

/**
 * Spec §5.4: kind and difficulty from Jev (§5.5's rule), else the lane file's `Kind:`/`Difficulty:`,
 * else the role's default rung. A role with one usable rung never asks Jev.
 */
async function route(req: RouteRequest, o: JevOpts): Promise<RouteAnswer> {
  const p = routingProfile(req.profile, req.role, req.spentFraction);
  await freshenDiscovery(p.role.rungs);
  const c = loadCatalog();
  const fallback = () => defaultLadder(c, p, req.role);
  if (req.laneText === null || candidates(c, p, req.role).length <= 1)
    return answer(fallback(), "default", null, null, null, null);
  const lane = parseLaneHeader(req.laneText);
  let asked: Asked | null = null;
  let judged: ReturnType<typeof judgeRoute> | null = null;
  if (req.profile.jev.use !== "off") {
    asked = await askJev(req.runDir, "route-v2", laneState(req.laneText), o);
    if (asked.answers) judged = judgeRoute(jevQuestions().sets["route-v2"].rule, asked.answers);
  }
  const jev: RouteJev | null = judged
    ? { pKind: judged.pKind, pA: judged.pA, pB: judged.pB, nouls: judged.nouls }
    : null;
  let out: RouteAnswer;
  if (judged?.track && judged.difficulty) {
    const kind = judged.kind ?? lane.kind ?? "repo_code";
    out = answer(select(c, p, req.role, kind, judged.difficulty), "jev", kind, judged.difficulty, asked, jev);
  } else {
    const kind = judged?.kind ?? lane.kind;
    out =
      kind && lane.difficulty
        ? answer(select(c, p, req.role, kind, lane.difficulty), "lane", kind, lane.difficulty, asked, jev)
        : answer(fallback(), "default", null, null, asked, jev);
  }
  if (asked) {
    logJev(req.runDir, {
      ...asked.meta,
      call: "route-v2",
      lane: req.lane,
      answers: asked.answers,
      derived: judged
        ? { ...jev, kind: judged.kind, track: judged.track, difficulty: judged.difficulty }
        : null,
      used: `${req.role} ${out.rung}`,
      source: out.source,
      why: asked.why ?? (judged ? judged.rule : "no answers"),
    });
  }
  return out;
}

async function verdict<T extends string>(
  runDir: string,
  set: Extract<SetName, "finding" | "same-defect">,
  state: Record<string, unknown>,
  options: readonly T[],
  o: JevOpts,
): Promise<Verdict<T>> {
  const asked = await askJev(runDir, set, state, o);
  const rule = jevQuestions().sets[set].rule;
  const v = judgeVerdict(rule, set, options, asked.answers as JevAnswers | null);
  logJev(runDir, {
    ...asked.meta,
    call: set,
    lane: null,
    answers: asked.answers,
    derived: null,
    used: v.value,
    source: v.source,
    why: asked.why ?? `p ${v.probability} ${v.source === "jev" ? "≥" : "<"} ${rule.min}`,
  });
  return v;
}

/** The routing port over the 1.0 catalog and Jev (spec §5); `o` lets tests inject Jev's transport. */
export function routingService(o: JevOpts = {}): RoutingPort {
  return {
    route: (req) => route(req, o),
    finding: (runDir, laneText, finding) =>
      verdict(
        runDir,
        "finding",
        { lane: laneState(laneText), finding: scrubSecrets(finding) },
        ["design", "code", "unclear"] as const,
        o,
      ),
    sameDefect: (runDir, before, after) =>
      verdict(
        runDir,
        "same-defect",
        { before: scrubSecrets(before), after: scrubSecrets(after) },
        ["yes", "no"] as const,
        o,
      ),
    catalog: (filter) => catalogQuery(filter),
  };
}
```

- [ ] **Step 5: Wire it in**

`src/services/lane-service.ts`: replace the import `import { type ClimbReason, currentRoute, nextRung, type RouteSource } from "../domain/route.ts";` with

```ts
import { type ClimbReason, currentRoute, nextRung, type RouteJev, type RouteSource } from "../domain/route.ts";
```

In `interface RouteResult`, replace

```ts
  /** the native agent to run a `claude:` rung as */
  agent: string | null;
}
```

with

```ts
  /** the native agent to run a `claude:` rung as */
  agent: string | null;
  /** the Jev question set asked, and what it said, when Jev was asked */
  questionSet: string | null;
  jev: RouteJev | null;
}
```

In `route`, replace

```ts
  const a = await deps.routing.route({
    runDir: run.dir,
    repo: run.meta.repo,
    role: i.role,
```

with

```ts
  const a = await deps.routing.route({
    runDir: run.dir,
    repo: run.meta.repo,
    profile,
    role: i.role,
    lane: lane?.lane ?? null,
```

and in its `appendRoute` call replace

```ts
      kind: a.kind,
      difficulty: a.difficulty,
    });
```

with

```ts
      kind: a.kind,
      difficulty: a.difficulty,
      questionSet: a.questionSet,
      jev: a.jev,
    });
```

Then move every `agentFor` call to the profile port:

```bash
sed -i 's/deps\.routing\.agentFor/deps.profiles.agentFor/g' src/services/lane-service.ts src/services/admission.ts src/services/dispatch-service.ts src/services/run-service.ts
```

`src/services/summary.ts`: replace

```ts
    jev: { decisions: jev.length, fallbacks: jev.filter((j) => j.source === "default").length },
```

with

```ts
    // a lane or default source is a decision Jev did not make
    jev: { decisions: jev.length, fallbacks: jev.filter((j) => j.source !== "jev").length },
```

`src/entry/mcp/server.ts`: replace `import { v0Profiles, v0Routing } from "../../bridge/v0.ts";` with `import { v0Profiles } from "../../bridge/v0.ts";`, add `import { routingService } from "../../services/routing-service.ts";` after the `reconcileAll` import, and replace `    routing: v0Routing(),` with `    routing: routingService(),`.

Replace `src/bridge/v0.ts` (the routing half and its 0.x routing imports go; the view gains the new fields; `agentFor` joins the profile port):

```ts
// The 0.x profile code behind the 1.0 profile port, translating `model#effort` rungs to
// `backend:model#effort`. Routing moved to src/services/routing-service.ts (plan 4); plan 5 replaces
// this file. Only the entry layer may import it (test/architecture.test.ts).
import { existsSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import diff from "microdiff";
import { CatherdError, isCatherdError } from "../domain/errors.ts";
import { parseRung } from "../domain/ids.ts";
import { claudeBackendFor, DEFAULT_ACCESS, type Role, ROLES } from "../domain/roles.ts";
import { agentName, claudeAgentsDir, saveProfileAndAgents } from "../profile/agents.ts";
import {
  activeProfileName,
  defaultProfile,
  listProfiles,
  loadProfile,
  patchProfile,
  type ProfilePatch as Patch0,
  validateProfile,
} from "../profile/profile.ts";
import { loadCatalog, modelOf } from "../routing/catalog.ts";
import { candidates } from "../routing/select.ts";
import type { ProfilePatch, ProfilePort, ProfileView } from "../services/ports.ts";
import type { Catalog, Profile } from "../types.ts";

/** 0.x throws plain Errors for a broken profile or catalog; the ports speak CatherdError. */
function asConfigError(e: unknown): CatherdError {
  if (isCatherdError(e)) return e;
  return new CatherdError("E_CONFIG_INVALID", String((e as Error)?.message ?? e).replace(/^catherd: /, ""), {
    fix: "run profile_validate, then fix the profile with profile_set",
  });
}

function v0<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    throw asConfigError(e);
  }
}

const modelPart = (rung0: string) => rung0.slice(0, rung0.lastIndexOf("#"));

/**
 * The 0.x catalog calls every Claude model `claude`; `claude` says which Claude backend to name instead:
 * a role's (spec D3), `claude-code` for a failover stand-in (dispatch runs it), `claude` when roleless.
 */
export function toRung1(c: Catalog, rung0: string, claude: "claude" | "claude-code" = "claude"): string {
  const model = modelPart(rung0);
  const backend = modelOf(c, model)?.backend ?? (model.includes("/") ? "opencode" : "codex");
  return `${backend === "claude" ? claude : backend}:${rung0}`;
}

const forRole = (c: Catalog, role: Role) => (r: string) => toRung1(c, r, claudeBackendFor(role));

export function toRung0(rung1: string): string {
  const r = parseRung(rung1);
  return `${r.model}#${r.effort}`;
}

const mapRungs = (m: Record<string, string>, f: (r: string) => string) =>
  Object.fromEntries(Object.entries(m).map(([a, b]) => [f(a), f(b)]));

function view(p: Profile, c: Catalog): ProfileView {
  const roles: ProfileView["roles"] = {};
  for (const role of ROLES) {
    const d = p.roles[role].defaultRung;
    roles[role] = {
      enabled: p.roles[role].enabled,
      access: DEFAULT_ACCESS[role],
      rungs: candidates(p, c, role).map(forRole(c, role)),
      ...(d ? { defaultRung: forRole(c, role)(d) } : {}),
    };
  }
  return {
    name: p.name,
    objective: p.objective,
    roles,
    // the 0.x profile stores neither: spec §7.1's defaults until plan 5's schema
    billing: {},
    jev: { use: "auto" },
    isolated: { codex: p.harness.codex.isolated, opencode: p.harness.opencode.isolated },
    failover: mapRungs(p.failover ?? {}, (r) => toRung1(c, r, "claude-code")),
    budget: p.budget ?? {},
    timeouts: { idleMin: 15, wallMin: 90 },
    preflight: { confirm: false },
    heavy: p.lock.heavy,
    notify: p.notify,
  };
}

function modelsOf(rungs: string[]): Record<string, string[]> {
  const m: Record<string, string[]> = {};
  for (const r of rungs) {
    const { model, effort } = parseRung(r);
    (m[model] ??= []).push(effort);
  }
  return m;
}

function applyPatch(before: Profile, patch: ProfilePatch): Profile {
  const roles: NonNullable<Patch0["roles"]> = {};
  for (const role of ROLES) {
    const rc = patch.roles?.[role];
    if (!rc) continue;
    roles[role] = {
      ...(rc.enabled === undefined ? {} : { enabled: rc.enabled }),
      ...(rc.rungs === undefined ? {} : { models: modelsOf(rc.rungs) }),
      ...(rc.defaultRung === undefined ? {} : { defaultRung: toRung0(rc.defaultRung) }),
    };
  }
  const patched = patchProfile(before, {
    objective: patch.objective,
    roles,
    harness: patch.harness,
    lock: patch.lock,
    notify: patch.notify,
  });
  return {
    ...patched,
    ...(patch.failover === undefined ? {} : { failover: mapRungs(patch.failover, toRung0) }),
    ...(patch.budget === undefined ? {} : { budget: patch.budget }),
  };
}

export function v0Profiles(): ProfilePort {
  return {
    forRepo: (repo) => v0(() => view(loadProfile(activeProfileName(repo ?? undefined)), loadCatalog())),
    get: (name) =>
      v0(() => {
        const active = activeProfileName();
        return {
          active,
          profiles: listProfiles(),
          profile: view(loadProfile(name ?? active), loadCatalog()),
        };
      }),
    validate: (name) =>
      v0(() => {
        const errors = validateProfile(loadProfile(name ?? activeProfileName()), loadCatalog());
        return { valid: errors.length === 0, errors };
      }),
    set: (name, patch) =>
      v0(() => {
        const c = loadCatalog();
        const n = name ?? activeProfileName();
        const before: Profile = listProfiles().includes(n)
          ? loadProfile(n)
          : { ...defaultProfile(), name: n };
        const after = applyPatch(before, patch);
        const errors = validateProfile(after, c);
        if (errors.length) return { saved: false, errors, diff: [], newSessionNeededFor: [] };
        const dir = claudeAgentsDir();
        const had = new Set(existsSync(dir) ? readdirSync(dir) : []);
        const agents = saveProfileAndAgents(after, c);
        return {
          saved: true,
          errors: [],
          diff: diff(
            before as unknown as Record<string, unknown>,
            after as unknown as Record<string, unknown>,
          ),
          newSessionNeededFor: agents.linked
            .filter((l) => !had.has(basename(l)))
            .map((l) => basename(l, ".md")),
        };
      }),
    agentFor(role, rung) {
      const r = parseRung(rung);
      return r.backend === "claude" ? agentName(role, `${r.model}#${r.effort}`) : null;
    },
  };
}
```

`test/services/helpers.ts`: in `testView`, replace

```ts
  return {
    name: "test",
    roles: {
```

with

```ts
  return {
    name: "test",
    objective: "cost",
    billing: {},
    jev: { use: "auto" },
    roles: {
```

In `fakeDeps`, replace the routing fake's `route`, `agentFor`, `finding` and `sameDefect`:

```ts
    async route(req) {
      const rungs = view.roles[req.role]?.rungs ?? [];
      return { rung: rungs[0] ?? "", ladder: rungs, source: "default", kind: null, difficulty: null };
    },
    agentFor(r, rung) {
      const p = parseRung(rung);
      return p.backend === "claude" ? `catherd-${r}-${p.model}-${p.effort}` : null;
    },
    finding: async () => ({ value: "code", confidence: null, source: "default" }),
    sameDefect: async () => ({ value: "no", confidence: null, source: "default" }),
```

with

```ts
    async route(req) {
      const rungs = view.roles[req.role]?.rungs ?? [];
      return {
        rung: rungs[0] ?? "",
        ladder: rungs,
        source: "default",
        kind: null,
        difficulty: null,
        questionSet: null,
        jev: null,
      };
    },
    finding: async () => ({ value: "code", probability: null, confidence: null, source: "default" }),
    sameDefect: async () => ({ value: "no", probability: null, confidence: null, source: "default" }),
```

and in the profiles fake replace

```ts
    set: () => ({ saved: false, errors: ["profiles are fixed in tests"], diff: [], newSessionNeededFor: [] }),
  };
```

with

```ts
    set: () => ({ saved: false, errors: ["profiles are fixed in tests"], diff: [], newSessionNeededFor: [] }),
    agentFor(r, rung) {
      const p = parseRung(rung);
      return p.backend === "claude" ? `catherd-${r}-${p.model}-${p.effort}` : null;
    },
  };
```

- [ ] **Step 6: Run everything that routes**

Run: `bun run format && bun run typecheck && bun run lint && bun test test/services test/bridge test/entry test/integration test/architecture.test.ts`
Expected: PASS, including `test/integration/mcp-stdio.test.ts` ("route: no Jev key, so the lane file's Kind/Difficulty decide: Track A") now through `routingService`.

- [ ] **Step 7: Commit**

```bash
git add src/services/routing-service.ts src/services/ports.ts src/domain/route.ts src/services/lane-service.ts src/services/admission.ts src/services/dispatch-service.ts src/services/run-service.ts src/services/summary.ts src/bridge/v0.ts src/entry/mcp/server.ts test/services/helpers.ts test/services/routing-service.test.ts test/bridge/v0.test.ts
git commit -m "feat(services): route through the 1.0 catalog and Jev route-v2; the bridge keeps only profiles"
```

---

### Task 10: `outcomes.jsonl` and environment climbs

Spec §5.6: one row per lane when its milestone lands or it fails its top rung, with climbs the environment caused marked and excluded from `start_ok` (Ruling 8). `climb` gains `env`, and the orchestrator skill says when to pass it.

**Files:**
- Modify: `src/domain/route.ts` (replace whole), `src/services/run-store.ts`, `src/services/lane-service.ts`, `src/entry/mcp/lane-tools.ts`, `plugin/skills/catherd/SKILL.md`
- Test: `test/services/outcomes.test.ts`

**Interfaces:**
- Consumes: Task 9's `RouteJev`, `RouteRow.questionSet/jev`, `RouteResult`; `appendRoute`, `readRoutes`, `ensureJsonlHeader`, `appendJsonl`, `readJsonl`.
- Produces: `RouteRow.env?: boolean`; `interface OutcomeRow { at; lane; questionSet; jevProbs; source; startRung; finalRung; climbs: { from; to; reason; env }[]; landed; start_ok; min_ok_index; envCaused }`; `laneOutcome(rows, lane, landed, at): OutcomeRow | null`; `runPaths(dir).outcomes`; `appendOutcome(run, row)`; `readOutcomes(run): OutcomeRow[]`; `climb(deps, { run, lane, reason, evidence?, env? })`; MCP `climb` input `env?: boolean`.

- [ ] **Step 1: Write the failing test**

`test/services/outcomes.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { laneOutcome, type RouteRow } from "../../src/domain/route.ts";
import { climb, land, route } from "../../src/services/lane-service.ts";
import { readOutcomes, readRoutes, runPaths } from "../../src/services/run-store.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, freshRun, LADDER, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());

const JEV = { pKind: 0.99, pA: 0.9, pB: 0.1, nouls: { mechanical: 0.2 } };
const head = (repo: string) =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

/** Deps whose route answers Track A from Jev, with its question set and probabilities. */
function jevDeps() {
  const deps = fakeDeps();
  deps.routing.route = async () => ({
    rung: LADDER[0] as string,
    ladder: LADDER,
    source: "jev",
    kind: "repo_code",
    difficulty: "build",
    questionSet: "route-v2#0123abcd",
    jev: JEV,
  });
  return deps;
}

const landM1 = (deps: ReturnType<typeof fakeDeps>, run: string, commit: string) =>
  land(deps, { run, milestone: "M1", what: "jobs", commit, evidence: "ok", next: "M2" });

describe("outcomes.jsonl (spec §5.6)", () => {
  it("keeps the question set and Jev's probabilities with the lane's route", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    const r = await route(jevDeps(), { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
    expect(r).toMatchObject({ questionSet: "route-v2#0123abcd", jev: JEV });
    expect(readRoutes(run)[0]).toMatchObject({
      decidedBy: "jev",
      questionSet: "route-v2#0123abcd",
      jev: JEV,
    });
  });

  it("writes one row per routed lane of a landed milestone, excluding environment climbs from start_ok", async () => {
    const { repo, run } = freshRun();
    const deps = jevDeps();
    for (const id of ["M1.L1", "M1.L2", "M2.L1"]) {
      writeLane(run, id, [`src/${id}.ts`]);
      await route(deps, { run: run.id, laneFile: `lanes/${id}.md`, role: "worker" });
    }
    await climb(deps, { run: run.id, lane: "M1.L1", reason: "blocked", evidence: "no database", env: true });
    await climb(deps, { run: run.id, lane: "M1.L2", reason: "check-failed-twice" });
    await landM1(deps, run.id, head(repo));
    const rows = readOutcomes(run);
    expect(rows.map((o) => o.lane)).toEqual(["M1.L1", "M1.L2"]);
    expect(rows[0]).toMatchObject({
      questionSet: "route-v2#0123abcd",
      jevProbs: JEV,
      source: "jev",
      startRung: LADDER[0],
      finalRung: LADDER[1],
      climbs: [{ from: LADDER[0], to: LADDER[1], reason: "blocked: no database", env: true }],
      landed: true,
      start_ok: true,
      min_ok_index: 1,
      envCaused: true,
    });
    expect(rows[1]).toMatchObject({ start_ok: false, min_ok_index: 1, envCaused: false });
    const first = readFileSync(runPaths(run.dir).outcomes, "utf8").split("\n")[0] as string;
    expect(JSON.parse(first)).toEqual({ schema: 1, kind: "outcomes" });
  });

  it("writes an open row when a lane climbs past its top rung", async () => {
    const { run } = freshRun();
    const deps = jevDeps();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    await route(deps, { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
    for (let i = 0; i < LADDER.length; i++)
      await climb(deps, { run: run.id, lane: "M1.L1", reason: "blocker" });
    const [o] = readOutcomes(run);
    expect(o).toMatchObject({ landed: false, start_ok: false, min_ok_index: null, finalRung: LADDER.at(-1) });
    expect(o?.climbs).toHaveLength(LADDER.length - 1);
  });

  it("starts from the lane's last route, and ignores lanes never routed", () => {
    const row = (over: Partial<RouteRow>): RouteRow => ({
      at: "t",
      lane: "M1.L1",
      role: "worker",
      rung: "a",
      ladder: ["a", "b"],
      source: "route",
      decidedBy: "lane",
      from: null,
      reason: null,
      kind: "repo_code",
      difficulty: "build",
      ...over,
    });
    const rows = [
      row({}),
      row({ source: "climb", from: "a", rung: "b", reason: "blocker" }),
      row({ rung: "b", ladder: ["b"] }),
    ];
    expect(laneOutcome(rows, "M1.L1", true, "t")).toMatchObject({
      startRung: "b",
      climbs: [],
      start_ok: true,
      min_ok_index: 0,
      questionSet: null,
      jevProbs: null,
    });
    expect(laneOutcome(rows, "M9.L9", true, "t")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test test/services/outcomes.test.ts`
Expected: FAIL — `Export named 'laneOutcome' not found in module '…/src/domain/route.ts'`.

- [ ] **Step 3: Implement**

Replace `src/domain/route.ts`:

```ts
import type { Difficulty, Kind } from "./lane.ts";
import type { Role } from "./roles.ts";

export const CLIMB_REASONS = [
  "check-failed-twice",
  "blocker",
  "same-defect",
  "refused",
  "blocked",
  "unchanged",
] as const;
export type ClimbReason = (typeof CLIMB_REASONS)[number];

/** Spec §5.4: where a lane's kind and difficulty came from. */
export type RouteSource = "jev" | "lane" | "default";

/** What Jev said about a lane, kept with its route for outcomes.jsonl (spec §5.6). */
export interface RouteJev {
  pKind: number | null;
  pA: number | null;
  pB: number | null;
  nouls: Record<string, number>;
}

/** One row of routes.jsonl: a lane's route, or one climb of it. The last row of a lane is its current route. */
export interface RouteRow {
  at: string;
  lane: string;
  role: Role;
  rung: string;
  ladder: string[];
  source: "route" | "climb";
  decidedBy: RouteSource;
  from: string | null;
  reason: string | null;
  kind: Kind | null;
  difficulty: Difficulty | null;
  /** route rows: the Jev question set asked (null when Jev was not asked) and its probabilities */
  questionSet?: string | null;
  jev?: RouteJev | null;
  /** climb rows: the climb was caused by the environment, not the rung's capability (spec §5.6) */
  env?: boolean;
}

export function nextRung(ladder: string[], current: string): string | null {
  const i = ladder.indexOf(current);
  return i >= 0 && i < ladder.length - 1 ? (ladder[i + 1] as string) : null;
}

export const currentRoute = (rows: RouteRow[], lane: string): RouteRow | null =>
  rows.findLast((r) => r.lane === lane) ?? null;

/** One outcomes.jsonl row (spec §5.6): how a routed lane ended, for calibrating Jev's route rule. */
export interface OutcomeRow {
  at: string;
  lane: string;
  questionSet: string | null;
  jevProbs: RouteJev | null;
  source: RouteSource;
  startRung: string;
  finalRung: string;
  climbs: { from: string; to: string; reason: string; env: boolean }[];
  /** true when the lane landed, false when it ended open (a climb past its top rung) */
  landed: boolean;
  /** landed with no climb the rung itself caused */
  start_ok: boolean;
  /** the ladder index it landed on; null when it ended open (censored) */
  min_ok_index: number | null;
  /** some climb was the environment's fault: calibration leaves this lane out */
  envCaused: boolean;
}

/** The lane's outcome from its routes.jsonl rows since its last route; null when it was never routed. */
export function laneOutcome(rows: RouteRow[], lane: string, landed: boolean, at: string): OutcomeRow | null {
  const mine = rows.filter((r) => r.lane === lane);
  const i = mine.findLastIndex((r) => r.source === "route");
  const start = mine[i];
  if (!start) return null;
  const climbs = mine
    .slice(i + 1)
    .filter((r) => r.source === "climb" && r.from !== null && r.from !== r.rung)
    .map((r) => ({ from: r.from as string, to: r.rung, reason: r.reason ?? "", env: r.env === true }));
  const finalRung = mine.at(-1)?.rung ?? start.rung;
  const idx = start.ladder.indexOf(finalRung);
  return {
    at,
    lane,
    questionSet: start.questionSet ?? null,
    jevProbs: start.jev ?? null,
    source: start.decidedBy,
    startRung: start.rung,
    finalRung,
    climbs,
    landed,
    start_ok: landed && climbs.every((c) => c.env),
    min_ok_index: landed && idx >= 0 ? idx : null,
    envCaused: climbs.some((c) => c.env),
  };
}
```

`src/services/run-store.ts`: replace `import type { RouteRow } from "../domain/route.ts";` with `import type { OutcomeRow, RouteRow } from "../domain/route.ts";`; in `runPaths`, add after `    jev: join(dir, "jev.jsonl"),`:

```ts
    outcomes: join(dir, "outcomes.jsonl"),
```

and add before `export const AgentRunSchema`:

```ts
export function appendOutcome(run: Run, row: OutcomeRow): void {
  const file = runPaths(run.dir).outcomes;
  ensureJsonlHeader(file, "outcomes");
  appendJsonl(file, row);
}

export function readOutcomes(run: Run): OutcomeRow[] {
  return readJsonl<OutcomeRow>(runPaths(run.dir).outcomes).rows.filter((r) => typeof r?.lane === "string");
}

```

`src/services/lane-service.ts`: replace the route import with

```ts
import {
  type ClimbReason,
  currentRoute,
  laneOutcome,
  nextRung,
  type RouteJev,
  type RouteSource,
} from "../domain/route.ts";
```

add `appendOutcome,` after `appendLedger,` in the `./run-store.ts` import; replace `  i: { run: string; lane: string; reason: ClimbReason; evidence?: string },` with `  i: { run: string; lane: string; reason: ClimbReason; evidence?: string; env?: boolean },`; inside `climb`'s lock replace

```ts
      reason: i.evidence ? `${i.reason}: ${i.evidence}` : i.reason,
    });
    return { cur, next };
```

with

```ts
      reason: i.evidence ? `${i.reason}: ${i.evidence}` : i.reason,
      env: i.env === true,
    });
    // spec §5.6: a climb past the top rung ends the lane open
    if (!next) {
      const o = laneOutcome(readRoutes(run), i.lane, false, new Date(deps.now()).toISOString());
      if (o) appendOutcome(run, o);
    }
    return { cur, next };
```

and in `land` replace

```ts
  const { hints } = await refreshState(run, landRow);
```

with

```ts
  const { hints } = await refreshState(run, landRow);
  // spec §5.6: every routed lane of the milestone lands with it
  const routes = readRoutes(run);
  for (const lane of new Set(routes.map((r) => r.lane)))
    if (lane.startsWith(`${i.milestone}.`)) {
      const o = laneOutcome(routes, lane, true, now.toISOString());
      if (o) appendOutcome(run, o);
    }
```

`src/entry/mcp/lane-tools.ts`: in the `climb` tool, replace the description with

```ts
        "Move a routed lane one rung up its ladder and record why. Returns the next rung, or top: true, and any hints. Dispatch the lane again at that rung on a fresh thread. Pass env: true when the environment caused it (a missing service, a broken tool, a usage limit), not the rung.",
```

and add `        env: z.boolean().optional(),` after `        evidence: z.string().optional(),`.

- [ ] **Step 4: Update the orchestrator skill**

In `plugin/skills/catherd/SKILL.md`, replace the tool-table row

```
| `climb(run, lane, reason, evidence?)`                                                     | The lane's next rung, with its `backend` and `agent`, or `top: true`                                                                                     |
```

with

```
| `climb(run, lane, reason, evidence?, env?)`                                               | The lane's next rung, with its `backend` and `agent`, or `top: true`. `env: true` when the environment, not the rung, caused it                        |
```

replace the paragraph that starts `**Jev picks the start, when the user has it.**` with

```
**Jev picks the start, when the user has it.** Jev (TypeSafe) is a decision model: it answers a fixed set of questions about the lane with calibrated probabilities, usually in well under a second, for a fraction of a cent; `route` gives up on it after 25 s. It is optional. When its probabilities do not settle the track, or with no Jev key, `route` uses the lane file's `Kind:` and `Difficulty:` lines (`source: "lane"`), else the profile's default (`source: "default"`), so the run never waits on it. Every Jev call is logged to `R/jev.jsonl`, without the lane's text.
```

in the paragraph that starts `**Climb one rung**`, replace

```
**Climb one rung** with `climb(run, lane, reason, evidence)`, then dispatch
```

with

```
**Climb one rung** with `climb(run, lane, reason, evidence)` (add `env: true` when a missing service, a broken tool or a usage limit caused it, not the rung), then dispatch
```

replace the line

```
- `R/routes.jsonl` records each lane's rung and every climb with its reason.
```

with

```
- `R/routes.jsonl` records each lane's rung and every climb with its reason; `R/outcomes.jsonl` gets one row per lane when its milestone lands or it fails its top rung.
```

and replace the line

```
- **`runs.jsonl`, `agents.jsonl`, `jev.jsonl`, `routes.jsonl`, `harness.jsonl`:** the record.
```

with

```
- **`runs.jsonl`, `agents.jsonl`, `jev.jsonl`, `routes.jsonl`, `outcomes.jsonl`, `harness.jsonl`:** the record.
```

- [ ] **Step 5: Run it to verify it passes**

Run: `bun run format && bun test test/services/outcomes.test.ts test/services/lanes-run.test.ts test/entry test/skills.test.ts test/plugin.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/route.ts src/services/run-store.ts src/services/lane-service.ts src/entry/mcp/lane-tools.ts plugin/skills/catherd/SKILL.md test/services/outcomes.test.ts
git commit -m "feat(services): outcomes.jsonl per lane, with environment climbs marked for calibration"
```

---

### Task 11: `catherd catalog`, and the 0.x routing and models.dev snapshot removed

Spec §8's `catherd catalog refresh|list|treat-like <rung> <like>` over the catalog service; then everything that only served 0.x routing goes (Ruling 12): `src/routing/route.ts`, `src/routing/commands.ts`, the models.dev snapshot, its script and tests, and `ofetch`. The 0.x catalog loader stays for the 0.x profile and TUI, without the snapshot and tolerant of 1.0 treat-likes (Review Focus 5); `src/routing/jev.ts` becomes a re-export for the TUI.

**Files:**
- Create: `src/entry/catalog-command.ts`
- Modify: `src/cli.ts`, `src/routing/catalog.ts` (replace whole), `src/routing/jev.ts` (replace whole), `test/catalog.test.ts`, `test/live/jev.live.test.ts` (replace whole), `package.json`, `bun.lock`, `README.md`, `docs/dependencies.md`, `src/tui/watch-model.ts`
- Delete: `src/routing/route.ts`, `src/routing/commands.ts`, `catalog/models-dev.json`, `scripts/snapshot-models-dev.ts`, `test/route.test.ts`, `test/jev.test.ts`, `test/models-dev.test.ts`
- Test: `test/entry/catalog-command.test.ts`

**Interfaces:**
- Consumes: Task 7 (`refreshDiscovery`, `catalogQuery`, `saveTreatLike`, `Refreshed`, `CatalogModel`, `overridePath`), Task 8 (`jevKey`, `saveJevKey`, `testJevKey`, `askJev`, `jevQuestions`), Task 4 (`judgeRoute`, `laneState`).
- Produces: `catalogCommand`, `formatRefreshed(r)`, `formatModel(m)`; exit codes 0 / 1 (`error E_CODE: …` + `fix: …`) / 2 (bad `--role`).

- [ ] **Step 1: Write the failing test**

`test/entry/catalog-command.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { overridePath } from "../../src/services/catalog-service.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
function catherd(...args: string[]) {
  const p = Bun.spawnSync([process.execPath, CLI, "catalog", ...args], {
    // no backend CLI on PATH: refresh lists nothing, and never touches the user's own
    env: { ...process.env, PATH: "/nonexistent", ANTHROPIC_API_KEY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("catherd catalog", () => {
  it("lists models with their scored rungs, as text or JSON", () => {
    withHome();
    const text = catherd("list", "--backend", "codex", "--text", "gpt-6-sol");
    expect(text.code).toBe(0);
    expect(text.out).toContain("codex:gpt-6-sol  5/6 rungs scored  roles ");
    const json = JSON.parse(catherd("list", "--role", "artist", "--json").out);
    expect(json.models.every((m: { backend: string }) => m.backend === "codex")).toBe(true);
  });

  it("refuses an unknown role with exit 2 and the fix", () => {
    withHome();
    const r = catherd("list", "--role", "chef");
    expect([r.code, r.err]).toEqual([
      2,
      `error E_INPUT_INVALID: no role "chef"\nfix: pass --role ${"architect|verifier|worker|reviewer|ui-reviewer|artist|writer|researcher"}\n`,
    ]);
  });

  it("saves a treat-like, and refuses one onto an unscored rung", () => {
    withHome();
    const ok = catherd("treat-like", "opencode:opencode-go/kimi-k3#default", "codex:gpt-6-sol#medium");
    expect([ok.code, ok.out]).toEqual([
      0,
      "✓ opencode-go/kimi-k3#default is treated like gpt-6-sol#medium\n",
    ]);
    expect(JSON.parse(readFileSync(overridePath(), "utf8")).treatLike).toEqual({
      "opencode-go/kimi-k3#default": "gpt-6-sol#medium",
    });
    const bad = catherd("treat-like", "a/b#high", "a/c#high");
    expect(bad.code).toBe(1);
    expect(bad.err).toStartWith("error E_CONFIG_INVALID: a/c#high has no scores of its own to lend\nfix: ");
  });

  it("refreshes every backend, keeping the claude-code list without an API key", () => {
    withHome();
    const r = catherd("refresh", "--json");
    const rows = JSON.parse(r.out) as { backend: string; models: number; error?: string }[];
    expect(rows.find((x) => x.backend === "claude-code")?.models).toBe(4);
    expect(rows.find((x) => x.backend === "codex")?.error).toBe(
      "listed no models; the previous listing is kept",
    );
    expect(r.code).toBe(0);
  });
});
```

In `test/catalog.test.ts` (the 0.x loader), delete the whole test `"adds snapshot models as opencode models with a default effort, and hand-entered ids win"` and the now-unused `import { dataDir } from "../src/paths.ts";`, and replace

```ts
  test("refuses a treat-like that points at an unscored rung", () => {
    writeOverride({ treatLike: { "openrouter/acme/coder-1#default": "gpt-6-luna#max" } });
    expect(() => loadCatalog()).toThrow(/treated like "gpt-6-luna#max", which has no scores/);
  });
```

with

```ts
  test("skips a treat-like onto a rung only the 1.0 catalog scores", () => {
    writeOverride({
      schema: 1,
      treatLike: { "openrouter/acme/coder-1#default": "gpt-6-astra#xhigh" },
      scores: [],
    });
    expect(loadCatalog().treatLike).toEqual({});
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/entry/catalog-command.test.ts test/catalog.test.ts`
Expected: FAIL — the CLI still runs the 0.x `catalog` command (`list` is not a subcommand), and the 0.x loader throws on the Astra treat-like.

- [ ] **Step 3: Write the command**

`src/entry/catalog-command.ts`:

```ts
import { defineCommand } from "citty";
import { isCatherdError } from "../domain/errors.ts";
import { ROLES, type Role } from "../domain/roles.ts";
import {
  type CatalogModel,
  catalogQuery,
  type Refreshed,
  refreshDiscovery,
  saveTreatLike,
} from "../services/catalog-service.ts";

export function formatRefreshed(r: Refreshed): string {
  return r.error
    ? `! ${r.backend}: ${r.error}${r.fetchedAt ? ` (last listed ${r.fetchedAt})` : ""}`
    : `✓ ${r.backend}: ${r.models} models`;
}

export function formatModel(m: CatalogModel): string {
  const scored = m.rungs.filter((r) => r.enabled).length;
  const listed = m.listed === false ? "  not offered by this account" : "";
  return `${m.backend}:${m.model}  ${scored}/${m.rungs.length} rungs scored  roles ${m.roles.join(",") || "none"}${listed}`;
}

function fail(e: unknown): void {
  if (!isCatherdError(e)) throw e;
  console.error(`error ${e.code}: ${e.message}`);
  if (e.fix) console.error(`fix: ${e.fix}`);
  process.exitCode = 1;
}

const refresh = defineCommand({
  meta: { name: "refresh", description: "List every backend's models now" },
  args: { json: { type: "boolean", description: "print JSON" } },
  async run({ args }) {
    const r = await refreshDiscovery();
    if (args.json) console.log(JSON.stringify(r, null, 2));
    else for (const x of r) console.log(formatRefreshed(x));
    process.exitCode = r.some((x) => !x.error) ? 0 : 1;
  },
});

const list = defineCommand({
  meta: { name: "list", description: "The models catherd can place, with their scored rungs" },
  args: {
    backend: { type: "string", description: "only this backend or billing key" },
    role: { type: "string", description: `only models for this role (${ROLES.join(", ")})` },
    text: { type: "string", description: "only ids containing this" },
    scored: { type: "boolean", description: "only models with a scored rung" },
    json: { type: "boolean", description: "print JSON" },
  },
  run({ args }) {
    if (args.role && !(ROLES as readonly string[]).includes(args.role)) {
      console.error(`error E_INPUT_INVALID: no role "${args.role}"`);
      console.error(`fix: pass --role ${ROLES.join("|")}`);
      process.exitCode = 2;
      return;
    }
    try {
      const r = catalogQuery({
        backend: args.backend,
        role: args.role as Role | undefined,
        text: args.text,
        scoredOnly: args.scored === true,
        limit: 10_000,
      });
      if (args.json) console.log(JSON.stringify(r, null, 2));
      else for (const m of r.models) console.log(formatModel(m));
    } catch (e) {
      fail(e);
    }
  },
});

const treatLike = defineCommand({
  meta: { name: "treat-like", description: "Score an unscored rung as a scored one" },
  args: {
    rung: {
      type: "positional",
      required: true,
      description: "the unscored rung, backend:model#effort or model#effort",
    },
    like: { type: "positional", required: true, description: "the scored rung whose scores it borrows" },
  },
  async run({ args }) {
    try {
      const r = await saveTreatLike(args.rung, args.like);
      console.log(`✓ ${r.rung} is treated like ${r.like}`);
    } catch (e) {
      fail(e);
    }
  },
});

/** Spec §8: `catherd catalog refresh|list|treat-like <rung> <like>`. */
export const catalogCommand = defineCommand({
  meta: { name: "catalog", description: "The model catalog" },
  subCommands: { refresh, list, "treat-like": treatLike },
});
```

In `src/cli.ts`, replace

```ts
    catalog: () => import("./routing/commands.ts").then((m) => m.catalogCommand),
```

with

```ts
    catalog: () => import("./entry/catalog-command.ts").then((m) => m.catalogCommand),
```

- [ ] **Step 4: Remove the 0.x routing and the snapshot**

```bash
git rm src/routing/route.ts src/routing/commands.ts catalog/models-dev.json scripts/snapshot-models-dev.ts test/route.test.ts test/jev.test.ts test/models-dev.test.ts
```

Replace `src/routing/catalog.ts` (the snapshot merge, `trimModelsDev`, `refreshModelsDev` and `ofetch` go; a treat-like 0.x cannot score is skipped):

```ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { assetPath, readJsonFile } from "../files.ts";
import { configDir } from "../paths.ts";
import {
  type Capabilities,
  type Catalog,
  type CatalogEntry,
  type CatalogModel,
  DIFFICULTIES,
  KINDS,
  ROLE_NEEDS,
  type Role,
  type RungId,
} from "../types.ts";

const Caps = z.object({
  toolCall: z.boolean(),
  imageIn: z.boolean(),
  imageOut: z.boolean(),
  reasoning: z.boolean(),
  context: z.number(),
});
const Model = z.object({
  id: z.string().min(1),
  backend: z.enum(["codex", "opencode", "claude"]),
  efforts: z.array(z.string().min(1)).min(1),
  capabilities: Caps,
});
const Scores = z.object({
  repo_code: z.number().optional(),
  terminal: z.number().optional(),
  honesty: z.number().optional(),
  secs_per_task: z.number().optional(),
});
const Bar = z.object({
  repo_code: z.number().optional(),
  terminal: z.number().optional(),
  honesty: z.number().optional(),
});
const Rung = z.string().regex(/^.+#[^#]+$/, "expected model#effort");

const CatalogSchema = z.object({
  version: z.string(),
  models: z.array(Model),
  entries: z.array(z.object({ rung: Rung, scores: Scores, costRank: z.number() })),
  bars: z.record(z.enum(KINDS), z.record(z.enum(DIFFICULTIES), Bar)),
  treatLike: z.record(Rung, Rung),
});

const OverrideSchema = z.object({
  models: z
    .record(
      z.string().min(1),
      z
        .object({ backend: Model.shape.backend, efforts: Model.shape.efforts, capabilities: Caps.partial() })
        .partial(),
    )
    .optional(),
  entries: z
    .record(Rung, z.object({ scores: Scores.optional(), costRank: z.number().optional() }))
    .optional(),
  bars: z.partialRecord(z.enum(KINDS), z.partialRecord(z.enum(DIFFICULTIES), Bar)).optional(),
  treatLike: z.record(Rung, Rung).optional(),
});
export type CatalogOverride = z.infer<typeof OverrideSchema>;

export const overridePath = (): string => join(configDir(), "catalog.override.json");

/**
 * 0.x shim: the 0.x profile validation and TUI read catalog/catalog.json until plans 5 and 6. The 1.0
 * catalog is src/services/catalog-service.ts; the models.dev snapshot is gone (spec §5.2).
 */
export function loadCatalog(): Catalog {
  const c: Catalog = readJsonFile(CatalogSchema, assetPath("catalog/catalog.json"));
  return existsSync(overridePath()) ? applyOverride(c, readJsonFile(OverrideSchema, overridePath())) : c;
}

function applyOverride(c: Catalog, o: CatalogOverride): Catalog {
  const file = overridePath();
  for (const [id, m] of Object.entries(o.models ?? {})) {
    const cur = modelOf(c, id);
    if (cur) {
      if (m.backend) cur.backend = m.backend;
      if (m.efforts) cur.efforts = m.efforts;
      cur.capabilities = { ...cur.capabilities, ...m.capabilities };
      continue;
    }
    const full = Model.safeParse({ id, ...m });
    if (!full.success)
      throw new Error(`catherd: ${file}: new model "${id}" needs a backend, efforts and every capability`);
    c.models.push(full.data);
  }
  for (const [rung, e] of Object.entries(o.entries ?? {})) {
    const cur = c.entries.find((x) => x.rung === rung);
    if (cur) {
      cur.scores = { ...cur.scores, ...e.scores };
      cur.costRank = e.costRank ?? cur.costRank;
    } else if (e.costRank === undefined) {
      throw new Error(`catherd: ${file}: new entry "${rung}" needs a costRank`);
    } else {
      c.entries.push({ rung, scores: e.scores ?? {}, costRank: e.costRank });
    }
  }
  for (const kind of KINDS) {
    for (const d of DIFFICULTIES) {
      const bar = o.bars?.[kind]?.[d];
      if (bar) c.bars[kind][d] = bar;
    }
  }
  // `catherd catalog treat-like` may name a rung only the 1.0 catalog scores; 0.x skips it
  for (const [rung, like] of Object.entries(o.treatLike ?? {}))
    if (c.entries.some((e) => e.rung === like)) c.treatLike[rung] = like;
  return c;
}

export function modelOf(c: Catalog, id: string): CatalogModel | undefined {
  return c.models.find((m) => m.id === id);
}

export function capableFor(role: Role, m: CatalogModel): boolean {
  return Object.entries(ROLE_NEEDS[role]).every(([k, need]) => {
    const have = m.capabilities[k as keyof Capabilities];
    return typeof need === "number" ? Number(have) >= need : have === need;
  });
}

export function entryFor(c: Catalog, rung: RungId): CatalogEntry | undefined {
  const own = c.entries.find((e) => e.rung === rung);
  if (own) return own;
  const like = c.treatLike[rung];
  const borrowed = like === undefined ? undefined : c.entries.find((e) => e.rung === like);
  return borrowed && { ...borrowed, rung };
}

export function isScored(c: Catalog, rung: RungId): boolean {
  return entryFor(c, rung) !== undefined;
}

/** Merges one "treat like" into <config>/catalog.override.json, keeping every other field. */
export function saveTreatLike(rung: RungId, like: RungId): void {
  const base = loadCatalog();
  if (!base.entries.some((e) => e.rung === like)) {
    throw new Error(`catherd: ${overridePath()}: "${rung}" is treated like "${like}", which has no scores`);
  }
  const file = overridePath();
  const current: CatalogOverride = existsSync(file) ? readJsonFile(OverrideSchema, file) : {};
  const next: CatalogOverride = { ...current, treatLike: { ...current.treatLike, [rung]: like } };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
}
```

Replace `src/routing/jev.ts`:

```ts
// 0.x shim: the 0.x TUI (init, dashboard) reads and tests the Jev key through here until plan 6 moves it
// onto the 1.0 services. Everything else about Jev lives in src/services/jev-service.ts.
export { jevKey, saveJevKey, testJevKey } from "../services/jev-service.ts";
```

Replace `test/live/jev.live.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeRoute, laneState } from "../../src/domain/jev.ts";
import { askJev, jevQuestions, testJevKey } from "../../src/services/jev-service.ts";

const lane = [
  "# M1.L2 — GET /jobs",
  "Owns: src/routes/jobs.ts, test/jobs.test.ts",
  "Fast check: bun test test/jobs.test.ts",
  "Add a GET /jobs endpoint to the Express API that lists jobs from the existing JobsRepository,",
  "following the pattern of GET /workers in src/routes/workers.ts.",
].join("\n");

describe.skipIf(!process.env.CATHERD_LIVE || !process.env.TYPESAFE_API_KEY)("live jev", () => {
  test("route-v2 puts a plain build lane on Track A as repo_code", async () => {
    const a = await askJev(mkdtempSync(join(tmpdir(), "catherd-jev-live-")), "route-v2", laneState(lane));
    expect(a.why).toBeNull();
    const j = judgeRoute(jevQuestions().sets["route-v2"].rule, a.answers ?? {});
    expect(j.kind).toBe("repo_code");
    expect(j.track).toBe("A");
    expect(a.meta.model).toBe("jev-1.13.0");
  }, 60_000);

  test("accepts the real key and refuses a fake one", async () => {
    expect(await testJevKey(process.env.TYPESAFE_API_KEY as string)).toBe(true);
    expect(await testJevKey("ts_fake_key")).toBe(false);
  }, 60_000);
});
```

In `package.json`, delete the line `    "snapshot:models-dev": "bun scripts/snapshot-models-dev.ts",`. Then drop the dependency nothing imports any more (with Bun ≥ 1.4, so the lockfile keeps its format):

```bash
grep -rn "ofetch" src test scripts   # expect no output
bun remove ofetch
```

Expected: `package.json` loses `"ofetch": "^1.5.1"`, and `bun.lock` loses `ofetch` and the packages only it used (`destr`, `node-fetch-native`; `ufo` if nothing else needs it) and nothing else. If `bun.lock`'s `lockfileVersion` changes, the Bun in use is older than 1.4: restore the lockfile and rerun with Bun ≥ 1.4.

In `README.md`, replace the row

```
| `bunx catherd-cli catalog refresh` | Refreshes the models.dev snapshot                                |
```

with

```
| `bunx catherd-cli catalog refresh` | Lists every backend's models now; `catalog list` shows them      |
```

In `docs/dependencies.md`, delete the line

```
- ofetch — HTTP with retries for the Jev client — unjs, works with `fetch`, built-in retry/backoff
```

In `src/tui/watch-model.ts`, replace the comment line

```ts
 * The fields `watch` shows from one `jev.jsonl` row (`JevLogRow` in `src/routing/jev.ts`):
```

with

```ts
 * The fields `watch` shows from one 0.x `jev.jsonl` row (the 0.x Jev client's log, gone in 1.0):
```

- [ ] **Step 5: Run everything**

Run: `bun run format && bun run typecheck && bun run lint && bun run format:check && bun test`
Expected: PASS. If `theme > reads the colour depth from the environment and honours NO_COLOR` fails, it fails identically on plan 3's untouched tree (it reads the terminal's environment) and is not this plan's. `grep -rn "routing/route\|routing/commands\|models-dev\|refreshModelsDev" src test scripts package.json` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add -A src/entry/catalog-command.ts src/cli.ts src/routing test/entry/catalog-command.test.ts test/catalog.test.ts test/live/jev.live.test.ts package.json bun.lock README.md docs/dependencies.md src/tui/watch-model.ts
git commit -m "feat(cli): catherd catalog refresh, list and treat-like; remove 0.x routing and the models.dev snapshot"
```

---

## Self-review

**Spec coverage.** §5.1: rungs name their backend and `default` means no effort flag (Task 1 `rungInfo`, `effortOffered`; Task 6 Haiku `#default`). §5.2 layer 1: `catalog/models.json` with canonical and per-backend ids, efforts, contexts (Codex 272K), capabilities, notes (`ultra`), the Codex image tool's ChatGPT-login requirement, and the spec's seed families (Task 1). Layer 2: discovery from each adapter's `listModels` with `fetchedAt` (plan 3's cache), refreshed by `catalog refresh` now (Tasks 7, 11; `init` and `doctor` call the same `refreshDiscovery` in plans 5 and 7) and at most daily on `route` (Tasks 7, 9), Claude's `/v1/models` refresh (Task 6), opencode limited to Zen and Go (plan 3). Layer 3: `catalog/scores.json` with benchmark, version, URL, date and confidence, unsourced values marked `inferred` (Task 1). Bars re-derived and the approved ladder pinned (Task 3, and end to end through the bridge's default profile in Task 9). `secs_per_task` from own runs with ≥ 5 samples, effort order below (Tasks 3, 7). Unscored discovered models listed but disabled until treat-like, shipped treat-likes marked `inferred` (Tasks 1, 7, 11). The models.dev snapshot removed (Task 11). §5.3 cost rank per billing mode, subscription before metered (Task 2). §5.4 Jev → lane → default, `select` and the speed ladder ported, `routes.jsonl` source (Tasks 3, 9); `ultra` never in a default ladder (routing places only rungs the profile enables; spec §7.2's default profile is plan 5's). §5.5: optional Jev with `use: auto|off` and keys from env or `credentials.json` (Tasks 8, 9), `route-v2` as versioned data with a content hash (Task 4), the trimmed, scrubbed state never logged (Tasks 4, 8, 9), the decision rule with its dead band and thresholds in data (Task 4), the transport (Task 5), the per-run cache and the log row (Task 8), `finding`/`same-defect` in probability terms (Tasks 4, 9), `jev.jsonl` with a header row (Task 8). §5.6 `outcomes.jsonl` with environment climbs excluded (Task 10). Deferred on purpose: `catherd jev eval` (spec: 1.x), storing `billing` and `jev` in the profile and spec §7.2's default profile (plan 5), `init`/`doctor` calling `refreshDiscovery` (plans 5, 7), the TUI on the 1.0 catalog (plan 6).

**Placeholder scan.** Every code step shows the whole file or the exact text to replace; the synthetic Jev fixtures are given in full and say why they are synthetic.

**Type consistency.** `Catalog`, `RungInfo`, `rungInfo`, `scoresOf` (Task 1) are what Tasks 3 and 7 use; `Cost`/`costOf`/`compareCost` (Task 2) are used by Tasks 3 and 7; `RoutingProfile`/`Pick` (Task 3) by Task 9; `Verdict` with `probability` (Task 4) is the port's in Task 9 and the fakes'; `JevTransport` (Task 5) is extended by `JevOpts` (Task 8), which `routingService` takes (Task 9); `RouteJev` (Task 9) is `OutcomeRow.jevProbs` (Task 10); `Refreshed` and `CatalogModel` (Task 7) are what Task 11 prints.

**Review Focus.** Each of the five lines names the test that pins it, in Tasks 3, 4, 5, 7, 9 and 11.

## After this plan

- Plan 5's profile schema v1 stores `objective`, `billing`, `jev.use` and per-role `defaultRung` (the bridge serves defaults until then), writes spec §7.2's default profile (with `ultra` rungs never enabled by default and Go failovers chosen by treat-like), validates rungs against this plan's catalog (so Astra, Fable, Sonnet and Haiku can be enabled), replaces `ProfilePort.agentFor`'s 0.x `agentName`, calls `refreshDiscovery` from `init`, and passes the profile's `billing` to `catalogQuery`. Then `src/routing/catalog.ts`, `src/routing/select.ts` and `catalog/catalog.json` can go with the 0.x profile code.
- Plan 6 moves the TUI onto `catalog-service`, `jev-service` and the 1.0 runs (retiring `src/routing/jev.ts` and the 0.x `watch` rows), including the "treat like" picker and `inferred` markers.
- Plan 7's `doctor` calls `refreshDiscovery` and `testJevKey`, and reports whether Codex is logged in with ChatGPT (the image tool's requirement in `catalog/models.json`).
- 1.x: `catherd jev eval` replays `outcomes.jsonl` and the logged answers (Brier, log loss, reliability with Wilson intervals, flip rate) and suggests the cost-optimal threshold.
