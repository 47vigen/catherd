# Preflight: plan 11 (docs/plans/2026-09-28-11-access-protocol.md) on plan 10's head 85884d3

Read-only scan, 2026-09-28. Scratch commits a2e6aa4..3e53458 minus 115189d (peek stub) were cherry-picked in
pre-validation order onto 85884d3 in a throwaway worktree. Each conflict was noted, resolved with a union merge so
the next pick saw the previous ones, and then hand-fixed only as far as needed to run the gate. Result: **9
conflicted files in 7 of 12 commits**. After the minimal fixes below: typecheck, lint and format:check are clean, and
`bun test` gives **1314 pass / 0 fail** (1257 at 85884d3, plus the plan's 57). Plan 10 still has fixes pending, so
re-run this check on the merged `main` before the first dispatch.

Task to commit: T1 3e53458, T2 042a1f8, T3 b69fa53, T4 430b1f1, T5 38bdfba, T6 688ed97, T7 18b0b2b, T8 6e8195f,
T9 131859e, T10 9e177ed, T11 2232344, T12 9de6cad. Each task's **Files:** list matches its commit's file list exactly.

## 1. Task pairs sharing a file or interface, and each task's own text

| Pair / task | Shared file or interface | Producer → consumer | Finding |
| --- | --- | --- | --- |
| T2 ↔ T3 | `src/adapters/access.ts`, `backend.ts`, `codex/index.ts`, `claude-code/index.ts`, `test/adapters/access.test.ts` | T2 grants (`writableRoots`, `realTmpdir`, `RunRequest.network`) → T3 `accessShell`, probes | Sequential (waves 1→2). Applies cleanly. OK |
| T2 ↔ T4 ↔ T5 | `src/services/admission.ts` | T2 `network` → T4 `assertLaneHeader` → T5 `withReplyContract` | Separate hunks, waves 1/2/3. OK |
| T2 ↔ T12 | `test/skills.test.ts` | T2 adds the catherd-setup `roles.<role>.network: false` assertion; T12 rewrites the orchestrator block | Different `describe`s. OK |
| T4 ↔ T5 | `route()` → `assertLaneHeader` | T4 → T5 auto-route in `dispatch` | Dispatch refuses a bad header through `route` (spec §6). OK |
| T4, T6, T9, T10 | `src/entry/mcp/lane-tools.ts`, `src/services/lane-service.ts` (T8 too) | route / land gate / climb check / digest | Separate functions. The wave table runs **T9 before T8** (pre-validation ran 8 then 9); I checked 9→8: `lane-service.ts` applies clean, and the only conflict is plan 10's `manual-tests.md`. OK |
| T5 → T6 | `dispatch-service` imports `route` from `lane-service` while T6 edits `lane-service` (same wave) | interface only | Disjoint files, no import cycle (tests green). OK |
| T5 ↔ T7 | `src/domain/role-prompts.ts` | T5 `CONTRACTS.verifier` (VERDICT and STATUS) ↔ T7's verifier body (gate steps, "one line per gate item") | These agree: the contract is the tail and the body lists the lines. OK |
| T6 ↔ T9 | `src/domain/errors.ts` | `E_LAND_GATE` (T6), `E_CLIMB_DESIGN` (T9) | Adjacent lines, sequential. OK |
| T7 ↔ T8 | `protocol-tools.ts`, `summary.ts`, `runs-command.ts`, `tui/fixtures.ts`, `run-store.ts`, `test/entry/mcp.test.ts`, `runs-command.test.ts` | T7 creates `protocol-tools`/`verifier` field → T8 adds `park`/`answer`/`questions` | Sequential (waves 4→5). OK |
| T7, T8 → T10 → T11 | `gate-service.ts` (`latestVerifierStep`), `questions.ts` (`openQuestions`), `protocol.ts` (`protocolView`), `state.ts` (`parked`) | → `reentry.ts` | Interfaces as Task 11's Consumes lists them. OK |
| T8 ↔ T10 | `src/domain/state.ts`, `src/services/state.ts`, `test/services/questions.test.ts` | `withParked` → `Protocol next` last line | Sequential. OK |
| T6 ↔ T10 | `test/services/lanes-run.test.ts` | land call → `Next:` now at `.at(-2)` | OK |
| T6 → T12 | reviewer named `reviewer-<M>`, verifier `verifier-<M>` (Ruling 14) | skill steps 7 and 9 | The names agree. See the T12 row for the and/or wording |
| T11 ↔ T12 | the `peek` fields | skill `peek` row: "open owner questions first … verifier's step … `protocol`" | These agree once T11 is ported to plan 10's `peek`. OK |
| T1 | research note | — | Agrees with itself. §4 names the claude sandbox keys that Ruling 3 uses |
| T2 | — | — | Agrees with itself |
| T3 | — | — | Agrees with itself. Nit: the new live-verification §4 snippet uses bash/zsh arrays (`G=(…)`, `"${G[@]:2}"`) inside a `sh` block, so label it `bash` or say "in bash or zsh" |
| T4 | — | — | Agrees with itself |
| T5 | — | — | Its `dispatch` description diff still says "and wait(run) collects its record … then call wait" (written against `main`), which contradicts Assumes 1. Its context line in `dispatch-service` ("`wait` collects the record") is plan 10's old text too |
| T6 | — | — | Agrees with itself. The mcp-stdio placement note already accounts for plan 10 |
| T7 | — | — | Agrees with itself |
| T8 | — | — | Agrees with itself. Its `manual-tests.md` context still lists `wait` (plan 10 removed it) |
| T9 | — | — | Agrees with itself |
| T10 | — | — | Agrees with itself. `Protocol next: M2 parked: wait for the owner` goes beyond the spec's example "M2 parked", which is acceptable |
| T11 | — | — | Its code targets the stub (`id`, synchronous, `{ runs }`), and its prose rule ("questions first, then plan 10's fields, `protocol`, `verifier`") is what applies. It does not touch the MCP `peek` description (see Ruling P3) |
| T12 | — | — | Skill line 241, "`land` refuses … a milestone with **no `reviewer-<M>` record and no verifier verdict**", reads as both-missing. Line 70 and Task 6 refuse when **either** is missing. The test does not catch it. The new orchestrator test also drops four plan-10 negative strings ("Each dispatch backgrounds by itself", "its dispatch call returns the same record", "Launch it now, in the same message", "`dispatch` has already") |

## 2. "Assumes from earlier plans": what plan 10 built at 85884d3, and the adaptation each task needs

1. **`wait` is gone.** Confirmed. `test/entry/mcp.test.ts` `TOOLS` has 21 names with `peek`, no `wait`, and the test title
   still says "the 1.0 tools". `dispatch-service.ts` has no `wait`, `Progress` or `lastEvent` import. The skill still has
   a `## Waiting` section (retitled content). Adaptation: T7 and T8 add their 4 names to `TOOLS` (applies clean, 25).
   T5 must **not** carry its `wait(run)` wording into the `dispatch` description (Conflict C2). T12's test replaces
   plan 10's `## Waiting` test (Conflict C9).
2. **`peek`.** It lives in `src/services/peek.ts`: `export async function peek(deps: Deps, i: { run?: string; name?: string }):
   Promise<{ runs: PeekRun[]; hints: string[] }>`. `PeekRun = { run, title, owner, live: PeekRole[], unread[], native, next }`,
   built by `peekRun(deps, run, name)`. It calls `claimRun`/`adopt` when given a run. **The MCP tool is registered in
   `src/entry/mcp/dispatch-tools.ts`** (not `run-tools.ts` as in the stub). Adaptation for T11: in `peekRun`, compute
   `const r = reentry(run, now)`, return `{ questions: r.questions, run: run.id, title, owner, live, unread, native, next,
   protocol: r.protocol, verifier: r.verifier }`, and declare `interface PeekRun extends Reentry { run: string; … }`. Keep
   `run` (not the stub's `id`), keep async and `hints`, and add the `reentry` import. T11's test (`Object.keys(p)[0] ===
   "questions"`, `protocol.checklist` of 6, `verifier: null`) passes on that merge. I checked this in the throwaway.
3. **`result` consumes the marker, and the notifier runs failover** (`src/services/notifier.ts`). Its messages are
   `limit on <rung>; failed over to <rung>` and `limit on <rung>; paused: no stand-in`, which match T12's skill text.
   Stand-in briefs go through `admit()`, so T5's `withReplyContract` covers them (T5's failover-cancel test passes).
   No adaptation.
4. **`run_start`.** `startRun(deps, {repo,title,aLines}): Promise<{run, dir, hints?}>`. It writes `startedBy:
   currentSession(deps)` and calls `claimRun`. **There is no resume path** (`run_start` always creates a run). Adaptation for
   T10: add `protocol: protocolView(run, [])` beside plan 10's `startedBy`/`claimRun` lines (Conflict C6: imports only).
   T11: there is no resume return to spread into (Ruling P4).
5. **Tests plan 10 rewrote.** `helpers.ts` no longer imports `wait`/`Progress` and imports `result`. T6 adds
   `appendAgentRun, appendRecord` to the `run-store` import and imports `makeRecord` (Conflict C4). The dispatch,
   failover-cancel, claude-code-dispatch, opencode-dispatch and mcp-stdio edits of T5, T6 and T10 all applied clean.
6. **The skill.** Plan 10 changed 17 lines (tools table, limit/failover, `## Waiting`, Resume, Pause, Cancel, red flags).
   T12's whole file conflicts in 8 hunks (C8). Plan-10 content the T12 text lacks and should keep (Assumes 6):
   - Resume: "it makes this session the run's owner, so catherd messages you from now on".
   - "Call `dispatch` from your main thread only …: catherd messages the session that dispatched", in the prose and the red-flag row.
   - The message format: "Its first line names the run, the role, its rung, its status and its STATUS line".
   - "Roles that finish together come in one message."
   - The failover hint: "the limited record's first hint says `limit: … failed over to <rung>`".
   - Cancel: "… and marks it read".
   - "`status(run)` adds the totals, budget and milestones".
   - The red-flag row "`sleep`, a loop, or repeated calls … | End your turn. catherd's message wakes you".

   Plan 10's test strings that T12's text drops are intended ("Before dispatching anything, call `peek(run)` once",
   "A single role is `dispatch`, then end your turn.", "## Waiting"). T12's new test replaces plan 10's block. T12's
   text keeps "call `peek(run)` once and answer from it".
7. **`RunSummary` / notes / `renderState`.** Plan 10 added session fields (`RunSession`, `sessionFacts`). T7 and T8
   add `questions` (second key, after `id`) and `verifier`, and `formatRun` prints `parked …` before `live`. All
   applied clean, and the TUI fixtures typecheck. No adaptation.

## 3. Cherry-pick of the plan-11 commits onto 85884d3 (with 115189d excluded)

T1 3e53458, T2 042a1f8, T4 430b1f1, T7 18b0b2b and T9 131859e apply clean. Nine conflicts:

| # | Commit (task) | File | Nature | How to resolve |
| --- | --- | --- | --- | --- |
| C1 | b69fa53 (T3) | `src/services/doctor.ts` | Imports. Plan 10 added `pushCheck`/`PushProbe` and kept `workspaceWriteBackends`; T3 imports `accessChecks` and drops `workspaceWriteBackends` and `locksDir` | Keep `doctor-push` import + `accessChecks`; import `backendChecks, usedBackends` only. The body merged clean: push row, then `locksCheck()`, then `accessChecks` |
| C2 | 38bdfba (T5) | `src/entry/mcp/dispatch-tools.ts` | `dispatch` description: plan 10's push wording vs T5's (still says `wait(run)` / "then call wait") | Plan 10's sentence + T5's two clauses: "dispatch appends the role's reply contract (reply length and the STATUS line), so do not write it" and "a lane not yet routed is routed first (… with a hint)". No `wait` |
| C3 | 38bdfba (T5) | `src/services/dispatch-service.ts` (3 hunks) | Imports: plan 10's `claimRun`, T5's `route` + `readRoutes`. Body: plan 10's `if (await claimRun(deps, run)) adopt(deps, run);` and its `try { start } finally { watch }` with `const hints` declared **after** launch, vs T5's routing block that declares `hints` **before** admit | One `run-store` import with `readRoutes` + `claimRun` + `route`. Order: `claimRun`/`adopt`, then T5's `hints`/`rung`/route block, then `admit({… rung})`, then plan 10's try/finally; delete plan 10's later `const hints` |
| C4 | 688ed97 (T6) | `test/services/helpers.ts` | Imports: plan 10 `result` + `createRun…`; T6 `appendAgentRun, appendRecord, createRun…` + `makeRecord` | Keep `result`; one `run-store` import with the T6 names; keep plan 10's `export { makeRecord }` line and the T6 import |
| C5 | 6e8195f (T8) | `docs/dev/manual-tests.md` | Tool list: plan 10 `… dispatch, peek, cancel, … profile_set`; T8's context still has `wait` | Plan 10's list + `, gate_check, gate_pass, park, answer` (25 names). A union merge leaves both lines, so check it by hand |
| C6 | 9e177ed (T10) | `src/services/run-service.ts` | Imports: plan 10 `claimRun, currentSession` vs T10 `protocolView` | Keep both. The `startRun` body merged clean (`startedBy`, `claimRun`, `protocol`) |
| C7 | 2232344 (T11) | `src/services/peek.ts` (3 hunks) | T11's diff is against the stub; plan 10's file is the real service | Discard T11's `peek.ts` diff and apply its rule to plan 10's `peekRun` (§2 item 2). `reentry.ts` and its test apply clean |
| C8 | 9de6cad (T12) | `plugin/skills/catherd/SKILL.md` (8 hunks) | Whole-file replacement vs plan 10's 17-line edit | Take T12's file, then add back the plan-10 sentences in §2 item 6. `plugin/commands/catherd.md` applies clean |
| C9 | 9de6cad (T12) | `test/skills.test.ts` (1 hunk) | Plan 10's "dispatches … (plan 10)" block (`## Waiting`) vs T12's "## After dispatching" block | Take T12's block; add plan 10's four dropped negative strings to its `not.toContain` list |

Earlier naive pass (abort on conflict, no carry-over) also reported `errors.ts` (T9), `lane-service.ts` (T8, T10),
`lane-tools.ts` and `questions.test.ts` (T10). Those were **cascades** from the skipped earlier pick, not plan-10
conflicts.

## 4. Conflicts with the spec and with plan 12

**Spec §3.7 `peek`.** Plan 10 deferred "parked questions, the verifier's latest step, the run's next protocol step" to
plan 11. T11 adds all three through `reentry()`: `questions` (first), `verifier` (T7's `latestVerifierStep`) and
`protocol` (T10's `protocolView`: `{ next, checklist }`). **Confirmed**, subject to C7's port. The native-role latest
step is plan 10's `native`. Gap: the MCP `peek` description (plan 10, in `dispatch-tools.ts`) does not mention the new
fields (Ruling P3).

**Spec §8 "`run_start` (on resume) … list unanswered questions first".** Plan 10 has no resume path. Spec §3.8 routes
re-entry through "`peek` once after `run_start` on a resumed run", and T12's skill does that (Ruling P4).

**Spec §8/§7 `status`.** `RunSummary.questions` (right after `id`) and `verifier`; the text prints `parked` lines
first after the header. OK.

**Spec §10.** `run_start` returns `protocol` (T10), `peek` returns it (T11), and `state.md` ends with `Protocol next:`
(T10). OK. The runs-page digest view is deferred by Ruling 23; plan 12 does not pick it up either (it is not in plan
12's file table), so it goes to `ideas.md` (Ruling P7).

**Spec §14.** 25 tools after T7 and T8. `mcp.test.ts`'s test title still says "exactly the 1.0 tools" (plan 10's), which
is cosmetic.

**Plan 12, `docs/dev/live-verification.md`.** Plan 12 Ruling 21 says "§4's old sandbox text is plan 11's to update".
T3 rewrites §4 as "Worker access: the Codex sandbox and the five probes" (commit b69fa53), so the ownership agrees. Plan
12 Task 9's new **§8 Worker access** then repeats the same five hand probes. Plan 12 should drop its hand-probe block
and point at §4 (Ruling P6). Plan 12's §8 wording (`sandbox:codex ✓ ready`, `access:<backend>` rows, failed probes
with fixes) matches T3's rows (`ok ready` / `warn blocked` / `skip not tested`).

**Plan 12, doctor rows.** The ids `access:full`/`access:advisory` (plan 12 T7) and `access:<backend>` (T3) do not clash.
But plan 12 Tasks 5 and 7's `doctor.ts` diffs were written against `main`: their context contains
`import { backendChecks, usedBackends, workspaceWriteBackends }` and the `for (const id of workspaceWriteBackends(profiles))
{ … a?.canWrite …}` loop, which T3 deletes. Its `doctor.test.ts` full-row map and the "Codex workspace-write sandbox
cannot write the lock dir" test context are T3-era too. Plan 12 must re-anchor those hunks after plan 11 merges.

## 5. Proposed rulings

- Ruling P1: Resolve the nine conflicts as §3 says (plan 10's code wins wherever the scratch diff assumed `main`; plan 11 adds only its own lines) — the plan's code was pre-validated on `main` + stub and plan 10 is the real base — a lost plan-10 line (claimRun/adopt, try/finally watch, push row) would break push or ownership silently, so each batch review diffs these nine files against 85884d3.
- Ruling P2: T5's `dispatch` description keeps plan 10's push wording and adds only the reply-contract and auto-route clauses; no `wait` anywhere — spec §3.7 removes `wait` and T5's text predates plan 10 — cost: a tool description that tells the model to call a tool that does not exist.
- Ruling P3: T11 also updates the MCP `peek` description in `src/entry/mcp/dispatch-tools.ts` to say "open owner questions first … the verifier's latest step … `protocol` (the next step and the six-line checklist)" — spec §3.7/§10, and the model reads descriptions, not the service — cost: the three fields exist but the orchestrator does not know to use them.
- Ruling P4: No `run_start` resume path is invented; `run_start` returns `protocol` for the new run only, and re-entry is `status()` then `peek(run)` once (as T12's skill and commands/catherd.md say) — plan 10 did not build a resume, and spec §3.8 names `peek` after `run_start` — cost: a spec reviewer reads §8 "run_start (on resume)" literally; if the owner wants it, it is an additive field later.
- Ruling P5: T12 keeps plan 10's skill sentences listed in §2 item 6, fixes line 241 to "no `reviewer-<M>` record **or** no verifier verdict", and its orchestrator test keeps plan 10's four dropped negative strings — Assumes 6 and Ruling 27 say to keep plan-10 lines, and Task 6 refuses on either missing — cost: the orchestrator loses the ownership/one-message facts, or skips a verifier after a reviewer.
- Ruling P6: live-verification §4 is plan 11's (T3's rewrite stands, with its snippet labelled bash/zsh); plan 12's §8 references §4 instead of repeating the probes — plan 12 Ruling 21 splits it that way — cost: two copies of the probe commands that drift.
- Ruling P7: The runs-page digest view (spec §10) goes to `docs/dev/ideas.md` with Ruling 23 as evidence, since neither plan 11 nor plan 12 builds it; HANDOFF names it as a 1.1 gap — cost: 1.1 ships without a spec §10 clause that no one tracks.
- Ruling P8: Before dispatching T3, T5, T6, T8, T10, T11 and T12, hand each worker its §3 conflict row(s) and have it re-find hunks by context on the merged plan-10 `main`; re-run this cherry-pick check once plan 10's pending fixes merge — plan 10's head can still move — cost: a worker pastes a stale hunk (e.g. a second `const hints`, or the stub's `id`).
- Ruling P9: The wave table's order (T9 in wave 4 before T8 in wave 5) stands — verified 9→8 applies with only the plan-10 `manual-tests.md` conflict — cost: none found.
- Ruling P10: The expected test count per task shifts by plan 10's +75 (1257 at 85884d3; 1314 after T12 in the throwaway); workers check "0 fail", not the plan's absolute numbers — the plan counted on `main` — cost: a worker chasing a count mismatch.
- Ruling P11 (for plan 12, recorded now): plan 12 Tasks 5 and 7 re-anchor their `doctor.ts` and `doctor.test.ts` hunks after plan 11 (no `workspaceWriteBackends`/`canWrite` loop; the new `access:<backend>` and `sandbox:codex` rows in the full-row map) — plan 12 was written on `main` — cost: plan 12's workers fail to apply or reintroduce the removed probe.
