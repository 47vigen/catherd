# catherd-cli

## 0.2.0

### Minor Changes

- 78b7e6c: Redesigns the TUI as one bordered-panel frame with a two-pane master/detail layout, a dashboard for the bare `catherd` command, and a single accent colour, replacing the per-row 🐾 clutter and truncated footer.

### Patch Changes

- 183ad9a: `init` finds a Jev key already saved at `~/.config/typesafe/api_key`, so a user who has one never types it again, and the key prompt accepts a pasted key.

## 0.1.0

### Minor Changes

- First release: the `catherd` CLI (profile editor, `init`, `watch`, `lock`, `catalog refresh`), the MCP server with Codex and opencode runners, Jev routing with the model ladder, and the Claude Code plugin with the orchestrator and setup skills. Autopilot guard rails: quota failover, preflight, per-repo knowledge and a run budget.
