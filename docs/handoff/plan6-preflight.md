# Plan 6 (TUI) pre-flight scan

Scanned against main `d0f6fd8`. Wave 1 is already on this branch (`44aa207` Task 2, `14791fc` Task 1,
`6ebb07f` Task 4), so their real exports stand in for "produced" below. The plan was replayed on `e1ffa6c`.
What changed on main since then and matters here: doctor adds `profile:<name>` and `binding:<repo>` rows;
`newSessionNeededFor` now also lists pruned agents; `createProfile("default")` throws (default always exists);
`Saved` is now `ProfileSaved` (same fields); ProfilePort's `get` returns `{ active, here }` (the TUI does not
use the port).

## 1. Pairs that share a file or an interface

| Pair | Shared | Produced | Consumed | Agree |
|---|---|---|---|---|
| 1→3,7–13 | `theme.ts`, `text.ts` | `detectUi(rawArgs, env): Omit<Ui,"mode">`, `glyph`, `STATE_TOKEN`, `FACES`, `mascot(mood)`, `Mood` (incl. `waiting`), `wrap`, `ago`, `clock`, `shortRung`, `ascii`, `width` (landed) | 12: `{...detectUi(o.rawArgs, env), mode}`; 9: `mascot("waiting")`, `glyph("full"/"empty"/"live"/"dot")`; 13: `mascot("good")` | yes |
| 1↔13 | `test/tui/theme.test.ts` | 1 deletes the colour-depth case (present at d0f6fd8 line 97; already gone on branch) | 13 deletes the file | yes |
| 2→3 | `commands.ts` | `CommandDef`, `commandsIn`, `isGuarded`, `isPrintable`, `DEFAULT_KEYS`, `LEADER`, `LEADER_TIMEOUT_MS`, `Scope`, `CommandId` | `providers/keymap.tsx` | yes |
| 2→7,11,12 | `commands.ts` | `formatKeys`, `Keybinds`, `COMMANDS`, `resolveKeybinds` (throws `E_CONFIG_KEYBIND`) | Footer, palette/help, `keybindsFromConfig` | yes |
| 2→7–11 | command ids by scope | `global` app.interrupt/back; `app` app.*, tab.*, profile.new/list; `tab.status` status.recheck/copy; `row.status` status.open; `tab.profiles` profile.save/activate/copy/revert, catalog.refresh, edit.undo/redo; `row.profiles` tree.*; `tab.runs` runs.refresh/pause; `row.runs` runs.open/cancel; `list` list.*; `filter` filter.accept; `dialog` dialog.* | every `useCommandLayer(scope, {...})` in 7, 8, 9, 10, 11 registers ids of that scope only | yes |
| 3→7–12 | `providers/keymap.tsx`, `test/entry/tui/render.tsx` | `useCommandLayer`, `setModal`, `reachableCommands`, `useKeybinds`, `useKeymapVersion`, `createAppKeymap`, `AppKeymapProvider({keybinds, keymap?})`, `mount`, `settle`, `Screen` | 7 `AppProvider` (`setModal`), `Footer`, harness; 11 palette; 12 `createAppKeymap(renderer)` | yes |
| 4→5,7–12 | `state.ts` | `Purpose` (14 types), `Dialog` (4 kinds), `Action` (18), `ARM_MS`, `currentDraft`, `dirtyCount`, `totalDirty`, `isArmed`, `initialState(tab?)`, `NumberPath`, `SelectOption` (landed) | 8 dialogs, 10 handlers (`new`, `copy`, `profiles`, `activate`, `revert`, `save`, `start`, `failover`, `treatLike`, `number`), 11 (`palette`, `help`, `quit`, `stories`), 12 `initialState(o.tab ?? "status")` | yes |
| 4→10 | `patchBetween(a, b)` in `src/domain/profile.ts` | landed, throws `E_INPUT_INVALID` | save handler `patchBetween(d.base, d.doc)`; error lands in the save dialog via `invalid` | yes |
| 5→6,8,10 | `profile-tree.ts` | `withStaged(catalog, staged)`, `buildRows`, `filterRows`, `firstMatch`, `patchFor`, `numberPatch/Value`, `parseNumber`, `startOptions`, `failoverOptions`, `treatLikeOptions` | 6 fixtures (`withStaged`), 8 `previewSave` (`withStaged`), 10 view | yes |
| 6→7–12 | `Effects` | `profiles(): {names, active}` (global), `activate(name): Synced`, `catalog(billing)`, `validate`, `agents`, `save(name, patch, treatLikes)`, `create`, `remove`, `cancel`, `run`, `runs`, `refreshCatalog`, `harnesses`, `enforcement`, `version`; `liveEffects()`; `fixtureEffects({runs?, report?})` | 7 `Data.profiles: Polled<{names; active}>`; 8 `previewSave(d, Pick<Effects,"catalog"\|"validate"\|"agents">)`; 9, 10, 11 read `.active`; 12 `liveEffects()` | yes as written; **all change under the repo ruling (§3)** |
| 7→8–12 | providers, widgets, `harness.tsx` | `AppApi` (getState, dispatch, answer, onDialog, onBack, back, keep, exit, copy), `useDialogHandler`, `useBack`, `useNow`, `usePoll`, `useLoad`, `Data`, `Providers` (no DataProvider inside), `Header({version, profile, active, dirty, mood, width})`, `Line`, `List` | 8 `Shell` adds `DataProvider`; 11 `App` wraps `DataProvider`; 12 mounts `Providers` + `App` | yes |
| 8→9–11 | `Shell`, `DialogHost`, `Behind`, `SaveDialog` answers `save`/`activate` | | 10 `useDialogHandler("save", (p, value) => … value === "activate")`; 11 mounts `DialogHost`, `Behind` | yes |
| 9/10→11 | `StatusView`, `RunsView`, `ProfilesView({width,height})`, `openNewProfile`, `openProfileList`, `useProfileDialogs` | | `Screen` | yes |
| 11→12 | `App({ story? })` | | `<App story={story} />` inside `Providers` | yes |
| 12↔13 | none (13 edits `init-command.ts`, 12 edits `cli.ts`/`runs-command.ts`) | | | yes |
| 3↔13, 11 | `package.json`, `docs/dependencies.md` | 3: exact pins + `@opentui/keymap`; 11: `tui-frames` script after `format:check`; 13: `files` + `string-width` removal | different lines | yes |

