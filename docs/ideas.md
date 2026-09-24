# Ideas backlog

Improvement and polish ideas collected while catherd is being built. They come from running the older `codex-orchestration` and `opencode-orchestration` skills, and from designing catherd itself. Those skills are frozen; every improvement lands here, and is picked up into a spec or plan when its time comes. One entry per idea: what, why (the evidence), and where it would live.

## Already in the v1 spec

Listed so they are not re-proposed:
- Only `turn.failed` fails a Codex run, never a reconnect `error` event (spec §7). This bit `artist-m1` on 2026-09-24.
- The server, not the orchestrator, writes `state.md`, because the polish run left it stale while four workers ran (spec §9).
- Every run record carries its rung (`model#effort`), so effort is measurable per run (spec §7).
- The UI pass covers changed screens only; findings carry screenshot paths; the orchestrator opens an image only to decide (spec §10).

- Per-profile, per-harness isolation toggle, default off: spec §8.2 (added 2026-09-24 at Vigen's request).

## Open

- **`catherd doctor`.** One command that checks the versions and logins of claude, codex and opencode, the Jev key, the plugin install, the agent symlinks, and whether the MCP server starts. *Why:* three runs so far were blocked on tool drift: a Claude CLI too old for Opus 5.5, a Codex CLI too old for the Sol/Luna ids, and a Codex CLI that could not parse its config. *Where:* plan 4, beside `init`.
- **The cost of the user's harness customizations, shown and not stripped.** Report the per-run token cost of the user's Codex hooks, skills and `AGENTS.md` in `status` and the final report, e.g. "your Codex AGENTS.md adds ~12k tokens per run". The user then decides whether to trim it. *Why:* the harness is never isolated (spec §2), and in one run the global `AGENTS.md` was read 27 times; the user should see that number instead of catherd silently removing it. *Where:* runner records plus the report.
- **Jev hit-rate review.** After N runs, show how often each Jev start rung had to climb, per kind × difficulty: "build lanes on luna#high climbed 3 of 10". *Why:* it is the raw material for v2's catalog tuning, and it tells the user whether a bar is too low today. *Where:* `runs_summary`, `watch`, and the setup skill.
- **A per-milestone digest.** One screen per landed milestone: A-lines met, commits, climbs, open findings, time and tokens. The push notification links it. *Why:* the user asked "where is it" about 8 times in phase 2; the milestone push answers when, and the digest answers what. *Where:* the `land` tool writes it into the run folder; `watch` shows it.
- **Quota failover.** Each rung in a profile can name a stand-in on another backend, e.g. `gpt-6-sol#medium → <opencode model of equal scores>`. A `limit` result then re-dispatches on the stand-in, instead of pausing the run, and pushes one line. *Why:* today a usage limit pauses an autopilot run until the user returns (goal 1). *Where:* the profile schema, `climb`/`dispatch`.
- **Preflight at `run_start`.** Run each lane's fast check once on the base tree before any worker starts, to catch a wrong command or a missing service in seconds rather than after a 20-minute worker run. *Where:* after the architect, before the first `route`.
- **Per-repo knowledge.** `<data>/<repo-slug>/knowledge.md` keeps what runs learned: test and build commands and how long they take, flaky tests, slow suites, patterns to copy. The next dossier reads it and only maps what changed since the last run's HEAD. *Why:* in phase 2 the architect spent 50 minutes and read 103 files; a second run on the same repo should not start cold. *Where:* the researcher dossier, the `land` tool.
- **Run budget.** A per-run cap on time, tokens or dollars (metered backends). At 80%, the orchestrator prefers lower rungs; at 100% it pauses and pushes. *Why:* autopilot on metered OpenRouter needs a ceiling. *Where:* the profile plus `run_start`.
- **Race mode (v2).** For lanes a profile marks as critical, dispatch two rungs at once in separate worktrees, and keep the first whose fast check passes. It trades quota for wall-clock time.
- **Automatic retro (v2).** At the finish, write a short retro (climbs, the slowest steps, failures) and append its improvement ideas to this file.
- **`catherd bench` (v2).** Replay recorded real tasks under different profiles to measure them on the user's own work; it feeds the bars.
