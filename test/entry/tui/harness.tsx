import { ManualClock } from "@opentui/core/testing";
import type { ReactNode } from "react";
import { DEFAULT_KEYS, type Keybinds } from "../../../src/entry/tui/commands.ts";
import type { Effects } from "../../../src/entry/tui/effects.ts";
import { fixtureEffects } from "../../../src/entry/tui/fixtures.ts";
import { type AppApi, useApp } from "../../../src/entry/tui/providers/app.tsx";
import { type AppKeymap, useKeymap } from "../../../src/entry/tui/providers/keymap.tsx";
import { Providers } from "../../../src/entry/tui/providers/root.tsx";
import { type AppState, initialState } from "../../../src/entry/tui/state.ts";
import type { Ui } from "../../../src/entry/tui/theme.ts";
import { mount, type Screen, settle } from "./render.tsx";

/** Colourless, still and Unicode: frames are plain text, identical on every run. */
export const UI: Ui = { plain: false, color: false, reducedMotion: true, mode: "dark" };
export const PLAIN: Ui = { ...UI, plain: true };

export interface Harness {
  s: Screen;
  clock: ManualClock;
  app: () => AppApi;
  exits: { code: number; kept: string[] }[];
  copied: string[];
  /** advances the fake clock and flushes what it set off */
  advance(ms: number): Promise<void>;
  /** runs `f` (a story, a dispatch) inside act() and draws */
  run(f: () => unknown): Promise<void>;
  keymap: () => AppKeymap;
}

function Expose(props: { set: (a: AppApi, k: AppKeymap) => void }) {
  props.set(useApp(), useKeymap());
  return null;
}

/**
 * Mounts `node` inside every provider, on a fake clock at 2026-09-26 12:00 UTC. Every key and every
 * typed text also runs the timers due now, so data a view reads on a 0 ms timer is there to assert on.
 */
export async function harness(
  node: ReactNode,
  o: {
    ui?: Ui;
    effects?: Effects;
    state?: AppState;
    keybinds?: Keybinds;
    width?: number;
    height?: number;
  } = {},
): Promise<Harness> {
  const clock = new ManualClock();
  clock.setTime(Date.parse("2026-09-26T12:00:00.000Z"));
  const exits: Harness["exits"] = [];
  const copied: string[] = [];
  let api!: AppApi;
  let keymap!: AppKeymap;
  const s = await mount(
    <Providers
      ui={o.ui ?? UI}
      keybinds={o.keybinds ?? DEFAULT_KEYS}
      effects={o.effects ?? fixtureEffects()}
      clock={clock}
      initial={o.state ?? initialState()}
      copy={(t) => {
        copied.push(t);
        return true;
      }}
      onExit={(code, kept) => exits.push({ code, kept: [...kept] })}
    >
      <Expose
        set={(a, k) => {
          api = a;
          keymap = k;
        }}
      />
      {node}
    </Providers>,
    { width: o.width ?? 80, height: o.height ?? 24 },
  );
  // a key often opens a view that reads its data on a 0 ms timer: run those, and what they set off, too
  const idle = async () => {
    for (let i = 0; i < 3; i++) await settle(s, () => clock.advance(0));
  };
  const press = s.press;
  const type = s.type;
  const burst = s.burst;
  s.press = async (...keys: string[]) => {
    for (const k of keys) {
      await press(k);
      await idle();
    }
  };
  s.type = async (text: string) => {
    await type(text);
    await idle();
  };
  s.burst = async (...keys: string[]) => {
    await burst(...keys);
    await idle();
  };
  const h: Harness = {
    s,
    clock,
    app: () => api,
    keymap: () => keymap,
    exits,
    copied,
    async advance(ms) {
      await settle(s, () => clock.advance(ms));
    },
    run: (f) => settle(s, f),
  };
  await h.advance(1);
  return h;
}
