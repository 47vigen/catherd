# catherd-cli

## 2.0.0

### Major Changes

- b842355: Part of 2.0.0. The terminal dashboard is removed, with its `@opentui` dependencies. `catherd panel` serves a browser panel on 127.0.0.1 behind a one-time token: Setup (backends, the catalog, each role's rungs from indexed Slopalytics pairs), Runs (every run and its live timeline) and Questions (answer a parked unit). A bare `catherd` opens the panel and `catherd --help` prints the help; `catherd watch` prints text only.
- bf5c7ce: catherd 2.0.0: the run drives itself. Upgrading, and every change that breaks a 1.5 setup: MIGRATION.md, "From 1.5 to 2.0". 1.x receives bug fixes only, from the `1.x` branch (`catherd-cli@1`); runs started on 1.5 finish on 1.5. The scorecard counts a daemon run's owner answers, open questions, cancels and plan approvals as interventions.
- 734b254: Part of 2.0.0. Routing on one scale: Jev's yes/no answers floor a lane at logic (an unexplained cause, a cross-service invariant, shared state) or cap it at build (purely mechanical work). The shipped bars are the 20th, 45th, 60th and 65th percentiles (copy, build, logic, hard), and a profile or a single role can move one (`bars`). `maxEffort` caps a model's effort for every route, climb and failover; the default profile caps Opus 5.5 and Sonnet 5.5 at high and GPT-6.1 Sol at xhigh. Coding workers never run below medium effort, and no objective or budget puts cost ahead of that floor. Every failover is a `failover` row in `routes.jsonl`.
- 060e320: Part of 2.0.0. The catalog reads only the Slopalytics index: one intelligence per model and effort, refreshed hourly. Every benchmark source, `scores.json`, the Artificial Analysis key, treat-likes and `catalog.override.json` are gone; a pair without an index is not offered and fails `profile validate`; bars are intelligence percentiles; a run pins the index it started on and refuses to start when a role has no usable rung. The Grok Build and Antigravity backends are removed.
- 766b45f: Part of 2.0.0. Every role gets its role text, team and done-when rules as sections, with the reviewer, worker and verifier rules real runs taught; replies gain EXTRA:, REJECTED: and DESIGN: lines; `run_start` takes `plan:`, each lane names the plan tasks its worker implements as written, a run without a plan waits for the owner's approval of the architect's (again only when a later change edits an approved decision), and preflight refuses a lane the plan does not back.
- b4b0f2a: 2.0.0 (part of): knowledge.md lines are standing rules in every role's brief, and a `[worker, reviewer]` tag scopes one to those roles; `catherd knowledge rm` retires a line; a finished run ends with a rules review whose proposals the report lists with their commands. A finished research lane's answer reaches the lanes after it. Preflight lints the plan's lanes, and stops on an After: that can never finish. The run report quotes every known issue word for word, NITs included, with the review rounds, what they fixed and the gate's record.
- aa94754: 2.0.0 (part of): `run_start` takes `base`: each milestone gets its own branch and worktree from `origin/<base>`, set up once with the plan's `Setup:` line, and its roles, checks and commits work there. Milestones whose `After:` milestones are merged run side by side while the machine has the memory for them (the profile's `limits.memory`: by default 3 GB each above a 2 GB reserve). Answering `push` to a landed milestone has catherd push its branch and print the MR command; merged, clean worktrees are removed. catherd never opens an MR or merges. A run without `base` works in the repo as before.
- 6761105: Part of 2.0.0. A decision model picks the rung of every dispatch and every judge, on the role's exact brief, in every round. It is any model behind a TypeSafe-compatible `/v1/systemone` endpoint: set `decision.url`, `decision.model` and `decision.minConfidence` on the profile, and put the key in `CATHERD_DECISION_KEY`. It is mandatory: a run refuses to start without it (`E_DECISION_UNSET`, `E_DECISION_PROBE`). A fix round never runs below the rung that failed. A call with no answer is retried, then parked for the coordinator.

  Briefs have four parts: the role contract, the run facts, the unit context (capped near 20 KB) and this round. Findings are capped at 2 KB, a resumed fix round sends this round only, and each role sees only the A-lines it owns.

  A verifier lists what it ran as `RAN: <cmd> — exit <n> — <log>` lines; a reply with none is a FAIL. A failure is classed `product` or `harness`, and one harness repair runs outside the round count. A test guard hashes the test files, so a worker cannot pass by editing them. Role runs get harness clamps (Claude Code `BASH_MAX_OUTPUT_LENGTH`, Codex `tool_output_token_limit`, an opencode scratch `TMPDIR`) and `HONCHO_ENABLED=false`. Every run report gains a per-role scorecard.

  Removed: Jev, `bars`, `objective`, climbing, the learned start, the cheap try and the chore start. Old profiles migrate when they load: `typesafeApiKey` becomes `decisionKey`, and `TYPESAFE_API_KEY` is no longer read.

- ad2886a: Part of 2.0.0. A detached daemon drives each run from its `events.jsonl` through a pure state machine; the session sees `run_start`, `status`, `answer`, `cancel`, `result` and `profile`; a judge role decides what no rule can; parked questions go to `notify.url` (ntfy). Runs started on 1.5 finish on 1.5.
- 6caed33: Part of 2.0.0. `catherd scorecard prepare|record|compare` measures a catherd version on four fixed tasks (a raqam
  task, a catherd milestone, a replayed Sanitell task and an injected-failure task) and compares it against the 1.5.0
  baseline: finished with no intervention, interventions, review rounds, wall-clock time, quota used and a first-try
  pass. It is a contributor command that runs from a source checkout (`docs/dev/scorecard.md`).
- 626489a: Part of 2.0.0. Blocked replies name one of six reasons the daemon acts on (Jev classifies the rest); a limit fails over to any configured backend, never down, Claude last; catherd runs each milestone's check and lands only the commit it verified (the verifier's `HEAD:`, `catherd gate run`, failures the base already has let through, a gitleaks scan, heavy slots that wait out a loaded host); a run with a base branch lands when origin's base contains it, after merging a base that moved.

### Minor Changes

