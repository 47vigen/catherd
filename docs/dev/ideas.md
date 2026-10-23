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
`plan:`); lint and type check in each lane's fast check; and a sure Jev kind kept when its difficulty is unsure
(`source: "jev-kind"`). Since 2.0 the daemon runs all of it (MIGRATION.md, "From 1.5 to 2.0").

## 2.0 follow-ups

### Panel v2 follow-ups (plan 37 final review, 2026-10-23)

- **A run document over 512 KiB is cut with no notice.** `runDoc` (`src/services/run-files.ts`) reads through
  `readCapped` and drops its `cut` flag, so the panel shows a truncated plan or report as if whole, and a UTF-8
  character at the cut can break. Send `cut` and say so under the document.
- **`summary` and `scorecard` still count paused time.** `wallMinutes` in `src/services/summary.ts` and
  `src/services/scorecard.ts` measure from creation to end; the panel's run index now subtracts pause spans
  (`coveredMs(start, end, pauseSpans(run))`). Use the same there so the CLI and the panel agree.
- **A pause does not hold `claimTree` or `route`.** A paused run with a base branch still claims worktrees and routes
  waiting milestones (`src/domain/run-machine.ts`, the paused filter). The README says so; hold them too if a pause
  should freeze the run entirely.

- **A watched transcript is re-read whole every 500 ms.** `tailTranscript` (`src/services/transcript.ts`, behind the
  socket's `watch` message) reads the role's stream file from the start on each poll (`completeLines`) and skips the
  lines it already sent, so a long role's stream costs more with every poll. _Where:_ keep the byte
  offset of the last full line and read from it.
- **A Setup section's save pins the defaults it shows.** The section patches (`patchFor`,
  `web/src/routes/_app/setup/-lib/patch.ts`) send every field of the section as the page resolved it, so a default
  the user never touched is written into the profile and no longer follows a new default. _Where:_ send only the keys
  the user changed.
- **The run index drops a run with a corrupt `meta.json` without a word.** `runIndex`
  (`src/services/run-index.ts`) reads `listRuns(...).runs` and never looks at its `corrupt` list, so such a run is
  just missing from the panel and the log. _Where:_ log each corrupt run once.
- **A reconnect's refetch can overwrite a newer patch.** After a reconnect `RunDetail`
  (`web/src/routes/_app/runs/$runId.tsx`) invalidates the model; a patch that lands while that read is in flight is
  replaced by the older model it returns. _Where:_ keep the cached model when the refetched `seq` is lower.
- **The overview accepts any date range.** `/api/overview` (`src/services/overview.ts`) takes any `from`/`to`, so a
  request for years of days builds that many daily rows. _Where:_ clamp the range to 366 days.
- **The run-index cache is never pruned.** Its map (`cache` in `src/services/run-index.ts`) keeps an entry for every
  run dir it has seen, deleted runs included, for the life of the panel. _Where:_ drop the entries `listRuns` no longer
  returns on each `runIndex` call.

### From plan 33

- **A lane on a held quota waits instead of failing over.** Plan 30's advance dispatches a pending lane only while
  its quota is free, so a lane routed onto a held quota waits up to 30 minutes (plan 33, Ruling 16). _Where:_
  dispatch it with `failoverFrom` set to its own rung, so `failoverRung` chooses a stand-in.
- **The panel cannot show or edit `maxEffort` or `bars`** (plan 33, Ruling 17); only `catherd profile set` and the
  session's `profile` tool do. _Where:_ the panel's Setup page (plan 31).

### From the plan 28–35 reviews (2026-10-21)

- **An explicit rung for a lane-less dispatch skips the floor and the cap.** `else rung = i.rung`
  (`src/services/dispatch-service.ts:457`) takes the caller's rung as is, while a lane's rung goes through routing,
  which applies `CODING_FLOOR` and `maxEffort` (`effortAllowed`, `src/domain/select.ts:40-52`). Fix: refuse or warn
  for a coding role's rung below the floor or above its cap, as validate does for the rungs.
- **`run_start`'s refusal names the wrong cause.** It says "no usable rung on the Slopalytics index"
  (`src/services/run-service.ts:131`) when the role's only rungs are removed by `maxEffort` or the coding floor
  (`rolesWithoutRung`, `src/services/routing-service.ts:315`). Fix: name the cause (the cap, the floor, or the index)
  in the message and the fix.
