---
"catherd-cli": minor
---

The oracle rule (spec D9). A ledger task's `oracle` paths are now enforced: when a worker or writer on that task changes them, the architect's digest says HELD with the diff, and `land final` refuses until the architect accepts the change with `oracle_accept` and a reason, or the task restores the oracle. Accepted changes are listed under "Oracle overrides" in the merge request. Every other test edit stays allowed and reported: the merge request and the verifier's brief now list test cases the run removed and existing test files it rewrote, besides deleted test files and added skips.
