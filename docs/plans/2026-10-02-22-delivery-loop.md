# catherd 1.5, plan 22: delivery and the loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Codex coordinator hears of every finished role even when its thread's MCP server is gone, never polls, and never acts on stale state. The detached supervisor queues the role's notice to a Codex owner when its worker exits (`codex queue --remote unix:// --thread <owner>`, the server's own text under the same per-event receipt); every catherd message names the role's `thread:`, and `dispatch` takes `thread: "latest"` and refuses a thread the name never ran on; a later short reply never overwrites the report; `dispatch` stops what a thread's last turn left running before it resumes it; "waiting for orchestrator" shows only for a current owner and a recent record; `peek` answers `actionable: false` with its reason and the skill's Codex half covers goal mode and tmux; `result()` advances a `Next` that names it and the verifier's step closes and shows its age; boot sync and reconcile are single-flight across MCP servers; `doctor --test-push --thread <uuid>` and a `test_push` tool; the 1.1 push minors. `wait` was removed by #45: this plan sweeps for residue only.

**Architecture:** The supervisor's push is a service (`src/services/end-push.ts`, `pushFromEnd`) that the `_supervise` entry imports dynamically once `supervise()` returns: it reads the run's owner from `state.json`, waits a grace (the server is the fast path), finalizes the record through the existing claim protocol, and sends `finishedNotice` under the dispatch's notify lock with the same `delivery.json` attempt/receipt the notifier writes, so `deliveryState` makes either path a no-op once the other was accepted. Single-flight is a lifetime file lock (`src/infra/boot-lock.ts`, `<data>/locks/mcp-boot.lock`, holder pid and start time) taken at the first `initialized`. The rest are local changes: `Notice.thread` in the domain notice, a thread check in `dispatch()` before the claim, `composeReply` (pure, `src/domain/reply.ts`) used by the Codex adapter's `finalize`, `orchestratorWait`'s window rules plus one `waitingLine` both TUI views use, `actionability` in `peek`, `advanceNext` in `result`, `verifierStepView` (`src/services/verifier-step.ts`) for `status` and `peek`.

**Tech Stack:** Bun ≥ 1.4, TypeScript, zod 4, citty, `@modelcontextprotocol/sdk`. No new dependency.

