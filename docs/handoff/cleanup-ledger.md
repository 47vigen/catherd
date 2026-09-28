# SDD ledger — cleanup before 1.0 (owner request 2026-09-27: full audit, remove dead code, principled cleanup, organize docs + locations, update 0.x md, make 1.0 ready)
Base: main d87a791. One PR, merged before the 1.0.0 release PR. Codex rounds cap 4.
Audits dispatched (read-only): dead code, docs, readiness.
Ruling: no move of docs/plans/2026-09-26-08-cursor-grok.md until the plan-8 re-check lands (it is being edited) — cost: none.
Docs audit done (audit-docs.md): layout proposed (root + CONTRIBUTING/SECURITY/CoC; docs/dev/; docs/archive/0.x/; tui-frames.md stays). False claims: skill 2, manual-tests 5, dependencies 5, ideas 8, research broken paths. Risk: main plugin skill 1.0 vs .mcp.json 0.2.1 until release PR merges; marketplace no ref.
Release PR opened: 47vigen/catherd#11 'chore: release catherd' (catherd-cli@1.0.0), head 321c8f2. HELD for owner's live verification; cleanup PR merges first (release PR will refresh itself).
Dead-code audit done (audit-dead-code.md): 4 dead, 13 test-only, 8 unused params, 5 unreachable, 3 0.x leftovers, 75 needless exports, 13 duplicates, 4 unread catalog fields, 3 undocumented CLI surfaces.
Ruling: keep cursor/grok reservations in ID lists/profile schema (plan 8 builds on them; profiles stay forward-compatible) — cost: dead-looking code until 1.1.
Ruling: keep hidden `_supervise` subcommand only if spec §3.1/tests need it; otherwise route tests through supervise-bin — worker decides against spec.
Ruling: staleAgents / relink / legacy status: implement if the spec requires the behaviour (doctor stale opencode agents; legacy models deprioritized), else delete — spec is authority.
Readiness audit done (audit-readiness.md): 1 blocker (B1 bare-key credentials.json leaks key via JSON parse error), 8 should-fix, 15 nice-to-have.
Plan: wave 1 A (security: B1, S1 one secrets module, S2 modes) ∥ D (docs layout, false claims, CONTRIBUTING/SECURITY/CoC, package.json metadata); wave 2 B (CLI UX: S3–S6, nice-to-haves CLI); wave 3 C (dead code, duplicates, S7 splits, code nice-to-haves); then final review, PR, Codex (cap 4), merge before release PR #11.
Ruling: S3 (codex-less new user "not ready") — doctor's fix offers both installing codex and moving roles to an installed backend (`/catherd-setup` or `catherd profile set`); the default profile stays codex-first (spec) — cost: first-run friction for codex-less users, now explained.
Wave 1 dispatched: A, D (worktrees, reset d87a791).
Batch D done: 9 commits cherry-picked; plus controller dbec4a9 (plan 8 + HANDOFF doc paths). Notes: SECURITY.md file-mode table must be updated after batch A; plan 8's README '## Backends' section will need a re-anchor when plan 8 runs; OWNER action: enable GitHub private vulnerability reporting (SECURITY.md relies on it).
Batch A done: 3 commits cherry-picked (496ef18 B1 no parse-error quoting, ccc302a one secrets module, 20d3888 0700/0600) + bc3f9a4 SECURITY.md modes. Gate 1057 pass. Wave 2 B (CLI UX) dispatched (reset bc3f9a4).
Batch B done: 12 commits cherry-picked (20d63e3..807a060) → 1a8edeee00b54d1f0d6db938bdeee52b532fc09c; gate 1077 pass. Deviation: bare catherd refuses non-dashboard flags (catherd --plain --version errors; --version alone works).
Wave 3 C (dead code/dupes/splits) dispatched (reset 1a8edee).
Batch C done: 9 commits cherry-picked → a6f25a0. Splits: doctor → doctor-checks/doctor-backends; profile-service → profile-store/agent-links; profile-tree → profile-edits; entry *-command.ts renames. Kept _supervise, readOutcomes, reserved plan-8 fields. Deviation: nonBlankLines returns [] on any read error (summary used to throw on EACCES).
Ruling: plan 8 needs a fresh anchor re-check before execution (doctor/profile-service splits, capture-fixtures rename) — note added to ledger; owner said no plan-8 execution now — cost: one re-check later.
Draft PR #12 opened + subscribed; check-in trig_01R61BGVgJ9K676GZceQoZ2S. Final whole-branch review dispatched (d87a791..a6f25a0).
Final review (final-review.md): ready after SECURITY redaction wording → fixed 1d6df4f (+CONTRIBUTING, changeset modes). HANDOFF updated a655cb6; ledgers copied. PR #12 ready; Codex round 1 requested.
Codex r1 on #12 (a655cb6): P2 doctor fallback not executable; P2 lock/git pass TYPESAFE_API_KEY (SECURITY promise); P3 --no-plain refused. Ruling: scrub secrets from lock-run commands and git subprocesses (promise holds as written). Fix worker dispatched.
Codex r1 fixed: 3 commits (doctor runnable per-role commands; scrub secrets in lock/git/ps; negated booleans).
Codex r2 (0a0d079): P2 doctor handshake MCP spawn raw env → fixed 82bcd12; audited all spawns (preflight allowlist, capture/workerEnv, launch scrubbed, supervisor spec.env from workerEnv, cli.ts scrubSecrets).
Codex r3 (82bcd12): P2 migration left a non-target default → fixed 0695fc2 with shell-run test. Next is round 4 (cap).
- Codex r4 (0695fc2, cap reached): 2×P2 upgrade modes (nested dirs, existing append targets) → fixed 1457de6 with test; threads resolved. No further Codex rounds; merge on green CI.
