# Security

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting:
[github.com/47vigen/catherd/security/advisories/new](https://github.com/47vigen/catherd/security/advisories/new).
Please do not open a public issue, pull request or discussion for it. If the form is not available to you, open an
issue that asks the maintainer for a private contact, with no details of the problem.

Include what you found, the catherd version (`catherd --version`), your OS and Bun version, and the steps to
reproduce it. `catherd doctor --json` output helps; check it for anything you would rather not share first. You can
expect a first answer within a week. Fixes are released as a patch of the latest 1.x version and credited in the
changelog unless you ask otherwise.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | yes       |
| 0.x     | no        |

## What catherd runs

catherd starts the worker CLIs you installed (Codex, opencode, Claude Code) as your user, with your own logins and
your own configuration. It does not sandbox them beyond what each CLI does itself: a role's access (`read-only`,
`workspace-write` or `full`) becomes Codex's sandbox mode, an opencode agent, or Claude Code permission flags
(advisory only: Claude's Bash tool can still write). Treat a catherd run like running those CLIs yourself in the
repository.

Lane-authored shell commands (for example the `preflight` fast checks) run with a small allowlisted environment,
not your full one. catherd removes its own secret (`TYPESAFE_API_KEY`) from the environment of every process it
starts; your backends' own keys stay, because the workers need them.

## What catherd stores, and where

Config lives in `~/.config/catherd/` and data in `~/.local/share/catherd/` (both follow `XDG_CONFIG_HOME` and
`XDG_DATA_HOME`, or sit under `$CATHERD_HOME` when it is set).

| What                                       | Where                                                         | Mode  |
| ------------------------------------------ | ------------------------------------------------------------- | ----- |
| The Jev (TypeSafe) API key, if you save it | `<config>/credentials.json`                                   | `600` |
| Profiles, `config.json`                    | `<config>/`                                                   | `600` |
| Each role's launch spec (`spec.json`)      | the run folder, under `<data>/repos/…/runs/`                  | `600` |
| Run records, briefs, replies, `state.md`   | the run folder                                                | `600` |
| Per-repo `knowledge.md`                    | `<data>/repos/<slug>-<hash8>/`                                | `600` |
| Logs, kept 7 days                          | `<data>/logs/`                                                | `600` |
| Claude agent files                         | `<config>/agents/<profile>/`, linked into `~/.claude/agents/` | `600` |

catherd creates its config and data folders, and every folder under them, `700` (only you), and tightens an
existing config or data folder to `700` the first time it writes there. `catherd doctor` warns when
`credentials.json` is readable by anyone but you and prints the `chmod 600` fix.
Run folders hold your briefs and the workers' replies, which can quote your code: they are as sensitive as the
repository itself.

## Secret redaction

- Every log row is redacted before it is written: the value of any environment variable whose name contains
  `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL` (8 characters or longer), the saved Jev key, and anything
  shaped like a key (private-key blocks, `sk-…`, GitHub, AWS and Slack tokens, `Bearer …`, a URL's password)
  become `[redacted]`, and any environment map is reduced to its variable names.
- `catherd capture-fixtures` applies the same rule, and also strips e-mail addresses and home paths, from the
  streams it records before writing them.

## Network

catherd itself makes two kinds of network call, both optional:

- **Jev routing**, when you give it a TypeSafe key: it sends the routing question (the lane's text and state) to
  `https://api.typesafe.ai/v1`. Without a key nothing is sent, and routing falls back to the lane file and your
  profile.
- **Claude's model list**, when `ANTHROPIC_API_KEY` is set: it reads `https://api.anthropic.com/v1/models`.
  Without the key it uses the list shipped in the package.

Everything else goes through the worker CLIs, under their own terms.
