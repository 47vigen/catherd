# Overrides — read before any plan

The four plans were written for a Node toolchain. On 2026-09-24 catherd moved to **Bun + OpenTUI** (spec §3), and took on four v1 additions (spec §11b). This file wins wherever a plan disagrees with it. Implement each plan's *behavior and tests*, translated as below.

## Toolchain translation

| Plan says | Do instead |
|---|---|
| `pnpm add X` / `pnpm add -D X` | `bun add X` / `bun add -d X` (latest, no version) |
| `pnpm vitest run …`, `pnpm test` | `bun test …` |
| `import { describe, it, expect, beforeEach, … } from "vitest"`, `vi.fn`, `vi.spyOn` | `from "bun:test"`: `mock()`, `spyOn()` |
| vitest config and include/exclude of `test/live/**` | `bunfig.toml` `[test]` plus a guard: live tests start with `if (!process.env.CATHERD_LIVE) test.skip(...)`, or use `describe.skipIf(!process.env.CATHERD_LIVE)` |
| tsdown, `pnpm build`, `dist/cli.js` | **No build.** `package.json` `"bin": { "catherd": "src/cli.ts" }`; `src/cli.ts` starts with `#!/usr/bin/env bun`; `"files": ["src", "catalog", "plugin"]` |
| `node dist/cli.js …` | `bun src/cli.ts …` |
| `pnpm typecheck` | `bun run typecheck` → `tsc --noEmit` (typescript latest, 7.x) with `"types": ["bun"]` (`bun add -d @types/bun`) |
| `pnpm lint` / `format:check` | `bun run lint` (oxlint) / `bun run format:check` (`oxfmt --check`) |
| husky / lefthook via pnpm | lefthook; commands use `bunx` |
| `engines.node` | `"engines": { "bun": ">=1.4" }` |
| `npx -y catherd@<v> mcp` | `bunx catherd@<v> mcp` |

## Built-ins before packages

- **Processes: `Bun.spawn`, not execa.** Children start detached, with stdout and stderr written straight to files (`stdout: Bun.file(path)`), which keeps plan 1's rule that a child survives the MCP server. First step: verify `Bun.spawn` supports a detached, own-process-group child in Bun ≥ 1.4 (the `detached` option, or `setsid` via `["setsid", …]` on Linux and a double-fork fallback on macOS). Pin it with the existing test that the fake codex sees its stdout as a regular file. If Bun cannot detach, keep execa for `runChild` only, and write down why in `docs/dependencies.md`.
- **File walks: `Bun.Glob`, not tinyglobby.** Owned paths must match literally, including `app/[id]/page.tsx`: escape them, or check literal existence before globbing.
- **Hashing: `Bun.CryptoHasher("sha1")`.** Files: `Bun.file`, `Bun.write`. HTTP: `fetch`, wrapped in ofetch for the Jev retries.
- **Kept packages:** citty, ofetch, zod, `@modelcontextprotocol/sdk`, `@opentui/core`, `@opentui/react` (plus react).
- **Dropped:** execa (unless the detach check fails), tinyglobby, tsdown, vitest, Ink and every ink-* package, and ink-testing-library.
- **Also dropped, for having no release since 2021:**
  - `xdg-basedir`: `src/paths.ts` reads `process.env.XDG_CONFIG_HOME` and `XDG_DATA_HOME` itself, with defaults `~/.config` and `~/.local/share`.
  - `proper-lockfile`: the lock takes a slot by creating `slot-<i>` with an exclusive create (`openSync(path, "wx")`) holding `{ pid, label }`. It reclaims a slot whose pid is dead (`process.kill(pid, 0)` throws ESRCH). This is the lock design of the original plan 1, Task 7, and `release` stays async-compatible (it returns a resolved Promise) so its callers keep the same shape.
- **Freshness check:** before adding any package, look at its last publish date (`npm view <pkg> time.modified`). A package with no release in the last 12 months needs a one-line justification in `docs/dependencies.md`, or it gets replaced.
- **Fake CLIs in `test/fixtures/bin/`** become `#!/usr/bin/env bun` scripts. The `package.json` `{ "type": "commonjs" }` trick is no longer needed.

## Plan 4: OpenTUI instead of Ink

Build the TUI with `@opentui/react`. Plan 4's closing section, which maps each Ink component to its OpenTUI equivalent, is the starting point. Before the first component, read `@opentui/react`'s README and examples in `node_modules`; they cover the renderer setup, keyboard input, the box/text elements, colours, and the test renderer. Keep plan 4's behavior, look, theme module and tests; only the rendering layer changes.

## Cross-plan fixes (from the consistency review)

1. **Plan 2 was written against the pre-revision plan 1.** Register its command in the citty root `main` (`subCommands`), use `acquire()` with an async `release`, and use `LOCK_STALE_MS`.
2. **Climbing under `objective: "speed"`.** The objective chooses only the start rung: the first bar-clearing candidate, ordered by cost or speed. The climb ladder is the other bar-clearing candidates at least as strong as the start, ordered by strength on the kind's primary dimension, weakest first. The primary dimension is `terminal` for terminal work and `repo_code` for all other kinds; costRank breaks ties. The approved-ladder pin for `objective: "cost"` stays. Add a test that `speed` never climbs to a weaker rung.
3. **Plan 3's `profile_set`** calls plan 2's `patchProfile`, which accepts `harness`. It does not merge `harness` itself.
4. **Every `RunRecord` literal**, including plan 3's `test/records.ts` `fakeRecord`, includes `isolated`.
5. **`saveTreatLike(rung, like)`** lives in plan 2's `src/routing/catalog.ts` and writes `<config>/catalog.override.json`. Plan 4 imports it from there.
6. **The ledger header** is `milestone | what | commit | minutes | evidence`. Plan 3's `land` computes the minutes since the previous landing, or since run start. Plan 4's `watch` parses that column.
7. **Plan-3 names that plan 4 uses:** `harnessCosts`, `HarnessCost`, `RunSummary.harness` (`src/core/harness.ts`, `src/core/status.ts`) and `fakeRecord` (`test/records.ts`).

## v1 additions (spec §11b)

- **`src/types.ts`** gains `Profile.failover?: Record<RungId, RungId>` and `Profile.budget?: { minutes?: number; tokens?: number; usd?: number }`. Both are optional, so old profile files still load.
- **Plan 2:** `validateProfile` checks that each failover target is a scored or treat-like rung on another backend. `route` takes a `budget` state `{ spentFraction: number }` and forces the cheapest bar-clearing start at ≥ 0.8.
- **Plan 3:**
  - `dispatch` does the limit failover and the budget refusal.
  - A `preflight(run)` tool.
  - `land` appends to `knowledge.md`, and `read_knowledge(repo)` returns it.
  - The orchestrator skill runs `preflight` after the lanes exist, and the dossier brief reads the knowledge file.
  - `status` shows the budget.
- **Plan 4:** the matrix editor edits budget and failover, and `watch` shows the budget bar.
