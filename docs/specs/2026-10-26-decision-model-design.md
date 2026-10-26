# The decision model and role briefs — design

One spec and one plan (owner, 2026-10-26). Part A is the decision model. Part B is the role briefs and the
harness checks that the briefs rely on. B comes first in the plan, because the decision model judges the
brief.

Status: draft for the owner's approval. Date: 2026-10-26.

## Why

An audit of seven runs on the shared run host (2026-10-25/26: P5 eligibility, P7 merchants, MR-P, MR-I, MR-U, MR-M
part-a and finish-i) found that the rung a role runs on is mostly guessed:

- Jev is asked once per lane, on the lane file's text (about 5 KB). The role gets a brief of 100–145 KB.
- Only lanes ask Jev. The architect, reviewer and verifier land on their role's `defaultRung`, and the judge
  takes `rungs[0]` (`run-effects.ts:396-404`, `routing-service.ts:301`).
- In 20 of 49 lane decisions Jev was below the 0.8 bar ("both below 0.8"), so the architect's `Difficulty:`
  line decided. In M40.L3 it overrode a Jev answer of `logic` and sent the lane to the cheapest rung.
- A fix round never asks again. It reuses the cached answer and climbs one rung.

The owner wants the decision made seriously: before every role, on what that role actually sees, in every
round.

## Goals

1. **A decision before every dispatch.** Every role (architect, dossier researcher, worker, writer,
   researcher, artist, reviewer, ui-reviewer, verifier, judge) and every round: the first dispatch, a retry, a
   fix round, a recheck and a re-verify.
2. **Same context.** The decision's state is the exact brief the role will receive, byte for byte, plus the
   few run facts below. The brief is rendered once, and that same text is both judged and sent.
3. **N levels for N rungs.** The difficulty question has as many levels as the role has rungs in the
   profile. The rungs are ordered weakest to strongest by catherd's intelligence index (the one
   `routing-service` already uses). Level k picks rung k.
4. **A floor in a fix round.** When a dispatch follows a failed or rejected one of the same unit (a fix round,
   a retry after a stop, a recheck after a BLOCKER), the rung that just failed is the minimum. The decision
   model picks that rung or a stronger one.
5. **Mandatory.** catherd does not run without a decision model. There is no `off`, and no silent fallback
   to the lane's `Difficulty:`.
6. **Failure parks, it does not guess.** On failure catherd retries. If the decision model still gives no
   usable answer, the dispatch parks a question for the coordinator.
7. **Provider-neutral.** The name is "decision model", not Jev, and nothing is tied to TypeSafe. One model is
   set in the profile: today `perplexity/pplx-decider` through the owner's gateway (`https://<your-gateway>/v1`,
   `POST /systemone`), swappable for any endpoint that speaks the same `{model, state, questions}` →
   `{answers, usage}` protocol.

## Non-goals

- Several decision models voting. One model, set in the profile (owner, 2026-10-26).
- Choosing a backend CLI inside the gateway. Roles run in each vendor's CLI (native harness), so the gateway only
  serves the decision call.
- A separate spec for the briefs. They are Part B of this one.

## Anti-goals

- A dispatch that starts on a rung nobody decided.
- A fix round that drops below the rung that failed.
- A decision judged on one text while the role receives another.

## Decided by the owner (2026-10-26)

| # | Decision |
|---|---|
| O1 | Rename Jev to "decision model" and take it off TypeSafe. One model in the profile, through the owner's gateway, swappable. |
| O2 | It runs before every dispatch of every role, in every round, on that role's exact context. |
| O3 | The difficulty scale has N levels, where N is the role's rung count. |
| O4 | In a fix round, the rung that just failed is the floor. |
| O5 | Mandatory: no off switch. |
| O6 | On failure: retry, then park a question the coordinator answers. |
| O7 | Build it as a decision step in the run state machine, right before every dispatch (approach A). |
| O8 | The difficulty bars go: `BAR_PERCENTILE` (copy 20 / build 45 / logic 60 / hard 65) in `src/domain/bars.ts`, the profile's and roles' `bars`, and their panel settings. «همه چیز باید داینامیک و ان د فلای تصمیم گیری بشه»: every routing choice is made on the fly by the decision model, not by stored thresholds. |

Assumed by the designer and not contradicted. The owner checks these while reading:

- **A1.** The decision model's pick replaces D5 (slack start) and D8 (learned cheaper start). Quota failover
  stays, because it is about availability, not difficulty. The D8 outcome records are still written, so we
  can measure the decision model against them.
