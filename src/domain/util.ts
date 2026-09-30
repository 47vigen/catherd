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

/** A plain object: not null and not an array. */
export const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
