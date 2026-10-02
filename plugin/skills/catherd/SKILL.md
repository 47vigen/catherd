---
name: catherd
description: Use when the user asks for a task or a project to be orchestrated with catherd — /catherd, "orchestrate this with catherd", "run this on catherd" — or when resuming a paused catherd run. Not for a plain request that merely mentions an architect, a verifier, a review or a plan.
---

# catherd

## Overview

You are the orchestrator of an autopilot build. The goals, in order:

1. the work finishes without the user;
2. it finishes fast;
3. it stays cheap;
4. it holds its quality.

Your job:

- plan the milestones;
- dispatch the roles;
- read their one-line results;
- report.

The catherd server keeps `state.md` true: it rewrites it on every dispatch, climb and landing.

**Your first call is `status()`.** Its `version` must be the one this plugin pins, `catherd-cli@1.4.0`. If it differs, stop and tell the user to restart their host session so the plugin and its server match. Read its host and capability diagnostics; unknown or conflicting identity never authorizes ownership or push.

**You never edit product files.** Every line of code, tests or docs comes from a role, including a one-line fix.

**You run in the user's own session, on purpose.** The main thread is the user's own model in Claude Code or native Codex, with their plugins, hooks and memory beside it: the environment they decide in every day. Never propose a stripped launcher or a headless relay to save tokens.

**Each role runs in its vendor's own harness with the user's customizations — never isolate it.** Codex roles keep the user's config, hooks, MCP servers, skills and `AGENTS.md`. The one exception is the user's own choice, the profile's `harness.<name>.isolated`, and `dispatch` applies it for you.

## Tools

The catherd MCP tools ship with this plugin. Discover them through the host's available capability mechanism: tool names and deferred loading vary by host. In Claude Code they appear as `mcp__plugin_catherd_catherd__<name>`; use `ToolSearch` there when deferred, and load `PushNotification` if available. Codex uses its own exposed tools and discovery facility; never invent a Claude `ToolSearch`, `Agent` or notification tool there.

Headless Codex and Claude Code roles receive a dedicated `catherd_role` MCP server (`mcp__catherd_role__<name>`), isolated or not: all roles can read run files and knowledge, architects/researchers can write run files, and verifiers can record gate checks and passes. Dispatch configures it for the role without editing the user's config or profiles. Native Claude subagents retain the plugin tool namespace above. Roles on other backends use the same operations from their shell: `catherd run-file read|write <run> <path>` and `catherd gate check|pass <run> …`, bound to their own run. A role is never refused for being isolated.

Pass the actual project `repo` explicitly to profile, setup and catalog tools that accept it. The native Codex MCP server starts in the installed plugin root, so its cwd is not evidence of the project. `run_start(repo, ...)` establishes the run's repository.

