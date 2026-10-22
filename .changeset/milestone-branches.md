---
"catherd-cli": major
---

2.0.0 (part of): `run_start` takes `base`: each milestone gets its own branch and worktree from `origin/<base>`, set up once with the plan's `Setup:` line, and its roles, checks and commits work there. Milestones whose `After:` milestones are merged run side by side while the machine has the memory for them (the profile's `limits.memory`: by default 3 GB each above a 2 GB reserve). Answering `push` to a landed milestone has catherd push its branch and print the MR command; merged, clean worktrees are removed. catherd never opens an MR or merges. A run without `base` works in the repo as before.
