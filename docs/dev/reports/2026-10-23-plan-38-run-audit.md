# Plan 38 run audit (ideas sweep, 2026-10-23)

Run `20261023-025529-ideas-sweep-plan-38`, catherd `2.0.0-next.20261023023018`, cancelled by the owner after 7h10m
(5h49m of it parked with nobody answering). 108 role runs, 113.5M tokens. M1 and M3 landed inside the run; M2, M4, M5
and M6 were merged by hand after the cancel; M7 never started inside the run. About 52 of the 53 plan tasks are on the
branch. Audited through five lenses: orchestration flow, gate integrity, cost, role output quality, observability.

Severity: **blocker** (the run cannot finish or a green cannot be trusted), **major** (large waste or a wrong signal),
**minor**.

## Gate integrity — a milestone's green could not be trusted

1. **blocker — The `&&` tail of the check never ran.** The milestone check was `ROOT && web && openapi && privacy`.
   The root `bun test` exited 1 in every record, so the web gate, e2e, openapi sync and the privacy grep never ran
   for any milestone. `machineGate` (`src/services/milestone-check.ts`) sees one command and one exit code. Fix: one
   `gate_run` per item, land requires every item.
2. **blocker — `gate_pass` records against the base checkout when it finds no matching step.** M3's `web-gate`,
   `panel-e2e` and `openapi-regen` rows in `gates.jsonl` name the base commit `d6b23a4` and hash the base's `web/`
   (`treeOf(run, null)` returns `run.meta.repo`). The verifier noticed and still returned PASS. Fix: `gate_pass`
   requires a milestone and refuses without a matching step.
3. **major — `gates.jsonl` never gates.** Land reads only the verdict HEAD and `checks.jsonl`
   (`src/services/lane-service.ts` ~425–460); `recordedItems`/`failedItems` are advisory. Fix: land refuses unless every
   item the A-lines name has a pass on the landed HEAD.
4. **major — Baseline comparison is on raw line text, so landing depended on who ran the baseline.** Failure lines
   embed the role name (`… runs verifier-M1 of run …`). The same environment fault was "pre-existing" for M1 and M3
   (they landed on exit 1) and "new" for M2, M5 and M6 (they parked). Fix: normalise role, run id, paths and ports in
   `checkFailLines`.
5. **major — A baseline that itself exits non-zero is accepted.** "Every failing line is pre-existing" is an audit
   note, not a failure, so a base with ~60 environment failures waved through any head with the same ones. Fix: a red
   baseline blocks until it is clean or the owner waives the lines.
6. **major — `checkFailLines` keeps only 60 lines** (`src/domain/fail-lines.ts`). Every record has exactly 60; a new
   failure past position 60 is invisible. Nothing was hidden this time by ordering luck. Fix: compare the full set of
   `(fail)` names; cap only the display.
7. **major — The verifier's gate inherits the role's `CATHERD_ROLE` and scratch `TMPDIR`**, so every spawned `catherd`
   in the suite fails `E_ROLE_SCOPE` (~54 failures). This is the root of 4 and 5. A cached failed record cannot be
   re-recorded by the verifier. (Fixed on this branch.)
8. **minor — Carried-over results are accepted.** Verifiers reported A3/A6 as "carried over from the last verifier on
   this HEAD" with no record. Fix: record each A-line with HEAD and command; reject a carried result on a different HEAD.

## Orchestration flow

9. **blocker — The run could never reach M7.** The architect widened M7's dependency from M1/M2/M5/M6 to M1–M6
   (plan.md D1) without surfacing it; the coordinator parked M4 believing the rest would proceed. Fix: a widened
   dependency is a plan-time question; `state.next` names the milestone that actually gates.
10. **blocker — A BLOCKER past the review cap deadlocks.** Answering it only re-runs the verifier on the unchanged
    HEAD; no worker is dispatched. A verifier FAIL counts as a review round (`run-state.ts:497`), so M4 hit the cap on
    one trivial test failure with no fix round. (Fixed on this branch.)