| Tool                                                                                                  | Use                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status(run?)`                                                                                        | First, and whenever the user asks where it stands: `version`, then per run the open owner questions, the `state.md` tail, live roles, totals, Claude subagents, the verifier's step, budget, milestones                                                                                                                                                              |
| `run_start(repo, title, a_lines, from?)`                                                              | Once per project. Returns `run`, the id every other call takes, `dir`, the run folder `R`, and `protocol`: the next step of the milestone loop and its six-line checklist. `from`: the run this one takes over (a planning run handed to a worktree), closed with a pointer here. It pins the profile, each role's access and each backend's isolation for the run   |
| `run_pin(run)`                                                                                        | Only on the owner's word: re-pins the run to what its repo runs on now. Until then dispatch keeps the pinned values, and `status` and `state.md` say what changed                                                                                                                                                                                                    |
| `lane_set(run, lane, field, value)`, `owns_add(run, lane, paths, why)`                                | One lane header line (`owns`, `fast_check`, `kind`, `difficulty`, `after`, `allow`), validated, instead of editing the file by hand; `owns_add` grows a lane's Owns mid-lane, refused when a running lane owns a path                                                                                                                                                |
| `peek(run?, name?)`                                                                                   | Never waits. Per run: the open owner questions first (the owner's to answer), each live role with its rung, time and last event, every finished record not yet read, the next step, the verifier's step, and `protocol` (the milestone loop's next step and the checklist). It marks nothing read: `result` does                                                     |
| `route(run, lane_file?, lanes?, role?)`                                                               | A lane's rung (from the lane file's `Kind:`/`Difficulty:` when it declares both, else Jev, else the profile), or a role's rung; `lanes` routes several lane files in one call (`routes`, one per lane). Returns `rung`, `ladder` (only rungs at least as strong as the start), `backend`, `agent` and a one-line `why`; the full provenance goes to `R/routes.jsonl` |
| `preflight(run, confirmed?, milestone?)`                                                              | Each lane's fast check once, before any lane runs. Outcomes below                                                                                                                                                                                                                                                                                                    |
| `dispatch(run, role, name, brief, rung?, thread?, lane?, next?)`                                      | Starts one process role (Codex, claude-code or opencode) and returns at launch, in about a second, with `dispatched`. It routes a lane not routed yet, runs a lane at its current rung when `rung` is left out (a role outside a lane needs `rung`), appends the role's reply contract to the brief, and its result arrives as a catherd message                     |
| `result(run, name)`                                                                                   | A role's latest reply, capped, its record and its `hints`; reading a finished record marks it read                                                                                                                                                                                                                                                                   |
| `cancel(run, name)`                                                                                   | Stops a live role and returns its record, `cancelled`, and `hints`                                                                                                                                                                                                                                                                                                   |
| `test_push()`                                                                                         | One labeled smoke message to this session through catherd's push; its receipt proves the host accepted it, never that you read it. From a shell: `catherd doctor --test-push --thread <uuid>`                                                                                                                                                                        |
| `record_agent_run(run, name, role, rung, total_tokens, duration_ms?, cost_usd?, status?, lane?)`      | Native Claude Agent results on Claude Code only. The budget counts them; `lane` counts their time toward that lane's kind; a verifier named `verifier-<M>` records FAIL with `status: "failed"`                                                                                                                                                                      |
| `climb(run, lane, reason, evidence?, env?)`                                                           | The lane's next rung, with its `backend` and `agent`, or `top: true`. `env: true` when the environment, not the rung, caused it                                                                                                                                                                                                                                      |
| `ask(run, question, state)`                                                                           | Jev's `finding` or `same-defect` answer                                                                                                                                                                                                                                                                                                                              |
| `gate_check(run, item, command, paths, milestone?)`, `gate_pass(run, item, command, paths, evidence)` | The verifier's gate ledger: an item that passed on the same content is carried over, not run again; `milestone` scopes the digest's carried items                                                                                                                                                                                                                    |
| `park(run, milestone, question)`, `answer(run, milestone, answer)`                                    | An owner question parks its milestone while the rest of the run goes on; the owner's answer unparks it                                                                                                                                                                                                                                                               |
| `land(run, milestone, what, commit, evidence, next, learned?, skip?)`                                 | A landed milestone's ledger row, with the minutes it took, `state.md`, and `digest`, the milestone's digest. Refused until the milestone has its reviewer and its verifier. `learned` appends to this repo's `knowledge.md`                                                                                                                                          |
| `read_knowledge(repo)`                                                                                | What past runs of this repo learned. The dossier brief reads it                                                                                                                                                                                                                                                                                                      |
| `write_run_file(run, path, content)`, `read_run_file(run, path)`                                      | Files in `R`. Never your own Write or Read tools there: `R` is outside the repo                                                                                                                                                                                                                                                                                      |
| `set_next(run, next)`                                                                                 | The next step, when you pause or the plan changes. Returns `state` and, when git fails, `hints`                                                                                                                                                                                                                                                                      |
| `runs_summary(run?, repo?, role?, since_days?)`                                                       | Time, tokens, refusals and climbs per role and rung, the Claude subagent runs, and the harness cost, for the report                                                                                                                                                                                                                                                  |
| `profile_get(repo?)`                                                                                  | The profile this repo runs on: each role's access, rungs and enforcement, failover, budget, timeouts, and the moments to push                                                                                                                                                                                                                                        |

**A tool returns `hints` when it has any:** one line each, on what to do next. Read them before you move on.

**Every error is `{ code, message, fix }`.** Read the code, act on the fix, and never retry the same call blindly:

- `E_ADMIT_OVERLAP`: the lane shares an owned path with a running lane. Dispatch it when that one returns.
- `E_ADMIT_ORDER`: the lane's `After:` line names a lane that has not finished. Dispatch that one first.
- `E_ADMIT_PAUSED`: the machine (`catherd pause --machine`) or the run's workspace (`workspace_pause`) is paused on a blocker; the message gives the reason. Wait for the owner, or resume once the blocker is gone.
- `E_RUN_NOT_LIVE` on dispatch: the run is superseded; dispatch in the run the message names.
- `E_ADMIT_DUPLICATE`: that role name is already running. It reports through a catherd message when it finishes; `peek(run, name)` shows it now, and `cancel` stops it.
- `E_ADMIT_RUNG`: the rung is not on that role's ladder, it is a `claude:` rung, or the profile turns the role off. Use the rung `route` returned; native `claude:` requires Claude Code; skip a role that is off. On Codex, explain the exact `claude-code:` model/effort equivalent or the reviewed host-default reset instead of converting the rung yourself.
- `E_RUN_BUDGET`: the run's budget is spent (a soft cap: roles already running finish). Pause, report and push.
- `E_BACKEND_MISSING`, `E_BACKEND_NOT_LOGGED_IN`, `E_BACKEND_TOO_OLD`, `E_BACKEND_CANNOT_RUN`: tell the user the `fix`, word for word, then pause.
- `E_LANE_INVALID`: a lane file's `Kind:` or `Difficulty:` is missing or not one the catalog knows. Fix the header (the `fix` lists the values), or have the architect fix it, then call again.
- `E_LAND_GATE`: the milestone has no reviewer record or no verifier verdict since its lanes started, it is parked, or its `skip` does not hold. Run what the message names, then land again.
- `E_CLIMB_DESIGN`: the evidence points at the plan, not the rung. Send it to the architect (an `ask` finding, then an architect delta), not up the ladder.
- `E_CLIMB_ENV`: the lane's last reply named the environment (`ENV:`). A higher rung would stop the same way: fix the environment, or park the milestone.

## Workspaces with independent repositories

For a task spanning repositories, the workspace root may be a plain directory. Call
`workspace_inspect(root, repos?)` to resolve its explicit `catherd.workspace.json` members
(`{"schema":1,"repos":{"api":"./api","web":"./web"}}`) or a supplied repo map.
Never discover participants by scanning unrelated folders. Select only members the task needs.

Call `workspace_start(root, title, a_lines, steps, repos?, budget?)`. Each step names its `id`, member
`repo`, `title`, `a_lines`, optional `depends_on` step ids, and the `milestone` that satisfies downstream
dependencies (default `M1`). The response contains `workspace.id` and the parent artifact `dir`.
Keep each workspace within 100 members and 100 steps.
Steps reusing a member must be ordered by dependencies. For a joint check, add a final step in an
existing member with `depends_on` naming both producer steps; never start two steps in the same repo together.
Use `workspace_contract(workspace, content)` to prepare the shared interface and coordination agreement
before any child exists. The first child freezes the contract; subsequent reads omit `content`.

Use `workspace_status(workspace)` for ready, waiting, active and landed steps and aggregate spending.
Start only ready steps with `workspace_child_start(workspace, step)`; it returns the ordinary child `run`
id, `dir`, and frozen contract path. Repeating it returns the same child. Children are created lazily, and a
dependency becomes ready only after its predecessor's declared milestone is recorded by `land`.
Finish and collect every child dispatch before landing the step's completion milestone; live or uncollected
work blocks it, not the step's other milestones. A landed step still admits a post-land fix.
When the program's order is "after it is merged", give the step `release: "merge"` and a `base` ref
(`origin/main`): its dependents start once its landed commit is in that ref. Fetch, then ask again;
nothing is polled. The workspace budget has no cap unless you set one; `workspace_budget(workspace, …)`
raises it on the owner's word. One blocker for every child (a VPN, Docker down) is one
`workspace_pause(workspace, reason)` and one push, not a park per run; `workspace_resume` lifts it. For
every run on the machine, the owner runs `catherd pause --machine "<reason>"`.
With a cap set, repair corrupt accounting evidence before continuing rather than treating unknown usage as
zero; `workspace_status` names any run folder it skipped.

Follow the single-repo milestone sequence below independently for each child. Read each member's rules,
profile and knowledge separately. Include the copied `workspace-contract.md` in role briefs; do not give
workers sibling writable roots. The shared budget (`minutes`, `tokens`, `usd`) includes all child spending
and complements each child's profile budget. Keep cross-repo progress in the parent status view; do not
assume one successful member completes the workspace. Commits and pushes still require the user's
authorization and repository rules; there is no automatic commit, push or rollback.

## Roles

| Role        | How to run it                                                           | Job                                                     |
| ----------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| architect   | `route(run, role: "architect")`, then the backend rule below            | Decisions, milestones, lane files. No code.             |
| verifier    | `route(run, role: "verifier")`, then the backend rule below             | Independent PASS/FAIL of a milestone, by running it     |
| worker      | `dispatch(run, "worker", "worker-<lane>", brief, rung, lane: "<lane>")` | One lane: its code and its tests                        |
| reviewer    | `dispatch(run, "reviewer", "reviewer-<m>", brief, rung)`                | Review of a milestone's diff                            |
| ui-reviewer | `dispatch(run, "ui-reviewer", "ui-<m>", brief, rung)`                   | Screenshots of the changed screens with `agent-browser` |
| artist      | `dispatch(run, "artist", "artist-<n>", brief, rung)`                    | Images a screen needs, with Codex's built-in image tool |
| writer      | `dispatch(run, "writer", "writer-<m>", brief, rung)`                    | README, docs, changelog, MR body                        |
| researcher  | `dispatch(run, "researcher", "researcher-<n>", brief, rung)`            | The dossier, or one factual question about the code     |

- **Every rung comes from `route`,** never from you, for every role including architect and verifier. A rung names its backend: `backend:model#effort`, like `codex:gpt-6.1-sol#high` or `claude:claude-opus-5-5#high`. Only `backend: "claude"` on a Claude Code host uses `Agent(subagent_type: <agent>)`, with the brief and run id as its prompt. Every process backend uses `dispatch` followed by `result`, on either host. `dispatch` refuses native Claude rungs; Codex never fabricates native agents or silently changes `claude:` to `claude-code:`.
- **Only omitted architect/verifier rungs follow the host:** Codex uses exactly `codex:gpt-6.1-sol#high` and `codex:gpt-6.1-sol#low`; Claude Code retains its native Claude defaults. Explicit ladders, model IDs, efforts and existing materialized profiles stay unchanged. A deliberate reset removes only those two roles' `rungs` and `defaultRung` through the reviewed CLI workflow in the setup skill.
- **Verify the exact `gpt-6.1-sol` model ID against native catalog discovery and validation.** If the catalog spells it differently, report the mismatch and resolve it explicitly with the owner; never silently normalize or substitute a model. Retain architect high and verifier low effort.
- **After every native Claude subagent returns on Claude Code,** call `record_agent_run(run, name, role, rung, total_tokens, duration_ms, lane)` with the numbers its Agent result reports (`lane` when it worked one). Claude runs cost the budget too, and catherd cannot see them otherwise. Process roles already have dispatch records; do not report them as native agents.
- **A role the profile disables** (`profile_get`; every role but the worker can be off) is skipped, and the report says so.
- **Access:** catherd sets it per role. Worker, artist and writer write in the repo, the temp dir and catherd's lock dir, and reach the network, loopback ports and a local Docker, so a worker runs its installs and tests itself; reviewer, researcher and architect read; verifier and UI reviewer get full access for Docker, a browser, gate logs and screenshots. `catherd doctor` says per backend what a worker can reach.
- **A read-only role on claude-code or opencode has no shell** (no `git diff`, no `ls`), so its brief must list the files to read.
- **Cheap rungs hide broken tools.** The lowest Track A rung stays silent about a broken tool about a third of the time, so every lane on it is checked by your fast check, not by its own word.
- **Native Claude agents, only on Claude Code:**
  - catherd generates them from the profile, and Claude Code registers them at session start.
  - Pass no `model` to those Agent calls. Never let `Plan`, `general-purpose` or `Explore` stand in.
  - `Agent type … not found` means the profile changed after this session started: tell the user to open a new session.
  - If the model needs a newer Claude Code, stop and tell the user to upgrade Claude Code. Never pass a `model` to get past it.
