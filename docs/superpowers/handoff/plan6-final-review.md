# Final whole-branch review: plan 6 (the TUI)

Range `d0f6fd8..b77f0de` (branch `claude/great-dijkstra-85qdx7`). Reviewed in passes: plan front matter, controller
rulings (progress.md, worker-notes.md, preflight §3–4), spec §9, §3.1, §7.3, §8, §10.3, §11.6, §12, then every file
under `src/entry/tui/`, the `cli.ts` / `runs-command.ts` / `init-command.ts` / `profile.ts` edits, and the TUI tests.

The gate is green on a clean worktree at `b77f0de`: `typecheck`, `lint` and `format:check` pass; `bun test` gives
949 pass, 10 skip, 0 fail, 66 snapshots (121 s). The behaviour findings below come from throwaway probe tests. I
wrote them in a separate worktree, ran them and then deleted them. Each one used the existing `harness()` and sent a
burst of keys with `s.type("…")` inside one `act()`. That is one stdin chunk, as a real terminal delivers it over
ssh or tmux, under key repeat, or from a fast typist.

## Strengths

- **The one command table holds up.** `COMMANDS` drives the keymap layers, the palette, help and footer.
  `duplicateKeys` checks every context in `CONTEXTS`, and `resolveKeybinds` refuses unknown, reserved and
  conflicting overrides with `E_CONFIG_KEYBIND` before anything draws. The palette shows each command's CLI twin
  (research C3).
- **Modes and guards are simple and correct for keys that arrive one at a time.** Each guarded scope splits its
  printable keys into their own layer that goes quiet while an editor has focus. `row.*` layers go quiet
  entirely, and `setModal` is synchronous inside `dispatch`. The every-bound-letter test passes for the tree
  filter, the palette and the prompt.
- **Focus 3 holds.** `patchBetween` (a leaf diff, lists whole, a removed key becomes `null`, checked against
  `ProfilePatchSchema`) goes to `patchProfile`, which re-reads the file under its lock. It is pinned in the domain
  and through the ProfileService. `show` keeps only a draft with staged changes (the wave-1 fix), so a clean
  draft never shadows a newer file.
- **Command handlers read the draft through `getState()`.** In `profiles.tsx` `current()` and in `app.tsx`
  `quit`/`interrupt`, a double toggle cancels out (the Focus 2 test).
- **The save dialog is careful.** `fitSections` holds the buttons and the failure line and trims filler first,
  with "… and N more" tails. A validation error leaves only Cancel, and a refused patch keeps the dialog open
  with the reasons.
- **The repo-binding ruling is applied the same way everywhere I checked:** `Effects.profiles()` has
  `{active, here, repo}`, `bound()` is evaluated at call time, `hereWord` is shared, and the header, the Status
  PROFILE row, the Profiles top line, the profile list (`current`/`this repo`/`active`), the activate confirm
  ("Use X in this repo?" / "Bind to this repo"), the save-dialog note, the success toast and the README (R29)
  all agree. An unbound repo acts globally and binds nothing, as ruled.
- **Layering is correct.** `cli.ts` imports `entry/tui/run.tsx` only for a bare `catherd`. A spawned test counts
  `@opentui` modules after `status --json`, and `cli.test.ts` statically checks that `mcp`, `lock` and
  `_supervise` never reach `@opentui` or `react`. `init-command.ts` imports only the pure `tui/theme.ts`. Every
  write goes through the ProfileService or `saveTreatLike` (S3, Ruling 6); nothing under `src/entry/tui` writes
  files itself.
- **No colour or Unicode (Focus 4).** `detectUi` reads only its arguments. `Behind` hides the tab under a
  colourless dialog, the selection uses INVERSE without colour, `Line` puts every part through `ascii()` in
  plain mode, and the frame test asserts plain frames are ASCII at three sizes.
