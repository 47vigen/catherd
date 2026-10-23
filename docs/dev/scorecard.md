# The run scorecard

The run scorecard is the gate for catherd 2.0 (spec `docs/specs/2026-10-12-catherd-2.0-design.md`, "Measurement"). It
is not the catalog benchmarks, which are deleted. It measures a catherd version on four fixed tasks, and
`catherd scorecard compare` checks that measurement against the baseline taken on 1.5.0.

It is a contributor command. The fixtures name private commits and the shims are test seams, so `scorecard/` is not
in the npm package: run every command from a catherd checkout, as `bun src/cli.ts scorecard …`, with `CK` the
checkout at `main`.

## The four tasks

Run them one at a time, in this order. A fixture lives in `scorecard/tasks/<id>/task.json`.

- `raqam-myanmar`: raqam's Myanmar locale plugin, `raqam/locales/my`, at raqam `6795167` (main). One milestone, one
  task. Its hidden acceptance test is copied in when the run is scored.
- `catherd-findings`: two review-gate misreads from 1.5's follow-ups (`BLOCKER: none` counts as an open blocker;
  `Allow:` misses a hit printed as `./path`), as a two-lane milestone, at catherd `2061e6e` (1.5.0).
- `sanitell-payment-3`: Sanitell payment plan 3 (run `20260929-124103-payment-plan-3-kit-auth-apps`, catherd 1.2.1,
  2 lanes, 50 minutes, landed `249e6a2f`), replayed at `0296d87585d6288998f7b845a501ebdf2a5c1cad`, the parent of its
  first commit `e0f006bf`, whose tree holds the plan. It names no source (the platform's host is private): give
  `--source <path to your clone>`.
- `injected-lao`: Lao digits at raqam `6795167`, with one fake quota limit and a stale test. The fixture commits a
  test pinning that Lao digits stay as typed; the plan's change (Lao built in) breaks it, so the gate fails until a
  fix round corrects it. The limit is a PATH shim (`scorecard/shim/codex`, `scorecard/shim/claude`): one headless
  call ends in the usage limit of catherd's own adapter fixtures, then every call passes through. No provider
  account is touched while a limit is injected. A profile whose headless workers are neither Codex nor Claude Code is
  never limited, and `compare` then says the task did not recover.

A prepared task is `<data dir>/scorecard/<task>-<YYYYMMDD-HHMMSS>/` (`--dir` moves the root): `repo/` (a clone at
the pinned commit, on branch `scorecard/<task>`, with no remote, so nothing can be pushed), `plan.md`, `limits/`
(the injected task) and `prepared.json`, written last.

## What each column counts

- **Finished:** the run has milestones, every one landed, no open question, and it was not superseded.
- **Interventions:** the sum of a park, a takeover (each change of owner session after the first, from
  `meta.startedBy` and `sessions.jsonl`), a manual dispatch (only in a daemon run, one with `events.jsonl`: each
  record carrying a `sessionId`), a pause begun during the run, a run this one superseded, and each chat message you
  typed after the start prompt (`record --chat <n>`). Answers are shown, not added: each closes a park already
  counted. A daemon revival is not counted. In 1.5 another session's dispatch first claims the run, so it is a
  takeover; any catherd call revives a 2.0 daemon, so a chat nudge you forget to report is missed.
  - A 1.5 run: a park is each question row of `questions.jsonl`.
  - A daemon run: `questions.jsonl` is not read. A park is each `question.answered` event answered `by: "owner"`
    plus each question still open at the end (a stop only the owner can clear); a judge's answer is not counted.
    Two more interventions exist here: an owner's cancel (`cancel.requested`) and an owner's plan approval
    (`plan.approved` with `by: "owner"`). A plan given as input is `by: "input"` and is not counted; a session that
    started the run without its plan makes the run wait for the owner, and `compare` fails that task.
- **Rounds:** a milestone's full reviewer passes (`reviewer-<M>`, ended ok, not `STATUS: partial`) since its lanes
  started, summed over milestones.
- **Wall-clock:** from the run's start to its last landing (the last landed milestone's digest line
  `· landed <iso>`), else to the last record or native agent row. Pause spans (the machine's, the run's
  workspace's and the run's own) are subtracted, as the panel does; parked and paused minutes together are
  shown beside it (`pausedMinutes`).
- **First try:** every milestone landed exactly once and the task's acceptance passes on the run's final tree, with
  the fixture's hidden `accept/` tests copied in (and removed after). A throwaway clone opens no MR, so this stands
  in for "the MR passed on the first try"; a CI-only failure goes unseen.
