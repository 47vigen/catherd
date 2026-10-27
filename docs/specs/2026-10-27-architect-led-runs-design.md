# catherd 2.0, continued: architect-led runs

Date: 2026-10-27. Status: draft for the owner's approval. Part of 2.0: 2.0 has not reached `latest`
(`latest` is 1.5.0; 2.0 ships only as `next` snapshots), so this design lands inside 2.0 before its release. Binding where it differs from the 2.0 spec
(`2026-10-12-catherd-2.0-design.md`) and the decision-model spec (`2026-10-26-decision-model-design.md`); both stay
binding elsewhere until the deletions below land.

Builds on plan 45 (branch `outcome-gates`, the bridge). Plan 45 already removes file-ownership enforcement (workers
report changes outside their lane), adds the run-wide team channel (`team_send` / `team_read` / `team_wait`; notices
by default; live steer for opencode and Claude, from the architect or the owner only), deletes wall and process text
from role contracts and lane files, makes the gates outcome-only, lets the architect edit plan, tasks and lanes
mid-run, fixes `pickLevel`, dedupes fix-round bullets, and retires the Cursor backend. Nothing here redoes that.

## Intent

The owner's diagnosis of 2.0: **"we turned runs into a pipeline, and in between we kill everything."** The work
inside the nodes is good (output quality was good in all 14 measured runs); the time goes to the transitions between
them. This design removes the fixed pipeline. The architect drives the run as its brain. catherd keeps only what a model
should not do: run processes, hold worktrees and locks, write the event log, enforce caps and safety stops, and do
the mechanics of merging and pushing.

## Baseline: what 14 runs measured (the shared run host, 2026-10-25..27)

Every decision below names the measurement it answers, by the tag in brackets.

| Tag | Measured |
|---|---|
| [idle] | 3,361 min wall. One role running 52% of the time, none 36%. Average concurrency 0.7–0.94 on the big runs; peak 4–6. |
| [check] | Milestone Check ~35% of wall (P8: 259 of 735 min), rerun in full after every round. |
| [rerun] | Auto-rerun of a red Check (`milestone-check.ts:243-247`) stayed red 19 of 22 times: 149 min. |
| [baseline] | Baseline Check on the base: ~115 min. |
| [barrier] | Each review round is a barrier: ui-reviewer 136 vs reviewer 59 min over 26 pairs, 81 min waiting on it alone; 17 of 26 ui-reviews found no bug. |
| [blocked] | Workers: first build 516 min, blocked or failed 448 min (48 dispatches), rework 349 min. check_broken 177 min ×24, needs_user 106 ×12, out_of_scope 65 ×5, no_access 26 ×4. |
| [retry] | Retrying a blocked lane on the same cause with no new information: ~240 min (M1.L5 17+35+35 min, done in 1 min after a ruling; `run-state.ts:829`). |
| [land] | Two landing parks per milestone ("push", answered "push" 34/34; "merged: MR !N"): ~94 min. E_LAND_GATE refusal 26 min. All 7 ask_owner questions answered yes, 4 of them file or scope permissions. Real worker questions ~2 min in total. |
| [preflight] | 5 parks for "task has neither signature nor Test:" (`plan-doc.ts:133-138`, `preflight.ts:334`); 6 architect reformat dispatches. |
| [plan-input] | The architect could not change the plan input: a two-line pin bump took 156 min (`plan-doc.ts:117-133`). |
| [acceptance] | The trailing acceptance milestone: 676 min wall for 173 worker min over 4 runs; the verifier reran what the Check had run. |
| [tick] | Admit-order refusals waited on a 5-minute tick (`REFUSAL_WAIT_MS`, P8 M4.L6 decision→start 606 s). |
| [rolelock] | The machine-wide verifier role lock turned a 10-minute cross-run wait into a FAIL. |
| [walls] | Editing an unowned test fails the attempt and orders a restore (`run-state.ts:1134`) → check_broken → judge → cold redispatch. `foreignFailure` blames the worker for shared tests and lint. Parallel lanes waiting on each other's symbols (P6 M50.L3: 6 dispatches in 3 min). Workers cannot commit, so HEAD-reading checks never see their work. |
| [audit] | About half the verifier FAILs were process audits (commit subjects, TDD red proof, change scope) or lock and timeout noise. |
| [judge] | Judge: 54 dispatches, ~35 min, never filtered a finding (61 routed, 0 dismissed). 9 rule reviews proposed 54 rules, 74% restrictions; the one accepted rule (GOCACHE in tree) made checks 30–88 min. |
| [decision] | Decision-model confidence did not predict success (p ≥ 0.9 → 77% complete; coverage < 0.5 → 76%); the first pick finished 65%. Static: flash-class workers 95% ok at ~$0.01; sonnet#high the slowest and dearest worker; sonnet verifiers mostly judged from the tree without running anything. |
| [dupes] | Two reviewers on P8 M3 reported the same 8 findings. |
| [round-cost] | A fix round's bullets repeat every file the check output named: 46 bullets, 81 KB, one root cause. |
| [box] | Box contention real in ~2 windows (two runs at once), ~3–5% of wall. Flaky dispatches: 2%. Briefs are 90–98% cached, so tokens are not the time sink. |
| [chain] | The private-media chain (6 runs, ~10 h) came from a plan-input design merged before its consumer's acceptance, and from single-repo runs forcing a pin bump per fix. |

The sources behind the shape are in `/.workspace/references/catherd-graph-loop-2026-10-27.md` (agora): Magentic's
task and progress ledger with stall counters; Claude Code dynamic workflows; CAID (isolation per writer, merge with
tests, replan from the current code); Cursor's scaling report (locks made 20 agents perform like 2–3); CooperBench
and the completed-change-notice result (narrow notices help, open chat hurts); Anthropic on grading the product, not
the path, on one final evaluator, on effective harnesses (a small machine-readable state file), and on auto mode
(users accept 93% of permission prompts).

## Owner decisions (binding)

| # | Decision |
|---|---|
| O1 | The redesign removes the fixed pipeline. "We turned runs into a pipeline, and in between we kill everything." |
| O2 | The architect is the brain of the run and may do anything: plan, delegate, choose who runs what on which model, read reports, replan mid-run, decide when to check, review and land. It reports what it changed and why. |
| O3 | Agents work freely and report what they changed and why. No line-drawing. Talk between agents is allowed; its default content is change notices and questions to the architect. Steer comes only from the architect or the owner. |
| O4 | Gate only the final product: behaviour, tests, build, acceptance. Never commit shape, TDD evidence or file scope. One mechanical exception only if the evidence demands it (D9). |
| O5 | The judge role goes; its jobs move to the architect. The decision model goes: the architect picks rungs from the profile's allowed list; static role ladders are the default; escalation on observed failure. |
| O6 | Push the feature branch without asking. Ask the owner once, at the end, for the merge. Stop only for production, secrets, irreversible shared-state actions, and "stuck / impossible". |
| O7 | "The box is slow" is never accepted without hard proof. Prefer deleting mechanisms over adding them. Cursor is retired. |
| O8 | The researcher and the writer are standing roles, on hand at any moment, above all for the architect (D12). |
| O9 | Honcho memory comes back for every catherd role as a principled knowledge base, without repeating the mistake that turned it off (D14). |

## Decisions

### The architect drives the run

**1. The architect runs as event-woken turns on a resumed thread, with a ledger as its memory.** (answers [idle],
[retry], [judge]; O1, O2)

Options:

