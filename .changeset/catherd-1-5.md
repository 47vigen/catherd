---
"catherd-cli": minor
---

catherd 1.5: everything the payment, platform and identity runs left open. Upgrade, run `catherd doctor` (it names the Claude agent links to refresh), update the plugin and start a new session; MIGRATION.md, "From 1.4 to 1.5", lists what you will notice.

**Roles and ownership**

- **A role never owns the run.** The supervisor sets `CATHERD_ROLE=<run>/<name>` in every role's environment. A role's process never claims a run, and its catherd MCP server refuses the coordinator tools (`peek` of another role, `result`, `dispatch`, `run_start`, `climb`, `land`, `park`, `cancel`, `set_next`, `answer`, `profile_set`, `test_push`, `run_pin`, `lane_set`, `owns_add`, `record_agent_run` and the workspace writers) with the new `E_ROLE_SCOPE`; their descriptions start "Orchestrator only". A native Claude subagent's agent file forbids them. A catherd notice is never sent to a role's thread: a refused one is a failed delivery, logged, and `status` warns.
- **catherd's tools in every role.** Headless Codex and Claude Code roles get the `catherd_role` MCP server isolated or not (a 30 s start timeout; `doctor` probes its cold start). An isolated Claude Code role with it runs with `--strict-mcp-config --setting-sources "" --disable-slash-commands` instead of `--safe-mode`, keeping your login, provider, model, deny rules and allowed network domains. Every role can run `catherd run-file read|write <run> <path>` and `catherd gate check|pass <run> …` from its shell, bound to its own run; opencode, Cursor, Grok Build and Antigravity briefs name them. The role server's `read_knowledge` reads the run's repository.
- **The brief carries the lane.** `dispatch` with `lane` inlines the lane file as it stands. Each role gets its own scratch `TMPDIR` (`<run>/scratch/<name>/`, named in its brief); `catherd runs clean [<id>]` removes the scratch of runs with no live role.
- **The writer has an implicit docs lane** (its brief's `Owns:`, else `docs/**` and `*.md`), and edits are attributed per dispatch, so a writer's edits are never a lane's violation.

**Delivery and the loop**

- **Results reach a Codex coordinator when its server is gone.** When a role ends, its supervisor queues the same notice to the Codex owner's thread (`codex queue --remote unix://…`), under the same receipt as the server's push, so it is never sent twice. The skill tells a Codex coordinator once to run inside tmux, and to end a goal continuation with no tool call while only roles are live; `peek` answers `actionable: false` with its reason when nothing is the coordinator's to do.
- **The thread travels.** Every catherd message names the role's `thread:`; `dispatch` takes `thread: "latest"` and refuses a thread that name never ran on in the run (`E_ADMIT_THREAD`). Before a resume, `dispatch` stops what the thread's last turn left running.
- **A short final reply never overwrites the report:** `result` returns the longest STATUS-bearing message and the later ones under `later:`.
- **"waiting for orchestrator"** shows only for the current owner and a record that ended within 24 h; `status` without a run shows the live runs, else the waiting ones, else the newest.
- **`state.md`'s Next** advances when `result` reads the dispatch it names, and the verifier's step closes (on its pass, its record, or its owner gone) and shows its age.
- **One boot per machine:** the catalog sync and reconcile at MCP server start run in one server at a time.
- **Testing the push from a Codex thread:** `catherd doctor --test-push --thread <uuid>` and the `test_push` tool.
- The 1.1 push minors: a session that no longer owns a run leaves its usage limits to the owner, an edit with no path shows `edit`, and a Claude role's activity shows its tool's first argument.

**Verifier, gate and environment**

- **Monorepo gates.** `gate_check` hashes tracked content (`git ls-files -s`) plus every lockfile; an ignored output not built yet is "absent"; `node_modules` is walked only when a path names it. `gate_check(run, milestone)` lists the milestone's recorded items, so a fresh verifier reuses their names. A re-check goes to a fresh verifier with the failed items and a 10-minute cap per command. `gate_pass` names its commit `<HEAD>+uncommitted` when an uncommitted change lies under its paths; a gate path `./` means the whole repo.
- **The gate environment.** `catherd knowledge env set NAME=value | NAME --from VAR`, `env rm`, `env list`: per-repo variables (secrets by reference only) that reach the verifier and preflight.
- **Per-role timeouts:** `roles.<role>.timeouts.{idleMin,wallMin}`; a `catherd lock` command still writing output keeps its role's wall clock alive, and waiting for a slot counts as activity.
- **The environment is not the work.** `VERDICT: BLOCKED: environment — <probe>` (or `record_agent_run`'s `verdict`) is a blocker to surface, never a fix round; an `ENV:` line in a reply becomes an `environment:` hint and `climb` refuses it (`E_CLIMB_ENV`); `STATUS: flaky` is a worker outcome.
- **Preflight** runs in your login environment, tells `cannot-start` (a missing command, Docker, DNS, a denied permission) from `fails-as-expected`, skips a pnpm filter that matches nothing, runs only lanes not landed (or the `milestone` named), reports `lock-busy` instead of timing out, and warns about a fast check with no lint step when the repo has a linter.
- **Reviews:** a `STATUS: partial` review is not the milestone's review (`land` refuses it), and open BLOCKER or BUG lines make the next step the fix round.
- **opencode provider outages fail over** like a usage limit (`provider-unavailable`) after 3 retries or 3 minutes of them.
- **doctor** warns about a Docker client `proxies` block and toolchain caches you cannot write; `catherd doctor --docker` probes a compose network by service name and warns under 10 GB free in Docker's data root. The verifier brief ends with `docker image prune -f`, each dispatch has its own `TESTCONTAINERS_SESSION_ID`, and acceptance items are the verifier's by default.

**Routing and cost**

- **Every enabled rung can start.** An unpriced rung on a plan or subscription costs 0 in its tier; the profile's ladder order breaks every tie, and equal scores start on the quota the run has used least. `profile validate` warns about a quota no worker rung starts on and a kind and difficulty no worker rung reaches.
- **Climb ladders only go up**, each rung at least as strong as the one before it; a lane starts no lower than an easier difficulty's start, and `route` says when no rung clears the bar (and the closest) or a tie decided.
- **`route` returns little:** `lane`, `role`, `rung`, `ladder`, `backend`, `agent` and a one-line `why`. Every decision, with its provenance, is a row in the run's `routes.jsonl`, as is each lane's final outcome beside Jev's answer. `route(run, lanes: [...])` routes a milestone's lanes in one call. A lane header declaring `Kind:` and `Difficulty:` wins over Jev. `dispatch` with `lane` takes `rung` optionally.
- **Catalog:** a new release of a family takes at least its predecessor's values at the same effort; the Artificial Analysis Intelligence Index joins the calibration sources; a stand-in needs values of its own on at least 3 dimensions; a sync spreads `adjacent` values upward only. A treat-like reads "like X", an inferred stand-in "inferred from X"; `catalog_sync` answers `busy` at once while another sync runs; and the 1.2 routing and catalog minors are closed.

**Runs, programs and lanes**

- **Workspaces** (#43, new in this release) survive an unreadable member run or a torn line, land only a step's completion milestone behind their lock, have no budget cap by default (`workspace_budget` sets one; minutes count from the first child), and can release a step only once its landed commit is merged into a base ref (`release: "merge"`).
- **Pause on one blocker:** `catherd pause --machine "<reason>"` or `--workspace <id>`, `catherd resume --machine` (or `--workspace <id>`), and the `workspace_pause`/`workspace_resume` tools; dispatch is refused with `E_ADMIT_PAUSED` until resumed, and `status` shows it first.
- **Two runs' verifiers never overlap:** `catherd lock --role verifier` holds a machine-wide lock per run.
- **`catherd runs supersede <id> --by <id>`** (and `run_start`'s `from`) closes a run with a pointer; `status` hides it, and dispatching into it is `E_RUN_NOT_LIVE`.
- **Lane editing:** `lane_set(run, lane, field, value)` edits one header line; `owns_add(run, lane, paths, why)` grows a running lane's Owns; `After: <lane>` orders lanes (`E_ADMIT_ORDER`); `Allow:` excuses known hits of a check; `write_run_file` validates a lane's header values. Header lines are read only from the header block under the title.
- **Pinned per run:** `run_start` records the profile, each role's access and each backend's isolation; dispatch keeps them, a later change shows in `state.md` and `status`, and `run_pin` or `catherd runs pin <id>` re-pins.
- **Knowledge keyed by the git origin**, so every worktree and clone of a repository shares one `knowledge.md` and gate environment; the old toplevel-keyed files are merged in on first read.
- **The milestone digest** lists the commits, the reviewer's findings and the open questions; `land` counts only a verifier named exactly `verifier-<M>` and leaves parked and paused time out of the minutes.
- MCP: 38 tools (`test_push`, `run_pin`, `lane_set`, `owns_add` and the workspace tools added).

**Fixes**

- `dispatch` refuses what admission would refuse before it routes, and routes a lane once when two dispatches start together; the first milestone's skip is judged from the HEAD the run started on; a markdown-wrapped verdict gets a fix line that names the bare `VERDICT: PASS`; ownership wording in a blocked climb is read more exactly.
- `init` stops a `bun add -g` after two minutes and says "shadowed" when another `catherd` comes first on PATH; doctor's Claude Code access row reads every bound repo's sandbox setting; `profile show` aligns its access column; `network: false` on a role that does not write is a warning; a failover suggestion comes only from backends the profile names.
- Cursor models are listed only from Cursor's own `agent`; an isolated Grok or Antigravity rung is checked against the API key's own model listing; catherd rewrites its Grok `sandbox.toml` block in place and refuses a link it cannot follow.
- The Runs page shows open milestones with their descriptions, opens a session on the run it was opened for, else its first live role, and stops polling a finished role.

**Not in 1.5**

- "Later" (race mode, automatic retro, `catherd bench`, standalone binaries): no run evidence asks for them yet.
- The logic and hard bars sit above every Sol rung: the owner's call between percentile bars and a stronger top rung, unchanged in this release.
- Haiku 4.5's terminal value (waits for an external source) and re-recorded Artificial Analysis fixtures (need the owner's key).
- Live coverage still missing: a live run, not code.
- Jev hit-rate review and difficulty calibration need outcome data first; 1.5 logs it in `routes.jsonl`.
- Milestone per branch and stacked milestones: a product change to how runs map to MRs.
