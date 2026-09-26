# Final whole-branch review: Plan 4 (catalog + routing), 2c01441..f6f3f89

I reviewed the whole diff in two passes. The first pass covered the domain and infra layers: catalog, cost, select, jev and jev-client. The second covered services, entry, the 0.x shim and the tests, with the five Review Focus items traced end to end. The per-task reviews and the ledger were read, and every deferred minor was triaged (see the end of this report).

Checks run at f6f3f89:
- The gate: `bun run typecheck` and `bun run lint` are clean, and `format:check` is clean on 241 files. `bun test` gives 793 pass, 10 skip, 0 fail.
- Hermeticity probe: services, entry, domain, infra, adapters, bridge, catalog and tui/profiles run with a fake `ANTHROPIC_API_KEY`, a fake `TYPESAFE_API_KEY` and a dead HTTPS proxy. 537 pass, 0 fail. The MCP stdio integration tests also pass (4/4) with a fake Anthropic key.
- Scratch probes (listed below) covered `laneState` and `scrubFree` on indented fences and secret shapes, and `catherd catalog treat-like` with a malformed rung in an isolated `CATHERD_HOME`.
- Data spot check: every value in `catalog/scores.json` (30 scores, 3 treat-likes, the bars) and every price, plan weight, effort list and context in `catalog/models.json` was compared with `docs/research/2026-09-25-models.md` §1–§3. Everything matches, and confidence labels follow the research doc: verified, secondary, and inferred where the research doc says UNVERIFIED.
- `bun.lock` drops only `ofetch`, `destr`, `node-fetch-native` and `ufo`, and `lockfileVersion` is unchanged.

## Strengths

