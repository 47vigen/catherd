# catherd 1.6, plan 30: blocked reasons, recovery and answers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every stop says why, and the server says what to do about it. A blocked reply ends `STATUS: blocked — <reason>: <why>` with one of six fixed reasons; each reason maps to an action hint (climb, fail over, park for the owner, wait); Jev, when on, classifies a stop that gives no reason; a lane check that fails only in a sibling lane's files counts as done; a `check_broken` lane waits for its running siblings and retries once, and a verifier's first `check_broken` reruns once before anyone is asked; `answer` hands back the stopped units, ready to re-run on the same rung with the old brief plus the answer; and a review finding "survives a fix" only when a fix ran between the two reviews, matched by a deterministic key.

**Architecture:** The reasons, their parser, the prompt text that lists them and the sibling-file matcher are pure, in a new `src/domain/blocked.ts`. A new `src/services/stops.ts` reads a record's stop (its reply's reason, else Jev's answer kept in the dispatch's `stop.json`) and turns it into one hint, which `recordHints` (`src/services/dispatches.ts`) passes to `dispatchHints` (`src/domain/hints.ts`) in place of today's `climb: blocked`. Jev's new `stop` question set lives in `catalog/jev.json`, is asked through a new `RoutingPort.stopCause`, and is called once per dispatch from `settle` (`src/services/dispatch-service.ts`). `protocolNext` (`src/services/protocol.ts`) reads the same stops to hold, retry or park a lane and to rerun a verifier. `answer` (`src/services/questions.ts`) returns `rerun` inputs built from each stopped dispatch's raw brief, which admission now keeps in `brief-in.md`. Finding keys and survival live beside `openFindings` in `src/services/milestones.ts`.

**Tech Stack:** Bun ≥ 1.4, TypeScript, zod 4, `@modelcontextprotocol/sdk`. No new dependency.

**Spec:** `docs/specs/2026-10-12-catherd-1.6-design.md`, "Plan 30: blocked reasons, recovery and answers", with "Owner rulings needed" (1: `roundCall` not ported) and "Not in 1.6". t3herd sources (read-only, `<the t3herd clone>` at 71cbb6a): `src/state.ts:96-111` (`BLOCKED_REASONS`, `blockedReason`), `src/step.ts:88-95` (`REASON_CAUSE`), `src/step.ts:389-505` (`recover`), `src/step.ts:507-534` (the answer path), `prompts/_no_questions.md`, `src/jev.ts:108-132` (`jevCause`), `catalog/jev-attention.json`, `src/check.ts:70-93` (`foreignFailure`), `src/step.ts:201-212` (`findingKey`); commits 7487854, dc3dbcf, 50820ef, 0b8b1e1, c514130, a488471.

**Pre-validation: spiked the reason parser, `foreignFailure` and `findingKey` (the `src/domain/blocked.ts` and `findingKey` assertions of Tasks 1 and 3), targeted tests only; the full gate runs at execution.** Written against `main` at 2061e6e (1.5.0); plans 28 and 29 land first, so refresh every line number at execution (the spec says so).

## Global Constraints

