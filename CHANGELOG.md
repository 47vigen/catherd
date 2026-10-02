# catherd-cli

## 1.5.0

### Minor Changes

- 8d16c33: catherd 1.5: everything the payment, platform and identity runs left open. Upgrade, run `catherd doctor` (it names the Claude agent links to refresh), update the plugin and start a new session; MIGRATION.md, "From 1.4 to 1.5", lists what you will notice.

  **Roles and ownership**

  - **A role never owns the run.** The supervisor sets `CATHERD_ROLE=<run>/<name>` in every role's environment. A role's process never claims a run, and its catherd MCP server refuses the coordinator tools (`peek` of another role, `result`, `dispatch`, `run_start`, `climb`, `land`, `park`, `cancel`, `set_next`, `answer`, `profile_set`, `test_push`, `run_pin`, `lane_set`, `owns_add`, `record_agent_run` and the workspace writers) with the new `E_ROLE_SCOPE`; their descriptions start "Orchestrator only". A native Claude subagent's agent file forbids them. A catherd notice is never sent to a role's thread: a refused one is a failed delivery, logged, and `status` warns.
  - **catherd's tools in every role.** Headless Codex and Claude Code roles get the `catherd_role` MCP server isolated or not (a 30 s start timeout; `doctor` probes its cold start). An isolated Claude Code role with it runs with `--strict-mcp-config --setting-sources "" --disable-slash-commands` instead of `--safe-mode`, keeping your login, provider, model, deny rules and allowed network domains. Roles can run `catherd run-file read|write <run> <path>` and `catherd gate check|pass <run> …` from their shell, bound to their own run and their role's tools (every role reads run files, the architect and researcher write them, the verifier runs the gate); opencode, Cursor, Grok Build and Antigravity briefs name them. The role server's `read_knowledge` reads the run's repository.
  - **The brief carries the lane.** `dispatch` with `lane` inlines the lane file as it stands. Codex and Claude Code roles, and isolated opencode roles, get their own scratch `TMPDIR` (`<run>/scratch/<name>/`, named in the brief); Cursor, Grok Build, Antigravity and non-isolated opencode roles keep their inherited one; `catherd runs clean [<id>]` removes the scratch of runs with no live role.
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

- 25c2e5d: Coordinate independent repository runs from explicit workspace members, with landed-milestone dependencies,
  a frozen shared contract, aggregate budgets, workspace MCP tools and read-only workspace CLI views.

### Patch Changes

- 4dd047c: Provide native headless Codex and Claude Code roles with catherd run-file and gate MCP tools without changing user configuration, and show when unread results await the orchestrator.

## 1.4.0

### Minor Changes

- 075df3f: Support orchestration from native Codex alongside Claude Code, with host-aware ownership and omitted architect/verifier defaults, optional Claude dependencies, durable native queue completion delivery and shared plugin skills. Preserve explicit profiles and the existing reviewer/verifier landing gate.

## 1.3.0

### Minor Changes

- cc72c97: catherd 1.3: three new worker backends, Cursor, Grok Build and Antigravity, each off until a profile puts a rung on it. Nothing to migrate: upgrade, run `catherd doctor`, and start a new Claude Code session (see MIGRATION.md, "From 1.2 to 1.3").

  - **Cursor (`cursor:`).** `cursor-agent` 2026.09.28 or newer, briefs on stdin, the effort as the slug's suffix (`cursor:gpt-6-sol#xhigh`). `workspace-write` runs in Cursor's sandbox without `--force`; doctor runs the five access probes through its sandbox runner. Isolated runs need `CURSOR_API_KEY` and get their own `sandbox.json`.
  - **Grok Build (`grok:`).** xAI's `grok` CLI on a Grok login or `XAI_API_KEY`; see the README's Grok section for its access modes and isolation.
  - **Antigravity (`antigravity:`).** Google's `agy` 1.2.13 or newer, on a Google login (plan quota) or `GEMINI_API_KEY` (the Gemini API project). catherd never runs `agy -p` while agy is signed out, since it would open a browser. agy has no read-only mode: a read-only role runs on it only isolated, where catherd's own settings deny writes and commands; `profile validate` refuses it natively. Doctor shows the plan quota left (`quota:antigravity`).
  - **Generic groundwork.** Admission refuses to resume a thread under another access or network grant on a backend that keeps a thread's access. A CLI the OS cannot execute is "installed but cannot run", with the reinstall command. A logged-out backend never reaches a dispatch. An isolated backend that needs an API key does not validate without it, and the dashboard's harness row says so. Doctor's access row says "not tested" where a backend has no sandbox runner.
  - **Catalog.** Grok 4.7, 4.6 and 4.5, Composer 2.5, and Gemini 3.8, 3.7 and 3.6 Flash and 3.1 Pro join the families, so the public sources score them; a model a backend runs with no effort is scored at `#default`. Gemini fails over between Antigravity and Cursor (and Grok between Grok Build and Cursor) when neither the profile nor the backend names another stand-in; the new backends never stand in for the shipped ones.

