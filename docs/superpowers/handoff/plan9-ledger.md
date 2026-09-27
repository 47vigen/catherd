# Plan 9 ledger (run findings)

- Base: main 38a930d. Audit verdicts in plan. Worker A: Task 1. Worker B: Tasks 2-5.
- Worker B (Tasks 2-5) DONE: 94317e9 e7dbd4c 1abcead 3b70ca0 cherry-picked; gate 1128/0. Deviations: defaultDifficulty = hardest the default rung clears; single jev-kind source. Concerns: manual-tests neighbouring Task 1 lines; fake-codex heredoc untried live; red-flag 'one message' row left for Task 1.
- Worker A (Task 1) DONE: 9f3513d 212420f cherry-picked (manual-tests conflict resolved: A's step 6 + B's step 7). Combined gate 1137/10/0 (with GIT_CONFIG_GLOBAL=/dev/null: env signing helper hangs temp-repo commits). Deviation: collect file for deliver-once.
- Review (whole branch): I-1 running drops finished-uncollected; I-2 late finalize → wrong diffs; I-3 records lost on throw/abort; M-1..M-5. Fix wave sent to worker A.
- Fix round 1 (worker A): edaf446 8e8d133; gate 1148/10/0. Codex r1 P2 (targeted wait running:[]) fixed in 8e8d133. Re-review sent.
- Re-review: I-1..I-3, M-1..M-5, Codex P2 all ADDRESSED. New minors N-1 abort during final refresh, N-2 cancel/wait double return hint, N-3 stand-in reuse lookup by id + test, N-4 typo. Batch with Codex r2.
- Fix round 2: 9f24d7c 3257d67 (Codex r2 claim window + N-1..N-4); gate 1156/10/0. Re-review 2 sent; Codex r3 next.
- Re-review 2: all ADDRESSED, nothing blocking. Optional: tryClaim leaves empty claim if writeSync fails (bounded 30s).
- CI red on 3257d67 (macos 1.4.0): all:true order test raced (both finished before one poll → dispatch order). Fixed 770d1bc: wait sorts records by endedAt; deterministic RED/GREEN test. 928fee1: tryClaim drops unwritable claim (re-review optional). Gate 1158/10/0.
- Lease fix ef8b528 (Codex r3); gate 1163/10/0. OWNER RULING: PR #14 is exempt from the 4-round Codex cap — continue Codex rounds until clean.
- Re-review 3 (ef8b528): nothing blocking; order + claim + lease P2 closed. Minors: M-1 dead-lease takeover loses record w/ 3 processes (fix: takeover → mark → normal path); M-2 relink live lease → double delivery (multi-server); M-3 temp clutter; M-4 no hard-link fallback; M-5 reused stand-in never launched. Batch with Codex r4.
- Codex r4 (ef8b528): 3×P2 — dead-lease takeover race (=M-1), not-launched stand-in reused (=M-5), claim stale window < settle+git timeout. Fix round 4 sent (with M-2..M-4). CI green on ef8b528.
- Fix round 4: 2c7aff9 (serialized dead-lease revive → mark; unlaunched stand-in started; claim window settle+git+margin; wx fallback; temp sweep). Gate 1171/10/0.
- Re-review 4 (2c7aff9): all ADDRESSED; Important macOS endCollect exact start-time compare → fixed 5-line: selfIdentity() cached + pid-only own-lease check (tests RED/GREEN). Gate 1174/10/0.
- Codex r5 (2c7aff9): 2×P2 — stale-claim takeover not serialized (double compute); pre-launch mark treated as launched. Fix round 5 sent. CI green on 2c7aff9.
- Codex r6 (d5785e5, requested without waiting for CI per owner): P2 persist collect intent at admission → added to fix round 5. CI green on d5785e5. OWNER: call Codex right after each push, don't wait for CI.
- Fix round 5: 1fe80de 4717544 (serialized stale-claim takeover; launch evidence = launch/proc/exit json; collect mark written at admission; failed launch keeps mark → lost record later). Gate 1178/10/0.
- Codex r7 (4717544): clean ('Didn't find any major issues'). CI green. All threads resolved. Final re-review requested before merge.
