# opencode's TUI as the reference for catherd's redesign

Research date: 2026-09-25. Companion to `research/tui.md` (the audit, sections C1-C6) and
`research/opencode.md` (the opencode integration research).

**Sources.** I read the opencode source directly, from shallow clones in
`scratchpad/opencode-src/{dev,v2}`:

| Clone | Branch | Commit | Version | npm package |
|---|---|---|---|---|
| `opencode-src/dev` | `dev` (default) | `adee738` (2026-09-25) | 1.18.32 | `opencode-ai` (v1 line) |
| `opencode-src/v2` | `v2` | `6585bb7` (2026-09-25) | 2.0.16 | `@opencode/cli` (v2 line) |

`github.com/sst/opencode` now redirects to `github.com/anomalyco/opencode`. Both URLs serve the same `dev`
HEAD. There is also a stale `2.0` branch, and `v2` is the live one. Unless a path is marked **(dev)**,
it points into the **v2** tree, `https://github.com/anomalyco/opencode/tree/v2/packages/tui/src/...`.
I also read the published npm tarballs of `@opentui/keymap`, `@opentui/solid` and `@opentui/react` 0.5.12
(`scratchpad/pkgs/`), and the docs sources `packages/web/src/content/docs/{tui,keybinds,themes,commands}.mdx`.
Those sources are the same pages as https://opencode.ai/docs/tui, /docs/keybinds, /docs/themes and /docs/commands. I checked /docs/keybinds live.
`https://opencode.ai/v2/docs/keybinds/` returns 404. The v2 docs still describe the v1-style
underscored keybind names, which v2 accepts through `src/config/v1/keybind.ts`.

**Verified.** I built a prototype in `scratchpad/keymap-proto/keymap.test.tsx` (passes with `bun test`). It shows that opencode's
keymap engine, `@opentui/keymap`, works with **@opentui/react 0.5.12**, the exact version catherd uses. The test covers
focus-scoped bare-letter bindings, global chords, a `ctrl+x` leader, inputs that own their printable keys, and a footer
that lists the active keys. Details are in §3.6.

---

## 1. Framework and binding

### 1.1 What opencode uses

opencode uses **@opentui/solid** on both lines, plus `@opentui/core` and the standalone keymap engine **`@opentui/keymap`**.

