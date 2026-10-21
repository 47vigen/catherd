# Dependencies

The panel (`web/`, its own package, copied from remora's console): Vite 8, React 19, HeroUI v3 with
`@heroui/styles`, Tailwind v4, TanStack Router (file routes, the committed `routeTree.gen.ts`) and Query,
`@hey-api/openapi-ts` 0.99.0 (the client is generated from `web/openapi.json`, which catherd's zod schemas write),
Geist fonts, `@gravity-ui/icons`, shiki, `react-aria-components`, oxlint and oxfmt, Vitest with jsdom, Playwright, and
`vite-plugin-compression2`. The versions are in `web/package.json`; the root installs none of them.

One line per dependency: what it does for catherd, and why this one.

## Runtime

- citty — the `catherd` main command and its subcommands — unjs, tiny, typed `defineCommand`, `--version` from `meta`
- zod — schemas for the catalog, profiles and MCP tool inputs — the standard TS-first validator
- @modelcontextprotocol/sdk — the MCP server (`catherd mcp`) — the official SDK

## Dev

- typescript — `tsc --noEmit` typecheck — 7.x is the native compiler, the fastest
- @types/bun — Bun globals and `bun:test` types for `"types": ["bun"]` — the only source of them
- oxlint — lint — Rust, the fastest linter, sensible defaults with no config
- oxfmt — format — Rust, Prettier-compatible output, the fastest formatter
- lefthook — git hooks for lint, format and commit messages — a single Go binary, no shell scripts to keep
- @changesets/cli — versions, changelog and npm trusted publishing — the standard for single-package release notes
- @commitlint/cli — checks commit messages on commit-msg — the standard checker
- @commitlint/config-conventional — the Conventional Commits rule set — the standard rule set

## Why no process library: detached children

`Bun.spawn(cmd, { detached: true, stdin/stdout/stderr: <fd> })` starts the child in its own process group (POSIX
`setsid()`: the child's pgid equals its own pid). A child spawned this way keeps running after its parent exits, is
reparented to pid 1, and writes to raw fd stdio (from `openSync`) as a real file, not a pipe through the parent.
`Bun.spawn` alone covers `launchSupervisor` (`src/infra/launch.ts`), so catherd needs no execa.

## opencode: the v2 facts the adapter relies on

catherd supports opencode v2 only, 2.0.16 or newer (`OPENCODE_MIN_VERSION` in `src/adapters/opencode/index.ts`;
install with `curl -fsSL https://opencode.ai/v2/install | bash`). The npm package `opencode-ai` is v1 and fails the
version probe. The full research is in `docs/research/2026-09-25-opencode.md`.

- A role runs as `opencode run --format json --auto --agent <agent> -m <model>[#<variant>]`, with `-s <session>` to
  continue a thread. The brief arrives on stdin. The stream is JSON events on stdout, each carrying a `sessionID`.
- An isolated run (the profile's `harness.opencode.isolated`) adds `--standalone` and points `XDG_CONFIG_HOME` at
  catherd's own config root: v2's background service ignores the client's config env, a standalone server reads it.
  Only the config dir is isolated; the session database stays in opencode's shared data dir.
- Token and cost totals come from `opencode api GET /api/session/<id>` after the run (the stream often drops its last
  `step_finish`), minus what earlier records on the same session already counted.
- Busy check (`isBusy`): a session is busy while `GET /api/session/active` lists it, unless its messages
  (`GET /api/session/<id>/message`) show it only waiting out a usage limit (`limitRetry`). Empty or failed API output
  counts as not busy, so a hung run still times out.
- Cancelling also sends `POST /api/session/<id>/interrupt`, because killing the v2 client does not stop its session.
- The adapter's tests replay recorded fixtures from `test/fixtures/adapters/opencode/`.

## Considered and not used

- xdg-basedir — no release since 2021; `src/infra/paths.ts` reads `XDG_CONFIG_HOME`/`XDG_DATA_HOME` itself
- execa — `Bun.spawn` covers detached children with stdio on files (above)
- tinyglobby — owned paths are matched literally (spec §4.2), and finalize compares `git status` fingerprints (`src/infra/git.ts`) instead of walking a glob
- tsdown — no build step; Bun runs `src/cli.ts` directly via its shebang
- vitest — `bun test` is the runner
