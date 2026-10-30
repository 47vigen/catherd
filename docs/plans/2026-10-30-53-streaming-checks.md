# Plan 53: streaming fast checks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec D6 on stage 2: every task's fast check runs by itself the moment the task ends complete, nothing
waits on it, its result wakes the architect and a red one reaches the other writers; the architect runs one full
check on the integrated product instead of a serial chain of them, and the metrics show how long a run waited on
checks.

**Architecture:** The fast check is named per task (`delegate_task {check}`) or comes from the profile's new
`fastCheck` for a worker, and is recorded on `task.delegated`. When the daemon writes a task's `dispatch.ended`
(`ok/complete`), it appends a `check.requested` (`by: "catherd"`, `task`) in the same events-lock write; the machine
runs it as any check, `check.done` wakes the architect with "C4 (fast check of T3) …", and a red one is posted on
the team channel. The architect's contract moves the full check to the end. Two new metrics, `fastCheckShare` and
`checkWaitShare`, measure stage 2 against stage 1.

**Tech Stack:** Bun ≥ 1.4, TypeScript, `bun:sqlite`, zod, `bun:test`; `web/` only for the regenerated OpenAPI types.

**Spec:** `docs/specs/2026-10-27-architect-led-runs-design.md` ("### Checks", D6; "## Migration" item 17, stage 2;
D3's tool table; D5 for what stays out).

**Pre-validated:** every task was built test-first in `.superpowers/plan53-scratch`; the scratch commits are on this
branch after this plan, one per task, in task order.

**Evidence (real scorecard runs on a Linux host, after plan 52):** checks were 63% and 60% of wall time on two
catherd-findings runs (30 and 22 min). Each full gate took about 6.5 min, and the architect ran three in a row (the
base, after the change, after a one-line fix), idle on each. On a third scorecard task (58 and 94 min), checks were about
30%.

## What D6 already has on `main`, and the gap

| D6 line | On `main` (d6437eb) | This plan |
|---|---|---|
| One full check, only when the architect calls it; `land {final}` refuses without a green full check on the exact sha | `check` tool, `greenFull` in `land.ts` (plans 47, 50) | prompt only (R7) |
| No automatic rerun of a red check | `milestone-check.ts` deleted (plan 48) | — |
| Baseline only on demand, pre-existing marked | plan 52 R5 runs the base on a failing full check (owner brief) | kept (R10) |
| No acceptance milestone; the verifier reads the full check | plans 48, 50 | — |
| **Fast check per task, as it finishes; nothing waits on it** | missing: a check runs only when the architect asks | Tasks 1 and 3 |
| Check minutes measured apart (plan 51: "fast-check minutes as their own metric", stage 2) | `checkShare` only | Task 2 |

## Global Constraints

- Layers `domain → infra → adapters → services → entry` (`test/architecture.test.ts`).
- Tests never wall-clock sleep for correctness; spawned processes get an explicit `env` with `ANTHROPIC_API_KEY: ""`.
- No personal hosts or infrastructure names in the repo; evidence is "a real scorecard run".
- Fewer code comments: one line for a why the code cannot show.
- Commits: conventional, subject ≤ 100 characters, lower-case first word, ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The gate: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test`;
  Tasks 1 and 2 touch `web/` (regenerated OpenAPI only), so also the panel's gate in `web/`:
  `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun run test`.
- `web/openapi.json` is regenerated with `bun run panel:openapi`, `web/src/client/types.gen.ts` with `cd web && bun run
  gen`; never edited by hand (`test/entry/panel-openapi.test.ts` compares the first).
- Known env-only failures on a Mac: the Codex-only doctor timeout, a timing test in `preflight.test.ts`, and a load
  flake in `plan-input.test.ts` (rerun it alone).
- Old runs replay unchanged: every new event field is optional (`task.delegated.check`, `check.requested.task`).

## Rulings

- **R1 — the fast check runs on the run's tree, when the task ends.** D6 says "in the task's tree at merge time";
  the task's own tree and the merge are D5, which is not built (stage 1 is one tree per run). So the check runs where
  `runArchitectCheck` runs every check today: the run's tree as it stands, under a heavy slot. — It is the only tree a
  task's work is in. — Cost if wrong: another task's half-written work can turn a fast check red; the architect
  judges it (R6), and D5 later moves the check into the task's tree.
- **R2 — "the lane's" check is the task's `check`.** Architect tasks have no lane (`lane: null`), so
  `delegate_task {check?}` is the per-task override D6 means; the profile's `fastCheck` is the default for a
  **worker** task only. An artist or writer task gets one only when the architect names it; a reviewer, verifier or
  researcher task is refused one (`E_INPUT_INVALID`: they change nothing). — A profile's code check fits code tasks;
  docs and reads would only burn a slot. — Cost if wrong: an artist task without `check` goes unchecked until the
  full check.
- **R3 — resolved once, at delegation.** The effective command is recorded on `task.delegated.check` (trimmed; a
  blank one is none); a profile edit mid-run affects later tasks only, as `caps` are pinned. A follow-up through
  `thread_send` to a finished task inherits it. — One place, replayable, no profile read at the task's end. — Cost if
  wrong: an owner who sets `fastCheck` mid-run sees it on new tasks only.
- **R4 — catherd asks for it in the same write as the task's end.** `settle` appends `dispatch.ended` and, under
  the same events lock, `check.requested {checkId: nextCheckId, command, scope: "fast", base: false, fresh: false,
  by: "catherd", why: "<task> ended complete: its fast check", task}`; the pure `fastCheckFor` decides. Only an
  `ok/complete` end of a `working` task, and never while the run is cancelling, finishing or ended. The machine runs
  it as any queued check. — An event keeps the check ids (`C<n>`), the panel graph's check node and the reducer
  unchanged (D4: the daemon "runs a check"); the same lock gives two tasks that end at once two ids. — Cost if wrong:
  a `partial` reply gets no fast check; the architect can ask for one.
- **R5 — nothing waits on it.** The task's end still wakes the architect at once, and `check.done` wakes it again
  (it already does). — D6: "No other task waits on it"; the architect may start dependent work before the result. —
  Cost if wrong: up to two architect turns per task, most of them batched into one digest.
- **R6 — a red fast check reaches the writers on the team channel, and the architect decides.** One `notice`
  from `catherd` to `all`, `mode: "queue"` (never steered): `the fast check of T3 (\`<command>\`) failed on the run's
  tree (exit N|timeout): <up to 3 failing lines>; log <path>`. A failed send is logged and never fails the check.
  catherd does not resume the writer's thread: D5's "a red fast check goes back to the same writer's thread" is a
  merge-time rule on the writer's own tree; on the shared tree the failure may be a sibling's. — The architect has
  `thread_send` for that. — Cost if wrong: one architect turn between a red check and the fix.
- **R7 — fewer serial full gates through the contract, not a mechanism.** The architect's `check` line and the
  tool description say: fast checks stream by themselves; call `check {scope: "full"}` once, on the integrated
  product before land final (or before a large replan), never to learn whether one task's change works; start it
  when no writer runs (a tree that changes while it runs proves nothing); do not ask for the base up front (plan 52
  runs it on a failing full check). The daemon still never schedules a full check (D6). — It answers the measured
  chain (base, change, one-line fix): the base is no longer asked, and the fast check catches the failure before the
  full one. — Cost if wrong: an architect still calls full mid-run; `checkWaitShare` shows it per run.
- **R8 — no `check {ref}`.** D3 lists `ref`; a check on a commit in its own tree belongs with D5's trees (plan 50
  deferred it there). — Without it the rule in R7 (no writer running) is what keeps a full check valid. — Cost if
  wrong: a full check started while a writer runs is wasted; in `ideas.md`.
- **R9 — two metrics, `checkShare` unchanged.** `fastCheckShare` (fast-check minutes over the wall) and
  `checkWaitShare` (wall minutes a check ran with no role running and no pause, over the wall), both from the
  `checks` rows' `at` and `minutes` (cached passes left out). Both are `nullable().optional()` in
  `RunMetricsSchema`, so a stage-1 scorecard file still reads; the stage comparison shows the median check wait
  (`null` for a stage-1 run). `checkShare` keeps its stage-1 meaning so the stages compare. The panel gets the
  regenerated types and no new view. — Overlapped fast checks raise check minutes while they cut wall time; only
  the wait says whether checks still block. — Cost if wrong: a check's span starts at its request, so a long slot
  wait counts as check time.
- **R10 — the base stays plan 52's.** A fast check never runs the base and gets no verdict; it still marks lines a
  base row of the same command already has as pre-existing. — D6's "baseline only on demand", as plan 52 left it. —
  Cost if wrong: none new.
- **R11 — the profile key.** `fastCheck` in the profile file, set with `catherd profile set fastCheck "<command>"`,
  removed with `null`; absent means none, so no migration. It is in the profile patch schema, so the panel's
  OpenAPI document changes. — D6 names "the profile's `fastCheck`". — Cost if wrong: none; a repo bound to a shared
  profile gets one command for all its repos, so the architect's `check` is the main path (R2).

## Review Focus

- **Two tasks that end at once** — two fast checks with distinct ids, each requested right after its own
  `dispatch.ended`. (Task 3 effects test.)
- **A task that ends while the run is cancelling or finishing, or that was cancelled** — no fast check. (Task 3
  domain test.)
- **A follow-up on a finished task's thread** — it inherits the task's check. (Task 1 tools test.)
- **A run an earlier build wrote** (`task.delegated` without `check`, `check.requested` without `task`) — replays
  as before: `check` is null, the digest has no "check of". (The existing machine and tools tests run without the
  fields.) Reviewer: confirm `fastCheckFor` on such a run returns null.
- **A fast check whose command cannot run (exit 127) or times out** — the result still lands and wakes the
  architect, the team notice says `exit timeout`, and a team write that throws never fails the `runCheck` effect.
  Reviewer: confirm the `catch` in `run-effects.ts`.

## Parallelism

Wave 1: Tasks 1 and 2 (independent; both regenerate `web/openapi.json` and `types.gen.ts`: after both land, run
`bun run panel:openapi` and `cd web && bun run gen` once; the merge was clean in the scratch). Wave 2: Task 3 (it reads
`ArchTask.check` from Task 1). Gate once per wave.

---

### Task 1: a task's fast check, named by the architect or the profile's for a worker

**Files:**
- Modify: `src/domain/profile.ts` (`ProfileDocSchema`, `Profile`, `resolveProfile`, `ProfilePatchSchema`),
  `src/services/ports.ts` (`ProfileView`), `src/services/profile-service.ts` (`viewOf`), `src/domain/run-events.ts`
  (`task.delegated`), `src/domain/architect-state.ts` (`ArchTask`, the `task.delegated` case),
  `src/services/architect-tools.ts` (`delegate`, `delegate_task`'s shape, `thread_send`'s resume),
  `src/services/architect-run.ts` (`taskBrief`), `web/openapi.json`, `web/src/client/types.gen.ts` (regenerated)
- Test: `test/domain/profile.test.ts`, `test/services/profile-service.test.ts`,
  `test/services/architect-tools.test.ts`, `test/services/architect-run.test.ts`

**Interfaces:**
- Produces: `ProfileDoc.fastCheck?: string`; `Profile.fastCheck?: string` (trimmed, absent when blank);
  `ProfilePatch.fastCheck?: string | null` (`z.string().trim().min(1).nullable().optional()`);
  `ProfileView.fastCheck?: string`; `task.delegated.check?: string`; `ArchTask.check: string | null`;
  `delegate_task {…, check?: string}`.

- [ ] **Step 1: Write the failing tests**

`profile.test.ts`, in `describe("resolveProfile")`, "reads the profile's fast check trimmed, and a blank one as none
(plan 53)": `resolveProfile({ schema: 1, fastCheck: " bun run lint " }, "f", "claude-code").fastCheck` is
`"bun run lint"`; `" "` and no key give `undefined`; `patchAt("fastCheck", "bun run lint && bun test")` is
`{ fastCheck: "bun run lint && bun test" }`.

`profile-service.test.ts`, before "gives the view its memory limits…", "sets the profile's fast check, gives it to
the view, and removes it with null (plan 53)": with `withHome()` and `profileService(...)`, `forRepo(null).fastCheck`
is `undefined`; after `set(undefined, { fastCheck: " bun run lint " })` it is `"bun run lint"`; it survives
`set(undefined, { caps: { attempts: 3 } })`; after `set(undefined, { fastCheck: null })` it is `undefined`.

`architect-tools.test.ts`, before "thread_wait returns…":

```ts
it("delegate_task records a task's fast check, the profile's for a worker without one, and none for a reader (plan 53)", async () => {
  const run = await architectRun();
  const checkOf = async (args: object) => {
    await call(run, "delegate_task", { task: "x", why: "w", ...args });
    return (last(run) as { check?: string }).check;
  };
  view.fastCheck = "bun run lint";
  try {
    expect(await checkOf({ role: "worker", check: " bun test test/a.test.ts " })).toBe("bun test test/a.test.ts");
    expect(await checkOf({ role: "worker" })).toBe("bun run lint");
    expect(await checkOf({ role: "writer" })).toBeUndefined();
    expect(await checkOf({ role: "writer", check: "bun run format:check" })).toBe("bun run format:check");
    await expect(checkOf({ role: "researcher", check: "bun test" })).rejects.toMatchObject({ code: "E_INPUT_INVALID" });
  } finally {
    delete view.fastCheck;
  }
  expect(replayRun(run).arch?.tasks.T1?.check).toBe("bun test test/a.test.ts");
  expect(replayRun(run).arch?.tasks.T3?.check).toBeNull();
  const log = makeLog();
  endDispatch(log, startDispatch(log, { name: "T1", unit: "T1" }), { name: "T1", unit: "T1", thread: "th-1" });
  for (const { v: _v, seq: _s, at: _a, ...e } of log.events) await appendEvent(run, e as never);
  // a follow-up on a finished task's thread checks the same work
  expect(await call(run, "thread_send", { to: "T1", text: "and the refund path?", why: "w" })).toMatchObject({ taskId: "T5" });
  expect(replayRun(run).arch?.tasks.T5?.check).toBe("bun test test/a.test.ts");
});
```

`architect-run.test.ts`, new `describe("a task's fast check in its brief (plan 53)")`, "names the check catherd runs
when the task ends complete, and nothing without one": two worker `task.delegated` (T1 with
`check: "bun test test/a.test.ts"`, T2 without); `taskBrief(...).round.join("\n")` of T1 contains
``Your fast check: `bun test test/a.test.ts`. catherd runs it on the run's tree when you end complete``; T2's does not
contain `fast check`.

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test test/domain/profile.test.ts test/services/profile-service.test.ts test/services/architect-tools.test.ts test/services/architect-run.test.ts`
Expected: 4 FAIL (no `fastCheck`, no `check` on the event, no brief line).

- [ ] **Step 3: Implement**

- `resolveProfile` ends `...(doc.fastCheck?.trim() ? { fastCheck: doc.fastCheck.trim() } : {})`; `viewOf` passes it
  the same way. `ProfilePatchSchema` gets the field after `notify` (null removes it through `mergePatch`).
- `delegate`: `i.check?: string`. After the ledger-task check, a non-blank `check` on a reviewer, verifier or
  researcher (`READ_ROLES`) throws `invalid("a <role> writes nothing for a fast check to check", "give check to a task
  that changes code")`; then `const check = i.check?.trim() || (i.role === "worker" ? (profile.fastCheck ?? null) :
  null)` (`profile` is the `runProfile` the function already reads) and `task.delegated` spreads
  `...(check ? { check } : {})`.
- `delegate_task`'s shape: `check: z.string().optional().describe("the task's fast check (type check, lint and the
  tests it touches; never the full suite): catherd runs it on the run's tree when the task ends complete and wakes
  you with the result. A worker without one gets the profile's fastCheck.")`.
