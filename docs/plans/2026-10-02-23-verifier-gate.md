# catherd 1.5, plan 23: verifier, gate and environment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the verifier's gate and the machine it runs on stop eating runs. `gate_check` hashes a monorepo's tracked content and lockfiles (an absent build output is "absent", `node_modules` is never walked unless named) and lists the milestone's recorded items; a re-check goes to a fresh verifier with the failed items and a per-command cap; a role has its own timeouts, and a `catherd lock` that is still writing keeps its wall alive; `VERDICT: BLOCKED: environment` is a blocker to surface, never a fix round; a per-repo gate environment reaches the verifier and preflight; preflight runs in the login environment, tells an environment error (`cannot-start`) from a real failure, skips an empty pnpm filter, runs only unlanded lanes, reports `lock-busy` and warns about a fast check without lint; a partial review is not the review, and open BLOCKER/BUG lines name the fix round; `STATUS: flaky` and an `ENV:` line are outcomes of their own; an opencode provider outage fails over like a usage limit; doctor sees a Docker client's proxies, a compose network by service name, a full Docker disk and the toolchain caches; each dispatch has its own testcontainers session.

**Architecture:** The gate stays in `src/services/gate-service.ts` (hash from `git ls-files -s`, `recordedItems`, `failedItems`, `gateList`). The run's own facts for a verifier brief are assembled by a new `src/services/verifier-brief.ts` from the pure `src/domain/gate-brief.ts` (the rules every verifier gets, also in its agent file). Per-role timeouts live in the profile (`roles.<role>.timeouts`, `roleTimeouts` in `src/domain/profile.ts`); a new `src/infra/lock-activity.ts` is how `catherd lock` tells the supervisor it is writing. The gate environment is a new store, `src/services/gate-env.ts` (`<repo dir>/gate-env.json`, beside `knowledge.md`), with `catherd knowledge env`; the login environment is `src/infra/login-env.ts`. Verdicts and reviews are read in `src/services/milestones.ts` (`blockedByEnvironment`, `partialReviewer`, `openFindings`) and acted on by `land` (`lane-service.ts`) and `protocol.next` (`protocol.ts`). Reply outcomes (`flaky`, `ENV:`) are parsed in `src/domain/record.ts` and turned into hints in `src/domain/hints.ts`. Provider retries are counted by the supervisor from the adapter's `step` flag and its `providerRetry` hook; doctor's new rows are `src/services/doctor-docker.ts`.

**Tech Stack:** Bun ≥ 1.4, TypeScript, zod 4, citty, `@modelcontextprotocol/sdk`. No new dependency.

**Spec:** `docs/specs/2026-10-02-catherd-1.5-design.md`, "Plan 23: verifier, gate and environment"; evidence in `docs/dev/ideas.md` ("From the agentic-machine identity run", "From the payment run", "From the platform review-fix run", "From the 1.1.0 platform run", "From the 1.1.0 install").

**Pre-validated on scratch `6f2f8c7..fd5b8c2` (worktree branch `plan23-scratch`, code head `fd5b8c2`; this plan is the next commit): 2055 pass / 0 fail / 19 skip (2074 tests, 187 files, about 6 minutes); install, typecheck, lint and format:check green.** The code below is that scratch build, one commit per task, built on `main` at `6f2f8c7` ("fix: remove wait and restore the skill text (#45)"). Plans 21 and 22 run before this one (cross-plan ruling X1): the executor applies each diff by its context, re-finding hunks in files those plans changed (see "Risks for the executor" at the end).

## Global Constraints

- Layers `domain → infra → adapters → services → entry` (`test/architecture.test.ts`): `gate-brief.ts`, the reply parsers and the hints are domain; `lock-activity.ts`, `login-env.ts`, `host-probe.ts`, `heavy-lock.ts` are infra; `gate-env.ts`, `verifier-brief.ts`, `doctor-docker.ts` are services; the CLI and MCP surfaces are entry.
- The gate: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test` (run with `FORCE_COLOR` unset). Tests that could reach the network delete `ANTHROPIC_API_KEY` (in-process) or pass `ANTHROPIC_API_KEY: ""` (spawned); spawned processes get an explicit `env`. No wall-clock sleep for correctness: the 5 s host-probe pause (`hostProbe.retryMs`), the preflight lock budget (`preflightLimits.lockWaitMs`), the provider-retry thresholds (spec field `providerRetry`) and the Docker disk floor (`dockerDisk.minFreeBytes`) are seams the tests set.
- Commits: conventional (commitlint), subject ≤ 100 characters, **lower-case first word after the scope, and no upper-case word that reads as sentence case** (`feat(outcomes): a flaky reply status…`, not `…: STATUS: flaky…`); check `git log` after each commit (a failed hook leaves the changes uncommitted).
- Binding values from the spec, verbatim:
  - "`gate_check` hashes tracked content from `git ls-files -s` for the given paths plus the lockfiles; an absent ignored path hashes as "absent"; `node_modules` and gitignored outputs are walked only when a path names them; the 10000-file cap applies to that explicit walk only."
  - "`gate_check` lists the milestone's recorded items so a new verifier reuses their names; re-checks go to a fresh verifier by default with the failed items named and a per-command timeout in its brief."
  - "`roles.<role>.timeouts.{wallMin,idleMin}` in the profile; while a `catherd lock` child of the role is alive and writing, the wall counts from its last output. The verifier brief splits the root gate from the per-service acceptance items."
  - "`VERDICT: BLOCKED: environment` with the probe that proves it; `land` and `protocol.next` treat it as a blocker to surface, not a fix round. A host probe retries once after 5 s before calling the host blocked."
  - "A per-repo `gateEnv` (names and values, secrets by reference to env names only) in the repo's knowledge folder, settable by `catherd knowledge env set`; injected into verifier and preflight briefs and env."
  - Preflight: "runs in the user's login environment (`$SHELL -lc env` captured once per server); classes `cannot-start` (an environment error pattern: missing Docker, DNS, permission, rootless Docker not found) apart from `fails-as-expected`; a pnpm filter that matches nothing is `skipped`; it takes `milestone` and by default runs only lanes not landed; each check takes a lock slot with its own wait budget and reports `lock-busy` instead of timing out."
  - "A reviewer reply of `STATUS: partial` is not the milestone's review: `land` refuses it with a fix line (a scoped second pass over the unread files). `protocol.next` reads the reviewer record and names the fix round, not the verifier, while BLOCKER or BUG lines are open."
  - "`STATUS: flaky` is a worker outcome (the evidence: fails then passes alone); an `ENV:` line in a reply becomes a hint `environment: <what>` and climb refuses it."
  - "The lane template's fast check names the linter of every package the lane touches; `preflight` warns when a fast check has no lint step and the repo has one."
  - "The opencode adapter reads the session's `retry` field; after 3 provider retries or 3 min of retry-only events it ends the attempt `provider-unavailable`, which failover treats like a usage limit; retry-only events do not count as activity."
  - doctor "warns on a Docker client `proxies` block and probes a two-container compose network by service name; probes the toolchain caches; Go/pnpm/bun caches present on the machine join `writable_roots`."
  - "The verifier brief ends with `docker image prune -f` for images it built; `doctor` warns under 10 GB free in Docker's data root."
  - "Each dispatch gets `TESTCONTAINERS_RYUK_CONTAINER_NAME`-style isolation through `TESTCONTAINERS_SESSION_ID=<dispatch>` in its env."
  - "Acceptance items belong to the verifier by default; the worker contract says so."
- Cross-plan rulings carried in: `CATHERD_ROLE`, `E_ROLE_SCOPE`, the role server in every harness, the `catherd gate check|pass` and `run-file` CLI forms and per-role scratch (`TMPDIR`) are plan 21's (X4); this plan reads none of them and adds its own `CATHERD_DISPATCH_ID` (Ruling 7). The role server's `gate_check` (`src/entry/mcp/role-server.ts`, plan 21's file) is left as it is (Ruling 4). No new CI job (X6). No changeset (plans 21–26).

## Review Focus

1. **A monorepo verifier names a build output that is not built yet, and `.` for a turbo gate.** Expected: `gate_check` answers (no `E_INPUT_INVALID`), the output hashes as "absent" and as new content once built; `node_modules` is never walked under `.`; a lockfile bump outside the item's paths re-runs it. Pinned in Task 1: "hashes an absent ignored output as absent, not as an error, and its build as new content" and "covers dependencies through the tracked lockfiles, never walking node_modules under a named path".
2. **A 90-minute root gate behind `catherd lock`.** Expected: the verifier is not stopped at `wallMin` while the lock's command keeps printing, and is stopped once it has been silent for `wallMin`; a role's own `timeouts.wallMin` raises its wall alone. Pinned in Task 4: "counts the wall from a live catherd lock's last output while it writes" and Task 3: "gives a role its own timeouts over the profile's".
3. **The machine, not the code, fails (no `DOCKER_HOST`, a VPN, a Docker client proxy).** Expected: preflight says `cannot-start` with the line, the verifier's `VERDICT: BLOCKED: environment` makes `land` refuse with a park fix and `protocol.next` name the owner, and a worker's `ENV:` line makes `climb` refuse. Pinned in Task 7: "calls an environment error cannot-start, never fails-as-expected", Task 5: "treats VERDICT: BLOCKED: environment as a blocker to surface, in land and in the next step" and Task 9: "refuses to climb a lane whose last reply named the environment".
4. **An opencode provider answers 503 for minutes.** Expected: the attempt ends `provider-unavailable` within 3 retries or 3 minutes, the record is a `limit` that fails over, and retry-only events never reset the idle timer. Pinned in Task 12: "ends an attempt that only retries its provider as provider-unavailable", "never counts retry-only events as activity, and reads a quiet session's own retry field" and "ends a provider outage as a limit, so failover moves the lane to the next backend".
5. **A low-effort reviewer replies `STATUS: partial`, or a full one reports a BLOCKER.** Expected: `land` refuses the partial review with a scoped second pass, and `protocol.next` names the fix round before the verifier until a fix ends ok. Pinned in Task 8: "refuses a partial review, and names the fix round while BLOCKER or BUG lines are open" and "refuses a native reviewer recorded with reply_status partial, until a full pass".
6. **A secret in the gate environment.** Expected: it is stored as a reference only, never in `gate-env.json` or a dispatch's `spec.json`, and is resolved when the verifier starts. Pinned in Task 6: "puts the gate env into a verifier's spec, a secret by reference only, and none into a worker's" and "refuses a secret-looking name by value, a bad name, and removing what is not set".

## Rulings

Every ambiguity this plan decided (`Ruling: <what> — <why> — <cost if wrong>`):

1. Ruling: the gate hash reads the index (`git ls-files -s -z -- <path>`), plus `git status` for every uncommitted change, as before; a staged change therefore counts twice — the spec names `git ls-files -s`, and the status part keeps a dirty tree's hash honest — none: both parts are content.
2. Ruling: "the lockfiles" are a fixed list (`bun.lock`, `bun.lockb`, `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `go.sum`, `Cargo.lock`, `poetry.lock`, `uv.lock`, `Gemfile.lock`, `composer.lock`), tracked anywhere in the repo (`:(glob)**/<name>`), in every item's hash, as is an uncommitted change to one (its status entry, final-review I3) — a dependency change can reach any item; a list is enough for the stacks the runs used — a lockfile bump re-runs every gate item (conservative), and a stack whose lockfile is not listed is covered only by its tracked manifests.
3. Ruling: an ignored path is "absent" when git ignores it, or ignores a child of it (`<path>/.catherd`), so a directory pattern (`dist/`) matches an output not built yet; a path neither tracked, on disk nor ignored is still refused (a typo) — `git check-ignore` cannot match a directory pattern against a path that does not exist — none known.
4. Ruling: `gate_check` with only `run` and `milestone` lists `{ recorded, env }` and records no step; with an item and a milestone it adds `recorded`; the role server's `gate_check` (plan 21's file) is not changed, so a headless verifier gets the list through its brief (Task 10) and `recorded` on its first item — plan 21 owns that file and its schema — a headless verifier sees the list only in its brief and after its first check.
5. Ruling: "re-checks go to a fresh verifier by default" is the protocol's next step, the skill and the brief (failed items first, each command capped at 10 minutes, `RECHECK_COMMAND_MIN`), not a refusal of `dispatch(thread:)` — the evidence's workaround was a 10-minute cap; refusing a resume would take a tool the owner may still want — an orchestrator can still resume a verifier and hang.
6. Ruling: per-role timeouts are a partial override (`roles.<role>.timeouts.idleMin` and/or `wallMin`), set by `profile set`/`profile_set`, cleared with `null`, shown under the profile's timeouts in `profile show`; the TUI's profile tree is not extended — smallest change; the TUI edits the profile-wide timeouts — a TUI user edits a role's timeouts through the CLI.
7. Ruling: "a `catherd lock` child of the role is alive and writing" is told by the lock itself: admission puts `CATHERD_DISPATCH_ID=<dispatch>` in every dispatch's env; inside a dispatch `catherd lock` pipes its command's output through (otherwise it keeps inherited stdio) and writes `<locks>/activity/<dispatch>/<pid>.json` at most once a second; the supervisor's wall is `now - max(start, latest output of a live lock seen at any poll) >= wallMs` (a running max: a lock that exits keeps its last output, final-review C1), with no cap of its own — plan 21's `CATHERD_ROLE` names a role, not a dispatch, and the locks dir is the one dir every role may write — a command that prints forever keeps its role alive past `wallMin` (cancel and the idle timeout still apply).
8. Ruling: `VERDICT: BLOCKED: environment — <probe>` is read from a headless verifier's first reply line, and from a new optional `verdict` argument of `record_agent_run` for a native one (its status `failed`); the blocker wins over the FAIL wording in `land` and `protocol.next` — a native verifier has no reply catherd keeps — a native verifier recorded without `verdict` reads as a plain FAIL (a fix round).
9. Ruling: catherd's own host probe is doctor's compose network probe (`probeTwice`, 5 s, `hostProbe.retryMs`); the verifier's probes get the rule in its brief and agent file ("twice, 5 s apart") — catherd ships no other host probe — none.
10. Ruling: the gate environment is `<data>/repos/<repo key>/gate-env.json` (schema 1, beside `knowledge.md` and `gates.jsonl`): `{ value }` or `{ from: <env var> }` per name; a secret-looking name (`KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH`) is refused by value; a name catherd sets in a dispatch (`CATHERD_ROLE`, `CATHERD_DISPATCH_ID`, `TESTCONTAINERS_SESSION_ID`, `TMPDIR`, `PWD`, `PATH`, `HOME`, catherd's dirs, the isolated CLI homes) is refused, and so is a reference to one of catherd's own secrets; the dispatch's own env is applied after the gate env, values and references alike (final-review I4); `catherd knowledge env set NAME=value | NAME --from VAR`, `env rm NAME`, `env list` — "names and values, secrets by reference to env names only", in "the repo's knowledge folder" — a secret under an innocent name can still be stored by value (the user typed it).
11. Ruling: the gate environment reaches a verifier dispatch's env (values in `spec.json`, references as `envFrom`, read by the supervisor from its own env, else the login env) and every preflight check; other roles do not get it; a native verifier gets the lines from `gate_check(run, milestone)` to export — "injected into verifier and preflight"; a native subagent runs in the orchestrator's env — a native verifier that skips the export runs without it.
12. Ruling: "preflight briefs" is read as preflight's environment: preflight runs checks itself and has no brief — none.
13. Ruling: the login environment is `$SHELL -lc 'env -0 2>/dev/null || env'`, 5 s cap, once per process, catherd's secrets scrubbed; preflight's base env is the server's env overlaid by the login env with `PATH` merged (login first), through the check allowlist widened with the toolchain variables (`DOCKER_HOST|CONTEXT|CONFIG|CERT_PATH|TLS_VERIFY`, `TESTCONTAINERS_*`, the proxy variables, `GOPATH|GOCACHE|GOMODCACHE|GOFLAGS|GOPROXY|GOPRIVATE|GONOSUMDB|GOTOOLCHAIN`, `PNPM_HOME`, `npm_config_store_dir`, `BUN_INSTALL[_CACHE_DIR]`, `NVM_DIR`, `JAVA_HOME`, `CARGO_HOME`, `RUSTUP_HOME`) — the evidence was `DOCKER_HOST` and `HTTPS_PROXY`; spec §4.7's allowlist still keeps credentials out — a proxy URL with a password in it reaches a check.
14. Ruling: an environment error is one of: `command not found`, `Cannot connect to the Docker daemon`, `rootless Docker not found`, `Could not find a valid Docker environment`, a missing `docker.sock`, a DNS failure (`Temporary failure in name resolution`, `Could not resolve host`, `no such host`, `Name or service not known`, `nodename nor servname`, `getaddrinfo ENOTFOUND|EAI_AGAIN`), or a denied permission (`permission denied`, `operation not permitted`, `EACCES`, `EPERM`) in the tail of a failed check; its note names the line — the spec's four classes, as the runs printed them — a test that prints "permission denied" as a real failure is called `cannot-start` (the lane's check is then re-run by hand).
15. Ruling: pnpm's "No projects matched the filters" makes a check `skipped` whatever its exit code; preflight runs the lanes of milestones not in the ledger, or the `milestone` named; each check waits at most 60 s (`preflightLimits.lockWaitMs`) for a heavy slot and is `lock-busy` (not blocking) past it — the spec; the MCP call's own budget was 300 s — a busy machine needs a second `preflight`.
16. Ruling: the repo "has a lint" when its root holds a golangci, biome, eslint, oxlint or ruff config, or `package.json` has a `lint` script; a fast check "has a lint step" when it names `lint`, `eslint`, `biome`, `oxlint`, `golangci-lint`, `ruff`, `clippy`, `vet` or `check`; the warning is in preflight's `warnings` — smallest reading of "the repo has one" — a linter configured only inside a package is not seen.
17. Ruling: a partial review is a headless reviewer record with `replyStatus: partial`, or a native one recorded with the new `record_agent_run` argument `reply_status: "partial"`; a later full review stands; the second pass is named `reviewer-<M>-2` (which `reviewsMilestone` already accepts) — the evidence's reviewers were native (just-claude) — a native reviewer recorded without `reply_status` still counts as a full review.
18. Ruling: open findings are the BLOCKER and BUG lines of the latest full headless reviewer reply, closed once any worker, writer or artist record or native run of the milestone ends ok after that review; a native reviewer's findings are not read — catherd keeps only a headless reviewer's reply — after a native review the next step stays the verifier, as today.
19. Ruling: `flaky` joins the reply statuses (`RunRecordSchema.replyStatus`, `record_agent_run`'s `reply_status`); a flaky reply counts as done for `protocol.next` and gets the hint `flaky: <why>; rerun it alone, accept it, or climb: your call` instead of `climb: unchanged` — the spec makes it a worker outcome; the call stays the orchestrator's — a catherd older than 1.5 reads a flaky record as invalid (no downgrade path is promised).
20. Ruling: an `ENV: <what>` line anywhere in a reply is recorded as `record.environment`; its hint `environment: <what>` replaces the climb hints; `climb` refuses with a new code `E_CLIMB_ENV` when the lane's last record has it, `env: true` or not — "climb refuses it"; `env: true` keeps its meaning for a climb the orchestrator decides — a new error code for plan 27's MIGRATION notes.
21. Ruling: the Docker host probes (the compose network by service name, the free space in Docker's data root) run with `catherd doctor --docker`; the client `proxies` row and the toolchain caches row are in every `doctor` — the compose probe pulls busybox and starts containers, which a plain `doctor` (and its tests) must not do — Owner question 1.
22. Ruling: the Docker disk row reads `docker info --format '{{.DockerRootDir}}'` and `statfs` on it when that path is on this machine; with Docker in a VM (macOS) the row is absent — the host cannot see the VM's disk — a macOS user gets no disk warning from doctor.
23. Ruling: "Go/pnpm/bun caches present on the machine join `writable_roots`" is already true (`writableRoots()` → `toolchainCaches()`, since 1.1); this plan adds doctor's `caches` row, warning on a cache the user cannot write — the spec bullet restates the 1.1.0-install fix — none.
24. Ruling: `TESTCONTAINERS_SESSION_ID=<dispatch id>` goes into every dispatch's env, whatever the role; whether each testcontainers library reads it is a live-verification step (X8) — the spec's literal fix; no library source is in the sandbox — a library that ignores it still shares a reaper (the live step names the variable it reads instead).
25. Ruling: a provider retry is a `step_start` right after another with nothing between (the adapter's new `step` flag), or, after 30 s of quiet, the attempt number of the session's own `retry` field (the adapter's new `providerRetry` hook), which when it reports no retry clears the stream's count (the retry worked; the quiet is work, final-review I2); 3 retries or 3 minutes of them end the attempt `provider-unavailable` (a new exit reason), which opencode records as `limit` with `error.code: provider-unavailable`, so failover and its pause are the usage-limit ones; opencode's `isBusy` is false while it retries; claude-code's `api_retry` lines are not counted — the spec names the opencode adapter — a claude-code provider outage still waits for its idle timeout.
26. Ruling: the verifier's rules also say "stay in the foreground until your verdict: no background watcher, and never end your turn while a command runs" — that is the fix the 1.1.0 platform run's "The foreground verifier handed off and ended" names, so this plan removes that entry from `ideas.md` — none.
27. Ruling: acceptance built from HEAD belongs to the verifier through the worker's reply contract and the verifier's rules; no WIP-commit escape — the spec's "by default" — a lane that must run its own acceptance says so in its brief.
28. Ruling: a verifier dispatch's milestone is the first `M<n>` its name names as a word (`verifier-M1`, `verifier-M12-recheck`); a name with none gets the rules without recorded items — the skill names verifiers `verifier-<M>` — a verifier named otherwise gets no item list.
29. Ruling: Task 2 first puts `RECHECK_COMMAND_MIN` in `gate-service.ts`; Task 10 moves it to `src/domain/gate-brief.ts` — the scratch was built in this order — none (the executor may define it in the domain file in Task 2 and skip the move).

Owner questions (each built as recommended):

1. Should plain `catherd doctor` run the Docker compose probe (it pulls `busybox:1.36` and starts two containers)? Recommended and built: no, behind `--docker`; the proxies row (the cause of three of the seven verifier attempts) is in every `doctor`.

## Spec coverage

| Spec bullet (plan 23) | Task |
| --- | --- |
| Gate paths for monorepos | 1 |
| `gate_check` lists the milestone's recorded items; re-checks to a fresh verifier with failed items and a per-command timeout | 2, 10 |
| Per-role timeouts; a writing `catherd lock` keeps the wall; the brief splits the root gate from acceptance | 3, 4, 10 |
| `VERDICT: BLOCKED: environment`; a host probe retries once after 5 s | 5 (13 uses the retry) |
| Gate environment, `catherd knowledge env set`, injected into verifier and preflight | 6, 7, 10 |
| Preflight: login env, `cannot-start` vs `fails-as-expected`, empty pnpm filter, `milestone` and unlanded lanes, `lock-busy` | 7 |
| The review step: partial review refused; fix round while BLOCKER/BUG are open | 8 |
| Outcomes: `STATUS: flaky`; `ENV:` → `environment:` hint, climb refuses | 9 |
| Lint reaches the worker: lane template; preflight warning | 10 (template), 7 (warning) |
| Provider outages fail over | 12 |
| doctor: Docker proxies, compose network, toolchain caches, caches in `writable_roots` | 13 (Ruling 23) |
| Docker cleanup: `docker image prune -f` in the brief; doctor under 10 GB | 10, 13 |
| Testcontainers reaper | 11 |
| Acceptance built from HEAD | 9 (worker contract), 10 (verifier rules) |
| `ideas.md` entries this plan fixes removed | 14 |

## Parallelism

Most tasks share a file with an earlier one (`admission.ts`, `SKILL.md`, `protocol.ts`, `milestones.ts`, `supervisor.ts`, `docs/dev/live-verification.md`), so the waves are mostly serial. Each wave's tasks touch disjoint files and run in parallel worktrees; a task's diff assumes every earlier task that touched its files.

| Wave | Tasks | Files |
| --- | --- | --- |
| 1 | 1 ∥ 3 | 1: `src/services/gate-service.ts`, `test/services/gate-service.test.ts` · 3: `src/domain/profile.ts`, `src/services/ports.ts`, `src/services/admission.ts`, `src/entry/profile-command.ts`, `src/entry/mcp/setup-tools.ts`, `test/domain/profile.test.ts`, `test/entry/profile-command.test.ts`, `test/services/admission.test.ts` |
| 2 | 2 ∥ 4 | 2: `src/services/gate-service.ts`, `src/entry/mcp/protocol-tools.ts`, `src/services/protocol.ts`, `plugin/skills/catherd/SKILL.md`, `test/services/gate-service.test.ts`, `test/services/protocol.test.ts` · 4: `src/infra/lock-activity.ts` (new), `src/infra/supervisor.ts`, `src/entry/lock-command.ts`, `src/services/admission.ts`, `test/infra/lock-activity.test.ts` (new), `test/infra/supervisor.test.ts`, `test/entry/lock-command.test.ts`, `test/services/admission.test.ts` |
| 3 | 5 ∥ 6 | 5: `src/services/milestones.ts`, `src/services/lane-service.ts`, `src/services/protocol.ts`, `src/services/run-store.ts`, `src/services/run-service.ts`, `src/entry/mcp/run-tools.ts`, `src/domain/role-prompts.ts`, `src/infra/host-probe.ts` (new), `plugin/skills/catherd/SKILL.md`, `test/services/land-gate.test.ts`, `test/services/dispatch-protocol.test.ts`, `test/infra/host-probe.test.ts` (new) · 6: `src/infra/login-env.ts` (new), `src/services/gate-env.ts` (new), `src/services/admission.ts`, `src/infra/supervisor.ts`, `src/entry/supervise-command.ts`, `src/entry/knowledge-command.ts`, `README.md`, `test/services/gate-env.test.ts` (new), `test/entry/knowledge-command.test.ts` |
| 4 | 7 | `src/services/preflight.ts`, `src/infra/heavy-lock.ts`, `src/infra/env.ts`, `src/entry/mcp/lane-tools.ts`, `plugin/skills/catherd/SKILL.md`, `test/services/preflight.test.ts` |
| 5 | 8 | `src/services/milestones.ts`, `src/services/lane-service.ts`, `src/services/protocol.ts`, `src/services/run-store.ts`, `src/services/run-service.ts`, `src/entry/mcp/run-tools.ts`, `plugin/skills/catherd/SKILL.md`, `test/services/land-gate.test.ts`, `test/services/protocol.test.ts` |
| 6 | 9 | `src/domain/record.ts`, `src/domain/hints.ts`, `src/domain/errors.ts`, `src/domain/role-prompts.ts`, `src/services/finalize.ts`, `src/services/lane-service.ts`, `src/services/run-store.ts`, `src/entry/mcp/run-tools.ts`, `src/entry/mcp/lane-tools.ts`, `plugin/skills/catherd/SKILL.md`, `test/domain/record.test.ts`, `test/domain/run-rules.test.ts`, `test/services/climb-design.test.ts`, `test/services/dispatch-protocol.test.ts`, `test/services/dispatch.test.ts` |
| 7 | 10 | `src/domain/gate-brief.ts` (new), `src/services/verifier-brief.ts` (new), `src/domain/role-prompts.ts`, `src/services/admission.ts`, `src/services/gate-service.ts`, `src/services/protocol.ts`, `plugin/skills/catherd/SKILL.md`, `test/services/verifier-brief.test.ts` (new), `test/domain/agents.test.ts`, `test/services/gate-service.test.ts`, `test/skills.test.ts` |
| 8 | 11 | `src/services/admission.ts`, `docs/dev/live-verification.md`, `test/services/admission.test.ts` |
| 9 | 12 ∥ 13 | 12: `src/adapters/backend.ts`, `src/adapters/opencode/index.ts`, `src/domain/record.ts`, `src/domain/hints.ts`, `src/infra/supervisor.ts`, `src/entry/supervise-command.ts`, `docs/dev/live-verification.md`, `test/adapters/opencode.test.ts`, `test/adapters/opencode-session.test.ts`, `test/domain/run-rules.test.ts`, `test/infra/supervisor.test.ts` · 13: `src/services/doctor-docker.ts` (new), `src/services/doctor.ts`, `src/entry/doctor-command.ts`, `README.md`, `docs/dev/live-verification.md`, `test/services/doctor-docker.test.ts` (new), `test/services/doctor.test.ts`. Both append one row to the table at the end of `docs/dev/live-verification.md`: on a cherry-pick conflict keep both rows, Task 12's first. |
| 10 | 14 | `docs/dev/ideas.md` |

Run the full gate once on the combined head after each wave.

## Tasks

Each task is one scratch commit; its diff below is the complete change (new files whole, existing files by hunk). Apply the test hunks first and watch the named tests fail, then the source hunks.

### Task 1: gate paths for monorepos

**Scratch commit:** `c336a2d` — `fix(gate): hash tracked content and lockfiles, and an absent ignored path as absent`

**Files:** modify `src/services/gate-service.ts`, `test/services/gate-service.test.ts`.

**Produces:** `LOCKFILES` (exported list); `contentHash` reads `git ls-files -s -z -- <path>` per path and the tracked lockfiles (`:(glob)**/<name>`), hashes an ignored path that is not there as `absent`, walks from disk only a named ignored path or a named symlink (the 10000-file cap applies to that walk only), and keeps the `git status` part for uncommitted changes. `ignored()` also asks for `<path>/.catherd`, so a directory pattern matches an output not built yet. The `E_INPUT_INVALID` message is unchanged; its fix adds "a git-ignored output not built yet is fine".

- [ ] **Step 1: the failing tests.** Add "hashes an absent ignored output as absent, not as an error, and its build as new content" and "covers dependencies through the tracked lockfiles, never walking node_modules under a named path" (the `test/services/gate-service.test.ts` hunk). Run `bun test test/services/gate-service.test.ts`: both fail (the first with `E_INPUT_INVALID … apps/checkout/dist exists neither at HEAD nor in the working tree`).
- [ ] **Step 2: the code.** Apply the `src/services/gate-service.ts` hunks.
- [ ] **Step 3:** `bun test test/services/gate-service.test.ts` passes (14 tests); `bun run typecheck && bun run lint`.
- [ ] **Step 4: commit** `fix(gate): hash tracked content and lockfiles, and an absent ignored path as absent`.

```diff
diff --git a/src/services/gate-service.ts b/src/services/gate-service.ts
index a6982cd..0b3d324 100644
--- a/src/services/gate-service.ts
+++ b/src/services/gate-service.ts
@@ -1,12 +1,4 @@
-import {
-  existsSync,
-  lstatSync,
-  readdirSync,
-  readlinkSync,
-  realpathSync,
-  type Stats,
-  statSync,
-} from "node:fs";
+import { lstatSync, readdirSync, readlinkSync, realpathSync, type Stats, statSync } from "node:fs";
 import { join } from "node:path";
 import { z } from "zod";
 import { CatherdError, isCatherdError } from "../domain/errors.ts";
@@ -148,7 +140,10 @@ const isLink = (file: string): boolean => {
 
 /** Whether git ignores `p` (a tracked file never is). */
 async function ignored(repo: string, p: string): Promise<boolean> {
-  return (await git(repo, ["check-ignore", "-q", "--", p.replace(/\/$/, "")])).kind === "ok";
+  const bare = p.replace(/\/$/, "");
+  const asked = async (q: string) => (await git(repo, ["check-ignore", "-q", "--", q])).kind === "ok";
+  // a directory pattern (`dist/`) matches a path that is not on disk yet only through a child of it
+  return (await asked(bare)) || (!onDisk(join(repo, bare)) && (await asked(`${bare}/.catherd`)));
 }
 
 /** The most files a gate path's on-disk walk hashes. */
@@ -179,37 +174,85 @@ function walk(repo: string, p: string): string[] {
 }
 
 /**
- * The content hash of `paths`: each one's tree entry at HEAD (mode, type and object id), plus the content of every
- * uncommitted change under them, so a verifier checking a tree not yet committed gets a hash of what it ran.
- * A path git ignores, or one not at HEAD, is also hashed file by file from disk; ignored files under `.` or
- * under a tracked directory are not, so an ignored input is covered only when it is named.
+ * The lockfiles a gate item's dependencies come from, wherever the repo tracks them: they stand in for
+ * `node_modules` and the toolchain caches, which a gate path never needs to name (plan 23).
+ */
+export const LOCKFILES = [
+  "bun.lock",
+  "bun.lockb",
+  "package-lock.json",
+  "npm-shrinkwrap.json",
+  "pnpm-lock.yaml",
+  "yarn.lock",
+  "go.sum",
+  "Cargo.lock",
+  "poetry.lock",
+  "uv.lock",
+  "Gemfile.lock",
+  "composer.lock",
+];
+
+/** `git ls-files -s -z` for `pathspecs`: each tracked file's mode, object id, stage and path, as the index holds them. */
+async function tracked(repo: string, pathspecs: string[]): Promise<string> {
+  const r = await git(repo, ["ls-files", "-s", "-z", "--", ...pathspecs]);
+  if (r.kind !== "ok")
+    throw new CatherdError(
+      "E_IO_UNEXPECTED",
+      `git ls-files ${r.kind === "timed-out" ? "timed out" : "failed"} in ${repo}`,
+      { fix: `check that git works in ${repo}` },
+    );
+  return r.out;
+}
+
+/** Whether anything is at `file` on disk, a dangling symlink included. */
+const onDisk = (file: string): boolean => {
+  try {
+    lstatSync(file);
+    return true;
+  } catch {
+    return false;
+  }
+};
+
+/**
+ * The content hash of `paths` (plan 23, a monorepo gate): the tracked files under each one, from `git ls-files -s`
+ * (mode, object id and path, so a committed chmod -x is new content), the repo's tracked lockfiles, and the
+ * content of every uncommitted change under them, so a verifier checking a tree not yet committed gets a hash of
+ * what it ran. An ignored path named explicitly (a `.env`, a build output, a `node_modules` folder) is hashed
+ * from disk, file by file within GATE_WALK_MAX, and as "absent" while it is not there; ignored files under `.`
+ * or under a tracked directory are never walked. A named symlink is hashed by what it points at too.
  */
 async function contentHash(repo: string, paths: string[]): Promise<string> {
   const h = new Bun.CryptoHasher("sha256");
+  // a dependency bump reaches every gate item through its lockfile
+  h.update(
+    `locks=${sha(
+      await tracked(
+        repo,
+        LOCKFILES.map((l) => `:(glob)**/${l}`),
+      ),
+    )}\n`,
+  );
   for (const p of paths) {
-    // the tree entry, mode and type with the object id (`100755 blob <sha>`), so a committed chmod -x is new
-    // content; a directory's tree id already covers its children's modes
-    const entry = await git(
-      repo,
-      p === "."
-        ? ["rev-parse", "HEAD^{tree}"]
-        : ["ls-tree", "--full-tree", "HEAD", "--", p.replace(/\/$/, "")],
-    );
-    const at = entry.kind === "ok" ? entry.out.trim() : "";
-    // a mistyped path (or a glob) would hash as a constant and carry a pass forever
-    if (!at && !existsSync(join(repo, p)))
+    const bare = p.replace(/\/$/, "");
+    const listed = await tracked(repo, [p === "." ? "." : bare]);
+    const there = p === "." || onDisk(join(repo, bare));
+    const isIgnored = p !== "." && listed === "" && (await ignored(repo, p));
+    // a mistyped path (or a glob) would hash as a constant and carry a pass forever; an ignored output that
+    // is not built yet is part of the content, as "absent"
+    if (listed === "" && !there && !isIgnored)
       throw new CatherdError(
         "E_INPUT_INVALID",
         `gate path ${p} exists neither at HEAD nor in the working tree`,
         {
-          fix: "check the spelling: pass repo-relative files or directories that exist, like src/ or package.json (no globs)",
+          fix: "check the spelling: pass repo-relative files or directories that exist, like src/ or package.json (no globs); a git-ignored output not built yet is fine",
         },
       );
-    h.update(`${p}=${at || "missing"}\n`);
-    // git status leaves ignored files out, so an ignored path (.env, a build output) or one not at HEAD is
-    // hashed by what is on disk; "." keeps to HEAD and the not-ignored status. A symlink's HEAD entry is only
-    // its link text, so a named symlink is hashed from disk too, by what it points at
-    if (p !== "." && (!at || isLink(join(repo, p)) || (await ignored(repo, p)))) {
+    h.update(`${p}=${listed ? sha(listed) : there ? "untracked" : "absent"}\n`);
+    // git status leaves ignored files out, so an ignored path named here is hashed by what is on disk; "."
+    // keeps to the index and the not-ignored status. A tracked symlink's index entry is only its link text,
+    // so a named symlink is hashed from disk too, by what it points at
+    if (p !== "." && there && (isIgnored || isLink(join(repo, bare)))) {
       // one budget per gate path: its walk and every symlink target it follows count against GATE_WALK_MAX
       const budget: Budget = { path: p, files: 0, seen: new Set() };
       for (const f of walk(repo, p)) h.update(`disk ${f}=${await diskEntry(join(repo, f), budget)}\n`);
diff --git a/test/services/gate-service.test.ts b/test/services/gate-service.test.ts
index 952b770..d00fba9 100644
--- a/test/services/gate-service.test.ts
+++ b/test/services/gate-service.test.ts
@@ -247,6 +247,42 @@ describe("the gate ledger (spec 1.1 §7)", () => {
     }
   });
 
+  it("hashes an absent ignored output as absent, not as an error, and its build as new content", async () => {
+    const { repo, run } = freshRun();
+    write(repo, ".gitignore", "dist/\n");
+    write(repo, "apps/checkout/src/a.ts", "a");
+    commit(repo);
+    const deps = fakeDeps();
+    const built = item(run.id, { paths: ["apps/checkout/", "apps/checkout/dist"] });
+    expect(await gateCheck(deps, built)).toEqual({ carried: false });
+    await gatePass(deps, { ...built, evidence: "ok" });
+    expect(await gateCheck(deps, built)).toMatchObject({ carried: true });
+    write(repo, "apps/checkout/dist/index.js", "x");
+    expect(await gateCheck(deps, built)).toEqual({ carried: false });
+  });
+
+  it("covers dependencies through the tracked lockfiles, never walking node_modules under a named path", async () => {
+    const { repo, run } = freshRun();
+    write(repo, ".gitignore", "node_modules/\n");
+    write(repo, "apps/web/src/a.ts", "a");
+    write(repo, "bun.lock", "v1");
+    write(repo, "apps/web/package.json", "{}");
+    commit(repo);
+    // more files than a walk takes, under an ignored folder inside the gate's paths
+    for (let i = 0; i < 10_001; i++) write(repo, `node_modules/.bun/p${i % 10}/f${i}`, "");
+    const deps = fakeDeps();
+    const whole = item(run.id, { paths: ["."] });
+    const web = item(run.id, { paths: ["apps/web/"] });
+    await gatePass(deps, { ...whole, evidence: "ok" });
+    await gatePass(deps, { ...web, evidence: "ok" });
+    expect(await gateCheck(deps, whole)).toMatchObject({ carried: true });
+    // a lockfile change outside apps/web/ still reaches the apps/web/ item
+    write(repo, "bun.lock", "v2");
+    commit(repo);
+    expect(await gateCheck(deps, web)).toEqual({ carried: false });
+    expect(await gateCheck(deps, whole)).toEqual({ carried: false });
+  });
+
   it("records each check as the verifier's step, which status shows", async () => {
     const { repo, run } = freshRun();
     write(repo, "src/a.ts", "a");
```

### Task 2: `gate_check` lists the milestone's recorded items; a re-check goes to a fresh verifier

**Scratch commit:** `489d707` — `feat(gate): gate_check lists the milestone's recorded items; a re-check goes to a fresh verifier`

**Files:** modify `src/services/gate-service.ts`, `src/entry/mcp/protocol-tools.ts`, `src/services/protocol.ts`, `plugin/skills/catherd/SKILL.md`, `test/services/gate-service.test.ts`, `test/services/protocol.test.ts`.

**Consumes:** Task 1's `gate-service.ts`. **Produces:**
- `VerifierStep.command?: string` (each new step records its command).
- `interface RecordedItem { item: string; command: string | null; passed: boolean }`; `recordedItems(run, m): RecordedItem[]` (the items checked for `m` in this run, first-checked order; passed = carried at its last check, or a `gate_pass` of this run since then); `failedItems(run, m): string[]`; `RECHECK_COMMAND_MIN = 10` (moved to the domain in Task 10, Ruling 29).
- `gateCheck(...)` answers `{ ..., recorded }` when it is given a `milestone`; `gateList({ run, milestone }): { recorded }` (Task 10 adds `env`).
- The MCP `gate_check`: `item`, `command`, `paths` optional; none of them with a `milestone` lists; part of them, or none without a milestone, is `E_INPUT_INVALID`. Its description says the lockfiles count, never to name `node_modules`, and an ignored output not built yet is "absent".
- `protocolNext`: after a verifier attempt that did not pass, `"<M>: <verifier> failed: the owning lanes fix it, then a fresh verifier (not a resume) re-checks <failed items>, each command capped at 10 min"`.
- SKILL.md step 9's FAIL bullet: a fresh verifier re-checks, its brief naming the failed items and a 10-minute cap.

- [ ] **Step 1: the failing tests.** Apply the two test hunks: "lists the milestone's recorded items with whether each passed…", the MCP listing assertions, the `command` in "records each check as the verifier's step", and "after a verifier FAIL names a fresh verifier and the failed items, not a resume (plan 23)". Run `bun test test/services/gate-service.test.ts test/services/protocol.test.ts`: they fail (no export `recordedItems`, `protocolNext` says `M1: verifier`).
- [ ] **Step 2: the code.** Apply the `gate-service.ts`, `protocol-tools.ts`, `protocol.ts` and `SKILL.md` hunks.
- [ ] **Step 3:** `bun test test/services/gate-service.test.ts test/services/protocol.test.ts test/skills.test.ts test/plugin.test.ts` passes; `bun run typecheck && bun run lint`.
- [ ] **Step 4: commit** `feat(gate): gate_check lists the milestone's recorded items; a re-check goes to a fresh verifier`.

```diff
diff --git a/plugin/skills/catherd/SKILL.md b/plugin/skills/catherd/SKILL.md
index cc782f9..62d6f7c 100644
--- a/plugin/skills/catherd/SKILL.md
+++ b/plugin/skills/catherd/SKILL.md
@@ -273,7 +273,7 @@ Nothing else pushes: a phone that buzzes for progress teaches the user to ignore
 9. **verifier,** named `verifier-<M>`, with the run id, the milestone's A-lines and the **full check**, on a frozen tree: it owns the independent gate. Route it first. A native Claude verifier runs in the foreground on Claude Code; a Codex or other process verifier uses `dispatch`, end the turn, then `result`. A full check that starts while a role still edits proves nothing, and it has to run again. Never give it a worker's reply.
    - It checks each gate item with `gate_check` first and skips an item that passed on the same content (carried over from its commit); it records each pass with `gate_pass`, runs independent items side by side within the lock's slots, and builds each commit's images once. It names git-ignored inputs (`.env`, generated files) in `paths` explicitly: `.` covers only HEAD and uncommitted not-ignored changes. It passes `gate_check` the milestone it verifies, so the digest lists only that milestone's carried items. `peek` and `status` show its current step.
    - For a native Claude verifier only, call `record_agent_run(run, "verifier-<M>", "verifier", rung, …)`, with `status: "failed"` when its verdict is FAIL: only a PASS is recorded `ok`. A process verifier on any backend counts through its dispatch record only when its reply opens `VERDICT: PASS`; collect it with `result` before landing.
-   - On FAIL, the owning worker fixes it, and you ask the same verifier to re-check: native Claude `SendMessage`, or process `dispatch` with its own recorded thread followed by `result`.
+   - On FAIL, the owning worker fixes it, then a **fresh** verifier re-checks (a resumed one can hang): a new `dispatch` or Agent with no `thread`, its brief naming the failed items (`gate_check(run, milestone)` lists them) and a 10-minute cap on each command; what passed is carried over.
    - A second FAIL on the same line goes to the architect.
    - A third one: pause, report and push.
 10. **Land.** Commit the milestone path-scoped, then `land(run, milestone, what, commit, evidence, next, learned)`, passing `learned` when the milestone taught the next run something worth knowing (a slow suite, a flaky test, a pattern to copy); push if the profile's `notify` has `milestone`, with the digest's path, and move to the next milestone.
diff --git a/src/entry/mcp/protocol-tools.ts b/src/entry/mcp/protocol-tools.ts
index a3e89af..e76831c 100644
--- a/src/entry/mcp/protocol-tools.ts
+++ b/src/entry/mcp/protocol-tools.ts
@@ -1,7 +1,8 @@
 import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
 import { z } from "zod";
+import { CatherdError } from "../../domain/errors.ts";
 import { ID_PATTERN } from "../../domain/ids.ts";
-import { gateCheck, gatePass } from "../../services/gate-service.ts";
+import { gateCheck, gateList, gatePass } from "../../services/gate-service.ts";
 import { answer, park } from "../../services/questions.ts";
 import type { Deps } from "../../services/ports.ts";
 import { handle } from "./result.ts";
@@ -19,10 +20,30 @@ export function registerProtocolTools(server: McpServer, deps: Deps): void {
     "gate_check",
     {
       description:
-        "The verifier, before running a gate item: { carried: true, passedAt, commit } when this repo already has a pass of the same command on the same content of paths (repo-relative; . for the whole repo: HEAD plus uncommitted not-ignored changes; a git-ignored input such as .env or a build output is hashed only when named as a path), so it reports the item as carried over from that commit instead of running it; else { carried: false }, and it runs the item. Either way the call is recorded as the verifier's current step, which status and peek show. Pass milestone (the M the verifier checks) so the milestone's digest lists only its own carried items.",
-      inputSchema: { ...gate, milestone: z.string().regex(ID_PATTERN).optional() },
+        "The verifier, before running a gate item: { carried: true, passedAt, commit } when this repo already has a pass of the same command on the same content of paths (repo-relative; . for the whole repo: the tracked files plus uncommitted not-ignored changes; the repo's lockfiles always count, so never name node_modules; a git-ignored input such as .env or a build output is hashed only when named as a path, and as absent while it is not built), so it reports the item as carried over from that commit instead of running it; else { carried: false }, and it runs the item. Either way the call is recorded as the verifier's current step, which status and peek show. Pass milestone (the M the verifier checks): the milestone's digest then lists only its own carried items, and the answer adds recorded, the items already checked for that milestone in this run, each with its command and whether it passed. Call it first with only run and milestone to get that list without checking anything: reuse those item names, and re-check the failed ones first.",
+      inputSchema: {
+        run: z.string(),
+        item: gate.item.optional(),
+        command: gate.command.optional(),
+        paths: gate.paths.optional(),
+        milestone: z.string().regex(ID_PATTERN).optional(),
+      },
     },
-    (a) => handle(() => gateCheck(deps, a)),
+    (a) =>
+      handle(async () => {
+        if (a.item === undefined && a.command === undefined && a.paths === undefined) {
+          if (!a.milestone)
+            throw new CatherdError("E_INPUT_INVALID", "gate_check needs an item, or a milestone to list", {
+              fix: "pass item, command and paths to check an item, or only run and milestone to list the recorded items",
+            });
+          return gateList({ run: a.run, milestone: a.milestone });
+        }
+        if (a.item === undefined || a.command === undefined || a.paths === undefined)
+          throw new CatherdError("E_INPUT_INVALID", "gate_check needs item, command and paths together", {
+            fix: "pass all three to check an item, or none of them (with milestone) to list the recorded items",
+          });
+        return gateCheck(deps, { ...a, item: a.item, command: a.command, paths: a.paths });
+      }),
   );
 
   server.registerTool(
diff --git a/src/services/gate-service.ts b/src/services/gate-service.ts
index 0b3d324..f78f2e9 100644
--- a/src/services/gate-service.ts
+++ b/src/services/gate-service.ts
@@ -27,6 +27,8 @@ type GatePass = z.infer<typeof GatePassSchema>;
 export interface VerifierStep {
   at: string;
   item: string;
+  /** the item's command; steps written before 1.5 lack it */
+  command?: string;
   carried: boolean;
   /** a carried item: the commit its pass was recorded on */
   commit?: string;
@@ -284,14 +286,51 @@ export function latestVerifierStep(run: Run): VerifierStep | null {
     .at(-1) ?? null) as VerifierStep | null;
 }
 
+/** One item the verifier checked for a milestone in this run: its name, its command, and whether it passed. */
+export interface RecordedItem {
+  item: string;
+  command: string | null;
+  /** carried over at its last check, or a gate_pass of this run recorded since that check */
+  passed: boolean;
+}
+
+/**
+ * The items checked for milestone `m` in this run, in the order they were first checked (plan 23): a new
+ * verifier reuses their names, so the ledger carries what passed, and a re-check starts from the failed ones.
+ */
+export function recordedItems(run: Run, m: string): RecordedItem[] {
+  const steps = readJsonl<VerifierStep>(stepsFile(run)).rows.filter(
+    (s) => typeof s?.item === "string" && s.milestone === m,
+  );
+  const passes = readPasses(run.meta.repo).filter((p) => p.run === run.id);
+  return [...new Set(steps.map((s) => s.item))].map((item) => {
+    const last = steps.findLast((s) => s.item === item) as VerifierStep;
+    const passed =
+      last.carried || passes.some((p) => p.item === item && Date.parse(p.at) >= Date.parse(last.at));
+    return { item, command: last.command ?? null, passed };
+  });
+}
+
+/** A re-check's cap on each command, in minutes: a hung command fails its item instead of the verifier (plan 23). */
+export const RECHECK_COMMAND_MIN = 10;
+
+/** The milestone's checked items that have not passed since their last check: what a re-check runs first. */
+export const failedItems = (run: Run, m: string): string[] =>
+  recordedItems(run, m)
+    .filter((r) => !r.passed)
+    .map((r) => r.item);
+
 /**
  * `gate_check`: carried when this repo has a pass with the same command on the same content of `paths`;
- * records "verifier step: <item>" either way.
+ * records "verifier step: <item>" either way. With `milestone` it also lists the milestone's recorded items
+ * (plan 23), so a verifier reuses the names an earlier one checked.
  */
 export async function gateCheck(
   deps: Deps,
   i: { run: string; item: string; command: string; paths: string[]; milestone?: string },
-): Promise<{ carried: true; passedAt: string; commit: string } | { carried: false }> {
+): Promise<
+  ({ carried: true; passedAt: string; commit: string } | { carried: false }) & { recorded?: RecordedItem[] }
+> {
   const run = findRun(i.run);
   const paths = cleanPaths(i.paths);
   const hash = await contentHash(run.meta.repo, paths);
@@ -299,11 +338,20 @@ export async function gateCheck(
   recordStep(run, {
     at: new Date(deps.now()).toISOString(),
     item: i.item,
+    command: i.command,
     carried: pass !== undefined,
     ...(pass ? { commit: pass.commit } : {}),
     ...(i.milestone ? { milestone: i.milestone } : {}),
   });
-  return pass ? { carried: true, passedAt: pass.at, commit: pass.commit } : { carried: false };
+  const carried = pass
+    ? { carried: true as const, passedAt: pass.at, commit: pass.commit }
+    : { carried: false as const };
+  return i.milestone ? { ...carried, recorded: recordedItems(run, i.milestone) } : carried;
+}
+
+/** `gate_check` with a milestone and no item: the milestone's recorded items, recording no step. */
+export function gateList(i: { run: string; milestone: string }): { recorded: RecordedItem[] } {
+  return { recorded: recordedItems(findRun(i.run), i.milestone) };
 }
 
 /** `gate_pass`: records that `command` passed on the current content of `paths`, with its evidence. */
diff --git a/src/services/protocol.ts b/src/services/protocol.ts
index bd5fb78..4f4e43f 100644
--- a/src/services/protocol.ts
+++ b/src/services/protocol.ts
@@ -4,7 +4,7 @@ import type { RunRecord } from "../domain/record.ts";
 import type { RouteRow } from "../domain/route.ts";
 import { ensurePrivateDir, readJsonl, writeTextAtomic } from "../infra/store.ts";
 import { type Dispatch, listDispatches, liveDispatches } from "./dispatches.ts";
-import type { VerifierStep } from "./gate-service.ts";
+import { failedItems, RECHECK_COMMAND_MIN, type VerifierStep } from "./gate-service.ts";
 import {
   landedMilestones,
   milestoneReviewer,
@@ -12,7 +12,6 @@ import {
   milestoneStart,
   namesMilestone,
   reviewerPassed,
-  verifierPassed,
 } from "./milestones.ts";
 import { readAgentRuns, readRecords, readRoutes, type Run, runPaths } from "./run-store.ts";
 
@@ -111,7 +110,13 @@ export function protocolNext(run: Run, parked: string[], now = Date.now()): stri
   if (running.length) return `${m}: lanes running (${running.map((d) => d.admit.name).join(", ")})`;
   const start = milestoneStart(run, m);
   if (!reviewerPassed(run, m, start)) return `${m}: reviewer`;
-  if (!verifierPassed(run, m, start)) return `${m}: verifier`;
+  const verdict = milestoneVerifier(run, m, start);
+  if (!verdict) return `${m}: verifier`;
+  if (!verdict.passed) {
+    // plan 23: a resumed verifier can hang; a re-check goes to a fresh one, told what failed
+    const failed = failedItems(run, m);
+    return `${m}: ${verdict.name} failed: the owning lanes fix it, then a fresh verifier (not a resume) re-checks ${failed.length ? failed.join(", ") : "the failed items"}, each command capped at ${RECHECK_COMMAND_MIN} min`;
+  }
   return `land ${m}`;
 }
 
diff --git a/test/services/gate-service.test.ts b/test/services/gate-service.test.ts
index d00fba9..612f316 100644
--- a/test/services/gate-service.test.ts
+++ b/test/services/gate-service.test.ts
@@ -4,7 +4,14 @@ import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:f
 import { dirname, join } from "node:path";
 import { formatRun } from "../../src/entry/runs-command.ts";
 import { isCatherdError } from "../../src/domain/errors.ts";
-import { gateCheck, gatePass, gatesFile, latestVerifierStep } from "../../src/services/gate-service.ts";
+import {
+  failedItems,
+  gateCheck,
+  gatePass,
+  gatesFile,
+  latestVerifierStep,
+  recordedItems,
+} from "../../src/services/gate-service.ts";
 import { createRun } from "../../src/services/run-store.ts";
 import { summarizeRun } from "../../src/services/summary.ts";
 import { snapshotEnv } from "../helpers.ts";
@@ -292,6 +299,7 @@ describe("the gate ledger (spec 1.1 §7)", () => {
     expect(latestVerifierStep(run)).toEqual({
       at: "2026-09-28T10:05:00.000Z",
       item: "boot check",
+      command: "bun test",
       carried: false,
     });
     const s = summarizeRun(deps, run);
@@ -310,5 +318,39 @@ describe("the gate ledger (spec 1.1 §7)", () => {
     // the optional milestone lands on the verifier's step
     expect((await call(c, "gate_check", item(run.id, { milestone: "M1" }))).data.carried).toBe(true);
     expect(latestVerifierStep(run)).toMatchObject({ item: "unit tests", carried: true, milestone: "M1" });
+    // the list alone, recording no step; half an item is refused
+    expect((await call(c, "gate_check", { run: run.id, milestone: "M1" })).data).toEqual({
+      recorded: [{ item: "unit tests", command: "bun test", passed: true }],
+    });
+    expect((await call(c, "gate_check", { run: run.id, item: "x", milestone: "M1" })).error?.code).toBe(
+      "E_INPUT_INVALID",
+    );
+    expect((await call(c, "gate_check", { run: run.id })).error?.code).toBe("E_INPUT_INVALID");
+  });
+
+  it("lists the milestone's recorded items with whether each passed, so a new verifier reuses their names (plan 23)", async () => {
+    const { repo, run } = freshRun();
+    write(repo, "src/a.ts", "a");
+    commit(repo);
+    const deps = fakeDeps();
+    const m1 = (name: string, over: Record<string, unknown> = {}) =>
+      item(run.id, { item: name, command: `run ${name}`, milestone: "M1", ...over });
+    expect(await gateCheck(deps, m1("lint"))).toEqual({
+      carried: false,
+      recorded: [{ item: "lint", command: "run lint", passed: false }],
+    });
+    await gatePass(deps, { ...m1("lint"), evidence: "ok" });
+    await gateCheck(deps, m1("acceptance"));
+    // another milestone's items stay out
+    await gateCheck(deps, item(run.id, { item: "boot", milestone: "M2" }));
+    expect(recordedItems(run, "M1")).toEqual([
+      { item: "lint", command: "run lint", passed: true },
+      { item: "acceptance", command: "run acceptance", passed: false },
+    ]);
+    expect(failedItems(run, "M1")).toEqual(["acceptance"]);
+    // a second check of an item that passed, not carried (its content changed), is open again
+    write(repo, "src/a.ts", "b");
+    await gateCheck(fakeDeps({ now: () => Date.now() + 1000 }), m1("lint"));
+    expect(failedItems(run, "M1")).toEqual(["lint", "acceptance"]);
   });
 });
diff --git a/test/services/protocol.test.ts b/test/services/protocol.test.ts
index da991c1..4703047 100644
--- a/test/services/protocol.test.ts
+++ b/test/services/protocol.test.ts
@@ -160,6 +160,50 @@ describe("Protocol next (spec 1.1 §10)", () => {
     expect(protocolNext(run, [])).toBe("finish: the final gate, then the report");
   });
 
+  it("after a verifier FAIL names a fresh verifier and the failed items, not a resume (plan 23)", async () => {
+    const { run } = freshRun();
+    const deps = fakeDeps();
+    writeLane(run, "M1.L1", ["src/a.ts"]);
+    await route(deps, { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
+    worked(run, "M1.L1");
+    const at = new Date(Date.now() + 1000).toISOString();
+    await appendRecord(
+      run,
+      makeRecord({
+        runId: run.id,
+        dispatchId: newDispatchId(),
+        name: "reviewer-M1",
+        role: "reviewer",
+        lane: null,
+        endedAt: at,
+      }),
+    );
+    const check = (item: string) => ({
+      run: run.id,
+      item,
+      command: `run ${item}`,
+      paths: ["."],
+      milestone: "M1",
+    });
+    await gateCheck(deps, check("lint"));
+    await gatePass(deps, { ...check("lint"), evidence: "ok" });
+    await gateCheck(deps, check("acceptance"));
+    appendAgentRun(run, {
+      at: new Date(Date.now() + 2000).toISOString(),
+      name: "verifier-M1",
+      role: "verifier",
+      rung: "claude:claude-opus-5-5#low",
+      agent: null,
+      totalTokens: 0,
+      costUsd: null,
+      secs: null,
+      status: "failed",
+    });
+    expect(protocolNext(run, [])).toBe(
+      "M1: verifier-M1 failed: the owning lanes fix it, then a fresh verifier (not a resume) re-checks acceptance, each command capped at 10 min",
+    );
+  });
+
   it("run_start returns the step and the six-line checklist", async () => {
     withHome();
     const r = await startRun(fakeDeps(), { repo: tempRepo(), title: "t", aLines: ["A1 x"] });
```

### Task 3: per-role timeouts

**Scratch commit:** `b45c752` — `feat(profile): per-role idle and wall timeouts over the profile's`

**Files:** modify `src/domain/profile.ts`, `src/services/ports.ts`, `src/services/admission.ts`, `src/entry/profile-command.ts`, `src/entry/mcp/setup-tools.ts`, `test/domain/profile.test.ts`, `test/entry/profile-command.test.ts`, `test/services/admission.test.ts`.

**Produces:** `RoleDocSchema.timeouts` (loose, positive `idleMin`/`wallMin`); `RoleConfig.timeouts?: { idleMin?: number; wallMin?: number }` (copied by `resolveProfile` only when set); `RolePatchSchema.timeouts` (strict, each field positive or `null`, the whole object nullable); `roleTimeouts(profile, role): { idleMin; wallMin }` (exported from `src/domain/profile.ts`); `ProfileView.roles[*].timeouts?`; admission writes `idleMs`/`wallMs` from `roleTimeouts(profile, rc)`; `profile show` prints `  <role> idle N min · wall N min` under the timeouts line; `profile_set`'s description names `timeouts` among a role's fields.

- [ ] **Step 1: the failing tests.** "sets a role's own timeouts, which win over the profile's and come off with null (plan 23)" (`test/domain/profile.test.ts`), "gives a role its own timeouts over the profile's (plan 23)" (`test/services/admission.test.ts`), "sets and shows a role's own wall timeout under the profile's (plan 23)" (`test/entry/profile-command.test.ts`). They fail: `roleTimeouts` is not exported; the patch is refused.
- [ ] **Step 2: the code.** Apply the source hunks.
- [ ] **Step 3:** `bun test test/domain/profile.test.ts test/services/admission.test.ts test/entry/profile-command.test.ts`; `bun run typecheck && bun run lint`.
- [ ] **Step 4: commit** `feat(profile): per-role idle and wall timeouts over the profile's`.

```diff
diff --git a/src/domain/profile.ts b/src/domain/profile.ts
index f700b83..d33b2fe 100644
--- a/src/domain/profile.ts
+++ b/src/domain/profile.ts
@@ -45,6 +45,7 @@ const RoleDocSchema = z.looseObject({
   rungs: z.array(z.string()).optional(),
   defaultRung: z.string().optional(),
   network: z.boolean().optional(),
+  timeouts: z.looseObject({ idleMin: positive.optional(), wallMin: positive.optional() }).optional(),
 });
 
 export const ProfileDocSchema = z.looseObject({
@@ -117,8 +118,19 @@ export type RoleConfig = {
   defaultRung?: string;
   /** spec §5: false drops a workspace-write role's network, loopback and Docker grants; absent means granted */
   network?: false;
+  /** plan 23: this role's own idle and wall timeouts, over the profile's `timeouts` (a long gate, a slow model) */
+  timeouts?: { idleMin?: number; wallMin?: number };
 };
 
+/** The idle and wall timeouts a role runs under: its own `timeouts`, else the profile's. */
+export const roleTimeouts = (
+  profile: { timeouts: { idleMin: number; wallMin: number } },
+  role: { timeouts?: { idleMin?: number; wallMin?: number } } | undefined,
+): { idleMin: number; wallMin: number } => ({
+  idleMin: role?.timeouts?.idleMin ?? profile.timeouts.idleMin,
+  wallMin: role?.timeouts?.wallMin ?? profile.timeouts.wallMin,
+});
+
 /** A profile with every default filled in: what the run engine, the CLI and the agent files read. */
 export interface Profile {
   name: string;
@@ -298,6 +310,14 @@ export function resolveProfile(doc: ProfileDoc, name: string, host: Orchestratio
       rungs: [...(d?.rungs ?? omitted)],
       ...(defaultRung ? { defaultRung } : {}),
       ...(d?.network === false ? { network: false as const } : {}),
+      ...(d?.timeouts?.idleMin !== undefined || d?.timeouts?.wallMin !== undefined
+        ? {
+            timeouts: {
+              ...(d.timeouts.idleMin !== undefined ? { idleMin: d.timeouts.idleMin } : {}),
+              ...(d.timeouts.wallMin !== undefined ? { wallMin: d.timeouts.wallMin } : {}),
+            },
+          }
+        : {}),
     };
   }
   const harness: Profile["harness"] = {};
@@ -344,6 +364,10 @@ const RolePatchSchema = z
     rungs: z.array(RungSchema),
     defaultRung: RungSchema.nullable(),
     network: z.boolean().nullable(),
+    timeouts: z
+      .strictObject({ idleMin: positive.nullable(), wallMin: positive.nullable() })
+      .partial()
+      .nullable(),
   })
   .partial();
 
diff --git a/src/entry/mcp/setup-tools.ts b/src/entry/mcp/setup-tools.ts
index 433c032..dae4574 100644
--- a/src/entry/mcp/setup-tools.ts
+++ b/src/entry/mcp/setup-tools.ts
@@ -100,7 +100,7 @@ export function registerSetupTools(server: McpServer, deps: Deps): void {
     "profile_set",
     {
       description:
-        "Apply a patch to a profile (without a name: the profile this repo runs on, as in profile_get; a new name starts from the default profile): objective, jev.use, billing, roles (enabled, access, network, rungs, defaultRung), harness isolation per backend, failover, budget, timeouts, preflight.confirm, lock.heavy and notify. Lists replace, maps merge, and null removes a key. An unknown key is refused. It validates first and writes nothing when invalid, unless the patch repairs an invalid profile: it fixes at least one of its errors and adds none, and then it saves with `errors` listing those still open. A save rewrites the agent files and relinks them. Returns saved, the errors and warnings, the diff, and newSessionNeededFor: the agents that apply from the next Claude Code session.",
+        "Apply a patch to a profile (without a name: the profile this repo runs on, as in profile_get; a new name starts from the default profile): objective, jev.use, billing, roles (enabled, access, network, rungs, defaultRung, timeouts: a role's own idleMin and wallMin over the profile's), harness isolation per backend, failover, budget, timeouts, preflight.confirm, lock.heavy and notify. Lists replace, maps merge, and null removes a key. An unknown key is refused. It validates first and writes nothing when invalid, unless the patch repairs an invalid profile: it fixes at least one of its errors and adds none, and then it saves with `errors` listing those still open. A save rewrites the agent files and relinks them. Returns saved, the errors and warnings, the diff, and newSessionNeededFor: the agents that apply from the next Claude Code session.",
       inputSchema: { name: PROFILE, repo: REPO, patch: ProfilePatchSchema },
     },
     (a) => handle(async () => deps.profiles.set(a.name, a.patch, await toplevel(a.repo))),
diff --git a/src/entry/profile-command.ts b/src/entry/profile-command.ts
index ce3709d..0b0e2b7 100644
--- a/src/entry/profile-command.ts
+++ b/src/entry/profile-command.ts
@@ -104,6 +104,16 @@ export function formatProfile(
   const budget = Object.entries(p.budget).map(([k, v]) => (k === "usd" ? `${v}` : `${v} ${k}`));
   lines.push(`budget ${budget.join(" · ") || "no cap"}`);
   lines.push(`timeouts idle ${p.timeouts.idleMin} min · wall ${p.timeouts.wallMin} min`);
+  // plan 23: a role's own timeouts, under the profile's
+  for (const role of ROLES) {
+    const t = p.roles[role].timeouts;
+    if (!t) continue;
+    const parts = [
+      ...(t.idleMin !== undefined ? [`idle ${t.idleMin} min`] : []),
+      ...(t.wallMin !== undefined ? [`wall ${t.wallMin} min`] : []),
+    ];
+    lines.push(`  ${role} ${parts.join(" · ")}`);
+  }
   lines.push(
     `preflight ${p.preflight.confirm ? "shows its commands and asks first" : "runs the checks without asking"}`,
   );
diff --git a/src/services/admission.ts b/src/services/admission.ts
index cc8242f..b253020 100644
--- a/src/services/admission.ts
+++ b/src/services/admission.ts
@@ -6,6 +6,7 @@ import { budgetStatus, formatBudget } from "../domain/budget.ts";
 import { CatherdError, errorMessage } from "../domain/errors.ts";
 import { assertId, formatRung, newDispatchId, parseRung } from "../domain/ids.ts";
 import { assertLaneHeader, overlaps } from "../domain/lane.ts";
+import { roleTimeouts } from "../domain/profile.ts";
 import type { RunRecord } from "../domain/record.ts";
 import { withReplyContract } from "../domain/role-prompts.ts";
 import type { Role } from "../domain/roles.ts";
@@ -300,8 +301,9 @@ export async function admit(
         env: { ...plan.env, PWD: plan.cwd },
         cwd: plan.cwd,
         stdinPath: plan.stdinPath,
-        idleMs: profile.timeouts.idleMin * 60_000,
-        wallMs: profile.timeouts.wallMin * 60_000,
+        // plan 23: a role's own timeouts win over the profile's (a verifier's long gate)
+        idleMs: roleTimeouts(profile, rc).idleMin * 60_000,
+        wallMs: roleTimeouts(profile, rc).wallMin * 60_000,
         killGraceMs: KILL_GRACE_MS,
         graceAfterFinalMs: adapter.graceAfterFinalMs,
         pollMs: deps.pollMs,
diff --git a/src/services/ports.ts b/src/services/ports.ts
index a3b27b1..64fc759 100644
--- a/src/services/ports.ts
+++ b/src/services/ports.ts
@@ -18,7 +18,18 @@ export interface ProfileView {
   objective: "cost" | "speed";
   /** `defaultRung`, when set, is where a lane starts without a kind and difficulty (spec §5.4) */
   roles: Partial<
-    Record<Role, { enabled: boolean; access: Access; rungs: string[]; defaultRung?: string; network?: false }>
+    Record<
+      Role,
+      {
+        enabled: boolean;
+        access: Access;
+        rungs: string[];
+        defaultRung?: string;
+        network?: false;
+        /** plan 23: the role's own timeouts over the profile's */
+        timeouts?: { idleMin?: number; wallMin?: number };
+      }
+    >
   >;
   /** per billing key (spec §7.1); a missing key bills as DEFAULT_BILLING */
   billing: Partial<Record<string, BillingMode>>;
diff --git a/test/domain/profile.test.ts b/test/domain/profile.test.ts
index 6b9c214..9677991 100644
--- a/test/domain/profile.test.ts
+++ b/test/domain/profile.test.ts
@@ -12,6 +12,7 @@ import {
   ProfileDocSchema,
   ProfilePatchSchema,
   resolveProfile,
+  roleTimeouts,
   unknownValues,
 } from "../../src/domain/profile.ts";
 import { ROLES } from "../../src/domain/roles.ts";
@@ -251,6 +252,20 @@ describe("patchAt", () => {
     expect(patchAt("notify", "finish,blocked")).toEqual({ notify: ["finish", "blocked"] });
   });
 
+  it("sets a role's own timeouts, which win over the profile's and come off with null (plan 23)", () => {
+    const patch = patchAt("roles.verifier.timeouts.wallMin", "240");
+    expect(patch).toEqual({ roles: { verifier: { timeouts: { wallMin: 240 } } } });
+    const doc = applyPatch(defaultProfileDoc(), patch);
+    const p = resolveProfile(doc, "default", "claude-code");
+    expect(p.roles.verifier.timeouts).toEqual({ wallMin: 240 });
+    expect(p.roles.worker.timeouts).toBeUndefined();
+    expect(roleTimeouts(p, p.roles.verifier)).toEqual({ idleMin: 15, wallMin: 240 });
+    expect(roleTimeouts(p, p.roles.worker)).toEqual({ idleMin: 15, wallMin: 90 });
+    const cleared = applyPatch(doc, patchAt("roles.verifier.timeouts", "null"));
+    expect(resolveProfile(cleared, "default", "claude-code").roles.verifier.timeouts).toBeUndefined();
+    expect(() => patchAt("roles.verifier.timeouts.wallMin", "0")).toThrow("cannot set");
+  });
+
   it("keeps a rung key with dots whole, and splits a comma-separated rung list", () => {
     expect(patchAt("failover.codex:gpt-5.6-sol#high", "opencode:opencode-go/gpt-5.6-luna#max")).toEqual({
       failover: { "codex:gpt-5.6-sol#high": "opencode:opencode-go/gpt-5.6-luna#max" },
diff --git a/test/entry/profile-command.test.ts b/test/entry/profile-command.test.ts
index ce9535f..4c2074e 100644
--- a/test/entry/profile-command.test.ts
+++ b/test/entry/profile-command.test.ts
@@ -52,6 +52,13 @@ describe("catherd profile show", () => {
     expect(writer).toContain("workspace-write (no network), enforced");
   });
 
+  it("sets and shows a role's own wall timeout under the profile's (plan 23)", () => {
+    withHome();
+    expect(catherd(["set", "roles.verifier.timeouts.wallMin", "240"]).code).toBe(0);
+    const out = catherd(["show"]).out;
+    expect(out).toContain("timeouts idle 15 min · wall 90 min\n  verifier wall 240 min\n");
+  });
+
   it("prints JSON with every default filled in", () => {
     withHome();
     const j = JSON.parse(catherd(["show", "--json"]).out);
diff --git a/test/services/admission.test.ts b/test/services/admission.test.ts
index c318a8a..e2fe04a 100644
--- a/test/services/admission.test.ts
+++ b/test/services/admission.test.ts
@@ -81,6 +81,19 @@ describe("admission", () => {
     expect(latestDispatch(run, "worker-M1.L1")?.admit.dispatchId).toBe(d.admit.dispatchId);
   });
 
+  it("gives a role its own timeouts over the profile's (plan 23)", async () => {
+    const { run } = setup();
+    const view = testView();
+    const worker = view.roles.worker;
+    if (!worker) throw new Error("no worker role");
+    view.roles.worker = { ...worker, timeouts: { wallMin: 240 } };
+    const { specPath } = await admit(fakeDeps({ view }), run, input());
+    expect(JSON.parse(readFileSync(specPath, "utf8"))).toMatchObject({
+      idleMs: 15 * 60_000,
+      wallMs: 240 * 60_000,
+    });
+  });
+
   it("keeps the server's environment out of spec.json, which only its owner can read (spec §10.4)", async () => {
     const { repo, run } = setup();
     process.env.FOO_API_KEY = "s3cret";
```

### Task 4: a writing `catherd lock` keeps a role's wall timeout alive

**Scratch commit:** `91d52e4` — `feat(supervisor): a live catherd lock's output keeps a role's wall timeout from its last line`

**Files:** create `src/infra/lock-activity.ts`, `test/infra/lock-activity.test.ts`; modify `src/infra/supervisor.ts`, `src/entry/lock-command.ts`, `src/services/admission.ts`, `test/infra/supervisor.test.ts`, `test/entry/lock-command.test.ts`, `test/services/admission.test.ts`.

**Consumes:** Task 3's `admission.ts`. **Produces (Ruling 7):**
- `src/infra/lock-activity.ts`: `DISPATCH_ID_ENV = "CATHERD_DISPATCH_ID"`, `ACTIVITY_EVERY_MS = 1000`, `activityDir(dispatchId)` (`<locks>/activity/<id>`), `activityReporter(dispatchId, now?, everyMs?) → { tick, done } | null` (null outside a dispatch or for an id that names a path), `lastLockOutput(dispatchId): number | null` (latest output of a live lock).
- The supervisor: `wall-timeout` when `now - started >= wallMs && now - (lastLockOutput(<dispatch dir basename>) ?? started) >= wallMs`.
- `runForwarding(argv, { onOutput? })`: with `onOutput`, stdout and stderr are piped through, each chunk calling it; the pipes get 500 ms to drain after the exit. `catherd lock` reports through `activityReporter(process.env.CATHERD_DISPATCH_ID)` and removes its file when done.
- Admission: every dispatch's spec env has `CATHERD_DISPATCH_ID: <dispatch id>`.

- [ ] **Step 1: the failing tests.** `test/infra/lock-activity.test.ts` (new), "counts the wall from a live catherd lock's last output while it writes (plan 23)" (`test/infra/supervisor.test.ts`), "inside a dispatch, passes the output through and reports it while the command runs (plan 23)" (`test/entry/lock-command.test.ts`), and the spec-env assertion in `test/services/admission.test.ts`. They fail (no module `lock-activity.ts`; the wall ends the supervised child at 200 ms).
- [ ] **Step 2: the code.** Create `src/infra/lock-activity.ts`; apply the `supervisor.ts`, `lock-command.ts`, `admission.ts` hunks.
- [ ] **Step 3:** `bun test test/infra/lock-activity.test.ts test/infra/supervisor.test.ts test/entry/lock-command.test.ts test/services/admission.test.ts test/architecture.test.ts`; `bun run typecheck && bun run lint`.
- [ ] **Step 4: commit** `feat(supervisor): a live catherd lock's output keeps a role's wall timeout from its last line`.

```diff
diff --git a/src/entry/lock-command.ts b/src/entry/lock-command.ts
index 2da63d1..b69042d 100644
--- a/src/entry/lock-command.ts
+++ b/src/entry/lock-command.ts
@@ -4,6 +4,7 @@ import { CatherdError } from "../domain/errors.ts";
 import { scrubSecrets } from "../infra/env.ts";
 import { gitToplevel } from "../infra/git.ts";
 import { heavySlots, withHeavySlot } from "../infra/heavy-lock.ts";
+import { activityReporter, DISPATCH_ID_ENV } from "../infra/lock-activity.ts";
 import { killGroup } from "../infra/proc.ts";
 import { activeName, readProfileDoc } from "../services/profile-store.ts";
 import { printError } from "./cli-kit.ts";
@@ -44,14 +45,23 @@ export const DOUBLE_INTERRUPT_MS = 2_000;
  * a terminal's Ctrl-C reaches catherd only, so the command sees it exactly once, and so does every
  * process it started. A second Ctrl-C within 2 s kills the group. Resolves to the command's exit code.
  */
-export async function runForwarding(argv: string[]): Promise<number> {
+export async function runForwarding(argv: string[], o: { onOutput?: () => void } = {}): Promise<number> {
+  // plan 23: inside a dispatch the output passes through catherd, which notes when the command last wrote
+  const piped = o.onOutput !== undefined;
   const child = Bun.spawn(argv, {
     stdin: "inherit",
-    stdout: "inherit",
-    stderr: "inherit",
+    stdout: piped ? "pipe" : "inherit",
+    stderr: piped ? "pipe" : "inherit",
     env: scrubSecrets(process.env),
     detached: true,
   });
+  const pumps =
+    piped && o.onOutput
+      ? [
+          pump(child.stdout as ReadableStream<Uint8Array>, process.stdout, o.onOutput),
+          pump(child.stderr as ReadableStream<Uint8Array>, process.stderr, o.onOutput),
+        ]
+      : [];
   let lastInt = 0;
   const handlers: [NodeJS.Signals, () => void][] = [
     [
@@ -80,13 +90,35 @@ export async function runForwarding(argv: string[]): Promise<number> {
     },
   );
   try {
-    return await child.exited;
+    const code = await child.exited;
+    // a process the command left behind may hold the pipes open: what it wrote by then is passed on
+    await Promise.race([Promise.all(pumps), Bun.sleep(PIPE_DRAIN_MS)]);
+    return code;
   } finally {
     watchdog.kill("SIGKILL");
     for (const [sig, h] of handlers) process.off(sig, h);
   }
 }
 
+/** How long the pipes may stay open after the command exits. */
+const PIPE_DRAIN_MS = 500;
+
+/** Copies a piped stream to `out`, calling `tick` for each chunk; a broken pipe ends the copy. */
+async function pump(
+  stream: ReadableStream<Uint8Array>,
+  out: NodeJS.WriteStream,
+  tick: () => void,
+): Promise<void> {
+  try {
+    for await (const chunk of stream) {
+      out.write(chunk);
+      tick();
+    }
+  } catch {
+    // the command's end closes the pipe
+  }
+}
+
 /** Spec §8: what `--help` and the usage error show; the command runs after `--`. */
 export const LOCK_USAGE = "catherd lock [--slots N] -- <command> [args...]";
 
@@ -123,6 +155,14 @@ export const lockCommand = defineCommand({
       () => readProfileDoc(activeName(repo)).lock?.heavy ?? "cpus/2",
       (m) => console.error(m),
     );
-    process.exitCode = await withHeavySlot(slots, () => runForwarding(argv));
+    process.exitCode = await withHeavySlot(slots, async () => {
+      // plan 23: a role's lock reports its output, so the role's wall timeout counts from its last line
+      const activity = activityReporter(process.env[DISPATCH_ID_ENV]);
+      try {
+        return await runForwarding(argv, activity ? { onOutput: activity.tick } : {});
+      } finally {
+        activity?.done();
+      }
+    });
   },
 });
diff --git a/src/infra/lock-activity.ts b/src/infra/lock-activity.ts
new file mode 100644
index 0000000..24819f3
--- /dev/null
+++ b/src/infra/lock-activity.ts
@@ -0,0 +1,88 @@
+import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
+import { join } from "node:path";
+import { locksDir } from "./paths.ts";
+import { isAlive, processStartTime } from "./proc.ts";
+import { ensurePrivateDir, writeJsonAtomic } from "./store.ts";
+
+// Plan 23: a role's long gate runs behind `catherd lock`. While such a lock child is alive and writing, the
+// role's wall timeout counts from its last output, not from the role's start. The lock writes here, in the
+// locks dir every role may write; the supervisor reads it.
+
+/** The env var the supervisor's spec carries, so a `catherd lock` inside the role knows its dispatch. */
+export const DISPATCH_ID_ENV = "CATHERD_DISPATCH_ID";
+
+/** A lock child reports at most this often, so a chatty command does not write a file per line. */
+export const ACTIVITY_EVERY_MS = 1_000;
+
+const SAFE_ID = /^[A-Za-z0-9][\w.-]{0,127}$/;
+
+/** `<locks>/activity/<dispatch id>`: one file per live `catherd lock` of that dispatch. */
+export const activityDir = (dispatchId: string): string => join(locksDir(), "activity", dispatchId);
+
+interface Activity {
+  schema: 1;
+  pid: number;
+  startTime: string | null;
+  /** the last time the lock's command wrote output (its start, before the first line) */
+  at: string;
+}
+
+/**
+ * A reporter for this `catherd lock` process, or null outside a dispatch (no id, or one that is not a plain
+ * id: it names a path). `tick` records output, at most once per ACTIVITY_EVERY_MS; `done` removes the file.
+ */
+export function activityReporter(
+  dispatchId: string | undefined,
+  now: () => number = Date.now,
+  everyMs = ACTIVITY_EVERY_MS,
+): { tick: () => void; done: () => void } | null {
+  if (!dispatchId || !SAFE_ID.test(dispatchId) || dispatchId.includes("..")) return null;
+  const dir = activityDir(dispatchId);
+  const file = join(dir, `${process.pid}.json`);
+  const startTime = processStartTime(process.pid);
+  let last = 0;
+  const write = (t: number): void => {
+    try {
+      ensurePrivateDir(dir);
+      writeJsonAtomic(file, {
+        schema: 1,
+        pid: process.pid,
+        startTime,
+        at: new Date(t).toISOString(),
+      } satisfies Activity);
+      last = t;
+    } catch {
+      // advisory: a lock that cannot report still runs its command
+    }
+  };
+  write(now());
+  return {
+    tick: () => {
+      const t = now();
+      if (t - last >= everyMs) write(t);
+    },
+    done: () => rmSync(file, { force: true }),
+  };
+}
+
+/**
+ * When a live `catherd lock` of the dispatch last wrote output, in ms; null when none is alive. A file whose
+ * process is gone is left alone (its lock may still be finishing its own cleanup) and never counts.
+ */
+export function lastLockOutput(dispatchId: string): number | null {
+  const dir = activityDir(dispatchId);
+  if (!existsSync(dir)) return null;
+  let latest: number | null = null;
+  for (const name of readdirSync(dir)) {
+    if (!name.endsWith(".json")) continue;
+    try {
+      const a = JSON.parse(readFileSync(join(dir, name), "utf8")) as Activity;
+      if (a.schema !== 1 || !isAlive(a.pid, a.startTime)) continue;
+      const at = Date.parse(a.at);
+      if (!Number.isNaN(at)) latest = Math.max(latest ?? at, at);
+    } catch {
+      // a file being written, or damaged: skipped this poll
+    }
+  }
+  return latest;
+}
diff --git a/src/infra/supervisor.ts b/src/infra/supervisor.ts
index 803e20f..7bd3575 100644
--- a/src/infra/supervisor.ts
+++ b/src/infra/supervisor.ts
@@ -1,11 +1,13 @@
 import { scrubSecrets } from "./env.ts";
 import type { Subprocess } from "bun";
 import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
+import { basename } from "node:path";
 import { z } from "zod";
 import { errorMessage } from "../domain/errors.ts";
 import type { ExitInfo, ExitReason } from "../domain/record.ts";
 import { dispatchPaths, supervisorLockTarget } from "./dispatch-dir.ts";
 import { tryLock } from "./filelock.ts";
+import { lastLockOutput } from "./lock-activity.ts";
 import { log } from "./log.ts";
 import { killGroup, processStartTime } from "./proc.ts";
 import { PRIVATE_FILE, writeJsonAtomic } from "./store.ts";
@@ -188,6 +190,7 @@ async function superviseHeld(spec: SuperviseSpec, hooks: SuperviseHooks): Promis
     });
 
     const started = Date.now();
+    const dispatchId = basename(spec.dispatchDir);
     let lastActivity = started;
     let finalAt: number | null = null;
     // spec §3.6: a quiet stretch of half the idle timeout, not busy, is a stall, reported once per dispatch
@@ -221,7 +224,9 @@ async function superviseHeld(spec: SuperviseSpec, hooks: SuperviseHooks): Promis
       if (done) break;
       const now = Date.now();
       if (existsSync(p.cancel)) reason = "cancelled";
-      else if (now - started >= spec.wallMs) reason = "wall-timeout";
+      else if (now - started >= spec.wallMs && now - (lastLockOutput(dispatchId) ?? started) >= spec.wallMs)
+        // plan 23: while a `catherd lock` of the role is alive and writing, the wall counts from its last output
+        reason = "wall-timeout";
       else if (finalAt !== null && spec.graceAfterFinalMs !== null && now - finalAt >= spec.graceAfterFinalMs)
         reason = "after-final";
       else if (now - lastActivity >= spec.idleMs) {
diff --git a/src/services/admission.ts b/src/services/admission.ts
index b253020..6be6caa 100644
--- a/src/services/admission.ts
+++ b/src/services/admission.ts
@@ -15,6 +15,7 @@ import { dispatchPaths, markForCollect } from "../infra/dispatch-dir.ts";
 import { withFileLock } from "../infra/filelock.ts";
 import { statusSnapshot } from "../infra/git.ts";
 import { launchSupervisor } from "../infra/launch.ts";
+import { DISPATCH_ID_ENV } from "../infra/lock-activity.ts";
 import { log } from "../infra/log.ts";
 import { processStartTime } from "../infra/proc.ts";
 import { ensurePrivateDir, PRIVATE_FILE, writeJsonAtomic, writeTextAtomic } from "../infra/store.ts";
@@ -298,7 +299,8 @@ export async function admit(
         dispatchDir: dir,
         cmd: plan.cmd,
         args: plan.args,
-        env: { ...plan.env, PWD: plan.cwd },
+        // plan 23: a `catherd lock` in the role reports to this dispatch, so a long gate keeps its wall alive
+        env: { ...plan.env, [DISPATCH_ID_ENV]: id, PWD: plan.cwd },
         cwd: plan.cwd,
         stdinPath: plan.stdinPath,
         // plan 23: a role's own timeouts win over the profile's (a verifier's long gate)
diff --git a/test/entry/lock-command.test.ts b/test/entry/lock-command.test.ts
index 0b04938..8686a01 100644
--- a/test/entry/lock-command.test.ts
+++ b/test/entry/lock-command.test.ts
@@ -1,9 +1,10 @@
 import { afterEach, describe, expect, it } from "bun:test";
-import { existsSync, mkdtempSync, readFileSync } from "node:fs";
+import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
 import { resolveSlots } from "../../src/entry/lock-command.ts";
 import { heavySlots } from "../../src/infra/heavy-lock.ts";
+import { activityDir } from "../../src/infra/lock-activity.ts";
 import { killGroup } from "../../src/infra/proc.ts";
 import { exited, snapshotEnv, withHome } from "../helpers.ts";
 import { waitFor } from "../services/helpers.ts";
@@ -68,6 +69,34 @@ describe("catherd lock", () => {
     ]);
   });
 
+  it("inside a dispatch, passes the output through and reports it while the command runs (plan 23)", () => {
+    withHome();
+    const dir = activityDir("01TESTDISPATCH");
+    const p = Bun.spawnSync(
+      [
+        process.execPath,
+        CLI,
+        "lock",
+        "--slots",
+        "1",
+        "--",
+        "sh",
+        "-c",
+        'echo out; echo err 1>&2; ls "$1"',
+        "_",
+        dir,
+      ],
+      { env: { ...process.env, CATHERD_DISPATCH_ID: "01TESTDISPATCH" }, stdout: "pipe", stderr: "pipe" },
+    );
+    expect(p.exitCode).toBe(0);
+    const [first, listed] = p.stdout.toString().split("\n");
+    expect(first).toBe("out");
+    expect(listed).toMatch(/^\d+\.json$/);
+    expect(p.stderr.toString()).toBe("err\n");
+    // gone once the lock ends: a finished lock never keeps a role's wall alive
+    expect(readdirSync(dir)).toEqual([]);
+  });
+
   it("refuses a bad --slots as a usage error", () => {
     withHome();
     const p = Bun.spawnSync([process.execPath, CLI, "lock", "--slots", "zero", "--", "true"], {
diff --git a/test/infra/lock-activity.test.ts b/test/infra/lock-activity.test.ts
new file mode 100644
index 0000000..93734b5
--- /dev/null
+++ b/test/infra/lock-activity.test.ts
@@ -0,0 +1,39 @@
+import { afterEach, describe, expect, it } from "bun:test";
+import { mkdirSync, writeFileSync } from "node:fs";
+import { join } from "node:path";
+import { activityDir, activityReporter, lastLockOutput } from "../../src/infra/lock-activity.ts";
+import { snapshotEnv, withHome } from "../helpers.ts";
+
+afterEach(snapshotEnv());
+
+describe("a catherd lock's output report (plan 23)", () => {
+  it("records the latest output of a live lock, throttled, and nothing once it is done", () => {
+    withHome();
+    let t = Date.parse("2026-10-02T10:00:00Z");
+    const r = activityReporter("01DISPATCH", () => t);
+    expect(lastLockOutput("01DISPATCH")).toBe(t);
+    const first = t;
+    t += 500;
+    r?.tick();
+    // within ACTIVITY_EVERY_MS of the last write: not written again
+    expect(lastLockOutput("01DISPATCH")).toBe(first);
+    t += 600;
+    r?.tick();
+    expect(lastLockOutput("01DISPATCH")).toBe(t);
+    r?.done();
+    expect(lastLockOutput("01DISPATCH")).toBeNull();
+  });
+
+  it("ignores a lock whose process is gone, and refuses an id that names a path", () => {
+    withHome();
+    const dir = activityDir("01GONE");
+    mkdirSync(dir, { recursive: true });
+    writeFileSync(
+      join(dir, "999999.json"),
+      JSON.stringify({ schema: 1, pid: 999_999_999, startTime: null, at: new Date().toISOString() }),
+    );
+    expect(lastLockOutput("01GONE")).toBeNull();
+    expect(activityReporter("../x")).toBeNull();
+    expect(activityReporter(undefined)).toBeNull();
+  });
+});
diff --git a/test/infra/supervisor.test.ts b/test/infra/supervisor.test.ts
index ef5a4bd..28fd3d1 100644
--- a/test/infra/supervisor.test.ts
+++ b/test/infra/supervisor.test.ts
@@ -1,7 +1,8 @@
 import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
 import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
-import { join } from "node:path";
+import { basename, join } from "node:path";
 import { dispatchPaths, readExit, requestCancel } from "../../src/infra/dispatch-dir.ts";
+import { activityReporter } from "../../src/infra/lock-activity.ts";
 import * as store from "../../src/infra/store.ts";
 import { type SuperviseSpec, supervise } from "../../src/infra/supervisor.ts";
 import { exited, snapshotEnv, tempDir, withHome } from "../helpers.ts";
@@ -81,6 +82,30 @@ describe("supervise", () => {
     expect(interrupted).toBe(true);
   });
 
+  it("counts the wall from a live catherd lock's last output while it writes (plan 23)", async () => {
+    const s = spec("sleep 30", { idleMs: 60_000, wallMs: 200 });
+    const lock = activityReporter(basename(s.dispatchDir), Date.now, 0);
+    if (!lock) throw new Error("no reporter");
+    const begun = Date.now();
+    // output for 600 ms, three times the wall; then silence, and the wall ends it 200 ms after the last line
+    const timer = setInterval(() => {
+      if (Date.now() - begun < 600) lock.tick();
+    }, 20);
+    try {
+      const exit = await supervise(s, { isBusy: async () => true });
+      expect(exit?.reason).toBe("wall-timeout");
+      expect(Date.now() - begun).toBeGreaterThanOrEqual(600);
+    } finally {
+      clearInterval(timer);
+      lock.done();
+    }
+    // with no live lock, the wall counts from the start
+    const plain = spec("sleep 30", { idleMs: 60_000, wallMs: 200 });
+    const at = Date.now();
+    expect((await supervise(plain, { isBusy: async () => true }))?.reason).toBe("wall-timeout");
+    expect(Date.now() - at).toBeLessThan(5_000);
+  });
+
   it("kills a CLI that lingers after its final event", async () => {
     const s = spec(`echo '{"type":"result"}'; sleep 30`, { graceAfterFinalMs: 100 });
     const exit = await supervise(s, { onLine: (l) => ({ final: l.includes("result") }) });
diff --git a/test/services/admission.test.ts b/test/services/admission.test.ts
index e2fe04a..6914ccd 100644
--- a/test/services/admission.test.ts
+++ b/test/services/admission.test.ts
@@ -101,8 +101,8 @@ describe("admission", () => {
     const text = readFileSync(specPath, "utf8");
     expect(text).not.toContain("s3cret");
     expect(text).not.toContain("TYPESAFE_API_KEY");
-    // the adapter's overrides and PWD only: a plain codex rung has none
-    expect(JSON.parse(text).env).toEqual({ PWD: repo });
+    // the adapter's overrides (a plain codex rung has none), the dispatch id for catherd lock, and PWD
+    expect(JSON.parse(text).env).toEqual({ CATHERD_DISPATCH_ID: expect.any(String), PWD: repo });
     expect(statSync(specPath).mode & 0o777).toBe(0o600);
   });
 
```

### Task 5: `VERDICT: BLOCKED: environment`, and a host probe that retries once

**Scratch commit:** `0f3f4b8` — `feat(verifier): a blocked-by-environment verdict is surfaced, not fixed; host probes retry once`

**Files:** create `src/infra/host-probe.ts`, `test/infra/host-probe.test.ts`; modify `src/services/milestones.ts`, `src/services/lane-service.ts`, `src/services/protocol.ts`, `src/services/run-store.ts`, `src/services/run-service.ts`, `src/entry/mcp/run-tools.ts`, `src/domain/role-prompts.ts`, `plugin/skills/catherd/SKILL.md`, `test/services/land-gate.test.ts`, `test/services/dispatch-protocol.test.ts`.

**Consumes:** Task 2's `protocol.ts`. **Produces (Rulings 8, 9):**
- `blockedByEnvironment(line): string | null` (the probe, `""` when none is named) in `milestones.ts`; `MilestoneVerifier.blocked: string | null` (a headless reply's first line when the CLI exited ok; a native row's `verdict` when its status is not ok).
- `AgentRun.verdict?: string`; `recordAgentRun({ …, verdict? })` keeps its first line; `record_agent_run` takes `verdict`.
- `land` refuses a blocked verdict first: `E_LAND_GATE` "land <M>: <verifier> is blocked by the environment: <probe>", fix "surface it to the owner: park(run, "<M>", …) …".
- `protocolNext`: `"<M>: <verifier> is blocked by the environment (<probe>): surface it to the owner (park <M>), not a fix round"`.
- The verifier's reply contract names `VERDICT: BLOCKED: environment — <the probe that proves it>` and the twice-5-s rule.
- `src/infra/host-probe.ts`: `hostProbe = { retryMs: 5_000 }`, `probeTwice(probe, ok) → { result, attempts: 1 | 2 }` (used by Task 13).
- SKILL.md: `verdict:` for a native verifier, and the BLOCKED bullet.

- [ ] **Step 1: the failing tests.** "treats VERDICT: BLOCKED: environment as a blocker to surface, in land and in the next step (plan 23)" (`land-gate.test.ts`), `test/infra/host-probe.test.ts` (new), the verifier contract's first words in `dispatch-protocol.test.ts`. They fail (`land` says "missing … a verifier verdict"; no `host-probe.ts`).
- [ ] **Step 2: the code.** Apply the source hunks; create `src/infra/host-probe.ts`.
- [ ] **Step 3:** `bun test test/services/land-gate.test.ts test/services/protocol.test.ts test/services/dispatch-protocol.test.ts test/infra/host-probe.test.ts test/skills.test.ts test/plugin.test.ts`; `bun run typecheck && bun run lint`.
- [ ] **Step 4: commit** `feat(verifier): a blocked-by-environment verdict is surfaced, not fixed; host probes retry once` (not `…: VERDICT: BLOCKED…`: commitlint reads it as sentence case).

```diff
diff --git a/plugin/skills/catherd/SKILL.md b/plugin/skills/catherd/SKILL.md
index 62d6f7c..7249fbf 100644
--- a/plugin/skills/catherd/SKILL.md
+++ b/plugin/skills/catherd/SKILL.md
@@ -272,7 +272,8 @@ Nothing else pushes: a phone that buzzes for progress teaches the user to ignore
    - A finding that comes back: `ask(run, "same-defect", …)`. `yes` gets one climb and one re-check of that line. Anything still open goes to the report, not into another round.
 9. **verifier,** named `verifier-<M>`, with the run id, the milestone's A-lines and the **full check**, on a frozen tree: it owns the independent gate. Route it first. A native Claude verifier runs in the foreground on Claude Code; a Codex or other process verifier uses `dispatch`, end the turn, then `result`. A full check that starts while a role still edits proves nothing, and it has to run again. Never give it a worker's reply.
    - It checks each gate item with `gate_check` first and skips an item that passed on the same content (carried over from its commit); it records each pass with `gate_pass`, runs independent items side by side within the lock's slots, and builds each commit's images once. It names git-ignored inputs (`.env`, generated files) in `paths` explicitly: `.` covers only HEAD and uncommitted not-ignored changes. It passes `gate_check` the milestone it verifies, so the digest lists only that milestone's carried items. `peek` and `status` show its current step.
-   - For a native Claude verifier only, call `record_agent_run(run, "verifier-<M>", "verifier", rung, …)`, with `status: "failed"` when its verdict is FAIL: only a PASS is recorded `ok`. A process verifier on any backend counts through its dispatch record only when its reply opens `VERDICT: PASS`; collect it with `result` before landing.
+   - For a native Claude verifier only, call `record_agent_run(run, "verifier-<M>", "verifier", rung, …)`, with `status: "failed"` when its verdict is FAIL: only a PASS is recorded `ok`. Pass `verdict:`, its reply's first line. A process verifier on any backend counts through its dispatch record only when its reply opens `VERDICT: PASS`; collect it with `result` before landing.
+   - `VERDICT: BLOCKED: environment — <probe>` is the machine, not the work (a VPN filter, a Docker proxy, a dead registry): no fix round and no climb. `land` refuses it; surface it to the owner with `park`, and run a fresh verifier once it is fixed.
    - On FAIL, the owning worker fixes it, then a **fresh** verifier re-checks (a resumed one can hang): a new `dispatch` or Agent with no `thread`, its brief naming the failed items (`gate_check(run, milestone)` lists them) and a 10-minute cap on each command; what passed is carried over.
    - A second FAIL on the same line goes to the architect.
    - A third one: pause, report and push.
diff --git a/src/domain/role-prompts.ts b/src/domain/role-prompts.ts
index 6689f08..81852fb 100644
--- a/src/domain/role-prompts.ts
+++ b/src/domain/role-prompts.ts
@@ -148,7 +148,7 @@ const STATUS_LINE =
  */
 const CONTRACTS: Record<Role, string> = {
   architect: `Reply briefly: the milestones, each with its lanes as Mx.Ly — one line — owned files, and the full-check command. ${STATUS_LINE}`,
-  verifier: `The first line of your reply is VERDICT: PASS or VERDICT: FAIL. ${STATUS_LINE}`,
+  verifier: `The first line of your reply is VERDICT: PASS or VERDICT: FAIL, or VERDICT: BLOCKED: environment — <the probe that proves it> when the machine, not the work, stops the gate (run that probe twice, 5 s apart, before you call the host blocked). ${STATUS_LINE}`,
   worker: REPLY,
   reviewer: REPLY,
   "ui-reviewer": REPLY,
diff --git a/src/entry/mcp/run-tools.ts b/src/entry/mcp/run-tools.ts
index e3461db..824fc5d 100644
--- a/src/entry/mcp/run-tools.ts
+++ b/src/entry/mcp/run-tools.ts
@@ -92,7 +92,7 @@ export function registerRunTools(server: McpServer, deps: Deps): void {
     "record_agent_run",
     {
       description:
-        "After every native Claude subagent (Agent tool) of a run, record what the Agent result reported: total_tokens and duration_ms. The budget counts it. Pass lane (e.g. M1.L1) when the subagent worked a lane, so its time counts toward that lane's kind in the catalog timings. status says how the subagent's work ended: for a verifier it is the verdict, so pass status: \"failed\" when its verdict is FAIL; only a PASS is recorded ok.",
+        'After every native Claude subagent (Agent tool) of a run, record what the Agent result reported: total_tokens and duration_ms. The budget counts it. Pass lane (e.g. M1.L1) when the subagent worked a lane, so its time counts toward that lane\'s kind in the catalog timings. status says how the subagent\'s work ended: for a verifier it is the verdict, so pass status: "failed" when its verdict is FAIL; only a PASS is recorded ok. For a verifier, pass verdict: the first line of its reply; a VERDICT: BLOCKED: environment — <probe> (status "failed") is then a blocker to surface to the owner, not a fix round.',
       inputSchema: {
         run: z.string(),
         name: z.string().regex(ID_PATTERN),
@@ -103,6 +103,7 @@ export function registerRunTools(server: McpServer, deps: Deps): void {
         cost_usd: z.number().nonnegative().optional(),
         status: z.enum(["ok", "failed", "cancelled"]).default("ok"),
         lane: z.string().regex(ID_PATTERN).optional(),
+        verdict: z.string().min(1).optional(),
       },
     },
     (a) =>
@@ -117,6 +118,7 @@ export function registerRunTools(server: McpServer, deps: Deps): void {
           durationMs: a.duration_ms,
           costUsd: a.cost_usd,
           status: a.status,
+          verdict: a.verdict,
         }),
       ),
   );
diff --git a/src/infra/host-probe.ts b/src/infra/host-probe.ts
new file mode 100644
index 0000000..0ffc309
--- /dev/null
+++ b/src/infra/host-probe.ts
@@ -0,0 +1,16 @@
+// Plan 23: a host probe that fails once may have caught the network mid-change (a VPN just dropped, a route
+// still settling). catherd's own host probes run twice, this far apart, before they call the host blocked.
+
+/** The pause before the second try; tests shorten it. */
+export const hostProbe = { retryMs: 5_000 };
+
+/** `probe`, and once more after hostProbe.retryMs when `ok` says the first answer failed. */
+export async function probeTwice<T>(
+  probe: () => Promise<T>,
+  ok: (r: T) => boolean,
+): Promise<{ result: T; attempts: 1 | 2 }> {
+  const first = await probe();
+  if (ok(first)) return { result: first, attempts: 1 };
+  await Bun.sleep(hostProbe.retryMs);
+  return { result: await probe(), attempts: 2 };
+}
diff --git a/src/services/lane-service.ts b/src/services/lane-service.ts
index d259658..f099864 100644
--- a/src/services/lane-service.ts
+++ b/src/services/lane-service.ts
@@ -274,6 +274,15 @@ async function gate(run: Run, m: string, commit: string, skip: LandSkip | undefi
   const start = milestoneStart(run, m);
   // the latest verifier attempt, passed or not: a FAIL after a PASS undoes it
   const verdict = milestoneVerifier(run, m, start);
+  // plan 23: a verdict on the machine is a blocker for the owner, never a fix round
+  if (verdict?.blocked != null)
+    throw new CatherdError(
+      "E_LAND_GATE",
+      `land ${m}: ${verdict.name} is blocked by the environment${verdict.blocked ? `: ${verdict.blocked}` : ""}`,
+      {
+        fix: `surface it to the owner: park(run, "${m}", <the blocker and its probe>); once the environment is fixed, run a fresh verifier on ${m}. A fix round or a climb cannot help`,
+      },
+    );
   const missing = [
     ...(reviewerPassed(run, m, start)
       ? []
diff --git a/src/services/milestones.ts b/src/services/milestones.ts
index 404e94b..288fba7 100644
--- a/src/services/milestones.ts
+++ b/src/services/milestones.ts
@@ -80,6 +80,15 @@ export const reviewerPassed = (run: Run, m: string, start = milestoneStart(run,
 /** The verifier's contract puts `VERDICT: PASS` or `VERDICT: FAIL` on the reply's first line (role-prompts.ts). */
 const VERDICT_PASS = /^VERDICT: PASS\b/;
 
+/**
+ * Plan 23: `VERDICT: BLOCKED: environment — <the probe that proves it>`, a verdict on the machine, not on the
+ * work. Its probe, or null when `line` is no such verdict ("" when it names none).
+ */
+export function blockedByEnvironment(line: string | null | undefined): string | null {
+  const m = /^VERDICT:\s*BLOCKED:\s*environment\b\s*(?:—|–|-|:)?\s*(.*)$/i.exec(line?.trim() ?? "");
+  return m ? (m[1] ?? "").trim() : null;
+}
+
 /** A headless verifier's reply: its first non-blank line, trimmed; null when there is no reply to read. */
 export function replyVerdict(run: Run, r: RunRecord): string | null {
   const file = join(run.dir, r.replyPath);
@@ -106,6 +115,8 @@ export interface MilestoneVerifier {
   passed: boolean;
   /** what the attempt said: a native row's status, or a headless reply's first non-blank line ("no reply") */
   verdict: string;
+  /** plan 23: the probe of a `VERDICT: BLOCKED: environment` attempt ("" when it named none); null otherwise */
+  blocked: string | null;
 }
 
 /**
@@ -123,13 +134,18 @@ export function milestoneVerifier(
   const found: MilestoneVerifier[] = [
     ...readAgentRuns(run)
       .filter((a) => a.role === "verifier" && namesMilestone(a.name, m) && since(a.at, start))
-      .map((a) => ({
-        name: a.name,
-        at: a.at,
-        headless: false,
-        passed: a.status === "ok",
-        verdict: a.status,
-      })),
+      .map((a) => {
+        // plan 23: a native verifier's verdict line, when record_agent_run passed it
+        const blocked = a.status === "ok" ? null : blockedByEnvironment(a.verdict);
+        return {
+          name: a.name,
+          at: a.at,
+          headless: false,
+          passed: a.status === "ok",
+          verdict: blocked === null ? a.status : (a.verdict ?? a.status),
+          blocked,
+        };
+      }),
     ...readRecords(run)
       .records.filter((r) => r.role === "verifier" && namesMilestone(r.name, m) && since(r.endedAt, start))
       .map((r) => {
@@ -142,6 +158,7 @@ export function milestoneVerifier(
           headless: true,
           passed,
           verdict: r.status === "ok" ? said : `${r.status}, ${said}`,
+          blocked: r.status === "ok" ? blockedByEnvironment(first) : null,
         };
       }),
   ];
diff --git a/src/services/protocol.ts b/src/services/protocol.ts
index 4f4e43f..48758e5 100644
--- a/src/services/protocol.ts
+++ b/src/services/protocol.ts
@@ -112,6 +112,9 @@ export function protocolNext(run: Run, parked: string[], now = Date.now()): stri
   if (!reviewerPassed(run, m, start)) return `${m}: reviewer`;
   const verdict = milestoneVerifier(run, m, start);
   if (!verdict) return `${m}: verifier`;
+  // plan 23: the machine, not the work: the owner hears of it, and no fix round runs
+  if (verdict.blocked !== null)
+    return `${m}: ${verdict.name} is blocked by the environment${verdict.blocked ? ` (${verdict.blocked})` : ""}: surface it to the owner (park ${m}), not a fix round`;
   if (!verdict.passed) {
     // plan 23: a resumed verifier can hang; a re-check goes to a fresh one, told what failed
     const failed = failedItems(run, m);
diff --git a/src/services/run-service.ts b/src/services/run-service.ts
index c73cabc..9d6ecdb 100644
--- a/src/services/run-service.ts
+++ b/src/services/run-service.ts
@@ -159,6 +159,8 @@ export function recordAgentRun(
     durationMs?: number;
     status?: AgentRun["status"];
     lane?: string;
+    /** plan 23: a native verifier's first reply line, so a VERDICT: BLOCKED: environment is told from a FAIL */
+    verdict?: string;
   },
 ): AgentRun {
   const run = findRun(i.run);
@@ -180,6 +182,7 @@ export function recordAgentRun(
     secs: i.durationMs === undefined ? null : Math.round(i.durationMs / 1000),
     status: i.status ?? "ok",
     lane: i.lane ?? null,
+    ...(i.verdict ? { verdict: i.verdict.trim().split("\n")[0] } : {}),
   };
   appendAgentRun(run, row);
   return row;
diff --git a/src/services/run-store.ts b/src/services/run-store.ts
index 630ac01..49561f3 100644
--- a/src/services/run-store.ts
+++ b/src/services/run-store.ts
@@ -265,6 +265,8 @@ const AgentRunSchema = z.looseObject({
   status: z.enum(["ok", "failed", "cancelled"]),
   /** the lane the subagent worked, so catalog timings count it under that lane's kind; rows before it lack it */
   lane: z.string().nullable().optional(),
+  /** plan 23: a native verifier's verdict line (VERDICT: BLOCKED: environment — <probe>); rows before it lack it */
+  verdict: z.string().optional(),
 });
 export type AgentRun = z.infer<typeof AgentRunSchema>;
 
diff --git a/test/infra/host-probe.test.ts b/test/infra/host-probe.test.ts
new file mode 100644
index 0000000..e0d5a9e
--- /dev/null
+++ b/test/infra/host-probe.test.ts
@@ -0,0 +1,37 @@
+import { afterEach, describe, expect, it } from "bun:test";
+import { hostProbe, probeTwice } from "../../src/infra/host-probe.ts";
+
+const saved = hostProbe.retryMs;
+afterEach(() => {
+  hostProbe.retryMs = saved;
+});
+
+describe("a host probe (plan 23)", () => {
+  it("retries once before it calls the host blocked", async () => {
+    hostProbe.retryMs = 0;
+    const answers = [false, true];
+    let asked = 0;
+    const r = await probeTwice(
+      async () => answers[asked++] as boolean,
+      (ok) => ok,
+    );
+    expect(r).toEqual({ result: true, attempts: 2 });
+    // a first answer that passes is the answer; a second failure is the verdict
+    expect(
+      await probeTwice(
+        async () => true,
+        (ok) => ok,
+      ),
+    ).toEqual({ result: true, attempts: 1 });
+    expect(
+      await probeTwice(
+        async () => false,
+        (ok) => ok,
+      ),
+    ).toEqual({ result: false, attempts: 2 });
+  });
+
+  it("waits five seconds between the two tries by default", () => {
+    expect(saved).toBe(5_000);
+  });
+});
diff --git a/test/services/dispatch-protocol.test.ts b/test/services/dispatch-protocol.test.ts
index 33f671e..6f5357d 100644
--- a/test/services/dispatch-protocol.test.ts
+++ b/test/services/dispatch-protocol.test.ts
@@ -35,7 +35,7 @@ describe("the reply contract (spec 1.1 §6)", () => {
       );
     expect(replyContract("worker")).toStartWith("Do not commit. Reply in at most 15 lines");
     expect(replyContract("verifier")).toStartWith(
-      "The first line of your reply is VERDICT: PASS or VERDICT: FAIL.",
+      "The first line of your reply is VERDICT: PASS or VERDICT: FAIL, or VERDICT: BLOCKED: environment",
     );
   });
 
diff --git a/test/services/land-gate.test.ts b/test/services/land-gate.test.ts
index 2a5c9c4..05f7fa5 100644
--- a/test/services/land-gate.test.ts
+++ b/test/services/land-gate.test.ts
@@ -12,6 +12,7 @@ import {
   reviewerPassed,
   reviewsMilestone,
 } from "../../src/services/milestones.ts";
+import { protocolNext } from "../../src/services/protocol.ts";
 import { appendAgentRun, appendRecord, readAgentRuns } from "../../src/services/run-store.ts";
 import { writeDeliveryAttempt } from "../../src/infra/delivery.ts";
 import { result, recordAgentRun } from "../../src/services/run-service.ts";
@@ -296,6 +297,79 @@ describe("the land gate (spec 1.1 §6)", () => {
     );
   });
 
+  it("treats VERDICT: BLOCKED: environment as a blocker to surface, in land and in the next step (plan 23)", async () => {
+    const { repo, run } = freshRun();
+    writeLane(run, "M1.L1", ["src/a.ts"]);
+    await route(fakeDeps(), { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
+    const c = commitFiles(repo, ["src/a.ts"]);
+    const t0 = Date.now() + 1000;
+    appendAgentRun(run, {
+      at: new Date(t0 - 500).toISOString(),
+      name: "worker-M1.L1",
+      role: "worker",
+      rung: "claude:claude-opus-5-5#low",
+      agent: null,
+      totalTokens: 1,
+      costUsd: null,
+      secs: 1,
+      status: "ok",
+      lane: "M1.L1",
+    });
+    await passGate(run, "M1", new Date(t0).toISOString());
+    const dispatchId = newDispatchId();
+    const replyPath = `roles/verifier-M1/${dispatchId}/reply.md`;
+    mkdirSync(dirname(join(run.dir, replyPath)), { recursive: true });
+    writeFileSync(
+      join(run.dir, replyPath),
+      "VERDICT: BLOCKED: environment — curl http://172.17.0.2:8080 from a Go binary: no route to host, twice\nSTATUS: blocked — the VPN filter\n",
+    );
+    await appendRecord(
+      run,
+      makeRecord({
+        runId: run.id,
+        dispatchId,
+        name: "verifier-M1",
+        role: "verifier",
+        replyPath,
+        endedAt: new Date(t0 + 1000).toISOString(),
+      }),
+    );
+    const e = await refusal(land(fakeDeps(), landing(run.id, c)));
+    expect(e.code).toBe("E_LAND_GATE");
+    expect(e.message).toBe(
+      "land M1: verifier-M1 is blocked by the environment: curl http://172.17.0.2:8080 from a Go binary: no route to host, twice",
+    );
+    expect(e.fix).toContain('park(run, "M1"');
+    expect(protocolNext(run, [])).toBe(
+      "M1: verifier-M1 is blocked by the environment (curl http://172.17.0.2:8080 from a Go binary: no route to host, twice): surface it to the owner (park M1), not a fix round",
+    );
+    // a native verifier says it through record_agent_run's verdict
+    const claude = { host: "claude-code" as const, session: null, conflict: null };
+    recordAgentRun(fakeDeps({ host: claude, now: () => t0 + 2000 }), {
+      run: run.id,
+      name: "verifier-M1",
+      role: "verifier",
+      rung: "claude:claude-opus-5-5#low",
+      totalTokens: 1,
+      status: "failed",
+      verdict: "VERDICT: BLOCKED: environment - docker compose: minio-buckets cannot resolve minio\nmore",
+    });
+    expect((await refusal(land(fakeDeps(), landing(run.id, c)))).message).toBe(
+      "land M1: verifier-M1 is blocked by the environment: docker compose: minio-buckets cannot resolve minio",
+    );
+    // a plain FAIL stays a fix round
+    recordAgentRun(fakeDeps({ host: claude, now: () => t0 + 3000 }), {
+      run: run.id,
+      name: "verifier-M1",
+      role: "verifier",
+      rung: "claude:claude-opus-5-5#low",
+      totalTokens: 1,
+      status: "failed",
+      verdict: "VERDICT: FAIL",
+    });
+    expect(protocolNext(run, [])).toStartWith("M1: verifier-M1 failed: the owning lanes fix it");
+  });
+
   it("takes a native reviewer (record_agent_run, role reviewer, reviewer-<M>, ok) since the milestone started", async () => {
     const { repo, run } = freshRun();
     writeLane(run, "M1.L1", ["src/a.ts"]);
```

### Task 6: the gate environment

**Scratch commit:** `e208368` — `feat(knowledge): a per-repo gate environment for the verifier, secrets by reference`

**Files:** create `src/infra/login-env.ts`, `src/services/gate-env.ts`, `test/services/gate-env.test.ts`; modify `src/services/admission.ts`, `src/infra/supervisor.ts`, `src/entry/supervise-command.ts`, `src/entry/knowledge-command.ts`, `README.md`, `test/entry/knowledge-command.test.ts`.

**Consumes:** Task 4's `admission.ts` and `supervisor.ts`. **Produces (Rulings 10–13):**
- `src/infra/login-env.ts`: `loginShell = { timeoutMs: 5_000 }`, `parseEnv(out)`, `loginEnv()` (captured once, secrets scrubbed, `{}` when the shell fails), `resetLoginEnv()`.
- `src/services/gate-env.ts`: `GateEnvEntry = { value } | { from }`, `gateEnvFile(toplevel)`, `readGateEnv(toplevel)`, `setGateEnv(repo, name, entry)` (async; refuses a bad name, a bad `from`, and a secret-looking name by value), `removeGateEnv(repo, name)`, `gateEnvLines(vars)` (`NAME=value`, `NAME=$FROM`, sorted), `gateEnvParts(vars) → { values, refs }`, `resolveGateEnv(vars, base, fallback?)`, `resolveRefs(values, refs, base, fallback?) → { env, missing }`. Writes are locked (`withFileLock`) and atomic, mode 600, schema 1.
- `SuperviseSpecSchema.envFrom?: Record<name, source name>`; `runSupervise` resolves it from its env, else `loginEnv()`, logging the unset ones.
- Admission: a verifier's spec env gets the gate env's values, and `envFrom` its references; other roles get neither.
- `catherd knowledge env set NAME=value | NAME --from VAR`, `env rm NAME`, `env list` (all with `--repo`, `--json`); README's commands table.

- [ ] **Step 1: the failing tests.** `test/services/gate-env.test.ts` (new) and "catherd knowledge env (plan 23)" in `test/entry/knowledge-command.test.ts`. They fail (no module; `knowledge env` is unknown).
- [ ] **Step 2: the code.** Create the two modules; apply the other hunks.
- [ ] **Step 3:** `bun test test/services/gate-env.test.ts test/entry/knowledge-command.test.ts test/services/admission.test.ts test/architecture.test.ts`; `bun run typecheck && bun run lint && bun run format:check`.
- [ ] **Step 4: commit** `feat(knowledge): a per-repo gate environment for the verifier, secrets by reference`.

```diff
diff --git a/README.md b/README.md
index 7498a85..f65dc10 100644
--- a/README.md
+++ b/README.md
@@ -200,6 +200,7 @@ In a terminal:
 | `catherd catalog treat-like <rung> <like>`                                                  | Scores an unscored rung as a scored one                                                             |
 | `catherd catalog treat-like --suggest <rung>\|--clear <rung>\|--reset`                      | The three nearest stand-ins for a rung; removes one or every mapping of yours                       |
 | `catherd knowledge show\|add "<line>"\|path [--repo <path>]`                                | The repo's knowledge.md, which new runs read; `add` appends a fact of yours, marked "by hand"       |
+| `catherd knowledge env set NAME=value\|NAME --from VAR`, `env rm NAME`, `env list`          | The repo's gate environment, which the verifier and preflight run with; a secret by reference only  |
 | `catherd lock [--slots N] -- <cmd>`                                                         | Runs a heavy command behind the machine-wide semaphore, in its own session (no /dev/tty)            |
 | `catherd mcp`                                                                               | The MCP server on stdio; the plugin starts it, you never need to                                    |
 | `catherd capture-fixtures [--backend <b>] [--out <dir>]`                                    | Contributors: records sanitized test fixtures from real runs (see CONTRIBUTING.md)                  |
diff --git a/src/entry/knowledge-command.ts b/src/entry/knowledge-command.ts
index c7ef65b..f3f988d 100644
--- a/src/entry/knowledge-command.ts
+++ b/src/entry/knowledge-command.ts
@@ -1,5 +1,7 @@
 import { resolve } from "node:path";
 import { defineCommand } from "citty";
+import { CatherdError } from "../domain/errors.ts";
+import { gateEnvLines, readGateEnv, removeGateEnv, setGateEnv } from "../services/gate-env.ts";
 import { addKnowledge, knowledgeLines, knowledgePath, readKnowledge } from "../services/run-service.ts";
 import { JSON_ARG, printJson } from "./cli-kit.ts";
 
@@ -43,8 +45,78 @@ const path = defineCommand({
   },
 });
 
+/** `NAME=value` as name and value; null when it has no `=`. */
+function assignment(raw: string): { name: string; value: string } | null {
+  const eq = raw.indexOf("=");
+  return eq > 0 ? { name: raw.slice(0, eq), value: raw.slice(eq + 1) } : null;
+}
+
+const envSet = defineCommand({
+  meta: {
+    name: "set",
+    description:
+      "Set one variable of the repo's gate environment, which the verifier and preflight run with: NAME=value, or NAME --from ENV_VAR for a secret (stored by reference, read when a role starts)",
+  },
+  args: {
+    variable: { type: "positional", required: true, description: "NAME=value, or NAME with --from" },
+    from: { type: "string", description: "the env var that holds the secret value" },
+    ...REPO_ARG,
+    ...JSON_ARG,
+  },
+  async run({ args }) {
+    const set = assignment(args.variable);
+    if (args.from !== undefined && set)
+      throw new CatherdError("E_INPUT_INVALID", "pass NAME=value or NAME --from ENV_VAR, not both", {
+        fix: "catherd knowledge env set DOCKER_HOST=unix:///var/run/docker.sock",
+      });
+    if (args.from === undefined && !set)
+      throw new CatherdError("E_INPUT_INVALID", `"${args.variable}" has no value`, {
+        fix: "catherd knowledge env set NAME=value, or catherd knowledge env set NAME --from ENV_VAR",
+      });
+    const r = set
+      ? await setGateEnv(repoOf(args.repo), set.name, { value: set.value })
+      : await setGateEnv(repoOf(args.repo), args.variable, { from: args.from as string });
+    if (args.json) return printJson(r);
+    for (const line of gateEnvLines(r.vars)) console.log(line);
+  },
+});
+
+const envRm = defineCommand({
+  meta: { name: "rm", description: "Remove one variable from the repo's gate environment" },
+  args: { name: { type: "positional", required: true }, ...REPO_ARG, ...JSON_ARG },
+  async run({ args }) {
+    const r = await removeGateEnv(repoOf(args.repo), args.name);
+    if (args.json) return printJson(r);
+    for (const line of gateEnvLines(r.vars)) console.log(line);
+  },
+});
+
+const envList = defineCommand({
+  meta: { name: "list", description: "Print the repo's gate environment (a secret shows as $ENV_VAR)" },
+  args: { ...REPO_ARG, ...JSON_ARG },
+  async run({ args }) {
+    const at = await knowledgePath(repoOf(args.repo));
+    const vars = readGateEnv(at.repo);
+    if (args.json) return printJson({ repo: at.repo, vars });
+    const lines = gateEnvLines(vars);
+    console.log(lines.length ? lines.join("\n") : "catherd: no gate environment set for this repo");
+  },
+});
+
+/** Plan 23: the repo's gate environment, beside its knowledge.md. */
+const env = defineCommand({
+  meta: {
+    name: "env",
+    description: "The repo's gate environment, which the verifier and preflight run with: set, rm or list",
+  },
+  subCommands: { set: envSet, rm: envRm, list: envList },
+});
+
 /** What past runs of a repo learned, which the read_knowledge tool gives every new run (spec §4.7). */
 export const knowledgeCommand = defineCommand({
-  meta: { name: "knowledge", description: "What catherd knows about a repo: show, add or path" },
-  subCommands: { show, add, path },
+  meta: {
+    name: "knowledge",
+    description: "What catherd knows about a repo: show, add or path, and its gate environment (env)",
+  },
+  subCommands: { show, add, path, env },
 });
diff --git a/src/entry/supervise-command.ts b/src/entry/supervise-command.ts
index 01fba27..99f73e1 100644
--- a/src/entry/supervise-command.ts
+++ b/src/entry/supervise-command.ts
@@ -1,8 +1,11 @@
 import { defineCommand } from "citty";
 import { adapterFor } from "../adapters/registry.ts";
 import { workerEnv } from "../infra/env.ts";
+import { log } from "../infra/log.ts";
+import { loginEnv } from "../infra/login-env.ts";
 import { readVersioned } from "../infra/store.ts";
 import { SuperviseSpecSchema, supervise } from "../infra/supervisor.ts";
+import { resolveRefs } from "../services/gate-env.ts";
 import "../adapters/all.ts";
 
 /**
@@ -12,7 +15,10 @@ import "../adapters/all.ts";
  */
 export async function runSupervise(specPath: string): Promise<void> {
   const read = readVersioned(specPath, SuperviseSpecSchema, 1);
-  const spec = { ...read, env: workerEnv(process.env, read.env, read.cwd) };
+  // plan 23: a gate env secret by reference, read here from this env, else the user's login env
+  const refs = resolveRefs({}, read.envFrom ?? {}, process.env, loginEnv);
+  if (refs.missing.length) log("warn", "gate-env", { dispatch: read.dispatchDir, unset: refs.missing });
+  const spec = { ...read, env: workerEnv(process.env, { ...read.env, ...refs.env }, read.cwd) };
   const a = adapterFor(spec.backend);
   const busy = a?.isBusy?.bind(a);
   const stop = a?.interrupt?.bind(a);
diff --git a/src/infra/login-env.ts b/src/infra/login-env.ts
new file mode 100644
index 0000000..d1168d7
--- /dev/null
+++ b/src/infra/login-env.ts
@@ -0,0 +1,48 @@
+import { scrubSecrets } from "./env.ts";
+
+// Plan 23: what a login shell of the user's sees (DOCKER_HOST for OrbStack or rootless Docker, a proxy, a
+// toolchain's PATH), which a server started by a desktop app or a plugin launcher may not inherit.
+// `$SHELL -lc env` is run once per process and kept.
+
+/** How long the login shell may take; one that hangs (a prompt in a profile) counts as an empty env. */
+export const loginShell = { timeoutMs: 5_000 };
+
+let captured: Record<string, string> | null = null;
+
+/** Parses `env -0` output, or plain `env` lines from a shell whose env has no -0. */
+export function parseEnv(out: string): Record<string, string> {
+  const env: Record<string, string> = {};
+  const rows = out.includes("\0") ? out.split("\0") : out.split("\n");
+  for (const row of rows) {
+    const eq = row.indexOf("=");
+    if (eq > 0) env[row.slice(0, eq)] = row.slice(eq + 1);
+  }
+  return env;
+}
+
+function capture(): Record<string, string> {
+  const shell = process.env.SHELL || "/bin/sh";
+  try {
+    const r = Bun.spawnSync([shell, "-lc", "env -0 2>/dev/null || env"], {
+      env: scrubSecrets(process.env),
+      stdin: "ignore",
+      stdout: "pipe",
+      stderr: "ignore",
+      timeout: loginShell.timeoutMs,
+    });
+    return r.exitCode === 0 ? scrubSecrets(parseEnv(r.stdout.toString())) : {};
+  } catch {
+    return {};
+  }
+}
+
+/** The user's login environment, without catherd's secrets; empty when the shell cannot say. Captured once. */
+export function loginEnv(): Record<string, string> {
+  captured ??= capture();
+  return captured;
+}
+
+/** Forgets the captured env (tests, which change SHELL). */
+export function resetLoginEnv(): void {
+  captured = null;
+}
diff --git a/src/infra/supervisor.ts b/src/infra/supervisor.ts
index 7bd3575..b6b8af7 100644
--- a/src/infra/supervisor.ts
+++ b/src/infra/supervisor.ts
@@ -19,6 +19,8 @@ export const SuperviseSpecSchema = z.looseObject({
   cmd: z.string(),
   args: z.array(z.string()),
   env: z.record(z.string(), z.string()),
+  /** plan 23: env vars set from another one at spawn (a gate env secret by reference): name → source name */
+  envFrom: z.record(z.string(), z.string()).optional(),
   cwd: z.string(),
   stdinPath: z.string().nullable(),
   idleMs: z.number().positive(),
diff --git a/src/services/admission.ts b/src/services/admission.ts
index 6be6caa..934d76c 100644
--- a/src/services/admission.ts
+++ b/src/services/admission.ts
@@ -33,6 +33,7 @@ import {
   setLatest,
 } from "./dispatches.ts";
 import { finalizeDispatch } from "./finalize.ts";
+import { gateEnvParts, readGateEnv } from "./gate-env.ts";
 import type { Deps } from "./ports.ts";
 import { readRecords, recordsOnThread, type Run, runPaths } from "./run-store.ts";
 import { currentSession } from "./sessions.ts";
@@ -287,6 +288,8 @@ export async function admit(
       ...(sessionId ? { sessionId, host: i.host ?? session?.host ?? "claude-code" } : {}),
     };
     ensurePrivateDir(dir);
+    // plan 23: the verifier runs with the repo's gate environment (DOCKER_HOST, a proxy, …)
+    const gate = i.role === "verifier" ? gateEnvParts(readGateEnv(run.meta.repo)) : { values: {}, refs: {} };
     // spec 1.1 §6: every brief ends with its role's reply contract, failover stand-ins' included
     writeTextAtomic(p.brief, withReplyContract(i.role, i.brief));
     // Spec §10.4: the adapter's overrides only; the supervisor adds its own inherited env at spawn
@@ -300,7 +303,9 @@ export async function admit(
         cmd: plan.cmd,
         args: plan.args,
         // plan 23: a `catherd lock` in the role reports to this dispatch, so a long gate keeps its wall alive
-        env: { ...plan.env, [DISPATCH_ID_ENV]: id, PWD: plan.cwd },
+        env: { ...plan.env, ...gate.values, [DISPATCH_ID_ENV]: id, PWD: plan.cwd },
+        // a secret of the gate env by reference only: the supervisor reads it from its own env at spawn
+        ...(Object.keys(gate.refs).length ? { envFrom: gate.refs } : {}),
         cwd: plan.cwd,
         stdinPath: plan.stdinPath,
         // plan 23: a role's own timeouts win over the profile's (a verifier's long gate)
diff --git a/src/services/gate-env.ts b/src/services/gate-env.ts
new file mode 100644
index 0000000..c230f42
--- /dev/null
+++ b/src/services/gate-env.ts
@@ -0,0 +1,158 @@
+import { existsSync } from "node:fs";
+import { join } from "node:path";
+import { z } from "zod";
+import { CatherdError } from "../domain/errors.ts";
+import { withFileLock } from "../infra/filelock.ts";
+import { gitToplevel } from "../infra/git.ts";
+import { repoDir } from "../infra/paths.ts";
+import { ensurePrivateDir, readVersioned, writeJsonAtomic } from "../infra/store.ts";
+
+// Plan 23: the gate environment a repo's verifier and preflight need (DOCKER_HOST, HTTPS_PROXY, a
+// TESTCONTAINERS_* setting), kept beside the repo's knowledge.md, so no verifier sets it up by hand. A value is
+// stored as is; a secret is stored by reference only: the name of the env var that holds it, read when a
+// role or a check starts, never written to disk.
+
+const GATE_ENV_SCHEMA = 1;
+
+const EntrySchema = z.union([z.strictObject({ value: z.string() }), z.strictObject({ from: z.string() })]);
+export type GateEnvEntry = z.infer<typeof EntrySchema>;
+
+const GateEnvSchema = z.looseObject({
+  schema: z.literal(GATE_ENV_SCHEMA),
+  vars: z.record(z.string(), EntrySchema),
+});
+type GateEnvFile = z.infer<typeof GateEnvSchema>;
+
+/** `<data>/repos/<repo key>/gate-env.json`, beside knowledge.md and gates.jsonl. */
+export const gateEnvFile = (toplevel: string): string => join(repoDir(toplevel), "gate-env.json");
+
+const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
+/** A name a secret goes by: such a variable is set by reference (--from), never by value. */
+const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;
+
+/** The repo's gate environment, by name; empty when none is set. */
+export function readGateEnv(toplevel: string): Record<string, GateEnvEntry> {
+  const file = gateEnvFile(toplevel);
+  if (!existsSync(file)) return {};
+  return readVersioned<GateEnvFile>(file, GateEnvSchema, GATE_ENV_SCHEMA).vars;
+}
+
+async function top(repo: string): Promise<string> {
+  const t = await gitToplevel(repo);
+  if (!t)
+    throw new CatherdError("E_IO_PATH", `${repo} is not inside a git repository`, {
+      fix: "pass the path of the repository",
+    });
+  return t;
+}
+
+function assertName(name: string): void {
+  if (!NAME.test(name))
+    throw new CatherdError("E_INPUT_INVALID", `"${name}" is not an env var name`, {
+      fix: "use letters, digits and _, not starting with a digit, e.g. DOCKER_HOST",
+    });
+}
+
+async function update(
+  repo: string,
+  change: (vars: Record<string, GateEnvEntry>) => void,
+): Promise<{ repo: string; vars: Record<string, GateEnvEntry> }> {
+  const t = await top(repo);
+  const file = gateEnvFile(t);
+  ensurePrivateDir(repoDir(t));
+  return withFileLock(file, () => {
+    const vars = { ...readGateEnv(t) };
+    change(vars);
+    writeJsonAtomic(file, { schema: GATE_ENV_SCHEMA, vars } satisfies GateEnvFile);
+    return { repo: t, vars };
+  });
+}
+
+/**
+ * Sets one variable of the repo's gate environment: a value, or `from`, the name of the env var that holds a
+ * secret. A secret-looking name (…KEY, …TOKEN, …PASSWORD) takes `from` only, so no secret lands on disk.
+ */
+export async function setGateEnv(
+  repo: string,
+  name: string,
+  entry: GateEnvEntry,
+): Promise<{ repo: string; vars: Record<string, GateEnvEntry> }> {
+  assertName(name);
+  if ("from" in entry) assertName(entry.from);
+  else if (SECRET_NAME.test(name))
+    throw new CatherdError(
+      "E_INPUT_INVALID",
+      `${name} looks like a secret: catherd stores it by reference only`,
+      {
+        fix: `export it in your shell, then: catherd knowledge env set ${name} --from <the env var that holds it>`,
+      },
+    );
+  return update(repo, (vars) => {
+    vars[name] = entry;
+  });
+}
+
+/** Removes one variable; refused when it is not set. */
+export function removeGateEnv(
+  repo: string,
+  name: string,
+): Promise<{ repo: string; vars: Record<string, GateEnvEntry> }> {
+  return update(repo, (vars) => {
+    if (!(name in vars))
+      throw new CatherdError("E_INPUT_INVALID", `${name} is not in the gate environment`, {
+        fix: "catherd knowledge env list shows what is set",
+      });
+    delete vars[name];
+  });
+}
+
+/** The variables as briefs show them: `NAME=value`, a reference as `NAME=$FROM`. */
+export const gateEnvLines = (vars: Record<string, GateEnvEntry>): string[] =>
+  Object.entries(vars)
+    .sort(([a], [b]) => a.localeCompare(b))
+    .map(([k, e]) => ("from" in e ? `${k}=${e.from}` : `${k}=${e.value}`));
+
+/** The literal values, for a spec written to disk; references stay names (`refs`), resolved at spawn. */
+export function gateEnvParts(vars: Record<string, GateEnvEntry>): {
+  values: Record<string, string>;
+  refs: Record<string, string>;
+} {
+  const values: Record<string, string> = {};
+  const refs: Record<string, string> = {};
+  for (const [k, e] of Object.entries(vars)) {
+    if ("from" in e) refs[k] = e.from;
+    else values[k] = e.value;
+  }
+  return { values, refs };
+}
+
+/**
+ * The env the gate environment adds to `base`: its values, and each reference read from `base`, else from
+ * `fallback` (the login env); a reference neither holds is left out, and named in `missing`.
+ */
+export function resolveGateEnv(
+  vars: Record<string, GateEnvEntry>,
+  base: Record<string, string | undefined>,
+  fallback: () => Record<string, string | undefined> = () => ({}),
+): { env: Record<string, string>; missing: string[] } {
+  const { values, refs } = gateEnvParts(vars);
+  return resolveRefs(values, refs, base, fallback);
+}
+
+/** `values` plus each of `refs` (name → the env var holding it) read from `base`, else `fallback`. */
+export function resolveRefs(
+  values: Record<string, string>,
+  refs: Record<string, string>,
+  base: Record<string, string | undefined>,
+  fallback: () => Record<string, string | undefined> = () => ({}),
+): { env: Record<string, string>; missing: string[] } {
+  const env = { ...values };
+  const missing: string[] = [];
+  let login: Record<string, string | undefined> | null = null;
+  for (const [k, from] of Object.entries(refs)) {
+    const v = base[from] ?? (login ??= fallback())[from];
+    if (v === undefined) missing.push(k);
+    else env[k] = v;
+  }
+  return { env, missing };
+}
diff --git a/test/entry/knowledge-command.test.ts b/test/entry/knowledge-command.test.ts
index 7ecad26..de92ec1 100644
--- a/test/entry/knowledge-command.test.ts
+++ b/test/entry/knowledge-command.test.ts
@@ -92,3 +92,33 @@ describe("catherd knowledge", () => {
     expect((await knowledgeLines(repo)).lines).toEqual([]);
   });
 });
+
+describe("catherd knowledge env (plan 23)", () => {
+  it("sets a value or a reference, lists them, and removes one", () => {
+    withHome();
+    const repo = tempRepo();
+    expect(catherd(["env", "list", "--repo", repo]).out).toBe(
+      "catherd: no gate environment set for this repo\n",
+    );
+    expect(catherd(["env", "set", "DOCKER_HOST=unix:///var/run/docker.sock", "--repo", repo]).code).toBe(0);
+    const set = catherd(["env", "set", "GITLAB_TOKEN", "--from", "MY_TOKEN", "--repo", repo]);
+    expect(set).toEqual({
+      code: 0,
+      out: "DOCKER_HOST=unix:///var/run/docker.sock\nGITLAB_TOKEN=$MY_TOKEN\n",
+      err: "",
+    });
+    const json = JSON.parse(catherd(["env", "list", "--json", "--repo", repo]).out);
+    expect(json).toEqual({
+      repo,
+      vars: {
+        DOCKER_HOST: { value: "unix:///var/run/docker.sock" },
+        GITLAB_TOKEN: { from: "MY_TOKEN" },
+      },
+    });
+    expect(catherd(["env", "rm", "DOCKER_HOST", "--repo", repo]).out).toBe("GITLAB_TOKEN=$MY_TOKEN\n");
+    const secret = catherd(["env", "set", "GITLAB_TOKEN=glpat-x", "--repo", repo]);
+    expect(secret.code).toBe(2);
+    expect(secret.err).toStartWith("error E_INPUT_INVALID: GITLAB_TOKEN looks like a secret");
+    expect(catherd(["env", "set", "NOVALUE", "--repo", repo]).err).toStartWith("error E_INPUT_INVALID:");
+  });
+});
diff --git a/test/services/gate-env.test.ts b/test/services/gate-env.test.ts
new file mode 100644
index 0000000..dbe4be0
--- /dev/null
+++ b/test/services/gate-env.test.ts
@@ -0,0 +1,113 @@
+import { afterEach, describe, expect, it } from "bun:test";
+import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
+import { join } from "node:path";
+import { isCatherdError } from "../../src/domain/errors.ts";
+import { loginEnv, parseEnv, resetLoginEnv } from "../../src/infra/login-env.ts";
+import { admit } from "../../src/services/admission.ts";
+import {
+  gateEnvFile,
+  gateEnvLines,
+  readGateEnv,
+  removeGateEnv,
+  resolveGateEnv,
+  setGateEnv,
+} from "../../src/services/gate-env.ts";
+import { snapshotEnv, tempDir } from "../helpers.ts";
+import { simPath, withScenario } from "../sim/scenario.ts";
+import { fakeDeps, freshRun, testView } from "./helpers.ts";
+
+afterEach(snapshotEnv());
+afterEach(resetLoginEnv);
+
+describe("the gate environment (plan 23)", () => {
+  it("keeps values and references beside knowledge.md, one name each, and removes them", async () => {
+    const { repo } = freshRun();
+    await setGateEnv(repo, "DOCKER_HOST", { value: "unix:///Users/me/.orbstack/run/docker.sock" });
+    await setGateEnv(repo, "HTTPS_PROXY", { value: "http://proxy:3128" });
+    await setGateEnv(repo, "GITLAB_TOKEN", { from: "MY_GITLAB_TOKEN" });
+    expect(gateEnvLines(readGateEnv(repo))).toEqual([
+      "DOCKER_HOST=unix:///Users/me/.orbstack/run/docker.sock",
+      "GITLAB_TOKEN=$MY_GITLAB_TOKEN",
+      "HTTPS_PROXY=http://proxy:3128",
+    ]);
+    expect(statSync(gateEnvFile(repo)).mode & 0o777).toBe(0o600);
+    await removeGateEnv(repo, "HTTPS_PROXY");
+    expect(Object.keys(readGateEnv(repo))).toEqual(["DOCKER_HOST", "GITLAB_TOKEN"]);
+  });
+
+  it("refuses a secret-looking name by value, a bad name, and removing what is not set", async () => {
+    const { repo } = freshRun();
+    for (const call of [
+      () => setGateEnv(repo, "NPM_TOKEN", { value: "npm_abc" }),
+      () => setGateEnv(repo, "1BAD", { value: "x" }),
+      () => setGateEnv(repo, "OK", { from: "not a name" }),
+      () => removeGateEnv(repo, "NOPE"),
+    ]) {
+      const e = await call().then(
+        () => null,
+        (x: unknown) => x,
+      );
+      expect(isCatherdError(e) && e.code).toBe("E_INPUT_INVALID");
+    }
+    expect(existsSync(gateEnvFile(repo))).toBe(false);
+  });
+
+  it("resolves a reference from the env, else the login env, and names one neither holds", () => {
+    const vars = {
+      A: { value: "1" },
+      B: { from: "SRC_B" },
+      C: { from: "SRC_C" },
+      D: { from: "SRC_D" },
+    };
+    expect(resolveGateEnv(vars, { SRC_B: "b" }, () => ({ SRC_C: "c" }))).toEqual({
+      env: { A: "1", B: "b", C: "c" },
+      missing: ["D"],
+    });
+  });
+
+  it("puts the gate env into a verifier's spec, a secret by reference only, and none into a worker's", async () => {
+    const { repo, run } = freshRun();
+    Object.assign(process.env, withScenario({ reply: "VERDICT: PASS" }).env);
+    process.env.PATH = simPath();
+    await setGateEnv(repo, "DOCKER_HOST", { value: "unix:///tmp/docker.sock" });
+    await setGateEnv(repo, "HTTPS_PROXY", { from: "MY_PROXY" });
+    const view = testView();
+    view.roles.verifier = { enabled: true, access: "full", rungs: ["codex:gpt-6-sol#high"] };
+    const deps = fakeDeps({ view });
+    const base = { brief: "b", rung: "codex:gpt-6-sol#high", thread: null, lane: null, failoverFrom: null };
+    const v = await admit(deps, run, { ...base, role: "verifier", name: "verifier-M1" });
+    const spec = JSON.parse(readFileSync(v.specPath, "utf8"));
+    expect(spec.env.DOCKER_HOST).toBe("unix:///tmp/docker.sock");
+    expect(spec.env.HTTPS_PROXY).toBeUndefined();
+    expect(spec.envFrom).toEqual({ HTTPS_PROXY: "MY_PROXY" });
+    const w = await admit(deps, run, { ...base, role: "reviewer", name: "reviewer-M1" });
+    const plain = JSON.parse(readFileSync(w.specPath, "utf8"));
+    expect(plain.env.DOCKER_HOST).toBeUndefined();
+    expect(plain.envFrom).toBeUndefined();
+  });
+});
+
+describe("the login environment (plan 23)", () => {
+  it("is what $SHELL -lc env prints, captured once, without catherd's secrets", () => {
+    const dir = tempDir("catherd-shell-");
+    const shell = join(dir, "fake-shell");
+    const count = join(dir, "count");
+    writeFileSync(
+      shell,
+      `#!/bin/sh\necho x >> "${count}"\nprintf 'DOCKER_HOST=unix:///run/user/1000/docker.sock\\0TYPESAFE_API_KEY=tsk\\0MULTI=a\\nb\\0'\n`,
+    );
+    chmodSync(shell, 0o755);
+    process.env.SHELL = shell;
+    resetLoginEnv();
+    expect(loginEnv()).toEqual({ DOCKER_HOST: "unix:///run/user/1000/docker.sock", MULTI: "a\nb" });
+    loginEnv();
+    expect(readFileSync(count, "utf8")).toBe("x\n");
+  });
+
+  it("is empty when the shell fails, and reads plain env lines too", () => {
+    process.env.SHELL = "/nonexistent/shell";
+    resetLoginEnv();
+    expect(loginEnv()).toEqual({});
+    expect(parseEnv("A=1\nB=x=y\n")).toEqual({ A: "1", B: "x=y" });
+  });
+});
```

### Task 7: preflight in the login environment, its new classes, and the lint warning

**Scratch commit:** `e8f87d9` — `feat(preflight): login env, environment and lock-busy classes, unlanded lanes, lint warnings`

**Files:** modify `src/services/preflight.ts`, `src/infra/heavy-lock.ts`, `src/infra/env.ts`, `src/entry/mcp/lane-tools.ts`, `plugin/skills/catherd/SKILL.md`, `test/services/preflight.test.ts`.

**Consumes:** Task 6's `loginEnv`, `readGateEnv`, `resolveGateEnv`; `landedMilestones`. **Produces (Rulings 13–16):**
- `withHeavySlotWithin(slots, waitMs, fn, o?) → { busy: false; value } | { busy: true }` in `heavy-lock.ts` (`withHeavySlot` now calls it with an unbounded wait).
- `checkEnv` also passes the toolchain variables (`TOOL_ENV_PATTERN`).
- `preflight.ts`: `PreflightOutcome` adds `"lock-busy"`; the report adds `warnings: string[]`; `runCheck(repo, check, timeoutMs, env?)`; `environmentLine(tail)`; `classify` (timeout/126/127 → cannot-start; an empty pnpm filter → skipped; 0 → pass; an environment line → cannot-start; else fails-as-expected); notes `environment: <line>`, `the pnpm filter matches no package yet…`; `preflightLimits = { lockWaitMs: 60_000 }`; `checkEnvFor(repo)`; `repoLinter(repo)`; `preflight({ …, milestone? })` runs the lanes of `milestone`, else of milestones not landed.
- The MCP `preflight` takes `milestone` and describes the new classes and `warnings`; SKILL.md step 4 lists them.

- [ ] **Step 1: the failing tests.** The five new tests in `test/services/preflight.test.ts` ("calls an environment error cannot-start…", "runs only the lanes of milestones not landed…", "reports lock-busy…", "runs a check in the login env and the repo's gate env…", "warns about a fast check with no lint step…"). They fail.
- [ ] **Step 2: the code.** Apply the source hunks.
- [ ] **Step 3:** `bun test test/services/preflight.test.ts test/infra test/entry/lock-command.test.ts test/skills.test.ts test/plugin.test.ts`; `bun run typecheck && bun run lint && bun run format:check`.
- [ ] **Step 4: commit** `feat(preflight): login env, environment and lock-busy classes, unlanded lanes, lint warnings`.

```diff
diff --git a/plugin/skills/catherd/SKILL.md b/plugin/skills/catherd/SKILL.md
index 7249fbf..abac99a 100644
--- a/plugin/skills/catherd/SKILL.md
+++ b/plugin/skills/catherd/SKILL.md
@@ -45,7 +45,7 @@ Pass the actual project `repo` explicitly to profile, setup and catalog tools th
 | `run_start(repo, title, a_lines)`                                                                     | Once per project. Returns `run`, the id every other call takes, `dir`, the run folder `R`, and `protocol`: the next step of the milestone loop and its six-line checklist                                                                                                                                        |
 | `peek(run?, name?)`                                                                                   | Never waits. Per run: the open owner questions first (the owner's to answer), each live role with its rung, time and last event, every finished record not yet read, the next step, the verifier's step, and `protocol` (the milestone loop's next step and the checklist). It marks nothing read: `result` does |
 | `route(run, lane_file?, role?)`                                                                       | A lane's rung (from Jev, else the lane file's `Kind:`/`Difficulty:`, else the profile), or a role's rung. Returns `rung`, `ladder`, `backend`, `agent`                                                                                                                                                           |
-| `preflight(run, confirmed?)`                                                                          | Each lane's fast check once, before any lane runs. Outcomes below                                                                                                                                                                                                                                                |
+| `preflight(run, confirmed?, milestone?)`                                                              | Each lane's fast check once, before any lane runs. Outcomes below                                                                                                                                                                                                                                                |
 | `dispatch(run, role, name, brief, rung, thread?, lane?, next?)`                                       | Starts one process role (Codex, claude-code or opencode) and returns at launch, in about a second, with `dispatched`. It routes a lane not routed yet, appends the role's reply contract to the brief, and its result arrives as a catherd message                                                               |
 | `result(run, name)`                                                                                   | A role's latest reply, capped, its record and its `hints`; reading a finished record marks it read                                                                                                                                                                                                               |
 | `cancel(run, name)`                                                                                   | Stops a live role and returns its record, `cancelled`, and `hints`                                                                                                                                                                                                                                               |
@@ -254,8 +254,11 @@ Nothing else pushes: a phone that buzzes for progress teaches the user to ignore
 4. **Route and preflight.** `route(run, "lanes/Mx.Ly.md")` for every lane, one call per lane; each may wait up to 25 s on Jev (`dispatch` routes a lane you missed, and starts it at the routed rung when yours is off its ladder). `route`, `preflight` and `dispatch` refuse a lane whose `Kind:` or `Difficulty:` the catalog does not know (`E_LANE_INVALID`). Then, once every lane file exists, `preflight(run)` once, before dispatching any lane. Each lane comes back as one of:
    - `pass`: the check already passes on the base tree;
    - `fails-as-expected`: it runs and fails, because the lane has not been done yet;
-   - `skipped`: it checks a file the lane creates;
-   - `cannot-start`: it could not even run (a missing command, exit 126 or 127, a 120 s timeout, or no `Fast check:` line). Only this blocks: fix that lane's check, or ask the architect to, and run `preflight` again.
+   - `skipped`: it checks a file the lane creates, or a pnpm filter that matches no package yet;
+   - `cannot-start`: it could not even run (a missing command, exit 126 or 127, a 120 s timeout, no `Fast check:` line, or an environment error its note names: no Docker at `DOCKER_HOST`, DNS, a denied permission). Only this blocks: fix that lane's check, or the environment (`catherd knowledge env set` for the repo's gate environment), and run `preflight` again;
+   - `lock-busy`: other checks held every heavy slot for 60 s; run `preflight` again later.
+
+   Preflight runs in your login environment and only the lanes of milestones not landed yet (`milestone` names one). Its `warnings` name a lane whose fast check runs no linter while the repo has one: add the linter of every package the lane touches.
 
    When it returns `needsConfirmation: true`, the profile wants the user to see the commands first: show them the `commands`, and on their yes call `preflight(run, confirmed: true)`.
 
diff --git a/src/entry/mcp/lane-tools.ts b/src/entry/mcp/lane-tools.ts
index 00a23a9..2b958d4 100644
--- a/src/entry/mcp/lane-tools.ts
+++ b/src/entry/mcp/lane-tools.ts
@@ -27,10 +27,14 @@ export function registerLaneTools(server: McpServer, deps: Deps): void {
     "preflight",
     {
       description:
-        "Run each lane's fast check once, on the base tree, behind the heavy-command lock, with a 120 s timeout. Each lane is pass, fails-as-expected, skipped (it checks a file the lane creates) or cannot-start; only cannot-start blocks. When the profile asks for confirmation, the first call returns the commands to show the user; call again with confirmed: true. Refused with E_LANE_INVALID, running nothing, while any lane's Kind: or Difficulty: is not one the catalog knows.",
-      inputSchema: { run: z.string(), confirmed: z.boolean().optional() },
+        "Run each lane's fast check once, on the base tree, behind the heavy-command lock, with a 120 s timeout, in the user's login environment plus the repo's gate environment (catherd knowledge env). By default only the lanes of milestones not landed yet; milestone names one. Each lane is pass, fails-as-expected, skipped (it checks a file the lane creates, or a pnpm filter that matches no package yet), cannot-start (a missing command, a timeout, or an environment error: no Docker, DNS, a denied permission; its note says which) or lock-busy (no heavy slot came free within 60 s: run it again); only cannot-start blocks. warnings names each lane whose fast check runs no linter while the repo has one. When the profile asks for confirmation, the first call returns the commands to show the user; call again with confirmed: true. Refused with E_LANE_INVALID, running nothing, while any lane's Kind: or Difficulty: is not one the catalog knows.",
+      inputSchema: {
+        run: z.string(),
+        confirmed: z.boolean().optional(),
+        milestone: z.string().regex(ID_PATTERN).optional(),
+      },
     },
-    (a) => handle(() => preflight(deps, { run: a.run, confirmed: a.confirmed })),
+    (a) => handle(() => preflight(deps, { run: a.run, confirmed: a.confirmed, milestone: a.milestone })),
   );
 
   server.registerTool(
diff --git a/src/infra/env.ts b/src/infra/env.ts
index 144a070..d384309 100644
--- a/src/infra/env.ts
+++ b/src/infra/env.ts
@@ -62,11 +62,18 @@ const CHECK_ENV = new Set([
   "CATHERD_LOCK_SLOTS",
 ]);
 const CHECK_ENV_PATTERN = /^(LC_[A-Z_]+|XDG_[A-Z_]+_(HOME|DIR|DIRS))$/;
+/**
+ * Plan 23: where the toolchains a check runs find their daemon, proxy and caches (DOCKER_HOST for OrbStack or
+ * rootless Docker, a proxy, Go's and pnpm's caches); without them a check that would run fails as if broken.
+ */
+const TOOL_ENV_PATTERN =
+  /^(DOCKER_(HOST|CONTEXT|CONFIG|CERT_PATH|TLS_VERIFY)|TESTCONTAINERS_[A-Z_]+|(HTTPS?|NO|ALL)_PROXY|(https?|no|all)_proxy|GO(PATH|CACHE|MODCACHE|FLAGS|PROXY|PRIVATE|NOSUMDB|TOOLCHAIN)|PNPM_HOME|npm_config_store_dir|BUN_INSTALL(_CACHE_DIR)?|NVM_DIR|JAVA_HOME|CARGO_HOME|RUSTUP_HOME)$/;
 
 /** A strict allowlist of `base` plus PWD, for lane-authored shell text such as preflight checks. */
 export function checkEnv(base: Record<string, string | undefined>, cwd: string): Record<string, string> {
   const env: Record<string, string> = {};
   for (const [k, v] of Object.entries(base))
-    if (v !== undefined && (CHECK_ENV.has(k) || CHECK_ENV_PATTERN.test(k))) env[k] = v;
+    if (v !== undefined && (CHECK_ENV.has(k) || CHECK_ENV_PATTERN.test(k) || TOOL_ENV_PATTERN.test(k)))
+      env[k] = v;
   return { ...env, PWD: cwd };
 }
diff --git a/src/infra/heavy-lock.ts b/src/infra/heavy-lock.ts
index 923122d..01e8b89 100644
--- a/src/infra/heavy-lock.ts
+++ b/src/infra/heavy-lock.ts
@@ -19,18 +19,36 @@ export async function withHeavySlot<T>(
   fn: (slot: number) => T | Promise<T>,
   o: { pollMs?: number } = {},
 ): Promise<T> {
+  const r = await withHeavySlotWithin(slots, Number.POSITIVE_INFINITY, fn, o);
+  if (r.busy) throw new Error("unreachable: an unbounded wait never gives up");
+  return r.value;
+}
+
+/**
+ * withHeavySlot with a wait budget (plan 23): `{ busy: true }` when no slot came free within `waitMs`, so a
+ * caller with a deadline of its own (preflight) reports the lock as busy instead of timing out behind it.
+ */
+export async function withHeavySlotWithin<T>(
+  slots: number,
+  waitMs: number,
+  fn: (slot: number) => T | Promise<T>,
+  o: { pollMs?: number } = {},
+): Promise<{ busy: false; value: T } | { busy: true }> {
   const dir = locksDir();
   ensurePrivateDir(dir);
+  const deadline = Date.now() + waitMs;
   for (;;) {
     for (let i = 0; i < slots; i++) {
       const release = tryLock(join(dir, `slot-${i}`));
       if (!release) continue;
       try {
-        return await fn(i);
+        return { busy: false, value: await fn(i) };
       } finally {
         release();
       }
     }
-    await Bun.sleep(o.pollMs ?? 500);
+    const left = deadline - Date.now();
+    if (left <= 0) return { busy: true };
+    await Bun.sleep(Math.min(o.pollMs ?? 500, left));
   }
 }
diff --git a/src/services/preflight.ts b/src/services/preflight.ts
index a914082..006426e 100644
--- a/src/services/preflight.ts
+++ b/src/services/preflight.ts
@@ -3,14 +3,17 @@ import { join } from "node:path";
 import { CatherdError, errorMessage } from "../domain/errors.ts";
 import { assertLaneHeader, LANE_HEADER_FIX, parseLaneHeader } from "../domain/lane.ts";
 import { checkEnv } from "../infra/env.ts";
-import { heavySlots, withHeavySlot } from "../infra/heavy-lock.ts";
+import { heavySlots, withHeavySlotWithin } from "../infra/heavy-lock.ts";
+import { loginEnv } from "../infra/login-env.ts";
 import { killGroup } from "../infra/proc.ts";
+import { readGateEnv, resolveGateEnv } from "./gate-env.ts";
+import { landedMilestones } from "./milestones.ts";
 import type { Deps } from "./ports.ts";
 import { TAIL_LINES } from "./run-debug.ts";
 import { findRun, type Run, runPaths } from "./run-store.ts";
 
-/** Spec §4.7. Only `cannot-start` blocks the run. */
-export type PreflightOutcome = "pass" | "fails-as-expected" | "skipped" | "cannot-start";
+/** Spec §4.7. Only `cannot-start` blocks the run; `lock-busy` (plan 23) means: run preflight again. */
+export type PreflightOutcome = "pass" | "fails-as-expected" | "skipped" | "cannot-start" | "lock-busy";
 
 interface PreflightResult {
   lane: string;
@@ -28,6 +31,8 @@ export type PreflightReport =
       commands: { lane: string; check: string | null }[];
       results: PreflightResult[];
       blocked: boolean;
+      /** plan 23: lanes whose fast check runs no linter while the repo has one */
+      warnings: string[];
     };
 
 const CHECK_TIMEOUT_MS = 120_000;
@@ -116,10 +121,11 @@ export async function runCheck(
   repo: string,
   check: string,
   timeoutMs: number,
+  env: Record<string, string> = checkEnv(process.env, repo),
 ): Promise<{ code: number | null; timedOut: boolean; tail: string[] }> {
   const p = Bun.spawn(["sh", "-c", check], {
     cwd: repo,
-    env: checkEnv(process.env, repo),
+    env,
     stdin: "ignore",
     stdout: "pipe",
     stderr: "pipe",
@@ -153,10 +159,88 @@ export async function runCheck(
   }
 }
 
+/**
+ * Plan 23: a check that failed on the machine, not on the code: no Docker (or none at DOCKER_HOST), no DNS, a
+ * permission the sandbox or the OS denied. Such a check cannot start; it never fails as expected.
+ */
+const ENVIRONMENT = [
+  /command not found/i,
+  /Cannot connect to the Docker daemon/i,
+  /rootless Docker not found/i,
+  /Could not find a valid Docker environment/i,
+  /docker\.sock: connect: no such file or directory/i,
+  /Temporary failure in name resolution|Could not resolve host|no such host|Name or service not known|nodename nor servname|getaddrinfo (ENOTFOUND|EAI_AGAIN)/i,
+  /permission denied|operation not permitted|\bEACCES\b|\bEPERM\b/i,
+];
+
+/** pnpm exits 0 on a `--filter` that matches no package: the lane creates it, so there is nothing to run yet. */
+const EMPTY_FILTER = /No projects matched the filters/i;
+
+/** The first tail line an ENVIRONMENT pattern matches, or null. */
+export const environmentLine = (tail: string[]): string | null =>
+  tail.find((l) => ENVIRONMENT.some((re) => re.test(l))) ?? null;
+
 export function classify(r: { code: number | null; timedOut: boolean; tail: string[] }): PreflightOutcome {
   if (r.timedOut || r.code === 126 || r.code === 127) return "cannot-start";
+  if (r.tail.some((l) => EMPTY_FILTER.test(l))) return "skipped";
   if (r.code === 0) return "pass";
-  return r.tail.some((l) => /command not found/i.test(l)) ? "cannot-start" : "fails-as-expected";
+  return environmentLine(r.tail) !== null ? "cannot-start" : "fails-as-expected";
+}
+
+/** Why a classified result says what it says, for its note. */
+function noteOf(
+  r: { code: number | null; timedOut: boolean; tail: string[] },
+  outcome: PreflightOutcome,
+  timeoutMs: number,
+): string | null {
+  if (r.timedOut) return `timed out after ${timeoutMs / 1000} s`;
+  if (outcome === "skipped") return "the pnpm filter matches no package yet; the lane creates it";
+  const env = outcome === "cannot-start" ? environmentLine(r.tail) : null;
+  return env ? `environment: ${env.trim()}` : null;
+}
+
+/** How long one check waits for a heavy slot before it reports lock-busy; tests shorten it. */
+export const preflightLimits = { lockWaitMs: 60_000 };
+
+/**
+ * Plan 23: a check runs in the user's login environment (DOCKER_HOST and the rest a login shell sets), through
+ * the allowlist, plus the repo's gate environment. A login PATH comes first, with the server's own after it.
+ */
+export function checkEnvFor(repo: string): Record<string, string> {
+  const login = loginEnv();
+  const base: Record<string, string | undefined> = { ...process.env, ...login };
+  const path = [
+    ...new Set([...(login.PATH ?? "").split(":"), ...(process.env.PATH ?? "").split(":")].filter(Boolean)),
+  ];
+  if (path.length) base.PATH = path.join(":");
+  return { ...checkEnv(base, repo), ...resolveGateEnv(readGateEnv(repo), base).env };
+}
+
+/** What a fast check names when it lints: a lint script, or a linter by name. */
+const LINT_STEP = /\b(lint|eslint|biome|oxlint|golangci-lint|ruff|clippy|vet|check)\b/i;
+
+/** Root files that say the repo has a linter, by the linter they configure. */
+const LINT_CONFIGS: [RegExp, string][] = [
+  [/^\.golangci\.(ya?ml|toml|json)$/, "golangci-lint"],
+  [/^(biome\.jsonc?)$/, "biome"],
+  [/^(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.[a-z]+)?)$/, "eslint"],
+  [/^\.?oxlintrc\.json$/, "oxlint"],
+  [/^\.?ruff\.toml$/, "ruff"],
+];
+
+/** The linter the repo has, by name, or null: a root lint config, or a `lint` script in package.json. */
+export function repoLinter(repo: string): string | null {
+  for (const name of existsSync(repo) ? readdirSync(repo) : [])
+    for (const [re, linter] of LINT_CONFIGS) if (re.test(name)) return linter;
+  try {
+    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
+      scripts?: Record<string, unknown>;
+    };
+    if (typeof pkg.scripts?.lint === "string") return "the lint script";
+  } catch {
+    // no package.json, or one that does not parse: no lint script
+  }
+  return null;
 }
 
 /**
@@ -165,11 +249,16 @@ export function classify(r: { code: number | null; timedOut: boolean; tail: stri
  */
 export async function preflight(
   deps: Deps,
-  i: { run: string; confirmed?: boolean; timeoutMs?: number },
+  i: { run: string; confirmed?: boolean; timeoutMs?: number; milestone?: string },
 ): Promise<PreflightReport> {
   const run = findRun(i.run);
   const profile = deps.profiles.forRepo(run.meta.repo);
-  const lanes = laneChecks(run);
+  // plan 23: one milestone's lanes, or by default every lane whose milestone has not landed
+  const landed = new Set(landedMilestones(run));
+  const milestoneOf = (lane: string) => lane.split(".")[0] as string;
+  const lanes = laneChecks(run).filter((l) =>
+    i.milestone ? milestoneOf(l.lane) === i.milestone : !landed.has(milestoneOf(l.lane)),
+  );
   // spec 1.1 §6: refuse before running anything, naming every lane whose header the catalog cannot route
   const invalid = lanes.flatMap((l) => (l.invalid ? [l.invalid] : []));
   if (invalid.length) throw new CatherdError("E_LANE_INVALID", invalid.join("; "), { fix: LANE_HEADER_FIX });
@@ -177,6 +266,8 @@ export async function preflight(
   if (profile.preflight.confirm && !i.confirmed) return { needsConfirmation: true, commands };
   const timeoutMs = i.timeoutMs ?? CHECK_TIMEOUT_MS;
   const results: PreflightResult[] = [];
+  // the login env is captured once per server; the gate env is read once per preflight
+  let env: Record<string, string> | undefined;
   for (const l of lanes) {
     const check = l.check;
     if (!check) {
@@ -202,20 +293,43 @@ export async function preflight(
       results.push({ lane: l.lane, check, outcome: "skipped", exitCode: null, tail: [], note });
       continue;
     }
-    const r = await withHeavySlot(heavySlots(profile.heavy), () => runCheck(run.meta.repo, check, timeoutMs));
+    env ??= checkEnvFor(run.meta.repo);
+    const checkEnvironment = env;
+    // plan 23: each check waits for its slot within its own budget, and says lock-busy past it
+    const slot = await withHeavySlotWithin(heavySlots(profile.heavy), preflightLimits.lockWaitMs, () =>
+      runCheck(run.meta.repo, check, timeoutMs, checkEnvironment),
+    );
+    if (slot.busy) {
+      const note = `every heavy slot stayed busy for ${preflightLimits.lockWaitMs / 1000} s (other lanes' checks); run preflight again when they finish`;
+      results.push({ lane: l.lane, check, outcome: "lock-busy", exitCode: null, tail: [], note });
+      continue;
+    }
+    const r = slot.value;
+    const outcome = classify(r);
     results.push({
       lane: l.lane,
       check,
-      outcome: classify(r),
+      outcome,
       exitCode: r.code,
       tail: r.tail,
-      note: r.timedOut ? `timed out after ${timeoutMs / 1000} s` : null,
+      note: noteOf(r, outcome, timeoutMs),
     });
   }
+  // plan 23: lint reaches the worker only through its fast check
+  const linter = repoLinter(run.meta.repo);
+  const warnings = linter
+    ? lanes
+        .filter((l) => l.check && !LINT_STEP.test(l.check))
+        .map(
+          (l) =>
+            `${l.lane}: its fast check runs no linter, and the repo has one (${linter}): add the linter of every package the lane touches to its Fast check: line`,
+        )
+    : [];
   return {
     needsConfirmation: false,
     commands,
     results,
     blocked: results.some((r) => r.outcome === "cannot-start"),
+    warnings,
   };
 }
diff --git a/test/services/preflight.test.ts b/test/services/preflight.test.ts
index 933a6b5..6e8aa6b 100644
--- a/test/services/preflight.test.ts
+++ b/test/services/preflight.test.ts
@@ -1,10 +1,19 @@
 import { afterEach, beforeEach, describe, expect, it } from "bun:test";
-import { existsSync, mkdirSync, writeFileSync } from "node:fs";
+import { appendFileSync, chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
 import { join } from "node:path";
 import { tryLock } from "../../src/infra/filelock.ts";
+import { resetLoginEnv } from "../../src/infra/login-env.ts";
 import { locksDir } from "../../src/infra/paths.ts";
-import { classify, preflight, preflightUser, runCheck } from "../../src/services/preflight.ts";
-import { snapshotEnv } from "../helpers.ts";
+import { setGateEnv } from "../../src/services/gate-env.ts";
+import {
+  classify,
+  preflight,
+  preflightLimits,
+  preflightUser,
+  runCheck,
+} from "../../src/services/preflight.ts";
+import { runPaths } from "../../src/services/run-store.ts";
+import { snapshotEnv, tempDir } from "../helpers.ts";
 import { fakeDeps, freshRun, testView, writeLane } from "./helpers.ts";
 
 afterEach(snapshotEnv());
@@ -142,4 +151,92 @@ describe("preflight", () => {
     expect(classify({ code: 126, timedOut: false, tail: [] })).toBe("cannot-start");
     expect(classify({ code: 2, timedOut: false, tail: ["1 failing"] })).toBe("fails-as-expected");
   });
+
+  it("calls an environment error cannot-start, never fails-as-expected (plan 23)", () => {
+    for (const line of [
+      "panic: rootless Docker not found",
+      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
+      "dial tcp: lookup proxy.golang.org: no such host",
+      "curl: (6) Could not resolve host: registry.npmjs.org",
+      "open /Users/me/Library/Caches/go-build/ab: operation not permitted",
+    ])
+      expect(classify({ code: 1, timedOut: false, tail: ["--- FAIL", line] })).toBe("cannot-start");
+    // pnpm passes an empty filter: nothing to run yet
+    expect(classify({ code: 0, timedOut: false, tail: ['No projects matched the filters in "/repo"'] })).toBe(
+      "skipped",
+    );
+  });
+
+  it("runs only the lanes of milestones not landed, or the milestone named (plan 23)", async () => {
+    const { run } = freshRun();
+    writeLane(run, "M1.L1", ["src/a.ts"], "true");
+    writeLane(run, "M2.L1", ["src/b.ts"], "true");
+    writeLane(run, "M2.L2", ["src/c.ts"], "true");
+    appendFileSync(runPaths(run.dir).ledger, "M1 | w | abc1234 | 3 | ok\n");
+    expect(outcomes(await preflight(fakeDeps(), { run: run.id }))).toEqual([
+      ["M2.L1", "pass"],
+      ["M2.L2", "pass"],
+    ]);
+    expect(outcomes(await preflight(fakeDeps(), { run: run.id, milestone: "M1" }))).toEqual([
+      ["M1.L1", "pass"],
+    ]);
+  });
+
+  it("reports lock-busy when no heavy slot comes free within its wait budget (plan 23)", async () => {
+    const { run } = freshRun();
+    writeLane(run, "M1.L1", ["src/a.ts"], "true");
+    mkdirSync(locksDir(), { recursive: true });
+    const release = tryLock(join(locksDir(), "slot-0"));
+    const saved = preflightLimits.lockWaitMs;
+    preflightLimits.lockWaitMs = 100;
+    try {
+      const r = await preflight(fakeDeps({ view: testView({ heavy: 1 }) }), { run: run.id });
+      expect(outcomes(r)).toEqual([["M1.L1", "lock-busy"]]);
+      if (!r.needsConfirmation) expect(r.blocked).toBe(false);
+    } finally {
+      preflightLimits.lockWaitMs = saved;
+      release?.();
+    }
+  });
+
+  it("runs a check in the login env and the repo's gate env, and names the environment error (plan 23)", async () => {
+    const { repo, run } = freshRun();
+    const dir = tempDir("catherd-shell-");
+    const shell = join(dir, "login");
+    writeFileSync(shell, `#!/bin/sh\nprintf 'DOCKER_HOST=unix:///login/docker.sock\\0PATH=/login/bin\\0'\n`);
+    chmodSync(shell, 0o755);
+    process.env.SHELL = shell;
+    resetLoginEnv();
+    await setGateEnv(repo, "TESTCONTAINERS_RYUK_DISABLED", { value: "true" });
+    writeLane(
+      run,
+      "M1.L1",
+      ["src/a.ts"],
+      'test "$DOCKER_HOST" = unix:///login/docker.sock && test "$TESTCONTAINERS_RYUK_DISABLED" = true && echo "${PATH%%:*}"',
+    );
+    writeLane(run, "M1.L2", ["src/b.ts"], "echo 'Could not find a valid Docker environment' >&2; exit 1");
+    const r = await preflight(fakeDeps(), { run: run.id });
+    resetLoginEnv();
+    expect(outcomes(r)).toEqual([
+      ["M1.L1", "pass"],
+      ["M1.L2", "cannot-start"],
+    ]);
+    if (r.needsConfirmation) throw new Error("unexpected");
+    expect(r.results[0]?.tail).toEqual(["/login/bin"]);
+    expect(r.results[1]?.note).toBe("environment: Could not find a valid Docker environment");
+  });
+
+  it("warns about a fast check with no lint step when the repo has a linter (plan 23)", async () => {
+    const { repo, run } = freshRun();
+    writeLane(run, "M1.L1", ["src/a.ts"], "true");
+    writeLane(run, "M1.L2", ["src/b.ts"], "go test ./x/... && golangci-lint run ./x/...");
+    const none = await preflight(fakeDeps(), { run: run.id });
+    if (!none.needsConfirmation) expect(none.warnings).toEqual([]);
+    writeFileSync(join(repo, ".golangci.yml"), "linters: {}\n");
+    const r = await preflight(fakeDeps(), { run: run.id });
+    if (r.needsConfirmation) throw new Error("unexpected");
+    expect(r.warnings).toEqual([
+      "M1.L1: its fast check runs no linter, and the repo has one (golangci-lint): add the linter of every package the lane touches to its Fast check: line",
+    ]);
+  });
 });
```

### Task 8: the review step

**Scratch commit:** `f8bb2a3` — `feat(review): a partial review is not the milestone's review; open findings name the fix round`

**Files:** modify `src/services/milestones.ts`, `src/services/lane-service.ts`, `src/services/protocol.ts`, `src/services/run-store.ts`, `src/services/run-service.ts`, `src/entry/mcp/run-tools.ts`, `plugin/skills/catherd/SKILL.md`, `test/services/land-gate.test.ts`, `test/services/protocol.test.ts`.

**Consumes:** Task 5's files. **Produces (Rulings 17, 18):**
- `milestones.ts`: `milestoneReviewer` ignores a partial attempt; `partialReviewer(run, m, start?)` (the latest partial attempt when no full one stands); `countFindings(run, record)` (moved from `protocol.ts`'s `findingCounts`, which now calls it); `openFindings(run, m, start?) → { name; blocker; bug } | null`.
- `AgentRun.replyStatus?`; `recordAgentRun({ …, replyStatus? })`; `record_agent_run` takes `reply_status` (`complete|partial|blocked|refused`; Task 9 adds `flaky`).
- `land` refuses a partial review: "land <M>: <name> replied STATUS: partial, which is not the milestone's review", fix "dispatch a scoped second pass, reviewer-<M>-2, over the files <name> did not read…".
- `protocolNext`: `"<M>: <name> stopped partial: a scoped second pass (reviewer-<M>-2) over the files it did not read"`, and `"<M>: fix round for <name>'s findings (<n> BLOCKER, <n> BUG), then the verifier"` while findings are open.
- SKILL.md step 7: both bullets.

- [ ] **Step 1: the failing tests.** "refuses a partial review, and names the fix round while BLOCKER or BUG lines are open (plan 23)" (`protocol.test.ts`) and "refuses a native reviewer recorded with reply_status partial, until a full pass (plan 23)" (`land-gate.test.ts`). They fail.
- [ ] **Step 2: the code.** Apply the source hunks.
- [ ] **Step 3:** `bun test test/services/protocol.test.ts test/services/land-gate.test.ts test/skills.test.ts`; `bun run typecheck && bun run lint`.
- [ ] **Step 4: commit** `feat(review): a partial review is not the milestone's review; open findings name the fix round`.

```diff
diff --git a/plugin/skills/catherd/SKILL.md b/plugin/skills/catherd/SKILL.md
index abac99a..f07babc 100644
--- a/plugin/skills/catherd/SKILL.md
+++ b/plugin/skills/catherd/SKILL.md
@@ -269,6 +269,8 @@ Nothing else pushes: a phone that buzzes for progress teaches the user to ignore
    - A `violation: <paths>` hint means the role wrote outside its lane. Send those paths to the reviewer with the milestone; a lane that needs them gets an `Owns:` delta from the architect.
 6. **writer,** when the milestone changes docs. It starts once the workers are done.
 7. **reviewer,** named `reviewer-<M>`, once, over the whole milestone diff on a frozen tree.
+   - A reply of `STATUS: partial` (it read only part of the diff) is not the milestone's review: `land` refuses it, and `protocol.next` names a scoped second pass, `reviewer-<M>-2`, over the files it did not read. For a native reviewer, pass `reply_status` to `record_agent_run`.
+   - While its BLOCKER or BUG lines are open, `protocol.next` names the fix round, not the verifier.
    - **UI pass,** when the milestone touched a screen. List the changed files (`git diff --name-only <milestone base>`), map them to the screens that render them, and brief the UI reviewer on those screens only. You start the app first.
 8. **One fix round.** Send each lane's findings, verbatim, to its own worker thread, at its rung. A BLOCKER climbs a rung instead, on a fresh thread. Dispatch every lane's fix, then end your turn. Then resume the same reviewer thread, and it re-checks only the BLOCKER and BUG lines.
    - Before routing a finding that questions the plan, `ask(run, "finding", …)`. `design` goes to the architect: `SendMessage` to the same native Claude agent on Claude Code, or `dispatch` with its recorded process `thread` for its own delta, followed by `result`. Its delta rewrites the lane files.
diff --git a/src/entry/mcp/run-tools.ts b/src/entry/mcp/run-tools.ts
index 824fc5d..db78740 100644
--- a/src/entry/mcp/run-tools.ts
+++ b/src/entry/mcp/run-tools.ts
@@ -92,7 +92,7 @@ export function registerRunTools(server: McpServer, deps: Deps): void {
     "record_agent_run",
     {
       description:
-        'After every native Claude subagent (Agent tool) of a run, record what the Agent result reported: total_tokens and duration_ms. The budget counts it. Pass lane (e.g. M1.L1) when the subagent worked a lane, so its time counts toward that lane\'s kind in the catalog timings. status says how the subagent\'s work ended: for a verifier it is the verdict, so pass status: "failed" when its verdict is FAIL; only a PASS is recorded ok. For a verifier, pass verdict: the first line of its reply; a VERDICT: BLOCKED: environment — <probe> (status "failed") is then a blocker to surface to the owner, not a fix round.',
+        'After every native Claude subagent (Agent tool) of a run, record what the Agent result reported: total_tokens and duration_ms. The budget counts it. Pass lane (e.g. M1.L1) when the subagent worked a lane, so its time counts toward that lane\'s kind in the catalog timings. status says how the subagent\'s work ended: for a verifier it is the verdict, so pass status: "failed" when its verdict is FAIL; only a PASS is recorded ok. For a verifier, pass verdict: the first line of its reply; a VERDICT: BLOCKED: environment — <probe> (status "failed") is then a blocker to surface to the owner, not a fix round. Pass reply_status, the STATUS word its reply ends with: a reviewer that stopped partial is not the milestone review.',
       inputSchema: {
         run: z.string(),
         name: z.string().regex(ID_PATTERN),
@@ -104,6 +104,7 @@ export function registerRunTools(server: McpServer, deps: Deps): void {
         status: z.enum(["ok", "failed", "cancelled"]).default("ok"),
         lane: z.string().regex(ID_PATTERN).optional(),
         verdict: z.string().min(1).optional(),
+        reply_status: z.enum(["complete", "partial", "blocked", "refused"]).optional(),
       },
     },
     (a) =>
@@ -119,6 +120,7 @@ export function registerRunTools(server: McpServer, deps: Deps): void {
           costUsd: a.cost_usd,
           status: a.status,
           verdict: a.verdict,
+          replyStatus: a.reply_status,
         }),
       ),
   );
diff --git a/src/services/lane-service.ts b/src/services/lane-service.ts
index f099864..de4c473 100644
--- a/src/services/lane-service.ts
+++ b/src/services/lane-service.ts
@@ -27,6 +27,7 @@ import {
   fullCommit,
   milestoneFiles,
   milestoneStart,
+  partialReviewer,
   reviewerPassed,
   milestoneVerifier,
 } from "./milestones.ts";
@@ -272,6 +273,16 @@ async function gate(run: Run, m: string, commit: string, skip: LandSkip | undefi
     );
   }
   const start = milestoneStart(run, m);
+  // plan 23: a reviewer that stopped partial read part of the diff; that is not the milestone's review
+  const partial = partialReviewer(run, m, start);
+  if (partial)
+    throw new CatherdError(
+      "E_LAND_GATE",
+      `land ${m}: ${partial.name} replied STATUS: partial, which is not the milestone's review`,
+      {
+        fix: `dispatch a scoped second pass, reviewer-${m}-2, over the files ${partial.name} did not read (its reply names them), then land again`,
+      },
+    );
   // the latest verifier attempt, passed or not: a FAIL after a PASS undoes it
   const verdict = milestoneVerifier(run, m, start);
   // plan 23: a verdict on the machine is a blocker for the owner, never a fix round
diff --git a/src/services/milestones.ts b/src/services/milestones.ts
index 288fba7..4188484 100644
--- a/src/services/milestones.ts
+++ b/src/services/milestones.ts
@@ -50,27 +50,95 @@ export interface MilestoneReviewer {
   record: RunRecord | null;
 }
 
-/**
- * The milestone's latest passing reviewer since its lanes started: a dispatch named reviewer-<m>…, status
- * ok; or a record_agent_run row with role reviewer and the same name, status ok. Null when there is none.
- */
-export function milestoneReviewer(
+/** Every reviewer attempt of the milestone since its lanes started that ended ok, oldest first, partial or not. */
+function reviewerAttempts(
   run: Run,
   m: string,
-  start = milestoneStart(run, m),
-): MilestoneReviewer | null {
-  const found: MilestoneReviewer[] = [
+  start: string | null,
+): (MilestoneReviewer & { partial: boolean })[] {
+  return [
     ...readRecords(run)
       .records.filter((r) => reviewsMilestone(r.name, m) && r.status === "ok" && since(r.endedAt, start))
-      .map((r) => ({ name: r.name, at: r.endedAt, record: r })),
+      .map((r) => ({ name: r.name, at: r.endedAt, record: r, partial: r.replyStatus === "partial" })),
     ...readAgentRuns(run)
       .filter(
         (a) =>
           a.role === "reviewer" && reviewsMilestone(a.name, m) && a.status === "ok" && since(a.at, start),
       )
-      .map((a) => ({ name: a.name, at: a.at, record: null })),
-  ];
-  return found.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).at(-1) ?? null;
+      .map((a) => ({ name: a.name, at: a.at, record: null, partial: a.replyStatus === "partial" })),
+  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
+}
+
+/**
+ * The milestone's latest passing reviewer since its lanes started: a dispatch named reviewer-<m>…, status
+ * ok; or a record_agent_run row with role reviewer and the same name, status ok. A reply of STATUS: partial
+ * read only part of the diff and is not the milestone's review (plan 23). Null when there is none.
+ */
+export function milestoneReviewer(
+  run: Run,
+  m: string,
+  start = milestoneStart(run, m),
+): MilestoneReviewer | null {
+  const full = reviewerAttempts(run, m, start).filter((a) => !a.partial);
+  const last = full.at(-1);
+  return last ? { name: last.name, at: last.at, record: last.record } : null;
+}
+
+/** Plan 23: the milestone's latest reviewer that stopped at STATUS: partial, when no full review stands; else null. */
+export function partialReviewer(
+  run: Run,
+  m: string,
+  start = milestoneStart(run, m),
+): MilestoneReviewer | null {
+  if (milestoneReviewer(run, m, start)) return null;
+  const last = reviewerAttempts(run, m, start)
+    .filter((a) => a.partial)
+    .at(-1);
+  return last ? { name: last.name, at: last.at, record: last.record } : null;
+}
+
+const FINDING = /^\s*(?:[-*]\s*)?(BLOCKER|BUG|NIT)\b/;
+
+/** A reviewer reply's findings by severity; null when there is no reply to read. */
+export function countFindings(run: Run, r: RunRecord): { BLOCKER: number; BUG: number; NIT: number } | null {
+  const file = join(run.dir, r.replyPath);
+  if (!r.replyPath || !existsSync(file)) return null;
+  const n = { BLOCKER: 0, BUG: 0, NIT: 0 };
+  for (const line of readFileSync(file, "utf8").split("\n")) {
+    const k = FINDING.exec(line)?.[1] as keyof typeof n | undefined;
+    if (k) n[k]++;
+  }
+  return n;
+}
+
+/** The roles a fix round runs as. */
+const FIX_ROLES = new Set(["worker", "writer", "artist"]);
+
+/**
+ * Plan 23: the milestone reviewer's BLOCKER and BUG lines while no fix round has ended since (a worker,
+ * writer or artist of the milestone, ended ok after the review); null when there are none, or for a native
+ * reviewer, whose reply catherd does not keep.
+ */
+export function openFindings(
+  run: Run,
+  m: string,
+  start = milestoneStart(run, m),
+): { name: string; blocker: number; bug: number } | null {
+  const reviewer = milestoneReviewer(run, m, start);
+  if (!reviewer?.record) return null;
+  const n = countFindings(run, reviewer.record);
+  if (!n || n.BLOCKER + n.BUG === 0) return null;
+  const after = (at: string) => Date.parse(at) > Date.parse(reviewer.at);
+  const ofM = (name: string, lane: string | null | undefined) =>
+    inMilestone(lane, m) || namesMilestone(name, m);
+  const fixed =
+    readRecords(run).records.some(
+      (r) => FIX_ROLES.has(r.role) && r.status === "ok" && ofM(r.name, r.lane) && after(r.endedAt),
+    ) ||
+    readAgentRuns(run).some(
+      (a) => FIX_ROLES.has(a.role) && a.status === "ok" && ofM(a.name, a.lane) && after(a.at),
+    );
+  return fixed ? null : { name: reviewer.name, blocker: n.BLOCKER, bug: n.BUG };
 }
 
 /** A reviewer record for the milestone since its lanes started (see milestoneReviewer). */
diff --git a/src/services/protocol.ts b/src/services/protocol.ts
index 48758e5..837f6ba 100644
--- a/src/services/protocol.ts
+++ b/src/services/protocol.ts
@@ -1,4 +1,4 @@
-import { existsSync, readdirSync, readFileSync } from "node:fs";
+import { existsSync, readdirSync } from "node:fs";
 import { join } from "node:path";
 import type { RunRecord } from "../domain/record.ts";
 import type { RouteRow } from "../domain/route.ts";
@@ -6,11 +6,14 @@ import { ensurePrivateDir, readJsonl, writeTextAtomic } from "../infra/store.ts"
 import { type Dispatch, listDispatches, liveDispatches } from "./dispatches.ts";
 import { failedItems, RECHECK_COMMAND_MIN, type VerifierStep } from "./gate-service.ts";
 import {
+  countFindings,
   landedMilestones,
   milestoneReviewer,
   milestoneVerifier,
   milestoneStart,
   namesMilestone,
+  openFindings,
+  partialReviewer,
   reviewerPassed,
 } from "./milestones.ts";
 import { readAgentRuns, readRecords, readRoutes, type Run, runPaths } from "./run-store.ts";
@@ -109,7 +112,17 @@ export function protocolNext(run: Run, parked: string[], now = Date.now()): stri
   const running = live.filter((d) => d.admit.lane !== null && mine.includes(d.admit.lane));
   if (running.length) return `${m}: lanes running (${running.map((d) => d.admit.name).join(", ")})`;
   const start = milestoneStart(run, m);
-  if (!reviewerPassed(run, m, start)) return `${m}: reviewer`;
+  if (!reviewerPassed(run, m, start)) {
+    // plan 23: a partial review is not the review: a second pass, scoped to what it did not read
+    const partial = partialReviewer(run, m, start);
+    return partial
+      ? `${m}: ${partial.name} stopped partial: a scoped second pass (reviewer-${m}-2) over the files it did not read`
+      : `${m}: reviewer`;
+  }
+  // plan 23: open BLOCKER and BUG lines go to the fix round before the verifier
+  const open = openFindings(run, m, start);
+  if (open)
+    return `${m}: fix round for ${open.name}'s findings (${open.blocker} BLOCKER, ${open.bug} BUG), then the verifier`;
   const verdict = milestoneVerifier(run, m, start);
   if (!verdict) return `${m}: verifier`;
   // plan 23: the machine, not the work: the owner hears of it, and no fix round runs
@@ -129,17 +142,9 @@ export const protocolView = (run: Run, parked: string[], now?: number) => ({
   checklist: PROTOCOL_CHECKLIST,
 });
 
-const FINDING = /^\s*(?:[-*]\s*)?(BLOCKER|BUG|NIT)\b/;
-
 function findingCounts(run: Run, r: RunRecord | undefined): string {
   if (!r?.replyPath) return "no reply";
-  const file = join(run.dir, r.replyPath);
-  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
-  const n = { BLOCKER: 0, BUG: 0, NIT: 0 };
-  for (const line of text.split("\n")) {
-    const k = FINDING.exec(line)?.[1] as keyof typeof n | undefined;
-    if (k) n[k]++;
-  }
+  const n = countFindings(run, r) ?? { BLOCKER: 0, BUG: 0, NIT: 0 };
   const total = n.BLOCKER + n.BUG + n.NIT;
   return `${total} finding(s): ${n.BLOCKER} BLOCKER, ${n.BUG} BUG, ${n.NIT} NIT`;
 }
diff --git a/src/services/run-service.ts b/src/services/run-service.ts
index 9d6ecdb..d5877de 100644
--- a/src/services/run-service.ts
+++ b/src/services/run-service.ts
@@ -161,6 +161,8 @@ export function recordAgentRun(
     lane?: string;
     /** plan 23: a native verifier's first reply line, so a VERDICT: BLOCKED: environment is told from a FAIL */
     verdict?: string;
+    /** plan 23: the STATUS word of the subagent's reply */
+    replyStatus?: NonNullable<AgentRun["replyStatus"]>;
   },
 ): AgentRun {
   const run = findRun(i.run);
@@ -183,6 +185,7 @@ export function recordAgentRun(
     status: i.status ?? "ok",
     lane: i.lane ?? null,
     ...(i.verdict ? { verdict: i.verdict.trim().split("\n")[0] } : {}),
+    ...(i.replyStatus ? { replyStatus: i.replyStatus } : {}),
   };
   appendAgentRun(run, row);
   return row;
diff --git a/src/services/run-store.ts b/src/services/run-store.ts
index 49561f3..8afdb02 100644
--- a/src/services/run-store.ts
+++ b/src/services/run-store.ts
@@ -267,6 +267,8 @@ const AgentRunSchema = z.looseObject({
   lane: z.string().nullable().optional(),
   /** plan 23: a native verifier's verdict line (VERDICT: BLOCKED: environment — <probe>); rows before it lack it */
   verdict: z.string().optional(),
+  /** plan 23: the STATUS word of the subagent's reply (a reviewer's partial is no review); rows before it lack it */
+  replyStatus: z.enum(["complete", "partial", "blocked", "refused"]).optional(),
 });
 export type AgentRun = z.infer<typeof AgentRunSchema>;
 
diff --git a/test/services/land-gate.test.ts b/test/services/land-gate.test.ts
index 05f7fa5..23fe745 100644
--- a/test/services/land-gate.test.ts
+++ b/test/services/land-gate.test.ts
@@ -370,6 +370,41 @@ describe("the land gate (spec 1.1 §6)", () => {
     expect(protocolNext(run, [])).toStartWith("M1: verifier-M1 failed: the owning lanes fix it");
   });
 
+  it("refuses a native reviewer recorded with reply_status partial, until a full pass (plan 23)", async () => {
+    const { repo, run } = freshRun();
+    const c = commitFiles(repo, ["src/a.ts"]);
+    const claude = { host: "claude-code" as const, session: null, conflict: null };
+    const t0 = Date.now();
+    const review = (name: string, at: number, replyStatus?: "partial" | "complete") =>
+      recordAgentRun(fakeDeps({ host: claude, now: () => at }), {
+        run: run.id,
+        name,
+        role: "reviewer",
+        rung: "claude:claude-opus-5-5#low",
+        totalTokens: 1,
+        ...(replyStatus ? { replyStatus } : {}),
+      });
+    review("reviewer-M1", t0, "partial");
+    appendAgentRun(run, {
+      at: new Date(t0 + 100).toISOString(),
+      name: "verifier-M1",
+      role: "verifier",
+      rung: "claude:claude-opus-5-5#low",
+      agent: null,
+      totalTokens: 0,
+      costUsd: null,
+      secs: null,
+      status: "ok",
+    });
+    const e = await refusal(land(fakeDeps(), landing(run.id, c)));
+    expect(e.message).toBe(
+      "land M1: reviewer-M1 replied STATUS: partial, which is not the milestone's review",
+    );
+    expect(e.fix).toContain("reviewer-M1-2");
+    review("reviewer-M1-2", t0 + 200, "complete");
+    expect((await land(fakeDeps(), landing(run.id, c))).ledger).toStartWith("M1 |");
+  });
+
   it("takes a native reviewer (record_agent_run, role reviewer, reviewer-<M>, ok) since the milestone started", async () => {
     const { repo, run } = freshRun();
     writeLane(run, "M1.L1", ["src/a.ts"]);
diff --git a/test/services/protocol.test.ts b/test/services/protocol.test.ts
index 4703047..83e14a3 100644
--- a/test/services/protocol.test.ts
+++ b/test/services/protocol.test.ts
@@ -204,6 +204,87 @@ describe("Protocol next (spec 1.1 §10)", () => {
     );
   });
 
+  it("refuses a partial review, and names the fix round while BLOCKER or BUG lines are open (plan 23)", async () => {
+    const { repo, run } = freshRun();
+    const deps = fakeDeps();
+    writeLane(run, "M1.L1", ["src/a.ts"]);
+    await route(deps, { run: run.id, laneFile: "lanes/M1.L1.md", role: "worker" });
+    worked(run, "M1.L1");
+    const t0 = Date.now() + 1000;
+    const reviewer = async (name: string, reply: string, status: "complete" | "partial", at: number) => {
+      const dispatchId = newDispatchId();
+      const replyPath = `roles/${name}/${dispatchId}/reply.md`;
+      mkdirSync(join(run.dir, "roles", name, dispatchId), { recursive: true });
+      writeFileSync(join(run.dir, replyPath), reply);
+      await appendRecord(
+        run,
+        makeRecord({
+          runId: run.id,
+          dispatchId,
+          name,
+          role: "reviewer",
+          lane: null,
+          replyPath,
+          replyStatus: status,
+          endedAt: new Date(at).toISOString(),
+        }),
+      );
+    };
+    await reviewer("reviewer-M1", "read the core only\nSTATUS: partial — 4 files unread", "partial", t0);
+    expect(protocolNext(run, [])).toBe(
+      "M1: reviewer-M1 stopped partial: a scoped second pass (reviewer-M1-2) over the files it did not read",
+    );
+    appendAgentRun(run, {
+      at: new Date(t0 + 500).toISOString(),
+      name: "verifier-M1",
+      role: "verifier",
+      rung: "claude:claude-opus-5-5#low",
+      agent: null,
+      totalTokens: 0,
+      costUsd: null,
+      secs: null,
+      status: "ok",
+    });
+    const e = await land(deps, {
+      run: run.id,
+      milestone: "M1",
+      what: "w",
+      commit: head(repo),
+      evidence: "ok",
+      next: "M2",
+    }).then(
+      () => null,
+      (x: unknown) => x as { code: string; message: string },
+    );
+    expect(e?.code).toBe("E_LAND_GATE");
+    expect(e?.message).toBe(
+      "land M1: reviewer-M1 replied STATUS: partial, which is not the milestone's review",
+    );
+    await reviewer(
+      "reviewer-M1-2",
+      "- BLOCKER src/a.ts:3 — wrong sign — flip it\n- BUG src/a.ts:9 — off by one — <=\n- NIT src/a.ts:1 — name\nSTATUS: complete — 3 findings",
+      "complete",
+      t0 + 1000,
+    );
+    expect(protocolNext(run, [])).toBe(
+      "M1: fix round for reviewer-M1-2's findings (1 BLOCKER, 1 BUG), then the verifier",
+    );
+    // the fix round ends ok after the review: the next step moves on
+    appendAgentRun(run, {
+      at: new Date(t0 + 2000).toISOString(),
+      name: "worker-M1.L1",
+      role: "worker",
+      rung: "claude:claude-opus-5-5#low",
+      agent: null,
+      totalTokens: 1,
+      costUsd: null,
+      secs: 1,
+      status: "ok",
+      lane: "M1.L1",
+    });
+    expect(protocolNext(run, [])).not.toStartWith("M1: fix round");
+  });
+
   it("run_start returns the step and the six-line checklist", async () => {
     withHome();
     const r = await startRun(fakeDeps(), { repo: tempRepo(), title: "t", aLines: ["A1 x"] });
```

### Task 9: outcomes — a flaky reply, an `ENV:` line, and acceptance left to the verifier

**Scratch commit:** `bd61ec7` — `feat(outcomes): a flaky reply status, and an env line as a hint that climb refuses`

**Files:** modify `src/domain/record.ts`, `src/domain/hints.ts`, `src/domain/errors.ts`, `src/domain/role-prompts.ts`, `src/services/finalize.ts`, `src/services/lane-service.ts`, `src/services/run-store.ts`, `src/entry/mcp/run-tools.ts`, `src/entry/mcp/lane-tools.ts`, `plugin/skills/catherd/SKILL.md`, `test/domain/record.test.ts`, `test/domain/run-rules.test.ts`, `test/services/climb-design.test.ts`, `test/services/dispatch-protocol.test.ts`, `test/services/dispatch.test.ts`.

**Consumes:** Task 8's files. **Produces (Rulings 19, 20, 27):**
- `record.ts`: `REPLY_STATUSES` adds `"flaky"` (and the STATUS line regex); `parseReplyEnvironment(reply): string | null` (an `ENV: <what>` line anywhere; blanks after `ENV:` never span lines); `RunRecordSchema.environment?: string`.
- `finalize` records `environment` from the reply.
- `dispatchHints`: `environment: <what>` (no climb hint), else `flaky: <why>; rerun it alone, accept it, or climb: your call`, else the existing climb hints.
- `ErrorCode` adds `"E_CLIMB_ENV"`; `climb` refuses when the lane's last record has `environment`, before Jev is asked; the `climb` tool's description says so.
- `role-prompts.ts`: `WORKER_REPLY`, the worker's contract: acceptance built from HEAD is the verifier's, `ENV: <what>`, `STATUS: complete|partial|blocked|refused|flaky`.
- `AgentRun.replyStatus` and `reply_status` take `flaky`.
- SKILL.md: `E_CLIMB_ENV` in the error list; the `environment:`/flaky bullet in step 5.

- [ ] **Step 1: the failing tests.** The new cases in `test/domain/record.test.ts`, `test/domain/run-rules.test.ts`, `test/services/climb-design.test.ts`, `test/services/dispatch.test.ts`, and the worker-contract assertions in `test/services/dispatch-protocol.test.ts`. They fail.
- [ ] **Step 2: the code.** Apply the source hunks.
- [ ] **Step 3:** `bun test test/domain test/services/climb-design.test.ts test/services/dispatch.test.ts test/services/dispatch-protocol.test.ts test/skills.test.ts test/plugin.test.ts`; `bun run typecheck && bun run lint`.
- [ ] **Step 4: commit** `feat(outcomes): a flaky reply status, and an env line as a hint that climb refuses`.

```diff
diff --git a/plugin/skills/catherd/SKILL.md b/plugin/skills/catherd/SKILL.md
index f07babc..b335f16 100644
--- a/plugin/skills/catherd/SKILL.md
+++ b/plugin/skills/catherd/SKILL.md
@@ -73,6 +73,7 @@ Pass the actual project `repo` explicitly to profile, setup and catalog tools th
 - `E_LANE_INVALID`: a lane file's `Kind:` or `Difficulty:` is missing or not one the catalog knows. Fix the header (the `fix` lists the values), or have the architect fix it, then call again.
 - `E_LAND_GATE`: the milestone has no reviewer record or no verifier verdict since its lanes started, it is parked, or its `skip` does not hold. Run what the message names, then land again.
 - `E_CLIMB_DESIGN`: the evidence points at the plan, not the rung. Send it to the architect (an `ask` finding, then an architect delta), not up the ladder.
+- `E_CLIMB_ENV`: the lane's last reply named the environment (`ENV:`). A higher rung would stop the same way: fix the environment, or park the milestone.
 
 ## Workspaces with independent repositories
 
@@ -266,6 +267,7 @@ Nothing else pushes: a phone that buzzes for progress teaches the user to ignore
 
 5. **Lanes.** Dispatch every lane of the milestone, one after another, each at its rung, then end your turn: workers, the artist, and a researcher if needed. A worker's brief points at its lane file, and `dispatch` gets its `lane`. A worker runs its own fast check until it passes.
    - When a worker's message arrives, read it with `result`: check its STATUS line, its `changedOwned` and its `hints`, then run its fast check yourself once. A fail goes back to the same thread with the failing output's path; a second fail climbs a rung.
+   - A hint `environment: <what>` (the reply had an `ENV:` line) is the machine, not the rung: `climb` refuses it (`E_CLIMB_ENV`). Fix the environment, or `park` the milestone when only the owner can. `STATUS: flaky` (a check failed, then passed alone) is the worker's evidence: rerun that check alone, accept it, or climb; the call is yours.
    - A `violation: <paths>` hint means the role wrote outside its lane. Send those paths to the reviewer with the milestone; a lane that needs them gets an `Owns:` delta from the architect.
 6. **writer,** when the milestone changes docs. It starts once the workers are done.
 7. **reviewer,** named `reviewer-<M>`, once, over the whole milestone diff on a frozen tree.
diff --git a/src/domain/errors.ts b/src/domain/errors.ts
index 0a08c58..7c5cc56 100644
--- a/src/domain/errors.ts
+++ b/src/domain/errors.ts
@@ -20,6 +20,7 @@ export type ErrorCode =
   | "E_LANE_INVALID"
   | "E_LAND_GATE"
   | "E_CLIMB_DESIGN"
+  | "E_CLIMB_ENV"
   | "E_JEV_KEY"
   | "E_JEV_NETWORK"
   | "E_JEV_RESPONSE"
diff --git a/src/domain/hints.ts b/src/domain/hints.ts
index d0af45a..6e3ee06 100644
--- a/src/domain/hints.ts
+++ b/src/domain/hints.ts
@@ -7,7 +7,13 @@ export function dispatchHints(r: RunRecord, owns: string[], dir: string): string
   if (r.status === "cli-too-old") h.push(`cli-too-old: ${r.error?.message ?? `upgrade ${r.backend}`}`);
   if (r.status === "failed") h.push(`failed: read ${dir}/stderr`);
   if (r.gitUnavailable) h.push("git-unavailable: changed files unknown");
-  if (r.replyStatus === "refused" || r.replyStatus === "blocked") h.push(`climb: ${r.replyStatus}`);
+  // plan 23: the environment stopped it, and a higher rung would stop the same way: fix it or surface it
+  if (r.environment) h.push(`environment: ${r.environment}`);
+  else if (r.replyStatus === "flaky")
+    h.push(
+      `flaky: ${r.replyWhy || "a check failed, then passed alone"}; rerun it alone, accept it, or climb: your call`,
+    );
+  else if (r.replyStatus === "refused" || r.replyStatus === "blocked") h.push(`climb: ${r.replyStatus}`);
   else if (
     r.status === "ok" &&
     !r.gitUnavailable &&
diff --git a/src/domain/record.ts b/src/domain/record.ts
index 9239b57..4cbe7ef 100644
--- a/src/domain/record.ts
+++ b/src/domain/record.ts
@@ -6,7 +6,8 @@ export type Access = (typeof ACCESS)[number];
 const RUN_STATUSES = ["ok", "failed", "limit", "cli-too-old", "timeout", "cancelled"] as const;
 export type RunStatus = (typeof RUN_STATUSES)[number];
 
-const REPLY_STATUSES = ["complete", "partial", "blocked", "refused"] as const;
+/** plan 23: `flaky`, a worker's word for a check that failed, then passed when run alone */
+const REPLY_STATUSES = ["complete", "partial", "blocked", "refused", "flaky"] as const;
 export type ReplyStatus = (typeof REPLY_STATUSES)[number];
 
 export interface Tokens {
@@ -65,6 +66,8 @@ export const RunRecordSchema = z.looseObject({
   gitUnavailable: z.boolean().optional(),
   replyStatus: z.enum(REPLY_STATUSES).nullable(),
   replyWhy: z.string().nullable(),
+  /** plan 23: the reply's ENV: line, when the environment stopped the role; absent otherwise */
+  environment: z.string().optional(),
   threadHeavy: z.boolean(),
   access: z.enum(ACCESS),
   isolated: z.boolean(),
@@ -79,7 +82,16 @@ export const RunRecordSchema = z.looseObject({
 });
 export type RunRecord = z.infer<typeof RunRecordSchema>;
 
-const STATUS_LINE = /^STATUS:\s*(complete|partial|blocked|refused)\s*(?:—|–|-)\s*(.*)$/;
+const STATUS_LINE = /^STATUS:\s*(complete|partial|blocked|refused|flaky)\s*(?:—|–|-)\s*(.*)$/;
+
+/**
+ * Plan 23: what stopped the role, when the environment did: an `ENV: <what>` line of its reply (a VPN, no
+ * Docker, a dead registry); null without one.
+ */
+export function parseReplyEnvironment(reply: string): string | null {
+  const m = /^[ \t]*ENV:[ \t]*(\S.*?)[ \t]*$/m.exec(reply);
+  return m ? (m[1] as string) : null;
+}
 
 /** The role's claim about its own work: the reply's last line, `STATUS: <s> — <why>`. */
 export function parseReplyStatus(reply: string): { status: ReplyStatus | null; why: string | null } {
diff --git a/src/domain/role-prompts.ts b/src/domain/role-prompts.ts
index 81852fb..5c37fd4 100644
--- a/src/domain/role-prompts.ts
+++ b/src/domain/role-prompts.ts
@@ -10,6 +10,14 @@ const RUN_FILES =
 const REPLY =
   "Do not commit. Reply in at most 15 lines: results, file:line, and evidence as a log path, not the log. The last line of your reply is: STATUS: complete|partial|blocked|refused — <one line why>";
 
+/**
+ * Plan 23: the worker's reply contract. Acceptance that builds from HEAD is the verifier's, since a worker
+ * does not commit; an environment that stopped it goes on an ENV: line (climb refuses it); a check that
+ * failed, then passed alone, is STATUS: flaky with that evidence.
+ */
+const WORKER_REPLY =
+  "Do not commit. Acceptance items that build from HEAD (git archive, a commit's image) belong to the verifier: do not run them, and never commit to get them to run. Reply in at most 15 lines: results, file:line, and evidence as a log path, not the log. When the environment stopped you (no Docker, a VPN, a dead registry), add a line ENV: <what>. The last line of your reply is: STATUS: complete|partial|blocked|refused|flaky — <one line why>; flaky means a check failed, then passed when run alone: name it, and how often each.";
+
 const architect = [
   "You are the architect of a catherd run. The orchestrator gave you the goal, the acceptance lines, the run id, and usually a dossier: a researcher's map of the code this work touches. Workers are other models that run in the project directory with no memory of this conversation. They will write every line of code from your plan.",
   "",
@@ -79,7 +87,7 @@ const worker = (version: string) =>
     "",
     `Change only the files you own. Run your fast check until it passes. Run the full suite only if the brief says so, and wrap any full build or full test suite in: bunx catherd-cli@${version} lock -- <command>. Other lanes share this machine.`,
     "",
-    REPLY,
+    WORKER_REPLY,
   ].join("\n");
 
 const reviewer = [
@@ -149,7 +157,7 @@ const STATUS_LINE =
 const CONTRACTS: Record<Role, string> = {
   architect: `Reply briefly: the milestones, each with its lanes as Mx.Ly — one line — owned files, and the full-check command. ${STATUS_LINE}`,
   verifier: `The first line of your reply is VERDICT: PASS or VERDICT: FAIL, or VERDICT: BLOCKED: environment — <the probe that proves it> when the machine, not the work, stops the gate (run that probe twice, 5 s apart, before you call the host blocked). ${STATUS_LINE}`,
-  worker: REPLY,
+  worker: WORKER_REPLY,
   reviewer: REPLY,
   "ui-reviewer": REPLY,
   artist: REPLY,
diff --git a/src/entry/mcp/lane-tools.ts b/src/entry/mcp/lane-tools.ts
index 2b958d4..abea006 100644
--- a/src/entry/mcp/lane-tools.ts
+++ b/src/entry/mcp/lane-tools.ts
@@ -41,7 +41,7 @@ export function registerLaneTools(server: McpServer, deps: Deps): void {
     "climb",
     {
       description:
-        "Move a routed lane one rung up its ladder and record why. Returns the next rung, or top: true, and any hints. Dispatch the lane again at that rung on a fresh thread. Pass env: true when the environment caused it (a missing service, a broken tool, a usage limit), not the rung. Refused with E_CLIMB_DESIGN when the evidence is a design question (Jev's finding answer is design, or a blocked climb's evidence is about lane ownership): send it to the architect instead.",
+        "Move a routed lane one rung up its ladder and record why. Returns the next rung, or top: true, and any hints. Dispatch the lane again at that rung on a fresh thread. Pass env: true when the environment caused it (a missing service, a broken tool, a usage limit), not the rung. Refused with E_CLIMB_DESIGN when the evidence is a design question (Jev's finding answer is design, or a blocked climb's evidence is about lane ownership): send it to the architect instead. Refused with E_CLIMB_ENV when the lane's last reply named the environment on an ENV: line: fix the environment or park the milestone.",
       inputSchema: {
         run: z.string(),
         lane: z.string().regex(ID_PATTERN),
diff --git a/src/entry/mcp/run-tools.ts b/src/entry/mcp/run-tools.ts
index db78740..3f075be 100644
--- a/src/entry/mcp/run-tools.ts
+++ b/src/entry/mcp/run-tools.ts
@@ -104,7 +104,7 @@ export function registerRunTools(server: McpServer, deps: Deps): void {
         status: z.enum(["ok", "failed", "cancelled"]).default("ok"),
         lane: z.string().regex(ID_PATTERN).optional(),
         verdict: z.string().min(1).optional(),
-        reply_status: z.enum(["complete", "partial", "blocked", "refused"]).optional(),
+        reply_status: z.enum(["complete", "partial", "blocked", "refused", "flaky"]).optional(),
       },
     },
     (a) =>
diff --git a/src/services/finalize.ts b/src/services/finalize.ts
index 7741065..bea165e 100644
--- a/src/services/finalize.ts
+++ b/src/services/finalize.ts
@@ -8,6 +8,7 @@ import { isCatherdError } from "../domain/errors.ts";
 import { parseRung } from "../domain/ids.ts";
 import {
   type ExitInfo,
+  parseReplyEnvironment,
   parseReplyStatus,
   type RunRecord,
   THREAD_HEAVY_INPUT,
@@ -193,6 +194,7 @@ async function compute(run: Run, d: Dispatch): Promise<RunRecord> {
       )
     : { changedOwned: [], violations: [] };
   const reported = parseReplyStatus(replyText);
+  const environment = parseReplyEnvironment(replyText);
   return {
     schema: 1,
     runId: run.id,
@@ -219,6 +221,7 @@ async function compute(run: Run, d: Dispatch): Promise<RunRecord> {
     ...(after ? {} : { gitUnavailable: true }),
     replyStatus: reported.status,
     replyWhy: reported.why,
+    ...(environment ? { environment } : {}),
     threadHeavy: o.tokens.input >= THREAD_HEAVY_INPUT,
     access: a.access,
     isolated: a.isolated,
diff --git a/src/services/lane-service.ts b/src/services/lane-service.ts
index de4c473..fceca56 100644
--- a/src/services/lane-service.ts
+++ b/src/services/lane-service.ts
@@ -185,6 +185,18 @@ export async function climb(
     });
   // an unrouted lane is refused before Jev is asked about its evidence (no call, no jev.jsonl row)
   if (!currentRoute(readRoutes(run), i.lane)) throw unrouted();
+  // plan 23: a reply that named the environment (ENV: …) would stop a higher rung the same way
+  const last = readRecords(run)
+    .records.filter((r) => r.lane === i.lane)
+    .at(-1);
+  if (last?.environment)
+    throw new CatherdError(
+      "E_CLIMB_ENV",
+      `climb ${i.lane}: ${last.name} was stopped by the environment (${last.environment}), which a higher rung cannot fix`,
+      {
+        fix: `fix the environment (doctor; catherd knowledge env set for the gate environment) and dispatch ${i.lane} again at the same rung, or park the milestone when only the owner can fix it`,
+      },
+    );
   await refuseDesign(deps, run, i);
   const { cur, next } = await withFileLock(runPaths(run.dir).routes, () => {
     const cur = currentRoute(readRoutes(run), i.lane);
diff --git a/src/services/run-store.ts b/src/services/run-store.ts
index 8afdb02..a54c9d3 100644
--- a/src/services/run-store.ts
+++ b/src/services/run-store.ts
@@ -268,7 +268,7 @@ const AgentRunSchema = z.looseObject({
   /** plan 23: a native verifier's verdict line (VERDICT: BLOCKED: environment — <probe>); rows before it lack it */
   verdict: z.string().optional(),
   /** plan 23: the STATUS word of the subagent's reply (a reviewer's partial is no review); rows before it lack it */
-  replyStatus: z.enum(["complete", "partial", "blocked", "refused"]).optional(),
+  replyStatus: z.enum(["complete", "partial", "blocked", "refused", "flaky"]).optional(),
 });
 export type AgentRun = z.infer<typeof AgentRunSchema>;
 
diff --git a/test/domain/record.test.ts b/test/domain/record.test.ts
index 455db1d..386b213 100644
--- a/test/domain/record.test.ts
+++ b/test/domain/record.test.ts
@@ -1,5 +1,11 @@
 import { describe, expect, it } from "bun:test";
-import { parseReplyStatus, type RunRecord, RunRecordSchema, ZERO_TOKENS } from "../../src/domain/record.ts";
+import {
+  parseReplyEnvironment,
+  parseReplyStatus,
+  type RunRecord,
+  RunRecordSchema,
+  ZERO_TOKENS,
+} from "../../src/domain/record.ts";
 
 export const sampleRecord = (over: Partial<RunRecord> = {}): RunRecord => ({
   schema: 1,
@@ -55,6 +61,16 @@ describe("parseReplyStatus", () => {
     expect(parseReplyStatus("STATUS: refused - no")).toEqual({ status: "refused", why: "no" });
     expect(parseReplyStatus("STATUS: complete — x\nmore text")).toEqual({ status: null, why: null });
     expect(parseReplyStatus("")).toEqual({ status: null, why: null });
+    expect(parseReplyStatus("STATUS: flaky — x failed once, passed 3/3 alone")).toEqual({
+      status: "flaky",
+      why: "x failed once, passed 3/3 alone",
+    });
+  });
+
+  it("reads an ENV: line anywhere in the reply (plan 23)", () => {
+    expect(parseReplyEnvironment("could not run the suite\nENV: vpn  \nSTATUS: blocked — vpn")).toBe("vpn");
+    expect(parseReplyEnvironment("no env here\nSTATUS: complete — ok")).toBeNull();
+    expect(parseReplyEnvironment("ENV:   \nSTATUS: blocked — x")).toBeNull();
   });
 });
 
diff --git a/test/domain/run-rules.test.ts b/test/domain/run-rules.test.ts
index d2c2ef6..c86d630 100644
--- a/test/domain/run-rules.test.ts
+++ b/test/domain/run-rules.test.ts
@@ -70,6 +70,29 @@ describe("dispatchHints", () => {
     expect(dispatchHints(makeRecord({ changedOwned: [] }), [], dir)).toEqual([]);
   });
 
+  it("says environment for an ENV: line and flaky for a flaky reply, never climb (plan 23)", () => {
+    expect(
+      dispatchHints(
+        makeRecord({ replyStatus: "blocked", environment: "vpn", changedOwned: [] }),
+        ["src/a.ts"],
+        dir,
+      ),
+    ).toEqual(["environment: vpn"]);
+    expect(
+      dispatchHints(
+        makeRecord({
+          replyStatus: "flaky",
+          replyWhy: "notify_test failed once in turbo, passed 3/3 alone",
+          changedOwned: [],
+        }),
+        ["src/a.ts"],
+        dir,
+      ),
+    ).toEqual([
+      "flaky: notify_test failed once in turbo, passed 3/3 alone; rerun it alone, accept it, or climb: your call",
+    ]);
+  });
+
   it("says the changes are unknown, not unchanged, when git could not see them", () => {
     const r = makeRecord({ changedOwned: [], gitUnavailable: true });
     expect(dispatchHints(r, ["src/a.ts"], dir)).toEqual(["git-unavailable: changed files unknown"]);
diff --git a/test/services/climb-design.test.ts b/test/services/climb-design.test.ts
index 933cb76..e1f2646 100644
--- a/test/services/climb-design.test.ts
+++ b/test/services/climb-design.test.ts
@@ -1,9 +1,10 @@
 import { afterEach, describe, expect, it } from "bun:test";
 import { isCatherdError } from "../../src/domain/errors.ts";
 import { climb, route } from "../../src/services/lane-service.ts";
-import { readRoutes } from "../../src/services/run-store.ts";
+import { newDispatchId } from "../../src/domain/ids.ts";
+import { appendRecord, readRoutes } from "../../src/services/run-store.ts";
 import { snapshotEnv } from "../helpers.ts";
-import { fakeDeps, freshRun, LADDER, testView, writeLane } from "./helpers.ts";
+import { fakeDeps, freshRun, LADDER, makeRecord, testView, writeLane } from "./helpers.ts";
 
 afterEach(snapshotEnv());
 
@@ -48,6 +49,38 @@ describe("climb only for capability (spec 1.1 §9)", () => {
     expect(readRoutes(run).filter((r) => r.source === "climb")).toEqual([]);
   });
 
+  it("refuses to climb a lane whose last reply named the environment (plan 23)", async () => {
+    const { run, deps, asked } = await routed();
+    await appendRecord(
+      run,
+      makeRecord({
+        runId: run.id,
+        dispatchId: newDispatchId(),
+        name: "worker-M1.L1",
+        lane: "M1.L1",
+        replyStatus: "blocked",
+        environment: "vpn",
+      }),
+    );
+    expect(await code(climb(deps, { run: run.id, lane: "M1.L1", reason: "blocked" }))).toStartWith(
+      "E_CLIMB_ENV: fix the environment",
+    );
+    expect(asked).toEqual([]);
+    expect(readRoutes(run).filter((r) => r.source === "climb")).toEqual([]);
+    // a later reply without it climbs again
+    await appendRecord(
+      run,
+      makeRecord({
+        runId: run.id,
+        dispatchId: newDispatchId(),
+        name: "worker-M1.L1",
+        lane: "M1.L1",
+        replyStatus: "blocked",
+      }),
+    );
+    expect(await code(climb(deps, { run: run.id, lane: "M1.L1", reason: "blocked" }))).toBe("climbed");
+  });
+
   it("climbs when Jev calls it code, and without evidence asks nothing", async () => {
     const { run, deps, asked } = await routed();
     const r = await climb(deps, {
diff --git a/test/services/dispatch-protocol.test.ts b/test/services/dispatch-protocol.test.ts
index 6f5357d..1fdaa7b 100644
--- a/test/services/dispatch-protocol.test.ts
+++ b/test/services/dispatch-protocol.test.ts
@@ -29,11 +29,18 @@ function setup() {
 
 describe("the reply contract (spec 1.1 §6)", () => {
   it("ends every role's contract with the STATUS line", () => {
-    for (const role of ROLES)
+    for (const role of ROLES.filter((r) => r !== "worker"))
       expect(replyContract(role)).toEndWith(
         "The last line of your reply is: STATUS: complete|partial|blocked|refused — <one line why>",
       );
-    expect(replyContract("worker")).toStartWith("Do not commit. Reply in at most 15 lines");
+    // plan 23: a worker may also say flaky, put the environment on an ENV: line, and leaves acceptance
+    // built from HEAD to the verifier
+    const worker = replyContract("worker");
+    expect(worker).toStartWith("Do not commit. Acceptance items that build from HEAD");
+    expect(worker).toContain("add a line ENV: <what>");
+    expect(worker).toContain(
+      "The last line of your reply is: STATUS: complete|partial|blocked|refused|flaky — ",
+    );
     expect(replyContract("verifier")).toStartWith(
       "The first line of your reply is VERDICT: PASS or VERDICT: FAIL, or VERDICT: BLOCKED: environment",
     );
diff --git a/test/services/dispatch.test.ts b/test/services/dispatch.test.ts
index f998aa1..a25ef2a 100644
--- a/test/services/dispatch.test.ts
+++ b/test/services/dispatch.test.ts
@@ -138,6 +138,13 @@ describe("dispatch", () => {
     expect(existsSync(runPaths(run.dir).harness)).toBe(false);
   });
 
+  it("records a reply's ENV: line, and hints environment, not climb (plan 23)", async () => {
+    const { run, deps } = setup({ reply: "the suite needs the VPN down\nENV: vpn\nSTATUS: blocked — vpn" });
+    const { record, hints } = await runRole(deps, input(run.id));
+    expect(record).toMatchObject({ replyStatus: "blocked", environment: "vpn" });
+    expect(hints).toEqual(["environment: vpn"]);
+  });
+
   it("flags an ok run that left its owned files alone, and a write outside the lane", async () => {
     const { run, deps } = setup({
       reply: "x\nSTATUS: complete — ok",
```

### Task 10: the verifier's brief, and the lint of every package in the lane template

**Scratch commit:** `09726f0` — `feat(verifier): the brief carries the gate rules, recorded and failed items, and the gate env`

**Files:** create `src/domain/gate-brief.ts`, `src/services/verifier-brief.ts`, `test/services/verifier-brief.test.ts`; modify `src/domain/role-prompts.ts`, `src/services/admission.ts`, `src/services/gate-service.ts`, `src/services/protocol.ts`, `plugin/skills/catherd/SKILL.md`, `test/domain/agents.test.ts`, `test/services/gate-service.test.ts`, `test/skills.test.ts`.

**Consumes:** Task 2's `recordedItems`, Task 6's `gateEnvLines`/`readGateEnv`, Task 9's `role-prompts.ts`. **Produces (Rulings 5, 11, 26–29):**
- `src/domain/gate-brief.ts`: `RECHECK_COMMAND_MIN = 10` (moved from `gate-service.ts`; `protocol.ts` imports it from here), `VERIFIER_GATE_RULES` (root gate apart from each per-service acceptance suite, acceptance from HEAD is the verifier's; stay in the foreground; BLOCKED with a probe run twice 5 s apart; `docker image prune -f` last), `GATE_NOTES_HEADING = "## The gate (catherd)"`, `GateNotes`, `gateNotes(n)`, `withGateNotes(brief, n)` (once).
- `src/services/verifier-brief.ts`: `milestoneOfName(name)`, `verifierBrief(run, role, name, brief)`.
- Admission writes a verifier's brief as `withReplyContract(role, verifierBrief(run, role, name, brief))`.
- `gateList` answers `{ recorded, env }` (the gate env lines a native verifier exports).
- The verifier's prompt: the first `gate_check(run, milestone)` call, the rules, `VERDICT … or VERDICT: BLOCKED: environment`; the architect's fast check names "the linter of every package the lane touches"; SKILL.md step 3 the same.

- [ ] **Step 1: the failing tests.** `test/services/verifier-brief.test.ts` (new), the architect assertion in `test/domain/agents.test.ts`, the skill assertion in `test/skills.test.ts`, the `env: []` in `test/services/gate-service.test.ts`. They fail.
- [ ] **Step 2: the code.** Create the two modules; apply the other hunks.
- [ ] **Step 3:** `bun test test/services/verifier-brief.test.ts test/domain/agents.test.ts test/services/gate-service.test.ts test/services/protocol.test.ts test/skills.test.ts test/services/dispatch-protocol.test.ts test/architecture.test.ts`; `bun run typecheck && bun run lint && bun run format:check`.
- [ ] **Step 4: commit** `feat(verifier): the brief carries the gate rules, recorded and failed items, and the gate env`.

```diff
diff --git a/plugin/skills/catherd/SKILL.md b/plugin/skills/catherd/SKILL.md
index b335f16..0ee5c47 100644
--- a/plugin/skills/catherd/SKILL.md
+++ b/plugin/skills/catherd/SKILL.md
@@ -247,7 +247,7 @@ Nothing else pushes: a phone that buzzes for progress teaches the user to ignore
 
    It may run to 200 lines; the 15-line cap does not apply to it. Its reply is `result(run, "researcher-dossier")`, at the record's `replyPath`. A native Claude researcher on Claude Code writes it to `R/dossier.md` with `write_run_file` instead.
 
-3. **Architect,** once, with the A-lines, the run id and the dossier's path. It reads the dossier first, writes `plan.md` and every `lanes/Mx.Ly.md` itself with `write_run_file`, and replies with a short list of milestones and lanes. Each lane names its owned files and its **fast check**: its targeted tests plus the linter, and the type check when the repo has one, scoped to the lane's owned packages (seconds to a minute or two). Each milestone names its **full check** (the whole suite).
+3. **Architect,** once, with the A-lines, the run id and the dossier's path. It reads the dossier first, writes `plan.md` and every `lanes/Mx.Ly.md` itself with `write_run_file`, and replies with a short list of milestones and lanes. Each lane names its owned files and its **fast check**: its targeted tests plus the linter of every package the lane touches, and the type check when the repo has one, scoped to those packages (seconds to a minute or two). Each milestone names its **full check** (the whole suite).
    - A full check slower than about five minutes is a problem to solve, not to live with. The architect makes speeding it up (parallel tests, a shared fixture) an early lane.
    - Every lane file starts with these lines: `# Mx.Ly — <title>`, `Owns: <paths>` (repo-relative, a trailing `/` for a folder, never a glob), `Fast check: <command>`, `Kind: repo_code|terminal|ui|prose|research` and `Difficulty: copy|build|logic|hard`.
    - **Plan in hand** (a `plan:` A-line): no dossier. Brief the architect with the A-lines, the run id and the plan's paths, to translate, not design: each plan task becomes lanes (`Owns:`, `Fast check:`, `Kind:`, `Difficulty:`), each MR or phase a milestone with its full check. It copies the plan's decisions into `plan.md` and the lane files, redesigns only what the plan leaves undecided, and stays the target for `design` findings.
diff --git a/src/domain/gate-brief.ts b/src/domain/gate-brief.ts
new file mode 100644
index 0000000..024f372
--- /dev/null
+++ b/src/domain/gate-brief.ts
@@ -0,0 +1,52 @@
+// Plan 23: how a verifier runs a gate, which every verifier gets (its agent file, or its dispatch brief), and
+// the run's own facts a dispatched verifier's brief adds: the items already recorded, the failed ones to
+// re-check first, and the repo's gate environment.
+
+/** A re-check's cap on each command, in minutes: a hung command fails its item, not the verifier. */
+export const RECHECK_COMMAND_MIN = 10;
+
+/** The rules of the gate, one paragraph each. */
+export const VERIFIER_GATE_RULES = [
+  "Run the root gate (the milestone's full check) as one gate item and each per-service acceptance suite as its own item, never as one command: a failure then names its item, and a re-check reruns only that item. Acceptance that builds from HEAD (git archive, a commit's image) is yours: workers do not commit, so they never run it.",
+  "Stay in the foreground until your verdict: no background watcher, and never end your turn while a command runs.",
+  `When the machine, not the work, stops an item (a VPN filter, a Docker client proxy, a dead registry, no DNS), probe it directly, twice, 5 s apart, and if it still fails, reply VERDICT: BLOCKED: environment — <the probe and its output>. That is a blocker for the owner, not a FAIL.`,
+  "Last, when you built Docker images, run docker image prune -f, so the gates of later milestones do not fill the disk.",
+];
+
+/** The marker a verifier brief's catherd section starts with: added once. */
+export const GATE_NOTES_HEADING = "## The gate (catherd)";
+
+/** The run's facts for one verifier dispatch. */
+export interface GateNotes {
+  milestone: string | null;
+  /** the milestone's recorded items, with whether each passed */
+  recorded: { item: string; passed: boolean }[];
+  /** the repo's gate environment, as `NAME=value` or `NAME=$FROM` */
+  env: string[];
+}
+
+/** The section a dispatched verifier's brief ends with (before the reply contract). */
+export function gateNotes(n: GateNotes): string {
+  const failed = n.recorded.filter((r) => !r.passed).map((r) => r.item);
+  const lines = [GATE_NOTES_HEADING, "", ...VERIFIER_GATE_RULES.map((r) => `- ${r}`)];
+  if (n.milestone && n.recorded.length) {
+    lines.push(
+      `- Items already recorded for ${n.milestone}; reuse these names in gate_check, so what passed is carried over: ${n.recorded.map((r) => r.item).join(", ")}.`,
+    );
+    if (failed.length)
+      lines.push(
+        `- This is a re-check. Run the failed items first: ${failed.join(", ")}. Cap each command at ${RECHECK_COMMAND_MIN} minutes; a command that runs longer fails its item (say so), it never holds the gate.`,
+      );
+  }
+  if (n.env.length)
+    lines.push(
+      `- The repo's gate environment is already set in your env (a secret as $NAME of where it came from): ${n.env.join(", ")}.`,
+    );
+  return lines.join("\n");
+}
+
+/** `brief` with the gate notes appended, once: a brief that already has them is kept. */
+export function withGateNotes(brief: string, n: GateNotes): string {
+  if (brief.includes(GATE_NOTES_HEADING)) return brief;
+  return `${brief.trimEnd()}\n\n${gateNotes(n)}\n`;
+}
diff --git a/src/domain/role-prompts.ts b/src/domain/role-prompts.ts
index 5c37fd4..746971f 100644
--- a/src/domain/role-prompts.ts
+++ b/src/domain/role-prompts.ts
@@ -1,4 +1,5 @@
 import type { Access } from "./record.ts";
+import { VERIFIER_GATE_RULES } from "./gate-brief.ts";
 import type { Role } from "./roles.ts";
 
 // The role prompts of the native Claude subagents, ported from 0.x (spec D9). Headless backends get the
@@ -32,7 +33,7 @@ const architect = [
   "3. Lanes inside each milestone, M1.L1…: each lane gives",
   "   - the files it owns (two lanes of one milestone never share a file);",
   "   - what changes, stated as behavior plus the exact signatures and data shapes it introduces;",
-  "   - its fast check: the command a worker reruns while it works, seconds to a minute or two: its targeted tests plus the linter, and the type check when the project has one, scoped to the packages the lane owns.",
+  "   - its fast check: the command a worker reruns while it works, seconds to a minute or two: its targeted tests plus the linter of every package the lane touches (each package's own: golangci-lint for a Go module, its lint script for a JS one), and the type check when the project has one, scoped to those packages.",
   "",
   "   Every lane of a milestone runs at the same time, so split for width: more small lanes beat one long one.",
   "4. Speed: if the full check takes more than about five minutes, name why and make speeding it up (parallel tests, one shared fixture, fewer real-time waits) a lane of the first milestone.",
@@ -62,6 +63,7 @@ const verifier = [
   "You verify work you did not write. You get the acceptance lines, the check command and how to run the thing. You do not get the author's account of it, and you should not look for one.",
   "",
   "1. Run the check command once. Report its exit code and the failing lines. When the check has several gate items (suites, lint, builds, a boot check):",
+  "   - First call gate_check with only the run id and the milestone: it lists the items already recorded for it (reuse their names; re-check the failed ones first, each command capped at 10 minutes) and the repo's gate environment (export it before the first item; a $NAME value is a secret in that env var).",
   "   - Before each item, call the catherd MCP tool gate_check (mcp__catherd_role__gate_check for native headless Codex/Claude Code roles; mcp__plugin_catherd_catherd__gate_check for native Claude subagents) with the run id, the milestone you verify (M1, as your brief names it), the item, its command and the repo paths it depends on. When it answers carried: true, do not run the item: report it as carried over from its commit. It also tells the orchestrator which step you are on.",
   "   - After an item passes, call gate_pass (mcp__catherd_role__gate_pass, or mcp__plugin_catherd_catherd__gate_pass for native Claude subagents) with the same item, command and paths, and the evidence.",
   "   - Run independent items side by side, each heavy one wrapped in catherd lock, which queues them within the machine's slots.",
@@ -71,8 +73,10 @@ const verifier = [
   "",
   "Change nothing in the project. Do not write mutation tests or extra proof tests. The job is to find out whether the work is right, not to grade its test suite.",
   "",
+  ...VERIFIER_GATE_RULES,
+  "",
   "Return, in this order:",
-  "- VERDICT: PASS or VERDICT: FAIL on the first line.",
+  "- VERDICT: PASS or VERDICT: FAIL on the first line, or VERDICT: BLOCKED: environment — <the probe> when the machine stopped the gate.",
   "- One line per acceptance line: A<n> PASS|FAIL, the command you ran and the decisive output.",
   "- One line per gate item: PASS|FAIL, or carried over from <commit>.",
   "- Bugs outside the acceptance lines: file:line, what happens, the input that triggers it.",
diff --git a/src/services/admission.ts b/src/services/admission.ts
index 934d76c..48c3c28 100644
--- a/src/services/admission.ts
+++ b/src/services/admission.ts
@@ -37,6 +37,7 @@ import { gateEnvParts, readGateEnv } from "./gate-env.ts";
 import type { Deps } from "./ports.ts";
 import { readRecords, recordsOnThread, type Run, runPaths } from "./run-store.ts";
 import { currentSession } from "./sessions.ts";
+import { verifierBrief } from "./verifier-brief.ts";
 import { withRunAdmission } from "./workspace-admission.ts";
 
 export interface AdmitInput {
@@ -291,7 +292,8 @@ export async function admit(
     // plan 23: the verifier runs with the repo's gate environment (DOCKER_HOST, a proxy, …)
     const gate = i.role === "verifier" ? gateEnvParts(readGateEnv(run.meta.repo)) : { values: {}, refs: {} };
     // spec 1.1 §6: every brief ends with its role's reply contract, failover stand-ins' included
-    writeTextAtomic(p.brief, withReplyContract(i.role, i.brief));
+    // plan 23: a verifier's brief also carries the gate's rules and the run's recorded items
+    writeTextAtomic(p.brief, withReplyContract(i.role, verifierBrief(run, i.role, i.name, i.brief)));
     // Spec §10.4: the adapter's overrides only; the supervisor adds its own inherited env at spawn
     // time (src/entry/supervise-command.ts), so no credential is ever written to disk. 0600 all the same.
     writeJsonAtomic(
diff --git a/src/services/gate-service.ts b/src/services/gate-service.ts
index f78f2e9..27cd7a7 100644
--- a/src/services/gate-service.ts
+++ b/src/services/gate-service.ts
@@ -6,6 +6,7 @@ import { normalizeOwned, overlaps } from "../domain/lane.ts";
 import { git, gitHead, statusSnapshot } from "../infra/git.ts";
 import { repoDir } from "../infra/paths.ts";
 import { appendJsonl, ensureJsonlHeader, readJsonl } from "../infra/store.ts";
+import { gateEnvLines, readGateEnv } from "./gate-env.ts";
 import type { Deps } from "./ports.ts";
 import { findRun, type Run } from "./run-store.ts";
 
@@ -311,9 +312,6 @@ export function recordedItems(run: Run, m: string): RecordedItem[] {
   });
 }
 
-/** A re-check's cap on each command, in minutes: a hung command fails its item instead of the verifier (plan 23). */
-export const RECHECK_COMMAND_MIN = 10;
-
 /** The milestone's checked items that have not passed since their last check: what a re-check runs first. */
 export const failedItems = (run: Run, m: string): string[] =>
   recordedItems(run, m)
@@ -349,9 +347,13 @@ export async function gateCheck(
   return i.milestone ? { ...carried, recorded: recordedItems(run, i.milestone) } : carried;
 }
 
-/** `gate_check` with a milestone and no item: the milestone's recorded items, recording no step. */
-export function gateList(i: { run: string; milestone: string }): { recorded: RecordedItem[] } {
-  return { recorded: recordedItems(findRun(i.run), i.milestone) };
+/**
+ * `gate_check` with a milestone and no item: the milestone's recorded items, recording no step, and the
+ * repo's gate environment as `NAME=value` lines (a secret as `NAME=$FROM`), which a native verifier exports.
+ */
+export function gateList(i: { run: string; milestone: string }): { recorded: RecordedItem[]; env: string[] } {
+  const run = findRun(i.run);
+  return { recorded: recordedItems(run, i.milestone), env: gateEnvLines(readGateEnv(run.meta.repo)) };
 }
 
 /** `gate_pass`: records that `command` passed on the current content of `paths`, with its evidence. */
diff --git a/src/services/protocol.ts b/src/services/protocol.ts
index 837f6ba..95dcff7 100644
--- a/src/services/protocol.ts
+++ b/src/services/protocol.ts
@@ -4,7 +4,8 @@ import type { RunRecord } from "../domain/record.ts";
 import type { RouteRow } from "../domain/route.ts";
 import { ensurePrivateDir, readJsonl, writeTextAtomic } from "../infra/store.ts";
 import { type Dispatch, listDispatches, liveDispatches } from "./dispatches.ts";
-import { failedItems, RECHECK_COMMAND_MIN, type VerifierStep } from "./gate-service.ts";
+import { RECHECK_COMMAND_MIN } from "../domain/gate-brief.ts";
+import { failedItems, type VerifierStep } from "./gate-service.ts";
 import {
   countFindings,
   landedMilestones,
diff --git a/src/services/verifier-brief.ts b/src/services/verifier-brief.ts
new file mode 100644
index 0000000..3af7c6a
--- /dev/null
+++ b/src/services/verifier-brief.ts
@@ -0,0 +1,23 @@
+import { withGateNotes } from "../domain/gate-brief.ts";
+import { gateEnvLines, readGateEnv } from "./gate-env.ts";
+import { recordedItems } from "./gate-service.ts";
+import type { Run } from "./run-store.ts";
+
+// Plan 23: a dispatched verifier's brief ends with the gate's rules and the run's facts: the milestone's
+// recorded items (reuse their names), the failed ones (a re-check runs them first, each command capped), and
+// the repo's gate environment.
+
+/** The milestone a verifier dispatch checks: the first `M<n>` its name names as a word (verifier-M1 → M1). */
+export const milestoneOfName = (name: string): string | null =>
+  /(?:^|[^A-Za-z0-9])(M\d+)(?=$|[-._\s])/.exec(name)?.[1] ?? null;
+
+/** A verifier's brief with the gate notes, once; any other role's brief as it is. */
+export function verifierBrief(run: Run, role: string, name: string, brief: string): string {
+  if (role !== "verifier") return brief;
+  const milestone = milestoneOfName(name);
+  return withGateNotes(brief, {
+    milestone,
+    recorded: milestone ? recordedItems(run, milestone) : [],
+    env: gateEnvLines(readGateEnv(run.meta.repo)),
+  });
+}
diff --git a/test/domain/agents.test.ts b/test/domain/agents.test.ts
index f7f7c9d..faf7d45 100644
--- a/test/domain/agents.test.ts
+++ b/test/domain/agents.test.ts
@@ -115,9 +115,9 @@ describe("rolePrompt", () => {
     expect(text).not.toContain("first three lines");
   });
 
-  it("puts the linter and the type check in the architect's fast check", () => {
+  it("puts the linter of every package the lane touches and the type check in the architect's fast check (plan 23)", () => {
     expect(rolePrompt("architect", "1.0.0")).toContain(
-      "its targeted tests plus the linter, and the type check when the project has one, scoped to the packages the lane owns",
+      "its targeted tests plus the linter of every package the lane touches (each package's own: golangci-lint for a Go module, its lint script for a JS one), and the type check when the project has one, scoped to those packages",
     );
   });
 
diff --git a/test/services/gate-service.test.ts b/test/services/gate-service.test.ts
index 612f316..a7bbd49 100644
--- a/test/services/gate-service.test.ts
+++ b/test/services/gate-service.test.ts
@@ -321,6 +321,7 @@ describe("the gate ledger (spec 1.1 §7)", () => {
     // the list alone, recording no step; half an item is refused
     expect((await call(c, "gate_check", { run: run.id, milestone: "M1" })).data).toEqual({
       recorded: [{ item: "unit tests", command: "bun test", passed: true }],
+      env: [],
     });
     expect((await call(c, "gate_check", { run: run.id, item: "x", milestone: "M1" })).error?.code).toBe(
       "E_INPUT_INVALID",
diff --git a/test/services/verifier-brief.test.ts b/test/services/verifier-brief.test.ts
new file mode 100644
index 0000000..cb18980
--- /dev/null
+++ b/test/services/verifier-brief.test.ts
@@ -0,0 +1,82 @@
+import { afterEach, describe, expect, it } from "bun:test";
+import { execFileSync } from "node:child_process";
+import { readFileSync, writeFileSync } from "node:fs";
+import { join } from "node:path";
+import { GATE_NOTES_HEADING, gateNotes, VERIFIER_GATE_RULES } from "../../src/domain/gate-brief.ts";
+import { replyContract, rolePrompt } from "../../src/domain/role-prompts.ts";
+import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
+import { admit } from "../../src/services/admission.ts";
+import { setGateEnv } from "../../src/services/gate-env.ts";
+import { gateCheck, gatePass } from "../../src/services/gate-service.ts";
+import { milestoneOfName, verifierBrief } from "../../src/services/verifier-brief.ts";
+import { snapshotEnv } from "../helpers.ts";
+import { simPath, withScenario } from "../sim/scenario.ts";
+import { fakeDeps, freshRun, testView } from "./helpers.ts";
+
+afterEach(snapshotEnv());
+
+describe("the verifier's brief (plan 23)", () => {
+  it("names the milestone a verifier checks from its name", () => {
+    expect(milestoneOfName("verifier-M1")).toBe("M1");
+    expect(milestoneOfName("verifier-M12-recheck")).toBe("M12");
+    expect(milestoneOfName("verifier-M1fix")).toBeNull();
+    expect(milestoneOfName("verifier")).toBeNull();
+  });
+
+  it("splits the root gate from acceptance, keeps acceptance from HEAD, says BLOCKED, and prunes images", () => {
+    const rules = VERIFIER_GATE_RULES.join("\n");
+    expect(rules).toContain("each per-service acceptance suite as its own item");
+    expect(rules).toContain("Acceptance that builds from HEAD (git archive, a commit's image) is yours");
+    expect(rules).toContain("twice, 5 s apart");
+    expect(rules).toContain("docker image prune -f");
+    // the native verifier's agent file carries the same rules
+    expect(rolePrompt("verifier", "1.0.0")).toContain(rules);
+    expect(gateNotes({ milestone: null, recorded: [], env: [] })).toBe(
+      [GATE_NOTES_HEADING, "", ...VERIFIER_GATE_RULES.map((r) => `- ${r}`)].join("\n"),
+    );
+  });
+
+  it("adds the recorded items, the failed ones to re-check first with a cap, and the gate env, once", async () => {
+    const { repo, run } = freshRun();
+    writeFileSync(join(repo, "a.ts"), "a");
+    execFileSync("git", ["add", "-A"], { cwd: repo });
+    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c"], { cwd: repo });
+    const deps = fakeDeps();
+    const check = (item: string) => ({ run: run.id, item, command: item, paths: ["."], milestone: "M1" });
+    await gateCheck(deps, check("lint"));
+    await gatePass(deps, { ...check("lint"), evidence: "ok" });
+    await gateCheck(deps, check("acceptance notification"));
+    await setGateEnv(repo, "DOCKER_HOST", { value: "unix:///tmp/d.sock" });
+    const brief = verifierBrief(run, "verifier", "verifier-M1", "Verify M1.");
+    expect(brief).toStartWith(`Verify M1.\n\n${GATE_NOTES_HEADING}\n`);
+    expect(brief).toContain(
+      "- Items already recorded for M1; reuse these names in gate_check, so what passed is carried over: lint, acceptance notification.",
+    );
+    expect(brief).toContain(
+      "- This is a re-check. Run the failed items first: acceptance notification. Cap each command at 10 minutes;",
+    );
+    expect(brief).toContain("DOCKER_HOST=unix:///tmp/d.sock");
+    expect(verifierBrief(run, "verifier", "verifier-M1", brief)).toBe(brief);
+    expect(verifierBrief(run, "reviewer", "reviewer-M1", "Review M1.")).toBe("Review M1.");
+  });
+
+  it("is what dispatch writes for a verifier, before its reply contract", async () => {
+    const { run } = freshRun();
+    process.env.PATH = simPath();
+    Object.assign(process.env, withScenario({ reply: "VERDICT: PASS" }).env);
+    const view = testView();
+    view.roles.verifier = { enabled: true, access: "full", rungs: ["codex:gpt-6-sol#high"] };
+    const { d } = await admit(fakeDeps({ view }), run, {
+      role: "verifier",
+      name: "verifier-M1",
+      brief: "Verify M1.",
+      rung: "codex:gpt-6-sol#high",
+      thread: null,
+      lane: null,
+      failoverFrom: null,
+    });
+    const text = readFileSync(dispatchPaths(d.dir).brief, "utf8");
+    expect(text).toContain(GATE_NOTES_HEADING);
+    expect(text).toEndWith(`\n\n${replyContract("verifier")}\n`);
+  });
+});
diff --git a/test/skills.test.ts b/test/skills.test.ts
index df1270b..58144c6 100644
--- a/test/skills.test.ts
+++ b/test/skills.test.ts
@@ -211,7 +211,7 @@ describe("orchestrator skill, run findings", () => {
   it("puts the linter and the type check in every fast check it describes", () => {
     const s = md();
     expect(s).toContain(
-      "its targeted tests plus the linter, and the type check when the repo has one, scoped to the lane's owned packages",
+      "its targeted tests plus the linter of every package the lane touches, and the type check when the repo has one, scoped to those packages",
     );
     expect(s).toContain("its fast check (targeted tests, lint and type check), to run until it passes");
     expect(s).toContain("the lint and type-check commands, and how to scope each to one package;");
```

### Task 11: a testcontainers session per dispatch

**Scratch commit:** `7b1e604` — `feat(dispatch): each dispatch gets its own testcontainers session id`

**Files:** modify `src/services/admission.ts`, `test/services/admission.test.ts`, `docs/dev/live-verification.md` (adds section 15 with its first row).

**Produces (Ruling 24):** every dispatch's spec env has `TESTCONTAINERS_SESSION_ID: <dispatch id>` (the same id as `CATHERD_DISPATCH_ID`); `docs/dev/live-verification.md` §15 "Verifier, gate and environment (1.5, plan 23)" with the testcontainers row.

- [ ] **Step 1: the failing test.** The spec-env assertion in "keeps the server's environment out of spec.json…" (`admission.test.ts`). It fails.
- [ ] **Step 2: the code.** Apply the `admission.ts` hunk and append the section to `docs/dev/live-verification.md`.
- [ ] **Step 3:** `bun test test/services/admission.test.ts`.
- [ ] **Step 4: commit** `feat(dispatch): each dispatch gets its own testcontainers session id`.

```diff
diff --git a/docs/dev/live-verification.md b/docs/dev/live-verification.md
index ede789a..5c565db 100644
--- a/docs/dev/live-verification.md
+++ b/docs/dev/live-verification.md
@@ -924,3 +924,11 @@ catherd runs retry-push <run> <name> --event '<exact event ID>' --acknowledge-po
 Preserve all event IDs through retry/coalescing; duplicate input remains an idempotent record read. The actual catherd record and reviewer/verifier gate, not a forged or echoed envelope, determine what can land. Record accepted, ambiguous, failed and collected states separately, and retain unread work on failures.
 
 The controller records exact commands, hashes, actual host observations, deviations and unverified cases in the acceptance report. Release stays held until the real packaged flow passes in both Codex surfaces and Claude Code, including busy ordering and the unchanged gate. No daemon research, fixture, skipped test, source-only skill read or isolated handshake marks an installed skill flow passed. Keep the existing Changesets/stamp/release tooling; this section authorizes neither CI nor publication.
+
+## 15. Verifier, gate and environment (1.5, plan 23)
+
+What the simulator cannot show. Record each observation, with the versions, in the acceptance report.
+
+| Step | Required observation |
+| --- | --- |
+| Testcontainers per dispatch | Two lanes of one milestone whose fast checks start testcontainers on one Docker daemon run side by side. Each worker's env has its own `TESTCONTAINERS_SESSION_ID` (its dispatch id), and neither fails with "reaper container name already in use". If the testcontainers library in use ignores that variable, record which one, and which variable it reads instead. |
diff --git a/src/services/admission.ts b/src/services/admission.ts
index 48c3c28..381ede3 100644
--- a/src/services/admission.ts
+++ b/src/services/admission.ts
@@ -305,7 +305,14 @@ export async function admit(
         cmd: plan.cmd,
         args: plan.args,
         // plan 23: a `catherd lock` in the role reports to this dispatch, so a long gate keeps its wall alive
-        env: { ...plan.env, ...gate.values, [DISPATCH_ID_ENV]: id, PWD: plan.cwd },
+        // plan 23: each dispatch its own testcontainers session, so parallel lanes never share a reaper
+        env: {
+          ...plan.env,
+          ...gate.values,
+          [DISPATCH_ID_ENV]: id,
+          TESTCONTAINERS_SESSION_ID: id,
+          PWD: plan.cwd,
+        },
         // a secret of the gate env by reference only: the supervisor reads it from its own env at spawn
         ...(Object.keys(gate.refs).length ? { envFrom: gate.refs } : {}),
         cwd: plan.cwd,
diff --git a/test/services/admission.test.ts b/test/services/admission.test.ts
index 6914ccd..719acf5 100644
--- a/test/services/admission.test.ts
+++ b/test/services/admission.test.ts
@@ -102,7 +102,13 @@ describe("admission", () => {
     expect(text).not.toContain("s3cret");
     expect(text).not.toContain("TYPESAFE_API_KEY");
     // the adapter's overrides (a plain codex rung has none), the dispatch id for catherd lock, and PWD
-    expect(JSON.parse(text).env).toEqual({ CATHERD_DISPATCH_ID: expect.any(String), PWD: repo });
+    expect(JSON.parse(text).env).toEqual({
+      CATHERD_DISPATCH_ID: expect.any(String),
+      TESTCONTAINERS_SESSION_ID: expect.any(String),
+      PWD: repo,
+    });
+    const env = JSON.parse(text).env;
+    expect(env.TESTCONTAINERS_SESSION_ID).toBe(env.CATHERD_DISPATCH_ID);
     expect(statSync(specPath).mode & 0o777).toBe(0o600);
   });
 
```

### Task 12: provider outages fail over

**Scratch commit:** `e992868` — `feat(opencode): provider retries end the attempt as provider-unavailable, which fails over`

**Files:** modify `src/adapters/backend.ts`, `src/adapters/opencode/index.ts`, `src/domain/record.ts`, `src/domain/hints.ts`, `src/infra/supervisor.ts`, `src/entry/supervise-command.ts`, `docs/dev/live-verification.md`, `test/adapters/opencode.test.ts`, `test/adapters/opencode-session.test.ts`, `test/domain/run-rules.test.ts`, `test/infra/supervisor.test.ts`.

**Consumes:** Task 9's `record.ts`/`hints.ts`, Task 6's `supervisor.ts`/`supervise-command.ts`, Task 11's live-verification section. **Produces (Ruling 25):**
- `EXIT_REASONS` adds `"provider-unavailable"`.
- `EventDelta.step?: boolean`; `BackendAdapter.providerRetry?(thread, cwd, sinceMs): Promise<number | null>`.
- The supervisor: `PROVIDER_RETRY = { attempts: 3, ms: 180_000, pollMs: 30_000 }`; `SuperviseSpecSchema.providerRetry?` (partial override, for tests); `LineInfo.step`; `SuperviseHooks.providerRetry`; a step right after a step is a retry and not progress; `retries >= attempts` or `retrySince` older than `ms` ends the attempt `provider-unavailable`; after `pollMs` of quiet it asks `providerRetry` once per `pollMs`.
- `supervise-command.ts` passes `step` and `providerRetry`.
- opencode: `parse` sets `step` on `step_start`; `providerRetry` reads the newest assistant message's `retry.attempt` (this run's only); `isBusy` is false while it retries; `finalize` turns `provider-unavailable` into `status: "limit"`, `error.code: "provider-unavailable"`.
- `dispatchHints`: `limit: <rung>'s provider is unavailable (<message>); it fails over as on a usage limit`.
- live-verification §15: the opencode row.

- [ ] **Step 1: the failing tests.** The two supervisor tests, the opencode finalize and session tests, the hints test. They fail.
- [ ] **Step 2: the code.** Apply the source hunks and the live-verification row.
- [ ] **Step 3:** `bun test test/infra/supervisor.test.ts test/adapters/opencode.test.ts test/adapters/opencode-session.test.ts test/domain/run-rules.test.ts`; `bun run typecheck && bun run lint`.
- [ ] **Step 4: commit** `feat(opencode): provider retries end the attempt as provider-unavailable, which fails over`.

```diff
diff --git a/docs/dev/live-verification.md b/docs/dev/live-verification.md
index 5c565db..6695676 100644
--- a/docs/dev/live-verification.md
+++ b/docs/dev/live-verification.md
@@ -932,3 +932,4 @@ What the simulator cannot show. Record each observation, with the versions, in t
 | Step | Required observation |
 | --- | --- |
 | Testcontainers per dispatch | Two lanes of one milestone whose fast checks start testcontainers on one Docker daemon run side by side. Each worker's env has its own `TESTCONTAINERS_SESSION_ID` (its dispatch id), and neither fails with "reaper container name already in use". If the testcontainers library in use ignores that variable, record which one, and which variable it reads instead. |
+| opencode provider outage | On an opencode rung whose provider answers 503 (or with the network to it blocked), the stream shows `step_start` events with nothing between, or the session message carries `retry.attempt`. Within 3 retries or 3 minutes the attempt ends `provider-unavailable`, its record is a `limit` with `error.code: provider-unavailable`, and failover starts the rung's stand-in on another backend. Record whether opencode emits a `step_start` per retry on the version in use. |
diff --git a/src/adapters/backend.ts b/src/adapters/backend.ts
index 27fbadc..0150b7e 100644
--- a/src/adapters/backend.ts
+++ b/src/adapters/backend.ts
@@ -85,6 +85,11 @@ export interface EventDelta {
   limit?: boolean;
   tooOld?: boolean;
   retrying?: boolean;
+  /**
+   * plan 23: a model step started (opencode's step_start). Two in a row with nothing between are a provider retry,
+   * which the supervisor never counts as progress
+   */
+  step?: boolean;
   /** the stream's terminal event: the supervisor may kill a CLI that lingers after it */
   final?: boolean;
   /** a tool call starting (`open`) or ending: while one is open the run is busy, however quiet */
@@ -150,6 +155,11 @@ export interface BackendAdapter {
   interrupt?(thread: string, cwd: string): Promise<void>;
   /** `sinceMs`: when this run started, so what an earlier run on the thread left behind does not count */
   isBusy?(thread: string, cwd: string, sinceMs?: number): Promise<boolean>;
+  /**
+   * Plan 23: the provider retry the session is waiting out, by its attempt number, when its newest message since
+   * `sinceMs` is retrying (a 503, an overloaded backend); null when it is not
+   */
+  providerRetry?(thread: string, cwd: string, sinceMs: number): Promise<number | null>;
   /** Spec §4.5: this backend's own stand-in for a rung on a usage limit, when the profile names none. */
   failoverFor?(rung: Rung, repo?: string): Rung | null;
   /**
diff --git a/src/adapters/opencode/index.ts b/src/adapters/opencode/index.ts
index 7731faf..e9da32b 100644
--- a/src/adapters/opencode/index.ts
+++ b/src/adapters/opencode/index.ts
@@ -155,6 +155,20 @@ function finalize(run: FinishedRun): Outcome {
   const f = foldOpencodeEvents(run.eventLines);
   const stopped = run.exit.reason;
   const tooOld = f.tooOld || OPENCODE_TOO_OLD.some((r) => r.test(run.stderr));
+  // plan 23: the provider kept failing; failover takes it as a usage limit, onto the next backend
+  if (stopped === "provider-unavailable")
+    return {
+      status: "limit",
+      thread: f.thread ?? run.request.thread,
+      tokens: f.tokens,
+      costUsd: f.costUsd,
+      images: [],
+      error: {
+        code: "provider-unavailable",
+        message: f.error?.message ?? "the provider retried with no progress",
+      },
+      reply: f.reply,
+    };
   const status: RunStatus =
     stopped === "cancelled"
       ? "cancelled"
@@ -201,6 +215,8 @@ function parse(line: string): EventDelta {
   const activity = opencodeActivity(e);
   if (activity) d.activity = activity;
   if (typeof e.sessionID === "string") d.thread = e.sessionID;
+  // plan 23: each provider retry starts a step again with nothing between; the supervisor counts them
+  if (e.type === "step_start") d.step = true;
   if (e.type === "step_finish") {
     d.tokens = opencodeTokens(e.part?.tokens);
     d.requestInput = d.tokens.input;
@@ -220,6 +236,21 @@ function parse(line: string): EventDelta {
  * older messages keep their errors, so only the newest assistant message counts, and with `sinceMs` only
  * if this run wrote it.
  */
+/**
+ * Plan 23: the provider retry the newest assistant message this run wrote is waiting out (a 503, an
+ * overloaded backend), by its attempt number; null when it is not retrying.
+ */
+function providerRetryOf(messages: unknown, sinceMs: number): number | null {
+  if (!Array.isArray(messages)) return null;
+  const m = messages.find((x) => x?.type === "assistant") as Record<string, any> | undefined;
+  if (!m?.retry || !(m.time?.created >= sinceMs)) return null;
+  return typeof m.retry.attempt === "number" ? m.retry.attempt : 1;
+}
+
+async function providerRetry(thread: string, sinceMs: number): Promise<number | null> {
+  return providerRetryOf((await opencodeApi("GET", `/api/session/${thread}/message`))?.data, sinceMs);
+}
+
 function limitRetry(messages: unknown, sinceMs?: number): string | null {
   if (!Array.isArray(messages)) return null;
   const m = messages.find((x) => x?.type === "assistant") as Record<string, any> | undefined;
@@ -265,7 +296,12 @@ async function isBusy(thread: string, sinceMs?: number): Promise<boolean> {
   const active = (await opencodeApi("GET", "/api/session/active"))?.data;
   if (!active || typeof active !== "object" || !(thread in active)) return false;
   const messages = (await opencodeApi("GET", `/api/session/${thread}/message`))?.data;
-  return Array.isArray(messages) && limitRetry(messages, sinceMs) === null;
+  // plan 23: a session only retrying its provider is not busy, so the idle timeout still runs
+  return (
+    Array.isArray(messages) &&
+    limitRetry(messages, sinceMs) === null &&
+    providerRetryOf(messages, sinceMs ?? 0) === null
+  );
 }
 
 /** Killing the v2 client does not stop its session; the service must be told (research §2.4). */
@@ -327,6 +363,7 @@ export const opencodeAdapter: BackendAdapter = {
   resume: { supported: true, sameAccessOnly: false, threadPattern: THREAD },
   interrupt: (thread) => interrupt(thread),
   isBusy: (thread, _cwd, sinceMs) => isBusy(thread, sinceMs),
+  providerRetry: (thread, _cwd, sinceMs) => providerRetry(thread, sinceMs),
   failoverFor,
   graceAfterFinalMs: null,
   reportsCost: true,
diff --git a/src/domain/hints.ts b/src/domain/hints.ts
index 6e3ee06..1febb29 100644
--- a/src/domain/hints.ts
+++ b/src/domain/hints.ts
@@ -3,7 +3,12 @@ import type { RunRecord } from "./record.ts";
 /** Spec §4.4: what the orchestrator does next, read off one finished record. `dir` is the dispatch folder, relative to the run. */
 export function dispatchHints(r: RunRecord, owns: string[], dir: string): string[] {
   const h: string[] = [];
-  if (r.status === "limit") h.push(`limit: ${r.backend} hit a usage limit on ${r.rung}`);
+  if (r.status === "limit")
+    h.push(
+      r.error?.code === "provider-unavailable"
+        ? `limit: ${r.rung}'s provider is unavailable (${r.error.message}); it fails over as on a usage limit`
+        : `limit: ${r.backend} hit a usage limit on ${r.rung}`,
+    );
   if (r.status === "cli-too-old") h.push(`cli-too-old: ${r.error?.message ?? `upgrade ${r.backend}`}`);
   if (r.status === "failed") h.push(`failed: read ${dir}/stderr`);
   if (r.gitUnavailable) h.push("git-unavailable: changed files unknown");
diff --git a/src/domain/record.ts b/src/domain/record.ts
index 4cbe7ef..dc2ca70 100644
--- a/src/domain/record.ts
+++ b/src/domain/record.ts
@@ -28,6 +28,8 @@ export const EXIT_REASONS = [
   "wall-timeout",
   "cancelled",
   "lost",
+  /** plan 23: the provider kept failing (retries with no progress); failover treats it as a usage limit */
+  "provider-unavailable",
 ] as const;
 export type ExitReason = (typeof EXIT_REASONS)[number];
 export interface ExitInfo {
diff --git a/src/entry/supervise-command.ts b/src/entry/supervise-command.ts
index 99f73e1..9ffa2cc 100644
--- a/src/entry/supervise-command.ts
+++ b/src/entry/supervise-command.ts
@@ -22,15 +22,19 @@ export async function runSupervise(specPath: string): Promise<void> {
   const a = adapterFor(spec.backend);
   const busy = a?.isBusy?.bind(a);
   const stop = a?.interrupt?.bind(a);
+  const retrying = a?.providerRetry?.bind(a);
   await supervise(spec, {
     onLine: (line) => {
       const d = a?.parse(line) ?? {};
-      return { final: d.final, thread: d.thread, item: d.item };
+      return { final: d.final, thread: d.thread, item: d.item, step: d.step };
     },
     isBusy: busy
       ? (thread, sinceMs) => (thread ? busy(thread, spec.cwd, sinceMs) : Promise.resolve(false))
       : undefined,
     interrupt: stop ? (thread) => (thread ? stop(thread, spec.cwd) : Promise.resolve()) : undefined,
+    providerRetry: retrying
+      ? (thread, sinceMs) => (thread ? retrying(thread, spec.cwd, sinceMs) : Promise.resolve(null))
+      : undefined,
   });
 }
 
diff --git a/src/infra/supervisor.ts b/src/infra/supervisor.ts
index b6b8af7..f2e18f3 100644
--- a/src/infra/supervisor.ts
+++ b/src/infra/supervisor.ts
@@ -28,15 +28,28 @@ export const SuperviseSpecSchema = z.looseObject({
   killGraceMs: z.number().nonnegative(),
   graceAfterFinalMs: z.number().nonnegative().nullable(),
   pollMs: z.number().positive(),
+  /** plan 23: when provider retries end an attempt; PROVIDER_RETRY when absent (tests shorten it) */
+  providerRetry: z
+    .object({ attempts: z.number().positive(), ms: z.number().positive(), pollMs: z.number().positive() })
+    .partial()
+    .optional(),
 });
 export type SuperviseSpec = z.infer<typeof SuperviseSpecSchema>;
 
+/**
+ * Plan 23: an attempt that has only retried its provider (3 retries, or 3 min of nothing else) ends as
+ * provider-unavailable; a quiet session's own retry field is read every pollMs.
+ */
+export const PROVIDER_RETRY = { attempts: 3, ms: 180_000, pollMs: 30_000 };
+
 /** What one stream line tells the supervisor: the terminal event, the thread, a tool call opening or closing. */
 interface LineInfo {
   final?: boolean;
   thread?: string;
   /** a tool call the CLI started (`open`) or finished: while one is open the run is busy, however quiet */
   item?: { id: string; open: boolean };
+  /** plan 23: a model step started; one right after another, with nothing between, is a provider retry */
+  step?: boolean;
 }
 
 export interface SuperviseHooks {
@@ -44,6 +57,8 @@ export interface SuperviseHooks {
   /** `sinceMs`: when this run started, so a backend can ignore what an earlier run on the thread left */
   isBusy?(thread: string | null, sinceMs: number): Promise<boolean>;
   interrupt?(thread: string | null): Promise<void>;
+  /** plan 23: the provider retry attempt the session waits out (its own retry field), or null */
+  providerRetry?(thread: string | null, sinceMs: number): Promise<number | null>;
 }
 
 /** Reads whatever the child appended to `file` since `offset`, as complete lines. */
@@ -201,20 +216,39 @@ async function superviseHeld(spec: SuperviseSpec, hooks: SuperviseHooks): Promis
     const open = new Set<string>();
     const stream = { offset: 0, rest: "", decoder: new TextDecoder("utf-8") };
 
+    // plan 23: a step that starts right after another with nothing between is a provider retry; retries are
+    // not progress, and enough of them (or a long enough stretch) end the attempt as provider-unavailable
+    let lastWasStep = false;
+    let retries = 0;
+    let retrySince: number | null = null;
+    let lastRetryPoll = started;
+    const retry = { ...PROVIDER_RETRY, ...spec.providerRetry };
+
     while (!done && reason === null) {
       await Bun.sleep(spec.pollMs);
       const lines = readNew(p.events, stream);
-      if (lines.length) {
-        lastActivity = Date.now();
-        stallChecked = false;
-      }
+      let progress = false;
       for (const line of lines) {
         let d: LineInfo | undefined;
         try {
           d = hooks.onLine?.(line);
         } catch {
-          continue; // one line the hook cannot read must not end supervision
+          // one line the hook cannot read must not end supervision; it is output all the same
+          progress = true;
+          lastWasStep = false;
+          continue;
         }
+        if (d?.step && lastWasStep) {
+          retries++;
+          retrySince ??= Date.now();
+        } else {
+          progress = true;
+          if (!d?.step) {
+            retries = 0;
+            retrySince = null;
+          }
+        }
+        lastWasStep = d?.step === true;
         if (d?.thread) thread = d.thread;
         if (d?.final) finalAt ??= Date.now();
         if (d?.item) {
@@ -222,6 +256,23 @@ async function superviseHeld(spec: SuperviseSpec, hooks: SuperviseHooks): Promis
           else open.delete(d.item.id);
         }
       }
+      if (progress) {
+        lastActivity = Date.now();
+        stallChecked = false;
+      }
+      // plan 23: a session quiet for a while may be waiting out a provider retry the stream does not show
+      if (
+        hooks.providerRetry &&
+        Date.now() - lastActivity >= retry.pollMs &&
+        Date.now() - lastRetryPoll >= retry.pollMs
+      ) {
+        lastRetryPoll = Date.now();
+        const attempt = await bounded(() => hooks.providerRetry?.(thread, started), hookMs, null);
+        if (attempt !== null) {
+          retrySince ??= Date.now();
+          retries = Math.max(retries, attempt);
+        }
+      }
       // a worker that ended on its own is recorded as it ended, even if a cancel or a limit arrived meanwhile
       if (done) break;
       const now = Date.now();
@@ -231,6 +282,8 @@ async function superviseHeld(spec: SuperviseSpec, hooks: SuperviseHooks): Promis
         reason = "wall-timeout";
       else if (finalAt !== null && spec.graceAfterFinalMs !== null && now - finalAt >= spec.graceAfterFinalMs)
         reason = "after-final";
+      else if (retries >= retry.attempts || (retrySince !== null && now - retrySince >= retry.ms))
+        reason = "provider-unavailable";
       else if (now - lastActivity >= spec.idleMs) {
         const busy = open.size > 0 || (await bounded(() => hooks.isBusy?.(thread, started), hookMs, false));
         // the busy check can take up to hookMs: a worker that ended meanwhile is recorded as it ended, read
diff --git a/test/adapters/opencode-session.test.ts b/test/adapters/opencode-session.test.ts
index 309cc5e..f55b727 100644
--- a/test/adapters/opencode-session.test.ts
+++ b/test/adapters/opencode-session.test.ts
@@ -42,6 +42,23 @@ describe("opencode busy and interrupt", () => {
     expect(await opencodeAdapter.isBusy?.(SES, "/repo")).toBe(false);
   });
 
+  it("reads a provider retry from the session, and is not busy while it waits one out (plan 23)", async () => {
+    const overloaded = { type: "service_overloaded", message: "503 The backend is temporarily overloaded" };
+    onSim({
+      active: { [SES]: { type: "running" } },
+      messages: [{ type: "assistant", time: { created: 5_000 }, retry: { attempt: 6, error: overloaded } }],
+    });
+    expect(await opencodeAdapter.providerRetry?.(SES, "/repo", 1_000)).toBe(6);
+    expect(await opencodeAdapter.isBusy?.(SES, "/repo", 1_000)).toBe(false);
+    // a retry an earlier run left behind does not count
+    expect(await opencodeAdapter.providerRetry?.(SES, "/repo", 9_000)).toBeNull();
+    onSim({
+      active: { [SES]: { type: "running" } },
+      messages: [{ type: "assistant", time: { created: 5_000 } }],
+    });
+    expect(await opencodeAdapter.providerRetry?.(SES, "/repo", 1_000)).toBeNull();
+  });
+
   it("is not busy while it only waits out a usage limit", async () => {
     onSim({
       active: { [SES]: { type: "running" } },
diff --git a/test/adapters/opencode.test.ts b/test/adapters/opencode.test.ts
index f13405c..3001e66 100644
--- a/test/adapters/opencode.test.ts
+++ b/test/adapters/opencode.test.ts
@@ -113,6 +113,19 @@ describe("opencode finalize", () => {
     expect(o).toMatchObject({ status: "failed", error: { message: "boom" }, thread: null });
   });
 
+  it("ends a provider outage as a limit, so failover moves the lane to the next backend (plan 23)", () => {
+    const o = opencodeAdapter.finalize(
+      finished([], { exit: { code: null, signal: "SIGTERM", reason: "provider-unavailable", endedAt: "x" } }),
+    );
+    expect(o).toMatchObject({
+      status: "limit",
+      error: { code: "provider-unavailable", message: "the provider retried with no progress" },
+    });
+    // a step start is what the supervisor counts
+    expect(opencodeAdapter.parse(lines("shell-ok.jsonl")[0] as string).step).toBe(true);
+    expect(opencodeAdapter.parse(lines("shell-ok.jsonl")[3] as string).step).toBeUndefined();
+  });
+
   it("keeps the thread of a resumed run with no events", () => {
     const thread = "ses_f2671cde4ffe4VbeG6dKWzM2vi";
     expect(opencodeAdapter.finalize(finished([], { request: req({ thread }) })).thread).toBe(thread);
diff --git a/test/domain/run-rules.test.ts b/test/domain/run-rules.test.ts
index c86d630..d91a602 100644
--- a/test/domain/run-rules.test.ts
+++ b/test/domain/run-rules.test.ts
@@ -93,6 +93,16 @@ describe("dispatchHints", () => {
     ]);
   });
 
+  it("names a provider outage apart from a usage limit, failing over the same way (plan 23)", () => {
+    const r = makeRecord({
+      status: "limit",
+      error: { code: "provider-unavailable", message: "503 service_overloaded" },
+    });
+    expect(dispatchHints(r, ["src/a.ts"], dir)[0]).toBe(
+      "limit: codex:gpt-6-sol#medium's provider is unavailable (503 service_overloaded); it fails over as on a usage limit",
+    );
+  });
+
   it("says the changes are unknown, not unchanged, when git could not see them", () => {
     const r = makeRecord({ changedOwned: [], gitUnavailable: true });
     expect(dispatchHints(r, ["src/a.ts"], dir)).toEqual(["git-unavailable: changed files unknown"]);
diff --git a/test/infra/supervisor.test.ts b/test/infra/supervisor.test.ts
index 28fd3d1..f96098b 100644
--- a/test/infra/supervisor.test.ts
+++ b/test/infra/supervisor.test.ts
@@ -106,6 +106,50 @@ describe("supervise", () => {
     expect(Date.now() - at).toBeLessThan(5_000);
   });
 
+  it("ends an attempt that only retries its provider as provider-unavailable (plan 23)", async () => {
+    const step = (l: string) => ({ step: l.includes("step_start") });
+    // four step starts in a row with nothing between: three retries
+    const retried = spec(`for i in 1 2 3 4; do echo '{"type":"step_start"}'; done; sleep 30`, {
+      idleMs: 60_000,
+    });
+    expect((await supervise(retried, { onLine: step }))?.reason).toBe("provider-unavailable");
+    // or a long enough stretch of retries, however few
+    const slow = spec(`while true; do echo '{"type":"step_start"}'; sleep 0.05; done`, {
+      idleMs: 60_000,
+      providerRetry: { attempts: 1_000, ms: 300 },
+    });
+    expect((await supervise(slow, { onLine: step }))?.reason).toBe("provider-unavailable");
+    // a step with work after it is progress, not a retry
+    const working = spec(
+      `for i in 1 2 3 4 5; do echo '{"type":"step_start"}'; echo '{"type":"text"}'; done; exit 0`,
+      { idleMs: 60_000 },
+    );
+    expect((await supervise(working, { onLine: step }))?.reason).toBe("exited");
+  });
+
+  it("never counts retry-only events as activity, and reads a quiet session's own retry field (plan 23)", async () => {
+    const step = (l: string) => ({ step: l.includes("step_start") });
+    const idle = spec(`while true; do echo '{"type":"step_start"}'; sleep 0.05; done`, {
+      idleMs: 400,
+      providerRetry: { attempts: 1_000, ms: 600_000 },
+    });
+    expect((await supervise(idle, { onLine: step, isBusy: async () => false }))?.reason).toBe("idle-timeout");
+    const quiet = spec(`echo '{"type":"text"}'; sleep 30`, {
+      idleMs: 60_000,
+      providerRetry: { pollMs: 50 },
+    });
+    let asked = 0;
+    const exit = await supervise(quiet, {
+      onLine: step,
+      providerRetry: async () => {
+        asked++;
+        return 6;
+      },
+    });
+    expect(exit?.reason).toBe("provider-unavailable");
+    expect(asked).toBeGreaterThan(0);
+  });
+
   it("kills a CLI that lingers after its final event", async () => {
     const s = spec(`echo '{"type":"result"}'; sleep 30`, { graceAfterFinalMs: 100 });
     const exit = await supervise(s, { onLine: (l) => ({ final: l.includes("result") }) });
```

### Task 13: doctor's Docker and toolchain-cache rows

**Scratch commit:** `42aacf0` — `feat(doctor): docker client proxies, a compose network probe, docker disk and toolchain caches`

**Files:** create `src/services/doctor-docker.ts`, `test/services/doctor-docker.test.ts`; modify `src/services/doctor.ts`, `src/entry/doctor-command.ts`, `README.md`, `docs/dev/live-verification.md`, `test/services/doctor.test.ts`.

**Consumes:** Task 5's `probeTwice`, `probeTargets.docker` (`CATHERD_PROBE_DOCKER`), `toolchainCaches()`, `runCli`. **Produces (Rulings 21–23; Owner question 1):**
- `src/services/doctor-docker.ts`: `dockerDisk = { minFreeBytes: 10 GiB }`, `composeProbe = { timeoutMs: 120_000 }`, `dockerConfigFile(env?)`, `proxiesCheck(file?)` (row `docker-proxies`, warn), `dockerChecks({ probe })` (proxies always; with `probe` and a daemon that answers: `docker-network` from a two-service busybox compose project, `up --abort-on-container-exit --exit-code-from probe` then `down -v`, retried once 5 s later; `docker-disk` when Docker's data root is local and under the floor), `cachesCheck(caches?)` (row `caches`: ok, skip none, or warn not writable).
- `doctor`: `DoctorDeps.docker?: boolean`; the `caches` row and the Docker rows go right after `locks`, before the access probes; `catherd doctor --docker`.
- README's doctor row; live-verification §15: the doctor and long-gate rows.

- [ ] **Step 1: the failing tests.** `test/services/doctor-docker.test.ts` (new); the `caches` row in "is ready when everything the active profile needs works…" (`doctor.test.ts`). They fail.
- [ ] **Step 2: the code.** Create the module; apply the other hunks.
- [ ] **Step 3:** `bun test test/services/doctor-docker.test.ts test/services/doctor.test.ts test/entry/doctor-command.test.ts test/entry/help-text.test.ts`; `bun run typecheck && bun run lint && bun run format:check`.
- [ ] **Step 4: commit** `feat(doctor): docker client proxies, a compose network probe, docker disk and toolchain caches`.

```diff
diff --git a/README.md b/README.md
index f65dc10..9e77f26 100644
--- a/README.md
+++ b/README.md
@@ -185,25 +185,25 @@ This acknowledges possible duplicate native input; an accepted receipt still sup
 
 In a terminal:
 
-| Command                                                                                     | What it does                                                                                        |
-| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
-| `catherd`                                                                                   | The dashboard: Status, Profiles and Runs (below)                                                    |
-| `catherd init [--host codex\|claude-code\|auto] [--no-input] [--no-global] [--profile <p>]` | First-run setup; installs the global `catherd` at its own version unless `--no-global`              |
-| `catherd doctor [--host codex\|claude-code\|auto] [--test-push] [--json]`                   | Readiness and capability report; no send unless explicit smoke; exits 3 when not ready              |
-| `catherd profile list\|show\|use [--repo]\|new [--from <p>]\|copy\|rm\|diff\|validate`      | Profiles; `use --repo` binds one to the repo you are in                                             |
-| `catherd profile use --repo --clear`                                                        | Unbinds the repo you are in; it runs on the active profile again                                    |
-| `catherd profile set <path> <value> [--profile <p>]`                                        | One field, e.g. `roles.verifier.access read-only`, `roles.worker.network false`, `budget.usd 20`    |
-| `catherd status [run]`, `catherd watch [--once] [--interval <s>]`                           | Where runs stand, grouped by host and session; read-only ownership                                  |
-| `catherd runs list [--repo <path>]\|show <id> [--debug [--name <n>]]\|cancel <id> <name>`   | Past runs, by session; `--debug` adds exit.json and the stderr and event tails, `--name` one role's |
-| `catherd catalog refresh\|list [--backend <b>] [--role <r>] [--text <t>] [--scored]`        | The models catherd can place, filtered                                                              |
-| `catherd catalog sync [--force] [--unmatched]`                                              | Fetches the public model facts and scores now (below); `--unmatched` lists ids no model matched     |
-| `catherd catalog treat-like <rung> <like>`                                                  | Scores an unscored rung as a scored one                                                             |
-| `catherd catalog treat-like --suggest <rung>\|--clear <rung>\|--reset`                      | The three nearest stand-ins for a rung; removes one or every mapping of yours                       |
-| `catherd knowledge show\|add "<line>"\|path [--repo <path>]`                                | The repo's knowledge.md, which new runs read; `add` appends a fact of yours, marked "by hand"       |
-| `catherd knowledge env set NAME=value\|NAME --from VAR`, `env rm NAME`, `env list`          | The repo's gate environment, which the verifier and preflight run with; a secret by reference only  |
-| `catherd lock [--slots N] -- <cmd>`                                                         | Runs a heavy command behind the machine-wide semaphore, in its own session (no /dev/tty)            |
-| `catherd mcp`                                                                               | The MCP server on stdio; the plugin starts it, you never need to                                    |
-| `catherd capture-fixtures [--backend <b>] [--out <dir>]`                                    | Contributors: records sanitized test fixtures from real runs (see CONTRIBUTING.md)                  |
+| Command                                                                                     | What it does                                                                                                                                    |
+| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
+| `catherd`                                                                                   | The dashboard: Status, Profiles and Runs (below)                                                                                                |
+| `catherd init [--host codex\|claude-code\|auto] [--no-input] [--no-global] [--profile <p>]` | First-run setup; installs the global `catherd` at its own version unless `--no-global`                                                          |
+| `catherd doctor [--host codex\|claude-code\|auto] [--test-push] [--docker] [--json]`        | Readiness and capability report; no send unless explicit smoke; `--docker` probes a compose network and the Docker disk; exits 3 when not ready |
+| `catherd profile list\|show\|use [--repo]\|new [--from <p>]\|copy\|rm\|diff\|validate`      | Profiles; `use --repo` binds one to the repo you are in                                                                                         |
+| `catherd profile use --repo --clear`                                                        | Unbinds the repo you are in; it runs on the active profile again                                                                                |
+| `catherd profile set <path> <value> [--profile <p>]`                                        | One field, e.g. `roles.verifier.access read-only`, `roles.worker.network false`, `budget.usd 20`                                                |
+| `catherd status [run]`, `catherd watch [--once] [--interval <s>]`                           | Where runs stand, grouped by host and session; read-only ownership                                                                              |
+| `catherd runs list [--repo <path>]\|show <id> [--debug [--name <n>]]\|cancel <id> <name>`   | Past runs, by session; `--debug` adds exit.json and the stderr and event tails, `--name` one role's                                             |
+| `catherd catalog refresh\|list [--backend <b>] [--role <r>] [--text <t>] [--scored]`        | The models catherd can place, filtered                                                                                                          |
+| `catherd catalog sync [--force] [--unmatched]`                                              | Fetches the public model facts and scores now (below); `--unmatched` lists ids no model matched                                                 |
+| `catherd catalog treat-like <rung> <like>`                                                  | Scores an unscored rung as a scored one                                                                                                         |
+| `catherd catalog treat-like --suggest <rung>\|--clear <rung>\|--reset`                      | The three nearest stand-ins for a rung; removes one or every mapping of yours                                                                   |
+| `catherd knowledge show\|add "<line>"\|path [--repo <path>]`                                | The repo's knowledge.md, which new runs read; `add` appends a fact of yours, marked "by hand"                                                   |
+| `catherd knowledge env set NAME=value\|NAME --from VAR`, `env rm NAME`, `env list`          | The repo's gate environment, which the verifier and preflight run with; a secret by reference only                                              |
+| `catherd lock [--slots N] -- <cmd>`                                                         | Runs a heavy command behind the machine-wide semaphore, in its own session (no /dev/tty)                                                        |
+| `catherd mcp`                                                                               | The MCP server on stdio; the plugin starts it, you never need to                                                                                |
+| `catherd capture-fixtures [--backend <b>] [--out <dir>]`                                    | Contributors: records sanitized test fixtures from real runs (see CONTRIBUTING.md)                                                              |
 
 A profile command without a profile name (`show`, `set`, `diff`, `validate`), like the MCP profile tools, acts
 on the profile the repo you are in runs on: the one bound to it, else the active one. Pass `repo` explicitly to MCP tools; profile CLI commands accept `--host` for effective defaults. Run them as
diff --git a/docs/dev/live-verification.md b/docs/dev/live-verification.md
index 6695676..6dfdf98 100644
--- a/docs/dev/live-verification.md
+++ b/docs/dev/live-verification.md
@@ -933,3 +933,5 @@ What the simulator cannot show. Record each observation, with the versions, in t
 | --- | --- |
 | Testcontainers per dispatch | Two lanes of one milestone whose fast checks start testcontainers on one Docker daemon run side by side. Each worker's env has its own `TESTCONTAINERS_SESSION_ID` (its dispatch id), and neither fails with "reaper container name already in use". If the testcontainers library in use ignores that variable, record which one, and which variable it reads instead. |
 | opencode provider outage | On an opencode rung whose provider answers 503 (or with the network to it blocked), the stream shows `step_start` events with nothing between, or the session message carries `retry.attempt`. Within 3 retries or 3 minutes the attempt ends `provider-unavailable`, its record is a `limit` with `error.code: provider-unavailable`, and failover starts the rung's stand-in on another backend. Record whether opencode emits a `step_start` per retry on the version in use. |
+| doctor --docker | On a machine whose `~/.docker/config.json` has a `proxies` block, plain `catherd doctor` warns `docker-proxies`; `catherd doctor --docker` reports `compose network` blocked after two tries 5 s apart, and ready once the block is removed. With less than 10 GB free in Docker's data root on Linux, `docker-disk` warns; on macOS (Docker in a VM) the row is absent. |
+| Long gate behind catherd lock | A verifier whose root gate runs longer than its `wallMin` behind `catherd lock`, printing as it goes, is not stopped at `wallMin`; with the gate silent for `wallMin`, it is. `roles.verifier.timeouts.wallMin` raises the wall for that role alone. |
diff --git a/src/entry/doctor-command.ts b/src/entry/doctor-command.ts
index 231dda2..0943579 100644
--- a/src/entry/doctor-command.ts
+++ b/src/entry/doctor-command.ts
@@ -42,6 +42,11 @@ export const doctorCommand = defineCommand({
       description:
         "send one labeled smoke to the validated original session (receipt does not prove processing)",
     },
+    docker: {
+      type: "boolean",
+      description:
+        "also probe Docker as a gate sees it: two compose services reaching each other by name, and the free disk (pulls busybox)",
+    },
     plain: { type: "boolean", description: "ASCII glyphs (NO_COLOR drops only colour)" },
   },
   async run({ args }) {
@@ -52,6 +57,7 @@ export const doctorCommand = defineCommand({
       version: VERSION,
       handshake: () => mcpHandshake(),
       testPush: args["test-push"] === true,
+      docker: args.docker === true,
     });
     if (args.json) printJson(r);
     else for (const l of formatReport(r, args.plain === true)) console.log(l);
diff --git a/src/services/doctor-docker.ts b/src/services/doctor-docker.ts
new file mode 100644
index 0000000..d4edbf3
--- /dev/null
+++ b/src/services/doctor-docker.ts
@@ -0,0 +1,196 @@
+import {
+  accessSync,
+  constants,
+  existsSync,
+  mkdtempSync,
+  readFileSync,
+  rmSync,
+  statfsSync,
+  writeFileSync,
+} from "node:fs";
+import { homedir } from "node:os";
+import { join } from "node:path";
+import { realTmpdir, toolchainCaches } from "../adapters/access.ts";
+import { runCli } from "../adapters/cli.ts";
+import { probeTwice } from "../infra/host-probe.ts";
+import { probeTargets } from "./doctor-access.ts";
+import type { Check } from "./doctor-checks.ts";
+
+// Plan 23: the rows that catch what cost the identity and payment runs their verifier rounds: a Docker client
+// that injects proxies into every container, a compose network whose services cannot reach each other by
+// name, a Docker disk about to fill, and the toolchain caches a sandboxed worker writes.
+
+/** Under this much free space in Docker's data root, doctor warns: image builds start failing near it (tests raise it). */
+export const dockerDisk = { minFreeBytes: 10 * 1024 ** 3 };
+
+/** How long the compose probe may take, an image pull included. */
+export const composeProbe = { timeoutMs: 120_000 };
+
+/** The Docker client's config file: $DOCKER_CONFIG/config.json, else ~/.docker/config.json. */
+export const dockerConfigFile = (env = process.env): string =>
+  join(env.DOCKER_CONFIG || join(env.HOME || homedir(), ".docker"), "config.json");
+
+/** A `proxies` block in the Docker client's config: every container then gets HTTP_PROXY and its siblings. */
+export function proxiesCheck(file = dockerConfigFile()): Check | null {
+  let config: { proxies?: unknown };
+  try {
+    config = JSON.parse(readFileSync(file, "utf8")) as { proxies?: unknown };
+  } catch {
+    return null;
+  }
+  if (!config.proxies || typeof config.proxies !== "object") return null;
+  return {
+    id: "docker-proxies",
+    label: "Docker client proxies",
+    state: "warn",
+    word: "injects proxies",
+    detail: `${file} has a proxies block: every container gets HTTP_PROXY, so compose services cannot reach each other by name and a loopback health check goes to the proxy`,
+    fix: `remove the proxies block from ${file}, or add the compose service names and 127.0.0.1 to its noProxy`,
+  };
+}
+
+/** Two busybox services: `web` serves on 8080 with a loopback health check, `probe` fetches it by name. */
+const COMPOSE = `services:
+  web:
+    image: busybox:1.36
+    command: ["httpd", "-f", "-p", "8080", "-h", "/etc"]
+    healthcheck:
+      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/hostname"]
+      interval: 1s
+      retries: 30
+  probe:
+    image: busybox:1.36
+    depends_on:
+      web:
+        condition: service_healthy
+    command: ["wget", "-q", "-O", "/dev/null", "http://web:8080/hostname"]
+`;
+
+/** `docker compose up` on the two-service file, then `down`; the result of the up. */
+async function composeUp(docker: string): Promise<{ ok: boolean; why: string }> {
+  const dir = mkdtempSync(join(realTmpdir(), "catherd-compose-"));
+  const file = join(dir, "compose.yaml");
+  writeFileSync(file, COMPOSE);
+  const project = ["compose", "-p", `catherd-doctor-${process.pid}`, "-f", file];
+  try {
+    const up = await runCli(
+      docker,
+      [...project, "up", "--abort-on-container-exit", "--exit-code-from", "probe"],
+      {
+        timeoutMs: composeProbe.timeoutMs,
+        cwd: dir,
+      },
+    );
+    const lines = `${up?.err ?? ""}\n${up?.out ?? ""}`
+      .split("\n")
+      .map((l) => l.trim())
+      .filter(Boolean);
+    return { ok: up?.ok === true, why: lines.at(-1) ?? "no output" };
+  } finally {
+    await runCli(docker, [...project, "down", "-v", "--remove-orphans"], { timeoutMs: 30_000, cwd: dir });
+    rmSync(dir, { recursive: true, force: true });
+  }
+}
+
+/** Free bytes in Docker's data root, when it is on this machine's disk; null when Docker runs in a VM. */
+async function dockerFree(docker: string): Promise<{ root: string; free: number } | null> {
+  const r = await runCli(docker, ["info", "--format", "{{.DockerRootDir}}"], { timeoutMs: 15_000 });
+  const root = r?.ok ? r.out.trim() : "";
+  if (!root || !existsSync(root)) return null;
+  try {
+    const s = statfsSync(root);
+    return { root, free: Number(s.bavail) * Number(s.bsize) };
+  } catch {
+    return null;
+  }
+}
+
+const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
+
+/**
+ * The Docker rows: the client's proxies, read from its config file; with `probe` (`catherd doctor --docker`), when
+ * a daemon answers, the compose network probe (retried once after 5 s before it calls the host blocked) and the
+ * free space in Docker's data root. The probes pull busybox and start containers, so a plain doctor skips them.
+ */
+export async function dockerChecks(o: { probe: boolean }): Promise<Check[]> {
+  const docker = probeTargets.docker;
+  const checks: Check[] = [];
+  const proxies = proxiesCheck();
+  if (proxies) checks.push(proxies);
+  if (!o.probe) return checks;
+  const version = await runCli(docker, ["version"], { timeoutMs: 15_000 });
+  if (!version?.ok) return checks;
+  const compose = await runCli(docker, ["compose", "version"], { timeoutMs: 15_000 });
+  if (compose?.ok) {
+    const { result, attempts } = await probeTwice(
+      () => composeUp(docker),
+      (r) => r.ok,
+    );
+    checks.push(
+      result.ok
+        ? {
+            id: "docker-network",
+            label: "compose network",
+            state: "ok",
+            word: "ready",
+            detail: "two services reach each other by name, and a loopback health check passes",
+          }
+        : {
+            id: "docker-network",
+            label: "compose network",
+            state: "warn",
+            word: "blocked",
+            detail: `a compose service could not reach another by name, or its loopback health check failed (${attempts} tries, 5 s apart): ${result.why}`,
+            fix: proxies
+              ? (proxies.fix as string)
+              : "check the Docker client's proxies, a VPN or socket filter on the Docker bridge, and that busybox can be pulled",
+          },
+    );
+  }
+  const free = await dockerFree(docker);
+  if (free && free.free < dockerDisk.minFreeBytes)
+    checks.push({
+      id: "docker-disk",
+      label: "Docker disk",
+      state: "warn",
+      word: "low",
+      detail: `${gb(free.free)} free in Docker's data root ${free.root}; builds fail with no space left on device`,
+      fix: "docker image prune -f, then docker builder prune -f",
+    });
+  return checks;
+}
+
+/** Whether this user may write `dir`. */
+const writable = (dir: string): boolean => {
+  try {
+    accessSync(dir, constants.W_OK);
+    return true;
+  } catch {
+    return false;
+  }
+};
+
+/**
+ * The toolchain caches present on the machine (Go's build and module caches, the pnpm store, Bun's and npm's
+ * caches), which join every workspace-write worker's writable roots; a warning for one this user cannot write.
+ */
+export function cachesCheck(caches = toolchainCaches()): Check {
+  const base = { id: "caches", label: "toolchain caches" };
+  if (caches.length === 0)
+    return { ...base, state: "skip", word: "none", detail: "no Go, pnpm, Bun or npm cache on this machine" };
+  const blocked = caches.filter((c) => !writable(c));
+  return blocked.length
+    ? {
+        ...base,
+        state: "warn",
+        word: "not writable",
+        detail: `${blocked.join(", ")}: a worker's checks cannot write it, even with it in their writable roots`,
+        fix: `chown -R "$(id -un)" ${blocked.join(" ")}`,
+      }
+    : {
+        ...base,
+        state: "ok",
+        word: "ready",
+        detail: `in every workspace-write worker's writable roots: ${caches.join(", ")}`,
+      };
+}
diff --git a/src/services/doctor.ts b/src/services/doctor.ts
index 5b9910e..8d19e29 100644
--- a/src/services/doctor.ts
+++ b/src/services/doctor.ts
@@ -12,6 +12,7 @@ import { accessChecks } from "./doctor-access.ts";
 import { backendChecks, usedBackends } from "./doctor-backends.ts";
 import { type PushProbe, pushCheck, probePush } from "./doctor-push.ts";
 import { sourcesCheck, standInsToConfirmIn } from "./doctor-sources.ts";
+import { cachesCheck, dockerChecks } from "./doctor-docker.ts";
 import { roleMcpChecks } from "./doctor-role-mcp.ts";
 import {
   agentsCheck,
@@ -67,6 +68,8 @@ export interface DoctorDeps {
   /** Explicit smoke test injection; default doctor never invokes it. */
   push?: () => Promise<PushProbe>;
   testPush?: boolean;
+  /** plan 23: `--docker`: run the Docker host probes (a compose network by service name, the free disk) */
+  docker?: boolean;
   env?: Record<string, string | undefined>;
   jev?: JevTransport;
 }
@@ -293,6 +296,9 @@ export async function doctor(d: DoctorDeps): Promise<DoctorReport> {
   }
 
   checks.push(locksCheck());
+  // plan 23: the toolchain caches workers write, and Docker as a gate sees it (before the access probes)
+  checks.push(cachesCheck());
+  checks.push(...(await dockerChecks({ probe: d.docker === true })));
   // spec §5 and §12: which codex sandbox form runs, and the five access probes per workspace-write backend
   checks.push(...(await accessChecks(profiles, installed)));
 
diff --git a/test/services/doctor-docker.test.ts b/test/services/doctor-docker.test.ts
new file mode 100644
index 0000000..5caba77
--- /dev/null
+++ b/test/services/doctor-docker.test.ts
@@ -0,0 +1,110 @@
+import { afterEach, beforeEach, describe, expect, it } from "bun:test";
+import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
+import { join } from "node:path";
+import { hostProbe } from "../../src/infra/host-probe.ts";
+import { cachesCheck, dockerChecks, dockerDisk, proxiesCheck } from "../../src/services/doctor-docker.ts";
+import { snapshotEnv, tempDir } from "../helpers.ts";
+
+afterEach(snapshotEnv());
+const saved = { retryMs: hostProbe.retryMs, minFree: dockerDisk.minFreeBytes };
+beforeEach(() => {
+  hostProbe.retryMs = 0;
+});
+afterEach(() => {
+  hostProbe.retryMs = saved.retryMs;
+  dockerDisk.minFreeBytes = saved.minFree;
+});
+
+/** A fake docker: `compose … up` fails the first `failures` times; `info` names `root`; every call is logged. */
+function fakeDocker(o: { failures: number; root: string }): { log: string } {
+  const dir = tempDir("catherd-docker-");
+  const log = join(dir, "calls");
+  const count = join(dir, "ups");
+  writeFileSync(count, "0");
+  const bin = join(dir, "docker");
+  writeFileSync(
+    bin,
+    [
+      "#!/bin/sh",
+      `echo "$*" >> '${log}'`,
+      'case "$*" in',
+      `  *" up "*) n=$(cat '${count}'); echo $((n + 1)) > '${count}'; if [ "$n" -lt ${o.failures} ]; then echo 'wget: bad address web:8080' >&2; exit 1; fi ;;`,
+      `  info*) echo '${o.root}' ;;`,
+      "esac",
+      "exit 0",
+      "",
+    ].join("\n"),
+  );
+  chmodSync(bin, 0o755);
+  process.env.CATHERD_PROBE_DOCKER = bin;
+  return { log };
+}
+
+describe("doctor's Docker rows (plan 23)", () => {
+  it("warns on a Docker client config with a proxies block, and says nothing without one", () => {
+    const dir = tempDir("catherd-dockercfg-");
+    const file = join(dir, "config.json");
+    writeFileSync(file, JSON.stringify({ proxies: { default: { httpProxy: "http://proxy:3128" } } }));
+    expect(proxiesCheck(file)).toMatchObject({
+      id: "docker-proxies",
+      state: "warn",
+      word: "injects proxies",
+    });
+    writeFileSync(file, JSON.stringify({ auths: {} }));
+    expect(proxiesCheck(file)).toBeNull();
+    expect(proxiesCheck(join(dir, "missing.json"))).toBeNull();
+  });
+
+  it("runs no docker without --docker, and reads the proxies block from DOCKER_CONFIG", async () => {
+    const { log } = fakeDocker({ failures: 0, root: "/nonexistent" });
+    const cfg = tempDir("catherd-dockercfg-");
+    writeFileSync(join(cfg, "config.json"), JSON.stringify({ proxies: {} }));
+    process.env.DOCKER_CONFIG = cfg;
+    const rows = await dockerChecks({ probe: false });
+    expect(rows.map((c) => c.id)).toEqual(["docker-proxies"]);
+    expect(() => readFileSync(log, "utf8")).toThrow();
+  });
+
+  it("probes two compose services by name, retrying once before it calls the network blocked", async () => {
+    process.env.DOCKER_CONFIG = tempDir("catherd-dockercfg-");
+    const once = fakeDocker({ failures: 1, root: "/nonexistent" });
+    const ok = await dockerChecks({ probe: true });
+    expect(ok.find((c) => c.id === "docker-network")).toMatchObject({ state: "ok", word: "ready" });
+    const calls = readFileSync(once.log, "utf8").split("\n");
+    expect(calls.filter((c) => c.includes(" up ")).length).toBe(2);
+    // each up is followed by a down that removes the project
+    expect(calls.filter((c) => c.includes(" down -v")).length).toBe(2);
+    fakeDocker({ failures: 2, root: "/nonexistent" });
+    const blocked = (await dockerChecks({ probe: true })).find((c) => c.id === "docker-network");
+    expect(blocked).toMatchObject({ state: "warn", word: "blocked" });
+    expect(blocked?.detail).toContain("(2 tries, 5 s apart): wget: bad address web:8080");
+  });
+
+  it("warns when Docker's data root has little free space", async () => {
+    process.env.DOCKER_CONFIG = tempDir("catherd-dockercfg-");
+    const root = tempDir("catherd-dockerroot-");
+    fakeDocker({ failures: 0, root });
+    expect((await dockerChecks({ probe: true })).find((c) => c.id === "docker-disk")).toBeUndefined();
+    dockerDisk.minFreeBytes = Number.MAX_SAFE_INTEGER;
+    expect((await dockerChecks({ probe: true })).find((c) => c.id === "docker-disk")).toMatchObject({
+      state: "warn",
+      word: "low",
+      fix: "docker image prune -f, then docker builder prune -f",
+    });
+  });
+});
+
+describe("doctor's toolchain caches row (plan 23)", () => {
+  it("lists the caches workers may write, and skips when there are none", () => {
+    const a = tempDir("catherd-cache-");
+    const b = join(a, "go-build");
+    mkdirSync(b);
+    expect(cachesCheck([a, b])).toMatchObject({ state: "ok", detail: expect.stringContaining(b) });
+    expect(cachesCheck([])).toMatchObject({ state: "skip", word: "none" });
+    if (process.getuid?.() !== 0) {
+      chmodSync(b, 0o500);
+      expect(cachesCheck([a, b])).toMatchObject({ state: "warn", word: "not writable" });
+      chmodSync(b, 0o700);
+    }
+  });
+});
diff --git a/test/services/doctor.test.ts b/test/services/doctor.test.ts
index fdac481..6113af4 100644
--- a/test/services/doctor.test.ts
+++ b/test/services/doctor.test.ts
@@ -153,6 +153,8 @@ describe("doctor", () => {
       agents: "ok ready",
       mcp: "ok ready",
       locks: "ok ready",
+      // the toolchain caches this machine has: none, or some, all writable
+      caches: expect.stringMatching(/^(ok ready|skip none)$/),
       "sandbox:codex": "ok ready",
       "access:codex": "ok ready",
       "access:opencode": "ok ready",
```

### Task 14: `ideas.md` drops what this plan fixes

**Scratch commit:** `fd5b8c2` — `docs(ideas): drop the verifier, gate and environment entries plan 23 fixes`

**Files:** modify `docs/dev/ideas.md` only.

Removed, whole (each fixed by this plan): "Workspace-write codex cannot reach the Go build cache" (1.1.0 install; Ruling 23 and Task 13); from the 1.1.0 platform run "Preflight runs without the user's environment", "The verdict has no environment class", the whole **Verifier** group ("The foreground verifier handed off and ended" (Ruling 26), "Lint reached only the verifier", "`gate_check` carried nothing across rounds"), "A host probe needs to run twice", "`preflight` reruns every past milestone's lanes"; from the payment run "Environment failures are classed as expected", "A filter that matches nothing passes", "\"Do not commit\" conflicts with acceptance built from HEAD", "There is no \"flaky\" outcome", "An environment block is not tagged", "Lanes share the testcontainers reaper", "The low-effort reviewer stops at \"partial\"", "The verifier sets up the environment by hand", "Nothing cleans up Docker"; from the platform review-fix run "`protocol.next` offers the verifier before the fix round", "A verifier resumed with SendMessage hangs", "`preflight` times out at 300 s behind the lock"; from the identity run "`gate_check` paths do not fit a monorepo gate", "The wall timeout kills a long gate", "doctor misses a Docker client that injects proxies", "A provider outage looks like progress".

Kept (other plans', or not fixed here): "A broken check is called expected" (a compose file valid only when layered: not a spec bullet), "The verifier runs in the background even when told not to", "A \"foreground\" verifier is still a background agent", "`status` shows a stale verifier step as live", and every entry of plans 21, 22, 24, 25 and 26.

- [ ] **Step 1:** apply the diff (deletions only).
- [ ] **Step 2:** `git diff --stat` shows `docs/dev/ideas.md` only, 68 deletions; read the four touched sections once to check no group header is left empty.
- [ ] **Step 3: commit** `docs(ideas): drop the verifier, gate and environment entries plan 23 fixes`.

```diff
diff --git a/docs/dev/ideas.md b/docs/dev/ideas.md
index 0e2ddaf..c56597e 100644
--- a/docs/dev/ideas.md
+++ b/docs/dev/ideas.md
@@ -492,11 +492,6 @@ typing a number.
   3 minutes and their event logs were growing, yet the TUI showed `running 00:00` for both. The owner took this to mean
   the run was stuck. Elapsed time should count from `proc.json` `startedAt`. Also show the last event's age, so that
   "alive" and "stuck" look different.
-- **Workspace-write codex cannot reach the Go build cache.** In the same run, the M3.L1 worker's `go vet ./...` failed
-  with "operation not permitted": the Go build cache (`~/Library/Caches/go-build`) is outside `writable_roots`. The
-  worker got past it by pointing `GOCACHE` at `/private/tmp`, which forces a cold cache on every lane. Fix: add the
-  toolchain caches that are present (`go env GOCACHE`/`GOMODCACHE`, the pnpm store, `~/.bun/install/cache`) to
-  `writable_roots`, and add a `doctor` probe for them.
 
 ## From the 1.1.0 platform run (2026-09-28/29)
 
@@ -527,20 +522,8 @@ Run `20260928-172920-m3-auth-plan-5-mr-b-the-kit-clean-up` (sanitell/platform, a
 
 **Preflight and environment**
 
-- **Preflight runs without the user's environment.** The testcontainers checks in L1 and L3 failed "rootless Docker not found", because `DOCKER_HOST` points at OrbStack and preflight doesn't inherit it. They were reported as fails-as-expected, not as cannot-start. Fix: run preflight in the user's login environment, and class "cannot start" apart from "fails as expected".
-- **The verdict has no environment class.** In verifier rounds 2 and 3, both acceptance suites failed on the environment:
-  - a connected Cisco AnyConnect socket filter drops unsigned binaries' connections to the docker bridge subnet, while `curl` passes, and a 20-line Go binary reproduces it;
-  - `proxy.golang.org` returned EOF inside an image build.
-
-  Both came out as a plain FAIL. Fix: a verdict of `BLOCKED: environment`, with the probe that proves it, so the orchestrator surfaces the blocker instead of cycling fix rounds.
 - **The version bump changed the sandbox silently.** Worker records went from `workspace-write, isolated: true` (1.1.0) to `access: full, isolated: false` (1.2.0) with no note in the run. Fix: pin the protocol and the sandbox per run, or log the change in `state.md`.
 
-**Verifier**
-
-- **The foreground verifier handed off and ended.** Its first turn ended after 80 s with "the status monitor will report each one as it finishes". No monitor reports to the main thread, so it had to be resumed with SendMessage, and ending the turn killed an auth `task check` mid-govulncheck. Fix: the verifier prompt forbids background watchers and ending the turn while a command runs.
-- **Lint reached only the verifier.** The workers' fast checks ran `go test`, never `golangci-lint`, so an `unparam` in tokenapi and a `revive` in both services' `audit_names.go` cost a full verifier round of about 43 min. Fix: a lane's fast check includes the linter of every package it touched.
-- **`gate_check` carried nothing across rounds.** The round-2 verifier didn't have round 1's item names, so every item ran again. Fix: `gate_check` lists the milestone's recorded items, and the verifier reuses their names.
-
 **Ledger and knowledge**
 
 - **`land` accepted inexact verifier names.** M2 landed with verifier records named `verifier-M2-pre`, `-gate1` and `-gate3`, with no exact `verifier-M2` row. Its ledger minutes (1689) counted the whole paused night. Fix: match the name exactly, and subtract the pauses.
@@ -552,10 +535,8 @@ Run `20260928-172920-m3-auth-plan-5-mr-b-the-kit-clean-up` (sanitell/platform, a
 - **`status` shows a stale verifier step as live.** After the round-2 verifier was gone, `status` and `peek` still reported `verifier: {item: "acceptance notification", at: 10:04:03Z}`, with no process running. They also listed the previous owner session as `live: true` after a new session had taken the run. `gate_check` records a step, but nothing ends one. Fix: close the step on `gate_pass`, on `record_agent_run(role: verifier)`, or when the owning session is gone, and show its age.
 - **`state.md`'s Next outlives the step.** It still read "dispatch M3.L1 at codex:gpt-6-sol#medium on a fresh thread" ten hours after that dispatch ended ok (L1 attempt 3, 23:55). Fix: `result()` of the named dispatch clears or advances Next.
 - **The profile is not pinned per run either.** The active profile changed from the codex one to `just-claude` while M3 was paused, so the run's verifier rung changed (`catherd-default-verifier-*` is gone and `catherd-just-claude-verifier-claude-opus-5-5-low` took over), and any re-dispatched lane would route on Sonnet instead of the Codex rungs it started on. Nothing in the run records the switch. Fix: same as the sandbox item: pin the profile at `run_start`, or log the change in `state.md`.
-- **A host probe needs to run twice.** Right after the AnyConnect VPN was disconnected, the first unsigned Go probe to `203.0.113.20` still got `no route to host`. The next seven, including one from a freshly built binary on a fresh network, answered 200. A single probe would have stopped the run for nothing. Fix: when catherd ships a host probe, it retries once after a few seconds before calling the host blocked.
 
 - **An isolated headless worker cannot read its lane file.** worker-M4.L1 (`claude-code`, `isolated: true`) was told "your lane file is lanes/M4.L1.md in the run" and replied "I couldn't find `lanes/M4.L1.md` on disk, so I worked from your summary". It guessed its Owns from the brief and edited four files the lane file did not list, which came back as violations (`directory.go`, `internal_test.go`, two Dokploy READMEs). All four were right to edit, but only because the brief happened to be detailed. Fix: `dispatch` inlines the lane file (Owns, Fast check, body) into the brief, or passes its absolute path and grants read access to the run folder.
-- **`preflight` reruns every past milestone's lanes.** Called for M4, which had one new lane, it ran all seven M3 lane checks too (Go testcontainers and four panels), took about 2 min behind the lock while the M4 worker was already running, and reported a failure on an M3 lane (`TestSeedWritesEveryStateThePanelShows`) that has nothing to do with M4. Fix: preflight only lanes that have not landed, or take a `milestone` argument.
 
 ## From the payment run (2026-09-29)
 
@@ -583,33 +564,15 @@ catherd 1.2.1, profile just-claude, sanitell/platform payment plans 1–11. That
 
 **Preflight**
 
-- **Environment failures are classed as expected.** A testcontainers check without `DOCKER_HOST` failed with "rootless Docker not found", and preflight called it `fails-as-expected`. This happened on plan 1 and again on plan 3. An environment error should be `cannot-start`.
-- **A filter that matches nothing passes.** `pnpm --filter checkout …` passed before `apps/checkout` existed, because pnpm exits 0 on an empty filter. It should be `skipped`. Evidence: run `-135414`, M1.L4.
 - **A broken check is called expected.** A compose file that is valid only layered on another failed `config -q`, and preflight called that `fails-as-expected`. Evidence: run `-143512`, M1.L5.
 
 **Workers**
 
-- **"Do not commit" conflicts with acceptance built from HEAD.** `tooling/acceptance.sh` builds from `git archive HEAD`, so a lane told not to commit cannot run the acceptance it owns. One worker skipped it (plan 5). Another made an unreferenced commit and a detached worktree (plan 10). Fix: a per-lane WIP-commit escape, or acceptance belongs to the verifier by default.
-- **There is no "flaky" outcome.** Three cases needed a judgement with no record:
-  - an input-otp timer error that the worker never reproduced;
-  - a notification timing test that failed once in turbo and passed 3/3 alone;
-  - vitest timeouts under load.
-
-  Climb, accept or rerun is left to the orchestrator.
-- **An environment block is not tagged.** A worker replied `STATUS: blocked` with `ENV: vpn` on its own line, but the hints did not flag it. Climb-by-default would have spent a rung. Evidence: run `-113338`, worker-M1.L4.
-- **Lanes share the testcontainers reaper.** Parallel lanes on one daemon failed with "reaper container name already in use". Evidence: run `-135414`, worker-M1.L1.
 - **A final reply can overwrite the report.** worker-M1.L3 of plan 9 sent a second, short reply ("the notification is just my wait loop…"), and `result` showed that one. The real report with its deviations survived only in `events.jsonl`. Fix: keep the report reply, or concatenate.
 
 **Reviewers and verifiers**
 
-- **The low-effort reviewer stops at "partial".** On plans 4, 5, 9, 10 and 11, reviewer-M1 at claude-opus#low read the core and replied `STATUS: partial`. `record_agent_run` counts it `ok`, and `land` accepts it. Second passes scoped to the unread files found real issues:
-  - a vacuous property walk (plan 10);
-  - two bugs in plan 11's review actions, found on its first scoped pass.
-
-  Fix: size the reviewer to the diff, or refuse a partial review as the milestone's review.
 - **The verifier runs in the background even when told not to.** The Agent call returned "Async agent launched" and an interim "waiting for the gate" message. The verdict came as a second notification. Evidence: runs `-113331` and `-133255`.
-- **The verifier sets up the environment by hand.** Every verifier's first `task check` or turbo hit govulncheck's 403, because `HTTPS_PROXY` was missing. Every first testcontainers run needed `DOCKER_HOST`. Fix: carry a per-repo gate environment in the profile or the knowledge file, and inject it into verifier briefs.
-- **Nothing cleans up Docker.** After about 30 image and acceptance builds, Docker hit "no space left on device", and even `builder prune` failed until dangling images were removed. About 20 GB was freed. Evidence: plan 11 verifier, 15:42.
 - **The verifier caught what review could not, and it paid off.** The hardened property walk, run `-count=3` by the verifier, found a real cross-payment ledger bug in refund. The plan 8 and plan 11 reviewers found real bugs as well. The loop earned its cost on this run.
 
 **Outside catherd, noted for the orchestrator**
@@ -621,9 +584,6 @@ catherd 1.2.1, profile just-claude, sanitell/platform payment plans 1–11. That
 catherd 1.2.1, sanitell/platform review-fix plans 1–7, one run per plan and its worktree, seven MRs merged to staging (!73–!79) in about 13 h 20 min. Already listed above and seen again: one run per worktree (`dispatch` takes no cwd), and a "foreground" verifier that runs in the background anyway.
 
 - **A resumed worker exits 143.** A worker that left a command running in the background in its previous turn gets exit 143 when its thread is resumed. Fix: the worker contract forbids leaving background processes behind, and `dispatch` kills the thread's process group before a resume.
-- **`protocol.next` offers the verifier before the fix round.** After a reviewer returns findings, the next step it names is the verifier, not the fix round. Fix: `protocol.next` reads the reviewer record, and with open BLOCKER or BUG lines it names the fix round.
-- **A verifier resumed with SendMessage hangs.** More than once, the resumed verifier never returned. The workaround was a fresh verifier with a 10-minute cap on each command. Fix: re-checks go to a fresh verifier by default, with the failed items named and a per-command timeout in its brief; `gate_check` already carries over what passed.
-- **`preflight` times out at 300 s behind the lock.** With testcontainers suites from other lanes holding the lock slots, preflight waited past its own timeout. Fix: preflight takes a lock slot per check with its own wait budget, or reports `lock-busy` instead of a timeout.
 
 ## From the agentic-machine identity run (2026-10-02)
 
@@ -666,19 +626,6 @@ owner turned isolation off (the host is itself a sandbox).
   can run (`catherd gate check|pass`, `catherd run-file write`), name them in the verifier's brief, and stop
   telling an isolated role to call MCP tools. Or write a catherd-only `[mcp_servers]` entry into the isolated
   config. Isolation per role, not only per harness, would also have kept the verifier native here.
-- **`gate_check` paths do not fit a monorepo gate.** The log has six `E_INPUT_INVALID` (03:32–08:33):
-  `gate path apps/checkout/dist exists neither at HEAD nor in the working tree`, and
-  `gate path node_modules/.bun/@adobe+react-spectrum@… holds more than 10000 files to hash`. A full
-  `turbo run check` really does read `.`, `node_modules` and ignored build outputs. Fix: hash tracked content from
-  `git ls-files -s` plus the lockfiles for dependencies. Treat an absent ignored path as part of the hash ("absent"),
-  not as an error. Leave `node_modules` and the gitignored outputs out of the walk unless a path names them.
-  (`src/services/gate-service.ts`.)
-- **The wall timeout kills a long gate.** Verifier attempt 3 hit `wall-timeout, exit SIGTERM` at 90 minutes inside
-  the root gate (55 turbo tasks plus testcontainers). Attempt 4 took 85 minutes for that gate alone. The
-  coordinator then split the gate and acceptance into separate continuations by hand. Fix: per-role `timeouts`
-  (`roles.verifier.timeouts.wallMin`). Or count the wall from the last output, not from the start, while a
-  `catherd lock` child of the role is alive and writing. The verifier brief also splits the root gate from the
-  per-service acceptance items by default.
 - **Codex goal mode turns into polling.** After the owner set a thread goal ("never stop again…"), Codex started a
   goal-continuation turn about once a minute. There were 11 such turns in 21 minutes, which read 7.2 M input
   tokens on Astra. They ran `pidwait`, `write_stdin` with 55 s yields and `wait` cells, and the coordinator also did
@@ -711,11 +658,6 @@ owner turned isolation off (the host is itself a sandbox).
   in the worktree, because there is one run per worktree. It still lists as `idle`, with
   `Protocol next: route and preflight M1's lanes`. Fix: `runs supersede <run> --by <run>` (or a field set by
   `run_start` with a `from:` line) closes it with a pointer, and `status` hides it.
-- **doctor misses a Docker client that injects proxies.** `access:codex` passed `docker version`, but
-  `~/.docker/config.json` had a `proxies` block, so every container got `HTTP_PROXY`. That broke a compose stack's
-  internal names (`minio-buckets` could not reach `minio`) and a BusyBox `wget` loopback health check
-  (`notification-fake`). Three of the seven verifier attempts failed on it. Fix: doctor warns when the client config
-  has `proxies`, and probes a two-container compose network by service name with a loopback `wget` health check.
 - **`doctor --test-push` cannot find a Codex thread from a shell.** Codex does not export `CODEX_THREAD_ID` to the
   commands it runs. The thread reaches catherd only as `_meta.threadId` on MCP calls, so the smoke always reports
   `no session` even inside a live thread. Fix: a `test_push` MCP tool, or `--thread <uuid>`, or resolve the cwd's
@@ -724,16 +666,6 @@ owner turned isolation off (the host is itself a sandbox).
   binary, and logs copied between roles. This host's `/tmp` is a 5.9 GiB tmpfs with a per-user quota that had
   already broken a TUI once. Fix: each dispatch gets `TMPDIR=<run>/scratch/<role>/`, the brief names it, and
   evidence goes through `write_run_file`. `runs` cleanup removes the scratch with the run.
-- **A provider outage looks like progress.** `researcher-M1-signin-failures` on
-  `opencode-go/muse-spark-1.3-contributor#xhigh` (10:29:39) produced no tool call and no text in 4.5 minutes. The
-  session held one assistant message with `retry.attempt: 6` and `503 service_overloaded: The backend is
-  temporarily overloaded`. Each opencode retry emitted a `step_start`, which reset the 15-minute idle timer, and
-  `failover` covers only usage limits. The role would have sat until `wallMin`. The owner cancelled it by hand
-  (`runs cancel` interrupted the server session cleanly: `aborted: Step interrupted`). Fix: the opencode adapter
-  reads the session's `retry` field (or counts consecutive `step_start` with no part between them). After N
-  provider retries (say 3) or about 3 minutes of retry-only events, it fails the attempt as `provider-unavailable`,
-  and `climb`/failover treats that like a usage limit: the next rung on another backend. A retry-only stretch
-  does not count as activity for `idleMin`.
 - **Investigate: three MCP servers for one Codex session.** At 09:36 one Codex TUI started `catherd mcp` three times
   (pids 633954 and 634083 as host codex, and 634148 as host `unknown`). Each reconciled the runs. Check whether
   Codex spawns the plugin server per tool context. If so, make boot sync and reconcile single-flight across
```

## Risks for the executor

- Plans 21 and 22 run first and edit `src/services/admission.ts` (`CATHERD_ROLE`, `TMPDIR`, the isolated refusal, the lane file in the brief), `src/domain/role-prompts.ts` (`RUN_FILES`, the CLI forms in the verifier brief), `src/infra/supervisor.ts` and `src/entry/supervise-command.ts` (the supervisor's `codex queue` push on exit), `src/services/finalize.ts` and `src/services/run-service.ts` (`result` keeps the longest STATUS reply), `src/services/protocol.ts` and `src/services/state.ts` (Next advanced by `result`, the verifier step closing), `src/entry/doctor-command.ts` (`--thread`) and `plugin/skills/catherd/SKILL.md` throughout. Re-find each hunk by its context; the spec-env line in `admission.ts` (`env: { ...plan.env, … }`) gains plan 21's `CATHERD_ROLE`/`TMPDIR` beside this plan's `CATHERD_DISPATCH_ID`/`TESTCONTAINERS_SESSION_ID`/gate values.
- Plan 21 may change the role server's `gate_check` (Ruling 4) and add `catherd gate check|pass`; both call `gateCheck`, whose signature this plan keeps (it only adds `recorded` to the answer when a milestone is passed).
- Plan 25 changes `land` (exact verifier names, parked time), `milestones.ts` and the knowledge key (git origin): `gate-env.json` lives in `repoDir()`, so it moves with the key; its migration-on-read must take `gate-env.json` along with `knowledge.md` and `gates.jsonl`.
- Plan 25 adds `catherd lock --role verifier` to `src/entry/lock-command.ts`; this plan's change there is the `onOutput` pipe and the activity reporter around `runForwarding`.
- `test/services/doctor.test.ts`'s "is ready…" test lists every row: Task 13 adds `caches` (`ok ready` or `skip none`, by machine).