- **The layers are clean.** The domain files (`catalog.ts`, `cost.ts`, `select.ts`, `jev.ts`) are pure. `infra/jev-client.ts` is the only Jev transport. The services import only downward, and `test/architecture.test.ts` passes. Only `src/entry` imports the bridge, which now keeps only the profile half. `agentFor` moved to `ProfilePort` consistently across admission, dispatch, run-service and lane-service.
- **Review Focus 1 (Jev hangs) holds end to end.** The attempt timer now aborts the request, so it covers the body read too. The track sums are rounded before comparison. `route` waits at most `DISCOVERY_BUDGET_MS` (5 s) on the daily listing, then up to Jev's 25 s deadline, and it logs why it fell back. The hang test and the stale-listing test both pin this.
- **Review Focus 3 (a wedged listing) holds.** Due backends are listed in parallel. A backend is tried at most once an hour per process, and the cached listing is used while a refresh finishes. `routing-service.test.ts` "routes on the cached listing when the daily listing does not answer within the budget" pins it, and also shows the listing-lacks-rung skip (Focus 4, first half) at the route level.
- **Review Focus 4 holds.** `candidates` skips rungs that cannot parse, that no model offers, that the backend's listing lacks, that cannot do the role, or that are unscored. An empty role raises `E_CONFIG_INVALID` with a `fix` that names treat-like, and this is tested in both select and routing-service.
- **Review Focus 5 holds.** The 0.x `OverrideSchema` is loose, and the 0.x loader skips treat-likes it cannot score. The 0.x save goes through the same lock and `writeJsonAtomic`. A test shows that the 1.0 `scores[]` survive a 0.x save and that the 1.0 reader still parses the result.
- **The approved ladder is pinned three ways:** the domain (20 kind/difficulty cases), the routing service through the real bridge default profile, and the skill text.
- **The fix rounds hold up across tasks.** `listingOf` is shared by `rungInfo` and `capableFor`. `saveJevKey` refuses a newer or corrupt credentials file instead of overwriting it. `scrubFree` covers finding and same-defect. The cache replays the drift note. `latestOutcomes` plus the spec §5.6 wording settle the one-row-per-lane question. `land` writes outcomes under the routes lock.
- **The data is honest.** Every unsourced number is marked `inferred`, Opus terminal uses the system card numbers (not the CursorBench mix-up), and treat-likes surface as `confidence: "inferred"` in `catalog_query` (Task 1's ⚠️ is resolved at `catalog-service.ts:219`).

## Issues

### Critical (must fix)

None.

### Important (should fix before merge)

1. **`catherd catalog treat-like` saves a malformed rung, and the saved file then breaks every 1.0 route and the 0.x profile loaders** (`src/services/catalog-service.ts:173-176, 179-195`).
   - `canonicalOf` passes a rung without `:` through unchecked. `saveTreatLike` then writes it with `writeJsonAtomic` without validating it against `OverrideSchema`.
   - Reproduced in a scratch home:
     - `catherd catalog treat-like foo gpt-6-sol#high` prints `✓ foo is treated like gpt-6-sol#high` and writes `"treatLike": {"foo": …}`.
     - From then on, `readOverride()` throws `E_CONFIG_INVALID … Invalid key in record → at treatLike.foo`. The failures that follow are `catalog list`, `catalog treat-like`, `loadCatalog()` (so every MCP `route` and `catalog_query`) and the 0.x `routing/catalog.ts` `loadCatalog()` (so profile validation, the bridge's `ProfileView` and the TUI).
   - A single typo (a missing `#effort`) in a user-facing CLI command therefore bricks routing until the user edits the file by hand. This is the Task 7 deferred minor #4, which I escalate.
   - Fix:
     - Validate `from` (and `to`) with the canonical-rung shape before taking the lock, and refuse with `E_INPUT_INVALID`/`E_CONFIG_INVALID` and a fix. The simplest way is to export `CanonicalRung` from `domain/catalog.ts`, or to `OverrideSchema.parse` the merged object before `writeJsonAtomic`.
     - Add a CLI or service test: `treat-like foo gpt-6-sol#high` exits 1, and the override file is unchanged.

2. **Fenced code inside a list item reaches Jev** (`src/domain/jev.ts:121-122`, `dropFences`, used by both `laneState` and `scrubFree`). This breaks Review Focus 2's "nothing … fenced reaches Jev".
   - The opener and the closer are anchored at column 0 (`^(`{3,}|~{3,})` and `^\1`). Markdown allows an indented fence, and a fence under a numbered step (`1. Step\n   ```bash …`) is a common shape in lane files.
   - Probe: a lane with a 3-space-indented ```` ```bash ```` block kept `export TOKEN=abc` and `rm -rf /` in `body`.
   - Fix: allow leading whitespace on both the opener and the closer, for example `/^[ \t]*(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?^[ \t]*\1[^\n]*$|[\s\S]*$)/gm`. Extend the Task 4 laneState test, or the routing wire test, with an indented fence.

### Minor (not blocking)

1. **`scrubSecrets` misses two common secret shapes** (`src/domain/jev.ts:72-80`), found in the same probe:
   - `Authorization: Bearer eyJ…` (a JWT or an opaque bearer token)
   - URL userinfo such as `postgres://user:hunter22@db/x`

   Suggest two more patterns: `/\bBearer\s+[A-Za-z0-9._~+\/-]{16,}=*/g` and `/(\w+:\/\/[^\s:@\/]+:)[^\s@\/]+@/g` → `$1[secret]@`. Regex scrubbing is best effort by nature, so this is not blocking.
2. **`finding` and `sameDefect` ignore `profile.jev.use: "off"`** (`src/services/routing-service.ts:140-158`; the port signature carries no profile). There is no effect today, because the bridge always serves `"auto"` (Ruling 10). Plan 5 must thread the profile, or its `jev.use`, into these two calls when it stores `jev.use`.
3. **Claude rungs can never clear a shipped bar.**
   - Every bar needs `repo_code` ≥ 55 and/or `honesty` ≥ 90. Anthropic has no honesty score (research §3.3), and Opus low–xhigh borrow only xhigh's `terminal` score. So a `claude:`/`claude-code:` rung is placed only through the `defaultLadder` fallback, and it never appears in a Track A/B ladder next to Codex rungs.
   - This follows from Rulings 3–4, not from an implementation defect. Plan 5's default profile (spec §7.2, which includes a Claude plan) should know that a Claude rung in a mixed worker ladder is unreachable.
4. **`saveTreatLike` on a rung that already has its own scores reports success but has no effect** (`scoresOf` prefers own scores). Suggest refusing it, or saying that the rung is already scored.
5. **`src/tui/init.tsx:117`: `d.saveJevKey(key)` can now throw** (a newer or corrupt `credentials.json`) inside an async handler that does not catch it, so the TUI stalls. The trigger is rare and the TUI retires in plan 6. A `.catch` that shows the note would do.
6. **`test/integration/mcp-stdio.test.ts:26` passes `ANTHROPIC_API_KEY` through to the spawned server.** It is harmless today: the routed worker ladder is Codex-only, and the discovery wait is bounded at 5 s. For hermeticity, strip it next to `TYPESAFE_API_KEY`.

## Triage of the deferred minors

**Must fix before merge:**
- **Task 7 #4, `canonicalOf` passes a bare rung through unvalidated.** This is Important 1 above: a typo corrupts the override file and breaks routing.

**Should fix, cheap (recommended in this PR, not blocking):**
- **Task 4, a test that each `catalog/jev.json` verdict set's `fallback` is among its caller's options.** The shipped data is correct today (`code` ∈ design/code/unclear, `no` ∈ yes/no). A two-line data test guards against an edit that would otherwise make `judgeVerdict` return an out-of-type value.
- **Task 11, `src/tui/matrix.tsx` never handles a rejected save.** A `.catch` that returns to `nav` with a note is enough. It is the same class of problem as Minor 5.

**Leave deferred (correctly deferred, or already resolved):**
- Task 1:
  - `capableFor` listing key: fixed (`listingOf`).
  - `https`-only URL for override scores: minor.
  - The test title claims more than its body asserts: cosmetic.
- Task 2: the chatgpt-plan no-`planWeight` fallback test and the Fable `compareCost` ordering test are coverage niceties.
- Task 3:
  - The hollow weaker-rung test and the broad `catch` in `candidates`: coverage and hardening.
  - The speed-objective fallback: a note for the speed follow-up.
  - Sol has no terminal score: a data observation.
- Task 4:
  - `pKind` of -1, `trackA` length, probability keys, an unclosed fence, surrogate pairs, `canonicalJson` of `undefined`: all fixed at HEAD.
  - A test of `judgeVerdict` at exactly 0.83 or 0.85: nice to have.
- Task 5:
  - Empty `Retry-After`, the 422 body echo, `content-type` on a GET: fixed.
  - The 20 ms timer test: acceptable.
- Task 6:
  - Hermeticity: resolved by the rulings (verified by the fake-key probe).
  - The per-page timeout and the order of API entries: fine.
- Task 7:
  - #1, `measuredSecs` keys a record by the lane's latest route kind: small skew.
  - #2, `loadCatalog` reads timings on every route: do a perf check later.
  - #3, `freshenDiscovery` fails silently: a debug log would help, not blocking.
  - #5, the unscored `why` shows on `#ultra`: wording.
- Task 8:
  - `jevKey` returns null on a corrupt file, and cached answers are not validated: declined with reasons in the ledger. I agree.
  - Drift on a cache hit: fixed.
  - The hollow test and the temp dirs: handled.
- Task 9: all applied.
- Task 10:
  - A free-form milestone that matches no lane writes nothing and says nothing: a hint would help, but the orchestrator's skill tells it the `Mx` form. Leave it.
  - The land/climb race: fixed with the lock.
- Task 11:
  - The 0.x save does not stamp `schema: 1` on a new file: the 1.0 reader defaults the field.
  - The target check runs before the lock: harmless.

## Declined to judge

- **`catherd watch` still reads `jev.jsonl` in the 0.x shape** (`questions[]`, through `core/runstore`). 1.0 run folders (`<data>/repos/<slug>/runs/…`) are invisible to the 0.x `listRuns`, so no 1.0 row reaches it. This belongs to plan 6's TUI rewrite.
- **Per-repo discovery files** (`discovery/repos/<backend>-<sha16>.json`) are not consulted by `route` or `catalog_query`, which read the home listing only. The plan's File Structure scopes discovery to the home listing, and per-repo listing is plan 3's or 5's concern.
- **`route`'s worst case is 5 s (discovery) + 25 s (Jev), not 25 s flat.** The ledger ruling and the Review Focus 1 amendment accept this.
- **With `jev.use: "auto"` and no key, every multi-rung route logs a `no key` row, and `runs_summary` counts it as a Jev fallback.** This is arguably right (Jev did not decide), so I left the wording of that line alone.
- **The 0.x profile still refuses Astra, Fable, Sonnet and Haiku rungs.** This is Ruling 12, until plan 5.
- **Comparing honesty across vendors** (research §3.3 recommends against it): a plan-level decision (Ruling 3). See Minor 3 for its consequence.

## Assessment

**Ready to merge: with fixes.** Important 1 must be fixed; Important 2 is cheap and falls under a named Review Focus, so it should be fixed too.

**Reasoning:** The branch is well layered and the gate is green. The five Review Focus items hold end to end with tests, except for the fence shape in Important 2, and the shipped data matches the research. One CLI path can write an override that bricks routing and the 0.x profile loaders, and the fence stripping misses indented fences. Both are small, local fixes with obvious tests.