- **A2.** The lane file's `Kind:` and `Difficulty:` lines stay as part of the brief, so the decision model
  reads them. They no longer route on their own. With O8, the start-rung path ("the first rung in objective
  order that clears the bar") and the profile's `objective` ordering of start rungs go too. Rungs are ordered
  only by intelligence, and the decision model's level picks among them.
- **A3.** The other Jev question sets (`finding`, `same-defect`, `stop`) move to the decision model
  unchanged in meaning, renamed with it.

## Approaches considered

- **A — a decision step in the state machine (chosen, O7).** `run-machine` issues `decide` before every
  `dispatch`. The effect renders the brief, asks the decision model and reports `decision.made` or
  `decision.parked`, and only then is `dispatch` issued, with the chosen rung and the same brief. The cost is
  a state machine change, its tests and a profile migration. In return, parking uses the existing question
  path, the panel shows the decision as its own step, and judging and sending one text is enforced by
  construction.
- **B — inside the dispatch effect.** This extends `routing-service` and asks just before spawn. Less code
  changes, but a park from inside a dispatch effect has no clean path back into the state machine, and the
  decision is invisible as a step. Rejected.
- **C — let the gateway pick the model.** This cannot pick a vendor CLI, effort or thread. Rejected.

## How it works

### The flow of one dispatch

```
machine: unit needs a role  ──▶ Action decide {name, role, unit, lane, brief kind, notes, floor}
effect:  render brief → decisions/<name>/<n>/brief.md (hash)
         ask decision model (state = brief + run facts) → retry policy
         ├─ usable answer → event decision.made {name, n, level, rung, briefHash, p, why}
         └─ no answer      → event decision.parked → Action park (reason "decision")
machine: decision.made ──▶ Action dispatch {…, rung, briefFile: decisions/<name>/<n>/brief.md}
effect:  dispatch sends that file; refuses if its hash ≠ decision.made.briefHash
```

- `decide` is keyed like `dispatch` (`decide:<name>:<n>`), so the daemon never issues one twice. A daemon
  restart between `decision.made` and `dispatch.started` dispatches on the recorded decision without asking
  again.
- What a coordinator answers on a `decision` park: a rung from that role's list (it must respect the floor),
  or `retry`. The answer becomes `decision.made` with `source: "coordinator"`.

### The state the decision model sees

```
{ role, unit, round, isFix, floorRung | null,
  rungs: [ {level: 0, rung, intelligence}, … ],   // weakest first, after the floor is applied
  previous: [ {rung, outcome, stopReason} ]          // this unit's earlier dispatches, newest last
  brief: "<the exact brief text>" }
```

### The questions

- `difficulty` (`score`, N criteria). The criteria are generated per role from the existing four difficulty
  descriptions (mechanical, follows an example, new stateful logic, open cause or design), stretched or
  merged to N levels. Each level's text names what a role at that level can do well. Level k maps to rung k
  of the ordered list.
- The existing `noul` signals (`shared_state`, `unclear_cause`, `cross_boundary`, `outside_repo`,
  `mechanical`) stay as a floor and cap rule, as in `route-v2`'s `floorLogic` and `capBuild`.
- A pick is usable when its probability is at least the profile's `decision.minConfidence` (default 0.8).
  When none is, catherd takes the lowest level whose cumulative probability from the top reaches the bar.
  That is a decision, not a fallback. Only an error or an unparsable reply counts as failure.

### The floor

`floor` is the rung of the last failed dispatch with the same name. What counts as a failure for each role,
and the strict floor after two failures on one rung, are in R1 and R2.
Rungs below the floor are removed from the list before the question is built, so N shrinks. When the floor is
the role's strongest rung, there is one level: no question is asked, and `decision.made` records
`source: "floor"`.

### Failover

A quota or limit failure (`limited`) does not go to the decision model again. The existing failover picks
the closest rung of no lesser intelligence on another provider, as it does today, and records it as
`decision.made` with `source: "failover"`.

### Retry policy

Transport retries as today (10 s per attempt, 25 s per call). Then three calls a minute apart. Then
`decision.parked`. A park notifies through the existing `blocked` moment.

### Profile and credentials

```jsonc
"decision": {
  "url": "https://<your-gateway>/v1",
  "model": "perplexity/pplx-decider",
  "minConfidence": 0.8
}
```

- The key: the env var `CATHERD_DECISION_KEY`, else `credentials.json` field `decisionKey`.
- Migration: `jev.use` is dropped, the key `typesafeApiKey` moves to `decisionKey`, and the URL defaults to
  TypeSafe's old URL only when a migrated profile had a key and no `decision` block. The migration logs that
  default.
- `catherd doctor` and preflight refuse to start a run until the decision model answers a fixed probe
  question.

### Records and the panel

- `decisions.jsonl` replaces `jev.jsonl`, one row per decision: name, n, role, level, rung, floor, the
  probabilities, `source` (`model`, `floor`, `failover`, `coordinator`), brief hash, latency and usage.
- The panel shows a "Decision" tab on every role node: the levels, the pick, its probability and why.
- Every "Jev" in code, CLI, docs and panel becomes "decision model". `catalog/jev.json` becomes
  `catalog/decision.json`.

## Rulings from the builder check (designer's calls, for the owner to check)

- **R1. The climb machinery goes.** The decision model replaces `climb`, `climbReason` and the one-rung
  ladder. To keep a lane from looping on a rung that keeps failing, the floor is **strict** once the same
  rung has failed twice on the same dispatch name (today's `MAX_TRIES` = 2): the floor becomes the next rung
  above it. When there is no rung above, the existing top-of-ladder path stays: the "unexpected" judge
  (`TOP_RUNG_JUDGES`).
- **R2. The floor is per dispatch name** (`worker-M40.L1`, `reviewer-M40`), never per unit, so another
  role's rung never becomes this role's floor. A failure is the role's own:
  - **worker or writer:** a failed fast check, a BLOCKER or BUG that came back to its lane, a stop
    (`blocked`, `refused`, `too_hard`, `flaky`) or an empty diff;
  - **reviewer, ui-reviewer or verifier:** its own dispatch failed (a provider error, no verdict, or a
    verdict the judge overturned). A worker's BLOCKER is not the reviewer's failure.
  - **architect or judge:** the reply was unusable.
- **R3. Decide first, render after.** The state is the full brief (as on a fresh thread) plus this round's
  notes, which is everything the role will know either way. After the pick, catherd renders what it sends:
  the fix-only lines when the chosen rung resumes its thread, the full brief otherwise. Anti-goal 3 reads as
  "the decision sees everything the role knows". `decision.made` records the hash of the state, not of the
  sent text.
- **R4. Secrets are scrubbed. The 6,000-character cap and the fence dropping go.** The decision model gets
  the brief with secrets redacted (`jev.ts:101-143` keeps only the scrub). Briefs go to the gateway and perplexity
  in full. The owner's data rule allows this.
- **R5. N comes from `candidates()`** after the effort, billing, listing and capability filters, minus rungs
  held on quota at decide time. Rungs of equal intelligence form one level. Within a level, today's
  spread-over-quotas tie break picks the rung.
- **R6. `finding`, `same-defect` and `stop` are mandatory too.** No off, and no fallback answer. They retry,
  then park like O6. A parked stop classification waits for the coordinator.
- **R7. Outcome records store `level`, `N` and the rung's intelligence**, so the decisions can be measured.
  `learnedStart` (D8) is deleted.
- **R8. Every other start-rung rule goes, in line with O8.**
  - The mechanical fix "once on the cheapest rung" (`run-state.ts:746,1532`).
  - The 80%-budget switch to cheapest-first (`routing-service.ts:56`): the spent fraction goes into the
    decision state instead.
  - The no-slack critical-path rule (`routing-service.ts:259-266`): `slack` goes into the decision state.
  - Chore lanes on the cheapest rung (`routing-service.ts:216,303-306`): they are decided like any lane.
- **R9. The judge is decided too.** The `judge` action gets the same decide step, since it does not go
  through `dispatch` (`run-machine.ts:56`, `run-effects.ts:1205-1217`).
- **R10. An admission refusal of a decided rung** (`rerouteLane`, `run-effects.ts:555-565`) is treated like
  a quota hold: the rung leaves the list, and the decision is asked again.

## Part B — role briefs and harness enforcement

The evidence is in [the role-brief research](../research/2026-10-26-role-briefs.md), with measurements,
vendor guidance and ten peer orchestrators. In short:

- Worker briefs are 74% `<context>` and 4% lane file.
- `plan-input.ts:110-147` gives every role of a milestone the same union of every lane's cited sections, and
  `§n` collides across files.
- Other roles' duties cause stops: 4 `no_access` on A12, and 9 `check_broken` on siblings' lint.
- 11 of 14 verifiers "judged from the tree".
- Unbounded findings broke 4 judges.

### Goals

8. **One brief shape for every role.** The cache-stable parts come first:
   1. **The role contract.** It is static per role and byte-identical across runs: purpose, you must, you
      must not, done when, and the reply (5 lines or fewer, with the full report written to a file).
   2. **Run facts.** Paths, the scratch dir and the machine rules, filtered to this role.
   3. **Unit context.** The plan tasks this unit owns, verbatim. The decisions and interfaces those tasks
      cite, at subsection level, resolved per file, so there is no `§n` collision. Every other document is
      named by path, to read on demand.
   4. **This round.** Findings to fix, the previous attempt's outcome and the floor rung.
9. **Duties have owners.** The architect tags every A-line `worker`, `reviewer`, `verifier` or `run`. A role
   sees only its own lines and the `run` lines. Lane Rules that restate an A-line are refused when the lane is
   written. The `<team>` paragraph is replaced by one line: who comes next and what they check.
10. **Hard caps, with pointers.**
    - Unit context: about 20 KB.
    - One finding: 2 KB.
    - Known issues: titles only.
    - The judge gets references, never pasted text.

    Each cap names the file that holds the rest.
11. **Fix rounds send part 4 only** on a resumed thread. A new thread gets the same four-part shape, never
    the old full brief.
12. **The verifier executes.** Its brief lists the exact commands of the milestone's checks. Its reply
    carries the command, exit code and log path for each one, and catherd reads the logs. A missing log or a
    `NOT RUN` is a FAIL. "Judged from the tree" is allowed only for lines about the tree itself (submodule
    pin, diff contents).
13. **Failure class.** Every failed check and every stop is classed `product` or `harness`, through the
    decision model's `stop` question (R6). A `harness` failure gets one repair dispatch outside the round
    count. The same harness signature twice parks to the coordinator with the evidence.
14. **Test-file guard.** Test files are hashed at lane start. A changed one is refused unless the lane owns
    it.
15. **A clean harness for headless roles.**
    - Tool output is clamped (head and tail) where the CLI allows it.
    - opencode gets `TMPDIR` and its scratch dir.
    - Memory plugins are off (`HONCHO_ENABLED=false` in the role env).
    - A role is never shown MCP tool names it cannot call.
16. **A scorecard on every run.** Per role: brief bytes, input tokens, cache-hit share, wall time, rounds per
    lane, stops by reason, and executed commands per verifier reply. It is written to the run report. The
    first target is a worker brief median under 20 KB, no verifier PASS without executed commands, and zero
    stops from another role's duty.

### Order in the plan

B8–B11 (the brief shape) land first. Then B12–B15 (enforcement), then Part A (the decision model, which
judges the new briefs), and then B16, measured on a live run.

## Probe results (2026-10-26, through `https://<your-gateway>/v1`, key `catherd`)

A second host of the same gateway timed out every call at 100 s with a 504, even a 3 KB state. The Cloudflare host
answered every one. The model was `perplexity/pplx-decider-v1.2-20261016`.

| state | input tokens | latency | 4-level `difficulty` (route-v2) | 5-level, one level per worker rung |
|---|---|---|---|---|
| reviewer recheck, 3 KB | 1,078 | 1.3 s | spread, confidence 0.17 | spread, confidence 0.35 |
| M40.L1 slim (role + tasks + lane), 38 KB | 11,353 | 1.4 s | **new logic, p 0.77** | level 3 (sol high), p 0.54 |
| MR-U M1.L2 full, 106 KB | 29,640 | 2.1 s | follows an example, p 0.96 | level 1, p 0.51 |
| M40.L1 full, 144 KB | 41,458 | 2.4 s | **mechanical, p 0.78** | **level 0 (the cheapest), p 0.66** |

- **It fits.** 41 K tokens take 2.4 s and $0.0008.
- **The bloated brief misleads the decision.** The same lane read as new logic when slim, and as a
  mechanical change when its 101 KB `<context>` was attached. In the real run that same lane went to the
  cheapest rung. Part B is a prerequisite for Part A's quality, not only for its cost.
- **Five levels lower the confidence** (0.35–0.65 against up to 0.96 on four). Few picks will clear 0.8, so
  the cumulative-from-the-top rule decides most of them. The plan should test the level texts on these four
  states, and keep them as a fixture.

## Open before planning

1. **Does a real brief fit the decider?** Its context limit is not published. Jev's was 64k tokens, and the
   worker briefs run to about 35–45k tokens and over (Persian costs more). Probe: send three real briefs
   (MR-U M1.L2 106 KB, P5 M40.L1 144 KB, a 3 KB recheck) through the owner's gateway and record status, latency and
   usage. This needs a gateway client key for catherd, a new access that needs the owner's OK. If the large
   ones fail, Part B's caps decide the size anyway. The probe should also cover a new-shape brief of about
20 KB.
2. **Cost and latency.** Roughly 180 dispatches across seven runs means about 180 decisions. The decider
   costs about $0.02 per million input tokens, so cost is negligible. Latency is about 0.8 s on the miner's
   small states, unmeasured on large ones. The probe answers this too.
3. **Tests.** Every test that routes gets a fake decision model (`fetchImpl`). No test reaches the network.

## Left to the builder

- Exact event and action names, and where `decide` sits in each machine path (`roleDispatch`, lane
  dispatch, fix, recheck, verify, judge).
- How the N-level criteria texts are generated for N = 1…6.
- The migration's file layout, in line with ProfileService being the only writer of profiles and config.
