# Ideas for 1.x

Improvements collected from real catherd runs and from designing it, not yet planned. When one is picked up it moves
into a spec or plan under `docs/specs/` or `docs/plans/` (or a GitHub issue) and leaves this list. One entry per idea: what, why
(the evidence), and where it would live.

Shipped in 1.0, so not re-proposed here: `catherd doctor`; the harness-cost line in `runs_summary` and the final
report; quota failover (the profile's `failover` map); the `preflight` tool; per-repo knowledge
(`<data>/repos/<slug>-<hash8>/knowledge.md`, read with `read_knowledge`, appended by `land`); the run budget (from 80 %
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
- **The docs still describe slug-keyed knowledge.** Knowledge is now keyed by the normalized origin (Ruling 20), but
  the README's knowledge row and the "Shipped in 1.0" line here still say `<data>/repos/<slug>-<hash8>/knowledge.md`
  or "the repo's". Evidence: `README.md:203`, `docs/dev/ideas.md:9`. Fix: say "keyed by the repository's origin URL
  (its toplevel when it has none)". (Controller carry-over.)
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

## 1.2 follow-ups (minors from the 1.2 reviews, 2026-09-28)

Owner rule: review Minors and non-correctness bot P2s land here, not in code. From the plan 14 final review (`cff7d19..04a48e2`) and its plan writer:

- **The shipped rebuild still spreads `adjacent` values downward** (Luna none carries Luna max's DeepSWE; a sync
  spreads only upward since 1.5, plan 24): the default ladder's Luna rungs rest on a value published only at max
  (plan 14 Ruling 3). The owner's call, with the Sol bars below.
- **The logic and hard bars sit above every Sol rung** on the default ladder (Sol agentic 0.0818 vs 0.08606): the
  owner's call, percentiles as specced or a ladder with a stronger top rung.
- **Haiku 4.5's terminal value returns** when Epoch's Terminal-Bench covers five anchor rungs (plan 14 C-2).
- **The Artificial Analysis fixtures are synthetic** (plan 13 R-C); re-record them with a key.

## Picked up

- **Push results to the main thread, drop `wait`**, and **the runs page by main-thread session** (both designed
  2026-09-28): now spec 1.1 §3 and §4, built by `docs/plans/2026-09-28-10-push-sessions.md`. The facts they rest on
  are in `docs/research/2026-09-28-cross-session-messaging.md`, which corrects two of the first notes: the self-sent
  rule runs on Linux too (a `/proc` walk), and `CLAUDE_CODE_HOST_SESSION_ID` is set only by a host (Desktop).

## 1.1.0 scope, settled (grilled 2026-09-28)

Written up as `docs/specs/2026-09-28-catherd-1.1-design.md`, which governs where the two differ.

1.1.0 = push results to the main thread (section above), the runs page by session (above) and the whole fix bundle
(below). Model scores from public sources go to 1.2.0. Implemented by the maintainer's own subagents in reviewed
bundles, not by catherd on itself; the plan goes to `docs/plans/`. Decisions per item:

- **Worker access.** Roles that write (worker, artist, writer) get network access plus the lock dir and the temp dir
  as writable roots by default; the rest of the disk stays closed. Verified 2026-09-28 on Codex 0.157 with
  `-c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true -c
  sandbox_workspace_write.writable_roots=[<locks>,"/private/tmp"]`: lock-dir write, `docker ps` over the OrbStack
  socket, a loopback `bind()`, an HTTPS fetch and a `/tmp` write all pass. A profile field `network: false` tightens
  it. opencode and headless Claude Code get the same intent through their own mechanisms (a researcher pins them
  down first); where one cannot, `doctor` says which of the five probes fail. `doctor` runs the five probes with the
  exact flags workers get.
- **Protocol enforced by the tools.** `dispatch` routes an unrouted lane itself; `dispatch` appends the role's reply
  contract (last line `STATUS: …`) to every brief; `land` refuses a milestone without a reviewer record and a
  verifier verdict unless the reason is `docs-only` or `no-code`, and it checks the diff to hold the claim.
- **MCP server launch.** `.mcp.json` runs the global `catherd mcp` when installed (`init` installs it), else falls
  back to `bunx`; `doctor` starts the server once and says "reinstall" when a module is missing.
- **Verifier.** Its brief says to run independent gate items side by side within the lock's slots and to build each
  commit's image once. A small gate ledger records each passed item with the command and the hash of its paths; a
  later run in the same repo reports an item as carried over when both match, except items whose paths are in the
  milestone's diff. The verifier reports each step it starts, so `peek` and `status` show where it is.
- **Owner questions.** `park(run, milestone, question)` pushes the full question and parks only that milestone; the
  rest continues. The answer comes in the main session, which records it and unparks; with no session, the next
  `run_start` or `peek` shows unanswered questions first.
- **Climb.** `climb` asks Jev for the kind of the failure first; plan design or file ownership is refused with a fix
  line ("send it to the architect").
- **Routing.** Under objective `cost`, `route` starts at the cheapest rung whose score clears the lane's difficulty,
  using today's `scores.json`.
- **Failover.** An inferred stand-in must clear the rung's own bar; Claude-plan rungs rank last; with no fitting
  stand-in there is none, and `doctor` says so. Fix the "treated like" labels.
- **Small items.** The marketplace plugin source becomes a full HTTPS URL; `doctor`'s sandbox probe uses `codex
  sandbox [COMMAND]`; `validate` warns on a descending ladder; `doctor` shows the shipped defaults' access rows as
  info; `init` says "installing catherd…" before the first resolve; the TUI's first frame does not say "0 profiles".
  First-turn cost stays an idea.
- **Acceptance.** CI green; a `claude -p` test on a scratch repo proving messages arrive while the session is free,
  `peek` works, route/review/verify are enforced and a worker runs `bun install` and its tests itself; then the real
  run: merge MR !54 and run auth plan 5 MR B in a fresh Desktop session, compared with MR A's numbers.

## Fix bundle: everything open, by priority

One line per open problem found in real use; the entry with the evidence is in the section named after it.

1. **Workers cannot run their checks:** the sandbox denies Docker, loopback ports, the network and the lock dir (Top priority; 1.0.0 fresh install; headless test).
2. **The protocol is optional:** `route`, the reviewer and the verifier get skipped, before and after compaction; replies carry no STATUS because `dispatch` does not add the reply contract (Top priority; headless test).
3. **Plugin install fails without GitHub SSH:** `git-subdir` shorthand URL (1.0.0 fresh install).
4. **The plugin's MCP server dies on a half-cleaned bunx cache** (1.0.0 platform run).
5. **The verifier is the bottleneck:** serial gate items, reruns of unchanged checks, an image built twice, no progress in `status` (1.0.0 platform run).
6. **One owner question stops everything** (Top priority).
7. **`doctor`'s sandbox probe is dead on Codex 0.157** (1.0.0 fresh install).
8. **Routing:** easy lanes start at the default rung, not the cheapest that clears them; climbs used for plan or ownership problems (headless test; Orchestration).
9. **Profiles:** failover downgrades high rungs or lands on the Claude quota with an odd label; ladders that go down validate clean (1.0.0 fresh install; headless test).
10. **Cost:** a first Codex turn is 280k to 580k input tokens even on an easy lane, native or isolated (headless test; Routing and cost).
11. **Noise and polish:** warnings on the shipped defaults, a silent 30 s first `bunx`, the TUI's "0 profiles" first frame (1.0.0 fresh install).

Already fixed in 1.0 and confirmed live: serial dispatch (`dispatch` + `wait`, lanes overlap), the plan-in-hand path,
lint in the fast check, the `status` harness line, Jev keeping a sure kind.

## Top priority

- **Workers cannot run their own checks.** In the auth build 60 of 171 worker replies were `partial`/`blocked`
  because the sandbox denied Docker, loopback ports or the lock dir, so the Opus main thread ran the tests itself and
  even edited test files. Fix: network, the lock dir and `DOCKER_HOST` in the worker sandbox, or a `check(run, lane)`
  tool that runs the fast check outside it. _Evidence:_ `reports/2026-09-27-auth-build.md`, finding 1.
- **The skill decays after compaction.** Runs started after a compaction called no `route`, no reviewer and no
  verifier. Fix: `run_start` returns the checklist, `state.md` names the next protocol step, and `land` refuses a
  milestone without a review and a verdict unless the run says why. _Evidence:_ the same report, finding 3.
- **One owner question stops everything.** A blocked milestone should park with a push while independent milestones
  and runs continue; one question held the auth build for 4.5 h. _Evidence:_ the same report, finding 4.

A clean 1.0.0 setup on macOS after removing every 0.x file: `bunx catherd-cli init`, the plugin commands, `doctor`, the
TUI.

## From the 1.0.0 headless test (2026-09-27)

`claude -p "/catherd:catherd ..."` on a scratch Bun + TypeScript repo, three independent utils plus an index, profile
with `codex.isolated: true`. Finished in 5 min for $0.89 of Claude; `bun test` 21/21 and `tsc` clean.

- **Parallel lanes work.** Three `dispatch` calls, then `wait({ all: true })`: the three Codex workers ran fully
  overlapped (12:50:59 to 12:54:35); M1 took 3.6 min against 7.6 min of summed worker time. Plan 9 finding 1 is
  fixed live.
- **`route` skipped for 3 of 4 lanes.** The orchestrator routed M1.L1 only and reused its rung for L2, L3 and M2.L1;
  `land` warned "no routed lane" and went on. This is a short run with no compaction, so it is not only the
  compaction decay. Fix: `dispatch` with a `lane` routes it itself when `routes.jsonl` has no entry, or refuses with a
  fix line.
- **No reviewer and no verifier.** The orchestrator read the code, ran the tests and made both commits itself. Fix:
  `land` refuses a milestone without a reviewer record and a verifier verdict, unless the call names why (and the
  skill lists the allowed reasons).
- **Replies carry no STATUS.** All four records have `replyStatus: null`: the orchestrator's briefs never asked for
  the STATUS line, and `dispatch` does not add the role's reply contract itself. The auth runs 3 to 5 showed the same.
  Fix: `dispatch` appends the role's reply contract (last line `STATUS: ...`) to every brief.
- **Sandbox denies the network.** The worker's `bun install` failed on DNS inside `workspace-write`; it passed only
  because `node_modules` already existed. Same root as the auth build's finding 1, on a trivial repo.
- **Easy lanes start at the default rung.** All four "Difficulty: easy" lanes ran on `gpt-6-sol#medium`, not the
  cheaper `gpt-6-luna#high` at the bottom of the ladder, under objective `cost`. The route should start at the
  cheapest rung that clears the lane's difficulty.
- **Worker first turn, isolated.** An easy lane still read 583k input tokens (L1); isolation does not make small lanes
  cheap.
- **Profile ladders can go down.** A ladder `... → sol#xhigh → luna#medium` validates clean. `validate` should warn when
  a rung scores below the one before it. Inferred failover labels read oddly too:
  `claude-code:claude-opus-5-5#low (treated like claude-opus-5-5#xhigh)`, and failover to a Claude rung spends the
  Claude quota the user ranks last.

## From the 1.0.0 platform run (2026-09-27)

Dev-registry MR and the end of auth plan 5 MR A, two runs side by side in one Desktop session. With the prompt forcing
route, reviewer and verifier, every lane was routed, both roles ran, replies carried STATUS, and lanes overlapped.

- **The verifier is the bottleneck.** At 63 min into MR A: workers and reviewer took about 9 min, the verifier about
  47 (26 min for the boot and SSO half, 20+ for the gate half, one attempt lost when it was cut and relaunched). Inside
  the gate, building the acceptance images took about 13 min, 7 of them a `pnpm install` in two Docker stages despite
  a cache mount; the suite itself ran after that. Ideas, catherd side: (1) the verifier runs independent gate items
  side by side within the lock's slots instead of one after another; (2) a gate item whose inputs have not changed
  since it last passed (tree hash of its paths) is reported as carried over, not rerun, when the milestone's diff
  since that pass is small; (3) the verifier builds each image once per commit and the boot check and the acceptance
  suite share it; (4) `status` shows the verifier's current step and elapsed time, so a long gate is visible instead
  of looking stuck. Repo side (platform): the Docker `pnpm install` should hit the package mirror and a warm store.
- **Final numbers for MR A.** The run took 100 min (13:18 to 14:58) before the user paused it with MR !54 open and
  green: workers and reviewer about 9 min, three verifier passes about 85 min (the last, the full gate with the
  acceptance suite, 14:01 to 14:57). M1 (dev registry), in its own run beside it, took 50 min end to end.
- **The plugin's MCP server dies on a half-cleaned bunx cache (second time).** `plugin/.mcp.json` runs `bunx
  catherd-cli@1.0.0 mcp`, which lives in `$TMPDIR/bunx-502-catherd-cli@1.0.0/`. A day later the plugin failed in
  every new session: `Cannot find module './v4/classic/external.js'` from `zod/index.js`: part of the tree was gone
  (macOS cleans `$TMPDIR` by age), and bunx reused the broken folder instead of reinstalling. 0.2.1 hit the same
  with `fast-deep-equal`. Claude Code then caches the failure for 15 min. Fix: run the MCP server from a stable place
  (the global `catherd` binary when present, else `bun x` with a cache under `~/.cache/catherd`), and have
  `doctor` import the tree once and say "reinstall" when a module is missing. Workaround: delete the bunx folder.

## Scores and catalog from public sources (2026-09-27)

_Picked up:_ designed in `docs/specs/2026-09-28-catherd-1.2-design.md` (1.2.0). The spec is binding where it differs from this section.

_What:_ `catherd catalog sync` pulls every independent, machine-readable source of model facts and scores, merges them
into the catalog routing already reads, and asks the user to pick a stand-in only for the rungs no source covers.
_Why:_ `catalog/models.json` and `scores.json` are written by hand today. A release like 2026-09-22 (Opus 5.5, GPT-6
Sol/Luna/Astra) leaves every new rung unscored until someone reads blog posts and types numbers in, and each unscored
rung needs a hand `treat-like`. Every source below was called with curl on 2026-09-27; none of the chosen ones is run
by a model vendor.

### Sources

Keyless, always on:

| Source | Call | Gives | License |
|---|---|---|---|
| models.dev | `GET https://models.dev/api.json` | per model: `reasoning_options` (the effort list), `limit.context`/`output`, `cost` (input, output, cache read/write, fast mode), `tool_call`, `modalities`, `release_date`, `knowledge` | MIT; opencode reads the same file |
| OpenRouter models | `GET https://openrouter.ai/api/v1/models` | id, context, pricing; new models appear the day they ship | public API |
| OpenRouter endpoints | `GET https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints` | per provider: `uptime_last_5m/30m/1d`, `latency_last_30m`, `throughput_last_30m` | public API |
| LiteLLM | `GET https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` | price and context, `supports_xhigh/max_reasoning_effort`; cross-check only | MIT |
| Arena (LMArena) | `GET https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=<c>&split=latest&length=100` | Agent Arena configs `agent` (Net Improvement), `agent_task_outcome_explicit`, `agent_bash_recovery_steps`, `agent_steerability`, `agent_tool_hallucination`, `agent_praise_complaint`; plus `webdev` and `text` (rating, CI, votes); `leaderboard_publish_date` | CC-BY-4.0, attribution |
| Vectara hallucination | `GET https://raw.githubusercontent.com/vectara/hallucination-leaderboard/main/README.md` (markdown table, parsed) | hallucination rate, factual consistency; "Last updated" line | Apache-2.0 |
| Epoch AI | `GET https://epoch.ai/data/benchmark_data.zip` (CSV per benchmark) | `frontiercode_external`, `webdev_arena_external`, `terminalbench_external`, `metr_time_horizons_external`, … with reasoning effort in `Model version` (`gpt-6-astra_max`) | CC-BY; external tables keep their own license |

Keyed, optional (asked in `init` like the Jev key):

| Source | Call | Gives | Terms |
|---|---|---|---|
| Artificial Analysis | `GET https://artificialanalysis.ai/api/v2/data/llms/models`, header `x-api-key` | one request, 674 rows, **one row per effort** (`gpt-6-astra-xhigh`, bare slug = `max`): `terminalbench_v2_1`, `terminalbench_hard`, `livecodebench`, `scicode`, `tau2`, `tau_banking`, `ifbench`, `lcr`, `hle`, `gpqa`, coding/intelligence/math index, pricing, `median_output_tokens_per_second`, `median_time_to_first_token_seconds` | free key, 100 requests/day, internal use only, attribution |
| same, fallback | `GET https://artificialanalysis.ai/api/v2/language/models/free?page=N` (4 pages) | intelligence/coding/agentic index, `cost_per_task`, pricing, speed | same |

The first AA path is the legacy v2 route: the free key reads it today but the current docs no longer list it, so a
404/403 there falls back to `/language/models/free`. `/language/models`, `/language/models/{slug}` (Pro) and
`/language/providers` (Commercial) answer 403 to a free key and are not used.

Checked and left out: Aider polyglot (last row 2025-10), SWE-rebench (last month 2026-07, no GPT-6), official SWE-bench
`leaderboards.json` (2026-02), the Terminal-Bench leaderboard repo (self-submitted by agent vendors, last 2025-11),
Galileo agent leaderboard and Helicone (stale), Scale SEAL / SWE-bench Pro and Vellum (403), BridgeBench (no API,
Cloudflare, `/api/` disallowed), llm-stats / benchlm / modelgrep (resell other sources), Kilo and OpenRouter rankings
(usage, not quality). Unresolved, worth a second look: BFCL, LiveBench and Design Arena have data but no endpoint was
pinned down.

### The AA key, like the Jev key

- `init` gains a second optional step after Jev: `ARTIFICIAL_ANALYSIS_API_KEY` in the env wins; else the saved key;
  else `Artificial Analysis API key (optional; Enter skips): `. The key is tested before it is saved (one request to
  `/language/models/free?page=1`: 200 saves, 401 does not) and never stops `init` (Ruling 11).
- Saved in `credentials.json` as `artificialAnalysisApiKey` beside `typesafeApiKey`, mode 600; the schema is a
  `looseObject`, so no schema bump. The env name joins `SECRET_ENV` in `infra/env.ts`, the saved key goes through
  `addSecret`, so workers never see it and logs redact it.
- Per-user keys keep the licence clean: each user reads AA for their own use, and catherd never ships AA numbers. The
  keyless sources are CC-BY or Apache, so their values could be shipped in `scores.json` too, with attribution.
- `doctor` gets a row: key present, last sync time, requests left today (`x-ratelimit-remaining`).

### The sync

- **At every session start, in the background.** The plugin's MCP server starts with each Claude Code session, so its
  boot fires the sync without awaiting it: no hook to add, and the server's handshake and first tool call never wait
  on the network. One TTL for every source, 12 h: a source is fetched only if its cached file is older than that. It
  costs AA 2 requests a day (10 on fallback) of the key's 100. A lock file in `<data>/sources/` keeps two sessions
  opened together from fetching twice.
- **Refresh on demand.** `catherd catalog sync --force` ignores the TTL (CLI); the TUI's catalog view gets an `r`
  key that does the same and shows each source's age and last error; and an MCP tool `catalog_sync` lets the setup
  skill or the user refresh from inside a session, returning what changed (new rungs scored, stand-ins no longer
  needed, sources that failed). Routing reads whatever is cached when it is asked; a sync that lands mid-run
  is picked up by the next `route`, and a failed one logs at debug and leaves the last good files.
- `catherd catalog sync` runs the same thing in the foreground (also run by `init`, and by `freshenDiscovery` when the
  cache is older than the TTL). It fetches all
  sources in parallel with the Jev client's retry policy, one timeout per source, and writes each raw answer to
  `<data>/sources/<source>.json` with its fetch time. A source that fails keeps its last good file; the sync reports it
  and goes on.
- Id mapping: lowercase, `.` → `-` (`gpt-5.6-sol` → `gpt-5-6-sol`), then a small alias table in `catalog/sources.json`
  for the irregular ones (AA `claude-4-5-haiku` → `claude-haiku-4-5`). Effort: AA slug suffix (none = `max`), Arena's
  `(Max)` / `(xHigh)` / `(High)`, Epoch's `_max` suffix. A model with no effort in its name maps to the family's
  default effort, marked `effort: assumed`. Unmatched ids are listed by `catalog sync --unmatched`, never guessed.
- Catalog facts: models.dev fills `efforts`, `context`, `price`, `capabilities` for families on the user's backends;
  OpenRouter and LiteLLM only cross-check (a price that disagrees by more than 10 % is a warning). The shipped
  `models.json` stays the floor, and the backend's own listing still decides what is callable.

### Dimensions and sources

| Dim | Anchor (the unit of the bars) | Other sources, calibrated |
|---|---|---|
| `repo_code` | DeepSWE (today's shipped values) | AA `livecodebench`, `scicode`, coding index; Epoch FrontierCode |
| `terminal` | AA `terminalbench_v2_1` | Epoch `terminalbench_external` |
| `honesty` | shipped (Broken Search Tool) | Vectara factual consistency; Arena `agent_tool_hallucination` |
| `agentic` (new) | Arena `agent` Net Improvement | Arena task outcome and bash recovery; AA `tau2` |
| `steer` (new) | Arena `agent_steerability` | — |
| `frontend` (new) | Arena `webdev` | Epoch WebDev |
| `speed` (fact, not a bar) | AA tokens/s and time to first token | OpenRouter `latency_last_30m`, `throughput_last_30m` |
| `cost` (fact, not a bar) | models.dev price | AA `cost_per_task` |

Bars are in each dim's anchor unit, so a value from another source is never compared to a bar raw. Calibration: on
the rungs both sources cover, fit anchor = a·x + b (at least 5 shared rungs, else the source is not used for that
dim) and store the fit with its R² in `<data>/sources/calibration.json`. A calibrated value carries its source and
the fit. New dims ship with no bars, so they change nothing until a profile sets one; `route` shows them.

### Precedence and confidence

`Score.confidence` grows from `verified | secondary | inferred` to, best first: `verified` (vendor or official
source), `measured` (an independent source for this exact rung, anchor unit), `calibrated` (an independent source for
this rung, mapped onto the anchor), `adjacent` (same model, another effort, from any source), `secondary`,
`inferred`. The user's override always wins, as today. Two sources at the same level: the newer `date` wins. A value
older than 90 days drops one level. Every value keeps `benchmark`, `version`, `url`, `date` and its source, so `route`
and the TUI can say where a number came from.

### When a rung has no data: the user picks its stand-in

1. `sync` ends with the list of enabled rungs that still have no value on a dim their bars need.
2. For each, catherd ranks the scored rungs by similarity on what every source does have for new models: AA
   intelligence index, `hle`, `scicode`, `lcr`, `cost_per_task`, tokens/s, models.dev price and context, same vendor
   and family. The distance is a z-score Euclidean over the features both rungs have, and a pair with fewer than 3
   shared features is not suggested.
3. The TUI's treat-like picker opens with the top 3 suggestions first, each with its distance and the features it
   rests on ("Opus 5.5#high ≈ Fable 5.1#medium: intelligence 53.6 vs 48.9, scicode 0.60 vs 0.59, price $4/$20 vs
   $10/$50"). The CLI prints the same: `catherd catalog treat-like <rung> --suggest`. The user picks, or types any
   rung; the choice goes to `catalog.override.json` as today, marked `source: "user"`.
4. `init --no-input` and headless runs never block on it: they take the top suggestion as `inferred`, and `doctor`
   lists it as a warning to confirm.
5. When a later sync brings real data for that rung, the stand-in is no longer needed: `sync` says so and
   `catherd catalog treat-like <rung> --clear` removes it (a user's pick is never removed silently).

### Where it lives

- `src/infra/sources/<source>.ts`: one fetcher and parser per source, returning `{ rung, field, value, date, url }` rows.
- `src/services/source-sync.ts`: fetch, cache, id mapping, calibration, merge into the `Catalog` layers in
  `catalog-service.ts`.
- `src/domain/catalog.ts`: new dims in `DIMS`, the longer confidence enum, `RANK` extended.
- `src/entry/init-command.ts`: `aaStep` beside `jevStep`; `catalog-command.ts`: `sync [--force]`,
  `treat-like --suggest|--clear`; `entry/mcp/`: the background sync at server boot and the `catalog_sync` tool;
  `entry/tui/`: the `r` refresh key and the stand-in picker's suggestions.
- `catalog/sources.json`: aliases and the list of sources with their licence and attribution line.
- Tests: one recorded fixture per source (parsers), the id mapping table, the calibration fit, precedence, and the
  suggestion ranking on the 2026-09-27 data (Opus 5.5 has no coding or terminal value in any source that day).

### Today's gap, for calibration

On 2026-09-27 AA has full per-effort values for GPT-6 Astra, Claude Fable 5.1 and GPT-5.6 Sol/Terra/Luna, but only
intelligence index, `hle`, `scicode` and `lcr` for Opus 5.5 and GPT-6 Sol/Luna (released five days earlier); Arena's
agent board has GPT-6 Sol (Max) but not Opus 5.5 or GPT-6 Luna; Vectara has GPT-6 Sol and Astra. So the stand-in
picker is the path for exactly the rungs a fresh release adds, and each daily sync shrinks that list without anyone
typing a number.

## From the 1.1.0 install (2026-09-28)

- **An invalid profile cannot be repaired field by field.** Clearing `treatLike` in `catalog.override.json` left three
  rungs unscored (`gpt-5.6-sol#high`, `gpt-5.6-sol#medium`, `gpt-6-luna#medium`). Every `catherd profile set` then
  failed with `E_CONFIG_INVALID`, even a `set` that removes one of those rungs, because each save validates the whole
  profile and the other bad field still fails. The workaround was to restore the mappings, make the edits, and clear them
  again. Fix: a save that removes errors and adds none goes through, and the result lists the errors still open.
- **`treat-like` cannot be undone from the CLI.** There is no `catherd catalog treat-like --rm`, so the only way to
  reset a mapping is to edit `catalog.override.json` by hand. Add `--rm <rung>` and `--reset`. Before removing a mapping,
  warn which profile rungs it would leave unscored.

- **The runs tab shows 00:00 for running roles.** In the M3 platform run (2026-09-28), two workers had been running for
  3 minutes and their event logs were growing, yet the TUI showed `running 00:00` for both. The owner took this to mean
  the run was stuck. Elapsed time should count from `proc.json` `startedAt`. Also show the last event's age, so that
  "alive" and "stuck" look different.

## From the 1.1.0 platform run (2026-09-28/29)

Run `20260928-172920-m3-auth-plan-5-mr-b-the-kit-clean-up` (sanitell/platform, auth plan 5 MR B) went from 1.1.0 to 1.2.0 mid-run, during a pause. It ran seven worker lanes, a writer, a reviewer, and a verifier in three rounds. Evidence lives in that run folder (`runs.jsonl`, the lane files and the role records).

**Delivery and the loop**

- **Messages arrive only when the next turn starts.** worker-M3.L1 ended at 17:43:08, and its catherd message reached the main thread only after the owner's next message, about 20 min later. An idle main thread is not woken. Until something wakes it, `peek` is the only way to see it, and the owner read the silence as a hang. Fix: wake an idle owner session, or let `status` show "finished, unread" prominently.

**Lanes and Owns**

- **Clone-driven work needs a "discover, then split" step.** L4 (Task 12) stopped on four panel clones that `dupes` found only after the allowlist emptied, and needed a hand-written rescoped lane. `owns_add` (1.5) grows one lane's Owns; splitting work the gate discovers into new lanes is still by hand, because the files are knowable only after the gate runs.

**Resume (2026-09-29)**

- **A "foreground" verifier is still a background agent.** On the resume, the orchestrator briefed the verifier to stay in the foreground, and the Agent tool launched it async anyway ("Async agent launched successfully"). The verifier can block inside its own turn, but the main thread only learns the verdict from a notification. Fix: the skill says so plainly, and `protocol.next` treats the verifier as a dispatched role whose result arrives as a message, not as a call that returns.
- **`status` lists a previous owner session as live.** After a new session had taken the run, `status` and `peek` still listed the previous owner session as `live: true` (the stale verifier step itself closes since 1.5).

## From the payment run (2026-09-29)

catherd 1.2.1, profile just-claude, sanitell/platform payment plans 1–11. That is eleven runs, one per plan and its worktree, from `20260929-113331` (plan 1) to `20260929-145705` (plan 11). The run ended with eleven MRs merged to staging (!59–!62, !64–!70). Evidence lives in each run folder: `runs.jsonl`, `agents.jsonl`, the lane files and the role records.

**Preflight**

- **A broken check is called expected.** A compose file that is valid only layered on another failed `config -q`, and preflight called that `fails-as-expected`. Evidence: run `-143512`, M1.L5.

**Workers**

**Reviewers and verifiers**

- **The verifier runs in the background even when told not to.** The Agent call returned "Async agent launched" and an interim "waiting for the gate" message. The verdict came as a second notification. Evidence: runs `-113331` and `-133255`.
- **The verifier caught what review could not, and it paid off.** The hardened property walk, run `-count=3` by the verifier, found a real cross-payment ledger bug in refund. The plan 8 and plan 11 reviewers found real bugs as well. The loop earned its cost on this run.

**Outside catherd, noted for the orchestrator**

- **Branch pipelines held the runner.** Pushing five stacked branches started five branch pipelines on the single runner, and plan 5's MR pipeline sat pending for about 30 min. Stacked pushes need `-o ci.skip`.

## From the platform review-fix run (2026-09-30)

catherd 1.2.1, sanitell/platform review-fix plans 1–7, one run per plan and its worktree, seven MRs merged to staging (!73–!79) in about 13 h 20 min. Already listed above and seen again: one run per worktree (`dispatch` takes no cwd), and a "foreground" verifier that runs in the background anyway.

## From the agentic-machine identity run (2026-10-02)

catherd 1.4.0 on a Codex-only Linux host (Ubuntu 26.04, Codex CLI 0.160.0, opencode 2.0.21). Codex was the
coordinator, first on GPT-6.1 Sol medium and later on GPT-6 Astra medium. Run
`20261002-005043-identity-implementation-m1-through-m5` on sanitell/platform: five sequential MRs, full autopilot.
After 9 h 15 min it had 34 role dispatches and 496 role minutes, and M1 had not landed. Its code was reviewed and
clean by 03:30. The six and a half hours after that went to seven verifier attempts, mostly on environment
failures. The coordinator read 26.7 M input tokens (97 % cached). The harnesses were isolated until 10:20, when the
owner turned isolation off (the host is itself a sandbox).

- **Isolated roles cannot reach catherd's own tools.** The isolated `CODEX_HOME` has no catherd MCP server. The
  verifier was told to call `gate_check`/`gate_pass`, so it wrote a stdio MCP client (`/tmp/m1-verifier-mcp.py`),
  wrapped it in `/tmp/m1-gate.py`, and drove `catherd mcp` by hand for every gate item. That spawned about 200 one-shot `catherd mcp` processes, one per call (03:31–10:17 in
  `catherd-2026-10-02.jsonl`), each paying a boot and a reconcile. Fix: add CLI forms any role
  can run (`catherd gate check|pass`, `catherd run-file write`), name them in the verifier's brief, and stop
  telling an isolated role to call MCP tools. Or write a catherd-only `[mcp_servers]` entry into the isolated
  config. Isolation per role, not only per harness, would also have kept the verifier native here.
- **`run_start` could warn about an active Codex goal.** In the identity run a thread goal made Codex start a
  goal-continuation turn about once a minute (11 turns in 21 minutes, 7.2 M input tokens). Since 1.5 the skill ends
  such a turn with no tool call and `peek` answers `actionable: false`; a warning at `run_start` when the thread
  has an active goal would catch it before the first poll.

## Routing and cost

- **Jev hit-rate review.** After N runs, show how often each Jev start rung had to climb, per kind and difficulty:
  "build lanes on `codex:gpt-6-luna#high` climbed 3 of 10". _Why:_ it is the raw material for catalog tuning, and it
  tells the user whether a bar is too low today. _Where:_ `runs_summary`, `watch`, and the setup skill.
- **Jev difficulty calibration.** In the first two real runs Jev was sure of the kind (1.0) but not the difficulty
  (0.4), so 3 of 4 routes fell back to the default. Since 1.5 each lane's final outcome (climbed or not) is logged
  beside Jev's answer in `routes.jsonl` (plan 24): tune the difficulty question's wording, its options or its
  threshold from that data.
- **First-turn cost on small lanes.** A native Codex turn starts at about 280k input tokens (mostly cached) whatever
  the lane's size. A profile rule such as "isolated below difficulty build" could save most of it without touching the
  user's harness for real work. _Where:_ the profile's `harness.<backend>.isolated`, made conditional.

## Orchestration

- **Milestone per branch.** A real multi-MR build wants one branch and one MR per milestone, some in parallel. `land`
  only commits. _Where:_ an optional `branch` on milestones, and a finish step that opens the MR through the repo's
  own tooling.
- **Stacked milestones.** Starting M2 only after M1 merged serializes the run behind review and the gate. M2 could
  start on a branch stacked on M1 while M1's gate and MR run, and rebase once it merges.
- **Climb only for capability.** Half the climbs in the auth build were plan contradictions or file-ownership limits,
  which a stronger model cannot fix. Before climbing a `blocked` reply, `ask(run, "finding")`, and send `design` or
  ownership to the architect. _Evidence:_ `reports/2026-09-27-auth-build.md`, finding 5.
- **Verifier in the foreground, no polling.** All nine verifier calls ran in the background, and the main thread ran
  46 sleep/poll loops while waiting on dispatches. The `wait` tool removes the loops; `land` should record how the
  verdict was produced.

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
