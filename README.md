# catherd

```
 /\_/\  .  catherd
(=^.^=)/   herds coding agents
 (")(")
```

Autopilot builds from your own Claude Code or native Codex session. Your profile routes the architect, verifier and workers to their backends; Codex, opencode
or headless Claude Code processes write the code, and a decision model you point it at picks the model and effort for each dispatch.

- **Your harness, as you set it up.** Every role runs in its vendor's own CLI with your config,
  hooks, skills and `AGENTS.md`. Isolation is an opt-in toggle per profile and harness, for when
  you'd rather save the tokens your customizations cost.
- **A daemon drives the run.** `run_start` launches a detached daemon that plans, dispatches, reviews, verifies
  and lands each milestone from the run's own `events.jsonl`. Every role runs headless in its vendor's CLI
  (Claude Code, Codex, opencode); the session needs none of it once the run has started, and a dropped
  session or MCP server never loses a run.
- **Questions reach your phone.** A parked question and the final report are sent to your ntfy topic
  (`notify.url`), and answered from the session (`answer`) or the terminal (`catherd answer`).
- **A protocol the daemon enforces.** Every lane implements its plan tasks as written, and every role, whatever vendor runs it, gets its role's text and ends with the reply contract, and a
  milestone lands only after a reviewer and a verifier passed it. A judge role decides what no rule can (an
  ambiguous finding, a stuck fix round, an unmet check) from the run's facts. An owner question parks one milestone,
  not the run.
- **Guard rails for autopilot.** Quota failover to an indexed stand-in at least as intelligent, a preflight check
  before any worker starts, per-repo knowledge carried between runs, and a run budget.

## Requirements

