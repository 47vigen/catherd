# SDD ledger — plan: docs/plans/2026-10-02-23-verifier-gate.md
Conflict read (controller): overlaps with 21/22 handed to replay worker (admission env + composed brief, role-prompts, supervisor/supervise-command, finalize, protocol, doctor-command, SKILL, live-verification numbering, gate-service.test).
Replay: p23-replay 19fb4cb..451b369 on 7cc83b0 (pre-fix plan 22). Gate 2133/19/0.
- Ruling: gate env values precede role keys in the spec env so they can never override CATHERD_ROLE/TMPDIR/dispatch ids — role scope wins — cost: none.
- Ruling: role server and role CLI `gate_check` also list the bound run's recorded items (shared gateCheckOrList) — a verifier needs its own run's items; run is bound by z.literal so nothing leaks — cost: none.
- Ruling: plan 23's live-verification section is §17 (21 = §15, 22 = §16); plan text left saying §15 — cost: cosmetic.
Final review: 1 C / 3 I / 5 M (final-review.md). Ruling: Minors 1 and 5 (gate env overriding adapter isolation homes; from naming SECRET_ENV) fold into I4's reserved-name fix — same list, same function — cost: none. Fix wave on 451b369.
Fix wave 42147f5..bfcdcb9 on 451b369 (C1 lockAt running max; I2 retries reset when hook null; I3 dirty lockfiles in every item's hash; I4 reserved gate-env names + secret `from` refused + spec env wins; M2–M4 → ideas). Worker gate 2137/19/0. Rulings 2, 7, 10, 25 in plan text updated.
- Ruling: gate values now also precede the adapter's plan.env (worker deviation) — an isolated home must never be overridden by gate env — cost: a gate value for a toolchain cache var loses to an isolated cursor/agy verifier's own cache value.
Scoped re-review: C1, I2, I3, I4 ADDRESSED, no new breakage. Re-review minors to add to ideas.md when rebasing: (a) I2 reset also fires on hook timeout (bounded(...,null)) — a slow providerRetry hook hides a stream-counted outage until idle timeout; (b) RESERVED gate-env list is hand-kept, not derived from adapters (misses GH_CONFIG_DIR, GIT_CONFIG_GLOBAL, XDG_CACHE_HOME, BUN_INSTALL_CACHE_DIR; ordering still protects them); (c) stray JSDoc in supervise-command.ts:122-126 (runSupervise's doc sits above superviseEnv's).
Rebased onto main e8b7cf9 (one conflict: ideas.md, both sides kept + re-review minors added). Plan 22 ledger commit da8898b.
Gate on da8898b: 2144/19/1 — the 1 fail is dispatches-state.test.ts `git commit` status 128 in tempRepo under parallel load (other agents' gates); file reruns 9/9 alone. Ruling: known load flake per CLAUDE.md (rerun only that file) — cost: if real, CI catches it.
PR #48 opened ready, subscribed.
Codex round (da8898b): P1 stale recorded passes in listing (4168313483); P2 compound pnpm filter skipped (4168313493); P2 empty proxies warns (4168313506). Fixer on da8898b.
Codex fixes for PR 48: f499f59 605a298 310dfa7  (worker gate 2148/19/0). Deviation: protocolNext's failedItems stays history-based (sync); verifier listing/brief are correct → ideas at plan 27.
CI red on f499f59 (ubuntu Bun latest): supervisor.test.ts 'counts the wall from a live catherd lock's last output' ended at 295 ms (<600). Timing-based plan-23 test, passed on prior run. Fixer dispatched to root-cause and make deterministic.
CI fix: root cause = test's same-loop sync fsync in reporter ticks blocks supervisor poll under load; supervisor gets injectable clock, tests deterministic (99bdcad). Pushed.
MERGED #48 as 8880bb8 (squash).