11. **major — Parallel lanes block each other through a repo-wide typecheck.** About 16 worker dispatches ended
    `check_broken` because red-first tests import exports a sibling lane has not written yet (plan.md D6 puts a
    repo-wide typecheck in every lane's fast check). Fix: the lane fast check type-checks its Owns, or a `check_broken`
    naming a sibling's file waits for that sibling.
12. **major — A verifier re-runs on an unchanged HEAD and environment.** M4's verifier ran three times on `13f8a45`;
    M5's second verifier repeated a deterministic env failure because the first did not write `VERDICT: BLOCKED`
    (`run-state.ts:730-737`). Fix: skip a verifier whose HEAD and environment are unchanged since its last failure.
13. **major — A verifier result is thrown away when the base moves.** M3's verifier ran 22 min, then `base.behind`
    forced a second full run (14 min). Fix: integrate the base before dispatching the verifier.
14. **minor — Milestone starts serialised by the memory check** (`needMb` 8192 vs 5–7 GB free): one new tree per ~6
    min, M6 waited 30 min. **minor — Verifier gates queue on the heavy lock in no useful order.** **minor — Cancel
    leaves orphan parks and 1.7 GB of trees.**

## Role output quality

15. **major — Owns lists omit the existing tests that pin changed behaviour.** M1 changed one-milestone semantics
    without owning `test/services/run-effects.test.ts`; M4 changed `run-state.ts:747` and `ensureDaemon` without owning
    their tests. Failures surfaced only at the verifier. Fix: the architect adds the callers' tests of every changed
    export to Owns (`src/domain/role-prompts.ts:56-62`).
16. **major — Reviewers do not run tests**, so they PASS heads the verifier fails (M4 at `13f8a45`). Fix: the reviewer
    runs the touched test files.
17. **minor — The same finding repeated unchanged for three rounds on an unchanged HEAD** (M3's `ANTHROPIC_API_KEY`
    BUG, which was a rule copied without its spawned-process scope). Fix: a repeated finding on an unchanged HEAD goes
    to the judge; rule text is copied with its scope.
18. **minor — Contract slips go unchecked.** Reviewers omit `VERDICT:`/`HEAD:`, a verifier opened with prose, workers
    wrote `STATUS: done`. Fix: the parser rejects a reply missing required lines and asks again.
19. **minor — The architect added a requirement that contradicted its task** (M2.L1, "re-read from start" vs
    `size <= at` returns), costing a judge round. **minor — Known issues are the verifier's whole reply split into lines.**

## Cost

20. **major — Codex cost is never computed.** `src/adapters/codex/index.ts:142` sets `costUsd: null` though the catalog
    has prices, and `src/services/summary.ts:150` sums `null` as 0. The run reported $11.09 — Claude only (20 runs, the
    CLI's own `total_cost_usd`). The 88 Codex runs (94% of tokens) at catalog prices add about $37.7: roughly $49 in all.
21. **major — "113M in" counts cache reads.** ~92.6% is cached; uncached input is ~8.4M. Cache writes are folded into
    input and not recorded in `runs.jsonl`, so cost cannot be recomputed from it. Show uncached / cache read / cache
    write / output.
22. **major — Effort climbs on environment failures.** M2.L3 took ~14 worker dispatches and 14% of all tokens, rising
    from Sol medium to xhigh after `check_broken` parks. Fix: park at once on a repeated identical `check_broken`; never
    climb a rung for an environment error.
23. **minor — ui-reviewer resumes a growing thread** (3.9M → 8.4M input per round, 20M total). Start a fresh thread per
    round or cap resumes when `threadHeavy`. **minor — Judges run as full Claude Code sessions** (~$0.34 each, 4 of 8 were
    `dismiss`); simple verdicts can go to the cheap Jev path. **open — whether Codex usage is cumulative across a resumed
    thread** (it would double-count resumed chains).

## Observability

24. **blocker — Nothing signals a run parked with nobody answering.** After 04:16 the run emitted only `tick` for 5h49m;
    ntfy sent once per park and never again. `orchestratorWait` (`src/services/orchestrator-wait.ts:41`) covers only 1.x
    dispatch records. Fix: re-notify at 30 min, 2 h, …; show "waiting for you · 6h" on the panel.
25. **major — An interactive question from an unattended coordinator is invisible.** The coordinator asked a menu
    question in its own terminal; ntfy carries only catherd's parks. Fix: the catherd skill tells a coordinator never to
    ask interactively — rule, record, and send owner-only items to the run's notify url.
26. **major — `status --json` `questions` reads the 1.x `questions.jsonl`** (`src/entry/runs-command.ts:48`,
    `src/services/summary.ts:129`), which never gets push parks, lane parks or plan approval
    (`run-effects.ts:765`). It showed `[]` while parks were open. Fix: build it from replayed state, like `parkedOf`.
27. **major — A cancelled run's report never says it was cancelled, by whom, or what was left.** The finish ntfy text is
    the same as for a success (`src/domain/notify.ts:30`); `state.md` still says "the daemon continues". Fix: an outcome
    headline in the report and a per-outcome finish message, with an optional cancel reason.
28. **major — ntfy messages cannot be acted on from a phone.** Every message is `Mx needs your answer` plus a shell
    command — no reason, no question text, no link. Fix: reason in the title, the question's first 120 characters, a
    click URL to the panel's questions page, higher priority for `blocker` and `environment`.
29. **minor — Panel numbers mislead.** Took includes parked time (show "waiting on you 5h49m"); "85/118 done" hides 25
    skipped and 5 failed; Rounds disagrees with the round counts in catherd's own messages; Cost does not say "Claude
    only"; an ended run keeps 5 `parked` entries with answer commands for a dead run.
