# Plan 47 — the architect loop (architect-led runs, stage 1, slice 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Never read the whole plan: take your task brief.

Setup: bun install --frozen-lockfile

**Goal:** a profile that says `engine: "architect"` starts runs the architect drives: catherd wakes it when a task, a check or the owner has news, it acts through its tools and keeps a ledger, and the researcher and the writer are on call to it and to workers through `delegate_task`. Every other run keeps the 2.0 pipeline, untouched. Nothing is deleted.

**Architecture:** the switch is one profile field and one `run.started` field. An architect run's state is a new `arch` part of `RunState`, folded by `applyArchitect` (`src/domain/architect-state.ts`) before the 2.0 reducer sees the event; the daemon calls `architectNext` (`src/domain/architect-machine.ts`) instead of `next` for such a run. Its actions are the existing `dispatch` (an architect turn: brief `wake`; a delegated task: brief `task`), `watch`, `cancel`, `report`, `notify`, `remind`, `finish`, and one new `runCheck`. The architect's tools (`src/services/architect-tools.ts`) only read the run or append the event that asks the daemon for something, each with a `why`. The ledger and the checks are rows of plan 46's database (three migrations); the ledger is rendered read-only into `ledger/`.

**Tech stack:** Bun ≥ 1.4 (`bun:sqlite`), TypeScript, zod, the MCP SDK.

**Spec:** `docs/specs/2026-10-27-architect-led-runs-design.md` — D1 (event-woken turns, the digest, a fresh thread from the ledger), D2 (the ledger), D3 (the tool surface), D6 (checks on demand, a tree-keyed pass cache, the base on demand), D10 (only its idle rule; caps and stall are plan 48), D12 (standing roles), D13 (the tables), "Contract lines", D17 stage 1.

## Global Constraints

- Version stays 2.0: the plan's one changeset is `"catherd-cli": minor` (Ruling R14).
- Deletes nothing. A 2.0 run's events, state, actions and briefs are what they were: every existing test passes unchanged, except the ones a task names.
- Gate only behaviour. No acceptance line, test or contract text judges commit subjects, test-first proof or file scope. Owns is a hint.
- Layers `domain → infra → adapters → services → entry` (`test/architecture.test.ts`). `bun:sqlite` stays in `src/infra/db.ts`.
- Documents stay files (D13): a row points at a file by path and never holds a brief, a reply or a report.
- Tests never reach the network and never sleep on the wall clock for correctness; spawned processes get `ANTHROPIC_API_KEY: ""`.
- No personal hosts or product names in code, tests or docs.
- The full root suite takes about 280 s: `catherd lock -- bun test`. The panel's gate runs in `web/` (Task 4 changes its generated client).

## Review Focus

1. A 2.0 run is untouched: `run.started` with `engine: "2.0"` leaves `arch` null, `next` drives it, and its role contracts, tools and briefs are byte-for-byte what they were except the worker's and the verifier's "permission to test" line (Task 5).
2. Wake and digest (D1): an event that lands during a turn is delivered in the next turn and never twice: the turn's `dispatch.started` carries `upTo`, and only inbox items with `seq <= upTo` are dropped (Task 6, "queues what happens during a turn…").
3. The run always ends: two idle turns, three failed turns in a row, `finish`, or the owner's cancel each end it (Task 6).
4. A worker reaches the standing roles and nothing else of the architect's surface; it sees only its own tasks (Task 8, "a worker delegates only to the standing roles…").
5. The check cache never reuses a failure, and `fresh: true` and a changed tree always rerun (Task 7).

## What already exists

