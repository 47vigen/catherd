# Ledger: plan 33, routing on one scale (docs/plans/2026-10-21-33-routing.md)

Ruling: commit trailer is "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" — the dispatch message names Opus 5.5, the brief file names Sonnet 5.5; the message is the later and more direct instruction — cost: trailer text only.

Task 1 done (74a4637). Task 2 done (213f47b). Task 3 done.
Ruling: tests that pinned plan 29's bars or a route on the fixture/PAIRS pool were re-derived under 20/45/60/65, not loosened (select.test PAIRS bars 28/38/44/46 and the "no raise" case gets four more 90-intelligence Opus pairs so copy stays unreachable; profile-rules "reach" case now uses a worker without Sol xhigh; routing-service COPY is now Luna high with the full ladder and hard routes to Sol xhigh) — plan Ruling 6 / Task 3 Step 3 — cost: none.
Ruling: two profile-service cases and one profile-rules case that set Opus `#max` on the default profile now also clear its `maxEffort` cap (`maxEffort: {"claude:claude-opus-5-5": null}`), since the shipped cap makes that rung unroutable (an error by Ruling 12) — the cases test agent linking and quota warnings, not the cap — cost: none.
Ruling: the existing select "skips bad rungs" and "climbs only onto rungs" cases moved their `#low` rungs from the worker role to the writer role, since a worker never runs below medium — cost: none.
Ruling: `idleQuotas` takes no `at` parameter — it routes through `select`, which already reads `RoutingProfile.bars` — cost: none.
Ruling: `EffortWord`/`effortRank` live only in ids.ts (Ruling 13), profile.ts does not re-export them — cost: none.

Task 4 done.
Ruling: Task 4's tests stand in with opencode-go GPT-6 Luna (low and xhigh) instead of Kimi K3 (low and max) — the shipped catalog lists no Kimi, so `catalogPairs` never offers it to the pool and the plan's cases could not pick a ranked stand-in; the fixtures pin the run's own index with `writeRunIndex`, since `freshRun()` swaps the home. The filter itself is as specified (explicit stand-in and every pool rung pass `effortAllowed`) — cost: none.

Task 5 done (cc912d5). Task 6 done.
Ruling: the live-verification section is "21. Routing on one scale (2.0, plan 33)", not §20 — §20 is already the panel's (plan 31); the README bars sentence and MIGRATION's existing "25th, 50th, 60th and 75th" bullet were changed to 20/45/60/65 as well — cost: none.
Ruling: ideas.md's new "## 2.0 follow-ups (plan 33)" sits above the existing "2.0 follow-ups (plan reviews, 2026-10-21)" heading, as the plan says (above the newest) — cost: none.

Full gate, first run: 3 failures, all tests that pinned "the default worker reaches no hard bar" (test/entry/mcp-profile, two cases in test/entry/profile-command).
Ruling: re-derived them under 20/45/60/65, where the default worker reaches every difficulty: the mcp validate case drops the "no worker rung clears hard" warning, the bound-repo case trims the fast profile's worker ladder to Luna high + Sol medium (warns "logic, hard") and checks default stays "✓ valid", the validate case expects "✓ valid" — plan Ruling 6 — cost: none.

## Review fixes

Final review: 0 Critical / 0 Important; 2 minors fixed.
- fd1439b fix(profile): a stored `maxEffort` entry that is no effort word (a number, an object, a word a newer catherd wrote) made the whole profile unreadable. The schema now takes unknown values, like `bars`; the entry is ignored and validate warns, naming it.
- f56db87 fix(routing): the failover row's `held` listed every key of `s.holds`, expired holds too. It now lists `heldQuotas(s)`, the live ones.
- Four follow-ups logged in docs/dev/ideas.md under "2.0 follow-ups (plan reviews, 2026-10-21)": a lane-less failover with no route row, bars out of order, an explicit lane-less rung skipping floor and cap, and run_start's refusal naming the wrong cause.
- Gate after the fixes: 2067 pass, 18 skip, 0 fail (typecheck, lint, format:check clean).