- 7e8354d: `catherd knowledge show|add|path [--repo <path>]` shows a repo's knowledge.md and where it lives, and adds facts you already know (the targeted test command, a suite that needs a database) before a run learns them. An added line looks like one `land` records, marked "by hand".

### Patch Changes

- 8d0bc57: The catalog's Cursor ids and efforts now match Cursor's live model listing, so `cursor:` rungs read differently (for
  example `cursor:cursor-grok-4.6#high` and `cursor:claude-opus-5-5#high`), and Grok and Gemini fail over to Cursor at
  the same effort where both list it.
- e6a400f: Isolated Cursor runs keep the API key in memory, so `cursor-agent` no longer touches the macOS keychain.
- bb37224: Doctor's Cursor access probes now test what they name: `cursor-agent sandbox run` joins its arguments into one shell
  line, so catherd sends each probe as one quoted command, and a lock, temp, loopback, HTTPS or Docker check no longer
  fails, or passes without running, because of the split.
- bd98159: Ship GPT-6.1 Sol (`codex:gpt-6.1-sol`) in the catalog with its price and efforts. No DeepSWE, comparable Terminal-Bench or Arena score is published for it yet, so GPT-6 Sol at the same effort stands in until one is.
- 4c53547: Warn about settings that cannot work on this machine: `profile validate` and `catherd doctor` flag a `budget.usd` cap
  when a role or its failover stand-in runs on a backend that reports no dollar cost (Codex, Cursor, Antigravity), and
  `catherd doctor` flags a profile that turns the ui-reviewer on while `agent-browser`, which takes its screenshots, is
  not on PATH. Each warning names the fix.

## 1.2.1

### Patch Changes

- b1d20e5: Claude Sonnet 5.5 (`claude-sonnet-5-5`) is listed for the claude, claude-code and opencode backends, and Claude Code's
  `sonnet` alias now resolves to it.

## 1.2.0

### Minor Changes

- 04a48e2: catherd 1.2: scores and model facts from public sources, bars that span several dimensions, and a profile that never breaks because a rung lacks a score. Run `catherd init` after upgrading (it asks for an optional Artificial Analysis key and syncs), then start a new Claude Code session (see MIGRATION.md, "From 1.1 to 1.2").

  - **Public sources.** models.dev, OpenRouter, LiteLLM, Arena (LMArena), Vectara's hallucination leaderboard and Epoch AI, keyless, plus Artificial Analysis with your own free key (`init` asks after Jev's, so piped `init` now reads four lines: the Jev key, the Artificial Analysis key, the profile, whether to replace it; `ARTIFICIAL_ANALYSIS_API_KEY` wins; it is saved in `credentials.json` and workers never see it). The MCP server syncs them in the background at session start, each at most every 12 hours; `catherd catalog sync [--force] [--unmatched]` and the `catalog_sync` tool (26 MCP tools) sync on demand. A failed source keeps its last good answer; offline, catherd routes on the scores it ships. `CATHERD_NO_SYNC=1` turns the automatic syncs off.
  - **Calibration and confidence.** Each dimension has an anchor unit; other sources are fitted onto it (at least 5 shared rungs, R² ≥ 0.5). A value's confidence is `verified`, `measured`, `calibrated`, `adjacent` (the same model at another effort), `secondary` or `inferred`; the override still wins, then the better level, then the newer date, and a value older than 90 days drops a level.
  - **New dimensions and bars.** `agentic`, `steer` and `frontend` join `repo_code`, `terminal` and `honesty`. The default bars span several dimensions per kind and difficulty (a `terminal` lane gates on Terminal-Bench, a `ui` lane on WebDev), at the 25th, 50th, 60th and 75th percentiles of the rungs measured or better, each with its `barsWhy` in `scores.json`. Your override's `bars` now override per dimension; `null` removes a threshold.
  - **Unscored is a warning.** A rung with no value on a dimension the bars use takes its nearest stand-in's (ranked on price, context, release date, vendor, family, effort and its own values; Artificial Analysis's features with a key) as `inferred`, and `profile validate` and `doctor` list it as a "stand-in to confirm". The error "unscored rung without a treat-like" is gone. A save that fixes one of a profile's errors and adds none now goes through (`profile set`, `profile_set`, the dashboard's save), listing the errors still open.
  - **treat-like.** `catherd catalog treat-like --suggest <rung>` ranks the three nearest stand-ins; `--clear <rung>` and `--reset` remove your mappings, naming first the profile rungs left on an inferred stand-in or left unscored.
  - **Why a rung.** `route` reports each threshold of the lane's bar, the value used, its confidence and source (inferred values marked), the rung's speed and cost facts, and catherd's own run evidence ("12 lanes, 2 climbed, 1 partial"), which never changes routing; `catalog_query` and `catalog list` show the same. In the dashboard, `r` in Profiles syncs and shows each source's age and last error, `i` shows a rung's values and runs, and `t` opens the treat-like picker with the three nearest stand-ins first.
  - **Shipped scores.** `catalog/scores.json` carries the keyless sources' values with their source, date and confidence (never Artificial Analysis's), attributed in `catalog/ATTRIBUTION.md`; a weekly workflow refreshes them in a `chore(catalog): refresh scores` PR.

