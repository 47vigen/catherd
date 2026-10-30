# Run Flow View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show architect runs as a live timeline of their ledger tasks, roles, checks and evidenced idle time.

**Architecture:** One pure domain derivation produces `RunModel.flow`; the existing graph model remains the drawer's selection model and the legacy presentation. The service reads database rows, the existing socket replaces the flow snapshot in each patch, and the frontend renders it without redoing metrics or inferring task ownership.

**Tech Stack:** Bun ≥ 1.4, TypeScript, Zod, React 19, TanStack Query/Router, HeroUI v3, SVG, Vitest and Playwright. No new dependencies.

**Spec:** `docs/specs/2026-10-30-run-flow-view.md`.

## Global Constraints

- Work from `flow-view` at `48053ba`; preserve other tasks' edits. No branch reset/switch, commit, push, MR or release in this run unless the architect separately authorizes it.
- Change only the flow feature and its tests/docs. Keep `domain → infra → adapters → services → entry` imports legal.
- “Keep it one pure function with unit tests”; “Reuse the Metrics tile data”; “reuse it, do not build a second drawer.”
- “thin bars (about 14px)”; “Correct in dark and light mode”; “no page scroll sideways.”
- English copy, HeroUI tokens and `web/src/conventions.test.ts` apply. No inline React `style`, extra CSS files, virtualization or graph-library replacement.
- Heavy builds and full suites use `catherd lock -- <cmd>`; independent jobs may start together, at most three. Reuse caches, separate mutable build outputs by worktree, never set a proxy. Baseline root/panel gates are already queued: consume their reports rather than duplicate them.
- Tests must not contact models. Use explicit spawned-process environments, empty `ANTHROPIC_API_KEY`, deterministic timestamps and no correctness sleeps.

## Review Focus

1. Null, removed or nonexistent ledger links: all actual activity remains visible without inventing dependencies or task membership (Tasks 1–3).
2. Overlapping roles, checks and simultaneous waits: idle is the complement of role activity, with deterministic evidence and no double counting (Task 1).
3. A request that is still open, a missing completion, or a stopped run: live intervals grow; finished runs freeze; unknown time stays unknown (Tasks 1–3).
4. Limits across shared quota identities and successful recovery: holds expire or clear using reducer semantics; a changed rung is not automatically a stronger model (Task 1).
5. Socket replay, selection and manual horizontal navigation: patches remain idempotent, the chosen attempt stays selected, and the view never drags a reader back to now after they scroll away (Tasks 2–4).

## Source map and rulings

