---
name: catherd-setup
description: Use when the user wants to tune catherd — which models and efforts each role may use, how much each role may touch, cost versus speed, which subscriptions to lean on, failover, budget, harness isolation — /catherd-setup, "set up catherd", "tune my catherd profile". Not for running a task; that is the catherd skill.
---

# catherd setup

You tune the user's catherd profile in conversation. A profile says, per role, which rungs it may run on (`backend:model#effort`, in ladder order) and what it may touch (its access mode); whether routing favours cost or speed; how each backend is billed; whether Jev picks the rung; which rung stands in when a backend hits its usage limit; the run budget and timeouts; whether each vendor harness runs with the user's customizations or isolated; how many heavy commands run at once; and when to push.

**You never edit a file by hand.** `profile_set` is the only writer, so this conversation, the `catherd profile` commands and the TUI cannot drift apart.

## Rules

- **One question at a time.** Each question carries your recommended answer and one line on why, so the user can simply say yes.
- **The user steers.** When they reverse a proposal, take the reversal and never re-argue it.
- **Talk in their terms:** minutes, their subscriptions, how often a rung climbed on their own runs, tokens per run. Benchmark names only when they ask.
- **Every number you quote comes from a tool result in this conversation.** When there is no data yet, say so instead of estimating.

## 1. Learn the goals

Ask these, one at a time, each with its recommended answer:

1. **Their order of speed, cost and quality.** Recommend cost first, the default `objective`: catherd climbs a rung when a cheap one cannot do the work, so the lanes that need speed get it anyway, and the reviewer and the verifier hold quality either way.
2. **The subscriptions they hold:** a ChatGPT plan (Codex), a Claude plan, OpenCode Go, Zen credit or API keys. They set `billing` per key (`codex`, `claude`, `claude-code`, `opencode-go`, `opencode`): `chatgpt-plan`, `claude-plan`, `subscription` or `metered`. Recommend leaning on subscriptions before metered spend, and on Claude last among the workers, since it spends the same quota as this conversation.
3. **The kind of work they orchestrate:** front-end screens, back-end services, terminal and ops work, docs. Recommend from their own runs when `runs_summary` has any.

## 2. Read the facts before proposing

In one message, call:

- `catalog_query({ role: "<role>" })` for each role you will discuss: the models that can fill it, their scored rungs, any "treat like", each rung's cost under their billing, and whether their backend's last listing offers it (`listed: false` means their account does not);
- `runs_summary({})`: how each rung has done on their own runs (runs, refusals, climbs, time) and the harness cost line;
- `profile_get()`: where they stand now, with each role's `access` and `enforcement`.

## 3. Propose one decision at a time

Go through these in order, and skip any the user does not care about:

1. `objective`, and `jev.use` (`auto` asks Jev when a key exists; `off` routes on each lane's `Kind:` and `Difficulty:` lines);
2. `billing`, from step 1;
3. the worker's `rungs` and its `defaultRung`;
4. the reviewer and the UI reviewer;
5. the architect and the verifier, which spend Claude quota. A `claude:` rung runs as a native subagent in this session; a `claude-code:` rung runs headless through `dispatch`. Recommend native for these two;
6. the writer, the researcher and the artist;
7. each role's `access` (below);
8. `failover` (below);
9. `budget`, `timeouts` and `preflight.confirm`;
10. harness isolation, per harness (below);
11. `lock.heavy` and `notify`.

Each proposal has three parts: the change, a worked example from their facts, and the tradeoff in their terms. For instance: "Luna high on build lanes: about 5 min slower than Sol medium, no Claude quota, climbs on 1 in 5 of your runs so far."

- Offer only the rungs `catalog_query` lists as capable for the role, written `backend:model#effort`.
- An unscored model can be enabled only once it has a "treat like <scored rung>". There is no tool for that: give the user the command to run in a terminal, `catherd catalog treat-like <rung> <scored rung>`, then come back and propose again.

**Access.** Each role runs `read-only`, `workspace-write` or `full`. The defaults: architect, reviewer and researcher `read-only`; worker, writer and artist `workspace-write`; verifier and UI reviewer `full`. `profile_get` says per role whether its backend holds it to that mode (`enforced`: Codex's sandbox) or only asks (`advisory`: claude-code, opencode and native subagents, where the model can still reach past it). Recommend the defaults; when the user wants a role tighter or looser, say what it can no longer do (a read-only reviewer on claude-code or opencode has no shell, so it cannot run `git diff`) and that `profile_validate` will warn about it.

**Failover.** `failover` maps a rung to its stand-in when that rung's backend hits a usage limit. A stand-in must be scored and on another quota (Go and Zen bill apart; native `claude` and `claude-code` share the Claude plan). The default profile fails each Codex rung over to OpenCode Go, marked inferred: Go's GPT-6 Luna for Luna, and Kimi K3, treated like Sol medium, for Sol. Say so, and offer to change it when they have no Go subscription. `null` removes an entry.

**Budget and timeouts.** `budget` (`minutes`, `tokens`, `usd`) is a soft cap: from 80 % routing starts at the cheapest rung that clears the bar, and at 100 % no new role starts. `timeouts.idleMin` (15) stops a role that has gone quiet, `timeouts.wallMin` (90) one that runs too long. `preflight.confirm: true` makes `preflight` show its commands for the user to approve first.

**Harness isolation.** For each harness they use (`codex`, `claude-code`, `opencode`), offer `harness.<name>.isolated` with its harness line from `runs_summary` and this tradeoff: "native keeps your hooks, skills and AGENTS.md; isolated saves ~N tokens per run, but the role loses them." Recommend native. When they have no isolated runs yet, the number is the median first-turn input of their native runs: say that isolation would save some part of it, not all of it. When there are no runs at all, say there is no number yet, and recommend native until there is.

## 4. Write it

- Call `profile_set({ patch })` with only what changed; pass `name` only to edit a profile other than the active one. Lists (`rungs`, `notify`) replace, maps (`billing`, `failover`, `budget`) merge, and `null` removes a key. A key it does not know is refused with `E_INPUT_INVALID`. It validates before it writes:
  - `saved: false` comes with `errors`, each with a `path`, a `message` and often a `fix`. Explain each in their terms, fix the patch, and propose again.
  - `saved: true` comes with the `diff` (`path`, `before`, `after`) and any `warnings`. Read the diff back to the user, one line per change, and each warning with it.
- Then call `profile_validate()`. `errors` block a save: the worker disabled, an enabled role with no usable rung, an unscored rung without a "treat like", a failover stand-in unscored or on the same quota, a backend catherd cannot run. `warnings` do not: an access mode other than the role's default, a model the backend's listing lacks, a stand-in that never runs.

## 5. Say what applies when

- Codex, claude-code and opencode changes, access and isolation included, apply at the next dispatch, even in a run already under way.
- An agent listed in `newSessionNeededFor` applies from the next Claude Code session: Claude Code reads agent files when a session starts. Other Claude changes apply now.
- Editing a profile that is not the active one writes its agent files but links none; they apply once it becomes active (`catherd profile use <name>`), or in a repo it is bound to (`catherd profile use <name> --repo`).