- **Test hygiene is good.** Tests run on a `ManualClock` inside `act()` with a deterministic flush. The only
  wall-clock waits are the PTY test's polling with a deadline. The PTY child runs under `env -i` on a private
  tmux socket with `-c home`. `openTui` takes `tty`, so no test reads the real terminal. Every file that sets env
  has `afterEach(snapshotEnv())`.
- **The 0.x removal is complete.** `src/` is `adapters cli.ts domain entry infra services`. `catalog/catalog.json`
  is gone, and `THIRD_PARTY_NOTICES.md` lists every derived file and is in `package.json` `files`. The three
  OpenTUI packages are pinned exactly at 0.5.12.

## Issues

### Critical

None.

### Important

**I1. Keys that land in one tick act on what was drawn, not on what is now. Focus 2 is pinned only for two
toggles on the same row.** Several handlers read state from the render closure, not from a ref or `getState()`:

- `widgets/list.tsx:88-102`: `move` steps from the render-time `index`.
- `views/profiles.tsx:93,208-209`: `toggle(row)` and `primary(row)` use the render-time `row`.
- `widgets/dialog-select.tsx:70-73,90-91`: `chosen` comes from the render-time `text` and `index`.
- `widgets/dialog-prompt.tsx:276`: `app.answer(d.value)` uses the render-time value.

What the probes showed:

- `2` then `jj ` in one chunk: both moves were lost, and `space` turned off **architect** (the row that was drawn).
- `ctrl+p` then `quit⏎` in one chunk: **"New profile…" opened** (the first Suggested entry for an empty filter),
  not Quit.
- `ctrl+x n` then `cheap⏎`: the prompt shows "cheap", but it submits `""` and shows the name error. In the number
  editor the same race submits the *old* value: the dialog closes and nothing changes, without a word.

For a keyboard-first user this is the "no surprises" bar failing: the wrong row is edited, the wrong command runs,
or a value is quietly dropped.

*Fix:*

- `List`: keep `selectedRef`, set it synchronously in `move`, `first` and `last` before `onSelect`, and step from it.
- Views: resolve the row from the view's own ref (`ProfilesView`: `selectedRef.current`, not `row`). RunList and
  Status have the same pattern.
- `DialogSelect`: keep `textRef` and `indexRef`, update them in `onInput` and `move`, and compute `chosen` in
  `submit` from the refs.
- `DialogPrompt`: `app.answer((app.getState().dialogs.at(-1) as Prompt).value)`.
- Add probe-style tests: `type("jj ")` on the tree, `type("quit\r")` in the palette, `type("5\r")` in the number
  editor.

**I2. `/` focuses the filter in an effect, so letters typed right after it run commands and are lost (Focus 1).**
`list.tsx:83-85,120-123`: `list.filter` bumps `focusTick`, and `input.focus()` runs only after React commits. Until
then `currentFocusedEditor` is null and the guarded letter layers are live. Probes:

- Profiles, `/ab` in one chunk: `a` ran `profile.activate` (the toast "default is already active"; on another
  profile it opens the activate dialog), `b` was lost and the filter stayed empty.
- Status, `/you`: `y` ran `status.copy`.

The dialogs have the same gap (`dialog-select.tsx:67-69`, `dialog-prompt.tsx:273-275`). In modal mode no command
runs, but the letters are lost: `:q` opens an empty palette.

The Task 11 test opens the input in one press and types in another, so it never covers this.

*Fix:* focus in the same tick.

- `List`: always mount the filter `<input>` (zero height or hidden while not filtering), and call
  `input.current.focus()` inside the `list.filter` handler.
- Dialogs: focus from a ref callback, or make `setModal` also set a keymap data flag `catherd.typing` that the
  guarded layers require false until the input takes focus.
- Add `type("/ab")` and `type(":q")` tests.

