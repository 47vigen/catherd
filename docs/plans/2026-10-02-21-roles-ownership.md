# catherd 1.5, plan 21: roles and ownership — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A role never becomes the run's owner or reaches the coordinator tools, isolated or not (the payment run's P1): the supervisor sets `CATHERD_ROLE`, `claimRun` and the full MCP server refuse a role, native subagents are forbidden the tools, and no notice goes to a role's thread. Around it, the rest of spec 1.5's plan 21: the `catherd_role` server in every harness (isolated Codex and Claude Code included), `catherd run-file` and `catherd gate` for roles without it, the #42 role server fixes, the lane file inlined in the brief, a per-role scratch `TMPDIR` with `catherd runs clean`, and a writer's implicit docs lane.

**Architecture:** The role's identity is `RoleScope { run, name }` (`src/domain/role-scope.ts`), written as `CATHERD_ROLE=<run>/<name>` into each dispatch's `spec.json` env, which the detached supervisor applies; a process knows it is a role from that env var or from a `TMPDIR` that is a role's scratch (`<run>/scratch/<name>/`), and `Deps.role` carries it. `claimRun` returns early on it; the full MCP server refuses coordinator tools at the request level. The supervisor writes each role's thread to `thread.json`, and the notifier fails a notice whose target is one. Briefs are composed in `src/domain/brief.ts`; the writer's implicit Owns (`admit.ownsImplicit`) joins attribution in `finalize`.

**Tech Stack:** Bun ≥ 1.4, TypeScript, zod 4, citty, `@modelcontextprotocol/sdk`. No new dependency.

**Spec:** `docs/specs/2026-10-02-catherd-1.5-design.md`, "Plan 21: roles and ownership" (and "Owner rulings carried in" 3), on top of the earlier specs; evidence in `docs/dev/ideas.md` ("From the reviews of #42 and #43", #42 findings 1, 2, 4, 5, 6, 8, 9; "A native role steals the run … (P1)"; "An isolated headless worker cannot read its lane file"; "Roles litter `/tmp`"; "A writer's edits are blamed on the lanes").


**Pre-validated on scratch `6f2f8c7..8d17046` (worktree branch `plan21-scratch`: code head `8d17046`, then this plan file as the last commit): 2039 pass / 19 skip / 0 fail (2058 tests, 192 files, about 6 minutes; baseline 2009 pass / 19 skip on 182 files); typecheck, lint and format:check green.** The code below is that scratch build, one commit per task, built on `main` (`6f2f8c7`, #45 "remove wait").


## Global Constraints

- Spec 1.5, plan 21, verbatim: "The P1 first: a role must never become the run's owner or reach coordinator tools, isolated or not."
- "The supervisor sets `CATHERD_ROLE=<run>/<role-name>` in every role's env on every backend. `claimRun` never claims from a request whose process carries it, and the full MCP server, started inside a role, refuses the coordinator tools (`peek` of another role, `result`, `dispatch`, `run_start`, `climb`, `land`, `park`, `cancel`, `set_next`, `answer`, `profile_set`, the `workspace_*` writers) with `E_ROLE_SCOPE` and a fix line. A native Claude subagent has no env of its own: the skill and the agent file forbid those tools there, and the tool descriptions say "orchestrator only"."
- "A delivery whose target is not the owner of record at enqueue time, or is a `codex exec` thread (recorded in the dispatch), fails with a loud log and a `status` warning instead of `enqueue-accepted`."
- "Remove the isolated refusal and `roleRequiresMcp`'s admission use. Codex gets the `-c mcp_servers.catherd_role.*` overrides whether isolated or not (verified under `--ignore-user-config`). Claude: verify whether `--mcp-config` survives `--safe-mode`; if not, isolated Claude uses `--strict-mcp-config --mcp-config` instead of `--safe-mode`'s MCP drop. opencode gets the server through its own config mechanism where it has one, else its role prompt names the CLI forms below."
- "`catherd run-file read|write <run> <path>`, `catherd gate check|pass <run> …`, bound by `CATHERD_ROLE` to that run. The verifier brief names them as the fallback when no MCP tool is listed."
- "`read_knowledge` takes an optional `repo` and uses the run's; `RUN_FILES` names only the tools a role gets; doctor's role-MCP row covers the active profile only and drops the always-true entry check; `profile validate` no longer needs to warn about isolation; the role server gets an explicit `startup_timeout_sec` (30) and stays `required` only after a doctor probe shows it starts in time."
- "`dispatch` with `lane` inlines the lane file (header and body) into the brief."
- "Each dispatch gets `TMPDIR=<run>/scratch/<name>/`; the brief names it; `runs` cleanup removes it with the run."
- "The writer gets an implicit docs lane (its Owns: the paths its brief names, default `docs/**`, `*.md`); edits are attributed to the process that wrote them by comparing each dispatch's own before/after snapshot, so a concurrent writer's edits are never a lane's violation."
- "Delete `docs/dev/reports/role-access-orchestration-wait-pr.md` (#42 finding 9)."
- Owner ruling 3 (spec 1.5) and cross-plan ruling X6: "A role is never refused for being isolated"; isolation stays the profile's per-backend toggle.
- Cross-plan ruling X4: `CATHERD_ROLE`, `E_ROLE_SCOPE`, the role server in every harness, the run-file/gate CLI forms and per-role scratch are this plan's; later plans consume `CATHERD_ROLE` (`<run>/<role-name>`) as an env var the supervisor sets.
- Layers `domain → infra → adapters → services → entry` (`test/architecture.test.ts`). The gate: `bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test`. Tests that could reach the network delete `ANTHROPIC_API_KEY` or pass `ANTHROPIC_API_KEY: ""` to what they spawn; spawned processes get an explicit `env`; no wall-clock sleep decides a result.
- Commits: conventional, subject ≤ 100 characters, lower-case first word after the scope; check `git log` after each (a failed hook leaves the changes uncommitted). No changeset (plan 27 writes 1.5.0's).

## Review Focus

1. **A native Codex role, with isolation off and the catherd plugin installed, calls `peek({run})`** (the payment run's P1). Codex hands an MCP server `TMPDIR` but not `CATHERD_ROLE`. Expected: `E_ROLE_SCOPE`; the orchestrator stays the owner; nothing is queued to the role's thread. Pinned in Task 1 (`role-scope-mcp.test.ts` "the full server in a role refuses every coordinator tool with E_ROLE_SCOPE, and the run keeps its owner"; `role-env.test.ts` "gives every role CATHERD_ROLE=<run>/<name> and its own scratch as TMPDIR …", which checks a server that sees only the role's `TMPDIR` knows the role).
2. **A run that 1.4 already handed to a role's exec thread.** Expected: each notice for it fails loudly instead of `enqueue-accepted`, `status` warns, and once the orchestrator's `peek(run)` takes the run back the notice goes to it. Pinned in Task 3 (`role-thread-delivery.test.ts` "fails a notice to a role's thread loudly, never sends it, and status warns; the orchestrator gets it once it takes the run back").
3. **An isolated Claude Code verifier.** `--safe-mode` drops every `--mcp-config` server, so it would have no gate tools. Expected: admitted, with the role server and without `--safe-mode`, the user's settings, skills and CLAUDE.md still off. Pinned in Task 4 (`role-server-harness.test.ts` "admits an isolated Claude Code verifier, isolated piece by piece so its --mcp-config survives"), with live step §15.3.
4. **A failover stand-in that reruns a brief admission already composed, after the architect changed the lane.** Expected: one lane block, the lane as it stands now, one set of notes, the contract last. Pinned in Task 7 (`brief.test.ts` "writes each part once when a failover stand-in reruns an earlier brief …"; `failover-cancel.test.ts` "reruns a fresh round's own brief on the stand-in …").
5. **A writer editing docs while a lane's fix runs.** Expected: the lane's record has no violation for them, and the writer's record lists them as its own. Pinned in Task 9 (`writer-attribution.test.ts` "attributes a concurrent writer's doc edits to the writer …").
6. **A role's shell running `catherd run-file read <another run> …` or a worker running `catherd gate pass`.** Expected: `E_ROLE_SCOPE`, nothing read or written. Pinned in Task 5 (`role-cli-command.test.ts`, both cases).

## Rulings on the spec

Controller rulings carried in: X1 (build on `main` 6f2f8c7; the executor adapts to earlier merged plans), X4, X6, X7, X8 (a vendor behaviour this sandbox cannot run is decided from the installed CLI's help or source, else the simulator plus a Ruling and a `live-verification.md` step).

Rulings of this plan (`what — why — cost if wrong`):

1. **`CATHERD_ROLE` (and the scratch `TMPDIR`) travel in `spec.json`'s env**, which the detached supervisor applies to the worker through `workerEnv` (spec env wins over its own). — The supervisor is the one process that spawns every role, on every backend, failover stand-ins included; `spec.json` already holds non-secret overrides. — Cost if wrong: none; the value is not a secret.
2. **A process is also a role when its `TMPDIR` is a role's scratch** (`…/runs/<YYYYMMDD-HHMMSS-…>/scratch/<name>[/…]`). — Codex starts an MCP server with a short default env list (`HOME`, `PATH`, `TMPDIR`, … in Codex's rmcp client) plus the server's own `env`/`env_vars`, so `CATHERD_ROLE` never reaches the user's catherd plugin server inside a native Codex role, while `TMPDIR` does; the plugin launcher hands `TMPDIR` through `CATHERD_USER_TMPDIR` and `restoreTmpdir` puts it back. No `codex` CLI in this sandbox: decided from Codex's source as known, with live step §15.1. Overriding the plugin server's own config with `-c mcp_servers.catherd.env_vars=…` was rejected: a plugin server's config key is not known, and a `-c` on a server the user's config does not define breaks Codex's start. — Cost if wrong: a native Codex role's plugin server would not know it is a role, so it could claim again; Task 3 still keeps every notice off its thread.
3. **The refusal runs at the MCP request level, before input validation**, by wrapping the SDK's `tools/call` handler (a private map, as `server.ts` already patches `createToolError`); `role-scope-mcp.test.ts` fails if the SDK moves it. — A role calling `peek({run})` with partial input must learn the tool is not its own, not that its input is wrong. — Cost if wrong: one test fails on an SDK upgrade.
4. **A role may `peek` its own dispatch** (its run and its own name; this never claims, since `claimRun` refuses it) **and read `workspace_contract`** (no `content`). — The spec names "`peek` of another role" and "the `workspace_*` writers". — Cost if wrong: none.
5. **"Orchestrator only (a role process gets E_ROLE_SCOPE)." prefixes each coordinator tool's description**, added once in `logToolCalls`'s `registerTool` wrapper. — "the tool descriptions say "orchestrator only"". — Cost if wrong: about 15 tokens per tool listing.
6. **A native subagent's agent file adds the 14 `mcp__plugin_catherd_catherd__<tool>` names to `disallowedTools`**, and its prompt ends with `NOT_THE_ORCHESTRATOR`. — Claude Code's `disallowedTools` takes MCP tool names; live step §15.4 confirms. — Cost if wrong: the line stays advisory, as the skill's.
7. **A role's thread** is any thread a dispatch of the run recorded: its record's `thread`, a resumed `admit.thread`, or `thread.json`, which the supervisor writes the first time the CLI names its thread. **"Not the owner of record at enqueue time" needs no new check**: the notifier sends only to the current session when it owns the run, checked when queued and again under the claim just before sending; the refusal of a role's thread covers the case where the owner of record is itself a role's (left by 1.4). — The spec's two halves; the second is how the P1's notices were lost. — Cost if wrong: none.
8. **A refused notice is a `failed` delivery attempt** whose reason starts `refused: the target is a role's thread` (`ROLE_THREAD_REFUSAL`), logged at `error`; its delivery state for the orchestrator stays `pending`, and `status` warns while that attempt is the dispatch's latest. — `failed` is the existing "provably not submitted" status, so nothing treats it as sent. — Cost if wrong: none.
9. **Isolated Claude Code with the role server drops `--safe-mode`** for `--strict-mcp-config --setting-sources "" --disable-slash-commands` and `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`; a run without the role server (fixture capture) keeps `--safe-mode`. — Verified in the installed Claude Code 2.1.287: safe mode keeps only `sdk` servers of `--mcp-config` and logs "--mcp-config: N servers ignored (safe mode)"; `--setting-sources ""` parses to no sources (no settings files: no hooks, no enabled plugins); `CLAUDE_CODE_DISABLE_CLAUDE_MDS` is what safe mode itself sets. — Cost if wrong: user agents (`~/.claude/agents`) and output styles still load in an isolated headless role; live step §15.3 checks hooks, CLAUDE.md and MCP.
10. **opencode gets no role server**: its v2 background service ignores a client's config env (the adapter's own comment), so a per-dispatch MCP config has no mechanism; opencode, Cursor, Grok Build and agy roles get the CLI forms in their brief. — "else its role prompt names the CLI forms". — Cost if wrong: none; a later plan can add the server where a backend gains a mechanism.
11. **The CLI forms outside a role work on any run** (the user's terminal is the owner's); **in a role they are bound to its run and to its role's tools**, the role kind read from its latest dispatch's `admit.role`; `write` reads stdin. — "bound by `CATHERD_ROLE` to that run"; the role server's own tool split. — Cost if wrong: a backend whose shell drops the env would act as a terminal; every backend's shell inherits it.
12. **The role server's `read_knowledge` accepts any `repo` and ignores it**, reading the run's repository. — "takes an optional `repo` and uses the run's"; refusing a mismatch was finding 4's bug. — Cost if wrong: none.
13. **Doctor probes the role server's cold start** (`role-bin.ts --probe` loads the server's whole module graph and prints `ready`, no run, no model turn): `info configured … Starts in N ms (limit 30 s).`, `warn slow start` past 15 s, `fail no start`. `required=true` stays, with `startup_timeout_sec=30`. — "stays `required` only after a doctor probe shows it starts in time"; the scratch probe starts in well under a second. — Cost if wrong: one Bun start per `catherd doctor`.
14. **`profile validate` gains nothing**: no rule of it ever warned about isolation; a test pins that isolating codex and claude-code changes no issue. — The spec's "no longer needs to warn". — Cost if wrong: none.
15. **The scratch `TMPDIR` is set on codex, claude-code and opencode**, and granted as a write root in Codex's `writable_roots` and Claude Code's sandbox `allowWrite`; Cursor, Grok Build and agy keep the inherited `TMPDIR`, since their sandbox grants are written once per isolated home, not per dispatch, and a `TMPDIR` their sandbox refuses would break every temp file. — Smallest change that cannot break a role. — Cost if wrong: roles on those three still write to `/tmp`.
16. **"`runs` cleanup" is a new `catherd runs clean [<id>]`**: it removes `<run>/scratch/` of a run with no live role. The scratch lives in the run folder, so whatever removes a run removes it too. — There is no runs cleanup command to extend. — Cost if wrong: a command name.
17. **The brief is composed in `src/domain/brief.ts`**: the orchestrator's text, the lane file in a `<lane-file path="lanes/<id>.md">` block as it stands at admission, the role's notes (who it is, its scratch as `$TMPDIR`, its catherd tools with the CLI fallback, or the CLI alone), the reply contract last; a rerun brief keeps one copy of each part, the lane current. No size cap. — "inlines the lane file (header and body)"; "the brief names it". — Cost if wrong: a few hundred tokens per brief.
18. **A writer's implicit Owns** (`admit.ownsImplicit`: its brief's `Owns:` line, else `docs/**`, `*.md`) sets its `changedOwned` and joins the other dispatches' Owns in attribution for overlapping windows; admission's overlap check ignores it. Attribution by raw before/after diff alone was rejected: windows overlap, so a writer's own snapshot diff also holds the lanes' concurrent edits, and trusting it would hide a lane's real violation. Only the writer gets one ("The writer gets an implicit docs lane"). — Cost if wrong: a lane's out-of-lane edit to a doc during a writer's window goes unflagged.
19. **Owns entries gain `dir/**` and `*.ext` in attribution only** (`ownsPath`); the lane overlap check (`overlaps`) is unchanged. — The default docs lane needs both forms. — Cost if wrong: none for lanes.
20. **`E_ROLE_SCOPE` joins `ErrorCode`**; its MIGRATION note is plan 27's. — Spec plan 27. — Cost if wrong: none.
21. **`ideas.md` keeps #42 findings 3 and 7 verbatim, with their numbers**, for plan 22, whose spec bullet cites them by number. — "Partially fixed entries are trimmed to what stays open". — Cost if wrong: none.
22. **A non-isolated opencode role cannot be bound by env** (final review, finding 2; narrows ruling 15): without `--standalone`, opencode v2 runs its tools in the shared background service, whose env the client cannot set, so neither `CATHERD_ROLE` nor a scratch `TMPDIR` reaches the role's shell. Only an isolated (standalone) opencode role gets the scratch `TMPDIR` and the brief's scratch note (`grantsScratch`); a non-isolated one gets neither, and its CLI forms act as from the user's terminal (unbound). — The brief must not claim a `$TMPDIR` the shell does not have. — Cost if wrong: a non-isolated opencode role writes temp files to `/tmp`, and its CLI forms are not scoped to its run; live step §15.5 checks the isolated case.

## Assumes

- `main` at `6f2f8c7`. Plans 22–26 are written in parallel on the same base and run after this one (X1).
- Each task's diff is re-found by its context if `main` moved; the line numbers in the hunks are the scratch build's.
- Step 4's counts are the focused files' totals on the scratch head.

## Verified facts (scratch build, 2026-10-02)

- Claude Code 2.1.287 (`claude --help`, and the minified source in `/opt/claude-code/bin/claude`): `--safe-mode` "Start with all customizations (CLAUDE.md, skills, installed plugins, hooks, MCP servers, custom commands and agents, …) disabled … Sets CLAUDE_CODE_SAFE_MODE=1"; in safe mode the `--mcp-config` servers are filtered to `type === "sdk"` and the rest logged as "--mcp-config: N servers ignored (safe mode)"; `--setting-sources` parses `""` to `[]`; safe mode sets `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, which skips every CLAUDE.md.
- No `codex` or `opencode` CLI in the sandbox: their behaviour comes from the simulators (`test/sim/codex`, which now records `CATHERD_ROLE` and `TMPDIR`) and Rulings 2 and 10.
- The role server's cold start (`role-bin.ts --probe`) takes about 0.15 s on the scratch machine.
- The full MCP server's `tools/call` handler lives in `server.server._requestHandlers` (`@modelcontextprotocol/sdk` 1.30), wrapped after every tool is registered.
- The baseline gate on `6f2f8c7`: 2009 pass, 19 skip, 0 fail (182 files).

## File Structure

| File | Task | Responsibility |
| --- | --- | --- |
| `src/domain/role-scope.ts` (new) | 1 | `CATHERD_ROLE`, `RoleScope`, the scratch-TMPDIR fallback, `COORDINATOR_TOOLS`, `refusedForRole`, `roleScopeError` |
| `src/domain/errors.ts`, `src/services/ports.ts`, `src/entry/deps.ts` | 1 | `E_ROLE_SCOPE`; `Deps.role` from the env |
| `src/services/sessions.ts` | 1 | `claimRun` refuses a role |
| `src/entry/mcp/server.ts` | 1 | request-level refusal; "Orchestrator only" descriptions |
| `src/services/admission.ts` | 1, 4, 7, 9 | role env and scratch (1); role server isolated or not (4); `composeBrief` (7); `ownsImplicit` (9) |
| `src/services/run-store.ts`, `src/services/dispatches.ts` | 1, 3, 9 | `runPaths().scratch`, `scratchDir` (1); `readThread`, `roleThreadOf` (3); `Admit.ownsImplicit` (9) |
| `src/adapters/backend.ts`, `src/adapters/codex/index.ts`, `src/adapters/claude-code/index.ts` | 1, 4 | scratch write root (1); Claude isolation with the role server (4) |
| `src/domain/role-prompts.ts`, `src/domain/agents.ts` | 2, 6 | native subagents forbidden the coordinator tools (2); per-role run-file text, verifier CLI fallback (6) |
| `src/infra/dispatch-dir.ts`, `src/infra/supervisor.ts`, `src/infra/delivery.ts`, `src/services/notifier.ts`, `src/services/summary.ts` | 3 | `thread.json`; the role-thread refusal and its `status` warning |
| `src/services/role-access.ts`, `src/entry/role-cli-command.ts` (new), `src/cli.ts` | 5 | `catherd run-file`, `catherd gate` |
| `src/infra/role-mcp.ts`, `src/entry/mcp/role-bin.ts`, `src/entry/mcp/role-server.ts`, `src/domain/role-tools.ts`, `src/services/doctor-role-mcp.ts`, `src/services/doctor.ts`, `src/entry/doctor-command.ts` | 6, 7 | startup timeout and probe, `read_knowledge`, doctor rows (6); backend sets (7) |
| `src/domain/brief.ts` (new) | 7 | the composed brief |
| `src/services/scratch.ts` (new), `src/entry/runs-command.ts` | 8 | `catherd runs clean` |
| `src/domain/changes.ts`, `src/services/finalize.ts` | 9 | `DOCS_OWNS`, `briefOwns`, `ownsPath`; attribution with `ownsImplicit` |
| `plugin/skills/catherd/SKILL.md` | 2, 4, 7, 9 | the coordinator tools; the role server; what `dispatch` adds to a brief; the writer's `Owns:` |
| `README.md` | 5, 8 | the CLI rows |
| `docs/dev/live-verification.md` | 4 | section 15 |
| `docs/dev/reports/role-access-orchestration-wait-pr.md` | 6 | deleted |
| `docs/dev/ideas.md` | 10 | the fixed entries removed |
| `test/sim/codex`, `test/sim/scenario.ts`, `test/sim/claude` | 1, 4 | the Codex simulator records the role env; the Claude simulator takes the new flags |
| `test/services/helpers.ts` | 7 | `briefFor` |

## Coverage: spec bullet → task

| Spec 1.5 plan 21 bullet | Task |
| --- | --- |
| The P1 first | 1 (first task, Review Focus 1) |
| `CATHERD_ROLE`: the supervisor sets it on every backend | 1 |
| `claimRun` never claims from it | 1 |
| The full MCP server refuses the coordinator tools with `E_ROLE_SCOPE` and a fix line | 1 |
| Native subagent: skill and agent file forbid them; descriptions say "orchestrator only" | 2 (descriptions: 1) |
| Deliveries never target a role thread (not the owner of record, or a `codex exec` thread) | 3 |
| Remove the isolated refusal and `roleRequiresMcp`'s admission use (#42 findings 1, 2) | 4 |
| Codex overrides whether isolated or not | 4 |
| Claude: `--mcp-config` vs `--safe-mode`, else `--strict-mcp-config --mcp-config` | 4 |
| opencode: its own config mechanism, else the CLI forms | 4 (Ruling 10), 7 (the brief names them) |
| CLI forms `catherd run-file read\|write`, `catherd gate check\|pass`, bound by `CATHERD_ROLE` | 5 |
| The verifier brief names them as the fallback | 6 (native prompt), 7 (every headless brief) |
| `read_knowledge` optional `repo` (#42 finding 4) | 6 |
| `RUN_FILES` names only a role's tools (#42 finding 5) | 6 |
| doctor's role-MCP row: active profile only, no entry check (#42 finding 6) | 6 |
| `profile validate` no isolation warning | 6 (pinned) |
| `startup_timeout_sec` (30), `required` after a doctor probe (#42 finding 8) | 6 |
| The lane file reaches the worker | 7 |
| Per-role scratch: `TMPDIR=<run>/scratch/<name>/` | 1 |
| … the brief names it | 7 |
| … `runs` cleanup removes it | 8 |
| Non-lane roles' edits: the writer's implicit docs lane, attribution | 9 |
| Delete `docs/dev/reports/role-access-orchestration-wait-pr.md` (#42 finding 9) | 6 |
| ideas.md entries removed | 10 |

## Parallelism

| Wave | Batches (parallel worktrees) | Depends on | Why disjoint |
| --- | --- | --- | --- |
| A | {1} | — | the P1, alone and first |
| B | {2, 4}, {3}, {5, 8} | A | skill, role prompts, agents, admission, claude-code adapter, Claude sim, live-verification (2, 4) vs supervisor, dispatch-dir, delivery, dispatches, notifier, summary, `role-env.test.ts` (3) vs README, `cli.ts`, `runs-command.ts`, new `role-cli-command.ts`, `role-access.ts`, `scratch.ts` (5, 8) |
| C | {6, 7, 9} | B | `role-prompts.ts` (after 2), `role-tools.ts` (6 then 7), `admission.ts` (7 then 9), the skill (7, 9), `dispatches.ts` (9, after 3): one batch, in order |
| D | {10} | C | `docs/dev/ideas.md` only |

Shared files, each owned by one task at a time: `src/services/admission.ts` (1, 4, 7, 9), `src/services/dispatches.ts` (1, 3, 9), `plugin/skills/catherd/SKILL.md` (2, 4, 7, 9), `src/domain/role-prompts.ts` (2, 6), `src/domain/role-tools.ts` (6, 7), `README.md` (5, 8), `test/services/role-env.test.ts` (1, 3), `test/services/admission.test.ts` (1, 7), `test/skills.test.ts` (2, 7, 9). Fewer agents: {1}, then {2, 4, 6, 7, 9} beside {3} and {5, 8}, then {10}.

**Files plans 22–26 also touch** (X1: the later plan adapts): `src/services/notifier.ts` and `src/infra/supervisor.ts` (plan 22's supervisor push), `src/services/summary.ts` (plan 22's `status()` rules), `src/entry/runs-command.ts` (plan 25's `runs supersede`), `src/services/admission.ts` and `src/services/finalize.ts` (plans 23, 25), `plugin/skills/catherd/SKILL.md` (plans 22, 23), `src/domain/role-prompts.ts` (plan 23's verifier brief), `docs/dev/ideas.md` (every plan's last task), `src/services/doctor.ts` (plans 23, 26).

---

### Task 1: A role never owns the run nor reaches the coordinator tools (the P1) (spec "`CATHERD_ROLE`" bullet; Rulings 1–5, 15)

The payment run's P1: a native `codex exec` verifier loaded the user's catherd plugin, called `peek({run})`, became the run's owner, and every later notice went to its dead thread. This task makes that impossible in the full MCP server, isolated or not:

- admission writes `CATHERD_ROLE=<run>/<name>` (and, on codex, claude-code and opencode, `TMPDIR=<run>/scratch/<name>/`, created 0700 and granted as a write root in the Codex and Claude Code sandboxes) into `spec.json`'s env, which the detached supervisor applies to the role's process (`workerEnv`);
- `defaultDeps()` reads the role from `CATHERD_ROLE`, else from a `TMPDIR` that is a role's scratch (Codex passes an MCP server `TMPDIR` but not `CATHERD_ROLE`, Ruling 2) into `Deps.role`;
- `claimRun` returns false for a process with `deps.role`;
- the full MCP server, with `deps.role` set, refuses every coordinator tool with `E_ROLE_SCOPE` and a fix line **before** input validation (a role learns at once the tool is not its own), except a `peek` of its own dispatch and a `workspace_contract` read; every coordinator tool's description starts "Orchestrator only (a role process gets E_ROLE_SCOPE).".

`test/services/role-env.test.ts` is shown here as Task 1 commits it; Task 3 adds the thread assertions to it.

**Files:**
- Modify: `src/adapters/backend.ts`
- Modify: `src/adapters/claude-code/index.ts`
- Modify: `src/adapters/codex/index.ts`
- Modify: `src/domain/errors.ts`
- Create: `src/domain/role-scope.ts`
- Modify: `src/entry/deps.ts`
- Modify: `src/entry/mcp/server.ts`
- Modify: `src/services/admission.ts`
- Modify: `src/services/dispatches.ts`
- Modify: `src/services/ports.ts`
- Modify: `src/services/run-store.ts`
- Modify: `src/services/sessions.ts`
- Create: `test/domain/role-scope.test.ts`
- Create: `test/entry/role-scope-mcp.test.ts`
- Test: `test/services/admission.test.ts`
- Create: `test/services/role-env.test.ts`
- Test: `test/sim/codex`
- Test: `test/sim/scenario.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `src/domain/role-scope.ts`: `ROLE_ENV = "CATHERD_ROLE"`, `interface RoleScope { run: string; name: string }`, `formatRoleScope(s): string`, `parseRoleScope(value?: string): RoleScope | null`, `roleScopeOfScratch(tmpdir?: string): RoleScope | null`, `roleScopeFromEnv(env): RoleScope | null`, `COORDINATOR_TOOLS` (14 names), `isCoordinatorTool(tool): boolean`, `refusedForRole(tool, args, scope): boolean`, `roleScopeError(tool, scope): CatherdError`. `ErrorCode` gains `"E_ROLE_SCOPE"`. `Deps.role?: RoleScope | null`. `runPaths(dir).scratch`; `scratchDir(run, name)` in `src/services/dispatches.ts`. `RunRequest.scratch?: string`. `codexGrants(access, network, isolated, extra: string[] = [])`, `claudeAccessArgs(access, network, repo?, extra: string[] = [])`. The Codex simulator records `catherdRole` and `tmpdir`.

**Scratch commit:** `1b96649` (fix(roles): a role never claims a run nor reaches the coordinator tools).

- [ ] **Step 1: Write the failing tests**

````diff
diff --git a/test/domain/role-scope.test.ts b/test/domain/role-scope.test.ts
new file mode 100644
index 0000000..0d7428f
--- /dev/null
+++ b/test/domain/role-scope.test.ts
@@ -0,0 +1,81 @@
+import { describe, expect, it } from "bun:test";
+import {
+  COORDINATOR_TOOLS,
+  parseRoleScope,
+  refusedForRole,
+  roleScopeError,
+  roleScopeFromEnv,
+  roleScopeOfScratch,
+} from "../../src/domain/role-scope.ts";
+
+const RUN = "20261002-101500-auth";
+const scope = { run: RUN, name: "verifier-M1" };
+
+describe("CATHERD_ROLE (spec 1.5 plan 21)", () => {
+  it("reads <run>/<role-name>, and nothing else", () => {
+    expect(parseRoleScope(`${RUN}/verifier-M1`)).toEqual(scope);
+    for (const bad of [undefined, "", RUN, `${RUN}/`, `/x`, `${RUN}/a/b`, `${RUN}/../x`, `${RUN}/-x`])
+      expect(parseRoleScope(bad)).toBeNull();
+  });
+
+  it("knows a role by a TMPDIR that is its scratch, when Codex drops CATHERD_ROLE", () => {
+    const tmp = `/home/u/.local/share/catherd/repos/app-1a2b3c4d/runs/${RUN}/scratch/verifier-M1`;
+    expect(roleScopeOfScratch(tmp)).toEqual(scope);
+    expect(roleScopeOfScratch(`${tmp}/`)).toEqual(scope);
+    expect(roleScopeOfScratch(`${tmp}/sub/dir`)).toEqual(scope);
+    // a plain temp dir, or a folder that only looks like one, is not a role's
+    for (const other of [
+      undefined,
+      "/tmp",
+      "/var/folders/x/T/",
+      "/home/u/runs/x/scratch/y",
+      "/runs/123/scratch/a",
+    ])
+      expect(roleScopeOfScratch(other)).toBeNull();
+    expect(roleScopeFromEnv({ TMPDIR: tmp })).toEqual(scope);
+    // CATHERD_ROLE wins over the temp dir
+    expect(roleScopeFromEnv({ CATHERD_ROLE: `${RUN}/worker-M1.L1`, TMPDIR: tmp })).toEqual({
+      run: RUN,
+      name: "worker-M1.L1",
+    });
+    expect(roleScopeFromEnv({ TMPDIR: "/tmp" })).toBeNull();
+  });
+
+  it("refuses every coordinator tool, except a peek of the role's own dispatch and a contract read", () => {
+    expect([...COORDINATOR_TOOLS].sort() as string[]).toEqual(
+      [
+        "answer",
+        "cancel",
+        "climb",
+        "dispatch",
+        "land",
+        "park",
+        "peek",
+        "profile_set",
+        "result",
+        "run_start",
+        "set_next",
+        "workspace_child_start",
+        "workspace_contract",
+        "workspace_start",
+      ].sort(),
+    );
+    for (const tool of COORDINATOR_TOOLS)
+      expect(refusedForRole(tool, { run: "other", content: "x" }, scope)).toBe(true);
+    expect(refusedForRole("peek", { run: RUN, name: "verifier-M1" }, scope)).toBe(false);
+    expect(refusedForRole("peek", { run: RUN }, scope)).toBe(true);
+    expect(refusedForRole("peek", { run: RUN, name: "worker-M1.L1" }, scope)).toBe(true);
+    expect(refusedForRole("peek", undefined, scope)).toBe(true);
+    expect(refusedForRole("workspace_contract", { workspace: "w" }, scope)).toBe(false);
+    expect(refusedForRole("workspace_contract", { workspace: "w", content: "x" }, scope)).toBe(true);
+    for (const tool of ["status", "read_run_file", "write_run_file", "gate_check", "gate_pass", "route"])
+      expect(refusedForRole(tool, { run: RUN }, scope)).toBe(false);
+  });
+
+  it("says why, with a fix line", () => {
+    const e = roleScopeError("result", scope);
+    expect(e.code).toBe("E_ROLE_SCOPE");
+    expect(e.message).toBe(`result is the orchestrator's: this process runs verifier-M1 of run ${RUN}`);
+    expect(e.fix).toContain(`catherd run-file read ${RUN} <path>`);
+  });
+});
diff --git a/test/entry/role-scope-mcp.test.ts b/test/entry/role-scope-mcp.test.ts
new file mode 100644
index 0000000..9683a7f
--- /dev/null
+++ b/test/entry/role-scope-mcp.test.ts
@@ -0,0 +1,101 @@
+import { afterEach, describe, expect, it } from "bun:test";
+import { Client } from "@modelcontextprotocol/sdk/client/index.js";
+import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
+import { COORDINATOR_TOOLS } from "../../src/domain/role-scope.ts";
+import { buildServer } from "../../src/entry/mcp/server.ts";
+import type { Deps } from "../../src/services/ports.ts";
+import { claimRun, readSessionRows, runOwner } from "../../src/services/sessions.ts";
+import { snapshotEnv } from "../helpers.ts";
+import { call } from "../mcp-helpers.ts";
+import { fakeDeps, freshRun } from "../services/helpers.ts";
+
+afterEach(snapshotEnv());
+
+const COORDINATOR = "0199c011-1234-7000-8000-00000000c00d";
+const ROLE_THREAD = "0199c011-1234-7000-8000-0000000001e5";
+const codex = (sessionId: string) => ({
+  host: "codex" as const,
+  session: { host: "codex" as const, sessionId, hostSessionId: null, name: null },
+  conflict: null,
+});
+
+/** A Codex client on the full server, each call on `thread` (as Codex sends `_meta.threadId`). */
+async function codexClient(deps: Deps): Promise<Client> {
+  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
+  await buildServer(deps).connect(serverSide);
+  const client = new Client({ name: "codex-mcp-client", version: "0" });
+  await client.connect(clientSide);
+  return client;
+}
+
+async function codexCall(client: Client, name: string, args: Record<string, unknown>, thread: string) {
+  const r = await client.callTool({ name, arguments: args, _meta: { threadId: thread } });
+  return r.isError ? (r.structuredContent as { code: string; fix: string }) : null;
+}
+
+describe("a role never owns the run nor reaches the coordinator tools (spec 1.5 plan 21, P1)", () => {
+  it("claimRun never claims from a process that carries CATHERD_ROLE", async () => {
+    const { run } = freshRun();
+    expect(await claimRun(fakeDeps({ host: codex(COORDINATOR) }), run)).toBe(true);
+    const role = { ...fakeDeps({ host: codex(ROLE_THREAD) }), role: { run: run.id, name: "verifier-M1" } };
+    expect(await claimRun(role, run)).toBe(false);
+    expect(runOwner(run)?.sessionId).toBe(COORDINATOR);
+    expect(readSessionRows(run).map((r) => r.sessionId)).toEqual([COORDINATOR]);
+  });
+
+  it("the full server in a role refuses every coordinator tool with E_ROLE_SCOPE, and the run keeps its owner", async () => {
+    const { run } = freshRun();
+    await claimRun(fakeDeps({ host: codex(COORDINATOR) }), run);
+    const deps: Deps = { ...fakeDeps(), role: { run: run.id, name: "verifier-M1" } };
+    const client = await codexClient(deps);
+    try {
+      // the payment run's P1: the verifier's exec thread called peek({run})
+      for (const tool of COORDINATOR_TOOLS) {
+        const e = await codexCall(client, tool, { run: run.id, content: "x" }, ROLE_THREAD);
+        expect([tool, e?.code]).toEqual([tool, "E_ROLE_SCOPE"]);
+        expect(e?.fix).toContain(`catherd run-file read ${run.id}`);
+      }
+      expect(runOwner(run)?.sessionId).toBe(COORDINATOR);
+      // its own dispatch it may peek at, without claiming; reads stay open
+      expect(await codexCall(client, "peek", { run: run.id, name: "verifier-M1" }, ROLE_THREAD)).toBeNull();
+      expect(await codexCall(client, "status", { run: run.id }, ROLE_THREAD)).toBeNull();
+      expect(
+        await codexCall(client, "read_run_file", { run: run.id, path: "meta.json" }, ROLE_THREAD),
+      ).toBeNull();
+      expect(runOwner(run)?.sessionId).toBe(COORDINATOR);
+      expect(readSessionRows(run).map((r) => r.sessionId)).toEqual([COORDINATOR]);
+    } finally {
+      await client.close();
+    }
+  });
+
+  it("without CATHERD_ROLE the same calls work, and peek claims as before", async () => {
+    const { run } = freshRun();
+    await claimRun(fakeDeps({ host: codex(COORDINATOR) }), run);
+    const client = await codexClient(fakeDeps());
+    try {
+      expect(await codexCall(client, "peek", { run: run.id }, ROLE_THREAD)).toBeNull();
+      expect(runOwner(run)?.sessionId).toBe(ROLE_THREAD);
+    } finally {
+      await client.close();
+    }
+  });
+
+  it("each coordinator tool's description says it is the orchestrator's", async () => {
+    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
+    await buildServer(fakeDeps()).connect(serverSide);
+    const client = new Client({ name: "catherd-test", version: "0" });
+    await client.connect(clientSide);
+    try {
+      const tools = (await client.listTools()).tools;
+      for (const name of COORDINATOR_TOOLS)
+        expect(tools.find((t) => t.name === name)?.description).toStartWith(
+          "Orchestrator only (a role process gets E_ROLE_SCOPE).",
+        );
+      expect(tools.find((t) => t.name === "status")?.description).not.toContain("Orchestrator only");
+      expect((await call(client, "status")).isError).toBe(false);
+    } finally {
+      await client.close();
+    }
+  });
+});
diff --git a/test/services/admission.test.ts b/test/services/admission.test.ts
index c318a8a..fc1b1b5 100644
--- a/test/services/admission.test.ts
+++ b/test/services/admission.test.ts
@@ -1,7 +1,7 @@
 import * as git from "../../src/infra/git.ts";
 import { replyContract } from "../../src/domain/role-prompts.ts";
 import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
-import { readFileSync, statSync } from "node:fs";
+import { readFileSync, realpathSync, statSync } from "node:fs";
 import { join } from "node:path";
 import { antigravityAdapter } from "../../src/adapters/antigravity/index.ts";
 import { registerAdapter, unregisterAdapter } from "../../src/adapters/registry.ts";
@@ -88,8 +88,12 @@ describe("admission", () => {
     const text = readFileSync(specPath, "utf8");
     expect(text).not.toContain("s3cret");
     expect(text).not.toContain("TYPESAFE_API_KEY");
-    // the adapter's overrides and PWD only: a plain codex rung has none
-    expect(JSON.parse(text).env).toEqual({ PWD: repo });
+    // the adapter's overrides (a plain codex rung has none), the role's identity and scratch, and PWD
+    expect(JSON.parse(text).env).toEqual({
+      CATHERD_ROLE: `${run.id}/worker-M1.L1`,
+      TMPDIR: realpathSync(join(run.dir, "scratch", "worker-M1.L1")),
+      PWD: repo,
+    });
     expect(statSync(specPath).mode & 0o777).toBe(0o600);
   });
 
diff --git a/test/services/role-env.test.ts b/test/services/role-env.test.ts
new file mode 100644
index 0000000..b470b85
--- /dev/null
+++ b/test/services/role-env.test.ts
@@ -0,0 +1,45 @@
+import { afterEach, beforeEach, describe, expect, it } from "bun:test";
+import { existsSync, realpathSync, statSync } from "node:fs";
+import { join } from "node:path";
+import { roleScopeFromEnv } from "../../src/domain/role-scope.ts";
+import { resetReadiness } from "../../src/services/backends.ts";
+import { watchersSettled } from "../../src/services/dispatch-service.ts";
+import { noPosixModes, snapshotEnv } from "../helpers.ts";
+import { simPath, withScenario } from "../sim/scenario.ts";
+import { fakeDeps, freshRun, runRole, writeLane } from "./helpers.ts";
+
+afterEach(() => watchersSettled());
+afterEach(snapshotEnv());
+beforeEach(() => resetReadiness());
+
+describe("the role's env (spec 1.5 plan 21)", () => {
+  it("gives every role CATHERD_ROLE=<run>/<name> and its own scratch as TMPDIR, a write root of its sandbox", async () => {
+    const { run } = freshRun();
+    process.env.PATH = simPath();
+    const sim = withScenario({
+      reply: "done\nSTATUS: complete — ok",
+      touch: [{ path: "src/a.ts", content: "x" }],
+    });
+    Object.assign(process.env, sim.env);
+    writeLane(run, "M1.L1", ["src/a.ts"]);
+    await runRole(fakeDeps(), {
+      run: run.id,
+      role: "worker",
+      name: "worker-M1.L1",
+      brief: "do it",
+      rung: "codex:gpt-6-luna#high",
+      lane: "M1.L1",
+    });
+    const seen = sim.recorded();
+    const scratch = realpathSync(join(run.dir, "scratch", "worker-M1.L1"));
+    expect(seen.catherdRole).toBe(`${run.id}/worker-M1.L1`);
+    expect(seen.tmpdir).toBe(scratch);
+    if (!noPosixModes) expect(statSync(scratch).mode & 0o777).toBe(0o700);
+    // the sandbox lets it write there
+    const roots = seen.args.find((a) => a.startsWith("sandbox_workspace_write.writable_roots="));
+    expect(JSON.parse(roots!.split("=").slice(1).join("="))).toContain(scratch);
+    // and a catherd MCP server its Codex starts, which sees TMPDIR but not CATHERD_ROLE, knows it is that role
+    expect(roleScopeFromEnv({ TMPDIR: seen.tmpdir! })).toEqual({ run: run.id, name: "worker-M1.L1" });
+    expect(existsSync(join(run.dir, "scratch"))).toBe(true);
+  });
+});
diff --git a/test/sim/codex b/test/sim/codex
index faf6df7..a95c887 100755
--- a/test/sim/codex
+++ b/test/sim/codex
@@ -90,6 +90,8 @@ writeFileSync(
     cwd: process.cwd(),
     pwd: process.env.PWD ?? null,
     codexHome: process.env.CODEX_HOME ?? null,
+    catherdRole: process.env.CATHERD_ROLE ?? null,
+    tmpdir: process.env.TMPDIR ?? null,
   }),
 );
 const out = args.includes("-o") ? args[args.indexOf("-o") + 1] : undefined;