- **A. One long-lived session for the whole run.** Simplest to describe. It is what 1.x did with the conductor, and
  the 2.0 spec recorded the result: when the session is compacted or closed, the loop stops. A run is 3–12 hours;
  no backend holds that in one context. Rejected as the primary mechanism.
- **B. Re-invoked turns over a ledger (Magentic).** The daemon wakes the architect on an event; the architect reads
  the ledger and a digest of what changed, acts through tools, and ends its turn. The ledger is the state; the
  session is only a cache. Survives restarts and compaction by construction.
- **C. The architect writes a replayable orchestration script (dynamic workflows).** Edges become free code and the
  run replays deterministically. But every replan means rewriting the script, a red check or a report still needs a
  model to read it, and catherd would grow a script runtime and API to maintain. It adds a mechanism (O7) to solve a
  problem B already solves. Rejected.

**Chosen: B, with the thread resumed when possible.** Each wake is a turn on the architect's thread
(`--resume` on Claude Code, the Codex thread, the opencode session), so the prompt cache and the architect's own
reasoning carry over. The ledger makes the thread disposable: on a daemon restart, a dead process, a context near
its limit (the adapter's reported usage past 70% of the model's window), or a rung change, the daemon starts a fresh
thread whose first message is the ledger plus the event digest since the last ledger write. Nothing is lost that
the ledger did not hold, so the architect is told to keep the ledger current.

- **Wake events.** A task finished, stopped or asked a question; a check finished; a merge finished or conflicted;
  a stall was detected (D10); a cap is near (80%); the owner sent a message or an answer; idle (D10). Events that
  arrive while a turn runs are queued and delivered together as the next turn's digest. The architect never polls:
  as in T3's `task_status` contract, it ends its turn and the completion wakes it.
- **The digest.** One block per event, short: who, what, outcome, the report path, changed files, and the free
  writer slots. Reports and logs stay in files; the architect reads them with `read_run_file` only when it needs
  to. This keeps a ten-hour run's architect context small.
- **Free slots are named.** Every digest ends with the number of writers running and the writer cap, so an idle box
  is visible to the one role that can fill it ([idle]: concurrency below 1 while the cap was 4–6).
- **Cost.** The architect is called more often than the 2.0 judge (every wake, not only on unexpected cases). With
  cached briefs ([box]: 90–98% cached), a turn costs one prompt's increment. The judge's ~35 min and 54
  dispatches, the decision model's calls, and the reformat dispatches go away in exchange.

**2. The ledger is a small task list and a progress log the architect owns.** (answers [plan-input], [preflight])

Its rows live in the D13 database and are written through the `ledger` tool; after each change the daemon renders
them read-only into the run dir as the two files below, so every role reads them as files.

- `ledger/tasks.json`: the task list. Each task: `id`, `goal`, `state` (`todo | running | review | done | blocked |
  impossible`), `assignee` (the task id of the dispatch working it), `attempts` (rung and outcome per attempt),
  `blocks` (stall fingerprints, D10), `depends` (task ids), optional `oracle` paths (D9). The daemon updates
  `state`, `assignee` and `attempts` from dispatch events; only the architect rewrites `goal`, `depends`, `oracle`,
  or adds and removes tasks. A worker cannot rewrite the list (the "may flip pass/fail but not rewrite" pattern).
- `ledger/progress.md`: the architect's log, newest last, one entry per turn: what it did and why. It is capped
  (the rendered file shows the last 40 entries; older ones stay in the database and in `progress-archive.md`).
- `plan.md` and the lane files stay as the architect's documents; plan 45 already lets it edit them mid-run, and the
  plan input (`plan:` paths) becomes an ordinary input the architect may edit too. Preflight no longer parks: plan
  lint runs once when the run starts and its findings go into the architect's first digest as warnings.

**3. The architect's tool surface is T3's orchestration contract, ported, plus five catherd tools.** (O2)

T3 Code's orchestrator and thread toolkits (MIT) are the model: delegate a task with only its brief, read its status
when woken, send and read messages by thread, cancel. Names drop T3's `t3_` prefix. The architect MCP server is a
new role server profile on `src/entry/mcp/role-server.ts`; every call takes a `why` (one line), which goes into the
event and from there into the MR's audit section (O2: it reports what it changed and why).

| Tool | Contract |
|---|---|
| `capabilities` | Roles, each role's allowed rungs (ordered, with the ladder default marked), backend health, quota holds, caps used and left, writer slots. Read-only. Like T3 `orchestrator_capabilities`. |
| `delegate_task` | `{role, task, rung?, worktree?: "new" \| "task:<id>" \| "integration" \| "none", from?, ledgerTask?, why}` → `{taskId, thread, reportPath}`. Starts one dispatch with only `task` as its brief (role text and team are added by catherd). No `rung` = the role's ladder default (D7). Returns at once. |
| `task_status` | `{taskId}` → `workState` (`working \| waiting \| stopped \| done`), the reply's summary (≤ 2,000 chars), `reportPath`, changed files, stop reason, cost. Reading a finished task marks it delivered. |
| `task_cancel` | `{taskId, why}`. Stops the dispatch and its children; a finished task keeps its result. |
| `thread_send` | `{to: taskId \| role \| "all", text, mode?: "auto" \| "queue" \| "steer" \| "restart", why}`. `auto` steers a running thread where the backend allows it (plan 45: opencode, Claude), else queues for its next turn; a send to a finished task resumes its thread as a new task and returns the new `taskId`. Built on plan 45's `team_send`. |
| `thread_read` | `{from?, since?, limit?, maxChars?}`: the run's team channel, paged. Built on `team_read`. |
| `thread_wait` | `{taskIds, timeoutSec ≤ 300}`: returns at the first to finish. For a short join inside one turn only; the default is to end the turn. |
| `check` | `{ref, scope?: "fast" \| "full" \| <named command>, base?: boolean, why}` → `{checkId}`. The daemon runs it under the heavy lock (D5) and wakes the architect with the result. |
| `merge` | `{taskId, why}`: merge that task's branch into the integration branch (D4). Conflicts go back as an event. |
| `ledger` | `{tasks?: patch, progress?: text, why}`: edit `tasks.json` and append to `progress.md`. Plan and lane files are edited with `write_run_file`, as plan 45 allows. |
| `land` | `{final?: boolean, why}`: push the feature branch and open or update its MR (D11). `final` also asks the owner for the merge. |
| `ask_owner` | `{question, options?, scope: "task:<id>" \| "run", why}`: parks only that scope. Refused unless the question falls in an O6 stop class (production, secrets, an irreversible shared-state action, stuck or impossible); a refusal says so and the architect decides. |
| `finish` | `{verdict: "done" \| "impossible" \| "stopped", why}`: ends the run with its report. |

The architect also gets `memory_search` and `memory_chat` (D14). Reviewers, the verifier, the researcher and the
writer are not separate tools: they are `delegate_task` with that
role. The architect also keeps `read_run_file`, `read_knowledge` and `write_run_file`.

The architect's access becomes `workspace-write` on the integration worktree. It may make a small change itself (the
two-line pin bump of [plan-input]) when that is faster than a dispatch; its commits go through the same `merge` and
check path as anyone's. It is told to delegate anything larger.

### What the daemon keeps

**4. The daemon supervises, merges and enforces; it stops deciding.** (O1, O7)

Keeps:

- **Process supervision.** The detached supervisor, heartbeats, revival, transport holds, quota failover to another
  provider of no lesser intelligence (2.0 decision 6: availability, not difficulty).