- **A task's signature and test are found by pattern.** `parsePlanDoc` (`src/domain/plan-doc.ts`) calls any code block a
  signature and any `Expected:` line a test, so a task with only a shell command passes preflight. _Where:_ ask
  Jev, or the judge at `readPlan`, whether each task names what its worker must build.
- **An unfinished baseline row makes the wall-clock bar lenient** (`passBar`): a task the operator gave up on at the
  4-hour cap still counts in the baseline's sum. Say so in the verdict.
- **`scorecard record` leaves the acceptance files' folders behind** in the throwaway clone. Harmless.
- **`saveTaskScore` writes the results file without a lock**: two concurrent `record` runs would lose a row. The
  protocol runs one task at a time.
- **A proxy answer with `fetchedAt` null makes validate's fix say `catherd catalog sync`** even though an index
  exists, so the advice does not match the state.
- **Reviving a daemon has no backoff:** with a corrupt events.jsonl every status call spawns a daemon that fails.
- **Base-failure line matching hides untested `a && b` tails.** A check that fails only in lines the base fails in
  too passes (`src/services/milestone-check.ts:171-206`, `src/domain/fail-lines.ts`). When the check is `a && b` and
  `a` fails on the base the same way, `b` never runs on either side, so a new break in `b` stays invisible. Fix: when
  the baseline's exit is non-zero, run the check's parts separately, or name the unreached tail in `audit`.
- **The secret scan in a base run covers others' commits too.** `secretScan` scans `base..HEAD`
  (`src/services/milestone-check.ts:77-89`), and once `integrate` has merged origin's base into the run's branch, that
  range holds the commits of other people. A secret they pushed blocks this run's milestone. Fix: scan only the
  first-parent chain (`--first-parent`) or exclude commits reachable from `origin/<base>`.
- **A last milestone that never merges keeps the run alive until the push answer.** In a base run `isFinished` (merged)
  gates the run's end (`src/domain/run-state.ts:254`, `src/domain/run-machine.ts:478`), as plan 30b's ledger ruling
  says; if the owner never merges it, the run waits on the push question forever. Fix: end the run when the last
  milestone is landed and the push question has been answered, and say that the merge is still open.
- **The panel's CSP `connect-src` falls back to `default-src 'self'`, which old Safari may not extend to `ws:`.**
  The run page's live socket could then be blocked there. The e2e runs Chromium only, so nothing has checked it;
  add `connect-src 'self' ws://127.0.0.1:*` if a Safari user reports a dead "Live" dot.
- **`decisionLines` reads only the `D<n>` line** (`src/domain/plan-doc.ts`). A decision wrapped onto a continuation
  line, or rewritten as a list item such as `1. D1`, changes nothing the comparison sees, so an edit to its meaning
  triggers no re-approval. Fix: read a decision up to the next `D<n>` line or blank line, and accept a list marker.
- **The `labelled` parser splits a finding that contains ` - ` at the first separator.** A finding whose own text
  holds a spaced hyphen loses the tail to the wrong field. Fix: split on the label once, or require the em dash.
- **The rules review's `" — "` splitter cuts a rule that contains `" — "`.** `parseJudgeReply` (`src/domain/judge.ts`)
  splits a `ADD`/`REMOVE` line at the last `" — "`, so a rule whose text holds one loses its tail to the reason.
  _Where:_ ask the judge for a field separator a rule cannot hold, or parse the reason from a tagged suffix.
- **The report has no cap.** `writeRunReport` (`src/services/run-report.ts`) lists every known issue, every standing
  rule and every research block in full; a long run's report grows without bound. _Where:_ cap each list, with a
  "+N more" line that points at the files.
- **`git worktree prune` in `claimTree` prunes the owner's own stale entries too.** `claimTree`
  (`src/services/milestone-tree.ts:111`) runs `git worktree prune` on the owner's repo, which drops every worktree
  entry whose folder is missing, such as one on an unmounted drive. Fix: scope it to catherd's trees (prune only when
  the missing folder is under `<run dir>/trees`), or drop the call and let `worktree add` report the stale entry.
- **A memory deferral never tells the owner.** `claim` (`src/services/run-effects.ts:684-697`) appends `tree.deferred`
  every `MEMORY_LIMITS.recheckMs` (2 minutes) while memory is short, and nothing reports it, so a milestone can wait
  for hours with no sign. Fix: report once on the first deferral of a milestone (and when it is claimed after), with
  the numbers the event already carries.