| | v1 (`dev`) | v2 (`v2`) |
|---|---|---|
| `@opentui/core` / `@opentui/solid` / `@opentui/keymap` | 0.4.5 | **0.5.12** (the same version as catherd's core/react) |
| `solid-js` | catalog | catalog (`@opentui/solid@0.5.12` peer: `solid-js@1.9.12`) |
| Other TUI deps | `fuzzysort`, `opentui-spinner`, `remeda`, `diff`, `effect`, `clipboardy` | `fuzzysort`, `opentui-spinner`, `remeda`, `effect`, `@solid-primitives/event-bus`, `string-width`, `uqr` |

Sources: `package.json` catalog (v2 lines 55-57, dev lines 43-45) and `packages/tui/package.json` (both branches).
`packages/tui/tsconfig.json` sets `"jsx": "preserve", "jsxImportSource": "@opentui/solid"`, and
`packages/tui/bunfig.toml` sets `preload = ["@opentui/solid/preload"]` for both run and test. The CLI
build (`packages/cli/script/build.ts:7,30,127`) compiles the TSX with `createSolidTransformPlugin()` from
`@opentui/solid/bun-plugin` and ships a compiled binary. The TUI is not run from source.

**Stated rationale.** I found none in the repo: nothing in AGENTS.md, CONTEXT.md, specs/ or the tui AGENTS.md.
OpenTUI and opencode come from the same team (anomalyco, formerly sst). They rewrote the old Go/Bubble Tea TUI on
OpenTUI with Solid. The usual argument, echoed by third-party write-ups such as the DeepWiki page
"SolidJS Integration | sst/opentui" and the Better Stack OpenTUI guide, is that Solid compiles JSX into direct
renderable mutations. There is no virtual DOM or fiber diff, so fine-grained signals update only the cells that
change, which matters for token streaming. I infer this; opencode does not say it.

### 1.2 Should catherd switch from @opentui/react to @opentui/solid?

**Recommendation: no. Stay on @opentui/react 0.5.12 and adopt `@opentui/keymap` (which has a React
binding) together with opencode's *patterns*. Port opencode's components by translation, not by copying files verbatim.**

| Criterion | @opentui/solid (opencode) | @opentui/react (catherd today) | Weight for catherd |
|---|---|---|---|
| Reactivity | Fine-grained signals and stores. Effects re-run per dependency, with no re-render of the tree. | Re-render plus reconcile. Needs memo discipline for large lists. | Low. catherd shows dozens of rows, not a streaming transcript. |
| Performance | Best for streaming chat (opencode's workload) | Fine for catherd's scale | Low |
| Build and run | **Needs a Babel transform** (`babel-preset-solid`, `@babel/core` are deps of `@opentui/solid`). It comes from a bunfig preload or `Bun.plugin`, or opencode's pre-build. | Bun's native JSX (`"jsx": "react-jsx"`). Works from source. | **High.** catherd ships raw TS (`"bin": {"catherd": "src/cli.ts"}`, `"files": ["src", …]`). Bun reads `bunfig.toml` from the working directory, so a preload in catherd's own bunfig would not apply to a global install. catherd would need a build step, or a runtime `Bun.plugin()` registration before any TSX import (as in opencode's `src/plugin/runtime-plugin-support.bun.ts`). |
| Keymap engine | `@opentui/keymap/solid` | `@opentui/keymap/react` (`KeymapProvider`, `useKeymap`, `useBindings` with `targetRef`/`targetMode`, `useActiveKeys`, `usePendingSequence`, `reactiveMatcherFromStore`). **Verified working.** | Same capability |
| Testing | `testRender(() => <App/>)` from `@opentui/solid` | `testRender(<App/>, opts)` from `@opentui/react/test-utils`. Both return the same `TestRendererSetup` (`mockInput`, `mockMouse`, `captureCharFrame`, `renderOnce`). | Equal |
| Code reuse from opencode | Copy almost verbatim (MIT) | Translate: `createMemo`→`useMemo`, `createStore`→`useState`/reducer, `<Show>/<For>`→JSX conditionals, `createSimpleContext`→context and hook | Medium. The components worth copying are small (dialog 258 LOC, toast 214, confirm 93, palette 66). `DialogSelect` (901) is the only big one. |
| Maturity and ecosystem | opencode is the flagship user. Slots, plugin runtime and `opentui-spinner/solid` exist. | Also first-party, with a React reconciler, error boundary, devtools and test utils | Equal for catherd's needs |
| Existing code | Rewrite 2,369 LOC plus 6 TUI test files | None | High |

Revisit Solid only if catherd starts rendering streaming agent output (live run transcripts) and React
re-renders become measurable, or if the owner decides to vendor large opencode subtrees verbatim. Either
way catherd would need a compile step (`createSolidTransformPlugin`) or a runtime plugin.

---

## 2. Architecture of opencode's TUI

### 2.1 Package layout (v2 `packages/tui/src`)

```
app.tsx            run(): renderer creation, provider tree, <App> (routes + overlays), app-level commands
index.tsx          export { run }
context/           one file per concern: route, keymap, theme, client, data, local, storage, panel,
                   permission, prompt, exit, args, clipboard, interactivity, session-tabs, …
  helper.tsx       createSimpleContext({name, init}) → {provider, use}
config/            index.tsx (tui.json schema via effect Schema), keybind.ts (command-id → default+description)
routes/            home.tsx, session/ (index, composer/, permission, sidebar, dialogs …)
ui/                generic primitives: dialog.tsx, dialog-select.tsx, dialog-confirm.tsx, dialog-prompt.tsx,
                   dialog-alert.tsx, dialog-help.tsx, toast.tsx, border.ts, layout.ts, spinner.ts, link.tsx
component/         app-specific pieces: command-palette, dialog-model, dialog-session-list, dialog-config,
                   dialog-status, dialog-mcp, dialog-integration, spinner, startup-loading, reconnecting, …
feature-plugins/   built-in UI written as plugins filling slots (home footer, sidebar, diff viewer, stats, storybook)
theme/             v1 JSON themes (33 in assets/), v2 opencode theme (assets/v2/opencode.json), system-theme generator
plugin/            TUI plugin runtime and <Slot path="…"> rendering
mini/              the non-fullscreen "mini" runner (scrollback mode)
util/              locale (truncate), format, selection, scroll, delayed-presence, …
```

catherd should take three ideas from this layout.

- `ui/` holds framework-free generic widgets.
- `component/` holds dialogs specific to the app.
- `context/` has one provider per concern, and every one is built with the same 26-line helper:

```tsx
// context/helper.tsx
export function createSimpleContext<T, Props>(input: { name: string; init: (p: Props) => T }) {
  const ctx = createContext<T>()
  return {
    provider: (props) => { const init = input.init(props)
      return <Show when={init.ready === undefined || init.ready === true}>
               <ctx.Provider value={init}>{props.children}</ctx.Provider></Show> },
    use() { const v = useContext(ctx); if (!v) throw new Error(`${input.name} context must be used within a context provider`); return v },
  }
}
```

### 2.2 App root (`app.tsx`)

`run()` creates the renderer with these options (`app.tsx:233-245`):

```ts
{ externalOutputMode: "passthrough", targetFps: 60, exitOnCtrlC: false, useKittyKeyboard: {},
  autoFocus: false, openConsoleOnError: false, useMouse: config.mouse }
```

It then waits for the terminal's colour mode, `await renderer.waitForThemeMode(1000) ?? "dark"`, and renders a
provider tree of about 30 levels: Log → Exit → Epilogue → ErrorBoundary → Storage → … → Config → **Keymap.Provider →
ToastProvider → RouteProvider** → Client → Data → … → **ThemeProvider** → Local → **DialogProvider** → … → `<App/>`
(`app.tsx:290-440`). The order matters. Keymap sits under Config because it reads the keybinds. Toast
sits under Keymap and above Dialog because dialogs use toasts.

`<App/>` is the whole screen (`app.tsx:1328-1405`):

```tsx
<box width={dimensions().width} height={dimensions().height} flexDirection="column" backgroundColor={theme.background.base}>
  <box flexGrow={1} minHeight={0} flexDirection="row">
    <Show when={verticalTabsVisible()}><SessionTabs orientation="vertical" … /></Show>
    <box flexGrow={1} minWidth={0} flexDirection="column">
      <Switch>
        <Match when={route.data.type === "home"}><Home /></Match>
        <Match when={route.data.type === "session"}>… <SessionFrame sessionID={id} /> …</Match>
        <Match when={route.data.type === "plugin"}><PluginRoute … /></Match>
      </Switch>
    </box>
  </box>
  <StartupLoading ready={plugins.ready} />   <Reconnecting … />   <MigrationOverlay />   <Toast />
</box>
```

The **DialogProvider** renders the dialog layer itself at `zIndex=3000` (see §2.5). Overlays are
absolutely positioned siblings, never part of the flow.

### 2.3 Routing

Routing is a single store holding a discriminated union (`context/route.tsx`):

```ts
export type Route = HomeRoute | SessionRoute | PluginRoute   // {type:"home"} | {type:"session", sessionID} | {type:"plugin", id, name, data?}
navigate(route: Route) { setStore(reconcile(route)) }
```

There is no history stack. Back behaviour comes from dialogs (Esc) and explicit commands. An initial
route can be injected with `OPENCODE_ROUTE='{"type":…}'`, or `OPENCODE_STORY=<story>` for the storybook route
(`app.tsx:340-358`). This is useful for tests and screenshots.

### 2.4 State and backend

- **Server state.** `context/client.tsx` wraps the typed HTTP client (`@opencode/client`) and one SSE event
  stream (`createClientConnection` with a reconnect callback). Events fan out through a typed global emitter
  (`@solid-primitives/event-bus`). `context/data.tsx` builds a normalized, event-synced cache
  (`createData({api, event, connection, directory})`). Components read `data.session.get(id)`,
  `data.location.model.list(ref)` and so on, and never fetch in render.
- **Local UI state.** `context/local.tsx` holds the current model, agent, favourites and recents. `context/storage.tsx`
  keeps persistent key-value data under the state directory (for example `useStorage().store("layout", {initial})`). `config/index.tsx` holds
  `tui.json`, with `config.update(draft => …)` writing the file and a watcher on it.
- **Events to UI.** `event.on("tui.toast.show", …)`, `event.on("tui.command.execute", e => keymap.dispatch(e.data.command))`
  (`app.tsx:1263-1285`). The server can open toasts and run TUI commands.
- **Connection UX.** When the connection drops, a full-screen "Reconnecting" overlay appears only after a grace
  period: 1 s on retry, 5 s on first connect (`app.tsx:1301-1325`).

What this means for catherd: its "backend" is the local file system (profiles, runstore) plus probes. Mirror the
split. A small **data context** loads and watches files off the render path (the audit's C5 "polled off
the render path"). A **config context** exposes `update(draft => …)`. Views only read.

### 2.5 Dialog and overlay system (`ui/dialog.tsx`)

- The store is `{ stack: {element, onClose?, key?}[], size: "medium"|"large"|"xlarge", centered }`.
- The API is `replace(render, onClose?, {size,key})`, `clear()`, `setSize()`, `stack`. In practice there is one
  dialog at a time: `replace` closes the previous one and runs its `onClose`. Flows chain dialogs with `replace`,
  for example Integration → method → key prompt → Model picker (`component/dialog-model.tsx`, `dialog-integration.tsx`).
- While the stack is non-empty, the provider pushes keymap mode **`"modal"`**. That disables every base-mode layer
  and leaves `mode:"global"` layers active (§3.3). A modal layer binds `escape` and `ctrl+c`, which close the top
  dialog or clear a selection. `ctrl+c` first clears a non-empty focused input.
- Focus: on open, the dialog stores `renderer.currentFocusedRenderable` and blurs it. On close, `refocus()`
  restores focus if that renderable is still mounted.
- Layout: a full-screen backdrop `RGBA(0,0,0,150)` with `zIndex 3000`. Clicking the backdrop closes the dialog. The panel
  is `width = 60 | 88 | 116`, `maxWidth = termWidth - 2`, placed at `paddingTop = height/4` (not centred unless
  asked), on `background.raised`. There is **no border**, only `paddingTop=1`.

```tsx
<box position="absolute" zIndex={3000} width={dims.width} height={dims.height} alignItems="center"
     paddingTop={props.centered ? 0 : dims.height / 4} backgroundColor={RGBA.fromInts(0, 0, 0, 150)} onMouseUp={close}>
  <box width={dialogWidth(size)} maxWidth={dims.width - 2} backgroundColor={theme.background.base /* dialog surface */} paddingTop={1}>
    {children}
  </box>
</box>
```

Every dialog uses the same header: the title bold on the left and a muted, clickable `esc` on the right
(`ui/dialog-confirm.tsx`, `ui/dialog-help.tsx`, `component/dialog-status.tsx`).

The dialog primitives are:

| File | Purpose |
|---|---|
| `ui/dialog-select.tsx` (901 LOC) | The workhorse. A filter input (always focused), fuzzy search (`fuzzysort`, title weight 2, category and `searchText` weight 1), grouped categories, a `current` marker `●`, the selected row filled with the interactive colour, per-row `description`, `footer`, `details[]` and `gutter` (a spinner, for example), `emptyView` and `noMatchView`, **footer actions** bound to command ids and shown as `title key`, and `bindings` for extra keys |
| `ui/dialog-confirm.tsx` | Title, message and [Cancel] [Confirm] buttons, with ←/→ to move and Enter to choose. The **dev** branch adds `DialogConfirm.show(dialog, title, msg): Promise<boolean \| undefined>` (dev `ui/dialog-confirm.tsx:93`) |
| `ui/dialog-prompt.tsx` | A text entry with `busy`, `onConfirm(text)` and `onCancel`, and a focus-targeted keymap layer (`target: textareaTarget, priority: 1`) |
| `ui/dialog-alert.tsx`, `ui/dialog-help.tsx` | A message with OK. The help dialog only says "Press ctrl+p to see all available actions and commands in any context." |

### 2.6 Toasts (`ui/toast.tsx`)

- `toast.show({title?, message, variant: info|success|warning|error, duration=5000, action?: {label, run}})`
  and `toast.error(err)`.
- One toast is visible at a time. The rest wait in a **queue**, shown as "+N more". **Hovering pauses** the timer.
  Clicking runs the action. The affordance is `› Label`, or `x` when there is no action.
- Placement: `position absolute, top 1, right 2, maxWidth min(60, width-6)`, on `background.raised.high`,
  with `padding 1/2` and a **left and right heavy bar `┃`** in the variant colour (`SplitBorder` in `ui/border.ts`).
- The MCP example raises a toast with an action that opens the relevant dialog:
  `{ title: "MCP server needs authentication", action: { label: "Open MCP servers", run: () => keymap.dispatch("mcp.list") } }`
  (`app.tsx:523-550`).

### 2.7 The command registry is the keymap, and the palette reads it

opencode has **no separate command registry**. A command is a keymap command with metadata
(`KeymapCommand` from `@opencode/plugin/tui/context`):

```ts
{ id: "session.list", title: "Switch session", group: "Session", palette: true,
  suggested: () => boolean, enabled: () => boolean, slash: { name: "sessions", aliases: ["resume","continue"] },
  bind: false /* key comes from config */, run: (input?, event?) => void }
```

`app.tsx:674-1238` declares about 60 app commands in one `createMemo([...])` and registers them with
`Keymap.createLayer(() => ({ mode: "global", commands: appCommands() }))`. Separate layers then attach
**bindings by id** from config: `Keymap.createLayer(() => ({ bindings: appBindingCommands }))`, where
`config.keybinds.get(id)` provides the keys. The benefits are:

- **One id per action.** The keyboard, the palette, `/slash` commands, server events (`tui.command.execute`) and
  mouse clicks (`onMouseUp={() => keymap.dispatch("mcp.list")}`) all run the same `dispatch(id)`.
- **The palette** (`component/command-palette.tsx`, 66 LOC) is a `DialogSelect` over
  `Keymap.useCommands()`, filtered to `palette: true` and **reachable** commands. It adds a "Suggested" group when the
  filter is empty. Each row shows the command's current shortcut (`shortcuts.all(id)`) and `group · keys` while filtering.
  It also indexes every **setting** ("Settings · Appearance") so settings can be found from the palette.
- **Footer hints** come from the same source. `Keymap.useShortcut("command.palette.show")()` returns the
  formatted key, so a hint always shows the user's rebinding.

### 2.8 Components and plugins

The home footer, sidebar sections, diff viewer, which-key panel and stats are written as **feature plugins**
(`feature-plugins/**`) that fill named `<Slot path="home.footer">` regions
(`Plugin.define({ id, setup(ctx){ ctx.ui.slot({append:"home.footer", render}) } })`). catherd does not need a
plugin system, but the idea of a *slot for each footer or status region* keeps screens simple.

---

## 3. Keybinding system

### 3.1 Engine: `@opentui/keymap` (MIT, same OpenTUI repo)

The package README (`pkgs/opentui-keymap-0.5.12/package/README.md`) describes a host-agnostic engine. Its main features are:

- Layers ordered by **priority** and **scoped by focus**. Global layers apply everywhere. Local `focus` and `focus-within` layers
  follow the focused renderable's parent chain.
- **Multi-key sequences** with a pending-sequence API. Addons include a leader (`registerTimedLeader`), comma lists
  (`"ctrl+c,ctrl+d"`), Esc to clear a pending sequence, Backspace to pop one, Emacs chords, `g`/`gg` disambiguation,
  and `mod+` aliases.
- A **command catalogue** with `dispatchCommand(id)`, visibility tiers (`registered`, `reachable`, `active`), search and
  namespaces. `getActiveKeys()` feeds footers and cheat sheets. `extras` provides
  `formatKeySequence` and `formatCommandBindings`.
- **Diagnostics**: `extras/graph` snapshots layers, bindings, **shadowing** and "inactive reasons".
  `registerDeadBindingWarnings` and `registerUnresolvedCommandWarnings` give lint-style warnings.
- Adapters for `opentui`, `html`, **`react`** and `solid`. `testing` provides a fake host.

### 3.2 Setup in opencode (`context/keymap.tsx`, 469 LOC)

```ts
const keymap = createDefaultOpenTuiKeymap(renderer)       // default parser + enabled/metadata fields
registerCommaBindings(keymap)                              // "ctrl+c,ctrl+d,<leader>q"
keymap.appendBindingExpander(/* enter→return, esc→escape, pgdown→pagedown, pgup→pageup */)
registerBaseLayoutFallback(keymap)                         // match by physical key on non-US layouts
registerEscapeClearsPendingSequence(keymap)
registerBackspacePopsPendingSequence(keymap)
registerManagedTextareaLayer(keymap, renderer, { enabled: () => focused editor is a Textarea,
                                                 bindings: input.* commands from config })
registerTimedLeader(keymap, { trigger: config leader ("ctrl+x"), name: "leader", timeoutMs: 2000 })
```

The shortcut display format maps `leader` to the configured key, uses arrows for `up/down/left/right`, `pgup/pgdn/del`,
and `meta`→`alt` (`formatOptions`, `keymap.tsx:445-468`).

### 3.3 Contexts: modes, focus scope, interactivity, priority

opencode resolves "which bindings are live" with four orthogonal mechanisms:

1. **Mode stack** (`createMode`, `keymap.tsx:392-434`). A layer declares `mode: "global"` (always live),
   omits `mode` (live only in mode `"base"`), or names a mode (`"modal"`). `keymap.mode.push("modal")` returns
   a pop function. The dialog provider pushes `"modal"` while a dialog is open, so screen bindings go
   dead but global ones still work. It is built on generic keymap features: `keymap.setData(key, value)` plus
   `registerLayerFields({ mode(value, ctx){ ctx.require(MODE.key, value) } })`.
2. **Focus scope.** A layer with `target` and `targetMode: "focus" | "focus-within"` is live only when that
   renderable, or a child of it, has focus (`ui/dialog-prompt.tsx:38`, `target: textareaTarget`).
3. **Interactivity.** `<InteractivityProvider enabled={…}>` (`context/interactivity.tsx`) turns off every layer
   in a subtree, used for background panes and hidden tabs. `test/keymap-scope.test.tsx` covers it.
4. **Priority.** The default is 0. The prompt, dialog prompts and the worktree dialog use `priority: 1`, the terminal
   pane 100, and the selection-copy intercept 101 (`app.tsx:556`). An intercept, `keymap.intercept("key", fn, {priority})`,
   runs before every binding.

### 3.4 How inputs own keys

opencode mostly **avoids the conflict by design**.

- It has **no bare printable global bindings**. Everything global is a chord (`ctrl+p`, `ctrl+o`, `f2`,
  `shift+tab`) or a leader sequence (`<leader>n`). In the home and session routes the prompt textarea is always
  focused, so letters always type.
- Bare letters appear only in views **without a text input**: the diff viewer (`j/k`, `gg`, `G`, `[`/`]`, `n/p`,
  `b`, `s`, `d`, `v`, `m`, `?`, `q`) and composer tabs (`k/j`).
- In a `DialogSelect` the filter input is always focused. Navigation uses `up/down` and
  **`ctrl+p/ctrl+n`**, never `j/k`. Typing filters.
- Text editing keys (`input.*`: `ctrl+a/e/k/u/w`, `alt+b/f`, …) form a managed layer that is live only when a
  `Textarea` has focus (`registerManagedTextareaLayer`), and users can rebind them.
- Context-sensitive chords: `app.exit` (`ctrl+c`) is live only when the prompt is empty
  (`enabled: () => promptRef.current.text === ""`, `app.tsx:1255-1261`). Otherwise `prompt.clear` (`ctrl+c`) clears it.
  The layering is: dialog open → close or clear its input. Prompt has text → clear it. Empty → exit.

I verified (§3.6) that **a global bare-letter binding does steal keys from a focused `<input>`**. The fix is either
focus scope or `enabled: () => !renderer.currentFocusedEditor`.

### 3.5 Default keymap (v2 `config/keybind.ts`, around 240 ids; the docs list the v1 names)

The leader is `ctrl+x` (`LeaderDefault`) with a 2000 ms timeout (`leader.timeout` in v2, `leader_timeout` in v1).

| Group | Command id (v2) | v1 docs name | Default |
|---|---|---|---|
| App | `app.exit` | `app_exit` | `ctrl+c,ctrl+d,<leader>q` |
| | `command.palette.show` | `command_list` | **`ctrl+p`** |
| | `help.show`, `docs.open`, `opencode.settings` | … | `none` (palette only) |
| | `opencode.status` | `status_view` | `<leader>s` |
| | `theme.switch` | `theme_list` | `none` (v2) / `<leader>t` (v1 docs) |
| | `terminal.suspend` | | `ctrl+z` |
| Session | `session.new` / `session.list` | | `<leader>n` / `<leader>l` |
| | `open.menu` | | `ctrl+o` |
| | `session.rename` / `session.delete` (in the session list) | | `ctrl+r` / `ctrl+d` |
| | `session.interrupt` | | `escape` (press twice) |
| | `session.compact`, `session.export`, `session.timeline` | | `<leader>c`, `<leader>x`, `<leader>g` |
| | `session.undo` / `session.redo` | `messages_undo/redo` | `<leader>u` / `<leader>r` |
| | `session.sidebar.toggle` | `sidebar_toggle` | `<leader>b` |
| | `session.tab.select.N` | | `<leader>N,ctrl+N` |
| | `session.page.up/down`, `session.first/last` | | `pageup`/`pagedown`, `ctrl+g,home` / `ctrl+alt+g,end` |
| Model/agent | `model.list`, `agent.list` | | `<leader>m`, `<leader>a` |
| | `agent.cycle`, `variant.cycle`, `model.cycle_recent` | | `shift+tab` (v2; `tab` in v1 docs), `ctrl+t`, `f2` |
| | `model.dialog.provider` / `model.dialog.favorite` (inside the model dialog) | | `ctrl+a` / `ctrl+f` |
| Prompt | `prompt.editor` | `editor_open` | `<leader>e` |
| | `prompt.clear` / `input.submit` / `input.newline` | | `ctrl+c` / `return` / `shift+return,ctrl+return,alt+return,ctrl+j` |
| | `input.*` readline set | | `ctrl+a/e/k/u/w`, `alt+b/f/d`, `ctrl+-` undo, `ctrl+.` redo, … |
| Dialog | `dialog.select.prev/next` | | `up,ctrl+p` / `down,ctrl+n` |
| | `dialog.select.page_up/down/home/end/submit` | | `pageup`/`pagedown`/`home`/`end`/`return` |
| | `dialog.mcp.toggle` | | `space` |
| Diff viewer | `diff.down/up`, `diff.first/last`, `diff.close`, `diff.help` | | `j,down`/`k,up`, `gg,home`/`shift+g,end`, `escape,q`, `?` |
| Which-key | `which-key.toggle` | | `ctrl+alt+k` (dev: a docked or overlay panel of the active keys) |

Other conventions: `ctrl+d` means *delete this item* in every list dialog (session, stash, queued prompt,
integration, worktree). `ctrl+r` means rename or refresh. `ctrl+f` means favourite or pin. `space` toggles.

### 3.6 Configuration

The config lives in `tui.json`/`tui.jsonc` (`$schema: https://opencode.ai/tui.json`), separate from `opencode.json`, and
`OPENCODE_TUI_CONFIG` can override the path. `keybinds` merges over the defaults. A value can be:

- a string (`"ctrl+x"`) or a comma list (`"ctrl+c,ctrl+d,<leader>q"`),
- an array of those,
- an object `{key, event: "press"|"release", preventDefault, fallthrough}`,
- `"none"` or `false` to disable the binding.

Unknown ids throw `Unrecognized keybind: …` (`config/keybind.ts:parse`). Every id carries a `description`, which becomes the
JSON-schema description and the binding's `desc`. Source: `config/keybind.ts` and `docs/keybinds.mdx`
("Binding Values", "Disable Keybind").

**Prototype result** (`scratchpad/keymap-proto/keymap.test.tsx`, React 19.3 plus `@opentui/react` 0.5.12 plus `@opentui/keymap` 0.5.12, passing):

| Case | Result |
|---|---|
| List box with `useBindings({targetRef, targetMode:"focus-within", bindings:[j,down,space]})` focused, keys `j`, `space` | fire `list.down`, `list.toggle` |
| Global `ctrl+p`, and leader `ctrl+x` then `n` (`registerTimedLeader`) | fire (also while the input is focused) |
| Global bare `q` **without** a guard, with the input focused | **steals `q`** (the input received `jk n`) |
| Global bare `q` with `enabled: () => !renderer.currentFocusedEditor` | the input receives `jk nq`, and `q` still fires when the list has focus |
| `useActiveKeys({includeMetadata:true})` in the footer | lists `q:quit ctrl+p:commands … j:move down space:toggle` when the list has focus, and only `ctrl+p` and the leader when the input has focus |

### 3.7 How keys are shown

- **Footer.** Minimal. The prompt footer shows two hints, `tab agents  ctrl+p commands`: the key in `text.base`
  and the label in `text.muted` (`feature-plugins/prompt/footer.tsx:96-104`). Hints drop by width.
- **Dialog footer.** Actions render as **bold title plus muted key**, for example `delete ctrl+d`, `favorite ctrl+f`
  (`ui/dialog-select.tsx` `FooterAction`). Tab and Shift-Tab move focus between footer actions. Below 60 columns the footer
  stacks vertically.
- **Palette.** Every command row shows its current shortcut. This is where users *learn* keys.
- **Armed state.** While a leader is pending, the prompt dims (`muted = leader() || props.muted`,
  `component/prompt/index.tsx:194-195`). A pending destructive action changes the label in place:
  `esc interrupt` becomes `esc again to interrupt` (in warning colour, reset after 5 s).
  The session list row becomes `Press ctrl+d again to confirm`.
- **Which-key** (dev `feature-plugins/system/which-key.tsx`, 608 LOC). A panel docked at the bottom, or overlaid, built from
  `getActiveKeys`, with group tabs. It can open automatically while a sequence is pending.

---

## 4. Visual design system

### 4.1 Theme model

**v1 schema** (dev `theme/assets/*.json`, 33 built-in themes, still accepted in v2 through `migrateV1`):
`{ $schema, defs: {name: "#hex"}, theme: { token: "#hex" | "defRef" | ansiNumber | {dark, light} | "none" } }`.
The tokens are `primary secondary accent error warning success info text textMuted selectedListItemText background
backgroundPanel backgroundElement backgroundMenu border borderActive borderSubtle`, 13 `diff*` tokens, 14
`markdown*` tokens, 9 `syntax*` tokens and `thinkingOpacity` (`packages/theme/src/tui/v1.ts`). opencode dark uses
`primary #fab283` (orange), `secondary #5c9cf5`, `accent #9d7cd8`, `text #eeeeee`, `textMuted #808080`, `background #0a0a0a`,
`backgroundPanel #141414`, `backgroundElement #1e1e1e`, `border #484848`, `borderActive #606060`, `borderSubtle #3c3c3c`.

**v2 schema** (`theme/assets/v2/opencode.json`, `packages/theme/src/tui/{schema,types}.ts`) is a *hue-scale* design token
system.

- `light.hue` and `dark.hue` define 9-step scales (100-900) for gray, red, orange, green, cyan, blue and purple, plus
  aliases: **`accent`** (dark: purple, light: orange), **`interactive`** (dark: orange, light: blue),
  `neutral` = gray.
- `base` holds semantic tokens that reference `$hue.x.step`:
  - `text.{base, muted}`
  - `text.action.{primary,secondary,destructive}.{base,$hovered,$focused,$selected,$disabled}`
  - `text.formfield.*`
  - `text.feedback.{error,warning,success,info}`
  - `background.{base, raised.{base,high,max}}`, `background.action.*`, `background.formfield`, `background.feedback.*`
  - `border.base`, `scrollbar.base`, `diff.*`, `syntax.*`, `markdown.*`, `categorical[]`
- **Surfaces**: `"@dialog": { background: { base: "$background.raised.base", … } }`. A dialog re-resolves the whole
  theme on the raised surface (`useTheme().surface("dialog")`, `ThemeContextProvider context="dialog"`).

Key dark values (v2 opencode): text `#eeeeee`, muted `#808080`, bg `#0a0a0a`, raised `#141414`/`#1e1e1e`/`#4c4c4c`,
selection fill `interactive.200 = #fab283` with text `neutral.800 = #0a0a0a`, category headings `accent.200 = #9d7cd8`,
error `#e06c75`, warning `#f5a742`, success `#7fd88f`, info `#56b6c2`, border `#484848`.
Light values: text `#1a1a1a`, muted `#8a8a8a`, interactive `#3b7dd8`, accent `#d68c27`, border `#b8b8b8`.

### 4.2 Dark/light and terminal background detection

- At startup: `renderer.waitForThemeMode(1000)`, falling back to `"dark"` (`app.tsx:290`). `renderer.themeMode` updates
  live.
- The `system` theme calls `renderer.getPalette({size:16})` to read the terminal's 16 ANSI colours and its default
  fg/bg (OSC queries). `terminalMode(colors)` computes luma `0.299r+0.587g+0.114b > 0.5` to pick light.
  `generateSystem(colors, mode)` builds a gray ramp from the terminal bg, maps red/green/yellow/blue/magenta/cyan
  to ANSI 1-6, and sets the background to *transparent* (`theme/system.ts`).
- Config: `theme: {name, mode: "system"|"dark"|"light"}` (v2). The palette offers "Switch to light mode" and
  "Lock theme mode".
- The TUI **ignores `NO_COLOR`** (only `cli/src/commands/handlers/stats.ts` checks it). catherd's plain and
  NO_COLOR handling already goes further. Keep it.
- catherd's `@opentui/core` 0.5.12 already exposes `renderer.themeMode`, `waitForThemeMode()` and `getPalette()`
  (`node_modules/@opentui/core/renderer.d.ts:460-461,641`).

### 4.3 Typography, borders, spacing

- **Attributes** (v2 tui/src counts): `BOLD` 75 uses plus 15 `<b>`, `DIM` 5, `ITALIC` 1, `INVERSE` 2, `UNDERLINE` 0.
  Hierarchy comes from **colour** (`text.base` against `text.muted`) and **bold**, almost never from dim.
  Bold marks titles, the selected row, toast titles, footer action names and names in status rows.
- **Borders are nearly absent.** Dialogs have none: a raised background and a dark backdrop do that job. Toasts and the
  prompt use a **single heavy vertical bar `┃`** on the left (and right), in the semantic colour
  (`SplitBorder`, `ui/border.ts`). Only the crash screen uses `borderStyle="rounded"`. Separation comes from
  `gap={1}` and padding.
- **Padding scale.** Dialog content `paddingLeft/Right = 2` (confirm, help, status) or `4` (select header and rows),
  `paddingTop 1`, `paddingBottom 1`. Row gutter `paddingLeft 3`. Footers `paddingLeft 2..4`.
- **Truncation.** `Locale.truncate`, `truncateLeft` and `truncateMiddle` (paths and details are middle-truncated, capped at 76).
  Titles are capped at about 61 columns inside a medium dialog.

### 4.4 Status, spinners, lists, selection

- **Status dots.** `•` coloured by state (success, warning, error) followed by **bold name** and a muted detail
  (`component/dialog-status.tsx:36-50`). The MCP dialog uses words plus glyphs: `Connected ✓` (bold), `Failed !`,
  `Sign in required →`, `Disabled ○`, `Connecting …`. The footer uses `⊙ 2 MCP` (green) and `⊙ 1 MCP failed` (red).
- **Spinner.** Braille frames `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` at 80 ms (`component/spinner-frames.ts`) through `opentui-spinner`, in
  `text.muted`. With `animations: false` it falls back to a static `⋯` (`component/spinner.tsx`). An optional shimmer
  sweeps a highlight across the label.
- **Delayed presence** for loaders. `StartupLoading` appears only after **500 ms** and then stays at least
  **3 s**, so it never flickers (`component/startup-loading.tsx`). Reconnecting waits 1 s or 5 s (§2.4).
- **List selection** (`DialogSelect`). The selected row is **filled** with `background.action.primary.focused` (the
  interactive colour) and its text is `text.action.primary.focused` (the background colour) plus **bold**. There is no
  cursor glyph. `●` marks the *current* value, and a coloured `gutter` can show a spinner for running items.
  Category headers are bold in `accent.200`, with a blank line between groups. Descriptions and footers are muted,
  and footers are right-aligned. Hovering with the mouse moves the selection.
- **Settings rows** (`component/dialog-config.tsx`). The title is on the left and the current value right-aligned as `footer`.
  `←/→` cycle the value, Enter moves to the next value, and the footer hint reads `←/→ change`.
- **Tabs** (`component/session-tabs.tsx`). The active tab is bold with a tinted background, inactive tabs use faded text,
  and there are pulse or animation effects for unread and running tabs (over-engineered for catherd).

### 4.5 Narrow terminals and scrollbars

- Width breakpoints are written as pure functions and tested. `homeFooterVisibility(width)` returns
  `{mcpCommand: w>=64, pluginCommand: w>=80, version: w>=64}`, and the footer hides entirely below 44x12
  (`feature-plugins/home/footer.tsx:7-13,83`).
- The session sidebar appears automatically only when `width > 120` (dev `routes/session/index.tsx:270-278`). Diffs use split
  view above 120 columns and unified below. Vertical tabs need `tabs + 64` columns (`ui/layout.ts`). Dialogs clamp to
  `width-2`. `DialogSelect` height is `min(rows, height/2 - 6)`. The dialog footer stacks below 60 columns.
- **Scrollbars are hidden by default**: `scrollbarOptions={{visible:false}}` in `DialogSelect`, diff viewer, pair
  dialog and btw. The session scrollbar is an off-by-default setting ("Scrollbar", `session.scrollbar`).
  Selection-follow (`scrollAfterLayout`) keeps the cursor in view.

---

## 5. UX patterns worth copying

1. **The command palette as the primary discovery surface** (`ctrl+p`). It includes every palette-flagged command
   with its live shortcut, a "Suggested" section that depends on context, and settings. Help simply points to it.
2. **The session list** (`component/dialog-session-list.tsx`). Rows are grouped by day ("Today", then dates) with a muted
   right-side footer (directory) and a spinner gutter for running sessions. Footer actions are `pin/unpin ctrl+f`,
   `delete ctrl+d` and `rename ctrl+r`, plus hints such as `all projects ctrl+a`. **Inline delete confirmation:** the first `ctrl+d`
   changes the row title to "Press ctrl+d again to confirm". Moving the cursor cancels it (`onMove={() => setToDelete(undefined)}`).
   `emptyView` and `noMatchView` show a single muted line.
3. **The model picker** (`component/dialog-model.tsx`). When the filter is empty it shows *Favorites*, *Recent*, then per-provider
   groups. Typing flattens the list and fuzzy-matches with favourites first. A right footer shows "Free". `ctrl+f`
   toggles favourite and `ctrl+a` opens "Connect an integration". Choosing a model with variants opens
   the variant picker with `dialog.replace`.
4. **The provider connect flow** (`component/dialog-integration.tsx`). Pick an integration, skip the method step when only one
   method exists, then an API-key `DialogPrompt` (masked input, `component/masked-text.ts`) or an OAuth URL. On success
   the flow `replace`s into `DialogModel providerID=…` scoped to the new provider. Accounts can be renamed (`ctrl+r`) and
   deleted (`ctrl+d`).
5. **Confirmations.** Use a real `DialogConfirm` (Cancel and Confirm, ←/→, Enter) for rare, weighty actions. Use a
   **double-press arm** for frequent destructive keys (`ctrl+d` twice, `esc` twice to interrupt, with a 5 s reset and the label
   changing to warning colour).
6. **Empty states.** One muted line in the list area ("No items available", "No results found", "No MCP servers").
   The home screen shows the logo, the prompt and rotating tips.
7. **Toasts** for results that do not need a decision ("Copied to clipboard", "Session … was deleted",
   errors). A toast can carry a *follow-up action* that dispatches a command id.
8. **Loading states.** Delayed presence (500 ms to show, 3 s minimum) plus a spinner label ("Loading plugins…",
   "Finishing startup…"). A per-row spinner gutter marks running items.
9. **Status and footer.** The home footer is a single row: status items on the left (`⊙ 2 MCP /mcps`), a spacer,
   and the version muted on the right, with items that hide by width. The session prompt footer shows agent, model and
   variant, context usage and cost joined by `·`, plus two key hints. The terminal title is set
   (`OC | <session title>`).
10. **Settings as a declarative registry** (`dialog-config.tsx`): `{title, category, path, default, values?, labels?,
    step/min/max?, format?, keywords?}` rendered by one generic list with ←/→ cycling. Adding a setting is a
    data change.
11. **Mouse parity.** Every visible key hint is also clickable (`onMouseUp={() => keymap.dispatch(id)}`).

---

## 6. How opencode tests its TUI

- **Runner**: `bun test --timeout 30000 --only-failures` (`packages/tui/package.json`) with the Solid preload from
  bunfig. There are 46 test files in dev and 163 in v2.
- **Component and integration tests** use `testRender(() => <Tree/>)` from `@opentui/solid` (57+ uses) and
  `createTestRenderer` from `@opentui/core/testing`, with **`ManualClock`** for time-dependent UI. They interact through
  `app.mockInput.pressKey/pressEnter/typeText` and `app.mockMouse.click/drag`, and assert on
  `app.captureCharFrame()` (`toContain`, or specific rows sliced).
- **Snapshots are rare**: one file, `test/cli/tui/__snapshots__/inline-tool-wrap-snapshot.test.tsx.snap` (wrapping at a
  narrow width). Most assertions target specific text.
- **Keymap semantics are unit-tested**. `test/keymap.test.tsx` and `test/keymap-scope.test.tsx` check that disabled
  scopes isolate named, inline and global layers, that `mode.push("modal")` works, and that `dispatch` respects
  reachability.
- **Pure helpers are tested separately**: `test/ui/layout.test.ts` (breakpoints), `select-controller.test.ts`,
  `pane-resize.test.ts`, `test/theme/v2/*` (resolve, surfaces, v1 migration), `test/component/dialog-session-list.test.ts`.
- **Fixtures**: `test/fixture/tui-client.ts` (a fake API client), `tui-environment.tsx`, `tui-runtime.ts`, `local.tsx`.
- **Drive/simulation**: `OPENCODE_DRIVE` swaps the renderer for `@opencode/simulation/frontend` `Drive.create(...)`,
  a loopback WebSocket control server with a viewport and a recorded timeline. It drives the real TUI end to end
  (`app.tsx:252-255`, `packages/simulation/src/manifest.ts`).
- **Storybook in the terminal**: `OPENCODE_STORY=1` opens a built-in story index as a plugin route
  (`feature-plugins/system/storybook/*`, with fixtures such as `one-cell-spinner.fixtures.ts`). It is used for visual review.

---

## 7. Recommendation for catherd

### 7.1 Decisions

1. **Framework.** Keep `@opentui/react`. **Add `@opentui/keymap@0.5.12`**, pinned to the same version as core.
   Its React peers are optional, so it adds no new runtime dependency beyond `@opentui/core`.
2. **Replace the audit's hand-written `router.ts`** (C2 and C5) with the keymap engine, and **keep the rest of C5**: the pure
   `keymap` defaults file, the pure reducer for drafts and undo, and effects. The audit's context stack
   `global → tab → pane → overlay → input` maps directly:

   | Audit context | Keymap mechanism |
   |---|---|
   | `global` | layer with `mode: "global"` (chords, leader, palette, `?`) |
   | `tab:<name>` | layer in mode `base`, `enabled: () => tab === name`, or rendered only while the tab is mounted |
   | `pane:<name>` | `useBindings({ targetRef: paneRef, targetMode: "focus-within" })` |
   | `overlay:<name>` | mode stack: the dialog provider pushes `"modal"`, and the dialog's own layer is `mode: "modal"` |
   | `input` | focused `<input>` receives printable keys. **Every bare-letter layer that is not focus-scoped gets `enabled: () => !renderer.currentFocusedEditor`** |

   The audit's test "no duplicate key within a reachable context stack" becomes a test over
   `@opentui/keymap/extras/graph` (shadowing diagnostics) plus `registerDeadBindingWarnings`.
3. **Command registry = keymap commands**, as in opencode. Each action has an id (`profile.save`, `tab.status`, …)
   with `title`, `group`, `palette`, `enabled`, `run`. Keys come from a defaults table
   (`src/tui/keymap/defaults.ts`, mirroring `config/keybind.ts` `Definitions` with `{default, description}`).
   The palette, footer, `?` overlay, mouse clicks and tests all use `dispatch(id)` and `useActiveKeys()`.
4. **Visual language.** Keep the audit's C4 (80x24 budget, no outer box, state glyph plus word, plain and NO_COLOR modes),
   and **align the details with opencode**:
   - Dialogs are borderless panels on `bg.raised` over a dim backdrop, placed at `height/4`, 60 columns wide (Save diff: 88,
     clamped to `width-2`). The header is a bold title with a muted `esc` on the right.
   - Selection is a **filled row in the accent colour with bold text** in lists and dialogs, as in opencode. In the main
     tree, the audit's subtle tinted row is also fine, but the same widget should be used everywhere.
   - Toasts and inline callouts use the `┃` split bar in the semantic colour.
   - Hierarchy comes from `text.base`, `text.muted` and bold. Avoid dim, as opencode does.
   - Hide scrollbars and use the audit's `↑ 3 more` / `↓ 11 more` hints.
   - The plain-mode fallback (`--plain`/`TERM=linux`) replaces `┃` with `|` and `•` with `*`, and uses reverse video
     for selection under NO_COLOR.

### 7.2 Revised keymap (reconciling audit C3 with opencode)

This is a hybrid. **Bare letters stay** where they help (catherd is mostly browse and toggle with few text inputs, like
opencode's diff viewer), but they are **scoped or guarded**. **opencode's global chords are added** so opencode users
already know them: `ctrl+p` palette, `ctrl+x` leader, `ctrl+c` layering, `ctrl+d` delete-in-list, and
`<leader>u`/`<leader>r` undo and redo.

| Scope | Keys | Command id | Notes / opencode precedent |
|---|---|---|---|
| global | **`ctrl+p`**, `:` (guarded) | `command.palette.show` | opencode `command_list` = `ctrl+p` |
| global | `?` (guarded), `<leader>?` | `help.show` → which-key overlay from `useActiveKeys`, grouped | opencode which-key (`ctrl+alt+k`) plus help |
| global | `ctrl+x` | `leader` (2000 ms) | opencode default. The input dims while it is pending |
| global | `1` `2` `3` (guarded), `<leader>1..3` | `tab.status/profiles/runs` | opencode `session.tab.select.N` = `<leader>N,ctrl+N` |
| global | `[` `]` (guarded) | `tab.prev/next` | |
| global | `q` (guarded), `<leader>q` | `app.quit` (confirm if dirty) | opencode `app_exit` includes `<leader>q` |
| global | `ctrl+c` | layered: close dialog, clear focused input, quit (clean) or arm "again to discard" (dirty) | opencode `ctrl+c` layering plus the armed double-press |
| global | `esc` | back one level (never quits) | opencode dialog `escape` |
| global | `ctrl+l` | redraw | |
| global | `ctrl+z` | suspend | opencode `terminal.suspend` |
| pane: list/tree (focus-within) | `↑/k` `↓/j`, `pgup/ctrl+b` `pgdn/ctrl+f`, `ctrl+u/d` half page, `home/g` `end/G` | `list.*` | opencode diff viewer uses the same vim set (`j,down`, `gg,home`, `shift+g,end`, `ctrl+d/u`) |
| pane: tree | `→/l` `←/h` expand and collapse, `enter` primary, `space` toggle `[x]` | `tree.*` | opencode `dialog.mcp.toggle` = `space` |
| pane | `/` | `list.filter` (focuses a filter input, `esc` clears) | opencode dialogs: the filter is always focused |
| profiles | `ctrl+s` | `profile.save` → Save diff dialog | (no opencode equivalent) |
| profiles | `u`, `<leader>u` / `ctrl+r`, `<leader>r` | `profile.undo` / `profile.redo` | opencode `session.undo/redo` = `<leader>u/<leader>r` |
| profiles | `a` | `profile.activate` (confirm) | |
| profiles | `p` / `P` | `profile.next/prev` | |
| profiles | `n`, `<leader>n` | `profile.new` (DialogPrompt) | opencode `session.new` = `<leader>n` |
| profiles | `c` | `profile.copy` (DialogPrompt) | |
| profiles | `D`, and **`ctrl+d` in the profile picker dialog** | `profile.delete` → DialogConfirm (default Cancel) | opencode `ctrl+d` = delete in lists. Keep a real confirm, because files change |
| profiles | `e` | `profile.edit_value` | |
| profiles | `R` | `profile.revert` (confirm) | |
| profiles | `<leader>l` | `profile.list` (DialogSelect of profiles) | opencode `session.list` = `<leader>l` |
| status | `enter`, `y`, `r` | open, copy fix, re-check | |
| runs | `enter`/`esc`, `r`, `p`, `f` | open, refresh, pause, follow | |
| dialog (mode modal) | `↑/ctrl+p` `↓/ctrl+n`, `pgup/pgdn`, `home/end`, `enter`, `esc`; typing filters | `dialog.select.*` | opencode exactly. **No `j/k` in dialogs**, because the filter owns the letters |
| dialog | `tab`/`shift+tab` between footer actions or buttons, `←/→` in confirm and in settings rows | | opencode `DialogSelect`, `DialogConfirm`, `DialogConfig` |
| dialog | `y`/`n` only where the dialog shows them | | audit C3 |
| input | printable and readline chords (`ctrl+a/e/k/u/w`, `alt+b/f`) | managed by `<input>` | opencode `input.*` |

"Guarded" means `enabled: () => !renderer.currentFocusedEditor`, verified in §3.6.
**Configurable keybinds are optional (phase 2).** Accept `keybinds` in catherd's config with opencode's value grammar
(string or comma list or array, `<leader>`, `"none"`/`false`, unknown ids rejected), keyed by the dotted command ids above.

### 7.3 Theme tokens (a v2-style subset, 16 tokens)

| Token | Dark | Light | Use |
|---|---|---|---|
| `text.base` | `#eeeeee` | `#1a1a1a` | content |
| `text.muted` | `#808080` | `#8a8a8a` | secondary text, key labels, empty states, `esc` |
| `text.onAccent` | `#0a0a0a` | `#ffffff` | text on the selected fill |
| `accent` (interactive) | **ginger `#E8833A`** (opencode dark interactive is `#fab283`) | `#B45309` (5.0:1 on white; `#C4651F` is only 4.0:1) | selected-row fill, focus, active tab, cursor, the leader-pending cue |
| `bg.base` | `none` (the terminal's own) | `none` | screen (opencode's `system` theme style) |
| `bg.raised` | `#141414` | `#fafafa` | dialogs, palette |
| `bg.raisedHigh` | `#1e1e1e` | `#f5f5f5` | toasts, hover |
| `bg.overlay` | `rgba(0,0,0,150)` | `rgba(0,0,0,80)` | dialog backdrop |
| `border` | `#484848` | `#b8b8b8` | the rare rule (`─` under tabs and above the footer) |
| `feedback.success` | `#7fd88f` | `#3d9a57` | `✓ ready`, `done`, landed |
| `feedback.warning` | `#f5a742` | `#b0851f` | `! warning`, armed double-press, dirty `modified (n)` |
| `feedback.error` | `#e06c75` | `#d1383d` | `✗ missing`, `failed` (never the accent) |
| `feedback.info` | `#56b6c2` | `#318795` | `● live`, info toasts |
| `diff.addedText` / `diff.addedBg` | `#4fd6be` / `#20303b` | `#1e725c` / `#d5e5d5` | Save diff dialog |
| `diff.removedText` / `diff.removedBg` | `#c53b53` / `#37222c` | `#c53b53` / `#f7d8db` | Save diff dialog |

The brand pink (`#FF6FA5`) and the gradient are limited to the `init` welcome, empty-state mascots and `--version`,
as the audit's C4 says. Pick the mode with `renderer.themeMode ?? await renderer.waitForThemeMode(1000) ?? "dark"`, plus
`--theme dark|light` and the existing `--plain`/NO_COLOR path (tokens become `undefined`, selection uses `INVERSE`). Keep
the themes in one TS object (`src/tui/theme.ts`). Loading JSON themes (opencode's `defs` plus `{dark, light}` format) is optional.

### 7.4 Component list (React) and what to mirror

| catherd file | Mirror (opencode v2 path) | Notes |
|---|---|---|
| `src/tui/keymap/provider.tsx` | `context/keymap.tsx` | `createDefaultOpenTuiKeymap` plus comma, alias expander, escape and backspace pending, timed leader, mode stack (`setData` + `registerLayerFields`), `dispatch(id)` |
| `src/tui/keymap/defaults.ts` | `config/keybind.ts` | `Definitions: Record<id, {default, description}>`, `parse(overrides)` |
| `src/tui/keymap/use-command.ts` | `Keymap.createLayer`, `useShortcut(s)`, `useCommands`, `useLeaderActive` | `useBindings` from `@opentui/keymap/react` |
| `src/tui/ui/dialog.tsx` | `ui/dialog.tsx` | stack with `replace/clear` (**add `push`** for Save → Confirm nesting), sizes 60/88/116, backdrop, refocus, pushes modal mode, esc and ctrl+c |
| `src/tui/ui/dialog-select.tsx` | `ui/dialog-select.tsx` | fuzzy (`fuzzysort`), categories, `current ●`, filled selection, footer actions `title key`, empty and no-match views, details, gutter. Start with about 300 LOC and skip section navigation and mouse extras |
| `src/tui/ui/dialog-confirm.tsx` | `ui/dialog-confirm.tsx` plus the dev `DialogConfirm.show` promise | destructive dialogs start on Cancel (audit) |
| `src/tui/ui/dialog-prompt.tsx` | `ui/dialog-prompt.tsx`, `component/masked-text.ts` | profile name, budget numbers, the Jev key (masked, with `ctrl+t` to reveal as the audit says) |
| `src/tui/ui/toast.tsx` | `ui/toast.tsx` | queue, variants, action, `┃` bars; "Saved profile default", "Copied fix command" |
| `src/tui/ui/spinner.tsx` | `component/spinner.tsx`, `spinner-frames.ts` | braille at 80 ms. With `--reduced-motion`, show `⋯` |
| `src/tui/util/delayed-presence.ts` | `component/startup-loading.tsx`, `util/delayed-presence.ts` | 500 ms show delay, 3 s minimum hold (re-check, probes) |
| `src/tui/components/command-palette.tsx` | `component/command-palette.tsx` | reachable palette commands, a Suggested group, shortcut footer, the CLI equivalent in `description` (audit C3) |
| `src/tui/components/which-key.tsx` (`?`) | dev `feature-plugins/system/which-key.tsx` | an overlay grouped by `group`, from `useActiveKeys` |
| `src/tui/components/footer.tsx` | `feature-plugins/prompt/footer.tsx`, `home/footer.tsx` | `key` base plus `label` muted. Width-breakpoint function (pure and tested). Top 5-6 active keys plus `ctrl+p commands` and `? help` |
| `src/tui/components/profile-fields.tsx` | `component/dialog-config.tsx` | declarative field registry (`path, values, labels, step/min/max, format, keywords`) for ROUTING, BUDGET, FAILOVER and NOTIFY rows; ←/→ cycle. **Writes go to the staged draft**, not to disk |
| `src/tui/components/status-list.tsx` | `component/dialog-status.tsx`, `dialog-mcp.tsx` | `•` or glyph coloured by state, **bold name**, muted detail, fix line |
| `src/tui/components/profile-picker.tsx` | `component/dialog-session-list.tsx` | grouped list with `ctrl+d delete`, `ctrl+r rename`, `ctrl+a …` footer actions |
| `src/tui/context/theme.tsx` | `context/theme.tsx`, `theme/system.ts` | mode detection, a `surface("dialog")`-like raised variant |
| `src/tui/context/data.tsx` | `context/data.tsx`, `client.tsx` | file watchers and polling off the render path, typed events |
| `src/tui/app.tsx` | `app.tsx` | renderer options (`exitOnCtrlC:false`, `useKittyKeyboard:{}`, `autoFocus:false`), providers, the route union `{type:"status"|"profiles"|"runs"|"run", id?}`, `CATHERD_ROUTE` env for tests and screenshots |

### 7.5 Testing (adjusting audit C6)

- Keep C6. Use `@opentui/react/test-utils` `testRender`, plus `createTestRenderer` with **`ManualClock`** from
  `@opentui/core/testing` for spinners, toasts, the leader timeout and double-press windows. That replaces `tick(30)`.
- Port opencode's `keymap-scope.test.tsx` cases to React: modal isolation, disabled scopes, `dispatch` reachability,
  and the "input owns printable keys" matrix. `scratchpad/keymap-proto/keymap.test.tsx` is a working seed.
- Assert breakpoints as pure functions, as `homeFooterVisibility` and `ui/layout.ts` do. Keep golden frames (C6.3) to a
  few screens; opencode uses targeted `toContain` and row-slice assertions far more than snapshots.
- An optional `CATHERD_STORY=<name>` route that renders one widget with fixtures, similar to opencode's in-TUI storybook,
  would help visual review and README screenshots.

### 7.6 License and attribution

- opencode is **MIT**: `LICENSE` ("Copyright (c) 2025 opencode"), and `packages/tui/package.json` and
  `packages/theme/package.json` both say `"license": "MIT"`. `@opentui/*` are MIT as well
  (`pkgs/opentui-keymap-0.5.12/package/LICENSE`). catherd is MIT.
- catherd **may copy and adapt code** (for example `dialog.tsx`, `toast.tsx`, `dialog-select.tsx`, the keybind table, the
  theme JSON) if it **keeps the copyright and permission notice**. Either put a header comment in each derived file
  (`// Adapted from anomalyco/opencode packages/tui/src/ui/toast.tsx (MIT, © 2025 opencode)`) or add a
  `THIRD_PARTY_NOTICES.md`/`LICENSES/opencode.txt` containing the full MIT text. Built-in themes based on third-party palettes
  (catppuccin, dracula, nord, …) carry those projects' own licences, mostly MIT; check each before copying.
  The brand names "opencode" and "OpenCode" should not appear in catherd's UI.
