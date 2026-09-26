import type { ReactNode } from "react";
import { useApp } from "../providers/app.tsx";
import { useUi } from "../providers/theme.tsx";
import { DialogConfirm } from "../widgets/dialog-confirm.tsx";
import { DialogPrompt } from "../widgets/dialog-prompt.tsx";
import { DialogSelect } from "../widgets/dialog-select.tsx";
import { SaveDialog } from "./save-dialog.tsx";

/** Draws the top dialog of the stack; a new dialog remounts, so its cursor and filter start fresh. */
export function DialogHost() {
  const { state } = useApp();
  const top = state.dialogs.at(-1);
  if (!top) return null;
  const key = `${state.dialogs.length}:${top.purpose.type}`;
  switch (top.kind) {
    case "select":
      return <DialogSelect key={key} dialog={top} />;
    case "confirm":
      return <DialogConfirm key={key} dialog={top} />;
    case "prompt":
      return <DialogPrompt key={key} dialog={top} />;
    case "save":
      return <SaveDialog key={key} dialog={top} />;
  }
}

/**
 * What an open dialog is drawn over. Without colour nothing can paint the panel opaque (a space
 * with no background shows what is beneath), so there the dialog replaces these lines instead.
 */
export function Behind(props: { width: number; height: number; children: ReactNode }) {
  const { state } = useApp();
  const ui = useUi();
  return (
    <box width={props.width} height={props.height}>
      <box width={props.width} height={props.height} visible={!(state.dialogs.length > 0 && !ui.color)}>
        {props.children}
      </box>
    </box>
  );
}
