# Ideas for 1.x

Improvements collected from real catherd runs and from designing it, not yet planned. When one is picked up it moves
into a spec or plan under `docs/superpowers/` (or a GitHub issue) and leaves this list. One entry per idea: what, why
(the evidence), and where it would live.

Shipped in 1.0, so not re-proposed here: `catherd doctor`; the harness-cost line in `runs_summary` and the final
report; quota failover (the profile's `failover` map); the `preflight` tool; per-repo knowledge
(`<data>/repos/<slug>-<hash8>/knowledge.md`, read with `read_knowledge`, appended by `land`); the run budget (from 80 %
`route` starts at the cheapest rung that clears the bar; once spent, `E_RUN_BUDGET` pauses the run); the trimmed catalog (`catalog/models.json`, `scores.json`, `jev.json`); a plan in hand (a `plan:` A-line: no dossier, the architect translates); lint and type check in each lane's fast check; `status` showing the run's native and isolated dispatches, with the harness figure compared within one repo; and a sure Jev kind kept when its difficulty is unsure (`source: "jev-kind"`).

## Push results to the main thread, drop `wait` (designed 2026-09-28)

_Why:_ `wait` fixed serial dispatch but blocks the main thread: an MCP call does not background, so the session freezes
until the lanes finish, and the user cannot even ask how it is going. Claude Code sessions have a peer inbox (a Unix
socket, `.workspace/references/claude-code-cross-session-messaging.md` in agora); catherd can use it to tell the main
thread a role finished, the way native subagents do. Every decision below was settled with the user in a grilling
session; the facts were verified in the 2.1.283 binary.

Facts it rests on:
- The receiver treats a message as self-sent when its own pid is an ancestor of the sender (a `ps -o ppid=` walk, 10
  levels, 32 on retry; macOS). The plugin's MCP server is a direct child of the session, so its messages pass with no
  `crossSessionInbound` setting. The detached supervisor (ppid 1) does not.
- MCP children get `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_HOST_SESSION_ID` and `CLAUDE_CODE_MESSAGING_SOCKET`; the
  session file `~/.claude/sessions/<pid>.json` gives its name.
- `priority`: `later` waits for the turn to end (native task notices use it), `next` drains at the next tool round,
  `now` aborts the turn.

Design:
1. **Disk stays the source of truth.** The supervisor writes the record as today; each record is delivered once by its
   collect marker. A message only announces it.
2. **The MCP server sends.** It watches the records of the roles it dispatched and sends one message per finished role
   over `CLAUDE_CODE_MESSAGING_SOCKET`; roles that finish within about 3 s of each other share one message. On start it
   sends for any unread record of its session's runs.
3. **The message.** First line self-contained, e.g. `catherd · M2.L1 worker · sol#medium · ok · complete · 1m51s · 3
   files`; then the worker's reply, capped at about 2 KB; then a pointer to `result(run, name)`.
4. **When.** Every end (ok, failed, limit, timeout), plus two mid-run events: the supervisor sees a stall, or a limit
   moved the role to its failover rung. No progress lines; `peek` has those.
5. **Priority.** Normal ends go `later`; blocked, stalled and limit messages go `next`; never `now`.
6. **Which session.** `dispatch` records `CLAUDE_CODE_SESSION_ID`. The message goes to the live session with that id,
   found by id, not pid; a run continued in another session (it called `run_start` or `peek` for it) moves delivery
   there. With no live session the record stays unread for the next `peek` or `run_start`; phone pushes follow the
   profile's notify moments as today.
7. **Tools.** `wait` is removed. New `peek(run?, name?)`, non-blocking: each live role with elapsed time and its last
   event (last command or message), plus finished records not yet read. `result` stays for a full record.
8. **Skill.** After dispatching independent roles, write one status line and end the turn; results arrive as messages,
   to be treated like native subagent notices. Never sleep, loop or poll `peek`; call it when the user asks how it is
   going or a decision needs the others' state. Native Claude roles (architect, verifier) keep their own notices.
9. **Settings.** `init` does not touch `crossSessionInbound`. `doctor` sends a test message from the MCP server to its
   own session and reports whether it arrived.

## Runs page by main-thread session (designed 2026-09-28)

_Why:_ one `/catherd` job (the whole auth build) became several runs, one per milestone and worktree, listed flat. The
user wants to open the session that drove the job and see every role, where it is, past runs and milestones, updating
in place.

- The run stays the unit (parallel runs in separate worktrees are needed). `run_start` stores the session id, host id
  and name in `meta.json`; the runs page groups by session first: session, its runs, their milestones, their roles.
- A run continued from another session stays under the one that started it, marked "continued in X", and shows as a
  link under the second.
- The session's name is read live from its session file (so a renamed Desktop session renames here), else the last
  stored name.
- The page watches the data folder and redraws when a record or state file changes; live roles' elapsed time ticks
  every second, with each role's last event from `peek`'s source.

## Fix bundle: everything open, by priority

One line per open problem found in real use; the entry with the evidence is in the section named after it.

1. **Workers cannot run their checks:** the sandbox denies Docker, loopback ports, the network and the lock dir (Top priority; 1.0.0 fresh install; headless test).
2. **The protocol is optional:** `route`, the reviewer and the verifier get skipped, before and after compaction; replies carry no STATUS because `dispatch` does not add the reply contract (Top priority; headless test).
3. **Plugin install fails without GitHub SSH:** `git-subdir` shorthand URL (1.0.0 fresh install).
4. **The plugin's MCP server dies on a half-cleaned bunx cache** (1.0.0 platform run).
5. **The verifier is the bottleneck:** serial gate items, reruns of unchanged checks, an image built twice, no progress in `status` (1.0.0 platform run).
6. **One owner question stops everything** (Top priority).
7. **`doctor`'s sandbox probe is dead on Codex 0.157** (1.0.0 fresh install).
8. **Routing:** easy lanes start at the default rung, not the cheapest that clears them; climbs used for plan or ownership problems (headless test; Orchestration).
9. **Profiles:** failover downgrades high rungs or lands on the Claude quota with an odd label; ladders that go down validate clean (1.0.0 fresh install; headless test).
10. **Cost:** a first Codex turn is 280k to 580k input tokens even on an easy lane, native or isolated (headless test; Routing and cost).
11. **Noise and polish:** warnings on the shipped defaults, a silent 30 s first `bunx`, the TUI's "0 profiles" first frame (1.0.0 fresh install).

Already fixed in 1.0 and confirmed live: serial dispatch (`dispatch` + `wait`, lanes overlap), the plan-in-hand path,
lint in the fast check, the `status` harness line, Jev keeping a sure kind.

## Top priority

- **Workers cannot run their own checks.** In the auth build 60 of 171 worker replies were `partial`/`blocked`
  because the sandbox denied Docker, loopback ports or the lock dir, so the Opus main thread ran the tests itself and
  even edited test files. Fix: network, the lock dir and `DOCKER_HOST` in the worker sandbox, or a `check(run, lane)`
  tool that runs the fast check outside it. _Evidence:_ `reports/2026-09-27-auth-build.md`, finding 1.
- **The skill decays after compaction.** Runs started after a compaction called no `route`, no reviewer and no
  verifier. Fix: `run_start` returns the checklist, `state.md` names the next protocol step, and `land` refuses a
  milestone without a review and a verdict unless the run says why. _Evidence:_ the same report, finding 3.
- **One owner question stops everything.** A blocked milestone should park with a push while independent milestones
  and runs continue; one question held the auth build for 4.5 h. _Evidence:_ the same report, finding 4.

## From the 1.0.0 fresh install (2026-09-27)

A clean 1.0.0 setup on macOS after removing every 0.x file: `bunx catherd-cli init`, the plugin commands, `doctor`, the
TUI.

- **Plugin install fails without GitHub SSH (blocker).** `marketplace.json` gives the plugin a `git-subdir` source
  with `"url": "47vigen/catherd"`. The marketplace itself clones over HTTPS, but Claude Code clones that shorthand over
  SSH, so `claude plugin install catherd@catherd` dies with `ssh: connect to host github.com port 22` on any machine
  without GitHub SSH. 0.x used `"source": "./plugin"` and installed fine. Fix: `"url": "https://github.com/47vigen/catherd.git"`,
  keeping `path` and `ref`. Workaround used: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf
  GIT_CONFIG_VALUE_0=git@github.com: claude plugin install catherd@catherd`.
- **`doctor`'s sandbox probe is dead on current Codex.** `canWrite` runs `codex sandbox macos --full-auto`; Codex
  0.157 has no `macos` subcommand (`codex sandbox [COMMAND]`, seatbelt implied) and no `--full-auto` there, so the row
  reads "not tested: no codex sandbox to test with" on every current install. It is the one check meant to catch the
  auth build's top finding. Fix: probe `codex sandbox -- sh -c ...` first, fall back to the old form.
- **The worker sandbox still cannot run checks (auth-build finding 1, confirmed on 1.0).** Under `codex sandbox`, a
  write to the locks dir, the Docker socket (`docker ps`), a loopback `bind()` and a write to `/tmp` are all denied.
  The default worker is `workspace-write`, so a Go monorepo with testcontainers repeats the auth build. Fix options: a
  worker access level between `workspace-write` and `full` (network, loopback, the lock dir, `DOCKER_HOST`), or a
  `check(run, lane)` tool that runs the fast check outside the sandbox behind the lock; `doctor` should say which one
  this machine needs.
- **Failover downgrades high rungs.** The inferred failover maps `codex:gpt-6-sol#high` and `#xhigh` to
  `opencode-go/kimi-k3#max` "treated like gpt-6-sol#medium". A usage limit on a climbed lane silently drops it back
  to the medium tier it just climbed from. Prefer a stand-in that clears the rung's own bar, or mark the row as a
  downgrade in `profile show` and `doctor`.
- **Warnings on the defaults.** A fresh `doctor` shows two `!` rows (full access for verifier and ui-reviewer, advisory
  access for the Claude roles) about the shipped defaults, which the user did not choose and cannot act on. Show them
  as info, or only when the profile departs from the defaults.
- **Silent first `bunx`.** The first `bunx catherd-cli init` resolves about 108 packages (TypeScript among them,
  pulled in transitively) for about 30 s before any output. Check what pulls TypeScript into the runtime tree, and
  say "installing catherd…" before the resolve where possible (README: suggest `bun add -g catherd-cli` first).
- **TUI first frame.** The Status tab shows "active · 0 profiles" before the profile list loads, then "1 profile".

## From the 1.0.0 headless test (2026-09-27)

`claude -p "/catherd:catherd ..."` on a scratch Bun + TypeScript repo, three independent utils plus an index, profile
with `codex.isolated: true`. Finished in 5 min for $0.89 of Claude; `bun test` 21/21 and `tsc` clean.

- **Parallel lanes work.** Three `dispatch` calls, then `wait({ all: true })`: the three Codex workers ran fully
  overlapped (12:50:59 to 12:54:35); M1 took 3.6 min against 7.6 min of summed worker time. Plan 9 finding 1 is
  fixed live.
- **`route` skipped for 3 of 4 lanes.** The orchestrator routed M1.L1 only and reused its rung for L2, L3 and M2.L1;
  `land` warned "no routed lane" and went on. This is a short run with no compaction, so it is not only the
  compaction decay. Fix: `dispatch` with a `lane` routes it itself when `routes.jsonl` has no entry, or refuses with a
  fix line.
- **No reviewer and no verifier.** The orchestrator read the code, ran the tests and made both commits itself. Fix:
  `land` refuses a milestone without a reviewer record and a verifier verdict, unless the call names why (and the
  skill lists the allowed reasons).
- **Replies carry no STATUS.** All four records have `replyStatus: null`: the orchestrator's briefs never asked for
  the STATUS line, and `dispatch` does not add the role's reply contract itself. The auth runs 3 to 5 showed the same.
  Fix: `dispatch` appends the role's reply contract (last line `STATUS: ...`) to every brief.
- **Sandbox denies the network.** The worker's `bun install` failed on DNS inside `workspace-write`; it passed only
  because `node_modules` already existed. Same root as the auth build's finding 1, on a trivial repo.
- **Easy lanes start at the default rung.** All four "Difficulty: easy" lanes ran on `gpt-6-sol#medium`, not the
  cheaper `gpt-6-luna#high` at the bottom of the ladder, under objective `cost`. The route should start at the
  cheapest rung that clears the lane's difficulty.
- **Worker first turn, isolated.** An easy lane still read 583k input tokens (L1); isolation does not make small lanes
  cheap.
- **Profile ladders can go down.** A ladder `... → sol#xhigh → luna#medium` validates clean. `validate` should warn when
  a rung scores below the one before it. Inferred failover labels read oddly too:
  `claude-code:claude-opus-5-5#low (treated like claude-opus-5-5#xhigh)`, and failover to a Claude rung spends the
  Claude quota the user ranks last.

## From the 1.0.0 platform run (2026-09-27)

Dev-registry MR and the end of auth plan 5 MR A, two runs side by side in one Desktop session. With the prompt forcing
route, reviewer and verifier, every lane was routed, both roles ran, replies carried STATUS, and lanes overlapped.

- **The verifier is the bottleneck.** At 63 min into MR A: workers and reviewer took about 9 min, the verifier about
  47 (26 min for the boot and SSO half, 20+ for the gate half, one attempt lost when it was cut and relaunched). Inside
  the gate, building the acceptance images took about 13 min, 7 of them a `pnpm install` in two Docker stages despite
  a cache mount; the suite itself ran after that. Ideas, catherd side: (1) the verifier runs independent gate items
  side by side within the lock's slots instead of one after another; (2) a gate item whose inputs have not changed
  since it last passed (tree hash of its paths) is reported as carried over, not rerun, when the milestone's diff
  since that pass is small; (3) the verifier builds each image once per commit and the boot check and the acceptance
  suite share it; (4) `status` shows the verifier's current step and elapsed time, so a long gate is visible instead
  of looking stuck. Repo side (platform): the Docker `pnpm install` should hit the package mirror and a warm store.
- **Final numbers for MR A.** The run took 100 min (13:18 to 14:58) before the user paused it with MR !54 open and
  green: workers and reviewer about 9 min, three verifier passes about 85 min (the last, the full gate with the
  acceptance suite, 14:01 to 14:57). M1 (dev registry), in its own run beside it, took 50 min end to end.
- **The plugin's MCP server dies on a half-cleaned bunx cache (second time).** `plugin/.mcp.json` runs `bunx
  catherd-cli@1.0.0 mcp`, which lives in `$TMPDIR/bunx-502-catherd-cli@1.0.0/`. A day later the plugin failed in
  every new session: `Cannot find module './v4/classic/external.js'` from `zod/index.js`: part of the tree was gone
  (macOS cleans `$TMPDIR` by age), and bunx reused the broken folder instead of reinstalling. 0.2.1 hit the same
  with `fast-deep-equal`. Claude Code then caches the failure for 15 min. Fix: run the MCP server from a stable place
  (the global `catherd` binary when present, else `bun x` with a cache under `~/.cache/catherd`), and have
  `doctor` import the tree once and say "reinstall" when a module is missing. Workaround: delete the bunx folder.

## Scores and catalog from public sources (2026-09-27)

_What:_ `catherd catalog sync` pulls every independent, machine-readable source of model facts and scores, merges them
into the catalog routing already reads, and asks the user to pick a stand-in only for the rungs no source covers.
_Why:_ `catalog/models.json` and `scores.json` are written by hand today. A release like 2026-09-22 (Opus 5.5, GPT-6
Sol/Luna/Astra) leaves every new rung unscored until someone reads blog posts and types numbers in, and each unscored
rung needs a hand `treat-like`. Every source below was called with curl on 2026-09-27; none of the chosen ones is run
by a model vendor.

### Sources

Keyless, always on:

| Source | Call | Gives | License |
|---|---|---|---|
| models.dev | `GET https://models.dev/api.json` | per model: `reasoning_options` (the effort list), `limit.context`/`output`, `cost` (input, output, cache read/write, fast mode), `tool_call`, `modalities`, `release_date`, `knowledge` | MIT; opencode reads the same file |
| OpenRouter models | `GET https://openrouter.ai/api/v1/models` | id, context, pricing; new models appear the day they ship | public API |
| OpenRouter endpoints | `GET https://openrouter.ai/api/v1/models/{author}/{slug}/endpoints` | per provider: `uptime_last_5m/30m/1d`, `latency_last_30m`, `throughput_last_30m` | public API |
| LiteLLM | `GET https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` | price and context, `supports_xhigh/max_reasoning_effort`; cross-check only | MIT |
| Arena (LMArena) | `GET https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=<c>&split=latest&length=100` | Agent Arena configs `agent` (Net Improvement), `agent_task_outcome_explicit`, `agent_bash_recovery_steps`, `agent_steerability`, `agent_tool_hallucination`, `agent_praise_complaint`; plus `webdev` and `text` (rating, CI, votes); `leaderboard_publish_date` | CC-BY-4.0, attribution |
| Vectara hallucination | `GET https://raw.githubusercontent.com/vectara/hallucination-leaderboard/main/README.md` (markdown table, parsed) | hallucination rate, factual consistency; "Last updated" line | Apache-2.0 |
| Epoch AI | `GET https://epoch.ai/data/benchmark_data.zip` (CSV per benchmark) | `frontiercode_external`, `webdev_arena_external`, `terminalbench_external`, `metr_time_horizons_external`, … with reasoning effort in `Model version` (`gpt-6-astra_max`) | CC-BY; external tables keep their own license |

Keyed, optional (asked in `init` like the Jev key):

| Source | Call | Gives | Terms |
|---|---|---|---|
| Artificial Analysis | `GET https://artificialanalysis.ai/api/v2/data/llms/models`, header `x-api-key` | one request, 674 rows, **one row per effort** (`gpt-6-astra-xhigh`, bare slug = `max`): `terminalbench_v2_1`, `terminalbench_hard`, `livecodebench`, `scicode`, `tau2`, `tau_banking`, `ifbench`, `lcr`, `hle`, `gpqa`, coding/intelligence/math index, pricing, `median_output_tokens_per_second`, `median_time_to_first_token_seconds` | free key, 100 requests/day, internal use only, attribution |
| same, fallback | `GET https://artificialanalysis.ai/api/v2/language/models/free?page=N` (4 pages) | intelligence/coding/agentic index, `cost_per_task`, pricing, speed | same |

The first AA path is the legacy v2 route: the free key reads it today but the current docs no longer list it, so a
404/403 there falls back to `/language/models/free`. `/language/models`, `/language/models/{slug}` (Pro) and
`/language/providers` (Commercial) answer 403 to a free key and are not used.

Checked and left out: Aider polyglot (last row 2025-10), SWE-rebench (last month 2026-07, no GPT-6), official SWE-bench
`leaderboards.json` (2026-02), the Terminal-Bench leaderboard repo (self-submitted by agent vendors, last 2025-11),
Galileo agent leaderboard and Helicone (stale), Scale SEAL / SWE-bench Pro and Vellum (403), BridgeBench (no API,
Cloudflare, `/api/` disallowed), llm-stats / benchlm / modelgrep (resell other sources), Kilo and OpenRouter rankings
(usage, not quality). Unresolved, worth a second look: BFCL, LiveBench and Design Arena have data but no endpoint was
pinned down.

### The AA key, like the Jev key

- `init` gains a second optional step after Jev: `ARTIFICIAL_ANALYSIS_API_KEY` in the env wins; else the saved key;
  else `Artificial Analysis API key (optional; Enter skips): `. The key is tested before it is saved (one request to
  `/language/models/free?page=1`: 200 saves, 401 does not) and never stops `init` (Ruling 11).
- Saved in `credentials.json` as `artificialAnalysisApiKey` beside `typesafeApiKey`, mode 600; the schema is a
  `looseObject`, so no schema bump. The env name joins `SECRET_ENV` in `infra/env.ts`, the saved key goes through
  `addSecret`, so workers never see it and logs redact it.
- Per-user keys keep the licence clean: each user reads AA for their own use, and catherd never ships AA numbers. The
  keyless sources are CC-BY or Apache, so their values could be shipped in `scores.json` too, with attribution.
- `doctor` gets a row: key present, last sync time, requests left today (`x-ratelimit-remaining`).

### The sync

- **At every session start, in the background.** The plugin's MCP server starts with each Claude Code session, so its
  boot fires the sync without awaiting it: no hook to add, and the server's handshake and first tool call never wait
  on the network. One TTL for every source, 12 h: a source is fetched only if its cached file is older than that. It
  costs AA 2 requests a day (10 on fallback) of the key's 100. A lock file in `<data>/sources/` keeps two sessions
  opened together from fetching twice.
- **Refresh on demand.** `catherd catalog sync --force` ignores the TTL (CLI); the TUI's catalog view gets an `r`
  key that does the same and shows each source's age and last error; and an MCP tool `catalog_sync` lets the setup
  skill or the user refresh from inside a session, returning what changed (new rungs scored, stand-ins no longer
  needed, sources that failed). Routing reads whatever is cached when it is asked; a sync that lands mid-run
  is picked up by the next `route`, and a failed one logs at debug and leaves the last good files.
- `catherd catalog sync` runs the same thing in the foreground (also run by `init`, and by `freshenDiscovery` when the
  cache is older than the TTL). It fetches all
  sources in parallel with the Jev client's retry policy, one timeout per source, and writes each raw answer to
  `<data>/sources/<source>.json` with its fetch time. A source that fails keeps its last good file; the sync reports it
  and goes on.
- Id mapping: lowercase, `.` → `-` (`gpt-5.6-sol` → `gpt-5-6-sol`), then a small alias table in `catalog/sources.json`
  for the irregular ones (AA `claude-4-5-haiku` → `claude-haiku-4-5`). Effort: AA slug suffix (none = `max`), Arena's
  `(Max)` / `(xHigh)` / `(High)`, Epoch's `_max` suffix. A model with no effort in its name maps to the family's
  default effort, marked `effort: assumed`. Unmatched ids are listed by `catalog sync --unmatched`, never guessed.
- Catalog facts: models.dev fills `efforts`, `context`, `price`, `capabilities` for families on the user's backends;
  OpenRouter and LiteLLM only cross-check (a price that disagrees by more than 10 % is a warning). The shipped
  `models.json` stays the floor, and the backend's own listing still decides what is callable.

### Dimensions and sources

| Dim | Anchor (the unit of the bars) | Other sources, calibrated |
|---|---|---|
| `repo_code` | DeepSWE (today's shipped values) | AA `livecodebench`, `scicode`, coding index; Epoch FrontierCode |
| `terminal` | AA `terminalbench_v2_1` | Epoch `terminalbench_external` |
| `honesty` | shipped (Broken Search Tool) | Vectara factual consistency; Arena `agent_tool_hallucination` |
| `agentic` (new) | Arena `agent` Net Improvement | Arena task outcome and bash recovery; AA `tau2` |
| `steer` (new) | Arena `agent_steerability` | — |
| `frontend` (new) | Arena `webdev` | Epoch WebDev |
| `speed` (fact, not a bar) | AA tokens/s and time to first token | OpenRouter `latency_last_30m`, `throughput_last_30m` |
| `cost` (fact, not a bar) | models.dev price | AA `cost_per_task` |

Bars are in each dim's anchor unit, so a value from another source is never compared to a bar raw. Calibration: on
the rungs both sources cover, fit anchor = a·x + b (at least 5 shared rungs, else the source is not used for that
dim) and store the fit with its R² in `<data>/sources/calibration.json`. A calibrated value carries its source and
the fit. New dims ship with no bars, so they change nothing until a profile sets one; `route` shows them.

### Precedence and confidence

`Score.confidence` grows from `verified | secondary | inferred` to, best first: `verified` (vendor or official
source), `measured` (an independent source for this exact rung, anchor unit), `calibrated` (an independent source for
this rung, mapped onto the anchor), `adjacent` (same model, another effort, from any source), `secondary`,
`inferred`. The user's override always wins, as today. Two sources at the same level: the newer `date` wins. A value
older than 90 days drops one level. Every value keeps `benchmark`, `version`, `url`, `date` and its source, so `route`
and the TUI can say where a number came from.

### When a rung has no data: the user picks its stand-in

1. `sync` ends with the list of enabled rungs that still have no value on a dim their bars need.
2. For each, catherd ranks the scored rungs by similarity on what every source does have for new models: AA
   intelligence index, `hle`, `scicode`, `lcr`, `cost_per_task`, tokens/s, models.dev price and context, same vendor
   and family. The distance is a z-score Euclidean over the features both rungs have, and a pair with fewer than 3
   shared features is not suggested.
3. The TUI's treat-like picker opens with the top 3 suggestions first, each with its distance and the features it
   rests on ("Opus 5.5#high ≈ Fable 5.1#medium: intelligence 53.6 vs 48.9, scicode 0.60 vs 0.59, price $4/$20 vs
   $10/$50"). The CLI prints the same: `catherd catalog treat-like <rung> --suggest`. The user picks, or types any
   rung; the choice goes to `catalog.override.json` as today, marked `source: "user"`.
4. `init --no-input` and headless runs never block on it: they take the top suggestion as `inferred`, and `doctor`
   lists it as a warning to confirm.
5. When a later sync brings real data for that rung, the stand-in is no longer needed: `sync` says so and
   `catherd catalog treat-like <rung> --clear` removes it (a user's pick is never removed silently).

### Where it lives

- `src/infra/sources/<source>.ts`: one fetcher and parser per source, returning `{ rung, field, value, date, url }` rows.
- `src/services/source-sync.ts`: fetch, cache, id mapping, calibration, merge into the `Catalog` layers in
  `catalog-service.ts`.
- `src/domain/catalog.ts`: new dims in `DIMS`, the longer confidence enum, `RANK` extended.
- `src/entry/init-command.ts`: `aaStep` beside `jevStep`; `catalog-command.ts`: `sync [--force]`,
  `treat-like --suggest|--clear`; `entry/mcp/`: the background sync at server boot and the `catalog_sync` tool;
  `entry/tui/`: the `r` refresh key and the stand-in picker's suggestions.
- `catalog/sources.json`: aliases and the list of sources with their licence and attribution line.
- Tests: one recorded fixture per source (parsers), the id mapping table, the calibration fit, precedence, and the
  suggestion ranking on the 2026-09-27 data (Opus 5.5 has no coding or terminal value in any source that day).

### Today's gap, for calibration

On 2026-09-27 AA has full per-effort values for GPT-6 Astra, Claude Fable 5.1 and GPT-5.6 Sol/Terra/Luna, but only
intelligence index, `hle`, `scicode` and `lcr` for Opus 5.5 and GPT-6 Sol/Luna (released five days earlier); Arena's
agent board has GPT-6 Sol (Max) but not Opus 5.5 or GPT-6 Luna; Vectara has GPT-6 Sol and Astra. So the stand-in
picker is the path for exactly the rungs a fresh release adds, and each daily sync shrinks that list without anyone
typing a number.

## Routing and cost

- **Jev hit-rate review.** After N runs, show how often each Jev start rung had to climb, per kind and difficulty:
  "build lanes on `codex:gpt-6-luna#high` climbed 3 of 10". _Why:_ it is the raw material for catalog tuning, and it
  tells the user whether a bar is too low today. _Where:_ `runs_summary`, `watch`, and the setup skill.
- **Jev difficulty calibration.** In the first two real runs Jev was sure of the kind (1.0) but not the difficulty
  (0.4), so 3 of 4 routes fell back to the default. Log each lane's final outcome (climbed or not) beside Jev's answer,
  then tune the difficulty question's wording, its options or its threshold from that data.
- **Batch `route`.** `route` takes one lane per call, and each call may wait up to 25 s on Jev, so a milestone of
  six lanes can spend minutes routing before its first dispatch. One `route(run, lanes: [...])` could ask Jev for
  every lane at once and return one answer per lane. _Where:_ the `route` tool and `routing-service.ts`.
- **First-turn cost on small lanes.** A native Codex turn starts at about 280k input tokens (mostly cached) whatever
  the lane's size. A profile rule such as "isolated below difficulty build" could save most of it without touching the
  user's harness for real work. _Where:_ the profile's `harness.<backend>.isolated`, made conditional.

## Orchestration

- **A per-milestone digest.** One screen per landed milestone: A-lines met, commits, climbs, open findings, time and
  tokens. The push notification links it. _Why:_ the user asked "where is it" about 8 times in one run; the milestone
  push answers when, and the digest answers what. _Where:_ `land` writes it into the run folder; `watch` shows it.
- **Milestone per branch.** A real multi-MR build wants one branch and one MR per milestone, some in parallel. `land`
  only commits. _Where:_ an optional `branch` on milestones, and a finish step that opens the MR through the repo's
  own tooling.
- **Stacked milestones.** Starting M2 only after M1 merged serializes the run behind review and the gate. M2 could
  start on a branch stacked on M1 while M1's gate and MR run, and rebase once it merges.
- **Climb only for capability.** Half the climbs in the auth build were plan contradictions or file-ownership limits,
  which a stronger model cannot fix. Before climbing a `blocked` reply, `ask(run, "finding")`, and send `design` or
  ownership to the architect. _Evidence:_ `reports/2026-09-27-auth-build.md`, finding 5.
- **Verifier in the foreground, no polling.** All nine verifier calls ran in the background, and the main thread ran
  46 sleep/poll loops while waiting on dispatches. The `wait` tool removes the loops; `land` should record how the
  verdict was produced.

## Later

- **Race mode.** For lanes a profile marks as critical, dispatch two rungs at once in separate worktrees and keep the
  first whose fast check passes. It trades quota for wall-clock time.
- **Automatic retro.** At the finish, write a short retro (climbs, the slowest steps, failures) and suggest
  improvements.
- **`catherd bench`.** Replay recorded real tasks under different profiles to measure them on the user's own work.
- **Standalone binaries.** `bun build --compile` per platform, published as optional platform packages, so users need
  no Bun install. It waits until OpenTUI's native core embeds cleanly in a compiled binary.

## Live coverage still missing

An opencode lane, quota failover and a budget stop have run only in tests, never in a real orchestrated run; the
live kit now scripts them, with parallel lanes and a forced climb (`live-verification.md` §6), and they leave this
list once a release run records them. A climb and a multi-milestone, multi-MR build are covered live (the auth
build, 8 climbs, 16 MRs).
