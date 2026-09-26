import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act, type ReactNode } from "react";

export interface Screen extends TestRendererSetup {
  /** Presses keys in the keymap's syntax (`ctrl+s`, `shift+g`, `return`, `escape`, `space`, `up`, `j`), then flushes. */
  press(...keys: string[]): Promise<void>;
  /** Types text as a person would, then flushes. */
  type(text: string): Promise<void>;
  frame(): string;
  /** destroys the renderer inside act(), so unmounting effects run before the next test */
  close(): Promise<void>;
}

const NAMED: Record<string, string> = {
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  home: "HOME",
  end: "END",
  space: " ",
  tab: "TAB",
};

/**
 * Renders under the kitty keyboard protocol, which reports a lone esc at once (a legacy terminal waits
 * to tell esc from alt+key), so no test waits on wall-clock time. Every key, text and clock step runs
 * inside React's act(), which settles state updates and effects before it returns; flush() then draws.
 */
/** Runs `f` inside act(), so React has applied every update and effect it caused, then draws a frame. */
export async function settle(s: TestRendererSetup, f: () => unknown): Promise<void> {
  await act(async () => {
    await f();
  });
  await s.flush();
}

export async function mount(
  node: ReactNode,
  size: { width: number; height: number } = { width: 80, height: 24 },
): Promise<Screen> {
  const s = await testRender(node, { ...size, kittyKeyboard: true });
  await settle(s, () => {});
  const one = (key: string) => {
    const m = key.match(/^(?:(ctrl|shift|meta)\+)?(.+)$/) as RegExpMatchArray;
    const mod = m[1] ? { [m[1]]: true } : undefined;
    const name = m[2] as string;
    if (name === "return") return s.mockInput.pressEnter(mod);
    if (name === "escape") return s.mockInput.pressEscape(mod);
    if (name === "backspace") return s.mockInput.pressBackspace(mod);
    if (name === "tab") return s.mockInput.pressTab(mod);
    if (name === "up" || name === "down" || name === "left" || name === "right")
      return s.mockInput.pressArrow(name, mod);
    s.mockInput.pressKey((NAMED[name] ?? name) as never, mod);
  };
  return Object.assign(s, {
    async press(...keys: string[]) {
      for (const k of keys) await settle(s, () => one(k));
    },
    async type(text: string) {
      await settle(s, () => s.mockInput.typeText(text));
    },
    frame: () => s.captureCharFrame(),
    close: () => act(async () => s.renderer.destroy()),
  });
}