- `thread_send`'s resume passes `...(t.check ? { check: t.check } : {})`.
- `taskBrief`, right after the task's text: when `t?.check`, the line ``Your fast check: `<check>`. catherd runs it on
  the run's tree when you end complete, and the architect reads its result: make it pass before you reply.``
- Regenerate: `bun run panel:openapi && (cd web && bun run gen)`.

- [ ] **Step 4: Verify** — the Step 2 files and `test/entry/panel-openapi.test.ts` pass; `bun run typecheck && bun
  run lint && bun run format:check`; the panel's gate in `web/`.

- [ ] **Step 5: Commit** `feat: a task's fast check, named by the architect or the profile's for a worker`

### Task 2: fast-check share and check wait in a run's metrics

**Files:**
- Modify: `src/domain/run-metrics.ts` (`MetricInput`, `RunMetricsSchema`, `runMetrics`),
  `src/services/run-metrics.ts` (`metricsOf`), `src/domain/scorecard.ts` (`StageRow`, `stageBar`),
  `src/entry/scorecard-command.ts` (`formatStage`), `src/entry/runs-command.ts` (the metrics line),
  `web/openapi.json`, `web/src/client/types.gen.ts` (regenerated)
- Test: `test/domain/run-metrics.test.ts`, `test/services/run-metrics.test.ts`, `test/domain/scorecard.test.ts`

