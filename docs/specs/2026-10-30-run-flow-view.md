# Run flow view: a live timeline of an architect run

## Goal

The panel's run page still draws runs as a milestone graph (`web/src/routes/_app/runs/-components/graph/RunGraph.tsx`,
`MilestoneGroup.tsx`). The milestone machine is gone since plan 48: every run is now led by the architect, who keeps
a ledger of tasks, delegates them to roles, asks for checks, and finishes. Replace the graph on architect runs with a
**flow view**: a timeline with one row per ledger task, so an owner can watch a live run and see at a glance what is
running, what it waits on, and where time went.

## What the owner sees

- **A stat strip** on top: state, wall time, idle %, concurrency, check share, review rounds, cost. Reuse the
  Metrics tile data (`catherd runs metrics`, `src/domain/run-metrics.ts`); do not compute these twice.
- **An architect row** first: one short bar per architect turn, on its rung. A turn's bar opens that turn's reply
  summary and the `why` of each event it caused (ledger.changed, task.delegated, check.requested).
- **One row per ledger task**, in ledger order, labelled with the task id and its state chip; the row shows every
  dispatch for that task (worker, writer, reviewer, verifier, researcher) and every check, as bars on one time axis.
  Colour by role family (writers, reviewers/verifiers, researchers, checks); a failed or cancelled bar and a failed
  check get a danger edge; a limit gets a warning mark. A rung change between two bars of one task (a ladder climb)
  shows on the second bar.
- **An idle row** at the bottom: every interval in which no role is working, coloured by the reason it is idle —
  waiting on a check, on a quota hold, on the owner (needs_user / a question), or on nothing (a gap). This is the row
  that shows a stalled run at a glance; the reasons must come from the run's own events, not be guessed.
- **A time axis** with a now line while the run is live. Live runs update over the existing run socket; bars grow,
  the view follows the now line unless the owner scrolled back.
- **Click a bar** to open the existing node drawer (`drawer/NodeDrawer.tsx`) for that dispatch or check — reuse it,
  do not build a second drawer. Hover shows role, rung, duration, status.
- **Phone width**: the rows keep a fixed label column and the track scrolls horizontally inside its card; no page
  scroll sideways.

Runs imported from 1.x (`runs.legacy`) keep the old graph; only architect runs get the flow view.

## Data

Add a `flow` section to the run model the run page already loads (`getRunModel`, `src/services/run-model.ts`,
schema in `src/entry/panel/openapi.ts`), derived in the domain layer from the run's events, dispatches, checks and
ledger tasks in the run database. It carries architect turns, ledger tasks (id, goal, state, depends), dispatches
(name, role, ledger task, rung, start, end, status, reply status, why, cost), checks (id, scope, base, start, end,
exit, failure count, and the new/inherited split when the run has it), owner waits, quota holds, and idle intervals
with their reason. Keep it one pure function with unit tests; regenerate the client with `bun run panel:openapi`.

A check row's start is when it was requested and its end when `check.done` arrived; a dispatch's are its
`dispatch.started` and `dispatch.ended`. A run that is still live has open intervals that end at "now".

## Look

The panel copies remora's console (spec 2.0, decisions 23–26) and HeroUI v3 tokens; its conventions test is the rule.
Refined, dense, airy: thin bars (about 14px), hairline row separators, no heavy chrome, Latin monospace with
tabular figures for times and numbers. Correct in dark and light mode.

## Done when

1. The flow view replaces the graph on architect runs, legacy runs keep the graph.
2. Unit tests cover the flow derivation, including idle reasons for: a check wait, a quota hold after a limit, an
   owner wait, a plain gap, and a live run with open intervals.
3. Component tests cover the rows, the idle row and the drawer opening from a bar; the panel e2e opens a seeded
   architect run and sees the flow view.
4. Both gates are green: the root gate and the `web/` gate (CONTRIBUTING.md, "The panel").
5. The reviewer looks at it in a browser, in dark mode, light mode and at phone width, against a seeded run with at
   least 8 ledger tasks, a failed check, a limit and an idle gap, and attaches the screenshots.
