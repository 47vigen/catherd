---
"catherd-cli": patch
---

Three fixes from the first 2.0 smoke run. `catherd status` on an ended run prints "Ended: <outcome> at <time>, took N min", counts its age from start to end, and drops the stale Next and Protocol next lines. A milestone digest lists the run's A-lines, marked as not mapped, when none of them is cited as `A<n>`, instead of "none". The report no longer repeats a milestone digest's own H1 under its `## M1` heading.
