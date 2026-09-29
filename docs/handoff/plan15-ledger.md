# Plan 15 — docs/plans/2026-09-29-15-groundwork-cursor.md (ledger)

- Executed by replaying the pre-validated scratch (`plan15-scratch`, 14 task commits built by the plan writer on a444e1b) onto main dfb3a17 (no src/test change since a444e1b): clean cherry-pick.
- Gate on the combined head (FORCE_COLOR unset): typecheck, lint, format:check clean; 1698 pass, 17 skip, 0 fail (1715 tests, 157 files).
- Ruling: execute from the writer's scratch instead of re-dispatching workers — the scratch is the plan's code, built test-first task by task (plan 14 precedent: "executed identical") — cost if wrong: the final review is the only independent read of the code.
- Codex round (PR #30), 2 P2, both fixed: resume compares the network grant too (e14b601, moved here from plan 16 Task 9 — groundwork); the isolated home's `chats` link is race-safe (2cdb496, `ensureLink`).
- Final review (opus): 0 Critical, 1 Important, 3 Minor. Important fixed in bf76318: `withHome()` and `test/preload.ts` drop an inherited `CATHERD_DATA_DIR`/`CATHERD_CONFIG_DIR` (an isolated worker running this suite would write into its catherd's real dirs), with a test. Minor 3 = the Codex race fix. Minors 2 and 4 → `docs/dev/ideas.md` "1.3 follow-ups".
- Ruling: no re-review of the fix wave — e14b601 is plan 16's pre-validated Task 9 code (Codex-reviewed as plan text in PR #29), the other two fixes are one function and a test helper, each with a test — cost if wrong: a defect in them reaches plan 16's review instead.
- Final gate: 1702 pass, 17 skip, 0 fail (1719 tests, 158 files); CI green on macOS and Linux.
- For plan 16's replay: skip f0f3cee (already here as e14b601).
