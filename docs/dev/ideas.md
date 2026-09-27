# Ideas for 1.x

Improvements collected from real catherd runs and from designing it, not yet planned. When one is picked up it moves
into a spec or plan under `docs/superpowers/` (or a GitHub issue) and leaves this list. One entry per idea: what, why
(the evidence), and where it would live.

Shipped in 1.0, so not re-proposed here: `catherd doctor`; the harness-cost line in `runs_summary` and the final
report; quota failover (the profile's `failover` map); the `preflight` tool; per-repo knowledge
(`<data>/repos/<slug>-<hash8>/knowledge.md`, read with `read_knowledge`, appended by `land`); the run budget (from 80 %
`route` starts at the cheapest rung that clears the bar; once spent, `E_RUN_BUDGET` pauses the run); and the trimmed catalog (`catalog/models.json`, `scores.json`, `jev.json`).

## Top priority

- **Parallel dispatch is serial today.** The orchestrator sent four `dispatch` calls in one message at 09:20; the
  server started them at 09:20, 09:22, 09:24 and 09:28, each the moment the previous one returned. Claude Code runs
  MCP tool calls that are not marked read-only one after another, so "launch every lane in one message" buys nothing,
  and the main thread sits blocked for the sum of the lanes (15 min in M1 instead of about 7). Fix: `dispatch` spawns
  and returns at once with a handle, and a new `wait(run, any: true)` tool blocks until the next role finishes (and
  backgrounds after two minutes like any long call). Alternatively, a batch `dispatch` with a `roles` array. Do not
  mark `dispatch` `readOnlyHint`: that would be a lie that also loosens permission prompts.

- **Workers cannot run their own checks.** In the auth build 60 of 171 worker replies were `partial`/`blocked`
  because the sandbox denied Docker, loopback ports or the lock dir, so the Opus main thread ran the tests itself and
  even edited test files. Fix: network, the lock dir and `DOCKER_HOST` in the worker sandbox, or a `check(run, lane)`
  tool that runs the fast check outside it. _Evidence:_ `reports/2026-09-27-auth-build.md`, finding 1.
- **The skill decays after compaction.** Runs started after a compaction called no `route`, no reviewer and no
  verifier. Fix: `run_start` returns the checklist, `state.md` names the next protocol step, and `land` refuses a
  milestone without a review and a verdict unless the run says why. _Evidence:_ the same report, finding 3.
- **One owner question stops everything.** A blocked milestone should park with a push while independent milestones
  and runs continue; one question held the auth build for 4.5 h. _Evidence:_ the same report, finding 4.

## Routing and cost

- **Jev hit-rate review.** After N runs, show how often each Jev start rung had to climb, per kind and difficulty:
  "build lanes on `codex:gpt-6-luna#high` climbed 3 of 10". _Why:_ it is the raw material for catalog tuning, and it
  tells the user whether a bar is too low today. _Where:_ `runs_summary`, `watch`, and the setup skill.
- **Jev difficulty calibration.** In the first two real runs Jev was sure of the kind (1.0) but not the difficulty
  (0.4), so 3 of 4 routes fell back to the default. Log each lane's final outcome (climbed or not) beside Jev's answer,
  then tune the difficulty question's wording, its options or its threshold from that data.
- **First-turn cost on small lanes.** A native Codex turn starts at about 280k input tokens (mostly cached) whatever
  the lane's size. A profile rule such as "isolated below difficulty build" could save most of it without touching the
  user's harness for real work. _Where:_ the profile's `harness.<backend>.isolated`, made conditional.
- **`status` harness line.** It can say "codex native" while every dispatch in the run is isolated, and print a
  negative delta ("~-528k"), because it compares against past native runs on tiny repos. Show the current run's mode,
  and compare only runs on the same repo.

## Orchestration

- **A per-milestone digest.** One screen per landed milestone: A-lines met, commits, climbs, open findings, time and
  tokens. The push notification links it. _Why:_ the user asked "where is it" about 8 times in one run; the milestone
  push answers when, and the digest answers what. _Where:_ `land` writes it into the run folder; `watch` shows it.
- **Plan in hand: architect as translator.** When the user brings finished plan files, the architect should not
  redesign. It reads them, splits each task into lanes (owned files, a fast check) and each MR into a milestone with
  its full check, and stays the escalation target for `design` findings. The researcher dossier is skipped (a
  code-level plan already carries its file map; in one run the researcher still spent 5 min and 1.1M tokens) and the
  architect runs at medium effort. _Where:_ a `plan:` A-line recognized in the catherd skill, and a shorter architect
  brief.
- **Milestone per branch.** A real multi-MR build wants one branch and one MR per milestone, some in parallel. `land`
  only commits. _Where:_ an optional `branch` on milestones, and a finish step that opens the MR through the repo's
  own tooling.
- **Stacked milestones.** Starting M2 only after M1 merged serializes the run behind review and the gate. M2 could
  start on a branch stacked on M1 while M1's gate and MR run, and rebase once it merges.
- **Lint in the fast check.** Both M1 fix rounds in one run were lint findings that only the milestone gate caught. A
  lane's fast check should run the linter on its own packages (for example `golangci-lint run ./authz/...`).

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

An opencode lane, quota failover and a budget stop have run only in tests, never in a real orchestrated run. A climb
and a multi-milestone, multi-MR build are now covered live (the auth build, 8 climbs, 16 MRs).
