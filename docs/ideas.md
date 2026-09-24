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
