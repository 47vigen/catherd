import { type CliRenderer, createCliRenderer, SystemClock } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { gitToplevel } from "../../infra/git.ts";
import { readConfig } from "../../services/profile-store.ts";
import { CatherdError } from "../../domain/errors.ts";
import { EXIT, printError } from "../cli-kit.ts";
import { type Keybinds, resolveKeybinds } from "./commands.ts";
import type { Effects } from "./effects.ts";
import { liveEffects } from "./effects.ts";
import { fixtureEffects } from "./fixtures.ts";
import { createAppKeymap } from "./providers/keymap.tsx";
import { Providers } from "./providers/root.tsx";
import { initialState, type Tab } from "./state.ts";
import { detectUi, type ThemeMode } from "./theme.ts";
import { App } from "./views/app.tsx";

export interface TuiOptions {
  rawArgs: string[];
  tab?: Tab;
  env?: Record<string, string | undefined>;
  /** Whether stdin and stdout are a terminal; tests pass it so none reads the real one. */
  tty?: boolean;
}

/** The keys in force: the defaults under config.json's `keybinds` (E_CONFIG_KEYBIND before anything draws). */
export const keybindsFromConfig = (): Keybinds =>
  resolveKeybinds((readConfig() as { keybinds?: unknown }).keybinds);

/** The terminal's own background decides dark or light, else dark (spec §9.3). */
async function modeOf(renderer: CliRenderer): Promise<ThemeMode> {
  return renderer.themeMode ?? (await renderer.waitForThemeMode(1000)) ?? "dark";
}

/**
 * Spec §9.4's renderer: no mouse capture, `exitOnCtrlC: false` (ctrl+c is the app's to layer), the
 * alternate screen for the app only; the lines the user must keep print to stdout once it is gone.
 * Resolves to the exit code: 0, or 130 when unsaved changes were discarded with ctrl+c.
 */
export async function openTui(o: TuiOptions): Promise<number> {
  const env = o.env ?? process.env;
  const tty = o.tty ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!tty) {
    printError(
      new CatherdError("E_INPUT_INVALID", "the dashboard needs an interactive terminal", {
        fix: "in a script, run catherd status, catherd doctor or catherd watch --once",
      }),
    );
    return EXIT.usage;
  }
  const keybinds = keybindsFromConfig();
  const story = Boolean(env.CATHERD_STORY);
  // the repo this directory is in, resolved once at start (the repo ruling)
  const effects: Effects = story ? fixtureEffects() : liveEffects(await gitToplevel(process.cwd()));
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    useMouse: false,
    autoFocus: false,
    screenMode: "alternate-screen",
    // the kitty protocol tells esc from alt+key at once; CATHERD_NO_KITTY=1 turns it off where it misbehaves
    useKittyKeyboard: env.CATHERD_NO_KITTY ? null : {},
    targetFps: 30,
  });
  let result = { code: EXIT.ok as number, kept: [] as string[] };
  const done = new Promise<void>((resolve) => renderer.once("destroy", () => resolve()));
  // anything that throws once the renderer exists gives the terminal back before the error surfaces
  try {
    const ui = { ...detectUi(o.rawArgs, env), mode: await modeOf(renderer) };
    renderer.setTerminalTitle(story ? "catherd stories" : "catherd");
    createRoot(renderer).render(
      <Providers
        ui={ui}
        keybinds={keybinds}
        keymap={createAppKeymap(renderer)}
        effects={effects}
        clock={new SystemClock()}
        initial={initialState(o.tab ?? "status")}
        copy={(text) => renderer.copyToClipboardOSC52(text)}
        onExit={(code, kept) => {
          result = { code, kept };
          renderer.destroy();
        }}
      >
        <App story={story} />
      </Providers>,
    );
  } catch (e) {
    renderer.destroy();
    throw e;
  }
  await done;
  for (const line of result.kept) console.log(line);
  return result.code;
}

/** Bare `catherd`: `cli.ts` imports this only when no subcommand was named, so no subcommand loads OpenTUI. */
export async function tuiRun(ctx: { rawArgs: string[] }): Promise<void> {
  process.exitCode = await openTui({ rawArgs: ctx.rawArgs });
}
