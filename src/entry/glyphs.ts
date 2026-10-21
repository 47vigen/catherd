/**
 * Spec §9.3's glyphs, each with its ASCII twin for `--plain`: every CLI command draws state with these, so
 * `mcp`, `lock` and `_supervise` can load them (spec §3.1).
 */
const GLYPHS = {
  ok: ["✓", "+"],
  warn: ["!", "!"],
  fail: ["✗", "x"],
  skip: ["-", "-"],
  info: ["i", "i"],
  live: ["●", "*"],
  waiting: ["◌", "."],
  on: ["[x]", "[x]"],
  off: ["[ ]", "[ ]"],
  open: ["▾", "v"],
  shut: ["▸", ">"],
  arrow: ["→", "->"],
  dot: ["·", "-"],
  more: ["…", "..."],
  up: ["↑", "^"],
  down: ["↓", "v"],
  bar: ["┃", "|"],
  rule: ["─", "-"],
  current: ["●", "*"],
  full: ["█", "#"],
  empty: ["░", "."],
} as const;
export type Glyph = keyof typeof GLYPHS;
export const GLYPH_NAMES = Object.keys(GLYPHS) as Glyph[];

export const glyph = (g: Glyph, plain: boolean): string => GLYPHS[g][plain ? 1 : 0];

/** The words state always travels with (spec §9.3: green/amber/red only for state, always with a word). */
export type State = "ok" | "warn" | "fail" | "skip" | "info";

export type Mood = "good" | "working" | "waiting" | "failed";
export const FACES: Record<Mood, string> = {
  good: "=^.^=",
  working: "=o.o=",
  waiting: "=-.-=",
  failed: "=x.x=",
};

/** The conductor, for the init welcome only (spec §9.3). ASCII already. */
export function mascot(mood: Mood): [string, string, string] {
  return [" /\\_/\\  .", `(${FACES[mood]})/`, ' (")(")'].map((l) => l.padEnd(9)) as [string, string, string];
}