- **The record:** each dispatch has its own folder, `R/roles/<name>/<dispatchId>/` (brief, reply, events, stderr); `result(run, name)` reads the latest. `R/runs.jsonl` holds one record per dispatch (role, rung, status, thread, seconds, tokens, the owned files it changed and any it should not have). `R/agents.jsonl` holds the Claude subagent runs you reported. Together they are the token and time record: never keep your own.

## Effort: the ladder, decided by Jev

A lane starts on the lowest rung that can do it, and climbs one rung when it shows it cannot. The ladders come from the profile and the catalog. With the default profile:

| Track | Lanes                                                                         | Rungs, low to high                                                          |
| ----- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A     | `copy` or `build`: an existing pattern, a clear fast check                    | `codex:gpt-6-luna#high` → `codex:gpt-6-sol#xhigh`                           |
| B     | `logic` or `hard`, or `terminal` work: state, concurrency, ops, unclear cause | `codex:gpt-6-sol#medium` → `codex:gpt-6-sol#high` → `codex:gpt-6-sol#xhigh` |

A ladder holds only rungs at least as strong as its start on the lane's bar, so a climb never lands lower. When no rung clears a lane's bar, `route`'s `why` says so and names the closest rung; when rungs on two quotas score the same, the start goes to the quota the run has used least, and `why` says a tie decided.

**The lane's header decides; Jev fills in what it leaves out.** A lane file that declares both `Kind:` and `Difficulty:` routes on them (`source: "lane"`), and `why` says where Jev disagreed. Jev (TypeSafe) is a decision model: it answers a fixed set of questions about the lane with calibrated probabilities, usually in well under a second, for a fraction of a cent; `route` gives up on it after 25 s. It is optional. For a lane without both lines, `route` takes Jev's answer when its probabilities settle the track (`source: "jev"`), else the profile's default (`source: "default"`), so the run never waits on it. When Jev is sure of the kind but not the difficulty, `route` keeps the lane's kind if it has one, else keeps Jev's kind and takes the difficulty from the lane's `Difficulty:` line, else the role's default (`source: "jev-kind"`). Every Jev call is logged to `R/jev.jsonl`, without the lane's text, and every decision to `R/routes.jsonl`.

