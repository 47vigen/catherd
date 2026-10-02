/** Lower-case letters and digits, every other run of characters one `-`, no `-` at either end. */
export const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

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
