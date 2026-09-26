# SDD ledger — plan: docs/superpowers/plans/2026-09-25-04-catalog-routing.md
Branch: claude/ecstatic-pasteur-yidat7, base 2c01441
Ruling: all plans are developed on the harness-designated branch claude/ecstatic-pasteur-yidat7, one PR per plan, branch restarted from main after each merge — the session may push only there — cost if wrong: none, branch names are cosmetic.
Ruling: pre-flight scan runs concurrently with wave 1 (tasks 1,4,5,6) instead of before it — the plan was replayed end-to-end in a scratch copy, so conflicts are unlikely and wall-clock matters — cost if wrong: redo of a wave-1 batch.
Ruling: worker agents are general-purpose with model opus (custom opus-low/medium types don't load mid-session); effort cannot be set per dispatch — cost: more tokens per task.
Wave 1 dispatched: T1 (batch A), T4+T5 (batch B), T6 (batch C) from 2c01441.
Wave 1 cherry-picked: T4-5 2c01441..a8dc8ef, T1 a8dc8ef..d241d81 (reviews dispatched). Wave 2 dispatched from d241d81: T2, T8.
T6 cherry-picked d241d81..dd730d2
Task 6: complete (commits d241d81..dd730d2, review clean)
Task 6: minor (deferred): see task-6-review.md Minor list (3 items)
Task 6: carry-over to Tasks 7/9/11: tests reaching claudeCodeAdapter.listModels() must inject fetchImpl or delete ANTHROPIC_API_KEY (else live API when dev has a key).
Task 1: complete (commits a8dc8ef..d241d81, review clean)
Task 1: ⚠️ to verify at T3/T7/T11: approved-ladder pin test (T3) and shipped treat-likes shown as inferred (T7/T11).
Task 1: minor (deferred): capableFor looks up listing by rung's own backend while rungInfo maps claude->claude-code (no result change today).
Ruling: T4 judgeRoute float-sum (0.1+0.7<0.8) and T5 body read not bounded by deadline are plan-mandated but real defects — fix both (spec §5.5 thresholds and "25 s hard deadline" are binding over plan code) — cost if wrong: small extra code.
Task 4-5: fix round 1 dispatched (resume implementer) from dd730d2.
T8 cherry-picked dd730d2..00beff8
T2 cherry-picked 00beff8..257b3bd; wave 3 (T3, T7) dispatched from here
Ruling: T8 saveJevKey swallowing read errors (newer-schema/unparsable credentials overwritten) is plan-mandated but a real data-loss defect — propagate errors except a missing file — cost if wrong: none. Task 8: fix round 1 dispatched.
Task 2: complete (commits 00beff8..257b3bd, review clean; 257b3bd is the cherry-pick of 3a7ff8b, same tree delta)
Task 2: minor (deferred): no test for chatgpt-plan family without planWeight fallback; Fable test checks metered only, not ordering.
Task 2: ⚠️ ultra never in default ladder -> verify in T3/plan 5 default profile.
T3 cherry-picked 257b3bd..d127c2f
T7 cherry-picked d127c2f..b9ab75f
Ruling: T9 dispatched from b9ab75f while fix rounds for T4/5/T8 are open — fixes touch only jev.ts/jev-client.ts/jev-service.ts internals with unchanged interfaces — cost if wrong: cherry-pick conflict in T9 tests.
Preflight (see preflight.md table) — rulings adopted:
- Ruling: In Task 7's catalog-service test and Task 9's routing-service test, have `beforeEach` delete `ANTHROPIC_API_KEY`, as Task 11's CLI test already blanks it — Task 6 made the claude-code listing an HTTP call whenever that variable is set, and both tests freshen claude rungs through the real adapter — cost if wrong: on the owner's machine these tests call api.anthropic.com with the real key and can fail on bun's 5 s timeout.
- Ruling: In Task 11's replacement of `src/routing/catalog.ts`, make the 0.x `OverrideSchema` a `z.looseObject` and have its `saveTreatLike` write through `writeJsonAtomic` inside `withFileLock` (0.x may import infra: Task 11 already has `routing/jev.ts` import from services), and add a `test/catalog.test.ts` case that keeps a 1.0 `scores[]` — the TUI matrix still saves treat-likes through this writer until plan 6 — cost if wrong: a treat-like saved in the TUI silently deletes the user's 1.0 score overrides and races `catherd catalog treat-like`.
- Ruling: Task 9 updates the `catalog_query` description in `src/entry/mcp/setup-tools.ts` and `plugin/skills/catherd-setup/SKILL.md:31` from `installed` to `listed` ("`listed: false`: this account's backend does not offer it"; "`enabled: false` rungs are unscored") — the routing port's catalog answer changes shape in Task 9, and neither file belongs to any task — cost if wrong: the setup skill reads a field that no longer exists, so it offers models whose backend the account cannot run.
- Ruling: In Task 8, either drop "and never the state" from the test name, or build the logged row from a real `askJev(dir, "route-v2", STATE, …)` result and then assert that the file lacks the state's text — the current assertion cannot fail, and Task 9 already pins the log end to end — cost if wrong: a reviewer flags a hollow test and asks for a fix round.
- Ruling: In Task 9, rename the hang test to "falls back to the lane's declaration when every attempt times out". Change Review Focus 1 to cite Task 5's "stops early rather than sleep past the deadline" as the deadline pin, and to say that the discovery refresh before Jev has its own hour-long backoff (Focus 3) and is outside the 25 s budget — the test never reaches the deadline — cost if wrong: a reviewer checking Focus 1 finds the claim unproven and asks for a fake-clock rewrite of a test that already passes.
- Ruling: Fix `capableFor` to read the same listing key as `rungInfo` (`claude` → `claude-code`). Wave 1 is merged, so fold the one-line change into Task 3 or Task 7 — the two functions disagree about the native backend's listing — cost if wrong: a claude-code-listed model with no shipped family loses its image input on `claude:` rungs, so ui-reviewer refuses it; the effect is small today.
- Ruling: Task 11 also deletes `test/fixtures/jev/route-unsure.json`, `same-defect-no.json`, `rate-limited.json` and `validation-error.json`, or Task 5's test is changed to read the last two — after this plan, nothing reads them — cost if wrong: four dead fixtures, a review nit only.
- Ruling: Task 10 adds `outcomes.jsonl` to spec §4.1's run-folder listing and removes "and lane outcomes" from the `routes.jsonl` line; §5.5's "counts and facts computed in code" is accepted as deferred to `jev eval` (1.x), and the spec says so — the spec contradicts itself on where outcomes live — cost if wrong: documentation drift only.
Status: C1 done in T7, sent to T9; C4 done in T8 fix; C3,C5,C6 sent to T9; C2,C7 carried to T11 dispatch; C8 carried to T10 dispatch.
Task 3: complete (commits 257b3bd..d127c2f, review clean; 4 minors in task-3-review.md deferred)
Task 7: complete (commits d127c2f..b9ab75f, review clean; 5 minors in task-7-review.md deferred)
Task 8: fix round 1/5 (1 addressed, 0 open Important; 2 minors declined: jevKey null on corrupt file (contract), cached answers unvalidated; commits b9ab75f..62e22f1)
Task 8: complete (commits dd730d2..00beff8 + 62e22f1, review clean after fix)
Task 4-5: fix round 1 commits 62e22f1..fa09675; re-review dispatched. Not applied: judgeVerdict fallback-in-options check (needs decision).
Task 4-5: fix round 1/5 (2 addressed, 0 open; commits 62e22f1..fa09675)
Task 4: complete (commits 2c01441..a8dc8ef + fa09675 fixes, review clean after fix)
Task 5: complete (same, review clean after fix)
Task 4: minor (deferred, final review): add a test that each catalog/jev.json verdict set's fallback is among its caller's options.
T9 cherry-picked fa09675..478e71a (gate green 823 tests); wave 5 T10, T11 dispatched from 478e71a
Ruling: T9 route awaiting freshenDiscovery unbounded (serial backend listings, ~75 s worst case) is plan-mandated but violates Review Focus 1/3 — freshenDiscovery lists backends in parallel and route races it against a 5 s budget, falling back to the cached listing while the refresh finishes in the background — cost if wrong: first route of the day may use a day-old listing. Task 9: fix round 1 dispatched.
T10 cherry-picked 478e71a..664c761
Ruling: T10 multiple outcome rows per lane — plan Ruling 8 intends append + 'readers take the last'; keep appends, but make it explicit: doc comment on OutcomeRow/appendOutcome and readOutcomes gains a latest-per-lane helper with a test — cost if wrong: a 1.x jev eval reader double-counts. Task 10: fix round 1 dispatched.
T11 cherry-picked 664c761..440a8ff
Task 9: fix round 1/5 (1 addressed; commits 440a8ff..df13339); Minors applied except scrubFree.
Ruling: scrubFree for finding/same-defect free text is required (Review Focus 2: nothing secret or fenced reaches Jev) — do it in T9 round 2 — cost if wrong: request keys change (nothing persisted yet).
Task 10: fix round 1/5 commits df13339..efaff8d; minor not applied: free-form milestone prefix (deferred to final review)
Task 10: complete (commits 478e71a..664c761 + efaff8d fix, review clean after fix round 1; minor deferred: milestone typo matches no lane silently)
Task 9: fix round 1 re-review: all addressed (commits 440a8ff..df13339). Round 2 (scrubFree) in flight.
Task 11: complete (commits 664c761..440a8ff, review clean); minors deferred: matrix.tsx ignores rejected save; 0.x saveTreatLike doesn't write schema:1 on new file; target check before lock.
Task 9: fix round 2/5 commits efaff8d..f6f3f89 (scrubFree)
Task 9: complete (commits fa09675..478e71a + fixes df13339, f6f3f89; review clean after 2 rounds)
Final review (f6f3f89): needs fixes — I1 treat-like typo saves invalid rung and breaks routing; I2 indented fences reach Jev. One fix wave dispatched incl. non-blocking: jev.json fallback test, matrix rejected save, Bearer/URL-password scrub, treat-like on scored rung no-op message, TUI init saveJevKey catch, MCP stdio test env ANTHROPIC_API_KEY.
Ruling: finding/sameDefect ignoring jev.use "off" is carried to plan 5 (profile jev.use is stored there) — cost if wrong: Jev asked with use off until plan 5.
Ruling: Claude rungs never clear shipped bars (no honesty score) — follows plan Rulings 3–4; carried to plan 5's default profile (Claude as explicit rungs/failovers, not via bars) — cost if wrong: Claude never auto-selected in mixed ladders.
Final fix wave commits f6f3f89..164da1b; scoped re-review dispatched
Final fix wave: re-review clean (all addressed, no new breakage). Plan 4 implementation done; awaiting Codex bot + CI.
Codex review (164da1b): P1 per-repo opencode discovery, P2 scrub Owns — fixed d9d8654, 4564d79; threads replied
Ruling: Codex P1 (0.x bridge loses models.dev-only rungs) not fixed — plan 5 removes the bridge and refuses 0.x profiles before any release — cost if wrong: an unreleased main between PRs mis-routes such profiles. Merging PR #6 after 7 Codex rounds, CI green at d60e602.