**Spec:** `docs/specs/2026-10-02-catherd-1.5-design.md`, "Plan 22: delivery and the loop" (binding), on top of the 1.0–1.4 specs; evidence in `docs/dev/ideas.md` (#42 findings 3 and 7, "A completion is lost once the daemon drops the thread", goal mode, the thread notice, final reply, exit 143, `state.md` Next, the stale verifier step, three MCP servers, `doctor --test-push`, the 1.1 push minors).

**Pre-validated on scratch `6f2f8c7..80db213` (worktree branch `plan22-scratch`, code head `80db213`): 2052 pass / 0 fail / 19 skip (2071 tests, 189 files, about 6 minutes); typecheck, lint and format:check green.** The code below is that scratch build, commit by commit, on `main` `6f2f8c7` (#45 "remove wait" merged). Every task names its scratch commit.

## Global Constraints

- Layers `domain → infra → adapters → services → entry` (`test/architecture.test.ts`). `composeReply` is domain; the boot lock is infra; `pushFromEnd`, `verifierStepView`, `actionability` are services; the supervisor reaches `end-push.ts` only through a dynamic `import()` from `src/entry/supervise-command.ts` after `supervise()` returned, so a supervising process loads nothing more until its worker ended.
- The gate: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test` (FORCE_COLOR unset). Tests that could reach the network delete `ANTHROPIC_API_KEY` (in-process) or pass `ANTHROPIC_API_KEY: ""` (spawned); spawned processes get an explicit `env`. No wall-clock sleeps for correctness: the supervisor's grace is `0` in tests (`graceMs: 0`, or `CATHERD_END_PUSH_GRACE_MS=0` for the spawned supervisor).
- `test/preload.ts` sets `CATHERD_NO_END_PUSH=1` for every test process and every process a test starts with its env (Task 10); only `test/services/end-push.test.ts` deletes it.
- Spec, verbatim: "On exit, the detached supervisor of a dispatch whose owner is a Codex thread runs `codex queue --remote unix://… --thread <owner>` with the same notice text and the same per-event receipt the server-side push uses, so the two never double-deliver. The server-side push stays the fast path. The Codex half of the skill says once, when `$TMUX` and `$STY` are empty, to run the coordinator inside tmux."
- Spec, verbatim: "shown only when the owner is the current one (its session live or seen in the last 24 h) and the unread record ended within 24 h; `status()` without a run returns live runs, else runs waiting under that rule, else the newest; the TUI memo computes it once per stamp change; one `stalled` computation shared by both views."
- Spec, verbatim: "a goal continuation while only roles are live ends the turn with no tool call. `peek` returns `actionable: false` with the reason when nothing is the coordinator's to do."
- Spec, verbatim: "The first line of every catherd message names `thread:`; `dispatch` accepts `thread: "latest"` for the name's last thread, and refuses a thread id not in `runs.jsonl` for that name." (Cross-plan ruling X3: plan 25's "Thread check" is this.)
- Spec, verbatim: "When a role sends more than one final message, `result` returns the longest STATUS-bearing one and appends the later ones under "later:"."
- Spec, verbatim: "The worker contract forbids leaving background processes behind; `dispatch` kills the old thread's process group before a resume (fixes exit 143)."
- Spec, verbatim: "`state.md`'s Next is advanced by `result()` of the named dispatch; a verifier step closes on `gate_pass` of its last item, on `record_agent_run(role: verifier)`, on the verifier dispatch's record, or when its owner session is gone, and `status` shows its age."
- Spec, verbatim: "Boot sync and reconcile are single-flight across processes (a lock file with the holder's pid); a second server skips both while the first is alive." (X5: this closes the three-MCP-servers investigation; plan 26 removes that `ideas.md` entry, not this plan.)
- Spec, verbatim: "`doctor --test-push --thread <uuid>`, and an MCP tool `test_push` for inside a session."
- Spec, verbatim: "`watch()` checks ownership before settling a limit; Codex activity is computed once; an edit with no paths shows `edit`; Claude tool activity shows its first argument."
- X2: `wait` (tool, service, tests, skill text) is already gone (#45); "Remove `wait`" is a residue sweep.
- No changeset (plan 27 writes the 1.5.0 one). Commits: conventional, subject ≤ 100 characters, lower-case first word after the scope; check `git log` after each commit (a failed hook leaves the changes uncommitted).

## Review Focus

1. **The server and the supervisor both push one finished role** (the owner's server alive, or reattached late). Expected: exactly one `codex queue` send per owner and event; whichever path is second finds the event accepted. Pinned in Task 10, `test/services/end-push.test.ts` ("queues the server's notice to the Codex owner under the per-event receipt; the server then sends nothing", "sends nothing when the server's push was accepted first").
2. **A usage limit announced before its failover ran.** Expected: the supervisor leaves a limit to the owner's server (it fails it over, then announces what it did). Pinned in Task 10 ("leaves a usage limit to the owner's server, which fails it over first") and Task 1 (`failover-cancel.test.ts`, "leaves a limit to the new owner when its session lost the run before it settled").
3. **Resume hygiene signals a stranger.** Expected: only a finished dispatch's group whose leader pid is gone is stopped; a pid that answers is someone else's. Pinned in Task 4, `test/services/dispatch-thread.test.ts` ("never signals a group whose leader's pid answers: it is someone else's by now", "stops what the thread's last turn left running in its group before it resumes the thread").
4. **The composed reply loses the report's STATUS** (so `land` and the protocol read no STATUS). Expected: the report's STATUS line stays the reply's last line. Pinned in Task 5, `test/domain/reply.test.ts` ("takes the longest STATUS-bearing message, and keeps a later STATUS line out of the last line") and `test/services/final-reply.test.ts`.
5. **An abandoned run reads "stalled" forever, or `status()` floods the coordinator.** Expected: no line after 24 h of either the record or the owner; `status()` returns live runs first. Pinned in Task 6, `test/services/orchestrator-wait.test.ts` (all five tests).
6. **A second MCP server of one session skips reconcile and loses nothing it owns.** Expected: the leader reconciles every run; the second still scans its notifier; the lock passes on at close and from a dead holder. Pinned in Task 9, `test/entry/mcp-sync.test.ts` ("lets a second server skip both while the first is alive, and the next lead once it closes", "takes the lock over from a server that died holding it").

## Rulings

Controller rulings (from the brief): X1 (built on `main` `6f2f8c7`; the executor adapts to plans 21 merged first), X2 (residue sweep only), X3 (the thread check is this plan's), X5 (single-flight closes the three-servers investigation; plan 26 removes its entry), X7 (product questions decided conservatively below), X8 (vendor behaviour this sandbox cannot run is decided from the simulator plus a `live-verification.md` step: §15).

Rulings of this plan (`what — why — cost if wrong`):

1. Ruling: `watch()` leaves a limit unsettled only when this process serves a session that no longer owns the run; a process with no session (a terminal, the tests) settles as before — the minor names the old owner starting a stand-in, and every failover test runs session-less — a terminal-launched dispatch still fails over from the terminal, as in 1.4.
2. Ruling: Claude tool activity is `<tool> <first string argument>` (`Grep TODO`), the tool name alone when it has none — opencode's rule, as the minor asks — wording only.
3. Ruling: `Notice.thread` is the record's thread (finished) or the admission's, else the stream's `thread.started` (stalled); a role with none reads `thread: none`; each block's header ends `· thread: <id>` and the multi-role preview line carries `(thread: …)` per role, so the message's first line names it either way — a longer Desktop preview line.
4. Ruling: the thread check is in `dispatch()`, before the claim (a refused dispatch changes no ownership), not in `admit()` (failover stand-ins and direct admits are untouched); `"latest"` is the name's last record with a thread; an id matches the name's records case-insensitively and resumes with the record's spelling; refusals are `E_ADMIT_THREAD` with a fix naming `thread: "latest"` and the last thread — a fix round under another name (`worker-x-fix` on `worker-x`'s thread) is now refused; the skill already resumes by the same name.
5. Ruling: before a resume, `dispatch` stops (SIGTERM, then SIGKILL after `orphanLimits.killGraceMs`) the process group of every finished dispatch on that thread whose leader pid no longer answers while the group still lives, and returns a `resume: stopped …` hint — the supervisor already stops its group when it exits, so this covers a supervisor that died; a pid that answers may be another process now — a background command that left the group (`setsid`) is not reached: the worker-contract sentence is the main fix, and `live-verification.md` §15 step 6 records that case.
6. Ruling: the worker's reply contract (and the native worker prompt) starts "Before you reply, leave nothing running: stop every server, watcher or command you started in the background." ahead of the unchanged `REPLY`, so the STATUS line stays last; other roles are unchanged — the spec names the worker contract — native Claude worker agent files change text (`profile use` relinks them).
7. Ruling: "final messages" are the agent message that ended each completed turn of a Codex run (`turn.completed`); the Codex adapter's `finalize` composes the reply with `composeReply` and returns it as `Outcome.reply`, so `reply.md`, the record's STATUS, the notice and `result` all agree; the report's STATUS line moves to the end, after `later:`; equal lengths take the later message. Claude Code (one `result` per run) and opencode (one streamed reply) are unchanged — the evidence (plan 9's worker) is a Codex run — a backend that later emits several finals needs the same fold.
8. Ruling: the owner is current when its Claude Code session file is live, or it was seen in the last 24 h: it took the run (`since`) or a dispatch was admitted from its session; `OrchestratorWait` gains `until` (when the line stops showing), and `waitingLine(w, now)` is the one line both TUI views (and their `stalled`) use; the memo no longer recomputes on a hit — a collect lease left dead by a crash shows as unread again only at the next stamp change.
9. Ruling: `status()` without a run returns the live runs, else the waiting runs, else the newest; the `catherd status` help says so — the spec's order.
10. Ruling: `peek`'s `actionable`/`reason` per run: an unread record is actionable (`unread: result(run, "<name>")`); a protocol step a live role covers (`lanes running`, `reviewer` or `verifier` with that role live, `plan:` with an architect or researcher live, `finish:` with a verifier or writer live) or a parked-only step is not; anything else is actionable with the protocol step as its reason; the top level is actionable when any run is (no runs: actionable, "no runs yet"); it is decided on the whole run even when `name` narrows the view — the smallest rule that answers goal mode in one call — a step the map misses reads actionable (safe: the coordinator does it).
11. Ruling: `result()` of a finished record whose role name or lane `state.json`'s Next names as a whole word sets Next to `after <name> (<status>): <protocol next>` through `refreshState` (a git failure is a hint); otherwise it writes nothing — "advanced", not cleared, and only when stale — one more git call in such a `result`.
12. Ruling: the verifier step's view (`VerifierStepView`: the step plus `secs`, `open`, `closedBy`) closes on the first of: a `gate_pass` of its item in this run at or after it; a `record_agent_run` with role verifier at or after it; a verifier record that ended at or after it; its owner gone (another session took the run after the step, or the Claude Code owner's session file is gone). A Codex owner that still holds the run has no liveness to read, so its step stays open until other evidence. `status` text reads `· N min ago · open|closed (<why>)`; `peek` and `status` JSON carry the fields.
13. Ruling: the single-flight lock is held for the server's life (`<data>/locks/mcp-boot.lock`, the filelock holder JSON: pid and start time, a dead holder reclaimed) and released when its transport closes; the second server skips boot sync and reconcile and still scans its own notifier; a lock that fails for another reason (I/O) runs the boot work — "while the first is alive" — a session started beside a long-lived leader gets no boot reconcile; its runs recover through the claim of `peek`/`dispatch` (the skill's one `peek(run)` on a resumed run) and the supervisor's push.
14. Ruling: the supervisor's push reads the owner before its 20 s grace (`END_PUSH_GRACE_MS`; `CATHERD_END_PUSH_GRACE_MS` overrides, for the spawned-supervisor test), and pushes only for a Codex owner, never for a limit or a read record; it finalizes the record itself through the claim protocol when no watcher did; it sends under the dispatch's notify lock (`notified.json`'s lock, which the notifier takes) after `recoverSubmission`, so both paths share one receipt — the server is the fast path and either is a no-op after the other — a coordinator whose server is alive but slower than 20 s gets the supervisor's (identical) message instead.
15. Ruling: `doctor --thread <uuid>` needs `--test-push`, refuses a non-UUID and a Claude Code host, and makes the host that Codex thread; `test_push` takes no input and probes `deps.host` (the call's thread); it lives in a new `src/entry/mcp/push-tools.ts` (32 tools) — no other plan's tool file is touched.
16. Ruling: `ideas.md`: the "`wait` goes" owner-ruling bullet, #42 findings 3 and 7, the 1.1 "Push and sessions" bullet, "The dispatch description still says wait…", "`dispatch` accepted a thread id that doesn't exist", "`state.md`'s Next outlives the step", "The catherd message does not carry the thread id", "A final reply can overwrite the report", "A resumed worker exits 143", "A completion is lost once the daemon drops the thread" and "`doctor --test-push` cannot find a Codex thread" go; "`status` shows a stale verifier step as live" is trimmed to the previous owner listed as live, and goal mode to the `run_start` warning idea; "Messages arrive only when the next turn starts" stays (the spec's plan 22 section does not name it) and "three MCP servers" stays for plan 26 (X5).

## Assumes

- `main` at `6f2f8c7` plus plan 21 merged before this plan runs (X1). Plan 21 owns `CATHERD_ROLE`, `E_ROLE_SCOPE` and "deliveries never target a role thread": after it, `runOwner` is always a coordinator, which is the target `pushFromEnd` reads. Re-find every diff hunk by its context.
- `test/services/helpers.ts` gains `seedThread` (Task 3); later tasks use it.

## Verified facts (scratch build, 2026-10-02)

- `codex exec` with `-o` keeps only the last turn's agent message; the turn-ending messages are recoverable from `events.jsonl` (`item.completed`/`agent_message`, then `turn.completed`).
- The Codex simulator's `queue: "accepted"` scenario answers `codex queue --remote unix:// --thread <t> --message …` with `Queued message 01a0f547-… for thread <t>.`: the spawned-supervisor test sees that receipt in `delivery.json` with no notifier running.
- Baseline on `6f2f8c7` in this sandbox: the first full run of the unchanged `main` gave 2005 pass / 7 fail / 19 skip (load timeouts, the suite run alongside a typecheck; not reproduced in later runs of the scratch head).

## File Structure

| File | Task | Responsibility |
| --- | --- | --- |
| `src/adapters/codex/index.ts`, `src/adapters/claude-code/index.ts` | 1, 5 | activity once, `edit` with no paths, Claude's first argument (1); the composed reply (5) |
| `src/services/dispatch-service.ts` | 1, 3, 4 | limit ownership in `watch` (1); `threadFor` (3); `stopLeftovers` (4) |
| `src/domain/notice.ts`, `src/services/notifier.ts` | 2, 10 | `Notice.thread`, `thread:` in headers (2); `recoverSubmission` exported (10) |
| `src/entry/mcp/dispatch-tools.ts` | 3, 7 | `dispatch`'s thread text (3); `peek`'s `actionable` (7) |
| `plugin/skills/catherd/SKILL.md`, `test/skills.test.ts` | 3, 7, 11 | thread resume (3); "On Codex" (7); `test_push` (11) |
| `test/services/helpers.ts` | 3 | `seedThread` |
| `test/services/dispatch-thread.test.ts` (new) | 3, 4 | thread check; resume hygiene |
| `src/domain/role-prompts.ts`, `src/infra/supervisor.ts` | 4 | worker contract; `groupAlive`/`stopGroup` exported |
| `src/adapters/codex/events.ts`, `src/domain/reply.ts` (new) | 5 | `finals`; `composeReply` |
| `src/services/orchestrator-wait.ts`, `src/entry/tui/{effects.ts,views/runs.tsx,views/status.tsx}` | 6 | the window rules, `waitingLine`, the memo |
| `src/services/summary.ts`, `src/entry/runs-command.ts` | 6, 8 | `status()` order (6); the verifier step view and its line (8) |
| `src/services/peek.ts` | 7 | `actionability` |
| `src/services/run-service.ts`, `src/services/reentry.ts`, `src/services/verifier-step.ts` (new) | 8 | `advanceNext`, `names`; `verifierStepView` |
| `src/infra/boot-lock.ts` (new), `src/entry/mcp/server.ts` | 9, 11 | the boot lock (9); `registerPushTools` (11) |
| `src/services/end-push.ts` (new), `src/entry/supervise-command.ts`, `test/preload.ts` | 10 | `pushFromEnd`; its call; `CATHERD_NO_END_PUSH` |
| `src/entry/host-arg.ts`, `src/entry/doctor-command.ts`, `src/entry/mcp/push-tools.ts` (new), `README.md` | 11 | `withThread`, `--thread`, `test_push` |
| `test/wait-residue.test.ts` (new) | 12 | the residue guard |
| `docs/dev/ideas.md`, `docs/dev/live-verification.md` | 13 | entries fixed; §15 |

## Spec coverage

| Spec bullet (Plan 22) | Task |
| --- | --- |
| Remove `wait` (ruling 1; X2: residue sweep) | 12 (guard), 13 (`ideas.md`) |
| Push from where a role ends: the supervisor's `codex queue`, same text and receipt, the server the fast path | 10 |
| … the Codex half says once, with `$TMUX` and `$STY` empty, to run in tmux | 7 |
| "waiting for orchestrator" (#42 findings 3, 7): current owner, 24 h, `status()` order, the memo, one `stalled` | 6 |
| Goal mode: the skill's Codex half; `peek` `actionable: false` with the reason | 7 |
| The notice carries the thread; `thread: "latest"`; an unknown thread refused | 2, 3 |
| A final reply never overwrites the report | 5 |
| Resume hygiene: the worker contract; `dispatch` kills the old thread's process group | 4 |
| `state.md`'s Next advanced by `result()`; the verifier step closes, `status` shows its age | 8 |
| One MCP server per Codex session: single-flight boot sync and reconcile | 9 |
| `doctor --test-push --thread <uuid>`; the `test_push` tool | 11 |
| The 1.1 push minors | 1 |

## Parallelism

| Wave | Batches (parallel worktrees) | Depends on | Why disjoint |
| --- | --- | --- | --- |
| A | {1, 3, 4}, {2}, {6, 8}, {9}, {12} | — | `dispatch-service.ts`, `failover-cancel.test.ts`, `dispatch-thread.test.ts`, the Codex/Claude adapters (1, 3, 4, in order) vs `notice.ts`/`notifier.ts` (2) vs `summary.ts`/`runs-command.ts` and their views (6, 8) vs `server.ts`/`boot-lock.ts` (9) vs one new test file (12). Batch {1, 3, 4} also owns `SKILL.md`, `dispatch-tools.ts` and `helpers.ts` for Task 3 |
| B | {5}, {7}, {10} | A (5 after 1 on `codex/index.ts` and `codex.test.ts`; 7 after 3 on `SKILL.md` and `dispatch-tools.ts`; 10 after 2 on `notifier.ts` and the notice's `thread:`) | Codex adapter and reply (5) vs `peek.ts`, `SKILL.md`, `skills.test.ts` (7) vs `end-push.ts`, `supervise-command.ts`, `preload.ts` (10) |
| C | {11} | 7 (`SKILL.md`, `skills.test.ts`), 9 (`server.ts`) | doctor, host-arg, push-tools, `mcp.test.ts`, README |
| D | {13} | all | `ideas.md`, `live-verification.md` |

Shared files, each owned by one task at a time: `src/services/dispatch-service.ts` (1, 3, 4), `src/adapters/codex/index.ts` and `test/adapters/codex.test.ts` (1, then 5), `src/services/notifier.ts` (2, then 10), `src/services/summary.ts` and `src/entry/runs-command.ts` (6, then 8), `src/entry/mcp/dispatch-tools.ts` (3, then 7), `plugin/skills/catherd/SKILL.md` and `test/skills.test.ts` (3, 7, then 11), `src/entry/mcp/server.ts` (9, then 11), `test/services/failover-cancel.test.ts` (1, then 3), `test/services/dispatch-thread.test.ts` (3, then 4). Files plans 21, 23 and 25 also touch (re-find hunks by context): `dispatch-service.ts`, `role-prompts.ts`, `supervisor.ts` (23's timeouts), `gate-service.test.ts` (23), `SKILL.md`, `dispatch-tools.ts` and `server.ts` (21's `E_ROLE_SCOPE`), `test/entry/mcp.test.ts`'s tool count (each plan's new tools), `live-verification.md`'s section number.

---

### Task 1: The 1.1 push minors (spec: "The 1.1 push minors")

`watch()` leaves a limit to the run's owner when its own session lost the run (Ruling 1); Codex's activity is computed once per line and a file change with no paths reads `edit`; Claude tool activity shows its first string argument (Ruling 2).

**Files:**
- Modify: `src/adapters/codex/index.ts`, `src/adapters/claude-code/index.ts`, `src/services/dispatch-service.ts`
- Test: `test/adapters/codex.test.ts`, `test/adapters/claude-code.test.ts`, `test/services/failover-cancel.test.ts`

**Interfaces:** none new. `watch()` now imports `currentSession` from `./sessions.ts`.

- [ ] **Step 1: Write the failing tests** (the three new `it` blocks in the test diffs below): `shows a file change with no paths as \`edit\`…`, `shows another tool with its first string argument…`, and in `failover-cancel.test.ts`'s "failover's stand-in, tied to its limited dispatch, launched once (N-3)" describe, `leaves a limit to the new owner when its session lost the run before it settled`.
- [ ] **Step 2: Run them and see them fail:** `bun test test/adapters/codex.test.ts test/adapters/claude-code.test.ts test/services/failover-cancel.test.ts` — the `edit ` trailing space, `Grep` alone, and a stand-in launched by the old owner.
- [ ] **Step 3: Make the code changes below.**
- [ ] **Step 4: Run the same command: all pass.**
- [ ] **Step 5: Commit** `fix(push): the 1.1 push minors: limit ownership in watch, activity lines`.

**Code (scratch commit `3b94ea2`):**

Modify `src/adapters/claude-code/index.ts`:

```diff
--- a/src/adapters/claude-code/index.ts
+++ b/src/adapters/claude-code/index.ts
@@ -245,7 +245,9 @@ function claudeActivity(e: Record<string, any>): string | undefined {
     if (typeof input.command === "string") return `$ ${input.command}`;
     if (typeof input.file_path === "string")
       return `${EDIT_TOOLS.has(c.name) ? "edit" : String(c.name)} ${input.file_path}`;
-    return String(c.name ?? "tool");
+    // another tool shows its first string argument, as opencode's activity does
+    const first = Object.values(input).find((v) => typeof v === "string");
+    return `${String(c.name ?? "tool")}${typeof first === "string" ? ` ${first}` : ""}`;
   }
   if (c?.type === "text" && typeof c.text === "string") return c.text;
   return undefined;
```

Modify `src/adapters/codex/index.ts`:

```diff
--- a/src/adapters/codex/index.ts
+++ b/src/adapters/codex/index.ts
@@ -245,7 +245,7 @@ function codexActivity(e: Record<string, any>): string | undefined {
     return `edit ${it.changes
       .map((c: { path?: unknown }) => c.path)
       .filter((p: unknown) => typeof p === "string")
-      .join(", ")}`;
+      .join(", ")}`.trimEnd();
   if (it.type === "agent_message" && typeof it.text === "string") return it.text;
   return undefined;
 }
@@ -265,12 +265,13 @@ export const codexAdapter: BackendAdapter = {
     // Not a todo_list: update_plan opens one that only completes with the turn, and would mute the watchdog
     const id = typeof e.item?.id === "string" && CODEX_TOOL_ITEMS.has(e.item.type) ? e.item.id : null;
     const open = e.type === "item.started" ? true : e.type === "item.completed" ? false : null;
+    const activity = codexActivity(e);
     return {
       ...(f.thread ? { thread: f.thread } : {}),
       ...(id !== null && open !== null ? { item: { id, open } } : {}),
       ...(e.type === "turn.completed" ? { tokens: f.tokens } : {}),
       lastEvent: f.lastEvent ?? undefined,
-      ...(codexActivity(e) ? { activity: codexActivity(e) } : {}),
+      ...(activity ? { activity } : {}),
       ...(f.turnFailed ? { failure: f.failure ?? "turn failed" } : {}),
       ...(f.limit ? { limit: true } : {}),
       ...(f.tooOld ? { tooOld: true } : {}),
```

Modify `src/services/dispatch-service.ts`:

```diff
--- a/src/services/dispatch-service.ts
+++ b/src/services/dispatch-service.ts
@@ -35,7 +35,7 @@ import { finalizeDispatch, finalizingElsewhere, waitForFinish } from "./finalize
 import type { Deps } from "./ports.ts";
 import { route } from "./lane-service.ts";
 import { findRun, readRecords, readRoutes, type Run } from "./run-store.ts";
-import { claimRun, ownsRun, runOwner } from "./sessions.ts";
+import { claimRun, currentSession, ownsRun, runOwner } from "./sessions.ts";
 import { type NotesPatch, refreshState } from "./state.ts";
 
 export interface DispatchInput {
@@ -176,7 +176,14 @@ export function watch(deps: Deps, run: Run, d: Dispatch): void {
   watching.add(d.admit.dispatchId);
   const w = (async () => {
     await waitForFinish(d, { pollMs: deps.pollMs, now: deps.now, onPoll: stallPoll(run, d) });
-    const s = await settle(deps, run, d, await finalizeDispatch(run, d));
+    const record = await finalizeDispatch(run, d);
+    // a session that lost the run since it dispatched leaves a limit to the owner's claim (1.1 push minors):
+    // only the run's owner starts a stand-in. A process with no session (a terminal) settles as before.
+    if (record.status === "limit" && currentSession(deps) !== null && !ownsRun(deps, run)) {
+      log("info", "dispatch", { run: run.id, name: d.admit.name, limit: "left to the run's owner" });
+      return;
+    }
+    const s = await settle(deps, run, d, record);
     if (s.stateHints[0]) log("warn", "dispatch", { run: run.id, name: d.admit.name, hint: s.stateHints[0] });
   })()
     .catch((e: unknown) =>
```

Modify `test/adapters/claude-code.test.ts`:

```diff
--- a/test/adapters/claude-code.test.ts
+++ b/test/adapters/claude-code.test.ts
@@ -211,6 +211,21 @@ describe("claude-code parse", () => {
     expect(lines("ok.jsonl").map((l) => claudeCodeAdapter.parse(l).activity)).toContain("hello");
   });
 
+  it("shows another tool with its first string argument, as opencode does (1.1 push minors)", () => {
+    const call = (name: string, input: Record<string, unknown>) =>
+      JSON.stringify({
+        type: "assistant",
+        message: { content: [{ type: "tool_use", id: "t1", name, input }] },
+      });
+    expect(claudeCodeAdapter.parse(call("Grep", { pattern: "TODO", path: "src" })).activity).toBe(
+      "Grep TODO",
+    );
+    expect(claudeCodeAdapter.parse(call("WebFetch", { url: "https://example.com" })).activity).toBe(
+      "WebFetch https://example.com",
+    );
+    expect(claudeCodeAdapter.parse(call("TodoWrite", { todos: [] })).activity).toBe("TodoWrite");
+  });
+
   it("reports the first request's own input from its assistant message, not the session's total", () => {
     const first = lines("read-only-write.jsonl")
       .map((l) => claudeCodeAdapter.parse(l).requestInput)
```

Modify `test/adapters/codex.test.ts`:

```diff
--- a/test/adapters/codex.test.ts
+++ b/test/adapters/codex.test.ts
@@ -64,6 +64,14 @@ describe("codex parse", () => {
     ]);
     expect(codexAdapter.parse('{"type":"turn.started"}').activity).toBeUndefined();
   });
+
+  it("shows a file change with no paths as `edit`, with no trailing space (1.1 push minors)", () => {
+    const line = JSON.stringify({
+      type: "item.completed",
+      item: { id: "item_9", type: "file_change", changes: [] },
+    });
+    expect(codexAdapter.parse(line).activity).toBe("edit");
+  });
 });
 
 describe("codex plan", () => {
```

Modify `test/services/failover-cancel.test.ts`:

```diff
--- a/test/services/failover-cancel.test.ts
+++ b/test/services/failover-cancel.test.ts
@@ -424,6 +424,27 @@ describe("failover's stand-in, tied to its limited dispatch, launched once (N-3)
     }
   });
 
+  it("leaves a limit to the new owner when its session lost the run before it settled (1.1 push minors)", async () => {
+    const release = held();
+    const { run } = setup({ ...LIMIT, holdUntil: release });
+    const deps = await owned(run);
+    const limited = (await dispatch(deps, input(run.id))).dispatched;
+    // another session takes the run while the limited role still runs
+    const other = fakeDeps({
+      view: testView({ failover: FAILOVER }),
+      session: { sessionId: "s-other", hostSessionId: null, socketPath: null, token: null },
+    });
+    await claimRun(other, run);
+    writeFileSync(release, "");
+    await watchersSettled();
+    const d = listDispatches(run).find((x) => x.admit.dispatchId === limited.dispatchId) as Dispatch;
+    expect(readRecords(run).records.find((r) => r.dispatchId === limited.dispatchId)?.status).toBe("limit");
+    // the old owner's watcher recorded it and left the failover to the run's owner
+    expect(readFailover(d.dir)).toBeNull();
+    expect(standInOf(run)).toBeUndefined();
+    expect(awaitsCollect(d.dir)).toBe(true);
+  });
+
   it("never hands one limited dispatch's stand-in to another of the same name and rung", async () => {
     const release = held();
     const { run, deps } = setup({ ...DONE, holdUntil: release });
```

### Task 2: Every catherd message names the thread (spec: "The notice carries the thread", first half)

`Notice` gains `thread: string | null`. Each block's header ends `· thread: <id>` (`thread: none` before the CLI named one); a multi-role message's preview line names each role's thread. `finishedNotice` takes the record's thread; `stalledNotice` the admission's, else the first `thread` its adapter reads from `events.jsonl` (Ruling 3).

**Files:**
- Modify: `src/domain/notice.ts`, `src/services/notifier.ts`
- Test: `test/domain/notice.test.ts`, `test/services/notifier.test.ts`

**Interfaces:** produces `Notice.thread` (Task 10's message carries it; `peek`'s `unread[].header` carries it through `noticeHeader`).

- [ ] **Step 1: Update the expectations in `test/domain/notice.test.ts` and the two preview strings in `test/services/notifier.test.ts`, and add the `the notice names the thread (plan 22)` describe** (diffs below).
- [ ] **Step 2: Run** `bun test test/domain/notice.test.ts test/services/notifier.test.ts` — fails (type error on `thread`, headers without it).
- [ ] **Step 3: Make the code changes below.**
- [ ] **Step 4: Run** `bun test test/domain/notice.test.ts test/services/notifier.test.ts test/services/peek.test.ts test/integration/mcp-stdio.test.ts` — all pass.
- [ ] **Step 5: Commit** `feat(push): the first line of every catherd message names the thread`.

**Code (scratch commit `a6ca3e2`):**

Modify `src/domain/notice.ts`:

```diff
--- a/src/domain/notice.ts
+++ b/src/domain/notice.ts
@@ -17,6 +17,8 @@ export interface Notice {
   role: string;
   /** the lane it worked, when it had one: the multi-role preview names it */
   lane: string | null;
+  /** the role's thread, so a fix round resumes it without reading runs.jsonl; null before the CLI named one */
+  thread: string | null;
   rung: string;
   /** the record's status, or for a limit what failover did ("limit on X; failed over to Y"), or the event */
   status: string;
@@ -34,15 +36,19 @@ export const REPLY_CAP = 2_000;
 
 const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
 
+/** `thread: <id>`, or `thread: none` before the CLI named one: every message's first line carries it. */
+const threadWord = (n: Notice): string => `thread: ${n.thread ?? "none"}`;
+
 /** The first line of one role's block: it must stand alone, since the Desktop preview shows only it. */
 export function noticeHeader(n: Notice): string {
   const head = `catherd · ${n.runTitle} · ${n.name} ${n.role} · ${n.rung} · ${n.status}`;
-  if (n.kind === "stalled") return `${head} · running ${n.secs}s`;
+  if (n.kind === "stalled") return `${head} · running ${n.secs}s · ${threadWord(n)}`;
   return [
     head,
     n.replyStatus ? `STATUS: ${n.replyStatus}` : "no STATUS",
     `${n.secs}s`,
     plural(n.changedOwned, "owned file changed", "owned files changed"),
+    threadWord(n),
   ].join(" · ");
 }
 
@@ -78,7 +84,8 @@ function previewOf(ns: Notice[]): string {
     ? `${ns.length} roles finished`
     : `${plural(ns.length, "role", "roles")} to look at`;
   const each = ns.map(
-    (n) => `${n.lane ?? n.name} ${n.kind === "stalled" ? "stalled" : n.status.split(";")[0]}`,
+    (n) =>
+      `${n.lane ?? n.name} ${n.kind === "stalled" ? "stalled" : n.status.split(";")[0]} (${threadWord(n)})`,
   );
   return `catherd · ${where} · ${what}: ${each.join(", ")}`;
 }
```

Modify `src/services/notifier.ts`:

```diff
--- a/src/services/notifier.ts
+++ b/src/services/notifier.ts
@@ -1,5 +1,7 @@
 import { existsSync, readFileSync } from "node:fs";
 import { join } from "node:path";
+import { adapterFor } from "../adapters/registry.ts";
+import "../adapters/all.ts";
 import { CatherdError, errorMessage } from "../domain/errors.ts";
 import { envelope, formatNotices, type Notice, type NoticePriority, priorityOf } from "../domain/notice.ts";
 import { sessionKey, type HostSessionRef } from "../domain/host.ts";
@@ -15,7 +17,7 @@ import { awaitsCollect, dispatchPaths } from "../infra/dispatch-dir.ts";
 import { tryLock } from "../infra/filelock.ts";
 import { log } from "../infra/log.ts";
 import { type SendResult, sendToInbox } from "../infra/peer-inbox.ts";
-import { writeJsonAtomic } from "../infra/store.ts";
+import { nonBlankLines, writeJsonAtomic } from "../infra/store.ts";
 import {
   readStallQuietMs,
   type Settled,
@@ -119,6 +121,7 @@ export function finishedNotice(run: Run, d: Dispatch, r: RunRecord): Notice {
     name: r.name,
     role: r.role,
     lane: r.lane,
+    thread: r.thread,
     rung: r.rung,
     status,
     replyStatus: r.replyStatus,
@@ -129,6 +132,21 @@ export function finishedNotice(run: Run, d: Dispatch, r: RunRecord): Notice {
   };
 }
 
+/** A live fresh role's thread, as its CLI named it early in its stream; null before it did. */
+function streamThread(d: Dispatch): string | null {
+  const a = adapterFor(d.admit.backend);
+  if (!a) return null;
+  for (const line of nonBlankLines(dispatchPaths(d.dir).events)) {
+    try {
+      const t = a.parse(line).thread;
+      if (t) return t;
+    } catch {
+      // a line the adapter cannot read names no thread
+    }
+  }
+  return null;
+}
+
 /** Spec §3.6: a live role that went quiet, once, at `next`. */
 export function stalledNotice(run: Run, d: Dispatch, quietMs: number, now: number): Notice {
   return {
@@ -140,6 +158,7 @@ export function stalledNotice(run: Run, d: Dispatch, quietMs: number, now: numbe
     name: d.admit.name,
     role: d.admit.role,
     lane: d.admit.lane,
+    thread: d.admit.thread ?? streamThread(d),
     rung: d.admit.rung,
     status: `stalled: no output for ${Math.max(1, Math.round(quietMs / 60_000))} min`,
     replyStatus: null,
```

Modify `test/domain/notice.test.ts`:

```diff
--- a/test/domain/notice.test.ts
+++ b/test/domain/notice.test.ts
@@ -17,6 +17,7 @@ const notice = (o: Partial<Notice> = {}): Notice => ({
   name: "worker-M1.L1",
   role: "worker",
   lane: "M1.L1",
+  thread: "019a0c1e-5b7a-7d10-9a4e-2f1c3d4e5f60",
   rung: "codex:gpt-6-sol#medium",
   status: "ok",
   replyStatus: "complete",
@@ -30,17 +31,18 @@ const notice = (o: Partial<Notice> = {}): Notice => ({
 describe("the push message (spec §3.5)", () => {
   it("puts everything on a first line that stands alone", () => {
     expect(noticeHeader(notice())).toBe(
-      "catherd · Auth plan 5 MR B · worker-M1.L1 worker · codex:gpt-6-sol#medium · ok · STATUS: complete · 312s · 3 owned files changed",
+      "catherd · Auth plan 5 MR B · worker-M1.L1 worker · codex:gpt-6-sol#medium · ok · STATUS: complete · 312s · 3 owned files changed · thread: 019a0c1e-5b7a-7d10-9a4e-2f1c3d4e5f60",
     );
     expect(noticeHeader(notice({ replyStatus: null, changedOwned: 1 }))).toContain(
       "· ok · no STATUS · 312s · 1 owned file changed",
     );
+    expect(noticeHeader(notice({ thread: null }))).toEndWith(" · thread: none");
   });
 
   it("carries the reply and the call that reads the record", () => {
     expect(formatNotices([notice()])).toBe(
       [
-        "catherd · Auth plan 5 MR B · worker-M1.L1 worker · codex:gpt-6-sol#medium · ok · STATUS: complete · 312s · 3 owned files changed",
+        "catherd · Auth plan 5 MR B · worker-M1.L1 worker · codex:gpt-6-sol#medium · ok · STATUS: complete · 312s · 3 owned files changed · thread: 019a0c1e-5b7a-7d10-9a4e-2f1c3d4e5f60",
         "Done: added the kit.",
         "STATUS: complete — kit in place",
         'Record: result(run: "20260928-100000-auth", name: "worker-M1.L1")',
@@ -62,7 +64,7 @@ describe("the push message (spec §3.5)", () => {
   it("sends several roles as one message: a preview line, then one block each", () => {
     const text = formatNotices([
       notice(),
-      notice({ name: "worker-M1.L2", lane: "M1.L2", dispatchId: "d2" }),
+      notice({ name: "worker-M1.L2", lane: "M1.L2", dispatchId: "d2", thread: null }),
       notice({
         name: "worker-M1.L3",
         lane: "M1.L3",
@@ -72,7 +74,7 @@ describe("the push message (spec §3.5)", () => {
     ]);
     const [preview, ...blocks] = text.split("\n\n");
     expect(preview).toBe(
-      "catherd · Auth plan 5 MR B · 3 roles finished: M1.L1 ok, M1.L2 ok, M1.L3 limit on codex:gpt-6-sol#medium",
+      "catherd · Auth plan 5 MR B · 3 roles finished: M1.L1 ok (thread: 019a0c1e-5b7a-7d10-9a4e-2f1c3d4e5f60), M1.L2 ok (thread: none), M1.L3 limit on codex:gpt-6-sol#medium (thread: 019a0c1e-5b7a-7d10-9a4e-2f1c3d4e5f60)",
     );
     expect(blocks).toHaveLength(3);
     expect(blocks[2]).toContain("limit on codex:gpt-6-sol#medium; failed over to codex:gpt-6-sol#high");
@@ -90,7 +92,7 @@ describe("the push message (spec §3.5)", () => {
     ]);
     expect(text).toBe(
       [
-        "catherd · Auth plan 5 MR B · worker-M1.L1 worker · codex:gpt-6-sol#medium · stalled: no output for 7 min · running 900s",
+        "catherd · Auth plan 5 MR B · worker-M1.L1 worker · codex:gpt-6-sol#medium · stalled: no output for 7 min · running 900s · thread: 019a0c1e-5b7a-7d10-9a4e-2f1c3d4e5f60",
         'Peek: peek(run: "20260928-100000-auth", name: "worker-M1.L1")',
         'Event: ["20260928-100000-auth","d1","finished"]',
       ].join("\n"),
```

Modify `test/services/notifier.test.ts`:

```diff
--- a/test/services/notifier.test.ts
+++ b/test/services/notifier.test.ts
@@ -764,6 +764,22 @@ function writeJsonAtomicForExit(dir: string) {
   store.writeJsonAtomic(dispatchPaths(dir).exit, { schema: 1, ...exit() });
 }
 
+describe("the notice names the thread (plan 22)", () => {
+  it("puts the record's thread, or a live role's streamed one, on the first line", async () => {
+    const { run } = freshRun("Auth plan 5 MR B");
+    const events = readFileSync(join(FX, "ok-with-reconnect.jsonl"), "utf8");
+    const d = await fakeDispatch(run, {}, { proc: "dead", exit: exit(), events, collect: true });
+    const record = await finalizeDispatch(run, d);
+    expect(record.thread).toBe("01a0d0d4-d0a6-71a1-983c-82a9169200b4");
+    expect(finishedNotice(run, d, record).thread).toBe(record.thread);
+    // a fresh live role has no thread in its admission: the stream's thread.started names it
+    const live = await fakeDispatch(run, { name: "worker-M1.L2", lane: "M1.L2" }, { proc: "self", events });
+    expect(stalledNotice(run, live, 60_000, Date.now()).thread).toBe(record.thread);
+    const quiet = await fakeDispatch(run, { name: "worker-M1.L3", lane: "M1.L3" }, { proc: "self" });
+    expect(stalledNotice(run, quiet, 60_000, Date.now()).thread).toBeNull();
+  });
+});
+
 describe("the notifier (spec §3.4–§3.6)", () => {
   it("announces a finished role of a run this session owns, at later, and writes notified.json", async () => {
     const { run, deps, n } = await owned();
@@ -798,7 +814,9 @@ describe("the notifier (spec §3.4–§3.6)", () => {
     await n.idle();
     const [f] = await (inbox as FakeInbox).received(1);
     expect(inbox?.frames).toHaveLength(1);
-    expect(f?.message.content).toContain("catherd · Auth plan 5 MR B · 2 roles finished: M1.L1 ok, M1.L2 ok");
+    expect(f?.message.content).toContain(
+      "catherd · Auth plan 5 MR B · 2 roles finished: M1.L1 ok (thread: none), M1.L2 ok (thread: none)",
+    );
   });
 
   it("sends a role that finishes after the message went as a message of its own", async () => {
@@ -888,7 +906,9 @@ describe("the notifier (spec §3.4–§3.6)", () => {
     await n.idle();
     const [f] = await (inbox as FakeInbox).received(1);
     expect(inbox?.frames).toHaveLength(1);
-    expect(f?.message.content).toContain("2 roles finished: M1.L1 ok, M1.L2 ok");
+    expect(f?.message.content).toContain(
+      "2 roles finished: M1.L1 ok (thread: none), M1.L2 ok (thread: none)",
+    );
     expect([a, b, read].map((d) => existsSync(dispatchPaths(d.dir).notified))).toEqual([true, true, false]);
   });
```

### Task 3: `thread: "latest"`, and a thread the name never ran on is refused (spec: "The notice carries the thread", second half; X3)

`dispatch()` resolves `thread` before it claims the run (`threadFor`, Ruling 4): `"latest"` is the name's last recorded thread; any other id must be one of the name's records in `runs.jsonl`, case-insensitively, else `E_ADMIT_THREAD` with a fix naming `thread: "latest"` and the last thread. The `dispatch` tool description and the skill's Threads section say so. Three existing tests resumed a thread with no record for their name: they now seed one (`seedThread`) or resume under the same name.

**Files:**
- Modify: `src/services/dispatch-service.ts`, `src/entry/mcp/dispatch-tools.ts`, `plugin/skills/catherd/SKILL.md`
- Create: `test/services/dispatch-thread.test.ts`
- Modify (tests): `test/services/helpers.ts` (`seedThread`), `test/services/claude-code-dispatch.test.ts`, `test/services/grok-dispatch.test.ts`, `test/services/failover-cancel.test.ts`

**Interfaces:** produces `seedThread(run, name, thread, over?)` in `test/services/helpers.ts`; `DispatchInput.thread` accepts `"latest"`.

- [ ] **Step 1: Write `test/services/dispatch-thread.test.ts` as below and add `seedThread` to the helpers.**
- [ ] **Step 2: Run** `bun test test/services/dispatch-thread.test.ts` — fails: `"latest"` reaches admission as a thread id, an unknown id is launched.
- [ ] **Step 3: Make the code changes below** (`dispatch-service.ts`, `dispatch-tools.ts`, `SKILL.md`), then the three test fixes.
- [ ] **Step 4: Run** `bun test test/services/dispatch-thread.test.ts test/services/claude-code-dispatch.test.ts test/services/grok-dispatch.test.ts test/services/failover-cancel.test.ts test/services/adapter-hooks.test.ts test/services/antigravity-dispatch.test.ts test/services/dispatch.test.ts test/integration/mcp-stdio.test.ts test/skills.test.ts` — all pass.
- [ ] **Step 5: Commit** `feat(dispatch): thread "latest" and a thread the name never ran on is refused`.

**Code (scratch commit `d55a3ad`):**

Modify `plugin/skills/catherd/SKILL.md`:

```diff
--- a/plugin/skills/catherd/SKILL.md
+++ b/plugin/skills/catherd/SKILL.md
@@ -169,7 +169,7 @@ A failure on the top rung (`top: true`) goes to the architect when Jev calls it
 
 A resumed thread replays its whole history on every tool call. In the first real run, one worker thread cost 20–25M input tokens per resume, and threads were 90% of the Codex spend.
 
-- **Resume a thread only for its own fix round:** the reviewer's findings on that piece, or the verifier's FAIL, at the same rung. That is `dispatch(…, thread: <record.thread>)`, with the fix as the brief.
+- **Resume a thread only for its own fix round:** the reviewer's findings on that piece, or the verifier's FAIL, at the same rung. That is `dispatch(…, thread: <record.thread>)`, with the fix as the brief: the `thread:` the first line of its catherd message names, or `thread: "latest"` for that name's last thread. A thread that name never ran on in the run is refused (`E_ADMIT_THREAD`).
 - **A new piece of work gets a fresh thread,** even for the same worker role: a new bug, a cleanup slice, a docs pass, a re-run, a climb to the next rung. Its brief carries what it needs, from its lane file and the ledger.
 - A `thread-heavy` hint means that thread is spent. Its next piece starts fresh.
```

Modify `src/entry/mcp/dispatch-tools.ts`:

```diff
--- a/src/entry/mcp/dispatch-tools.ts
+++ b/src/entry/mcp/dispatch-tools.ts
@@ -12,7 +12,7 @@ export function registerDispatchTools(server: McpServer, deps: Deps): void {
     "dispatch",
     {
       description:
-        "Start one role on a process backend (codex, claude-code, opencode) and return at launch, in about a second, with { dispatched: { name, role, rung, dispatchId, admittedAt }, hints }; the role runs on. When it finishes, catherd sends this session a <cross-session-message from-name=\"catherd\"> naming the run, the role and its status, and result(run, name) reads the record. Dispatch every independent role one after another, then end your turn. The brief is the text itself; dispatch appends the role's reply contract (reply length and the STATUS line), so do not write it. With lane, the lane file's Owns: paths guard against overlapping lanes, and a lane not yet routed is routed first (a rung off its routed ladder starts at the routed rung, with a hint). thread resumes that role's thread for its own fix round. Refused with a structured error (E_ADMIT_*, E_RUN_BUDGET, E_BACKEND_*) before anything starts. Call it from the main thread.",
+        "Start one role on a process backend (codex, claude-code, opencode) and return at launch, in about a second, with { dispatched: { name, role, rung, dispatchId, admittedAt }, hints }; the role runs on. When it finishes, catherd sends this session a <cross-session-message from-name=\"catherd\"> naming the run, the role and its status, and result(run, name) reads the record. Dispatch every independent role one after another, then end your turn. The brief is the text itself; dispatch appends the role's reply contract (reply length and the STATUS line), so do not write it. With lane, the lane file's Owns: paths guard against overlapping lanes, and a lane not yet routed is routed first (a rung off its routed ladder starts at the routed rung, with a hint). thread resumes that role's thread for its own fix round: the thread its catherd message names, or \"latest\" for the name's last thread; a thread the name never ran on in this run is refused (E_ADMIT_THREAD). Refused with a structured error (E_ADMIT_*, E_RUN_BUDGET, E_BACKEND_*) before anything starts. Call it from the main thread.",
       inputSchema: {
         run: z.string(),
         role: z.enum(ROLES),
```

Modify `src/services/dispatch-service.ts`:

```diff
--- a/src/services/dispatch-service.ts
+++ b/src/services/dispatch-service.ts
@@ -288,12 +288,41 @@ function unannounced(run: Run): { d: Dispatch; record: RunRecord }[] {
   });
 }
 
+/**
+ * Plan 22: the thread a dispatch resumes. `"latest"` is the name's last recorded thread; any other id must be one
+ * the name's records in this run hold (`runs.jsonl`), in any case, so a wrong id is refused before a CLI starts
+ * and fails on it. Null for a fresh thread.
+ */
+function threadFor(run: Run, name: string, thread: string | undefined): string | null {
+  if (thread === undefined) return null;
+  assertId("role name", name);
+  const mine = readRecords(run)
+    .records.filter((r) => r.name === name && r.thread !== null)
+    .map((r) => r.thread as string);
+  const last = mine.at(-1);
+  if (thread === "latest") {
+    if (last) return last;
+    throw new CatherdError("E_ADMIT_THREAD", `${name} has no earlier thread in this run`, {
+      fix: "omit thread for a fresh thread",
+    });
+  }
+  const known = mine.findLast((t) => t.toLowerCase() === thread.toLowerCase());
+  if (known) return known;
+  throw new CatherdError("E_ADMIT_THREAD", `${thread} is not a thread of ${name} in this run`, {
+    fix: last
+      ? `pass thread: "latest" for ${name}'s last thread (${last}), or omit thread for a fresh one`
+      : "omit thread for a fresh thread",
+  });
+}
+
 /**
  * Spec §4.4, plan 9 ruling 1: admit and launch one role, start its watcher, then refresh state.md with
  * `next` (after the launch, so nothing delays it). Returns at once; catherd announces the record (spec §3).
  */
 export async function dispatch(deps: Deps, i: DispatchInput): Promise<DispatchStarted> {
   const run = findRun(i.run);
+  // refused before the claim, so a wrong thread changes nothing
+  const thread = threadFor(run, i.name, i.thread);
   await claim(deps, run);
   const hints: string[] = [];
   let rung = i.rung;
@@ -316,7 +345,7 @@ export async function dispatch(deps: Deps, i: DispatchInput): Promise<DispatchSt
       name: i.name,
       brief: i.brief,
       rung,
-      thread: i.thread ?? null,
+      thread,
       lane: i.lane ?? null,
       failoverFrom: null,
     },
```

Modify `test/services/claude-code-dispatch.test.ts`:

```diff
--- a/test/services/claude-code-dispatch.test.ts
+++ b/test/services/claude-code-dispatch.test.ts
@@ -9,7 +9,7 @@ import { latestDispatch } from "../../src/services/dispatches.ts";
 import { snapshotEnv } from "../helpers.ts";
 import { simPath } from "../sim/scenario.ts";
 import { type ClaudeScenario, withClaudeScenario } from "../sim/sim-scenarios.ts";
-import { fakeDeps, freshRun, runRole, testView, writeLane } from "./helpers.ts";
+import { fakeDeps, freshRun, runRole, seedThread, testView, writeLane } from "./helpers.ts";
 
 afterEach(snapshotEnv());
 beforeEach(() => resetReadiness());
@@ -73,6 +73,7 @@ describe("dispatch on claude-code (simulator)", () => {
   it("resumes a fix round on the same session", async () => {
     const thread = "670d1ec2-db2b-471f-a1a5-3cda1416c061";
     const { run, sim, deps } = setup({ eventsFile: join(FX, "resume.jsonl") });
+    await seedThread(run, "worker-M1.L1", thread, { backend: "claude-code", rung: RUNG });
     const { record } = await runRole(deps, input(run.id, { thread, brief: "Fix: BUG src/a.ts:1" }));
     expect(record).toMatchObject({ status: "ok", thread });
     expect(sim.recorded().args).toContain("--resume");
```

Create `test/services/dispatch-thread.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { isCatherdError } from "../../src/domain/errors.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { dispatch, type DispatchInput, watchersSettled } from "../../src/services/dispatch-service.ts";
import { listDispatches } from "../../src/services/dispatches.ts";
import { readRecords } from "../../src/services/run-store.ts";
import { snapshotEnv } from "../helpers.ts";
import { type CodexScenario, simPath, withScenario } from "../sim/scenario.ts";
import { fakeDeps, freshRun, runRole, writeLane } from "./helpers.ts";

afterEach(() => watchersSettled());
afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
const THREAD = "01a0d0d4-d0a6-71a1-983c-82a9169200b4";
const OK = { eventsFile: join(FX, "ok-with-reconnect.jsonl"), reply: "Done.\nSTATUS: complete — ok" };

function setup(s: CodexScenario = OK) {
  const { run } = freshRun();
  process.env.PATH = simPath();
  const scenario = withScenario(s);
  Object.assign(process.env, scenario.env);
  writeLane(run, "M1.L1", ["src/a.ts"]);
  return { run, deps: fakeDeps(), recorded: scenario.recorded };
}

const input = (run: string, over: Partial<DispatchInput> = {}): DispatchInput => ({
  run,
  role: "worker",
  name: "worker-M1.L1",
  brief: "Read lanes/M1.L1.md",
  rung: "codex:gpt-6-luna#high",
  lane: "M1.L1",
  ...over,
});

async function refused(p: Promise<unknown>): Promise<{ code: string; message: string; fix?: string }> {
  try {
    await p;
  } catch (e) {
    if (isCatherdError(e)) return { code: e.code, message: e.message, fix: e.fix };
    throw e;
  }
  throw new Error("not refused");
}

describe("dispatch's thread (plan 22: the notice carries the thread)", () => {
  it('resumes the name\'s last thread for thread: "latest"', async () => {
    const { run, deps, recorded } = setup();
    const first = await runRole(deps, input(run.id));
    expect(first.record.thread).toBe(THREAD);
    const again = await runRole(deps, input(run.id, { brief: "Fix the finding", thread: "latest" }));
    expect(again.record.thread).toBe(THREAD);
    const last = listDispatches(run).find((d) => d.admit.dispatchId === again.record.dispatchId);
    expect(last?.admit.thread).toBe(THREAD);
    const args = recorded().args;
    expect(args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(args).toContain(THREAD);
  });

  it("refuses a thread the name never ran on in this run, before anything starts", async () => {
    const { run, deps } = setup();
    await runRole(deps, input(run.id));
    const other = "0199c011-1234-7000-8000-00000000beef";
    const e = await refused(dispatch(deps, input(run.id, { thread: other })));
    expect(e.code).toBe("E_ADMIT_THREAD");
    expect(e.message).toBe(`${other} is not a thread of worker-M1.L1 in this run`);
    expect(e.fix).toContain('thread: "latest"');
    expect(e.fix).toContain(THREAD);
    // another name's thread is not this name's
    const theirs = await refused(
      dispatch(deps, input(run.id, { name: "worker-M1.L1-fix", lane: undefined, thread: THREAD })),
    );
    expect(theirs.code).toBe("E_ADMIT_THREAD");
    expect(listDispatches(run)).toHaveLength(1);
    expect(readRecords(run).records).toHaveLength(1);
  });

  it('refuses thread: "latest" for a name with no thread yet, and matches a thread in any case', async () => {
    const { run, deps } = setup();
    const none = await refused(dispatch(deps, input(run.id, { thread: "latest" })));
    expect(none).toMatchObject({
      code: "E_ADMIT_THREAD",
      message: "worker-M1.L1 has no earlier thread in this run",
    });
    await runRole(deps, input(run.id));
    const upper = await runRole(deps, input(run.id, { thread: THREAD.toUpperCase() }));
    expect(upper.record.thread).toBe(THREAD);
  });
});
```

Modify `test/services/failover-cancel.test.ts`:

```diff
--- a/test/services/failover-cancel.test.ts
+++ b/test/services/failover-cancel.test.ts
@@ -47,6 +47,7 @@ import {
   fakeGit,
   freshRun,
   runRole,
+  seedThread,
   testView,
   waitFor,
   writeLane,
@@ -220,6 +221,7 @@ describe("failover (spec §3.4: it runs as soon as a limit is settled)", () => {
 
   it("hands a fix round's stand-in the lane file and the fix brief by path, both of which exist", async () => {
     const { run, deps } = setup({ byRung: { "gpt-6-sol#medium": LIMIT, "gpt-6-sol#high": DONE } });
+    await seedThread(run, "worker-M1.L1", "t-earlier-thread");
     const { record } = await runRole(
       deps,
       input(run.id, { thread: "t-earlier-thread", brief: "Fix: BUG src/a.ts:3 — off by one" }),
```

Modify `test/services/grok-dispatch.test.ts`:

```diff
--- a/test/services/grok-dispatch.test.ts
+++ b/test/services/grok-dispatch.test.ts
@@ -89,15 +89,13 @@ describe("dispatch on grok (simulator)", () => {
     const { run, sim, deps } = setup({ eventsFile: join(FX, "ok.jsonl") });
     const first = (await runRole(deps, input(run.id))).record;
     sim.rewrite({ eventsFile: join(FX, "resume.jsonl"), sessionSandbox: "catherd-ws" });
-    const again = await runRole(deps, input(run.id, { name: "worker-M1.L1b", thread: first.thread ?? "" }));
+    const again = await runRole(deps, input(run.id, { thread: first.thread ?? "" }));
     expect(again.record).toMatchObject({ status: "ok", thread: first.thread });
     expect(sim.recorded().args.slice(-2)).toEqual(["-r", first.thread as string]);
     expect(sim.recorded().args).not.toContain("--sandbox");
     // spec 1.3 §3.2: grok refuses another sandbox on resume, so admission refuses it first
     deps.view.roles.worker = { enabled: true, access: "read-only", rungs: [RUNG] };
-    expect(
-      await code(dispatch(deps, input(run.id, { name: "worker-M1.L1c", thread: first.thread ?? "" }))),
-    ).toBe("E_ADMIT_THREAD");
+    expect(await code(dispatch(deps, input(run.id, { thread: first.thread ?? "" })))).toBe("E_ADMIT_THREAD");
   });
 
   it("refuses an isolated run without XAI_API_KEY, and runs one with it under catherd's HOME", async () => {
```

Modify `test/services/helpers.ts`:

```diff
--- a/test/services/helpers.ts
+++ b/test/services/helpers.ts
@@ -135,6 +135,30 @@ export function writeLane(
   return file;
 }
 
+/**
+ * A finished, read record of `name` on `thread`, so `dispatch(…, thread)` may resume it (plan 22: a thread must
+ * be one of the name's records in this run).
+ */
+export async function seedThread(
+  run: Run,
+  name: string,
+  thread: string,
+  over: Partial<RunRecord> = {},
+): Promise<RunRecord> {
+  const dispatchId = newDispatchId();
+  return appendRecord(
+    run,
+    makeRecord({
+      runId: run.id,
+      dispatchId,
+      name,
+      thread,
+      replyPath: `roles/${name}/${dispatchId}/reply.md`,
+      ...over,
+    }),
+  );
+}
+
 export async function waitFor<T>(f: () => T | null | undefined | false, ms = 15_000): Promise<T> {
   const end = Date.now() + ms;
   for (;;) {
```

### Task 4: Resume hygiene (spec: "Resume hygiene"; exit 143)

The worker's reply contract and its native prompt start "Before you reply, leave nothing running: …" (Ruling 6). Before a resume, `dispatch` stops the process group of each finished dispatch on that thread whose leader pid no longer answers while the group lives, and returns a `resume: stopped …` hint (Ruling 5). `groupAlive` and `stopGroup` in `src/infra/supervisor.ts` become exports.

**Files:**
- Modify: `src/domain/role-prompts.ts`, `src/infra/supervisor.ts`, `src/services/dispatch-service.ts`
- Test: `test/services/dispatch-thread.test.ts` (the `resume hygiene` describe), `test/services/dispatch-protocol.test.ts`

**Interfaces:** consumes Task 3's `threadFor` result; exports `groupAlive(pgid)`, `stopGroup(pgid, graceMs, pollMs)`.

- [ ] **Step 1: Add the `resume hygiene (plan 22: a resumed worker exits 143)` describe and update `dispatch-protocol.test.ts`** (diffs below).
- [ ] **Step 2: Run** `bun test test/services/dispatch-thread.test.ts test/services/dispatch-protocol.test.ts` — fails: the left `sleep 60` still lives, no hint, the contract has no sentence.
- [ ] **Step 3: Make the code changes below.**
- [ ] **Step 4: Run** `bun test test/services/dispatch-thread.test.ts test/services/dispatch-protocol.test.ts test/domain test/services/admission.test.ts test/services/claude-code-dispatch.test.ts test/plugin.test.ts` — all pass.
- [ ] **Step 5: Commit** `fix(dispatch): stop what a thread's last turn left running before a resume`.

**Code (scratch commit `38f22c4`):**

Modify `src/domain/role-prompts.ts`:

```diff
--- a/src/domain/role-prompts.ts
+++ b/src/domain/role-prompts.ts
@@ -10,6 +10,12 @@ const RUN_FILES =
 const REPLY =
   "Do not commit. Reply in at most 15 lines: results, file:line, and evidence as a log path, not the log. The last line of your reply is: STATUS: complete|partial|blocked|refused — <one line why>";
 
+/**
+ * Plan 22, resume hygiene: a worker's thread may be resumed for its fix round, and a command its last turn left
+ * running in the background ends the resumed CLI (exit 143).
+ */
+const WORKER_REPLY = `Before you reply, leave nothing running: stop every server, watcher or command you started in the background. ${REPLY}`;
+
 const architect = [
   "You are the architect of a catherd run. The orchestrator gave you the goal, the acceptance lines, the run id, and usually a dossier: a researcher's map of the code this work touches. Workers are other models that run in the project directory with no memory of this conversation. They will write every line of code from your plan.",
   "",
@@ -79,7 +85,7 @@ const worker = (version: string) =>
     "",
     `Change only the files you own. Run your fast check until it passes. Run the full suite only if the brief says so, and wrap any full build or full test suite in: bunx catherd-cli@${version} lock -- <command>. Other lanes share this machine.`,
     "",
-    REPLY,
+    WORKER_REPLY,
   ].join("\n");
 
 const reviewer = [
@@ -149,7 +155,7 @@ const STATUS_LINE =
 const CONTRACTS: Record<Role, string> = {
   architect: `Reply briefly: the milestones, each with its lanes as Mx.Ly — one line — owned files, and the full-check command. ${STATUS_LINE}`,
   verifier: `The first line of your reply is VERDICT: PASS or VERDICT: FAIL. ${STATUS_LINE}`,
-  worker: REPLY,
+  worker: WORKER_REPLY,
   reviewer: REPLY,
   "ui-reviewer": REPLY,
   artist: REPLY,
```

Modify `src/infra/supervisor.ts`:

```diff
--- a/src/infra/supervisor.ts
+++ b/src/infra/supervisor.ts
@@ -79,7 +79,7 @@ async function bounded<T>(call: () => Promise<T> | undefined, ms: number, fallba
   }
 }
 
-function groupAlive(pgid: number): boolean {
+export function groupAlive(pgid: number): boolean {
   try {
     process.kill(-pgid, 0);
     return true;
@@ -89,7 +89,7 @@ function groupAlive(pgid: number): boolean {
 }
 
 /** SIGTERM the group, give it `graceMs` to leave, then SIGKILL whatever is left of it. */
-async function stopGroup(pgid: number, graceMs: number, pollMs: number): Promise<void> {
+export async function stopGroup(pgid: number, graceMs: number, pollMs: number): Promise<void> {
   killGroup(pgid, "SIGTERM");
   const end = Date.now() + graceMs;
   while (Date.now() < end && groupAlive(pgid))
```

Modify `src/services/dispatch-service.ts`:

```diff
--- a/src/services/dispatch-service.ts
+++ b/src/services/dispatch-service.ts
@@ -16,6 +16,7 @@ import {
 import { lockHeld, withFileLock } from "../infra/filelock.ts";
 import { log } from "../infra/log.ts";
 import { isAlive, isSurelyAlive, killGroup } from "../infra/proc.ts";
+import { groupAlive, stopGroup } from "../infra/supervisor.ts";
 import { writeJsonAtomic } from "../infra/store.ts";
 import { admit, KILL_GRACE_MS, laneFile, launch } from "./admission.ts";
 import { standInFor } from "./backends.ts";
@@ -315,6 +316,30 @@ function threadFor(run: Run, name: string, thread: string | undefined): string |
   });
 }
 
+/**
+ * Plan 22, resume hygiene: what an earlier turn on `thread` left running in its process group (a server, a
+ * watcher, a background command) is stopped before the thread is resumed, so it never ends the resumed CLI
+ * (exit 143). Only a finished dispatch whose group leader is gone is touched: a live group with no process of the
+ * leader's pid can only be that dispatch's leftovers (a pid is never reused while its group lives), and a pid
+ * that answers belongs to someone else by now. Returns a hint per group stopped.
+ */
+async function stopLeftovers(deps: Deps, run: Run, thread: string): Promise<string[]> {
+  const records = new Map(readRecords(run).records.map((r) => [r.dispatchId, r]));
+  const hints: string[] = [];
+  for (const d of listDispatches(run)) {
+    const on = d.admit.thread ?? records.get(d.admit.dispatchId)?.thread ?? null;
+    if (on?.toLowerCase() !== thread.toLowerCase()) continue;
+    const proc = readProc(d.dir);
+    const pgid = proc?.pgid ?? proc?.pid;
+    if (!proc || pgid === undefined || pgid !== proc.pid || readExit(d.dir) === null) continue;
+    if (isAlive(proc.pid, null) || !groupAlive(pgid)) continue;
+    await stopGroup(pgid, orphanLimits.killGraceMs, deps.pollMs);
+    log("info", "dispatch", { run: run.id, name: d.admit.name, thread, stoppedGroup: pgid });
+    hints.push(`resume: stopped what ${d.admit.name}'s earlier turn left running on thread ${thread}`);
+  }
+  return hints;
+}
+
 /**
  * Spec §4.4, plan 9 ruling 1: admit and launch one role, start its watcher, then refresh state.md with
  * `next` (after the launch, so nothing delays it). Returns at once; catherd announces the record (spec §3).
@@ -325,6 +350,7 @@ export async function dispatch(deps: Deps, i: DispatchInput): Promise<DispatchSt
   const thread = threadFor(run, i.name, i.thread);
   await claim(deps, run);
   const hints: string[] = [];
+  if (thread !== null) hints.push(...(await stopLeftovers(deps, run, thread)));
   let rung = i.rung;
   // spec 1.1 §6: a lane is routed before its first dispatch; a rung off the routed ladder starts at the routed one
   if (i.lane !== undefined && !readRoutes(run).some((r) => r.lane === i.lane)) {
```

Modify `test/services/dispatch-protocol.test.ts`:

```diff
--- a/test/services/dispatch-protocol.test.ts
+++ b/test/services/dispatch-protocol.test.ts
@@ -33,7 +33,8 @@ describe("the reply contract (spec 1.1 §6)", () => {
       expect(replyContract(role)).toEndWith(
         "The last line of your reply is: STATUS: complete|partial|blocked|refused — <one line why>",
       );
-    expect(replyContract("worker")).toStartWith("Do not commit. Reply in at most 15 lines");
+    expect(replyContract("worker")).toStartWith("Before you reply, leave nothing running");
+    expect(replyContract("worker")).toContain("Do not commit. Reply in at most 15 lines");
     expect(replyContract("verifier")).toStartWith(
       "The first line of your reply is VERDICT: PASS or VERDICT: FAIL.",
     );
```

Modify `test/services/dispatch-thread.test.ts`:

```diff
--- a/test/services/dispatch-thread.test.ts
+++ b/test/services/dispatch-thread.test.ts
@@ -1,13 +1,17 @@
 import { afterEach, beforeEach, describe, expect, it } from "bun:test";
+import { readFileSync } from "node:fs";
 import { join } from "node:path";
 import { isCatherdError } from "../../src/domain/errors.ts";
+import { replyContract, rolePrompt } from "../../src/domain/role-prompts.ts";
+import { processStartTime } from "../../src/infra/proc.ts";
 import { resetReadiness } from "../../src/services/backends.ts";
 import { dispatch, type DispatchInput, watchersSettled } from "../../src/services/dispatch-service.ts";
 import { listDispatches } from "../../src/services/dispatches.ts";
+import { finalizeDispatch } from "../../src/services/finalize.ts";
 import { readRecords } from "../../src/services/run-store.ts";
 import { snapshotEnv } from "../helpers.ts";
 import { type CodexScenario, simPath, withScenario } from "../sim/scenario.ts";
-import { fakeDeps, freshRun, runRole, writeLane } from "./helpers.ts";
+import { deadProcess, fakeDeps, fakeDispatch, freshRun, runRole, writeLane } from "./helpers.ts";
 
 afterEach(() => watchersSettled());
 afterEach(snapshotEnv());
@@ -46,6 +50,88 @@ async function refused(p: Promise<unknown>): Promise<{ code: string; message: st
   throw new Error("not refused");
 }
 
+describe("resume hygiene (plan 22: a resumed worker exits 143)", () => {
+  const exited = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };
+  const groupLives = (pgid: number) => {
+    try {
+      process.kill(-pgid, 0);
+      return true;
+    } catch {
+      return false;
+    }
+  };
+
+  it("stops what the thread's last turn left running in its group before it resumes the thread", async () => {
+    const { run, deps } = setup();
+    // a turn that ended with a command still running in the background of its process group
+    const turn = Bun.spawn(["sh", "-c", "sleep 60 & exit 0"], {
+      detached: true,
+      stdio: ["ignore", "ignore", "ignore"],
+      env: { PATH: process.env.PATH ?? "" },
+    });
+    const startTime = processStartTime(turn.pid);
+    await turn.exited;
+    expect(groupLives(turn.pid)).toBe(true);
+    const events = readFileSync(join(FX, "ok-with-reconnect.jsonl"), "utf8");
+    const dead = await deadProcess();
+    const earlier = await fakeDispatch(
+      run,
+      {},
+      {
+        proc: { pid: turn.pid, startTime, supervisorPid: dead, supervisorStartTime: "gone" },
+        exit: exited,
+        events,
+      },
+    );
+    expect((await finalizeDispatch(run, earlier)).thread).toBe(THREAD);
+    const { hints } = await dispatch(deps, input(run.id, { thread: "latest", brief: "Fix the finding" }));
+    expect(groupLives(turn.pid)).toBe(false);
+    expect(hints).toContain(
+      `resume: stopped what worker-M1.L1's earlier turn left running on thread ${THREAD}`,
+    );
+    await watchersSettled();
+  });
+
+  it("never signals a group whose leader's pid answers: it is someone else's by now", async () => {
+    const { run, deps } = setup();
+    const other = Bun.spawn(["sleep", "60"], {
+      detached: true,
+      stdio: ["ignore", "ignore", "ignore"],
+      env: {},
+    });
+    try {
+      const events = readFileSync(join(FX, "ok-with-reconnect.jsonl"), "utf8");
+      const dead = await deadProcess();
+      const earlier = await fakeDispatch(
+        run,
+        {},
+        {
+          proc: {
+            pid: other.pid,
+            startTime: "an earlier process",
+            supervisorPid: dead,
+            supervisorStartTime: "gone",
+          },
+          exit: exited,
+          events,
+        },
+      );
+      await finalizeDispatch(run, earlier);
+      const { hints } = await dispatch(deps, input(run.id, { thread: "latest" }));
+      expect(groupLives(other.pid)).toBe(true);
+      expect(hints.filter((h) => h.startsWith("resume:"))).toEqual([]);
+      await watchersSettled();
+    } finally {
+      other.kill("SIGKILL");
+    }
+  });
+
+  it("tells the worker to leave nothing running when it replies", () => {
+    expect(replyContract("worker")).toContain("leave nothing running");
+    expect(rolePrompt("worker", "1.5.0")).toContain("leave nothing running");
+  });
+});
+
 describe("dispatch's thread (plan 22: the notice carries the thread)", () => {
   it('resumes the name\'s last thread for thread: "latest"', async () => {
     const { run, deps, recorded } = setup();
```

### Task 5: A final reply never overwrites the report (spec: "A final reply never overwrites the report")

`composeReply(finals, last)` (pure, `src/domain/reply.ts`): with two or more turn-ending messages, the reply is the longest STATUS-bearing one without its STATUS line, then `later:` and the later messages, then that STATUS line last (Ruling 7). `foldCodexEvents` collects `finals` (the agent message before each `turn.completed`); the Codex `finalize` returns the composed text as `Outcome.reply` when it differs, which `finalize.ts` already writes to `reply.md`.

**Files:**
- Create: `src/domain/reply.ts`, `test/domain/reply.test.ts`, `test/services/final-reply.test.ts`
- Modify: `src/adapters/codex/events.ts`, `src/adapters/codex/index.ts`, `test/adapters/codex.test.ts`

**Interfaces:** produces `composeReply(finals: string[], last: string): string`; `CodexFold.finals: string[]`.

- [ ] **Step 1: Write the three tests below** (`reply.test.ts`, the new `codex finalize` case, `final-reply.test.ts`).
- [ ] **Step 2: Run** `bun test test/domain/reply.test.ts test/adapters/codex.test.ts test/services/final-reply.test.ts` — fails (no module; `result` returns the short reply).
- [ ] **Step 3: Make the code changes below.**
- [ ] **Step 4: Run** `bun test test/domain/reply.test.ts test/adapters/codex.test.ts test/adapters/codex.contract.test.ts test/services/final-reply.test.ts test/services/dispatch.test.ts` — all pass.
- [ ] **Step 5: Commit** `fix(reply): a later short reply never overwrites the report`.

**Code (scratch commit `32d6f30`):**

Modify `src/adapters/codex/events.ts`:

```diff
--- a/src/adapters/codex/events.ts
+++ b/src/adapters/codex/events.ts
@@ -8,6 +8,8 @@ export interface CodexFold {
   limit: boolean;
   tooOld: boolean;
   lastEvent: string | null;
+  /** plan 22: the agent message that ended each completed turn, in order */
+  finals: string[];
 }
 
 /**
@@ -43,10 +45,18 @@ export function foldCodexEvents(lines: string[]): CodexFold {
     limit: false,
     tooOld: false,
     lastEvent: null,
+    finals: [],
   };
+  let said: string | null = null;
   for (const line of lines) {
     const e = parseCodexLine(line);
     if (!e) continue;
+    if (e.type === "item.completed" && e.item?.type === "agent_message" && typeof e.item.text === "string")
+      said = e.item.text;
+    if (e.type === "turn.completed" && said !== null) {
+      f.finals.push(said);
+      said = null;
+    }
     f.lastEvent = e.item?.type ? `${e.type}/${e.item.type}` : e.type;
     const msg: string = e.message ?? e.error?.message ?? e.item?.message ?? "";
     if (CODEX_TOO_OLD.some((r) => r.test(msg))) f.tooOld = true;
```

Modify `src/adapters/codex/index.ts`:

```diff
--- a/src/adapters/codex/index.ts
+++ b/src/adapters/codex/index.ts
@@ -3,6 +3,7 @@ import { join } from "node:path";
 import { codexRoleMcpArgs } from "../../infra/role-mcp.ts";
 import { CatherdError } from "../../domain/errors.ts";
 import type { Access, RunStatus } from "../../domain/record.ts";
+import { composeReply } from "../../domain/reply.ts";
 import {
   type AccessShell,
   type BackendAdapter,
@@ -127,6 +128,7 @@ function finalize(run: FinishedRun): Outcome {
                 : "ok";
   const lastErr = run.stderr.trim().split("\n").at(-1) ?? "";
   const home = run.request.isolated ? isolatedCodexHomePath() : userCodexHome();
+  const reply = composeReply(f.finals, run.reply);
   return {
     status,
     thread: f.thread ?? run.request.thread,
@@ -140,6 +142,8 @@ function finalize(run: FinishedRun): Outcome {
             code: status,
             message: f.failure ?? (lastErr || `${stopped}, exit ${run.exit.code ?? run.exit.signal}`),
           },
+    // plan 22: -o keeps the last turn's message; a later turn never overwrites the report
+    ...(reply !== run.reply ? { reply } : {}),
   };
 }
```

Create `src/domain/reply.ts`:

```ts
import { parseReplyStatus } from "./record.ts";

/**
 * Plan 22: a final reply never overwrites the report. `finals` are the messages that ended each of the run's
 * turns, in order (a background command's notification can start another turn after the report); `last` is the
 * reply the CLI kept, the last of them. With more than one, the reply is the longest STATUS-bearing message, the
 * later ones after it under `later:`, and the report's STATUS line last, so the record's STATUS is the report's.
 * Otherwise `last` is the reply, unchanged.
 */
export function composeReply(finals: string[], last: string): string {
  if (finals.length < 2) return last;
  let report = -1;
  for (const [i, f] of finals.entries())
    if (
      parseReplyStatus(f).status !== null &&
      (report < 0 || f.trim().length >= finals[report]!.trim().length)
    )
      report = i;
  if (report < 0 || report === finals.length - 1) return last;
  const lines = finals[report]!.trimEnd().split("\n");
  const status = lines.pop() as string;
  const later = finals
    .slice(report + 1)
    .map((f) => f.trim())
    .filter(Boolean);
  if (!later.length) return last;
  const body = lines.join("\n").trimEnd();
  return [...(body ? [body, ""] : []), "later:", later.join("\n\n"), "", status.trim(), ""].join("\n");
}
```

Modify `test/adapters/codex.test.ts`:

```diff
--- a/test/adapters/codex.test.ts
+++ b/test/adapters/codex.test.ts
@@ -174,6 +174,30 @@ describe("codex finalize", () => {
     expect(o.error).toBeNull();
   });
 
+  it("keeps the report when a later turn ends on a short message (plan 22: a final reply never overwrites)", () => {
+    const msg = (id: string, text: string) =>
+      JSON.stringify({ type: "item.completed", item: { id, type: "agent_message", text } });
+    const turn = (...items: string[]) => [
+      '{"type":"turn.started"}',
+      ...items,
+      '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}',
+    ];
+    const report = "Done: moved the kit.\nDeviation: kept one export.\nSTATUS: complete — lane finished";
+    const short = "That notification was my wait loop; nothing to do.";
+    const events = [
+      '{"type":"thread.started","thread_id":"t-two"}',
+      ...turn(msg("i0", "Starting."), msg("i1", report)),
+      ...turn(msg("i2", short)),
+    ];
+    const o = codexAdapter.finalize(finished(events, { reply: short }));
+    expect(o.reply).toBe(
+      "Done: moved the kit.\nDeviation: kept one export.\n\nlater:\n" +
+        `${short}\n\nSTATUS: complete — lane finished\n`,
+    );
+    // one turn: the CLI's reply file is the reply, as before
+    expect(codexAdapter.finalize(finished(lines("ok-with-reconnect.jsonl"))).reply).toBeUndefined();
+  });
+
   it("sums tokens over turns", () => {
     expect(codexAdapter.finalize(finished(lines("two-turns.jsonl"))).tokens).toEqual({
       input: 300,
```

Create `test/domain/reply.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { parseReplyStatus } from "../../src/domain/record.ts";
import { composeReply } from "../../src/domain/reply.ts";

const REPORT = [
  "Done: the kit moved to packages/kit.",
  "Deviations: kept the old export for one release (src/index.ts:12).",
  "STATUS: complete — lane finished, fast check green",
].join("\n");
const SHORT = "The notification is just my wait loop finishing; nothing to do.";

describe("a final reply never overwrites the report (plan 22)", () => {
  it("keeps the report when a later turn ends on a short message, with that message under later:", () => {
    const reply = composeReply([REPORT, SHORT], SHORT);
    expect(reply).toBe(
      [
        "Done: the kit moved to packages/kit.",
        "Deviations: kept the old export for one release (src/index.ts:12).",
        "",
        "later:",
        SHORT,
        "",
        "STATUS: complete — lane finished, fast check green",
        "",
      ].join("\n"),
    );
    // the record's STATUS is the report's
    expect(parseReplyStatus(reply)).toEqual({ status: "complete", why: "lane finished, fast check green" });
  });

  it("takes the longest STATUS-bearing message, and keeps a later STATUS line out of the last line", () => {
    const later = "Rechecked.\nSTATUS: partial — one flake";
    const reply = composeReply(["warming up", REPORT, later], later);
    expect(reply.startsWith("Done: the kit moved")).toBe(true);
    expect(reply).toContain("later:\nRechecked.\nSTATUS: partial — one flake\n\nSTATUS: complete");
    expect(parseReplyStatus(reply).status).toBe("complete");
  });

  it("leaves the reply alone with one final message, when the report is last, or with no STATUS at all", () => {
    expect(composeReply([REPORT], REPORT)).toBe(REPORT);
    expect(composeReply([SHORT, REPORT], REPORT)).toBe(REPORT);
    expect(composeReply(["a", "b"], "b")).toBe("b");
    expect(composeReply([], "cli reply")).toBe("cli reply");
  });
});
```

Create `test/services/final-reply.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetReadiness } from "../../src/services/backends.ts";
import { type DispatchInput, watchersSettled } from "../../src/services/dispatch-service.ts";
import { result } from "../../src/services/run-service.ts";
import { snapshotEnv } from "../helpers.ts";
import { type CodexScenario, simPath, withScenario } from "../sim/scenario.ts";
import { fakeDeps, freshRun, runRole, writeLane } from "./helpers.ts";

afterEach(() => watchersSettled());
afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

const THREAD = "01a0d0d4-d0a6-71a1-983c-82a9169200b4";

function setup(s: CodexScenario) {
  const { run } = freshRun();
  process.env.PATH = simPath();
  Object.assign(process.env, withScenario(s).env);
  writeLane(run, "M1.L1", ["src/a.ts"]);
  return { run, deps: fakeDeps() };
}

const input = (run: string): DispatchInput => ({
  run,
  role: "worker",
  name: "worker-M1.L1",
  brief: "Read lanes/M1.L1.md",
  rung: "codex:gpt-6-luna#high",
  lane: "M1.L1",
});

describe("a final reply never overwrites the report (plan 22)", () => {
  it("result returns the report, the later short reply under later:, and the report's STATUS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "catherd-fx-"));
    const events = join(dir, "two-replies.jsonl");
    const msg = (id: string, text: string) =>
      JSON.stringify({ type: "item.completed", item: { id, type: "agent_message", text } });
    const done =
      '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}';
    const report = "Done: moved the kit.\nDeviation: kept one export.\nSTATUS: complete — lane finished";
    const short = "The notification is just my wait loop.";
    writeFileSync(
      events,
      [
        `{"type":"thread.started","thread_id":"${THREAD}"}`,
        '{"type":"turn.started"}',
        msg("i0", report),
        done,
        '{"type":"turn.started"}',
        msg("i1", short),
        done,
        "",
      ].join("\n"),
    );
    const { run, deps } = setup({ eventsFile: events, reply: short });
    const { record } = await runRole(deps, input(run.id));
    expect(record).toMatchObject({ replyStatus: "complete", replyWhy: "lane finished" });
    const r = await result(deps, { run: run.id, name: "worker-M1.L1" });
    expect(r.reply).toBe(
      `Done: moved the kit.\nDeviation: kept one export.\n\nlater:\n${short}\n\nSTATUS: complete — lane finished\n`,
    );
  });
});
```

### Task 6: "waiting for orchestrator" for a current owner and a recent record (spec: #42 findings 3 and 7)

`orchestratorWait` shows only with a current owner (its Claude Code session live, or seen in 24 h: `since` or a dispatch admitted from its session) and an unread record that ended in 24 h, and gains `until` (Ruling 8). `waitingLine(w, now)` is the one line (and the one `stalled`) both TUI views use; the memo no longer recomputes the wait on a hit. `status()` without a run returns the live runs, else the waiting ones, else the newest (Ruling 9).

**Files:**
- Replace: `src/services/orchestrator-wait.ts` (full file below)
- Modify: `src/entry/tui/effects.ts`, `src/entry/tui/views/runs.tsx`, `src/entry/tui/views/status.tsx`, `src/services/summary.ts`, `src/entry/runs-command.ts`
- Create: `test/services/orchestrator-wait.test.ts`; Modify: `test/entry/tui/effects.test.ts`

**Interfaces:** produces `WAIT_WINDOW_MS`, `OrchestratorWait.until`, `waitingLine(w, now): string | null`; `orchestratorWait(run, now, records?, hasLive?, files?)`.

- [ ] **Step 1: Write `test/services/orchestrator-wait.test.ts` and the memo test** (below).
- [ ] **Step 2: Run** `bun test test/services/orchestrator-wait.test.ts test/entry/tui/effects.test.ts` — fails (no `waitingLine`, the old rules show a day-old record, `status()` returns live and waiting runs together).
- [ ] **Step 3: Make the code changes below.**
- [ ] **Step 4: Run** `bun test test/services/orchestrator-wait.test.ts test/entry/tui test/services/summary-reconcile.test.ts test/services/runs-page.test.ts test/entry/runs-command.test.ts test/entry/help-text.test.ts` — all pass.
- [ ] **Step 5: Commit** `fix(status): waiting for orchestrator only for a current owner and a recent record`.

**Code (scratch commit `b04bcb0`):**

Modify `src/entry/runs-command.ts`:

```diff
--- a/src/entry/runs-command.ts
+++ b/src/entry/runs-command.ts
@@ -119,11 +119,12 @@ async function printStatus(runId: string | undefined, asJson: boolean, live = fa
   for (const w of r.warnings) console.log(`${mark("warn")} ${w}`);
 }
 
-/** `catherd status [run] [--json]`: that run, else live or waiting runs, else the newest. */
+/** `catherd status [run] [--json]`: that run, else the live runs, else the runs waiting for their orchestrator, else the newest. */
 export const statusCommand = defineCommand({
   meta: {
     name: "status",
-    description: "A run at a glance (default: live or waiting runs, else the newest)",
+    description:
+      "A run at a glance (default: live runs, else runs waiting for their orchestrator, else the newest)",
   },
   args: { run: { type: "positional", required: false, description: "run id" }, ...json },
   run({ args }) {
```

Modify `src/entry/tui/effects.ts`:

```diff
--- a/src/entry/tui/effects.ts
+++ b/src/entry/tui/effects.ts
@@ -55,7 +55,6 @@ import {
   sessionRows,
 } from "../../services/runs-page.ts";
 import { type RunSummary, summarizeRun } from "../../services/summary.ts";
-import { orchestratorWait } from "../../services/orchestrator-wait.ts";
 import { defaultDeps } from "../deps.ts";
 import { mcpHandshake } from "../mcp/handshake.ts";
 
@@ -236,12 +235,8 @@ export function memoRuns(compute: (run: Run) => RunRow, stamp: (dir: string) =>
     runs.map((r) => {
       const s = stamp(r.dir);
       const hit = cache.get(r.dir);
-      if (hit && hit.stamp === s && hit.row.live === 0) {
-        // A dead collection lease can restore unread status without changing any file's mtime.
-        const waiting = orchestratorWait(r, Date.now());
-        if (waiting || hit.row.waiting) hit.row = { ...hit.row, waiting };
-        return hit.row;
-      }
+      // the wait is computed with the row, once per stamp change; the views age it (waitingLine)
+      if (hit && hit.stamp === s && hit.row.live === 0) return hit.row;
       const row = compute(r);
       cache.set(r.dir, { stamp: s, row });
       return row;
```

Modify `src/entry/tui/views/runs.tsx`:

```diff
--- a/src/entry/tui/views/runs.tsx
+++ b/src/entry/tui/views/runs.tsx
@@ -1,4 +1,5 @@
 import { type MutableRefObject, useEffect, useRef, useState } from "react";
+import { waitingLine } from "../../../services/orchestrator-wait.ts";
 import { useApp, useBack, useNow } from "../providers/app.tsx";
 import { useData, usePoll } from "../providers/data.tsx";
 import { useCommandLayer } from "../providers/keymap.tsx";
@@ -166,10 +167,8 @@ function roleMark(r: RoleRow, plain: boolean): Part {
 function runHeading(r: SessionRun, now: number, plain: boolean): Part[] {
   const bits = [r.repo, `started ${ago(now - Date.parse(r.createdAt))}`];
   if (r.budget !== null) bits.push(`budget ${Math.round(r.budget * 100)}%`);
-  if (r.waiting)
-    bits.push(
-      `${r.waiting.stalled ? "stalled · " : ""}waiting for orchestrator ${Math.max(0, Math.floor((now - Date.parse(r.waiting.since)) / 1000))}s`,
-    );
+  const waiting = waitingLine(r.waiting, now);
+  if (waiting) bits.push(waiting);
   const moved =
     r.continued === "here" ? "continued here" : r.continuedIn ? `continued in ${r.continuedIn}` : null;
   return [
```

Modify `src/entry/tui/views/status.tsx`:

```diff
--- a/src/entry/tui/views/status.tsx
+++ b/src/entry/tui/views/status.tsx
@@ -1,5 +1,5 @@
 import type { Check } from "../../../services/doctor-checks.ts";
-import { ORCHESTRATOR_STALL_MS } from "../../../services/orchestrator-wait.ts";
+import { waitingLine } from "../../../services/orchestrator-wait.ts";
 import { useApp, useNow } from "../providers/app.tsx";
 import { useData } from "../providers/data.tsx";
 import { useCommandLayer } from "../providers/keymap.tsx";
@@ -20,10 +20,8 @@ function stateParts(state: Check["state"], word: string, plain: boolean): Part[]
 /** A run in one line: its state word first, then title, repo and progress (research C4). */
 export function runParts(r: RunRow, now: number, plain: boolean): Part[] {
   const bits = [plural(r.roleRuns, "role run"), `${r.landed} landed`];
-  if (r.waiting)
-    bits.push(
-      `${now - Date.parse(r.waiting.since) >= ORCHESTRATOR_STALL_MS ? "stalled · " : ""}waiting for orchestrator ${Math.max(0, Math.floor((now - Date.parse(r.waiting.since)) / 1000))}s`,
-    );
+  const waiting = waitingLine(r.waiting, now);
+  if (waiting) bits.push(waiting);
   if (r.budget !== null) bits.push(`${Math.round(r.budget * 100)}% budget`);
   return [
     r.live
```

Replace (whole file) `src/services/orchestrator-wait.ts`:

```ts
import type { RunRecord } from "../domain/record.ts";
import { liveSessionFile, readSessionFiles, type SessionFile } from "../infra/claude-session.ts";
import { awaitsCollect } from "../infra/dispatch-dir.ts";
import { listDispatches, liveDispatches } from "./dispatches.ts";
import { readRecords, type Run } from "./run-store.ts";
import { runOwner } from "./sessions.ts";

export const ORCHESTRATOR_STALL_MS = 5 * 60_000;

/**
 * Plan 22 (#42 finding 3): the line shows only for a current owner (its Claude Code session live, or seen in the
 * last day) and an unread record that ended in the last day, so an abandoned run never reads "stalled" forever.
 */
export const WAIT_WINDOW_MS = 24 * 3_600_000;

export interface OrchestratorWait {
  since: string;
  seconds: number;
  stalled: boolean;
  unread: number;
  /** when the line stops showing, unless the owner is seen again or another record ends */
  until: string;
}

/**
 * When the owner was last seen acting on the run: it took the run (`since`), or one of the run's dispatches was
 * admitted from its session.
 */
function ownerSeen(run: Run, owner: { sessionId: string; since: string }): number {
  let seen = Date.parse(owner.since) || 0;
  for (const d of listDispatches(run))
    if (d.admit.sessionId?.toLowerCase() === owner.sessionId.toLowerCase())
      seen = Math.max(seen, Date.parse(d.admit.admittedAt) || 0);
  return seen;
}

/**
 * Pure diagnostic: queue acceptance cannot show that the orchestrator processed a completion. Null unless the
 * run has a current owner, no live role, and an unread record that ended within WAIT_WINDOW_MS.
 */
export function orchestratorWait(
  run: Run,
  now: number,
  records: RunRecord[] = readRecords(run).records,
  hasLive = liveDispatches(run, now).length > 0,
  files: () => SessionFile[] = readSessionFiles,
): OrchestratorWait | null {
  const owner = runOwner(run);
  if (!owner || hasLive) return null;
  const unread = new Set(
    listDispatches(run)
      .filter((d) => awaitsCollect(d.dir))
      .map((d) => d.admit.dispatchId),
  );
  const recent = records.filter(
    (r) => unread.has(r.dispatchId) && now - (Date.parse(r.endedAt) || 0) < WAIT_WINDOW_MS,
  );
  if (!recent.length) return null;
  const ended = Math.max(...recent.map((r) => Date.parse(r.endedAt) || 0));
  const live = owner.host === "claude-code" && liveSessionFile(owner.sessionId, files()) !== null;
  const seen = live ? now : ownerSeen(run, owner);
  if (now - seen >= WAIT_WINDOW_MS) return null;
  const since = Math.max(ended, Date.parse(owner.since) || 0);
  const elapsed = Math.max(0, now - since);
  return {
    since: new Date(since).toISOString(),
    seconds: Math.floor(elapsed / 1000),
    stalled: elapsed >= ORCHESTRATOR_STALL_MS,
    unread: records.filter((r) => unread.has(r.dispatchId)).length,
    until: new Date(Math.min(ended, seen) + WAIT_WINDOW_MS).toISOString(),
  };
}

/**
 * The one "waiting for orchestrator" line every view shows (#42 finding 7): seconds and `stalled` from `since` at
 * `now`, so a memoised wait stays true between recomputes; null once it is past `until`.
 */
export function waitingLine(w: OrchestratorWait | null | undefined, now: number): string | null {
  if (!w || now >= Date.parse(w.until)) return null;
  const elapsed = Math.max(0, now - Date.parse(w.since));
  return `${elapsed >= ORCHESTRATOR_STALL_MS ? "stalled · " : ""}waiting for orchestrator ${Math.floor(elapsed / 1000)}s`;
}
```

Modify `src/services/summary.ts`:

```diff
--- a/src/services/summary.ts
+++ b/src/services/summary.ts
@@ -125,7 +125,10 @@ export function summarizeRun(deps: Deps, run: Run): RunSummary {
   };
 }
 
-/** `status(run?)`: that run; without one, live or waiting runs, else the newest run. */
+/**
+ * `status(run?)`: that run; without one, the live runs, else the runs waiting for their orchestrator (a current
+ * owner, a recent unread record: plan 22), else the newest run.
+ */
 export function status(
   deps: Deps,
   runId?: string,
@@ -148,12 +151,13 @@ export function status(
   const { runs, corrupt } = listRuns();
   const warnings = corrupt.map((c) => `skipped run ${c.id}: ${c.reason}`);
   const all = runs.map((r) => summarizeRun(deps, r));
-  const active = all.filter((s) => s.live.length > 0 || s.waiting);
+  const live = all.filter((s) => s.live.length > 0);
+  const waiting = all.filter((s) => s.waiting);
   return {
     host: inspectionHost(deps.host),
     queue,
     version: deps.version,
-    runs: active.length ? active : all.slice(0, 1),
+    runs: live.length ? live : waiting.length ? waiting : all.slice(0, 1),
     warnings,
   };
 }
```

Modify `test/entry/tui/effects.test.ts`:

```diff
--- a/test/entry/tui/effects.test.ts
+++ b/test/entry/tui/effects.test.ts
@@ -60,6 +60,28 @@ describe("the run list's memo (spec §9.4: memoised by mtime)", () => {
     rows(runs);
     expect(computed).toEqual(["a", "b", "a", "b", "b"]);
   });
+
+  it("computes an idle run's wait for its orchestrator once per stamp change (#42 finding 7)", () => {
+    let computed = 0;
+    const waiting = {
+      since: "2026-10-02T11:50:00.000Z",
+      seconds: 0,
+      stalled: false,
+      unread: 1,
+      until: "2026-10-03T11:50:00.000Z",
+    };
+    const rows = memoRuns(
+      (r) => {
+        computed++;
+        return { ...row(r.id), waiting };
+      },
+      () => "1",
+    );
+    const runs = [{ id: "a", dir: "/a" }] as Run[];
+    const first = rows(runs)[0];
+    for (let i = 0; i < 5; i++) expect(rows(runs)[0]).toBe(first as RunRow);
+    expect(computed).toBe(1);
+  });
 });
 
 describe("the live effects", () => {
```

Create `test/services/orchestrator-wait.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeHome } from "../../src/infra/paths.ts";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import {
  ORCHESTRATOR_STALL_MS,
  orchestratorWait,
  WAIT_WINDOW_MS,
  waitingLine,
} from "../../src/services/orchestrator-wait.ts";
import { createRun, type Run } from "../../src/services/run-store.ts";
import { claimRun } from "../../src/services/sessions.ts";
import { status } from "../../src/services/summary.ts";
import { snapshotEnv, tempRepo } from "../helpers.ts";
import { fakeDeps, fakeDispatch, freshRun } from "./helpers.ts";

afterEach(snapshotEnv());

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const THREAD = "0199c011-1234-7000-8000-000000000001";

const codexOwner = (at: number) =>
  fakeDeps({
    host: {
      host: "codex",
      session: { host: "codex", sessionId: THREAD, hostSessionId: null, name: null },
      conflict: null,
    },
    now: () => at,
  });

/** A finished, recorded, unread dispatch that ended at `ended`, admitted by `sessionId` when given. */
async function unreadAt(run: Run, name: string, ended: number, sessionId?: string) {
  const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: iso(ended) };
  const d = await fakeDispatch(
    run,
    { name, lane: null, admittedAt: iso(ended - 60_000), ...(sessionId ? { sessionId, host: "codex" } : {}) },
    { proc: "dead", exit, reply: "Done.\nSTATUS: complete — ok", collect: true },
  );
  await finalizeDispatch(run, d);
  return d;
}

describe("waiting for orchestrator (plan 22, #42 findings 3 and 7)", () => {
  it("shows for a current owner and a recent unread record, and turns stalled after five minutes", async () => {
    const { run } = freshRun("Push it");
    await claimRun(codexOwner(NOW - 2 * HOUR), run);
    await unreadAt(run, "worker-a", NOW - 10 * 60_000, THREAD);
    const w = orchestratorWait(run, NOW);
    expect(w).toMatchObject({ since: iso(NOW - 10 * 60_000), seconds: 600, stalled: true, unread: 1 });
    expect(waitingLine(w, NOW)).toBe("stalled · waiting for orchestrator 600s");
    expect(waitingLine(w, Date.parse(w!.since) + ORCHESTRATOR_STALL_MS - 1000)).toBe(
      "waiting for orchestrator 299s",
    );
  });

  it("never shows for an unread record that ended more than a day ago: an abandoned run is not stalled forever", async () => {
    const { run } = freshRun("Abandoned");
    await claimRun(codexOwner(NOW - 30 * HOUR), run);
    await unreadAt(run, "worker-a", NOW - 25 * HOUR, THREAD);
    expect(orchestratorWait(run, NOW)).toBeNull();
  });

  it("never shows for an owner not seen in a day, and does once one of its dispatches is recent", async () => {
    const { run } = freshRun("Old owner");
    await claimRun(codexOwner(NOW - 3 * 24 * HOUR), run);
    // a record a dashboard cancel left unread, from no session of the owner's
    await unreadAt(run, "worker-a", NOW - HOUR);
    expect(orchestratorWait(run, NOW)).toBeNull();
    await unreadAt(run, "worker-b", NOW - 2 * HOUR, THREAD.toUpperCase());
    expect(orchestratorWait(run, NOW)?.unread).toBe(2);
  });

  it("shows for a live Claude Code owner however long ago it took the run", async () => {
    const { run } = freshRun("Live owner");
    const dir = join(claudeHome(), "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: "s-live" }),
    );
    const deps = fakeDeps({
      session: { sessionId: "s-live", hostSessionId: null, socketPath: null, token: null },
      now: () => NOW - 3 * 24 * HOUR,
    });
    await claimRun(deps, run);
    await unreadAt(run, "worker-a", NOW - HOUR);
    const w = orchestratorWait(run, NOW);
    expect(w?.until).toBe(iso(NOW - HOUR + WAIT_WINDOW_MS));
    // the line ages out on its own, between two recomputes
    expect(waitingLine(w, NOW - HOUR + WAIT_WINDOW_MS)).toBeNull();
  });

  it("status() without a run: the live runs, else the waiting runs, else the newest", async () => {
    const { run: waiting } = freshRun("Waiting");
    await claimRun(codexOwner(Date.now() - HOUR), waiting);
    await unreadAt(waiting, "worker-a", Date.now() - 60_000, THREAD);
    // one home for all three runs
    const another = (title: string) =>
      createRun({ repo: tempRepo(), title, aLines: ["A1 it works"], version: "0.0.0-test" });
    const stale = another("Stale");
    await claimRun(codexOwner(Date.now() - 50 * HOUR), stale);
    await unreadAt(stale, "worker-a", Date.now() - 49 * HOUR, THREAD);
    const deps = fakeDeps();
    expect(status(deps).runs.map((r) => r.id)).toEqual([waiting.id]);
    const live = another("Live");
    await fakeDispatch(live, { name: "worker-l", lane: null }, { proc: "self" });
    expect(status(deps).runs.map((r) => r.id)).toEqual([live.id]);
  });
});
```

### Task 7: Goal mode and the skill's Codex half (spec: "Goal mode"; the tmux line of "Push from where a role ends")

`actionability(live, unread, protocolNext)` (exported from `src/services/peek.ts`, Ruling 10) gives every `PeekRun` `actionable` and `reason`, decided on the whole run; `peek` adds the top-level pair. The `peek` tool description says what `actionable: false` means. A new `### On Codex` section at the end of "After dispatching" in the skill says, once, to run inside tmux when `$TMUX` and `$STY` are empty, and that a goal continuation while only roles are live ends the turn with no tool call.

**Files:**
- Modify: `src/services/peek.ts`, `src/entry/mcp/dispatch-tools.ts`, `plugin/skills/catherd/SKILL.md`
- Test: `test/services/peek.test.ts`, `test/skills.test.ts`

**Interfaces:** produces `actionability(...)`, `PeekRun.actionable`, `PeekRun.reason`, and `peek()`'s top-level `actionable`, `reason`. The skill text must not contain `` `wait` `` (the skills test forbids it): it says "no `pidwait` or other wait cell".

- [ ] **Step 1: Write the `goal mode` describe in `peek.test.ts` and the `On Codex` skills test** (below).
- [ ] **Step 2: Run** `bun test test/services/peek.test.ts test/skills.test.ts` — fails.
- [ ] **Step 3: Make the code changes below.** Keep `questions` the first key of a `PeekRun` (`reentry.test.ts` checks it): the `actionable`/`reason` pair goes last.
- [ ] **Step 4: Run** `bun test test/services/peek.test.ts test/services/reentry.test.ts test/skills.test.ts test/entry/mcp.test.ts test/plugin.test.ts test/integration/mcp-stdio.test.ts` — all pass.
- [ ] **Step 5: Commit** `feat(peek): actionable false with its reason, and the skill's Codex half (goal mode, tmux)`.

**Code (scratch commit `1c3c8ce`):**

Modify `plugin/skills/catherd/SKILL.md`:

```diff
--- a/plugin/skills/catherd/SKILL.md
+++ b/plugin/skills/catherd/SKILL.md
@@ -207,6 +207,11 @@ Call `dispatch` from your main thread only, never from a subagent: catherd messa
 
 Nothing else pushes: a phone that buzzes for progress teaches the user to ignore it.
 
+### On Codex
+
+- **Run inside tmux.** When `$TMUX` and `$STY` are both empty, tell the user once, at the run's start, to run the coordinator inside `tmux` (or `screen`): Codex's app-server stops a thread's MCP servers once no client is attached, so an SSH drop detaches you. Each role's supervisor also queues its result to your thread when it ends, and the queued input waits for the next attach.
+- **Goal mode.** A goal continuation while only roles are live ends the turn with no tool call: no `peek`, no `sleep`, no `pidwait` or other wait cell, no role work of your own. When unsure, one `peek(run)` answers it: `actionable: false` and its `reason` mean nothing is yours to do until the next catherd message.
+
 ## The run folder
 
 `run_start` creates `R` under catherd's data directory, outside the repo. It outlives the session. `R` holds:
```

Modify `src/entry/mcp/dispatch-tools.ts`:

```diff
--- a/src/entry/mcp/dispatch-tools.ts
+++ b/src/entry/mcp/dispatch-tools.ts
@@ -31,7 +31,7 @@ export function registerDispatchTools(server: McpServer, deps: Deps): void {
     "peek",
     {
       description:
-        "A look at the runs, without waiting: with run, that run (and this session becomes its owner); without, every run this session owns, else the newest. Per run, first the open owner questions, which are the owner's questions: push them to the owner, relay the owner's answer with answer(run, milestone, answer), and go on with the work that does not depend on them. Then each live role with its rung, seconds since it started and its last event (the last command, file edit or message line); every finished record not yet read, as the first line of catherd's message; the latest native Claude run; the run's next step; protocol, the milestone loop's next step and its six-line checklist; and verifier, the verifier's latest gate step. name narrows it to one role. It never marks a record read: result(run, name) does. Call it when the user asks how it is going, when a decision needs the other roles' state, or once after run_start on a resumed run; never in a loop.",
+        "A look at the runs, without waiting: with run, that run (and this session becomes its owner); without, every run this session owns, else the newest. Per run, first the open owner questions, which are the owner's questions: push them to the owner, relay the owner's answer with answer(run, milestone, answer), and go on with the work that does not depend on them. Then each live role with its rung, seconds since it started and its last event (the last command, file edit or message line); every finished record not yet read, as the first line of catherd's message; the latest native Claude run; the run's next step; protocol, the milestone loop's next step and its six-line checklist; and verifier, the verifier's latest gate step. name narrows it to one role. It never marks a record read: result(run, name) does. Call it when the user asks how it is going, when a decision needs the other roles' state, or once after run_start on a resumed run; never in a loop. actionable is false, with its reason, when nothing is yours to do (only roles are live on the step, or the owner's answer comes first): end the turn with no tool call, and the next catherd message wakes you.",
       inputSchema: {
         run: z.string().optional(),
         name: z.string().regex(ID_PATTERN).optional(),
```

Modify `src/services/peek.ts`:

```diff
--- a/src/services/peek.ts
+++ b/src/services/peek.ts
@@ -49,6 +49,45 @@ export interface PeekRun extends Reentry {
   native: { name: string; role: string; rung: string; status: string; at: string } | null;
   /** the run's next step (state.md's last line) */
   next: string;
+  /** plan 22, goal mode: whether anything in this run is the coordinator's to do now, and why (not) */
+  actionable: boolean;
+  reason: string;
+}
+
+/**
+ * Plan 22, goal mode: whether the run holds anything for the coordinator. An unread record is its to read; with
+ * roles live, a protocol step one of them is doing (lanes running, the reviewer or verifier step with that role
+ * live, the plan while an architect or researcher runs) or the owner's question is nobody's to act on, so the
+ * coordinator ends its turn with no tool call and the next catherd message wakes it.
+ */
+export function actionability(
+  live: { name: string; role: string }[],
+  unread: { name: string }[],
+  protocolNext: string,
+): { actionable: boolean; reason: string } {
+  if (unread.length)
+    return {
+      actionable: true,
+      reason: `unread: ${unread.map((u) => `result(run, "${u.name}")`).join(", ")}`,
+    };
+  if (protocolNext.endsWith(" parked: wait for the owner"))
+    return {
+      actionable: false,
+      reason: `${protocolNext.replace(/: wait for the owner$/, "")}: the owner's answer comes first; end the turn with no tool call`,
+    };
+  const running = (role: string) => live.some((l) => l.role === role);
+  const covered =
+    /: lanes running \(/.test(protocolNext) ||
+    (protocolNext.endsWith(": reviewer") && running("reviewer")) ||
+    (protocolNext.endsWith(": verifier") && running("verifier")) ||
+    (protocolNext.startsWith("plan:") && (running("architect") || running("researcher"))) ||
+    (protocolNext.startsWith("finish:") && (running("verifier") || running("writer")));
+  if (live.length && covered)
+    return {
+      actionable: false,
+      reason: `only roles are live (${live.map((l) => l.name).join(", ")}): their results arrive as catherd messages; end the turn with no tool call`,
+    };
+  return { actionable: true, reason: protocolNext };
 }
 
 function peekRun(deps: Deps, run: Run, name: string | undefined): PeekRun {
@@ -58,22 +97,29 @@ function peekRun(deps: Deps, run: Run, name: string | undefined): PeekRun {
   const agents = readAgentRuns(run).filter((a) => name === undefined || a.name === name);
   const native = agents.at(-1);
   const r = reentry(run, now);
+  const live = liveDispatches(run, now);
+  // the whole run decides it, whatever `name` narrows the view to
+  const act = actionability(
+    live.map((d) => ({ name: d.admit.name, role: d.admit.role })),
+    listDispatches(run).flatMap((d) =>
+      records.has(d.admit.dispatchId) && awaitsCollect(d.dir) ? [{ name: d.admit.name }] : [],
+    ),
+    r.protocol.next,
+  );
   return {
     questions: r.questions,
     run: run.id,
     title: run.meta.title,
     owner: runOwner(run)?.sessionId ?? null,
     ownerHost: runOwner(run)?.host ?? null,
-    live: liveDispatches(run, now)
-      .filter(mine)
-      .map((d) => ({
-        name: d.admit.name,
-        role: d.admit.role,
-        rung: d.admit.rung,
-        state: d.state,
-        secs: Math.max(0, Math.round((now - Date.parse(d.admit.admittedAt)) / 1000)),
-        lastEvent: lastActivity(d),
-      })),
+    live: live.filter(mine).map((d) => ({
+      name: d.admit.name,
+      role: d.admit.role,
+      rung: d.admit.rung,
+      state: d.state,
+      secs: Math.max(0, Math.round((now - Date.parse(d.admit.admittedAt)) / 1000)),
+      lastEvent: lastActivity(d),
+    })),
     delivery: listDispatches(run)
       .filter(mine)
       .flatMap((d) =>
@@ -106,6 +152,7 @@ function peekRun(deps: Deps, run: Run, name: string | undefined): PeekRun {
     next: readNotes(run).next,
     protocol: r.protocol,
     verifier: r.verifier,
+    ...act,
   };
 }
 
@@ -117,7 +164,15 @@ function peekRun(deps: Deps, run: Run, name: string | undefined): PeekRun {
 export async function peek(
   deps: Deps,
   i: { run?: string; name?: string },
-): Promise<{ runs: PeekRun[]; hints: string[]; host: HostContext; queue: QueueCapability | null }> {
+): Promise<{
+  /** plan 22, goal mode: false when no run holds anything for the coordinator; `reason` says why either way */
+  actionable: boolean;
+  reason: string;
+  runs: PeekRun[];
+  hints: string[];
+  host: HostContext;
+  queue: QueueCapability | null;
+}> {
   if (i.name !== undefined) assertId("role name", i.name);
   let runs: Run[];
   if (i.run) {
@@ -131,8 +186,14 @@ export async function peek(
     runs = owned.length ? owned : all.slice(0, 1);
   }
   const hints = runs.length === 0 ? ["no runs yet: run_start(repo, title, a_lines) starts one"] : [];
+  const views = runs.map((r) => peekRun(deps, r, i.name));
+  const doing = views.filter((v) => v.actionable);
+  const shown = (vs: PeekRun[]) =>
+    vs.map((v) => (views.length > 1 ? `${v.title}: ${v.reason}` : v.reason)).join("; ");
   return {
-    runs: runs.map((r) => peekRun(deps, r, i.name)),
+    actionable: views.length === 0 || doing.length > 0,
+    reason: views.length === 0 ? "no runs yet" : shown(doing.length ? doing : views),
+    runs: views,
     hints,
     host: inspectionHost(deps.host),
     queue: deps.host.host === "codex" && !deps.host.conflict ? knownQueueCapability(process.env) : null,
```

Modify `test/services/peek.test.ts`:

```diff
--- a/test/services/peek.test.ts
+++ b/test/services/peek.test.ts
@@ -11,7 +11,7 @@ import { dispatchPaths, awaitsCollect } from "../../src/infra/dispatch-dir.ts";
 import { watchersSettled } from "../../src/services/dispatch-service.ts";
 import { finalizeDispatch } from "../../src/services/finalize.ts";
 import { lastActivity } from "../../src/services/finalize.ts";
-import { peek } from "../../src/services/peek.ts";
+import { actionability, peek } from "../../src/services/peek.ts";
 import { appendAgentRun, createRun } from "../../src/services/run-store.ts";
 import { claimRun, runOwner } from "../../src/services/sessions.ts";
 import { snapshotEnv, withHome } from "../helpers.ts";
@@ -234,3 +234,56 @@ it("queued and ambiguous remain unread; only result collects, and old owner rece
   await result(other, { run: run.id, name: d.admit.name });
   expect((await peek(other, {})).runs[0]?.unread).toEqual([]);
 });
+
+describe("goal mode: peek says when nothing is the coordinator's to do (plan 22)", () => {
+  const worker = { name: "worker-M1.L1", role: "worker" };
+  it("is not actionable while only roles are live on the step", () => {
+    expect(actionability([worker], [], "M1: lanes running (worker-M1.L1)")).toEqual({
+      actionable: false,
+      reason:
+        "only roles are live (worker-M1.L1): their results arrive as catherd messages; end the turn with no tool call",
+    });
+    expect(actionability([{ name: "verifier-M1", role: "verifier" }], [], "M1: verifier").actionable).toBe(
+      false,
+    );
+    expect(
+      actionability([{ name: "architect", role: "architect" }], [], "plan: the architect writes").actionable,
+    ).toBe(false);
+    expect(actionability([], [], "M2 parked: wait for the owner")).toEqual({
+      actionable: false,
+      reason: "M2 parked: the owner's answer comes first; end the turn with no tool call",
+    });
+  });
+
+  it("is actionable for an unread record, a step no live role covers, or no live role at all", () => {
+    expect(actionability([worker], [{ name: "worker-M1.L2" }], "M1: lanes running (worker-M1.L1)")).toEqual({
+      actionable: true,
+      reason: 'unread: result(run, "worker-M1.L2")',
+    });
+    expect(actionability([worker], [], "dispatch M1.L3")).toEqual({
+      actionable: true,
+      reason: "dispatch M1.L3",
+    });
+    expect(actionability([worker], [], "M1: reviewer").actionable).toBe(true);
+    expect(actionability([], [], "land M1")).toEqual({ actionable: true, reason: "land M1" });
+  });
+
+  it("answers in one call, for the whole run even when narrowed to one role", async () => {
+    const { run } = freshRun("Goal");
+    await fakeDispatch(run, { name: "architect", role: "architect", lane: null }, { proc: "self" });
+    const quiet = await peek(fakeDeps(), { run: run.id, name: "nobody" });
+    expect(quiet).toMatchObject({ actionable: false, runs: [{ actionable: false }] });
+    expect(quiet.reason).toContain("only roles are live (architect)");
+    const ended = { ...exit, endedAt: new Date().toISOString() };
+    const done = await fakeDispatch(
+      run,
+      { name: "researcher", role: "researcher", lane: null },
+      { proc: "dead", exit: ended, reply: "Map.\nSTATUS: complete — ok", collect: true },
+    );
+    await finalizeDispatch(run, done);
+    expect(await peek(fakeDeps(), {})).toMatchObject({
+      actionable: true,
+      reason: 'unread: result(run, "researcher")',
+    });
+  });
+});
```

Modify `test/skills.test.ts`:

```diff
--- a/test/skills.test.ts
+++ b/test/skills.test.ts
@@ -52,6 +52,14 @@ describe("orchestrator skill", () => {
     }
   });
 
+  it("tells a Codex coordinator to run in tmux once, and to end a goal continuation with no tool call (plan 22)", () => {
+    const md = skill("catherd");
+    const codex = md.slice(md.indexOf("### On Codex"), md.indexOf("\n## ", md.indexOf("### On Codex")));
+    expect(codex).toContain("When `$TMUX` and `$STY` are both empty, tell the user once");
+    expect(codex).toContain("A goal continuation while only roles are live ends the turn with no tool call");
+    expect(codex).toContain("`actionable: false`");
+  });
+
   it("dispatches roles one after another, then ends its turn; results arrive as catherd messages (spec 1.1 §3.8)", () => {
     const md = skill("catherd");
     const after = md.slice(
```

### Task 8: `Next` advanced by `result()`; the verifier step closes and shows its age (spec: "`state.md`'s Next")

`result()` of a finished record whose name or lane `Next` names as a whole word (`names(text, token)`) moves `Next` to `after <name> (<status>): <protocol next>` (Ruling 11). `verifierStepView(run, now)` (`src/services/verifier-step.ts`) replaces `latestVerifierStep` in `summarizeRun` and `reentry`, with `secs`, `open` and `closedBy` (Ruling 12); `catherd status` prints `· N min ago · open|closed (<why>)`.

**Files:**
- Create: `src/services/verifier-step.ts`, `test/services/next-step.test.ts`
- Modify: `src/services/run-service.ts`, `src/services/reentry.ts`, `src/services/summary.ts`, `src/entry/runs-command.ts`, `test/services/gate-service.test.ts`

**Interfaces:** produces `names(text, token): boolean` (exported from `run-service.ts`), `verifierStepView(run, now, files?)`, `VerifierStepView`, `StepClosedBy`; `RunSummary.verifier` and `Reentry.verifier` become `VerifierStepView | null`.

- [ ] **Step 1: Write `test/services/next-step.test.ts`** (below) **and update the status line in `gate-service.test.ts`.**
- [ ] **Step 2: Run** `bun test test/services/next-step.test.ts test/services/gate-service.test.ts` — fails.
- [ ] **Step 3: Make the code changes below.**
- [ ] **Step 4: Run** `bun test test/services/next-step.test.ts test/services/gate-service.test.ts test/services/reentry.test.ts test/services/summary-reconcile.test.ts test/entry/runs-command.test.ts test/services/dispatch.test.ts` — all pass.
- [ ] **Step 5: Commit** `fix(state): result advances a Next that names it; the verifier step closes and shows its age`.

**Code (scratch commit `6fcef78`):**

Modify `src/entry/runs-command.ts`:

```diff
--- a/src/entry/runs-command.ts
+++ b/src/entry/runs-command.ts
@@ -60,7 +60,7 @@ export function formatRun(s: RunSummary, now: number = Date.now()): string[] {
   for (const m of s.milestones) lines.push(`  landed ${m}`);
   if (s.verifier)
     lines.push(
-      `  verifier step ${s.verifier.item}${s.verifier.carried ? " (carried over)" : ""} at ${s.verifier.at.slice(11, 16)}`,
+      `  verifier step ${s.verifier.item}${s.verifier.carried ? " (carried over)" : ""} at ${s.verifier.at.slice(11, 16)} · ${Math.floor(s.verifier.secs / 60)} min ago · ${s.verifier.open ? "open" : `closed (${s.verifier.closedBy})`}`,
     );
   for (const d of s.delivery)
     lines.push(
```

Modify `src/services/reentry.ts`:

```diff
--- a/src/services/reentry.ts
+++ b/src/services/reentry.ts
@@ -1,8 +1,8 @@
-import { latestVerifierStep, type VerifierStep } from "./gate-service.ts";
 import { protocolView } from "./protocol.ts";
 import { type OpenQuestion, openQuestions } from "./questions.ts";
 import type { Run } from "./run-store.ts";
 import { readNotes } from "./state.ts";
+import { verifierStepView, type VerifierStepView } from "./verifier-step.ts";
 
 // Spec 1.1 §8, §7 and §10: what a session re-entering a run needs first, as peek returns it: the owner questions still open, the protocol's next step with its checklist,
 // and the verifier's latest step.
@@ -10,13 +10,13 @@ import { readNotes } from "./state.ts";
 export interface Reentry {
   questions: OpenQuestion[];
   protocol: { next: string; checklist: string[] };
-  verifier: VerifierStep | null;
+  verifier: VerifierStepView | null;
 }
 
 export function reentry(run: Run, now?: number): Reentry {
   return {
     questions: openQuestions(run),
     protocol: protocolView(run, readNotes(run).parked ?? [], now),
-    verifier: latestVerifierStep(run),
+    verifier: verifierStepView(run, now ?? Date.now()),
   };
 }
```

Modify `src/services/run-service.ts`:

```diff
--- a/src/services/run-service.ts
+++ b/src/services/run-service.ts
@@ -25,10 +25,11 @@ import {
   knowledgeFile,
   readRecords,
   runFile,
+  type Run,
 } from "./run-store.ts";
-import { protocolView } from "./protocol.ts";
+import { protocolNext, protocolView } from "./protocol.ts";
 import { claimRun, currentSession } from "./sessions.ts";
-import { refreshState } from "./state.ts";
+import { readNotes, refreshState } from "./state.ts";
 
 export async function startRun(
   deps: Deps,
@@ -99,6 +100,28 @@ function capReply(reply: string, path: string): string {
   return `${head.slice(0, CAP_CHARS)}\n[capped: the full reply is ${path}]`;
 }
 
+/** Whether `text` names `token` (a role name or lane id) as a whole word, a full stop after it allowed. */
+export function names(text: string, token: string): boolean {
+  const t = token.replace(/[.*+?^${}()|[\]\\]/g, "\\{{TASKS}}");
+  return new RegExp(`(?<![\\w.-])${t}(?![\\w-]|\\.\\w)`).test(text);
+}
+
+/**
+ * Plan 22: state.md's Next never outlives the step it names. When it names a role whose record `result` returns
+ * (by its name or its lane), it moves on to the protocol's next step. A refresh that fails comes back as hints.
+ */
+async function advanceNext(run: Run, record: RunRecord): Promise<string[]> {
+  const stale = (next: string) =>
+    names(next, record.name) || (record.lane !== null && names(next, record.lane));
+  if (!stale(readNotes(run).next)) return [];
+  const { hints } = await refreshState(run, (n) =>
+    stale(n.next)
+      ? { next: `after ${record.name} (${record.status}): ${protocolNext(run, n.parked ?? [])}` }
+      : {},
+  );
+  return hints;
+}
+
 /**
  * A role's latest dispatch: its record once finished, its capped reply and its hints. Spec §3.7: reading a
  * finished record marks it read, with the collect lease (each record is marked read once, whoever reads it);
@@ -134,6 +157,7 @@ export async function result(
     if (x.admit.dispatchId !== d.admit.dispatchId) hints.push(...recordHints(run, x, r));
   }
   if (record) for (const h of recordHints(run, d, record)) if (!hints.includes(h)) hints.push(h);
+  if (record) for (const h of await advanceNext(run, record)) if (!hints.includes(h)) hints.push(h);
   const reply = dispatchPaths(d.dir).reply;
   const text = existsSync(reply) ? readFileSync(reply, "utf8") : "";
   return {
```

Modify `src/services/summary.ts`:

```diff
--- a/src/services/summary.ts
+++ b/src/services/summary.ts
@@ -8,7 +8,7 @@ import type { Tokens } from "../domain/record.ts";
 import { median } from "../domain/util.ts";
 import { nonBlankLines, readJsonl } from "../infra/store.ts";
 import { spendOf } from "./budget.ts";
-import { latestVerifierStep, type VerifierStep } from "./gate-service.ts";
+import { verifierStepView, type VerifierStepView } from "./verifier-step.ts";
 import { type OpenQuestion, openQuestions } from "./questions.ts";
 import { type DispatchState, listDispatches, liveDispatches } from "./dispatches.ts";
 import { type RunSession, sessionFacts } from "./session-view.ts";
@@ -48,8 +48,8 @@ export interface RunSummary {
   harness: { backend: string; native: number; isolated: number }[];
   budget: BudgetStatus | null;
   milestones: string[];
-  /** spec 1.1 §7: the verifier's latest gate_check, so the user sees where it is */
-  verifier: VerifierStep | null;
+  /** spec 1.1 §7: the verifier's latest gate_check, so the user sees where it is; plan 22: its age, and what closed it */
+  verifier: VerifierStepView | null;
   warnings: string[];
 }
 
@@ -120,7 +120,7 @@ export function summarizeRun(deps: Deps, run: Run): RunSummary {
     }),
     budget,
     milestones: nonBlankLines(runPaths(run.dir).ledger).slice(1),
-    verifier: latestVerifierStep(run),
+    verifier: verifierStepView(run, now),
     warnings,
   };
 }
```

Create `src/services/verifier-step.ts`:

```ts
import { liveSessionFile, readSessionFiles, type SessionFile } from "../infra/claude-session.ts";
import { readJsonl } from "../infra/store.ts";
import { gatesFile, latestVerifierStep, type VerifierStep } from "./gate-service.ts";
import { readAgentRuns, readRecords, type Run } from "./run-store.ts";
import { runOwner } from "./sessions.ts";

/** What ended a verifier step (plan 22: a step nothing ends shows as live forever). */
export type StepClosedBy = "gate_pass" | "agent-run" | "record" | "owner-gone";

export interface VerifierStepView extends VerifierStep {
  /** seconds since the step began */
  secs: number;
  open: boolean;
  closedBy: StepClosedBy | null;
}

/**
 * Plan 22: the verifier's latest step with its age, closed by the first evidence after it: a `gate_pass` of its
 * item in this run, a native verifier's `record_agent_run`, a verifier dispatch's record, or its owner session
 * gone (another session took the run since, or the owner's Claude Code session no longer runs). A Codex owner
 * that still holds the run has no liveness to read: its step stays open until other evidence ends it.
 */
export function verifierStepView(
  run: Run,
  now: number,
  files: () => SessionFile[] = readSessionFiles,
): VerifierStepView | null {
  const step = latestVerifierStep(run);
  if (!step) return null;
  const at = Date.parse(step.at) || 0;
  const after = (t: string | undefined) => (Date.parse(t ?? "") || 0) >= at;
  const passed = readJsonl<{ run?: unknown; item?: unknown; at?: string }>(
    gatesFile(run.meta.repo),
  ).rows.some((p) => p?.run === run.id && p.item === step.item && after(p.at));
  const owner = runOwner(run);
  const closedBy: StepClosedBy | null = passed
    ? "gate_pass"
    : readAgentRuns(run).some((a) => a.role === "verifier" && after(a.at))
      ? "agent-run"
      : readRecords(run).records.some((r) => r.role === "verifier" && after(r.endedAt))
        ? "record"
        : owner &&
            ((Date.parse(owner.since) || 0) > at ||
              (owner.host === "claude-code" && liveSessionFile(owner.sessionId, files()) === null))
          ? "owner-gone"
          : null;
  return { ...step, secs: Math.max(0, Math.floor((now - at) / 1000)), open: closedBy === null, closedBy };
}
```

Modify `test/services/gate-service.test.ts`:

```diff
--- a/test/services/gate-service.test.ts
+++ b/test/services/gate-service.test.ts
@@ -260,7 +260,7 @@ describe("the gate ledger (spec 1.1 §7)", () => {
     });
     const s = summarizeRun(deps, run);
     expect(s.verifier?.item).toBe("boot check");
-    expect(formatRun(s)).toContain("  verifier step boot check at 10:05");
+    expect(formatRun(s)).toContain("  verifier step boot check at 10:05 · 0 min ago · open");
   });
 
   it("serves gate_check and gate_pass over MCP", async () => {
```

Create `test/services/next-step.test.ts`:

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatRun } from "../../src/entry/runs-command.ts";
import { claudeHome } from "../../src/infra/paths.ts";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import { gateCheck, gatePass } from "../../src/services/gate-service.ts";
import { names, recordAgentRun, result, setNext } from "../../src/services/run-service.ts";
import { claimRun } from "../../src/services/sessions.ts";
import { readNotes } from "../../src/services/state.ts";
import { summarizeRun } from "../../src/services/summary.ts";
import { verifierStepView } from "../../src/services/verifier-step.ts";
import { snapshotEnv } from "../helpers.ts";
import { fakeDeps, fakeDispatch, freshRun, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());

const exit = (endedAt = new Date().toISOString()) => ({
  code: 0,
  signal: null,
  reason: "exited" as const,
  endedAt,
});

function committed(repo: string): void {
  writeFileSync(join(repo, "a.txt"), "a");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c"], { cwd: repo });
}

describe("state.md's Next never outlives the step it names (plan 22)", () => {
  it("names a role or lane only as a whole word", () => {
    expect(names("dispatch M3.L1 at codex:gpt-6-sol#medium on a fresh thread", "M3.L1")).toBe(true);
    expect(names("then land; worker-M3.L1.", "worker-M3.L1")).toBe(true);
    expect(names("dispatch M3.L10", "M3.L1")).toBe(false);
    expect(names("dispatch worker-M3.L1-fix", "worker-M3.L1")).toBe(false);
    expect(names("dispatch M3.L1.b", "M3.L1")).toBe(false);
  });

  it("result() of the dispatch Next names moves Next to the protocol's step; another leaves it", async () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a.ts"]);
    const deps = fakeDeps();
    await setNext({ run: run.id, next: "dispatch M1.L1 at codex:gpt-6-sol#medium on a fresh thread" });
    const other = await fakeDispatch(
      run,
      { name: "researcher-1", role: "researcher", lane: null },
      { proc: "dead", exit: exit(), reply: "Map.\nSTATUS: complete — ok", collect: true },
    );
    await finalizeDispatch(run, other);
    await result(deps, { run: run.id, name: "researcher-1" });
    expect(readNotes(run).next).toBe("dispatch M1.L1 at codex:gpt-6-sol#medium on a fresh thread");
    const d = await fakeDispatch(
      run,
      {},
      { proc: "dead", exit: exit(), reply: "Done.\nSTATUS: complete — ok", collect: true },
    );
    const record = await finalizeDispatch(run, d);
    await result(deps, { run: run.id, name: "worker-M1.L1" });
    expect(readNotes(run).next).toBe(`after worker-M1.L1 (${record.status}): route and preflight M1's lanes`);
  });
});

describe("the verifier's step closes (plan 22)", () => {
  const T0 = Date.parse("2026-10-02T10:00:00.000Z");
  const at = (min: number) => () => T0 + min * 60_000;
  const check = { item: "boot check", command: "bun run boot", paths: ["."] };

  async function stepped() {
    const { repo, run } = freshRun();
    committed(repo);
    await gateCheck(fakeDeps({ now: at(0) }), { run: run.id, ...check });
    return { repo, run };
  }

  it("stays open with its age while nothing ends it, and status shows both", async () => {
    const { run } = await stepped();
    expect(verifierStepView(run, at(12)())).toMatchObject({
      item: "boot check",
      secs: 720,
      open: true,
      closedBy: null,
    });
    const s = summarizeRun(fakeDeps({ now: at(12) }), run);
    expect(formatRun(s)).toContain("  verifier step boot check at 10:00 · 12 min ago · open");
  });

  it("closes on a gate_pass of its item", async () => {
    const { run } = await stepped();
    await gatePass(fakeDeps({ now: at(5) }), { run: run.id, ...check, evidence: "ok" });
    expect(verifierStepView(run, at(6)())).toMatchObject({ open: false, closedBy: "gate_pass" });
    expect(formatRun(summarizeRun(fakeDeps({ now: at(6) }), run)).join("\n")).toContain(
      " · closed (gate_pass)",
    );
  });

  it("closes on a native verifier's record_agent_run, and on a verifier dispatch's record", async () => {
    const { run } = await stepped();
    const deps = fakeDeps({ host: { host: "claude-code", session: null, conflict: null }, now: at(3) });
    recordAgentRun(deps, {
      run: run.id,
      name: "verifier-M1",
      role: "verifier",
      rung: "claude:claude-opus-5-5#low",
      totalTokens: 10,
    });
    expect(verifierStepView(run, at(4)())?.closedBy).toBe("agent-run");
    const { run: other } = await stepped();
    const d = await fakeDispatch(
      other,
      { name: "verifier-M1", role: "verifier", lane: null },
      { proc: "dead", exit: exit(new Date(at(8)()).toISOString()), reply: "VERDICT: PASS", collect: true },
    );
    await finalizeDispatch(other, d);
    expect(verifierStepView(other, at(9)())?.closedBy).toBe("record");
  });

  it("closes when its owner session is gone: another took the run, or the Claude Code session ended", async () => {
    const { run } = await stepped();
    const dir = join(claudeHome(), "sessions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: "s-live" }),
    );
    const live = fakeDeps({
      session: { sessionId: "s-live", hostSessionId: null, socketPath: null, token: null },
      now: () => T0 - 60_000,
    });
    await claimRun(live, run);
    expect(verifierStepView(run, at(2)())?.open).toBe(true);
    // the owner's Claude Code session ends
    expect(verifierStepView(run, at(2)(), () => [])?.closedBy).toBe("owner-gone");
    // another session takes the run after the step began
    const next = fakeDeps({
      session: { sessionId: "s-next", hostSessionId: null, socketPath: null, token: null },
      now: at(5),
    });
    await claimRun(next, run);
    expect(verifierStepView(run, at(6)())?.closedBy).toBe("owner-gone");
  });
});
```

### Task 9: Single-flight boot sync and reconcile (spec: "One MCP server per Codex session"; X5)

`takeBootLock()` (`src/infra/boot-lock.ts`) is `tryLock(<locks>/mcp-boot)`; `startMcpServer` takes it at its first `initialized`, keeps it until its transport closes, and a server that finds it held skips the boot sync and `reconcileAll`, still scanning its own notifier (Ruling 13). `startMcpServer` takes an optional `bootLock` seam.

**Files:**
- Create: `src/infra/boot-lock.ts`
- Modify: `src/entry/mcp/server.ts`, `test/entry/mcp-sync.test.ts`

**Interfaces:** produces `bootLockTarget()`, `takeBootLock(): (() => void) | null`; `startMcpServer({ …, bootLock? })`.

- [ ] **Step 1: Write the `one MCP server runs the boot sync and reconcile` describe** (below).
- [ ] **Step 2: Run** `bun test test/entry/mcp-sync.test.ts` — fails: the second server syncs and reconciles too.
- [ ] **Step 3: Make the code changes below.**
- [ ] **Step 4: Run** `bun test test/entry test/integration` — all pass.
- [ ] **Step 5: Commit** `fix(mcp): boot sync and reconcile are single-flight across MCP servers`.

**Code (scratch commit `a44985d`):**

Modify `src/entry/mcp/server.ts`:

```diff
--- a/src/entry/mcp/server.ts
+++ b/src/entry/mcp/server.ts
@@ -5,6 +5,7 @@ import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
 import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
 import { sessionKey, type HostContext } from "../../domain/host.ts";
 import { errorMessage } from "../../domain/errors.ts";
+import { takeBootLock } from "../../infra/boot-lock.ts";
 import { resolveHost } from "../../infra/host-context.ts";
 import { log } from "../../infra/log.ts";
 import { currentSession } from "../../services/sessions.ts";
@@ -113,7 +114,13 @@ export function buildServer(deps: Deps = defaultDeps(), observe?: ObserveSession
 
 /** Connect immediately; initialized triggers recovery without delaying the handshake. */
 export async function startMcpServer(
-  o: { transport?: Transport; sync?: () => Promise<unknown>; deps?: Deps } = {},
+  o: {
+    transport?: Transport;
+    sync?: () => Promise<unknown>;
+    deps?: Deps;
+    /** plan 22: the boot lock (tests replace it); null while another live server holds it */
+    bootLock?: () => (() => void) | null;
+  } = {},
 ): Promise<void> {
   const deps = o.deps ?? defaultDeps();
   const observed = new Map<string, ReturnType<typeof startNotifier>>();
@@ -136,6 +143,8 @@ export async function startMcpServer(
   let generation = 0;
   let notifier: ReturnType<typeof startNotifier> | undefined;
   let recovery: Deps | undefined;
+  // plan 22: taken at the first initialize, held until this server closes; null: another server leads the boot
+  let boot: (() => void) | null | undefined;
   const invalidate = () => {
     generation++;
     if (recovery) recovery.host = { host: "unknown", session: null, conflict: null };
@@ -145,10 +154,17 @@ export async function startMcpServer(
     observed.clear();
     closed();
   };
-  server.server.onclose = invalidate;
+  server.server.onclose = () => {
+    invalidate();
+    boot?.();
+    boot = undefined;
+  };
   server.server.oninitialized = () => {
     invalidate();
     initialized();
+    boot ??= (o.bootLock ?? takeBootLock)();
+    const lead = boot !== null;
+    if (!lead) log("info", "boot", { skipped: "another catherd server runs the boot sync and reconcile" });
     log("info", "session", {
       host: deps.host.host,
       conflict: deps.host.conflict,
@@ -166,12 +182,14 @@ export async function startMcpServer(
     if (target) observed.set(sessionKey(target), active);
     void Promise.resolve()
       .then(() => {
-        if (epoch === generation) return (o.sync ?? (() => backgroundSync()))();
+        if (lead && epoch === generation) return (o.sync ?? (() => backgroundSync()))();
       })
       .catch((e: unknown) => log("debug", "sources", { error: errorMessage(e) }));
     void (async () => {
       try {
         if (epoch !== generation) return;
+        // the leading server reconciles every run; this one still tells its own session what it owns
+        if (!lead) return void active.scan();
         const r = await reconcileAll(context);
         if (epoch !== generation) return;
         const shown = r.warnings.length;
```

Create `src/infra/boot-lock.ts`:

```ts
import { join } from "node:path";
import { tryLock } from "./filelock.ts";
import { log } from "./log.ts";
import { locksDir } from "./paths.ts";
import { ensurePrivateDir } from "./store.ts";

/** The machine-wide lock the MCP server that runs the boot sync and reconcile holds for its life. */
export const bootLockTarget = (): string => join(locksDir(), "mcp-boot");

/**
 * Plan 22 (the three MCP servers of one Codex session): boot sync and reconcile are single-flight across
 * processes. The first server takes this lock (its pid and start time in it; a dead holder's is reclaimed) and
 * keeps it until it closes; a second server finds it held and skips both. Returns the release, or null while
 * another live server holds it. A lock that cannot be taken for another reason never costs a reconcile: the
 * server runs the boot work, with nothing to release.
 */
export function takeBootLock(): (() => void) | null {
  try {
    ensurePrivateDir(locksDir());
    return tryLock(bootLockTarget());
  } catch (e) {
    log("warn", "boot", { lock: bootLockTarget(), error: e instanceof Error ? e.message : String(e) });
    return () => {};
  }
}
```

Modify `test/entry/mcp-sync.test.ts`:

```diff
--- a/test/entry/mcp-sync.test.ts
+++ b/test/entry/mcp-sync.test.ts
@@ -1,12 +1,16 @@
-import { afterEach, describe, expect, it } from "bun:test";
+import { afterEach, describe, expect, it, spyOn } from "bun:test";
+import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
 import { Client } from "@modelcontextprotocol/sdk/client/index.js";
 import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
 import { startMcpServer } from "../../src/entry/mcp/server.ts";
+import { bootLockTarget } from "../../src/infra/boot-lock.ts";
+import { locksDir } from "../../src/infra/paths.ts";
+import * as reconcile from "../../src/services/reconcile.ts";
 import { backgroundSync, type SyncReport } from "../../src/services/source-sync.ts";
 import { fakeFetch } from "../fake-fetch.ts";
 import { snapshotEnv, withHome } from "../helpers.ts";
 import { call, mcpClient } from "../mcp-helpers.ts";
-import { fakeDeps } from "../services/helpers.ts";
+import { deadProcess, fakeDeps, waitFor } from "../services/helpers.ts";
 
 afterEach(snapshotEnv());
 
@@ -53,6 +57,59 @@ describe("catalog_sync (spec 1.2 §9)", () => {
   });
 });
 
+describe("one MCP server runs the boot sync and reconcile (plan 22, single-flight)", () => {
+  async function server(syncs: string[], label: string): Promise<Client> {
+    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
+    await startMcpServer({
+      transport: serverSide,
+      deps: fakeDeps(),
+      sync: async () => {
+        syncs.push(label);
+      },
+    });
+    const client = new Client({ name: "catherd-test", version: "0.0.0" });
+    await client.connect(clientSide);
+    // a tool call: the boot work of `initialized` has started by its answer
+    expect((await call(client, "status")).isError).toBe(false);
+    return client;
+  }
+
+  it("lets a second server skip both while the first is alive, and the next lead once it closes", async () => {
+    withHome();
+    const reconciles = spyOn(reconcile, "reconcileAll");
+    try {
+      const syncs: string[] = [];
+      const first = await server(syncs, "first");
+      await waitFor(() => reconciles.mock.calls.length === 1);
+      const second = await server(syncs, "second");
+      expect(syncs).toEqual(["first"]);
+      expect(reconciles.mock.calls).toHaveLength(1);
+      expect(readFileSync(`${bootLockTarget()}.lock`, "utf8")).toContain(`"pid":${process.pid}`);
+      await first.close();
+      const third = await server(syncs, "third");
+      await waitFor(() => reconciles.mock.calls.length === 2);
+      expect(syncs).toEqual(["first", "third"]);
+      await second.close();
+      await third.close();
+    } finally {
+      reconciles.mockRestore();
+    }
+  });
+
+  it("takes the lock over from a server that died holding it", async () => {
+    withHome();
+    mkdirSync(locksDir(), { recursive: true });
+    writeFileSync(
+      `${bootLockTarget()}.lock`,
+      JSON.stringify({ pid: await deadProcess(), startTime: "gone" }),
+    );
+    const syncs: string[] = [];
+    const c = await server(syncs, "after a crash");
+    await waitFor(() => syncs.length === 1);
+    await c.close();
+  });
+});
+
 describe("the boot sync (spec 1.2 §3.2)", () => {
   it("never delays the handshake or a tool call, even when every source hangs", async () => {
     withHome();
```

### Task 10: Push from where a role ends (spec: "Push from where a role ends")

`pushFromEnd(dispatchDir, o?)` (`src/services/end-push.ts`, Ruling 14) runs in the detached supervisor after `supervise()` returned an exit (`src/entry/supervise-command.ts`, a dynamic import): for a run a Codex thread owns, after `END_PUSH_GRACE_MS` (20 s; `CATHERD_END_PUSH_GRACE_MS` overrides), it finalizes the record (the claim protocol), skips a limit or a read record, takes the dispatch's notify lock, recovers a dead sender's claim, and sends `envelope(formatNotices([finishedNotice(…)]))` with `sendToCodexQueue` under one `delivery.json` attempt, unless `deliveryState` already reads `enqueue-accepted` or ambiguous. `recoverSubmission` in `notifier.ts` becomes an export. `test/preload.ts` sets `CATHERD_NO_END_PUSH=1`.

**Files:**
- Create: `src/services/end-push.ts`, `test/services/end-push.test.ts`
- Modify: `src/services/notifier.ts`, `src/entry/supervise-command.ts`, `test/preload.ts`

**Interfaces:** consumes Task 2's `Notice.thread` (the test reads `thread:` in the message); produces `pushFromEnd`, `END_PUSH_GRACE_MS`, `EndPushOutcome`, and the env switches `CATHERD_NO_END_PUSH` and `CATHERD_END_PUSH_GRACE_MS`.

- [ ] **Step 1: Write `test/services/end-push.test.ts`** (below; its last test spawns the real supervisor through `dispatch` with the simulator's `queue: "accepted"`).
- [ ] **Step 2: Run** `bun test test/services/end-push.test.ts` — fails (no module).
- [ ] **Step 3: Make the code changes below**, `test/preload.ts` included (without it, every spawned supervisor in the suite would wait its grace for a Codex-owned run).
- [ ] **Step 4: Run** `bun test test/services/end-push.test.ts test/services/notifier.test.ts test/services/dispatch.test.ts test/entry/supervise-bin.test.ts test/infra/supervisor.test.ts test/architecture.test.ts` — all pass.
- [ ] **Step 5: Commit** `feat(push): the supervisor queues a Codex owner's notice when its role ends`.

**Code (scratch commit `c775394`):**

Modify `src/entry/supervise-command.ts`:

```diff
--- a/src/entry/supervise-command.ts
+++ b/src/entry/supervise-command.ts
@@ -16,7 +16,7 @@ export async function runSupervise(specPath: string): Promise<void> {
   const a = adapterFor(spec.backend);
   const busy = a?.isBusy?.bind(a);
   const stop = a?.interrupt?.bind(a);
-  await supervise(spec, {
+  const ended = await supervise(spec, {
     onLine: (line) => {
       const d = a?.parse(line) ?? {};
       return { final: d.final, thread: d.thread, item: d.item };
@@ -26,6 +26,12 @@ export async function runSupervise(specPath: string): Promise<void> {
       : undefined,
     interrupt: stop ? (thread) => (thread ? stop(thread, spec.cwd) : Promise.resolve()) : undefined,
   });
+  // plan 22: a Codex owner hears of the role from here too, when its thread's MCP server is gone. Loaded only
+  // once the worker ended (a supervisor that lost the lock to another pushes nothing); never throws.
+  if (ended && process.env.CATHERD_NO_END_PUSH !== "1") {
+    const { pushFromEnd } = await import("../services/end-push.ts");
+    await pushFromEnd(spec.dispatchDir);
+  }
 }
 
 export const superviseCommand = defineCommand({
```

Create `src/services/end-push.ts`:

```ts
import { readFileSync } from "node:fs";
import { errorMessage } from "../domain/errors.ts";
import type { HostSessionRef } from "../domain/host.ts";
import { envelope, formatNotices } from "../domain/notice.ts";
import { type QueueSendResult, sendToCodexQueue } from "../infra/codex-queue.ts";
import { type DeliveryAttempt, deliveryState, writeDeliveryAttempt } from "../infra/delivery.ts";
import { awaitsCollect, dispatchPaths } from "../infra/dispatch-dir.ts";
import { tryLock } from "../infra/filelock.ts";
import { log } from "../infra/log.ts";
import { admitPath, listDispatches } from "./dispatches.ts";
import { finalizeDispatch } from "./finalize.ts";
import { finishedNotice, recoverSubmission } from "./notifier.ts";
import { findRun } from "./run-store.ts";
import { runOwner } from "./sessions.ts";

/**
 * How long the supervisor leaves the owner's MCP server to push first (the fast path: its watcher finalizes,
 * settles and sends within the notifier's coalescing window). Either path sends under the same per-event receipt,
 * so a late server or a late supervisor finds the event accepted and sends nothing.
 */
export const END_PUSH_GRACE_MS = 20_000;

/** `CATHERD_END_PUSH_GRACE_MS` (a test of the spawned supervisor shortens it), else END_PUSH_GRACE_MS. */
function graceFromEnv(): number {
  const ms = Number(process.env.CATHERD_END_PUSH_GRACE_MS);
  return process.env.CATHERD_END_PUSH_GRACE_MS !== undefined && Number.isFinite(ms) && ms >= 0
    ? ms
    : END_PUSH_GRACE_MS;
}

export interface EndPushOptions {
  graceMs?: number;
  /** the sender; tests replace it */
  sendCodex?: (target: HostSessionRef, content: string) => Promise<QueueSendResult>;
  now?: () => number;
}

/** Why the supervisor pushed nothing, or the receipt's status when it did. */
export type EndPushOutcome =
  | "off"
  | "not-a-run"
  | "not-codex"
  | "limit"
  | "read"
  | "busy"
  | "delivered"
  | DeliveryAttempt["status"];

/** The run's owner, when it is a Codex thread: the supervisor's push targets it. */
function codexOwner(runId: string): HostSessionRef | null {
  const owner = runOwner(findRun(runId));
  return owner?.host === "codex"
    ? { host: "codex", sessionId: owner.sessionId, hostSessionId: null, name: null }
    : null;
}

/**
 * Plan 22, push from where a role ends: the detached supervisor of a dispatch whose run a Codex thread owns, once
 * its worker exited, queues the role's notice to that thread with `codex queue --remote unix:// --thread <owner>`.
 * Codex's app-server keeps queued input for an unloaded thread, so a result reaches a coordinator whose MCP
 * server the daemon stopped (no client attached) at its next attach. The notice is the server's own text, and it
 * goes under the same per-event receipt (`delivery.json`, the dispatch's notify lock), so the two paths never
 * double-deliver. A usage limit is left to the owner's server, which fails it over before it announces it.
 * `CATHERD_NO_END_PUSH=1` turns it off (the test preload sets it). Never throws.
 */
export async function pushFromEnd(dispatchDir: string, o: EndPushOptions = {}): Promise<EndPushOutcome> {
  if (process.env.CATHERD_NO_END_PUSH === "1") return "off";
  try {
    const runId = (JSON.parse(readFileSync(admitPath(dispatchDir), "utf8")) as { runId?: unknown }).runId;
    if (typeof runId !== "string") return "not-a-run";
    // read before the grace: a run no Codex thread owns costs the supervisor nothing
    if (!codexOwner(runId)) return "not-codex";
    await Bun.sleep(o.graceMs ?? graceFromEnv());
    const run = findRun(runId);
    const d = listDispatches(run).find((x) => x.dir === dispatchDir);
    if (!d) return "not-a-run";
    const record = await finalizeDispatch(run, d);
    if (record.status === "limit") return "limit";
    // the owner of record now, which a claim may have changed during the grace
    const target = codexOwner(runId);
    if (!target) return "not-codex";
    if (!awaitsCollect(d.dir)) return "read";
    const notice = finishedNotice(run, d, record);
    const release = tryLock(dispatchPaths(d.dir).notified);
    if (!release) return "busy";
    try {
      recoverSubmission(d.dir, notice.eventId);
      if (deliveryState(d.dir, target, notice.eventId) !== "pending") return "delivered";
      const attempt: DeliveryAttempt = {
        attemptId: crypto.randomUUID(),
        target,
        eventIds: [notice.eventId],
        at: new Date((o.now ?? Date.now)()).toISOString(),
        status: "submitting",
        msgId: null,
        reason: null,
      };
      writeDeliveryAttempt(d.dir, attempt);
      let sent: QueueSendResult;
      try {
        sent = await (o.sendCodex ?? ((t, c) => sendToCodexQueue(t, c, process.env)))(
          target,
          envelope(formatNotices([notice])),
        );
      } catch {
        sent = { outcome: "ambiguous", reason: "Sender ended without a verified receipt; use peek/result." };
      }
      const receipt: DeliveryAttempt = {
        ...attempt,
        status:
          sent.outcome === "accepted"
            ? "accepted"
            : sent.outcome === "not-submitted"
              ? "failed"
              : "ambiguous",
        msgId: sent.outcome === "accepted" ? sent.msgId : null,
        reason: sent.outcome === "accepted" ? null : sent.reason,
      };
      writeDeliveryAttempt(d.dir, receipt);
      log(receipt.status === "accepted" ? "info" : "warn", "notify", {
        from: "supervisor",
        outcome: receipt.status,
        msgId: receipt.msgId,
        reason: receipt.reason,
        dispatches: [notice.dispatchId],
      });
      return receipt.status;
    } finally {
      release();
    }
  } catch (e) {
    log("warn", "notify", { from: "supervisor", dispatch: dispatchDir, error: errorMessage(e) });
    return "not-a-run";
  }
}
```

Modify `src/services/notifier.ts`:

```diff
--- a/src/services/notifier.ts
+++ b/src/services/notifier.ts
@@ -78,7 +78,8 @@ function legacyNotified(q: Queued, target: HostSessionRef): boolean {
   }
 }
 
-function recoverSubmission(dir: string, eventId: string): void {
+/** A "submitting" claim left by a sender that died is ambiguous: retrying it may duplicate input. Under the notify lock. */
+export function recoverSubmission(dir: string, eventId: string): void {
   for (const a of readDelivery(dir)) {
     if (a.status === "submitting" && a.eventIds.includes(eventId))
       writeDeliveryAttempt(dir, {
```

Modify `test/preload.ts`:

```diff
--- a/test/preload.ts
+++ b/test/preload.ts
@@ -2,6 +2,9 @@
 // public sources (spec 1.2 §3.2); no test may reach the network, and every process a test starts with its
 // env inherits this. A test of the sync itself deletes it and injects a fetch.
 process.env.CATHERD_NO_SYNC = "1";
+// Plan 22: a detached supervisor whose run a Codex thread owns pushes the role's notice itself, after a grace;
+// in tests it would outlive its test. A test of that push deletes it.
+process.env.CATHERD_NO_END_PUSH = "1";
 // A catherd worker runs this suite with its own catherd's data and config dirs in the env (movedHomeEnv); they win
 // over CATHERD_HOME, so a test that sets only CATHERD_HOME would write into the real ones.
 delete process.env.CATHERD_DATA_DIR;
```

Create `test/services/end-push.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostSessionRef } from "../../src/domain/host.ts";
import { readDelivery, writeDeliveryAttempt } from "../../src/infra/delivery.ts";
import { awaitsCollect } from "../../src/infra/dispatch-dir.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { dispatch, watchersSettled } from "../../src/services/dispatch-service.ts";
import { latestDispatch, type Dispatch } from "../../src/services/dispatches.ts";
import { pushFromEnd } from "../../src/services/end-push.ts";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import { finishedNotice, startNotifier } from "../../src/services/notifier.ts";
import { result } from "../../src/services/run-service.ts";
import type { Run } from "../../src/services/run-store.ts";
import { claimRun } from "../../src/services/sessions.ts";
import { snapshotEnv } from "../helpers.ts";
import { simPath, withScenario } from "../sim/scenario.ts";
import { fakeDeps, fakeDispatch, freshRun, waitFor, writeLane } from "./helpers.ts";

afterEach(() => watchersSettled());
afterEach(snapshotEnv());
beforeEach(() => {
  resetReadiness();
  // the preload turns the supervisor's push off for every other test
  delete process.env.CATHERD_NO_END_PUSH;
});

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
const OWNER = "0199c011-1234-7000-8000-000000000001";
const target: HostSessionRef = { host: "codex", sessionId: OWNER, hostSessionId: null, name: null };
const codexDeps = (sessionId = OWNER) =>
  fakeDeps({ host: { host: "codex", session: { ...target, sessionId }, conflict: null } });
const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };

/** A Codex-owned run with one finished, unrecorded dispatch, as its supervisor sees it once the worker exited. */
async function ended(events = "ok-with-reconnect.jsonl"): Promise<{ run: Run; d: Dispatch }> {
  const { run } = freshRun("Push it");
  await claimRun(codexDeps(), run);
  const d = await fakeDispatch(
    run,
    {},
    {
      proc: "dead",
      exit,
      events: readFileSync(join(FX, events), "utf8"),
      reply: "Done.\nSTATUS: complete — ok",
      collect: true,
    },
  );
  return { run, d };
}

function recorder() {
  const sent: { target: HostSessionRef; content: string }[] = [];
  return {
    sent,
    sendCodex: async (t: HostSessionRef, content: string) => {
      sent.push({ target: t, content });
      return { outcome: "accepted" as const, msgId: `m-${sent.length}` };
    },
  };
}

describe("push from where a role ends (plan 22)", () => {
  it("queues the server's notice to the Codex owner under the per-event receipt; the server then sends nothing", async () => {
    const { run, d } = await ended();
    const r = recorder();
    expect(await pushFromEnd(d.dir, { graceMs: 0, sendCodex: r.sendCodex })).toBe("accepted");
    const record = await finalizeDispatch(run, d);
    const notice = finishedNotice(run, d, record);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.target.sessionId).toBe(OWNER);
    expect(r.sent[0]?.content).toContain(`thread: ${record.thread}`);
    expect(r.sent[0]?.content).toContain(`Event: ${notice.eventId}`);
    // one attempt, claimed as submitting before the send and settled to its receipt
    expect(readDelivery(d.dir)).toMatchObject([
      { status: "accepted", msgId: "m-1", eventIds: [notice.eventId] },
    ]);
    // the owner's server reattaches and settles the same record: the receipt stops a second delivery
    const server = recorder();
    const n = startNotifier(codexDeps(), { coalesceMs: 0, sendCodex: server.sendCodex });
    try {
      n.onSettled({ run, d, record, hints: [], started: null, pause: null, stateHints: [] });
      await n.scan();
      await n.idle();
    } finally {
      n.stop();
    }
    expect(server.sent).toEqual([]);
    // queue acceptance is not collection
    expect(awaitsCollect(d.dir)).toBe(true);
  });

  it("sends nothing when the server's push was accepted first", async () => {
    const { run, d } = await ended();
    const record = await finalizeDispatch(run, d);
    const eventId = finishedNotice(run, d, record).eventId;
    writeDeliveryAttempt(d.dir, {
      attemptId: "server",
      target,
      eventIds: [eventId],
      at: new Date().toISOString(),
      status: "accepted",
      msgId: "from-server",
      reason: null,
    });
    const r = recorder();
    expect(await pushFromEnd(d.dir, { graceMs: 0, sendCodex: r.sendCodex })).toBe("delivered");
    expect(r.sent).toEqual([]);
  });

  it("leaves a usage limit to the owner's server, which fails it over first", async () => {
    const { d } = await ended("limit.jsonl");
    const r = recorder();
    expect(await pushFromEnd(d.dir, { graceMs: 0, sendCodex: r.sendCodex })).toBe("limit");
    expect(r.sent).toEqual([]);
  });

  it("does nothing, at once, for a run no Codex thread owns, a record already read, or when turned off", async () => {
    const { run } = freshRun("Claude");
    await claimRun(
      fakeDeps({ session: { sessionId: "s-me", hostSessionId: null, socketPath: null, token: null } }),
      run,
    );
    const d = await fakeDispatch(
      run,
      {},
      { proc: "dead", exit, reply: "x\nSTATUS: complete — ok", collect: true },
    );
    const r = recorder();
    // a grace it would wait out in full: the test's timeout says it never does
    expect(await pushFromEnd(d.dir, { graceMs: 60_000, sendCodex: r.sendCodex })).toBe("not-codex");
    const read = await ended();
    await finalizeDispatch(read.run, read.d);
    await result(codexDeps(), { run: read.run.id, name: read.d.admit.name });
    expect(await pushFromEnd(read.d.dir, { graceMs: 0, sendCodex: r.sendCodex })).toBe("read");
    process.env.CATHERD_NO_END_PUSH = "1";
    const off = await ended();
    expect(await pushFromEnd(off.d.dir, { graceMs: 0, sendCodex: r.sendCodex })).toBe("off");
    expect(r.sent).toEqual([]);
  });

  it("runs from the detached supervisor: codex queue --remote unix:// --thread <owner> when the worker exits", async () => {
    const { run } = freshRun("Push it");
    writeLane(run, "M1.L1", ["src/a.ts"]);
    process.env.PATH = simPath();
    process.env.CATHERD_END_PUSH_GRACE_MS = "0";
    Object.assign(
      process.env,
      withScenario({
        queue: "accepted",
        eventsFile: join(FX, "ok-with-reconnect.jsonl"),
        reply: "Done.\nSTATUS: complete — ok",
      }).env,
    );
    const deps = codexDeps();
    await dispatch(deps, {
      run: run.id,
      role: "worker",
      name: "worker-M1.L1",
      brief: "Read lanes/M1.L1.md",
      rung: "codex:gpt-6-luna#high",
      lane: "M1.L1",
    });
    const d = latestDispatch(run, "worker-M1.L1") as Dispatch;
    // no MCP server notifier runs in this test: only the supervisor can have queued it
    const accepted = await waitFor(() => readDelivery(d.dir).find((a) => a.status === "accepted"));
    expect(accepted).toMatchObject({
      target: { host: "codex", sessionId: OWNER },
      msgId: "01a0f547-7947-7972-90a0-a7ad547170e0",
    });
  });
});
```

### Task 11: `doctor --test-push --thread <uuid>` and the `test_push` tool (spec: "`doctor --test-push --thread <uuid>`")

`withThread(host, thread)` (`src/entry/host-arg.ts`) makes the host that Codex thread, refusing a non-UUID and a Claude Code host; `doctor` takes `--thread`, which needs `--test-push` (Ruling 15). `test_push` (`src/entry/mcp/push-tools.ts`, registered in `buildServer`) returns `probePush(deps.host, process.env)` for the call's own session. The skill's tool table and Codex half, and the README's doctor row, name both.

**Files:**
- Create: `src/entry/mcp/push-tools.ts`
- Modify: `src/entry/host-arg.ts`, `src/entry/doctor-command.ts`, `src/entry/mcp/server.ts`, `plugin/skills/catherd/SKILL.md`, `README.md`
- Test: `test/services/doctor-push.test.ts`, `test/entry/doctor-command.test.ts`, `test/entry/mcp.test.ts` (32 tools), `test/skills.test.ts`

**Interfaces:** produces `withThread(host, thread)`, `registerPushTools(server, deps)`, the `test_push` tool, `doctor --thread`.

- [ ] **Step 1: Write the tests below** (two in `doctor-push.test.ts`, the `--thread` lines of the spawned doctor test, the tool list, the skills test).
- [ ] **Step 2: Run** `bun test test/services/doctor-push.test.ts test/entry/mcp.test.ts test/skills.test.ts` — fails.
- [ ] **Step 3: Make the code changes below.**
- [ ] **Step 4: Run** `bun test test/services/doctor-push.test.ts test/entry/mcp.test.ts test/skills.test.ts test/plugin.test.ts test/entry/doctor-command.test.ts` — all pass.
- [ ] **Step 5: Commit** `feat(doctor): --test-push --thread <uuid>, and the test_push tool inside a session`.

**Code (scratch commit `08d18df`):**

Modify `README.md`:

```diff
--- a/README.md
+++ b/README.md
@@ -46,7 +46,7 @@ of work, climbing a ladder only when a cheaper rung falls short.
 
 `catherd doctor` checks each backend's version and login and prints the fix for anything missing. The default
 profile runs its workers on Codex; without Codex, doctor's fix also names how to move those roles to a backend
-you have (`/catherd-setup`, or `catherd profile set roles.<role>.rungs <rung> --host <codex|claude-code>`). Codex-only setup does not require or configure Claude; enabled selected roles and reachable failover decide optional dependencies. Doctor sends nothing by default; `--test-push` is an explicit smoke send from a validated host session.
+you have (`/catherd-setup`, or `catherd profile set roles.<role>.rungs <rung> --host <codex|claude-code>`). Codex-only setup does not require or configure Claude; enabled selected roles and reachable failover decide optional dependencies. Doctor sends nothing by default; `--test-push` is an explicit smoke send from a validated host session (`--thread <uuid>` names the Codex thread from a shell; inside a session, the `test_push` tool does the same).
 
 ### Cursor
 
@@ -189,7 +189,7 @@ In a terminal:
 | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
 | `catherd`                                                                                   | The dashboard: Status, Profiles and Runs (below)                                                    |
 | `catherd init [--host codex\|claude-code\|auto] [--no-input] [--no-global] [--profile <p>]` | First-run setup; installs the global `catherd` at its own version unless `--no-global`              |
-| `catherd doctor [--host codex\|claude-code\|auto] [--test-push] [--json]`                   | Readiness and capability report; no send unless explicit smoke; exits 3 when not ready              |
+| `catherd doctor [--host codex\|claude-code\|auto] [--test-push [--thread <uuid>]] [--json]` | Readiness and capability report; no send unless explicit smoke; exits 3 when not ready              |
 | `catherd profile list\|show\|use [--repo]\|new [--from <p>]\|copy\|rm\|diff\|validate`      | Profiles; `use --repo` binds one to the repo you are in                                             |
 | `catherd profile use --repo --clear`                                                        | Unbinds the repo you are in; it runs on the active profile again                                    |
 | `catherd profile set <path> <value> [--profile <p>]`                                        | One field, e.g. `roles.verifier.access read-only`, `roles.worker.network false`, `budget.usd 20`    |
```

Modify `plugin/skills/catherd/SKILL.md`:

```diff
--- a/plugin/skills/catherd/SKILL.md
+++ b/plugin/skills/catherd/SKILL.md
@@ -49,6 +49,7 @@ Pass the actual project `repo` explicitly to profile, setup and catalog tools th
 | `dispatch(run, role, name, brief, rung, thread?, lane?, next?)`                                       | Starts one process role (Codex, claude-code or opencode) and returns at launch, in about a second, with `dispatched`. It routes a lane not routed yet, appends the role's reply contract to the brief, and its result arrives as a catherd message                                                               |
 | `result(run, name)`                                                                                   | A role's latest reply, capped, its record and its `hints`; reading a finished record marks it read                                                                                                                                                                                                               |
 | `cancel(run, name)`                                                                                   | Stops a live role and returns its record, `cancelled`, and `hints`                                                                                                                                                                                                                                               |
+| `test_push()`                                                                                         | One labeled smoke message to this session through catherd's push; its receipt proves the host accepted it, never that you read it. From a shell: `catherd doctor --test-push --thread <uuid>`                                                                                                                    |
 | `record_agent_run(run, name, role, rung, total_tokens, duration_ms?, cost_usd?, status?, lane?)`      | Native Claude Agent results on Claude Code only. The budget counts them; `lane` counts their time toward that lane's kind; a verifier named `verifier-<M>` records FAIL with `status: "failed"`                                                                                                                  |
 | `climb(run, lane, reason, evidence?, env?)`                                                           | The lane's next rung, with its `backend` and `agent`, or `top: true`. `env: true` when the environment, not the rung, caused it                                                                                                                                                                                  |
 | `ask(run, question, state)`                                                                           | Jev's `finding` or `same-defect` answer                                                                                                                                                                                                                                                                          |
@@ -211,6 +212,7 @@ Nothing else pushes: a phone that buzzes for progress teaches the user to ignore
 
 - **Run inside tmux.** When `$TMUX` and `$STY` are both empty, tell the user once, at the run's start, to run the coordinator inside `tmux` (or `screen`): Codex's app-server stops a thread's MCP servers once no client is attached, so an SSH drop detaches you. Each role's supervisor also queues its result to your thread when it ends, and the queued input waits for the next attach.
 - **Goal mode.** A goal continuation while only roles are live ends the turn with no tool call: no `peek`, no `sleep`, no `pidwait` or other wait cell, no role work of your own. When unsure, one `peek(run)` answers it: `actionable: false` and its `reason` mean nothing is yours to do until the next catherd message.
+- **Test the push from inside the thread** with `test_push`, when the user asks whether results will reach you: a shell cannot name this thread, since Codex does not export its id to the commands it runs.
 
 ## The run folder
```

Modify `src/entry/doctor-command.ts`:

```diff
--- a/src/entry/doctor-command.ts
+++ b/src/entry/doctor-command.ts
@@ -1,5 +1,6 @@
 import { gitToplevel } from "../infra/git.ts";
-import { HOST_ARG, terminalHost } from "./host-arg.ts";
+import { CatherdError } from "../domain/errors.ts";
+import { HOST_ARG, terminalHost, withThread } from "./host-arg.ts";
 import { defineCommand } from "citty";
 import { VERSION } from "../infra/version.ts";
 import { type DoctorReport, doctor } from "../services/doctor.ts";
@@ -42,11 +43,20 @@ export const doctorCommand = defineCommand({
       description:
         "send one labeled smoke to the validated original session (receipt does not prove processing)",
     },
+    thread: {
+      type: "string",
+      description:
+        "with --test-push: the Codex thread to send the smoke to (Codex does not export it to the commands it runs)",
+    },
     plain: { type: "boolean", description: "ASCII glyphs (NO_COLOR drops only colour)" },
   },
   async run({ args }) {
+    if (args.thread !== undefined && args["test-push"] !== true)
+      throw new CatherdError("E_INPUT_INVALID", "--thread only names where --test-push sends its smoke", {
+        fix: `catherd doctor --test-push --thread ${args.thread}`,
+      });
     const r = await doctor({
-      host: terminalHost(args.host),
+      host: withThread(terminalHost(args.host), args.thread),
       repo: await gitToplevel(process.cwd()),
       bunVersion: Bun.version,
       version: VERSION,
```

Modify `src/entry/host-arg.ts`:

```diff
--- a/src/entry/host-arg.ts
+++ b/src/entry/host-arg.ts
@@ -10,6 +10,34 @@ export const HOST_ARG = {
   },
 };
 
+const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
+
+/**
+ * Plan 22, `doctor --test-push --thread <uuid>`: Codex does not export its thread id to the commands it runs, so a
+ * shell names the thread the smoke goes to. It makes the host that Codex thread; a Claude Code session refuses it.
+ */
+export function withThread(host: HostContext, thread: string | undefined): HostContext {
+  if (thread === undefined) return host;
+  if (!UUID.test(thread))
+    throw new CatherdError("E_INPUT_INVALID", `--thread ${thread} is not a Codex thread id`, {
+      fix: "pass the thread's UUID, as the first line of a catherd message names it (thread: <uuid>)",
+    });
+  if (host.host === "claude-code")
+    throw new CatherdError(
+      "E_INPUT_INVALID",
+      "--thread names a Codex thread, and this is a Claude Code session",
+      {
+        fix: "run catherd doctor --test-push without --thread from Claude Code",
+      },
+    );
+  const sessionId = thread.toLowerCase();
+  return {
+    host: "codex",
+    session: { host: "codex", sessionId, hostSessionId: null, name: null },
+    conflict: null,
+  };
+}
+
 export function terminalHost(value: string | undefined, env = process.env): HostContext {
   if (value === undefined || value === "auto") return resolveHost({ env });
   if (value !== "codex" && value !== "claude-code")
```

Create `src/entry/mcp/push-tools.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { probePush } from "../../services/doctor-push.ts";
import type { Deps } from "../../services/ports.ts";
import { handle } from "./result.ts";

export function registerPushTools(server: McpServer, deps: Deps): void {
  server.registerTool(
    "test_push",
    {
      description:
        "Send this session one labeled smoke message through catherd's push (Claude Code's peer inbox, or the native Codex queue for this thread) and return the receipt: { outcome, enqueue, processing, msgId, detail }. A receipt proves the host accepted it, never that the model read it. For a check from inside a session, where a shell cannot name the Codex thread; catherd doctor --test-push --thread <uuid> is the shell's form.",
      inputSchema: {},
    },
    () => handle(() => probePush(deps.host, process.env)),
  );
}
```

Modify `src/entry/mcp/server.ts`:

```diff
--- a/src/entry/mcp/server.ts
+++ b/src/entry/mcp/server.ts
@@ -17,6 +17,7 @@ import { defaultDeps } from "../deps.ts";
 import { registerDispatchTools } from "./dispatch-tools.ts";
 import { registerLaneTools } from "./lane-tools.ts";
 import { registerProtocolTools } from "./protocol-tools.ts";
+import { registerPushTools } from "./push-tools.ts";
 import { sdkToolError, toolOf } from "./result.ts";
 import { registerRunTools } from "./run-tools.ts";
 import { registerSetupTools } from "./setup-tools.ts";
@@ -109,6 +110,7 @@ export function buildServer(deps: Deps = defaultDeps(), observe?: ObserveSession
   registerDispatchTools(server, scoped);
   registerSetupTools(server, scoped);
   registerProtocolTools(server, scoped);
+  registerPushTools(server, scoped);
   return server;
 }
```

Modify `test/entry/doctor-command.test.ts`:

```diff
--- a/test/entry/doctor-command.test.ts
+++ b/test/entry/doctor-command.test.ts
@@ -252,4 +252,15 @@ it("default CLI doctor sends nothing; explicit smoke preserves receipt-only repo
       .map((line) => JSON.parse(line))
       .filter((c) => c.args.includes("--message")),
   ).toHaveLength(1);
+  // plan 22: a shell names the thread Codex does not export to it
+  const thread = "01a0f53b-a47d-7350-83a4-c3430e4534ff";
+  const named = runCodex("--host", "codex", "--test-push", "--thread", thread);
+  expect(named.push).toMatchObject({ enqueue: "accepted", processing: "unconfirmed" });
+  const sent = readFileSync(envTo, "utf8")
+    .trim()
+    .split("\n")
+    .map((line) => JSON.parse(line))
+    .filter((c) => c.args.includes("--message"));
+  expect(sent).toHaveLength(2);
+  expect(sent[1].args.slice(0, 5)).toEqual(["queue", "--remote", "unix://", "--thread", thread]);
 }, 60_000);
```

Modify `test/entry/mcp.test.ts`:

```diff
--- a/test/entry/mcp.test.ts
+++ b/test/entry/mcp.test.ts
@@ -45,13 +45,14 @@ const TOOLS = [
   "workspace_contract",
   "workspace_child_start",
   "workspace_status",
+  "test_push",
 ];
 
 describe("MCP server", () => {
-  it("lists exactly the run and workspace tools, 31 of them", async () => {
+  it("lists exactly the run and workspace tools, 32 of them", async () => {
     freshRun();
     const c = await mcpClient();
-    expect(TOOLS).toHaveLength(31);
+    expect(TOOLS).toHaveLength(32);
     expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([...TOOLS].sort());
     const described = (name: string) =>
       c.listTools().then((l) => l.tools.find((t) => t.name === name)?.description ?? "");
```

Modify `test/services/doctor-push.test.ts`:

```diff
--- a/test/services/doctor-push.test.ts
+++ b/test/services/doctor-push.test.ts
@@ -5,7 +5,9 @@ import type { HostContext } from "../../src/domain/host.ts";
 import { resolveHost } from "../../src/infra/host-context.ts";
 import { claudeHome } from "../../src/infra/paths.ts";
 import { probePush, pushCheck } from "../../src/services/doctor-push.ts";
-import { terminalHost } from "../../src/entry/host-arg.ts";
+import { terminalHost, withThread } from "../../src/entry/host-arg.ts";
+import { call, mcpClient } from "../mcp-helpers.ts";
+import { fakeDeps } from "./helpers.ts";
 import { snapshotEnv, tempDir, withHome } from "../helpers.ts";
 import { type FakeInbox, fakeInbox } from "../sim/peer-inbox.ts";
 import { simPath, withScenario } from "../sim/scenario.ts";
@@ -98,6 +100,38 @@ describe("explicit push smoke", () => {
     expect(JSON.stringify(probe)).not.toContain("never-report");
   });
 
+  it("lets a shell name the Codex thread the smoke goes to (plan 22: doctor --test-push --thread)", () => {
+    const host = withThread(terminalHost("codex", {}), uuid.toUpperCase());
+    expect(host).toEqual(codex);
+    expect(withThread(codex, undefined)).toBe(codex);
+    expect(() => withThread(codex, "not-a-thread")).toThrow("--thread not-a-thread is not a Codex thread id");
+    const claude: HostContext = {
+      host: "claude-code",
+      session: { host: "claude-code", sessionId: "s-1", hostSessionId: null, name: null },
+      conflict: null,
+    };
+    expect(() => withThread(claude, uuid)).toThrow("--thread names a Codex thread");
+  });
+
+  it("serves the smoke from inside a session as the test_push tool, to the thread of the call", async () => {
+    withHome();
+    process.env.PATH = simPath();
+    const envTo = join(tempDir("smoke-"), "calls");
+    Object.assign(process.env, withScenario({ queue: "accepted", envTo }).env);
+    // a Codex client: the server resolves its thread as it does for every call
+    process.env.CODEX_THREAD_ID = uuid;
+    const c = await mcpClient(fakeDeps(), "codex-mcp-client");
+    const r = await call(c, "test_push");
+    expect(r.data).toMatchObject({ outcome: "ok", enqueue: "accepted", processing: "unconfirmed" });
+    const sent = (await Bun.file(envTo).text())
+      .trim()
+      .split("\n")
+      .map((s) => JSON.parse(s) as { args: string[] })
+      .filter((f) => f.args.includes("--message"));
+    expect(sent).toHaveLength(1);
+    expect(sent[0]?.args.slice(0, 5)).toEqual(["queue", "--remote", "unix://", "--thread", uuid]);
+  });
+
   it("preserves no-session for gone Claude inbox and ambiguous malformed Codex receipt", async () => {
     withHome();
     const env = {
```

Modify `test/skills.test.ts`:

```diff
--- a/test/skills.test.ts
+++ b/test/skills.test.ts
@@ -60,6 +60,14 @@ describe("orchestrator skill", () => {
     expect(codex).toContain("`actionable: false`");
   });
 
+  it("names test_push in the tool table and the Codex half, with the shell's --thread form (plan 22)", () => {
+    const md = skill("catherd");
+    expect(md).toContain("| `test_push()`");
+    expect(md).toContain("`catherd doctor --test-push --thread <uuid>`");
+    const codex = md.slice(md.indexOf("### On Codex"), md.indexOf("\n## ", md.indexOf("### On Codex")));
+    expect(codex).toContain("with `test_push`");
+  });
+
   it("dispatches roles one after another, then ends its turn; results arrive as catherd messages (spec 1.1 §3.8)", () => {
     const md = skill("catherd");
     const after = md.slice(
```

### Task 12: The `wait` residue sweep (spec: "Remove `wait`"; X2)

#45 removed the tool, its service, tests and skill text; a scan of `src/`, `plugin/`, `README.md`, `docs/dev/` and `docs/handoff/process/` on `6f2f8c7` found no remaining tool mention outside "`wait` is gone" lines and historical evidence in `ideas.md`. This task adds the guard that keeps it so: no `wait` tool on the coordinator's or a role's server, and no `wait(`, `` `wait` `` or `"wait"` in the plugin, the MCP entry, the role prompts and tools, or the README, except on a line that says it is gone or removed.

**Files:**
- Create: `test/wait-residue.test.ts`

- [ ] **Step 1: Write the test below and run** `bun test test/wait-residue.test.ts` — passes on a clean tree; to see it bite, add `` `wait` `` to a plugin file and run it again (fails, naming the line), then revert.
- [ ] **Step 2: Commit** `test(wait): guard against any residue of the removed wait tool`.

**Code (scratch commit `5d831fa`):**

Create `test/wait-residue.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { roleMcpTools } from "../src/domain/role-tools.ts";
import { ROLES } from "../src/domain/roles.ts";
import { withHome } from "./helpers.ts";
import { mcpClient } from "./mcp-helpers.ts";

// Plan 22 (owner ruling 1, X2): `wait` is gone (#45). Nothing a coordinator or a role reads may name it as a tool
// again: no MCP tool, no `wait(` call, no `wait` in backticks outside a line that says it is gone.

const ROOT = join(import.meta.dir, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** Every file the plugin ships or a coordinator or role reads: the plugin, the MCP entry, the prompts, the README. */
const READ = [
  ...files(join(ROOT, "plugin")),
  ...files(join(ROOT, "src", "entry", "mcp")),
  join(ROOT, "src", "domain", "role-prompts.ts"),
  join(ROOT, "src", "domain", "role-tools.ts"),
  join(ROOT, "README.md"),
];

const naming = /\bwait\(|`wait`|"wait"/;
const gone = /\b(gone|removed)\b/;

describe("no residue of the removed wait tool (plan 22)", () => {
  it("lists no wait tool on the coordinator's server or on any role's", async () => {
    withHome();
    const names = (await (await mcpClient()).listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("wait");
    for (const role of ROLES) expect(roleMcpTools(role)).not.toContain("wait");
  });

  it("names wait as a tool nowhere a coordinator or a role reads, except where it says it is gone", () => {
    const found = READ.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          naming.test(line) && !gone.test(line) ? [`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`] : [],
        ),
    );
    expect(found).toEqual([]);
  });
});
```

### Task 13: `ideas.md` and the live-verification steps (last task)

Removes from `docs/dev/ideas.md` exactly what this plan fixed (Ruling 16) and adds `docs/dev/live-verification.md` §15 (X8: the daemon's detach behaviour, tmux once, goal mode, one server, the smoke, exit 143, two final replies). If plan 21 ran first, its section numbers come first: renumber §15 to follow the last one.

**Files:**
- Modify: `docs/dev/ideas.md`, `docs/dev/live-verification.md`

- [ ] **Step 1: Apply the diff below** (re-find each entry by its bold title; plan 21 removes other #42 findings from the same list).
- [ ] **Step 2: Run the full gate:** `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test`.
- [ ] **Step 3: Commit** `docs(ideas): drop what plan 22 fixed; live-verification steps for delivery and the loop`.

**Code (scratch commit `80db213`):**

Modify `docs/dev/ideas.md`:

```diff
--- a/docs/dev/ideas.md
+++ b/docs/dev/ideas.md
@@ -7,13 +7,7 @@ into a spec or plan under `docs/specs/` or `docs/plans/` (or a GitHub issue) and
 ## From the reviews of #42 and #43 (2026-10-02)
 
 Both PRs were merged as they stood (owner decision); the findings below are fixed in the next autopilot run, not by
-the contributor. Owner rulings:
-
-- **`wait` goes.** A 50 s bounded wait makes the Codex coordinator re-read its whole context about every 50 s (about
-  100 rounds for a 90-min gate), the goal-mode polling problem in a blessed form, and it dies with the turn when the
-  daemon drops the thread. Remove the tool and its skill text; deliver instead from where a role ends (the
-  supervisor's `codex queue` push in "A completion is lost once the daemon drops the thread" below). Keep the
-  "waiting for orchestrator" line from #42, with the fix in finding 3.
+the contributor.
 
 #42 (role MCP server, `wait`), review findings:
 
@@ -26,17 +20,11 @@ the contributor. Owner rulings:
 2. **Runs started isolated break on resume.** A resumed thread keeps its record's `isolated`, so fix rounds,
    verifier re-checks and failover stand-ins on an isolated backend are refused even after the user turns isolation
    off. Goes away with finding 1.
-3. **"waiting for orchestrator · stalled" never clears.** `runOwner` is never cleared and a dashboard `cancel` or an
-   abandoned run leaves a record unread forever, so old runs show stalled forever and `status()` with no run returns
-   all of them into the coordinator's context. Fix: only for a current owner and recent unread records; `status()`
-   keeps defaulting to live runs, else the newest.
 4. **`read_knowledge` on the role server takes `z.literal(run.meta.repo)`**, refusing `.`, the pwd, or
    `/tmp` vs `/private/tmp`. Make `repo` optional and use the run's.
 5. **`RUN_FILES` tells every role to write with `write_run_file`**, which workers and verifiers do not get.
 6. **doctor's role-MCP row:** fails inactive profiles; `existsSync(ROLE_MCP_ENTRY)` is always true; `profile
    validate` should say it instead.
-7. **The TUI memo calls `orchestratorWait` on every tick for every idle run** (defeats the mtime memo), and
-   `runs.tsx` uses the precomputed `stalled` while `status.tsx` recomputes it.
 8. **`required=true` on the role server** aborts the whole role when a cold Bun start beats Codex's MCP startup
    timeout on a loaded machine. Check the timeout; set `startup_timeout_sec` or drop `required`.
 9. **`docs/dev/reports/role-access-orchestration-wait-pr.md`** is a PR description, not a run report; delete it.
@@ -133,10 +121,6 @@ From the plan 14 final review (`cff7d19..04a48e2`) and its plan writer:
 
 Owner rule for the end of 1.1: review Minors and non-correctness bot P2s land here, not in code. Each is small.
 
-- **Push and sessions (plan 10).** `watch()` in dispatch-service settles and fails over a limit without checking
-  that this session still owns the run (failover-once keeps it to one stand-in, but the old owner can start it).
-  Codex activity is computed twice per line; a file change with no paths shows `edit `; Claude tool activity shows
-  only the tool name (opencode shows its first argument).
 - **Runs page (TUI).** A ref is written during render in `runs.tsx`; the role screen keeps polling a finished role;
   a recent run opened from the Status tab lands on the session's first role, not that run; a session opens on its
   first milestone row and live roles can sit below the fold; `milestoneAt` rebuilds its list on every key; a
@@ -506,7 +490,6 @@ Run `20260928-172920-m3-auth-plan-5-mr-b-the-kit-clean-up` (sanitell/platform, a
 
 - **Messages arrive only when the next turn starts.** worker-M3.L1 ended at 17:43:08, and its catherd message reached the main thread only after the owner's next message, about 20 min later. An idle main thread is not woken. Until something wakes it, `peek` is the only way to see it, and the owner read the silence as a hang. Fix: wake an idle owner session, or let `status` show "finished, unread" prominently.
 - **`protocol.next` ignores lane order.** It said "dispatch M3.L3, M3.L4" while both depended on L1's kit changes, which have to compile first. Admission guards only file overlap, not package-level compile coupling. Fix: add a `After: M3.L1` lane header that `protocol.next` and admission respect.
-- **The dispatch description still says "wait(run) collects its record".** `wait` was removed in 1.1.0.
 
 **Lanes and Owns**
 
@@ -523,7 +506,6 @@ Run `20260928-172920-m3-auth-plan-5-mr-b-the-kit-clean-up` (sanitell/platform, a
   Fix: give non-lane roles an Owns (or a docs lane), and attribute each edit to the process that wrote it.
 - **Jev overrode the lane headers.** All four first lanes declared `Kind`/`Difficulty`, and routing replaced them (declared logic → `repo_code`/`copy`), so the logic lanes started on `luna#high`. Fix: a declared header wins, or the route record says why it didn't.
 - **A lane could not declare an allowed exception to its own absence grep.** The plan's `func Allowed` grep also matched an unrelated `services/verification/internal/job/command.go:120`, and `acceptancetest\.SignIn` matched the surviving `SignInAuth` and `SignInSSO`. The workers returned partial correctly, but a check that can never pass looks the same as work that isn't done yet. Fix: an `Allow:` line under the check, and word boundaries in plan greps.
-- **`dispatch` accepted a thread id that doesn't exist.** The orchestrator passed a wrong thread for the L4 fix, the role launched, and codex failed with "no rollout found for thread id". Fix: check `thread` against `runs.jsonl` (same name) before launching, or default to the name's last thread.
 
 **Preflight and environment**
 
@@ -549,8 +531,7 @@ Run `20260928-172920-m3-auth-plan-5-mr-b-the-kit-clean-up` (sanitell/platform, a
 **Resume (2026-09-29)**
 
 - **A "foreground" verifier is still a background agent.** On the resume, the orchestrator briefed the verifier to stay in the foreground, and the Agent tool launched it async anyway ("Async agent launched successfully"). The verifier can block inside its own turn, but the main thread only learns the verdict from a notification. Fix: the skill says so plainly, and `protocol.next` treats the verifier as a dispatched role whose result arrives as a message, not as a call that returns.
-- **`status` shows a stale verifier step as live.** After the round-2 verifier was gone, `status` and `peek` still reported `verifier: {item: "acceptance notification", at: 10:04:03Z}`, with no process running. They also listed the previous owner session as `live: true` after a new session had taken the run. `gate_check` records a step, but nothing ends one. Fix: close the step on `gate_pass`, on `record_agent_run(role: verifier)`, or when the owning session is gone, and show its age.
-- **`state.md`'s Next outlives the step.** It still read "dispatch M3.L1 at codex:gpt-6-sol#medium on a fresh thread" ten hours after that dispatch ended ok (L1 attempt 3, 23:55). Fix: `result()` of the named dispatch clears or advances Next.
+- **`status` lists a previous owner session as live.** After a new session had taken the run, `status` and `peek` still listed the previous owner session as `live: true` (the stale verifier step itself closes since 1.5).
 - **The profile is not pinned per run either.** The active profile changed from the codex one to `just-claude` while M3 was paused, so the run's verifier rung changed (`catherd-default-verifier-*` is gone and `catherd-just-claude-verifier-claude-opus-5-5-low` took over), and any re-dispatched lane would route on Sonnet instead of the Codex rungs it started on. Nothing in the run records the switch. Fix: same as the sandbox item: pin the profile at `run_start`, or log the change in `state.md`.
 - **A host probe needs to run twice.** Right after the AnyConnect VPN was disconnected, the first unsigned Go probe to `203.0.113.20` still got `no route to host`. The next seven, including one from a freshly built binary on a fresh network, answered 200. A single probe would have stopped the run for nothing. Fix: when catherd ships a host probe, it retries once after a few seconds before calling the host blocked.
 
@@ -577,7 +558,6 @@ catherd 1.2.1, profile just-claude, sanitell/platform payment plans 1–11. That
 - **`route` bloats the orchestrator.** Every call returns the full provenance block, about 3k tokens per lane, into the most expensive context of the run. Fix: return rung, ladder, backend and agent, and write provenance to `R/routes.jsonl`.
 - **Ladders were inverted on just-claude.** `Difficulty: build` lanes got the ladder [sonnet#high] with no room to climb (source `jev-kind`). `logic` lanes started lower, at sonnet#medium. Every claude-code value in provenance was `inferred` from a gpt-6-sol benchmark. Evidence: the first four routes of runs `-113331`, `-113334` and `-113338`.
 - **`dispatch` needs a rung it then overrides.** `rung` is required, even when the lane is not routed yet. The orchestrator guessed a rung, and dispatch overrode it with a hint. Fix: make `rung` optional on a lane dispatch.
-- **The catherd message does not carry the thread id.** Passing the dispatchId gave `E_ADMIT_THREAD`. Every fix round needed `jq … runs.jsonl`. Fix: put `thread:` in the message's first line, or accept `thread: "latest"`.
 - **Lane values are refused only at preflight.** `Difficulty: medium` (the word plans use) was refused as `E_LANE_INVALID` at preflight, not when `write_run_file` wrote the lane. Evidence: run `-135414`.
 - **There is no `lane_set`.** Fixing one header line (a fast check without `pnpm check`, or an Owns path) meant `sed` on the run folder. Evidence: runs `-113331` and `-143512`.
 
@@ -598,7 +578,6 @@ catherd 1.2.1, profile just-claude, sanitell/platform payment plans 1–11. That
   Climb, accept or rerun is left to the orchestrator.
 - **An environment block is not tagged.** A worker replied `STATUS: blocked` with `ENV: vpn` on its own line, but the hints did not flag it. Climb-by-default would have spent a rung. Evidence: run `-113338`, worker-M1.L4.
 - **Lanes share the testcontainers reaper.** Parallel lanes on one daemon failed with "reaper container name already in use". Evidence: run `-135414`, worker-M1.L1.
-- **A final reply can overwrite the report.** worker-M1.L3 of plan 9 sent a second, short reply ("the notification is just my wait loop…"), and `result` showed that one. The real report with its deviations survived only in `events.jsonl`. Fix: keep the report reply, or concatenate.
 
 **Reviewers and verifiers**
 
@@ -620,7 +599,6 @@ catherd 1.2.1, profile just-claude, sanitell/platform payment plans 1–11. That
 
 catherd 1.2.1, sanitell/platform review-fix plans 1–7, one run per plan and its worktree, seven MRs merged to staging (!73–!79) in about 13 h 20 min. Already listed above and seen again: one run per worktree (`dispatch` takes no cwd), and a "foreground" verifier that runs in the background anyway.
 
-- **A resumed worker exits 143.** A worker that left a command running in the background in its previous turn gets exit 143 when its thread is resumed. Fix: the worker contract forbids leaving background processes behind, and `dispatch` kills the thread's process group before a resume.
 - **`protocol.next` offers the verifier before the fix round.** After a reviewer returns findings, the next step it names is the verifier, not the fix round. Fix: `protocol.next` reads the reviewer record, and with open BLOCKER or BUG lines it names the fix round.
 - **A verifier resumed with SendMessage hangs.** More than once, the resumed verifier never returned. The workaround was a fresh verifier with a 10-minute cap on each command. Fix: re-checks go to a fresh verifier by default, with the failed items named and a per-command timeout in its brief; `gate_check` already carries over what passed.
 - **`preflight` times out at 300 s behind the lock.** With testcontainers suites from other lanes holding the lock slots, preflight waited past its own timeout. Fix: preflight takes a lock slot per check with its own wait budget, or reports `lock-busy` instead of a timeout.
@@ -635,30 +613,6 @@ clean by 03:30. The six and a half hours after that went to seven verifier attem
 failures. The coordinator read 26.7 M input tokens (97 % cached). The harnesses were isolated until 10:20, when the
 owner turned isolation off (the host is itself a sandbox).
 
-- **A completion is lost once the daemon drops the thread.** Codex 0.159/0.160 runs threads in its app-server
-  daemon (pid 241476, up since 2026-10-01 21:33). The TUI is only a client, and catherd's MCP server is a child of
-  the daemon, not of the TUI. Timeline, all from logs:
-  - The owner's SSH dropped at 08:42:57 (sshd: `Read error from remote host … Connection timed out`). The
-    coordinator ran on bare SSH, not in tmux.
-  - The daemon finished the coordinator's turn anyway: last dispatch 08:47:57, turn end 08:48:02.
-  - At 08:49:05 the daemon closed the thread's MCP clients (`rmcp::transport::streamable_http_client: fail to
-    delete session` in `~/.codex/app-server-daemon/daemon.stderr.log`). The same signature appears at 10:28:48,
-    when the owner closed the TUI on purpose. catherd's server for the thread (pid 345390, 164 tool calls and 26
-    `notify` since 00:24) logged nothing after that.
-  - `researcher-M1-notification-fake` ended at 09:03:32 with no server left to push it. The next `notify` came at
-    09:38:04 from a new server (634083) that reconciled after the owner reattached at 09:36. The run sat for
-    35 minutes.
-
-  Most likely the daemon unloads a thread, and stops that thread's MCP servers, once its turn ends and no client is
-  attached. One fact does not fit yet: 634083 outlived the 10:28 TUI restart, maybe because a client reattached
-  within a grace period. Pin this down with a controlled detach before relying on it.
-
-  Fix: push from where a role ends, not only from the MCP server. On exit, the detached supervisor runs
-  `codex queue --remote unix:// --thread <owner>`. The daemon outlives every client and keeps queued input for an
-  unloaded thread (README: "unloaded/interrupted hosts may retain input"), so the notice waits for the next attach.
-  Keep the server-side push as the fast path, with the existing per-event receipt so the two never double-deliver.
-  The Codex half of the skill tells the coordinator to run inside tmux and says so once when `$TMUX` is empty.
-  (`src/infra/codex-queue.ts`, the supervisor, `src/services/notifier.ts`, `plugin/skills/catherd`.)
 - **Isolated roles cannot reach catherd's own tools.** The isolated `CODEX_HOME` has no catherd MCP server. The
   verifier was told to call `gate_check`/`gate_pass`, so it wrote a stdio MCP client (`/tmp/m1-verifier-mcp.py`),
   wrapped it in `/tmp/m1-gate.py`, and drove `catherd mcp` by hand for every gate item. That spawned about 200 one-shot `catherd mcp` processes, one per call (03:31–10:17 in
@@ -679,13 +633,10 @@ owner turned isolation off (the host is itself a sandbox).
   (`roles.verifier.timeouts.wallMin`). Or count the wall from the last output, not from the start, while a
   `catherd lock` child of the role is alive and writing. The verifier brief also splits the root gate from the
   per-service acceptance items by default.
-- **Codex goal mode turns into polling.** After the owner set a thread goal ("never stop again…"), Codex started a
-  goal-continuation turn about once a minute. There were 11 such turns in 21 minutes, which read 7.2 M input
-  tokens on Astra. They ran `pidwait`, `write_stdin` with 55 s yields and `wait` cells, and the coordinator also did
-  role work itself (browser preflight, GitLab docs research). Fix: the Codex half of the catherd skill says that a
-  goal continuation while only roles are live ends the turn with no tool call. `peek` returns
-  `actionable: false` with the reason, so the coordinator has a one-call answer. Also consider `run_start` warning
-  when the thread has an active goal.
+- **`run_start` could warn about an active Codex goal.** In the identity run a thread goal made Codex start a
+  goal-continuation turn about once a minute (11 turns in 21 minutes, 7.2 M input tokens). Since 1.5 the skill ends
+  such a turn with no tool call and `peek` answers `actionable: false`; a warning at `run_start` when the thread
+  has an active goal would catch it before the first poll.
 - **Equal scores never reach the second quota.** In 34 dispatches there were 0 opencode rungs and 0 climbs. Under
   `objective: speed`, DeepSeek 4.1 Flash max (treat-like GPT-6 Luna xhigh, the same values as Luna high) sits
   second in the worker ladder, so Luna always won. The writer and researcher ladders behaved the same way. The
@@ -716,10 +667,6 @@ owner turned isolation off (the host is itself a sandbox).
   internal names (`minio-buckets` could not reach `minio`) and a BusyBox `wget` loopback health check
   (`notification-fake`). Three of the seven verifier attempts failed on it. Fix: doctor warns when the client config
   has `proxies`, and probes a two-container compose network by service name with a loopback `wget` health check.
-- **`doctor --test-push` cannot find a Codex thread from a shell.** Codex does not export `CODEX_THREAD_ID` to the
-  commands it runs. The thread reaches catherd only as `_meta.threadId` on MCP calls, so the smoke always reports
-  `no session` even inside a live thread. Fix: a `test_push` MCP tool, or `--thread <uuid>`, or resolve the cwd's
-  latest thread from `~/.codex/session_index.jsonl`.
 - **Roles litter `/tmp`.** The run left about 250 files there: drivers, observers, ledgers, a 51 MB `payment`
   binary, and logs copied between roles. This host's `/tmp` is a 5.9 GiB tmpfs with a per-user quota that had
   already broken a TUI once. Fix: each dispatch gets `TMPDIR=<run>/scratch/<role>/`, the brief names it, and
```

Modify `docs/dev/live-verification.md`:

```diff
--- a/docs/dev/live-verification.md
+++ b/docs/dev/live-verification.md
@@ -924,3 +924,33 @@ catherd runs retry-push <run> <name> --event '<exact event ID>' --acknowledge-po
 Preserve all event IDs through retry/coalescing; duplicate input remains an idempotent record read. The actual catherd record and reviewer/verifier gate, not a forged or echoed envelope, determine what can land. Record accepted, ambiguous, failed and collected states separately, and retain unread work on failures.
 
 The controller records exact commands, hashes, actual host observations, deviations and unverified cases in the acceptance report. Release stays held until the real packaged flow passes in both Codex surfaces and Claude Code, including busy ordering and the unchanged gate. No daemon research, fixture, skipped test, source-only skill read or isolated handshake marks an installed skill flow passed. Keep the existing Changesets/stamp/release tooling; this section authorizes neither CI nor publication.
+
+## 15. Delivery and the loop (1.5, plan 22)
+
+On a Codex host (0.159 or later, the app-server daemon running), with catherd from this branch installed as the
+plugin, one scratch repo and a run owned by a Codex TUI thread. Record each result in the acceptance report.
+
+1. **A completion survives a detach.** Start the coordinator outside tmux, dispatch one worker whose fast check
+   takes about two minutes, then close the terminal (or drop the SSH session) while it runs. Wait past the worker's
+   end plus 20 s (the supervisor's grace). Look for: `notify` with `"from":"supervisor"` and `outcome: accepted` in
+   `catherd-<date>.jsonl`, and the dispatch's `delivery.json` holding one accepted attempt for the thread. Reattach
+   (`codex resume`): the catherd message arrives as the next input, its first line naming `thread:`. Repeat with the
+   terminal left attached: the MCP server's push wins (`notify` without `from`), and the supervisor logs nothing
+   (its receipt check found the event accepted). This also pins down the daemon behaviour the identity run left
+   open (a thread unloaded once no client is attached, and the grace before it).
+2. **tmux, once.** In a shell where `$TMUX` and `$STY` are empty, start a run: the coordinator tells the user once
+   to run inside tmux, and not again on later turns.
+3. **Goal mode.** Set a thread goal, dispatch two workers, and let the goal continue: each continuation ends with no
+   tool call while only the workers run. A `peek(run)` in that stretch answers `actionable: false` with its reason.
+4. **One MCP server per session.** Open one Codex TUI and count `catherd mcp` processes and `reconcile` log rows: one
+   server leads (`reconcile`), any other logs `boot … skipped`.
+5. **The push smoke.** From inside the thread, call `test_push`; from a shell, `catherd doctor --test-push --thread
+   <uuid>` with the uuid the last catherd message named. Both report `enqueue accepted`, and the labeled smoke
+   arrives in that thread.
+6. **Resume hygiene (exit 143).** Brief a worker to start `sleep 600 &` and reply; then resume its thread for a fix
+   round (`thread: "latest"`). The resumed role ends `ok`, not exit 143, and `dispatch` returns the hint
+   `resume: stopped what … left running on thread …`. If a resumed worker still exits 143, record the process tree
+   of the old turn (`ps -o pid,pgid,sid,cmd`): a background command outside the worker's process group is the case
+   plan 22 does not cover.
+7. **Two final replies.** Brief a worker to reply, then emit a second short message after a background command's
+   notification; `result` returns the report first, the short one under `later:`, and the report's STATUS.
```