Exact checkout has no codebase-memory index (architect's confirmed coverage result); use scoped source reads, never the separate `/root/lab/catherd` graph. Sources checked at `48053ba`:

| Source | Existing contract and consequence |
| --- | --- |
| `src/services/run-model.ts:14`, `src/domain/run-graph.ts:190` | `runModel()` reads events/records, replays, calls `deriveRunModel`; graph nodes already identify architect, delegated tasks and checks. Add flow beside them. |
| `src/services/ledger-store.ts:25`, `src/domain/ledger.ts:102` | `ledgerTasks()` reads `ORDER BY pos`; derive display state with `ledgerView(tasks, taskAttempts(replay(events).arch))`. Preserve task `depends` and order, including tasks with no dispatch. |
| `src/domain/run-events.ts:186`, `src/domain/architect-state.ts:33` | `task.delegated.ledgerTask` is nullable; task IDs (`T1`) differ from ledger IDs (`L1`). Join dispatch `name` to delegated `taskId`, then use only its explicit ledger link. |
| `src/domain/run-events.ts:218`, `src/infra/db.ts:33` | Checks have no ledger task field. They are run-scoped. A caller's task does not prove check ownership. |
| `src/domain/run-graph.ts:270` | Existing check attempt starts at done minus minutes, which differs from request time. Flow starts at `check.requested.at` and ends at `check.done.at`. Do not copy graph timing. |
| `src/infra/db.ts:17`, `src/services/legacy-import.ts:10`, `src/services/run-events-store.ts:119` | Actual flag is SQLite `runs.legacy` (integer 0/1), not `RunView.legacy`. Public engine is only `"2.0" | "1.5"`. `isEarlierRun()` also catches file-backed and old-schema runs. |
| `src/services/run-metrics.ts:35`, `src/services/run-read.ts:204` | Existing `RunView.metrics` owns all arithmetic; use `wallMin`, `idlePct`, `concurrency`, `checkShare`, `rounds.total`, `costUsd` directly. State comes from RunView phase/outcome, not a second metric. |
| `src/entry/panel/server.ts:189`, `:590` | Initial socket base uses `modelBefore()` and later snapshots use `runModel()`. First diff must carry full current flow even if the historical graph-only base has null flow. |
| `web/src/routes/_app/runs/-components/drawer/NodeDrawer.tsx:101` | Drawer takes nodeId and attemptId, selects a dispatch and fetches its existing detail endpoint. Preserve this path. |
| `src/services/run-files.ts:205`, `web/src/routes/_app/runs/-components/drawer/ChecksTab.tsx:31` | Current Checks tab reads `scratch/worker-<lane>/*-check.log`, not architect checks. Add flow check details inside this tab/drawer, never send a check ID to the lane-log endpoint. |

Rulings for the architect to retain in dispatch briefs:

- Flow eligibility: daemon run, database `legacy != 1`, and `!isEarlierRun(run)`. Otherwise `flow: null`; retain existing graph/list/table behavior, including the 1.5 records table. Missing DB row alone does not classify an old file run as modern. No public engine rename or schema migration.
- Rows: architect first, current ledger tasks in database order, then an optional **Unassigned roles** row, then an optional **Run checks** row, idle last. Removed ledger references go under Unassigned roles with their original ledgerTask shown. All checks live under Run checks until a future persisted explicit link exists. Never copy checks onto several task rows.
- Show every dispatch (including artist/unknown stored role labels) and check once. Queued/refused delegations that never started do not get fictitious duration bars; ledger state still appears. Completed record-only dispatches use their recorded timestamps and null provenance. Event endpoints win over records. A row-only check has unknown request time, displayed as a timing-unknown marker at completion rather than a guessed bar.
- Match architect causes by exact `by === turn.name`, not event proximity. Include ledger.changed/task.delegated/check.requested whys; preserve unmatched or ambiguous causes in `flow.causes` with null turnDispatchId. For non-architect dispatches, why is task.delegated.why, falling back to dispatch.ended.why then record.replyWhy. Architect summary/why is dispatch.ended.why, falling back to record.replyWhy; the existing Output tab still provides the full reply.
- Rung marker: a later dispatch for the same ledger task **and role**, or next architect turn, whose rung differs from its predecessor gets `climbFrom`. Label it “Rung changed” and show both values: there is no persisted ladder ordering in these inputs. Different roles' rungs are not compared.
- A nonzero or null check exit gets a danger edge even if its verdict is inherited and it counts as passing elsewhere. Limit gets a warning marker; failed, timeout, cli-too-old and cancelled dispatches get a danger edge. Preserve raw status and replyStatus separately.

## Shared contracts (freeze before parallel dispatch)

Task 1 owns these domain exports in new `src/domain/run-flow.ts`, with matching exported Zod schemas (use existing role/status/ledger enums). All wire timestamps are ISO strings; null end means open, never an evaluated “now”. `now` is epoch milliseconds and is explicit input. Arrays are oldest first unless ledger order is specified.

```ts
import type { LedgerTask, LedgerState } from "./ledger.ts";
import type { RunRecord, RunStatus, ReplyStatus } from "./record.ts";
import type { RunEvent, ParkReason } from "./run-events.ts";

export interface FlowSelection { nodeId: string; attemptId: string | null }
export interface FlowInterval { startedAt: string; endedAt: string | null }
export interface FlowCause {
  seq: number; at: string; by: string; why: string;
  type: "ledger.changed" | "task.delegated" | "check.requested";
  turnDispatchId: string | null;
}
export interface FlowDispatch extends FlowInterval {
  dispatchId: string; name: string; role: string; taskId: string | null;
  ledgerTask: string | null; rung: string;
  status: RunStatus | "running"; replyStatus: ReplyStatus | null;
  why: string | null; costUsd: number | null; climbFrom: string | null;
  selection: FlowSelection;
}
export interface FlowTurn extends FlowDispatch { causeSeqs: number[] }
export interface FlowCheck {
  checkId: string; scope: string; base: boolean; command: string;
  startedAt: string | null; endedAt: string | null;
  exit: number | null; failureCount: number | null;
  verdict: "pass" | "inherited" | "new" | "unknown" | null;
  newFailures: number | null; inheritedFailures: number | null;
  failures: string[]; preExisting: string[]; cached: boolean;
  logPath: string | null; why: string | null; selection: FlowSelection;
}
export interface FlowTask {
  id: string; goal: string; state: LedgerState; depends: string[];
  dispatchIds: string[];
}
export interface FlowOwnerWait extends FlowInterval {
  unit: string; question: string | null; reason: ParkReason | "paused";
  evidenceSeqs: number[];
}
export interface FlowQuotaHold extends FlowInterval {
  quota: string; until: string; evidenceSeqs: number[];
}
export interface FlowIdle extends FlowInterval {
  reason: "owner" | "quota" | "check" | "gap"; evidenceSeqs: number[];
}
// Structural projection of infra CheckRow: domain does not import infra.
export interface FlowCheckRecord {
  checkId: string; scope: string; command: string; base: boolean;
  exit: number | null; failures: string[]; at: string;
  cached: boolean; verdict?: string | null;
}
export interface RunFlow {
  startedAt: string; endedAt: string | null; asOf: string;
  architect: FlowTurn[]; tasks: FlowTask[]; dispatches: FlowDispatch[];
  checks: FlowCheck[]; causes: FlowCause[];
  ownerWaits: FlowOwnerWait[]; quotaHolds: FlowQuotaHold[]; idle: FlowIdle[];
}
export interface RunFlowInput {
  startedAt: string; now: number; events: readonly RunEvent[];
  records: readonly RunRecord[]; ledgerTasks: readonly LedgerTask[];
  checks: readonly FlowCheckRecord[];
}
export function deriveRunFlow(input: RunFlowInput): RunFlow;
```

`RunFlow.dispatches` contains non-architect dispatches; architect turns appear only in `architect`. `FlowTask.dispatchIds` indexes dispatches; the unassigned row uses those not referenced by a current task. No duplicated bar records. `asOf` is the evaluated end (run.ended.at, else now), not a cache version; `RunModel.seq` remains the patch ordering key.

Export `RunFlowSchema`, `FlowSelectionSchema`, `FlowIntervalSchema`, `FlowCauseSchema`, `FlowDispatchSchema`, `FlowTurnSchema`, `FlowCheckSchema`, `FlowTaskSchema`, `FlowOwnerWaitSchema`, `FlowQuotaHoldSchema` and `FlowIdleSchema` with the fields above. Input-only RunFlowInput/FlowCheckRecord need no wire schemas.

Task 1 adds **required nullable** `flow: RunFlow | null` to `RunModelSchema` and `RunModelPatchSchema`; `deriveRunModel()` defaults flow to null and the service fills it. `diffRunModel()` always includes `b.flow` as a full replacement. Task 2's `applyPatch()` assigns `patch.flow`, including null, after the existing stale-seq guard. No partial flow merge or second socket.

Drawer selection contract:

- Architect dispatch: `{nodeId: "architect", attemptId: dispatchId}`.
- Delegated/record dispatch: `{nodeId: "task/" + name, attemptId: dispatchId}`. If missing from graph nodes, frontend adds a drawer-only RunNode/Attempt projection using flow data; no fake backend task or provenance. Keep existing nodes/attempts when present.
- Completed check: `{nodeId: "check/" + checkId, attemptId: "check:" + checkDone.seq}` matches today's graph attempt. Requested/open or row-only check: same nodeId, null attemptId. Frontend provides a drawer-only node if absent, and renders flow check details regardless of whether an old Attempt exists.
- `RunFlowView` prop contract: `{ flow: RunFlow; run: RunView; now: number; selected?: string; onOpen: (selection: FlowSelection) => void; onExpand?: () => void; fill?: boolean }`. Types come from generated client. Route maps selection to existing `node`, `attempt`, `tab: "overview"` search fields. Existing graph `open(id)` remains usable.

## Task 1: Domain derivation, database assembly and API (backend owner)

**Files:** Create `src/domain/run-flow.ts`, `src/services/run-flow.ts`, `test/domain/run-flow.test.ts`, `test/services/run-flow.test.ts`. Modify `src/domain/run-graph.ts`, `src/services/run-model.ts`, `src/entry/panel/openapi.ts`, `test/domain/run-graph.test.ts`, `test/services/run-model.test.ts`, `test/entry/panel-server.test.ts`. Own API artifacts `web/openapi.json` and generated `web/src/client/`.

**Interfaces:** Produce the Shared contracts exactly; `flowOf(run: Run, events: RunEvent[], records: RunRecord[], now: number): RunFlow | null` in the new service reads legacy, ordered ledger tasks and check rows and calls deriveRunFlow. `runModel(runId: string)` retains its signature. Do not put DB/file reads inside domain code.

- [ ] Add failing unit tests using fixed second offsets: roles busy [1,4) and limiter [10,11), check [2,7), owner [8,10), limit at 11 with HOLD_MS expiry at 1811, run [0,1815). Assert idle gap [0,1), check [4,7), gap [7,8), owner [8,10), quota [11,1811), gap [1811,1815); owner/quota intervals must be backed by their events. Run `bun test test/domain/run-flow.test.ts` and observe assertion failures/missing export.
- [ ] Implement derivation: sort a copy by seq, join starts/ends by dispatchId/checkId; use record and check-row data only as fallback. Preserve input arrays. Merge roles' half-open busy intervals, subtract their union from run bounds and split idle at all wait boundaries. Checks do not count as roles. Ignore zero-width spans in the idle sweep (keep zero-duration activity markers in output). Stop all intervals at run.ended even when their completion is absent; preserve observed raw running status but freeze duration there.
- [ ] Fold owner intervals from question.parked to question.answered (same unit), replacement question, or run end; include run.paused → run.resumed as owner reason paused. Any actual parked question is an owner wait; a blocked reply alone is not. Build quota spans using tryParseRung/quotaOf/HOLD_MS: limit opens/extends the quota, ok+complete clears it, expiry closes it without needing a tick. Preserve active hold's `until` and null endedAt. Malformed rungs give a warning bar but no invented quota.
- [ ] Resolve simultaneous idle reasons by **owner > quota > check > gap**; evidenceSeqs names every active source of the chosen reason, sorted unique. Merge adjacent segments only when reason and evidence match. Gap has no evidence. Keep full owner/quota spans even while roles work; only the no-role complement appears in idle. Live tail endedAt is null; closed historical segments have finite ends.
- [ ] Add the five Review Focus tests: overlapping roles/checks/waits with priority switches; multiple limit events on one shared quota and early successful clear; ordered/empty/removed ledger tasks plus null and unknown links; open architect/role/check/question and ended-without-done freeze; exact caller whys and same-role rung changes across retries. Assert requested start (not done minus minutes), cached/base checks and unique dispatch/check output too.
- [ ] Split check failures only when an event supplies comparable data: verdict new/inherited/pass gives `inheritedFailures = intersection(failures, preExisting).length`, `newFailures = failureCount - inheritedFailures`. Missing verdict, unknown verdict, or row-only historical data leaves both split counts null. Total count remains available once completed. Requested check failureCount is null, not zero. Never turn an inherited exit 1 into exit 0.
- [ ] Implement service assembly and eligibility; register RunFlow and named Flow* schemas in OpenAPI components. Add tests for real DB legacy=1, earlier files/schema, modern empty run, check row-only fallback, and no new filesystem writes. Preserve existing graph models/drawer IDs. A record-only dispatch uses exact stored times; events remain authoritative when present.
- [ ] Verify graph diff includes flow on first patch when modelBefore supplied null; server patch/fetch schemas parse and old graph still works. Run `bun test test/domain/run-flow.test.ts test/domain/run-graph.test.ts test/services/run-flow.test.ts test/services/run-model.test.ts test/entry/panel-server.test.ts` and `bun run typecheck`; expect clean exit.
- [ ] Generate API once: root `bun run panel:openapi`, then `(cd web && bun run gen)`. Send frontend/e2e owners the contract completion and generated paths. Other owners must not regenerate concurrently.

## Task 2: Flow presentation, selection and live behavior (frontend owner)

**Files:** Create `web/src/routes/_app/runs/-components/flow/RunFlowView.tsx`, `RunFlowView.test.tsx` in that directory, `web/src/routes/_app/runs/-lib/flow-view.ts`, `flow-view.test.ts`, `web/src/routes/_app/runs/-hooks/useFlowFollow.ts`, `useFlowFollow.test.ts`. Modify `web/src/routes/_app/runs/$runId.tsx`, `-lib/apply-patch.ts`, `-lib/apply-patch.test.ts`, `-components/drawer/NodeDrawer.tsx`, `-components/drawer/ChecksTab.tsx`, `-route.test.tsx` (all under that run route). Update existing test fixtures requiring nullable flow; do not hand-edit generated client.

**Interfaces:** Consume Shared contracts; export `RunFlowView(props)` exactly as above and `drawerModel(model: RunModel): RunModel` from flow-view.ts for missing graph targets. Drawer receives that model, finds flow architect/check data by selected node/dispatch, and keeps existing dispatch detail queries. No backend changes in this task.

- [ ] Write failing component tests with 8 task rows in ledger order, architect first/idle last, dependencies and task chip/goal visible, unassigned role and run-check rows, overlapping attempts each keyboard reachable. Assert failure/cancel danger, limit warning, rung-change marker, hover/focus role/rung/status/duration, and no empty-state crash. Run `(cd web && bun run test src/routes/_app/runs/-components/flow/RunFlowView.test.tsx)`; expect failure before implementation.
- [ ] Render one shared time axis using SVG positional attributes (`x`, `width`, `viewBox`) and token classes; avoid inline style. Role-family mapping: worker/writer/artist → accent; reviewer/verifier → success; researcher → warning; checks → muted/surface-secondary; architect → foreground. Keep explicit text/legend and marker shapes so color alone conveys nothing essential. Use 14px visible bars inside focusable targets at least 28px tall, hairline separators, Geist Mono/tabular figures, surface/border/foreground/muted/accent/success/warning/danger tokens. Stack simultaneous bars into subtracks rather than hiding overlap. Use 2px minimum width for zero-duration known events and a distinct timing-unknown marker for row-only checks.
- [ ] Place stat strip immediately above flow: state from run.phase/outcome; wall time, idle %, concurrency, check share (`*100` only for formatting), rounds.total and costUsd from run.metrics. Missing metrics show “–”. Reuse existing formatters and Metrics data; do not derive percentages or costs from flow. Keep the existing Metrics tile for its additional facts.
- [ ] Keep label column sticky at 152px with truncated goal and accessible full text. Put tracks in a contained `min-w-0 max-w-full overflow-x-auto overscroll-x-contain` card, minimum track width 960px, scale at least 2px/sec and expand for elapsed time. SVG width is an attribute. All tracks share the same scale and scroll offset, with labels fixed and one axis. Phone shows the same flow, replacing the current phone node list for eligible runs. Existing graph/list/fullscreen remain for null flow; fullscreen flow uses the same component/selection logic.
- [ ] Test bar activation through the route: worker dispatch sets exact node+attempt and opens existing drawer; check opens its overview and Checks tab with scope/base/command/request/end/exit/failure split/cached state/logPath text; architect opens summary and caused-event whys plus existing Output tab. Show “Failure split unavailable” for unknown; a logPath is evidence text, never a new arbitrary file-fetch endpoint. Legacy checks retain their lane-log path. Test live requested check with no Attempt and record-only dispatch drawer projection.
- [ ] Add patch tests for full flow replacement, null replacement, new unassigned dispatch, equal/older seq rejection and final-run freeze. Feed a FakeSocket frame in -route.test.tsx and assert new bar/ledger state/idle update without reload; reconnect invalidation follows existing useLiveRun behavior. The modelBefore null baseline must not blank current flow.
- [ ] Implement useFlowFollow: ticker advances open ends and now line only while live, initial follow keeps now within a 48px right margin. User wheel/touch/pointer/key navigation away disables follow; programmatic scrolling does not. A “Follow now” button re-enables it. Stop following on run end/unmount/run change; clean listeners/timers. Invalidate getRunModel once at an active quota hold's future until boundary so a local growing idle tail cannot keep showing quota after expiry. Reuse the route ticker/socket; do not add polling or a second connection.
- [ ] Verify pure geometry/follow tests with mocked dimensions and fake clock: open bars grow, closed bars do not, user scroll opt-out survives patches, follow resumes explicitly, quota boundary refresh fires once, reduced motion requires no animation. Run `(cd web && bun run test src/routes/_app/runs)` plus `(cd web && bun run test src/conventions.test.ts)` and `(cd web && bun run typecheck)`; expect clean exit after Task 1 generation lands.

## Task 3: Seeded browser acceptance (e2e owner)

**Files:** Create `test/panel-flow-fixture.ts`, `web/e2e/run-flow.spec.ts`; modify `test/panel-e2e-serve.ts`, `web/e2e/helpers.ts`. Own these files independently of backend/frontend owners.

**Interfaces:** Export `seedFlowRun(deps: Deps, repo: string): Promise<{id: string}>` from panel-flow-fixture.ts. Seed current-schema database rows/events through existing runStart/writeLedger/appendEvent/appendRecord/insertCheck helpers, no vendor process or daemon. State JSON gets `flow: {id: string}`; E2eState mirrors it. Existing `live` fixture still drives socket changes through its event URL. Consume generated API/UI contracts without editing them.

- [ ] Add a deterministic fixture with at least 8 ledger tasks (one empty, one blocked, dependencies), two architect turns and their matching whys, overlapping worker/writer/researcher/reviewer/verifier attempts, one same-role rung change, one limit and actual hold, owner wait, plain gap, failed full check with one new/one inherited failure, passing cached/base checks and one unassigned dispatch. Seed completed run at fixed times for stable review screenshots. Existing live fixture covers open intervals; add a modern live requested check there for real socket acceptance. Existing legacy fixture remains unchanged.
- [ ] Write failing Playwright assertions: flow exists and graph is absent for seeded architect run; eight ordered task labels, idle gap and warning/danger/rung markers; worker/check/architect click opens the reused drawer and correct content; legacy fixture still presents graph. At 390×844 assert document.scrollWidth <= viewport width, track.scrollWidth > track.clientWidth, label bounding x unchanged after track scroll. Test live check requested/done and role ended via appendEvent and assert bar/idle update without reload. Assert collected console errors are empty.
- [ ] Use R1's browser harness recipe/report from this run for environment startup, authentication and screenshots; do not repeat harness investigation. Expected native sequence after Task 1/2 integration is root `(cd web && catherd lock -- bun run build)` then `(cd web && catherd lock -- bun run e2e -- e2e/run-flow.spec.ts)`; retain existing e2e runner's managed server behavior. Save evidence under a unique $TMPDIR run-specific directory and record the actual command/exit/log path. Run existing run-page.spec.ts too, since it covers legacy drawer behavior.

## Task 4: Combined gates, review and release note (integration owner)

**Files:** Add `.changeset/<unique-flow-view-name>.md` with a minor `catherd-cli` entry describing the architect run flow view; record implementation rulings/checks/screenshots in the run's artifacts. No package version edit or release.

- [ ] Integrate backend and frontend, then e2e fixture. Resolve generated-client/test-fixture compile changes once. Review against the binding spec and this plan; no per-task feature expansion.
- [ ] Run final root gate once under `catherd lock -- sh -c 'bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun test'`. Independently run panel gate under `(cd web && catherd lock -- sh -c 'bun install --frozen-lockfile && bun run typecheck && bun run lint && bun run format:check && bun run test')`. Preserve full logs in $TMPDIR; both exits must be 0. Baseline logs do not replace final checks. Run build/e2e from Task 3 once on combined head; coordinate shared heavy slots and do not duplicate the build.
- [ ] One reviewer opens Task 3's seed in a browser using R1's recipe: desktop 1440×1000 dark and light, phone 390×844 (at least dark); inspect labels, colors, glyphs, overlap, all 8 tasks, failed check, limit, gap, now follow and drawer. Attach three screenshots plus optional drawer screenshot to the run report; source/component tests alone do not meet visual acceptance. Stop every server/watcher started for the review.
- [ ] Report verdict, exact commands/exits/log paths, screenshots and any remaining limits to architect. Do not claim browser acceptance from screenshots of a legacy graph or a mocked route.

## Acceptance map and parallelism

| Spec Done when | Implementation | Evidence |
| --- | --- | --- |
| 1 Architect flow; legacy graph | Task 1 eligibility + Task 2 route/fullscreen/mobile | DB legacy/earlier service tests, route tests and Task 3 dual-run e2e |
| 2 Pure derivation including 5 idle classes | Task 1 | Exact check/quota/owner/gap intervals, live-open and overlap/expiry unit tests |
| 3 Rows, idle, drawer; seeded e2e | Tasks 2–3 | Component/route/socket tests and seeded real panel browser assertions |
| 4 Root and panel gates | Task 4 | Both final lock-wrapped gate logs exit 0 |
| 5 Reviewer dark/light/phone with specified seed | Tasks 3–4 | 8-task seed, failed check/limit/gap and attached screenshots with reviewer verdict |

After architect freezes Shared contracts, dispatch Tasks 1, 2 and 3 together. Backend alone owns schemas/client generation; frontend may implement against the contract fixture until generation lands; e2e owns only fixture/harness files and may seed against existing APIs immediately. Task 4 depends on all three and R1's browser recipe. No second browser researcher or product dependency is needed.

## Prevalidation and remaining facts

Writer scratch checks at `48053ba` validated existing Zod event shapes, ledger order/links, exact existing drawer IDs, request-time versus duration-derived check timing, caller whys, real quota expiry, failure splits, actual SQLite legacy schema and record-only missing provenance: **8 pass, 0 fail**. This is contract prevalidation, not an implemented feature or final gate. Evidence location is in the writer's run report; scratch stays under $TMPDIR. No full baseline gate was duplicated.

No product decision is pending. R1 still supplies the executable browser recipe; this plan does not assume its browser binary/path. Existing historical data cannot recover ledger membership for checks (`src/domain/run-events.ts:218`) or record-only dispatches (`src/domain/record.ts:50`), nor a historical split without comparable check verdict (`src/domain/run-events.ts:236`); the contracts intentionally expose those as unassigned/unknown. Current ledger rows are the current snapshot, not a historical reconstruction (`src/services/ledger-store.ts:60`), so a first socket diff replaces flow rather than pretending modelBefore reconstructs old ledger content.
