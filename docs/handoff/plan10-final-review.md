# Final whole-branch review: plan 10 (push, sessions), 4b8d460..ac213b3

Reviewer: final whole-branch seat (superpowers `requesting-code-review/code-reviewer.md`), read-only, no subagents.
I read the diff in passes. First the services and infra at HEAD, whole files: `dispatch-service.ts`, `notifier.ts`,
`sessions.ts`, `reconcile.ts`, `peek.ts`, `session-view.ts`, `runs-page.ts`, `doctor-push.ts`, `peer-inbox.ts`,
`claude-session.ts` and `notice.ts`. Then the diffs of `run-service.ts`, `dispatches.ts`, `dispatch-dir.ts`,
`finalize.ts`, `admission.ts`, `supervisor.ts`, `env.ts`, the MCP entry files, `runs-command.ts`, the TUI effects
and data provider, and the fix-B commits. Last, the test helpers, the env handling in the stdio, doctor and
pack-smoke tests, and the skill's word diff. I did not read the TUI snapshot file, and I did not re-run the gate.
`gate2.log` shows 1271 pass / 0 fail at ac213b3, and the ledger records CI green, macOS included, at 0eefeb4.

### Strengths

- **Disk stays the truth.** The design holds this end to end. `sendToInbox` never throws and returns an outcome
  (`peer-inbox.ts:40-92`). `notified.json` is written only after `sent` (`notifier.ts:161-170`). The collect mark
  goes only through `result` and `cancel`, under the existing lease (`run-service.ts:120-124`). A notice is checked
  again with `due()` just before it goes, so a record read in the meantime is never announced as stale
  (`notifier.ts:153,179`). I found no path where a message failure loses a record.
- **Failover runs once per limited dispatch.** `settle` wraps it in `failover.lock`, writes `failover.json`, and
  reuses an admitted but unlaunched stand-in (`dispatch-service.ts:265-321,380-393`). A second settle from another
  process, from a claim, or after a restart is therefore harmless.
- **The fix round's ownership rule is coherent.** Stand-ins start on their own only for a run this session owns,
  and a claim takes over the leftovers (`reconcile.ts:52,91-121`, `dispatch-service.ts:202-222`). Together these
  close the batch 1 Important (surprise stand-ins) and the batch 2 I2 (adopt skipped finished-unrecorded
  dispatches) with one rule.
- **Locks are consistent.** `claimRun` writes `state.json` under the same `withFileLock(stateJson)` as
  `refreshState`, and the notes schema is loose, so `owner` survives every refresh (`state.ts:14,41,93`). No lock
  is held across `claim`'s settles, so there is no nested-lock deadlock.
- **Hook isolation.** A throwing settled or stall hook is logged and skipped. The notifier's delivery chain now
  has a `.catch` (`notifier.ts:136-140`). A stall write goes through `stallPoll` inside `waitForFinish`'s guarded
  `onPoll`.
- **Test safety is done properly.** `withHome()` deletes the four session variables and points `CLAUDE_CONFIG_DIR`
  at the test home. The stdio test builds its server env after `withHome()` and gives the server a fake inbox.
  `pack-smoke.ts` blanks the socket and the token. `doctor-command.test.ts` spawns under `withHome()` with an
  explicit env. Only `startMcpServer` starts a notifier. I found no path by which the suite messages a real
  session.
- **Layers are respected.** `domain/notice.ts` imports nothing. `infra/peer-inbox.ts` uses only `node:net`.
  `infra/claude-session.ts` uses only `infra`. `services/ports.ts` takes a type from `infra`. `peek` →
  `notifier` → `dispatch-service` has no cycle.
- **Docs are consistent.** Outside archives, plans, the spec's own history and the 1.0 section of `MIGRATION.md`,
  nothing tells a user or the orchestrator to call `wait`. `test/skills.test.ts` forbids the mention. The skill's
  resume path (`peek(run)` once, which claims the run) matches the claim design.
- **The TUI fixes are sound.** The sessions poll is `off` away from the list, the cursor is kept by key, the watch
  uses the real path and has a `stopped` guard, and the macOS FSEvents failure is fixed. All of it is tested
  through fakes, with no sleeps.

### Issues

#### Critical (Must Fix)

None.

#### Important (Should Fix)

