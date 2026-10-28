---
"catherd-cli": minor
---

The architect loop, behind `engine: architect` in a profile: the architect is woken by events, delegates tasks, runs checks, keeps a ledger and finishes the run through its tools, and the researcher and the writer are on call to it and to workers through `delegate_task`. Every other run keeps the 2.0 pipeline.
