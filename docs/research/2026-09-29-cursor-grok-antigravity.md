# Cursor CLI, Grok Build and Antigravity CLI as catherd backends: research, 2026-09-29

This report replaces the desk research in `docs/research/2026-09-25-cursor-grok.md` for catherd 1.3. That report was
written before any of these CLIs had been run. This one runs the real binaries on the owner's machine and reads the
vendor docs of the versions it ran. Where the two reports disagree, this one wins, and §6 says what changed.

Markers used below:

- **[run]**: a command ran here, and its output is quoted.
- **[doc]**: the vendor's docs for the version that ran (the doc path or URL is cited).
- **[bin]**: a string or JS bundle inside the binary. Weaker than a doc and used only where the docs are silent.
- **UNVERIFIED**: none of the above. Each one comes with the reason and a live-verification step (§8).

## 0. Summary

| | Cursor CLI | Grok Build | Antigravity CLI |
|---|---|---|---|
| Binary | `cursor-agent` (also `agent`) | `grok` (the installer also links `agent`) | `agy` (the Homebrew cask links `antigravity` as `agy`) |
| Version run | 2026.09.28-64d2043 (latest); the owner's install is 2026.06.04 | 1.0.44 (stable); alpha 1.0.45. The owner's install is a **Linux** build of 0.2.117 that cannot run on macOS | 1.2.13 (released 2026-09-29) |
| Headless | `-p --output-format stream-json` | `--prompt-file F --output-format streaming-json` | `-p <prompt> --output-format stream-json` |
| Signed in here | **no**: Keychain tokens exist, but every call says "Authentication required" | **no**: the owner's token expired on 2026-08-01, and grok deleted `auth.json` when the refresh failed | **no**: never signed in on this machine |
| Enforced read-only | `--mode ask` (tool-level; the kernel level is UNVERIFIED) | a kernel sandbox, but the built-in `read-only` profile **refuses to start** on a Mac with Docker Desktop or OrbStack (§3.6) | **none**: deny rules in a global settings file only |
| Cost in the stream | no | `end.total_cost_usd` on API-key traffic only | no |
| Verdict | Buildable; the stream contract is still UNVERIFIED until a signed-in capture | Buildable, with two design changes (isolation, read-only on macOS) | Buildable for write roles. Read-only needs an owner decision (§4.9) |

None of the three was signed in, so **no model turn ran**. Everything a real turn produces is from the docs or the
binary, and is marked. What did run: install, `--help`, version, the login probes, argument validation, exit codes,
the unauthenticated error streams, sandbox-profile application (grok), config discovery (`grok inspect --json`), and
the model listings as far as they answer logged out.

Side effects of this research on the owner's machine, for the record:

- Running grok 1.0.44 against the default `~/.grok` removed `~/.grok/auth.json`. The token in it had expired on
  2026-08-01, and the refresh token was rejected (`invalid_grant`), so it was already unusable. `grok login` is needed
  either way (§3.9).
- Each unauthenticated `agy -p` opened a Google sign-in page in the browser and waited 60 s (§4.8). The owner pasted
  one code back, but a code is bound to the PKCE verifier of the process that asked for it. Those processes had
  exited, so the code was not used.
- `cursor-agent create-chat` created one empty chat in `~/.cursor/chats`.
- All binaries were run from the session scratchpad, not installed. Grok and Antigravity ran with a scratch
  `GROK_HOME` / `HOME`, except the one grok run above.

## 1. Environment and method

- macOS 26 (Darwin 25.6.0), arm64. Bun 1.4.0. catherd 1.2.0 (`catherd --version`). Docker through OrbStack:
  `/var/run/docker.sock -> /Users/vigen/.docker/run/docker.sock` (a symlink, which matters for grok, §3.6).
- Binaries were downloaded to the scratchpad:
  - Cursor: `https://downloads.cursor.com/lab/2026.09.28-64d2043/darwin/arm64/agent-cli-package.tar.gz`. The version
    comes from the current `https://cursor.com/install` script.
  - grok: `https://x.ai/cli/grok-1.0.44-macos-aarch64`. The version comes from `https://x.ai/cli/stable`, which answers
    `1.0.44`; `/alpha` answers `1.0.45`.
  - agy: `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.2.13-6662628811079680/darwin-arm/cli_mac_arm64.tar.gz`.
    That is the URL of the Homebrew cask `antigravity-cli` 1.2.13. `https://antigravity.google/cli/install.sh` answers
    **HTTP 403** from this network.
- Vendor docs:
  - Cursor: `https://cursor.com/docs/cli/*.md`.
  - grok: the user guide the binary installs into `$GROK_HOME/docs/user-guide/` (29 files, 1.0.44). The `.md` pages on
    docs.x.ai now return 404.
  - Antigravity: `antigravity.google/docs/*` answers 403 from here. It was read through Wayback Machine snapshots dated
    2026-09-16..25. The CLI's own `agy changelog` was also read; it is bundled in the binary, so it is exact for
    1.2.13.
- The raw notes of the three doc sweeps are not committed. Every fact used below is restated here with its source.

## 2. Cursor CLI (`cursor-agent`) 2026.09.28-64d2043

Sources:
- **[doc]** is `https://cursor.com/docs/…/*.md` as fetched on 2026-09-29.
- **[bin]** is the bundled JS in the package, cited as `<chunk>.index.js@<offset>`.
- The owner's install is 2026.06.04-5fd875e. It has not auto-updated in four months, although auto-update is on by
  default.

### 2.1 Install, version, update, the name `agent`

- **[run]** `cursor-agent --version` → `2026.09.28-64d2043`.
- **[run]** The install script puts versions in `~/.local/share/cursor-agent/versions/<v>/` and links
  `~/.local/bin/agent` **and** `~/.local/bin/cursor-agent` to the current one. It first runs
  `rm -f ~/.local/bin/agent ~/.local/bin/cursor-agent`.
- **[run]** On this machine `~/.local/bin/agent` points at grok (§3.1). Whichever of the two installers ran last owns
  `agent`. **Probe `cursor-agent` first, and accept `agent` only when `--version` prints Cursor's date-hash format.**
  Plan 8's A1 is confirmed and now has a real collision behind it.
- [bin] The update channel is `prod` by default. `lab` in the download URL is only a path. Auto-update runs in
  headless too, 2 s after start, unless the hidden `--disable-auto-update` flag is given. **No env var turns it off**
  (`AGENT_CLI_UPDATE_CHECK_URL` only moves the check). Running processes protect their own install dir from cleanup
  (changelog 2026-07-13).

### 2.2 Headless

- **[run]** `--help` shows:
  - `-p/--print` ("Has access to all tools, including write and shell"), `--output-format text|json|stream-json`,
    `--stream-partial-output`;
  - `--mode plan|ask`, `--plan`, `--resume [chatId]`, `--continue`, `--model` (with bracket overrides),
    `--list-models`;
  - `-f/--force` and `--yolo` ("Run Everything"), `--auto-review`, `--sandbox enabled|disabled`, `--approve-mcps`;
  - `--trust`, `--workspace`, `--add-dir <path>` (repeatable), `--plugin-dir`, `-w/--worktree`, `--api-key`,
    `-H/--header`, `-e/--endpoint`.
- Hidden flags [bin] that matter for a worker:
  - `--new-session-id <uuidv4>`: the caller picks the chat id.
  - `--disable-auto-update`.
  - `--background-shell-timeout <s>` and `--single-turn`: bound the wait for background shells after the last turn.
  - `--exclude-workspace-context` and `--disable-project-configs`.
  - `--image <path>`: "internal only".
  - `--auth-token`.

  Hidden flags can change without notice. The adapter uses only those it needs and pins each one in a simulator case
  and a live case.
- Prompt [bin `6949.index.js@9563`]: the positional words are the prompt. stdin is read to EOF **only when there is no
  positional prompt**, and stdin not being a TTY also turns on print mode. So the brief can go on stdin, which is
  catherd's rule. Plan 8's A8 is confirmed from the code; live it is UNVERIFIED.
- **[run]** An unknown flag exits **1** with `error: unknown option '--bogus-flag'` (commander). A bad `--sandbox` or
  `--mode` value exits 1 with `error: option '--sandbox <mode>' argument 'bogus' is invalid. Allowed choices are
  enabled, disabled.` There is no exit 2. `cli-too-old` must match the text `unknown option`.
- **[run]** When there is no auth, `-p` exits 1 **before** the trust check, with
  `Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.` on
  **stderr** and nothing on stdout.

### 2.3 The stream, usage, status

