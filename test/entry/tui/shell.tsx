import type { ReactNode } from "react";
import { useApp } from "../../../src/entry/tui/providers/app.tsx";
import { DataProvider } from "../../../src/entry/tui/providers/data.tsx";
import { useCommandLayer } from "../../../src/entry/tui/providers/keymap.tsx";
import { Behind, DialogHost } from "../../../src/entry/tui/views/dialogs.tsx";
import { ToastHost } from "../../../src/entry/tui/widgets/toast.tsx";

function Frame(props: { width: number; height: number; children: ReactNode }) {
  const app = useApp();
  // the App's esc: close the top dialog, else run the newest back handler
  useCommandLayer("global", {
    "app.back": () => (app.getState().dialogs.length ? app.dispatch({ type: "close" }) : void app.back()),
  });
  return (
    <box flexDirection="column">
      <Behind width={props.width} height={props.height}>
        {props.children}
      </Behind>
      <DialogHost />
      <ToastHost />
    </box>
  );
}

/** A view as the App mounts it: shared data, esc, dialogs and toasts, without the App's tabs. */
export function Shell(props: { width: number; height: number; children: ReactNode }) {
  return (
    <DataProvider>
      <Frame width={props.width} height={props.height}>
        {props.children}
      </Frame>
    </DataProvider>
  );
}