- Layers `domain → infra → adapters → services → entry` (`test/architecture.test.ts`): `blocked.ts`, `hints.ts`, `jev.ts` and `role-prompts.ts` are domain; `stops.ts`, `protocol.ts`, `milestones.ts`, `questions.ts` are services; the MCP tool text is entry.
- The gate: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test`. Per the 1.6 ruling, executors run the targeted test files named in each task, and the full gate once per wave on the combined head. Tests that could reach the network delete `ANTHROPIC_API_KEY` and `TYPESAFE_API_KEY` (`freshRun` already deletes the latter); Jev answers come from the `fakeDeps` routing fake, never the network. No wall-clock sleep for correctness.
- Commits: conventional, subject ≤ 100 characters, lower-case first word after the scope, no plan ids in the subject; check `git log` after each commit.
- The six reasons, verbatim and in this order: `needs_user | too_hard | provider_error | no_access | check_broken | out_of_scope`.
- The reason → action map (spec: "climb, fail over, park for the user, or wait"): `too_hard` → climb; `provider_error` → retry once on the same rung, then fail over; `needs_user`, `no_access`, `out_of_scope` → park; `check_broken` → wait (a lane) or rerun once (a verifier), then park.
- Integrates with plan 23, never duplicates it: a record with an `ENV:` line (`record.environment`) keeps its `environment:` hint and gets no reason hint; a verifier's `VERDICT: BLOCKED: environment` keeps its park path in `protocolNext` and `land`; an adapter's `provider-unavailable` stays a `limit` that `settle` fails over. The new reasons only cover what those do not.
- With Jev off (`jev.use: "off"` on the run's profile), no Jev call is made, no `stop.json` is written, and a stop without a reason is handled exactly as in 1.5.
- Owner ruling 1 default: no `roundCall`, no soft or hard round caps; the survival rule only feeds the existing "a finding that comes back climbs once" step.

## Review Focus

1. **A blocked reply that names no reason (`STATUS: blocked — the tests fail`), with Jev off.** Expected: the hints are exactly 1.5's (`climb: blocked`), nothing is written to the dispatch folder, `protocolNext` still says `dispatch <lane>`. Pinned in Task 2: "keeps 1.5's hint for a blocked reply with no reason" and Task 4: "asks nothing and writes nothing with Jev off".
2. **A worker's check fails in its own file and in a sibling's.** Expected: not foreign; the lane is not done and gets the `wait:` hint. Pinned in Task 1: "is not foreign when the log also names an own file" and Task 2: "calls a check_broken lane done only when every named file is a sibling's".
3. **Every sibling of a `check_broken` lane stopped too.** Expected: nobody waits on a stopped sibling; `protocolNext` says `dispatch` for the broken lane (its one retry), and a second `check_broken` parks the milestone. Pinned in Task 5: "retries a check_broken lane at once when its siblings stopped, and parks it after a second check_broken".
4. **A reviewer writes `BUG: none`, or re-reviews after a base merge with no fix in between.** Expected: no open finding from the `none` line, and no finding "survives". Pinned in Task 3: "does not count BLOCKER: none or BUG: n/a as a finding" and "lets a finding survive only when a fix ended between the two reviews".
5. **`answer` while a unit is still running, or for a verifier whose `VERDICT: FAIL` reply ends `STATUS: complete`.** Expected: neither is in `rerun`; only stopped units are. Pinned in Task 6: "re-runs only stopped units: not a live one, not a verdict".
6. **An `ENV:` line together with `STATUS: blocked — check_broken: …`.** Expected: only plan 23's `environment:` hint; no `wait:` or `park:` hint. Pinned in Task 2: "leaves an ENV: stop to plan 23's environment hint".

## Rulings

Every ambiguity this plan decided (`Ruling: <what> — <why> — <cost if wrong>`). Step 0 (what 1.5 already does) first.

1. Ruling: no spec item is fully covered by 1.5, so none is dropped. Partial coverage, kept as the gap only: (a) plan 23's `ENV:` line (`src/domain/record.ts:93-96`, commit 8880bb8) and `VERDICT: BLOCKED: environment` (`src/services/milestones.ts:155-158`) already park an environment stop — this plan adds the six reasons around them and lets `environment` win (Global Constraints); (b) plan 23's `provider-unavailable` exit (`src/domain/record.ts:31-32`) already fails over an opencode stream outage as a `limit` — this plan covers only a reply that reports `provider_error` itself; (c) plan 23's `openFindings` (`src/services/milestones.ts:117-142`) closes findings once a fix ran, and 1.0's `ask same-defect` (`src/services/lane-service.ts:568-589`) judges a returning finding — this plan adds only the deterministic key and the "a fix ran between" condition; (d) plan 23's fresh-verifier re-check (`src/services/protocol.ts:184-188`) handles a FAIL — this plan adds only the verifier's `check_broken` rerun — the spec's Step 0 — none.
2. Ruling: the reason is read from the existing `replyWhy` (`STATUS: blocked — <reason>: <why>` parses to `replyWhy = "<reason>: <why>"`), not a new record field; only a `blocked` reply carries one — the STATUS line's shape is unchanged, so no schema change and no parser rewrite — a reply that puts the reason elsewhere has none.
3. Ruling: the reason list goes into every role's reply contract (`replyContract(role)`), the verifier's and architect's included, as one sentence built from `BLOCKED_REASONS` right after the STATUS line; after plan 28 the contract is the `reply_contract` section of every brief and native agent body, and `STATUS_LINE` is the single place the STATUS text lives (plan 28's handoff note), so `BLOCKED_LINE` is attached there and to the worker's own STATUS sentence — one source, every vendor — none.
4. Ruling: actions are hints, never server dispatches — catherd's orchestrator dispatches (spec 1.0: the server never runs a role on its own except a usage-limit stand-in); a hint is how every 1.5 action reaches it — the orchestrator can ignore one.
5. Ruling: `provider_error` from a reply: the first in a row on a dispatch name → `retry:` on the same rung; the second in a row → `failover:` naming the rung's stand-in from the run's profile (`standInFor(runProfile(deps, run).failover, rung, repo)`), or `park:` when it has none. It is not routed through `settle`'s automatic failover — that path is a usage limit's, writes a run-wide pause and its text says "usage limit"; t3herd also retried the same rung first — a second `provider_error` waits for the orchestrator's next dispatch instead of starting one.
6. Ruling: `out_of_scope` parks, as in t3herd (`REASON_CAUSE`), even though catherd has `owns_add` — the spec's map has no architect action; the park hint says `owns_add` is the owner's other option — none.
7. Ruling: "an unexplained stop" is a record that is not a `limit`, `cancelled` or `cli-too-old`, has no `environment`, and either ended `failed`/`timeout`, or ended `ok` with no STATUS line, or with `blocked`/`refused` and no reason. Jev is asked once per dispatch, from `settle`, under the run's profile's `jev.use`; a sure answer (p ≥ 0.8, not `other`) is kept in `<dispatch>/stop.json` (schema 1) and read by `recordHints` and `protocolNext` — `settle` has `deps` and already writes `failover.json` the same way; `recordHints` runs without `deps` — a dispatch settled by a catherd older than 1.6 has no `stop.json` and reads as in 1.5.
8. Ruling: Jev's question set is `stop` in `catalog/jev.json`: one `choice` question `stop` whose criteria are the six reasons plus `other`, rule `{ min: 0.8, fallback: "other" }`, state `{ status, reply }` with `reply` the last 4000 characters through `scrubFree` — t3herd's `jev-attention.json` (min 0.8, a 4000-character tail), re-cut to the six reasons so one map serves both sources; `usage_limit` and `failed_check` are dropped (a limit is already a `limit` record; a failed check is the orchestrator's fast check) — none known.
9. Ruling: "a lane check that fails only in a sibling lane's files" is read from the worker's own `check_broken` reply (the contract asks it to name the failing file:line), matched by t3herd's `foreignFailure` against the lane's `Owns:` (own) and the other lanes of its milestone (siblings), each `Owns:` entry cut at its first glob (`src/x/**` → `src/x`); such a lane counts as done in `protocolNext` and gets a `done:` hint naming the files — catherd runs no lane check itself (the worker and the orchestrator do), and lane files are what `protocolNext` already reads — a worker that replies `complete` despite a failing check is already done; one that names no file is not foreign.
10. Ruling: a `check_broken` lane waits while a sibling of its milestone is running or has never been tried since its latest climb; a sibling that tried and stopped holds nobody; with nothing to wait for, `protocolNext` names the lane for its one retry, and a second `check_broken` in a row on that lane names `park` — t3herd 50820ef ("stopped siblings unblock nobody") and dc3dbcf (retry once, then ask) — a sibling that is parked for a week leaves the broken lane retried once and parked, which is the point.
11. Ruling: "in a row" counts the records of the same dispatch name (for a lane, the same lane) newest first while their stop reason is the same — the smallest rule that matches t3herd's `attempt`/`earlier` counting without an attempt ceiling, which catherd does not have — a climb in between does not reset it (a climb changes the rung, not the reason).
12. Ruling: a verifier's first `check_broken` (a headless `verifier-<M>` record) → `protocolNext` names a fresh verifier once more; the second in a row → park. A native verifier is not read (catherd keeps no native reply); the skill gives the orchestrator the same rule — plan 23's Ruling 8 has the same limit — a native verifier's `check_broken` reaches the owner one rerun early.
13. Ruling: `answer` returns `rerun`: for each dispatch name of the milestone (its lane in the milestone, or its name naming it) whose latest dispatch is not live and stopped — a stop with any reason, `blocked`/`refused` with none, `failed`/`timeout`, or a lane whose latest route row is a climb past the top rung (`from === rung`: "stopped at its ceiling after a failed check") — one `{ role, name, lane, rung, brief }` with the same rung and the raw brief plus `The owner answered: <answer>`. A `limit` is not a stop (failover owns it), nor is a verifier or reviewer whose reply ends `complete`, `partial` or `flaky`. The tool does not dispatch them — Ruling 4; t3herd 0b8b1e1/c514130 — a native Claude unit is not listed (its brief is the orchestrator's).
14. Ruling: admission keeps the brief the orchestrator passed, before composition, in `<dispatch>/brief-in.md` (0600, `writeTextAtomic`); `rerun` uses it, and skips with a hint a dispatch that has none (admitted before 1.6) — `brief.md` is the composed brief (lane block, role notes, contract): re-dispatching it would compose them twice; plan 28 changes the composition, not the input — one more small file per dispatch.
15. Ruling: `findingKey` is t3herd's, verbatim (label stripped, `:line` ranges dropped, lower-cased, non-word runs to spaces, first 8 words); a finding survives when its key is in both the latest full headless review of the milestone and the full headless review before it, and a fix (`FIX_ROLES` record or native run of the milestone, ended ok) ended between the two. `protocolNext` names the surviving lines in its fix-round step; the skill climbs them without `ask same-defect`, which stays for reworded lines — spec, owner ruling 1 default — a native reviewer's findings are never keyed (not kept).
16. Ruling: a finding line whose text after the label is `none`, `n/a` or `-` is no finding (`countFindings`, `findingLines`, the keys) — a `none` key would "survive" every round; it is the ideas.md entry "BLOCKER: none counts as an open blocker" — none.

No owner questions: every fork above is decided by the spec, t3herd's behavior or an existing catherd mechanism.

## Cross-plan interfaces

- **Consumed from plan 28** (assumed, not built here): `replyContract(role: Role): string` in `src/domain/role-prompts.ts`, whose text is the brief's `reply_contract` section, with `STATUS_LINE` the one place the STATUS text lives (`withReplyContract` is deleted by plan 28); `findingBlocks(reply: string): string[]` in `src/domain/fix-brief.ts` (BLOCKER/BUG lines with their continuation lines); admission still receives the orchestrator's brief as `i.brief` and runs it through `fixBrief`/`rejectedBrief`/`verifierBrief` before `composeBrief` — `brief-in.md` keeps `i.brief` before all of them, since a re-dispatch runs them again.
- **Not consumed from plan 29:** the verifier's `HEAD:` line plays no part here.
- **Plan 28 handed this plan** "replace `blocked` with its reason list on the STATUS line" (Task 1) and "build `findingKey` on `findingBlocks`" (Task 3); both are taken as written.
- **Produced for plans 31–33:** `BLOCKED_REASONS`, `BlockedReason`, `parseBlockedReason(why)` (`src/domain/blocked.ts`); `stopOf(run, r): Stop | null` and `Stop` (`src/services/stops.ts`); `findingKey(line)` and `survivingFindings(run, m, start?)` (`src/services/milestones.ts`). Plan 31 (routing) may read `stopOf(...).reason === "too_hard"` as climb evidence; it must not re-parse `replyWhy`.

## Spec coverage

| Spec bullet (plan 30) | Task |
| --- | --- |
| A fixed reason on every blocked reply; the prompt text | 1 |
| The server maps each reason to an action (climb, fail over, park, wait) | 2, 5 |
| A first verifier `check_broken` reruns once before anyone is asked | 5 |
| Jev classifies an unexplained stop; Jev off is as today | 4 |
| A lane check failing only in a sibling's files counts as done, files named | 1, 2, 5 |
| A `check_broken` lane waits for its siblings, then retries once; stopped siblings unblock nobody | 5 |
| An answer re-runs the stopped unit: same rung, old brief plus answer; a lane at its ceiling too | 6 |
| A finding survives a fix only when a fix ran between rounds, by a deterministic key | 3 |
| Skill, ideas.md, changeset | 7, 8 |

## Parallelism

| Wave | Tasks | Files |
| --- | --- | --- |
| 1 | 1 | `src/domain/blocked.ts` (new), `src/domain/role-prompts.ts`, `test/domain/blocked.test.ts` (new), `test/services/dispatch-protocol.test.ts` |
| 2 | 2 ∥ 3 | 2: `src/services/stops.ts` (new), `src/domain/hints.ts`, `src/services/dispatches.ts`, `src/services/dispatch-service.ts`, `src/services/run-service.ts`, `test/services/stops.test.ts` (new), `test/domain/run-rules.test.ts` · 3: `src/services/milestones.ts`, `src/services/protocol.ts`, `test/services/protocol.test.ts` |
| 3 | 4 | `catalog/jev.json`, `src/domain/jev.ts`, `src/services/ports.ts`, `src/services/routing-service.ts`, `src/infra/dispatch-dir.ts`, `src/services/stops.ts`, `src/services/dispatch-service.ts`, `test/services/helpers.ts`, `test/domain/jev.test.ts`, `test/services/stops.test.ts` |
| 4 | 5 ∥ 6 | 5: `src/services/protocol.ts`, `src/services/milestones.ts`, `test/services/protocol.test.ts` · 6: `src/services/admission.ts`, `src/infra/dispatch-dir.ts`, `src/services/questions.ts`, `src/entry/mcp/protocol-tools.ts`, `test/services/questions.test.ts` |
| 5 | 7, then 8 | 7: `plugin/skills/catherd/SKILL.md`, `docs/dev/ideas.md` · 8: `.changeset/blocked-recovery.md` (new) |

Run the full gate once on the combined head after each wave. Other 1.6 plans that the spec puts on the same files (refresh line numbers, keep their hunks): `src/domain/role-prompts.ts` and `src/services/admission.ts` (plan 28), `src/services/protocol.ts` and `src/services/milestones.ts` (plans 29 and 33), `src/services/dispatch-service.ts` and `catalog/jev.json` (plan 31), `plugin/skills/catherd/SKILL.md`, `docs/dev/ideas.md` and `test/services/helpers.ts` (any).

## Tasks

### Task 1: the six reasons, their parser, the prompt text and the sibling-file matcher

**Files:**
- Create: `src/domain/blocked.ts`, `test/domain/blocked.test.ts`
- Modify: `src/domain/role-prompts.ts:165-166` (`STATUS_LINE`), `:172-181` (`CONTRACTS`; the worker's STATUS sentence in `WORKER_REPLY`, `:27-28`) — as plan 28 left them
- Modify: `test/services/dispatch-protocol.test.ts:31-49`

**Interfaces:**
- Produces (`src/domain/blocked.ts`):
  - `export const BLOCKED_REASONS = ["needs_user", "too_hard", "provider_error", "no_access", "check_broken", "out_of_scope"] as const;`
  - `export type BlockedReason = (typeof BLOCKED_REASONS)[number];`
  - `export type StopAction = "climb" | "failover" | "park" | "wait";`
  - `export const REASON_ACTION: Readonly<Record<BlockedReason, StopAction>>` — `too_hard: "climb"`, `provider_error: "failover"`, `check_broken: "wait"`, the other three `"park"`.
  - `export function parseBlockedReason(why: string | null): { reason: BlockedReason; why: string } | null` — the reason is the first word of `why`, backticks or `*` around it allowed, `-` read as `_`, case-insensitive; then an optional `:`, `—`, `–` or `-`; the rest, trimmed, is `why`.
  - `export const BLOCKED_LINE: string` — exact copy below, built from `BLOCKED_REASONS` so the list cannot drift.
  - `export function foreignFailure(log: string, own: string[], siblings: string[]): string[]` — t3herd `src/check.ts:75-93`, with `own`/`siblings` as `Owns:` entries cut at the first glob and trailing `/`; returns the sibling entries named, deduplicated, or `[]` when the log names an own entry (from its base name) or no sibling entry (from two path segments).

- [ ] **Step 1: Write the failing tests** in `test/domain/blocked.test.ts`:

```ts
it("reads a blocked reply's reason and its why", () => {
  expect(parseBlockedReason("check_broken: lint fails in src/b.ts")).toEqual({ reason: "check_broken", why: "lint fails in src/b.ts" });
  expect(parseBlockedReason("`needs-user` — keep v1?")).toEqual({ reason: "needs_user", why: "keep v1?" });
  expect(parseBlockedReason("the tests do not pass")).toBeNull();
  expect(parseBlockedReason(null)).toBeNull();
});
it("maps every reason to one action", () => {
  expect(Object.keys(REASON_ACTION)).toEqual([...BLOCKED_REASONS]);
  expect(REASON_ACTION.out_of_scope).toBe("park");
});
it("names only sibling files, from two path segments", () => {
  expect(foreignFailure("src/b.ts:3:1 error unused import", ["src/a.ts"], ["src/b.ts", "src/c.ts"])).toEqual(["src/b.ts"]);
  expect(foreignFailure("FAIL pkg/x/y.go:3", ["src/a.ts"], ["pkg/x/"])).toEqual(["pkg/x"]);
  expect(foreignFailure("FAIL web/pkg/x/y.go:3", ["src/a.ts"], ["web/pkg/x/**"])).toEqual(["web/pkg/x"]);
  expect(foreignFailure("timeout after 120 s", ["src/a.ts"], ["src/b.ts"])).toEqual([]);
});
it("is not foreign when the log also names an own file", () => {
  expect(foreignFailure("src/b.ts:3 x\na.ts(4,2): error", ["src/a.ts"], ["src/b.ts"])).toEqual([]);
});
it("lists the six reasons in the prompt line, in order", () => {
  expect(BLOCKED_LINE).toContain("STATUS: blocked — <reason>: <why>");
  const at = BLOCKED_REASONS.map((r) => BLOCKED_LINE.indexOf(`${r} (`));
  expect(at.every((x, i) => x > (at[i - 1] ?? -1))).toBe(true);
});
```

In `test/services/dispatch-protocol.test.ts` (the contract test): for every role, `replyContract(role)` contains `BLOCKED_LINE`, after its `STATUS:` line (`indexOf(BLOCKED_LINE) > indexOf("STATUS: ")`). Adjust plan 28's `toEndWith` STATUS assertions to `toContain` where the new sentence follows them.

- [ ] **Step 2:** `bun test test/domain/blocked.test.ts test/services/dispatch-protocol.test.ts` — FAIL (`blocked.ts` missing; contracts do not end with `BLOCKED_LINE`).
- [ ] **Step 3: Implement `src/domain/blocked.ts`.** `BLOCKED_LINE` is exactly this text (port of t3herd `prompts/_no_questions.md`), the reasons joined from `BLOCKED_REASONS`:

```text
Nobody reads your thread until you finish: never ask a question and never wait for an answer. When you cannot finish, leave the finished work in place, say what is left, and end with STATUS: blocked — <reason>: <why>, where <reason> is one of: needs_user (only the user can decide; <why> is the question), too_hard (you tried and cannot solve it; a stronger model should), provider_error (your model, tools or sandbox failed), no_access (you cannot reach what you need: the running app, a service, credentials), check_broken (the check cannot pass for a reason outside your task; name each failing file:line), out_of_scope (the task needs changes outside the files you own).
```

- [ ] **Step 4: Attach `BLOCKED_LINE`** right after the STATUS sentence in `STATUS_LINE` and in the worker's STATUS sentence, separated by one space, so every `CONTRACTS` entry carries it once.
- [ ] **Step 5:** the Step 2 command passes; also `bun test test/domain/agents.test.ts test/skills.test.ts` (native bodies carry the same constants).
- [ ] **Step 6: Commit** `feat(roles): a blocked reply names one of six reasons`.

### Task 2: one action hint per stop

**Files:**
- Create: `src/services/stops.ts`, `test/services/stops.test.ts`
- Modify: `src/domain/hints.ts:4` (signature), `:21` (the `climb:` line)
- Modify: `src/services/dispatches.ts:203-205` (`recordHints`), its callers `src/services/dispatch-service.ts:541,601,656,817` and `src/services/run-service.ts:259,261`
- Modify: `test/domain/run-rules.test.ts` (the `dispatchHints` cases)

**Interfaces:**
- Consumes: Task 1's `parseBlockedReason`, `REASON_ACTION`, `foreignFailure`, `BlockedReason`.
- Produces (`src/services/stops.ts`):
  - `export interface Stop { reason: BlockedReason; source: "reply" | "jev"; why: string; foreign: string[] }`
  - `export function stopOf(run: Run, r: RunRecord): Stop | null` — null when `r.environment` is set or `r.status` is `limit`/`cancelled`/`cli-too-old`; from the reply when `r.replyStatus` is `blocked` and `parseBlockedReason(r.replyWhy)` reads one; else from `stop.json` beside the reply (`dirname(join(run.dir, r.replyPath))`, Task 4; absent until then, so `null`). `foreign` is non-empty only for `check_broken` on a lane record: `foreignFailure(<reply text>, <lane's Owns>, <Owns of the other lanes/<M>.*.md>)`, lane files read with `parseLaneHeader` (an unreadable file contributes nothing).
  - `export function stopStreak(run: Run, r: RunRecord, records: RunRecord[]): number` — how many records of `r`'s lane (or, laneless, `r.name`), newest first and ending with `r`, have the same `stopOf(...).reason`; 0 when `r` has none.
  - `export function stopHint(run: Run, r: RunRecord, standIn: string | null): string | null` — the one hint below, or null.
  - `recordHints(run: Run, d: Dispatch, r: RunRecord, standIn: string | null = null): string[]`, and `dispatchHints(r: RunRecord, owns: string[], dir: string, stop: string | null = null): string[]`: when `stop` is given it is pushed instead of `climb: <replyStatus>`; everything else unchanged.
  - `recordHints` computes the hint with `stopHint(run, r, standIn)`. `settle` (`dispatch-service.ts:541`), `cancel` (`:817`) and `result` (`run-service.ts:259,261`) pass `standIn = standInFor(runProfile(deps, run).failover, r.rung, run.meta.repo)` (`src/services/backends.ts:77`, `src/services/run-pin.ts:69`); the failover paths (`:601`, `:656`) handle `limit` records, which have no stop, and keep the default.

The hints, exact text (`<M>` is `r.lane`'s milestone, else `milestoneOfName(r.name)` from `src/services/verifier-brief.ts:11`; `park(run, "<M>", …)` falls back to `park its milestone` when there is none; `<why>` is the stop's why, else `r.replyWhy`):

| Stop | Hint |
| --- | --- |
| `too_hard` | `climb: blocked (too_hard)` |
| `needs_user`, `no_access` | `park: <reason> — park(run, "<M>", "<why>")` |
| `out_of_scope` | `park: out_of_scope — park(run, "<M>", "<why>"), or owns_add when the architect agrees the lane needs the file` |
| `provider_error`, streak 1 | `retry: provider_error — dispatch <name> again at <rung>, same brief, once` |
| `provider_error`, streak ≥ 2 | `failover: provider_error twice on <rung> — dispatch <name> at <standIn>`, or with no stand-in `park: provider_error twice on <rung>, no stand-in — park(run, "<M>", "<why>")` |
| `check_broken`, foreign | `done: <lane>'s check fails only in other lanes' files (<files, comma-separated>); the milestone's gate backstops it` |
| `check_broken`, verifier, streak 1 | `retry: check_broken — a fresh <name> once more before anyone is asked` |
| `check_broken`, lane, streak 1 | `wait: check_broken — dispatch <lane> again at <rung> once its running siblings finish (protocol.next says when)` |
| `check_broken`, streak ≥ 2, or laneless non-verifier | `park: check_broken — park(run, "<M>", "<why>")` |
| a Jev stop | the same hint with ` (Jev)` after the reason word, e.g. `park: needs_user (Jev) — …` |

- [ ] **Step 1: Write the failing tests** in `test/services/stops.test.ts` (setup: `freshRun`, `writeLane`, `fakeDispatch` with `files.reply`, `appendRecord(makeRecord({ dispatchId, replyStatus, replyWhy, replyPath }))`):
  - "maps each reason to its action hint": `needs_user` → hint starts `park: needs_user — park(run, "M1", "keep v1?")`; `too_hard` → `climb: blocked (too_hard)`; `out_of_scope` → starts `park: out_of_scope`.
  - "retries a provider_error once, then fails over to the stand-in": first record → `retry: provider_error — dispatch worker-M1.L1 again at codex:gpt-6-sol#medium, same brief, once`; a second record of the same lane → `failover: provider_error twice on codex:gpt-6-sol#medium — dispatch worker-M1.L1 at <standIn>` (pass a stand-in); with `null` → starts `park: provider_error twice`.
  - "calls a check_broken lane done only when every named file is a sibling's": lanes `M1.L1` (`src/a.ts`), `M1.L2` (`src/b.ts`); reply `src/b.ts:3 unused import\n\nSTATUS: blocked — check_broken: lint fails in src/b.ts` → `stopOf(...).foreign` `["src/b.ts"]` and hint `done: M1.L1's check fails only in other lanes' files (src/b.ts); the milestone's gate backstops it`; a reply naming `src/a.ts:1` too → `foreign: []` and the `wait:` hint.
  - "reruns a verifier's first check_broken, parks the second": `verifier-M1` records → `retry: check_broken — a fresh verifier-M1 once more before anyone is asked`, then `park: check_broken — park(run, "M1", …)`.
  - "leaves an ENV: stop to plan 23's environment hint": record with `environment: "no Docker"` and `replyWhy: "check_broken: …"` → `stopOf` null; `recordHints` contains `environment: no Docker` and no `park:`/`wait:`.
  - "keeps 1.5's hint for a blocked reply with no reason": `replyWhy: "the tests fail"` → `recordHints` equals 1.5's list (contains `climb: blocked`, nothing else new).
- [ ] **Step 2:** `bun test test/services/stops.test.ts test/domain/run-rules.test.ts` — FAIL.
- [ ] **Step 3: Implement** `stops.ts`, the `dispatchHints` parameter and the `recordHints` parameter; thread `standIn` through the callers named above.
- [ ] **Step 4:** the Step 2 command passes; `bun test test/services/dispatch.test.ts test/services/failover-cancel.test.ts` still pass.
- [ ] **Step 5: Commit** `feat(hints): each blocked reason gets its action`.

### Task 3: a finding survives a fix only when a fix ran between reviews

**Files:**
- Modify: `src/services/milestones.ts:100-112` (`FINDING`, `countFindings`), `:114-142` (`openFindings`); consumes plan 28's `src/domain/fix-brief.ts` `findingBlocks`
- Modify: `src/services/protocol.ts:175-178` (the fix-round step), `:205-214` (`findingLines`)
- Test: `test/services/protocol.test.ts`

**Interfaces:**
- Produces (`src/services/milestones.ts`):
  - `export const findingKey = (block: string): string` — t3herd `src/step.ts:202-211`, verbatim, over one of plan 28's `findingBlocks` (its newlines fold into spaces like any other non-word run).
  - `export function isFinding(line: string): "BLOCKER" | "BUG" | "NIT" | null` — `FINDING`'s label, or null when the text after it (and an optional `:` or `—`) is `none`, `n/a` or `-`, case-insensitive; `countFindings` and `protocol.ts`'s `findingLines` use it.
  - `export function survivingFindings(run: Run, m: string, start?: string | null): string[]` — the `findingBlocks` (first line each, `isFinding` not null) of the latest full headless review of `m` whose `findingKey` is among the previous full headless review's keys, when a fix (`FIX_ROLES` record or native run of `m`, ended ok) ended between the two reviews; `[]` otherwise. Reviews are `reviewerAttempts(...).filter(!partial)` with a record.
- `protocolNext`'s fix-round line, when `survivingFindings` is non-empty: `${m}: fix round for ${name}'s findings (${b} BLOCKER, ${u} BUG); ${n} survived the last fix: climb their lanes first (same-defect), then the verifier`; otherwise unchanged.

- [ ] **Step 1: Write the failing tests** in `test/services/protocol.test.ts`:
  - "does not count BLOCKER: none or BUG: n/a as a finding": a reviewer reply of `BLOCKER: none\nBUG: n/a\nNIT src/a.ts:1 — x\n\nSTATUS: complete — ok` → `protocolNext` says `M1: verifier` (no fix round).
  - "keys a finding by file and words, not its line": `findingKey("- BUG src/a.ts:12 — off by one in the loop")` equals `findingKey("BUG src/a.ts:40-41 — Off by one in the loop!")`, differs from `findingKey("BUG src/b.ts:1 — off by one in the loop")`.
  - "lets a finding survive only when a fix ended between the two reviews": review 1 with `BUG src/a.ts:3 — off by one`; a `worker-M1.L1` record ended ok after it; review 2 with `BUG src/a.ts:9 — off by one` → `survivingFindings(run, "M1")` has that line and `protocolNext` contains `1 survived the last fix`; the same two reviews with no fix between → `[]` and the 1.5 line.
- [ ] **Step 2:** `bun test test/services/protocol.test.ts` — FAIL.
- [ ] **Step 3: Implement** `findingKey`, `isFinding` (used by `countFindings` and `findingLines`), `survivingFindings`, and the `protocolNext` line.
- [ ] **Step 4:** `bun test test/services/protocol.test.ts test/services/land-gate.test.ts` pass.
- [ ] **Step 5: Commit** `feat(review): a finding survives only a fix that ran, matched by key`.

### Task 4: Jev classifies a stop that gives no reason

**Files:**
- Modify: `catalog/jev.json` (add the `stop` set), `src/domain/jev.ts:37-54` (`JevFileSchema.sets`, `VERDICT_OPTIONS`)
- Modify: `src/services/ports.ts:134-152` (`RoutingPort`), `src/services/routing-service.ts:249-306` (`verdict`'s set type, `routingService`)
- Modify: `src/infra/dispatch-dir.ts:21-46` (`dispatchPaths.stop`), `src/services/stops.ts` (`stopOf` reads it; `classifyStop`), `src/services/dispatch-service.ts:540-542` (`settle`)
- Modify: `test/services/helpers.ts:89-125` (`fakeDeps` routing gets `stopCause`), `test/domain/jev.test.ts:271` (the verdict-set loop)
- Test: `test/services/stops.test.ts`

**Interfaces:**
- Consumes: Task 2's `Stop`, `stopOf`, `stopHint`; `BLOCKED_REASONS`.
- Produces:
  - `catalog/jev.json` `sets.stop`, after `same-defect`:

```json
"stop": {
  "questions": {
    "stop": {
      "type": "choice",
      "instructions": "An agent stopped before finishing its task. `status` is how its process ended and `reply` is the end of its last message. Why did it stop?",
      "criteria": {
        "needs_user": "The agent needs a decision, a credential or a fact that only the project owner can give",
        "too_hard": "The agent worked on the task but could not make the change work, or could not understand the code well enough",
        "provider_error": "The model, its tools or its sandbox failed: an API, network, overload, timeout or crash error, with no judgement about the work",
        "no_access": "The agent could not reach something it needs: a running app, a service, a host or credentials",
        "check_broken": "The agent's check, tests or lint cannot pass for a reason outside its task",
        "out_of_scope": "The task needs changes outside the files the agent may change",
        "other": "None of the above"
      }
    }
  },
  "rule": { "min": 0.8, "fallback": "other" }
}
```

  - `VERDICT_OPTIONS.stop = [...BLOCKED_REASONS, "other"] as const`; `JevFileSchema.sets.stop` like `finding`.
  - `RoutingPort.stopCause(runDir: string, status: string, reply: string, use: "auto" | "off"): Promise<Verdict<BlockedReason | "other">>` — state `{ status, reply: scrubFree(reply.slice(-4000)) }`, through `verdict(runDir, "stop", …)`.
  - `dispatchPaths(dir).stop = join(dir, "stop.json")`; file `{ schema: 1, at: string, reason: BlockedReason, probability: number }`.
  - `export function unexplainedStop(r: RunRecord): boolean` (Ruling 7) and `export async function classifyStop(deps: Deps, run: Run, d: Dispatch, r: RunRecord): Promise<void>` in `stops.ts`: returns at once unless `unexplainedStop(r)`, `stop.json` is absent and `runProfile(deps, run).jev.use !== "off"`; writes `stop.json` only for `source: "jev"` and a value other than `other`; never throws (a Jev error is logged, as `verdict` already logs).
  - `settle` calls `await classifyStop(deps, run, d, record)` first, before `recordHints`, for every record that is not a `limit`.
  - `stopOf` reads `stop.json` (`readVersioned`, schema 1; an unreadable file is none) when the reply gives no reason, with `source: "jev"`.

- [ ] **Step 1: Write the failing tests:**
  - `test/domain/jev.test.ts`: the "falls back, in each verdict set…" loop runs over `["finding", "same-defect", "stop"]`.
  - `test/services/stops.test.ts` "classifies a stop with no reason through Jev, once": `fakeDeps()` with `routing.stopCause` returning `{ value: "needs_user", probability: 0.91, confidence: 0.5, source: "jev" }` (counting calls); a record `replyStatus: null`, `status: "ok"`; `classifyStop` twice → one call, `stop.json` reason `needs_user`; `recordHints` contains a hint starting `park: needs_user (Jev) — `.
  - "asks nothing and writes nothing with Jev off": the view's `jev.use` set to `"off"` → zero `stopCause` calls, no `stop.json`, hints as in 1.5.
  - "never asks Jev about a reply that gave its reason, a limit or an ENV: stop": `replyWhy: "too_hard: …"`, a `limit` record, an `environment` record → zero calls.
  - "keeps a Jev answer of other, or an unsure one, out of the record": `value: "other"` or `source: "default"` → no `stop.json`.
- [ ] **Step 2:** `bun test test/domain/jev.test.ts test/services/stops.test.ts` — FAIL.
- [ ] **Step 3: Implement** the catalog set, schema, port method (fake: `{ value: "other", probability: null, confidence: null, source: "default" }`), `dispatchPaths.stop`, `unexplainedStop`, `classifyStop`, the `stopOf` read and the `settle` call.
- [ ] **Step 4:** the Step 2 command passes; `bun test test/services/routing-service.test.ts test/services/dispatch.test.ts test/services/failover-cancel.test.ts` still pass.
- [ ] **Step 5: Commit** `feat(jev): classify a stop that names no reason`.

### Task 5: protocol.next holds, retries and parks by reason

**Files:**
- Modify: `src/services/protocol.ts:53-103` (`LaneEvidence`, `laneDone`), `:130-190` (`protocolNext`)
- Modify: `src/services/milestones.ts` (add `verifierBrokenStreak`)
- Test: `test/services/protocol.test.ts`

**Interfaces:**
- Consumes: Task 2's `stopOf`, `stopStreak`; `REASON_ACTION`.
- Produces:
  - `laneDone`: a try also counts ok when its record's `stopOf(...)` is `check_broken` with a non-empty `foreign`.
  - `function lastTry(lane: string, e: LaneEvidence): { at: number; ok: boolean; record: RunRecord | null } | null` in `protocol.ts` (the latest try `laneDone` already selects; `laneDone` becomes `lastTry(...)?.ok ?? false`). `LaneEvidence` gains `run: Run`.
  - `export function verifierBrokenStreak(run: Run, m: string, start?: string | null): number` in `milestones.ts` — the trailing run of headless `verifier-<m>` records since `start` whose `stopOf` reason is `check_broken`.
  - In `protocolNext`, over `waiting` (before `ready` is returned), by the latest try's stop:
    - `park` action, or `check_broken` with `stopStreak ≥ 2` → collected as `toPark`; when nothing is ready or running: `${m}: ${lane} stopped ${reason}: park ${m} with its question` (lanes joined by `, `).
    - `check_broken` with streak 1 → held while a sibling of `m` is live or untried (no try since its latest climb); held lanes join `order` as `${lane} after ${siblings} (check_broken)`; not held → in `ready` (its one retry).
  - After `verdict` is read and before `!verdict.passed`: `verifierBrokenStreak` 1 → `${m}: ${verdict.name} stopped check_broken: run a fresh verifier once more before anyone is asked`; ≥ 2 → `${m}: ${verdict.name} stopped check_broken twice: park ${m} for the owner`.

- [ ] **Step 1: Write the failing tests** in `test/services/protocol.test.ts` (lanes `M1.L1` `src/a.ts`, `M1.L2` `src/b.ts`, both routed):
  - "counts a lane whose check fails only in a sibling's files as done": `M1.L1` record blocked `check_broken` naming `src/b.ts:3`; `M1.L2` done → `protocolNext` is `M1: reviewer`.
  - "holds a check_broken lane while a sibling runs": `M1.L1` blocked `check_broken` naming `src/a.ts:1`; `M1.L2` live (`fakeDispatch` with `proc: "self"`) → `M1: lanes running (worker-M1.L2); then M1.L1 after M1.L2 (check_broken)`.
  - "retries a check_broken lane at once when its siblings stopped, and parks it after a second check_broken": `M1.L2`'s latest record is blocked `needs_user` (tried and stopped, so it holds nobody); `M1.L1` has one `check_broken` naming `src/a.ts:1` → `protocolNext` is `dispatch M1.L1` (its retry; `M1.L2` is not offered for dispatch). After a second `M1.L1` `check_broken` → `M1: M1.L1 stopped check_broken, M1.L2 stopped needs_user: park M1 with its question`.
  - "reruns a verifier's first check_broken before anyone is asked": reviewer passed; a headless `verifier-M1` record blocked `check_broken` → `M1: verifier-M1 stopped check_broken: run a fresh verifier once more before anyone is asked`; a second → `…twice: park M1 for the owner`.
  - "keeps plan 23's environment verdict ahead of check_broken": a verifier record whose reply opens `VERDICT: BLOCKED: environment — curl …` and ends `STATUS: blocked — check_broken: …` → the 1.5 `blocked by the environment` line.
- [ ] **Step 2:** `bun test test/services/protocol.test.ts` — FAIL.
- [ ] **Step 3: Implement** `lastTry`, the `laneDone` change, `verifierBrokenStreak` and the `protocolNext` branches. Keep the order of the existing returns; the new park line comes after `spent`, before `running`.
- [ ] **Step 4:** `bun test test/services/protocol.test.ts test/services/land-gate.test.ts test/services/dispatch-protocol.test.ts` pass.
- [ ] **Step 5: Commit** `feat(protocol): hold, retry or park a stopped lane by its reason`.

### Task 6: an answer re-runs the stopped units

**Files:**
- Modify: `src/infra/dispatch-dir.ts:21-46` (`dispatchPaths.briefIn`), `src/services/admission.ts:336-349` (write it)
- Modify: `src/services/questions.ts:90-117` (`answer`), `src/entry/mcp/protocol-tools.ts:54-62` (the tool description)
- Test: `test/services/questions.test.ts`

**Interfaces:**
- Consumes: Task 2's `stopOf`; `listDispatches`, `liveDispatches`, `readRecords`, `readRoutes`, `milestoneOfName`.
- Produces:
  - `dispatchPaths(dir).briefIn = join(dir, "brief-in.md")`; admission writes `i.brief` there with `writeTextAtomic` right before `brief.md`.
  - `export interface Rerun { role: Role; name: string; lane: string | null; rung: string; brief: string }` in `questions.ts`.
  - `answer(...)` returns `{ milestone: string; parked: string[]; rerun: Rerun[]; hints?: string[] }`. `rerun` follows Ruling 13; `brief` is `${briefIn.trimEnd()}\n\nThe owner answered: ${answer}`. A stopped dispatch with no `brief-in.md` adds the hint `${name}: admitted before 1.6, no brief to re-run: dispatch it by hand with the answer`. With any rerun, one hint: `re-run each at its rung, on a fresh thread: dispatch(run, role, name, brief, lane, rung) with rerun[i]`.
  - The `answer` tool description adds: "Returns rerun: the milestone's stopped units, each ready for dispatch on its old rung with its old brief and the answer."

- [ ] **Step 1: Write the failing tests** in `test/services/questions.test.ts`:
  - "hands back a blocked lane for a re-run on its rung, with its brief and the answer": a dispatch `worker-M1.L1` at `codex:gpt-6-sol#medium` with `brief-in.md` `Do L1.` and a record blocked `needs_user: keep v1?`; `park` then `answer(…, "yes")` → `rerun` equals `[{ role: "worker", name: "worker-M1.L1", lane: "M1.L1", rung: "codex:gpt-6-sol#medium", brief: "Do L1.\n\nThe owner answered: yes" }]`.
  - "re-runs a lane that stopped at its ceiling after a failed check": the lane's latest route row is a climb with `from === rung`, its latest record `complete` → it is in `rerun`.
  - "re-runs only stopped units: not a live one, not a verdict": a live `worker-M1.L2` (`proc: "self"`), a `verifier-M1` record `complete` with `VERDICT: FAIL`, and a `limit` record → none in `rerun`.
  - "admission keeps the orchestrator's brief as it was given": `runRole` (helpers) with brief `B` → `brief-in.md` is `B` and `brief.md` still ends with the reply contract.
- [ ] **Step 2:** `bun test test/services/questions.test.ts` — FAIL.
- [ ] **Step 3: Implement** `briefIn`, the admission write, `Rerun`, the `rerun` list and hints, and the tool description.
- [ ] **Step 4:** `bun test test/services/questions.test.ts test/services/dispatch.test.ts` pass.
- [ ] **Step 5: Commit** `feat(questions): an answer hands back the stopped units to re-run`.

### Task 7: the skill and the backlog

**Files:**
- Modify: `plugin/skills/catherd/SKILL.md` (`:59` the `park`/`answer` tool row, `:167-175` the climb table and list, `:254` owner questions, `:292-296` step 5's per-result bullets, `:301-303` step 8, `:304-312` step 9)
- Modify: `docs/dev/ideas.md:60-62` (remove "BLOCKER: none counts as an open blocker", closed by Task 3)

- [ ] **Step 1: Skill text.** Add, in the per-result bullet list of step 5: "A blocked reply names its reason (`STATUS: blocked — <reason>: <why>`), and its hint is the action: `climb: blocked (too_hard)` climbs; `retry:` dispatches it again on the same rung once; `failover:` dispatches it at the named stand-in; `park:` parks the milestone with that question; `wait:` dispatches it again once `protocol.next` says so; `done:` means its check fails only in other lanes' files: the lane is done and the milestone's gate decides. With Jev on, a stop that gave no reason gets the same hints marked `(Jev)`. A native role's blocked reply: apply the same map yourself." In the climb list, the `blocked` refusal line names `too_hard` only. In step 8: "`protocol.next` names the findings that survived a fix (same file and words after a fix ran): climb their lanes without asking `same-defect`; ask it only for a reworded line." In step 9: "A verifier that stops `check_broken` (load, a port, a lock) runs once more, fresh, before the owner hears of it; a second one parks the milestone." In the `answer` row and the parked-milestone text: "`answer` returns `rerun`: dispatch each as given."
- [ ] **Step 2:** `bun test test/skills.test.ts test/plugin.test.ts` pass (fix any row assertion the text change breaks, keeping its intent).
- [ ] **Step 3: Remove** the ideas.md entry named above.
- [ ] **Step 4: Commit** `docs(skill): blocked reasons, their actions and answer re-runs`.

### Task 8: the changeset

**Files:**
- Create: `.changeset/blocked-recovery.md`

- [ ] **Step 1: Write it:**

```md
---
"catherd-cli": minor
---

A blocked reply names one of six reasons (needs_user, too_hard, provider_error, no_access, check_broken, out_of_scope), and each record's hints say what to do about it: climb, retry and fail over, park for the owner, or wait. With Jev on, a stop that gives no reason is classified into the same reasons. A lane whose check fails only in another lane's files counts as done; a check_broken lane waits for its running siblings and retries once; a verifier's first check_broken reruns before the owner is asked. `answer` returns the milestone's stopped units, ready to re-run on their rung with the answer. A review finding survives a fix only when a fix ran between the reviews, matched by file and words; "BLOCKER: none" is no finding.
```

- [ ] **Step 2:** `bun run format:check` passes.
- [ ] **Step 3: Commit** `chore: changeset for blocked reasons and recovery`.
