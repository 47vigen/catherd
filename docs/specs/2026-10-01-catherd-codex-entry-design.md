# catherd entry from Codex and Claude Code

Date: 2026-10-01. Status: owner-approved for implementation planning, including the requested `gpt-6-1-sol` defaults. Written plans require owner review before execution.

## Intent and scope

The same catherd installation can orchestrate from native Codex CLI, Codex Desktop, or Claude Code. Claude Code is optional for a Codex-only profile. Architect and verifier defaults follow the actual orchestration host, while explicit profile choices remain authoritative. External role completions wake the same existing host conversation through its native messaging facility; `peek` and `result` remain the durable read interfaces.

Use the existing shared core and thin host integration. Keep the `domain → infra → adapters → services → entry` dependency direction, profile single-writer rule, detached worker supervisors, atomic locked stores, routing, failover and verifier gate. This design amends the existing specs only where host identity, default role resolution, packaging and completion delivery need to become host-aware.

There is no second orchestration engine, native Codex subagent subsystem, new messaging daemon, unrelated model upgrade, provider auto-installation, speculative transport framework or model polling loop. This work introduces no CI check jobs.

## Host and session contract

An orchestration host is `claude-code`, `codex`, or `unknown`. It is independent of a role's backend: a Codex orchestrator may dispatch `claude-code:` workers, and a Claude Code orchestrator may dispatch `codex:` workers.

The MCP entry identifies the connected host from initialization client metadata, validated session environment and, where necessary, a host discriminator supplied by the host's launcher. Installed binaries on `PATH` are dependencies, never host evidence. Codex identity uses the actual thread/session identifiers exposed by the running native host; a target thread UUID is validated before sending. Claude retains its existing live registry lookup, including the session change after `/clear`.

Consistent evidence selects a host. Contradictory host or session evidence produces an actionable conflict and disables ownership and push until resolved; it must not arbitrarily pick a vendor. Insufficient evidence selects `unknown`. An explicit launcher discriminator identifies the integration, but cannot invent a session or override contradictory validated evidence. Host resolution completes before host-dependent profile resolution, ownership claims and notification scans; connecting MCP does not wait for network discovery or a live smoke test.

Terminal `init` and `doctor` accept `--host codex|claude-code|auto`; auto remains unknown when the terminal provides no actual host evidence. An explicit terminal host selects setup and dependency checks, not an owner conversation. Unknown contexts can inspect existing data and collect results; operations requiring host defaults must request an explicit host, and unknown contexts never claim a run or push a message.

Every new session identity is namespaced by `(host, sessionId)`. `startedBy`, the current owner in `state.json`, `sessions.jsonl`, and dispatch origin metadata carry that host alongside the existing session fields. `hostSessionId` remains the existing outer-session identifier, not the new host discriminator. Run and dispatch IDs keep their current meaning and format. Session views and ownership comparisons use the host plus session ID, preventing identical IDs from different vendors colliding.

`run_start`, `peek` and `dispatch` remain the explicit ownership transition when a run continues in another session, including across hosts. Reading status, collecting a result, changing a profile or starting another MCP server does not silently transfer ownership. Workers retain their recorded origin; notifications target the current owner. Ownership is checked under the existing delivery claim and again after send. A completion accepted for an old owner during a transition may remain there, but it must not suppress delivery to the new owner.

Legacy session records containing an ID but no host decode as Claude Code. Records with no owner stay unowned. New optional host fields and delivery metadata use existing versioned-store compatibility conventions; readers retain support for legacy rows and markers. Any required incompatible store-version change gets an explicit migration rather than silently discarding data. Receipt identity includes its target owner so a receipt for one owner cannot suppress another owner's notice.

## Defaults and explicit profiles

Only omitted architect/verifier rung choices follow the resolved host:

| Host | Architect | Verifier |
| --- | --- | --- |
| Claude Code | Existing native Claude Opus default at high effort | Existing native Claude Opus default at low effort |
| Codex | `codex:gpt-6-1-sol#high` | `codex:gpt-6-1-sol#low` |
| Unknown | Requires a host for host-dependent role resolution | Requires a host for host-dependent role resolution |

The owner selected `gpt-6-1-sol` for the omitted Codex architect/verifier defaults. Verify that exact model ID through existing catalog discovery and validation during implementation, retaining existing treat-like alias behavior. If the native catalog uses a different spelling, report the mismatch and resolve it explicitly rather than silently substituting a model. Other role defaults and explicit backend model IDs remain unchanged.

`defaultProfileDoc` currently materializes `BUILTIN_ROLES`; new documents omit `rungs` and `defaultRung` only for architect and verifier, retaining their other defaults. `resolveProfile` supplies their defaults from explicit host context. Other role defaults are unchanged. An explicit rung ladder is preserved in order, and the existing rule that an explicit ladder never inherits an unrelated built-in `defaultRung` remains intact. Explicit access, enabled state, network settings, routing, budgets, harness isolation, billing and failover keep their current semantics.

Existing materialized profiles are kept byte-for-byte. An explicit profile reset/migration operation, through ProfileService's existing reviewed-diff write path, removes only architect/verifier `rungs` and `defaultRung` overrides. It preserves every other field and exposes the resulting effective host defaults before saving. It is never an automatic conversion on init, read, host switch or upgrade. Users may also deliberately edit those two fields through the existing profile workflow.

Explicit `claude-code:` rungs work from either host using the configured native headless harness. An explicit native `claude:` rung requires a Claude Code orchestration host. From Codex it fails clearly and proposes either `claude-code:` with the same exact model and effort, or opting into host defaults. catherd must never silently convert a native Claude rung into a headless one. The same host constraint applies to a selected native-Claude failover.

Codex architect/verifier work uses existing dispatch execution and headless verifier verdict processing. Claude's native agent dispatch instructions and `record_agent_run` accounting are unchanged.

## Packaging and optional dependencies

Both integrations deliver the shared skill and the same versioned MCP launcher/core, with small host-specific manifest and launcher environment differences. The Claude plugin retains its existing install experience. The Codex plugin must use the native Codex plugin layout, supported MCP declaration and plugin-root/path expansion; `${CLAUDE_PLUGIN_ROOT}` is not a Codex contract. Inspect actual native manifest and launcher compatibility before implementation, then verify the installed package in both Codex surfaces. If the native plugin cannot supply the integration, the user explicitly chooses CLI installation plus native MCP configuration; there is no automatic other-vendor installation.

Portable skill/setup references explain native Claude agents only on Claude Code, and existing dispatch/headless roles on Codex. The shared run protocol uses push completion followed by `result`; `await_results` is not the completion mechanism.

`init`, profile validation and `doctor` determine dependencies from the selected host and the effective current-repository profile, including relevant failover. Claude plugin availability is required only for the Claude host. Claude CLI/login is required only when an enabled selected role or applicable failover needs its backend, retaining the existing distinction between role failures and failover warnings. Codex-only readiness must succeed without Claude installed or configured.

ProfileService remains the sole writer of Claude agent links. It creates or updates them only when native Claude roles are actually used. Codex-only setup/profile operations make no writes under `~/.claude`. Doctor can report problems in other linked profiles separately, but those problems do not block unrelated Codex-only readiness. Deliberate writes to a Claude-dependent profile keep the current managed-link ownership and pruning rules.

## Native completion delivery

The [native Codex messaging research](../research/2026-10-01-codex-messaging.md) supports the persistent queue as the minimum Codex transport. Preserve Claude's peer-inbox transport and its priority semantics. Codex delivery invokes the native command with an argument array:

```text
codex queue --thread <validated original thread UUID> --message <completion text>
```