**I3. Error toasts cut their fix command, and it is gone in 4 s (spec §9.3: "commands wrap").**
`widgets/toast.tsx:59-60` end-truncates to about 56 columns. `profile-actions.ts:8-12` builds
`` `${e.message}. ${e.fix}` `` for activate, delete and read failures, and the Runs cancel and catalog refresh
errors go through toasts too. The fix, the part the user must act on, is exactly what gets cut. Example: a
delete refused because the profile is bound to a long repo path. This is "lost silently" in the owner's terms.

*Fix:*

- Wrap toast text to up to 3 lines at the toast width (opencode wraps).
- Keep `error` toasts for longer (for example 8 s), or until the next key.
- Keep the fix on its own muted line.

**I4. An error thrown while rendering leaves the user stuck in the alternate screen with no way out.**
`run.tsx:66` renders under OpenTUI's built-in `ErrorBoundary`, which replaces the whole tree with a red stack. A
probe (a catalog read throwing when `ctrl+s` opens the save dialog) confirmed the tree is replaced. Everything
below it unmounts, including every `useBindings` layer. With `exitOnCtrlC: false`, `ctrl+c`, `q` and `esc` then
do nothing, `done` never resolves, and unsaved drafts are lost.

At least one throw path does file I/O while rendering: `SaveDialog`'s `useMemo(previewSave)`
(`save-dialog.tsx:364`) calls `effects.catalog` (`loadCatalog` plus `catalogQuery`) and `effects.agents`. A
corrupt `catalog.override.json`, or a catalog refresh that drops a rung the draft holds, is enough to reach it.

*Fix:*

