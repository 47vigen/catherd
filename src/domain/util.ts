/** Lower-case letters and digits, every other run of characters one `-`, no `-` at either end. */
export const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Natural order: `M2` before `M10`, `M1.L2` before `M1.L10`. */
export const natural = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });

/** One table cell or one line of text: `|` and newlines become `/`, whitespace runs one space, trimmed. */
export const cell = (s: string): string => s.replace(/[|\n]/g, "/").replace(/\s+/g, " ").trim();

/** The middle value, or the mean of the two middle values for an even count; null when there are none. */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

/** A stretch of time in epoch ms; `to` null while it is still open. */
export interface Span {
  from: number;
  to: number | null;
}

/** How many ms of [from, to] any of `spans` covers, overlaps counted once; an open span runs to `to`. */
export function coveredMs(from: number, to: number, spans: readonly Span[]): number {
  const clipped = spans
    .map((s) => [Math.max(from, s.from), Math.min(to, s.to ?? to)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of clipped) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return total;
}

/** A plain object: not null and not an array. */
export const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;

/** Which lines sit inside a ``` or ~~~ fence (the fence lines included), and the fence still open at the end. */
function scanFences(lines: readonly string[]): { inside: boolean[]; open: string | null } {
  let open: string | null = null;
  const inside = lines.map((line) => {
    const mark = FENCE_OPEN.exec(line)?.[1];
    if (open === null) {
      if (mark === undefined) return false;
      open = mark;
      return true;
    }
    if (mark !== undefined && mark[0] === open[0] && mark.length >= open.length && line.trim() === mark)
      open = null;
    return true;
  });
  return { inside, open };
}

/** `text` with the content of every fenced line blanked, same length and same line breaks: heading regexes skip code. */
export function maskFences(text: string): string {
  const lines = text.split("\n");
  const { inside } = scanFences(lines);
  return lines.map((l, i) => (inside[i] ? " ".repeat(l.length) : l)).join("\n");
}

/**
 * The longest start of `text` within `maxBytes` of UTF-8: whole lines, a fence left open closed, and only when no
 * line fits, a cut at a character boundary.
 */
export function cutText(text: string, maxBytes: number): string {
  maxBytes = Math.max(maxBytes, 0);
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const kept: string[] = [];
  let bytes = 0;
  for (const line of text.split("\n")) {
    const b = Buffer.byteLength(line) + 1;
    if (bytes + b > maxBytes) break;
    kept.push(line);
    bytes += b;
  }
  if (kept.length === 0) return Buffer.from(text).subarray(0, maxBytes).toString("utf8").replace(/�+$/, "");
  for (;;) {
    const { open } = scanFences(kept);
    if (open === null) return kept.join("\n");
    if (bytes + open.length <= maxBytes || kept.length === 1) return `${kept.join("\n")}\n${open}`;
    bytes -= Buffer.byteLength(kept.pop() as string) + 1;
  }
}
