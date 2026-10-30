---
"catherd-cli": minor
---

Part of 2.0.0 (spec D6). Fast checks stream: a task delegated with `check` (or a worker task, with the profile's new `fastCheck`, set by `catherd profile set fastCheck "<command>"`) gets that check on the run's tree the moment it ends complete. Nothing waits on it; its result wakes the architect, and a red one is posted on the team channel. The architect is told to call the full check once, on the integrated product before land final, and not to ask for the base up front. `catherd runs` and the stage comparison show the fast-check share and the share of the wall time the run waited on a check.
