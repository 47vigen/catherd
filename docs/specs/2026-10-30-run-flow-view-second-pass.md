# Run flow view: second pass, from the owner's look in a browser

The first pass works on real data, but it is not good enough to show. These were seen on a real 30-minute run
(`catherd-findings`, 11 ledger tasks, 3 full checks) at 1440x1000 in dark mode and at 375x812 in light mode.
Fix every item below, keep the spec docs/specs/2026-10-30-run-flow-view.md, and keep the existing tests green.

1. **The whole run must fit the width by default.** Today the axis is fixed (about 3 minutes per 200px), so a
   30-minute run needs horizontal scrolling even in full screen. Default: fit the run's wall time to the track
   width; ticks pick a round step (1, 2, 5, 10, 15, 30 min, 1 h ...). Offer zoom in/out and "fit" controls
   (ctrl/cmd + wheel or trackpad pinch zooms around the pointer; drag pans), like the old RunGraph's canvas.
   A live run keeps fitting as it grows unless the owner zoomed or scrolled.
2. **One line per row.** Row labels wrap into two or three lines today (id, then a state chip on its own line,
   then a truncated goal), so rows have uneven heights and on the phone the text spills over the next row.
   Each row is one fixed-height line: id in mono, then the state chip inline; the goal goes in a tooltip and in
   the drawer, not in the row. Widen the label column enough for ids (about 180px desktop, 120px phone, ids
   truncate with a tooltip, never wrap).
3. **The idle row is nearly invisible.** The run was idle 28% of its wall time, yet the idle row shows two
   hairline ticks. Draw idle intervals as solid bands with the reason's color at full row height, merge
   adjacent intervals with the same reason, and show the reason and minutes on hover.
4. **Architect turns are heavy.** White filled bars with long text ("architect-1 architect · partial"), stacked
   on two sub-lanes. Draw them as the same thin bars as the other roles in the architect color, with text only
   when the bar is wide enough ("turn 1"), and never stack: turns do not overlap in time.
5. **Bars carry too much text.** "T1 worker · complete" in every bar. Show the task id only, when it fits; role
   is the color, status is the edge (danger for failed or cancelled, warning for limit). Everything else on hover.
6. **Leftovers of the milestone UI on architect runs.** The header tile still says "7 milestones" under Rounds,
   the flow header says "1 failed of 11", and the right sidebar still has a "Milestones" card whose labels
   overlap ("BASELINERecord the full..."). On architect runs: the tile counts ledger tasks, and the sidebar card
   lists ledger tasks (id, state chip, one line), or is removed if the flow already shows it.
7. **Full screen** opens slowly (its enter animation runs about two seconds) and is titled "Steps". Make it open
   at once (no more than 150ms) and title it "Run flow".
8. **Phone (375px):** the track is clipped with no hint it scrolls, and the legend wraps over three lines. On the
   phone, fit the run to the track like desktop; the legend is one scrollable line or collapses into a key icon.

Done when: every item above holds in a real browser in dark mode, light mode and at 375px wide, on a seeded run
with at least 8 ledger tasks, 30 minutes of wall time, three checks, an idle gap of each reason, and a limit.
The reviewer attaches the screenshots, and both gates are green.
