---
"catherd-cli": patch
---

Every A-line of a run is owned by a milestone. The architect's brief and role text say each milestone cites the A-lines it delivers as `A<n>` in its plan.md section; a plan that leaves an A-line with no milestone is sent back to the architect naming the missing ids. The digest reads the A-lines from the milestone's whole plan.md section (it read only the heading before), and the verifier's brief names the A-lines its milestone delivers and asks for an `A<n> PASS|FAIL` line each.
