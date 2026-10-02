# SDD ledger — plan: docs/plans/2026-10-02-22-delivery-loop.md
Conflict read (controller): trial replay onto plan 21 head 1404b6c — tasks 1–2 clean, task 3 conflict in claude-code-dispatch.test.ts (briefFor). Overlap files with plan 21: dispatch-service, role-prompts, SKILL.md, dispatch-tools, server.ts, notifier, supervisor, summary, tool count. Rulings handed to the replay worker: end-push must respect plan 21's role-thread refusal; test_push is a coordinator tool.
Replay (one integration worker, autopilot ruling): branch p22-replay 0afb97a..7cc83b0 on 1404b6c. Gate 2086/19/0.
- Ruling: supervisor end-push refuses a role's thread (c278344), reusing plan 21's roleThreadOf — plan 21's P1 guarantee wins over plan 22 text that lacked the check — cost: none.
- Ruling: test_push joins COORDINATOR_TOOLS — it pushes to the owner thread, an orchestrator action — cost: a role cannot self-test push (none intended).
- Ruling: plan 22's live-verification section is §16 (plan 21 has §15); plan doc text left saying §15 with its renumber note — cost: cosmetic.
Final review: 0 C / 2 I / 6 M (final-review.md). Fix wave dispatched on 7cc83b0.
Fix wave 1b42124..ba1b620 (I1 stopLeftovers on dead supervisor without exit.json, Ruling 5 reworded; I2 adoptOwned on non-lead servers, Ruling 13 reworded; M1–M6 → ideas). Worker gate 2088/19/0.
Rebased onto main 9c02598 as 0f5f746..26e50f6 (+6105abc handoff). One conflict: SKILL.md coordinator-tools sentence — merged both (test_push + record_agent_run).
Gate on rebased head running; scoped re-review running.
Scoped re-review: I1, I2 ADDRESSED, no new breakage.
Gate on rebased 6105abc: 2091/19/0. PR #47 opened ready, subscribed; check-in trig_01AURFJwLqDG5yLyNTArjAp9.
Codex round (6105abc): P1 non-lead boot doesn't recover finished dispatches (4168066405); P1 invalidated watcher host bypasses limit ownership (4168066413). Fixer dispatched on 6105abc.
Codex P1 fixes 050033b, 2ba2f56 pushed (worker gate 2094/19/0); threads replied+resolved. Waiting CI then merge.
MERGED #47 as e8b7cf9 (squash).
