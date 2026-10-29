# Ideas

Improvements collected from real catherd runs and from designing it, not yet planned. When one is picked up it moves
into a spec or plan under `docs/specs/` or `docs/plans/` (or a GitHub issue) and leaves this list. One entry per idea: what, why
(the evidence), and where it would live.

After 2.0 the list holds the follow-ups the reviews of plans 28–35 and 21–26 left open (each one's code is still in
2.0, checked against the head of plan 36), the longer-term ideas ("Routing and cost", "Orchestration", "Later" and
"Live coverage" below), and what the scorecard finds.

Shipped, so not re-proposed here: `catherd doctor`; quota failover; preflight; per-repo knowledge (`knowledge.md`,
keyed by the repository's git origin, its toplevel when it has none); the run budget (from 80 % routing starts at
the cheapest rung that clears the bar; once spent, `E_RUN_BUDGET` pauses the run); a plan in hand (`run_start`'s
`plan:`); lint and type check in each lane's fast check; and the decision model, which picks the rung of every dispatch and
judge on the role's exact brief (plan 44). Since 2.0 the daemon runs all of it (MIGRATION.md, "From 1.5 to 2.0").

## 2.0 follow-ups

### From plan 53 (streaming fast checks)

Left out of plan 53 on purpose:

- **A fast check runs on the shared run tree.** Another task's half-written work can turn it red, and catherd cannot
  tell whose failure it is; the architect decides. Per-writer trees (spec D5) make it the task's own work on top of
  the integration branch, and a red one then goes back to the writer's thread by itself.
- **No `check {ref}` yet.** A check on a commit in its own tree waits for D5's trees; until then a full check is proof
  only for a tree no writer changed while it ran, and the architect is told to start it when no writer runs.
- **The verifier still waits for the full check.** Land final needs both green on one commit, so the verifier could
  run beside the full check and save one serial check per land; spec D8 has it read the full check's result first.
  Measure the check wait on stage 2 before changing D8.
- **A red notice goes to every role.** Narrow it to the running writers if it shows up as noise in their replies.
- **A fast check is not rerun when a sibling ends.** A fast check that went red on a sibling's half-written work stays
  red until the architect asks again.
### From plan 54 (the oracle rule)

Left out of plan 54 on purpose:

- **On the shared tree an oracle diff is the task's window, not its author.** Any edit to the oracle while the task
  worked (another writer's, the architect's) is held against it. Per-writer trees (spec D5) make the diff the
  writer's own; move the check to the merge then.
- **An oracle set after a task was delegated does not cover that attempt.** Its tree was not snapshotted; the next
  attempt is covered.
- **An oracle snapshot has no ref.** After a `git gc --prune=now` land final cannot prove a restore, so the hold stays
  until the architect accepts it.
- **"Rewritten" is per file.** An existing test file that lost lines is listed with the count; which test inside it
  changed is the verifier's to read.
- **Removed-test detection reads single-line declarations only.** `it.each` tables, test names split over several lines,
  Rust `#[test] fn` and Go suite methods (`func (s *S) TestX`) are not named as removed; a parser per language would.
- **A base merge that touches an oracle file reads as a missing restore.** Land final compares HEAD with the held
  snapshot, so files the base changed are refused with "accepted or restored"; the message should say the base moved them.
- **Settle replays the whole event log** for each ended worker (`oracleChange` reads the run state to find the earliest
  held base); a long run pays it once per dispatch, so pass the state in if it shows up in a profile.

### From plan 52 (stage-1 fixes)

Left out of plan 52 on purpose:

- **A quota limit still counts as a failed architect turn.** Three limits in a row (every rung of a two-rung ladder,
  then one more after the hold) stop the run. A limit is not the architect's failure; count it apart when a real run
  stops this way.
- **Failure identity is the normalized failing line.** A runner whose output has no line `checkFailLines` reads gets
  `unknown`, and the architect judges it as before. Per-runner parsers (Go test JSON, JUnit XML) would make more
  results comparable.
- **A fast check never runs the base.** It compares only with a base result that already exists; the inherited rule
  is the full check's.
- **A check that failed on the base and stays parked.** A run that reached `needs_user` after a broken gate waited 9 h
  for the owner; the inherited rule removes the cause seen, not the wait. A cap on a parked run's wait is open.
- **A retried check id on the base row.** `checks` is `UNIQUE(run_id, check_id)`, so a retried full check writes its
  `<id>-base` row twice and the second insert fails; the verdict then falls back to `unknown`. Give the base row a
  per-attempt id.
- **Two concurrent failing full checks both run the base on one commit.** The base result is cached only after the
  first run ends, so two checks that fail at once each check the base out and run it. Serialize them per base commit.
- **The lock leak was not reproduced on the plan's machine.** The suite passes with `CATHERD_LOCK_HELD=1` there; Bun's
  `Bun.spawn` without an `env` inherits the variable even after `delete process.env`, so a test that spawns without
  an explicit env still could. The guard test pins the lock tests only.

### From plan 51 (converging reviews, the ui-reviewer fold, the metrics)

Left out of plan 51 on purpose:

- **The reviewer eval set is recorded, not replayed.** `review.missed` events list every bug a review missed; running
  a rung against them to score it is stage 4's.
- **The shipped reviewer ladder is one family.** A default review of the default (gpt) workers is `same-family`; a
  headless Claude rung in the shipped ladder would make a Codex-only machine need Claude Code. The owner adds a rung of
  another family to his profile.
