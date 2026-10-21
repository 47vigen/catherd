# catherd 2.0, plan 30b: unattended — reasons, recovery, failover, gate evidence and landing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the daemon of plan 30 survives a night alone. Every blocked reply names one of six reasons and the machine maps each to a transition (climb, retry then fail over, park, wait); Jev classifies a stop that names none, and with Jev off it is handled as in 1.5; a lane check that fails only in a sibling's files counts as done; a limit fails over to any backend the user has configured, never a step down, Claude last; a landing rests on catherd's own check of the commit it lands (the verifier's `HEAD:`, a detached `gate_run`, failures the base already has let through, one rerun for new lines, a gitleaks scan, heavy slots that wait out an overloaded host); and in a run with a base branch, "landed" means origin's base contains it, a base that moved is integrated first, and dependants wait for the merge.

**Architecture:** No new event or action type: this plan fills plan 30's slots. Domain: the reason parser, the prompt line and the sibling matcher (`src/domain/blocked.ts`), the `HEAD:` parser (`src/domain/record.ts`), failing lines (`src/domain/fail-lines.ts`), and new bodies for the machine's `onLaneStopped`, `onVerifier` and land reactions plus the base-run rules (`src/domain/run-machine.ts`). Infra: the load wait and per-slot temp dir (`heavy-lock.ts`), `fetchBase`/`isAncestor`/`currentBranch` (`git.ts`), the check worker's launcher (`launch.ts`). Services: the milestone check (`milestone-check.ts`, `check-bin.ts`), the land gate's HEAD and machine rules (`lane-service.ts`), the `classify`, `checkMerged` and `integrate` effects and the widened `failoverRung`. Entry: `gate_run` on the role server and `catherd gate run`.

**Tech Stack:** Bun ≥ 1.4, TypeScript, zod 4, citty, `@modelcontextprotocol/sdk`, git ≥ 2.30; gitleaks optional. No new dependency.

**Spec:** `docs/specs/2026-10-12-catherd-2.0-design.md`, decisions 6, 8, 18, 19 and the landing rules of 21. Plan 30's file `docs/plans/2026-10-21-30-run-daemon.md` (its Design, Produces and Rulings bind this one). Inputs, re-shaped for the daemon: `docs/plans/drafts-1.6/2026-10-12-29-gate-evidence.md` (Tasks 1–8), `…-30-blocked-recovery.md` (Tasks 1, 4), `…-33-milestone-branches.md` (Task 2, D5, D6, D9, D11, Ruling 9). t3herd 71cbb6a: `src/state.ts:96-111`, `src/step.ts:88-95,389-505`, `src/check.ts:50-93,263-352`, `src/profile.ts:130-152`, `src/jev.ts:108-132`, `prompts/_no_questions.md`.

**Pre-validation: spiked the logged `sh -c 'exec > "$1" 2>&1; eval "$2"'` runner (exit code and merged output kept, as draft 29 did) and `merge-base --is-ancestor` against a local bare origin after a push from another clone (as draft 33 did), targeted tests only; the full gate runs at execution.** Written against `main` at 2061e6e; it executes after plan 30 merges, so every line number below is 1.5's and must be re-found by context.

## Global Constraints

- Everything in plan 30's Global Constraints, unchanged.
- **No new event or action type.** Every event and action this plan produces or consumes is in plan 30's Produces block; a task that seems to need a new one is wrong.
- **A run without `base` behaves as 1.5 on landing:** no fetch, no merge check, no integrate; `land`'s result has no new key. The base-run rules are tested by feeding `run.started{ base: "main" }` to the machine and, for effects, against a local bare origin (`git clone --bare`), never a URL.
- **No push, no MR, no merge by catherd.** catherd's git writes are local (`commit`, `merge` into the run's own branch); its only network git call is `git fetch -q origin <base>` (60 s cap); a failed fetch never fails a call, it works from the last fetch and says so.
- Jev off (`jev.use: "off"`) means no Jev call and 1.5's handling of a stop with no reason.
- Spec values, verbatim: "`needs_user | too_hard | provider_error | no_access | check_broken | out_of_scope`. The machine maps each reason to a transition: climb, retry then fail over, park, or wait. A stop with no reason is classified by Jev, and with Jev off it is handled as in 1.5." · "A limit fails over to any backend the user has configured, not only those the profile uses. It never steps down, and Claude rungs go last." · "a verdict must name the commit it lands. catherd runs the milestone check itself. Failures the base already has do not block, and a failure with new lines gets one rerun. A gitleaks scan runs, and heavy slots wait while the machine is overloaded." · "a lane check that fails only in a sibling's files counts as done. An answer re-runs the stopped unit. A finding survives only when a fix ran between reviews." · "base integration, "landed" meaning origin's base contains the branch … A run without `base` behaves as 1.5. Pushes and MRs still need the user's authorization. In a squash-merging repo, dependants are unblocked by hand."
- Numbers (draft 29): load threshold `2 × availableParallelism()`, load wait 15 min (`heavyLimits.loadWaitMs = 900_000`), poll 15 s; `checkLimits = { waitMs: 600_000, pollMs: 1_000, graceMs: 30_000 }`; `checkFailLines` keeps at most 60 lines of at most 300 characters; a fix brief carries the last 40 lines of the failing check's log. Jev's stop rule: `min: 0.8`, the last 4000 characters of the reply.

