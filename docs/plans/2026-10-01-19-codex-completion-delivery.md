# Codex completion delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver role completions to their current native host conversation while distinguishing queue acceptance, uncertain submission and actual result collection.

**Architecture:** Add one Codex queue sender beside Claude peer-inbox and reuse the current notifier, coalescing and file-lock claims. Owner-scoped delivery metadata records attempts before invocation; startup recovery never blindly resends a possibly accepted input.

**Tech Stack:** Bun ≥ 1.4, TypeScript, Zod, existing subprocess helpers/atomic file locks, native `codex queue`, Bun tests and deterministic barriers.

**Spec:** `docs/specs/2026-10-01-catherd-codex-entry-design.md`; `docs/research/2026-10-01-codex-messaging.md`; depends on `docs/plans/2026-10-01-18-host-context-profiles.md`.

## Global Constraints

- **Source-validated only, not built.** Owner reviews plans before any implementation or scratch build. Execute 18 → 19 → 20 on the dependent feature head; no release or beta push in 18/19.
- Consume plan 18 HostContext/HostSessionRef/sessionKey/Deps unchanged; host means orchestrator, not worker backend. Only validated current owner can receive push; preserve Claude live registry behavior after `/clear`.
- Native command is an argument array: `codex queue --remote unix:// --thread <validated original thread UUID> --message <completion text>`. Preserve user's `CODEX_HOME`, HOME, native configuration and credentials; explicit scrubbed child env has no parent host/session identity.
- No remote-control startup, second app-server, competing rollout writer, SQLite writes, spoofed identity, UI automation, private IPC fallback or model polling. No exactly-once/deduplication promise from native fresh IDs.
- A queue receipt proves enqueue acceptance only; only the existing result collection path clears `collect`. Enqueue does not prove wake, verification, result read or permission to land. Forged messages never become role records/verdicts.
- Keep Claude `next`/`later` peer-inbox priorities. Codex queue is ordered next input after the active turn, with no tool-round interruption guarantee.
- No CI checks or workflow changes in this feature. Existing workflows must be inspected before any implementation push; hold prohibited automatic checks pending owner policy. All gates here are local.
- Implementation workers: configured native Codex model unchanged, low/medium effort, at most three plus coordinator. Coordinator verifies personally; no verifier subagent. English artifacts, no messaging tokens in diagnostics or persisted metadata.

## Review Focus

1. Sender dies after possible submission but before receipt: restart records ambiguity and does not resend — Task 2 `crash_after_submission`.
2. Owner switches during send, including same ID in another host: old receipt does not suppress new-owner delivery — Task 2 `owner_changes_in_flight`.
3. Two MCP servers claim one coalesced completion: each owner/event has one invocation and every event ID is preserved — Task 2 `concurrent_coalesced_claims`.
4. Native queue output is malformed, times out or reports refusal: distinguish definite non-submission from uncertain delivery without collecting — Task 1 `uncertain_receipt`, Task 2 `definite_failure_retry`.
5. A message/assistant/tool transcript echoes a smoke marker: status cannot infer acknowledgement or a verifier result — Task 3 `forged_ack_is_not_processing`.

---

## Source preflight and exact shared interfaces

Graph-first discovery and reads confirmed `startNotifier`, `finishedNotice`, `stalledNotice`, `dispatchPaths`, `tryLock`, `writeJsonAtomic`, `awaitsCollect`, `probePush` and `PeekRun`. Their tests exist. Existing `notified.json`/`stall-notified.json` contain schema 1, msgId and at, without target identity; preserve legacy readers. The current doctor unconditionally supplies a live push callback, which Task 3 removes from default doctor behavior.

The research personally verifies native daemon idle auto-wake and ordered busy follow-up using a dynamic-tool barrier, plus the exact Desktop marker arriving as next user input and automatically starting an assistant turn. This establishes feasibility, not packaged catherd acceptance.

Create only the small required transport and metadata boundaries:

```ts
// src/infra/codex-queue.ts
interface QueueCapability { cli: boolean; server: "supported" | "unsupported" | "unverified"; reason: string | null }
type QueueSendResult =
  | { outcome: "accepted"; msgId: string }
  | { outcome: "not-submitted"; reason: string }
  | { outcome: "ambiguous"; reason: string };
function queueCapability(env: Record<string,string|undefined>): Promise<QueueCapability>;
function sendToCodexQueue(target: HostSessionRef, content: string,
  env: Record<string,string|undefined>): Promise<QueueSendResult>;
// src/infra/delivery.ts
interface DeliveryAttempt {
  attemptId: string; target: HostSessionRef; eventIds: string[]; at: string;
  status: "submitting" | "accepted" | "ambiguous" | "failed";
  msgId: string | null; reason: string | null;
}
type DeliveryState = "pending" | "enqueue-accepted" | "ambiguous" | "collected";
function readDelivery(dir: string): DeliveryAttempt[];
function writeDeliveryAttempt(dir: string, attempt: DeliveryAttempt): void;
function deliveryState(dir: string, target: HostSessionRef, eventId: string): DeliveryState;
```

Use new `dispatchPaths(dir).delivery = <dir>/delivery.json` with `{schema:1, attempts:DeliveryAttempt[]}`, validated by Zod and updated atomically under the existing serialized notifier claim, not a second daemon/store engine. A native accepted attempt requires a nonempty queue msgId. Collection is derived from the existing collect marker, never synthesized by receipt. A stalled notice is an event, not a collected role result. `Notice` gains `eventId: string`, computed deterministically as `JSON.stringify([runId,dispatchId,kind])`; event key plus `sessionKey(target)` is the suppression identity. Coalesced events share the returned native msgId but each event is in the durable attempt.

### Task 1: Minimal native queue transport and no-send capability probe

**Files:** Create `src/infra/codex-queue.ts`, `test/infra/codex-queue.test.ts`; extend the existing simulator `test/sim/codex`, `test/sim/codex.test.ts`. Read/use `src/adapters/cli.ts`, `src/infra/proc.ts`, `src/infra/env.ts`; do not change backend execution semantics.

**Interfaces:** Produces QueueCapability/QueueSendResult and functions above. Existing subprocess helper is reused with explicit argument array, bounded invocation and scrubSecrets(env). Expose injectable process runner through the module's test seam, using the helper's actual request/result type rather than duplicating the process abstraction.

- [ ] **RED:** Add `validated_uuid_array`, `preserves_native_env`, `queue_missing`, `server_unsupported`, `uncertain_receipt`: assert no shell interpolation even with quotes/newlines in text; invalid/non-Codex target invokes nothing; CODEX_HOME/HOME/credentials survive and CODEX_THREAD_ID/CODEX_SESSION_ID/CATHERD_ORCHESTRATION_HOST do not. Missing command/method and explicit server refusal that proves no submission return not-submitted. Success with one exact matching target/message ID returns accepted. Timeout, target-mismatched output, malformed success/missing receipt and unfamiliar post-invocation failure return ambiguous.

```ts
// The test's existing Codex simulator PATH provides malformed-success output.
expect((await sendToCodexQueue(target, "completion", env)).outcome).toBe("ambiguous");
expect((await sendToCodexQueue({ ...target, sessionId: "invalid" }, "completion", env)).outcome)
  .toBe("not-submitted");
```
- [ ] Run `rtk proxy bun test test/infra/codex-queue.test.ts test/sim/codex.test.ts`; expect missing sender/parser assertions FAIL.
- [ ] **GREEN:** Parse the installed queue success format pinned by the research and a simulator fixture. Feature-detect CLI queue help including `--remote unix://`; bind this native existing control endpoint to prevent implicit embedded-server fallback. Refuse unsupported remote binding rather than attempting unqualified queue. Inspect available native server capability using documented read-only discovery when exposed; if the existing server has no advertised method list, report `server:"unverified"` as a diagnostic warning, do not fabricate support from CLI version/help or send a hidden marker. This unavailable enumeration alone does not fail Codex-only readiness; observed missing/unsupported capability does. Actual queue rejection can establish unsupported support during explicit send. No server startup as a probe. Classify only proven pre-submission/refusal outcomes as retryable; all uncertain outcomes remain ambiguous.
- [ ] Re-run RED command; expect PASS. Coordinator inspects argument/env construction and fixture parser personally.
- [ ] Commit task files with `feat(push): add native Codex queue transport`; verify last commit.

