# catherd 1.0 — Plan 9: the findings from the real 0.x runs, before 1.0.0

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 1.0.0 must not repeat what the real orchestrated runs on 0.1 and 0.2.1 went wrong on (recorded in
`docs/ideas.md` by c0479cb, 72648b9 and f4967fd; consolidated in `docs/dev/ideas.md`). An audit of `main` at
38a930d found that the top bug, **parallel dispatch is serial**, is still present in 1.0, and that five more
findings are open or half done. This plan fixes them; the release PR (#11) stays held until it merges.

**Architecture:** no new layer. `dispatch` stops blocking: it admits, launches and returns. A new MCP tool,
`wait`, blocks (with progress, so Claude Code backgrounds it after two minutes) until the next of the run's live
dispatches finishes, finalizes it and handles a usage-limit failover. The rest is prompt and skill text, the
harness-cost summary, one routing rule and docs.

## Audit verdicts (main at 38a930d)

| # | Finding (run) | Verdict | This plan |
|---|---|---|---|
| 1 | Parallel dispatch is serial (auth-kit) | still present: `dispatch` awaits `waitForFinish` (dispatch-service.ts `runToEnd`); no tool is read-only, so Claude Code runs the calls one by one; SKILL.md still says "launch every independent role in the same message" | Task 1 |
| 2 | Plan in hand: the architect redesigns, the researcher still runs (auth-kit) | still present: no `plan:` path | Task 2 |
| 3 | Lint in the fast check (auth-kit) | still present: "targeted tests" only | Task 2 |
| 4 | Milestone per branch, stacked milestones | feature idea | stays in `docs/dev/ideas.md` |
| 5 | `status` harness line: wrong mode, negative delta (auth-kit) | half: no mode shown, unscoped, unclamped; Codex has no figure at all | Task 3 |
| 6 | Jev sure of the kind, not the difficulty: 3 of 4 routes fell back (first runs) | half: outcomes are logged and the rule changed, but the native architect prompt omits `Kind:`/`Difficulty:`, so the dead band still lands on the default | Tasks 2, 4 |
| 7 | First-turn cost on small lanes | feature idea | stays in ideas |
| 8 | Live coverage missing (opencode lane, climb, failover, budget stop) | still present in the live kit | Task 5 |
| 9 | Per-milestone digest | feature idea | stays in ideas |

## Rulings

1. **`dispatch` returns at launch; `wait` collects.** `dispatch` keeps its input and its refusals (every
   `E_ADMIT_*`, `E_RUN_BUDGET`, `E_BACKEND_*` still comes back before anything starts) and returns
   `{ dispatched: { name, role, rung, dispatchId, admittedAt }, hints }` once the supervisor is launched and
   state.md refreshed. `wait({ run, names?, all? })` blocks until at least one of the named live dispatches
   (default: every live dispatch of the run) has finished (`all: true`: every one of them), finalizes each that
   has, and returns `{ records, started, running, hints }`. A finished dispatch whose record says `limit` gets its
   failover stand-in admitted and launched inside `wait` (not awaited): it is listed in `started` and its name
   stays in `running`. A dispatch finished by an earlier server process is finalized by the next `wait` the same
   way (finalizing is claim-based and idempotent already). `wait` with nothing live returns at once, with a hint.
   Progress ticks as `dispatch` sent them before. This replaces the "backgrounds after two minutes" promise the
   0.x skill made of `dispatch` itself. The tool count goes from 20 to 21.
2. **No tool is marked `readOnlyHint`.** It would be false for `dispatch` and `wait` and loosen permission
   prompts. Serial `dispatch` calls now cost about a second each, which is why this works.
3. **`route` stays one call per lane.** Its Jev call is bounded (25 s); the skill no longer claims the calls run
   at once. A batch `route` is a 1.x idea.
4. **Plan in hand is an A-line.** `plan: <path>[, <path>…]` in the user's request (the skill's A-lines) skips the
   researcher dossier and briefs the architect to translate, not design: each plan task becomes lanes (Owns:,
   Fast check:, Kind:, Difficulty:), each MR or phase a milestone with its full check; it redesigns only what the
   plan leaves undecided, and stays the escalation target for `design` findings.
5. **A lane's fast check includes the linter (and type check, when the repo has one) scoped to its owned
   packages**, besides its targeted tests; the dossier reports the lint and type-check commands.
6. **A sure kind survives an unsure difficulty.** When Jev's kind is sure and its difficulty is in the dead band,
   `route` keeps Jev's kind and takes the difficulty from the lane's `Difficulty:` line, else the profile's default
   difficulty for that role, instead of dropping to `source: "default"`.
7. **The harness line shows this run and compares like with like.** `status` shows, per backend, how many of
   this run's dispatches ran native and isolated. `runs_summary`'s `extraPerRun` compares only runs in the same
   repo when a run is given, and is null with fewer than 3 runs a side or when native is not dearer. Codex
   reports no per-request input, so it has no harness figure: both skills say so instead of offering one.

## Global constraints