## 2. Each task: self-consistency and anchors on main

| Task | Self-consistent (tests vs code, files) | Anchors on d0f6fd8 | Finding |
|---|---|---|---|
| 1 | landed, 11 tests | colour-depth case existed (line 97) | none |
| 2 | landed, 8 tests | `E_CONFIG_KEYBIND` in `domain/errors.ts` | `profile.activate.cli` is `catherd profile use <name>`; under the ruling a bound repo's twin is `… --repo` (§3, optional) |
| 3 | 5 tests; creates `keymap.tsx`, `render.tsx` | `@opentui/core`/`react` 0.5.12 installed with carets; dependencies.md paragraph "…unlike the Ink-era plan text." at line 12; both runtime lines present | `bun add` needs the registry (proxy); none otherwise |
| 4 | landed (`patchBetween` + 3 profile tests, 10 state tests) | `isPlain`, `ProfilePatchSchema`, `z` in `profile.ts` | none |
| 5 | 11 tests | `billingKeyOf`, `rungInfo`, `scoresOf`, `candidates`, `inferredScores`, `quotaOf`, `routingProfileOf`, `parseRung` (`domain/ids.ts`), `ACCESS` (`domain/record.ts`) all exported | profile-rules' warning text lost "(no honesty score)" since the replay; no brief asserts it |
| 6 | 5 tests; code matches tests | `ADAPTER_IDS` (`adapters/backend.ts`), `adapterFor` (`registry.ts`), `cancel(deps, runId, name): DispatchResult{record}`, `findRun`, `listRuns(): {runs, corrupt[{id,reason}]}`, `readRoutes`, `appendRoute`, `runPaths` (`runs, routes, jev, agents, state, ledger, roles`), `summarizeRun(deps, run)`, `catalogQuery(f, billing)`, `loadCatalog({timings})`, `refreshDiscovery(o?)`, `saveTreatLike(rung, like)`, `doctor({bunVersion, version, handshake})`, `mcpHandshake()`, `activate(name, repo = null)`, `activeName(repo = null)`, `freshRun`, `withHome`, `snapshotEnv` — all match | D1, D2 below; ruling §3 |
| 7 | 8 + 10 tests; 10 files created as listed | `Clock` (`@opentui/core`), `ManualClock` | ruling §3 |
| 8 | 15 tests | `Change`, `diffProfiles`, `resolveProfile`, `defaultProfileDoc`, `Validation` | ruling §3 (optional line) |
| 9 | 4 + 5 tests; `runs.tsx` imports `runParts` from `status.tsx` (created in the same task) | `Check {id,label,state,word,detail,fix?}`, `BudgetStatus {fraction, minutes?, tokens?, usd?}` | D3; ruling §3 |
| 10 | 11 tests (counted) | `PROFILE_NAME`, `isCatherdError`, `resolveProfile` | D4, D5; ruling §3 |
| 11 | 14 + 67 tests (11 stories × 6 + doc) | none outside the TUI | D6; ruling §3 |
| 12 | 4 + 3 tests | `cli.ts` line 43–47 `run` block and `type Command` line 18 exact; first import `runtimeRefusal` line 2; runs-command doc comment, `meta.description`, `interval` description and `if (args.once \|\| args.json) …` exact; `SRC` in `test/import-graph.ts`; `readConfig` loose schema keeps `keybinds` | D7; ruling §3 |
| 13 | notices 2 tests; init test edits | `import { jevStep, PLUGIN_STEPS }` line 5; `--no-input writes and activates…` test with `expect(r.code).toBe(0)`; `import { mcpHandshake } from "./mcp/handshake.ts";` line 12; `setting up in` line 93; README `The TUI` row line 62 and `## Develop` line 84; dependencies `string-width`, `src/paths.ts`, tinyglobby lines; `fakeBinPath` + its comment; `testView`, `fakeDeps`, `freshRun`, `resetReadiness`, `dispatch` | D8 |