1. **A cancel from the dashboard or the CLI is never announced, so the orchestrator waits for a message that
   never comes.**
   - File: `src/services/dispatch-service.ts:505-507` (`cancel` always marks the record read). It is reached from
     `src/entry/tui/effects.ts:281-282` (ctrl+d twice on the Runs tab) and `src/entry/runs-command.ts:244`
     (`catherd runs cancel`).
   - What's wrong: `cancel` does `tryCollect` + `endCollect` whoever calls it. The MCP server's watcher then
     settles the cancelled dispatch. The notifier either skips it at enqueue (`!awaitsCollect`,
     `notifier.ts:175`) or drops it at delivery (`due()`, `notifier.ts:179`). Spec §3.6's table says a role that
     ends `cancelled` is sent at `later`.
   - Why it matters: under 1.1's skill the orchestrator dispatches and then **ends its turn**. When the user
     cancels a stuck role from the dashboard, the session is never told. The run stalls silently until the user
     prods it. This regresses from 1.0, where the blocked `wait` saw the role leave `running`. Plan Ruling 6
     ("`cancel` marks its record read too") was written for the MCP `cancel`, where the caller holds the record,
     and does not consider the other callers.
   - Fix: mark the record read only when the MCP tool cancels. For example, `cancel(deps, run, name, { read })`
     with `read: true` from `dispatch-tools.ts` only. The TUI and CLI then leave the collect mark, and the
     notifier announces "cancelled" to the owner. Add a notifier test: cancel without `read`, and one `later`
     notice arrives.

#### Minor (Nice to Have)

1. **A takeover through `dispatch` never announces records that finished before it.**
   - File: `src/services/dispatch-service.ts:202-222`.
   - `claim` settles only finished-unrecorded dispatches and unsettled limits. A record the earlier owner's server
     (or this server's reconcile, while the run was still someone else's) already settled but never announced is
     not queued. Examples: an `ok`, or a limit already failed over.
   - `peek(run)` lists them, and the skill says to call `peek` once on resume, so nothing is lost. A takeover
     that starts with `dispatch` still hears nothing about them.
   - Cheap fix: a `claimedHooks` set that the notifier uses to run its `scan` for that one run.
2. **Outside Claude Code, a limit left after a restart is never failed over, and `result` then consumes it.**
   - Files: `src/services/reconcile.ts:91,101,111`, `dispatch-service.ts:203`, `run-service.ts:120-124`.
   - With no session, `ownsRun` is false (so reconcile only records the limit), `claim` returns at once (so
     `peek` and `dispatch` never settle it), and `result` marks it read, returning only
     `limit: … hit a usage limit`. No stand-in starts and no pause is written.
   - The ledger's fixer-A ruling says these limits "wait for result/peek". Neither settles them. Please correct
     the ruling's wording, or treat "no session" as owning its runs (1.0 behaviour), if the owner wants
     non-Claude-Code MCP clients covered.
3. **`catherd doctor`, run from a Claude Code session, starts an MCP handshake server that believes it owns that
   session's runs.**
   - Files: `src/infra/env.ts:8-12` scrubs the socket and the token but not `CLAUDE_CODE_SESSION_ID`, and
     `src/infra/claude-session.ts:182` matches the live session by that id.
   - The handshake child's `reconcileAll` therefore sees `mine = true`. It settles, and fails over, that session's
     unsettled limits, then is killed when the handshake ends. The failover machinery recovers from that (Ruling
     5), so the practical harm is a stand-in started from a doctor run.
   - Scrubbing `CLAUDE_CODE_SESSION_ID` and `CLAUDE_CODE_HOST_SESSION_ID` from every child would also settle the
     ledger's live-verification item about headless `claude-code` workers inheriting the parent's session id.
