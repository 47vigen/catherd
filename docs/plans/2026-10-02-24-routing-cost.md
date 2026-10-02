# catherd 1.5, plan 24: routing and cost — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every enabled rung can start a lane: an unpriced rung paid from a plan or subscription costs 0 in its tier, the profile's ladder order breaks every tie, and rungs of equal scores start on the quota the run has used least. A climb ladder only goes up, a lane starts no lower than an easier difficulty's start, and `route` says when no rung clears the bar or a tie decided. `route` returns little (rung, ladder, backend, agent, why) and `routes.jsonl` records every role's decision with its provenance, Jev's disagreement with a declared lane header (which wins), and each lane's final outcome beside Jev's answer. `route` takes a milestone's lanes in one call; `dispatch` takes `rung` optionally on a lane. A new same-family release takes at least its predecessor's values, the Artificial Analysis Intelligence Index calibrates `repo_code`, sparse rungs never stand in, and the 1.2 routing and catalog minors are closed.

**Architecture:** The routing rules stay pure in `src/domain/select.ts` (`candidates`, `select`, `defaultLadder`; new `ladderFrom`, `breakTie`, `noClearLine`, `quotaUsage`) and `src/domain/cost.ts`; `src/domain/profile-rules.ts` adds the idle-quota and reach warnings. `src/services/routing-service.ts` splits a route into `prepare` (catalog), `judge` (Jev) and `decide` (header first, then Jev, then the default), and `routeMany` judges every lane at once and decides them in order. `src/services/lane-service.ts` computes the run's quota usage, records each decision in `routes.jsonl` (lane rows as before; `RoleRouteRow` with `lane: null`; `OutcomeRouteRow` with `source: "outcome"`) and returns the slim `RouteResult`; `readRoutes` keeps returning only lane route and climb rows, so every existing reader is untouched. The catalog changes live in `catalog/models.json` (`predecessor`), `src/domain/calibration.ts`, `src/services/standins.ts` and `src/services/source-derive.ts`.

**Tech Stack:** Bun ≥ 1.4, TypeScript, zod 4, citty, `@modelcontextprotocol/sdk`, `@opentui/react`. No new dependency.

**Spec:** `docs/specs/2026-10-02-catherd-1.5-design.md`, "Plan 24: routing and cost" (binding); evidence in `docs/dev/ideas.md`: the agentic-machine identity run ("Equal scores never reach the second quota", "The climb ladder goes down above the top rung", "Only worker dispatches leave a route record", "Scores of a new same-family release start absurd"), the payment run ("`route` bloats the orchestrator", "Ladders were inverted on just-claude", "`dispatch` needs a rung it then overrides"), the 1.1.0 platform run ("Jev overrode the lane headers"), "Routing and cost" ("Jev difficulty calibration", "Batch `route`"), the 1.3 follow-up "A sparse rung borrows its nearest stand-in's honesty", and the 1.2 follow-ups the spec's last bullet names.

**Pre-validated on scratch `6f2f8c7..35a8a66` (worktree branch `plan24-scratch`, code head `35a8a66`; this plan is the commit after it): 2062 pass / 19 skip / 0 fail (2081 tests, 184 files, about 6 minutes); `bun install --frozen-lockfile`, typecheck, lint and format:check green.** The code below is that scratch build, commit by commit, on `main` at `6f2f8c7` (#45, "remove wait"). Task 2 carries two scratch commits: its test-only second commit (`7dad10c`) was built after Task 12 and depends on Task 2 alone.

## Global Constraints

- Spec 1.5, plan 24, binding, verbatim:
  - "**Unpriced subscription rungs start.** An unpriced rung on a subscription billing key costs 0 within its tier; the profile's ladder order breaks every tie; `profile validate` warns about a rung that can never start. Equal scores prefer the billing key with more quota headroom; `route` says when a tie decided."
  - "**Climb ladders only go up.** A climb ladder holds only rungs that score at least the start rung; when no rung clears the bar, `route` says so (`no rung clears repo_code/hard; best is …`) and `profile validate` warns about a kind and difficulty a role cannot reach."
  - "**Every role's decision is recorded** in `routes.jsonl`, with source and ladder."
  - "**`route` returns little:** rung, ladder, backend, agent and a one-line why; provenance goes to `routes.jsonl`."
  - "**A declared lane header wins** over Jev; when Jev disagrees, the route record says so."
  - "**`dispatch` with `lane` takes `rung` optionally.**"
  - "**A new same-family release** takes at least its predecessor's values at the same effort until a value arrives; the Artificial Analysis Intelligence Index per model and effort joins the calibration sources."
  - "**Sparse rungs:** a stand-in must share at least 3 dims with the rung it stands in for; single-dim rows are refused as honesty stand-ins."
  - "**Outcome logging:** each lane's final outcome (climbed or not) is written beside Jev's answer in `routes.jsonl`."
  - "**Batch `route(run, lanes: [...])`** asks Jev once for all lanes."
  - "**The just-claude ladders:** `jev-kind` with a `build` difficulty gets the role's full ladder, not one rung; `logic` starts no lower than `build`."
  - "**The 1.2 routing and catalog minors** (provenance "your override", inferred-from marks, `route` evidence guarded, TUI save preview, silent `defaultRung` fallback, `speedLadder`'s `ui` dimension, ruling 7 alignment, ATTRIBUTION, `valueWords`, `adjacent` effort spreading upward only, `catalog list` "like X", `treat-like --clear` partial gap, doctor handshake `CATHERD_NO_SYNC`, fetchers throwing on empty, `writeDerived` validation, `catalog_sync` busy, `testAaKey` retries 0, doctor rate-limit timestamp, per-field direction in `derive`, `saveCredential` lock, `catalog-refresh.yml` credentials)."
- **Owner ruling X6 (binding): the logic and hard bars above every Sol rung are the owner's call. No task changes a bar value or `catalog/scores.json`.** No new CI job: the only workflow edit is inside `catalog-refresh.yml` (Task 12).
- Layers `domain → infra → adapters → services → entry` (`test/architecture.test.ts`): `select.ts`, `cost.ts`, `route.ts`, `profile-rules.ts`, `calibration.ts` stay pure domain; Jev, run files and the catalog are read in services.
- The gate: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test` (FORCE_COLOR unset). No test reaches the network: every fetch is injected (`fakeFetch`, `recordedFetch`); `test/preload.ts` keeps `CATHERD_NO_SYNC=1`. Tests that spawn a process pass an explicit `env` with `ANTHROPIC_API_KEY: ""` (Task 12's credentials test). No wall-clock sleep decides a test: the batch-route test holds Jev's answers until both requests are in flight.
- Commits: conventional (commitlint), subject ≤ 100 characters, lower-case first word after the scope; check `git log` after each commit (a failed hook leaves the changes uncommitted). No changeset (plan 27 writes the 1.5.0 one).
- The default profile validates with no error and no warning on every save, in `doctor` and in the TUI, as today; only an explicit `catherd profile validate` / `profile_validate` adds the reach warning (Ruling 3).

## Review Focus

1. **An OpenCode Go subscription sits idle while Codex carries every lane** (the identity run: 34 dispatches, 0 on Go). Expected: an unpriced Go rung costs 0 and starts the lanes it clears; when it ties a Codex rung on every value, the start goes to the quota the run has used least and `why` says a tie decided; `profile validate` names a quota that can never start. Pinned in Task 1 ("places a treat-like rung with the scores it borrows; unpriced on Go, it costs 0 and starts first"), Task 3 ("starts on the less used quota and says the tie decided"), Task 7 ("spreads lanes that tie over the quotas, each routed start counting as a use") and Task 4 ("warns about a quota none of whose rungs ever starts a lane").
2. **A climb lands on a weaker rung** (the identity run's repo_code/hard ladder `sol#medium → deepseek#max → glm#max`). Expected: the ladder holds only rungs at least as strong as the start on the lane's bar, and `route` names the closest rung. Pinned in Task 2 ("keeps a weaker rung off the ladder when nothing clears the bar, and says which rung comes closest") and the re-pinned approved table ("the approved ladder: default worker on the shipped catalog").
3. **A metered rung wins a headroom tie and spends money nobody chose.** Expected: a tie never crosses cost tiers. Pinned in Task 4 ("never gives a tie to a metered rung over one paid from a plan").
4. **Jev overrides a lane's declared header** (the 1.1.0 platform run: declared logic routed as copy). Expected: the header wins and the record says what Jev said. Pinned in Task 5 ("keeps the lane's declaration over a confident track, says Jev disagreed, and logs it but never the lane").
5. **A role's rung cannot be audited, or `route` floods the coordinator's context.** Expected: `route` answers seven keys; every decision (lane, lane-less role, lane-less dispatch) is a `routes.jsonl` row, and the lane readers (`readRoutes`: climb, land, protocol, digest, evidence) never see the new rows. Pinned in Task 5 ("records a role routed without a lane, with its source, ladder and why, apart from the lanes"; the stdio test's key list), Task 6 ("records a lane-less dispatch's rung, and whether route or the coordinator chose it") and Task 8 ("the lane readers never see an outcome row").
6. **One unreadable run on the machine fails every route.** Expected: evidence and timings skip it. Pinned in Task 5 ("routes with no evidence when a run on this machine cannot be read (1.2 minor)").

## Rulings on the spec

Controller rulings carried in: X1 (built on `main` `6f2f8c7`; the executor adapts to plans 21–23), X6 (no bar changes, no new CI job), X7 (conservative product decisions; owner questions below).

Rulings of this plan (`what — why — cost if wrong`):

1. **Ruling: an unpriced rung costs 0 under every flat-fee mode (`chatgpt-plan`, `claude-plan`, `subscription`), tier 0; an unpriced metered rung stays `null`, last in tier 1** — "a subscription billing key" read as any plan the user already pays for; a metered rung spends per call — cost if wrong: an unpriced plan rung starts the lanes it clears ahead of priced ones (the point, for Go).
2. **Ruling: the ladder-order tie-break is the rung's position in `roles.<role>.rungs`, after cost then seconds (cost objective) or seconds then cost (speed)** — "the profile's ladder order breaks every tie" — cost if wrong: none; it only orders what compared equal.
3. **Ruling: the reach warning ("no worker rung clears …") is given only by an explicit validate (`catherd profile validate`, `profile_validate`), not on saves, in `doctor` or in the TUI** — on the shipped bars the default worker reaches no logic or hard bar (owner ruling X6), so every `profile set`, every `doctor` and the TUI tree would carry a warning the user cannot act on short of the owner's call; the idle-quota warning is in every validation — cost if wrong: a user who never runs `validate` learns it from `route`'s `why` instead. **Owner question 1.**
4. **Ruling: "scores at least the start" means at least the start on every dimension of the lane's bar (a lane-less ladder: every dimension the start has), and each rung kept scores at least the rung kept before it (the ladder is built as a chain, in the objective's order)** — the speed ladder already compared strength; one dimension alone lets a weaker-everywhere-else rung on; checking each rung against the start alone let a mixed Codex and Claude ladder step down between its own rungs (final review Important 1: `… → opus-5-5#medium → sol#xhigh`) — cost if wrong: the default copy ladder loses Sol high (65.3 < Luna high's 66.6): copy lanes climb Luna high → Sol xhigh; a cheaper strong rung after a stronger one is dropped rather than reordered.
5. **Ruling: when no rung clears, the start is the default rung, raised to the start of the hardest easier difficulty some rung clears when that rung scores at least the default on this bar; `best` is the rung missing the fewest thresholds, then the highest on the kind's main dimension** — "`logic` starts no lower than `build`" without starting a logic lane on a rung weaker on honesty or agentic (the default profile: Luna high stays off logic, Sol medium starts) — cost if wrong: on the default profile `ui` logic and hard lanes now start at Sol xhigh (build's start), not Sol medium.
6. **Ruling: batch `route` sends one Jev request per lane, all in flight at once, and decides the lanes in order** — one multi-lane request would rewrite every question per lane and change the question set's identity, its cache key and the calibration of its rule; in flight together, a milestone waits for the slowest answer, not the sum — cost if wrong: N requests (about $0.000025 each) instead of one.
7. **Ruling: headroom is the run's dispatches per quota (`quotaOf`: native `claude` and `claude-code` are one), plus each lane routed but not dispatched at its current rung; in a batch each routed start counts; a tie is only between rungs of different quotas in the start's cost tier that are equal on every compared dimension** — no quota API exists (only agy and doctor read one, as text); per run is what `runs.jsonl` holds — cost if wrong: two runs in parallel can both start on the same quota.
8. **Ruling: "a rung that can never start" is warned per quota: a quota none of whose rungs starts any kind and difficulty (nor a lane-less route), whichever quota the run has used least** — a top rung reached only by climbing is the normal case and would warn on every default ladder — cost if wrong: one idle rung on a quota that starts elsewhere is not named.
9. **Ruling: the reach warning covers the worker role only, one warning listing every kind and its unreached difficulties** — lanes route as the worker; the existing "blind kind" warning (plan 14 Ruling 12) is its special case and is replaced — cost if wrong: a lane routed with another role reads `why` only.
10. **Ruling: a lane header wins when it declares both `Kind:` and `Difficulty:`; a declared `Kind:` alone still wins over Jev's kind; Jev is still asked (its 25 s budget) so `jevSaid` and the outcome rows can carry its answer** — "when Jev disagrees, the route record says so" needs Jev's answer — cost if wrong: a fully declared lane still waits on Jev.
11. **Ruling: `route` returns `{ lane, role, rung, ladder, backend, agent, why }`; `source`, `kind`, `difficulty`, the Jev answer, `jevSaid`, `noClear`, `tie` and `provenance` go to the `routes.jsonl` row. A lane-less decision is a `RoleRouteRow` (`lane: null`, `source: "route" | "dispatch"`); `readRoutes` filters to lane `route`/`climb` rows; `readRoleRoutes` and `readOutcomeRoutes` read the others** — every existing reader keeps its meaning — cost if wrong: a reader that parses `routes.jsonl` itself (none in `src/`; `live-verification.md`'s `jq` is updated in Task 13) must filter.
12. **Ruling: `dispatch` without `rung`: on a lane, the lane's current rung (after any climb), routing it first when unrouted; without a lane, `E_INPUT_INVALID` naming `route(run, role)`. A lane-less dispatch writes a `dispatch` row: `decidedBy` is the role's last `route` row's source when the rung is that row's, else `orchestrator`; a failed write is logged, never a failed dispatch** — the role is already running — cost if wrong: a lost audit row.
13. **Ruling: the outcome row joins `routes.jsonl` as `source: "outcome"` (kind and difficulty of the lane's last route, Jev's probabilities, `climbed`, `landed`, `start_ok`, `envCaused`); `outcomes.jsonl` (spec §5.6) is kept as it is** — "beside Jev's answer in `routes.jsonl`" — cost if wrong: one row written twice.
14. **Ruling: a family's predecessor is explicit (`predecessor` in `catalog/models.json`, 8 families); the floor replaces an inferred stand-in's value on a dimension when the predecessor's own value at the same effort is at least as high; a treat-like (shipped or the user's) is an explicit mapping and is kept as is** — no id heuristic can tell a line from a sibling — cost if wrong: a family added without `predecessor` gets no floor. GPT-6.1 Sol keeps its shipped treat-likes (they lend GPT-6 Sol's values, the same floor).
15. **Ruling: the AA Intelligence Index is fitted onto `repo_code` like AA's other coding numbers (`artificial_analysis_intelligence_index`, per AA slug effort)** — DeepSWE is the anchor whose bars route lanes; a fit below R² 0.5 or 5 shared rungs is not used (spec 1.2 §4.2) — cost if wrong: none until a fit passes.
16. **Ruling: "a stand-in must share at least 3 dims" is read as: a stand-in has values of its own on at least 3 dimensions (`MIN_STANDIN_DIMS`)** — 40 of the 95 shipped canonical rungs have no value of their own, so a rule on dimensions shared with the rung would leave them unscored; the evidence is a one-row stand-in (GPT-6.1 Sol's honesty) — cost if wrong: a two-dimension row stands in nowhere either.
17. **Ruling: `adjacent` spreads upward only in a sync (`derive`); the weekly rebuild of `catalog/scores.json` keeps spreading both ways** — the default ladder's Luna rungs rest on DeepSWE published only at max (plan 14 Ruling 3), and X6 keeps the shipped routing as the owner left it; the `ideas.md` entry is trimmed to the shipped part — cost if wrong: a new family's low efforts get a stand-in instead of its high effort's value. **Owner question 2.**
18. **Ruling: plan 14 Ruling 7 is aligned to the code: `steer` is never inferred by default, and a user's steer bar makes it inferred** — the user asked for a steer bar; a rung with none would otherwise fail it silently — cost if wrong: none (behaviour unchanged, now pinned).
19. **Ruling: a treat-like's value reads "like X" (the user's and the shipped ones: both are mappings); an inferred stand-in's reads "inferred from X"** — the minor asks to tell a mapping from a guess — cost if wrong: wording.
20. **Ruling: "fetchers throw on empty" covers Artificial Analysis (both paths) and every Arena config, the two the minor names** — the other parsers already tolerate a partial answer — cost if wrong: another source's empty answer replaces its last good one.
21. **Ruling: lower is better for `cost_per_task` and `median_time_to_first_token_seconds`; every other field keeps the higher** — the minor's two examples; no other field is lower-is-better today — cost if wrong: a future fact needs adding.
22. **Ruling: the requests-left count keeps its own read time (`rateLimitAt` in `state.json`); a state written before 1.5 falls back to the last attempt** — the minor — cost if wrong: one stale date after the upgrade.
23. **Ruling: `catalog_sync` never waits (`wait: false`): it answers `busy` at once while another sync runs; `catherd catalog sync` still waits** — the minor names the tool — cost if wrong: none.
24. **Ruling: the TUI preview offers a repair only for a stored profile (`profiles().names`, as the service's `profileExists`)** — the minor — cost if wrong: none.
25. **Ruling: `catalog-refresh.yml` checks out with `persist-credentials: false` and pushes with the token in the URL inside the PR step only** — the minor; no new job (X6) — cost if wrong: the push step needs the token, which it has.

### Owner questions (built as recommended)

1. **Where does "no worker rung clears …" show?** Recommended and built: only in an explicit `profile validate` (Ruling 3). The alternative, every validation, puts a permanent warning on the default profile in `doctor`, on every `profile set` and in the TUI tree, while the bars that cause it are the owner's open call.
2. **Should the shipped rebuild spread `adjacent` values upward only too?** Recommended and built: not yet (Ruling 17). Upward only there would drop Luna high's DeepSWE 66.6 (published at max) at the next weekly refresh and move every default copy and build lane off Luna high.

## Spec coverage

| Spec bullet (plan 24) | Task |
| --- | --- |
| Unpriced subscription rungs cost 0 within their tier | 1 |
| The profile's ladder order breaks every tie | 1 |
| `profile validate` warns about a rung that can never start | 4 |
| Equal scores prefer the billing key with more quota headroom; `route` says when a tie decided | 3 (domain, routing), 5 (`why`), 7 (batch) |
| A climb ladder holds only rungs that score at least the start | 2 |
| When no rung clears, `route` says so (`no rung clears …; best is …`) | 2 (domain), 5 (`why`, row) |
| `profile validate` warns about a kind and difficulty a role cannot reach | 4 |
| Every role's decision recorded in `routes.jsonl`, with source and ladder | 5 (route), 6 (dispatch) |
| `route` returns rung, ladder, backend, agent and a one-line why; provenance to `routes.jsonl` | 5 |
| A declared lane header wins over Jev; the record says when Jev disagrees | 5 |
| `dispatch` with `lane` takes `rung` optionally | 6 |
| A new same-family release takes at least its predecessor's values | 9 |
| The AA Intelligence Index per model and effort joins the calibration sources | 9 |
| Sparse rungs: a stand-in needs 3 dims; single-dim rows refused | 10 |
| Each lane's final outcome beside Jev's answer in `routes.jsonl` | 8 |
| Batch `route(run, lanes: [...])` asks Jev once for all lanes | 7 |
| `jev-kind` with `build` gets the full ladder; `logic` starts no lower than `build` | 2 |
| Minor: provenance "your override" | 5 |
| Minor: inferred-from marks | 10 |
| Minor: `route` evidence guarded | 5 |
| Minor: TUI save preview | 12 |
| Minor: silent `defaultRung` fallback | 4 |
| Minor: `speedLadder`'s `ui` dimension | 2 |
| Minor: ruling 7 alignment | 10 |
| Minor: ATTRIBUTION | 12 |
| Minor: `valueWords` | 5 |
| Minor: `adjacent` spreading upward only | 11 |
| Minor: `catalog list` "like X" | 10 |
| Minor: `treat-like --clear` partial gap | 10 |
| Minor: doctor handshake `CATHERD_NO_SYNC` | 12 |
| Minor: fetchers throwing on empty | 11 |
| Minor: `writeDerived` validation | 11 |
| Minor: `catalog_sync` busy | 11 |
| Minor: `testAaKey` retries 0 | 11 |
| Minor: doctor rate-limit timestamp | 11 |
| Minor: per-field direction in `derive` | 11 |
| Minor: `saveCredential` lock | 12 |
| Minor: `catalog-refresh.yml` credentials | 12 |
| The skill, README and live kit say what changed | 5, 6, 7, 13 |
| `ideas.md` loses what this plan fixes | 14 |

## Assumes

- `main` at `6f2f8c7`. Plans 21, 22 and 23 merge first (X1): they touch `src/services/dispatch-service.ts` (21, 22), `src/services/lane-service.ts` (22: `result` and Next; 23: `land`), `src/services/run-store.ts` (21: per-role scratch), `src/domain/profile-rules.ts` and `src/entry/mcp/setup-tools.ts` (21: isolation warnings, the role server), `src/services/ports.ts`, `plugin/skills/catherd/SKILL.md`, `README.md`, `docs/dev/live-verification.md` and `docs/dev/ideas.md` (all). Every hunk below is re-found by its context; where a hunk no longer applies, the executor re-applies its intent there and records a ruling.
- Plan 22 makes `dispatch` refuse a thread not in `runs.jsonl` and accept `thread: "latest"`; Task 6 does not touch the thread path.

## Parallelism

| Wave | Batches (parallel worktrees) | Depends on | Why disjoint |
| --- | --- | --- | --- |
| A | {1, 2, 3, 4}, {9, 11, 12} | — | Batch 1: `cost.ts`, `select.ts`, `profile-rules.ts`, `profile-store.ts`, `profile-service.ts`, `profile-command.ts`, `routing-service.ts` and `lane-service.ts` (Task 3's usage lines), `ports.ts` (`RouteRequest.usage`), and their tests. Batch 2: `catalog/models.json`, `catalog.ts` (`FamilySchema`), `calibration.ts`, `standins.ts` (Task 9), `infra/sources/{artificial-analysis,arena,cache}.ts`, `source-derive.ts`, `source-sync.ts`, `setup-tools.ts`, `ports.ts` (`Deps.sync` only), `handshake.ts`, `credentials.ts`, `ATTRIBUTION.md`, `catalog-refresh.yml`, `save-dialog.tsx`, and their tests |
| B | {5, 6, 7, 8} | A | `routing-service.ts`, `lane-service.ts`, `ports.ts`, `route.ts`, `run-store.ts`, `catalog.ts` (`userBars`), `provenance.ts`, `catalog-service.ts`, `dispatch-service.ts`, `dispatch-tools.ts`, `lane-tools.ts`, `SKILL.md`, and their tests |
| C | {10}, then {13}, then {14} | B | `standins.ts` (after 9), `profile-rules.ts` `inferredScores` (after 4), `provenance.ts` and `catalog-service.ts` (after 5), `catalog-command.ts`, `treat-likes.ts`, the TUI profiles view; then the docs; then `ideas.md` |

Shared files, each owned by one batch at a time: `src/services/ports.ts` (batches 1 and 2 touch different interfaces in wave A: `RouteRequest` and `Deps.sync`; the scratch commits, replayed in this wave order on `6f2f8c7`, merged with no conflict into the same tree), `src/domain/catalog.ts` (9, then 5), `src/services/standins.ts` (9, then 10), `src/domain/profile-rules.ts` (4, then 10), `src/services/provenance.ts` and `src/services/catalog-service.ts` (5, then 10), `src/entry/mcp/setup-tools.ts` (11, then 12, one batch), `plugin/skills/catherd/SKILL.md` (5, 6, 7, then 13). Inside a batch the tasks run in order. Batching for fewer agents: {1–4}, {9, 11, 12}, {5–8}, {10, 13, 14}.

---

### Task 1: Unpriced subscription rungs start, and the ladder order breaks every tie (spec bullet 1; Rulings 1, 2)

`costOf` prices a rung catherd has no family for at 0 under a flat-fee mode (tier 0) and leaves an unpriced metered one unknown (tier 1, last). `candidates` sorts by cost then seconds (or seconds then cost under `speed`), then by the rung's position in `roles.<role>.rungs`.

**Interfaces:**
- Consumes: nothing new.
- Produces: `costOf(null, effort, mode)` → `{ tier: 0, value: 0, mode }` for `chatgpt-plan`, `claude-plan`, `subscription`; `{ tier: 1, value: null, mode: "metered" }` for `metered`. `candidates()` breaks every remaining tie on the profile's order.

**Scratch commit:** `f356748` (feat(routing): start unpriced subscription rungs and break ties on ladder order).

**Files:**
- Modify: `src/domain/cost.ts`
- Modify: `src/domain/select.ts`
- Modify: `test/domain/cost.test.ts`
- Modify: `test/domain/select.test.ts`

- [ ] **Step 1: Write the failing tests**

Edit `test/domain/cost.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/domain/cost.test.ts b/test/domain/cost.test.ts
index 2b4ca43..5d20f57 100644
--- a/test/domain/cost.test.ts
+++ b/test/domain/cost.test.ts
@@ -44,13 +44,21 @@ describe("cost rank (spec §5.3)", () => {
     expect(compareCost(goLuna, zenLuna)).toBeLessThan(0);
   });
 
-  it("orders an unknown model last in its tier, and an unknown effort as medium", () => {
-    const unknown = costOf(null, "high", "subscription");
-    expect(unknown).toEqual({ tier: 0, value: null, mode: "subscription" });
-    expect(compareCost(costOf(fam("gpt-6-sol"), "max", "subscription"), unknown)).toBeLessThan(0);
+  it("prices an unpriced plan or subscription rung at 0 in its tier, and an unknown effort as medium", () => {
+    for (const mode of ["subscription", "chatgpt-plan", "claude-plan"] as const)
+      expect(costOf(null, "high", mode)).toEqual({ tier: 0, value: 0, mode });
+    const unpriced = costOf(null, "max", "subscription");
+    expect(compareCost(unpriced, costOf(fam("gpt-6-luna"), "low", "subscription"))).toBeLessThan(0);
+    expect(compareCost(unpriced, costOf(fam("gpt-6-luna"), "low", "metered"))).toBeLessThan(0);
     expect(effortFactor("thinking")).toBe(1);
   });
 
+  it("orders an unpriced metered rung last in its tier", () => {
+    const unknown = costOf(null, "high", "metered");
+    expect(unknown).toEqual({ tier: 1, value: null, mode: "metered" });
+    expect(compareCost(costOf(fam("gpt-6-sol"), "max", "metered"), unknown)).toBeLessThan(0);
+  });
+
   it("bills the spec's default keys", () => {
     expect(DEFAULT_BILLING).toMatchObject({
       codex: "chatgpt-plan",
````

Edit `test/domain/select.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/domain/select.test.ts b/test/domain/select.test.ts
index 441a1c6..42ff479 100644
--- a/test/domain/select.test.ts
+++ b/test/domain/select.test.ts
@@ -104,7 +104,7 @@ describe("select", () => {
     );
   });
 
-  it("places a treat-like rung with the scores it borrows", () => {
+  it("places a treat-like rung with the scores it borrows; unpriced on Go, it costs 0 and starts first", () => {
     const c = shipped({
       override: {
         schema: 1,
@@ -113,13 +113,38 @@ describe("select", () => {
         bars: {},
       },
     });
-    const p = worker({}, [...LADDER, "opencode:opencode-go/kimi-k3#default"]);
-    expect(select(c, p, "worker", "repo_code", "logic").ladder).toEqual([
-      "codex:gpt-6-sol#medium",
-      "codex:gpt-6-sol#high",
-      "codex:gpt-6-sol#xhigh",
-      "opencode:opencode-go/kimi-k3#default",
-    ]);
+    const kimi = "opencode:opencode-go/kimi-k3#default";
+    const p = worker({}, [...LADDER, kimi]);
+    expect(candidates(c, p, "worker")[0]?.rung).toBe(kimi);
+    // terminal copy: Sol's borrowed Terminal-Bench 43 clears 40.15, and the unpriced Go rung is the cheapest
+    expect(select(c, p, "worker", "terminal", "copy")).toEqual({
+      rung: kimi,
+      ladder: [kimi, SOL_MEDIUM, SOL_HIGH, SOL_XHIGH],
+    });
+  });
+
+  it("breaks a cost tie on the profile's ladder order (spec 1.5 plan 24)", () => {
+    const c = shipped({
+      override: {
+        schema: 1,
+        treatLike: {
+          "opencode-go/kimi-k3#default": "gpt-6-sol#medium",
+          "opencode-go/glm-5#default": "gpt-6-sol#medium",
+        },
+        scores: [],
+        bars: {},
+      },
+    });
+    const kimi = "opencode:opencode-go/kimi-k3#default";
+    const glm = "opencode:opencode-go/glm-5#default";
+    const first = (rungs: string[]) => candidates(c, worker({}, rungs), "worker").map((x) => x.rung);
+    expect(first([glm, kimi, SOL_MEDIUM])).toEqual([glm, kimi, SOL_MEDIUM]);
+    expect(first([kimi, glm, SOL_MEDIUM])).toEqual([kimi, glm, SOL_MEDIUM]);
+    expect(first([kimi, glm, SOL_MEDIUM]).slice(0, 2)).toEqual(
+      candidates(c, worker({ objective: "speed" }, [kimi, glm, SOL_MEDIUM]), "worker")
+        .map((x) => x.rung)
+        .slice(0, 2),
+    );
   });
 
   it("ranks subscription rungs before metered ones, then by cost", () => {
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/domain/cost.test.ts test/domain/select.test.ts`
Expected: FAIL: `costOf(null, "high", "subscription")` still returns `value: null`, so the unpriced Go rung sorts last and is not `candidates(...)[0]`; the two Go rungs come back in cost order, not the written order.

- [ ] **Step 3: Implement**

Edit `src/domain/cost.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/cost.ts b/src/domain/cost.ts
index e18a58b..a6d1a15 100644
--- a/src/domain/cost.ts
+++ b/src/domain/cost.ts
@@ -51,19 +51,24 @@ export const CHATGPT_UNIT_USD = 0.019;
 export interface Cost {
   /** 0: paid from a subscription; 1: metered. Every tier-0 rung ranks before any tier-1 rung. */
   tier: 0 | 1;
-  /** comparable across billing modes, in list-price dollars per task; null when unknown */
+  /**
+   * comparable across billing modes, in list-price dollars per task; 0 for an unpriced rung paid from a plan or
+   * subscription (it spends nothing beyond the flat fee); null for an unpriced metered one
+   */
   value: number | null;
   mode: BillingMode;
 }
 
 /**
- * Spec §5.3. Every mode yields list-price dollars per task, so plans compare with each other:
+ * Spec §5.3. Every mode yields list-price dollars per task, so plans compare with each other. Spec 1.5 plan 24:
+ * a rung catherd has no price for costs 0 within its tier when a plan or subscription pays for it, so it can
+ * start a lane (the profile's ladder order then breaks the tie); a metered one stays unknown, last in its tier.
  * chatgpt-plan scales the official quota weight (Luna 1, Sol 20, Astra 60) by the effort factor;
  * claude-plan uses API prices as the proxy, with Fable metered (catherd cannot tell Pro from Max);
  * Go's share of its monthly dollar limit is dollars / limit, which orders the same as dollars.
  */
 export function costOf(family: Family | null, effort: string, mode: BillingMode): Cost {
-  if (!family) return { tier: mode === "metered" ? 1 : 0, value: null, mode };
+  if (!family) return mode === "metered" ? { tier: 1, value: null, mode } : { tier: 0, value: 0, mode };
   const usd = taskUsd(family.price, effort);
   switch (mode) {
     case "chatgpt-plan":
````

Edit `src/domain/select.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/select.ts b/src/domain/select.ts
index 50b323e..c3c2c9d 100644
--- a/src/domain/select.ts
+++ b/src/domain/select.ts
@@ -44,12 +44,14 @@ function secsOf(c: Catalog, canonical: string, kind: Kind | null): number | null
  * The role's enabled rungs that the catalog can place: parseable, offered by their model, listed by
  * the backend when it has a listing, capable for the role, and scored (their own or a treat-like).
  * Ordered by cost (spec §5.3), or by measured speed with cost breaking ties; with fewer than 5
- * samples a rung has no speed, and cost orders it, which within a model is effort order.
+ * samples a rung has no speed, and cost orders it, which within a model is effort order. The profile's
+ * ladder order breaks every remaining tie (spec 1.5 plan 24), so equal rungs start in the order the user wrote.
  */
 export function candidates(c: Catalog, p: RoutingProfile, role: Role, kind: Kind | null = null): Candidate[] {
   if (!p.role.enabled) return [];
   const out: Candidate[] = [];
-  for (const rung of new Set(p.role.rungs)) {
+  const order = [...new Set(p.role.rungs)];
+  for (const rung of order) {
     let info: RungInfo;
     try {
       info = rungInfo(c, rung);
@@ -68,8 +70,11 @@ export function candidates(c: Catalog, p: RoutingProfile, role: Role, kind: Kind
       secs: secsOf(c, info.canonical, kind),
     });
   }
-  const cost = (a: Candidate, b: Candidate) => compareCost(a.cost, b.cost) || byNull(a.secs, b.secs);
-  const speed = (a: Candidate, b: Candidate) => byNull(a.secs, b.secs) || compareCost(a.cost, b.cost);
+  const written = (a: Candidate, b: Candidate) => order.indexOf(a.rung) - order.indexOf(b.rung);
+  const cost = (a: Candidate, b: Candidate) =>
+    compareCost(a.cost, b.cost) || byNull(a.secs, b.secs) || written(a, b);
+  const speed = (a: Candidate, b: Candidate) =>
+    byNull(a.secs, b.secs) || compareCost(a.cost, b.cost) || written(a, b);
   return out.sort(p.objective === "speed" ? speed : cost);
 }
 
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/domain/cost.test.ts test/domain/select.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS.

- [ ] **Step 5: Commit**

````bash
git add src/domain/cost.ts src/domain/select.ts test/domain/cost.test.ts test/domain/select.test.ts
git commit -m "feat(routing): start unpriced subscription rungs and break ties on ladder order"
````

---

### Task 2: Climb ladders only go up, and a lane starts no lower than an easier difficulty (spec bullets 2, 11; minor `speedLadder`'s `ui`; Rulings 4, 5)

`select` and `defaultLadder` build every ladder through `ladderFrom(start, order, dims)`: the start, then every other candidate that scores at least the start on every dimension of the lane's bar (a lane-less ladder: every dimension the start has), in the objective's order. A stronger rung joins the ladder wherever cost puts it (the payment run's "no room to climb"), a weaker one never does (the identity run's hard ladder). When no rung clears the bar the start is the default rung, raised to the hardest cleared easier difficulty's start when that rung scores at least the default on this bar, and `Pick.noClear` says `no rung clears <kind>/<difficulty>; best is <rung> (<dim> <value> < <min>, …)`. `primaryDim(ui)` is `frontend`. The approved-ladder table is re-pinned: copy lanes lose Sol high (65.3 < Luna high's 66.6); logic and hard lanes carry `noClear`; ui logic and hard start at Sol xhigh.

The appended test (scratch commit `7dad10c`, test only, folded into this task's commit) pins the payment run's just-claude ladders on override scores: a `jev-kind` lane with no `Difficulty:` routes as `build` and gets every stronger rung; a logic lane starts at build's start, not at the default rung.

**Interfaces:**
- Consumes: Task 1's `candidates` order.
- Produces: `Pick.noClear?: string`; `primaryDim(kind: Kind): Dim`; `noClearLine(all: Candidate[], bar, kind, d): string` (exported, used by Task 4 only through `select`); `defaultLadder` and `select` keep their signatures.

**Scratch commits:** `0e8494f` (feat(routing): keep climb ladders going up and start no lower than an easier difficulty), `7dad10c` (test(routing): pin the just-claude ladders of the payment run).

**Files:**
- Modify: `src/domain/select.ts`
- Modify: `test/domain/select.test.ts`
- Modify: `test/services/routing-service.test.ts`

- [ ] **Step 1: Write the failing tests**

Edit `test/domain/select.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/domain/select.test.ts b/test/domain/select.test.ts
index 42ff479..8d6b347 100644
--- a/test/domain/select.test.ts
+++ b/test/domain/select.test.ts
@@ -16,12 +16,17 @@ const LADDER = [
   "codex:gpt-6-sol#xhigh",
 ];
 const [LUNA_HIGH, SOL_MEDIUM, SOL_HIGH, SOL_XHIGH] = LADDER as [string, string, string, string];
-/** Track A: Luna high (repo_code 66.6, carried from max) clears the 60.95 copy bar; Sol medium (56.6) does not */
-const TRACK_A = { rung: LUNA_HIGH, ladder: [LUNA_HIGH, SOL_HIGH, SOL_XHIGH] };
+/**
+ * Track A: Luna high (repo_code 66.6, carried from max) clears the 60.95 copy bar; Sol medium (56.6) does not.
+ * Spec 1.5 plan 24: the ladder only goes up, so Sol high (65.3) is off it; Sol xhigh (66.6) stays.
+ */
+const TRACK_A = { rung: LUNA_HIGH, ladder: [LUNA_HIGH, SOL_XHIGH] };
 /** the build bar is the median, 66.6: Luna high and Sol xhigh reach it */
 const BUILD = { rung: LUNA_HIGH, ladder: [LUNA_HIGH, SOL_XHIGH] };
-/** nothing clears: the default rung and every rung above it */
+/** nothing clears: the default rung and every rung at least as strong on the bar */
 const TRACK_B = { rung: SOL_MEDIUM, ladder: LADDER.slice(1) };
+const noClear = (kind: Kind, d: Difficulty) =>
+  expect.stringMatching(new RegExp(`^no rung clears ${kind}/${d}; best is `));
 
 /** Spec §7.2's default worker: the four Codex rungs, default sol#medium, the owner's billing. */
 const worker = (over: Partial<RoutingProfile> = {}, rungs = LADDER): RoutingProfile => ({
@@ -33,13 +38,19 @@ const worker = (over: Partial<RoutingProfile> = {}, rungs = LADDER): RoutingProf
 
 /**
  * Spec 1.2 §5: the default worker on the shipped bars of 2026-09-28. Sol reaches no Track B bar (agentic
- * 0.0818 is below 0.08606, repo_code 66.6 below 67), so logic and hard lanes start at the default rung;
- * terminal copy needs Terminal-Bench 40.15, which Sol clears (43, carried from max) and Luna (13) does not;
- * ui build needs frontend 1617 and repo_code 66.6, which only Sol xhigh clears.
+ * 0.0818 is below 0.08606, repo_code 66.6 below 67), so logic and hard lanes start at the default rung, and
+ * `noClear` says so (spec 1.5 plan 24); terminal copy needs Terminal-Bench 40.15, which Sol clears (43,
+ * carried from max) and Luna (13) does not, and nothing reaches terminal build's 55.8; ui build needs frontend
+ * 1617 and repo_code 66.6, which only Sol xhigh clears, so ui logic and hard start there too: no lower than
+ * build, since Sol xhigh scores at least the default rung on their bars.
  */
 const approved = (kind: Kind, d: Difficulty) => {
-  if (d === "logic" || d === "hard" || kind === "terminal") return TRACK_B;
-  if (kind === "ui" && d === "build") return { rung: SOL_XHIGH, ladder: [SOL_XHIGH] };
+  if (kind === "terminal") return d === "copy" ? TRACK_B : { ...TRACK_B, noClear: noClear(kind, d) };
+  if (kind === "ui" && d !== "copy") {
+    const xhigh = { rung: SOL_XHIGH, ladder: [SOL_XHIGH] };
+    return d === "build" ? xhigh : { ...xhigh, noClear: noClear(kind, d) };
+  }
+  if (d === "logic" || d === "hard") return { ...TRACK_B, noClear: noClear(kind, d) };
   return d === "copy" ? TRACK_A : BUILD;
 };
 
@@ -192,6 +203,12 @@ describe("objective speed", () => {
     expect(d).toEqual({ rung: SOL_HIGH, ladder: [SOL_HIGH, LUNA_HIGH, SOL_XHIGH] });
   });
 
+  it("sorts a ui speed ladder on frontend, the dimension ui gates on", () => {
+    const secs = { "gpt-6-sol#xhigh|ui": 50 };
+    const d = select(shipped({ secs }), worker({ objective: "speed" }), "worker", "ui", "build");
+    expect(d.rung).toBe(SOL_XHIGH);
+  });
+
   it("keeps the approved pin under cost whatever the timings", () => {
     const secs = { "gpt-6-sol#high|*": 1, "gpt-6-luna#high|*": 9999 };
     expect(select(shipped({ secs }), worker(), "worker", "repo_code", "copy")).toEqual(TRACK_A);
@@ -205,3 +222,52 @@ describe("defaultDifficulty", () => {
     expect(defaultDifficulty(c, worker(), "worker", "repo_code")).toBe("build");
   });
 });
+
+describe("climb ladders only go up (spec 1.5 plan 24)", () => {
+  /** the identity run's M1.L2: a Sol start with two weaker Go rungs above it in cost order */
+  const goWeak = () =>
+    shipped({
+      override: {
+        schema: 1,
+        treatLike: {
+          "opencode-go/deepseek-v4.1-flash#default": "gpt-6-luna#medium",
+          "opencode-go/glm-5.3-flash#default": "gpt-6-luna#low",
+        },
+        scores: [],
+        bars: {},
+      },
+    });
+  const DEEPSEEK = "opencode:opencode-go/deepseek-v4.1-flash#default";
+  const GLM = "opencode:opencode-go/glm-5.3-flash#default";
+
+  it("keeps a weaker rung off the ladder when nothing clears the bar, and says which rung comes closest", () => {
+    const p = worker({ billing: { "opencode-go": "metered" } }, [SOL_MEDIUM, DEEPSEEK, GLM]);
+    const pick = select(goWeak(), p, "worker", "repo_code", "hard");
+    expect(pick.rung).toBe(SOL_MEDIUM);
+    expect(pick.ladder).toEqual([SOL_MEDIUM]);
+    expect(pick.noClear).toBe(
+      "no rung clears repo_code/hard; best is codex:gpt-6-sol#medium (repo_code 56.6 < 70.9, agentic 0.0818 < 0.1077)",
+    );
+  });
+
+  it("puts a stronger rung on the ladder even when cost orders it below the start", () => {
+    const c = shipped();
+    // Opus low (74.2, every dimension above Sonnet medium's) costs less than Sonnet medium on the Claude plan
+    const p = worker({}, ["claude-code:claude-sonnet-5#medium", "claude-code:claude-opus-5-5#low"]);
+    p.role.defaultRung = "claude-code:claude-sonnet-5#medium";
+    expect(defaultLadder(c, p, "worker")).toEqual({
+      rung: "claude-code:claude-sonnet-5#medium",
+      ladder: ["claude-code:claude-sonnet-5#medium", "claude-code:claude-opus-5-5#low"],
+    });
+  });
+
+  it("starts a lane no lower than an easier difficulty's start that scores at least the default on its bar", () => {
+    const c = shipped();
+    for (const d of DIFFICULTIES) c.bars.repo_code[d] = { repo_code: d === "copy" ? 60 : 1e9 };
+    // build, logic and hard clear nothing; copy's start (Luna high, 66.6) beats the default (Sol medium, 56.6)
+    // on the only dimension those bars have, so they start at Luna high, not the default rung
+    const pick = select(c, worker(), "worker", "repo_code", "logic");
+    expect(pick.rung).toBe(LUNA_HIGH);
+    expect(pick.ladder).toEqual([LUNA_HIGH, SOL_XHIGH]);
+  });
+});
````

Edit `test/services/routing-service.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/routing-service.test.ts b/test/services/routing-service.test.ts
index 9b1390e..6a605c9 100644
--- a/test/services/routing-service.test.ts
+++ b/test/services/routing-service.test.ts
@@ -28,9 +28,10 @@ beforeEach(() => {
 const fx = (n: string): unknown =>
   JSON.parse(readFileSync(join(import.meta.dir, "..", "fixtures", "jev", n), "utf8"));
 // spec 1.2 §5: build lanes need DeepSWE 66.6 (the median), which Luna high (carried from max) and Sol xhigh
-// clear; copy needs 60.95, which Sol high clears too; no Sol rung clears a logic or hard bar
+// clear; copy needs 60.95, which Sol high clears too, but it scores below Luna high, so a ladder that only goes
+// up (spec 1.5 plan 24) leaves it off; no Sol rung clears a logic or hard bar
 const TRACK_A = { rung: LADDER[0] as string, ladder: [LADDER[0] as string, LADDER[3] as string] };
-const COPY = { rung: LADDER[0] as string, ladder: [LADDER[0], LADDER[2], LADDER[3]] as string[] };
+const COPY = TRACK_A;
 const TRACK_B = { rung: LADDER[1] as string, ladder: LADDER.slice(1) };
 const noWait = { sleep: async () => {}, random: () => 0.5 };
 
@@ -327,13 +328,14 @@ describe("route and a repository's listing", () => {
     });
     const rungs = ["opencode:opencode/gpt-6-luna#high", "opencode:opencode/gpt-6-sol#high"];
     const profile = view({
-      roles: { worker: { enabled: true, access: "workspace-write", rungs, defaultRung: rungs[0] } },
+      roles: { worker: { enabled: true, access: "workspace-write", rungs, defaultRung: rungs[1] } },
     });
     const r = routingService();
+    // /work/a does not list the default rung, so the role falls back to the one it lists
     const inA = await r.route(req(null, { repo: "/work/a", profile }));
     expect(inA.ladder).toEqual(["opencode:opencode/gpt-6-luna#high"]);
     const inB = await r.route(req(null, { repo: "/work/b", profile }));
-    expect(inB.ladder).toContain("opencode:opencode/gpt-6-sol#high");
+    expect(inB.rung).toBe("opencode:opencode/gpt-6-sol#high");
   });
 });
 
````

Append to the end of `test/domain/select.test.ts` (scratch commit `7dad10c`, built after Task 12; it needs only this task's code):

````ts
describe("the just-claude ladders (spec 1.5 plan 24, the payment run)", () => {
  // Sonnet 5.5 with no published value: the payment run's Claude rungs scored only by Sol's values
  const score = (effort: string, dim: "repo_code" | "honesty" | "agentic", value: number) => ({
    rung: `claude-sonnet-5-5#${effort}`,
    dim,
    value,
    benchmark: "b",
    version: "1",
    url: "https://example.com/b",
    date: "2026-09-28",
    confidence: "inferred" as const,
  });
  const values: [string, number][] = [
    ["low", 50],
    ["medium", 56.6],
    ["high", 66.6],
    ["xhigh", 68.8],
  ];
  const c = () =>
    shipped({
      override: {
        schema: 1,
        treatLike: {},
        scores: values.flatMap(([e, repo]) => [
          score(e, "repo_code", repo),
          score(e, "honesty", 95.1),
          score(e, "agentic", 0.0818),
        ]),
        bars: {},
      },
    });
  const rung = (e: string) => `claude-code:claude-sonnet-5-5#${e}`;
  const rungs = values.map(([e]) => rung(e));
  const p = (): RoutingProfile => ({
    objective: "cost",
    billing: {},
    role: { enabled: true, rungs, defaultRung: rung("medium") },
  });

  it("gives a build lane, the difficulty a sure kind defaults to, every stronger rung to climb onto", () => {
    // jev-kind with no Difficulty line: the default rung clears no bar, so the lane routes as build
    expect(defaultDifficulty(c(), p(), "worker", "repo_code")).toBe("build");
    expect(select(c(), p(), "worker", "repo_code", "build")).toEqual({
      rung: rung("high"),
      ladder: [rung("high"), rung("xhigh")],
    });
  });

  it("starts a logic lane no lower than build's start, not at the default rung below it", () => {
    const pick = select(c(), p(), "worker", "repo_code", "logic");
    expect(pick.rung).toBe(rung("high"));
    expect(pick.ladder).toEqual([rung("high"), rung("xhigh")]);
    expect(pick.noClear).toMatch(/^no rung clears repo_code\/logic; best is /);
  });
});
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/domain/select.test.ts test/services/routing-service.test.ts`
Expected: FAIL: the approved table still has Sol high on the copy ladder and no `noClear`; the identity run's hard ladder still climbs onto the two Go rungs; Opus low is not on Sonnet medium's default ladder; logic starts at the default rung, not build's start; the ui speed ladder sorts on repo_code.

- [ ] **Step 3: Implement**

Edit `src/domain/select.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/select.ts b/src/domain/select.ts
index c3c2c9d..bee70f0 100644
--- a/src/domain/select.ts
+++ b/src/domain/select.ts
@@ -31,6 +31,8 @@ export interface Candidate {
 export interface Pick {
   rung: string;
   ladder: string[];
+  /** spec 1.5 plan 24: no rung clears the lane's bar (`no rung clears repo_code/hard; best is …`) */
+  noClear?: string;
 }
 
 const byNull = (a: number | null, b: number | null) =>
@@ -90,15 +92,38 @@ function noRung(role: Role): CatherdError {
   });
 }
 
+/** The dimensions a ladder is compared on: the bar's, else every dimension the start has a value on. */
+function compareDims(start: Candidate, bar: Partial<Record<Dim, number>>): Dim[] {
+  const dims = (Object.keys(bar) as Dim[]).filter((d) => bar[d] !== undefined);
+  return dims.length ? dims : (Object.keys(start.scores) as Dim[]);
+}
+
+/** `x` scores at least `start` on every one of `dims` (a missing value scores below any). */
+const atLeast = (x: Candidate, start: Candidate, dims: Dim[]): boolean =>
+  dims.every(
+    (d) => (x.scores[d] ?? Number.NEGATIVE_INFINITY) >= (start.scores[d] ?? Number.NEGATIVE_INFINITY),
+  );
+
 /**
- * The role's default rung and every candidate above it (the whole list when it has no default), in cost
- * order under either objective: speed order would put slower, not stronger, rungs above the default.
+ * Spec 1.5 plan 24, "climb ladders only go up": the start, then every other candidate that scores at least the
+ * start on `dims`, in `order`'s order. A stronger rung is on the ladder wherever cost puts it, and a weaker one
+ * never is, so a climb never lands on a rung below the one it leaves.
+ */
+function ladderFrom(start: Candidate, order: Candidate[], dims: Dim[]): Pick {
+  const rest = order.filter((x) => x !== start && atLeast(x, start, dims));
+  return { rung: start.rung, ladder: [start, ...rest].map((x) => x.rung) };
+}
+
+/**
+ * The role's default rung and every candidate at least as strong on every dimension it has a value on (the
+ * whole list when it has no default), in cost order under either objective: speed order would put slower, not
+ * stronger, rungs above the default.
  */
 export function defaultLadder(c: Catalog, p: RoutingProfile, role: Role): Pick {
-  const all = candidates(c, { ...p, objective: "cost" }, role).map((x) => x.rung);
+  const all = candidates(c, { ...p, objective: "cost" }, role);
   if (all.length === 0) throw noRung(role);
-  const i = Math.max(0, all.indexOf(p.role.defaultRung ?? ""));
-  return { rung: all[i] as string, ladder: all.slice(i) };
+  const start = all.find((x) => x.rung === p.role.defaultRung) ?? (all[0] as Candidate);
+  return ladderFrom(start, all, compareDims(start, {}));
 }
 
 /**
@@ -113,29 +138,78 @@ export function defaultDifficulty(c: Catalog, p: RoutingProfile, role: Role, kin
   return cleared.at(-1) ?? "build";
 }
 
+/** The kind's main dimension: what a speed ladder sorts on and what `best is` reads first. */
+export const primaryDim = (kind: Kind): Dim =>
+  kind === "terminal" ? "terminal" : kind === "ui" ? "frontend" : "repo_code";
+
 /**
  * Under `objective: "speed"` the objective picks only the start (the fastest bar-clearing rung); the
- * ladder above it is the other bar-clearing rungs at least as strong on the kind's primary dimension,
- * weakest first, cost breaking ties, so a lane never climbs onto a weaker rung. Ported from 0.x.
+ * ladder above it is the other rungs at least as strong on the bar, weakest first on the kind's primary
+ * dimension, cost breaking ties, so a lane never climbs onto a weaker rung. Ported from 0.x.
  */
-function speedLadder(clearing: Candidate[], kind: Kind): Pick {
-  const start = clearing[0] as Candidate;
-  const dim: Dim = kind === "terminal" ? "terminal" : "repo_code";
+function speedLadder(start: Candidate, all: Candidate[], kind: Kind, dims: Dim[]): Pick {
+  const dim = primaryDim(kind);
   const strength = (x: Candidate) => x.scores[dim] ?? Number.NEGATIVE_INFINITY;
-  const rest = clearing
-    .filter((x) => x !== start && strength(x) >= strength(start))
-    .sort((a, b) => strength(a) - strength(b) || compareCost(a.cost, b.cost));
-  return { rung: start.rung, ladder: [start, ...rest].map((x) => x.rung) };
+  const order = [...all].sort((a, b) => strength(a) - strength(b) || compareCost(a.cost, b.cost));
+  return ladderFrom(start, order, dims);
 }
 
-/** Spec §5.4: the start rung and ladder for a lane of this kind and difficulty (0.x `select`). */
+/** The thresholds of `bar` a rung misses, each with its value: `agentic 0.0818 < 0.1077`. */
+function shortfalls(cand: Candidate, bar: Partial<Record<Dim, number>>): string[] {
+  return (Object.entries(bar) as [Dim, number | undefined][]).flatMap(([dim, min]) => {
+    if (min === undefined) return [];
+    const v = cand.scores[dim];
+    return v !== undefined && v >= min ? [] : [`${dim} ${v ?? "none"} < ${min}`];
+  });
+}
+
+/**
+ * Spec 1.5 plan 24: when no rung clears a bar, the one closest to it: the fewest thresholds missed, then the
+ * highest on the kind's primary dimension, then the candidates' order.
+ */
+function bestOf(all: Candidate[], bar: Partial<Record<Dim, number>>, kind: Kind): Candidate {
+  const dim = primaryDim(kind);
+  const v = (x: Candidate) => x.scores[dim] ?? Number.NEGATIVE_INFINITY;
+  const misses = (x: Candidate) => shortfalls(x, bar).length;
+  return [...all].sort((a, b) => misses(a) - misses(b) || v(b) - v(a))[0] as Candidate;
+}
+
+/** `no rung clears repo_code/hard; best is codex:gpt-6-sol#xhigh (agentic 0.0818 < 0.1077)`. */
+export function noClearLine(
+  all: Candidate[],
+  bar: Partial<Record<Dim, number>>,
+  kind: Kind,
+  d: Difficulty,
+): string {
+  const best = bestOf(all, bar, kind);
+  return `no rung clears ${kind}/${d}; best is ${best.rung} (${shortfalls(best, bar).join(", ")})`;
+}
+
+/**
+ * Spec §5.4: the start rung and ladder for a lane of this kind and difficulty (0.x `select`). The start is the
+ * first rung in objective order that clears the bar. When none does, it is the default rung, raised to an
+ * easier difficulty's start when that one scores at least the default on this bar (spec 1.5 plan 24: `logic`
+ * starts no lower than `build`), and `noClear` says so. The ladder above the start only goes up.
+ */
 export function select(c: Catalog, p: RoutingProfile, role: Role, kind: Kind, difficulty: Difficulty): Pick {
   const all = candidates(c, p, role, kind);
   if (all.length === 0) throw noRung(role);
   if (all.length === 1) return { rung: all[0]?.rung as string, ladder: [all[0]?.rung as string] };
-  const clearing = all.filter((x) => clearsBar(c, x, kind, difficulty));
-  if (clearing.length === 0) return defaultLadder(c, p, role);
-  return p.objective === "speed"
-    ? speedLadder(clearing, kind)
-    : { rung: clearing[0]?.rung as string, ladder: clearing.map((x) => x.rung) };
+  const bar = c.bars[kind][difficulty];
+  const first = all.find((x) => clearsBar(c, x, kind, difficulty));
+  if (first) {
+    const dims = compareDims(first, bar);
+    return p.objective === "speed" ? speedLadder(first, all, kind, dims) : ladderFrom(first, all, dims);
+  }
+  const byCost = candidates(c, { ...p, objective: "cost" }, role, kind);
+  const fallback = defaultLadder(c, p, role).rung;
+  let start = byCost.find((x) => x.rung === fallback) ?? (byCost[0] as Candidate);
+  const dims = compareDims(start, bar);
+  for (const easier of DIFFICULTIES.slice(0, DIFFICULTIES.indexOf(difficulty)).reverse()) {
+    const s = byCost.find((x) => clearsBar(c, x, kind, easier));
+    if (!s) continue;
+    if (atLeast(s, start, dims)) start = s;
+    break;
+  }
+  return { ...ladderFrom(start, byCost, dims), noClear: noClearLine(all, bar, kind, difficulty) };
 }
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/domain/select.test.ts test/services/routing-service.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS.

- [ ] **Step 5: Commit**

````bash
git add src/domain/select.ts test/domain/select.test.ts test/services/routing-service.test.ts
git commit -m "feat(routing): keep climb ladders going up and start no lower than an easier difficulty"
````

---

### Task 3: Equal scores start on the quota with more headroom, and the pick says a tie decided (spec bullet 1; Ruling 7)

`RoutingProfile.usage` holds the run's dispatches per quota. `breakTie` looks for rungs on other quotas that score exactly as the start on the compared dimensions and starts on the one whose quota has the fewest uses (the candidates' order breaking an equal count); `Pick.tie` says `tie on <dims> with <rungs>: started on <rung>; <quota> has the most headroom (dispatches in this run: …)` or `equal headroom (…); the profile's ladder order and cost decided`. `quotaUsage(rungs)` counts rungs per `quotaOf`. The routing service passes `RouteRequest.usage` through; the lane service fills it from `runs.jsonl` (Task 7 widens it to routed, undispatched lanes).

**Interfaces:**
- Consumes: Task 2's `ladderFrom`.
- Produces: `RoutingProfile.usage?: Partial<Record<string, number>>`; `Pick.tie?: string`; `quotaUsage(rungs: readonly string[]): Record<string, number>`; `RouteRequest.usage?: Record<string, number>` (`src/services/ports.ts`).

**Scratch commit:** `c714d21` (feat(routing): start a tie of equal scores on the quota with more headroom).

**Files:**
- Modify: `src/domain/select.ts`
- Modify: `src/services/lane-service.ts`
- Modify: `src/services/ports.ts`
- Modify: `src/services/routing-service.ts`
- Modify: `test/domain/select.test.ts`
- Modify: `test/services/routing-service.test.ts`

- [ ] **Step 1: Write the failing tests**

Edit `test/domain/select.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/domain/select.test.ts b/test/domain/select.test.ts
index 8d6b347..3ed108c 100644
--- a/test/domain/select.test.ts
+++ b/test/domain/select.test.ts
@@ -4,6 +4,7 @@ import {
   candidates,
   defaultDifficulty,
   defaultLadder,
+  quotaUsage,
   type RoutingProfile,
   select,
 } from "../../src/domain/select.ts";
@@ -131,6 +132,7 @@ describe("select", () => {
     expect(select(c, p, "worker", "terminal", "copy")).toEqual({
       rung: kimi,
       ladder: [kimi, SOL_MEDIUM, SOL_HIGH, SOL_XHIGH],
+      tie: expect.stringMatching(/^tie on terminal with codex:gpt-6-sol#medium, /),
     });
   });
 
@@ -271,3 +273,67 @@ describe("climb ladders only go up (spec 1.5 plan 24)", () => {
     expect(pick.ladder).toEqual([LUNA_HIGH, SOL_XHIGH]);
   });
 });
+
+describe("equal scores go to the quota with more headroom (spec 1.5 plan 24)", () => {
+  // the identity run: DeepSeek on OpenCode Go is treated like Luna high, so the two tie on every dimension
+  const c = () =>
+    shipped({
+      override: {
+        schema: 1,
+        treatLike: { "opencode-go/deepseek-v4.1-flash#default": "gpt-6-luna#high" },
+        scores: [],
+        bars: {},
+      },
+    });
+  const DEEPSEEK = "opencode:opencode-go/deepseek-v4.1-flash#default";
+  const rungs = [LUNA_HIGH, DEEPSEEK, SOL_MEDIUM, SOL_HIGH, SOL_XHIGH];
+
+  it("starts on the less used quota and says the tie decided", () => {
+    const p = worker({ usage: { codex: 3, "opencode-go": 0 } }, rungs);
+    const pick = select(c(), p, "worker", "repo_code", "copy");
+    expect(pick.rung).toBe(DEEPSEEK);
+    expect(pick.ladder).toEqual([DEEPSEEK, LUNA_HIGH, SOL_XHIGH]);
+    expect(pick.tie).toBe(
+      `tie on repo_code with ${LUNA_HIGH}, ${SOL_XHIGH}: started on ${DEEPSEEK}; opencode-go has the most headroom (dispatches in this run: opencode-go 0, codex 3)`,
+    );
+    const back = select(
+      c(),
+      worker({ usage: { codex: 1, "opencode-go": 2 } }, rungs),
+      "worker",
+      "repo_code",
+      "copy",
+    );
+    expect(back.rung).toBe(LUNA_HIGH);
+  });
+
+  it("breaks a tie with equal headroom on the profile's ladder order, and says so", () => {
+    const first = select(c(), worker({}, [DEEPSEEK, LUNA_HIGH, SOL_XHIGH]), "worker", "repo_code", "build");
+    expect(first.rung).toBe(DEEPSEEK);
+    expect(first.tie).toMatch(
+      /equal headroom \(0 dispatches each\); the profile's ladder order and cost decided$/,
+    );
+    // the unpriced Go rung costs 0, so cost puts it first whatever the written order
+    expect(
+      select(c(), worker({}, [LUNA_HIGH, DEEPSEEK, SOL_XHIGH]), "worker", "repo_code", "build").rung,
+    ).toBe(DEEPSEEK);
+  });
+
+  it("leaves a start with no equal alone", () => {
+    expect(select(shipped(), worker(), "worker", "repo_code", "copy").tie).toBeUndefined();
+  });
+});
+
+describe("quotaUsage", () => {
+  it("counts a run's dispatched rungs per quota, Claude's two paths as one", () => {
+    expect(
+      quotaUsage([
+        "codex:gpt-6-luna#high",
+        "codex:gpt-6-sol#high",
+        "claude:claude-opus-5-5#low",
+        "claude-code:claude-opus-5-5#low",
+        "opencode:opencode-go/gpt-6-luna#high",
+        "not a rung",
+      ]),
+    ).toEqual({ codex: 2, "claude-code": 2, "opencode-go": 1 });
+  });
+});
````

Edit `test/services/routing-service.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/routing-service.test.ts b/test/services/routing-service.test.ts
index 6a605c9..1f82a1a 100644
--- a/test/services/routing-service.test.ts
+++ b/test/services/routing-service.test.ts
@@ -472,3 +472,27 @@ it("refuses native dispatch without host evidence while explicit profile stays i
     fix: expect.stringContaining("claude-code:claude-opus-5-5#high"),
   });
 });
+
+describe("route and quota headroom (spec 1.5 plan 24)", () => {
+  // Luna high on Codex and on OpenCode Go is one model: equal scores on two quotas
+  const GO_LUNA = "opencode:opencode-go/gpt-6-luna#high";
+  const rungs = [LADDER[0] as string, GO_LUNA, ...LADDER.slice(1)];
+  const profile = () =>
+    view({
+      roles: {
+        ...testView().roles,
+        worker: { enabled: true, access: "workspace-write", rungs, defaultRung: "codex:gpt-6-sol#medium" },
+      },
+    });
+
+  it("starts a tie on the quota the run has used least", async () => {
+    const r = routingService();
+    const a = await r.route(
+      req(lane("repo_code", "copy"), { profile: profile(), usage: { "opencode-go": 2 } }),
+    );
+    expect(a.rung).toBe(LADDER[0] as string);
+    const b = await r.route(req(lane("repo_code", "copy"), { profile: profile(), usage: { codex: 2 } }));
+    expect(b.rung).toBe(GO_LUNA);
+    expect(b.ladder).toContain(LADDER[0] as string);
+  });
+});
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/domain/select.test.ts test/services/routing-service.test.ts`
Expected: FAIL: `quotaUsage` is not exported by `src/domain/select.ts`; `RoutingProfile` has no `usage`; the DeepSeek/Luna tie starts on Luna whatever the usage and `pick.tie` is undefined; `RouteRequest` has no `usage`.

- [ ] **Step 3: Implement**

Edit `src/domain/select.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/select.ts b/src/domain/select.ts
index bee70f0..f26f39a 100644
--- a/src/domain/select.ts
+++ b/src/domain/select.ts
@@ -9,6 +9,8 @@ import {
 } from "./catalog.ts";
 import { type BillingMode, type Cost, compareCost, costOf, DEFAULT_BILLING } from "./cost.ts";
 import { CatherdError } from "./errors.ts";
+import { quotaOf } from "./failover.ts";
+import { tryParseRung } from "./ids.ts";
 import { DIFFICULTIES, type Difficulty, type Kind } from "./lane.ts";
 import type { Role } from "./roles.ts";
 
@@ -17,6 +19,11 @@ export interface RoutingProfile {
   objective: "cost" | "speed";
   billing: Partial<Record<string, BillingMode>>;
   role: { enabled: boolean; rungs: string[]; defaultRung?: string };
+  /**
+   * spec 1.5 plan 24: the run's dispatches so far per quota (`quotaOf`), the headroom a tie between rungs of
+   * equal scores is broken on; absent, every quota counts 0 and the candidates' order breaks it
+   */
+  usage?: Partial<Record<string, number>>;
 }
 
 export interface Candidate {
@@ -33,6 +40,8 @@ export interface Pick {
   ladder: string[];
   /** spec 1.5 plan 24: no rung clears the lane's bar (`no rung clears repo_code/hard; best is …`) */
   noClear?: string;
+  /** spec 1.5 plan 24: rungs of equal scores competed for the start, and how the tie was broken */
+  tie?: string;
 }
 
 const byNull = (a: number | null, b: number | null) =>
@@ -104,14 +113,64 @@ const atLeast = (x: Candidate, start: Candidate, dims: Dim[]): boolean =>
     (d) => (x.scores[d] ?? Number.NEGATIVE_INFINITY) >= (start.scores[d] ?? Number.NEGATIVE_INFINITY),
   );
 
+/** Spec 1.5 plan 24: how many of `rungs` (a run's dispatched rungs) drew on each quota. */
+export function quotaUsage(rungs: readonly string[]): Record<string, number> {
+  const out: Record<string, number> = {};
+  for (const rung of rungs) {
+    const r = tryParseRung(rung);
+    if (r) out[quotaOf(r)] = (out[quotaOf(r)] ?? 0) + 1;
+  }
+  return out;
+}
+
+/** Equal on every one of `dims`: a tie for the start. */
+const same = (a: Candidate, b: Candidate, dims: Dim[]): boolean => atLeast(a, b, dims) && atLeast(b, a, dims);
+
+const quota = (x: Candidate): string => quotaOf(x.info.parsed);
+
+/**
+ * Spec 1.5 plan 24: when rungs on other quotas score exactly as `start` does on `dims`, the start goes to the
+ * quota with the most headroom (the fewest of the run's dispatches so far), the candidates' order (cost, then
+ * the profile's ladder order) breaking an equal count. `tie` says what decided. Rungs of one quota that tie
+ * are no tie: cost already orders them.
+ */
+function breakTie(
+  start: Candidate,
+  order: Candidate[],
+  dims: Dim[],
+  usage: Partial<Record<string, number>>,
+): { start: Candidate; tie?: string } {
+  const rivals = order.filter((x) => x !== start && quota(x) !== quota(start) && same(x, start, dims));
+  if (rivals.length === 0) return { start };
+  const used = (x: Candidate) => usage[quota(x)] ?? 0;
+  const tied = [start, ...rivals];
+  const pick = [...tied].sort((a, b) => used(a) - used(b))[0] as Candidate;
+  const others = tied.filter((x) => x !== pick).map((x) => x.rung);
+  const counts = [...new Set(tied.map(quota))].map((q) => `${q} ${usage[q] ?? 0}`).join(", ");
+  const why = tied.every((x) => used(x) === used(pick))
+    ? `equal headroom (${used(pick)} dispatches each); the profile's ladder order and cost decided`
+    : `${quota(pick)} has the most headroom (dispatches in this run: ${counts})`;
+  return {
+    start: pick,
+    tie: `tie on ${dims.join(", ")} with ${others.join(", ")}: started on ${pick.rung}; ${why}`,
+  };
+}
+
 /**
- * Spec 1.5 plan 24, "climb ladders only go up": the start, then every other candidate that scores at least the
- * start on `dims`, in `order`'s order. A stronger rung is on the ladder wherever cost puts it, and a weaker one
- * never is, so a climb never lands on a rung below the one it leaves.
+ * Spec 1.5 plan 24, "climb ladders only go up": the start (after a tie on equal scores goes to the quota with
+ * the most headroom), then every other candidate that scores at least the start on `dims`, in `order`'s order.
+ * A stronger rung is on the ladder wherever cost puts it, and a weaker one never is, so a climb never lands on
+ * a rung below the one it leaves.
  */
-function ladderFrom(start: Candidate, order: Candidate[], dims: Dim[]): Pick {
+function ladderFrom(
+  first: Candidate,
+  order: Candidate[],
+  dims: Dim[],
+  usage: Partial<Record<string, number>> = {},
+): Pick {
+  const { start, tie } = breakTie(first, order, dims, usage);
   const rest = order.filter((x) => x !== start && atLeast(x, start, dims));
-  return { rung: start.rung, ladder: [start, ...rest].map((x) => x.rung) };
+  return { rung: start.rung, ladder: [start, ...rest].map((x) => x.rung), ...(tie ? { tie } : {}) };
 }
 
 /**
@@ -123,7 +182,7 @@ export function defaultLadder(c: Catalog, p: RoutingProfile, role: Role): Pick {
   const all = candidates(c, { ...p, objective: "cost" }, role);
   if (all.length === 0) throw noRung(role);
   const start = all.find((x) => x.rung === p.role.defaultRung) ?? (all[0] as Candidate);
-  return ladderFrom(start, all, compareDims(start, {}));
+  return ladderFrom(start, all, compareDims(start, {}), p.usage);
 }
 
 /**
@@ -147,11 +206,11 @@ export const primaryDim = (kind: Kind): Dim =>
  * ladder above it is the other rungs at least as strong on the bar, weakest first on the kind's primary
  * dimension, cost breaking ties, so a lane never climbs onto a weaker rung. Ported from 0.x.
  */
-function speedLadder(start: Candidate, all: Candidate[], kind: Kind, dims: Dim[]): Pick {
+function speedLadder(start: Candidate, all: Candidate[], kind: Kind, dims: Dim[], p: RoutingProfile): Pick {
   const dim = primaryDim(kind);
   const strength = (x: Candidate) => x.scores[dim] ?? Number.NEGATIVE_INFINITY;
   const order = [...all].sort((a, b) => strength(a) - strength(b) || compareCost(a.cost, b.cost));
-  return ladderFrom(start, order, dims);
+  return ladderFrom(start, order, dims, p.usage);
 }
 
 /** The thresholds of `bar` a rung misses, each with its value: `agentic 0.0818 < 0.1077`. */
@@ -199,7 +258,9 @@ export function select(c: Catalog, p: RoutingProfile, role: Role, kind: Kind, di
   const first = all.find((x) => clearsBar(c, x, kind, difficulty));
   if (first) {
     const dims = compareDims(first, bar);
-    return p.objective === "speed" ? speedLadder(first, all, kind, dims) : ladderFrom(first, all, dims);
+    return p.objective === "speed"
+      ? speedLadder(first, all, kind, dims, p)
+      : ladderFrom(first, all, dims, p.usage);
   }
   const byCost = candidates(c, { ...p, objective: "cost" }, role, kind);
   const fallback = defaultLadder(c, p, role).rung;
@@ -211,5 +272,5 @@ export function select(c: Catalog, p: RoutingProfile, role: Role, kind: Kind, di
     if (atLeast(s, start, dims)) start = s;
     break;
   }
-  return { ...ladderFrom(start, byCost, dims), noClear: noClearLine(all, bar, kind, difficulty) };
+  return { ...ladderFrom(start, byCost, dims, p.usage), noClear: noClearLine(all, bar, kind, difficulty) };
 }
````

Edit `src/services/lane-service.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/lane-service.ts b/src/services/lane-service.ts
index d259658..6dfa0cd 100644
--- a/src/services/lane-service.ts
+++ b/src/services/lane-service.ts
@@ -2,6 +2,7 @@ import { existsSync, readFileSync } from "node:fs";
 import { relative, sep } from "node:path";
 import { CatherdError } from "../domain/errors.ts";
 import { assertId, ID_PATTERN, parseRung } from "../domain/ids.ts";
+import { quotaUsage } from "../domain/select.ts";
 import { assertLaneHeader, type Difficulty, type Kind } from "../domain/lane.ts";
 import type { Role } from "../domain/roles.ts";
 import { cell } from "../domain/util.ts";
@@ -100,6 +101,7 @@ export async function route(
     role: i.role,
     lane: lane?.lane ?? null,
     laneText: lane?.text ?? null,
+    usage: quotaUsage(readRecords(run).records.map((r) => r.rung)),
     spentFraction: Math.max(
       budgetOf(run, profile.budget, deps.now())?.fraction ?? 0,
       (await workspaceBudget(run, deps.now()))?.fraction ?? 0,
````

Edit `src/services/ports.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/ports.ts b/src/services/ports.ts
index a3b27b1..57fc2c4 100644
--- a/src/services/ports.ts
+++ b/src/services/ports.ts
@@ -82,6 +82,8 @@ export interface RouteRequest {
   lane: string | null;
   laneText: string | null;
   spentFraction: number;
+  /** spec 1.5 plan 24: the run's dispatches so far per quota, for a tie between rungs of equal scores */
+  usage?: Record<string, number>;
 }
 
 export interface RouteAnswer {
````

Edit `src/services/routing-service.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/routing-service.ts b/src/services/routing-service.ts
index 38950e5..2957e15 100644
--- a/src/services/routing-service.ts
+++ b/src/services/routing-service.ts
@@ -28,9 +28,15 @@ import type { ProfileView, RouteAnswer, RouteRequest, RoutingPort, Verdict } fro
 import { provenanceOf } from "./provenance.ts";
 import { runEvidence } from "./run-evidence.ts";
 
-function routingProfile(v: ProfileView, role: Role, spentFraction: number): RoutingProfile {
+function routingProfile(
+  v: ProfileView,
+  role: Role,
+  spentFraction: number,
+  usage: Record<string, number> = {},
+): RoutingProfile {
   const rc = v.roles[role];
   return {
+    usage,
     // spec §4.6: from 80 % of the budget on, start at the cheapest rung that clears the bar
     objective: spentFraction >= BUDGET_CHEAP_AT ? "cost" : v.objective,
     billing: v.billing,
@@ -86,7 +92,7 @@ async function freshenWithin(rungs: string[], repo: string, ms: number): Promise
  * usable rung never asks Jev.
  */
 async function route(req: RouteRequest, o: RoutingOpts): Promise<RouteAnswer> {
-  const p = routingProfile(req.profile, req.role, req.spentFraction);
+  const p = routingProfile(req.profile, req.role, req.spentFraction, req.usage);
   await freshenWithin(p.role.rungs, req.repo, o.discoveryBudgetMs ?? DISCOVERY_BUDGET_MS);
   const c = loadCatalog({ repo: req.repo });
   const fallback = () => defaultLadder(c, p, req.role);
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/domain/select.test.ts test/services/routing-service.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS.

- [ ] **Step 5: Commit**

````bash
git add src/domain/select.ts src/services/lane-service.ts src/services/ports.ts src/services/routing-service.ts test/domain/select.test.ts test/services/routing-service.test.ts
git commit -m "feat(routing): start a tie of equal scores on the quota with more headroom"
````

---

### Task 4: `profile validate` names a quota that never starts, what no worker rung reaches, and an unscored default's fallback (spec bullets 1, 2; minor silent `defaultRung` fallback; Rulings 3, 8, 9)

`validateProfile` gains `o: ValidateOptions = {}`. Every validation warns about a quota none of whose usable rungs starts any kind and difficulty (nor a lane-less route), trying each quota as the least used one so a tie it could win counts (`idleQuotas`), and an unscored `defaultRung`'s warning says what routing falls back to. With `{ reach: true }` (only `catherd profile validate` and the `profile_validate` tool, through `validateNamed`/`validateHere`), the worker gets one warning listing every kind and its difficulties no rung clears; it replaces plan 14's "blind kind" warning. A headroom tie stays within the start's cost tier: a metered rung never wins it over a plan's (`breakTie`).

**Interfaces:**
- Consumes: Task 3's `breakTie`, `RoutingProfile.usage`; Task 2's `select`, `defaultLadder`.
- Produces: `ValidateOptions { reach?: boolean }` (`src/domain/profile-rules.ts`); `validateProfile(p, c, backends, doc?, host?, o?)`; `validateHere(p, c, doc?, host?, o?)` and `validateNamed(name, repo, host, o?)` (`src/services/profile-store.ts`).

**Scratch commit:** `360183f` (feat(profile): warn about a quota that never starts and what no worker rung reaches).

**Files:**
- Modify: `src/domain/profile-rules.ts`
- Modify: `src/domain/select.ts`
- Modify: `src/entry/profile-command.ts`
- Modify: `src/services/profile-service.ts`
- Modify: `src/services/profile-store.ts`
- Modify: `test/domain/profile-rules.test.ts`
- Modify: `test/domain/select.test.ts`
- Modify: `test/entry/mcp-profile.test.ts`
- Modify: `test/entry/profile-command.test.ts`

- [ ] **Step 1: Write the failing tests**

Edit `test/domain/profile-rules.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/domain/profile-rules.test.ts b/test/domain/profile-rules.test.ts
index 9bfa61d..0e91c18 100644
--- a/test/domain/profile-rules.test.ts
+++ b/test/domain/profile-rules.test.ts
@@ -335,3 +335,85 @@ it("rejects native Claude on Codex including reachable failover without converti
   });
   expect(p.failover[rung]).toBe("claude:claude-opus-5-5#low");
 });
+
+describe("validateProfile: what a role can never start or reach (spec 1.5 plan 24)", () => {
+  const LUNA = "codex:gpt-6-luna#high";
+  const SOL = "codex:gpt-6-sol#medium";
+  const GO_KIMI = "opencode:opencode-go/kimi-k3#default";
+  /** Kimi treated like Sol medium: on its subscription it ties Sol, metered it is never first */
+  const c = () =>
+    catalog({
+      override: {
+        schema: 1,
+        treatLike: { "opencode-go/kimi-k3#default": "gpt-6-sol#medium" },
+        scores: [],
+        bars: {},
+      },
+    });
+  const explicit = (patch: ProfilePatch = {}) =>
+    validateProfile(
+      resolveProfile(applyPatch(defaultProfileDoc(), patch), "p", "claude-code"),
+      catalog(),
+      BACKENDS,
+      undefined,
+      "claude-code",
+      { reach: true },
+    );
+
+  it("warns about a quota none of whose rungs ever starts a lane", () => {
+    const v = check(
+      {
+        billing: { "opencode-go": "metered" },
+        roles: { worker: { rungs: [LUNA, SOL, GO_KIMI], defaultRung: SOL } },
+      },
+      c(),
+    );
+    expect(v.warnings).toContainEqual({
+      path: "roles.worker.rungs",
+      message: `opencode-go never starts a worker lane: ${GO_KIMI} runs only on a climb, since another rung starts every lane`,
+      fix: "check billing.opencode-go (a metered rung starts only where nothing paid from a plan clears the bar), or order roles.worker.rungs so its rungs come first among equals",
+    });
+  });
+
+  it("counts a quota that wins a tie on headroom as one that starts", () => {
+    const v = check({ roles: { worker: { rungs: [LUNA, SOL, GO_KIMI], defaultRung: SOL } } }, c());
+    expect(messages(v.warnings).some((m) => m.includes("never starts"))).toBe(false);
+  });
+
+  it("names what an unscored default rung falls back to", () => {
+    const nobody = "opencode:opencode-go/nobody-1#default";
+    const v = check({ roles: { worker: { rungs: [LUNA, SOL, nobody], defaultRung: nobody } } });
+    expect(messages(v.warnings)).toContain(
+      `${nobody} is unscored and no rung is near enough to stand in for it: routing skips it; it is the worker's default rung, so routing falls back to ${LUNA}`,
+    );
+  });
+
+  it("lists, on an explicit validate only, every kind and difficulty no worker rung clears", () => {
+    expect(explicit().warnings).toEqual([
+      {
+        path: "roles.worker.rungs",
+        message:
+          "no worker rung clears repo_code logic, hard; terminal build, logic, hard; ui logic, hard; prose logic, hard; research logic, hard: those lanes start at the default rung and climb only onto rungs at least as strong (route names the closest)",
+      },
+    ]);
+    // a save, doctor and the TUI validate without it: the default profile stays clean there
+    expect(check().warnings).toEqual([]);
+    // Astra medium (Terminal-Bench 57.9, agentic 0.1031) reaches every bar but the hard ones of three kinds
+    const astra = explicit({
+      roles: {
+        worker: {
+          rungs: [
+            "codex:gpt-6-luna#high",
+            "codex:gpt-6-sol#medium",
+            "codex:gpt-6-sol#high",
+            "codex:gpt-6-sol#xhigh",
+            "codex:gpt-6-astra#medium",
+          ],
+        },
+      },
+    });
+    expect(messages(astra.warnings).find((m) => m.startsWith("no worker rung clears"))).toBe(
+      "no worker rung clears repo_code hard; terminal hard; ui hard: those lanes start at the default rung and climb only onto rungs at least as strong (route names the closest)",
+    );
+  });
+});
````

Edit `test/domain/select.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/domain/select.test.ts b/test/domain/select.test.ts
index 3ed108c..2ef1545 100644
--- a/test/domain/select.test.ts
+++ b/test/domain/select.test.ts
@@ -318,6 +318,13 @@ describe("equal scores go to the quota with more headroom (spec 1.5 plan 24)", (
     ).toBe(DEEPSEEK);
   });
 
+  it("never gives a tie to a metered rung over one paid from a plan", () => {
+    const p = worker({ billing: { "opencode-go": "metered" }, usage: { codex: 9 } }, rungs);
+    const pick = select(c(), p, "worker", "repo_code", "copy");
+    expect(pick.rung).toBe(LUNA_HIGH);
+    expect(pick.tie).toBeUndefined();
+  });
+
   it("leaves a start with no equal alone", () => {
     expect(select(shipped(), worker(), "worker", "repo_code", "copy").tie).toBeUndefined();
   });
````

Edit `test/entry/mcp-profile.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/entry/mcp-profile.test.ts b/test/entry/mcp-profile.test.ts
index 5ca09bd..d4850e7 100644
--- a/test/entry/mcp-profile.test.ts
+++ b/test/entry/mcp-profile.test.ts
@@ -79,6 +79,11 @@ describe("the profile tools on the profile service", () => {
           path: "roles.verifier.access",
           message: "verifier runs read-only; catherd's default for it is full",
         },
+        // spec 1.5 plan 24: an explicit validate also names what no worker rung clears
+        {
+          path: "roles.worker.rungs",
+          message: expect.stringMatching(/^no worker rung clears repo_code logic, hard;/),
+        },
       ],
     });
   });
````

Edit `test/entry/profile-command.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/entry/profile-command.test.ts b/test/entry/profile-command.test.ts
index ce9535f..2ea9bd2 100644
--- a/test/entry/profile-command.test.ts
+++ b/test/entry/profile-command.test.ts
@@ -216,7 +216,7 @@ describe("catherd profile use, new, copy, rm, list, diff", () => {
     expect(getProfile("fast", "claude-code").budget.minutes).toBe(7);
     expect(getProfile("default", "claude-code").budget.minutes).toBeUndefined();
     expect(catherd(["diff", "default"], repo).out).toBe("budget.minutes: 7 → none\n");
-    expect(catherd(["validate"], repo).out).toBe("✓ valid\n");
+    expect(catherd(["validate"], repo).out).toStartWith("! roles.worker.rungs: no worker rung clears ");
   });
 });
 
@@ -264,7 +264,12 @@ describe("names the user types, and unbinding", () => {
 describe("catherd profile validate", () => {
   it("prints errors and warnings, and exits 1 on an error", () => {
     withHome();
-    expect(catherd(["validate"])).toEqual({ code: 0, out: "✓ valid\n", err: "" });
+    // spec 1.5 plan 24: the default worker reaches no logic or hard bar, which only validate says
+    expect(catherd(["validate"])).toEqual({
+      code: 0,
+      out: "! roles.worker.rungs: no worker rung clears repo_code logic, hard; terminal build, logic, hard; ui logic, hard; prose logic, hard; research logic, hard: those lanes start at the default rung and climb only onto rungs at least as strong (route names the closest)\n",
+      err: "",
+    });
     mkdirSync(profilesDir(), { recursive: true });
     const doc = JSON.parse(readFileSync(join(SRC, "..", "test", "fixtures", "profiles", "bad.json"), "utf8"));
     writeFileSync(join(profilesDir(), "bad.json"), JSON.stringify(doc));
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/domain/profile-rules.test.ts test/domain/select.test.ts test/entry/mcp-profile.test.ts test/entry/profile-command.test.ts`
Expected: FAIL: no "never starts" warning for the metered Go rung; the explicit validate has no "no worker rung clears" warning (and `validateProfile` takes no options); the unscored default rung's warning names no fallback; a metered DeepSeek wins the tie over Luna; `catherd profile validate` on the default profile still prints `✓ valid`.

- [ ] **Step 3: Implement**

Edit `src/domain/profile-rules.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/profile-rules.ts b/src/domain/profile-rules.ts
index 7ce862f..7254830 100644
--- a/src/domain/profile-rules.ts
+++ b/src/domain/profile-rules.ts
@@ -21,10 +21,25 @@ import { tryParseRung } from "./ids.ts";
 import { DIFFICULTIES, KINDS } from "./lane.ts";
 import { type Profile, type ProfileDoc, unknownValues } from "./profile.ts";
 import { DEFAULT_ACCESS, ROLES, type Role } from "./roles.ts";
-import { candidates, clearsBar, type RoutingProfile } from "./select.ts";
+import {
+  type Candidate,
+  candidates,
+  clearsBar,
+  defaultLadder,
+  type RoutingProfile,
+  select,
+} from "./select.ts";
 
 export { quotaOf };
 
+/**
+ * `reach`: also warn about the kinds and difficulties no worker rung clears (spec 1.5 plan 24), which only an
+ * explicit `profile validate` asks for.
+ */
+export interface ValidateOptions {
+  reach?: boolean;
+}
+
 /** One finding of `validate`: where in the profile, what is wrong, and the action that fixes it. */
 export interface Issue {
   path: string;
@@ -147,6 +162,7 @@ export function validateProfile(
   backends: readonly string[],
   doc?: ProfileDoc,
   host: OrchestrationHost = "unknown",
+  o: ValidateOptions = {},
 ): Validation {
   const errors: Issue[] = [];
   const warnings: Issue[] = [];
@@ -218,7 +234,7 @@ export function validateProfile(
       if (!scoresOf(c, info.canonical))
         warnings.push({
           path: `${at}.rungs`,
-          message: `${rung} is unscored and no rung is near enough to stand in for it: routing skips it`,
+          message: `${rung} is unscored and no rung is near enough to stand in for it: routing skips it${rung === rc.defaultRung ? `; it is the ${role}'s default rung, so ${defaultFallback(c, p, role)}` : ""}`,
           fix: TREAT_LIKE_FIX(rung),
         });
     }
@@ -257,15 +273,26 @@ export function validateProfile(
             path: `${at}.rungs`,
             message: `${x.rung} clears no routing bar, so a lane starts on it only as the role's default rung and never climbs onto it`,
           });
-    // spec 1.2 §5.2: the logic and hard bars sit at the 60th and 75th percentiles, which a cost-minded ladder
-    // may never reach, and those lanes start at the default rung and climb; only a kind whose every bar the
-    // ladder misses routes blind (plan 14 Ruling 12)
-    if (role === "worker" && usable.length > 1) {
-      const blind = KINDS.filter((k) => !DIFFICULTIES.some((d) => usable.some((x) => clearsBar(c, x, k, d))));
-      if (blind.length)
+    // spec 1.5 plan 24: every kind and difficulty no worker rung clears, in one warning; those lanes start at the
+    // default rung (or an easier difficulty's start) and climb only onto rungs at least as strong. Only an
+    // explicit validate says it (Ruling 3): the shipped bars put logic and hard above every Sol rung, the
+    // owner's call, so every save and doctor would repeat it
+    if (o.reach && role === "worker" && usable.length > 1) {
+      const unreached = unreachable(c, usable);
+      if (unreached.length)
         warnings.push({
           path: `${at}.rungs`,
-          message: `no worker rung clears any bar for ${blind.join(", ")}; those lanes always start at the default rung`,
+          message: `no worker rung clears ${unreached.join("; ")}: those lanes start at the default rung and climb only onto rungs at least as strong (route names the closest)`,
+        });
+    }
+    // spec 1.5 plan 24: a quota whose rungs never start a lane sits idle but for climbs (the identity run's Go)
+    if (usable.length > 1) {
+      const idle = idleQuotas(c, p, role, usable);
+      for (const [q, rungs] of idle)
+        warnings.push({
+          path: `${at}.rungs`,
+          message: `${q} never starts a ${role} lane: ${rungs.join(", ")} ${rungs.length > 1 ? "run" : "runs"} only on a climb, since another rung starts every lane`,
+          fix: `check billing.${q} (a metered rung starts only where nothing paid from a plan clears the bar), or order ${at}.rungs so its rungs come first among equals`,
         });
     }
   }
@@ -334,6 +361,44 @@ export function validateProfile(
   return { errors, warnings };
 }
 
+/** The role's default rung when it is unscored: what routing starts on instead. */
+function defaultFallback(c: Catalog, p: Profile, role: Role): string {
+  try {
+    return `routing falls back to ${defaultLadder(c, routingProfileOf(p, role), role).rung}`;
+  } catch {
+    return "routing has no rung to fall back to";
+  }
+}
+
+/** `repo_code logic, hard` per kind: the kinds and difficulties no rung of `usable` clears. */
+function unreachable(c: Catalog, usable: Candidate[]): string[] {
+  return KINDS.flatMap((k) => {
+    const ds = DIFFICULTIES.filter((d) => !usable.some((x) => clearsBar(c, x, k, d)));
+    return ds.length ? [`${k} ${ds.join(", ")}`] : [];
+  });
+}
+
+/**
+ * Spec 1.5 plan 24: each quota of the role's usable rungs that no kind and difficulty (nor a lane-less route)
+ * ever starts on, whichever quota the run has used least, with its rungs.
+ */
+function idleQuotas(c: Catalog, p: Profile, role: Role, usable: Candidate[]): [string, string[]][] {
+  const quotas = [...new Set(usable.map((x) => quotaOf(x.info.parsed)))];
+  if (quotas.length < 2) return [];
+  const starts = new Set<string>();
+  // every quota gets its turn as the least used, so a tie it could win counts as a start
+  for (const fresh of [null, ...quotas]) {
+    const usage = Object.fromEntries(quotas.map((q) => [q, q === fresh ? 0 : 1]));
+    const rp = { ...routingProfileOf(p, role), usage };
+    starts.add(defaultLadder(c, rp, role).rung);
+    for (const k of KINDS) for (const d of DIFFICULTIES) starts.add(select(c, rp, role, k, d).rung);
+  }
+  const started = new Set(usable.filter((x) => starts.has(x.rung)).map((x) => quotaOf(x.info.parsed)));
+  return quotas
+    .filter((q) => !started.has(q))
+    .map((q) => [q, usable.filter((x) => quotaOf(x.info.parsed) === q).map((x) => x.rung)]);
+}
+
 export function nativeClaudeIssue(rung: string, host: OrchestrationHost, path: string): Issue | null {
   const r = tryParseRung(rung);
   return host !== "claude-code" && r?.backend === "claude"
````

Edit `src/domain/select.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/select.ts b/src/domain/select.ts
index f26f39a..d925846 100644
--- a/src/domain/select.ts
+++ b/src/domain/select.ts
@@ -132,7 +132,7 @@ const quota = (x: Candidate): string => quotaOf(x.info.parsed);
  * Spec 1.5 plan 24: when rungs on other quotas score exactly as `start` does on `dims`, the start goes to the
  * quota with the most headroom (the fewest of the run's dispatches so far), the candidates' order (cost, then
  * the profile's ladder order) breaking an equal count. `tie` says what decided. Rungs of one quota that tie
- * are no tie: cost already orders them.
+ * are no tie (cost already orders them), nor is a rung of another cost tier.
  */
 function breakTie(
   start: Candidate,
@@ -140,7 +140,11 @@ function breakTie(
   dims: Dim[],
   usage: Partial<Record<string, number>>,
 ): { start: Candidate; tie?: string } {
-  const rivals = order.filter((x) => x !== start && quota(x) !== quota(start) && same(x, start, dims));
+  // a metered rung never wins a tie over a plan's: headroom is free only within the start's cost tier
+  const rivals = order.filter(
+    (x) =>
+      x !== start && quota(x) !== quota(start) && x.cost.tier === start.cost.tier && same(x, start, dims),
+  );
   if (rivals.length === 0) return { start };
   const used = (x: Candidate) => usage[quota(x)] ?? 0;
   const tied = [start, ...rivals];
````

Edit `src/entry/profile-command.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/profile-command.ts b/src/entry/profile-command.ts
index ce3709d..2422007 100644
--- a/src/entry/profile-command.ts
+++ b/src/entry/profile-command.ts
@@ -342,6 +342,7 @@ const validate = defineCommand({
       args.name === undefined ? activeName(repo) : requireProfile(args.name),
       repo,
       terminalHost(args.host).host,
+      { reach: true },
     );
     if (args.json) printJson({ valid: v.errors.length === 0, ...v });
     else if (v.errors.length === 0 && v.warnings.length === 0) console.log(`${mark("ok")} valid`);
````

Edit `src/services/profile-service.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/profile-service.ts b/src/services/profile-service.ts
index 9dc6a40..32d1784 100644
--- a/src/services/profile-service.ts
+++ b/src/services/profile-service.ts
@@ -333,6 +333,7 @@ export function profileService(host: () => HostContext): ProfilePort {
         name === undefined ? activeName(repo) : requireProfile(name),
         repo,
         host().host,
+        { reach: true },
       );
       return { valid: v.errors.length === 0, ...v };
     },
````

Edit `src/services/profile-store.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/profile-store.ts b/src/services/profile-store.ts
index b906d1b..7e62409 100644
--- a/src/services/profile-store.ts
+++ b/src/services/profile-store.ts
@@ -15,7 +15,12 @@ import {
   ProfileDocSchema,
   resolveProfile,
 } from "../domain/profile.ts";
-import { type Issue, type Validation, validateProfile } from "../domain/profile-rules.ts";
+import {
+  type Issue,
+  type ValidateOptions,
+  type Validation,
+  validateProfile,
+} from "../domain/profile-rules.ts";
 import type { Catalog } from "../domain/catalog.ts";
 import type { Access } from "../domain/record.ts";
 import { ROLES, type Role } from "../domain/roles.ts";
@@ -220,8 +225,9 @@ export function validateHere(
   c: Catalog,
   doc?: ProfileDoc,
   host: OrchestrationHost = "unknown",
+  o: ValidateOptions = {},
 ): Validation {
-  const v = validateProfile(p, c, runnableBackends(), doc, host);
+  const v = validateProfile(p, c, runnableBackends(), doc, host, o);
   return {
     errors: [...v.errors, ...isolationKeyErrors(p), ...isolatedOnlyErrors(p)],
     warnings: [...v.warnings, ...budgetUsdWarnings(p)],
@@ -233,12 +239,13 @@ export function validateNamed(
   name: string | undefined,
   repo: string | null,
   host: OrchestrationHost,
+  o: ValidateOptions = {},
 ): Validation {
   const n = name ?? activeName(repo);
   const doc = readProfileDoc(n);
   const catalog = loadCatalog({ timings: false, ...(repo === null ? {} : { repo }) });
   try {
-    return validateHere(resolveProfile(doc, n, host), catalog, doc, host);
+    return validateHere(resolveProfile(doc, n, host), catalog, doc, host, o);
   } catch (e) {
     if (!(e instanceof CatherdError)) throw e;
     return { errors: [{ path: "roles", message: e.message, fix: e.fix }], warnings: [] };
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/domain/profile-rules.test.ts test/domain/select.test.ts test/entry/mcp-profile.test.ts test/entry/profile-command.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS.

- [ ] **Step 5: Commit**

````bash
git add src/domain/profile-rules.ts src/domain/select.ts src/entry/profile-command.ts src/services/profile-service.ts src/services/profile-store.ts test/domain/profile-rules.test.ts test/domain/select.test.ts test/entry/mcp-profile.test.ts test/entry/profile-command.test.ts
git commit -m "feat(profile): warn about a quota that never starts and what no worker rung reaches"
````

---

### Task 5: Every role's decision in `routes.jsonl`, a declared header wins, and `route` returns little (spec bullets 3, 4, 5, 6; minors "your override", evidence guarded, `valueWords`; Rulings 10, 11)

The routing service decides on the lane's header when it declares both `Kind:` and `Difficulty:`, then Jev's track, then Jev's kind (`jev-kind`, the lane's `Kind:` first), then the default; `jevSaid` says `Jev said <kind>/<difficulty>` where Jev disagreed. `RouteAnswer` gains `jevSaid`, `noClear`, `tie` and `why` (one line: the source and kind/difficulty, Jev's disagreement, the start rule or `noClear`, the tie). Evidence is read through `evidenceOrNone` (null on error) and `measuredSecs` skips a run it cannot read; a threshold the user's override set says `your override` (`Catalog.userBars`); `valueWords` is gone. The lane service records every decision: a lane's `route` row gains `why`, `jevSaid`, `noClear`, `tie` and `provenance`; a lane-less route writes a `RoleRouteRow` (`lane: null`); `readRoutes` returns lane route and climb rows only, `readRoleRoutes` the role rows. `route` returns `{ lane, role, rung, ladder, backend, agent, why }`. The `route` tool's description and the skill's tool row say so.

**Interfaces:**
- Consumes: Task 2's `Pick.noClear`, Task 3's `Pick.tie`.
- Produces: `RouteAnswer.{ jevSaid: string | null; noClear?: string; tie?: string; why: string }` (`ports.ts`); `RouteRow.{ why?, jevSaid?, noClear?, tie?, provenance? }` and `RoleRouteRow` (`src/domain/route.ts`); `readRoleRoutes(run): RoleRouteRow[]`, `appendRoute(run, row: RouteRow | RoleRouteRow)` (`run-store.ts`); `RouteResult = { lane, role, rung, ladder, backend, agent, why }` (`lane-service.ts`); `Catalog.userBars?: string[]`; `Provenance.evidence: {…} | null`. Test fakes of `RoutingPort.route` return `jevSaid` and `why`.

**Scratch commit:** `cebede7` (feat(routing): record every role's decision and return route's rung, ladder and why).

**Files:**
- Modify: `plugin/skills/catherd/SKILL.md`
- Modify: `src/domain/catalog.ts`
- Modify: `src/domain/route.ts`
- Modify: `src/entry/mcp/lane-tools.ts`
- Modify: `src/services/catalog-service.ts`
- Modify: `src/services/lane-service.ts`
- Modify: `src/services/ports.ts`
- Modify: `src/services/provenance.ts`
- Modify: `src/services/routing-service.ts`
- Modify: `src/services/run-store.ts`
- Modify: `test/integration/mcp-stdio.test.ts`
- Modify: `test/services/dispatch-protocol.test.ts`
- Modify: `test/services/helpers.ts`
- Modify: `test/services/outcomes.test.ts`
- Create: `test/services/route-records.test.ts`
- Modify: `test/services/routing-service.test.ts`

- [ ] **Step 1: Write the failing tests**

Edit `test/integration/mcp-stdio.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/integration/mcp-stdio.test.ts b/test/integration/mcp-stdio.test.ts
index f098e85..0eac8da 100644
--- a/test/integration/mcp-stdio.test.ts
+++ b/test/integration/mcp-stdio.test.ts
@@ -172,7 +172,20 @@ describe("catherd mcp over stdio, on the Codex simulator", () => {
 
       // route: no Jev key, so the lane file's Kind/Difficulty decide: Track A.
       const routed = await call(c, "route", { run, lane_file: "lanes/M1.L1.md" });
-      expect(routed.data).toMatchObject({ source: "lane", rung: "codex:gpt-6-luna#high", backend: "codex" });
+      expect(routed.data).toMatchObject({
+        rung: "codex:gpt-6-luna#high",
+        backend: "codex",
+        why: expect.stringMatching(/^the lane's Kind\/Difficulty, repo_code\/build/),
+      });
+      expect(Object.keys(routed.data).sort()).toEqual([
+        "agent",
+        "backend",
+        "ladder",
+        "lane",
+        "role",
+        "rung",
+        "why",
+      ]);
 
       // preflight: M1.L1 checks a file it creates; M1.L2's check runs and fails as expected.
       const pre = await call(c, "preflight", { run });
````

Edit `test/services/dispatch-protocol.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/dispatch-protocol.test.ts b/test/services/dispatch-protocol.test.ts
index 33f671e..68a34cc 100644
--- a/test/services/dispatch-protocol.test.ts
+++ b/test/services/dispatch-protocol.test.ts
@@ -93,6 +93,8 @@ describe("dispatch routes an unrouted lane first (spec 1.1 §6)", () => {
       difficulty: "logic",
       questionSet: null,
       jev: null,
+      jevSaid: null,
+      why: "the lane's Kind/Difficulty, repo_code/logic",
     });
     const s = await dispatch(deps, {
       run: run.id,
````

Edit `test/services/helpers.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/helpers.ts b/test/services/helpers.ts
index 53e6fbf..53f30ed 100644
--- a/test/services/helpers.ts
+++ b/test/services/helpers.ts
@@ -66,6 +66,8 @@ export function fakeDeps(
         difficulty: null,
         questionSet: null,
         jev: null,
+        jevSaid: null,
+        why: "the role's default rung",
       };
     },
     finding: async (_runDir, _laneText, _finding, _use) => ({
````

Edit `test/services/outcomes.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/outcomes.test.ts b/test/services/outcomes.test.ts
index 13776a9..c766d43 100644
--- a/test/services/outcomes.test.ts
+++ b/test/services/outcomes.test.ts
@@ -24,6 +24,8 @@ function jevDeps() {
     difficulty: "build",
     questionSet: "route-v2#0123abcd",
     jev: JEV,
+    jevSaid: null,
+    why: "Jev: repo_code/build",
   });
   return deps;
 }
@@ -38,11 +40,21 @@ describe("outcomes.jsonl (spec §5.6)", () => {
     const { run } = freshRun();
     writeLane(run, "M1.L1", ["src/a.ts"]);
     const r = await route(jevDeps(), { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
-    expect(r).toMatchObject({ questionSet: "route-v2#0123abcd", jev: JEV });
+    // spec 1.5 plan 24: route returns little; Jev's answer stays in routes.jsonl
+    expect(r).toEqual({
+      lane: "M1.L1",
+      role: "worker",
+      rung: LADDER[0] as string,
+      ladder: LADDER,
+      backend: "codex",
+      agent: null,
+      why: "Jev: repo_code/build",
+    });
     expect(readRoutes(run)[0]).toMatchObject({
       decidedBy: "jev",
       questionSet: "route-v2#0123abcd",
       jev: JEV,
+      why: "Jev: repo_code/build",
     });
   });
 
````

Create `test/services/route-records.test.ts` (new file):

````diff
diff --git a/test/services/route-records.test.ts b/test/services/route-records.test.ts
new file mode 100644
index 0000000..12508f8
--- /dev/null
+++ b/test/services/route-records.test.ts
@@ -0,0 +1,70 @@
+import { afterEach, describe, expect, it } from "bun:test";
+import { route } from "../../src/services/lane-service.ts";
+import { readRoleRoutes, readRoutes } from "../../src/services/run-store.ts";
+import { snapshotEnv } from "../helpers.ts";
+import { fakeDeps, freshRun, LADDER, writeLane } from "./helpers.ts";
+
+afterEach(snapshotEnv());
+
+describe("every role's decision in routes.jsonl (spec 1.5 plan 24)", () => {
+  it("records a role routed without a lane, with its source, ladder and why, apart from the lanes", async () => {
+    const { run } = freshRun();
+    const deps = fakeDeps();
+    const r = await route(deps, { run: run.id, role: "worker" });
+    expect(r).toEqual({
+      lane: null,
+      role: "worker",
+      rung: LADDER[0] as string,
+      ladder: LADDER,
+      backend: "codex",
+      agent: null,
+      why: "the role's default rung",
+    });
+    expect(readRoleRoutes(run)).toEqual([
+      {
+        at: expect.any(String),
+        lane: null,
+        role: "worker",
+        name: null,
+        rung: LADDER[0] as string,
+        ladder: LADDER,
+        source: "route",
+        decidedBy: "default",
+        why: "the role's default rung",
+      },
+    ]);
+    // a role's row has no lane to climb: the lane readers never see it
+    expect(readRoutes(run)).toEqual([]);
+  });
+
+  it("keeps a lane route's provenance, Jev's disagreement, a no-clear line and a tie in its row", async () => {
+    const { run } = freshRun();
+    const deps = fakeDeps();
+    deps.routing.route = async () => ({
+      rung: LADDER[1] as string,
+      ladder: LADDER.slice(1),
+      source: "lane",
+      kind: "repo_code",
+      difficulty: "hard",
+      questionSet: "route-v2#0123abcd",
+      jev: null,
+      jevSaid: "Jev said repo_code/build",
+      noClear: "no rung clears repo_code/hard; best is codex:gpt-6-sol#xhigh (repo_code 66.6 < 70.9)",
+      tie: "tie on repo_code with x: started on y; equal headroom",
+      why: "the lane's Kind/Difficulty, repo_code/hard; Jev said repo_code/build",
+      provenance: { rung: LADDER[1] as string } as never,
+    });
+    writeLane(run, "M1.L1", ["src/a.ts"]);
+    const r = await route(deps, { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
+    expect(r.why).toBe("the lane's Kind/Difficulty, repo_code/hard; Jev said repo_code/build");
+    expect(readRoutes(run)[0]).toMatchObject({
+      lane: "M1.L1",
+      decidedBy: "lane",
+      jevSaid: "Jev said repo_code/build",
+      noClear: expect.stringMatching(/^no rung clears repo_code\/hard; best is /),
+      tie: expect.stringMatching(/^tie on repo_code/),
+      provenance: { rung: LADDER[1] },
+    });
+    expect(readRoleRoutes(run)).toEqual([]);
+  });
+});
````

Edit `test/services/routing-service.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/routing-service.test.ts b/test/services/routing-service.test.ts
index 1f82a1a..69024df 100644
--- a/test/services/routing-service.test.ts
+++ b/test/services/routing-service.test.ts
@@ -1,18 +1,22 @@
 import { afterEach, beforeEach, describe, expect, it } from "bun:test";
-import { mkdtempSync, readFileSync } from "node:fs";
+import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
 import { join } from "node:path";
 import type { BackendAdapter } from "../../src/adapters/backend.ts";
 import { writeDiscovery } from "../../src/adapters/discovery.ts";
 import { adapterFor, registerAdapter } from "../../src/adapters/registry.ts";
 import { readJsonl } from "../../src/infra/store.ts";
-import { resetFreshen } from "../../src/services/catalog-service.ts";
+import { overridePath, resetFreshen } from "../../src/services/catalog-service.ts";
+import { runPaths } from "../../src/services/run-store.ts";
 import type { JevRow } from "../../src/services/jev-service.ts";
 import type { ProfileView, RouteRequest } from "../../src/services/ports.ts";
 import { profileService } from "../../src/services/profile-service.ts";
 import { routingService } from "../../src/services/routing-service.ts";
 import { fakeFetch } from "../fake-fetch.ts";
 import { snapshotEnv, withHome } from "../helpers.ts";
-import { LADDER, testView } from "./helpers.ts";
+import { freshRun, LADDER, testView } from "./helpers.ts";
+
+/** the PATH a real run needs (it is a repository); beforeEach takes every CLI off PATH */
+const PATH_AT_LOAD = process.env.PATH;
 
 afterEach(snapshotEnv());
 beforeEach(() => {
@@ -88,6 +92,8 @@ describe("route without Jev", () => {
       difficulty: "build",
       questionSet: null,
       jev: null,
+      jevSaid: null,
+      why: "the lane's Kind/Difficulty, repo_code/build; the first rung in objective order that clears it",
       provenance: expect.objectContaining({ rung: TRACK_A.rung }),
     });
     expect(jevRows(r.runDir)).toEqual([
@@ -178,6 +184,30 @@ describe("route's provenance (spec 1.2 §5.3)", () => {
     ]);
   });
 
+  it("says a threshold is the user's override, not the default's why (1.2 minor)", async () => {
+    mkdirSync(join(overridePath(), ".."), { recursive: true });
+    writeFileSync(
+      overridePath(),
+      JSON.stringify({ schema: 1, bars: { repo_code: { build: { repo_code: 60 } } } }),
+    );
+    const a = await routingService().route(req(lane("repo_code", "build")));
+    expect(a.provenance?.thresholds).toEqual([
+      expect.objectContaining({ dim: "repo_code", min: 60, why: "your override" }),
+    ]);
+  });
+
+  it("routes with no evidence when a run on this machine cannot be read (1.2 minor)", async () => {
+    process.env.PATH = PATH_AT_LOAD;
+    const { run } = freshRun();
+    process.env.PATH = "/nonexistent";
+    // a routes.jsonl that is a directory: reading it throws
+    rmSync(runPaths(run.dir).routes, { force: true });
+    mkdirSync(runPaths(run.dir).routes);
+    const a = await routingService().route(req(lane("repo_code", "build")));
+    expect(a.rung).toBe(TRACK_A.rung);
+    expect(a.provenance?.evidence).toBeNull();
+  });
+
   it("shows the default rung's values with no thresholds when the route reads no bar", async () => {
     const a = await routingService().route(req(null));
     expect(a.source).toBe("default");
@@ -187,7 +217,7 @@ describe("route's provenance (spec 1.2 §5.3)", () => {
 });
 
 describe("route with Jev", () => {
-  it("takes a confident track over the lane's declaration, and logs the decision but never the lane", async () => {
+  it("keeps the lane's declaration over a confident track, says Jev disagreed, and logs it but never the lane", async () => {
     const f = fakeFetch({
       status: 200,
       body: fx("route-v2-track-b.json"),
@@ -201,7 +231,17 @@ describe("route with Jev", () => {
       ),
     );
     const a = await routingService({ key: "k", fetchImpl: f.impl, ...noWait }).route(r);
-    expect(a).toMatchObject({ ...TRACK_B, source: "jev", kind: "repo_code", difficulty: "hard" });
+    // spec 1.5 plan 24: a declared header wins; the route says where Jev disagreed
+    expect(a).toMatchObject({
+      ...TRACK_A,
+      source: "lane",
+      kind: "repo_code",
+      difficulty: "build",
+      jevSaid: "Jev said repo_code/hard",
+    });
+    expect(a.why).toBe(
+      "the lane's Kind/Difficulty, repo_code/build; Jev said repo_code/hard; the first rung in objective order that clears it",
+    );
     expect(a.questionSet).toMatch(/^route-v2#[0-9a-f]{8}$/);
     expect(a.jev).toMatchObject({ pA: 0.05, pB: 0.95, pKind: 0.96, nouls: { unclear_cause: 0.88 } });
     const sent = JSON.stringify(f.sent[0]?.body);
@@ -211,7 +251,7 @@ describe("route with Jev", () => {
     expect(sent).not.toContain("drainAll");
     const [row] = jevRows(r.runDir);
     expect(row).toMatchObject({
-      source: "jev",
+      source: "lane",
       requestId: "req_1",
       model: "jev-1.13.0",
       why: "P(B) 0.95 ≥ 0.8",
@@ -227,20 +267,40 @@ describe("route with Jev", () => {
     expect(jevRows(r.runDir)[0]?.why).toBe("P(A) 0.55, P(B) 0.45: both below 0.8");
   });
 
-  it("keeps a sure kind in the dead band, with the lane's Difficulty", async () => {
+  it("keeps the lane's Kind over a sure kind in the dead band, and says Jev's", async () => {
     const f = fakeFetch({ status: 200, body: fx("route-v2-kind-only.json") });
     const r = req(lane("prose", "build"));
     const a = await routingService({ key: "k", fetchImpl: f.impl, ...noWait }).route(r);
-    expect(a).toMatchObject({ ...TRACK_A, source: "jev-kind", kind: "repo_code", difficulty: "build" });
-    expect(jevRows(r.runDir)[0]).toMatchObject({ source: "jev-kind", used: `worker ${TRACK_A.rung}` });
+    expect(a).toMatchObject({
+      ...TRACK_A,
+      source: "lane",
+      kind: "prose",
+      difficulty: "build",
+      jevSaid: "Jev said repo_code/no sure difficulty",
+    });
+    expect(jevRows(r.runDir)[0]).toMatchObject({ source: "lane", used: `worker ${TRACK_A.rung}` });
+  });
+
+  it("keeps a sure kind in the dead band when the lane declares only its Difficulty", async () => {
+    const f = fakeFetch({ status: 200, body: fx("route-v2-kind-only.json") });
+    const r = req(lane(null, "build"));
+    const a = await routingService({ key: "k", fetchImpl: f.impl, ...noWait }).route(r);
+    expect(a).toMatchObject({
+      ...TRACK_A,
+      source: "jev-kind",
+      kind: "repo_code",
+      difficulty: "build",
+      jevSaid: null,
+    });
   });
 
   it("keeps a sure kind in the dead band without a Difficulty line, at the default rung's difficulty", async () => {
     const f = fakeFetch({ status: 200, body: fx("route-v2-kind-only.json") });
     const r = req(lane("prose", null));
     const a = await routingService({ key: "k", fetchImpl: f.impl, ...noWait }).route(r);
-    // the default rung, gpt-6-sol#medium, clears no repo_code bar: the default difficulty is build
-    expect(a).toMatchObject({ ...TRACK_A, source: "jev-kind", kind: "repo_code", difficulty: "build" });
+    // the lane's Kind wins; the default rung, gpt-6-sol#medium, clears no prose bar: the default difficulty is build
+    expect(a).toMatchObject({ ...TRACK_A, source: "jev-kind", kind: "prose", difficulty: "build" });
+    expect(a.jevSaid).toBe("Jev said repo_code/no sure difficulty");
     expect(jevRows(r.runDir)[0]?.source).toBe("jev-kind");
   });
 
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/integration/mcp-stdio.test.ts test/services/dispatch-protocol.test.ts test/services/outcomes.test.ts test/services/route-records.test.ts test/services/routing-service.test.ts`
Expected: FAIL: `readRoleRoutes` is not exported by `src/services/run-store.ts`; `route` still returns `source`, `kind`, `difficulty`, `questionSet`, `jev` and `provenance` and no `why`; a role routed without a lane leaves no row; a confident Jev track still overrides the lane's declared `repo_code/build`; an override bar's threshold shows the default's why; a run whose `routes.jsonl` is a directory fails the route (`EISDIR`).

- [ ] **Step 3: Implement**

Edit `plugin/skills/catherd/SKILL.md` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/plugin/skills/catherd/SKILL.md b/plugin/skills/catherd/SKILL.md
index cc782f9..069cdfb 100644
--- a/plugin/skills/catherd/SKILL.md
+++ b/plugin/skills/catherd/SKILL.md
@@ -44,7 +44,7 @@ Pass the actual project `repo` explicitly to profile, setup and catalog tools th
 | `status(run?)`                                                                                        | First, and whenever the user asks where it stands: `version`, then per run the open owner questions, the `state.md` tail, live roles, totals, Claude subagents, the verifier's step, budget, milestones                                                                                                          |
 | `run_start(repo, title, a_lines)`                                                                     | Once per project. Returns `run`, the id every other call takes, `dir`, the run folder `R`, and `protocol`: the next step of the milestone loop and its six-line checklist                                                                                                                                        |
 | `peek(run?, name?)`                                                                                   | Never waits. Per run: the open owner questions first (the owner's to answer), each live role with its rung, time and last event, every finished record not yet read, the next step, the verifier's step, and `protocol` (the milestone loop's next step and the checklist). It marks nothing read: `result` does |
-| `route(run, lane_file?, role?)`                                                                       | A lane's rung (from Jev, else the lane file's `Kind:`/`Difficulty:`, else the profile), or a role's rung. Returns `rung`, `ladder`, `backend`, `agent`                                                                                                                                                           |
+| `route(run, lane_file?, role?)`                                                                       | A lane's rung (from the lane file's `Kind:`/`Difficulty:` when it declares both, else Jev, else the profile), or a role's rung. Returns `rung`, `ladder` (only rungs at least as strong as the start), `backend`, `agent` and a one-line `why`; the full provenance goes to `R/routes.jsonl`                     |
 | `preflight(run, confirmed?)`                                                                          | Each lane's fast check once, before any lane runs. Outcomes below                                                                                                                                                                                                                                                |
 | `dispatch(run, role, name, brief, rung, thread?, lane?, next?)`                                       | Starts one process role (Codex, claude-code or opencode) and returns at launch, in about a second, with `dispatched`. It routes a lane not routed yet, appends the role's reply contract to the brief, and its result arrives as a catherd message                                                               |
 | `result(run, name)`                                                                                   | A role's latest reply, capped, its record and its `hints`; reading a finished record marks it read                                                                                                                                                                                                               |
````

Edit `src/domain/catalog.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/catalog.ts b/src/domain/catalog.ts
index 3e45325..b9554db 100644
--- a/src/domain/catalog.ts
+++ b/src/domain/catalog.ts
@@ -211,6 +211,8 @@ export interface Catalog {
    * whose value it uses as `inferred` (spec 1.2 §6.1); filled by the stand-in ranking (services/standins.ts)
    */
   inferred: Record<string, Partial<Record<Dim, InferredStandIn>>>;
+  /** the thresholds the user's override set or removed, as `<kind>/<difficulty>/<dim>` (route says "your override") */
+  userBars?: string[];
 }
 
 /**
@@ -317,11 +319,14 @@ export function buildCatalog(o: {
   for (const [rung, like] of Object.entries(o.override?.treatLike ?? {}))
     treatLike[rung] = { like, source: "user" };
   const bars = structuredClone(o.scores.bars) as Bars;
+  const userBars: string[] = [];
   for (const kind of KINDS)
     for (const d of DIFFICULTIES)
-      for (const [dim, min] of Object.entries(o.override?.bars[kind]?.[d] ?? {}) as [Dim, number | null][])
+      for (const [dim, min] of Object.entries(o.override?.bars[kind]?.[d] ?? {}) as [Dim, number | null][]) {
+        userBars.push(`${kind}/${d}/${dim}`);
         if (min === null) delete bars[kind][d][dim];
         else bars[kind][d][dim] = min;
+      }
   return {
     families: o.facts ? applyFacts(o.models.families, o.facts) : o.models.families,
     backends: o.models.backends,
@@ -333,6 +338,7 @@ export function buildCatalog(o: {
     secs: o.secs ?? {},
     features: o.features ?? {},
     inferred: {},
+    userBars,
   };
 }
 
````

Edit `src/domain/route.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/route.ts b/src/domain/route.ts
index e94e232..57fdb41 100644
--- a/src/domain/route.ts
+++ b/src/domain/route.ts
@@ -43,6 +43,35 @@ export interface RouteRow {
   jev?: RouteJev | null;
   /** climb rows: the climb was caused by the environment, not the rung's capability (spec §5.6) */
   env?: boolean;
+  /** route rows (spec 1.5 plan 24): the decision in one line, as `route` returned it */
+  why?: string;
+  /** route rows: where Jev disagreed with the lane's declared Kind/Difficulty */
+  jevSaid?: string;
+  /** route rows: no rung clears the lane's bar, and the closest one */
+  noClear?: string;
+  /** route rows: rungs of equal scores on other quotas competed for the start, and what decided */
+  tie?: string;
+  /** route rows: the chosen rung's thresholds, values and sources (spec 1.2 §5.3), kept out of `route`'s answer */
+  provenance?: unknown;
+}
+
+/**
+ * Spec 1.5 plan 24: one routes.jsonl row for a role's decision outside a lane: `route` without a lane file, or
+ * a lane-less `dispatch` (its `name`). `readRoutes` skips these rows: they have no lane to climb.
+ */
+export interface RoleRouteRow {
+  at: string;
+  lane: null;
+  role: Role;
+  /** the dispatch's name; null for a `route` */
+  name: string | null;
+  rung: string;
+  ladder: string[];
+  source: "route" | "dispatch";
+  /** who chose the rung: the router (its source), or the coordinator passing `rung` to `dispatch` */
+  decidedBy: RouteSource | "orchestrator";
+  why: string;
+  provenance?: unknown;
 }
 
 export function nextRung(ladder: string[], current: string): string | null {
````

Edit `src/entry/mcp/lane-tools.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/mcp/lane-tools.ts b/src/entry/mcp/lane-tools.ts
index 00a23a9..7b1bda8 100644
--- a/src/entry/mcp/lane-tools.ts
+++ b/src/entry/mcp/lane-tools.ts
@@ -13,7 +13,7 @@ export function registerLaneTools(server: McpServer, deps: Deps): void {
     "route",
     {
       description:
-        "The rung for a lane (from Jev, else the lane file's Kind/Difficulty lines, else the profile default) or, without a lane file, a role's default rung, with the ladder above it. Rungs are backend:model#effort; a claude: rung comes with the agent to run it as. `provenance` says why: each threshold of the lane's bar with the value used against it, that value's confidence, source and date (`inferred: true` when a treat-like or a stand-in lent it), the rung's speed and cost facts, and catherd's own run evidence for it (shown, never used to route). A lane whose Kind: or Difficulty: the catalog does not know is refused with E_LANE_INVALID.",
+        "The rung for a lane (from the lane file's Kind/Difficulty lines when it declares both, else Jev, else the profile default) or, without a lane file, a role's default rung, with the ladder above it: only rungs at least as strong as the start. Rungs are backend:model#effort; a claude: rung comes with the agent to run it as. Returns rung, ladder, backend, agent and why: one line naming the decision, where Jev disagreed with the lane's header, when no rung clears the bar (and the closest), and when a tie between quotas decided. Every decision, with its provenance (each threshold, the value used, its source and date, the rung's cost and run evidence), is written to the run's routes.jsonl. A lane whose Kind: or Difficulty: the catalog does not know is refused with E_LANE_INVALID.",
       inputSchema: {
         run: z.string(),
         lane_file: z.string().optional(),
````

Edit `src/services/catalog-service.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/catalog-service.ts b/src/services/catalog-service.ts
index 214ce68..9a022a6 100644
--- a/src/services/catalog-service.ts
+++ b/src/services/catalog-service.ts
@@ -99,18 +99,23 @@ export function measuredSecs(base: Catalog): Catalog["secs"] {
     if (kind) add(`${canonical}|${kind}`, secs);
   };
   for (const run of listRuns().runs) {
-    const routes = readRoutes(run);
-    for (const r of readRecords(run).records)
-      if (r.status === "ok") count(routes, r.rung, r.secs, r.lane, r.startedAt);
-    for (const a of readAgentRuns(run)) {
-      if (a.status !== "ok" || a.secs === null) continue;
-      // a row is written when the subagent ends; it started `secs` earlier
-      const lane = typeof a.lane === "string" ? a.lane : null;
-      const end = Date.parse(a.at);
-      // a duration past the Date range (record_agent_run takes any) keeps the end, not a RangeError
-      const start = new Date(end - a.secs * 1000);
-      const startedAt = Number.isNaN(start.getTime()) ? a.at : start.toISOString();
-      count(routes, a.rung, a.secs, lane, startedAt);
+    // a run whose files cannot be read gives no timings; it never fails a route (1.2 minor)
+    try {
+      const routes = readRoutes(run);
+      for (const r of readRecords(run).records)
+        if (r.status === "ok") count(routes, r.rung, r.secs, r.lane, r.startedAt);
+      for (const a of readAgentRuns(run)) {
+        if (a.status !== "ok" || a.secs === null) continue;
+        // a row is written when the subagent ends; it started `secs` earlier
+        const lane = typeof a.lane === "string" ? a.lane : null;
+        const end = Date.parse(a.at);
+        // a duration past the Date range (record_agent_run takes any) keeps the end, not a RangeError
+        const start = new Date(end - a.secs * 1000);
+        const startedAt = Number.isNaN(start.getTime()) ? a.at : start.toISOString();
+        count(routes, a.rung, a.secs, lane, startedAt);
+      }
+    } catch (e) {
+      log("debug", "catalog", { run: run.id, timings: errorMessage(e) });
     }
   }
   const secs: Catalog["secs"] = {};
````

Edit `src/services/lane-service.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/lane-service.ts b/src/services/lane-service.ts
index 6dfa0cd..c32235d 100644
--- a/src/services/lane-service.ts
+++ b/src/services/lane-service.ts
@@ -3,17 +3,10 @@ import { relative, sep } from "node:path";
 import { CatherdError } from "../domain/errors.ts";
 import { assertId, ID_PATTERN, parseRung } from "../domain/ids.ts";
 import { quotaUsage } from "../domain/select.ts";
-import { assertLaneHeader, type Difficulty, type Kind } from "../domain/lane.ts";
+import { assertLaneHeader } from "../domain/lane.ts";
 import type { Role } from "../domain/roles.ts";
 import { cell } from "../domain/util.ts";
-import {
-  type ClimbReason,
-  currentRoute,
-  laneOutcome,
-  nextRung,
-  type RouteJev,
-  type RouteSource,
-} from "../domain/route.ts";
+import { type ClimbReason, currentRoute, laneOutcome, nextRung } from "../domain/route.ts";
 import { withFileLock } from "../infra/filelock.ts";
 import { commitExists } from "../infra/git.ts";
 import { laneFile } from "./admission.ts";
@@ -51,20 +44,20 @@ import { type Notes, type NotesPatch, refreshState } from "./state.ts";
 
 const withHints = (hints: string[]) => (hints.length ? { hints } : {});
 
+/**
+ * Spec 1.5 plan 24: what `route` returns: little, since every call lands in the coordinator's context. The
+ * decision's source, kind, difficulty, Jev's answer and the provenance go to routes.jsonl.
+ */
 export interface RouteResult {
   lane: string | null;
   role: Role;
   rung: string;
   ladder: string[];
-  source: RouteSource;
-  kind: Kind | null;
-  difficulty: Difficulty | null;
   backend: string;
   /** the native agent to run a `claude:` rung as */
   agent: string | null;
-  /** the Jev question set asked, and what it said, when Jev was asked */
-  questionSet: string | null;
-  jev: RouteJev | null;
+  /** the decision in one line */
+  why: string;
 }
 
 function readLaneFile(run: Run, path: string): { lane: string; text: string } {
@@ -107,9 +100,18 @@ export async function route(
       (await workspaceBudget(run, deps.now()))?.fraction ?? 0,
     ),
   });
+  const at = new Date(deps.now()).toISOString();
+  // spec 1.5 plan 24: every role's decision is recorded, with its source, ladder and provenance
+  const detail = {
+    why: a.why,
+    ...(a.jevSaid ? { jevSaid: a.jevSaid } : {}),
+    ...(a.noClear ? { noClear: a.noClear } : {}),
+    ...(a.tie ? { tie: a.tie } : {}),
+    ...(a.provenance ? { provenance: a.provenance } : {}),
+  };
   if (lane)
     appendRoute(run, {
-      at: new Date(deps.now()).toISOString(),
+      at,
       lane: lane.lane,
       role: i.role,
       rung: a.rung,
@@ -122,13 +124,28 @@ export async function route(
       difficulty: a.difficulty,
       questionSet: a.questionSet,
       jev: a.jev,
+      ...detail,
+    });
+  else
+    appendRoute(run, {
+      at,
+      lane: null,
+      role: i.role,
+      name: null,
+      rung: a.rung,
+      ladder: a.ladder,
+      source: "route",
+      decidedBy: a.source,
+      ...detail,
     });
   return {
     lane: lane?.lane ?? null,
     role: i.role,
-    ...a,
+    rung: a.rung,
+    ladder: a.ladder,
     backend: parseRung(a.rung).backend,
     agent: deps.profiles.agentFor(run.meta.repo, i.role, a.rung),
+    why: a.why,
   };
 }
 
````

Edit `src/services/ports.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/ports.ts b/src/services/ports.ts
index 57fc2c4..f814090 100644
--- a/src/services/ports.ts
+++ b/src/services/ports.ts
@@ -95,6 +95,14 @@ export interface RouteAnswer {
   /** the Jev question set asked, and its summed probabilities, for outcomes.jsonl (spec §5.6) */
   questionSet: string | null;
   jev: RouteJev | null;
+  /** spec 1.5 plan 24: where Jev disagreed with a declared lane header (`Jev said logic/hard`), else null */
+  jevSaid: string | null;
+  /** spec 1.5 plan 24: no rung clears the lane's bar, and the closest one */
+  noClear?: string;
+  /** spec 1.5 plan 24: rungs of equal scores on other quotas competed for the start, and what decided */
+  tie?: string;
+  /** spec 1.5 plan 24: the decision in one line, for the coordinator */
+  why: string;
   /** spec 1.2 §5.3, §8: the chosen rung's thresholds, values, sources, facts and run evidence */
   provenance?: Provenance;
 }
````

Edit `src/services/provenance.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/provenance.ts b/src/services/provenance.ts
index 11b9c6b..91303b7 100644
--- a/src/services/provenance.ts
+++ b/src/services/provenance.ts
@@ -40,8 +40,11 @@ export interface Provenance {
   /** facts that never carry a bar (spec 1.2 §4.1): `<source>.<field>` → value */
   speed: Record<string, number>;
   cost: Cost;
-  /** spec 1.2 §8: its runs for the lane's kind (or every kind) and over every kind; never used for routing */
-  evidence: { kind: string | null; all: string | null };
+  /**
+   * spec 1.2 §8: its runs for the lane's kind (or every kind) and over every kind; never used for routing;
+   * null when the runs could not be read
+   */
+  evidence: { kind: string | null; all: string | null } | null;
 }
 
 /** Spec 1.2 §5.3: each value a canonical rung has, with its confidence and source, borrowed ones marked. */
@@ -75,7 +78,7 @@ export function provenanceOf(
   kind: Kind | null,
   difficulty: Difficulty | null,
   billing: Partial<Record<string, BillingMode>>,
-  evidence: EvidenceTable,
+  evidence: EvidenceTable | null,
 ): Provenance {
   const info = rungInfo(c, rung);
   const values = valuesUsed(c, info.canonical);
@@ -90,7 +93,10 @@ export function provenanceOf(
         min,
         used,
         clears: used !== null && used.value >= min,
-        why: c.barsWhy[dim]?.[difficulty] ?? null,
+        // a threshold the user's override set is theirs, whatever the default's why says (1.2 minor)
+        why: c.userBars?.includes(`${kind}/${difficulty}/${dim}`)
+          ? "your override"
+          : (c.barsWhy[dim]?.[difficulty] ?? null),
       },
     ];
   });
@@ -101,15 +107,9 @@ export function provenanceOf(
     values,
     speed: info.family?.speed ?? {},
     cost: costOf(info.family, info.parsed.effort, billing[info.key] ?? DEFAULT_BILLING[info.key]),
-    evidence: {
+    evidence: evidence && {
       kind: evidenceLine(evidenceOf(evidence, info.canonical, kind)),
       all: evidenceLine(evidenceOf(evidence, info.canonical)),
     },
   };
 }
-
-/** A value as one line: `repo_code 66.6 (adjacent, shipped DeepSWE 1.1, 2026-09-22)`, marking a guess. */
-export function valueWords(v: ValueUsed): string {
-  const lent = v.inferred ? `, inferred from ${v.from}` : "";
-  return `${v.dim} ${v.value} (${v.confidence}, ${v.source} ${v.benchmark}, ${v.date}${lent})`;
-}
````

Edit `src/services/routing-service.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/routing-service.ts b/src/services/routing-service.ts
index 2957e15..613d534 100644
--- a/src/services/routing-service.ts
+++ b/src/services/routing-service.ts
@@ -13,6 +13,7 @@ import {
 import { type Difficulty, type Kind, parseLaneHeader } from "../domain/lane.ts";
 import type { Role } from "../domain/roles.ts";
 import type { RouteJev } from "../domain/route.ts";
+import type { Catalog } from "../domain/catalog.ts";
 import {
   candidates,
   defaultDifficulty,
@@ -26,7 +27,7 @@ import { catalogQuery, freshenDiscovery, loadCatalog } from "./catalog-service.t
 import { type Asked, askJev, type JevOpts, jevQuestions, logJev } from "./jev-service.ts";
 import type { ProfileView, RouteAnswer, RouteRequest, RoutingPort, Verdict } from "./ports.ts";
 import { provenanceOf } from "./provenance.ts";
-import { runEvidence } from "./run-evidence.ts";
+import { type EvidenceTable, runEvidence } from "./run-evidence.ts";
 
 function routingProfile(
   v: ProfileView,
@@ -56,14 +57,60 @@ const answer = (
   asked: Asked | null,
   jev: RouteJev | null,
 ): RouteAnswer => ({
-  ...pick,
+  rung: pick.rung,
+  ladder: pick.ladder,
   source,
   kind,
   difficulty,
   questionSet: asked?.answers ? asked.meta.questionSet : null,
   jev,
+  jevSaid: null,
+  why: "",
+  ...(pick.noClear ? { noClear: pick.noClear } : {}),
+  ...(pick.tie ? { tie: pick.tie } : {}),
 });
 
+/** Spec 1.5 plan 24: what Jev said when it differs from the kind and difficulty the route used, else null. */
+function jevSaid(
+  judged: ReturnType<typeof judgeRoute> | null,
+  kind: Kind | null,
+  difficulty: Difficulty | null,
+): string | null {
+  if (!judged) return null;
+  const k = judged.kind;
+  const d = judged.track ? judged.difficulty : null;
+  if ((k === null || k === kind) && (d === null || d === difficulty)) return null;
+  return `Jev said ${k ?? "no sure kind"}/${d ?? "no sure difficulty"}`;
+}
+
+/** Spec 1.5 plan 24: the route's one-line why, for the coordinator; the provenance goes to routes.jsonl. */
+function whyOf(a: RouteAnswer, hasLane: boolean): string {
+  const what = `${a.kind}/${a.difficulty}`;
+  const head =
+    a.source === "lane"
+      ? `the lane's Kind/Difficulty, ${what}`
+      : a.source === "jev"
+        ? `Jev: ${what}`
+        : a.source === "jev-kind"
+          ? `Jev's kind with ${what}`
+          : hasLane
+            ? "the role's default rung: neither Jev nor the lane file gave a kind and difficulty"
+            : "the role's default rung";
+  const start =
+    a.noClear ?? (a.source === "default" ? null : "the first rung in objective order that clears it");
+  return [head, a.jevSaid, start, a.tie].filter((x): x is string => Boolean(x)).join("; ");
+}
+
+/** Spec 1.2 §8 evidence is display only: an unreadable run on this machine never fails a route. */
+function evidenceOrNone(c: Catalog): EvidenceTable | null {
+  try {
+    return runEvidence(c);
+  } catch (e) {
+    log("debug", "route", { evidence: errorMessage(e) });
+    return null;
+  }
+}
+
 /** How long `route` waits on the daily discovery refresh before routing on the cached listing. */
 const DISCOVERY_BUDGET_MS = 5_000;
 
@@ -86,20 +133,24 @@ async function freshenWithin(rungs: string[], repo: string, ms: number): Promise
 }
 
 /**
- * Spec §5.4: kind and difficulty from Jev (§5.5's rule), else the lane file's `Kind:`/`Difficulty:`,
- * else the role's default rung. A kind Jev is sure of survives a difficulty in the dead band: the
- * difficulty then comes from the lane, else the role's default difficulty (`jev-kind`). A role with one
- * usable rung never asks Jev.
+ * Spec §5.4: kind and difficulty from the lane file's `Kind:`/`Difficulty:` when it declares both (spec 1.5
+ * plan 24: a declared header wins, and `jevSaid` names where Jev disagreed), else from Jev (§5.5's rule), else
+ * the role's default rung. A kind Jev is sure of survives a difficulty in the dead band: the difficulty then
+ * comes from the lane, else the role's default difficulty (`jev-kind`). A role with one usable rung never asks
+ * Jev.
  */
 async function route(req: RouteRequest, o: RoutingOpts): Promise<RouteAnswer> {
   const p = routingProfile(req.profile, req.role, req.spentFraction, req.usage);
   await freshenWithin(p.role.rungs, req.repo, o.discoveryBudgetMs ?? DISCOVERY_BUDGET_MS);
   const c = loadCatalog({ repo: req.repo });
   const fallback = () => defaultLadder(c, p, req.role);
-  if (req.laneText === null || candidates(c, p, req.role).length <= 1) {
-    const out = answer(fallback(), "default", null, null, null, null);
-    return { ...out, provenance: provenanceOf(c, out.rung, null, null, p.billing, runEvidence(c)) };
-  }
+  const finish = (out: RouteAnswer): RouteAnswer => {
+    out.why = whyOf(out, req.laneText !== null);
+    out.provenance = provenanceOf(c, out.rung, out.kind, out.difficulty, p.billing, evidenceOrNone(c));
+    return out;
+  };
+  if (req.laneText === null || candidates(c, p, req.role).length <= 1)
+    return finish(answer(fallback(), "default", null, null, null, null));
   const lane = parseLaneHeader(req.laneText);
   let asked: Asked | null = null;
   let judged: ReturnType<typeof judgeRoute> | null = null;
@@ -111,27 +162,27 @@ async function route(req: RouteRequest, o: RoutingOpts): Promise<RouteAnswer> {
     ? { pKind: judged.pKind, pA: judged.pA, pB: judged.pB, nouls: judged.nouls }
     : null;
   let out: RouteAnswer;
-  if (judged?.track && judged.difficulty) {
-    const kind = judged.kind ?? lane.kind ?? "repo_code";
-    out = answer(select(c, p, req.role, kind, judged.difficulty), "jev", kind, judged.difficulty, asked, jev);
-  } else if (judged?.kind) {
-    const difficulty = lane.difficulty ?? defaultDifficulty(c, p, req.role, judged.kind);
+  if (lane.kind && lane.difficulty) {
     out = answer(
-      select(c, p, req.role, judged.kind, difficulty),
-      "jev-kind",
-      judged.kind,
-      difficulty,
+      select(c, p, req.role, lane.kind, lane.difficulty),
+      "lane",
+      lane.kind,
+      lane.difficulty,
       asked,
       jev,
     );
+  } else if (judged?.track && judged.difficulty) {
+    const kind = lane.kind ?? judged.kind ?? "repo_code";
+    out = answer(select(c, p, req.role, kind, judged.difficulty), "jev", kind, judged.difficulty, asked, jev);
+  } else if (judged?.kind || (judged && lane.kind)) {
+    const kind = (lane.kind ?? judged.kind) as Kind;
+    const difficulty = lane.difficulty ?? defaultDifficulty(c, p, req.role, kind);
+    out = answer(select(c, p, req.role, kind, difficulty), "jev-kind", kind, difficulty, asked, jev);
   } else {
-    const kind = lane.kind;
-    out =
-      kind && lane.difficulty
-        ? answer(select(c, p, req.role, kind, lane.difficulty), "lane", kind, lane.difficulty, asked, jev)
-        : answer(fallback(), "default", null, null, asked, jev);
+    out = answer(fallback(), "default", null, null, asked, jev);
   }
-  out.provenance = provenanceOf(c, out.rung, out.kind, out.difficulty, p.billing, runEvidence(c));
+  out.jevSaid = out.source === "default" ? null : jevSaid(judged, out.kind, out.difficulty);
+  finish(out);
   if (asked) {
     logJev(req.runDir, {
       ...asked.meta,
````

Edit `src/services/run-store.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/run-store.ts b/src/services/run-store.ts
index 630ac01..0cd9043 100644
--- a/src/services/run-store.ts
+++ b/src/services/run-store.ts
@@ -4,7 +4,7 @@ import { z } from "zod";
 import { CatherdError } from "../domain/errors.ts";
 import { assertId } from "../domain/ids.ts";
 import { type RunRecord, RunRecordSchema } from "../domain/record.ts";
-import type { OutcomeRow, RouteRow } from "../domain/route.ts";
+import type { OutcomeRow, RoleRouteRow, RouteRow } from "../domain/route.ts";
 import { cell, slug } from "../domain/util.ts";
 import { withFileLock } from "../infra/filelock.ts";
 import { dataDir, repoDir, runsDir } from "../infra/paths.ts";
@@ -230,13 +230,21 @@ export function appendRecord(run: Run, r: RunRecord): Promise<RunRecord> {
   });
 }
 
+/** The run's lane rows (routes and climbs); a role's rows outside a lane are left out (`readRoleRoutes`). */
 export function readRoutes(run: Run): RouteRow[] {
   return readJsonl<RouteRow>(runPaths(run.dir).routes).rows.filter(
     (r) => typeof r?.lane === "string" && Array.isArray(r.ladder) && typeof r.rung === "string",
   );
 }
 
-export function appendRoute(run: Run, row: RouteRow): void {
+/** Spec 1.5 plan 24: the run's role decisions outside a lane, oldest first. */
+export function readRoleRoutes(run: Run): RoleRouteRow[] {
+  return readJsonl<RoleRouteRow>(runPaths(run.dir).routes).rows.filter(
+    (r) => r?.lane === null && typeof r.role === "string" && typeof r.rung === "string",
+  );
+}
+
+export function appendRoute(run: Run, row: RouteRow | RoleRouteRow): void {
   const file = runPaths(run.dir).routes;
   ensureJsonlHeader(file, "routes");
   appendJsonl(file, row);
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/integration/mcp-stdio.test.ts test/services/dispatch-protocol.test.ts test/services/outcomes.test.ts test/services/route-records.test.ts test/services/routing-service.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS.

- [ ] **Step 5: Commit**

````bash
git add plugin/skills/catherd/SKILL.md src/domain/catalog.ts src/domain/route.ts src/entry/mcp/lane-tools.ts src/services/catalog-service.ts src/services/lane-service.ts src/services/ports.ts src/services/provenance.ts src/services/routing-service.ts src/services/run-store.ts test/integration/mcp-stdio.test.ts test/services/dispatch-protocol.test.ts test/services/helpers.ts test/services/outcomes.test.ts test/services/route-records.test.ts test/services/routing-service.test.ts
git commit -m "feat(routing): record every role's decision and return route's rung, ladder and why"
````

---

### Task 6: `dispatch` takes `rung` optionally on a lane and records a lane-less dispatch's rung (spec bullets 3, 6; Ruling 12)

`DispatchInput.rung` is optional. With `lane`, a lane not routed yet is routed first (an explicit off-ladder rung still starts at the routed one, with the hint), and a missing `rung` is the lane's current rung (its route, or the rung its last climb gave). Without `lane`, a missing `rung` is `E_INPUT_INVALID` naming `route(run, role)`. After the launch, a lane-less dispatch appends a `RoleRouteRow` with `source: "dispatch"`, its `name`, the role's last routed ladder and `decidedBy` (the route's source when the rung is the routed one, else `orchestrator`); a failed write is logged. The tool's schema and description, and the skill's row, follow.

**Interfaces:**
- Consumes: Task 5's `readRoleRoutes`, `appendRoute(RoleRouteRow)`.
- Produces: `DispatchInput.rung?: string`; the `dispatch` tool's `rung` optional.

**Scratch commit:** `dac3f18` (feat(dispatch): take rung optionally on a lane and record a lane-less dispatch's rung).

**Files:**
- Modify: `plugin/skills/catherd/SKILL.md`
- Modify: `src/entry/mcp/dispatch-tools.ts`
- Modify: `src/services/dispatch-service.ts`
- Modify: `test/services/dispatch-protocol.test.ts`
- Modify: `test/services/lanes-run.test.ts`

- [ ] **Step 1: Write the failing tests**

Edit `test/services/dispatch-protocol.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/dispatch-protocol.test.ts b/test/services/dispatch-protocol.test.ts
index 68a34cc..7ac97c4 100644
--- a/test/services/dispatch-protocol.test.ts
+++ b/test/services/dispatch-protocol.test.ts
@@ -6,8 +6,8 @@ import { ROLES } from "../../src/domain/roles.ts";
 import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
 import { resetReadiness } from "../../src/services/backends.ts";
 import { dispatch, watchersSettled } from "../../src/services/dispatch-service.ts";
-import { route } from "../../src/services/lane-service.ts";
-import { readRoutes } from "../../src/services/run-store.ts";
+import { climb, route } from "../../src/services/lane-service.ts";
+import { readRoleRoutes, readRoutes } from "../../src/services/run-store.ts";
 import { snapshotEnv } from "../helpers.ts";
 import { simPath, withScenario } from "../sim/scenario.ts";
 import { fakeDeps, freshRun, LADDER, writeLane } from "./helpers.ts";
@@ -146,3 +146,64 @@ describe("dispatch routes an unrouted lane first (spec 1.1 §6)", () => {
     expect(readRoutes(run)).toHaveLength(1);
   });
 });
+
+describe("dispatch takes rung optionally on a lane (spec 1.5 plan 24)", () => {
+  it("routes an unrouted lane and runs it at the routed rung, then at the rung its climb gave", async () => {
+    const { run, deps } = setup();
+    const first = await dispatch(deps, {
+      run: run.id,
+      role: "worker",
+      name: "worker-M1.L1",
+      brief: "b",
+      lane: "M1.L1",
+    });
+    expect(first.dispatched.rung).toBe(L0);
+    expect(first.hints).toEqual([]);
+    await watchersSettled();
+    await climb(deps, { run: run.id, lane: "M1.L1", reason: "check-failed-twice" });
+    const again = await dispatch(deps, {
+      run: run.id,
+      role: "worker",
+      name: "worker-M1.L1-r2",
+      brief: "b",
+      lane: "M1.L1",
+    });
+    expect(again.dispatched.rung).toBe(L1);
+  });
+
+  it("refuses a role outside a lane with no rung, naming route", async () => {
+    const { run, deps } = setup();
+    const err = await dispatch(deps, {
+      run: run.id,
+      role: "reviewer",
+      name: "reviewer-M1",
+      brief: "b",
+    }).catch((e: unknown) => e);
+    expect(err).toMatchObject({
+      code: "E_INPUT_INVALID",
+      message: "dispatch reviewer-M1: a role outside a lane needs a rung",
+      fix: 'route(run, role: "reviewer") gives the role\'s rung; pass it as rung',
+    });
+  });
+
+  it("records a lane-less dispatch's rung, and whether route or the coordinator chose it", async () => {
+    const { run, deps } = setup();
+    await route(deps, { run: run.id, role: "reviewer" });
+    const routed = deps.view.roles.reviewer?.rungs[0] as string;
+    await dispatch(deps, { run: run.id, role: "reviewer", name: "reviewer-M1", brief: "b", rung: routed });
+    await dispatch(deps, { run: run.id, role: "worker", name: "worker-spike", brief: "b", rung: L2 });
+    expect(readRoleRoutes(run).map((r) => [r.source, r.role, r.name, r.rung, r.decidedBy, r.why])).toEqual([
+      ["route", "reviewer", null, routed, "default", "the role's default rung"],
+      ["dispatch", "reviewer", "reviewer-M1", routed, "default", "the rung route gave the reviewer"],
+      [
+        "dispatch",
+        "worker",
+        "worker-spike",
+        L2,
+        "orchestrator",
+        "the coordinator's rung; the worker was never routed",
+      ],
+    ]);
+    expect(readRoutes(run)).toEqual([]);
+  });
+});
````

Edit `test/services/lanes-run.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/lanes-run.test.ts b/test/services/lanes-run.test.ts
index 26cb8a8..2003bc2 100644
--- a/test/services/lanes-run.test.ts
+++ b/test/services/lanes-run.test.ts
@@ -23,6 +23,7 @@ import {
   knowledgeFile,
   listRuns,
   readAgentRuns,
+  readRoleRoutes,
   readRoutes,
   runPaths,
 } from "../../src/services/run-store.ts";
@@ -78,7 +79,7 @@ describe("startRun", () => {
 });
 
 describe("route and climb", () => {
-  it("routes a lane file and records it, and routes a role without recording", async () => {
+  it("routes a lane file and records it, and records a role's route apart from the lanes", async () => {
     const { run } = freshRun();
     writeLane(run, "M1.L1", ["src/a.ts"]);
     const deps = fakeDeps();
@@ -100,6 +101,7 @@ describe("route and climb", () => {
       agent: "catherd-architect-claude-opus-5-5-high",
     });
     expect(readRoutes(run)).toHaveLength(1);
+    expect(readRoleRoutes(run)).toMatchObject([{ lane: null, role: "architect", source: "route" }]);
   });
 
   it("refuses a lane file outside lanes/ or missing", async () => {
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/services/dispatch-protocol.test.ts test/services/lanes-run.test.ts`
Expected: FAIL: `dispatch` without `rung` on a lane fails admission (`rung` undefined); a reviewer dispatched without a lane and without `rung` is not refused with `E_INPUT_INVALID`; a lane-less dispatch writes no `dispatch` row; `readRoleRoutes` is not imported by the lanes test.

- [ ] **Step 3: Implement**

Edit `plugin/skills/catherd/SKILL.md` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/plugin/skills/catherd/SKILL.md b/plugin/skills/catherd/SKILL.md
index 069cdfb..e59e648 100644
--- a/plugin/skills/catherd/SKILL.md
+++ b/plugin/skills/catherd/SKILL.md
@@ -39,27 +39,27 @@ Native headless Codex and Claude Code roles receive a dedicated `catherd_role` M
 
 Pass the actual project `repo` explicitly to profile, setup and catalog tools that accept it. The native Codex MCP server starts in the installed plugin root, so its cwd is not evidence of the project. `run_start(repo, ...)` establishes the run's repository.
 
-| Tool                                                                                                  | Use                                                                                                                                                                                                                                                                                                              |
-| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
-| `status(run?)`                                                                                        | First, and whenever the user asks where it stands: `version`, then per run the open owner questions, the `state.md` tail, live roles, totals, Claude subagents, the verifier's step, budget, milestones                                                                                                          |
-| `run_start(repo, title, a_lines)`                                                                     | Once per project. Returns `run`, the id every other call takes, `dir`, the run folder `R`, and `protocol`: the next step of the milestone loop and its six-line checklist                                                                                                                                        |
-| `peek(run?, name?)`                                                                                   | Never waits. Per run: the open owner questions first (the owner's to answer), each live role with its rung, time and last event, every finished record not yet read, the next step, the verifier's step, and `protocol` (the milestone loop's next step and the checklist). It marks nothing read: `result` does |
-| `route(run, lane_file?, role?)`                                                                       | A lane's rung (from the lane file's `Kind:`/`Difficulty:` when it declares both, else Jev, else the profile), or a role's rung. Returns `rung`, `ladder` (only rungs at least as strong as the start), `backend`, `agent` and a one-line `why`; the full provenance goes to `R/routes.jsonl`                     |
-| `preflight(run, confirmed?)`                                                                          | Each lane's fast check once, before any lane runs. Outcomes below                                                                                                                                                                                                                                                |
-| `dispatch(run, role, name, brief, rung, thread?, lane?, next?)`                                       | Starts one process role (Codex, claude-code or opencode) and returns at launch, in about a second, with `dispatched`. It routes a lane not routed yet, appends the role's reply contract to the brief, and its result arrives as a catherd message                                                               |
-| `result(run, name)`                                                                                   | A role's latest reply, capped, its record and its `hints`; reading a finished record marks it read                                                                                                                                                                                                               |
-| `cancel(run, name)`                                                                                   | Stops a live role and returns its record, `cancelled`, and `hints`                                                                                                                                                                                                                                               |
-| `record_agent_run(run, name, role, rung, total_tokens, duration_ms?, cost_usd?, status?, lane?)`      | Native Claude Agent results on Claude Code only. The budget counts them; `lane` counts their time toward that lane's kind; a verifier named `verifier-<M>` records FAIL with `status: "failed"`                                                                                                                  |
-| `climb(run, lane, reason, evidence?, env?)`                                                           | The lane's next rung, with its `backend` and `agent`, or `top: true`. `env: true` when the environment, not the rung, caused it                                                                                                                                                                                  |
-| `ask(run, question, state)`                                                                           | Jev's `finding` or `same-defect` answer                                                                                                                                                                                                                                                                          |
-| `gate_check(run, item, command, paths, milestone?)`, `gate_pass(run, item, command, paths, evidence)` | The verifier's gate ledger: an item that passed on the same content is carried over, not run again; `milestone` scopes the digest's carried items                                                                                                                                                                |
-| `park(run, milestone, question)`, `answer(run, milestone, answer)`                                    | An owner question parks its milestone while the rest of the run goes on; the owner's answer unparks it                                                                                                                                                                                                           |
-| `land(run, milestone, what, commit, evidence, next, learned?, skip?)`                                 | A landed milestone's ledger row, with the minutes it took, `state.md`, and `digest`, the milestone's digest. Refused until the milestone has its reviewer and its verifier. `learned` appends to this repo's `knowledge.md`                                                                                      |
-| `read_knowledge(repo)`                                                                                | What past runs of this repo learned. The dossier brief reads it                                                                                                                                                                                                                                                  |
-| `write_run_file(run, path, content)`, `read_run_file(run, path)`                                      | Files in `R`. Never your own Write or Read tools there: `R` is outside the repo                                                                                                                                                                                                                                  |
-| `set_next(run, next)`                                                                                 | The next step, when you pause or the plan changes. Returns `state` and, when git fails, `hints`                                                                                                                                                                                                                  |
-| `runs_summary(run?, repo?, role?, since_days?)`                                                       | Time, tokens, refusals and climbs per role and rung, the Claude subagent runs, and the harness cost, for the report                                                                                                                                                                                              |
-| `profile_get(repo?)`                                                                                  | The profile this repo runs on: each role's access, rungs and enforcement, failover, budget, timeouts, and the moments to push                                                                                                                                                                                    |
+| Tool                                                                                                  | Use                                                                                                                                                                                                                                                                                                                                              |
+| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
+| `status(run?)`                                                                                        | First, and whenever the user asks where it stands: `version`, then per run the open owner questions, the `state.md` tail, live roles, totals, Claude subagents, the verifier's step, budget, milestones                                                                                                                                          |
+| `run_start(repo, title, a_lines)`                                                                     | Once per project. Returns `run`, the id every other call takes, `dir`, the run folder `R`, and `protocol`: the next step of the milestone loop and its six-line checklist                                                                                                                                                                        |
+| `peek(run?, name?)`                                                                                   | Never waits. Per run: the open owner questions first (the owner's to answer), each live role with its rung, time and last event, every finished record not yet read, the next step, the verifier's step, and `protocol` (the milestone loop's next step and the checklist). It marks nothing read: `result` does                                 |
+| `route(run, lane_file?, role?)`                                                                       | A lane's rung (from the lane file's `Kind:`/`Difficulty:` when it declares both, else Jev, else the profile), or a role's rung. Returns `rung`, `ladder` (only rungs at least as strong as the start), `backend`, `agent` and a one-line `why`; the full provenance goes to `R/routes.jsonl`                                                     |
+| `preflight(run, confirmed?)`                                                                          | Each lane's fast check once, before any lane runs. Outcomes below                                                                                                                                                                                                                                                                                |
+| `dispatch(run, role, name, brief, rung?, thread?, lane?, next?)`                                      | Starts one process role (Codex, claude-code or opencode) and returns at launch, in about a second, with `dispatched`. It routes a lane not routed yet, runs a lane at its current rung when `rung` is left out (a role outside a lane needs `rung`), appends the role's reply contract to the brief, and its result arrives as a catherd message |
+| `result(run, name)`                                                                                   | A role's latest reply, capped, its record and its `hints`; reading a finished record marks it read                                                                                                                                                                                                                                               |
+| `cancel(run, name)`                                                                                   | Stops a live role and returns its record, `cancelled`, and `hints`                                                                                                                                                                                                                                                                               |
+| `record_agent_run(run, name, role, rung, total_tokens, duration_ms?, cost_usd?, status?, lane?)`      | Native Claude Agent results on Claude Code only. The budget counts them; `lane` counts their time toward that lane's kind; a verifier named `verifier-<M>` records FAIL with `status: "failed"`                                                                                                                                                  |
+| `climb(run, lane, reason, evidence?, env?)`                                                           | The lane's next rung, with its `backend` and `agent`, or `top: true`. `env: true` when the environment, not the rung, caused it                                                                                                                                                                                                                  |
+| `ask(run, question, state)`                                                                           | Jev's `finding` or `same-defect` answer                                                                                                                                                                                                                                                                                                          |
+| `gate_check(run, item, command, paths, milestone?)`, `gate_pass(run, item, command, paths, evidence)` | The verifier's gate ledger: an item that passed on the same content is carried over, not run again; `milestone` scopes the digest's carried items                                                                                                                                                                                                |
+| `park(run, milestone, question)`, `answer(run, milestone, answer)`                                    | An owner question parks its milestone while the rest of the run goes on; the owner's answer unparks it                                                                                                                                                                                                                                           |
+| `land(run, milestone, what, commit, evidence, next, learned?, skip?)`                                 | A landed milestone's ledger row, with the minutes it took, `state.md`, and `digest`, the milestone's digest. Refused until the milestone has its reviewer and its verifier. `learned` appends to this repo's `knowledge.md`                                                                                                                      |
+| `read_knowledge(repo)`                                                                                | What past runs of this repo learned. The dossier brief reads it                                                                                                                                                                                                                                                                                  |
+| `write_run_file(run, path, content)`, `read_run_file(run, path)`                                      | Files in `R`. Never your own Write or Read tools there: `R` is outside the repo                                                                                                                                                                                                                                                                  |
+| `set_next(run, next)`                                                                                 | The next step, when you pause or the plan changes. Returns `state` and, when git fails, `hints`                                                                                                                                                                                                                                                  |
+| `runs_summary(run?, repo?, role?, since_days?)`                                                       | Time, tokens, refusals and climbs per role and rung, the Claude subagent runs, and the harness cost, for the report                                                                                                                                                                                                                              |
+| `profile_get(repo?)`                                                                                  | The profile this repo runs on: each role's access, rungs and enforcement, failover, budget, timeouts, and the moments to push                                                                                                                                                                                                                    |
 
 **A tool returns `hints` when it has any:** one line each, on what to do next. Read them before you move on.
 
````

Edit `src/entry/mcp/dispatch-tools.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/mcp/dispatch-tools.ts b/src/entry/mcp/dispatch-tools.ts
index b5e524e..803533a 100644
--- a/src/entry/mcp/dispatch-tools.ts
+++ b/src/entry/mcp/dispatch-tools.ts
@@ -12,13 +12,13 @@ export function registerDispatchTools(server: McpServer, deps: Deps): void {
     "dispatch",
     {
       description:
-        "Start one role on a process backend (codex, claude-code, opencode) and return at launch, in about a second, with { dispatched: { name, role, rung, dispatchId, admittedAt }, hints }; the role runs on. When it finishes, catherd sends this session a <cross-session-message from-name=\"catherd\"> naming the run, the role and its status, and result(run, name) reads the record. Dispatch every independent role one after another, then end your turn. The brief is the text itself; dispatch appends the role's reply contract (reply length and the STATUS line), so do not write it. With lane, the lane file's Owns: paths guard against overlapping lanes, and a lane not yet routed is routed first (a rung off its routed ladder starts at the routed rung, with a hint). thread resumes that role's thread for its own fix round. Refused with a structured error (E_ADMIT_*, E_RUN_BUDGET, E_BACKEND_*) before anything starts. Call it from the main thread.",
+        "Start one role on a process backend (codex, claude-code, opencode) and return at launch, in about a second, with { dispatched: { name, role, rung, dispatchId, admittedAt }, hints }; the role runs on. When it finishes, catherd sends this session a <cross-session-message from-name=\"catherd\"> naming the run, the role and its status, and result(run, name) reads the record. Dispatch every independent role one after another, then end your turn. The brief is the text itself; dispatch appends the role's reply contract (reply length and the STATUS line), so do not write it. With lane, the lane file's Owns: paths guard against overlapping lanes, a lane not yet routed is routed first (a rung off its routed ladder starts at the routed rung, with a hint), and rung may be left out: the lane runs at its current rung (its route, or the rung its last climb gave). Without lane, rung is required (route(run, role) gives it), and the choice is recorded in routes.jsonl. thread resumes that role's thread for its own fix round. Refused with a structured error (E_ADMIT_*, E_RUN_BUDGET, E_BACKEND_*) before anything starts. Call it from the main thread.",
       inputSchema: {
         run: z.string(),
         role: z.enum(ROLES),
         name: z.string().regex(ID_PATTERN),
         brief: z.string().min(1),
-        rung: z.string().min(3),
+        rung: z.string().min(3).optional(),
         thread: z.string().optional(),
         lane: z.string().regex(ID_PATTERN).optional(),
         next: z.string().optional(),
````

Edit `src/services/dispatch-service.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/dispatch-service.ts b/src/services/dispatch-service.ts
index d30aec0..235d42b 100644
--- a/src/services/dispatch-service.ts
+++ b/src/services/dispatch-service.ts
@@ -34,7 +34,8 @@ import {
 import { finalizeDispatch, finalizingElsewhere, waitForFinish } from "./finalize.ts";
 import type { Deps } from "./ports.ts";
 import { route } from "./lane-service.ts";
-import { findRun, readRecords, readRoutes, type Run } from "./run-store.ts";
+import { currentRoute } from "../domain/route.ts";
+import { appendRoute, findRun, readRecords, readRoleRoutes, readRoutes, type Run } from "./run-store.ts";
 import { claimRun, ownsRun, runOwner } from "./sessions.ts";
 import { type NotesPatch, refreshState } from "./state.ts";
 
@@ -43,7 +44,8 @@ export interface DispatchInput {
   role: Role;
   name: string;
   brief: string;
-  rung: string;
+  /** spec 1.5 plan 24: optional with `lane` (the lane's current rung); required without one */
+  rung?: string;
   thread?: string;
   lane?: string;
   next?: string;
@@ -289,16 +291,25 @@ export async function dispatch(deps: Deps, i: DispatchInput): Promise<DispatchSt
   const run = findRun(i.run);
   await claim(deps, run);
   const hints: string[] = [];
-  let rung = i.rung;
-  // spec 1.1 §6: a lane is routed before its first dispatch; a rung off the routed ladder starts at the routed one
-  if (i.lane !== undefined && !readRoutes(run).some((r) => r.lane === i.lane)) {
+  let rung: string;
+  if (i.lane !== undefined) {
     assertId("lane", i.lane);
-    const routed = await route(deps, { run: i.run, laneFile: `lanes/${i.lane}.md`, role: i.role });
-    if (!routed.ladder.includes(i.rung)) {
+    // spec 1.1 §6: a lane is routed before its first dispatch; a rung off the routed ladder starts at the routed one
+    const current = currentRoute(readRoutes(run), i.lane);
+    const routed = current
+      ? null
+      : await route(deps, { run: i.run, laneFile: `lanes/${i.lane}.md`, role: i.role });
+    // spec 1.5 plan 24: without a rung, a lane runs at its current rung (its route, after any climb)
+    rung = i.rung ?? routed?.rung ?? (current?.rung as string);
+    if (routed && i.rung !== undefined && !routed.ladder.includes(i.rung)) {
       rung = routed.rung;
       hints.push(`${i.rung} is not on ${i.lane}'s routed ladder: dispatched at ${routed.rung}`);
     }
-  }
+  } else if (i.rung === undefined)
+    throw new CatherdError("E_INPUT_INVALID", `dispatch ${i.name}: a role outside a lane needs a rung`, {
+      fix: `route(run, role: "${i.role}") gives the role's rung; pass it as rung`,
+    });
+  else rung = i.rung;
   // the rung that runs, after routing: an off-ladder native rung routing replaced is never launched
   assertNativeHost(rung, deps.host.host);
   const { d, specPath } = await admit(
@@ -324,10 +335,40 @@ export async function dispatch(deps: Deps, i: DispatchInput): Promise<DispatchSt
     // a launch that failed is still watched: its record (lost, after the start grace) is announced
     watch(deps, run, d);
   }
+  if (i.lane === undefined) recordRoleDispatch(deps, run, i.role, i.name, rung);
   await refresh(run, i.next ? { next: i.next } : {}, hints);
   return { dispatched: dispatchedOf(d), hints };
 }
 
+/**
+ * Spec 1.5 plan 24: a lane-less dispatch's rung in routes.jsonl, so every role's decision can be audited:
+ * `route` when it is the rung the role's last `route` gave (with that ladder), else the coordinator's own pick.
+ * A failed write is logged, never a failed dispatch: the role is already running.
+ */
+function recordRoleDispatch(deps: Deps, run: Run, role: Role, name: string, rung: string): void {
+  try {
+    const last = readRoleRoutes(run).findLast((r) => r.role === role && r.source === "route");
+    const routed = last?.rung === rung;
+    appendRoute(run, {
+      at: new Date(deps.now()).toISOString(),
+      lane: null,
+      role,
+      name,
+      rung,
+      ladder: last?.ladder ?? [rung],
+      source: "dispatch",
+      decidedBy: routed ? last.decidedBy : "orchestrator",
+      why: routed
+        ? `the rung route gave the ${role}`
+        : last
+          ? `the coordinator's rung; route gave the ${role} ${last.rung}`
+          : `the coordinator's rung; the ${role} was never routed`,
+    });
+  } catch (e) {
+    log("warn", "dispatch", { run: run.id, name, routes: errorMessage(e) });
+  }
+}
+
 /** How long a settle waits for another process's failover of the same dispatch (a test seam). */
 export const failoverLock = { timeoutMs: 120_000 };
 
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/services/dispatch-protocol.test.ts test/services/lanes-run.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS.

- [ ] **Step 5: Commit**

````bash
git add plugin/skills/catherd/SKILL.md src/entry/mcp/dispatch-tools.ts src/services/dispatch-service.ts test/services/dispatch-protocol.test.ts test/services/lanes-run.test.ts
git commit -m "feat(dispatch): take rung optionally on a lane and record a lane-less dispatch's rung"
````

---

### Task 7: `route(run, lanes)` routes a milestone's lanes in one call, asking Jev about all of them at once (spec bullets 1, 10; Rulings 6, 7)

The routing service splits a route into `prepare` (routing profile, discovery refresh, catalog), `judge` (Jev, or nothing) and `decide`. `routeMany(reqs)` prepares once, judges every lane in parallel (one request each, all in flight together) and decides them in order, each routed start counting as a use of its quota so lanes that tie spread over the quotas. The lane service's `routeLanes(deps, { run, laneFiles, role })` refuses a lane named twice, builds every request (usage: the run's dispatches plus routed, undispatched lanes at their current rung, `runUsage`), calls `route` for one lane and `routeMany` for several, and records each answer as Task 5 does; `route` is `routeLanes` with one file. The `route` tool takes `lanes` (refusing it beside `lane_file`) and returns `{ routes: [...] }`. The skill routes a milestone's lanes in one call and says the header decides and a ladder only goes up.

**Interfaces:**
- Consumes: Task 5's `RouteResult`, `record` path, `decide` order.
- Produces: `RoutingPort.routeMany(reqs: RouteRequest[]): Promise<RouteAnswer[]>` (the test fake maps `route`); `routeLanes(deps, { run, laneFiles: (string | undefined)[], role }): Promise<RouteResult[]>`; the `route` tool's `lanes?: string[]`.

**Scratch commit:** `f5ae7d5` (feat(routing): route a milestone's lanes in one call, asking Jev about all at once).

**Files:**
- Modify: `plugin/skills/catherd/SKILL.md`
- Modify: `src/entry/mcp/lane-tools.ts`
- Modify: `src/services/lane-service.ts`
- Modify: `src/services/ports.ts`
- Modify: `src/services/routing-service.ts`
- Create: `test/entry/mcp-route.test.ts`
- Modify: `test/services/helpers.ts`
- Modify: `test/services/route-records.test.ts`
- Modify: `test/services/routing-service.test.ts`
- Modify: `test/skills.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/entry/mcp-route.test.ts` (new file):

````diff
diff --git a/test/entry/mcp-route.test.ts b/test/entry/mcp-route.test.ts
new file mode 100644
index 0000000..7bcc227
--- /dev/null
+++ b/test/entry/mcp-route.test.ts
@@ -0,0 +1,43 @@
+import { afterEach, describe, expect, it } from "bun:test";
+import { writeRunFile } from "../../src/services/run-service.ts";
+import { snapshotEnv } from "../helpers.ts";
+import { call, mcpClient } from "../mcp-helpers.ts";
+import { fakeDeps, freshRun } from "../services/helpers.ts";
+
+afterEach(snapshotEnv());
+
+const laneText = (id: string) =>
+  [`# ${id}`, `Owns: src/${id}.ts`, "Fast check: bun test", "Kind: repo_code", "Difficulty: build", "x"].join(
+    "\n",
+  );
+
+describe("the route tool (spec 1.5 plan 24)", () => {
+  it("routes several lanes in one call and returns little for each", async () => {
+    const { run } = freshRun();
+    for (const id of ["M1.L1", "M1.L2"])
+      writeRunFile({ run: run.id, path: `lanes/${id}.md`, content: laneText(id) });
+    const c = await mcpClient(fakeDeps());
+    const r = await call(c, "route", { run: run.id, lanes: ["lanes/M1.L1.md", "lanes/M1.L2.md"] });
+    expect(r.isError).toBe(false);
+    expect(r.data.routes.map((x: { lane: string }) => x.lane)).toEqual(["M1.L1", "M1.L2"]);
+    expect(Object.keys(r.data.routes[0]).sort()).toEqual([
+      "agent",
+      "backend",
+      "ladder",
+      "lane",
+      "role",
+      "rung",
+      "why",
+    ]);
+  });
+
+  it("refuses lane_file and lanes together", async () => {
+    const { run } = freshRun();
+    const c = await mcpClient(fakeDeps());
+    const r = await call(c, "route", { run: run.id, lane_file: "lanes/M1.L1.md", lanes: ["lanes/M1.L1.md"] });
+    expect(r.error).toMatchObject({
+      code: "E_INPUT_INVALID",
+      message: "route takes lane_file or lanes, not both",
+    });
+  });
+});
````

Edit `test/services/helpers.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/helpers.ts b/test/services/helpers.ts
index 53f30ed..842002f 100644
--- a/test/services/helpers.ts
+++ b/test/services/helpers.ts
@@ -70,6 +70,10 @@ export function fakeDeps(
         why: "the role's default rung",
       };
     },
+    // a test that replaces route gets it for every lane of a batch too
+    async routeMany(reqs) {
+      return Promise.all(reqs.map((r) => routing.route(r)));
+    },
     finding: async (_runDir, _laneText, _finding, _use) => ({
       value: "code",
       probability: null,
````

Edit `test/services/route-records.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/route-records.test.ts b/test/services/route-records.test.ts
index 12508f8..f4e90c9 100644
--- a/test/services/route-records.test.ts
+++ b/test/services/route-records.test.ts
@@ -1,5 +1,5 @@
 import { afterEach, describe, expect, it } from "bun:test";
-import { route } from "../../src/services/lane-service.ts";
+import { route, routeLanes } from "../../src/services/lane-service.ts";
 import { readRoleRoutes, readRoutes } from "../../src/services/run-store.ts";
 import { snapshotEnv } from "../helpers.ts";
 import { fakeDeps, freshRun, LADDER, writeLane } from "./helpers.ts";
@@ -68,3 +68,55 @@ describe("every role's decision in routes.jsonl (spec 1.5 plan 24)", () => {
     expect(readRoleRoutes(run)).toEqual([]);
   });
 });
+
+describe("batch route through the lane service (spec 1.5 plan 24)", () => {
+  it("routes and records each lane in order, in one call to the routing port", async () => {
+    const { run } = freshRun();
+    const deps = fakeDeps();
+    let batches = 0;
+    const single = deps.routing.route;
+    deps.routing.routeMany = async (reqs) => {
+      batches++;
+      return Promise.all(reqs.map((r) => single(r)));
+    };
+    for (const id of ["M1.L1", "M1.L2"]) writeLane(run, id, [`src/${id}.ts`]);
+    const out = await routeLanes(deps, {
+      run: run.id,
+      laneFiles: ["lanes/M1.L1.md", "lanes/M1.L2.md"],
+      role: "worker",
+    });
+    expect(batches).toBe(1);
+    expect(out.map((r) => r.lane)).toEqual(["M1.L1", "M1.L2"]);
+    expect(readRoutes(run).map((r) => [r.lane, r.source])).toEqual([
+      ["M1.L1", "route"],
+      ["M1.L2", "route"],
+    ]);
+  });
+
+  it("refuses a lane named twice, before asking anything", async () => {
+    const { run } = freshRun();
+    writeLane(run, "M1.L1", ["src/a.ts"]);
+    const err = await routeLanes(fakeDeps(), {
+      run: run.id,
+      laneFiles: ["lanes/M1.L1.md", "lanes/M1.L1.md"],
+      role: "worker",
+    }).catch((e: unknown) => e);
+    expect(err).toMatchObject({ code: "E_INPUT_INVALID", message: "route: lane M1.L1 is named twice" });
+    expect(readRoutes(run)).toEqual([]);
+  });
+
+  it("counts a lane routed but not dispatched as a use of its quota", async () => {
+    const { run } = freshRun();
+    const deps = fakeDeps();
+    const seen: Record<string, number>[] = [];
+    const single = deps.routing.route;
+    deps.routing.route = async (r) => {
+      seen.push(r.usage ?? {});
+      return single(r);
+    };
+    for (const id of ["M1.L1", "M1.L2"]) writeLane(run, id, [`src/${id}.ts`]);
+    await route(deps, { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
+    await route(deps, { run: run.id, laneFile: "lanes/M1.L2.md", role: "worker" });
+    expect(seen).toEqual([{}, { codex: 1 }]);
+  });
+});
````

Edit `test/services/routing-service.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/routing-service.test.ts b/test/services/routing-service.test.ts
index 69024df..d047f90 100644
--- a/test/services/routing-service.test.ts
+++ b/test/services/routing-service.test.ts
@@ -556,3 +556,48 @@ describe("route and quota headroom (spec 1.5 plan 24)", () => {
     expect(b.ladder).toContain(LADDER[0] as string);
   });
 });
+
+describe("batch route (spec 1.5 plan 24)", () => {
+  it("asks Jev about every lane at once, and decides each one", async () => {
+    // each answer is held until both questions are in flight: asked one after the other, the first would hang
+    const held: (() => void)[] = [];
+    let asked = 0;
+    const impl = (async () => {
+      asked++;
+      if (asked < 2) await new Promise<void>((resolve) => held.push(resolve));
+      else for (const go of held) go();
+      return new Response(JSON.stringify(fx("route-v2-track-a.json")), { status: 200 });
+    }) as unknown as typeof fetch;
+    const svc = routingService({ key: "k", fetchImpl: impl, attemptMs: 2_000, ...noWait });
+    const dir = runDir();
+    const one = (id: string) => ({ ...req(lane(null, null)), runDir: dir, lane: id });
+    const out = await svc.routeMany([one("M1.L1"), one("M1.L2")]);
+    expect(asked).toBe(2);
+    expect(out.map((a) => [a.source, a.rung])).toEqual([
+      ["jev", TRACK_A.rung],
+      ["jev", TRACK_A.rung],
+    ]);
+    expect(jevRows(dir).map((r) => r.lane)).toEqual(["M1.L1", "M1.L2"]);
+  });
+
+  it("spreads lanes that tie over the quotas, each routed start counting as a use", async () => {
+    const GO_LUNA = "opencode:opencode-go/gpt-6-luna#high";
+    const profile = view({
+      roles: {
+        ...testView().roles,
+        worker: {
+          enabled: true,
+          access: "workspace-write",
+          rungs: [LADDER[0] as string, GO_LUNA, ...LADDER.slice(1)],
+          defaultRung: "codex:gpt-6-sol#medium",
+        },
+      },
+    });
+    const one = () => req(lane("repo_code", "copy"), { profile });
+    const out = await routingService().routeMany([one(), one(), one()]);
+    expect(out.map((a) => a.rung)).toEqual([LADDER[0] as string, GO_LUNA, LADDER[0] as string]);
+    expect(out[1]?.tie).toMatch(
+      /opencode-go has the most headroom \(dispatches in this run: codex 1, opencode-go 0\)$/,
+    );
+  });
+});
````

Edit `test/skills.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/skills.test.ts b/test/skills.test.ts
index df1270b..42d580c 100644
--- a/test/skills.test.ts
+++ b/test/skills.test.ts
@@ -234,9 +234,14 @@ describe("orchestrator skill, run findings", () => {
     expect(md()).toContain('`source: "jev-kind"`');
   });
 
-  it("no longer claims the routes run at once", () => {
+  it("routes a milestone's lanes in one call (spec 1.5 plan 24)", () => {
     expect(md()).not.toContain("all in one message");
-    expect(md()).toContain('`route(run, "lanes/Mx.Ly.md")` for every lane, one call per lane');
+    expect(md()).toContain('`route(run, lanes: ["lanes/Mx.L1.md", …])` once for the milestone\'s lanes');
+  });
+
+  it("says the lane's header decides and a ladder only goes up (spec 1.5 plan 24)", () => {
+    expect(md()).toContain("A lane file that declares both `Kind:` and `Difficulty:` routes on them");
+    expect(md()).toContain("A ladder holds only rungs at least as strong as its start");
   });
 
   it("offers no Codex harness figure", () => {
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/entry/mcp-route.test.ts test/services/route-records.test.ts test/services/routing-service.test.ts test/skills.test.ts`
Expected: FAIL: `routeLanes` is not exported by `src/services/lane-service.ts`; `routingService().routeMany` does not exist; the `route` tool has no `lanes`; the second of two single routes sees no usage for the first.

- [ ] **Step 3: Implement**

Edit `plugin/skills/catherd/SKILL.md` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/plugin/skills/catherd/SKILL.md b/plugin/skills/catherd/SKILL.md
index e59e648..baebd54 100644
--- a/plugin/skills/catherd/SKILL.md
+++ b/plugin/skills/catherd/SKILL.md
@@ -39,27 +39,27 @@ Native headless Codex and Claude Code roles receive a dedicated `catherd_role` M
 
 Pass the actual project `repo` explicitly to profile, setup and catalog tools that accept it. The native Codex MCP server starts in the installed plugin root, so its cwd is not evidence of the project. `run_start(repo, ...)` establishes the run's repository.
 
-| Tool                                                                                                  | Use                                                                                                                                                                                                                                                                                                                                              |
-| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
-| `status(run?)`                                                                                        | First, and whenever the user asks where it stands: `version`, then per run the open owner questions, the `state.md` tail, live roles, totals, Claude subagents, the verifier's step, budget, milestones                                                                                                                                          |
-| `run_start(repo, title, a_lines)`                                                                     | Once per project. Returns `run`, the id every other call takes, `dir`, the run folder `R`, and `protocol`: the next step of the milestone loop and its six-line checklist                                                                                                                                                                        |
-| `peek(run?, name?)`                                                                                   | Never waits. Per run: the open owner questions first (the owner's to answer), each live role with its rung, time and last event, every finished record not yet read, the next step, the verifier's step, and `protocol` (the milestone loop's next step and the checklist). It marks nothing read: `result` does                                 |
-| `route(run, lane_file?, role?)`                                                                       | A lane's rung (from the lane file's `Kind:`/`Difficulty:` when it declares both, else Jev, else the profile), or a role's rung. Returns `rung`, `ladder` (only rungs at least as strong as the start), `backend`, `agent` and a one-line `why`; the full provenance goes to `R/routes.jsonl`                                                     |
-| `preflight(run, confirmed?)`                                                                          | Each lane's fast check once, before any lane runs. Outcomes below                                                                                                                                                                                                                                                                                |
-| `dispatch(run, role, name, brief, rung?, thread?, lane?, next?)`                                      | Starts one process role (Codex, claude-code or opencode) and returns at launch, in about a second, with `dispatched`. It routes a lane not routed yet, runs a lane at its current rung when `rung` is left out (a role outside a lane needs `rung`), appends the role's reply contract to the brief, and its result arrives as a catherd message |
-| `result(run, name)`                                                                                   | A role's latest reply, capped, its record and its `hints`; reading a finished record marks it read                                                                                                                                                                                                                                               |
-| `cancel(run, name)`                                                                                   | Stops a live role and returns its record, `cancelled`, and `hints`                                                                                                                                                                                                                                                                               |
-| `record_agent_run(run, name, role, rung, total_tokens, duration_ms?, cost_usd?, status?, lane?)`      | Native Claude Agent results on Claude Code only. The budget counts them; `lane` counts their time toward that lane's kind; a verifier named `verifier-<M>` records FAIL with `status: "failed"`                                                                                                                                                  |
-| `climb(run, lane, reason, evidence?, env?)`                                                           | The lane's next rung, with its `backend` and `agent`, or `top: true`. `env: true` when the environment, not the rung, caused it                                                                                                                                                                                                                  |
-| `ask(run, question, state)`                                                                           | Jev's `finding` or `same-defect` answer                                                                                                                                                                                                                                                                                                          |
-| `gate_check(run, item, command, paths, milestone?)`, `gate_pass(run, item, command, paths, evidence)` | The verifier's gate ledger: an item that passed on the same content is carried over, not run again; `milestone` scopes the digest's carried items                                                                                                                                                                                                |
-| `park(run, milestone, question)`, `answer(run, milestone, answer)`                                    | An owner question parks its milestone while the rest of the run goes on; the owner's answer unparks it                                                                                                                                                                                                                                           |
-| `land(run, milestone, what, commit, evidence, next, learned?, skip?)`                                 | A landed milestone's ledger row, with the minutes it took, `state.md`, and `digest`, the milestone's digest. Refused until the milestone has its reviewer and its verifier. `learned` appends to this repo's `knowledge.md`                                                                                                                      |
-| `read_knowledge(repo)`                                                                                | What past runs of this repo learned. The dossier brief reads it                                                                                                                                                                                                                                                                                  |
-| `write_run_file(run, path, content)`, `read_run_file(run, path)`                                      | Files in `R`. Never your own Write or Read tools there: `R` is outside the repo                                                                                                                                                                                                                                                                  |
-| `set_next(run, next)`                                                                                 | The next step, when you pause or the plan changes. Returns `state` and, when git fails, `hints`                                                                                                                                                                                                                                                  |
-| `runs_summary(run?, repo?, role?, since_days?)`                                                       | Time, tokens, refusals and climbs per role and rung, the Claude subagent runs, and the harness cost, for the report                                                                                                                                                                                                                              |
-| `profile_get(repo?)`                                                                                  | The profile this repo runs on: each role's access, rungs and enforcement, failover, budget, timeouts, and the moments to push                                                                                                                                                                                                                    |
+| Tool                                                                                                  | Use                                                                                                                                                                                                                                                                                                                                                                  |
+| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
+| `status(run?)`                                                                                        | First, and whenever the user asks where it stands: `version`, then per run the open owner questions, the `state.md` tail, live roles, totals, Claude subagents, the verifier's step, budget, milestones                                                                                                                                                              |
+| `run_start(repo, title, a_lines)`                                                                     | Once per project. Returns `run`, the id every other call takes, `dir`, the run folder `R`, and `protocol`: the next step of the milestone loop and its six-line checklist                                                                                                                                                                                            |
+| `peek(run?, name?)`                                                                                   | Never waits. Per run: the open owner questions first (the owner's to answer), each live role with its rung, time and last event, every finished record not yet read, the next step, the verifier's step, and `protocol` (the milestone loop's next step and the checklist). It marks nothing read: `result` does                                                     |
+| `route(run, lane_file?, lanes?, role?)`                                                               | A lane's rung (from the lane file's `Kind:`/`Difficulty:` when it declares both, else Jev, else the profile), or a role's rung; `lanes` routes several lane files in one call (`routes`, one per lane). Returns `rung`, `ladder` (only rungs at least as strong as the start), `backend`, `agent` and a one-line `why`; the full provenance goes to `R/routes.jsonl` |
+| `preflight(run, confirmed?)`                                                                          | Each lane's fast check once, before any lane runs. Outcomes below                                                                                                                                                                                                                                                                                                    |
+| `dispatch(run, role, name, brief, rung?, thread?, lane?, next?)`                                      | Starts one process role (Codex, claude-code or opencode) and returns at launch, in about a second, with `dispatched`. It routes a lane not routed yet, runs a lane at its current rung when `rung` is left out (a role outside a lane needs `rung`), appends the role's reply contract to the brief, and its result arrives as a catherd message                     |
+| `result(run, name)`                                                                                   | A role's latest reply, capped, its record and its `hints`; reading a finished record marks it read                                                                                                                                                                                                                                                                   |
+| `cancel(run, name)`                                                                                   | Stops a live role and returns its record, `cancelled`, and `hints`                                                                                                                                                                                                                                                                                                   |
+| `record_agent_run(run, name, role, rung, total_tokens, duration_ms?, cost_usd?, status?, lane?)`      | Native Claude Agent results on Claude Code only. The budget counts them; `lane` counts their time toward that lane's kind; a verifier named `verifier-<M>` records FAIL with `status: "failed"`                                                                                                                                                                      |
+| `climb(run, lane, reason, evidence?, env?)`                                                           | The lane's next rung, with its `backend` and `agent`, or `top: true`. `env: true` when the environment, not the rung, caused it                                                                                                                                                                                                                                      |
+| `ask(run, question, state)`                                                                           | Jev's `finding` or `same-defect` answer                                                                                                                                                                                                                                                                                                                              |
+| `gate_check(run, item, command, paths, milestone?)`, `gate_pass(run, item, command, paths, evidence)` | The verifier's gate ledger: an item that passed on the same content is carried over, not run again; `milestone` scopes the digest's carried items                                                                                                                                                                                                                    |
+| `park(run, milestone, question)`, `answer(run, milestone, answer)`                                    | An owner question parks its milestone while the rest of the run goes on; the owner's answer unparks it                                                                                                                                                                                                                                                               |
+| `land(run, milestone, what, commit, evidence, next, learned?, skip?)`                                 | A landed milestone's ledger row, with the minutes it took, `state.md`, and `digest`, the milestone's digest. Refused until the milestone has its reviewer and its verifier. `learned` appends to this repo's `knowledge.md`                                                                                                                                          |
+| `read_knowledge(repo)`                                                                                | What past runs of this repo learned. The dossier brief reads it                                                                                                                                                                                                                                                                                                      |
+| `write_run_file(run, path, content)`, `read_run_file(run, path)`                                      | Files in `R`. Never your own Write or Read tools there: `R` is outside the repo                                                                                                                                                                                                                                                                                      |
+| `set_next(run, next)`                                                                                 | The next step, when you pause or the plan changes. Returns `state` and, when git fails, `hints`                                                                                                                                                                                                                                                                      |
+| `runs_summary(run?, repo?, role?, since_days?)`                                                       | Time, tokens, refusals and climbs per role and rung, the Claude subagent runs, and the harness cost, for the report                                                                                                                                                                                                                                                  |
+| `profile_get(repo?)`                                                                                  | The profile this repo runs on: each role's access, rungs and enforcement, failover, budget, timeouts, and the moments to push                                                                                                                                                                                                                                        |
 
 **A tool returns `hints` when it has any:** one line each, on what to do next. Read them before you move on.
 
@@ -136,18 +136,20 @@ authorization and repository rules; there is no automatic commit, push or rollba
 
 A lane starts on the lowest rung that can do it, and climbs one rung when it shows it cannot. The ladders come from the profile and the catalog. With the default profile:
 
-| Track | Lanes                                                                         | Rungs, low to high                                                                                    |
-| ----- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
-| A     | `copy` or `build`: an existing pattern, a clear fast check                    | `codex:gpt-6-luna#high` → `codex:gpt-6-sol#medium` → `codex:gpt-6-sol#high` → `codex:gpt-6-sol#xhigh` |
-| B     | `logic` or `hard`, or `terminal` work: state, concurrency, ops, unclear cause | `codex:gpt-6-sol#medium` → `codex:gpt-6-sol#high` → `codex:gpt-6-sol#xhigh`                           |
+| Track | Lanes                                                                         | Rungs, low to high                                                          |
+| ----- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
+| A     | `copy` or `build`: an existing pattern, a clear fast check                    | `codex:gpt-6-luna#high` → `codex:gpt-6-sol#xhigh`                           |
+| B     | `logic` or `hard`, or `terminal` work: state, concurrency, ops, unclear cause | `codex:gpt-6-sol#medium` → `codex:gpt-6-sol#high` → `codex:gpt-6-sol#xhigh` |
 
-**Jev picks the start, when the user has it.** Jev (TypeSafe) is a decision model: it answers a fixed set of questions about the lane with calibrated probabilities, usually in well under a second, for a fraction of a cent; `route` gives up on it after 25 s. It is optional. When its probabilities do not settle the track, or with no Jev key, `route` uses the lane file's `Kind:` and `Difficulty:` lines (`source: "lane"`), else the profile's default (`source: "default"`), so the run never waits on it. When Jev is sure of the kind but not the difficulty, `route` keeps Jev's kind and takes the difficulty from the lane's `Difficulty:` line, else the role's default (`source: "jev-kind"`). Every Jev call is logged to `R/jev.jsonl`, without the lane's text.
+A ladder holds only rungs at least as strong as its start on the lane's bar, so a climb never lands lower. When no rung clears a lane's bar, `route`'s `why` says so and names the closest rung; when rungs on two quotas score the same, the start goes to the quota the run has used least, and `why` says a tie decided.
 
-| When                                          | Call                                                                          | On the answer                               |
-| --------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------- |
-| Each lane, before its first dispatch          | `route(run, "lanes/Mx.Ly.md")`                                                | Dispatch it at `rung`                       |
-| A review finding that may be the plan's fault | `ask(run, "finding", { lane_file: "lanes/Mx.Ly.md", finding: "<the line>" })` | `design` → the architect. Else → the worker |
-| A finding back after its fix round            | `ask(run, "same-defect", { before: "<old line>", after: "<new line>" })`      | `yes` → climb one rung                      |
+**The lane's header decides; Jev fills in what it leaves out.** A lane file that declares both `Kind:` and `Difficulty:` routes on them (`source: "lane"`), and `why` says where Jev disagreed. Jev (TypeSafe) is a decision model: it answers a fixed set of questions about the lane with calibrated probabilities, usually in well under a second, for a fraction of a cent; `route` gives up on it after 25 s. It is optional. For a lane without both lines, `route` takes Jev's answer when its probabilities settle the track (`source: "jev"`), else the profile's default (`source: "default"`), so the run never waits on it. When Jev is sure of the kind but not the difficulty, `route` keeps the lane's kind if it has one, else keeps Jev's kind and takes the difficulty from the lane's `Difficulty:` line, else the role's default (`source: "jev-kind"`). Every Jev call is logged to `R/jev.jsonl`, without the lane's text, and every decision to `R/routes.jsonl`.
+
+| When                                             | Call                                                                          | On the answer                               |
+| ------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------- |
+| A milestone's lanes, before their first dispatch | `route(run, lanes: ["lanes/Mx.L1.md", …])`                                    | Dispatch each at its `rung`                 |
+| A review finding that may be the plan's fault    | `ask(run, "finding", { lane_file: "lanes/Mx.Ly.md", finding: "<the line>" })` | `design` → the architect. Else → the worker |
+| A finding back after its fix round               | `ask(run, "same-defect", { before: "<old line>", after: "<new line>" })`      | `yes` → climb one rung                      |
 
 **Climb one rung** with `climb(run, lane, reason, evidence)` (add `env: true` when a missing service, a broken tool or a usage limit caused it, not the rung), then dispatch the lane at the new rung on a fresh thread whose brief is the lane file plus the path of the failing evidence, when:
 
@@ -251,7 +253,7 @@ Nothing else pushes: a phone that buzzes for progress teaches the user to ignore
    - Every lane file starts with these lines: `# Mx.Ly — <title>`, `Owns: <paths>` (repo-relative, a trailing `/` for a folder, never a glob), `Fast check: <command>`, `Kind: repo_code|terminal|ui|prose|research` and `Difficulty: copy|build|logic|hard`.
    - **Plan in hand** (a `plan:` A-line): no dossier. Brief the architect with the A-lines, the run id and the plan's paths, to translate, not design: each plan task becomes lanes (`Owns:`, `Fast check:`, `Kind:`, `Difficulty:`), each MR or phase a milestone with its full check. It copies the plan's decisions into `plan.md` and the lane files, redesigns only what the plan leaves undecided, and stays the target for `design` findings.
    - **No dossier and no architect** for a polish or fix run (a list of known defects or tweaks to code that exists) or a single mechanical task. You write the lane files yourself with `write_run_file`, straight from the A-lines: one lane per cluster of defects that share files, with owned files found by `grep -n`, and the same header lines.
-4. **Route and preflight.** `route(run, "lanes/Mx.Ly.md")` for every lane, one call per lane; each may wait up to 25 s on Jev (`dispatch` routes a lane you missed, and starts it at the routed rung when yours is off its ladder). `route`, `preflight` and `dispatch` refuse a lane whose `Kind:` or `Difficulty:` the catalog does not know (`E_LANE_INVALID`). Then, once every lane file exists, `preflight(run)` once, before dispatching any lane. Each lane comes back as one of:
+4. **Route and preflight.** `route(run, lanes: ["lanes/Mx.L1.md", …])` once for the milestone's lanes: Jev is asked about all of them at once, where one call per lane may wait up to 25 s each (`dispatch` routes a lane you missed, and starts it at the routed rung when yours is off its ladder). `route`, `preflight` and `dispatch` refuse a lane whose `Kind:` or `Difficulty:` the catalog does not know (`E_LANE_INVALID`). Then, once every lane file exists, `preflight(run)` once, before dispatching any lane. Each lane comes back as one of:
    - `pass`: the check already passes on the base tree;
    - `fails-as-expected`: it runs and fails, because the lane has not been done yet;
    - `skipped`: it checks a file the lane creates;
````

Edit `src/entry/mcp/lane-tools.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/mcp/lane-tools.ts b/src/entry/mcp/lane-tools.ts
index 7b1bda8..e593864 100644
--- a/src/entry/mcp/lane-tools.ts
+++ b/src/entry/mcp/lane-tools.ts
@@ -2,8 +2,9 @@ import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 import { z } from "zod";
 import { ID_PATTERN } from "../../domain/ids.ts";
 import { ROLES } from "../../domain/roles.ts";
+import { CatherdError } from "../../domain/errors.ts";
 import { CLIMB_REASONS } from "../../domain/route.ts";
-import { ask, climb, LAND_SKIPS, land, route } from "../../services/lane-service.ts";
+import { ask, climb, LAND_SKIPS, land, route, routeLanes } from "../../services/lane-service.ts";
 import type { Deps } from "../../services/ports.ts";
 import { preflight } from "../../services/preflight.ts";
 import { handle } from "./result.ts";
@@ -13,14 +14,24 @@ export function registerLaneTools(server: McpServer, deps: Deps): void {
     "route",
     {
       description:
-        "The rung for a lane (from the lane file's Kind/Difficulty lines when it declares both, else Jev, else the profile default) or, without a lane file, a role's default rung, with the ladder above it: only rungs at least as strong as the start. Rungs are backend:model#effort; a claude: rung comes with the agent to run it as. Returns rung, ladder, backend, agent and why: one line naming the decision, where Jev disagreed with the lane's header, when no rung clears the bar (and the closest), and when a tie between quotas decided. Every decision, with its provenance (each threshold, the value used, its source and date, the rung's cost and run evidence), is written to the run's routes.jsonl. A lane whose Kind: or Difficulty: the catalog does not know is refused with E_LANE_INVALID.",
+        "The rung for a lane (from the lane file's Kind/Difficulty lines when it declares both, else Jev, else the profile default), or with lanes (several lane files) for each of them in one call, Jev asked about all at once ({ routes: [...] }, in order), or, without a lane file, a role's default rung, with the ladder above it: only rungs at least as strong as the start. Rungs are backend:model#effort; a claude: rung comes with the agent to run it as. Returns rung, ladder, backend, agent and why: one line naming the decision, where Jev disagreed with the lane's header, when no rung clears the bar (and the closest), and when a tie between quotas decided. Every decision, with its provenance (each threshold, the value used, its source and date, the rung's cost and run evidence), is written to the run's routes.jsonl. A lane whose Kind: or Difficulty: the catalog does not know is refused with E_LANE_INVALID.",
       inputSchema: {
         run: z.string(),
         lane_file: z.string().optional(),
+        lanes: z.array(z.string()).min(1).optional(),
         role: z.enum(ROLES).default("worker"),
       },
     },
-    (a) => handle(() => route(deps, { run: a.run, laneFile: a.lane_file, role: a.role })),
+    (a) =>
+      handle(async () => {
+        if (a.lanes && a.lane_file !== undefined)
+          throw new CatherdError("E_INPUT_INVALID", "route takes lane_file or lanes, not both", {
+            fix: "pass every lane file in lanes",
+          });
+        return a.lanes
+          ? { routes: await routeLanes(deps, { run: a.run, laneFiles: a.lanes, role: a.role }) }
+          : route(deps, { run: a.run, laneFile: a.lane_file, role: a.role });
+      }),
   );
 
   server.registerTool(
````

Edit `src/services/lane-service.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/lane-service.ts b/src/services/lane-service.ts
index c32235d..dd219de 100644
--- a/src/services/lane-service.ts
+++ b/src/services/lane-service.ts
@@ -78,15 +78,50 @@ function readLaneFile(run: Run, path: string): { lane: string; text: string } {
   return { lane, text };
 }
 
-/** Spec §5.4 through the routing port; a lane's route is recorded in routes.jsonl. */
+/**
+ * Spec 1.5 plan 24: the run's dispatches per quota, plus each lane routed but not dispatched yet at its current
+ * rung, so a tie between quotas goes to the one the run will have used least.
+ */
+function runUsage(run: Run): Record<string, number> {
+  const records = readRecords(run).records;
+  const dispatched = new Set(records.flatMap((r) => (r.lane ? [r.lane] : [])));
+  const routes = readRoutes(run);
+  const waiting = [...new Set(routes.map((r) => r.lane))]
+    .filter((l) => !dispatched.has(l))
+    .flatMap((l) => currentRoute(routes, l)?.rung ?? []);
+  return quotaUsage([...records.map((r) => r.rung), ...waiting]);
+}
+
+/** Spec §5.4 through the routing port; every decision is recorded in routes.jsonl. */
 export async function route(
   deps: Deps,
   i: { run: string; laneFile?: string; role: Role },
 ): Promise<RouteResult> {
+  const [one] = await routeLanes(deps, { run: i.run, laneFiles: [i.laneFile], role: i.role });
+  return one as RouteResult;
+}
+
+/**
+ * Spec 1.5 plan 24, batch `route`: several lanes of one role in one call (Jev asked about all at once), each
+ * recorded as `route` records one. `laneFiles` holds `undefined` for a role routed without a lane.
+ */
+export async function routeLanes(
+  deps: Deps,
+  i: { run: string; laneFiles: (string | undefined)[]; role: Role },
+): Promise<RouteResult[]> {
   const run = findRun(i.run);
-  const lane = i.laneFile === undefined ? null : readLaneFile(run, i.laneFile);
+  const lanes = i.laneFiles.map((f) => (f === undefined ? null : readLaneFile(run, f)));
+  const dup = lanes.find((l, n) => l && lanes.findIndex((x) => x?.lane === l.lane) !== n);
+  if (dup)
+    throw new CatherdError("E_INPUT_INVALID", `route: lane ${dup.lane} is named twice`, {
+      fix: "name each lane file once",
+    });
   const profile = deps.profiles.forRepo(run.meta.repo);
-  const a = await deps.routing.route({
+  const spentFraction = Math.max(
+    budgetOf(run, profile.budget, deps.now())?.fraction ?? 0,
+    (await workspaceBudget(run, deps.now()))?.fraction ?? 0,
+  );
+  const reqs = lanes.map((lane) => ({
     host: deps.host.host,
     runDir: run.dir,
     repo: run.meta.repo,
@@ -94,14 +129,25 @@ export async function route(
     role: i.role,
     lane: lane?.lane ?? null,
     laneText: lane?.text ?? null,
-    usage: quotaUsage(readRecords(run).records.map((r) => r.rung)),
-    spentFraction: Math.max(
-      budgetOf(run, profile.budget, deps.now())?.fraction ?? 0,
-      (await workspaceBudget(run, deps.now()))?.fraction ?? 0,
-    ),
-  });
+    usage: runUsage(run),
+    spentFraction,
+  }));
+  const answers =
+    reqs.length === 1
+      ? [await deps.routing.route(reqs[0] as (typeof reqs)[number])]
+      : await deps.routing.routeMany(reqs);
+  return answers.map((a, n) => record(deps, run, i.role, lanes[n] ?? null, a));
+}
+
+/** One decision into routes.jsonl (spec 1.5 plan 24: every role's, with its source, ladder and provenance). */
+function record(
+  deps: Deps,
+  run: Run,
+  role: Role,
+  lane: { lane: string } | null,
+  a: Awaited<ReturnType<Deps["routing"]["route"]>>,
+): RouteResult {
   const at = new Date(deps.now()).toISOString();
-  // spec 1.5 plan 24: every role's decision is recorded, with its source, ladder and provenance
   const detail = {
     why: a.why,
     ...(a.jevSaid ? { jevSaid: a.jevSaid } : {}),
@@ -113,7 +159,7 @@ export async function route(
     appendRoute(run, {
       at,
       lane: lane.lane,
-      role: i.role,
+      role,
       rung: a.rung,
       ladder: a.ladder,
       source: "route",
@@ -130,7 +176,7 @@ export async function route(
     appendRoute(run, {
       at,
       lane: null,
-      role: i.role,
+      role,
       name: null,
       rung: a.rung,
       ladder: a.ladder,
@@ -140,11 +186,11 @@ export async function route(
     });
   return {
     lane: lane?.lane ?? null,
-    role: i.role,
+    role,
     rung: a.rung,
     ladder: a.ladder,
     backend: parseRung(a.rung).backend,
-    agent: deps.profiles.agentFor(run.meta.repo, i.role, a.rung),
+    agent: deps.profiles.agentFor(run.meta.repo, role, a.rung),
     why: a.why,
   };
 }
````

Edit `src/services/ports.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/ports.ts b/src/services/ports.ts
index f814090..1f672b4 100644
--- a/src/services/ports.ts
+++ b/src/services/ports.ts
@@ -121,6 +121,8 @@ export interface CatalogFilter {
 
 export interface RoutingPort {
   route(req: RouteRequest): Promise<RouteAnswer>;
+  /** spec 1.5 plan 24: the lanes of one role in one call; Jev is asked about all of them at once */
+  routeMany(reqs: RouteRequest[]): Promise<RouteAnswer[]>;
   /** `use` is the repo profile's `jev.use`: "off" answers with the rule's default and never asks Jev */
   finding(
     runDir: string,
````

Edit `src/services/routing-service.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/routing-service.ts b/src/services/routing-service.ts
index 613d534..89e8ba5 100644
--- a/src/services/routing-service.ts
+++ b/src/services/routing-service.ts
@@ -19,6 +19,7 @@ import {
   defaultDifficulty,
   defaultLadder,
   type Pick,
+  quotaUsage,
   type RoutingProfile,
   select,
 } from "../domain/select.ts";
@@ -132,6 +133,32 @@ async function freshenWithin(rungs: string[], repo: string, ms: number): Promise
   clearTimeout(timer);
 }
 
+/** What every route of one call shares: the role's routing profile and the catalog. */
+interface Prepared {
+  p: RoutingProfile;
+  c: Catalog;
+}
+
+async function prepare(req: RouteRequest, o: RoutingOpts): Promise<Prepared> {
+  const p = routingProfile(req.profile, req.role, req.spentFraction, req.usage);
+  await freshenWithin(p.role.rungs, req.repo, o.discoveryBudgetMs ?? DISCOVERY_BUDGET_MS);
+  return { p, c: loadCatalog({ repo: req.repo }) };
+}
+
+/** Jev's answer about a lane; null when the route reads no lane or asks nothing (one usable rung). */
+interface Judged {
+  asked: Asked | null;
+  judged: ReturnType<typeof judgeRoute> | null;
+}
+
+async function judge(req: RouteRequest, { p, c }: Prepared, o: RoutingOpts): Promise<Judged | null> {
+  if (req.laneText === null || candidates(c, p, req.role).length <= 1) return null;
+  if (req.profile.jev.use === "off") return { asked: null, judged: null };
+  const asked = await askJev(req.runDir, "route-v2", laneState(req.laneText), o);
+  const judged = asked.answers ? judgeRoute(jevQuestions().sets["route-v2"].rule, asked.answers) : null;
+  return { asked, judged };
+}
+
 /**
  * Spec §5.4: kind and difficulty from the lane file's `Kind:`/`Difficulty:` when it declares both (spec 1.5
  * plan 24: a declared header wins, and `jevSaid` names where Jev disagreed), else from Jev (§5.5's rule), else
@@ -139,25 +166,17 @@ async function freshenWithin(rungs: string[], repo: string, ms: number): Promise
  * comes from the lane, else the role's default difficulty (`jev-kind`). A role with one usable rung never asks
  * Jev.
  */
-async function route(req: RouteRequest, o: RoutingOpts): Promise<RouteAnswer> {
-  const p = routingProfile(req.profile, req.role, req.spentFraction, req.usage);
-  await freshenWithin(p.role.rungs, req.repo, o.discoveryBudgetMs ?? DISCOVERY_BUDGET_MS);
-  const c = loadCatalog({ repo: req.repo });
+function decide(req: RouteRequest, { p, c }: Prepared, j: Judged | null): RouteAnswer {
   const fallback = () => defaultLadder(c, p, req.role);
   const finish = (out: RouteAnswer): RouteAnswer => {
     out.why = whyOf(out, req.laneText !== null);
     out.provenance = provenanceOf(c, out.rung, out.kind, out.difficulty, p.billing, evidenceOrNone(c));
     return out;
   };
-  if (req.laneText === null || candidates(c, p, req.role).length <= 1)
+  if (req.laneText === null || j === null)
     return finish(answer(fallback(), "default", null, null, null, null));
   const lane = parseLaneHeader(req.laneText);
-  let asked: Asked | null = null;
-  let judged: ReturnType<typeof judgeRoute> | null = null;
-  if (req.profile.jev.use !== "off") {
-    asked = await askJev(req.runDir, "route-v2", laneState(req.laneText), o);
-    if (asked.answers) judged = judgeRoute(jevQuestions().sets["route-v2"].rule, asked.answers);
-  }
+  const { asked, judged } = j;
   const jev: RouteJev | null = judged
     ? { pKind: judged.pKind, pA: judged.pA, pB: judged.pB, nouls: judged.nouls }
     : null;
@@ -200,6 +219,31 @@ async function route(req: RouteRequest, o: RoutingOpts): Promise<RouteAnswer> {
   return out;
 }
 
+async function route(req: RouteRequest, o: RoutingOpts): Promise<RouteAnswer> {
+  const prep = await prepare(req, o);
+  return decide(req, prep, await judge(req, prep, o));
+}
+
+/**
+ * Spec 1.5 plan 24, batch `route`: the lanes of one role (one run, one profile) share one discovery refresh and
+ * one catalog, and Jev is asked about all of them at once (Ruling 6: one request per lane, all in flight
+ * together, so each keeps its own cache key and jev.jsonl row). Then each lane is decided in order, every
+ * routed start counting as a use of its quota, so lanes that tie spread over the quotas.
+ */
+async function routeMany(reqs: RouteRequest[], o: RoutingOpts): Promise<RouteAnswer[]> {
+  const first = reqs[0];
+  if (!first) return [];
+  const prep = await prepare(first, o);
+  const judged = await Promise.all(reqs.map((r) => judge(r, prep, o)));
+  const usage: Record<string, number> = { ...first.usage };
+  return reqs.map((req, i) => {
+    const out = decide(req, { ...prep, p: { ...prep.p, usage: { ...usage } } }, judged[i] ?? null);
+    const q = quotaUsage([out.rung]);
+    for (const [k, n] of Object.entries(q)) usage[k] = (usage[k] ?? 0) + n;
+    return out;
+  });
+}
+
 async function verdict<T extends string>(
   runDir: string,
   set: Extract<SetName, "finding" | "same-defect">,
@@ -234,6 +278,11 @@ export function routingService(o: RoutingOpts = {}): RoutingPort {
       assertNativeHost(result.rung, req.host ?? "unknown");
       return result;
     },
+    routeMany: async (reqs) => {
+      const results = await routeMany(reqs, o);
+      results.forEach((r, i) => assertNativeHost(r.rung, reqs[i]?.host ?? "unknown"));
+      return results;
+    },
     finding: (runDir, laneText, finding, use) =>
       verdict(
         runDir,
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/entry/mcp-route.test.ts test/services/route-records.test.ts test/services/routing-service.test.ts test/skills.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS.

- [ ] **Step 5: Commit**

````bash
git add plugin/skills/catherd/SKILL.md src/entry/mcp/lane-tools.ts src/services/lane-service.ts src/services/ports.ts src/services/routing-service.ts test/entry/mcp-route.test.ts test/services/helpers.ts test/services/route-records.test.ts test/services/routing-service.test.ts test/skills.test.ts
git commit -m "feat(routing): route a milestone's lanes in one call, asking Jev about all at once"
````

---

### Task 8: Each lane's final outcome beside Jev's answer in `routes.jsonl` (spec bullet 9; Ruling 13)

`land` and a climb past the top rung write each lane's outcome through `writeOutcome`: the `outcomes.jsonl` row as before, and an `OutcomeRouteRow` (`source: "outcome"`: the kind and difficulty of the lane's last route, Jev's question set and probabilities, `climbed`, `startRung`, `finalRung`, `landed`, `start_ok`, `envCaused`) in `routes.jsonl`. `readRoutes` now filters on `source` too, so the lane readers never see it.

**Interfaces:**
- Consumes: Task 5's `appendRoute`.
- Produces: `OutcomeRouteRow`, `outcomeRouteRow(rows, o)` (`route.ts`); `readOutcomeRoutes(run)` (`run-store.ts`).

**Scratch commit:** `1b87f49` (feat(routing): log each lane's final outcome beside Jev's answer in routes.jsonl).

**Files:**
- Modify: `src/domain/route.ts`
- Modify: `src/services/lane-service.ts`
- Modify: `src/services/run-store.ts`
- Modify: `test/services/outcomes.test.ts`

- [ ] **Step 1: Write the failing tests**

Edit `test/services/outcomes.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/outcomes.test.ts b/test/services/outcomes.test.ts
index c766d43..998684c 100644
--- a/test/services/outcomes.test.ts
+++ b/test/services/outcomes.test.ts
@@ -3,7 +3,13 @@ import { execFileSync } from "node:child_process";
 import { readFileSync } from "node:fs";
 import { laneOutcome, latestOutcomes, type RouteRow } from "../../src/domain/route.ts";
 import { climb, land, route } from "../../src/services/lane-service.ts";
-import { readOutcomes, readRoutes, type Run, runPaths } from "../../src/services/run-store.ts";
+import {
+  readOutcomeRoutes,
+  readOutcomes,
+  readRoutes,
+  type Run,
+  runPaths,
+} from "../../src/services/run-store.ts";
 import { snapshotEnv } from "../helpers.ts";
 import { fakeDeps, freshRun, LADDER, passGate, writeLane } from "./helpers.ts";
 
@@ -204,3 +210,52 @@ describe("outcomes.jsonl (spec §5.6)", () => {
     expect(laneOutcome(capability, "M1.L1", true, "t")).toMatchObject({ start_ok: false, envCaused: false });
   });
 });
+
+describe("the outcome beside Jev's answer in routes.jsonl (spec 1.5 plan 24)", () => {
+  it("writes each landed lane's outcome, climbed or not, with Jev's probabilities and the route's kind", async () => {
+    const { repo, run } = freshRun();
+    const deps = jevDeps();
+    for (const id of ["M1.L1", "M1.L2"]) {
+      writeLane(run, id, [`src/${id}.ts`]);
+      await route(deps, { run: run.id, laneFile: `lanes/${id}.md`, role: "worker" });
+    }
+    await climb(deps, { run: run.id, lane: "M1.L2", reason: "check-failed-twice" });
+    await landM1(deps, run, head(repo));
+    expect(
+      readOutcomeRoutes(run).map((r) => [r.lane, r.climbed, r.landed, r.kind, r.difficulty, r.jev]),
+    ).toEqual([
+      ["M1.L1", false, true, "repo_code", "build", JEV],
+      ["M1.L2", true, true, "repo_code", "build", JEV],
+    ]);
+    // the lane readers never see an outcome row: the lane's current route is still its last climb
+    expect(readRoutes(run).map((r) => r.source)).toEqual(["route", "route", "climb"]);
+  });
+
+  it("writes a lane that ended open on its top rung", async () => {
+    const { run } = freshRun();
+    const deps = jevDeps();
+    deps.routing.route = async () => ({
+      rung: LADDER[3] as string,
+      ladder: [LADDER[3] as string],
+      source: "jev",
+      kind: "repo_code",
+      difficulty: "hard",
+      questionSet: "route-v2#0123abcd",
+      jev: JEV,
+      jevSaid: null,
+      why: "Jev: repo_code/hard",
+    });
+    writeLane(run, "M1.L1", ["src/a.ts"]);
+    await route(deps, { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
+    await climb(deps, { run: run.id, lane: "M1.L1", reason: "check-failed-twice" });
+    expect(readOutcomeRoutes(run)).toEqual([
+      expect.objectContaining({
+        lane: "M1.L1",
+        source: "outcome",
+        landed: false,
+        climbed: false,
+        difficulty: "hard",
+      }),
+    ]);
+  });
+});
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/services/outcomes.test.ts`
Expected: FAIL: `readOutcomeRoutes` is not exported by `src/services/run-store.ts`; landing M1 or failing a lane's top rung writes no `outcome` row to `routes.jsonl`.

- [ ] **Step 3: Implement**

Edit `src/domain/route.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/route.ts b/src/domain/route.ts
index 57fdb41..ee7ebee 100644
--- a/src/domain/route.ts
+++ b/src/domain/route.ts
@@ -147,6 +147,50 @@ export function laneOutcome(rows: RouteRow[], lane: string, landed: boolean, at:
   };
 }
 
+/**
+ * Spec 1.5 plan 24: a lane's final outcome in routes.jsonl, beside the route row that holds Jev's answer, for
+ * calibrating Jev's difficulty question: what Jev said and what the route used, whether the lane climbed, and
+ * how it ended. `readRoutes` skips these rows; outcomes.jsonl keeps its own (spec §5.6).
+ */
+export interface OutcomeRouteRow {
+  at: string;
+  lane: string;
+  source: "outcome";
+  decidedBy: RouteSource;
+  kind: Kind | null;
+  difficulty: Difficulty | null;
+  questionSet: string | null;
+  jev: RouteJev | null;
+  /** some climb moved the lane to another rung (an environment climb included) */
+  climbed: boolean;
+  startRung: string;
+  finalRung: string;
+  landed: boolean;
+  start_ok: boolean;
+  envCaused: boolean;
+}
+
+/** The routes.jsonl outcome row of `o`, with the kind and difficulty of the lane's last route. */
+export function outcomeRouteRow(rows: RouteRow[], o: OutcomeRow): OutcomeRouteRow {
+  const start = rows.findLast((r) => r.lane === o.lane && r.source === "route");
+  return {
+    at: o.at,
+    lane: o.lane,
+    source: "outcome",
+    decidedBy: o.source,
+    kind: start?.kind ?? null,
+    difficulty: start?.difficulty ?? null,
+    questionSet: o.questionSet,
+    jev: o.jevProbs,
+    climbed: o.climbs.length > 0,
+    startRung: o.startRung,
+    finalRung: o.finalRung,
+    landed: o.landed,
+    start_ok: o.start_ok,
+    envCaused: o.envCaused,
+  };
+}
+
 /** Spec §5.6: one row per lane, the last one written (last row per lane wins), in first-seen lane order. */
 export function latestOutcomes(rows: OutcomeRow[]): OutcomeRow[] {
   const byLane = new Map<string, OutcomeRow>();
````

Edit `src/services/lane-service.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/lane-service.ts b/src/services/lane-service.ts
index dd219de..d645076 100644
--- a/src/services/lane-service.ts
+++ b/src/services/lane-service.ts
@@ -6,7 +6,15 @@ import { quotaUsage } from "../domain/select.ts";
 import { assertLaneHeader } from "../domain/lane.ts";
 import type { Role } from "../domain/roles.ts";
 import { cell } from "../domain/util.ts";
-import { type ClimbReason, currentRoute, laneOutcome, nextRung } from "../domain/route.ts";
+import {
+  type ClimbReason,
+  currentRoute,
+  laneOutcome,
+  nextRung,
+  type OutcomeRow,
+  outcomeRouteRow,
+  type RouteRow,
+} from "../domain/route.ts";
 import { withFileLock } from "../infra/filelock.ts";
 import { commitExists } from "../infra/git.ts";
 import { laneFile } from "./admission.ts";
@@ -229,6 +237,15 @@ async function refuseDesign(
     });
 }
 
+/**
+ * A lane's final outcome: its outcomes.jsonl row (spec §5.6) and, beside Jev's answer, its routes.jsonl row
+ * (spec 1.5 plan 24). Called under the routes lock.
+ */
+function writeOutcome(run: Run, routes: RouteRow[], o: OutcomeRow): void {
+  appendOutcome(run, o);
+  appendRoute(run, outcomeRouteRow(routes, o));
+}
+
 /** Spec §4.5: one rung up the lane's ladder, on a fresh thread; the reason goes to routes.jsonl. */
 export async function climb(
   deps: Deps,
@@ -265,8 +282,9 @@ export async function climb(
     });
     // spec §5.6: a climb past the top rung ends the lane open
     if (!next) {
-      const o = laneOutcome(readRoutes(run), i.lane, false, new Date(deps.now()).toISOString());
-      if (o) appendOutcome(run, o);
+      const routes = readRoutes(run);
+      const o = laneOutcome(routes, i.lane, false, new Date(deps.now()).toISOString());
+      if (o) writeOutcome(run, routes, o);
     }
     return { cur, next };
   });
@@ -440,7 +458,7 @@ async function landRun(
       if (lane.startsWith(`${i.milestone}.`)) {
         landed++;
         const o = laneOutcome(routes, lane, true, now.toISOString());
-        if (o) appendOutcome(run, o);
+        if (o) writeOutcome(run, routes, o);
       }
   });
   // a milestone name no routed lane starts with is most likely a typo: say so rather than record nothing
````

Edit `src/services/run-store.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/run-store.ts b/src/services/run-store.ts
index 0cd9043..fa6c6b6 100644
--- a/src/services/run-store.ts
+++ b/src/services/run-store.ts
@@ -4,7 +4,7 @@ import { z } from "zod";
 import { CatherdError } from "../domain/errors.ts";
 import { assertId } from "../domain/ids.ts";
 import { type RunRecord, RunRecordSchema } from "../domain/record.ts";
-import type { OutcomeRow, RoleRouteRow, RouteRow } from "../domain/route.ts";
+import type { OutcomeRouteRow, OutcomeRow, RoleRouteRow, RouteRow } from "../domain/route.ts";
 import { cell, slug } from "../domain/util.ts";
 import { withFileLock } from "../infra/filelock.ts";
 import { dataDir, repoDir, runsDir } from "../infra/paths.ts";
@@ -233,7 +233,18 @@ export function appendRecord(run: Run, r: RunRecord): Promise<RunRecord> {
 /** The run's lane rows (routes and climbs); a role's rows outside a lane are left out (`readRoleRoutes`). */
 export function readRoutes(run: Run): RouteRow[] {
   return readJsonl<RouteRow>(runPaths(run.dir).routes).rows.filter(
-    (r) => typeof r?.lane === "string" && Array.isArray(r.ladder) && typeof r.rung === "string",
+    (r) =>
+      typeof r?.lane === "string" &&
+      (r.source === "route" || r.source === "climb") &&
+      Array.isArray(r.ladder) &&
+      typeof r.rung === "string",
+  );
+}
+
+/** Spec 1.5 plan 24: the lanes' outcome rows of routes.jsonl, oldest first (the last per lane wins). */
+export function readOutcomeRoutes(run: Run): OutcomeRouteRow[] {
+  return readJsonl<OutcomeRouteRow>(runPaths(run.dir).routes).rows.filter(
+    (r) => typeof r?.lane === "string" && r.source === "outcome",
   );
 }
 
@@ -244,7 +255,7 @@ export function readRoleRoutes(run: Run): RoleRouteRow[] {
   );
 }
 
-export function appendRoute(run: Run, row: RouteRow | RoleRouteRow): void {
+export function appendRoute(run: Run, row: RouteRow | RoleRouteRow | OutcomeRouteRow): void {
   const file = runPaths(run.dir).routes;
   ensureJsonlHeader(file, "routes");
   appendJsonl(file, row);
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/services/outcomes.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS.

- [ ] **Step 5: Commit**

````bash
git add src/domain/route.ts src/services/lane-service.ts src/services/run-store.ts test/services/outcomes.test.ts
git commit -m "feat(routing): log each lane's final outcome beside Jev's answer in routes.jsonl"
````

---

### Task 9: A new release takes at least its predecessor's values, and the AA Intelligence Index calibrates `repo_code` (spec bullet 7; Rulings 14, 15)

`FamilySchema` gains `predecessor`; `catalog/models.json` names it for GPT-6.1 Sol, GPT-6 Sol, GPT-6 Luna, Claude Sonnet 5.5, Grok 4.7 and 4.6, Gemini 3.8 and 3.7 Flash. `inferStandIns` uses the predecessor's own value at the same effort (`{ like, distance: 0, features: ["predecessor"] }`) when it is at least the nearest stand-in's. `DIM_SOURCES.repo_code.others` gains AA's Intelligence Index.

**Interfaces:**
- Consumes: nothing new.
- Produces: `Family.predecessor?: string`.

**Scratch commit:** `c6c8ab3` (feat(catalog): floor a new release at its predecessor and calibrate on the AA Intelligence Index).

**Files:**
- Modify: `catalog/models.json`
- Modify: `src/domain/calibration.ts`
- Modify: `src/domain/catalog.ts`
- Modify: `src/services/standins.ts`
- Modify: `test/services/source-derive.test.ts`
- Modify: `test/services/standins.test.ts`

- [ ] **Step 1: Write the failing tests**

Edit `test/services/source-derive.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/source-derive.test.ts b/test/services/source-derive.test.ts
index 8652125..61bc9f6 100644
--- a/test/services/source-derive.test.ts
+++ b/test/services/source-derive.test.ts
@@ -277,3 +277,16 @@ describe("catalog facts (spec 1.2 §3.5)", () => {
     ]);
   });
 });
+
+describe("the Artificial Analysis Intelligence Index (spec 1.5 plan 24)", () => {
+  it("is fitted onto repo_code per model and effort, like AA's other coding numbers", () => {
+    const d = derive(rawAnswers(AT, { aa: true }), shippedContext(NOW));
+    expect(d.fits).toContainEqual(
+      expect.objectContaining({
+        dim: "repo_code",
+        source: "artificial-analysis",
+        field: "artificial_analysis_intelligence_index",
+      }),
+    );
+  });
+});
````

Edit `test/services/standins.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/standins.test.ts b/test/services/standins.test.ts
index 13e030e..75939ad 100644
--- a/test/services/standins.test.ts
+++ b/test/services/standins.test.ts
@@ -11,7 +11,7 @@ import {
   suggestStandIns,
   withStandIns,
 } from "../../src/services/standins.ts";
-import { shipped } from "../domain/shipped.ts";
+import { shipped, shippedModels, shippedScores } from "../domain/shipped.ts";
 import { snapshotEnv, withHome } from "../helpers.ts";
 import { rawAnswers, shippedContext } from "./source-fixtures.ts";
 
@@ -133,3 +133,37 @@ describe("inferred values in the catalog (spec 1.2 §6.1)", () => {
     expect(scoresOf(c, "gpt-5.6-terra#high")?.values.repo_code).toBeDefined();
   });
 });
+
+describe("a new release of a family line (spec 1.5 plan 24)", () => {
+  it("takes at least its predecessor's value at the same effort until a value of its own arrives", () => {
+    const models = shippedModels();
+    // as if GPT-5.6 Terra succeeded GPT-5.6 Luna
+    for (const f of models.families) if (f.id === "gpt-5.6-terra") f.predecessor = "gpt-5.6-luna";
+    const c = withStandIns(buildCatalog({ models, scores: shippedScores() }));
+    const terra = scoresOf(c, "gpt-5.6-terra#high");
+    // repo_code: Luna's 67 beats the nearest stand-in's guess, so the predecessor stands in
+    expect(c.inferred["gpt-5.6-terra#high"]?.repo_code).toEqual({
+      like: "gpt-5.6-luna#high",
+      distance: 0,
+      features: ["predecessor"],
+    });
+    expect(terra?.values.repo_code).toBe(67);
+    // terminal and honesty: the nearest stand-in's values are higher than Luna's (13, 21.8), so they stay
+    expect(terra?.standIns.terminal).not.toBe("gpt-5.6-luna#high");
+    expect(terra?.values.terminal).toBeGreaterThan(13);
+    expect(terra?.standIns.honesty).not.toBe("gpt-5.6-luna#high");
+  });
+
+  it("ships GPT-6.1 Sol as GPT-6 Sol's successor, which stands in for it without the treat-like", () => {
+    expect(shippedModels().families.find((f) => f.id === "gpt-6.1-sol")?.predecessor).toBe("gpt-6-sol");
+    const scores = shippedScores();
+    const treatLike = Object.fromEntries(
+      Object.entries(scores.treatLike).filter(([rung]) => !rung.startsWith("gpt-6.1-sol#")),
+    );
+    const c = withStandIns(buildCatalog({ models: shippedModels(), scores: { ...scores, treatLike } }));
+    expect(scoresOf(c, "gpt-6.1-sol#high")?.standIns.repo_code).toBe("gpt-6-sol#high");
+    expect(scoresOf(c, "gpt-6.1-sol#high")?.values.repo_code).toBe(
+      scoresOf(c, "gpt-6-sol#high")?.values.repo_code,
+    );
+  });
+});
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/services/source-derive.test.ts test/services/standins.test.ts`
Expected: FAIL: `FamilySchema` drops `predecessor` (the test's assignment is a type error) and `shippedModels()` has none for GPT-6.1 Sol; Terra's repo_code stand-in is the nearest rung, not Luna; no fit row for `artificial_analysis_intelligence_index`.

- [ ] **Step 3: Implement**

Edit `catalog/models.json` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/catalog/models.json b/catalog/models.json
index b7a67cc..84a39a4 100644
--- a/catalog/models.json
+++ b/catalog/models.json
@@ -45,6 +45,7 @@
     {
       "id": "gpt-6.1-sol",
       "name": "GPT-6.1 Sol",
+      "predecessor": "gpt-6-sol",
       "vendor": "openai",
       "releaseDate": "2026-09-29",
       "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
@@ -63,6 +64,7 @@
     {
       "id": "gpt-6-sol",
       "name": "GPT-6 Sol",
+      "predecessor": "gpt-5.6-sol",
       "vendor": "openai",
       "releaseDate": "2026-09-22",
       "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
@@ -88,6 +90,7 @@
     {
       "id": "gpt-6-luna",
       "name": "GPT-6 Luna",
+      "predecessor": "gpt-5.6-luna",
       "vendor": "openai",
       "releaseDate": "2026-09-22",
       "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
@@ -239,6 +242,7 @@
     {
       "id": "claude-sonnet-5-5",
       "name": "Claude Sonnet 5.5",
+      "predecessor": "claude-sonnet-5",
       "vendor": "anthropic",
       "releaseDate": "2026-09-28",
       "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
@@ -292,6 +296,7 @@
     {
       "id": "grok-4-7",
       "name": "Grok 4.7",
+      "predecessor": "grok-4-6",
       "vendor": "xai",
       "releaseDate": "2026-09-21",
       "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
@@ -308,6 +313,7 @@
     {
       "id": "grok-4-6",
       "name": "Grok 4.6",
+      "predecessor": "grok-4-5",
       "vendor": "xai",
       "releaseDate": "2026-08-12",
       "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
@@ -356,6 +362,7 @@
     {
       "id": "gemini-3-8-flash",
       "name": "Gemini 3.8 Flash",
+      "predecessor": "gemini-3-7-flash",
       "vendor": "google",
       "releaseDate": "2026-09-02",
       "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
@@ -368,6 +375,7 @@
     {
       "id": "gemini-3-7-flash",
       "name": "Gemini 3.7 Flash",
+      "predecessor": "gemini-3-6-flash",
       "vendor": "google",
       "releaseDate": "2026-08-13",
       "capabilities": { "toolUse": true, "imageIn": true, "reasoning": true },
````

Edit `src/domain/calibration.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/calibration.ts b/src/domain/calibration.ts
index ceae83d..6af2022 100644
--- a/src/domain/calibration.ts
+++ b/src/domain/calibration.ts
@@ -34,6 +34,13 @@ export const DIM_SOURCES: Record<Dim, { anchor: FieldRef | "shipped"; others: Fi
         benchmark: "Artificial Analysis Coding Index",
       },
       { source: "epoch", field: "frontiercode", benchmark: "FrontierCode (Epoch AI)" },
+      // spec 1.5 plan 24: per model and effort, it scores a new release the day it ships (the identity run's
+      // GPT-6.1 Sol: medium 47.8, about Astra low)
+      {
+        source: "artificial-analysis",
+        field: "artificial_analysis_intelligence_index",
+        benchmark: "Artificial Analysis Intelligence Index",
+      },
     ],
   },
   // plan 14 Ruling C-2: the vendors' Terminal-Bench 4.0 values, not Epoch's Terminal-Bench 2.0, which shares
````

Edit `src/domain/catalog.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/catalog.ts b/src/domain/catalog.ts
index b9554db..910e2ab 100644
--- a/src/domain/catalog.ts
+++ b/src/domain/catalog.ts
@@ -84,6 +84,11 @@ const FamilySchema = z.looseObject({
   notes: z.record(z.string(), z.string()).default({}),
   /** the day the vendor released it (models.dev), a stand-in feature (spec 1.2 §6.3) */
   releaseDate: z.iso.date().optional(),
+  /**
+   * spec 1.5 plan 24: the family this one succeeds in the same line (GPT-6.1 Sol after GPT-6 Sol): until a
+   * value of its own arrives, a rung takes at least its predecessor's value at the same effort
+   */
+  predecessor: z.string().min(1).optional(),
   /** a sync's speed facts (spec 1.2 §4.1), `<source>.<field>` → value; they never carry a bar */
   speed: z.record(z.string(), z.number()).optional(),
 });
````

Edit `src/services/standins.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/standins.ts b/src/services/standins.ts
index f98a969..f6409d7 100644
--- a/src/services/standins.ts
+++ b/src/services/standins.ts
@@ -173,10 +173,24 @@ export function suggestStandIns(c: Catalog, canonical: string, limit = 3): Sugge
   return new Ranker(c).rank(canonical, lacking.length ? lacking : DIMS).slice(0, limit);
 }
 
+/**
+ * Spec 1.5 plan 24: the same effort of the family's predecessor (`Family.predecessor`), when it has a value on
+ * `d` of its own; null otherwise.
+ */
+function predecessorOf(c: Catalog, canonical: string, d: Dim): { like: string; value: number } | null {
+  const pred = family(c, canonical)?.predecessor;
+  if (!pred) return null;
+  const like = `${pred}${canonical.slice(canonical.lastIndexOf("#"))}`;
+  const s = c.scores[like]?.[d];
+  return s ? { like, value: s.value } : null;
+}
+
 /**
  * Spec 1.2 §6.1: for every rung the catalog can name, per dimension the bars use that it has no value for
  * (of its own or through a treat-like), its nearest stand-in with a value there. A rung no rung is near
- * enough to (fewer than MIN_SHARED_FEATURES shared) gets none on that dimension.
+ * enough to (fewer than MIN_SHARED_FEATURES shared) gets none on that dimension. Spec 1.5 plan 24: a new
+ * release of a family line takes at least its predecessor's value at the same effort, so a guess never puts it
+ * below the model it replaces (the identity run's GPT-6.1 Sol at 37.2, under GPT-6 Luna).
  */
 export function inferStandIns(c: Catalog): Catalog["inferred"] {
   const dims = barDimsIn(c);
@@ -186,9 +200,14 @@ export function inferStandIns(c: Catalog): Catalog["inferred"] {
     const lacking = missingDims(c, canonical, dims);
     for (const d of lacking) {
       const best = ranker.rank(canonical, [d])[0];
-      if (!best) continue;
-      const entry: InferredStandIn = { like: best.like, distance: best.distance, features: best.features };
-      (out[canonical] ??= {})[d] = entry;
+      const pred = predecessorOf(c, canonical, d);
+      const nearest = best ? c.scores[best.like]?.[d]?.value : undefined;
+      let entry: InferredStandIn | null = best
+        ? { like: best.like, distance: best.distance, features: best.features }
+        : null;
+      if (pred && (nearest === undefined || pred.value >= nearest))
+        entry = { like: pred.like, distance: 0, features: ["predecessor"] };
+      if (entry) (out[canonical] ??= {})[d] = entry;
     }
   }
   return out;
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/services/source-derive.test.ts test/services/standins.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS.

- [ ] **Step 5: Commit**

````bash
git add catalog/models.json src/domain/calibration.ts src/domain/catalog.ts src/services/standins.ts test/services/source-derive.test.ts test/services/standins.test.ts
git commit -m "feat(catalog): floor a new release at its predecessor and calibrate on the AA Intelligence Index"
````

---

### Task 10: Sparse rungs never stand in; a treat-like's values read "like X"; marks and gaps named (spec bullet 8; minors inferred-from marks, ruling 7, "like X", `treat-like --clear` partial gap; Rulings 16, 18, 19)

`Ranker.rank` skips a candidate with fewer than `MIN_STANDIN_DIMS` (3) values of its own. `barDimsIn`'s comment states plan 14 Ruling 7 as the code reads it, pinned by a test. `inferredScores`'s note adds `<dims> inferred from <rung>` per stand-in. `ValueUsed.lent` (`treat-like` | `stand-in`) reaches `catalog_query` rows, `catalog list` (`like X` vs `inferred from X`) and the TUI's value picker. `leftOnStandIns` adds `missing` (bar dimensions left with no value at all, present only when some are), and `leftLines` prints it.

**Interfaces:**
- Consumes: Task 9's `inferStandIns`; Task 5's `provenance.ts`.
- Produces: `MIN_STANDIN_DIMS = 3`; `ValueUsed.lent: "treat-like" | "stand-in" | null`; catalog row `scores[dim].lent?`; `LeftOnStandIn.missing?: Dim[]`.

**Scratch commit:** `66f5999` (feat(catalog): refuse sparse stand-ins and tell a treat-like's values from a guess).

**Files:**
- Modify: `src/domain/profile-rules.ts`
- Modify: `src/entry/catalog-command.ts`
- Modify: `src/entry/tui/views/profiles.tsx`
- Modify: `src/services/catalog-service.ts`
- Modify: `src/services/provenance.ts`
- Modify: `src/services/standins.ts`
- Modify: `src/services/treat-likes.ts`
- Modify: `test/domain/profile-rules.test.ts`
- Modify: `test/entry/catalog-command.test.ts`
- Modify: `test/entry/tui/profile-tree.test.ts`
- Modify: `test/entry/tui/profiles.test.tsx`
- Modify: `test/services/standins.test.ts`
- Modify: `test/services/treat-likes.test.ts`

- [ ] **Step 1: Write the failing tests**

Edit `test/domain/profile-rules.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/domain/profile-rules.test.ts b/test/domain/profile-rules.test.ts
index 0e91c18..37170cb 100644
--- a/test/domain/profile-rules.test.ts
+++ b/test/domain/profile-rules.test.ts
@@ -299,6 +299,13 @@ describe("inferredScores", () => {
     expect(inferredScores(c, rungInfo(c, "codex:gpt-5.6-terra#high"))).toMatchObject({
       inferred: true,
       via: null,
+      note: expect.stringMatching(/^repo_code(, \S+)* inferred from \S+/),
+    });
+    // (1.2 minor) a rung scored partly by an inferred stand-in says so, as the tree and profile show print it
+    expect(inferredScores(c, rungInfo(c, "claude-code:claude-opus-5-5#high"))).toEqual({
+      inferred: true,
+      via: null,
+      note: "honesty inferred from gpt-6-sol#high",
     });
   });
 });
````

Edit `test/entry/catalog-command.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/entry/catalog-command.test.ts b/test/entry/catalog-command.test.ts
index a53e798..954e9b5 100644
--- a/test/entry/catalog-command.test.ts
+++ b/test/entry/catalog-command.test.ts
@@ -67,6 +67,16 @@ describe("formatModel (spec 1.2 §4.1, §8)", () => {
               source: "epoch",
               date: "2026-09-20",
               from: "gpt-6-sol#high",
+              lent: "stand-in",
+            },
+            honesty: {
+              value: 95.1,
+              benchmark: "Broken Search Tool",
+              confidence: "inferred",
+              source: "shipped",
+              date: "2026-09-20",
+              from: "gpt-6-astra#medium",
+              lent: "treat-like",
             },
           },
           treatLike: null,
@@ -86,7 +96,8 @@ describe("formatModel (spec 1.2 §4.1, §8)", () => {
     expect(formatModel(m).split("\n")).toEqual([
       "codex:gpt-6-sol  1/2 rungs scored  roles worker",
       "  $2/$10 per M tokens in/out · openrouter.throughput_last_30m 81.23",
-      "  #medium  repo_code 65.3 (verified, shipped) · terminal 0.1235 (inferred from gpt-6-sol#high, epoch)",
+      // a treat-like's value is the user's mapping, "like X"; a stand-in's is a guess (1.2 minor)
+      "  #medium  repo_code 65.3 (verified, shipped) · terminal 0.1235 (inferred from gpt-6-sol#high, epoch) · honesty 95.1 (like gpt-6-astra#medium, shipped)",
       "  #high  unscored",
       "    runs: 12 lanes, 2 climbed, 1 partial",
     ]);
````

Edit `test/entry/tui/profile-tree.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/entry/tui/profile-tree.test.ts b/test/entry/tui/profile-tree.test.ts
index f71dd7f..23c0bb2 100644
--- a/test/entry/tui/profile-tree.test.ts
+++ b/test/entry/tui/profile-tree.test.ts
@@ -232,9 +232,13 @@ describe("edits", () => {
     expect(standIns[0]).toEqual({ value: "", title: "none", current: false });
     expect(standIns.some((o) => o.value.startsWith("codex:"))).toBe(false);
     expect(standIns.some((o) => o.value === "claude-code:claude-opus-5-5#xhigh")).toBe(true);
-    // Opus high has values of its own now (carried from xhigh and max): nothing borrowed
-    expect(standIns.find((o) => o.value === "claude-code:claude-opus-5-5#high")?.detail).toBe("");
-    expect(standIns.find((o) => o.value === "claude-code:claude-opus-5-5#xhigh")?.detail).toBe("");
+    // Opus high has values of its own now (carried from xhigh and max), but no honesty: Sol's is inferred, and said
+    expect(standIns.find((o) => o.value === "claude-code:claude-opus-5-5#high")?.detail).toBe(
+      "honesty inferred from gpt-6-sol#high",
+    );
+    expect(standIns.find((o) => o.value === "claude-code:claude-opus-5-5#xhigh")?.detail).toBe(
+      "honesty inferred from gpt-6-sol#max",
+    );
     expect(standIns.find((o) => o.value === "opencode:opencode-go/gpt-6-luna#high")?.detail).toBe(
       "agentic, steer borrowed from gpt-5.6-luna#high",
     );
````

Edit `test/entry/tui/profiles.test.tsx` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/entry/tui/profiles.test.tsx b/test/entry/tui/profiles.test.tsx
index b0f3b77..e6abf8f 100644
--- a/test/entry/tui/profiles.test.tsx
+++ b/test/entry/tui/profiles.test.tsx
@@ -113,7 +113,8 @@ describe("the Profiles tab", () => {
     const f = h!.s.frame();
     expect(f).toContain("codex:gpt-6-luna#high");
     expect(f).toMatch(/repo_code 66\.6 +adjacent · shipped DeepSWE 1\.1/);
-    expect(f).toMatch(/agentic -0\.0075 +inferred from gpt-5\.6-luna#high/);
+    // a treat-like lends it: a mapping, "like X", not a stand-in's guess (1.2 minor)
+    expect(f).toMatch(/agentic -0\.0075 +like gpt-5\.6-luna#high/);
     expect(f).toContain("no runs yet");
   });
 
````

Edit `test/services/standins.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/standins.test.ts b/test/services/standins.test.ts
index 75939ad..b2560c8 100644
--- a/test/services/standins.test.ts
+++ b/test/services/standins.test.ts
@@ -134,6 +134,41 @@ describe("inferred values in the catalog (spec 1.2 §6.1)", () => {
   });
 });
 
+describe("sparse rungs never stand in (spec 1.5 plan 24)", () => {
+  const sparse = (value: number) => ({
+    rung: "sparse-1#high",
+    dim: "honesty" as const,
+    value,
+    benchmark: "Broken Search Tool",
+    version: "1",
+    url: "https://example.com/sparse",
+    date: "2026-09-28",
+    confidence: "measured" as const,
+  });
+
+  it("refuses a rung with values on fewer than three dimensions as anyone's stand-in", () => {
+    // GPT-6.1 Sol's one honesty figure, shipped as its own row, would have lent 97.92 to unrelated rungs
+    const c = withStandIns(
+      shipped({ override: { schema: 1, treatLike: {}, scores: [sparse(97.92)], bars: {} } }),
+    );
+    const lenders = Object.values(c.inferred).flatMap((m) => Object.values(m).map((x) => x?.like));
+    expect(lenders).not.toContain("sparse-1#high");
+    expect(lenders.length).toBeGreaterThan(0);
+    expect(suggestStandIns(c, "gpt-5.6-terra#high", 50).map((s) => s.like)).not.toContain("sparse-1#high");
+  });
+
+  it("infers steer only once a user's bar uses it (plan 14 Ruling 7, as aligned)", () => {
+    const none = withStandIns(shipped());
+    expect(Object.values(none.inferred).some((x) => x.steer)).toBe(false);
+    const steerBar = withStandIns(
+      shipped({
+        override: { schema: 1, treatLike: {}, scores: [], bars: { repo_code: { build: { steer: 0.05 } } } },
+      }),
+    );
+    expect(Object.values(steerBar.inferred).some((x) => x.steer)).toBe(true);
+  });
+});
+
 describe("a new release of a family line (spec 1.5 plan 24)", () => {
   it("takes at least its predecessor's value at the same effort until a value of its own arrives", () => {
     const models = shippedModels();
````

Edit `test/services/treat-likes.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/treat-likes.test.ts b/test/services/treat-likes.test.ts
index 7353080..ab2138e 100644
--- a/test/services/treat-likes.test.ts
+++ b/test/services/treat-likes.test.ts
@@ -11,6 +11,7 @@ import {
   resetTreatLikes,
   suggestFor,
 } from "../../src/services/treat-likes.ts";
+import { leftLines } from "../../src/entry/catalog-command.ts";
 import { snapshotEnv, withHome } from "../helpers.ts";
 
 afterEach(snapshotEnv());
@@ -146,6 +147,43 @@ describe("treat-like --clear and --reset (spec 1.2 §6.4)", () => {
     expect((await resetTreatLikes("claude-code")).left).toEqual(left);
   });
 
+  it("names a rung the removal leaves with some values but none on a bar dimension (1.2 minor)", async () => {
+    withHome();
+    // a model no family knows, with one value of its own: too few features for a stand-in on the others
+    const foo = "opencode:acme/foo-9#high";
+    patchProfile(
+      "default",
+      { roles: { worker: { rungs: [...DEFAULT_WORKER, foo] } } },
+      { host: "claude-code" },
+    );
+    const own = {
+      rung: "acme/foo-9#high",
+      dim: "repo_code",
+      value: 70,
+      benchmark: "mine",
+      version: "1",
+      url: "https://example.com/mine",
+      date: "2026-09-27",
+      confidence: "verified",
+    };
+    mkdirSync(dirname(overridePath()), { recursive: true });
+    writeFileSync(overridePath(), JSON.stringify({ schema: 1, treatLike: {}, scores: [own], bars: {} }));
+    await saveTreatLike(foo, "gpt-6-sol#high");
+    const left = leftOnStandIns(["acme/foo-9#high"], "claude-code");
+    expect(left).toEqual([
+      {
+        profile: "default",
+        rung: foo,
+        dims: [],
+        unscored: false,
+        missing: ["terminal", "honesty", "agentic", "frontend"],
+      },
+    ]);
+    expect(leftLines(left, true)).toEqual([
+      `! default: ${foo} is left with no terminal, honesty, agentic, frontend value: it clears no bar that needs one`,
+    ]);
+  });
+
   it("says there is nothing to remove", async () => {
     withHome();
     expect(await resetTreatLikes("claude-code")).toEqual({ removed: [], left: [] });
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/domain/profile-rules.test.ts test/entry/catalog-command.test.ts test/entry/tui/profile-tree.test.ts test/entry/tui/profiles.test.tsx test/services/standins.test.ts test/services/treat-likes.test.ts`
Expected: FAIL: the one-row `sparse-1#high` lends honesty to other rungs; Opus high's note is null (no "honesty inferred from …"); `formatModel` prints a treat-like's value as "inferred from"; the TUI shows Luna's agentic "inferred from"; `leftOnStandIns` omits a rung that keeps repo_code but loses every other bar dimension.

- [ ] **Step 3: Implement**

Edit `src/domain/profile-rules.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/domain/profile-rules.ts b/src/domain/profile-rules.ts
index 7254830..57ff04c 100644
--- a/src/domain/profile-rules.ts
+++ b/src/domain/profile-rules.ts
@@ -129,7 +129,8 @@ export const routingProfileOf = (p: Profile, role: Role): RoutingProfile => ({
 /**
  * Whether a rung's scores are catherd's guess: borrowed through a treat-like, filled by an inferred stand-in
  * (spec 1.2 §6.1), or only `inferred` ones. `note` says what a treat-like lends: "scores borrowed from X"
- * when the rung has no value of its own, else the dimensions it borrows (a rung a sync scored on some).
+ * when every value is borrowed, else the dimensions it borrows (a rung a sync scored on some); and (1.2
+ * minor) what each inferred stand-in lends: "honesty inferred from Y".
  */
 export function inferredScores(
   c: Catalog,
@@ -140,9 +141,17 @@ export function inferredScores(
   const records = Object.values(s.records);
   const guessed =
     s.via !== null || s.inferred.length > 0 || records.every((r) => r.confidence === "inferred");
-  const all = s.borrowed.length + s.inferred.length === records.length;
-  const note = s.via ? `${all ? "scores" : s.borrowed.join(", ")} borrowed from ${s.via}` : null;
-  return { inferred: guessed, via: s.via, note };
+  const all = s.borrowed.length === records.length;
+  const byStandIn = new Map<string, Dim[]>();
+  for (const d of s.inferred) {
+    const like = s.standIns[d] as string;
+    byStandIn.set(like, [...(byStandIn.get(like) ?? []), d]);
+  }
+  const parts = [
+    ...(s.via ? [`${all ? "scores" : s.borrowed.join(", ")} borrowed from ${s.via}`] : []),
+    ...[...byStandIn].map(([like, dims]) => `${dims.join(", ")} inferred from ${like}`),
+  ];
+  return { inferred: guessed, via: s.via, note: parts.length ? parts.join("; ") : null };
 }
 
 /**
````

Edit `src/entry/catalog-command.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/catalog-command.ts b/src/entry/catalog-command.ts
index 2d6e9b3..ec78776 100644
--- a/src/entry/catalog-command.ts
+++ b/src/entry/catalog-command.ts
@@ -99,7 +99,7 @@ export function formatModel(m: CatalogModel): string {
     // spec 1.2 §5.3: each value with its confidence and source, as `route` reports it; a guess names its rung
     const values = Object.entries(r.scores).map(
       ([dim, v]) =>
-        `${dim} ${Number(v.value.toPrecision(4))} (${v.from ? `inferred from ${v.from}` : v.confidence}, ${v.source})`,
+        `${dim} ${Number(v.value.toPrecision(4))} (${v.from ? (v.lent === "treat-like" ? `like ${v.from}` : `inferred from ${v.from}`) : v.confidence}, ${v.source})`,
     );
     if (values.length === 0 && !r.evidence) continue;
     lines.push(`  #${r.rung.slice(r.rung.lastIndexOf("#") + 1)}  ${values.join(" · ") || "unscored"}`);
@@ -163,10 +163,17 @@ const list = defineCommand({
 
 /** Spec 1.2 §6.4: the profile rungs a removal leaves on an inferred stand-in or unscored, one line each. */
 export function leftLines(left: LeftOnStandIn[], plain = false): string[] {
-  return left.map(
-    (l) =>
-      `${mark("warn", plain)} ${l.profile}: ${l.rung} is left ${l.unscored ? "unscored: routing skips it" : `on an inferred stand-in for ${l.dims.join(", ")}`}`,
-  );
+  return left.map((l) => {
+    const what = l.unscored
+      ? ["unscored: routing skips it"]
+      : [
+          ...(l.dims.length ? [`on an inferred stand-in for ${l.dims.join(", ")}`] : []),
+          ...(l.missing?.length
+            ? [`with no ${l.missing.join(", ")} value: it clears no bar that needs one`]
+            : []),
+        ];
+    return `${mark("warn", plain)} ${l.profile}: ${l.rung} is left ${what.join(", and ")}`;
+  });
 }
 
 /** Spec 1.2 §6.4 `--suggest`: the three nearest stand-ins, each with its distance and the features it rests on. */
````

Edit `src/entry/tui/views/profiles.tsx` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/tui/views/profiles.tsx b/src/entry/tui/views/profiles.tsx
index f0b1105..37fce57 100644
--- a/src/entry/tui/views/profiles.tsx
+++ b/src/entry/tui/views/profiles.tsx
@@ -267,7 +267,7 @@ export function ProfilesView(props: { width: number; height: number }) {
             value: v.dim,
             title: `${v.dim} ${v.value}`,
             group: "values",
-            detail: `${v.inferred ? `inferred from ${v.from}` : v.confidence} · ${v.source} ${v.benchmark} · ${v.date}`,
+            detail: `${v.lent === "treat-like" ? `like ${v.from}` : v.inferred ? `inferred from ${v.from}` : v.confidence} · ${v.source} ${v.benchmark} · ${v.date}`,
           })),
           {
             value: "runs",
````

Edit `src/services/catalog-service.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/catalog-service.ts b/src/services/catalog-service.ts
index 9a022a6..bc6aeec 100644
--- a/src/services/catalog-service.ts
+++ b/src/services/catalog-service.ts
@@ -345,6 +345,8 @@ function rungRows(
         date: string;
         /** spec 1.2 §5.3: the rung a borrowed or inferred value belongs to */
         from?: string;
+        /** what lent it: a treat-like's mapping (`like X`) or an inferred stand-in's guess (1.2 minor) */
+        lent?: "treat-like" | "stand-in";
       }
     > = {};
     for (const v of valuesUsed(c, info.canonical))
@@ -356,6 +358,7 @@ function rungRows(
         source: v.source,
         date: v.date,
         ...(v.from ? { from: v.from } : {}),
+        ...(v.lent ? { lent: v.lent } : {}),
       };
     const like = c.treatLike[info.canonical] ?? null;
     return {
````

Edit `src/services/provenance.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/provenance.ts b/src/services/provenance.ts
index 91303b7..94db55d 100644
--- a/src/services/provenance.ts
+++ b/src/services/provenance.ts
@@ -17,6 +17,8 @@ export interface ValueUsed {
   inferred: boolean;
   /** the rung the value belongs to, when it is not this one */
   from: string | null;
+  /** what lent it: a treat-like (a mapping, `like X`) or an inferred stand-in (a guess); null for its own */
+  lent: "treat-like" | "stand-in" | null;
 }
 
 /** Spec 1.2 §5.3: one threshold of the lane's bar, the value used against it, and whether it clears. */
@@ -54,7 +56,8 @@ export function valuesUsed(c: Catalog, canonical: string): ValueUsed[] {
   return DIMS.flatMap((dim) => {
     const r = s.records[dim];
     if (!r) return [];
-    const from = s.borrowed.includes(dim) ? s.via : (s.standIns[dim] ?? null);
+    const borrowed = s.borrowed.includes(dim);
+    const from = borrowed ? s.via : (s.standIns[dim] ?? null);
     return [
       {
         dim,
@@ -66,6 +69,7 @@ export function valuesUsed(c: Catalog, canonical: string): ValueUsed[] {
         url: r.url,
         inferred: from !== null,
         from,
+        lent: from === null ? null : borrowed ? "treat-like" : "stand-in",
       },
     ];
   });
````

Edit `src/services/standins.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/standins.ts b/src/services/standins.ts
index f6409d7..63f2af4 100644
--- a/src/services/standins.ts
+++ b/src/services/standins.ts
@@ -22,6 +22,13 @@ export type Features = Record<string, number | string>;
 /** Spec 1.2 §6.3: a pair sharing fewer features than this is not suggested. */
 export const MIN_SHARED_FEATURES = 3;
 
+/**
+ * Spec 1.5 plan 24: a rung stands in only when it has values of its own on at least this many dimensions. A
+ * sparse row (GPT-6.1 Sol's one honesty figure) ranks near everything, for it has few features to differ on,
+ * and would lend that one value to unrelated rungs.
+ */
+export const MIN_STANDIN_DIMS = 3;
+
 export interface Suggestion {
   /** the canonical rung that would stand in */
   like: string;
@@ -132,7 +139,11 @@ export function missingDims(c: Catalog, canonical: string, dims: readonly Dim[]
   return dims.filter((d) => !own[d] && !lent[d]);
 }
 
-/** Every dimension some bar of the catalog (the defaults, with the user's override) has a threshold on. */
+/**
+ * Every dimension some bar of the catalog (the defaults, with the user's override) has a threshold on: the
+ * dimensions a stand-in fills. No shipped bar uses `steer`, so it is never inferred by default; a user's steer
+ * bar makes it one (plan 14 Ruling 7, as the code has always read it; spec 1.5 plan 24 aligns the words).
+ */
 export function barDimsIn(c: Catalog): Dim[] {
   const used = new Set<string>();
   for (const kind of Object.values(c.bars))
@@ -148,13 +159,17 @@ class Ranker {
     for (const r of canonicalRungs(c)) this.all.set(r, featuresOf(c, r));
     this.z = scales([...this.all.values()]);
   }
-  /** The rungs with an own value on any of `dims`, nearest first; each with what it would lend. */
+  /**
+   * The rungs with an own value on any of `dims` (and on at least MIN_STANDIN_DIMS dimensions in all), nearest
+   * first; each with what it would lend.
+   */
   rank(canonical: string, dims: readonly Dim[]): Suggestion[] {
     const mine = this.all.get(canonical) ?? featuresOf(this.c, canonical);
     const out: Suggestion[] = [];
     for (const [other, f] of this.all) {
       if (other === canonical) continue;
       const own = ownValues(this.c, other);
+      if (Object.keys(own).length < MIN_STANDIN_DIMS) continue;
       const lends = dims.filter((d) => own[d] !== undefined);
       if (lends.length === 0) continue;
       const got = distance(mine, f, this.z);
````

Edit `src/services/treat-likes.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/treat-likes.ts b/src/services/treat-likes.ts
index b83deb5..cecd994 100644
--- a/src/services/treat-likes.ts
+++ b/src/services/treat-likes.ts
@@ -5,7 +5,7 @@ import { tryParseRung } from "../domain/ids.ts";
 import { ROLES } from "../domain/roles.ts";
 import { canonicalRung, loadCatalog, readOverride, removeTreatLikes } from "./catalog-service.ts";
 import { getProfile, listProfiles } from "./profile-store.ts";
-import { type Suggestion, suggestStandIns } from "./standins.ts";
+import { barDimsIn, type Suggestion, suggestStandIns } from "./standins.ts";
 
 /** A profile's rung that would lean on an inferred stand-in, or be left with no value at all (spec 1.2 §6.4). */
 export interface LeftOnStandIn {
@@ -15,6 +15,11 @@ export interface LeftOnStandIn {
   dims: Dim[];
   /** no value of its own and no stand-in near enough: routing skips it */
   unscored: boolean;
+  /**
+   * (1.2 minor) the bar dimensions it keeps no value on at all, though it keeps others: present only when some
+   * are; no bar that needs one is cleared
+   */
+  missing?: Dim[];
 }
 
 /**
@@ -50,8 +55,19 @@ export function leftOnStandIns(
       const canonical = rungInfo(c, rung).canonical;
       if (!gone.includes(canonical)) continue;
       const s = scoresOf(c, canonical);
-      if (!s) out.push({ profile, rung, dims: [], unscored: true });
-      else if (s.inferred.length) out.push({ profile, rung, dims: s.inferred, unscored: false });
+      if (!s) {
+        out.push({ profile, rung, dims: [], unscored: true });
+        continue;
+      }
+      const missing = barDimsIn(c).filter((d) => s.values[d] === undefined);
+      if (s.inferred.length || missing.length)
+        out.push({
+          profile,
+          rung,
+          dims: s.inferred,
+          unscored: false,
+          ...(missing.length ? { missing } : {}),
+        });
     }
   }
   return out;
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/domain/profile-rules.test.ts test/entry/catalog-command.test.ts test/entry/tui/profile-tree.test.ts test/entry/tui/profiles.test.tsx test/services/standins.test.ts test/services/treat-likes.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS.

- [ ] **Step 5: Commit**

````bash
git add src/domain/profile-rules.ts src/entry/catalog-command.ts src/entry/tui/views/profiles.tsx src/services/catalog-service.ts src/services/provenance.ts src/services/standins.ts src/services/treat-likes.ts test/domain/profile-rules.test.ts test/entry/catalog-command.test.ts test/entry/tui/profile-tree.test.ts test/entry/tui/profiles.test.tsx test/services/standins.test.ts test/services/treat-likes.test.ts
git commit -m "feat(catalog): refuse sparse stand-ins and tell a treat-like's values from a guess"
````

---

### Task 11: The sources minors: empty answers, derived values, direction, upward spreading, `catalog_sync` and the rate limit (spec bullet 12; Rulings 17, 20–23)

AA's models path refuses an answer with no `data` and the free path an empty first page; every Arena config refuses an answer with no rows (each a `SourceError`, so the last good answer stays). `testAaKey` sends one request (`retries: 0`). `derive` keeps the lower value on `LOWER_IS_BETTER` fields, drops every score `ScoreSchema` refuses, and spreads `adjacent` values only from a weaker effort (`upwardOnly`; `rebuildShipped` keeps both ways). `state.json` keeps `rateLimitAt`, kept on a failure without a header. `SyncOptions.wait: false` answers `busy` at once; the `catalog_sync` tool passes it.

**Interfaces:**
- Consumes: nothing new.
- Produces: `LOWER_IS_BETTER` (`source-derive.ts`); `adjacent(..., o?: { upwardOnly?: boolean })`; `SyncOptions.wait?: boolean`; `Deps.sync`'s option `wait?`; the state's `rateLimitAt?`.

**Scratch commit:** `3122c6f` (fix(sources): refuse empty answers, validate and direct derived values, and never wait on a sync).

**Files:**
- Modify: `src/entry/mcp/setup-tools.ts`
- Modify: `src/infra/sources/arena.ts`
- Modify: `src/infra/sources/artificial-analysis.ts`
- Modify: `src/infra/sources/cache.ts`
- Modify: `src/services/ports.ts`
- Modify: `src/services/source-derive.ts`
- Modify: `src/services/source-sync.ts`
- Modify: `test/entry/mcp-sync.test.ts`
- Modify: `test/infra/sources/artificial-analysis.test.ts`
- Modify: `test/infra/sources/scores.test.ts`
- Modify: `test/services/source-derive.test.ts`
- Modify: `test/services/source-sync.test.ts`

- [ ] **Step 1: Write the failing tests**

Edit `test/entry/mcp-sync.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/entry/mcp-sync.test.ts b/test/entry/mcp-sync.test.ts
index b40540f..4da72b4 100644
--- a/test/entry/mcp-sync.test.ts
+++ b/test/entry/mcp-sync.test.ts
@@ -23,7 +23,7 @@ const REPORT: SyncReport = {
 describe("catalog_sync (spec 1.2 §9)", () => {
   it("syncs, forced when asked, and returns the rungs newly scored, the stand-ins no longer needed and what failed", async () => {
     withHome();
-    const asked: { force: boolean }[] = [];
+    const asked: { force: boolean; wait?: boolean }[] = [];
     const c = await mcpClient({
       ...fakeDeps(),
       sync: async (o) => {
@@ -32,7 +32,8 @@ describe("catalog_sync (spec 1.2 §9)", () => {
       },
     });
     const r = await call(c, "catalog_sync", { force: true });
-    expect(asked).toEqual([{ force: true }]);
+    // (1.2 minor) the tool never waits on a running sync: it answers busy
+    expect(asked).toEqual([{ force: true, wait: false }]);
     expect(r.data).toEqual({
       newlyScored: ["claude-opus-5-5#high"],
       standInsNoLongerNeeded: [{ rung: "gpt-6-sol#high", like: "yardstick#high" }],
@@ -41,7 +42,7 @@ describe("catalog_sync (spec 1.2 §9)", () => {
       warnings: [],
     });
     await call(c, "catalog_sync");
-    expect(asked[1]).toEqual({ force: false });
+    expect(asked[1]).toEqual({ force: false, wait: false });
   });
 
   it("says so when another sync was running", async () => {
````

Edit `test/infra/sources/artificial-analysis.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/infra/sources/artificial-analysis.test.ts b/test/infra/sources/artificial-analysis.test.ts
index 488b0ec..abefbdd 100644
--- a/test/infra/sources/artificial-analysis.test.ts
+++ b/test/infra/sources/artificial-analysis.test.ts
@@ -75,6 +75,23 @@ describe("Artificial Analysis (spec 1.2 §3.1; fixtures synthetic, see their REA
     });
   });
 
+  it("tests a key with one request, never a retry (1.2 minor)", async () => {
+    const busy = fakeFetch({ status: 503, body: {} }, { status: 200, body: { data: [] } });
+    expect((await testAaKey("k", { fetchImpl: busy.impl, ...clock() })).result).toBe("unchecked");
+    expect(busy.sent).toHaveLength(1);
+  });
+
+  it("refuses an answer with no models, on either path, so the last good one stays (1.2 minor)", async () => {
+    const empty = fakeFetch({ status: 200, body: { data: [] }, headers: limit(9) });
+    await expect(fetchArtificialAnalysis("k", { fetchImpl: empty.impl, ...clock() })).rejects.toThrow(
+      "Artificial Analysis answered no models",
+    );
+    const free = fakeFetch({ status: 403, body: {} }, { status: 200, body: { data: [] } });
+    await expect(fetchArtificialAnalysis("k", { fetchImpl: free.impl, ...clock() })).rejects.toThrow(
+      "Artificial Analysis answered an empty first page",
+    );
+  });
+
   it("gives a row per slug and number: evaluations, prices, speed and cost per task", () => {
     const rows = parseArtificialAnalysis(
       { path: "models", pages: [fixture("artificial-analysis-models.json")], rateLimitRemaining: null },
````

Edit `test/infra/sources/scores.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/infra/sources/scores.test.ts b/test/infra/sources/scores.test.ts
index 69687fd..e17ca52 100644
--- a/test/infra/sources/scores.test.ts
+++ b/test/infra/sources/scores.test.ts
@@ -30,8 +30,13 @@ describe("Arena (spec 1.2 §3.1)", () => {
     expect(arenaRung("gemini-3.5-flash-lite")).toBe("gemini-3.5-flash-lite");
   });
 
-  it("fetches the six configs of the leaderboard dataset", async () => {
+  it("refuses an answer with no rows, keeping the last good one (1.2 minor)", async () => {
     const f = fakeFetch({ status: 200, body: { rows: [] } });
+    await expect(fetchArena({ fetchImpl: f.impl })).rejects.toThrow(/^Arena \w+ answered no rows$/);
+  });
+
+  it("fetches the six configs of the leaderboard dataset", async () => {
+    const f = fakeFetch({ status: 200, body: { rows: [{ row: {} }] } });
     const got = await fetchArena({ fetchImpl: f.impl });
     expect(Object.keys(got)).toEqual([...ARENA_CONFIGS]);
     expect(f.sent.map((s) => s.url)).toEqual(ARENA_CONFIGS.map(arenaUrl));
````

Edit `test/services/source-derive.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/source-derive.test.ts b/test/services/source-derive.test.ts
index 61bc9f6..cae7f75 100644
--- a/test/services/source-derive.test.ts
+++ b/test/services/source-derive.test.ts
@@ -1,6 +1,6 @@
 import { describe, expect, it } from "bun:test";
-import { applyFacts, buildCatalog } from "../../src/domain/catalog.ts";
-import { derive, openRouterIds } from "../../src/services/source-derive.ts";
+import { applyFacts, buildCatalog, ScoreSchema } from "../../src/domain/catalog.ts";
+import { derive, LOWER_IS_BETTER, openRouterIds } from "../../src/services/source-derive.ts";
 import { fixtureJson, rawAnswers, shippedContext } from "./source-fixtures.ts";
 
 const AT = "2026-09-28T10:00:00.000Z";
@@ -170,7 +170,7 @@ describe("anchors and calibration (spec 1.2 §4.1, §4.2)", () => {
 });
 
 describe("adjacent values (spec 1.2 §4.3)", () => {
-  it("carries a family's synced value to its other efforts, from the nearest effort", () => {
+  it("carries a family's synced value to its stronger efforts, from the nearest weaker one (1.2 minor)", () => {
     // over the hand-typed values alone: the shipped file carries the keyless values spread already
     const c = shippedContext(NOW);
     const hand = c.scores.scores.filter((s) => s.source === undefined && s.confidence !== "adjacent");
@@ -182,8 +182,9 @@ describe("adjacent values (spec 1.2 §4.3)", () => {
         note: "arena has it at high; carried to this effort",
       }),
     ]);
-    // Sol has Arena values at max only: every other effort takes them
-    expect(find(d, "gpt-6-sol#low", "steer", "adjacent")[0]?.value).toBe(0.1335);
+    // Sol has Arena values at max only: no weaker effort takes them (Luna none never takes Luna max's)
+    expect(find(d, "gpt-6-sol#low", "steer", "adjacent")).toEqual([]);
+    expect(find(d, "gpt-6-sol#xhigh", "steer", "adjacent")).toEqual([]);
   });
 
   it("never spreads the shipped values, and leaves Opus 5.5 without a coding or terminal value (plan 13 R-D)", () => {
@@ -290,3 +291,31 @@ describe("the Artificial Analysis Intelligence Index (spec 1.5 plan 24)", () =>
     );
   });
 });
+
+describe("the 1.2 minors in derive", () => {
+  it("keeps the lower of two rows on a rung for a field where less is better", () => {
+    const aa = fixtureJson("artificial-analysis-models.json") as { data: Record<string, unknown>[] };
+    const sol = aa.data.find((m) => typeof m.slug === "string" && m.slug.startsWith("gpt-6-sol"));
+    if (!sol) throw new Error("fixture lacks gpt-6-sol");
+    // the same rung twice, as an alias would give it: 0.9 and 0.4 dollars per task
+    const twice = {
+      ...aa,
+      data: [...aa.data, { ...sol, cost_per_task: 0.9 }, { ...sol, cost_per_task: 0.4 }],
+    };
+    const raw = rawAnswers(AT, { aa: true });
+    raw["artificial-analysis"] = {
+      fetchedAt: AT,
+      data: { path: "models", pages: [twice], rateLimitRemaining: null },
+    };
+    const d = derive(raw, shippedContext(NOW));
+    const key = Object.keys(d.features).find((k) => k.startsWith("gpt-6-sol#"));
+    expect(key).toBeDefined();
+    expect(LOWER_IS_BETTER.has("cost_per_task")).toBe(true);
+    expect(d.features[key as string]?.cost_per_task).toBeLessThanOrEqual(0.4);
+  });
+
+  it("drops a score that would not read back, so one bad date never makes the derived file unreadable", () => {
+    const d = derive(rawAnswers("not a time"), shippedContext(NOW));
+    for (const s of d.scores) expect(ScoreSchema.safeParse(s).success).toBe(true);
+  });
+});
````

Edit `test/services/source-sync.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/source-sync.test.ts b/test/services/source-sync.test.ts
index 7a1ca92..3451a84 100644
--- a/test/services/source-sync.test.ts
+++ b/test/services/source-sync.test.ts
@@ -97,12 +97,9 @@ describe("the sync (spec 1.2 §3.2, §3.3)", () => {
     // GPT-6 Luna has no Arena agent row in the recorded answers: this one gives Luna high its first agentic value
     const r = await syncSources({ transport: c.transport(withLunaAgent()), now: c.now, aaKey: null });
     // Gemini 3.8 Flash's family is new in 1.3: the weekly refresh ships its values, the recorded file has none.
-    // Both backends list low, medium and high, so Arena's value at high spreads to those and not to #default.
-    expect(r.newlyScored).toEqual([
-      "gemini-3-8-flash#high",
-      "gemini-3-8-flash#low",
-      "gemini-3-8-flash#medium",
-    ]);
+    // Arena scores it at high only, and a sync carries a value only up (1.2 minor): low and medium stay to a
+    // stand-in, never high's value.
+    expect(r.newlyScored).toEqual(["gemini-3-8-flash#high"]);
     expect(loadCatalog({ timings: false }).scores["gpt-6-luna#high"]?.agentic).toMatchObject({
       value: 0.03,
       confidence: "measured",
@@ -257,6 +254,46 @@ describe("the sync (spec 1.2 §3.2, §3.3)", () => {
   });
 });
 
+describe("the 1.2 minors in the sync", () => {
+  it("keeps the requests-left count with the time it was read when a later attempt fails without one", async () => {
+    withHome();
+    const c = clock();
+    await syncSources({
+      transport: c.transport(recordedFetch().impl),
+      now: c.now,
+      aaKey: "aa-key-0123456789",
+    });
+    c.advance(3_600_000);
+    const base = recordedFetch().impl;
+    const failing = (async (input: RequestInfo | URL) =>
+      String(input) === AA_MODELS_URL ? new Response("{}", { status: 500 }) : base(input)) as typeof fetch;
+    const r = await syncSources({
+      transport: c.transport(failing),
+      now: c.now,
+      aaKey: "aa-key-0123456789",
+      force: true,
+    });
+    expect(r.failed.map((f) => f.source)).toContain("artificial-analysis");
+    process.env.ARTIFICIAL_ANALYSIS_API_KEY = "aa-key-0123456789";
+    expect(sourcesStatus()).toMatchObject({
+      rateLimitRemaining: 98,
+      rateLimitAt: "2026-09-28T10:00:00.000Z",
+    });
+  });
+
+  it("answers busy at once, without waiting, when told not to wait and another sync holds the lock", async () => {
+    withHome();
+    const release = tryLockSync();
+    if (!release) throw new Error("the sync lock should be free");
+    try {
+      const r = await syncSources({ wait: false, aaKey: null });
+      expect(r).toMatchObject({ busy: true, sources: [] });
+    } finally {
+      release();
+    }
+  });
+});
+
 describe("the shipped values after a sync (plan 13 R7, R18)", () => {
   it("are never overwritten by an adjacent value; a rung with no value of its own still gets one", async () => {
     withHome();
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/entry/mcp-sync.test.ts test/infra/sources/artificial-analysis.test.ts test/infra/sources/scores.test.ts test/services/source-derive.test.ts test/services/source-sync.test.ts`
Expected: FAIL: an empty AA or Arena answer resolves; `testAaKey` retries a 503; `LOWER_IS_BETTER` is not exported; Sol low still takes Sol max's steer and Gemini 3.8 Flash low/medium are newly scored from high; a failed AA attempt moves `rateLimitAt`; `syncSources({ wait: false })` waits for the lock; `catalog_sync` asks without `wait: false`.

- [ ] **Step 3: Implement**

Edit `src/entry/mcp/setup-tools.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/mcp/setup-tools.ts b/src/entry/mcp/setup-tools.ts
index 433c032..733da14 100644
--- a/src/entry/mcp/setup-tools.ts
+++ b/src/entry/mcp/setup-tools.ts
@@ -59,7 +59,8 @@ export function registerSetupTools(server: McpServer, deps: Deps): void {
     },
     (a) =>
       handle(async () => {
-        const r = await (deps.sync ?? ((o) => syncSources(o)))({ force: a.force });
+        // (1.2 minor) a sync already running (the boot sync) answers busy at once, never a 120 s wait
+        const r = await (deps.sync ?? ((o) => syncSources(o)))({ force: a.force, wait: false });
         return {
           newlyScored: r.newlyScored,
           standInsNoLongerNeeded: r.noLongerNeeded,
````

Edit `src/infra/sources/arena.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/infra/sources/arena.ts b/src/infra/sources/arena.ts
index 360d393..d815f43 100644
--- a/src/infra/sources/arena.ts
+++ b/src/infra/sources/arena.ts
@@ -1,5 +1,5 @@
 import { effortWord } from "../../domain/sources.ts";
-import { type SourceTransport, sourceGet } from "./http.ts";
+import { SourceError, type SourceTransport, sourceGet } from "./http.ts";
 import { isoDay, num, type SourceRow } from "./rows.ts";
 
 /** Spec 1.2 §3.1: the Agent Arena boards and WebDev (CC-BY-4.0). */
@@ -18,10 +18,18 @@ export const ARENA_PAGE = "https://huggingface.co/datasets/lmarena-ai/leaderboar
 export const arenaUrl = (config: ArenaConfig): string =>
   `https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=${config}&split=latest&length=100`;
 
-/** Every config, in parallel; one failure fails the source, which keeps its last answer. */
+/**
+ * Every config, in parallel; one failure fails the source, which keeps its last answer. A config that answers
+ * no rows is a failure too (1.2 minor): an answer of the wrong shape never replaces a good one.
+ */
 export async function fetchArena(t: SourceTransport = {}): Promise<Record<ArenaConfig, unknown>> {
   const got = await Promise.all(
-    ARENA_CONFIGS.map(async (c) => [c, (await sourceGet(arenaUrl(c), t)).json()]),
+    ARENA_CONFIGS.map(async (c) => {
+      const body = (await sourceGet(arenaUrl(c), t)).json() as { rows?: unknown } | null;
+      if (!Array.isArray(body?.rows) || body.rows.length === 0)
+        throw new SourceError(`Arena ${c} answered no rows`);
+      return [c, body];
+    }),
   );
   return Object.fromEntries(got) as Record<ArenaConfig, unknown>;
 }
````

Edit `src/infra/sources/artificial-analysis.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/infra/sources/artificial-analysis.ts b/src/infra/sources/artificial-analysis.ts
index f59b6c9..486b290 100644
--- a/src/infra/sources/artificial-analysis.ts
+++ b/src/infra/sources/artificial-analysis.ts
@@ -26,7 +26,11 @@ export async function fetchArtificialAnalysis(key: string, t: SourceTransport =
   const o = { ...t, headers: { "x-api-key": key } };
   try {
     const r = await sourceGet(AA_MODELS_URL, o);
-    return { path: "models", pages: [r.json()], rateLimitRemaining: rateLimitRemaining(r.headers) };
+    const body = r.json() as { data?: unknown } | null;
+    // (1.2 minor) an answer of the wrong shape is a failure: the last good one stays
+    if (!Array.isArray(body?.data) || body.data.length === 0)
+      throw new SourceError("Artificial Analysis answered no models", r.status, r.headers);
+    return { path: "models", pages: [body], rateLimitRemaining: rateLimitRemaining(r.headers) };
   } catch (e) {
     if (!(e instanceof SourceError) || (e.status !== 403 && e.status !== 404)) throw e;
   }
@@ -41,6 +45,7 @@ export async function fetchArtificialAnalysis(key: string, t: SourceTransport =
     const total = num(body.pagination?.total_pages);
     if (total !== null && page >= total) break;
   }
+  if (pages.length === 0) throw new SourceError("Artificial Analysis answered an empty first page");
   return { path: "free", pages, rateLimitRemaining: remaining };
 }
 
@@ -53,10 +58,12 @@ export async function testAaKey(
   t: SourceTransport = {},
 ): Promise<{ result: "ok" | "refused" | "unchecked"; error?: string; rateLimitRemaining: number | null }> {
   try {
+    // spec 1.2 §9: one request, never retried (a 429 or 5xx leaves the key unchecked)
     const r = await sourceGet(aaFreeUrl(1), {
       attemptMs: 10_000,
       deadlineMs: 20_000,
       ...t,
+      retries: 0,
       headers: { "x-api-key": key },
     });
     return { result: "ok", rateLimitRemaining: rateLimitRemaining(r.headers) };
````

Edit `src/infra/sources/cache.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/infra/sources/cache.ts b/src/infra/sources/cache.ts
index a030e37..31d0b7b 100644
--- a/src/infra/sources/cache.ts
+++ b/src/infra/sources/cache.ts
@@ -59,6 +59,8 @@ const StateSchema = z.looseObject({
         error: z.string().nullable(),
         /** Artificial Analysis: `x-ratelimit-remaining` of its last answer */
         rateLimitRemaining: z.number().nullable().default(null),
+        /** when that count was read (1.2 minor); absent in a state written before 1.5 */
+        rateLimitAt: z.iso.datetime().nullable().optional(),
       }),
     )
     .default({}),
````

Edit `src/services/ports.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/ports.ts b/src/services/ports.ts
index 1f672b4..784e821 100644
--- a/src/services/ports.ts
+++ b/src/services/ports.ts
@@ -155,5 +155,5 @@ export interface Deps {
   session: SessionEnv | null;
   now: () => number;
   /** spec 1.2 §3.2 `catalog_sync`; default: the real sync (tests inject one that never reaches the network) */
-  sync?: (o: { force: boolean }) => Promise<SyncReport>;
+  sync?: (o: { force: boolean; wait?: boolean }) => Promise<SyncReport>;
 }
````

Edit `src/services/source-derive.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/source-derive.ts b/src/services/source-derive.ts
index 38ad28b..8c25615 100644
--- a/src/services/source-derive.ts
+++ b/src/services/source-derive.ts
@@ -8,9 +8,11 @@ import {
   type ModelsFile,
   outranks,
   type Score,
+  ScoreSchema,
   type ScoresFile,
 } from "../domain/catalog.ts";
 import {
+  EFFORT_ORDER,
   defaultEffortOf,
   type Derived,
   familyEfforts,
@@ -55,6 +57,18 @@ interface Keyed {
   row: SourceRow;
 }
 
+/**
+ * (1.2 minor) the fields where less is better: when two of a source's rows land on one rung, the lower one
+ * stands for it. Every other field keeps the higher.
+ */
+export const LOWER_IS_BETTER: ReadonlySet<string> = new Set([
+  "cost_per_task",
+  "median_time_to_first_token_seconds",
+]);
+
+/** Whether `a` should stand for a rung over `b` on `field`. */
+const better = (field: string, a: number, b: number): boolean => (LOWER_IS_BETTER.has(field) ? a < b : a > b);
+
 /** The score sources' rows, by source (spec 1.2 §3.3). */
 function scoreRows(raw: RawAnswers): [SourceId, SourceRow[]][] {
   const out: [SourceId, SourceRow[]][] = [];
@@ -93,7 +107,7 @@ export function derive(raw: RawAnswers, ctx: DeriveContext): Derived {
       const at = table.get(field) ?? new Map<string, Keyed>();
       table.set(field, at);
       const had = at.get(key);
-      if (!had || row.value > had.row.value)
+      if (!had || better(row.field, row.value, had.row.value))
         at.set(key, {
           key,
           family,
@@ -171,15 +185,19 @@ export function derive(raw: RawAnswers, ctx: DeriveContext): Derived {
       const family = map.family(id);
       if (family && effort !== null) shipped.add(`${family.id}#${effort}|${s.dim}`);
     }
+  // (1.2 minor) a sync carries a value only up to a stronger effort: a low effort never takes a high one's
   scores.push(
-    ...adjacent(ctx.models.families, scores, shipped, ctx.now, (f) => defaultEffortOf(ctx.sources, f)),
+    ...adjacent(ctx.models.families, scores, shipped, ctx.now, (f) => defaultEffortOf(ctx.sources, f), {
+      upwardOnly: true,
+    }),
   );
 
   const { facts, warnings } = factsOf(raw, ctx, map);
   return {
     schema: 1,
     builtAt: new Date(ctx.now).toISOString(),
-    scores,
+    // (1.2 minor) readDerived validates every score: one bad row would make the whole file unreadable
+    scores: scores.filter((s) => ScoreSchema.safeParse(s).success),
     facts,
     fits,
     unmatched: Object.fromEntries(Object.entries(unmatched).map(([s, ids]) => [s, [...ids].sort()])),
@@ -212,7 +230,8 @@ function aaFeatures(table: Map<string, Map<string, Keyed>>): Derived["features"]
 /**
  * Spec 1.2 §4.3 `adjacent`: for each family effort a dimension has no value at (neither one in `direct` nor
  * one `shipped` names, as `<family>#<effort>|<dim>`), the best value in `direct` at the nearest effort that
- * has one (the weaker on a tie). A sync spreads only its own values, and never onto a value the shipped file
+ * has one (the weaker on a tie); with `upwardOnly` (a sync's values, 1.2 minor), only a weaker effort's value
+ * is carried, so Luna none never takes Luna max's. A sync spreads only its own values, and never onto a value the shipped file
  * carries; `rebuildShipped` spreads the shipped file's published values, with an empty `shipped`. A family that
  * one backend runs without an effort (Cursor's bare slug, spec 1.3 §7.1) also gets `#default`, carried from the
  * value nearest `defaultEffort(family)`.
@@ -223,7 +242,9 @@ export function adjacent(
   shipped: ReadonlySet<string>,
   now: number,
   defaultEffort: (f: Family) => string = () => "high",
+  o: { upwardOnly?: boolean } = {},
 ): Score[] {
+  const rank = (e: string) => (EFFORT_ORDER as readonly string[]).indexOf(e);
   const out: Score[] = [];
   for (const f of families)
     for (const dim of DIMS) {
@@ -239,7 +260,9 @@ export function adjacent(
       const bare = efforts.length > 0 && Object.values(f.on).some((o) => o && o.efforts.length === 0);
       for (const e of bare ? [...efforts, "default"] : efforts) {
         if (byEffort.has(e) || shipped.has(`${f.id}#${e}|${dim}`)) continue;
-        const near = nearestEffort(e === "default" ? defaultEffort(f) : e, [...byEffort.keys()]);
+        const target = e === "default" ? defaultEffort(f) : e;
+        const from_ = [...byEffort.keys()].filter((x) => !o.upwardOnly || rank(x) <= rank(target));
+        const near = nearestEffort(target, from_);
         const from = near ? byEffort.get(near) : undefined;
         if (!near || !from) continue;
         out.push({
````

Edit `src/services/source-sync.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/source-sync.ts b/src/services/source-sync.ts
index 0919052..b6b1b04 100644
--- a/src/services/source-sync.ts
+++ b/src/services/source-sync.ts
@@ -49,6 +49,8 @@ export interface SyncOptions {
   force?: boolean;
   /** the MCP server's boot sync: skips when another sync runs, and gives a failing source an hour's rest */
   background?: boolean;
+  /** false: answer `busy` at once when another sync holds the lock (the catalog_sync tool), never wait */
+  wait?: boolean;
   /** how every source is fetched; tests replace it */
   transport?: SourceTransport;
   /** the Artificial Analysis key; default: the env's, else the saved one */
@@ -129,7 +131,7 @@ export function cachedAnswers(): RawAnswers {
  */
 export async function syncSources(o: SyncOptions = {}): Promise<SyncReport> {
   const now = o.now ?? Date.now;
-  const release = await takeLock(o.background === true);
+  const release = await takeLock(o.background === true || o.wait === false);
   if (!release)
     return {
       busy: true,
@@ -177,16 +179,19 @@ export async function syncSources(o: SyncOptions = {}): Promise<SyncReport> {
           lastAttemptAt: iso(at),
           error: null,
           rateLimitRemaining: limit,
+          rateLimitAt: limit === null ? null : iso(at),
         };
         outcomes.set(id, { source: id, state: "fetched", fetchedAt: iso(at) });
       } catch (e) {
         const error = errorMessage(e);
         const limit = e instanceof SourceError ? rateLimitRemaining(e.headers) : null;
+        // (1.2 minor) a failure with no header keeps the last count with the time that count was read
         state.sources[id] = {
           fetchedAt: prev?.fetchedAt ?? null,
           lastAttemptAt: iso(at),
           error,
           rateLimitRemaining: limit ?? prev?.rateLimitRemaining ?? null,
+          rateLimitAt: limit === null ? (prev?.rateLimitAt ?? null) : iso(at),
         };
         outcomes.set(id, { source: id, state: "failed", fetchedAt: prev?.fetchedAt ?? null, error });
         log(o.background ? "debug" : "warn", "sources", { source: id, error });
@@ -300,6 +305,8 @@ export function sourcesStatus(): {
     })),
     aaKey: aaKey() !== null,
     rateLimitRemaining: aa?.rateLimitRemaining ?? null,
-    rateLimitAt: aa?.rateLimitRemaining === null || aa === undefined ? null : aa.lastAttemptAt,
+    // a state written before 1.5 has no rateLimitAt: its last attempt is the best guess
+    rateLimitAt:
+      aa?.rateLimitRemaining === null || aa === undefined ? null : (aa.rateLimitAt ?? aa.lastAttemptAt),
   };
 }
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/entry/mcp-sync.test.ts test/infra/sources/artificial-analysis.test.ts test/infra/sources/scores.test.ts test/services/source-derive.test.ts test/services/source-sync.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS.

- [ ] **Step 5: Commit**

````bash
git add src/entry/mcp/setup-tools.ts src/infra/sources/arena.ts src/infra/sources/artificial-analysis.ts src/infra/sources/cache.ts src/services/ports.ts src/services/source-derive.ts src/services/source-sync.ts test/entry/mcp-sync.test.ts test/infra/sources/artificial-analysis.test.ts test/infra/sources/scores.test.ts test/services/source-derive.test.ts test/services/source-sync.test.ts
git commit -m "fix(sources): refuse empty answers, validate and direct derived values, and never wait on a sync"
````

---

### Task 12: The remaining 1.2 minors: doctor's handshake, the credentials lock, ATTRIBUTION, the refresh workflow, the TUI preview (spec bullet 12; Rulings 24, 25)

`handshakeEnv` sets `CATHERD_NO_SYNC=1`. `saveCredential` reads and writes under `withFileLockSync(credentialsPath())`. `ATTRIBUTION.md` ships models.dev's release dates with its MIT line. `catalog-refresh.yml` checks out with `persist-credentials: false` and pushes with the token in the PR step. The TUI's `previewSave` offers a repair only for a stored profile. `profile_validate`'s description names Task 4's warnings.

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new.

**Scratch commit:** `ac5c04d` (fix: close the 1.2 minors in doctor, credentials, attribution, the refresh workflow and the TUI).

**Files:**
- Modify: `.github/workflows/catalog-refresh.yml`
- Modify: `catalog/ATTRIBUTION.md`
- Modify: `src/entry/mcp/handshake.ts`
- Modify: `src/entry/mcp/setup-tools.ts`
- Modify: `src/entry/tui/views/save-dialog.tsx`
- Modify: `src/services/credentials.ts`
- Modify: `test/catalog-refresh-workflow.test.ts`
- Modify: `test/entry/mcp-handshake-env.test.ts`
- Modify: `test/entry/tui/dialogs.test.tsx`
- Modify: `test/services/credentials.test.ts`

- [ ] **Step 1: Write the failing tests**

Edit `test/catalog-refresh-workflow.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/catalog-refresh-workflow.test.ts b/test/catalog-refresh-workflow.test.ts
index fda4e68..ab3d182 100644
--- a/test/catalog-refresh-workflow.test.ts
+++ b/test/catalog-refresh-workflow.test.ts
@@ -22,6 +22,14 @@ describe(".github/workflows/catalog-refresh.yml (spec 1.2 §7)", () => {
     expect(script).toContain("process.env.CATHERD_HOME = home;");
   });
 
+  it("keeps the token out of .git/config while bun install runs, and pushes with it in the PR step (1.2 minor)", () => {
+    expect(workflow).toContain("persist-credentials: false");
+    expect(workflow).not.toMatch(/^\s+token: /m);
+    expect(workflow).toContain(
+      'git push --force "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" catalog-refresh',
+    );
+  });
+
   it("opens or updates one PR, chore(catalog): refresh scores, with a patch changeset, only on a change", () => {
     expect(workflow).toContain("if: steps.refresh.outputs.changed == 'true'");
     expect(workflow.match(/--title "chore\(catalog\): refresh scores"/g)).toHaveLength(2);
````

Edit `test/entry/mcp-handshake-env.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/entry/mcp-handshake-env.test.ts b/test/entry/mcp-handshake-env.test.ts
index 8fadad4..737172d 100644
--- a/test/entry/mcp-handshake-env.test.ts
+++ b/test/entry/mcp-handshake-env.test.ts
@@ -20,6 +20,11 @@ describe("doctor's MCP handshake", () => {
       CLAUDE_CODE_MESSAGING_TOKEN: "t",
       PATH: "/usr/bin",
     });
-    expect(env).toEqual({ PATH: "/usr/bin" });
+    expect(env).toEqual({ PATH: "/usr/bin", CATHERD_NO_SYNC: "1" });
+  });
+
+  it("starts the server with no boot sync: it lives for one tools/list (1.2 minor)", () => {
+    expect(handshakeEnv({ PATH: "/usr/bin" }).CATHERD_NO_SYNC).toBe("1");
+    expect(handshakeEnv({ PATH: "/usr/bin", CATHERD_NO_SYNC: "0" }).CATHERD_NO_SYNC).toBe("1");
   });
 });
````

Edit `test/entry/tui/dialogs.test.tsx` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/entry/tui/dialogs.test.tsx b/test/entry/tui/dialogs.test.tsx
index dccdc19..e6b40be 100644
--- a/test/entry/tui/dialogs.test.tsx
+++ b/test/entry/tui/dialogs.test.tsx
@@ -249,6 +249,23 @@ describe("SaveDialog (spec §9.2)", () => {
     expect(answers).toEqual(["save"]);
   });
 
+  it("offers no repair for a profile with no stored file, as the ProfileService rules (1.2 minor)", async () => {
+    const effects = fixtureEffects();
+    const read = effects.readProfile;
+    effects.readProfile = (n) =>
+      applyPatch(read(n), {
+        roles: { writer: { rungs: [] } },
+        failover: { "codex:gpt-6-sol#high": "codex:gpt-6-luna#high" },
+      });
+    // no profile file yet: the service would refuse the save, so the preview offers only Cancel
+    const profiles = effects.profiles;
+    effects.profiles = () => ({ ...profiles(), names: [] });
+    await save({ failover: { "codex:gpt-6-sol#high": "opencode:opencode-go/kimi-k3#max" } }, effects);
+    const f = h!.s.frame();
+    expect(f).not.toContain("This save fixes an error and adds none");
+    expect(f).not.toContain("[ Save ]");
+  });
+
   it("answers activate from the second button, and cancels from the third", async () => {
     const answers = await save({ budget: { usd: 5 } });
     await h!.s.press("right", "return");
````

Edit `test/services/credentials.test.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/test/services/credentials.test.ts b/test/services/credentials.test.ts
index f97e1cb..d949489 100644
--- a/test/services/credentials.test.ts
+++ b/test/services/credentials.test.ts
@@ -1,6 +1,6 @@
 import { afterEach, describe, expect, it } from "bun:test";
 import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
-import { dirname } from "node:path";
+import { dirname, join } from "node:path";
 import { knownSecrets } from "../../src/infra/log.ts";
 import { aaKey, credentialsPath, saveAaKey, savedCredential } from "../../src/services/credentials.ts";
 import { jevKey, registerSavedSecrets, saveJevKey } from "../../src/services/jev-service.ts";
@@ -58,3 +58,35 @@ describe("the Artificial Analysis key (spec 1.2 §9)", () => {
     expect(knownSecrets({})).toContain("aa-redact-0123456789");
   });
 });
+
+describe("saving a credential (1.2 minor)", () => {
+  it("holds the file's lock, so two concurrent saves of different keys both survive", async () => {
+    withHome();
+    const module = join(import.meta.dir, "..", "..", "src", "services", "credentials.ts");
+    const writer = (field: string, key: string) =>
+      Bun.spawn(
+        [
+          process.execPath,
+          "-e",
+          `const { saveCredential } = await import(${JSON.stringify(module)}); for (let i = 0; i < 25; i++) saveCredential(${JSON.stringify(field)}, ${JSON.stringify(key)} + i);`,
+        ],
+        {
+          env: {
+            PATH: process.env.PATH ?? "",
+            CATHERD_HOME: process.env.CATHERD_HOME ?? "",
+            ANTHROPIC_API_KEY: "",
+          },
+          stdout: "ignore",
+          stderr: "pipe",
+        },
+      );
+    const a = writer("typesafeApiKey", "tsk-");
+    const b = writer("artificialAnalysisApiKey", "aa-");
+    expect([await a.exited, await b.exited]).toEqual([0, 0]);
+    expect(JSON.parse(readFileSync(credentialsPath(), "utf8"))).toEqual({
+      schema: 1,
+      typesafeApiKey: "tsk-24",
+      artificialAnalysisApiKey: "aa-24",
+    });
+  });
+});
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/catalog-refresh-workflow.test.ts test/entry/mcp-handshake-env.test.ts test/entry/tui/dialogs.test.tsx test/services/credentials.test.ts`
Expected: FAIL: `handshakeEnv` has no `CATHERD_NO_SYNC`; two concurrent processes saving different keys lose one (most runs); the TUI preview offers Save for a repair of a profile with no stored file; the workflow persists the token.

- [ ] **Step 3: Implement**

Edit `.github/workflows/catalog-refresh.yml` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/.github/workflows/catalog-refresh.yml b/.github/workflows/catalog-refresh.yml
index 4abdb8f..7542e45 100644
--- a/.github/workflows/catalog-refresh.yml
+++ b/.github/workflows/catalog-refresh.yml
@@ -21,9 +21,8 @@ jobs:
     steps:
       - uses: actions/checkout@v7
         with:
-          # a push by GITHUB_TOKEN triggers no workflow: the PR gets CI only through RELEASE_TOKEN, as the
-          # release PR does
-          token: ${{ secrets.RELEASE_TOKEN || secrets.GITHUB_TOKEN }}
+          # no token in .git/config while bun install runs package scripts: the PR step pushes with it
+          persist-credentials: false
       - uses: oven-sh/setup-bun@v2
         with:
           bun-version: latest
@@ -40,6 +39,8 @@ jobs:
       - name: Open or update the refresh PR
         if: steps.refresh.outputs.changed == 'true'
         env:
+          # a push by GITHUB_TOKEN triggers no workflow: the PR gets CI only through RELEASE_TOKEN, as the
+          # release PR does
           GH_TOKEN: ${{ secrets.RELEASE_TOKEN || secrets.GITHUB_TOKEN }}
         run: |
           git config user.name "github-actions[bot]"
@@ -47,7 +48,7 @@ jobs:
           git switch -C catalog-refresh
           git add catalog/scores.json .changeset/catalog-refresh.md
           git commit -m "chore(catalog): refresh scores"
-          git push --force origin catalog-refresh
+          git push --force "https://x-access-token:${GH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" catalog-refresh
           if [ "$(gh pr view catalog-refresh --json state -q .state 2>/dev/null)" = "OPEN" ]; then
             gh pr edit catalog-refresh --title "chore(catalog): refresh scores" --body-file "$RUNNER_TEMP/body.md"
           else
````

Edit `catalog/ATTRIBUTION.md` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/catalog/ATTRIBUTION.md b/catalog/ATTRIBUTION.md
index 686a1e1..96afd53 100644
--- a/catalog/ATTRIBUTION.md
+++ b/catalog/ATTRIBUTION.md
@@ -1,7 +1,8 @@
 # Attribution for the shipped catalog data
 
 `catalog/scores.json` carries model scores from public sources. Each value names its source (`source`), the page
-it came from (`url`), its date and its confidence. The weekly `catalog-refresh` workflow rebuilds the values that
+it came from (`url`), its date and its confidence. `catalog/models.json` carries each model's release date
+(`releaseDate`) from models.dev. The weekly `catalog-refresh` workflow rebuilds the values that
 come from the keyless sources below; the hand-typed values (no `source`) cite their own vendor or benchmark page in
 their `url`.
 
@@ -20,6 +21,12 @@ their `url`.
 - License: CC BY 4.0; external tables keep their own license
 - Attribution: Epoch AI, 'Capabilities & benchmarking'. Published online at epoch.ai. Retrieved from 'https://epoch.ai/benchmarks' (CC BY 4.0)
 
+### models.dev
+
+- Data: https://models.dev/api.json, the release dates in `catalog/models.json`
+- License: MIT License
+- Attribution: models.dev (MIT License), https://github.com/sst/models.dev
+
 ### Vectara hallucination leaderboard
 
 - Data: the README table of https://github.com/vectara/hallucination-leaderboard
@@ -28,9 +35,10 @@ their `url`.
 
 ## Sources read at run time only
 
-catherd reads these on the user's machine and ships none of their data: models.dev (MIT License,
-https://models.dev), the OpenRouter API (https://openrouter.ai) and LiteLLM's
-`model_prices_and_context_window.json` (MIT License, https://github.com/BerriAI/litellm).
+catherd reads these on the user's machine and ships none of their data: the OpenRouter API
+(https://openrouter.ai) and LiteLLM's `model_prices_and_context_window.json` (MIT License,
+https://github.com/BerriAI/litellm). models.dev's prices, capabilities and efforts are read at run time too;
+only its release dates ship (above).
 
 Artificial Analysis (https://artificialanalysis.ai) is read only with the user's own key, and its values are never
 shipped.
````

Edit `src/entry/mcp/handshake.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/mcp/handshake.ts b/src/entry/mcp/handshake.ts
index 0944f7e..1b2f684 100644
--- a/src/entry/mcp/handshake.ts
+++ b/src/entry/mcp/handshake.ts
@@ -12,11 +12,15 @@ export const LAUNCHER = fileURLToPath(new URL("../../../plugin/bin/catherd-mcp",
 const TIMEOUT_MS = 60_000;
 const STDERR_TAIL = 4_000;
 
-/** The env the doctor's MCP server starts with: catherd's own secrets scrubbed, as for every process it starts. */
+/**
+ * The env the doctor's MCP server starts with: catherd's own secrets scrubbed, as for every process it starts,
+ * and no boot sync (1.2 minor): the server lives for one tools/list, so a sync there spends fetches (AA's
+ * included) and records nothing.
+ */
 export const handshakeEnv = (
   base: Record<string, string | undefined> = process.env,
 ): Record<string, string> => {
-  return scrubSecrets(base);
+  return { ...scrubSecrets(base), CATHERD_NO_SYNC: "1" };
 };
 
 /**
````

Edit `src/entry/mcp/setup-tools.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/mcp/setup-tools.ts b/src/entry/mcp/setup-tools.ts
index 733da14..2ba1606 100644
--- a/src/entry/mcp/setup-tools.ts
+++ b/src/entry/mcp/setup-tools.ts
@@ -91,7 +91,7 @@ export function registerSetupTools(server: McpServer, deps: Deps): void {
     "profile_validate",
     {
       description:
-        "Check a profile (without a name: the profile this repo runs on, as in profile_get). errors block a save: the worker disabled, an enabled role with no usable rung, an unscored rung without a 'treat like', a failover stand-in unscored or on the same quota, a backend catherd cannot run. warnings do not: an access mode other than the role's default, a model the backend's listing lacks, a stand-in that never runs. Each has a path, a message and often a fix.",
+        "Check a profile (without a name: the profile this repo runs on, as in profile_get). errors block a save: the worker disabled, an enabled role with no usable rung, an unscored rung without a 'treat like', a failover stand-in unscored or on the same quota, a backend catherd cannot run. warnings do not: an access mode other than the role's default, a model the backend's listing lacks, a stand-in that never runs, a quota none of whose rungs ever starts a lane, and every kind and difficulty no worker rung clears. Each has a path, a message and often a fix.",
       inputSchema: { name: PROFILE, repo: REPO },
     },
     (a) => handle(async () => deps.profiles.validate(a.name, await toplevel(a.repo))),
````

Edit `src/entry/tui/views/save-dialog.tsx` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/entry/tui/views/save-dialog.tsx b/src/entry/tui/views/save-dialog.tsx
index 11320d7..b4345cf 100644
--- a/src/entry/tui/views/save-dialog.tsx
+++ b/src/entry/tui/views/save-dialog.tsx
@@ -48,7 +48,7 @@ export interface SavePreview {
  */
 function previewSave(
   d: Draft,
-  fx: Pick<Effects, "catalog" | "validate" | "agents" | "readProfile">,
+  fx: Pick<Effects, "catalog" | "validate" | "agents" | "readProfile" | "profiles">,
   now: ProfileDoc = fx.readProfile(d.name),
 ): SavePreview {
   const before = resolveProfile(now, d.name, d.host);
@@ -62,7 +62,11 @@ function previewSave(
     changes: diffProfiles(before, after),
     treatLikes: Object.entries(d.treatLikes),
     validation,
-    repair: validation.errors.length > 0 && repairs(fx.validate(before, staged), validation),
+    // as the ProfileService rules: a profile with no stored file has no errors a save could repair (1.2 minor)
+    repair:
+      validation.errors.length > 0 &&
+      fx.profiles().names.includes(d.name) &&
+      repairs(fx.validate(before, staged), validation),
     agentsAdded: [...b].filter((x) => !a.has(x)),
     agentsRemoved: [...a].filter((x) => !b.has(x)),
   };
````

Edit `src/services/credentials.ts` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/src/services/credentials.ts b/src/services/credentials.ts
index aff998b..3d9df18 100644
--- a/src/services/credentials.ts
+++ b/src/services/credentials.ts
@@ -1,7 +1,8 @@
-import { existsSync } from "node:fs";
+import { existsSync, mkdirSync } from "node:fs";
 import { join } from "node:path";
 import { z } from "zod";
 import { CatherdError, isCatherdError } from "../domain/errors.ts";
+import { withFileLockSync } from "../infra/filelock.ts";
 import { log } from "../infra/log.ts";
 import { configDir } from "../infra/paths.ts";
 import { readVersioned, writeJsonAtomic } from "../infra/store.ts";
@@ -45,13 +46,17 @@ export function savedCredential(field: CredentialField): {
 
 /**
  * Keeps every other credential, and the file at mode 600 (spec §10.4). A missing file starts empty; an
- * unreadable or newer-schema one is refused (it throws) rather than overwritten.
+ * unreadable or newer-schema one is refused (it throws) rather than overwritten. The read and the write hold
+ * the file's lock (1.2 minor), so two concurrent `init`s never lose a key.
  */
 export function saveCredential(field: CredentialField, key: string): void {
-  const cur: z.infer<typeof CredentialsSchema> = existsSync(credentialsPath())
-    ? readCredentials()
-    : { schema: 1 };
-  writeJsonAtomic(credentialsPath(), { ...cur, schema: 1, [field]: key.trim() }, { mode: 0o600 });
+  mkdirSync(configDir(), { recursive: true });
+  withFileLockSync(credentialsPath(), () => {
+    const cur: z.infer<typeof CredentialsSchema> = existsSync(credentialsPath())
+      ? readCredentials()
+      : { schema: 1 };
+    writeJsonAtomic(credentialsPath(), { ...cur, schema: 1, [field]: key.trim() }, { mode: 0o600 });
+  });
 }
 
 /**
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun test test/catalog-refresh-workflow.test.ts test/entry/mcp-handshake-env.test.ts test/entry/tui/dialogs.test.tsx test/services/credentials.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS.

- [ ] **Step 5: Commit**

````bash
git add .github/workflows/catalog-refresh.yml catalog/ATTRIBUTION.md src/entry/mcp/handshake.ts src/entry/mcp/setup-tools.ts src/entry/tui/views/save-dialog.tsx src/services/credentials.ts test/catalog-refresh-workflow.test.ts test/entry/mcp-handshake-env.test.ts test/entry/tui/dialogs.test.tsx test/services/credentials.test.ts
git commit -m "fix: close the 1.2 minors in doctor, credentials, attribution, the refresh workflow and the TUI"
````

---

### Task 13: README, the skill's record line and the live kit say what `route` returns

README's bar paragraph says what `route` returns and that `routes.jsonl` keeps every decision; the live kit counts routed lanes without role and outcome rows and reads thresholds from `routes.jsonl`; the skill's `routes.jsonl` line lists the new rows.

**Scratch commit:** `a6ab10d` (docs: say what route returns and that routes.jsonl keeps every decision).

**Files:**
- Modify: `README.md`
- Modify: `docs/dev/live-verification.md`
- Modify: `plugin/skills/catherd/SKILL.md`

- [ ] **Step 1: Edit**

Edit `README.md` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/README.md b/README.md
index 7498a85..44e8df2 100644
--- a/README.md
+++ b/README.md
@@ -224,9 +224,12 @@ A lane's kind and difficulty pick a bar: a threshold on each dimension it spans
 `honesty`, `agentic`, `frontend`; `steer` is shown but has no default bar), and the lane starts on the cheapest
 rung that clears them all. A rung with no value on a dimension takes its nearest stand-in's as `inferred`, and
 `profile validate` and `doctor` list it as a "stand-in to confirm": confirm or replace it with `catherd catalog
-treat-like --suggest <rung>`, then `treat-like <rung> <like>`. `route` says, for the rung it picks, each threshold,
-the value used, its confidence and source, and catherd's own runs on it ("12 lanes, 2 climbed, 1 partial"), which
-it shows but never routes on. A bar of your own goes in `~/.config/catherd/catalog.override.json`, per dimension
+treat-like --suggest <rung>`, then `treat-like <rung> <like>`. A ladder holds only rungs at least as strong as its
+start, and rungs of equal scores on two quotas start on the one the run has used least. `route` returns the rung,
+its ladder and a one-line why (a lane's declared `Kind:`/`Difficulty:` wins over Jev, and the why says when Jev
+disagreed, when no rung clears the bar, or when a tie decided); the run's `routes.jsonl` keeps every role's
+decision with, for the rung it picks, each threshold, the value used, its confidence and source, and catherd's own
+runs on it ("12 lanes, 2 climbed, 1 partial"), which it shows but never routes on. A bar of your own goes in `~/.config/catherd/catalog.override.json`, per dimension
 (`"bars": { "ui": { "hard": { "frontend": 1700, "honesty": null } } }`: a number sets a threshold, `null` removes
 the default's).
 
````

Edit `docs/dev/live-verification.md` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/docs/dev/live-verification.md b/docs/dev/live-verification.md
index ede789a..a230c9c 100644
--- a/docs/dev/live-verification.md
+++ b/docs/dev/live-verification.md
@@ -354,8 +354,9 @@ Look for, one at a time:
 2. `peek` answered during the run: `grep -o '"name":"mcp__[a-z_]*catherd__peek"' run.jsonl | head -1` prints a
    line, before the last worker's record.
 3. Every lane was routed with valid headers:
-   `jq -r 'select(.source == "route") | .lane' "$run/routes.jsonl" | sort -u | wc -l` (the routed lanes; the
-   header row and climb rows do not count) is at least 4, and
+   `jq -r 'select(.source == "route" and .lane != null) | .lane' "$run/routes.jsonl" | sort -u | wc -l` (the
+   routed lanes; the header row, climb and outcome rows and a role's rows outside a lane do not count) is at
+   least 4, and
    `grep -hE '^(Kind|Difficulty):' "$run"/lanes/*.md | sort | uniq -c` shows only the catalog's values.
 4. A reviewer and a verifier ran before each `land`:
    `catherd runs show "$(basename "$run")" --json | jq -r '.records[] | "\(.startedAt) \(.name) \(.status)"'`
@@ -439,7 +440,7 @@ In a scratch repository, start a run and route two lanes through the MCP tools f
 ```sh
 scratch="$(mktemp -d)/bars" && mkdir -p "$scratch" && cd "$scratch" && git init -q && git commit -q --allow-empty -m init
 claude -p --output-format json \
-  "/catherd:catherd Start a run titled bars. Write lanes/M1.L1.md with 'Kind: terminal' and 'Difficulty: copy', and lanes/M1.L2.md with 'Kind: ui' and 'Difficulty: build' (each: Owns: a.txt, Fast check: true), then call route for each and print both answers' rung and provenance.thresholds as JSON. Do not dispatch." \
+  "/catherd:catherd Start a run titled bars. Write lanes/M1.L1.md with 'Kind: terminal' and 'Difficulty: copy', and lanes/M1.L2.md with 'Kind: ui' and 'Difficulty: build' (each: Owns: a.txt, Fast check: true), then call route once with both in lanes, print each answer's rung and why, and print the provenance.thresholds of both lanes' rows in the run's routes.jsonl as JSON. Do not dispatch." \
   | jq -r .result
 ```
 
````

Edit `plugin/skills/catherd/SKILL.md` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/plugin/skills/catherd/SKILL.md b/plugin/skills/catherd/SKILL.md
index baebd54..41a0eb7 100644
--- a/plugin/skills/catherd/SKILL.md
+++ b/plugin/skills/catherd/SKILL.md
@@ -164,7 +164,7 @@ A climb is for capability only. When the evidence says the lane cannot be done a
 A failure on the top rung (`top: true`) goes to the architect when Jev calls it design, else to the report as open.
 
 - Jev decides which model does the work. It never decides that the work is done: only a check, the reviewer or the verifier does.
-- `R/routes.jsonl` records each lane's rung and every climb with its reason; `R/outcomes.jsonl` gets one row per lane when its milestone lands or it fails its top rung; a lane written again (landed after failing its top rung, or re-landed) keeps its rows, and the last row per lane wins.
+- `R/routes.jsonl` records every role's decision (its why and provenance, a lane-less dispatch's rung too), each lane's rung, every climb with its reason, and each lane's outcome beside Jev's answer; `R/outcomes.jsonl` gets one row per lane when its milestone lands or it fails its top rung; a lane written again (landed after failing its top rung, or re-landed) keeps its rows, and the last row per lane wins.
 - Never put a secret or a key into an `ask` state. Keep the state short and in English.
 
 ## Threads
````

- [ ] **Step 2: Check**

Run: `bun test test/skills.test.ts test/plugin.test.ts && bun run format:check`
Expected: PASS.

- [ ] **Step 3: Commit**

````bash
git add README.md docs/dev/live-verification.md plugin/skills/catherd/SKILL.md
git commit -m "docs: say what route returns and that routes.jsonl keeps every decision"
````

---

### Task 14: `ideas.md` loses what plan 24 fixed

Removes every entry this plan fixes and trims two to what stays open: the shipped file's `adjacent` spreading (Ruling 17) and Jev difficulty calibration (the logging is done, the tuning is not). Nothing else changes.

**Scratch commit:** `35a8a66` (docs(ideas): remove what plan 24 fixed).

**Files:**
- Modify: `docs/dev/ideas.md`

- [ ] **Step 1: Edit**

Edit `docs/dev/ideas.md` (diff; re-find each hunk by its context, line numbers may have moved):

````diff
diff --git a/docs/dev/ideas.md b/docs/dev/ideas.md
index 0e2ddaf..3a568f6 100644
--- a/docs/dev/ideas.md
+++ b/docs/dev/ideas.md
@@ -77,55 +77,19 @@ report; quota failover (the profile's `failover` map); the `preflight` tool; per
 Owner rule: review Minors and non-correctness bot P2s land here, not in code. From the plan 13 final review
 (`ee661e4..5209310`):
 
-- **doctor's handshake starts a boot sync** (`src/entry/mcp/handshake.ts`): each `doctor` with a stale cache spends
-  fetches (AA included) in a server it kills a moment later, and records nothing. Set `CATHERD_NO_SYNC=1` in
-  `handshakeEnv`.
 - **Piped `init` reads a new line order** (Jev, AA, profile, replace): an old script piping `KEY\nwork\ny` now sends
   `work` as the AA key. Say so in the 1.2 changeset and MIGRATION (plan 14).
-- **Fetchers store an answer of the wrong shape as a success** (AA `pages: []`, an Arena answer without `rows`),
-  replacing the last good one. Throw when a parser yields no rows or page 1 is empty.
-- **`writeDerived` does not validate what it writes**, while `readDerived` does: one score with a bad date makes the
-  whole file unreadable. `ScoreSchema.safeParse` each score in `derive` and drop the invalid ones.
-- **`catalog_sync` right after boot** waits up to 120 s for the boot sync's lock and may throw `E_IO_LOCK` when
-  sources hang. Return `busy` from the tool instead of waiting.
-- **`testAaKey` retries 429 and 5xx** through `sourceGet` (up to 3 requests); the spec says one. Pass `retries: 0`.
-- **doctor's "requests left today" can be stale:** a failed AA attempt with no header keeps the old
-  `rateLimitRemaining` under a new `lastAttemptAt`. Keep the header's own timestamp.
-- **`derive` keeps the highest value per key** whatever the field's direction; fine for today's dims, wrong for
-  `cost_per_task` or time to first token once they are facts. Carry a direction per field.
-- **`saveCredential` writes without a file lock**; two concurrent `init`s could lose a key (the Jev key's old
-  pattern). Take the profiles lock or a credentials lock.
 
 From the plan 14 final review (`cff7d19..04a48e2`) and its plan writer:
 
-- **A threshold's `why` in `route` always shows the default's `barsWhy`**, even when the user's override replaced
-  it (`provenance.ts`): `min: 70` beside "the median … 66.6". Say "your override" when `c.bars` differs.
-- **A failover stand-in scored only by an inferred stand-in has no mark** in `profile show` and the tree
-  (`note` is set only for a treat-like). Add "`<dims>` inferred from X".
-- **`route` reads every run on the machine for evidence, unguarded** (`routing-service.ts`): an unreadable run file
-  fails routing, though evidence is display-only. Wrap it; `evidence: null` on error.
-- **The TUI save preview checks the repair rule against a profile with no stored file**, which the service refuses:
-  the dialog offers Save and the save comes back invalid. Preview `repair: false` when the profile does not exist.
-- **An unscored `defaultRung` falls back silently** to the cheapest candidate (`select.ts` `defaultLadder`); say so
-  in the warning.
-- **`speedLadder`'s main dimension for `ui` is `repo_code`**, while `ui` now gates on `frontend`.
-- **Ruling 7 says `steer` is never inferred**, but a user's steer bar makes it inferred (`standins.ts` `barDimsIn`).
-  Align the ruling or the code.
-- **`catalog/ATTRIBUTION.md` says models.dev data is never shipped**, but `models.json` now ships its release dates.
-  Move models.dev to the shipped section with its MIT line.
-- **`catalog-refresh.yml` keeps the token in `.git/config` while `bun install` runs scripts** (as `release.yml`
-  does). `persist-credentials: false`; push with the token only in the PR step.
-- **`valueWords` in `provenance.ts` is exported and unused.**
-- **`adjacent` values overstate lower efforts** (Luna none carries Luna max's DeepSWE). A per-effort discount, or
-  spreading only upward, once sources score low efforts (plan 14 Ruling 3).
+- **The shipped file's `adjacent` values overstate lower efforts** (Luna none carries Luna max's DeepSWE). A sync
+  spreads only upward since 1.5 (plan 24); the weekly rebuild of `catalog/scores.json` still spreads both ways,
+  since the default ladder's Luna rungs rest on a value published only at max (plan 14 Ruling 3). A per-effort
+  discount, or spreading only upward there too, once sources score low efforts.
 - **The logic and hard bars sit above every Sol rung** on the default ladder (Sol agentic 0.0818 vs 0.08606): the
   owner's call, percentiles as specced or a ladder with a stronger top rung.
 - **Haiku 4.5's terminal value returns** when Epoch's Terminal-Bench covers five anchor rungs (plan 14 C-2).
 - **The Artificial Analysis fixtures are synthetic** (plan 13 R-C); re-record them with a key.
-- **`catalog list` says "inferred from X" for a user treat-like's values too**, the same as a stand-in's guess;
-  tell a user's mapping apart ("like X").
-- **`treat-like --clear` does not name a rung that keeps some values but loses a bar dimension** to no stand-in
-  (neither unscored nor inferred). Spec §6.4 arguably covers the partial gap.
 - **The text `catalog list` format changed in 1.2** (values line, then `runs:`); any script scraping it should use
   `--json`.
 
@@ -521,7 +485,6 @@ Run `20260928-172920-m3-auth-plan-5-mr-b-the-kit-clean-up` (sanitell/platform, a
   - the L4 fix record listed its 7 concurrent doc edits as L4 violations.
 
   Fix: give non-lane roles an Owns (or a docs lane), and attribute each edit to the process that wrote it.
-- **Jev overrode the lane headers.** All four first lanes declared `Kind`/`Difficulty`, and routing replaced them (declared logic → `repo_code`/`copy`), so the logic lanes started on `luna#high`. Fix: a declared header wins, or the route record says why it didn't.
 - **A lane could not declare an allowed exception to its own absence grep.** The plan's `func Allowed` grep also matched an unrelated `services/verification/internal/job/command.go:120`, and `acceptancetest\.SignIn` matched the surviving `SignInAuth` and `SignInSSO`. The workers returned partial correctly, but a check that can never pass looks the same as work that isn't done yet. Fix: an `Allow:` line under the check, and word boundaries in plan greps.
 - **`dispatch` accepted a thread id that doesn't exist.** The orchestrator passed a wrong thread for the L4 fix, the role launched, and codex failed with "no rollout found for thread id". Fix: check `thread` against `runs.jsonl` (same name) before launching, or default to the name's last thread.
 
@@ -574,9 +537,6 @@ catherd 1.2.1, profile just-claude, sanitell/platform payment plans 1–11. That
 
 **Routing and dispatch**
 
-- **`route` bloats the orchestrator.** Every call returns the full provenance block, about 3k tokens per lane, into the most expensive context of the run. Fix: return rung, ladder, backend and agent, and write provenance to `R/routes.jsonl`.
-- **Ladders were inverted on just-claude.** `Difficulty: build` lanes got the ladder [sonnet#high] with no room to climb (source `jev-kind`). `logic` lanes started lower, at sonnet#medium. Every claude-code value in provenance was `inferred` from a gpt-6-sol benchmark. Evidence: the first four routes of runs `-113331`, `-113334` and `-113338`.
-- **`dispatch` needs a rung it then overrides.** `rung` is required, even when the lane is not routed yet. The orchestrator guessed a rung, and dispatch overrode it with a hint. Fix: make `rung` optional on a lane dispatch.
 - **The catherd message does not carry the thread id.** Passing the dispatchId gave `E_ADMIT_THREAD`. Every fix round needed `jq … runs.jsonl`. Fix: put `thread:` in the message's first line, or accept `thread: "latest"`.
 - **Lane values are refused only at preflight.** `Difficulty: medium` (the word plans use) was refused as `E_LANE_INVALID` at preflight, not when `write_run_file` wrote the lane. Evidence: run `-135414`.
 - **There is no `lane_set`.** Fixing one header line (a fast check without `pnpm check`, or an Owns path) meant `sed` on the run folder. Evidence: runs `-113331` and `-143512`.
@@ -686,27 +646,6 @@ owner turned isolation off (the host is itself a sandbox).
   goal continuation while only roles are live ends the turn with no tool call. `peek` returns
   `actionable: false` with the reason, so the coordinator has a one-call answer. Also consider `run_start` warning
   when the thread has an active goal.
-- **Equal scores never reach the second quota.** In 34 dispatches there were 0 opencode rungs and 0 climbs. Under
-  `objective: speed`, DeepSeek 4.1 Flash max (treat-like GPT-6 Luna xhigh, the same values as Luna high) sits
-  second in the worker ladder, so Luna always won. The writer and researcher ladders behaved the same way. The
-  ChatGPT plan carried everything while the OpenCode Go subscription sat idle. Fix: break ties on quota headroom
-  across billing keys, starting the lane on the less used subscription when scores tie. Or add an objective that
-  balances subscriptions. `route` says when a tie decided the pick.
-  Root cause, found after the run: the profile's ladder order is never read. `candidates` sorts by cost
-  (`compareCost`), or by measured seconds first under `speed`. The three opencode-go models have no catalog family,
-  so `costOf(null, …)` returns `value: null` and they have no `secs` yet, and both sorts put them after every Codex
-  rung. Only `billing.codex: metered` (tier 1) together with `objective: cost` put them first. A dry run of
-  `select` then started worker copy/build/prose lanes, and every writer and researcher lane, on DeepSeek or Muse.
-  Fix: an unpriced subscription rung costs 0 within its tier, not "unknown, last". The profile's ladder order breaks
-  ties. `profile validate` warns about a subscription rung that can never start.
-- **The climb ladder goes down above the top rung.** `M1.L2` (repo_code/hard) got the ladder
-  `gpt-6.1-sol#medium → deepseek-v4.1-flash#max → glm-5.3-flash#max`: no rung cleared the hard bar, so the "climb"
-  was all weaker rungs. Fix: a climb ladder holds only rungs that score at least the start. When nothing clears the
-  bar, `route` says so (`no rung clears repo_code/hard; best is …`), and `profile validate` warns about a kind and
-  difficulty no rung of a role can reach.
-- **Only worker dispatches leave a route record.** `routes.jsonl` has 11 entries for 34 dispatches. The writer,
-  researcher, reviewer, verifier and architect rungs (for example writer on Luna high instead of the ladder's first
-  rung) cannot be audited. Fix: `route` and `dispatch` record every role's decision, its source and the ladder.
 - **A superseded run stays open.** Planning run `20261002-002615-…` (main checkout) handed over to the execution run
   in the worktree, because there is one run per worktree. It still lists as `idle`, with
   `Protocol next: route and preflight M1's lanes`. Fix: `runs supersede <run> --by <run>` (or a field set by
@@ -738,12 +677,6 @@ owner turned isolation off (the host is itself a sandbox).
   (pids 633954 and 634083 as host codex, and 634148 as host `unknown`). Each reconciled the runs. Check whether
   Codex spawns the plugin server per tool context. If so, make boot sync and reconcile single-flight across
   processes.
-- **Scores of a new same-family release start absurd.** With no public numbers, GPT-6.1 Sol was inferred at
-  repo_code 37.2 (low) and 56.6 (medium), below GPT-6 Luna, so the router would have avoided it. It was fixed
-  locally with `treat-like` from the Artificial Analysis Intelligence Index per effort (slopalytics.com): Sol 6.1
-  medium 47.8 ≈ Astra low, high 50.2 ≈ Astra medium. GLM 5.3 Flash max (41.8) and DeepSeek 4.1 Flash max (39.5)
-  were mapped the same way. Fix: read the AA Intelligence Index per model and effort as a calibration source. Until
-  a value arrives, a release of the same family takes at least its predecessor's values at the same effort.
 - **A native role steals the run, and every later result goes to it (P1).** Isolation was turned off, so roles
   launched with `codex exec` load the user's config, including the catherd plugin. At 11:08:37
   `verifier-M1-verification` called `peek({run})`. Its prompt included the coordinator section of AGENTS.md, and
@@ -796,22 +729,15 @@ owner turned isolation off (the host is itself a sandbox).
   window still reaches a native `-p` (which opens a browser). Document it, or re-run `agy models` in native
   `prepare` (~10 s a dispatch). (Plan 17 final review, Minor 3.)
 
-- **A sparse rung borrows its nearest stand-in's honesty.** Shipping GPT-6.1 Sol's one honesty value (97.92, a
-  Broken Search Tool figure) would have become the honesty stand-in for 18 unrelated rungs, e.g.
-  `opencode/claude-haiku-4-5#high` 22.5 → 97.92: the similarity ranking seems to favour rungs with few values of their
-  own. Check the nearest-stand-in distance before shipping any single-dimension row. (PR #36.)
-
 ## Routing and cost
 
 - **Jev hit-rate review.** After N runs, show how often each Jev start rung had to climb, per kind and difficulty:
   "build lanes on `codex:gpt-6-luna#high` climbed 3 of 10". _Why:_ it is the raw material for catalog tuning, and it
   tells the user whether a bar is too low today. _Where:_ `runs_summary`, `watch`, and the setup skill.
 - **Jev difficulty calibration.** In the first two real runs Jev was sure of the kind (1.0) but not the difficulty
-  (0.4), so 3 of 4 routes fell back to the default. Log each lane's final outcome (climbed or not) beside Jev's answer,
-  then tune the difficulty question's wording, its options or its threshold from that data.
-- **Batch `route`.** `route` takes one lane per call, and each call may wait up to 25 s on Jev, so a milestone of
-  six lanes can spend minutes routing before its first dispatch. One `route(run, lanes: [...])` could ask Jev for
-  every lane at once and return one answer per lane. _Where:_ the `route` tool and `routing-service.ts`.
+  (0.4), so 3 of 4 routes fell back to the default. Since 1.5 each lane's final outcome (climbed or not) is logged
+  beside Jev's answer in `routes.jsonl` (plan 24): tune the difficulty question's wording, its options or its
+  threshold from that data.
 - **First-turn cost on small lanes.** A native Codex turn starts at about 280k input tokens (mostly cached) whatever
   the lane's size. A profile rule such as "isolated below difficulty build" could save most of it without touching the
   user's harness for real work. _Where:_ the profile's `harness.<backend>.isolated`, made conditional.
````

- [ ] **Step 2: Check**

Run: `grep -c 'Batch `route`\|Equal scores never reach\|sparse rung borrows' docs/dev/ideas.md`
Expected: `0`; the "Not in 1.5" entries (the logic and hard bars, Haiku's terminal value, the AA fixtures, the Jev hit-rate review) and the entries other plans own are still there.

- [ ] **Step 3: Commit**

````bash
git add docs/dev/ideas.md
git commit -m "docs(ideas): remove what plan 24 fixed"
````

---

## Self-review (plan writer)

- Every spec bullet of "Plan 24: routing and cost", and each of the 21 minors its last bullet names, maps to a task (Spec coverage). The "Not in 1.5" items stay in `ideas.md`: the logic and hard bars (X6: no bar or `catalog/scores.json` value changes here), Haiku's terminal value, the AA fixtures, the Jev hit-rate review; "First-turn cost on small lanes" is not in this plan's section and stays.
- The scratch build was replayed in the Parallelism order (9, 11, 12, then 1–4, 5–8, 10, Task 2's test commit, 13, 14) on `6f2f8c7`: no conflict, and the same tree as `35a8a66`.
- Every task's code is its scratch commit's diff, file by file, tests first. The gate on the scratch head: 2062 pass / 19 skip / 0 fail, 184 files; typecheck, lint, format:check green.
- Behaviour changes a reviewer should expect in the diffs: the approved default ladder loses Sol high on copy lanes and gains `noClear` on logic and hard lanes, ui logic and hard start at Sol xhigh (Rulings 4, 5); an unpriced Go rung starts the lanes it clears (Ruling 1); `route`'s answer shrinks to seven keys (Ruling 11); a declared header beats Jev (Ruling 10); a sync no longer carries a value down to weaker efforts (Ruling 17); the default profile's explicit `profile validate` prints one warning instead of `✓ valid` (Ruling 3).

## After the plan

Plan 25 owns the dispatch thread check (X3) and the per-run pin of the profile; plan 26 the remaining 1.1/1.2/1.3 minors (including "Piped `init` reads a new line order" and "The text `catalog list` format changed in 1.2", which this plan's section does not name); plan 27 the 1.5.0 changeset, whose notes list this plan's user-visible changes: `route`'s smaller answer and `lanes`, `dispatch`'s optional `rung`, the new `routes.jsonl` rows, the tie and reach lines, and the two owner questions' answers.
