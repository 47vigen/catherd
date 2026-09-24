# Dependencies

TUI: OpenTUI (`@opentui/react` + `@opentui/core`), decided in OVERRIDES before this plan started —
both were already in `package.json`, so plan 4 Task 1 skipped the spike and went straight to
reading `node_modules/@opentui/react/README.md` and its type definitions. Test API: `testRender`
from `@opentui/react/test-utils` (wraps `@opentui/core/testing`'s `createTestRenderer`), used as
`const { renderOnce, captureCharFrame, mockInput } = await testRender(<El/>, { width, height })`.
Keys go through `mockInput.pressArrow/pressEnter/pressEscape/pressBackspace/pressKey/typeText`;
`test/tui/helpers.ts`'s `press()` wraps those behind the same `KEY.up`/`KEY.down`/… names plan 4
uses. Colour: OpenTUI takes RGB only and downsamples itself for the terminal it finds, so
`theme.ts`'s `tint()` returns one hex value per tone at every depth above 1, and `undefined` at
depth 1 (`NO_COLOR`) — no `ansi256(n)` or named-colour branches, unlike the Ink-era plan text.

One line per dependency: what it does for catherd, and why this one.

## Runtime

- citty — the `catherd` main command and its subcommands — unjs, tiny, typed `defineCommand`, `--version` from `meta`
- ofetch — HTTP with retries for the Jev client — unjs, works with `fetch`, built-in retry/backoff
- zod — schemas for the catalog, profiles and MCP tool inputs — the standard TS-first validator
- @modelcontextprotocol/sdk — the MCP server (`catherd mcp`) — the official SDK
- @opentui/core — the TUI renderer — the terminal renderer opencode itself uses (spec §3, §8.4)
- @opentui/react — React bindings for the TUI (`init`, the profile matrix, `watch`) — pairs with `@opentui/core`
- react — required by `@opentui/react`'s component model — peer dependency of the TUI layer
- microdiff — the diff `profile_set` returns — tiny, zero-dependency, maintained object diff

## Dev

- typescript — `tsc --noEmit` typecheck — 7.x is the native compiler, the fastest
- @types/bun — Bun globals and `bun:test` types for `"types": ["bun"]` — the only source of them
- @types/react — types for the OpenTUI React components — needed alongside `react`
- oxlint — lint — Rust, the fastest linter, sensible defaults with no config
- oxfmt — format — Rust, Prettier-compatible output, the fastest formatter
- string-width — measures terminal cells in the 80-column TUI tests (`test/tui/helpers.ts`'s `widest`) — the standard cell-width function; emoji glyphs (🐾, 🐈) count as 2 cells and a hand count gets that wrong
- lefthook — git hooks for lint, format and commit messages — a single Go binary, no shell scripts to keep
- @changesets/cli — versions, changelog and npm trusted publishing — the standard for single-package release notes
- @commitlint/cli — checks commit messages on commit-msg — the standard checker
- @commitlint/config-conventional — the Conventional Commits rule set — the standard rule set

## Detach check (Task 5, step 0)

`Bun.spawn(cmd, { detached: true, stdin/stdout/stderr: <fd> })` starts the child in its own
process group (POSIX `setsid()`, confirmed with `ps -o pid,pgid,ppid`: child's pgid equals its
own pid). Verified with a throwaway parent that spawns a child sleeping 1.5s, then exits
immediately: the child kept running, was reparented to pid 1, and wrote its marker file after the
parent had already exited. Raw fd stdio (from `openSync`) is honoured as a real file, not a pipe
through the parent. `Bun.spawn` alone covers `runChild`; execa is not needed.

## opencode CLI check (Task 6, step 1), verified live against opencode 2.0.15

- `opencode run --help` matches the plan's flags exactly: `--standalone`, `--format json`, `-m`,
  `--agent`, `--auto`, `-s`. No renaming needed.
- `--standalone` plus an empty `XDG_CONFIG_HOME` runs a real turn end-to-end (confirmed with a
  live `opencode/space-bunny-free` call): JSON events on stdout, a `sessionID` on every event.
- `opencode api GET /api/session/<id>` returns `.data.cost` for both a native session and one
  created under `--standalone`, because only the *config* dir is isolated — the session database
  is in opencode's *data* dir, which stays shared. So `costUsd` is never `null` for isolated runs.
- **Deviation from the busy-check text above:** on 2.0.15, `GET /api/session/<id>/message` never
  contains the string `"status":"running"` — verified live by polling mid-tool-call. The busy
  signal is structural: `.data` is newest-first, and the session is idle iff `data[0].type ===
  "idle"`; while a tool streams, `data[0]` is the assistant message instead. `runOpencode`'s busy
  check parses JSON and reads `data[0]?.type` rather than substring-matching `"status":"running"`,
  and the fake `opencode`/tests use that same shape.

## Dropped from the Node-toolchain plan (OVERRIDES)

- xdg-basedir — no release since 2021; `src/paths.ts` reads `XDG_CONFIG_HOME`/`XDG_DATA_HOME` itself
- execa — `Bun.spawn` covers detached children with stdio on files; kept only if a detach check fails (not needed in Tasks 1-4)
- tinyglobby — owned paths are matched literally, so `src/core/reply.ts` walks them with plain `node:fs` `readdirSync` recursion instead of a glob library at all; `Bun.CryptoHasher("sha1")` does the hashing
- tsdown — no build step; Bun runs `src/cli.ts` directly via its shebang
- vitest — `bun test` is the runner
