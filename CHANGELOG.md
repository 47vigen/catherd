# catherd-cli

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
