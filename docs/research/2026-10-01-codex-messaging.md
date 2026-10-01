# Native Codex asynchronous completion delivery

Research date: 2026-10-01. Scope: wake the same existing native CLI or Desktop conversation when external work completes, without polling the model or starting a competing writer.

## Conclusion

The native persistent queue satisfies the research feasibility question. Idle wake and ordered busy follow-up were personally verified on the native shared daemon. The owner also confirmed that the original Desktop conversation woke, then intentionally cancelled the test turn. Official source includes cross-process queue watching: the process owning a loaded thread can detect another process’s queue writes and wake that thread. A receipt alone still does not prove generation; packaged catherd integration acceptance remains required.

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

The coordinator submitted a labeled completion marker to the current conversation using native `codex queue`, with its actual `CODEX_THREAD_ID`. The command exited 0 and returned receipt `01a0f547-7947-7972-90a0-a7ad547170e0`. Queue/history inspection did not establish a native user-message acknowledgement. The owner then explicitly confirmed that the original Desktop conversation woke and that they personally cancelled its test turn. Record this as owner-witnessed same-session wake success, with intentional interruption, rather than an assistant-history proof.

The owner authorized a repeat. Marker `CATHERD_DESKTOP_RETEST_20261001` was accepted for the same original thread `01a0f53b-a47d-7350-83a4-c3430e453404`, with receipt `01a0f54c-cf5d-7e22-9c63-39d867803eb5`. After the sending turn ended, that exact queued message arrived as the next user input in this original Desktop conversation and started an assistant turn. The coordinator received and acknowledged it here. This directly observes cross-process same-session Desktop wake and ordered follow-up after an active turn, beyond the earlier receipt and owner testimony. It remains a transport probe, not packaged catherd integration acceptance.

## Unverified behavior and excluded shortcuts

Persisted deduplication, unload/restart behavior, and packaged catherd delivery remain unverified. Desktop same-session wake was witnessed by the owner; idle auto-dispatch and ordered busy delivery are verified on the native shared daemon above. No duplicate retry guarantee is inferred from `clientUserMessageId`; catherd must retain its existing serialized delivery claims and distinguish acknowledged enqueue from reading a role result.

[Issue 44491](https://github.com/openai/codex/issues/44491) reports that unloaded threads retain queued input until resume in 0.154.0. [Issue 32188](https://github.com/openai/codex/issues/32188) includes a Linux 0.153.4 report of an idle Desktop wakeup through `codex queue`. Both are reporter evidence, not official guarantees or local reproduction.

Do not start a second app-server, reopen the same rollout through another writer, spoof Desktop identity, manipulate session storage, or assume MCP notifications wake an idle model. A delivery implementation must distinguish a durable queue receipt from observed processing and preserve the worker result for later retrieval.

## Cross-process queue watcher: pinned official source

Source commit: `799324821d36a822923cee7814d3b80f7ec3cf99`. Inspected through the indexed official sparse checkout, using graph search and symbol snippets.

[`QueuedItemService::watch_external_messages`](https://github.com/openai/codex/blob/799324821d36a822923cee7814d3b80f7ec3cf99/codex-rs/ext/queue/src/service.rs#L92) runs every ten seconds, reads `QueueStore::change_version`, and queries `changes_since` for that process’s loaded thread IDs. It also checks newly loaded/resumed threads. Changes emit queue notifications and launch bounded per-thread dispatch tasks. Running, interrupted, shutdown, and missing threads are not started by those tasks. Other loaded states with queued items call `wake_if_loaded`; that method emits the existing idle lifecycle when idle, excluding interrupted threads. This is explicit support for cross-process queue writes, with native timer polling rather than model polling. Actual installed Desktop compatibility and shared-store identity require local confirmation.

## Desktop IPC exploration

Official documentation searches for `ipc.sock`, Desktop IPC, and `send_message_to_thread` produced no relevant documented external transport. Read-only archive inventory identified the installed `app.asar` main bundle and its imported bootstrap/protocol chunks. Only those relevant JavaScript files were extracted into `/tmp/catherd-desktop-ipc-source` and indexed before source searching. No credentials, socket payloads, or user messages were inspected.

The installed bundles expose the existing `codex_app.send_message_to_thread` tool name and its tool-approval annotation, but this does not establish that `~/.codex/ipc/ipc.sock` accepts arbitrary thread input. The inspected files contained no literal `ipc.sock` path or proven send-message socket handler. Because official source established a native cross-process queue watcher, private IPC investigation was stopped without attempting any socket operation. This IPC path remains unverified and is unnecessary if the native queue experiment succeeds.

## Native MCP caller identity: pinned official source

At commit `799324821d36a822923cee7814d3b80f7ec3cf99`, [`mcp_initialize_request_params`](https://github.com/openai/codex/blob/799324821d36a822923cee7814d3b80f7ec3cf99/codex-rs/codex-mcp/src/rmcp_client.rs#L1107) advertises `clientInfo.name = "codex-mcp-client"`, title `Codex`. Initialization identifies the client, not a target conversation.

The model-call path in [`mcp_tool_call.rs`](https://github.com/openai/codex/blob/799324821d36a822923cee7814d3b80f7ec3cf99/codex-rs/core/src/mcp_tool_call.rs#L516) applies `with_mcp_tool_call_ids_meta`, inserting `_meta.threadId` and the distinct `_meta.sessionId` (helper at line 1409). The direct app-server [`mcpServer/toolCall` path](https://github.com/openai/codex/blob/799324821d36a822923cee7814d3b80f7ec3cf99/codex-rs/app-server/src/request_processors/mcp_processor.rs#L682) also inserts `threadId`. Therefore the native MCP integration must consume validated thread metadata per request; it must not assume shell-injected `CODEX_THREAD_ID` reaches the MCP subprocess, equate runtime session and thread IDs, or keep a last-request global owner. Actual packaged calls remain the compatibility gate.

## Queue must bind to the existing native server

Pinned source exposes a necessary correction to the unqualified queue argv. In [`tui/src/lib.rs::app_server_target_for_launch`](https://github.com/openai/codex/blob/799324821d36a822923cee7814d3b80f7ec3cf99/codex-rs/tui/src/lib.rs#L1011), implicit local discovery chooses embedded server if no daemon is found and permits embedded fallback after connection failure. Merely probing before an unqualified queue call would leave a race.

Use the supported native flag `--remote unix://` with `codex queue`. [`resolve_remote_addr`](https://github.com/openai/codex/blob/799324821d36a822923cee7814d3b80f7ec3cf99/codex-rs/tui/src/lib.rs#L446) resolves that endpoint through the existing CODEX_HOME control socket, without catherd hardcoding its path. [`start_app_server_for_session_command`](https://github.com/openai/codex/blob/799324821d36a822923cee7814d3b80f7ec3cf99/codex-rs/tui/src/session_archive_commands.rs#L253) connects explicit endpoints directly; a connection failure returns an error instead of selecting an embedded writer. Installed CLI 0.159.2 `queue --help` confirms support. The integration must feature-detect this flag and refuse unavailable existing-server delivery, preserving unread results. Actual explicit-endpoint queue acceptance remains a Plan19/20 test, not established by help.