- [doc output-format; bin `6949@565224`, `@571182`] `system/init`: `{apiKeySource: env|flag|login, cwd, session_id,
  model: <display name, not the slug>, permissionMode: "default" (hard-coded)}`. Then come `user`, `assistant` and
  `tool_call` started/completed (`readToolCall`, `writeToolCall`, other tools as `function`). The run ends with
  `result: {subtype, duration_ms, duration_api_ms (= duration_ms), is_error, result, session_id, request_id,
  usage?}`.
- [bin] Also emitted, but undocumented:
  - `thinking` (delta/completed), despite the doc's "suppressed in print mode";
  - `retry` (starting/resuming), `connection`, `interaction_query`;
  - `system/task_notification` and `system/background_shell_timeout`.

  The parser ignores unknown types.
- Usage [bin `6949@564048`]: `usage: {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`, summed over
  the run, with `inputTokens = max(total - cacheRead - cacheWrite, 0)`. **Uncached only**, which confirms plan 8's A10
  arithmetic (`input = inputTokens + cacheReadTokens + cacheWriteTokens`). There is no cost field.
- `result.result` is every assistant text delta concatenated. The text format prints only the text after the last
  tool call, so the reply is the last `assistant` message (plan 8's A10 holds).
- Failure [bin; doc]: there is no `result` event. The error text goes to stderr, with exit 1. Exit codes are 0, 1, 130
  (SIGINT) and 143 (SIGTERM).
- Limits [bin `index.js@4146371`]: `ActionRequiredError`, with server codes mapped to actions:
  - `FREE_USER_USAGE_LIMIT`, `PRO_USER_USAGE_LIMIT`, `*_RATE_LIMIT_EXCEEDED`, `RATE_LIMITED*` → `upgrade`;
  - `USAGE_PRICING_REQUIRED*` → `payment`;
  - `BAD_API_KEY` and `OUTDATED_CLIENT` → `config`.

  The user-facing text comes from the server. "Spend Limit" is not in the binary, so the 2026-09-25 regex is a guess.
  Match `usage limit|rate limit|ActionRequiredError|RATE_LIMIT|USAGE_LIMIT|too many requests`, keep
  `administrator has disabled` as `failed`, and map `OUTDATED_CLIENT` to `cli-too-old`.
- Team policy texts [bin `6949@732783`]:
  - `Error: Your team administrator has disabled the 'Run Everything' option.`
  - `Error: Your team administrator has disabled headless Cursor CLI usage.`

### 2.4 Models and effort

- [bin `9517@1021`] `models` and `--list-models` print text only: a dim `Available models` header, then
  `<id> - <Display Name>` lines with ` (current, default)` markers, then a tip. There is no JSON option
  (`models --help` shows only `-h`). The empty case is `No models available for this account.` [run] The owner's old
  2026.06.04 printed exactly that, with exit 0, while logged out in practice. The new build exits 1 with
  "Authentication required".
- Effort [help; bin `3483@32325`]: there is still no `--effort`. `--model` takes either a legacy slug with the effort
  in the name (`gpt-5.3-codex-high`, matched through `legacySlug`), a family name (the saved parameters, else the
  default variant), or a **bracket variant string** such as `'claude-opus-4-8[context=1m,effort=high,fast=false]'`.
  The bracket string must equal a server-sent variant **character for character**; the client does not parse it. A
  mismatch exits 1 with `Cannot use this model: <m>. Available models: …`. The listing does not print the variant
  strings, so catherd can neither discover nor build them reliably.
  **Consequence:** plan 8's A7 (fold effort-suffixed slugs from the listing) stays the only listing-based way. Whether
  the owner's account still lists suffixed slugs is UNVERIFIED (no login).
- Aliases [bin]: `composer-2` → `composer-2.5`, and `composer-2-fast` → `composer-2.5-fast`. New installs default to
  `auto` (changelog 2026-07-06).
- Billing pools [doc models-and-pricing]: "Cursor Models" (Composer 2.5, Grok 4.7/4.6/4.5, "jointly trained by
  Cursor and SpaceXAI") and "Other Models", "charged at the model's API price". Teams add $0.25 per million tokens on
  third-party models.

### 2.5 Resume

- **[run]** `cursor-agent create-chat` → a bare UUID on stdout, exit 0, with no auth needed. It creates
  `<configDir>/chats/<md5(cwd)>/<uuid>/store.db` [bin `3726@65`].
- [bin `6949@728513`] An explicit `--resume <id>` is looked up under `chats/<md5(process.cwd())>/`. Only the picker
  searches across workspaces, so the changelog's "resume chats from any directory" is about the picker. **An unknown
  id, or the right id from another cwd, silently starts an empty session under that id.** The store opener creates
  the directory. This is inferred from the code and UNVERIFIED live. The 2026-09-25 research copied paperclip's
  "unknown chat" regex, which would therefore never fire. catherd must resume from the same cwd, and the adapter should
  detect an empty resumed context: a resumed run whose first `assistant` event does not know the earlier turn cannot be
  detected from the stream. So the defence is to always resume with the recorded cwd, which catherd already does
  (`repo`).
- [bin `6949@741976`; changelog 2026-05-14] "Resuming a conversation recomputes Run Everything from your config and
  team policy". The sandbox mode comes from the config or `--sandbox` of each run. **Resume does not have to keep the
  same access**: each run applies its own flags. `sameAccessOnly: false`.

### 2.6 Permissions, sandbox, access

- **`-p` without `--force` auto-rejects any approval** [bin `6949@733504`]. In headless mode the decision provider
  is AlwaysApprove when `--force` (or `approvalMode: "unrestricted"`) is set, else AlwaysDeny. It neither stalls nor
  applies. Web search is rejected unless `autoAcceptWebSearch`, and web fetch unless the domain is in
  `permissions.allow`.
- The docs disagree on plain workspace edits without `--force`:
  - headless.md: "changes are only proposed, not applied";
  - parameters.md: "has access to all tools, including write and shell";
  - security.md: "Agents can modify workspace files without approval, except for configuration files".

  This needs a live check (§8).
- **`--force` disables the sandbox** [bin `5083@30206`: `"unrestricted"===l ? {type:"insecure_none"} : …`; doc
  run-modes: "Run Everything | Every tool call runs automatically. | Sandbox: No"]. This **refutes** spec 1.0 §6.4
  ("otherwise `--force` with `--sandbox enabled`") and plan 8's A2. The corollary [doc run-modes]: headless **without
  `--force` but with `--sandbox enabled`** runs sandboxable shell commands without asking, and rejects the rest.
- Sandbox policy [doc reference/sandbox]:
  - Files: `~/.cursor/sandbox.json` and `<workspace>/.cursor/sandbox.json`, and the repo file wins.
  - `type`: `workspace_readwrite|workspace_readonly|insecure_none`.
  - `additionalReadwritePaths` and `additionalReadonlyPaths`: **extra writable roots, for the lock dir and caches**.
  - `disableTmpWrite`, `enableSharedBuildCache`.
  - `networkPolicy {default: deny|allow, allow[], deny[]}`, with domains, wildcards or CIDR. Private and metadata IPs
    are always blocked. Is loopback a "private IP"? UNVERIFIED; this matters for 1.1 §5's loopback bind.
  - Protected paths include `.cursor/*.json`, `.claude/*.json`, `.git/hooks/**` and `.git/config`.
  - `cli-config.json` also has `sandbox.mode` and `sandbox.networkAccess`
    (`allow_all|user_config_only|user_config_with_defaults`).
- `workspace_readonly` exists as a sandbox `type`. **That is a kernel-level read-only**, which the 2026-09-25
  research did not know. Setting it per run needs a `sandbox.json`. The repo one is the repo's file (catherd must not
  write it), and the user one is global. Isolated `HOME` or `CURSOR_CONFIG_DIR` puts one where catherd owns it. Which
  directory the CLI reads `sandbox.json` from when `CURSOR_CONFIG_DIR` is set is UNVERIFIED.
- Platforms [doc run-modes]:
  - macOS uses Seatbelt (`sandbox-exec`).
  - Linux uses Landlock and seccomp. It needs kernel ≥ 6.2 and unprivileged user namespaces, with Bubblewrap as a
    fallback.
  - When the sandbox is enabled but unavailable, the CLI fails fast: `Error: Sandbox mode is enabled but not available
    on this system.`
- [bin] A hidden `agent sandbox enable|disable|reset|run` exists. `sandbox run` takes `--allow-paths`,
  `--readonly-paths`, `--blocked-patterns` and `--network`. **This is a direct way to run doctor's five access probes
  inside Cursor's sandbox without a model turn**, as `codex sandbox` does for Codex. It is hidden, and UNVERIFIED live.
- `--mode ask` is "Q&A style … (read-only)". It is a mode, not a kernel policy. With the AlwaysDeny provider in
  headless mode, a write or shell call in ask mode is rejected, not stalled.
- `--add-dir`: each root must be trusted. Whether it adds a sandbox read-write root is UNVERIFIED; use
  `additionalReadwritePaths`.

### 2.7 Trust

[bin `6949@21758`] Without `--trust`, `-p` prints `⚠ Workspace Trust Required … Pass --trust, --yolo, or -f if you
trust this directory` and exits 1. The check covers every root, including `--add-dir` roots. `--trust` persists
`{trustedAt}` to `~/.cursor/projects/<slug>/.workspace-trusted`. `--force` skips the check without saving it. This
confirms the 2026-09-25 research.

### 2.8 The user's config, and isolation

- Loaded by the CLI [bin `5083`, `index.js@4953225`, `@4973696`, `190@74039`]. **Third-party loading is hard-coded
  on in the CLI** (`getThirdPartyExtensibilityEnabled: () => true`); the IDE's toggle has no CLI counterpart.
  - Skills from `.cursor`, `.claude`, `.codex`, **`.grok`** and `.agents` (workspace and `~`).
  - Rules and `AGENTS.md`, `CLAUDE.md` and `CLAUDE.local.md` in the cwd **and every ancestor**.
  - Commands from `.claude` and `.cursor`.
  - Hooks from `/etc/cursor/hooks.json`, the team, `~/.cursor/hooks.json`, `.cursor/hooks.json` and
    **`~/.claude/settings.json`, `.claude/settings.json`, `.claude/settings.local.json`**.
  - Claude `enabledPlugins` and marketplaces.
  - **Claude Code permission rules** from `~/.claude/settings.json`.
  - `~/.cursor/mcp.json` and `.cursor/mcp.json`.
  - Server-side User Rules (UNVERIFIED; no client code).
- `CURSOR_CONFIG_DIR` (else `$XDG_CONFIG_HOME/cursor` on **every** OS, else `~/.cursor`) moves `cli-config.json` and
  the chats. `CURSOR_DATA_DIR` moves `projects/`, which holds trust and transcripts. Neither stops the reads of
  `~/.claude`, `~/.codex`, `~/.grok` and `~/.agents`, which use `os.homedir()`. **Only a separate `HOME` isolates.**
- Auth under a separate `HOME` [bin; changelog 2026-06-29]:
  - The macOS Keychain (services `cursor-access-token`, `cursor-refresh-token`, `cursor-api-key`; account
    `cursor-user`) is per user, not per `HOME`. Whether it is still found under another `HOME` is UNVERIFIED.
  - `AGENT_CLI_CREDENTIAL_STORE=file` stores a 0600 `~/.cursor/auth.json` (macOS) or
    `$XDG_CONFIG_HOME/cursor/auth.json` (Linux).
  - `CURSOR_API_KEY` needs no store at all.

  Plan 8's A9 (isolation needs `CURSOR_API_KEY`) stays the safe rule.

### 2.9 Auth, login probe

- **[run]** `cursor-agent status` → `✓ Login successful!` / `Logged in (unable to fetch user details)`, exit 0.
  `status --format json` → `{"status":"authenticated","isAuthenticated":true,"hasAccessToken":true,
  "hasRefreshToken":true,"message":"Logged in (unable to fetch user details)"}`. But every real call fails with
  "Authentication required". **`status` reports token presence, not a working login.** Plan 8's A5 would call this
  machine logged in. The login probe must be a call that reaches the server: `models` (exit 1 with "Authentication
  required" on the new build) or `about --format json` (`userEmail: null`, `subscriptionTier: null` here).
- **[run]** `about --format json` → `{"cliVersion":"2026.09.28-64d2043","latestStatus":"unavailable","model":"GPT-5.2
  Medium","subscriptionTier":null,"osPlatform":"darwin","osArch":"arm64","userEmail":null,…}`.
- Login is `agent login` (browser; `NO_OPEN_BROWSER=1`), `CURSOR_API_KEY` / `--api-key`, or `CURSOR_AUTH_TOKEN` /
  `--auth-token`.

### 2.10 Exit, images, MCP

- After the last turn, the run waits for background shells **with no limit by default**, and for subagents without a
  bound (changelog 2026-08-11). `--background-shell-timeout` or `--single-turn` bound the shell wait. catherd's grace
  kill after `result` stays necessary.
- Images: the documented way is a path in the prompt ("the agent will automatically read the files"). The hidden
  `--image` is "internal only". A worker can read image paths named in the brief.
- MCP: `agent mcp list|list-tools|login|enable|disable`. `--approve-mcps` auto-approves project servers; global ones
  load without asking. MCP calls follow the approval rules of §2.6.

## 3. Grok Build (`grok`) 1.0.44

### 3.1 Install, version, update channel

- **[run]** `curl -fsSL https://x.ai/cli/stable` → `1.0.44`, and `/alpha` → `1.0.45`. The binary is
  `https://x.ai/cli/grok-<v>-<os>-<arch>`, where os is `macos|linux|windows` and arch is `x86_64|aarch64`. The
  fallback host is `storage.googleapis.com/grok-build-public-artifacts/cli`.
- **[run]** `grok --version` → `grok 1.0.44 (5b807183dd79)`. `grok version` is an alias.
- **[run]** The installer (`https://x.ai/cli/install.sh`) downloads to `~/.grok/downloads/grok-<platform>` and
  symlinks **both `~/.grok/bin/grok` and `~/.grok/bin/agent`** to it (`ln -sf "$link_target" "$BIN_DIR/agent"`).
  On this machine `~/.local/bin/agent` points to `~/.grok/bin/agent`, so **the name `agent` on PATH is grok, not
  Cursor.** This confirms plan 8's Review Focus 1 with a real case: catherd must never take `agent` for Cursor
  without checking what it is (§2.1).
- **[run]** The owner's `~/.grok/bin/grok` is an ELF aarch64 Linux binary of 0.2.117, and zsh says
  `exec format error`. The `internal` installer channel in `~/.grok/config.toml` probably put it there. catherd's
  probe must report this ("installed but cannot run: reinstall") rather than "not installed".
- **[doc]** 26-config-reference: channels `stable` (weekly) and `alpha`. `grok update [--check [--json]] [--stable|--alpha] [--version V]`.
  **[bin]** An `enterprise` channel also exists.
- **[doc]** 14-headless-mode § Update Check Suppression: auto-update is suppressed when stderr is not a TTY, by
  `--no-auto-update` (hidden in `--help`; **[run]** accepted), and by `GROK_DISABLE_AUTOUPDATER=1`. Update messages go
  to stderr.
- **[doc]** 26: `[cli] required_minimum_version` / `required_maximum_version` in managed config make the CLI refuse to start.

### 3.2 Headless mode

- **[run]** `--help`: `-p, --single <PROMPT>`, `--prompt-file <PATH>`, `--prompt-json <JSON>`, `--output-format
  plain|json|streaming-json|streaming-messages-json`, `-m/--model`, `--reasoning-effort` (alias `--effort`),
  `--cwd`, `--always-approve`, `--permission-mode default|acceptEdits|auto|dontAsk|bypassPermissions|plan`,
  `--allow`/`--deny RULE`, `--tools`/`--disallowed-tools`, `--sandbox <PROFILE>` (env `GROK_SANDBOX`), `--max-turns`,
  `-s/--session-id`, `-r/--resume [ID_OR_TITLE]`, `-c`, `--fork-session`, `--restore-code`, `--rules`,
  `--system-prompt-override`, `--json-schema`, `--no-subagents`, `--disable-web-search`, `--verbatim`, `-w/--worktree`.
- **[run]** Hidden flags that parse: `--trust`, `--no-auto-update`, `--yolo`, `--no-memory`,
  `--dangerously-skip-permissions`.
- **[doc]** 14 § Standard Input: "Headless mode does not read piped stdin into the prompt." `--prompt-file` is the
  way in for catherd's brief file.
- **[run]** `grok agent stdio|serve|headless|leader` is an ACP agent. It is not needed for catherd; `-p` is the
  documented headless surface.

### 3.3 The stream, usage, cost and status

**[doc]** 14 § streaming-json. One JSON object per line. The documented types are `text`, `thought`, `tool_call`,
`tool_call_update`, `usage`, `plan`, `available_commands`, `end` and `error`. The docs add that "Grok may also emit
`max_turns_reached` and `auto_compact_*` events; treat the list as non-exhaustive and switch on `type`."

- `usage` is emitted **once per model response** (`messageId, stopReason, usage, signature`). It is not a total.
- `end` is `{stopReason, sessionId, requestId, usage, num_turns, modelUsage, total_cost_usd?, total_cost_usd_ticks?}`.
  `stopReason` is one of `end_turn|max_tokens|max_turn_requests|refusal|cancelled`. "`end` is always the last event."
- Tokens: "`usage.input_tokens` … are **uncached only**", and "`total_tokens = input_tokens +
  cache_read_input_tokens + cache_creation_input_tokens + output_tokens`". `reasoning_tokens` is reported beside them
  and is not added into the total.
- Cost: "`total_cost_usd` appears only when the server reported a **complete** cost. Absence means unreported or
  incomplete, never free." "Cost is stamped for API-key traffic today; pool/OAuth paths often omit it." Ticks:
  1 USD = 10^10. `cost_is_partial: true` drops all cost floats. `usage_is_incomplete` marks missing subagent usage.
- On failure: **[run]** a logged-out run prints exactly one line on stdout and exits 1:
  `{"type":"error","message":"Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n\n…"}`.
  The same text goes to stderr. No `end` follows. The doc's "`end` is always the last event" therefore holds only for
  a run that started a turn. The adapter must treat a terminal `error` with no `end` as the end.
- `json` format: one object `{text, stopReason, sessionId, requestId, usage, num_turns, modelUsage, total_cost_usd?,
  thought?}`. **[run]** On failure it is the same `{"type":"error","message":…}` line.
- **[doc]** Exit codes: 0, 1 (auth, network, runtime), 130 (SIGINT), 143 (SIGTERM). **[run]** An unknown flag exits
  **2** with clap's `error: unexpected argument '--bogus-flag' found`. Exit 2 is not in the docs.
- **[doc]** 14/26 § drain: a one-shot run can wait at exit up to 120 s for subagent usage and about 150 s for
  trace-upload draining (`harness.wait_for_uploads`; `GROK_EXIT_TIMEOUT_SECS` default 20). catherd's grace after the
  final event must allow for this, or kill after the final event and accept `usage_is_incomplete`.

### 3.4 Models and effort

- **[run]** `grok models` (logged out, scratch `GROK_HOME`), exit 0, plain text:
  ```
  You are not authenticated.

  Default model: grok-4.6

  Available models:
    * grok-4.6 (default)
    - grok-4.5
  ```
  There is no `--json`, and no efforts are listed. The default is `grok-4.6` per the binary; the docs still say
  `grok-4.5`, and the README says `grok-build`. The logged-in list (which should add `grok-4.7` and the models from
  `/v1/models`) is **UNVERIFIED**: no login.
- **[doc]** 14: `--effort` canonical levels `none, minimal, low, medium, high, xhigh, max`, "a model only accepts the
  levels its menu advertises". The menu comes from `/v1/models` `reasoning_efforts`, or from config
  `model.<id>.reasoning_efforts`. The only machine-readable effort list is ACP `session/new` `configOptions`. What
  headless does with an unsupported effort is **UNVERIFIED** (ACP drops it with a warning).
- **[run]** `--effort bogus` and `-m no-such-model` fail only after auth ("Not signed in"), so the validation order
  is auth first.

### 3.5 Sessions and resume

- **[doc]**/**[run]** `-s/--session-id <uuid>` creates a **new** session with a caller-chosen UUID, and errors if the
  UUID is invalid or in use. With `-r`/`-c` it needs `--fork-session`. `-r` resumes by id **or title**, and "UUID-shaped
  values always mean IDs". Sessions live in `$GROK_HOME/sessions/<url-encoded cwd>/<id>/` (JSONL is the source of
  truth). They are scoped by cwd, so a resume must use the same `--cwd` and the same `GROK_HOME`.
- **[doc]** 18 § Resuming Sessions: "Passing `--sandbox <profile>` that **differs** from the saved profile is
  **refused with an error**". Omitting `--sandbox` restores the saved profile. **Resume must keep the same access.**
- **[doc]** SIGINT → 130, SIGTERM → 143. State is saved to the last completed tool call, and file edits are not rolled
  back. `grok usage <session> [turn]` prints JSON spend per session.

### 3.6 Sandbox and access

**[doc]** 18 § Built-in Profiles:

| profile | reads | writes | child network |
|---|---|---|---|
| `off` (default) | all | all | all |
| `workspace` | everywhere | cwd, `~/.grok`, `/tmp`, `/var/tmp`, the macOS temp dirs | allowed |
| `devbox` | everywhere | all top-level dirs except `/data` | allowed |
| `read-only` | everywhere | `~/.grok`, `/tmp`, `/var/tmp` | blocked (Linux only) |
| `strict` | cwd, system paths, `~/.grok` | cwd, `~/.grok/sessions`, tmp | blocked (Linux only) |

- "Child-network blocking is enforced on **Linux only** (via seccomp). On macOS it is a no-op." So on macOS no grok
  profile can deny the network.
- Custom profiles go in `$GROK_HOME/sandbox.toml` or project `.grok/sandbox.toml`, under
  `[profiles.<name>] extends, restrict_network, read_only = [...], read_write = [...], deny = [...]`. The key is
  `read_write`, not `write` as the 2026-09-25 research had it. Grants are literal directories, not globs. **Extra
  writable roots can only come from a custom profile's `read_write`**; there is no flag.
- **[run] The runtime-socket refusal.** The binary has a hard-coded deny list of container and system sockets
  (`/var/run/docker.sock`, `~/.docker/run/docker.sock`, podman, containerd, dbus, systemd; **[bin]**). On this Mac:
  ```
  $ grok -p hi --sandbox read-only --output-format streaming-json      # exit 1
  warning: sandbox could not be applied: socket deny resolution failed: could not resolve runtime-socket deny path
    /var/run/docker.sock: endpoint is a symlink
  error: could not apply the 'read-only' sandbox profile; see the warning above for the cause. Refusing to start
    with its protections missing.
  ```
  Results per profile: `read-only` refuses, `strict` refuses, and a custom profile `extends = "read-only"` refuses.
  `workspace`, `devbox`, `off`, and custom profiles `extends = "workspace"` (with `read_write` or `deny`) all get
  past the sandbox and stop only at "Not signed in". The docs do not mention the socket list, and document no key to
  change it. They also contradict themselves on whether a built-in profile that fails "warns and continues" (18 § How
  It Works) or refuses (18 § Direct global write protection). 1.0.44 **refuses**, which corrects the 2026-09-25
  research ("logs a warning and runs unenforced").
  **Consequence:** on any Mac whose `/var/run/docker.sock` is a symlink (Docker Desktop, OrbStack, Colima), a grok
  worker cannot run under a kernel read-only profile. The spec takes this up in §5.3.
- Other sandbox rules [doc]:
  - A non-`off` sandbox refuses the shared leader process.
  - The sandbox is irreversible once applied.
  - `trusted_folders.toml`, `config.toml` and `sandbox.toml` are write-denied inside `workspace`, `read-only` and
    `strict`, so "run `grok --trust` *before* starting a sandboxed run".
  - A symlinked `$GROK_HOME` is refused at sandbox start.
- Permission modes [doc] 22:
  - `bypassPermissions` equals `--always-approve`, which equals `--yolo`. Deny rules and hooks still apply.
  - `auto` in `-p`: a call the classifier will not allow "fails and is reported to the model".
  - `dontAsk` denies anything not pre-approved.
  - What `default` does in `-p` when a call needs approval is **UNVERIFIED**.
- Tool filtering [doc]:
  - `--tools read_file,grep,list_dir,…` and `--disallowed-tools run_terminal_cmd,search_replace,Agent` are headless-only,
    and "`--disallowed-tools` wins".
  - Beware: the compat alias `--disallowedTools` maps to `--deny` (a permission rule), not to `--disallowed-tools`.

### 3.7 Trust

**[doc]** 22 § Best Practices: "Folder trust gates project permission rules … plus startup loading of project
instructions and skills. Headless startup with these sources requires `--trust` or a prior grant." The grant is
persisted in `$GROK_HOME/trusted_folders.toml` (**[run]** the owner's file has `[folders."<path>"] trusted = true`).
Because sandboxed runs cannot write that file, catherd passes `--trust` and accepts that the grant is saved only when
the run is not sandboxed. The alternative is a one-time `grok --trust` probe at `prepare`. Whether an untrusted
headless run fails or silently skips the project's `AGENTS.md` is **UNVERIFIED**; the docs say hooks and skills are
"silently skipped".

### 3.8 The user's config, and isolation

- Grok reads, by default [doc 05, 08, 09, 22]:
  - its own `$GROK_HOME` config;
  - **Claude Code's** `~/.claude/skills`, `commands`, `rules`, `CLAUDE*.md`, `~/.claude.json` (MCP), and
    `~/.claude/settings.json` (hooks **and permission rules**);
  - **Claude Code plugins** from `~/.claude/plugins/`, and `~/.claude/agents/*.md`;
  - **Cursor's** `~/.cursor/{skills,rules,mcp.json,hooks.json}`;
  - `~/.agents/skills/`.
- **[run] `GROK_HOME` plus the ten compat toggles do not isolate.** `grok inspect --json` was run with a scratch
  `GROK_HOME` and `GROK_{CLAUDE,CURSOR}_{AGENTS,RULES,SKILLS,MCPS,HOOKS}_ENABLED=0`. The ten items were marked
  `disabled`, but grok still discovered as active: 12 Claude Code plugins from `~/.claude/plugins/` (their hooks,
  skills and MCP servers), `~/.claude/agents/*.md`, `~/.agents/skills/`, and the permission rules in
  `~/.claude/settings.json`. This refutes plan 8's Ruling B3 premise that `GROK_HOME` plus the toggles make an
  isolated worker. A true isolation needs a scratch `HOME` as well. The docs do not cover whether grok then still
  finds its auth.
- Env overlays [doc 05]: `GROK_CONFIG` / `GROK_CONFIG_PATH` are "allowlisted to soft settings only". They cannot
  change auth, trust or spawned commands.
- `GROK_MEMORY` is off by default (13). `--no-memory` forces it off.

### 3.9 Auth and billing

- [doc 02] Precedence:
  1. A per-model `api_key` / `env_key`.
  2. The session token in `$GROK_HOME/auth.json` (0600).
  3. `XAI_API_KEY`, "fallback when no session token is active".

  So with a live login, the API key is ignored.
- Login: `grok login` (browser, auth.x.ai) or `grok login --device-code`. Tokens have a server expiry, else 30 days.
- **[run] A permanent refresh failure deletes `auth.json`.** From the log of a run against `~/.grok`:
  - `"oidc try_refresh_pure terminal error","error_code":"invalid_grant","error_description":"Invalid or unknown refresh token"`
  - `"auth: cleared credentials after permanent refresh failure","disk_mutation":"file deleted (no scopes left)"`

  **[bin]** It also has "sibling-rotation detected; demoting to transient". The refresh token rotates. Two
  processes that each hold a *copy* of `auth.json` will therefore invalidate each other on refresh, and the loser
  deletes its copy. This settles plan 8's B3 risk: **copying `auth.json` into a catherd-owned `GROK_HOME` is unsafe.**
  One refresh in the copy can log the user out of their own grok.
- Billing: a subscription login (SuperGrok / X Premium+, "free Grok Build usage limit" per the 2026-09-25 research)
  reports no reliable cost. An API key bills the xAI team and reports `total_cost_usd`. Plan names and prices are not
  in the 1.0.44 docs (**UNVERIFIED**).

### 3.10 Limits and errors

- [doc 10, 11]: HTTP 429 and 503/529 classify as `rate_limit`. Retries are `max_retries` (default 8). The user-facing
  limit texts are not in the 1.0.44 docs.
- The 2026-09-25 research's strings came from the source repo at f0e3be11 ("You’ve hit the rate limit for your
  plan…", "free Grok Build usage limit…", `resource-exhausted`, "temporarily at capacity"). **[bin]** They are
  unchanged in 1.0.44: `strings` finds "rate limit for your plan", "free Grok Build usage limit" and
  "temporarily overloaded". A real limit stream is **UNVERIFIED**.
- "Not signed in" is exit 1 with an `error` event (§3.3), so the adapter maps it to `failed` with a login fix, never
  `limit`.

### 3.11 Images, MCP, stdin

- Images: `--prompt-json` takes "JSON content blocks". Whether an image block is accepted is **UNVERIFIED** (no
  example in the docs).
- MCP: `grok mcp …`, `[mcp_servers]` in config, plus Claude and Cursor MCP files unless their toggles are off.
- stdin: not read in headless.

## 4. Antigravity CLI (`agy`) 1.2.13

### 4.1 What exists

Google ships **a standalone headless CLI for Antigravity**: Antigravity CLI, binary `agy`. It is a Go binary of
178 MB that shares the agent core with the desktop app ("Both environments run on the exact same agent core",
docs/cli/overview). Other surfaces, and why they are not the path:

- The desktop app (`brew --cask antigravity` 2.17): installs the app only, with no CLI link.
- The Python SDK (`google-antigravity` on PyPI): wraps a local binary and is Python only.
- The Gemini API "Antigravity agent" (`antigravity-preview-09-2026`): runs in a Google-hosted sandbox, not on the
  local worktree.
- **Gemini CLI**: its own docs say "Unpaid tier and Google One users: Gemini CLI was replaced by Antigravity CLI on
  June 18th, 2026". It is not the Antigravity path.
- npm packages named `antigravity`, `antigravity-cli` and `agy` are squatters.

catherd can drive `agy` directly.

### 4.2 Install, version, update

- **[run]** Cask `antigravity-cli` 1.2.13,6662628811079680 (`auto_updates`; artifact `antigravity -> agy`; zap
  `~/.gemini/antigravity-cli`). The tarball holds one binary, `antigravity`. `antigravity --version` → `1.2.13`.
- [doc] The install script is `curl -fsSL https://antigravity.google/cli/install.sh | bash` → `~/.local/bin/agy`
  (403 from here).
- [doc] A background self-updater runs; opt out with `AGY_CLI_DISABLE_AUTO_UPDATE=true`. Releases are near-daily:
  1.2.9 → 1.2.13 in seven days, per `agy changelog` **[run]**.

### 4.3 Headless mode

- **[run]** `--help` (Go `flag` style; single- and double-dash both parse):
  - `-p/--print/--prompt`, `--output-format text|json|stream-json`, `--input-format text|stream-json`, `--model`;
  - `--effort` "(low|medium|high|max)";
  - `--mode` "(accept-edits, plan)", `--add-dir` (repeatable), `--sandbox`, `--dangerously-skip-permissions`;
  - `--conversation <id>`, `-c/--continue`, `--print-timeout` ("0 waits until the turn completes (default 0s)");
  - `--json-schema`, `--disable-slash-commands`, `--agent`, `--project`, `--new-project`, `--log-file`.
- Corrections to the doc sweep:
  - `--effort` includes `max`.
  - `--add-dir` exists as a flag.
  - The print-timeout default is unlimited (changelog 1.2.6: "Changed the default timeout for headless … from 5
    minutes to unlimited"; the snapshot of the headless doc still says 5 m).
- [changelog 1.1.1] "no longer reading stdin when a prompt is provided via a flag". The prompt is an **argv value**
  (`-p <text>`). catherd's rule is that the brief never goes on argv, so the adapter passes a short pointer instead:
  `-p "Read and follow the brief in <briefPath>"`. The stdin route is `--input-format stream-json`, one NDJSON
  `{"event":"user","message":{"content":"…"}}` per turn, which also keeps the brief off argv. It is **UNVERIFIED**
  live and is the preferred route; see §7.3.
- [changelog 1.2.13] `-p` no longer blocks on an inherited open stdin.

### 4.4 The stream, usage, status

- **[run]** Logged out, `--output-format stream-json` prints one line and exits 1:
  `{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"authentication failed or timed out","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}`.
  `--output-format json` prints the inner object alone. Events are keyed by `event`, not `type`.
- [doc HL] The stream is one `init` event (`{cwd, tools[], permission_mode, model?, agent?}`), then `step_update`
  events, then **exactly one** `result` event.
  - `step_update` is `{conversation_id, step_index, state: ACTIVE|DONE, step_type, tool_name?, text_delta?, usage?,
    tool_info?}`, with `step_type` one of `user_input|agent_response|tool|checkpoint` ("stable, closed-vocabulary").
  - `result.status` is one of `SUCCESS|ERROR|CANCELED|INTERRUPTED|INVALID|WAITING|RUNNING`.
- Tokens: `input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens`. There is no cache-write
  bucket. Whether `input_tokens` includes cache reads is **UNVERIFIED**.
- Cost: **not in the headless output**. It exists only in the status-line data (changelog 1.1.21). catherd prices
  tokens from the catalog.
- Exit codes:
  - 0: success. **Also** an expired `--print-timeout` (partial output plus a stderr warning, changelog 1.1.28), and
    soft-denied tools.
  - 1: failure, for example an unknown model or auth ([run]).
  - **2: argument errors** ([run] `flags provided but not defined: -bogus`, plus the usage text), and protocol misuse
    in stream input.
  - 3: a model or agent failure mid-turn, with an `AGY_ERROR: {…}` line on stderr carrying the canonical status,
    HTTP/gRPC code, retryability and error id (changelog 1.2.6, 1.2.10).

  The adapter's status therefore comes from `result.status`, never from the exit code alone.
- Denied tool calls: "end with a notice naming the refused actions and report them as `denied_actions` in the JSON
  output" (changelog). Where the field sits is **UNVERIFIED**.
- Headless waits for background tasks until the `--print-timeout` deadline, capped at 30 minutes, but "leaves daemon
  background tasks such as dev servers running" (changelog). catherd's grace kill after `result` matters here.

### 4.5 Models and effort

- **[run]** `agy models` logged out: `Fetching available models...` then `Error: Please sign in to view available
  models. Launch the CLI without arguments to sign in.`, exit 1, after about 10 s.
- **[run]** `agy models --output-format json` → exit 1, `flags provided but not defined: -output-format`. The
  changelog (1.1.12) says `models` and `agents` gained `--output-format json|stream-json`, but 1.2.13 rejects it. The
  listing format is therefore **UNVERIFIED** until a signed-in capture.
- [doc] Model slugs can embed the effort (`gemini-3.8-flash-high`, `gemini-3.1-pro-high`). "`--effort` variant
  selection" resolves a model name to another model (changelog), and effort support differs per model (1.2.11).
- [doc docs/models] Plans offer Gemini 3.8 / 3.7 / 3.6 Flash and 3.1 Pro, plus Claude Sonnet 4.6, Claude Opus 4.6 and
  GPT-OSS-120b except on Enterprise.

### 4.6 Sessions and resume

- [doc] `--conversation <conversation_id>` or `-c`. Conversations are scoped to the working directory and stored as
  SQLite under `~/.gemini/antigravity-cli/` (**[run]** `conversation_summaries.db`, `conversations/`). A resumed
  headless run prints only the new response.
- Whether a resume keeps its original permissions and sandbox is **UNVERIFIED**. Permissions come from the global
  settings plus the flags of each run, so a resume probably takes the new run's flags. The adapter declares
  `sameAccessOnly: true` until a capture shows otherwise.

### 4.7 Sandbox and access

- File tools [doc HL]: "Reading and writing files inside your active workspace is auto-allowed; actions such as shell
  commands default to Ask and are soft-denied in headless mode unless you grant them." `--add-dir` widens the
  workspace.
- `--sandbox` [doc SBX, SET]: "terminal sandbox restrictions". It uses Seatbelt on macOS and nsjail or namespaces on
  Linux.
  - It confines **shell commands only**. File tools are governed by permissions.
  - Sandboxed commands reach the workspace, temp and build caches. `~/.ssh` and `.env` are blocked, and `.git` is
    read-only (changelog).
  - The network is limited to domains granted by `read_url(...)` rules, and the default is no network.
- Permissions [doc PERM]:
  - Rules are `deny` / `ask` / `allow` over `write_file(...)`, `command(...)`, `read_url(...)` and so on, with
    "Deny > Ask > Allow".
  - They live in `~/.gemini/antigravity-cli/settings.json`, **which the desktop app also reads**, and in
    `~/.gemini/config/projects/*` project overrides.
  - "Paths allowed under write_file are mounted read-write" in the sandbox. That is how extra writable roots (the
    lock dir and caches) get in.
  - `--dangerously-skip-permissions` approves every tool call. Whether `--sandbox` still confines commands with it is
    **UNVERIFIED**.
- **Read-only has no flag.** `--mode plan` "prepends the /plan instruction prefix", which is a prompt, not a control.
  Enforcement would be deny rules for `write_file(*)` and `command(*)` in the shared settings file. It is
  **UNVERIFIED** whether those beat the workspace auto-allow in headless mode.
- No env var or flag relocates the settings. [run] With `HOME` pointed at a scratch dir, agy created
  `$HOME/.gemini/antigravity-cli/` and `$HOME/.gemini/config/` there. So a per-worker `HOME` *does* relocate config,
  conversations and settings. Whether the macOS Keychain login is still found under another `HOME` is **UNVERIFIED**
  (no login to test with).

### 4.8 Auth and billing

- [doc INST] The Google sign-in token lives in the OS keyring. [changelog] Logout short-circuits "to file storage
  when keyring storage is bypassed or unreachable", so a file fallback exists; its path is **UNVERIFIED**.
- **[run] An unauthenticated headless run does not fail fast.** It prints "Authentication required. Please visit the
  URL to log in: https://accounts.google.com/o/oauth2/auth?…" to stderr, **opens the browser**, waits "(timeout 60s)",
  then emits the `ERROR` result above and exits 1. This contradicts the headless doc ("exits with an authentication
  required error instead of hanging"). catherd must never dispatch to `agy` without a logged-in probe first, or every
  lane opens a browser tab.
- API key: `GEMINI_API_KEY` works **only** with `"modelProvider": "gemini"` in `settings.json` ("Only setting a
  GEMINI_API_KEY environment variable on its own has no effect", INST). It bills the Gemini API project, and it stops
  at once on an exhausted daily quota or spend cap (changelog 1.2.12).
- Plans [doc plans]: Free and Plus have weekly quota; Pro and Ultra have 5-hour and weekly quota, then AI credits.
  Whether the plan terms allow an orchestrator to drive `agy` is **UNVERIFIED** (the terms page is 403 here).
- Quota without spending: `agy -p "/usage" --output-format json` (and `/quota`, `/credits`) answers without an agent
  turn (changelog 1.1.11). That makes it a good `doctor` probe. It is **UNVERIFIED** live.

### 4.9 Images, MCP, stdin, and the verdict

- Images: stream-json input accepts text blocks only ("Submitting any other block type ends the session with an
  error"). `-p` image attachment is **UNVERIFIED**. catherd sets `imageIn: false` for the agy harness until shown.
- MCP: `agy mcp add|list|…` writes `~/.gemini/config/mcp_config.json`. The workspace file is `.agents/mcp_config.json`.
  **[run]** `agy mcp list` → "No MCP servers configured." in the scratch home.
- Verdict:
  - `agy` is a real headless worker, and a status, tokens and resume are there.
  - It cannot enforce read-only by any flag, has no cost, reports a timeout as exit 0, and opens a browser when
    logged out.
  - It fits catherd's `workspace-write` roles with `--sandbox` plus allow rules, run under an isolated `HOME`.
  - Read-only roles need an owner decision (spec 1.3 §8).

## 5. What 1.2's source sync knows about these vendors

Read from the owner's cache `~/.local/share/catherd/sources/` (fetched 2026-09-28T22:02Z) and its `derived.json`.

- The shipped catalog has 11 families: GPT-6 Astra, Sol and Luna; GPT-5.6 Sol, Terra and Luna; Claude Fable 5.1,
  Opus 5.5, Sonnet 5.5, Sonnet 5 and Haiku 4.5. `derived.json` scores rungs of those families only. Every Grok,
  Composer and Gemini row lands in `unmatched`: arena 114, epoch 107, vectara 104 and AA 582 unmatched ids, which
  include `Grok 4.5/4.6/4.7`, `grok-4.5`, `grok-4.6`, `Composer 2.5` and `gemini-3.x`. **To score a new backend's
  models, catherd must add their families.** An alias only helps a family that exists.
- Keyless coverage, by dimension, as of the cache:

| Model | agentic (Arena agent) | steer | honesty (Arena tool-halluc.) | frontend (Arena webdev / Epoch WebDev) | repo_code (Epoch FrontierCode) | terminal (Epoch TB) |
|---|---|---|---|---|---|---|
| Grok 4.7 | xhigh | xhigh | xhigh | xhigh 1629 | — | — |
| Grok 4.6 | xhigh | xhigh | xhigh | high 1621 / 1618 | high 0.480 | — |
| Grok 4.5 | default | default | default | 1552 / 1555 | high 0.424 | — |
| Grok Build 0.1 | — | — | — | — | — | — (AA only) |
| Composer 2.5 | — | — | — | — | none 0.256 | — |
| Gemini 3.8 Flash | high | high | high | high 1580 / 1568 | medium 0.412 | — |
| Gemini 3.7 Flash | high | high | high | high 1593 / 1587 | medium 0.436 | — |
| Gemini 3.6 Flash | high | high | high | high 1536 / 1537 | medium 0.344 | — |
| Gemini 3.1 Pro | preview | preview | preview | 1446 | — | preview 0.59–0.80 |

- AA (keyed) lists Grok 4.5 (high), 4.6 (low, medium, high, xhigh), 4.7 (high, xhigh), "Grok Build 0.1 0616", and
  Gemini 3.x at several efforts. With the owner's AA key these calibrate terminal and repo_code.
- OpenRouter lists `x-ai/grok-4.5`, `4.6`, `4.7` and `x-ai/grok-build-0.1`, which give price and context. models.dev
  has `grok-4-6` (Bedrock) and many `gemini-3-*` entries. Neither has Composer, so **Composer's price is not in any
  keyless source**. It is billed inside Cursor plans.
- Arena and Epoch name efforts (`(xHigh)`, `_high`). Grok Build's own effort names (`low…xhigh`) line up, so
  `adjacent` fills the other efforts of a scored model.
- Cursor-served models: Cursor mostly serves models whose families catherd already has (GPT, Claude, Gemini, Grok),
  under its own slugs. A Cursor rung scores through its family (`on.cursor.id`); only Composer needs a new family.
- Result: after the families are added, every Grok and Gemini rung has measured `agentic`, `steer`, `honesty` and
  `frontend`, and most have `repo_code`. `terminal` needs AA or a stand-in. Composer has only `repo_code` and gets
  inferred stand-ins for the rest (1.2 §6). No hand scores are needed.

## 6. Re-check of the 2026-09-25 research and plan 8's rulings

Verdicts: **confirmed**, **wrong** (with the fix), **unverifiable** (with the reason). "No login" means the check
needs a model turn and none of the CLIs was signed in.

### 6.1 The 2026-09-25 research, Cursor (its §1)

| Claim | Verdict |
|---|---|
| Binary `agent`, fallback `cursor-agent` | **wrong order**: probe `cursor-agent` first. On this machine `agent` is grok (§2.1) |
| Auth by `agent login`, `CURSOR_API_KEY`, `AGENT_CLI_CREDENTIAL_STORE=file` | confirmed. Also `CURSOR_AUTH_TOKEN`. Tokens are in the macOS Keychain (§2.8) |
| Linux auth file paths (`~/.config/cursor/auth.json` …) | confirmed for the file store only (§2.8) |
| `status --format json` tells logged in | **wrong**: it reports token presence. Here it said authenticated while every call failed (§2.9) |
| Prompt on stdin works with no positional | confirmed from the code; unverifiable live (no login) |
| No effort flag; each effort a separate slug; bracket syntax rejected | no effort flag: confirmed. Bracket syntax: **wrong**, it now works but only as an exact server variant string. Legacy slugs are still accepted (§2.4) |
| stream-json schema (init, user, assistant, tool_call, result) | confirmed, plus six undocumented types. `permissionMode` is always `default`, and `model` is the display name (§2.3) |
| `result.usage` camelCase, `inputTokens` excludes cache reads | confirmed, and it **also excludes cache writes** (§2.3) |
| No cost | confirmed |
| Reply = last `assistant` text | confirmed (§2.3) |
| `create-chat` returns an id | confirmed [run]: a bare UUID, no auth (§2.5) |
| Resume from any dir; paperclip's unknown-chat regex | **wrong** for an explicit id: it is looked up by the cwd, and an unknown id silently starts empty (§2.5) |
| Resume recomputes Run Everything | confirmed |
| Untrusted `-p` exits 1 "Workspace Trust Required" | confirmed from the code [bin]; live, the auth check fires first (§2.2) |
| Non-force `-p` on an approval: reject or stall? | resolved: **auto-rejects** [bin] (§2.6). Plain edits without `--force`: unverifiable (the docs disagree) |
| `--force` with `--sandbox enabled` keeps shell sandboxed? | **wrong**: `--force` turns the sandbox off (§2.6) |
| Sandbox policy files and network default-deny | confirmed. Keys corrected: `type`, `additionalReadwritePaths`, `networkPolicy` (§2.6) |
| Headless ignores `sandbox.json` (forum) | unverifiable (no login) |
| `--mode ask` read-only | confirmed as a mode. The kernel read-only is `sandbox.json` `type: workspace_readonly` (§2.6) |
| Models listing `<id> - <Name>` with markers | confirmed [bin]; no JSON (§2.4) |
| Limit regex `usage limit|spend limit|…|ActionRequiredError` | partly **wrong**: "Spend Limit" is not in the binary. Match the error kinds (§2.3) |
| Team policy "Run Everything disabled" is not a limit | confirmed, plus "disabled headless Cursor CLI usage" |
| Unknown flag → `cli-too-old` | confirmed text `unknown option`, **exit 1** [run] |
| Process may not exit after `result` | confirmed: background shells are awaited with no limit (§2.10) |
| Third-party (Claude) hooks and skills load; toggle unknown for the CLI | confirmed and worse: **hard-coded on** in the CLI; Claude permission rules also merge (§2.8) |
| `CURSOR_CONFIG_DIR` isolates | **wrong**: it does not stop the `~/.claude` reads. Only `HOME` isolates (§2.8) |
| User Rules are server-side | unverifiable (no client code; no login) |

### 6.2 The 2026-09-25 research, Grok (its §2)

| Claim | Verdict |
|---|---|
| Stable 1.0.41, installer paths | stable is now 1.0.44. The installer **also links `agent`** (§3.1) |
| `grok models` probe lines | confirmed [run]. The default is now `grok-4.6` (§3.4) |
| `-p` / `--prompt-file`; no stdin; `-p -` literal | the first two confirmed. `-p -`: unverifiable (no login) |
| streaming-json schema, `end` fields | confirmed, plus `available_commands`. `usage` is per response (§3.3) |
| Failure = terminal `error`, no `end` | confirmed [run] for a run that never started a turn (§3.3) |
| Token semantics, `total_cost_usd` only when complete | confirmed (§3.3) |
| Efforts none…max, per model menu | confirmed; `grok models` prints no efforts (§3.4) |
| `-s <uuid>` new-only; `-r` errors on a missing id | confirmed. `-r` also takes a title (§3.5) |
| Sandbox fixed per session on resume | confirmed (§3.5) |
| Built-in profile that cannot apply → warns and runs | **wrong** on 1.0.44 [run]: it refuses. `read-only` and `strict` refuse on a Mac with a symlinked docker socket (§3.6) |
| Custom profile keys `read_only`, `write`, `deny` | **wrong**: `read_write`, not `write` (§3.6) |
| Network blocked under read-only | **Linux only**; a no-op on macOS (§3.6) |
| `--trust` persists | confirmed, except inside a sandbox, which cannot write `trusted_folders.toml` (§3.7) |
| Isolation via `GROK_HOME` + compat toggles + `GROK_MEMORY=0` | **wrong** [run]: Claude plugins, agents, `~/.agents/skills` and Claude permission rules still load (§3.8) |
| Copied `auth.json` may break on refresh | confirmed and worse: refresh tokens rotate, and a permanent failure **deletes** the file (§3.9) |
| Limit texts from source f0e3be11 | still in the 1.0.44 binary [bin]; a live stream is unverifiable (§3.10) |
| Exit 2 on clap errors | confirmed [run]; undocumented (§3.3) |
| `--always-approve` needed in headless | confirmed as the practical choice; `default` mode's headless behaviour is undocumented (§3.6) |
| Headless drains background work before exit | confirmed, with bounds of up to ~150 s at exit (§3.3) |

### 6.3 Plan 8's rulings (`docs/plans/2026-09-26-08-cursor-grok.md`)

| Ruling | Verdict |
|---|---|
| R1 release order (Cursor 1.1, Grok 1.2) | **obsolete**: 1.1 and 1.2 shipped without them. Spec 1.3 replaces D5's phasing |
| A1 `cursor-agent` first, `agent` only with a date version | confirmed, with a real collision (§2.1) |
| A2 `full` = `--force --sandbox disabled`; `workspace-write` = `--force --sandbox enabled` | `full` confirmed. `workspace-write` is **wrong**: `--force` disables the sandbox. Use `--sandbox enabled` without `--force` (§2.6) |
| A3 enforcement advisory for all modes | revise: `workspace-write` is kernel-enforced once §8's check passes. `read-only` becomes enforced with `workspace_readonly` where catherd owns `sandbox.json` (isolated) |
| A4 GPT-6 and Claude on Cursor under canonical ids | unverifiable (no login, no listing). Keep it as a ruling with a live step; add Composer and Grok families (§5) |
| A5 logged in from `status --format json` | **wrong** (§2.9): use a server call |
| A6 live rung `cursor:auto#default` | still reasonable; `auto` is the default for new installs |
| A7 fold effort-suffixed slugs | still the only listing-based route; the bracket strings are not listed (§2.4) |
| A8 brief on stdin | confirmed from the code [bin]; live unverifiable |
| A9 isolated = separate `HOME` + `CURSOR_API_KEY` | confirmed as the safe rule (§2.8) |
| A10 status and tokens | confirmed. Replace the limit texts with the error kinds (§2.3) |
| A11 min version `2026.09.02`, grace 30 s | revise the floor to the verified `2026.09.28` (the owner's 2026.06.04 lacks `--add-dir` and `--new-session-id`). Grace 30 s stays |
| A12 thread from `system/init`, no `create-chat` | keep. The hidden `--new-session-id` could pre-assign a thread, but is not needed |
| A13 default profile keys | re-check against 1.2's profile shape (plan task) |
| A14 tests that used `cursor` as "no adapter" | still true; the test helper must switch to a fake id |
| B1 `--prompt-file`, stdin only when asked | confirmed; `capture.ts` still passes stdin to every CLI (code, `src/services/capture.ts`) |
| B2 built-in profiles native, `catherd-ro`/`catherd-ws` isolated | **wrong** in part: `read-only` refuses on symlinked-socket Macs; key is `read_write`; network control is Linux only (§3.6) |
| B3 isolated needs `XAI_API_KEY`; never copy `auth.json` | confirmed, and stronger (§3.9). But `GROK_HOME` alone is not isolation: a separate `HOME` is needed (§3.8) |
| B4 `-s <uuid>`; thread from `end.sessionId` | confirmed |
| B5 resume `-r` without `--sandbox`; admission enforces `sameAccessOnly` | confirmed; admission still does not enforce it (code, `src/services/admission.ts`) |
| B6 live rung `grok:grok-4.7#low` | unverifiable: the logged-out list shows only 4.6 and 4.5. Use the listing's default model |
| B7 effort table for grok-4.7 | keep as catalog data (`on.grok.efforts`); the CLI lists none |
| B8 Grok families unscored, disabled until treat-like | **obsolete**: 1.2 makes unscored a warning with stand-ins, and the sources hold real Grok values once the families exist (§5) |
| B9 status and tokens | confirmed. Add "Not signed in" → `failed` with the login fix |
| B10 enforcement `enforced` for all modes | **wrong** on macOS for read-only (§3.6), and for network everywhere on macOS |
| B11 min `1.0.41`, `GROK_DISABLE_AUTOUPDATER=1`, grace 30 s, `--trust` | revise the floor to the verified `1.0.44`. The rest stands; the exit drain may exceed the grace (§3.3) |

## 7. Mapping to catherd

### 7.1 Access levels

catherd's levels (1.0 D10, 1.1 §5): `read-only`; `workspace-write` (the repo, the lock dir `<data>/locks`, the real temp
dir, the toolchain caches from `toolchainCaches()`, outbound network and loopback unless `network: false`, and the
local Docker socket); `full`.

| | Cursor | Grok | Antigravity |
|---|---|---|---|
| read-only | `--mode ask --sandbox enabled`, no `--force`. Headless rejects every approval. Isolated: `sandbox.json` `type: workspace_readonly` | `--sandbox read-only` where it applies, else `--sandbox workspace` plus `--tools` limited to the read tools. Always `--always-approve` | no flag. Isolated: deny `write_file(*)` and `command(*)` in the agy home's `settings.json`. Native: not offered, or advisory (owner's choice) |
| workspace-write | `--sandbox enabled`, no `--force`. Writable roots and network through `sandbox.json` (`additionalReadwritePaths`, `networkPolicy`), which catherd can write only in an isolated home | custom `catherd-ws` (`extends = "workspace"`, `read_write = [locks, tmp, caches]`). Network is always open on macOS; `restrict_network` for `network: false` on Linux | `--sandbox` for shell, file tools auto-allowed in the workspace. Roots through `write_file(...)` allow rules, network through `read_url(...)`, both in the agy home's `settings.json`. Shell needs `--dangerously-skip-permissions` or `proceed-in-sandbox` |
| full | `--force --sandbox disabled` | `--sandbox off --always-approve` | `--dangerously-skip-permissions`, no `--sandbox` |
| resume, same access? | not required (each run applies its flags) | **required** (the CLI refuses a different profile) | unknown; declare required until shown |
| doctor's five probes | the hidden `agent sandbox run --allow-paths … --network …` runs a shell in Cursor's sandbox without a model turn | no standalone sandbox runner: "not tested here", with the live-kit step | no standalone runner: same |

### 7.2 Native harness and the isolated toggle

The rule that stands: each role runs in the vendor CLI as the user configured it. Isolation is only the profile's
per-backend toggle. What each CLI reads of the user's setup, and what the toggle has to do:

- **Cursor**: `~/.cursor` plus hard-coded Claude, Codex, Grok and `.agents` reads, and cloud User Rules. The toggle
  needs `HOME=<data>/cursor-home` plus `CURSOR_API_KEY`. The Keychain login may not follow a moved `HOME`
  (unverified). User Rules cannot be isolated.
- **Grok**: `$GROK_HOME` plus Claude and Cursor sources. The compat toggles leave the Claude plugins, agents and
  permission rules on. The toggle needs `HOME=<data>/grok-home` (so `$HOME/.grok` and `$HOME/.claude` are catherd's)
  plus `XAI_API_KEY`, the ten compat toggles off, and `GROK_MEMORY=0`. Never a copied `auth.json`.
- **Antigravity**: `~/.gemini/antigravity-cli`, `~/.gemini/config`, `.agents/`, `GEMINI.md`/`AGENTS.md`. The toggle
  needs `HOME=<data>/agy-home` [run: it relocates everything] plus `GEMINI_API_KEY` and `modelProvider: "gemini"` in
  that home's `settings.json`. The Google login lives in the Keychain; whether it follows is unverified.

The repo's own files (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `.grok/`, `.agents/`) belong to the repo and load in
both modes.

### 7.3 Prompt delivery

- Cursor: stdin (the brief file), no positional.
- Grok: `--prompt-file <brief>`, with `stdinPath: null`.
- agy: there are two ways, and the plan's research task picks one live:
  - `-p "<one fixed line naming the brief file>"`. The brief stays in its file, and argv carries only its path.
  - `--input-format stream-json` with a one-line NDJSON wrapper file on stdin, written by `prepare` next to the brief.

  The first is the default.

## 8. Live verification still owed

These need a signed-in CLI on the owner's machine. Each becomes a step in `docs/dev/live-verification.md` (§11–§13,
written by plans 15–17) and a `capture-fixtures` case.

Cursor (`cursor-agent login`, then update to ≥ 2026.09.28):

1. A `-p stream-json` run with the brief on stdin and no positional. Capture it, with `result.usage`.
2. Without `--force`, `--sandbox enabled`: does a plain file edit apply? Is `bun test` (sandboxable) run? Is a
   `curl https://registry.npmjs.org` allowed by the default `networkPolicy`?
3. `--force --sandbox disabled`: a write outside the repo succeeds.
4. `--mode ask`: a write and a shell call are rejected, not stalled.
5. `--resume <id>` from the same cwd keeps context; from another cwd it starts empty (the inferred behaviour).
6. `models` on the owner's account: which slugs are listed, and whether effort-suffixed slugs exist for GPT-6, Claude
   and Grok.
7. `HOME=<tmp>` with `CURSOR_API_KEY`: the run works, and loads no `~/.claude` hooks.
8. `sandbox.json` under `CURSOR_CONFIG_DIR` / an isolated `HOME`: are `additionalReadwritePaths` and
   `workspace_readonly` honoured?
9. `agent sandbox run --allow-paths <locks> -- sh -c '…'`: the five access probes.
10. A real usage-limit stderr, if one can be hit.

Grok (`grok login`, or `XAI_API_KEY`):

1. A `--prompt-file` run with `-s <uuid>` and `--sandbox workspace`: capture `end` with and without an API key
   (whether cost is present).
2. The `models` list logged in, and whether `grok-4.7` is there.
3. `--sandbox catherd-ws` with `read_write` roots: a lock-dir write and a toolchain-cache write pass. `read-only`
   refuses, as on this machine.
4. `--tools read_file,grep,list_dir` under `workspace`: a write attempt has no tool to call.
5. Resume with `-r` keeps the session; a different `--sandbox` is refused (capture the error).
6. `HOME=<tmp>`, `XAI_API_KEY`, the toggles off: `grok inspect --json` shows no `~/.claude` plugins.
7. The time from `end` to process exit (the upload drain).
8. An unsupported `--effort`: error or ignore?

Antigravity (`agy` interactive sign-in once, or `GEMINI_API_KEY` + `modelProvider`):

1. `models` logged in, with the listing format.
2. A `-p` run with the pointer prompt, capturing `init`/`step_update`/`result` and `usage`.
3. The same with `--input-format stream-json` from a file.
4. `--sandbox --dangerously-skip-permissions`: is a shell write outside the workspace blocked?
5. Deny rules in an isolated `HOME`'s `settings.json`: are `write_file(*)` and `command(*)` refused headless, and
   where do `denied_actions` appear?
6. `--conversation <id>` resume; whether a changed `--sandbox` is accepted.
7. An isolated `HOME` with the Keychain login: does it stay signed in?
8. The `AGY_ERROR` line for a quota stop, if one can be hit. `-p "/usage" --output-format json` as a quota probe.
9. Whether the plan terms allow driving `agy` from an orchestrator (read on a network that reaches antigravity.google).