- **Worktrees** (D6) and **merges** into the integration branch.
- **The heavy-command lock and the load gate** (`src/infra/heavy-lock.ts`), for checks and heavy builds.
- **The event log** (the `events` table, D13) and replay. State is rebuilt by replay, as in 2.0 decision 2.
- **Budgets and caps** (D10), **stall detection** (D10), **safety stops** (O6).
- **Landing mechanics**: push, MR create and update, the audit section (D11).
- **The wake queue** (D1) and the session-facing tools (`run_start`, `status`, `answer`, `cancel`, `result`,
  `profile`) unchanged.

Stops deciding: which role runs next, on which rung (beyond the ladder default, D7), when to review and with whom,
how to triage findings, whether a block is the rung's fault, when a milestone is ready, the admission order of
lanes, when to fix or land, which rules to add, and whether a plan is well-formed enough to start. All of that is
the architect's.

The state machine shrinks to a reducer over dispatch, check, merge, wake and cap events. `next(state, event) →
actions[]` stays as the pattern (pure, replay-tested), but its actions are only: run a dispatch the architect asked
for, run a check, run a merge, wake the architect, apply a cap or stall stop, push. There are no milestone or round
transitions in it.

### Worktrees

**5. One worktree per writer, merged into an integration branch with a fast check.** (answers [walls], [blocked],
[check]; O3)

Options:

- **A. Shared milestone worktree with change notices (2.0 + plan 45).** No merge step, no extra disk. But every
  measured wall lives here: a sibling's half-written test fails your check ([walls], and commit 6c08f862 "never
  blame a lane for a running sibling's test edits" is still patching it), shared lint and format failures are
  nobody's and everybody's ([blocked]: check_broken 177 min ×24), and workers cannot commit, so a HEAD-reading check
  never sees their work. CooperBench measured a shared workspace without isolation as worse than one agent. Plan 45's
  notices soften this; they do not remove the cause.
- **B. One worktree per writer, merge on completion with tests (CAID).** Each writer has its own branch and tree,
  commits freely, and its fast check sees only its own work on top of the integration branch it started from. The
  daemon merges a finished task into the integration branch after that task's fast check passes on the merged
  result. The cost: disk per tree, dependency install per tree, a cold build cache per tree, and merge conflicts.
- **C. Isolation only for lanes the architect marks risky.** Two code paths for one problem. Rejected (O7).

**Chosen: B.** The costs are paid this way:

- **Caches are shared, never per tree.** Go's build and module cache, Bun's and npm's global caches stay in their
  home locations; the measured 30–88 min checks came from a rule that moved GOCACHE into the tree ([judge]). New
  trees run the package manager's install against its shared cache, never a `cp -al` of the main checkout's
  `node_modules` (it saves ~3 s, and a write through a hardlink edits the main checkout). Measured on the box
  (2026-10-28, median of 3): worktree add 0.2–0.6 s, `bun install --frozen-lockfile` 6–7 s and ~50 MB of real new
  disk (bun hardlinks from its cache), Go build in a new tree 12 s with the shared GOCACHE, so a writer's tree is
  ready in 7–15 s. Tree setup keeps its 15-minute limit (`treeLimits.setupMs`). Submodules borrow objects from the
  main checkout's copy (`--reference --dissociate`): 6.5 → 5.7 s on the box, 61 → 5 s over a slow link. LayerFS itself (a FUSE overlay with instant forks) is not adopted: it mounts
  per tool call, which needs the harness to call it, and roles run in each vendor CLI as configured (native harness); no published plugin gives a
  native CLI a workspace except by running the CLI inside LayerFS's Docker sandbox; and v1.1.0 is not durable
  (`synchronous=OFF`, no fsync), has no garbage collection (issue #411), and shipped with its Linux FUSE gate not run. Copy-on-write clones are not available either: the box's ext4 has no reflink (measured).
- **Merges are the daemon's, conflicts are the writer's** (Cursor: workers resolve their own conflicts; an
  integrator role made more bottlenecks than it solved). `merge` first merges the integration branch into the task
  branch inside the task's tree; a clean merge runs the fast check there and fast-forwards the integration branch.
  A conflict, or a red fast check, goes back to the same writer's thread with the conflict list (`thread_send`,
  `queue`), and the architect gets the event.
- **A completed merge posts a notice** to every running writer: "task T merged: files …, sha …" (the completed-change
  notice that recovered 82% of constructed conflicts). A writer that needs that work runs `git merge integration` in
  its own tree; nobody waits on a sibling's symbols ([walls]: P6 M50.L3).
