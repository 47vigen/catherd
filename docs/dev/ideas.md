# Ideas for 1.x

Improvements collected from real catherd runs and from designing it, not yet planned. When one is picked up it moves
into a spec or plan under `docs/specs/` or `docs/plans/` (or a GitHub issue) and leaves this list. One entry per idea: what, why
(the evidence), and where it would live.

Shipped in 1.0, so not re-proposed here: `catherd doctor`; the harness-cost line in `runs_summary` and the final
report; quota failover (the profile's `failover` map); the `preflight` tool; per-repo knowledge
(`<data>/repos/<slug>-<hash8>/knowledge.md`, read with `read_knowledge`, appended by `land`); the run budget (from 80 %
`route` starts at the cheapest rung that clears the bar; once spent, `E_RUN_BUDGET` pauses the run); the trimmed catalog (`catalog/models.json`, `scores.json`, `jev.json`); a plan in hand (a `plan:` A-line: no dossier, the architect translates); lint and type check in each lane's fast check; `status` showing the run's native and isolated dispatches, with the harness figure compared within one repo; and a sure Jev kind kept when its difficulty is unsure (`source: "jev-kind"`).

## 1.1 follow-ups (minors from the 1.1 reviews, 2026-09-28)

Owner rule for the end of 1.1: review Minors and non-correctness bot P2s land here, not in code. Each is small.

- **Push and sessions (plan 10).** `watch()` in dispatch-service settles and fails over a limit without checking
  that this session still owns the run (failover-once keeps it to one stand-in, but the old owner can start it).
  Codex activity is computed twice per line; a file change with no paths shows `edit `; Claude tool activity shows
  only the tool name (opencode shows its first argument).
- **Runs page (TUI).** A ref is written during render in `runs.tsx`; the role screen keeps polling a finished role;
  a recent run opened from the Status tab lands on the session's first role, not that run; a session opens on its
  first milestone row and live roles can sit below the fold; `milestoneAt` rebuilds its list on every key; a
  milestone whose id is not `M<n>` gets a row only once it has landed. The `watchDirs` real-fs test can pass on a
  late probe event; doctor's `failed` push row is tested only with a hand-made outcome.
- **Protocol and gate (plan 11).** `laneDone` reads the records file once per lane; `peek.ts` shadows `r` and reads
  the notes twice. A verifier that writes `**VERDICT: PASS**` in markdown counts as no verdict (fails safe): say so in
  the `E_LAND_GATE` fix. The first milestone's commit range is its landed commit only (store the start HEAD in
  meta.json). `dispatch` routes (asks Jev, writes a route row) before admission can refuse, and two concurrent
  dispatches of one lane both route it. The ownership regex for climbs also catches environment errors that say
  "owned by". `gate_pass` names HEAD for a pass on an uncommitted tree; a staged rename out of a gate's paths is not
  seen; `./` is refused where `.` is meant.
- **Access and doctor.** Doctor's claude-code access row reads the sandbox setting of the directory doctor runs in,
  not each bound repo. `profile show` pads the "(no network)" row wrong; nothing warns about `network: false` on a
  read-only or full role. Live check: whether `bunx catherd-cli@latest init` sees bunx's own `.bin` on PATH and
  reports the global install as present.
- **Failover and validation (plan 12).** An unscored stand-in gets both its "unscored" error and a "downgrade"
  warning; `ladderDropDims` has no direct unit test; `rankStandIns` recomputes the bar check per pool member.
- **Docs.** live-verification §9.2 reads verifier minutes from `agents.jsonl`, so a headless (`claude-code:`)
  verifier prints nothing; the "back to published" block reuses `$version`, empty in a new shell.
- **Install (plan 12 final review).** `bun add -g` in `init` has no time limit; the spawned init test passes
  `BUN_INSTALL` through; `init` no longer warns "shadowed" when the global install is current but an older `catherd`
  comes first on PATH (the launcher then falls back to bunx); an open milestone row lost its description; §9 check 5
  should say "at least three" worker folders.
