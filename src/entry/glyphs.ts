/**
 * Spec §9.3's glyphs, each with its ASCII twin for `--plain`: the dashboard and every CLI command draw
 * state with these. Free of OpenTUI, so `mcp`, `lock` and `_supervise` can load it (spec §3.1).
 */
const GLYPHS = {
  ok: ["✓", "+"],
  warn: ["!", "!"],
  fail: ["✗", "x"],
  skip: ["-", "-"],
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
export type State = "ok" | "warn" | "fail" | "skip";
