# plan 44 — docs/plans/2026-10-26-44-decision-model-and-briefs.md

Branch decision-model, base 54a1184. Gate on base: green (2828 pass).
Workers: Sonnet 5.5 high subagents in worktrees (owner, 2026-10-26). Coordinator reviews and verifies.

- M1.L2 task 2: 2a5d826 → 29da966. Reviewed: plan-doc owners, restatedALine (8 folded words, untagged numbered positionally), write refusal. DESIGN accepted: returns the lane line.
- M1.L1 task 1: 1d420f3 → cherry-picked. Reviewed composeBrief, admission composed path, failover stand-in (fresh thread composed; resumed gets 1.x-wrapped pointer — fine).
  Ruling: L4 must carry into the composed brief what admission's 1.x path still adds — the repo's standing rules (rulesBlock, part 3) and a verifier's gate notes (verifierBrief) — why: the composed path writes verbatim and dropped both — cost if wrong: roles lose knowledge rules, verifier loses recorded gate items.
  Ruling: the architect's Chore paragraph is dropped in L4 (D32), as the plan assigns.
- M1.L3 task 3: b79fb55 → 2cba556. Reviewed unitContext/roleALines/sectionOf; tasks never cut, cited sections cut first. EXTRA run-effects.test DEEP fixture tagged [run].
- M1.L4 task 4: c9bfbd0 cherry-picked. M1 gate green: 2853 pass 0 fail. A1 no mcp__/<team> in src briefs; A5 web untouched; A7 no private paths in diff.
- M2.L1 task 5: c6aa377 → b9cecf8. Note: harness.ts imports findingKey from run-state.ts; L4 importing harness from run-state forms a call-time-only cycle — L4 should move findingKey or keep usage lazy.
- M2.L2 task 6: 217252e cherry-picked. codex `-c tool_output_token_limit=8000` confirmed in codex binary.
  Ruling: keep BASH_MAX_OUTPUT_LENGTH=30000 for claude-code — the installed CLI documents 30000 as its default and a newer `bashOutputMaxChars` setting, so this is a no-op pin, not a clamp — cost if wrong: claude roles keep today's output size; a real clamp via --settings bashOutputMaxChars goes to ideas.md.
- M2.L3 task 7: 39af781 → 277721d. Bug fixed in verdict(): question id from set, not set name.
- M2.L4 task 8: e07a778 → 2554e44. findingKey moved to harness.ts (re-exported). Every reasoned stop now waits for classify: L5 must make classify run for every lane stop.
- M2.L4 amend delta (protocol.test) → 237c469. Fixed myself: BASH_MAX_OUTPUT_LENGTH reserved in gate-env → 2745cf3. gate-env 'reserves every env name' times out at 5 s when run alone, also on the M1 head — load-timing, passed in the M1 full gate; watch it in the M2 gate.
- M2.L5 task 9: 466a95f → 27ae2bf (dup protocol.test resolved ours). M2 gate green: 2874 pass 0 fail. gate-env flake did not recur in the full run.
- M3.L2 task 11: e72dc27 → 48026c7. Client takes url; key optional; per-attempt 10 s ok (probe max 2.4 s).
- M3.L1 task 10: abd53f0 → 683035e. Reviewed level texts (6 per family) and pickLevel (sure → cumulative from top → strongest; floor beats cap).
- M3.L3 task 12: 8a661d7 → ffe75c8. M3.L4 task 13: 7d350c6 → 05bef3e. M3 gate green: root 2902 pass 0 fail, web 325 pass.
- M4.L1 task 14: 0f1ee49 → 3bfa488. DESIGN accepted: floor applied before held/excluded drop (A2 safety). Note for L3: decide writes a second decisions.jsonl row (call decide) without n — L3 should pass name/n so the row is D28's.
- M4.L2 task 15: 0fbc7d0 → 0a5f2fc. Reviewed decided()/floorOf/failedOn: floor per name, strict at MAX_TRIES fails on one rung, cleared on accept. DESIGNs accepted: judge ids unit-kind-n (seq changed per event), surviving finding → strict floor, REDECIDE_LIMIT 6. Root typecheck red only in test/services/run-effects.test.ts until L3.
- M4.L3 Task 16 — cherry-picked 56063b6 (from 8b8a983). M4 full gate: root 2931 pass / 0 fail, web 325 pass.
- Ruling: a verdict failure (stop/failure-class) parks through the generic effect.failed path (reason `effect`), not `decision` — A5 only asks retried-then-parked, and the effect path already retries and parks for the coordinator — cost if wrong: the panel labels such a park "effect" rather than "decision".
- M5.L1, M5.L3 and M6.L1 dispatched at once from 56063b6. Ruling: M6.L1 runs beside M5 — its four files are disjoint from M5's — cost if wrong: a rebase of run-report.ts if M5.L1 had to touch it.
- M6.L1 Task 20 — cherry-picked 671ac57 (from 12d3031); reviewed: reuses parseRanLines, synthetic fixtures; full gate deferred to the M5 wave.
- M5.L3 Task 19 — cherry-picked 3147199 and a340d8a (from ec132bb, 2ea32ea); second commit drops the stale climb/bars live checks and points at decision.live.test.ts.
- M5.L1 Task 17 — cherry-picked 33cf308 (from e76be3a; 90 files, -5436/+1059). Remaining jev/typesafe in src: only migration, credentials move, env scrub and the doctor not-read line. panel-openapi.test fails until M5.L2 regenerates web/openapi.json (plan line 26 gives regeneration to the schema-changing lane; ruling: M5.L2 does it since web/ is its) — cost if wrong: none, one gate later.
- Ruling: the workspace sibling-spend → spentFraction test went with the objective it served — cost if wrong: a quota-sharing regression goes untested.
- M6.L2 Task 21 — cherry-picked 9b4b880 (from de457c6): ideas.md 'From plan 44' + major changeset; citations checked.
- M5 + M6 full gate on 3e6e138: root 2783 pass / 0 fail, web 329 pass. Docs scrubbed of personal hosts and project names (6cc4722) — owner's earlier question folded in: research stays, names generic.
- Ruling: branch history rewritten before first push (filter-branch tree scrub of the three docs commits; scrub commit pruned) — the repo is public and the PR keeps its commits forever — cost if wrong: none, never pushed. New head 4240e44.
- Final review (opus medium): 0 Critical, 4 Important (hadKey reads env key → gateway key sent to TypeSafe; all-held decide parks/exhausts instead of waiting; non-lane exhausted park never clears floor; private hosts in history — fixed by rewrite). Minors → ideas.md.
- Fix wave cherry-picked d2020dc (from 7bb7512): hadKey only saved creds; held answer → E_ALL_HELD wait; exhaustedParks clears non-lane floor on answer. Minors in ideas.md. PR #101 opened ready at d94277e (owner asked for speed to test next).
