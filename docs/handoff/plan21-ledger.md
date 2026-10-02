# SDD ledger — plan: docs/plans/2026-10-02-21-roles-ownership.md
Conflict read (controller): base of plan = main 6f2f8c7 = current main. Parallelism table: shared files (admission.ts 1,4,7,9; dispatches.ts 1,3,9; SKILL.md 2,4,7,9; role-prompts.ts 2,6; role-tools.ts 6,7; README 5,8) each owned by one task at a time per wave; every task's own tests built and green on scratch (2039/19/0). No contradictions with spec bullets (coverage table complete). Cross-plan: notifier/supervisor/summary/SKILL also touched by plan 22 — plan 22 adapts.
- Ruling: execute by cherry-picking the pre-validated scratch commits 1b96649..8d17046 (one per task) instead of re-dispatching workers — base unchanged, so a replay would reproduce the same commits; precedent plans 14/15 — cost if wrong: none beyond what the final review catches.
- Ruling: accept writer Ruling 9 (isolated Claude with role server drops --safe-mode for --strict-mcp-config --setting-sources "" + CLAUDE_CODE_DISABLE_CLAUDE_MDS) — spec names exactly this fallback; Claude 2.1.287 source shows safe mode drops --mcp-config servers — cost: user agents/output styles load in isolated headless roles; live §15.3.
- Ruling: accept writer Ruling 2 (scratch TMPDIR marks a role for Codex MCP servers) — CATHERD_ROLE does not reach a Codex plugin server's env — cost: live §15.1.
Final review: 0 C / 3 I / 4 Minor (final-review.md). Fix wave dispatched (opus-medium) on 9f806f7 for I1–I3; minors 4–7 → ideas.md '1.5 follow-ups'.
Gate on 9f806f7: 2039/19/0 green.
Fix wave: 5501d77..1404b6c (I1 carried settings + auto-memory off; I2 scratch only for isolated opencode, plan Ruling 22; I3 full server binds run-writing tools, refuses record_agent_run). Worker gate 2042/19/0. Scoped re-review: all 3 ADDRESSED, no new breakage.
PR #46 opened ready, subscribed; hourly check-in trig_01CVSE1z9CbAVqnmGPXDe82D.
Codex round (1404b6c): P1 native record_agent_run not disallowed (4167789713); P2 scratch clean race (4167789720); P2 isolated claude reads project sandbox (4167789725). Fixer dispatched on 1404b6c.
Codex fixes 061795e..9030b91 pushed (worker gate 2045/19/0); threads replied+resolved. Waiting CI then merge.
MERGED #46 as 9c02598 (squash). Ledger copy to docs/handoff/plan21-ledger.md rides the plan 22 PR.
