# Cursor CLI and Grok CLI as catherd worker backends: research report

Date: 2026-09-25. Sources are cited inline. **UNVERIFIED** marks anything I could not confirm from an official doc, the vendor's source code, or a reproduced third-party log. Nothing here was run live: neither CLI is installed in this container. Every claim should be checked against the recorded fixtures listed in section 4 before code relies on it.

Context in catherd: a backend is driven today by `src/core/codex.ts` / `src/core/opencode.ts`: the brief goes in on stdin (codex) or as an argv value (opencode), stdout JSONL is written to `<role>.jsonl`, stderr to a file, and the reply is written to `-o reply` (codex) or taken from events. Other pieces: a thread/session id for resume, `ROLE_SANDBOX` (read-only / workspace-write / danger-full-access), `Tokens {input, cached, output}`, `costUsd`, and `RunStatus` including `limit` and `cli-too-old`.

---

## 0. Which "Grok CLI"?

- **Official:** **Grok Build** (binary `grok`) from SpaceXAI (formerly xAI). Source is published at https://github.com/xai-org/grok-build (Rust, "synced periodically from the SpaceXAI monorepo"; issues are disabled there and filed at xai-org/plugin-marketplace). Docs: https://docs.x.ai/build/overview and https://docs.x.ai/build/cli/headless-scripting. Announcement: https://x.ai/news/grok-build-cli. Current stable channel version: `1.0.41` (from `https://storage.googleapis.com/grok-build-public-artifacts/cli/stable`, which the installer reads). The early beta shipped on 2026-05-14 for SuperGrok Heavy and widened on 2026-05-25 to SuperGrok and X Premium+ (https://www.buildfastwithai.com/blogs/grok-build-xai-cli-ai-agents-2026). A free tier exists (the source has a "free Grok Build usage limit" message), and API-key use is supported.
- **Community, NOT official:** superagent-ai/grok-cli (npm `grok-dev`). Its README says it is "not affiliated with, endorsed by, or sponsored by xAI Corp." (https://github.com/superagent-ai/grok-cli). **catherd should target Grok Build (`grok`) and ignore superagent-ai/grok-cli.**
- xAI also publishes an official Claude Code plugin that drives `grok` headlessly from Claude Code: https://github.com/xai-org/grok-build-plugin-cc (`plugins/grok-build/scripts/lib/grok.mjs`). It is the closest prior art to catherd, and its choices are cited below.

Side note: Cursor's own docs now call Grok 4.5/4.6/4.7 "Cursor Models … jointly trained by Cursor and SpaceXAI" (https://cursor.com/docs/models-and-pricing.md). Grok models can therefore be reached through both backends, and they bill against different pools.

---

## 1. Cursor CLI (`agent`, alias `cursor-agent`)

Primary docs are available as markdown (append `.md`): https://cursor.com/docs/cli/overview.md, https://cursor.com/docs/cli/headless.md, https://cursor.com/docs/cli/reference/parameters.md, https://cursor.com/docs/cli/reference/output-format.md, https://cursor.com/docs/cli/reference/permissions.md, https://cursor.com/docs/cli/reference/configuration.md, https://cursor.com/docs/cli/reference/authentication.md, and the changelog at https://cursor.com/docs/cli/changelog.md. Version strings look like `2026.09.18-9a7762b` (https://github.com/atomantic/slashdo/issues/399).

### 1.1 Install, auth, status, version
- Install: `curl https://cursor.com/install -fsS | bash`. It installs to `~/.local/bin` (docs) or `~/.cursor/bin` (the GitHub Actions doc adds that to PATH). The CLI auto-updates by default; `agent update` updates manually, and `--disable-auto-update` exists (Jan 2026 changelog). Both binary names are seen in practice: `agent` in the docs, `cursor-agent` in many integrations. catherd should probe `agent`, then fall back to `cursor-agent`.
- Auth: `agent login` (browser; `NO_OPEN_BROWSER=1` prints the URL instead) or `CURSOR_API_KEY` / `--api-key` (https://cursor.com/docs/cli/reference/authentication.md). `AGENT_CLI_CREDENTIAL_STORE=file` stores credentials in an owner-only file, which is useful in sandboxes (changelog 2026-06-29). On Linux the token is read from `~/.config/cursor/auth.json`, `~/.cursor/auth.json` or `~/.cursor/cli-config.json` (third-party reverse-engineering, **UNVERIFIED**: https://github.com/Kenzim/cursor-core).
- Non-interactive checks: `agent --version`, `agent status --format json` (alias `whoami`), `agent about --format json` (`--format json` was added in April 2026 per the changelog; the output schema is **UNVERIFIED**, so record a fixture).

### 1.2 Headless mode
- Command: `agent -p [--output-format text|json|stream-json] [--stream-partial-output] [--model <id>] [--mode plan|ask] [-f|--force|--yolo] [--sandbox enabled|disabled] [--trust] [--approve-mcps] [--workspace <path>] [--resume <chatId>] [prompt...]`. The docs also say print mode is inferred when stdout is not a TTY or stdin is piped (https://cursor.com/docs/cli/reference/output-format.md).
- Prompt: the docs pass it as positional argv. paperclip's production adapter sends `-p --output-format stream-json --workspace <cwd> [--resume id] [--model m] [--mode m] [--yolo]` with **the prompt on stdin and no prompt argument** (https://github.com/paperclipai/paperclip `packages/adapters/cursor-local/src/server/execute.ts`, "Prompt is piped to Cursor via stdin"). So stdin works in practice, but this is not documented. A Feb 2026 fix also says "`-p` runs no longer block when spawned with an open stdin pipe". **Recommendation:** feed the brief file as stdin, as for codex, and keep argv prompt passing as a tested fallback (Linux `MAX_ARG_STRLEN` is 128 KiB per argument).
- Working dir: `--workspace <path>` plus the spawn `cwd`. `-w/--worktree` exists, but catherd manages its own lanes, so don't use it.
- Reasoning effort: **there is no effort flag.** Each effort level is its own model id (for example `gpt-5.3-codex-low`, `claude-opus-4-8-low`, `gpt-5.6-sol-xhigh`). The `model[effort=high]` bracket syntax shown in help is rejected by the validator (https://github.com/superset-sh/superset/pull/7178, tested on 2026.08.11; also https://github.com/repoprompt/repoprompt-ce/issues/1016). Since May 2026, headless keeps "Fast or high-effort model slugs" (changelog).
- `stream-json` schema (NDJSON, one line per complete assistant message; https://cursor.com/docs/cli/reference/output-format.md):
  ```json
  {"type":"system","subtype":"init","apiKeySource":"env|flag|login","cwd":"/abs","session_id":"<uuid>","model":"<display name>","permissionMode":"default"}
  {"type":"user","message":{"role":"user","content":[{"type":"text","text":"<prompt>"}]},"session_id":"<uuid>"}
  {"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I'll read the README.md file"}]},"session_id":"<uuid>"}
  {"type":"tool_call","subtype":"started","call_id":"toolu_…","tool_call":{"readToolCall":{"args":{"path":"README.md"}}},"session_id":"<uuid>"}
  {"type":"tool_call","subtype":"completed","call_id":"toolu_…","tool_call":{"readToolCall":{"args":{"path":"README.md"},"result":{"success":{"content":"…","totalLines":54}}}},"session_id":"<uuid>"}
  {"type":"tool_call","subtype":"started","call_id":"…","tool_call":{"writeToolCall":{"args":{"path":"summary.txt","fileText":"…"}}},"session_id":"<uuid>"}
  {"type":"result","subtype":"success","duration_ms":5234,"duration_api_ms":5234,"is_error":false,"result":"<ALL assistant text concatenated>","session_id":"<uuid>","request_id":"<uuid>"}
  ```
  Other tools may appear as `tool_call.function {name, arguments}`. `thinking` events are suppressed in print mode.
- **Token usage:** the docs omit it, but the live CLI emits `usage` on the `result` event, with camelCase keys:
  `"usage":{"inputTokens":5749,"outputTokens":25,"cacheReadTokens":9728,"cacheWriteTokens":0}` (cursor-agent 2026.09.02-c22c1a3: https://github.com/chenhg5/cc-connect/issues/1810; 2026.09.10 `--output-format json`: https://github.com/jonathanong/auto-harness/issues/795). The Feb 2026 changelog says "Per-turn input/output/cache token totals and a request_id in stream-json output". `inputTokens` appears to exclude cache reads, since reads exceed input in the sample. **UNVERIFIED:** confirm with a fixture.
- **Cost:** not emitted. `costUsd = null`.
- **Reply text caveat:** `result.result` is every assistant segment concatenated with no separator (see the docs example "…README.md fileBased on the README…"). For the reply file, take the **last `assistant` event's text**. That is also what `--output-format text` prints.

### 1.3 Session resume
- `--resume <chatId>` (or `--resume=<id>`), `--continue` (= `--resume=-1`), `agent ls`, `agent resume`. `agent create-chat` "creates a new empty chat and returns its ID" (parameters doc). That means catherd could pre-create the thread id before spawning, so the live marker has a thread even if the run dies before `system/init`. The output format is **UNVERIFIED**.
- Headless resume is used in production by paperclip, which retries fresh when resume fails, matching stdout/stderr against `/unknown\s+(session|chat)|session\s+.*\s+not\s+found|chat\s+.*\s+not\s+found|resume\s+.*\s+not\s+found|could\s+not\s+resume/i` (`parse.ts` `isCursorUnknownSessionError`). Since July 2026, chats resume from any directory. Resume re-computes "Run Everything" from config and team policy (May 2026). Reliability is good per these reports; the exact error text is **UNVERIFIED**.

### 1.4 Permissions, sandbox, avoiding blocking prompts
- **Workspace trust:** in an untrusted directory without `--trust` (or `--yolo`/`-f`), `-p` prints "⚠ Workspace Trust Required … Pass --trust, --yolo, or -f if you trust this directory" to stderr and **exits 1 before any model call** (https://github.com/atomantic/slashdo/issues/399, 2026.09.18). Always pass `--trust`.
- **Force/yolo:** `-f/--force/--yolo` means "Force allow commands unless explicitly denied" (Run Everything). Without it, print mode has "changes are only proposed, not applied" (headless doc), but the permissions doc says "Print mode can use write and shell tools. Use permissions.allow/deny and --force to control what runs without prompts." The docs contradict each other, and what a non-force `-p` run does with a command that needs approval (auto-reject or stall) is **UNVERIFIED**. Guardrails measured that `--force` exits 1 with "Error: Your team administrator has disabled the 'Run Everything' option." on enterprise teams, and that an undocumented `--auto-review` exists, but its write/shell behaviour headless is unmeasured (https://github.com/Servant-Software-LLC/Guardrails/issues/768). The Aug 2026 changelog adds "Timed mode-switch approvals … auto-rejects when left unattended" (15 s).
- **Modes:** `--mode ask` is "read-only exploration without making changes". `--mode plan` plans only.
- **Sandbox:** `--sandbox enabled|disabled`, with Linux Landlock + seccomp and macOS Seatbelt (https://github.com/imshaikot/browsentic/issues/25). Policy files are `~/.cursor/sandbox.json` and `.cursor/sandbox.json`, and network is default-deny through a proxy (Jan/Feb 2026 changelog). The CLI "fails fast with a clear reason when sandboxing is enabled but unavailable" (Feb 2026). An unresolved forum report says headless `-p` ignored `sandbox.json`. **Settings persist across sessions** (overview doc), so a flag may write global state; confirm with a fixture.
- **Permission tokens** go in `~/.cursor/cli-config.json` or `<project>/.cursor/cli.json`: `Shell(cmd)`, `Read(glob)`, `Write(glob)`, `WebFetch(domain)`, `Mcp(server:tool)`, and deny wins (https://cursor.com/docs/cli/reference/permissions.md). `approvalMode: allowlist|auto-review|unrestricted` is also in the config.
- **MCP:** `--approve-mcps` auto-approves project MCP servers. Global `~/.cursor/mcp.json` servers load without prompts (April 2026 changelog).
- **Suggested mapping for catherd** (verify with fixtures):
  - `read-only`: `-p --trust --mode ask --sandbox enabled`, with no `--force`. The risk is that ask mode may still want approval for a shell command. Fallback: an isolated `cli.json` deny list `Write(**)` plus `--force --sandbox enabled`.
  - `workspace-write`: `-p --trust --force --sandbox enabled`. **UNVERIFIED** whether `--force` still runs shell inside the sandbox or bypasses it. Record a fixture.
  - `danger-full-access`: `-p --trust --force --sandbox disabled --approve-mcps`.

### 1.5 Models
- `agent models` or `agent --list-models`. Output is `<id> - <Display Name>` lines under an "Available models" header, with markers such as `(current, default)`, for example `auto - Auto (current, default)`, `gpt-5.3-codex-low - Codex 5.3 Low`, `composer-2.5 - Composer 2.5`, `composer-2.5-fast - Composer 2.5 Fast` (https://github.com/shep-ai/shep/issues/886). Kangentic parses the same shape, 223 ids live, stripping markers but keeping `(NO ZDR)` (https://github.com/Kangentic/kangentic/pull/404). ANSI or header lines should be tolerated.
- Id format: lowercase slug, with effort, thinking, fast and max variants encoded as suffixes (e.g. `-low`, `-xhigh`, `-thinking`, `-fast`). The default for new installs is `auto` (July 2026). The catalog includes Composer 2.5, Grok 4.5–4.7, Claude, GPT-5.x, Gemini, Kimi and GLM (https://cursor.com/docs/models-and-pricing.md).
- For catherd rungs (`model#effort`), map `(base, effort)` to a sibling slug by parsing the `--list-models` ids. Treat an unmatched effort as unsupported. Keep `#default` meaning "bare slug".

### 1.6 Rate / usage limit errors
- Observed: stderr `ActionRequiredError: You've hit your usage limit ... set a Spend Limit to continue`, a non-zero exit, and zero assistant turns after `system/init` (https://github.com/getappz/agentflare/pull/693). Since March 2026, "classified server errors (like rate limits) render with their real message", and retries are on by default for dropped or stalled streams.
- Suggested `limit` regex, run over stderr and any `result.is_error` text: `/usage limit|spend limit|rate limit|too many requests|quota|ActionRequiredError|out of (credits|requests)/i`. Keep `Run Everything` / `administrator has disabled` as `failed` (policy), not `limit`.

### 1.7 Exit codes, failure signals, known hangs
- Success exits 0 with a terminal `result` event. On failure the exit code is non-zero (1 is observed for trust, `--force` policy and limit), an error goes to stderr, and **the stream may end with no `result` event** (output-format doc). An unknown flag is a commander-style error on stderr (**UNVERIFIED** code) and should map to `cli-too-old`.
- Known headless problems:
  - Hang with zero output in 2.4.21–2.4.22 / agents up to 2026.02.13, caused by TCP connection stalls. Staff said it was fixed as of 2026-03-25 (https://forum.cursor.com/t/cursor-agent-p-print-headless-mode-hangs-indefinitely-and-never-returns/150246).
  - Process does not exit after printing its result (2025.09.04, https://forum.cursor.com/t/cursor-agent-can-not-return-from-simple-command-under-headless-mode/132641).
  - Since Aug 2026, "single-turn runs drain delegated subagents … before exiting", so background shells or dev servers the agent starts can keep `-p` alive.
  - "Wedged uploads on long-running headless HTTP/1.1 sessions" were fixed in Aug 2026.
  - `cli-config.json` corruption with concurrent CLI processes was fixed July 2026. This matters because catherd runs parallel lanes.
- Mitigation: after a `result` event, give a grace period (for example 20–30 s), then kill the process group. catherd already launches detached with `killGroup`. Keep the idle watchdog for the no-output case.

### 1.8 User customization loaded, and isolation
- Loaded:
  - `.cursor/rules/*.mdc`, nested, plus `AGENTS.md` and `CLAUDE.md` at the project root (https://cursor.com/docs/cli/using.md).
  - Nested `AGENTS.md` (https://cursor.com/docs/rules.md).
  - **User Rules**, which are account-level and cloud-synced from Customize → Rules.
  - Team rules.
  - `~/.cursor/mcp.json` and project `.cursor/mcp.json`.
  - Skills from `.cursor/skills`, `~/.cursor/skills`, `~/.agents/skills`, **plus `.claude/skills`, `~/.claude/skills`, `~/.codex/skills`** (https://cursor.com/docs/skills.md).
  - Hooks from `~/.cursor/hooks.json` and `.cursor/hooks.json`, **plus Claude Code hooks from `~/.claude/settings.json`, `.claude/settings.json` and `.claude/settings.local.json`**. These are gated by "Include Third-Party Plugins, Skills, and Other Configs", which is on by default and documented as an editor setting (https://cursor.com/docs/reference/third-party-hooks.md). Whether the CLI honours that toggle is **UNVERIFIED**.
  - Plugins, and `permissions.json`.
- **Why this matters for catherd:** it runs inside a Claude Code session, so a Cursor worker will run the user's Claude Code hooks and skills.
- Isolation knobs: `CURSOR_CONFIG_DIR` relocates `cli-config.json` (configuration doc), and `XDG_CONFIG_HOME` is honoured on Linux. **There is no documented `--ignore-user-config`.** The only strong isolation is to run with an isolated `HOME` (so `~/.cursor`, `~/.claude`, `~/.codex` and `~/.agents` are empty) plus `CURSOR_API_KEY`, or a copied or symlinked auth file (paths are **UNVERIFIED**, see 1.1). User Rules are server-side and cannot be isolated locally (**UNVERIFIED** whether an API key without a user login still gets them). Project-level `AGENTS.md`, `CLAUDE.md` and `.cursor/rules` belong to the repo and are always read.

### 1.9 Recommended Cursor adapter
```
bin:    agent (fallback cursor-agent)
argv:   -p --output-format stream-json --trust --workspace <cwd> --model <slug(model,effort)>
        + role flags (1.4)  [+ --resume <thread>]
stdin:  brief file (resume: fix file)          # argv fallback if a fixture shows stdin is ignored
env:    process.env (+ isolated: HOME=<catherd>/cursor-home, CURSOR_API_KEY or linked auth, CURSOR_CONFIG_DIR)
thread: system/init.session_id (or pre-create with `agent create-chat`)
reply:  last assistant event text -> write to p.out (catherd writes the reply file itself)
tokens: result.usage: input = inputTokens+cacheReadTokens+cacheWriteTokens, cached = cacheReadTokens, output = outputTokens
cost:   null
status: limit if the LIMIT regex matches stderr/result; cli-too-old on an unknown-option error;
        failed if exit!=0 or no result event or result.is_error; else ok
after result: 30 s grace, then killGroup
```
Fixtures to record (with `agent --version` in each file name):
1. `init-read-write.jsonl`: `-p stream-json` with one read, one write and one shell call, including `result.usage`.
2. `json-success.json`: `--output-format json`.
3. `resume.jsonl`: the second turn with `--resume <id>`, showing the same `session_id`.
4. `resume-unknown.{stderr,exit}`: a bogus chat id.
5. `untrusted.{stderr,exit}`: no `--trust`.
6. `usage-limit.{stderr,jsonl,exit}`: a real exhausted account. Also any `result.is_error:true` sample.
7. `unknown-flag.{stderr,exit}`.
8. `ask-mode-shell.jsonl`: read-only mode when the model tries shell or write (does it auto-reject or hang?).
9. `force-sandbox.jsonl`: `--force --sandbox enabled`, running a write outside the workspace and a `curl`.
10. `list-models.txt`: the `agent models` / `--list-models` output with ANSI.
11. `status.json` and `about.json` (`--format json`), logged in and logged out.
12. `create-chat.txt`.
13. `stdin-prompt.jsonl`: the prompt only on stdin.
14. `no-exit-after-result`: a timing log with a background dev server.

---

## 2. Grok Build (`grok`)

Primary sources:
- The repo user guide `crates/codegen/xai-grok-pager/docs/user-guide/*.md` at commit f0e3be11 (2026-09-23): https://github.com/xai-org/grok-build/tree/main/crates/codegen/xai-grok-pager/docs/user-guide. Particularly `14-headless-mode.md`, `18-sandbox.md`, `22-permissions-and-safety.md`, `12-project-rules.md`, `26-config-reference.md`, `11-custom-models.md` and `17-sessions.md`.
- https://docs.x.ai/build/cli/reference.md
- The source in `crates/codegen/xai-grok-pager/src/headless.rs`, `src/models.rs` and `crates/codegen/xai-grok-shell/src/sampling/error.rs`.

### 2.1 Install, auth, status, version
- Install: `curl -fsSL https://x.ai/cli/install.sh | bash` (pin a version with `bash -s 0.1.42`), or `irm https://x.ai/cli/install.ps1 | iex`. It installs to `~/.grok/bin`. Update with `grok update [--check|--version V|--stable|--alpha]`. Suppress auto-update with `--no-auto-update` or `GROK_DISABLE_AUTOUPDATER=1`; it is also auto-suppressed when stderr is not a TTY. Update messages go to stderr.
- Auth: `grok login` opens a browser (OAuth at auth.x.ai); `grok login --device-auth` (alias `--device-code`) works headless; `XAI_API_KEY` works for CI; `grok logout` signs out. **Precedence:** a per-model `api_key` beats a cached session token (`~/.grok/auth.json`, mode 0600), which beats `XAI_API_KEY`. The API key is only a fallback, so `grok logout` is needed to force key use (02-authentication.md).
- Version: `grok version` or `grok --version`.
- Logged-in check: there is no `status` command. `grok models` prints one of "You are using XAI_API_KEY." / "You are logged in with <host>." / "You are not authenticated." and then the model list (`src/models.rs`). xAI's own plugin uses exactly this probe (`runModelsProbe` in grok-build-plugin-cc `lib/grok.mjs`). `grok inspect --json` shows the effective config, rules, skills, hooks and MCP servers.

### 2.2 Headless mode
- Command (14-headless-mode.md):
  `grok -p "<prompt>" | --prompt-file <path> | --prompt-json <json>  [--output-format plain|json|streaming-json|streaming-messages-json] [-m <model>] [--effort none|minimal|low|medium|high|xhigh|max] [--cwd <path>] [--always-approve|--yolo] [--permission-mode default|acceptEdits|auto|dontAsk|bypassPermissions] [--allow RULE]* [--deny RULE]* [--tools a,b] [--disallowed-tools a,b] [--sandbox off|workspace|read-only|strict|devbox|<custom>] [--max-turns N] [--rules TEXT] [-s <new-uuid>] [-r <id>] [-c] [--fork-session] [--no-auto-update] [--no-memory] [--no-subagents] [--disable-web-search] [--trust] [--json-schema ...]`
- Claude-Code alias flags are accepted: `--allowedTools`, `--disallowedTools`, `--append-system-prompt`, `--system-prompt`, `--dangerously-skip-permissions` (https://docs.x.ai/build/cli/reference.md).
- **Prompt:** headless **does not read piped stdin** (doc: "Headless mode does not read piped stdin into the prompt"). `grok -p -` sends a literal "-" and still exits 0 (https://github.com/saketvishal/stagemesh/issues/67). **Use `--prompt-file <brief path>`**, which fits catherd's brief/fix files.
- Effort: `--effort` / `--reasoning-effort`, "a model only accepts the levels its menu advertises". The source has `EffortTokenError::Unsupported`, so an unsupported level is an error. grok-4.7 supports low, medium, high (default) and xhigh (https://docs.x.ai/developers/grok-4-7). xAI's plugin exposes low, medium and high.
- `streaming-json` (xAI-native NDJSON, ACP-derived; switch on `type`):
  ```json
  {"type":"thought","data":"Analyzing the directory structure..."}
  {"type":"tool_call","toolCallId":"call_1","title":"Read","kind":"read","status":"in_progress","toolName":"read_file","rawInput":{"path":"src/main.rs"},"content":[],"locations":[]}
  {"type":"tool_call_update","toolCallId":"call_1","status":"completed","content":[],"rawOutput":{"lines":42},"locations":[]}
  {"type":"text","data":"Here's a summary"}
  {"type":"usage","messageId":"resp_1","stopReason":"end_turn","usage":{"input_tokens":812,"output_tokens":45,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"reasoning_tokens":0},"signature":"..."}
  {"type":"end","stopReason":"end_turn","sessionId":"abc123","requestId":"xyz789","usage":{...},"num_turns":7,"modelUsage":{"grok-4.6":{"inputTokens":7210,"outputTokens":1893,"cacheReadInputTokens":41000,"modelCalls":7,"costUSD":0.0127}},"total_cost_usd":0.0127,"total_cost_usd_ticks":126890500}
  ```
  Other types: `plan`, `available_commands`, `error`, `max_turns_reached`, `auto_compact_*`, and more; the list is non-exhaustive. `end.stopReason` is one of `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`.
  **On failure, the source (`headless/reducer/acp.rs`) emits a terminal `{"type":"error","message":…, (+usage fields)}` and no `end`, so no `sessionId` appears in the stream.** A `max_turns_reached` event is followed by `end`, and the process exits non-zero ("max turns reached").
- The `json` format gives one object: `{text, stopReason, sessionId, requestId, num_turns, usage{input_tokens(uncached), cache_read_input_tokens, cache_creation_input_tokens, output_tokens, reasoning_tokens, total_tokens}, modelUsage, total_cost_usd, total_cost_usd_ticks}`. On failure it is `{"type":"error","message":"…"}` with a non-zero exit.
- Token semantics (documented): `input_tokens` is **uncached only**, and `total_tokens = input + cache_read + cache_creation + output`. `total_cost_usd` appears **only when the server reported the complete cost**, which is stamped for API-key traffic; OAuth/pool paths often omit it. `cost_is_partial` and `usage_is_incomplete` flags can appear. For catherd: `input = input_tokens + cache_read + cache_creation`, `cached = cache_read`, `costUsd = total_cost_usd ?? null`.
- `streaming-messages-json` is a Claude-Code-compatible stream (`system/init`, `assistant`, `user`, `result`). It is usable, but xAI recommends `streaming-json` for a clean native stream.
- Per-session spend after the fact: `grok usage <session-id> [turn]`, and the session log is at `~/.grok/sessions/<encoded-cwd>/<id>/updates.jsonl` (17-sessions.md). This is useful for `reconcile` after a catherd restart.

### 2.3 Session resume
- `-r/--resume <id>` errors if the id does not exist. `-c` continues the most recent session in the cwd. `-s/--session-id <uuid>` **creates** a new session with a client-chosen UUID and errors if that UUID is in use; with `-r` or `-c` it requires `--fork-session`. Sessions are stored per cwd group under `$GROK_HOME/sessions/`.
- **Recommendation:** on the first turn, pass `-s $(uuidv4)` so the thread id is known at spawn. xAI's plugin does exactly this (`sessionId = crypto.randomUUID()` then `--session-id`). Later turns use `-r <id>` with the same `--cwd` and the same `GROK_HOME`.
- **Sandbox is fixed per session:** on resume, omit `--sandbox` or pass the same profile. A different profile is "refused with an error" (18-sandbox.md). catherd must not change the role sandbox when it resumes a grok thread.
- Interrupted runs: session state is saved up to the last completed tool call. SIGINT exits 130 and SIGTERM exits 143.

### 2.4 Permissions and sandbox
- Modes (22-permissions-and-safety.md):
  - `default` (ask): auto-runs read-only tools and a fixed list of read-only shell commands.
  - `acceptEdits`.
  - `auto`: a classifier decides. In `-p`, anything it will not allow **fails and is reported to the model** instead of prompting.
  - `dontAsk`: pre-approved tools only.
  - `bypassPermissions` (= `--always-approve` / `--yolo`): deny rules, hooks and some shell `ask` rules still apply.
- What `default` ask mode does in `-p` when a write needs approval is not stated. xAI's plugin comments that "headless runs have no user to click Approve, so … can hang or fail on any tool call" and **always uses `--always-approve` plus `--sandbox read-only` for read-only runs**.
- Sandbox profiles (kernel-enforced: Landlock + seccomp on Linux, Seatbelt on macOS; 18-sandbox.md):

  | Profile | Reads | Writes | Child network |
  |---|---|---|---|
  | `read-only` | everywhere | only `~/.grok` and tmp | blocked on Linux |
  | `workspace` | everywhere | cwd, `~/.grok` and tmp | allowed |
  | `strict` | cwd, system paths and `~/.grok` | cwd, `~/.grok/sessions` and tmp | blocked |
  | `devbox` | everywhere | almost everywhere | allowed |
  | `off` (default) | unrestricted | unrestricted | unrestricted |

  Custom profiles go in `~/.grok/sandbox.toml` as `[profiles.x] extends=…, restrict_network, read_only[], write[], deny[]`.
- **Gotcha:** if a **built-in** profile cannot be applied (for example Linux older than 5.13, or no Landlock), grok **logs a warning and runs unenforced**. An explicitly requested **custom** profile refuses to start instead. For a hard guarantee, catherd should ship custom profiles in its isolated `GROK_HOME/sandbox.toml` (for example `catherd-ro` extends `read-only`, and `catherd-ws` extends `workspace`).
- Tool filtering, headless only: `--tools read_file,grep,list_dir` or `--disallowed-tools run_terminal_cmd,search_replace,Agent`.
- **Mapping for catherd:**
  - `read-only`: `--always-approve --sandbox read-only` (or `catherd-ro`), optionally with `--disallowed-tools search_replace`.
  - `workspace-write`: `--always-approve --sandbox workspace`.
  - `danger-full-access`: `--always-approve --sandbox off`.
- Folder trust: project `AGENTS.md`, project config, hooks and skills load at startup only if the folder is trusted. "Headless startup with these sources requires `--trust` or a prior grant." `--trust` **persists** the grant (`grant_folder_trust` in `headless.rs`). Whether an untrusted headless run fails or silently skips the project sources is **UNVERIFIED**; the hooks doc says untrusted project hooks are "silently skipped". Pass `--trust` so the repo's `AGENTS.md` is honoured.

### 2.5 Models
- `grok models` prints the auth line, then `Default model: <id>`, then `Available models:` with `  * <id> (default)` / `  - <id>` lines (`src/models.rs`; plain text, no `--json`).
- Ids are plain, for example `grok-4.5`, `grok-4.6`, `grok-4.7`, plus custom `[model.<name>]` entries and models prefetched from `/v1/models`. The docs disagree on the default: the repo docs say new sessions start with `grok-4.5`, while https://docs.x.ai/build/overview and the Grok 4.7 page call grok-4.7 "the default model of the coding agent". Read the `Default model:` line instead of hardcoding.
- A fast variant, "Grok 4.7 Fast", exists in Grok Build and Cursor; its id is **UNVERIFIED**. `grok-build-0.1` was mentioned at launch; whether it is still listed is **UNVERIFIED**.
- Efforts come from the model's menu; the list output does not include them. Canonical levels are none, minimal, low, medium, high, xhigh and max, and grok-4.7 takes low/medium/high/xhigh. Discover efforts by probing, or hardcode them per model in the catalog.

### 2.6 Rate / usage limit errors
From `xai-grok-shell/src/sampling/error.rs`: HTTP 429 becomes ACP error `-32003 "Rate limited"`, and headless then emits `{"type":"error","message":<text>}` and exits 1. Possible texts:
- "You’ve hit the rate limit for your plan. Upgrade your account or try again later." (OAuth)
- "You’ve hit your team’s API rate limit. Ask a team admin to purchase more credits for higher limits, or try again later. See https://docs.x.ai/developers/rate-limits#rate-limit-tiers" (API key)
- "You’ve reached your free Grok Build usage limit for now. Get SuperGrok for much higher limits, or try again later: …" (server code `subscription:free-usage-exhausted`)
- The server body with the `API error (status 429 …):` prefix stripped, for example "resource-exhausted: Too many requests for team …" or "The service is temporarily at capacity. Please retry your request shortly."
- Related: "Model is temporarily overloaded. Try again in a moment." (503/529 are classed as rate limit), "The model stopped responding after Ns.", and 403 "…requires a Grok subscription…".

Note the typographic apostrophe `’` (U+2019). Suggested regex: `/rate limit|usage limit|free-usage-exhausted|too many requests|resource-exhausted|at capacity|temporarily overloaded|purchase more credits|try again later/i` gives `limit`. "requires a Grok subscription" is `failed` (auth/plan).

### 2.7 Exit codes and failure signals
- Exit codes (doc): 0 success; 1 error (auth, network, runtime, max-turns, prompt error); 130 SIGINT; 143 SIGTERM; **2** for CLI argument errors (clap), for example `error: unexpected argument '--json-schema' found` on 0.2.11 (https://github.com/xai-org/grok-build-plugin-cc/issues/35). Exit 2 should map to `cli-too-old`.
- Not signed in (headless): "Not signed in. To authenticate without a browser, run: grok login --device-code … Alternatively, set the XAI_API_KEY environment variable…" (`headless.rs` `auth_required_message`).
- `stdout` stays clean JSON; logs go to stderr (`RUST_LOG`), or to `GROK_LOG_FILE`.
- Known issues: the `-p -` literal-prompt pitfall above; flags drift between versions (`--json-schema` rejected on 0.2.11); a Windows interactive hang after 1.0.5 (https://github.com/xai-org/plugin-marketplace/issues/866, not headless).
- Headless waits for background tasks before exiting, bounded by a timeout (up to 120 s drain for subagent usage). The source has a stall detector ("The model stopped responding after Ns"). A `--max-turns` cap is available as a runaway guard.

### 2.8 User customization loaded, and isolation
- Loaded:
  - `$GROK_HOME/config.toml` and project `.grok/config.toml` (only mcp_servers, plugins, permission and one mcp key).
  - `managed_config.toml` and `requirements.toml` (these can pin values).
  - `GROK_CONFIG` / `GROK_CONFIG_PATH` overlays.
  - Rules: `Agents.md`, `Claude.md`, `CLAUDE.md`, `CLAUDE.local.md`, `AGENT.md` and `AGENTS.md` from the repo root down to the cwd; `.grok/rules`, `.claude/rules` and `.cursor/rules`; home `~/.grok/rules`, **`~/.claude/rules`, `~/.claude/CLAUDE*.md`, `~/.cursor/rules`**; and `extra_rule_dirs`.
  - **Claude and Cursor skills, MCP (`~/.claude.json`, `~/.cursor/mcp.json`) and hooks (`~/.claude/settings.json`, `~/.cursor/hooks.json`)**.
  - Claude permission rules from `~/.claude/settings*.json`.
  - Cross-session memory.
  - Plugins.

  Sources: 12-project-rules.md, 05-configuration.md, 22-permissions-and-safety.md.
- Isolation is good and scriptable (26-config-reference.md):
  - `GROK_HOME=<catherd>/grok-home`, which holds config, auth, sessions and sandbox.toml. Put the auth file in it, or use `XAI_API_KEY`. The docs say a *symlinked `$GROK_HOME`* is refused under a sandbox. A symlinked `auth.json` might break on token refresh (atomic rename); **UNVERIFIED**, so prefer copying it, or use the API key.
  - `GROK_CLAUDE_{AGENTS,RULES,SKILLS,MCPS,HOOKS}_ENABLED=0` and `GROK_CURSOR_{AGENTS,RULES,SKILLS,MCPS,HOOKS}_ENABLED=0`. Env beats config.
  - `GROK_MEMORY=0` (or `--no-memory`), `GROK_DISABLE_AUTOUPDATER=1`, `--no-auto-update`.
  - Still loaded: project `AGENTS.md`/`CLAUDE.md` (repo-owned, and generic `CLAUDE.md` stays recognized), any system `/etc/grok/*` managed files, and possibly `~/.claude/settings.json` *permission rules*. Whether the compat cells gate those rules is **UNVERIFIED**; check with `grok inspect --json`.
  - Grok needs a writable `$GROK_HOME` (sessions). Even the `read-only` sandbox keeps `~/.grok` writable.

### 2.9 Recommended Grok adapter
```
bin:    grok
argv:   --prompt-file <brief|fix> --output-format streaming-json --cwd <cwd> -m <model>
        [--effort <e> unless "default"] --always-approve --trust --no-auto-update
        new:    -s <uuid> --sandbox <profile(role)>
        resume: -r <thread>            (no --sandbox; the session keeps its profile)
stdin:  ignore
env:    process.env + GROK_DISABLE_AUTOUPDATER=1
        isolated: GROK_HOME=<catherd>/grok-home (auth.json copy + sandbox.toml with catherd-* profiles),
                  GROK_{CLAUDE,CURSOR}_*_ENABLED=0, GROK_MEMORY=0
thread: the pre-assigned uuid (confirmed by end.sessionId)
reply:  text events after the last tool_call/tool_call_update -> p.out
tokens: from end.usage (fallback: sum of usage lines, or `grok usage <id>` on reconcile)
cost:   end.total_cost_usd ?? null
status: limit if an error event matches the LIMIT regex; cli-too-old if exit==2 or "unexpected argument";
        failed if exit!=0 or error event or no end; ok if end.stopReason in {end_turn}
        (max_tokens / max_turn_requests -> failed with reason)
```
Fixtures to record (with `grok version` in each name):
1. `streaming-json-read-write-shell.jsonl` with `end` spend fields, API-key auth (cost present).
2. The same with OAuth auth (cost absent).
3. `json-success.json`.
4. `resume.jsonl`: `-r`, same id.
5. `resume-missing.{stderr,jsonl,exit}`.
6. `session-id-conflict.{…}`: `-s` with a used uuid.
7. `resume-sandbox-mismatch.{…}`.
8. `rate-limit.{jsonl,exit}`, or a synthesized fixture using the exact source strings above if a real one cannot be triggered.
9. `not-signed-in.{jsonl,stderr,exit}`.
10. `bad-flag.{stderr,exit=2}`.
11. `unsupported-effort.{…}`.
12. `models.txt`: the three auth variants.
13. `inspect.json`: isolated and non-isolated.
14. `sandbox-ro-write-attempt.jsonl`: the tool error shape when a write is denied.
15. `untrusted-no-trust.jsonl`: are the project rules loaded?
16. `max-turns.jsonl`.
17. `sigterm.exit=143`.

---

## 3. Generic backend adapter interface (codex, opencode, cursor, grok)

```ts
export type BackendId = "codex" | "opencode" | "cursor" | "grok";

export interface SpawnPlan {
  cmd: string;                       // resolved binary (probe list, e.g. ["agent","cursor-agent"])
  args: string[];
  env: Record<string, string | undefined>;
  stdinFile?: string;                // codex, cursor: brief/fix file; grok/opencode: undefined
  preThread?: string | null;         // thread id known before spawn (grok -s uuid, cursor create-chat)
  replyFile?: "cli-writes" | "adapter-writes"; // codex -o writes it; others: finalize writes it from events
}

export interface EventState {        // incremental, fed by onLines, also re-run over the full file
  thread: string | null;
  lastEvent: string | null;          // for progress ticks
  replyText: string;                 // final assistant message so far
  tokens: Tokens;
  costUsd: number | null;
  terminal: "ok" | "error" | null;   // saw result/end vs. error
  failure: string | null;
  limit: boolean;
  cliTooOld: boolean;
}

export interface BackendAdapter {
  id: BackendId;
  /** argv/env/stdin for a new run or a resume; applies role -> sandbox/permission mapping and isolation */
  plan(o: DispatchOpts, paths: RolePaths, isolated: boolean): SpawnPlan;
  /** pure; parse NDJSON lines into state (unit-tested against recorded fixtures) */
  parse(lines: string[], prev?: EventState): EventState;
  /** combine the parse, exit code, stderr and timeout into RunRecord fields (status/error/tokens/cost/thread/reply) */
  finalize(ev: EventState, exit: { code: number | null; signal: string | null; stderr: string; timedOut: boolean }): {
    status: RunStatus; error: string | null; reply: string; thread: string | null; tokens: Tokens; costUsd: number | null;
  };
  /** kill policy: e.g. cursor needs "N s after terminal event", opencode needs a busy check */
  afterTerminalGraceMs?: number;
  isBusy?(thread: string, cwd: string): boolean;
  /** constraints on resume (grok: sandbox fixed per session; codex: sandbox_mode override allowed) */
  resume: { supported: boolean; sandboxMutable: boolean; scope: "global" | "cwd" | "home" };
  /** isolated home/config dir preparation (codex CODEX_HOME, opencode XDG_CONFIG_HOME, cursor HOME/CURSOR_CONFIG_DIR, grok GROK_HOME + env toggles) */
  prepareIsolation(): { env: Record<string, string> };
  /** preflight: installed? version? logged in? (codex login status, `agent status --format json`, `grok models` first line, opencode auth list) */
  probe(): Promise<{ installed: boolean; version: string | null; loggedIn: boolean | null; detail: string }>;
  /** model discovery, normalized to CatalogModel[] with efforts
   *  (cursor: collapse effort-suffixed slugs; grok: `grok models` + a per-model effort table) */
  listModels(): Promise<CatalogModel[]>;
  /** map (model, effort) to CLI args; throws on an unsupported effort */
  modelArgs(model: string, effort: string): string[];
  limitPattern: RegExp;
  tooOldPattern: RegExp;
}
```
Notes:
- `RunRecord.backend` and `Backend` must widen to include `cursor` and `grok`, and the profile's `harness` record must gain `cursor` and `grok` entries.
- One shared `runBackend(adapter, o)` would replace `runCodex` and `runOpencode`. It would call `runChild` with `plan`, stream `parse` for progress, apply `afterTerminalGraceMs` (a new `runChild` option: kill the group N ms after `parse().terminal` becomes set), and on exit write the reply file when `replyFile === "adapter-writes"`. It would then call `finalize` and append the record. `reconcile` would use `parse` + `finalize` on files with `code = null`.
- Token normalization contract: `input` = all prompt tokens including cached, `cached` = cache reads, `output` = output tokens including reasoning. Cursor and Grok report uncached input separately, so their adapters add the buckets.
- The fixture harness would live at `test/fixtures/<backend>/<version>/<case>.{jsonl,stderr,exit}`. One table-driven test per adapter would assert the `finalize()` output. The `FAKE_*` env hook already used in tests could replay fixtures through a fake binary (xAI's plugin does the same with `tests/fake-grok-fixture.mjs`).

## 4. Open items to verify live (priority order)
1. Cursor: can the prompt go on stdin with `-p` and no argument? What does ask mode or no-`--force` do on a shell or write request (reject or stall)? Does `--force` keep shell sandboxed with `--sandbox enabled`? Get a real usage-limit stream and exit code, and the `result.usage` semantics.
2. Cursor isolation: which auth file paths are used with `HOME` overridden? Does the CLI honour the third-party-configs toggle for `~/.claude` hooks and skills?
3. Grok: in an untrusted folder without `--trust`, does `-p` fail or skip project rules? What does default ask mode do in `-p` on a write? Does a copied `auth.json` in an isolated `GROK_HOME` survive refresh? Does `total_cost_usd` appear with OAuth?
4. Both: the exact model id lists on the owner's accounts (`agent --list-models`, `grok models`).