## 3. The repo ruling: every place that changes

Ruling: inside a repo bound to another profile the TUI opens on and labels the profile the repo runs on
(`here = activeName(gitToplevel(cwd))`), and Save & make active binds the repo (`activate(name, repo)`);
outside a repo it acts on the global active profile.

What main offers: `gitToplevel(dir: string): Promise<string | null>` (`src/infra/git.ts`, async; entry may
import infra, as `catalog-command.ts`, `lock.ts` and `profile-command.ts` already do);
`activeName(repo: string | null = null): string`; `activate(name: string, repo: string | null = null)`
(takes `null` as is, so no `?? undefined`); `readProjects().bindings: Record<string, string>`. Plan 5's
port already names the pair `{ active (global), here }` (`ProfilePort.get`); the TUI should copy those names.

**One point for the owner (cost: one condition).** The ruling does not cover a repo with no binding. There
`here` is the global profile anyway, so opening and labelling are the same. Activation is the open question.
Proposed: bind only when the repo already has a binding (`catherd profile use`'s default is global; binding
every repo the TUI is opened in would be a surprise). Below, `bound()` is
`repo !== null && readProjects().bindings[repo] !== undefined ? repo : null`.

| # | Task · file · symbol | Line in the brief now | Change |
|---|---|---|---|
| R1 | 6 · `effects.ts` · `Effects` | `profiles(): { names: string[]; active: string };` | `profiles(): { names: string[]; /** global */ active: string; /** what this directory runs on */ here: string; /** the bound repo, null outside one or unbound */ repo: string \| null };` and the comment on `activate`: "makes it active, or binds `repo` to it inside a bound repo" |
| R2 | 6 · `effects.ts` · `liveEffects` | `export function liveEffects(): Effects {` | `export function liveEffects(repo: string \| null = null): Effects {` + `const bound = () => (repo !== null && readProjects().bindings[repo] !== undefined ? repo : null);` (import `readProjects`) |
| R3 | 6 · `liveEffects.profiles` | `profiles: () => ({ names: listProfiles(), active: activeName() }),` | `profiles: () => ({ names: listProfiles(), active: activeName(), here: activeName(repo), repo: bound() }),` |
| R4 | 6 · `liveEffects.activate` | `activate: (name) => activate(name),` | `activate: (name) => activate(name, bound()),` |
| R5 | 6 · `effects.ts` (new export) | — | `export const hereWord = (p: { repo: string \| null }): string => (p.repo ? "this repo" : "active");` so 7/9/10/11 share one word |
| R6 | 6 · `fixtures.ts` · `fixtureEffects` | `o: { runs?: RunDetail[]; report?: DoctorReport } = {},` / `let active = "default";` | add `repo?: string; bindings?: Record<string, string>`; `const bindings = new Map(Object.entries(o.bindings ?? {}));` `const bound = () => (o.repo && bindings.has(o.repo) ? o.repo : null);` |
| R7 | 6 · `fixtures.profiles` | `profiles: () => ({ names: [...docs.keys()].sort(), active }),` | `profiles: () => ({ names: [...docs.keys()].sort(), active, here: bindings.get(o.repo ?? "") ?? active, repo: bound() }),` |
| R8 | 6 · `fixtures.activate` | `active = name;` / `` writes.push(`activate ${name}`); `` | `const r = bound(); if (r) { bindings.set(r, name); writes.push(`bind ${name} ${r}`); } else { active = name; writes.push(`activate ${name}`); }` |
| R9 | 6 · `fixtures.remove` | `if (name === active) throw new Error(...)` | also refuse a bound one, as `deleteProfile` does: `const at = [...bindings].find(([, p]) => p === name); if (at) throw new Error(`"${name}" is bound to ${at[0]}`);` |
| R10 | 6 · test "saves the staged treat-likes…" | `expect(fx.profiles()).toEqual({ names: ["default"], active: "default" });` | `…toEqual({ names: ["default"], active: "default", here: "default", repo: null });` |
| R11 | 6 · new test | — | "inside a repo bound to another profile, names it here and binds the repo on activate": `withHome(); const repo = tempRepo(); createProfile("cheap"); createProfile("other"); activate("cheap", repo); const fx = liveEffects(repo); expect(fx.profiles()).toMatchObject({ active: "default", here: "cheap", repo }); fx.activate("other"); expect([activeName(repo), activeName()]).toEqual(["other", "default"]); liveEffects(tempRepo()).activate("other"); expect(activeName()).toBe("other");` (6 tests) |
| R12 | 7 · `data.tsx` · `Data` | `profiles: Polled<{ names: string[]; active: string }>;` | `profiles: Polled<ReturnType<Effects["profiles"]>>;` (import type `Effects`) |
| R13 | 7 · `chrome.tsx` · `Header` | `if (props.active) left.push({ text: " (active)", tone: "muted" });` | add prop `label?: string`; `` left.push({ text: ` (${props.label ?? "active"})`, tone: "muted" }) ``. New case in `widgets.test.tsx`: `label="this repo"` → `" catherd 1.0.0  profile cheap (this repo)…"` (8 + 11 tests) |
| R14 | 8 · `save-dialog.tsx` · `SaveDialog` (recommended) | `"Applies to: native Claude agents in new Claude Code sessions; …"` | when `useData().profiles.value?.repo` is set, one more muted line: `` `Save & make active binds ${repo} to ${name}.` `` The button keeps spec §9.2's label. Test: save dialog with `fixtureEffects({ repo: "/r", bindings: { "/r": "default" } })` shows the line |
| R15 | 9 · `status.tsx` · `StatusView` | `const profiles = data.profiles.value ?? { names: [], active: "…" };` | `?? { names: [], active: "…", here: "…", repo: null }` |
| R16 | 9 · `status.tsx` · profile row | `` { text: `   ${profiles.active}`, bold: true }, `` / `` text: `  active · ${profiles.names.length} profile… `` | `profiles.here` / `` `  ${hereWord(profiles)} · ${…}` `` |
| R17 | 9 · `status.tsx` · `status.open` | `if (selected === "profile" \|\| selectedCheck?.id === "profile") { app.dispatch({ type: "show", name: profiles.active, … }) }` | row `profile` → `profiles.here`; doctor check `profile` → `profiles.active` (doctor's row is the global one); check `profile:<name>` → `<name>` (D3) |
| R18 | 9 · test | — | "shows and opens the profile this repo runs on": `fixtureEffects({ repo: "/r", bindings: { "/r": "cheap" } })` after `fx.create("cheap")`; frame has `cheap  this repo · 2 profiles`; `shift+g, k, k, return` → `{ tab: "profiles", profile: "cheap" }` (4 + 6 tests) |
| R19 | 10 · `openProfileList` | `current: n === p.active,` / `detail: [n === p.active ? "active" : "", …]` | `current: n === p.here`; `detail: [n === p.active ? "active" : "", p.repo && n === p.here ? "this repo" : "", …]` |
| R20 | 10 · `openActivate` | `if (data.profiles.value?.active === d.name)` / `` title: `Make ${d.name} active?` `` / message `"New Claude Code sessions … keep theirs."` / `yes: "Make active"` | read `const p = data.profiles.value`; compare `p?.here`; when `p?.repo`: title `` `Use ${d.name} in this repo?` ``, message `` `Binds ${p.repo} to it; the active profile (${p.active}) and other repos keep theirs.` ``, yes `"Bind to this repo"`; toast `` `${d.name} is already this repo's profile` `` |
| R21 | 10 · `activateNow` | `` app.toast({ variant: "success", message: `${name} is active` }); `` | read `const repo = data.profiles.value?.repo ?? null` before `refresh()`; `` repo ? `${name} is bound to ${repo}` : `${name} is active` `` |
| R22 | 10 · `ProfilesView` | `const active = data.profiles.value?.active ?? null;` (opens on it) | `const here = data.profiles.value?.here ?? null;` and `showProfile(app, here)` |
| R23 | 10 · `ProfilesView` top line | `{ text: draft.name === active ? " (active)" : "", tone: "muted" },` | `` draft.name === here ? ` (${hereWord(data.profiles.value ?? { repo: null })})` : "" `` |
| R24 | 10 · test | — | "inside a bound repo, opens on its profile and binds the repo": setup `f.create("cheap"); f.create("other")` with `fixtureEffects({ repo: "/home/me/app", bindings: { "/home/me/app": "cheap" } })` (harness needs the effects passed in: `profiles()` helper takes an `effects` arg); line 0 contains `PROFILE cheap (this repo)`; `ctrl+x l`, type `other`, `return`, `a` → `Use other in this repo?`; `return` → writes end `"bind other /home/me/app"`, line 0 `PROFILE other (this repo)` (12 tests) |
| R25 | 11 · `Screen` | `const shown = draft?.name ?? data.profiles.value?.active ?? null;` / `active={shown !== null && shown === data.profiles.value?.active}` | `.here` in both, and `label={hereWord(data.profiles.value ?? { repo: null })}` on `Header` |
| R26 | 11 · test | — | "inside a bound repo, Save & make active binds it": `fixtureEffects({ repo: "/r", bindings: { "/r": "default" } })`, `effects.create("cheap")`, open cheap, `j, space, ctrl+s, right, return` → writes end `bind cheap /r`; header line 0 contains `(this repo)` (15 tests). Frames and stories keep `repo` unset: no snapshot changes |
| R27 | 12 · `run.tsx` · `openTui` | `const effects: Effects = story ? fixtureEffects() : liveEffects();` | `: liveEffects(await gitToplevel(process.cwd()));` + `import { gitToplevel } from "../../infra/git.ts";` (resolved once at start, as the ruling says) |
| R28 | 12 · `pty.test.ts` · `start` (hygiene) | `tmux("new-session", "-d", "-s", name, "-x", "80", "-y", "24", …)` | add `"-c", home` so the binary runs outside the catherd checkout, whatever the bindings |
| R29 | 13 · README "The dashboard" | `- Edits are staged: nothing is written until ctrl+s …` | add: "Inside a repo bound to a profile, the dashboard opens on that profile, and making a profile active binds the repo to it (as `catherd profile use <name> --repo`)." |
| R30 | 2 (landed; optional fix round) · `commands.ts` `profile.activate` | `cli: "catherd profile use <name>",` | `cli: "catherd profile use <name> [--repo]",` |