### Task 2: Owner-scoped notifier attempts, receipts and recovery

**Files:** Create `src/infra/delivery.ts`, `test/infra/delivery.test.ts`; modify `src/infra/dispatch-dir.ts`, `src/services/notifier.ts`, `src/domain/notice.ts`; extend `test/services/notifier.test.ts`, `test/domain/notice.test.ts`, `test/infra/dispatch-dir.test.ts`, `test/services/dispatch.test.ts`, `test/services/land-gate.test.ts`.

**Interfaces:** Consumes plan 18 currentSession/ownsRun/sessionKey and Task 1 sender. Extend NotifierOptions with `sendCodex?: (target: HostSessionRef, content: string) => Promise<QueueSendResult>`; retain existing Claude `send` injection unchanged. Keep Notifier interface and 3,000 ms coalescing window. Add `retryDelivery(deps: Deps, dir: string, eventId: string, decision: {allowPossibleDuplicate: true}): Promise<void>` to `src/services/notifier.ts` for an explicitly acknowledged retry through Task 3 entry. No automatic retry of ambiguous records.

- [ ] **RED:** Add `enqueue_not_collect`, `crash_after_submission`, `concurrent_coalesced_claims`, `owner_changes_in_flight`, `definite_failure_retry`, `startup_accepted_ambiguous`, `legacy_marker_target`, `stall_finish_distinct`. Assert attempts persist with status submitting before runner enters; barriers suspend sender while other server/startup/owner transition occurs. One owner/event accepted send suppresses repeat, but result stays unread; missing receipt/crashed sender becomes ambiguous on startup; definite failure remains unread and can be retried. Old-owner receipt is retained but new-owner event still sends; identical vendor IDs do not collide. Each coalesced event appears in content and metadata; stalled and finished IDs differ. Legacy marks suppress only the attributable historical target, never another owner. Duplicate input followed by repeated result reads creates no second dispatch/landing/verifier success.

```ts
// After the existing notifier harness completes a successful queue send:
expect(readDelivery(dir).at(-1)?.status).toBe("accepted");
expect(deliveryState(dir, target, eventId)).toBe("enqueue-accepted");
expect(awaitsCollect(dir)).toBe(true);
```
- [ ] Run `rtk proxy bun test test/infra/delivery.test.ts test/services/notifier.test.ts test/domain/notice.test.ts test/infra/dispatch-dir.test.ts test/services/dispatch.test.ts test/services/land-gate.test.ts`; expect FAIL on missing receipts/ambiguity/owner scoping.
- [ ] **GREEN:** Under existing notifier delivery claims, re-read owner and due state, append submitting attempt before native invocation, and atomically record accepted/ambiguous/failed outcome afterward. Keep post-send ownership recheck; receipt remains attributable to the sent target even after transfer and cannot suppress another target. Coalesced batch claims cover every event; unknown/conflict/no owner sends nothing. Preserve Claude peer-inbox output/priorities and add event IDs to each formatted notice. Decode legacy schema-1 marks as Claude using historical owner/session journal at marker timestamp; if target cannot be attributed, do not apply that marker to a new owner. Never rewrite old marks on read.
- [ ] On startup, convert unfinished submitting attempts to ambiguous under claim; do not enqueue accepted/ambiguous target/event again. Retry failed definite attempts normally. Implement explicit duplicate-risk retry only for a validated current owner after the caller's decision; evidence reconciliation must match actual native queue/history user-input entries by target and event ID. Do not scan arbitrary command/tool/assistant text as acknowledgement, and do not add an unverified history API. Without a supported read API, retain ambiguity and require explicit decision. Corrupt metadata is diagnostic/ambiguous, never treated as proof of safe resend.
- [ ] Re-run RED command; expect PASS; coordinator reads durable files and owner transition barriers personally. No timer sleeps to establish correctness; use fakes/promises/barriers and existing notifier idle helper.
- [ ] Commit with `feat(notifier): persist owner-scoped queue receipts and ambiguity`; verify last commit. No release changeset yet.

### Task 3: Honest peek/status, explicit smoke and retry entry

