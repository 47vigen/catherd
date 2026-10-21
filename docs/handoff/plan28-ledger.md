# Plan 28: the run scorecard — ledger

Ruling: `Prepared.startCommit` and `TaskScore.startCommit` hold the full 40-hex HEAD (`git rev-parse HEAD`), not `gitHead`'s short one — the plan's test says "startCommit is the commit" (a full sha) and `formatPrepared` cuts it to 8 characters; `TaskScore.head` stays short as the plan says — a short sha in a row would not compare to the fixture's pinned commit — none.
Ruling: `prepareTask` stores `into` as its real path (`realpathSync`) — the run's `meta.repo` is the git toplevel's real path, and `listRuns([repo])` keys by it; on macOS the temp and data dirs sit behind symlinks — a prepared dir under a symlink would find no run — none.
Ruling: `passBar` checks the injected task's recovery as its own step after the per-task loop (the plan's wording), so an injected task with an intervention reports both lines — follows the plan's order literally — none.
