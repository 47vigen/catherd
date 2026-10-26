---
"catherd-cli": major
---

Part of 2.0.0. A decision model picks the rung of every dispatch and every judge, on the role's exact brief, in every round. It is any model behind a TypeSafe-compatible `/v1/systemone` endpoint: set `decision.url`, `decision.model` and `decision.minConfidence` on the profile, and put the key in `CATHERD_DECISION_KEY`. It is mandatory: a run refuses to start without it (`E_DECISION_UNSET`, `E_DECISION_PROBE`). A fix round never runs below the rung that failed. A call with no answer is retried, then parked for the coordinator.

Briefs have four parts: the role contract, the run facts, the unit context (capped near 20 KB) and this round. Findings are capped at 2 KB, a resumed fix round sends this round only, and each role sees only the A-lines it owns.

A verifier lists what it ran as `RAN: <cmd> — exit <n> — <log>` lines; a reply with none is a FAIL. A failure is classed `product` or `harness`, and one harness repair runs outside the round count. A test guard hashes the test files, so a worker cannot pass by editing them. Role runs get harness clamps (Claude Code `BASH_MAX_OUTPUT_LENGTH`, Codex `tool_output_token_limit`, an opencode scratch `TMPDIR`) and `HONCHO_ENABLED=false`. Every run report gains a per-role scorecard.

Removed: Jev, `bars`, `objective`, climbing, the learned start, the cheap try and the chore start. Old profiles migrate when they load: `typesafeApiKey` becomes `decisionKey`, and `TYPESAFE_API_KEY` is no longer read.
