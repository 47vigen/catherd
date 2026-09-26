// Adapted from anomalyco/opencode packages/tui/src/ui/dialog-confirm.tsx (MIT, © 2025 opencode);
// see THIRD_PARTY_NOTICES.md.
import { useState } from "react";
import { useApp } from "../providers/app.tsx";
import { useCommandLayer } from "../providers/keymap.tsx";
import type { Dialog as DialogState } from "../state.ts";
import { wrap } from "../text.ts";
import { Dialog } from "./dialog.tsx";
import { Line } from "./line.tsx";

type Confirm = Extract<DialogState, { kind: "confirm" }>;

/** A row of buttons: ←/→ or tab move, enter chooses (spec §9.2 confirmations; never "any other key"). */
export function Buttons(props: { labels: string[]; focused: number; width: number }) {
  const cells = props.labels.map((l) => `[ ${l} ]`);
  const used = cells.reduce((n, c) => n + Bun.stringWidth(c) + 2, 0);
  return (
    <box flexDirection="row" width={props.width} height={1}>
      {cells.map((c, i) => (
        <box key={c} flexDirection="row">
          <Line width={Bun.stringWidth(c)} parts={[{ text: c }]} selected={i === props.focused} />
          <text>{"  "}</text>
        </box>
      ))}
      <text>{" ".repeat(Math.max(0, props.width - used))}</text>
    </box>
  );
}

/** A real confirmation: the message, then [no] [yes]; a destructive one starts on "no". */
export function DialogConfirm(props: { dialog: Confirm }) {
  const app = useApp();
  const d = props.dialog;
  const [focused, setFocused] = useState(d.destructive ? 0 : 1);
  useCommandLayer("dialog", {
    "dialog.left": () => setFocused(0),
    "dialog.right": () => setFocused(1),
    "dialog.submit": () => (focused === 1 ? app.answer("yes") : app.dispatch({ type: "close" })),
  });
  return (
    <Dialog
      title={d.title}
      rows={(inner) => [
        ...d.message.flatMap((m, i) =>
          wrap(m, inner).map((l, j) => <Line key={`m${i}-${j}`} width={inner} parts={[{ text: l }]} />),
        ),
        <Line key="gap" width={inner} parts={[]} />,
        <Buttons key="buttons" labels={[d.no, d.yes]} focused={focused} width={inner} />,
      ]}
    />
  );
}
