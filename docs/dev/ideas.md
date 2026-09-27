# Ideas for 1.x

Improvements collected from real catherd runs and from designing it, not yet planned. When one is picked up it moves
into a spec or plan under `docs/superpowers/` (or a GitHub issue) and leaves this list. One entry per idea: what, why
(the evidence), and where it would live.

Shipped in 1.0, so not re-proposed here: `catherd doctor`; the harness-cost line in `runs_summary` and the final
report; quota failover (the profile's `failover` map); the `preflight` tool; per-repo knowledge
(`<data>/repos/<slug>-<hash8>/knowledge.md`, read with `read_knowledge`, appended by `land`); the run budget (from 80 %
`route` starts at the cheapest rung that clears the bar; once spent, `E_RUN_BUDGET` pauses the run); the trimmed catalog (`catalog/models.json`, `scores.json`, `jev.json`); a plan in hand (a `plan:` A-line: no dossier, the architect translates); lint and type check in each lane's fast check; `status` showing the run's native and isolated dispatches, with the harness figure compared within one repo; and a sure Jev kind kept when its difficulty is unsure (`source: "jev-kind"`).

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

## From the 1.0.0 fresh install (2026-09-27)

A clean 1.0.0 setup on macOS after removing every 0.x file: `bunx catherd-cli init`, the plugin commands, `doctor`, the
TUI.

- **Plugin install fails without GitHub SSH (blocker).** `marketplace.json` gives the plugin a `git-subdir` source
  with `"url": "47vigen/catherd"`. The marketplace itself clones over HTTPS, but Claude Code clones that shorthand over
  SSH, so `claude plugin install catherd@catherd` dies with `ssh: connect to host github.com port 22` on any machine
  without GitHub SSH. 0.x used `"source": "./plugin"` and installed fine. Fix: `"url": "https://github.com/47vigen/catherd.git"`,
  keeping `path` and `ref`. Workaround used: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf
  GIT_CONFIG_VALUE_0=git@github.com: claude plugin install catherd@catherd`.
- **`doctor`'s sandbox probe is dead on current Codex.** `canWrite` runs `codex sandbox macos --full-auto`; Codex
  0.157 has no `macos` subcommand (`codex sandbox [COMMAND]`, seatbelt implied) and no `--full-auto` there, so the row
  reads "not tested: no codex sandbox to test with" on every current install. It is the one check meant to catch the
  auth build's top finding. Fix: probe `codex sandbox -- sh -c ...` first, fall back to the old form.
- **The worker sandbox still cannot run checks (auth-build finding 1, confirmed on 1.0).** Under `codex sandbox`, a
  write to the locks dir, the Docker socket (`docker ps`), a loopback `bind()` and a write to `/tmp` are all denied.
  The default worker is `workspace-write`, so a Go monorepo with testcontainers repeats the auth build. Fix options: a
  worker access level between `workspace-write` and `full` (network, loopback, the lock dir, `DOCKER_HOST`), or a
  `check(run, lane)` tool that runs the fast check outside the sandbox behind the lock; `doctor` should say which one
  this machine needs.
- **Failover downgrades high rungs.** The inferred failover maps `codex:gpt-6-sol#high` and `#xhigh` to
  `opencode-go/kimi-k3#max` "treated like gpt-6-sol#medium". A usage limit on a climbed lane silently drops it back
  to the medium tier it just climbed from. Prefer a stand-in that clears the rung's own bar, or mark the row as a
  downgrade in `profile show` and `doctor`.
- **Warnings on the defaults.** A fresh `doctor` shows two `!` rows (full access for verifier and ui-reviewer, advisory
  access for the Claude roles) about the shipped defaults, which the user did not choose and cannot act on. Show them
  as info, or only when the profile departs from the defaults.
- **Silent first `bunx`.** The first `bunx catherd-cli init` resolves about 108 packages (TypeScript among them,
  pulled in transitively) for about 30 s before any output. Check what pulls TypeScript into the runtime tree, and
  say "installing catherd…" before the resolve where possible (README: suggest `bun add -g catherd-cli` first).
- **TUI first frame.** The Status tab shows "active · 0 profiles" before the profile list loads, then "1 profile".

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

## Routing and cost

- **Jev hit-rate review.** After N runs, show how often each Jev start rung had to climb, per kind and difficulty:
  "build lanes on `codex:gpt-6-luna#high` climbed 3 of 10". _Why:_ it is the raw material for catalog tuning, and it
  tells the user whether a bar is too low today. _Where:_ `runs_summary`, `watch`, and the setup skill.
- **Jev difficulty calibration.** In the first two real runs Jev was sure of the kind (1.0) but not the difficulty
  (0.4), so 3 of 4 routes fell back to the default. Log each lane's final outcome (climbed or not) beside Jev's answer,
  then tune the difficulty question's wording, its options or its threshold from that data.
- **Batch `route`.** `route` takes one lane per call, and each call may wait up to 25 s on Jev, so a milestone of
  six lanes can spend minutes routing before its first dispatch. One `route(run, lanes: [...])` could ask Jev for
  every lane at once and return one answer per lane. _Where:_ the `route` tool and `routing-service.ts`.
- **First-turn cost on small lanes.** A native Codex turn starts at about 280k input tokens (mostly cached) whatever
  the lane's size. A profile rule such as "isolated below difficulty build" could save most of it without touching the
  user's harness for real work. _Where:_ the profile's `harness.<backend>.isolated`, made conditional.

## Orchestration

- **A per-milestone digest.** One screen per landed milestone: A-lines met, commits, climbs, open findings, time and
  tokens. The push notification links it. _Why:_ the user asked "where is it" about 8 times in one run; the milestone
  push answers when, and the digest answers what. _Where:_ `land` writes it into the run folder; `watch` shows it.
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