- Wrap `<App>` in catherd's own boundary whose `componentDidCatch` calls `onExit(1, [...kept, "catherd: " +
  message])`, so the renderer is destroyed and the error prints after exit.
- In `previewSave`'s caller, catch and render the failure as the dialog's failure section.

### Minor

- **M1. `status.tsx:167`: Enter on a profile row fails silently when the profile cannot be read.** It dispatches
  `show` with an unguarded `readProfile`, so the error goes to the keymap's `console.error` and nothing shows. That
  is exactly when the doctor `profile` row is red. *Fix:* call `showProfile(app, name)`, which toasts.
- **M2. `app.tsx:137-141`: esc while a double press is armed disarms *and* backs out.** In a run it arms the
  cancel, then leaves the run; in the profile list it closes the dialog. "Back out one level" says the armed state
  is the level. *Fix:* `if (state.armed) return app.dispatch({ type: "disarm" });`.
- **M3. `data.tsx:294` with `runs.tsx:62-66`: a failed poll still moves `at`.** The Runs tab keeps the old rows
  under "updated just now" (task 9's "errors after first load hidden"). *Fix:* leave `at` alone on error, and show
  `error` as a warning line above the list.
- **M4. `data.tsx:366`: the profile list and `here`/`active` are read once and only after the TUI's own writes.**
  After a `catherd profile use` in another terminal, the header label, `openActivate`'s "already active" check and
  the profile list are stale. *Fix:* refresh `profiles` in `openProfileList`, `openActivate` and on tab switch, or
  poll it with the runs.
- **M5. `save-dialog.tsx:264-277`: the save preview compares against the draft's `base`, not the file now.** When
  the file changed on disk, the shown "before" values, agent-file changes and validation can differ from what the
  patch will do. The write itself is right, and `patchProfile` re-validates. *Fix:* in `previewSave`, read the
  current doc and preview `applyPatch(current, patchBetween(base, doc))`.
- **M6. The palette and help show 3–4 entries at 80×24, with ragged key/CLI columns (P1).**
  `dialog-select.tsx:74` caps the list at `floor(h/2)-6`, although `dialogRows(24)` leaves about 10. Detail sits
  right-aligned per row (`163-169`), and a long CLI twin ("catherd profile use <name> [--repo]") is end-cut.
  *Fix:* size from `dialogRows(dims.height) - 4`, pad titles to the longest title, and drop the CLI column when
  it does not fit instead of cutting it.
- **M7. Dialog footers show only "enter choose" (P2).** `commands.ts:338-341` give no `hint` to `dialog.up`,
  `dialog.down` or `app.back`. *Fix:* add hints (`↑↓ move`, `esc back`); the footer already generates them.
- **M8. Plurals written as `change(s)` and `agent(s)` (P3):** `app.tsx:133`, `profile-actions.ts:117,129`.
- **M9. `test/entry/cli.test.ts:104`: the OpenTUI layering check filters `f.startsWith("tui/")`, the 0.x path.**
  The package check still covers it. *Fix:* `entry/tui/`.
- **M10. `test/entry/tui/pty.test.ts:36`: every case leaves a `catherd-pty-*` home in tmp.** *Fix:* track the homes
  and `rmSync` them in `afterEach`.
- **M11. `frames.test.tsx:49`: the footer check takes the last *non-blank* line, not row `h`.** The snapshots do
  pin the position, but the invariant should: `expect(lines[c.h - 1]).toMatch(…)`.
- **M12. `profile-actions.ts:203-231`: the async save handler can run twice** if Enter is pressed again while
  `saveTreatLike` awaits. Its later `close` then hits whatever dialog is on top by then. *Fix:* a `saving` ref
  that ignores the second answer.

## Deferred minors: triage

| # | Item (source) | Decision | Why |
|---|---|---|---|
| 1 | `wrap` drops doubled or leading spaces (T1) | Stay deferred | Cosmetic; `wrap` only takes messages and commands with single spaces. |
| 2 | `resolveKeybinds` accepts `ctrl+x` (the leader) and has no key-syntax check (T2) | Stay deferred; plan 7 | Config-only. A typo'd key leaves that command unbound, which the user notices when the key does nothing. Add a parse check with `E_CONFIG_KEYBIND` later. |
| 3 | A printable key rebound onto a dialog or row command (T2) | Stay deferred; plan 7 | Only a hand-edited config reaches it. In modal mode such a key takes letters from the palette filter; refuse printable keys for `dialog`/`filter` commands in `resolveKeybinds`. |
| 4 | Filter layer gated on any focused editor; no leader-timeout or `useKeymapVersion` test; orphan JSDoc in `render.tsx`; dead `NAMED.tab`; single-modifier key parser (T3) | Stay deferred | The only base-mode editor is the list filter; the rest is test and cosmetic. |
| 5 | `failoverOptions` ignoring staged treat-likes (T5) | Resolved | `profiles.tsx:142` passes the `withStaged` catalog, and `usable()` reads it. |
| 6 | `memoRuns` never drops deleted runs; fixture `create` with an unknown `from` (T6) | Stay deferred | A small, bounded leak; fixture-only. |
| 7 | `List` move reads the render-time index (T7) | **Fix before merge** | It is I1: probes show lost moves and the wrong row toggled. |
| 8 | Leader chord's second key muted in the footer; keymap mode set only in `dispatch`; the same toast object queued twice; "3 s hold" test; `keep` dedupe collapses blank lines (T7) | Stay deferred | Cosmetic, or unreachable: the initial state has no dialogs, toasts are fresh objects, and kept lines have no blanks. |
| 9 | The ctrl+d "press again" label outlives the 5 s arm; `DialogHost` key kept across a same-purpose replace (T8) | Stay deferred | It fails safe (a late second press re-arms, it does not delete), and nothing dispatches `replace`. |
| 10 | On very short screens the save-failure tail can be cut (T8) | Stay deferred | Below 24 rows only; the failure section is held last. |
| 11 | Budget colour threshold test; `stateParts` pad edge; repo paths truncated, not wrapped; errors after the first load hidden; repeated React keys (T9) | Errors-after-first-load: **fix (M3)**. The rest: stay deferred | M3 shows stale data as fresh. The others are cosmetic or test gaps. |
| 12 | After a post-save read failure the draft still shows edits unsaved, and a success toast follows the error (T10) | Stay deferred | The save did happen; saving again is an idempotent patch. |
| 13 | The palette and help show 3 rows at 80×24; ragged key column (T11, P1) | **Fix before merge (M6)** | It is the owner's flagged polish, it cheapens the main discovery surface at the default size, and it is a small change. |
| 14 | Toast "change(s)" (T11, P3) | **Fix before merge (M8)** | Trivial. |
| 15 | Storybook not reset between stories; `frames.test.tsx` docs test order-dependent under `-t` (T11) | Stay deferred | Dev-only. |
| 16 | Footer invariant checks the last non-blank line (T11) | **Fix before merge (M11)** | One line; it is the test that pins Focus 5. |
| 17 | Coverage: `]`, `?`, a rebound key in the palette (T11) | Stay deferred | The palette key test covers one rebound key. |
| 18 | Terminal check runs twice (T12) | Stay deferred | Harmless. |
| 19 | `docs/dependencies.md` mentions `runChild`/`runOpencode`; `docs/ideas.md` and `docs/manual-tests.md` point at deleted paths (T13) | **Fix before merge** | This branch deleted those paths. `manual-tests.md:231` is a runnable command that now fails. Cheap. |
| 20 | `init`'s TTY welcome branch untested (T13) | Stay deferred | `welcomeLines` is tested; the branch is one `isTTY` line. |
| 21 | P2: dialog footer shows only "enter choose" | **Fix before merge (M7)** | Two `hint` fields; keyboard discoverability is the owner's bar. |
| 22 | P4: Status heavy-lock path truncated (spec: paths wrap) | Stay deferred | The fix command, which the user acts on, wraps; `catherd doctor` prints the detail in full. Wrap `detail` when Status next changes. |
| 23 | P5: tree model column misaligns for long names | Stay deferred | Cosmetic: pad to the longest label per role. |

## Declined to judge

- `ctrl+d` twice (not "esc again") cancels a live run: owner and plan Ruling 3.
- Status and Profiles label `here` ("this repo") where spec §9.1 says "the active profile": owner ruling (S2).
- In a bound repo the TUI cannot change the global active profile or clear the binding. The owner ruling says
  activation binds the repo; clearing is `catherd profile use --repo --clear`.
- `effects.save` calls the catalog service before the ProfileService: plan Ruling 6 and research K6 (S3).
- A refused patch leaves the staged treat-likes in `catalog.override.json`: D2 ruling.
- A draft edit to a list field (a role's `rungs`) overwrites the whole list, so another terminal's change to that
  same list is lost. Ruling 7 sends lists whole; Focus 3 covers other fields.
- `r` on Profiles refreshes the catalog over the network: plan Ruling 5.
- `ctrl+c` with a dialog open closes the dialog instead of quitting: opencode's layering, as the plan's handler
  comment states.
- `q` quits without confirmation when nothing is unsaved: spec §9.2.
- Up to 1 s of blank alternate screen while `waitForThemeMode` waits on terminals that do not answer: spec §9.3
  names `waitForThemeMode` with a dark fallback.
- Billing, `lock.heavy` and `preflight.confirm` are not in the tree: plan Ruling 14.
- 11 widgets, not "about 18": S4 ("about").
- `docs/superpowers/plans/2026-09-26-08-cursor-grok.md` on this branch: out of scope, per the brief.
- Codex live test: needs the owner's login (`CATHERD_LIVE=1`); typechecked only.
- The PTY test's one flake in five full-suite runs: the plan asks plan 7 to watch it on CI.

## Verdict

**With fixes.** No Critical issues. Before merge, fix the four Important issues:

- I1: handlers read render-time state.
- I2: `/` and dialog inputs take focus late.
- I3: error toasts cut their fix command.
- I4: a render error leaves an unexitable screen.

Also fold in these cheap Minors: M6, M7, M8, M11, the docs from row 19, and ideally M1–M3. I1 and I2 are one
theme: make every key handler read "now", not "as drawn". Add a burst-style test for each, which the existing
harness already supports with `s.type("…")`.