Plan 7's global constraints hold (layers, Bun ≥ 1.4, isolated `CATHERD_HOME` per test, explicit `env` for
spawned processes, `ANTHROPIC_API_KEY` deleted or blanked, no wall-clock sleeps for correctness, commit subjects
≤ 100 characters starting lower-case, never a `bun.lock` rewritten by an older Bun). Full gate before the last
commit of each task: `bun run format && bun run typecheck && bun run lint && bun run format:check && bun test`.

## Task 1: `dispatch` returns at launch, `wait` collects (finding 1)

**Files:** `src/services/dispatch-service.ts`, `src/services/finalize.ts` (reuse `waitForFinish` /
`dispatchState`), `src/entry/mcp/dispatch-tools.ts`, the MCP tool list and its tests, `plugin/` skill text
(the catherd skill's Waiting section and every line that relies on concurrent `dispatch`), docs that count 20
tools (README, `docs/dev/manual-tests.md`, `.changeset/catherd-1-0.md`, the spec only if it lists tools as
current behaviour, not as history).

- [ ] Failing tests first (`test/services/dispatch.test.ts` and the MCP stdio test): `dispatch` returns while the
  fake worker still runs, with `dispatched.name` and `admittedAt`; two dispatches issued one after the other are
  both live at once (their `admittedAt` differ by far less than a worker's run); `wait` returns the first to
  finish with its record and leaves the other in `running`; `wait({ all: true })` returns both; a worker that
  hits a usage limit is recorded `limit` by `wait`, its stand-in is launched and listed in `started`; `wait` with
  nothing live returns at once with a hint; a dispatch that finished while no `wait` ran (a new server) is
  finalized by the next `wait`; refusals still come from `dispatch` before anything starts; progress ticks still
  reach the client during `wait`.
- [ ] Implement per Ruling 1. Keep `cancel` working on a dispatch nobody waits for. Budget pause (`out.pause`)
  and state.md refreshes move with the code that produces them.
- [ ] Skill: dispatch every independent role one after another (each returns in about a second), then call
  `wait(run)`; its result (or its notification, once it backgrounds) wakes you; act on each record, dispatch
  what follows, and `wait` again while anything is running. A single role is `dispatch` then `wait`. Both only
  from the main thread. Update the skills test to require `wait` and forbid the old "same message" claim.
- [ ] Tool descriptions: `dispatch` says it returns at launch and names `wait`; `wait` says what it returns.

## Task 2: skill and prompt text (findings 2, 3, 6)

**Files:** the catherd skill (`plugin/skills/catherd/SKILL.md`), the setup skill, `src/…/role-prompts.ts`
(the architect and researcher prompts), their tests (`skills.test.ts`, `agents.test.ts`).

- [ ] Plan in hand per Ruling 4 (the A-line, skip the dossier, the translator brief; remove the rule that
  forbids copying a plan in that case only).
- [ ] Lint per Ruling 5, in every place the fast check is described (skill, architect prompt, brief template,
  dossier list).
- [ ] The native architect prompt lists all five lane header lines (`#`, `Owns:`, `Fast check:`, `Kind:`,
  `Difficulty:`), matching the skill.
- [ ] Remove "all in one message" for `route` (Ruling 3). Codex harness wording per Ruling 7 in both skills.
- [ ] Tests assert each of these.

## Task 3: the harness line (finding 5)

**Files:** `src/services/summary.ts` (and wherever `status` is assembled), their tests
(`summary-reconcile.test.ts`, status tests).

- [ ] Failing tests: `status` shows this run's native/isolated counts per backend; `harnessCosts` with a run
  given ignores other repos' runs; `extraPerRun` is null with fewer than 3 runs a side and when not positive.
- [ ] Implement per Ruling 7.

## Task 4: a sure kind survives an unsure difficulty (finding 6)

**Files:** `src/services/routing-service.ts` (and the pure rule in `src/domain/` if it lives there), tests.

- [ ] Failing tests: Jev kind sure + difficulty in the dead band + lane `Difficulty:` → Jev's kind with the lane's
  difficulty (a new `source` value that says so); without the lane line → the profile's default difficulty for the
  role; both unsure → unchanged behaviour.
- [ ] Implement per Ruling 6; `outcomes.jsonl` records the source as now.

## Task 5: docs (finding 8, and the ledger of findings)

- [ ] `docs/dev/live-verification.md` §6 (and `manual-tests.md` where the orchestrated run lives): a run with at
  least two parallel lanes (check that their `admittedAt` overlap, guarding finding 1); a profile whose worker
  rung is opencode; a forced climb; quota failover through a fake `codex` on PATH that prints a usage limit; a
  tiny token budget ending in `E_RUN_BUDGET`.
- [ ] `docs/dev/ideas.md`: remove what this plan ships (serial dispatch, plan in hand, lint in the fast check, the
  status harness line), keep 4, 7, 9 and add "batch `route`".
- [ ] `.changeset/catherd-1-0.md`: 21 MCP tools, three new (`cancel`, `record_agent_run`, `wait`), and parallel
  lanes that really run at once.
