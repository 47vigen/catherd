# Native Codex asynchronous completion delivery

Research date: 2026-10-01. Scope: wake the same existing native CLI or Desktop conversation when external work completes, without polling the model or starting a competing writer.

## Conclusion

The native persistent queue is the strongest candidate. Official source includes cross-process queue watching: the process owning a loaded thread can detect another process’s queue writes and wake that thread. Therefore absence from the CLI daemon’s loaded-thread list does not disqualify Desktop delivery. The Desktop process must share the queue store and run a compatible watcher; a receipt still does not prove generation.

## Official documentation

[App-server reference](https://learn.chatgpt.com/docs/app-server): stdio uses newline JSON; Unix sockets use HTTP WebSocket Upgrade. Initialize each connection with `clientInfo` and `initialized`; experimental methods require `capabilities.experimentalApi: true`. `thread/loaded/list` identifies in-memory threads. `thread/read` exposes `notLoaded`, `idle`, `active`, or `systemError` without loading. `thread/resume` loads and subscribes. `thread/inject_items` persists context without starting generation. `turn/steer` requires `expectedTurnId` and fails when idle. `turn/start` with `input: []` and `toolOutput: {name, namespace, output}` starts generation, or queues output for an active regular turn. This is an alternative primitive, not evidence of existing Desktop accessibility.

The reference documents WebSocket bearer authentication (`--ws-auth`, token file/hash or signed bearer secret), enforced before initialization. Client names identify integrations; they do not select the conversation owner. Network listeners are experimental.

[Developer commands](https://learn.chatgpt.com/docs/developer-commands): `--remote` accepts `ws://`, `wss://`, `unix://`, or `unix://PATH`; `--remote-auth-token-env` reads credentials. CLI Tab queues the next turn, Enter steers current work. `codex debug app-server send-message-v2` starts a new thread, so it does not satisfy same-conversation delivery. `remote-control start` starts a daemon and must not be used as a substitute for reaching an existing owner. The current reference does not describe `codex queue`.

## Official upstream source

These observations concern moving upstream `main`, not proof of installed-version behavior.

[CLI queue command](https://github.com/openai/codex/blob/main/codex-rs/cli/src/queue_cmd.rs): `codex queue --thread UUID_OR_EXACT_NAME --message TEXT` requires nonempty text, rejects image attachments, and resolves an optional remote endpoint.

[Queue submission path](https://github.com/openai/codex/blob/main/codex-rs/tui/src/session_queue_commands.rs): rejects local `--no-daemon`; refuses embedded delivery while the local daemon runs. It sends only `thread/queue/add`, without resume, and does not fall back when the shared server lacks that method. Request fields are `threadId`, `input` text items, and `clientUserMessageId`. Each CLI invocation generates a fresh UUIDv7. Success prints `queuedSubmission.id` and target thread ID. This proves acceptance, not completion. Repeated CLI invocations can submit duplicates; stable event IDs require the underlying RPC and confirmed server idempotency behavior.

## Local observations supplied by coordinating agent

- Installed CLI: 0.159.2; existing shared daemon: 0.159.3.
- Installed Desktop bundled CLI: 0.159.2. Its binary contains the queue watcher's three diagnostic strings for change-version, changed-thread, and newly-loaded-thread discovery.
- Shared daemon socket: `~/.codex/app-server-control/app-server-control.sock`.
- CLI help confirms queue UUID/exact-name and message options.
- Desktop bundled app-server uses stdio. The separate native CLI daemon reports zero loaded threads, including absence of this Desktop conversation. This alone does not rule out shared-queue delivery.
- A JSONL attempt through `app-server proxy` timed out or returned empty output. A direct HTTP WebSocket Upgrade on the existing Unix control socket, followed by `initialize`, `initialized`, and `thread/loaded/list`, succeeded. No server was started or restarted for this connection.
- Installed 0.159.2 schemas generated with `--experimental` confirm `ThreadQueueAddParams` requires `threadId`, `input`, and `clientUserMessageId`. Queue APIs are excluded from default stable schema generation.

### Personally verified native daemon smoke

A throwaway Python WebSocket probe connected to the existing daemon. It created a disposable read-only research thread; it did not resume or modify any existing user conversation. The initial no-tool turn completed too quickly to establish busy queueing, so the corrected probe used a dynamic-tool barrier to keep a turn demonstrably active while the follow-up was accepted.

The corrected run reported:

```text
idle_queue_accepted: True
turn_completed: completed
idle_auto_wake_confirmed: True
status_before_busy_queue: {'type': 'active', 'activeFlags': []}
busy_queue_accepted: True
turn_completed: completed
turn_completed: completed
queue_drained: True
reply_markers: ['CATHERD_IDLE_ACK', 'CATHERD_BUSY_BASE_ACK', 'CATHERD_BUSY_QUEUED_ACK']
```

The markers were read from that disposable thread's native history, not inferred from queue receipts. This verifies idle wakeup and ordered busy follow-up on the native shared daemon. It does not by itself prove cross-process Desktop wakeup.

### Original Desktop conversation probe

The coordinator submitted one labeled completion marker to the current conversation using native `codex queue`, with its actual `CODEX_THREAD_ID`. The command exited 0 and returned a queue receipt. Delivery to the original Desktop conversation is pending until its active turn ends; receipt alone is not recorded as a successful wakeup.

## Unverified behavior and excluded shortcuts

Persisted deduplication, unload/restart behavior, and same-Desktop-thread wakeup remain unverified. Idle auto-dispatch and ordered busy delivery are verified on the native shared daemon above. No duplicate retry guarantee is inferred from `clientUserMessageId`; catherd must retain its existing serialized delivery claims and distinguish acknowledged enqueue from reading a role result.

[Issue 44491](https://github.com/openai/codex/issues/44491) reports that unloaded threads retain queued input until resume in 0.154.0. [Issue 32188](https://github.com/openai/codex/issues/32188) includes a Linux 0.153.4 report of an idle Desktop wakeup through `codex queue`. Both are reporter evidence, not official guarantees or local reproduction.

Do not start a second app-server, reopen the same rollout through another writer, spoof Desktop identity, manipulate session storage, or assume MCP notifications wake an idle model. A delivery implementation must distinguish a durable queue receipt from observed processing and preserve the worker result for later retrieval.

## Cross-process queue watcher: pinned official source

Source commit: `799324821d36a822923cee7814d3b80f7ec3cf99`. Inspected through the indexed official sparse checkout, using graph search and symbol snippets.

[`QueuedItemService::watch_external_messages`](https://github.com/openai/codex/blob/799324821d36a822923cee7814d3b80f7ec3cf99/codex-rs/ext/queue/src/service.rs#L92) runs every ten seconds, reads `QueueStore::change_version`, and queries `changes_since` for that process’s loaded thread IDs. It also checks newly loaded/resumed threads. Changes emit queue notifications and launch bounded per-thread dispatch tasks. Running, interrupted, shutdown, and missing threads are not started by those tasks. Other loaded states with queued items call `wake_if_loaded`; that method emits the existing idle lifecycle when idle, excluding interrupted threads. This is explicit support for cross-process queue writes, with native timer polling rather than model polling. Actual installed Desktop compatibility and shared-store identity require local confirmation.

## Desktop IPC exploration

Official documentation searches for `ipc.sock`, Desktop IPC, and `send_message_to_thread` produced no relevant documented external transport. Read-only archive inventory identified the installed `app.asar` main bundle and its imported bootstrap/protocol chunks. Only those relevant JavaScript files were extracted into `/tmp/catherd-desktop-ipc-source` and indexed before source searching. No credentials, socket payloads, or user messages were inspected.

The installed bundles expose the existing `codex_app.send_message_to_thread` tool name and its tool-approval annotation, but this does not establish that `~/.codex/ipc/ipc.sock` accepts arbitrary thread input. The inspected files contained no literal `ipc.sock` path or proven send-message socket handler. Because official source established a native cross-process queue watcher, private IPC investigation was stopped without attempting any socket operation. This IPC path remains unverified and is unnecessary if the native queue experiment succeeds.
