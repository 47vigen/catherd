---
"catherd-cli": patch
---

The ideas sweep: most of the open follow-ups fixed.

The run report and digests: each known issue names where it came from (the reviewer or the verifier), A-lines written without an id are numbered `A1`, `A2`, … and a one-milestone run maps every A-line to its milestone. Each list in the report is capped with a "+N more" line, and the report lists the worktrees still on disk. A rule that holds " — ", a finding with a spaced hyphen, a decision wrapped over lines or written as a numbered item, and an `ENV:` line inside a code fence are all read as meant.

The panel server, `summary` and `scorecard`: a watched transcript is read from where the last poll stopped, not from the start; the run summary and the scorecard leave pauses out of their wall-clock; the summary shows the run's pinned budget; the run index logs a run with a corrupt `meta.json` once and forgets runs that are gone; the overview's date range is capped at 366 days; the panel's CSP names its live socket; a baseline task that did not finish is noted in the verdict; and scoring locks the results file and removes the folders it made.

The panel: a reconnect never shows an older run than a patch already did, a Setup save writes only the fields you changed, and a run document too large to show whole says so, without cutting a character in two.

The run itself: a paused run claims no worktree and routes no milestone until it resumes; `claimTree` clears only catherd's own stale worktree entries; a milestone waiting for memory is reported once, and again when it starts; a daemon that dies right after launch is revived at most once per interval; and the base-failure audit names the part of an `a && b` check that never ran.

Routing, lanes and starting a run: a lane with only a `Kind:` routes on that kind, with or without Jev; Jev is asked about at most a few lanes at once and quota usage is read once per batch; `run_start` says whether the maxEffort cap, the coding floor or the index left a role without a rung; validate's fix no longer asks for a catalog sync when an index exists; preflight and Jev's verdicts read the run's pinned profile; a workspace child whose profile cannot be read leaves no run folder; state.md's Next moves only when `result()` collects the record; the bare-verdict hint fires only for a verifier that exited ok; and a merge release's git check runs before the workspace lock. The protocol's re-check step names every item the fresh verifier will re-check, a passed item whose files changed included.

Delivery, the end push and the infrastructure: a role-thread refusal is written once per notice; the end push reads the owner under its lock, retries once when busy and reports an ambiguous delivery as such; a login profile that prints text no longer corrupts the login env; a timed-out retry hook keeps the stream's retries; the reserved gate-env names come from what the adapters set; the role lock file is versioned (old files still read); `Allow:` matches a hit printed as `./path`; carried gate passes are shared between checkouts of one origin; and `status` shows a run's starting session as live only while it owns the run.

Two fixes from the sweep's own run: the verifier's gate and a lane's check run with an env that drops `CATHERD_ROLE` and `CATHERD_DISPATCH_ID` and a TMPDIR outside the role's scratch, so CLI tests no longer fail with `E_ROLE_SCOPE` under a role; and answering a BLOCKER park past the review cap opens one more fix round (the answer `accept` still lands the milestone with its known issues).
