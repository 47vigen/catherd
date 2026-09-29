# Upgrading catherd

- [From 1.2 to 1.3](#from-12-to-13)
- [From 1.1 to 1.2](#from-11-to-12)
- [From 1.0 to 1.1](#from-10-to-11)
- [From 0.x to 1.0](#from-0x-to-10)

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
- A thread resumed under another access than it started with is refused on a backend that keeps a thread's access
  (Grok, Antigravity), with the fix "dispatch a fresh thread".
- After the next sync, Gemini, Grok and Composer rungs have scores of their own. Gemini rungs fail over between
  Antigravity and Cursor on a usage limit unless your profile names another stand-in.

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
  rung's run evidence.
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
