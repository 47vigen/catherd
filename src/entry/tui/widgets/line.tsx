import { TextAttributes } from "@opentui/core";
import { useTone, useUi } from "../providers/theme.tsx";
import { ascii, truncateEnd, width as widthOf } from "../text.ts";
import type { Token } from "../theme.ts";

/** One run of text on a line, in a token's colour. */
export interface Part {
  text: string;
  tone?: Token;
  bold?: boolean;
}

/** The parts cut to `max` columns at the end (an ellipsis on the last one kept). */
export function clip(parts: Part[], max: number, plain: boolean): Part[] {
  const out: Part[] = [];
  let used = 0;
  for (const p of parts) {
    const w = widthOf(p.text);
    if (used + w <= max) {
      out.push(p);
      used += w;
      continue;
    }
    const room = max - used;
    if (room > 0) out.push({ ...p, text: truncateEnd(p.text, room, plain) });
    break;
  }
  return out;
}

/**
 * The one line primitive every row is drawn with: exactly `width` columns. A selected line is filled
 * with the accent and bold (spec §9.3), or drawn in reverse video without colour; under --plain every
 * character is ASCII.
 */
export function Line(props: { parts: Part[]; width: number; selected?: boolean; dim?: boolean }) {
  const ui = useUi();
  const tone = useTone();
  const parts = clip(
    ui.plain ? props.parts.map((p) => ({ ...p, text: ascii(p.text) })) : props.parts,
    props.width,
    ui.plain,
  );
  const used = parts.reduce((n, p) => n + widthOf(p.text), 0);
  const pad = " ".repeat(Math.max(0, props.width - used));
  const sel = props.selected === true;
  const fg = (p: Part) =>
    sel ? tone("selectionText") : props.dim ? tone("muted") : p.tone ? tone(p.tone) : undefined;
  const bg = sel ? tone("selection") : undefined;
  const attrs = (p: Part) =>
    (sel || p.bold ? TextAttributes.BOLD : 0) | (sel && !ui.color ? TextAttributes.INVERSE : 0);
  return (
    <text wrapMode="none">
      {parts.map((p, i) => (
        <span key={i} fg={fg(p)} bg={bg} attributes={attrs(p)}>
          {p.text}
        </span>
      ))}
      <span bg={bg} attributes={sel && !ui.color ? TextAttributes.INVERSE : 0}>
        {pad}
      </span>
    </text>
  );
}

/** A full-width rule (`─`, or `-` in plain). */
export function Rule(props: { width: number }) {
  const ui = useUi();
  const tone = useTone();
  return (
    <text wrapMode="none" fg={tone("border")}>
      {(ui.plain ? "-" : "─").repeat(Math.max(0, props.width))}
    </text>
  );
}