- [Bun](https://bun.sh) ≥ 1.4
- An orchestration host: [Claude Code](https://claude.com/claude-code), or native [Codex](https://github.com/openai/codex) CLI/Desktop with plugin support and the existing native queue endpoint (installed CLI 0.159.2 verified for packaging; queue support is feature-detected)
- At least one worker backend, logged in:
  - [Codex CLI](https://github.com/openai/codex) 0.157.0 or newer
  - [opencode](https://opencode.ai) **v2**, 2.0.16 or newer: `curl -fsSL https://opencode.ai/v2/install | bash`
    (the npm package `opencode-ai` is v1 and is not supported)
  - Claude Code's `claude` CLI 2.1.282 or newer, for headless `claude-code:` rungs
- A decision model: an OpenAI-compatible endpoint and a model name, and a key in `CATHERD_DECISION_KEY` or saved by
  `catherd init` (below). A run refuses to start without one
- Optional: [gitleaks](https://github.com/gitleaks/gitleaks) (`brew install gitleaks`): catherd's milestone check
  scans the commits of a milestone with it for a leaked secret; without it the scan is skipped and the record says so

`catherd doctor` checks each backend's version and login and prints the fix for anything missing. The default
profile runs its workers on Codex; without Codex, doctor's fix also names how to move those roles to a backend
you have (`/catherd-setup`, or `catherd profile set roles.<role>.rungs <rung> --host <codex|claude-code>`). Codex-only setup does not require or configure Claude; enabled selected roles and reachable failover decide optional dependencies. Doctor sends nothing by default; `--test-push` is an explicit smoke send from a validated host session (`--thread <uuid>` names the Codex thread from a shell).

## Install

catherd runs from Claude Code or, since 1.4, from native Codex; one global `catherd` and one plugin version serve both. To check a packaged build before you rely on it, follow the [local packaged acceptance procedure](docs/dev/live-verification.md#14-native-codex-packaging-and-completion-acceptance); a matching version alone does not prove that the feature core ran.

Channels: `catherd-cli@latest` is the stable release. `catherd-cli@next` and the `plugin-next` marketplace carry
every merge to `main` before it is stable (CONTRIBUTING.md, "Next channel"). `catherd-cli@1` is the 1.x line, which receives
bug fixes only (CONTRIBUTING.md, "Maintenance line (1.x)").

### Claude Code

```sh
bun add -g catherd-cli
catherd init --host claude-code
```

The npm package is `catherd-cli`; the command it installs is `catherd`. `bunx catherd-cli init --host claude-code`
works too (a terminal with no host evidence cannot pick the architect/verifier defaults, so name the host): `init`
installs the global command at its own version (`--no-global` skips it) and says `installing catherd…` before
it does, though the first `bunx` resolve itself prints nothing for up to half a minute: bunx fetches the
package before catherd's first line, so `bun add -g catherd-cli` first is the quicker start. `init` asks for the
decision model's url, model and key, fetches the Slopalytics index, writes the default
profile and links its Claude agents, lists your backends' models, and ends with a readiness report (`--no-input`
asks nothing and keeps what exists; `--profile <name>` sets up and activates that profile instead of `default`;
piped, it reads one answer per line once stdin closes: the decision model's url, model and key, the profile,
whether to replace it, each on its own line even when a question is skipped). Then add the plugin to
Claude Code:

```sh
claude plugin marketplace add 47vigen/catherd
claude plugin install catherd@catherd
```

Start a new Claude Code session so the plugin, its MCP server and the agent files load, then check with
`catherd doctor --host claude-code`. From inside that session, explicit `catherd doctor --test-push` sends a labeled smoke notice; inspect actual processing separately from transport acceptance.

### Native Codex

```sh
bun add -g catherd-cli
catherd init --host codex
codex plugin marketplace add 47vigen/catherd
codex plugin add catherd@catherd
codex mcp list --json
```

Restart the Codex host to load the installed shared skills and server. Native CLI accepts `owner/repo[@ref]` and a local marketplace path. The supported marketplace uses `.claude-plugin/marketplace.json` with its plugin subdirectory; the native manifest is `plugin/.codex-plugin/plugin.json`, with `skills: "./skills/"` and `mcpServers: "./.mcp-codex.json"`. Installed native resolution supplies `command: "sh"`, `args: ["./bin/catherd-mcp"]`, `cwd: <installed plugin root>` and `CATHERD_ORCHESTRATION_HOST=codex`. No Claude root macro or synthetic session ID belongs in that declaration. The shared launcher/core remains versioned together with both manifests.

Pass the actual project `repo` to repository-aware MCP profile/setup/catalog calls, because the server cwd is the plugin root. `run_start(repo, ...)` already requires it. Terminal `init` and `doctor` accept `--host codex|claude-code|auto`; selecting a terminal host chooses setup checks without inventing a conversation owner.

## Use

In either supported host, use the installed shared skills through that host's skill invocation and tool discovery:

- `/catherd <task>` runs a task on autopilot; `/catherd` alone resumes the latest run. While it runs, keep
  talking: a report arrives through the host's transport and on your phone, and "how is it going?" gets a `status`.
- `/catherd-setup` tunes your profile in conversation: which models and efforts each role may
  use, the decision model, isolation, budget and failover.

A session sees six tools:

| Tool                                            | What it does                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `run_start(repo, title, a_lines, plan?, base?)` | Starts a run and returns its id and the notify url its questions go to                       |
| `status(run?)`                                  | Phase, milestones, live roles, parked questions, quota holds and whether the daemon is alive |
| `answer(run, unit, answer)`                     | Answers a parked unit (the run, a milestone or a lane); it runs again with the answer        |
| `cancel(run)`                                   | Stops the run and every live role                                                            |
| `result(run, name?)`                            | The run's report (the merge request body), or one role's record                              |
| `profile(action, …)`                            | Reads, validates or changes a profile, or sets `notify_url`                                  |

Set where questions go once: `notify.url` is an [ntfy](https://ntfy.sh) topic url (`catherd-setup`, or the `profile`
tool's `notify_url`). The daemon sends to it from your machine, so a question and the final report reach the phone
with no session open. If `notify.url` is unset, `run_start` makes a random, unlisted topic on the public ntfy.sh and
sends questions there; set `notify.url` to your own ntfy server for privacy. Omitted Codex architect/verifier choices are exactly `codex:gpt-6.1-sol#high` /
`codex:gpt-6.1-sol#low`; omitted Claude choices retain their existing defaults, and a `claude:` rung runs as its
headless `claude-code:` twin. To opt into host defaults, review and save the narrow reset:

```sh
catherd profile reset-host-defaults <profile> --host codex --preview --json > /tmp/catherd-host-defaults-review.json
# Review the diff, effective defaults, errors and warnings.
catherd profile reset-host-defaults <profile> --host codex --expect /tmp/catherd-host-defaults-review.json --json
```

It removes only architect/verifier `rungs` and `defaultRung`; every other setting stays intact. Run profile CLI commands from the project directory and choose the actual profile name. Use `--host claude-code` for Claude defaults.

A run's reports reach the session that started it (Claude Code's peer inbox, Codex's queued next input) and the phone.
`status` revives a daemon that died, so asking "how is it going?" is always safe. Roles get catherd's tools too:
headless Codex and Claude Code roles get a `catherd_role` MCP server, and other roles run
`catherd run-file read|write <run> <path>` and `catherd gate check|pass <run> …` from their shell, bound to their own
run and role (anything else is `E_ROLE_SCOPE`). `run_start`, `answer`, `cancel`, `result` and `profile` are the owner's: a role's process gets
`E_ROLE_SCOPE` for them, so a role can never take the run over.

In a terminal:

| Command                                                                                                                                                                | What it does                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `catherd`, `catherd panel [--port <n>] [--no-open]`                                                                                                                    | The panel in your browser on 127.0.0.1: Setup, Runs and Questions; a fresh token each start; `catherd --help` for the commands                                                                                                                                              |
| `catherd init [--host codex\|claude-code\|auto] [--no-input] [--no-global] [--profile <p>]`                                                                            | First-run setup; installs the global `catherd` at its own version unless `--no-global`                                                                                                                                                                                      |
| `catherd doctor [--host codex\|claude-code\|auto] [--test-push [--thread <uuid>]] [--docker] [--json]`                                                                 | Readiness and capability report; no send unless explicit smoke; `--docker` probes a compose network and the Docker disk; exits 3 when not ready                                                                                                                             |
| `catherd profile list\|show\|use [--repo]\|new [--from <p>]\|copy\|rm\|diff\|validate`                                                                                 | Profiles; `use --repo` binds one to the repo you are in                                                                                                                                                                                                                     |
| `catherd profile use --repo --clear`                                                                                                                                   | Unbinds the repo you are in; it runs on the active profile again                                                                                                                                                                                                            |
| `catherd profile set <path> <value> [--profile <p>]`                                                                                                                   | One field, e.g. `roles.verifier.access read-only`, `roles.worker.network false`, `budget.usd 20`                                                                                                                                                                            |
| `catherd status [run]`, `catherd watch [--once] [--interval <s>]`                                                                                                      | Where runs stand, grouped by host and session; read-only ownership                                                                                                                                                                                                          |
| `catherd runs list [--repo <path>]\|show <id> [--debug [--name <n>]]\|cancel <id> <name>`                                                                              | Past runs, by session; `--debug` adds exit.json and the stderr and event tails, `--name` one role's                                                                                                                                                                         |
| `catherd runs clean [<id>]`                                                                                                                                            | Removes the roles' scratch folders (each role's `$TMPDIR`) of runs with no live role                                                                                                                                                                                        |
| `catherd catalog refresh\|list [--backend <b>] [--role <r>] [--text <t>] [--older]`                                                                                    | The models catherd can place, with their indexed pairs; `--older` adds the ones a newer version replaces                                                                                                                                                                    |
| `catherd catalog sync [--force]`                                                                                                                                       | Fetches the Slopalytics index now (below); it is refreshed at most hourly otherwise                                                                                                                                                                                         |
| `catherd catalog outcomes [--json]`                                                                                                                                    | Each rung's finished lanes on this machine: first passes, rounds and findings per lane, by kind and difficulty; `--json` prints the stats                                                                                                                                   |
| `catherd knowledge show [--role <role>]\|add "<line>"\|rm "<text>"\|path [--repo <path>]`                                                                              | The repo's knowledge.md, keyed by its git origin (its toplevel when it has none), which new runs read; `add` appends a fact of yours, marked "by hand"; a `[role, …]` tag after the source scopes a line to those roles' briefs; `rm` removes the one line the text matches |
| `catherd knowledge env set NAME=value\|NAME --from VAR`, `env rm NAME`, `env list`                                                                                     | The repo's gate environment, which the verifier and preflight run with; a secret by reference only                                                                                                                                                                          |
| `catherd runs supersede <id> --by <id>`, `catherd runs pin <id>`                                                                                                       | Closes a run with a pointer to the one that took over; re-pins a run to the repo's profile now                                                                                                                                                                              |
| `catherd pause --machine\|--workspace <id> "<reason>"`, `catherd resume --machine\|--workspace <id>`                                                                   | Pauses every run on the machine (or in a workspace) on one blocker; dispatch is refused until resume                                                                                                                                                                        |
| `catherd lock [--slots N] [--role verifier [--run <id>]] -- <cmd>`                                                                                                     | Runs a heavy command behind the machine-wide semaphore, in its own session (no /dev/tty); `--role verifier` keeps two runs' verifiers apart                                                                                                                                 |
| `catherd run-file read\|write <run> <path>`                                                                                                                            | A run's plan, lanes and notes (`write` reads stdin); in a role, its own run only                                                                                                                                                                                            |
| `catherd gate check <run> [--item <i> --command <c> --paths <p,…>] [--milestone <M>]`, `catherd gate pass <run> --item <i> --command <c> --paths <p,…> --evidence <e>` | A verifier's gate evidence, as `gate_check`/`gate_pass`; in a role, its own run only                                                                                                                                                                                        |
| `catherd gate run <run> --milestone <M> [--command <c>] [--at <base checkout>] [--force]`                                                                              | A verifier's milestone check, run by catherd on the committed HEAD, detached: failures the base already has do not block, a new failure is rerun once, and `land` needs its record                                                                                          |
| `catherd answer <run> <unit> <text>`                                                                                                                                   | Answers a parked unit from the terminal, as the `answer` tool does; the daemon picks it up                                                                                                                                                                                  |
| `catherd mcp`                                                                                                                                                          | The MCP server on stdio; the plugin starts it, you never need to                                                                                                                                                                                                            |
| `catherd capture-fixtures [--backend <b>] [--out <dir>]`                                                                                                               | Contributors: records sanitized test fixtures from real runs (see CONTRIBUTING.md)                                                                                                                                                                                          |
| `catherd scorecard prepare <task>`, `record <dir> --label <l>`, `compare <label>`                                                                                      | Contributors: measures a catherd version on four fixed tasks against the 1.5.0 baseline (docs/dev/scorecard.md)                                                                                                                                                             |

A profile command without a profile name (`show`, `set`, `diff`, `validate`), like the MCP profile tools, acts
on the profile the repo you are in runs on: the one bound to it, else the active one. Pass `repo` explicitly to MCP tools; profile CLI commands accept `--host` for effective defaults. Run them as
`bunx catherd-cli <command>` when catherd is not installed globally. Every read command takes `--json`; a bare `catherd runs` is `catherd runs list`. Exit codes: 0 ok, 1 error, 2 usage, 3 not ready, 130 interrupted; an error prints
`error E_CODE: message` and a `fix:` line. `--verbose` (or `CATHERD_LOG=debug`) logs more to
`~/.local/share/catherd/logs/`, kept for 7 days with secrets redacted. `doctor` and `init` take `--plain` for ASCII glyphs. `NO_COLOR` drops colour, never glyphs.

The catalog reads one source: the [Slopalytics](https://slopalyticsproxy.vercel.app) index, one `intelligence`
number per model and effort. It is fetched hourly (the MCP server does it in the background when a host session
starts, `init` does it, and `catherd catalog sync [--force]` does it on demand) and
cached in `~/.local/share/catherd/slopalytics.json`; a fetch that fails keeps the last good index and `doctor`
names the error. A model and effort the index does not list is not offered: it is absent from the catalog and
`catherd catalog list`, and a profile that names one fails `profile validate`. `CATHERD_NO_SYNC=1` stops the automatic
refreshes.

### The decision model

A decision model is called before every dispatch and judge. It reads the exact brief of that role and chooses one of
N levels, where N is the number of rungs the role has. In a fix round the failed rung is the floor, and twice on
one rung moves the floor up. It is not optional: a run refuses to start without `decision.url` and `decision.model`
(`E_DECISION_UNSET`), or when the probe fails (`E_DECISION_PROBE`); `catherd doctor` checks both.

```sh
catherd profile set decision.url https://<your-gateway>/v1
catherd profile set decision.model <model>
export CATHERD_DECISION_KEY=<key>   # or let `catherd init` save it
```

`decision.minConfidence` (default 0.8) is the least probability the pick may have. If the model gives no answer, the
call is retried three times, a minute apart, and then the unit parks for the coordinator. Every decision is a
`decision.made` event in the run's log with the levels, the pick, its probability and why, and the panel shows it on the role's
Decision tab.

A brief has four parts: the role contract, the run facts, the unit context (capped at about 20 KB) and this round.
Findings in it are capped at 2 KB each, and a resumed fix round sends this round only. The verifier prints
`RAN: <cmd> — exit <n> — <log>` for each command it runs; a check that is missing or marked NOT RUN is a FAIL.
Every stop and failed check gets a failure class, `product` or `harness`, and a harness failure gets one repair
dispatch outside the round count.

A lane's Owns is a hint for scheduling, not a wall: a worker changes whatever its task needs and reports each file
outside its Owns on an `EXTRA:` line with its reason, which the reviewer reads. There is no test guard and no
`out_of_scope` stop. A stop that names a running sibling's file waits for that sibling, then its fast check decides.
Lanes talk through a team channel: `catherd team send|read|wait` and the same tools on the role server. Messages
between lanes are queued and reach the target in its next brief; the architect's and the owner's messages steer a
running opencode lane at once. The architect may add, change, split or drop tasks, lanes and milestones mid-run with
no re-approval; the owner approves an architect-written plan once, before any code. A red milestone Check gives the
fix round at most five findings per item. A milestone tree's submodules borrow objects from the main checkout
(`--reference --dissociate`), so a fresh tree does not clone them again from the remote.

Tool output is clamped per harness: `claude-code` roles get `BASH_MAX_OUTPUT_LENGTH`, `codex` roles get
`tool_output_token_limit`, and `opencode` roles get a scratch `TMPDIR`. `opencode` has no output clamp.
Roles run with `HONCHO_ENABLED=false`.

`catherd profile set maxEffort.codex:gpt-6.1-sol xhigh` caps a model's effort for every route and failover; the
default profile ships Opus 5.5 and Sonnet 5.5 at high and GPT-6.1 Sol at xhigh (`null` removes one). A coding worker
never runs below medium effort, whatever the budget. Every failover is a `failover` row in the run's `routes.jsonl`.

Run data lives in `~/.local/share/catherd/`, config in `~/.config/catherd/` (both follow
`XDG_*`).

### A milestone per branch

Start a run with `base` (a branch on origin, such as `main`) and each milestone becomes its own branch and git
worktree, made from `origin/<base>` under the run's folder (`trees/<milestone>`) and set up once with the `Setup:`
line the plan carries under its `#` title. Every role of the milestone works in that tree. Milestones whose `After:`
milestones are merged run side by side, a new one starting only while the machine has the memory for it: it counts
what is free (on macOS through `kern.memorystatus_level`, since `os.freemem()` reads almost nothing there), less a
reserve, and starts one more only when a milestone's share still fits above a floor. The defaults are 2 GB of
reserve and 3 GB per milestone and floor; set them per profile with `catherd profile set limits.memory.reserveMb
<MB>` (or `perMilestoneMb`, `floorMb`). A landed milestone asks you to push its branch and merge its merge request;
answer `push` and catherd pushes the branch and prints the command that opens the MR. catherd never opens an MR and
never merges; once you answer that it is merged (or origin's base holds it), a clean worktree is removed. With
`catherd profile set land.autoMerge true`, a base run started afterwards merges each landed milestone into the base
itself: a `--no-ff` merge commit whose subject is `chore: merge <run> <milestone> <title>` (the run id without its
date prefix), pushed without force. Any git failure (a conflict, a hook, a rejected push) falls back to the push
question, which says why. A run without `base` works in the repo, one milestone at a time.

A plan line `Format: <command>` (in a milestone's section, else the preamble) runs that command on the milestone's
staged owned files before each milestone commit. A pre-commit hook that refuses the commit becomes a fix round; a
second refusal in the same round parks the milestone. A land or verifier park answered with a fix starts a fix round;
`retry` runs it again, and `accept` waives it.

### Coordinating several repositories

A workspace can be a plain directory containing independent Git repositories. Declare its members explicitly
in `catherd.workspace.json`; catherd does not scan neighboring folders:

```json
{
  "schema": 1,
  "repos": { "api": "./api", "web": "./web" }
}
```

Run `catherd workspace inspect /path/to/workspace --json` to check the resolved members, and
`catherd workspace status <id> --json` for a workspace run's children, dependencies and spending. The workspace
tools (`workspace_start`, `workspace_child_start`, …) are not on the session in 2.0: the daemon runs single-repo
runs, and a coordinated program is a later plan. The read-only commands, the stored runs and the `pause --workspace`
switch stay.

### Environment variables

| Variable                    | What it does                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `CATHERD_DECISION_KEY`      | The decision model's key, instead of the one `catherd init` saves                                                             |
| `CATHERD_NO_SYNC`           | `1`: no automatic fetch of the Slopalytics index (at MCP server start, in `init` and at run start); `catalog sync` still runs |
| `CATHERD_HOME`              | Puts config and data under `$CATHERD_HOME/config` and `$CATHERD_HOME/data` instead of XDG                                     |
| `CATHERD_LOG`               | Log level: `off`, `error`, `warn`, `info` (default) or `debug` (what `--verbose` sets)                                        |
| `CATHERD_LOCK_SLOTS`        | `catherd lock`'s slot count when `--slots` is not given (before the profile's `lock.heavy`)                                   |
| `CATHERD_CLAUDE_AGENTS_DIR` | Where catherd links its Claude agents (default: `$CLAUDE_CONFIG_DIR/agents`, else `~/.claude/agents`)                         |
| `NO_COLOR`                  | Drops colour (`--help`'s; piped `--help` has none either)                                                                     |

For development only: `CATHERD_LIVE=1` enables the live tests (CONTRIBUTING.md has the rest). `CATHERD_PANEL_DIST`
points `catherd panel` at another build of the panel than the one the package ships.

### The panel

`catherd` (or `catherd panel`) serves the panel on `127.0.0.1` (port 4317; `--port 0` takes any free one) and opens
your browser on it. It prints `catherd panel: http://127.0.0.1:<port>/login#token=<token>` and keeps running until
Ctrl-C; `--no-open` prints the link without opening it. The token is new each start and travels in the link's
fragment, so no request or log carries it; the login page reads it, clears it from the address bar and signs you
in. A restart signs every tab out. The panel answers only to `127.0.0.1` and `localhost`, and refuses a write or a
socket from another origin.

- **Dashboard** (the first page): every run on the machine, from every repo. A stat sheet gives the runs, the
  ones that finished alone, the median time, the interventions, the cost and the tokens, for the last 7 or 30 days.
  Below it are the runs that are live now, the questions that wait for you, the cost and tokens per day by backend,
  the tokens by model, the time by role, the recoveries (failovers) and the recent runs. Each tile has a
  one-line note that tells you what it shows.
- **Runs**: every run, with its status, models, time, tokens and cost. Open a run to see it as a graph. The graph
  starts at the plan and goes through every step of every milestone: route, preflight, each lane, its checks, the
  commit, the review, the verify, integrate and land, then the judge and the report. Each milestone is a box, the
  edges show the path the run took, and the running step pulses. A stat sheet above the graph gives the status,
  the time, the tokens, the cost and the rounds. The plan, the report, the milestones, the models and the timeline
  are below it. The page updates live over the run socket.
- **The node drawer**: click a node to open it. Overview gives the model, the effort, the times, the tokens, the
  cost and why that model ran. Prompt shows the brief's sections. Log shows the role's stream as a readable
  transcript, or the raw lines. Output shows the reply. Changes shows the diff, and Checks shows the check logs.
  A node that waits for you takes the answer in the drawer.
- **Pause, resume and cancel**: **Pause** stops a run from starting new steps: no new role or judge, and no
  landing, push or merge. Live roles finish their work, and their checks and commits still run; no new worktree is
  claimed and no waiting milestone is routed. **Resume** starts the held steps again. **Cancel role** stops one live
  role, and **Cancel run** stops the whole run. Each cancel asks first. A run starts from your session, never from the panel.
- **Questions**: each question that waits, with its run, unit and role, the reason, and the latest reply of the
  role that asked. A one-click answer sends a common reply at once. For your own words, Cmd/Ctrl+Enter sends the
  answer. The unit then runs again. Answered questions move to "Recently answered".
- **Setup**: the repo selector picks the repo to edit, or the global default. The roles overview lists each role
  with the models it tries, its access and an on switch. Click a role to open its drawer. There you order its
  models (the first one runs, and the next one runs if it fails), set its access (read only, workspace or full)
  and set its limits. The settings tile edits every other profile setting. Each change shows a before/after
  preview, and nothing is saved until you click **Save**. The backends tile shows each backend's status and fix.
  A slow probe shows as "checking" until it answers, and **Re-check** probes again.
- **The host question**: if catherd cannot tell which app runs it (Claude Code or Codex), Setup asks once and
  stays read-only until you choose. catherd never guesses.

`catherd watch` prints the live runs as text.

## Upgrading

From 1.5: `bun add -g catherd-cli@latest && catherd doctor`, then `claude plugin marketplace update catherd && claude
plugin update catherd@catherd` and a new session. A run started on 1.5 finishes on 1.5, so keep it installed until
those end; new runs go through the daemon. The session has six tools (`run_start`, `status`, `answer`, `cancel`,
`result`, `profile`), every role runs headless, and a parked question goes to `notify.url`. `catherd` opens the
browser panel in place of the TUI. The catalog reads one source, the Slopalytics index, so a profile rung it does
not list must be picked again (`catherd catalog list --role <role>`). Grok Build and Antigravity are gone.
[MIGRATION.md](MIGRATION.md), "From 1.5 to 2.0", has the rest.

From 1.4: `bun add -g catherd-cli@latest && catherd doctor`, update the plugin and start a new session; `doctor`
names the Claude agent links to refresh. There is still no `wait` tool (it never shipped and is gone): end the
turn, and on Codex run the coordinator inside `tmux`. A role calling a coordinator tool now gets `E_ROLE_SCOPE`,
knowledge is keyed by the git origin, and `route` returns seven keys with the rest in `routes.jsonl`.
[MIGRATION.md](MIGRATION.md), "From 1.4 to 1.5", has the rest.

From 1.0: install 1.1 and run its `init` (`bun add -g catherd-cli@latest && catherd init`, or
`bunx catherd-cli@latest init`; 1.0's own `catherd init` does not upgrade), update the plugin
(`claude plugin marketplace update catherd && claude plugin update catherd@catherd`) and start a new Claude Code
session. `wait` is gone: results arrive as messages, `peek` shows a run, `result` reads a record. A profile saved
by 1.0 keeps its failover map; `catherd profile validate` says what to change. The details are in
[MIGRATION.md](MIGRATION.md).

### From 0.x

1.0 is a clean break: run `bunx catherd-cli init` once. It moves your 0.x `config.json`, `projects.json` and
profiles into a `0.x-backup-<time>/` folder next to them (it never reads or deletes them), writes the 1.0
default profile, replaces the 0.x Claude agent links with 1.0 ones and keeps your saved key; 0.x run
folders stay where they are, unread. Then update the plugin
(`claude plugin marketplace update catherd && claude plugin update catherd@catherd`) and start a new Claude
Code session. The details are in [MIGRATION.md](MIGRATION.md).

## Docs

| Where                                                                                              | What                                                                  |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [MIGRATION.md](MIGRATION.md)                                                                       | Upgrading from each release to the next, and from 0.x                 |
| [CHANGELOG.md](CHANGELOG.md)                                                                       | Releases                                                              |
| [CONTRIBUTING.md](CONTRIBUTING.md)                                                                 | Development setup, the checks, commits, changesets, live tests        |
| [SECURITY.md](SECURITY.md)                                                                         | Reporting a vulnerability; what catherd stores and how                |
| [`docs/specs/2026-10-12-catherd-2.0-design.md`](docs/specs/2026-10-12-catherd-2.0-design.md)       | The 2.0 design (binding where it differs from the earlier ones)       |
| [`docs/specs/2026-10-02-catherd-1.5-design.md`](docs/specs/2026-10-02-catherd-1.5-design.md)       | The 1.5 design (binding where it differs from the earlier ones)       |
| [`docs/specs/2026-09-28-catherd-1.1-design.md`](docs/specs/2026-09-28-catherd-1.1-design.md)       | The 1.1 design (binding; builds on 1.0's)                             |
| [`docs/specs/2026-09-25-catherd-1.0-design.md`](docs/specs/2026-09-25-catherd-1.0-design.md)       | The 1.0 design                                                        |
| [`docs/dev/`](docs/dev/)                                                                           | Maintainer docs: live verification, manual tests, dependencies, ideas |
| [`docs/dev/live-verification.md`](docs/dev/live-verification.md)                                   | What CI cannot run: live tests, fixture capture, the Codex sandbox    |
| [`docs/plans/`](docs/plans/), [`docs/handoff/`](docs/handoff/), [`docs/research/`](docs/research/) | How 1.0 was designed and built: plans, reviews, research              |
| [`docs/archive/0.x/`](docs/archive/0.x/)                                                           | The 0.x design and plans, for history                                 |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). CI runs the checks a change can break on every pull request, on Linux with the latest Bun (macOS and the coverage floor nightly);
live verification is in [`docs/dev/live-verification.md`](docs/dev/live-verification.md). Report security issues
privately, as [SECURITY.md](SECURITY.md) describes. Everyone taking part follows the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

MIT
