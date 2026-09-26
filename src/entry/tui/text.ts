/** Terminal columns a string takes (wide and zero-width characters counted as the terminal does). */
export const width = (s: string): number => Bun.stringWidth(s);

/** Cuts `s` at the end to `max` columns with an ellipsis; never in the middle (spec §9.3). */
export function truncateEnd(s: string, max: number, plain = false): string {
  if (max <= 0) return "";
  if (width(s) <= max) return s;
  const more = plain ? "..." : "…";
  const room = max - width(more);
  if (room <= 0) return more.slice(0, max);
  let out = "";
  for (const ch of s) {
    if (width(out + ch) > room) break;
    out += ch;
  }
  return out + more;
}

/** Pads with spaces to exactly `w` columns (truncating nothing: callers truncate first). */
export const padEnd = (s: string, w: number): string => s + " ".repeat(Math.max(0, w - width(s)));

/**
 * Wraps to `max` columns without losing a character: breaks at spaces, and inside a word only when the
 * word alone is wider than a line (ids, paths and commands wrap; spec §9.3).
 */
export function wrap(s: string, max: number): string[] {
  if (max <= 0) return [s];
  const lines: string[] = [];
  let line = "";
  const push = () => {
    lines.push(line);
    line = "";
  };
  for (const word of s.split(" ")) {
    const candidate = line ? `${line} ${word}` : word;
    if (width(candidate) <= max) {
      line = candidate;
      continue;
    }
    if (line) push();
    let rest = word;
    while (width(rest) > max) {
      let head = "";
      for (const ch of rest) {
        if (head && width(head + ch) > max) break;
        head += ch;
      }
      lines.push(head);
      rest = rest.slice(head.length);
    }
    line = rest;
  }
  if (line || lines.length === 0) push();
  return lines;
}

/** `left` then `right` on one line of exactly `w` columns; `left` gives way (end-truncated) first. */
export function fit(left: string, right: string, w: number, plain = false): string {
  if (!right) return padEnd(truncateEnd(left, w, plain), w);
  const r = truncateEnd(right, Math.max(0, w - 2), plain);
  const l = truncateEnd(left, Math.max(0, w - width(r) - 2), plain);
  return l + " ".repeat(Math.max(1, w - width(l) - width(r))) + r;
}

/** `04:12`, or `1:02:03` past an hour. */
export function clock(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor(s / 60) % 60).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "just now", "12s ago", "4m ago", "2h ago", "3d ago". */
export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** `gpt-6-sol#medium` from `codex:gpt-6-sol#medium`: the backend goes, and a provider path keeps its last part. */
export function shortRung(rung: string): string {
  const noBackend = rung.slice(rung.indexOf(":") + 1);
  return noBackend.slice(noBackend.lastIndexOf("/") + 1);
}

const ASCII: Record<string, string> = {
  "—": "-",
  "–": "-",
  "·": "-",
  "…": "...",
  "⋯": "...",
  "→": "->",
  "←": "<-",
  "↑": "^",
  "↓": "v",
  "●": "*",
  "•": "*",
  "◌": ".",
  "✓": "+",
  "✗": "x",
  "▸": ">",
  "▾": "v",
  "┃": "|",
  "─": "-",
  "█": "#",
  "░": ".",
  "×": "x",
  ω: "w",
};

/** `s` with every character outside printable ASCII replaced, for --plain (spec §9.3). */
export function ascii(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    out += c >= 0x20 && c <= 0x7e ? ch : (ASCII[ch] ?? "?");
  }
  return out;
}
