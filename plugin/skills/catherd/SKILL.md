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

**You never edit product files.** Every line of code, tests or docs comes from a role, including a one-line fix.

**You run in the user's own session, on purpose.** The main thread is the user's own model in Claude Code, with their plugins, hooks and memory beside it: the environment they decide in every day. Never propose a stripped launcher or a headless relay to save tokens.

**Each role runs in its vendor's own harness with the user's customizations — never isolate it.** Codex and opencode roles keep the user's config, hooks, MCP servers, skills and `AGENTS.md`. The one exception is the user's own choice, the profile's `harness.<name>.isolated`, and `dispatch` applies it for you.

## Tools

The catherd MCP tools ship with this plugin. They appear as `mcp__plugin_catherd_catherd__<name>`. If they are deferred, load them all with one ToolSearch call at the start, together with `PushNotification`.

| Tool                                                             | Use                                                                                                                                                                           |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_start(repo, title, a_lines)`                                | Once per project. Returns `run`, the id every other call takes, and `dir`, the run folder `R`                                                                                 |
| `route(run, lane_file?, role?)`                                  | A lane's rung, decided by Jev from its lane file; or, without a lane file, a role's rung from the profile. Returns `rung`, `ladder`, `backend`, and `agent` for a Claude rung |
| `preflight(run)`                                                 | Runs each lane's fast check once, on the base tree, behind the machine-wide lock. Call it once every lane file exists, before dispatching any of them                         |
| `dispatch(run, role, name, brief, rung, thread?, lane?, next?)`  | Runs one Codex or opencode role and returns its `record` and `hints`                                                                                                          |
| `climb(run, lane, reason, evidence?)`                            | The lane's next rung, or `top: true`                                                                                                                                          |
| `ask(run, question, state)`                                      | Jev's `finding` or `same-defect` answer                                                                                                                                       |
| `land(run, milestone, what, commit, evidence, next, learned?)`   | A landed milestone's ledger row, and `state.md`. `learned` appends to this repo's `knowledge.md`                                                                              |
| `read_knowledge(repo)`                                           | What past runs of this repo learned. The dossier brief reads it                                                                                                               |
| `write_run_file(run, path, content)`, `read_run_file(run, path)` | Files in `R`. Never your own Write or Read tools there: `R` is outside the repo                                                                                               |
| `result(run, name)`                                              | A role's capped reply and its record                                                                                                                                          |
| `status(run?)`                                                   | One screen: the `state.md` tail, live roles with their age, totals, Jev fallbacks, the harness cost, the run's budget spend                                                   |
| `set_next(run, next)`                                            | The next step, when you pause or the plan changes                                                                                                                             |
| `runs_summary(filter)`                                           | Time, tokens, refusals and climbs per role and rung, and the harness cost, for the report                                                                                     |
| `profile_get()`                                                  | The active profile: enabled roles, and the moments to push                                                                                                                    |

## Roles

| Role        | How to run it                                                                   | Job                                                     |
| ----------- | ------------------------------------------------------------------------------- | ------------------------------------------------------- |
| architect   | `Agent(subagent_type: <agent>)`, the agent from `route(run, role: "architect")` | Decisions, milestones, lane files. No code.             |
| verifier    | `Agent(subagent_type: <agent>)`, from `route(run, role: "verifier")`            | Independent PASS/FAIL of a milestone, by running it     |
| worker      | `dispatch(run, "worker", "worker-<lane>", brief, rung, lane: "<lane>")`         | One lane: its code and its tests                        |
| reviewer    | `dispatch(run, "reviewer", "reviewer-<m>", brief, rung)`                        | Review of a milestone's diff                            |
| ui-reviewer | `dispatch(run, "ui-reviewer", "ui-<m>", brief, rung)`                           | Screenshots of the changed screens with `agent-browser` |
| artist      | `dispatch(run, "artist", "artist-<n>", brief, rung)`                            | Images a screen needs, with Codex's built-in image tool |
| writer      | `dispatch(run, "writer", "writer-<m>", brief, rung)`                            | README, docs, changelog, MR body                        |
| researcher  | `dispatch(run, "researcher", "researcher-<n>", brief, rung)`                    | The dossier, or one factual question about the code     |

- **Every rung comes from `route`,** never from you. The table shows the usual backend; the profile decides. When `route` returns `backend: "claude"`, run that role with `Agent(subagent_type: <agent>)`, with the brief and the run id as its prompt; otherwise `dispatch` it. `dispatch` refuses a Claude rung and names the agent.
- **A role the profile disables** (`profile_get`; every role but the worker can be off) is skipped, and the report says so.
- **Sandbox:** catherd sets it per role. Worker, artist and writer write in the repo only; reviewer, researcher and architect read; verifier and UI reviewer get full access for Docker, a browser, gate logs and screenshots.
- **Cheap rungs hide broken tools.** The lowest Track A rung stays silent about a broken tool about a third of the time, so every lane on it is checked by your fast check, not by its own word.
- **Claude agents:**
  - catherd generates them from the profile, and Claude Code registers them at session start.
  - Pass no `model` to those Agent calls. Never let `Plan`, `general-purpose` or `Explore` stand in.
  - `Agent type … not found` means the profile changed after this session started: tell the user to open a new session.
  - If the model needs a newer Claude Code, stop and tell the user to upgrade Claude Code. Never pass a `model` to get past it.
- **The record:** `R/roles/<name>.out` is the latest reply; earlier rounds are kept as `<name>.r<k>.*`. `R/runs.jsonl` holds one record per run (role, rung, status, thread, seconds, tokens). It is the token and time record: never keep your own.

## Effort: the ladder, decided by Jev

A lane starts on the lowest rung that can do it, and climbs one rung when it shows it cannot. The ladders come from the profile and the catalog. With the default profile:

| Track | Lanes                                                                         | Rungs, low to high                                                            |
| ----- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| A     | `copy` or `build`: an existing pattern, a clear fast check                    | `gpt-6-luna#high` → `gpt-6-sol#medium` → `gpt-6-sol#high` → `gpt-6-sol#xhigh` |
| B     | `logic` or `hard`, or `terminal` work: state, concurrency, ops, unclear cause | `gpt-6-sol#medium` → `gpt-6-sol#high` → `gpt-6-sol#xhigh`                     |

