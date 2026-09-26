import type { Clock } from "@opentui/core";
import type { ReactNode } from "react";
import type { Keybinds } from "../commands.ts";
import type { Effects } from "../effects.ts";
import type { AppState } from "../state.ts";
import type { Ui } from "../theme.ts";
import { AppProvider } from "./app.tsx";
import { AppErrorBoundary } from "./boundary.tsx";
import { type AppKeymap, AppKeymapProvider } from "./keymap.tsx";
import { ThemeProvider } from "./theme.tsx";
import { ToastProvider } from "./toast.tsx";

/**
 * Every provider, in dependency order: theme → keymap → toasts → app state (dialogs, handlers), and
 * under them the boundary that keeps a way out when a view throws.
 */
export function Providers(props: {
  ui: Ui;
  keybinds: Keybinds;
  keymap?: AppKeymap;
  effects: Effects;
  clock: Clock;
  initial: AppState;
  copy: (text: string) => boolean;
  onExit: (code: number, kept: string[]) => void;
  children: ReactNode;
}) {
  return (
    <ThemeProvider ui={props.ui}>
      <AppKeymapProvider keybinds={props.keybinds} keymap={props.keymap}>
        <ToastProvider clock={props.clock}>
          <AppProvider
            effects={props.effects}
            clock={props.clock}
            initial={props.initial}
            copy={props.copy}
            onExit={props.onExit}
          >
            <AppErrorBoundary>{props.children}</AppErrorBoundary>
          </AppProvider>
        </ToastProvider>
      </AppKeymapProvider>
    </ThemeProvider>
  );
}
