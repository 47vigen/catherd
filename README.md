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
- **Claude roles stay native.** `claude:` rungs run as ordinary Claude Code subagents; Codex,
  opencode and headless `claude-code:` rungs run through catherd's MCP server.
- **Survives restarts.** Workers are detached processes writing straight to disk, so a dropped
  MCP server never loses a run.
- **Guard rails for autopilot.** Quota failover to a rung on another quota, a preflight check before any
  worker starts, per-repo knowledge carried between runs, and a run budget.

## Requirements

- [Bun](https://bun.sh) ≥ 1.4
- [Claude Code](https://claude.com/claude-code) (desktop app or CLI)
- At least one worker backend: [Codex CLI](https://github.com/openai/codex) and/or
  [opencode](https://opencode.ai), logged in
- Optional: a TypeSafe API key for Jev, in `TYPESAFE_API_KEY` or saved by `catherd init`

## Install

```sh
bunx catherd-cli init
```

The npm package is `catherd-cli`; the command it installs is `catherd`. `init` asks for the optional Jev key,
writes the default profile and links its Claude agents, lists your backends' models, and ends with a readiness
report (`--no-input` asks nothing and keeps what exists). Then add the plugin to Claude Code:

```sh
claude plugin marketplace add 47vigen/catherd
claude plugin install catherd@catherd
```

Start a new Claude Code session so the plugin, its MCP server and the agent files load, then check with
`bunx catherd-cli doctor`.

## Use

In Claude Code:

- `/catherd <task>` runs a task on autopilot; `/catherd` alone resumes the latest run.
- `/catherd-setup` tunes your profile in conversation: which models and efforts each role may
  use, cost or speed, isolation, budget and failover.

In a terminal:

| Command                                                                                | What it does                                                             |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `catherd`                                                                              | The TUI                                                                  |
| `catherd init [--no-input]`                                                            | First-run setup                                                          |
| `catherd doctor [--json]`                                                              | Readiness report, one row per check with its fix; exits 3 when not ready |
| `catherd profile list\|show\|use [--repo]\|new [--from <p>]\|copy\|rm\|diff\|validate` | Profiles; `use --repo` binds one to the repo you are in                  |
| `catherd profile set <path> <value> [--profile <p>]`                                   | One field, e.g. `roles.verifier.access read-only`, `budget.usd 20`       |
| `catherd status [run]`, `catherd watch [--once] [--interval <s>]`                      | Where runs stand                                                         |
| `catherd runs list [--repo <path>]\|show <id> [--debug]\|cancel <id> <name>`           | Past runs; `--debug` adds exit.json and the stderr and event tails       |
| `catherd catalog refresh\|list\|treat-like <rung> <like>`                              | The models catherd can place                                             |
| `catherd lock [--slots N] -- <cmd>`                                                    | Runs a heavy command behind the machine-wide semaphore                   |

Run them as `bunx catherd-cli <command>` when catherd is not installed globally. Every read command takes
`--json`. Exit codes: 0 ok, 1 error, 2 usage, 3 not ready, 130 interrupted; an error prints
`error E_CODE: message` and a `fix:` line. `--verbose` (or `CATHERD_LOG=debug`) logs more to
`~/.local/share/catherd/logs/`, kept for 7 days with secrets redacted. The TUI takes `--plain` (ASCII only)
and `--reduced-motion`; `doctor` takes `--plain` too.

Run data lives in `~/.local/share/catherd/`, config in `~/.config/catherd/` (both follow
`XDG_*`).

## Develop

```sh
bun install
bun test
bun run typecheck && bun run lint && bun run format:check
```

Design: [`docs/superpowers/specs/2026-09-25-catherd-1.0-design.md`](docs/superpowers/specs/2026-09-25-catherd-1.0-design.md).
Releases go through [Changesets](https://github.com/changesets/changesets): add one with
`bunx changeset`.

## License

MIT
