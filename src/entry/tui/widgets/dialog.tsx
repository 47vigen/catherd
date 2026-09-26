// Adapted from anomalyco/opencode packages/tui/src/ui/dialog.tsx (MIT, © 2025 opencode);
// see THIRD_PARTY_NOTICES.md.
import { useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import { useTone, useUi } from "../providers/theme.tsx";
import { DIALOG_WIDTH, type DialogSize } from "../theme.ts";
import { Line } from "./line.tsx";

/** The panel's inner width: its size, clamped to the terminal less a margin, less the padding. */
export const dialogInner = (size: DialogSize, termWidth: number): number =>
  Math.max(10, Math.min(DIALOG_WIDTH[size], termWidth - 2) - 4);

/**
 * Spec §9.3: a raised panel over a dimmed backdrop, a quarter down the screen, 60, 88 or 116 columns
 * wide, with no border; the title bold on the left and a muted `esc` on the right. `rows` returns one
 * node per line, each `inner` columns wide (Line pads them); the panel pads every line with spaces on
 * both sides, so it hides what is beneath even without colour.
 */
export function Dialog(props: { title: string; size?: DialogSize; rows: (inner: number) => ReactNode[] }) {
  const dims = useTerminalDimensions();
  const ui = useUi();
  const tone = useTone();
  const size = props.size ?? "medium";
  const inner = dialogInner(size, dims.width);
  const lines: ReactNode[] = [
    <Line key="top" width={inner} parts={[]} />,
    <Line
      key="title"
      width={inner}
      parts={[
        { text: props.title, bold: true },
        { text: " ".repeat(Math.max(1, inner - Bun.stringWidth(props.title) - 3)) },
        { text: "esc", tone: "muted" },
      ]}
    />,
    <Line key="gap" width={inner} parts={[]} />,
    ...props.rows(inner),
    <Line key="bottom" width={inner} parts={[]} />,
  ];
  return (
    <box
      position="absolute"
      top={0}
      left={0}
      zIndex={3000}
      width={dims.width}
      height={dims.height}
      alignItems="center"
      paddingTop={Math.floor(dims.height / 4)}
      backgroundColor={ui.color ? `${tone("backdrop")}99` : undefined}
    >
      <box width={inner + 4} flexDirection="column" backgroundColor={tone("surfaceRaised")}>
        {lines.map((line, i) => (
          <box key={i} flexDirection="row" height={1}>
            <text>{"  "}</text>
            {line}
            <text>{"  "}</text>
          </box>
        ))}
      </box>
    </box>
  );
}