The orchestrator's MCP server is the sender. Preserve the user's `CODEX_HOME`, credentials and native configuration so the command reaches the same native queue/store. Check the installed command and server queue capability, rather than relying on a version threshold. Do not start remote-control infrastructure, start a second app-server, resume the original rollout under a competing writer, write SQLite directly, spoof host identity, automate the UI, or strip HOME/configuration to force delivery.

The installed native shared daemon has personally verified idle auto-wake and ordered busy follow-up, with a dynamic-tool barrier proving the busy state and three exact replies in thread history. Official pinned source provides a cross-process watcher on a native timer, including newly loaded threads. This is native infrastructure polling, not catherd model polling. The owner confirmed that the original Desktop conversation woke and that they intentionally cancelled the first test. The authorized repeat then delivered its exact marker as the next user input in this same Desktop conversation after the sending turn ended, starting an assistant turn that acknowledged it. Same-session Desktop wake and ordered follow-up are now directly observed. Installed catherd/plugin idle and busy acceptance still must pass before release.

Codex queue submission is a queued next input. It does not promise Claude's `next` tool-round urgency or interrupt an active turn. Idle conversations should wake automatically; active conversations should process the queued completion after the current turn. The shared notice can retain urgency information without claiming unsupported scheduling semantics.

Reuse notifier coalescing, serialized claims, ownership checks and startup unread-result scanning. Every completion includes run ID, dispatch ID and a stable catherd event identifier; stalled and finished notices have distinct event kinds. Coalesced messages identify every event. Duplicate messages lead to idempotent reads of existing catherd records, never duplicate dispatches or a second landing.

Delivery states distinguish pending, enqueue accepted, ambiguous delivery and collected. A native receipt records the native queue message ID, target host/session, event IDs and timestamp in the dispatch's delivery metadata. It means the queue accepted input; it does not mean the model consumed it, woke, verified the work or read the role result. `result` alone performs the existing collection step; enqueue never writes the collected marker. Status/peek expose enqueue versus collection and the selected host/capability without exposing messaging tokens.

Each native CLI invocation generates fresh IDs, so catherd makes no exactly-once or automatic duplicate-retry promise. Persist the attempt under the existing claim before invocation. A definite pre-submission failure leaves the record unread and retryable. Timeout, sender crash or missing receipt after possible submission records an ambiguous attempt, including recovery after server restart; it is not automatically retried. Reconcile only against native queue/history entries matching the target and event ID, never against mere occurrences in command/tool text. Retry requires evidence that no matching submission was accepted, or an explicit decision acknowledging possible duplication. A confirmed receipt suppresses another enqueue for that same owner/event, while retaining the unread result.

Unavailable queue support, rejected targets, configuration errors and definite transport failures preserve the durable result and produce actionable diagnostics with `peek`/`result` recovery. Startup recovery does not blindly resend accepted or ambiguous events. Unloaded, interrupted or restarted host sessions may retain queued input without generating; catherd reports that limit instead of pretending the receipt proves wakeup. Private Desktop IPC is investigated only if the supported native queue cannot satisfy same-session delivery; it is not an automatic fallback. No fallback polls the model.

Doctor's capability check sends no live marker by default. Explicit `doctor --test-push` sends one clearly labeled smoke message to the validated original session, and reports enqueue acceptance separately from observed processing. A terminal with no live owner reports no session. An arbitrary user message, matching assistant text or forged completion envelope is never delivery acknowledgement or authority for a role result: catherd's actual record and reviewer/verifier gate remain authoritative.

## Process environment boundary

Extend existing Claude session scrubbing at every child execution boundary to remove `CODEX_THREAD_ID`, `CODEX_SESSION_ID` and catherd host/session identity overrides from workers, supervisors, checks and doctor subprocesses. Preserve vendor credentials, user configuration and `CODEX_HOME`. A worker must not inherit the orchestrator's identity and claim or notify its parent conversation. The queue sender receives an explicit validated target argument from the orchestrator and only the required native environment; it does not rely on a worker-inherited thread variable.

## Existing integration points