**Jev picks the start.** Jev (TypeSafe) is a decision model: it answers a fixed question with calibrated confidence in about three seconds, for a fraction of a cent. On low confidence, or with no Jev, the tools return the profile's default (`source: "default"`), so the run never waits on it. Every call is logged to `R/jev.jsonl`.

| When                                          | Call                                                                          | On the answer                               |
| --------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------- |
| Each lane, before its first dispatch          | `route(run, "lanes/Mx.Ly.md")`                                                | Dispatch it at `rung`                       |
| A review finding that may be the plan's fault | `ask(run, "finding", { lane_file: "lanes/Mx.Ly.md", finding: "<the line>" })` | `design` → the architect. Else → the worker |
| A finding back after its fix round            | `ask(run, "same-defect", { before: "<old line>", after: "<new line>" })`      | `yes` → climb one rung                      |

**Climb one rung** with `climb(run, lane, reason, evidence)`, then dispatch the lane at the new rung on a fresh thread whose brief is the lane file plus the path of the failing evidence, when:

- your fast check fails twice on that lane (`check-failed-twice`);
- the lane gets a BLOCKER (`blocker`), or Jev calls a returning finding the same defect (`same-defect`);
- the reply says `STATUS: refused` or `blocked`, or the run exits 0 while the lane's owned files are unchanged: that is a refusal, whatever the reply says (`refused`, `blocked`, `unchanged`). `dispatch` flags each of these in its `hints` as `climb: <reason>`.

A failure on the top rung (`top: true`) goes to the architect when Jev calls it design, else to the report as open.

