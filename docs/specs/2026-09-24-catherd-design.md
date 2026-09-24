# catherd — design

Date: 2026-09-24. Status: approved in conversation, awaiting written review.

catherd herds coding agents. It turns a request into an autopilot build inside the user's own Claude Code session. Claude plans and verifies; Codex and opencode workers write the code; Jev decides which model and effort each piece of work gets. It ships as one npm package that is also a Claude Code plugin marketplace.

It productizes a workflow that ran for real on 2026-09-23/24 as the `codex-orchestration` skill: 42 Codex runs, 14 parallel lanes, one user message mid-run. The numbers and lessons below come from those runs.

## 1. Goals

In order, when they conflict:

1. **Autopilot.** A multi-milestone project finishes without the user.
2. **Speed.** Parallel lanes, the lowest model that can do each piece, no idle waits.
3. **Cost.** Subscription models before metered ones, cheap rungs before expensive ones.
4. **Quality.** Independent review and verification on every milestone.

**Non-goals for v1:** a headless mode, Windows, user-defined roles, backends other than Codex and opencode, automatic catalog tuning from past runs, a web dashboard.

## 2. Principles

- **The orchestrator is the user's own session.** It runs in Claude Desktop (Code tab) on the user's main model, with their plugins, hooks and memory beside it. catherd never launches a stripped or headless orchestrator. A user's customizations are part of how they decide, and the orchestrator decides.
- **Claude models run natively.** A role on a Claude model is a real Claude Code subagent from an agent file, never a Claude call through the MCP server.
- **Codex and opencode run through the MCP server.** The server owns their CLIs, parses their event streams and records every run.
- **Each model runs in its own vendor's harness, exactly as the user configured it.** Codex keeps the user's config, hooks, MCP servers, skills and `AGENTS.md`; opencode keeps its providers, agents and plugins. catherd never isolates a harness, and never funnels every model through one generic harness behind a router, which is what everyone else does. The vendor harness, with the user's customizations, is the experience catherd exists to keep.
- **Jev judges, code counts, checks prove.** Jev answers qualitative questions with calibrated confidence. Deterministic code turns those answers and the catalog's numbers into a model and an effort. Only a check, the reviewer or the verifier decides that work is done.
- **The orchestrator never edits product files.** Every line comes from a role.

## 3. Shape

One repository, `github.com/47vigen/catherd`, MIT. One npm package, `catherd`, with one binary:

| Command | What it does |
|---|---|
| `catherd` | The TUI: profiles and the role × model × effort matrix |
| `catherd init` | First-run wizard (§8.1) |
| `catherd mcp` | The MCP server over stdio (§7) |
| `catherd watch` | Live view of running and recent runs |
| `catherd lock -- <cmd>` | Runs a heavy command behind a machine-wide semaphore (§9) |
| `catherd catalog refresh` | Refreshes the local models.dev snapshot (§5) |
| `catherd wait <job>` | Only if spike S1 fails: blocks until a dispatched job ends (§7) |

The repository root is also a Claude Code plugin marketplace (`.claude-plugin/marketplace.json`) holding one plugin, `catherd`:

```
plugin/
  .claude-plugin/plugin.json
  .mcp.json              # { "catherd": { "command": "npx", "args": ["-y", "catherd@<version>", "mcp"] } }
  skills/catherd/        # the orchestrator skill (§10)
  skills/catherd-setup/  # the conversational setup skill (§11)
  commands/catherd.md    # /catherd <task>
  commands/catherd-setup.md
```

The plugin pins the package version it was released with, so the skill text and the server it calls always match.

**Stack:** the newest, fastest tools, with Rust-based ones first, all at their latest versions and never pinned:
- pnpm, TypeScript 7 (the native compiler), tsdown (Rolldown) and vitest;
- oxlint and oxfmt;
- lefthook with commitlint, and Changesets with npm trusted publishing.

