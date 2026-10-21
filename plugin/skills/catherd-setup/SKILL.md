---
name: catherd-setup
description: Use when the user wants to tune catherd — which models and efforts each role may use, how much each role may touch, cost versus speed, which subscriptions to lean on, failover, budget, harness isolation — /catherd-setup, "set up catherd", "tune my catherd profile". Not for running a task; that is the catherd skill.
---

# catherd setup

You tune the user's catherd profile in conversation. A profile says, per role, which rungs it may run on (`backend:model#effort`, in ladder order) and what it may touch (its access mode); whether routing favours cost or speed; how each backend is billed; whether Jev picks the rung; which rung stands in when a backend hits its usage limit; the run budget and timeouts; whether each vendor harness runs with the user's customizations or isolated; how many heavy commands run at once; and when to push.

**You never edit a file by hand.** Use `profile({ action: "set" })` for patches and the existing reviewed CLI reset below; both go through ProfileService, as do the `catherd profile` commands and the panel.

**Discover the host first with `status()`.** Use the host's available MCP discovery facility; names and deferred tools differ. Claude Code may use `ToolSearch`; Codex never needs invented Claude tools or native Claude agents. Pass the actual project `repo` explicitly to profile, setup and catalog calls that accept it: native Codex starts the MCP server in the installed plugin root, not the project. An unknown terminal can use `catherd init --host codex` or `--host claude-code` for setup; this does not create a conversation owner. Conflicting identity must be resolved before ownership or push.

## Rules

- **One question at a time.** Each question carries your recommended answer and one line on why, so the user can simply say yes.
- **The user steers.** When they reverse a proposal, take the reversal and never re-argue it.
- **Talk in their terms:** minutes, their subscriptions, how often a rung climbed on their own runs, tokens per run. Name the Slopalytics intelligence index only when they ask.
- **Every number you quote comes from a tool result in this conversation.** When there is no data yet, say so instead of estimating.

## 1. Learn the goals

Ask these, one at a time, each with its recommended answer:

1. **Their order of speed, cost and quality.** Recommend cost first, the default `objective`: catherd climbs a rung when a cheap one cannot do the work, so the lanes that need speed get it anyway, and the reviewer and the verifier hold quality either way.
2. **The subscriptions they hold:** a ChatGPT plan (Codex), a Claude plan, OpenCode Go, Zen credit or API keys. They set `billing` per key (`codex`, `claude`, `claude-code`, `opencode-go`, `opencode`, `cursor`): `chatgpt-plan`, `claude-plan`, `subscription` or `metered`. Recommend leaning on subscriptions before metered spend. Explain which workers share this conversation's quota from the actual host and billing facts.
3. **The kind of work they orchestrate:** front-end screens, back-end services, terminal and ops work, docs. Recommend from their own runs when the catalog's `runs:` evidence has any.

## 2. Read the facts before proposing

In one message, call:

- `catherd catalog list --role <role> --json` (in a shell, from their repo) for each role you will discuss: the models that can fill it, their indexed rungs (each with its `intelligence`, the one number catherd ranks on), each rung's cost under their billing, whether their backend's last listing offers it (`listed: false` means their account does not), and the `runs:` evidence of how each rung has done on their own runs (runs, refusals, climbs, time). The session has no catalog tool;
- `profile({ action: "get", repo })`: where they stand now, with each role's `access` and `enforcement`. Pass the user's repo: without a name, the profile tools act on the profile this repo runs on (the one bound to it, else the active one), which `here` names; `active` is the global active profile.

There is no per-run harness figure in the session: say so when isolation comes up.

Verify the exact omitted Codex model ID `gpt-6.1-sol` against native catalog discovery and validation. If its spelling differs, report the mismatch and resolve it explicitly with the owner; never silently normalize or substitute a model. Retain architect high and verifier low effort.

## 3. Propose one decision at a time

Go through these in order, and skip any the user does not care about:

