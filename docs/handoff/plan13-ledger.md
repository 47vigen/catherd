# SDD ledger — plan: docs/plans/2026-09-28-13-sources-sync.md

Session 6 (1.2 autopilot), controller started 2026-09-28 on main ee661e4.

- Setup: contracts copied to .superpowers/sdd/; gate on main ee661e4 green: 1443 pass, 10 skip, 0 fail
- Network: all seven keyless sources reachable from the sandbox (models.dev, OpenRouter models + endpoints, LiteLLM,
  Arena HF rows x6 configs, Vectara README, Epoch zip) — 200 on 2026-09-28. AA: 401 without a key.
- Ruling: every keyless fixture is recorded live with curl on 2026-09-28 and trimmed to the rows tests need — the
  sandbox reached them — cost if wrong: none (re-recordable by the same curl lines in test/fixtures/sources/README.md).
- Ruling: the AA fixtures (v2 data/llms/models and language/models/free) are built from the fields ideas.md documents,
  not recorded — the sandbox has no AA key (401) — cost if wrong: the parser misreads a real field name; listed in the
  PR for the owner to re-record with a key.
- Ruling: the spec's "2026-09-27 fixture data" stand-in test uses the 2026-09-28 captures — recorded one day later;
  Opus 5.5 still has no repo_code or terminal value in any keyless source (Arena agent has Opus 5.5 (High), Epoch
  terminalbench/frontiercode do not) — cost if wrong: none, the property the test pins is unchanged.
- Plan writer dispatched (opus-medium, worktree) with controller rulings R-A..R-H:
  - Ruling: R-A plan 13 adds agentic/steer/frontend to DIMS with no bars; plan 14 owns bars and everything routing —
    calibration/merge need the dims to exist, the owner's split puts bars in 14 — cost if wrong: one enum moves.
  - Ruling: R-B doctor's "stand-ins to confirm" goes to plan 14 — it depends on inferred stand-ins — cost: none.
  - Ruling: R-E fetch injected, background-sync boot test with a never-resolving fetch — spec §11 — cost: none.
  - Ruling: R-F Epoch zip read with a small central-directory reader over Bun.inflateSync, no new dependency —
    YAGNI — cost if wrong: a zip with data descriptors/zip64 misreads (fixture test catches).
  - Ruling: R-H OpenRouter endpoints fetched per catalog family, not per OR model — request budget — cost: none.
- Plan written: 08a34ef → cherry-picked as c5ee773 on the branch (14 tasks, waves A{1},{2,4},{9} B{3},{5},{6},{7},{8}
  C{10} D{11} E{12},{13} F{14}); scratch plan13-scratch ee661e4..31d04e0, 1551 pass/0 fail/10 skip.
  Writer rulings 1–22 are in the plan's "Rulings on the spec".
- Plan 14 writer dispatched on plan13-scratch 31d04e0 (replayed onto main after plan 13 merges).
- Conflict read (controller): shared files sequenced by waves — catalog.ts 1→10, domain/sources.ts 2→10, cache.ts +
  its test 4→11, catalog-service 1→11, README 12→14; mcp tool-count test 25→26 only in 12; no task edits src/cli.ts;
  doctor.ts only 13; init stdin order (Ruling 15) only 14; 14 consumes 12's syncLines, 9's aaKey, 8's key test.
  Each task's tests match its code (pre-validated scratch 31d04e0). No conflicts found; nothing to rule.
- Ruling: execution batching A {1},{2,4},{9} → B {3,5},{6,7,8} → C {10,11} → D {12,13,14}, workers opus-low —
  the plan holds the code (transcription grade) and suggests this batching — cost if wrong: a longer serial wave D.
