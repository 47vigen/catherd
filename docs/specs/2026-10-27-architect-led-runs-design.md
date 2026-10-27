# catherd 3.0: architect-led runs

Date: 2026-10-27. Status: draft for the owner's approval. Binding where it differs from the 2.0 spec
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
them. 3.0 removes the fixed pipeline. The architect drives the run as its brain. catherd keeps only what a model
should not do: run processes, hold worktrees and locks, write the event log, enforce caps and safety stops, and do
the mechanics of merging and pushing.

## Baseline: what 14 runs measured (codekesh, 2026-10-25..27)

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

Reviewers, the verifier, the researcher and the writer are not separate tools: they are `delegate_task` with that
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
  trees reuse the main checkout's `node_modules` by hardlink copy where the package manager allows it (the agora
  worktree script already does this), else install with the shared cache. Tree setup keeps its 15-minute limit
  (`treeLimits.setupMs`).
- **Merges are the daemon's, conflicts are the writer's** (Cursor: workers resolve their own conflicts; an
  integrator role made more bottlenecks than it solved). `merge` first merges the integration branch into the task
  branch inside the task's tree; a clean merge runs the fast check there and fast-forwards the integration branch.
  A conflict, or a red fast check, goes back to the same writer's thread with the conflict list (`thread_send`,
  `queue`), and the architect gets the event.
- **A completed merge posts a notice** to every running writer: "task T merged: files …, sha …" (the completed-change
  notice that recovered 82% of constructed conflicts). A writer that needs that work runs `git merge integration` in
  its own tree; nobody waits on a sibling's symbols ([walls]: P6 M50.L3).
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
- **No verifier role lock.** The machine-wide lock (`withRoleLock` in `heavy-lock.ts`) is deleted; the heavy lock
  still serializes the commands a verifier runs ([rolelock]).

**9. The one mechanical gate: an implementer may not change an oracle.** (O4)

The evidence demands exactly one process check: the implementer did not edit the tests or the oracle it is graded
by (Anthropic evals). The 2.0 form of that check, "any test file the lane does not own", produced the [walls] loop.
3.0 narrows it:

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
- **One feature branch and one MR per repo per run** by default. Milestones are the architect's checkpoints on that
  branch, not branches. Multi-MR runs are open question Q1.
- `land {final: true}` needs a green full check and a verifier PASS on the pushed sha (the E_LAND_GATE requirement on
  reviews and dispatch evidence goes), then sends the owner one question: merge? The run ends `done` when the owner
  answers; it does not wait on the merge itself.
- The MR body carries the architect's change log (every tool call's `why`), Known issues, oracle overrides, and
  deleted or skipped tests.

### Standing roles

**12. The researcher and the writer are on call for the whole run, for the architect and for writers.** (O8)