diff --git a/test/sim/scenario.ts b/test/sim/scenario.ts
index 5fde37c..a6ddfd0 100644
--- a/test/sim/scenario.ts
+++ b/test/sim/scenario.ts
@@ -55,6 +55,8 @@ export function withScenario(s: CodexScenario) {
         cwd: string;
         pwd: string | null;
         codexHome: string | null;
+        catherdRole: string | null;
+        tmpdir: string | null;
       },
   };
 }
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/domain/role-scope.test.ts test/entry/role-scope-mcp.test.ts test/services/role-env.test.ts test/services/admission.test.ts test/services/sessions.test.ts test/entry/mcp.test.ts test/adapters/codex.test.ts test/adapters/claude-code.test.ts`
Expected: FAIL. `test/domain/role-scope.test.ts` and `test/entry/role-scope-mcp.test.ts` fail to import `src/domain/role-scope.ts`; `role-env.test.ts` fails on `seen.catherdRole` (null); the admission test fails on the spec env (no `CATHERD_ROLE`, no `TMPDIR`).

- [ ] **Step 3: Implement**

````diff
diff --git a/src/adapters/backend.ts b/src/adapters/backend.ts
index 27fbadc..88a4ca7 100644
--- a/src/adapters/backend.ts
+++ b/src/adapters/backend.ts
@@ -46,6 +46,8 @@ export interface RunRequest {
   access: Access;
   /** Native catherd roles receive a dedicated, run-bound control-plane server. */
   roleMcp?: RoleMcpContext;
+  /** spec 1.5 plan 21: the role's TMPDIR (`<run>/scratch/<name>`), a write root besides the repo */
+  scratch?: string;
   /** spec §5: a workspace-write role's network and loopback grants; false only when the profile says `network: false` */
   network?: boolean;
   thread: string | null;
diff --git a/src/adapters/claude-code/index.ts b/src/adapters/claude-code/index.ts
index 8e9da36..1d15915 100644
--- a/src/adapters/claude-code/index.ts
+++ b/src/adapters/claude-code/index.ts
@@ -78,13 +78,18 @@ export const CLAUDE_ACCESS: Record<Access, string[]> = {
  * doctor says `network: false` is not enforced by claude-code's shell). With the user's sandbox on, `enabled: true`
  * goes in too, so a merge that replaces the whole `sandbox` object cannot turn it off.
  */
-export function claudeAccessArgs(access: Access, network = true, repo?: string): string[] {
+export function claudeAccessArgs(
+  access: Access,
+  network = true,
+  repo?: string,
+  extra: string[] = [],
+): string[] {
   const base = CLAUDE_ACCESS[access];
   if (access !== "workspace-write") return base;
   const sock = dockerSocket();
   const sandbox = {
     ...(claudeSandboxOn(repo) ? { enabled: true } : {}),
-    filesystem: { allowWrite: writableRoots() },
+    filesystem: { allowWrite: [...new Set([...writableRoots(), ...extra])] },
     ...(network
       ? {
           network: { allowLocalBinding: true, ...(sock ? { allowUnixSockets: [sock] } : {}) },
@@ -141,7 +146,7 @@ function plan(r: RunRequest): SpawnPlan {
     throw new CatherdError("E_ADMIT_THREAD", `"${r.thread}" is not a Claude Code session id`, {
       fix: "pass the thread from the earlier RunRecord",
     });
-  const accessArgs = [...claudeAccessArgs(r.access, r.network, r.repo)];
+  const accessArgs = [...claudeAccessArgs(r.access, r.network, r.repo, r.scratch ? [r.scratch] : [])];
   if (r.roleMcp) {
     const tools = roleMcpTools(r.roleMcp.role).map((tool) => `mcp__${ROLE_MCP_SERVER}__${tool}`);
     const allowed = accessArgs.indexOf("--allowedTools");
diff --git a/src/adapters/codex/index.ts b/src/adapters/codex/index.ts
index 3e77a3b..7a853f4 100644
--- a/src/adapters/codex/index.ts
+++ b/src/adapters/codex/index.ts
@@ -58,9 +58,14 @@ export function userWritableRoots(): string[] {
  * The same `-c` overrides go to `codex sandbox` in doctor's probes, so doctor tests exactly what a worker gets. `-c …writable_roots=` replaces the
  * user's own roots, so theirs go in too; an isolated run ignores the user's config, so it has none.
  */
-export function codexGrants(access: Access, network = true, isolated = false): string[] {
+export function codexGrants(
+  access: Access,
+  network = true,
+  isolated = false,
+  extra: string[] = [],
+): string[] {
   if (access !== "workspace-write") return [];
-  const roots = [...new Set([...(isolated ? [] : userWritableRoots()), ...writableRoots()])];
+  const roots = [...new Set([...(isolated ? [] : userWritableRoots()), ...writableRoots(), ...extra])];
   return [
     "-c",
     `sandbox_workspace_write.network_access=${network}`,
@@ -90,7 +95,7 @@ function plan(r: RunRequest): SpawnPlan {
     "--json",
     "-o",
     r.replyPath,
-    ...codexGrants(r.access, r.network, r.isolated),
+    ...codexGrants(r.access, r.network, r.isolated, r.scratch ? [r.scratch] : []),
     ...(r.roleMcp ? codexRoleMcpArgs(r.roleMcp) : []),
   ];
   const sandbox = SANDBOX[r.access];
diff --git a/src/domain/errors.ts b/src/domain/errors.ts
index 0a08c58..851ad6d 100644
--- a/src/domain/errors.ts
+++ b/src/domain/errors.ts
@@ -28,6 +28,7 @@ export type ErrorCode =
   | "E_IO_PATH"
   | "E_IO_UNEXPECTED"
   | "E_INPUT_INVALID"
+  | "E_ROLE_SCOPE"
   | "E_RUNTIME_TOO_OLD";
 
 /**
diff --git a/src/domain/role-scope.ts b/src/domain/role-scope.ts
new file mode 100644
index 0000000..e2092c0
--- /dev/null
+++ b/src/domain/role-scope.ts
@@ -0,0 +1,99 @@
+import { CatherdError } from "./errors.ts";
+import { ID_PATTERN } from "./ids.ts";
+
+/**
+ * Spec 1.5 plan 21: the env var the supervisor sets in every role's process, `<run>/<role-name>`. A process
+ * that carries it is a role of that run: it never owns the run and never reaches the coordinator tools.
+ */
+export const ROLE_ENV = "CATHERD_ROLE";
+
+/** The run and the dispatch name a role process works for. */
+export interface RoleScope {
+  run: string;
+  name: string;
+}
+
+const isId = (s: string): boolean => ID_PATTERN.test(s) && !s.includes("..");
+
+export const formatRoleScope = (s: RoleScope): string => `${s.run}/${s.name}`;
+
+/** `<run>/<role-name>`, else null (unset, empty, or not two ids). */
+export function parseRoleScope(value: string | undefined): RoleScope | null {
+  if (!value) return null;
+  const [run, name, ...rest] = value.split("/");
+  if (rest.length > 0 || !run || !name || !isId(run) || !isId(name)) return null;
+  return { run, name };
+}
+
+/** A run id as `createRun` makes it: `YYYYMMDD-HHMMSS-<slug>`. */
+const RUN_ID = /^\d{8}-\d{6}-/;
+
+/**
+ * The role a temp dir names, when it is a role's scratch, `…/runs/<run>/scratch/<name>[/…]`: Codex passes an
+ * MCP server only a short list of env vars, TMPDIR among them and CATHERD_ROLE not, so a server a role's
+ * Codex starts knows it is a role by its TMPDIR.
+ */
+export function roleScopeOfScratch(tmpdir: string | undefined): RoleScope | null {
+  if (!tmpdir) return null;
+  const parts = tmpdir.split(/[\\/]+/).filter(Boolean);
+  for (let i = parts.length - 2; i >= 2; i--) {
+    if (parts[i] !== "scratch" || parts[i - 2] !== "runs") continue;
+    const run = parts[i - 1] as string;
+    const name = parts[i + 1] as string;
+    if (RUN_ID.test(run)) return parseRoleScope(`${run}/${name}`);
+  }
+  return null;
+}
+
+/** The role this process works for: CATHERD_ROLE, else a TMPDIR that is a role's scratch, else null. */
+export function roleScopeFromEnv(env: Record<string, string | undefined>): RoleScope | null {
+  return parseRoleScope(env[ROLE_ENV]) ?? roleScopeOfScratch(env.TMPDIR);
+}
+
+/**
+ * The tools only the orchestrator calls: each one claims the run, steers a role or changes the run's plan
+ * (spec 1.5 plan 21). A role process gets E_ROLE_SCOPE for them.
+ */
+export const COORDINATOR_TOOLS = [
+  "peek",
+  "result",
+  "dispatch",
+  "run_start",
+  "climb",
+  "land",
+  "park",
+  "cancel",
+  "set_next",
+  "answer",
+  "profile_set",
+  "workspace_start",
+  "workspace_contract",
+  "workspace_child_start",
+] as const;
+
+const COORDINATOR = new Set<string>(COORDINATOR_TOOLS);
+
+export const isCoordinatorTool = (tool: string): boolean => COORDINATOR.has(tool);
+
+/**
+ * Whether a role process may not make this call: every coordinator tool, except a `peek` of its own
+ * dispatch (its run and its own name) and a `workspace_contract` read (no `content`).
+ */
+export function refusedForRole(tool: string, args: unknown, scope: RoleScope): boolean {
+  if (!COORDINATOR.has(tool)) return false;
+  const a = (args ?? {}) as Record<string, unknown>;
+  if (tool === "peek") return !(a.run === scope.run && a.name === scope.name);
+  if (tool === "workspace_contract") return a.content !== undefined;
+  return true;
+}
+
+/** E_ROLE_SCOPE: the error a role process gets for a coordinator tool, with the line that fixes it. */
+export function roleScopeError(tool: string, scope: RoleScope): CatherdError {
+  return new CatherdError(
+    "E_ROLE_SCOPE",
+    `${tool} is the orchestrator's: this process runs ${scope.name} of run ${scope.run}`,
+    {
+      fix: `a role reports through its reply; read its run's files with read_run_file, or catherd run-file read ${scope.run} <path>`,
+    },
+  );
+}
diff --git a/src/entry/deps.ts b/src/entry/deps.ts
index a0d3b66..a8c1f6f 100644
--- a/src/entry/deps.ts
+++ b/src/entry/deps.ts
@@ -1,4 +1,5 @@
 import type { HostContext } from "../domain/host.ts";
+import { roleScopeFromEnv } from "../domain/role-scope.ts";
 import { readSessionEnv } from "../infra/claude-session.ts";
 import { VERSION } from "../infra/version.ts";
 import type { Deps } from "../services/ports.ts";
@@ -15,6 +16,7 @@ export function defaultDeps(host: HostContext = { host: "unknown", session: null
     pollMs: 250,
     session: readSessionEnv(process.env),
     now: Date.now,
+    role: roleScopeFromEnv(process.env),
   };
   return deps;
 }
diff --git a/src/entry/mcp/server.ts b/src/entry/mcp/server.ts
index a90b6d2..d09fdef 100644
--- a/src/entry/mcp/server.ts
+++ b/src/entry/mcp/server.ts
@@ -5,6 +5,7 @@ import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
 import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
 import { sessionKey, type HostContext } from "../../domain/host.ts";
 import { errorMessage } from "../../domain/errors.ts";
+import { isCoordinatorTool, refusedForRole, roleScopeError } from "../../domain/role-scope.ts";
 import { resolveHost } from "../../infra/host-context.ts";
 import { log } from "../../infra/log.ts";
 import { currentSession } from "../../services/sessions.ts";
@@ -16,13 +17,48 @@ import { defaultDeps } from "../deps.ts";
 import { registerDispatchTools } from "./dispatch-tools.ts";
 import { registerLaneTools } from "./lane-tools.ts";
 import { registerProtocolTools } from "./protocol-tools.ts";
-import { sdkToolError, toolOf } from "./result.ts";
+import { handle, sdkToolError, toolOf } from "./result.ts";
 import { registerRunTools } from "./run-tools.ts";
 import { registerSetupTools } from "./setup-tools.ts";
 import { registerWorkspaceTools } from "./workspace-tools.ts";
 
 type ObserveSession = (context: Deps) => (() => void) | undefined;
 
+/** Spec 1.5 plan 21: a coordinator tool's description says, first, that only the orchestrator calls it. */
+function orchestratorOnly(name: string, config: unknown): unknown {
+  const c = config as { description?: string };
+  return isCoordinatorTool(name) && c.description
+    ? { ...c, description: `Orchestrator only (a role process gets E_ROLE_SCOPE). ${c.description}` }
+    : config;
+}
+
+type RequestHandler = (
+  request: { params?: { name?: unknown; arguments?: unknown } },
+  extra: unknown,
+) => unknown;
+
+/**
+ * Spec 1.5 plan 21: in a role's process (`deps.role`) a coordinator tool call is refused with E_ROLE_SCOPE
+ * before anything else, its input check included, so a role learns at once that the tool is not its own. The
+ * SDK keeps its request handlers in a private map; test/entry/role-scope-mcp.test.ts fails if it moves.
+ */
+function refuseCoordinatorTools(server: McpServer, deps: Deps): void {
+  const handlers = (server.server as unknown as { _requestHandlers: Map<string, RequestHandler> })
+    ._requestHandlers;
+  const callTool = handlers.get("tools/call");
+  if (!callTool) return;
+  handlers.set("tools/call", async (request, extra) => {
+    const role = deps.role;
+    const name = String(request.params?.name ?? "");
+    if (!role || !refusedForRole(name, request.params?.arguments, role)) return callTool(request, extra);
+    const r = await handle(() => {
+      throw roleScopeError(name, role);
+    });
+    log("warn", "tool", { tool: name, ok: false, code: "E_ROLE_SCOPE" });
+    return r;
+  });
+}
+
 type Handler = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;
 
 /** Spec §10.2: every tool call is logged with its duration and outcome (the error code), never its input. */
@@ -39,7 +75,7 @@ function logToolCalls(
     h: Handler,
   ) => unknown;
   (server as unknown as { registerTool: typeof register }).registerTool = (name, config, handler) =>
