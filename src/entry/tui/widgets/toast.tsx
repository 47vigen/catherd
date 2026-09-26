// Adapted from anomalyco/opencode packages/tui/src/ui/toast.tsx (MIT, © 2025 opencode);
// see THIRD_PARTY_NOTICES.md.
import { useTerminalDimensions } from "@opentui/react";
import { useToasts } from "../providers/toast.tsx";
import { useUi } from "../providers/theme.tsx";
import { truncateEnd } from "../text.ts";
import { glyph, type Token } from "../theme.ts";
import { Line } from "./line.tsx";

const TONE: Record<string, Token> = { info: "info", success: "success", warning: "warning", error: "error" };

/** Spec §9.3: the current toast at the top right, with a `┃` bar in its colour and the queue's length. */
export function ToastHost() {
  const { current, queued } = useToasts();
  const ui = useUi();
  const dims = useTerminalDimensions();
  if (!current) return null;
  const bar = glyph("bar", ui.plain);
  const max = Math.min(60, dims.width - 6);
  const text = truncateEnd(`${current.message}${queued ? `  +${queued} more` : ""}`, max - 4, ui.plain);
  const w = Bun.stringWidth(text) + 4;
  return (
    <box
      position="absolute"
      top={1}
      left={Math.max(0, dims.width - w - 2)}
      zIndex={4000}
      width={w}
      height={1}
    >
      <Line
        width={w}
        parts={[
          { text: `${bar} `, tone: TONE[current.variant] },
          { text },
          { text: ` ${bar}`, tone: TONE[current.variant] },
        ]}
      />
    </box>
  );
}
