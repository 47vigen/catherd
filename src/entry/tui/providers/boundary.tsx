import { useTerminalDimensions } from "@opentui/react";
import { Component, type ReactNode, useEffect } from "react";
import { isCatherdError } from "../../../domain/errors.ts";
import { wrap } from "../text.ts";
import { Line } from "../widgets/line.tsx";
import { useApp } from "./app.tsx";
import { setModal, useCommandLayer, useKeymap } from "./keymap.tsx";

/**
 * What shows when a view throws while drawing: the error, its fix and a way out. Everything under the
 * boundary is gone, with its keys, so this registers its own quit: q or ctrl+c exits 1 and prints the
 * error after the terminal is given back.
 */
function Crashed(props: { error: unknown }) {
  const app = useApp();
  const keymap = useKeymap();
  const dims = useTerminalDimensions();
  const e = props.error;
  const message = e instanceof Error ? e.message : String(e);
  const fix = isCatherdError(e) ? e.fix : undefined;
  // a dialog open when it broke is gone with the rest: its modal mode would keep q from reaching quit
  useEffect(() => setModal(keymap, false), [keymap]);
  const quit = () => {
    app.keep([`catherd: ${message}`, ...(fix ? [`fix: ${fix}`] : [])]);
    app.exit(1);
  };
  useCommandLayer("global", { "app.interrupt": quit });
  useCommandLayer("app", { "app.quit": quit });
  const w = Math.max(10, dims.width - 2);
  const lines: { text: string; tone?: "error" | "muted" }[] = [
    { text: "" },
    ...wrap(`catherd stopped: ${message}`, w).map((text) => ({ text, tone: "error" as const })),
    ...(fix ? wrap(`fix: ${fix}`, w).map((text) => ({ text, tone: "muted" as const })) : []),
    { text: "" },
    { text: "press q or ctrl+c to quit; unsaved changes are lost", tone: "muted" },
  ];
  return (
    <box flexDirection="column" width={dims.width} height={dims.height}>
      {lines.map((l, i) => (
        <Line key={i} width={dims.width} parts={[{ text: ` ${l.text}`, tone: l.tone }]} />
      ))}
    </box>
  );
}

/** Catches an error thrown while drawing, so the user keeps a way out of the alternate screen. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: unknown }> {
  override state: { error: unknown } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error: error ?? new Error("unknown error") };
  }

  override render(): ReactNode {
    return this.state.error !== null ? <Crashed error={this.state.error} /> : this.props.children;
  }
}
