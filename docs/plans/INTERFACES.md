# Cross-plan interfaces

The four plans are written in parallel, and each one imports from the others only through the names below. `src/types.ts` (plan 1, Task 2) is the base contract: never redefine a name it exports. Every name here is created by exactly one plan and consumed by the plans listed after "used by".

## Plan 1 — core (`docs/plans/2026-09-24-01-core.md`)

- `src/paths.ts`:
  - `configDir()`, `dataDir()`
  - `repoSlug(root)`, `runsRoot(root)`
- `src/cli.ts`: the citty main command. Each plan defines its subcommands with citty's `defineCommand` in `src/<area>/commands.ts`, exporting them as named `CommandDef`s, and registers each one by adding an entry to `subCommands` in `src/cli.ts`. Plan 1 registers `lock`; plan 2 registers `catalog`; plan 3 registers `mcp` (and `wait`, only if S1 fails); plan 4 registers `init` and `watch`, and makes the bare `catherd` run the profile editor.
- `src/core/runstore.ts`:
  - `createRun(repo, title, aLines) → Run`, `openRun(repo, id)`, `listRuns() → Run[]`
  - `rolePaths(dir, name) → { brief, fix, out, jsonl, err }`
  - `appendJsonl(file, value)`, `readJsonl<T>(file)`
  - `appendRunRecord`, `readRunRecords(dir)`
  - `writeState(dir, StateSnapshot)`, `appendLedger(dir, row)`
  - `LiveMarker`, `writeLive`, `clearLive`, `readLive(dir)`
  - `Run = { dir, id, meta: RunMeta }`
- `src/types.ts` additions: `HarnessConfig`, `Profile.harness: { codex; opencode }`, and `RunRecord.isolated: boolean` (spec §8.2).
- `src/core/codex.ts`:
  - `DispatchOpts`, including `isolated?: boolean` (default false = native)
  - `runCodex(o) → Promise<RunRecord>`
  - `userCodexHome()` is `${CODEX_HOME:-~/.codex}`; `codexHome()` is catherd's isolated home, used only when isolated.
- `src/core/opencode.ts`: also exports `opencodeConfigHome()`, the empty config home for isolated runs.
- `src/core/opencode.ts`: `runOpencode(o) → Promise<RunRecord>`.
- `src/core/reconcile.ts`: `reconcileLive(dir) → { finished, stillRunning }`, `pidAlive(pid)`.
- `src/core/lock.ts`: `heavySlots(setting)`, `acquire(slots, label) → { slot, release(): Promise<void> }`, `LOCK_STALE_MS`, and the citty command `lockCommand`.
- `src/cli.ts` exports `main`, the citty root command.
- `LiveMarker.isolated: boolean`.
- `test/helpers.ts`: `withHome()`, `tempRepo()`, `fakeBinPath()`.

## Plan 2 — routing and profiles (`docs/plans/2026-09-24-02-routing.md`)

- `catalog/catalog.json`: the shipped catalog, of type `Catalog`.
- `catalog/models-dev.json`: the snapshot of the models.dev fields catherd uses.
- `src/routing/catalog.ts` (used by 3, 4):
  - `loadCatalog(): Catalog`: shipped catalog, merged with the models.dev snapshot, merged with `<config>/catalog.override.json`.
  - `modelOf(c: Catalog, id: string): CatalogModel | undefined`
  - `capableFor(role: Role, m: CatalogModel): boolean`
  - `entryFor(c: Catalog, rung: RungId): CatalogEntry | undefined`: resolves `treatLike`.
  - `isScored(c: Catalog, rung: RungId): boolean`
  - `refreshModelsDev(): Promise<{ models: number }>`
- `src/profile/profile.ts` (used by 3, 4):
  - `defaultProfile(): Profile`
  - `loadProfile(name?: string): Profile`: no name means the active one.
  - `saveProfile(p: Profile): void`: writes JSON only; agent files are plan 3.
  - `listProfiles(): string[]`
  - `activeProfileName(repo?: string): string`, `setActiveProfile(name: string, repo?: string): void`
  - `validateProfile(p: Profile, c: Catalog): string[]`: an empty array means valid.
  - `type ProfilePatch = { objective?; roles?: Partial<Record<Role, Partial<RoleConfig>>>; lock?; notify? }`
  - `patchProfile(p: Profile, patch: ProfilePatch): Profile`
- `src/routing/jev.ts` (used by 3, 4):
  - `jevKey(): string | null`: reads `TYPESAFE_API_KEY`, else `<config>/credentials.json` `{ "typesafeApiKey": … }`.
  - `saveJevKey(key: string): void`: file mode 600.
  - `testJevKey(key: string): Promise<boolean>`
  - `askJev(q: JevQuestions, state: Record<string, string>, o?: { runDir?: string; fetchImpl?: typeof fetch }): Promise<JevAnswers | null>`: null means unavailable.
- `src/routing/select.ts` (used by 3, 4):
  - `candidates(p: Profile, c: Catalog, role: Role): RungId[]`
  - `select(p, c, role, kind: Kind, difficulty: Difficulty): { rung: RungId; ladder: RungId[] }`
  - `defaultLadder(p, c, role): { rung: RungId; ladder: RungId[] }`
- `src/routing/route.ts` (used by 3):
  - `route(o: { runDir: string; profile: Profile; catalog: Catalog; role: Role; laneText: string }): Promise<RouteDecision>`
  - `nextRung(ladder: RungId[], current: RungId): RungId | null`
  - `askFinding(runDir: string, laneText: string, finding: string): Promise<{ value: "design" | "code" | "unclear"; confidence: number | null; source: "jev" | "default" }>`
  - `askSameDefect(runDir: string, before: string, after: string): Promise<{ value: "yes" | "no"; confidence: number | null; source: "jev" | "default" }>`
- The `catalog` command (`catherd catalog refresh`) and the profile's `lock.heavy` wired into `lockCommand`.

## Plan 3 — MCP server, Claude agents, plugin (`docs/plans/2026-09-24-03-mcp-plugin.md`)

- `src/profile/agents.ts` (used by 4):
  - `agentName(role: Role, rung: RungId): string`: `catherd-<role>-<model slug>-<effort>`, where the model slug is lowercase with every non-alphanumeric run turned into `-`.
  - `writeClaudeAgents(p: Profile, c: Catalog): { written: string[]; linked: string[]; pruned: string[] }`: writes the files under `<config>/agents/<profile>/`, symlinks each one into `~/.claude/agents/` (or `CATHERD_CLAUDE_AGENTS_DIR`), and prunes links belonging to other profiles.
  - `saveProfileAndAgents(p: Profile, c: Catalog)`: `saveProfile` plus `writeClaudeAgents`. This is the only writer that the TUI, `init` and `profile_set` use.
- `src/core/status.ts` (used by 4):
  - `summarizeRun(run: Run): RunSummary`
  - `RunSummary = { id; title; repo; stateTail: string[]; live: { name; rung; secs; pid }[]; totals: { runs; ok; notOk: string[]; secs; tokens: Tokens; costUsd: number }; jev: { decisions: number; fallbacks: number }; milestones: string[] }`
  - It calls `reconcileLive` first.
- `src/mcp/server.ts`: `startMcpServer(): Promise<void>`, and the `mcp` command. The tool names are those in spec §7.
- `plugin/…`, `.claude-plugin/marketplace.json`, and the two skills.

## Plan 4 — TUI (`docs/plans/2026-09-24-04-tui.md`)

- `src/tui/…`: the `init` command, the bare `catherd` (profile editor), `watch`, and `detectBackends(): Promise<BackendStatus[]>`, all using only the names above.
