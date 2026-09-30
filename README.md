# catherd

```
 /\_/\  .  catherd
(=^.^=)/   herds coding agents
 (")(")
```

Autopilot builds from your own Claude Code session. Claude plans and verifies, Codex, opencode, Cursor, Grok Build,
Antigravity or headless Claude Code workers write the code, and [Jev](https://typesafe.ai) picks the model and effort for each piece
of work, climbing a ladder only when a cheaper rung falls short.

- **Your harness, as you set it up.** Every role runs in its vendor's own CLI with your config,
  hooks, skills and `AGENTS.md`. Isolation is an opt-in toggle per profile and harness, for when
  you'd rather save the tokens your customizations cost.
- **Claude roles stay native.** `claude:` rungs run as ordinary Claude Code subagents; Codex,
  opencode, Cursor, Grok Build, Antigravity and headless `claude-code:` rungs run through catherd's MCP server.
- **Survives restarts.** Workers are detached processes writing straight to disk, so a dropped
  MCP server never loses a run.
- **Results come to you.** Roles run side by side while you keep talking to Claude; each one that finishes
  arrives in the session as a message, like a native subagent's notice, and `peek` shows how a run stands.
- **A protocol the tools enforce.** Every lane is routed, every brief ends with the reply contract, and a
  milestone lands only after a reviewer and a verifier passed it. Workers can run their own checks (network,
  loopback, Docker, the lock dir); an owner question parks one milestone, not the run.
- **Guard rails for autopilot.** Quota failover to a stand-in that clears the same bars, a preflight check
  before any worker starts, per-repo knowledge carried between runs, and a run budget.

## Requirements

- [Bun](https://bun.sh) ≥ 1.4
- [Claude Code](https://claude.com/claude-code) (desktop app or CLI)
- At least one worker backend, logged in:
  - [Codex CLI](https://github.com/openai/codex) 0.157.0 or newer
  - [opencode](https://opencode.ai) **v2**, 2.0.16 or newer: `curl -fsSL https://opencode.ai/v2/install | bash`
    (the npm package `opencode-ai` is v1 and is not supported)
  - Claude Code's `claude` CLI 2.1.282 or newer, for headless `claude-code:` rungs
  - Cursor's CLI, `cursor-agent` 2026.09.28 or newer: `curl https://cursor.com/install -fsS | bash`, then
    `cursor-agent login` (below)
  - Grok Build's `grok` 1.0.44 or newer: `curl -fsSL https://x.ai/cli/install.sh | bash`, then `grok login`
    (below)
  - Google's Antigravity CLI, `agy` 1.2.13 or newer: `brew install --cask antigravity-cli`, or
    `curl -fsSL https://antigravity.google/cli/install.sh | bash` (with `~/.local/bin` on PATH), then run `agy` once
    to sign in (below)
- Optional: a TypeSafe API key for Jev, in `TYPESAFE_API_KEY` or saved by `catherd init`
- Optional: a free [Artificial Analysis](https://artificialanalysis.ai) API key for more scores, in
  `ARTIFICIAL_ANALYSIS_API_KEY` or saved by `catherd init`; its numbers are read for you alone and never shipped

`catherd doctor` checks each backend's version and login and prints the fix for anything missing. The default
profile runs its workers on Codex; without Codex, doctor's fix also names how to move those roles to a backend
you have (`/catherd-setup` in Claude Code, or `catherd profile set roles.<role>.rungs <rung>`).

### Cursor

A Cursor rung names Cursor's own model slug, with the effort as the slug's suffix: `cursor:gpt-6-sol#xhigh` runs
`gpt-6-sol-xhigh`, and `#default` runs the bare slug (`cursor:composer-2.5#default`). `cursor-agent models` lists
what your account offers; `catherd catalog refresh` reads it. No profile uses Cursor until you put a rung on it.
Its Composer and Grok models bill from Cursor's own pool, the other models at API rates after your plan's included
usage, so a Cursor rung ranks as `metered`.

- **Native** (the default) runs with your login and your Cursor setup. It also loads your Claude Code hooks,
  skills and plugins, which Cursor reads from `~/.claude`. `workspace-write` runs in Cursor's sandbox under your
  `~/.cursor/sandbox.json`, which catherd never edits: `catherd doctor` shows which of a worker's checks (the lock
  dir, temp, loopback, the network, Docker) it allows. `read-only` runs Cursor's ask mode, which asks the model not
  to write but cannot stop it (`advisory`).
- **Isolated** (`catherd profile set harness.cursor.isolated true`) needs `CURSOR_API_KEY`, since a login cannot
  move to another home. catherd runs Cursor under its own HOME with its own `sandbox.json`, which gives a worker
  catherd's writable roots.

### Grok Build

A Grok rung names grok's model and effort: `grok:grok-4.6#high` runs `grok -m grok-4.6 --effort high`, and
`#default` passes no effort. `grok models` lists your models but no efforts, so catherd offers Grok Build's `low`
to `xhigh`; `catherd catalog refresh` reads the list. No profile uses grok until you put a rung on it. A Grok login
(SuperGrok, X Premium+) bills your subscription and `XAI_API_KEY` bills per token: `catherd doctor` says when a
profile's `billing.grok` differs from your login. On a usage limit, a Grok rung fails over to the same model on
Cursor, and a Cursor Grok rung to grok, unless the profile names another stand-in.

- **Native** (the default) runs with your login and your grok setup. It also loads your Claude Code plugins,
  agents, skills, hooks and permission rules, and your Cursor rules and MCP. `workspace-write` runs in grok's
  sandbox under catherd's own profile, `catherd-ws`, which lets a worker write the lock dir, temp and the
  toolchain caches: catherd adds its marked `[profiles.catherd-*]` tables to `~/.grok/sandbox.toml` and leaves the
  rest of that file alone. `read-only` runs grok's kernel `read-only` profile. On a Mac whose
  `/var/run/docker.sock` is a link (Docker Desktop, OrbStack, Colima) grok refuses that profile, so catherd gives
  the role only the read tools instead (`advisory`); `catherd doctor` says which applies. On macOS no grok profile
  controls the network.
- **Isolated** (`catherd profile set harness.grok.isolated true`) needs `XAI_API_KEY`: catherd never copies your
  grok login, whose refresh token rotates. catherd runs grok under its own HOME with its own `sandbox.toml`.

grok keeps a session on the access it started with, so catherd refuses to resume one under another access.

### Antigravity

An Antigravity rung names the model `agy models` lists, without an effort suffix; the effort is agy's `--effort`
(`low`, `medium`, `high` or `max`), and `#default` passes none: `antigravity:gemini-3.8-flash#low`. No profile uses
Antigravity until you put a rung on it. catherd never runs `agy -p` while agy is signed out, since agy would open a
browser and wait; `catherd doctor` says so, with the fix. A Google login draws on your plan's quota (doctor shows
what is left); `GEMINI_API_KEY` bills the Gemini API project. Gemini rungs fail over between Antigravity and Cursor
when either runs out, unless your profile names another stand-in.

- **Native** (the default) runs with your Google login and your `~/.gemini` settings, which the Antigravity desktop
  app shares and catherd never edits. `workspace-write` runs shell commands in agy's sandbox, which reaches the
  workspace, temp and build caches but no network unless your own `read_url` rules grant it; the file tools are not
  confined (`advisory`). agy has no read-only mode, so a read-only role (the reviewer, the architect) cannot run on
  native Antigravity: `profile validate` refuses it.
- **Isolated** (`catherd profile set harness.antigravity.isolated true`) needs `GEMINI_API_KEY`. catherd runs agy
  under its own HOME, with its own settings: the Gemini API as the provider, write and command deny rules for
  read-only roles, and catherd's writable roots and the network for `workspace-write`.

Whether Google's plan terms allow an orchestrator to drive `agy` on a consumer plan is not settled here. The API-key
route is the one meant for automation; check the terms before you rely on a plan login.

## Install

```sh
bun add -g catherd-cli
catherd init
```

The npm package is `catherd-cli`; the command it installs is `catherd`. `bunx catherd-cli init` works too: `init`
installs the global command at its own version (`--no-global` skips it) and says `installing catherd…` before
it does, though the first `bunx` resolve itself prints nothing for up to half a minute. `init` asks for the
optional Jev key and the optional Artificial Analysis key, syncs the public model sources, writes the default
profile and links its Claude agents, lists your backends' models, and ends with a readiness report (`--no-input`
asks nothing and keeps what exists; `--profile <name>` sets up and activates that profile instead of `default`;
piped, it reads one answer per line once stdin closes: the Jev key, the Artificial Analysis key, the profile,
whether to replace it, each on its own line even when a question is skipped). Then add the plugin to
Claude Code:

```sh
claude plugin marketplace add 47vigen/catherd
claude plugin install catherd@catherd
```

Start a new Claude Code session so the plugin, its MCP server and the agent files load, then check with
`catherd doctor`. Run it once from inside that session too (ask Claude to run `catherd doctor`): its `push` row
then checks that finished roles can reach the session.

## Use

In Claude Code:

- `/catherd <task>` runs a task on autopilot; `/catherd` alone resumes the latest run. While it runs, keep
  talking: each finished role arrives as a message from catherd, and "how is it going?" gets a `peek`.
- `/catherd-setup` tunes your profile in conversation: which models and efforts each role may
  use, cost or speed, isolation, budget and failover.

In a terminal:

| Command                                                                                   | What it does                                                                                        |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `catherd`                                                                                 | The dashboard: Status, Profiles and Runs (below)                                                    |
| `catherd init [--no-input] [--no-global] [--profile <p>]`                                 | First-run setup; installs the global `catherd` at its own version unless `--no-global`              |
| `catherd doctor [--json]`                                                                 | Readiness report, one row per check with its fix; exits 3 when not ready                            |
| `catherd profile list\|show\|use [--repo]\|new [--from <p>]\|copy\|rm\|diff\|validate`    | Profiles; `use --repo` binds one to the repo you are in                                             |
| `catherd profile use --repo --clear`                                                      | Unbinds the repo you are in; it runs on the active profile again                                    |
| `catherd profile set <path> <value> [--profile <p>]`                                      | One field, e.g. `roles.verifier.access read-only`, `roles.worker.network false`, `budget.usd 20`    |
| `catherd status [run]`, `catherd watch [--once] [--interval <s>]`                         | Where runs stand, grouped by the Claude Code session that drove them                                |
| `catherd runs list [--repo <path>]\|show <id> [--debug [--name <n>]]\|cancel <id> <name>` | Past runs, by session; `--debug` adds exit.json and the stderr and event tails, `--name` one role's |
| `catherd catalog refresh\|list [--backend <b>] [--role <r>] [--text <t>] [--scored]`      | The models catherd can place, filtered                                                              |
| `catherd catalog sync [--force] [--unmatched]`                                            | Fetches the public model facts and scores now (below); `--unmatched` lists ids no model matched     |
| `catherd catalog treat-like <rung> <like>`                                                | Scores an unscored rung as a scored one                                                             |
| `catherd catalog treat-like --suggest <rung>\|--clear <rung>\|--reset`                    | The three nearest stand-ins for a rung; removes one or every mapping of yours                       |
| `catherd knowledge show\|add "<line>"\|path [--repo <path>]`                              | The repo's knowledge.md, which new runs read; `add` appends a fact of yours, marked "by hand"       |
| `catherd lock [--slots N] -- <cmd>`                                                       | Runs a heavy command behind the machine-wide semaphore, in its own session (no /dev/tty)            |
| `catherd mcp`                                                                             | The MCP server on stdio; the plugin starts it, you never need to                                    |
| `catherd capture-fixtures [--backend <b>] [--out <dir>]`                                  | Contributors: records sanitized test fixtures from real runs (see CONTRIBUTING.md)                  |

A profile command without a profile name (`show`, `set`, `diff`, `validate`), like the MCP profile tools, acts
on the profile the repo you are in runs on: the one bound to it, else the active one. Run them as
`bunx catherd-cli <command>` when catherd is not installed globally. Every read command takes `--json`; a bare `catherd runs` is `catherd runs list`. Exit codes: 0 ok, 1 error, 2 usage, 3 not ready, 130 interrupted; an error prints
`error E_CODE: message` and a `fix:` line. `--verbose` (or `CATHERD_LOG=debug`) logs more to
`~/.local/share/catherd/logs/`, kept for 7 days with secrets redacted. The dashboard takes `--plain` (ASCII, no colour)
and `--reduced-motion`; `doctor` and `init` take `--plain` for ASCII glyphs too. `NO_COLOR` drops colour, never glyphs.

Model facts and scores also come from public sources: models.dev, OpenRouter, LiteLLM, Arena (LMArena), Vectara's
hallucination leaderboard and Epoch AI, plus Artificial Analysis when you give `catherd init` a free key. The MCP
server syncs them in the background when a Claude Code session starts (each source at most every 12 hours, never
delaying the session), `init` syncs them, and `catherd catalog sync` (or the `catalog_sync` tool) does it on demand.
Each answer is kept in `~/.local/share/catherd/sources/`; a source that fails keeps its last good answer, and with no
network and no sync at all catherd routes on the scores it ships. Those are the keyless sources' values, refreshed
weekly (`catalog/ATTRIBUTION.md` credits each source); Artificial Analysis values are read with your key only and
never shipped.

A lane's kind and difficulty pick a bar: a threshold on each dimension it spans (`repo_code`, `terminal`,
`honesty`, `agentic`, `frontend`; `steer` is shown but has no default bar), and the lane starts on the cheapest
rung that clears them all. A rung with no value on a dimension takes its nearest stand-in's as `inferred`, and
`profile validate` and `doctor` list it as a "stand-in to confirm": confirm or replace it with `catherd catalog
treat-like --suggest <rung>`, then `treat-like <rung> <like>`. `route` says, for the rung it picks, each threshold,
the value used, its confidence and source, and catherd's own runs on it ("12 lanes, 2 climbed, 1 partial"), which
it shows but never routes on. A bar of your own goes in `~/.config/catherd/catalog.override.json`, per dimension
(`"bars": { "ui": { "hard": { "frontend": 1700, "honesty": null } } }`: a number sets a threshold, `null` removes
the default's).

Run data lives in `~/.local/share/catherd/`, config in `~/.config/catherd/` (both follow
`XDG_*`).

### Environment variables

| Variable                      | What it does                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `TYPESAFE_API_KEY`            | The Jev key, instead of the one `catherd init` saves                                                        |
| `ARTIFICIAL_ANALYSIS_API_KEY` | An Artificial Analysis key for `catalog sync`, instead of the one `catherd init` saves                      |
| `CATHERD_NO_SYNC`             | `1`: no automatic sync of the public sources (at MCP server start and in `init`); `catalog sync` still runs |
| `CURSOR_API_KEY`              | Cursor's API key: logs `cursor-agent` in, and is what an isolated Cursor role runs on                       |
| `XAI_API_KEY`                 | xAI's API key: logs `grok` in when no Grok login is active, and is what an isolated grok role runs on       |
| `GEMINI_API_KEY`              | The Gemini API key an isolated Antigravity role runs on (agy reads it only with its Gemini API provider)    |
| `CATHERD_HOME`                | Puts config and data under `$CATHERD_HOME/config` and `$CATHERD_HOME/data` instead of XDG                   |
| `CATHERD_LOG`                 | Log level: `off`, `error`, `warn`, `info` (default) or `debug` (what `--verbose` sets)                      |
| `CATHERD_LOCK_SLOTS`          | `catherd lock`'s slot count when `--slots` is not given (before the profile's `lock.heavy`)                 |
| `CATHERD_REDUCED_MOTION`      | Any value: the dashboard's `--reduced-motion`                                                               |
| `CATHERD_NO_KITTY`            | Any value: turns off the kitty keyboard protocol in the dashboard, for terminals it breaks                  |
| `CATHERD_CLAUDE_AGENTS_DIR`   | Where catherd links its Claude agents (default: `$CLAUDE_CONFIG_DIR/agents`, else `~/.claude/agents`)       |
| `NO_COLOR`                    | Drops colour (the dashboard's and `--help`'s; piped `--help` has none either)                               |

For development only: `CATHERD_STORY=1` opens the dashboard's storybook, and `CATHERD_LIVE=1` enables the live
tests (CONTRIBUTING.md has the rest).

### The dashboard

`catherd` opens three tabs: **1 Status** (every check with its fix; `y` copies the fix, `r` checks again),
**2 Profiles** (one tree per profile: roles with their access, default rung, models and efforts, then routing,
harness, budget, failover, timeouts and notify) and **3 Runs** (the Claude Code sessions that drove your runs, newest
first; a session opens on its runs, their milestones and every role with its rung, status, time and last event, live
ones first; a milestone opens on its digest (what landed, lanes and climbs, reviewer and verifier, tokens); a role
opens on its brief, reply and record; the open screen redraws as run files change; `esc` goes back,
`p` pauses). `catherd watch` opens it on Runs.

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

## Upgrading

From 1.0: install 1.1 and run its `init` (`bun add -g catherd-cli@latest && catherd init`, or
`bunx catherd-cli@latest init`; 1.0's own `catherd init` does not upgrade), update the plugin
(`claude plugin marketplace update catherd && claude plugin update catherd@catherd`) and start a new Claude Code
session. `wait` is gone: results arrive as messages, `peek` shows a run, `result` reads a record. A profile saved
by 1.0 keeps its failover map; `catherd profile validate` says what to change. The details are in
[MIGRATION.md](MIGRATION.md).

### From 0.x

1.0 is a clean break: run `bunx catherd-cli init` once. It moves your 0.x `config.json`, `projects.json` and
profiles into a `0.x-backup-<time>/` folder next to them (it never reads or deletes them), writes the 1.0
default profile, replaces the 0.x Claude agent links with 1.0 ones and keeps your saved Jev key; 0.x run
folders stay where they are, unread. Then update the plugin
(`claude plugin marketplace update catherd && claude plugin update catherd@catherd`) and start a new Claude
Code session. The details are in [MIGRATION.md](MIGRATION.md).

## Docs

| Where                                                                                              | What                                                                  |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [MIGRATION.md](MIGRATION.md)                                                                       | Upgrading from 1.0 and from 0.x                                       |
| [CHANGELOG.md](CHANGELOG.md)                                                                       | Releases                                                              |
| [CONTRIBUTING.md](CONTRIBUTING.md)                                                                 | Development setup, the checks, commits, changesets, live tests        |
| [SECURITY.md](SECURITY.md)                                                                         | Reporting a vulnerability; what catherd stores and how                |
| [`docs/specs/2026-09-28-catherd-1.1-design.md`](docs/specs/2026-09-28-catherd-1.1-design.md)       | The 1.1 design (binding; builds on 1.0's)                             |
| [`docs/specs/2026-09-25-catherd-1.0-design.md`](docs/specs/2026-09-25-catherd-1.0-design.md)       | The 1.0 design                                                        |
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