For every job, the first choice is a maintained package; catherd hand-writes only what no package covers. Every dependency is listed with its reason in `docs/dependencies.md`. The runtime set:
- citty (CLI), execa (processes), xdg-basedir (paths), proper-lockfile (lock), tinyglobby (file walks);
- ofetch (HTTP with retries), zod (schemas);
- the official MCP TypeScript SDK;
- Ink (TUI), unless OpenTUI runs on Node.

**Platforms:** macOS and Linux.

## 4. Roles

Fixed in v1. A profile can disable any role except the worker.

| Role | Job | Needs (capability) | Sandbox (Codex) |
|---|---|---|---|
| architect | Decisions, milestones, lane files. No code. | tool use, long context | read-only + writes to the run folder |
| verifier | Independent PASS/FAIL of a milestone, by running it | tool use | full access (runs the stack) |
| worker | One lane: its code and its tests | tool use | workspace-write |
| reviewer | Findings on a milestone's diff | tool use | read-only |
| ui-reviewer | Findings on the changed screens, from screenshots | tool use, **image input** | full access (browser) |
| artist | Images a screen needs | **image output** | workspace-write |
| writer | Docs, changelog, MR body | tool use | workspace-write |
| researcher | The dossier, or one factual question | tool use | read-only |

A role may be assigned any model whose catalog capabilities cover the role's needs. The TUI and the setup skill never offer the others. In practice this makes the artist Codex-only, and removes every model without image input from the ui-reviewer, which is 164 of the 385 OpenRouter models in models.dev today.

## 5. Catalog

`catalog/catalog.json`, shipped and versioned with the package. It has three parts.

**Capabilities** come from models.dev (`https://models.dev/api.json`), the database opencode itself uses: 8,173 models from 223 providers, each with input and output modalities, tool-call and reasoning support, context and output limits, and cost. `catherd` snapshots the fields it needs at build time, and `catherd catalog refresh` updates the local copy. Codex models are added by hand, because models.dev does not list the ChatGPT-login ids (`gpt-6-sol`, `gpt-6-luna`).

**Scores** exist for a curated set of `model#effort` entries only. Each entry holds:
- `repo_code`: resolving real issues in a repository (DeepSWE-style);
- `terminal`: terminal, ops and environment work (Terminal-Bench-style);
- `honesty`: how reliably it reports a broken tool or a failed step (system-card disclosure rates);
- `secs_per_task`: median time per task;
- `cost_rank`: an integer order of what one run costs the user, lowest first. Subscription quota counts: a ChatGPT-plan model ranks below a metered OpenRouter model of similar strength, and Claude models rank by the Claude quota they spend.

The seed set, from the published per-effort benchmarks (sources recorded in the file):

| model#effort | repo_code | terminal | secs_per_task |
|---|---|---|---|
| gpt-6-luna#high | 59.3 | 4.5 | 563 |
| gpt-6-sol#medium | 56.6 | 18.7 | 264 |
| gpt-6-sol#high | 65.3 | 26.3 | 391 |
| gpt-6-sol#xhigh | 66.6 | 30.3 | 496 |
| claude-opus-5-5#low | — | 31.3 | — |
| claude-opus-5-5#medium | — | 52.5 | — |
| claude-opus-5-5#high | — | 56.6 | — |

`luna#xhigh` and `luna#max` are deliberately absent: `xhigh` was dominated, and `max` took 958 s a task, which is worse on speed than `sol#xhigh` at an equal score.

**Bars** give, for each work kind × difficulty, the minimum on each score dimension that a candidate must clear. For example, `repo_code/logic` requires `terminal ≥ 15` as well as a `repo_code` floor. That extra floor is what keeps a model with a strong repo score but a weak terminal score, like Luna, off logic lanes. The seed bars must reproduce the ladder that was approved on 2026-09-24 (§6.3), and a unit test pins it.