**Interfaces:**
- Produces: `MetricInput.checkSpans?: readonly (Span & { fast: boolean })[]`;
  `RunMetrics.fastCheckShare?: number | null`, `RunMetrics.checkWaitShare?: number | null`;
  `StageRow.checkWaitShare: number | null`.

- [ ] **Step 1: Write the failing tests**

`run-metrics.test.ts` (domain), before "sums review rounds…":

```ts
it("counts fast-check minutes apart, and the minutes a check ran with no role running and no pause (plan 53)", () => {
  const c = (from: number, to: number, fast: boolean) => ({ from: min(from), to: min(to), fast });
  const m = runMetrics({
    ...base,
    dispatches: [d(0, 40), d(40, 50)],
    pauses: [{ from: min(60), to: min(80) }],
    // 20–25 and 40–50 beside a role, 50–56 alone, 70–75 inside the pause
    checkSpans: [c(20, 25, true), c(40, 50, false), c(50, 56, true), c(70, 75, true)],
    checkMinutes: 26,
  });
  expect(m.fastCheckShare).toBe(0.2);
  expect(m.checkWaitShare).toBe(0.08);
  expect(runMetrics({ ...base }).checkWaitShare).toBeNull();
});
```

`run-metrics.test.ts` (services), after `expect(m.checkShare).toBe(0.1);`:
`expect([m.fastCheckShare, m.checkWaitShare]).toEqual([0, 0.1]);` (the one full check ran with no role beside it).

