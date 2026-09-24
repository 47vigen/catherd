# catherd

```
 /\_/\  .  catherd
(=^.^=)/   herds coding agents
 (")(")
```

Autopilot builds from your own Claude Code session. Claude plans and verifies, Codex and opencode
workers write the code, and [Jev](https://typesafe.ai) picks the model and effort for each piece
of work, climbing a ladder only when a cheaper rung falls short.

- **Your harness, as you set it up.** Every role runs in its vendor's own CLI with your config,
  hooks, skills and `AGENTS.md`. Isolation is an opt-in toggle per profile and harness, for when
  you'd rather save the tokens your customizations cost.
- **Claude roles stay native.** Claude models run as ordinary Claude Code subagents; Codex and
  opencode run through catherd's MCP server.
- **Survives restarts.** Workers are detached processes writing straight to disk, so a dropped
  MCP server never loses a run.
- **Guard rails for autopilot.** Quota failover to another backend, a preflight check before any
  worker starts, per-repo knowledge carried between runs, and a run budget.

## Requirements

- [Bun](https://bun.sh) ≥ 1.4
- [Claude Code](https://claude.com/claude-code) (desktop app or CLI)
- At least one worker backend: [Codex CLI](https://github.com/openai/codex) and/or
  [opencode](https://opencode.ai), logged in
- A TypeSafe API key for Jev, in `TYPESAFE_API_KEY` or `~/.config/typesafe/api_key`

## Install

```sh
bunx catherd init
```

`init` asks for the Jev key, finds your backends, and builds your first profile. Then add the
plugin to Claude Code:

```sh
claude plugin marketplace add 47vigen/catherd
claude plugin install catherd@catherd
```

Start a new Claude Code session so the plugin, its MCP server and the agent files load.

## Use

In Claude Code:

- `/catherd <task>` runs a task on autopilot; `/catherd` alone resumes the latest run.
- `/catherd-setup` tunes your profile in conversation: which models and efforts each role may
  use, cost or speed, isolation, budget and failover.

In a terminal:

| Command                        | What it does                                                     |
| ------------------------------ | ---------------------------------------------------------------- |
| `bunx catherd`                 | Profile editor: models and efforts per role, with paw checkboxes |
| `bunx catherd watch`           | Live view of running and recent runs                             |
| `bunx catherd lock -- <cmd>`   | Runs a heavy command behind the machine-wide semaphore           |
| `bunx catherd catalog refresh` | Refreshes the models.dev snapshot                                |

`--plain` and `--reduced-motion` work everywhere.

Run data lives in `~/.local/share/catherd/`, config in `~/.config/catherd/` (both follow
`XDG_*`).

## Develop

```sh
bun install
bun test
bun run typecheck && bun run lint && bun run format:check
```

Design: [`docs/specs/2026-09-24-catherd-design.md`](docs/specs/2026-09-24-catherd-design.md).
Releases go through [Changesets](https://github.com/changesets/changesets): add one with
`bunx changeset`.

## License

MIT
