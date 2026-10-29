---
"catherd-cli": patch
---

Fixes from the first real stage-1 runs. An architect turn that ends on a quota limit now starts the next turn at once on a rung of its ladder whose quota is free, and waits only when every rung is held; a delegated task with no rung skips a held rung the same way. A failing full check is compared with the same command on the base, which catherd runs itself once per base commit: when every failure is inherited, the check counts as passing for the verifier and the final land, and the inherited failures are listed under Known issues in the merge request. `catherd status` shows an architect run's last check instead of the old milestone notes, and catherd's own lock tests pass when the suite runs under `catherd lock`.
