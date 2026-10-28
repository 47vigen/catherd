---
"catherd-cli": minor
---

Landing (plan 50). `run_start` takes `base` again: a base run works in a tree of its own on a branch named after it, and the architect's `land` commits, pushes that branch (never `base` or a default branch, never forced) and opens one MR per run with `gh` or `glab`. `land {final}` needs a green full check and a verifier PASS on the pushed commit, merges a moved base first, and asks the owner one question, merge?, whose answer ends the run. One verifier now runs once on the integrated product, and a PASS with no command run is a FAIL. Removed: `catherd gate`, `catherd lock --role`, `catherd catalog outcomes`, `routes.jsonl`, `outcomes.jsonl`, the milestone branches and the land gate. MIGRATION.md, "Landing and the one verifier (plan 50)".