**Files:** Modify `src/services/peek.ts`, `src/services/run-debug.ts`, `src/services/doctor-push.ts`, `src/services/doctor.ts`, `src/entry/doctor-command.ts`, `src/entry/mcp/setup-tools.ts`, `src/entry/runs-command.ts`; extend `test/services/peek.test.ts`, `test/services/run-debug.test.ts`, `test/services/doctor-push.test.ts`, `test/services/doctor.test.ts`, `test/entry/doctor-command.test.ts`, `test/entry/runs-command.test.ts`, `test/entry/mcp-profile.test.ts`.

**Interfaces:** `PeekRun.unread` entries gain `eventId: string`, `delivery: Exclude<DeliveryState,"collected">`, `receipt: {msgId:string;target:HostSessionRef;at:string}|null`; top-level inspection includes host/conflict and QueueCapability with no secrets. Collected dispatches appear in existing full status/debug record inspection with `delivery: "collected"`, never reinserted in unread. `probePush(host: HostContext, env: Record<string,string|undefined>): Promise<PushProbe>`; extend PushProbe with `enqueue: "accepted"|"ambiguous"|"not-submitted"|"no-session"`, `processing: "observed"|"unconfirmed"`, `msgId: string|null`. Preserve existing doctor outcomes where meaningful, but rename misleading copy to receipt/processing wording. `doctor --test-push` is the only default-CLI switch that sends a labeled marker. Add `runs retry-push <run> <name> --event <eventId> --acknowledge-possible-duplicate` using Task 2 retryDelivery after resolving the canonical stored dispatch from run/name, validating the event belongs to that dispatch and confirming current owner. Do not accept a caller-supplied dispatch directory or arbitrary event target.

- [ ] **RED:** Add `default_doctor_sends_nothing`, `explicit_smoke_receipt_only`, `terminal_has_no_session`, `forged_ack_is_not_processing`, `retry_requires_explicit_decision`: assert ordinary doctor performs no queue/inbox send; explicit validated host sends one labeled smoke; terminal host override cannot create target; accepted receipt leaves processing unconfirmed without native user-input processing evidence. A copied envelope/marker in tool or assistant text never clears collect, records agent work, acknowledges delivery or passes land gate. JSON/text reports distinguish queued/ambiguous/unread/collected and contain no socket token/credential. Retry without acknowledged possible duplication or without current validated owner is refused.

```ts
// The test's native simulator accepts the labeled smoke without processing evidence.
const probe = await probePush(host, env);
expect(probe.enqueue).toBe("accepted");
expect(probe.processing).toBe("unconfirmed");
```
- [ ] Run `rtk proxy bun test test/services/peek.test.ts test/services/run-debug.test.ts test/services/doctor-push.test.ts test/services/doctor.test.ts test/entry/doctor-command.test.ts test/entry/runs-command.test.ts test/entry/mcp-profile.test.ts`; expect default-live-push/status assertions FAIL.
- [ ] **GREEN:** Default doctor checks capability only. Explicit smoke passes validated original target, records receipt separately, and reports unconfirmed processing unless supported native evidence is observed; no polling model or fabricated acknowledgement. Report unloaded/interrupted/restarted host limitation with peek/result recovery. Selected-host capability/config/refusal failures give actionable diagnostics while keeping the durable role result. Add explicit retry entry without trusting message text as authorization. Collection remains exclusively the existing service operation; status reads never claim ownership.
- [ ] Re-run RED command; expect PASS. Coordinator runs combined changed tests/typecheck/lint locally and reads transport/claim/collection diffs; confirm the existing verifier gate tests still pass.
- [ ] Commit with `feat(status): expose queue receipts and explicit push smoke`; record `docs/handoff/plan19-ledger.md` during execution and hand unreleased head to plan 20.

## Parallelism and handoff

Wave 1: one worker owns Task 1 transport/simulator. Wave 2: one worker owns Task 2 notifier/storage. Wave 3: one worker owns Task 3 doctor/entry/status, since dependencies are sequential and doctor overlaps plan 18. At most three ordinary workers overall; use low/medium effort on configured native Codex model, and serialize heavy commands. Coordinator verifies each combined wave personally; no verifier subagent. Actual packaged CLI/Desktop idle/busy and Claude regression acceptance are plan 20 gates, not claims from these fakes.