- `src/infra/db.ts` — `MIGRATIONS` (two), `db()`, `ensureRunRow`, `insertEvent`, `insertDispatch`, `insertMessage`, `storeOnFile`, `backupDb`.
- `src/services/team.ts` — `teamSend` (numbers under `withFileLockSync`, steers a running *lane* when the sender is the architect or the owner), `teamRead`, `teamWait` (lane-based), `teamFor` (a brief's team lines, by the `teamSeen` watermark).
- `src/domain/run-events.ts` — `RunEventSchema` (`run.started.engine: z.literal("2.0")`), `PARK_REASONS`, `ACTION_TYPES` (must equal `Action["type"]`: `ACTIONS_MATCH_EVENTS` in run-machine.ts), `describeEvent` (exhaustive).
- `src/domain/run-state.ts` — `RunState`, `emptyState`, `apply` (one `switch`), `reduce`, `replay`, `liveDispatches`, `HOLD_MS`, the private `recomputeWake`.
- `src/domain/run-machine.ts` — `BriefKind`, `DispatchAction`, `Action`, `actionKey`, `unitOf`, `confirms`, `next`, the private `owedActions` (reports, notices and reminders a parked question owes).
- `src/services/daemon.ts` `runDaemon` — `take(e)`: `reduce`, `confirms`, then `for (const a of next(state, e)) issue(a)`.
- `src/services/run-effects.ts` `realEffects` — `start(a, render, s, judge)` admits and launches a dispatch with a given rung (no decision when `a.decision` is null and `a.rung` is set) and appends `dispatch.started`, then `settle` appends `dispatch.ended`; `perform` switches on the action; `finish` writes `writeRunReport`, `run.ended`, `refreshState`, `backupDb`.
- `src/services/run-briefs.ts` — `briefFor` → `briefBody` (a `switch` on `BriefKind`), `renderBrief` → `composeBrief`.
- `src/domain/brief.ts` — `composeBrief(parts, c: BriefContext)`, `roleNotes` (the CLI forms of `roleMcpTools(role)`), `cliForm`.
- `src/domain/role-prompts.ts` — `roleContract(role, version)`, `BODIES`, `STATUS_LINE`, `runFiles(writes)`.
- `src/domain/role-tools.ts` — `RoleMcpContext {run, role}`, `roleMcpTools(role)`; callers: `src/infra/role-mcp.ts` (Codex `enabled_tools`), `src/adapters/claude-code/index.ts` (the allowlist), `src/domain/brief.ts`, `src/services/role-access.ts` `assertRoleMay`, `src/services/doctor-role-mcp.ts`, `src/entry/mcp/role-server.ts`.
- `src/services/admission.ts` `admit` — `rc = profile.roles[i.role]` (access, rungs), `roleMcp: { run, role }` at line ~280.
- `src/services/run-client.ts` `runStart` — appends `run.started` (`engine: "2.0"`) and `plan.approved by input` when plan files are given.
- `src/domain/profile.ts` — `ProfileDocSchema` (loose), `Profile`, `resolveProfile`, `unknownValues`, `ProfilePatchSchema` (strict), `applyPatch` (a generic merge); `src/services/ports.ts` `ProfileView`; `src/services/profile-service.ts` `viewOf`.
- `src/services/run-store.ts` `ROLE_WRITABLE`: `plan.md`, `dossier.md`, `lanes/<id>.md`.
- `src/services/preflight.ts` `runCheck(cwd, command, timeoutMs, env)`, `checkEnvFor`; `src/infra/heavy-lock.ts` `withHeavySlot`, `heavySlots`, `LOCK_HELD_ENV`; `src/infra/git.ts` `git`, `worktreeIdentity` (a hash of HEAD, the diff and untracked files); `src/domain/fail-lines.ts` `checkFailLines`, `newFails`; `src/domain/plan-lint.ts` `lintPlan`; `src/services/dispatch-service.ts` `cancel(deps, run, name)`; `src/services/budget.ts` `budgetOf`.
- Test helpers: `test/helpers.ts` `withHome`, `tempRepo`; `test/services/helpers.ts` `freshRun`, `fakeDeps`, `testView` (worker, writer, reviewer, architect only), `fakeDispatch`; `test/domain/run-fixtures.ts` `makeLog`, `startDispatch`, `endDispatch`, `newId`, `startedFields`; `test/sim/scenario.ts` `simPath`, `withScenario` (a fake Codex).

## Contracts

```ts
// src/infra/db.ts (Task 1)
export function insertMessage(d: Database, runId: string,
  m: { n: number; at: string; from: string; to: string; text: string; kind?: string; mode?: string }): void;
export interface CheckRow { checkId: string; scope: string; ref: string; tree: string | null; command: string;
  base: boolean; exit: number | null; failures: string[]; minutes: number; cached: boolean; at: string }
export function insertCheck(d: Database, runId: string, c: CheckRow): void;

// src/domain/ledger.ts (Task 2)
export const LEDGER_STATES = ["todo", "running", "review", "done", "blocked", "impossible"] as const;
export interface LedgerTask { id: string; goal: string; state: LedgerState; depends: string[]; oracle: string[] }
export interface TaskAttempt { taskId: string; ledgerTask: string | null; rung: string; working: boolean; outcome: string | null }
export interface LedgerView extends LedgerTask { assignee: string | null;
  attempts: { taskId: string; rung: string; outcome: string | null }[]; blocks: string[] }
export const LedgerPatchSchema; // strict: { add?: {id, goal, depends?, oracle?}[], set?: {id, goal?, depends?, oracle?, state?}[], remove?: id[] }
export function applyLedgerPatch(tasks: readonly LedgerTask[], patch: LedgerPatch): LedgerTask[]; // E_INPUT_INVALID
export function ledgerView(tasks: readonly LedgerTask[], attempts: readonly TaskAttempt[]): LedgerView[];
export const PROGRESS_SHOWN = 40;
export function renderProgress(entries: readonly { at: string; text: string }[]): { shown: string; archive: string };
// src/services/ledger-store.ts (Task 2)
export const LEDGER_DIR = "ledger";
export function ledgerTasks(run: Run): LedgerTask[];
export function ledgerProgress(run: Run): { at: string; text: string }[];
export function writeLedger(run: Run, i: { tasks?: LedgerPatch; progress?: string }, at: Date): LedgerTask[];
export function renderLedger(run: Run, attempts?: readonly TaskAttempt[]): void; // ledger/tasks.json, progress.md, progress-archive.md

// src/services/team.ts (Task 3)
export const MESSAGE_KINDS = ["notice", "question"] as const;  export type MessageKind
export const SEND_MODES = ["auto", "queue", "steer"] as const;  export type SendMode
teamSend(i: { run; from; to; text; kind?: MessageKind; mode?: SendMode }, o?)  // existing return type
teamRead(i: { run; from?: string; since?; limit?; maxChars? })                  // existing return type

// src/domain/profile.ts (Task 4)
export const ENGINES = ["2.0", "architect"] as const;  export type Engine
// Profile.engine: Engine; ProfileView.engine?: Engine; ProfileDocSchema.engine: z.string().optional();
// ProfilePatchSchema.engine: z.enum(ENGINES).optional()

// src/domain/role-prompts.ts (Task 5)
export const roleContract: (role: Role, version: string, engine?: Engine) => string; // engine defaults to "2.0"
// src/domain/brief.ts: BriefContext.engine?: Engine

// src/domain/architect-state.ts (Task 6)
export const STANDING_ROLES: readonly Role[]; // ["researcher", "writer"]
export const isStanding: (role: Role) => boolean;
export const STANDING_CAP = 4; export const WRITER_CAP = 4; export const FAILED_TURNS_MAX = 3;
export const architectName: (turn: number) => string; // `architect-${turn}`
export interface ArchTask { taskId; role: Role; rung; thread: string | null; ledgerTask: string | null; by; why;
  state: "queued" | "working" | "ended" | "cancelled" | "refused"; dispatchId: string | null; outcome: string | null; read: boolean }
export interface ArchCheck { checkId; command; scope: "fast" | "full"; base: boolean; fresh: boolean; state: "queued" | "done" }
export interface InboxItem { seq: number; text: string; wakes: boolean; taskId?: string }
export type FinishVerdict = "done" | "impossible" | "stopped";
export interface ArchState { tasks: Record<string, ArchTask>; checks: Record<string, ArchCheck>; inbox: InboxItem[];
  turns: number; turn: string | null; thread: string | null; rung: string | null; fresh: string | null;
  failedTurns: number; idle: number; finishing: { verdict: FinishVerdict; why: string } | null }
export function emptyArch(): ArchState;
export const taskAttempts: (a: ArchState) => TaskAttempt[];
export function applyArchitect(s: RunState, e: RunEvent): boolean; // true: handled; false: the 2.0 reducer applies it
// src/domain/architect-machine.ts (Task 6)
export function architectNext(s: RunState, e: RunEvent): Action[];
// src/domain/run-state.ts: RunState.engine: Engine; RunState.arch: ArchState | null; export recomputeWake
// src/domain/run-machine.ts: BriefKind += "wake" | "task"; DispatchAction.upTo?: number;
//   Action += { type: "runCheck"; checkId: string }; export owedActions

// src/services/run-events-store.ts (Task 7)
export function runEngine(run: Run): Engine; // a run on files, or with no run.started: "2.0"
// src/services/architect-run.ts (Task 7)
export const taskBriefFile: (taskId: string) => string; // `tasks/${taskId}/brief.md`
export const researchFile: (taskId: string) => string;  // `research/${taskId}.md`
export function wakeBrief(run: Run, s: RunState, a: DispatchAction): Pick<BriefParts, "unit" | "round">;
export function taskBrief(run: Run, s: RunState, a: DispatchAction): Pick<BriefParts, "unit" | "round">;
export function writeArchitectReport(run: Run, s: RunState, events: RunEvent[]): string; // <run>/report.md
// src/services/architect-check.ts (Task 7)
export async function runArchitectCheck(deps: Deps, run: Run, c: ArchCheck,
  o: { timeoutMs: number; onWait?: (w: LockWait | null) => void }): Promise<Extract<RunEventInput, { type: "check.done" }>>;

// src/domain/role-tools.ts (Task 8)
export const ARCHITECT_TOOLS = ["capabilities", "delegate_task", "task_status", "task_cancel", "thread_send",
  "thread_read", "thread_wait", "check", "ledger", "ask_owner", "finish"] as const;  export type ArchitectTool
export const DELEGATOR_TOOLS: readonly ArchitectTool[]; // ["delegate_task", "task_status", "thread_wait"]
// RoleMcpContext.engine?: Engine; roleMcpTools(role: Role, engine: Engine = "2.0"): string[]
// src/services/architect-tools.ts (Task 8)
export interface ToolCaller { name: string; role: Role }   // name: the dispatch name, or "owner"
export interface ToolContext { deps: Deps; run: Run; caller: ToolCaller; pollMs?: number }
export const STOP_CLASSES = ["production", "secrets", "irreversible", "stuck"] as const;
export interface ToolSpec { description: string; shape: z.ZodRawShape; readOnly: boolean; call(c: ToolContext, a: never): unknown }
export const ARCHITECT_TOOL_SPECS: Record<ArchitectTool, ToolSpec>;
export const architectToolsFor: (role: Role) => readonly ArchitectTool[];
export async function callArchitectTool(c: ToolContext, tool: ArchitectTool, args: unknown): Promise<unknown>;
// src/entry/role-cli-command.ts (Task 8): export const callCommand — `catherd call <run> <tool>`, JSON args on stdin
```

The three migrations, exact (index 2, 3, 4 of `MIGRATIONS`, so `user_version` 3, 4, 5):

```sql
-- 3: the ledger (D2)
CREATE TABLE ledger_tasks (run_id TEXT NOT NULL REFERENCES runs(id), id TEXT NOT NULL, pos INTEGER NOT NULL,
  body TEXT NOT NULL, PRIMARY KEY (run_id, id));
CREATE TABLE ledger_progress (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
  at TEXT NOT NULL, text TEXT NOT NULL);
-- 4: the team channel's kind and delivery (D13)
ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'notice';
ALTER TABLE messages ADD COLUMN mode TEXT NOT NULL DEFAULT 'queue';
ALTER TABLE messages ADD COLUMN delivered_at TEXT;
-- 5: checks (D6)
CREATE TABLE checks (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), check_id TEXT NOT NULL,
  scope TEXT NOT NULL, ref TEXT NOT NULL, tree TEXT, command TEXT NOT NULL, base INTEGER NOT NULL,
  exit INTEGER, failures TEXT NOT NULL, minutes REAL NOT NULL, cached INTEGER NOT NULL, at TEXT NOT NULL,
  UNIQUE (run_id, check_id));
```

The new events (Task 4), each in `RunEventSchema` and in `describeEvent`; `role` is `z.enum(ROLES)`, `strings` is `z.array(z.string())`:

```ts
ev("task.delegated", { taskId: z.string(), role, rung: z.string(), thread: z.string().nullable(),
  ledgerTask: z.string().nullable(), by: z.string(), why: z.string() }),
ev("task.cancelled", { taskId: z.string(), by: z.string(), why: z.string() }),
ev("task.read", { taskId: z.string() }),
ev("check.requested", { checkId: z.string(), command: z.string(), scope: z.enum(["fast", "full"]),
  base: z.boolean(), fresh: z.boolean(), by: z.string(), why: z.string() }),
ev("check.done", { checkId: z.string(), exit: z.number().int().nullable(), failures: strings, preExisting: strings,
  cached: z.boolean(), minutes: z.number(), logPath: z.string() }),
ev("ledger.changed", { tasks: strings, progress: z.boolean(), by: z.string(), why: z.string() }),
ev("thread.sent", { to: z.string(), n: z.number().int(), delivery: z.enum(["steered", "queued", "resumed"]),
  by: z.string(), why: z.string() }),
ev("run.finishing", { verdict: z.enum(["done", "impossible", "stopped"]), by: z.string(), why: z.string() }),
// changed: run.started.engine: z.enum(ENGINES); dispatch.started.upTo?: int ≥ 0; question.parked.why?: string;
// PARK_REASONS += "owner"
```

## Rulings

Each is `Ruling: <what> — <why> — <cost if wrong>`. They bind every task.

- R1 — Ruling: the switch is the profile's `engine` field (`"2.0"` default, `"architect"`), read once by `runStart` into `run.started.engine`; a run never changes engine — D17 measures stage 1 against stage 0 run by run, so both engines must run side by side — a profile change does not move a run in flight.
- R2 — Ruling: an architect run's state lives in `RunState.arch`, folded by `applyArchitect` before the 2.0 `switch`; it handles `daemon.started`, `dispatch.*`, `question.answered`, `effect.failed` and every new event, and leaves pause, resume, cancel, `question.parked`/`reminded`, reports, ticks and `run.ended` to the 2.0 reducer — the 2.0 `onEnded` would park, floor and judge an architect's dispatches — the dispatch-table update is written twice (2.0's and the architect's), until plan 48 deletes the 2.0 one.
- R3 — Ruling: the existing `dispatch` action carries both an architect turn (`brief: "wake"`, `name: architect-<n>`, `unit: "run"`, `rung: null`, filled by the effect from the profile) and a task (`brief: "task"`, `name = unit = taskId`, `lane: null`, the rung the tool chose); only `runCheck` is a new action — admission, launch, watch, settle, cancel and failover are reused as they are — `DispatchAction` gains one optional field (`upTo`).
- R4 — Ruling: the digest is an inbox in `ArchState` (one item per wake event, `wakes` false for what only rides along); the turn's `dispatch.started.upTo` is the last item the brief showed, and only items up to it are dropped — the reducer cannot see the brief, the event can — one optional field on `dispatch.started`.
- R5 — Ruling: wake events are a delegated task's end or refusal (the architect's own tasks only; a worker's standing-role task rides along by path, D12), a check's result, an owner's answer, a failed effect, a failed or refused turn, and the idle notice; a team message to the architect does not wake it and arrives in the next digest through `teamFor` — the spec's "owner sent a message" is the `answer` path here — a worker's question waits for the next wake (ideas.md).
- R6 — Ruling: idle (D10, the only part of D10 in this plan) is counted at a turn's end: nothing live, nothing queued, no queued check, no waking item, no open question and not finishing; the first such turn adds the idle notice, the second ends the run `failed` with the verdict `stopped — idle`; any architect action resets it — without it a turn that started nothing would end the loop silently — D10's 15-minute idle cap, wall, cost and attempts caps are plan 48.
- R7 — Ruling: a fresh thread starts after a failed or refused turn, after `daemon.started` (when a thread exists), when the profile's architect rung differs from the thread's, and when the last architect record is `threadHeavy`; the 70%-of-window rule waits for the window in the catalog — `threadHeavy` is catherd's existing spent-thread signal — a long thread may run past 70% until then (ideas.md).
- R8 — Ruling: three failed or refused turns in a row end the run (`stopped`) — a broken architect rung must not loop — a transient outage of three turns ends a run the owner restarts.
- R9 — Ruling: caps for stage 1: 4 writer tasks and 4 standing-role tasks at once (`WRITER_CAP`, `STANDING_CAP`); a task over its cap stays `queued` and starts the moment a slot frees, with no tick — D12 sets 4; the memory-bound writer cap comes with per-writer trees (stage 2) — a box with less memory runs four writers anyway.
- R10 — Ruling: an architect run works in the repository's checkout and refuses a `base` at `runStart` (E_INPUT_INVALID); checks run on the checkout as it stands, keyed by `worktreeIdentity`, and `check {ref}` is not offered — the integration tree and landing are plans 50 and 52 — an architect run cannot land a branch until plan 50.
- R11 — Ruling: the owner's plan files are copied as input and no `plan.approved` is appended on the architect engine; plan lint runs once, in the first turn's brief, as warnings — D2 drops the approval stop — the first turn reads a plan lint it may ignore.
- R12 — Ruling: on the architect engine the architect runs `workspace-write` when its profile says `read-only` (admission); `full` stays `full` — D3; the profile migration that writes it is plan 49 — a hand-set `read-only` architect profile gets write access on this engine.
- R13 — Ruling: the tools are one service (`architect-tools.ts`) behind both the role server and `catherd call <run> <tool>` (JSON on stdin), refused on a 2.0 run (E_ROLE_SCOPE); outside a role the CLI acts as `owner` with the architect's tools, as the other role CLI forms allow everything outside a role — opencode roles have no role server — the owner can drive a run by hand.
- R14 — Ruling: one changeset for the plan, in Task 9 — the plan merges as one PR — one `next` snapshot carries all three milestones.
- R15 — Ruling: `ask_owner` requires `stopClass` ∈ production, secrets, irreversible, stuck and parks `unit` `run` or the task id with reason `owner`; nothing in the daemon waits on it except the idle rule — O6; the architect alone decides what waits — a mislabelled class still reaches the owner.
- R16 — Ruling: `thread_send` mode `steer` behaves as `auto` (steer where the backend allows, else queue, and the reply says which); `restart` is not offered — `task_cancel` then `thread_send` does it — one mode fewer than the spec's list.
- R17 — Ruling: the verdicts map to outcomes `done → done`, `impossible → failed`, `stopped → failed`; the owner's cancel stays `cancelled` — the outcome enum is the 2.0 one, and the report carries the verdict — the panel shows an impossible run as failed.
- R18 — Ruling: `write_run_file` takes `research/<id>.md` for every role that has the tool; the writer gets `write_run_file` on the architect engine — D12 — a researcher may write another task's research file (ideas.md).
- R19 — Ruling: the ledger's `assignee` and `attempts` are derived at render time from the events, not written by the daemon; the architect's `done`, `blocked` and `impossible` stand, else `running` while a dispatch works the task and `review` after one completed it — one writer of the rows — `tasks.json` lags until the next tool call or turn renders it.

## Parallelism

- M1: Task 1, then Tasks 2 and 3 at once (Task 2: ledger files; Task 3: team.ts).
- M2 (after M1): Task 4, then Tasks 5 and 6 at once (Task 5: role-prompts.ts, brief.ts; Task 6: the domain machine, run-briefs.ts' two stub cases, daemon.ts), then Task 7.
- M3 (after M2): Tasks 8 and 9 at once (Task 8: code and tests; Task 9: MIGRATION.md, ideas.md, the changeset).

Every task's code and tests are built and green in the scratch reference (below); a worker may read the reference file it is writing, as a check, after writing its own.

## Scratch reference

`/Users/vigen/agora/lab/.worktree/plan47-architect/catherd/.superpowers/plan47-scratch` (gitignored), branch `plan47-scratch` on main `7e307412`, one commit per milestone, each with the full gate green:

- M1 — `a093debb` feat(db): the ledger, check and message columns for the architect loop
- M2 — `a4dfa05e` feat(engine): the architect loop behind engine: architect
- M3 — `47cec573` feat(architect): the architect's tools and catherd call; docs and changeset

`git -C <scratch> show <sha> -- <file>` prints one file's change.

## M1 — The ledger, checks and message columns in the database

A1 — a database plan 46 wrote opens with the three new migrations, its messages kept as queued notices (Check).
A2 — the ledger's rows apply a patch whole or not at all, and render to `ledger/tasks.json`, `ledger/progress.md` and `ledger/progress-archive.md` (Check).
A3 — a message is recorded with its kind and how it was delivered; the architect's message steers a running task by its name (Check).

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 1: Three migrations, `insertMessage` kinds, `insertCheck`

Files: src/infra/db.ts, test/infra/db.test.ts

Append the three migrations (Contracts) to `MIGRATIONS`. `insertMessage` takes optional `kind` and `mode` and writes them (`'notice'`, `'queue'` when absent). Add `CheckRow` and `insertCheck` (writes `failures` as `JSON.stringify`, `base` and `cached` as 0/1). `legacy-import.ts` keeps calling `insertMessage` without the new fields.

- [ ] Write the tests; `bun test test/infra/db.test.ts` fails.

Test: test/infra/db.test.ts —
- "keeps a message a plan-46 database holds, as a queued notice, when it adds the plan-47 tables" — a raw `new Database(file)` with only `MIGRATIONS.slice(0, 2)` applied (`user_version` 2), one `runs` row and one message; `openDb(file)` → `SELECT kind, mode, delivered_at FROM messages` is `[{ kind: "notice", mode: "queue", delivered_at: null }]`; `insertMessage(…, { kind: "question", mode: "steer" })` reads back so; `ledger_tasks`, `ledger_progress` and `checks` exist in `sqlite_master`.
- "stores a check's failing lines as JSON and its flags as integers (plan 47)" — one `insertCheck` → `{ check_id: "C1", base: 0, cached: 0, failures: '["(fail) a > b"]' }`.
- The existing tests pass on `MIGRATIONS.length` 5 unchanged.

- [ ] Implement; the test passes; `bun run typecheck && bun run lint`.
- [ ] Commit (suggested): `feat(db): ledger, checks and message kind columns for the architect loop`

### Task 2: The ledger, in the domain and the store

Files: src/domain/ledger.ts (new), src/services/ledger-store.ts (new), test/domain/architect-ledger.test.ts (new), test/services/ledger-store.test.ts (new)

`src/domain/ledger.ts` (pure, Contracts): `applyLedgerPatch` copies the tasks into a `Map` by id, applies `remove` (an unknown id throws), then `add` (state `todo`, `depends` and `oracle` default `[]`; a known id throws), then `set` (an unknown id throws), then checks every `depends` names a task in the result; every throw is `CatherdError("E_INPUT_INVALID", …, { fix: "read ledger/tasks.json and patch the ids it holds" })`; the order is the insertion order. `ledgerView` (R19): per task, the attempts whose `ledgerTask` is its id; state = the task's own when it is `done|blocked|impossible`, else `running` when an attempt is `working`, else `review` when the last attempt's outcome is `"ok/complete"`, else the task's own; `assignee` the working attempt's task id; `blocks: []`. `renderProgress`: each entry `## <at>\n\n<text trimmed>\n`, joined by `\n`, under `# Progress\n\n`; the last `PROGRESS_SHOWN` go to `shown`, the rest to `archive` under `# Progress, archived\n\n`.

`src/services/ledger-store.ts`: `ledgerTasks` = `SELECT body FROM ledger_tasks WHERE run_id = ? ORDER BY pos`, parsed; `ledgerProgress` = `SELECT at, text FROM ledger_progress WHERE run_id = ? ORDER BY id`. `writeLedger` in one `.immediate()` transaction: `ensureRunRow`, apply the patch to the current rows (when given), replace the run's `ledger_tasks` rows (`pos` = index), insert a progress row when `progress.trim()` is not empty; returns the tasks. `renderLedger` writes the three files under `<run>/ledger/` with `writeTextAtomic`; `tasks.json` is `JSON.stringify(ledgerView(...), null, 2)` plus a newline.

- [ ] Write the tests; `bun test test/domain/architect-ledger.test.ts test/services/ledger-store.test.ts` fails.

Test: test/domain/architect-ledger.test.ts — describe "the architect's ledger (plan 47, spec D2)":
- "adds as todo, sets, removes, and keeps the order tasks were added in" — `[L1, L2]` + `{ remove: [L1], add: [L3 depends L2, oracle test/a.test.ts], set: [L2 done, goal g2] }` → `[L2 done g2, L3 todo]`.
- "refuses a patch on an id it lacks, a duplicate add, and a dangling depends" — four `E_INPUT_INVALID`s (set L9, add L1 twice, remove L9, set depends L2 that does not exist).
- "derives running and review from the task's dispatches; the architect's done, blocked and impossible stand" — L1 (a failed then a working attempt) → `running`, assignee T2, 2 attempts; L2 (`ok/complete`) → `review`; L3 `impossible` with a working attempt → `impossible`, assignee T4; L4 → `todo`.
- "shows the last 40 progress entries and archives the rest" — 42 entries: `shown` holds t2 and not t1; `archive` holds t0 and t1 and not t2.
Test: test/services/ledger-store.test.ts — describe "the ledger store (plan 47, spec D2 and D13)":
- "keeps tasks and progress as rows and renders them read-only into ledger/" — two writes (add L1 with progress, set L1 done) → rows; `renderLedger` with one `ok/complete` attempt → `tasks.json` is the full `LedgerView` (state `done`, the attempt listed, `blocks: []`); `progress.md` holds the entry.
- "writes nothing when the patch does not apply" — a failing add with a progress → throws; rows unchanged; `ledger_progress` empty.

- [ ] Implement; the tests pass; `bun run typecheck && bun run lint`.
- [ ] Commit (suggested): `feat(ledger): the architect's ledger as rows, rendered read-only`

### Task 3: The team channel's kind, mode and a task's steer

Files: src/services/team.ts, test/services/team.test.ts

Add `MESSAGE_KINDS`, `SEND_MODES` and their types (Contracts). `teamSend` takes `kind` and `mode`: the database insert passes `kind` (a file run's line is unchanged); `mode === "queue"` returns `queued` before any steer. The steer target: when `state.lanes[to]` is running, the live dispatch of that lane (as today); else the live dispatch whose `name === to` (an architect run's task). After a steer that succeeded on a database run (`!existsSync(team.jsonl)`), `UPDATE messages SET mode = 'steer', delivered_at = <now> WHERE run_id = ? AND n = ?`. `teamRead` takes `from` and keeps only that sender's messages before paging.

- [ ] Write the test; `bun test test/services/team.test.ts` fails.

Test: test/services/team.test.ts — "steers a running task by its name, records the kind and the delivery, and queue never steers (plan 47)" — a run whose log starts dispatch `T1` (`lane: null`, thread `ses_T1`) on a codex rung; a send from `architect` with `mode: "queue"` → `queued`; a second with `kind: "question"` and a steer stub returning true → `steered`; `SELECT n, kind, mode, delivered_at IS NOT NULL AS delivered FROM messages` → `[{1, notice, queue, 0}, {2, question, steer, 1}]`; `teamRead({ from: "architect" })` texts `["a", "b"]`, `from: "owner"` none. Every existing team test passes unchanged.

- [ ] Implement; the test passes; then the full Check.
- [ ] Commit (suggested): `feat(team): a message's kind and delivery, and a steer by task name`

### M1 lanes

- M1.L1 — Task 1 — owns src/infra/db.ts, test/infra/db.test.ts — fast check: `bun test test/infra && bun run typecheck && bun run lint`
- M1.L2 — Task 2 — after M1.L1 — owns the files Task 2 lists — fast check: `bun test test/domain/architect-ledger.test.ts test/services/ledger-store.test.ts test/architecture.test.ts && bun run typecheck && bun run lint`
- M1.L3 — Task 3 — after M1.L1 — owns src/services/team.ts, test/services/team.test.ts — fast check: `bun test test/services/team.test.ts test/services/run-briefs.test.ts && bun run typecheck && bun run lint`

## M2 — The architect loop behind `engine: "architect"`

A1 — a profile with `engine: architect` starts a run the architect drives; every other run is the 2.0 pipeline as before (Check).
A2 — the architect is woken at the start and after every task end, check result, owner answer or failure, with a digest of exactly what it has not seen, on its resumed thread unless a fresh one is due; a run whose turns start nothing ends (Check).
A3 — a task the architect delegated runs with only its brief, within the writer and standing-role caps; a check runs only when asked, reuses a pass on the same tree, and marks a failure the base has as pre-existing (Check).
A4 — the run's report carries the verdict, the ledger, the last progress entries and every architect call's why (Check).

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test && cd web && bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun run test

### Task 4: The engine switch and the architect engine's events

Files: src/domain/profile.ts, src/services/ports.ts, src/services/profile-service.ts, src/domain/run-events.ts, src/services/run-client.ts, web/openapi.json, web/src/client/types.gen.ts, web/src/lib/park-reasons.ts, web/src/lib/park-reasons.test.ts, test/domain/profile.test.ts, test/domain/run-events.test.ts, test/services/run-client.test.ts

profile.ts: `ENGINES`/`Engine` (Contracts); `ProfileDocSchema.engine: z.string().optional()`; `Profile.engine: Engine` (doc comment "plan 47: the machine a new run starts on"); `resolveProfile` sets `engine: known(ENGINES, doc.engine) ? doc.engine : "2.0"`; `unknownValues` adds `check("engine", ENGINES, doc.engine, "2.0")`; `ProfilePatchSchema.engine: z.enum(ENGINES).optional()`. ports.ts: `ProfileView.engine?: Engine`. profile-service.ts `viewOf`: `engine: p.engine`.

run-events.ts: import `ENGINES`; `run.started.engine: z.enum(ENGINES)`; `PARK_REASONS` gains `"owner"` (last, with a comment "plan 47: the architect's ask_owner, within spec O6's stop classes"); `dispatch.started` gains `upTo: z.number().int().min(0).optional()`; `question.parked` gains `why: z.string().optional()`; the eight new events after `tick` (Contracts); `describeEvent` lines:
`task.delegated` → `` `${by} delegated ${taskId} to the ${role} on ${rung}: ${one(why)}` ``; `task.cancelled` → `` `${by} cancelled ${taskId}: ${one(why)}` ``; `task.read` → `` `${taskId} read` ``; `check.requested` → `` `${by} asked for check ${checkId} (${scope}${base ? ", base" : ""}): ${one(why)}` ``; `check.done` → `` `check ${checkId} ${exit === 0 ? "passed" : `failed (exit ${exit ?? "timeout"})`}${cached ? " (cached)" : ""}` ``; `ledger.changed` → `` `${by} changed the ledger${tasks.length ? ` (${tasks.join(", ")})` : ""}: ${one(why)}` ``; `thread.sent` → `` `${by} sent #${n} to ${to} (${delivery}): ${one(why)}` ``; `run.finishing` → `` `${by} finishes the run ${verdict}: ${one(why)}` ``. `ACTION_TYPES` is not touched here (Task 6 adds `runCheck` with its action).

run-client.ts `runStart` (R1, R10, R11): before `assertBase`, `const engine = top ? (deps.profiles.forRepo(top).engine ?? "2.0") : "2.0"`; `engine === "architect" && i.base` → `CatherdError("E_INPUT_INVALID", "the architect engine does not take a base yet", { fix: "start without base, or set the profile's engine to 2.0 for a branch run" })`, before any folder exists; `run.started` gets `engine`; `plan.approved by input` only when `engine === "2.0"`; `next` on the architect engine: `` `the architect drives the run from its ledger and asks you only what it must: status(run) shows it; questions reach ${notifyUrl} and this session` ``.

Panel: `bun run panel:openapi`, then `cd web && bun run gen`; `park-reasons.ts` `REASON_TEXT.owner` = "The architect asks you about production, a secret, an action that cannot be undone, or a stuck run."; its test expects 20 reasons.

- [ ] Write the tests; `bun test test/domain/profile.test.ts test/domain/run-events.test.ts test/services/run-client.test.ts` fails.

Test: test/domain/profile.test.ts — describe "engine (plan 47)": "defaults to 2.0, takes architect, and reads a value it does not know as 2.0" — `resolveProfile` of `{}`, `{engine: "architect"}`, `{engine: "4.0"}` → 2.0, architect, 2.0; `unknownValues({ engine: "4.0" })` → `[{ path: "engine", value: "4.0", readAs: "2.0" }]`; `patchAt("engine", "architect")` → `{ engine: "architect" }`; `ProfilePatchSchema` refuses `"4.0"`.
Test: test/domain/run-events.test.ts — "parses and describes the architect engine's events, each with its why (plan 47)" — one of each new event plus `question.parked` with reason `owner` and a `why` round-trip through `RunEventSchema.parse` and have a non-empty `describeEvent`; the `task.delegated` line is exactly `architect-1 delegated T1 to the worker on codex:gpt-6-sol#high: <why>`; `run.started` with `engine: "3.0"` does not parse.
Test: test/services/run-client.test.ts — "starts an architect run when the profile says so: its plan files are input, not an approval (plan 47)" — `testView({ engine: "architect" })`, a `PLAN.md`: events are only `run.started`, with `engine: "architect"` and the plan path; `next` contains "architect drives the run". "refuses a base on the architect engine, creating no run (plan 47)" — `E_INPUT_INVALID`, the run count unchanged.

- [ ] Implement; the tests pass; `bun run typecheck && bun run lint`; `bun test test/entry/panel-openapi.test.ts`; the panel's gate in `web/`.
- [ ] Commit (suggested): `feat(engine): the engine switch and the architect engine's events`

### Task 5: The architect loop's contract and the permission to test

Files: src/domain/role-prompts.ts, src/domain/brief.ts, test/domain/architect-contract.test.ts (new)

role-prompts.ts: a `PERMISSION_TO_TEST` line ("This run is your permission to test: when the repository's agent files say to ask before browser, simulator or dev-server testing, this brief is that permission, since nobody can answer a prompt. Use the method that gives direct proof, and name it in your report."), appended to the verifier's body (after a blank line) and placed in the worker's body before its "Reference:" paragraph. A new `ARCHITECT_LOOP` body, `ARCHITECT_LOOP_NEXT` and `ARCHITECT_LOOP_DONE` (copy them from the scratch reference, M2, or write to these points): the architect is the run's brain and catherd only runs what it asks; it works in turns and ends each one (never polls; `thread_wait` only for a short join); one line per tool of `ARCHITECT_TOOLS` with its contract, every call with a one-line `why`; `ledger` progress every turn, because a fresh thread starts from the ledger; `ask_owner` only in the four stop classes, with the context and the recommendation first; delegate, but a small change itself is fine; fill the free slots; the researcher and the writer on call, results by path; "Handoffs are context, not proof." (compare the ledger with git log and the tree on a fresh thread; spot-check one cited claim); "Plans can be stale." (log `SKIP <task> — <evidence>`); gate only the product. `roleContract(role, version, engine = "2.0")`: for `role === "architect" && engine === "architect"`, `[ARCHITECT_LOOP, EVERY_ROLE, STOP_WATCHERS, ARCHITECT_LOOP_NEXT, \`Done when: ${ARCHITECT_LOOP_DONE}\`, STATUS_LINE].join("\n\n")`; otherwise exactly as today. `import type { Engine } from "./profile.ts"`.

brief.ts: `BriefContext.engine?: Engine`; `composeBrief`'s part 1 is `roleContract(c.role, c.version, c.engine)`.

- [ ] Write the test; `bun test test/domain/architect-contract.test.ts` fails.

Test: test/domain/architect-contract.test.ts — describe "the architect loop's contract (plan 47, spec D1–D3 and the contract lines)":
- "names every tool and the architect's contract lines, and keeps the 2.0 architect's for a 2.0 run" — the loop contract contains each of the eleven tool names, "Handoffs are context, not proof", "SKIP <task> — <evidence>", "your recommendation first", and not "lanes/Mx.Ly.md"; the 2.0 architect's contains "lanes/Mx.Ly.md"; `roleContract("architect", v, "2.0") === roleContract("architect", v)`.
- "makes a run the permission to test for the worker and the verifier".
- "composes an architect run's brief with the loop's contract" — `composeBrief` with `engine: "architect"` contains `delegate_task`; without it, not.

- [ ] Implement; the test passes; `bun test test/domain test/services/verifier-brief.test.ts test/services/dispatch-thread.test.ts`.
- [ ] Commit (suggested): `feat(prompts): the architect loop's contract and the permission to test`

### Task 6: The architect engine's state and machine

Files: src/domain/architect-state.ts (new), src/domain/architect-machine.ts (new), src/domain/run-state.ts, src/domain/run-machine.ts, src/domain/run-events.ts, src/services/run-briefs.ts, src/services/daemon.ts, test/domain/architect-machine.test.ts (new), test/services/architect-daemon.test.ts (new)

run-events.ts: `ACTION_TYPES` gains `"runCheck"` (last). run-machine.ts: `BriefKind` gains `"wake" | "task"`; `DispatchAction.upTo?: number`; `Action` gains `{ type: "runCheck"; checkId: string }`; `actionKey` → `` `runCheck:${checkId}` ``; `unitOf` → `a.checkId`; `confirms(check.done)` → `` [`runCheck:${e.checkId}`] ``; `export function owedActions`. run-briefs.ts `briefBody`: `case "wake": case "task": return { unit: [], round: [] };` (Task 7 renders them).

run-state.ts (R2): `RunState.engine: Engine` and `RunState.arch: ArchState | null` (`emptyState`: `"2.0"`, `null`); `export function recomputeWake`; in `apply`, right after `s.seq`/`s.at`: `if (applyArchitect(s, e)) return;`; the `run.started` case also sets `s.engine = e.engine` and, for `architect`, `s.arch = emptyArch()`, `s.phase = "running"` and one inbox item `{ seq: e.seq, text: \`the run started: ${e.title}\`, wakes: true }`.

architect-state.ts (Contracts; pure). `applyArchitect` returns false when `s.arch` is null. Otherwise, per event (`push(a, e, text, wakes = true, taskId?)` appends `{ seq: e.seq, … }`; `failTurn(a, why)`: `failedTurns += 1`, `fresh = why`, at `FAILED_TURNS_MAX` `finishing ??= { verdict: "stopped", why: \`the architect failed ${n} turns in a row: ${why}\` }`; a caller is the architect when `by === "architect" || by.startsWith("architect-")`):
- `daemon.started`: `if (a.thread !== null) a.fresh ??= "the daemon restarted"`; true.
- `dispatch.started`: add the `DispatchView` (as the 2.0 reducer does: fields, `teamSeen` when present, `ended: null`); an `architect` role: `turns += 1`, `turn = dispatchId`, drop inbox items with `seq <= (e.upTo ?? e.seq)`, `fresh = null`; else the task named `e.name`: `working`, its `dispatchId`; `recomputeWake(s)`; true.
- `dispatch.refused`: `E_RUN_CANCELLED` → true; a task: `refused`, push `` `${taskId} (${role}) could not start: ${code} ${message}` `` (wakes only for the architect's task); `unit === "run"`: `failTurn(a, \`your turn could not start: ${code}\`)` and push `` `your last turn could not start: ${code} ${message}` ``; true.
- `dispatch.ended`: end the view (`thread`, `ended`), the quota hold as 2.0's `onEnded` does it (`limit` → `holds[quota] = at + HOLD_MS`; ok/complete → delete), `recomputeWake`. The architect: clear `turn`, `thread = dv.thread`, `rung = dv.rung`; status not ok → `failTurn(\`your last turn ended ${status}\`)` and push `` `your last turn ended ${status}: ${why || "no reason given"}` ``; ok → `failedTurns = 0`, then the idle rule (R6): when nothing is live, no task or check is queued, no inbox item wakes, no question is open and not finishing, `idle += 1`; at 2 `finishing = { verdict: "stopped", why: "idle: two turns in a row ended with nothing running" }`, else push "idle: nothing is running, nothing is queued and nobody was asked. Delegate, check, ask the owner or finish.". A task: `ended`, `outcome = \`${status}/${replyStatus ?? "none"}\``, push (the architect's: `` `${taskId} (${role}${ledgerTask ? `, ledger ${ledgerTask}` : ""}) ended ${outcome}: ${why || "no reason given"}; reply ${replyPath}` ``, waking; another caller's: `` `${taskId} (${role}, for ${by}) ended ${outcome}; reply ${replyPath}` ``, not waking), with `taskId`. True.
- `task.delegated`: the task, `queued`, `read: false`; the architect's resets `idle`; another caller's pushes a non-waking `` `${by} delegated ${taskId} to the ${role}: ${why}` ``.
- `task.cancelled`: a `queued` task → `cancelled`; `idle = 0`. `task.read`: `read = true`, drop the inbox items with that `taskId`.
- `check.requested`: the check, `queued`; `idle = 0`. `check.done`: `done`; push `` `${checkId} (${scope}${base ? ", on the base" : ""}) ${exit === 0 ? "passed" : `failed (exit ${exit ?? "timeout"}): ${failures.length} failing line(s), ${preExisting.length} also on the base`}${cached ? ", from a pass on the same tree" : ""}; log ${logPath}` ``.
- `ledger.changed`, `thread.sent`: `idle = 0`; true. `run.finishing`: `finishing ??= { verdict, why }`; true.
- `question.parked`: `idle = 0`; **false** (2.0 records the question and owes its report). `question.answered`: delete the question, `recomputeWake`, push `` `the owner answered (${unit}): ${answer}` ``; true.
- `effect.failed`: `report|notify|remind` → true; `runCheck` → that check `done`; `dispatch` on `run` → `failTurn`; `dispatch` on a queued task → `refused`; push `` `${action} on ${unit} failed: ${message}` ``; true.
- Anything else: false.

`taskAttempts(a)`: the tasks with a `dispatchId`, as `TaskAttempt`s (`working` = state `working`).

architect-machine.ts `architectNext(s, e)` (R3, R9): `[]` without `arch` or once ended. Else `out` = a `watch` per live dispatch on `daemon.started`, then `owedActions(s)`. Cancelling: a `cancel` of every live dispatch, or `finish` `cancelled` when none. Finishing: a `cancel` of every live non-architect dispatch, or `finish` with `{ done: "done", impossible: "failed", stopped: "failed" }[verdict]` when none (R17). Then a `runCheck` per queued check. Paused: stop here. Then, in task order, a `dispatch` per queued task while its pool has room (standing: `STANDING_CAP`; others: `WRITER_CAP`; counted from working tasks and those started in this call): `{ unit: taskId, name: taskId, role, lane: null, rung, thread, failoverFrom: null, brief: "task", notes: [], decision: null }`. Last, when `turn === null` and an inbox item wakes: the wake `{ type: "dispatch", unit: "run", name: architectName(turns + 1), role: "architect", lane: null, rung: a.rung, thread: fresh === null ? thread : null, failoverFrom: null, brief: "wake", notes: fresh === null ? [] : [fresh], decision: null, upTo: inbox.at(-1)?.seq ?? 0 }`.

daemon.ts `take`: `for (const a of (state.arch ? architectNext : next)(state, e)) issue(a);`.

- [ ] Write the tests; `bun test test/domain/architect-machine.test.ts test/services/architect-daemon.test.ts` fails.

Test: test/domain/architect-machine.test.ts — describe "the architect engine's machine (plan 47, spec D1 and D4)"; helpers: an architect `run.started`; `turn(log, n, thread?)` appends an architect `dispatch.started` with `upTo` = the last seq; `delegate(log, id, role?, by?)`; `after(log)` = `architectNext(log.state(), last event)`:
- "wakes the architect at the start, on a fresh thread, with the digest up to the start" — state `{ engine: "architect", phase: "running" }`; the wake `{ name: "architect-1", brief: "wake", thread: null, rung: null, upTo: 1 }`.
- "starts what the architect delegated within the writer and standing-role caps, and never wakes it mid-turn" — 5 workers and 5 researchers → dispatches `T1–T4, T6–T9`; the first is `{ unit: "T1", lane: null, brief: "task", rung }`.
- "queues what happens during a turn and wakes it once the turn ends, on its own thread" — T1 runs, architect-1 ends with thread `th-a` → no wake; T1 ends → wake `{ name: "architect-2", thread: "th-a", upTo: <T1 end seq> }`, inbox text is the T1 line; once architect-2 starts the inbox is empty.
- "names a worker's standing-role task in the next digest without waking the architect" — T2 (researcher, by T1) delegated and ended → no wake, two non-waking items; T1's end wakes.
- "wakes once when nothing runs, and stops the run when the next turn starts nothing either" — the idle item, then `finish` `failed`.
- "starts a fresh thread after a failed turn or a daemon restart, and stops after three failed turns" — after a timeout the wake has `thread: null, notes: ["your last turn ended timeout"]`; after `daemon.started`, `fresh` is "the daemon restarted"; three failed turns → `finish` `failed`.
- "runs a requested check and wakes the architect with its result" — `runCheck C1` issued; after `check.done`, no `runCheck` and a wake.
- "finishing stops the tasks still running, then ends the run with the verdict's outcome" — `cancel [T1's id]`, then `finish done`, and no wake after the architect's own end.
- "an owner's cancel stops every role, the architect's turn included, then ends cancelled".
- "a pause holds new tasks and turns; reading a finished task drops its digest line".
- "an owner's answer wakes the architect; a 2.0 run has no architect state" — `question.parked` (owner) during the turn, the turn ends → no wake; `question.answered` → no questions, a wake; a 2.0 `run.started` → `{ engine: "2.0", arch: null, phase: "planning" }`.
Test: test/services/architect-daemon.test.ts — "wakes the architect, runs the task it delegated, wakes it with the result, and ends when it finishes" — `runDaemon` with scripted effects (a dispatch appends `dispatch.started` with its `upTo`, architect-1 also `task.delegated T1`, architect-2 `run.finishing done`, then `dispatch.ended` with thread `th-<name>`; `finish` appends `run.ended`) and a driven clock → `"ended"`; actions `["architect-1", "T1", "architect-2", "finish"]`; the third has `thread: "th-architect-1"`, brief `wake`; the last event `run.ended done`.

- [ ] Implement; the tests pass; `bun test test/domain test/services/run-daemon.test.ts test/architecture.test.ts`; `bun run typecheck && bun run lint`.
- [ ] Commit (suggested): `feat(engine): the architect engine's state and machine`

### Task 7: The effects: turns, tasks, checks, the report

Files: src/services/architect-run.ts (new), src/services/architect-check.ts (new), src/services/run-briefs.ts, src/services/run-effects.ts, src/services/run-events-store.ts, src/services/admission.ts, src/services/run-store.ts, test/services/architect-run.test.ts (new), test/services/architect-check.test.ts (new), test/services/architect-effects.test.ts (new), test/services/lanes-run.test.ts

run-events-store.ts `runEngine` (Contracts): `onFile(run)` → `"2.0"`; else `SELECT json_extract(body, '$.engine') AS engine FROM events WHERE run_id = ? AND type = 'run.started' LIMIT 1` → `"architect"` or `"2.0"`.

admission.ts (R12): `rc` = the profile's role, but `{ ...configured, access: "workspace-write" }` when the role is `architect`, its access is `read-only` and `runEngine(run) === "architect"`; every later `rc.access` reads it.

run-store.ts (R18): `ROLE_WRITABLE` also takes `research/[^/]+\.md`; its doc names plan 47 and spec D12.

architect-run.ts (Contracts):
- `wakeBrief`: unit = the goal and acceptance lines (`The run's goal: ${title}.\nIts acceptance lines:\n- …`), the plan files (`plan-input/<name>`, "They are your input, not an approval: you may edit them."), on the first turn (`arch.turns === 0`) the plan lint (`lintPlan(text, id, s.aLines)` for each `## M<n>` heading of each plan file, `- <file>: <warning>`, under "Plan lint, warnings only:"), and where the ledger is. Round = on a fresh thread after the first turn, `` `This is a fresh thread${notes ? ` (${notes.join("; ")})` : ""}: read the ledger, then compare it with git log and the tree before you act.` ``; the digest `What happened since your last turn:\n- #<seq> <text>` for inbox items with `seq <= a.upTo` (else "Nothing new happened since your last turn."); last, the slots line `` `Writers running: ${w} of ${WRITER_CAP}. Standing roles (researcher, writer) running: ${st} of ${STANDING_CAP}. Tasks queued: ${q}. Checks queued or running: ${c}.` ``.
- `taskBrief`: unit `[]`; round = `` `You are task ${id}, a ${role} delegated by ${by}. You have no lane file: this task is your whole brief.` ``, the text of `tasks/<id>/brief.md` (or a STATUS: blocked line when missing), then for a researcher `` `Write your answer to research/${id}.md with catherd run-file write ${run} research/${id}.md, cite file:line for every claim, and reply with that path.` ``, else "Report every file you changed and why, one line each: EXTRA: <path> — <why>.".
- `writeArchitectReport`: `report.md` = title; `Verdict: <verdict> — <why>` (the last `run.finishing`, else the cancel or the reducer's `finishing`); `## Ledger` (`- <id> [<state>] <goal>` or "No ledger task."); `## Progress (last entries)` (the last 5); `## Change log` (every event with `why` and `by`: `` `- ${at} ${type} (${by}): ${why}` ``).

architect-check.ts `runArchitectCheck` (D6, R10): `key` = the run's `startHead` for a base check (E_INPUT_INVALID when there is none), else `worktreeIdentity(run.meta.repo)`. A cached row, unless `fresh`: base → the latest base row of the command at that sha, any exit; else the latest base-0 row of the command on that tree **with exit 0**. Otherwise run: a base check adds `git worktree add --detach <run>/checks/base-<sha12> <sha>` (removed with `--force` in `finally`); `withHeavySlot(heavySlots(runProfile(deps, run).heavy), (_, tmp) => runCheck(cwd, command, o.timeoutMs, { ...checkEnvFor(repo), TMPDIR: tmp, GOTMPDIR: tmp, [LOCK_HELD_ENV]: "1" }), { onWait })`; the output (`lines`, else `tail`) to `checks/<checkId>.log`; `failures` = `checkFailLines` (none on exit 0). `preExisting` = the failures the latest base row of the same command also has (`newFails`). One `insertCheck` row (`ref` = the sha or `"worktree"`, `tree` = the key or null for a base check, `cached`), then return the `check.done` input.

run-briefs.ts: `briefBody` cases `wake` → `wakeBrief`, `task` → `taskBrief`; `renderBrief` passes `engine: s.engine` to `composeBrief`.

run-effects.ts: `start`'s first parameter gains `upTo?: number`, and its `dispatch.started` spreads `upTo` when defined. A `wake(a, s)` (R7): the profile's architect rung (`defaultRung ?? rungs[0]`, headless; none → throw); the reasons = `a.notes`, plus "your last thread is spent" when the last architect record is `threadHeavy` and a thread is set, plus "the architect's rung changed" when `a.rung` is set and differs; `thread` = null when reasons were added, else `a.thread`; render the ledger (`renderLedger(run, taskAttempts(s.arch))`); then `start({ ...a, rung, thread, notes }, (resumed) => renderBrief(run, s, turn, resumed), s, null)`. `perform`: `dispatch` with `brief === "wake"` → `wake`; `runCheck` → `append(await runArchitectCheck(deps, run, s.arch.checks[id], { timeoutMs: effectLimits.checkMs, onWait: waitingOnce(id) }))` (an unknown id throws); `finish`: `s.arch ? writeArchitectReport(run, s, readEvents(run)) : writeRunReport(…)`.

- [ ] Write the tests; run `bun test test/services/architect-run.test.ts test/services/architect-check.test.ts test/services/architect-effects.test.ts test/services/lanes-run.test.ts`: the new tests fail.

Test: test/services/architect-run.test.ts — describe "the architect's briefs (plan 47, spec D1 and D12)":
- "first turn: the goal, the plan files as input, the plan lint once, the digest and the slots last" — a `plan-input/PLAN.md` with `## M1 — core` and no Check → unit contains the goal, `plan-input/PLAN.md` and "PLAN.md: M1: no Check: line"; round is exactly the digest line `#1 the run started: wallet` and the slots line with zeros.
- "a fresh thread after a turn says why and to check the ledger against git; only events up to upTo" — two checks done after turn 1, `upTo` at the first → round[0] is the fresh-thread line naming "the daemon restarted", round[1] names C1 and not C2.
- "a researcher task writes its answer to research/<id>.md; a worker reports each file with its reason".
Test: test/services/architect-check.test.ts — describe "a check the architect asks for (plan 47, spec D6)" (a run with `startHead` from `git rev-parse HEAD` of a `tempRepo`):
- "records its failing lines and its log, and a row in checks" — `echo '(fail) wallet > balance'; exit 1` → `exit 1`, that failure, not cached, the log holds it, one row.
- "reuses a pass on the same tree, never a failure, and reruns on a changed tree or fresh" — `true` → not cached, again → cached, `fresh` → not cached, a new file → not cached; `exit 3` twice → never cached.
- "checks the base on demand, on its start commit, and marks a failure the base has as pre-existing" — an untracked `new.txt` makes the command fail `(fail) new` only on the checkout: base → `["(fail) old"]`; checkout → both, `preExisting: ["(fail) old"]`; the base again → cached.
Test: test/services/architect-effects.test.ts — "runs a delegated task, wakes the architect with a digest, and stops when two turns start nothing" — the fake Codex (`simPath`, `withScenario({ reply: "Done.\nSTATUS: complete — ok" })`), `testView` with the architect on `codex:gpt-6-sol#high`, an architect `run.started`, `tasks/T1/brief.md` and a `task.delegated T1` by `architect`; `runDaemon(deps, run.id, { clock })` with the real effects → `"ended"`; dispatches `T1`, `architect-1`, `architect-2`; architect-1's `dispatch.started` has the rung and an `upTo`; the last event `run.ended failed`; T1's dispatch brief holds the task text and the `EXTRA:` line; architect-1's brief holds `delegate_task`, "The run's goal: wallet.", "the run started: wallet" and `Writers running: <n> of 4`; the architect's record has `access: "workspace-write"`; `report.md` holds "Verdict: stopped — idle" and the delegation's why; `ledger/progress.md` starts "# Progress".
Test: test/services/lanes-run.test.ts — "takes a research answer, and refuses the ledger's renders (plan 47)" — `research/T3.md` written; `ledger/tasks.json`, `ledger/progress.md`, `research/a/b.md` refused "is written by catherd itself".

- [ ] Implement; the tests pass; then the full Check (root and `web/`).
- [ ] Commit (suggested): `feat(engine): architect turns, delegated tasks, checks on demand and the report`

### M2 lanes

- M2.L1 — Task 4 — owns the files Task 4 lists — fast check: `bun test test/domain/profile.test.ts test/domain/run-events.test.ts test/services/run-client.test.ts test/entry/panel-openapi.test.ts && bun run typecheck && bun run lint && cd web && bun run typecheck && bun run test`
- M2.L2 — Task 5 — after M2.L1 — owns src/domain/role-prompts.ts, src/domain/brief.ts, test/domain/architect-contract.test.ts — fast check: `bun test test/domain && bun run typecheck && bun run lint`
- M2.L3 — Task 6 — after M2.L1 — owns the files Task 6 lists — fast check: `bun test test/domain test/services/architect-daemon.test.ts test/services/run-daemon.test.ts test/architecture.test.ts && bun run typecheck && bun run lint`
- M2.L4 — Task 7 — after M2.L2, M2.L3 — owns the files Task 7 lists — fast check: `bun test test/services/architect-run.test.ts test/services/architect-check.test.ts test/services/architect-effects.test.ts test/services/lanes-run.test.ts test/services/admission.test.ts test/services/run-effects.test.ts && bun run typecheck && bun run lint`

## M3 — The architect's tools, standing roles through `delegate_task`

A1 — on the architect engine the architect's role server lists the eleven tools, a worker's and a writer's list `delegate_task`, `task_status` and `thread_wait`; a 2.0 run's role servers are unchanged (Check).
A2 — every tool call is recorded with its why; a worker delegates only to the researcher or the writer and sees only its own tasks (Check).
A3 — a role with no role server calls the same tools with `catherd call <run> <tool>` (Check).
A4 — MIGRATION.md and ideas.md say what plan 47 changed and left out; one changeset names catherd-cli (Check).

Check: bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && catherd lock -- bun test

### Task 8: The tools, the role server and `catherd call`

Files: src/domain/role-tools.ts, src/domain/brief.ts, src/infra/role-mcp.ts, src/adapters/claude-code/index.ts, src/services/admission.ts, src/services/role-access.ts, src/services/doctor-role-mcp.ts, src/services/architect-tools.ts (new), src/entry/mcp/role-server.ts, src/entry/role-cli-command.ts, src/cli.ts, test/services/architect-tools.test.ts (new), test/entry/role-mcp.test.ts, test/entry/role-cli-command.test.ts

role-tools.ts (Contracts): `ARCHITECT_TOOLS`, `DELEGATOR_TOOLS`, `RoleMcpContext.engine?`. `roleMcpTools(role, engine = "2.0")`: as today, plus `write_run_file` for the writer on the architect engine, `...ARCHITECT_TOOLS` for the architect on it, `...DELEGATOR_TOOLS` for a worker or a writer on it. Callers pass the engine: role-mcp.ts and the Claude Code adapter `context.engine` / `r.roleMcp.engine`; admission's `roleMcp: { run, role, engine: runEngine(run) }`; role-access.ts `roleMcpTools(role, runEngine(run))`; doctor-role-mcp.ts `roles.flatMap((r) => roleMcpTools(r))`. brief.ts: `roleNotes` takes `engine` and passes it; `cliForm` of an architect tool is `` `catherd call ${run} ${tool} (its arguments as JSON on stdin)` ``.

architect-tools.ts (Contracts; the doc comment credits T3 Code as team.ts does). `why` = `z.string().min(1).max(300)`; a task id is `/^T\d+$/`; the task roles are every role but `architect` and `judge`. The architect is the caller whose role is `architect`, or `owner`. `taskOf(c, s, id)`: unknown → E_INPUT_INVALID; a non-architect caller and `t.by !== caller.name` → E_ROLE_SCOPE. `workState`: queued → `waiting`, working → `working`, ended `ok/…` → `done`, else `stopped`. Tools:
- `capabilities` {} (read-only): `roles` (each enabled task role with rungs: `{ rungs: headless, default }`), `holds`, `writers {running, cap}`, `standing {running, cap}`, `queued`, `budget: budgetOf(run, profile.budget, now)`.
- `delegate_task` {role, task, rung?, ledgerTask?, why}: a non-architect caller and a non-standing role → E_ROLE_SCOPE; a role off or with no rung → E_INPUT_INVALID; `rung` (headless) not on the role's headless rungs → E_INPUT_INVALID; default `defaultRung ?? rungs[0]`; an unknown `ledgerTask` → E_INPUT_INVALID; under `withEventsLock`: id `T<number of tasks + 1>`, write `tasks/<id>/brief.md` (`task.trim()` + newline), append `task.delegated`. Returns `{ taskId, thread, reportPath }` (`research/<id>.md` for a researcher, else null).
- `task_status` {taskId}: `{ taskId, role, rung, workState, summary (the reply ≤ 2,000 chars + "…"), reportPath, changed (the record's EXTRA lines, then changedOwned and violations with why ""), stopReason, costUsd }`; a finished, unread task read by the architect appends `task.read`.
- `task_cancel` {taskId, why}: not queued or working → its state, nothing appended; else `task.cancelled`, and for a working one `cancel(deps, run.id, taskId)` (E_RUN_NOT_LIVE ignored) → `{ taskId, workState: "stopped" }`.
- `thread_send` {to, text, mode?, kind?, why} (R16): to a task that ended or was cancelled and has a thread → `delegate` the same role, rung and ledger task with `thread` and `text`, append `thread.sent` (`n: 0`, `resumed`), return the delegation plus `delivery: "resumed"`; else `teamSend({ from: caller.name, … kind, mode only when queue })`, append `thread.sent` with its `n` and delivery, return it.
- `thread_read` {from?, since?, limit?, maxChars?}: `teamRead`.
- `thread_wait` {taskIds, timeoutSec ≤ 300 (default 60)}: replay until one of the tasks (each through `taskOf`) is neither queued nor working → `{ taskId, workState, timedOut: false }`; past the deadline `{ taskId: null, workState: null, timedOut: true }`; sleeps `c.pollMs ?? 1000` between reads.
- `check` {command, scope?, base?, fresh?, why}: under the lock, id `C<number of checks + 1>`, append `check.requested` (scope `full`, base and fresh false by default) → `{ checkId }`.
- `ledger` {tasks?: LedgerPatchSchema, progress?, why}: `writeLedger`, append `ledger.changed` (the ids added, set and removed; `progress` true when not blank), `renderLedger` with the replayed attempts → `{ tasks: <count> }`.
- `ask_owner` {question, options?, scope: `run` | `task:T<n>`, stopClass, why} (R15): a unit already waiting → E_INPUT_INVALID; append `question.parked` with `` `(${stopClass}) ${question}` `` and `- <option>` lines, reason `owner`, the why → `{ unit, parked: true }`.
- `finish` {verdict, why}: append `run.finishing` → `{ finishing: verdict }`.
`architectToolsFor(role)`: all for the architect, `DELEGATOR_TOOLS` for a worker or a writer, none else. `callArchitectTool`: `runEngine(run) !== "architect"` → E_ROLE_SCOPE; a non-owner caller without the tool → E_ROLE_SCOPE; `z.object(spec.shape).safeParse(args ?? {})` failing → E_INPUT_INVALID with `z.prettifyError` on one line; else the call.

role-server.ts: `const engine = runEngine(run)`; `tools = new Set(roleMcpTools(context.role, engine))`; after the team tools, for each `ARCHITECT_TOOLS` entry in `tools`, `registerTool(tool, { description, inputSchema: spec.shape, annotations: { readOnlyHint: spec.readOnly, destructiveHint: false, openWorldHint: false } }, (a) => call(tool, () => callArchitectTool({ deps, run, caller: { name: from(), role: context.role } }, tool, a)))`.

role-cli-command.ts `callCommand` (R13): args `run`, `tool` (positional); an unknown tool → E_INPUT_INVALID; `assertRoleMay(scope(), run, tool)`; stdin parsed as JSON (empty → `{}`, not JSON → E_INPUT_INVALID); the caller is the role's dispatch name and role, or `{ name: "owner", role: "architect" }`; `printJson` of the result. cli.ts: `call: () => import("./entry/role-cli-command.ts").then((m) => m.callCommand)` after `team`.

- [ ] Write the tests; `bun test test/services/architect-tools.test.ts test/entry/role-mcp.test.ts test/entry/role-cli-command.test.ts` fails.

Test: test/services/architect-tools.test.ts — describe "the architect's tools (plan 47, spec D3 and D12)" (`testView` plus a researcher on `codex:gpt-6-luna#high`; callers `architect-1` and `T1` the worker):
- "delegate_task writes the brief, appends task.delegated with the why, and returns at once" — `{ taskId: "T1", thread: null, reportPath: null }`, the brief file, the event with the default rung `codex:gpt-6-luna#high`; a researcher → `T2`, `research/T2.md`.
- "refuses a rung off the role's ladder, an unknown ledger task, and a role the profile turns off" — and `role: "architect"` fails the schema.
- "a worker delegates only to the standing roles and sees only its own tasks (D12)" — worker → worker refused E_ROLE_SCOPE; → researcher `T2`; its `task_status` T2 `waiting`, T1 E_ROLE_SCOPE; its `check` E_ROLE_SCOPE.
- "task_cancel stops a queued task; task_status of a finished one marks it read once".
- "thread_send queues a message to a task and records it; to a finished task it resumes its thread" — `{ n: 1, delivery: "queued" }` and the `thread.sent` event; after T1 ends on thread `th-1`, a send → `{ taskId: "T2", thread: "th-1", delivery: "resumed" }`, T2 queued on `th-1`; `thread_read { from: "architect-1" }` one message.
- "thread_wait returns at a task's end and times out on a running one".
- "check, ledger, ask_owner and finish append what the daemon acts on, each with its why" — `C1`; the ledger rows, event and render; `ask_owner` without `stopClass` E_INPUT_INVALID, with it the parked question `(production) …\n- yes\n- no`; `finish` sets `arch.finishing`.
- "capabilities names each role's rungs, the slots and the budget; a 2.0 run has none of these tools".
Test: test/entry/role-mcp.test.ts — "an architect run's architect gets the loop's tools; its workers and writers the standing-role ones (plan 47)" — the exact sorted tool lists for the architect and the worker; the writer has `write_run_file`; `delegate_task` over MCP returns `T1`; without `why` it is an error. The existing "exposes only each role's allowed tools" (a 2.0 run) passes unchanged.
Test: test/entry/role-cli-command.test.ts — "calls an architect-engine tool with JSON on stdin, bound to the role's own tools (plan 47)" — a worker `T1` calling `finish` fails with E_ROLE_SCOPE; the owner's `finish` prints `{ finishing: "done" }` and appends `run.finishing` by `owner`; an unknown tool E_INPUT_INVALID.

- [ ] Implement; the tests pass; `bun test test/entry test/wait-residue.test.ts test/services/doctor-role-mcp.test.ts`; then the full Check.
- [ ] Commit (suggested): `feat(architect): the architect's tools on the role server and catherd call`

### Task 9: Docs and the changeset

Files: MIGRATION.md, docs/dev/ideas.md, .changeset/plan-47-architect-loop.md (new)

MIGRATION.md, under "From 1.5 to 2.0", before "### Grok Build and Antigravity are removed": "### The architect loop, behind a switch (plan 47)" — `engine: architect` (`catherd profile set engine architect`) starts runs the architect drives, through its tools, with a ledger in `ledger/`; every other profile runs the 2.0 pipeline; on this engine the architect runs `workspace-write` when its profile says `read-only`, the run takes no `base` yet, and plan files are input, not an approval; a role with no role server calls the tools with `catherd call <run> <tool>`, JSON on stdin. docs/dev/ideas.md, above "### From plan 46": "### From plan 47 (the architect loop)" — the 70% context threshold (R7), the fixed writer cap (R9), the run's checkout only (R10), messages do not wake the architect (R5), any research file is writable (R18). Changeset (minor): "The architect loop, behind `engine: architect` in a profile: the architect is woken by events, delegates tasks, runs checks, keeps a ledger and finishes the run through its tools, and the researcher and the writer are on call to it and to workers through `delegate_task`. Every other run keeps the 2.0 pipeline."

- [ ] Write; `bun run format:check`.
- [ ] Commit (suggested): `docs: the architect loop in MIGRATION.md and ideas.md; changeset for plan 47`

### M3 lanes

- M3.L1 — Task 8 — owns the files Task 8 lists — fast check: `bun test test/services/architect-tools.test.ts test/entry test/wait-residue.test.ts test/services/doctor-role-mcp.test.ts && bun run typecheck && bun run lint`
- M3.L2 — Task 9 — owns the files Task 9 lists — fast check: `bun run format:check`

## Edge cases

- A daemon restart in the middle of a turn: `daemon.started` re-watches the live turn and sets `fresh`; the next turn starts a fresh thread from the ledger.
- A wake whose admission is refused (a held quota, the budget): `dispatch.refused` on `run` counts as a failed turn and wakes again; three in a row end the run.
- `finish` while the architect's own turn runs: the other tasks are cancelled, `run.ended` is written, and the daemon waits for the architect's process before it leaves (its settle is in flight).
- An architect run's `run.started` with plan files: the files are copied as input; nothing waits for an approval.
- A question the architect parked and the owner answered while a turn runs: the answer is a waking item delivered at the next turn.
- A task delegated over its cap stays `queued` and starts in the same `architectNext` call that sees a slot free.
- `thread_send` to a task with no thread yet (queued, or ended with none): a team message, never a resume.
- `check {base: true}` on a run with no start commit: E_INPUT_INVALID, as an `effect.failed` that wakes the architect.

## Out of scope

- Deleting anything of the 2.0 machine (plan 48 onward); the reducer of D4 replacing `next`.
- D10's caps (wall, cost, attempts, the 15-minute idle, the 80% wake, the grace) and stall fingerprints; `impossible` from a worker (plan 48).
- Ladders and escalation (D7), the decision model's deletion (plan 49); `delegate_task` takes any rung on the role's list and climbs nothing.
- `land`, the integration tree, a base run on this engine (plans 50 and 52); per-writer trees, merges and the oracle rule (stage 2).
- Cross-family review defaults and the review lines of D8 (plan 51); memory (D14, stage 3).
- The panel's view of the ledger: it reads the run folder's files as for any run.

## Next plans (the rest of stage 1)

Each is one plan, merged in this order, every deletion after its replacement. All run on the shared tree (stage 2 brings per-writer trees). Each plan writer pre-validates against the merged head of the previous one.

- **Plan 48 — the reducer (D4), caps and stall (D10).** The architect engine becomes the default and its machine the reducer: `next(state, event) → actions[]` over dispatch, check, merge, wake and cap events only (today's `architectNext` plus caps and stall); the `caps` table and D10's caps (12 h wall, budget, 4 attempts per ledger task, the 15-minute idle on top of plan 47's idle rule; the 80% wake; the 10-minute grace); stall fingerprints on `dispatches` and the refusal with "stalled"; `impossible` from a worker and from the architect; the 2.0 machine's run of a new run goes, and the `engine` switch with it. Deleted after the reducer runs: milestone and round transitions (`laneActions`, `fixActions`, `reviewActions`, `milestoneActions`, `architectAgain`, `planningActions`, `approvalActions`, `onLaneStopped`, `waitsForSibling`, `afterReady`), the `floors` and `failedOn` retry floors (`run-state.ts:829`), the admission tick (`REFUSAL_WAIT_MS` and admit-order refusals), the auto-rerun of a red check (`milestone-check.ts:243-262`) and the automatic baseline, the judge role and its calls, rule review and `rules.ts`, the 2.0 architect contract and the 2.0 half of `applyArchitect`'s fallback (R2); the event schema version bumps, and D16's refusal to drive an earlier build's run lands with it; the lock files of plan 46's R4 go as writes become single transactions.
- **Plan 49 — ladders (D7) and the decision model's deletion.** Each role's rungs become its ladder (first = default), a `delegate_task` rung off the ladder refused (plan 47 already does), a climb only after `failed`, `timeout`, `too_hard` or a review BLOCKER; `init`'s defaults (a flash-class worker first; a verifier ladder of rungs that run commands; R2's cross-family architect). ProfileService's migration per D16: drop `judge`, `decision` and `bars`; rungs to ladders in intelligence order; the architect `workspace-write` (plan 47's admission override, R12, goes); `caps` and an empty `memory` block; each dropped key named by `profile validate`. Deleted: `decision.ts`, `decision-client.ts`, `decision-service.ts`, the `decide` action and `decision.*` events, routing by bars and objective (`route.ts`, `select.ts`, `routing-service.ts` shrink), `routes.jsonl` and `outcomes.jsonl`, `test/fixtures/decision/`.
- **Plan 50 — landing (D11), the integration tree and the one verifier (D8).** One integration tree per repo per run, so an architect run takes a `base` again (plan 47's R10 refusal goes) and `check {ref}` names a ref; `land` pushes and opens or updates one MR per repo per run with no park, never the base, never a force-push of a branch the run did not create; `land {final}` needs a green full check and a verifier PASS on the pushed sha, fetches the base and reruns the full check when landed base commits touch the run's diff ("the base moved"), then asks the owner one question; the MR body leads with the problem, then the change, one proof line, and the audit block last (every `why` from plan 47's events, Known issues, deleted or skipped tests); the verifier once on the integrated product, its `RAN:` lines required on runnable lines, a bug task's `RUN:` run on base and head ("reproduce, then fix", on plan 47's `check {base}`). Deleted after: the "push" and "merged: MR !N" parks, `E_LAND_GATE`, the merge wait in `milestones.ts`, the milestone-per-branch mode and stacked MRs, the acceptance milestone (`role-prompts.ts`, `run-graph.ts`, `gate-brief.ts`, `verifier-step.ts`), and the verifier role lock (`withRoleLock`, `roleLockOwner`, its caller at `milestone-check.ts:224`, the role slots in `lock-command.ts`).
- **Plan 51 — reviews that converge, the ui-reviewer fold, and the stage-1 measurement.** D8's review lines: cross-family by default (the first reviewer rung of another family; `same-family` marked in the digest and the MR audit when none exists), one reviewer per call, findings with `important | nit | pre-existing` (a `pre-existing` one never starts a fix round), a finding names its bug class, a re-review sees only the diff since the last one and never re-reports, a fourth round on one task is refused in favour of a replan, depth by the change (money, auth, migrations, CI), each finding's handling recorded; the reviewer-scope contract line. The ui-reviewer folds into the reviewer (a reviewer brief that names the screens to open; an image-capable rung appended to the reviewer ladder by the profile migration; then `ui-reviewer` dropped from profiles, its prompt and role deleted). The D17 metrics as views over the database (idle %, average concurrency, blocked minutes by reason, check share of wall from plan 47's `checks` rows, rounds per task, cost, standing-role start latency) and a per-task comparison over at least two runs each; the remaining files of plan 46's R5 moved or deleted.