`scorecard.test.ts`, in "passes when every task ran twice…": `rows[0]` also matches `checkWaitShare: null` (the
fixture's metrics are a stage-1 run's, without the field); new "takes the median check wait of runs that recorded
one (plan 53)": the same two-run file with `checkWaitShare` 0.1 and 0.3 on each task's runs gives
`rows[0].checkWaitShare` `0.2`.

- [ ] **Step 2: Verify they fail** — `bun test test/domain/run-metrics.test.ts test/services/run-metrics.test.ts test/domain/scorecard.test.ts`: 4 FAIL.

- [ ] **Step 3: Implement**

- `runMetrics`: with `checks = i.checkSpans ?? []`,
  `fastMs` = the sum of `coveredMs(i.start, i.end, [c])` over the fast ones;
  `waitMs = coveredMs(i.start, i.end, [...spans, ...i.pauses, ...checks]) - paused - busy`;
  `share(ms) = i.checkMinutes === null || wall === 0 ? null : round2(ms / wall)`; `checkShare` becomes
  `share(i.checkMinutes * 60_000)` (same value), plus `fastCheckShare: share(fastMs)` and
  `checkWaitShare: share(waitMs)`. Schema: both `z.number().nullable().optional()`.
- `metricsOf`: `SELECT scope, minutes, cached, at FROM checks WHERE run_id = ?`; `ran` = the uncached rows;
  `checkMinutes` sums `ran`; `checkSpans: ran.map((c) => ({ fast: c.scope === "fast", from: Date.parse(c.at), to:
  Date.parse(c.at) + c.minutes * 60_000 }))`.
