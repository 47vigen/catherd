# Run page redesign

Date: 2026-10-31. Owner request: "the run page needs a deep rethink and a good redesign"; autopilot to the end.

## Intent

The owner comes to a run page for two jobs, and both matter equally:

- **A live run:** who is doing what right now, and is anything waiting on me or going wrong.
- **An ended run:** what came of it, where the time and the money went, and where it got stuck.

The page before this change answered neither directly. It stacked five layers (a six-figure stat sheet, the flow
with its own copy of those figures, plan and report beside Models and Metrics, then 40 raw timeline events), and the
same numbers (idle, concurrency, cost, rounds) appeared up to three times. A real run (payment-3 on codekesh: 45 role
runs, $25.63, 94 min) shows what the data is worth: a handful of stories ("T4 alone took 22.6M tokens", "the run is
done but its last full check failed", "the architect came back 27 times"). Every figure was shown at the same weight,
so none of the stories was visible.

## Goals

- The top of the page answers the job at hand: live roles and open questions while the run is live, the outcome and
  what stands out once it ended.
- The page finds the stories itself ("What stands out") and links each one to the role run or check it is about.
- Time and cost each get one picture: where the wall time went, where the money went.
- Every figure appears once.
- The flow, plan and report, models and timeline stay as the evidence, below the summary.

## Non-goals

- No change to the server, the API or the run model. Everything is derived in the panel from data it already reads.
- No change to the drawer, the flow chart's drawing or its interactions.
- Legacy runs (1.5, and 2.0 runs drawn as a graph) keep their current sections; the new summary needs the flow.

## Anti-goals

- A dashboard of more numbers. A finding is a sentence a person would say, not a figure.
- Hiding the evidence. Each finding opens what it is about.

## Approaches considered

1. **Re-skin in place:** keep the layers and restyle them. Cheap, but the duplication and the missing "what
   matters" stay. Rejected.
2. **Two pages (live view and report view):** each job gets its own page. A run changes from one to the other while
   you watch it, and two pages split one URL and its drawer state. Rejected.
3. **One page whose summary changes with the run's state (chosen):** one summary band at the top (now and needs you
   while live; outcome and findings at the end, findings also while live), one breakdown of time and cost, then the
   evidence. One URL, one drawer, the same components in both states.

## Design

The page is a bento grid: tiles in a row share one height, and no tile leaves a hole. Top to bottom, on 12
columns (one column on a phone):

1. **Header.** Title, then one line: id, repo folder name (the full path on hover), started. Actions as before. One
   stat sheet with each figure once: Status, Took / Running for, Cost (tokens and role runs under it, the token
   split on hover), Tasks (done of the ledger), Rounds, Idle (from the flow's own idle spans, so it never disagrees
   with the time bar; concurrency under it).
2. **Needs you** (only when a unit is parked on the owner): one warning band, each question with its Answer button.
3. **The summary row, three equal tiles:**
   - ended: What stands out · Where the time went · Where the cost went;
   - live: Now · What stands out · Where the time went (cost moves beside Models).
   **What stands out** lists findings derived from the run, the most serious first, each with a tone and a link to
   its role run or check: a failing last check per scope (and that the run ended done anyway), role runs that
   failed, were cancelled or timed out, limits and climbs, the role run with a quarter or more of the cost, a role
   run three times the median and at least five minutes long, waits on the owner and on quota, idle of a third or
   more with its main reason, the architect's turns and share of the wall time, tasks left blocked. **Where the time
   went** is one bar (working, checks only, waiting on you, quota, nothing running) plus concurrency, median and
   longest role run, architect turns. **Where the cost went** is one bar by role family, the five most expensive
   role runs when they differ, and the token split. **Now** lists the live roles, each opening its drawer.
4. **Run flow** (12 columns): no copy of the figures. Bars are a tinted body with a solid edge in the role's colour
   and the task id inside; failures and limits keep their outlined edge; a running bar pulses; waits on the owner
   and on quota wash across every row; each row has a state dot; a fixed inspector strip shows the bar under the
   pointer.
5. **Plan and report** (8) beside **Models** (4), and the cost tile on a live run.
6. **Timeline** (12): a rail with clock time and offset into the run, an icon per kind of event and its outcome,
   the line, then type and seq.
7. **Drawers:** redesigned in the same pass (see the drawer commit).

One palette everywhere: architect chart-4, worker/writer/artist chart-1, reviewer/verifier chart-2, researcher
chart-3, checks muted, waiting on the owner chart-5, quota warning.

The Metrics card goes on flow runs: each of its figures now lives in the stat sheet, the time tile or a finding.

## Left to the builder

Exact thresholds beyond those named above, copy, and the visual details within the panel's conventions (remora's
console language: Geist, hairlines, label-caps, the existing Tile).
