# SDD ledger — plan: docs/plans/2026-10-23-37-panel-v2.md
Spec: docs/specs/2026-10-23-panel-v2-design.md. Branch panel-v2, base 38d9083.
Mode (repo CLAUDE.md overrides skill): waves in parallel in isolated worktrees, cherry-pick, one gate per wave, one Opus review at end, one Codex round.
Ruling: markdown rendered with react-markdown + remark-gfm (plan Ruling 9 overridden) — readability for any user — one more UI dep.
Wave 1a dispatched: tasks 1-7.
Wave 1a agents (sonnet high, isolated worktrees): T1 a4fd034a, T2 a44d5375, T3 ac3a301c, T4 aaadd701, T5 a6968750, T6 af170e3e, T7 af8ba9a7.
T1 done: c1b89f8 (branch worktree-agent-a4fd034ab8050c586) — RunViewSchema gained paused; T8 must regen openapi+client.
T2 done: f4005d2 (worktree-agent-a44d5375d9cb6f654) — parkedQuestions uncached; 1.5 runs counted ended.
T5 done: 97b069e (worktree-agent-a696875071af736df) — setup passes real host; probeCache.clear race noted.
T4 done: 965bf78 (worktree-agent-aaadd701efeafab64) — non-rejected rate_limit_event dropped; empty thinking items emitted (UI should hide).
T6 done: 3767b57 (worktree-agent-af170e3e5c123aa18) — diff read whole then cut 1MB; runDoc no size cap (final review item).
T3 done: a6fc803 (worktree-agent-ac3a301c60e695bc3) — ended run: parked/running nodes become cancelled/failed; synthetic tests for failover/integrate/question.
T7 done: 875a15d (worktree-agent-af8ba9a7e130ae2aa) — CodeBlock only json|text (markdown fences/ts not highlighted); Term uses Focusable.
Ruling: CodeBlock gains languages (markdown, ts/js, bash, diff, json, yaml, text via shiki) — owned by Task 12 (transcript view) in wave 2 — Markdown fences need it — small.
Wave 1a combined: 2252472..579c69b. Gate: root 2324 pass, 1 fail (openapi drift, expected: T8 regenerates); web 131 pass. Static clean.
Wave 1b: T8 dispatched.
T8 done: bf10ac5 picked as 9bd640b — preview refused on unknown host; socket error frame + patch:null→refetch; RunsTable status local.
Ruling: Task 12 owns web/src/components/code-block/** (CodeBlock languages) — Markdown fences need highlighting — none.
Ruling: TranscriptView export {runId,dispatchId,live} from runs/-components/transcript/TranscriptView.tsx unless brief names otherwise — T11/T12 contract.
Wave 2 dispatched on 9bd640b: T9 abfbe08d, T10 aafa87c1, T11 a32821c4, T12 a3a0c1b7, T13 a1c1d17c, T14 af4d3605.
T9 done: 6e72131 (worktree-agent-abfbe08d0ff2feb25).
T14 done: aa39252 (worktree-agent-af4d36057aa609af4) — plan link #plan needs id=plan (T11/T15); links are href (full loads) → wave 3 polish.
T10 done: 5aea9a4 (worktree-agent-aafa87c1d7b390970) — cost/tokens one chart w/ toggle; repo filter in dashboard header.
T12 done: 7449b52 3946074 (worktree-agent-a3a0c1b7d714017f8) — Markdown.tsx must pass lang to CodeBlock (controller fixes after merge); live tail polls 1.5s → T15 swaps to socket watch.
design-lists done: 745c1de (worktree-agent-a92d450005d75c9d2) — strips list defaults from URLs; may conflict in runs/-route.test.tsx
design-dashboard done: 87e3ba4 (worktree-agent-ad759dfa6a80c9b4a) — bento, recharts, stat sheet; empty recent-runs box not reproduced (list replaced by a table)
design-setup done: 096da34 (worktree-agent-a9bc68fec33d6efbe) — roles overview + drawer editor, segmented access, settings tile.
Follow-ups (controller, after merge): /api/setup blocks on probes → split probes (profile first, probes later); bare HeroUI Switch without Switch.Content is unclickable — sweep other pages; /api/setup hangs with empty HOME (a probe never returns) — add a timeout; Failover/Max-effort editors still take raw rung text.
design-run done: 7182ae4 (worktree-agent-afca58d9f71a4d39e)
Owner saw the merged design pass live and handed over: "from here on, drive it yourself". Head a9ff356 (design pass + setup probe deadline + background discovery).
Dispatched on a9ff356: prompt-view (structured brief view in the Prompt tab, owner request), task15-live, task17-docs. Then: T16 e2e, root gate, final Opus review, PR, Codex round, merge, install @next.
Noticed: test runs leave catherd-home-* run dirs under ~/.local/share/catherd/locks/tmp/slot-0 (leak, check after the root suite).
Root suite on 625a1fe (+a9ff356 setup change): 2340 pass, 0 fail. The locks/tmp/slot-0 dirs were the live lock slot of that suite and are cleaned on exit — not a leak.
T17 done: 906bfea cherry-picked. Its format:check concern on CLAUDE.md/MIGRATION.md does not reproduce on panel-v2 (root format:check green).
T15 done: 78dcbcb cherry-picked (patches applied, transcript socket watch; getRun still refetched per frame, single-flight).
prompt-view done: 6bfe7d8 cherry-picked; web gate 272 pass, build ok; checked in browser (worker prompt, nested plan-task cards).
T16 done: fffa991 cherry-picked (4 e2e flows, rung writer removed). Controller fix a6a3b9c: planning run no longer requests plan.md (test added); CATHERD_E2E_PORT documented.
Gates on a6a3b9c: root typecheck/lint/format green; web 273 pass; e2e 12/12. Root suite running. Final review dispatched (opus) on 2d6c5eb..a6a3b9c.
Final review: no Critical, 4 Important (socket backlog, preview repair save, pause vs land, paused timings). Ruling: paused runs also hold land/pushBranch/integrate — the owner presses Pause to look before landing — cost if wrong: a paused run waits to land until resume. Ruling: recharts kept (owner-approved design pass), spec/plan line amended.
Fix wave done: 8 commits cherry-picked, head a4edbae. Fix touched 35 files → scoped re-review (opus) dispatched on a6a3b9c..a4edbae; root suite running.
Re-review of fix wave: I1, I3, I4, M1, M6, M7 and the docs verified. One Important (the preview hid the reason a refused repair wasn't saved) and 3 Minor items fixed by the controller (filtered timeline replays from the older seq, two doc comments moved back to their functions, stale pause wording). The out-of-scope items (pause doesn't hold claimTree/route; runDoc drops cut; summary/scorecard count paused time) went to ideas.md, and the README now says routing continues while paused.
