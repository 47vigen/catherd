---
name: catherd
description: Use when the user asks for a task or a project to be orchestrated with catherd — /catherd, "orchestrate this with catherd", "run this on catherd" — or when resuming, answering or reading a catherd run. Not for a plain request that merely mentions an architect, a verifier, a review or a plan.
---

# catherd

## Overview

catherd runs the work in a background daemon: it plans, dispatches the roles, reviews, verifies and lands each
milestone by itself, and writes everything it does to the run's `events.jsonl`. You are the owner's front door to
it, not its driver. Your job is four things:

- write the A-lines the run must meet;
- start the run;
- carry the owner's answers to the questions the run parks;
- relay the finished report.

**Your first call is `status()`.** Its `version` must be the one this plugin pins, `catherd-cli@1.5.0`. If it
differs, stop and tell the user to restart their host session so the plugin and its server match.

**You never edit product files and you never dispatch a role.** Every line of code, tests or docs comes from a
role the daemon runs. Each role runs headless in its vendor's own harness with the user's customizations; never
isolate it (the profile's `harness.<name>.isolated` is the user's own choice, and the daemon applies it).

## Tools

Six tools, nothing else.

| Tool                                            | Use                                                                                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `run_start(repo, title, a_lines, plan?, base?)` | Starts a run. Returns its id and the notify url its questions go to.                                                               |
| `status(run?)`                                  | Each run's phase, milestones, live roles, parked questions, quota holds and whether the daemon is alive (a dead one is restarted). |
| `answer(run, unit, answer)`                     | Answers a parked unit (the run, a milestone or a lane); it runs again with the answer.                                             |
| `cancel(run)`                                   | Stops the run: every live role is cancelled.                                                                                       |
| `result(run, name?)`                            | The run's report, or with `name` one role's record.                                                                                |
| `profile(action, …)`                            | Reads, validates or changes a profile, or sets `notify_url`. Tuning is the `catherd-setup` skill's.                                |

## Starting a run

1. Write the A-lines, the acceptance lines the work must meet, one per line, each checkable. Ask the owner every
   product question first, before the run starts: a daemon that must park later costs a round trip.
2. A plan the owner already has ("implement the plan at …", a scorecard prompt) goes in `run_start`'s `plan:`
   (several files, a contracts file included, as a list); an A-line `plan: <path>[, <path>…]` does the same. Write
   only the acceptance lines the plan does not already state. The run then skips the dossier, and the architect
   translates the plan instead of designing. With no plan, say that the architect writes one first, and the run
   waits once for the owner's approval of it.
3. Call `run_start(repo, title, a_lines, plan?)` with the repo's absolute path. If it fails, `error.code` and
   `error.fix` say what to do; relay them.
   A run whose milestones should each be their own branch and merge request takes a `base`, a branch on origin
   (`run_start(repo, title, a_lines, base)`). Each milestone then works in its own worktree from `origin/<base>`;
   independent milestones run side by side while the machine has the memory for them (the profile's
   `limits.memory`); a milestone that builds on another names it on an `After:` line. Without `base`, the run
   works in the repo, one milestone at a time.
4. Tell the owner the run id and the notify url (an ntfy topic) to subscribe to on the phone: that is where a
   parked question and the final report arrive.
5. End the turn. **The run does not need this session: it continues if the session is compacted or closed.**
   Never poll, `sleep` or loop on `status`.

## When the run reports

A report reaches you as a catherd message (`<cross-session-message from-name="catherd">`) or the owner reads the
phone notice and asks. Either way:

1. Call `status(run)`. It lists the parked units with their questions, the live roles and any quota hold (a hold
   lifts by itself; say when).
2. A parked unit is the owner's question. Put it to them in their own language, with the daemon's context and your
   recommended answer, one question at a time. Pass their answer with `answer(run, unit, answer)` and nothing
   else: do not rephrase it into a decision of your own. The run goes on with the work that does not depend on it.
   A question may also be the plan's approval: relay `catherd run-file read <run> plan.md` for the owner to read,
   then pass `answer approve` (the owner's yes) or the owner's changes as the answer; the architect revises and the
   run asks again, the same way. It asks again later only when an architect change edits an approved `D<n>`
   decision. A parked lane whose question quotes a DESIGN: line is a conflict between the plan and the code: the
   owner answers it (the plan or the code changes). A question may also be a `push` (a landed milestone of a run with a base branch waits for the owner: relay the
   question with its commands; an `answer push` has catherd push the branch and ask again with the MR command, and
   any other answer, once the MR is merged, unblocks the milestones after it, which matters when the repo squash-merges)
   or a `check_broken` (the milestone's check cannot run, so fix the environment, then answer).
3. A role that failed, a gate that is red or a milestone that climbed is the daemon's to handle; report it, do not
   step in. The secret scan of a milestone's check uses `gitleaks` when it is installed; it is optional. Stop the run only on the owner's word: `cancel(run)`.

## The end

When `status(run)` shows the run ended, call `result(run)` and relay the report in the owner's language: what
landed, the known issues, and what the judge decided and why. `result(run, name)` shows one role's record when the
owner asks how a lane went.

The report may end with a rules review: a judge's proposed changes to the repo's standing rules, each with its
`catherd knowledge add` or `catherd knowledge rm` command, and the run has already ended. Give the owner each change in
one line and run a command only on their yes; a rule for some roles only is written
`catherd knowledge add "[worker, reviewer] <rule>"`.

**Push and the merge request only on the owner's word.** The run lands milestones on its own branch and pushes
it only when the owner answers `push`; catherd never opens an MR or merges. A merge request title is the run's outcome, under 72 characters, never the branch name.

## Errors

A tool failure carries `error.code`, `error.message` and often `error.fix`: act on the fix before you retry, and
tell the owner when the fix is theirs. Codes you will meet:

- `E_RUN_BUDGET`: the run's budget is spent; the owner raises it in the profile (`catherd-setup`) or ends the run.
- `E_BACKEND_NOT_LOGGED_IN`: a backend the run needs has no login; the owner logs in, then the daemon proceeds.
- `E_ADMIT_RUNG`: no rung can fill a role; the profile needs one (`catherd-setup`).
- `E_ROLE_SCOPE`: a role session called `run_start`, `answer`, `cancel`, `result` or `profile`; only you, the owner's session, may.

## What not to do

- Do not run the work yourself while a run is in flight: a second writer in the repo races the daemon's lanes.
- Do not promise a time: the roles take what they take, and a quota hold waits for its window.
- Do not copy secrets, tokens or notify urls into a lane, an A-line or a message to a role.
- Do not call `catherd` from a shell to drive a run; the six tools are the interface. `catherd answer` and
  `catherd runs` are the owner's own terminal.
