# catherd 1.1 — Plan 10: push results to the main thread, `peek`, and the runs page by session

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The main thread never blocks on a worker again: `wait` is gone, catherd's MCP server announces each finished (or stalled, or failed-over) role to the Claude Code session that owns its run over the session's peer inbox, `peek` answers "how is it going" without waiting, and `result` marks a record read. Runs are grouped by the Claude Code session that drove them, in `catherd runs list`, `status` and a live Runs tab (sessions → a session's runs, milestones and roles → a role).

**Architecture:** Disk stays the truth (spec §3.2). A dispatch is **settled** as soon as it is finalized, by whichever process finalizes it (its own watcher, or reconcile after a restart): a usage limit fails over there, once per limited dispatch (`failover.lock`, `failover.json`), and every **settled hook** runs. The MCP server's **notifier** (`services/notifier.ts`) is one such hook: for a run whose **owner session** (`state.json` `owner`, set by `run_start`, `dispatch` and `peek`) is this server's session, it sends the record's notice through `infra/peer-inbox.ts` (one frame per message, coalesced 3 s, `notified.json` so a restart never repeats one) and scans for unannounced records on start. The supervisor writes `stall.json` once when a worker goes quiet; watchers hand it to **stall hooks**. `result` consumes the collect mark (the lease `wait` used). `services/session-view.ts` groups runs by `meta.startedBy` and `R/sessions.jsonl`; `services/runs-page.ts` builds the Runs tab's three screens, which redraw on `fs.watch` of the run folders.

**Tech Stack:** Bun ≥ 1.4 (`node:net` Unix sockets, `fs.watch` recursive), TypeScript 7, zod 4, `@modelcontextprotocol/sdk` 1.30, `@opentui/react` 0.5.12 (the TUI, pinned), oxlint, oxfmt. No new dependency.

**Spec:** `docs/specs/2026-09-28-catherd-1.1-design.md` — §3 (push delivery, `peek`, `wait` removed, `result` consumes, doctor `push`), §4 (sessions and the runs page), §14 (the tool list: 21 tools after this plan), §15 (the tests that concern these). The 1.0 spec (`docs/specs/2026-09-25-catherd-1.0-design.md`) holds where 1.1 is silent. Research: `docs/research/2026-09-28-cross-session-messaging.md` (written by Task 1 from the controller's static spike of the installed Claude Code 2.1.283).

**Pre-validated** on scratch branch `worktree-agent-a4c7ec5414a4f0b16` at **`7b08323`** (on `main` `a2e6aa4`), every task built in order, each task's new tests seen failing first, the full gate after each task: **1257 pass / 10 skip / 0 fail** at the end (1182 pass before the plan). Task commits on the scratch branch: T1 `c7a51e9`, T2 `c3a9667`, T3 `28c4355`, T4 `75d653b`, T5 `a548f15`, T6 `c22fbc5`, T7 `fc9d42e`, T8 `c2b042b`, T9 `bce7370`, T10 `eb928a5`, T11 `7b08323`. Every code block below is taken from those commits.

## Global Constraints

- Layers `domain → infra → adapters → services → entry` (spec §3.1 of 1.0; `test/architecture.test.ts`): `domain/notice.ts` is pure; `infra/peer-inbox.ts` and `infra/claude-session.ts` touch only sockets and files; the notifier, sessions, peek, session-view and runs-page modules are services; the MCP tools, CLI and TUI are entry.
- Spec §3.2: "**Disk stays the source of truth.** … A message only announces that a record exists. A lost message loses nothing." "**The MCP server is the only sender.** … The supervisor never sends." "**Only non-native roles notify through catherd.**"
- Spec §3.4: `peer-inbox.ts` "writes one frame to a socket path with a token and closes after 150 ms. It never throws into callers: it returns `sent | no-session | refused | error` with a reason." Notices "within 3 s of each other for the same session are sent as one message". "After a send returns `sent`, it writes `notified` … so a restart does not send it twice. The `collect` marker stays until a tool reads the record."
- Spec §3.6: `now` is never used; ends go `later`; `limit`, `blocked`/`refused` replies and a stall go `next`; progress lines are never sent.
- Controller rulings on the spike (bind every task): (a) never declare `from-mode`; Linux behaves as macOS; `doctor`'s `held` advice names `crossSessionInbound`. (b) The self-sent rule runs on Linux (`/proc` walk). (c) `doctor` finds the transcript by globbing `<claude config>/projects/*/<sessionId>.jsonl`. (d) The live session id comes from `<claude config>/sessions/<pid>.json` (the env id goes stale after `/clear`). (e) The auth line carries `CLAUDE_CODE_MESSAGING_TOKEN`, no `session_id` field, and the socket closes 150 ms after the write.
- **No test ever messages a real Claude Code session.** `withHome()` (test/helpers.ts, Task 4) deletes `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_HOST_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` and points `CLAUDE_CONFIG_DIR` at the test's home; every test that needs a session builds a fake one (`test/sim/peer-inbox.ts`). Only `startMcpServer` starts a notifier and only `catherd doctor` runs the push probe. When you run the suite from inside a Claude Code session before Task 4 lands, unset those four variables in the shell first.
- Tests: an isolated `CATHERD_HOME` per test; `afterEach(snapshotEnv())` where a test sets env; spawned processes get an explicit `env`; `ANTHROPIC_API_KEY` deleted or blanked where discovery could run; no wall-clock sleep for correctness (wait on a file, a frame, a process state, with a deadline; a worker script may be slow on purpose, never the test).
- Gate after every task: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test` (run `bun run format` first). Commits: Conventional Commits, subject ≤ 100 characters, first word lower-case; never a `bun.lock` rewritten by an older Bun.
- Diff blocks are unified diffs (`-U5`) against the tree the previous task left; save one to a file and `git apply` it, or apply it by hand, finding each hunk by its text if lines moved. "Replace the whole of" and "Create" blocks are the complete file.
- Plans 11 and 12 add no tool before this plan merges; this plan adds no changeset (plan 12's last task adds the 1.1.0 changeset).

## Review Focus

1. **Claude Code changes or refuses the inbox protocol** (a new release, a `crossSessionInbound` of `hold`). Expected: nothing breaks and nothing is lost: the send returns an outcome instead of throwing, no `notified.json` is written, the record stays unread for `peek`/`result`, and `catherd doctor` says `held` or `failed` with the fix. Pinned by Task 2 ("returns no-session without a socket, or when the socket is gone, and never throws", "returns error, with the reason, when the path is not a socket"), Task 5 ("writes nothing when the session's socket is gone") and Task 8 (the `held`/`failed` rows).
2. **The user runs `/clear` (or `/resume`) mid-run, or continues the run from another session.** Expected: notices follow the session that owns the run now, by its live id. Pinned by Task 4 ("reads the live session id from the registry, not the one the environment had before /clear", "moves the run to a session that continues it, once") and Task 5 ("tells a session that took a run over about the live roles another session's server launched").
3. **The orchestrator reads a record (a `peek` it acted on, a `result`) before its notice goes out, or two servers settle the same limited dispatch.** Expected: no stale notice, and exactly one stand-in. Pinned by Task 5 ("drops a notice whose record was read before the message went out") and Task 3 ("reuses the stand-in when a limit is settled a second time: no second launch", "is settled by the next server's reconcile …, once").
4. **The suite runs inside a Claude Code session** (the owner runs it from Desktop). Expected: no test sends to that session and no child catherd starts gets its inbox token. Pinned by Task 4 ("keeps the messaging socket and token from every process catherd starts", "gives every test a Claude config dir of its own and no session").
5. **A run folder cannot be watched** (a platform without recursive `fs.watch`, a network disk). Expected: the open screen still updates, once a second. Pinned by Task 11 ("redraws the open session when a run file changes, and polls every second where it cannot watch") and Task 11's `watchDirs` tests.


## Rulings on the spec

1. **Never declare `from-mode`; Linux behaves as macOS** — the session file has no permission mode, a wrong class holds the message at a prompting receiver, and the self-sent rule (a `/proc` walk on Linux, `ps` on macOS) passes the MCP server anyway; spec §3.9's Linux fallback is replaced, and Task 1 corrects §3.1/§3.9's wording in the spec itself (controller rulings a, b) — cost if wrong: on a bypass-mode session whose self-sent check fails, messages are held until the user sets `crossSessionInbound`, which `doctor` names.
2. **Task 1 is a document and a standalone script, not a hidden doctor mode** — the static spike is done; the repo needs the facts (`docs/research/2026-09-28-cross-session-messaging.md`) and the owner needs one command to confirm live delivery on macOS and Linux (`bun scripts/spike-push.ts`, no `src/` imports, so it runs before any of this plan is built); the rest of the plan does not wait for it — cost if wrong: if the live spike fails, Tasks 2–8 still stand (disk is the truth) and only the sender's frame changes.
3. **The live session is read from its registry file, found by socket path, then the parent pid, then the env session id** (controller ruling d) — the socket path is stable across `/clear` and names exactly one file; the pid covers a missing socket variable — cost if wrong: a stale id makes the notifier skip runs the session owns under its new id (they still appear in `peek`).
4. **One write of the auth line and the frame, closed after 150 ms on every OS, no `session_id`** (controller ruling e) — the receiver parses a final fragment on `end`, so the delay costs nothing on Linux, and a stale `session_id` would drop the frame — cost if wrong: none measured; the owner's spike confirms.
5. **Settling replaces `wait`'s collection as the moment catherd acts on a record** — every finalize is followed by `settle` in the same process (the dispatch's watcher, reconcile's watcher, reconcile's pass over finished and unsettled dispatches): failover for a limit, state.md with the pause, the settled hooks. Any server may settle any run, since failover runs once per limited dispatch under `failover.lock`, and its outcome (the stand-in, the pause, the limited record's hints) is written to `failover.json` — cost if wrong: a crash between admitting a stand-in and writing `failover.json` is recovered by the next settle, which reuses the admitted stand-in (the existing `failoverOf` logic, kept).
6. **`result(run, name)` marks read every finished, unread record of that name up to the latest, and returns `hints`** — the hints `wait` used to return (`climb:`, `violation:`, `failed: read …`, `limit: … failed over to …`) now come from `result`; an earlier record it marks read (a limit its stand-in replaced) puts its hints first; `cancel` marks its record read too — cost if wrong: an orchestrator that reads only the stand-in's name still sees the limit line.
7. **Reconcile settles only unread limits** (`collect` mark present, no `failover.json`) — a 1.0 limit that `wait` read long ago must not fail over now — cost if wrong: a limit read by `result` before its settle ran is never failed over; the orchestrator sees `limit:` in the hints and the run is paused by nobody (rare: settle runs right after finalize).
8. **Hooks are module-level sets in `dispatch-service.ts` (`settledHooks`, `stallHooks`); only `startMcpServer` starts the notifier** — the in-memory MCP servers of the tests, the CLI and the TUI never send — cost if wrong: none; a later caller that wants notices calls `startNotifier`.
9. **The owner is `state.json`'s `owner: { sessionId, since }`, claimed by `run_start`, `dispatch` and `peek` with a `run` (not a `peek` without one)**, and a claim that changes the owner appends to `R/sessions.jsonl` and **adopts** the run: this process watches the run's live dispatches it is not already watching (the `watching` set, shared with reconcile), so the new owner's server settles and announces them — cost if wrong: without adoption, roles launched by another session's still-running server would be announced to nobody.
10. **A failover stand-in carries the limited dispatch's `sessionId`**, whichever process fails it over — the stand-in answers to the session that dispatched the role — cost if wrong: none.
11. **`scrubSecrets` drops `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` from every process catherd starts** (workers, git, `lock`, the doctor's MCP handshake server) — spec §3.2 makes the MCP server the only sender, and a worker with the token could message the user's session — cost if wrong: a tool a worker runs that expected those variables does not get them (none known).
12. **Coalescing is a debounce: a message goes 3 s after the last notice queued, and never more than 15 s after the first**; its priority is the most urgent of its notices; a notice whose record was read or announced meanwhile is dropped; a send that fails is logged and not retried — spec §3.4 ("within 3 s of each other"; "notices are not sent") — cost if wrong: a trickle of finishes waits up to 15 s.
13. **The message's details** (spec §3.5 leaves them open): the STATUS slot reads `STATUS: <word>` or `no STATUS`; seconds as `<n>s`; `1 owned file changed` in the singular; a limit's status slot reads `limit on <rung>; failed over to <rung>`, `…; paused: no stand-in`, `…; paused: the stand-in was refused`, or `…; its stand-in is a Claude agent: result(run, name) has the hint`; a multi-role preview names each role by its lane (else its name); a stall reads `stalled: no output for <n> min · running <secs>s` with a `Peek:` line in place of `Record:`; the body neutralises the envelope's own tag name — cost if wrong: wording only.
14. **A stall is written once per dispatch by the supervisor** (`stall.json`) at half the idle timeout without output when not busy (no open tool call and `isBusy` false, asked once per quiet stretch); watchers see it on their poll and call the stall hooks; the notifier sends it once (`stall-notified.json`), only while the role has not finished — cost if wrong: a slow worker that prints nothing for half its idle timeout sends one `next` message.
15. **`peek`'s last event is the adapter's new `activity` (a command, a file edit or a message line), else the event's name**, from the last 200 lines of `events.jsonl`, cut to 160 characters; Codex, claude-code and opencode report it. Parked questions (§8) and the protocol's next step (§10) are plan 11's; this plan's `peek` returns the run's `next` note and the latest `record_agent_run` row — cost if wrong: plan 11 adds two fields.
16. **`deps.tickMs`, `CATHERD_TICK_MS` and `progressTo` go with `wait`** — only `wait` reported progress — cost if wrong: none.
17. **The `push` row runs only from `catherd doctor`** (`DoctorDeps.push` is optional; the dashboard does not pass it: a re-check there would message the session each time). Outcomes: `ok`; `no session` (skip); `held` (warn: sent, no enqueue line within 5 s; the fix names `crossSessionInbound`); `not confirmed` (warn: sent, no transcript found); `failed` (fail: the socket would not take it) — cost if wrong: the dashboard shows no push row.
18. **Runs by session**: a run belongs to the session in `meta.startedBy`; each other session in its `sessions.jsonl` lists it too, "continued here", and its starter says "continued in <the latest other>"; "earlier runs" (no `startedBy`) comes last; a session's activity is the newest write to its runs' state and record files, counting a run it lost to another session only from its start. `catherd status` prints each run once, under its starting session; `runs list` shows the links; `--json` rows (and `RunSummary`, so the `status` tool too) gain `session` and `continuedIn` — cost if wrong: a moved run shows once more or once less.
19. **The session screen replaces the 1.0 run screen**: per run a heading (repo, start, budget %, where it moved), its milestones (the ledger's landed ones, then each `M<n>` a lane file names that has not landed; `plan.md` is not parsed), and one row per role name (its latest dispatch), live ones first. Climbs and route decisions leave the dashboard (`catherd runs show` and `status` keep them) — cost if wrong: a user who watched climbs in the dashboard reads them in `runs show`.
20. **Live redraw**: `fs.watch` (recursive) on the open session's run folders, a burst gathered for 100 ms; while watching works the screen still re-reads every 5 s (a run that joins the session has no watch yet); where it fails, every 1 s; `p` stops both; a live role's elapsed time ticks every second from its admission time — cost if wrong: a new run in the open session appears up to 5 s late.
21. **The frames cover spec §4's four states as five stories** (`runs-empty`, `runs`, `session`, `session-live`, `role`); a story may name its fixtures (`Story.fixtures`), which the frame snapshots honour and the storybook, running on one fixture set, does not — cost if wrong: the storybook's "no runs yet" story shows the default fixtures.
22. **The skill gets the minimal edit only** (plan 11 rewrites its orchestration text): every mention of `wait` goes; dispatch, one status line, end the turn, act on catherd messages with `result`, `peek` once when asked or resuming — cost if wrong: none; `test/skills.test.ts` forbids any `wait` mention.

## Owner questions

1. **Task 1 edits the 1.1 spec's §3.1 and §3.9** to match the spike (the self-sent rule on Linux; no `from-mode` fallback; `CLAUDE_CODE_HOST_SESSION_ID` host-only; the transcript glob). The spec awaits your review of its text; provisional default: the edits are made, each marked "(Corrected by plan 10's spike …)" where it matters.
2. **Please run `bun scripts/spike-push.ts` once from a Claude Code session's Bash tool on macOS** (and on Linux if you use it), and paste its verdict into the PR. Provisional default: the plan proceeds on the static spike.

## Assumes from earlier plans

None: this is the first 1.1 plan; it starts from `main` at `a2e6aa4` (1.0 with plan 9 and the 1.1 spec).

## What later plans may rely on (the executor re-checks these names)

- MCP tools: 21 — `wait` gone, `peek(run?, name?)` added (`src/entry/mcp/dispatch-tools.ts`); `result` returns `{ name, state, record, reply, replyPath, hints }` and marks records read.
- `src/services/dispatch-service.ts`: `settle(deps, run, d, record): Promise<Settled>`, `interface Settled { run; d; record; hints; started; pause; stateHints }`, `settledHooks`, `stallHooks`, `interface Stalled`, `stallPoll(run, d)`, `watch(deps, run, d)`, `adopt(deps, run)`, `watching`, `unsettledLimits(run)`, `watchersSettled()`.
- `src/services/dispatches.ts`: `readFailover(dir)`, `recordHints(run, d, record)`, `Admit.sessionId?`; `src/infra/dispatch-dir.ts` `dispatchPaths(dir).failover | notified | stall | stallNotified`.
- `src/services/peek.ts`: `peek(deps, { run?, name? }) → { runs: PeekRun[]; hints }`, `PeekRun { run, title, owner, live, unread, native, next }` (plan 11 adds parked questions and the protocol's next step here).
- `src/services/sessions.ts`: `currentSession(deps)`, `claimRun(deps, run)`, `runOwner(run)`, `readSessionRows(run)`; `src/services/ports.ts` `Deps.session: SessionEnv | null` (no `tickMs`).
- `src/services/notifier.ts`: `startNotifier(deps, { coalesceMs?, send? })`, `finishedNotice`, `stalledNotice`; `src/domain/notice.ts`: `formatNotices`, `noticeHeader`, `envelope`, `priorityOf`.
- `src/services/doctor-push.ts`: `probePush(env)`, `pushCheck(probe)`, `DoctorDeps.push?` (row id `push`).
- The skill's `## Waiting` section as Task 3 and Task 7 leave it (plan 11 rewrites it).

## Verified facts this plan relies on

- **The blocks reproduce the validated tree:** each task's diff blocks were applied with `git apply` and its Create/Replace blocks written, on top of the previous task's pre-validated tree; every task's result is identical to its scratch commit (apart from the generated frames Task 11 regenerates).
- **The installed Claude Code (2.1.283, Linux) registry and transcript, read live while writing this plan** (no message sent): `~/.claude/sessions/<pid>.json` holds `pid, sessionId, cwd, startedAt, procStart, version, peerProtocol, peerFeatures, kind, entrypoint, pidDomain, messagingSocketPath, name, nameSource, nameSince, updatedAt, status, statusUpdatedAt` and no permission mode; the socket is `/tmp/cc-socks/<pid>.sock` (0600); the transcript `~/.claude/projects/-home-user-catherd/<sessionId>.jsonl` has `{"type":"queue-operation","operation":"enqueue","timestamp":…,"sessionId":…,"content":…}` lines; the MCP-visible env had `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN` and no `CLAUDE_CODE_HOST_SESSION_ID` (a cloud session). `bun scripts/spike-push.ts --dry-run` found the registry by its socket and printed the frame.
- **The static spike** (`strings` of the binary, by the controller): the frame, the auth rules, the drop rule, priorities, the envelope order and re-serialisation, the gate and the self-sent rule on Linux (`/proc`, 12 levels, `SO_PEERCRED`) and macOS (`ps`, 10/32 levels, child-token fallback) — all in the research document Task 1 writes.
- **Bun 1.4.2**: `fs.watch(dir, { recursive: true })` reports changes in existing and newly created subfolders on Linux (checked with a scratch script: `roles/x/1/events.jsonl`, a new `roles/y/2/exit.json`, `state.md` all reported). `node:net` `createServer({ allowHalfOpen: true })` and `createConnection({ path })` serve the fake inbox and the sender.
- **UNVERIFIED:** live delivery into a real session on macOS and Linux (the owner's spike, Owner question 2); recursive `fs.watch` on macOS (FSEvents supports it; CI's macOS leg runs `watchDirs`'s test); that an MCP server finds the socket and token already set at spawn (the `session` log row Task 5 adds shows it on the first real start).

## File Structure

```
docs/research/2026-09-28-cross-session-messaging.md   (new, T1)  the spike's facts, so the repo stands alone
scripts/spike-push.ts                                  (new, T1)  the owner's live check, standalone
docs/specs/2026-09-28-catherd-1.1-design.md            (T1)       §3.1/§3.9 errata
src/domain/notice.ts                                   (new, T2)  the message: header, blocks, cap, preview, envelope
src/infra/peer-inbox.ts                                (new, T2)  one frame to a session's inbox; outcomes, never throws
test/sim/peer-inbox.ts                                 (new, T2)  a fake inbox socket that records frames
src/services/dispatch-service.ts                       (T3, T4, T5, T6)  settle, failover once, hooks, watch/adopt; no wait
src/services/dispatches.ts                             (T3, T4)   failover.json, recordHints; Admit.sessionId
src/services/run-service.ts                            (T3, T4)   result marks read, returns hints; run_start records the session
src/services/reconcile.ts                              (T3, T5, T6)  settles what it finalizes, and unsettled limits
src/services/finalize.ts                               (T3, T4, T6, T10)  waitForFinish(onPoll); records copy sessionId; lastActivity
src/infra/dispatch-dir.ts                              (T3, T5, T6)  failover/notified/stall paths; mark means "not yet read"
src/entry/mcp/dispatch-tools.ts                        (T3, T7)   no wait, no progressTo; peek
src/infra/claude-session.ts                            (new, T4, T8)  the session env and registry files
src/services/sessions.ts                               (new, T4)  currentSession, owner, sessions.jsonl, claimRun
src/infra/env.ts                                       (T4)       scrubSecrets drops the inbox socket and token
src/services/notifier.ts                               (new, T5, T6)  notices, coalescing, notified.json, start scan, stalls
src/entry/mcp/server.ts                                (T5)       session log row, notifier start and scan
src/infra/supervisor.ts                                (T6)       stall.json once per dispatch
src/adapters/{backend,codex/index,claude-code/index,opencode/index}.ts  (T7)  EventDelta.activity
src/services/peek.ts                                   (new, T7, T10)  peek
src/services/doctor-push.ts                            (new, T8)  the push probe and its row
src/services/doctor.ts, src/entry/doctor-command.ts    (T8)       the push row
src/services/session-view.ts                           (new, T9)  runs grouped by session
src/services/summary.ts, src/entry/runs-command.ts     (T9)       RunSummary.session/continuedIn; runs list and status by session
src/services/runs-page.ts                              (new, T10) the Runs tab's data: sessions, a session, a role
src/entry/tui/{effects,fixtures,state,stories,commands}.ts, providers/data.tsx, views/{runs,status}.tsx  (T11)
plugin/skills/catherd/SKILL.md, test/skills.test.ts    (T3, T7)   no wait; end the turn; result; peek
README.md, CONTRIBUTING.md, docs/dev/manual-tests.md, docs/dev/ideas.md, docs/tui-frames.md  (T3, T7, T9, T11)
```

## Parallelism

Tasks that share no files and whose inputs exist can run in parallel worktrees; each merges before its dependents start.

| Wave | Tasks | Needs |
|---|---|---|
| 1 | 1 (research, spike script, spec errata), 2 (notice, peer inbox, fake inbox), 3 (settle, `result` reads, `wait` removed) | `main` |
| 2 | 4 (session identity, ownership) | 3 (`dispatch-service.ts`, `run-service.ts`, `admission.ts`, `dispatches.ts`, `finalize.ts`) |
| 3 | 5 (notifier) | 2 (`sendToInbox`, `formatNotices`), 3 (`settle`, hooks), 4 (`currentSession`, `runOwner`, `Deps.session`) |
| 4 | 6 (stalls), 7 (`peek`, activity, stdio push test), 9 (runs by session in the CLI) | 6, 7: 5 · 9: 4 |
| 5 | 8 (doctor `push`), 10 (runs page data) | 8: 7 (it renames an import in `peek.test.ts` and `mcp-stdio.test.ts`) · 10: 6 (`finalize.ts`), 7 (`peek.ts`), 9 (`session-view.ts`) |
| 6 | 11 (the Runs tab) | 9 (`RunSummary.session`), 10 (`runs-page.ts`) |

Shared files, different blocks: Tasks 3, 4, 5, 6 all edit `src/services/dispatch-service.ts` (in that order). Tasks 6 and 7 are disjoint (6: supervisor, notifier, dispatch-service, finalize, reconcile and their tests; 7: adapters, `peek.ts`, dispatch-tools, `mcp.test.ts`, `mcp-stdio.test.ts`, the skill). Tasks 8 and 10 both edit `test/services/peek.test.ts`'s imports (8: `claudeConfigDir` → `claudeHome`; 10: `lastActivity` from `finalize.ts`): keep both lines when merging. Task 9 edits `src/entry/tui/fixtures.ts` (two fields); Task 11 replaces the file.

---


### Task 1: The spike, written down: research document, owner-run push script, spec errata

Spec §3.9's first task, done statically by the controller on the installed Claude Code 2.1.283 (Linux build): this task puts the facts in the repo (`docs/research/2026-09-28-cross-session-messaging.md`, so the repo stands alone), gives the owner a one-command live check (`scripts/spike-push.ts`, standalone: it imports nothing from `src/`), and corrects the spec's §3.1 and §3.9 where the spike proved them wrong (Rulings 1–4). Nothing else in the plan waits for the owner's run of the script. No test: the script is a manual check (it would message the session that runs it), and `docs/` is outside the formatter.

**Files:**
- Create: `docs/research/2026-09-28-cross-session-messaging.md`
- Modify: `docs/specs/2026-09-28-catherd-1.1-design.md`
- Create: `scripts/spike-push.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the research document every later task cites; `bun scripts/spike-push.ts [--dry-run]`.

- [ ] **Step 1: Write the document, the script and the errata**

#### Create `docs/research/2026-09-28-cross-session-messaging.md`

````markdown
# Cross-session messaging in Claude Code — research for catherd 1.1 push delivery

Researched 2026-09-28 for spec `docs/specs/2026-09-28-catherd-1.1-design.md` §3 (plan 10, Task 1). Source: a static
reading of the installed **Claude Code 2.1.283 Linux build** (`strings -n 8 /opt/claude-code/bin/claude`, BUILD_TIME
2026-09-25T00:44:42Z, GIT_SHA 4631ccd7), plus the live session registry and transcript of the session the plan was
written in (read only: no message was sent). The protocol is **undocumented** and can change in any Claude Code
release; catherd treats every delivery as best effort (disk stays the source of truth, spec §3.2).

Bun folds platform branches when it compiles the binary, so the Linux build shows the Linux paths in full; macOS
behaviour below is **inferred** from the runtime `platform === "macos"` checks that survive in it, not observed in a
macOS binary. `scripts/spike-push.ts` (this task) confirms delivery live on either OS.

## 1. The session registry: `~/.claude/sessions/<pid>.json`

Written by each live session on start (under `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`), and updated in place:

```js
{ pid, sessionId, cwd, startedAt, procStart, version: "2.1.283", peerProtocol: 1, peerFeatures, kind, entrypoint,
  hostSessionId /* only when a host (Desktop) launched it */, pidDomain, messagingSocketPath,
  name, nameSource, nameSince, logPath?, agent?, jobId?, updatedAt, status /* busy|idle|waiting */, statusUpdatedAt }
```

Observed live on 2026-09-28 (values elided): `pid`, `sessionId`, `cwd`, `startedAt`, `procStart`, `version`,
`peerProtocol`, `peerFeatures`, `kind`, `entrypoint`, `pidDomain`, `messagingSocketPath`, `name`, `nameSource`,
`nameSince`, `updatedAt`, `status`, `statusUpdatedAt`. A key file `~/.claude/sessions/<pid>.<sha256(sock)>.key` sits
beside it (the peer token; catherd never reads it).

- **`sessionId` is live.** `/clear` and `/resume` rewrite it here; the `CLAUDE_CODE_SESSION_ID` an MCP server was
  started with keeps the old id. catherd reads the live id from this file (controller ruling d).
- **`name` is live** too (a renamed Desktop session renames here), with `nameSource` and `formerNames`.
- **There is no permission-mode field.** No writer puts the session's permission mode into the file, so a sender
  cannot learn the receiver's permission class from it.
- **Finding the file.** The MCP server is the session's child: its parent pid names the file. catherd matches, in
  order: the file whose `messagingSocketPath` equals `CLAUDE_CODE_MESSAGING_SOCKET`, else `<ppid>.json`.
- Default socket path: `$XDG_RUNTIME_DIR` (else the temp dir) + `/cc-socks/<pid>.sock`, mode 0600, at most 103
  bytes (a fallback path otherwise). Observed: `/tmp/cc-socks/<pid>.sock`.

## 2. The socket and the frame

The listener is `net.createServer({ allowHalfOpen: true })` on the Unix socket. Lines are `\n`-delimited JSON; blank
lines are skipped; a final unterminated fragment is parsed on `end`. Buffered data over 1,048,576 characters, or no
complete line within 30 s, destroys the connection. The server never closes first; on `end` it parses the tail and
ends its side.

- **Auth.** An auth line is honoured only as the **first** line: `{"type":"auth","token":"<token>"}`. A missing or
  bad token drops the connection **only on Windows**; on Linux and macOS unauthenticated lines are processed (the
  token then only feeds the self-sent fallback, §4). Two tokens exist: the peer token (in the key file) and the
  **child token**, which the session puts in its own environment as `CLAUDE_CODE_MESSAGING_TOKEN`, so its children
  inherit it. catherd sends the child token (controller ruling e).
- **User frame.** `{"msgV":1,"msg_id":"<uuid>","type":"user","message":{"role":"user","content":"<string>"},"priority":"later|next|now"}`.
  `content` must be a non-empty string. `priority` other than `now|next|later` (or missing) is read as `next`.
  `msg_id` is kept when it is a UUID; `msgV: 1` is what native senders put and the receiver does not require it.
- **Drop rule.** A frame that carries `session_id` different from the receiver's current id is dropped. catherd
  sends **no `session_id`** (ruling e): after `/clear` the id it knows may be stale.
- **Closing.** The native client writes `auth + "\n" + json + "\n"` in one write, then on macOS ends the socket after
  150 ms (`setTimeout(end, 150)`), elsewhere at once. catherd writes the same two lines in one write and closes after
  150 ms on every OS (ruling e): the tail parse on `end` makes the delay harmless on Linux.

## 3. The environment an MCP server gets

stdio MCP servers are spawned with `{ ...process.env, CLAUDE_PROJECT_DIR, CLAUDE_CODE_SESSION_ID, CLAUDECODE: "1",
...server.env }`. When the inbox starts, the session sets `process.env.CLAUDE_CODE_MESSAGING_SOCKET` and
`CLAUDE_CODE_MESSAGING_TOKEN` (the child token), so every child spawned after that inherits both.

| Variable | Set by | Notes |
|---|---|---|
| `CLAUDE_CODE_SESSION_ID` | injected at spawn | stale after `/clear`: read the registry file for the live id |
| `CLAUDE_CODE_MESSAGING_SOCKET` | inherited | the socket path; the registry's `messagingSocketPath` is the same |
| `CLAUDE_CODE_MESSAGING_TOKEN` | inherited | the child token |
| `CLAUDE_CODE_HOST_SESSION_ID` | **not set by Claude Code** | a host (Desktop) passes it in; absent in a terminal session |

Not verifiable statically: that the inbox is listening before the MCP servers spawn. catherd logs, at MCP start,
which of the four variables it found (keys only, `session` row in the catherd log), so a live session shows it.

## 4. The inbound gate (`crossSessionInbound`)

Setting `crossSessionInbound: "accept" | "hold" | "refuse"` (unset = default). Policy, user and flag settings are read
first; local and project settings may only tighten it (`hold`, `refuse`); an invalid value reads as `hold`. A kill
switch (`CLAUDE_CODE_HARBOR_KITE` env or the `tengu_harbor_kite` flag, default on) off means refuse.

With the setting **unset**, a peer message is judged like this:

1. `selfSent` → accept.
2. The receiver's permission mode unknown → hold (`mode-unknown`).
3. The receiver's class is `bypass` (bypassPermissions, or plan with bypass available) or `prompting` (default,
   acceptEdits, auto, dontAsk, plan without bypass).
4. The message declares `from-mode` (an envelope attribute): accept when it equals the receiver's class, else hold
   (`mode-mismatch`).
5. No `from-mode`: a `prompting` receiver **accepts**; a `bypass` receiver holds (`no-mode-asserted`).

`selfSent` is computed only when it matters (no setting and a bypass-class receiver). It is true when the session's
pid is among the sender's ancestors:

- **Linux:** the peer pid comes from `SO_PEERCRED` at connect (re-checked against its `/proc` start time at the
  first line, a pid-reuse guard), and the ancestors from `/proc/<pid>/stat`, up to 12 levels. The self-sent rule
  **does run on Linux** (controller ruling b; spec §3.9's "does not run" is wrong for this build).
- **macOS:** a `ps -o ppid= -p <pid>` walk, 10 levels, retried with 32 when cut short; when the walk yields no
  evidence, presenting the child token passes.
- **Windows or pid 1:** self-sent = the child token was presented.

An explicit `crossSessionInbound` of `hold` or `refuse` wins over everything, self-sent included. A held message waits
in a buffer of 100 (oldest expire), is shown to the user for review, and is released when the policy later accepts.

**What catherd does (controller ruling a):** it never declares `from-mode`. The class cannot be learned (no mode in
the registry), a wrong value holds the message at a prompting receiver, and without it a prompting receiver accepts
while a bypass receiver runs the self-sent rule, which the MCP server (the session's direct child) passes on Linux
and macOS alike. Spec §3.9's Linux fallback is replaced by: the same behaviour as macOS; `doctor`'s `held` advice names
`crossSessionInbound`.

## 5. Priorities

- `now` (without attachments) aborts the running turn. catherd never uses it.
- `next` (the default): drained between tool rounds of a running turn; wakes an idle session.
- `later`: not drained mid-turn (the message waits for the turn to end); still wakes an idle session, since peer
  items are queued as prompts. Native background-task notices use it.

Accepted messages are queued as `{ mode: "prompt", isMeta: true, skipSlashCommands: true, skipAttachments: true,
priority, origin: { kind: "peer" } }`.

## 6. The envelope

`<cross-session-message ATTRS>\n<body>\n</cross-session-message>`, attributes in the order `from`, `from-session`,
`hop-chain`, `from-name`, `from-mode`, `from-plugin`. The receiver re-serialises the attributes it parsed and keeps
them only when the result matches byte for byte; otherwise the message is still delivered, without its name and mode.
A UDS sender's `from-plugin` is stripped; nested openers in the body are neutralised; text that is not an envelope is
neutralised but delivered.

catherd sends `<cross-session-message from-name="catherd">` (no `from`: the MCP server has no reply address). It
round-trips: the name is `[A-Za-z0-9 ._-]` with no quote, angle bracket or newline.

## 7. The transcript's enqueue line (what `doctor` checks)

An accepted message appends `{"type":"queue-operation","operation":"enqueue","timestamp":…,"sessionId":…,"content":"<the envelope text>"}`
to the session's transcript. A held or refused message writes **no** enqueue line, so the line tells `ok` from
`held`. Observed live: enqueue, dequeue and remove lines of this shape.

The transcript is `<config dir>/projects/<slug>/<sessionId>.jsonl`, the slug being the project root with every
character outside `[A-Za-z0-9]` replaced by `-` (longer than 200: the first 200 plus a hash). A git worktree may log
under its main checkout's slug, so `doctor` globs `projects/*/<sessionId>.jsonl` instead of computing the slug
(controller ruling c).

## 8. Verdict for catherd

- **Linux, no settings:** delivery works. A prompting receiver accepts any message without `from-mode`; a bypass
  receiver runs the self-sent rule through `/proc`, which the MCP server passes.
- **macOS, no settings:** delivery works (inferred): the same, through the `ps` walk, with the child token as the
  fallback when the walk fails.
- **Send:** the auth line with `CLAUDE_CODE_MESSAGING_TOKEN`, then `type: "user"` with string content and a
  `priority`, no `session_id`, envelope `from-name="catherd"`, one write, close after 150 ms.
- **Never** declare `from-mode`. `crossSessionInbound: hold|refuse` stops delivery; `doctor` says so and `peek`
  still works.
- **Live checks still owed** (the owner runs `bun scripts/spike-push.ts` from a Claude Code session's Bash tool on
  macOS and on Linux): the message arrives (the script finds the enqueue line); an MCP server finds the socket and
  token at spawn (the `session` log row on the first `catherd mcp` start).
````


#### Modify `docs/specs/2026-09-28-catherd-1.1-design.md`

```diff
--- a/docs/specs/2026-09-28-catherd-1.1-design.md
+++ b/docs/specs/2026-09-28-catherd-1.1-design.md
@@ -56,15 +56,18 @@ batch `route`, Jev hit-rate review, race mode, automatic retro, `catherd bench`,
 ### 3.1 Facts it rests on (verified in the Claude Code 2.1.283 binary, 2026-09-28)
 
 - Every live session registers an inbox: `~/.claude/sessions/<pid>.json` (`sessionId`, `name`, `hostSessionId`,
   `messagingSocketPath`, `status`) and a Unix socket. A frame is two JSON lines: `{"type":"auth","token":…}` then
   `{"msgV":1,"msg_id":<uuid>,"type":"user","message":{"role":"user","content":"<cross-session-message …>\n…\n</cross-session-message>"},"priority":…}`.
-- MCP servers and their children get `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_HOST_SESSION_ID`,
-  `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` in their environment.
+- MCP servers and their children get `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET` and
+  `CLAUDE_CODE_MESSAGING_TOKEN` in their environment, and `CLAUDE_CODE_HOST_SESSION_ID` when a host (Desktop) set it.
+  The session id there goes stale after `/clear`; the session file holds the live one.
 - **Self-sent rule.** With no `crossSessionInbound` setting, a receiver accepts a message whose sender process has
-  the session's pid among its ancestors (a `ps -o ppid=` walk, 10 levels, 32 on retry; macOS). The MCP server is a
-  direct child of the session, so its messages pass. A detached process reparented to launchd does not.
+  the session's pid among its ancestors (macOS: a `ps -o ppid=` walk, 10 levels, 32 on retry; Linux: a `/proc` walk,
+  12 levels, from the socket's peer pid). The MCP server is a direct child of the session, so its messages pass. A
+  detached process reparented to launchd or init does not. (Corrected by plan 10's spike,
+  `docs/research/2026-09-28-cross-session-messaging.md`.)
 - `priority`: `later` waits for the receiver's turn to end (native background-task notices use it), `next` drains at
   the next tool round (immediately when idle), `now` aborts the running turn.
 - The envelope attributes must re-serialise byte for byte, in the order from, from-session, hop-chain, from-name,
   from-mode, from-plugin. A sender may declare `from-mode="bypass|prompting"`; a matching receiver accepts it.
 - This protocol is undocumented and can change in any Claude Code release (see §3.9).
@@ -165,17 +168,18 @@ Record: result(run: "<run id>", name: "<name>")
 ### 3.9 When push is unavailable
 
 - `doctor` gains a row `push`. Run from inside a Claude Code session (the session env is present, e.g. from its Bash
   tool), it sends `catherd doctor: push test, no action needed` to that session with `priority: "later"` and looks
   for the `queue-operation` enqueue line in the session's transcript
-  (`~/.claude/projects/<cwd slug>/<sessionId>.jsonl`). Results: ok; `no session` (run from a plain terminal: skip,
+  (`~/.claude/projects/*/<sessionId>.jsonl`, found by globbing: a worktree logs under its main checkout's slug). Results: ok; `no session` (run from a plain terminal: skip,
   "run catherd doctor from a Claude Code session to test push"); `held` (a `crossSessionInbound` of `hold`/`refuse` or a mode mismatch: warn, with the fix);
   `failed` (the protocol changed: fail, "catherd cannot notify this Claude Code version; `peek` still works").
-- On Linux the self-sent rule does not run. The sender then declares `from-mode` with the session's permission class
-  when the session file names it; otherwise `doctor` says to set `crossSessionInbound` for this user. The plan's first
-  task is a spike that confirms delivery on macOS and Linux against the current Claude Code before anything is built
-  on it.
+- Linux behaves as macOS: the self-sent rule runs there too (through `/proc`). The sender never declares `from-mode`
+  (the session file has no permission mode, and a wrong value holds the message); a `held` result's advice names
+  `crossSessionInbound`. The plan's first task records the spike (`docs/research/2026-09-28-cross-session-messaging.md`)
+  and ships `scripts/spike-push.ts`, which the owner runs to confirm delivery on macOS and Linux; the rest of the plan
+  does not wait for it.
 - `init` does not change `crossSessionInbound`.
 
 ## 4. Sessions and the runs page
 
 - **Data.** A session is `{sessionId, hostSessionId, name}`. Runs are grouped by `meta.startedBy.sessionId`; runs
```


#### Create `scripts/spike-push.ts`

```ts
#!/usr/bin/env bun
/**
 * The catherd 1.1 push spike (plan 10 Task 1, docs/research/2026-09-28-cross-session-messaging.md). Run it from
 * a Claude Code session's Bash tool, on macOS and on Linux:
 *
 *   bun scripts/spike-push.ts            # sends one `later` message to this session and checks it arrived
 *   bun scripts/spike-push.ts --dry-run  # prints what it would send, sends nothing
 *
 * It stands alone (nothing from src/), so it runs before any of plan 10 is built. It never prints the token.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const dry = process.argv.includes("--dry-run");
const env = process.env;
const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const socket = env.CLAUDE_CODE_MESSAGING_SOCKET;
const token = env.CLAUDE_CODE_MESSAGING_TOKEN;

console.log(`os ${platform()} · config dir ${configDir}`);
for (const k of [
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
])
  console.log(`env ${k}: ${env[k] ? "set" : "absent"}`);
if (!socket) {
  console.log("verdict: no session (run this from a Claude Code session's Bash tool)");
  process.exit(2);
}

type Entry = {
  pid?: number;
  sessionId?: string;
  name?: string;
  version?: string;
  messagingSocketPath?: string;
};
const sessions = join(configDir, "sessions");
const entries: Entry[] = existsSync(sessions)
  ? readdirSync(sessions)
      .filter((f) => /^\d+\.json$/.test(f))
      .flatMap((f) => {
        try {
          return [JSON.parse(readFileSync(join(sessions, f), "utf8")) as Entry];
        } catch {
          return [];
        }
      })
  : [];
const mine = entries.find((e) => e.messagingSocketPath === socket);
console.log(
  mine
    ? `registry: pid ${mine.pid} · session ${mine.sessionId} · name ${mine.name ?? "-"} · claude ${mine.version ?? "?"}`
    : "registry: no session file names this socket",
);
const sessionId = mine?.sessionId ?? env.CLAUDE_CODE_SESSION_ID;
if (mine?.sessionId && env.CLAUDE_CODE_SESSION_ID && mine.sessionId !== env.CLAUDE_CODE_SESSION_ID)
  console.log("note: the env session id is stale (a /clear or /resume since start); using the registry's");

const nonce = crypto.randomUUID().slice(0, 8);
const text = `catherd spike: push test ${nonce}, no action needed`;
const frame = {
  msgV: 1,
  msg_id: crypto.randomUUID(),
  type: "user",
  message: {
    role: "user",
    content: `<cross-session-message from-name="catherd">\n${text}\n</cross-session-message>`,
  },
  priority: "later",
};
const payload = `${token ? `${JSON.stringify({ type: "auth", token })}\n` : ""}${JSON.stringify(frame)}\n`;
console.log(`frame: auth line ${token ? "yes" : "no (no token in env)"} · ${JSON.stringify(frame)}`);
if (dry) process.exit(0);

const sent = await new Promise<string>((resolve) => {
  const s = createConnection({ path: socket });
  s.setTimeout(5_000, () => {
    s.destroy();
    resolve("error: no connection within 5 s");
  });
  s.on("error", (e: NodeJS.ErrnoException) => resolve(`error: ${e.code ?? e.message}`));
  s.on("connect", () =>
    s.write(payload, () =>
      setTimeout(() => {
        s.end();
        resolve("sent");
      }, 150),
    ),
  );
});
console.log(`send: ${sent}`);
if (sent !== "sent") {
  console.log("verdict: failed (the socket did not take the frame)");
  process.exit(1);
}

/** The transcript: `projects/<slug>/<sessionId>.jsonl`, found by globbing (a worktree logs under its checkout). */
const transcript = (): string | null => {
  const projects = join(configDir, "projects");
  if (!sessionId || !existsSync(projects)) return null;
  for (const d of readdirSync(projects)) {
    const f = join(projects, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
};
const deadline = Date.now() + 10_000;
for (;;) {
  const f = transcript();
  const hit =
    f !== null &&
    readFileSync(f, "utf8")
      .split("\n")
      .some((l) => l.includes('"operation":"enqueue"') && l.includes(nonce));
  if (hit) {
    console.log(`verdict: ok (enqueue line found in ${f})`);
    process.exit(0);
  }
  if (Date.now() > deadline) {
    console.log(
      f
        ? `verdict: held (no enqueue line in ${f} within 10 s: check crossSessionInbound in your settings)`
        : "verdict: sent, not confirmed (no transcript found for this session)",
    );
    process.exit(1);
  }
  await Bun.sleep(250);
}
```

- [ ] **Step 2: Run the gate**

Run: `bun run format && bun run format:check && bun run typecheck && bun run lint`, then `bun scripts/spike-push.ts --dry-run` from any shell. Expected: the gate clean (`scripts/` is formatted, not type-checked); the dry run prints `env … absent` lines and `verdict: no session (run this from a Claude Code session's Bash tool)` with exit 2 outside Claude Code, or the registry line and the frame (the token never printed) inside one. **Never run it without `--dry-run` from a session you do not own**: it sends that session a message. Scratch count after this task: 1182 pass (no test added), 10 skip, 0 fail.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs(research): cross-session messaging spike, owner-run push spike script, spec errata"
```

---

### Task 2: The peer inbox sender, the push message and a fake inbox

Spec §3.4's `infra/peer-inbox.ts` (one frame, an outcome, never a throw) and §3.5's message (`domain/notice.ts`, pure), with §15's fake socket server (`test/sim/peer-inbox.ts`) that later tasks' tests receive frames on. Rulings 4 and 13.

**Files:**
- Create: `test/domain/notice.test.ts`
- Create: `test/infra/peer-inbox.test.ts`
- Create: `test/sim/peer-inbox.ts`
- Create: `src/domain/notice.ts`
- Create: `src/infra/peer-inbox.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `sendToInbox(target: { socketPath: string | null; token: string | null }, content: string, priority: "later" | "next"): Promise<SendResult>` with `SendResult { outcome: "sent" | "no-session" | "refused" | "error"; msgId?; reason? }`, `frameText(content, priority, token, msgId)`, `inboxLimits { connectMs, closeAfterMs }` (`src/infra/peer-inbox.ts`); `interface Notice { kind: "finished" | "stalled"; runId; runTitle; dispatchId; name; role; lane; rung; status; replyStatus; secs; changedOwned; reply; priority }`, `type NoticePriority`, `noticeHeader(n)`, `capNoticeReply(reply, cap?)`, `formatNotices(ns)`, `priorityOf(ns)`, `envelope(body)`, `REPLY_CAP` (`src/domain/notice.ts`); `fakeInbox(): Promise<FakeInbox>` with `{ path, frames, received(n, ms?), close() }` and `ReceivedFrame { auth, msgV, msg_id, type, message, priority?, session_id?, lines }` (`test/sim/peer-inbox.ts`).

- [ ] **Step 1: Write the failing tests**

#### Create `test/domain/notice.test.ts`

```ts
import { describe, expect, it } from "bun:test";
import {
  capNoticeReply,
  envelope,
  formatNotices,
  type Notice,
  noticeHeader,
  priorityOf,
} from "../../src/domain/notice.ts";

const notice = (o: Partial<Notice> = {}): Notice => ({
  kind: "finished",
  runId: "20260928-100000-auth",
  runTitle: "Auth plan 5 MR B",
  dispatchId: "d1",
  name: "worker-M1.L1",
  role: "worker",
  lane: "M1.L1",
  rung: "codex:gpt-6-sol#medium",
  status: "ok",
  replyStatus: "complete",
  secs: 312,
  changedOwned: 3,
  reply: "Done: added the kit.\nSTATUS: complete — kit in place",
  priority: "later",
  ...o,
});

describe("the push message (spec §3.5)", () => {
  it("puts everything on a first line that stands alone", () => {
    expect(noticeHeader(notice())).toBe(
      "catherd · Auth plan 5 MR B · worker-M1.L1 worker · codex:gpt-6-sol#medium · ok · STATUS: complete · 312s · 3 owned files changed",
    );
    expect(noticeHeader(notice({ replyStatus: null, changedOwned: 1 }))).toContain(
      "· ok · no STATUS · 312s · 1 owned file changed",
    );
  });

  it("carries the reply and the call that reads the record", () => {
    expect(formatNotices([notice()])).toBe(
      [
        "catherd · Auth plan 5 MR B · worker-M1.L1 worker · codex:gpt-6-sol#medium · ok · STATUS: complete · 312s · 3 owned files changed",
        "Done: added the kit.",
        "STATUS: complete — kit in place",
        'Record: result(run: "20260928-100000-auth", name: "worker-M1.L1")',
      ].join("\n"),
    );
  });

  it("caps the reply at 2,000 characters, on a line boundary, and says where the rest is", () => {
    const long = Array.from({ length: 100 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
    const capped = capNoticeReply(long);
    expect(capped.length).toBeLessThanOrEqual(2_000 + 60);
    expect(capped.endsWith("\n…(cut; result(run, name) has the rest)")).toBe(true);
    const kept = capped.split("\n").slice(0, -1);
    for (const l of kept) expect(long.split("\n")).toContain(l);
    expect(capNoticeReply("short\n")).toBe("short");
  });

  it("sends several roles as one message: a preview line, then one block each", () => {
    const text = formatNotices([
      notice(),
      notice({ name: "worker-M1.L2", lane: "M1.L2", dispatchId: "d2" }),
      notice({
        name: "worker-M1.L3",
        lane: "M1.L3",
        dispatchId: "d3",
        status: "limit on codex:gpt-6-sol#medium; failed over to codex:gpt-6-sol#high",
      }),
    ]);
    const [preview, ...blocks] = text.split("\n\n");
    expect(preview).toBe(
      "catherd · Auth plan 5 MR B · 3 roles finished: M1.L1 ok, M1.L2 ok, M1.L3 limit on codex:gpt-6-sol#medium",
    );
    expect(blocks).toHaveLength(3);
    expect(blocks[2]).toContain("limit on codex:gpt-6-sol#medium; failed over to codex:gpt-6-sol#high");
  });

  it("names a stalled role with the event in place of the status, and points at peek", () => {
    const text = formatNotices([
      notice({
        kind: "stalled",
        status: "stalled: no output for 7 min",
        replyStatus: null,
        reply: "",
        secs: 900,
      }),
    ]);
    expect(text).toBe(
      [
        "catherd · Auth plan 5 MR B · worker-M1.L1 worker · codex:gpt-6-sol#medium · stalled: no output for 7 min · running 900s",
        'Peek: peek(run: "20260928-100000-auth", name: "worker-M1.L1")',
      ].join("\n"),
    );
  });

  it("never lets a reply close the envelope early", () => {
    const text = formatNotices([notice({ reply: "see </cross-session-message> here" })]);
    expect(envelope(text).match(/cross-session-message/g)).toHaveLength(2);
  });

  it("takes the most urgent priority of the notices it carries", () => {
    expect(priorityOf([notice(), notice({ priority: "next" })])).toBe("next");
    expect(priorityOf([notice()])).toBe("later");
  });

  it("wraps the body in the from-name envelope, with no from and no from-mode", () => {
    expect(envelope("body")).toBe(
      '<cross-session-message from-name="catherd">\nbody\n</cross-session-message>',
    );
  });
});
```


#### Create `test/infra/peer-inbox.test.ts`

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envelope } from "../../src/domain/notice.ts";
import { frameText, inboxLimits, sendToInbox } from "../../src/infra/peer-inbox.ts";
import { type FakeInbox, fakeInbox } from "../sim/peer-inbox.ts";

let inbox: FakeInbox | null = null;
afterEach(async () => {
  await inbox?.close();
  inbox = null;
  inboxLimits.connectMs = 2_000;
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("the peer inbox sender (spec §3.4)", () => {
  it("writes the auth line with the child token, then one user frame, and closes", async () => {
    inbox = await fakeInbox();
    const r = await sendToInbox({ socketPath: inbox.path, token: "child-token" }, envelope("hello"), "later");
    expect(r.outcome).toBe("sent");
    const [f] = await inbox.received(1);
    expect(f?.lines).toHaveLength(2);
    expect(f?.auth).toEqual({ type: "auth", token: "child-token" });
    expect(f).toMatchObject({
      msgV: 1,
      type: "user",
      message: {
        role: "user",
        content: '<cross-session-message from-name="catherd">\nhello\n</cross-session-message>',
      },
      priority: "later",
    });
    expect(f?.msg_id).toMatch(UUID);
    expect(f?.msg_id).toBe(r.msgId as string);
    // a stale session id drops the frame at the receiver; a declared mode can hold it
    expect(f?.session_id).toBeUndefined();
    expect(f?.message.content).not.toContain("from-mode");
  });

  it("sends the priority it is given, and no auth line without a token", async () => {
    inbox = await fakeInbox();
    await sendToInbox({ socketPath: inbox.path, token: null }, envelope("x"), "next");
    const [f] = await inbox.received(1);
    expect(f?.auth).toBeNull();
    expect(f?.lines).toHaveLength(1);
    expect(f?.priority).toBe("next");
  });

  it("returns no-session without a socket, or when the socket is gone, and never throws", async () => {
    expect(await sendToInbox({ socketPath: null, token: "t" }, "x", "later")).toEqual({
      outcome: "no-session",
      reason: "no messaging socket in this session's environment",
    });
    const gone = join(mkdtempSync(join(tmpdir(), "cc-socks-")), "9.sock");
    expect(await sendToInbox({ socketPath: gone, token: "t" }, "x", "later")).toMatchObject({
      outcome: "no-session",
    });
  });

  it("returns error, with the reason, when the path is not a socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-socks-"));
    const r = await sendToInbox({ socketPath: dir, token: "t" }, "x", "later");
    expect(["error", "refused"]).toContain(r.outcome);
    expect(r.reason).toBeTruthy();
  });

  it("gives up on a socket that never accepts, within the connect limit", async () => {
    // a listener with a zero backlog that never accepts: some kernels still complete the handshake, so either
    // way the sender must return, never hang
    const path = join(mkdtempSync(join(tmpdir(), "cc-socks-")), "2.sock");
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(path, resolve));
    inboxLimits.connectMs = 200;
    try {
      const r = await sendToInbox({ socketPath: path, token: "t" }, "x", "later");
      expect(["sent", "error"]).toContain(r.outcome);
    } finally {
      server.close();
    }
  });

  it("builds exactly the two lines the protocol names", () => {
    expect(frameText("c", "later", "tok", "00000000-0000-4000-8000-000000000000")).toBe(
      '{"type":"auth","token":"tok"}\n{"msgV":1,"msg_id":"00000000-0000-4000-8000-000000000000","type":"user","message":{"role":"user","content":"c"},"priority":"later"}\n',
    );
  });
});
```


#### Create `test/sim/peer-inbox.ts`

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One frame as the fake inbox parsed it: the auth line (if any) and the user frame of one connection. */
export interface ReceivedFrame {
  auth: { type: string; token?: string } | null;
  msgV: number;
  msg_id: string;
  type: string;
  message: { role: string; content: string };
  priority?: string;
  session_id?: string;
  /** every line of the connection, raw */
  lines: string[];
}

export interface FakeInbox {
  /** the socket path, to hand to the sender as CLAUDE_CODE_MESSAGING_SOCKET */
  path: string;
  frames: ReceivedFrame[];
  /** resolves once `n` frames have arrived (rejects after `ms`) */
  received(n: number, ms?: number): Promise<ReceivedFrame[]>;
  close(): Promise<void>;
}

/**
 * A fake Claude Code peer inbox (spec §15): a Unix socket that reads each connection to its end, as the real one does
 * (`allowHalfOpen`, the tail parsed on `end`), and records the frame. It never answers.
 */
export async function fakeInbox(): Promise<FakeInbox> {
  const dir = mkdtempSync(join(tmpdir(), "cc-socks-"));
  const path = join(dir, "1.sock");
  const frames: ReceivedFrame[] = [];
  const waiters: (() => void)[] = [];
  const server: Server = createServer({ allowHalfOpen: true }, (c) => {
    let text = "";
    c.setEncoding("utf8");
    c.on("data", (d: string) => {
      text += d;
    });
    c.on("end", () => {
      const lines = text.split("\n").filter((l) => l.trim());
      const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      const auth = parsed[0]?.type === "auth" ? (parsed[0] as ReceivedFrame["auth"]) : null;
      const user = parsed.find((p) => p.type === "user");
      if (user) frames.push({ ...(user as unknown as ReceivedFrame), auth, lines });
      for (const w of waiters.splice(0)) w();
      c.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    path,
    frames,
    async received(n, ms = 10_000) {
      const end = Date.now() + ms;
      while (frames.length < n) {
        if (Date.now() > end) throw new Error(`fake inbox: ${frames.length} of ${n} frames after ${ms} ms`);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 50);
          waiters.push(() => {
            clearTimeout(t);
            resolve();
          });
        });
      }
      return frames.slice(0, n);
    },
    close: () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          resolve();
        }),
      ),
  };
}
```


- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/domain/notice.test.ts test/infra/peer-inbox.test.ts`. Expected: FAIL — `Cannot find module` for `src/domain/notice.ts` and `src/infra/peer-inbox.ts`.

- [ ] **Step 3: Write the sender and the message**

#### Create `src/domain/notice.ts`

```ts
/**
 * Spec §3.5: the message catherd pushes to the main thread when roles finish or need attention. Pure text; the
 * notifier (services/notifier.ts) gathers the facts and infra/peer-inbox.ts sends the result.
 */

/** Spec §3.6: `later` waits for the receiver's turn to end, `next` drains at its next tool round. Never `now`. */
export type NoticePriority = "later" | "next";

/** One role's news: it finished (`record`), or an event while it runs (`stall`). */
export interface Notice {
  kind: "finished" | "stalled";
  runId: string;
  runTitle: string;
  dispatchId: string;
  name: string;
  role: string;
  /** the lane it worked, when it had one: the multi-role preview names it */
  lane: string | null;
  rung: string;
  /** the record's status, or for a limit what failover did ("limit on X; failed over to Y"), or the event */
  status: string;
  /** the reply's STATUS word, null without a STATUS line */
  replyStatus: string | null;
  secs: number;
  changedOwned: number;
  /** the worker's reply (finished notices), capped when the message is written */
  reply: string;
  priority: NoticePriority;
}

/** The body of a reply a message carries at most (spec §3.5). */
export const REPLY_CAP = 2_000;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The first line of one role's block: it must stand alone, since the Desktop preview shows only it. */
export function noticeHeader(n: Notice): string {
  const head = `catherd · ${n.runTitle} · ${n.name} ${n.role} · ${n.rung} · ${n.status}`;
  if (n.kind === "stalled") return `${head} · running ${n.secs}s`;
  return [
    head,
    n.replyStatus ? `STATUS: ${n.replyStatus}` : "no STATUS",
    `${n.secs}s`,
    plural(n.changedOwned, "owned file changed", "owned files changed"),
  ].join(" · ");
}

/** The reply, at most `cap` characters, cut on a line boundary, saying where the rest is. */
export function capNoticeReply(reply: string, cap = REPLY_CAP): string {
  const text = reply.trimEnd();
  if (text.length <= cap) return text;
  const cut = text.slice(0, cap);
  const at = cut.lastIndexOf("\n");
  return `${at > 0 ? cut.slice(0, at) : cut}\n…(cut; result(run, name) has the rest)`;
}

/** The envelope's own tags are neutralised in a body, so a reply can never close the envelope early. */
const neutral = (s: string) => s.replaceAll("cross-session-message", "cross session message");

function block(n: Notice): string {
  const call = `run: "${n.runId}", name: "${n.name}"`;
  if (n.kind === "stalled") return `${noticeHeader(n)}\nPeek: peek(${call})`;
  const reply = capNoticeReply(n.reply);
  return [noticeHeader(n), ...(reply ? [reply] : []), `Record: result(${call})`].join("\n");
}

/** The preview line of a message that carries several roles: `catherd · <title> · 3 roles finished: …`. */
function previewOf(ns: Notice[]): string {
  const titles = [...new Set(ns.map((n) => n.runTitle))];
  const where = titles.length === 1 ? titles[0] : plural(titles.length, "run", "runs");
  const what = ns.every((n) => n.kind === "finished")
    ? `${ns.length} roles finished`
    : `${plural(ns.length, "role", "roles")} to look at`;
  const each = ns.map(
    (n) => `${n.lane ?? n.name} ${n.kind === "stalled" ? "stalled" : n.status.split(";")[0]}`,
  );
  return `catherd · ${where} · ${what}: ${each.join(", ")}`;
}

/** The message body for one or more notices: one block per role, a preview line first when there are several. */
export function formatNotices(ns: Notice[]): string {
  if (ns.length === 1) return neutral(block(ns[0] as Notice));
  return neutral([previewOf(ns), ...ns.map(block)].join("\n\n"));
}

/** The message's priority: the most urgent of its notices. */
export const priorityOf = (ns: Notice[]): NoticePriority =>
  ns.some((n) => n.priority === "next") ? "next" : "later";

/** The envelope catherd sends: from-name only, no `from` (the MCP server has no reply address). */
export const envelope = (body: string): string =>
  `<cross-session-message from-name="catherd">\n${body}\n</cross-session-message>`;
```


#### Create `src/infra/peer-inbox.ts`

```ts
import { createConnection } from "node:net";

/**
 * Spec §3.4: one frame to a Claude Code session's peer inbox (docs/research/2026-09-28-cross-session-messaging.md).
 * The auth line (the child token the session gave its children), then one `user` frame, in one write; the socket
 * is closed 150 ms later, as the native client does on macOS. No `session_id` (a stale one drops the frame) and no
 * `from-mode` (a wrong one holds it).
 */

export type SendOutcome = "sent" | "no-session" | "refused" | "error";

export interface SendResult {
  outcome: SendOutcome;
  /** the frame's msg_id, when one was written */
  msgId?: string;
  /** why it was not sent */
  reason?: string;
}

export interface InboxTarget {
  socketPath: string | null;
  token: string | null;
}

/** How long a connection may take, and how long after the write the socket is closed; tests shorten them. */
export const inboxLimits = { connectMs: 2_000, closeAfterMs: 150 };

/** The two lines one send writes: the auth line (when there is a token) and the user frame. */
export function frameText(
  content: string,
  priority: "later" | "next",
  token: string | null,
  msgId: string,
): string {
  const frame = { msgV: 1, msg_id: msgId, type: "user", message: { role: "user", content }, priority };
  return `${token ? `${JSON.stringify({ type: "auth", token })}\n` : ""}${JSON.stringify(frame)}\n`;
}

/** Sends one message; never throws: every failure is an outcome with its reason. */
export function sendToInbox(
  target: InboxTarget,
  content: string,
  priority: "later" | "next",
): Promise<SendResult> {
  if (!target.socketPath)
    return Promise.resolve({
      outcome: "no-session",
      reason: "no messaging socket in this session's environment",
    });
  const msgId = crypto.randomUUID();
  const socketPath = target.socketPath;
  return new Promise<SendResult>((resolve) => {
    let settled = false;
    const done = (r: SendResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let s: ReturnType<typeof createConnection>;
    try {
      s = createConnection({ path: socketPath });
    } catch (e) {
      return done({ outcome: "error", reason: (e as Error).message });
    }
    const timer = setTimeout(() => {
      s.destroy();
      done({ outcome: "error", reason: `no connection within ${inboxLimits.connectMs} ms` });
    }, inboxLimits.connectMs);
    s.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      s.destroy();
      if (e.code === "ENOENT")
        done({ outcome: "no-session", reason: `the session's socket is gone (${socketPath})` });
      else if (e.code === "ECONNREFUSED")
        done({ outcome: "refused", reason: "the session's socket refused it" });
      else done({ outcome: "error", reason: e.code ?? e.message });
    });
    s.on("connect", () => {
      clearTimeout(timer);
      s.write(frameText(content, priority, target.token, msgId), (err) => {
        if (err) {
          s.destroy();
          return done({ outcome: "error", reason: err.message });
        }
        setTimeout(() => {
          s.end();
          done({ outcome: "sent", msgId });
        }, inboxLimits.closeAfterMs);
      });
    });
  });
}
```

- [ ] **Step 4: Run the gate**

Run the gate. Expected: clean; the two new files 14 pass. Scratch count after this task: 1196 pass, 10 skip, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(push): the peer inbox sender, the push message format and a fake inbox"
```

---

### Task 3: Settle each dispatch at finalize; `result` marks records read; `wait` removed

Spec §3.4 ("Failover moves here"), §3.7 (`wait` removed; `result` consumes) and §14 (20 tools after this task, 21 once Task 7 adds `peek`). Rulings 5–8, 16 and 22. What `wait` did moves: finalizing stays with the dispatch's watcher (and reconcile), which now also **settles** the dispatch: failover once per limited dispatch under `failover.lock`, its outcome in `failover.json`, state.md with the pause, then the settled hooks (none yet: Task 5's notifier is the first). A launch that throws is still watched, so its lost record is settled. `result` returns the record's `hints` and marks it read with the collect lease (the mark now means "not yet read"). `tickMs`, `CATHERD_TICK_MS` and `progressTo` go with `wait`. The skill loses every mention of `wait` (Ruling 22: dispatch, one status line, end the turn, `result`); plan 11 rewrites the rest. The migrated tests keep every guarantee the `wait` tests pinned that still applies: two dispatches live at once, a record read once however many read it, a reader that died holding its lease, failover once (a second settle, a crash before launch, a crash between spawn and `launch.json`, a restarted server), the stand-in tied to its own limited dispatch.

**Files:**
- Modify: `test/entry/mcp.test.ts`
- Modify: `test/integration/mcp-stdio.test.ts`
- Modify: `test/services/dispatch.test.ts`
- Replace: `test/services/failover-cancel.test.ts`
- Modify: `test/services/helpers.ts`
- Modify: `test/services/lanes-run.test.ts`
- Modify: `test/skills.test.ts`
- Modify: `src/entry/deps.ts`
- Modify: `src/entry/mcp/dispatch-tools.ts`
- Modify: `src/entry/mcp/run-tools.ts`
- Modify: `src/infra/dispatch-dir.ts`
- Modify: `src/services/admission.ts`
- Replace: `src/services/dispatch-service.ts`
- Modify: `src/services/dispatches.ts`
- Modify: `src/services/finalize.ts`
- Modify: `src/services/ports.ts`
- Modify: `src/services/reconcile.ts`
- Modify: `src/services/run-service.ts`
- Modify: `CONTRIBUTING.md`
- Modify: `README.md`
- Modify: `docs/dev/manual-tests.md`
- Modify: `plugin/skills/catherd/SKILL.md`

**Interfaces:**
- Consumes: `finalizeDispatch`, `admit`, `standInFor`, `tryCollect`/`endCollect`/`awaitsCollect` (unchanged).
- Produces: `settle(deps, run, d, record): Promise<Settled>`, `interface Settled { run: Run; d: Dispatch; record: RunRecord; hints: string[]; started: Dispatched | null; pause: string | null; stateHints: string[] }`, `settledHooks: Set<(s: Settled) => void | Promise<void>>`, `watch(deps, run, d)` (exported), `unsettledLimits(run)`, `watchersSettled()` (`src/services/dispatch-service.ts`; `wait`, `WaitInput`, `WaitResult`, `Progress` are gone); `type FailoverFile`, `readFailover(dir)`, `recordHints(run, d, record)` (`src/services/dispatches.ts`); `dispatchPaths(dir).failover`; `result(deps, { run, name })` is now `async` and returns `hints`; `waitForFinish(d, { pollMs, now })`; `Deps` without `tickMs`; `runRole(deps, input)` in `test/services/helpers.ts` = dispatch, `watchersSettled()`, `result`.

- [ ] **Step 1: Write the failing tests**

#### Modify `test/entry/mcp.test.ts`

```diff
--- a/test/entry/mcp.test.ts
+++ b/test/entry/mcp.test.ts
@@ -1,28 +1,26 @@
 import { afterEach, describe, expect, it } from "bun:test";
 import { mkdirSync, mkdtempSync } from "node:fs";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
 import { writeDiscovery } from "../../src/adapters/discovery.ts";
-import { progressTo } from "../../src/entry/mcp/dispatch-tools.ts";
 import { gitToplevel } from "../../src/infra/git.ts";
 import { VERSION } from "../../src/infra/version.ts";
 import { readAgentRuns } from "../../src/services/run-store.ts";
 import { snapshotEnv } from "../helpers.ts";
 import { call, mcpClient } from "../mcp-helpers.ts";
 import { fakeDeps, fakeGit, freshRun, writeLane } from "../services/helpers.ts";
 
 afterEach(snapshotEnv());
 
-/** Spec §4.8, exactly. */
+/** Spec §4.8 and the 1.1 spec §14 (plan 10: `wait` removed), exactly. */
 const TOOLS = [
   "run_start",
   "route",
   "preflight",
   "dispatch",
   "cancel",
-  "wait",
   "climb",
   "ask",
   "land",
   "read_knowledge",
   "write_run_file",
@@ -198,17 +196,5 @@ describe("MCP server", () => {
     const set = await call(c, "set_next", { run: run.id, next: "paused: lunch" });
     expect(set.isError).toBe(false);
     expect(set.data).toEqual({ state: null, hints: [expect.stringMatching(/^state\.md not refreshed: /)] });
   });
 });
-
-describe("progress notifications", () => {
-  it("never throw, whether the client rejects or the transport is closed", () => {
-    const rejecting = progressTo("t", () => Promise.reject(new Error("client gone")));
-    const throwing = progressTo(1, () => {
-      throw new Error("closed");
-    });
-    expect(() => rejecting?.("w · 30s")).not.toThrow();
-    expect(() => throwing?.("w · 30s")).not.toThrow();
-    expect(progressTo(undefined, () => Promise.resolve())).toBeUndefined();
-  });
-});
```


#### Modify `test/integration/mcp-stdio.test.ts`

```diff
--- a/test/integration/mcp-stdio.test.ts
+++ b/test/integration/mcp-stdio.test.ts
@@ -37,11 +37,10 @@ function serverEnv(home: string, scenarioFile: string): Record<string, string> {
     ...env,
     CATHERD_HOME: home,
     XDG_CONFIG_HOME: join(home, "xdg-config"),
     PATH: simPath(),
     CATHERD_SIM_SCENARIO: scenarioFile,
-    CATHERD_TICK_MS: "200",
     // a root container runs this suite too: preflight runs its checks there only on a disposable machine
     IS_SANDBOX: "1",
   };
 }
 
@@ -109,34 +108,18 @@ async function until<T>(f: () => Promise<T | null | undefined | false>, ms = 20_
     if (Date.now() > end) throw new Error("timed out");
     await Bun.sleep(100);
   }
 }
 
-/** A `wait` call whose progress notifications reach `onTick`; its parsed result. */
-async function waitWithProgress(
-  c: Client,
-  args: Record<string, unknown>,
-  onTick: (message: string) => void,
-  // oxlint-disable-next-line typescript/no-explicit-any
-): Promise<any> {
-  const r = await c.callTool({ name: "wait", arguments: args }, undefined, {
-    timeout: 60_000,
-    resetTimeoutOnProgress: true,
-    onprogress: (p) => onTick(p.message ?? ""),
-  });
-  if (r.isError) throw new Error(JSON.stringify(r.content));
-  return JSON.parse((r.content as { text: string }[])[0]?.text ?? "null");
-}
-
 /** runs.jsonl's whole rows; a torn tail line is skipped, as catherd's own reader does. */
-function recordsOf(dir: string): { dispatchId: string; status: string }[] {
+function recordsOf(dir: string): { dispatchId: string; status: string; name: string }[] {
   return readFileSync(join(dir, "runs.jsonl"), "utf8")
     .split("\n")
     .slice(1)
     .flatMap((l) => {
       try {
-        return [JSON.parse(l) as { dispatchId: string; status: string }];
+        return [JSON.parse(l) as { dispatchId: string; status: string; name: string }];
       } catch {
         return [];
       }
     });
 }
@@ -170,16 +153,10 @@ describe("catherd mcp over stdio, on the Codex simulator", () => {
       let c = await connect(env);
 
       expect((await call(c, "status")).data.version).toBe(PKG.version);
       const started = await call(c, "run_start", { repo, title: "Add a", a_lines: ["A1 a exists"] });
       const { run, dir } = started.data as { run: string; dir: string };
-      expect((await call(c, "wait", { run })).data).toEqual({
-        records: [],
-        started: [],
-        running: [],
-        hints: ["nothing to wait for: every dispatch of this run has been collected; dispatch a role first"],
-      });
       await call(c, "write_run_file", {
         run,
         path: "lanes/M1.L1.md",
         content: lane("M1.L1", "src/a.ts", "grep -q fixed src/a.ts"),
       });
@@ -199,11 +176,11 @@ describe("catherd mcp over stdio, on the Codex simulator", () => {
         "skipped",
         "fails-as-expected",
       ]);
       expect(pre.data.blocked).toBe(false);
 
-      // dispatch at Luna, which returns at launch; wait, with progress, collects the refusal; climb.
+      // dispatch at Luna, which returns at launch; the server records the refusal; result reads it; climb.
       const release = join(mkdtempSync(join(tmpdir(), "catherd-hold-")), "release");
       sim.rewrite({
         eventsFile: join(FX, "two-turns.jsonl"),
         reply: "Tried.\nSTATUS: refused — needs a stronger model",
         holdUntil: release,
@@ -217,19 +194,15 @@ describe("catherd mcp over stdio, on the Codex simulator", () => {
       };
       const launched = await call(c, "dispatch", { ...worker, rung: "codex:gpt-6-luna#high" });
       expect(launched.data.dispatched).toMatchObject({ name: "worker-M1.L1", rung: "codex:gpt-6-luna#high" });
       expect(Date.parse(launched.data.dispatched.admittedAt)).toBeGreaterThan(0);
       expect((await call(c, "status", { run })).data.runs[0].live).toHaveLength(1);
-      const ticks: string[] = [];
-      const waiting = waitWithProgress(c, { run }, (m) => ticks.push(m));
-      await until(async () => ticks.length > 0);
       writeFileSync(release, "");
-      const refused = await waiting;
-      expect(ticks[0]).toMatch(/^worker-M1\.L1 · codex:gpt-6-luna#high · \d+s/);
-      expect(refused.records[0].record).toMatchObject({ status: "ok", replyStatus: "refused" });
-      expect(refused.records[0].hints).toContain("climb: refused");
-      expect(refused.running).toEqual([]);
+      await until(async () => recordsOf(dir).length === 1);
+      const refused = (await call(c, "result", { run, name: "worker-M1.L1" })).data;
+      expect(refused.record).toMatchObject({ status: "ok", replyStatus: "refused" });
+      expect(refused.hints).toContain("climb: refused");
       const climbed = await call(c, "climb", { run, lane: "M1.L1", reason: "refused" });
       expect(climbed.data).toMatchObject({ rung: "codex:gpt-6-sol#medium", top: false });
 
       // failover: Sol medium hits a usage limit; its stand-in Sol high finishes the lane.
       writeProfile({ failover: { "codex:gpt-6-sol#medium": "codex:gpt-6-sol#high" } });
@@ -243,28 +216,23 @@ describe("catherd mcp over stdio, on the Codex simulator", () => {
           },
         },
       });
       const failed = await call(c, "dispatch", { ...worker, rung: "codex:gpt-6-sol#medium" });
       expect(failed.data.dispatched.rung).toBe("codex:gpt-6-sol#medium");
-      // wait records the limit and launches the stand-in without awaiting it; the next wait collects it
-      const limited = (await call(c, "wait", { run })).data;
-      expect(limited.records[0].record).toMatchObject({ status: "limit", rung: "codex:gpt-6-sol#medium" });
-      expect(limited.records[0].hints[0]).toBe(
-        "limit: codex:gpt-6-sol#medium hit a usage limit; failed over to codex:gpt-6-sol#high",
-      );
-      expect(limited.started).toEqual([
-        expect.objectContaining({ name: "worker-M1.L1", rung: "codex:gpt-6-sol#high" }),
-      ]);
-      expect(limited.running).toEqual(["worker-M1.L1"]);
-      const stood = (await call(c, "wait", { run })).data;
-      expect(stood.records[0].record).toMatchObject({
+      // the server records the limit and launches the stand-in at once; result reads both, the limit's hint first
+      await until(async () => recordsOf(dir).length === 3);
+      expect(recordsOf(dir).map((r) => r.status)).toEqual(["ok", "limit", "ok"]);
+      const stood = (await call(c, "result", { run, name: "worker-M1.L1" })).data;
+      expect(stood.record).toMatchObject({
         status: "ok",
         rung: "codex:gpt-6-sol#high",
         failoverFrom: "codex:gpt-6-sol#medium",
         changedOwned: ["src/a.ts"],
       });
-      expect(stood.running).toEqual([]);
+      expect(stood.hints[0]).toBe(
+        "limit: codex:gpt-6-sol#medium hit a usage limit; failed over to codex:gpt-6-sol#high",
+      );
 
       // land: five columns with minutes, and what it learned goes to the repo's knowledge.
       const sha = commitAll(repo);
       const landed = await call(c, "land", {
         run,
@@ -294,25 +262,20 @@ describe("catherd mcp over stdio, on the Codex simulator", () => {
       writeProfile({});
 
       // cancel: a hanging role is stopped and recorded once as cancelled.
       sim.rewrite({ hangMs: 60_000 });
       expect((await call(c, "dispatch", second)).isError).toBe(false);
-      const hanging = call(c, "wait", { run, names: ["worker-M1.L2"] });
       await until(async () =>
         (await call(c, "status", { run })).data.runs[0].live.some(
           (l: { state: string }) => l.state === "running",
         ),
       );
       const cancelled = await call(c, "cancel", { run, name: "worker-M1.L2" });
       expect(cancelled.data.record.status).toBe("cancelled");
-      // cancel collects the record: the wait in flight may return it too, and no later wait does
-      const id = cancelled.data.record.dispatchId;
-      const inFlight = (await hanging).data.records as { record: { dispatchId: string } }[];
-      expect(inFlight.every((r) => r.record.dispatchId === id)).toBe(true);
-      expect((await call(c, "wait", { run })).data.records).toEqual([]);
+      expect(recordsOf(dir).filter((r) => r.dispatchId === cancelled.data.record.dispatchId)).toHaveLength(1);
 
-      // restart mid-run: the server dies while a role runs; the next server's wait collects its one record.
+      // restart mid-run: the server dies while a role runs; the next server records it, once.
       sim.rewrite({
         delayMs: 2_000,
         eventsFile: join(FX, "two-turns.jsonl"),
         reply: "ok\nSTATUS: complete — b",
         touch: [{ path: "src/b.ts", content: "b" }],
@@ -321,15 +284,12 @@ describe("catherd mcp over stdio, on the Codex simulator", () => {
       expect((await call(c, "dispatch", second)).isError).toBe(false);
       await crash(c);
       // the dead server recorded nothing: the record below is the next server's
       expect(recordsOf(dir)).toHaveLength(recordedBefore);
       c = await connect(env);
-      const collected = (await call(c, "wait", { run })).data;
-      expect(collected.records.map((r: { record: { name: string } }) => r.record.name)).toEqual([
-        "worker-M1.L2",
-      ]);
-      const done = collected.records[0].record;
+      await until(async () => recordsOf(dir).length === recordedBefore + 1);
+      const done = (await call(c, "result", { run, name: "worker-M1.L2" })).data.record;
       expect(done.status).toBe("ok");
       expect(done.changedOwned).toEqual(["src/b.ts"]);
       const ids = recordsOf(dir).map((r) => r.dispatchId);
       expect(new Set(ids).size).toBe(ids.length);
       expect((await call(c, "status", { run })).data.runs[0].live).toEqual([]);
@@ -343,11 +303,11 @@ describe("concurrency and corruption, over stdio", () => {
   it(
     "admits one of two parallel overlapping dispatches, and one of two with the same name",
     async () => {
       const { repo, sim, env } = setup();
       const c = await connect(env);
-      const { run } = (await call(c, "run_start", { repo, title: "p", a_lines: ["A1"] })).data;
+      const { run, dir } = (await call(c, "run_start", { repo, title: "p", a_lines: ["A1"] })).data;
       await call(c, "write_run_file", {
         run,
         path: "lanes/M1.L1.md",
         content: lane("M1.L1", "src/", "true"),
       });
@@ -366,12 +326,12 @@ describe("concurrency and corruption, over stdio", () => {
       const names = await Promise.all([
         call(c, "dispatch", { ...base, name: "writer", role: "writer" }),
         call(c, "dispatch", { ...base, name: "writer", role: "writer" }),
       ]);
       expect(names.map((r) => r.error?.code ?? "ok").sort()).toEqual(["E_ADMIT_DUPLICATE", "ok"]);
-      const all = (await call(c, "wait", { run, all: true })).data;
-      expect(all.records.map((r: { record: { status: string } }) => r.record.status)).toEqual(["ok", "ok"]);
+      await until(async () => recordsOf(dir).length === 2);
+      expect(recordsOf(dir).map((r) => r.status)).toEqual(["ok", "ok"]);
       await c.close();
     },
     { timeout: 60_000 },
   );
 
@@ -426,11 +386,12 @@ describe("concurrency and corruption, over stdio", () => {
         name: "writer",
         brief: "b",
         rung: "codex:gpt-6-luna#high",
       });
       expect(r.data.dispatched.name).toBe("writer");
-      expect((await call(c2, "wait", { run })).data.records[0].record.status).toBe("ok");
+      await until(async () => recordsOf(dir).length === 1);
+      expect((await call(c2, "result", { run, name: "writer" })).data.record.status).toBe("ok");
       expect(recordsOf(dir).map((x) => x.status)).toEqual(["ok"]);
       await c2.close();
     },
     { timeout: 60_000 },
   );
```


#### Modify `test/services/dispatch.test.ts`

```diff
--- a/test/services/dispatch.test.ts
+++ b/test/services/dispatch.test.ts
@@ -1,24 +1,26 @@
 import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
 import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
 import { isCatherdError } from "../../src/domain/errors.ts";
+import * as dispatchDir from "../../src/infra/dispatch-dir.ts";
 import { awaitsCollect, dispatchPaths, readExit } from "../../src/infra/dispatch-dir.ts";
 import { resetReadiness } from "../../src/services/backends.ts";
-import * as fin from "../../src/services/finalize.ts";
-import * as state from "../../src/services/state.ts";
 import {
   dispatch,
   type DispatchInput,
   launcher,
-  wait,
+  type Settled,
+  settledHooks,
   watchersSettled,
 } from "../../src/services/dispatch-service.ts";
 import { admit } from "../../src/services/admission.ts";
 import { listDispatches, liveDispatches, startLimits } from "../../src/services/dispatches.ts";
 import { finalizeDispatch } from "../../src/services/finalize.ts";
+import { reconcileAll } from "../../src/services/reconcile.ts";
+import { result } from "../../src/services/run-service.ts";
 import { readRecords, runPaths } from "../../src/services/run-store.ts";
 import { readNotes } from "../../src/services/state.ts";
 import { noPosixModes, openModes, snapshotEnv } from "../helpers.ts";
 import { type CodexScenario, simPath, withScenario } from "../sim/scenario.ts";
 import { processStartTime } from "../../src/infra/proc.ts";
@@ -176,12 +178,10 @@ describe("dispatch", () => {
 });
 
 /** A file the simulated worker waits for before it exits: the test decides when each worker ends. */
 const holdFile = () => join(mkdtempSync(join(tmpdir(), "catherd-hold-")), "release");
 const OK = { reply: "Done.\nSTATUS: complete — ok" };
-const NOTHING = "nothing to wait for: every dispatch of this run has been collected; dispatch a role first";
-const NOTHING_FOR = (n: string) => `${n} has nothing to collect: result(run, "${n}") reads its last record`;
 const L2 = { name: "worker-M1.L2", lane: "M1.L2", rung: "codex:gpt-6-sol#medium" };
 
 /** Two lanes whose workers each run until released: M1.L1 at Luna, M1.L2 at Sol medium. */
 function twoLanes() {
   const [a, b] = [holdFile(), holdFile()];
@@ -190,11 +190,14 @@ function twoLanes() {
   });
   writeLane(s.run, "M1.L2", ["src/b.ts"]);
   return { ...s, releaseA: () => writeFileSync(a, ""), releaseB: () => writeFileSync(b, "") };
 }
 
-describe("dispatch returns at launch, wait collects (plan 9, finding 1)", () => {
+const read = (deps: ReturnType<typeof fakeDeps>, run: string, name = "worker-M1.L1") =>
+  result(deps, { run, name });
+
+describe("dispatch returns at launch; its watcher settles it; result reads it (plan 10)", () => {
   it("returns while the worker still runs, with its name and admission time", async () => {
     const release = holdFile();
     const { run, deps } = setup({ ...OK, holdUntil: release });
     const out = await dispatch(deps, input(run.id, { next: "review M1" }));
     const d = listDispatches(run)[0];
@@ -212,197 +215,70 @@ describe("dispatch returns at launch, wait collects (plan 9, finding 1)", () =>
     expect(liveDispatches(run).map((x) => x.admit.name)).toEqual(["worker-M1.L1"]);
     expect(readRecords(run).records).toEqual([]);
     expect(readNotes(run).next).toBe("review M1");
     expect(readFileSync(runPaths(run.dir).state, "utf8")).not.toContain("Running:\n- none");
     writeFileSync(release, "");
-    const w = await wait(deps, { run: run.id });
-    expect(w.records.map((r) => r.record.status)).toEqual(["ok"]);
-    expect(w.records[0]?.hints).toEqual(["climb: unchanged"]);
-    expect({ started: w.started, running: w.running }).toEqual({ started: [], running: [] });
+    await watchersSettled();
+    const r = await read(deps, run.id);
+    expect(r.record?.status).toBe("ok");
+    expect(r.hints).toEqual(["climb: unchanged"]);
     expect(readFileSync(runPaths(run.dir).state, "utf8")).toContain("Running:\n- none");
   });
 
-  it("has two dispatches issued one after the other live at once; wait returns the first to finish", async () => {
+  it("has two dispatches issued one after the other live at once, each recorded as it finishes", async () => {
     const { run, deps, releaseA, releaseB } = twoLanes();
     const a = await dispatch(deps, input(run.id));
     const b = await dispatch(deps, input(run.id, L2));
     // each worker runs until the test releases it: the second was admitted while the first still ran
     expect(Date.parse(b.dispatched.admittedAt) - Date.parse(a.dispatched.admittedAt)).toBeLessThan(5_000);
     expect(liveDispatches(run).map((d) => d.admit.name)).toEqual([a, b].map((x) => x.dispatched.name).sort());
     releaseB();
-    const first = await wait(deps, { run: run.id });
-    expect(first.records.map((r) => r.record.name)).toEqual(["worker-M1.L2"]);
-    expect(first.running).toEqual(["worker-M1.L1"]);
-    releaseA();
-    const second = await wait(deps, { run: run.id });
-    expect(second.records.map((r) => r.record.name)).toEqual(["worker-M1.L1"]);
-    expect(second.running).toEqual([]);
-    expect(readRecords(run).records).toHaveLength(2);
-  });
-
-  it("waits for every one of them with all: true", async () => {
-    const { run, deps, releaseA, releaseB } = twoLanes();
-    await dispatch(deps, input(run.id));
-    await dispatch(deps, input(run.id, L2));
-    releaseB();
-    let done = false;
-    const all = wait(deps, { run: run.id, all: true }).then((w) => {
-      done = true;
-      return w;
-    });
-    // wait records M1.L2 once it finishes, and goes on waiting for M1.L1
-    await waitFor(() => readRecords(run).records.some((r) => r.name === "worker-M1.L2"));
-    expect(done).toBe(false);
-    releaseA();
-    const w = await all;
-    expect(w.records.map((r) => r.record.name)).toEqual(["worker-M1.L2", "worker-M1.L1"]);
-    expect(w.running).toEqual([]);
-  });
-
-  it("returns the records of one wait in the order the roles finished, whatever order it saw them in", async () => {
-    const { run, deps, releaseA, releaseB } = twoLanes();
-    await dispatch(deps, input(run.id));
-    await dispatch(deps, input(run.id, L2));
-    // both finish, M1.L2 first, before any wait polls: one poll then sees both at once
-    releaseB();
     await waitFor(() => readRecords(run).records.some((r) => r.name === "worker-M1.L2"));
+    expect(liveDispatches(run).map((d) => d.admit.name)).toEqual(["worker-M1.L1"]);
     releaseA();
-    await waitFor(() => readRecords(run).records.some((r) => r.name === "worker-M1.L1"));
-    const w = await wait(deps, { run: run.id, all: true });
-    expect(w.records.map((r) => r.record.name)).toEqual(["worker-M1.L2", "worker-M1.L1"]);
-  });
-
-  it("returns at once, with a hint, when nothing is uncollected", async () => {
-    const { run, deps } = setup(OK);
-    expect(await wait(deps, { run: run.id })).toEqual({
-      records: [],
-      started: [],
-      running: [],
-      hints: [NOTHING],
-    });
-    expect((await wait(deps, { run: run.id, names: ["worker-M9.L9"] })).hints).toEqual([
-      NOTHING_FOR("worker-M9.L9"),
-      NOTHING,
-    ]);
-  });
-
-  it("keeps the run's other roles in running when the names given have nothing to collect", async () => {
-    const release = holdFile();
-    const { run, deps } = setup({ ...OK, holdUntil: release });
-    await dispatch(deps, input(run.id));
-    expect(await wait(deps, { run: run.id, names: ["worker-M9.L9"] })).toEqual({
-      records: [],
-      started: [],
-      running: ["worker-M1.L1"],
-      hints: [NOTHING_FOR("worker-M9.L9")],
-    });
-    writeFileSync(release, "");
-    expect((await wait(deps, { run: run.id })).records).toHaveLength(1);
-  });
-
-  it("lists in running a role that finished but was not collected, and the next wait returns it (I-1)", async () => {
-    const { run, deps, releaseA, releaseB } = twoLanes();
-    await dispatch(deps, input(run.id));
-    const b = await dispatch(deps, input(run.id, L2));
-    releaseB();
-    await waitFor(() =>
-      readExit(listDispatches(run).find((d) => d.admit.dispatchId === b.dispatched.dispatchId)?.dir ?? ""),
-    );
-    releaseA();
-    const first = await wait(deps, { run: run.id, names: ["worker-M1.L1"] });
-    expect(first.records.map((r) => r.record.name)).toEqual(["worker-M1.L1"]);
-    expect(first.running).toEqual(["worker-M1.L2"]);
-    const next = await wait(deps, { run: run.id });
-    expect(next.records.map((r) => r.record.name)).toEqual(["worker-M1.L2"]);
-    expect(next.running).toEqual([]);
+    await watchersSettled();
+    expect(readRecords(run).records.map((r) => r.name)).toEqual(["worker-M1.L2", "worker-M1.L1"]);
   });
 
-  it("finalizes a role as soon as it exits, and leaves its record for wait to hand back (I-2)", async () => {
+  it("settles a role as soon as it exits, and leaves its record unread until result reads it", async () => {
     const release = holdFile();
     const { run, deps } = setup({ ...OK, holdUntil: release });
     await dispatch(deps, input(run.id));
     writeFileSync(release, "");
     await waitFor(() => readRecords(run).records.length === 1);
     await waitFor(() => readFileSync(runPaths(run.dir).state, "utf8").includes("Running:\n- none"));
-    const d = listDispatches(run)[0];
-    expect(awaitsCollect(d?.dir ?? "")).toBe(true);
-    expect((await wait(deps, { run: run.id })).records.map((r) => r.record.status)).toEqual(["ok"]);
-  });
-
-  it("hints and drops a dispatch it cannot finalize, and still returns the others (I-3)", async () => {
-    const { run, deps } = setup(OK);
-    const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };
-    const files = { proc: "dead" as const, exit, reply: "ok\nSTATUS: complete — ok", collect: true };
-    const broken = await fakeDispatch(run, {}, files);
-    const fine = await fakeDispatch(run, { name: "writer", role: "writer", lane: null, owns: [] }, files);
-    const real = fin.finalizeDispatch;
-    const spy = spyOn(fin, "finalizeDispatch").mockImplementation((r, d) =>
-      d.admit.dispatchId === broken.admit.dispatchId ? Promise.reject(new Error("disk on fire")) : real(r, d),
-    );
-    try {
-      const w = await wait(deps, { run: run.id, all: true });
-      expect(w.records.map((r) => r.record.dispatchId)).toEqual([fine.admit.dispatchId]);
-      expect(w.hints).toContain(
-        'worker-M1.L1: not finalized: disk on fire; result(run, "worker-M1.L1") reads its record once it has one',
-      );
-      expect(w.running).toEqual([]);
-      expect((await wait(deps, { run: run.id })).hints).toEqual([NOTHING]);
-    } finally {
-      spy.mockRestore();
-    }
-  });
-
-  it("puts back what it collected when an error escapes, so the next wait returns it (I-3)", async () => {
-    const release = holdFile();
-    const { run, deps } = setup({ ...OK, holdUntil: release });
-    await dispatch(deps, input(run.id));
-    writeFileSync(release, "");
-    await waitFor(() => readRecords(run).records.length === 1);
-    await watchersSettled();
-    const spy = spyOn(state, "refreshState").mockImplementation(() => Promise.reject(new Error("no disk")));
-    try {
-      expect(await wait(deps, { run: run.id }).catch((e: Error) => e.message)).toBe("no disk");
-    } finally {
-      spy.mockRestore();
-    }
-    expect((await wait(deps, { run: run.id })).records.map((r) => r.record.status)).toEqual(["ok"]);
-  });
-
-  it("stops without collecting when its caller aborts it (I-3)", async () => {
-    const release = holdFile();
-    const { run, deps } = setup({ ...OK, holdUntil: release });
-    await dispatch(deps, input(run.id));
-    const ac = new AbortController();
-    const pending = wait(deps, { run: run.id }, undefined, ac.signal);
-    ac.abort();
-    writeFileSync(release, "");
-    expect((await pending).records).toEqual([]);
-    expect((await wait(deps, { run: run.id })).records.map((r) => r.record.status)).toEqual(["ok"]);
+    const d = listDispatches(run)[0] as { dir: string };
+    expect(awaitsCollect(d.dir)).toBe(true);
+    expect((await read(deps, run.id)).record?.status).toBe("ok");
+    expect(awaitsCollect(d.dir)).toBe(false);
   });
 
-  it("puts back what it collected when aborted during its final refresh (N-1)", async () => {
+  it("runs every settled hook once per dispatch, and a hook that throws stops nothing", async () => {
     const release = holdFile();
     const { run, deps } = setup({ ...OK, holdUntil: release });
-    await dispatch(deps, input(run.id));
-    writeFileSync(release, "");
-    await waitFor(() => readRecords(run).records.length === 1);
-    await watchersSettled();
-    const ac = new AbortController();
-    const real = state.refreshState;
-    const spy = spyOn(state, "refreshState").mockImplementation((r, c) => {
-      ac.abort();
-      return real(r, c);
-    });
+    const seen: string[] = [];
+    const bad = () => {
+      throw new Error("hook broke");
+    };
+    const good = (s: Settled) => {
+      seen.push(`${s.record.name} ${s.record.status}`);
+    };
+    settledHooks.add(bad);
+    settledHooks.add(good);
     try {
-      expect((await wait(deps, { run: run.id }, undefined, ac.signal)).records).toEqual([]);
+      await dispatch(deps, input(run.id));
+      writeFileSync(release, "");
+      await watchersSettled();
     } finally {
-      spy.mockRestore();
+      settledHooks.delete(bad);
+      settledHooks.delete(good);
     }
-    expect((await wait(deps, { run: run.id })).records.map((r) => r.record.status)).toEqual(["ok"]);
+    expect(seen).toEqual(["worker-M1.L1 ok"]);
+    expect(readFileSync(runPaths(run.dir).state, "utf8")).toContain("Running:\n- none");
   });
 
-  it("keeps the mark when the launch throws: dispatch says so, and a wait returns the lost record (M-4)", async () => {
+  it("keeps the mark when the launch throws: dispatch says so, and the lost record is settled and read (M-4)", async () => {
     const { run, deps } = setup(OK);
     startLimits.graceMs = 300;
     const real = launcher.launch;
     launcher.launch = () => {
       throw new Error("no fork");
@@ -412,20 +288,20 @@ describe("dispatch returns at launch, wait collects (plan 9, finding 1)", () =>
       e = await dispatch(deps, input(run.id)).catch((x: unknown) => x);
     } finally {
       launcher.launch = real;
     }
     expect(isCatherdError(e) && e.message).toMatch(/no fork/);
-    expect(isCatherdError(e) && e.fix).toMatch(/wait\(run\) returns its record/);
+    expect(isCatherdError(e) && e.fix).toMatch(/result\(run, "worker-M1\.L1"\) reads its record, lost/);
     const d = listDispatches(run)[0];
     expect(d && awaitsCollect(d.dir)).toBe(true);
-    const w = await wait(deps, { run: run.id });
-    expect(w.records.map((r) => r.record)).toEqual([
+    await watchersSettled();
+    expect((await read(deps, run.id)).record).toEqual(
       expect.objectContaining({ status: "failed", exitCode: null }),
-    ]);
+    );
   });
 
-  it("returns the lost record of a dispatch whose server died after admitting it, before launching it", async () => {
+  it("records a dispatch whose server died after admitting it, before launching it, at the next start", async () => {
     const { run, deps } = setup(OK);
     startLimits.graceMs = 300;
     // what dispatch had done when its process died: admission only
     const { d } = await admit(deps, run, {
       role: "worker",
@@ -435,137 +311,83 @@ describe("dispatch returns at launch, wait collects (plan 9, finding 1)", () =>
       thread: null,
       lane: "M1.L1",
       failoverFrom: null,
     });
     expect(awaitsCollect(d.dir)).toBe(true);
-    const w = await wait(deps, { run: run.id });
-    expect(w.records.map((r) => r.record)).toEqual([
+    await (
+      await reconcileAll(deps)
+    ).done;
+    expect((await read(deps, run.id)).record).toEqual(
       expect.objectContaining({ dispatchId: d.admit.dispatchId, status: "failed", exitCode: null }),
-    ]);
-  });
-
-  it("collects a dispatch that finished while no wait ran, as after a server restart, once", async () => {
-    const { run, deps } = setup(OK);
-    const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };
-    const files = { proc: "dead" as const, exit, reply: "ok\nSTATUS: complete — ok", collect: true };
-    const unrecorded = await fakeDispatch(run, {}, files);
-    // one the new server's reconcile recorded first is collected too
-    const reconciled = await fakeDispatch(
-      run,
-      { name: "writer", role: "writer", lane: null, owns: [] },
-      files,
-    );
-    await finalizeDispatch(run, reconciled);
-    // one no catherd dispatch launched for a wait (an older build's) is left to reconcile
-    await fakeDispatch(
-      run,
-      { name: "writer-old", role: "writer", lane: null, owns: [] },
-      { ...files, collect: false },
     );
-    const w = await wait(deps, { run: run.id });
-    expect(w.records.map((r) => r.record.dispatchId).sort()).toEqual(
-      [unrecorded, reconciled].map((d) => d.admit.dispatchId).sort(),
-    );
-    expect(w.records.find((r) => r.record.name === "writer")?.record.status).toBe("ok");
-    expect(readRecords(run).records).toHaveLength(2);
-    expect((await wait(deps, { run: run.id })).records).toEqual([]);
   });
 
-  it("hands a record to one wait only, when two wait at once", async () => {
+  it("marks a record read for one reader, when two read at once", async () => {
     const release = holdFile();
     const { run, deps } = setup({ ...OK, holdUntil: release });
     await dispatch(deps, input(run.id));
-    const both = Promise.all([wait(deps, { run: run.id }), wait(deps, { run: run.id })]);
     writeFileSync(release, "");
-    const [x, y] = await both;
-    expect([...x.records, ...y.records]).toHaveLength(1);
-    expect(readRecords(run).records).toHaveLength(1);
+    await watchersSettled();
+    const d = listDispatches(run)[0] as { dir: string };
+    const collects: boolean[] = [];
+    const real = dispatchDir.tryCollect;
+    const spy = spyOn(dispatchDir, "tryCollect").mockImplementation(async (dir) => {
+      const got = await real(dir);
+      collects.push(got);
+      return got;
+    });
+    try {
+      const [x, y] = await Promise.all([read(deps, run.id), read(deps, run.id)]);
+      expect(x.record).toEqual(y.record);
+    } finally {
+      spy.mockRestore();
+    }
+    expect(collects.filter(Boolean)).toHaveLength(1);
+    expect(awaitsCollect(d.dir)).toBe(false);
   });
 
   it("still refuses from dispatch, before anything starts", async () => {
     const release = holdFile();
     const { run, deps } = setup({ ...OK, holdUntil: release });
     await dispatch(deps, input(run.id));
     const e = await dispatch(deps, input(run.id)).catch((x: unknown) => x);
     expect(isCatherdError(e) && e.code).toBe("E_ADMIT_DUPLICATE");
     expect(listDispatches(run)).toHaveLength(1);
     writeFileSync(release, "");
-    expect((await wait(deps, { run: run.id })).records).toHaveLength(1);
-  });
-
-  it("reports progress while it waits", async () => {
-    const release = holdFile();
-    const { run, deps } = setup({ ...OK, holdUntil: release });
-    await dispatch(deps, input(run.id));
-    const ticks: string[] = [];
-    const pending = wait(deps, { run: run.id }, (m) => ticks.push(m));
-    await waitFor(() => ticks.length > 0);
-    writeFileSync(release, "");
-    expect((await pending).records).toHaveLength(1);
-    expect(ticks[0]).toMatch(/^worker-M1\.L1 · codex:gpt-6-luna#high · \d+s/);
+    await watchersSettled();
+    expect(readRecords(run).records).toHaveLength(1);
   });
 });
 
-describe("collection is a lease: a crash between collecting and returning loses nothing (codex P2)", () => {
+describe("reading is a lease: a crash between taking a record and returning it loses nothing (codex P2)", () => {
   const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };
-  /** A finished dispatch a wait had collected, as its lease names `owner`: the marker is gone. */
+  /** A finished, recorded dispatch a reader had taken, as its lease names `owner`: the mark is gone. */
   async function leased(
     run: Parameters<typeof fakeDispatch>[0],
     owner: { pid: number; startTime: string | null },
   ) {
     const d = await fakeDispatch(run, {}, { proc: "dead", exit, reply: "ok\nSTATUS: complete — ok" });
+    await finalizeDispatch(run, d);
     writeFileSync(dispatchPaths(d.dir).lease, JSON.stringify(owner));
     return d;
   }
 
-  it("collects a lease whose owner died, returns its record and ends the lease", async () => {
+  it("reads a record whose reader died holding its lease, and ends the lease", async () => {
     const { run, deps } = setup(OK);
     const d = await leased(run, { pid: await deadProcess(), startTime: "gone" });
-    const w = await wait(deps, { run: run.id });
-    expect(w.records.map((r) => r.record.dispatchId)).toEqual([d.admit.dispatchId]);
+    expect(awaitsCollect(d.dir)).toBe(true);
+    expect((await read(deps, run.id)).record?.dispatchId).toBe(d.admit.dispatchId);
     expect(existsSync(dispatchPaths(d.dir).lease)).toBe(false);
     expect(awaitsCollect(d.dir)).toBe(false);
   });
 
-  it("lists a dead owner's lease in running when the names given leave it out", async () => {
-    const { run, deps } = setup(OK);
-    await leased(run, { pid: await deadProcess(), startTime: "gone" });
-    const w = await wait(deps, { run: run.id, names: ["worker-M9.L9"] });
-    expect(w.running).toEqual(["worker-M1.L1"]);
-  });
-
-  it("never takes a lease whose owner lives", async () => {
+  it("never takes a lease whose owner lives: the record is returned, the lease left alone", async () => {
     const { run, deps } = setup(OK);
     const d = await leased(run, { pid: process.pid, startTime: processStartTime(process.pid) });
-    const w = await wait(deps, { run: run.id });
-    expect(w.records).toEqual([]);
-    expect(w.running).toEqual([]);
+    expect((await read(deps, run.id)).record?.dispatchId).toBe(d.admit.dispatchId);
     expect(existsSync(dispatchPaths(d.dir).lease)).toBe(true);
   });
-
-  it("holds a lease, not nothing, while it fails over, and ends it when it returns", async () => {
-    const release = holdFile();
-    const { run, deps } = setup({ ...OK, holdUntil: release });
-    await dispatch(deps, input(run.id));
-    writeFileSync(release, "");
-    await waitFor(() => readRecords(run).records.length === 1);
-    await watchersSettled();
-    const d = listDispatches(run)[0] as { dir: string };
-    const real = state.refreshState;
-    const during: boolean[] = [];
-    const spy = spyOn(state, "refreshState").mockImplementation((r, c) => {
-      during.push(existsSync(dispatchPaths(d.dir).lease));
-      return real(r, c);
-    });
-    try {
-      expect((await wait(deps, { run: run.id })).records).toHaveLength(1);
-    } finally {
-      spy.mockRestore();
-    }
-    expect(during).toEqual([true]);
-    expect(existsSync(dispatchPaths(d.dir).lease)).toBe(false);
-  });
 });
 
 describe("finalizeDispatch", () => {
   const finished = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };
 
```


#### Replace the whole of `test/services/failover-cancel.test.ts` with

```ts
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCatherdError } from "../../src/domain/errors.ts";
import * as dispatchDir from "../../src/infra/dispatch-dir.ts";
import { awaitsCollect, dispatchPaths, readExit } from "../../src/infra/dispatch-dir.ts";
import * as backends from "../../src/services/backends.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import {
  cancel,
  dispatch,
  type DispatchInput,
  orphanLimits,
  type Settled,
  settle,
  settledHooks,
  watchersSettled,
} from "../../src/services/dispatch-service.ts";
import { isAlive, processStartTime } from "../../src/infra/proc.ts";
import { writeJsonAtomic } from "../../src/infra/store.ts";
import { launchSupervisor } from "../../src/infra/launch.ts";
import { admit } from "../../src/services/admission.ts";
import {
  type Dispatch,
  latestDispatch,
  launchPath,
  listDispatches,
  liveDispatches,
  readFailover,
  readProc,
} from "../../src/services/dispatches.ts";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import { reconcileAll } from "../../src/services/reconcile.ts";
import { result } from "../../src/services/run-service.ts";
import { readRecords, type Run, runPaths } from "../../src/services/run-store.ts";
import { readNotes } from "../../src/services/state.ts";
import { snapshotEnv } from "../helpers.ts";
import { type CodexScenario, simPath, withScenario } from "../sim/scenario.ts";
import {
  deadProcess,
  fakeDeps,
  fakeDispatch,
  fakeGit,
  freshRun,
  runRole,
  testView,
  waitFor,
  writeLane,
} from "./helpers.ts";

afterEach(() => watchersSettled());
afterEach(snapshotEnv());
beforeEach(() => {
  resetReadiness();
  orphanLimits.killGraceMs = 10_000;
});

const orphans: Bun.Subprocess[] = [];
afterEach(() => {
  for (const p of orphans.splice(0)) p.kill("SIGKILL");
});

/** A worker left running in its own process group, as a dead supervisor leaves one. */
function orphan(script: string): Bun.Subprocess {
  const p = Bun.spawn(["sh", "-c", script], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
  });
  orphans.push(p);
  return p;
}

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
const LIMIT = { eventsFile: join(FX, "limit.jsonl"), exitCode: 1 };
const DONE = { reply: "Done.\nSTATUS: complete — ok", touch: [{ path: "src/a.ts", content: "fixed" }] };
const FAILOVER = { "codex:gpt-6-sol#medium": "codex:gpt-6-sol#high" };
const FAILED_OVER = "limit: codex:gpt-6-sol#medium hit a usage limit; failed over to codex:gpt-6-sol#high";

function setup(s: CodexScenario, failover: Record<string, string> = FAILOVER) {
  const { repo, run } = freshRun();
  process.env.PATH = simPath();
  Object.assign(process.env, withScenario(s).env);
  writeLane(run, "M1.L1", ["src/a.ts"]);
  return { repo, run, deps: fakeDeps({ view: testView({ failover }) }) };
}

const input = (run: string, over: Partial<DispatchInput> = {}): DispatchInput => ({
  run,
  role: "worker",
  name: "worker-M1.L1",
  brief: "Read lanes/M1.L1.md",
  rung: "codex:gpt-6-sol#medium",
  lane: "M1.L1",
  ...over,
});

const standInOf = (run: Run) => listDispatches(run).find((d) => d.admit.failoverOf !== undefined);

/** A limited dispatch recorded on disk, as a server that died before settling it left it: unread, no failover. */
async function limitedOnDisk(
  run: Run,
): Promise<{ d: Dispatch; record: Awaited<ReturnType<typeof finalizeDispatch>> }> {
  const exit = { code: 1, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };
  const d = await fakeDispatch(
    run,
    {},
    { proc: "dead", exit, events: readFileSync(LIMIT.eventsFile, "utf8"), collect: true },
  );
  const record = await finalizeDispatch(run, d);
  expect(record.status).toBe("limit");
  return { d, record };
}

describe("failover (spec §3.4: it runs as soon as a limit is settled)", () => {
  it("launches the stand-in as the limit is settled, writes what it did once, and hands it to the hooks", async () => {
    const release = join(mkdtempSync(join(tmpdir(), "catherd-hold-")), "release");
    const { run, deps } = setup({
      byRung: { "gpt-6-sol#medium": LIMIT, "gpt-6-sol#high": { ...DONE, holdUntil: release } },
    });
    const seen: Settled[] = [];
    const hook = (s: Settled) => {
      seen.push(s);
    };
    settledHooks.add(hook);
    try {
      const limited = (await dispatch(deps, input(run.id))).dispatched;
      const stand = await waitFor(() => standInOf(run));
      await waitFor(() => seen.length === 1);
      expect(stand.admit).toMatchObject({ rung: "codex:gpt-6-sol#high", failoverOf: limited.dispatchId });
      expect(seen[0]?.record.status).toBe("limit");
      expect(seen[0]?.hints).toEqual([FAILED_OVER]);
      expect(seen[0]?.started).toMatchObject({ name: "worker-M1.L1", dispatchId: stand.admit.dispatchId });
      const dir = listDispatches(run).find((d) => d.admit.dispatchId === limited.dispatchId)?.dir as string;
      expect(readFailover(dir)).toMatchObject({
        standIn: { dispatchId: stand.admit.dispatchId, rung: "codex:gpt-6-sol#high" },
        hints: [FAILED_OVER],
        pause: null,
      });
      expect(readNotes(run).next).not.toMatch(/^paused/);
      writeFileSync(release, "");
      await watchersSettled();
    } finally {
      settledHooks.delete(hook);
    }
    const r = await result(deps, { run: run.id, name: "worker-M1.L1" });
    expect(r.record).toMatchObject({
      status: "ok",
      rung: "codex:gpt-6-sol#high",
      failoverFrom: "codex:gpt-6-sol#medium",
    });
    expect(r.hints).toEqual([FAILED_OVER]);
  });

  it("still settles the limited record, paused, when the failover throws an unexpected error (I-3)", async () => {
    const release = join(mkdtempSync(join(tmpdir(), "catherd-hold-")), "release");
    const { run, deps } = setup({ ...LIMIT, holdUntil: release });
    // admitted first (admission reads the stand-ins too); the failover, after the limit, throws
    await dispatch(deps, input(run.id));
    const spy = spyOn(backends, "standInFor").mockImplementation(() => {
      throw new Error("profile vanished");
    });
    try {
      writeFileSync(release, "");
      await watchersSettled();
    } finally {
      spy.mockRestore();
    }
    const r = await result(deps, { run: run.id, name: "worker-M1.L1" });
    expect(r.record?.status).toBe("limit");
    expect(r.hints.at(-1)).toBe("failover: profile vanished");
    expect(readNotes(run).next).toBe("paused: codex usage limit; resume when the user says so");
  });

  it("reruns a fresh round's own brief on the stand-in, and records both runs", async () => {
    const { run, deps } = setup({ byRung: { "gpt-6-sol#medium": LIMIT, "gpt-6-sol#high": DONE } });
    const { record, hints } = await runRole(deps, input(run.id));
    expect(record).toMatchObject({
      status: "ok",
      rung: "codex:gpt-6-sol#high",
      failoverFrom: "codex:gpt-6-sol#medium",
      attempt: 2,
      changedOwned: ["src/a.ts"],
    });
    expect(hints[0]).toBe(FAILED_OVER);
    expect(readRecords(run).records.map((r) => r.status)).toEqual(["limit", "ok"]);
    const stand = latestDispatch(run, "worker-M1.L1");
    expect(stand?.admit.thread).toBeNull();
    expect(readFileSync(dispatchPaths(stand?.dir ?? "").brief, "utf8")).toBe("Read lanes/M1.L1.md");
  });

  it("keeps the limited run's violations in the hints after a successful failover", async () => {
    const { run, deps } = setup({
      byRung: {
        "gpt-6-sol#medium": { ...LIMIT, touch: [{ path: "src/other.ts", content: "out of lane" }] },
        "gpt-6-sol#high": DONE,
      },
    });
    const { record, hints } = await runRole(deps, input(run.id));
    expect(record.status).toBe("ok");
    expect(readRecords(run).records[0]?.violations).toEqual(["src/other.ts"]);
    expect(hints).toEqual([FAILED_OVER, "violation: src/other.ts"]);
  });

  it("hands a fix round's stand-in the lane file and the fix brief by path, both of which exist", async () => {
    const { run, deps } = setup({ byRung: { "gpt-6-sol#medium": LIMIT, "gpt-6-sol#high": DONE } });
    const { record } = await runRole(
      deps,
      input(run.id, { thread: "t-earlier-thread", brief: "Fix: BUG src/a.ts:3 — off by one" }),
    );
    expect(record.status).toBe("ok");
    const stand = latestDispatch(run, "worker-M1.L1");
    const brief = readFileSync(dispatchPaths(stand?.dir ?? "").brief, "utf8");
    const paths = [...brief.matchAll(/: (\/\S+)/g)].map((m) => m[1] as string);
    expect(paths).toHaveLength(2);
    for (const p of paths) expect(existsSync(p)).toBe(true);
    expect(readFileSync(paths[1] as string, "utf8")).toBe("Fix: BUG src/a.ts:3 — off by one");
  });

  it("puts the stand-in through the budget again, and pauses when it is refused", async () => {
    const events = join(mkdtempSync(join(tmpdir(), "catherd-fx-")), "limit-after-work.jsonl");
    writeFileSync(
      events,
      [
        '{"type":"thread.started","thread_id":"t-spent"}',
        '{"type":"turn.completed","usage":{"input_tokens":5000,"cached_input_tokens":0,"output_tokens":100}}',
        '{"type":"turn.failed","error":{"message":"You\'ve hit your usage limit. Try again later."}}',
        "",
      ].join("\n"),
    );
    const { run, deps } = setup({
      byRung: { "gpt-6-sol#medium": { eventsFile: events, exitCode: 1 }, "gpt-6-sol#high": DONE },
    });
    deps.view.budget = { tokens: 1000 };
    const { record, hints } = await runRole(deps, input(run.id));
    expect(record.status).toBe("limit");
    expect(hints.at(-1)).toMatch(/^failover: codex:gpt-6-sol#high refused: E_RUN_BUDGET/);
    expect(readRecords(run).records).toHaveLength(1);
    expect(readFileSync(runPaths(run.dir).state, "utf8")).toContain("Next: paused: codex usage limit");
  });

  it("keeps the paused note in state.json when git breaks before state.md can be refreshed", async () => {
    const { run, deps } = setup(LIMIT, {});
    // git breaks once the worker has ended (its exit.json exists), not after a guessed delay
    const roles = runPaths(run.dir).roles;
    fakeGit(`for e in '${roles}'/*/*/exit.json; do [ -f "$e" ] && exit 128; done\nexec "$REAL_GIT" "$@"`);
    const { record } = await runRole(deps, input(run.id));
    expect(record).toMatchObject({ status: "limit", gitUnavailable: true });
    expect(readNotes(run).next).toBe("paused: codex usage limit; resume when the user says so");
  });

  it("names the agent when the stand-in is a native Claude rung, without pausing", async () => {
    const { run, deps } = setup(LIMIT, { "codex:gpt-6-sol#medium": "claude:claude-opus-5-5#high" });
    const { record, hints } = await runRole(deps, input(run.id));
    expect(record.status).toBe("limit");
    expect(hints.at(-1)).toBe(
      'failover: run worker-M1.L1 as Agent(subagent_type: "catherd-worker-claude-opus-5-5-high"), standing in for codex:gpt-6-sol#medium',
    );
    expect(readFileSync(runPaths(run.dir).state, "utf8")).not.toContain("paused");
  });
});

describe("failover's stand-in, tied to its limited dispatch, launched once (N-3)", () => {
  // every held stand-in is released after its test, pass or fail, so no watcher outlives it
  const releases: string[] = [];
  const held = () => {
    const f = join(mkdtempSync(join(tmpdir(), "catherd-hold-")), "release");
    releases.push(f);
    return f;
  };
  afterEach(() => {
    for (const f of releases.splice(0)) writeFileSync(f, "");
  });

  it("reuses the stand-in when a limit is settled a second time: no second launch", async () => {
    const release = held();
    const { run, deps } = setup({
      byRung: { "gpt-6-sol#medium": LIMIT, "gpt-6-sol#high": { ...DONE, holdUntil: release } },
    });
    const limited = (await dispatch(deps, input(run.id))).dispatched;
    const stand = await waitFor(() => standInOf(run));
    const d = listDispatches(run).find((x) => x.admit.dispatchId === limited.dispatchId) as Dispatch;
    await waitFor(() => readFailover(d.dir));
    const record = readRecords(run).records.find((r) => r.dispatchId === limited.dispatchId);
    const again = await settle(deps, run, d, record as NonNullable<typeof record>);
    expect(again.started?.dispatchId).toBe(stand.admit.dispatchId);
    expect(again.hints).toEqual([FAILED_OVER]);
    expect(listDispatches(run)).toHaveLength(2);
  });

  it("starts a stand-in admitted before a crash but never launched, instead of reporting it started (M-5)", async () => {
    const release = held();
    const { run, deps } = setup({ ...DONE, holdUntil: release });
    const { d, record } = await limitedOnDisk(run);
    // the settle that crashed had admitted the stand-in (admit.json, spec.json, the mark) and died before its launch
    const stand = await admit(deps, run, {
      role: "worker",
      name: "worker-M1.L1",
      brief: "Read lanes/M1.L1.md",
      rung: "codex:gpt-6-sol#high",
      thread: null,
      lane: "M1.L1",
      failoverFrom: "codex:gpt-6-sol#medium",
      failoverOf: d.admit.dispatchId,
    });
    const s = await settle(deps, run, d, record);
    expect(s.started?.dispatchId).toBe(stand.d.admit.dispatchId);
    expect(existsSync(launchPath(stand.d.dir))).toBe(true);
    writeFileSync(release, "");
    await watchersSettled();
    expect(readRecords(run).records.map((r) => [r.dispatchId, r.status])).toEqual([
      [d.admit.dispatchId, "limit"],
      [stand.d.admit.dispatchId, "ok"],
    ]);
  });

  it("reuses a stand-in whose settle died between spawning its supervisor and writing launch.json", async () => {
    const release = held();
    const { run, deps } = setup({ ...DONE, holdUntil: release });
    const { d, record } = await limitedOnDisk(run);
    const stand = await admit(deps, run, {
      role: "worker",
      name: "worker-M1.L1",
      brief: "Read lanes/M1.L1.md",
      rung: "codex:gpt-6-sol#high",
      thread: null,
      lane: "M1.L1",
      failoverFrom: "codex:gpt-6-sol#medium",
      failoverOf: d.admit.dispatchId,
    });
    // the settle spawned the supervisor and died before launch.json: the supervisor holds the dispatch
    launchSupervisor(stand.specPath);
    await waitFor(() => existsSync(dispatchPaths(stand.d.dir).supervisorLock));
    const s = await settle(deps, run, d, record);
    expect(s.started?.dispatchId).toBe(stand.d.admit.dispatchId);
    // reused, not launched again: recovery never wrote a launch.json of its own
    expect(existsSync(launchPath(stand.d.dir))).toBe(false);
  });

  it("is settled by the next server's reconcile when its own server died before settling it, once", async () => {
    const release = held();
    const { run, deps } = setup({ ...DONE, holdUntil: release });
    const { d } = await limitedOnDisk(run);
    // reconcile settles before it returns; its `done` would wait for the held stand-in too
    await reconcileAll(deps);
    const first = readFailover(d.dir);
    expect(first?.standIn?.rung).toBe("codex:gpt-6-sol#high");
    const again = await reconcileAll(deps);
    expect(readFailover(d.dir)).toEqual(first);
    expect(listDispatches(run)).toHaveLength(2);
    // the second reconcile watches the stand-in it found running: let it finish inside this test
    writeFileSync(release, "");
    await again.done;
  });

  it("leaves a read limit alone at the next start: failover is for what the orchestrator has not read", async () => {
    const { run, deps } = setup(DONE);
    const { d } = await limitedOnDisk(run);
    await result(deps, { run: run.id, name: "worker-M1.L1" });
    expect(awaitsCollect(d.dir)).toBe(false);
    await reconcileAll(deps);
    expect(readFailover(d.dir)).toBeNull();
    expect(listDispatches(run)).toHaveLength(1);
  });

  it("never hands one limited dispatch's stand-in to another of the same name and rung", async () => {
    const release = held();
    const { run, deps } = setup({ ...DONE, holdUntil: release });
    const a = await limitedOnDisk(run);
    const b = await limitedOnDisk(run);
    const first = await settle(deps, run, a.d, a.record);
    expect(first.started).not.toBeNull();
    // b is not a's: its own stand-in is refused while a's stand-in, of the same name, runs
    const second = await settle(deps, run, b.d, b.record);
    expect(second.started).toBeNull();
    expect(second.hints.at(-1)).toMatch(/^failover: codex:gpt-6-sol#high refused: E_ADMIT_DUPLICATE/);
  });
});

describe("cancel", () => {
  it("says so when result already read the record it returns (N-2)", async () => {
    const { run, deps } = setup({ hangMs: 30_000 });
    await dispatch(deps, input(run.id));
    await waitFor(() => liveDispatches(run).find((d) => d.state === "running"));
    const spy = spyOn(dispatchDir, "tryCollect").mockImplementation(async () => false);
    try {
      const { hints } = await cancel(deps, run.id, "worker-M1.L1");
      expect(hints).toContain("worker-M1.L1: result had already read this record");
    } finally {
      spy.mockRestore();
    }
  });

  it("stops a live dispatch, records it once as cancelled, and marks the record read", async () => {
    const { run, deps } = setup({ hangMs: 30_000 });
    await dispatch(deps, input(run.id));
    const live = await waitFor(() => liveDispatches(run).find((d) => d.state === "running"));
    const { record } = await cancel(deps, run.id, "worker-M1.L1");
    expect(record.status).toBe("cancelled");
    expect(awaitsCollect(live.dir)).toBe(false);
    await watchersSettled();
    expect(readRecords(run).records).toHaveLength(1);
    expect(liveDispatches(run)).toEqual([]);
  });

  it("still records a cancel when git breaks mid-run, and says what it could not see", async () => {
    const { run, deps } = setup({ hangMs: 30_000 });
    await dispatch(deps, input(run.id));
    await waitFor(() => liveDispatches(run).find((d) => d.state === "running"));
    fakeGit("exit 128");
    const { record, hints } = await cancel(deps, run.id, "worker-M1.L1");
    expect(record).toMatchObject({ status: "cancelled", changedOwned: [], gitUnavailable: true });
    expect(hints).toHaveLength(2);
    expect(hints[0]).toBe("git-unavailable: changed files unknown");
    expect(hints[1]).toMatch(/^state\.md not refreshed: git status failed in /);
    await watchersSettled();
    expect(readRecords(run).records).toHaveLength(1);
  });

  it("stops a worker whose supervisor died, and records it as cancelled", async () => {
    const { run, deps } = setup({ hangMs: 60_000 });
    await dispatch(deps, input(run.id));
    const live = await waitFor(() => liveDispatches(run).find((d) => d.state === "running"));
    const proc = await waitFor(() => readProc(live.dir));
    process.kill(proc.supervisorPid, "SIGKILL");
    await waitFor(() => !isAlive(proc.supervisorPid, proc.supervisorStartTime));
    expect(isAlive(proc.pid, proc.startTime)).toBe(true);
    const started = Date.now();
    const { record } = await cancel(deps, run.id, "worker-M1.L1");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(record.status).toBe("cancelled");
    expect(isAlive(proc.pid, proc.startTime)).toBe(false);
    expect(readExit(live.dir)).toMatchObject({ reason: "cancelled", signal: "SIGTERM" });
    await watchersSettled();
    expect(readRecords(run).records).toHaveLength(1);
  }, 30_000);

  it("records a dispatch as lost once its supervisor died and then its worker ended", async () => {
    // the worker ends only when the test says so: after its supervisor is gone, never before
    const release = join(mkdtempSync(join(tmpdir(), "catherd-hold-")), "release");
    const { run, deps } = setup({ holdUntil: release });
    await dispatch(deps, input(run.id));
    const live = await waitFor(() => liveDispatches(run).find((d) => d.state === "running"));
    const proc = await waitFor(() => readProc(live.dir));
    process.kill(proc.supervisorPid, "SIGKILL");
    await waitFor(() => !isAlive(proc.supervisorPid, proc.supervisorStartTime));
    writeFileSync(release, "");
    await watchersSettled();
    const record = (await result(deps, { run: run.id, name: "worker-M1.L1" })).record;
    expect(record).toMatchObject({ status: "failed", exitCode: null, error: { message: "lost, exit null" } });
    expect(readExit(live.dir)).toBeNull();
    expect(readRecords(run).records).toHaveLength(1);
  }, 30_000);

  it("records SIGKILL when an orphaned worker outlasts its SIGTERM grace", async () => {
    orphanLimits.killGraceMs = 300;
    const { run, deps } = setup({});
    const worker = orphan("trap '' TERM; while :; do sleep 0.05; done");
    const dead = await deadProcess();
    const d = await fakeDispatch(
      run,
      {},
      {
        proc: {
          pid: worker.pid,
          startTime: processStartTime(worker.pid),
          supervisorPid: dead,
          supervisorStartTime: "gone",
        },
      },
    );
    const { record } = await cancel(deps, run.id, d.admit.name);
    expect(record.status).toBe("cancelled");
    expect(readExit(d.dir)).toMatchObject({ reason: "cancelled", signal: "SIGKILL" });
    expect(await worker.exited).toBe(137);
  });

  it("never signals an orphaned worker it cannot identify, and still records the cancel", async () => {
    const { run, deps } = setup({});
    const dead = await deadProcess();
    const unidentified = [
      // no start time: the pid alone may belong to another process by now
      (pid: number) => ({ startTime: null, pgid: pid }),
      // a process group that is not the one the worker leads
      (pid: number) => ({ startTime: processStartTime(pid), pgid: process.pid }),
    ];
    for (const who of unidentified) {
      const worker = orphan("sleep 30");
      const d = await fakeDispatch(run, { name: `worker-${worker.pid}` });
      writeJsonAtomic(dispatchPaths(d.dir).proc, {
        schema: 1,
        pid: worker.pid,
        ...who(worker.pid),
        supervisorPid: dead,
        supervisorStartTime: "gone",
        startedAt: d.admit.admittedAt,
      });
      const { record } = await cancel(deps, run.id, d.admit.name);
      expect(record.status).toBe("cancelled");
      expect(readExit(d.dir)).toMatchObject({ reason: "cancelled", signal: null });
      expect(isAlive(worker.pid, null)).toBe(true);
    }
  });

  it("refuses a name with no live dispatch", async () => {
    const { run, deps } = setup({});
    const e = await cancel(deps, run.id, "worker-M1.L1").catch((x: unknown) => x);
    expect(isCatherdError(e) && e.code).toBe("E_RUN_NOT_LIVE");
  });
});
```


#### Modify `test/services/helpers.ts`

```diff
--- a/test/services/helpers.ts
+++ b/test/services/helpers.ts
@@ -4,19 +4,14 @@ import { join } from "node:path";
 import { newDispatchId, parseRung } from "../../src/domain/ids.ts";
 import type { Access, ExitReason, RunRecord } from "../../src/domain/record.ts";
 import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
 import { processStartTime } from "../../src/infra/proc.ts";
 import { writeJsonAtomic } from "../../src/infra/store.ts";
-import {
-  dispatch,
-  type DispatchInput,
-  type Progress,
-  wait,
-  watchersSettled,
-} from "../../src/services/dispatch-service.ts";
+import { dispatch, type DispatchInput, watchersSettled } from "../../src/services/dispatch-service.ts";
 import { type Admit, admitPath, type Dispatch, roleDir, setLatest } from "../../src/services/dispatches.ts";
 import type { Deps, ProfilePort, ProfileView, RoutingPort } from "../../src/services/ports.ts";
+import { result } from "../../src/services/run-service.ts";
 import { createRun, type Run, runPaths } from "../../src/services/run-store.ts";
 import { tempRepo, withHome } from "../helpers.ts";
 
 export { makeRecord } from "../domain/make-record.ts";
 
@@ -98,11 +93,11 @@ export function fakeDeps(o: { view?: ProfileView; now?: () => number } = {}): De
     agentFor(_repo, r, rung) {
       const p = parseRung(rung);
       return p.backend === "claude" ? `catherd-${r}-${p.model}-${p.effort}` : null;
     },
   };
-  return { profiles, routing, version: "0.0.0-test", pollMs: 50, tickMs: 100, now: o.now ?? Date.now, view };
+  return { profiles, routing, version: "0.0.0-test", pollMs: 50, now: o.now ?? Date.now, view };
 }
 
 /** An isolated CATHERD_HOME, a fresh git repo and a run in it. Call `afterEach(snapshotEnv())` in the file. */
 export function freshRun(title = "t"): { repo: string; run: Run } {
   withHome();
@@ -135,35 +130,20 @@ export async function waitFor<T>(f: () => T | null | undefined | false, ms = 15_
     await Bun.sleep(25);
   }
 }
 
 /**
- * `dispatch`, then `wait` on that name until nothing of it runs (a failover stand-in included): what one
- * 0.x dispatch call did. The last record, and every hint on the way (the records' first, then the state
- * hints, once each).
+ * `dispatch`, then everything its watchers settle (a failover stand-in included), then `result`: what one
+ * 0.x dispatch call did. The last record, and every hint on the way (the records' first, then dispatch's
+ * state hints, once each).
  */
-export async function runRole(
-  deps: Deps,
-  i: DispatchInput,
-  onProgress?: Progress,
-): Promise<{ record: RunRecord; hints: string[] }> {
+export async function runRole(deps: Deps, i: DispatchInput): Promise<{ record: RunRecord; hints: string[] }> {
   const started = await dispatch(deps, i);
-  const hints: string[] = [];
-  const state = [...started.hints];
-  let record: RunRecord | null = null;
-  for (;;) {
-    const w = await wait(deps, { run: i.run, names: [i.name] }, onProgress);
-    for (const r of w.records) {
-      hints.push(...r.hints);
-      record = r.record;
-    }
-    for (const h of w.hints) if (!state.includes(h)) state.push(h);
-    if (!w.running.includes(i.name)) break;
-  }
   await watchersSettled();
-  if (!record) throw new Error(`no record for ${i.name}`);
-  return { record, hints: [...hints, ...state.filter((h) => !hints.includes(h))] };
+  const r = await result(deps, { run: i.run, name: i.name });
+  if (!r.record) throw new Error(`no record for ${i.name}`);
+  return { record: r.record, hints: [...r.hints, ...started.hints.filter((h) => !r.hints.includes(h))] };
 }
 
 interface FakeFiles {
   /** "self": this test process stands in for a live supervisor; "dead": both pids are gone */
   proc?:
@@ -171,11 +151,11 @@ interface FakeFiles {
     | "dead"
     | { pid: number; startTime: string | null; supervisorPid: number; supervisorStartTime: string | null };
   exit?: { code: number | null; signal: string | null; reason: ExitReason; endedAt: string };
   events?: string;
   reply?: string;
-  /** leave the marker `dispatch` leaves for `wait`, as any catherd server that launched it does */
+  /** leave the unread mark admission leaves, as any catherd server that admitted it does */
   collect?: boolean;
 }
 
 let deadPid = 0;
 /** A pid that belonged to a process which has exited. */
```


#### Modify `test/services/lanes-run.test.ts`

```diff
--- a/test/services/lanes-run.test.ts
+++ b/test/services/lanes-run.test.ts
@@ -1,12 +1,13 @@
 import { afterEach, describe, expect, it } from "bun:test";
 import { execFileSync } from "node:child_process";
-import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
+import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
 import { isCatherdError } from "../../src/domain/errors.ts";
-import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
+import { awaitsCollect, dispatchPaths } from "../../src/infra/dispatch-dir.ts";
+import { writeJsonAtomic } from "../../src/infra/store.ts";
 import { ask, climb, land, route } from "../../src/services/lane-service.ts";
 import {
   readKnowledge,
   readRunFile,
   recordAgentRun,
@@ -304,27 +305,74 @@ describe("run files, result and agent runs", () => {
     expect(await codeOf(() => readRunFile({ run: run.id, path: "nope.md" }))).toBe("E_IO_PATH");
     await setNext({ run: run.id, next: "paused: user asked" });
     expect(lastLine(runPaths(run.dir).state)).toBe("Next: paused: user asked");
   });
 
-  it("returns a live role's state, then its record and capped reply", async () => {
+  it("returns a live role's state, then its record, capped reply and hints", async () => {
     const { run } = freshRun();
     const deps = fakeDeps();
-    const d = await fakeDispatch(run, {}, { proc: "self" });
-    expect(result(deps, { run: run.id, name: "worker-M1.L1" })).toMatchObject({
+    const d = await fakeDispatch(run, {}, { proc: "self", collect: true });
+    expect(await result(deps, { run: run.id, name: "worker-M1.L1" })).toMatchObject({
       state: "running",
       record: null,
+      hints: [],
     });
+    // a live role's record is not there yet: nothing is marked read
+    expect(awaitsCollect(d.dir)).toBe(true);
     writeFileSync(dispatchPaths(d.dir).reply, `${"line\n".repeat(300)}STATUS: complete — ok`);
-    await appendRecord(run, makeRecord({ dispatchId: d.admit.dispatchId }));
-    const r = result(deps, { run: run.id, name: "worker-M1.L1" });
+    await appendRecord(run, makeRecord({ dispatchId: d.admit.dispatchId, violations: ["src/x.ts"] }));
+    const r = await result(deps, { run: run.id, name: "worker-M1.L1" });
     expect(r.state).toBe("finished");
     expect(r.record?.dispatchId).toBe(d.admit.dispatchId);
     expect(r.reply).toContain(`[capped: the full reply is ${r.replyPath}]`);
+    expect(r.hints).toContain("violation: src/x.ts");
     expect(await codeOf(() => result(deps, { run: run.id, name: "nobody" }))).toBe("E_RUN_NOT_FOUND");
   });
 
+  it("marks a finished record read, once, and reads it again unchanged (spec §3.7)", async () => {
+    const { run } = freshRun();
+    const deps = fakeDeps();
+    const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };
+    const d = await fakeDispatch(run, {}, { proc: "dead", exit, collect: true });
+    await appendRecord(run, makeRecord({ dispatchId: d.admit.dispatchId }));
+    expect(awaitsCollect(d.dir)).toBe(true);
+    const first = await result(deps, { run: run.id, name: "worker-M1.L1" });
+    expect(awaitsCollect(d.dir)).toBe(false);
+    expect(existsSync(dispatchPaths(d.dir).lease)).toBe(false);
+    const again = await result(deps, { run: run.id, name: "worker-M1.L1" });
+    expect(again.record).toEqual(first.record);
+    expect(again.hints).toEqual(first.hints);
+  });
+
+  it("marks an earlier unread record of the name read with the latest, its hints first", async () => {
+    const { run } = freshRun();
+    const deps = fakeDeps();
+    const exit = { code: 1, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };
+    const limited = await fakeDispatch(run, {}, { proc: "dead", exit, collect: true });
+    await appendRecord(run, makeRecord({ dispatchId: limited.admit.dispatchId, status: "limit" }));
+    writeJsonAtomic(dispatchPaths(limited.dir).failover, {
+      schema: 1,
+      at: new Date().toISOString(),
+      standIn: null,
+      hints: ["limit: codex:gpt-6-sol#medium hit a usage limit; failed over to codex:gpt-6-sol#high"],
+      pause: null,
+    });
+    const stand = await fakeDispatch(
+      run,
+      { rung: "codex:gpt-6-sol#high", failoverFrom: "codex:gpt-6-sol#medium" },
+      { proc: "dead", exit: { ...exit, code: 0 }, collect: true },
+    );
+    await appendRecord(run, makeRecord({ dispatchId: stand.admit.dispatchId, violations: ["src/y.ts"] }));
+    const r = await result(deps, { run: run.id, name: "worker-M1.L1" });
+    expect(r.record?.dispatchId).toBe(stand.admit.dispatchId);
+    expect(r.hints).toEqual([
+      "limit: codex:gpt-6-sol#medium hit a usage limit; failed over to codex:gpt-6-sol#high",
+      "violation: src/y.ts",
+    ]);
+    expect([limited, stand].map((x) => awaitsCollect(x.dir))).toEqual([false, false]);
+  });
+
   it("records a native subagent run, and only for a claude rung", async () => {
     const { run } = freshRun();
     const deps = fakeDeps();
     const row = recordAgentRun(deps, {
       run: run.id,
```


#### Modify `test/skills.test.ts`

```diff
--- a/test/skills.test.ts
+++ b/test/skills.test.ts
@@ -32,11 +32,10 @@ describe("orchestrator skill", () => {
     for (const core of [
       "run_start",
       "route",
       "preflight",
       "dispatch",
-      "wait",
       "cancel",
       "record_agent_run",
       "climb",
       "ask",
       "land",
@@ -46,17 +45,21 @@ describe("orchestrator skill", () => {
     ]) {
       expect(used).toContain(core);
     }
   });
 
-  it("dispatches roles one after another, then waits: never the 0.x claim that dispatches run at once (plan 9)", () => {
+  it("dispatches roles one after another, then ends its turn for catherd's messages (plan 10)", () => {
     const md = skill("catherd");
     const waiting = md.slice(md.indexOf("## Waiting"), md.indexOf("\n## ", md.indexOf("## Waiting") + 1));
     expect(waiting).toContain("one after another");
-    expect(waiting).toContain("`wait(run)`");
-    expect(waiting).toContain("A single role is `dispatch`, then `wait`.");
-    expect(waiting).toMatch(/`dispatch` and `wait` from your main thread only/);
+    expect(waiting).toContain("write one status line and end your turn");
+    expect(waiting).toContain('`<cross-session-message from-name="catherd">`');
+    expect(waiting).toContain("call `result(run, name)` for the record you act on");
+    expect(waiting).toContain("A single role is `dispatch`, then end your turn.");
+    expect(waiting).toContain("never the user's approval of anything");
+    expect(waiting).toContain("Never `sleep`, loop or poll.");
+    expect(md).not.toMatch(/`wait`|`wait\(/);
     for (const old of [
       "Launch every independent role in the same message",
       "Each dispatch backgrounds by itself",
       "in one message, each at its rung",
       "All lanes go at once",
```


- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/services/dispatch.test.ts test/services/failover-cancel.test.ts test/services/lanes-run.test.ts`. Expected: FAIL — `Export named 'settle' not found` (and `settledHooks`), then `result(...)` has no `hints` and does not mark a record read.

- [ ] **Step 3: Settle, read, and remove `wait` (source, skill and docs)**

#### Modify `src/entry/deps.ts`

```diff
--- a/src/entry/deps.ts
+++ b/src/entry/deps.ts
@@ -8,9 +8,8 @@ export function defaultDeps(): Deps {
   return {
     profiles: profileService(),
     routing: routingService(),
     version: VERSION,
     pollMs: 250,
-    tickMs: Number(process.env.CATHERD_TICK_MS) || 30_000,
     now: Date.now,
   };
 }
```


#### Modify `src/entry/mcp/dispatch-tools.ts`

```diff
--- a/src/entry/mcp/dispatch-tools.ts
+++ b/src/entry/mcp/dispatch-tools.ts
@@ -1,40 +1,19 @@
 import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 import { z } from "zod";
 import { ID_PATTERN } from "../../domain/ids.ts";
 import { ROLES } from "../../domain/roles.ts";
-import { cancel, dispatch, type Progress, wait } from "../../services/dispatch-service.ts";
+import { cancel, dispatch } from "../../services/dispatch-service.ts";
 import type { Deps } from "../../services/ports.ts";
 import { handle } from "./result.ts";
 
-type Notify = (n: {
-  method: "notifications/progress";
-  params: { progressToken: string | number; progress: number; message: string };
-}) => Promise<void>;
-
-/** Progress notifications that can never fail a wait: the client may be gone (audit C8). */
-export function progressTo(token: string | number | undefined, send: Notify): Progress | undefined {
-  if (token === undefined) return undefined;
-  let n = 0;
-  return (message) => {
-    try {
-      send({
-        method: "notifications/progress",
-        params: { progressToken: token, progress: ++n, message },
-      }).catch(() => {}); // the client is gone: progress is best effort
-    } catch {
-      // the transport is closed
-    }
-  };
-}
-
 export function registerDispatchTools(server: McpServer, deps: Deps): void {
   server.registerTool(
     "dispatch",
     {
       description:
-        "Start one role on a process backend (codex, claude-code, opencode) and return at launch, in about a second, with { dispatched: { name, role, rung, dispatchId, admittedAt }, hints }; the role runs on, and wait(run) collects its record. Dispatch every independent role one after another, then call wait. The brief is the text itself. With lane, the lane file's Owns: paths guard against overlapping lanes. thread resumes that role's thread for its own fix round. Refused with a structured error (E_ADMIT_*, E_RUN_BUDGET, E_BACKEND_*) before anything starts. Call it from the main thread.",
+        "Start one role on a process backend (codex, claude-code, opencode) and return at launch, in about a second, with { dispatched: { name, role, rung, dispatchId, admittedAt }, hints }; the role runs on. When it finishes, catherd sends this session a <cross-session-message from-name=\"catherd\"> naming the run, the role and its status, and result(run, name) reads the record. Dispatch every independent role one after another, then end your turn. The brief is the text itself. With lane, the lane file's Owns: paths guard against overlapping lanes. thread resumes that role's thread for its own fix round. Refused with a structured error (E_ADMIT_*, E_RUN_BUDGET, E_BACKEND_*) before anything starts. Call it from the main thread.",
       inputSchema: {
         run: z.string(),
         role: z.enum(ROLES),
         name: z.string().regex(ID_PATTERN),
         brief: z.string().min(1),
@@ -45,38 +24,15 @@ export function registerDispatchTools(server: McpServer, deps: Deps): void {
       },
     },
     (a) => handle(() => dispatch(deps, a)),
   );
 
-  server.registerTool(
-    "wait",
-    {
-      description:
-        "Block until at least one of the run's uncollected dispatches has finished (only those in names, when given; every one of them with all: true), reporting progress meanwhile, and return { records, started, running, hints }. records holds each finished role's { record, hints }, in the order they finished, each returned by one wait only; a role that hit a usage limit has its failover stand-in launched, listed in started. running names every uncollected role this call did not return, still running or already finished, stand-ins included: act on the records, then wait again while running is not empty. Returns at once, with a hint, when nothing is uncollected. Call it from the main thread.",
-      inputSchema: {
-        run: z.string(),
-        names: z.array(z.string().regex(ID_PATTERN)).optional(),
-        all: z.boolean().optional(),
-      },
-    },
-    (a, extra) =>
-      handle(() =>
-        wait(
-          deps,
-          a,
-          progressTo(extra._meta?.progressToken, (n) => extra.sendNotification(n)),
-          // a wait its caller cancelled collects nothing: the record would go to no one
-          extra.signal,
-        ),
-      ),
-  );
-
   server.registerTool(
     "cancel",
     {
       description:
-        "Stop a live dispatch (interrupt, then SIGTERM, then SIGKILL) and return its record, marked cancelled, and hints.",
+        "Stop a live dispatch (interrupt, then SIGTERM, then SIGKILL) and return its record, marked cancelled and read, and hints.",
       inputSchema: { run: z.string(), name: z.string().regex(ID_PATTERN) },
     },
     (a) => handle(() => cancel(deps, a.run, a.name)),
   );
 }
```


#### Modify `src/entry/mcp/run-tools.ts`

```diff
--- a/src/entry/mcp/run-tools.ts
+++ b/src/entry/mcp/run-tools.ts
@@ -66,11 +66,12 @@ export function registerRunTools(server: McpServer, deps: Deps): void {
   );
 
   server.registerTool(
     "result",
     {
-      description: "A role's latest dispatch: its state, its record once finished, and its capped reply.",
+      description:
+        "A role's latest dispatch: its state, its record once finished, its capped reply, and hints (climb, violation, failed, limit and failover lines). Reading a finished record marks it read: catherd's messages announce records, and this is how you read one.",
       inputSchema: { run: z.string(), name: z.string().regex(ID_PATTERN) },
     },
     (a) => handle(() => result(deps, a)),
   );
 
```


#### Modify `src/infra/dispatch-dir.ts`

```diff
--- a/src/infra/dispatch-dir.ts
+++ b/src/infra/dispatch-dir.ts
@@ -29,15 +29,17 @@ export function dispatchPaths(dir: string) {
     exit: join(dir, "exit.json"),
     claim: join(dir, "claim"),
     cancel: join(dir, "cancel"),
     /** held by the one supervisor of this dispatch for its lifetime (filelock, dead holders reclaimed) */
     supervisorLock: join(dir, "supervisor.lock"),
-    /** exists from launch until a `wait` hands the dispatch's record to the orchestrator */
+    /** exists from admission until the orchestrator reads the record (`result`, `cancel`): "not yet read" */
     collect: join(dir, "collect"),
-    /** while a `wait` hands the record back: names that wait's process, so a crash leaves it reclaimable */
+    /** while a reader takes the record: names that reader's process, so a crash leaves it reclaimable */
     lease: join(dir, "collect.lease"),
     supervisorLog: join(dir, "supervisor.log"),
+    /** what failover did for this limited dispatch, written once under `failover.lock` (plan 10) */
+    failover: join(dir, "failover.json"),
   };
 }
 
 /**
  * Exclusive create: the first caller finalizes; every later caller reads the record it wrote. The claim
@@ -79,11 +81,11 @@ export function readClaimant(dir: string): { pid: number; startTime: string | nu
   } catch {
     return null;
   }
 }
 
-/** Marks a dispatch as one a `wait` is to hand back; written before its launch. */
+/** Marks a dispatch's record as not yet read; written before its launch. */
 export function markForCollect(dir: string): void {
   writeFileSync(dispatchPaths(dir).collect, "", { mode: PRIVATE_FILE });
 }
 
 const errno = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;
@@ -128,12 +130,12 @@ function leaseDead(file: string): boolean {
   const who = leaseOwner(file);
   return who ? !isAlive(who.pid, who.startTime) : olderThan(file, OWNERLESS_STALE_MS);
 }
 
 /**
- * Whether a `wait` still has this dispatch's record to hand back: it has the mark, or a lease whose
- * collector died before handing the record back.
+ * Whether this dispatch's record is still unread: it has the mark, or a lease whose reader died before the
+ * record went out.
  */
 export function awaitsCollect(dir: string): boolean {
   const p = dispatchPaths(dir);
   return existsSync(p.collect) || leaseDead(p.lease);
 }
@@ -186,11 +188,11 @@ async function reviveDeadLease(dir: string): Promise<void> {
   });
 }
 
 /**
  * Collects the dispatch as a lease naming this process: true for the one caller that got it, so each
- * record reaches one `wait` only. The common path takes no lock: the lease is created exclusively, and
+ * record is read (marked read) once. The common path takes no lock: the lease is created exclusively, and
  * the record is this caller's only if the mark still exists then; the mark goes only once the lease
  * exists. A dead collector's lease is first turned back into the mark (`reviveDeadLease`), then
  * collected the same way; a live collector's is never taken. The caller ends the lease with `endCollect`
  * once the record has gone out, or turns it back into the mark with `putBackCollect`.
  */
```


#### Modify `src/services/admission.ts`

```diff
--- a/src/services/admission.ts
+++ b/src/services/admission.ts
@@ -177,11 +177,11 @@ export async function admit(deps: Deps, run: Run, i: AdmitInput): Promise<{ d: D
         `${i.name} is already ${doing(same)} on ${same.admit.rung}`,
         {
           fix:
             same.state === "finished"
               ? `its record could not be written; see ${same.dir}, and retry`
-              : `wait for it, or cancel(run, "${i.name}")`,
+              : `its record is announced when it finishes; or cancel(run, "${i.name}")`,
         },
       );
     for (const d of pending) {
       const shared = overlaps(owns, d.admit.owns);
       if (shared.length)
@@ -242,11 +242,11 @@ export async function admit(deps: Deps, run: Run, i: AdmitInput): Promise<{ d: D
         pollMs: deps.pollMs,
       },
       { mode: 0o600 },
     );
     // the collect mark before admit.json: no admitted dispatch ever exists without it, so a process that
-    // dies before launching it still leaves a record (lost, once its start grace passes) for a `wait`
+    // dies before launching it still leaves a record (lost, once its start grace passes), unread
     markForCollect(dir);
     writeJsonAtomic(admitPath(dir), admitted);
     setLatest(run, i.name, id);
     return { d: { dir, admit: admitted }, specPath: p.spec };
   });
```


#### Replace the whole of `src/services/dispatch-service.ts` with

```ts
import { existsSync, readFileSync } from "node:fs";
import { CatherdError, errorMessage, isCatherdError } from "../domain/errors.ts";
import { assertId, parseRung } from "../domain/ids.ts";
import type { RunRecord } from "../domain/record.ts";
import type { Role } from "../domain/roles.ts";
import {
  awaitsCollect,
  dispatchPaths,
  endCollect,
  readExit,
  requestCancel,
  supervisorAlive,
  tryCollect,
} from "../infra/dispatch-dir.ts";
import { withFileLock } from "../infra/filelock.ts";
import { log } from "../infra/log.ts";
import { isAlive, isSurelyAlive, killGroup } from "../infra/proc.ts";
import { writeJsonAtomic } from "../infra/store.ts";
import { admit, KILL_GRACE_MS, laneFile, launch } from "./admission.ts";
import { standInFor } from "./backends.ts";
import {
  type Dispatch,
  dispatchState,
  type FailoverFile,
  launchPath,
  listDispatches,
  liveDispatches,
  readFailover,
  readProc,
  recordHints,
} from "./dispatches.ts";
import { finalizeDispatch, waitForFinish } from "./finalize.ts";
import type { Deps } from "./ports.ts";
import { findRun, readRecords, type Run } from "./run-store.ts";
import { type NotesPatch, refreshState } from "./state.ts";

export interface DispatchInput {
  run: string;
  role: Role;
  name: string;
  brief: string;
  rung: string;
  thread?: string;
  lane?: string;
  next?: string;
}

/** One finished dispatch: its record and what to do next. */
export interface DispatchResult {
  record: RunRecord;
  hints: string[];
}

/** A dispatch that has been admitted and launched. */
export interface Dispatched {
  name: string;
  role: Role;
  rung: string;
  dispatchId: string;
  admittedAt: string;
}

export interface DispatchStarted {
  dispatched: Dispatched;
  hints: string[];
}

/**
 * A finalized dispatch once catherd has acted on it (spec §3.4): its record, its hints, and for a usage limit
 * what failover did: the stand-in it launched, or the pause it wrote.
 */
export interface Settled {
  run: Run;
  d: Dispatch;
  record: RunRecord;
  hints: string[];
  started: Dispatched | null;
  pause: string | null;
  /** state.md's refresh failed: its hint (the notes are kept in state.json) */
  stateHints: string[];
}

/**
 * Called with every dispatch this process settles, once each (the notifier, services/notifier.ts, is one). A
 * hook that throws is logged and never stops the others.
 */
export const settledHooks = new Set<(s: Settled) => void | Promise<void>>();

const dispatchedOf = (d: Dispatch): Dispatched => ({
  name: d.admit.name,
  role: d.admit.role,
  rung: d.admit.rung,
  dispatchId: d.admit.dispatchId,
  admittedAt: d.admit.admittedAt,
});

/** Refreshes state.md (spec §4.5 notes kept on a git failure); a refresh that fails adds its hint once. */
async function refresh(run: Run, change: NotesPatch, hints: string[]): Promise<void> {
  for (const h of (await refreshState(run, change)).hints) if (!hints.includes(h)) hints.push(h);
}

/** How a dispatch's supervisor is started; tests replace it to make a launch fail. */
export const launcher = { launch };

/**
 * Starts an admitted dispatch's supervisor. Admission already left its collect mark, and a launch that
 * throws keeps it: the dispatch is recorded as lost once its start grace passes, and `result` reads that
 * record, as the error says.
 */
function start(d: Dispatch, specPath: string): void {
  try {
    launcher.launch(d, specPath);
  } catch (e) {
    throw new CatherdError("E_IO_UNEXPECTED", `could not launch ${d.admit.name}: ${errorMessage(e)}`, {
      fix: `result(run, "${d.admit.name}") reads its record, lost, once its start grace passes (30 s); then dispatch it again`,
    });
  }
}

/** The watchers this process started, each until its dispatch is settled. */
const watchers = new Set<Promise<void>>();

/** Settles once every watcher has: tests await it so none outlives its test. */
export async function watchersSettled(): Promise<void> {
  while (watchers.size > 0) await Promise.all(watchers);
}

/**
 * Finalizes a dispatch as soon as it exits and settles it (failover, state.md, the settled hooks), so its
 * after-snapshot holds only its own writes and the live list and the spend stay true. Its errors are logged.
 */
export function watch(deps: Deps, run: Run, d: Dispatch): void {
  const w = (async () => {
    await waitForFinish(d, { pollMs: deps.pollMs, now: deps.now });
    const s = await settle(deps, run, d, await finalizeDispatch(run, d));
    if (s.stateHints[0]) log("warn", "dispatch", { run: run.id, name: d.admit.name, hint: s.stateHints[0] });
  })()
    .catch((e: unknown) =>
      log("warn", "dispatch", { run: run.id, name: d.admit.name, error: errorMessage(e) }),
    )
    .finally(() => watchers.delete(w));
  watchers.add(w);
}

/**
 * Spec §4.4, plan 9 ruling 1: admit and launch one role, start its watcher, then refresh state.md with
 * `next` (after the launch, so nothing delays it). Returns at once; catherd announces the record (spec §3).
 */
export async function dispatch(deps: Deps, i: DispatchInput): Promise<DispatchStarted> {
  const run = findRun(i.run);
  const { d, specPath } = await admit(deps, run, {
    role: i.role,
    name: i.name,
    brief: i.brief,
    rung: i.rung,
    thread: i.thread ?? null,
    lane: i.lane ?? null,
    failoverFrom: null,
  });
  try {
    start(d, specPath);
  } finally {
    // a launch that failed is still watched: its record (lost, after the start grace) is announced
    watch(deps, run, d);
  }
  const hints: string[] = [];
  await refresh(run, i.next ? { next: i.next } : {}, hints);
  return { dispatched: dispatchedOf(d), hints };
}

/** A failover's outcome before it is written down. */
interface Outcome {
  hints: string[];
  started: Dispatched | null;
  pause: string | null;
}

/**
 * Spec §3.4 (plan 10): what catherd does once a dispatch is finalized, whoever finalized it (its watcher,
 * reconcile after a restart): a usage limit fails over (once per limited dispatch, under a lock, its outcome
 * written to failover.json so a second settle or a restarted server reuses it), state.md is refreshed with the
 * pause a limit calls for (a refresh that fails comes back in `stateHints`), and every settled hook runs. Never
 * throws for a hook.
 */
export async function settle(deps: Deps, run: Run, d: Dispatch, record: RunRecord): Promise<Settled> {
  let o: Outcome = { hints: recordHints(run, d, record), started: null, pause: null };
  if (record.status === "limit") {
    try {
      o = await withFileLock(dispatchPaths(d.dir).failover, () => failoverOnce(deps, run, d, record), {
        timeoutMs: 120_000,
      });
    } catch (e) {
      o = {
        hints: [...o.hints, `failover: ${errorMessage(e)}`],
        started: null,
        pause: `paused: ${record.backend} usage limit; resume when the user says so`,
      };
    }
  }
  const stateHints: string[] = [];
  await refresh(run, o.pause ? { next: o.pause } : {}, stateHints);
  const s: Settled = { run, d, record, hints: o.hints, started: o.started, pause: o.pause, stateHints };
  for (const hook of settledHooks) {
    try {
      await hook(s);
    } catch (e) {
      log("warn", "settle", { run: run.id, name: d.admit.name, error: errorMessage(e) });
    }
  }
  return s;
}

/** Under the failover lock: the outcome already written, else a failover run now and written down. */
async function failoverOnce(deps: Deps, run: Run, d: Dispatch, record: RunRecord): Promise<Outcome> {
  const done = readFailover(d.dir);
  if (done) {
    const next = done.standIn
      ? listDispatches(run).find((x) => x.admit.dispatchId === done.standIn?.dispatchId)
      : undefined;
    return { hints: done.hints, started: next ? dispatchedOf(next) : null, pause: done.pause };
  }
  let o: Outcome;
  try {
    o = await failover(deps, run, d, record);
  } catch (e) {
    o = {
      hints: [...recordHints(run, d, record), `failover: ${errorMessage(e)}`],
      started: null,
      pause: `paused: ${record.backend} usage limit; resume when the user says so`,
    };
  }
  const file: FailoverFile = {
    schema: 1,
    at: new Date(deps.now()).toISOString(),
    standIn: o.started ? { dispatchId: o.started.dispatchId, rung: o.started.rung } : null,
    hints: o.hints,
    pause: o.pause,
  };
  writeJsonAtomic(dispatchPaths(d.dir).failover, file);
  return o;
}

/**
 * Whether a dispatch has concrete launch evidence: a live supervisor holding its lock (taken first thing),
 * launch.json (written by `launch` right after the spawn), proc.json (written by the supervisor once its
 * worker runs) or exit.json. Not the collect mark: admission writes the mark before any launch.
 */
function launched(d: Dispatch): boolean {
  return (
    supervisorAlive(d.dir) ||
    existsSync(launchPath(d.dir)) ||
    readProc(d.dir) !== null ||
    readExit(d.dir) !== null
  );
}

const recordOf = (run: Run, d: Dispatch): boolean =>
  readRecords(run).records.some((r) => r.dispatchId === d.admit.dispatchId);

/**
 * The stand-in's brief (spec §4.5, audit C4). A fresh round reruns its own brief; a fix round hands
 * over the lane file and the fix brief by path, since the stand-in cannot resume the old thread.
 */
function standInBrief(run: Run, d: Dispatch): string {
  const own = dispatchPaths(d.dir).brief;
  if (d.admit.thread === null) return readFileSync(own, "utf8");
  return [
    `You take over ${d.admit.name} from ${d.admit.rung}, which hit a usage limit. You start on a fresh thread, so read these first:`,
    ...(d.admit.lane ? [`- the lane file: ${laneFile(run, d.admit.lane)}`] : []),
    `- the fix brief the previous thread was given: ${own}`,
    "The work so far is in the tree. Do what the fix brief asks.",
  ].join("\n");
}

/**
 * Spec §4.5: on a limit, launch the rung's stand-in on a fresh thread, through admission again (budget
 * included), without awaiting it. A stand-in that hits a limit too pauses the run. A stand-in already
 * admitted for this record (by a settle that died before writing failover.json) is reused, never launched
 * twice.
 */
async function failover(deps: Deps, run: Run, d: Dispatch, limited: RunRecord): Promise<Outcome> {
  const hints = recordHints(run, d, limited);
  if (d.admit.failoverFrom !== null)
    return {
      hints,
      started: null,
      pause: `paused: ${limited.backend} usage limit on ${limited.rung} and on ${d.admit.failoverFrom}`,
    };
  const paused = `paused: ${limited.backend} usage limit; resume when the user says so`;
  const failedOver = (standIn: string, next: Dispatch): Outcome => ({
    hints: [
      `limit: ${limited.rung} hit a usage limit; failed over to ${standIn}`,
      // the stand-in's before-snapshot already holds the limited run's writes: surface them here
      ...hints.filter((h) => /^(violation|git-unavailable):/.test(h)),
    ],
    started: dispatchedOf(next),
    pause: null,
  });
  // tied to this limited dispatch's id: a later dispatch of the same name, rung and limit is not its stand-in
  const already = listDispatches(run)
    .filter((x) => x.admit.failoverOf === d.admit.dispatchId)
    .at(-1);
  if (already && launched(already)) return failedOver(already.admit.rung, already);
  if (already && !recordOf(run, already) && dispatchState(already, deps.now()) === "starting") {
    // Admitted by a settle that died before launching it: launch it now, never report it unlaunched. Only
    // the holder of the failover lock launches a stand-in, and we hold it now, so that settle is dead. If
    // it died after spawning a supervisor that has not taken the dispatch's lock yet, the second supervisor
    // started here and that one race for the lock: exactly one runs the worker, the other exits touching
    // nothing (supervisor.ts), so no worker ever runs twice.
    start(already, dispatchPaths(already.dir).spec);
    watch(deps, run, already);
    return failedOver(already.admit.rung, already);
  }
  // else that stand-in never ran and is over (recorded as lost, or past its start grace): admit a new one
  const standIn = standInFor(deps.profiles.forRepo(run.meta.repo).failover, limited.rung, run.meta.repo);
  if (!standIn) return { hints, started: null, pause: paused };
  if (parseRung(standIn).backend === "claude") {
    const agent = deps.profiles.agentFor(run.meta.repo, d.admit.role, standIn);
    return {
      hints: [
        ...hints,
        `failover: run ${d.admit.name} as Agent(subagent_type: "${agent}"), standing in for ${limited.rung}`,
      ],
      started: null,
      pause: null,
    };
  }
  let next: Awaited<ReturnType<typeof admit>>;
  try {
    next = await admit(deps, run, {
      role: d.admit.role,
      name: d.admit.name,
      brief: standInBrief(run, d),
      rung: standIn,
      thread: null,
      lane: d.admit.lane,
      failoverFrom: limited.rung,
      failoverOf: d.admit.dispatchId,
    });
  } catch (e) {
    if (!isCatherdError(e)) throw e;
    return {
      hints: [...hints, `failover: ${standIn} refused: ${e.code} ${e.message}`],
      started: null,
      pause: paused,
    };
  }
  start(next.d, next.specPath);
  watch(deps, run, next.d);
  return failedOver(standIn, next.d);
}

/**
 * The finished dispatches of a run that still await catherd's action after a restart: a usage limit recorded,
 * not yet failed over (no failover.json) and not yet read. Reconcile settles them.
 */
export const unsettledLimits = (run: Run): { d: Dispatch; record: RunRecord }[] => {
  const records = new Map(readRecords(run).records.map((r) => [r.dispatchId, r]));
  return listDispatches(run).flatMap((d) => {
    const record = records.get(d.admit.dispatchId);
    return record?.status === "limit" && !readFailover(d.dir) && awaitsCollect(d.dir) ? [{ d, record }] : [];
  });
};

/** How long an orphaned worker gets between SIGTERM and SIGKILL; tests shorten it. */
export const orphanLimits = { killGraceMs: KILL_GRACE_MS };

/**
 * A worker whose supervisor died has no one to read the cancel file: stop its group here (SIGTERM, then
 * SIGKILL after the grace), each signal guarded by the worker's pid and start time, and write the
 * exit.json the supervisor would have, with the signal that ended it. A worker catherd cannot identify
 * (no start time, or a proc.json whose pgid is not the worker's own pid) is never signalled: its pid may
 * belong to someone else by now, so the dispatch is only recorded as cancelled. A finalizer that sees the
 * worker gone first reads the cancel file instead (finalize.ts). Nothing happens while the supervisor
 * lives: it acts on the cancel file itself.
 */
async function stopOrphan(deps: Deps, d: Dispatch): Promise<void> {
  const proc = readProc(d.dir);
  if (!proc || readExit(d.dir) || isAlive(proc.supervisorPid, proc.supervisorStartTime)) return;
  const worker = () => isAlive(proc.pid, proc.startTime);
  // a signal needs the start time read back exactly: a pid whose start time cannot be read now may be reused
  const surely = () => isSurelyAlive(proc.pid, proc.startTime);
  if (!worker()) return;
  let signal: NodeJS.Signals | null = null;
  if (proc.startTime !== null && (proc.pgid === undefined || proc.pgid === proc.pid)) {
    if (surely()) {
      signal = "SIGTERM";
      killGroup(proc.pid, signal);
    }
    const end = Date.now() + orphanLimits.killGraceMs;
    while (signal && Date.now() < end && worker()) await Bun.sleep(deps.pollMs);
    if (signal && worker() && surely()) {
      signal = "SIGKILL";
      killGroup(proc.pid, signal);
    }
  }
  writeJsonAtomic(dispatchPaths(d.dir).exit, {
    schema: 1,
    code: null,
    signal,
    reason: "cancelled",
    endedAt: new Date().toISOString(),
  });
}

/**
 * Spec §4.7: stop a live dispatch (interrupt, SIGTERM, SIGKILL) and record it as cancelled. The record it
 * returns is read: `peek` no longer lists it as unread.
 */
export async function cancel(deps: Deps, runId: string, name: string): Promise<DispatchResult> {
  const run = findRun(runId);
  assertId("role name", name);
  const live = liveDispatches(run, deps.now()).find((d) => d.admit.name === name);
  if (!live)
    throw new CatherdError("E_RUN_NOT_LIVE", `${name} has no live dispatch`, {
      fix: "status(run) lists the live ones",
    });
  requestCancel(live.dir);
  await stopOrphan(deps, live);
  await waitForFinish(live, { pollMs: deps.pollMs, now: deps.now });
  const record = await finalizeDispatch(run, live);
  const mine = await tryCollect(live.dir);
  // cancel returns at once, so its lease ends at once
  if (mine) endCollect(live.dir);
  const also = mine ? [] : [`${name}: result had already read this record`];
  const { hints } = await refreshState(run);
  return { record, hints: [...recordHints(run, live, record), ...also, ...hints] };
}
```


#### Modify `src/services/dispatches.ts`

```diff
--- a/src/services/dispatches.ts
+++ b/src/services/dispatches.ts
@@ -1,8 +1,9 @@
 import { existsSync, readdirSync, readFileSync } from "node:fs";
-import { join } from "node:path";
+import { join, relative } from "node:path";
 import { z } from "zod";
+import { dispatchHints } from "../domain/hints.ts";
 import { ACCESS, type RunRecord } from "../domain/record.ts";
 import { ROLES } from "../domain/roles.ts";
 import { dispatchPaths, readExit, supervisorAlive } from "../infra/dispatch-dir.ts";
 import { isAlive } from "../infra/proc.ts";
 import { readVersioned, writeTextAtomic } from "../infra/store.ts";
@@ -141,5 +142,31 @@ export function latestDispatch(run: Run, name: string): Dispatch | null {
   } catch {
     // no pointer yet
   }
   return all.find((d) => d.admit.dispatchId === id) ?? all.at(-1) ?? null;
 }
+
+/** failover.json: what failover did for a limited dispatch (plan 10), written once, under its lock. */
+const FailoverSchema = z.looseObject({
+  schema: z.literal(1),
+  at: z.string(),
+  /** the stand-in it launched, if any */
+  standIn: z.object({ dispatchId: z.string(), rung: z.string() }).nullable(),
+  /** the limited record's hints, as failover left them ("limit: … failed over to …", "failover: …") */
+  hints: z.array(z.string()),
+  /** the pause it wrote to state.md, if any */
+  pause: z.string().nullable(),
+});
+export type FailoverFile = z.infer<typeof FailoverSchema>;
+
+export function readFailover(dir: string): FailoverFile | null {
+  try {
+    return readVersioned(dispatchPaths(dir).failover, FailoverSchema, 1);
+  } catch {
+    return null;
+  }
+}
+
+/** Spec §4.4: what to do next about one finished record; for a usage limit, the failover's own hints. */
+export function recordHints(run: Run, d: Dispatch, r: RunRecord): string[] {
+  return readFailover(d.dir)?.hints ?? dispatchHints(r, d.admit.owns, relative(run.dir, d.dir));
+}
```


#### Modify `src/services/finalize.ts`

```diff
--- a/src/services/finalize.ts
+++ b/src/services/finalize.ts
@@ -250,11 +250,11 @@ function recordHarness(run: Run, d: Dispatch, r: RunRecord): void {
  * Spec §3.3: the first finalizer claims the dispatch and writes its record; any other waits for that
  * record and returns it. If the claimer died before appending, the late finalizer appends instead;
  * appendRecord's per-dispatch dedupe keeps that to one record either way (audit C2). A claimer that throws
  * releases its claim.
  *
- * In this process, a second finalizer (a `wait` beside the dispatch's watcher) joins the first one's
+ * In this process, a second finalizer (`cancel` beside the dispatch's watcher) joins the first one's
  * promise. Across processes it waits for the claimant's record, and takes over only once the claim is
  * stale (claimant dead, or past its settle window): never while a live claimant may still be settling.
  */
 export function finalizeDispatch(run: Run, d: Dispatch): Promise<RunRecord> {
   const id = d.admit.dispatchId;
@@ -319,11 +319,11 @@ async function finalizeOnce(run: Run, d: Dispatch): Promise<RunRecord> {
   }
   if (saved === mine) recordHarness(run, d, mine);
   return saved;
 }
 
-/** The last event of a running dispatch worth showing in a progress line, if any. */
+/** The last event of a running dispatch worth showing (peek, the runs page), if any. */
 export function lastEvent(d: Dispatch): string | null {
   const a = adapterFor(d.admit.backend);
   const line = nonBlankLines(dispatchPaths(d.dir).events).at(-1);
   if (!a || !line) return null;
   try {
@@ -331,29 +331,9 @@ export function lastEvent(d: Dispatch): string | null {
   } catch {
     return null;
   }
 }
 
-/** Waits until the dispatch finishes, calling `onTick` every `tickMs`; a throwing onTick never ends the wait. */
-export async function waitForFinish(
-  d: Dispatch,
-  o: {
-    pollMs: number;
-    tickMs: number;
-    now: () => number;
-    onTick?: (secs: number, lastEvent: string | null) => void;
-  },
-): Promise<void> {
-  const started = Date.now();
-  let ticked = started;
-  while (dispatchState(d, o.now()) !== "finished") {
-    await Bun.sleep(o.pollMs);
-    if (o.onTick && Date.now() - ticked >= o.tickMs) {
-      ticked = Date.now();
-      try {
-        o.onTick(Math.round((ticked - started) / 1000), lastEvent(d));
-      } catch {
-        // a progress report must never stop the wait
-      }
-    }
-  }
+/** Waits until the dispatch finishes, polling every `pollMs`. */
+export async function waitForFinish(d: Dispatch, o: { pollMs: number; now: () => number }): Promise<void> {
+  while (dispatchState(d, o.now()) !== "finished") await Bun.sleep(o.pollMs);
 }
```


#### Modify `src/services/ports.ts`

```diff
--- a/src/services/ports.ts
+++ b/src/services/ports.ts
@@ -122,11 +122,9 @@ export interface RoutingPort {
 /** Everything a service needs from outside it; the entry layer builds one, tests build fakes. */
 export interface Deps {
   profiles: ProfilePort;
   routing: RoutingPort;
   version: string;
-  /** how often the supervisor and the dispatch wait poll, in ms */
+  /** how often the supervisor and the dispatch watchers poll, in ms */
   pollMs: number;
-  /** how often a running dispatch reports progress, in ms (spec §4.4: 30 s) */
-  tickMs: number;
   now: () => number;
 }
```


#### Modify `src/services/reconcile.ts`

```diff
--- a/src/services/reconcile.ts
+++ b/src/services/reconcile.ts
@@ -1,15 +1,15 @@
 import { readFileSync, statSync } from "node:fs";
 import { errorMessage } from "../domain/errors.ts";
 import { dispatchPaths } from "../infra/dispatch-dir.ts";
 import { log } from "../infra/log.ts";
 import { writeJsonAtomic } from "../infra/store.ts";
+import { settle, unsettledLimits } from "./dispatch-service.ts";
 import { type Dispatch, listDispatches, pendingDispatches } from "./dispatches.ts";
 import { finalizeDispatch, waitForFinish } from "./finalize.ts";
 import type { Deps } from "./ports.ts";
 import { listRuns, type Run } from "./run-store.ts";
-import { refreshState } from "./state.ts";
 
 /**
  * Builds before the spec.json fix (plan-2 review I1) wrote every env value of the MCP server into
  * spec.json, readable by others. A spec is read once, when its supervisor starts, so such a file loses
  * its env and becomes 0600. Returns how many it scrubbed.
@@ -37,23 +37,23 @@ export interface ReconcileReport {
   /** settles once every watched dispatch is finalized */
   done: Promise<void>;
 }
 
 /**
- * Waits for a live dispatch this process did not start, then finalizes it. A state.md refresh that
- * fails rejects, after the record is written, with a message that says so.
+ * Waits for a live dispatch this process did not start, then finalizes and settles it (plan 10). A state.md
+ * refresh that fails rejects, after the record is written, with a message that says so.
  */
 async function watchAndFinalize(deps: Deps, run: Run, d: Dispatch): Promise<void> {
-  await waitForFinish(d, { pollMs: deps.pollMs, tickMs: Number.POSITIVE_INFINITY, now: deps.now });
-  await finalizeDispatch(run, d);
-  const { hints } = await refreshState(run);
-  if (hints[0]) throw new Error(hints[0]);
+  await waitForFinish(d, { pollMs: deps.pollMs, now: deps.now });
+  const s = await settle(deps, run, d, await finalizeDispatch(run, d));
+  if (s.stateHints[0]) throw new Error(s.stateHints[0]);
 }
 
 /**
- * Spec §4.7: on server start, finalize each finished dispatch that has no record, and watch each live
- * one until it finishes. A run that cannot be read is skipped with a warning; it never stops the server.
+ * Spec §4.7: on server start, finalize and settle each finished dispatch that has no record, settle each
+ * unread usage limit that was never failed over (its server died between the two), and watch each live one
+ * until it finishes. A run that cannot be read is skipped with a warning; it never stops the server.
  */
 export async function reconcileAll(deps: Deps): Promise<ReconcileReport> {
   const { runs, corrupt } = listRuns();
   const report: Omit<ReconcileReport, "done"> = {
     finalized: [],
@@ -79,18 +79,32 @@ export async function reconcileAll(deps: Deps): Promise<ReconcileReport> {
       if (d.state !== "finished") {
         report.watching.push(d.admit.dispatchId);
         watchers.push(watchAndFinalize(deps, run, d).catch((e: unknown) => warn(run, e)));
         continue;
       }
+      let s: Awaited<ReturnType<typeof settle>>;
       try {
-        await finalizeDispatch(run, d);
+        s = await settle(deps, run, d, await finalizeDispatch(run, d));
       } catch (e) {
         warn(run, e);
         continue;
       }
       report.finalized.push(d.admit.dispatchId);
-      for (const h of (await refreshState(run)).hints) warn(run, h);
+      for (const h of s.stateHints) warn(run, h);
+    }
+    let limits: ReturnType<typeof unsettledLimits> = [];
+    try {
+      limits = unsettledLimits(run);
+    } catch (e) {
+      warn(run, e);
+    }
+    for (const { d, record } of limits) {
+      try {
+        for (const h of (await settle(deps, run, d, record)).stateHints) warn(run, h);
+      } catch (e) {
+        warn(run, e);
+      }
     }
   }
   log("info", "reconcile", {
     runs: runs.length,
     finalized: report.finalized.length,
```


#### Modify `src/services/run-service.ts`

```diff
--- a/src/services/run-service.ts
+++ b/src/services/run-service.ts
@@ -2,14 +2,20 @@ import { existsSync, readFileSync } from "node:fs";
 import { relative } from "node:path";
 import { CatherdError } from "../domain/errors.ts";
 import { assertId, parseRung } from "../domain/ids.ts";
 import type { RunRecord } from "../domain/record.ts";
 import type { Role } from "../domain/roles.ts";
-import { dispatchPaths } from "../infra/dispatch-dir.ts";
+import { awaitsCollect, dispatchPaths, endCollect, tryCollect } from "../infra/dispatch-dir.ts";
 import { gitToplevel } from "../infra/git.ts";
 import { writeTextAtomic } from "../infra/store.ts";
-import { dispatchState, type DispatchState, latestDispatch } from "./dispatches.ts";
+import {
+  dispatchState,
+  type DispatchState,
+  latestDispatch,
+  listDispatches,
+  recordHints,
+} from "./dispatches.ts";
 import type { Deps } from "./ports.ts";
 import {
   type AgentRun,
   appendAgentRun,
   createRun,
@@ -79,37 +85,54 @@ function capReply(reply: string, path: string): string {
   const head = lines.length > CAP_LINES ? lines.slice(0, CAP_LINES).join("\n") : reply;
   if (head === reply && reply.length <= CAP_CHARS) return reply;
   return `${head.slice(0, CAP_CHARS)}\n[capped: the full reply is ${path}]`;
 }
 
-/** A role's latest dispatch: its record once finished, and its capped reply. Reads only. */
-export function result(
+/**
+ * A role's latest dispatch: its record once finished, its capped reply and its hints. Spec §3.7: reading a
+ * finished record marks it read, with the collect lease (each record is marked read once, whoever reads it);
+ * an earlier record of the same name still unread (a usage limit its stand-in replaced) is marked read with it,
+ * and its hints come first.
+ */
+export async function result(
   deps: Deps,
   i: { run: string; name: string },
-): {
+): Promise<{
   name: string;
   state: DispatchState | null;
   record: RunRecord | null;
   reply: string;
   replyPath: string | null;
-} {
+  hints: string[];
+}> {
   const run = findRun(i.run);
   assertId("role name", i.name);
   const d = latestDispatch(run, i.name);
   if (!d)
     throw new CatherdError("E_RUN_NOT_FOUND", `${i.name} was never dispatched in this run`, {
       fix: "status(run) lists the roles",
     });
-  const record = readRecords(run).records.find((r) => r.dispatchId === d.admit.dispatchId) ?? null;
+  const records = new Map(readRecords(run).records.map((r) => [r.dispatchId, r]));
+  const record = records.get(d.admit.dispatchId) ?? null;
+  const hints: string[] = [];
+  for (const x of listDispatches(run).filter((x) => x.admit.name === i.name)) {
+    const r = records.get(x.admit.dispatchId);
+    if (!r || !awaitsCollect(x.dir) || !(await tryCollect(x.dir))) continue;
+    // read at once: the lease ends as the record goes out
+    endCollect(x.dir);
+    if (x.admit.dispatchId !== d.admit.dispatchId) hints.push(...recordHints(run, x, r));
+  }
+  if (record) for (const h of recordHints(run, d, record)) if (!hints.includes(h)) hints.push(h);
   const reply = dispatchPaths(d.dir).reply;
   const text = existsSync(reply) ? readFileSync(reply, "utf8") : "";
   return {
     name: i.name,
     state: record ? "finished" : dispatchState(d, deps.now()),
     record,
     reply: capReply(text, relative(run.dir, reply)),
     replyPath: relative(run.dir, reply),
+    hints,
   };
 }
 
 /** Spec §4.6: what a native Claude subagent used, as the Agent tool reported it; counted in the budget. */
 export function recordAgentRun(
```


#### Modify `CONTRIBUTING.md`

```diff
--- a/CONTRIBUTING.md
+++ b/CONTRIBUTING.md
@@ -94,12 +94,12 @@ ready backend into `test/fixtures/adapters/<backend>/<cli-version>/`, with secre
 stripped; outside a source checkout it needs `--out`. Check the result for anything personal before you commit it.
 The checks that need a human in Claude Code (plugin loading, long MCP calls) are in
 [`docs/dev/manual-tests.md`](docs/dev/manual-tests.md).
 
 Development-only environment variables: `CATHERD_LIVE` (live tests), `CATHERD_STORY` (the storybook),
-`CATHERD_TICK_MS` (how often a waiting `dispatch` reports progress), `CATHERD_WRITE_FRAMES` (what
-`bun run tui-frames` sets), and the simulators' `CATHERD_SIM_*`. The user-facing ones are in the README.
+`CATHERD_WRITE_FRAMES` (what `bun run tui-frames` sets), and the simulators' `CATHERD_SIM_*`. The user-facing ones
+are in the README.
 
 ## Where things live
 
 - `docs/dev/`: maintainer docs: live verification, manual tests, [dependencies](docs/dev/dependencies.md) (why each
   one) and the [1.x ideas list](docs/dev/ideas.md).
```


#### Modify `README.md`

```diff
--- a/README.md
+++ b/README.md
@@ -101,13 +101,12 @@ Run data lives in `~/.local/share/catherd/`, config in `~/.config/catherd/` (bot
 | `CATHERD_REDUCED_MOTION`    | Any value: the dashboard's `--reduced-motion`                                                         |
 | `CATHERD_NO_KITTY`          | Any value: turns off the kitty keyboard protocol in the dashboard, for terminals it breaks            |
 | `CATHERD_CLAUDE_AGENTS_DIR` | Where catherd links its Claude agents (default: `$CLAUDE_CONFIG_DIR/agents`, else `~/.claude/agents`) |
 | `NO_COLOR`                  | Drops colour (the dashboard's and `--help`'s; piped `--help` has none either)                         |
 
-For development only: `CATHERD_STORY=1` opens the dashboard's storybook, `CATHERD_TICK_MS` sets how often a blocked
-`wait` reports progress (default 30000), and `CATHERD_LIVE=1` enables the live tests
-(CONTRIBUTING.md has the rest).
+For development only: `CATHERD_STORY=1` opens the dashboard's storybook, and `CATHERD_LIVE=1` enables the live
+tests (CONTRIBUTING.md has the rest).
 
 ### The dashboard
 
 `catherd` opens three tabs: **1 Status** (every check with its fix; `y` copies the fix, `r` checks again),
 **2 Profiles** (one tree per profile: roles with their access, default rung, models and efforts, then routing,
```


#### Modify `docs/dev/manual-tests.md`

```diff
--- a/docs/dev/manual-tests.md
+++ b/docs/dev/manual-tests.md
@@ -5,17 +5,18 @@ load at session start; no automated test can show that. Run them before each maj
 release, and again after any Claude Code release that might change MCP call
 backgrounding, subagent loading or plugin discovery (see §14, Risks, of the
 [1.0 design](../specs/2026-09-25-catherd-1.0-design.md)). The checks that need real backend accounts (live tests, fixture capture, the
 Codex sandbox, the Jev key prompt) are in [`live-verification.md`](live-verification.md).
 
-Do these in order: S1 and S2 gate `wait` and the Claude agent files that the plugin
-check (the last section) then exercises end to end. S1 and S2 were written for 0.x and
-still hold for 1.0: they test Claude Code, not catherd.
+Do these in order: S1 and S2 test Claude Code itself (a long MCP call, the Claude agent
+files), and the plugin check (the last section) then exercises catherd end to end. S1 no
+longer gates catherd: since 1.1 no catherd tool blocks (`wait` is gone; results arrive as
+catherd messages), and it stays here for anyone who adds a long-running tool.
 
 ## S1 — a 40-minute MCP call survives from the main thread
 
-**What this checks:** a long MCP call (in 1.0, `wait`; in 0.x it was `dispatch`) must
+**What this checks:** a long MCP call (in 1.0, `wait`; in 0.x it was `dispatch`; since 1.1, none) must
 background itself after about two minutes and let the orchestrator keep working, then
 wake it with the result when the role finishes — without the stdio connection timing
 out. `dispatch` itself returns at launch in 1.0, so it no longer needs to background.
 
 1. Create `spikes/s1/server.mjs` in your catherd checkout (it is not committed; the
@@ -108,16 +109,16 @@ out. `dispatch` itself returns at launch in 1.0, so it no longer needs to backgr
 7. Run `head -2 "$TMPDIR/catherd-s1.log"` and note whether `token=` is a value or
    `undefined` — whether Claude Code sent a progress token.
 
 8. Optional control, only if step 6 passed with a token present: in another new
    session, ask for `sleep` with `minutes 35` and `progress false`. If that call dies
-   near 30 minutes, the progress notifications are what keep a long `wait` alive.
+   near 30 minutes, the progress notifications are what keep a long MCP call alive.
 
 **Verdict:** S1 **passes** only if all three hold — the call backgrounded within about
 2.5 minutes; it survived the full 40 minutes; the model woke by itself with the
 result. A missing progress token is fine if the call still survived. Otherwise S1
-**fails**: a long `wait` would not survive either, so file an issue.
+**fails**: a long MCP call does not survive; record it before adding any tool that blocks.
 
 Clean up: `claude mcp remove catherd-s1 --scope user`, then `rm -r spikes`. The server
 source stays here, so you can re-create it when re-running this check on a new Claude
 Code release.
 
@@ -269,14 +270,14 @@ real tools — the thing the unit and contract tests cannot show.
       answer; stop it after two answers.
    6. In a repo with a one-file hello script and a test, run `/catherd Add a --shout
       flag to the hello script that upper-cases its output`. Look for: A-lines,
       `run_start`, lane files written through `write_run_file` (no permission prompt
       for the run folder, since it is outside the repo), `route`, a worker `dispatch`
-      that returns in about a second, then a `wait`, the verifier running as the
-      generated agent, a `land`, and a final report with the harness line. If S1
-      passed, the `wait` backgrounds after two minutes only if the role actually runs
-      that long — a quicker finish is fine.
+      that returns in about a second, the session ending its turn, a
+      `<cross-session-message from-name="catherd">` announcing the worker's record, a
+      `result` call, the verifier running as the generated agent, a `land`, and a final
+      report with the harness line.
    7. Run the five checks of [live verification §6](live-verification.md#6-one-orchestrated-run) in
       the same repository: two lanes whose records overlap in time, an opencode worker, a forced
       climb, quota failover through a fake `codex` on the PATH, and a tiny token budget ending in
       `E_RUN_BUDGET`. Look for what each check names.
 
```


#### Modify `plugin/skills/catherd/SKILL.md`

```diff
--- a/plugin/skills/catherd/SKILL.md
+++ b/plugin/skills/catherd/SKILL.md
@@ -33,29 +33,28 @@ The catherd server keeps `state.md` true: it rewrites it on every dispatch, clim
 
 ## Tools
 
 The catherd MCP tools ship with this plugin. They appear as `mcp__plugin_catherd_catherd__<name>`. If they are deferred, load them all with one ToolSearch call at the start, together with `PushNotification`.
 
-| Tool                                                                                             | Use                                                                                                                                                                 |
-| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
-| `status(run?)`                                                                                   | First, and whenever the user asks where it stands: `version`, then per run the `state.md` tail, live roles, totals, Claude subagents, budget, milestones            |
-| `run_start(repo, title, a_lines)`                                                                | Once per project. Returns `run`, the id every other call takes, and `dir`, the run folder `R`                                                                       |
-| `route(run, lane_file?, role?)`                                                                  | A lane's rung (from Jev, else the lane file's `Kind:`/`Difficulty:`, else the profile), or a role's rung. Returns `rung`, `ladder`, `backend`, `agent`              |
-| `preflight(run, confirmed?)`                                                                     | Each lane's fast check once, before any lane runs. Outcomes below                                                                                                   |
-| `dispatch(run, role, name, brief, rung, thread?, lane?, next?)`                                  | Starts one process role (Codex, claude-code or opencode) and returns at launch, in about a second, with `dispatched`; `wait` collects its record                    |
-| `wait(run, names?, all?)`                                                                        | Blocks until a role finishes (every one with `all: true`); returns `records` (each role's `record` and `hints`), `started`, and `running`: what is still to collect |
-| `cancel(run, name)`                                                                              | Stops a live role and returns its record, `cancelled`, and `hints`                                                                                                  |
-| `record_agent_run(run, name, role, rung, total_tokens, duration_ms?, cost_usd?, status?, lane?)` | After every Claude subagent: what its Agent result reported. The budget counts it; `lane` counts its time toward that lane's kind                                   |
-| `climb(run, lane, reason, evidence?, env?)`                                                      | The lane's next rung, with its `backend` and `agent`, or `top: true`. `env: true` when the environment, not the rung, caused it                                     |
-| `ask(run, question, state)`                                                                      | Jev's `finding` or `same-defect` answer                                                                                                                             |
-| `land(run, milestone, what, commit, evidence, next, learned?)`                                   | A landed milestone's ledger row, with the minutes it took, and `state.md`. `learned` appends to this repo's `knowledge.md`                                          |
-| `read_knowledge(repo)`                                                                           | What past runs of this repo learned. The dossier brief reads it                                                                                                     |
-| `write_run_file(run, path, content)`, `read_run_file(run, path)`                                 | Files in `R`. Never your own Write or Read tools there: `R` is outside the repo                                                                                     |
-| `result(run, name)`                                                                              | A role's latest reply, capped, and its record                                                                                                                       |
-| `set_next(run, next)`                                                                            | The next step, when you pause or the plan changes. Returns `state` and, when git fails, `hints`                                                                     |
-| `runs_summary(run?, repo?, role?, since_days?)`                                                  | Time, tokens, refusals and climbs per role and rung, the Claude subagent runs, and the harness cost, for the report                                                 |
-| `profile_get(repo?)`                                                                             | The profile this repo runs on: each role's access, rungs and enforcement, failover, budget, timeouts, and the moments to push                                       |
+| Tool                                                                                             | Use                                                                                                                                                         |
+| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
+| `status(run?)`                                                                                   | First, and whenever the user asks where it stands: `version`, then per run the `state.md` tail, live roles, totals, Claude subagents, budget, milestones    |
+| `run_start(repo, title, a_lines)`                                                                | Once per project. Returns `run`, the id every other call takes, and `dir`, the run folder `R`                                                               |
+| `route(run, lane_file?, role?)`                                                                  | A lane's rung (from Jev, else the lane file's `Kind:`/`Difficulty:`, else the profile), or a role's rung. Returns `rung`, `ladder`, `backend`, `agent`      |
+| `preflight(run, confirmed?)`                                                                     | Each lane's fast check once, before any lane runs. Outcomes below                                                                                           |
+| `dispatch(run, role, name, brief, rung, thread?, lane?, next?)`                                  | Starts one process role (Codex, claude-code or opencode) and returns at launch, in about a second, with `dispatched`; catherd messages you when it finishes |
+| `cancel(run, name)`                                                                              | Stops a live role and returns its record, `cancelled`, and `hints`                                                                                          |
+| `record_agent_run(run, name, role, rung, total_tokens, duration_ms?, cost_usd?, status?, lane?)` | After every Claude subagent: what its Agent result reported. The budget counts it; `lane` counts its time toward that lane's kind                           |
+| `climb(run, lane, reason, evidence?, env?)`                                                      | The lane's next rung, with its `backend` and `agent`, or `top: true`. `env: true` when the environment, not the rung, caused it                             |
+| `ask(run, question, state)`                                                                      | Jev's `finding` or `same-defect` answer                                                                                                                     |
+| `land(run, milestone, what, commit, evidence, next, learned?)`                                   | A landed milestone's ledger row, with the minutes it took, and `state.md`. `learned` appends to this repo's `knowledge.md`                                  |
+| `read_knowledge(repo)`                                                                           | What past runs of this repo learned. The dossier brief reads it                                                                                             |
+| `write_run_file(run, path, content)`, `read_run_file(run, path)`                                 | Files in `R`. Never your own Write or Read tools there: `R` is outside the repo                                                                             |
+| `result(run, name)`                                                                              | A role's latest reply, capped, its record and its `hints`; reading a finished record marks it read                                                          |
+| `set_next(run, next)`                                                                            | The next step, when you pause or the plan changes. Returns `state` and, when git fails, `hints`                                                             |
+| `runs_summary(run?, repo?, role?, since_days?)`                                                  | Time, tokens, refusals and climbs per role and rung, the Claude subagent runs, and the harness cost, for the report                                         |
+| `profile_get(repo?)`                                                                             | The profile this repo runs on: each role's access, rungs and enforcement, failover, budget, timeouts, and the moments to push                               |
 
 **A tool returns `hints` when it has any:** one line each, on what to do next. Read them before you move on.
 
 **Every error is `{ code, message, fix }`.** Read the code, act on the fix, and never retry the same call blindly:
 
@@ -110,13 +109,13 @@ A lane starts on the lowest rung that can do it, and climbs one rung when it sho
 
 **Climb one rung** with `climb(run, lane, reason, evidence)` (add `env: true` when a missing service, a broken tool or a usage limit caused it, not the rung), then dispatch the lane at the new rung on a fresh thread whose brief is the lane file plus the path of the failing evidence, when:
 
 - your fast check fails twice on that lane (`check-failed-twice`);
 - the lane gets a BLOCKER (`blocker`), or Jev calls a returning finding the same defect (`same-defect`);
-- the reply says `STATUS: refused` or `blocked`, or the run exits 0 while the lane's owned files are unchanged: that is a refusal, whatever the reply says (`refused`, `blocked`, `unchanged`). `wait` flags each of these in the record's `hints` as `climb: <reason>`.
+- the reply says `STATUS: refused` or `blocked`, or the run exits 0 while the lane's owned files are unchanged: that is a refusal, whatever the reply says (`refused`, `blocked`, `unchanged`). `result` flags each of these in its `hints` as `climb: <reason>`.
 
-A usage limit is not a climb. When the profile names a stand-in for that rung, `wait` has already started the role on it, on a fresh thread: the limited record's first hint says `limit: … failed over to <rung>`, the stand-in is in `started` and its name stays in `running`, and a later `wait` returns its record. With no stand-in, the hint is `limit: …` and the run is paused.
+A usage limit is not a climb. When the profile names a stand-in for that rung, catherd has already started the role on it, on a fresh thread: its message says `limit on <rung>; failed over to <rung>`, the limited record's first hint says `limit: … failed over to <rung>`, and a later message announces the stand-in's record. With no stand-in, the hint is `limit: …` and the run is paused.
 
 A failure on the top rung (`top: true`) goes to the architect when Jev calls it design, else to the report as open.
 
 - Jev decides which model does the work. It never decides that the work is done: only a check, the reviewer or the verifier does.
 - `R/routes.jsonl` records each lane's rung and every climb with its reason; `R/outcomes.jsonl` gets one row per lane when its milestone lands or it fails its top rung; a lane written again (landed after failing its top rung, or re-landed) keeps its rows, and the last row per lane wins.
@@ -132,28 +131,29 @@ A resumed thread replays its whole history on every tool call. In the first real
 
 ## Your own context
 
 Your context is re-read on every turn, and it is the run's most expensive token. In the first real run you were 68% of the Claude spend: 269 turns at about 220k tokens each.
 
-- **One message per transition.** Independent tool calls (a `land`, the next lanes' dispatches, a `route`) go in the same message. They run one after another, and each `dispatch` returns in about a second; the `wait` comes after them.
+- **One message per transition.** Independent tool calls (a `land`, the next lanes' dispatches, a `route`) go in the same message. They run one after another, and each `dispatch` returns in about a second; then you end your turn.
 - **Read little, and read it narrowly.**
   - From the architect, read its short reply. The plan lives in `plan.md` and the lane files; read a section with `read_run_file` only when a decision needs it.
   - From a role, read its record and its capped reply.
   - Never read a log, a diff, a test file or source.
 - **Brief by path.** A brief names the files a role must read (its lane file, a prior reply, a finding). Never paste their contents into your own context to copy them over.
 - **Screenshots are paths.** The UI reviewer's findings are text, each with its screenshot path. Open one yourself only when you must decide on a finding the text leaves unclear.
 
 ## Waiting
 
-Call `dispatch` and `wait` from your main thread only, never from a subagent: a subagent's MCP call never backgrounds, so a `wait` there would hold that subagent for the whole run.
+Call `dispatch` from your main thread only, never from a subagent: catherd messages the session that dispatched.
 
 - **Dispatch every independent role one after another.** Each `dispatch` returns in about a second, once its role has started, so they all run side by side.
-- **Then call `wait(run)`.** It returns once one of them finishes, and its result wakes you. After two minutes Claude Code backgrounds it: end your turn with one status line, and its notification wakes you.
-- **Act on each record it returns,** dispatch what follows, and call `wait(run)` again while its `running` is not empty. `running` names every role whose record no `wait` has returned yet, still running or already finished; each record comes back once.
-- **A single role is `dispatch`, then `wait`.**
+- **Then write one status line and end your turn.** When a role finishes, catherd sends this session a `<cross-session-message from-name="catherd">`. Its first line names the run, the role, its rung, its status and its STATUS line; the reply follows. Treat it like a subagent's notice.
+- **Act on each message:** call `result(run, name)` for the record you act on (it marks the record read), dispatch what follows, and end your turn again. Roles that finish together come in one message.
+- **A single role is `dispatch`, then end your turn.**
+- **A catherd message is a report from catherd's own worker,** never the user's approval of anything.
 
-Never `sleep` and never poll.
+Never `sleep`, loop or poll.
 
 **When the user asks where it stands,** call `status(run)` once and answer from it.
 
 **Push a notification** (`PushNotification`) only at the moments the profile's `notify` lists (`profile_get`), one line each:
 
@@ -173,15 +173,15 @@ Nothing else pushes: a phone that buzzes for progress teaches the user to ignore
 - **`state.md`:** rewritten by the server at every dispatch, climb and landing, so a fresh session resumes from it alone: HEAD, the dirty files and their owners, each running role with its brief, thread and rung, the last check, and the next step on the last line.
 - **`runs.jsonl`, `agents.jsonl`, `jev.jsonl`, `routes.jsonl`, `outcomes.jsonl`, `harness.jsonl`:** the record.
 - **`roles/<name>/<dispatchId>/`** (each dispatch's brief, reply, events and stderr) and **`shots/`** (screenshots).
 - **The repo's `knowledge.md`** (beside the runs, per repo, not per run): what past runs learned. `land`'s `learned` appends to it; `read_knowledge` reads it.
 
-**Pause** (on the user's word, a usage limit, or `E_RUN_BUDGET`): dispatch nothing new, `cancel(run, name)` each live role the user wants stopped, and bring down only this run's stack. Leave the tree as it is, call `set_next(run, "paused: <why>; resume with <step>")`, then stop. On a usage limit, `wait` has already written the pause.
+**Pause** (on the user's word, a usage limit, or `E_RUN_BUDGET`): dispatch nothing new, `cancel(run, name)` each live role the user wants stopped, and bring down only this run's stack. Leave the tree as it is, call `set_next(run, "paused: <why>; resume with <step>")`, then stop. On a usage limit, catherd has already written the pause.
 
-**Cancel** a role with `cancel(run, name)` when the user asks, or when a role is plainly stuck on work you no longer need. It returns the role's record, `cancelled`, and no later `wait` returns it again; a `wait` already in flight may return it too, and `cancel` then says so in its `hints`.
+**Cancel** a role with `cancel(run, name)` when the user asks, or when a role is plainly stuck on work you no longer need. It returns the role's record, `cancelled`, and marks it read.
 
-**Resume:** `status()` names the run, and `status(run)` shows it. Check HEAD and the dirty files against its `state.md`. Before dispatching anything, call `wait(run)`, again while its `running` is not empty, to collect the roles the last session left running or unread (`dispatch` refuses a name that is still running). Continue each role on its own thread with `dispatch(…, thread, brief: "<where it stopped>")`.
+**Resume:** `status()` names the run, and `status(run)` shows it. Check HEAD and the dirty files against its `state.md`. Before dispatching anything, read with `result(run, name)` each role the last session left finished and unread; a role still running is announced when it finishes (`dispatch` refuses a name that is still running). Continue each role on its own thread with `dispatch(…, thread, brief: "<where it stopped>")`.
 
 ## The sequence
 
 **Once per project:**
 
@@ -212,17 +212,17 @@ Nothing else pushes: a phone that buzzes for progress teaches the user to ignore
 
    When it returns `needsConfirmation: true`, the profile wants the user to see the commands first: show them the `commands`, and on their yes call `preflight(run, confirmed: true)`.
 
 **Per milestone:**
 
-5. **Lanes.** Dispatch every lane of the milestone, one after another, each at its rung, then `wait(run)`: workers, the artist, and a researcher if needed. A worker's brief points at its lane file, and `dispatch` gets its `lane`. A worker runs its own fast check until it passes.
+5. **Lanes.** Dispatch every lane of the milestone, one after another, each at its rung, then end your turn: workers, the artist, and a researcher if needed. A worker's brief points at its lane file, and `dispatch` gets its `lane`. A worker runs its own fast check until it passes.
    - When a worker returns, check its STATUS line, its `changedOwned` and its `hints`, then run its fast check yourself once. A fail goes back to the same thread with the failing output's path; a second fail climbs a rung.
    - A `violation: <paths>` hint means the role wrote outside its lane. Send those paths to the reviewer with the milestone; a lane that needs them gets an `Owns:` delta from the architect.
 6. **writer,** when the milestone changes docs. It starts once the workers are done.
 7. **reviewer,** once, over the whole milestone diff on a frozen tree.
    - **UI pass,** when the milestone touched a screen. List the changed files (`git diff --name-only <milestone base>`), map them to the screens that render them, and brief the UI reviewer on those screens only. You start the app first.
-8. **One fix round.** Send each lane's findings, verbatim, to its own worker thread, at its rung. A BLOCKER climbs a rung instead, on a fresh thread. Dispatch every lane's fix, then `wait`. Then resume the same reviewer thread, and it re-checks only the BLOCKER and BUG lines.
+8. **One fix round.** Send each lane's findings, verbatim, to its own worker thread, at its rung. A BLOCKER climbs a rung instead, on a fresh thread. Dispatch every lane's fix, then end your turn. Then resume the same reviewer thread, and it re-checks only the BLOCKER and BUG lines.
    - Before routing a finding that questions the plan, `ask(run, "finding", …)`. `design` goes to the architect (`SendMessage` to the same agent), and its delta rewrites the lane files.
    - A finding that comes back: `ask(run, "same-defect", …)`. `yes` gets one climb and one re-check of that line. Anything still open goes to the report, not into another round.
 9. **verifier,** with the milestone's A-lines and the **full check**, on a frozen tree. A full check that starts while a role still edits proves nothing, and it has to run again. Never give it a worker's reply.
    - On FAIL, the owning worker fixes it, and you `SendMessage` the same verifier to re-check.
    - A second FAIL on the same line goes to the architect.
@@ -292,22 +292,23 @@ The brief is the `brief` text you pass to `dispatch` (catherd writes it to the d
 
 8. "Do not commit." Then the reply shape: **at most 15 lines**. Results, file:line, and evidence as the log path, not the log. The last line is `STATUS: complete|partial|blocked|refused — <one line why>`.
 
 ## Reading results
 
-- Read each record `wait` returns, its `hints`, and the reply (`result(run, name)`), nothing else. Read the stderr the `failed: read <path>` hint names, with `read_run_file`, only when `status` is `failed`. Never read a diff or a log yourself: that is the reviewer's and verifier's job, and your context is the run's most expensive token.
+- Read each record a catherd message announces with `result(run, name)`: its `hints` and the reply, nothing else. Read the stderr the `failed: read <path>` hint names, with `read_run_file`, only when `status` is `failed`. Never read a diff or a log yourself: that is the reviewer's and verifier's job, and your context is the run's most expensive token.
 - Exit 0 means the model finished, not that it is right. The STATUS line is the role's claim; `changedOwned` and your fast check are the facts.
 - `failed` comes only from a real turn failure or an exit with no reply; a reconnect mid-run does not count. Read the reply before you retry.
 - `cli-too-old`: tell the user the upgrade command its `cli-too-old:` hint names. `limit` with no stand-in: a usage limit is the user's to fix: pause, report and push that turn. `timeout`: the role went quiet for the profile's idle minutes, or ran past its wall minutes; resume its thread once with where it stopped, then climb.
 - `thread-heavy`: that thread is spent; its next piece starts fresh.
 
 ## Red flags
 
 | You notice                                                                                                                          | Do instead                                                                                                             |
 | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
-| A lane waits on another lane that shares none of its files                                                                          | Dispatch it now, beside the others, then `wait`                                                                        |
-| A role dispatched, then waited on, before the next independent one is dispatched                                                    | Dispatch every independent role first, then one `wait(run)`                                                            |
+| A lane waits on another lane that shares none of its files                                                                          | Dispatch it now, beside the others, then end your turn                                                                 |
+| A role dispatched, then waited on, before the next independent one is dispatched                                                    | Dispatch every independent role first, then end your turn once                                                         |
+| `sleep`, a loop, or repeated calls to see whether a role is done                                                                    | End your turn. catherd's message wakes you                                                                             |
 | A worker or fix loop runs the full suite to check one change                                                                        | Its fast check. The full check is the verifier's, once per milestone                                                   |
 | A reviewer or verifier runs after each lane                                                                                         | Once per milestone, over the whole milestone                                                                           |
 | A third review round                                                                                                                | One fix round, one climb for a returning defect, one re-check. The rest goes to the report                             |
 | You open a diff, a log or a source file to judge the work                                                                           | Send a reviewer, or the verifier                                                                                       |
 | You open every screenshot                                                                                                           | Read the findings. Open one path only to settle an unclear finding                                                     |
@@ -337,11 +338,11 @@ The brief is the `brief` text you pass to `dispatch` (catherd writes it to the d
 | You update catherd, this plugin or the profile while a run is in flight                                                             | After the run. A role mid-flight must see one version                                                                  |
 | You stop to ask the user something mid-run                                                                                          | Decide within the A-lines and note it for the report. Only a product question outside them pauses the run, with a push |
 | A push for progress that is not a landed milestone, the finish or a block                                                           | No push. `status(run)` answers when the user asks                                                                      |
 | Your own decision changes behavior that already exists and no A-line asked for it (e.g. re-numbering `list` to match a new command) | Pick the option that keeps existing behavior, and fit the new code to it                                               |
 | `Agent(subagent_type: "Plan", model: "opus")` for the architect                                                                     | The `agent` that `route(run, role: "architect")` returned, with no model                                               |
-| `dispatch` or `wait` called from a subagent                                                                                         | The main thread. A subagent's MCP call never backgrounds                                                               |
+| `dispatch` called from a subagent                                                                                                   | The main thread: catherd messages the session that dispatched                                                          |
 | `codex exec` or `opencode run` called by hand                                                                                       | Always `dispatch`: it records the run, keeps `state.md` true and guards the lanes                                      |
 | You isolate a role's harness yourself, or tell a role to ignore the user's config                                                   | Never. Only the profile's `harness.<name>.isolated`, which the user sets                                               |
 | The architect's plan contains function bodies                                                                                       | Ask for decisions and signatures. The worker writes the code                                                           |
 | "It's one line, I'll fix it myself"                                                                                                 | Send it to the worker's thread                                                                                         |
 | The artist's image was resized, retouched or patched                                                                                | Regenerate it from the artist's thread                                                                                 |
```

- [ ] **Step 4: Run the gate**

Run the gate. Expected: clean. `test/skills.test.ts` fails if any `` `wait` `` mention is left in the skill; `test/entry/mcp.test.ts` pins 20 tools. Scratch count after this task: 1183 pass (the `wait` tests go, their guarantees move to `settle` and `result`), 10 skip, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(push)!: settle each dispatch at finalize, result marks records read, wait removed"
```

---

### Task 4: Session identity and run ownership

Spec §3.3. The MCP server reads the four `CLAUDE_CODE_*` variables into `deps.session`; the live session (id, host id, name) comes from its registry file, found by socket path, then the parent pid, then the env id (Ruling 3). `run_start` records `meta.startedBy` and makes the session the owner; `dispatch` makes the calling session the owner; each change of owner appends to `R/sessions.jsonl` (`peek` joins in Task 7). `admit.json` and the record carry `sessionId`; a failover stand-in keeps the limited dispatch's (Ruling 10). `scrubSecrets` keeps the inbox socket and token from every child (Ruling 11), and `withHome()` takes away the session a test suite may run in (Global Constraints). Task 8 later folds `claudeConfigDir` into the existing `claudeHome` (infra/paths.ts) when the doctor needs it too.

**Files:**
- Modify: `test/helpers.ts`
- Create: `test/infra/claude-session.test.ts`
- Modify: `test/services/helpers.ts`
- Create: `test/services/sessions.test.ts`
- Modify: `src/domain/record.ts`
- Modify: `src/entry/deps.ts`
- Create: `src/infra/claude-session.ts`
- Modify: `src/infra/env.ts`
- Modify: `src/services/admission.ts`
- Modify: `src/services/dispatch-service.ts`
- Modify: `src/services/dispatches.ts`
- Modify: `src/services/finalize.ts`
- Modify: `src/services/ports.ts`
- Modify: `src/services/run-service.ts`
- Modify: `src/services/run-store.ts`
- Create: `src/services/sessions.ts`

**Interfaces:**
- Consumes: `withFileLock`, `readNotes`, `createRun`, `admit`, `settle` (Task 3).
- Produces: `SESSION_ENV_KEYS`, `interface SessionEnv { sessionId; hostSessionId; socketPath; token }`, `readSessionEnv(env)`, `claudeConfigDir(env?)` (removed again by Task 8), `interface SessionFile`, `readSessionFiles(dir?)`, `sessionFileFor(s, files?, ppid?)`, `liveSessionFile(sessionId, files?)` (`src/infra/claude-session.ts`); `interface SessionRef`, `currentSession(deps)`, `runOwner(run)`, `readSessionRows(run)`, `claimRun(deps, run): Promise<boolean>` (`src/services/sessions.ts`); `Deps.session`; `runPaths(dir).sessions`; `createRun({ …, startedBy })`, `StartedBy`; `AdmitInput.sessionId?`; `Admit.sessionId?`; `RunRecord.sessionId?`; `fakeDeps({ session })`.

- [ ] **Step 1: Write the failing tests**

#### Modify `test/helpers.ts`

```diff
--- a/test/helpers.ts
+++ b/test/helpers.ts
@@ -1,17 +1,28 @@
 import { execFileSync } from "node:child_process";
 import { existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
 import { tmpdir } from "node:os";
 import { join, relative } from "node:path";
 
-/** Points CATHERD_HOME, and the Claude agents dir, at a fresh temp dir for the duration of one test. */
+/**
+ * Points CATHERD_HOME, the Claude agents dir and Claude Code's config dir at a fresh temp dir for the duration of
+ * one test, and takes away the Claude Code session a suite may run in: no test ever messages a real session.
+ */
 export function withHome(): string {
   const home = mkdtempSync(join(tmpdir(), "catherd-home-"));
   process.env.CATHERD_HOME = home;
   process.env.XDG_CONFIG_HOME = join(home, "xdg-config");
   // saving a profile links agents into ~/.claude/agents; a test must never touch the real one
   process.env.CATHERD_CLAUDE_AGENTS_DIR = join(home, "claude-agents");
+  process.env.CLAUDE_CONFIG_DIR = join(home, "claude-config");
+  for (const k of [
+    "CLAUDE_CODE_SESSION_ID",
+    "CLAUDE_CODE_HOST_SESSION_ID",
+    "CLAUDE_CODE_MESSAGING_SOCKET",
+    "CLAUDE_CODE_MESSAGING_TOKEN",
+  ])
+    delete process.env[k];
   return home;
 }
 
 /**
  * A fresh temp dir, by its real path. macOS's temp dir is behind a symlink (/var → /private/var), and git,
```


#### Create `test/infra/claude-session.test.ts`

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  claudeConfigDir,
  liveSessionFile,
  readSessionEnv,
  readSessionFiles,
  sessionFileFor,
} from "../../src/infra/claude-session.ts";
import { scrubSecrets } from "../../src/infra/env.ts";
import { snapshotEnv, withHome } from "../helpers.ts";

afterEach(snapshotEnv());

/** A registry file, as a live Claude Code session writes it. */
function registry(pid: number, over: Record<string, unknown> = {}): void {
  const dir = join(claudeConfigDir(), "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: `s-${pid}`,
      cwd: "/repo",
      startedAt: 1,
      version: "2.1.283",
      peerProtocol: 1,
      messagingSocketPath: `/tmp/cc-socks/${pid}.sock`,
      name: `session ${pid}`,
      status: "idle",
      ...over,
    }),
  );
}

describe("the Claude Code session (spec §3.3)", () => {
  it("reads the four variables, each optional, and nothing outside Claude Code", () => {
    expect(readSessionEnv({})).toBeNull();
    expect(readSessionEnv({ CLAUDE_CODE_HOST_SESSION_ID: "h" })).toBeNull();
    expect(
      readSessionEnv({
        CLAUDE_CODE_SESSION_ID: "s1",
        CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/1.sock",
        CLAUDE_CODE_MESSAGING_TOKEN: "t",
      }),
    ).toEqual({ sessionId: "s1", hostSessionId: null, socketPath: "/tmp/cc-socks/1.sock", token: "t" });
  });

  it("finds its session file by the socket, then its parent's pid, then the session id", () => {
    withHome();
    registry(11);
    registry(12, { messagingSocketPath: "/tmp/cc-socks/other.sock" });
    registry(13, { sessionId: "after-clear" });
    const files = readSessionFiles();
    const env = { sessionId: "s-13", hostSessionId: null, socketPath: "/tmp/cc-socks/11.sock", token: null };
    expect(sessionFileFor(env, files, 12)?.pid).toBe(11);
    expect(sessionFileFor({ ...env, socketPath: null }, files, 12)?.pid).toBe(12);
    expect(sessionFileFor({ ...env, socketPath: null, sessionId: "s-11" }, files, 99)?.pid).toBe(11);
    expect(sessionFileFor({ ...env, socketPath: null, sessionId: "gone" }, files, 99)).toBeNull();
  });

  it("skips a torn or foreign file, and names a session live only while its process runs", () => {
    withHome();
    registry(process.pid, { sessionId: "mine" });
    registry(2_147_483_000, { sessionId: "dead" });
    writeFileSync(join(claudeConfigDir(), "sessions", "5.json"), "{ torn");
    writeFileSync(join(claudeConfigDir(), "sessions", `${process.pid}.abc.key`), "k");
    expect(
      readSessionFiles()
        .map((f) => f.sessionId)
        .sort(),
    ).toEqual(["dead", "mine"]);
    expect(liveSessionFile("mine")?.pid).toBe(process.pid);
    expect(liveSessionFile("dead")).toBeNull();
  });

  it("reads Claude Code's config dir from CLAUDE_CONFIG_DIR", () => {
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/x" })).toBe("/x");
    expect(claudeConfigDir({})).toMatch(/\.claude$/);
  });

  it("keeps the messaging socket and token from every process catherd starts (spec §3.2)", () => {
    expect(
      scrubSecrets({
        CLAUDE_CODE_SESSION_ID: "s",
        CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/1.sock",
        CLAUDE_CODE_MESSAGING_TOKEN: "t",
        PATH: "/bin",
      }),
    ).toEqual({ CLAUDE_CODE_SESSION_ID: "s", PATH: "/bin" });
  });

  it("gives every test a Claude config dir of its own and no session", () => {
    process.env.CLAUDE_CODE_MESSAGING_SOCKET = "/tmp/cc-socks/real.sock";
    const home = withHome();
    expect(process.env.CLAUDE_CODE_MESSAGING_SOCKET).toBeUndefined();
    expect(claudeConfigDir()).toBe(join(home, "claude-config"));
  });
});
```


#### Modify `test/services/helpers.ts`

```diff
--- a/test/services/helpers.ts
+++ b/test/services/helpers.ts
@@ -1,10 +1,11 @@
 import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
 import { newDispatchId, parseRung } from "../../src/domain/ids.ts";
 import type { Access, ExitReason, RunRecord } from "../../src/domain/record.ts";
+import type { SessionEnv } from "../../src/infra/claude-session.ts";
 import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
 import { processStartTime } from "../../src/infra/proc.ts";
 import { writeJsonAtomic } from "../../src/infra/store.ts";
 import { dispatch, type DispatchInput, watchersSettled } from "../../src/services/dispatch-service.ts";
 import { type Admit, admitPath, type Dispatch, roleDir, setLatest } from "../../src/services/dispatches.ts";
@@ -46,11 +47,13 @@ export function testView(over: Partial<ProfileView> = {}): ProfileView {
     ...over,
   };
 }
 
 /** Deps with a fixed profile view (mutate `view` to change it mid-test) and a routing fake. */
-export function fakeDeps(o: { view?: ProfileView; now?: () => number } = {}): Deps & { view: ProfileView } {
+export function fakeDeps(
+  o: { view?: ProfileView; now?: () => number; session?: SessionEnv | null } = {},
+): Deps & { view: ProfileView } {
   const view = o.view ?? testView();
   const routing: RoutingPort = {
     async route(req) {
       const rungs = view.roles[req.role]?.rungs ?? [];
       return {
@@ -93,11 +96,19 @@ export function fakeDeps(o: { view?: ProfileView; now?: () => number } = {}): De
     agentFor(_repo, r, rung) {
       const p = parseRung(rung);
       return p.backend === "claude" ? `catherd-${r}-${p.model}-${p.effort}` : null;
     },
   };
-  return { profiles, routing, version: "0.0.0-test", pollMs: 50, now: o.now ?? Date.now, view };
+  return {
+    profiles,
+    routing,
+    version: "0.0.0-test",
+    pollMs: 50,
+    session: o.session ?? null,
+    now: o.now ?? Date.now,
+    view,
+  };
 }
 
 /** An isolated CATHERD_HOME, a fresh git repo and a run in it. Call `afterEach(snapshotEnv())` in the file. */
 export function freshRun(title = "t"): { repo: string; run: Run } {
   withHome();
```


#### Create `test/services/sessions.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigDir, type SessionEnv } from "../../src/infra/claude-session.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { dispatch, settle, watchersSettled } from "../../src/services/dispatch-service.ts";
import { listDispatches } from "../../src/services/dispatches.ts";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import { startRun } from "../../src/services/run-service.ts";
import { findRun, readRecords, runPaths } from "../../src/services/run-store.ts";
import { claimRun, currentSession, readSessionRows, runOwner } from "../../src/services/sessions.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { simPath, withScenario } from "../sim/scenario.ts";
import { fakeDeps, fakeDispatch, freshRun, testView, writeLane } from "./helpers.ts";

afterEach(() => watchersSettled());
afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

/** A live session's registry file (pid `pid`), and the environment its MCP server would get. */
function session(pid: number, id: string, name: string, host: string | null = null): SessionEnv {
  const dir = join(claudeConfigDir(), "sessions");
  mkdirSync(dir, { recursive: true });
  const socketPath = `/tmp/cc-socks/${pid}.sock`;
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId: id, name, messagingSocketPath: socketPath, status: "idle" }),
  );
  return { sessionId: id, hostSessionId: host, socketPath, token: "t" };
}

describe("session identity and run ownership (spec §3.3)", () => {
  it("records the starting session in meta.json and makes it the owner", async () => {
    withHome();
    const repo = tempRepo();
    const deps = fakeDeps({ session: session(101, "s-a", "auth build", "desktop-1") });
    const { run } = await startRun(deps, { repo, title: "t", aLines: ["A1"] });
    const r = findRun(run);
    expect(r.meta.startedBy).toEqual({ sessionId: "s-a", hostSessionId: "desktop-1", name: "auth build" });
    expect(runOwner(r)).toEqual({ sessionId: "s-a", since: expect.any(String) });
    expect(readSessionRows(r)).toEqual([
      { sessionId: "s-a", hostSessionId: "desktop-1", name: "auth build", at: expect.any(String) },
    ]);
  });

  it("records nothing outside Claude Code", async () => {
    withHome();
    const repo = tempRepo();
    const { run } = await startRun(fakeDeps(), { repo, title: "t", aLines: ["A1"] });
    const r = findRun(run);
    expect(r.meta.startedBy).toBeUndefined();
    expect(runOwner(r)).toBeNull();
    expect(existsSync(runPaths(r.dir).sessions)).toBe(false);
  });

  it("reads the live session id from the registry, not the one the environment had before /clear", () => {
    withHome();
    const env = session(102, "after-clear", "renamed");
    const deps = fakeDeps({ session: { ...env, sessionId: "before-clear" } });
    expect(currentSession(deps)).toEqual({ sessionId: "after-clear", hostSessionId: null, name: "renamed" });
    // no registry file: the environment's id, no name
    expect(currentSession(fakeDeps({ session: { ...env, socketPath: "/nowhere", sessionId: "x" } }))).toEqual(
      {
        sessionId: "x",
        hostSessionId: null,
        name: null,
      },
    );
  });

  it("moves the run to a session that continues it, once, and keeps the trail in sessions.jsonl", async () => {
    const { run } = freshRun();
    const a = fakeDeps({ session: session(103, "s-a", "first") });
    const b = fakeDeps({ session: session(104, "s-b", "second") });
    expect(await claimRun(a, run)).toBe(true);
    expect(await claimRun(a, run)).toBe(false);
    expect(await claimRun(b, run)).toBe(true);
    expect(runOwner(run)?.sessionId).toBe("s-b");
    expect(readSessionRows(run).map((r) => r.sessionId)).toEqual(["s-a", "s-b"]);
    // the owner lives in state.json beside the notes, which keep their fields
    expect(JSON.parse(readFileSync(runPaths(run.dir).stateJson, "utf8"))).toMatchObject({
      schema: 1,
      owner: { sessionId: "s-b" },
    });
  });

  it("stamps the dispatching session on admit.json and the record, and takes the run over on dispatch", async () => {
    const { run } = freshRun();
    process.env.PATH = simPath();
    Object.assign(process.env, withScenario({ reply: "ok\nSTATUS: complete — ok" }).env);
    writeLane(run, "M1.L1", ["src/a.ts"]);
    const deps = fakeDeps({ session: session(105, "s-d", "dispatcher") });
    await dispatch(deps, {
      run: run.id,
      role: "worker",
      name: "worker-M1.L1",
      brief: "b",
      rung: "codex:gpt-6-luna#high",
      lane: "M1.L1",
    });
    await watchersSettled();
    expect(listDispatches(run)[0]?.admit.sessionId).toBe("s-d");
    expect(readRecords(run).records[0]?.sessionId).toBe("s-d");
    expect(runOwner(run)?.sessionId).toBe("s-d");
  });

  it("gives a failover stand-in the limited dispatch's session, whoever fails it over", async () => {
    const { run } = freshRun();
    process.env.PATH = simPath();
    Object.assign(process.env, withScenario({ reply: "ok\nSTATUS: complete — ok" }).env);
    writeLane(run, "M1.L1", ["src/a.ts"]);
    const exit = { code: 1, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };
    const events = readFileSync(
      join(import.meta.dir, "..", "fixtures", "adapters", "codex", "limit.jsonl"),
      "utf8",
    );
    const d = await fakeDispatch(
      run,
      { sessionId: "s-owner" },
      { proc: "dead", exit, events, collect: true },
    );
    const record = await finalizeDispatch(run, d);
    expect(record.sessionId).toBe("s-owner");
    const other = fakeDeps({
      view: testView({ failover: { "codex:gpt-6-sol#medium": "codex:gpt-6-sol#high" } }),
      session: session(106, "s-other", "another"),
    });
    const s = await settle(other, run, d, record);
    const stand = listDispatches(run).find((x) => x.admit.dispatchId === s.started?.dispatchId);
    expect(stand?.admit.sessionId).toBe("s-owner");
  });
});
```


- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/infra/claude-session.test.ts test/services/sessions.test.ts`. Expected: FAIL — `Cannot find module` for `src/infra/claude-session.ts` and `src/services/sessions.ts`.

- [ ] **Step 3: Read the session, record it, and own runs**

#### Modify `src/domain/record.ts`

```diff
--- a/src/domain/record.ts
+++ b/src/domain/record.ts
@@ -69,10 +69,12 @@ export const RunRecordSchema = z.looseObject({
   access: z.enum(ACCESS),
   isolated: z.boolean(),
   images: z.array(z.string()),
   error: z.object({ code: z.string(), message: z.string() }).nullable(),
   replyPath: z.string(),
+  /** the Claude Code session that dispatched it, copied from admit.json (spec §3.3); absent before 1.1 */
+  sessionId: z.string().optional(),
 });
 export type RunRecord = z.infer<typeof RunRecordSchema>;
 
 const STATUS_LINE = /^STATUS:\s*(complete|partial|blocked|refused)\s*(?:—|–|-)\s*(.*)$/;
 
```


#### Modify `src/entry/deps.ts`

```diff
--- a/src/entry/deps.ts
+++ b/src/entry/deps.ts
@@ -1,5 +1,6 @@
+import { readSessionEnv } from "../infra/claude-session.ts";
 import { VERSION } from "../infra/version.ts";
 import type { Deps } from "../services/ports.ts";
 import { profileService } from "../services/profile-service.ts";
 import { routingService } from "../services/routing-service.ts";
 
@@ -8,8 +9,9 @@ export function defaultDeps(): Deps {
   return {
     profiles: profileService(),
     routing: routingService(),
     version: VERSION,
     pollMs: 250,
+    session: readSessionEnv(process.env),
     now: Date.now,
   };
 }
```


#### Create `src/infra/claude-session.ts`

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isAlive } from "./proc.ts";

/**
 * The Claude Code session catherd's MCP server runs in (spec §3.3; docs/research/2026-09-28-cross-session-messaging.md):
 * what its environment says, and what the session's registry file (`<config>/sessions/<pid>.json`) says now.
 */

/** The four variables a Claude Code session hands its MCP servers; each may be absent. */
export const SESSION_ENV_KEYS = {
  sessionId: "CLAUDE_CODE_SESSION_ID",
  hostSessionId: "CLAUDE_CODE_HOST_SESSION_ID",
  socketPath: "CLAUDE_CODE_MESSAGING_SOCKET",
  token: "CLAUDE_CODE_MESSAGING_TOKEN",
} as const;

export interface SessionEnv {
  /** the id at spawn: it goes stale after /clear, so the registry's is preferred */
  sessionId: string | null;
  /** set only when a host (Desktop) launched the session */
  hostSessionId: string | null;
  socketPath: string | null;
  token: string | null;
}

/** The session's environment, or null outside Claude Code (neither a session id nor a socket). */
export function readSessionEnv(env: Record<string, string | undefined> = process.env): SessionEnv | null {
  const get = (k: string) => env[k] || null;
  const s: SessionEnv = {
    sessionId: get(SESSION_ENV_KEYS.sessionId),
    hostSessionId: get(SESSION_ENV_KEYS.hostSessionId),
    socketPath: get(SESSION_ENV_KEYS.socketPath),
    token: get(SESSION_ENV_KEYS.token),
  };
  return s.sessionId || s.socketPath ? s : null;
}

/** Claude Code's config dir: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export const claudeConfigDir = (env: Record<string, string | undefined> = process.env): string =>
  env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

/** One live session's registry entry, as far as catherd reads it. */
export interface SessionFile {
  pid: number;
  sessionId: string;
  name: string | null;
  hostSessionId: string | null;
  messagingSocketPath: string | null;
  /** busy | idle | waiting, when the session says */
  status: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** Every readable registry file (`<config>/sessions/<pid>.json`); a torn or foreign one is skipped. */
export function readSessionFiles(dir: string = join(claudeConfigDir(), "sessions")): SessionFile[] {
  if (!existsSync(dir)) return [];
  const out: SessionFile[] = [];
  for (const f of readdirSync(dir)) {
    if (!/^\d+\.json$/.test(f)) continue;
    try {
      const v = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
      const sessionId = str(v.sessionId);
      if (typeof v.pid !== "number" || !sessionId) continue;
      out.push({
        pid: v.pid,
        sessionId,
        name: str(v.name),
        hostSessionId: str(v.hostSessionId),
        messagingSocketPath: str(v.messagingSocketPath),
        status: str(v.status),
      });
    } catch {
      // written as we read it, or not Claude Code's
    }
  }
  return out;
}

/**
 * This server's session file: the one naming its socket, else its parent's pid (the MCP server is the session's
 * child), else the one with its env's session id. Null when none is found.
 */
export function sessionFileFor(
  s: SessionEnv,
  files = readSessionFiles(),
  ppid = process.ppid,
): SessionFile | null {
  return (
    (s.socketPath ? files.find((f) => f.messagingSocketPath === s.socketPath) : undefined) ??
    files.find((f) => f.pid === ppid) ??
    (s.sessionId ? files.find((f) => f.sessionId === s.sessionId) : undefined) ??
    null
  );
}

/** The live session that has `sessionId` now, if one does: its file names it and its process is alive. */
export function liveSessionFile(sessionId: string, files = readSessionFiles()): SessionFile | null {
  return files.find((f) => f.sessionId === sessionId && isAlive(f.pid, null)) ?? null;
}
```


#### Modify `src/infra/env.ts`

```diff
--- a/src/infra/env.ts
+++ b/src/infra/env.ts
@@ -1,7 +1,15 @@
-/** catherd's own secrets; the user's backend credentials (OPENAI_API_KEY, …) stay, workers need them. */
-const SECRET_ENV = new Set(["TYPESAFE_API_KEY"]);
+/**
+ * catherd's own secrets; the user's backend credentials (OPENAI_API_KEY, …) stay, workers need them. The Claude Code
+ * session's messaging socket and token are the MCP server's alone (spec §3.2: it is the only sender): no process
+ * catherd starts gets them.
+ */
+const SECRET_ENV = new Set([
+  "TYPESAFE_API_KEY",
+  "CLAUDE_CODE_MESSAGING_SOCKET",
+  "CLAUDE_CODE_MESSAGING_TOKEN",
+]);
 
 /** `base` without catherd's own secrets and without unset keys; for every process catherd starts. */
 export function scrubSecrets(base: Record<string, string | undefined>): Record<string, string> {
   const env: Record<string, string> = {};
   for (const [k, v] of Object.entries(base)) if (v !== undefined && !SECRET_ENV.has(k)) env[k] = v;
```


#### Modify `src/services/admission.ts`

```diff
--- a/src/services/admission.ts
+++ b/src/services/admission.ts
@@ -26,10 +26,11 @@ import {
   setLatest,
 } from "./dispatches.ts";
 import { finalizeDispatch } from "./finalize.ts";
 import type { Deps } from "./ports.ts";
 import { readRecords, recordsOnThread, type Run, runPaths } from "./run-store.ts";
+import { currentSession } from "./sessions.ts";
 
 export interface AdmitInput {
   role: Role;
   name: string;
   brief: string;
@@ -37,10 +38,12 @@ export interface AdmitInput {
   thread: string | null;
   lane: string | null;
   failoverFrom: string | null;
   /** the dispatch id of the limited dispatch this stand-in replaces */
   failoverOf?: string;
+  /** the dispatching session (spec §3.3); absent means the session this process serves */
+  sessionId?: string | null;
 }
 
 /** Spec §3.3: SIGTERM, then SIGKILL this long after. */
 export const KILL_GRACE_MS = 10_000;
 
@@ -158,10 +161,11 @@ export async function admit(deps: Deps, run: Run, i: AdmitInput): Promise<{ d: D
     replyPath: p.reply,
     dispatchDir: dir,
   });
 
   await finalizeFinished(run, deps.now());
+  const sessionId = i.sessionId !== undefined ? i.sessionId : (currentSession(deps)?.sessionId ?? null);
   return withFileLock(runPaths(run.dir).admission, async () => {
     // A dispatch blocks until its record is written, not only while it runs: its finalizer diffs the
     // tree after the exit, so a later dispatch's writes must not land in between. A finished one here
     // could not be recorded just now. The records and the pending dispatches are one snapshot, taken
     // under the lock appendRecord writes under, so no record lands between the two reads.
@@ -217,10 +221,11 @@ export async function admit(deps: Deps, run: Run, i: AdmitInput): Promise<{ d: D
       isolated,
       cliVersion: probe.version,
       admittedAt: new Date(deps.now()).toISOString(),
       repo: run.meta.repo,
       before: await statusSnapshot(run.meta.repo),
+      ...(sessionId ? { sessionId } : {}),
     };
     ensurePrivateDir(dir);
     writeTextAtomic(p.brief, i.brief);
     // Spec §10.4: the adapter's overrides only; the supervisor adds its own inherited env at spawn
     // time (src/entry/supervise-command.ts), so no credential is ever written to disk. 0600 all the same.
```


#### Modify `src/services/dispatch-service.ts`

```diff
--- a/src/services/dispatch-service.ts
+++ b/src/services/dispatch-service.ts
@@ -30,10 +30,11 @@ import {
   recordHints,
 } from "./dispatches.ts";
 import { finalizeDispatch, waitForFinish } from "./finalize.ts";
 import type { Deps } from "./ports.ts";
 import { findRun, readRecords, type Run } from "./run-store.ts";
+import { claimRun } from "./sessions.ts";
 import { type NotesPatch, refreshState } from "./state.ts";
 
 export interface DispatchInput {
   run: string;
   role: Role;
@@ -146,10 +147,11 @@ export function watch(deps: Deps, run: Run, d: Dispatch): void {
  * Spec §4.4, plan 9 ruling 1: admit and launch one role, start its watcher, then refresh state.md with
  * `next` (after the launch, so nothing delays it). Returns at once; catherd announces the record (spec §3).
  */
 export async function dispatch(deps: Deps, i: DispatchInput): Promise<DispatchStarted> {
   const run = findRun(i.run);
+  await claimRun(deps, run);
   const { d, specPath } = await admit(deps, run, {
     role: i.role,
     name: i.name,
     brief: i.brief,
     rung: i.rung,
@@ -334,10 +336,12 @@ async function failover(deps: Deps, run: Run, d: Dispatch, limited: RunRecord):
       rung: standIn,
       thread: null,
       lane: d.admit.lane,
       failoverFrom: limited.rung,
       failoverOf: d.admit.dispatchId,
+      // the stand-in answers to the session that dispatched the limited role, whoever fails it over
+      sessionId: d.admit.sessionId ?? null,
     });
   } catch (e) {
     if (!isCatherdError(e)) throw e;
     return {
       hints: [...hints, `failover: ${standIn} refused: ${e.code} ${e.message}`],
```


#### Modify `src/services/dispatches.ts`

```diff
--- a/src/services/dispatches.ts
+++ b/src/services/dispatches.ts
@@ -30,10 +30,12 @@ const AdmitSchema = z.looseObject({
   cliVersion: z.string().nullable(),
   admittedAt: z.string(),
   repo: z.string(),
   /** `git status` fingerprints when admitted, for changedOwned and violations */
   before: z.record(z.string(), z.string()),
+  /** the Claude Code session that dispatched it (spec §3.3); absent on 1.0 dispatches and outside Claude Code */
+  sessionId: z.string().optional(),
 });
 export type Admit = z.infer<typeof AdmitSchema>;
 
 export interface Dispatch {
   dir: string;
```


#### Modify `src/services/finalize.ts`

```diff
--- a/src/services/finalize.ts
+++ b/src/services/finalize.ts
@@ -213,10 +213,11 @@ async function compute(run: Run, d: Dispatch): Promise<RunRecord> {
     access: a.access,
     isolated: a.isolated,
     images: o.images,
     error: o.error,
     replyPath: relative(run.dir, p.reply),
+    ...(a.sessionId ? { sessionId: a.sessionId } : {}),
   };
 }
 
 /**
  * A fresh thread's first-turn input, for the harness-cost line of runs_summary: its first model request's
```


#### Modify `src/services/ports.ts`

```diff
--- a/src/services/ports.ts
+++ b/src/services/ports.ts
@@ -1,6 +1,7 @@
 import type { Budget } from "../domain/budget.ts";
+import type { SessionEnv } from "../infra/claude-session.ts";
 import type { BillingMode } from "../domain/cost.ts";
 import type { Verdict } from "../domain/jev.ts";
 import type { Difficulty, Kind } from "../domain/lane.ts";
 import type { Access } from "../domain/record.ts";
 import type { Role } from "../domain/roles.ts";
@@ -124,7 +125,9 @@ export interface Deps {
   profiles: ProfilePort;
   routing: RoutingPort;
   version: string;
   /** how often the supervisor and the dispatch watchers poll, in ms */
   pollMs: number;
+  /** the Claude Code session this process serves (spec §3.3), from its environment; null outside one */
+  session: SessionEnv | null;
   now: () => number;
 }
```


#### Modify `src/services/run-service.ts`

```diff
--- a/src/services/run-service.ts
+++ b/src/services/run-service.ts
@@ -22,10 +22,11 @@ import {
   findRun,
   knowledgeFile,
   readRecords,
   runFile,
 } from "./run-store.ts";
+import { claimRun, currentSession } from "./sessions.ts";
 import { refreshState } from "./state.ts";
 
 export async function startRun(
   deps: Deps,
   i: { repo: string; title: string; aLines: string[] },
@@ -39,11 +40,13 @@ export async function startRun(
     repo: top,
     title: i.title,
     aLines: i.aLines,
     version: deps.version,
     now: new Date(deps.now()),
+    startedBy: currentSession(deps),
   });
+  await claimRun(deps, run);
   // a failed state.md refresh never fails the start: the run exists and is usable, so a retry would orphan it
   const { hints } = await refreshState(run);
   return { run: run.id, dir: run.dir, ...(hints.length ? { hints } : {}) };
 }
 
```


#### Modify `src/services/run-store.ts`

```diff
--- a/src/services/run-store.ts
+++ b/src/services/run-store.ts
@@ -18,18 +18,27 @@ import {
   readVersioned,
   writeJsonAtomic,
   writeTextAtomic,
 } from "../infra/store.ts";
 
+/** Spec §3.3: the Claude Code session that started a run; absent on 1.0 runs and outside Claude Code. */
+const StartedBySchema = z.object({
+  sessionId: z.string(),
+  hostSessionId: z.string().nullable(),
+  name: z.string().nullable(),
+});
+export type StartedBy = z.infer<typeof StartedBySchema>;
+
 const RunMetaSchema = z.looseObject({
   schema: z.literal(1),
   id: z.string(),
   repo: z.string(),
   title: z.string(),
   aLines: z.array(z.string()),
   createdAt: z.string(),
   catherdVersion: z.string(),
+  startedBy: StartedBySchema.nullable().optional(),
 });
 type RunMeta = z.infer<typeof RunMetaSchema>;
 
 export interface Run {
   id: string;
@@ -50,10 +59,12 @@ export function runPaths(dir: string) {
     routes: join(dir, "routes.jsonl"),
     jev: join(dir, "jev.jsonl"),
     outcomes: join(dir, "outcomes.jsonl"),
     agents: join(dir, "agents.jsonl"),
     harness: join(dir, "harness.jsonl"),
+    /** every session that has owned the run, in order (spec §3.3) */
+    sessions: join(dir, "sessions.jsonl"),
     roles: join(dir, "roles"),
     shots: join(dir, "shots"),
     /** the admission lock's target: `admission.lock` guards dispatch admission */
     admission: join(dir, "admission"),
   };
@@ -69,10 +80,11 @@ export function createRun(o: {
   repo: string;
   title: string;
   aLines: string[];
   version: string;
   now?: Date;
+  startedBy?: StartedBy | null;
 }): Run {
   const now = o.now ?? new Date();
   const root = runsDir(o.repo);
   ensurePrivateDir(root);
   const base = `${stamp(now)}-${runSlug(o.title)}`;
@@ -109,10 +121,11 @@ export function createRun(o: {
     repo: o.repo,
     title: o.title,
     aLines: o.aLines,
     createdAt: now.toISOString(),
     catherdVersion: o.version,
+    ...(o.startedBy ? { startedBy: o.startedBy } : {}),
   };
   writeJsonAtomic(p.meta, meta);
   return { id, dir, meta };
 }
 
@@ -269,10 +282,11 @@ const SERVER_OWNED = new Set([
   "routes.jsonl",
   "jev.jsonl",
   "agents.jsonl",
   "harness.jsonl",
   "outcomes.jsonl",
+  "sessions.jsonl",
 ]);
 
 const present = (p: string) => {
   try {
     lstatSync(p);
```


#### Create `src/services/sessions.ts`

```ts
import { z } from "zod";
import { sessionFileFor } from "../infra/claude-session.ts";
import { withFileLock } from "../infra/filelock.ts";
import { appendJsonl, ensureJsonlHeader, readJsonl, writeJsonAtomic } from "../infra/store.ts";
import type { Deps } from "./ports.ts";
import { type Run, runPaths } from "./run-store.ts";
import { readNotes } from "./state.ts";

/** Spec §4: a Claude Code session as catherd records it. */
export interface SessionRef {
  sessionId: string;
  hostSessionId: string | null;
  name: string | null;
}

/**
 * The session this process serves (spec §3.3), read live: its registry file's id and name when it has one (the
 * id in the environment goes stale after /clear), else the environment's. Null outside Claude Code.
 */
export function currentSession(deps: Deps): SessionRef | null {
  const env = deps.session;
  if (!env) return null;
  const file = sessionFileFor(env);
  const sessionId = file?.sessionId ?? env.sessionId;
  if (!sessionId) return null;
  return { sessionId, hostSessionId: file?.hostSessionId ?? env.hostSessionId, name: file?.name ?? null };
}

const OwnerSchema = z.object({ sessionId: z.string(), since: z.string() });
export type Owner = z.infer<typeof OwnerSchema>;

/** The run's owner session (state.json `owner`), or null for a run no session has owned (1.0, a terminal). */
export function runOwner(run: Run): Owner | null {
  const r = OwnerSchema.safeParse((readNotes(run) as Record<string, unknown>).owner);
  return r.success ? r.data : null;
}

const SessionRowSchema = z.looseObject({
  sessionId: z.string(),
  hostSessionId: z.string().nullable(),
  name: z.string().nullable(),
  at: z.string(),
});
export type SessionRow = z.infer<typeof SessionRowSchema>;

/** `R/sessions.jsonl`: every session that has owned the run, in the order they took it. */
export function readSessionRows(run: Run): SessionRow[] {
  return readJsonl<unknown>(runPaths(run.dir).sessions).rows.flatMap((row) => {
    const r = SessionRowSchema.safeParse(row);
    return r.success ? [r.data] : [];
  });
}

/**
 * Spec §3.3: `run_start`, `dispatch` and `peek` make the calling session the run's owner when it is not, and
 * append it to `R/sessions.jsonl`: that is how a run moves when it is continued from another session. Outside
 * Claude Code it changes nothing. Returns whether the owner changed.
 */
export async function claimRun(deps: Deps, run: Run): Promise<boolean> {
  const me = currentSession(deps);
  if (!me) return false;
  const p = runPaths(run.dir);
  const at = new Date(deps.now()).toISOString();
  const changed = await withFileLock(p.stateJson, () => {
    const notes = readNotes(run);
    if (runOwner(run)?.sessionId === me.sessionId) return false;
    writeJsonAtomic(p.stateJson, { ...notes, owner: { sessionId: me.sessionId, since: at } });
    return true;
  });
  if (changed) {
    ensureJsonlHeader(p.sessions, "sessions");
    appendJsonl(p.sessions, { sessionId: me.sessionId, hostSessionId: me.hostSessionId, name: me.name, at });
  }
  return changed;
}
```

- [ ] **Step 4: Run the gate**

Run the gate. Expected: clean. Scratch count after this task: 1195 pass, 10 skip, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(push): session identity, run ownership and sessions.jsonl; no child gets the inbox token"
```

---

### Task 5: The notifier

Spec §3.4–§3.6: a settled hook, started only by `startMcpServer` (Ruling 8). For a run this session owns, a settled dispatch whose record is still unread and not yet announced is queued; notices go as one message after 3 s of quiet (Ruling 12); `notified.json` records the message; on start the notifier scans owned runs for unread, unannounced records (a limit not yet failed over is left to reconcile's settle, whose hook announces it). A limit's notice says what failover did and goes `next`, as does a `blocked`/`refused` reply. A claim that changes a run's owner **adopts** its live dispatches (Ruling 9), with a `watching` set shared by the dispatch watchers and reconcile. The server logs, at start, which session variables it got (keys only: the live check of §3.9).

**Files:**
- Create: `test/services/notifier.test.ts`
- Modify: `src/entry/mcp/server.ts`
- Modify: `src/infra/dispatch-dir.ts`
- Modify: `src/services/dispatch-service.ts`
- Create: `src/services/notifier.ts`
- Modify: `src/services/reconcile.ts`

**Interfaces:**
- Consumes: `sendToInbox`, `formatNotices`, `envelope`, `priorityOf`, `Notice` (Task 2); `settle`, `settledHooks`, `readFailover` (Task 3); `currentSession`, `runOwner`, `claimRun` (Task 4).
- Produces: `startNotifier(deps, { coalesceMs?, send? }): Notifier` with `{ onSettled(s), scan(), idle(), stop() }`, `finishedNotice(run, d, record): Notice` (`src/services/notifier.ts`); `dispatchPaths(dir).notified`; `adopt(deps, run)`, `watching` (`src/services/dispatch-service.ts`).

- [ ] **Step 1: Write the failing tests**

#### Create `test/services/notifier.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigDir, type SessionEnv } from "../../src/infra/claude-session.ts";
import { awaitsCollect, dispatchPaths } from "../../src/infra/dispatch-dir.ts";
import { resetReadiness } from "../../src/services/backends.ts";
import { adopt, dispatch, settle, watchersSettled } from "../../src/services/dispatch-service.ts";
import { processStartTime } from "../../src/infra/proc.ts";
import type { Dispatch } from "../../src/services/dispatches.ts";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import { type Notifier, startNotifier } from "../../src/services/notifier.ts";
import { result } from "../../src/services/run-service.ts";
import type { Run } from "../../src/services/run-store.ts";
import { claimRun } from "../../src/services/sessions.ts";
import { snapshotEnv } from "../helpers.ts";
import { type FakeInbox, fakeInbox } from "../sim/peer-inbox.ts";
import { simPath, withScenario } from "../sim/scenario.ts";
import { deadProcess, fakeDeps, fakeDispatch, freshRun, testView, writeLane } from "./helpers.ts";

afterEach(() => watchersSettled());
afterEach(snapshotEnv());
beforeEach(() => resetReadiness());

let inbox: FakeInbox | null = null;
const notifiers: Notifier[] = [];
afterEach(async () => {
  for (const n of notifiers.splice(0)) n.stop();
  await inbox?.close();
  inbox = null;
});

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
const exit = (code = 0) => ({
  code,
  signal: null,
  reason: "exited" as const,
  endedAt: new Date().toISOString(),
});

/** A live session (registry file and environment) whose inbox is the fake one. */
async function sessionWithInbox(id = "s-me", pid = 201): Promise<SessionEnv> {
  inbox = await fakeInbox();
  const dir = join(claudeConfigDir(), "sessions");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId: id, name: "auth build", messagingSocketPath: inbox.path }),
  );
  return { sessionId: id, hostSessionId: null, socketPath: inbox.path, token: "child-token" };
}

/** A finished, recorded, unread dispatch of `run`, as a watcher leaves it before its settle. */
async function finished(run: Run, name: string, reply = "Done.\nSTATUS: complete — ok"): Promise<Dispatch> {
  const d = await fakeDispatch(
    run,
    { name, lane: name.replace(/^worker-/, "") },
    { proc: "dead", exit: exit(), reply, collect: true },
  );
  await finalizeDispatch(run, d);
  return d;
}

async function owned(o: { coalesceMs?: number } = {}) {
  const { run } = freshRun("Auth plan 5 MR B");
  const session = await sessionWithInbox();
  const deps = fakeDeps({ session });
  await claimRun(deps, run);
  const n = startNotifier(deps, { coalesceMs: o.coalesceMs ?? 20 });
  notifiers.push(n);
  return { run, deps, n };
}

const recordOf = async (run: Run, d: Dispatch) => finalizeDispatch(run, d);

describe("the notifier (spec §3.4–§3.6)", () => {
  it("announces a finished role of a run this session owns, at later, and writes notified.json", async () => {
    const { run, deps, n } = await owned();
    const d = await finished(run, "worker-M1.L1");
    await settle(deps, run, d, await recordOf(run, d));
    await n.idle();
    const [f] = await (inbox as FakeInbox).received(1);
    expect(f?.priority).toBe("later");
    expect(f?.auth).toEqual({ type: "auth", token: "child-token" });
    const content = f?.message.content ?? "";
    expect(
      content.startsWith(
        '<cross-session-message from-name="catherd">\ncatherd · Auth plan 5 MR B · worker-M1.L1 worker',
      ),
    ).toBe(true);
    expect(content).toContain("· ok · STATUS: complete · ");
    expect(content).toContain(`Record: result(run: "${run.id}", name: "worker-M1.L1")`);
    expect(JSON.parse(readFileSync(dispatchPaths(d.dir).notified, "utf8"))).toMatchObject({
      schema: 1,
      msgId: f?.msg_id,
    });
    // announced, not read: the record stays unread until result reads it
    expect(awaitsCollect(d.dir)).toBe(true);
  });

  it("sends roles that finish within the window as one message", async () => {
    const { run, deps, n } = await owned({ coalesceMs: 200 });
    const a = await finished(run, "worker-M1.L1");
    const b = await finished(run, "worker-M1.L2");
    await settle(deps, run, a, await recordOf(run, a));
    await settle(deps, run, b, await recordOf(run, b));
    await n.idle();
    const [f] = await (inbox as FakeInbox).received(1);
    expect(inbox?.frames).toHaveLength(1);
    expect(f?.message.content).toContain("catherd · Auth plan 5 MR B · 2 roles finished: M1.L1 ok, M1.L2 ok");
  });

  it("sends a role that finishes after the message went as a message of its own", async () => {
    const { run, deps, n } = await owned();
    const a = await finished(run, "worker-M1.L1");
    await settle(deps, run, a, await recordOf(run, a));
    await n.idle();
    const b = await finished(run, "worker-M1.L2");
    await settle(deps, run, b, await recordOf(run, b));
    await n.idle();
    const frames = await (inbox as FakeInbox).received(2);
    expect(frames.map((f) => f.message.content.split("\n")[1]?.split(" · ")[2])).toEqual([
      "worker-M1.L1 worker",
      "worker-M1.L2 worker",
    ]);
  });

  it("never announces a record twice, across a restart (notified.json)", async () => {
    const { run, deps, n } = await owned();
    const d = await finished(run, "worker-M1.L1");
    await settle(deps, run, d, await recordOf(run, d));
    await n.idle();
    n.stop();
    const again = startNotifier(deps, { coalesceMs: 20 });
    notifiers.push(again);
    await again.scan();
    await settle(deps, run, d, await recordOf(run, d));
    await again.idle();
    await (inbox as FakeInbox).received(1);
    expect(inbox?.frames).toHaveLength(1);
  });

  it("announces, on start, every unread record of an owned run that no message announced", async () => {
    const { run, deps } = await owned();
    // finished while no server ran: recorded (by reconcile, say) with no notifier to hear it
    notifiers.splice(0).forEach((x) => x.stop());
    const a = await finished(run, "worker-M1.L1");
    const b = await finished(run, "worker-M1.L2");
    const read = await finished(run, "worker-M1.L3");
    await result(deps, { run: run.id, name: "worker-M1.L3" });
    const n = startNotifier(deps, { coalesceMs: 20 });
    notifiers.push(n);
    await n.scan();
    await n.idle();
    const [f] = await (inbox as FakeInbox).received(1);
    expect(inbox?.frames).toHaveLength(1);
    expect(f?.message.content).toContain("2 roles finished: M1.L1 ok, M1.L2 ok");
    expect([a, b, read].map((d) => existsSync(dispatchPaths(d.dir).notified))).toEqual([true, true, false]);
  });

  it("says nothing of a run another session owns, a run no session owns, or a record already read", async () => {
    const { run, deps, n } = await owned();
    const read = await finished(run, "worker-M1.L1");
    await result(deps, { run: run.id, name: "worker-M1.L1" });
    await settle(deps, run, read, await recordOf(run, read));
    const theirs = freshRun("theirs").run;
    await claimRun(
      fakeDeps({ session: { sessionId: "s-other", hostSessionId: null, socketPath: null, token: null } }),
      theirs,
    );
    const t = await finished(theirs, "worker-M1.L1");
    await settle(deps, theirs, t, await recordOf(theirs, t));
    const nobody = freshRun("nobody's").run;
    const x = await finished(nobody, "worker-M1.L1");
    await settle(deps, nobody, x, await recordOf(nobody, x));
    await n.idle();
    expect(inbox?.frames).toEqual([]);
    expect([read, t, x].map((d) => existsSync(dispatchPaths(d.dir).notified))).toEqual([false, false, false]);
  });

  it("tells a session that took a run over about the live roles another session's server launched", async () => {
    const { run } = freshRun("Auth plan 5 MR B");
    // launched by a server that is gone: nothing in this process watches it
    const worker = Bun.spawn(["sh", "-c", "read x"], { stdin: "pipe", env: process.env });
    const d = await fakeDispatch(
      run,
      { sessionId: "s-before" },
      {
        proc: {
          pid: worker.pid,
          startTime: processStartTime(worker.pid),
          supervisorPid: await deadProcess(),
          supervisorStartTime: "gone",
        },
        reply: "Done.\nSTATUS: complete — ok",
        collect: true,
      },
    );
    const deps = fakeDeps({ session: await sessionWithInbox("s-now", 202) });
    const n = startNotifier(deps, { coalesceMs: 20 });
    notifiers.push(n);
    expect(await claimRun(deps, run)).toBe(true);
    adopt(deps, run);
    worker.stdin.end();
    await worker.exited;
    const [f] = await (inbox as FakeInbox).received(1);
    expect(f?.message.content).toContain(`name: "${d.admit.name}"`);
  });

  it("drops a notice whose record was read before the message went out", async () => {
    const { run, deps, n } = await owned({ coalesceMs: 200 });
    const d = await finished(run, "worker-M1.L1");
    await settle(deps, run, d, await recordOf(run, d));
    // the orchestrator read it (a peek showed it, say) inside the window
    await result(deps, { run: run.id, name: "worker-M1.L1" });
    await n.idle();
    expect(inbox?.frames).toEqual([]);
    expect(existsSync(dispatchPaths(d.dir).notified)).toBe(false);
  });

  it("announces a blocked or refused reply at next", async () => {
    const { run, deps } = await owned();
    const d = await finished(run, "worker-M1.L1", "Cannot.\nSTATUS: blocked — no network");
    await settle(deps, run, d, await recordOf(run, d));
    const [f] = await (inbox as FakeInbox).received(1);
    expect(f?.priority).toBe("next");
    expect(f?.message.content).toContain("STATUS: blocked");
  });

  it("sends nothing without a session, and the record stays unread", async () => {
    const { run } = freshRun();
    const deps = fakeDeps();
    const n = startNotifier(deps, { coalesceMs: 20 });
    notifiers.push(n);
    const d = await finished(run, "worker-M1.L1");
    await settle(deps, run, d, await recordOf(run, d));
    await n.scan();
    await n.idle();
    expect(existsSync(dispatchPaths(d.dir).notified)).toBe(false);
    expect(awaitsCollect(d.dir)).toBe(true);
  });

  it("writes nothing when the session's socket is gone: the record waits for peek or result", async () => {
    const { run, deps, n } = await owned();
    await inbox?.close();
    inbox = null;
    const d = await finished(run, "worker-M1.L1");
    await settle(deps, run, d, await recordOf(run, d));
    await n.idle();
    expect(existsSync(dispatchPaths(d.dir).notified)).toBe(false);
  });

  it("fails over a usage limit first, then says so at next; the stand-in's record follows at later", async () => {
    const release = join(mkdtempSync(join(tmpdir(), "catherd-hold-")), "release");
    const { run } = freshRun("Auth plan 5 MR B");
    process.env.PATH = simPath();
    Object.assign(
      process.env,
      withScenario({
        byRung: {
          "gpt-6-sol#medium": { eventsFile: join(FX, "limit.jsonl"), exitCode: 1 },
          "gpt-6-sol#high": { reply: "Done.\nSTATUS: complete — ok", holdUntil: release },
        },
      }).env,
    );
    writeLane(run, "M1.L1", ["src/a.ts"]);
    const session = await sessionWithInbox();
    const deps = fakeDeps({
      session,
      view: testView({ failover: { "codex:gpt-6-sol#medium": "codex:gpt-6-sol#high" } }),
    });
    const n = startNotifier(deps, { coalesceMs: 20 });
    notifiers.push(n);
    await dispatch(deps, {
      run: run.id,
      role: "worker",
      name: "worker-M1.L1",
      brief: "b",
      rung: "codex:gpt-6-sol#medium",
      lane: "M1.L1",
    });
    const [limit] = await (inbox as FakeInbox).received(1);
    expect(limit?.priority).toBe("next");
    expect(limit?.message.content).toContain(
      "· limit on codex:gpt-6-sol#medium; failed over to codex:gpt-6-sol#high · no STATUS ·",
    );
    writeFileSync(release, "");
    const frames = await (inbox as FakeInbox).received(2);
    expect(frames[1]?.priority).toBe("later");
    expect(frames[1]?.message.content).toContain("· codex:gpt-6-sol#high · ok · STATUS: complete ·");
  });
});
```


- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/services/notifier.test.ts`. Expected: FAIL — `Cannot find module` for `src/services/notifier.ts` (then `adopt` not exported).

- [ ] **Step 3: Write the notifier and start it with the server**

#### Modify `src/entry/mcp/server.ts`

```diff
--- a/src/entry/mcp/server.ts
+++ b/src/entry/mcp/server.ts
@@ -1,10 +1,11 @@
 import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
 import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
 import { errorMessage } from "../../domain/errors.ts";
 import { log } from "../../infra/log.ts";
+import { startNotifier } from "../../services/notifier.ts";
 import type { Deps } from "../../services/ports.ts";
 import { reconcileAll } from "../../services/reconcile.ts";
 import { defaultDeps } from "../deps.ts";
 import { registerDispatchTools } from "./dispatch-tools.ts";
 import { registerLaneTools } from "./lane-tools.ts";
@@ -53,13 +54,24 @@ export function buildServer(deps: Deps = defaultDeps()): McpServer {
   registerDispatchTools(server, deps);
   registerSetupTools(server, deps);
   return server;
 }
 
-/** Spec §4.7: connect first, so the client never waits on a scan; then reconcile every run. */
+/**
+ * Spec §4.7: connect first, so the client never waits on a scan; then reconcile every run. Spec §3.4: the notifier
+ * starts before reconcile, so what reconcile settles is announced, and scans for the rest once it is done.
+ */
 export async function startMcpServer(): Promise<void> {
   const deps = defaultDeps();
+  // which of the session's variables this server got (never their values): the live check of spec §3.9
+  log("info", "session", {
+    sessionId: Boolean(deps.session?.sessionId),
+    hostSessionId: Boolean(deps.session?.hostSessionId),
+    socket: Boolean(deps.session?.socketPath),
+    token: Boolean(deps.session?.token),
+  });
+  const notifier = startNotifier(deps);
   await buildServer(deps).connect(new StdioServerTransport());
   try {
     const r = await reconcileAll(deps);
     const shown = r.warnings.length;
     for (const w of r.warnings) console.error(`catherd: ${w}`);
@@ -67,6 +79,8 @@ export async function startMcpServer(): Promise<void> {
       for (const w of r.warnings.slice(shown)) console.error(`catherd: ${w}`);
     });
   } catch (e) {
     console.error(`catherd: reconcile failed: ${errorMessage(e)}`);
   }
+  // whatever finished unread while no server ran, or finished under another server (spec §3.4)
+  void notifier.scan();
 }
```


#### Modify `src/infra/dispatch-dir.ts`

```diff
--- a/src/infra/dispatch-dir.ts
+++ b/src/infra/dispatch-dir.ts
@@ -36,10 +36,12 @@ export function dispatchPaths(dir: string) {
     /** while a reader takes the record: names that reader's process, so a crash leaves it reclaimable */
     lease: join(dir, "collect.lease"),
     supervisorLog: join(dir, "supervisor.log"),
     /** what failover did for this limited dispatch, written once under `failover.lock` (plan 10) */
     failover: join(dir, "failover.json"),
+    /** the message that announced this dispatch's record to its session, once sent (plan 10) */
+    notified: join(dir, "notified.json"),
   };
 }
 
 /**
  * Exclusive create: the first caller finalizes; every later caller reads the record it wrote. The claim
```


#### Modify `src/services/dispatch-service.ts`

```diff
--- a/src/services/dispatch-service.ts
+++ b/src/services/dispatch-service.ts
@@ -118,10 +118,12 @@ function start(d: Dispatch, specPath: string): void {
   }
 }
 
 /** The watchers this process started, each until its dispatch is settled. */
 const watchers = new Set<Promise<void>>();
+/** The dispatches some watcher of this process is on (this module's, or reconcile's): watched once each. */
+export const watching = new Set<string>();
 
 /** Settles once every watcher has: tests await it so none outlives its test. */
 export async function watchersSettled(): Promise<void> {
   while (watchers.size > 0) await Promise.all(watchers);
 }
@@ -129,29 +131,42 @@ export async function watchersSettled(): Promise<void> {
 /**
  * Finalizes a dispatch as soon as it exits and settles it (failover, state.md, the settled hooks), so its
  * after-snapshot holds only its own writes and the live list and the spend stay true. Its errors are logged.
  */
 export function watch(deps: Deps, run: Run, d: Dispatch): void {
+  watching.add(d.admit.dispatchId);
   const w = (async () => {
     await waitForFinish(d, { pollMs: deps.pollMs, now: deps.now });
     const s = await settle(deps, run, d, await finalizeDispatch(run, d));
     if (s.stateHints[0]) log("warn", "dispatch", { run: run.id, name: d.admit.name, hint: s.stateHints[0] });
   })()
     .catch((e: unknown) =>
       log("warn", "dispatch", { run: run.id, name: d.admit.name, error: errorMessage(e) }),
     )
-    .finally(() => watchers.delete(w));
+    .finally(() => {
+      watchers.delete(w);
+      watching.delete(d.admit.dispatchId);
+    });
   watchers.add(w);
 }
 
+/**
+ * Spec §3.3: a run this session has just taken over may have roles another session's server launched. This
+ * process watches each live one it is not already watching, so it settles them and its notifier announces them
+ * to their new owner (a second settle of a dispatch is harmless: finalize and failover run once).
+ */
+export function adopt(deps: Deps, run: Run): void {
+  for (const d of liveDispatches(run, deps.now())) if (!watching.has(d.admit.dispatchId)) watch(deps, run, d);
+}
+
 /**
  * Spec §4.4, plan 9 ruling 1: admit and launch one role, start its watcher, then refresh state.md with
  * `next` (after the launch, so nothing delays it). Returns at once; catherd announces the record (spec §3).
  */
 export async function dispatch(deps: Deps, i: DispatchInput): Promise<DispatchStarted> {
   const run = findRun(i.run);
-  await claimRun(deps, run);
+  if (await claimRun(deps, run)) adopt(deps, run);
   const { d, specPath } = await admit(deps, run, {
     role: i.role,
     name: i.name,
     brief: i.brief,
     rung: i.rung,
```


#### Create `src/services/notifier.ts`

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage } from "../domain/errors.ts";
import { envelope, formatNotices, type Notice, type NoticePriority, priorityOf } from "../domain/notice.ts";
import type { RunRecord } from "../domain/record.ts";
import { awaitsCollect, dispatchPaths } from "../infra/dispatch-dir.ts";
import { log } from "../infra/log.ts";
import { type SendResult, sendToInbox } from "../infra/peer-inbox.ts";
import { writeJsonAtomic } from "../infra/store.ts";
import { type Settled, settledHooks } from "./dispatch-service.ts";
import { type Dispatch, listDispatches, readFailover } from "./dispatches.ts";
import type { Deps } from "./ports.ts";
import { listRuns, readRecords, type Run } from "./run-store.ts";
import { currentSession, runOwner } from "./sessions.ts";

/**
 * Spec §3.4: runs only inside the MCP server, the session's child and so its only sender (§3.2). For every run this
 * session owns, a dispatch that is settled with its record still unread is announced to the session's peer inbox;
 * notices that arrive within the window of each other go as one message; a message that went out is written down
 * (`notified.json`), so a restart never sends it twice. Disk stays the truth: a notice that cannot be sent is
 * dropped, and the record waits, unread, for `result` or `peek`.
 */

export interface NotifierOptions {
  /** notices this close to each other go as one message (spec: 3 s); tests shorten it */
  coalesceMs?: number;
  /** the sender; tests may replace it */
  send?: (
    target: { socketPath: string | null; token: string | null },
    content: string,
    p: NoticePriority,
  ) => Promise<SendResult>;
}

export interface Notifier {
  /** the settled hook: queues the dispatch's notice when this session should hear of it */
  onSettled(s: Settled): void;
  /** spec §3.4 "a scan on start": every unread, un-notified record of a run this session owns */
  scan(): Promise<void>;
  /** resolves once nothing is queued and no message is on its way */
  idle(): Promise<void>;
  /** removes the hook and drops what is queued */
  stop(): void;
}

const notified = (dir: string): boolean => existsSync(dispatchPaths(dir).notified);

function replyOf(run: Run, r: RunRecord): string {
  try {
    return readFileSync(join(run.dir, r.replyPath), "utf8");
  } catch {
    return "";
  }
}

/** Spec §3.5/§3.6: one finished role's notice, with what failover did in place of a limit's status. */
export function finishedNotice(run: Run, d: Dispatch, r: RunRecord): Notice {
  const fo = readFailover(d.dir);
  let status: string = r.status;
  if (r.status === "limit") {
    const why = fo?.standIn
      ? `failed over to ${fo.standIn.rung}`
      : fo?.hints.some((h) => h.startsWith("failover: run "))
        ? "its stand-in is a Claude agent: result(run, name) has the hint"
        : fo?.hints.some((h) => h.startsWith("failover: "))
          ? "paused: the stand-in was refused"
          : "paused: no stand-in";
    status = `limit on ${r.rung}; ${why}`;
  }
  const urgent = r.status === "limit" || r.replyStatus === "blocked" || r.replyStatus === "refused";
  return {
    kind: "finished",
    runId: run.id,
    runTitle: run.meta.title,
    dispatchId: r.dispatchId,
    name: r.name,
    role: r.role,
    lane: r.lane,
    rung: r.rung,
    status,
    replyStatus: r.replyStatus,
    secs: r.secs,
    changedOwned: r.changedOwned.length,
    reply: replyOf(run, r),
    priority: urgent ? "next" : "later",
  };
}

interface Queued {
  notice: Notice;
  dir: string;
}

/** Starts the notifier for this process's session and hooks it to every settled dispatch. */
export function startNotifier(deps: Deps, o: NotifierOptions = {}): Notifier {
  const window = o.coalesceMs ?? 3_000;
  const send = o.send ?? sendToInbox;
  const queue = new Map<string, Queued>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let firstAt = 0;
  let flight: Promise<void> = Promise.resolve();

  /** This session's id, when there is one and it owns the run. */
  const owned = (run: Run): boolean => {
    const me = currentSession(deps);
    return me !== null && runOwner(run)?.sessionId === me.sessionId;
  };

  const flush = (): void => {
    timer = null;
    const batch = [...queue.values()];
    queue.clear();
    flight = flight.then(() => deliver(batch));
  };

  const schedule = (): void => {
    const now = Date.now();
    if (timer === null) firstAt = now;
    else clearTimeout(timer);
    // quiet for `window`, but never held past five windows: a steady trickle still goes out
    timer = setTimeout(flush, Math.max(0, Math.min(window, firstAt + 5 * window - now)));
  };

  async function deliver(batch: Queued[]): Promise<void> {
    // read (or announced) meanwhile: nothing to say
    const due = batch.filter((q) => awaitsCollect(q.dir) && !notified(q.dir));
    if (due.length === 0 || !deps.session) return;
    const notices = due.map((q) => q.notice);
    const r = await send(
      { socketPath: deps.session.socketPath, token: deps.session.token },
      envelope(formatNotices(notices)),
      priorityOf(notices),
    ).catch((e: unknown): SendResult => ({ outcome: "error", reason: errorMessage(e) }));
    if (r.outcome !== "sent") {
      log("warn", "notify", {
        outcome: r.outcome,
        reason: r.reason,
        dispatches: notices.map((n) => n.dispatchId),
      });
      return;
    }
    const at = new Date(deps.now()).toISOString();
    for (const q of due) writeJsonAtomic(dispatchPaths(q.dir).notified, { schema: 1, msgId: r.msgId, at });
    log("info", "notify", { msgId: r.msgId, dispatches: notices.map((n) => n.dispatchId) });
  }

  const enqueue = (run: Run, d: Dispatch, record: RunRecord): void => {
    if (queue.has(record.dispatchId) || notified(d.dir) || !awaitsCollect(d.dir) || !owned(run)) return;
    queue.set(record.dispatchId, { notice: finishedNotice(run, d, record), dir: d.dir });
    schedule();
  };

  const onSettled = (s: Settled): void => {
    try {
      enqueue(s.run, s.d, s.record);
    } catch (e) {
      log("warn", "notify", { run: s.run.id, name: s.d.admit.name, error: errorMessage(e) });
    }
  };

  const n: Notifier = {
    onSettled,
    async scan() {
      if (!currentSession(deps)) return;
      for (const run of listRuns().runs) {
        try {
          if (!owned(run)) continue;
          const records = new Map(readRecords(run).records.map((r) => [r.dispatchId, r]));
          for (const d of listDispatches(run)) {
            const r = records.get(d.admit.dispatchId);
            // a limit not yet failed over is reconcile's to settle first: its hook announces it then
            if (r && !(r.status === "limit" && !readFailover(d.dir))) enqueue(run, d, r);
          }
        } catch (e) {
          log("warn", "notify", { run: run.id, error: errorMessage(e) });
        }
      }
    },
    async idle() {
      for (;;) {
        if (timer === null && queue.size === 0) {
          await flight;
          if (timer === null && queue.size === 0) return;
        } else await Bun.sleep(5);
      }
    },
    stop() {
      settledHooks.delete(onSettled);
      if (timer !== null) clearTimeout(timer);
      timer = null;
      queue.clear();
    },
  };
  settledHooks.add(onSettled);
  return n;
}
```


#### Modify `src/services/reconcile.ts`

```diff
--- a/src/services/reconcile.ts
+++ b/src/services/reconcile.ts
@@ -1,11 +1,11 @@
 import { readFileSync, statSync } from "node:fs";
 import { errorMessage } from "../domain/errors.ts";
 import { dispatchPaths } from "../infra/dispatch-dir.ts";
 import { log } from "../infra/log.ts";
 import { writeJsonAtomic } from "../infra/store.ts";
-import { settle, unsettledLimits } from "./dispatch-service.ts";
+import { settle, unsettledLimits, watching } from "./dispatch-service.ts";
 import { type Dispatch, listDispatches, pendingDispatches } from "./dispatches.ts";
 import { finalizeDispatch, waitForFinish } from "./finalize.ts";
 import type { Deps } from "./ports.ts";
 import { listRuns, type Run } from "./run-store.ts";
 
@@ -41,13 +41,18 @@ export interface ReconcileReport {
 /**
  * Waits for a live dispatch this process did not start, then finalizes and settles it (plan 10). A state.md
  * refresh that fails rejects, after the record is written, with a message that says so.
  */
 async function watchAndFinalize(deps: Deps, run: Run, d: Dispatch): Promise<void> {
-  await waitForFinish(d, { pollMs: deps.pollMs, now: deps.now });
-  const s = await settle(deps, run, d, await finalizeDispatch(run, d));
-  if (s.stateHints[0]) throw new Error(s.stateHints[0]);
+  watching.add(d.admit.dispatchId);
+  try {
+    await waitForFinish(d, { pollMs: deps.pollMs, now: deps.now });
+    const s = await settle(deps, run, d, await finalizeDispatch(run, d));
+    if (s.stateHints[0]) throw new Error(s.stateHints[0]);
+  } finally {
+    watching.delete(d.admit.dispatchId);
+  }
 }
 
 /**
  * Spec §4.7: on server start, finalize and settle each finished dispatch that has no record, settle each
  * unread usage limit that was never failed over (its server died between the two), and watch each live one
```

- [ ] **Step 4: Run the gate**

Run the gate. Expected: clean. Scratch count after this task: 1207 pass, 10 skip, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(push): the notifier: coalesced notices, notified.json, a start scan, failover first"
```

---

### Task 6: Stalls: the supervisor reports one, the notifier announces it

Spec §3.6's stall row: "The supervisor sees a stall (no event for half the idle timeout while not busy) — yes, once per dispatch — `next`". The supervisor (the detached process, which never sends: §3.2) writes `stall.json` once; each watcher (`watch`, reconcile's) checks for it on its poll and calls the stall hooks once; the notifier queues a stalled notice once (`stall-notified.json`), dropped if the role finished first. Ruling 14.

**Files:**
- Modify: `test/infra/supervisor.test.ts`
- Modify: `test/services/dispatch.test.ts`
- Modify: `test/services/notifier.test.ts`
- Modify: `src/infra/dispatch-dir.ts`
- Modify: `src/infra/supervisor.ts`
- Modify: `src/services/dispatch-service.ts`
- Modify: `src/services/finalize.ts`
- Modify: `src/services/notifier.ts`
- Modify: `src/services/reconcile.ts`

**Interfaces:**
- Consumes: `startNotifier`, `owned` logic (Task 5); `waitForFinish` (Task 3).
- Produces: `dispatchPaths(dir).stall | stallNotified`; `interface Stalled { run; d; quietMs }`, `stallHooks`, `stallPoll(run, d)` (`src/services/dispatch-service.ts`); `waitForFinish(d, { pollMs, now, onPoll? })`; `Notifier.onStall(s)`, `stalledNotice(run, d, quietMs, now)`.

- [ ] **Step 1: Write the failing tests**

#### Modify `test/infra/supervisor.test.ts`

```diff
--- a/test/infra/supervisor.test.ts
+++ b/test/infra/supervisor.test.ts
@@ -93,10 +93,50 @@ describe("supervise", () => {
     expect(exit?.reason).toBe("cancelled");
     expect(exit?.signal).toBe("SIGKILL");
   });
 });
 
+describe("supervise reports a stall (spec §3.6)", () => {
+  it("writes stall.json once the worker is quiet for half its idle timeout and not busy", async () => {
+    const s = spec(`echo '{"type":"a"}'; sleep 30`, { idleMs: 400 });
+    const exit = await supervise(s, { isBusy: async () => false });
+    expect(exit?.reason).toBe("idle-timeout");
+    const stall = JSON.parse(readFileSync(dispatchPaths(s.dispatchDir).stall, "utf8"));
+    expect(stall).toMatchObject({ schema: 1, at: expect.any(String) });
+    expect(stall.quietMs).toBeGreaterThanOrEqual(200);
+  });
+
+  it("writes it once per dispatch, however many quiet stretches follow", async () => {
+    // quiet, a line, quiet again: the second stretch is a stall too, and is not reported again
+    const s = spec(`sleep 0.4; echo '{"type":"a"}'; sleep 0.4; echo '{"type":"b"}'`, { idleMs: 600 });
+    let first: string | null = null;
+    const exit = await supervise(s, {
+      isBusy: async () => false,
+      onLine: () => {
+        first ??= readFileSync(dispatchPaths(s.dispatchDir).stall, "utf8");
+        return {};
+      },
+    });
+    expect(exit?.reason).toBe("exited");
+    expect(first).not.toBeNull();
+    expect(readFileSync(dispatchPaths(s.dispatchDir).stall, "utf8")).toBe(first as unknown as string);
+  });
+
+  it("reports no stall while the worker is busy, or has a tool call open", async () => {
+    const busy = spec("sleep 30", { idleMs: 200, wallMs: 600 });
+    expect((await supervise(busy, { isBusy: async () => true }))?.reason).toBe("wall-timeout");
+    expect(existsSync(dispatchPaths(busy.dispatchDir).stall)).toBe(false);
+    const open = spec(`echo '{"open":"t1"}'; sleep 30`, { idleMs: 200, wallMs: 600 });
+    const exit = await supervise(open, {
+      onLine: (l) => (l.includes("open") ? { item: { id: "t1", open: true } } : {}),
+      isBusy: async () => false,
+    });
+    expect(exit?.reason).toBe("wall-timeout");
+    expect(existsSync(dispatchPaths(open.dispatchDir).stall)).toBe(false);
+  });
+});
+
 describe("supervise always leaves exit.json and no live worker", () => {
   it("records a binary that cannot be spawned as lost, with the error in stderr", async () => {
     const s = { ...spec(""), cmd: "catherd-no-such-binary-4f2a", args: [] };
     const exit = await supervise(s);
     expect(exit).toMatchObject({ code: null, signal: null, reason: "lost" });
```


#### Modify `test/services/dispatch.test.ts`

```diff
--- a/test/services/dispatch.test.ts
+++ b/test/services/dispatch.test.ts
@@ -10,10 +10,12 @@ import {
   dispatch,
   type DispatchInput,
   launcher,
   type Settled,
   settledHooks,
+  type Stalled,
+  stallHooks,
   watchersSettled,
 } from "../../src/services/dispatch-service.ts";
 import { admit } from "../../src/services/admission.ts";
 import { listDispatches, liveDispatches, startLimits } from "../../src/services/dispatches.ts";
 import { finalizeDispatch } from "../../src/services/finalize.ts";
@@ -274,10 +276,31 @@ describe("dispatch returns at launch; its watcher settles it; result reads it (p
     }
     expect(seen).toEqual(["worker-M1.L1 ok"]);
     expect(readFileSync(runPaths(run.dir).state, "utf8")).toContain("Running:\n- none");
   });
 
+  it("tells the stall hooks, once, when the supervisor reports a stall", async () => {
+    const release = holdFile();
+    const { run, deps } = setup({ ...OK, holdUntil: release });
+    const seen: string[] = [];
+    const hook = (s: Stalled) => {
+      seen.push(`${s.d.admit.name} ${s.quietMs}`);
+    };
+    stallHooks.add(hook);
+    try {
+      await dispatch(deps, input(run.id));
+      const d = listDispatches(run)[0] as { dir: string };
+      writeFileSync(dispatchPaths(d.dir).stall, JSON.stringify({ schema: 1, at: "x", quietMs: 450_000 }));
+      await waitFor(() => seen.length > 0);
+      writeFileSync(release, "");
+      await watchersSettled();
+    } finally {
+      stallHooks.delete(hook);
+    }
+    expect(seen).toEqual(["worker-M1.L1 450000"]);
+  });
+
   it("keeps the mark when the launch throws: dispatch says so, and the lost record is settled and read (M-4)", async () => {
     const { run, deps } = setup(OK);
     startLimits.graceMs = 300;
     const real = launcher.launch;
     launcher.launch = () => {
```


#### Modify `test/services/notifier.test.ts`

```diff
--- a/test/services/notifier.test.ts
+++ b/test/services/notifier.test.ts
@@ -205,10 +205,29 @@ describe("the notifier (spec §3.4–§3.6)", () => {
     await worker.exited;
     const [f] = await (inbox as FakeInbox).received(1);
     expect(f?.message.content).toContain(`name: "${d.admit.name}"`);
   });
 
+  it("announces a stalled role once, at next, and not once the role has finished", async () => {
+    const { run, n } = await owned();
+    const live = await fakeDispatch(run, { name: "worker-M1.L1" }, { proc: "self", collect: true });
+    n.onStall({ run, d: live, quietMs: 7 * 60_000 });
+    n.onStall({ run, d: live, quietMs: 7 * 60_000 });
+    const [f] = await (inbox as FakeInbox).received(1);
+    expect(f?.priority).toBe("next");
+    expect(f?.message.content).toContain(
+      "· worker-M1.L1 worker · codex:gpt-6-sol#medium · stalled: no output for 7 min · running ",
+    );
+    expect(f?.message.content).toContain(`Peek: peek(run: "${run.id}", name: "worker-M1.L1")`);
+    expect(existsSync(dispatchPaths(live.dir).stallNotified)).toBe(true);
+    n.onStall({ run, d: live, quietMs: 7 * 60_000 });
+    const done = await finished(run, "worker-M1.L2");
+    n.onStall({ run, d: done, quietMs: 60_000 });
+    await n.idle();
+    expect(inbox?.frames).toHaveLength(1);
+  });
+
   it("drops a notice whose record was read before the message went out", async () => {
     const { run, deps, n } = await owned({ coalesceMs: 200 });
     const d = await finished(run, "worker-M1.L1");
     await settle(deps, run, d, await recordOf(run, d));
     // the orchestrator read it (a peek showed it, say) inside the window
```


- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/infra/supervisor.test.ts test/services/dispatch.test.ts test/services/notifier.test.ts`. Expected: FAIL — no `stall.json` is written, `stallHooks` is not exported, `n.onStall` is not a function.

- [ ] **Step 3: Write the stall, watch for it, announce it**

#### Modify `src/infra/dispatch-dir.ts`

```diff
--- a/src/infra/dispatch-dir.ts
+++ b/src/infra/dispatch-dir.ts
@@ -38,10 +38,14 @@ export function dispatchPaths(dir: string) {
     supervisorLog: join(dir, "supervisor.log"),
     /** what failover did for this limited dispatch, written once under `failover.lock` (plan 10) */
     failover: join(dir, "failover.json"),
     /** the message that announced this dispatch's record to its session, once sent (plan 10) */
     notified: join(dir, "notified.json"),
+    /** written once by the supervisor when the worker went quiet for half its idle timeout, not busy (spec §3.6) */
+    stall: join(dir, "stall.json"),
+    /** the message that announced the stall, once sent */
+    stallNotified: join(dir, "stall-notified.json"),
   };
 }
 
 /**
  * Exclusive create: the first caller finalizes; every later caller reads the record it wrote. The claim
```


#### Modify `src/infra/supervisor.ts`

```diff
--- a/src/infra/supervisor.ts
+++ b/src/infra/supervisor.ts
@@ -187,17 +187,23 @@ async function superviseHeld(spec: SuperviseSpec, hooks: SuperviseHooks): Promis
     });
 
     const started = Date.now();
     let lastActivity = started;
     let finalAt: number | null = null;
+    // spec §3.6: a quiet stretch of half the idle timeout, not busy, is a stall, reported once per dispatch
+    let stalled = false;
+    let stallChecked = false;
     const open = new Set<string>();
     const stream = { offset: 0, rest: "", decoder: new TextDecoder("utf-8") };
 
     while (!done && reason === null) {
       await Bun.sleep(spec.pollMs);
       const lines = readNew(p.events, stream);
-      if (lines.length) lastActivity = Date.now();
+      if (lines.length) {
+        lastActivity = Date.now();
+        stallChecked = false;
+      }
       for (const line of lines) {
         let d: LineInfo | undefined;
         try {
           d = hooks.onLine?.(line);
         } catch {
@@ -222,10 +228,22 @@ async function superviseHeld(spec: SuperviseSpec, hooks: SuperviseHooks): Promis
         // the busy check can take up to hookMs: a worker that ended meanwhile is recorded as it ended, read
         // from the child itself too, since `done` is set by a callback that may not have run yet
         if (done || child.exitCode !== null || child.signalCode !== null) break;
         if (busy) lastActivity = Date.now();
         else reason = "idle-timeout";
+      } else if (!stalled && !stallChecked && now - lastActivity >= spec.idleMs / 2) {
+        // asked once per quiet stretch: a busy worker is not asked again until it next writes an event
+        stallChecked = true;
+        const busy = open.size > 0 || (await bounded(() => hooks.isBusy?.(thread, started), hookMs, false));
+        if (!busy && !done) {
+          stalled = true;
+          writeJsonAtomic(p.stall, {
+            schema: 1,
+            at: new Date().toISOString(),
+            quietMs: Date.now() - lastActivity,
+          });
+        }
       }
     }
   } catch (e) {
     failure = { error: e };
     reason = "lost";
```


#### Modify `src/services/dispatch-service.ts`

```diff
--- a/src/services/dispatch-service.ts
+++ b/src/services/dispatch-service.ts
@@ -85,10 +85,43 @@ export interface Settled {
  * Called with every dispatch this process settles, once each (the notifier, services/notifier.ts, is one). A
  * hook that throws is logged and never stops the others.
  */
 export const settledHooks = new Set<(s: Settled) => void | Promise<void>>();
 
+/** A live dispatch whose supervisor reported a stall (spec §3.6: quiet for half its idle timeout, not busy). */
+export interface Stalled {
+  run: Run;
+  d: Dispatch;
+  /** how long it had been quiet when the supervisor noticed */
+  quietMs: number;
+}
+
+/** Called once per watcher when its dispatch's stall.json appears (the notifier is one). */
+export const stallHooks = new Set<(s: Stalled) => void>();
+
+/** A watcher's poll: the first time the dispatch's stall.json is there, every stall hook hears of it. */
+export function stallPoll(run: Run, d: Dispatch): () => void {
+  let seen = false;
+  return () => {
+    if (seen || !existsSync(dispatchPaths(d.dir).stall)) return;
+    seen = true;
+    let quietMs = 0;
+    try {
+      quietMs = Number(JSON.parse(readFileSync(dispatchPaths(d.dir).stall, "utf8")).quietMs) || 0;
+    } catch {
+      // being written: the stall is reported without its length
+    }
+    for (const hook of stallHooks) {
+      try {
+        hook({ run, d, quietMs });
+      } catch (e) {
+        log("warn", "stall", { run: run.id, name: d.admit.name, error: errorMessage(e) });
+      }
+    }
+  };
+}
+
 const dispatchedOf = (d: Dispatch): Dispatched => ({
   name: d.admit.name,
   role: d.admit.role,
   rung: d.admit.rung,
   dispatchId: d.admit.dispatchId,
@@ -133,11 +166,11 @@ export async function watchersSettled(): Promise<void> {
  * after-snapshot holds only its own writes and the live list and the spend stay true. Its errors are logged.
  */
 export function watch(deps: Deps, run: Run, d: Dispatch): void {
   watching.add(d.admit.dispatchId);
   const w = (async () => {
-    await waitForFinish(d, { pollMs: deps.pollMs, now: deps.now });
+    await waitForFinish(d, { pollMs: deps.pollMs, now: deps.now, onPoll: stallPoll(run, d) });
     const s = await settle(deps, run, d, await finalizeDispatch(run, d));
     if (s.stateHints[0]) log("warn", "dispatch", { run: run.id, name: d.admit.name, hint: s.stateHints[0] });
   })()
     .catch((e: unknown) =>
       log("warn", "dispatch", { run: run.id, name: d.admit.name, error: errorMessage(e) }),
```


#### Modify `src/services/finalize.ts`

```diff
--- a/src/services/finalize.ts
+++ b/src/services/finalize.ts
@@ -332,9 +332,19 @@ export function lastEvent(d: Dispatch): string | null {
   } catch {
     return null;
   }
 }
 
-/** Waits until the dispatch finishes, polling every `pollMs`. */
-export async function waitForFinish(d: Dispatch, o: { pollMs: number; now: () => number }): Promise<void> {
-  while (dispatchState(d, o.now()) !== "finished") await Bun.sleep(o.pollMs);
+/** Waits until the dispatch finishes, polling every `pollMs`; `onPoll` runs at each poll, and never ends the wait. */
+export async function waitForFinish(
+  d: Dispatch,
+  o: { pollMs: number; now: () => number; onPoll?: () => void },
+): Promise<void> {
+  while (dispatchState(d, o.now()) !== "finished") {
+    await Bun.sleep(o.pollMs);
+    try {
+      o.onPoll?.();
+    } catch {
+      // a report on the way must never stop the wait
+    }
+  }
 }
```


#### Modify `src/services/notifier.ts`

```diff
--- a/src/services/notifier.ts
+++ b/src/services/notifier.ts
@@ -5,11 +5,11 @@ import { envelope, formatNotices, type Notice, type NoticePriority, priorityOf }
 import type { RunRecord } from "../domain/record.ts";
 import { awaitsCollect, dispatchPaths } from "../infra/dispatch-dir.ts";
 import { log } from "../infra/log.ts";
 import { type SendResult, sendToInbox } from "../infra/peer-inbox.ts";
 import { writeJsonAtomic } from "../infra/store.ts";
-import { type Settled, settledHooks } from "./dispatch-service.ts";
+import { type Settled, settledHooks, type Stalled, stallHooks } from "./dispatch-service.ts";
 import { type Dispatch, listDispatches, readFailover } from "./dispatches.ts";
 import type { Deps } from "./ports.ts";
 import { listRuns, readRecords, type Run } from "./run-store.ts";
 import { currentSession, runOwner } from "./sessions.ts";
 
@@ -33,10 +33,12 @@ export interface NotifierOptions {
 }
 
 export interface Notifier {
   /** the settled hook: queues the dispatch's notice when this session should hear of it */
   onSettled(s: Settled): void;
+  /** the stall hook: queues a stalled role's notice, once per dispatch */
+  onStall(s: Stalled): void;
   /** spec §3.4 "a scan on start": every unread, un-notified record of a run this session owns */
   scan(): Promise<void>;
   /** resolves once nothing is queued and no message is on its way */
   idle(): Promise<void>;
   /** removes the hook and drops what is queued */
@@ -84,13 +86,36 @@ export function finishedNotice(run: Run, d: Dispatch, r: RunRecord): Notice {
     reply: replyOf(run, r),
     priority: urgent ? "next" : "later",
   };
 }
 
+/** Spec §3.6: a live role that went quiet, once, at `next`. */
+export function stalledNotice(run: Run, d: Dispatch, quietMs: number, now: number): Notice {
+  return {
+    kind: "stalled",
+    runId: run.id,
+    runTitle: run.meta.title,
+    dispatchId: d.admit.dispatchId,
+    name: d.admit.name,
+    role: d.admit.role,
+    lane: d.admit.lane,
+    rung: d.admit.rung,
+    status: `stalled: no output for ${Math.max(1, Math.round(quietMs / 60_000))} min`,
+    replyStatus: null,
+    secs: Math.max(0, Math.round((now - Date.parse(d.admit.admittedAt)) / 1000)),
+    changedOwned: 0,
+    reply: "",
+    priority: "next",
+  };
+}
+
 interface Queued {
   notice: Notice;
-  dir: string;
+  /** the mark a message that went out leaves */
+  mark: string;
+  /** whether it is still news when the message goes */
+  due: () => boolean;
 }
 
 /** Starts the notifier for this process's session and hooks it to every settled dispatch. */
 export function startNotifier(deps: Deps, o: NotifierOptions = {}): Notifier {
   const window = o.coalesceMs ?? 3_000;
@@ -121,11 +146,11 @@ export function startNotifier(deps: Deps, o: NotifierOptions = {}): Notifier {
     timer = setTimeout(flush, Math.max(0, Math.min(window, firstAt + 5 * window - now)));
   };
 
   async function deliver(batch: Queued[]): Promise<void> {
     // read (or announced) meanwhile: nothing to say
-    const due = batch.filter((q) => awaitsCollect(q.dir) && !notified(q.dir));
+    const due = batch.filter((q) => q.due());
     if (due.length === 0 || !deps.session) return;
     const notices = due.map((q) => q.notice);
     const r = await send(
       { socketPath: deps.session.socketPath, token: deps.session.token },
       envelope(formatNotices(notices)),
@@ -138,30 +163,52 @@ export function startNotifier(deps: Deps, o: NotifierOptions = {}): Notifier {
         dispatches: notices.map((n) => n.dispatchId),
       });
       return;
     }
     const at = new Date(deps.now()).toISOString();
-    for (const q of due) writeJsonAtomic(dispatchPaths(q.dir).notified, { schema: 1, msgId: r.msgId, at });
+    for (const q of due) writeJsonAtomic(q.mark, { schema: 1, msgId: r.msgId, at });
     log("info", "notify", { msgId: r.msgId, dispatches: notices.map((n) => n.dispatchId) });
   }
 
   const enqueue = (run: Run, d: Dispatch, record: RunRecord): void => {
     if (queue.has(record.dispatchId) || notified(d.dir) || !awaitsCollect(d.dir) || !owned(run)) return;
-    queue.set(record.dispatchId, { notice: finishedNotice(run, d, record), dir: d.dir });
+    queue.set(record.dispatchId, {
+      notice: finishedNotice(run, d, record),
+      mark: dispatchPaths(d.dir).notified,
+      due: () => awaitsCollect(d.dir) && !notified(d.dir),
+    });
     schedule();
   };
 
+  const onStall = (s: Stalled): void => {
+    try {
+      const p = dispatchPaths(s.d.dir);
+      const key = `${s.d.admit.dispatchId} stall`;
+      if (queue.has(key) || existsSync(p.stallNotified) || existsSync(p.exit) || !owned(s.run)) return;
+      queue.set(key, {
+        notice: stalledNotice(s.run, s.d, s.quietMs, deps.now()),
+        mark: p.stallNotified,
+        // it finished meanwhile: its record is the news now
+        due: () => !existsSync(p.stallNotified) && !existsSync(p.exit),
+      });
+      schedule();
+    } catch (e) {
+      log("warn", "notify", { run: s.run.id, name: s.d.admit.name, error: errorMessage(e) });
+    }
+  };
+
   const onSettled = (s: Settled): void => {
     try {
       enqueue(s.run, s.d, s.record);
     } catch (e) {
       log("warn", "notify", { run: s.run.id, name: s.d.admit.name, error: errorMessage(e) });
     }
   };
 
   const n: Notifier = {
     onSettled,
+    onStall,
     async scan() {
       if (!currentSession(deps)) return;
       for (const run of listRuns().runs) {
         try {
           if (!owned(run)) continue;
@@ -184,13 +231,15 @@ export function startNotifier(deps: Deps, o: NotifierOptions = {}): Notifier {
         } else await Bun.sleep(5);
       }
     },
     stop() {
       settledHooks.delete(onSettled);
+      stallHooks.delete(onStall);
       if (timer !== null) clearTimeout(timer);
       timer = null;
       queue.clear();
     },
   };
   settledHooks.add(onSettled);
+  stallHooks.add(onStall);
   return n;
 }
```


#### Modify `src/services/reconcile.ts`

```diff
--- a/src/services/reconcile.ts
+++ b/src/services/reconcile.ts
@@ -1,11 +1,11 @@
 import { readFileSync, statSync } from "node:fs";
 import { errorMessage } from "../domain/errors.ts";
 import { dispatchPaths } from "../infra/dispatch-dir.ts";
 import { log } from "../infra/log.ts";
 import { writeJsonAtomic } from "../infra/store.ts";
-import { settle, unsettledLimits, watching } from "./dispatch-service.ts";
+import { settle, stallPoll, unsettledLimits, watching } from "./dispatch-service.ts";
 import { type Dispatch, listDispatches, pendingDispatches } from "./dispatches.ts";
 import { finalizeDispatch, waitForFinish } from "./finalize.ts";
 import type { Deps } from "./ports.ts";
 import { listRuns, type Run } from "./run-store.ts";
 
@@ -43,11 +43,11 @@ export interface ReconcileReport {
  * refresh that fails rejects, after the record is written, with a message that says so.
  */
 async function watchAndFinalize(deps: Deps, run: Run, d: Dispatch): Promise<void> {
   watching.add(d.admit.dispatchId);
   try {
-    await waitForFinish(d, { pollMs: deps.pollMs, now: deps.now });
+    await waitForFinish(d, { pollMs: deps.pollMs, now: deps.now, onPoll: stallPoll(run, d) });
     const s = await settle(deps, run, d, await finalizeDispatch(run, d));
     if (s.stateHints[0]) throw new Error(s.stateHints[0]);
   } finally {
     watching.delete(d.admit.dispatchId);
   }
```

- [ ] **Step 4: Run the gate**

Run the gate. Expected: clean. Scratch count after this task: 1212 pass, 10 skip, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(push): the supervisor reports a stall once; the notifier announces it at next"
```

---

### Task 7: `peek`, what each worker is doing, and the push test over stdio

Spec §3.7 `peek`, §14 (21 tools) and §15's stdio integration test ("dispatch two fake workers, receive two notices on the fake socket while the MCP client makes other calls, then `peek` and `result`"). Each adapter's `parse` now reports `activity` — a command, a file edit or a message line — which `peek` shows as a live role's last event (Ruling 15). `peek` with a `run` claims it and adopts it (Ruling 9). The skill names `peek` (once when the user asks, when a decision needs it, or once on resume), and the manual test's tool list trades `wait` for `peek`.

**Files:**
- Modify: `test/adapters/claude-code.test.ts`
- Modify: `test/adapters/codex.test.ts`
- Modify: `test/adapters/opencode.test.ts`
- Modify: `test/entry/mcp.test.ts`
- Modify: `test/integration/mcp-stdio.test.ts`
- Create: `test/services/peek.test.ts`
- Modify: `test/skills.test.ts`
- Modify: `src/adapters/backend.ts`
- Modify: `src/adapters/claude-code/index.ts`
- Modify: `src/adapters/codex/index.ts`
- Modify: `src/adapters/opencode/index.ts`
- Modify: `src/entry/mcp/dispatch-tools.ts`
- Create: `src/services/peek.ts`
- Modify: `docs/dev/manual-tests.md`
- Modify: `plugin/skills/catherd/SKILL.md`

**Interfaces:**
- Consumes: `finishedNotice` (Task 5), `adopt` (Task 5), `claimRun`, `currentSession`, `runOwner` (Task 4), `noticeHeader` (Task 2), `tail` (`src/services/run-debug.ts`).
- Produces: `EventDelta.activity?: string`; `peek(deps, { run?, name? }): Promise<{ runs: PeekRun[]; hints: string[] }>`, `PeekRun`, `PeekRole`, `lastActivity(d)`, `LAST_EVENT_CHARS` (`src/services/peek.ts`; Task 10 moves `lastActivity` and `LAST_EVENT_CHARS` to `finalize.ts`); the `peek` MCP tool.

- [ ] **Step 1: Write the failing tests**

#### Modify `test/adapters/claude-code.test.ts`

```diff
--- a/test/adapters/claude-code.test.ts
+++ b/test/adapters/claude-code.test.ts
@@ -195,10 +195,19 @@ describe("claude-code parse", () => {
       tokens: { input: 20912, cached: 20000, output: 14 },
       costUsd: 0.0142,
     });
   });
 
+  it("says what the worker is doing: a command, a file edit, its text (spec §3.7 peek)", () => {
+    const all = lines("read-only-write.jsonl")
+      .map((l) => claudeCodeAdapter.parse(l).activity)
+      .filter(Boolean);
+    expect(all).toContain("edit <repo>/out.txt");
+    expect(all).toContain('$ echo "hi" > out.txt');
+    expect(lines("ok.jsonl").map((l) => claudeCodeAdapter.parse(l).activity)).toContain("hello");
+  });
+
   it("reports the first request's own input from its assistant message, not the session's total", () => {
     const first = lines("read-only-write.jsonl")
       .map((l) => claudeCodeAdapter.parse(l).requestInput)
       .find((x) => x !== undefined);
     expect(first).toBe(9 + 30314);
```


#### Modify `test/adapters/codex.test.ts`

```diff
--- a/test/adapters/codex.test.ts
+++ b/test/adapters/codex.test.ts
@@ -49,10 +49,21 @@ describe("codex parse", () => {
       item: { id: "item_2", type: "todo_list", items: [] },
     });
     expect(codexAdapter.parse(plan).item).toBeUndefined();
     expect(codexAdapter.parse('{"type":"turn.started"}').item).toBeUndefined();
   });
+
+  it("says what the worker is doing: a command, a file edit, a message (spec §3.7 peek)", () => {
+    const all = lines("ok-with-reconnect.jsonl").map((l) => codexAdapter.parse(l).activity);
+    expect(all.filter(Boolean)).toEqual([
+      "$ /bin/zsh -lc 'cat CLAUDE.md'",
+      "$ /bin/zsh -lc 'cat CLAUDE.md'",
+      "edit /repo/src/a.ts",
+      "Done.\nSTATUS: complete — lane finished, fast check green",
+    ]);
+    expect(codexAdapter.parse('{"type":"turn.started"}').activity).toBeUndefined();
+  });
 });
 
 describe("codex plan", () => {
   it("sends the brief on stdin, sets model, effort and sandbox, and ends positionals after --", () => {
     const p = codexAdapter.plan(req());
```


#### Modify `test/adapters/opencode.test.ts`

```diff
--- a/test/adapters/opencode.test.ts
+++ b/test/adapters/opencode.test.ts
@@ -135,6 +135,15 @@ describe("opencode parse", () => {
       limit: true,
       failure: "Monthly usage limit reached for opencode-go/kimi-k3",
     });
     expect(opencodeAdapter.parse(lines("v1-model-hash-error.jsonl")[0] as string).tooOld).toBe(true);
   });
+
+  it("says what the worker is doing: a command, a tool with its first argument, its text (spec §3.7 peek)", () => {
+    expect(opencodeAdapter.parse(lines("shell-ok.jsonl")[2] as string).activity).toBe(
+      "$ ls /usr/share > /dev/null && echo listed",
+    );
+    const explore = lines("explore-tools.jsonl").map((l) => opencodeAdapter.parse(l).activity);
+    expect(explore).toContain("grep export const");
+    expect(opencodeAdapter.parse(lines("shell-ok.jsonl")[0] as string).activity).toBeUndefined();
+  });
 });
```


#### Modify `test/entry/mcp.test.ts`

```diff
--- a/test/entry/mcp.test.ts
+++ b/test/entry/mcp.test.ts
@@ -10,17 +10,18 @@ import { snapshotEnv } from "../helpers.ts";
 import { call, mcpClient } from "../mcp-helpers.ts";
 import { fakeDeps, fakeGit, freshRun, writeLane } from "../services/helpers.ts";
 
 afterEach(snapshotEnv());
 
-/** Spec §4.8 and the 1.1 spec §14 (plan 10: `wait` removed), exactly. */
+/** Spec §4.8 and the 1.1 spec §14 (plan 10: `wait` removed, `peek` added), exactly. */
 const TOOLS = [
   "run_start",
   "route",
   "preflight",
   "dispatch",
   "cancel",
+  "peek",
   "climb",
   "ask",
   "land",
   "read_knowledge",
   "write_run_file",
```


#### Modify `test/integration/mcp-stdio.test.ts`

```diff
--- a/test/integration/mcp-stdio.test.ts
+++ b/test/integration/mcp-stdio.test.ts
@@ -11,14 +11,16 @@ import {
 } from "node:fs";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
 import { Client } from "@modelcontextprotocol/sdk/client/index.js";
 import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
+import { claudeConfigDir } from "../../src/infra/claude-session.ts";
 import { configDir, runsDir } from "../../src/infra/paths.ts";
 import { defaultProfileDoc } from "../../src/domain/profile.ts";
 import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
 import { call } from "../mcp-helpers.ts";
+import { fakeInbox } from "../sim/peer-inbox.ts";
 import { type CodexScenario, simPath, withScenario } from "../sim/scenario.ts";
 
 afterEach(snapshotEnv());
 
 const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");
@@ -297,10 +299,88 @@ describe("catherd mcp over stdio, on the Codex simulator", () => {
     },
     { timeout: 120_000 },
   );
 });
 
+describe("push over stdio (spec §15)", () => {
+  it(
+    "announces two workers on the session's inbox while the client makes other calls; then peek and result",
+    async () => {
+      const { repo, sim, env } = setup();
+      const inbox = await fakeInbox();
+      // the Claude Code session the server runs in: its registry file names the fake inbox
+      mkdirSync(join(claudeConfigDir(), "sessions"), { recursive: true });
+      writeFileSync(
+        join(claudeConfigDir(), "sessions", "4242.json"),
+        JSON.stringify({ pid: 4242, sessionId: "s-it", name: "it session", messagingSocketPath: inbox.path }),
+      );
+      const c = await connect({
+        ...env,
+        CLAUDE_CODE_SESSION_ID: "s-it",
+        CLAUDE_CODE_MESSAGING_SOCKET: inbox.path,
+        CLAUDE_CODE_MESSAGING_TOKEN: "child-token",
+      });
+      try {
+        const { run } = (await call(c, "run_start", { repo, title: "Push it", a_lines: ["A1"] })).data;
+        for (const [id, owns] of [
+          ["M1.L1", "src/a.ts"],
+          ["M1.L2", "src/b.ts"],
+        ] as const)
+          await call(c, "write_run_file", { run, path: `lanes/${id}.md`, content: lane(id, owns, "true") });
+        const [a, b] = [0, 1].map(() => join(mkdtempSync(join(tmpdir(), "catherd-hold-")), "release"));
+        sim.rewrite({
+          byRung: {
+            "gpt-6-luna#high": { reply: "A done.\nSTATUS: complete — a", holdUntil: a },
+            "gpt-6-sol#medium": { reply: "B done.\nSTATUS: complete — b", holdUntil: b },
+          },
+        });
+        const base = { run, role: "worker", brief: "b" };
+        await call(c, "dispatch", {
+          ...base,
+          name: "worker-M1.L1",
+          lane: "M1.L1",
+          rung: "codex:gpt-6-luna#high",
+        });
+        await call(c, "dispatch", {
+          ...base,
+          name: "worker-M1.L2",
+          lane: "M1.L2",
+          rung: "codex:gpt-6-sol#medium",
+        });
+        writeFileSync(a as string, "");
+        // the client keeps working while the first notice is on its way
+        const first = inbox.received(1, 20_000);
+        const live = await until(async () => {
+          const p = (await call(c, "peek", { run })).data.runs[0];
+          return p.unread.length === 1 && p.live.length === 1 ? p : null;
+        });
+        expect(live.live[0].name).toBe("worker-M1.L2");
+        expect(live.unread[0].header).toMatch(/^catherd · Push it · worker-M1\.L1 worker · /);
+        const [f1] = await first;
+        expect(f1?.auth).toEqual({ type: "auth", token: "child-token" });
+        expect(f1?.priority).toBe("later");
+        expect(f1?.message.content).toContain('Record: result(run: "' + run + '", name: "worker-M1.L1")');
+        writeFileSync(b as string, "");
+        expect((await call(c, "status", { run })).isError).toBe(false);
+        const frames = await inbox.received(2, 20_000);
+        expect(frames[1]?.message.content).toContain("worker-M1.L2 worker");
+        // announced, not read: peek lists both until result reads them
+        expect((await call(c, "peek", { run })).data.runs[0].unread).toHaveLength(2);
+        const r1 = (await call(c, "result", { run, name: "worker-M1.L1" })).data;
+        expect(r1.record).toMatchObject({ status: "ok", replyStatus: "complete" });
+        await call(c, "result", { run, name: "worker-M1.L2" });
+        expect((await call(c, "peek", { run })).data.runs[0].unread).toEqual([]);
+        expect(inbox.frames).toHaveLength(2);
+      } finally {
+        await c.close();
+        await inbox.close();
+      }
+    },
+    { timeout: 90_000 },
+  );
+});
+
 describe("concurrency and corruption, over stdio", () => {
   it(
     "admits one of two parallel overlapping dispatches, and one of two with the same name",
     async () => {
       const { repo, sim, env } = setup();
```


#### Create `test/services/peek.test.ts`

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeConfigDir, type SessionEnv } from "../../src/infra/claude-session.ts";
import { awaitsCollect } from "../../src/infra/dispatch-dir.ts";
import { watchersSettled } from "../../src/services/dispatch-service.ts";
import { finalizeDispatch } from "../../src/services/finalize.ts";
import { lastActivity, peek } from "../../src/services/peek.ts";
import { appendAgentRun, createRun } from "../../src/services/run-store.ts";
import { claimRun, runOwner } from "../../src/services/sessions.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { fakeDeps, fakeDispatch, freshRun } from "./helpers.ts";

afterEach(() => watchersSettled());
afterEach(snapshotEnv());

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
const OK_LINES = readFileSync(join(FX, "ok-with-reconnect.jsonl"), "utf8").split("\n").filter(Boolean);
const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };

function session(pid: number, id: string): SessionEnv {
  const dir = join(claudeConfigDir(), "sessions");
  mkdirSync(dir, { recursive: true });
  const socketPath = `/tmp/cc-socks/${pid}.sock`;
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId: id, messagingSocketPath: socketPath }),
  );
  return { sessionId: id, hostSessionId: null, socketPath, token: null };
}

describe("peek (spec §3.7)", () => {
  it("shows each live role with its rung, elapsed time and last command, file edit or message line", async () => {
    const { run } = freshRun("Jobs screen");
    // the worker has run a command so far
    await fakeDispatch(run, {}, { proc: "self", events: `${OK_LINES.slice(0, 5).join("\n")}\n` });
    const { runs } = await peek(fakeDeps(), { run: run.id });
    expect(runs[0]?.live).toEqual([
      {
        name: "worker-M1.L1",
        role: "worker",
        rung: "codex:gpt-6-sol#medium",
        state: "running",
        secs: expect.any(Number),
        lastEvent: "$ /bin/zsh -lc 'cat CLAUDE.md'",
      },
    ]);
  });

  it("reads back past events without one to the last activity, and caps it at 160 characters", async () => {
    const { run } = freshRun();
    const d = await fakeDispatch(run, {}, { proc: "self", events: `${OK_LINES.join("\n")}\n` });
    // the turn.completed line says nothing: the agent message before it is the last activity
    expect(lastActivity(d)).toBe("Done.");
    const long = JSON.stringify({
      type: "item.started",
      item: { id: "i", type: "command_execution", command: "x".repeat(400) },
    });
    const e = await fakeDispatch(
      run,
      { name: "worker-M1.L2", lane: "M1.L2" },
      { proc: "self", events: `${long}\n` },
    );
    const a = lastActivity(e) as string;
    expect(a.length).toBe(160);
    expect(a.endsWith("…")).toBe(true);
    expect(lastActivity(await fakeDispatch(run, { name: "w3", lane: null }, { proc: "self" }))).toBeNull();
  });

  it("lists each finished record not yet read as its message's first line, and never marks it read", async () => {
    const { run } = freshRun("Jobs screen");
    const d = await fakeDispatch(
      run,
      {},
      { proc: "dead", exit, reply: "ok\nSTATUS: complete — ok", collect: true },
    );
    await finalizeDispatch(run, d);
    const first = await peek(fakeDeps(), { run: run.id });
    expect(first.runs[0]?.unread).toEqual([
      {
        name: "worker-M1.L1",
        dispatchId: d.admit.dispatchId,
        header: expect.stringMatching(
          /^catherd · Jobs screen · worker-M1\.L1 worker · codex:gpt-6-sol#medium · \w+ · /,
        ),
      },
    ]);
    expect(awaitsCollect(d.dir)).toBe(true);
    expect((await peek(fakeDeps(), { run: run.id })).runs[0]?.unread).toHaveLength(1);
  });

  it("shows the latest native run and the run's next step, and narrows to one role by name", async () => {
    const { run } = freshRun();
    appendAgentRun(run, {
      at: "2026-09-28T10:00:00.000Z",
      name: "verifier-M1",
      role: "verifier",
      rung: "claude:claude-opus-5-5#low",
      agent: null,
      totalTokens: 10,
      costUsd: null,
      secs: 60,
      status: "ok",
      lane: null,
    });
    await fakeDispatch(run, {}, { proc: "self" });
    await fakeDispatch(run, { name: "reviewer-M1", role: "reviewer", lane: null }, { proc: "self" });
    const all = (await peek(fakeDeps(), { run: run.id })).runs[0];
    expect(all?.native).toEqual({
      name: "verifier-M1",
      role: "verifier",
      rung: "claude:claude-opus-5-5#low",
      status: "ok",
      at: "2026-09-28T10:00:00.000Z",
    });
    expect(all?.next).toBe("plan the milestones");
    expect(all?.live.map((l) => l.name).sort()).toEqual(["reviewer-M1", "worker-M1.L1"]);
    const one = (await peek(fakeDeps(), { run: run.id, name: "reviewer-M1" })).runs[0];
    expect(one?.live.map((l) => l.name)).toEqual(["reviewer-M1"]);
    expect(one?.native).toBeNull();
  });

  it("without a run, shows the runs this session owns, else the newest; with one, takes it over", async () => {
    const { repo, run: older } = freshRun("older");
    const newer = createRun({
      repo,
      title: "newer",
      aLines: ["A1"],
      version: "0",
      now: new Date(Date.now() + 60_000),
    });
    const me = fakeDeps({ session: session(301, "s-me") });
    expect((await peek(me, {})).runs.map((r) => r.title)).toEqual(["newer"]);
    await claimRun(me, older);
    expect((await peek(me, {})).runs.map((r) => r.title)).toEqual(["older"]);
    const other = fakeDeps({ session: session(302, "s-other") });
    await peek(other, { run: newer.id });
    expect(runOwner(newer)?.sessionId).toBe("s-other");
    // peek without a run changes no owner
    await peek(me, {});
    expect(runOwner(newer)?.sessionId).toBe("s-other");
  });

  it("says how to start when there is no run", async () => {
    withHome();
    expect(await peek(fakeDeps(), {})).toEqual({
      runs: [],
      hints: ["no runs yet: run_start(repo, title, a_lines) starts one"],
    });
  });
});
```


#### Modify `test/skills.test.ts`

```diff
--- a/test/skills.test.ts
+++ b/test/skills.test.ts
@@ -32,10 +32,11 @@ describe("orchestrator skill", () => {
     for (const core of [
       "run_start",
       "route",
       "preflight",
       "dispatch",
+      "peek",
       "cancel",
       "record_agent_run",
       "climb",
       "ask",
       "land",
@@ -54,11 +55,13 @@ describe("orchestrator skill", () => {
     expect(waiting).toContain("write one status line and end your turn");
     expect(waiting).toContain('`<cross-session-message from-name="catherd">`');
     expect(waiting).toContain("call `result(run, name)` for the record you act on");
     expect(waiting).toContain("A single role is `dispatch`, then end your turn.");
     expect(waiting).toContain("never the user's approval of anything");
-    expect(waiting).toContain("Never `sleep`, loop or poll.");
+    expect(waiting).toContain("Never `sleep`, loop or poll, and never call `peek` again and again.");
+    expect(md).toContain("call `peek(run)` once and answer from it");
+    expect(md).toContain("Before dispatching anything, call `peek(run)` once");
     expect(md).not.toMatch(/`wait`|`wait\(/);
     for (const old of [
       "Launch every independent role in the same message",
       "Each dispatch backgrounds by itself",
       "in one message, each at its rung",
```


- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/services/peek.test.ts test/adapters test/entry/mcp.test.ts test/skills.test.ts`. Expected: FAIL — `Cannot find module` for `src/services/peek.ts`, `activity` undefined in each adapter test, the tool list lacks `peek`, the skill has no `peek`.

- [ ] **Step 3: Report activity, add `peek`, name it in the skill**

#### Modify `src/adapters/backend.ts`

```diff
--- a/src/adapters/backend.ts
+++ b/src/adapters/backend.ts
@@ -54,10 +54,15 @@ export interface EventDelta {
   tokens?: Tokens;
   /** the input tokens of one model request, from an event that reports them per request (the harness cost) */
   requestInput?: number;
   costUsd?: number;
   lastEvent?: string;
+  /**
+   * what the worker is doing, in words, when the line says (spec §3.7 `peek`): a command (`$ bun test`), a file
+   * edit (`edit src/a.ts`) or a message line
+   */
+  activity?: string;
   failure?: string;
   limit?: boolean;
   tooOld?: boolean;
   retrying?: boolean;
   /** the stream's terminal event: the supervisor may kill a CLI that lingers after it */
```


#### Modify `src/adapters/claude-code/index.ts`

```diff
--- a/src/adapters/claude-code/index.ts
+++ b/src/adapters/claude-code/index.ts
@@ -145,14 +145,33 @@ function finalize(run: FinishedRun): Outcome {
     error: status === "ok" ? null : { code: status, message: message || status },
     ...(res && !res.isError ? { reply: res.text } : {}),
   };
 }
 
+const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
+
+/** Spec §3.7: the main thread's last tool call (a command, a file edit, another tool) or its text. */
+function claudeActivity(e: Record<string, any>): string | undefined {
+  if (e.type !== "assistant" || e.parent_tool_use_id) return undefined;
+  const c = (e.message?.content ?? []).at(-1);
+  if (c?.type === "tool_use") {
+    const input = c.input ?? {};
+    if (typeof input.command === "string") return `$ ${input.command}`;
+    if (typeof input.file_path === "string")
+      return `${EDIT_TOOLS.has(c.name) ? "edit" : String(c.name)} ${input.file_path}`;
+    return String(c.name ?? "tool");
+  }
+  if (c?.type === "text" && typeof c.text === "string") return c.text;
+  return undefined;
+}
+
 function parse(line: string): EventDelta {
   const e = parseClaudeLine(line);
   if (!e) return {};
   const d: EventDelta = { lastEvent: eventName(e) };
+  const activity = claudeActivity(e);
+  if (activity) d.activity = activity;
   if (typeof e.session_id === "string" && e.session_id) d.thread = e.session_id;
   if (e.type === "system" && e.subtype === "api_retry") d.retrying = true;
   if (e.type === "rate_limit_event" && e.rate_limit_info?.status === "rejected") d.limit = true;
   // each assistant message of the main thread carries its own request's usage; `result` sums the session
   if (e.type === "assistant" && !e.parent_tool_use_id && e.message?.usage)
```


#### Modify `src/adapters/codex/index.ts`

```diff
--- a/src/adapters/codex/index.ts
+++ b/src/adapters/codex/index.ts
@@ -192,10 +192,24 @@ async function canWrite(dir: string): Promise<{ ok: boolean; fix?: string } | nu
   } finally {
     rmSync(cwd, { recursive: true, force: true });
   }
 }
 
+/** Spec §3.7: a command Codex runs, the files it changes, or its message. */
+function codexActivity(e: Record<string, any>): string | undefined {
+  const it = e.item;
+  if (!it || (e.type !== "item.started" && e.type !== "item.completed")) return undefined;
+  if (it.type === "command_execution" && typeof it.command === "string") return `$ ${it.command}`;
+  if (it.type === "file_change" && Array.isArray(it.changes))
+    return `edit ${it.changes
+      .map((c: { path?: unknown }) => c.path)
+      .filter((p: unknown) => typeof p === "string")
+      .join(", ")}`;
+  if (it.type === "agent_message" && typeof it.text === "string") return it.text;
+  return undefined;
+}
+
 export const codexAdapter: BackendAdapter = {
   id: "codex",
   minVersion: CODEX_MIN_VERSION,
   probe,
   listModels,
@@ -211,10 +225,11 @@ export const codexAdapter: BackendAdapter = {
     return {
       ...(f.thread ? { thread: f.thread } : {}),
       ...(id !== null && open !== null ? { item: { id, open } } : {}),
       ...(e.type === "turn.completed" ? { tokens: f.tokens } : {}),
       lastEvent: f.lastEvent ?? undefined,
+      ...(codexActivity(e) ? { activity: codexActivity(e) } : {}),
       ...(f.turnFailed ? { failure: f.failure ?? "turn failed" } : {}),
       ...(f.limit ? { limit: true } : {}),
       ...(f.tooOld ? { tooOld: true } : {}),
     };
   },
```


#### Modify `src/adapters/opencode/index.ts`

```diff
--- a/src/adapters/opencode/index.ts
+++ b/src/adapters/opencode/index.ts
@@ -179,14 +179,28 @@ function finalize(run: FinishedRun): Outcome {
     error: status === "ok" ? null : { code: status, message },
     reply: f.reply,
   };
 }
 
+/** Spec §3.7: the tool opencode ran (a command, a file edit, another tool with its first argument) or its text. */
+function opencodeActivity(e: Record<string, any>): string | undefined {
+  if (e.type === "text" && typeof e.part?.text === "string") return e.part.text;
+  if (e.type !== "tool_use" || typeof e.part?.tool !== "string") return undefined;
+  const input = e.part.state?.input ?? {};
+  if (typeof input.command === "string") return `$ ${input.command}`;
+  const path = input.filePath ?? input.path;
+  if (/^(edit|write|patch)$/.test(e.part.tool) && typeof path === "string") return `edit ${path}`;
+  const first = Object.values(input).find((v) => typeof v === "string");
+  return `${e.part.tool}${typeof first === "string" ? ` ${first}` : ""}`;
+}
+
 function parse(line: string): EventDelta {
   const e = parseOpencodeLine(line);
   if (!e) return {};
   const d: EventDelta = { lastEvent: eventName(e) };
+  const activity = opencodeActivity(e);
+  if (activity) d.activity = activity;
   if (typeof e.sessionID === "string") d.thread = e.sessionID;
   if (e.type === "step_finish") {
     d.tokens = opencodeTokens(e.part?.tokens);
     d.requestInput = d.tokens.input;
     if (typeof e.part?.cost === "number") d.costUsd = e.part.cost;
```


#### Modify `src/entry/mcp/dispatch-tools.ts`

```diff
--- a/src/entry/mcp/dispatch-tools.ts
+++ b/src/entry/mcp/dispatch-tools.ts
@@ -1,10 +1,11 @@
 import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 import { z } from "zod";
 import { ID_PATTERN } from "../../domain/ids.ts";
 import { ROLES } from "../../domain/roles.ts";
 import { cancel, dispatch } from "../../services/dispatch-service.ts";
+import { peek } from "../../services/peek.ts";
 import type { Deps } from "../../services/ports.ts";
 import { handle } from "./result.ts";
 
 export function registerDispatchTools(server: McpServer, deps: Deps): void {
   server.registerTool(
@@ -24,10 +25,23 @@ export function registerDispatchTools(server: McpServer, deps: Deps): void {
       },
     },
     (a) => handle(() => dispatch(deps, a)),
   );
 
+  server.registerTool(
+    "peek",
+    {
+      description:
+        "A look at the runs, without waiting: with run, that run (and this session becomes its owner); without, every run this session owns, else the newest. Per run: each live role with its rung, seconds since it started and its last event (the last command, file edit or message line); every finished record not yet read, as the first line of catherd's message; the latest native Claude run; the run's next step. name narrows it to one role. It never marks a record read: result(run, name) does. Call it when the user asks how it is going, when a decision needs the other roles' state, or once after run_start on a resumed run; never in a loop.",
+      inputSchema: {
+        run: z.string().optional(),
+        name: z.string().regex(ID_PATTERN).optional(),
+      },
+    },
+    (a) => handle(() => peek(deps, a)),
+  );
+
   server.registerTool(
     "cancel",
     {
       description:
         "Stop a live dispatch (interrupt, then SIGTERM, then SIGKILL) and return its record, marked cancelled and read, and hints.",
```


#### Create `src/services/peek.ts`

```ts
import { adapterFor } from "../adapters/registry.ts";
import "../adapters/all.ts";
import { assertId } from "../domain/ids.ts";
import { noticeHeader } from "../domain/notice.ts";
import { awaitsCollect, dispatchPaths } from "../infra/dispatch-dir.ts";
import { adopt } from "./dispatch-service.ts";
import { type Dispatch, type DispatchState, listDispatches, liveDispatches } from "./dispatches.ts";
import { finishedNotice } from "./notifier.ts";
import type { Deps } from "./ports.ts";
import { tail } from "./run-debug.ts";
import { findRun, listRuns, readAgentRuns, readRecords, type Run } from "./run-store.ts";
import { claimRun, currentSession, runOwner } from "./sessions.ts";
import { readNotes } from "./state.ts";

/** How much of a role's last event `peek` shows (spec §3.7). */
export const LAST_EVENT_CHARS = 160;

export interface PeekRole {
  name: string;
  role: string;
  rung: string;
  state: DispatchState;
  /** since admission */
  secs: number;
  /** the last command, file edit or message line, else the last event's name; null before any event */
  lastEvent: string | null;
}

export interface PeekRun {
  run: string;
  title: string;
  /** the session that owns the run now, null when none has */
  owner: string | null;
  live: PeekRole[];
  /** each finished record not yet read, as the first line of its message */
  unread: { name: string; dispatchId: string; header: string }[];
  /** the latest native Claude run recorded with record_agent_run */
  native: { name: string; role: string; rung: string; status: string; at: string } | null;
  /** the run's next step (state.md's last line) */
  next: string;
}

const oneLine = (s: string): string => {
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  return line.length > LAST_EVENT_CHARS ? `${line.slice(0, LAST_EVENT_CHARS - 1)}…` : line;
};

/**
 * Spec §3.7: what a live role is doing, from the end of its events.jsonl: the last line an adapter reads as an
 * activity (a command, a file edit, a message line), else the last event's name.
 */
export function lastActivity(d: Dispatch): string | null {
  const a = adapterFor(d.admit.backend);
  if (!a) return null;
  const lines = tail(dispatchPaths(d.dir).events, 200);
  let name: string | null = null;
  for (const line of lines.toReversed()) {
    let delta;
    try {
      delta = a.parse(line);
    } catch {
      continue;
    }
    if (delta.activity) return oneLine(delta.activity);
    name ??= delta.lastEvent ?? null;
  }
  return name;
}

function peekRun(deps: Deps, run: Run, name: string | undefined): PeekRun {
  const now = deps.now();
  const mine = (d: Dispatch) => name === undefined || d.admit.name === name;
  const records = new Map(readRecords(run).records.map((r) => [r.dispatchId, r]));
  const agents = readAgentRuns(run).filter((a) => name === undefined || a.name === name);
  const native = agents.at(-1);
  return {
    run: run.id,
    title: run.meta.title,
    owner: runOwner(run)?.sessionId ?? null,
    live: liveDispatches(run, now)
      .filter(mine)
      .map((d) => ({
        name: d.admit.name,
        role: d.admit.role,
        rung: d.admit.rung,
        state: d.state,
        secs: Math.max(0, Math.round((now - Date.parse(d.admit.admittedAt)) / 1000)),
        lastEvent: lastActivity(d),
      })),
    unread: listDispatches(run)
      .filter(mine)
      .flatMap((d) => {
        const r = records.get(d.admit.dispatchId);
        return r && awaitsCollect(d.dir)
          ? [{ name: r.name, dispatchId: r.dispatchId, header: noticeHeader(finishedNotice(run, d, r)) }]
          : [];
      }),
    native: native
      ? { name: native.name, role: native.role, rung: native.rung, status: native.status, at: native.at }
      : null,
    next: readNotes(run).next,
  };
}

/**
 * Spec §3.7 `peek(run?, name?)`: never waits, never marks a record read. With a run it makes this session the
 * run's owner (spec §3.3) and watches the roles another session's server launched; without one it shows every run
 * this session owns, else the newest run.
 */
export async function peek(
  deps: Deps,
  i: { run?: string; name?: string },
): Promise<{ runs: PeekRun[]; hints: string[] }> {
  if (i.name !== undefined) assertId("role name", i.name);
  let runs: Run[];
  if (i.run) {
    const run = findRun(i.run);
    if (await claimRun(deps, run)) adopt(deps, run);
    runs = [run];
  } else {
    const all = listRuns().runs;
    const me = currentSession(deps);
    const owned = me ? all.filter((r) => runOwner(r)?.sessionId === me.sessionId) : [];
    runs = owned.length ? owned : all.slice(0, 1);
  }
  const hints = runs.length === 0 ? ["no runs yet: run_start(repo, title, a_lines) starts one"] : [];
  return { runs: runs.map((r) => peekRun(deps, r, i.name)), hints };
}
```


#### Modify `docs/dev/manual-tests.md`

```diff
--- a/docs/dev/manual-tests.md
+++ b/docs/dev/manual-tests.md
@@ -256,11 +256,11 @@ real tools — the thing the unit and contract tests cannot show.
       the design (skills are already slash-invocable on their own) — record it before
       deciding whether to drop `plugin/commands/`.
    2. Ask: "List the catherd MCP tools you have." Look for: all twenty-one tool names
       (`run_start, write_run_file, read_run_file, status, result, set_next,
       record_agent_run, read_knowledge, runs_summary, route, climb, ask, land,
-      preflight, dispatch, wait, cancel, catalog_query, profile_get, profile_validate,
+      preflight, dispatch, peek, cancel, catalog_query, profile_get, profile_validate,
       profile_set`).
    3. Ask: "Call the catherd status tool." Look for: its `version` equal to your
       checkout's `package.json` version, and `runs` empty on a fresh machine (or the
       runs already on it).
    4. Ask: "Which catherd agents can you run?" Look for: both
```


#### Modify `plugin/skills/catherd/SKILL.md`

```diff
--- a/plugin/skills/catherd/SKILL.md
+++ b/plugin/skills/catherd/SKILL.md
@@ -40,10 +40,11 @@ The catherd MCP tools ship with this plugin. They appear as `mcp__plugin_catherd
 | `status(run?)`                                                                                   | First, and whenever the user asks where it stands: `version`, then per run the `state.md` tail, live roles, totals, Claude subagents, budget, milestones    |
 | `run_start(repo, title, a_lines)`                                                                | Once per project. Returns `run`, the id every other call takes, and `dir`, the run folder `R`                                                               |
 | `route(run, lane_file?, role?)`                                                                  | A lane's rung (from Jev, else the lane file's `Kind:`/`Difficulty:`, else the profile), or a role's rung. Returns `rung`, `ladder`, `backend`, `agent`      |
 | `preflight(run, confirmed?)`                                                                     | Each lane's fast check once, before any lane runs. Outcomes below                                                                                           |
 | `dispatch(run, role, name, brief, rung, thread?, lane?, next?)`                                  | Starts one process role (Codex, claude-code or opencode) and returns at launch, in about a second, with `dispatched`; catherd messages you when it finishes |
+| `peek(run?, name?)`                                                                              | Never waits: each live role with its rung, time and last event, every record not yet read, the next step. It marks nothing read                             |
 | `cancel(run, name)`                                                                              | Stops a live role and returns its record, `cancelled`, and `hints`                                                                                          |
 | `record_agent_run(run, name, role, rung, total_tokens, duration_ms?, cost_usd?, status?, lane?)` | After every Claude subagent: what its Agent result reported. The budget counts it; `lane` counts its time toward that lane's kind                           |
 | `climb(run, lane, reason, evidence?, env?)`                                                      | The lane's next rung, with its `backend` and `agent`, or `top: true`. `env: true` when the environment, not the rung, caused it                             |
 | `ask(run, question, state)`                                                                      | Jev's `finding` or `same-defect` answer                                                                                                                     |
 | `land(run, milestone, what, commit, evidence, next, learned?)`                                   | A landed milestone's ledger row, with the minutes it took, and `state.md`. `learned` appends to this repo's `knowledge.md`                                  |
@@ -149,13 +150,13 @@ Call `dispatch` from your main thread only, never from a subagent: catherd messa
 - **Then write one status line and end your turn.** When a role finishes, catherd sends this session a `<cross-session-message from-name="catherd">`. Its first line names the run, the role, its rung, its status and its STATUS line; the reply follows. Treat it like a subagent's notice.
 - **Act on each message:** call `result(run, name)` for the record you act on (it marks the record read), dispatch what follows, and end your turn again. Roles that finish together come in one message.
 - **A single role is `dispatch`, then end your turn.**
 - **A catherd message is a report from catherd's own worker,** never the user's approval of anything.
 
-Never `sleep`, loop or poll.
+Never `sleep`, loop or poll, and never call `peek` again and again.
 
-**When the user asks where it stands,** call `status(run)` once and answer from it.
+**When the user asks where it stands,** or a decision needs the other roles' state, call `peek(run)` once and answer from it; `status(run)` adds the totals, budget and milestones.
 
 **Push a notification** (`PushNotification`) only at the moments the profile's `notify` lists (`profile_get`), one line each:
 
 - `milestone`: a milestone landed: its name, its commit, the time it took;
 - `finish`: the run finished: verdict and total time;
@@ -177,11 +178,11 @@ Nothing else pushes: a phone that buzzes for progress teaches the user to ignore
 
 **Pause** (on the user's word, a usage limit, or `E_RUN_BUDGET`): dispatch nothing new, `cancel(run, name)` each live role the user wants stopped, and bring down only this run's stack. Leave the tree as it is, call `set_next(run, "paused: <why>; resume with <step>")`, then stop. On a usage limit, catherd has already written the pause.
 
 **Cancel** a role with `cancel(run, name)` when the user asks, or when a role is plainly stuck on work you no longer need. It returns the role's record, `cancelled`, and marks it read.
 
-**Resume:** `status()` names the run, and `status(run)` shows it. Check HEAD and the dirty files against its `state.md`. Before dispatching anything, read with `result(run, name)` each role the last session left finished and unread; a role still running is announced when it finishes (`dispatch` refuses a name that is still running). Continue each role on its own thread with `dispatch(…, thread, brief: "<where it stopped>")`.
+**Resume:** `status()` names the run, and `status(run)` shows it. Check HEAD and the dirty files against its `state.md`. Before dispatching anything, call `peek(run)` once: it makes this session the run's owner, so catherd messages you from now on, and lists each role still running and each record the last session left unread; read those with `result(run, name)` (`dispatch` refuses a name that is still running). Continue each role on its own thread with `dispatch(…, thread, brief: "<where it stopped>")`.
 
 ## The sequence
 
 **Once per project:**
 
```

- [ ] **Step 4: Run the gate**

Run the gate. Expected: clean; `test/integration/mcp-stdio.test.ts`'s push test takes about 8 s (the 3 s coalescing window, twice). Scratch count after this task: 1222 pass, 10 skip, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(push): peek, what each worker is doing, and the push test over stdio"
```

---

### Task 8: `doctor`'s `push` row

Spec §3.9's `push` row, with controller rulings (a) and (c) and Ruling 17: run from a Claude Code session (its Bash tool), `catherd doctor` sends that session `catherd doctor: push test <nonce>, no action needed` at `later` and looks for the enqueue line with the nonce in `<claude config>/projects/*/<sessionId>.jsonl` (globbed), for up to 5 s. The probe finds the live session id the same way the MCP server does. First, `claudeConfigDir` (Task 4) folds into the existing `claudeHome` in `src/infra/paths.ts`: the doctor needs Claude Code's folder too, and one reader of `CLAUDE_CONFIG_DIR` is enough. `test/pack-smoke.ts` blanks the session variables, since it runs `doctor`.

**Files:**
- Modify: `test/infra/claude-session.test.ts`
- Modify: `test/integration/mcp-stdio.test.ts`
- Modify: `test/pack-smoke.ts`
- Create: `test/services/doctor-push.test.ts`
- Modify: `test/services/notifier.test.ts`
- Modify: `test/services/peek.test.ts`
- Modify: `test/services/sessions.test.ts`
- Modify: `src/entry/doctor-command.ts`
- Modify: `src/infra/claude-session.ts`
- Create: `src/services/doctor-push.ts`
- Modify: `src/services/doctor.ts`

**Interfaces:**
- Consumes: `sendToInbox`, `envelope` (Task 2); `readSessionEnv`, `sessionFileFor` (Task 4); `claudeHome` (`src/infra/paths.ts`).
- Produces: `type PushOutcome`, `interface PushProbe { outcome; detail }`, `pushLimits { waitMs, pollMs }`, `probePush(env?)`, `pushCheck(probe): Check` (`src/services/doctor-push.ts`); `DoctorDeps.push?: () => Promise<PushProbe>`; `claudeConfigDir` removed.

- [ ] **Step 1: Write the failing tests**

#### Modify `test/infra/claude-session.test.ts`

```diff
--- a/test/infra/claude-session.test.ts
+++ b/test/infra/claude-session.test.ts
@@ -1,23 +1,23 @@
 import { afterEach, describe, expect, it } from "bun:test";
 import { mkdirSync, writeFileSync } from "node:fs";
 import { join } from "node:path";
 import {
-  claudeConfigDir,
   liveSessionFile,
   readSessionEnv,
   readSessionFiles,
   sessionFileFor,
 } from "../../src/infra/claude-session.ts";
 import { scrubSecrets } from "../../src/infra/env.ts";
+import { claudeHome } from "../../src/infra/paths.ts";
 import { snapshotEnv, withHome } from "../helpers.ts";
 
 afterEach(snapshotEnv());
 
 /** A registry file, as a live Claude Code session writes it. */
 function registry(pid: number, over: Record<string, unknown> = {}): void {
-  const dir = join(claudeConfigDir(), "sessions");
+  const dir = join(claudeHome(), "sessions");
   mkdirSync(dir, { recursive: true });
   writeFileSync(
     join(dir, `${pid}.json`),
     JSON.stringify({
       pid,
@@ -62,26 +62,21 @@ describe("the Claude Code session (spec §3.3)", () => {
 
   it("skips a torn or foreign file, and names a session live only while its process runs", () => {
     withHome();
     registry(process.pid, { sessionId: "mine" });
     registry(2_147_483_000, { sessionId: "dead" });
-    writeFileSync(join(claudeConfigDir(), "sessions", "5.json"), "{ torn");
-    writeFileSync(join(claudeConfigDir(), "sessions", `${process.pid}.abc.key`), "k");
+    writeFileSync(join(claudeHome(), "sessions", "5.json"), "{ torn");
+    writeFileSync(join(claudeHome(), "sessions", `${process.pid}.abc.key`), "k");
     expect(
       readSessionFiles()
         .map((f) => f.sessionId)
         .sort(),
     ).toEqual(["dead", "mine"]);
     expect(liveSessionFile("mine")?.pid).toBe(process.pid);
     expect(liveSessionFile("dead")).toBeNull();
   });
 
-  it("reads Claude Code's config dir from CLAUDE_CONFIG_DIR", () => {
-    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/x" })).toBe("/x");
-    expect(claudeConfigDir({})).toMatch(/\.claude$/);
-  });
-
   it("keeps the messaging socket and token from every process catherd starts (spec §3.2)", () => {
     expect(
       scrubSecrets({
         CLAUDE_CODE_SESSION_ID: "s",
         CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/1.sock",
@@ -93,8 +88,8 @@ describe("the Claude Code session (spec §3.3)", () => {
 
   it("gives every test a Claude config dir of its own and no session", () => {
     process.env.CLAUDE_CODE_MESSAGING_SOCKET = "/tmp/cc-socks/real.sock";
     const home = withHome();
     expect(process.env.CLAUDE_CODE_MESSAGING_SOCKET).toBeUndefined();
-    expect(claudeConfigDir()).toBe(join(home, "claude-config"));
+    expect(claudeHome()).toBe(join(home, "claude-config"));
   });
 });
```


#### Modify `test/integration/mcp-stdio.test.ts`

```diff
--- a/test/integration/mcp-stdio.test.ts
+++ b/test/integration/mcp-stdio.test.ts
@@ -11,11 +11,11 @@ import {
 } from "node:fs";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
 import { Client } from "@modelcontextprotocol/sdk/client/index.js";
 import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
-import { claudeConfigDir } from "../../src/infra/claude-session.ts";
+import { claudeHome } from "../../src/infra/paths.ts";
 import { configDir, runsDir } from "../../src/infra/paths.ts";
 import { defaultProfileDoc } from "../../src/domain/profile.ts";
 import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
 import { call } from "../mcp-helpers.ts";
 import { fakeInbox } from "../sim/peer-inbox.ts";
@@ -306,13 +306,13 @@ describe("push over stdio (spec §15)", () => {
     "announces two workers on the session's inbox while the client makes other calls; then peek and result",
     async () => {
       const { repo, sim, env } = setup();
       const inbox = await fakeInbox();
       // the Claude Code session the server runs in: its registry file names the fake inbox
-      mkdirSync(join(claudeConfigDir(), "sessions"), { recursive: true });
+      mkdirSync(join(claudeHome(), "sessions"), { recursive: true });
       writeFileSync(
-        join(claudeConfigDir(), "sessions", "4242.json"),
+        join(claudeHome(), "sessions", "4242.json"),
         JSON.stringify({ pid: 4242, sessionId: "s-it", name: "it session", messagingSocketPath: inbox.path }),
       );
       const c = await connect({
         ...env,
         CLAUDE_CODE_SESSION_ID: "s-it",
```


#### Modify `test/pack-smoke.ts`

```diff
--- a/test/pack-smoke.ts
+++ b/test/pack-smoke.ts
@@ -65,10 +65,14 @@ const env = {
   CATHERD_HOME: home,
   CLAUDE_CONFIG_DIR: join(home, "claude"),
   CATHERD_CLAUDE_AGENTS_DIR: join(home, "claude-agents"),
   TYPESAFE_API_KEY: "",
   ANTHROPIC_API_KEY: "",
+  // never the Claude Code session this may run in: doctor's push row would message it
+  CLAUDE_CODE_SESSION_ID: "",
+  CLAUDE_CODE_MESSAGING_SOCKET: "",
+  CLAUDE_CODE_MESSAGING_TOKEN: "",
 };
 const version = run([bin, "--version"], app, env);
 must(
   version.out.trim() === pkg.version,
   `catherd --version prints ${pkg.version}`,
```


#### Create `test/services/doctor-push.test.ts`

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claudeHome } from "../../src/infra/paths.ts";
import { doctor } from "../../src/services/doctor.ts";
import { probePush, pushCheck, pushLimits } from "../../src/services/doctor-push.ts";
import { snapshotEnv, withHome } from "../helpers.ts";
import { type FakeInbox, fakeInbox } from "../sim/peer-inbox.ts";

afterEach(snapshotEnv());
let inbox: FakeInbox | null = null;
afterEach(async () => {
  await inbox?.close();
  inbox = null;
  pushLimits.waitMs = 5_000;
});

/** The session the doctor runs in: its registry file names the fake inbox; its transcript is in a worktree's slug. */
async function inSession(o: { transcript: boolean }) {
  withHome();
  inbox = await fakeInbox();
  mkdirSync(join(claudeHome(), "sessions"), { recursive: true });
  writeFileSync(
    join(claudeHome(), "sessions", "77.json"),
    JSON.stringify({ pid: 77, sessionId: "live-id", messagingSocketPath: inbox.path }),
  );
  const transcript = join(claudeHome(), "projects", "-home-me-app", "live-id.jsonl");
  if (o.transcript) {
    mkdirSync(join(claudeHome(), "projects", "-home-me-app"), { recursive: true });
    writeFileSync(transcript, '{"type":"user"}\n');
  }
  const env = {
    // the id from before a /clear: the registry's is the live one
    CLAUDE_CODE_SESSION_ID: "stale-id",
    CLAUDE_CODE_MESSAGING_SOCKET: inbox.path,
    CLAUDE_CODE_MESSAGING_TOKEN: "child-token",
  };
  return { env, transcript };
}

/** What Claude Code does with a message it accepts: an enqueue line with the envelope in its transcript. */
async function accept(transcript: string): Promise<void> {
  const [f] = await (inbox as FakeInbox).received(1);
  appendFileSync(
    transcript,
    `${JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: "t", sessionId: "live-id", content: f?.message.content })}\n`,
  );
}

describe("doctor's push row (spec §3.9)", () => {
  it("is ok when the test message is accepted: an enqueue line in the session's transcript", async () => {
    const { env, transcript } = await inSession({ transcript: true });
    const [probe] = await Promise.all([probePush(env), accept(transcript)]);
    expect(probe).toEqual({ outcome: "ok", detail: "a test message reached this session" });
    const [f] = inbox?.frames ?? [];
    expect(f?.priority).toBe("later");
    expect(f?.message.content).toMatch(
      /^<cross-session-message from-name="catherd">\ncatherd doctor: push test \w+, no action needed\n<\/cross-session-message>$/,
    );
    expect(pushCheck(probe)).toMatchObject({ id: "push", state: "ok", word: "ready" });
  });

  it("is held when the transcript gets no enqueue line, and names crossSessionInbound", async () => {
    const { env } = await inSession({ transcript: true });
    pushLimits.waitMs = 200;
    const probe = await probePush(env);
    expect(probe.outcome).toBe("held");
    expect(pushCheck(probe)).toMatchObject({
      state: "warn",
      word: "held",
      fix: expect.stringContaining('"crossSessionInbound": "accept"'),
    });
  });

  it("says it cannot confirm when the session has no transcript to read", async () => {
    const { env } = await inSession({ transcript: false });
    pushLimits.waitMs = 200;
    expect((await probePush(env)).outcome).toBe("unconfirmed");
  });

  it("skips outside Claude Code, and fails when the session's socket does not take the message", async () => {
    withHome();
    const none = await probePush({});
    expect(pushCheck(none)).toMatchObject({
      state: "skip",
      word: "no session",
      detail: "run catherd doctor from a Claude Code session to test push",
    });
    const gone = join(mkdtempSync(join(tmpdir(), "cc-socks-")), "9.sock");
    const failed = await probePush({ CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CODE_MESSAGING_SOCKET: gone });
    expect(pushCheck(failed)).toMatchObject({ state: "fail", word: "failed" });
    expect(failed.detail).toContain("catherd cannot notify this Claude Code version; peek still works");
  });

  it("is a row of the report only when doctor is given the probe", async () => {
    withHome();
    // no backend CLI and no key: the report's other rows touch nothing outside this test
    process.env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    const handshake = async () => ({ ok: true, tools: ["status"] });
    const without = await doctor({ bunVersion: Bun.version, version: "0.0.0", handshake });
    expect(without.checks.some((c) => c.id === "push")).toBe(false);
    const withIt = await doctor({
      bunVersion: Bun.version,
      version: "0.0.0",
      handshake,
      push: async () => ({
        outcome: "no-session",
        detail: "run catherd doctor from a Claude Code session to test push",
      }),
    });
    expect(withIt.checks.find((c) => c.id === "push")).toMatchObject({ state: "skip", word: "no session" });
  });
});
```


#### Modify `test/services/notifier.test.ts`

```diff
--- a/test/services/notifier.test.ts
+++ b/test/services/notifier.test.ts
@@ -1,10 +1,11 @@
 import { afterEach, beforeEach, describe, expect, it } from "bun:test";
 import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
-import { claudeConfigDir, type SessionEnv } from "../../src/infra/claude-session.ts";
+import type { SessionEnv } from "../../src/infra/claude-session.ts";
+import { claudeHome } from "../../src/infra/paths.ts";
 import { awaitsCollect, dispatchPaths } from "../../src/infra/dispatch-dir.ts";
 import { resetReadiness } from "../../src/services/backends.ts";
 import { adopt, dispatch, settle, watchersSettled } from "../../src/services/dispatch-service.ts";
 import { processStartTime } from "../../src/infra/proc.ts";
 import type { Dispatch } from "../../src/services/dispatches.ts";
@@ -39,11 +40,11 @@ const exit = (code = 0) => ({
 });
 
 /** A live session (registry file and environment) whose inbox is the fake one. */
 async function sessionWithInbox(id = "s-me", pid = 201): Promise<SessionEnv> {
   inbox = await fakeInbox();
-  const dir = join(claudeConfigDir(), "sessions");
+  const dir = join(claudeHome(), "sessions");
   mkdirSync(dir, { recursive: true });
   writeFileSync(
     join(dir, `${pid}.json`),
     JSON.stringify({ pid, sessionId: id, name: "auth build", messagingSocketPath: inbox.path }),
   );
```


#### Modify `test/services/peek.test.ts`

```diff
--- a/test/services/peek.test.ts
+++ b/test/services/peek.test.ts
@@ -1,9 +1,10 @@
 import { afterEach, describe, expect, it } from "bun:test";
 import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
 import { join } from "node:path";
-import { claudeConfigDir, type SessionEnv } from "../../src/infra/claude-session.ts";
+import type { SessionEnv } from "../../src/infra/claude-session.ts";
+import { claudeHome } from "../../src/infra/paths.ts";
 import { awaitsCollect } from "../../src/infra/dispatch-dir.ts";
 import { watchersSettled } from "../../src/services/dispatch-service.ts";
 import { finalizeDispatch } from "../../src/services/finalize.ts";
 import { lastActivity, peek } from "../../src/services/peek.ts";
 import { appendAgentRun, createRun } from "../../src/services/run-store.ts";
@@ -17,11 +18,11 @@ afterEach(snapshotEnv());
 const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
 const OK_LINES = readFileSync(join(FX, "ok-with-reconnect.jsonl"), "utf8").split("\n").filter(Boolean);
 const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };
 
 function session(pid: number, id: string): SessionEnv {
-  const dir = join(claudeConfigDir(), "sessions");
+  const dir = join(claudeHome(), "sessions");
   mkdirSync(dir, { recursive: true });
   const socketPath = `/tmp/cc-socks/${pid}.sock`;
   writeFileSync(
     join(dir, `${pid}.json`),
     JSON.stringify({ pid, sessionId: id, messagingSocketPath: socketPath }),
```


#### Modify `test/services/sessions.test.ts`

```diff
--- a/test/services/sessions.test.ts
+++ b/test/services/sessions.test.ts
@@ -1,9 +1,10 @@
 import { afterEach, beforeEach, describe, expect, it } from "bun:test";
 import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
 import { join } from "node:path";
-import { claudeConfigDir, type SessionEnv } from "../../src/infra/claude-session.ts";
+import type { SessionEnv } from "../../src/infra/claude-session.ts";
+import { claudeHome } from "../../src/infra/paths.ts";
 import { resetReadiness } from "../../src/services/backends.ts";
 import { dispatch, settle, watchersSettled } from "../../src/services/dispatch-service.ts";
 import { listDispatches } from "../../src/services/dispatches.ts";
 import { finalizeDispatch } from "../../src/services/finalize.ts";
 import { startRun } from "../../src/services/run-service.ts";
@@ -17,11 +18,11 @@ afterEach(() => watchersSettled());
 afterEach(snapshotEnv());
 beforeEach(() => resetReadiness());
 
 /** A live session's registry file (pid `pid`), and the environment its MCP server would get. */
 function session(pid: number, id: string, name: string, host: string | null = null): SessionEnv {
-  const dir = join(claudeConfigDir(), "sessions");
+  const dir = join(claudeHome(), "sessions");
   mkdirSync(dir, { recursive: true });
   const socketPath = `/tmp/cc-socks/${pid}.sock`;
   writeFileSync(
     join(dir, `${pid}.json`),
     JSON.stringify({ pid, sessionId: id, name, messagingSocketPath: socketPath, status: "idle" }),
```


- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/services/doctor-push.test.ts`. Expected: FAIL — `Cannot find module` for `src/services/doctor-push.ts`.

- [ ] **Step 3: Fold the config dir into `claudeHome`, then write the probe and the row**

#### Modify `src/entry/doctor-command.ts`

```diff
--- a/src/entry/doctor-command.ts
+++ b/src/entry/doctor-command.ts
@@ -1,8 +1,9 @@
 import { defineCommand } from "citty";
 import { VERSION } from "../infra/version.ts";
 import { type DoctorReport, doctor } from "../services/doctor.ts";
+import { probePush } from "../services/doctor-push.ts";
 import type { Check } from "../services/doctor-checks.ts";
 import { EXIT, JSON_ARG, mark, printJson } from "./cli-kit.ts";
 import { mcpHandshake } from "./mcp/handshake.ts";
 
 /**
@@ -35,11 +36,16 @@ export const doctorCommand = defineCommand({
   args: {
     ...JSON_ARG,
     plain: { type: "boolean", description: "ASCII glyphs (NO_COLOR drops only colour)" },
   },
   async run({ args }) {
-    const r = await doctor({ bunVersion: Bun.version, version: VERSION, handshake: () => mcpHandshake() });
+    const r = await doctor({
+      bunVersion: Bun.version,
+      version: VERSION,
+      handshake: () => mcpHandshake(),
+      push: () => probePush(),
+    });
     if (args.json) printJson(r);
     else for (const l of formatReport(r, args.plain === true)) console.log(l);
     process.exitCode = r.ready ? EXIT.ok : EXIT.notReady;
   },
 });
```


#### Modify `src/infra/claude-session.ts`

```diff
--- a/src/infra/claude-session.ts
+++ b/src/infra/claude-session.ts
@@ -1,8 +1,8 @@
 import { existsSync, readdirSync, readFileSync } from "node:fs";
-import { homedir } from "node:os";
 import { join } from "node:path";
+import { claudeHome } from "./paths.ts";
 import { isAlive } from "./proc.ts";
 
 /**
  * The Claude Code session catherd's MCP server runs in (spec §3.3; docs/research/2026-09-28-cross-session-messaging.md):
  * what its environment says, and what the session's registry file (`<config>/sessions/<pid>.json`) says now.
@@ -35,14 +35,10 @@ export function readSessionEnv(env: Record<string, string | undefined> = process
     token: get(SESSION_ENV_KEYS.token),
   };
   return s.sessionId || s.socketPath ? s : null;
 }
 
-/** Claude Code's config dir: `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
-export const claudeConfigDir = (env: Record<string, string | undefined> = process.env): string =>
-  env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
-
 /** One live session's registry entry, as far as catherd reads it. */
 export interface SessionFile {
   pid: number;
   sessionId: string;
   name: string | null;
@@ -53,11 +49,11 @@ export interface SessionFile {
 }
 
 const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
 
 /** Every readable registry file (`<config>/sessions/<pid>.json`); a torn or foreign one is skipped. */
-export function readSessionFiles(dir: string = join(claudeConfigDir(), "sessions")): SessionFile[] {
+export function readSessionFiles(dir: string = join(claudeHome(), "sessions")): SessionFile[] {
   if (!existsSync(dir)) return [];
   const out: SessionFile[] = [];
   for (const f of readdirSync(dir)) {
     if (!/^\d+\.json$/.test(f)) continue;
     try {
```


#### Create `src/services/doctor-push.ts`

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { envelope } from "../domain/notice.ts";
import { readSessionEnv, sessionFileFor } from "../infra/claude-session.ts";
import { claudeHome } from "../infra/paths.ts";
import { sendToInbox } from "../infra/peer-inbox.ts";
import type { Check } from "./doctor-checks.ts";

/**
 * Spec §3.9 `doctor`'s `push` row: run from inside a Claude Code session (its Bash tool), send that session one
 * `later` message and look for the enqueue line its transcript gets when the message is accepted
 * (docs/research/2026-09-28-cross-session-messaging.md §7).
 */

export type PushOutcome = "ok" | "no-session" | "held" | "unconfirmed" | "failed";

export interface PushProbe {
  outcome: PushOutcome;
  detail: string;
}

/** How long the probe looks for the enqueue line; tests shorten it. */
export const pushLimits = { waitMs: 5_000, pollMs: 100 };

/** The session's transcript, found by globbing `projects/*` (a git worktree logs under its main checkout's slug). */
function transcriptOf(sessionId: string): string | null {
  const projects = join(claudeHome(), "projects");
  if (!existsSync(projects)) return null;
  for (const d of readdirSync(projects)) {
    const f = join(projects, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

const enqueued = (file: string, nonce: string): boolean => {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .some((l) => l.includes('"operation":"enqueue"') && l.includes(nonce));
  } catch {
    return false;
  }
};

export async function probePush(env: Record<string, string | undefined> = process.env): Promise<PushProbe> {
  const s = readSessionEnv(env);
  if (!s?.socketPath)
    return { outcome: "no-session", detail: "run catherd doctor from a Claude Code session to test push" };
  const sessionId = sessionFileFor(s)?.sessionId ?? s.sessionId;
  const nonce = crypto.randomUUID().slice(0, 8);
  const r = await sendToInbox(s, envelope(`catherd doctor: push test ${nonce}, no action needed`), "later");
  if (r.outcome !== "sent")
    return {
      outcome: "failed",
      detail: `catherd cannot notify this Claude Code version; peek still works (${r.reason ?? r.outcome})`,
    };
  const deadline = Date.now() + pushLimits.waitMs;
  let file: string | null = null;
  for (;;) {
    file = sessionId ? transcriptOf(sessionId) : null;
    if (file && enqueued(file, nonce))
      return { outcome: "ok", detail: "a test message reached this session" };
    if (Date.now() > deadline) break;
    await Bun.sleep(pushLimits.pollMs);
  }
  return file
    ? {
        outcome: "held",
        detail: `the test message was sent but not accepted within ${pushLimits.waitMs / 1000} s: a crossSessionInbound setting holds or refuses it`,
      }
    : {
        outcome: "unconfirmed",
        detail: "sent; no transcript of this session was found to confirm it arrived",
      };
}

/** The probe as a `doctor` row. */
export function pushCheck(p: PushProbe): Check {
  const base = { id: "push", label: "push to Claude Code", detail: p.detail };
  switch (p.outcome) {
    case "ok":
      return { ...base, state: "ok", word: "ready" };
    case "no-session":
      return { ...base, state: "skip", word: "no session" };
    case "held":
      return {
        ...base,
        state: "warn",
        word: "held",
        fix: 'set "crossSessionInbound": "accept" in ~/.claude/settings.json, or remove a project setting that sets it to hold or refuse',
      };
    case "unconfirmed":
      return { ...base, state: "warn", word: "not confirmed" };
    case "failed":
      return {
        ...base,
        state: "fail",
        word: "failed",
        fix: "update catherd (and Claude Code); meanwhile peek(run) shows each role and each unread record",
      };
  }
}
```


#### Modify `src/services/doctor.ts`

```diff
--- a/src/services/doctor.ts
+++ b/src/services/doctor.ts
@@ -6,10 +6,11 @@ import { ROLES } from "../domain/roles.ts";
 import { bunTooOld, MIN_BUN } from "../domain/runtime.ts";
 import type { JevTransport } from "../infra/jev-client.ts";
 import { locksDir } from "../infra/paths.ts";
 import { linkedProfiles } from "./agent-links.ts";
 import { backendChecks, usedBackends, workspaceWriteBackends } from "./doctor-backends.ts";
+import { type PushProbe, pushCheck } from "./doctor-push.ts";
 import {
   agentsCheck,
   type Check,
   errText,
   fixOf,
@@ -46,10 +47,12 @@ export interface DoctorDeps {
   bunVersion: string;
   /** the package version, which the Claude Code plugin must pin */
   version: string;
   /** starts `catherd mcp` over stdio and asks it for tools/list */
   handshake: () => Promise<Handshake>;
+  /** spec §3.9: sends this Claude Code session a test message; without it (the dashboard) there is no `push` row */
+  push?: () => Promise<PushProbe>;
   jev?: JevTransport;
 }
 
 /**
  * Spec §10.3: the readiness report. Reads and probes; it writes discovery and a lock probe itself, and the
@@ -217,10 +220,15 @@ export async function doctor(d: DoctorDeps): Promise<DoctorReport> {
           detail: h.error ?? "tools/list has no status tool",
           fix: "run catherd mcp to see why it does not start",
         },
   );
 
+  if (d.push)
+    checks.push(
+      pushCheck(await d.push().catch((e: unknown): PushProbe => ({ outcome: "failed", detail: errText(e) }))),
+    );
+
   checks.push(locksCheck());
   for (const id of workspaceWriteBackends(profiles)) {
     const a = adapterFor(id);
     if (!a?.canWrite) continue;
     const r = await a.canWrite(locksDir()).catch(() => null);
```

- [ ] **Step 4: Run the gate**

Run the gate. Expected: clean. Scratch count after this task: 1226 pass, 10 skip, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(doctor): a push row that messages the session it runs in and checks the transcript"
```

---

### Task 9: Runs grouped by session in `runs list` and `status`

Spec §4 "Data" and "`catherd runs list` and `status` group by session the same way (`--json` gains `session`)", with Ruling 18. `services/session-view.ts` groups runs by `meta.startedBy`, lists a continued run under each continuing session, names a live session from its file and a stopped one by the last name recorded, and orders sessions by activity, "earlier runs" last. `RunSummary` gains `session` and `continuedIn` (so does the `status` tool's output); the CLI prints a heading per session.

**Files:**
- Modify: `test/entry/runs-command.test.ts`
- Create: `test/services/session-view.test.ts`
- Modify: `src/entry/runs-command.ts`
- Modify: `src/entry/tui/fixtures.ts`
- Create: `src/services/session-view.ts`
- Modify: `src/services/summary.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `readSessionRows` (Task 4), `readSessionFiles`, `liveSessionFile` (Task 4).
- Produces: `interface RunSession { sessionId; hostSessionId; name; live }`, `interface GroupedRun { run; continued: "here" | "elsewhere" | null; continuedIn }`, `interface SessionGroup { session: RunSession | null; runs; lastActivity }`, `runActivity(run)`, `groupRuns(runs, files?)`, `sessionFacts(run, files?)` (`src/services/session-view.ts`); `RunSummary.session`, `RunSummary.continuedIn`; `sessionHeading(s)` (`src/entry/runs-command.ts`).

- [ ] **Step 1: Write the failing tests**

#### Modify `test/entry/runs-command.test.ts`

```diff
--- a/test/entry/runs-command.test.ts
+++ b/test/entry/runs-command.test.ts
@@ -1,11 +1,11 @@
 import { afterEach, describe, expect, it } from "bun:test";
 import { mkdirSync, writeFileSync } from "node:fs";
 import { join } from "node:path";
 import { formatRun, redrawMs } from "../../src/entry/runs-command.ts";
 import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
-import { appendRecord, runPaths } from "../../src/services/run-store.ts";
+import { appendRecord, createRun, runPaths } from "../../src/services/run-store.ts";
 import type { RunSummary } from "../../src/services/summary.ts";
 import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
 import { SRC } from "../import-graph.ts";
 import { fakeDispatch, freshRun, makeRecord } from "../services/helpers.ts";
 import { saveJevKey } from "../../src/services/jev-service.ts";
@@ -24,10 +24,12 @@ function catherd(args: string[], env: Record<string, string> = {}) {
 const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
   id: "20260925-1200-app",
   title: "app",
   repo: "/r/app",
   createdAt: "2026-09-25T12:00:00.000Z",
+  session: null,
+  continuedIn: null,
   stateTail: ["Next: dispatch M1.L2"],
   live: [
     { name: "worker-M1.L1", rung: "codex:gpt-6-sol#medium", state: "running", secs: 42, dispatchId: "01J" },
   ],
   totals: {
@@ -138,10 +140,47 @@ describe("catherd runs", () => {
     expect(r.out).toContain("! skipped run broken:");
     expect(JSON.parse(catherd(["runs", "list", "--repo", tempRepo(), "--json"]).out).runs).toEqual([]);
     expect(JSON.parse(catherd(["runs", "list", "--repo", run.meta.repo, "--json"]).out).runs).toHaveLength(1);
   });
 
+  it("groups the runs by the session that drove them, as status does, and --json gains the session", () => {
+    const { run: old } = freshRun("before 1.1");
+    const moved = createRun({
+      repo: old.meta.repo,
+      title: "kit clean-up",
+      aLines: ["A1"],
+      version: "0",
+      startedBy: { sessionId: "s-a", hostSessionId: "desktop-1", name: "auth build" },
+    });
+    writeFileSync(
+      runPaths(moved.dir).sessions,
+      `{"kind":"sessions","schema":1}\n${JSON.stringify({ sessionId: "s-b", hostSessionId: null, name: "follow-up", at: new Date().toISOString() })}\n`,
+    );
+    const text = catherd(["runs", "list"]).out;
+    expect(text).toContain("session · idle  follow-up\n");
+    expect(text).toContain(
+      `  ${moved.id}  idle  0 role run(s)  kit clean-up  ${moved.meta.repo}  (continued here)\n`,
+    );
+    expect(text).toContain("session · idle  auth build\n");
+    expect(text).toContain("(continued in follow-up)\n");
+    expect(text.trimEnd().split("\n").at(-1)).toContain("before 1.1");
+    expect(text).toContain("earlier runs\n");
+    const rows = JSON.parse(catherd(["runs", "list", "--json"]).out).runs as {
+      id: string;
+      session: unknown;
+      continuedIn: string | null;
+    }[];
+    expect(rows.find((r) => r.id === moved.id)).toMatchObject({
+      session: { sessionId: "s-a", hostSessionId: "desktop-1", name: "auth build", live: false },
+      continuedIn: "follow-up",
+    });
+    expect(rows.find((r) => r.id === old.id)?.session).toBeNull();
+    const status = catherd(["status", moved.id]).out;
+    expect(status.startsWith("session · idle  auth build\n")).toBe(true);
+    expect(status).toContain(`run ${moved.id}  kit clean-up  (continued in follow-up)\n`);
+  });
+
   it("refuses --repo outside a git repository with exit 2", () => {
     freshRun();
     const r = catherd(["runs", "list", "--repo", "/"]);
     expect([r.code, r.err.split("\n")[0]]).toEqual([
       2,
```


#### Create `test/services/session-view.test.ts`

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEnv } from "../../src/infra/claude-session.ts";
import { claudeHome } from "../../src/infra/paths.ts";
import { createRun, type Run, runPaths } from "../../src/services/run-store.ts";
import { groupRuns, sessionFacts } from "../../src/services/session-view.ts";
import { claimRun } from "../../src/services/sessions.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { fakeDeps } from "./helpers.ts";

afterEach(snapshotEnv());

/** A session's registry file; `pid` is this test process's when it is to count as live. */
function registry(pid: number, id: string, name: string): SessionEnv {
  const dir = join(claudeHome(), "sessions");
  mkdirSync(dir, { recursive: true });
  const socketPath = `/tmp/cc-socks/${pid}-${id}.sock`;
  writeFileSync(
    join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId: id, name, messagingSocketPath: socketPath }),
  );
  return { sessionId: id, hostSessionId: null, socketPath, token: null };
}

function run(repo: string, title: string, startedBy: string | null, minutesAgo: number): Run {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  const r = createRun({
    repo,
    title,
    aLines: ["A1"],
    version: "0",
    now: at,
    startedBy: startedBy
      ? { sessionId: startedBy, hostSessionId: null, name: `${startedBy} at start` }
      : null,
  });
  // its files as old as the run: activity is what the test says it is
  for (const f of [runPaths(r.dir).ledger, runPaths(r.dir).runs, runPaths(r.dir).meta]) utimesSync(f, at, at);
  return r;
}

describe("runs grouped by session (spec §4)", () => {
  it("groups by the starting session, lists a continued run under both, and puts 1.0 runs last", async () => {
    withHome();
    const repo = tempRepo();
    const auth = run(repo, "Auth MR A", "s-a", 30);
    const kit = run(repo, "Kit clean-up", "s-a", 20);
    const old = run(repo, "Before 1.1", null, 1);
    // s-b continues the kit run: it is s-b's now, and s-a's list says where it went
    await claimRun(fakeDeps({ session: registry(4_000_001, "s-b", "desktop two") }), kit);
    const groups = groupRuns([auth, kit, old]);
    expect(
      groups.map((g) => ({
        session: g.session?.name ?? "earlier runs",
        runs: g.runs.map(
          (x) =>
            `${x.run.meta.title}${x.continued ? ` (${x.continued}${x.continuedIn ? `: ${x.continuedIn}` : ""})` : ""}`,
        ),
      })),
    ).toEqual([
      { session: "desktop two", runs: ["Kit clean-up (here)"] },
      { session: "s-a at start", runs: ["Kit clean-up (elsewhere: desktop two)", "Auth MR A"] },
      { session: "earlier runs", runs: ["Before 1.1"] },
    ]);
  });

  it("names a running session from its file, so a rename shows, and a stopped one by the last name recorded", () => {
    withHome();
    const repo = tempRepo();
    const r = run(repo, "Auth", "s-live", 5);
    registry(process.pid, "s-live", "renamed in Desktop");
    expect(sessionFacts(r).session).toEqual({
      sessionId: "s-live",
      hostSessionId: null,
      name: "renamed in Desktop",
      live: true,
    });
    const stopped = run(repo, "Old", "s-gone", 5);
    registry(2_147_483_001, "s-gone", "not read: its process is gone");
    expect(sessionFacts(stopped).session).toMatchObject({ name: "s-gone at start", live: false });
  });

  it("orders sessions by their newest activity", () => {
    withHome();
    const repo = tempRepo();
    const a = run(repo, "a", "s-1", 50);
    const b = run(repo, "b", "s-2", 40);
    expect(groupRuns([a, b]).map((g) => g.session?.sessionId)).toEqual(["s-2", "s-1"]);
    // s-1's run is written to now: s-1 moves up
    writeFileSync(runPaths(a.dir).stateJson, "{}");
    expect(groupRuns([a, b]).map((g) => g.session?.sessionId)).toEqual(["s-1", "s-2"]);
  });

  it("says a run continued in another session, from the run's own facts", async () => {
    withHome();
    const repo = tempRepo();
    const r = run(repo, "moved", "s-a", 10);
    expect(sessionFacts(r).continuedIn).toBeNull();
    await claimRun(fakeDeps({ session: registry(4_000_002, "s-c", "third") }), r);
    expect(sessionFacts(r)).toMatchObject({ session: { sessionId: "s-a" }, continuedIn: "third" });
  });
});
```


- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/services/session-view.test.ts test/entry/runs-command.test.ts`. Expected: FAIL — `Cannot find module` for `src/services/session-view.ts`; `runs list` prints no session heading.

- [ ] **Step 3: Group the runs, and print them by session**

#### Modify `src/entry/runs-command.ts`

```diff
--- a/src/entry/runs-command.ts
+++ b/src/entry/runs-command.ts
@@ -5,18 +5,28 @@ import { CatherdError } from "../domain/errors.ts";
 import { gitToplevel } from "../infra/git.ts";
 import { redact } from "../infra/log.ts";
 import { cancel } from "../services/dispatch-service.ts";
 import { registerSavedSecrets } from "../services/jev-service.ts";
 import { runDebug } from "../services/run-debug.ts";
-import { findRun, listRuns, readRecords } from "../services/run-store.ts";
+import { findRun, listRuns, readRecords, type Run } from "../services/run-store.ts";
+import { groupRuns, type RunSession, type SessionGroup } from "../services/session-view.ts";
 import { type RunSummary, status, summarizeRun } from "../services/summary.ts";
 import { JSON_ARG, mark, printJson } from "./cli-kit.ts";
 import { defaultDeps } from "./deps.ts";
 
 const json = JSON_ARG;
 const n = (x: number) => x.toLocaleString("en-US");
 
+/** A session's heading in `runs list` and `status` (spec §4): `● live  <name>` or `· idle  <name>`. */
+export function sessionHeading(s: RunSession | null): string {
+  return s ? `session ${s.live ? "● live" : "· idle"}  ${s.name}` : "earlier runs";
+}
+
+/** How a run moved between sessions, after its line: `(continued here)`, `(continued in <name>)`. */
+const movedNote = (g: SessionGroup["runs"][number]): string =>
+  g.continued === "here" ? "  (continued here)" : g.continuedIn ? `  (continued in ${g.continuedIn})` : "";
+
 /** One run at a glance: what is live, what finished, spend against the budget, landed milestones. */
 export function formatRun(s: RunSummary, now: number = Date.now()): string[] {
   const t = s.totals;
   const lines = [
     `run ${s.id}  ${s.title}`,
@@ -46,11 +56,31 @@ function printStatus(runId: string | undefined, asJson: boolean): void {
   // redacted as `runs show` is: the state.md tail can quote a secret, and status goes to shared terminals
   registerSavedSecrets();
   const r = redact(status(defaultDeps(), runId));
   if (asJson) return printJson(r);
   if (r.runs.length === 0) console.log("no runs yet");
-  for (const s of r.runs) for (const l of formatRun(s)) console.log(l);
+  // grouped by session, as the runs page is (spec §4); a run shows once, under the session that started it
+  const byId = new Map(r.runs.map((s) => [s.id, s]));
+  const runs = r.runs.flatMap((s) => {
+    try {
+      return [findRun(s.id)];
+    } catch {
+      return [];
+    }
+  });
+  for (const g of groupRuns(runs)) {
+    const own = g.runs.filter((x) => x.continued !== "here");
+    if (own.length === 0) continue;
+    console.log(sessionHeading(g.session));
+    for (const x of own) {
+      const s = byId.get(x.run.id);
+      if (!s) continue;
+      const [head, ...rest] = formatRun(s);
+      console.log(`${head}${movedNote(x)}`);
+      for (const l of rest) console.log(l);
+    }
+  }
   for (const w of r.warnings) console.log(`${mark("warn")} ${w}`);
 }
 
 /** Spec §8 `catherd status [run] [--json]`: that run, else every run with a live role, else the newest. */
 export const statusCommand = defineCommand({
@@ -122,29 +152,37 @@ const list = defineCommand({
     if (args.repo && !top)
       throw new CatherdError("E_INPUT_INVALID", `${resolve(args.repo)} is not inside a git repository`, {
         fix: "pass a path inside the repo, or leave out --repo",
       });
     const { runs, corrupt } = listRuns();
-    const rows = runs
-      .filter((r) => !args.repo || r.meta.repo === top)
-      .map((r) => {
-        const s = summarizeRun(defaultDeps(), r);
-        return {
-          id: r.id,
-          title: r.meta.title,
-          repo: r.meta.repo,
-          createdAt: r.meta.createdAt,
-          live: s.live.length,
-          roleRuns: s.totals.runs,
-        };
-      });
-    if (args.json) return printJson({ runs: rows, corrupt });
-    if (rows.length === 0) console.log("no runs yet");
-    for (const r of rows)
-      console.log(
-        `${r.id}  ${r.live ? `${r.live} live` : "idle"}  ${r.roleRuns} role run(s)  ${r.title}  ${r.repo}`,
-      );
+    const shown = runs.filter((r) => !args.repo || r.meta.repo === top);
+    const deps = defaultDeps();
+    const row = (r: Run) => {
+      const s = summarizeRun(deps, r);
+      return {
+        id: r.id,
+        title: r.meta.title,
+        repo: r.meta.repo,
+        createdAt: r.meta.createdAt,
+        live: s.live.length,
+        roleRuns: s.totals.runs,
+        session: s.session,
+        continuedIn: s.continuedIn,
+      };
+    };
+    const groups = groupRuns(shown);
+    if (args.json) return printJson({ runs: shown.map(row), corrupt });
+    if (shown.length === 0) console.log("no runs yet");
+    for (const g of groups) {
+      console.log(sessionHeading(g.session));
+      for (const x of g.runs) {
+        const r = row(x.run);
+        console.log(
+          `  ${r.id}  ${r.live ? `${r.live} live` : "idle"}  ${r.roleRuns} role run(s)  ${r.title}  ${r.repo}${movedNote(x)}`,
+        );
+      }
+    }
     for (const c of corrupt) console.log(`${mark("warn")} skipped run ${c.id}: ${c.reason}`);
   },
 });
 
 const show = defineCommand({
```


#### Modify `src/entry/tui/fixtures.ts`

```diff
--- a/src/entry/tui/fixtures.ts
+++ b/src/entry/tui/fixtures.ts
@@ -68,10 +68,12 @@ export const FIXTURE_REPORT: DoctorReport = {
 };
 
 const summary = (o: Partial<RunSummary> & Pick<RunSummary, "id" | "title">): RunSummary => ({
   repo: "/home/me/app",
   createdAt: "2026-09-26T11:48:00.000Z",
+  session: null,
+  continuedIn: null,
   stateTail: [],
   live: [],
   totals: {
     runs: 0,
     ok: 0,
```


#### Create `src/services/session-view.ts`

```ts
import { statSync } from "node:fs";
import { liveSessionFile, readSessionFiles, type SessionFile } from "../infra/claude-session.ts";
import { type Run, runPaths } from "./run-store.ts";
import { readSessionRows } from "./sessions.ts";

/**
 * Spec §4: runs grouped by the Claude Code session that drove them. A run belongs to the session that started it
 * (`meta.startedBy`); a run listed in another session's rows of `sessions.jsonl` also appears under that session,
 * as "continued here", and under its starting session it says "continued in <name>". Runs from 1.0 (no
 * `startedBy`) go under "earlier runs".
 */

/** A session as the runs page shows it: its name read live while it runs, else the last one recorded. */
export interface RunSession {
  sessionId: string;
  hostSessionId: string | null;
  name: string;
  /** the session's process runs now */
  live: boolean;
}

export interface GroupedRun {
  run: Run;
  /** "here": this session continued a run another started; "elsewhere": another session continued it */
  continued: "here" | "elsewhere" | null;
  /** the session that continued it, for "elsewhere" */
  continuedIn: string | null;
}

export interface SessionGroup {
  /** null: "earlier runs", the 1.0 runs no session is recorded for */
  session: RunSession | null;
  runs: GroupedRun[];
  /** when anything last happened in one of its runs, ms since the epoch */
  lastActivity: number;
}

/** Newest of the run's creation and its state and record files' last writes. */
export function runActivity(run: Run): number {
  const p = runPaths(run.dir);
  let t = Date.parse(run.meta.createdAt) || 0;
  for (const f of [p.stateJson, p.runs, p.state, p.agents]) {
    try {
      t = Math.max(t, statSync(f).mtimeMs);
    } catch {
      // not written yet
    }
  }
  return t;
}

/** The sessions each run has had, oldest first: its starter, then each one that took it over. */
function trailOf(
  run: Run,
): { sessionId: string; hostSessionId: string | null; name: string | null; at: string }[] {
  const rows = readSessionRows(run);
  const s = run.meta.startedBy;
  if (s && !rows.some((r) => r.sessionId === s.sessionId)) return [{ ...s, at: run.meta.createdAt }, ...rows];
  return rows;
}

/** Every run grouped by session, the groups newest activity first, the runs in each newest first. */
export function groupRuns(runs: Run[], files: SessionFile[] = readSessionFiles()): SessionGroup[] {
  // the last name recorded for each session, in any run
  const recorded = new Map<string, { name: string | null; host: string | null; at: string }>();
  const trails = new Map(runs.map((r) => [r.id, trailOf(r)]));
  for (const t of trails.values())
    for (const row of t) {
      const was = recorded.get(row.sessionId);
      if (!was || row.at >= was.at)
        recorded.set(row.sessionId, {
          name: row.name ?? was?.name ?? null,
          host: row.hostSessionId ?? was?.host ?? null,
          at: row.at,
        });
    }
  const sessionOf = (id: string): RunSession => {
    const live = liveSessionFile(id, files);
    const rec = recorded.get(id);
    return {
      sessionId: id,
      hostSessionId: live?.hostSessionId ?? rec?.host ?? null,
      name: live?.name ?? rec?.name ?? `session ${id.slice(0, 8)}`,
      live: live !== null,
    };
  };
  const groups = new Map<string | null, SessionGroup>();
  const add = (id: string | null, g: GroupedRun, at: number) => {
    let group = groups.get(id);
    if (!group) {
      group = { session: id === null ? null : sessionOf(id), runs: [], lastActivity: 0 };
      groups.set(id, group);
    }
    group.runs.push(g);
    group.lastActivity = Math.max(group.lastActivity, at);
  };
  for (const run of runs) {
    const at = runActivity(run);
    const trail = trails.get(run.id) ?? [];
    const starter = run.meta.startedBy?.sessionId ?? null;
    const others = [...new Set(trail.map((t) => t.sessionId))].filter((id) => id !== starter);
    const last = others.at(-1);
    // a run continued elsewhere lives on there: here it counts from when it started, not from its latest write
    add(
      starter,
      { run, continued: last ? "elsewhere" : null, continuedIn: last ? sessionOf(last).name : null },
      last ? Date.parse(run.meta.createdAt) || 0 : at,
    );
    for (const id of others) add(id, { run, continued: "here", continuedIn: null }, at);
  }
  const out = [...groups.values()];
  for (const g of out)
    g.runs.sort(
      (a, b) =>
        runActivity(b.run) - runActivity(a.run) || b.run.meta.createdAt.localeCompare(a.run.meta.createdAt),
    );
  // "earlier runs" last, whatever its activity: 1.0 runs are history
  return out.sort((a, b) =>
    a.session === null ? 1 : b.session === null ? -1 : b.lastActivity - a.lastActivity,
  );
}

/**
 * The session a run started in, as the runs page names it now (null for a run from before 1.1), and the session
 * that continued it, if another did.
 */
export function sessionFacts(
  run: Run,
  files: SessionFile[] = readSessionFiles(),
): { session: RunSession | null; continuedIn: string | null } {
  const starter = run.meta.startedBy?.sessionId ?? null;
  const own = groupRuns([run], files).find((g) => (g.session?.sessionId ?? null) === starter);
  return { session: own?.session ?? null, continuedIn: own?.runs[0]?.continuedIn ?? null };
}
```


#### Modify `src/services/summary.ts`

```diff
--- a/src/services/summary.ts
+++ b/src/services/summary.ts
@@ -4,10 +4,11 @@ import { isCatherdError } from "../domain/errors.ts";
 import type { Tokens } from "../domain/record.ts";
 import { median } from "../domain/util.ts";
 import { nonBlankLines, readJsonl } from "../infra/store.ts";
 import { spendOf } from "./budget.ts";
 import { type DispatchState, liveDispatches } from "./dispatches.ts";
+import { type RunSession, sessionFacts } from "./session-view.ts";
 import type { Deps } from "./ports.ts";
 import {
   findRun,
   listRuns,
   readAgentRuns,
@@ -20,10 +21,14 @@ import {
 export interface RunSummary {
   id: string;
   title: string;
   repo: string;
   createdAt: string;
+  /** spec §4: the Claude Code session that started it (null before 1.1), named live while it runs */
+  session: RunSession | null;
+  /** the session that continued it, when another did */
+  continuedIn: string | null;
   stateTail: string[];
   live: { name: string; rung: string; state: DispatchState; secs: number; dispatchId: string }[];
   totals: { runs: number; ok: number; notOk: string[]; tokens: Tokens; costUsd: number; wallMinutes: number };
   /** native subagent runs, as the orchestrator reported them: reported, not measured (spec §14) */
   agents: { runs: number; totalTokens: number; costUsd: number };
@@ -53,10 +58,11 @@ export function summarizeRun(deps: Deps, run: Run): RunSummary {
   return {
     id: run.id,
     title: run.meta.title,
     repo: run.meta.repo,
     createdAt: run.meta.createdAt,
+    ...sessionFacts(run),
     stateTail: nonBlankLines(runPaths(run.dir).state).slice(-3),
     live: live.map((d) => ({
       name: d.admit.name,
       rung: d.admit.rung,
       state: d.state,
```


#### Modify `README.md`

```diff
--- a/README.md
+++ b/README.md
@@ -62,25 +62,25 @@ In Claude Code:
 - `/catherd-setup` tunes your profile in conversation: which models and efforts each role may
   use, cost or speed, isolation, budget and failover.
 
 In a terminal:
 
-| Command                                                                                   | What it does                                                                             |
-| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
-| `catherd`                                                                                 | The dashboard: Status, Profiles and Runs (below)                                         |
-| `catherd init [--no-input] [--profile <p>]`                                               | First-run setup                                                                          |
-| `catherd doctor [--json]`                                                                 | Readiness report, one row per check with its fix; exits 3 when not ready                 |
-| `catherd profile list\|show\|use [--repo]\|new [--from <p>]\|copy\|rm\|diff\|validate`    | Profiles; `use --repo` binds one to the repo you are in                                  |
-| `catherd profile use --repo --clear`                                                      | Unbinds the repo you are in; it runs on the active profile again                         |
-| `catherd profile set <path> <value> [--profile <p>]`                                      | One field, e.g. `roles.verifier.access read-only`, `budget.usd 20`                       |
-| `catherd status [run]`, `catherd watch [--once] [--interval <s>]`                         | Where runs stand                                                                         |
-| `catherd runs list [--repo <path>]\|show <id> [--debug [--name <n>]]\|cancel <id> <name>` | Past runs; `--debug` adds exit.json and the stderr and event tails, `--name` one role's  |
-| `catherd catalog refresh\|list [--backend <b>] [--role <r>] [--text <t>] [--scored]`      | The models catherd can place, filtered                                                   |
-| `catherd catalog treat-like <rung> <like>`                                                | Scores an unscored rung as a scored one                                                  |
-| `catherd lock [--slots N] -- <cmd>`                                                       | Runs a heavy command behind the machine-wide semaphore, in its own session (no /dev/tty) |
-| `catherd mcp`                                                                             | The MCP server on stdio; the plugin starts it, you never need to                         |
-| `catherd capture-fixtures [--backend <b>] [--out <dir>]`                                  | Contributors: records sanitized test fixtures from real runs (see CONTRIBUTING.md)       |
+| Command                                                                                   | What it does                                                                                        |
+| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
+| `catherd`                                                                                 | The dashboard: Status, Profiles and Runs (below)                                                    |
+| `catherd init [--no-input] [--profile <p>]`                                               | First-run setup                                                                                     |
+| `catherd doctor [--json]`                                                                 | Readiness report, one row per check with its fix; exits 3 when not ready                            |
+| `catherd profile list\|show\|use [--repo]\|new [--from <p>]\|copy\|rm\|diff\|validate`    | Profiles; `use --repo` binds one to the repo you are in                                             |
+| `catherd profile use --repo --clear`                                                      | Unbinds the repo you are in; it runs on the active profile again                                    |
+| `catherd profile set <path> <value> [--profile <p>]`                                      | One field, e.g. `roles.verifier.access read-only`, `budget.usd 20`                                  |
+| `catherd status [run]`, `catherd watch [--once] [--interval <s>]`                         | Where runs stand, grouped by the Claude Code session that drove them                                |
+| `catherd runs list [--repo <path>]\|show <id> [--debug [--name <n>]]\|cancel <id> <name>` | Past runs, by session; `--debug` adds exit.json and the stderr and event tails, `--name` one role's |
+| `catherd catalog refresh\|list [--backend <b>] [--role <r>] [--text <t>] [--scored]`      | The models catherd can place, filtered                                                              |
+| `catherd catalog treat-like <rung> <like>`                                                | Scores an unscored rung as a scored one                                                             |
+| `catherd lock [--slots N] -- <cmd>`                                                       | Runs a heavy command behind the machine-wide semaphore, in its own session (no /dev/tty)            |
+| `catherd mcp`                                                                             | The MCP server on stdio; the plugin starts it, you never need to                                    |
+| `catherd capture-fixtures [--backend <b>] [--out <dir>]`                                  | Contributors: records sanitized test fixtures from real runs (see CONTRIBUTING.md)                  |
 
 A profile command without a profile name (`show`, `set`, `diff`, `validate`), like the MCP profile tools, acts
 on the profile the repo you are in runs on: the one bound to it, else the active one. Run them as
 `bunx catherd-cli <command>` when catherd is not installed globally. Every read command takes `--json`; a bare `catherd runs` is `catherd runs list`. Exit codes: 0 ok, 1 error, 2 usage, 3 not ready, 130 interrupted; an error prints
 `error E_CODE: message` and a `fix:` line. `--verbose` (or `CATHERD_LOG=debug`) logs more to
```

- [ ] **Step 4: Run the gate**

Run the gate. Expected: clean. Scratch count after this task: 1231 pass, 10 skip, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(runs): runs grouped by the session that drove them in runs list and status"
```

---

### Task 10: The runs page's data

Spec §4 "Runs tab", its data only (Task 11 draws it), Ruling 19: the sessions with their counts; a session's runs, newest first, each with its milestones and every role (its latest dispatch; live ones first, with the last activity); a role's brief, reply and record. `lastActivity` moves from `peek.ts` to `finalize.ts` (next to the adapters it reads), since the runs page needs it too.

**Files:**
- Modify: `test/services/peek.test.ts`
- Create: `test/services/runs-page.test.ts`
- Modify: `src/services/finalize.ts`
- Modify: `src/services/peek.ts`
- Create: `src/services/runs-page.ts`

**Interfaces:**
- Consumes: `groupRuns`, `SessionGroup` (Task 9); `lastActivity` (Task 7, moved here); `spendOf`, `budgetStatus`.
- Produces: `SessionRow { key; name; live; runs; liveRoles; landed; lastActivity }`, `RoleRow { run; dispatchId; name; role; rung; status; live; since; secs; lastEvent; replyStatus }`, `Milestone { name; landed; what }`, `SessionRun { id; title; repo; createdAt; continued; continuedIn; budget; milestones; roles }`, `SessionDetail { session; runs; dirs }`, `RoleDetail { run; runTitle; dispatchId; name; role; rung; state; brief; reply; record }`, `sessionRows(deps)`, `sessionDetail(deps, key)`, `roleDetail(deps, run, dispatchId)` (`src/services/runs-page.ts`); `lastActivity`, `LAST_EVENT_CHARS` in `src/services/finalize.ts`.

- [ ] **Step 1: Write the failing tests**

#### Modify `test/services/peek.test.ts`

```diff
--- a/test/services/peek.test.ts
+++ b/test/services/peek.test.ts
@@ -4,11 +4,12 @@ import { join } from "node:path";
 import type { SessionEnv } from "../../src/infra/claude-session.ts";
 import { claudeHome } from "../../src/infra/paths.ts";
 import { awaitsCollect } from "../../src/infra/dispatch-dir.ts";
 import { watchersSettled } from "../../src/services/dispatch-service.ts";
 import { finalizeDispatch } from "../../src/services/finalize.ts";
-import { lastActivity, peek } from "../../src/services/peek.ts";
+import { lastActivity } from "../../src/services/finalize.ts";
+import { peek } from "../../src/services/peek.ts";
 import { appendAgentRun, createRun } from "../../src/services/run-store.ts";
 import { claimRun, runOwner } from "../../src/services/sessions.ts";
 import { snapshotEnv, withHome } from "../helpers.ts";
 import { fakeDeps, fakeDispatch, freshRun } from "./helpers.ts";
 
```


#### Create `test/services/runs-page.test.ts`

```ts
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeHome } from "../../src/infra/paths.ts";
import { appendLedger, appendRecord, createRun, runPaths } from "../../src/services/run-store.ts";
import { roleDetail, sessionDetail, sessionRows } from "../../src/services/runs-page.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { fakeDeps, fakeDispatch, makeRecord, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());

const FX = join(import.meta.dir, "..", "fixtures", "adapters", "codex");
const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };

/** Two runs of one live session (this process stands in for it), one of them continued by another session. */
async function twoRuns() {
  withHome();
  const repo = tempRepo();
  mkdirSync(join(claudeHome(), "sessions"), { recursive: true });
  writeFileSync(
    join(claudeHome(), "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: "s-auth", name: "auth build" }),
  );
  const startedBy = { sessionId: "s-auth", hostSessionId: null, name: "auth build" };
  const at = (m: number) => new Date(Date.now() - m * 60_000);
  const jobs = createRun({
    repo,
    title: "Jobs screen",
    aLines: ["A1"],
    version: "0",
    now: at(10),
    startedBy,
  });
  const moved = createRun({
    repo,
    title: "Auth refactor",
    aLines: ["A1"],
    version: "0",
    now: at(20),
    startedBy,
  });
  writeFileSync(
    runPaths(moved.dir).sessions,
    `{"kind":"sessions","schema":1}\n${JSON.stringify({ sessionId: "s-kit", hostSessionId: null, name: "kit follow-up", at: new Date().toISOString() })}\n`,
  );
  appendLedger(jobs, "M0 | scaffold the jobs screen | 3f2a9c1 | 9 | bun test");
  writeLane(jobs, "M1.L1", ["src/a.ts"]);
  writeLane(jobs, "M1.L2", ["src/b.ts"]);
  writeLane(jobs, "M2.L1", ["src/c.ts"]);
  const live = await fakeDispatch(
    jobs,
    { name: "worker-M1.L2", lane: "M1.L2" },
    { proc: "self", events: `${readLines("ok-with-reconnect.jsonl").slice(0, 5).join("\n")}\n` },
  );
  const done = await fakeDispatch(jobs, {}, { proc: "dead", exit, reply: "Done.\nSTATUS: complete — ok" });
  await appendRecord(jobs, makeRecord({ runId: jobs.id, dispatchId: done.admit.dispatchId, secs: 190 }));
  return { jobs, moved, live, done };
}

const readLines = (f: string) => readFileSync(join(FX, f), "utf8").split("\n").filter(Boolean);

describe("the runs page (spec §4)", () => {
  it("lists the sessions, newest activity first, with their runs, live roles and landings", async () => {
    await twoRuns();
    const { rows } = sessionRows(fakeDeps());
    expect(rows).toEqual([
      {
        key: "s-auth",
        name: "auth build",
        live: true,
        runs: 2,
        liveRoles: 1,
        landed: 1,
        lastActivity: expect.any(String),
      },
      {
        key: "s-kit",
        name: "kit follow-up",
        live: false,
        runs: 1,
        liveRoles: 0,
        landed: 0,
        lastActivity: expect.any(String),
      },
    ]);
  });

  it("opens a session: its runs newest first, their milestones, every role, live ones first", async () => {
    const { jobs, moved, live, done } = await twoRuns();
    const s = sessionDetail(fakeDeps(), "s-auth");
    expect(s.runs.map((r) => [r.title, r.continued, r.continuedIn])).toEqual([
      ["Jobs screen", null, null],
      ["Auth refactor", "elsewhere", "kit follow-up"],
    ]);
    expect(s.dirs.sort()).toEqual([jobs.dir, moved.dir].sort());
    const j = s.runs[0];
    expect(j?.milestones).toEqual([
      { name: "M0", landed: true, what: "scaffold the jobs screen" },
      { name: "M1", landed: false, what: "" },
      { name: "M2", landed: false, what: "" },
    ]);
    expect(j?.roles).toEqual([
      {
        run: jobs.id,
        dispatchId: live.admit.dispatchId,
        name: "worker-M1.L2",
        role: "worker",
        rung: "codex:gpt-6-sol#medium",
        status: "running",
        live: true,
        since: live.admit.admittedAt,
        secs: null,
        lastEvent: "$ /bin/zsh -lc 'cat CLAUDE.md'",
        replyStatus: null,
      },
      {
        run: jobs.id,
        dispatchId: done.admit.dispatchId,
        name: "worker-M1.L1",
        role: "worker",
        rung: "codex:gpt-6-sol#medium",
        status: "ok",
        live: false,
        since: done.admit.admittedAt,
        secs: 190,
        lastEvent: null,
        replyStatus: "complete",
      },
    ]);
  });

  it("opens a role: its brief, reply and record", async () => {
    const { jobs, done } = await twoRuns();
    const r = roleDetail(fakeDeps(), jobs.id, done.admit.dispatchId);
    expect(r).toMatchObject({
      run: jobs.id,
      runTitle: "Jobs screen",
      name: "worker-M1.L1",
      state: "finished",
      brief: "brief",
      reply: "Done.\nSTATUS: complete — ok",
      record: { dispatchId: done.admit.dispatchId, status: "ok" },
    });
    expect(() => roleDetail(fakeDeps(), jobs.id, "nope")).toThrow(/no dispatch nope/);
  });

  it("puts 1.0 runs under earlier runs, last", async () => {
    await twoRuns();
    const repo = tempRepo();
    createRun({ repo, title: "old", aLines: ["A1"], version: "0" });
    const { rows } = sessionRows(fakeDeps());
    expect(rows.at(-1)).toMatchObject({ key: null, name: "earlier runs", runs: 1 });
    expect(sessionDetail(fakeDeps(), null).runs.map((r) => r.title)).toEqual(["old"]);
  });
});
```


- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/services/runs-page.test.ts`. Expected: FAIL — `Cannot find module` for `src/services/runs-page.ts`.

- [ ] **Step 3: Move `lastActivity`, and build the page's data**

#### Modify `src/services/finalize.ts`

```diff
--- a/src/services/finalize.ts
+++ b/src/services/finalize.ts
@@ -23,10 +23,11 @@ import {
   makePrivate,
   nonBlankLines,
   writeTextAtomic,
 } from "../infra/store.ts";
 import { type Dispatch, dispatchState, listDispatches, readProc } from "./dispatches.ts";
+import { tail } from "./run-debug.ts";
 import { appendRecord, readRecords, recordsOnThread, type Run, runPaths } from "./run-store.ts";
 
 const text = (file: string): string => {
   try {
     return readFileSync(file, "utf8");
@@ -320,20 +321,37 @@ async function finalizeOnce(run: Run, d: Dispatch): Promise<RunRecord> {
   }
   if (saved === mine) recordHarness(run, d, mine);
   return saved;
 }
 
-/** The last event of a running dispatch worth showing (peek, the runs page), if any. */
-export function lastEvent(d: Dispatch): string | null {
+/** How much of a role's last event `peek` and the runs page show (spec §3.7). */
+export const LAST_EVENT_CHARS = 160;
+
+const oneLine = (s: string): string => {
+  const line = s.split("\n").find((l) => l.trim()) ?? "";
+  return line.length > LAST_EVENT_CHARS ? `${line.slice(0, LAST_EVENT_CHARS - 1)}…` : line;
+};
+
+/**
+ * Spec §3.7: what a live role is doing, from the end of its events.jsonl: the last line its adapter reads as an
+ * activity (a command, a file edit, a message line), else the last event's name; null before any event.
+ */
+export function lastActivity(d: Dispatch): string | null {
   const a = adapterFor(d.admit.backend);
-  const line = nonBlankLines(dispatchPaths(d.dir).events).at(-1);
-  if (!a || !line) return null;
-  try {
-    return a.parse(line).lastEvent ?? null;
-  } catch {
-    return null;
+  if (!a) return null;
+  let name: string | null = null;
+  for (const line of tail(dispatchPaths(d.dir).events, 200).toReversed()) {
+    let delta;
+    try {
+      delta = a.parse(line);
+    } catch {
+      continue;
+    }
+    if (delta.activity) return oneLine(delta.activity);
+    name ??= delta.lastEvent ?? null;
   }
+  return name;
 }
 
 /** Waits until the dispatch finishes, polling every `pollMs`; `onPoll` runs at each poll, and never ends the wait. */
 export async function waitForFinish(
   d: Dispatch,
```


#### Modify `src/services/peek.ts`

```diff
--- a/src/services/peek.ts
+++ b/src/services/peek.ts
@@ -1,22 +1,17 @@
-import { adapterFor } from "../adapters/registry.ts";
-import "../adapters/all.ts";
 import { assertId } from "../domain/ids.ts";
 import { noticeHeader } from "../domain/notice.ts";
-import { awaitsCollect, dispatchPaths } from "../infra/dispatch-dir.ts";
+import { awaitsCollect } from "../infra/dispatch-dir.ts";
 import { adopt } from "./dispatch-service.ts";
 import { type Dispatch, type DispatchState, listDispatches, liveDispatches } from "./dispatches.ts";
+import { lastActivity } from "./finalize.ts";
 import { finishedNotice } from "./notifier.ts";
 import type { Deps } from "./ports.ts";
-import { tail } from "./run-debug.ts";
 import { findRun, listRuns, readAgentRuns, readRecords, type Run } from "./run-store.ts";
 import { claimRun, currentSession, runOwner } from "./sessions.ts";
 import { readNotes } from "./state.ts";
 
-/** How much of a role's last event `peek` shows (spec §3.7). */
-export const LAST_EVENT_CHARS = 160;
-
 export interface PeekRole {
   name: string;
   role: string;
   rung: string;
   state: DispatchState;
@@ -38,37 +33,10 @@ export interface PeekRun {
   native: { name: string; role: string; rung: string; status: string; at: string } | null;
   /** the run's next step (state.md's last line) */
   next: string;
 }
 
-const oneLine = (s: string): string => {
-  const line = s.split("\n").find((l) => l.trim()) ?? "";
-  return line.length > LAST_EVENT_CHARS ? `${line.slice(0, LAST_EVENT_CHARS - 1)}…` : line;
-};
-
-/**
- * Spec §3.7: what a live role is doing, from the end of its events.jsonl: the last line an adapter reads as an
- * activity (a command, a file edit, a message line), else the last event's name.
- */
-export function lastActivity(d: Dispatch): string | null {
-  const a = adapterFor(d.admit.backend);
-  if (!a) return null;
-  const lines = tail(dispatchPaths(d.dir).events, 200);
-  let name: string | null = null;
-  for (const line of lines.toReversed()) {
-    let delta;
-    try {
-      delta = a.parse(line);
-    } catch {
-      continue;
-    }
-    if (delta.activity) return oneLine(delta.activity);
-    name ??= delta.lastEvent ?? null;
-  }
-  return name;
-}
-
 function peekRun(deps: Deps, run: Run, name: string | undefined): PeekRun {
   const now = deps.now();
   const mine = (d: Dispatch) => name === undefined || d.admit.name === name;
   const records = new Map(readRecords(run).records.map((r) => [r.dispatchId, r]));
   const agents = readAgentRuns(run).filter((a) => name === undefined || a.name === name);
```


#### Create `src/services/runs-page.ts`

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { budgetStatus } from "../domain/budget.ts";
import type { RunRecord } from "../domain/record.ts";
import { dispatchPaths } from "../infra/dispatch-dir.ts";
import { nonBlankLines } from "../infra/store.ts";
import { spendOf } from "./budget.ts";
import { dispatchState, listDispatches, liveDispatches } from "./dispatches.ts";
import { lastActivity } from "./finalize.ts";
import type { Deps } from "./ports.ts";
import { findRun, listRuns, readRecords, type Run, runPaths } from "./run-store.ts";
import { groupRuns, type SessionGroup } from "./session-view.ts";

/**
 * Spec §4: what the Runs tab shows. The top level is the sessions; a session's screen holds its runs, each with its
 * milestones and every role (live ones first); a role's screen holds its brief, reply and record.
 */

export interface SessionRow {
  /** the session id; null for "earlier runs" */
  key: string | null;
  name: string;
  live: boolean;
  runs: number;
  liveRoles: number;
  landed: number;
  /** ISO time of its newest activity */
  lastActivity: string;
}

export interface RoleRow {
  run: string;
  dispatchId: string;
  name: string;
  role: string;
  rung: string;
  /** running | starting while live; once finished, the record's status (`finished` until it has one) */
  status: string;
  live: boolean;
  /** a live role's admission time: the page ticks its elapsed time from it */
  since: string;
  /** a finished role's seconds, from its record */
  secs: number | null;
  /** a live role's last command, file edit or message line */
  lastEvent: string | null;
  replyStatus: string | null;
}

export interface Milestone {
  name: string;
  landed: boolean;
  /** the ledger's "what" once landed */
  what: string;
}

export interface SessionRun {
  id: string;
  title: string;
  repo: string;
  createdAt: string;
  continued: "here" | "elsewhere" | null;
  continuedIn: string | null;
  /** the budget's spent fraction, null without a cap */
  budget: number | null;
  milestones: Milestone[];
  roles: RoleRow[];
}

export interface SessionDetail {
  session: SessionRow;
  runs: SessionRun[];
  /** the run folders to watch for changes */
  dirs: string[];
}

export interface RoleDetail {
  run: string;
  runTitle: string;
  dispatchId: string;
  name: string;
  role: string;
  rung: string;
  /** running | starting | finished */
  state: string;
  brief: string;
  reply: string;
  record: RunRecord | null;
}

const keyOf = (g: SessionGroup): string | null => g.session?.sessionId ?? null;

/** The runs a session holds that live on in it: not the ones another session continued. */
const ownRuns = (g: SessionGroup): Run[] =>
  g.runs.filter((x) => x.continued !== "elsewhere").map((x) => x.run);

function rowOf(deps: Deps, g: SessionGroup): SessionRow {
  const own = ownRuns(g);
  return {
    key: keyOf(g),
    name: g.session?.name ?? "earlier runs",
    live: g.session?.live ?? false,
    runs: g.runs.length,
    liveRoles: own.reduce((n, r) => n + liveDispatches(r, deps.now()).length, 0),
    landed: own.reduce((n, r) => n + Math.max(0, nonBlankLines(runPaths(r.dir).ledger).length - 1), 0),
    lastActivity: new Date(g.lastActivity).toISOString(),
  };
}

/** The Runs tab's top level: every session, newest activity first, "earlier runs" last. */
export function sessionRows(deps: Deps): { rows: SessionRow[]; warnings: string[] } {
  const { runs, corrupt } = listRuns();
  return {
    rows: groupRuns(runs).map((g) => rowOf(deps, g)),
    warnings: corrupt.map((c) => `skipped run ${c.id}: ${c.reason}`),
  };
}

/** The ledger's landed milestones, then each milestone a lane file names that has not landed. */
function milestonesOf(run: Run): Milestone[] {
  const landed = nonBlankLines(runPaths(run.dir).ledger)
    .slice(1)
    .map((l) => l.split(" | "))
    .map(([name, what]) => ({ name: (name ?? "").trim(), landed: true, what: (what ?? "").trim() }));
  const lanes = existsSync(runPaths(run.dir).lanes) ? readdirSync(runPaths(run.dir).lanes) : [];
  const open = [...new Set(lanes.map((f) => /^(M\d+)\./.exec(f)?.[1]).filter((m): m is string => !!m))]
    .filter((m) => !landed.some((l) => l.name === m))
    .map((name) => ({ name, landed: false, what: "" }));
  const n = (m: string) => Number(/\d+/.exec(m)?.[0] ?? 0);
  return [...landed, ...open.sort((a, b) => n(a.name) - n(b.name))];
}

/** Each role's latest dispatch, live ones first, then the newest finished first. */
function rolesOf(deps: Deps, run: Run): RoleRow[] {
  const now = deps.now();
  const records = new Map(readRecords(run).records.map((r) => [r.dispatchId, r]));
  const latest = new Map<string, ReturnType<typeof listDispatches>[number]>();
  for (const d of listDispatches(run)) latest.set(d.admit.name, d);
  const rows = [...latest.values()].map((d): RoleRow => {
    const r = records.get(d.admit.dispatchId);
    const state = r ? "finished" : dispatchState(d, now);
    const live = state !== "finished";
    return {
      run: run.id,
      dispatchId: d.admit.dispatchId,
      name: d.admit.name,
      role: d.admit.role,
      rung: d.admit.rung,
      status: r?.status ?? state,
      live,
      since: d.admit.admittedAt,
      secs: r?.secs ?? null,
      lastEvent: live ? lastActivity(d) : null,
      replyStatus: r?.replyStatus ?? null,
    };
  });
  return rows.sort((a, b) =>
    a.live !== b.live ? (a.live ? -1 : 1) : b.dispatchId.localeCompare(a.dispatchId),
  );
}

function sessionRun(deps: Deps, x: SessionGroup["runs"][number]): SessionRun {
  const run = x.run;
  let budget: number | null = null;
  try {
    const b = budgetStatus(
      spendOf(run, readRecords(run).records, liveDispatches(run, deps.now()), deps.now()),
      deps.profiles.forRepo(run.meta.repo).budget,
    );
    budget = b?.fraction ?? null;
  } catch {
    // an unreadable profile: no bar, the rest of the page stands
  }
  return {
    id: run.id,
    title: run.meta.title,
    repo: run.meta.repo,
    createdAt: run.meta.createdAt,
    continued: x.continued,
    continuedIn: x.continuedIn,
    budget,
    milestones: milestonesOf(run),
    roles: rolesOf(deps, run),
  };
}

/** A session's screen: its runs, newest first, each with its milestones and roles. */
export function sessionDetail(deps: Deps, key: string | null): SessionDetail {
  const g = groupRuns(listRuns().runs).find((x) => keyOf(x) === key);
  if (!g) throw new Error(key === null ? "no earlier runs" : `no session "${key}" in the runs`);
  return {
    session: rowOf(deps, g),
    runs: g.runs.map((x) => sessionRun(deps, x)),
    dirs: g.runs.map((x) => x.run.dir),
  };
}

const text = (file: string): string => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/** A role's screen: its brief, its reply and its record. */
export function roleDetail(deps: Deps, runId: string, dispatchId: string): RoleDetail {
  const run = findRun(runId);
  const d = listDispatches(run).find((x) => x.admit.dispatchId === dispatchId);
  if (!d) throw new Error(`no dispatch ${dispatchId} in run ${runId}`);
  const record = readRecords(run).records.find((r) => r.dispatchId === dispatchId) ?? null;
  const p = dispatchPaths(d.dir);
  return {
    run: run.id,
    runTitle: run.meta.title,
    dispatchId,
    name: d.admit.name,
    role: d.admit.role,
    rung: d.admit.rung,
    state: record ? "finished" : dispatchState(d, deps.now()),
    brief: text(p.brief),
    reply: text(p.reply),
    record,
  };
}
```

- [ ] **Step 4: Run the gate**

Run the gate. Expected: clean. Scratch count after this task: 1235 pass, 10 skip, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(runs): the runs page's data: sessions, a session's runs and roles, a role"
```

---

### Task 11: The Runs tab by session, live

Spec §4 "Runs tab", "Live" and the frames, with Rulings 19–21: top level the sessions (`● live|· idle <name> <n> runs · <n> live roles · <n> landed <ago>`), enter opens a session (its runs, milestones and roles, live ones first, elapsed times ticking), enter on a role opens it (brief, reply, record), esc goes back one level, `p` pauses (watch included), `ctrl+d` twice still cancels a live role. The open session redraws on `fs.watch` of its run folders (a 5 s safety read), and reads every second where it cannot watch. The Status tab's recent run opens its session. `docs/tui-frames.md` and the snapshots cover no runs, the sessions, one session with two runs (one continued elsewhere), a live session with three live roles, and a role. The README's dashboard line and `docs/dev/ideas.md` (the picked-up ideas leave) follow.

**Files:**
- Modify: `test/entry/tui/app.test.tsx`
- Modify: `test/entry/tui/effects.test.ts`
- Modify: `test/entry/tui/frames.test.tsx`
- Replace: `test/entry/tui/runs.test.tsx`
- Modify: `test/entry/tui/state.test.ts`
- Modify: `test/entry/tui/status.test.tsx`
- Modify: `src/entry/tui/commands.ts`
- Modify: `src/entry/tui/effects.ts`
- Replace: `src/entry/tui/fixtures.ts`
- Modify: `src/entry/tui/providers/data.tsx`
- Modify: `src/entry/tui/state.ts`
- Modify: `src/entry/tui/stories.ts`
- Replace: `src/entry/tui/views/runs.tsx`
- Modify: `src/entry/tui/views/status.tsx`
- Modify: `README.md`
- Modify: `docs/dev/ideas.md`

**Interfaces:**
- Consumes: `sessionRows`, `sessionDetail`, `roleDetail` and their types (Task 10); `RunSummary.session` (Task 9); `cancel` (unchanged).
- Produces: `Effects.sessions()`, `Effects.session(key)`, `Effects.role(run, dispatchId)`, `Effects.watch(dirs, onChange)`, `watchDirs(dirs, onChange)`, `RunRow.session` (`src/entry/tui/effects.ts`; `Effects.run` and `RunDetail` are gone); `FixtureOptions`, `FIXTURE_SESSIONS`, fixture `touch()`/`watched` (`src/entry/tui/fixtures.ts`); `AppState.session`, `AppState.role`, actions `session`, `role`, `up` (`run` is gone); `Data.sessions`; `RUN_EVERY_MS`, `WATCHED_EVERY_MS`, `sessionParts` (`src/entry/tui/views/runs.tsx`); `Story.fixtures`.

- [ ] **Step 1: Write the failing tests**

#### Modify `test/entry/tui/app.test.tsx`

```diff
--- a/test/entry/tui/app.test.tsx
+++ b/test/entry/tui/app.test.tsx
@@ -31,21 +31,21 @@ describe("tabs and leaving (spec §9.2)", () => {
   it("switches tabs with 1-3, the leader and [ ]", async () => {
     await app();
     await h!.s.press("2");
     expect(tabLine()).toContain("PROFILE default");
     await h!.s.press("ctrl+x", "3");
-    expect(tabLine()).toContain("RUNS");
+    expect(tabLine()).toContain("SESSIONS");
     await h!.s.press("[", "[");
     expect(tabLine()).toContain("SETUP");
   });
 
   it("backs out with esc and never quits with it", async () => {
     await app();
     await h!.s.press("3", "return");
-    expect(tabLine()).toContain("Jobs screen");
+    expect(tabLine()).toContain("jobs screen  ● live");
     await h!.s.press("escape");
-    expect(tabLine()).toContain("RUNS");
+    expect(tabLine()).toContain("SESSIONS");
     await h!.s.press("escape", "escape");
     expect(h!.exits).toEqual([]);
   });
 
   it("takes back an armed double press with esc, and backs out only on the next esc", async () => {
@@ -189,11 +189,11 @@ describe("the command palette (spec §9.2)", () => {
     await app();
     await h!.s.press("ctrl+p");
     expect(h!.s.frame()).toContain("catherd profile new <name>");
     await h!.s.type("go to runs");
     await h!.s.press("return");
-    expect(tabLine()).toContain("RUNS");
+    expect(tabLine()).toContain("SESSIONS");
   });
 });
 
 describe("the palette and help at 80x24 (P1)", () => {
   /** the option rows (indented under their group), and where each one's second column starts */
@@ -358,11 +358,11 @@ describe("an error from a key's read", () => {
     expect(h!.s.frame()).toContain("projects.json is not valid JSON");
     expect(h!.s.frame()).toContain("catherd doctor");
     expect(h!.app().getState().dialogs).toEqual([]);
     expect(h!.exits).toEqual([]);
     await h!.s.press("3");
-    expect(tabLine()).toContain("RUNS");
+    expect(tabLine()).toContain("SESSIONS");
   });
 });
 
 describe("toasts are opaque (Review Focus 4)", () => {
   const FIX = "catherd profile use --repo --clear /home/someone/work/a-rather-long-client-name/services/api";
```


#### Modify `test/entry/tui/effects.test.ts`

```diff
--- a/test/entry/tui/effects.test.ts
+++ b/test/entry/tui/effects.test.ts
@@ -1,19 +1,22 @@
 import { afterEach, describe, expect, it } from "bun:test";
 import { applyPatch, defaultProfileDoc, patchBetween, resolveProfile } from "../../../src/domain/profile.ts";
+import { mkdirSync, writeFileSync } from "node:fs";
+import { join } from "node:path";
 import {
   CHANGED_ON_DISK,
   liveEffects,
   memoRuns,
   type RunRow,
   stampOf,
+  watchDirs,
 } from "../../../src/entry/tui/effects.ts";
 import { activate, createProfile, patchProfile } from "../../../src/services/profile-service.ts";
 import { activeName } from "../../../src/services/profile-store.ts";
-import { appendRoute, type Run } from "../../../src/services/run-store.ts";
+import type { Run } from "../../../src/services/run-store.ts";
 import { snapshotEnv, tempRepo, withHome } from "../../helpers.ts";
-import { freshRun } from "../../services/helpers.ts";
+import { fakeDispatch, freshRun, waitFor } from "../../services/helpers.ts";
 
 afterEach(snapshotEnv());
 
 const row = (id: string, live = 0): RunRow => ({
   id,
@@ -22,10 +25,11 @@ const row = (id: string, live = 0): RunRow => ({
   createdAt: "2026-09-26T00:00:00.000Z",
   live,
   roleRuns: 0,
   landed: 0,
   budget: null,
+  session: null,
 });
 
 describe("the run list's memo (spec §9.4: memoised by mtime)", () => {
   it("computes a run again only when its files changed or a role is live", () => {
     const stamps = new Map([
@@ -57,62 +61,55 @@ describe("the run list's memo (spec §9.4: memoised by mtime)", () => {
     expect(computed).toEqual(["a", "b", "a", "b", "b"]);
   });
 });
 
 describe("the live effects", () => {
-  it("lists a run and reads its climbs and route decisions", () => {
+  it("lists a run, and its session, and opens the session and a role (spec §4)", async () => {
     const { run } = freshRun("Jobs screen");
-    const at = new Date().toISOString();
-    const base = {
-      at,
-      lane: "M1.L1",
-      role: "worker" as const,
-      ladder: ["codex:gpt-6-luna#high", "codex:gpt-6-sol#medium"],
-      kind: "repo_code" as const,
-      difficulty: "build" as const,
-    };
-    appendRoute(run, {
-      ...base,
-      rung: "codex:gpt-6-luna#high",
-      source: "route",
-      decidedBy: "lane",
-      from: null,
-      reason: null,
-    });
-    appendRoute(run, {
-      ...base,
-      rung: "codex:gpt-6-sol#medium",
-      source: "climb",
-      decidedBy: "lane",
-      from: "codex:gpt-6-luna#high",
-      reason: "refused",
-    });
+    const d = await fakeDispatch(run, {}, { proc: "self" });
     const fx = liveEffects();
-    const { rows } = fx.runs();
-    expect(rows).toEqual([
-      expect.objectContaining({ id: run.id, title: "Jobs screen", live: 0, landed: 0, budget: null }),
-    ]);
-    const d = fx.run(run.id);
-    expect(d.climbs).toEqual([
-      {
-        lane: "M1.L1",
-        from: "codex:gpt-6-luna#high",
-        to: "codex:gpt-6-sol#medium",
-        reason: "refused",
-        env: false,
-      },
+    expect(fx.runs().rows).toEqual([
+      expect.objectContaining({
+        id: run.id,
+        title: "Jobs screen",
+        live: 1,
+        landed: 0,
+        budget: null,
+        session: null,
+      }),
     ]);
-    expect(d.decisions).toEqual([
-      {
-        lane: "M1.L1",
-        role: "worker",
-        source: "lane",
-        kind: "repo_code",
-        difficulty: "build",
-        rung: "codex:gpt-6-luna#high",
-      },
+    expect(fx.sessions().rows).toEqual([
+      expect.objectContaining({ key: null, name: "earlier runs", liveRoles: 1 }),
     ]);
+    const s = fx.session(null);
+    expect(s.dirs).toEqual([run.dir]);
+    expect(s.runs[0]?.roles.map((r) => [r.name, r.live])).toEqual([["worker-M1.L1", true]]);
+    expect(fx.role(run.id, d.admit.dispatchId)).toMatchObject({
+      name: "worker-M1.L1",
+      brief: "brief",
+      record: null,
+    });
+  });
+
+  it("watches run folders for any change below them, and gathers a burst into one call", async () => {
+    const { run } = freshRun();
+    let calls = 0;
+    const stop = watchDirs([run.dir], () => calls++);
+    expect(stop).not.toBeNull();
+    try {
+      writeFileSync(join(run.dir, "state.md"), "x");
+      mkdirSync(join(run.dir, "roles", "w", "1"), { recursive: true });
+      writeFileSync(join(run.dir, "roles", "w", "1", "events.jsonl"), "{}\n");
+      await waitFor(() => calls > 0, 5_000);
+      expect(calls).toBe(1);
+    } finally {
+      stop?.();
+    }
+  });
+
+  it("cannot watch a folder that is not there: the screen polls instead", () => {
+    expect(watchDirs(["/nonexistent/catherd-run"], () => {})).toBeNull();
   });
 
   it("saves the staged treat-likes and the patch through the services", async () => {
     withHome();
     const fx = liveEffects();
```


#### Modify `test/entry/tui/frames.test.tsx`

```diff
--- a/test/entry/tui/frames.test.tsx
+++ b/test/entry/tui/frames.test.tsx
@@ -22,11 +22,16 @@ async function frame(
   width: number,
   height: number,
   plain: boolean,
 ): Promise<string> {
   withHome();
-  const h = await harness(<App />, { effects: fixtureEffects(), ui: plain ? PLAIN : UI, width, height });
+  const h = await harness(<App />, {
+    effects: fixtureEffects(story.fixtures),
+    ui: plain ? PLAIN : UI,
+    width,
+    height,
+  });
   for (const step of story.steps) await h.run(() => applyStep(step, h.app(), h.keymap()));
   await h.advance(0);
   await h.advance(0);
   const f = h.s.frame().replace(/ +$/gm, "");
   await h.s.close();
```


#### Replace the whole of `test/entry/tui/runs.test.tsx` with

```tsx
import { afterEach, describe, expect, it } from "bun:test";
import { RUNS_EVERY_MS } from "../../../src/entry/tui/providers/data.tsx";
import { FIXTURE_SESSIONS, fixtureEffects } from "../../../src/entry/tui/fixtures.ts";
import { RUN_EVERY_MS, RunsView, WATCHED_EVERY_MS } from "../../../src/entry/tui/views/runs.tsx";
import { snapshotEnv, withHome } from "../../helpers.ts";
import { type Harness, harness } from "./harness.tsx";
import { Shell } from "./shell.tsx";

afterEach(snapshotEnv());
let h: Harness | null = null;
afterEach(async () => {
  await h?.s.close();
  h = null;
});

async function runs(effects = fixtureEffects()) {
  withHome();
  h = await harness(
    <Shell width={100} height={19}>
      <RunsView width={100} height={19} />
    </Shell>,
    { effects, width: 100, height: 19 },
  );
  await h.advance(0);
  return effects;
}

describe("the Runs tab (spec §4)", () => {
  it("lists the sessions, newest activity first, with a state word, and when it last read them", async () => {
    await runs();
    const f = h!.s.frame();
    expect(f).toContain("SESSIONS  updated just now");
    expect(f).toContain("● live  jobs screen  1 run · 3 live roles · 1 landed  20s ago");
    expect(f).toContain("· idle  kit follow-up  1 run · 0 live roles · 3 landed  1d ago");
    expect(f.indexOf("jobs screen")).toBeLessThan(f.indexOf("kit follow-up"));
    expect(f.indexOf("kit follow-up")).toBeLessThan(f.indexOf("auth build"));
  });

  it("says a read failed, keeping when the sessions were last read", async () => {
    const fx = await runs();
    fx.sessions = () => {
      throw new Error("runs directory is not readable");
    };
    await h!.advance(5 * RUNS_EVERY_MS);
    const f = h!.s.frame();
    expect(f).toContain("could not read the runs: runs directory is not readable");
    expect(f).toContain("updated 10s ago");
    expect(f).toContain("jobs screen");
  });

  it("shows the mascot and how to start a run when there are none", async () => {
    await runs(fixtureEffects({ runs: [], sessions: [] }));
    expect(h!.s.frame()).toContain("(=-.-=)/");
    expect(h!.s.frame()).toContain("No runs yet. Start one in Claude Code: /catherd <what to build>");
  });

  it("opens a session: its runs, their milestones, and every role, live ones first, ticking; esc goes back", async () => {
    await runs();
    await h!.s.press("return");
    let f = h!.s.frame();
    expect(f).toContain("jobs screen  ● live · 1 run · 3 live roles");
    expect(f).toContain("▸ Jobs screen  /home/me/app · started 12m ago · budget 52%");
    expect(f).toContain("✓ M0 scaffold the jobs screen  ◌ M1");
    expect(f).toContain("● worker-M1.L2    gpt-6-sol#medium   running  04:12  $ bun test test/jobs --bail");
    expect(f).toContain("◌ reviewer-M1     gpt-6-sol#high     starting 00:04");
    expect(f).toContain("✓ worker-M1.L1    gpt-6-luna#high    ok       05:12");
    expect(f.indexOf("reviewer-M1")).toBeLessThan(f.indexOf("worker-M1.L1 "));
    // a live role's elapsed time ticks every second, with nothing read again
    await h!.advance(1_000);
    f = h!.s.frame();
    expect(f).toContain("running  04:13");
    await h!.s.press("escape");
    expect(h!.s.frame()).toContain("SESSIONS");
  });

  it("marks a run continued in another session, and under that session as continued here", async () => {
    await runs();
    await h!.s.press("j", "j", "return");
    expect(h!.s.frame()).toContain(
      "▸ Auth refactor  /home/me/api · started 1d ago · continued in kit follow-up",
    );
    await h!.s.press("escape", "j", "return");
    expect(h!.s.frame()).toContain("▸ Auth refactor  /home/me/api · started 1d ago · continued here");
  });

  it("opens a role: its brief, reply and record; esc goes back to its session, then to the list", async () => {
    await runs();
    await h!.s.press("return", "j", "j", "j", "return");
    const f = h!.s.frame();
    expect(f).toContain("worker-M1.L1 worker · gpt-6-luna#high · ok · Jobs screen");
    expect(f).toContain("BRIEF");
    expect(f).toContain("Fast check: bun test test/jobs/list");
    expect(f).toContain("STATUS: complete — list in place, fast check green");
    expect(f).toContain("RECORD");
    expect(f).toContain("changed src/jobs/list.tsx, src/jobs/list.test.tsx");
    await h!.s.press("escape");
    expect(h!.s.frame()).toContain("jobs screen  ● live");
    await h!.s.press("escape");
    expect(h!.s.frame()).toContain("SESSIONS");
  });

  it("redraws the open session when a run file changes, and polls every second where it cannot watch", async () => {
    const fx = fixtureEffects();
    let reads = 0;
    const read = fx.session;
    fx.session = (key) => {
      reads++;
      return read(key);
    };
    await runs(fx);
    await h!.s.press("return");
    expect(fx.watched).toEqual([["/runs/20260926-114800-jobs-screen"]]);
    const before = reads;
    await h!.run(() => fx.touch());
    await h!.advance(0);
    expect(reads).toBe(before + 1);
    // watched: only the slow safety read, not one a second
    await h!.advance(RUN_EVERY_MS * 3);
    expect(reads).toBe(before + 1);
    await h!.advance(WATCHED_EVERY_MS);
    expect(reads).toBe(before + 2);
    await h!.s.press("escape");
    expect(fx.watched).toEqual([]);

    const blind = fixtureEffects({ watchable: false });
    let polls = 0;
    const r2 = blind.session;
    blind.session = (key) => {
      polls++;
      return r2(key);
    };
    await h!.s.close();
    await runs(blind);
    await h!.s.press("return");
    const p0 = polls;
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      await h!.advance(RUN_EVERY_MS);
      seen.push(polls - p0);
    }
    expect(seen).toEqual([1, 2, 3]);
  });

  it("pauses the updates with p, watch included, and says so", async () => {
    const fx = fixtureEffects();
    let reads = 0;
    const read = fx.session;
    fx.session = (key) => {
      reads++;
      return read(key);
    };
    await runs(fx);
    await h!.s.press("return", "p");
    expect(h!.s.frame()).toContain("paused");
    expect(fx.watched).toEqual([]);
    const paused = reads;
    await h!.run(() => fx.touch());
    await h!.advance(WATCHED_EVERY_MS * 3);
    expect(reads).toBe(paused);
  });

  it("cancels a live role only on a second ctrl+d within 5 s", async () => {
    const fx = await runs();
    await h!.s.press("return", "ctrl+d");
    expect(h!.s.frame()).toContain("press ctrl+d again to cancel");
    await h!.advance(5_001);
    await h!.s.press("ctrl+d");
    expect(fx.writes).toEqual([]);
    await h!.s.press("ctrl+d");
    expect(fx.writes).toEqual(["cancel 20260926-114800-jobs-screen worker-M1.L2"]);
  });

  it("takes back a first ctrl+d when the cursor moves, and never cancels a finished role", async () => {
    const fx = await runs();
    await h!.s.press("return", "ctrl+d");
    expect(h!.s.frame()).toContain("press ctrl+d again to cancel");
    await h!.s.press("j");
    expect(h!.s.frame()).not.toContain("press ctrl+d again to cancel");
    await h!.s.press("j", "j", "ctrl+d", "ctrl+d");
    expect(fx.writes).toEqual([]);
  });

  it("keeps a fixture of every shape the frames need", () => {
    expect(FIXTURE_SESSIONS.map((s) => s.row.key)).toEqual(["s-jobs", "s-kit", "s-auth"]);
  });
});
```


#### Modify `test/entry/tui/state.test.ts`

```diff
--- a/test/entry/tui/state.test.ts
+++ b/test/entry/tui/state.test.ts
@@ -208,11 +208,24 @@ describe("dialogs and armed keys", () => {
     ]);
     expect(run(s, { type: "tab", tab: "runs" }).armed).toBeNull();
     expect(run(s, { type: "open", dialog: confirm }).armed).toBeNull();
   });
 
-  it("opens and leaves a run, and pauses", () => {
-    const s = run(initialState("runs"), { type: "run", id: "r1" }, { type: "pause" });
-    expect([s.run, s.paused]).toEqual(["r1", true]);
-    expect(run(s, { type: "run", id: null }, { type: "pause" })).toMatchObject({ run: null, paused: false });
+  it("opens a session, then a role, goes back one level at a time, and pauses (spec §4)", () => {
+    const s = run(
+      initialState("runs"),
+      { type: "session", key: "s1" },
+      { type: "role", run: "r1", dispatchId: "d1" },
+      { type: "pause" },
+    );
+    expect([s.session, s.role, s.paused]).toEqual([{ key: "s1" }, { run: "r1", dispatchId: "d1" }, true]);
+    const up = run(s, { type: "up" });
+    expect([up.session, up.role]).toEqual([{ key: "s1" }, null]);
+    expect(run(up, { type: "up" }, { type: "pause" })).toMatchObject({
+      session: null,
+      role: null,
+      paused: false,
+    });
+    // "earlier runs" is a session too, with no key
+    expect(run(initialState("runs"), { type: "session", key: null }).session).toEqual({ key: null });
   });
 });
```


#### Modify `test/entry/tui/status.test.tsx`

```diff
--- a/test/entry/tui/status.test.tsx
+++ b/test/entry/tui/status.test.tsx
@@ -92,11 +92,11 @@ describe("the Status tab (spec §9.1)", () => {
   it("opens the active profile or a recent run with enter", async () => {
     await status();
     await h!.s.press("shift+g", "k", "k", "return");
     expect(h!.app().getState()).toMatchObject({ tab: "profiles", profile: "default" });
     await h!.s.press("shift+g", "return");
-    expect(h!.app().getState()).toMatchObject({ tab: "runs", run: "20260925-090000-auth-refactor" });
+    expect(h!.app().getState()).toMatchObject({ tab: "runs", session: { key: "s-auth" } });
   });
 
   it("shows and opens the profile this repo runs on", async () => {
     const fx = fixtureEffects({ repo: "/r", bindings: { "/r": "cheap" } });
     fx.create("cheap");
```


- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/entry/tui/runs.test.tsx test/entry/tui/state.test.ts test/entry/tui/effects.test.ts`. Expected: FAIL — `FIXTURE_SESSIONS`, `WATCHED_EVERY_MS` and `watchDirs` are not exported; the `session`, `role` and `up` actions do nothing.

- [ ] **Step 3: Draw the sessions, a session and a role; watch the open one**

#### Modify `src/entry/tui/commands.ts`

```diff
--- a/src/entry/tui/commands.ts
+++ b/src/entry/tui/commands.ts
@@ -312,11 +312,11 @@ export const COMMANDS = [
     scope: "row.profiles",
     keys: ["left", "h"],
   },
   {
     id: "runs.open",
-    title: "Open the run",
+    title: "Open the session or role",
     group: "Runs",
     scope: "row.runs",
     keys: ["return"],
     hint: 1,
     short: "open",
```


#### Modify `src/entry/tui/effects.ts`

```diff
--- a/src/entry/tui/effects.ts
+++ b/src/entry/tui/effects.ts
@@ -1,14 +1,13 @@
-import { statSync } from "node:fs";
+import { type FSWatcher, statSync, watch } from "node:fs";
 import { adapterFor } from "../../adapters/registry.ts";
 import "../../adapters/all.ts";
 import { agentFiles } from "../../domain/agents.ts";
 import type { Catalog } from "../../domain/catalog.ts";
 import { HARNESS_KEYS, type Profile, type ProfileDoc, type ProfilePatch } from "../../domain/profile.ts";
 import { type Validation, validateProfile } from "../../domain/profile-rules.ts";
 import type { Access } from "../../domain/record.ts";
-import type { RouteSource } from "../../domain/route.ts";
 import { VERSION } from "../../infra/version.ts";
 import {
   type CatalogModel,
   catalogQuery,
   loadCatalog,
@@ -35,17 +34,33 @@ import {
   projectsFile,
   readProfileDoc,
   readProjects,
   runnableBackends,
 } from "../../services/profile-store.ts";
-import { findRun, listRuns, readRoutes, type Run, runPaths } from "../../services/run-store.ts";
+import { listRuns, type Run, runPaths } from "../../services/run-store.ts";
+import {
+  type RoleDetail,
+  roleDetail,
+  type SessionDetail,
+  sessionDetail,
+  type SessionRow,
+  sessionRows,
+} from "../../services/runs-page.ts";
 import { type RunSummary, summarizeRun } from "../../services/summary.ts";
 import { defaultDeps } from "../deps.ts";
 import { mcpHandshake } from "../mcp/handshake.ts";
 
 /** A save refused because the profile changed on disk since its preview read it carries this path. */
 export { CHANGED_ON_DISK } from "../../services/profile-service.ts";
+export type {
+  Milestone,
+  RoleDetail,
+  RoleRow,
+  SessionDetail,
+  SessionRow,
+  SessionRun,
+} from "../../services/runs-page.ts";
 
 /** One line of the run list. */
 export interface RunRow {
   id: string;
   title: string;
@@ -54,46 +69,33 @@ export interface RunRow {
   live: number;
   roleRuns: number;
   landed: number;
   /** the budget's spent fraction, null without a cap */
   budget: number | null;
-}
-
-interface Climb {
-  lane: string;
-  from: string;
-  to: string;
-  reason: string;
-  /** the environment's fault (a limit, a missing service), not the rung's */
-  env: boolean;
-}
-
-interface Decision {
-  lane: string;
-  role: string;
-  source: RouteSource;
-  kind: string | null;
-  difficulty: string | null;
-  rung: string;
-}
-
-/** Spec §9.1's run view: live lanes, climbs, Jev decisions, budget, landed milestones. */
-export interface RunDetail {
-  summary: RunSummary;
-  climbs: Climb[];
-  decisions: Decision[];
+  /** the session that started it (the Runs tab opens it); null for a run from before 1.1 */
+  session: string | null;
 }
 
 /**
  * Everything the TUI reads or changes, behind one seam (spec §9.4 `effects.ts`: services injected).
  * The live set calls the services; tests and the storybook pass fakes.
  */
 export interface Effects {
   version: string;
   doctor(): Promise<DoctorReport>;
   runs(): { rows: RunRow[]; warnings: string[] };
-  run(id: string): RunDetail;
+  /** spec §4: the Runs tab's top level, the sessions */
+  sessions(): { rows: SessionRow[]; warnings: string[] };
+  /** a session's screen; `key` null is "earlier runs" */
+  session(key: string | null): SessionDetail;
+  /** a role's screen */
+  role(run: string, dispatchId: string): RoleDetail;
+  /**
+   * calls `onChange` when a file under one of `dirs` changes (spec §4: the open screen redraws when a run file
+   * changes); null when they cannot be watched here, and the screen polls every second instead
+   */
+  watch(dirs: string[], onChange: () => void): (() => void) | null;
   /** stops a live role; resolves to the line the toast shows */
   cancel(run: string, name: string): Promise<string>;
   profiles(): {
     names: string[];
     /** global */
@@ -191,37 +193,44 @@ export function rowOf(s: RunSummary): RunRow {
     createdAt: s.createdAt,
     live: s.live.length,
     roleRuns: s.totals.runs,
     landed: s.milestones.length,
     budget: s.budget?.fraction ?? null,
+    session: s.session?.sessionId ?? null,
   };
 }
 
-/** The climbs and route decisions in a run's routes.jsonl. */
-function routesOf(run: Run): { climbs: Climb[]; decisions: Decision[] } {
-  const rows = readRoutes(run);
-  return {
-    climbs: rows
-      .filter((r) => r.source === "climb" && r.from !== null)
-      .map((r) => ({
-        lane: r.lane,
-        from: r.from as string,
-        to: r.rung,
-        reason: r.reason ?? "",
-        env: r.env === true,
-      })),
-    decisions: rows
-      .filter((r) => r.source === "route")
-      .map((r) => ({
-        lane: r.lane,
-        role: r.role,
-        source: r.decidedBy,
-        kind: r.kind,
-        difficulty: r.difficulty,
-        rung: r.rung,
-      })),
+/** How long a burst of file events is gathered into one redraw. */
+const WATCH_SETTLE_MS = 100;
+
+/** `fs.watch` on each run folder, recursive; null when any of them cannot be watched. */
+export function watchDirs(dirs: string[], onChange: () => void): (() => void) | null {
+  const watchers: FSWatcher[] = [];
+  let timer: ReturnType<typeof setTimeout> | null = null;
+  const fire = () => {
+    if (timer !== null) return;
+    timer = setTimeout(() => {
+      timer = null;
+      onChange();
+    }, WATCH_SETTLE_MS);
+  };
+  const stop = () => {
+    if (timer !== null) clearTimeout(timer);
+    for (const w of watchers) w.close();
   };
+  try {
+    for (const d of dirs) {
+      const w = watch(d, { recursive: true }, fire);
+      // a watcher that breaks later (the folder removed) just stops; the screen's slow poll still reads
+      w.on("error", () => w.close());
+      watchers.push(w);
+    }
+  } catch {
+    stop();
+    return null;
+  }
+  return stop;
 }
 
 /**
  * The live effects. `repo` is the git toplevel the TUI was opened in (null outside one): inside a repo
  * bound to a profile, `here` is that profile and activating binds the repo instead of the global profile.
@@ -236,14 +245,14 @@ export function liveEffects(repo: string | null = null): Effects {
     doctor: () => doctor({ bunVersion: Bun.version, version: VERSION, handshake: () => mcpHandshake() }),
     runs() {
       const { runs, corrupt } = listRuns();
       return { rows: rows(runs), warnings: corrupt.map((c) => `skipped run ${c.id}: ${c.reason}`) };
     },
-    run(id) {
-      const run = findRun(id);
-      return { summary: summarizeRun(deps, run), ...routesOf(run) };
-    },
+    sessions: () => sessionRows(deps),
+    session: (key) => sessionDetail(deps, key),
+    role: (run, dispatchId) => roleDetail(deps, run, dispatchId),
+    watch: watchDirs,
     async cancel(run, name) {
       const r = await cancel(deps, run, name);
       return `${r.record.name} ${r.record.status}`;
     },
     profiles: () => ({ names: listProfiles(), active: activeName(), here: activeName(repo), repo: bound() }),
```


#### Replace the whole of `src/entry/tui/fixtures.ts` with

```ts
import { isDeepStrictEqual } from "node:util";
import {
  applyPatch,
  defaultProfileDoc,
  diffProfiles,
  type ProfileDoc,
  resolveProfile,
} from "../../domain/profile.ts";
import { validateProfile } from "../../domain/profile-rules.ts";
import { catalogQuery, loadCatalog } from "../../services/catalog-service.ts";
import type { RunRecord } from "../../domain/record.ts";
import type { DoctorReport } from "../../services/doctor.ts";
import type { RunSummary } from "../../services/summary.ts";
import {
  CHANGED_ON_DISK,
  type Effects,
  type RoleDetail,
  type RoleRow,
  rowOf,
  type SessionRow,
  type SessionRun,
} from "./effects.ts";
import { withStaged } from "./profile-tree.ts";

/**
 * Fixed data for the storybook (CATHERD_STORY=1), the frame snapshots and the view tests: a setup with
 * one backend missing and one not logged in, two runs (one live), and profiles kept in memory. Only
 * the catalog is the shipped one, read through the catalog service.
 */
export const FIXTURE_REPORT: DoctorReport = {
  ready: false,
  version: "1.0.0",
  checks: [
    { id: "bun", label: "Bun", state: "ok", word: "ready", detail: "1.4.2" },
    { id: "config", label: "config", state: "ok", word: "ready", detail: "active profile default" },
    { id: "profile", label: "profile default", state: "ok", word: "ready", detail: "valid" },
    {
      id: "backend:codex",
      label: "codex",
      state: "ok",
      word: "ready",
      detail: "0.156.1, logged in, 14 models",
    },
    {
      id: "backend:claude-code",
      label: "claude-code",
      state: "ok",
      word: "ready",
      detail: "2.1.282, logged in, 6 models",
    },
    {
      id: "backend:opencode",
      label: "opencode",
      state: "warn",
      word: "not logged in",
      detail: "2.0.16 (a failover stand-in uses it)",
      fix: "opencode auth login",
    },
    {
      id: "jev",
      label: "Jev",
      state: "skip",
      word: "no key",
      detail: "optional: routing uses the lane files",
    },
    {
      id: "plugin",
      label: "Claude Code plugin",
      state: "fail",
      word: "missing",
      detail: "not installed",
      fix: "claude plugin marketplace add 47vigen/catherd && claude plugin install catherd@catherd",
    },
    { id: "agents", label: "Claude agents", state: "ok", word: "ready", detail: "2 linked" },
    { id: "mcp", label: "MCP server", state: "ok", word: "ready", detail: "21 tools" },
  ],
};

const summary = (o: Partial<RunSummary> & Pick<RunSummary, "id" | "title">): RunSummary => ({
  repo: "/home/me/app",
  createdAt: "2026-09-26T11:48:00.000Z",
  session: null,
  continuedIn: null,
  stateTail: [],
  live: [],
  totals: {
    runs: 0,
    ok: 0,
    notOk: [],
    tokens: { input: 0, cached: 0, output: 0 },
    costUsd: 0,
    wallMinutes: 12,
  },
  agents: { runs: 0, totalTokens: 0, costUsd: 0 },
  jev: { decisions: 0, fallbacks: 0 },
  harness: [],
  budget: null,
  milestones: [],
  warnings: [],
  ...o,
});

const JOBS = "20260926-114800-jobs-screen";
const AUTH = "20260925-090000-auth-refactor";
const PLAN4 = "20260924-080000-auth-plan-4";

const FIXTURE_RUNS: RunSummary[] = [
  summary({
    id: JOBS,
    title: "Jobs screen",
    session: { sessionId: "s-jobs", hostSessionId: null, name: "jobs screen", live: true },
    stateTail: ["M1 in review", "Next: fix round for M1.L2"],
    live: [
      {
        name: "worker-M1.L2",
        rung: "codex:gpt-6-sol#medium",
        state: "running",
        secs: 252,
        dispatchId: "d2",
      },
      { name: "reviewer-M1", rung: "codex:gpt-6-sol#high", state: "starting", secs: 4, dispatchId: "d3" },
    ],
    totals: {
      runs: 3,
      ok: 3,
      notOk: [],
      tokens: { input: 812_000, cached: 640_000, output: 41_000 },
      costUsd: 0,
      wallMinutes: 12,
    },
    jev: { decisions: 2, fallbacks: 0 },
    budget: { fraction: 0.52, minutes: { spent: 31, cap: 60 } },
    milestones: ["M0 | scaffold the jobs screen | 3f2a9c1 | 9 | bun test test/jobs"],
  }),
  summary({
    id: AUTH,
    title: "Auth refactor",
    repo: "/home/me/api",
    createdAt: "2026-09-25T09:00:00.000Z",
    session: { sessionId: "s-auth", hostSessionId: null, name: "auth build", live: false },
    continuedIn: "kit follow-up",
    stateTail: ["Next: done"],
    totals: {
      runs: 9,
      ok: 8,
      notOk: ["worker-M2.L1 (limit)"],
      tokens: { input: 3_100_000, cached: 2_400_000, output: 160_000 },
      costUsd: 1.84,
      wallMinutes: 96,
    },
    milestones: ["M1 | tokens | a1 | 30 | ok", "M2 | sessions | b2 | 41 | ok", "M3 | cleanup | c3 | 25 | ok"],
  }),
];

/** A role of the fixtures; `since` minutes before the fixed clock (2026-09-26 12:00 UTC) for a live one. */
const role = (o: Partial<RoleRow> & Pick<RoleRow, "run" | "dispatchId" | "name" | "rung">): RoleRow => ({
  role: o.name.split("-")[0] ?? "worker",
  status: "ok",
  live: false,
  since: "2026-09-26T11:48:10.000Z",
  secs: null,
  lastEvent: null,
  replyStatus: "complete",
  ...o,
});

const auth = (continued: SessionRun["continued"]): SessionRun => ({
  id: AUTH,
  title: "Auth refactor",
  repo: "/home/me/api",
  createdAt: "2026-09-25T09:00:00.000Z",
  continued,
  continuedIn: continued === "elsewhere" ? "kit follow-up" : null,
  budget: null,
  milestones: [
    { name: "M1", landed: true, what: "tokens" },
    { name: "M2", landed: true, what: "sessions" },
    { name: "M3", landed: true, what: "cleanup" },
  ],
  roles: [
    role({ run: AUTH, dispatchId: "a3", name: "reviewer-M3", rung: "codex:gpt-6-sol#high", secs: 188 }),
    role({ run: AUTH, dispatchId: "a2", name: "worker-M3.L1", rung: "codex:gpt-6-luna#high", secs: 402 }),
    role({
      run: AUTH,
      dispatchId: "a1",
      name: "worker-M2.L1",
      rung: "codex:gpt-6-sol#medium",
      status: "limit",
      secs: 95,
      replyStatus: null,
    }),
  ],
});

/** The Runs tab's sessions: a live one with three live roles, one whose run another session continued, and it. */
export const FIXTURE_SESSIONS: { row: SessionRow; runs: SessionRun[] }[] = [
  {
    row: {
      key: "s-jobs",
      name: "jobs screen",
      live: true,
      runs: 1,
      liveRoles: 3,
      landed: 1,
      lastActivity: "2026-09-26T11:59:40.000Z",
    },
    runs: [
      {
        id: JOBS,
        title: "Jobs screen",
        repo: "/home/me/app",
        createdAt: "2026-09-26T11:48:00.000Z",
        continued: null,
        continuedIn: null,
        budget: 0.52,
        milestones: [
          { name: "M0", landed: true, what: "scaffold the jobs screen" },
          { name: "M1", landed: false, what: "" },
        ],
        roles: [
          role({
            run: JOBS,
            dispatchId: "d2",
            name: "worker-M1.L2",
            rung: "codex:gpt-6-sol#medium",
            status: "running",
            live: true,
            since: "2026-09-26T11:55:48.000Z",
            lastEvent: "$ bun test test/jobs --bail",
            replyStatus: null,
          }),
          role({
            run: JOBS,
            dispatchId: "d4",
            name: "worker-M1.L3",
            rung: "codex:gpt-6-luna#high",
            status: "running",
            live: true,
            since: "2026-09-26T11:57:00.000Z",
            lastEvent: "edit src/jobs/list.tsx",
            replyStatus: null,
          }),
          role({
            run: JOBS,
            dispatchId: "d3",
            name: "reviewer-M1",
            rung: "codex:gpt-6-sol#high",
            status: "starting",
            live: true,
            since: "2026-09-26T11:59:56.000Z",
            replyStatus: null,
          }),
          role({
            run: JOBS,
            dispatchId: "d1",
            name: "worker-M1.L1",
            rung: "codex:gpt-6-luna#high",
            secs: 312,
          }),
        ],
      },
    ],
  },
  {
    row: {
      key: "s-kit",
      name: "kit follow-up",
      live: false,
      runs: 1,
      liveRoles: 0,
      landed: 3,
      lastActivity: "2026-09-25T11:20:00.000Z",
    },
    runs: [auth("here")],
  },
  {
    row: {
      key: "s-auth",
      name: "auth build",
      live: false,
      runs: 2,
      liveRoles: 0,
      landed: 5,
      lastActivity: "2026-09-25T10:36:00.000Z",
    },
    runs: [
      auth("elsewhere"),
      {
        id: PLAN4,
        title: "Auth plan 4",
        repo: "/home/me/api",
        createdAt: "2026-09-24T08:00:00.000Z",
        continued: null,
        continuedIn: null,
        budget: null,
        milestones: [
          { name: "M1", landed: true, what: "schema" },
          { name: "M2", landed: true, what: "handlers" },
        ],
        roles: [
          role({
            run: PLAN4,
            dispatchId: "p2",
            name: "reviewer-M2",
            rung: "codex:gpt-6-sol#high",
            secs: 140,
          }),
          role({
            run: PLAN4,
            dispatchId: "p1",
            name: "worker-M2.L1",
            rung: "codex:gpt-6-sol#medium",
            secs: 610,
          }),
        ],
      },
    ],
  },
];

/** The role screen's text: the brief, the reply and the record behind worker-M1.L1 of the jobs screen. */
const FIXTURE_ROLE: Omit<RoleDetail, "run" | "runTitle" | "dispatchId" | "name" | "role" | "rung" | "state"> =
  {
    brief:
      "Read /home/me/.local/share/catherd/runs/jobs-screen/lanes/M1.L1.md\nFast check: bun test test/jobs/list",
    reply:
      "Done: the list renders every job with its state.\nsrc/jobs/list.tsx:12 — the list\nsrc/jobs/list.test.tsx:4 — its test\nSTATUS: complete — list in place, fast check green",
    record: null,
  };

/** The record a finished fixture role would have: what the role screen shows under RECORD. */
function fixtureRecord(r: SessionRun, x: RoleRow): RunRecord {
  const start = Date.parse(x.since);
  return {
    schema: 1,
    runId: r.id,
    dispatchId: x.dispatchId,
    name: x.name,
    role: x.role,
    lane: x.name.includes("-M") && x.name.includes(".") ? x.name.slice(x.name.indexOf("-") + 1) : null,
    backend: x.rung.slice(0, x.rung.indexOf(":")),
    rung: x.rung,
    attempt: 1,
    failoverFrom: null,
    thread: "01a0d0d4-d0a6-71a1-983c-82a9169200b4",
    status: x.status as RunRecord["status"],
    startedAt: x.since,
    endedAt: new Date(start + (x.secs ?? 0) * 1000).toISOString(),
    secs: x.secs ?? 0,
    exitCode: 0,
    signal: null,
    cliVersion: "0.157.0",
    tokens: { input: 812_000, cached: 640_000, output: 41_000 },
    costUsd: null,
    changedOwned: ["src/jobs/list.tsx", "src/jobs/list.test.tsx"],
    violations: [],
    replyStatus: x.replyStatus as RunRecord["replyStatus"],
    replyWhy: x.replyStatus ? "list in place, fast check green" : null,
    threadHeavy: false,
    access: "workspace-write",
    isolated: false,
    images: [],
    error: null,
    replyPath: `roles/${x.name}/${x.dispatchId}/reply.md`,
  };
}

const BACKENDS = ["claude", "codex", "claude-code", "opencode"];

/**
 * Effects over the fixtures; profile writes stay in memory and are recorded in `writes`. `repo` is the
 * directory the TUI stands in and `bindings` the repo bindings, as `liveEffects(repo)` reads them.
 */
export interface FixtureOptions {
  runs?: RunSummary[];
  sessions?: { row: SessionRow; runs: SessionRun[] }[];
  report?: DoctorReport;
  repo?: string;
  bindings?: Record<string, string>;
  /** false: the run folders cannot be watched here, as on a platform without fs.watch */
  watchable?: boolean;
}

export function fixtureEffects(o: FixtureOptions = {}): Effects & {
  writes: string[];
  /** what a change to a watched run file does: every open watch hears of it */
  touch(): void;
  /** the run folders watched now */
  watched: string[][];
} {
  const runs = o.runs ?? FIXTURE_RUNS;
  const sessions = o.sessions ?? FIXTURE_SESSIONS;
  const listeners = new Set<() => void>();
  const watched: string[][] = [];
  const docs = new Map<string, ProfileDoc>([["default", defaultProfileDoc()]]);
  let active = "default";
  const bindings = new Map(Object.entries(o.bindings ?? {}));
  const bound = () => (o.repo && bindings.has(o.repo) ? o.repo : null);
  const writes: string[] = [];
  /** what the ProfileService returns for writing `after` over `before` */
  const result = (
    name: string,
    before: ProfileDoc,
    after: ProfileDoc,
    staged: Record<string, string> = {},
  ) => {
    const p = resolveProfile(after, name);
    const v = validateProfile(p, withStaged(loadCatalog({ timings: false }), staged), BACKENDS);
    return {
      saved: v.errors.length === 0,
      ...v,
      diff: diffProfiles(resolveProfile(before, name), p),
      linked: [],
      pruned: [],
      newSessionNeededFor: [],
    };
  };
  return {
    writes,
    watched,
    touch: () => {
      for (const l of listeners) l();
    },
    version: "1.0.0",
    doctor: async () => o.report ?? FIXTURE_REPORT,
    runs: () => ({ rows: runs.map(rowOf), warnings: [] }),
    sessions: () => ({ rows: sessions.map((x) => x.row), warnings: [] }),
    session(key) {
      const x = sessions.find((y) => y.row.key === key);
      if (!x) throw new Error(`no session "${key}"`);
      return { session: x.row, runs: x.runs, dirs: x.runs.map((r) => `/runs/${r.id}`) };
    },
    role(run, dispatchId) {
      for (const x of sessions)
        for (const r of x.runs) {
          const role = r.id === run ? r.roles.find((y) => y.dispatchId === dispatchId) : undefined;
          if (!role) continue;
          return {
            run,
            runTitle: r.title,
            dispatchId,
            name: role.name,
            role: role.role,
            rung: role.rung,
            state: role.live ? role.status : "finished",
            brief: FIXTURE_ROLE.brief,
            reply: role.live ? "" : FIXTURE_ROLE.reply,
            record: role.live ? null : fixtureRecord(r, role),
          };
        }
      throw new Error(`no dispatch ${dispatchId} in run ${run}`);
    },
    watch(dirs, onChange) {
      if (o.watchable === false) return null;
      watched.push(dirs);
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
        watched.splice(watched.indexOf(dirs), 1);
      };
    },
    async cancel(run, name) {
      writes.push(`cancel ${run} ${name}`);
      return `${name} cancelled`;
    },
    profiles: () => ({
      names: [...docs.keys()].sort(),
      active,
      here: bindings.get(o.repo ?? "") ?? active,
      repo: bound(),
    }),
    readProfile(name) {
      const d = docs.get(name);
      if (!d) throw new Error(`no profile named "${name}"`);
      return d;
    },
    catalog: (billing) => ({
      catalog: loadCatalog({ timings: false }),
      models: catalogQuery({ scoredOnly: false, limit: Number.MAX_SAFE_INTEGER }, billing).models,
    }),
    validate: (p, c) => validateProfile(p, c, BACKENDS),
    enforcement: (rung) => (rung.startsWith("codex:") ? "enforced" : "advisory"),
    harnesses: ["codex", "claude-code", "opencode"],
    agents: (p) =>
      (["architect", "verifier"] as const)
        .filter((r) => p.roles[r].enabled)
        .flatMap((r) =>
          p.roles[r].rungs
            .filter((x) => x.startsWith("claude:"))
            .map((x) => `catherd-${p.name}-${r}-${x.slice(7).replace("#", "-")}`),
        ),
    async save(name, patch, treatLikes, shown) {
      const before = docs.get(name) ?? defaultProfileDoc(name);
      // the ProfileService's compare-and-swap: nothing is written over a profile the preview did not show
      if (shown !== undefined && !isDeepStrictEqual(before, shown))
        return {
          saved: false,
          errors: [
            {
              path: CHANGED_ON_DISK,
              message: `profile "${name}" changed on disk since it was shown`,
              fix: "check the changes and save again",
            },
          ],
          warnings: [],
          diff: [],
          linked: [],
          pruned: [],
          newSessionNeededFor: [],
        };
      const after = applyPatch(before, patch);
      const r = result(name, before, after, treatLikes);
      if (r.saved) {
        docs.set(name, after);
        const tl = Object.keys(treatLikes).length ? ` ${JSON.stringify(treatLikes)}` : "";
        writes.push(`save ${name} ${JSON.stringify(patch)}${tl}`);
      }
      return r;
    },
    activate(name, repo) {
      if (repo !== null) {
        bindings.set(repo, name);
        writes.push(`bind ${name} ${repo}`);
      } else {
        active = name;
        writes.push(`activate ${name}`);
      }
      return {
        linked: [],
        pruned: [],
        newSessionNeededFor: [`catherd-${name}-architect-claude-opus-5-5-high`],
      };
    },
    create(name, from) {
      const doc = { ...(from ? (docs.get(from) as ProfileDoc) : defaultProfileDoc(name)), name };
      const r = result(name, doc, doc);
      if (r.saved) {
        docs.set(name, doc);
        writes.push(`create ${name}${from ? ` from ${from}` : ""}`);
      }
      return r;
    },
    remove(name) {
      if (name === active) throw new Error(`"${name}" is the active profile`);
      const at = [...bindings].find(([, p]) => p === name);
      if (at) throw new Error(`"${name}" is bound to ${at[0]}`);
      docs.delete(name);
      writes.push(`remove ${name}`);
      return { linked: [], pruned: [], newSessionNeededFor: [] };
    },
    async refreshCatalog() {
      writes.push("refresh");
      return [{ backend: "codex", models: 14, fetchedAt: "2026-09-26T12:00:00.000Z" }];
    },
  };
}
```


#### Modify `src/entry/tui/providers/data.tsx`

```diff
--- a/src/entry/tui/providers/data.tsx
+++ b/src/entry/tui/providers/data.tsx
@@ -1,9 +1,9 @@
 import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
 import { errorMessage, isCatherdError } from "../../../domain/errors.ts";
 import type { DoctorReport } from "../../../services/doctor.ts";
-import type { Effects, RunRow } from "../effects.ts";
+import type { Effects, RunRow, SessionRow } from "../effects.ts";
 import { useApp } from "./app.tsx";
 
 export interface Polled<T> {
   value: T | null;
   error: string | null;
@@ -69,10 +69,12 @@ export interface Data {
   checking: boolean;
   checkedAt: number | null;
   checkError: string | null;
   recheck(): void;
   runs: Polled<{ rows: RunRow[]; warnings: string[] }>;
+  /** spec §4: the Runs tab's sessions, read on the runs' cadence */
+  sessions: Polled<{ rows: SessionRow[]; warnings: string[] }>;
   /** the profile names and the active one; read on the runs' cadence and after every profile write */
   profiles: Polled<ReturnType<Effects["profiles"]>>;
 }
 
 const DataContext = createContext<Data | null>(null);
@@ -113,21 +115,23 @@ export function DataProvider(props: { children: ReactNode }) {
       live = false;
       app.clock.clearTimeout(h);
     };
   }, [app.effects, app.clock, nonce]);
   const runs = usePoll(() => app.effects.runs(), RUNS_EVERY_MS, { paused: app.state.paused });
+  const sessions = usePoll(() => app.effects.sessions(), RUNS_EVERY_MS, { paused: app.state.paused });
   // cheap (a directory listing and two small reads), and another terminal may change them at any time
   const profiles = usePoll(() => app.effects.profiles(), RUNS_EVERY_MS);
   const value = useMemo(
     () => ({
       report,
       checking,
       checkedAt,
       checkError,
       recheck: () => setNonce((n) => n + 1),
       runs,
+      sessions,
       profiles,
     }),
-    [report, checking, checkedAt, checkError, runs, profiles],
+    [report, checking, checkedAt, checkError, runs, sessions, profiles],
   );
   return <DataContext.Provider value={value}>{props.children}</DataContext.Provider>;
 }
```


#### Modify `src/entry/tui/state.ts`

```diff
--- a/src/entry/tui/state.ts
+++ b/src/entry/tui/state.ts
@@ -118,12 +118,14 @@ export interface AppState {
   /** the profile the Profiles tab shows; null until one is read */
   profile: string | null;
   drafts: Record<string, Draft>;
   /** the open dialogs; only the top one is drawn and takes keys */
   dialogs: Dialog[];
-  /** the run the Runs tab has open; null shows the list */
-  run: string | null;
+  /** spec §4: the session the Runs tab has open (`key` null: "earlier runs"); null shows the sessions */
+  session: { key: string | null } | null;
+  /** the role the open session shows, by its dispatch */
+  role: { run: string; dispatchId: string } | null;
   paused: boolean;
   armed: Armed | null;
 }
 
 export type Action =
@@ -143,21 +145,27 @@ export type Action =
   | { type: "replace"; dialog: Dialog }
   | { type: "close" }
   | { type: "saving"; name: string; on: boolean }
   | { type: "input"; value: string }
   | { type: "invalid"; error: string | null }
-  | { type: "run"; id: string | null }
+  /** opens a session of the Runs tab (`key` null: "earlier runs") */
+  | { type: "session"; key: string | null }
+  /** opens one role of the open session */
+  | { type: "role"; run: string; dispatchId: string }
+  /** the Runs tab goes back one level: a role to its session, a session to the list */
+  | { type: "up" }
   | { type: "pause" }
   | { type: "arm"; what: Armed["what"]; target: string; at: number }
   | { type: "disarm" };
 
 export const initialState = (tab: Tab = "status"): AppState => ({
   tab,
   profile: null,
   drafts: {},
   dialogs: [],
-  run: null,
+  session: null,
+  role: null,
   paused: false,
   armed: null,
 });
 
 const fresh = (name: string, doc: ProfileDoc): Draft => ({
@@ -322,12 +330,16 @@ export function reduce(s: AppState, a: Action): AppState {
       if (top.kind === "prompt")
         next = a.type === "input" ? { ...top, value: a.value, error: null } : { ...top, error: a.error };
       else if (top.kind === "save" && a.type === "invalid") next = { ...top, error: a.error };
       return next === top ? s : { ...s, dialogs: [...s.dialogs.slice(0, -1), next] };
     }
-    case "run":
-      return { ...s, run: a.id, armed: null };
+    case "session":
+      return { ...s, session: { key: a.key }, role: null, armed: null };
+    case "role":
+      return { ...s, role: { run: a.run, dispatchId: a.dispatchId }, armed: null };
+    case "up":
+      return s.role ? { ...s, role: null, armed: null } : { ...s, session: null, armed: null };
     case "pause":
       return { ...s, paused: !s.paused };
     case "arm":
       return { ...s, armed: { what: a.what, target: a.target, at: a.at } };
     case "disarm":
```


#### Modify `src/entry/tui/stories.ts`

```diff
--- a/src/entry/tui/stories.ts
+++ b/src/entry/tui/stories.ts
@@ -1,7 +1,8 @@
 import type { ProfilePatch } from "../../domain/profile.ts";
 import type { CommandId } from "./commands.ts";
+import type { FixtureOptions } from "./fixtures.ts";
 import type { AppApi } from "./providers/app.tsx";
 import type { AppKeymap } from "./providers/keymap.tsx";
 import type { Action } from "./state.ts";
 
 /** One step towards a screen: a command as a key would run it, a reducer action, or a profile shown. */
@@ -9,10 +10,12 @@ export type Step = { command: CommandId } | { action: Action } | { show: string
 
 export interface Story {
   name: string;
   title: string;
   steps: Step[];
+  /** the fixtures the frame snapshots render it on (the storybook shows it on its one set) */
+  fixtures?: FixtureOptions;
 }
 
 const SHOWN: Step[] = [{ show: "default" }];
 const DIRTY: Step[] = [
   ...SHOWN,
@@ -43,15 +46,35 @@ export const STORIES: Story[] = [
     name: "palette",
     title: "Command palette",
     steps: [{ command: "tab.status" }, { command: "app.palette" }],
   },
   { name: "help", title: "Keyboard shortcuts", steps: [{ command: "tab.status" }, { command: "app.help" }] },
-  { name: "runs", title: "Runs: the list", steps: [{ command: "tab.runs" }] },
   {
-    name: "run",
-    title: "Runs: one live run",
-    steps: [{ command: "tab.runs" }, { action: { type: "run", id: "20260926-114800-jobs-screen" } }],
+    name: "runs-empty",
+    title: "Runs: no runs yet",
+    steps: [{ command: "tab.runs" }],
+    fixtures: { runs: [], sessions: [] },
+  },
+  { name: "runs", title: "Runs: the sessions", steps: [{ command: "tab.runs" }] },
+  {
+    name: "session",
+    title: "Runs: one session with two runs, one continued elsewhere",
+    steps: [{ command: "tab.runs" }, { action: { type: "session", key: "s-auth" } }],
+  },
+  {
+    name: "session-live",
+    title: "Runs: a live session with three live roles",
+    steps: [{ command: "tab.runs" }, { action: { type: "session", key: "s-jobs" } }],
+  },
+  {
+    name: "role",
+    title: "Runs: a role opened",
+    steps: [
+      { command: "tab.runs" },
+      { action: { type: "session", key: "s-jobs" } },
+      { action: { type: "role", run: "20260926-114800-jobs-screen", dispatchId: "d1" } },
+    ],
   },
 ];
 
 /** One step, as a key or the reducer would take it. */
 export function applyStep(s: Step, app: AppApi, keymap: AppKeymap): void {
```


#### Replace the whole of `src/entry/tui/views/runs.tsx` with

```tsx
import { useEffect, useRef, useState } from "react";
import { useApp, useBack, useNow } from "../providers/app.tsx";
import { useData, usePoll } from "../providers/data.tsx";
import { useCommandLayer } from "../providers/keymap.tsx";
import { errorToast } from "../providers/toast.tsx";
import { useUi } from "../providers/theme.tsx";
import { isArmed } from "../state.ts";
import { ago, clock, plural, shortRung, wrap } from "../text.ts";
import { glyph, mascot, type Token } from "../theme.ts";
import type { RoleRow, SessionRow, SessionRun } from "../effects.ts";
import { Line, type Part } from "../widgets/line.tsx";
import { List, type ListItem, useSelected } from "../widgets/list.tsx";

/** How often an open screen is read again when its run folders cannot be watched, unless paused (spec §4). */
export const RUN_EVERY_MS = 1_000;
/** How often a watched screen is read again all the same: a run that joins the session has no watch yet. */
export const WATCHED_EVERY_MS = 5_000;

/**
 * The selected row, where moving the cursor takes back a first ctrl+d (Ruling 3: moving or esc disarms),
 * as the dialog list does.
 */
function useSelection(): [string | null, (key: string) => void, () => string | null] {
  const app = useApp();
  const sel = useSelected();
  const select = (key: string) => {
    if (key !== sel.current() && app.getState().armed) app.dispatch({ type: "disarm" });
    sel.select(key);
  };
  return [sel.selected, select, sel.current];
}

/** One session of the top level: `● live  <name>  2 runs · 3 live roles · 1 landed  4m ago` (spec §4). */
export function sessionParts(s: SessionRow, now: number, plain: boolean): Part[] {
  return [
    s.live
      ? { text: `${glyph("live", plain)} live  `, tone: "info" }
      : { text: `${glyph("dot", plain)} idle  `, tone: "muted" },
    { text: `${s.name}  `, bold: true },
    {
      text: `${plural(s.runs, "run")} · ${plural(s.liveRoles, "live role")} · ${s.landed} landed  `,
      tone: "muted",
    },
    { text: ago(now - Date.parse(s.lastActivity)), tone: "muted" },
  ];
}

const keyOf = (k: string | null) => (k === null ? "earlier" : `s:${k}`);
const fromKey = (k: string) => (k === "earlier" ? null : k.slice("s:".length));

function SessionList(props: { width: number; height: number }) {
  const app = useApp();
  const data = useData();
  const ui = useUi();
  const now = useNow(1_000);
  const [selected, setSelected, selectedNow] = useSelection();
  const rows = data.sessions.value?.rows ?? [];
  useCommandLayer("row.runs", {
    "runs.open": () => {
      const k = selectedNow();
      if (k) app.dispatch({ type: "session", key: fromKey(k) });
    },
  });
  const updated = app.state.paused
    ? "paused"
    : data.sessions.at !== null
      ? `updated ${ago(now - data.sessions.at)}`
      : "";
  const items: ListItem[] = rows.map((s) => ({
    key: keyOf(s.key),
    selectable: true,
    render: (sel, w) => (
      <Line width={w} selected={sel} parts={[{ text: " " }, ...sessionParts(s, now, ui.plain)]} />
    ),
  }));
  const warnings = data.sessions.value?.warnings ?? [];
  // a failed read says so, whether rows from an earlier good read are shown, none were, or none exist
  const failed = data.sessions.error;
  const failure = failed ? (
    <Line
      width={props.width}
      parts={[{ text: ` ${glyph("fail", ui.plain)} could not read the runs: ${failed}`, tone: "error" }]}
    />
  ) : null;
  if (rows.length === 0 && data.sessions.value) {
    const art = mascot("waiting");
    return (
      <box flexDirection="column" width={props.width} height={props.height} paddingTop={failed ? 1 : 2}>
        {failure}
        {art.map((l) => (
          <Line key={l} width={props.width} parts={[{ text: `   ${l}`, tone: "muted" }]} />
        ))}
        <Line
          width={props.width}
          parts={[
            { text: "   No runs yet. Start one in Claude Code: /catherd <what to build>", tone: "muted" },
          ]}
        />
      </box>
    );
  }
  return (
    <box flexDirection="column" width={props.width} height={props.height}>
      <Line
        width={props.width}
        parts={[
          { text: " SESSIONS", bold: true },
          { text: `  ${updated}`, tone: app.state.paused ? "warning" : "muted" },
        ]}
      />
      {failure}
      <List
        items={items}
        selected={selected}
        onSelect={setSelected}
        width={props.width}
        height={props.height - 1 - (failed ? 1 : 0) - Math.min(2, warnings.length)}
        filter={null}
        empty={failed ? "no runs read yet" : "reading runs…"}
      />
      {warnings.slice(0, 2).map((w) => (
        <Line
          key={w}
          width={props.width}
          parts={[{ text: ` ${glyph("warn", ui.plain)} ${w}`, tone: "warning" }]}
        />
      ))}
    </box>
  );
}

/** A finished role's glyph and colour by its record's status; a live one's by running or starting. */
function roleMark(r: RoleRow, plain: boolean): Part {
  if (r.live) return { text: glyph(r.status === "running" ? "live" : "waiting", plain), tone: "info" };
  const tone: Token =
    r.status === "ok"
      ? "success"
      : r.status === "cancelled"
        ? "muted"
        : r.status === "limit"
          ? "warning"
          : "error";
  return { text: glyph(r.status === "ok" ? "ok" : r.status === "cancelled" ? "skip" : "fail", plain), tone };
}

/** A run's heading on its session's screen: title, repo, when it started, its budget, where it moved. */
function runHeading(r: SessionRun, now: number, plain: boolean): Part[] {
  const bits = [r.repo, `started ${ago(now - Date.parse(r.createdAt))}`];
  if (r.budget !== null) bits.push(`budget ${Math.round(r.budget * 100)}%`);
  const moved =
    r.continued === "here" ? "continued here" : r.continuedIn ? `continued in ${r.continuedIn}` : null;
  return [
    { text: ` ${glyph("shut", plain)} ` },
    { text: r.title, bold: true },
    { text: `  ${bits.join(" · ")}`, tone: "muted" },
    ...(moved ? [{ text: ` · ${moved}`, tone: "info" as Token }] : []),
  ];
}

/** Spec §4: the open screen redraws when a run file changes, else every second; `p` stops both. */
function useLiveRead<T extends { dirs: string[] }>(read: () => T, key: string) {
  const app = useApp();
  const [watching, setWatching] = useState(false);
  const polled = usePoll(read, watching ? WATCHED_EVERY_MS : RUN_EVERY_MS, { paused: app.state.paused, key });
  const refresh = useRef(polled.refresh);
  refresh.current = polled.refresh;
  const dirs = polled.value?.dirs.join("\n") ?? "";
  useEffect(() => {
    if (app.state.paused || dirs === "") {
      setWatching(false);
      return;
    }
    const stop = app.effects.watch(dirs.split("\n"), () => refresh.current());
    setWatching(stop !== null);
    return () => stop?.();
  }, [dirs, app.state.paused, app.effects]);
  return { ...polled, watching };
}

function SessionView(props: { sessionKey: string | null; width: number; height: number }) {
  const app = useApp();
  const ui = useUi();
  const now = useNow(1_000);
  const [selected, setSelected, selectedNow] = useSelection();
  const polled = useLiveRead(() => app.effects.session(props.sessionKey), String(props.sessionKey));
  useBack(true, "view", () => app.dispatch({ type: "up" }));
  const d = polled.value;
  const roleAt = (key: string | null) =>
    d?.runs.flatMap((r) => r.roles).find((x) => key === `role:${x.run}:${x.dispatchId}`) ?? null;
  useCommandLayer("row.runs", {
    "runs.open": () => {
      const r = roleAt(selectedNow());
      if (r) app.dispatch({ type: "role", run: r.run, dispatchId: r.dispatchId });
    },
    "runs.cancel": () => {
      const r = roleAt(selectedNow());
      if (!r?.live) return;
      const target = `${r.run}/${r.name}`;
      const t = app.clock.now();
      if (!isArmed(app.getState(), "cancel", target, t))
        return app.dispatch({ type: "arm", what: "cancel", target, at: t });
      app.dispatch({ type: "disarm" });
      void app.effects.cancel(r.run, r.name).then(
        (msg) => {
          app.toast({ variant: "success", message: msg });
          polled.refresh();
        },
        (e: unknown) => app.toast(errorToast(e)),
      );
    },
  });
  if (!d)
    return (
      <Line
        width={props.width}
        parts={[
          {
            text: polled.error ? ` ${polled.error}` : " reading the session…",
            tone: polled.error ? "error" : "muted",
          },
        ]}
      />
    );
  const items: ListItem[] = [];
  const text = (key: string, parts: Part[]) =>
    items.push({ key, selectable: false, render: (_sel, w) => <Line width={w} parts={parts} /> });
  for (const r of d.runs) {
    text(`run:${r.id}`, runHeading(r, now, ui.plain));
    if (r.milestones.length)
      text(`ms:${r.id}`, [
        { text: "   " },
        ...r.milestones.flatMap((m, i): Part[] => [
          ...(i ? [{ text: "  " }] : []),
          m.landed
            ? { text: `${glyph("ok", ui.plain)} ${m.name}`, tone: "success" }
            : { text: `${glyph("waiting", ui.plain)} ${m.name}`, tone: "muted" },
          ...(m.what ? [{ text: ` ${m.what}`, tone: "muted" as Token }] : []),
        ]),
      ]);
    if (r.roles.length === 0) text(`none:${r.id}`, [{ text: "   no role has run yet", tone: "muted" }]);
    for (const x of r.roles) {
      const secs = x.live ? (now - Date.parse(x.since)) / 1000 : (x.secs ?? 0);
      const armed = isArmed(app.state, "cancel", `${x.run}/${x.name}`, app.clock.now());
      items.push({
        key: `role:${x.run}:${x.dispatchId}`,
        selectable: true,
        render: (sel, w) => (
          <Line
            width={w}
            selected={sel}
            parts={[
              { text: "   " },
              roleMark(x, ui.plain),
              { text: ` ${x.name.padEnd(15)} `, bold: true },
              { text: shortRung(x.rung).padEnd(19) },
              { text: x.status.padEnd(9), tone: x.live ? "info" : "muted" },
              { text: clock(secs).padEnd(7) },
              armed
                ? { text: "press ctrl+d again to cancel", tone: "warning" }
                : { text: x.lastEvent ?? "", tone: "muted" },
            ]}
          />
        ),
      });
    }
  }
  const s = d.session;
  const updated = app.state.paused ? "paused" : polled.at !== null ? `updated ${ago(now - polled.at)}` : "";
  return (
    <box flexDirection="column" width={props.width} height={props.height}>
      <Line
        width={props.width}
        parts={[
          { text: ` ${s.name}  `, bold: true },
          s.live
            ? { text: `${glyph("live", ui.plain)} live`, tone: "info" }
            : { text: `${glyph("dot", ui.plain)} idle`, tone: "muted" },
          { text: ` · ${plural(s.runs, "run")} · ${plural(s.liveRoles, "live role")} · `, tone: "muted" },
          { text: updated, tone: app.state.paused ? "warning" : "muted" },
          {
            text: polled.error ? ` · ${glyph("fail", ui.plain)} could not read it: ${polled.error}` : "",
            tone: "error",
          },
        ]}
      />
      <List
        items={items}
        selected={selected}
        onSelect={setSelected}
        width={props.width}
        height={props.height - 1}
        filter={null}
        empty=""
      />
    </box>
  );
}

function RoleView(props: { run: string; dispatchId: string; width: number; height: number }) {
  const app = useApp();
  const ui = useUi();
  const [selected, setSelected] = useSelection();
  const polled = usePoll(() => app.effects.role(props.run, props.dispatchId), RUN_EVERY_MS, {
    paused: app.state.paused,
    key: `${props.run}/${props.dispatchId}`,
  });
  useBack(true, "view", () => app.dispatch({ type: "up" }));
  const d = polled.value;
  if (!d)
    return (
      <Line
        width={props.width}
        parts={[
          {
            text: polled.error ? ` ${polled.error}` : " reading the role…",
            tone: polled.error ? "error" : "muted",
          },
        ]}
      />
    );
  const items: ListItem[] = [];
  const room = Math.max(10, props.width - 4);
  let n = 0;
  const line = (parts: Part[]) =>
    items.push({
      key: `l${n++}`,
      selectable: true,
      render: (sel, w) => <Line width={w} selected={sel} parts={parts} />,
    });
  const section = (title: string, body: string, none: string) => {
    line([{ text: ` ${title}`, bold: true }]);
    const lines = body.trimEnd() ? body.trimEnd().split("\n") : [];
    if (lines.length === 0) line([{ text: `   ${none}`, tone: "muted" }]);
    for (const l of lines) for (const w of wrap(l, room)) line([{ text: `   ${w}` }]);
  };
  section("BRIEF", d.brief, "no brief");
  section("REPLY", d.reply, d.state === "finished" ? "no reply" : "no reply yet: the role is running");
  line([{ text: " RECORD", bold: true }]);
  const r = d.record;
  if (!r) line([{ text: "   none yet: the role is running", tone: "muted" }]);
  else {
    const k = (x: number) => `${Math.round(x / 1000)}k`;
    line([
      { text: `   ${r.status}`, tone: r.status === "ok" ? "success" : "error" },
      {
        text: r.replyStatus
          ? ` · STATUS ${r.replyStatus}${r.replyWhy ? ` — ${r.replyWhy}` : ""}`
          : " · no STATUS",
      },
    ]);
    line([
      {
        text: `   ${clock(r.secs)} · ${k(r.tokens.input)} in (${k(r.tokens.cached)} cached) · ${k(r.tokens.output)} out`,
        tone: "muted",
      },
    ]);
    line([{ text: `   changed ${r.changedOwned.join(", ") || "nothing it owns"}`, tone: "muted" }]);
    if (r.violations.length)
      line([{ text: `   outside its lane: ${r.violations.join(", ")}`, tone: "warning" }]);
    if (r.thread) line([{ text: `   thread ${r.thread}`, tone: "muted" }]);
  }
  return (
    <box flexDirection="column" width={props.width} height={props.height}>
      <Line
        width={props.width}
        parts={[
          { text: ` ${d.name}`, bold: true },
          {
            text: ` ${d.role} · ${shortRung(d.rung)} · ${r?.status ?? d.state} · ${d.runTitle}`,
            tone: "muted",
          },
          {
            text: polled.error ? ` · ${glyph("fail", ui.plain)} could not read it: ${polled.error}` : "",
            tone: "error",
          },
        ]}
      />
      <List
        items={items}
        selected={selected}
        onSelect={setSelected}
        width={props.width}
        height={props.height - 1}
        filter={null}
        empty=""
      />
    </box>
  );
}

/**
 * Spec §4 (tab 3): the sessions, newest activity first; enter opens a session (its runs, milestones and roles,
 * live ones first), enter on a role opens it (brief, reply, record); esc goes back one level; p pauses.
 */
export function RunsView(props: { width: number; height: number }) {
  const app = useApp();
  const data = useData();
  useCommandLayer("tab.runs", {
    "runs.refresh": () => data.sessions.refresh(),
    "runs.pause": () => {
      app.dispatch({ type: "pause" });
      app.toast({ variant: "info", message: app.getState().paused ? "Updates paused" : "Updates resumed" });
    },
  });
  const { role, session } = app.state;
  if (role)
    return <RoleView run={role.run} dispatchId={role.dispatchId} width={props.width} height={props.height} />;
  if (session) return <SessionView sessionKey={session.key} width={props.width} height={props.height} />;
  return <SessionList width={props.width} height={props.height} />;
}
```


#### Modify `src/entry/tui/views/status.tsx`

```diff
--- a/src/entry/tui/views/status.tsx
+++ b/src/entry/tui/views/status.tsx
@@ -186,12 +186,14 @@ export function StatusView(props: { width: number; height: number }) {
               ? selectedCheck.id.slice("profile:".length)
               : null;
       if (name !== null) {
         showProfile(app, name);
       } else if (selected?.startsWith("run:")) {
+        // spec §4: a run opens in its session's screen, which shows it with the session's other runs
+        const row = runs.find((r) => `run:${r.id}` === selected);
         app.dispatch({ type: "tab", tab: "runs" });
-        app.dispatch({ type: "run", id: selected.slice("run:".length) });
+        if (row) app.dispatch({ type: "session", key: row.session });
       }
     },
   });
   return (
     <List
```


#### Modify `README.md`

```diff
--- a/README.md
+++ b/README.md
@@ -108,12 +108,14 @@ tests (CONTRIBUTING.md has the rest).
 
 ### The dashboard
 
 `catherd` opens three tabs: **1 Status** (every check with its fix; `y` copies the fix, `r` checks again),
 **2 Profiles** (one tree per profile: roles with their access, default rung, models and efforts, then routing,
-harness, budget, failover, timeouts and notify) and **3 Runs** (live roles, climbs, routes, the budget, landed
-milestones; `p` pauses). `catherd watch` opens it on Runs.
+harness, budget, failover, timeouts and notify) and **3 Runs** (the Claude Code sessions that drove your runs, newest
+first; a session opens on its runs, their milestones and every role with its rung, status, time and last event, live
+ones first; a role opens on its brief, reply and record; the open screen redraws as run files change; `esc` goes back,
+`p` pauses). `catherd watch` opens it on Runs.
 
 - `ctrl+p` lists every command with its key and CLI twin; `?` lists the keys that work where you are.
 - `ctrl+x` is the leader: `ctrl+x 1`–`3` tabs, `ctrl+x n` new profile, `ctrl+x l` profiles, `ctrl+x u` and
   `ctrl+x r` undo and redo, `ctrl+x q` quit.
 - Lists: arrows or `j`/`k`, `pgup`/`pgdn`, `home`/`g`, `end`/`G`, `/` to filter; `space` ticks, `enter`
```


#### Modify `docs/dev/ideas.md`

```diff
--- a/docs/dev/ideas.md
+++ b/docs/dev/ideas.md
@@ -7,64 +7,16 @@ into a spec or plan under `docs/specs/` or `docs/plans/` (or a GitHub issue) and
 Shipped in 1.0, so not re-proposed here: `catherd doctor`; the harness-cost line in `runs_summary` and the final
 report; quota failover (the profile's `failover` map); the `preflight` tool; per-repo knowledge
 (`<data>/repos/<slug>-<hash8>/knowledge.md`, read with `read_knowledge`, appended by `land`); the run budget (from 80 %
 `route` starts at the cheapest rung that clears the bar; once spent, `E_RUN_BUDGET` pauses the run); the trimmed catalog (`catalog/models.json`, `scores.json`, `jev.json`); a plan in hand (a `plan:` A-line: no dossier, the architect translates); lint and type check in each lane's fast check; `status` showing the run's native and isolated dispatches, with the harness figure compared within one repo; and a sure Jev kind kept when its difficulty is unsure (`source: "jev-kind"`).
 
-## Push results to the main thread, drop `wait` (designed 2026-09-28)
-
-_Why:_ `wait` fixed serial dispatch but blocks the main thread: an MCP call does not background, so the session freezes
-until the lanes finish, and the user cannot even ask how it is going. Claude Code sessions have a peer inbox (a Unix
-socket, `.workspace/references/claude-code-cross-session-messaging.md` in agora); catherd can use it to tell the main
-thread a role finished, the way native subagents do. Every decision below was settled with the user in a grilling
-session; the facts were verified in the 2.1.283 binary.
-
-Facts it rests on:
-- The receiver treats a message as self-sent when its own pid is an ancestor of the sender (a `ps -o ppid=` walk, 10
-  levels, 32 on retry; macOS). The plugin's MCP server is a direct child of the session, so its messages pass with no
-  `crossSessionInbound` setting. The detached supervisor (ppid 1) does not.
-- MCP children get `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_HOST_SESSION_ID` and `CLAUDE_CODE_MESSAGING_SOCKET`; the
-  session file `~/.claude/sessions/<pid>.json` gives its name.
-- `priority`: `later` waits for the turn to end (native task notices use it), `next` drains at the next tool round,
-  `now` aborts the turn.
-
-Design:
-1. **Disk stays the source of truth.** The supervisor writes the record as today; each record is delivered once by its
-   collect marker. A message only announces it.
-2. **The MCP server sends.** It watches the records of the roles it dispatched and sends one message per finished role
-   over `CLAUDE_CODE_MESSAGING_SOCKET`; roles that finish within about 3 s of each other share one message. On start it
-   sends for any unread record of its session's runs.
-3. **The message.** First line self-contained, e.g. `catherd · M2.L1 worker · sol#medium · ok · complete · 1m51s · 3
-   files`; then the worker's reply, capped at about 2 KB; then a pointer to `result(run, name)`.
-4. **When.** Every end (ok, failed, limit, timeout), plus two mid-run events: the supervisor sees a stall, or a limit
-   moved the role to its failover rung. No progress lines; `peek` has those.
-5. **Priority.** Normal ends go `later`; blocked, stalled and limit messages go `next`; never `now`.
-6. **Which session.** `dispatch` records `CLAUDE_CODE_SESSION_ID`. The message goes to the live session with that id,
-   found by id, not pid; a run continued in another session (it called `run_start` or `peek` for it) moves delivery
-   there. With no live session the record stays unread for the next `peek` or `run_start`; phone pushes follow the
-   profile's notify moments as today.
-7. **Tools.** `wait` is removed. New `peek(run?, name?)`, non-blocking: each live role with elapsed time and its last
-   event (last command or message), plus finished records not yet read. `result` stays for a full record.
-8. **Skill.** After dispatching independent roles, write one status line and end the turn; results arrive as messages,
-   to be treated like native subagent notices. Never sleep, loop or poll `peek`; call it when the user asks how it is
-   going or a decision needs the others' state. Native Claude roles (architect, verifier) keep their own notices.
-9. **Settings.** `init` does not touch `crossSessionInbound`. `doctor` sends a test message from the MCP server to its
-   own session and reports whether it arrived.
-
-## Runs page by main-thread session (designed 2026-09-28)
-
-_Why:_ one `/catherd` job (the whole auth build) became several runs, one per milestone and worktree, listed flat. The
-user wants to open the session that drove the job and see every role, where it is, past runs and milestones, updating
-in place.
-
-- The run stays the unit (parallel runs in separate worktrees are needed). `run_start` stores the session id, host id
-  and name in `meta.json`; the runs page groups by session first: session, its runs, their milestones, their roles.
-- A run continued from another session stays under the one that started it, marked "continued in X", and shows as a
-  link under the second.
-- The session's name is read live from its session file (so a renamed Desktop session renames here), else the last
-  stored name.
-- The page watches the data folder and redraws when a record or state file changes; live roles' elapsed time ticks
-  every second, with each role's last event from `peek`'s source.
+## Picked up
+
+- **Push results to the main thread, drop `wait`**, and **the runs page by main-thread session** (both designed
+  2026-09-28): now spec 1.1 §3 and §4, built by `docs/plans/2026-09-28-10-push-sessions.md`. The facts they rest on
+  are in `docs/research/2026-09-28-cross-session-messaging.md`, which corrects two of the first notes: the self-sent
+  rule runs on Linux too (a `/proc` walk), and `CLAUDE_CODE_HOST_SESSION_ID` is set only by a host (Desktop).
 
 ## 1.1.0 scope, settled (grilled 2026-09-28)
 
 Written up as `docs/specs/2026-09-28-catherd-1.1-design.md`, which governs where the two differ.
 
```

- [ ] **Step 4: Run the gate**

Run: `bun run format`, then regenerate the frames: `bun test test/entry/tui/frames.test.tsx --update-snapshots && bun run tui-frames` (the snapshot file drops the old `run` story's 6 frames, redraws the `runs` story's 6 and gains 24 for the four new Runs stories: 84 frames in all; `docs/tui-frames.md` ends with the five "Runs: …" sections), then the gate. Expected: clean; `bun run tui-frames` again changes nothing. Scratch count after this task: 1257 pass, 10 skip, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(tui): the Runs tab by session: sessions, a session's runs and roles, a role; live redraw"
```

---
