# SDD ledger — plan: docs/plans/2026-09-28-12-failover-install-release.md
Preflight: preflight.md (4 small conflicts replaying onto plan 11's end state; 1394 pass there). Extra task: task-11-digest-brief.md.
Ruling: accept preflight R1–R11 (R1 replay order plan 11 then plan 12; R2 Task 5 keeps plan 10's scrubbed handshakeEnv — doctor's MCP server must not own the session's runs; R3 access:full/advisory stay separate after plan 11's access:<backend> rows; R4 info never affects ready nor counts as warning; R5 Task 9 §8 is a pointer to plan 11's §4 plus the network:false check; R6 MIGRATION names processes catherd starts no longer get CLAUDE_CODE_* session vars, plus digest and verifier steps; R7 README network:false example; R8 init test with test/bin shim prints no "installing"; R9 Task 11 digest added; R10 frames regenerated once by Task 11; R11 Sol high/xhigh no default stand-in, listed in the PR for the owner) — preflight evidence — per-ruling costs in preflight.md.
Ruling: execution order: worker A ports tasks 1–9 (+R2–R8) onto plan 11's head 3cea949; worker B does Task 11 (digest) then Task 10 (changeset, updated to name everything shipped incl. the digest) — the changeset stays last — none.
Ruling: plan 12 starts on plan 11's head while PR #16 is in Codex review; replayed onto main after #16 merges — saves hours — a small rebase.
Part A done: 3cea949..f593d8c (T1-T9 + R commits), 1406 pass x2, pack-smoke ok.
Task 1: complete (review clean)
Task 2: complete (review clean)
Task 3: complete (review clean)
Task 1-3: minor (deferred): 5 in review-batch1.md. Check in batch3: MIGRATION says 1.0-saved profiles get downgrade warnings for Sol high/xhigh → Kimi.
Task 4: complete (review clean)
Task 5: complete (review clean)
Task 6: complete (review clean)
Task 4-6: minor (deferred): 10 in review-batch2.md; carry to final fix wave: realGlobalInstall.install has no .catch (init must never stop); installedVersion reads stderr; globalStep claims plugin starts without bunx without checking PATH; launcher HOME unset / mkdir failure / stray CATHERD_USER_TMPDIR.
Batch3 (T7-9+R): spec issues in docs. Important: (1) MIGRATION/README upgrade step `catherd init` runs 1.0 init — use `bunx catherd-cli@latest init` or `bun add -g catherd-cli@latest && catherd init`; (2) live-verification §9.2 jq .durationMs → .secs; (3) events glob roles/*/*/events.jsonl; (4) routes count via jq unique lanes source==route; (5) §9 install of an unpublished release candidate.
Ruling: acceptance installs from the held release PR branch (bun pm pack + bun add -g ./catherd-cli-<v>.tgz; plugin via claude --plugin-dir <checkout>/plugin or a local marketplace add of the checkout) — no prerelease publish, which is outside the repo and the owner's call — cost: the owner runs two extra commands.
Task 7: complete (review clean). Task 8/9: fix round after part B lands (same docs files).
Part B done: f593d8c..9db1e80 (32a30bc digest view, e0fd32d network null, 9db1e80 changeset); gate 1416 pass (one unnamed intermittent fail in one of 5 runs).
Batch4 (T11+changeset): Important I1 runs-page milestoneDetail /^M\d+$/ rejects land-accepted ids; I2 unnamed intermittent failure. Both sent to fix round 1 worker plus cheap minors.
Fix round 1 done 9db1e80..21862d5 (items 1-11), 1428 pass x3. Deviation: acceptance plugin install via manual-tests ./plugin marketplace edit.
Ruling (owner, 2026-09-28 ~16:00): speed change for the rest of 1.1 — PR #16 merges on green CI with no more rounds, open P2s go to docs/dev/ideas.md "1.1 follow-ups"; plan 12: no per-batch reviews, parallel waves (opus-low for plan-held code), one gate per wave, ONE whole-branch review (opus-medium), fix only Critical/Important in one wave, re-review only if a fix touched >3 files, Minors to ideas.md, PR ready at once, ONE Codex round (fix P1 + correctness/security P2, other P2s replied "tracked in ideas.md" and resolved), merge on green, gate once per step (rerun only a known load-flake file); after plan 12 merges stop with the release PR held and post the acceptance commands as a PR comment; CLAUDE.md "Executing a plan" updated to this default in plan 12's PR — owner instruction — cost: late P2 edge cases ship as follow-ups.
Fix round 1 re-review: 11/11 addressed; new Important I1: §9 `bun add -g ./catherd-cli-$version.tgz` fails on Bun 1.4.2 (relative to global dir) → use "$PWD/…" (goes into the final fix wave). Minors → ideas.md.
Plan 12 replayed onto main 7035612 (clean), + 0556b69 (CLAUDE.md fast process, ideas.md 1.1 follow-ups); gate 1439 pass.
PR17 Codex round (only): P1 bunx transient shim makes init skip the global install → fix wave with re-review I1 ($PWD tgz path).
Fix wave: 1bad09c→cherry-picked (global bin detection), d0d892d ($PWD tgz, version re-read); final review Importants: I1 same as above, I2 init --no-input in §9, I3 handshake test withHome — controller commit b415c3b. Minors to ideas.md. No re-review (fix wave touched <=3 files per item).
