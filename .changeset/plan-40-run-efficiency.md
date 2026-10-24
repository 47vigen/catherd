---
"catherd-cli": patch
---

Run each milestone's Check in the daemon before any verifier, so a verifier reviews only the A-lines the Check does not cover. A plan line `(Check)` on an A-line marks it covered, and `Baseline: <check item>` accepts that item's pre-existing failures. Plan task ids may be dotted, such as `### Task 1.3`, and the plan lint warns instead of refusing.
