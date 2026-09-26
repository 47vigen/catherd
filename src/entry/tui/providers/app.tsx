import type { Clock } from "@opentui/core";
import { useKeymap } from "@opentui/keymap/react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { Effects } from "../effects.ts";
import { type Action, type AppState, type Purpose, reduce } from "../state.ts";
import { setModal } from "./keymap.tsx";
import { type Toast, useToasts } from "./toast.tsx";

export type BackKind = "input" | "view";

export type DialogHandler = (purpose: Purpose, value: string) => void | Promise<void>;

export interface AppApi {
  /** the state this render drew */
  state: AppState;
  /** the state now, after every dispatch so far: what a command handler must read */
  getState(): AppState;
  /** runs the reducer now, so the keymap's mode follows the dialog stack before the next key */
  dispatch(a: Action): void;
  effects: Effects;
  clock: Clock;
  toast(t: Toast): void;
  /** lines printed to stdout once the TUI has exited: what the user must keep (spec §9.4); a line held already is dropped */
  keep(lines: string[]): void;
  exit(code: number): void;
  /** copies to the clipboard (OSC 52); false when the terminal cannot */
  copy(text: string): boolean;
  /** answers the top dialog: runs the handler registered for its purpose */
  answer(value: string): void;
  onDialog(type: Purpose["type"], fn: DialogHandler): () => void;
  /**
   * esc runs the newest back handler (clear a filter, leave a run); ctrl+c runs only the newest one that
   * clears a text input.
   */
  onBack(fn: () => void, kind: BackKind): () => void;
  back(kind?: BackKind): boolean;
}

const AppContext = createContext<AppApi | null>(null);

export function useApp(): AppApi {
  const app = useContext(AppContext);
  if (!app) throw new Error("useApp must be used inside AppProvider");
  return app;
}

export function AppProvider(props: {
  effects: Effects;
  clock: Clock;
  initial: AppState;
  copy: (text: string) => boolean;
  onExit: (code: number, kept: string[]) => void;
  children: ReactNode;
}) {
  const keymap = useKeymap();
  const toasts = useToasts();
  const [state, setState] = useState(props.initial);
  const stateRef = useRef(props.initial);
  const kept = useRef<string[]>([]);
  const handlers = useRef(new Map<string, DialogHandler[]>());
  const backs = useRef<{ fn: () => void; kind: BackKind }[]>([]);
  const propsRef = useRef(props);
  propsRef.current = props;
  const api = useMemo<Omit<AppApi, "state">>(
    () => ({
      getState: () => stateRef.current,
      dispatch(a) {
        const next = reduce(stateRef.current, a);
        if (next === stateRef.current) return;
        stateRef.current = next;
        setModal(keymap, next.dialogs.length > 0);
        setState(next);
      },
      effects: props.effects,
      clock: props.clock,
      toast: (t) => toasts.show(t),
      keep(lines) {
        // a line already kept (an agent linked by both Save and Make active) prints once
        for (const l of lines) if (!kept.current.includes(l)) kept.current.push(l);
      },
      exit: (code) => propsRef.current.onExit(code, kept.current),
      copy: (text) => propsRef.current.copy(text),
      answer(value) {
        const top = stateRef.current.dialogs.at(-1);
        if (!top) return;
        const fn = handlers.current.get(top.purpose.type)?.at(-1);
        if (fn) void fn(top.purpose, value);
      },
      onDialog(type, fn) {
        const list = handlers.current.get(type) ?? [];
        handlers.current.set(type, [...list, fn]);
        return () =>
          handlers.current.set(
            type,
            (handlers.current.get(type) ?? []).filter((f) => f !== fn),
          );
      },
      onBack(fn, kind) {
        const entry = { fn, kind };
        backs.current.push(entry);
        return () => {
          backs.current = backs.current.filter((b) => b !== entry);
        };
      },
      back(kind) {
        const b = backs.current.findLast((x) => kind === undefined || x.kind === kind);
        if (!b) return false;
        b.fn();
        return true;
      },
    }),
    // the toast api and the keymap are stable for the app's life
    [keymap, props.effects, props.clock, toasts.show],
  );
  const value = useMemo(() => ({ ...api, state }), [api, state]);
  return <AppContext.Provider value={value}>{props.children}</AppContext.Provider>;
}

/** Registers the handler for a dialog purpose while the caller is mounted. */
export function useDialogHandler(type: Purpose["type"], fn: DialogHandler): void {
  const app = useApp();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => app.onDialog(type, (p, v) => ref.current(p, v)), [app.onDialog, type]);
}

/** Registers a back handler while `active`: `input` clears a text input, `view` leaves a view. */
export function useBack(active: boolean, kind: BackKind, fn: () => void): void {
  const app = useApp();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => (active ? app.onBack(() => ref.current(), kind) : undefined), [active, kind, app.onBack]);
}

/** The clock's time, re-read every `everyMs` (for "updated 3s ago"). */
export function useNow(everyMs: number): number {
  const { clock } = useApp();
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const h = clock.setInterval(tick, everyMs);
    return () => clock.clearInterval(h);
  }, [clock, everyMs]);
  return clock.now();
}
