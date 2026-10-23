# catherd panel v2 — design

Status: draft for the owner's approval, 2026-10-23. Extends spec 2.0 decisions 23–26 (the panel is remora's console,
copied); nothing here reverses them.

## Why

The panel is the face of catherd 2.0: the daemon runs everything headless, so the panel is where a person sees what
the system is doing, steers it and answers it. Today it shows almost none of the data a run records. The run page is
a raw event log, Setup shows rungs only (the rest of the profile is invisible), there is no overview, and Questions
is a bare form. The owner's words: "without a usable panel, one of the most important features of 2.0 is lost."

Goal: open the panel and understand at once how the system is working right now, see every agent's prompt and log,
and act. Any user, at any level of knowledge, can follow a run and use catherd from it.

## Goals

1. **Dashboard home**: an overview of every run on the machine, live and historical.
2. **Live run page like GitHub Actions**: a graph from the entry point through every step in order, nodes changing
   status live; any node opens what it received (prompt), what it is doing (live log) and what it produced (reply,
   diff), with model, duration, tokens and cost.
3. **Setup that is visual and complete**: provider icons, each role's ladder as a visual, and every profile setting
   editable, with the effect of a change shown before saving.
4. **Questions that are hands-on**: each question with its context and, for known reasons, one-click answers;
   answerable from the run graph too.
5. **Self-explaining**: plain one-line explanations of every concept, plain-language node status, empty states that
   say what to do next. No tour.
6. **Run control**: cancel the run, pause/resume one run, cancel one live role, answer.

## Non-goals

- Rerunning a role or editing the plan from the panel (they touch the protocol; later).
- Persian/RTL: the copy stays English (owner decision, conventions test).
- Masking secrets in prompts or logs: the panel is local (127.0.0.1 + one-time token); data is shown as recorded.
- A new on-disk index or database: run files stay the only source.
- Full graph on phones.

## Anti-goals (a failure even if it works)

- A pretty graph that hides what happened: every node must lead to the raw truth (brief, raw stream, files).
- Numbers without meaning: no KPI or chart without a one-line "what this tells you".
- A slow panel: no page may sit on a skeleton for seconds (Setup does today, ~10 s, because it probes every CLI on
  each load).
- Drift from the design system: refine the copied console's tokens and HeroUI v3; no second visual language.

## Constraints

- Stack stays as spec 2.0 decision 23: Vite, React 19, HeroUI v3 + `@heroui/styles`, Tailwind v4, TanStack Router and
  Query, `@hey-api/openapi-ts` client generated from the server's OpenAPI (zod), Geist, `@gravity-ui/icons`,
  oxlint/oxfmt, Vitest, Playwright.
- `web/src/conventions.test.ts` stays the rule: only `index.css` + `theme.css` (library CSS such as React Flow's is
  imported from `index.css` after the two required imports), no inline `style={}`, no hook files in component folders,
  no virtualization, English copy, no source/vendor brand names in our code.
- Server rules: every write goes through `ProfileService` (profiles) or the run store's existing writers (events);
  `127.0.0.1` only; the one-time token login; OpenAPI generated from zod.
