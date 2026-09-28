# Cross-session messaging in Claude Code — research for catherd 1.1 push delivery

Researched 2026-09-28 for spec `docs/specs/2026-09-28-catherd-1.1-design.md` §3 (plan 10, Task 1). Source: a static
reading of the installed **Claude Code 2.1.283 Linux build** (`strings -n 8 /opt/claude-code/bin/claude`, BUILD_TIME
2026-09-25T00:44:42Z, GIT_SHA 4631ccd7), plus the live session registry and transcript of the session the plan was
written in (read only: no message was sent). The protocol is **undocumented** and can change in any Claude Code
release; catherd treats every delivery as best effort (disk stays the source of truth, spec §3.2).

Bun folds platform branches when it compiles the binary, so the Linux build shows the Linux paths in full; macOS
behaviour below is **inferred** from the runtime `platform === "macos"` checks that survive in it, not observed in a
macOS binary. `scripts/spike-push.ts` (this task) confirms delivery live on either OS.

## 1. The session registry: `~/.claude/sessions/<pid>.json`

Written by each live session on start (under `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`), and updated in place:

```js
{ pid, sessionId, cwd, startedAt, procStart, version: "2.1.283", peerProtocol: 1, peerFeatures, kind, entrypoint,
  hostSessionId /* only when a host (Desktop) launched it */, pidDomain, messagingSocketPath,
  name, nameSource, nameSince, logPath?, agent?, jobId?, updatedAt, status /* busy|idle|waiting */, statusUpdatedAt }
```

Observed live on 2026-09-28 (values elided): `pid`, `sessionId`, `cwd`, `startedAt`, `procStart`, `version`,
`peerProtocol`, `peerFeatures`, `kind`, `entrypoint`, `pidDomain`, `messagingSocketPath`, `name`, `nameSource`,
`nameSince`, `updatedAt`, `status`, `statusUpdatedAt`. A key file `~/.claude/sessions/<pid>.<sha256(sock)>.key` sits
beside it (the peer token; catherd never reads it).

- **`sessionId` is live.** `/clear` and `/resume` rewrite it here; the `CLAUDE_CODE_SESSION_ID` an MCP server was
  started with keeps the old id. catherd reads the live id from this file (controller ruling d).
- **`name` is live** too (a renamed Desktop session renames here), with `nameSource` and `formerNames`.
- **There is no permission-mode field.** No writer puts the session's permission mode into the file, so a sender
  cannot learn the receiver's permission class from it.
- **Finding the file.** The MCP server is the session's child: its parent pid names the file. catherd matches, in
  order: the file whose `messagingSocketPath` equals `CLAUDE_CODE_MESSAGING_SOCKET`, else `<ppid>.json`.
- Default socket path: `$XDG_RUNTIME_DIR` (else the temp dir) + `/cc-socks/<pid>.sock`, mode 0600, at most 103
  bytes (a fallback path otherwise). Observed: `/tmp/cc-socks/<pid>.sock`.

## 2. The socket and the frame

The listener is `net.createServer({ allowHalfOpen: true })` on the Unix socket. Lines are `\n`-delimited JSON; blank
lines are skipped; a final unterminated fragment is parsed on `end`. Buffered data over 1,048,576 characters, or no
complete line within 30 s, destroys the connection. The server never closes first; on `end` it parses the tail and
ends its side.

- **Auth.** An auth line is honoured only as the **first** line: `{"type":"auth","token":"<token>"}`. A missing or
  bad token drops the connection **only on Windows**; on Linux and macOS unauthenticated lines are processed (the
  token then only feeds the self-sent fallback, §4). Two tokens exist: the peer token (in the key file) and the
  **child token**, which the session puts in its own environment as `CLAUDE_CODE_MESSAGING_TOKEN`, so its children
  inherit it. catherd sends the child token (controller ruling e).
- **User frame.** `{"msgV":1,"msg_id":"<uuid>","type":"user","message":{"role":"user","content":"<string>"},"priority":"later|next|now"}`.
  `content` must be a non-empty string. `priority` other than `now|next|later` (or missing) is read as `next`.
  `msg_id` is kept when it is a UUID; `msgV: 1` is what native senders put and the receiver does not require it.
- **Drop rule.** A frame that carries `session_id` different from the receiver's current id is dropped. catherd
  sends **no `session_id`** (ruling e): after `/clear` the id it knows may be stale.
- **Closing.** The native client writes `auth + "\n" + json + "\n"` in one write, then on macOS ends the socket after
  150 ms (`setTimeout(end, 150)`), elsewhere at once. catherd writes the same two lines in one write and closes after
  150 ms on every OS (ruling e): the tail parse on `end` makes the delay harmless on Linux.

## 3. The environment an MCP server gets

stdio MCP servers are spawned with `{ ...process.env, CLAUDE_PROJECT_DIR, CLAUDE_CODE_SESSION_ID, CLAUDECODE: "1",
...server.env }`. When the inbox starts, the session sets `process.env.CLAUDE_CODE_MESSAGING_SOCKET` and
`CLAUDE_CODE_MESSAGING_TOKEN` (the child token), so every child spawned after that inherits both.

| Variable | Set by | Notes |
|---|---|---|
| `CLAUDE_CODE_SESSION_ID` | injected at spawn | stale after `/clear`: read the registry file for the live id |
| `CLAUDE_CODE_MESSAGING_SOCKET` | inherited | the socket path; the registry's `messagingSocketPath` is the same |
| `CLAUDE_CODE_MESSAGING_TOKEN` | inherited | the child token |
| `CLAUDE_CODE_HOST_SESSION_ID` | **not set by Claude Code** | a host (Desktop) passes it in; absent in a terminal session |