**User overrides** live in `~/.config/catherd/catalog.override.json`. A user may change any score or bar, and may enable an **unscored** model only by declaring it "treat like `<scored model#effort>`". The router then uses that entry's scores. The router never places an unscored model by guesswork.

## 6. Routing

### 6.1 Jev

Jev (TypeSafe, `POST https://api.typesafe.ai/v1/systemone`) answers typed questions with calibrated probabilities in about three seconds, at $42 per billion input tokens. Its output is free.
- The model is pinned per catherd release (`jev-1.13.0` today).
- The key is **required**. `catherd init` refuses to finish without a key that answers a live test question.
- The key lives in `~/.config/catherd/credentials.json` (mode 600), or in `TYPESAFE_API_KEY`. It never appears in argv, logs, briefs or run folders.
- Retries 429, 529 and 5xx up to three times with backoff.
- Every call appends a line to the run's `jev.jsonl`: the question, the answer, the confidence, the probabilities, the value used, and why.
- **Mid-run outage:** the run continues on the profile defaults (§6.3), and the report lists every fallback. A key is required to start a run, but Jev is never a single point of failure during one.

Jev is weak on numbers, long state and non-English text, so catherd only ever asks it short English qualitative questions. A spike on 2026-09-24 settled this. Jev was given a real score table under neutral names, and two models' numbers were then swapped. Its picks did follow the numbers, but at confidence 0.14–0.52, never reaching the 0.75 threshold. Its qualitative answers on the same lanes came back at 0.93–1.0.

### 6.2 Questions

| Question | When | Choices | Threshold | Default |
|---|---|---|---|---|
| `kind` + `difficulty` (one call) | Each lane, before its first dispatch | kind: `repo_code`, `terminal`, `ui`, `prose`, `research`; difficulty: `copy`, `build`, `logic`, `hard` | 0.75 each | the profile's default rung |
| `finding` | A review finding that may be the plan's fault | `design`, `code`, `unclear` | 0.75 | `code` |
| `same-defect` | A finding that returns after its fix round | `yes`, `no` | 0.70 | `no` |

The question texts and criteria are fixed in code and versioned with the Jev pin.

### 6.3 Selecting the rung

Given the lane's kind and difficulty, the router:

1. takes every `model#effort` the profile enables for the role;
2. keeps those whose catalog capabilities cover the role;
3. keeps those whose scores clear the bar for that kind × difficulty;
4. orders the rest by the profile's `objective`: `cost` (cost_rank, then secs_per_task) or `speed` (the reverse). The default is `cost`;
5. returns the first. That entry is rung 1, and the rest of the ordered list is the ladder above it.

When Jev is below the threshold or unavailable, rung 1 is the profile's `defaultRung` for the role (`gpt-6-sol#medium` in the default profile), and the ladder is every enabled entry above it.

The default profile must yield the approved ladder:
- **Track A**, `copy` or `build` work with a clear fast check: `luna#high → sol#medium → sol#high → sol#xhigh`;
- **Track B**, `logic` or `hard` work, or `terminal` work: `sol#medium → sol#high → sol#xhigh`.

### 6.4 Climbing

A lane climbs one rung, onto a **fresh thread** whose brief is the lane file plus the path of the failing evidence, when any of these happens:
- the orchestrator's own run of the lane's fast check fails twice;
- the reviewer reports a BLOCKER on the lane;
- Jev calls a returning finding `same-defect: yes`;
- the reply's last line is `STATUS: refused` or `STATUS: blocked`;
- the run exits 0 while the lane's owned files are unchanged. That is a refusal, whatever the reply says.

A failure on the top rung goes to the architect when Jev calls it `design`, and otherwise into the report as open. These rules are fixed, not configurable, so runs stay comparable.

## 7. MCP server

`catherd mcp` over stdio. Long tools stream progress notifications at least once a minute, so a quiet Codex run never trips an idle timeout.

