# Ideas for 1.x

Improvements collected from real catherd runs and from designing it, not yet planned. When one is picked up it moves
into a spec or plan under `docs/specs/` or `docs/plans/` (or a GitHub issue) and leaves this list. One entry per idea: what, why
(the evidence), and where it would live.

After 1.5 the list holds only what the 1.5 spec (`docs/specs/2026-10-02-catherd-1.5-design.md`) names under "Not in
1.5" (the "1.2 follow-ups", "Routing and cost", "Orchestration", "Later" and "Live coverage" sections), the 1.5 follow-ups below, and the open entries of the older sections
that no 1.5 plan fixed (under "Found while releasing 1.5").

Shipped in 1.0, so not re-proposed here: `catherd doctor`; the harness-cost line in `runs_summary` and the final
report; quota failover (the profile's `failover` map); the `preflight` tool; per-repo knowledge
(`knowledge.md`, keyed since 1.5 by the repository's git origin, its toplevel when it has none; read with
`read_knowledge`, appended by `land`); the run budget (from 80 %
`route` starts at the cheapest rung that clears the bar; once spent, `E_RUN_BUDGET` pauses the run); the trimmed catalog (`catalog/models.json`, `scores.json`, `jev.json`); a plan in hand (a `plan:` A-line: no dossier, the architect translates); lint and type check in each lane's fast check; `status` showing the run's native and isolated dispatches, with the harness figure compared within one repo; and a sure Jev kind kept when its difficulty is unsure (`source: "jev-kind"`).

## 1.5 follow-ups (plan reviews, 2026-10-02)

Plan 21 (roles and ownership) review:

- **A role's own peek still claims.** A role may `peek` its own dispatch (ruling 4), but `peek` still calls
  `claim()`; on a 1.4-era run whose owner of record is that role's thread, adopt and recover then run inside the role
  process. Evidence: `src/services/peek.ts:126`, `src/services/dispatch-service.ts:216`. Fix: return from `claim`
  when `deps.role` is set, and skip `startNotifier` in a role process (`src/entry/mcp/server.ts`). (Minor 4.)
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
- **"BLOCKER: none" counts as an open blocker.** A reviewer that writes `BLOCKER: none` (or `BUG: none`) gets one
  open finding and the orchestrator a needless fix round. Evidence: `src/services/milestones.ts:100`. Fix: skip a
  finding line whose text after the label is `none`, `n/a` or `-`. (Minor 3.)
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
- **A raised no-clear start does not say it was raised.** When no rung clears the bar and the start is raised to an
  easier difficulty's start, `noClear`/`why` do not say so. Evidence: `src/domain/select.ts:273-281`. Fix: append
  "started at <difficulty>'s start, which scores at least the default" to the line. (Minor 7.)
- **An empty first page loses its rate-limit headers.** The "empty first page" `SourceError` carries no status or
  headers, so that attempt's rate-limit count is lost. Evidence: `src/infra/sources/artificial-analysis.ts:48`. Fix:
  pass the first response's status and headers, as line 32 does. (Minor 8.)
- **An unknown Claude model rides the plan for free.** On `claude-plan` a rung with no family costs 0 at tier 0, while
  some Claude models are metered on the plan (as Fable is), so an unknown one may start lanes as if free. Evidence:
  `src/domain/cost.ts:71`. Fix: price a familyless Claude-plan rung last in tier 0, or treat it as metered until the
  catalog knows it. (Minor 9.)
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
  budget `status` and the runs page show read `forRepo`, so admission enforces the pinned budget while status shows
  the repo's. Evidence: `src/services/preflight.ts:260`, `src/services/lane-service.ts:240`, `:573`,
  `src/services/summary.ts:81`, `src/services/runs-page.ts:180`. Fix: read `runProfile(deps, run)` there. (Minor 3.)
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
- **A bad `After:` blocks a lane forever.** `After:` is not checked for a cycle, the lane itself, or a lane with no
  file, so such a lane is refused `E_ADMIT_ORDER` for good. Evidence: `src/services/admission.ts:226`,
  `src/services/protocol.ts:90`. Fix: refuse them in `assertLaneValues` where the run is known (`write_run_file`,
  `lane_set`), or at least name them in `protocol.next` or a status warning. (Minor 7.)
- **`landedCommitOf` lines up two separately filtered arrays.** It indexes `landedCommits` by the position of the
  milestone in `landedMilestones`; a ledger row one filter keeps and the other drops shifts every later commit.
  Evidence: `src/services/workspace-admission.ts:127-132`. Fix: parse each ledger row once into
  `{ milestone, commit }`. (Minor 8.)
- **Carried gate passes are not shared between worktrees of one repo.** `gates.jsonl` stays keyed by the toplevel
  (Ruling 20), so a worktree never reuses a pass recorded in another worktree of the same origin. Evidence:
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
- **RoleView's `done` outlives its role.** `done` is component state and RoleView has no key, so a future
  role-to-role navigation would carry `done=true` to a live role and stop polling. Evidence: `src/entry/tui/views/runs.tsx:375,597`
  (`RoleView`). Fix: render it with `key={role.dispatchId}`. (Minor 4.)

Found while releasing 1.5 (open entries of the older sections that no 1.5 plan fixed and the spec's "Not in 1.5"
does not name):

- **Messages arrive only when the next turn starts.** worker-M3.L1 of the 1.1.0 platform run ended at 17:43:08,
  and its catherd message reached the Claude Code main thread only after the owner's next message, about 20 min
  later: an idle main thread is not woken, and the owner read the silence as a hang. Evidence: run
  `20260928-172920-m3-auth-plan-5-mr-b-the-kit-clean-up` (sanitell/platform). Fix: wake an idle owner session, or
  let `status` show "finished, unread" prominently. (Plan 22 Ruling 16 kept it.)
- **`status` lists a previous owner session as live.** After a new session took the run on the 2026-09-29 resume of
  that run, `status` and `peek` still listed the previous owner session as `live: true` (plan 22 closes the stale
  verifier step itself, not this). Fix: list only the owner of record as live.
- **A "foreground" verifier is still a background agent.** On that resume, and in the payment runs `-113331` and
  `-133255`, the Agent call for a verifier briefed to stay in the foreground returned "Async agent launched" and
  the verdict came as a second notification. The skill now names `run_in_background: false`
  (`plugin/skills/catherd/SKILL.md`, "the gate owner"), but nothing checks that the host honoured it. Fix: the
  skill says a native verifier's verdict may still arrive as a notification, and `protocol.next` treats it as a
  dispatched role whose result arrives as a message.
- **A broken check is called expected.** In the payment run `-143512`, M1.L5, a compose file valid only layered on
  another failed `config -q`, and preflight called it `fails-as-expected`. Since 1.5 only an environment error is
  `cannot-start` (`src/services/preflight.ts:204`), so a check that is broken for another reason still reads as
  expected. Fix: name the failing line in the outcome, or class a failure in the check's own setup step
  (`config`, a parse error) as `cannot-start`.
- **Clone-driven work needs a "discover, then split" step.** In the 1.1.0 platform run L4 (Task 12) stopped on
  four panel clones that `dupes` found only after the allowlist emptied, and needed a hand-written rescoped lane.
  `owns_add` (1.5) grows one lane's Owns; splitting work the gate discovers into new lanes is still by hand.
- **One run per worktree: `dispatch` takes no cwd.** The platform review-fix run (2026-09-30, plans 1–7, seven
  MRs) needed one run per plan and its worktree. Workspaces (1.5) coordinate several runs; one run still cannot
  dispatch into two worktrees. Fix: an optional `cwd` (a worktree of the run's repository) on `dispatch`.
- **First-turn cost on small lanes.** A native Codex turn starts at about 280k input tokens (mostly cached)
  whatever the lane's size; an easy lane in the 1.0.0 headless test still read 583k isolated. A profile rule such as
  "isolated below difficulty build" could save most of it without touching the user's harness for real work.
  _Where:_ the profile's `harness.<backend>.isolated`, made conditional.
- **`run_start` could warn about an active Codex goal.** In the identity run (2026-10-02) a thread goal made Codex
  start a goal-continuation turn about once a minute (11 turns in 21 minutes, 7.2 M input tokens). Since 1.5 the
  skill ends such a turn with no tool call and `peek` answers `actionable: false`; a warning at `run_start` when the
  thread has an active goal would catch it before the first poll.
- **`protocol.next` names failed items from history, the verifier from content.** `failedItems`
  (`src/services/gate-service.ts:359`, used by `src/services/protocol.ts:186`) reads the step history alone (sync),
  while `gate_check`'s listing and the verifier brief use `recordedItems`, which also re-opens a pass whose content
  changed since. So the re-check step can name fewer items than the fresh verifier is given. Evidence: plan 23
  ledger (Codex fixes for PR 48). Fix: make `protocol.next` async and use `recordedItems`, or cache its result.
- **Stacked pushes need `-o ci.skip` (branch pipelines held the runner).** About the user's CI practice, not
  catherd. In the payment run, pushing five stacked branches started five branch pipelines on the single runner, and
  plan 5's MR pipeline sat pending for about 30 min. Stacked pushes need `-o ci.skip`.

## 1.2 follow-ups (minors from the 1.2 reviews, 2026-09-28)

Owner rule: review Minors and non-correctness bot P2s land here, not in code. From the plan 14 final review (`cff7d19..04a48e2`) and its plan writer:

- **The shipped rebuild still spreads `adjacent` values downward** (Luna none carries Luna max's DeepSWE; a sync
  spreads only upward since 1.5, plan 24): the default ladder's Luna rungs rest on a value published only at max
  (plan 14 Ruling 3). The owner's call, with the Sol bars below.
- **The logic and hard bars sit above every Sol rung** on the default ladder (Sol agentic 0.0818 vs 0.08606): the
  owner's call, percentiles as specced or a ladder with a stronger top rung.
- **Haiku 4.5's terminal value returns** when Epoch's Terminal-Bench covers five anchor rungs (plan 14 C-2).
- **The Artificial Analysis fixtures are synthetic** (plan 13 R-C); re-record them with a key.

## Routing and cost

- **Jev hit-rate review.** After N runs, show how often each Jev start rung had to climb, per kind and difficulty:
  "build lanes on `codex:gpt-6-luna#high` climbed 3 of 10". _Why:_ it is the raw material for catalog tuning, and it
  tells the user whether a bar is too low today. _Where:_ `runs_summary`, `watch`, and the setup skill.
- **Jev difficulty calibration.** In the first two real runs Jev was sure of the kind (1.0) but not the difficulty
  (0.4), so 3 of 4 routes fell back to the default. Since 1.5 each lane's final outcome (climbed or not) is logged
  beside Jev's answer in `routes.jsonl` (plan 24): tune the difficulty question's wording, its options or its
  threshold from that data.

## Orchestration

- **Milestone per branch.** A real multi-MR build wants one branch and one MR per milestone, some in parallel. `land`
  only commits. _Where:_ an optional `branch` on milestones, and a finish step that opens the MR through the repo's
  own tooling.
- **Stacked milestones.** Starting M2 only after M1 merged serializes the run behind review and the gate. M2 could
  start on a branch stacked on M1 while M1's gate and MR run, and rebase once it merges.

## Later

- **Race mode.** For lanes a profile marks as critical, dispatch two rungs at once in separate worktrees and keep the
  first whose fast check passes. It trades quota for wall-clock time.
- **Automatic retro.** At the finish, write a short retro (climbs, the slowest steps, failures) and suggest
  improvements.
- **`catherd bench`.** Replay recorded real tasks under different profiles to measure them on the user's own work.
- **Standalone binaries.** `bun build --compile` per platform, published as optional platform packages, so users need
  no Bun install. It waits until OpenTUI's native core embeds cleanly in a compiled binary.

## Live coverage still missing

An opencode lane, quota failover and a budget stop have run only in tests, never in a real orchestrated run; the
live kit now scripts them, with parallel lanes and a forced climb (`live-verification.md` §6), and they leave this
list once a release run records them. A climb and a multi-milestone, multi-MR build are covered live (the auth
build, 8 climbs, 16 MRs).