Unchanged on purpose: `remove` (live `deleteProfile` already refuses the global active profile and bound
ones); `save`/`patchProfile(name, …)` (always a named profile); `doctor` (its `profile` row stays the global
one); the catalog reads (`patchProfile` validates against `loadCatalog({ timings: false })` without a repo,
so the preview must not pass one either).

## 4. What a reviewer would flag, and spec conflicts

| # | Task | Issue | Proposal |
|---|---|---|---|
| D1 | 6 | `memoRuns` keys on run-file mtimes, but `summarizeRun` also reads the profile's budget (`deps.profiles.forRepo(run.meta.repo).budget`). After a budget cap is saved, an idle run's `% budget` stays stale until one of its files changes. | Add the profiles folder and `projects.json` mtimes to `stampOf`'s list, or accept and note it |
| D2 | 6 | `save` writes the treat-likes (`saveTreatLike`) before `patchProfile`; when the patch is refused (`saved: false`, e.g. the file changed on disk into an invalid combination), `catalog.override.json` keeps the treat-likes. Ruling 6 needs this order: validation reads the override. | Accept and say so in the doc comment, or restore the previous override entries when `!r.saved` |
| D3 | 9 | `status.open` handles only doctor's `profile` row; main's doctor now also emits `profile:<name>` (repo-bound profiles) and `binding:<repo>` rows, where enter does nothing. | Handled by R17 |
| D4 | 10 | `profile-actions.ts` imports `../providers/app.tsx` twice (`{ type AppApi, useDialogHandler }` and `{ useApp }`) | One import line |
| D5 | 10 | Save & make active calls `sessionsNeeded` twice (save, then activate), so the lines kept after exit repeat agents | Dedupe in `AppApi.keep` (Task 7) or merge the two lists in the save handler |
| D6 | 11 | Test title "saves and makes active from the dialog's **third** button" presses `right` once: Save & make active is the **second** of three | Rename to "second button" |
| D7 | 12 | "refuses a terminal that is not interactive" calls `openTui({ rawArgs: [] })`, which reads the real `process.stdin/stdout.isTTY`. Run from an interactive terminal, `bun test` makes a real renderer, takes over the screen and hangs. This breaks the global constraint that tests never read the real terminal. | `TuiOptions.tty?: boolean` (default `process.stdin.isTTY && process.stdout.isTTY`); the test passes `tty: false` |
| D8 | 13 | README line 78 (outside the new section) still says "The TUI takes `--plain` (ASCII only)"; the new section says ASCII without colour | Reword it to "the dashboard takes `--plain` (ASCII, no colour)" |
| D9 | 12 | PTY kept-line assertion: main's `newSessionNeededFor` now includes pruned agents, so the line is `…: catherd-default-architect-…, catherd-default-verifier-…` | `toContain` of the prefix still holds; no change |
| S1 | 9 vs spec §9.2 | "Cancelling a live run in Runs uses the 'esc again' armed state"; Ruling 3 uses `ctrl+d` twice | Owner ruling (kept); cite it in the review |
| S2 | 9, 10, 11 vs spec §9.1 | "the active profile" on Status and Profiles; the repo ruling shows `here` | Owner ruling supersedes; §3 above |
| S3 | 6 vs spec §3.1 | "The entry layer … calls one service": `effects.save` calls the catalog service, then the ProfileService | Ruling 6 (research K6); name it in the review so it is not flagged as drift |
| S4 | 7–11 vs spec §9.4 | "widgets/ (about 18 components)": the plan has 11 widgets plus views | "About"; not a conflict |

Counts: 0 interface disagreements between tasks; 30 places for the repo ruling (R1–R30: 25 code, 5 tests,
across Tasks 6, 7, 8, 9, 10, 11, 12, 13 and optionally 2); 8 reviewer-level defects (D1–D8, one already
covered by R17) and 1 no-op note (D9); 2 spec deviations the owner ruled on (S1, S2), 1 ruled by the plan
(S3).