- `stageBar`: `checkWaitShare: med(runs, (m) => m.checkWaitShare ?? null)`; `formatStage` adds
  `waited on checks N%` (`?` when null) after `checks`.
- `catherd runs metrics`' line: `checks X% (fast Y%, waited Z%)`, `–` for a missing value.
- Regenerate the OpenAPI document and the panel's types.

- [ ] **Step 4: Verify** — the Step 2 files and `test/entry/panel-openapi.test.ts` pass; typecheck, lint, format;
  the panel's gate.

- [ ] **Step 5: Commit** `feat: fast-check share and check wait in a run's metrics`

### Task 3: stream each task's fast check the moment it ends complete

**Files:**
- Modify: `src/domain/run-events.ts` (`check.requested.task`), `src/domain/architect-state.ts` (`ArchCheck.task`,
  `nextCheckId`, `fastCheckFor`, the `check.requested` case, the `check.done` digest),
  `src/services/run-effects.ts` (`settle`, the `runCheck` case), `src/services/architect-tools.ts` (`check` uses
  `nextCheckId`; its description), `src/domain/role-prompts.ts` (`ARCHITECT_LOOP`: the `delegate_task` and `check`
  lines), `docs/dev/ideas.md`, `.changeset/streaming-fast-checks.md`
- Test: `test/domain/architect-machine.test.ts`, `test/services/architect-effects.test.ts`