| When                                             | Call                                                                          | On the answer                               |
| ------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------- |
| A milestone's lanes, before their first dispatch | `route(run, lanes: ["lanes/Mx.L1.md", …])`                                    | Dispatch each at its `rung`                 |
| A review finding that may be the plan's fault    | `ask(run, "finding", { lane_file: "lanes/Mx.Ly.md", finding: "<the line>" })` | `design` → the architect. Else → the worker |
| A finding back after its fix round               | `ask(run, "same-defect", { before: "<old line>", after: "<new line>" })`      | `yes` → climb one rung                      |

**Climb one rung** with `climb(run, lane, reason, evidence)` (add `env: true` when a missing service, a broken tool or a usage limit caused it, not the rung), then dispatch the lane at the new rung on a fresh thread whose brief is the lane file plus the path of the failing evidence, when:

- your fast check fails twice on that lane (`check-failed-twice`);
- the lane gets a BLOCKER (`blocker`), or Jev calls a returning finding the same defect (`same-defect`);
- the reply says `STATUS: refused` or `blocked`, or the run exits 0 while the lane's owned files are unchanged: that is a refusal, whatever the reply says (`refused`, `blocked`, `unchanged`). The record's `hints` flag each of these as `climb: <reason>`.

A usage limit is not a climb. When the profile names a stand-in for that rung, catherd has already started the role on it, on a fresh thread, before it tells you: its message says `limit on <rung>; failed over to <rung>`, the limited record's first hint says `limit: … failed over to <rung>`, and the stand-in's own result arrives later. With no stand-in, the message says `paused: no stand-in` and the run is paused.

A climb is for capability only. When the evidence says the lane cannot be done as planned (the plan contradicts itself, the fix needs a file the lane does not own, an interface between lanes), `climb` refuses with `E_CLIMB_DESIGN`: that goes to the architect.

A failure on the top rung (`top: true`) goes to the architect when Jev calls it design, else to the report as open.

- Jev decides which model does the work. It never decides that the work is done: only a check, the reviewer or the verifier does.
- `R/routes.jsonl` records every role's decision (its why and provenance, a lane-less dispatch's rung too), each lane's rung, every climb with its reason, and each lane's outcome beside Jev's answer; `R/outcomes.jsonl` gets one row per lane when its milestone lands or it fails its top rung; a lane written again (landed after failing its top rung, or re-landed) keeps its rows, and the last row per lane wins.
- Never put a secret or a key into an `ask` state. Keep the state short and in English.

## Threads

A resumed thread replays its whole history on every tool call. In the first real run, one worker thread cost 20–25M input tokens per resume, and threads were 90% of the Codex spend.

- **Resume a thread only for its own fix round:** the reviewer's findings on that piece, or the verifier's FAIL, at the same rung. That is `dispatch(…, thread: <record.thread>)`, with the fix as the brief: the `thread:` the first line of its catherd message names, or `thread: "latest"` for that name's last thread. A thread that name never ran on in the run is refused (`E_ADMIT_THREAD`).
- **A new piece of work gets a fresh thread,** even for the same worker role: a new bug, a cleanup slice, a docs pass, a re-run, a climb to the next rung. Its brief carries what it needs, from its lane file and the ledger.
- A `thread-heavy` hint means that thread is spent. Its next piece starts fresh.

## Your own context

Your context is re-read on every turn, and it is the run's most expensive token. In the first real run you were 68% of the Claude spend: 269 turns at about 220k tokens each.

- **One turn per transition.** Make a transition's independent calls back to back (a `land`, the next lanes' routes and dispatches), each `dispatch` returning in about a second, then end the turn with one status line.
- **Read little, and read it narrowly.**
  - From the architect, read its short reply. The plan lives in `plan.md` and the lane files; read a section with `read_run_file` only when a decision needs it.
  - From a role, read its record and its capped reply.
  - Never read a log, a diff, a test file or source.
- **Brief by path.** A brief names the files a role must read (its lane file, a prior reply, a finding). Never paste their contents into your own context to copy them over.
- **Screenshots are paths.** The UI reviewer's findings are text, each with its screenshot path. Open one yourself only when you must decide on a finding the text leaves unclear.

## After dispatching

Call `dispatch` from your main thread only, never from a subagent: catherd messages the session that dispatched.

Only you, the orchestrator, call the coordinator tools: `peek` (of another role), `result`, `dispatch`, `run_start`, `climb`, `land`, `park`, `cancel`, `set_next`, `answer`, `profile_set`, `test_push`, `run_pin`, `lane_set`, `owns_add`, `record_agent_run` and the `workspace_*` writers (`workspace_budget`, `workspace_pause` and `workspace_resume` among them). A role never does: a native Claude subagent's agent file forbids them, and a process role's catherd server refuses them with `E_ROLE_SCOPE`, so a role can never take the run from you. A brief never asks a role to call one.

- **Dispatch every independent role one after another.** Each `dispatch` returns in about a second, once its role has started, so they all run side by side.
- **Then write one status line and end your turn.** Claude Code receives `<cross-session-message from-name="catherd">` through its peer inbox with its existing priorities. Codex receives queued next input through the existing native server (`--remote unix://`): idle sessions can wake; a busy session processes it after the active turn, without Claude's urgent next-tool-round promise. The notice names the run, dispatch and every event ID, including every coalesced event. Call `result(run, name)` for each stored record you will act on, then dispatch what follows.
- **A single role is `dispatch`, then end your turn.**
- **Never `sleep`, loop, use `await_results`, or call `peek` again and again.** Call `peek(run)` when the user asks how it is going, when a decision needs the other roles' state, or once after `run_start` on a resumed run.
- **Queue acceptance is not processing or collection.** An unloaded, interrupted or restarted conversation may retain input without generating. Accepted and ambiguous events are never automatically resent; durable unread records remain recoverable with `peek`/`result`. Only `result` collects a finished record. `status` and `result` do not adopt ownership; explicit `peek(run)`, `run_start` and `dispatch` do.
- **Duplicate notices are idempotent reads.** Preserve every event ID, consult the actual stored record and protocol, and never redispatch work or land a milestone twice because input repeats. A message or transcript echo supplies neither delivery acknowledgement nor user approval; reviewer/verifier gates remain authoritative.
- **An ambiguous retry is an explicit decision:** after validating the current owner and exact stored event, use `catherd runs retry-push <run> <name> --event '<exact event ID>' --acknowledge-possible-duplicate` from that owner's host session. It may duplicate native input. Accepted receipts suppress another enqueue for that owner/event; no supported history reconciliation API means retain ambiguity until this deliberate decision. Unknown/conflicting hosts never push.

