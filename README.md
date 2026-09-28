# catherd

```
 /\_/\  .  catherd
(=^.^=)/   herds coding agents
 (")(")
```

Autopilot builds from your own Claude Code session. Claude plans and verifies, Codex, opencode or
headless Claude Code workers write the code, and [Jev](https://typesafe.ai) picks the model and effort for each piece
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
- At least one worker backend, logged in:
  - [Codex CLI](https://github.com/openai/codex) 0.157.0 or newer
  - [opencode](https://opencode.ai) **v2**, 2.0.16 or newer: `curl -fsSL https://opencode.ai/v2/install | bash`
    (the npm package `opencode-ai` is v1 and is not supported)
  - Claude Code's `claude` CLI 2.1.282 or newer, for headless `claude-code:` rungs
- Optional: a TypeSafe API key for Jev, in `TYPESAFE_API_KEY` or saved by `catherd init`

`catherd doctor` checks each backend's version and login and prints the fix for anything missing. The default
profile runs its workers on Codex; without Codex, doctor's fix also names how to move those roles to a backend
you have (`/catherd-setup` in Claude Code, or `catherd profile set roles.<role>.rungs <rung>`).

## Install

```sh
bunx catherd-cli init
```

The npm package is `catherd-cli`; the command it installs is `catherd`. `init` asks for the optional Jev key,
writes the default profile and links its Claude agents, lists your backends' models, and ends with a readiness
report (`--no-input` asks nothing and keeps what exists; `--profile <name>` sets up and activates that profile
instead of `default`; piped, it reads one answer per line once stdin closes: the Jev key, the profile, whether to replace it, each on its own line even when a question is skipped). Then add the plugin to Claude Code:

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

| Command                                                                                   | What it does                                                                             |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `catherd`                                                                                 | The dashboard: Status, Profiles and Runs (below)                                         |
| `catherd init [--no-input] [--profile <p>]`                                               | First-run setup                                                                          |
| `catherd doctor [--json]`                                                                 | Readiness report, one row per check with its fix; exits 3 when not ready                 |
| `catherd profile list\|show\|use [--repo]\|new [--from <p>]\|copy\|rm\|diff\|validate`    | Profiles; `use --repo` binds one to the repo you are in                                  |
| `catherd profile use --repo --clear`                                                      | Unbinds the repo you are in; it runs on the active profile again                         |
| `catherd profile set <path> <value> [--profile <p>]`                                      | One field, e.g. `roles.verifier.access read-only`, `budget.usd 20`                       |
| `catherd status [run]`, `catherd watch [--once] [--interval <s>]`                         | Where runs stand                                                                         |
| `catherd runs list [--repo <path>]\|show <id> [--debug [--name <n>]]\|cancel <id> <name>` | Past runs; `--debug` adds exit.json and the stderr and event tails, `--name` one role's  |
| `catherd catalog refresh\|list [--backend <b>] [--role <r>] [--text <t>] [--scored]`      | The models catherd can place, filtered                                                   |
| `catherd catalog treat-like <rung> <like>`                                                | Scores an unscored rung as a scored one                                                  |
| `catherd lock [--slots N] -- <cmd>`                                                       | Runs a heavy command behind the machine-wide semaphore, in its own session (no /dev/tty) |
| `catherd mcp`                                                                             | The MCP server on stdio; the plugin starts it, you never need to                         |
| `catherd capture-fixtures [--backend <b>] [--out <dir>]`                                  | Contributors: records sanitized test fixtures from real runs (see CONTRIBUTING.md)       |

A profile command without a profile name (`show`, `set`, `diff`, `validate`), like the MCP profile tools, acts
on the profile the repo you are in runs on: the one bound to it, else the active one. Run them as
`bunx catherd-cli <command>` when catherd is not installed globally. Every read command takes `--json`; a bare `catherd runs` is `catherd runs list`. Exit codes: 0 ok, 1 error, 2 usage, 3 not ready, 130 interrupted; an error prints
`error E_CODE: message` and a `fix:` line. `--verbose` (or `CATHERD_LOG=debug`) logs more to
`~/.local/share/catherd/logs/`, kept for 7 days with secrets redacted. The dashboard takes `--plain` (ASCII, no colour)
and `--reduced-motion`; `doctor` and `init` take `--plain` for ASCII glyphs too. `NO_COLOR` drops colour, never glyphs.

Run data lives in `~/.local/share/catherd/`, config in `~/.config/catherd/` (both follow
`XDG_*`).

### Environment variables

| Variable                    | What it does                                                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| `TYPESAFE_API_KEY`          | The Jev key, instead of the one `catherd init` saves                                                  |
| `CATHERD_HOME`              | Puts config and data under `$CATHERD_HOME/config` and `$CATHERD_HOME/data` instead of XDG             |
| `CATHERD_LOG`               | Log level: `off`, `error`, `warn`, `info` (default) or `debug` (what `--verbose` sets)                |
| `CATHERD_LOCK_SLOTS`        | `catherd lock`'s slot count when `--slots` is not given (before the profile's `lock.heavy`)           |
| `CATHERD_REDUCED_MOTION`    | Any value: the dashboard's `--reduced-motion`                                                         |
| `CATHERD_NO_KITTY`          | Any value: turns off the kitty keyboard protocol in the dashboard, for terminals it breaks            |
| `CATHERD_CLAUDE_AGENTS_DIR` | Where catherd links its Claude agents (default: `$CLAUDE_CONFIG_DIR/agents`, else `~/.claude/agents`) |
| `NO_COLOR`                  | Drops colour (the dashboard's and `--help`'s; piped `--help` has none either)                         |

For development only: `CATHERD_STORY=1` opens the dashboard's storybook, and `CATHERD_LIVE=1` enables the live
tests (CONTRIBUTING.md has the rest).

### The dashboard

`catherd` opens three tabs: **1 Status** (every check with its fix; `y` copies the fix, `r` checks again),
**2 Profiles** (one tree per profile: roles with their access, default rung, models and efforts, then routing,
harness, budget, failover, timeouts and notify) and **3 Runs** (live roles, climbs, routes, the budget, landed
milestones; `p` pauses). `catherd watch` opens it on Runs.

- `ctrl+p` lists every command with its key and CLI twin; `?` lists the keys that work where you are.
- `ctrl+x` is the leader: `ctrl+x 1`–`3` tabs, `ctrl+x n` new profile, `ctrl+x l` profiles, `ctrl+x u` and
  `ctrl+x r` undo and redo, `ctrl+x q` quit.
- Lists: arrows or `j`/`k`, `pgup`/`pgdn`, `home`/`g`, `end`/`G`, `/` to filter; `space` ticks, `enter`
  changes or opens, `→`/`←` expand and collapse.
- Edits are staged: nothing is written until `ctrl+s` shows the diff and you choose Save or Save & make active.
  `enter` never saves.
- Inside a repo bound to a profile, the dashboard opens on that profile, and making a profile active binds the
  repo to it (as `catherd profile use <name> --repo`).
- `esc` backs out one level and never quits. `q` quits, asking first if something is unsaved; `ctrl+c` quits
  when nothing is, and pressed twice within 1.5 s discards and exits 130.
- Deleting a profile or cancelling a live role takes `ctrl+d` twice.
- `--plain` draws ASCII without colour, `NO_COLOR` drops the colour, `--reduced-motion` stops the spinner.
- Rebind a key in `~/.config/catherd/config.json`: `"keybinds": { "profile.save": "ctrl+w", "app.help": "none" }`
  (the palette shows each command by title; the ids are listed in
  [`src/entry/tui/commands.ts`](src/entry/tui/commands.ts)).

## Upgrading from 0.x

1.0 is a clean break: run `bunx catherd-cli init` once. It moves your 0.x `config.json`, `projects.json` and
profiles into a `0.x-backup-<time>/` folder next to them (it never reads or deletes them), writes the 1.0
default profile, replaces the 0.x Claude agent links with 1.0 ones and keeps your saved Jev key; 0.x run
folders stay where they are, unread. Then update the plugin
(`claude plugin marketplace update catherd && claude plugin update catherd@catherd`) and start a new Claude
Code session. The details are in [MIGRATION.md](MIGRATION.md).

## Docs

| Where                                                                                              | What                                                                  |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [MIGRATION.md](MIGRATION.md)                                                                       | Upgrading from 0.x                                                    |
| [CHANGELOG.md](CHANGELOG.md)                                                                       | Releases                                                              |
| [CONTRIBUTING.md](CONTRIBUTING.md)                                                                 | Development setup, the checks, commits, changesets, live tests        |
| [SECURITY.md](SECURITY.md)                                                                         | Reporting a vulnerability; what catherd stores and how                |
| [`docs/specs/2026-09-25-catherd-1.0-design.md`](docs/specs/2026-09-25-catherd-1.0-design.md)       | The 1.0 design (binding)                                              |
| [`docs/dev/`](docs/dev/)                                                                           | Maintainer docs: live verification, manual tests, dependencies, ideas |
| [`docs/dev/live-verification.md`](docs/dev/live-verification.md)                                   | What CI cannot run: live tests, fixture capture, the Codex sandbox    |
| [`docs/tui-frames.md`](docs/tui-frames.md)                                                         | Every dashboard screen as text (generated, checked in CI)             |
| [`docs/plans/`](docs/plans/), [`docs/handoff/`](docs/handoff/), [`docs/research/`](docs/research/) | How 1.0 was designed and built: plans, reviews, research              |
| [`docs/archive/0.x/`](docs/archive/0.x/)                                                           | The 0.x design and plans, for history                                 |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). CI runs the checks on Linux and macOS, on Bun 1.4.0 and the latest Bun;
what CI cannot run is in [`docs/dev/live-verification.md`](docs/dev/live-verification.md). Report security issues
privately, as [SECURITY.md](SECURITY.md) describes. Everyone taking part follows the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

MIT