**Interfaces:**
- Consumes: `ArchTask.check` (Task 1).
- Produces: `check.requested.task?: string`; `ArchCheck.task?: string`;
  `nextCheckId(a: ArchState): string` (`C${Object.keys(a.checks).length + 1}`, the `check` tool's id rule);
  `fastCheckFor(s: RunState, end: { name: string; status: string; replyStatus: string | null }): { checkId: string;
  command: string } | null` — from the state before the task's `dispatch.ended`: null unless the task has a `check`,
  is `working`, and ended `ok`/`complete`, and the run is not ended, cancelling or finishing.

- [ ] **Step 1: Write the failing tests**

`architect-machine.test.ts`, before "says a quota is held only while it is…":

- "gives a task that ended complete its fast check, never one that ended short, was cancelled or outlived the run
  (plan 53)": T1 delegated with `check: "bun test a"` and started, T2 started with none. `fastCheckFor(s, { name:
  "T1", status: "ok", replyStatus: "complete" })` is `{ checkId: "C1", command: "bun test a" }`; `partial`,
  `failed/null` and T2 give null; after an architect `check.requested` C1 the id is `C2`; after `task.cancelled` T1,
  and for T3 (with a check, started) once `run.finishing` is in, null.
- "names the task a fast check ran for in its digest line (plan 53)": a `check.requested` C1 with `scope: "fast"`,
  `by: "catherd"`, `task: "T1"` gives the action `{ type: "runCheck", checkId: "C1" }`; its `check.done` (exit 1, one
  failure) puts an inbox item `{ text: /^C1 \(fast check of T1\) failed \(exit 1\): 1 failing line\(s\)/, wakes: true }`.

`architect-effects.test.ts`, before "the architect's rung follows a profile change…":

```ts
it("runs each task's fast check the moment it ends complete, wakes the architect with it, and posts a red one to the team (plan 53)", async () => {
  // the first test's setup (simulator reply "Done.\nSTATUS: complete — ok", an architect on SOL), then two worker
  // tasks: T1 with check "echo fast-ok", T2 with check "echo '(fail) wallet balance'; exit 1"
  expect(await runDaemon(fakeDeps({ view }), run.id, { clock })).toBe("ended");
  const events = readEvents(run);
  const asked = events.flatMap((e) => (e.type === "check.requested" ? [e] : []));
  expect(asked.map((e) => [e.task, e.command, e.scope, e.by]).sort()).toEqual([
    ["T1", "echo fast-ok", "fast", "catherd"],
    ["T2", "echo '(fail) wallet balance'; exit 1", "fast", "catherd"],
  ]);
  // asked in the same write as the task's end: nothing waited in between
  for (const e of asked)
    expect(e.seq).toBe((events.find((x) => x.type === "dispatch.ended" && x.name === e.task)?.seq ?? 0) + 1);
  // check.done of T1's check has exit 0, T2's exit 1 with failures ["(fail) wallet balance"]
  // the architect briefs (roles/<name>/<dispatchId>/brief.md) match /C\d \(fast check of T1\) passed/ and
  // /C\d \(fast check of T2\) failed \(exit 1\)/
  expect(teamMessages(run)).toMatchObject([
    { from: "catherd", to: "all", text: expect.stringContaining("the fast check of T2") },
  ]);
});
```

- [ ] **Step 2: Verify they fail** — `bun test test/domain/architect-machine.test.ts test/services/architect-effects.test.ts`
  (`fastCheckFor` is not exported; no `check.requested` by catherd).

- [ ] **Step 3: Implement**

- `check.requested`: `task: z.string().optional()`; the reducer adds `...(e.task ? { task: e.task } : {})`.
- The `check.done` digest's head becomes
  `` `${e.checkId} (${c?.scope ?? "check"}${c?.task ? ` check of ${c.task}` : ""}${c?.base ? ", on the base" : ""}) …` ``.
- `settle`, inside its `withEventsLock`: take `s = replayRun(run)` once (the `ended` guard reads it), add the ended
  event, then `const fast = fastCheckFor(s, record)` and, when set, add the R4 `check.requested`.
- `runCheck`: keep the result in `done`, append it, then when `c.task && done.exit !== 0` send R6's notice with
  `teamSend({ run: run.id, from: "catherd", to: "all", mode: "queue", text })`, `.catch` →
  `log("warn", "daemon", { run, check, team: errorMessage(e) })`.
- `check` tool: `nextCheckId(replayRun(c.run).arch)`; its description ends "A task's fast check streams by itself
  when the task ends complete (delegate_task's check): call check for the integrated product, scope full once before
  land final."
- `ARCHITECT_LOOP`. The `delegate_task` line ends: "Give a code task its fast check (check: the type check, lint and
  the tests it touches, never the full suite): catherd runs it on the run's tree the moment the task ends complete,
  nothing waits on it, and its result wakes you. A worker task without one gets the profile's fastCheck." The `check`
  line, after "wakes you with the result.": "Each task's fast check already streams by itself, so check is for the
  integrated product: scope full once, when the work is in and before land final (or before a large replan), never
  to learn whether one task's change works. A full check is proof only for a tree that did not change while it ran:
  start it when no writer is running. A red fast check names its task: resume that task with thread_send when the
  failure is its own; another task on the shared tree may have caused it, and catherd posts it on the team channel.
  Do not ask for the base up front: a failing full check runs it by itself. base: true runs the command on the run's
  base commit, …" (the rest as it is), and "Nothing is checked unless you ask." becomes "Beyond the fast checks,
  nothing is checked unless you ask."
- `docs/dev/ideas.md`: a "From plan 53 (streaming fast checks)" section above plan 52's: R1's shared tree (D5 moves
  it and sends a red one back to the writer), R8's `check {ref}`, the verifier beside the full check (land final
  needs both on one commit; D8 has it read the result first; measure `checkWaitShare` on stage 2 before changing D8),
  the red notice to every role, a fast check not rerun when a sibling ends.
- `.changeset/streaming-fast-checks.md`: `"catherd-cli": minor`, one paragraph: part of 2.0.0 (spec D6); `check` on
  `delegate_task` and the profile's `fastCheck` (`catherd profile set fastCheck "<command>"`); it runs the moment a
  task ends complete, nothing waits on it, its result wakes the architect, a red one goes to the team channel; the
  architect calls the full check once before land final and does not ask for the base up front; `catherd runs` and
  the stage comparison show the fast-check share and the check wait.

- [ ] **Step 4: Verify** — the Step 2 files pass; then the full gate (wrap the full `bun test` in the machine's
  gate lock when another gate runs on the box).

- [ ] **Step 5: Commit** `feat: stream each task's fast check the moment it ends complete`

## Out of scope (stage 2, other plans)

- D5: per-writer trees, the merge, `check {ref}` on a writer's tree, the red fast check sent back to the writer's
  own thread, the regen merge driver, checkpoints, predicted conflicts, the memory-bound writer cap.
- D9, the oracle rule (plan 54).
- E3, affected-tests-only fast checks: switched on only after stage 4.