- Jev decides which model does the work. It never decides that the work is done: only a check, the reviewer or the verifier does.
- `R/routes.jsonl` records each lane's rung and every climb with its reason.
- Never put a secret or a key into an `ask` state. Keep the state short and in English.

## Threads

A resumed thread replays its whole history on every tool call. In the first real run, one worker thread cost 20–25M input tokens per resume, and threads were 90% of the Codex spend.

- **Resume a thread only for its own fix round:** the reviewer's findings on that piece, or the verifier's FAIL, at the same rung. That is `dispatch(…, thread: <record.thread>)`, with the fix as the brief.
- **A new piece of work gets a fresh thread,** even for the same worker role: a new bug, a cleanup slice, a docs pass, a re-run, a climb to the next rung. Its brief carries what it needs, from its lane file and the ledger.
- A `thread-heavy` hint means that thread is spent. Its next piece starts fresh.

## Your own context

Your context is re-read on every turn, and it is the run's most expensive token. In the first real run you were 68% of the Claude spend: 269 turns at about 220k tokens each.

- **One message per transition.** Independent tool calls (a `land`, the next lanes' dispatches, a `route`) go in the same message.
- **Read little, and read it narrowly.**
  - From the architect, read its short reply. The plan lives in `plan.md` and the lane files; read a section with `read_run_file` only when a decision needs it.
  - From a role, read its record and its capped reply.
  - Never read a log, a diff, a test file or source.
- **Brief by path.** A brief names the files a role must read (its lane file, a prior reply, a finding). Never paste their contents into your own context to copy them over.
- **Screenshots are paths.** The UI reviewer's findings are text, each with its screenshot path. Open one yourself only when you must decide on a finding the text leaves unclear.

## Waiting

Call `dispatch` from your main thread, never from a subagent: a subagent's MCP call never backgrounds, so it would hold that subagent for the whole run. Launch every independent role in the same message. Each dispatch backgrounds by itself after two minutes, and its result arrives as a notification that wakes you. Then end your turn with one status line. Never `sleep` and never poll.

**When the user asks where it stands,** call `status(run)` once and answer from it.

**Push a notification** (`PushNotification`) only at the moments the profile's `notify` lists (`profile_get`), one line each:

- `milestone`: a milestone landed: its name, its commit, the time it took;
- `finish`: the run finished: verdict and total time;
- `blocked`: the run is blocked on a decision only the user can make.

Nothing else pushes: a phone that buzzes for progress teaches the user to ignore it.

## The run folder

`run_start` creates `R` under catherd's data directory, outside the repo. It outlives the session. `R` holds:

- **`plan.md`:** the architect's decisions, milestones and lanes. It changes only by an architect delta.
- **`lanes/Mx.Ly.md`:** one file per lane, the only plan a worker reads. Its second line, `Owns: <paths>`, is what `dispatch` uses to refuse a lane that shares a file with a running one, and to spot a refusal.
- **`ledger.md`:** one row per landed piece, appended by `land`. Never rewritten.
- **`state.md`:** rewritten by the server at every dispatch, climb and landing, so a fresh session resumes from it alone: HEAD, the dirty files and their owners, each running role with its brief, thread and rung, the last check, and the next step on the last line.
- **`runs.jsonl`, `jev.jsonl`, `routes.jsonl`, `harness.jsonl`:** the record.
- **`roles/`** (briefs and replies) and **`shots/`** (screenshots).
- **`<data>/<repo-slug>/knowledge.md`** (one level up, per repo, not per run): what past runs learned. `land`'s `learned` appends to it; `read_knowledge` reads it.

**Pause** (on the user's word, or a usage limit): dispatch nothing new, and bring down only this run's stack. Leave the tree as it is, call `set_next(run, "paused: <why>; resume with <step>")`, then stop. On a usage limit, `dispatch` has already written the pause.

**Resume:** `status()` names the run, and `status(run)` shows it. Check HEAD and the dirty files against its `state.md`. Continue each role on its own thread with `dispatch(…, thread, brief: "<where it stopped>")`.

## The sequence

**Once per project:**

1. **A-lines.** Write the request as numbered, observable lines `A1…An`. Ask the user every open product question now; after this point, run without them. Then `run_start(repo, title, a_lines)`.
2. **Dossier.** One researcher, `researcher-dossier`, maps the code the A-lines touch. Its brief asks for, with `file:line` everywhere:
   - what past runs of this repo learned (`read_knowledge(repo)`), so it maps only what changed since then;
   - the files and folders involved, one line each on what they hold;
   - the existing patterns the work should copy, by path;
   - the build, test and run commands, with how long the full suite takes;
   - the symbols the change will call or alter, with their signatures;
   - the repo's rules (`CLAUDE.md`, `AGENTS.md`, conventions) that bind this work;
   - risks: shared files, generated code, slow or flaky tests.

   It may run to 200 lines; the 15-line cap does not apply to it. Its reply is `R/roles/researcher-dossier.out`. A Claude researcher writes it to `R/dossier.md` with `write_run_file` instead.

3. **Architect,** once, with the A-lines, the run id and the dossier's path. It reads the dossier first, writes `plan.md` and every `lanes/Mx.Ly.md` itself with `write_run_file`, and replies with a short list of milestones and lanes. Each lane names its owned files and its **fast check** (targeted tests, seconds to a minute or two); each milestone names its **full check** (the whole suite).
   - A full check slower than about five minutes is a problem to solve, not to live with. The architect makes speeding it up (parallel tests, a shared fixture) an early lane.
   - **No dossier and no architect** for a polish or fix run (a list of known defects or tweaks to code that exists) or a single mechanical task. You write the lane files yourself with `write_run_file`, straight from the A-lines: one lane per cluster of defects that share files, with owned files found by `grep -n`, and the three header lines the architect writes (`# Mx.Ly — …`, `Owns: …`, `Fast check: …`).
4. **Route and preflight.** `route(run, "lanes/Mx.Ly.md")` for every lane, all in one message. Then, once every lane file exists, `preflight(run)` once, before dispatching any lane: a lane whose fast check cannot even start blocks the run with its output until fixed.

**Per milestone:**

5. **Lanes.** Launch every lane of the milestone in one message, each at its rung: workers, the artist, and a researcher if needed. A worker's brief points at its lane file, and `dispatch` gets its `lane`. A worker runs its own fast check until it passes.
   - When a worker returns, check its STATUS line, its `changedOwned` and its `hints`, then run its fast check yourself once. A fail goes back to the same thread with the failing output's path; a second fail climbs a rung.
6. **writer,** when the milestone changes docs. It starts once the workers are done.
7. **reviewer,** once, over the whole milestone diff on a frozen tree.
   - **UI pass,** when the milestone touched a screen. List the changed files (`git diff --name-only <milestone base>`), map them to the screens that render them, and brief the UI reviewer on those screens only. You start the app first.
8. **One fix round.** Send each lane's findings, verbatim, to its own worker thread, at its rung. A BLOCKER climbs a rung instead, on a fresh thread. All lanes go at once. Then resume the same reviewer thread, and it re-checks only the BLOCKER and BUG lines.
   - Before routing a finding that questions the plan, `ask(run, "finding", …)`. `design` goes to the architect (`SendMessage` to the same agent), and its delta rewrites the lane files.
   - A finding that comes back: `ask(run, "same-defect", …)`. `yes` gets one climb and one re-check of that line. Anything still open goes to the report, not into another round.
9. **verifier,** with the milestone's A-lines and the **full check**, on a frozen tree. A full check that starts while a role still edits proves nothing, and it has to run again. Never give it a worker's reply.
   - On FAIL, the owning worker fixes it, and you `SendMessage` the same verifier to re-check.
   - A second FAIL on the same line goes to the architect.
   - A third one: pause, report and push.
10. **Land.** Commit the milestone path-scoped, then `land(run, milestone, what, commit, evidence, next, learned)`, passing `learned` when the milestone taught the next run something worth knowing (a slow suite, a flaky test, a pattern to copy); push if the profile's `notify` has `milestone`, and move to the next milestone.
    - Commit only while no role is writing. A pre-commit hook may stash unstaged files, and a role's edits vanish under it.
    - The next milestone's lanes can start in the same message as the `land`.

**Finish:** run the project's final gate if it has one.

- The verifier is the gate owner, run in the **foreground** (`run_in_background: false`). A background subagent dies with the session, and the gate is lost.
- Beside it, in the background:
  - any independent review (a spec or milestone review by a fresh verifier);
  - the writer's MR body;
  - one **whole-app UI pass**, for what a change broke on a screen nobody touched.
- A gate FAIL goes to a fresh worker thread as one piece. The gate then re-runs from the start on the new SHA.

Then report to the user, in their language, and push if `notify` has `finish`:

- the verdict per milestone;
- the commits;
- one line per role run, with its rung;
- the time and token sums per backend and per rung, and the climbs with their reasons (`runs_summary({ run })`), the Claude subagent runs, and the Jev decisions with how many fell back (`status(run)`);
- the harness line from `runs_summary`: what the user's Codex and opencode customizations cost per run, so they can judge the isolation toggle (`/catherd-setup` offers it);
- the run's budget spend (`status(run)`), if the profile set one;
- what was left open, and why.

Roles never commit. You commit, following the repo's rules.

## Brief for a role

The brief is the `brief` text you pass to `dispatch` (catherd writes it to `R/roles/<name>.md`, or `<name>.fix.md` for a fix), or the prompt of a Claude role's Agent call, with the run id. It has these parts, in order:

1. The role and the goal, in one line.
2. The A-lines this run must meet.
3. The files it owns, and the files it must not touch. If the repo has a `CLAUDE.md`, add "Read CLAUDE.md first": Codex loads only `AGENTS.md`.
4. For a worker:
   - "Read `<R>/lanes/Mx.Ly.md`": decisions, signatures, data shapes;
   - its fast check, to run until it passes;
   - "Run the full suite only if this brief says so", and "Wrap any full build or full test suite in `bunx catherd-cli@0.2.1 lock -- <command>`": other lanes share the machine.
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

8. "Do not commit." Then the reply shape: **at most 15 lines**. Results, file:line, and evidence as the log path, not the log. The last line is `STATUS: complete|partial|blocked|refused — <one line why>`.

## Reading results

- Read the record `dispatch` returns, its `hints`, and the reply (`result(run, name)`), nothing else. Read `roles/<name>.jsonl` or `.err` with `read_run_file` only when `status` is `failed`. Never read a diff or a log yourself: that is the reviewer's and verifier's job, and your context is the run's most expensive token.
- Exit 0 means the model finished, not that it is right. The STATUS line is the role's claim; `changedOwned` and your fast check are the facts.
- `failed` comes only from a real turn failure or an exit with no reply; a reconnect mid-run does not count. Read the reply before you retry.
- `cli-too-old`: tell the user the upgrade command in the record's `error`. `limit`: a usage limit is the user's to fix: pause, report and push that turn.

## Red flags

| You notice                                                                                                                          | Do instead                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| A lane waits on another lane that shares none of its files                                                                          | Launch it now, in the same message                                                                                     |
| A worker or fix loop runs the full suite to check one change                                                                        | Its fast check. The full check is the verifier's, once per milestone                                                   |
| A reviewer or verifier runs after each lane                                                                                         | Once per milestone, over the whole milestone                                                                           |
| A third review round                                                                                                                | One fix round, one climb for a returning defect, one re-check. The rest goes to the report                             |
| You open a diff, a log or a source file to judge the work                                                                           | Send a reviewer, or the verifier                                                                                       |
| You open every screenshot                                                                                                           | Read the findings. Open one path only to settle an unclear finding                                                     |
| The UI pass covers the whole app mid-run                                                                                            | Changed screens only. The whole app once, at finish                                                                    |
| You write `state.md`, the ledger or a brief file with your own tools                                                                | The server writes `state.md`, `land` writes the ledger, `dispatch` writes the brief                                    |
| A new bug, cleanup, re-run or climb sent with `thread`                                                                              | A fresh thread. Resume only for that piece's own findings at the same rung                                             |
| One transition spread over several turns (a land, routes, dispatches)                                                               | One message, with every independent call in it                                                                         |
| A plan, log or test file read whole into your context                                                                               | `read_run_file` for the one section, or `grep -n` then those lines. Or name the path in a brief                        |
| You copy the architect's plan into `plan.md` yourself                                                                               | The architect writes `plan.md` and the lane files                                                                      |
| A dossier or an architect for a polish or fix run                                                                                   | Write the lane files from the A-lines yourself                                                                         |
| A lane file without an `Owns:` line                                                                                                 | Add it: `dispatch` refuses the lane without one                                                                        |
| You pick a rung by feel                                                                                                             | `route`. Its default covers the case where Jev is unsure or down                                                       |
| Jev's answer taken as proof a lane is done                                                                                          | Jev picks who works. Checks, the reviewer and the verifier decide done                                                 |
| A reply from the lowest Track A rung trusted without your fast check                                                                | Run it. Cheap rungs hide broken tools                                                                                  |
| A reviewer, or a `logic`/`hard` lane, on a rung you chose yourself                                                                  | The rung `route` returned                                                                                              |
| Exit 0 with the owned files unchanged, treated as done                                                                              | A refusal: climb with reason `unchanged`                                                                               |
| The gate verifier dispatched in the background                                                                                      | Foreground. Reviews, the MR body and the whole-app UI pass go in the background beside it                              |
| A full check started while a worker still edits                                                                                     | Wait for a frozen tree. That run proves nothing                                                                        |
| Lanes dispatched before `preflight` ran                                                                                             | Run `preflight(run)` first; a lane whose check cannot even start wastes a dispatch                                     |
| An architect planning without reading what past runs learned                                                                        | `read_knowledge(repo)` first, from the dossier brief                                                                   |
| A landed milestone that taught something, landed without `learned`                                                                  | Pass it: the next run's architect reads `knowledge.md`                                                                 |
| You update catherd, this plugin or the profile while a run is in flight                                                             | After the run. A role mid-flight must see one version                                                                  |
| You stop to ask the user something mid-run                                                                                          | Decide within the A-lines and note it for the report. Only a product question outside them pauses the run, with a push |
| A push for progress that is not a landed milestone, the finish or a block                                                           | No push. `status(run)` answers when the user asks                                                                      |
| Your own decision changes behavior that already exists and no A-line asked for it (e.g. re-numbering `list` to match a new command) | Pick the option that keeps existing behavior, and fit the new code to it                                               |
| `Agent(subagent_type: "Plan", model: "opus")` for the architect                                                                     | The `agent` that `route(run, role: "architect")` returned, with no model                                               |
| `dispatch` called from a subagent                                                                                                   | The main thread. A subagent's MCP call never backgrounds                                                               |
| `codex exec` or `opencode run` called by hand                                                                                       | Always `dispatch`: it records the run, keeps `state.md` true and guards the lanes                                      |
| You isolate a role's harness yourself, or tell a role to ignore the user's config                                                   | Never. Only the profile's `harness.<name>.isolated`, which the user sets                                               |
| The architect's plan contains function bodies                                                                                       | Ask for decisions and signatures. The worker writes the code                                                           |
| "It's one line, I'll fix it myself"                                                                                                 | Send it to the worker's thread                                                                                         |
| The artist's image was resized, retouched or patched                                                                                | Regenerate it from the artist's thread                                                                                 |