| Tool | Returns | Notes |
|---|---|---|
| `run_start(repo, title, a_lines)` | run id, run folder | Creates the run folder and `state.md` |
| `route(run, lane_file)` | rung 1 and the ladder, with the Jev answer | §6 |
| `dispatch(run, role, name, brief_path, rung, thread?)` | the RESULT record when the role finishes | Codex or opencode only. It blocks until the role finishes, and Claude Desktop auto-backgrounds it after two minutes and wakes the orchestrator with the result |
| `climb(run, lane, reason)` | the next rung, or `top` | Records the reason |
| `ask(run, question, state)` | the answer, the confidence, and the value used | `finding` and `same-defect` |
| `status(run?)` | one screen: state tail, live roles with age, totals, Jev fallbacks | What the user asks for mid-run |
| `result(run, name)` | the reply, capped, plus the RESULT record | |
| `catalog_query(filter)` | models with their capabilities and scores | Used by the setup skill |
| `profile_get(name?)` / `profile_set(name, patch)` / `profile_validate(name)` | the profile, a diff, or errors | `profile_set` regenerates the Claude agent files (§8.3) |
| `runs_summary(filter)` | per role and rung: runs, climbs, time, tokens | Used by the setup skill and the report |

**The RESULT record** holds: role, name, backend, `model#effort`, thread, status (`ok`, `failed`, `limit`, `cli-too-old`), seconds, input, cached and output tokens, cost when metered, the owned files that changed, the reply's STATUS line, and a `thread_heavy` flag at more than 8M input tokens. `failed` comes only from a `turn.failed` event, or from a non-zero exit with no reply, never from a transient error event such as a reconnect (a bug in `cx.sh` on 2026-09-24).