- Layers `domain → infra → adapters → services → entry` (`test/architecture.test.ts`).
- Tests never touch the network or real CLIs.
- New runtime dependencies for the UI only: `@xyflow/react` (React Flow), `elkjs` (layout), `react-markdown` +
  `remark-gfm` (rendered prompts, plans and reports; raw HTML stays escaped) and `recharts` (the dashboard's charts,
  added in the owner-approved design pass). Provider logos are
  bundled SVGs (simple-icons, CC0 or the vendor's published mark), no icon runtime package.

## What exists to build on (verified 2026-10-23)

Per run, under `~/.local/share/catherd/repos/<slug>/runs/<id>/`:

- `events.jsonl`: the event-sourced history (`src/domain/run-events.ts` union).
- `runs.jsonl`: one record per dispatch with role, lane, rung, attempt, failoverFrom, status, start/end, secs, tokens
  `{input, cached, output}`, costUsd, replyStatus, replyPath.
- `roles/<name>/<dispatchId>/`: `brief.md` (the full prompt), `events.jsonl` (the agent's raw stream: Claude
  `assistant/user/result/system` records; Codex `thread.started`, `item.*` with command_execution, file_change,
  mcp_tool_call, agent_message, `turn.completed`), `reply.md`, `stderr`, `supervisor.log`, `admit.json`, `spec.json`,
  `exit.json`.
- `routes.jsonl` (why a rung: ladder, decidedBy, Jev probabilities, provenance), `jev.jsonl`, `outcomes.jsonl`
  (start/final rung, climbs), `plan.md`, `lanes/*.md`, `digests/M*.md`, `report.md`, `ledger.md`, `meta.json`,
  `pin.json`, `scratch/<role>/fast-check.log|full-check.log`.

The machine: `src/domain/run-machine.ts` (actions), `src/domain/run-state.ts` (milestone status waiting → routing →
lanes → committing → review → fixing → verifying → integrating → landing → landed; lane pending/running/checking/
done/parked; run phase planning/approval/running/ended). `plan.ready` gives the milestone/lane graph with `after`
up front; `lanes.routed` gives each lane's ladder. Fix rounds, climbs, failovers and judge calls appear only as they
happen.

Today's API exposes RunView, a one-line timeline, cancel, answers, questions and Setup rungs. Not exposed: briefs, raw
streams, replies, dispatch records, routes, plan/lanes/digests/report, structured event fields, cross-run totals.
The run list replays every run on every request.

## Approaches considered

1. **Grow the existing pages in place** (add fields to RunView, more tables). Cheapest, but the run page stays a log
   and the data never forms a picture. Rejected: it is the thing the owner called bad.
2. **A new read model on the server + graph-first UI** (chosen). The server derives a structured *run model* (nodes,
   attempts, edges, statuses) from the run's files and streams model patches live; the UI renders it with React Flow
   and a side drawer. One source (the run files), one derivation (server side, tested), thin UI.
3. **Client-side derivation from raw events** shipped to the browser. Less server code, but the derivation would be
   duplicated outside the tested domain layer and would ship every raw file to the browser on load. Rejected.

## The design

### A. Server: the read model (services + entry)

- **Run index cache** (`services`): an in-memory map run id → summary (phase, outcome, title, repo, started/ended,
  wall minutes, totals: dispatches, tokens per backend and per model, costUsd, interventions, failovers, climbs,
  rounds, open questions). Keyed by the mtimes of `events.jsonl` + `runs.jsonl`; a request recomputes only changed
  runs. Covers every repo on the machine (`listRuns()` scan). 1.x runs (no `events.jsonl`) get a summary from
  `runs.jsonl`/`meta.json`/`state.json` with `engine: "1.x"`.
- **Run model** (`services`, pure derivation from events + dispatch records + plan): a directed graph.
  - Nodes: `start` → `architect` (plan, with approval sub-state) → per milestone: `route`, one node per lane
    (worker/artist/writer/researcher by kind), `fast check` per lane, `commit`, `review`, `verify`, `land` (and
    `integrate` where it occurs) → `judge` → `report` → `end`.
  - Every node has: status (`pending | running | done | failed | parked | skipped | cancelled`), a plain-language
    `now` line ("Codex is writing the code for M1.L1"), timings, and **attempts**: each dispatch or check run that
    belongs to it (round, rung, failoverFrom, climb), newest first. A fix round adds an attempt to the lane, review
    and check nodes; it is not a backward edge.
  - Future nodes are drawn as `pending` from `plan.ready` + the fixed protocol order; before `plan.ready` the graph
    is `start → architect → (milestones unknown)`.
  - Edges from `after` dependencies and the protocol order.
- **Detail endpoints** (entry/panel, all zod + OpenAPI):
  - `GET /api/overview?from&to&repo` — dashboard aggregates (below).
  - `GET /api/runs?…&repo` — list from the index (cross-repo, filterable).
  - `GET /api/runs/{id}/model` — the run model.
  - `GET /api/runs/{id}/dispatches/{dispatchId}` — record + brief (markdown) + reply + stderr + admit/spec summary.
  - `GET /api/runs/{id}/dispatches/{dispatchId}/stream?from` — the raw stream parsed into transcript items (see C),
    paged by line offset; `raw=1` returns raw lines.
  - `GET /api/runs/{id}/docs/{name}` — plan.md, lanes/*, digests/*, report.md, ledger.md.
  - `GET /api/runs/{id}/commits/{sha}/diff` — `git show` of a run commit in the run's repo, read-only, only for shas
    the run's events name.
  - `GET /api/runs/{id}/checks/{lane}` — fast/full check logs.
  - `POST /api/runs/{id}/pause`, `POST /api/runs/{id}/resume`, `POST /api/runs/{id}/roles/{name}/cancel`
    (existing CLI behaviour of `runs cancel <id> <name>`), existing cancel and answers.
- **Live socket**: today it sends one line per event. v2 sends, per event, the structured event plus the run-model
  patch it causes (changed nodes), and a second channel per open dispatch tails its `roles/…/events.jsonl` as
  transcript items. The browser keeps the model current without refetching.
- **Per-run pause/resume (core change)**: a run-scoped pause, alongside the machine and workspace scopes in
  `pause.ts`: a `run.paused` / `run.resumed` event (or the existing pause record, scoped by run id — the builder picks
  whichever fits `pause.ts`), checked by the daemon before admitting a dispatch; live roles finish, nothing new
  starts. Tested at the domain/service layer.
- **Setup speed**: backend probes are cached (per CLI path + mtime, short TTL) and returned stale-while-refreshing;
  Setup renders from cache immediately, a "Re-check" action forces a probe.

### B. Dashboard (`/`)

- **Live strip**: every running run as a card: title, repo, a mini progress bar of milestones, the node that is
  running now with its plain `now` line and provider icon, elapsed time. Click → run page.
- **Waiting for you**: open questions across runs (count + the first few, answerable inline).
- **KPIs for a range (7 / 30 days, repo filter)**, each with a one-line meaning: runs, finished without
  intervention (%), median wall time, interventions, cost (USD where known) and tokens.
- **Charts**: cost and tokens over time by backend; tokens by model; time by role; failovers and climbs count.
- **Recent runs** across repos (from the index).
- Empty state: what catherd is in two lines and how to start a run (`/catherd` in Claude Code or Codex).

### C. Run page (`/runs/$id`)

- **Header**: title, repo, status, elapsed/total time, live cost/tokens, controls (Pause/Resume, Cancel run).
- **Graph** (React Flow, elk layered left → right, auto-fit, minimap, zoom): the run model. Node card: icon by kind,
  title, status colour + animated ring when running, provider logo + model + effort, duration, attempt count badge
  ("round 2"), a question badge when parked. Edges animate into the running node. Pending nodes are muted.
- **Drawer** (node click; deep-linkable via search param): tabs
  - **Overview**: plain explanation of the step, status, timings, rung and why it was chosen (routes.jsonl), tokens,
    cost, attempts list (switch between attempts).
  - **Prompt**: `brief.md` rendered as markdown (with a copy button).
  - **Log**: the transcript, live when running: assistant messages as text; thinking collapsed; each tool call a card
    (name, input, output, duration); shell commands terminal-styled with exit code; file changes as diffs; errors
    highlighted. Search within the log; "Raw" toggle shows the JSON lines. Formats: Claude stream-json and Codex exec
    JSON; opencode/cursor fall back to raw with message extraction where known.
  - **Output**: `reply.md`, findings (BLOCKER/BUG/NIT parsed from the reply), verifier A-line PASS/FAIL lines.
  - **Changes** (commit/land nodes and lanes): the diff of the commits this node produced, per round.
  - **Checks** (check nodes): fast/full check log tail and exit.
  - Role node actions: "Cancel this role" when running.
- **Below the graph**: Plan (plan.md rendered), Report (report.md), and the event timeline (structured, filterable by
  type, kept for the raw truth).
- A parked node shows the question inline in the drawer with the Questions answer UI.

### D. Setup (`/setup`)

- **Backends**: cards with provider logo, version, login state, model count, readiness, and the fix command when not
  ready (copyable). Probes from cache (A).
- **Roles**: one row per role: logo + role name + plain one-line meaning, the ladder drawn as connected steps (rung
  chips with provider logo, model, effort, the catalog score as a small bar), enabled switch, access level. Editing a
  ladder: a picker grouped by provider with score/price/speed per pair, drag to reorder, add/remove; the change shows
  "before → after" before Save. Host-set roles show why they cannot be edited without a host.
- **Profile settings** (all of `ProfileDocSchema`), grouped with a one-line meaning each: Objective, Budget
  (minutes/tokens/USD), Timeouts (idle/wall, per role), Failover (rung → rung pairs), Max effort, Difficulty bars,
  Heavy lock and memory limits, Preflight confirm, Notifications (which events + the URL), Jev, Billing per backend,
  Isolation per backend, per-role network. Each section saves through ProfileService with the same validation as the
  CLI; validation messages shown inline.
- **Profiles**: list, activate, create from defaults, delete, and which repos are bound.
- The access warnings collapse into one line ("6 roles run with full access, wider than catherd's default — why it
  matters"), expandable.

### E. Questions (`/questions`)

- Each question card: run + unit (role/lane/milestone), the reason explained in plain words, the asking role's latest
  reply (collapsed), links to the lane/plan and the node in the graph.
- Quick answers by reason: approval → "Approve plan" / "Request changes" (+ text); others → free text with
  suggested phrasings when the reason has a known fix (e.g. budget: "Raise the budget" deep-links to Setup → Budget).
- Answering updates the run live; answered questions move to a "Recently answered" list.

### F. Self-explaining layer

- A glossary (one source file) for every concept: run, milestone, lane, rung, ladder, effort, round, climb, failover,
  fast check, verifier, judge, A-line, access level, Jev, objective. Rendered as tooltip on hover/focus wherever the
  word appears as a label.
- Every node's `now` line and every empty state written in plain English.

### G. Visual language

Keep the copied console's tokens and HeroUI v3; refine: denser, more visual (logos, small charts, status colour,
motion only for live changes: running ring, edge flow, row highlight on arrival). Refined, not brutalist. Light and
dark both work. Desktop first; on phones the dashboard, questions and the run header + a list view of nodes work,
the graph is desktop only.

## Delivery

One branch (`panel-v2`), one PR, landing everything together (owner decision). Built by parallel subagents from a
plan in `docs/plans/`, verified in the browser against real runs, gated by the root and web gates plus Playwright
e2e of the main flows (dashboard, run page with a fixture run that goes live, setup edit, answering). One Codex
review round, then merge; it reaches users through `@next`.

## Decided by the owner (2026-10-23)

All lands together; cross-repo runs with a repo filter; full profile editor with before → after preview; controls:
cancel run, pause/resume one run, cancel one role, answer; built-in explanations, no tour; refine the existing design
system; English; React Flow with stacked attempts, drawer with prompt/log/output/diff; desktop first; readable
transcript + raw toggle; live log streaming; per-round diffs from git; dashboard set above; in-memory mtime cache, no
new index file; per-run pause in the core; questions with derived context and quick answers, also on the graph node;
bundled provider SVGs; `@xyflow/react` + `elkjs`; no masking; built by Claude subagents (not dogfooded); 1.x runs
listed read-only.

- **Setup's repo.** Setup has a repo selector (default: the repo the panel was launched from; plus "global
  default"). Every edit goes to the profile the selected repo runs on. "Use for this repo" binds a profile to the
  selected repo; activating a profile globally is a separate action. Every Setup/profile endpoint takes a `repo`.
- **Unknown host.** When the host is unknown, the header asks once "Which app do you run catherd from? Claude Code /
  Codex"; the answer is saved as `catherd init` saves it (`config.json` host via ProfileService), and from then on Setup
  works fully. Until answered, Setup is read-only. catherd never guesses the host.

## Calls made by the designer (check these)

- **Steps beyond the main chain.** Preflight is a node per milestone between `route` and the lanes (it can park with
  `preflight`/`confirm`). Mid-run judge calls (`triage`, `question`, `unexpected`) are attempts with a "judge" badge on
  the node of the unit they concern; only the `rules` judge is the end node. `commit.failed` is a failed attempt on
  `commit`; `base.behind`, `integrate.*`, `branch.pushed` and the push question are attempts on `integrate`/`land`;
  `tree.deferred` shows on the milestone's `route` node. Every `question.parked` unit maps to exactly one node, so
  every question has a home in the graph. Unmapped event types still appear in the timeline.
- **Changes.** The diff endpoint serves only shas named by the run's `commit.made`, `milestone.landed` and
  `integrate.done` events. The `commit` and `land` nodes show the milestone commit per round; a lane's Changes tab
  shows the same commit filtered to the lane's `owns` paths, with a note that the commit is per milestone.
- **Per-run pause** works like the machine pause (refuses new dispatches) and also: Resume takes effect immediately
  (it wakes the run instead of waiting out the 5-minute refusal back-off, so a `run.paused`/`run.resumed` event pair
  is the expected storage), and paused spans are left out of timings, idle/wall timeouts and the minutes budget, as
  machine pauses already are.
- **1.x runs** open a simple run page: summary, dispatch records, report and timeline; no graph, no live view.

## Left to the builder

Component structure and file layout within the conventions; the exact run-model node ids and patch format; chart
component choice inside HeroUI/Tailwind (amended: the owner-approved design pass added `recharts`, as remora uses, for
the dashboard's charts); cache
TTLs; the exact glossary wording; fixtures for tests (derived from the real smoke runs, sanitized of absolute home paths).