- **Regenerable files never conflict** (the job LayerFS's `.lww` does, done safely: newest-mtime-wins on a
  lockfile silently drops one side's dependency, and git resets mtimes). The profile or the repo lists paths that are
  rebuilt rather than written by hand: lockfiles, generated API clients, build output. They get a `merge=regen`
  attribute whose driver keeps the integration side (`cp %B %A`); after the merge the daemon reruns the repo's
  regenerate command (the install for a lockfile) in the task's tree. Only a conflict in any other file goes back to
  the writer.
- **Checkpoints, on git** (LayerFS's per-step checkpoints, at the granularity catherd can see). The daemon snapshots a
  writer's tree, committed or not, as `refs/catherd/<run>/<task>/<n>`: at the end of every dispatch, before any kill,
  timeout or stall stop, and every two minutes while it runs. The snapshot uses an alternate index so the writer's
  index and files are never touched and untracked files are included (`GIT_INDEX_FILE=<tmp> git read-tree HEAD &&
  git add -A && git commit-tree $(git write-tree) -p HEAD`, then `git update-ref`; `git stash create` cannot do this,
  it takes no `-u`, measured). A retry of the same ledger task **continues from the last attempt's snapshot** by
  default ([retry]: M1.L5 finished in 1 min after a ruling, the work was nearly done); `delegate_task {from: "clean"}`
  or any earlier checkpoint restarts instead. A race (E1) forks from one point; a reviewer reads exactly one
  dispatch's diff. Run cleanup deletes the refs.
- **Conflicts are predicted, not discovered.** After each merge into the integration branch, the daemon runs
  `git merge-tree --write-tree integration <snapshot>` against every running writer's latest snapshot (no tree is
  touched). A writer whose work would now conflict gets the paths in its notice at once, instead of at its own merge.
- **Check results are keyed by tree.** A fast or full check result is stored against `HEAD^{tree}`; a tree already
  checked (a fast-forward, a revert, a race duplicate) reuses the result instead of rerunning ([rerun]).
- **The writer cap stays memory-bound** (plan 35's milestone memory, applied to writers instead of milestones). The
  box is not assumed slow: contention was measured at 3–5% of wall ([box]).
- **Read-only roles get no tree.** Reviewers, the verifier and the researcher read a ref (`git worktree` only when
  the role must run a command, else `git show` through `read_run_file`). The writer gets a tree only when it edits
  repo docs.

### Checks

**6. Fast checks stream per task; one full check on the integrated product; nothing reruns blind.** (answers
[check], [rerun], [baseline], [acceptance])

- **Fast check per task, as it finishes.** The profile's `fastCheck` (or the lane's, as today) runs in the task's
  tree at merge time. No other task waits on it. This replaces the per-round milestone Check.
- **One full check on the integrated product**, when the architect calls `check {scope: "full"}`; `land {final}`
  refuses without a green full check on the exact sha it pushes. The architect may call it earlier (for example
  before a large replan); the daemon never schedules it.
- **No automatic rerun of a red check.** The rerun at `milestone-check.ts:243-247` is deleted: it stayed red 19 of
  22 times. A red result goes to the architect, which may call `check` again (it must give a reason, for example
  "load flake: the failing test passed on the task tree"), dispatch a fix, or ask for the base.
- **Baseline only on demand.** `check {base: true}` runs the same command on the base sha and caches it by sha and
  command. A failure line present on the base is marked "pre-existing" in the result. No run computes a baseline it
  was not asked for ([baseline]: ~115 min).
- **No acceptance milestone.** The final verifier (D8) reads the full check's result at the same sha and does not
  rerun it ([acceptance]).

### Rungs

**7. Static role ladders, chosen by the architect, escalated on observed failure.** (answers [decision]; O5)

- Each role in the profile has an ordered list of allowed rungs, its ladder. The first is the default. The architect
  may pass any rung on the role's list; a rung not on it is refused.
- **Escalation is mechanical and observed.** When a task's last attempt ended `failed`, `timeout`, `too_hard`, or with
  a BLOCKER from review, a `delegate_task` for the same ledger task with no `rung` gets the next rung up the ladder.
  An attempt that ended for a reason outside the rung (`provider_error`, `no_access`, `needs_user`, a quota limit)
  does not climb. The architect can always name a rung.
- **Defaults from the measurements:** coding workers start on a flash-class rung where the profile has one (95% ok at
  ~$0.01); the verifier's ladder must hold only rungs that run commands (sonnet verifiers mostly judged from the tree).
  These are profile defaults written by `init`, not code.
- Deleted: the decision model, its client, its questions, its floors and parks, the bars, and Jev's `noul` signals.
  Plan 45's `pickLevel` fix is the last change to it.

### Reviewers and the verifier

**8. Reviews are called by the architect, run fresh and cross-family, and never form a barrier.** (answers
[barrier], [dupes], [audit], [rolelock])

- **Reviewer.** The architect calls one when it judges a merged task or the integrated diff worth it. Fresh context:
  the brief is the diff ref, the task goal and the acceptance lines, not the run history. Cross-family by default:
  with no `rung`, the daemon takes the first rung on the reviewer ladder whose model family differs from the
  author's (Cognition: same-family judges share errors). One reviewer per call; a second only when the architect
  asks for one ([dupes]). Other tasks keep running while it reviews.
- **ui-reviewer** only for a task whose diff touches the screens the architect names in the call ([barrier]: 17 of
  26 ui-reviews found no bug, and it was the slow side of every pair).
- **Verifier.** Once, on the integrated product, before `land {final}`. It runs the acceptance commands that the
  full check does not cover and reads the full check's result for the rest; its verdict carries the commands it ran
  (the existing `RAN:` lines), and a verdict with no command run on a runnable acceptance line is not a PASS. Plan 45
  already removes process audits from its contract.
- **Findings go to the architect**, which decides what is fixed now, later, or listed under Known issues in the MR.
  The judge's triage step goes ([judge]: it never filtered a finding).
- **Review converges** (Claude Code team, "How the Claude Code team does code review", 2026-10: one PR cycled 50+
  times between an agent author and an agent reviewer; ~59% of what re-reviews flagged was code from the first
  pass). A finding carries a severity (`important | nit | pre-existing`); a `pre-existing` one (not introduced by
  this run's diff) never starts a fix round and goes under Known issues. A finding names the bug class, so one fix
  round covers every instance, not one line ([round-cost]: 46 bullets for one root cause). A re-review sees only
  the diff since the last review and never re-reports an earlier finding. After three review rounds on one task the
  architect re-plans the approach instead of calling a fourth.
- **Review depth follows the change, not the author.** The architect asks for a deeper review (a second,
  cross-family reviewer) only for diffs touching money, auth, migrations or CI; a routine diff gets one reviewer or
  none.
- **The reviewer is measured.** Every confirmed bug a reviewer missed and a later check, verifier or owner caught
  joins a reviewer eval set; each reviewer finding records how the architect handled it (fixed, rejected,
  intentional, not worth it), so noise is visible per rung.
- **No verifier role lock.** The machine-wide lock (`withRoleLock` in `heavy-lock.ts`) is deleted; the heavy lock
  still serializes the commands a verifier runs ([rolelock]).

**9. The one mechanical gate: an implementer may not change an oracle.** (O4)

The evidence demands exactly one process check: the implementer did not edit the tests or the oracle it is graded
by (Anthropic evals). The 2.0 form of that check, "any test file the lane does not own", produced the [walls] loop.
This design narrows it:

- An **oracle** is a path the architect lists on a ledger task (`oracle`), typically the acceptance tests written
  before the implementation, or an existing test file the task must keep green.
- A merge whose diff changes an oracle path of that task, and was authored by that task's writer, is held: the
  architect gets the event with the oracle diff, and either accepts it with a reason (recorded in the MR's audit
  section) or sends the task back.
- Every other test edit is allowed and reported: the merge event lists test files added, changed, deleted or skipped,
  and the MR's audit section lists deleted or skipped tests. Nothing fails an attempt for touching a test.

Rejected: no rule at all (leaves the one gaming path the literature names); the 2.0 ownership rule (measured walls).

### Stopping, retries and the owner

**10. Caps, stall detection and an "impossible" verdict replace retries.** (answers [retry], [blocked], [tick])

- **Caps** (profile, overridable per run): wall time (default 12 h), cost (the existing budget), attempts per ledger
  task (default 4), idle (default 15 min with no role running and no wake pending). At 80% of a cap the architect is
  woken; at 100% the daemon stops new dispatches, lets running ones finish or cancels them past a 10-minute grace,
  and wakes the architect for `land` or `finish`.
- **Idle.** Idle wakes the architect once with "nothing is running". A second idle with no action in between stops
  the run with its report ([idle]: 36% of wall with no role running).
- **Stall.** Every stopped attempt gets a fingerprint: ledger task, stop reason, and a hash of the first three
  normalized failure lines or of the `why`. When a task's new attempt would start with the same fingerprint as its
  last and nothing new happened in between (no ledger or plan edit, no owner answer, no new integration commit, no
  different rung), the daemon refuses the dispatch and wakes the architect with "stalled". The architect must
  replan, change the rung, ask, or mark the task `impossible`. No same-rung retry without new information
  ([retry]: ~240 min).
- **Impossible.** A worker may stop with `impossible` and its reason; the architect may mark a task or the run
  `impossible`. Impossible ends that task (the run continues without it, and the MR lists it) or the run (`finish`).
- **No admission tick.** The 5-minute refusal wait goes ([tick]); a dispatch the writer cap holds starts the moment a
  slot frees.
- **Questions.** Workers ask the architect (team channel, `question` kind). The architect answers, or uses
  `ask_owner` within O6. Only the asked scope parks; the phone notification path (2.0 decision 5) stays.

**11. Landing pushes without asking and asks once.** (answers [land]; O6)

- `land` pushes the feature branch and opens or updates the MR, every time the architect calls it, with no park. It
  never pushes the base, never force-pushes a branch the run did not create, and refuses a protected branch.
- **One feature branch and one MR per repo per run.** Milestones are the architect's checkpoints on that branch, not
  branches. Ruling (owner delegated, 2026-10-27): the 2.0 milestone-per-branch mode with stacked MRs merged in order
  is dropped. It removes the "merged: MR !N" wait and the pin-bump chain ([chain]); a change too large for one MR is
  split across runs.
- `land {final: true}` needs a green full check and a verifier PASS on the pushed sha (the E_LAND_GATE requirement on
  reviews and dispatch evidence goes), then sends the owner one question: merge? The run ends `done` when the owner
  answers; it does not wait on the merge itself.
- The MR body carries the architect's change log (every tool call's `why`), Known issues, oracle overrides, and
  deleted or skipped tests.

### Standing roles

**12. The researcher and the writer are on call for the whole run, for the architect and for writers.** (O8)

In 2.0 they appear at fixed points: the researcher writes a dossier before planning, the writer takes docs lanes.
This design makes them callable at any moment: research a question, map code for a task, read docs or a vendor API, write or
update docs, a report or the MR text.

- **Who calls them.** The architect, with `delegate_task {role: "researcher" | "writer"}`. Writers (workers, the
  writer itself) get the same tool, restricted to those two roles, so a worker can ask "how does the payment client
  sign requests?" without a round trip through the architect's context. Run-wide cap: 4 standing-role tasks at once
  by default; they do not count against the writer cap and take no heavy lock.
- **Results are files with a path back.** A research answer goes to `research/<taskId>.md`, a writer's output to its
  target path (repo docs in its own tree, run documents in the run dir). The caller gets `{taskId, reportPath}` at
  once and the completion as a wake event or a team notice; the content never passes through the architect's
  context unless it reads it. The architect's digest names standing-role results by path only.
- **Fast to start, not kept warm.** Options were (a) an idle warm session per role held for the whole run, (b) a pool
  of warm sessions, (c) start on demand with nothing in the way. 2.0's start latency was not the process: it was
  everything before the spawn (decision-model call, preflight, admission tick). (c) removes those and adds no
  mechanism (O7); briefs are cached 90–98% ([box]) so a cold start pays little for context. **Chosen: (c)**, on the
  role's ladder default (a cheap fast rung). Follow-ups reuse context without idle processes: `thread_send` to a
  finished researcher task resumes its thread (T3's contract), so "and what about the refund path?" continues the
  same research. Start latency (request → first output) is recorded per call; a warm pool is reconsidered only if its
  median exceeds 30 s over a staged run.
- **Tool surface.** Researcher: read-only on the repo, the backend's native web search and fetch where the profile
  allows it, `read_run_file`, `read_knowledge`, `write_run_file` limited to its own report path, `team_send` for a
  question, `memory_search` and `memory_chat` (D14). Writer: `workspace-write` in its own tree when it edits repo docs (merged like any writer's work, D5), else
  `write_run_file` to run documents (`report.md`, the MR text); `read_run_file`, `read_knowledge`, `team_send`,
  `memory_search` and `memory_chat` (D14).
- The pre-planning dossier becomes the architect's first `delegate_task` to the researcher, when it wants one.

### Machine state

**13. Machine state moves to one SQLite database; documents stay files.** (owner, raised 2026-10-27, adopted on the
coordinator's recommendation; the owner may still veto)

Today one run dir (P8) holds 1,831 files and 105 MB: `events.jsonl`, `runs.jsonl`, `decisions/`, questions, routes,
outcomes, digests, `state.json`, each written through the per-file atomic-write-and-lock machinery
(`src/infra/store.ts`, `src/services/run-store.ts`, `run-events-store.ts`).
Every cross-run question, including the 14-run baseline above, took ad-hoc scripts over JSONL.

- **One database** at `<catherd data dir>/catherd.db`, opened with Bun's built-in `bun:sqlite` (no new dependency),
  `journal_mode=WAL`, `busy_timeout=5000`, `foreign_keys=ON`. The daemons, the MCP servers, the CLI and the panel are
  processes on one machine, which is the case WAL serves. Writes are short transactions; a transaction replaces each
  lock-and-rename.
- **Tables:** `runs`; `events` (append-only, `seq INTEGER PRIMARY KEY`, run id, type, JSON body; replay reads by
  `seq`); `dispatches` (one row per attempt: role, rung, ledger task, status, stop reason, fingerprint, cost, tokens,
  times, report path); `messages` (the team channel: sender, target, kind, mode `notice | question | steer | queue`,
  delivered-at; `team_read`/`thread_read` page by a `seq` since-cursor, `team_wait` waits on it); `ledger_tasks` and
  `ledger_progress` (D2: the architect edits them through `ledger`, and `tasks.json`/`progress.md` are rendered into
  the run dir after each change, read-only, so agents still read them as files); `checks` (ref, sha, command, exit,
  failure lines, baseline flag, minutes); `merges`; `caps` and budget spend; `questions`; `outcomes`; `memory_outbox` (D14); workspace-run state
  (the parent execution graph and its child links).
- **Files stay files** for everything an agent reads or writes as a document: `plan.md`, lane notes, briefs, replies,
  research and writer outputs, reports, logs, screenshots. Agents work on files natively, and D1 and D12's "return a
  path, not the content" needs them. A row points at a file by its path; it never holds a document's body.
- **Schema and migrations.** `PRAGMA user_version` holds the schema version. Migrations are an ordered list in code,
  each applied in one transaction at open. A database newer than the binary is refused with the existing
  `E_CONFIG_NEWER_SCHEMA` path. The domain layer stays pure; SQLite lives in `infra`, behind the same store
  interfaces the services use now, so `test/architecture.test.ts` keeps holding.
- **Configuration stays files** (owner, 2026-10-27): profiles, config, repo bindings, the workspace registry and repo
  knowledge. The owner edits profiles by hand and diffs them, and a profile change that is his is reported, never
  reverted. `ProfileService` stays their single writer, on the existing file store (`src/infra/store.ts`,
  `profile-store.ts`, the registry part of `workspace-store.ts`), unchanged. Only run and machine state moves.
- **The panel's live updates** tail `events` by `seq` instead of watching `events.jsonl` (2.0 decision 24 amended).
- **Backup.** At each run's end the daemon writes `VACUUM INTO <data dir>/backups/catherd-<date>.db` and keeps the
  last 7. The database is the only machine state, so this one copy is the whole backup; documents stay in run dirs as
  today.
- **What the panel and scorecard gain.** Cross-run queries in SQL: idle %, concurrency, blocked minutes by reason,
  check share of wall, cost per rung, a rung's success rate per role, stall counts; the D17 metrics become views, and
  the scorecard stops parsing JSONL (`scorecard-metrics.ts`, `outcome-summary.ts` shrink to queries). The panel's
  Runs page can filter and compare runs. A later learned router (rejected for now) would train on `dispatches`.
- **Earlier runs.** Runs written by an earlier 2.0 `next` build stay on files; one still in flight finishes on the
  build that started it (D16). On first start, catherd imports every finished earlier run dir read-only (events,
  dispatches from the records, outcomes, checks) with `legacy = 1`, so the 14-run baseline is queryable beside new
  runs. Import never writes to a run dir, and an unreadable dir is
  reported and skipped.

Rejected: keeping JSONL and adding an index (two stores to keep in step); an external database or a new dependency
(O7); putting documents in the database (agents and the path-return rule need files).

### Memory

**14. Honcho comes back as the run's knowledge base, in its own workspace, written only by catherd.** (O9)

**The mistake not to repeat.** Plan 2.0's roles ran in each vendor CLI as the owner configured it, so a headless
Claude role loaded the owner's `claude-honcho` plugin. Its hooks uploaded every role brief into the owner's personal
workspace as the owner's own peer, and the post-tool-use hook stored tool noise. Honcho then derived "the owner said
the scratch folder is …/runs/…" and injected it into later sessions. A headless role started in an unknown folder
also took over the interactive session's memory target (the plugin rewrites its instance cache and session map). The
cleanup deleted thousands of messages and soft-deleted thousands of conclusions, and catherd#100 gave every dispatch
`HONCHO_ENABLED=false` (`src/services/admission.ts`). Three causes, each answered below: the wrong workspace, the
wrong speaker, and uncurated content.

- **(1) Its own workspace and key.** Memory writes go to one workspace (default name `catherd`, set in config)
  through a key scoped to that workspace. The endpoint and the key come from catherd's config and environment
  (`memory.url`, `CATHERD_MEMORY_KEY`); nothing personal is in the code or docs. No role and no catherd process ever
  holds a key that can write the owner's personal workspace; that is enforced by the server (the key is scoped), not
  by catherd's discipline. Cost: one more workspace for the owner to create and one key to keep. Rejected: a session
  inside the personal workspace (one wrong config line and the mistake repeats; and recall is workspace-wide, so the
  owner's own recall would fill with run facts).
- **(2) Peers.** The roles are peers: `architect`, `worker`, `reviewer`, `verifier`, `researcher`, `writer`, and
  `catherd` itself as the orchestrator peer. The owner's answers go under a peer named `owner`, never the owner's
  personal peer name, and only when the owner actually answered: an answer typed in the panel (token-authenticated)
  or one the session marks `by: "owner"` because the owner typed it. An answer a coordinator gives on its own is
  posted under `catherd` as "the coordinator ruled …". `observe_me` is set explicitly on every peer (the server
  default is true, which once made 64% of a store's observations about an assistant that nobody read): true for
  `architect`, `worker`, `reviewer`, `verifier`, `researcher`, `catherd` and `owner`, because each posts only curated
  facts (below); false for `writer`, whose output is documents already in the repo. `observe_others` is false for
  every peer, so no peer builds a private view of another. catherd sets no peer cards. If the dreamer writes one, the
  strict prefixes apply, and `INSTRUCTION:` stays reserved for a rule that peer stated itself.
- **(3) Sessions: one per repo,** named from the repo binding (`repo-<binding>`), never from a filesystem path. A
  workspace run writes each child repo to its own session. Knowledge accumulates per repo across runs; the run,
  dispatch, ledger task and commit sha go in each message's metadata. Rejected: a session per run (recall is not gated
  by session, so it buys nothing for search, while every session pays its own rolling-summary work, the dearest
  deriver job); one session for everything (the summary would mix repos).
- **(4) What is written: curated messages only, posted by catherd through the Honcho API.** No role writes memory.
  catherd builds each message from events it already records:
  - the architect's decisions and replans with their `why` (from its tool calls, D3), and every reversal as a
    superseding message;
  - each merged task's report: "changed X because Y", with the files (from the merge event and the reply);
  - reviewer and verifier findings the architect confirmed (fixed or listed under Known issues), never raw findings;
  - a researcher report's summary (its first 1,500 characters and the report's path);
  - landed outcomes: the MR, the sha, Known issues, oracle overrides; and `impossible` verdicts with their reason;
  - owner answers, under `owner`, as above.

  Never written: briefs, raw replies, tool calls, check logs, progress chatter. Every message starts with its date
  (`2026-10-27 — …`), because Honcho has no recency weighting and the date must be inside the embedded text. Every
  message passes catherd's secret scan (`src/domain/secrets.ts`) and is dropped, not redacted, on a hit. Posting is
  asynchronous through an outbox table in the D13 database with retries, so a slow or down Honcho never holds a run.
  The workspace's `custom_instructions` are set by `catherd memory setup`: keep code facts with identifiers,
  decisions with reasons and reversals, contracts and traps; derive nothing from status, progress or approvals.
  Cost: the deriver load on the shared Honcho server (one curated message per decision or merge, a few hundred per
  big run, against thousands of uncurated ones before) and the code that curates.
- **Plugin hooks inside roles stay off.** `HONCHO_ENABLED=false` stays in every dispatch's env, and catherd turns off
  any Honcho MCP server a backend loads from the owner's config (Codex's `honcho` entry would otherwise write as its
  own peer into the personal workspace); `doctor` verifies both per backend. Rejected: pointing the plugin at the
  catherd workspace with saving off through `HONCHO_WORKSPACE` / `HONCHO_PEER_NAME` / `HONCHO_SAVE_MESSAGES` /
  `HONCHO_SAVE_TOOL_USE`. Even with saving off, the plugin still resolves sessions from the role's cwd and rewrites
  the owner's instance cache and session map, the trap above, and its session-start injection would put memory into
  every worker's context, which (5) forbids.
- **(5) Reading.** The architect, the researcher and the writer get two role tools on catherd's role server:
  `memory_search {query, repo?, limit?}` (conclusions, semantic search; defaults to this run's repo session) and
  `memory_chat {question, repo?}` (the dialectic, reasoning medium, 120 s limit, answer capped at 4,000 characters).
  Nothing is injected into any brief automatically, and workers get no memory tool: a worker that needs history asks
  the researcher (D12). A memory answer is a lead, not a fact; the architect's brief says so.
- **(6) Health.** `catherd doctor` and `catherd memory check` assert, with no writes: the catherd key lists its own
  workspace's sessions; the same key is refused (HTTP 401) on every workspace named in `memory.isolateFrom` (the
  owner lists his personal workspace there); no message in the catherd workspace comes from a peer outside the seven
  role peers and `owner`; and every role's dispatch env carries `HONCHO_ENABLED=false` (also a unit test on
  `admission.ts`). A failure turns memory writes off for the run and says why; the run itself continues. It is the
  same isolation check the owner already runs for another workspace on that server.
- **Off by default.** With no `memory.url` configured, catherd writes and reads nothing, and the memory tools are not
  offered.

### Compatibility of 2.0 decisions

**15. What this design replaces in the 2.0 spec.** Decision 3 (judgment is a role) is replaced by D1; 7 (fix rounds by
convergence) by the architect's own call within D10's caps; 8 (blocked reasons map to transitions) keeps the reason
vocabulary, but reasons go to the architect, plus `impossible`; 11–12 routing on one scale shrinks to D7's ladders
(Slopalytics stays the catalog: a ladder may only hold indexed pairs); 18 (gate evidence: auto-rerun, baseline every
check) by D6; 19 (recovery: foreign failures) by D5; 20 (standing rules reviewed after each run) is deleted
([judge]: 74% restrictions; rules that only grow degrade compliance); 21 (a milestone per branch) is dropped by D11; 22
(the plan as input, its preflight, the one planned stop) keeps the plan as the preferred input but drops the
preflight refusals and lets the architect edit it. Decisions 1, 2, 4, 5, 6, 9, 10, 13, 15–17 and 23–26 stand.
Decision 14's Cursor backend is retired by plan 45.

## Deletion table

Files are on `main` at 6c08f862 unless a plan 45 change is noted. "Shrinks" means the named part goes and the file
stays for what D4 keeps.

| What goes | Files | Measured reason |
|---|---|---|
| The judge role, its prompts, replies and calls | `src/domain/judge.ts`; judge parts of `run-machine.ts` (`judgeCall`, `judgeId`, `judgeInputFor`, `judgeRetries`, `judgeKeys`), `run-state.ts`, `run-effects.ts`, `role-prompts.ts` (`judge`), `roles.ts`, `run-graph.ts` | [judge] |
| The decision model | `src/domain/decision.ts`, `src/infra/decision-client.ts`, `src/services/decision-service.ts`; `decide` action and `decision.*` events in `run-machine.ts`, `run-events.ts`, `run-state.ts` (`decisionFailed`); profile `decision` block; `test/fixtures/decision/` | [decision] |
| Routing by bars and objective | Shrinks: `src/domain/route.ts`, `src/domain/select.ts`, `src/services/routing-service.ts` to "ladder default, climb on observed failure, failover"; `failover.ts` and `failover-rungs.ts` stay | [decision] |
| Milestone and round transitions | Shrinks: `src/domain/run-machine.ts` (`laneActions`, `fixActions`, `reviewActions`, `milestoneActions`, `architectAgain`, `planningActions`, `approvalActions`, `onLaneStopped`, `waitsForSibling`, `afterReady`) and `src/domain/run-state.ts` (milestone, round, floor and lane-status bookkeeping) to the D4 reducer; `src/domain/run-graph.ts` draws from the ledger | O1, [idle] |
| Rule review and standing-rule tagging | `rulesReviewActions`, `failRulesReview` (`run-machine.ts`, `run-state.ts`), rules-review parts of `run-graph.ts`, `run-report.ts`; `src/domain/rules.ts` | [judge] |
| Preflight parks and plan coverage refusals | Shrinks: `src/services/preflight.ts` to a warnings pass; `coverageProblems` and the signature/Test refusals in `src/domain/plan-doc.ts` (plan 45 removes the `Test:` rule); `src/services/plan-input.ts` refusals | [preflight], [plan-input] |
| Landing parks and the land gate | "push" and "merged: MR !N" parks, `pushBranch` gating in `run-machine.ts`; `E_LAND_GATE` in `src/services/lane-service.ts` and `src/domain/errors.ts`; the merge wait in `src/services/milestones.ts` | [land] |
| The acceptance milestone | Acceptance-milestone text in `role-prompts.ts` (architect contract), `run-graph.ts`, `gate-brief.ts`; `src/services/verifier-step.ts` milestone-verifier flow (`milestoneVerifier` in `milestones.ts`) | [acceptance] |
| Auto-rerun of a red check, automatic baseline | `src/services/milestone-check.ts:243-262` rerun; per-check baseline calls (`baselineFor` stays for `check {base}`) | [rerun], [baseline] |
| The verifier role lock | `withRoleLock`, `roleLockOwner` in `src/infra/heavy-lock.ts`; its caller in `milestone-check.ts:224`; role slots in `src/entry/lock-command.ts` | [rolelock] |
| The admission tick | `REFUSAL_WAIT_MS` (`run-state.ts:28`) and admit-order refusals in `src/services/admission.ts` | [tick] |
| Test-ownership guard, foreign-failure blame | `src/domain/test-guard.ts` (plan 45 trims it), the restore order at `run-state.ts:1134`, `foreignFailure` in `src/domain/blocked.ts`, `src/domain/role-scope.ts` ownership parts | [walls] |
| The shared milestone tree as the writers' tree | Shrinks: `src/services/milestone-tree.ts` becomes the integration tree; per-writer trees added beside it | [walls] |
| Same-rung retry floors | `floors` and `failedOn` in `run-state.ts` (`run-state.ts:829` clearing included) | [retry] |
| Per-file run and machine state | `src/services/run-store.ts` and `run-events-store.ts` become SQLite-backed, as does the run-state part of `workspace-store.ts` (D13); `src/infra/store.ts` stays for profiles, config, repo bindings, the workspace registry and knowledge, which stay files; `decisions/`, `routes`, `state.json`, `runs.jsonl` and `outcomes.jsonl` files stop being written | 1,831 files / 105 MB in one run dir; ad-hoc scripts for every cross-run question |

Kept on purpose: the supervisor, `heavy-lock.ts` (heavy commands and load gate), the event log and replay (now the D13 `events` table), the
notifier, questions (for the scopes D10 allows), failover, budgets, the panel (its Runs timeline reads the new
events), `scorecard` (outcomes now in the D13 database), plan lint as warnings, Slopalytics catalog.

## Migration

**16. Still 2.0.0, on `next` until 2.0 is released.** The profile schema loses the judge role, the decision block
and bars, the run event schema changes, and role contracts change. Those are breaking changes, but 2.0 is
unreleased: `latest` is 1.5.0 and 2.0 has shipped only as `next` snapshots, so they land inside 2.0's major bump
rather than starting a 3.0. The changesets are `minor`, as plan 45's is, while the version line stays `2.0.0-next.*`.

- **Runs in flight.** A daemon on this design does not resume a run whose `events.jsonl` was written by an earlier
  `next` build with the old event schema: it imports it read-only once it has finished (D13) for `status`, `result`
  and the panel, and tells the owner to finish it with the build that started it (`npx catherd-cli@<that version>`).
  1.5 runs keep 2.0's rule (finish them on `catherd-cli@1`).
- **Profiles** stay files (D13). `ProfileService` migrates them on first read, schema-versioned as today: drop `judge` and its rungs, drop
  `decision` and `bars`; each role's rungs become its ladder in their current intelligence order; give the architect
  `workspace-write`; add `caps` with D10's defaults and the standing-role cap, and an empty `memory` block (memory off until
  configured, D14). `profile validate` names every dropped
  key, and the migration is written back as a file the owner can diff. Nothing is guessed: a role with no rung left still stops the run at start (2.0 decision 12).
- **Lane files and plans** written before this design stay readable; ownership lines become hints, `Difficulty:` and `Kind:` are
  plain text for the architect.

**17. Staged rollout, measured against the 14 runs.** (O7: remove parts one at a time and measure)

| Stage | What runs | Measured against |
|---|---|---|
| 0 | Plan 45 (the bridge), on today's 2.0 shape. | The 14 runs. Isolates what notices, outcome gates and plan freedom buy by themselves. |
| 1 | The SQLite state (D13), with the read-only import of the finished earlier runs. The architect loop (D1–D3), the daemon reducer (D4), stall and caps (D10), landing (D11), standing roles (D12) on the 2.0.0 `next` line, still on the shared milestone tree. Judge, decision model, acceptance milestone, landing parks, auto-rerun, role lock and admission tick deleted. | Stage 0 and the 14 runs. |
| 2 | Per-writer worktrees and merge (D5), streaming fast checks (D6), the oracle rule (D9). | Stage 1. If isolation does not reduce blocked minutes, it is reverted (O7). |
| 3 | Memory (D14): the catherd workspace and key, the curated outbox, the role peers, the read tools, and the isolation check, which must pass before the first write. | Stage 2, on the same tasks. Memory is kept when a sample of 50 conclusions after two runs holds at least 60% repo facts with identifiers and no brief text, and the architect's runs on a repo it has seen are no worse on wall time and rounds; otherwise writes are turned off and the finding goes to `ideas.md`. |
| 4 | The 2.0 scorecard's four fixed tasks plus replays of three of the 14 runs (one big: P8; one with the [walls] loop: P6; one landing-heavy). `latest` moves on the owner's word after it passes. | All of the above. |

Metrics per run, as queries over the D13 database (the scorecard's existing fields plus four):

- wall time; **idle %** (time with no role running; baseline 36%); **average concurrency** (baseline 0.7–0.94);
- **blocked minutes** by reason (baseline 448 min of 1,313 worker min);
- check minutes as a share of wall (baseline ~35%); rounds per task; interventions and owner questions (baseline
  every one answered yes);
- cost; standing-role start latency (D12); memory messages posted, outbox failures, and memory tool calls per run (D14);
- output quality: verifier FAILs that were real bugs, MR first-pass, Known issues count, bugs found after merge.

Pass bar for `latest`: no quality metric worse than the baseline; wall time and idle % better; zero process-audit
FAILs; zero landing parks.

After stage 4, the experiments below are switched on one at a time, each measured on its own metric.

## Experiments

Five ideas from the owner, designed here. They are not part of this design's binding shape. Each is a profile flag
(`experiments.<id>: true`, default off), is switched on **alone**, on top of the finished stage 4 (or the stage its
prerequisite lands in), runs on the same replayed tasks, and is kept only if it beats the 14-run baseline and the
stage-4 numbers on its named metric without making output quality worse. Otherwise it is switched off, and the result
goes to `docs/dev/ideas.md` with its numbers. Two experiments are never measured in the same run.

**E1. Race instead of escalate.** (targets tail latency: flash-class worker stalls of 29 and 55 min; a strong rung
blocked 35 min twice)

- When the architect marks a ledger task `race: true` (it is on the critical path), or a task's first attempt failed,
  catherd starts the same brief on **two** cheap rungs at once, each in its own worktree (D5), from different
  providers where the ladder allows it, so one quota hold or one provider's stall does not hit both.
- The first attempt whose fast check passes on the merged result wins and is merged; the other is cancelled at once
  (`task_cancel`), its tree removed. Both runs count toward cost and the attempts cap (D10).
- If both fail with the same stall fingerprint, that is a stall (D10), not a reason to race again. A raced attempt
  never touches an oracle (D9), so the winner is judged on the same tests as a single attempt.
- Why it can pay: a flash-class worker succeeded 95% of the time at about $0.01 with a 6-minute median, so a second
  copy costs cents and cuts the tail, where escalation pays for a slower, dearer rung after the stall already happened.
- Risk: double writer slots on a tight memory cap. A race counts as two writers, and it does not start when it would
  delay a non-raced task.
- **Metric:** p90 task time (dispatch to merge) and cost per landed task.

**E2. Speculative continuation.** (targets the check-sized idle: checks were ~35% of wall)

- While a full check runs on integration head H, the architect may dispatch tasks that depend on H with
  `delegate_task {from: H, speculative: true}`. They work in their own trees on top of the unverified head.
- Green: nothing happens; they were simply early. Red: catherd tells each speculative task (a `queue` message) that
  H failed, names the fix task, and once the fix merges, rebases each speculative branch onto the fixed head; a
  rebase conflict goes back to that task's writer (D5). The architect may instead cancel them.
- Speculative tasks never merge before H is green: `merge` holds them until it is.
- Like a CPU's branch prediction, it pays when checks are mostly green. Measured, a red check is common enough
  (the auto-rerun stayed red 19 of 22 times), so the architect is told to speculate only on tasks whose files do not
  overlap the failing area, and the metric counts the waste honestly.
- **Metric:** idle % and wasted dispatch minutes (speculative minutes later cancelled or redone after a red check).

**E3. Fast checks on the affected tests only.** (targets fast-check minutes; prerequisite D6)

- A task's fast check runs only the tests reachable from the symbols the task changed; the full check still runs once
  on the integrated product (D6), and that is where an escape is caught.
- The source of "affected" is pluggable, tried in order:
  1. a code-graph MCP server configured in the profile (`experiments.affected.mcp`), for example a codebase-memory
     graph with `trace_path` / `query_graph`: changed symbols → their callers → the test functions among them;
  2. the test runner's own changed-files mode, declared per repo in knowledge (`vitest --changed <base>`,
     `jest --changedSince`, `go test` over the changed packages with the shared build cache);
  3. otherwise the plain fast check, unchanged.
- The selection is written to the check result (which source, which tests), so a miss can be traced. A graph that is
  stale for the task's commit is not used (the server reports its indexed commit; catherd compares it with the base).
- **Metric:** fast-check minutes, and escaped failures: full-check failures in files a task's selected fast check
  should have covered. Kept only if escapes stay at or below 1 per 10 merged tasks.

**E4. Warm tree pool.** (targets dispatch start latency: tree ready → preflight took 89 min in sum over 42 trees)

Measured first (2026-10-28): a fresh tree is ready in 7–15 s, so the pool can save at most that per writer; the
89 min above was preflight, not tree setup. Run E4 only if dispatch start latency is still high after stage 4.

- catherd keeps one or two prepared worktrees per repo (dependencies installed, shared caches primed, the gitignored
  `.env*` files copied), parked on the integration head.
- A writer takes a pool tree; catherd resets it to the task's `from` ref (a fast-forward or a `git reset --hard` to
  that ref, then an install only when the lockfile changed) and refills the pool in the background when the box has a
  free slot. Pool trees count toward the memory cap; when the cap is tight, the pool is the first thing given up.
