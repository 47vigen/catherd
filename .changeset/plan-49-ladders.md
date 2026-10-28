---
"catherd-cli": minor
---

Role ladders replace the decision model: each role's rungs, in profile order, are its ladder. The architect names any rung on a role's ladder, or none: a task then runs on the default, and a ledger task tried before climbs one rung after a failure, a timeout, a too-hard stop or a review BLOCKER, never after a provider error or a quota limit. `capabilities` reports the ladders. The decision model, its key, `credentials.json`, its doctor rows and `init` questions, its panel section and Decision tab, and the `judge` role are removed. A profile an earlier 2.0 build wrote loses its `decision` block and `judge` role once, and its architect gets `workspace-write` and the default caps.