## Cross-plan interfaces

- **Consumes from plan 30** (its Produces block, exact names): `BLOCKED_REASONS`, `RunEvent`/`RunEventInput`, `RunState`, `LaneState` (`lastReason`, `sameReason`, `notes`), `MilestoneState` (`commit`, `verifierRuns`), `next` and its reactions `onLaneStopped`, `onLimit`, `onVerifier`, `actionKey`, `Effects`/`realEffects`, `endedEvent`, `briefFor`, `failoverRung`, `appendEvent`, `activeMilestones`, the `classify`, `checkMerged`, `integrate` actions (stubbed by 30 as `effect.failed`), the `stop.classified`, `milestone.merged`, `base.behind`, `integrate.done`, `integrate.conflict` events.
- **Consumes from plan 29:** the Slopalytics intelligence index. This plan reads it through one adapter, `indexedPairs(deps: Deps): { rung: string; intelligence: number }[]` in `src/services/failover-rungs.ts`, implemented on plan 29's Produces as `const c = loadCatalog({ repo }); return catalogPairs(c).map((rung) => ({ rung, intelligence: pairOf(c, rung)!.intelligence }))` (`loadCatalog`, `catalogPairs`, `pairOf` from `src/domain/catalog.ts` / `catalog-service.ts`; `catalogPairs` returns only indexed rungs, so `pairOf` is never null there). Ranking reuses plan 29's `rankStandIns(c, billing, rung, pool)` with `pool` = every configured backend's indexed rungs, Claude-billed last.
- **Produces for plan 32:** `parseReplyHead`, `RunRecord.head`, the verifier contract's `HEAD:` line and `BLOCKED_LINE` in every reply contract (32 keeps both when it rewrites the contracts and adds `EXTRA:`, `REJECTED:`).
- **Produces for plan 33:** `failoverRung` ranks on `indexedPairs`; 33 may replace the ranking, keeping the signature.
- **Produces for plan 35:** `checkBase(run)` in `milestone-check.ts` is the one place the base commit is chosen (`run.meta.startHead` here; 35 returns `merge-base origin/<base> HEAD` and the tree's own branch); `fetchBase`, `isAncestor`, `currentBranch` (`src/infra/git.ts`); `landedCommitOf` (`src/services/milestones.ts`); the base-run transitions and the `checkMerged`/`integrate` effects, which work on `run.meta.repo` until 35 gives each milestone its tree (`CheckJob.cwd`, the integrate cwd).

## Review Focus

1. **A blocked reply that names no reason, with Jev off.** Expected: no Jev call; `blocked`/`refused` climb (`climb{ "blocked" }`), `failed`/`timeout` keep plan 30's retry-then-climb; no judge call. Task 3: "handles a stop with no reason as 1.5 does when Jev is off".
2. **Every candidate of a limited rung is on a held quota, and the cheapest free one is a lower model.** Expected: no step down; the unit waits for the earliest hold, then runs on its own rung. Task 4: "never steps down, and waits when every candidate is held or lower".
3. **The verifier's PASS names a commit older than the one being landed** (a fix landed after it). Expected: a fresh verifier on the milestone's commit, no `land` call; `land()` still refuses such a PASS on its own. Tasks 3 and 7: "re-verifies a PASS whose HEAD is not the milestone's commit" and "refuses a PASS whose HEAD is not the commit being landed".
4. **The base is already red, and the suite flakes under load.** Expected: failures the base has land with an audit line; a new failure is rerun once and lands if the rerun passes, `rerunOf` in the record; an exit with no readable failing line blocks. Task 5: the `machineGate` tests.
5. **A base run whose base moved while the milestone was verified, and a squash-merged prerequisite.** Expected: `land` is not called; the base is merged into the run's branch (conflicts to `worker-<M>-integrate`), a fresh verifier gates the merge, then it lands; a dependant of a squash-merged milestone waits until the owner answers its push question. Task 8: "integrates a base that moved before landing" and "unblocks a dependant of a squash merge only by the owner's answer".

## Rulings

1. Ruling: reasons map to transitions, not hints (draft 30 Ruling 4 reversed): the daemon dispatches; `stops.ts` and its hint table are not built — spec decision 8 — none.
2. Ruling: `needs_user` goes to the judge first (`question`: answer from the plan and the code, or `ask_owner`, which parks the lane, reason `needs_user`); `no_access` and `out_of_scope` park at once — decision 3 lists "answer a worker's question", decision 5 parks what only the owner can answer — a judge answer that is wrong costs one more lane attempt.
3. Ruling: `too_hard` climbs (`climb{ "blocked" }`); at the top rung it parks (reason `too_hard`), not the judge — a stronger model was the only fix — none.
4. Ruling: `provider_error`, the first in a row: the same rung on a fresh thread; the second: fail over (`failoverFrom`), with no quota hold, since no limit was hit — draft 30 Ruling 5, t3herd `recover` — a provider down for an hour costs one retry per unit.
5. Ruling: `check_broken` on a lane: a non-empty `foreign` (its reply or its fast check names only sibling files) → the lane is `done`; else the lane is held while a sibling of its milestone is `running` or untried since its latest climb, then retried once on its rung, and a second `check_broken` in a row parks it — draft 30 Rulings 9–11, t3herd 50820ef, dc3dbcf — a sibling parked for a week leaves the broken lane retried once and parked.
6. Ruling: a verifier's first `check_broken` runs a fresh verifier once more; the second parks the milestone (reason `check_broken`); `VERDICT: BLOCKED: environment` keeps plan 30's park ahead of it — draft 30 Ruling 12 — none.
7. Ruling: "a stop with no reason" is `blocked`/`refused` with no parsable reason, or `ok` with no STATUS line, or `failed`/`timeout` with no `ENV:` line; the machine emits `classify`, the effect asks Jev (`RoutingPort.stopCause`, the `stop` set of `catalog/jev.json`, draft 30 Task 4 verbatim) and appends `stop.classified{ reason }`, `null` when Jev is off, unsure or says `other`; `null` → 1.5: `blocked`/`refused` climb, `failed`/`timeout` plan 30's retry-then-climb, `ok` with no STATUS goes on to the fast check — "with Jev off it is handled as in 1.5" — none.
8. Ruling: "an answer re-runs the stopped unit" needs no `brief-in.md` (draft 30 Ruling 14 dropped): the daemon rebuilds a brief from the run's files with `briefFor`, so the old brief plus the answer is the lane's `notes` gaining the answer, which plan 30 already does — none.
9. Ruling: "configured backends" are the backends of every rung in every saved profile (`profilesDir()`) plus every value of each profile's `failover` map — "not only those the profile uses"; a backend installed but in no profile is not used — the user adds it to any profile.
10. Ruling: `failoverRung` order: the profile's explicit stand-in when its quota is free and its index is not lower; then every indexed pair of a configured backend on another free quota with an index ≥ the rung's, non-Claude before Claude, nearest index first, a tie to the higher; a rung with no index fails over only to its explicit stand-in — t3herd `failoverRung` with the spec's "never steps down" and "Claude last" — a lane whose only free quota is a weaker model waits for the hold.
11. Ruling: gate evidence ports draft 29 as written (its Rulings 4, 6–17), except: no native verifier (`record_agent_run`'s `head` is not built; plan 30 retired it), the commit before the verifier is plan 30's, and the HEAD comes from this plan's `parseReplyHead` — none.
12. Ruling: the machine checks the HEAD rule before `land`: a PASS whose `head` is not a prefix of the milestone's `commit` dispatches a fresh verifier with "verify <commit12>" in its notes; `land()` keeps its own refusal as the last word — a land refusal costs a park in plan 30's rules — none.
13. Ruling: a `land.refused` re-verifies once (a fresh verifier, the refusal's message and fix in its notes) before it parks (reason `land`) — a verifier that skipped `gate_run` is the common cause — a refusal no verifier can fix costs one verifier run.
14. Ruling: in a base run, `land` first fetches the base; when `origin/<base>` is not an ancestor of the milestone's commit it appends `base.behind` and does not land; `integrate` runs `git merge --no-ff -m "Merge origin/<base> into <branch>" origin/<base>` in `run.meta.repo` → `integrate.done` (the merge commit becomes the milestone's, and a fresh verifier gates it), or, on conflicts, `integrate.conflict` with `git diff --name-only --diff-filter=U` → `worker-<M>-integrate` (brief `fix`, notes: the files and "resolve the conflicts keeping both sides' intent; do not commit"), then `commit` completes the merge — draft 33 D11 — reviews stay fresh across merges (counted by time, draft 33 Ruling 1).
15. Ruling: in a base run, a landed milestone parks with reason `push`: "M1 landed on <branch> at <commit12>: push it and open and merge its MR (precheck: git fetch -q origin <base> && git merge-base --is-ancestor origin/<base> HEAD); answer once it is merged" — "Pushes and MRs still need the user's authorization" — the owner pushes by hand until plan 35.
16. Ruling: "merged" is `isAncestor(landedCommitOf(run, M), "origin/<base>")` after `fetchBase`; the daemon checks it (`checkMerged`) when a milestone lands and every 10 minutes while a milestone waits on it (`wakeAt`); `milestone.merged` closes its `push` question; an owner's answer to a `push` question counts as merged, which is how a squash merge unblocks its dependants — draft 33 D6 and Ruling 9 — a squash-merging repo needs one answer per milestone.
17. Ruling: in a base run, a milestone's `after` milestones must be `merged`, not `landed`, before it starts — draft 33 D9 — none for a run without base.
18. Ruling: `checkBase(run)` is `run.meta.startHead` (the base for the baseline and the secret scan) until plan 35 — draft 29 Ruling 9 — a run scans from where it started.

No owner questions.

## Parallelism

| Wave | Tasks | Files |
| --- | --- | --- |
| 1 | 1 ∥ 5 | 1: `src/domain/{blocked,record,role-prompts}.ts`, `src/services/finalize.ts`, tests · 5: `src/infra/heavy-lock.ts`, `src/entry/lock-command.ts`, `src/services/preflight.ts`, `src/domain/fail-lines.ts`, `src/services/milestone-check.ts`, tests |
| 2 | 2 ∥ 4 ∥ 6 | 2: `catalog/jev.json`, `src/domain/jev.ts`, `src/services/{ports,routing-service,run-effects}.ts`, `test/services/helpers.ts` · 4: `src/services/failover-rungs.ts` · 6: `src/services/milestone-check.ts`, `src/infra/launch.ts`, `src/entry/{check-bin,role-cli-command}.ts`, `src/entry/mcp/role-server.ts`, `src/domain/{role-tools,brief,gate-brief}.ts`, `test/pack-smoke.ts` |
| 3 | 3 ∥ 7 | 3: `src/domain/run-machine.ts`, its test · 7: `src/services/{lane-service,milestones,run-briefs,run-report,run-effects}.ts`, `test/services/helpers.ts` (`passGate`), the land tests |
| 4 | 8 | `src/infra/git.ts`, `src/services/{milestones,run-effects}.ts`, `src/domain/run-machine.ts`, `test/helpers.ts` |
| 5 | 9 | skill, README, MIGRATION, ideas, `.changeset/unattended.md` |

Task 3 and Task 8 both edit `run-machine.ts`: 8 after 3. Task 2's and Task 8's `run-effects.ts` hunks touch different actions.

---

### Task 1: six reasons, the HEAD line, and every contract that names them

**Files:**
- Modify: `src/domain/blocked.ts` (plan 30's list), `src/domain/record.ts:44-111` (`RunRecordSchema.head`, `parseReplyHead`), `src/services/finalize.ts` (store `head` where it stores `replyStatus`), `src/domain/role-prompts.ts:165-181` (`STATUS_LINE`, the worker's STATUS sentence, the verifier's contract)
- Test: `test/domain/blocked.test.ts` (new), `test/domain/record.test.ts`, `test/services/dispatch-protocol.test.ts`

**Interfaces:**
- Produces (`blocked.ts`): `export type StopAction = "climb" | "failover" | "park" | "wait"`; `export const REASON_ACTION: Readonly<Record<BlockedReason, StopAction>>` (`too_hard` climb, `provider_error` failover, `check_broken` wait, the rest park); `export function parseBlockedReason(why: string | null): { reason: BlockedReason; why: string } | null`; `export const BLOCKED_LINE: string`; `export function foreignFailure(log: string, own: string[], siblings: string[]): string[]` — all as draft 30 Task 1 (Interfaces and the exact `BLOCKED_LINE` text, which ports t3herd `prompts/_no_questions.md`).
- Produces (`record.ts`): `RunRecordSchema.head: z.string().optional()` (lower-case 7–64 hex); `export function parseReplyHead(reply: string): string | null` — the last `HEAD: <hex>` line of the reply, outside code fences, lower-cased; the verifier contract gains, after its VERDICT sentence: "Then a line HEAD: <the full sha of the commit you checked> (git rev-parse HEAD)."

- [ ] **Step 1: Write the failing tests:** draft 30 Task 1 Step 1's five tests, verbatim, in `test/domain/blocked.test.ts`; its `dispatch-protocol.test.ts` change (every `replyContract(role)` contains `BLOCKED_LINE` after its `STATUS:` line), including `judge`; and in `test/domain/record.test.ts`:

```ts
it("reads the last HEAD: line outside code fences, lower-cased", () => {
  expect(parseReplyHead("VERDICT: PASS\nHEAD: 0123456789ABCDEF0123456789abcdef01234567\nSTATUS: complete — ok")).toBe("0123456789abcdef0123456789abcdef01234567");
  expect(parseReplyHead("```\nHEAD: deadbeef\n```\nSTATUS: complete — ok")).toBeNull();
  expect(parseReplyHead("HEAD: main")).toBeNull();
});
it("asks every verifier for the HEAD it checked", () => expect(replyContract("verifier")).toContain("HEAD: <the full sha"));
```

- [ ] **Step 2: Run** `bun test test/domain/blocked.test.ts test/domain/record.test.ts test/services/dispatch-protocol.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as draft 30 Task 1 Steps 3–4; finalize sets `head` from `parseReplyHead(reply)` when it is not null.
- [ ] **Step 4: Run** the Step 2 command and `bun test test/domain/agents.test.ts test/services/dispatch.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(roles): a blocked reply names one of six reasons, and a verdict names its commit"`

### Task 2: what a stop says, and Jev for one that says nothing

**Files:**
- Modify: `src/services/run-effects.ts` (`endedEvent`: `reason`, `head`, `foreign`; `fastCheck`: `foreign`; the `classify` effect), `catalog/jev.json`, `src/domain/jev.ts:37-54`, `src/services/ports.ts:134-152` (`RoutingPort.stopCause`), `src/services/routing-service.ts:249-306`, `test/services/helpers.ts:89-125` (`fakeDeps`' `stopCause`)
- Test: `test/services/run-effects.test.ts`, `test/domain/jev.test.ts:271`

**Interfaces:**
- Consumes: Task 1; `laneOwns` (`src/services/admission.ts:78`); `runProfile` (`src/services/run-pin.ts:69`).
- Produces: `endedEvent` fills `reason` (`parseBlockedReason(replyWhy)` for `blocked`/`refused`), `head` (`record.head ?? null`), and `foreign` (a lane record with reason `check_broken`: `foreignFailure(reply, own Owns, the Owns of its milestone's other lanes)`); `check.ran.foreign` is `foreignFailure(tail, own, siblings)` when the check failed. The `stop` set, `VERDICT_OPTIONS.stop` and `RoutingPort.stopCause(runDir, status, reply, use): Promise<Verdict<BlockedReason | "other">>` are draft 30 Task 4's, verbatim. The `classify` effect: `stopCause(run.dir, record.status, reply, runProfile(deps, run).jev.use)` → `stop.classified{ reason }` with `reason` null unless `source === "jev"` and the value is not `other`; a Jev error logs and appends `null`.

- [ ] **Step 1: Write the failing tests:**

```ts
it("puts the reply's reason and HEAD on dispatch.ended", …);   // "STATUS: blocked — too_hard: …" → reason too_hard; HEAD: line → head
it("names only sibling files as foreign, for a check_broken lane and for its failed fast check", …);
it("classifies a stop with no reason through Jev, once", …);   // stopCause → needs_user 0.91 jev → stop.classified{ reason: "needs_user" }; one call
it("classifies to null with Jev off, for other, or for an unsure answer", …);   // zero calls when off
```

  and draft 30 Task 4's `jev.test.ts` loop over `["finding", "same-defect", "stop"]`.
- [ ] **Step 2: Run** `bun test test/services/run-effects.test.ts test/domain/jev.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as above; the routing fake answers `{ value: "other", probability: null, confidence: null, source: "default" }`.
- [ ] **Step 4: Run** the Step 2 command and `bun test test/services/routing-service.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): a stop carries its reason, and jev names one for a stop that gives none"`

### Task 3: the machine recovers by reason

**Files:**
- Modify: `src/domain/run-machine.ts` (`onLaneStopped`, `onVerifier`, a `stop.classified` reaction, the land-refusal reaction, a held-lane rule in advance)
- Test: `test/domain/run-machine.test.ts`

**Interfaces:**
- Consumes: plan 30's machine; `REASON_ACTION`.
- Produces, as transitions (Rulings 2–7, 12, 13):

| Event | Actions |
| --- | --- |
| lane ended with `reason` (or `stop.classified` with one) | `too_hard` → `climb{ "blocked" }` (top → `park` `too_hard`) · `needs_user` → `judge{ question }` · `no_access`, `out_of_scope` → `park` lane (that reason) · `provider_error`: `sameReason` 1 → re-dispatch same rung, fresh thread; 2 → lane `pending` with `failoverFrom` · `check_broken`: `foreign` non-empty → lane `done`; else `sameReason` 1 → held, then retried; 2 → `park` lane `check_broken` |
| an unexplained stop (Ruling 7) | `classify{ dispatchId }` |
| `stop.classified{ reason: null }` | `blocked`/`refused` → `climb{ "blocked" }`; `failed`/`timeout` → plan 30's retry-then-climb; `ok` → `fastCheck` |
| `check.ran` with non-empty `foreign` | lane `done` |
| verifier ended `check_broken` | the first of the milestone's verifier ends in a row with that reason (`dispatches[…].ended.reason`) → fresh `verifier-<M>`; the second → `park M` (`check_broken`) |
| verifier `pass` with `head` not a prefix of `M.commit` | fresh `verifier-<M>`, notes `verify <commit12>` (no `land`) |
| `land.refused` | `landRefusals` 1 (reduce counts it): fresh `verifier-<M>` with the message and fix in its notes; 2: `park M` (`land`) |

  Held (advance): a `pending` lane whose `lastReason` is `check_broken` and `sameReason` is 1 is not dispatched while a sibling lane of its milestone is `running`, or `pending` with no dispatch since its latest climb.

- [ ] **Step 1: Write the failing tests:**

```ts
it("climbs a too_hard lane, and parks it at the top rung", …);
it("asks the judge about needs_user, and parks no_access and out_of_scope at once", …);
it("retries a provider_error once on its rung, then fails it over", …);
it("counts a lane whose check fails only in a sibling's files as done", …);
it("holds a check_broken lane while a sibling runs or is untried, retries it once, then parks it", …);
it("does not hold a check_broken lane for a sibling that tried and stopped", …);
it("reruns a verifier's first check_broken and parks the second; BLOCKED: environment still parks first", …);
it("asks Jev about a stop with no reason, and acts on the reason it names", …);
it("handles a stop with no reason as 1.5 does when Jev is off", () => {
  const f = feed([...laneRunning(), endedAs("worker-M1.L1", "ok", { replyStatus: "blocked", why: "the tests fail" })]);
  expect(f.last).toEqual([{ type: "classify", dispatchId: "d-1" }]);
  expect(feed([...f.events, classified("d-1", null)]).last).toContainEqual({ type: "climb", lane: "M1.L1", reason: "blocked" });
});
it("re-verifies a PASS whose HEAD is not the milestone's commit", …);
it("re-verifies once after a land refusal, then parks", …);
```

- [ ] **Step 2: Run** `bun test test/domain/run-machine.test.ts`. Expected: FAIL (the new tests; plan 30's still pass except its "asks the judge about a blocked reply" test, which this task rewrites to a `needs_user` reply).
- [ ] **Step 3: Implement** the reaction bodies and the held rule.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): each stop reason gets its transition, and jev or 1.5 handles the rest"`

### Task 4: failover to any configured backend, never down, Claude last

**Files:**
- Modify: `src/services/failover-rungs.ts`; Test: `test/services/failover-rungs.test.ts` (new)

**Interfaces:**
- Consumes: plan 29's index (through `indexedPairs`); `quotaOf`, `claudeBilled`; `profilesDir`, `readProfileDoc` (`src/services/profile-store.ts`); `standInFor`.
- Produces: `failoverRung(deps, run, role, rung, held)` per Rulings 9–10; `export function configuredBackends(): string[]`; `export function indexedPairs(deps: Deps): { rung: string; intelligence: number }[]`.

- [ ] **Step 1: Write the failing tests** (two saved profiles; `indexedPairs` fed by plan 29's catalog fixture):

```ts
it("prefers the profile's stand-in when its quota is free and it is not weaker", …);
it("reaches a backend only another profile uses", …);              // the run's profile has codex only; another has opencode
it("never steps down, and waits when every candidate is held or lower", () => {
  expect(failoverRung(deps, run, "worker", "codex:gpt-6-sol#high", ["codex"])).toBeNull();   // the only free pair is weaker
});
it("puts Claude rungs last, and picks the nearest index, a tie to the higher", …);
it("fails a rung with no index over only to its explicit stand-in", …);
```

- [ ] **Step 2: Run** `bun test test/services/failover-rungs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the Step 2 command and `bun test test/services/run-effects.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(failover): a limit moves to any configured backend, never down, claude last"`

### Task 5: heavy slots, failing lines and catherd's milestone check

**Files:**
- Modify: `src/infra/heavy-lock.ts:1-58`, `src/entry/lock-command.ts:141-142,197-201`, `src/services/preflight.ts:316-318`
- Create: `src/domain/fail-lines.ts`, `src/services/milestone-check.ts`
- Test: `test/infra/heavy-lock.test.ts`, `test/entry/lock-command.test.ts`, `test/domain/fail-lines.test.ts`, `test/services/milestone-check.test.ts`

**Interfaces:**
- Produces: draft 29 Task 1's `LOCK_HELD_ENV`, `heavyLimits`, `slotTmpDir`, the `(slot, tmp)` callback and `tmpBase`; Task 2's `checkFailLines`, `newFails`; Task 3's `CheckRecordSchema`, `CheckRecord`, `checksFile`, `checkLogDir`, `readChecks`, `appendCheckRecord`, `checkBase` (Ruling 18), `baselineFor`, `checkTools`, `secretScan`, `CheckJob`, `execMilestoneCheck`, `machineGate` — every signature as the draft states it.

- [ ] **Step 1: Write the failing tests:** draft 29 Task 1 Step 1 (four heavy-lock tests and the lock-command TMPDIR test), Task 2 Step 1 (four fail-lines tests) and Task 3 Step 1 (the runner, rerun, baseline, gitleaks and seven `machineGate` tests), verbatim.
- [ ] **Step 2: Run** `bun test test/infra/heavy-lock.test.ts test/entry/lock-command.test.ts test/domain/fail-lines.test.ts test/services/milestone-check.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as draft 29 Tasks 1–3, Step 3 each (t3herd `src/check.ts:50-68,263-352` for `failLines`, `execCheck`, `checkGate`).
- [ ] **Step 4: Run** the Step 2 command and `bun test test/services/preflight.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(gate): catherd runs the milestone check and judges it against the base"`

### Task 6: the check runs detached, and the verifier calls it as gate_run

**Files:**
- Modify: `src/services/milestone-check.ts`, `src/infra/launch.ts` (`CHECK_ENTRY`, `launchCheckWorker` through plan 30's `launchDetached`), `src/entry/mcp/role-server.ts:73-105` (`gate_run`, run-bound), `src/domain/role-tools.ts` (`roleMcpTools("verifier")` gains `"gate_run"`), `src/domain/brief.ts:19-35` (`cliForm("gate_run", run)`), `src/entry/role-cli-command.ts:112-115` (`catherd gate run`), `src/domain/gate-brief.ts:9-14` (`VERIFIER_GATE_RULES`, draft 29 Task 8's rule, verbatim), `test/pack-smoke.ts`, `test/infra/launch.test.ts`
- Create: `src/entry/check-bin.ts`
- Test: `test/services/milestone-check-run.test.ts`, `test/entry/role-mcp.test.ts`, `test/services/role-server-harness.test.ts`, `test/entry/role-cli-command.test.ts`, `test/domain/role-scope.test.ts`, `test/services/verifier-brief.test.ts`

**Interfaces:**
- Produces: draft 29 Task 4's `CHECK_ENTRY`, `launchCheckWorker`, `checkLimits`, `GateRunResult`, `runMilestoneCheck`, `checkWorker`; Task 5's `gate_run` (role server only: the session server has no gate tools after plan 30) and `catherd gate run`.

- [ ] **Step 1: Write the failing tests:** draft 29 Task 4 Step 1 (six tests), Task 5 Step 1 (the tool-list updates, minus the full server's list, and the worker-scope refusal), and Task 8's "tells every verifier to run the full check through gate_run on the committed HEAD", verbatim.
- [ ] **Step 2: Run** `bun test test/services/milestone-check-run.test.ts test/entry/role-mcp.test.ts test/services/role-server-harness.test.ts test/entry/role-cli-command.test.ts test/domain/role-scope.test.ts test/services/verifier-brief.test.ts test/infra/launch.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as draft 29 Tasks 4–5 and the Task 8 rule; `check-bin.ts` mirrors `daemon-bin.ts`.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(gate): the verifier runs the milestone check through gate_run, detached"`

### Task 7: land lands only the commit its evidence is about

**Files:**
- Modify: `src/services/milestones.ts:179-239` (`MilestoneVerifier.head` from the headless record), `src/services/lane-service.ts:342-436` (`gate()`: the HEAD rule and `machineGate`, returning the audit), `:511,565` (`landRun` adds it to `hints`), `src/services/run-report.ts` (`writeRunReport(run, s, events, audits: Record<string, string[]> = {})`), `src/services/run-effects.ts` (`finish` passes `audits[M] = (await machineGate(run, M, commit)).audit` per landed milestone), `src/services/run-briefs.ts` (a `fix` brief carries the failing check's log tail), `test/services/helpers.ts:317-346` (`passGate(run, m, at?, head?)`)
- Test: `test/services/land-gate.test.ts`, `test/services/run-briefs.test.ts`; then the files that call `passGate`: `test/services/{protocol,questions,outcomes,ledger,lanes-run,workspace-land}.test.ts`

**Interfaces:**
- Produces: draft 29 Task 6's `MilestoneVerifier.head`, the two refusals and their exact messages and fixes (the native-verifier `head:` fix sentence dropped), `passGate(run, m, at?, head?)`; `CHECK_LOG_TAIL_LINES = 40` in `src/services/run-briefs.ts`.

- [ ] **Step 1: Write the failing tests:** draft 29 Task 6 Step 1's seven tests, verbatim, except "refuses a PASS that names no HEAD", whose fix now reads `a headless verifier's reply ends with HEAD: <sha>`; and in `run-briefs.test.ts` draft 29 Task 7's "gives a fix-round worker the tail of the milestone's latest failing check" (50 log lines: `l50` and `l11` present, `l10` absent; a later exit-0 record removes it).
- [ ] **Step 2: Run** `bun test test/services/land-gate.test.ts test/services/run-briefs.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as draft 29 Task 6 Step 3 and Task 7 Step 3 (in `briefFor`'s `fix` body instead of plan 28's `fixBrief`); `writeRunReport` lists each milestone's machine-gate audit (`pre-existing`, `rerun`, a skipped scan) under `## Audit`, beside the judge's decisions.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Repair the callers** — draft 29 Task 6 Step 5, verbatim. Never loosen a gate assertion.
- [ ] **Step 6: Commit** — `git commit -m "feat(land): a verdict covers the commit it lands, with catherd's own check on it"`

### Task 8: landing in a run with a base branch

**Files:**
- Modify: `src/infra/git.ts` (`fetchBase`, `isAncestor`, `currentBranch`), `src/services/milestones.ts:245-259` (`landedCommitOf`), `src/services/workspace-admission.ts:126-147` (uses both), `src/services/run-effects.ts` (`land` in a base run, `checkMerged`, `integrate`), `src/domain/run-machine.ts` (the base-run rules), `test/helpers.ts` (`repoWithOrigin`, `commitInClone`)
- Test: `test/infra/git.test.ts`, `test/services/workspace.test.ts`, `test/services/run-effects.test.ts`, `test/domain/run-machine.test.ts`

**Interfaces:**
- Produces: draft 33 Task 2's `fetchBase(repo, base, timeoutMs = 60_000): Promise<boolean>`, `isAncestor(repo, commit, ref): Promise<boolean | null>`, `landedCommitOf(run, m): string | null`; `currentBranch(repo): Promise<string | null>` (`git rev-parse --abbrev-ref HEAD`, null when detached). Effects (Rulings 14–16): `land` in a base run → `fetchBase` (a failure adds the hint "fetch of origin/<base> failed: using the copy from the last fetch") → not an ancestor → `base.behind`, else 1.5 `land`; `integrate` → `integrate.done` / `integrate.conflict`; `checkMerged` → `milestone.merged` when merged, else nothing. Transitions, base runs only:

| Event or state | Actions |
| --- | --- |
| `base.behind` | `integrate{ M }` |
| `integrate.done` | `M.commit` = the merge; a fresh `verifier-<M>` |
| `integrate.conflict` | `dispatch worker-<M>-integrate` (`fix`, notes: the files and the rule of Ruling 14); its clean end → `commit{ M, round }` → a fresh verifier |
| `milestone.landed` | plan 30's actions, plus `park M` (`push`, Ruling 15) and `checkMerged{ M }` |
| a landed, unmerged milestone that another waits on, `wakeAt` passed (10 min) | `checkMerged{ M }` |
| `milestone.merged` | the `push` question closes (reduce); advance |
| `question.answered` on a `push` question | M counts as merged (reduce) |
| `activeMilestones` | in a base run, `after` milestones must be `merged` |

- [ ] **Step 1: Write the failing tests:** draft 33 Task 2 Step 1's two tests, verbatim, plus:

```ts
it("integrates a base that moved before landing", …);               // machine: base.behind → integrate → integrate.done → verifier-M1, no land
it("sends conflicts to an integrate worker, then commits and re-verifies", …);
it("parks a landed milestone for its push, and closes the question when origin's base contains it", …);
it("unblocks a dependant of a squash merge only by the owner's answer", …);
it("a run without base lands as 1.5: no fetch, no push question, dependants wait for landed only", …);
it("land in a base run reports base.behind when origin moved, and lands when it did not", …);   // effects, local bare origin
it("works from the last fetch when origin cannot be reached, and says so", …);
```

- [ ] **Step 2: Run** `bun test test/infra/git.test.ts test/services/workspace.test.ts test/services/run-effects.test.ts test/domain/run-machine.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as draft 33 Task 2 Step 3 (switching `unmerged` to the two helpers), the effects and the rules; `wakeAt` gains the 10-minute merge check while one is due.
- [ ] **Step 4: Run** the Step 2 command. Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(land): in a base run, landed means origin's base contains it, after integrating the base"`

### Task 9: docs, backlog and changeset

**Files:** `plugin/skills/catherd/SKILL.md` (two lines: a phone question may be a push or a `check_broken`; gitleaks is optional), `README.md` (gitleaks; `catherd gate run`), `MIGRATION.md` ("From 1.5 to 2.0": install gitleaks for the secret scan; a verifier's reply ends with `HEAD:`; `land` needs a `gate_run` record), `docs/dev/ideas.md` (remove "BLOCKER: none counts as an open blocker", fixed in plan 30's `endedEvent`, and draft 33's "`landedCommitOf` lines up two separately filtered arrays", fixed in Task 8), `.changeset/unattended.md`

- [ ] **Step 1:** Write the text; the changeset is `"catherd-cli": major`, "2.0.0 (part of): blocked replies name one of six reasons the daemon acts on, Jev classifies the rest; limits fail over to any configured backend; catherd runs each milestone's check and lands only the commit it verified; a base run lands when origin contains it."
- [ ] **Step 2: Run** `bun test test/skills.test.ts`, `bun run format:check`, `bunx changeset status`. Expected: PASS; `catherd-cli` major.
- [ ] **Step 3: Commit** — `git commit -m "docs(gate): the unattended run's reasons, check and landing"`