**Spike S1 gates this design.** One `dispatch` has to run for 40 minutes with progress notifications inside Claude Desktop, then background and wake the orchestrator. The documented facts: MCP calls in the main thread auto-background after two minutes (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`), stdio servers have a 30-minute idle timeout, and subagent calls never background. If S1 fails, `dispatch` returns at once with a job id. The orchestrator then runs `catherd wait <job>` through Bash with `run_in_background`, the proven wake-up path, and the rest of the design stands.

### 7.1 Runners

**Codex**, from what the 2026-09-23/24 runs verified:
- `codex exec -m <model> -c model_reasoning_effort=<e> --json -o <reply> -s <sandbox> -`, with the brief on stdin, in the user's own Codex home and config. Without stdin it waits forever.
- Resume is `codex exec resume … -c sandbox_mode=<sandbox> <thread> -`, since a resume otherwise falls back to read-only.
- Images from the built-in image tool land in `${CODEX_HOME:-~/.codex}/generated_images/<thread>/`, and the runner returns their paths.
- `not supported when using Codex with a ChatGPT account` → `cli-too-old`. A usage-limit message → `limit`, which pauses the run and pushes.

**opencode**, from the `using-opencode` skill and `ocrun.sh`:
- `opencode run` in the repo directory. `--agent explore --auto` is read-only mode.
- Killing the client does not stop the server session, so the runner interrupts it through `POST /api/session/:id/interrupt` on timeout or cancel.
- A benign tool error is not a failed run.
- The diff is the union of snapshot files across messages, which survives interrupts.
- Cost is per latest run.
- The provider is whatever the user configured in opencode (OpenRouter, opencode Go/Zen or others). catherd reads the model list from `opencode models`.

## 8. Profiles and Claude agents

### 8.1 `catherd init`

1. Asks for the Jev key and runs a live test question. Without a pass it stops.
2. Detects `codex` and `opencode`, with their versions and whether each is logged in. A backend that is not ready is shown greyed out, with the command that fixes it.
3. Shows the default profile as one matrix screen (§8.2). The user adjusts it, or presses Enter to accept.
4. Writes the profile, generates the Claude agent files, and prints the two plugin commands:
   `/plugin marketplace add 47vigen/catherd` and `/plugin install catherd@catherd`.
5. Tells the user that a new Claude Code session picks up the agents.

### 8.2 Profile

`~/.config/catherd/profiles/<name>.json`. The active profile is named in `~/.config/catherd/config.json`. A repository can be bound to a different profile in `~/.config/catherd/projects.json` (repo root → profile), so nothing is written into the repository.

```json
{
  "name": "default",
  "objective": "cost",
  "roles": {
    "architect":   { "enabled": true, "models": { "claude-opus-5-5": ["high"] } },
    "verifier":    { "enabled": true, "models": { "claude-opus-5-5": ["low"] } },
    "worker":      { "enabled": true, "defaultRung": "gpt-6-sol#medium",
                     "models": { "gpt-6-luna": ["high"], "gpt-6-sol": ["medium", "high", "xhigh"] } },
    "reviewer":    { "enabled": true, "models": { "gpt-6-sol": ["high"] } },
    "ui-reviewer": { "enabled": true, "models": { "gpt-6-sol": ["medium"] } },
    "artist":      { "enabled": true, "models": { "gpt-6-sol": ["medium"] } },
    "writer":      { "enabled": true, "models": { "gpt-6-luna": ["high"] } },
    "researcher":  { "enabled": true, "models": { "gpt-6-luna": ["high"] } }
  },
  "lock": { "heavy": "cpus/2" },
  "notify": ["milestone", "finish", "blocked"]
}
```

The TUI matrix is the two-level checkbox that the profile file mirrors. Each role row expands to its capable models, and each model to its efforts. A role with a single enabled entry is not routed: it simply runs on that entry.

### 8.3 Claude agent files

Claude Code reads a subagent's model and effort only from its agent file's frontmatter, and registers agent files at session start. A test on 2026-09-24 confirmed that the desktop app did not pick up new agent files mid-session.

So on every profile save, catherd writes one agent file per enabled Claude `(role, model, effort)` to `~/.config/catherd/agents/<profile>/catherd-<role>-<model>-<effort>.md`. It then symlinks each of those files into `~/.claude/agents/`, pruning links that belong to the previous profile. The router names the exact `subagent_type`, so nothing has to switch mid-run. The role prompts are the ones in `codex-orchestration/agents/`, generalized.

**Spike S2** checks two things in a fresh desktop session. First, whether retargeting the symlink of an already-registered agent changes its behavior live. If it does, a profile switch needs no new session. Second, whether a symlinked directory is scanned. If it is, one link replaces many.

### 8.4 How the TUI looks

The terminal is part of the product. It should make people smile, and still read as plain facts.

- **Mascot.** A three-line ASCII cat with a conductor's baton heads every screen, and the `catherd` wordmark beside it runs in a ginger-to-pink gradient. The cat's face follows the state it reports: `=^.^=` for all good, `=o.o=` for working, `=-.-=` for waiting on something, `=x.x=` for failed, and `=^ω^=` for a landed milestone.
- **Palette.** Warm: ginger, cream, charcoal, one pink accent. It uses true colour where the terminal has it and degrades to 256 or 16 colours, and it honours `NO_COLOR`.
- **Motion.** Spinners are cat frames (a flicking tail, kneading paws) paired with a rotating line of herding copy: "herding…", "counting whiskers…", "negotiating with Luna…". Motion never exceeds what reads calmly, stops under `--reduced-motion`, and never delays input. The `init` intro lasts under 1.5 s and a key skips it.
- **The matrix.** Role rows expand to their capable models, and each model to its efforts. A ticked box is a paw `🐾`, an empty one `○`. Arrows move, space toggles, Enter saves. A model that is not capable for a role never appears, and an unscored one carries a small `unscored` tag until it is given its "treat like".
- **`watch`.** One line per live role: `🐈 worker-M1.L2  sol#medium  04:12  =o.o=`. A climb animates one step up the ladder, with a line such as "Luna gave up, Sol takes over". Landed milestones stack below as `=^ω^= M1 landed · 38m · a1b2c3d`.
- **Every joke carries a fact.** Each status line still states the role, the rung, the time and the outcome. With `--plain`, or on a terminal without Unicode, every glyph has a text fallback.
- **Fit.** Every screen works at 80 columns.

Built with Ink and custom `ink-spinner` frames, plus a gradient helper. There is no heavier TUI framework.

## 9. Run folder and lock

Run data lives outside the repository, at `~/.local/share/catherd/<repo-slug>/<run-id>/`:

```
plan.md          # the architect's decisions, milestones and lanes
lanes/Mx.Ly.md   # one file per lane: the only plan a worker reads
ledger.md        # one appended row per landed piece
state.md         # rewritten at every transition; the last line is the next step
runs.jsonl       # one RESULT record per role run
jev.jsonl        # one line per Jev call
roles/<name>.{md,fix.md,out,jsonl,err}   # briefs and replies; earlier rounds kept as .r<k>.*
shots/           # ui-reviewer screenshots
```

`state.md` is written by the MCP server on every `dispatch`, `climb` and landing, not by the orchestrator. The 2026-09-24 polish run showed an orchestrator leaving it stale while four workers ran.

`catherd lock -- <cmd>` takes one of N slots, where N is the profile's `lock.heavy` (default: half the CPU cores). It uses lock files in `~/.local/share/catherd/locks/`, and a slot whose process has died is reclaimed. Worker briefs tell workers to wrap full builds and test suites in it.

## 10. The orchestrator skill

`skills/catherd/SKILL.md` is `codex-orchestration/SKILL.md` as it stands on 2026-09-24, generalized:
- the Bash calls to `cx.sh`, `jev.sh` and `status.sh` become MCP tool calls;
- the ladder and the Jev table come from the profile;
- the personal paths and names are gone.

The sequence is unchanged:
1. A-lines, with every product question asked up front.
2. The dossier from the researcher, then the architect, which writes `plan.md` and the lane files and returns a short summary. There is no dossier and no architect for a polish or fix run.
3. `route` per lane.
4. Per milestone:
   - lanes in parallel, at their rungs;
   - the writer;
   - one reviewer pass, plus a UI pass on the changed screens only, whose findings carry their screenshot paths;
   - one fix round, with climbs;
   - the verifier on a frozen tree, with the full check;
   - landing.
5. At the finish, the gate verifier in the foreground, with reviews, the MR body and one whole-app UI pass beside it.

It pushes (`PushNotification`) only when a milestone lands, when the run finishes, and when it is blocked on the user. Its reply limits, red flags and brief shapes carry over.

Triggers: `/catherd <task>` and English phrases ("orchestrate this with catherd"). Users add triggers in their own language to their own `CLAUDE.md`.

## 11. The setup skill

`skills/catherd-setup/SKILL.md` makes profile tuning a conversation with the user's own Claude. It is the conversation that produced the default profile, turned into a procedure:

1. **Learn the goals.** The user's order of speed, cost and quality; the subscriptions they hold (ChatGPT plan, Claude plan, OpenRouter credit); the kind of work they orchestrate. One question at a time, each with a recommended answer.
2. **Read the facts before proposing:**
   - `catalog_query` for what their installed backends can run, with the capabilities and scores;
   - `runs_summary` for how each rung has done on their own runs: climbs, time, refusals;
   - `profile_get` for where they stand now.
3. **Propose one decision at a time,** with a worked example and the tradeoff in their terms. For instance, "Luna high on build lanes: about 5 min slower than Sol medium, no Claude quota, climbs on 1 in 5 of your runs so far." The user steers, and the skill never re-argues a reversal.
4. **Write the profile through `profile_set`, and run `profile_validate`:**
   - every enabled role must have a capable model;
   - the worker's ladder must be non-empty for every kind;
   - no unscored model may be enabled without its "treat like".
5. **Say what applies when:** Codex and opencode changes apply to the next dispatch, and Claude agent changes apply to the next session, unless spike S2 proved otherwise.

It never edits files by hand. `profile_set` is the only writer, so the TUI and the conversation cannot drift apart.

## 12. Errors

| Condition | Behavior |
|---|---|
| Jev unreachable or below threshold | Profile default; logged; listed in the report |
| Transient Codex error event (reconnect) | Ignored; only `turn.failed` or no reply is `failed` |
| Usage limit on any backend | `limit`: pause the run, write `state.md`, push |
| CLI too old | `cli-too-old`, with the upgrade command |
| Exit 0, owned files unchanged | Refusal: climb |
| Orchestrator session dies | A new session resumes from `state.md`: `status` shows the run, the skill continues each role on its own thread |
| MCP server restarts mid-dispatch | Codex keeps running. On start, the server re-attaches to its live child processes from `runs.jsonl` (pid, reply path) and completes their records |
| A worker's lane shares a file with a running lane | `dispatch` refuses it; the owned files come from the lane file |

## 13. Observability

- `runs.jsonl` and `jev.jsonl` per run are the record. No other log is authoritative.
- `status` (MCP) and `catherd watch` (TUI) read only those files and the live process table. `watch` lists every run under the data directory, with its live roles, their age and rung, and its milestones landed.
- The final report sums time and tokens per backend and per rung, the climbs and their reasons, and the Jev decisions with the number that fell back.
- v1 records everything a later catalog tuner would need: kind, difficulty, rung, climbs, outcome. v1 does not tune.

## 14. Testing

- **Unit (vitest):**
  - router selection and the approved-ladder pin;
  - bars;
  - "treat like";
  - profile validation;
  - catalog merge with overrides;
  - Codex and opencode event parsing against recorded `.jsonl` fixtures from the 2026-09-23/24 runs, including the reconnect event that must not count as a failure;
  - the lock's slot and reclaim logic.
- **Fake backends:** stub `codex` and `opencode` executables on `PATH` that replay recorded event streams, with a configurable delay, exit code and file changes. They drive `dispatch` end to end without a model.
- **MCP contract:** each tool against the SDK's in-memory client.
- **Jev:** a recorded-response client for unit tests, plus one live smoke test, run only when `TYPESAFE_API_KEY` is set.
- **Spikes before the dependent code:** S1 (§7), S2 (§8.3), and S3: Codex's image tool invoked from a `dispatch`, with the image path returned.
- **Release gate:** `pnpm typecheck`, `pnpm test`, `pnpm lint`, plus one real orchestrated run on a small public sample repository before 1.0.

## 15. Build order

Each part gets its own implementation plan in `docs/plans/`.

1. **Core:** the runners, the RESULT record, the run folder, `state.md` writes, the lock. Spike S3 runs here.
2. **Routing:** the catalog with its models.dev snapshot, overrides, the Jev client and questions, selection, and climbing.
3. **MCP server and plugin:** the tools, the orchestrator skill, the setup skill, the commands, the marketplace. Spikes S1 and S2 run first.
4. **TUI:** `init`, the profile matrix, `watch`, and the agent-file generation shared with `profile_set`.

Then the migration: the first real project runs on catherd. Once it lands, `codex-orchestration` is retired in its favor. `opencode-orchestration` is left as it is.

## 16. Risks

- **S1 fails:** covered by the `catherd wait` fallback. The cost is one Bash call per dispatch.
- **Benchmarks go stale** as models ship monthly. The catalog is versioned data, not code; a release updates it; users override locally.
- **The Jev API changes or disappears.** The pin, the fallback-to-default path and the recorded client limit the blast radius. A key stays required for as long as Jev is available.
- **Claude Code changes how it registers agents.** Generation sits behind one module, which S2 re-verifies on each Claude Code minor release.
