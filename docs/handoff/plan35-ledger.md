Plan 35: a milestone per branch, parallel milestones capped by free memory (docs/plans/2026-10-21-35-milestone-branches.md)

Branch p35-branches, stacked on p34-knowledge. Owner rules: memory limits are profile settings; "push" answer pushes a milestone branch only; tests use a local bare origin.

Ruling: planSetup reads only the lines directly under plan.md's "# " title (no leading blank skipped, unlike lane headerBlock) — the plan's own test wants "# Plan\n\nSetup: body prose" to be null and the architect sentence says "the line under the title" — an architect who leaves a blank line after the title gets no Setup: (the architect brief says where to put it).
Ruling: the LANE_ID widening makes a bare "L1" a valid After entry (shape-identical to a milestone id), so the old lane.test "After: L1" refusal test now uses "After: M1 L1" — plan Task 1 itself defines the regex — a typo like "L1" for "M1.L1" is caught at preflight instead of at write.
Ruling: MilestoneState gains pushing, digestPath and mr beside the plan's tree/treeAt/claimAfter (branch already exists from 30b) — the machine must remember an answered `push` until `branch.pushed`, name the digest in D11's question, and name the MR command in the second question; level-triggered advance emits pushBranch while pushing and parks the question again from `mr` — a replayed old run has them null/false, harmless.
Ruling: effect.failed pushBranch twice parks the milestone with reason "effect" and the owner's answer retries the push (pushing stays true) — plan says "one retry, then park with git's message; the answer resumes" — an owner who pushed by hand gets a no-op push then the MR question.
Ruling: tree.deferred's recheck uses MEMORY_LIMITS.recheckMs (not a profile value) and a tick clears claimAfter once due — only the three megabyte numbers are profile settings (owner rule) — none.
Ruling: lane `After:` readiness keeps the 1.5 rule in a run without base; in a base run another milestone's lane or a whole milestone must be merged — plan table row "lane after entry".
Ruling: the answer to a push question that merges (any answer but push) emits checkMerged from `react(question.answered)` so the effect removes the tree — a daemon killed between the answer and the effect leaves the clean tree on disk (harmless, removable by hand).
Ruling: treeDir/treeOf live in src/services/tree-path.ts and milestone-tree.ts re-exports them — preflight, gate-service and milestone-check need treeOf, and milestone-tree.ts imports preflight (runCheck, checkEnvFor), so exporting them from milestone-tree.ts would make an import cycle — none (callers may import either path).
Ruling: milestoneFiles in a base run uses the three-dot diff and, when git fails, throws the function's 1.5 error instead of falling back to the ledger range — a ledger-based range is wrong on a branch from origin's base — none.
Ruling: planOf's `after` is the union of plan.md's heading `After:` milestones and milestoneAfter(lanes) — the plan says milestoneAfter, but dropping the heading line would break 1.5 plans that use it — a heading After: and a lane After: both hold a milestone back.
Ruling: the integrate brief's sentence becomes "Edit the conflicted files only ... (no git add, no git commit): catherd does." keeping the substring the old test pins — the plan wants the explicit phrase — none.

## Review fixes

Final review: 0 C / 2 I fixed, 1 minor fixed. One commit each, each test failing first on the old code.

- I1 `treeOf` fell back to the main checkout when a claimed milestone's tree folder was missing; the milestone is never claimed again after `tree.ready`, so its commit, dispatch cwd, checks and merge would have run in the owner's own checkout. A tree with a `.ready` marker and no folder now throws E_TREE (restore it or cancel the run); the effect failure path parks the milestone, and the dispatch is refused with E_TREE (`4206d6e`).
- I2 A folder left by a `git worktree add` cut off mid-checkout (right HEAD, part of the files, no `.ready`) was reused as complete, and the missing files were committed as deleted. A reused folder without `.ready` now gets `git reset --hard -q HEAD` before Setup: (no `git clean`) (`d2986fa`).
- M1 `removeTree` gave the "uncommitted or untracked" hint for any failure of `git worktree remove`; the hint now carries git's own stderr (`0aa4191`).

Ruling: the marker that says "claimed" is the `.ready` file, not the `tree.ready` event, since `treeOf` has no state and the file is written first — cost if wrong: none.
Follow-ups noted in `docs/dev/ideas.md` (2.0 follow-ups): `git worktree prune` also prunes the owner's stale entries; a memory deferral never tells the owner; `updateState` and the skip path's `fullCommit` read the main checkout's HEAD in a base run.