**When the user asks where it stands,** call `peek(run)` once and answer from it; `status(run)` adds the totals, budget and milestones.

**Push a notification through an available host facility** only at the moments the profile's `notify` lists (`profile_get({ repo })`), one line each. Claude Code may use `PushNotification`; if the host exposes none, report in the conversation without inventing a notification or scheduled follow-up:

- `milestone`: a milestone landed: its name, its commit, the time it took, and the path of its digest (`land`'s `digest`);
- `finish`: the run finished: verdict and total time;
- `blocked`: a milestone is parked on a decision only the user can make (`park`): push the full question.

Nothing else pushes: a phone that buzzes for progress teaches the user to ignore it.

### On Codex

- **Run inside tmux.** When `$TMUX` and `$STY` are both empty, tell the user once, at the run's start, to run the coordinator inside `tmux` (or `screen`): Codex's app-server stops a thread's MCP servers once no client is attached, so an SSH drop detaches you. Each role's supervisor also queues its result to your thread when it ends, and the queued input waits for the next attach.
- **Goal mode.** A goal continuation while only roles are live ends the turn with no tool call: no `peek`, no `sleep`, no `pidwait` or other wait cell, no role work of your own. When unsure, one `peek(run)` answers it: `actionable: false` and its `reason` mean nothing is yours to do until the next catherd message.
- **Test the push from inside the thread** with `test_push`, when the user asks whether results will reach you: a shell cannot name this thread, since Codex does not export its id to the commands it runs.

## The run folder

`run_start` creates `R` under catherd's data directory, outside the repo. It outlives the session. `R` holds:

- **`plan.md`:** the architect's decisions, milestones and lanes. It changes only by an architect delta.
- **`lanes/Mx.Ly.md`:** one file per lane, the only plan a worker reads. Its second line, `Owns: <paths>`, is what `dispatch` uses to refuse a lane that shares a file with a running one, and to spot a refusal.
- **`ledger.md`:** one row per landed piece, appended by `land`. Never rewritten.
- **`state.md`:** rewritten by the server at every dispatch, climb and landing, so a fresh session resumes from it alone: HEAD, the dirty files and their owners, each running role with its brief, thread and rung, the last check, the next step, and on the last line `Protocol next:`, the step of the milestone loop the run is at.
- **`runs.jsonl`, `agents.jsonl`, `jev.jsonl`, `routes.jsonl`, `outcomes.jsonl`, `harness.jsonl`, `verifier.jsonl`, `questions.jsonl`:** the record.
- **`digests/<milestone>.md`:** each landed milestone's digest, written by `land`.
- **`roles/<name>/<dispatchId>/`** (each dispatch's brief, reply, events and stderr) and **`shots/`** (screenshots).
- **The repo's `knowledge.md`** (beside the runs, per repo, not per run): what past runs learned. `land`'s `learned` appends to it; `read_knowledge` reads it.

**Pause** (on the user's word, a usage limit, or `E_RUN_BUDGET`): dispatch nothing new, `cancel(run, name)` each live role the user wants stopped, and bring down only this run's stack. Leave the tree as it is, call `set_next(run, "paused: <why>; resume with <step>")`, then stop. On a usage limit with no stand-in, catherd has already written the pause.

**Cancel** a role with `cancel(run, name)` when the user asks, or when a role is plainly stuck on work you no longer need. It returns the role's record, `cancelled`, and marks it read.

**Resume** (a new session, or after your context was compacted): `status()` names the run, and `status(run)` shows it. Before dispatching anything, call `peek(run)` once: it lists the open owner questions first, the roles still running, the records not read yet (read each with `result`), and `protocol`, the step of the milestone loop the run is at, with the checklist. It also makes this session the run's owner, so catherd messages you from now on. Check HEAD and the dirty files against its `state.md`, whose last line is the same step. Continue each role on its own thread with `dispatch(…, thread, brief: "<where it stopped>")` (`dispatch` refuses a name that is still running).

**Owner questions:** a product question outside the A-lines never stops the run. `park(run, milestone, question)` parks that milestone (`land` refuses it until it is answered), notify through the available host facility as above, and go on with the milestones and runs that do not depend on it. When the owner answers in this session, `answer(run, milestone, answer)`, then finish the milestone.

## The sequence

**Once per project:**

1. **A-lines.** Write the request as numbered, observable lines `A1…An`. Ask the user every open product question now; after this point, run without them. Then `run_start(repo, title, a_lines)`.
   - **Plan in hand:** when the request names a plan the user already has, keep it as an A-line, `plan: <path>[, <path>…]`. The run then skips the dossier, and the architect translates that plan instead of designing one (step 3).
2. **Dossier.** One researcher, `researcher-dossier`, maps the code the A-lines touch. Its brief asks for, with `file:line` everywhere:
   - what past runs of this repo learned (`read_knowledge(repo)`), so it maps only what changed since then;
   - the files and folders involved, one line each on what they hold;
   - the existing patterns the work should copy, by path;
   - the build, test and run commands, with how long the full suite takes;
   - the lint and type-check commands, and how to scope each to one package;
   - the symbols the change will call or alter, with their signatures;
   - the repo's rules (`CLAUDE.md`, `AGENTS.md`, conventions) that bind this work;
   - risks: shared files, generated code, slow or flaky tests.

   It may run to 200 lines; the 15-line cap does not apply to it. Its reply is `result(run, "researcher-dossier")`, at the record's `replyPath`. A native Claude researcher on Claude Code writes it to `R/dossier.md` with `write_run_file` instead.

3. **Architect,** once, with the A-lines, the run id and the dossier's path. It reads the dossier first, writes `plan.md` and every `lanes/Mx.Ly.md` itself with `write_run_file`, and replies with a short list of milestones and lanes. Each lane names its owned files and its **fast check**: its targeted tests plus the linter of every package the lane touches, and the type check when the repo has one, scoped to those packages (seconds to a minute or two). Each milestone names its **full check** (the whole suite).
   - A full check slower than about five minutes is a problem to solve, not to live with. The architect makes speeding it up (parallel tests, a shared fixture) an early lane.
   - Every lane file starts with these lines: `# Mx.Ly — <title>`, `Owns: <paths>` (repo-relative, a trailing `/` for a folder, never a glob), `Fast check: <command>`, `Kind: repo_code|terminal|ui|prose|research` and `Difficulty: copy|build|logic|hard`. Two optional lines follow: `After: Mx.Ly, …` when the lane compiles against another lane's changes (`protocol.next` and `dispatch` hold it until those finish ok), and `Allow: path[:line], …` under a fast check that greps for absence, naming the hits that are allowed exceptions. `write_run_file` refuses a lane whose header values are wrong; fix one line with `lane_set`.
   - **Plan in hand** (a `plan:` A-line): no dossier. Brief the architect with the A-lines, the run id and the plan's paths, to translate, not design: each plan task becomes lanes (`Owns:`, `Fast check:`, `Kind:`, `Difficulty:`), each MR or phase a milestone with its full check. It copies the plan's decisions into `plan.md` and the lane files, redesigns only what the plan leaves undecided, and stays the target for `design` findings.
   - **No dossier and no architect** for a polish or fix run (a list of known defects or tweaks to code that exists) or a single mechanical task. You write the lane files yourself with `write_run_file`, straight from the A-lines: one lane per cluster of defects that share files, with owned files found by `grep -n`, and the same header lines.
4. **Route and preflight.** `route(run, lanes: ["lanes/Mx.L1.md", …])` once for the milestone's lanes: Jev is asked about all of them at once, where one call per lane may wait up to 25 s each (`dispatch` routes a lane you missed, and starts it at the routed rung when yours is off its ladder). `route`, `preflight` and `dispatch` refuse a lane whose `Kind:` or `Difficulty:` the catalog does not know (`E_LANE_INVALID`). Then, once every lane file exists, `preflight(run)` once, before dispatching any lane. Each lane comes back as one of:
   - `pass`: the check already passes on the base tree;
   - `fails-as-expected`: it runs and fails, because the lane has not been done yet;
   - `skipped`: it checks a file the lane creates, or a pnpm filter that matches no package yet;
   - `cannot-start`: it could not even run (a missing command, exit 126 or 127, a 120 s timeout, no `Fast check:` line, or an environment error its note names: no Docker at `DOCKER_HOST`, DNS, a denied permission). Only this blocks: fix that lane's check, or the environment (`catherd knowledge env set` for the repo's gate environment), and run `preflight` again;
   - `lock-busy`: other checks held every heavy slot for 60 s; run `preflight` again later.

   Preflight runs in your login environment and only the lanes of milestones not landed yet (`milestone` names one). Its `warnings` name a lane whose fast check runs no linter while the repo has one: add the linter of every package the lane touches.

   When it returns `needsConfirmation: true`, the profile wants the user to see the commands first: show them the `commands`, and on their yes call `preflight(run, confirmed: true)`.

**Per milestone:**

5. **Lanes.** Dispatch every lane of the milestone, one after another, each at its rung, then end your turn: workers, the artist, and a researcher if needed. A worker's brief points at its lane file, and `dispatch` gets its `lane`. A worker runs its own fast check until it passes.
   - When a worker's message arrives, read it with `result`: check its STATUS line, its `changedOwned` and its `hints`, then run its fast check yourself once. A fail goes back to the same thread with the failing output's path; a second fail climbs a rung.
   - A hint `environment: <what>` (the reply had an `ENV:` line) is the machine, not the rung: `climb` refuses it (`E_CLIMB_ENV`). Fix the environment, or `park` the milestone when only the owner can. `STATUS: flaky` (a check failed, then passed alone) is the worker's evidence: rerun that check alone, accept it, or climb; the call is yours.
   - A `violation: <paths>` hint means the role wrote outside its lane. Send those paths to the reviewer with the milestone; a lane that needs them gets an `Owns:` delta from the architect.
6. **writer,** when the milestone changes docs. It starts once the workers are done. Its brief names the files it may change on an `Owns:` line (default: `docs/**` and `*.md`), so its edits count as its own and never as a lane's violation.
7. **reviewer,** named `reviewer-<M>`, once, over the whole milestone diff on a frozen tree.
   - A reply of `STATUS: partial` (it read only part of the diff) is not the milestone's review: `land` refuses it, and `protocol.next` names a scoped second pass, `reviewer-<M>-2`, over the files it did not read. For a native reviewer, pass `reply_status` to `record_agent_run`.
   - While its BLOCKER or BUG lines are open, `protocol.next` names the fix round, not the verifier.
   - **UI pass,** when the milestone touched a screen. List the changed files (`git diff --name-only <milestone base>`), map them to the screens that render them, and brief the UI reviewer on those screens only. You start the app first.
8. **One fix round.** Send each lane's findings, verbatim, to its own worker thread, at its rung. A BLOCKER climbs a rung instead, on a fresh thread. Dispatch every lane's fix, then end your turn. Then resume the same reviewer thread, and it re-checks only the BLOCKER and BUG lines.
   - Before routing a finding that questions the plan, `ask(run, "finding", …)`. `design` goes to the architect: `SendMessage` to the same native Claude agent on Claude Code, or `dispatch` with its recorded process `thread` for its own delta, followed by `result`. Its delta rewrites the lane files.
   - A finding that comes back: `ask(run, "same-defect", …)`. `yes` gets one climb and one re-check of that line. Anything still open goes to the report, not into another round.
9. **verifier,** named `verifier-<M>`, with the run id, the milestone's A-lines and the **full check**, on a frozen tree: it owns the independent gate. Route it first. A native Claude verifier runs in the foreground on Claude Code; a Codex or other process verifier uses `dispatch`, end the turn, then `result`. A full check that starts while a role still edits proves nothing, and it has to run again. Never give it a worker's reply.
   - It checks each gate item with `gate_check` first and skips an item that passed on the same content (carried over from its commit); it records each pass with `gate_pass`, runs independent items side by side within the lock's slots, and builds each commit's images once. It names git-ignored inputs (`.env`, generated files) in `paths` explicitly: `.` covers only HEAD and uncommitted not-ignored changes. It passes `gate_check` the milestone it verifies, so the digest lists only that milestone's carried items. `peek` and `status` show its current step.
   - For a native Claude verifier only, call `record_agent_run(run, "verifier-<M>", "verifier", rung, …)`, with `status: "failed"` when its verdict is FAIL: only a PASS is recorded `ok`. Pass `verdict:`, its reply's first line. A process verifier on any backend counts through its dispatch record only when its reply opens `VERDICT: PASS`; collect it with `result` before landing.
   - `VERDICT: BLOCKED: environment — <probe>` is the machine, not the work (a VPN filter, a Docker proxy, a dead registry): no fix round and no climb. `land` refuses it; surface it to the owner with `park`, and run a fresh verifier once it is fixed.
   - On FAIL, the owning worker fixes it, then a **fresh** verifier re-checks (a resumed one can hang): a new `dispatch` or Agent with no `thread`, its brief naming the failed items (`gate_check(run, milestone)` lists them) and a 10-minute cap on each command; what passed is carried over.
   - A second FAIL on the same line goes to the architect.
   - A third one: pause, report and push.
10. **Land.** Commit the milestone path-scoped, then `land(run, milestone, what, commit, evidence, next, learned)`, passing `learned` when the milestone taught the next run something worth knowing (a slow suite, a flaky test, a pattern to copy); push if the profile's `notify` has `milestone`, with `digestPath` (the digest's full path: its commits, findings and what is open), and move to the next milestone. Only a verifier named exactly `verifier-<M>` counts, and the minutes leave out parked and paused time.
    - `land` refuses (`E_LAND_GATE`) a milestone with no reviewer record (a `reviewer-<M>` dispatch record, or a native Claude `record_agent_run` row with role reviewer and that name, status `ok`) or no verifier verdict since its lanes started. A skip over an empty commit range is refused too: commit first. A milestone that changed only docs lands with `skip: "docs-only"`; one that changed no source file with `skip: "no-code"` and the required local gate evidence in `evidence`. Follow the repo's CI policy; a skill never authorizes triggering checks.
    - Commit only while no role is writing. A pre-commit hook may stash unstaged files, and a role's edits vanish under it.
    - The next milestone's lanes can start in the same turn as the `land`.

**Finish:** run the project's final gate if it has one.

- The verifier is the gate owner, with `gate_check` and `gate_pass`. On Claude Code a native Claude verifier runs in the **foreground** (`run_in_background: false`); a background subagent dies with the session. A process verifier on either host uses `dispatch`/`result` and its durable record; finish only after its PASS.
- Beside it, in the background:
  - any independent review (a spec or milestone review by a fresh verifier);
  - the writer's MR body;
  - one **whole-app UI pass**, for what a change broke on a screen nobody touched.
- A gate FAIL goes to a fresh worker thread as one piece. The gate then re-runs from the start on the new SHA.

Then report to the user, in their language, and push if `notify` has `finish`:

- the verdict per milestone;
- the commits;
- one line per role run, with its rung;
- the time and token sums per backend and per rung, and the climbs with their reasons (`runs_summary({ run })`), the Claude subagent runs you reported (say they are reported, not measured), and the Jev decisions with how many fell back (`status(run)`);
- the harness line from `runs_summary`: what the user's claude-code and opencode customizations cost per run, so they can judge the isolation toggle (`/catherd-setup` offers it). Codex reports no per-request input, so it has no harness figure: say so instead of offering one;
- the run's budget spend (`status(run)`), if the profile set one;
- what was left open, and why.

Roles never commit. You commit, following the repo's rules.

## Brief for a role

The brief is the `brief` text you pass to `dispatch` (catherd writes it to the dispatch's own `brief.md` and hands it to the CLI on stdin), or the prompt of a native Claude role's Agent call on Claude Code, with the run id. It has these parts, in order:

1. The role and the goal, in one line.
2. The A-lines this run must meet.
3. The files it owns, and the files it must not touch. If the repo has a `CLAUDE.md`, add "Read CLAUDE.md first": Codex loads only `AGENTS.md`.
4. For a worker:
   - "Read `<R>/lanes/Mx.Ly.md`": decisions, signatures, data shapes;
   - its fast check (targeted tests, lint and type check), to run until it passes;
   - "Run the full suite only if this brief says so", and "Wrap any full build or full test suite in `bunx catherd-cli@1.4.0 lock -- <command>`": other lanes share the machine.
5. For a reviewer: the A-lines and the changed files, with new files read in full. It reports every finding as `BLOCKER|BUG|NIT file:line — problem — fix`, covering:
   - unmet A-lines and edge cases;
   - code or abstractions nobody needs;
   - comments that restate code;
   - tests that assert nothing.

   With no finding, the reply is `CLEAN`.

6. For a UI reviewer:
   - the URL and the changed screens, by route;
   - the viewports and themes;
   - `agent-browser screenshot <R>/shots/<name>.png` at viewport size, not full page; it opens each PNG with its image tool;
   - every finding is `BLOCKER|BUG|NIT <screen> — problem — fix — <R>/shots/<name>.png`, always with the path.
7. For an artist, per image:
   - the screen, where the image sits, its shape;
   - the mood and scene in words (subject, materials, light, colour): taste, not measurements;
   - the final `.webp` path in the repo's assets folder. The worker's brief names the same path, so both lanes run at once.

   Its rules:
   - use the built-in image tool, and copy its untouched output from `${CODEX_HOME:-~/.codex}/generated_images/`; the record's `images` lists those paths;
   - the only processing is `cwebp -q 85 in.png -o out.webp`;
   - never paint, patch or upscale;
   - never redraw a real logo, and never present a generated person as a real customer;
   - add one provenance line per image to a `README.md` beside it.

   The tool tops out around 1536×1024.

8. Not the reply shape: `dispatch` appends the role's reply contract to every brief ("Do not commit", at most 15 lines, and the last line `STATUS: complete|partial|blocked|refused — <one line why>`), and a native Claude role's agent carries it.
9. Not the lane file's text, the role's scratch folder or its catherd tools: with `lane`, `dispatch` inlines the lane file as it stands, and every brief names the role's `$TMPDIR` (`<run>/scratch/<name>/`) and how it reads its run's files.

## Reading results

- Read each record a catherd message announces, its `hints`, and the reply, with `result(run, name)`, nothing else. Read the stderr the `failed: read <path>` hint names, with `read_run_file`, only when `status` is `failed`. Never read a diff or a log yourself: that is the reviewer's and verifier's job, and your context is the run's most expensive token.
- Exit 0 means the model finished, not that it is right. The STATUS line is the role's claim; `changedOwned` and your fast check are the facts.
- `failed` comes only from a real turn failure or an exit with no reply; a reconnect mid-run does not count. Read the reply before you retry.
- `cli-too-old`: tell the user the upgrade command its `cli-too-old:` hint names. `limit` with no stand-in: a usage limit is the user's to fix: pause, report and push that turn. `timeout`: the role went quiet for the profile's idle minutes, or ran past its wall minutes; resume its thread once with where it stopped, then climb.
- `thread-heavy`: that thread is spent; its next piece starts fresh.

## Red flags

| You notice                                                                                                                          | Do instead                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| A lane waits on another lane that shares none of its files                                                                          | Dispatch it now, beside the others                                                                                                                |
| A role dispatched, then waited on, before the next independent one is dispatched                                                    | Dispatch every independent role first, then end your turn                                                                                         |
| `sleep`, `await_results`, a loop, or repeated `peek` to see whether a role is done                                                  | End your turn; use the host's completion input and durable `result` recovery                                                                      |
| A worker or fix loop runs the full suite to check one change                                                                        | Its fast check. The full check is the verifier's, once per milestone                                                                              |
| A reviewer or verifier runs after each lane                                                                                         | Once per milestone, over the whole milestone                                                                                                      |
| A third review round                                                                                                                | One fix round, one climb for a returning defect, one re-check. The rest goes to the report                                                        |
| You open a diff, a log or a source file to judge the work                                                                           | Send a reviewer, or the verifier                                                                                                                  |
| You open every screenshot                                                                                                           | Read the findings. Open one path only to settle an unclear finding                                                                                |
| The UI pass covers the whole app mid-run                                                                                            | Changed screens only. The whole app once, at finish                                                                                               |
| You write `state.md`, the ledger or a brief file with your own tools                                                                | The server writes `state.md`, `land` writes the ledger, `dispatch` writes the brief                                                               |
| A new bug, cleanup, re-run or climb sent with `thread`                                                                              | A fresh thread. Resume only for that piece's own findings at the same rung                                                                        |
| One transition spread over several turns (a land, routes, dispatches)                                                               | One turn: every independent call back to back, then one status line                                                                               |
| A plan, log or test file read whole into your context                                                                               | `read_run_file` for the one section, or `grep -n` then those lines. Or name the path in a brief                                                   |
| You copy the architect's plan into `plan.md` yourself                                                                               | The architect writes `plan.md` and the lane files. With a plan in hand, it copies the user's plan into them                                       |
| A dossier, or an architect designing afresh, with a plan in hand                                                                    | No dossier. Brief the architect to translate the plan, and to design only what it leaves undecided                                                |
| A dossier or an architect for a polish or fix run                                                                                   | Write the lane files from the A-lines yourself                                                                                                    |
| A lane file without an `Owns:` line                                                                                                 | Add it: `dispatch` refuses the lane without one                                                                                                   |
| A native Claude subagent on Claude Code returned and you moved on                                                                   | `record_agent_run` with its `total_tokens` and `duration_ms` first                                                                                |
| A rung written as `model#effort`                                                                                                    | `backend:model#effort`, exactly as `route` returned it                                                                                            |
| `dispatch` retried after an `E_*` error without doing what its `fix` says                                                           | Do the `fix`, or pause and tell the user                                                                                                          |
| A `cannot-start` preflight lane dispatched anyway                                                                                   | Fix its fast check first, and run `preflight` again                                                                                               |
| You pick a rung by feel                                                                                                             | `route`. Its default covers the case where Jev is unsure or down                                                                                  |
| Jev's answer taken as proof a lane is done                                                                                          | Jev picks who works. Checks, the reviewer and the verifier decide done                                                                            |
| A reply from the lowest Track A rung trusted without your fast check                                                                | Run it. Cheap rungs hide broken tools                                                                                                             |
| A reviewer, or a `logic`/`hard` lane, on a rung you chose yourself                                                                  | The rung `route` returned                                                                                                                         |
| Exit 0 with the owned files unchanged, treated as done                                                                              | A refusal: climb with reason `unchanged`                                                                                                          |
| A native Claude gate verifier dispatched in the background                                                                          | Foreground on Claude Code; process verifiers use `dispatch`/`result` on either host                                                               |
| A full check started while a worker still edits                                                                                     | Wait for a frozen tree. That run proves nothing                                                                                                   |
| Lanes dispatched before `preflight` ran                                                                                             | Run `preflight(run)` first; a lane whose check cannot even start wastes a dispatch                                                                |
| An architect planning without reading what past runs learned                                                                        | `read_knowledge(repo)` first, from the dossier brief                                                                                              |
| A landed milestone that taught something, landed without `learned`                                                                  | Pass it: the next run's architect reads `knowledge.md`                                                                                            |
| You update catherd, this plugin or the profile while a run is in flight                                                             | After the run. A role mid-flight must see one version                                                                                             |
| You stop to ask the user something mid-run                                                                                          | Decide within the A-lines and note it for the report. A product question outside them parks its milestone (`park`), with a push; the rest goes on |
| A brief that spells out the reply shape and the STATUS line                                                                         | `dispatch` appends the reply contract itself                                                                                                      |
| A milestone landed without its reviewer and verifier                                                                                | `reviewer-<M>`, then the routed verifier's independent PASS, then `land`                                                                          |
| A climb for a finding that questions the plan or the lane's owned files                                                             | `ask` finding, then the architect. `climb` refuses it (`E_CLIMB_DESIGN`)                                                                          |
| A gate item run again on content that already passed it                                                                             | The verifier's `gate_check` carries it over                                                                                                       |
| A push for progress that is not a landed milestone, the finish or a block                                                           | No push. `status(run)` answers when the user asks                                                                                                 |
| Your own decision changes behavior that already exists and no A-line asked for it (e.g. re-numbering `list` to match a new command) | Pick the option that keeps existing behavior, and fit the new code to it                                                                          |
| `Agent(subagent_type: "Plan", model: "opus")` for the architect                                                                     | Route first: native Claude's returned `agent` with no model on Claude Code, otherwise `dispatch`/`result`                                         |
| `dispatch` called from a subagent                                                                                                   | The main thread: catherd messages the session that dispatched                                                                                     |
| `codex exec` or `opencode run` called by hand                                                                                       | Always `dispatch`: it records the run, keeps `state.md` true and guards the lanes                                                                 |
| You isolate a role's harness yourself, or tell a role to ignore the user's config                                                   | Never. Only the profile's `harness.<name>.isolated`, which the user sets                                                                          |
| The architect's plan contains function bodies                                                                                       | Ask for decisions and signatures. The worker writes the code                                                                                      |
| "It's one line, I'll fix it myself"                                                                                                 | Send it to the worker's thread                                                                                                                    |
| The artist's image was resized, retouched or patched                                                                                | Regenerate it from the artist's thread                                                                                                            |
