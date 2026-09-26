// Adapted from anomalyco/opencode packages/tui/src/context/keymap.tsx (MIT, © 2025 opencode);
// see THIRD_PARTY_NOTICES.md.
import type { CliRenderer, KeyEvent, Renderable } from "@opentui/core";
import type { Keymap } from "@opentui/keymap";
import {
  registerBackspacePopsPendingSequence,
  registerCommaBindings,
  registerEscapeClearsPendingSequence,
  registerTimedLeader,
} from "@opentui/keymap/addons/opentui";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider, useBindings, useKeymap } from "@opentui/keymap/react";
import { useRenderer } from "@opentui/react";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import {
  type CommandDef,
  type CommandId,
  commandsIn,
  DEFAULT_KEYS,
  isGuarded,
  isPrintable,
  type Keybinds,
  LEADER,
  LEADER_TIMEOUT_MS,
  type Scope,
} from "../commands.ts";

export type AppKeymap = Keymap<Renderable, KeyEvent>;
export type Handlers = Partial<Record<CommandId, () => void>>;

/** The keymap data key that holds the mode: `base`, or `modal` while a dialog is open (spec §9.2). */
export const MODE = "catherd.mode";

/** opencode's keymap setup: comma lists, esc and backspace for pending sequences, the timed leader, modes. */
export function createAppKeymap(renderer: CliRenderer): AppKeymap {
  const k = createDefaultOpenTuiKeymap(renderer);
  registerCommaBindings(k);
  registerEscapeClearsPendingSequence(k);
  registerBackspacePopsPendingSequence(k);
  registerTimedLeader(k, { trigger: LEADER, name: "leader", timeoutMs: LEADER_TIMEOUT_MS });
  k.setData(MODE, "base");
  // a layer names its mode; "global" layers are live in every mode
  k.registerLayerFields({
    mode(value, ctx) {
      if (value !== "global") ctx.require(MODE, value);
    },
  });
  const attr = (name: string) => (value: unknown, ctx: { attr(n: string, v: unknown): void }) =>
    ctx.attr(name, value);
  k.registerCommandFields({
    palette: attr("palette"),
    suggested: attr("suggested"),
    hint: attr("hint"),
    short: attr("short"),
    scope: attr("scope"),
    cli: attr("cli"),
  });
  return k;
}

/** Puts the keymap in modal mode while a dialog is open; synchronous, so a key right after sees it. */
export const setModal = (k: AppKeymap, modal: boolean): void => k.setData(MODE, modal ? "modal" : "base");

const KeybindsContext = createContext<Keybinds>(DEFAULT_KEYS);
export const useKeybinds = (): Keybinds => useContext(KeybindsContext);

/** The keymap for the renderer, and the keys in force. */
export function AppKeymapProvider(props: { keybinds: Keybinds; keymap?: AppKeymap; children: ReactNode }) {
  const renderer = useRenderer();
  const keymap = useMemo(() => props.keymap ?? createAppKeymap(renderer), [props.keymap, renderer]);
  return (
    <KeymapProvider keymap={keymap}>
      <KeybindsContext.Provider value={props.keybinds}>{props.children}</KeybindsContext.Provider>
    </KeymapProvider>
  );
}

const modeOf = (scope: Scope): "global" | "modal" | "base" =>
  scope === "global" ? "global" : scope === "dialog" ? "modal" : "base";

/**
 * Registers the commands of `scope` that have a handler, bound to their keys, while the calling component
 * is mounted. Printable keys of guarded scopes, and every key of a `row.*` scope, go quiet while a text
 * input has focus, so the input gets them as text; a `filter` layer is live only then.
 */
export function useCommandLayer(scope: Scope, handlers: Handlers, o: { enabled?: () => boolean } = {}): void {
  const renderer = useRenderer();
  const keys = useKeybinds();
  const ref = useRef(handlers);
  ref.current = handlers;
  const enabledRef = useRef(o.enabled);
  enabledRef.current = o.enabled;
  const ids = commandsIn(scope)
    .filter((c) => handlers[c.id as CommandId])
    .map((c) => c.id as CommandId);
  const idsKey = ids.join(" ");
  const mode = modeOf(scope);
  const typing = () => renderer.currentFocusedEditor !== null;
  const allowed = () => enabledRef.current?.() ?? true;
  const layerEnabled =
    scope === "filter"
      ? () => typing() && allowed()
      : scope.startsWith("row.")
        ? () => !typing() && allowed()
        : allowed;
  const command = (c: CommandDef) => ({
    name: c.id,
    title: c.title,
    group: c.group,
    scope: c.scope,
    ...(c.palette ? { palette: true } : {}),
    ...(c.suggested ? { suggested: true } : {}),
    ...(c.hint !== undefined ? { hint: c.hint } : {}),
    ...(c.short ? { short: c.short } : {}),
    ...(c.cli ? { cli: c.cli } : {}),
    run: () => {
      ref.current[c.id as CommandId]?.();
    },
  });
  const defs = commandsIn(scope).filter((c) => ids.includes(c.id as CommandId));
  const guarded = isGuarded(scope);
  const bindingsFor = (printable: boolean) =>
    defs.flatMap((c) =>
      keys[c.id as CommandId]
        .filter((k) => (guarded ? isPrintable(k) === printable : !printable))
        .map((k) => ({ key: k, cmd: c.id })),
    );
  useBindings(
    () => ({ mode, enabled: layerEnabled, commands: defs.map(command), bindings: bindingsFor(false) }),
    [scope, idsKey, keys],
  );
  // printable keys of a guarded scope: their own layer, quiet while a text input has focus
  useBindings(
    () => ({ mode, enabled: () => !typing() && allowed(), bindings: guarded ? bindingsFor(true) : [] }),
    [scope, idsKey, keys],
  );
}

export interface CommandEntry {
  id: CommandId;
  title: string;
  group: string;
  palette: boolean;
  suggested: boolean;
  hint: number | null;
  short: string | null;
  cli: string | null;
}

/** The commands a key could run right now, or that `dispatch` could; what the palette and help list. */
export function reachableCommands(k: AppKeymap): CommandEntry[] {
  return k.getCommandEntries({ visibility: "reachable" }).map(({ command: c }) => ({
    id: c.name as CommandId,
    title: String(c.title ?? c.name),
    group: String(c.group ?? ""),
    palette: c.palette === true,
    suggested: c.suggested === true,
    hint: typeof c.hint === "number" ? c.hint : null,
    short: typeof c.short === "string" ? c.short : null,
    cli: typeof c.cli === "string" ? c.cli : null,
  }));
}

/** Re-renders the caller whenever the keymap's live bindings change (a layer, a mode, focus). */
export function useKeymapVersion(): number {
  const k = useKeymap();
  const [v, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => k.on("state", () => bump()), [k]);
  return v;
}

export { useKeymap };
