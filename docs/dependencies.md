# Dependencies

One line per dependency: what it does for catherd, and why this one.

## Runtime

- citty — the `catherd` main command and its subcommands — unjs, tiny, typed `defineCommand`, `--version` from `meta`
- ofetch — HTTP with retries for the Jev client — unjs, works with `fetch`, built-in retry/backoff
- zod — schemas for the catalog, profiles and MCP tool inputs — the standard TS-first validator
- @modelcontextprotocol/sdk — the MCP server (`catherd mcp`) — the official SDK
- @opentui/core — the TUI renderer — the terminal renderer opencode itself uses (spec §3, §8.4)
- @opentui/react — React bindings for the TUI (`init`, the profile matrix, `watch`) — pairs with `@opentui/core`
- react — required by `@opentui/react`'s component model — peer dependency of the TUI layer

## Dev

- typescript — `tsc --noEmit` typecheck — 7.x is the native compiler, the fastest
- @types/bun — Bun globals and `bun:test` types for `"types": ["bun"]` — the only source of them
- @types/react — types for the OpenTUI React components — needed alongside `react`
- oxlint — lint — Rust, the fastest linter, sensible defaults with no config
- oxfmt — format — Rust, Prettier-compatible output, the fastest formatter
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

## Dropped from the Node-toolchain plan (OVERRIDES)

- xdg-basedir — no release since 2021; `src/paths.ts` reads `XDG_CONFIG_HOME`/`XDG_DATA_HOME` itself
- execa — `Bun.spawn` covers detached children with stdio on files; kept only if a detach check fails (not needed in Tasks 1-4)
- tinyglobby — owned paths are matched literally, so `src/core/reply.ts` walks them with plain `node:fs` `readdirSync` recursion instead of a glob library at all; `Bun.CryptoHasher("sha1")` does the hashing
- tsdown — no build step; Bun runs `src/cli.ts` directly via its shebang
- vitest — `bun test` is the runner
