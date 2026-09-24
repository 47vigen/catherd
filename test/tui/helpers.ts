import stringWidth from "string-width";
import type { MockInput } from "@opentui/core/testing";
import type { Ui } from "../../src/tui/theme.ts";

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

export function widest(frame = ""): number {
  return Math.max(0, ...frame.split("\n").map((line) => stringWidth(line)));
}
