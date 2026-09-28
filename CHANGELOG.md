# catherd-cli

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