- bbc1104: opencode rungs can run any provider opencode enables, not only Zen and Go. Discovery lists every enabled provider's models, so a custom provider in opencode's config (an OpenAI-compatible endpoint, say) is routed instead of skipped, and its model and variants are validated before dispatch like Zen and Go. A provider other than Go bills `metered`.
- 8bc03fc: The panel, v2. A dashboard of every run on the machine: what runs now, what waits for you, and KPIs and charts for the last 7 or 30 days. Each run is a live graph from the plan through every milestone step; any node opens its prompt, its log as a readable transcript (or raw), its output, its diff and its checks, with model, time, tokens and cost. Pause and resume one run, cancel one role. Setup edits every profile setting for any repo, shows the change before it saves, and opens at once from a probe cache. Questions show their context and one-click answers.
- 8b2f969: The cheap tier. opencode: a mid-run abort that the agent recovered from ends `ok` when the reply has its `STATUS:` line; a run whose model has no price in opencode's own figures is priced from the catalog; its transcript shows as the other backends' do. Routing: a lane on the critical path of the remaining plan starts no lower than the role's default rung, a lane with slack is held to the next easier difficulty's bar, and a `Chore: yes` lane starts on the cheapest capable rung. A cheaper rung with at least as good a record on this machine (5 or more finished lanes of that difficulty) is preferred, and the why names both records. A fix round of only lint, type-check or naming findings runs once on the cheapest rung first. `catherd catalog outcomes [--json]` prints each rung's first passes, rounds and findings per lane.
- 8b2f969: The panel: a role's log reads newest first; the run graph zooms, fits and opens full screen; a step that is one event no longer shows 0s, and a fast check shows its own time; model names drop their provider path; a new Models page plots cost per task against intelligence for every model catherd can route to; backends and labs keep their brand colours on the dashboard and the Models page.
- 4e28b0c: Runs stop paying for walls and process. A lane's Owns is a hint: a worker changes whatever its task needs and reports each file outside its Owns on an `EXTRA:` line with its reason, which the reviewer reads; the test guard and the `out_of_scope` stop are gone. A stop that names a sibling's file waits for that sibling instead of being dispatched again. Lanes talk through a team channel (`catherd team send|read|wait`, and the same tools on the role server, after T3 Code's thread tools): messages between lanes are queued, and the architect's and the owner's reach a running opencode lane at once. No gate judges an acceptance line about commit messages, test-first evidence or file scope. The architect may add, change, split or drop tasks, lanes and milestones mid-run with no approval park. A red Check gives at most five findings per item. The decision model's fallback picks the lowest level that is enough, summed from the bottom. A fresh milestone tree's submodules borrow objects from the main checkout instead of cloning them again from the remote.

  Cursor is retired: a profile that names a Cursor rung loads with it dropped and a note.

- 7e30741: A run's event log lives in one SQLite database, `catherd.db` in catherd's data folder, instead of its folder's `events.jsonl`; runs an earlier build started keep their files.
- 7e30741: Finished runs an earlier build kept on files are copied into the run-state database at a session's start, read-only, so cross-run queries see them; each run's end backs the database up under `backups/`, keeping the last seven.
- 7e30741: Dispatch records and team messages live in the run-state database beside the events; a run an earlier build started keeps its `runs.jsonl` and `team.jsonl`.
- 057b98d: The architect loop, behind `engine: architect` in a profile: the architect is woken by events, delegates tasks, runs checks, keeps a ledger and finishes the run through its tools, and the researcher and the writer are on call to it and to workers through `delegate_task`. Every other run keeps the 2.0 pipeline.
- 7cc71d7: The architect drives every run: the `engine` switch and the 2.0 milestone pipeline are gone (plan approval, milestones and rounds, the judge, the automatic rerun of a red check, the admission wait). A run an earlier build started is read but never driven. Runs have spec D10's caps (`caps.wallMin`, default 12 h, and `caps.attempts`, default 4 per ledger task), a same-rung retry with nothing new is refused as stalled, and a worker may stop `impossible`.
- 1e4e690: Role ladders replace the decision model: each role's rungs, in profile order, are its ladder. The architect names any rung on a role's ladder, or none: a task then runs on the default, and a ledger task tried before climbs one rung after a failure, a timeout, a too-hard stop or a review BLOCKER, never after a provider error or a quota limit. `capabilities` reports the ladders. The decision model, its key, `credentials.json`, its doctor rows and `init` questions, its panel section and Decision tab, and the `judge` role are removed. A profile an earlier 2.0 build wrote loses its `decision` block and `judge` role once, and its architect gets `workspace-write` and the default caps.
- 8d82e16: Landing (plan 50). `run_start` takes `base` again: a base run works in a tree of its own on a branch named after it, and the architect's `land` commits, pushes that branch (never `base` or a default branch, never forced) and opens one MR per run with `gh` or `glab`. `land {final}` needs a green full check and a verifier PASS on the pushed commit, merges a moved base first, and asks the owner one question, merge?, whose answer ends the run. One verifier now runs once on the integrated product, and a PASS with no command run is a FAIL. Removed: `catherd gate`, `catherd lock --role`, `catherd catalog outcomes`, `routes.jsonl`, `outcomes.jsonl`, the milestone branches and the land gate. MIGRATION.md, "Landing and the one verifier (plan 50)".
- 1a4ff69: Converging reviews (plan 51). A reviewer reports IMPORTANT, NIT or PRE-EXISTING findings with their bug class; a review runs on another model family than the work it reads (marked same-family when its ladder has none); a re-review of a ledger task reads only the diff since the last one, and a fourth round is refused until the task is replanned. The architect logs each finding's handling and missed bugs with the new `findings` tool, and the MR's Known issues list what is left. The `ui-reviewer` role folds into the reviewer: profiles migrate once, and the reviewer's default access is `full`. New: `catherd runs metrics`, a Metrics tile on the run page, and `catherd scorecard stage` for a per-task stage comparison. MIGRATION.md, "Converging reviews and the ui-reviewer fold (plan 51)".
- 1ae0711: The oracle rule (spec D9). A ledger task's `oracle` paths are now enforced: when a worker or writer on that task changes them, the architect's digest says HELD with the diff, and `land final` refuses until the architect accepts the change with `oracle_accept` and a reason, or the task restores the oracle. Accepted changes are listed under "Oracle overrides" in the merge request. Every other test edit stays allowed and reported: the merge request and the verifier's brief now list test cases the run removed and existing test files it rewrote, besides deleted test files and added skips.
- fcc7133: Per-writer worktrees and merge (spec D5). In a run with a base, each writing task works in its own worktree, cut from the run's branch, and a retry on the same ledger task continues in the last attempt's tree (`delegate_task {worktree, from: "clean"}`). When the task ends complete, catherd commits its tree, merges the run's branch into it, runs its fast check there and fast-forwards the run's branch; a conflict or a red check goes back to the same writer, and a change to the task's oracle holds the merge until the architect accepts it. Every running writer hears what merged, and a writer whose work would now conflict is told the paths at once. `merge {taskId}` merges by hand, `check {ref}` checks a commit apart or a task's own tree, the profile's `regen` lists lockfiles and generated files a merge regenerates, and every dispatch end checkpoints the writer's tree under `refs/catherd/`. `catherd profile set trees shared` puts a run's writers back on one tree; the blocked minutes count merge rework under `merge_conflict` and `merge_red`.
- f5d186d: Show architect runs as a live flow timeline with ledger tasks, dispatches, checks, idle reasons and run metrics. Reuse the existing detail drawer and preserve the graph for legacy runs.
- a68a715: The panel's run, Questions and Models pages are redesigned as bento layouts.

  - Run page: a summary leads it — the questions waiting on you, the roles working now, what stands out in the run (a
    failing last check, failed or cancelled role runs, limits, the biggest spender, outliers, waits, idle, the
    architect's share) with a link to each, and where the time and the cost went. The run flow chart reads more clearly
    (role-coloured bars, waits washed across the chart, a fixed inspector strip), the event timeline is a rail with
    time, offset and outcome icons, and the drawers are reworked.
  - Questions: a decision inbox. The waiting questions as a list that warms with age, the picked one beside it with the
    role's latest reply open, the next one opening after each answer, and arrow keys to move.
  - Models: the smartest model, the best value and the one used most up top, the cost chart with the frontier of
    models worth the money beside the model list, and a table of every model against every effort.

- 86daa03: Part of 2.0.0 (spec D6). Fast checks stream: a task delegated with `check` (or a worker task, with the profile's new `fastCheck`, set by `catherd profile set fastCheck "<command>"`) gets that check on the run's tree the moment it ends complete. Nothing waits on it; its result wakes the architect, and a red one is posted on the team channel. The architect is told to call the full check once, on the integrated product before land final, and not to ask for the base up front. `catherd runs` and the stage comparison show the fast-check share and the share of the wall time the run waited on a check.

### Patch Changes

- 2d6c5eb: Every A-line of a run is owned by a milestone. The architect's brief and role text say each milestone cites the A-lines it delivers as `A<n>` in its plan.md section; a plan that leaves an A-line with no milestone is sent back to the architect naming the missing ids. The digest reads the A-lines from the milestone's whole plan.md section (it read only the heading before), and the verifier's brief names the A-lines its milestone delivers and asks for an `A<n> PASS|FAIL` line each.
- f462f3f: Three fixes from the first 2.0 beta run. A run started from Claude Code or Codex now dispatches its architect and verifier on that host's default rungs, where it used to stop with "roles.architect.rungs needs an orchestration host" when the profile named none. `catherd init` remembers the host it ran on, so the panel's Setup page lists the roles instead of failing; with no remembered host it shows the architect and verifier as set by the session's host. `catherd init` no longer ends with plugin install commands when its own report shows the plugin ready, and on a pre-release it names the next channel's marketplace.
- e339700: Claude Haiku 5.5 is in the catalog, so a `claude:` or `claude-code:` rung can name `claude-haiku-5-5` at every effort the Slopalytics index lists.
- a37a4f6: Update the MCP SDK to 1.32.1 and zod to 4.6.7.
- 6c08f86: A lane is no longer blamed for a test file that a running sibling lane owns and changed. The shared milestone tree cannot tell which worker made that change.
- 086ee80: Older model versions are hidden by default. When a newer version of a model is offered on the same backend (GPT-6.1 Sol replaces GPT-6 Sol on Codex, Claude Sonnet 5.5 replaces Sonnet 5, and so on), `catherd catalog list` leaves the older one out unless you pass `--older`, failover no longer picks it as a stand-in, Setup's model picker shows it only under "Older versions" (a rung already on a role stays and names its newer version), and the Models page starts with its switch off. Profiles that name an older model keep working unchanged.
- b140fa2: The ideas sweep: most of the open follow-ups fixed.

  The run report and digests: each known issue names where it came from (the reviewer or the verifier), A-lines written without an id are numbered `A1`, `A2`, … and a one-milestone run maps every A-line to its milestone. Each list in the report is capped with a "+N more" line, and the report lists the worktrees still on disk. A rule that holds " — ", a finding with a spaced hyphen, a decision wrapped over lines or written as a numbered item, and an `ENV:` line inside a code fence are all read as meant.

  The panel server, `summary` and `scorecard`: a watched transcript is read from where the last poll stopped, not from the start; the run summary and the scorecard leave pauses out of their wall-clock; the summary shows the run's pinned budget; the run index logs a run with a corrupt `meta.json` once and forgets runs that are gone; the overview's date range is capped at 366 days; the panel's CSP names its live socket; a baseline task that did not finish is noted in the verdict; and scoring locks the results file and removes the folders it made.

  The panel: a reconnect never shows an older run than a patch already did, a Setup save writes only the fields you changed, and a run document too large to show whole says so, without cutting a character in two.

  The run itself: a paused run claims no worktree and routes no milestone until it resumes; `claimTree` clears only catherd's own stale worktree entries; a milestone waiting for memory is reported once, and again when it starts; a daemon that dies right after launch is revived at most once per interval; and the base-failure audit names the part of an `a && b` check that never ran.

  Routing, lanes and starting a run: a lane with only a `Kind:` routes on that kind, with or without Jev; Jev is asked about at most a few lanes at once and quota usage is read once per batch; `run_start` says whether the maxEffort cap, the coding floor or the index left a role without a rung; validate's fix no longer asks for a catalog sync when an index exists; preflight and Jev's verdicts read the run's pinned profile; a workspace child whose profile cannot be read leaves no run folder; state.md's Next moves only when `result()` collects the record; the bare-verdict hint fires only for a verifier that exited ok; and a merge release's git check runs before the workspace lock. The protocol's re-check step names every item the fresh verifier will re-check, a passed item whose files changed included.

  Delivery, the end push and the infrastructure: a role-thread refusal is written once per notice; the end push reads the owner under its lock, retries once when busy and reports an ambiguous delivery as such; a login profile that prints text no longer corrupts the login env; a timed-out retry hook keeps the stream's retries; the reserved gate-env names come from what the adapters set; the role lock file is versioned (old files still read); `Allow:` matches a hit printed as `./path`; carried gate passes are shared between checkouts of one origin; and `status` shows a run's starting session as live only while it owns the run.

  Two fixes from the sweep's own run: the verifier's gate and a lane's check run with an env that drops `CATHERD_ROLE` and `CATHERD_DISPATCH_ID` and a TMPDIR outside the role's scratch, so CLI tests no longer fail with `E_ROLE_SCOPE` under a role; and answering a BLOCKER park past the review cap opens one more fix round (the answer `accept` still lands the milestone with its known issues).

- e09feb9: `catherd lock` exits as soon as its command does; it no longer holds the process open for the half second it allows the command's pipes to drain.
- 8a4f42a: A model the account cannot use (Codex's `model_not_found`, Claude's "may not have access") no longer reads as a CLI too old: the dispatch ends `limit` with the error code `model-unavailable` ("model not available to this account"), its quota is held, and the next turn or task starts on the next rung whose quota is free instead of repeating the same rung.
- e09feb9: `catherd init` no longer waits 1.5 s and asks opencode for its models a second time when the opencode CLI did not answer at all; the retry stays for a service that answered with an empty list.
- 086ee80: Panel polish from a live review. The run graph's zoom, fit and full-screen controls are a small overlay; the graph pans by dragging with the mouse, and in full screen it fills the dialog, zooms with a trackpad pinch around the pointer and keeps zoom there only. The Models page is the chart itself, edge to edge, with the title, axis switch and model list floating over it; a lab's models share its colour, deeper for the stronger ones, every line solid with hollow dots, a crosshair to both axes, the tooltip of the dot under the pointer, and the list strongest first. Setup's model picker lists one row per model with its efforts and their scores, with the search, a provider filter and Add fixed while the list scrolls. Cursor shows its own mark.
- 1d9d00d: Fix milestone gate integrity, orchestration retries and reminders, usage pricing and reporting, and panel run metrics.
- fbf1bfb: Run each milestone's Check in the daemon before any verifier, so a verifier reviews only the A-lines the Check does not cover. A plan line `(Check)` on an A-line marks it covered, and `Baseline: <check item>` accepts that item's pre-existing failures. Plan task ids may be dotted, such as `### Task 1.3`, and the plan lint warns instead of refusing.
- 3d0515a: Release hardening for unattended runs. `catherd profile set land.autoMerge true` (off by default; pinned when a run starts) makes a base run merge each landed milestone into the base itself, with a `--no-ff` merge commit `chore: merge <run> <milestone> <title>` pushed without force; any git failure falls back to the push question. A plan line `Format: <command>` formats each milestone's staged owned files before its commit, and a pre-commit hook refusal becomes a fix round. A land or verifier park answered with a fix starts a fix round; `retry` runs it again and `accept` waives it. A resumed claude-code dispatch records its own cost, not its thread's running total. A passing test line no longer reads as a failure, a reply with no `STATUS:` line is asked again once, a `check_broken` stop parks at once, a lane whose rung left the profile is routed again, and the daemon waits for free disk instead of stopping for good on a full disk. Two milestones that land together both merge (a push that lost the race merges again on the new base), and a failed auto-merge shows under the panel's landing filter and Setup's Land tile. A proxy, network or overloaded-server error retries the lane's own rung with a backoff instead of climbing it, and parks after 30 minutes. A verifier reply with no `VERDICT:` line is asked for it once, and a judge that dismisses every finding of a verifier FAIL lands that commit.
- 8a4f42a: Test only: the plan-input test that compares a slim and a bloated unit context no longer fails when its two runs are made in different seconds (a loaded CI shard); both now share one home, so the first run's events are still there.
- 54a1184: A dispatched role runs with `HONCHO_ENABLED=false`, so the Honcho memory plugin no longer stores a role's brief as the owner's own words.
- b9f8bcc: Three fixes from the first 2.0 smoke run. `catherd status` on an ended run prints "Ended: <outcome> at <time>, took N min", counts its age from start to end, and drops the stale Next and Protocol next lines. A milestone digest lists the run's A-lines, marked as not mapped, when none of them is cited as `A<n>`, instead of "none". The report no longer repeats a milestone digest's own H1 under its `## M1` heading.
- d6437eb: Fixes from the first real stage-1 runs. An architect turn that ends on a quota limit now starts the next turn at once on a rung of its ladder whose quota is free, and waits only when every rung is held; a delegated task with no rung skips a held rung the same way. A failing full check is compared with the same command on the base, which catherd runs itself once per base commit: when every failure is inherited, the check counts as passing for the verifier and the final land, and the inherited failures are listed under Known issues in the merge request. `catherd status` shows an architect run's last check instead of the old milestone notes, and catherd's own lock tests pass when the suite runs under `catherd lock`.
- f26520f: Fixes from a full review of the 2.0 line. Roles can write only `plan.md`, `dossier.md` and lane files, so a read-only role can no longer forge run events or write into milestone worktrees. The panel token works once, and panel sessions expire when idle. A refused judge is started again, and an owner's answer reaches the next brief. The daemon stops when it cannot record a failed effect, and it settles each dispatch only once. The unit-context cap is enforced in bytes, and plan headings inside code fences no longer cut tasks. A 1.5 profile with Jev off is no longer moved onto TypeSafe. The live run page keeps its socket open after a failed read.

## 1.5.0

### Minor Changes

- 8d16c33: catherd 1.5: everything the payment, platform and identity runs left open. Upgrade, run `catherd doctor` (it names the Claude agent links to refresh), update the plugin and start a new session; MIGRATION.md, "From 1.4 to 1.5", lists what you will notice.

  **Roles and ownership**

  - **A role never owns the run.** The supervisor sets `CATHERD_ROLE=<run>/<name>` in every role's environment. A role's process never claims a run, and its catherd MCP server refuses the coordinator tools (`peek` of another role, `result`, `dispatch`, `run_start`, `climb`, `land`, `park`, `cancel`, `set_next`, `answer`, `profile_set`, `test_push`, `run_pin`, `lane_set`, `owns_add`, `record_agent_run` and the workspace writers) with the new `E_ROLE_SCOPE`; their descriptions start "Orchestrator only". A native Claude subagent's agent file forbids them. A catherd notice is never sent to a role's thread: a refused one is a failed delivery, logged, and `status` warns.
  - **catherd's tools in every role.** Headless Codex and Claude Code roles get the `catherd_role` MCP server isolated or not (a 30 s start timeout; `doctor` probes its cold start). An isolated Claude Code role with it runs with `--strict-mcp-config --setting-sources "" --disable-slash-commands` instead of `--safe-mode`, keeping your login, provider, model, deny rules and allowed network domains. Roles can run `catherd run-file read|write <run> <path>` and `catherd gate check|pass <run> …` from their shell, bound to their own run and their role's tools (every role reads run files, the architect and researcher write them, the verifier runs the gate); opencode, Cursor, Grok Build and Antigravity briefs name them. The role server's `read_knowledge` reads the run's repository.
  - **The brief carries the lane.** `dispatch` with `lane` inlines the lane file as it stands. Codex and Claude Code roles, and isolated opencode roles, get their own scratch `TMPDIR` (`<run>/scratch/<name>/`, named in the brief); Cursor, Grok Build, Antigravity and non-isolated opencode roles keep their inherited one; `catherd runs clean [<id>]` removes the scratch of runs with no live role.
  - **The writer has an implicit docs lane** (its brief's `Owns:`, else `docs/**` and `*.md`), and edits are attributed per dispatch, so a writer's edits are never a lane's violation.

  **Delivery and the loop**

  - **Results reach a Codex coordinator when its server is gone.** When a role ends, its supervisor queues the same notice to the Codex owner's thread (`codex queue --remote unix://…`), under the same receipt as the server's push, so it is never sent twice. The skill tells a Codex coordinator once to run inside tmux, and to end a goal continuation with no tool call while only roles are live; `peek` answers `actionable: false` with its reason when nothing is the coordinator's to do.
  - **The thread travels.** Every catherd message names the role's `thread:`; `dispatch` takes `thread: "latest"` and refuses a thread that name never ran on in the run (`E_ADMIT_THREAD`). Before a resume, `dispatch` stops what the thread's last turn left running.
  - **A short final reply never overwrites the report:** `result` returns the longest STATUS-bearing message and the later ones under `later:`.
  - **"waiting for orchestrator"** shows only for the current owner and a record that ended within 24 h; `status` without a run shows the live runs, else the waiting ones, else the newest.
  - **`state.md`'s Next** advances when `result` reads the dispatch it names, and the verifier's step closes (on its pass, its record, or its owner gone) and shows its age.
  - **One boot per machine:** the catalog sync and reconcile at MCP server start run in one server at a time.
  - **Testing the push from a Codex thread:** `catherd doctor --test-push --thread <uuid>` and the `test_push` tool.
  - The 1.1 push minors: a session that no longer owns a run leaves its usage limits to the owner, an edit with no path shows `edit`, and a Claude role's activity shows its tool's first argument.

  **Verifier, gate and environment**

  - **Monorepo gates.** `gate_check` hashes tracked content (`git ls-files -s`) plus every lockfile; an ignored output not built yet is "absent"; `node_modules` is walked only when a path names it. `gate_check(run, milestone)` lists the milestone's recorded items, so a fresh verifier reuses their names. A re-check goes to a fresh verifier with the failed items and a 10-minute cap per command. `gate_pass` names its commit `<HEAD>+uncommitted` when an uncommitted change lies under its paths; a gate path `./` means the whole repo.
  - **The gate environment.** `catherd knowledge env set NAME=value | NAME --from VAR`, `env rm`, `env list`: per-repo variables (secrets by reference only) that reach the verifier and preflight.
  - **Per-role timeouts:** `roles.<role>.timeouts.{idleMin,wallMin}`; a `catherd lock` command still writing output keeps its role's wall clock alive, and waiting for a slot counts as activity.
  - **The environment is not the work.** `VERDICT: BLOCKED: environment — <probe>` (or `record_agent_run`'s `verdict`) is a blocker to surface, never a fix round; an `ENV:` line in a reply becomes an `environment:` hint and `climb` refuses it (`E_CLIMB_ENV`); `STATUS: flaky` is a worker outcome.
  - **Preflight** runs in your login environment, tells `cannot-start` (a missing command, Docker, DNS, a denied permission) from `fails-as-expected`, skips a pnpm filter that matches nothing, runs only lanes not landed (or the `milestone` named), reports `lock-busy` instead of timing out, and warns about a fast check with no lint step when the repo has a linter.
  - **Reviews:** a `STATUS: partial` review is not the milestone's review (`land` refuses it), and open BLOCKER or BUG lines make the next step the fix round.
  - **opencode provider outages fail over** like a usage limit (`provider-unavailable`) after 3 retries or 3 minutes of them.
  - **doctor** warns about a Docker client `proxies` block and toolchain caches you cannot write; `catherd doctor --docker` probes a compose network by service name and warns under 10 GB free in Docker's data root. The verifier brief ends with `docker image prune -f`, each dispatch has its own `TESTCONTAINERS_SESSION_ID`, and acceptance items are the verifier's by default.

  **Routing and cost**

  - **Every enabled rung can start.** An unpriced rung on a plan or subscription costs 0 in its tier; the profile's ladder order breaks every tie, and equal scores start on the quota the run has used least. `profile validate` warns about a quota no worker rung starts on and a kind and difficulty no worker rung reaches.
  - **Climb ladders only go up**, each rung at least as strong as the one before it; a lane starts no lower than an easier difficulty's start, and `route` says when no rung clears the bar (and the closest) or a tie decided.
  - **`route` returns little:** `lane`, `role`, `rung`, `ladder`, `backend`, `agent` and a one-line `why`. Every decision, with its provenance, is a row in the run's `routes.jsonl`, as is each lane's final outcome beside Jev's answer. `route(run, lanes: [...])` routes a milestone's lanes in one call. A lane header declaring `Kind:` and `Difficulty:` wins over Jev. `dispatch` with `lane` takes `rung` optionally.
  - **Catalog:** a new release of a family takes at least its predecessor's values at the same effort; the Artificial Analysis Intelligence Index joins the calibration sources; a stand-in needs values of its own on at least 3 dimensions; a sync spreads `adjacent` values upward only. A treat-like reads "like X", an inferred stand-in "inferred from X"; `catalog_sync` answers `busy` at once while another sync runs; and the 1.2 routing and catalog minors are closed.

  **Runs, programs and lanes**

  - **Workspaces** (#43, new in this release) survive an unreadable member run or a torn line, land only a step's completion milestone behind their lock, have no budget cap by default (`workspace_budget` sets one; minutes count from the first child), and can release a step only once its landed commit is merged into a base ref (`release: "merge"`).
  - **Pause on one blocker:** `catherd pause --machine "<reason>"` or `--workspace <id>`, `catherd resume --machine` (or `--workspace <id>`), and the `workspace_pause`/`workspace_resume` tools; dispatch is refused with `E_ADMIT_PAUSED` until resumed, and `status` shows it first.
  - **Two runs' verifiers never overlap:** `catherd lock --role verifier` holds a machine-wide lock per run.
  - **`catherd runs supersede <id> --by <id>`** (and `run_start`'s `from`) closes a run with a pointer; `status` hides it, and dispatching into it is `E_RUN_NOT_LIVE`.
  - **Lane editing:** `lane_set(run, lane, field, value)` edits one header line; `owns_add(run, lane, paths, why)` grows a running lane's Owns; `After: <lane>` orders lanes (`E_ADMIT_ORDER`); `Allow:` excuses known hits of a check; `write_run_file` validates a lane's header values. Header lines are read only from the header block under the title.
  - **Pinned per run:** `run_start` records the profile, each role's access and each backend's isolation; dispatch keeps them, a later change shows in `state.md` and `status`, and `run_pin` or `catherd runs pin <id>` re-pins.
  - **Knowledge keyed by the git origin**, so every worktree and clone of a repository shares one `knowledge.md` and gate environment; the old toplevel-keyed files are merged in on first read.
  - **The milestone digest** lists the commits, the reviewer's findings and the open questions; `land` counts only a verifier named exactly `verifier-<M>` and leaves parked and paused time out of the minutes.
  - MCP: 38 tools (`test_push`, `run_pin`, `lane_set`, `owns_add` and the workspace tools added).

  **Fixes**

  - `dispatch` refuses what admission would refuse before it routes, and routes a lane once when two dispatches start together; the first milestone's skip is judged from the HEAD the run started on; a markdown-wrapped verdict gets a fix line that names the bare `VERDICT: PASS`; ownership wording in a blocked climb is read more exactly.
  - `init` stops a `bun add -g` after two minutes and says "shadowed" when another `catherd` comes first on PATH; doctor's Claude Code access row reads every bound repo's sandbox setting; `profile show` aligns its access column; `network: false` on a role that does not write is a warning; a failover suggestion comes only from backends the profile names.
  - Cursor models are listed only from Cursor's own `agent`; an isolated Grok or Antigravity rung is checked against the API key's own model listing; catherd rewrites its Grok `sandbox.toml` block in place and refuses a link it cannot follow.
  - The Runs page shows open milestones with their descriptions, opens a session on the run it was opened for, else its first live role, and stops polling a finished role.

  **Not in 1.5**

  - "Later" (race mode, automatic retro, `catherd bench`, standalone binaries): no run evidence asks for them yet.
  - The logic and hard bars sit above every Sol rung: the owner's call between percentile bars and a stronger top rung, unchanged in this release.
  - Haiku 4.5's terminal value (waits for an external source) and re-recorded Artificial Analysis fixtures (need the owner's key).
  - Live coverage still missing: a live run, not code.
  - Jev hit-rate review and difficulty calibration need outcome data first; 1.5 logs it in `routes.jsonl`.
  - Milestone per branch and stacked milestones: a product change to how runs map to MRs.

- 25c2e5d: Coordinate independent repository runs from explicit workspace members, with landed-milestone dependencies,
  a frozen shared contract, aggregate budgets, workspace MCP tools and read-only workspace CLI views.

### Patch Changes

- 4dd047c: Provide native headless Codex and Claude Code roles with catherd run-file and gate MCP tools without changing user configuration, and show when unread results await the orchestrator.

## 1.4.0

### Minor Changes

- 075df3f: Support orchestration from native Codex alongside Claude Code, with host-aware ownership and omitted architect/verifier defaults, optional Claude dependencies, durable native queue completion delivery and shared plugin skills. Preserve explicit profiles and the existing reviewer/verifier landing gate.

## 1.3.0

### Minor Changes

- cc72c97: catherd 1.3: three new worker backends, Cursor, Grok Build and Antigravity, each off until a profile puts a rung on it. Nothing to migrate: upgrade, run `catherd doctor`, and start a new Claude Code session (see MIGRATION.md, "From 1.2 to 1.3").

  - **Cursor (`cursor:`).** `cursor-agent` 2026.09.28 or newer, briefs on stdin, the effort as the slug's suffix (`cursor:gpt-6-sol#xhigh`). `workspace-write` runs in Cursor's sandbox without `--force`; doctor runs the five access probes through its sandbox runner. Isolated runs need `CURSOR_API_KEY` and get their own `sandbox.json`.
  - **Grok Build (`grok:`).** xAI's `grok` CLI on a Grok login or `XAI_API_KEY`; see the README's Grok section for its access modes and isolation.
  - **Antigravity (`antigravity:`).** Google's `agy` 1.2.13 or newer, on a Google login (plan quota) or `GEMINI_API_KEY` (the Gemini API project). catherd never runs `agy -p` while agy is signed out, since it would open a browser. agy has no read-only mode: a read-only role runs on it only isolated, where catherd's own settings deny writes and commands; `profile validate` refuses it natively. Doctor shows the plan quota left (`quota:antigravity`).
  - **Generic groundwork.** Admission refuses to resume a thread under another access or network grant on a backend that keeps a thread's access. A CLI the OS cannot execute is "installed but cannot run", with the reinstall command. A logged-out backend never reaches a dispatch. An isolated backend that needs an API key does not validate without it, and the dashboard's harness row says so. Doctor's access row says "not tested" where a backend has no sandbox runner.
  - **Catalog.** Grok 4.7, 4.6 and 4.5, Composer 2.5, and Gemini 3.8, 3.7 and 3.6 Flash and 3.1 Pro join the families, so the public sources score them; a model a backend runs with no effort is scored at `#default`. Gemini fails over between Antigravity and Cursor (and Grok between Grok Build and Cursor) when neither the profile nor the backend names another stand-in; the new backends never stand in for the shipped ones.

- 7e8354d: `catherd knowledge show|add|path [--repo <path>]` shows a repo's knowledge.md and where it lives, and adds facts you already know (the targeted test command, a suite that needs a database) before a run learns them. An added line looks like one `land` records, marked "by hand".

### Patch Changes

- 8d0bc57: The catalog's Cursor ids and efforts now match Cursor's live model listing, so `cursor:` rungs read differently (for
  example `cursor:cursor-grok-4.6#high` and `cursor:claude-opus-5-5#high`), and Grok and Gemini fail over to Cursor at
  the same effort where both list it.
- e6a400f: Isolated Cursor runs keep the API key in memory, so `cursor-agent` no longer touches the macOS keychain.
- bb37224: Doctor's Cursor access probes now test what they name: `cursor-agent sandbox run` joins its arguments into one shell
  line, so catherd sends each probe as one quoted command, and a lock, temp, loopback, HTTPS or Docker check no longer
  fails, or passes without running, because of the split.
- bd98159: Ship GPT-6.1 Sol (`codex:gpt-6.1-sol`) in the catalog with its price and efforts. No DeepSWE, comparable Terminal-Bench or Arena score is published for it yet, so GPT-6 Sol at the same effort stands in until one is.
- 4c53547: Warn about settings that cannot work on this machine: `profile validate` and `catherd doctor` flag a `budget.usd` cap
  when a role or its failover stand-in runs on a backend that reports no dollar cost (Codex, Cursor, Antigravity), and
  `catherd doctor` flags a profile that turns the ui-reviewer on while `agent-browser`, which takes its screenshots, is
  not on PATH. Each warning names the fix.

## 1.2.1

### Patch Changes

- b1d20e5: Claude Sonnet 5.5 (`claude-sonnet-5-5`) is listed for the claude, claude-code and opencode backends, and Claude Code's
  `sonnet` alias now resolves to it.

## 1.2.0

### Minor Changes

- 04a48e2: catherd 1.2: scores and model facts from public sources, bars that span several dimensions, and a profile that never breaks because a rung lacks a score. Run `catherd init` after upgrading (it asks for an optional Artificial Analysis key and syncs), then start a new Claude Code session (see MIGRATION.md, "From 1.1 to 1.2").

  - **Public sources.** models.dev, OpenRouter, LiteLLM, Arena (LMArena), Vectara's hallucination leaderboard and Epoch AI, keyless, plus Artificial Analysis with your own free key (`init` asks after Jev's, so piped `init` now reads four lines: the Jev key, the Artificial Analysis key, the profile, whether to replace it; `ARTIFICIAL_ANALYSIS_API_KEY` wins; it is saved in `credentials.json` and workers never see it). The MCP server syncs them in the background at session start, each at most every 12 hours; `catherd catalog sync [--force] [--unmatched]` and the `catalog_sync` tool (26 MCP tools) sync on demand. A failed source keeps its last good answer; offline, catherd routes on the scores it ships. `CATHERD_NO_SYNC=1` turns the automatic syncs off.
  - **Calibration and confidence.** Each dimension has an anchor unit; other sources are fitted onto it (at least 5 shared rungs, R² ≥ 0.5). A value's confidence is `verified`, `measured`, `calibrated`, `adjacent` (the same model at another effort), `secondary` or `inferred`; the override still wins, then the better level, then the newer date, and a value older than 90 days drops a level.
  - **New dimensions and bars.** `agentic`, `steer` and `frontend` join `repo_code`, `terminal` and `honesty`. The default bars span several dimensions per kind and difficulty (a `terminal` lane gates on Terminal-Bench, a `ui` lane on WebDev), at the 25th, 50th, 60th and 75th percentiles of the rungs measured or better, each with its `barsWhy` in `scores.json`. Your override's `bars` now override per dimension; `null` removes a threshold.
  - **Unscored is a warning.** A rung with no value on a dimension the bars use takes its nearest stand-in's (ranked on price, context, release date, vendor, family, effort and its own values; Artificial Analysis's features with a key) as `inferred`, and `profile validate` and `doctor` list it as a "stand-in to confirm". The error "unscored rung without a treat-like" is gone. A save that fixes one of a profile's errors and adds none now goes through (`profile set`, `profile_set`, the dashboard's save), listing the errors still open.
  - **treat-like.** `catherd catalog treat-like --suggest <rung>` ranks the three nearest stand-ins; `--clear <rung>` and `--reset` remove your mappings, naming first the profile rungs left on an inferred stand-in or left unscored.
  - **Why a rung.** `route` reports each threshold of the lane's bar, the value used, its confidence and source (inferred values marked), the rung's speed and cost facts, and catherd's own run evidence ("12 lanes, 2 climbed, 1 partial"), which never changes routing; `catalog_query` and `catalog list` show the same. In the dashboard, `r` in Profiles syncs and shows each source's age and last error, `i` shows a rung's values and runs, and `t` opens the treat-like picker with the three nearest stand-ins first.
  - **Shipped scores.** `catalog/scores.json` carries the keyless sources' values with their source, date and confidence (never Artificial Analysis's), attributed in `catalog/ATTRIBUTION.md`; a weekly workflow refreshes them in a `chore(catalog): refresh scores` PR.

## 1.1.1

### Patch Changes

- 3751229: The runs page now counts a live role's elapsed time and a run's age in wall-clock time. It had shown 00:00 for every
  running role, because OpenTUI's clock counts from process start. Workspace-write workers can now write the
  toolchain caches that exist (Go build and module caches, the pnpm store, Bun's install cache, npm's cache), so a
  sandboxed `go vet` no longer fails with "operation not permitted" or starts cold in every lane.

## 1.1.0

### Minor Changes

- 8c0297e: catherd 1.1: results come to you, the protocol is enforced, and workers run their own checks. Upgrade with 1.1's own init (`bun add -g catherd-cli@latest && catherd init`, or `bunx catherd-cli@latest init`), then update the plugin and start a new Claude Code session (see MIGRATION.md, "From 1.0 to 1.1").

  - **Push, not `wait`.** A finished role reaches the Claude Code session that drove it as a message on its peer inbox (`<cross-session-message from-name="catherd">`), like a native subagent's notice, so the session stays free while roles run; a stalled worker is reported once the same way. `wait` and `CATHERD_TICK_MS` are removed; `peek` shows a run at once (open questions, live roles with their last event, unread records, the verifier's latest step, the next protocol step) and `result` reads a record and marks it read. A lost message loses nothing: records stay unread on disk until `result`. `doctor` has a `push` row (and says on Linux whether to set `crossSessionInbound`; `init` never changes it).
  - **Sessions.** Runs remember the Claude Code session that started and continued them, and only the session that owns a run (the last to `dispatch` or `peek` on it) is messaged about it; only that session's catherd server fails the run's roles over when they hit a usage limit. The Runs tab lists sessions, newest first ("earlier runs" for 1.0's), opens one on its runs, milestones and roles, redrawing as run files change, and opens a milestone on its digest; `runs list` and `status` group by session and their `--json` gains `session`.
  - **Workers can run their checks.** `workspace-write` roles get the network, loopback, the lock and temp dirs and a local Docker socket (Codex through `network_access` and `writable_roots`, alongside your own); `catherd profile set roles.<role>.network false` closes the network for a role and `null` clears it. `doctor` probes each of the five per backend (`access:<backend>`, with the fix for each that fails), and its Codex sandbox probe uses the current `codex sandbox` form.
  - **An enforced protocol.** `dispatch` refuses unknown `Kind:`/`Difficulty:` values (`E_LANE_INVALID`), routes an unrouted lane and appends the reply contract to every brief; `land` needs a reviewer record and a verifier verdict (`E_LAND_GATE`, with `skip: "docs-only" | "no-code"`) and writes the milestone's digest, `<run>/digests/<milestone>.md`, returning it as `digest` (the orchestrator's milestone message links it); `climb` sends plan and ownership problems to the architect (`E_CLIMB_DESIGN`); `run_start` returns the next protocol step and the milestone checklist, and `state.md` ends with `Protocol next:`.
  - **A faster verifier.** A per-repo gate ledger (`gate_check`, `gate_pass`) carries over unchanged gate items; the verifier runs independent items side by side, and `peek` and `status` show its latest step.
  - **Owner questions park one milestone** (`park`, `answer`), not the run; the other milestones go on.
  - **Processes catherd starts no longer see the session.** Workers, the supervisor and a command under `catherd lock -- <cmd>` no longer get `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_HOST_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET` or `CLAUDE_CODE_MESSAGING_TOKEN`; a script that read the session id must take it as an argument.
  - **Failover and validation.** The default failover uses only stand-ins that clear the same bars as their rung (Luna high to OpenCode Go's Luna, Sol medium to Kimi K3; Sol high and xhigh have none, so a limit there pauses the lane). A profile written by 1.0 keeps its own map: `validate` warns on a downgrading stand-in (its fix removes the entry), on a Claude stand-in while another plan could stand in, and on a ladder that goes down; warnings never block a save. `profile show` and the dashboard say "scores borrowed from X" for a stand-in with no scores of its own.
  - **Install and launch.** The marketplace fetches the plugin over HTTPS (no GitHub SSH key needed); the plugin starts its server through a stamped launcher that runs the global `catherd` at the plugin's version, else `bunx catherd-cli@<version>` with its cache in `~/.cache/catherd/bunx` instead of `$TMPDIR`; `init` installs the global command at its own version (`--no-global` skips it); `doctor`'s `mcp` row starts the server as the plugin does and names the reinstall command; the shipped defaults' access rows are info, not warnings.
  - **25 MCP tools:** `wait` removed; `peek`, `gate_check`, `gate_pass`, `park` and `answer` added.

## 1.0.0

### Major Changes

- df2b299: catherd 1.0: a rewrite, and a clean break from 0.x. Run `bunx catherd-cli init` once after upgrading; it moves your 0.x files aside and sets 1.0 up (see MIGRATION.md).

  - **Runs that survive.** Every worker runs detached under a supervisor with idle and wall timeouts, writes straight to disk and is recorded exactly once, even when the MCP server restarts mid-run. Admission is atomic, parallel lanes are checked for overlapping files, and a write outside a lane is reported.
  - **Three backends behind one adapter:** Codex, headless Claude Code (`claude-code:` rungs, beside native Claude subagents) and opencode v2 (OpenCode Go and Zen). Each has a probe with a minimum version, optional isolation, and per-role access (`read-only`, `workspace-write`, `full`) with how strongly the backend enforces it.
  - **A discovery catalog.** catherd lists what each backend offers, scores models from dated sources, ranks cost by how you pay (plan, subscription or per token), and lets you map an unscored model with `treat-like`. Jev is optional: without a key, each lane's own Kind and Difficulty route it.
  - **Profiles, schema 1:** per-role ladders, access, failover to a rung on another quota, a budget and timeouts, kept through `catherd profile`, the TUI or `/catherd-setup`; native Claude roles get linked agent files.
  - **A full CLI:** `init`, `doctor` (one row per check, each with its fix), `profile`, `status`, `watch`, `runs`, `catalog`, `lock` and `capture-fixtures`, with stable exit codes, one-line errors and a log with secrets redacted. catherd keeps its folders `700` and its files `600`.
  - **A new TUI** after opencode's: Status, Profiles and Runs tabs, a command palette, and edits that are saved only through a diff.
  - **21 MCP tools**, three of them new (`cancel`, `record_agent_run`, `wait`); every failure is `{ code, message, fix }`. `dispatch` returns as soon as its role starts, so independent roles run side by side, and `wait` collects their records.
  - Needs Bun 1.4 or newer.

## 0.2.1

### Patch Changes

- 766596f: Briefs pin the lock command to the running catherd version, so a stale `bunx catherd-cli@latest` cache can no longer break it, and `preflight` skips a lane's check when the file it tests does not exist yet instead of failing the run.

## 0.2.0

### Minor Changes

- 78b7e6c: Redesigns the TUI as one bordered-panel frame with a two-pane master/detail layout, a dashboard for the bare `catherd` command, and a single accent colour, replacing the per-row 🐾 clutter and truncated footer.

### Patch Changes

- 183ad9a: `init` finds a Jev key already saved at `~/.config/typesafe/api_key`, so a user who has one never types it again, and the key prompt accepts a pasted key.

## 0.1.0

### Minor Changes

- First release: the `catherd` CLI (profile editor, `init`, `watch`, `lock`, `catalog refresh`), the MCP server with Codex and opencode runners, Jev routing with the model ladder, and the Claude Code plugin with the orchestrator and setup skills. Autopilot guard rails: quota failover, preflight, per-repo knowledge and a run budget.
