// Adapted from anomalyco/opencode packages/tui/src/ui/toast.tsx (MIT, © 2025 opencode);
// see THIRD_PARTY_NOTICES.md.
import { useTerminalDimensions } from "@opentui/react";
import { useToasts } from "../providers/toast.tsx";
import { useUi } from "../providers/theme.tsx";
import { truncateEnd, wrap } from "../text.ts";
import { glyph, type Token } from "../theme.ts";
import { Line } from "./line.tsx";

const TONE: Record<string, Token> = { info: "info", success: "success", warning: "warning", error: "error" };

/** Lines of a toast's message kept before the rest is cut; a fix command always shows in full. */
const MESSAGE_LINES = 3;

/**
 * Spec §9.3: the current toast at the top right, with a `┃` bar in its colour and the queue's length.
 * The message wraps to three lines; a fix command wraps in full on muted lines under it.
 */
export function ToastHost() {
  const { current, queued } = useToasts();
  const ui = useUi();
  const dims = useTerminalDimensions();
  if (!current) return null;
  const bar = glyph("bar", ui.plain);
  const max = Math.max(1, Math.min(60, dims.width - 6) - 4);
  const said = wrap(`${current.message}${queued ? `  +${queued} more` : ""}`, max);
  const message = said.slice(0, MESSAGE_LINES);
  if (said.length > MESSAGE_LINES)
    message[MESSAGE_LINES - 1] = truncateEnd(
      `${message[MESSAGE_LINES - 1]} ${said[MESSAGE_LINES]}`,
      max,
      ui.plain,
    );
  const fix = current.fix ? wrap(current.fix, max) : [];
  const text = Math.max(...[...message, ...fix].map((l) => Bun.stringWidth(l)));
  const w = text + 4;
  const line = (t: string, muted: boolean, i: number) => (
    <Line
      key={i}
      width={w}
      parts={[
        { text: `${bar} `, tone: TONE[current.variant] },
        { text: t.padEnd(text + t.length - Bun.stringWidth(t)), tone: muted ? "muted" : undefined },
        { text: ` ${bar}`, tone: TONE[current.variant] },
      ]}
    />
  );
  return (
    <box
      position="absolute"
      top={1}
      left={Math.max(0, dims.width - w - 2)}
      zIndex={4000}
      width={w}
      height={message.length + fix.length}
      flexDirection="column"
    >
      {[...message.map((t, i) => line(t, false, i)), ...fix.map((t, i) => line(t, true, message.length + i))]}
    </box>
  );
}