| Area | Responsibility |
| --- | --- |
| `src/domain/profile.ts`, profile validation/routing | Host-aware omitted defaults; explicit rung semantics and host compatibility |
| `src/infra/claude-session.ts`, `src/infra/peer-inbox.ts`, process/environment helpers | Preserve Claude integration; add minimal Codex identity/capability/queue transport; scrub child identity |
| `src/services/ports.ts`, ProfileService, setup and doctor services | Thread host context through existing ports; optional dependency checks, reset diff and conditional agent linking |
| `src/services/sessions.ts`, `run-store.ts`, dispatch admission and session views | Host-namespaced origin/current owner, journal compatibility and cross-host continuation |
| `src/services/notifier.ts`, dispatch delivery markers and status/result services | Existing claims/coalescing plus owner-scoped enqueue receipts, ambiguous attempts and unread-result preservation |
| `src/entry/deps.ts`, `src/entry/mcp/server.ts`, CLI/setup tools | Initialization-based host resolution before dependent work; terminal overrides and explicit push smoke |
| Plugin manifests/launcher, shared skills and setup documentation | Native Codex packaging alongside Claude packaging, shared protocol and portable references |

These are affected responsibilities, not a parallel reorganization of the layers. Use existing ports, subprocess facilities, locks, schema validation and tests; introduce only the small host data contract and transport boundary required by the second consumer.

## Local verification and live acceptance

Extend the existing local tests with injected host/session and queue send fakes. Cover omitted versus explicit defaults, legacy profile preservation and narrowly scoped reset; conflicting/unknown detection; host namespace collisions and cross-host ownership; selected-profile dependency severity and zero Claude writes for Codex-only setup; child environment scrubbing with configuration preservation; enqueue versus collection; failures and ambiguous recovery; coalescing, concurrent servers, owner changes, startup/restart and duplicate event handling. Assertions inspect durable markers and records, rather than equating process exit zero with wakeup. Use deterministic barriers for busy-state tests, not correctness sleeps.

Run the repository's existing local gate when implementation is complete. No new CI lint, test or check job is introduced.

| Live case | Acceptance evidence |
| --- | --- |
| Codex-only native CLI, idle and busy | Installed integration initializes without Claude, defaults route architect/verifier to the owner-selected SOL model at high/low effort, completion wakes the original idle thread and becomes an ordered busy follow-up; `result` collects the stored record |
| Codex-only Desktop, idle and busy | Installed native plugin/launcher targets the original Desktop conversation; observed native user-message processing and assistant continuation, with separate queue receipt and collection evidence |
| Explicit Claude headless roles from Codex | Same configured model/effort runs through `claude-code:`; optional dependency failures are specific and actionable |
| Explicit native Claude role from Codex | Clear rejection with exact headless equivalent or host-default reset suggestion; profile is unchanged |
| Legacy Claude Code integration | Existing plugin, native defaults/agent accounting, peer inbox, priorities, collection and live registry behavior still work |
| Cross-host continuation | Existing ownership transition moves delivery to the new host/session, preserves origin/journal, and old-owner receipts do not suppress new-owner events |
| Unknown and conflicting host evidence | No accidental ownership, push or vendor guess; terminal explicit host supports setup without fabricating a conversation |
| Concurrent servers, duplicate messages and owner change | Claims serialize sends; event IDs make duplicate processing harmless; accepted old-owner events do not lose new-owner delivery |
| Startup, restart and unloaded/interrupted host | Unread results survive, accepted/ambiguous events are not blindly resent, and status distinguishes retained queue input from observed processing |
| Queue unavailable, refusal or uncertain receipt | Actionable capability/delivery state; durable unread result remains accessible; no competing server or polling fallback starts |

Passing daemon research and owner-witnessed Desktop wake establishes feasibility. Release acceptance requires the actual packaged catherd flow on both hosts and both Codex surfaces, including the busy case and the unchanged verifier gate.