- **A review snapshot has no ref.** A `git gc --prune=now` during a run loses it, and that re-review reads the whole
  tree instead of the diff.
- **A model family is the model name's first part.** One lab under two prefixes reads as two families; read the
  catalog's lab if that happens.
- **Standing-role start is to the dispatch's start,** not to its first output, which nothing records yet (spec D12).
- **`PARK_REASONS` keeps every value.** It is the read vocabulary of earlier runs; only `owner` and `land` are written.
- **The climbs metric counts any change of rung.** A reviewer's family switch and a downward change count too; it
  should count only climbs up the ladder.
- **`roleMs` in the concurrency metric is not clipped by pauses.** A dispatch that spans a pause counts its paused
  minutes, against R21.
- **A re-review sees only the previous round's findings.** It should see every earlier round's since the last ledger
  edit, so a finding fixed two rounds ago is not reported again.

### From plan 50 (landing and the one verifier)

Left out of plan 50 on purpose:

- **Stage 2 is not here.** Per-writer worktrees, the merge into the run's tree, `check {ref}` on a writer's tree and
  the memory-bound writer cap need spec D5's stage 2. `infra/memory.ts` stays for it.
- **The run's tree gets no `.env*` files.** A repo that needs them names a copy in the plan's `Setup:` line.
- **`land` cannot tell a squash merge.** The owner's answer to the merge question ends the run; catherd never merges
  and never checks that the MR merged.
- **The verifier's RAN rule is read from its reply only.** A PASS whose RAN lines name commands it did not run is not
  caught; the check rows are the proof the land gate trusts.
- **A forge CLI that is missing or not signed in** leaves the branch pushed and the MR unopened; the land message
  gives the command. No token is read or stored.

### From plan 49 (ladders)

Left out of plan 49 on purpose:

- **Listings refresh only at `doctor`, `init`, setup and `catalog refresh`.** The daily refresh at dispatch went with
  the decision model (`freshenDiscovery`); a listing can go stale between them. Fix: refresh at `run_start` if runs
  show a stale listing refusing a rung.
- **No `memory` block is written by the migration.** D16 names it; it comes with memory (D14, stage 3).
- **An earlier run's judge dispatches are not shown.** `judge` left `ROLES`, so their admit files and events no longer
  parse and are skipped. Fix, if an owner misses them: read an unknown role as a plain string in the read-only views.
- **A ladder that goes down still climbs to a weaker rung.** The migration keeps the stored order (R1); `profile
  validate` warns. Fix: refuse a descending ladder at `run_start` if runs show it.
- **M2:** `migrateProfiles` does not re-sync native agent files, so a native `claude:` architect file keeps its
  `disallowedTools` until `doctor` relinks it.

### From plan 48 (the reducer, caps and stall)

Left out of plan 48 on purpose:

- **Failover on a quota hold is not wired into the reducer.** A task on a held rung waits for the hold; plan 49's
  ladder never climbs on a quota limit (D7), so this is still open.
- **The idle cap is still plan 47's two idle turns,** not D10's 15 minutes with nothing running; and the budget's 80%
  is shown by `capabilities`, not a wake.
- **The stall rule needs no fingerprint hash.** A same-rung retry after a failed attempt with no ledger edit, owner
  answer or check result in between is refused; a plan-file edit alone does not count as news.
