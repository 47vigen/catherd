---
"catherd-cli": patch
---

Test only: the plan-input test that compares a slim and a bloated unit context no longer fails when its two runs are made in different seconds (a loaded CI shard); both now share one home, so the first run's events are still there.