4. **`admit`'s `finalizeFinished` records a finished dispatch without settling it.**
   - File: `src/services/admission.ts:165`.
   - When no watcher in this process covers a dispatch in an owned run (the watcher's finalize threw, say), the
     next `dispatch` writes its record with no settle. There is no notice, and a limit gets no failover until the
     next server start.
   - Rare. Settling what `finalizeFinished` records would close it.
5. **`peek(run)` on an old run can start workers.** A claim settles unread limits that were never failed over,
   whatever their age (`dispatch-service.ts:215-221`). A user who peeks at a stale run from a new session gets a
   stand-in launched. This follows the fix-round ruling. Consider an age bound, or skipping runs without
   `startedBy`.
6. **Envelope neutralising is case-sensitive.** `src/domain/notice.ts:58` rewrites only lower-case
   `cross-session-message`. Use a case-insensitive replace. Whether the receiver's parser is case-sensitive is in
   "Declined to judge" below.
7. **`state.md`'s `Next: wait for <names>; then …`** (`src/domain/state.ts:30`) still uses the word "wait" beside
   the removed tool. `peek` returns it as `next`. Consider "running: <names>".
8. **Docs pending for later plans.** `MIGRATION.md:66` (1.0 section, "the new `wait` returns the records") needs
   the 1.1 section spec §13 calls for. `docs/dev/live-verification.md` has no push check yet (spec §15). Both
   probably belong to plan 12. Confirm they are tracked.

### Deferred minors: triage

| Source | Item | Verdict |
|---|---|---|
| batch3 #2 | `supervisor.ts:239`: the advisory `stall.json` write sits inside supervision's `try`. A throw sets `reason = "lost"` and kills a healthy worker. | **Fix before merge.** One try/catch. An advisory notice must never end a worker. |
| batch4 #4 | `test/services/session-view.test.ts:38-39` back-dates the wrong files (`ledger`, `meta`), not those `runActivity` reads (`agents`). The ordering assertion passes only by creation order and can tie on a coarse-mtime filesystem. | **Fix before merge.** It is a flaky-test risk on the macOS/Linux matrix, and the test does not pin what it claims. |
| batch2 #1 | `sessions.ts:76-79`: the `sessions.jsonl` append sits outside the `state.json` lock. | **Fix before merge (cheap).** Since fix round 1, the trail's last row decides the "current owner" in `session-view.ts:106`, so trail order is load-bearing. Move the append inside the lock. |
| batch3 #1 | `supervisor.ts:231`: `stallChecked` is not reset when a full-idle check finds the worker busy. | Should fix, one line. It can ride with batch3 #2. |
| batch1 #2, #3 | `result` hints depend on read order. A limit read before its settle is never failed over (Ruling 7). | Defer. It is a ruled cost. See Minor 2 for the no-session variant. |
| batch1 #1 | Double settle of a stand-in in one process. | Resolved: the notifier dedupes by `queue.has` and `notified.json`, and failover by its lock. |
| batch1 #4, #6, #7 | Peer-inbox test title; the 2,000-character cap plus its suffix; noisy gate log. | Defer. |
| batch1 #5 | SKILL.md "Wait for it". | Fixed in ac213b3. |
| batch2 #2-#6 | Registry re-reads; ownership moves on a refused dispatch; the dispatch-path adopt branch is untested; `idle()` has no deadline; import order. | Defer. #4 is worth a test when Important 1 is fixed. |
| batch3 #3-#6 | Stale catch comment; `codexActivity` computed twice; `"edit "` with no paths; Claude tool activity shows only the name. | Defer (polish). #5 is a one-liner if someone is in the adapter. |
| batch4 #1, #2 | Doctor: a gone socket reported as `failed`; hard-coded settings path. | Fixed in cd06aea. |
| batch4 #3, #5-#8 | Transcript re-read; activity ignores events; heading comment; `runs list` wasted work; `printStatus` drops an unreadable run. | Defer. |
| batch5 #1, #5 | `r` re-reads only the list; a watch event after stop. | Fixed in 16c65bd and 0eefeb4. |
| batch5 #2, #3, #4, #6 | Extra reads on toggle; the role screen polls a finished role; the recursive watch test is weak; Status opens a session on its first role. | Defer. #4 was strengthened in 0eefeb4 (a burst including a new subfolder). |

### Declined to judge

- **Live delivery into a real Claude Code session** on macOS and Linux: the self-sent rule, `/proc` versus `ps`,
  and the 150 ms close. This needs the owner's `bun scripts/spike-push.ts` run (Owner question 2).
- **Whether `claude --resume` keeps the session id.** If it does not, a resumed session owns nothing until it
  calls `peek` or `dispatch`, and the start scan announces nothing. Spec §3.4's restart example assumes it does.
- **Behaviour after `/clear`.** The owner stays the pre-clear id. Notices for roles dispatched before `/clear` are
  therefore dropped until the new conversation claims the run. This is spec-consistent (§3.3), but whether the
  owner wants the same socket to count as the same owner is a product call.
- **Headless `claude-code` workers inheriting `CLAUDE_CODE_SESSION_ID` / `HOST_SESSION_ID`.** What Claude Code
  does with an inherited id needs a live check (already on the ledger's live-verification list).
- **Whether Claude Code's envelope parser is case-sensitive** (Minor 6), and whether a worker's reply, delivered
  as user-role content, can be used for prompt injection beyond what the skill's "not the user's approval" line
  covers.
- **macOS FSEvents behaviour beyond CI**, for example network disks and very deep run trees.
- **The TUI snapshot file**, skipped as instructed. The stories and the rendered frames are not re-reviewed.
- **The full gate.** I did not run it. I relied on `gate2.log` at ac213b3 and the ledger's CI record.

### Recommendations

- Fix Important 1 together with batch3 #2 and #1, batch2 #1 and batch4 #4, as one small fix wave. Each needs a
  test that fails first. The re-review can stay scoped to `dispatch-service.ts` `cancel`, `supervisor.ts`,
  `sessions.ts` and `session-view.test.ts`.
- Correct the fixer-A ruling's wording in the ledger (Minor 2) so the owner sees the real cost.
- Consider extending Ruling 11 to the session id variables (Minor 3). It is one set entry and removes two
  unknowns.

### Assessment

**Ready to merge?** With fixes

**Reasoning:** The settle, claim, notifier and reconcile interplay is idempotent across processes and restarts,
disk stays the truth, the layers are clean, and no test can reach a real session. One user-visible gap remains: a
cancel from the dashboard or the CLI is silently dropped from push, against spec §3.6, and leaves the orchestrator
waiting. Three cheap deferred minors should also land before merge: the stall write can kill a worker, the
session trail is appended outside the lock, and the session-view test back-dates the wrong files.