-    register(name, config, async (...args: unknown[]) => {
+    register(name, orchestratorOnly(name, config), async (...args: unknown[]) => {
       const started = Date.now();
       const epoch = generation();
       const extra = args.at(-1) as { _meta?: Record<string, unknown> } | undefined;
@@ -108,6 +144,7 @@ export function buildServer(deps: Deps = defaultDeps(), observe?: ObserveSession
   registerDispatchTools(server, scoped);
   registerSetupTools(server, scoped);
   registerProtocolTools(server, scoped);
+  refuseCoordinatorTools(server, deps);
   return server;
 }
 
diff --git a/src/services/admission.ts b/src/services/admission.ts
index cc8242f..9ce84b5 100644
--- a/src/services/admission.ts
+++ b/src/services/admission.ts
@@ -1,5 +1,5 @@
 import type { KnownHost } from "../domain/host.ts";
-import { appendFileSync, existsSync, readFileSync } from "node:fs";
+import { appendFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
 import { join } from "node:path";
 import type { BackendAdapter } from "../adapters/backend.ts";
 import { budgetStatus, formatBudget } from "../domain/budget.ts";
@@ -9,6 +9,7 @@ import { assertLaneHeader, overlaps } from "../domain/lane.ts";
 import type { RunRecord } from "../domain/record.ts";
 import { withReplyContract } from "../domain/role-prompts.ts";
 import type { Role } from "../domain/roles.ts";
+import { formatRoleScope, ROLE_ENV } from "../domain/role-scope.ts";
 import { roleRequiresMcp } from "../domain/role-tools.ts";
 import { dispatchPaths, markForCollect } from "../infra/dispatch-dir.ts";
 import { withFileLock } from "../infra/filelock.ts";
@@ -28,6 +29,7 @@ import {
   listDispatches,
   pendingDispatches,
   roleDir,
+  scratchDir,
   setLatest,
 } from "./dispatches.ts";
 import { finalizeDispatch } from "./finalize.ts";
@@ -56,6 +58,20 @@ export const KILL_GRACE_MS = 10_000;
 
 export const laneFile = (run: Run, lane: string): string => join(runPaths(run.dir).lanes, `${lane}.md`);
 
+/**
+ * Spec 1.5 plan 21: the backends whose sandbox catherd grants the role's scratch, so they get it as TMPDIR.
+ * Cursor, Grok and agy write their grants once per isolated home, not per dispatch: they keep the inherited one.
+ */
+const SCRATCH_BACKENDS = new Set(["codex", "claude-code", "opencode"]);
+
+/** The role's scratch folder, created (0700) and by its real path, on a backend that grants it; else null. */
+function roleScratch(run: Run, name: string, backend: string): string | null {
+  if (!SCRATCH_BACKENDS.has(backend)) return null;
+  const dir = scratchDir(run, name);
+  ensurePrivateDir(dir);
+  return realpathSync(dir);
+}
+
 function laneOwns(run: Run, lane: string): string[] {
   const file = laneFile(run, lane);
   if (!existsSync(file))
@@ -198,6 +214,7 @@ export async function admit(
         fix: `set harness.${rung.backend}.isolated to false in profile ${profile.name}, then dispatch a fresh thread`,
       },
     );
+  const scratch = roleScratch(run, i.name, rung.backend);
   await prepared(adapter, {
     rung,
     access: rc.access,
@@ -216,6 +233,7 @@ export async function admit(
     replyPath: p.reply,
     dispatchDir: dir,
     ...(needsRoleMcp && !isolated ? { roleMcp: { run: run.id, role: i.role } } : {}),
+    ...(scratch ? { scratch } : {}),
   });
 
   await finalizeFinished(run, deps.now(), onRecorded);
@@ -297,7 +315,13 @@ export async function admit(
         dispatchDir: dir,
         cmd: plan.cmd,
         args: plan.args,
-        env: { ...plan.env, PWD: plan.cwd },
+        // spec 1.5 plan 21: the supervisor gives the role its identity and, where granted, its scratch TMPDIR
+        env: {
+          ...plan.env,
+          [ROLE_ENV]: formatRoleScope({ run: run.id, name: i.name }),
+          ...(scratch ? { TMPDIR: scratch } : {}),
+          PWD: plan.cwd,
+        },
         cwd: plan.cwd,
         stdinPath: plan.stdinPath,
         idleMs: profile.timeouts.idleMin * 60_000,
diff --git a/src/services/dispatches.ts b/src/services/dispatches.ts
index a245a58..c9fdde3 100644
--- a/src/services/dispatches.ts
+++ b/src/services/dispatches.ts
@@ -55,6 +55,8 @@ export const startLimits = { graceMs: STARTING_GRACE_MS };
 export const admitPath = (dir: string): string => join(dir, "admit.json");
 export const launchPath = (dir: string): string => join(dir, "launch.json");
 export const roleDir = (run: Run, name: string): string => join(runPaths(run.dir).roles, name);
+/** Spec 1.5 plan 21: the role's TMPDIR, `<run>/scratch/<name>/`, removed with the run's scratch. */
+export const scratchDir = (run: Run, name: string): string => join(runPaths(run.dir).scratch, name);
 
 /** Every admitted dispatch of the run, oldest first; a folder whose admit.json cannot be read is skipped. */
 export function listDispatches(run: Run, strict = false): Dispatch[] {
diff --git a/src/services/ports.ts b/src/services/ports.ts
index a3b27b1..248030b 100644
--- a/src/services/ports.ts
+++ b/src/services/ports.ts
@@ -7,6 +7,7 @@ import type { Verdict } from "../domain/jev.ts";
 import type { Difficulty, Kind } from "../domain/lane.ts";
 import type { Access } from "../domain/record.ts";
 import type { Role } from "../domain/roles.ts";
+import type { RoleScope } from "../domain/role-scope.ts";
 import type { Change, ProfileDoc, ProfilePatch } from "../domain/profile.ts";
 import type { Issue } from "../domain/profile-rules.ts";
 import type { RouteJev, RouteSource } from "../domain/route.ts";
@@ -144,4 +145,9 @@ export interface Deps {
   now: () => number;
   /** spec 1.2 §3.2 `catalog_sync`; default: the real sync (tests inject one that never reaches the network) */
   sync?: (o: { force: boolean }) => Promise<SyncReport>;
+  /**
+   * Spec 1.5 plan 21: the role this process works for (CATHERD_ROLE, or a role's scratch TMPDIR); null or
+   * absent for the orchestrator's own server. A role never claims a run and never reaches a coordinator tool.
+   */
+  role?: RoleScope | null;
 }
diff --git a/src/services/run-store.ts b/src/services/run-store.ts
index 630ac01..99c0094 100644
--- a/src/services/run-store.ts
+++ b/src/services/run-store.ts
@@ -67,6 +67,8 @@ export function runPaths(dir: string) {
     sessions: join(dir, "sessions.jsonl"),
     roles: join(dir, "roles"),
     shots: join(dir, "shots"),
+    /** per dispatch name, the role's TMPDIR (spec 1.5 plan 21): `scratch/<name>/` */
+    scratch: join(dir, "scratch"),
     /** the admission lock's target: `admission.lock` guards dispatch admission */
     admission: join(dir, "admission"),
   };
diff --git a/src/services/sessions.ts b/src/services/sessions.ts
index 7c6d699..dd67c74 100644
--- a/src/services/sessions.ts
+++ b/src/services/sessions.ts
@@ -69,9 +69,11 @@ export function readSessionRows(run: Run): SessionRow[] {
 
 /**
  * Spec §3.3: `run_start`, `dispatch` and `peek` make the calling session the run's owner when it is not, and
- * append it to `R/sessions.jsonl`: that is how a run moves when it is continued from another session. Without host session identity it changes nothing. Returns whether the owner changed.
+ * append it to `R/sessions.jsonl`: that is how a run moves when it is continued from another session. Without host session identity it changes nothing, and neither does a role's process (`deps.role`, spec 1.5 plan 21). Returns whether the owner changed.
  */
 export async function claimRun(deps: Deps, run: Run): Promise<boolean> {
+  // spec 1.5 plan 21: a role's process never becomes the run's owner, whatever host identity it has
+  if (deps.role) return false;
   const me = currentSession(deps);
   if (!me) return false;
   const p = runPaths(run.dir);
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun run format && bun test test/domain/role-scope.test.ts test/entry/role-scope-mcp.test.ts test/services/role-env.test.ts test/services/admission.test.ts test/services/sessions.test.ts test/entry/mcp.test.ts test/adapters/codex.test.ts test/adapters/claude-code.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS (83 pass, 0 fail, 8 files).

- [ ] **Step 5: Commit**

````bash
git add -A src/adapters/backend.ts src/adapters/claude-code/index.ts src/adapters/codex/index.ts src/domain/errors.ts src/domain/role-scope.ts src/entry/deps.ts src/entry/mcp/server.ts src/services/admission.ts src/services/dispatches.ts src/services/ports.ts src/services/run-store.ts src/services/sessions.ts test/domain/role-scope.test.ts test/entry/role-scope-mcp.test.ts test/services/admission.test.ts test/services/role-env.test.ts test/sim/codex test/sim/scenario.ts
git commit -m "fix(roles): a role never claims a run nor reaches the coordinator tools"
````

---

### Task 2: Native Claude subagents are told, and forbidden, the coordinator tools (spec "`CATHERD_ROLE`" bullet, last sentence; Ruling 6)

A native Claude subagent shares the orchestrator's MCP server, so it has no env to be refused by. Its agent file's `disallowedTools` now also lists `mcp__plugin_catherd_catherd__<tool>` for every coordinator tool, its prompt ends with a line saying it is a role and not the orchestrator, and the skill says only the orchestrator calls those tools (the tool descriptions say "Orchestrator only" since Task 1).

**Files:**
- Modify: `plugin/skills/catherd/SKILL.md`
- Modify: `src/domain/agents.ts`
- Modify: `src/domain/role-prompts.ts`
- Test: `test/domain/agents.test.ts`
- Test: `test/skills.test.ts`

**Interfaces:**
- Consumes: Task 1's `COORDINATOR_TOOLS`.
- Produces: `src/domain/role-prompts.ts`: `NATIVE_TOOL_PREFIX = "mcp__plugin_catherd_catherd__"`, `NOT_THE_ORCHESTRATOR` (string), `nativeDisallowedTools(access)` now ends with the 14 prefixed coordinator tools. `renderAgent` appends `NOT_THE_ORCHESTRATOR` after the role prompt.

**Scratch commit:** `90df4f6` (fix(roles): native subagents are told and forbidden the coordinator tools).

- [ ] **Step 1: Write the failing tests**

````diff
diff --git a/test/domain/agents.test.ts b/test/domain/agents.test.ts
index f7f7c9d..29762b8 100644
--- a/test/domain/agents.test.ts
+++ b/test/domain/agents.test.ts
@@ -6,7 +6,11 @@ import {
   type ProfilePatch,
   resolveProfile,
 } from "../../src/domain/profile.ts";
-import { rolePrompt } from "../../src/domain/role-prompts.ts";
+import { NATIVE_TOOL_PREFIX, rolePrompt } from "../../src/domain/role-prompts.ts";
+import { COORDINATOR_TOOLS } from "../../src/domain/role-scope.ts";
+
+/** spec 1.5 plan 21: every native role's agent file also forbids catherd's coordinator tools */
+const COORDINATOR = COORDINATOR_TOOLS.map((t) => `${NATIVE_TOOL_PREFIX}${t}`).join(", ");
 
 const profile = (patch: ProfilePatch = {}, name = "default") =>
   resolveProfile(applyPatch(defaultProfileDoc(name), patch), name, "claude-code");
@@ -25,7 +29,7 @@ describe("agentFiles", () => {
         "description: Internal architect role of the catherd orchestrator (profile default), on claude-opus-5-5 at high effort. Dispatched only by the catherd skill while a run is in flight. Never for a plain request, even one that names this role.",
         "model: claude-opus-5-5",
         "effort: high",
-        "disallowedTools: Write, Edit, NotebookEdit, Agent",
+        `disallowedTools: Write, Edit, NotebookEdit, Agent, ${COORDINATOR}`,
         "---",
         "",
         "You are the architect of a catherd run.",
@@ -35,12 +39,12 @@ describe("agentFiles", () => {
 
   it("takes the tool list from the role's access, not from the role", () => {
     const [verifier] = agentFiles(profile({ roles: { architect: { enabled: false } } }), "1.0.0");
-    expect(verifier?.text).toContain("\ndisallowedTools: Agent\n");
+    expect(verifier?.text).toContain(`\ndisallowedTools: Agent, ${COORDINATOR}\n`);
     const [ro] = agentFiles(
       profile({ roles: { architect: { enabled: false }, verifier: { access: "read-only" } } }),
       "1.0.0",
     );
-    expect(ro?.text).toContain("\ndisallowedTools: Write, Edit, NotebookEdit, Agent\n");
+    expect(ro?.text).toContain(`\ndisallowedTools: Write, Edit, NotebookEdit, Agent, ${COORDINATOR}\n`);
   });
 
   it("skips disabled roles and headless rungs, and counts a native stand-in", () => {
@@ -57,6 +61,15 @@ describe("agentFiles", () => {
     ]);
   });
 
+  it("tells a native role it is not the orchestrator, and forbids it the coordinator tools (spec 1.5 plan 21)", () => {
+    const [architect] = agentFiles(profile(), "1.0.0");
+    expect(architect?.text).toContain(
+      "You are a role of a catherd run, not its orchestrator. Never call catherd's peek, result, dispatch,",
+    );
+    for (const tool of ["peek", "result", "dispatch", "run_start", "land", "workspace_child_start"])
+      expect(architect?.text).toContain(`${NATIVE_TOOL_PREFIX}${tool}`);
+  });
+
   it("leaves the effort out for a model that takes none", () => {
     const text = renderAgent({
       profile: "p",
@@ -65,7 +78,7 @@ describe("agentFiles", () => {
       access: "full",
       version: "1.0.0",
     });
-    expect(text).toContain("\nmodel: claude-haiku-4-5-20251001\ndisallowedTools: Agent\n");
+    expect(text).toContain(`\nmodel: claude-haiku-4-5-20251001\ndisallowedTools: Agent, ${COORDINATOR}\n`);
     expect(text).toContain("(profile p), on claude-haiku-4-5-20251001. Dispatched only by the catherd skill");
     expect(text).not.toContain("effort");
   });
diff --git a/test/skills.test.ts b/test/skills.test.ts
index df1270b..32cd32e 100644
--- a/test/skills.test.ts
+++ b/test/skills.test.ts
@@ -67,6 +67,9 @@ describe("orchestrator skill", () => {
     expect(after).toMatch(/neither[^\n]*user approval/);
     // plan 10's push facts the orchestrator still needs
     expect(after).toContain("catherd messages the session that dispatched");
+    // spec 1.5 plan 21: only the orchestrator calls the coordinator tools
+    expect(after).toContain("Only you, the orchestrator, call the coordinator tools");
+    expect(after).toContain("refuses them with `E_ROLE_SCOPE`");
     expect(after).toContain("every coalesced event");
     expect(md).toContain("so catherd messages you from now on");
     expect(md).toContain("call `peek(run)` once and answer from it");
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/domain/agents.test.ts test/skills.test.ts test/entry/mcp-profile.test.ts`
Expected: FAIL. `agents.test.ts` fails on the `disallowedTools:` lines and the new "tells a native role" case; `skills.test.ts` fails on "Only you, the orchestrator, call the coordinator tools".

- [ ] **Step 3: Implement**

````diff
diff --git a/plugin/skills/catherd/SKILL.md b/plugin/skills/catherd/SKILL.md
index cc782f9..cda25c7 100644
--- a/plugin/skills/catherd/SKILL.md
+++ b/plugin/skills/catherd/SKILL.md
@@ -189,6 +189,8 @@ Your context is re-read on every turn, and it is the run's most expensive token.
 
 Call `dispatch` from your main thread only, never from a subagent: catherd messages the session that dispatched.
 
+Only you, the orchestrator, call the coordinator tools: `peek` (of another role), `result`, `dispatch`, `run_start`, `climb`, `land`, `park`, `cancel`, `set_next`, `answer`, `profile_set` and the `workspace_*` writers. A role never does: a native Claude subagent's agent file forbids them, and a process role's catherd server refuses them with `E_ROLE_SCOPE`, so a role can never take the run from you. A brief never asks a role to call one.
+
 - **Dispatch every independent role one after another.** Each `dispatch` returns in about a second, once its role has started, so they all run side by side.
 - **Then write one status line and end your turn.** Claude Code receives `<cross-session-message from-name="catherd">` through its peer inbox with its existing priorities. Codex receives queued next input through the existing native server (`--remote unix://`): idle sessions can wake; a busy session processes it after the active turn, without Claude's urgent next-tool-round promise. The notice names the run, dispatch and every event ID, including every coalesced event. Call `result(run, name)` for each stored record you will act on, then dispatch what follows.
 - **A single role is `dispatch`, then end your turn.**
diff --git a/src/domain/agents.ts b/src/domain/agents.ts
index 7167bcd..d2b0f25 100644
--- a/src/domain/agents.ts
+++ b/src/domain/agents.ts
@@ -1,7 +1,7 @@
 import { parseRung, tryParseRung } from "./ids.ts";
 import { agentName, type Profile } from "./profile.ts";
 import type { Access } from "./record.ts";
-import { nativeDisallowedTools, rolePrompt } from "./role-prompts.ts";
+import { NOT_THE_ORCHESTRATOR, nativeDisallowedTools, rolePrompt } from "./role-prompts.ts";
 import { ROLES, type Role } from "./roles.ts";
 
 export interface AgentFile {
@@ -32,6 +32,8 @@ export function renderAgent(o: {
     "",
     rolePrompt(o.role, o.version),
     "",
+    NOT_THE_ORCHESTRATOR,
+    "",
   ].join("\n");
 }
 
diff --git a/src/domain/role-prompts.ts b/src/domain/role-prompts.ts
index 6689f08..36a6df9 100644
--- a/src/domain/role-prompts.ts
+++ b/src/domain/role-prompts.ts
@@ -1,4 +1,5 @@
 import type { Access } from "./record.ts";
+import { COORDINATOR_TOOLS } from "./role-scope.ts";
 import type { Role } from "./roles.ts";
 
 // The role prompts of the native Claude subagents, ported from 0.x (spec D9). Headless backends get the
@@ -169,10 +170,21 @@ export function withReplyContract(role: Role, brief: string): string {
 /** The role's prompt; the worker's names the catherd version whose `lock` it must use. */
 export const rolePrompt = (role: Role, version: string): string => BODIES[role](version);
 
+/** The catherd plugin's MCP tool names as a native Claude subagent sees them. */
+export const NATIVE_TOOL_PREFIX = "mcp__plugin_catherd_catherd__";
+
+/**
+ * Spec 1.5 plan 21: a native Claude subagent shares the orchestrator's MCP server, so it has no env of its own to
+ * refuse it by. Its agent file forbids the coordinator tools, and its prompt says why.
+ */
+export const NOT_THE_ORCHESTRATOR = `You are a role of a catherd run, not its orchestrator. Never call catherd's ${COORDINATOR_TOOLS.join(", ")}: they belong to the orchestrator, which reads your reply.`;
+
 /**
  * Spec D10 for native subagents, whose only lever is the agent file's tool list: read-only drops the
  * editing tools (its Bash stays, for inspection, so enforcement is advisory); every role drops Agent,
- * so a role never spawns its own subagents.
+ * so a role never spawns its own subagents, and catherd's coordinator tools (spec 1.5 plan 21).
  */
-export const nativeDisallowedTools = (access: Access): string[] =>
-  access === "read-only" ? ["Write", "Edit", "NotebookEdit", "Agent"] : ["Agent"];
+export const nativeDisallowedTools = (access: Access): string[] => [
+  ...(access === "read-only" ? ["Write", "Edit", "NotebookEdit", "Agent"] : ["Agent"]),
+  ...COORDINATOR_TOOLS.map((tool) => `${NATIVE_TOOL_PREFIX}${tool}`),
+];
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun run format && bun test test/domain/agents.test.ts test/skills.test.ts test/entry/mcp-profile.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS (47 pass, 0 fail, 3 files).

- [ ] **Step 5: Commit**

````bash
git add -A plugin/skills/catherd/SKILL.md src/domain/agents.ts src/domain/role-prompts.ts test/domain/agents.test.ts test/skills.test.ts
git commit -m "fix(roles): native subagents are told and forbidden the coordinator tools"
````

---

### Task 3: A notice never goes to a role's thread; status warns instead (spec "Deliveries never target a role thread" bullet; Rulings 7, 8)

The supervisor writes `thread.json` in the dispatch folder the first time the role's CLI names its thread, so a live role's thread is known, not only a finished one's. `roleThreadOf(run, thread)` names the dispatch whose thread it is (its record, its resumed `admit.thread`, or `thread.json`). The notifier, right before it claims a batch, drops every notice whose target is a role's thread: it writes a `failed` delivery attempt whose reason starts with `ROLE_THREAD_REFUSAL`, logs at `error`, and never calls the sender; the delivery state stays `pending`, so the orchestrator gets the notice once it takes the run back. `summarizeRun` (`status`) warns while that refusal is a dispatch's latest attempt.

The other half of the bullet, "a target that is not the owner of record at enqueue time", already holds: the notifier sends only to the current session when it owns the run, checked when queued and again under the claim right before sending (Ruling 7). The test pins both halves together.

**Files:**
- Modify: `src/infra/delivery.ts`
- Modify: `src/infra/dispatch-dir.ts`
- Modify: `src/infra/supervisor.ts`
- Modify: `src/services/dispatches.ts`
- Modify: `src/services/notifier.ts`
- Modify: `src/services/summary.ts`
- Test: `test/services/role-env.test.ts`
- Create: `test/services/role-thread-delivery.test.ts`

**Interfaces:**
- Consumes: Task 1 (the `role-env` test file and the simulator's `catherdRole`/`tmpdir` record).
- Produces: `dispatchPaths(dir).thread` (`thread.json`: `{ schema: 1, thread, at }`), `readThread(dir): string | null` and `roleThreadOf(run, thread): string | null` in `src/services/dispatches.ts`; `ROLE_THREAD_REFUSAL` in `src/infra/delivery.ts`.

**Scratch commit:** `8e7fc7d` (fix(notify): a notice never goes to a role's thread; status warns instead).

- [ ] **Step 1: Write the failing tests**

````diff
diff --git a/test/services/role-env.test.ts b/test/services/role-env.test.ts
index b470b85..2d1d4a5 100644
--- a/test/services/role-env.test.ts
+++ b/test/services/role-env.test.ts
@@ -4,6 +4,7 @@ import { join } from "node:path";
 import { roleScopeFromEnv } from "../../src/domain/role-scope.ts";
 import { resetReadiness } from "../../src/services/backends.ts";
 import { watchersSettled } from "../../src/services/dispatch-service.ts";
+import { listDispatches, readThread, roleThreadOf } from "../../src/services/dispatches.ts";
 import { noPosixModes, snapshotEnv } from "../helpers.ts";
 import { simPath, withScenario } from "../sim/scenario.ts";
 import { fakeDeps, freshRun, runRole, writeLane } from "./helpers.ts";
@@ -18,11 +19,12 @@ describe("the role's env (spec 1.5 plan 21)", () => {
     process.env.PATH = simPath();
     const sim = withScenario({
       reply: "done\nSTATUS: complete — ok",
+      eventsFile: join(import.meta.dir, "..", "fixtures", "adapters", "codex", "ok-with-reconnect.jsonl"),
       touch: [{ path: "src/a.ts", content: "x" }],
     });
     Object.assign(process.env, sim.env);
     writeLane(run, "M1.L1", ["src/a.ts"]);
-    await runRole(fakeDeps(), {
+    const { record } = await runRole(fakeDeps(), {
       run: run.id,
       role: "worker",
       name: "worker-M1.L1",
@@ -41,5 +43,10 @@ describe("the role's env (spec 1.5 plan 21)", () => {
     // and a catherd MCP server its Codex starts, which sees TMPDIR but not CATHERD_ROLE, knows it is that role
     expect(roleScopeFromEnv({ TMPDIR: seen.tmpdir! })).toEqual({ run: run.id, name: "worker-M1.L1" });
     expect(existsSync(join(run.dir, "scratch"))).toBe(true);
+    // the supervisor wrote the role's thread down as soon as the CLI named it, so no notice ever targets it
+    expect(record.thread).toBe("01a0d0d4-d0a6-71a1-983c-82a9169200b4");
+    const d = listDispatches(run)[0]!;
+    expect(readThread(d.dir)).toBe(record.thread);
+    expect(roleThreadOf(run, record.thread!)).toBe("worker-M1.L1");
   });
 });
diff --git a/test/services/role-thread-delivery.test.ts b/test/services/role-thread-delivery.test.ts
new file mode 100644
index 0000000..0c5b229
--- /dev/null
+++ b/test/services/role-thread-delivery.test.ts
@@ -0,0 +1,124 @@
+import { afterEach, beforeEach, describe, expect, it } from "bun:test";
+import type { HostSessionRef } from "../../src/domain/host.ts";
+import { deliveryState, readDelivery, ROLE_THREAD_REFUSAL } from "../../src/infra/delivery.ts";
+import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
+import { writeJsonAtomic } from "../../src/infra/store.ts";
+import { resetReadiness } from "../../src/services/backends.ts";
+import { watchersSettled } from "../../src/services/dispatch-service.ts";
+import { roleThreadOf } from "../../src/services/dispatches.ts";
+import { finalizeDispatch } from "../../src/services/finalize.ts";
+import { type Notifier, startNotifier } from "../../src/services/notifier.ts";
+import type { Run } from "../../src/services/run-store.ts";
+import { claimRun, runOwner } from "../../src/services/sessions.ts";
+import { summarizeRun } from "../../src/services/summary.ts";
+import { snapshotEnv } from "../helpers.ts";
+import { fakeDeps, fakeDispatch, freshRun } from "./helpers.ts";
+
+afterEach(() => watchersSettled());
+afterEach(snapshotEnv());
+beforeEach(() => resetReadiness());
+
+const notifiers: Notifier[] = [];
+afterEach(() => {
+  for (const n of notifiers.splice(0)) n.stop();
+});
+
+const COORDINATOR = "0199c011-1234-7000-8000-00000000c00d";
+const VERIFIER_THREAD = "0199c011-1234-7000-8000-0000000001e5";
+const ref = (sessionId: string): HostSessionRef => ({
+  host: "codex",
+  sessionId,
+  hostSessionId: null,
+  name: null,
+});
+const as = (sessionId: string) =>
+  fakeDeps({ host: { host: "codex", session: ref(sessionId), conflict: null } });
+const exit = () => ({ code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() });
+const codexEvents = (thread: string) =>
+  `${JSON.stringify({ type: "thread.started", thread_id: thread })}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } })}\n`;
+
+/** The payment run's P1, as 1.4 left it: the verifier's `codex exec` thread owns the run. */
+async function stolenRun(): Promise<{ run: Run; eventId: string; dir: string }> {
+  const { run } = freshRun();
+  await claimRun(as(COORDINATOR), run);
+  const verifier = await fakeDispatch(
+    run,
+    { name: "verifier-M1", role: "verifier", lane: null, owns: [], access: "read-only" },
+    {
+      proc: "dead",
+      exit: exit(),
+      reply: "VERDICT: PASS\nSTATUS: complete — ok",
+      collect: true,
+      events: codexEvents(VERIFIER_THREAD),
+    },
+  );
+  await finalizeDispatch(run, verifier);
+  await claimRun(as(VERIFIER_THREAD), run);
+  expect(runOwner(run)?.sessionId).toBe(VERIFIER_THREAD);
+  const worker = await fakeDispatch(
+    run,
+    { name: "worker-M1.L2" },
+    { proc: "dead", exit: exit(), reply: "STATUS: complete — ok", collect: true },
+  );
+  await finalizeDispatch(run, worker);
+  return { run, eventId: JSON.stringify([run.id, worker.admit.dispatchId, "finished"]), dir: worker.dir };
+}
+
+describe("deliveries never target a role thread (spec 1.5 plan 21)", () => {
+  it("knows a role's thread from its record, its resume, or what its supervisor wrote down", async () => {
+    const { run } = freshRun();
+    const live = await fakeDispatch(run, { name: "worker-M1.L1" }, { proc: "self" });
+    expect(roleThreadOf(run, VERIFIER_THREAD)).toBeNull();
+    writeJsonAtomic(dispatchPaths(live.dir).thread, {
+      schema: 1,
+      thread: VERIFIER_THREAD,
+      at: new Date().toISOString(),
+    });
+    expect(roleThreadOf(run, VERIFIER_THREAD)).toBe("worker-M1.L1");
+    await fakeDispatch(run, { name: "worker-M1.L2", thread: "0199c011-1234-7000-8000-0000000000aa" });
+    expect(roleThreadOf(run, "0199c011-1234-7000-8000-0000000000aa")).toBe("worker-M1.L2");
+    expect(roleThreadOf(run, COORDINATOR)).toBeNull();
+  });
+
+  it("fails a notice to a role's thread loudly, never sends it, and status warns; the orchestrator gets it once it takes the run back", async () => {
+    const { run, eventId, dir } = await stolenRun();
+    const sent: string[] = [];
+    const role = startNotifier(as(VERIFIER_THREAD), {
+      coalesceMs: 0,
+      sendCodex: async (target) => {
+        sent.push(target.sessionId);
+        return { outcome: "accepted", msgId: "m" };
+      },
+    });
+    notifiers.push(role);
+    await role.scan();
+    await role.idle();
+    expect(sent).toEqual([]);
+    const last = readDelivery(dir).at(-1);
+    expect(last).toMatchObject({ status: "failed", target: { sessionId: VERIFIER_THREAD } });
+    expect(last?.reason).toStartWith(`${ROLE_THREAD_REFUSAL} (verifier-M1, codex ${VERIFIER_THREAD})`);
+    expect(deliveryState(dir, ref(VERIFIER_THREAD), eventId)).not.toBe("enqueue-accepted");
+    expect(summarizeRun(fakeDeps(), run).warnings).toContain(
+      `worker-M1.L2: its notice was not sent: ${last?.reason}`,
+    );
+    role.stop();
+
+    // the orchestrator takes the run back (peek claims): the notice is still pending for it, and goes
+    await claimRun(as(COORDINATOR), run);
+    expect(deliveryState(dir, ref(COORDINATOR), eventId)).toBe("pending");
+    const coordinator = startNotifier(as(COORDINATOR), {
+      coalesceMs: 0,
+      sendCodex: async (target) => {
+        sent.push(target.sessionId);
+        return { outcome: "accepted", msgId: "m2" };
+      },
+    });
+    notifiers.push(coordinator);
+    await coordinator.scan();
+    await coordinator.idle();
+    expect(sent).toContain(COORDINATOR);
+    expect(sent).not.toContain(VERIFIER_THREAD);
+    expect(deliveryState(dir, ref(COORDINATOR), eventId)).toBe("enqueue-accepted");
+    expect(summarizeRun(fakeDeps(), run).warnings.filter((w) => w.includes(ROLE_THREAD_REFUSAL))).toEqual([]);
+  });
+});
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/services/role-thread-delivery.test.ts test/services/role-env.test.ts test/services/notifier.test.ts test/infra/supervisor.test.ts test/services/summary-reconcile.test.ts`
Expected: FAIL. `role-thread-delivery.test.ts` fails to import `roleThreadOf`/`ROLE_THREAD_REFUSAL`; `role-env.test.ts` fails on `readThread`.

- [ ] **Step 3: Implement**

````diff
diff --git a/src/infra/delivery.ts b/src/infra/delivery.ts
index dafd1f5..c867496 100644
--- a/src/infra/delivery.ts
+++ b/src/infra/delivery.ts
@@ -24,6 +24,9 @@ const AttemptSchema = z
   .refine((a) => a.status !== "accepted" || Boolean(a.msgId?.trim()), "accepted attempt needs a receipt");
 const DeliverySchema = z.looseObject({ schema: z.literal(1), attempts: z.array(AttemptSchema) });
 export type DeliveryAttempt = z.infer<typeof AttemptSchema>;
+/** How a delivery to a role's thread is recorded (spec 1.5 plan 21); `status` warns about it. */
+export const ROLE_THREAD_REFUSAL = "refused: the target is a role's thread";
+
 export type DeliveryState = "pending" | "enqueue-accepted" | "ambiguous" | "collected";
 
 export function readDelivery(dir: string): DeliveryAttempt[] {
diff --git a/src/infra/dispatch-dir.ts b/src/infra/dispatch-dir.ts
index 666c5d5..7c41ba3 100644
--- a/src/infra/dispatch-dir.ts
+++ b/src/infra/dispatch-dir.ts
@@ -45,6 +45,8 @@ export function dispatchPaths(dir: string) {
     stall: join(dir, "stall.json"),
     /** the message that announced the stall, once sent */
     stallNotified: join(dir, "stall-notified.json"),
+    /** the role's own thread, written by the supervisor once the CLI names it (spec 1.5 plan 21) */
+    thread: join(dir, "thread.json"),
   };
 }
 
diff --git a/src/infra/supervisor.ts b/src/infra/supervisor.ts
index 803e20f..a83c79b 100644
--- a/src/infra/supervisor.ts
+++ b/src/infra/supervisor.ts
@@ -210,7 +210,15 @@ async function superviseHeld(spec: SuperviseSpec, hooks: SuperviseHooks): Promis
         } catch {
           continue; // one line the hook cannot read must not end supervision
         }
-        if (d?.thread) thread = d.thread;
+        if (d?.thread && d.thread !== thread) {
+          thread = d.thread;
+          // spec 1.5 plan 21: a live role's thread is on disk, so no delivery ever targets it
+          try {
+            writeJsonAtomic(p.thread, { schema: 1, thread, at: new Date().toISOString() });
+          } catch (e) {
+            log("warn", "supervise", { dispatch: spec.dispatchDir, error: errorMessage(e) });
+          }
+        }
         if (d?.final) finalAt ??= Date.now();
         if (d?.item) {
           if (d.item.open) open.add(d.item.id);
diff --git a/src/services/dispatches.ts b/src/services/dispatches.ts
index c9fdde3..c3837a9 100644
--- a/src/services/dispatches.ts
+++ b/src/services/dispatches.ts
@@ -140,6 +140,23 @@ export function pendingDispatches(
 export const liveDispatches = (run: Run, now = Date.now()): LiveDispatch[] =>
   pendingDispatches(run, now).filter((d) => d.state !== "finished");
 
+/** The thread the supervisor saw the role's CLI name (thread.json), else null. */
+export function readThread(dir: string): string | null {
+  const t = readJson<{ thread?: unknown }>(dispatchPaths(dir).thread)?.thread;
+  return typeof t === "string" && t ? t : null;
+}
+
+/**
+ * Spec 1.5 plan 21: the role whose thread `thread` is, in this run: a recorded thread, a resumed one, or the one
+ * a live role's supervisor wrote down. Null for any other thread, the orchestrator's among them.
+ */
+export function roleThreadOf(run: Run, thread: string): string | null {
+  const recorded = readRecords(run).records.find((r) => r.thread === thread);
+  if (recorded) return recorded.name;
+  const d = listDispatches(run).find((x) => x.admit.thread === thread || readThread(x.dir) === thread);
+  return d ? d.admit.name : null;
+}
+
 /** Spec §4.1: `roles/<name>/latest` names the newest dispatch of a role. */
 export function setLatest(run: Run, name: string, dispatchId: string): void {
   writeTextAtomic(join(roleDir(run, name), "latest"), dispatchId);
diff --git a/src/services/notifier.ts b/src/services/notifier.ts
index 145082f..6e62119 100644
--- a/src/services/notifier.ts
+++ b/src/services/notifier.ts
@@ -7,6 +7,7 @@ import { sendToCodexQueue, type QueueSendResult } from "../infra/codex-queue.ts"
 import {
   deliveryState,
   readDelivery,
+  ROLE_THREAD_REFUSAL,
   writeDeliveryAttempt,
   type DeliveryAttempt,
 } from "../infra/delivery.ts";
@@ -23,7 +24,7 @@ import {
   type Stalled,
   stallHooks,
 } from "./dispatch-service.ts";
-import { type Dispatch, listDispatches, readFailover } from "./dispatches.ts";
+import { type Dispatch, listDispatches, readFailover, roleThreadOf } from "./dispatches.ts";
 import type { Deps } from "./ports.ts";
 import { listRuns, readRecords, type Run } from "./run-store.ts";
 import { currentSession, ownsRun, readSessionRows, runOwner } from "./sessions.ts";
@@ -242,6 +243,38 @@ function notifierFor(deps: Deps, o: NotifierOptions, retryEvent?: string): Notif
           log("warn", "notify", { error: errorMessage(e), dispatch: q.notice.dispatchId });
         }
       }
+      // spec 1.5 plan 21: a notice never goes to a role's own thread (a `codex exec` thread exits after its turn,
+      // so what is queued there is lost). It fails loudly, and `status` says so, instead of enqueue-accepted.
+      const roles = new Map(due.map((q) => [q, roleThreadOf(q.run, target.sessionId)]));
+      for (const [q, role] of roles) {
+        if (role === null) continue;
+        due.splice(due.indexOf(q), 1);
+        const reason = `${ROLE_THREAD_REFUSAL} (${role}, ${target.host} ${target.sessionId}), not the orchestrator's; peek(run) from the orchestrator's session takes the run back`;
+        log("error", "notify", {
+          run: q.run.id,
+          dispatch: q.notice.dispatchId,
+          target: target.sessionId,
+          reason,
+        });
+        try {
+          writeDeliveryAttempt(q.dir, {
+            attemptId: crypto.randomUUID(),
+            target: {
+              host: target.host,
+              sessionId: target.sessionId,
+              hostSessionId: target.hostSessionId,
+              name: target.name,
+            },
+            eventIds: [q.notice.eventId],
+            at: new Date(deps.now()).toISOString(),
+            status: "failed",
+            msgId: null,
+            reason,
+          });
+        } catch (e) {
+          log("warn", "notify", { error: errorMessage(e), dispatch: q.notice.dispatchId });
+        }
+      }
       // nothing is sent unless every notice's claim is on disk. A claim that cannot be written rolls the batch's
       // written claims back to failed (provably not submitted, so still deliverable), keeps that notice for a
       // later pass, and claims the rest again at once: one bad file never holds back the others
diff --git a/src/services/summary.ts b/src/services/summary.ts
index 6bd1b6d..eb649bc 100644
--- a/src/services/summary.ts
+++ b/src/services/summary.ts
@@ -11,6 +11,7 @@ import { spendOf } from "./budget.ts";
 import { latestVerifierStep, type VerifierStep } from "./gate-service.ts";
 import { type OpenQuestion, openQuestions } from "./questions.ts";
 import { type DispatchState, listDispatches, liveDispatches } from "./dispatches.ts";
+import { readDelivery, ROLE_THREAD_REFUSAL } from "../infra/delivery.ts";
 import { type RunSession, sessionFacts } from "./session-view.ts";
 import type { Deps } from "./ports.ts";
 import { orchestratorWait, type OrchestratorWait } from "./orchestrator-wait.ts";
@@ -72,6 +73,16 @@ export function summarizeRun(deps: Deps, run: Run): RunSummary {
   } catch (e) {
     warnings.push(`budget: ${isCatherdError(e) ? e.message : String(e)}`);
   }
+  // spec 1.5 plan 21: a notice refused because its target was a role's thread, while that is its latest attempt
+  for (const d of listDispatches(run)) {
+    try {
+      const last = readDelivery(d.dir).at(-1);
+      if (last?.status === "failed" && last.reason?.startsWith(ROLE_THREAD_REFUSAL))
+        warnings.push(`${d.admit.name}: its notice was not sent: ${last.reason}`);
+    } catch {
+      // unreadable delivery evidence is the delivery row's to show
+    }
+  }
   return {
     waiting: orchestratorWait(run, now, records, live.length > 0),
     delivery: listDispatches(run).flatMap((d) =>
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun run format && bun test test/services/role-thread-delivery.test.ts test/services/role-env.test.ts test/services/notifier.test.ts test/infra/supervisor.test.ts test/services/summary-reconcile.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS (92 pass, 0 fail, 5 files).

- [ ] **Step 5: Commit**

````bash
git add -A src/infra/delivery.ts src/infra/dispatch-dir.ts src/infra/supervisor.ts src/services/dispatches.ts src/services/notifier.ts src/services/summary.ts test/services/role-env.test.ts test/services/role-thread-delivery.test.ts
git commit -m "fix(notify): a notice never goes to a role's thread; status warns instead"
````

---

### Task 4: The role server goes into every harness, isolated or not (#42 findings 1, 2) (spec "The role server in every harness" bullet; Rulings 9, 10)

Admission no longer refuses an isolated codex or claude-code architect, researcher, worker or verifier (`E_ADMIT_RUNG` "needs catherd's run tools"), and `roleRequiresMcp` has no admission use left (doctor's goes in Task 6): every codex and claude-code role gets the `catherd_role` server. That also ends finding 2: a thread an isolated run started resumes isolated with its role server.

Codex: the `-c mcp_servers.catherd_role.*` overrides are passed under `--ignore-user-config` too (#42's review verified they apply there).

Claude Code: `--safe-mode` drops every `--mcp-config` server. Verified in the installed Claude Code 2.1.287 (`/opt/claude-code/bin/claude`, the minified source): under safe mode the `--mcp-config` servers pass through a filter that keeps only `type: "sdk"` servers and logs `--mcp-config: N servers ignored (safe mode)`. So an isolated run with the role server isolates piece by piece instead: `--strict-mcp-config` (only the `--mcp-config` servers), `--setting-sources ""` (no user, project or local settings, so no hooks and no enabled plugins; the source parses `""` to no sources), `--disable-slash-commands` (no skills) and `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` (what `--safe-mode` itself sets for CLAUDE.md). A run with no role server (fixture capture) keeps `--safe-mode`.

opencode: its v2 background service ignores a client's config env (the adapter says so), so it gets no per-dispatch MCP config; its roles get the CLI forms (Task 5) in their brief (Task 7). The skill's role-server paragraph says all this, and `docs/dev/live-verification.md` gains section 15 for what only live CLIs prove.

**Files:**
- Modify: `docs/dev/live-verification.md`
- Modify: `plugin/skills/catherd/SKILL.md`
- Modify: `src/adapters/claude-code/index.ts`
- Modify: `src/services/admission.ts`
- Create: `test/services/role-server-harness.test.ts`
- Test: `test/sim/claude`

**Interfaces:**
- Consumes: Task 1 (admission's `roleScratch`, `RunRequest.scratch`).
- Produces: `isolationArgs(r)` (private, claude-code adapter). The Claude simulator accepts `--strict-mcp-config`, `--disable-slash-commands` and `--setting-sources <v>`.

**Scratch commit:** `3ba2b51` (fix(roles): the role server goes into every harness, isolated or not).

- [ ] **Step 1: Write the failing tests**

````diff
diff --git a/test/services/role-server-harness.test.ts b/test/services/role-server-harness.test.ts
new file mode 100644
index 0000000..c3ca00b
--- /dev/null
+++ b/test/services/role-server-harness.test.ts
@@ -0,0 +1,93 @@
+import { afterEach, beforeEach, describe, expect, it } from "bun:test";
+import { readFileSync } from "node:fs";
+import { newDispatchId } from "../../src/domain/ids.ts";
+import { type AdmitInput, admit } from "../../src/services/admission.ts";
+import { resetReadiness } from "../../src/services/backends.ts";
+import { appendRecord } from "../../src/services/run-store.ts";
+import { snapshotEnv } from "../helpers.ts";
+import { withClaudeScenario } from "../sim/sim-scenarios.ts";
+import { simPath, withScenario } from "../sim/scenario.ts";
+import { fakeDeps, freshRun, makeRecord, testView } from "./helpers.ts";
+
+afterEach(snapshotEnv());
+beforeEach(() => resetReadiness());
+
+const CODEX = "codex:gpt-6-sol#high";
+const CLAUDE = "claude-code:claude-opus-5-5#low";
+
+function setup() {
+  const { run } = freshRun();
+  process.env.PATH = simPath();
+  Object.assign(process.env, withScenario({}).env, withClaudeScenario({}).env);
+  const view = testView({ isolated: { codex: true, "claude-code": true } });
+  view.roles.verifier = { enabled: true, access: "workspace-write", rungs: [CODEX, CLAUDE] };
+  return { run, deps: fakeDeps({ view }) };
+}
+
+const verifier = (rung: string, over: Partial<AdmitInput> = {}): AdmitInput => ({
+  role: "verifier",
+  name: "verifier-M1",
+  brief: "verify M1",
+  rung,
+  thread: null,
+  lane: null,
+  failoverFrom: null,
+  ...over,
+});
+
+const spec = (path: string) =>
+  JSON.parse(readFileSync(path, "utf8")) as { args: string[]; env: Record<string, string> };
+
+describe("the role server in every harness (spec 1.5 plan 21, #42 findings 1, 2)", () => {
+  it("admits an isolated Codex verifier, with the role server under --ignore-user-config", async () => {
+    const { run, deps } = setup();
+    const { d, specPath } = await admit(deps, run, verifier(CODEX));
+    expect(d.admit.isolated).toBe(true);
+    const { args } = spec(specPath);
+    expect(args).toContain("--ignore-user-config");
+    expect(args).toContain("mcp_servers.catherd_role.enabled=true");
+    expect(args).toContain(
+      'mcp_servers.catherd_role.enabled_tools=["read_run_file","read_knowledge","gate_check","gate_pass"]',
+    );
+  });
+
+  it("admits an isolated Claude Code verifier, isolated piece by piece so its --mcp-config survives", async () => {
+    const { run, deps } = setup();
+    const { specPath } = await admit(deps, run, verifier(CLAUDE));
+    const { args, env } = spec(specPath);
+    expect(args).not.toContain("--safe-mode");
+    expect(args).toContain("--strict-mcp-config");
+    expect(args).toContain("--disable-slash-commands");
+    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
+    expect(JSON.parse(args[args.indexOf("--mcp-config") + 1]!).mcpServers.catherd_role.args).toEqual([
+      expect.stringMatching(/role-bin\.ts$/),
+      "verifier",
+      run.id,
+    ]);
+    expect(args[args.indexOf("--allowedTools") + 1]).toContain("mcp__catherd_role__gate_pass");
+    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
+  });
+
+  it("resumes a thread an isolated run started, after the user turned isolation off", async () => {
+    const { run, deps } = setup();
+    const thread = "019a0000-0000-7000-8000-000000000001";
+    await appendRecord(
+      run,
+      makeRecord({
+        runId: run.id,
+        dispatchId: newDispatchId(),
+        name: "verifier-M1",
+        role: "verifier",
+        lane: null,
+        rung: CODEX,
+        backend: "codex",
+        thread,
+        isolated: true,
+      }),
+    );
+    deps.view.isolated = {};
+    const { d, specPath } = await admit(deps, run, verifier(CODEX, { thread }));
+    expect(d.admit.isolated).toBe(true);
+    expect(spec(specPath).args).toContain("mcp_servers.catherd_role.enabled=true");
+  });
+});
diff --git a/test/sim/claude b/test/sim/claude
index aa96763..eeef8f8 100755
--- a/test/sim/claude
+++ b/test/sim/claude
@@ -33,8 +33,16 @@ const VALUE = [
   "--disallowedTools",
   "--settings",
   "--mcp-config",
+  "--setting-sources",
+];
+const BOOL = [
+  "-p",
+  "--print",
+  "--verbose",
+  "--safe-mode",
+  "--strict-mcp-config",
+  "--disable-slash-commands",
 ];
-const BOOL = ["-p", "--print", "--verbose", "--safe-mode"];
 const opts: Record<string, string> = {};
 const prompt: string[] = [];
 for (let i = 0; i < args.length; i++) {
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/services/role-server-harness.test.ts test/adapters/claude-code.test.ts test/services/claude-code-dispatch.test.ts test/services/capture.test.ts test/skills.test.ts test/services/admission.test.ts`
Expected: FAIL. `role-server-harness.test.ts`: the isolated Codex and Claude Code verifiers are refused with `E_ADMIT_RUNG`; the resume case is refused too.

- [ ] **Step 3: Implement**

````diff
diff --git a/docs/dev/live-verification.md b/docs/dev/live-verification.md
index ede789a..1555f4d 100644
--- a/docs/dev/live-verification.md
+++ b/docs/dev/live-verification.md
@@ -924,3 +924,34 @@ catherd runs retry-push <run> <name> --event '<exact event ID>' --acknowledge-po
 Preserve all event IDs through retry/coalescing; duplicate input remains an idempotent record read. The actual catherd record and reviewer/verifier gate, not a forged or echoed envelope, determine what can land. Record accepted, ambiguous, failed and collected states separately, and retain unread work on failures.
 
 The controller records exact commands, hashes, actual host observations, deviations and unverified cases in the acceptance report. Release stays held until the real packaged flow passes in both Codex surfaces and Claude Code, including busy ordering and the unchanged gate. No daemon research, fixture, skipped test, source-only skill read or isolated handshake marks an installed skill flow passed. Keep the existing Changesets/stamp/release tooling; this section authorizes neither CI nor publication.
+
+## 15. Roles and ownership (1.5, plan 21)
+
+What the simulators cannot prove: how each vendor CLI hands a role's env to the MCP servers it starts, and which
+flags keep the role server alive in an isolated Claude Code run. Use a scratch repo and a profile whose roles run on
+Codex and headless Claude Code (`claude-code:` rungs).
+
+1. **A native Codex role cannot take the run (the payment run's P1).** With `harness.codex.isolated` false and the
+   catherd plugin installed in Codex, dispatch a verifier whose brief asks it to call catherd's `peek` with the run
+   id. Look for: the verifier's reply quotes `E_ROLE_SCOPE`; `catherd runs show <run>` still names the
+   orchestrator's thread as owner; the verifier's notice reaches the orchestrator. If the plugin's server answered
+   anything else, Codex no longer passes `TMPDIR` to MCP servers: record the Codex version and the env the server
+   saw (`catherd mcp` logs `session` at start).
+2. **Isolated Codex keeps the role server.** Set `harness.codex.isolated` true and dispatch a verifier. Look for:
+   its reply shows it called `mcp__catherd_role__gate_check`; `codex mcp list` inside catherd's `CODEX_HOME` lists
+   nothing of the user's.
+3. **Isolated Claude Code keeps the role server and drops the rest.** Set `harness.claude-code.isolated` true and
+   dispatch a verifier on a `claude-code:` rung, in a repo whose `CLAUDE.md` says "end every reply with BANANA" and
+   whose `.claude/settings.json` has a `SessionStart` hook that writes a file. Look for: the role calls
+   `mcp__catherd_role__gate_check`; no reply ends with BANANA; the hook's file is absent; the role's `events.jsonl`
+   lists only `catherd_role` among its MCP servers. Then confirm the reason for the change once by hand:
+   `claude -p --safe-mode --mcp-config '<the role server json>' --debug` logs "--mcp-config: 1 server ignored (safe
+   mode)" (Claude Code 2.1.287).
+4. **A native Claude subagent cannot steer.** On Claude Code, ask a native verifier (`claude:` rung) to call
+   `mcp__plugin_catherd_catherd__dispatch`. Look for: Claude Code refuses the tool (its agent file's
+   `disallowedTools`), and the run is unchanged.
+5. **Roles without the role server use the CLI forms.** Dispatch an opencode worker whose brief asks it to run
+   `catherd run-file read <run> lanes/<lane>.md`, then `catherd run-file read <other run> plan.md`. Look for: the
+   first prints the lane file; the second fails with `E_ROLE_SCOPE`.
+6. **Scratch.** After any dispatch, `ls <run>/scratch/<name>/` holds what the role wrote to `$TMPDIR` and `/tmp`
+   holds nothing new from it; `catherd runs clean <run>` removes the scratch once no role is live.
diff --git a/plugin/skills/catherd/SKILL.md b/plugin/skills/catherd/SKILL.md
index cda25c7..b2898b0 100644
--- a/plugin/skills/catherd/SKILL.md
+++ b/plugin/skills/catherd/SKILL.md
@@ -35,7 +35,7 @@ The catherd server keeps `state.md` true: it rewrites it on every dispatch, clim
 
 The catherd MCP tools ship with this plugin. Discover them through the host's available capability mechanism: tool names and deferred loading vary by host. In Claude Code they appear as `mcp__plugin_catherd_catherd__<name>`; use `ToolSearch` there when deferred, and load `PushNotification` if available. Codex uses its own exposed tools and discovery facility; never invent a Claude `ToolSearch`, `Agent` or notification tool there.
 
-Native headless Codex and Claude Code roles receive a dedicated `catherd_role` MCP server (`mcp__catherd_role__<name>`): all roles can read run files and knowledge, architects/researchers can write run files, and verifiers can record gate checks and passes. Dispatch configures it for the role without editing the user's config or profiles. Native Claude subagents retain the plugin tool namespace above. Isolated Codex/Claude Code architects, researchers, workers and verifiers are refused before launch because they require these MCP tools; use a native harness for those roles. Other isolated roles retain their existing behavior without the role server.
+Headless Codex and Claude Code roles receive a dedicated `catherd_role` MCP server (`mcp__catherd_role__<name>`), isolated or not: all roles can read run files and knowledge, architects/researchers can write run files, and verifiers can record gate checks and passes. Dispatch configures it for the role without editing the user's config or profiles. Native Claude subagents retain the plugin tool namespace above. Roles on other backends use the same operations from their shell: `catherd run-file read|write <run> <path>` and `catherd gate check|pass <run> …`, bound to their own run. A role is never refused for being isolated.
 
 Pass the actual project `repo` explicitly to profile, setup and catalog tools that accept it. The native Codex MCP server starts in the installed plugin root, so its cwd is not evidence of the project. `run_start(repo, ...)` establishes the run's repository.
 
diff --git a/src/adapters/claude-code/index.ts b/src/adapters/claude-code/index.ts
index 1d15915..2d35724 100644
--- a/src/adapters/claude-code/index.ts
+++ b/src/adapters/claude-code/index.ts
@@ -141,6 +141,18 @@ async function accessShell(): Promise<AccessShell | string> {
   return scratchShell("an unsandboxed shell (Claude Code's sandbox is off)", []);
 }
 
+/**
+ * An isolated run without the user's customizations. --bare would also drop OAuth, so a Claude plan could not
+ * log in; --safe-mode keeps auth, but drops every --mcp-config server too (Claude Code 2.1.287: "--mcp-config:
+ * … ignored (safe mode)"). A run with the role server (spec 1.5 plan 21, #42 finding 1) gets the same isolation
+ * piece by piece instead: only the --mcp-config servers, no settings file (so no hooks, no enabled plugins), no
+ * skills, and CLAUDE.md off through the env.
+ */
+function isolationArgs(r: RunRequest): string[] {
+  if (!r.roleMcp) return ["--safe-mode"];
+  return ["--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands"];
+}
+
 function plan(r: RunRequest): SpawnPlan {
   if (r.thread !== null && !THREAD.test(r.thread))
     throw new CatherdError("E_ADMIT_THREAD", `"${r.thread}" is not a Claude Code session id`, {
@@ -173,10 +185,10 @@ function plan(r: RunRequest): SpawnPlan {
       "--permission-prompts",
       "none",
       ...accessArgs,
-      // --bare would also drop OAuth, so a Claude plan could not log in; --safe-mode keeps auth
-      ...(r.isolated ? ["--safe-mode"] : []),
+      ...(r.isolated ? isolationArgs(r) : []),
     ],
-    env: {},
+    // CLAUDE.md off, as --safe-mode turns it off (spec 1.5 plan 21)
+    env: r.isolated && r.roleMcp ? { CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1" } : {},
     cwd: r.repo,
     stdinPath: r.briefPath,
   };
diff --git a/src/services/admission.ts b/src/services/admission.ts
index 9ce84b5..49ed1cb 100644
--- a/src/services/admission.ts
+++ b/src/services/admission.ts
@@ -10,7 +10,6 @@ import type { RunRecord } from "../domain/record.ts";
 import { withReplyContract } from "../domain/role-prompts.ts";
 import type { Role } from "../domain/roles.ts";
 import { formatRoleScope, ROLE_ENV } from "../domain/role-scope.ts";
-import { roleRequiresMcp } from "../domain/role-tools.ts";
 import { dispatchPaths, markForCollect } from "../infra/dispatch-dir.ts";
 import { withFileLock } from "../infra/filelock.ts";
 import { statusSnapshot } from "../infra/git.ts";
@@ -205,15 +204,9 @@ export async function admit(
   const dir = join(roleDir(run, i.name), id);
   const p = dispatchPaths(dir);
   const isolated = started?.isolated ?? profile.isolated[rung.backend] ?? false;
-  const needsRoleMcp = rung.backend === "codex" || rung.backend === "claude-code";
-  if (needsRoleMcp && isolated && roleRequiresMcp(i.role))
-    throw new CatherdError(
-      "E_ADMIT_RUNG",
-      `${i.role} needs catherd's run tools, which are not available in an isolated ${rung.backend} harness`,
-      {
-        fix: `set harness.${rung.backend}.isolated to false in profile ${profile.name}, then dispatch a fresh thread`,
-      },
-    );
+  // spec 1.5 plan 21 (#42 findings 1, 2): the role server goes in whether the harness is isolated or not, so no
+  // role is refused for isolation, and a thread an isolated run started resumes as it started
+  const roleServer = rung.backend === "codex" || rung.backend === "claude-code";
   const scratch = roleScratch(run, i.name, rung.backend);
   await prepared(adapter, {
     rung,
@@ -232,7 +225,7 @@ export async function admit(
     briefPath: p.brief,
     replyPath: p.reply,
     dispatchDir: dir,
-    ...(needsRoleMcp && !isolated ? { roleMcp: { run: run.id, role: i.role } } : {}),
+    ...(roleServer ? { roleMcp: { run: run.id, role: i.role } } : {}),
     ...(scratch ? { scratch } : {}),
   });
 
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun run format && bun test test/services/role-server-harness.test.ts test/adapters/claude-code.test.ts test/services/claude-code-dispatch.test.ts test/services/capture.test.ts test/skills.test.ts test/services/admission.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS (70 pass, 0 fail, 6 files).

- [ ] **Step 5: Commit**

````bash
git add -A docs/dev/live-verification.md plugin/skills/catherd/SKILL.md src/adapters/claude-code/index.ts src/services/admission.ts test/services/role-server-harness.test.ts test/sim/claude
git commit -m "fix(roles): the role server goes into every harness, isolated or not"
````

---

### Task 5: `catherd run-file` and `catherd gate`: the CLI forms any role can run (spec "CLI forms any role can run" bullet; Ruling 11)

`catherd run-file read|write <run> <path>` (write reads stdin) and `catherd gate check|pass <run> --item … --command … --paths a,b [--milestone M] [--evidence …]` run the role server's operations from a shell. In a role (CATHERD_ROLE, or a scratch TMPDIR) `assertRoleMay` binds them to the role's own run and to its role's tools (the role kind is read from its latest dispatch's `admit.role`), refusing anything else with `E_ROLE_SCOPE`; outside a role (the user's terminal) they work on any run. README lists both.

**Files:**
- Modify: `README.md`
- Modify: `src/cli.ts`
- Create: `src/entry/role-cli-command.ts`
- Create: `src/services/role-access.ts`
- Create: `test/entry/role-cli-command.test.ts`

**Interfaces:**
- Consumes: Task 1's `roleScopeFromEnv`, `E_ROLE_SCOPE`.
- Produces: `src/services/role-access.ts`: `assertRoleMay(scope: RoleScope | null, run: string, tool: string): void`. `src/entry/role-cli-command.ts`: `runFileCommand`, `gateCommand`, registered in `src/cli.ts` as `run-file` and `gate`.

**Scratch commit:** `68e254a` (feat(cli): run-file and gate commands any role can run, bound to its run).

- [ ] **Step 1: Write the failing tests**

````diff
diff --git a/test/entry/role-cli-command.test.ts b/test/entry/role-cli-command.test.ts
new file mode 100644
index 0000000..56b37ca
--- /dev/null
+++ b/test/entry/role-cli-command.test.ts
@@ -0,0 +1,99 @@
+import { afterEach, describe, expect, it } from "bun:test";
+import { readFileSync, writeFileSync } from "node:fs";
+import { join } from "node:path";
+import { createRun, runPaths } from "../../src/services/run-store.ts";
+import { snapshotEnv, tempRepo } from "../helpers.ts";
+import { SRC } from "../import-graph.ts";
+import { fakeDispatch, freshRun } from "../services/helpers.ts";
+
+afterEach(snapshotEnv());
+
+/** `catherd <args>` as a role's shell runs it: CATHERD_ROLE set, or not, and nothing else of catherd's. */
+function catherd(args: string[], o: { role?: string; stdin?: string } = {}) {
+  const env: Record<string, string> = {
+    ...(process.env as Record<string, string>),
+    NO_COLOR: "1",
+    ANTHROPIC_API_KEY: "",
+  };
+  delete env.CATHERD_ROLE;
+  if (o.role) env.CATHERD_ROLE = o.role;
+  const p = Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), ...args], {
+    env,
+    stdin: o.stdin === undefined ? "ignore" : Buffer.from(o.stdin),
+    stdout: "pipe",
+    stderr: "pipe",
+  });
+  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
+}
+
+describe("the CLI forms any role can run (spec 1.5 plan 21)", () => {
+  it("reads and writes run files, bound by CATHERD_ROLE to the role's own run and its role's operations", async () => {
+    const { run } = freshRun();
+    const other = createRun({ repo: tempRepo(), title: "other", aLines: ["A1"], version: "0.0.0-test" });
+    await fakeDispatch(run, { name: "worker-M1.L1" });
+    await fakeDispatch(run, {
+      name: "architect",
+      role: "architect",
+      lane: null,
+      owns: [],
+      access: "read-only",
+    });
+    writeFileSync(join(runPaths(run.dir).lanes, "M1.L1.md"), "# M1.L1 — lane\nOwns: src/a.ts\n");
+    writeFileSync(join(other.dir, "plan.md"), "secret plan\n");
+
+    // the worker reads its lane, but neither writes nor reads another run
+    const worker = `${run.id}/worker-M1.L1`;
+    expect(catherd(["run-file", "read", run.id, "lanes/M1.L1.md"], { role: worker })).toMatchObject({
+      code: 0,
+      out: "# M1.L1 — lane\nOwns: src/a.ts\n",
+    });
+    const elsewhere = catherd(["run-file", "read", other.id, "plan.md"], { role: worker });
+    expect(elsewhere.code).toBe(1);
+    expect(elsewhere.err).toContain(`error E_ROLE_SCOPE: this process runs worker-M1.L1 of run ${run.id}`);
+    const write = catherd(["run-file", "write", run.id, "notes.md"], { role: worker, stdin: "x" });
+    expect(write.err).toContain("error E_ROLE_SCOPE: worker-M1.L1 is a worker, which has no write_run_file");
+
+    // the architect writes; catherd's own files stay protected
+    const architect = `${run.id}/architect`;
+    expect(
+      catherd(["run-file", "write", run.id, "plan.md"], { role: architect, stdin: "# Plan\n" }).code,
+    ).toBe(0);
+    expect(readFileSync(join(run.dir, "plan.md"), "utf8")).toBe("# Plan\n");
+    expect(catherd(["run-file", "write", run.id, "state.md"], { role: architect, stdin: "x" }).err).toContain(
+      "error E_IO_PATH",
+    );
+    // a name that is no dispatch of the run gets nothing
+    expect(catherd(["run-file", "read", run.id, "plan.md"], { role: `${run.id}/ghost` }).err).toContain(
+      "error E_ROLE_SCOPE: ghost is no dispatch of run",
+    );
+    // the user's own terminal is not a role
+    expect(catherd(["run-file", "read", other.id, "plan.md"]).out).toBe("secret plan\n");
+  });
+
+  it("checks and records a verifier's gate items, and refuses them to any other role", async () => {
+    const { repo, run } = freshRun();
+    await fakeDispatch(run, {
+      name: "verifier-M1",
+      role: "verifier",
+      lane: null,
+      owns: [],
+      access: "read-only",
+    });
+    await fakeDispatch(run, { name: "worker-M1.L1" });
+    writeFileSync(join(repo, "a.txt"), "a\n");
+    const gate = ["--item", "unit", "--command", "bun test", "--paths", "a.txt"];
+    const verifier = `${run.id}/verifier-M1`;
+    const first = catherd(["gate", "check", run.id, ...gate, "--milestone", "M1"], { role: verifier });
+    expect(first.code).toBe(0);
+    expect(JSON.parse(first.out)).toEqual({ carried: false });
+    expect(catherd(["gate", "pass", run.id, ...gate, "--evidence", "12 pass"], { role: verifier }).code).toBe(
+      0,
+    );
+    expect(JSON.parse(catherd(["gate", "check", run.id, ...gate], { role: verifier }).out)).toMatchObject({
+      carried: true,
+    });
+    expect(
+      catherd(["gate", "pass", run.id, ...gate, "--evidence", "x"], { role: `${run.id}/worker-M1.L1` }).err,
+    ).toContain("error E_ROLE_SCOPE: worker-M1.L1 is a worker, which has no gate_pass");
+  });
+});
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/entry/role-cli-command.test.ts test/entry/help-text.test.ts test/entry/cli.test.ts`
Expected: FAIL. `role-cli-command.test.ts`: `catherd run-file …` and `catherd gate …` are unknown commands (usage error).

- [ ] **Step 3: Implement**

````diff
diff --git a/README.md b/README.md
index 7498a85..e9f3461 100644
--- a/README.md
+++ b/README.md
@@ -201,6 +201,8 @@ In a terminal:
 | `catherd catalog treat-like --suggest <rung>\|--clear <rung>\|--reset`                      | The three nearest stand-ins for a rung; removes one or every mapping of yours                       |
 | `catherd knowledge show\|add "<line>"\|path [--repo <path>]`                                | The repo's knowledge.md, which new runs read; `add` appends a fact of yours, marked "by hand"       |
 | `catherd lock [--slots N] -- <cmd>`                                                         | Runs a heavy command behind the machine-wide semaphore, in its own session (no /dev/tty)            |
+| `catherd run-file read\|write <run> <path>`                                                 | A run's plan, lanes and notes (`write` reads stdin); in a role, its own run only                    |
+| `catherd gate check\|pass <run> --item <i> --command <c> --paths <p,…> [--evidence <e>]`    | A verifier's gate evidence, as `gate_check`/`gate_pass`; in a role, its own run only                |
 | `catherd mcp`                                                                               | The MCP server on stdio; the plugin starts it, you never need to                                    |
 | `catherd capture-fixtures [--backend <b>] [--out <dir>]`                                    | Contributors: records sanitized test fixtures from real runs (see CONTRIBUTING.md)                  |
 
diff --git a/src/cli.ts b/src/cli.ts
index b1a30f4..fdc0517 100755
--- a/src/cli.ts
+++ b/src/cli.ts
@@ -52,6 +52,8 @@ export const main: Command = defineCommand({
     knowledge: () => import("./entry/knowledge-command.ts").then((m) => m.knowledgeCommand),
     workspace: () => import("./entry/workspace-command.ts").then((m) => m.workspaceCommand),
     lock: () => import("./entry/lock-command.ts").then((m) => m.lockCommand),
+    "run-file": () => import("./entry/role-cli-command.ts").then((m) => m.runFileCommand),
+    gate: () => import("./entry/role-cli-command.ts").then((m) => m.gateCommand),
     "capture-fixtures": () =>
       import("./entry/capture-fixtures-command.ts").then((m) => m.captureFixturesCommand),
     mcp: () => import("./entry/mcp/command.ts").then((m) => m.mcpCommand),
diff --git a/src/entry/role-cli-command.ts b/src/entry/role-cli-command.ts
new file mode 100644
index 0000000..f6f73d9
--- /dev/null
+++ b/src/entry/role-cli-command.ts
@@ -0,0 +1,108 @@
+import { defineCommand } from "citty";
+import { CatherdError } from "../domain/errors.ts";
+import { ID_PATTERN } from "../domain/ids.ts";
+import { roleScopeFromEnv } from "../domain/role-scope.ts";
+import { gateCheck, gatePass } from "../services/gate-service.ts";
+import { assertRoleMay } from "../services/role-access.ts";
+import { readRunFile, writeRunFile } from "../services/run-service.ts";
+import { printJson } from "./cli-kit.ts";
+import { defaultDeps } from "./deps.ts";
+
+/**
+ * Spec 1.5 plan 21: the role server's operations as commands any role can run from its shell, on a backend
+ * whose harness has no role server (opencode, Cursor, Grok Build, agy) or when no MCP tool is listed. In a role
+ * (CATHERD_ROLE, or its scratch TMPDIR) they are bound to its own run and its role's operations.
+ */
+const scope = () => roleScopeFromEnv(process.env);
+
+const RUN_PATH = {
+  run: { type: "positional", required: true, description: "the run id" },
+  path: { type: "positional", required: true, description: "a path relative to the run folder" },
+} as const;
+
+const read = defineCommand({
+  meta: { name: "read", description: "Print a file of the run folder (read_run_file)" },
+  args: RUN_PATH,
+  run({ args }) {
+    assertRoleMay(scope(), args.run, "read_run_file");
+    const text = readRunFile({ run: args.run, path: args.path });
+    process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
+  },
+});
+
+const write = defineCommand({
+  meta: { name: "write", description: "Write stdin to a file of the run folder (write_run_file)" },
+  args: RUN_PATH,
+  async run({ args }) {
+    assertRoleMay(scope(), args.run, "write_run_file");
+    const content = await Bun.stdin.text();
+    printJson(writeRunFile({ run: args.run, path: args.path, content }));
+  },
+});
+
+export const runFileCommand = defineCommand({
+  meta: { name: "run-file", description: "Read or write a run's plan, lanes, dossier and notes" },
+  subCommands: { read, write },
+});
+
+const GATE = {
+  run: { type: "positional", required: true, description: "the run id" },
+  item: { type: "string", required: true, description: "the gate item's name" },
+  command: { type: "string", required: true, description: "the command that checks it" },
+  paths: { type: "string", required: true, description: "the repo paths it depends on, comma-separated" },
+} as const;
+
+const pathsOf = (s: string): string[] => {
+  const paths = s
+    .split(",")
+    .map((p) => p.trim())
+    .filter(Boolean);
+  if (!paths.length)
+    throw new CatherdError("E_INPUT_INVALID", "--paths names no path", {
+      fix: "pass --paths src,package.json",
+    });
+  return paths;
+};
+
+const check = defineCommand({
+  meta: { name: "check", description: "Whether a gate item passed on unchanged content (gate_check)" },
+  args: { ...GATE, milestone: { type: "string", description: "the milestone you verify, like M1" } },
+  async run({ args }) {
+    assertRoleMay(scope(), args.run, "gate_check");
+    if (args.milestone !== undefined && !ID_PATTERN.test(args.milestone))
+      throw new CatherdError("E_INPUT_INVALID", `bad milestone "${args.milestone}"`, {
+        fix: "pass --milestone M1",
+      });
+    printJson(
+      await gateCheck(defaultDeps(), {
+        run: args.run,
+        item: args.item,
+        command: args.command,
+        paths: pathsOf(args.paths),
+        ...(args.milestone ? { milestone: args.milestone } : {}),
+      }),
+    );
+  },
+});
+
+const pass = defineCommand({
+  meta: { name: "pass", description: "Record a passed gate item with its evidence (gate_pass)" },
+  args: { ...GATE, evidence: { type: "string", required: true, description: "what showed it passed" } },
+  async run({ args }) {
+    assertRoleMay(scope(), args.run, "gate_pass");
+    printJson(
+      await gatePass(defaultDeps(), {
+        run: args.run,
+        item: args.item,
+        command: args.command,
+        paths: pathsOf(args.paths),
+        evidence: args.evidence,
+      }),
+    );
+  },
+});
+
+export const gateCommand = defineCommand({
+  meta: { name: "gate", description: "A verifier's gate evidence: check an item, record a pass" },
+  subCommands: { check, pass },
+});
diff --git a/src/services/role-access.ts b/src/services/role-access.ts
new file mode 100644
index 0000000..da3e58b
--- /dev/null
+++ b/src/services/role-access.ts
@@ -0,0 +1,27 @@
+import { CatherdError } from "../domain/errors.ts";
+import type { RoleScope } from "../domain/role-scope.ts";
+import { roleMcpTools } from "../domain/role-tools.ts";
+import { latestDispatch } from "./dispatches.ts";
+import { findRun } from "./run-store.ts";
+
+/**
+ * Spec 1.5 plan 21: what the role server lets a role do, for the CLI forms any role can run
+ * (`catherd run-file`, `catherd gate`). Outside a role (`scope` null: the user's own terminal) everything is
+ * allowed. In a role, only its own run, and only the operations its role server would list (`tool`).
+ */
+export function assertRoleMay(scope: RoleScope | null, run: string, tool: string): void {
+  if (!scope) return;
+  if (scope.run !== run)
+    throw new CatherdError(
+      "E_ROLE_SCOPE",
+      `this process runs ${scope.name} of run ${scope.run}, not of run ${run}`,
+      { fix: `use run ${scope.run}` },
+    );
+  const role = latestDispatch(findRun(run), scope.name)?.admit.role;
+  if (!role || !roleMcpTools(role).includes(tool))
+    throw new CatherdError(
+      "E_ROLE_SCOPE",
+      `${scope.name} ${role ? `is a ${role}, which has no ${tool}` : `is no dispatch of run ${run}`}`,
+      { fix: "report it in your reply; the orchestrator does it" },
+    );
+}
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun run format && bun test test/entry/role-cli-command.test.ts test/entry/help-text.test.ts test/entry/cli.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS (25 pass, 0 fail, 3 files).

- [ ] **Step 5: Commit**

````bash
git add -A README.md src/cli.ts src/entry/role-cli-command.ts src/services/role-access.ts test/entry/role-cli-command.test.ts
git commit -m "feat(cli): run-file and gate commands any role can run, bound to its run"
````

---

### Task 6: Role server fixes (#42 findings 4, 5, 6, 8, 9) (spec "Role server fixes" and "Delete the report" bullets; Rulings 12–14)

- **Finding 4.** The role server's `read_knowledge` takes an optional `repo` and always reads the run's repository (`.`, the pwd or `/tmp` vs `/private/tmp` no longer fail).
- **Finding 5.** The native role prompts name only the run-file tools each role gets (`runFiles(writes)`: the worker reads; the architect and researcher read and write), with the CLI forms as the fallback; the verifier's prompt names `catherd gate check|pass` as the fallback when no gate tool is listed.
- **Finding 6.** Doctor's role-MCP rows cover the active profile only (`roleMcpChecks(profile, start?)`), drop the isolated fail/skip and the always-true `existsSync(ROLE_MCP_ENTRY)` check; `roleRequiresMcp` is deleted. `profile validate` never warned about isolation and needs nothing now; a test pins that isolation changes no issue (Ruling 14).
- **Finding 8.** Codex gets `mcp_servers.catherd_role.startup_timeout_sec=30` and keeps `required=true`, because doctor now probes the start: `probeRoleServer()` runs `role-bin.ts --probe` (it loads the server's whole module graph and prints `ready`) and the row says the cold start in ms, warns past 15 s (`slow start`) and fails when it does not start (`no start`).
- **Finding 9.** `docs/dev/reports/role-access-orchestration-wait-pr.md` is deleted.

**Files:**
- Delete: `docs/dev/reports/role-access-orchestration-wait-pr.md`
- Modify: `src/domain/role-prompts.ts`
- Modify: `src/domain/role-tools.ts`
- Modify: `src/entry/doctor-command.ts`
- Modify: `src/entry/mcp/role-bin.ts`
- Modify: `src/entry/mcp/role-server.ts`
- Modify: `src/infra/role-mcp.ts`
- Modify: `src/services/doctor-role-mcp.ts`
- Modify: `src/services/doctor.ts`
- Test: `test/domain/verifier-prompt.test.ts`
- Test: `test/entry/role-mcp.test.ts`
- Create: `test/services/doctor-role-mcp.test.ts`

**Interfaces:**
- Consumes: Task 4 (admission no longer imports `roleRequiresMcp`).
- Produces: `src/infra/role-mcp.ts`: `ROLE_MCP_STARTUP_SEC = 30`, `type RoleServerStart = { ok: true; ms: number } | { ok: false; error: string }`, `probeRoleServer(timeoutMs?): Promise<RoleServerStart>`. `roleMcpChecks(profile: Profile | null, start?: RoleServerStart): Check[]`. `DoctorDeps.roleServerStart?: () => Promise<RoleServerStart>` (the CLI passes `probeRoleServer`). `roleRequiresMcp` is gone.

**Scratch commit:** `deb83d3` (fix(roles): role server fixes from the #42 review).

- [ ] **Step 1: Write the failing tests**

````diff
diff --git a/test/domain/verifier-prompt.test.ts b/test/domain/verifier-prompt.test.ts
index c38593c..89cd8a5 100644
--- a/test/domain/verifier-prompt.test.ts
+++ b/test/domain/verifier-prompt.test.ts
@@ -15,4 +15,24 @@ describe("the verifier's prompt (spec 1.1 §7)", () => {
       expect(text).toContain(s);
     expect(text.split("\n")[0]).toStartWith("You verify work you did not write.");
   });
+
+  it("names the CLI forms as the fallback when no gate tool is listed (spec 1.5 plan 21)", () => {
+    const text = rolePrompt("verifier", "1.5.0");
+    expect(text).toContain(
+      "When neither tool is listed, run the same from your shell: catherd gate check <run>",
+    );
+    expect(text).toContain("then catherd gate pass <run> --item <item>");
+  });
+
+  it("tells each role only the run-file tools it gets (#42 finding 5)", () => {
+    const worker = rolePrompt("worker", "1.5.0");
+    expect(worker).toContain("Read it only through catherd's read_run_file");
+    expect(worker).toContain("catherd run-file read <run> <path>");
+    expect(worker).not.toContain("write_run_file");
+    for (const role of ["architect", "researcher"] as const) {
+      const text = rolePrompt(role, "1.5.0");
+      expect(text).toContain("Read and write it only through catherd's read_run_file and write_run_file");
+      expect(text).toContain("catherd run-file write <run> <path> with the content on stdin");
+    }
+  });
 });
diff --git a/test/entry/role-mcp.test.ts b/test/entry/role-mcp.test.ts
index 6df458a..d60faeb 100644
--- a/test/entry/role-mcp.test.ts
+++ b/test/entry/role-mcp.test.ts
@@ -5,6 +5,7 @@ import { existsSync } from "node:fs";
 import { join } from "node:path";
 import type { Role } from "../../src/domain/roles.ts";
 import { buildRoleServer } from "../../src/entry/mcp/role-server.ts";
+import { codexRoleMcpArgs, probeRoleServer, ROLE_MCP_STARTUP_SEC } from "../../src/infra/role-mcp.ts";
 import { createRun } from "../../src/services/run-store.ts";
 import { snapshotEnv, tempRepo } from "../helpers.ts";
 import { call } from "../mcp-helpers.ts";
@@ -20,6 +21,19 @@ async function roleClient(run: string, role: Role): Promise<Client> {
   return client;
 }
 
+describe("the role server's start (spec 1.5 plan 21, #42 finding 8)", () => {
+  it("gives Codex an explicit startup timeout, and starts cold well inside it", async () => {
+    const args = codexRoleMcpArgs({ run: "20261002-101500-auth", role: "verifier" });
+    expect(args).toContain("mcp_servers.catherd_role.required=true");
+    expect(args).toContain(`mcp_servers.catherd_role.startup_timeout_sec=${ROLE_MCP_STARTUP_SEC}`);
+    expect(ROLE_MCP_STARTUP_SEC).toBe(30);
+    const start = await probeRoleServer();
+    expect(start).toMatchObject({ ok: true });
+    if (start.ok) expect(start.ms).toBeLessThan((ROLE_MCP_STARTUP_SEC * 1000) / 2);
+    expect(await probeRoleServer(1)).toEqual({ ok: false, error: "no answer in 1 ms" });
+  });
+});
+
 describe("dispatch-scoped role MCP", () => {
   it("exposes only each role's allowed tools", async () => {
     const { run } = freshRun();
@@ -61,10 +75,11 @@ describe("dispatch-scoped role MCP", () => {
       expect((await call(client, "read_run_file", { run: other.id, path: "plan.md" })).error?.code).toBe(
         "E_INPUT_INVALID",
       );
-      expect((await call(client, "read_knowledge", { repo: other.meta.repo })).error?.code).toBe(
-        "E_INPUT_INVALID",
-      );
-      expect((await call(client, "read_knowledge", { repo })).isError).toBe(false);
+      // #42 finding 4: read_knowledge reads the run's own repository, whatever repo it is given
+      const own = (await call(client, "read_knowledge", { repo })).raw;
+      expect((await call(client, "read_knowledge", {})).raw).toBe(own);
+      expect((await call(client, "read_knowledge", { repo: "." })).raw).toBe(own);
+      expect((await call(client, "read_knowledge", { repo: other.meta.repo })).raw).toBe(own);
       for (const path of ["state.md", "../outside.md"])
         expect(
           (await call(client, "write_run_file", { run: run.id, path, content: "blocked" })).error?.code,
diff --git a/test/services/doctor-role-mcp.test.ts b/test/services/doctor-role-mcp.test.ts
new file mode 100644
index 0000000..216658c
--- /dev/null
+++ b/test/services/doctor-role-mcp.test.ts
@@ -0,0 +1,58 @@
+import { describe, expect, it } from "bun:test";
+import {
+  applyPatch,
+  defaultProfileDoc,
+  type ProfilePatch,
+  resolveProfile,
+} from "../../src/domain/profile.ts";
+import { validateProfile } from "../../src/domain/profile-rules.ts";
+import { roleMcpChecks } from "../../src/services/doctor-role-mcp.ts";
+import { withStandIns } from "../../src/services/standins.ts";
+import { shipped } from "../domain/shipped.ts";
+
+const profile = (patch: ProfilePatch = {}) =>
+  resolveProfile(applyPatch(defaultProfileDoc(), patch), "p", "claude-code");
+const isolated: ProfilePatch = { harness: { codex: { isolated: true }, "claude-code": { isolated: true } } };
+const headless: ProfilePatch = { roles: { verifier: { rungs: ["claude-code:claude-opus-5-5#low"] } } };
+const rows = (checks: ReturnType<typeof roleMcpChecks>) => checks.map((c) => [c.id, `${c.state} ${c.word}`]);
+
+describe("doctor's role server rows (spec 1.5 plan 21, #42 findings 6, 8)", () => {
+  it("covers only the profile it is given, one row per backend that runs a role server, isolated or not", () => {
+    expect(roleMcpChecks(null)).toEqual([]);
+    const expected = [
+      ["role-mcp:p:codex", "info configured"],
+      ["role-mcp:p:claude-code", "info configured"],
+    ];
+    expect(rows(roleMcpChecks(profile(headless)))).toEqual(expected);
+    // isolation used to fail this row, or skip it: the role server goes in either way now
+    expect(rows(roleMcpChecks(profile({ ...headless, ...isolated })))).toEqual(expected);
+  });
+
+  it("says how long a cold start took, warns past half of Codex's 30 s, and fails a server that does not start", () => {
+    const [ok] = roleMcpChecks(profile(), { ok: true, ms: 412.4 });
+    expect(ok).toMatchObject({ state: "info", word: "configured" });
+    expect(ok?.detail).toEndWith("Starts in 412 ms (limit 30 s).");
+    expect(roleMcpChecks(profile(), { ok: true, ms: 16_000 })[0]).toMatchObject({
+      state: "warn",
+      word: "slow start",
+      detail: "the role server took 16000 ms to start; Codex gives it 30 s and stops the role when it misses",
+    });
+    expect(roleMcpChecks(profile(), { ok: false, error: "no answer in 30000 ms" })[0]).toMatchObject({
+      state: "fail",
+      word: "no start",
+      detail: "the role server did not start: no answer in 30000 ms",
+    });
+  });
+
+  it("profile validate says nothing about isolation and the role server", () => {
+    const check = (patch: ProfilePatch) =>
+      validateProfile(
+        profile(patch),
+        withStandIns(shipped()),
+        ["codex", "claude-code", "opencode", "claude"],
+        undefined,
+        "claude-code",
+      );
+    expect(check({ ...headless, ...isolated })).toEqual(check(headless));
+  });
+});
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/entry/role-mcp.test.ts test/services/doctor-role-mcp.test.ts test/services/doctor.test.ts test/domain/verifier-prompt.test.ts test/domain/agents.test.ts`
Expected: FAIL. `role-mcp.test.ts` fails to import `probeRoleServer`/`ROLE_MCP_STARTUP_SEC` and on `read_knowledge` with another repo; `doctor-role-mcp.test.ts` fails on the isolated rows and the start probe; `verifier-prompt.test.ts` fails on the CLI fallback lines.

- [ ] **Step 3: Implement**

````diff
diff --git a/docs/dev/reports/role-access-orchestration-wait-pr.md b/docs/dev/reports/role-access-orchestration-wait-pr.md
deleted file mode 100644
index 9285127..0000000
--- a/docs/dev/reports/role-access-orchestration-wait-pr.md
+++ /dev/null
@@ -1,33 +0,0 @@
-# Role access and orchestration wait review
-
-Title: fix: provide role MCP access and bounded orchestration waits
-
-## Problem and behavior
-
-Headless architects can be denied catherd's run-file tools despite having read-only project access. Native
-Codex orchestration can also stop between phases after a completion notice is accepted by the queue; acceptance
-does not establish that a new turn started or the result was collected.
-
-Native headless Codex and Claude Code roles receive a dedicated `catherd_role` MCP server and explicit access
-to catherd's role tools. Project access restrictions remain in place; user configuration and profiles are not
-rewritten. Required MCP roles with isolated harnesses fail before launch. Native Claude subagents keep their
-plugin tool namespace.
-
-Codex orchestration dispatches independent roles first, then uses bounded `wait` calls and collects completed
-records with `result` before advancing. Status exposes unread results awaiting the orchestrator. Claude Code
-retains its push flow, and duplicate queued notices retain their existing idempotent handling.
-
-## Validation and limits
-
-- Final source review covered role tool permissions, run/repository binding, dependency layers,
-  failover publication, cancellation and unread-result cache recovery. `git diff --check` passed.
-- After the owner authorized a lightweight local gate, typecheck, lint and format checking passed.
-  Focused tests cover the affected services, adapters, MCP surface, CLI and TUI; the two doctor
-  expectations affected by the new diagnostic were updated and passed on recheck.
-  Nine new regressions passed for bounded waiting, cancellation, linked failover, no collection or
-  ownership mutation, role tool sets and run/repository/path restrictions.
-  TUI frames were regenerated per CONTRIBUTING.md and remained unchanged.
-- Native host wake behavior, packaged acceptance and performance gains have not been demonstrated.
-- The full test suite and packaged native Codex/Claude acceptance remain outstanding. CONTRIBUTING.md holds this
-  feature's release and forbids triggering or re-enabling CI for this work.
-- Per-host custom ladders, plan-width guardrails, cheaper fix-round models and multi-repo support are outside this PR.
diff --git a/src/domain/role-prompts.ts b/src/domain/role-prompts.ts
index 36a6df9..493d851 100644
--- a/src/domain/role-prompts.ts
+++ b/src/domain/role-prompts.ts
@@ -5,8 +5,14 @@ import type { Role } from "./roles.ts";
 // The role prompts of the native Claude subagents, ported from 0.x (spec D9). Headless backends get the
 // same text from the orchestrator's briefs; only native agents carry it in their agent file.
 
-const RUN_FILES =
-  "The run folder is outside the project. Read and write it only through the catherd MCP tools read_run_file and write_run_file, with the run id the orchestrator gave you. Native headless Codex and Claude Code roles use mcp__catherd_role__<name>; native Claude subagents use mcp__plugin_catherd_catherd__<name>. Use the tools exposed in your harness. Paths are relative to the run folder.";
+/**
+ * How a role reaches its run folder, naming only the tools that role gets (spec 1.5 plan 21, #42 finding 5): every
+ * role reads, the architect and the researcher also write. The CLI forms are the fallback when no tool is listed.
+ */
+const runFiles = (writes: boolean): string =>
+  writes
+    ? "The run folder is outside the project. Read and write it only through catherd's read_run_file and write_run_file, with the run id the orchestrator gave you (native Claude subagents: mcp__plugin_catherd_catherd__<name>; headless Codex and Claude Code roles: mcp__catherd_role__<name>). When neither is listed, run catherd run-file read <run> <path>, and catherd run-file write <run> <path> with the content on stdin. Paths are relative to the run folder."
+    : "The run folder is outside the project. Read it only through catherd's read_run_file, with the run id the orchestrator gave you (native Claude subagents: mcp__plugin_catherd_catherd__read_run_file; headless Codex and Claude Code roles: mcp__catherd_role__read_run_file). When neither is listed, run catherd run-file read <run> <path>. Paths are relative to the run folder.";
 
 const REPLY =
   "Do not commit. Reply in at most 15 lines: results, file:line, and evidence as a log path, not the log. The last line of your reply is: STATUS: complete|partial|blocked|refused — <one line why>";
@@ -14,7 +20,7 @@ const REPLY =
 const architect = [
   "You are the architect of a catherd run. The orchestrator gave you the goal, the acceptance lines, the run id, and usually a dossier: a researcher's map of the code this work touches. Workers are other models that run in the project directory with no memory of this conversation. They will write every line of code from your plan.",
   "",
-  `Start from the dossier. Open a project file yourself only to settle a decision the dossier leaves open, and read each file once. Bash is for inspection only. Change nothing in the project. ${RUN_FILES}`,
+  `Start from the dossier. Open a project file yourself only to settle a decision the dossier leaves open, and read each file once. Bash is for inspection only. Change nothing in the project. ${runFiles(true)}`,
   "",
   "When the acceptance lines include plan: <path>[, <path>…], the user already has a plan and there is no dossier. Translate it, do not design: each plan task becomes lanes, each merge request or phase a milestone with its full check. Copy the plan's decisions into plan.md and the lane files, and decide only what the plan leaves undecided.",
   "",
@@ -57,6 +63,7 @@ const verifier = [
   "1. Run the check command once. Report its exit code and the failing lines. When the check has several gate items (suites, lint, builds, a boot check):",
   "   - Before each item, call the catherd MCP tool gate_check (mcp__catherd_role__gate_check for native headless Codex/Claude Code roles; mcp__plugin_catherd_catherd__gate_check for native Claude subagents) with the run id, the milestone you verify (M1, as your brief names it), the item, its command and the repo paths it depends on. When it answers carried: true, do not run the item: report it as carried over from its commit. It also tells the orchestrator which step you are on.",
   "   - After an item passes, call gate_pass (mcp__catherd_role__gate_pass, or mcp__plugin_catherd_catherd__gate_pass for native Claude subagents) with the same item, command and paths, and the evidence.",
+  "   - When neither tool is listed, run the same from your shell: catherd gate check <run> --milestone <M> --item <item> --command <command> --paths <path,…>, then catherd gate pass <run> --item <item> --command <command> --paths <path,…> --evidence <evidence>.",
   "   - Run independent items side by side, each heavy one wrapped in catherd lock, which queues them within the machine's slots.",
   "   - Build each commit's images once, and reuse them for the boot check and the acceptance suite.",
   "2. Exercise every acceptance line through the real entry point: the CLI, the HTTP route, the page. Read source only to find that entry point. When a line needs data or files, build them in a temporary directory outside the project.",
@@ -76,7 +83,7 @@ const worker = (version: string) =>
   [
     "You are a worker in a catherd run. The orchestrator's message is your brief: the acceptance lines, the lane file to read, the files you own and the files you must not touch, and your fast check.",
     "",
-    `Read your lane file first. ${RUN_FILES} If the project has a CLAUDE.md or AGENTS.md, follow it.`,
+    `Read your lane file first. ${runFiles(false)} If the project has a CLAUDE.md or AGENTS.md, follow it.`,
     "",
     `Change only the files you own. Run your fast check until it passes. Run the full suite only if the brief says so, and wrap any full build or full test suite in: bunx catherd-cli@${version} lock -- <command>. Other lanes share this machine.`,
     "",
@@ -124,7 +131,7 @@ const writer = [
 const researcher = [
   "You answer a factual question about the code, or map it for a dossier. Change nothing in the project. Give file:line for every claim.",
   "",
-  `A dossier lists: the files and folders involved, one line each on what they hold; the existing patterns the work should copy, by path; the build, test and run commands, with how long the full suite takes when the docs, the CI config or a log say so (never run the suite to find out; write "unknown" instead); the lint and type-check commands, and how to scope each to one package; the symbols the change will call or alter, with their signatures; the project rules (CLAUDE.md, AGENTS.md, conventions) that bind this work; and risks: shared files, generated code, slow or flaky tests. It may run to 200 lines. Write it with write_run_file to the path the brief names, and reply with that path. ${RUN_FILES}`,
+  `A dossier lists: the files and folders involved, one line each on what they hold; the existing patterns the work should copy, by path; the build, test and run commands, with how long the full suite takes when the docs, the CI config or a log say so (never run the suite to find out; write "unknown" instead); the lint and type-check commands, and how to scope each to one package; the symbols the change will call or alter, with their signatures; the project rules (CLAUDE.md, AGENTS.md, conventions) that bind this work; and risks: shared files, generated code, slow or flaky tests. It may run to 200 lines. Write it with write_run_file to the path the brief names, and reply with that path. ${runFiles(true)}`,
   "",
   "For a single question, reply in at most 15 lines. The last line of your reply is: STATUS: complete|partial|blocked|refused — <one line why>",
 ].join("\n");
diff --git a/src/domain/role-tools.ts b/src/domain/role-tools.ts
index 189e017..838f0e6 100644
--- a/src/domain/role-tools.ts
+++ b/src/domain/role-tools.ts
@@ -14,7 +14,3 @@ export function roleMcpTools(role: Role): string[] {
   if (role === "verifier") tools.push("gate_check", "gate_pass");
   return tools;
 }
-
-/** These role prompts require artifacts or gate records to complete their work. */
-export const roleRequiresMcp = (role: Role): boolean =>
-  role === "architect" || role === "researcher" || role === "worker" || role === "verifier";
diff --git a/src/entry/doctor-command.ts b/src/entry/doctor-command.ts
index 231dda2..1ba0d25 100644
--- a/src/entry/doctor-command.ts
+++ b/src/entry/doctor-command.ts
@@ -6,6 +6,7 @@ import { type DoctorReport, doctor } from "../services/doctor.ts";
 import type { Check } from "../services/doctor-checks.ts";
 import { EXIT, JSON_ARG, mark, printJson } from "./cli-kit.ts";
 import { mcpHandshake } from "./mcp/handshake.ts";
+import { probeRoleServer } from "../infra/role-mcp.ts";
 
 /**
  * One row per check: `✓ ready  Bun — 1.4.2`, then the full fix on its own line; a fix of several lines
@@ -51,6 +52,7 @@ export const doctorCommand = defineCommand({
       bunVersion: Bun.version,
       version: VERSION,
       handshake: () => mcpHandshake(),
+      roleServerStart: () => probeRoleServer(),
       testPush: args["test-push"] === true,
     });
     if (args.json) printJson(r);
diff --git a/src/entry/mcp/role-bin.ts b/src/entry/mcp/role-bin.ts
index 06b734d..3d28965 100644
--- a/src/entry/mcp/role-bin.ts
+++ b/src/entry/mcp/role-bin.ts
@@ -4,6 +4,12 @@ import { ROLES } from "../../domain/roles.ts";
 import { restoreTmpdir } from "../../infra/env.ts";
 import { startRoleMcpServer } from "./role-server.ts";
 
+if (process.argv[2] === "--probe") {
+  // doctor's start probe: the server's module graph is loaded by now (spec 1.5 plan 21)
+  console.log("ready");
+  process.exit(0);
+}
+
 try {
   const [role, run] = z.tuple([z.enum(ROLES), z.string().min(1)]).parse(process.argv.slice(2));
   restoreTmpdir(process.env);
diff --git a/src/entry/mcp/role-server.ts b/src/entry/mcp/role-server.ts
index 1507889..bab9662 100644
--- a/src/entry/mcp/role-server.ts
+++ b/src/entry/mcp/role-server.ts
@@ -52,11 +52,13 @@ export function buildRoleServer(context: RoleMcpContext, deps: Deps = defaultDep
   server.registerTool(
     "read_knowledge",
     {
-      description: "Read what past runs learned about this role's repository.",
-      inputSchema: { repo: z.literal(run.meta.repo) },
+      description:
+        "Read what past runs learned about this role's repository. Takes no argument: it reads the run's own repository.",
+      // #42 finding 4: `.`, the pwd or /tmp vs /private/tmp never matched a literal; any repo given is ignored
+      inputSchema: { repo: z.string().optional() },
       annotations: { readOnlyHint: true, openWorldHint: false },
     },
-    (a) => call("read_knowledge", () => readKnowledge(a.repo)),
+    () => call("read_knowledge", () => readKnowledge(run.meta.repo)),
   );
   if (tools.has("write_run_file"))
     server.registerTool(
diff --git a/src/infra/role-mcp.ts b/src/infra/role-mcp.ts
index 5cfa909..496dcb2 100644
--- a/src/infra/role-mcp.ts
+++ b/src/infra/role-mcp.ts
@@ -1,9 +1,43 @@
 import { fileURLToPath } from "node:url";
 import { type RoleMcpContext, ROLE_MCP_SERVER, roleMcpTools } from "../domain/role-tools.ts";
+import { scrubSecrets } from "./env.ts";
 import { configDir, dataDir } from "./paths.ts";
 
 export const ROLE_MCP_ENTRY = fileURLToPath(new URL("../entry/mcp/role-bin.ts", import.meta.url));
 
+/** How long Codex waits for the role server to start (spec 1.5 plan 21, #42 finding 8). */
+export const ROLE_MCP_STARTUP_SEC = 30;
+
+export type RoleServerStart = { ok: true; ms: number } | { ok: false; error: string };
+
+/**
+ * Doctor's probe: a cold start of the role server's entry, which loads the server's whole module graph and
+ * exits (`--probe`), timed against the startup timeout. Never a model turn.
+ */
+export async function probeRoleServer(timeoutMs = ROLE_MCP_STARTUP_SEC * 1000): Promise<RoleServerStart> {
+  const started = performance.now();
+  const p = Bun.spawn([process.execPath, ROLE_MCP_ENTRY, "--probe"], {
+    stdin: "ignore",
+    stdout: "pipe",
+    stderr: "pipe",
+    env: { ...scrubSecrets(process.env), CATHERD_NO_SYNC: "1" },
+  });
+  const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
+  try {
+    const code = await p.exited;
+    const ms = performance.now() - started;
+    const out = await new Response(p.stdout).text();
+    if (code === 0 && out.trim() === "ready") return { ok: true, ms };
+    const err = (await new Response(p.stderr).text()).trim().split("\n").at(-1);
+    return {
+      ok: false,
+      error: p.signalCode === "SIGKILL" ? `no answer in ${timeoutMs} ms` : err || `exit ${code}`,
+    };
+  } finally {
+    clearTimeout(timer);
+  }
+}
+
 /** Launch the same installed package as the dispatching process, without resolving another release. */
 export function roleMcpConfig(context: RoleMcpContext): {
   command: string;
@@ -25,7 +59,9 @@ export function codexRoleMcpArgs(context: RoleMcpContext): string[] {
     `${prefix}.args=${JSON.stringify(config.args)}`,
     ...Object.entries(config.env).map(([key, value]) => `${prefix}.env.${key}=${JSON.stringify(value)}`),
     `${prefix}.enabled=true`,
+    // required: a role without its run tools cannot work; doctor's probe shows it starts well inside the timeout
     `${prefix}.required=true`,
+    `${prefix}.startup_timeout_sec=${ROLE_MCP_STARTUP_SEC}`,
     `${prefix}.enabled_tools=${JSON.stringify(roleMcpTools(context.role))}`,
     ...roleMcpTools(context.role).map((tool) => `${prefix}.tools.${tool}.approval_mode="approve"`),
   ];
diff --git a/src/services/doctor-role-mcp.ts b/src/services/doctor-role-mcp.ts
index 669a1c8..4bd15e9 100644
--- a/src/services/doctor-role-mcp.ts
+++ b/src/services/doctor-role-mcp.ts
@@ -1,72 +1,65 @@
-import { existsSync } from "node:fs";
 import { tryParseRung } from "../domain/ids.ts";
 import type { Profile } from "../domain/profile.ts";
-import { roleMcpTools, roleRequiresMcp } from "../domain/role-tools.ts";
+import { roleMcpTools } from "../domain/role-tools.ts";
 import { ROLES } from "../domain/roles.ts";
-import { ROLE_MCP_ENTRY } from "../infra/role-mcp.ts";
+import { ROLE_MCP_STARTUP_SEC, type RoleServerStart } from "../infra/role-mcp.ts";
 import { standInFor } from "./backends.ts";
 import type { Check } from "./doctor-checks.ts";
 
-/** Static configuration only: no model turn, scratch run or tool invocation. */
-export function roleMcpChecks(profiles: Profile[]): Check[] {
+/**
+ * The active profile's role server, per backend that runs one (codex, claude-code), isolated or not (spec 1.5
+ * plan 21, #42 finding 6): the roles that get it and their tools, and, when doctor probed it, how long a cold
+ * start took against Codex's startup timeout. A start past half that timeout warns: on a loaded machine Codex,
+ * which requires the server, would abort the role.
+ */
+export function roleMcpChecks(profile: Profile | null, start?: RoleServerStart): Check[] {
+  if (!profile) return [];
   const checks: Check[] = [];
-  for (const profile of profiles) {
-    for (const backend of ["codex", "claude-code"] as const) {
-      const uses = (rung: string) => tryParseRung(rung)?.backend === backend;
-      const roles = ROLES.filter((role) => {
-        const configured = profile.roles[role];
-        return (
-          configured.enabled &&
-          configured.rungs.some((rung) => {
-            const failover = standInFor(profile.failover, rung);
-            return uses(rung) || (failover !== null && uses(failover));
-          })
-        );
+  for (const backend of ["codex", "claude-code"] as const) {
+    const uses = (rung: string) => tryParseRung(rung)?.backend === backend;
+    const roles = ROLES.filter((role) => {
+      const configured = profile.roles[role];
+      return (
+        configured.enabled &&
+        configured.rungs.some((rung) => {
+          const failover = standInFor(profile.failover, rung);
+          return uses(rung) || (failover !== null && uses(failover));
+        })
+      );
+    });
+    if (!roles.length) continue;
+    const base = { id: `role-mcp:${profile.name}:${backend}`, label: `${profile.name} ${backend} role MCP` };
+    const tools = [...new Set(roles.flatMap(roleMcpTools))];
+    const configured = `${roles.join(", ")}: scoped catherd_role exposes ${tools.join(", ")}; ${backend === "codex" ? "per-tool approval_mode=approve" : "exact MCP tool allowlist"}. Model invocation not tested; managed policy may still deny tools.`;
+    const limit = ROLE_MCP_STARTUP_SEC * 1000;
+    if (start && !start.ok) {
+      checks.push({
+        ...base,
+        state: "fail",
+        word: "no start",
+        detail: `the role server did not start: ${start.error}`,
+        fix: "reinstall catherd at this version, then run catherd doctor again",
       });
-      if (!roles.length) continue;
-      const base = {
-        id: `role-mcp:${profile.name}:${backend}`,
-        label: `${profile.name} ${backend} role MCP`,
-      };
-      const isolated = profile.harness[backend]?.isolated ?? false;
-      const blocked = isolated ? roles.filter(roleRequiresMcp) : [];
-      if (blocked.length) {
-        checks.push({
-          ...base,
-          state: "fail",
-          word: "isolated",
-          detail: `${blocked.join(", ")} require run artifact or gate tools, unavailable in isolated mode`,
-          fix: `Set harness.${backend}.isolated to false for profile ${profile.name}, or select a supported native role backend.`,
-        });
-        continue;
-      }
-      if (isolated) {
-        checks.push({
-          ...base,
-          state: "skip",
-          word: "isolated",
-          detail: "role MCP is not injected in isolated mode",
-        });
-        continue;
-      }
-      if (!existsSync(ROLE_MCP_ENTRY)) {
-        checks.push({
-          ...base,
-          state: "fail",
-          word: "missing",
-          detail: "role MCP entry point is missing from this installation",
-          fix: "Reinstall catherd at this version.",
-        });
-        continue;
-      }
-      const tools = [...new Set(roles.flatMap(roleMcpTools))];
+      continue;
+    }
+    if (start?.ok && start.ms > limit / 2) {
       checks.push({
         ...base,
-        state: "info",
-        word: "configured",
-        detail: `${roles.join(", ")}: scoped catherd_role exposes ${tools.join(", ")}; ${backend === "codex" ? "per-tool approval_mode=approve" : "exact MCP tool allowlist"}. Model invocation not tested; managed policy may still deny tools.`,
+        state: "warn",
+        word: "slow start",
+        detail: `the role server took ${Math.round(start.ms)} ms to start; Codex gives it ${ROLE_MCP_STARTUP_SEC} s and stops the role when it misses`,
+        fix: "install catherd globally (catherd init) so roles start it without resolving a package, and check the machine's load",
       });
+      continue;
     }
+    checks.push({
+      ...base,
+      state: "info",
+      word: "configured",
+      detail: start?.ok
+        ? `${configured} Starts in ${Math.round(start.ms)} ms (limit ${ROLE_MCP_STARTUP_SEC} s).`
+        : configured,
+    });
   }
   return checks;
 }
diff --git a/src/services/doctor.ts b/src/services/doctor.ts
index 5b9910e..de1d8d5 100644
--- a/src/services/doctor.ts
+++ b/src/services/doctor.ts
@@ -7,6 +7,7 @@ import { BUILTIN_ROLES, type Profile } from "../domain/profile.ts";
 import { DEFAULT_ACCESS, ROLES } from "../domain/roles.ts";
 import { bunTooOld, MIN_BUN } from "../domain/runtime.ts";
 import type { JevTransport } from "../infra/jev-client.ts";
+import type { RoleServerStart } from "../infra/role-mcp.ts";
 import { linkedProfiles } from "./agent-links.ts";
 import { accessChecks } from "./doctor-access.ts";
 import { backendChecks, usedBackends } from "./doctor-backends.ts";
@@ -69,6 +70,8 @@ export interface DoctorDeps {
   testPush?: boolean;
   env?: Record<string, string | undefined>;
   jev?: JevTransport;
+  /** spec 1.5 plan 21: a cold start of the role server, timed; absent, doctor does not probe it */
+  roleServerStart?: () => Promise<RoleServerStart>;
 }
 
 /**
@@ -171,7 +174,7 @@ export async function doctor(d: DoctorDeps): Promise<DoctorReport> {
   const used = usedBackends(profiles);
   const installed = new Set<string>();
   checks.push(...(await backendChecks(used, profiles, installed, d.host.host)));
-  checks.push(...roleMcpChecks(profiles));
+  checks.push(...roleMcpChecks(active, await d.roleServerStart?.()));
 
   if (active && [active, ...profiles].every((p) => p.jev.use === "off"))
     checks.push({
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun run format && bun test test/entry/role-mcp.test.ts test/services/doctor-role-mcp.test.ts test/services/doctor.test.ts test/domain/verifier-prompt.test.ts test/domain/agents.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS (73 pass, 0 fail, 5 files).

- [ ] **Step 5: Commit**

````bash
git add -A docs/dev/reports/role-access-orchestration-wait-pr.md src/domain/role-prompts.ts src/domain/role-tools.ts src/entry/doctor-command.ts src/entry/mcp/role-bin.ts src/entry/mcp/role-server.ts src/infra/role-mcp.ts src/services/doctor-role-mcp.ts src/services/doctor.ts test/domain/verifier-prompt.test.ts test/entry/role-mcp.test.ts test/services/doctor-role-mcp.test.ts
git commit -m "fix(roles): role server fixes from the #42 review"
````

---

### Task 7: The brief carries the lane file, the role's scratch and its catherd tools (spec "The lane file reaches the worker" and "Per-role scratch" (the brief names it) bullets; Ruling 17)

`composeBrief(brief, ctx)` writes, in order: the orchestrator's text, the lane file as it stands at admission inside `<lane-file path="lanes/<id>.md">…</lane-file>` (header and body: an isolated headless worker can no longer miss its Owns), the role's notes (`catherd: you are <name> of run <run>.`, its scratch folder as `$TMPDIR` where the backend grants one, and its catherd tools, `mcp__catherd_role__…` with the CLI forms as fallback, or the CLI forms alone where the harness has no role server), then the reply contract. A failover stand-in that reruns an earlier brief gets the lane block and the notes once, the lane as it stands now. The backend sets move to `src/domain/role-tools.ts`. Every backend's dispatch test now expects `briefFor(...)`, a helper that builds the expected brief the way admission does; `brief.test.ts` pins the exact text.

**Files:**
- Modify: `plugin/skills/catherd/SKILL.md`
- Create: `src/domain/brief.ts`
- Modify: `src/domain/role-tools.ts`
- Modify: `src/services/admission.ts`
- Create: `test/domain/brief.test.ts`
- Test: `test/services/admission.test.ts`
- Test: `test/services/antigravity-dispatch.test.ts`
- Test: `test/services/claude-code-dispatch.test.ts`
- Test: `test/services/cursor-dispatch.test.ts`
- Test: `test/services/dispatch-protocol.test.ts`
- Test: `test/services/failover-cancel.test.ts`
- Test: `test/services/grok-dispatch.test.ts`
- Test: `test/services/helpers.ts`
- Test: `test/services/opencode-dispatch.test.ts`
- Test: `test/skills.test.ts`

**Interfaces:**
- Consumes: Task 1 (`roleScratch`, `scratch`), Task 4 (`roleServer`), Task 6 (`role-tools.ts` without `roleRequiresMcp`).
- Produces: `src/domain/brief.ts`: `interface BriefContext { run; name; role; lane: { id; text } | null; scratch: string | null; roleServer: boolean }`, `laneBlock(id, text)`, `roleNotes(ctx)`, `composeBrief(brief, ctx): string`. `src/domain/role-tools.ts`: `ROLE_SERVER_BACKENDS`, `SCRATCH_BACKENDS`. `test/services/helpers.ts`: `briefFor(run, text, { name?, role?, lane?, backend? })`.

**Scratch commit:** `f7ebb42` (feat(dispatch): the brief carries the lane file, the role's scratch and its tools).

- [ ] **Step 1: Write the failing tests**

````diff
diff --git a/test/domain/brief.test.ts b/test/domain/brief.test.ts
new file mode 100644
index 0000000..e9a4381
--- /dev/null
+++ b/test/domain/brief.test.ts
@@ -0,0 +1,69 @@
+import { describe, expect, it } from "bun:test";
+import { type BriefContext, composeBrief } from "../../src/domain/brief.ts";
+import { replyContract } from "../../src/domain/role-prompts.ts";
+
+const RUN = "20261002-101500-auth";
+const LANE =
+  "# M4.L1 — directory listing\nOwns: services/directory.go, services/internal_test.go\nFast check: go test ./services/...\nKind: repo_code\nDifficulty: build\n\nAdd the listing endpoint.\n";
+const worker: BriefContext = {
+  run: RUN,
+  name: "worker-M4.L1",
+  role: "worker",
+  lane: { id: "M4.L1", text: LANE },
+  scratch: `/data/repos/app-1/runs/${RUN}/scratch/worker-M4.L1`,
+  roleServer: true,
+};
+
+describe("what admission adds to a brief (spec 1.5 plan 21)", () => {
+  it("inlines the lane file, header and body, then the role's notes, then its reply contract", () => {
+    expect(composeBrief("Do lane M4.L1.", worker)).toBe(
+      [
+        "Do lane M4.L1.",
+        "",
+        "Your lane file, lanes/M4.L1.md, as it stood when you were dispatched:",
+        '<lane-file path="lanes/M4.L1.md">',
+        LANE.trimEnd(),
+        "</lane-file>",
+        "",
+        `catherd: you are worker-M4.L1 of run ${RUN}.`,
+        `Your scratch folder is /data/repos/app-1/runs/${RUN}/scratch/worker-M4.L1, which is your $TMPDIR: put temporary files, logs and builds there, never in /tmp. catherd removes it with the run, so anything the orchestrator must keep goes in your reply.`,
+        `Your catherd tools: mcp__catherd_role__read_run_file, mcp__catherd_role__read_knowledge. If they are not listed, run the same from your shell: catherd run-file read ${RUN} <path>; catherd knowledge show.`,
+        "",
+        replyContract("worker"),
+        "",
+      ].join("\n"),
+    );
+  });
+
+  it("gives a role with no role server its CLI forms, and names no scratch where the backend grants none", () => {
+    const text = composeBrief("Verify M1.", {
+      run: RUN,
+      name: "verifier-M1",
+      role: "verifier",
+      lane: null,
+      scratch: null,
+      roleServer: false,
+    });
+    expect(text).not.toContain("<lane-file");
+    expect(text).not.toContain("scratch folder");
+    expect(text).toContain(
+      `Your catherd commands, from your shell: catherd run-file read ${RUN} <path>; catherd knowledge show; catherd gate check ${RUN} --milestone <M> --item <item> --command <command> --paths <path,…>; catherd gate pass ${RUN} --item <item> --command <command> --paths <path,…> --evidence <evidence>.`,
+    );
+    expect(text).toEndWith(`${replyContract("verifier")}\n`);
+  });
+
+  it("writes each part once when a failover stand-in reruns an earlier brief, with the lane file as it stands now", () => {
+    const first = composeBrief("Do lane M4.L1.", worker);
+    expect(composeBrief(first, worker)).toBe(first);
+    const moved = {
+      ...worker,
+      lane: { id: "M4.L1", text: LANE.replace("Add the listing", "Add the paged listing") },
+    };
+    const again = composeBrief(first, moved);
+    expect(again.match(/<lane-file /g)).toHaveLength(1);
+    expect(again.match(/catherd: you are /g)).toHaveLength(1);
+    expect(again).toContain("Add the paged listing endpoint.");
+    expect(again).not.toContain("Add the listing endpoint.");
+    expect(again).toBe(composeBrief("Do lane M4.L1.", moved));
+  });
+});
diff --git a/test/services/admission.test.ts b/test/services/admission.test.ts
index fc1b1b5..8671a6b 100644
--- a/test/services/admission.test.ts
+++ b/test/services/admission.test.ts
@@ -13,7 +13,7 @@ import { latestDispatch } from "../../src/services/dispatches.ts";
 import { readRecords } from "../../src/services/run-store.ts";
 import { snapshotEnv } from "../helpers.ts";
 import { simPath, withScenario } from "../sim/scenario.ts";
-import { fakeDeps, fakeDispatch, fakeGit, freshRun, testView, writeLane } from "./helpers.ts";
+import { briefFor, fakeDeps, fakeDispatch, fakeGit, freshRun, testView, writeLane } from "./helpers.ts";
 
 afterEach(snapshotEnv());
 // a test that needs a backend with no adapter unregisters a real one (plan 17 Ruling X2)
@@ -60,7 +60,12 @@ describe("admission", () => {
       input({ brief: "--help me, do not read me as a flag" }),
     );
     expect(readFileSync(dispatchPaths(d.dir).brief, "utf8")).toBe(
-      `--help me, do not read me as a flag\n\n${replyContract("worker")}\n`,
+      briefFor(run, "--help me, do not read me as a flag"),
+    );
+    expect(readFileSync(dispatchPaths(d.dir).brief, "utf8")).toEndWith(`\n\n${replyContract("worker")}\n`);
+    // spec 1.5 plan 21: the lane file itself travels in the brief, so an isolated worker never guesses its Owns
+    expect(readFileSync(dispatchPaths(d.dir).brief, "utf8")).toContain(
+      '<lane-file path="lanes/M1.L1.md">\n# M1.L1 — test lane\nOwns: src/a.ts\nFast check: true\n',
     );
     expect(d.admit).toMatchObject({
       name: "worker-M1.L1",
diff --git a/test/services/antigravity-dispatch.test.ts b/test/services/antigravity-dispatch.test.ts
index debdfb5..1e20207 100644
--- a/test/services/antigravity-dispatch.test.ts
+++ b/test/services/antigravity-dispatch.test.ts
@@ -2,13 +2,12 @@ import { afterEach, beforeEach, describe, expect, it } from "bun:test";
 import { existsSync, readFileSync } from "node:fs";
 import { join } from "node:path";
 import { isolatedAgyHome } from "../../src/adapters/antigravity/index.ts";
-import { replyContract } from "../../src/domain/role-prompts.ts";
 import { resetReadiness } from "../../src/services/backends.ts";
 import { dispatch, type DispatchInput } from "../../src/services/dispatch-service.ts";
 import { snapshotEnv, tempDir } from "../helpers.ts";
 import { simPath } from "../sim/scenario.ts";
 import { type AgyScenario, withAgyScenario } from "../sim/sim-scenarios.ts";
-import { fakeDeps, freshRun, runRole, testView, writeLane } from "./helpers.ts";
+import { briefFor, fakeDeps, freshRun, runRole, testView, writeLane } from "./helpers.ts";
 
 afterEach(snapshotEnv());
 beforeEach(() => resetReadiness());
@@ -63,7 +62,7 @@ describe("dispatch on agy (simulator)", () => {
       seen.stdin,
     )?.[1];
     expect(readFileSync(brief as string, "utf8")).toBe(
-      `---\nRead lanes/M1.L1.md\n\n${replyContract("worker")}\n`,
+      briefFor(run, "---\nRead lanes/M1.L1.md", { backend: "antigravity" }),
     );
     expect(seen.args.slice(2)).toEqual([
       "--output-format",
diff --git a/test/services/claude-code-dispatch.test.ts b/test/services/claude-code-dispatch.test.ts
index 9327711..9f7c662 100644
--- a/test/services/claude-code-dispatch.test.ts
+++ b/test/services/claude-code-dispatch.test.ts
@@ -1,4 +1,3 @@
-import { replyContract } from "../../src/domain/role-prompts.ts";
 import { afterEach, beforeEach, describe, expect, it } from "bun:test";
 import { readFileSync } from "node:fs";
 import { join } from "node:path";
@@ -9,7 +8,7 @@ import { latestDispatch } from "../../src/services/dispatches.ts";
 import { snapshotEnv } from "../helpers.ts";
 import { simPath } from "../sim/scenario.ts";
 import { type ClaudeScenario, withClaudeScenario } from "../sim/sim-scenarios.ts";
-import { fakeDeps, freshRun, runRole, testView, writeLane } from "./helpers.ts";
+import { briefFor, fakeDeps, freshRun, runRole, testView, writeLane } from "./helpers.ts";
 
 afterEach(snapshotEnv());
 beforeEach(() => resetReadiness());
@@ -60,7 +59,7 @@ describe("dispatch on claude-code (simulator)", () => {
     });
     expect(hints).toEqual([]);
     expect(seen).toMatchObject({
-      stdin: `---\nRead lanes/M1.L1.md\n\n${replyContract("worker")}\n`,
+      stdin: briefFor(run, "---\nRead lanes/M1.L1.md", { backend: "claude-code" }),
       cwd: repo,
       pwd: repo,
     });
diff --git a/test/services/cursor-dispatch.test.ts b/test/services/cursor-dispatch.test.ts
index 6a1ad5e..398ec72 100644
--- a/test/services/cursor-dispatch.test.ts
+++ b/test/services/cursor-dispatch.test.ts
@@ -2,13 +2,12 @@ import { afterEach, beforeEach, describe, expect, it } from "bun:test";
 import { existsSync, readFileSync } from "node:fs";
 import { join } from "node:path";
 import { isolatedCursorHome } from "../../src/adapters/cursor/index.ts";
-import { replyContract } from "../../src/domain/role-prompts.ts";
 import { resetReadiness } from "../../src/services/backends.ts";
 import { dispatch, type DispatchInput } from "../../src/services/dispatch-service.ts";
 import { snapshotEnv } from "../helpers.ts";
 import { simPath } from "../sim/scenario.ts";
 import { type CursorScenario, withCursorScenario } from "../sim/sim-scenarios.ts";
-import { fakeDeps, freshRun, runRole, testView, writeLane } from "./helpers.ts";
+import { briefFor, fakeDeps, freshRun, runRole, testView, writeLane } from "./helpers.ts";
 
 afterEach(snapshotEnv());
 beforeEach(() => resetReadiness());
@@ -54,7 +53,7 @@ describe("dispatch on cursor-agent (simulator)", () => {
     });
     expect(record.thread).toMatch(/^[0-9a-f-]{36}$/);
     expect(sim.recorded()).toMatchObject({
-      stdin: `---\nRead lanes/M1.L1.md\n\n${replyContract("worker")}\n`,
+      stdin: briefFor(run, "---\nRead lanes/M1.L1.md", { backend: "cursor" }),
     });
     expect(sim.recorded().args).toEqual([
       "-p",
diff --git a/test/services/dispatch-protocol.test.ts b/test/services/dispatch-protocol.test.ts
index 33f671e..6b49134 100644
--- a/test/services/dispatch-protocol.test.ts
+++ b/test/services/dispatch-protocol.test.ts
@@ -10,7 +10,7 @@ import { route } from "../../src/services/lane-service.ts";
 import { readRoutes } from "../../src/services/run-store.ts";
 import { snapshotEnv } from "../helpers.ts";
 import { simPath, withScenario } from "../sim/scenario.ts";
-import { fakeDeps, freshRun, LADDER, writeLane } from "./helpers.ts";
+import { briefFor, fakeDeps, freshRun, LADDER, writeLane } from "./helpers.ts";
 
 afterEach(() => watchersSettled());
 afterEach(snapshotEnv());
@@ -56,9 +56,7 @@ describe("the reply contract (spec 1.1 §6)", () => {
       lane: "M1.L1",
     });
     const dir = join(run.dir, "roles", "worker-M1.L1", s.dispatched.dispatchId);
-    expect(readFileSync(dispatchPaths(dir).brief, "utf8")).toBe(
-      `Read lanes/M1.L1.md\n\n${replyContract("worker")}\n`,
-    );
+    expect(readFileSync(dispatchPaths(dir).brief, "utf8")).toBe(briefFor(run, "Read lanes/M1.L1.md"));
   });
 });
 
diff --git a/test/services/failover-cancel.test.ts b/test/services/failover-cancel.test.ts
index c71acdf..dda0d72 100644
--- a/test/services/failover-cancel.test.ts
+++ b/test/services/failover-cancel.test.ts
@@ -41,6 +41,7 @@ import { readNotes } from "../../src/services/state.ts";
 import { snapshotEnv } from "../helpers.ts";
 import { type CodexScenario, simPath, withScenario } from "../sim/scenario.ts";
 import {
+  briefFor,
   deadProcess,
   fakeDeps,
   fakeDispatch,
@@ -201,7 +202,7 @@ describe("failover (spec §3.4: it runs as soon as a limit is settled)", () => {
     const stand = latestDispatch(run, "worker-M1.L1");
     expect(stand?.admit.thread).toBeNull();
     expect(readFileSync(dispatchPaths(stand?.dir ?? "").brief, "utf8")).toBe(
-      `Read lanes/M1.L1.md\n\n${replyContract("worker")}\n`,
+      briefFor(run, "Read lanes/M1.L1.md"),
     );
   });
 
@@ -230,9 +231,7 @@ describe("failover (spec §3.4: it runs as soon as a limit is settled)", () => {
     const paths = [...brief.matchAll(/: (\/\S+)/g)].map((m) => m[1] as string);
     expect(paths).toHaveLength(2);
     for (const p of paths) expect(existsSync(p)).toBe(true);
-    expect(readFileSync(paths[1] as string, "utf8")).toBe(
-      `Fix: BUG src/a.ts:3 — off by one\n\n${replyContract("worker")}\n`,
-    );
+    expect(readFileSync(paths[1] as string, "utf8")).toBe(briefFor(run, "Fix: BUG src/a.ts:3 — off by one"));
     // spec 1.1 §6: the stand-in's own brief carries the reply contract too
     expect(brief).toEndWith(`${replyContract("worker")}\n`);
   });
diff --git a/test/services/grok-dispatch.test.ts b/test/services/grok-dispatch.test.ts
index c5f7f8e..dea14ae 100644
--- a/test/services/grok-dispatch.test.ts
+++ b/test/services/grok-dispatch.test.ts
@@ -2,13 +2,12 @@ import { afterEach, beforeEach, describe, expect, it } from "bun:test";
 import { readFileSync, writeFileSync } from "node:fs";
 import { join } from "node:path";
 import { isolatedGrokRoot } from "../../src/adapters/grok/index.ts";
-import { replyContract } from "../../src/domain/role-prompts.ts";
 import { resetReadiness } from "../../src/services/backends.ts";
 import { dispatch, type DispatchInput } from "../../src/services/dispatch-service.ts";
 import { snapshotEnv, tempDir } from "../helpers.ts";
 import { simPath } from "../sim/scenario.ts";
 import { type GrokScenario, withGrokScenario } from "../sim/sim-scenarios.ts";
-import { fakeDeps, freshRun, runRole, testView, writeLane } from "./helpers.ts";
+import { briefFor, fakeDeps, freshRun, runRole, testView, writeLane } from "./helpers.ts";
 
 afterEach(snapshotEnv());
 beforeEach(() => resetReadiness());
@@ -61,7 +60,7 @@ describe("dispatch on grok (simulator)", () => {
       changedOwned: ["src/a.ts"],
       cliVersion: "1.0.44",
     });
-    expect(sim.recorded().stdin).toBe(`---\nRead lanes/M1.L1.md\n\n${replyContract("worker")}\n`);
+    expect(sim.recorded().stdin).toBe(briefFor(run, "---\nRead lanes/M1.L1.md", { backend: "grok" }));
     expect(args.slice(0, -2)).toEqual([
       "--prompt-file",
       args[1] as string,
diff --git a/test/services/helpers.ts b/test/services/helpers.ts
index 53e6fbf..e1c0fcc 100644
--- a/test/services/helpers.ts
+++ b/test/services/helpers.ts
@@ -1,5 +1,8 @@
 import type { HostContext } from "../../src/domain/host.ts";
-import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
+import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
+import { composeBrief } from "../../src/domain/brief.ts";
+import type { Role } from "../../src/domain/roles.ts";
+import { ROLE_SERVER_BACKENDS, SCRATCH_BACKENDS } from "../../src/domain/role-tools.ts";
 import { tmpdir } from "node:os";
 import { join } from "node:path";
 import { newDispatchId, parseRung } from "../../src/domain/ids.ts";
@@ -9,7 +12,14 @@ import { dispatchPaths } from "../../src/infra/dispatch-dir.ts";
 import { processStartTime } from "../../src/infra/proc.ts";
 import { writeJsonAtomic } from "../../src/infra/store.ts";
 import { dispatch, type DispatchInput, watchersSettled } from "../../src/services/dispatch-service.ts";
-import { type Admit, admitPath, type Dispatch, roleDir, setLatest } from "../../src/services/dispatches.ts";
+import {
+  type Admit,
+  admitPath,
+  type Dispatch,
+  roleDir,
+  scratchDir,
+  setLatest,
+} from "../../src/services/dispatches.ts";
 import type { Deps, ProfilePort, ProfileView, RoutingPort } from "../../src/services/ports.ts";
 import { result } from "../../src/services/run-service.ts";
 import { appendAgentRun, appendRecord, createRun, type Run, runPaths } from "../../src/services/run-store.ts";
@@ -18,6 +28,31 @@ import { tempRepo, withHome } from "../helpers.ts";
 
 export { makeRecord } from "../domain/make-record.ts";
 
+/**
+ * The brief admission writes for `text` (spec 1.5 plan 21): the lane file inlined, the role's notes, its reply
+ * contract. `backend` decides the scratch folder and the role server, as admission does.
+ */
+export function briefFor(
+  run: Run,
+  text: string,
+  o: { name?: string; role?: Role; lane?: string | null; backend?: string } = {},
+): string {
+  const name = o.name ?? "worker-M1.L1";
+  const lane = o.lane === undefined ? "M1.L1" : o.lane;
+  const backend = o.backend ?? "codex";
+  return composeBrief(text, {
+    run: run.id,
+    name,
+    role: o.role ?? "worker",
+    lane:
+      lane === null
+        ? null
+        : { id: lane, text: readFileSync(join(runPaths(run.dir).lanes, `${lane}.md`), "utf8") },
+    scratch: SCRATCH_BACKENDS.includes(backend) ? realpathSync(scratchDir(run, name)) : null,
+    roleServer: ROLE_SERVER_BACKENDS.includes(backend),
+  });
+}
+
 export const LADDER = [
   "codex:gpt-6-luna#high",
   "codex:gpt-6-sol#medium",
diff --git a/test/services/opencode-dispatch.test.ts b/test/services/opencode-dispatch.test.ts
index f8e921b..65768c8 100644
--- a/test/services/opencode-dispatch.test.ts
+++ b/test/services/opencode-dispatch.test.ts
@@ -1,4 +1,3 @@
-import { replyContract } from "../../src/domain/role-prompts.ts";
 import { afterEach, beforeEach, describe, expect, it } from "bun:test";
 import { existsSync, mkdtempSync, readFileSync } from "node:fs";
 import { tmpdir } from "node:os";
@@ -11,7 +10,7 @@ import { readRecords } from "../../src/services/run-store.ts";
 import { snapshotEnv } from "../helpers.ts";
 import { simPath } from "../sim/scenario.ts";
 import { type OpencodeModel, type OpencodeScenario, withOpencodeScenario } from "../sim/sim-scenarios.ts";
-import { fakeDeps, freshRun, runRole, testView, writeLane } from "./helpers.ts";
+import { briefFor, fakeDeps, freshRun, runRole, testView, writeLane } from "./helpers.ts";
 
 afterEach(snapshotEnv());
 beforeEach(() => {
@@ -67,7 +66,7 @@ describe("dispatch on opencode v2 (simulator)", () => {
       cliVersion: "2.0.16",
     });
     expect(sim.recorded()).toMatchObject({
-      stdin: `---\nRead lanes/M1.L1.md\n\n${replyContract("worker")}\n`,
+      stdin: briefFor(run, "---\nRead lanes/M1.L1.md", { backend: "opencode" }),
       pwd: repo,
     });
     expect(sim.recorded().args).toEqual([
diff --git a/test/skills.test.ts b/test/skills.test.ts
index 32cd32e..b9499c9 100644
--- a/test/skills.test.ts
+++ b/test/skills.test.ts
@@ -106,6 +106,8 @@ describe("orchestrator skill", () => {
   it("leaves the reply contract, the routing and the land gate to the tools (spec 1.1 §6)", () => {
     const md = skill("catherd");
     expect(md).toContain("`dispatch` appends the role's reply contract to every brief");
+    // spec 1.5 plan 21
+    expect(md).toContain("with `lane`, `dispatch` inlines the lane file as it stands");
     expect(md).not.toContain('"Do not commit." Then the reply shape');
     expect(md).toContain("`dispatch` routes a lane you missed");
     for (const code of ["E_LANE_INVALID", "E_LAND_GATE", "E_CLIMB_DESIGN"]) expect(md).toContain(code);
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/domain/brief.test.ts test/services/admission.test.ts test/services/claude-code-dispatch.test.ts test/services/grok-dispatch.test.ts test/services/cursor-dispatch.test.ts test/services/antigravity-dispatch.test.ts test/services/opencode-dispatch.test.ts test/services/dispatch-protocol.test.ts test/services/failover-cancel.test.ts test/skills.test.ts`
Expected: FAIL. `brief.test.ts` fails to import `src/domain/brief.ts`; the admission test fails on the lane block.

- [ ] **Step 3: Implement**

````diff
diff --git a/plugin/skills/catherd/SKILL.md b/plugin/skills/catherd/SKILL.md
index b2898b0..7ffe244 100644
--- a/plugin/skills/catherd/SKILL.md
+++ b/plugin/skills/catherd/SKILL.md
@@ -343,6 +343,7 @@ The brief is the `brief` text you pass to `dispatch` (catherd writes it to the d
    The tool tops out around 1536×1024.
 
 8. Not the reply shape: `dispatch` appends the role's reply contract to every brief ("Do not commit", at most 15 lines, and the last line `STATUS: complete|partial|blocked|refused — <one line why>`), and a native Claude role's agent carries it.
+9. Not the lane file's text, the role's scratch folder or its catherd tools: with `lane`, `dispatch` inlines the lane file as it stands, and every brief names the role's `$TMPDIR` (`<run>/scratch/<name>/`) and how it reads its run's files.
 
 ## Reading results
 
diff --git a/src/domain/brief.ts b/src/domain/brief.ts
new file mode 100644
index 0000000..28419dd
--- /dev/null
+++ b/src/domain/brief.ts
@@ -0,0 +1,91 @@
+import { replyContract } from "./role-prompts.ts";
+import { ROLE_MCP_SERVER, roleMcpTools } from "./role-tools.ts";
+import type { Role } from "./roles.ts";
+
+/** What admission adds to a role's brief, besides its reply contract (spec 1.5 plan 21). */
+export interface BriefContext {
+  run: string;
+  name: string;
+  role: Role;
+  /** the lane file as it stands at admission, header and body */
+  lane: { id: string; text: string } | null;
+  /** the role's scratch folder, its TMPDIR, on a backend that grants it */
+  scratch: string | null;
+  /** whether the role's harness lists the catherd_role tools */
+  roleServer: boolean;
+}
+
+/** The CLI form of each role server tool, which any role can run from its shell. */
+function cliForm(tool: string, run: string): string {
+  switch (tool) {
+    case "read_run_file":
+      return `catherd run-file read ${run} <path>`;
+    case "write_run_file":
+      return `catherd run-file write ${run} <path> (the content on stdin)`;
+    case "read_knowledge":
+      return "catherd knowledge show";
+    case "gate_check":
+      return `catherd gate check ${run} --milestone <M> --item <item> --command <command> --paths <path,…>`;
+    case "gate_pass":
+      return `catherd gate pass ${run} --item <item> --command <command> --paths <path,…> --evidence <evidence>`;
+    default:
+      return tool;
+  }
+}
+
+const LANE_OPEN = (id: string) => `<lane-file path="lanes/${id}.md">`;
+const LANE_CLOSE = "</lane-file>";
+
+/**
+ * The lane file inlined (spec 1.5 plan 21): an isolated headless worker cannot read the run folder, so its Owns,
+ * fast check and body travel in the brief itself.
+ */
+export function laneBlock(id: string, text: string): string {
+  return [
+    `Your lane file, lanes/${id}.md, as it stood when you were dispatched:`,
+    LANE_OPEN(id),
+    text.trimEnd(),
+    LANE_CLOSE,
+  ].join("\n");
+}
+
+/** Who the role is, where its temp files go, and how it reaches its run's files and gate. */
+export function roleNotes(c: BriefContext): string {
+  const tools = roleMcpTools(c.role);
+  const lines = [`catherd: you are ${c.name} of run ${c.run}.`];
+  if (c.scratch)
+    lines.push(
+      `Your scratch folder is ${c.scratch}, which is your $TMPDIR: put temporary files, logs and builds there, never in /tmp. catherd removes it with the run, so anything the orchestrator must keep goes in your reply.`,
+    );
+  const cli = tools.map((t) => cliForm(t, c.run)).join("; ");
+  lines.push(
+    c.roleServer
+      ? `Your catherd tools: ${tools.map((t) => `mcp__${ROLE_MCP_SERVER}__${t}`).join(", ")}. If they are not listed, run the same from your shell: ${cli}.`
+      : `Your catherd commands, from your shell: ${cli}.`,
+  );
+  return lines.join("\n");
+}
+
+/**
+ * The brief admission writes: the orchestrator's text, the lane file, the role's notes, then its reply contract,
+ * each once. A failover stand-in that reruns an earlier brief gets the lane file as it stands now and its own notes,
+ * never two copies.
+ */
+export function composeBrief(brief: string, c: BriefContext): string {
+  const contract = replyContract(c.role);
+  let body = brief.trimEnd();
+  if (body.endsWith(contract)) body = body.slice(0, -contract.length).trimEnd();
+  if (c.lane) {
+    const open = LANE_OPEN(c.lane.id);
+    const start = body.lastIndexOf(open);
+    const end = body.indexOf(LANE_CLOSE, start);
+    if (start >= 0 && end >= 0) {
+      const lead = body.lastIndexOf("\n\n", start);
+      body = `${body.slice(0, lead >= 0 ? lead : start)}${body.slice(end + LANE_CLOSE.length)}`.trimEnd();
+    }
+  }
+  const notesStart = body.lastIndexOf("\n\ncatherd: you are ");
+  if (notesStart >= 0) body = body.slice(0, notesStart).trimEnd();
+  const parts = [body, ...(c.lane ? [laneBlock(c.lane.id, c.lane.text)] : []), roleNotes(c), contract];
+  return `${parts.filter(Boolean).join("\n\n")}\n`;
+}
diff --git a/src/domain/role-tools.ts b/src/domain/role-tools.ts
index 838f0e6..d5c34b2 100644
--- a/src/domain/role-tools.ts
+++ b/src/domain/role-tools.ts
@@ -7,6 +7,15 @@ export interface RoleMcpContext {
 
 export const ROLE_MCP_SERVER = "catherd_role";
 
+/** Spec 1.5 plan 21: the backends whose harness gets the role server, isolated or not. */
+export const ROLE_SERVER_BACKENDS: readonly string[] = ["codex", "claude-code"];
+
+/**
+ * Spec 1.5 plan 21: the backends whose sandbox catherd grants the role's scratch, so they get it as TMPDIR.
+ * Cursor, Grok and agy write their grants once per isolated home, not per dispatch: they keep the inherited one.
+ */
+export const SCRATCH_BACKENDS: readonly string[] = ["codex", "claude-code", "opencode"];
+
 /** Run artifacts and gate evidence have their own authority, independent of repository writes. */
 export function roleMcpTools(role: Role): string[] {
   const tools = ["read_run_file", "read_knowledge"];
diff --git a/src/services/admission.ts b/src/services/admission.ts
index 49ed1cb..6311513 100644
--- a/src/services/admission.ts
+++ b/src/services/admission.ts
@@ -7,7 +7,8 @@ import { CatherdError, errorMessage } from "../domain/errors.ts";
 import { assertId, formatRung, newDispatchId, parseRung } from "../domain/ids.ts";
 import { assertLaneHeader, overlaps } from "../domain/lane.ts";
 import type { RunRecord } from "../domain/record.ts";
-import { withReplyContract } from "../domain/role-prompts.ts";
+import { composeBrief } from "../domain/brief.ts";
+import { ROLE_SERVER_BACKENDS, SCRATCH_BACKENDS } from "../domain/role-tools.ts";
 import type { Role } from "../domain/roles.ts";
 import { formatRoleScope, ROLE_ENV } from "../domain/role-scope.ts";
 import { dispatchPaths, markForCollect } from "../infra/dispatch-dir.ts";
@@ -57,15 +58,9 @@ export const KILL_GRACE_MS = 10_000;
 
 export const laneFile = (run: Run, lane: string): string => join(runPaths(run.dir).lanes, `${lane}.md`);
 
-/**
- * Spec 1.5 plan 21: the backends whose sandbox catherd grants the role's scratch, so they get it as TMPDIR.
- * Cursor, Grok and agy write their grants once per isolated home, not per dispatch: they keep the inherited one.
- */
-const SCRATCH_BACKENDS = new Set(["codex", "claude-code", "opencode"]);
-
 /** The role's scratch folder, created (0700) and by its real path, on a backend that grants it; else null. */
 function roleScratch(run: Run, name: string, backend: string): string | null {
-  if (!SCRATCH_BACKENDS.has(backend)) return null;
+  if (!SCRATCH_BACKENDS.includes(backend)) return null;
   const dir = scratchDir(run, name);
   ensurePrivateDir(dir);
   return realpathSync(dir);
@@ -206,7 +201,7 @@ export async function admit(
   const isolated = started?.isolated ?? profile.isolated[rung.backend] ?? false;
   // spec 1.5 plan 21 (#42 findings 1, 2): the role server goes in whether the harness is isolated or not, so no
   // role is refused for isolation, and a thread an isolated run started resumes as it started
-  const roleServer = rung.backend === "codex" || rung.backend === "claude-code";
+  const roleServer = ROLE_SERVER_BACKENDS.includes(rung.backend);
   const scratch = roleScratch(run, i.name, rung.backend);
   await prepared(adapter, {
     rung,
@@ -296,8 +291,19 @@ export async function admit(
       ...(sessionId ? { sessionId, host: i.host ?? session?.host ?? "claude-code" } : {}),
     };
     ensurePrivateDir(dir);
-    // spec 1.1 §6: every brief ends with its role's reply contract, failover stand-ins' included
-    writeTextAtomic(p.brief, withReplyContract(i.role, i.brief));
+    // spec 1.1 §6: every brief ends with its role's reply contract, failover stand-ins' included; spec 1.5 plan 21:
+    // before it, the lane file as it stands now, and who the role is, its scratch and its catherd tools
+    writeTextAtomic(
+      p.brief,
+      composeBrief(i.brief, {
+        run: run.id,
+        name: i.name,
+        role: i.role,
+        lane: i.lane === null ? null : { id: i.lane, text: readFileSync(laneFile(run, i.lane), "utf8") },
+        scratch,
+        roleServer,
+      }),
+    );
     // Spec §10.4: the adapter's overrides only; the supervisor adds its own inherited env at spawn
     // time (src/entry/supervise-command.ts), so no credential is ever written to disk. 0600 all the same.
     writeJsonAtomic(
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun run format && bun test test/domain/brief.test.ts test/services/admission.test.ts test/services/claude-code-dispatch.test.ts test/services/grok-dispatch.test.ts test/services/cursor-dispatch.test.ts test/services/antigravity-dispatch.test.ts test/services/opencode-dispatch.test.ts test/services/dispatch-protocol.test.ts test/services/failover-cancel.test.ts test/skills.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS (94 pass, 0 fail, 10 files).

- [ ] **Step 5: Commit**

````bash
git add -A plugin/skills/catherd/SKILL.md src/domain/brief.ts src/domain/role-tools.ts src/services/admission.ts test/domain/brief.test.ts test/services/admission.test.ts test/services/antigravity-dispatch.test.ts test/services/claude-code-dispatch.test.ts test/services/cursor-dispatch.test.ts test/services/dispatch-protocol.test.ts test/services/failover-cancel.test.ts test/services/grok-dispatch.test.ts test/services/helpers.ts test/services/opencode-dispatch.test.ts test/skills.test.ts
git commit -m "feat(dispatch): the brief carries the lane file, the role's scratch and its tools"
````

---

### Task 8: `catherd runs clean` removes the roles' scratch (spec "Per-role scratch" bullet ("`runs` cleanup removes it with the run"); Ruling 16)

There is no `runs` cleanup command yet. `catherd runs clean [<id>]` removes `<run>/scratch/` of a run with no live role (or of every such run), and leaves a run whose role still runs; the run's own files, records and replies stay. Deleting a run folder removes its scratch anyway, since it lives inside.

**Files:**
- Modify: `README.md`
- Modify: `src/entry/runs-command.ts`
- Create: `src/services/scratch.ts`
- Create: `test/services/scratch.test.ts`

**Interfaces:**
- Consumes: Task 1's `runPaths(dir).scratch`, `scratchDir`.
- Produces: `src/services/scratch.ts`: `interface ScratchCleaned { removed: { run; bytes }[]; kept: { run; why }[] }`, `cleanScratch({ run?, now? }): ScratchCleaned`. `catherd runs clean [<id>] [--json]`.

**Scratch commit:** `d0ddeca` (feat(runs): runs clean removes the roles' scratch of runs with no live role).

- [ ] **Step 1: Write the failing tests**

````diff
diff --git a/test/services/scratch.test.ts b/test/services/scratch.test.ts
new file mode 100644
index 0000000..d860366
--- /dev/null
+++ b/test/services/scratch.test.ts
@@ -0,0 +1,33 @@
+import { afterEach, describe, expect, it } from "bun:test";
+import { existsSync, mkdirSync, writeFileSync } from "node:fs";
+import { join } from "node:path";
+import { scratchDir } from "../../src/services/dispatches.ts";
+import { createRun, runPaths } from "../../src/services/run-store.ts";
+import { cleanScratch } from "../../src/services/scratch.ts";
+import { snapshotEnv, tempRepo } from "../helpers.ts";
+import { fakeDispatch, freshRun } from "./helpers.ts";
+
+afterEach(snapshotEnv());
+
+const exit = { code: 0, signal: null, reason: "exited" as const, endedAt: new Date().toISOString() };
+
+describe("catherd runs clean (spec 1.5 plan 21)", () => {
+  it("removes a finished run's scratch, keeps a run whose role still writes there, and keeps the run itself", async () => {
+    const { run: done } = freshRun("done");
+    const live = createRun({ repo: tempRepo(), title: "live", aLines: ["A1"], version: "0.0.0-test" });
+    await fakeDispatch(done, { name: "worker-M1.L1" }, { proc: "dead", exit });
+    await fakeDispatch(live, { name: "worker-M1.L1" }, { proc: "self" });
+    for (const run of [done, live]) {
+      mkdirSync(scratchDir(run, "worker-M1.L1"), { recursive: true });
+      writeFileSync(join(scratchDir(run, "worker-M1.L1"), "payment"), "x".repeat(2048));
+    }
+    const r = cleanScratch();
+    expect(r.removed).toEqual([{ run: done.id, bytes: 2048 }]);
+    expect(r.kept).toEqual([{ run: live.id, why: "worker-M1.L1 still running" }]);
+    expect(existsSync(runPaths(done.dir).scratch)).toBe(false);
+    expect(existsSync(runPaths(done.dir).meta)).toBe(true);
+    expect(existsSync(join(scratchDir(live, "worker-M1.L1"), "payment"))).toBe(true);
+    // one run by id; nothing left to remove is not an error
+    expect(cleanScratch({ run: done.id })).toEqual({ removed: [], kept: [] });
+  });
+});
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/services/scratch.test.ts test/entry/runs-command.test.ts`
Expected: FAIL. `scratch.test.ts` fails to import `src/services/scratch.ts`.

- [ ] **Step 3: Implement**

````diff
diff --git a/README.md b/README.md
index e9f3461..c638e10 100644
--- a/README.md
+++ b/README.md
@@ -195,6 +195,7 @@ In a terminal:
 | `catherd profile set <path> <value> [--profile <p>]`                                        | One field, e.g. `roles.verifier.access read-only`, `roles.worker.network false`, `budget.usd 20`    |
 | `catherd status [run]`, `catherd watch [--once] [--interval <s>]`                           | Where runs stand, grouped by host and session; read-only ownership                                  |
 | `catherd runs list [--repo <path>]\|show <id> [--debug [--name <n>]]\|cancel <id> <name>`   | Past runs, by session; `--debug` adds exit.json and the stderr and event tails, `--name` one role's |
+| `catherd runs clean [<id>]`                                                                 | Removes the roles' scratch folders (each role's `$TMPDIR`) of runs with no live role                |
 | `catherd catalog refresh\|list [--backend <b>] [--role <r>] [--text <t>] [--scored]`        | The models catherd can place, filtered                                                              |
 | `catherd catalog sync [--force] [--unmatched]`                                              | Fetches the public model facts and scores now (below); `--unmatched` lists ids no model matched     |
 | `catherd catalog treat-like <rung> <like>`                                                  | Scores an unscored rung as a scored one                                                             |
diff --git a/src/entry/runs-command.ts b/src/entry/runs-command.ts
index 3741760..90a6cc9 100644
--- a/src/entry/runs-command.ts
+++ b/src/entry/runs-command.ts
@@ -13,6 +13,7 @@ import { redact } from "../infra/log.ts";
 import { cancel } from "../services/dispatch-service.ts";
 import { registerSavedSecrets } from "../services/jev-service.ts";
 import { runDebug } from "../services/run-debug.ts";
+import { cleanScratch } from "../services/scratch.ts";
 import { findRun, listRuns, readRecords, type Run } from "../services/run-store.ts";
 import { groupRuns, type RunSession, type SessionGroup } from "../services/session-view.ts";
 import { type RunSummary, status, summarizeRun } from "../services/summary.ts";
@@ -289,6 +290,23 @@ const cancelCmd = defineCommand({
   },
 });
 
+const clean = defineCommand({
+  meta: {
+    name: "clean",
+    description:
+      "Remove the roles' scratch folders (their TMPDIR) of a run with no live role, or of every such run",
+  },
+  args: { id: { type: "positional", required: false, description: "run id (default: every run)" }, ...json },
+  run({ args }) {
+    const r = cleanScratch({ run: args.id });
+    if (args.json) return printJson(r);
+    for (const x of r.removed)
+      console.log(`${mark("ok")} ${x.run}  scratch removed (${n(Math.round(x.bytes / 1024))} KB)`);
+    for (const x of r.kept) console.log(`${mark("skip")} ${x.run}  scratch kept: ${x.why}`);
+    if (!r.removed.length && !r.kept.length) console.log("no scratch to remove");
+  },
+});
+
 const retryPush = defineCommand({
   meta: {
     name: "retry-push",
@@ -336,6 +354,6 @@ const retryPush = defineCommand({
 /** Spec §8 `catherd runs list|show [--debug]|cancel`; a bare `catherd runs` lists them, as `status` needs no run. */
 export const runsCommand = defineCommand({
   meta: { name: "runs", description: "Runs: list them (the default), show one, cancel a live role" },
-  subCommands: { list, show, cancel: cancelCmd, "retry-push": retryPush },
+  subCommands: { list, show, cancel: cancelCmd, clean, "retry-push": retryPush },
   default: "list",
 });
diff --git a/src/services/scratch.ts b/src/services/scratch.ts
new file mode 100644
index 0000000..249c12c
--- /dev/null
+++ b/src/services/scratch.ts
@@ -0,0 +1,47 @@
+import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
+import { join } from "node:path";
+import { liveDispatches } from "./dispatches.ts";
+import { findRun, listRuns, type Run, runPaths } from "./run-store.ts";
+
+export interface ScratchCleaned {
+  /** the runs whose scratch folder was removed, with what it held */
+  removed: { run: string; bytes: number }[];
+  /** the runs left alone, and why: a role still writes there */
+  kept: { run: string; why: string }[];
+}
+
+/** The bytes under `dir`, links not followed; 0 for what cannot be read. */
+function sizeOf(dir: string): number {
+  let total = 0;
+  try {
+    for (const e of readdirSync(dir, { withFileTypes: true })) {
+      const p = join(dir, e.name);
+      total += e.isDirectory() ? sizeOf(p) : (lstatSync(p, { throwIfNoEntry: false })?.size ?? 0);
+    }
+  } catch {
+    // gone or unreadable: counts as nothing
+  }
+  return total;
+}
+
+/**
+ * Spec 1.5 plan 21: `catherd runs clean [run]` removes the roles' scratch folders (`<run>/scratch/`, each role's
+ * TMPDIR) of a run with no live role, or of every such run. The run's own files, records and replies stay.
+ */
+export function cleanScratch(o: { run?: string; now?: number } = {}): ScratchCleaned {
+  const runs: Run[] = o.run ? [findRun(o.run)] : listRuns().runs;
+  const out: ScratchCleaned = { removed: [], kept: [] };
+  for (const run of runs) {
+    const dir = runPaths(run.dir).scratch;
+    if (!existsSync(dir)) continue;
+    const live = liveDispatches(run, o.now ?? Date.now());
+    if (live.length) {
+      out.kept.push({ run: run.id, why: `${live.map((d) => d.admit.name).join(", ")} still running` });
+      continue;
+    }
+    const bytes = sizeOf(dir);
+    rmSync(dir, { recursive: true, force: true });
+    out.removed.push({ run: run.id, bytes });
+  }
+  return out;
+}
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun run format && bun test test/services/scratch.test.ts test/entry/runs-command.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS (18 pass, 0 fail, 2 files).

- [ ] **Step 5: Commit**

````bash
git add -A README.md src/entry/runs-command.ts src/services/scratch.ts test/services/scratch.test.ts
git commit -m "feat(runs): runs clean removes the roles' scratch of runs with no live role"
````

---

### Task 9: A writer's implicit docs lane keeps its edits off the lanes (spec "Non-lane roles' edits" bullet; Rulings 18, 19)

A laneless writer gets an implicit Owns, stored as `admit.ownsImplicit`: the paths of an `Owns:` line in its brief, else `docs/**` and `*.md`. Its record's `changedOwned` is computed against it (no more "0 owned files changed" after 11 docs), and every dispatch that finalizes during an overlapping window counts it among the others' Owns, so the writer's concurrent doc edits are never a lane's violation. Each dispatch still compares its own before/after snapshot; an edit is attributed to the dispatch whose Owns (declared or implicit) covers it (Ruling 18 says why not by raw diff). Owns entries gain two forms for attribution: `dir/**` and `*.ext`. Admission's overlap check is unchanged. The skill tells the orchestrator to put the writer's files on an `Owns:` line.

**Files:**
- Modify: `plugin/skills/catherd/SKILL.md`
- Modify: `src/domain/changes.ts`
- Modify: `src/services/admission.ts`
- Modify: `src/services/dispatches.ts`
- Modify: `src/services/finalize.ts`
- Create: `test/services/writer-attribution.test.ts`
- Test: `test/skills.test.ts`

**Interfaces:**
- Consumes: Task 7 (admission's imports and brief composition; the writer's `Owns:` line is read from the orchestrator's text, not the composed brief).
- Produces: `src/domain/changes.ts`: `DOCS_OWNS = ["docs/**", "*.md"]`, `briefOwns(brief): string[] | null`, `ownsPath(path, entry): boolean`; `splitChanges` matches with `ownsPath`. `Admit.ownsImplicit?: string[]`.

**Scratch commit:** `179aa4c` (fix(finalize): a writer's implicit docs lane keeps its edits off the lanes).

- [ ] **Step 1: Write the failing tests**

````diff
diff --git a/test/services/writer-attribution.test.ts b/test/services/writer-attribution.test.ts
new file mode 100644
index 0000000..e578209
--- /dev/null
+++ b/test/services/writer-attribution.test.ts
@@ -0,0 +1,97 @@
+import { afterEach, beforeEach, describe, expect, it } from "bun:test";
+import { mkdirSync, writeFileSync } from "node:fs";
+import { join } from "node:path";
+import { briefOwns, DOCS_OWNS, ownsPath, splitChanges } from "../../src/domain/changes.ts";
+import { type AdmitInput, admit } from "../../src/services/admission.ts";
+import { resetReadiness } from "../../src/services/backends.ts";
+import { finalizeDispatch } from "../../src/services/finalize.ts";
+import { snapshotEnv } from "../helpers.ts";
+import { simPath, withScenario } from "../sim/scenario.ts";
+import { fakeDeps, fakeDispatch, freshRun } from "./helpers.ts";
+
+afterEach(snapshotEnv());
+beforeEach(() => resetReadiness());
+
+describe("a writer's implicit docs lane (spec 1.5 plan 21)", () => {
+  it("reads an Owns: line from the brief, and matches dir/** and *.ext entries", () => {
+    expect(briefOwns("Update the docs.\nOwns: CHANGELOG.md, `docs/api/`\n")).toEqual([
+      "CHANGELOG.md",
+      "docs/api/",
+    ]);
+    expect(briefOwns("Update the docs.")).toBeNull();
+    expect(briefOwns("Owns:   \n")).toBeNull();
+    expect(ownsPath("docs/guide/intro.md", "docs/**")).toBe(true);
+    expect(ownsPath("docs", "docs/**")).toBe(true);
+    expect(ownsPath("services/payment/README.md", "*.md")).toBe(true);
+    expect(ownsPath("README.mdx", "*.md")).toBe(false);
+    expect(ownsPath("src/docs.ts", "docs/**")).toBe(false);
+    expect(ownsPath("src/a.ts", "src")).toBe(true);
+    expect(splitChanges(["README.md", "src/x.ts"], ["src/a.ts"], DOCS_OWNS, true)).toEqual({
+      changedOwned: [],
+      violations: ["src/x.ts"],
+    });
+  });
+
+  it("gives a laneless writer its brief's Owns, else docs/** and *.md; nobody else gets one", async () => {
+    const { run } = freshRun();
+    process.env.PATH = simPath();
+    Object.assign(process.env, withScenario({}).env);
+    const deps = fakeDeps();
+    const writer = (brief: string, name: string): AdmitInput => ({
+      role: "writer",
+      name,
+      brief,
+      rung: "codex:gpt-6-luna#high",
+      thread: null,
+      lane: null,
+      failoverFrom: null,
+    });
+    expect(
+      (await admit(deps, run, writer("Write the changelog.\nOwns: CHANGELOG.md", "writer-a"))).d.admit
+        .ownsImplicit,
+    ).toEqual(["CHANGELOG.md"]);
+    expect((await admit(deps, run, writer("Write the docs.", "writer-b"))).d.admit).toMatchObject({
+      owns: [],
+      ownsImplicit: DOCS_OWNS,
+    });
+    const reviewer = await admit(deps, run, {
+      ...writer("Review M1.", "reviewer-M1"),
+      role: "reviewer",
+      rung: "codex:gpt-6-sol#high",
+    });
+    expect(reviewer.d.admit.ownsImplicit).toBeUndefined();
+  });
+
+  it("attributes a concurrent writer's doc edits to the writer: never a lane's violation, and its own changed files", async () => {
+    const { repo, run } = freshRun();
+    const ended = {
+      code: 0,
+      signal: null,
+      reason: "exited" as const,
+      endedAt: new Date(Date.now() + 60_000).toISOString(),
+    };
+    const lane = await fakeDispatch(
+      run,
+      { name: "worker-M1.L4", lane: "M1.L4", owns: ["src/a.ts"] },
+      { proc: "dead", exit: ended },
+    );
+    const writer = await fakeDispatch(
+      run,
+      { name: "writer", role: "writer", lane: null, owns: [], ownsImplicit: DOCS_OWNS },
+      { proc: "dead", exit: ended },
+    );
+    // the payment run: the writer edited docs while the L4 fix ran
+    mkdirSync(join(repo, "src"), { recursive: true });
+    mkdirSync(join(repo, "docs"), { recursive: true });
+    writeFileSync(join(repo, "src", "a.ts"), "fixed\n");
+    writeFileSync(join(repo, "docs", "guide.md"), "# Guide\n");
+    writeFileSync(join(repo, "README.md"), "# App\n");
+    const l4 = await finalizeDispatch(run, lane);
+    expect(l4.changedOwned).toEqual(["src/a.ts"]);
+    expect(l4.violations).toEqual([]);
+    const w = await finalizeDispatch(run, writer);
+    // its record says what it wrote, where 1.4 said "0 owned files changed"
+    expect(w.changedOwned).toEqual(["README.md", "docs/guide.md"]);
+    expect(w.violations).toEqual([]);
+  });
+});
diff --git a/test/skills.test.ts b/test/skills.test.ts
index b9499c9..1039fdf 100644
--- a/test/skills.test.ts
+++ b/test/skills.test.ts
@@ -108,6 +108,9 @@ describe("orchestrator skill", () => {
     expect(md).toContain("`dispatch` appends the role's reply contract to every brief");
     // spec 1.5 plan 21
     expect(md).toContain("with `lane`, `dispatch` inlines the lane file as it stands");
+    expect(md).toContain(
+      "Its brief names the files it may change on an `Owns:` line (default: `docs/**` and `*.md`)",
+    );
     expect(md).not.toContain('"Do not commit." Then the reply shape');
     expect(md).toContain("`dispatch` routes a lane you missed");
     for (const code of ["E_LANE_INVALID", "E_LAND_GATE", "E_CLIMB_DESIGN"]) expect(md).toContain(code);
````

- [ ] **Step 2: Run them and see them fail**

Run: `bun test test/services/writer-attribution.test.ts test/domain test/services/dispatch.test.ts test/services/lanes-run.test.ts test/skills.test.ts`
Expected: FAIL. `writer-attribution.test.ts` fails to import `briefOwns`/`DOCS_OWNS`/`ownsPath`; with them, the lane's record lists `README.md` and `docs/guide.md` as violations.

- [ ] **Step 3: Implement**

````diff
diff --git a/plugin/skills/catherd/SKILL.md b/plugin/skills/catherd/SKILL.md
index 7ffe244..004a8ec 100644
--- a/plugin/skills/catherd/SKILL.md
+++ b/plugin/skills/catherd/SKILL.md
@@ -266,7 +266,7 @@ Nothing else pushes: a phone that buzzes for progress teaches the user to ignore
 5. **Lanes.** Dispatch every lane of the milestone, one after another, each at its rung, then end your turn: workers, the artist, and a researcher if needed. A worker's brief points at its lane file, and `dispatch` gets its `lane`. A worker runs its own fast check until it passes.
    - When a worker's message arrives, read it with `result`: check its STATUS line, its `changedOwned` and its `hints`, then run its fast check yourself once. A fail goes back to the same thread with the failing output's path; a second fail climbs a rung.
    - A `violation: <paths>` hint means the role wrote outside its lane. Send those paths to the reviewer with the milestone; a lane that needs them gets an `Owns:` delta from the architect.
-6. **writer,** when the milestone changes docs. It starts once the workers are done.
+6. **writer,** when the milestone changes docs. It starts once the workers are done. Its brief names the files it may change on an `Owns:` line (default: `docs/**` and `*.md`), so its edits count as its own and never as a lane's violation.
 7. **reviewer,** named `reviewer-<M>`, once, over the whole milestone diff on a frozen tree.
    - **UI pass,** when the milestone touched a screen. List the changed files (`git diff --name-only <milestone base>`), map them to the screens that render them, and brief the UI reviewer on those screens only. You start the app first.
 8. **One fix round.** Send each lane's findings, verbatim, to its own worker thread, at its rung. A BLOCKER climbs a rung instead, on a fresh thread. Dispatch every lane's fix, then end your turn. Then resume the same reviewer thread, and it re-checks only the BLOCKER and BUG lines.
diff --git a/src/domain/changes.ts b/src/domain/changes.ts
index 633e5e2..2ef42e8 100644
--- a/src/domain/changes.ts
+++ b/src/domain/changes.ts
@@ -33,6 +33,28 @@ export function changedPaths(before: Snapshot, after: Snapshot): string[] {
     .sort();
 }
 
+/** Spec 1.5 plan 21: a writer's implicit docs lane, when its brief names no Owns. */
+export const DOCS_OWNS = ["docs/**", "*.md"];
+
+/** The paths of an `Owns:` line in a brief (as a lane file writes it), or null when it has none. */
+export function briefOwns(brief: string): string[] | null {
+  const line = /^Owns:\s*(.+)$/m.exec(brief)?.[1];
+  const paths = line
+    ?.split(",")
+    .map((p) => p.trim().replace(/^`|`$/g, ""))
+    .filter(Boolean);
+  return paths?.length ? paths : null;
+}
+
+/**
+ * Whether `path` is inside an Owns entry: a path covers what is under it, and the other way round (as lanes'
+ * Owns always did); `dir/**` covers what is under dir; `*.ext` (no slash) is any file with that extension.
+ */
+export function ownsPath(path: string, entry: string): boolean {
+  if (entry.startsWith("*.") && !entry.includes("/")) return path.endsWith(entry.slice(1));
+  return overlaps([path], [entry.replace(/\/\*\*$/, "")]).length > 0;
+}
+
 /**
  * Spec §4.4: `changedOwned` are the changes inside the lane's Owns; `violations` the ones outside it
  * that no overlapping dispatch owns either. `strict` is false for a laneless dispatch that may write
@@ -44,7 +66,7 @@ export function splitChanges(
   others: string[],
   strict: boolean,
 ): { changedOwned: string[]; violations: string[] } {
-  const inside = (p: string, paths: string[]) => overlaps([p], paths).length > 0;
+  const inside = (p: string, paths: string[]) => paths.some((entry) => ownsPath(p, entry));
   return {
     changedOwned: changed.filter((p) => inside(p, owns)),
     violations: strict ? changed.filter((p) => !inside(p, owns) && !inside(p, others)) : [],
diff --git a/src/services/admission.ts b/src/services/admission.ts
index 6311513..d23853e 100644
--- a/src/services/admission.ts
+++ b/src/services/admission.ts
@@ -8,6 +8,7 @@ import { assertId, formatRung, newDispatchId, parseRung } from "../domain/ids.ts
 import { assertLaneHeader, overlaps } from "../domain/lane.ts";
 import type { RunRecord } from "../domain/record.ts";
 import { composeBrief } from "../domain/brief.ts";
+import { briefOwns, DOCS_OWNS } from "../domain/changes.ts";
 import { ROLE_SERVER_BACKENDS, SCRATCH_BACKENDS } from "../domain/role-tools.ts";
 import type { Role } from "../domain/roles.ts";
 import { formatRoleScope, ROLE_ENV } from "../domain/role-scope.ts";
@@ -195,6 +196,8 @@ export async function admit(
       { fix: "dispatch a fresh thread (omit `thread`)" },
     );
   const owns = i.lane === null ? [] : laneOwns(run, i.lane);
+  // spec 1.5 plan 21: the writer's implicit docs lane, for attribution only
+  const ownsImplicit = i.role === "writer" && i.lane === null ? (briefOwns(i.brief) ?? DOCS_OWNS) : null;
   const id = newDispatchId();
   const dir = join(roleDir(run, i.name), id);
   const p = dispatchPaths(dir);
@@ -275,6 +278,7 @@ export async function admit(
       role: i.role,
       lane: i.lane,
       owns,
+      ...(ownsImplicit ? { ownsImplicit } : {}),
       rung: formatRung(rung),
       backend: rung.backend,
       thread: i.thread,
diff --git a/src/services/dispatches.ts b/src/services/dispatches.ts
index c3837a9..7da3fcb 100644
--- a/src/services/dispatches.ts
+++ b/src/services/dispatches.ts
@@ -19,6 +19,11 @@ const AdmitSchema = z.looseObject({
   role: z.enum(ROLES),
   lane: z.string().nullable(),
   owns: z.array(z.string()),
+  /**
+   * spec 1.5 plan 21: a laneless writer's implicit Owns (its brief's Owns: line, else docs/** and *.md), so its
+   * edits are its own and never a concurrent lane's violation; admission never refuses an overlap with it
+   */
+  ownsImplicit: z.array(z.string()).optional(),
   rung: z.string(),
   backend: z.string(),
   thread: z.string().nullable(),
diff --git a/src/services/finalize.ts b/src/services/finalize.ts
index 7741065..9f6a183 100644
--- a/src/services/finalize.ts
+++ b/src/services/finalize.ts
@@ -75,7 +75,7 @@ function othersOwns(run: Run, self: Dispatch, start: number, end: number): strin
       const to = ended.get(d.admit.dispatchId) ?? (Date.parse(readExit(d.dir)?.endedAt ?? "") || Date.now());
       return from <= end && to >= start;
     })
-    .flatMap((d) => d.admit.owns);
+    .flatMap((d) => [...d.admit.owns, ...(d.admit.ownsImplicit ?? [])]);
 }
 
 /** The tree after the run, or null when git cannot say: the record is still written, its changes unknown. */
@@ -186,7 +186,7 @@ async function compute(run: Run, d: Dispatch): Promise<RunRecord> {
   const { changedOwned, violations } = after
     ? splitChanges(
         changedPaths(a.before, after),
-        a.owns,
+        a.owns.length ? a.owns : (a.ownsImplicit ?? []),
         // from admission, when the before-snapshot was taken, not from the worker's start
         othersOwns(run, d, Date.parse(a.admittedAt), end),
         a.lane !== null || a.access === "read-only",
````

- [ ] **Step 4: Run the tests and the checks**

Run: `bun run format && bun test test/services/writer-attribution.test.ts test/domain test/services/dispatch.test.ts test/services/lanes-run.test.ts test/skills.test.ts && bun run typecheck && bun run lint && bun run format:check`
Expected: PASS (323 pass, 0 fail, 27 files).

- [ ] **Step 5: Commit**

````bash
git add -A plugin/skills/catherd/SKILL.md src/domain/changes.ts src/services/admission.ts src/services/dispatches.ts src/services/finalize.ts test/services/writer-attribution.test.ts test/skills.test.ts
git commit -m "fix(finalize): a writer's implicit docs lane keeps its edits off the lanes"
````

---

### Task 10: Drop from `docs/dev/ideas.md` what this plan fixed (brief: the last task)

Remove, and nothing else: #42 findings 1, 2, 4, 5, 6, 8, 9 (findings 3 and 7 stay, verbatim and with their numbers, for plan 22; Ruling 21); "A writer's edits are blamed on the lanes"; "An isolated headless worker cannot read its lane file"; "Roles litter `/tmp`"; "A native role steals the run, and every later result goes to it (P1)" with all its sub-bullets.

**Files:**
- Modify: `docs/dev/ideas.md`

**Interfaces:**
- Consumes: Tasks 1–9 merged.
- Produces: nothing.

**Scratch commit:** `8d17046` (docs(ideas): drop what plan 21 fixed).

- [ ] **Step 1: Edit `docs/dev/ideas.md`**

Apply this diff (only removals):

````diff
diff --git a/docs/dev/ideas.md b/docs/dev/ideas.md
index 0e2ddaf..d977b2f 100644
--- a/docs/dev/ideas.md
+++ b/docs/dev/ideas.md
@@ -17,29 +17,12 @@ the contributor. Owner rulings:
 
 #42 (role MCP server, `wait`), review findings:
 
-1. **The isolated refusal is unnecessary and reopens P1.** `admission.ts` refuses isolated codex/claude-code
-   architect, researcher, worker and verifier with `E_ADMIT_RUNG`, whose fix says to turn isolation off. Verified:
-   `-c mcp_servers.*` overrides still apply under `--ignore-user-config` and an empty `CODEX_HOME` (`codex mcp list`
-   showed `catherd_role` enabled). Isolation is today the only thing that keeps a role from loading the full
-   catherd plugin and stealing the run with `peek`. Fix: inject the role server in isolated mode too; for Claude,
-   check whether `--mcp-config` survives `--safe-mode`, else `--strict-mcp-config --mcp-config`.
-2. **Runs started isolated break on resume.** A resumed thread keeps its record's `isolated`, so fix rounds,
-   verifier re-checks and failover stand-ins on an isolated backend are refused even after the user turns isolation
-   off. Goes away with finding 1.
 3. **"waiting for orchestrator · stalled" never clears.** `runOwner` is never cleared and a dashboard `cancel` or an
    abandoned run leaves a record unread forever, so old runs show stalled forever and `status()` with no run returns
    all of them into the coordinator's context. Fix: only for a current owner and recent unread records; `status()`
    keeps defaulting to live runs, else the newest.
-4. **`read_knowledge` on the role server takes `z.literal(run.meta.repo)`**, refusing `.`, the pwd, or
-   `/tmp` vs `/private/tmp`. Make `repo` optional and use the run's.
-5. **`RUN_FILES` tells every role to write with `write_run_file`**, which workers and verifiers do not get.
-6. **doctor's role-MCP row:** fails inactive profiles; `existsSync(ROLE_MCP_ENTRY)` is always true; `profile
-   validate` should say it instead.
 7. **The TUI memo calls `orchestratorWait` on every tick for every idle run** (defeats the mtime memo), and
    `runs.tsx` uses the precomputed `stalled` while `status.tsx` recomputes it.
-8. **`required=true` on the role server** aborts the whole role when a cold Bun start beats Codex's MCP startup
-   timeout on a loaded machine. Check the timeout; set `startup_timeout_sec` or drop `required`.
-9. **`docs/dev/reports/role-access-orchestration-wait-pr.md`** is a PR description, not a run report; delete it.
 
 #43 (workspace runs), review findings:
 
@@ -516,11 +499,6 @@ Run `20260928-172920-m3-auth-plan-5-mr-b-the-kit-clean-up` (sanitell/platform, a
   - Each case needed a hand-written lane: L5, L6, L7, and a rescoped L4.
 
   Fix: an `owns_add(run, lane, paths, why)` tool that re-checks overlap. Clone-driven work also needs a "discover, then split" step, because the files are knowable only after the gate runs.
-- **A writer's edits are blamed on the lanes.** The writer role has no lane and no Owns:
-  - its record reads "0 owned files changed" after it edited 11 docs;
-  - the L4 fix record listed its 7 concurrent doc edits as L4 violations.
-
-  Fix: give non-lane roles an Owns (or a docs lane), and attribute each edit to the process that wrote it.
 - **Jev overrode the lane headers.** All four first lanes declared `Kind`/`Difficulty`, and routing replaced them (declared logic → `repo_code`/`copy`), so the logic lanes started on `luna#high`. Fix: a declared header wins, or the route record says why it didn't.
 - **A lane could not declare an allowed exception to its own absence grep.** The plan's `func Allowed` grep also matched an unrelated `services/verification/internal/job/command.go:120`, and `acceptancetest\.SignIn` matched the surviving `SignInAuth` and `SignInSSO`. The workers returned partial correctly, but a check that can never pass looks the same as work that isn't done yet. Fix: an `Allow:` line under the check, and word boundaries in plan greps.
 - **`dispatch` accepted a thread id that doesn't exist.** The orchestrator passed a wrong thread for the L4 fix, the role launched, and codex failed with "no rollout found for thread id". Fix: check `thread` against `runs.jsonl` (same name) before launching, or default to the name's last thread.
@@ -554,7 +532,6 @@ Run `20260928-172920-m3-auth-plan-5-mr-b-the-kit-clean-up` (sanitell/platform, a
 - **The profile is not pinned per run either.** The active profile changed from the codex one to `just-claude` while M3 was paused, so the run's verifier rung changed (`catherd-default-verifier-*` is gone and `catherd-just-claude-verifier-claude-opus-5-5-low` took over), and any re-dispatched lane would route on Sonnet instead of the Codex rungs it started on. Nothing in the run records the switch. Fix: same as the sandbox item: pin the profile at `run_start`, or log the change in `state.md`.
 - **A host probe needs to run twice.** Right after the AnyConnect VPN was disconnected, the first unsigned Go probe to `203.0.113.20` still got `no route to host`. The next seven, including one from a freshly built binary on a fresh network, answered 200. A single probe would have stopped the run for nothing. Fix: when catherd ships a host probe, it retries once after a few seconds before calling the host blocked.
 
-- **An isolated headless worker cannot read its lane file.** worker-M4.L1 (`claude-code`, `isolated: true`) was told "your lane file is lanes/M4.L1.md in the run" and replied "I couldn't find `lanes/M4.L1.md` on disk, so I worked from your summary". It guessed its Owns from the brief and edited four files the lane file did not list, which came back as violations (`directory.go`, `internal_test.go`, two Dokploy READMEs). All four were right to edit, but only because the brief happened to be detailed. Fix: `dispatch` inlines the lane file (Owns, Fast check, body) into the brief, or passes its absolute path and grants read access to the run folder.
 - **`preflight` reruns every past milestone's lanes.** Called for M4, which had one new lane, it ran all seven M3 lane checks too (Go testcontainers and four panels), took about 2 min behind the lock while the M4 worker was already running, and reported a failure on an M3 lane (`TestSeedWritesEveryStateThePanelShows`) that has nothing to do with M4. Fix: preflight only lanes that have not landed, or take a `milestone` argument.
 
 ## From the payment run (2026-09-29)
@@ -720,10 +697,6 @@ owner turned isolation off (the host is itself a sandbox).
   commands it runs. The thread reaches catherd only as `_meta.threadId` on MCP calls, so the smoke always reports
   `no session` even inside a live thread. Fix: a `test_push` MCP tool, or `--thread <uuid>`, or resolve the cwd's
   latest thread from `~/.codex/session_index.jsonl`.
-- **Roles litter `/tmp`.** The run left about 250 files there: drivers, observers, ledgers, a 51 MB `payment`
-  binary, and logs copied between roles. This host's `/tmp` is a 5.9 GiB tmpfs with a per-user quota that had
-  already broken a TUI once. Fix: each dispatch gets `TMPDIR=<run>/scratch/<role>/`, the brief names it, and
-  evidence goes through `write_run_file`. `runs` cleanup removes the scratch with the run.
 - **A provider outage looks like progress.** `researcher-M1-signin-failures` on
   `opencode-go/muse-spark-1.3-contributor#xhigh` (10:29:39) produced no tool call and no text in 4.5 minutes. The
   session held one assistant message with `retry.attempt: 6` and `503 service_overloaded: The backend is
@@ -744,23 +717,6 @@ owner turned isolation off (the host is itself a sandbox).
   medium 47.8 ≈ Astra low, high 50.2 ≈ Astra medium. GLM 5.3 Flash max (41.8) and DeepSeek 4.1 Flash max (39.5)
   were mapped the same way. Fix: read the AA Intelligence Index per model and effort as a calibration source. Until
   a value arrives, a release of the same family takes at least its predecessor's values at the same effort.
-- **A native role steals the run, and every later result goes to it (P1).** Isolation was turned off, so roles
-  launched with `codex exec` load the user's config, including the catherd plugin. At 11:08:37
-  `verifier-M1-verification` called `peek({run})`. Its prompt included the coordinator section of AGENTS.md, and
-  "skip this section" was not enough to stop it. `claimRun` (spec §3.3: `run_start`, `dispatch` and `peek` claim)
-  made the verifier's exec thread `01a0fc4b` the run's owner. The deliveries of `verifier-M1` (11:22:49) and
-  `verifier-M1-notification` (11:23:40) were then queued to that thread
-  (`~/.codex/queue_1.sqlite`, `enqueue-accepted`, status `unread`), and the coordinator never saw them. A
-  `codex exec` thread exits after its turn, so those items stay orphaned. Found 15 minutes later only because the
-  owner noticed silence. Fixed by hand: the coordinator called `peek` to reclaim ownership, and AGENTS.md now forbids
-  roles the claiming and steering tools. Fix in catherd:
-  - The supervisor sets `CATHERD_ROLE=<run>/<role>` in every role's env, Codex and opencode alike.
-  - `claimRun` never claims from a process that carries it.
-  - In a role process the MCP server refuses the coordinator tools (`peek` on another role, `result`, `dispatch`,
-    `run_start`, `climb`, `land`, `park`, `cancel`, `set_next`, `answer`, `profile_set`) with a clear error.
-  - A test pins all three.
-  - Also: a delivery whose target thread is a `codex exec` thread, or a thread that is not the owner of record at
-    enqueue time, should fail loudly instead of going `enqueue-accepted`.
 
 ## 1.3 follow-ups (plan reviews, 2026-09-29)
 
````

- [ ] **Step 2: Check**

Run: `bun run format:check` and `grep -n "CATHERD_ROLE\|Roles litter\|blamed on the lanes\|cannot read its lane file" docs/dev/ideas.md`
Expected: format clean; the grep prints nothing.

- [ ] **Step 3: Commit**

````bash
git add docs/dev/ideas.md
git commit -m "docs(ideas): drop what plan 21 fixed"
````

---

## Self-review (plan writer)

- **Spec coverage:** every bullet of spec 1.5's plan 21 maps to a task (Coverage table); the P1 is Task 1 and Review Focus 1.
- **Placeholders:** none; every step has its diff or command, and every diff is the scratch commit named in the task.
- **Type consistency:** `RoleScope`, `Deps.role`, `COORDINATOR_TOOLS`, `scratchDir`, `roleThreadOf`, `ROLE_THREAD_REFUSAL`, `assertRoleMay`, `RoleServerStart`, `BriefContext`, `ROLE_SERVER_BACKENDS`, `SCRATCH_BACKENDS`, `ownsImplicit` and `DOCS_OWNS` are spelled as the scratch build compiles them.
- **Review Focus:** each of the six lines has its test in the owning task.

## After the plan

The controller runs live-verification section 15 with the owner's release acceptance (plan 27), and lists Rulings 2, 6 and 9 in the PR body as the vendor behaviours a live run confirms.