- **Quota:** tokens per backend (input, cached, output, runs, limit records) from `runs.jsonl` plus native Claude
  subagents' reported tokens. Money is not shown. Reported, never gated.

Acceptance runs through catherd's own check runner: its own process group, an allowlisted login environment plus
the repo's gate environment (`catherd knowledge env set` supplies a variable outside the allowlist).

## The pass bar

All four tasks finish with zero interventions, the injected-failure task recovers by itself (a limit was hit and a
stand-in ended ok), and the four tasks' summed wall-clock is no worse than the baseline's by more than 10 %
(`WALL_TOLERANCE`). Per-task deltas are shown, not gated: one run per task cannot tell 5 % from noise. Quota, review
rounds and the first try are reported, never gated.

## Operator rules

- One task at a time. Parallel tasks share quota and the machine; a measurement takes up to 16 hours.
- A fresh Claude Code session per task, started from the printed start line. Paste the printed prompt and touch
  nothing.
- Every message you type into the session afterwards counts: pass the number as `--chat <n>` when you record.
- Stop at 4 hours, or when nothing has moved for 30 minutes, and record the run as it stands: it scores as
  unfinished, with its wall-clock to its last activity.
- Leave your default profile unchanged between measurements.
- If the repo holds two runs (you restarted, or one superseded the other), `record` refuses and names both; pass
  `--run <id>`. A superseded predecessor counts as an intervention.

## The version under test

- The baseline: `catherd --version` and the Claude Code plugin both say 1.5.0. Each row stores its run's
  `meta.catherdVersion`, so a row from the wrong version shows it.
- After plan N: the merged `main` through the next channel, `catherd-cli@next` and the `plugin-next` marketplace,
  with the label `plan-N`. A 2.x pre-release is measured from `@next` under its exact version label
  (`2.1.0-next.<datetime>`); it becomes `latest` once `catherd scorecard compare <label>` exits 0. The 2.0.0 beta
  already published as `2.0.0-beta.20261022113309` keeps its `beta` tag and its label.

Labels match `^[a-z0-9][a-z0-9.-]{0,40}$` (`1.5.0`, `plan-29`, `2.0.0-beta.3`). Results are
`scorecard/results/<label>.json`, one row per task; a re-record replaces that task's row. `--results <dir>` moves
them.

## Release gate

A major's pre-release is measured under its exact version label (`x.y.z-next.<datetime>`, or the 2.0.0 beta's
`2.0.0-beta.20261022113309`), so one label measures one version. `latest` follows only when `catherd scorecard compare <label>` exits 0 and the owner says so. Nothing under
`src`, `plugin`, `catalog`, `package.json` or `bun.lock` may differ between the measured build's commit and `main` at that
moment; if it does, measure the newest `@next` again.

## The 1.5.0 baseline: commands

The baseline spends your subscriptions for hours and is never run automatically.

```sh
# the version under test: both say 1.5.0
catherd --version
claude plugin list | grep catherd

# the scorer: this checkout at main after plan 28
CK=<the catherd checkout>; cd "$CK" && git pull && bun install --frozen-lockfile

# one task at a time, in this order: prepare, then in a new terminal run its start line, paste its prompt,
# touch nothing until the run lands or 4 hours pass, then record
bun src/cli.ts scorecard prepare raqam-myanmar
bun src/cli.ts scorecard record <printed dir> --label 1.5.0 [--chat <messages typed into the session>]
bun src/cli.ts scorecard prepare catherd-findings
bun src/cli.ts scorecard record <printed dir> --label 1.5.0
bun src/cli.ts scorecard prepare sanitell-payment-3 --source <your clone of the Sanitell platform>
bun src/cli.ts scorecard record <printed dir> --label 1.5.0
bun src/cli.ts scorecard prepare injected-lao   # its start line sets CATHERD_SCORECARD_LIMITS and the shim
bun src/cli.ts scorecard record <printed dir> --label 1.5.0

bun src/cli.ts scorecard compare 1.5.0          # four rows; FAIL lines are expected for a baseline
```

Each `prepare` ends with four lines (folder, start, prompt, record); each `record` prints its row and the file it
wrote; `compare` prints four rows and the verdict (exit 0 pass, 1 fail, 2 for a label never recorded). Commit
`scorecard/results/1.5.0.json` on a branch from `main`: plan 36 reads the baseline.