- **The events lock stays.** `withEventsLock` still guards `answer` and `delegate_task`, which check state and append
  in one step (plan 46's R4).
- **"attempt n of N" counts later attempts** when a ledger task's attempts run in parallel; the end line should use the
  task's position in its attempts instead of how many exist when it ends.
- **A cap stop leaves the architect's own `workspace-write` turn running.** The stop cancels the tasks, not the turn;
  it ends by itself, but it can still write to the tree after the run is called stopped.
- **The D16 refusal falls back to `<its version>`** (`run-client.ts:46`) when the run has no `daemon.started` to name
  the build that owns it.

### From plan 47 (the architect loop)

Left out of plan 47 on purpose:

- **The 70% context threshold.** A fresh thread starts after a failed turn, a daemon restart, a rung change or a spent
  thread (`threadHeavy`, past 8M input tokens). Starting one at 70% of the model's window needs the window in the
  catalog (spec D1).
- **A fixed writer cap.** Four writers and four standing-role tasks at once (`WRITER_CAP`, `STANDING_CAP`); the
  memory-bound writer cap comes with per-writer trees (spec D5, stage 2).
- **One tree per run.** A base run's writers share its integration tree (plan 50); per-writer trees, `check {ref}`
  and the merge into the integration tree come with stage 2 (spec D5).
- **Messages do not wake the architect.** A worker's question rides the next digest; the turn that ends the worker's
  task wakes it. Make a `question` message a wake event if runs show workers idling on an answer.
- **A researcher may write any research file.** `write_run_file` takes `research/<id>.md` for every role that has it,
  not only the task's own path (spec D12).
- **`ROLE_WRITABLE` also accepts `research/*.md` on 2.0 runs.** The widening is global, not scoped to the architect
  engine.
- **Two tools take a nonsense argument.** `ask_owner` accepts a scope that names an unknown task, and `delegate_task`
  accepts a task that is only whitespace.
- **The owner's tasks and checks do not wake the architect.** One the owner starts leaves no waking item when it ends.
- **`thread_wait` reads the wall clock.** It uses `Date.now()` and `Bun.sleep` instead of `deps.now()`, so a test
  cannot drive it.
- **The role server's `from()` falls back to `context.role`.** Workers without a role scope share the name `worker`.

### From plan 46 (the run-state database)

Left out of plan 46 on purpose:

- **The lock files beside the transactions.** `events.jsonl.lock`, `runs.jsonl.lock` and `team.jsonl.lock` still give
  the writers their mutual exclusion, and each write is one transaction inside the lock (R4). The lock is needed
  because `withEventsLock` and admission hold it across awaits. Plan 48's reducer makes each write one transaction and
  drops the locks.
- **Files still beside the database.** `outcomes.jsonl`, `routes.jsonl`, `state.json`, `sessions.jsonl`,
  `agents.jsonl`, `harness.jsonl` and a workspace's `meta.json` stay files (R5): plan 50 deleted the first two, and
  the rest move when their mechanisms move or go.
- **One backup per day.** `backups/catherd-<date>.db` is replaced by every run that ends the same day, so a busy day
  keeps only its last end (R9). Keep one per run end if a bad write ever needs an hour-level restore.
- **The run index and the session view read every record of every run per poll.** That defeats the run index cache.
  Key the cache on `count(*)` / `max(id)` for a run's rows and on the file stamp for a run's files.
- **Runs started by an M1-only build are never imported.** Their records stay in `runs.jsonl` and their events in the
  database, so the import (events.jsonl with `run.ended`) does not see them; they stay readable on their own files.

### From plan 45 (outcome gates)

Left out of plan 45 on purpose:

- **Live steering for Claude Code and Codex.** The architect's and the owner's team messages steer a running opencode
  lane only; the other backends read them in their next brief. Claude Code needs `claude -p --input-format
  stream-json` with the supervisor holding stdin open, and Codex needs `codex app-server` instead of `codex exec`: a
  long-lived session per role and a supervisor change, about a plan each (R9).
- **A verifier beside the milestone Check.** P8 spent 282 of 735 minutes idle while the Check ran. Superseded by the
  architect-led redesign, which replaces the per-milestone verifier (R16).
- **The review-finding dedupe.** A reviewer re-reports its own findings (`reviewer-M-2`) and re-raises dismissed
  ones (P8 M3, P6 M50/M51/M53). Superseded by the redesign, which replaces the judge (R16).
- **A sibling block that names only a symbol.** A stop waits for a sibling only when it names one of the sibling's
  files; a stop that names a function or type of a sibling, and no file, is dispatched again (R5).
- **Isolation per writer.** Lanes of a milestone share one tree, so two writers can still meet on a file. The
  redesign owns isolation (owner).

Found by the plan 45 final review, left as minors:

- **`team_wait` returns at once for a `pending` sibling.** A sibling admitted but not started reads as not running,
  so the wait ends before its code exists. Fix: treat `pending` like running.
- **Sender matching by name suffix.** A message's sender is matched to a dispatch by the end of its name, with a
  fallback to the `worker` and `owner` labels, so two dispatches with the same suffix can be confused. Fix: match the
  full dispatch name from the role scope.
- **`env -u CATHERD_ROLE` posts as the owner.** Any role that unsets its role variable can send a team message that
  steers like the owner's. Local only, since every role runs on the owner's machine. Fix: tie the owner to the CLI's
  parent session, not to a missing variable.
- **An opencode steer with an empty 2xx body delivers twice.** The steer reads an empty answer as a failure, so the
  message stays queued and reaches the next brief as well. Fix: take any 2xx as delivered.
- **No tests for the `catherd team` CLI and the role server's team tools.** `test/services/team.test.ts` covers the
  service only. Fix: one test per CLI form and per role-server tool.

### From plan 44 (the decision model and the briefs)

Left out of plan 44 on purpose, or found while building it:

- **The milestone Check has no failure class.** A dispatch's fix round knows whether a failure is `product` or
  `harness` (D9), but a milestone Check that fails is not classed, so a broken environment still costs a product fix
  round. Fix: class a Check failure the same way, and give a harness failure the one repair outside the round count.
- **A harness clamp for opencode.** Claude Code and Codex cap a shell command's output (plan 44 D12); opencode has
  no such setting yet, so a noisy command can still fill its context. Fix: add the clamp when it gains a setting. opencode's scratch `TMPDIR` is the only guard for now.
- **The scorecard targets are not measured on a live run (B16).** Targets: the worker brief median under 20 KB, no
  verifier PASS without executed commands, and zero stops from another role's duty. Fix: run a real plan on the
  `@next` build, read the report's "## Scorecard" table, and record the numbers here or in the scorecard doc.
- **The claude-code clamp does nothing.** `BASH_MAX_OUTPUT_LENGTH=30000`
  (`src/adapters/claude-code/index.ts:272`) equals the CLI's own default, so it changes no run. The real clamp is the
  newer `bashOutputMaxChars` setting. Fix: set that, in the role's settings, to a value below the default, and check
  that a long command output is cut.
- **A resumed dispatch's full brief has no test.** A resumed composed dispatch writes `brief-full.md`
  (`src/services/admission.ts:80`) and the stand-in brief points at it; no test reads the file or the path for a
  resumed thread on a stand-in. Evidence: reviewer-M6 NIT of plan 40 (seq 353), still true after plan 44. Fix: one
  assertion in the resumed-dispatch test.

### From plan 40 (run 20261024-133108-plan-40-run-efficiency)

Defects the run's lanes and reviews reported, which plan 40 did not fix:

- **The plan lint warns twice for one A-line.** `lintPlan` (`src/domain/plan-lint.ts`) scans the milestone section and
  the run's `aLines`, so an A-line in both gets the commit-history warning twice. Input that shows it:
  `lintPlan("## M1\nCheck: x\nA1 — list the commit history\n", "M1", ["A1 — list the commit history"])`. Warnings
  only. Evidence: verifier-M1 NIT, seq 123. Fix: scan each A-line once.
- **`coveredDir` reads `cd` with a regex, not a shell.** `coveredDir` (`src/domain/fail-lines.ts`) matches `cd <dir> &&`
  as text, so a sourced file that changes directory still counts as one covered directory. The code carries a
  `shortcut:` comment for it. Evidence: verifier-M1 NIT, seq 123. Fix: treat an item that sources a file, or whose `cd`
  the regex cannot place, as whole-tree.
- **A waiting cycle of three or more lanes can deadlock.** The guard at `src/domain/run-state.ts:752` checks only that a
  lane does not wait on the lane it blames, so L1 waits on L2, L2 on L3 and L3 on L1 can each blame the next lane and
  never finish. Rare, and it holds no milestone. Evidence: reviewer-M5 NIT, seq 307. Fix: follow `waitOn` transitively
  from the blamed lane back to this one.

Ideas the plan leaves for this file. The evidence is the event or code cited; where this run shows nothing, it is the
2026-10-24 run-efficiency studies that plan 40 names as its source.

- **The ui-reviewer runs with no way to log in, or on screens that are stubs.** A review of a login page or a
  placeholder cannot show the screen the milestone changed. Evidence: the 2026-10-24 studies; plan 40 changed no UI.
  Fix: the ui-reviewer's brief names how to log in, and a stub screen is reported as not reviewed.
- **A retry when idle for load-induced timeouts.** The retry after a timeout under host load does not wait for the host
  to go idle. Evidence: the 2026-10-24 studies. Fix: wait for the load to drop before the retry, and count that wait
  apart from the tries.
- **A squash merge does not advance the base for dependants.** Dependants of a squash-merged milestone stay blocked until
  the owner answers the push question, because catherd does not count a squash as a merge. The rulings are
  `docs/plans/2026-10-21-35-milestone-branches.md` (Ruling 13) and `docs/plans/drafts-1.6/2026-10-12-33-milestone-branches.md`
  (Ruling 9). Fix: treat a squash whose tree matches the landed commit as merged.
- **A per-run `pause --run` scope.** `catherd pause` is machine-wide: the refusals name "the machine is paused" (seq 194),
  not the run. Fix: `pause --run <id>` stops one run's admissions, and the machine pause stays for every run.
- **Milestones start by remaining critical path.** This run started each milestone when a predecessor landed, in ID
  order: `tree.ready` at seq 7, 13, 26, 129, 278 and 313. M5 and M6 started a few events after M4 and M5 landed (seq
  274 and 309). Whether a path-length order starts them sooner is not measured. Fix: order the ready milestones by the
  work left on the critical path, and record the order.
- **Tearing down compose stacks a gate started.** A gate that starts compose stacks leaves them running after it ends.
  Each milestone tree now has its own compose project name (plan 43, D16), so stacks of two trees no longer collide;
  nothing stops them. Evidence: the 2026-10-24 studies; no compose stack ran in this run. Fix: the gate runs
  `compose down` for each stack it started, as its last step. A `compose down` on land is not the fix: catherd cannot
  tell which stacks a gate started.
- **An owner ruling never reaches later lane briefs.** The owner's answer at seq 81, that M1.L4's no-Check warning is
  intended, is recorded against M1.L3 only, the lane parked on it. No event shows it reaching another lane. Fix: write
  a ruling into the run's ledger and into the brief of each later lane it touches.
- **The daemon does not alert after ENOSPC.** After a full disk the daemon loop stops; the daemon then waits until the
  disk has its reserve again and runs once more, replaying the run (plan 43, D18). Nothing tells the owner. Evidence:
  the 2026-10-24 studies. Fix: notify through the run's notify url on ENOSPC.
- **`status` prints one collected line per dispatch.** A run with many dispatches prints a long list where one line per
  unit would do. Evidence: the 2026-10-24 studies. Fix: print one line per unit, with its last dispatch.
- **A merge that deletes the run's base branch.** A merge that deletes the branch a run started from leaves its
  dependants with no base to integrate into. Evidence: the 2026-10-24 studies; no event in this run. Fix: refuse to
  delete a branch that a run's base names, or leave it in place after the merge.
- **Skipping the daemon's fast-check rerun when the worker's passing run is recorded.** A lane's passing fast check on
  the head could stand in for the daemon's rerun. M2.L2 removed a rerun skip in its fix round (seq 75, "the rerun skip
  is removed"), so the idea needs the recorded run to name the same head and the lane's files to be unchanged.

### From plan 38 (the ideas sweep, run 20261023-025529-ideas-sweep-plan-38)

- **The judge's first rung skips `maxEffort`.** `rungFor` (`src/services/run-effects.ts:255`) takes
  `profile.roles.judge?.rungs[0]` as is, while a routed rung goes through `effortAllowed`, so a judge rung above its
  cap still runs. Found while planning plan 38. Fix: pick the judge's first rung within `maxEffort`, or refuse as
  validate does.
- **`run_start`'s fix follows only the first role's cause.** When two roles have no rung for different causes (one
  the cap, one the index), the message names both, but `fix` is chosen from `start.unusable[0]`'s cause only
  (`src/services/run-service.ts:154`). Fix: one fix per cause group. (Plan 38 M5 verifier, NIT.)
- **A workspace child's merge check runs outside the admission lock.** `startWorkspaceChild`
  (`src/services/workspace-service.ts:161-167`) checks `dependencyBlockers(…, { merge: true })` before the lock, on
  purpose (git outside the lock), so a dependency could change between the check and `childFor`. The M5 verifier
  judged it harmless (a merge does not un-merge), but the Codex review of PR #83 found a real case: a dependency
  milestone landed again while the call waits for the lock passes the pre-lock check on the old ledger commit, and the
  locked recheck does not compare commits, so the child starts on a commit not yet in base. Fix: capture the checked
  commit before the lock and require the same `landedCommitOf` under it. (Plan 38 M5 verifier NIT; Codex P2.)
- **`status` lists a finished 1.5 run as unfinished, with empty metadata.** Before `run_start`, `status()` with no run
  returned a 1.5 run (`engine 1.5`) with `phase: null`, `outcome: null`, all 10 milestones `landed` but
  `commit: null`, `title` equal to the id, `startedAt == updatedAt` and `elapsedSec: 0`. A run whose milestones all
  landed should read as finished, and the 2.0 server should read a 1.5 run's title, commits and times.
- **An owner's answer does not stick to the lane.** After the answer that dropped that docs step, the daemon kept
  running the unchanged fast check (`check.ran` exit 2 at seq 150, 163, 186, 195), the lane climbed to the top rung
  (seq 164, 198), and a judge skipped the step (seq 210). In M2's fix round the lane went out on a fresh thread
  (seq 251) with the step still in its check and parked a third time (seq 290): about ten worker dispatches, two
  climbs, one judge and three owner round trips on a step that cannot pass. Fix: an answer that drops a check step
  edits the lane's `Fast check:` (or records a waiver the check honours), and a judge `skip` carries into later
  rounds of that lane. (Run audit 22.)
- **A plan-backed run maps no A-line, and the digest shows only the last review round.** M1's digest said "A-lines:
  not mapped to this milestone (none cited as A<n>)" and listed all six: a plan written before the run does not cite
  the run's `A<n>`, and a one-milestone mapping does not apply to six milestones. The same digest said "Reviewer:
  reviewer-M1 · 0 finding(s)" after three review rounds, so rounds 1-2's findings are invisible. Fix: the architect
  maps the A-lines onto milestones when it turns a plan into `plan.md`; the digest sums findings over every round.
- **A push takes two parked round trips per milestone.** M1 parked for the push, then again for the MR. With
  `land.autoMerge` off it still does.
- **A gate recorded in a broken env cannot be re-recorded.** The gate cache is keyed by HEAD only, not by the env it
  ran in: a verifier's second and third `gate run` on M6's head returned the same cached failed record, `land` reads
  it, and that head can never land without a new commit. Fix: let a verifier re-run a gate (a `fresh` flag), or key
  the record by its env too. (Run audit 7.)
- **An unattended coordinator asked an interactive question, and the run sat for six hours.** Five parked questions
  (M2-M6) waited from 04:16 to 10:05 UTC while the coordinator showed a question menu in a terminal nobody watched;
  the phone notices carry only catherd's own parks. Fix: the catherd skill tells a coordinator that runs unattended
  never to ask interactively: rule, record the ruling, and send what needs the owner to the run's notify url.
  (Run audit 25.)
- **The run audit's open findings.** The five-lens audit
  (`docs/dev/reports/2026-10-23-plan-38-run-audit.md`) leaves these items outside plan 39. Finding 7: a verifier gate
  inherits role and scratch variables, and cached failures cannot be re-recorded; 14: milestone starts serialize on memory checks, and cancel leaves orphan parks and trees.
  Evidence: report findings 7 and 14.
  Findings 15–19 also remain open: lane ownership can omit tests of changed exports (15); reviewers do not run tests
  (16); unchanged findings repeat across rounds (17); malformed role replies can pass parsing (18); architect
  requirements can contradict tasks, and known issues can contain a verifier reply split into lines (19). Evidence:
  report findings 15–19, including M2.L1's contradictory requirement and the cancelled run's split reply.
  Finding 25 remains open: an unattended coordinator can ask an interactive question that no one sees. Evidence:
  report finding 25, where five questions waited from 04:16 to 10:05 UTC.

- **New catherd findings from plan 39.** Evidence below comes from plan 39 milestone verifier findings and reviewer
  records; these items were not fixed by plan 39:
  - **Loopback addresses are partly normalized as ports.** `normalizeFailLine` turns `127.0.0.1:43211` into
    `<port>.0.0.1:<port>`, so the displayed address is wrong. Evidence: M1 verifier finding in
    `src/domain/fail-lines.ts`; M1 landed known issue.
  - **The Codex catalog fallback can lose a run record.** `finalize` lets an unreadable pinned catalog throw when a
    backend provides no cost, rather than leaving the cost null. Evidence: M3 verifier finding at
    `src/services/finalize.ts:217`.
  - **A full-suite test is order-dependent.** `test/services/run-effects.test.ts:826` fails in full-suite runs but
    passes alone, including on the base. Evidence: M4 verifier's full-gate report.
  - **The report can mislabel a failed finish.** `run-report.ts` derives the headline from state and can print
    `Outcome: done` when the finish action outcome is `failed`. Evidence: M4 verifier finding at
    `src/services/run-report.ts:145`.
  - **Notification excerpts retain fenced code.** Removing the fence markers leaves the code text in the excerpt.
    Evidence: M4 verifier finding at `src/domain/notify.ts:30`.
  - **The step summary truncates on a narrow screen.** At 390px, “Steps” appears as “ST…”. Evidence: M5 UI review
    screenshot `shots/M5-r2-waiting-mobile-dark.png`, with the summary at
    `web/src/routes/_app/runs/$runId.tsx:171`.

- **Coordinator findings from the plan 39 run** (run `20261023-105527-run-audit-fixes-plan-39`; seq numbers are its
  `events.jsonl`):
  - **A host session's MCP server older than the run's daemon goes silent.** The coordinator's `catherd mcp` started
    from an npm build; `bun link` then pointed the global command at a newer checkout, and the daemon started from
    it. From seq 22 (`report.posted` kind `memory`) the old server could not replay the log: no channel message for
    any later park (seq 37 and 44 waited about 15 min until the owner noticed), and `status()` returned
    `E_RUN_CORRUPT … restore events.jsonl from a backup`, while every line validates against the daemon's schema.
    Fix: an unknown newer event is a version error ("restart your host session"), never "corrupt"; the server compares
    its version with the daemon's on each read.
  - **A fresh milestone tree has no dependencies.** M5.L2's preflight ran the web typecheck before anything installed
    `web/node_modules` and parked `preflight` (seq 240, `tsc: No such file or directory`, exit 127). Fix: the tree
    setup runs the repo's install for each package a lane's check touches, before preflight.
  - **A land-path regression surfaced only at review round 5.** M1's change made `land` need a per-item machine
    record, and `passGate` in `test/services/helpers.ts` wrote none, so `test/services/protocol.test.ts:519` failed
    from round 1; lane fast checks run only their own test files, so the verifier caught it at round 5 (seq 348).
  - **Codex dispatches stay unpriced in a run whose daemon predates the catalog pricing.** 68 Codex dispatches carry
    `costUsd: null` (24 Claude Code dispatches are priced), so the run's $24.03 covers Claude Code only. Plan 39 M3
    prices Codex from the catalog; the next run on this build should show it.
  - **`checkItems` keeps a command with an unquoted `${…}` whole.** Safe, but such a check is not split into items.
    Evidence: verifier NIT on the Codex-fix run, `src/domain/fail-lines.ts`.
  - **`worktreeIdentity` reads every tracked and untracked file on each fast check.** Correct, but slow on large
    trees; a stat-keyed cache would avoid re-hashing unchanged files. Evidence: verifier NIT on the Codex-fix run,
    `src/infra/git.ts`.

- **A public panel URL for phone links.** The panel binds to `127.0.0.1`, so phone notices cannot open it from
  another device. Evidence: `CLAUDE.md:17` and plan 39 decision D16; choosing a public URL is a product decision.

### Found while hardening 2.0 (plan 43)

Found by the plans 41–42 audit, the platform run and the credit run. Plan 43 does not fix these.

- **A memory deferral does not say how its need is computed.** The platform run's message read `6266 MB available,
  8192 MB needed`, with no account of the 8192. `neededMb` (`src/domain/milestone-memory.ts:44`) computes it, and the
  message (`src/domain/run-state.ts:1704`) prints only the result. Fix: the message names the reserve, the share per
  milestone and the count it covers.
- **A land refusal's fix text names `gate_pass` but not `gate_check`.** `gate_pass` needs a matching `gate_check` step
  first (`src/services/gate-service.ts:491`), so a fix that names only the first leaves out the step it needs. Fix:
  the land refusal's fix names both calls, in order.
- **A dispatch shows "ended failed … fast check green", with its cause only in `runs.jsonl`.** The credit run's
  `Step interrupted` cause is in the runs log and nowhere the owner reads a status line. Fix: the status line names the
  dispatch's recorded cause.
- **A second landed sibling whose base moves before the owner's merge answer is not re-integrated.** Credit run, M31
  and M33. Fix: integrate a landed milestone again when the base it was cut from moves, before its merge is asked.
- **A Check's 177 s stall has no wait recorded.** M20's Check in the plans 41–42 run stalled for 177 s, and no wait was
  recorded, so the report does not say where the time went (audit C5). Fix: record the time a Check waits as a wait.
- **`execMilestoneCheck run by a verifier role` is flaky under load** (audit C6). Fix: find the timing the test depends
  on, and remove it.
- **The report's minutes are the time since the previous landing.** A milestone's minutes start when the one before it
  landed, not when it started (audit C7). Fix: count each milestone's minutes from its own start.
- **Round counters skip numbers** (audit C8). Fix: number a milestone's rounds in order, with no gap.
- **A worker's screenshots keep a milestone tree** (audit C9). Fix: keep screenshots out of the tree, or remove them
  with it.
- **A fix round waits for every reviewer of its round** (audit C10). Fix: start the fix round once the blocking
  reviewers have reported.
- **The no-verifier path is unreachable when A1 is "as written"** (audit C11). Fix: decide whether a run without a
  verifier exists, then either make the path reachable or remove it.
- **The memory `tree.deferred` carries no `resource`.** The disk deferral sets `resource: "disk"`
  (`src/services/run-effects.ts:1141`); the memory one (`:1129`) leaves it out, so the event does not name the resource
  it waited for (audit C13). Fix: set `resource: "memory"` there too.

### From the plan 28–35 reviews (2026-10-21)

- **An explicit rung for a lane-less dispatch skips the floor and the cap.** `else rung = i.rung`
  (`src/services/dispatch-service.ts:457`) takes the caller's rung as is, while a lane's rung goes through routing,
  which applies `CODING_FLOOR` and `maxEffort` (`effortAllowed`, `src/domain/select.ts:40-52`). Fix: refuse or warn
  for a coding role's rung below the floor or above its cap, as validate does for the rungs.
  Nothing calls it since 2.0 (plan 38 triage).
- **A task's signature and test are found by pattern.** `parsePlanDoc` (`src/domain/plan-doc.ts`) calls any code block a
  signature and any `Expected:` line a test, so a task with only a shell command passes preflight. _Where:_ ask
  the judge at `readPlan`, whether each task names what its worker must build.
- **A last milestone that never merges keeps the run alive until the push answer.** In a base run `isFinished` (merged)
  gates the run's end (`src/domain/run-state.ts:254`, `src/domain/run-machine.ts:478`), as plan 30b's ledger ruling
  says; if the owner never merges it, the run waits on the push question forever. Fix: end the run when the last
  milestone is landed and the push question has been answered, and say that the merge is still open.
- **In a base run `updateState` and the skip path read the main checkout's HEAD.** `updateState`
  (`src/services/state.ts:51`) takes `gitHead(run.meta.repo)`, and the skip path's `fullCommit(run, "HEAD")`
  (`src/services/lane-service.ts:357`) resolves in the repo as well, while the work is on the milestone's branch in
  its tree. Neither is reachable from the daemon today; a caller that reaches them in a base run gets the wrong
  commit. Fix: resolve them through `treeOf(run, milestone)`.
  The skip path has no caller since 2.0 (plan 38 triage).

### From the 1.5 plan reviews (2026-10-02, still open)

These concern code 2.0 kept: the 1.5 notifier, end push and `result` paths still serve a run started on 1.5, and the
services behind the removed session tools stay for the CLI.

Plan 22 (delivery and the loop) review:

- **`thread` is checked against records a claim has not written yet.** `threadFor` reads `runs.jsonl` before
  `claim()`, which finalizes finished dispatches that lack a record, so `thread: "latest"` can resolve to an older
  thread and an explicit newer thread is refused. Evidence: `src/services/dispatch-service.ts:297-321` (called at
  :354, before `claim`). Fix: also accept the threads of finished, unrecorded dispatches (`admit.thread` or the
  stream's thread), or finalize the name's finished dispatches before the check without claiming. (M1.)
  Nothing calls it since 2.0 (plan 38 triage).

Plan 23 (verifier, gate and environment) review:

- **The login env is captured synchronously.** The capture's `spawnSync` blocks the MCP server's event loop for up
  to 5 s, once per process (`src/infra/login-env.ts`). Fix: capture it asynchronously, or at boot, off the request
  path. (Minor 2; the chatty-profile parse is fixed.)

Plan 24 (routing and cost) review:

- **An explicit rung on a routed lane goes unchecked and unrecorded.** A lane dispatch with an explicit `rung` on a
  lane already routed is neither checked against the lane's ladder nor written to `routes.jsonl`. Evidence:
  `src/services/dispatch-service.ts:364-366`. Fix: refuse (or warn on) a rung off the ladder, and record the rung
  dispatched as a route row. (Minor 5.)
  Nothing calls it since 2.0 (plan 38 triage).

Plan 25 (runs, programs and lanes) review:

- **Two open questions on one milestone share one parked span.** `parkedSpans` opens a span on a question only when
  none is open, so a second question asked while the first is open is closed by the first answer, and the minutes
  after it stop being excluded. Evidence: `src/services/questions.ts:43-54`. Fix: count open questions (a span ends
  when the last open one is answered), or pair each answer with its question id. (Minor 2.)

Plan 26 (the minors sweep) review:

- **A skipped first landing says "changed nothing".** When the first milestone lands with skip and its commit equals
  the run's start head, the range is empty and the message reads "<commit> changed nothing" instead of "nothing
  committed since the run started" (it fails safe). Evidence: `src/services/lane-service.ts:368-373`,
  `milestoneFiles`. Fix: special-case commit == startHead with the clearer message. (Minor 2.)
  The skip path has no caller since 2.0 (plan 38 triage).

### Found while releasing 1.5 (still open)

- **A broken check is called expected.** In the payment run `-143512`, M1.L5, a compose file valid only layered on
  another failed `config -q`, and preflight called it `fails-as-expected`. Since 1.5 only an environment error is
  `cannot-start` (`src/services/preflight.ts:204`), so a check that is broken for another reason still reads as
  expected. Fix: name the failing line in the outcome, or class a failure in the check's own setup step
  (`config`, a parse error) as `cannot-start`.
- **Clone-driven work needs a "discover, then split" step.** In the 1.1.0 platform run L4 (Task 12) stopped on
  four panel clones that `dupes` found only after the allowlist emptied, and needed a hand-written rescoped lane.
  `owns_add` (a role's tool in 1.5, off the session since 2.0) grows one lane's Owns; splitting work the gate discovers into new lanes is still by hand.
- **First-turn cost on small lanes.** A native Codex turn starts at about 280k input tokens (mostly cached)
  whatever the lane's size; an easy lane in the 1.0.0 headless test still read 583k isolated. A profile rule such as
  "isolated below difficulty build" could save most of it without touching the user's harness for real work.
  _Where:_ the profile's `harness.<backend>.isolated`, made conditional.
- **`run_start` could warn about an active Codex goal.** In the identity run (2026-10-02) a thread goal made Codex
  start a goal-continuation turn about once a minute (11 turns in 21 minutes, 7.2 M input tokens). In 2.0 the
  skill ends the turn after `run_start` and nothing polls; a warning at `run_start` when the
  thread has an active goal would catch it before the first poll.
- **Stacked pushes need `-o ci.skip` (branch pipelines held the runner).** About the user's CI practice, not
  catherd. In the payment run, pushing five stacked branches started five branch pipelines on the single runner, and
  plan 5's MR pipeline sat pending for about 30 min. Stacked pushes need `-o ci.skip`.

## Routing and cost

- **The catalog price and opencode's configured price for one model differ 5×.** The owner's review of the first
  DeepSeek V4.1 Flash lanes (2026-10-24, plan 41's source) found the two 5× apart. A run's cost is opencode's own
  figure when opencode reports a price, else the catalog's (plan 41 D2). _Why:_ the cheap tier's saving depends on
  which price a run takes. _Where:_ `src/services/finalize.ts`, `src/adapters/opencode/index.ts`.
- **A `dsh` adapter for cheap chore lanes, at a stable release.** The A/B ran on 2026-10-25
  (`docs/dev/reports/2026-10-25-dsh-vs-opencode-pilot.md`): 15 headless runs of `dsh` 0.2.1-rc.3 against opencode 2.1.4
  on the same model (DeepSeek V4.1 Flash, max, through one OpenAI-compatible gateway), three `ideas.md` tasks with hidden
  acceptance tests and blind grading. Medians: opencode 145 s, 25 tool calls, $0.0107, hidden tests 6/6, blind 7.0;
  `dsh` native 153 s, 25 calls, $0.0101, 5/6, blind 5.2; `dsh` with programmatic tool calling 124 s, 15 calls, $0.0080,
  2/3, blind 6.0. So the harness does not cause DeepSeek's slowdown, and `dsh` is no better than opencode on quality
  (worse on the hardest task). _Why:_ PTC mode may cut chore-lane cost by about a quarter; 3 runs do not show it.
  _Where:_ an adapter under `src/adapters/`, once `dsh` ships a stable release: the model set by a YAML patch (no
  `--model` flag), an isolated `DSH_HOME`, the permission mode by `DSH_PERMISSION_MODE` (rc.3 has no
  `--permission-mode` flag), cost from catalog prices (the stream has none), web tools off, `DSH_TELEMETRY_DISABLED=1`,
  `--session-id` for resume and a version pin. Re-run the A/B on PTC only, with more runs, before routing to it.
- **opencode streams carry no reasoning text.** The v2 stream has no reasoning part, so an opencode transcript shows
  the text and the tool calls, never the model's reasoning; a step's token count is the only trace of it. The research
  notes list a `reasoning` part only with `--thinking` (`docs/research/2026-09-25-opencode.md:190`). _Why:_ a reviewer
  reading a DeepSeek lane cannot see why it took a step. _Where:_ `src/adapters/opencode/transcript.ts`.

## Orchestration

- **The milestone memory defaults are a guess.** `limits.memory`'s defaults (2 GB reserve, 3 GB per milestone, 3 GB
  floor) were set from the shop run's 9 GB swap, not measured per milestone. Fix: record the peak RSS of each
  milestone's process tree on the scorecard runs, then retune the defaults.
- **Stacked milestones.** Starting M2 only after M1 merged serializes the run behind review and the gate. M2 could
  start on a branch stacked on M1 while M1's gate and MR run, and rebase once it merges.

## Later

- **Race mode.** For lanes a profile marks as critical, dispatch two rungs at once in separate worktrees and keep the
  first whose fast check passes. It trades quota for wall-clock time.
- **Automatic retro.** At the finish, write a short retro (stops, the slowest steps, failures) and suggest
  improvements.
- **`catherd bench`.** Replay recorded real tasks under different profiles to measure them on the user's own work.
- **Standalone binaries.** `bun build --compile` per platform, published as optional platform packages, so users need
  no Bun install. The built panel must be embedded too.

## Live coverage still missing

An opencode lane, quota failover and a budget stop have run only in tests, never in a real orchestrated run; the
live kit now scripts them, with parallel lanes and a forced climb (`live-verification.md` §6), and they leave this
list once a release run records them. Quota failover runs live in the scorecard's `injected-lao` task
(`docs/dev/scorecard.md`) from the 1.5.0 baseline on; it leaves this list once a recorded scorecard shows the
stand-in ending ok. A climb and a multi-milestone, multi-MR build are covered live (the auth build, 8 climbs, 16
MRs).
