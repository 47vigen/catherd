import { WriteStream } from "node:tty";
import type { HarnessCost } from "../core/harness.ts";

export type Mood = "good" | "working" | "waiting" | "failed" | "landed";
export type Tone = "ginger" | "cream" | "charcoal" | "pink" | "green" | "amber" | "red";
/** Node's getColorDepth: 1 none, 4 sixteen, 8 256, 24 true colour. */
export type Depth = 1 | 4 | 8 | 24;

export interface Ui {
  plain: boolean;
  reducedMotion: boolean;
  depth: Depth;
}

// OpenTUI renders true-colour RGB only and downsamples itself for the terminal it finds, so
// every depth above 1 gets the same hex; depth 1 (NO_COLOR) gets no colour at all.
const TONES: Record<Tone, string> = {
  ginger: "#E8833A",
  cream: "#F5E6C8",
  charcoal: "#4A4340",
  pink: "#FF6FA5",
  green: "#8FBF6A",
  amber: "#E0A63E",
  red: "#D9636A",
};

/** The one accent colour: headings and the selected-row bar. Everything else stays neutral or dim. */
export const ACCENT: Tone = "pink";

export const GRADIENT: string[] = [TONES.ginger, TONES.pink];

export function tint(tone: Tone, depth: Depth): string | undefined {
  return depth === 1 ? undefined : TONES[tone];
}

export function detectUi(rawArgs: string[], env: NodeJS.ProcessEnv = process.env): Ui {
  return {
    // is-unicode-supported answers exactly this on macOS and Linux.
    plain: rawArgs.includes("--plain") || env.TERM === "linux",
    reducedMotion: rawArgs.includes("--reduced-motion"),
    depth: WriteStream.prototype.getColorDepth.call(process.stdout as WriteStream, env) as Depth,
  };
}

export const FACES: Record<Mood, string> = {
  good: "=^.^=",
  working: "=o.o=",
  waiting: "=-.-=",
  failed: "=x.x=",
  landed: "=^ω^=",
};

export function face(mood: Mood, plain: boolean): string {
  return plain ? FACES[mood].replace("ω", "w") : FACES[mood];
}

const GLYPHS = {
  on: ["●", "*"],
  off: ["○", "o"],
  cat: ["🐈", "*"],
  paw: ["🐾", ""],
  dot: ["·", "-"],
  more: ["…", "..."],
  open: ["▾", "v"],
  shut: ["▸", ">"],
  cursor: ["▶", ">"],
  arrow: ["→", "->"],
  keys: ["↑↓", "up/down"],
  swap: ["⇄", "<->"],
} as const;

export type Glyph = keyof typeof GLYPHS;
export const GLYPH_NAMES = Object.keys(GLYPHS) as Glyph[];

export function glyph(g: Glyph, plain: boolean): string {
  return GLYPHS[g][plain ? 1 : 0];
}

/** Ready/warn/missing status, painted with the same two shapes `on`/`off` toggles use — a
 * warning is still a "filled" dot (amber instead of green), missing is the hollow one (red).
 * ponytail: --plain collapses warn into the ready glyph (a star), the spec's ASCII table only
 * names two dot characters, star and o; upgrade to a three-way ASCII split if that ever matters. */
export type DotState = "ready" | "warn" | "missing";
const DOT_TONE: Record<DotState, Tone> = { ready: "green", warn: "amber", missing: "red" };

export function dot(state: DotState, plain: boolean): string {
  return glyph(state === "missing" ? "off" : "on", plain);
}

export function dotTint(state: DotState, depth: Depth): string | undefined {
  return tint(DOT_TONE[state], depth);
}

/** The conductor: ears, a face that follows the mood, a raised baton, paws. */
export function mascot(mood: Mood, plain: boolean): [string, string, string] {
  return [" /\\_/\\  .", `(${face(mood, plain)})/`, ' (")(")'].map((l) => l.padEnd(9)) as [
    string,
    string,
    string,
  ];
}

export const HERDING = [
  "herding",
  "counting whiskers",
  "negotiating with Luna",
  "coaxing Sol off the keyboard",
  "lining up the kittens",
  "untangling the yarn",
] as const;

export function herdLine(i: number, plain: boolean): string {
  return `${HERDING[i % HERDING.length]}${glyph("more", plain)}`;
}

/** Kneading paws (m/n) and a flicking tail. ASCII already, so --plain needs no second set. */
export const SPINNER = {
  frames: ["m=o.o=~", "n=o.o=-", "m=o.o=_", "n=o.o=-"],
  ms: 160,
  copyMs: 2400,
} as const;

/** The init intro: 6 frames of 200 ms, 1.2 s in all, inside the spec's 1.5 s. */
export const INTRO = { steps: 6, ms: 200 } as const;

export const HARNESS_HINT: Record<"codex" | "opencode", string> = {
  codex: "native keeps your Codex config, hooks, skills, AGENTS.md; isolated saves tokens",
  opencode: "native keeps your opencode config, agents and plugins; isolated saves tokens",
};

const kTokens = (n: number) => `~${Math.round(n / 1000)}k`;

export function costNote(h: HarnessCost): string {
  if (h.extraPerRun !== null) return `customizations ${kTokens(h.extraPerRun)} tokens/run`;
  if (h.nativeMedian !== null) return `native ${kTokens(h.nativeMedian)} tokens/run`;
  return h.isolatedMedian !== null ? `isolated ${kTokens(h.isolatedMedian)} tokens/run` : "";
}

/** The profile editor's HARNESS detail: the native/isolated choice plus what it costs, falling
 * back to the static hint (`HARNESS_HINT`) until a run has recorded a real cost. */
export function harnessLine(
  backend: "codex" | "opencode",
  isolated: boolean,
  cost: HarnessCost | undefined,
  plain: boolean,
): string {
  const mode = isolated ? "isolated" : "native";
  const note = (cost && costNote(cost)) || HARNESS_HINT[backend];
  return `${mode} ${glyph("dot", plain)} ${note}`;
}

export function clock(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor(s / 60) % 60).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** "gpt-6-sol#medium" -> "sol#medium"; provider paths drop to the last segment. */
export function shortRung(rung: string): string {
  return rung.replace(/^.*\//, "").replace(/^gpt-\d+-/, "");
}

export function nick(rung: string): string {
  const model = shortRung(rung).split("#")[0] ?? "";
  return model.charAt(0).toUpperCase() + model.slice(1);
}

export function climbLine(name: string, from: string, to: string, plain: boolean): string {
  const a = nick(from);
  const b = nick(to);
  const story = a === b ? `${a} digs deeper` : `${a} gave up, ${b} takes over`;
  return `${story} ${glyph("dot", plain)} ${name} ${shortRung(from)} ${glyph("arrow", plain)} ${shortRung(to)}`;
}