1. `objective`, and `jev.use` (`auto` asks Jev when a key exists; `off` routes on each lane's `Kind:` and `Difficulty:` lines);
2. `billing`, from step 1;
3. the worker's `rungs` and its `defaultRung`;
4. the reviewer and the UI reviewer;
5. the architect and the verifier. Recommend omitted host defaults: on Codex, exactly `codex:gpt-6.1-sol#high` and `codex:gpt-6.1-sol#low`; on Claude Code, the existing native Claude defaults. A `claude:` rung requires a Claude Code host and its native `Agent`; `claude-code:` runs headless through `dispatch` on either host. Codex architect/verifier use process `dispatch`/`result`. Preserve explicit model IDs, efforts, ladder order and all other fields. Never silently convert `claude:` into `claude-code:`;
6. the writer, the researcher and the artist;
7. each role's `access` (below);
8. `failover` (below);
9. `budget`, `timeouts` and `preflight.confirm`;
10. harness isolation, per harness (below);
11. `lock.heavy` and `notify`.

Existing materialized profiles remain unchanged on read, init, upgrade or host switch. To deliberately opt into host defaults, use the existing CLI from the project directory, naming the profile returned by `profile({ action: "get" })`:

```sh
catherd profile reset-host-defaults <profile> --host codex --preview --json > /tmp/catherd-host-defaults-review.json
# Read the complete diff, effective defaults, errors and warnings before saving.
catherd profile reset-host-defaults <profile> --host codex --expect /tmp/catherd-host-defaults-review.json --json
```

Use `--host claude-code` for that host. This reviewed reset removes only architect/verifier `rungs` and `defaultRung`, preserving access, enabled state, network, budget, isolation, billing, routing and failover. The `--expect` file guards against a profile changing after review. There is no MCP reset tool. Offer the exact headless model/effort equivalent as a separate explicit choice when a native Claude rung is incompatible with Codex.

Each proposal has three parts: the change, a worked example from their facts, and the tradeoff in their terms. For instance: "Luna high on build lanes: about 5 min slower than Sol medium, no Claude quota, climbs on 1 in 5 of your runs so far."

- Offer only the rungs `catherd catalog list` shows as capable for the role, written `backend:model#effort`.
- Offer only the indexed pairs `catherd catalog list` shows. A model or effort the Slopalytics index does not list is not offered, and a rung that names one is an error: if the user wants it, say it is not indexed yet and propose the nearest indexed pair.

**Access.** Each role runs `read-only`, `workspace-write` or `full`. The defaults: architect, reviewer and researcher `read-only`; worker, writer and artist `workspace-write`; verifier and UI reviewer `full`. `profile({ action: "get" })` says per role whether its backend holds it to that mode (`enforced`: Codex's sandbox) or only asks (`advisory`: claude-code, opencode and native subagents, where the model can still reach past it). Recommend the defaults; when the user wants a role tighter or looser, say what it can no longer do (a read-only reviewer on claude-code or opencode has no shell, so it cannot run `git diff`) and that `profile({ action: "validate" })` will warn about it. A `workspace-write` role also writes catherd's lock dir and the temp dir, reaches the network, binds loopback ports and talks to a local Docker socket, so it runs its own installs and tests; `roles.<role>.network: false` takes the network, loopback and Docker away from that role (Codex enforces it; claude-code drops its web tools; opencode has no sandbox to enforce it). `catherd doctor` probes each of these per backend.

**Failover.** `failover` maps a rung to its stand-in when that rung's backend hits a usage limit. A stand-in must be indexed, on another quota and at least as intelligent as its rung (Go and Zen bill apart; native `claude` and `claude-code` share the Claude plan). The default profile fails a Codex rung over only to an indexed stand-in at least as intelligent: Go's GPT-6 Luna for Luna high, and Kimi K3 for Sol medium. Sol high and xhigh have none, so a limit there pauses the lane rather than dropping it a tier. Say so, and offer to change it when they have no Go subscription. `null` removes an entry.

**Budget and timeouts.** `budget` (`minutes`, `tokens`, `usd`) is a soft cap: from 80 % routing starts at the cheapest rung that clears the bar, and at 100 % no new role starts. `timeouts.idleMin` (15) stops a role that has gone quiet, `timeouts.wallMin` (90) one that runs too long; `roles.<role>.timeouts.idleMin` and `wallMin` override them for one role (a verifier with a long gate), and `null` removes the override. `preflight.confirm: true` makes `preflight` show its commands for the user to approve first.

**Notifications.** `notify` controls the milestone, finish and blocked moments. Where a parked question reaches the owner is `notify.url`, an ntfy topic url: set it with `profile({ action: "set", notify_url })` (ask them for the url; never invent one). The daemon sends to it from the machine, so a question reaches the phone with no session open. `catherd doctor --test-push` sends a labeled test notice.

**Harness isolation.** For each harness they use (`codex`, `claude-code`, `opencode`, `cursor`), offer `harness.<name>.isolated` and this tradeoff: "native keeps your hooks, skills and AGENTS.md; isolated saves some tokens per run, but the role loses them." Recommend native. The session reads no harness line, so quote no number. Codex reports no per-request input, so it has no harness figure (Codex has none: it reports no per-request input).

## 4. Write it

- Call `profile({ action: "set", repo, patch })` with only what changed; pass `name` only to edit a profile other than the one this repo runs on (a name that does not exist yet starts a new profile from the default one). Lists (`rungs`, `notify`) replace, maps (`billing`, `failover`, `budget`) merge, and `null` removes a key. A key it does not know is refused with `E_INPUT_INVALID`. It validates before it writes:
  - `saved: false` comes with `errors`, each with a `path`, a `message` and often a `fix`. Explain each in their terms, fix the patch, and propose again.
  - `saved: true` comes with the `diff` (`path`, `before`, `after`) and any `warnings`. Read the diff back to the user, one line per change, and each warning with it.
- Then call `profile({ action: "validate", repo })`. `errors` block a save: the worker disabled, an enabled role with no usable rung, a rung or failover stand-in the index does not list ("has no Slopalytics intelligence index"), a failover stand-in on the same quota, a backend catherd cannot run. `warnings` do not: an access mode other than the role's default, a model the backend's listing lacks, a stand-in that never runs, a stand-in less intelligent than its rung ("downgrade"), a Claude stand-in while another plan could stand in ("spends Claude quota"), a ladder whose rung is less intelligent than the one before it ("the ladder goes down"). Each has a `fix`; offer it.

## 5. Say what applies when

- Rung and ladder changes apply at the next dispatch, even in a run already under way. Access and isolation are pinned per run when it starts: a run under way keeps them until it is re-pinned (`catherd runs pin <run>`). Isolating Cursor needs `CURSOR_API_KEY` in the environment catherd runs in; `profile` validation refuses it without.
- Every role runs headless, so no agent file needs a new session: a change applies at the next dispatch. `newSessionNeededFor` stays empty unless a native Claude agent file is linked.
- ProfileService manages Claude agent files/links only when native Claude roles are used. Codex-only setup and profile operations do not write under `~/.claude`; Claude CLI/login is needed only by an enabled selected role or reachable failover that uses it. Editing an inactive Claude-dependent profile writes its managed files but links none; they apply once active or repo-bound. Keep role-disabled, access, isolation, budget and failover choices intact.
