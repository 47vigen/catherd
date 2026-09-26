/** Spec §9.3: the 16 semantic tokens every widget paints with. */
export const TOKENS = [
  "text",
  "muted",
  "accent",
  "accentText",
  "surface",
  "surfaceRaised",
  "backdrop",
  "border",
  "success",
  "warning",
  "error",
  "info",
  "selection",
  "selectionText",
  "diffAdd",
  "diffDel",
] as const;
export type Token = (typeof TOKENS)[number];
export type Palette = Record<Token, string>;
export type ThemeMode = "dark" | "light";

/**
 * Accent ginger `#E8833A` on dark and `#B45309` on light (spec §9.3); every colour that carries text
 * keeps 4.5:1 against both surfaces (test/entry/tui/theme.test.ts). The screen itself keeps the
 * terminal's own background; `surface` is only what text on the accent fill contrasts with.
 */
export const PALETTES: Record<ThemeMode, Palette> = {
  dark: {
    text: "#EEEEEE",
    muted: "#8A8A8A",
    accent: "#E8833A",
    accentText: "#0A0A0A",
    surface: "#0A0A0A",
    surfaceRaised: "#1E1E1E",
    backdrop: "#000000",
    border: "#484848",
    success: "#7FD88F",
    warning: "#F5A742",
    error: "#E06C75",
    info: "#56B6C2",
    selection: "#E8833A",
    selectionText: "#0A0A0A",
    diffAdd: "#4FD6BE",
    diffDel: "#E06C75",
  },
  light: {
    text: "#1A1A1A",
    muted: "#6B6B6B",
    accent: "#B45309",
    accentText: "#FFFFFF",
    surface: "#FFFFFF",
    surfaceRaised: "#F7F7F7",
    backdrop: "#000000",
    border: "#B8B8B8",
    success: "#2F7D46",
    warning: "#8A6116",
    error: "#C22D33",
    info: "#256F7B",
    selection: "#B45309",
    selectionText: "#FFFFFF",
    diffAdd: "#1E725C",
    diffDel: "#B42A3E",
  },
};

/** How this terminal is drawn: `plain` is ASCII only, `color` false paints nothing (NO_COLOR). */
export interface Ui {
  plain: boolean;
  color: boolean;
  reducedMotion: boolean;
  mode: ThemeMode;
}

type Env = Record<string, string | undefined>;

/** The first locale variable that is set decides; with none set the terminal is taken to speak UTF-8. */
function utf8(env: Env): boolean {
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  return !locale || /utf-?8/i.test(locale);
}

/**
 * Spec §9.3: `NO_COLOR` and `--plain` (ASCII glyphs, no colour). Reads only `rawArgs` and `env`, never
 * the terminal, so it answers the same on every machine. OpenTUI downsamples true colour itself.
 */
export function detectUi(rawArgs: readonly string[], env: Env): Omit<Ui, "mode"> {
  const dumb = env.TERM === "dumb";
  const plain = rawArgs.includes("--plain") || env.TERM === "linux" || dumb || !utf8(env);
  return {
    plain,
    color: !rawArgs.includes("--plain") && !dumb && !env.NO_COLOR,
    reducedMotion: rawArgs.includes("--reduced-motion") || Boolean(env.CATHERD_REDUCED_MOTION),
  };
}

/** A token's colour, or undefined when the terminal gets no colour. */
export const paint = (ui: Ui, token: Token): string | undefined =>
  ui.color ? PALETTES[ui.mode][token] : undefined;

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
export const STATE_TOKEN: Record<State, Token> = {
  ok: "success",
  warn: "warning",
  fail: "error",
  skip: "muted",
};

export type Mood = "good" | "working" | "waiting" | "failed";
export const FACES: Record<Mood, string> = {
  good: "=^.^=",
  working: "=o.o=",
  waiting: "=-.-=",
  failed: "=x.x=",
};

/** The conductor, for the init welcome and empty states only (spec §9.3). ASCII already. */
export function mascot(mood: Mood): [string, string, string] {
  return [" /\\_/\\  .", `(${FACES[mood]})/`, ' (")(")'].map((l) => l.padEnd(9)) as [string, string, string];
}

/** Spec §9.3 motion: a braille spinner at 80 ms, shown after 500 ms and kept at least 3 s. */
export const SPINNER = {
  frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  plainFrames: ["|", "/", "-", "\\"],
  still: ["⋯", "..."],
  ms: 80,
  showAfterMs: 500,
  minShowMs: 3_000,
} as const;

/** Spec §9.3: dialogs are 60, 88 or 116 columns, clamped to the terminal. */
export const DIALOG_WIDTH = { medium: 60, large: 88, xlarge: 116 } as const;
export type DialogSize = keyof typeof DIALOG_WIDTH;
