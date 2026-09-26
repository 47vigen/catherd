# Upgrading from catherd 0.x to 1.0

1.0 is a clean break: it reads none of 0.x's files and converts nothing. One command sets it up:

```sh
bunx catherd-cli init
```

## What `init` does to a 0.x install

- **Moves your 0.x settings aside.** `config.json`, `projects.json` and every profile in `profiles/` that
  0.x wrote (the ones without a `"schema"` field) go from your config folder (`~/.config/catherd/`,
  `$XDG_CONFIG_HOME/catherd/` or `$CATHERD_HOME/config/`) into `0.x-backup-<date and time>/` inside it.
  Nothing is deleted, and 1.0 never reads that folder again.
- **Writes the 1.0 default profile** and makes it active. Your 0.x choices are not carried over: set them
  again with `catherd profile set`, the TUI (`catherd`) or `/catherd-setup` in Claude Code, with the backup to
  compare against. A 0.x rung like `gpt-6-sol#high` is `codex:gpt-6-sol#high` in 1.0: every rung names its
  backend.
- **Replaces the Claude agents.** 0.x linked `catherd-<role>-<model>-<effort>` into `~/.claude/agents`; 1.0
  links `catherd-<profile>-<role>-<model>-<effort>` and removes the 0.x links. Only catherd's own links are
  touched, never a file of yours. Start a new Claude Code session afterwards: it reads agents only at start.
- **Keeps your Jev key.** `credentials.json` stays where it is, and 1.0 reads it. 0.x also read the key
  from TypeSafe's own file (`~/.config/typesafe/api_key`); 1.0 reads only `TYPESAFE_API_KEY` and
  `credentials.json`, so if your key lived only in that file, `init` asks for it once: paste it there.
- Lists your backends' models and ends with `catherd doctor`'s readiness report and the plugin commands.

`init --no-input` does the same without asking anything.

## What it leaves alone

0.x run data. Your data folder is `~/.local/share/catherd/` (or `$XDG_DATA_HOME/catherd/`, or
`$CATHERD_HOME/data/`). 1.0 keeps its runs in `repos/` there and does not read what 0.x left beside it:

- **0.x runs**: one folder per repository, named after the repository's path with the leading `/` dropped
  and every `/` turned into `-` (`/home/you/src/app` became `home-you-src-app/`). Each holds one folder
  per run, with `meta.json`, `ledger.md`, `state.md`, `lanes/`, `roles/` and `shots/`.
- **`models-dev.json`**: 0.x's model catalog snapshot. 1.0 ships its own catalog.

Delete those when you no longer need them. Keep everything else, because 1.0 uses it:

- `repos/`: 1.0's runs.
- `logs/`: 1.0's logs.
- `locks/`: the heavy-command slots (`catherd lock`).
- `discovery/`: each backend's last model listing.
- `codex-home/`: the isolated Codex home, with the sessions an isolated Codex thread resumes from.
- `opencode-home/`: the isolated opencode config.

## Then

1. Update the Claude Code plugin, and start a new session:

   ```sh
   claude plugin marketplace update catherd && claude plugin update catherd@catherd
   ```

2. opencode must be v2 (2.0.16 or newer); 0.x's install hint installed v1:
   `curl -fsSL https://opencode.ai/v2/install | bash`.
3. Check everything with `bunx catherd-cli doctor`: it exits 0 when catherd is ready, and prints the fix
   for every row that is not.

## What else changed

- Bun 1.4 or newer; catherd refuses to start on an older one and says how to upgrade.
- `catherd watch` and the dashboard show 1.0 runs only.
- The MCP server has 20 tools (0.x had 18), and every error is `{ code, message, fix }`; the plugin's skills
  are updated to match, so update the plugin with catherd.
- Exit codes: `0` ok, `1` error, `2` usage, `3` not ready (`doctor`), `130` interrupted.
