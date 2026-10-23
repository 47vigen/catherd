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
- **The architect writes a fast check over a path the formatter ignores.** `lanes/M2.L3.md`'s `Fast check:` ended
  with `bunx oxfmt --check docs/dev/scorecard.md`, but `.oxfmtrc.json` ignores `docs/**`, so the step could never
  pass. The worker blocked `check_broken` (`runs/<run>/events.jsonl` seq 79), was re-dispatched with the same check
  (seq 82), blocked again (seq 96), and the lane parked (seq 97). Fix: leave ignored paths out of a lane's fast check
  (or run the repo's own `format:check`); a second `check_broken` with the same `why` on the same head parks at once
  instead of re-dispatching.
- **An owner's answer does not stick to the lane.** After the answer that dropped that docs step, the daemon kept
  running the unchanged fast check (`check.ran` exit 2 at seq 150, 163, 186, 195), the lane climbed to the top rung
  (seq 164, 198), and a judge skipped the step (seq 210). In M2's fix round the lane went out on a fresh thread
  (seq 251) with the step still in its check and parked a third time (seq 290): about ten worker dispatches, two
  climbs, one judge and three owner round trips on a step that cannot pass. Fix: an answer that drops a check step
  edits the lane's `Fast check:` (or records a waiver the check honours), and a judge `skip` carries into later
  rounds of that lane. (Run audit 22.)
- **A lane misses the tests that pin the behaviour it changes.** `lanes/M4.L3.md` owned only `src/services/daemon.ts`
  and its test; its task changed `ensureDaemon` for every caller, and `test/services/run-read.test.ts` and
  `test/services/run-pause.test.ts` (which stub `daemonLauncher.launch`) expected the old launch. The worker parked
  `out_of_scope`. In M4 a change to `src/domain/run-state.ts` broke `test/domain/run-state.test.ts`, which no lane
  owned and no fast check ran; it surfaced only at the verifier, after five review rounds. Fix: when a lane changes
  an exported function, the architect adds the tests that call or stub it to the lane's Owns:, and a lane's fast
  check runs the test files of the source files it owns. (Run audit 15.)
- **A plan-backed run maps no A-line, and the digest shows only the last review round.** M1's digest said "A-lines:
  not mapped to this milestone (none cited as A<n>)" and listed all six: a plan written before the run does not cite
  the run's `A<n>`, and a one-milestone mapping does not apply to six milestones. The same digest said "Reviewer:
  reviewer-M1 · 0 finding(s)" after three review rounds, so rounds 1-2's findings are invisible. Fix: the architect
  maps the A-lines onto milestones when it turns a plan into `plan.md`; the digest sums findings over every round.
- **A push takes two parked round trips per milestone.** M1 parked for the push, then again for the MR. With the
  owner's standing approval for a run's base branch, both could be one answer (`push+merge`) or a profile setting.
- **A gate recorded in a broken env cannot be re-recorded.** The gate cache is keyed by HEAD only, not by the env it
  ran in: a verifier's second and third `gate run` on M6's head returned the same cached failed record, `land` reads
  it, and that head can never land without a new commit. Fix: let a verifier re-run a gate (a `fresh` flag), or key
  the record by its env too. (Run audit 7.)
- **The report's known issues can be a verifier reply cut into lines.** The cancelled run's `result` listed, as M4's
  known issues, the verifier's whole reply split per line ("HEAD: 13f8a45…", "**Acceptance lines**", "**Gate
  items**", "**Not checked**"), not findings. The report also shows tokens but no cost. Fix: take only finding lines
  into `knownIssues`, and add the run's cost. (Run audit 19, 20.)
- **An unattended coordinator asked an interactive question, and the run sat for six hours.** Five parked questions
  (M2-M6) waited from 04:16 to 10:05 UTC while the coordinator showed a question menu in a terminal nobody watched;
  the phone notices carry only catherd's own parks. Fix: the catherd skill tells a coordinator that runs unattended
  never to ask interactively: rule, record the ruling, and send what needs the owner to the run's notify url.
  (Run audit 25.)
- **The run audit's open findings.** The five-lens audit
  (`docs/dev/reports/2026-10-23-plan-38-run-audit.md`) leaves these items outside plan 39. Finding 7: a verifier gate
  inherits role and scratch variables, and cached failures cannot be re-recorded; 8: verifiers can carry A-line
  results without a record; 11: repo-wide typechecks make parallel lanes fail on unwritten sibling exports; 13: a
  base move discards a verifier result; 14: milestone starts serialize on memory checks, verifier gates queue without
  useful order, and cancel leaves orphan parks and trees. Evidence: report findings 7–8 and 11–14, including the
  ~16 failed dispatches in finding 11.
  Findings 15–19 also remain open: lane ownership can omit tests of changed exports (15); reviewers do not run tests
  (16); unchanged findings repeat across rounds (17); malformed role replies can pass parsing (18); architect
  requirements can contradict tasks, and known issues can contain a verifier reply split into lines (19). Evidence:
  report findings 15–19, including M2.L1's contradictory requirement and the cancelled run's split reply.
  Finding 23 remains open: ui-reviewers resume growing threads, judges use full sessions, and Codex usage across a
  resumed thread may be cumulative. Evidence: report finding 23; the cumulative-usage question remains unresolved.
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
  - **Passing tests can be reported as failures when their names contain `FAIL`.** The verifier's failure list
    includes `(pass) the verifier's prompt (spec 1.1 §7) > records HEAD first, puts file:line in FAIL lines and calls
    a minor issue a NIT`. Evidence: the verifier gate output recorded in the run events (seq 66); the passing test is
    `test/domain/verifier-prompt.test.ts:47`.

- **Coordinator findings from the plan 39 run** (run `20261023-105527-run-audit-fixes-plan-39`; seq numbers are its
  `events.jsonl`):
  - **Admission and the reducer disagree on whether a blocked lane finished (it deadlocked M1).** worker-M1.L1
    replied `blocked` (check_broken) at seq 30, 43 and 60. The replayed state marks the lane `done` and parks
    nothing, but `unfinishedAfter` (`src/services/protocol.ts:123`, from the dispatch records) still counts it
    unfinished, so M1.L4 (`After: M1.L1`) was refused `E_ADMIT_ORDER` on every try (seq 61, 172) and parked as
    `effect`. Answering M1.L4 repeated the refusal; answering M1.L1 failed "has no open question". The owner unblocked
    it by deleting the `After:` line with `catherd run-file write` (the plan lint had flagged it at seq 24). Fix:
    admission reads the reducer's lane state; a `blocked` reply parks the lane with its reason; the lint's "shares no
    file: drop it" drops the line instead of only warning. The first refusal also raced the predecessor's finish (seq
    60 and 61 in the same second).
  - **A host session's MCP server older than the run's daemon goes silent.** The coordinator's `catherd mcp` started
    from an npm build; `bun link` then pointed the global command at a newer checkout, and the daemon started from
    it. From seq 22 (`report.posted` kind `memory`) the old server could not replay the log: no channel message for
    any later park (seq 37 and 44 waited about 15 min until the owner noticed), and `status()` returned
    `E_RUN_CORRUPT … restore events.jsonl from a backup`, while every line validates against the daemon's schema.
    Fix: an unknown newer event is a version error ("restart your host session"), never "corrupt"; the server compares
    its version with the daemon's on each read.
  - **Spawned-CLI tests inherit the worker's role.** A worker's fast check runs in its own shell, so tests that
    spread `process.env` into a spawned `catherd` (or derive temp paths under `runs/<run>/scratch/`) run as the
    worker and fail `E_ROLE_SCOPE`: M3.L2 (seq 185, `test/entry/runs-command.test.ts:15`), M1.L4 (seq 298,
    `test/services/milestone-check.test.ts:115`), M1.L3 (seq 316 and 321, `test/entry/role-cli-command.test.ts:70`).
    Each passed with no role; each lane called it an environment block. Plan 39 fixed those three helpers. Fix: one
    shared test helper that strips `CATHERD_ROLE`, `CATHERD_DISPATCH_ID` and the scratch `TMPDIR`, plus a test that
    every spawn under `test/` uses it.
  - **A fresh milestone tree has no dependencies.** M5.L2's preflight ran the web typecheck before anything installed
    `web/node_modules` and parked `preflight` (seq 240, `tsc: No such file or directory`, exit 127). Fix: the tree
    setup runs the repo's install for each package a lane's check touches, before preflight.
  - **A pre-commit hook failure parks the milestone with no way forward.** The lefthook format check rejected a web/
    test (`commit.failed` seq 260); the park's answer only retries the same commit (`commit.failed` → `stuck`, then
    back to `committing`), so the owner had to run the formatter in the tree. Fix: a commit failure goes back to the
    lane that owns the file with the hook output, and a lane's fast check runs the format check on its files (the
    run's rules review proposed the latter).
  - **Lanes still break callers no lane owns (run audit 11).** M1.L2 (seq 37, four `gatePass` callers), M1.L1 (seq
    44), M3.L1 (seq 91, `Tokens.cacheWrite` fixtures in three adapter tests and `src/adapters/opencode/index.ts`) and
    M5.L2 (seq 253, nullable `costUsd` in `web/`) each parked until the owner widened the lane. The run's rules review
    proposed the architect rule; the plan lint could also grep the callers of every changed signature.
  - **A land-path regression surfaced only at review round 5.** M1's change made `land` need a per-item machine
    record, and `passGate` in `test/services/helpers.ts` wrote none, so `test/services/protocol.test.ts:519` failed
    from round 1; lane fast checks run only their own test files, so the verifier caught it at round 5 (seq 348).
  - **A re-approval question shows no diff.** After the owner's plan changes, the second approval question gave the
    whole plan again; seeing what changed took a hand diff of two `run-file read` outputs.
  - **Codex dispatches stay unpriced in a run whose daemon predates the catalog pricing.** 68 Codex dispatches carry
    `costUsd: null` (24 Claude Code dispatches are priced), so the run's $24.03 covers Claude Code only. Plan 39 M3
    prices Codex from the catalog; the next run on this build should show it.

- **A public panel URL for phone links.** The panel binds to `127.0.0.1`, so phone notices cannot open it from
  another device. Evidence: `CLAUDE.md:17` and plan 39 decision D16; choosing a public URL is a product decision.

### From the plan 28–35 reviews (2026-10-21)

- **An explicit rung for a lane-less dispatch skips the floor and the cap.** `else rung = i.rung`
  (`src/services/dispatch-service.ts:457`) takes the caller's rung as is, while a lane's rung goes through routing,
  which applies `CODING_FLOOR` and `maxEffort` (`effortAllowed`, `src/domain/select.ts:40-52`). Fix: refuse or warn
  for a coding role's rung below the floor or above its cap, as validate does for the rungs.
  Nothing calls it since 2.0 (plan 38 triage).
- **A task's signature and test are found by pattern.** `parsePlanDoc` (`src/domain/plan-doc.ts`) calls any code block a
  signature and any `Expected:` line a test, so a task with only a shell command passes preflight. _Where:_ ask
  Jev, or the judge at `readPlan`, whether each task names what its worker must build.
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
