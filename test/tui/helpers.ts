import stringWidth from "string-width";
import type { MockInput } from "@opentui/core/testing";
import type { BackendStatus } from "../../src/tui/backends.ts";
import type { Ui } from "../../src/tui/theme.ts";
import { type Bars, type Catalog, type CatalogModel, DIFFICULTIES, KINDS } from "../../src/types.ts";

/** Colourless and still, so frames are plain text and identical on every run. */
export const UI: Ui = { plain: false, reducedMotion: true, depth: 1 };
export const PLAIN: Ui = { ...UI, plain: true };

/** Semantic key names accepted by OpenTUI's mock keyboard (see `press`). */
export const KEY = {
  up: "up",
  down: "down",
  right: "right",
  left: "left",
  enter: "enter",
  esc: "escape",
  space: " ",
  backspace: "backspace",
} as const;

export const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends one key or one run of typed text per argument, through OpenTUI's mock keyboard.
 * A single character or a name from `KEY` is a key press; anything longer is typed text.
 */
export async function press(input: MockInput, ...keys: string[]): Promise<void> {
  await tick();
  for (const k of keys) {
    switch (k) {
      case "up":
      case "down":
      case "left":
      case "right":
        input.pressArrow(k);
        break;
      case "enter":
        input.pressEnter();
        break;
      case "escape":
        input.pressEscape();
        break;
      case "backspace":
        input.pressBackspace();
        break;
      default:
        if (k.length === 1) input.pressKey(k);
        else await input.typeText(k);
    }
    await tick();
  }
}

export const down = (n: number): string[] => Array<string>(n).fill(KEY.down);

/** OpenTUI's captureCharFrame pads every row to the requested width, so trailing blanks are cropped first. */
export function widest(frame = ""): number {
  return Math.max(0, ...frame.split("\n").map((line) => stringWidth(line.replace(/\s+$/, ""))));
}

export const READY: BackendStatus[] = [
  { backend: "codex", installed: true, version: "0.156.1", loggedIn: true, fix: null },
  { backend: "opencode", installed: true, version: "2.0.15", loggedIn: true, fix: null },
];

export const NOT_READY: BackendStatus[] = [
  { backend: "codex", installed: false, version: null, loggedIn: false, fix: "npm i -g @openai/codex" },
  { backend: "opencode", installed: true, version: "2.0.15", loggedIn: false, fix: "opencode auth login" },
];

export const caps = (o: Partial<CatalogModel["capabilities"]> = {}): CatalogModel["capabilities"] => ({
  toolCall: true,
  imageIn: false,
  imageOut: false,
  reasoning: true,
  context: 400_000,
  ...o,
});

/** Small and fixed, so frame tests do not move when plan 2's shipped catalog changes. */
export function catalogFixture(extra: CatalogModel[] = []): Catalog {
  const bars = Object.fromEntries(
    KINDS.map((k) => [k, Object.fromEntries(DIFFICULTIES.map((d) => [d, {}]))]),
  ) as Bars;
  return {
    version: "test",
    models: [
      {
        id: "claude-opus-5-5",
        backend: "claude",
        efforts: ["low", "medium", "high"],
        capabilities: caps({ imageIn: true }),
      },
      {
        id: "gpt-6-sol",
        backend: "codex",
        efforts: ["medium", "high", "xhigh"],
        capabilities: caps({ imageIn: true, imageOut: true }),
      },
      { id: "gpt-6-luna", backend: "codex", efforts: ["high", "xhigh", "max"], capabilities: caps() },
      { id: "openrouter/qwen/qwen3-coder", backend: "opencode", efforts: ["high"], capabilities: caps() },
      ...extra,
    ],
    entries: [
      {
        rung: "gpt-6-luna#high",
        scores: { repo_code: 59.3, terminal: 4.5, secs_per_task: 563 },
        costRank: 1,
      },
      {
        rung: "gpt-6-sol#medium",
        scores: { repo_code: 56.6, terminal: 18.7, secs_per_task: 264 },
        costRank: 2,
      },
      {
        rung: "gpt-6-sol#high",
        scores: { repo_code: 65.3, terminal: 26.3, secs_per_task: 391 },
        costRank: 3,
      },
      {
        rung: "gpt-6-sol#xhigh",
        scores: { repo_code: 66.6, terminal: 30.3, secs_per_task: 496 },
        costRank: 4,
      },
      { rung: "claude-opus-5-5#low", scores: { terminal: 31.3 }, costRank: 5 },
      { rung: "claude-opus-5-5#medium", scores: { terminal: 52.5 }, costRank: 6 },
      { rung: "claude-opus-5-5#high", scores: { terminal: 56.6 }, costRank: 7 },
    ],
    bars,
    treatLike: {},
  };
}
