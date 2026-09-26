// Adapted from anomalyco/opencode packages/tui/src/ui/dialog-prompt.tsx (MIT, © 2025 opencode);
// see THIRD_PARTY_NOTICES.md.
import type { InputRenderable } from "@opentui/core";
import { useEffect, useRef } from "react";
import { useApp } from "../providers/app.tsx";
import { useCommandLayer } from "../providers/keymap.tsx";
import { useTone } from "../providers/theme.tsx";
import type { Dialog as DialogState } from "../state.ts";
import { Dialog } from "./dialog.tsx";
import { Line } from "./line.tsx";

type Prompt = Extract<DialogState, { kind: "prompt" }>;

/**
 * A value editor: one input that owns every printable key, enter to submit, esc to cancel. A refused
 * value keeps what was typed and shows why under it (research K13).
 */
export function DialogPrompt(props: { dialog: Prompt }) {
  const app = useApp();
  const tone = useTone();
  const input = useRef<InputRenderable>(null);
  const d = props.dialog;
  useEffect(() => {
    input.current?.focus();
  }, []);
  // the value typed so far, not the one drawn: text typed in the same tick as enter has not drawn yet
  useCommandLayer("dialog", {
    "dialog.submit": () => {
      const top = app.getState().dialogs.at(-1);
      app.answer(top?.kind === "prompt" ? top.value : d.value);
    },
  });
  return (
    <Dialog
      title={d.title}
      rows={(inner) => [
        <Line key="label" width={inner} parts={[{ text: d.label, tone: "muted" }]} />,
        <box key="input" flexDirection="row" width={inner} height={1}>
          <text fg={tone("accent")}>{"> "}</text>
          <input
            ref={input}
            value={d.value}
            onInput={(v: string) => app.dispatch({ type: "input", value: v })}
            width={inner - 2}
          />
        </box>,
        <Line key="error" width={inner} parts={d.error ? [{ text: d.error, tone: "error" }] : []} />,
        <Line key="hint" width={inner} parts={[{ text: "enter to save, esc to cancel", tone: "muted" }]} />,
      ]}
    />
  );
}
