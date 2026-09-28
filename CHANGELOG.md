# catherd-cli

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