- Wave A dispatched on c5ee773: {1}, {2,4}, {9} (opus-low, worktrees).
Task 1: complete (e696aa0 → 0897710; worker gate 1451 pass)
Task 2, 4: complete (ee31818, 32680d3 cherry-picked; worker gate 1464 pass)
Task 9: complete (69e9965 cherry-picked; worker gate 0 fail)
- Wave B dispatched on b705a66: {3,5}, {6,7,8} (opus-low; fixtures from git show 31d04e0).
- Wave A gate on b705a66: green, 1478 pass, 10 skip, 0 fail.
Task 3, 5: complete (f429cbc, 06297fd; files identical to scratch 31d04e0; worker gate 1489 pass)
Task 6, 7, 8: complete (bc40a4f, 08a59e2, 787c66b; byte-identical to briefs/scratch; worker gate 1499 pass)
- Wave C dispatched on 58c26f7: {10,11}.
- Wave B gate on 58c26f7:  1510 pass  0 fail 
Task 10, 11: complete (c01bab5, 37be769; from scratch 31d04e0; worker gate 1535 pass 0 fail)
- Wave D dispatched on 57f25ce: {12,13,14}.
Task 12, 13, 14: complete (80e6f84, c3ee16a, 1db9515; diff vs scratch 31d04e0 empty; worker gate 1551 pass)
- PR https://github.com/47vigen/catherd/pull/22 opened ready; subscribed; hourly check-in trig_01JN6FHtDruWeS5wkRpnR1RM (delete after merge). Final review dispatched (opus-medium) on ee661e4..5209310.
- Codex round 1 (5209310): 2 P2 correctness — (c1 4126039228) freshness only checks the cache path exists, a corrupt
  cache file is never refetched within TTL (source-sync.ts:155); (c2 4126039234) an unreadable derived.json is not
  rebuilt while sources are fresh (source-sync.ts:230). Both go into the final-review fix wave, RED test first.
- Full gate + pack-smoke on 5209310:  1551 pass  0 fail  EXIT 0
- Final review (opus-medium) on 5209310: 0 Critical, 4 Important, 9 Minor. Verdict: fix I1–I4.
  - I1 adjacent overwrites shipped exact-rung values (sol#low 37.2 → 70.35 with an AA key).
  - I2 plan Ruling 18's premise wrong: Epoch measured (rank 1) beats shipped secondary TB 4.0 → mixed terminal units.
  - I3 corrupt cache file counted fresh; unreadable derived.json not rebuilt (= Codex P2 c1, c2).
  - I4 applyFacts replaces capabilities wholesale; a sync can remove a shipped capability (floor broken).
  - Ruling: I1 fix — adjacent() skips any rung×dim a shipped non-inferred value or a direct synced value covers —
    plan Ruling 7's own intent; spec §4.3 "adjacent" is "the same model at another effort", a fallback — cost if
    wrong: fewer adjacent values (routing falls back to treat-like/inferred as in 1.1).
  - Ruling: I2 fix — derive does not emit Epoch terminal values as synced scores in 1.2 plan 13 (the fit is still
    recorded in calibration.json); plan 14 moves terminal onto one unit when it regenerates shipped values; Ruling 18
    corrected: "shipped terminal values stay authoritative until plan 14" — mixing TB 4.0 and Epoch TB 2.0 on the
    ladder is worse than no Epoch terminal value — cost if wrong: Haiku 4.5 terminal stays as shipped until plan 14.
  - Ruling: I3 fix — freshness requires readCached(id) !== null; rebuild derived when readDerived() === null —
    Codex + reviewer agree — cost: none.
  - Ruling: I4 fix — capabilities OR the shipped ones (a sync adds, never removes) — spec §3.5 "shipped models.json
    stays the floor" — cost if wrong: a capability a vendor truly removed stays until models.json is edited.
  - Minors 1–9 → docs/dev/ideas.md "1.2 follow-ups" (CLAUDE.md: only Critical/Important in code).
- Minors 1–9 written to docs/dev/ideas.md '1.2 follow-ups' (913924a). Fix wave dispatched (opus-medium) on 5209310; plan-14 writer told of the 4 fixes.
- Fix wave: 531375d (I1), d0d6d4d (I2), 9551429 (I3 = Codex c1, c2), 447e8ef (I4), each RED→GREEN; worker gate 1557 pass.
  - Ruling: I2 held terminal entirely (AA terminalbench calibrated onto Epoch too) — AA values calibrated onto the
    Epoch anchor are still in the 2.0 unit — cost if wrong: no synced terminal value at all until plan 14.
  - Ruling: no re-review of the fix wave — it touched 3 source files (CLAUDE.md: re-review above ~3) — cost: a fix
    regression reaches the Codex round/CI instead.