In 2.0 they appear at fixed points: the researcher writes a dossier before planning, the writer takes docs lanes.
3.0 makes them callable at any moment: research a question, map code for a task, read docs or a vendor API, write or
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
  question. Writer: `workspace-write` in its own tree when it edits repo docs (merged like any writer's work, D5), else
  `write_run_file` to run documents (`report.md`, the MR text); `read_run_file`, `read_knowledge`, `team_send`.
- The pre-planning dossier becomes the architect's first `delegate_task` to the researcher, when it wants one.

### Machine state

**13. Machine state moves to one SQLite database; documents stay files.** (owner, raised 2026-10-27, adopted on the
coordinator's recommendation; the owner may still veto)

Today one run dir (P8) holds 1,831 files and 105 MB: `events.jsonl`, `runs.jsonl`, `decisions/`, questions, routes,
outcomes, digests, `state.json`, each written through the per-file atomic-write-and-lock machinery
(`src/infra/store.ts`, `src/services/run-store.ts`, `run-events-store.ts`, `profile-store.ts`, `workspace-store.ts`).
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
  failure lines, baseline flag, minutes); `merges`; `caps` and budget spend; `questions`; `outcomes`; `profiles`,
  `config`, `repo_bindings`, `workspaces`.
- **Files stay files** for everything an agent reads or writes as a document: `plan.md`, lane notes, briefs, replies,
  research and writer outputs, reports, logs, screenshots. Agents work on files natively, and D1 and D12's "return a
  path, not the content" needs them. A row points at a file by its path; it never holds a document's body.
- **Schema and migrations.** `PRAGMA user_version` holds the schema version. Migrations are an ordered list in code,
  each applied in one transaction at open. A database newer than the binary is refused with the existing
  `E_CONFIG_NEWER_SCHEMA` path. The domain layer stays pure; SQLite lives in `infra`, behind the same store
  interfaces the services use now, so `test/architecture.test.ts` keeps holding.
- **Profiles move too** (ruling): `ProfileService` stays their single writer and `profile show` prints them; the cost
  is that a profile is no longer a file to diff in an editor.
- **The panel's live updates** tail `events` by `seq` instead of watching `events.jsonl` (2.0 decision 24 amended).
- **Backup.** At each run's end the daemon writes `VACUUM INTO <data dir>/backups/catherd-<date>.db` and keeps the
  last 7. The database is the only machine state, so this one copy is the whole backup; documents stay in run dirs as
  today.
- **What the panel and scorecard gain.** Cross-run queries in SQL: idle %, concurrency, blocked minutes by reason,
  check share of wall, cost per rung, a rung's success rate per role, stall counts; the D16 metrics become views, and
  the scorecard stops parsing JSONL (`scorecard-metrics.ts`, `outcome-summary.ts` shrink to queries). The panel's
  Runs page can filter and compare runs. A later learned router (rejected for now) would train on `dispatches`.
- **2.x runs.** Left on files while in flight; they finish on `catherd-cli@2` (D15). On first start, 3.0 imports
  every finished 2.x run dir read-only (events, dispatches from the records, outcomes, checks) with `legacy = 1`, so
  the 14-run baseline is queryable beside 3.0 runs. Import never writes to a run dir, and an unreadable dir is
  reported and skipped.

Rejected: keeping JSONL and adding an index (two stores to keep in step); an external database or a new dependency
(O7); putting documents in the database (agents and the path-return rule need files).

### Compatibility of 2.0 decisions

**14. What 3.0 replaces in the 2.0 spec.** Decision 3 (judgment is a role) is replaced by D1; 7 (fix rounds by
convergence) by the architect's own call within D10's caps; 8 (blocked reasons map to transitions) keeps the reason
vocabulary, but reasons go to the architect, plus `impossible`; 11–12 routing on one scale shrinks to D7's ladders
(Slopalytics stays the catalog: a ladder may only hold indexed pairs); 18 (gate evidence: auto-rerun, baseline every
check) by D6; 19 (recovery: foreign failures) by D5; 20 (standing rules reviewed after each run) is deleted
([judge]: 74% restrictions; rules that only grow degrade compliance); 21 (a milestone per branch) by D11 and Q1; 22
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
| Per-file machine state and its locks | Shrinks: `src/infra/store.ts` (atomic write and lock for machine state), `src/services/run-store.ts`, `run-events-store.ts`, `profile-store.ts`, `workspace-store.ts` become SQLite-backed (D13); `decisions/`, `routes`, `state.json`, `runs.jsonl` and `outcomes.jsonl` files stop being written | 1,831 files / 105 MB in one run dir; ad-hoc scripts for every cross-run question |

Kept on purpose: the supervisor, `heavy-lock.ts` (heavy commands and load gate), the event log and replay (now the D13 `events` table), the
notifier, questions (for the scopes D10 allows), failover, budgets, the panel (its Runs timeline reads the new
events), `scorecard` and `outcomes.jsonl`, plan lint as warnings, Slopalytics catalog.

## Migration

**15. Version 3.0.0, on `next` first.** The session tools stay, but the profile schema loses the judge role, the
decision block and bars, the run event schema changes, and role contracts change. That is a major version.

- **Runs in flight.** A 3.0 daemon does not resume a run whose `events.jsonl` was written by 2.x: it imports it
  read-only once it has finished (D13) for `status`, `result` and the panel, and tells the owner to finish it with `npx catherd-cli@2` (the 2.x line keeps bug
  fixes, as 1.x did). 2.0 followed the same rule for 1.5 runs.
- **Profiles.** `ProfileService` migrates on first read, schema-versioned as today: drop `judge` and its rungs, drop
  `decision` and `bars`; each role's rungs become its ladder in their current intelligence order; give the architect
  `workspace-write`; add `caps` with D10's defaults and the standing-role cap. `profile validate` names every dropped
  key. Nothing is guessed: a role with no rung left still stops the run at start (2.0 decision 12).
- **Lane files and plans** written for 2.x stay readable; ownership lines become hints, `Difficulty:` and `Kind:` are
  plain text for the architect.

**16. Staged rollout, measured against the 14 runs.** (O7: remove parts one at a time and measure)

| Stage | What runs | Measured against |
|---|---|---|
| 0 | Plan 45 (the bridge) on 2.x. | The 14 runs. Isolates what notices, outcome gates and plan freedom buy by themselves. |
| 1 | The SQLite state (D13), with the read-only import of the finished 2.x runs. The architect loop (D1–D3), the daemon reducer (D4), stall and caps (D10), landing (D11), standing roles (D12) on 3.0.0-next, still on the shared milestone tree. Judge, decision model, acceptance milestone, landing parks, auto-rerun, role lock and admission tick deleted. | Stage 0 and the 14 runs. |
| 2 | Per-writer worktrees and merge (D5), streaming fast checks (D6), the oracle rule (D9). | Stage 1. If isolation does not reduce blocked minutes, it is reverted (O7). |
| 3 | The 2.0 scorecard's four fixed tasks plus replays of three of the 14 runs (one big: P8; one with the [walls] loop: P6; one landing-heavy). `latest` moves on the owner's word after it passes. | All of the above. |

Metrics per run, as queries over the D13 database (the scorecard's existing fields plus four):

- wall time; **idle %** (time with no role running; baseline 36%); **average concurrency** (baseline 0.7–0.94);
- **blocked minutes** by reason (baseline 448 min of 1,313 worker min);
- check minutes as a share of wall (baseline ~35%); rounds per task; interventions and owner questions (baseline
  every one answered yes);
- cost; standing-role start latency (D12);
- output quality: verifier FAILs that were real bugs, MR first-pass, Known issues count, bugs found after merge.

Pass bar for `latest`: no quality metric worse than the baseline; wall time and idle % better; zero process-audit
FAILs; zero landing parks.

## Rejected alternatives (whole-design)

- **Keep the 2.0 machine and tune its transitions.** The 14 runs show the waste is the transitions themselves; each
  tuning (plan 45 included) removes one wall and keeps the shape. Plan 45 is kept as the bridge, not the end.
- **Peer-to-peer agents with no coordinator.** The owner wants free talk; the evidence (CooperBench, Cognition) finds
  open peer negotiation harmful. 3.0 lets anyone talk on the team channel, with notices and questions as the default
  content, and keeps one brain that decides.
- **A learned router in place of the decision model.** Possible later, trained on catherd's own `outcomes.jsonl`; not
  before the ladders have been measured.

## Open questions for the owner

- **Q1. Multi-MR runs.** D11 makes one feature branch and one MR per repo the default, which removes the
  "merged: MR !N" wait and the pin-bump chain ([chain]). Keep the 2.0 milestone-per-branch mode (stacked MRs, each
  merged in order) as an option the architect may choose, or drop it? Recommendation: drop it; a large change is
  split across runs instead.
- **Q2. The architect's own rung family.** D8 makes reviewers cross-family to the author. The architect is the
  author of the plan and the integrator. Should its default ladder be a different family from the default worker
  ladder (for example a Codex architect over opencode and Claude workers)? Recommendation: yes, set by `init`, and the
  owner's profile wins.

Everything else is ruled above. Rulings the builder may revisit with evidence: the 70% context threshold (D1), the
ledger's 40-entry window (D2), the default caps (D10), the standing-role cap of 4 and the 30 s warm-pool trigger
(D12).