Not verifiable statically: that the inbox is listening before the MCP servers spawn. catherd logs, at MCP start,
which of the four variables it found (keys only, `session` row in the catherd log), so a live session shows it.

## 4. The inbound gate (`crossSessionInbound`)

Setting `crossSessionInbound: "accept" | "hold" | "refuse"` (unset = default). Policy, user and flag settings are read
first; local and project settings may only tighten it (`hold`, `refuse`); an invalid value reads as `hold`. A kill
switch (`CLAUDE_CODE_HARBOR_KITE` env or the `tengu_harbor_kite` flag, default on) off means refuse.

With the setting **unset**, a peer message is judged like this:

1. `selfSent` → accept.
2. The receiver's permission mode unknown → hold (`mode-unknown`).
3. The receiver's class is `bypass` (bypassPermissions, or plan with bypass available) or `prompting` (default,
   acceptEdits, auto, dontAsk, plan without bypass).
4. The message declares `from-mode` (an envelope attribute): accept when it equals the receiver's class, else hold
   (`mode-mismatch`).
5. No `from-mode`: a `prompting` receiver **accepts**; a `bypass` receiver holds (`no-mode-asserted`).

`selfSent` is computed only when it matters (no setting and a bypass-class receiver). It is true when the session's
pid is among the sender's ancestors:

- **Linux:** the peer pid comes from `SO_PEERCRED` at connect (re-checked against its `/proc` start time at the
  first line, a pid-reuse guard), and the ancestors from `/proc/<pid>/stat`, up to 12 levels. The self-sent rule
  **does run on Linux** (controller ruling b; spec §3.9's "does not run" is wrong for this build).
- **macOS:** a `ps -o ppid= -p <pid>` walk, 10 levels, retried with 32 when cut short; when the walk yields no
  evidence, presenting the child token passes.
- **Windows or pid 1:** self-sent = the child token was presented.

An explicit `crossSessionInbound` of `hold` or `refuse` wins over everything, self-sent included. A held message waits
in a buffer of 100 (oldest expire), is shown to the user for review, and is released when the policy later accepts.

**What catherd does (controller ruling a):** it never declares `from-mode`. The class cannot be learned (no mode in
the registry), a wrong value holds the message at a prompting receiver, and without it a prompting receiver accepts
while a bypass receiver runs the self-sent rule, which the MCP server (the session's direct child) passes on Linux
and macOS alike. Spec §3.9's Linux fallback is replaced by: the same behaviour as macOS; `doctor`'s `held` advice names
`crossSessionInbound`.

## 5. Priorities

- `now` (without attachments) aborts the running turn. catherd never uses it.
- `next` (the default): drained between tool rounds of a running turn; wakes an idle session.
- `later`: not drained mid-turn (the message waits for the turn to end); still wakes an idle session, since peer
  items are queued as prompts. Native background-task notices use it.

Accepted messages are queued as `{ mode: "prompt", isMeta: true, skipSlashCommands: true, skipAttachments: true,
priority, origin: { kind: "peer" } }`.

## 6. The envelope

`<cross-session-message ATTRS>\n<body>\n</cross-session-message>`, attributes in the order `from`, `from-session`,
`hop-chain`, `from-name`, `from-mode`, `from-plugin`. The receiver re-serialises the attributes it parsed and keeps
them only when the result matches byte for byte; otherwise the message is still delivered, without its name and mode.
A UDS sender's `from-plugin` is stripped; nested openers in the body are neutralised; text that is not an envelope is
neutralised but delivered.

catherd sends `<cross-session-message from-name="catherd">` (no `from`: the MCP server has no reply address). It
round-trips: the name is `[A-Za-z0-9 ._-]` with no quote, angle bracket or newline.

## 7. The transcript's enqueue line (what `doctor` checks)

An accepted message appends `{"type":"queue-operation","operation":"enqueue","timestamp":…,"sessionId":…,"content":"<the envelope text>"}`
to the session's transcript. A held or refused message writes **no** enqueue line, so the line tells `ok` from
`held`. Observed live: enqueue, dequeue and remove lines of this shape.

The transcript is `<config dir>/projects/<slug>/<sessionId>.jsonl`, the slug being the project root with every
character outside `[A-Za-z0-9]` replaced by `-` (longer than 200: the first 200 plus a hash). A git worktree may log
under its main checkout's slug, so `doctor` globs `projects/*/<sessionId>.jsonl` instead of computing the slug
(controller ruling c).

## 8. Verdict for catherd

- **Linux, no settings:** delivery works. A prompting receiver accepts any message without `from-mode`; a bypass
  receiver runs the self-sent rule through `/proc`, which the MCP server passes.
- **macOS, no settings:** delivery works (inferred): the same, through the `ps` walk, with the child token as the
  fallback when the walk fails.
- **Send:** the auth line with `CLAUDE_CODE_MESSAGING_TOKEN`, then `type: "user"` with string content and a
  `priority`, no `session_id`, envelope `from-name="catherd"`, one write, close after 150 ms.
- **Never** declare `from-mode`. `crossSessionInbound: hold|refuse` stops delivery; `doctor` says so and `peek`
  still works.
- **Live checks still owed** (the owner runs `bun scripts/spike-push.ts` from a Claude Code session's Bash tool on
  macOS and on Linux): the message arrives (the script finds the enqueue line); an MCP server finds the socket and
  token at spawn (the `session` log row on the first `catherd mcp` start).