- Trees from cancelled races (E1) or dropped speculation (E2) go back to the pool after a reset instead of being
  removed.
- **Metric:** dispatch start latency (request → the writer's first output), with the pool's disk and memory reported.

**E5. Facts, not rules.** (targets the [judge] failure mode: the one accepted rule, GOCACHE in tree, slowed every check)

- When a role discovers an environment fact (a cron wiping a cache, a flaky suite, a slow command, a port in use),
  it reports it on the team channel with kind `fact` and its evidence (a command and its output, a log path).
- catherd records it as a dated fact with the evidence: in the repo's knowledge file under `## Facts`
  (`- 2026-10-27 — <fact> (evidence: <path or command>)`), and in memory (D14) when memory is on. A fact is shown to
  roles as a fact, never phrased as an instruction, and catherd never turns one into a rule.
- Rules for future briefs are written only by the owner (knowledge `## Rules`, by hand or `catherd knowledge`). The
  2.0 rule review is already deleted (D15); this experiment measures whether facts alone prevent repeats.
- A fact can be superseded: a later fact on the same subject is written with "supersedes <date>", and the old line
  stays.
- **Metric:** the rules count stays flat across runs (no rule written by catherd), and repeat incidents: the same
  environment problem costing a run time after a fact about it was recorded.

## Rejected alternatives (whole-design)

- **Keep the 2.0 machine and tune its transitions.** The 14 runs show the waste is the transitions themselves; each
  tuning (plan 45 included) removes one wall and keeps the shape. Plan 45 is kept as the bridge, not the end.
- **Peer-to-peer agents with no coordinator.** The owner wants free talk; the evidence (CooperBench, Cognition) finds
  open peer negotiation harmful. This design lets anyone talk on the team channel, with notices and questions as the default
  content, and keeps one brain that decides.
- **A learned router in place of the decision model.** Possible later, trained on catherd's own outcomes (the D13 `dispatches` and `outcomes` tables); not
  before the ladders have been measured.

## Rulings on the former open questions (owner delegated, 2026-10-27)

- **R1. Multi-MR runs are dropped.** One feature branch and one MR per repo per run (D11). A change too large for one
  MR is split across runs.
- **R2. The architect's default ladder is from a different model family than the workers' default ladder** (for
  example a Codex architect over opencode and Claude workers), set by `init`, for the same reason D8 makes reviewers
  cross-family: the architect authors the plan and integrates the work. The owner's profile always wins.

No question is left open for the owner. Rulings the builder may revisit with evidence: the 70% context threshold
(D1), the ledger's 40-entry window (D2), the default caps (D10), the standing-role cap of 4 and the 30 s warm-pool
trigger (D12).