- **Tests.** Three doctor tests run close to the 5 s default under load (plan 11's probes make a doctor run ~2.3 s):
  give them 30 s like their neighbour. One full `bun test` run in five failed once on plan 12's head with no name recorded; heavy parallel
  load in a shared sandbox times out git- and notifier-based tests at 5 s.

## Picked up

- **Push results to the main thread, drop `wait`**, and **the runs page by main-thread session** (both designed
  2026-09-28): now spec 1.1 §3 and §4, built by `docs/plans/2026-09-28-10-push-sessions.md`. The facts they rest on
  are in `docs/research/2026-09-28-cross-session-messaging.md`, which corrects two of the first notes: the self-sent
  rule runs on Linux too (a `/proc` walk), and `CLAUDE_CODE_HOST_SESSION_ID` is set only by a host (Desktop).

## 1.1.0 scope, settled (grilled 2026-09-28)

Written up as `docs/specs/2026-09-28-catherd-1.1-design.md`, which governs where the two differ.

1.1.0 = push results to the main thread (section above), the runs page by session (above) and the whole fix bundle
(below). Model scores from public sources go to 1.2.0. Implemented by the maintainer's own subagents in reviewed
bundles, not by catherd on itself; the plan goes to `docs/plans/`. Decisions per item:

- **Worker access.** Roles that write (worker, artist, writer) get network access plus the lock dir and the temp dir
  as writable roots by default; the rest of the disk stays closed. Verified 2026-09-28 on Codex 0.157 with
  `-c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true -c
  sandbox_workspace_write.writable_roots=[<locks>,"/private/tmp"]`: lock-dir write, `docker ps` over the OrbStack
  socket, a loopback `bind()`, an HTTPS fetch and a `/tmp` write all pass. A profile field `network: false` tightens
  it. opencode and headless Claude Code get the same intent through their own mechanisms (a researcher pins them
  down first); where one cannot, `doctor` says which of the five probes fail. `doctor` runs the five probes with the
  exact flags workers get.
- **Protocol enforced by the tools.** `dispatch` routes an unrouted lane itself; `dispatch` appends the role's reply
  contract (last line `STATUS: …`) to every brief; `land` refuses a milestone without a reviewer record and a
  verifier verdict unless the reason is `docs-only` or `no-code`, and it checks the diff to hold the claim.
- **MCP server launch.** `.mcp.json` runs the global `catherd mcp` when installed (`init` installs it), else falls
  back to `bunx`; `doctor` starts the server once and says "reinstall" when a module is missing.
- **Verifier.** Its brief says to run independent gate items side by side within the lock's slots and to build each
  commit's image once. A small gate ledger records each passed item with the command and the hash of its paths; a
  later run in the same repo reports an item as carried over when both match, except items whose paths are in the
  milestone's diff. The verifier reports each step it starts, so `peek` and `status` show where it is.
- **Owner questions.** `park(run, milestone, question)` pushes the full question and parks only that milestone; the
  rest continues. The answer comes in the main session, which records it and unparks; with no session, the next
  `run_start` or `peek` shows unanswered questions first.
- **Climb.** `climb` asks Jev for the kind of the failure first; plan design or file ownership is refused with a fix
  line ("send it to the architect").
- **Routing.** Under objective `cost`, `route` starts at the cheapest rung whose score clears the lane's difficulty,
  using today's `scores.json`.
- **Failover.** An inferred stand-in must clear the rung's own bar; Claude-plan rungs rank last; with no fitting
  stand-in there is none, and `doctor` says so. Fix the "treated like" labels.
- **Small items.** The marketplace plugin source becomes a full HTTPS URL; `doctor`'s sandbox probe uses `codex
  sandbox [COMMAND]`; `validate` warns on a descending ladder; `doctor` shows the shipped defaults' access rows as
  info; `init` says "installing catherd…" before the first resolve; the TUI's first frame does not say "0 profiles".
  First-turn cost stays an idea.
- **Acceptance.** CI green; a `claude -p` test on a scratch repo proving messages arrive while the session is free,
  `peek` works, route/review/verify are enforced and a worker runs `bun install` and its tests itself; then the real
  run: merge MR !54 and run auth plan 5 MR B in a fresh Desktop session, compared with MR A's numbers.

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

_Picked up:_ designed in `docs/specs/2026-09-28-catherd-1.2-design.md` (1.2.0). The spec is binding where it differs from this section.

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

## From the 1.1.0 install (2026-09-28)

- **An invalid profile cannot be repaired field by field.** Clearing `treatLike` in `catalog.override.json` left three
  rungs unscored (`gpt-5.6-sol#high`, `gpt-5.6-sol#medium`, `gpt-6-luna#medium`). Every `catherd profile set` then
  failed with `E_CONFIG_INVALID`, even a `set` that removes one of those rungs, because each save validates the whole
  profile and the other bad field still fails. The workaround was to restore the mappings, make the edits, and clear them
  again. Fix: a save that removes errors and adds none goes through, and the result lists the errors still open.
- **`treat-like` cannot be undone from the CLI.** There is no `catherd catalog treat-like --rm`, so the only way to
  reset a mapping is to edit `catalog.override.json` by hand. Add `--rm <rung>` and `--reset`. Before removing a mapping,
  warn which profile rungs it would leave unscored.

- **The runs tab shows 00:00 for running roles.** In the M3 platform run (2026-09-28), two workers had been running for
  3 minutes and their event logs were growing, yet the TUI showed `running 00:00` for both. The owner took this to mean
  the run was stuck. Elapsed time should count from `proc.json` `startedAt`. Also show the last event's age, so that
  "alive" and "stuck" look different.
- **Workspace-write codex cannot reach the Go build cache.** In the same run, the M3.L1 worker's `go vet ./...` failed
  with "operation not permitted": the Go build cache (`~/Library/Caches/go-build`) is outside `writable_roots`. The
  worker got past it by pointing `GOCACHE` at `/private/tmp`, which forces a cold cache on every lane. Fix: add the
  toolchain caches that are present (`go env GOCACHE`/`GOMODCACHE`, the pnpm store, `~/.bun/install/cache`) to
  `writable_roots`, and add a `doctor` probe for them.

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
