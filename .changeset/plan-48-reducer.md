---
"catherd-cli": minor
---

The architect drives every run: the `engine` switch and the 2.0 milestone pipeline are gone (plan approval, milestones and rounds, the judge, the automatic rerun of a red check, the admission wait). A run an earlier build started is read but never driven. Runs have spec D10's caps (`caps.wallMin`, default 12 h, and `caps.attempts`, default 4 per ledger task), a same-rung retry with nothing new is refused as stalled, and a worker may stop `impossible`.