- **In a base run `updateState` and the skip path read the main checkout's HEAD.** `updateState`
  (`src/services/state.ts:51`) takes `gitHead(run.meta.repo)`, and the skip path's `fullCommit(run, "HEAD")`
  (`src/services/lane-service.ts:357`) resolves in the repo as well, while the work is on the milestone's branch in
  its tree. Neither is reachable from the daemon today; a caller that reaches them in a base run gets the wrong
  commit. Fix: resolve them through `treeOf(run, milestone)`.

### From the 1.5 plan reviews (2026-10-02, still open)

These concern code 2.0 kept: the 1.5 notifier, end push and `result` paths still serve a run started on 1.5, and the
services behind the removed session tools stay for the CLI.

Plan 21 (roles and ownership) review:

- **Refused notices pile up in delivery.jsonl.** Each deliver pass writes another `failed` attempt and another
  `error` log line for the same notice refused for a role's thread, so `delivery.jsonl` grows without bound while the
  owner of record stays a role. Evidence: `src/services/notifier.ts:248-252`. Fix: skip the notice when its latest
  attempt is already a role-thread refusal (`ROLE_THREAD_REFUSAL`) for the same target. (Minor 5.)

Plan 22 (delivery and the loop) review:

- **`thread` is checked against records a claim has not written yet.** `threadFor` reads `runs.jsonl` before
  `claim()`, which finalizes finished dispatches that lack a record, so `thread: "latest"` can resolve to an older
  thread and an explicit newer thread is refused. Evidence: `src/services/dispatch-service.ts:297-321` (called at
  :354, before `claim`). Fix: also accept the threads of finished, unrecorded dispatches (`admit.thread` or the
  stream's thread), or finalize the name's finished dispatches before the check without claiming. (M1.)
- **`advanceNext` runs on every `result()`.** A re-read of an already collected record can rewrite a Next that names
  the role for a future step. Evidence: `src/services/run-service.ts:113-124`, called at :160. Fix: advance only
  when the call marks the record read, or when the record ended after state.md's last write. (M2.)
- **End push reads the owner before the notify lock.** A claim in the gap sends to the old owner, and the new
  owner's notifier also sends (two sessions, one message each). Evidence: `src/services/end-push.ts:85` (owner) vs
  :89 (`tryLock`). Fix: re-read `codexOwner` inside the lock. (M3.)
- **End push reports an `ambiguous` delivery as "delivered".** Evidence: `src/services/end-push.ts:93`
  (`deliveryState(...) !== "pending"` returns `"delivered"`). Fix: return the delivery state itself. (M4.)
- **End push gives up at once on "busy".** If the server holding the notify lock then fails to submit, nobody
  retries. Evidence: `src/services/end-push.ts:90`. Fix: one short retry after the lock frees. (M5.)
- **`CATHERD_NO_END_PUSH` reaches only children that inherit `process.env`.** A test that spawns with an explicit
  `env` could leave a supervisor running 20 s and calling the real `codex`. Evidence: `test/preload.ts:7`; there
  is no shared spawn-env helper (each test builds its `env`, e.g. `test/plugin.test.ts:112`). Fix: add a shared
  spawn-env helper in `test/helpers.ts` that sets `CATHERD_NO_END_PUSH=1` (and `ANTHROPIC_API_KEY: ""`), and use it
  in the tests that spawn catherd. (M6.)

Plan 23 (verifier, gate and environment) review:

- **A chatty login profile corrupts the login env.** A profile that prints to stdout (a motd, an `echo`) lands in
  front of the first `env -0` record, so that variable (PATH, when it comes first) is lost; and the capture's
  `spawnSync` blocks the MCP server's event loop for up to 5 s, once per process. Evidence:
  `src/infra/login-env.ts:13`, `src/infra/login-env.ts:26`. Fix: parse only `K=V` records, dropping what precedes the
  last newline before the first `\0`; capture it asynchronously (or at boot, off the request path). (Minor 2.)
- **An `ENV:` line anywhere makes climb refuse.** `parseReplyEnvironment` matches an `ENV:` line anywhere in the
  reply, a YAML or Dockerfile snippet in a code fence included, so `climb` refuses with `E_CLIMB_ENV` for a lane that
  had no environment blocker. Evidence: `src/domain/record.ts:93-95`. Fix: read it outside code fences only, or only
  among the lines just above the `STATUS:` line. (Minor 4.)
- **The retry reset also fires when the `providerRetry` hook times out.** `bounded(..., null)` falls back to null,
  which clears the stream-counted retries, so a slow hook hides an outage until the idle timeout. Evidence:
  `src/infra/supervisor.ts` (the `providerRetry` poll). Fix: reset only on a hook answer of "no retry", not on a
  timeout. (Re-review.)
- **The reserved gate-env names are a hand-kept list.** It misses `GH_CONFIG_DIR`, `GIT_CONFIG_GLOBAL`,
  `XDG_CACHE_HOME`, `BUN_INSTALL_CACHE_DIR` (the env order still protects them). Evidence: `src/services/gate-env.ts`
  `RESERVED`. Fix: derive it from what the adapters' plans set. (Re-review.)
- **A stray JSDoc in `supervise-command.ts`.** `runSupervise`'s doc sits above `superviseEnv`'s. Evidence:
  `src/entry/supervise-command.ts:122-126`. Fix: move it back. (Re-review.)

Plan 24 (routing and cost) review:

- **`jev-kind` is claimed when Jev was sure of nothing.** When Jev answered but was sure of no kind, a lane's
  declared `Kind:` alone still routes as source `jev-kind`, so `why` says "Jev's kind with …" and `decidedBy: jev-kind`
  reaches the outcome rows used to calibrate Jev; with Jev off or failing, a `Kind:`-only lane falls to the default
  and its declared kind is ignored. Evidence: `src/services/routing-service.ts:196` (`judged && lane.kind`). Fix:
  label it `lane` (or a new source) and use `lane.kind` whether or not Jev answered. (Minor 2.)
- **An explicit rung on a routed lane goes unchecked and unrecorded.** A lane dispatch with an explicit `rung` on a
  lane already routed is neither checked against the lane's ladder nor written to `routes.jsonl`. Evidence:
  `src/services/dispatch-service.ts:364-366`. Fix: refuse (or warn on) a rung off the ladder, and record the rung
  dispatched as a route row. (Minor 5.)
- **Quota usage is read once per lane, and double-counts a re-route.** `runUsage(run)` is computed for each lane of a
  batch, and a waiting lane that is re-routed counts both its routes. Evidence: `src/services/lane-service.ts:94`,
  `src/services/lane-service.ts:141`. Fix: compute it once per batch and count each lane's latest route only.
  (Minor 6.)
- **`route` sends unbounded Jev requests.** `route`'s `lanes` has no upper bound, and every lane is judged at once, so
  a large batch sends that many Jev requests in parallel. Evidence: `src/entry/mcp/lane-tools.ts:21`,
  `src/services/routing-service.ts:237`. Fix: cap `lanes` (`.max(n)`) or judge with bounded concurrency. (Minor 10.)

Plan 25 (runs, programs and lanes) review:

- **A merge release's git check runs inside the workspace lock.** `workspace_child_start` calls
  `dependencyBlockers(…, { merge: true })`, whose `git merge-base --is-ancestor` runs while the workspace lock is
  held, against Ruling 4 (git outside the lock); bounded only by git's 15 s timeout. Evidence:
  `src/services/workspace-service.ts:182`, `:219`. Fix: compute the merge blockers before taking the lock and re-check
  only the cheap record rule inside it. (Minor 1.)
- **Two open questions on one milestone share one parked span.** `parkedSpans` opens a span on a question only when
  none is open, so a second question asked while the first is open is closed by the first answer, and the minutes
  after it stop being excluded. Evidence: `src/services/questions.ts:43-54`. Fix: count open questions (a span ends
  when the last open one is answered), or pair each answer with its question id. (Minor 2.)
- **Some readers still use the repo's profile, not the run's pin.** Preflight, `jev.use` in lane routing, and the
  budget `status` shows, all read `forRepo`, so admission enforces the pinned budget while status shows
  the repo's. Evidence: `src/services/preflight.ts:260`, `src/services/lane-service.ts:240`, `:573`,
  `src/services/summary.ts:81`. Fix: read `runProfile(deps, run)` there. (Minor 3.)
- **An unreadable profile leaves an orphan run folder.** `startRun` and `startWorkspaceChild` call `writePin`
  (`forRepo`) after `createRun`, so a profile that does not read throws with the run folder already made. Evidence:
  `src/services/run-service.ts:121`, `src/services/workspace-service.ts:195`. Fix: resolve the pin before
  `createRun`, or catch and remove the folder. (Minor 4.)
- **The role lock's state file has no schema field.** `role-<role>.json` is written as `{ owner, holders }`, unlike
  every other store file; pause rows rely only on the jsonl header. Evidence: `src/infra/heavy-lock.ts:96-115`. Fix:
  add `schema: 1` and read it through `readVersioned`. (Minor 5.)
- **`Allow:` misses a hit printed as `./path`.** `onlyAllowedHits` compares the hit's path verbatim, so
  `./src/x.ts:12:` (a grep under `./`) does not match `Allow: src/x.ts`. Evidence: `src/domain/lane.ts:143-158`. Fix:
  normalize both sides with `normalizeOwned`. (Minor 6.)
- **Carried gate passes are not shared between worktrees the user made.** `gates.jsonl` stays keyed by the toplevel
  (Ruling 20), so a worktree of the same origin that catherd did not make never reuses a pass recorded in another.
  A base run's worktrees (plan 35) are one run's and share the repo's passes. Evidence:
  `src/services/gate-service.ts:41`. Fix: key it by origin like knowledge; the content hashes already make a pass
  checkout-independent. (Controller carry-over.)

Plan 26 (the minors sweep) review:

- **The `marked` hint fires on a failed verifier.** It fires on any non-passed headless verdict whose reply holds
  `VERDICT: PASS`, including a verifier whose CLI exited failed or hit its limit. Evidence:
  `src/services/lane-service.ts:419-423`. Fix: count only records with status `ok`. (Minor 1.)
- **A skipped first landing says "changed nothing".** When the first milestone lands with skip and its commit equals
  the run's start head, the range is empty and the message reads "<commit> changed nothing" instead of "nothing
  committed since the run started" (it fails safe). Evidence: `src/services/lane-service.ts:368-373`,
  `milestoneFiles`. Fix: special-case commit == startHead with the clearer message. (Minor 2.)

### Found while releasing 1.5 (still open)


- **`status` lists a previous owner session as live.** After a new session took the run on the 2026-09-29 resume of
  that run, `status` and `peek` still listed the previous owner session as `live: true` (plan 22 closes the stale
  verifier step itself, not this). Fix: list only the owner of record as live.
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
- **`protocol.next` names failed items from history, the verifier from content.** `failedItems`
  (`src/services/gate-service.ts:359`, used by `src/services/protocol.ts:186`) reads the step history alone (sync),
  while `gate_check`'s listing and the verifier brief use `recordedItems`, which also re-opens a pass whose content
  changed since. So the re-check step can name fewer items than the fresh verifier is given. Evidence: plan 23
  ledger (Codex fixes for PR 48). Fix: make `protocol.next` async and use `recordedItems`, or cache its result.
- **Stacked pushes need `-o ci.skip` (branch pipelines held the runner).** About the user's CI practice, not
  catherd. In the payment run, pushing five stacked branches started five branch pipelines on the single runner, and
  plan 5's MR pipeline sat pending for about 30 min. Stacked pushes need `-o ci.skip`.

## Routing and cost

- **Jev hit-rate review.** After N runs, show how often each Jev start rung had to climb, per kind and difficulty:
  "build lanes on `codex:gpt-6-luna#high` climbed 3 of 10". _Why:_ it is the raw material for catalog tuning, and it
  tells the user whether a bar is too low today. _Where:_ `catherd runs`, the panel's Runs page, and the setup skill.
- **Jev difficulty calibration.** In the first two real runs Jev was sure of the kind (1.0) but not the difficulty
  (0.4), so 3 of 4 routes fell back to the default. Since 1.5 each lane's final outcome (climbed or not) is logged
  beside Jev's answer in `routes.jsonl` (plan 24): tune the difficulty question's wording, its options or its
  threshold from that data.

## Orchestration

- **The milestone memory defaults are a guess.** `limits.memory`'s defaults (2 GB reserve, 3 GB per milestone, 3 GB
  floor) were set from the shop run's 9 GB swap, not measured per milestone. Fix: record the peak RSS of each
  milestone's process tree on the scorecard runs, then retune the defaults.
- **A kept worktree is only logged.** A merged milestone's tree with untracked files stays under `<run>/trees/` and
  only the daemon log says so. Fix: list kept trees in the run's report.
- **Stacked milestones.** Starting M2 only after M1 merged serializes the run behind review and the gate. M2 could
  start on a branch stacked on M1 while M1's gate and MR run, and rebase once it merges.

## Later

- **Race mode.** For lanes a profile marks as critical, dispatch two rungs at once in separate worktrees and keep the
  first whose fast check passes. It trades quota for wall-clock time.
- **Automatic retro.** At the finish, write a short retro (climbs, the slowest steps, failures) and suggest
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
