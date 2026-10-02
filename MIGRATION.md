# Upgrading catherd

- [From 1.4 to 1.5](#from-14-to-15)
- [From 1.2 to 1.3](#from-12-to-13)
- [From 1.1 to 1.2](#from-11-to-12)
- [From 1.0 to 1.1](#from-10-to-11)
- [From 0.x to 1.0](#from-0x-to-10)

## From 1.4 to 1.5

1.5 reads 1.4's profiles, runs, credentials and catalog as they are, and `init` asks nothing new. Upgrade, check,
update the plugin, then start a new session:

```sh
bun add -g catherd-cli@latest && catherd doctor
claude plugin marketplace update catherd && claude plugin update catherd@catherd
```

On Codex, install the plugin again from the marketplace (the README's "Native Codex" commands) and restart the
host. The native Claude agent files changed (they now forbid the coordinator tools): `catherd doctor` shows the
`Claude agents` row as `stale` and names the fix, `catherd profile use <profile>`.

### `wait` stays gone: end the turn

1.4.0 had no `wait` tool, and 1.5 adds none: a bounded `wait` that sat on `main` after 1.4.0 never reached a
release and is removed, from the tools, the skill and the prompts. After `dispatch`, end the turn. Each finished
role's result comes to you as a message; `peek` shows how a run stands and `result` reads a record.

- **On Codex** the result is now also pushed from where the role ends: its supervisor queues the notice to your
  thread (`codex queue --remote unix://…`) when the role exits, so a result reaches you even after Codex stopped
  your thread's MCP server. The server's own push stays the fast path; one receipt covers both, so nothing arrives
  twice.
- **Run a Codex coordinator inside tmux** (or screen). Codex's app-server stops a thread's MCP servers once no
  client is attached, so an SSH drop detaches you; the queued input waits for the next attach. The skill says so
  once when `$TMUX` and `$STY` are empty.
- **A goal continuation** while only roles are live ends with no tool call. `peek` answers `actionable: false`
  with its `reason` when nothing is the coordinator's to do.
- `catherd doctor --test-push --thread <uuid>` tests the push to a Codex thread from a shell, and the new
  `test_push` tool from inside the thread.

### Roles never steer the run: `E_ROLE_SCOPE`

catherd sets `CATHERD_ROLE=<run>/<name>` in every role's environment. A process that carries it (or whose
`TMPDIR` is a role's scratch folder) never becomes the run's owner, and its catherd MCP server refuses the
coordinator tools with the new error `E_ROLE_SCOPE`: `peek` of another role, `result`, `dispatch`, `run_start`,
`climb`, `land`, `park`, `cancel`, `set_next`, `answer`, `profile_set`, `test_push`, `run_pin`, `lane_set`,
`owns_add`, `record_agent_run`, and the workspace writers (`workspace_start`, `workspace_contract` with `content`,
`workspace_child_start`, `workspace_budget`, `workspace_pause`, `workspace_resume`). Their descriptions now start
"Orchestrator only". A role may still `peek` its own dispatch.

- **What triggers it:** a brief that asks a role to dispatch, land, read another role's result or change the
  profile, or a role whose shell calls catherd's plugin server for those. In 1.4 such a call could make the role
  the run's owner, and catherd's messages then went to the role's thread.
- **The fix:** call the coordinator tools only from the orchestrator, and let a role report through its reply.
  A role reads and writes its run's files and records its gate evidence with its own tools: the `catherd_role`
  server's tools (headless Codex and Claude Code roles), or `catherd run-file read|write <run> <path>` and
  `catherd gate check|pass <run> …` from its shell, which in a role act on its own run only and refuse the rest
  with `E_ROLE_SCOPE` too.
- A native Claude subagent's agent file now lists those tools (and `record_agent_run`) under `disallowedTools`.
- A catherd notice is never sent to a role's thread: a run whose owner of record is a role's thread (left by 1.4)
  logs a failed delivery and `status` warns. Take the run back with one `peek(run)` from the orchestrator.

### Isolated roles keep catherd's tools

The `catherd_role` server now reaches headless Codex and Claude Code roles whether isolated or not, and a role is
never refused for being isolated. An isolated Claude Code role with that server runs with
`--strict-mcp-config --setting-sources "" --disable-slash-commands` (and CLAUDE.md and auto-memory off) instead of
`--safe-mode`, which dropped every `--mcp-config` server. From your `~/.claude/settings.json` it carries over the
login and provider keys (`apiKeyHelper`, `env`, `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`),
`model`, `permissions.deny` and `sandbox.network`; never hooks, plugins, allow rules or project settings. Your own
agents and output styles still load. A run without the role server (fixture capture) keeps `--safe-mode`.

Each role also gets its own `TMPDIR`, `<run>/scratch/<name>/` (Codex, Claude Code and isolated opencode roles),
named in its brief; `catherd runs clean [<id>]` removes the scratch of runs with no live role. `dispatch` with
`lane` inlines the lane file into the brief, so a brief no longer needs to paste it.

### Other changes you will notice

- **`route` returns seven keys:** `lane`, `role`, `rung`, `ladder`, `backend`, `agent` and a one-line `why`. The
  provenance 1.2 added to `route` (each threshold, the value used, its source, the cost and run evidence), the
  source, kind, difficulty and Jev's answer are now in the run's `routes.jsonl`, which also records every role's
  decision (rows with `lane: null`) and each lane's final outcome (`source: "outcome"`). A script that reads
  `routes.jsonl` itself should filter on `source`. `route(run, lanes: [...])` routes a milestone's lanes at once.
- **Routing starts lower or differently on some profiles.** An unpriced rung on a plan or subscription now costs 0
  and can start lanes; the ladder order breaks ties; a climb ladder holds only rungs at least as strong as the one
  before it, so on the default profile copy lanes climb Luna high → Sol xhigh, and `ui` logic and hard lanes start
  at Sol xhigh. `catherd profile validate` now warns about a quota no worker rung starts on and a kind and
  difficulty no worker rung reaches.
- **Lane headers live in one block** under the `# ` title (blank lines right after it are skipped), up to the first
  blank line or heading. A `Kind:`, `Owns:` or `After:` line further down is body text, not a header.
  `write_run_file` refuses a lane whose header values are wrong (an unknown Kind or Difficulty, an Owns path
  outside the repo, a malformed `After:` or `Allow:`); `lane_set` and `owns_add` edit a lane's header in place.
- **Lane order:** `After: <lane id>` holds a lane until the named lanes finished (`E_ADMIT_ORDER`).
- **A run keeps its profile.** `run_start` pins the profile name, each role's access and each backend's isolation
  in the run. Binding the repo to another profile, or changing a role's access or a backend's isolation, no longer
  changes a running run: `state.md` and `status` name the difference, and `catherd runs pin <id>` (or `run_pin`) re-pins it to the repo's profile now.
- **Knowledge is keyed by the git origin:** `<data>/repos/origin-<key>/knowledge.md`, shared by every worktree and
  clone of one repository (a repository with no origin keeps its toplevel key). A worktree's old file is merged in
  on its first read and renamed `knowledge.md.migrated`. `catherd knowledge path` shows where it is.
- **The gate environment:** `catherd knowledge env set NAME=value` (or `NAME --from VAR` for a secret, which is
  never stored by value), `env rm NAME`, `env list`. The verifier and preflight run with it; it lives beside
  `knowledge.md`.
- **Per-role timeouts:** `catherd profile set roles.verifier.timeouts.wallMin 240` (and `idleMin`) over the
  profile's own; `null` clears it. A `catherd lock` command still writing output, or waiting for a slot, keeps its
  role's wall clock alive.
- **`catherd doctor --docker`** probes a two-container compose network by service name and Docker's free disk;
  every `doctor` now warns about a Docker client `proxies` block and toolchain caches you cannot write.
- **`catherd pause --machine "<reason>"`** (or `--workspace <id>`) and **`catherd resume --machine`** (or `--workspace <id>`): while paused, every
  `dispatch` is refused with the new `E_ADMIT_PAUSED` naming the reason; running roles finish.
- **`catherd runs supersede <id> --by <id>`** (or `run_start`'s `from`) closes a run with a pointer to the one that
  took over; `status` hides it, and a `dispatch` into it is refused with `E_RUN_NOT_LIVE`.
- **`thread`:** `dispatch` refuses a thread that name never ran on in the run (`E_ADMIT_THREAD`), so a fix round
  under another name (`worker-x-fix` on `worker-x`'s thread) is refused: resume by the same name, or pass
  `thread: "latest"`.
- **`land` counts only a verifier named exactly `verifier-<M>`** (`verifier-M1-recheck` does not count), refuses a
  `STATUS: partial` review, and leaves parked and paused time out of the minutes.
- **Verifier and worker outcomes:** `VERDICT: BLOCKED: environment — <probe>` is a blocker for you, not a fix
  round; an `ENV:` line in a reply makes `climb` refuse that lane with the new `E_CLIMB_ENV`; `STATUS: flaky` is a
  worker outcome. `gate_pass` records `<HEAD>+uncommitted` as its commit when an uncommitted change lies under its
  paths.
- **New error codes:** `E_ROLE_SCOPE`, `E_ADMIT_PAUSED`, `E_ADMIT_ORDER` and `E_CLIMB_ENV`. `E_RUN_NOT_LIVE` and
  `E_ADMIT_THREAD` are not new, but refuse the new cases above.
- MCP: 38 tools (`test_push`, `run_pin`, `lane_set`, `owns_add` and the workspace tools added).

## From 1.2 to 1.3

1.3 reads 1.2's profiles, runs, credentials and catalog as they are; nothing is moved or converted, and `init` asks
nothing new. Upgrade the same way as to 1.2, then start a new Claude Code session:

```sh
bun add -g catherd-cli@latest && catherd doctor
claude plugin marketplace update catherd && claude plugin update catherd@catherd
```

- Three backends join: Cursor (`cursor:`), Grok Build (`grok:`) and Antigravity (`antigravity:`). Each is off until a
  profile puts a rung on it; the default profile is unchanged. The README's backend sections say how each logs in,
  what each access mode runs, and what isolation needs.
- `catherd doctor` shows a `backend:` row for each, missing or not, and for a backend a profile uses, its
  `isolation:` and `access:` rows. `quota:antigravity` shows a signed-in agy's plan quota.
- Isolating Cursor, Grok or Antigravity needs its API key (`CURSOR_API_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`) in the
  environment catherd runs in: a profile that isolates one without it no longer validates.
- A read-only role (architect, reviewer, researcher by default) cannot run on native Antigravity, which has no
  read-only mode: isolate it, or put the role on another backend.
- A thread resumed under another access or network grant than it started with is refused on a backend that keeps a thread's access
  (Grok, Antigravity), with the fix "dispatch a fresh thread".
- After the next sync, Gemini, Grok and Composer rungs have scores of their own. Grok and Gemini rungs fail over
  between Grok Build or Antigravity and Cursor on a usage limit unless your profile names another stand-in.

## From 1.1 to 1.2

1.2 reads 1.1's profiles, runs, credentials and catalog override as they are. Upgrade the same way as to 1.1, then
start a new Claude Code session:

```sh
bun add -g catherd-cli@latest && catherd init
claude plugin marketplace update catherd && claude plugin update catherd@catherd
```

`init` asks for an optional [Artificial Analysis](https://artificialanalysis.ai) key after Jev's (Enter skips; it
is tested, then saved in `credentials.json`) and syncs the public sources. Without a key, routing uses the keyless
sources and the scores catherd ships.

- Piped `init` now reads four lines: the Jev key, the Artificial Analysis key, the profile, whether to replace it.
  A script that pipes 1.1's three answers needs an empty line after the Jev key.

### Routing reads new bars

The default bars now span several dimensions per kind: `repo_code` lanes gate on DeepSWE, `terminal` lanes on
Terminal-Bench, `ui` lanes on WebDev and DeepSWE, and logic and hard lanes also on honesty and Arena's agentic
score. Their thresholds are the 25th, 50th, 60th and 75th percentiles of the rungs measured or better (each
threshold's reason is in `catalog/scores.json`'s `barsWhy`). On the default worker ladder (Luna high, Sol medium,
high, xhigh) this means:

- copy and build lanes start on Luna high (its DeepSWE value carried from Luna max), `terminal` lanes on Sol
  medium, and `ui` build lanes on Sol xhigh;
- no Sol rung reaches a logic or hard bar (Sol's agentic score is just below the 60th percentile), so those lanes
  start at the default rung, Sol medium, as they did in 1.1.

A `bars` entry in `catalog.override.json` now changes only the dimensions it names; the default's other
thresholds stay. Write `null` for a dimension to remove its threshold.

### Unscored rungs never make a profile invalid

- "`<rung>` is unscored" and "stand-in `<rung>` is unscored" are warnings now. A rung that lacks a value on a
  dimension the bars use takes its nearest stand-in's, marked `inferred`, and `profile validate` and `doctor` list
  it as a "stand-in to confirm".
- A save that fixes one of a profile's errors and adds none goes through, and lists the errors still open. Before
  1.2, a profile with two errors could not be repaired one `profile set` at a time.
- Your treat-likes keep working. `catherd catalog treat-like --suggest <rung>` shows the three nearest stand-ins,
  `--clear <rung>` removes one of yours and `--reset` all of them; each first names the profile rungs it leaves on
  an inferred stand-in or unscored.
- `profile show` and the dashboard say which dimensions a treat-like lends (`agentic, steer borrowed from X`)
  when the rung has values of its own.

### Scores

`catalog/scores.json` carries the keyless sources' values (Arena, Epoch AI) beside the hand-typed ones, each value
spread to its model's other efforts as `adjacent` where no effort has its own. The shipped treat-likes for Opus
5.5 low, medium and high are gone (those efforts carry xhigh's and max's values now); GPT-6 Luna borrows agentic
and steer from GPT-5.6 Luna at the same effort until Arena scores it.

### Where to look

- `route` returns `provenance`: each threshold, the value used, its confidence, source and date, the rung's speed
  and cost facts and its run evidence. `catalog_query` and `catherd catalog list` show values' sources and each
  rung's run evidence. The text `catherd catalog list` prints changed shape (a values line, then `runs:`): a script
  that scraped it should read `catherd catalog list --json` instead.
- In the dashboard's Profiles tab, `r` syncs the sources (and lists the backends' models) and shows each source's
  age and last error, `i` shows a rung's values and runs, and `t` opens the treat-like picker with the three
  nearest stand-ins first.
- MCP: 26 tools (`catalog_sync` added).

## From 1.0 to 1.1

1.1 reads 1.0's profiles, runs and settings as they are; nothing is moved or converted. Upgrade with 1.1's own
`init`: a `catherd init` from a 1.0 install runs 1.0, which installs nothing, and 1.0's documented install
(`bunx catherd-cli init`) left no `catherd` command at all.

```sh
# either: install 1.1 globally, then run its init (its checks)
bun add -g catherd-cli@latest && catherd init
# or: run 1.1's init through bunx; it installs the global command at its own version
bunx catherd-cli@latest init
# then, either way: the plugin
claude plugin marketplace update catherd && claude plugin update catherd@catherd
```

Then start a new Claude Code session: it loads the new plugin, its MCP server and the rewritten skills.

### `wait` is gone: results come to you, `peek` and `result` read them

1.0's orchestrator called `wait` after dispatching, and the whole session froze until the roles finished. In 1.1
`dispatch` returns at once, the orchestrator ends its turn, and each finished role arrives in the session as a
message from catherd (`<cross-session-message from-name="catherd">`), the way a native subagent's notice does.
You can keep talking to Claude meanwhile.

| 1.0                                           | 1.1                                                                                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `wait(run, names?)` blocks until roles end    | removed; the notice arrives by itself                                                                                                           |
| `wait` returned the records                   | `result(run, name)` returns one record and marks it read                                                                                        |
| `status(run)` to see where a run stands       | still works; `peek(run?, name?)` answers at once: live roles with their last event, unread records, parked questions and the next protocol step |
| `CATHERD_TICK_MS` (how often `wait` reported) | removed                                                                                                                                         |

`peek` never waits and never marks anything read. A record stays unread until `result` reads it, so a notice that
never arrives (Claude Code closed, an old Claude Code) loses nothing: `peek` or the next `run_start` shows it.
`catherd doctor` has a `push` row: run it from a Claude Code session (its Bash tool) to test the notices. On
Linux, where Claude Code cannot tell that catherd's messages come from its own MCP server, the row says whether
to set `crossSessionInbound`; `init` never changes that setting.

### The MCP tools: 25

Removed `wait`. Added `peek`, `gate_check`, `gate_pass`, `park` and `answer`. Changed:

- `dispatch` refuses a lane whose `Kind:` or `Difficulty:` is not one catherd knows (`E_LANE_INVALID`, with the
  allowed values), routes a lane that was never routed, and appends the role's reply contract (the `STATUS:` line)
  to every brief. Briefs no longer need to carry it.
- `land` refuses a milestone without a reviewer record and a verifier verdict since its lanes started
  (`E_LAND_GATE`); `skip: "docs-only"` and `skip: "no-code"` cover milestones that change no code. It also writes
  the milestone's digest, `<run>/digests/<milestone>.md` (the A-lines, the commit, the lanes with their rungs and
  climbs, the reviewer's findings, the verifier's verdict with its carried items, minutes and tokens), and returns
  its path as `digest`; the orchestrator's milestone message links it.
- `climb` refuses a plan or ownership problem (`E_CLIMB_DESIGN`): that goes to the architect, not up the ladder.
- `result` consumes the record (see above); `run_start` returns the run's next protocol step and the milestone
  checklist, and `state.md` ends with `Protocol next: <step>`.
- `park(run, milestone, question)` and `answer(run, milestone, answer)`: one owner question no longer stops the
  run; the other milestones go on.
- `gate_check` and `gate_pass`: the verifier carries over a gate item whose command and inputs have not changed
  (the ledger is `<data>/repos/<repo>/gates.jsonl`). Every `gate_check` is a verifier step (`<run>/verifier.jsonl`):
  `peek` and `status` show its latest step as the verifier goes, a carried item with the commit its pass was
  recorded on. `gate_check` takes an optional `milestone`, so a milestone's digest lists only its own
  carried items.

The plugin's skills use all of this; update the plugin with catherd, as above.

### Workers can run their own checks

A `workspace-write` role (worker, writer, artist by default) may now reach the network, bind a loopback port,
write catherd's lock dir and the temp dir, and talk to a local Docker socket. Codex gets
`sandbox_workspace_write.network_access` and `writable_roots` for it. To keep a role off the network:

```sh
catherd profile set roles.worker.network false
```

`catherd doctor` runs five probes for each backend a `workspace-write` role uses (lock dir, temp dir, loopback,
HTTPS, Docker) and names the fix for each that fails.

### Processes catherd starts no longer see the Claude Code session

Workers, the supervisor, `doctor`'s MCP server, `init`'s install and a command run under `catherd lock -- <cmd>`
no longer get `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_HOST_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET` or
`CLAUDE_CODE_MESSAGING_TOKEN` (nor `TYPESAFE_API_KEY`, as in 1.0). catherd keeps them to itself so only the
session's own MCP server owns its runs and messages it. A script run under `catherd lock` that read the session id
must now take it as an argument.

### Failover and validation

- The default failover now uses only a stand-in that clears the same bars as its rung at least as well: Luna high
  to OpenCode Go's Luna, Sol medium to Kimi K3. Sol high and xhigh have none, so a usage limit there pauses the
  lane instead of dropping it to the medium tier. **A profile written by 1.0 keeps its own map**, which sends Sol
  high and xhigh to Kimi K3; `catherd profile validate` now warns about it (`downgrade: …`) and its fix removes the
  entry, or run `catherd profile set failover.codex:gpt-6-sol#high null` (and the same for `#xhigh`).
- `validate` also warns when a stand-in spends Claude quota while another plan could stand in, and when a
  ladder's rung scores below the one before it. Warnings never block a save.
- `profile show` and the dashboard say "scores borrowed from X" for a stand-in with no scores of its own, instead
  of "inferred: treated like X".

### Install and launch

- The marketplace fetches the plugin over HTTPS, so installing it no longer needs a GitHub SSH key.
- The plugin starts its MCP server through `plugin/bin/catherd-mcp`: the global `catherd` when it is the plugin's
  version, else `bunx catherd-cli@<version>` with its cache in `~/.cache/catherd/bunx` (or
  `$XDG_CACHE_HOME/catherd/bunx`) instead of `$TMPDIR`, which macOS cleans. Workers still get your own `TMPDIR`.
- `catherd init` installs the global command at its own version and says `installing catherd…` first;
  `--no-global` skips it.
- `catherd doctor`'s `mcp` row starts the server the way the plugin does; a broken install says
  `reinstall: bun add -g catherd-cli@<version>`. The shipped defaults' access rows (full access for the verifier
  and ui-reviewer, advisory access for the Claude roles) are info rows (`i`) now, and warnings only when a
  profile changes them.

### The runs page, by session

`catherd`'s Runs tab lists the Claude Code sessions that drove runs, newest first; open one to watch its runs,
milestones and roles live; a milestone opens on its digest (what landed, lanes and climbs, reviewer and
verifier, tokens). Runs started by 1.0 are under "earlier runs". `catherd runs list` and `status` group
the same way, and their `--json` gains `session`.

## From 0.x to 1.0

1.0 is a clean break: it reads none of 0.x's files and converts nothing. One command sets it up:

```sh
bunx catherd-cli init
```

### What `init` does to a 0.x install

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

### What it leaves alone

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

### Then

1. Update the Claude Code plugin, and start a new session:

   ```sh
   claude plugin marketplace update catherd && claude plugin update catherd@catherd
   ```

2. opencode must be v2 (2.0.16 or newer); 0.x's install hint installed v1:
   `curl -fsSL https://opencode.ai/v2/install | bash`.
3. Check everything with `bunx catherd-cli doctor`: it exits 0 when catherd is ready, and prints the fix
   for every row that is not.

### What else changed

- Bun 1.4 or newer; catherd refuses to start on an older one and says how to upgrade.
- `catherd watch` and the dashboard show 1.0 runs only.
- The MCP server has 21 tools (0.x had 18), and every error is `{ code, message, fix }`. `dispatch` now returns
  as soon as its role starts, and the new `wait` returns the records; the plugin's skills
  are updated to match, so update the plugin with catherd.
- Exit codes: `0` ok, `1` error, `2` usage, `3` not ready (`doctor`), `130` interrupted.
