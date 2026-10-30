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

Top to bottom, on a 12-column grid (one column on a phone):

1. **Header.** Title, then one line: status chip, started, repo folder name (the full path on hover). Actions as
   before. One stat sheet with each figure once: Status, Took / Running for, Cost (tokens under it), Tasks (done of
   the ledger), Rounds, Idle (concurrency under it).
2. **Needs you** (only when a unit is parked on the owner): one warning band, each question with its Answer button.
3. **Now** (live only, 7 columns): one row per live role (name, role colour, model, how long it has run); a row
   opens that role in the drawer.
4. **What stands out** (7 columns; under Now when live): findings derived from the run, the most serious first, each
   with a tone (danger, warning, neutral) and a link to its role run or check:
   - a check whose last result failed (and, for a run that ended done, that it ended done anyway);
   - role runs that failed, were cancelled or timed out;
   - limits hit and rung climbs;
   - the role run that took the largest share of the cost (when it took a quarter or more);
   - the role run that ran far longer than the median (three times or more, and at least five minutes);
   - time spent waiting on the owner and on quota;
   - idle time of a third of the run or more, with its main reason;
   - the architect's turn count and its share of the wall time;
   - ledger tasks left blocked or impossible at the end.
   No finding: "Nothing stands out."
5. **Where the time went** and **Where the cost went** (5 columns, stacked): one segmented bar each with a legend.
   Time: roles working, checks only, waiting on you, quota, gaps. Cost: by role family; under it the top five role
   runs by cost (tokens when no cost is known), each with a share bar, each opening its role run.
6. **Run flow** (12 columns), without its own copy of the figures.
7. **Plan and report** (8) beside **Models** (4).
8. **Timeline** (12).

The Metrics card goes: each of its figures now lives in the stat sheet, the time bar or a finding.

## Left to the builder

Exact thresholds beyond those named above, copy, and the visual details within the panel's conventions (remora's
console language: Geist, hairlines, label-caps, the existing Tile).