## 1.1.1

### Patch Changes

- 3751229: The runs page now counts a live role's elapsed time and a run's age in wall-clock time. It had shown 00:00 for every
  running role, because OpenTUI's clock counts from process start. Workspace-write workers can now write the
  toolchain caches that exist (Go build and module caches, the pnpm store, Bun's install cache, npm's cache), so a
  sandboxed `go vet` no longer fails with "operation not permitted" or starts cold in every lane.

## 1.1.0

### Minor Changes

- 8c0297e: catherd 1.1: results come to you, the protocol is enforced, and workers run their own checks. Upgrade with 1.1's own init (`bun add -g catherd-cli@latest && catherd init`, or `bunx catherd-cli@latest init`), then update the plugin and start a new Claude Code session (see MIGRATION.md, "From 1.0 to 1.1").

  - **Push, not `wait`.** A finished role reaches the Claude Code session that drove it as a message on its peer inbox (`<cross-session-message from-name="catherd">`), like a native subagent's notice, so the session stays free while roles run; a stalled worker is reported once the same way. `wait` and `CATHERD_TICK_MS` are removed; `peek` shows a run at once (open questions, live roles with their last event, unread records, the verifier's latest step, the next protocol step) and `result` reads a record and marks it read. A lost message loses nothing: records stay unread on disk until `result`. `doctor` has a `push` row (and says on Linux whether to set `crossSessionInbound`; `init` never changes it).
  - **Sessions.** Runs remember the Claude Code session that started and continued them, and only the session that owns a run (the last to `dispatch` or `peek` on it) is messaged about it; only that session's catherd server fails the run's roles over when they hit a usage limit. The Runs tab lists sessions, newest first ("earlier runs" for 1.0's), opens one on its runs, milestones and roles, redrawing as run files change, and opens a milestone on its digest; `runs list` and `status` group by session and their `--json` gains `session`.
  - **Workers can run their checks.** `workspace-write` roles get the network, loopback, the lock and temp dirs and a local Docker socket (Codex through `network_access` and `writable_roots`, alongside your own); `catherd profile set roles.<role>.network false` closes the network for a role and `null` clears it. `doctor` probes each of the five per backend (`access:<backend>`, with the fix for each that fails), and its Codex sandbox probe uses the current `codex sandbox` form.
  - **An enforced protocol.** `dispatch` refuses unknown `Kind:`/`Difficulty:` values (`E_LANE_INVALID`), routes an unrouted lane and appends the reply contract to every brief; `land` needs a reviewer record and a verifier verdict (`E_LAND_GATE`, with `skip: "docs-only" | "no-code"`) and writes the milestone's digest, `<run>/digests/<milestone>.md`, returning it as `digest` (the orchestrator's milestone message links it); `climb` sends plan and ownership problems to the architect (`E_CLIMB_DESIGN`); `run_start` returns the next protocol step and the milestone checklist, and `state.md` ends with `Protocol next:`.
  - **A faster verifier.** A per-repo gate ledger (`gate_check`, `gate_pass`) carries over unchanged gate items; the verifier runs independent items side by side, and `peek` and `status` show its latest step.
  - **Owner questions park one milestone** (`park`, `answer`), not the run; the other milestones go on.
  - **Processes catherd starts no longer see the session.** Workers, the supervisor and a command under `catherd lock -- <cmd>` no longer get `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_HOST_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET` or `CLAUDE_CODE_MESSAGING_TOKEN`; a script that read the session id must take it as an argument.
  - **Failover and validation.** The default failover uses only stand-ins that clear the same bars as their rung (Luna high to OpenCode Go's Luna, Sol medium to Kimi K3; Sol high and xhigh have none, so a limit there pauses the lane). A profile written by 1.0 keeps its own map: `validate` warns on a downgrading stand-in (its fix removes the entry), on a Claude stand-in while another plan could stand in, and on a ladder that goes down; warnings never block a save. `profile show` and the dashboard say "scores borrowed from X" for a stand-in with no scores of its own.
  - **Install and launch.** The marketplace fetches the plugin over HTTPS (no GitHub SSH key needed); the plugin starts its server through a stamped launcher that runs the global `catherd` at the plugin's version, else `bunx catherd-cli@<version>` with its cache in `~/.cache/catherd/bunx` instead of `$TMPDIR`; `init` installs the global command at its own version (`--no-global` skips it); `doctor`'s `mcp` row starts the server as the plugin does and names the reinstall command; the shipped defaults' access rows are info, not warnings.
  - **25 MCP tools:** `wait` removed; `peek`, `gate_check`, `gate_pass`, `park` and `answer` added.

## 1.0.0

### Major Changes

- df2b299: catherd 1.0: a rewrite, and a clean break from 0.x. Run `bunx catherd-cli init` once after upgrading; it moves your 0.x files aside and sets 1.0 up (see MIGRATION.md).

  - **Runs that survive.** Every worker runs detached under a supervisor with idle and wall timeouts, writes straight to disk and is recorded exactly once, even when the MCP server restarts mid-run. Admission is atomic, parallel lanes are checked for overlapping files, and a write outside a lane is reported.
  - **Three backends behind one adapter:** Codex, headless Claude Code (`claude-code:` rungs, beside native Claude subagents) and opencode v2 (OpenCode Go and Zen). Each has a probe with a minimum version, optional isolation, and per-role access (`read-only`, `workspace-write`, `full`) with how strongly the backend enforces it.
  - **A discovery catalog.** catherd lists what each backend offers, scores models from dated sources, ranks cost by how you pay (plan, subscription or per token), and lets you map an unscored model with `treat-like`. Jev is optional: without a key, each lane's own Kind and Difficulty route it.
  - **Profiles, schema 1:** per-role ladders, access, failover to a rung on another quota, a budget and timeouts, kept through `catherd profile`, the TUI or `/catherd-setup`; native Claude roles get linked agent files.
  - **A full CLI:** `init`, `doctor` (one row per check, each with its fix), `profile`, `status`, `watch`, `runs`, `catalog`, `lock` and `capture-fixtures`, with stable exit codes, one-line errors and a log with secrets redacted. catherd keeps its folders `700` and its files `600`.
  - **A new TUI** after opencode's: Status, Profiles and Runs tabs, a command palette, and edits that are saved only through a diff.
  - **21 MCP tools**, three of them new (`cancel`, `record_agent_run`, `wait`); every failure is `{ code, message, fix }`. `dispatch` returns as soon as its role starts, so independent roles run side by side, and `wait` collects their records.
  - Needs Bun 1.4 or newer.

## 0.2.1

### Patch Changes

- 766596f: Briefs pin the lock command to the running catherd version, so a stale `bunx catherd-cli@latest` cache can no longer break it, and `preflight` skips a lane's check when the file it tests does not exist yet instead of failing the run.

## 0.2.0

### Minor Changes

- 78b7e6c: Redesigns the TUI as one bordered-panel frame with a two-pane master/detail layout, a dashboard for the bare `catherd` command, and a single accent colour, replacing the per-row 🐾 clutter and truncated footer.

### Patch Changes

- 183ad9a: `init` finds a Jev key already saved at `~/.config/typesafe/api_key`, so a user who has one never types it again, and the key prompt accepts a pasted key.

## 0.1.0

### Minor Changes

- First release: the `catherd` CLI (profile editor, `init`, `watch`, `lock`, `catalog refresh`), the MCP server with Codex and opencode runners, Jev routing with the model ladder, and the Claude Code plugin with the orchestrator and setup skills. Autopilot guard rails: quota failover, preflight, per-repo knowledge and a run budget.
