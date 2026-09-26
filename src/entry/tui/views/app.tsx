import { useTerminalDimensions } from "@opentui/react";
import { type CommandId, formatKeys } from "../commands.ts";
import { hereWord } from "../effects.ts";
import { useApp, useDialogHandler } from "../providers/app.tsx";
import { DataProvider, useData } from "../providers/data.tsx";
import { reachableCommands, useCommandLayer, useKeybinds, useKeymap } from "../providers/keymap.tsx";
import { useUi } from "../providers/theme.tsx";
import { currentDraft, isArmed, TABS, totalDirty } from "../state.ts";
import type { Mood } from "../theme.ts";
import { Footer, Header, Tabs } from "../widgets/chrome.tsx";
import { Rule } from "../widgets/line.tsx";
import { Spinner, useDelayedPresence } from "../widgets/spinner.tsx";
import { ToastHost } from "../widgets/toast.tsx";
import { Behind, DialogHost } from "./dialogs.tsx";
import { playStory, STORIES } from "../stories.ts";
import { openNewProfile, openProfileList, useProfileDialogs } from "./profile-actions.ts";
import { ProfilesView } from "./profiles.tsx";
import { RunsView } from "./runs.tsx";
import { StatusView } from "./status.tsx";

/** Rows the chrome takes at any size: header, tabs, rule, rule, footer (spec §9.3: 19 of 24 rows left). */
export const CHROME_ROWS = 5;

/** The palette's and help's rows, read from the commands a key could reach before the dialog opens. */
function useCommandDialogs() {
  const app = useApp();
  const keymap = useKeymap();
  const keys = useKeybinds();
  const ui = useUi();
  const open = (kind: "palette" | "help") => {
    const entries = reachableCommands(keymap).filter((c) =>
      kind === "palette" ? c.palette : keys[c.id].length > 0 && !c.id.startsWith("dialog."),
    );
    app.dispatch({
      type: "open",
      dialog: {
        kind: "select",
        purpose: { type: kind },
        title: kind === "palette" ? "Commands" : "Keyboard shortcuts",
        empty: "no commands",
        suggested: kind === "palette" ? entries.filter((c) => c.suggested).map((c) => c.id) : [],
        options: entries.map((c) => ({
          value: c.id,
          title: c.title,
          group: c.group,
          detail: [formatKeys(keys[c.id as CommandId], ui.plain), kind === "palette" ? c.cli : null]
            .filter(Boolean)
            .join("  "),
        })),
      },
    });
  };
  const run = (_p: unknown, id: string) => {
    app.dispatch({ type: "close" });
    keymap.dispatchCommand(id);
  };
  useDialogHandler("palette", run);
  useDialogHandler("help", run);
  return open;
}

/** The storybook's picker (CATHERD_STORY=1): a story plays from a clean state. */
function useStories(on: boolean) {
  const app = useApp();
  const keymap = useKeymap();
  useDialogHandler("stories", (_p, name) => {
    app.dispatch({ type: "close" });
    const story = STORIES.find((s) => s.name === name);
    if (story) void playStory(story, app, keymap, () => new Promise((r) => app.clock.setTimeout(r, 50)));
  });
  return on
    ? () =>
        app.dispatch({
          type: "open",
          dialog: {
            kind: "select",
            purpose: { type: "stories" },
            title: "Stories",
            empty: "no stories",
            options: STORIES.map((s) => ({ value: s.name, title: s.title, detail: s.name })),
          },
        })
    : null;
}

function Screen(props: { story: boolean }) {
  const app = useApp();
  const data = useData();
  const dims = useTerminalDimensions();
  const openCommands = useCommandDialogs();
  const openStories = useStories(props.story);
  useProfileDialogs();
  const { state } = app;
  const dirty = totalDirty(state);
  const quit = () => {
    const dirty = totalDirty(app.getState());
    if (dirty === 0) return app.exit(0);
    app.dispatch({
      type: "open",
      dialog: {
        kind: "confirm",
        purpose: { type: "quit" },
        title: "Quit with unsaved changes?",
        message: [`${dirty} unsaved change${dirty === 1 ? "" : "s"} will be lost.`],
        yes: "Discard and quit",
        no: "Keep editing",
        destructive: true,
      },
    });
  };
  useDialogHandler("quit", () => app.exit(0));
  const go = (by: number) => {
    const tab = app.getState().tab;
    app.dispatch({
      type: "tab",
      tab: TABS[(TABS.indexOf(tab) + by + TABS.length) % TABS.length] ?? "status",
    });
  };
  useCommandLayer("global", {
    // spec §9.2 ctrl+c: close a dialog, else clear a text input, else quit when clean; when dirty a second
    // press within 1.5 s discards and exits 130
    "app.interrupt": () => {
      const state = app.getState();
      const dirty = totalDirty(state);
      if (state.dialogs.length) return app.dispatch({ type: "close" });
      if (app.back("input")) return;
      if (dirty === 0) return app.exit(0);
      const now = app.clock.now();
      if (isArmed(state, "interrupt", "app", now)) return app.exit(130);
      app.dispatch({ type: "arm", what: "interrupt", target: "app", at: now });
      app.toast({
        variant: "warning",
        message: `${dirty} unsaved change(s): ctrl+c again to discard and quit`,
      });
    },
    // esc backs out one level and never quits; an armed double press is a level of its own
    "app.back": () => {
      const state = app.getState();
      const a = state.armed;
      if (a) app.dispatch({ type: "disarm" });
      if (a && isArmed(state, a.what, a.target, app.clock.now())) return;
      if (state.dialogs.length) return app.dispatch({ type: "close" });
      app.back();
    },
  });
  useCommandLayer("app", {
    "app.palette": () => openCommands("palette"),
    "app.help": () => openCommands("help"),
    "app.quit": quit,
    "tab.status": () => app.dispatch({ type: "tab", tab: "status" }),
    "tab.profiles": () => app.dispatch({ type: "tab", tab: "profiles" }),
    "tab.runs": () => app.dispatch({ type: "tab", tab: "runs" }),
    "tab.next": () => go(1),
    "tab.prev": () => go(-1),
    "profile.new": () => openNewProfile(app),
    "profile.list": () => openProfileList(app, data),
    ...(openStories ? { "app.stories": openStories } : {}),
  });
  const checking = useDelayedPresence(data.checking);
  const live = (data.runs.value?.rows ?? []).some((r) => r.live > 0);
  const mood: Mood = data.report && !data.report.ready ? "failed" : live ? "working" : "good";
  const draft = currentDraft(state);
  const shown = draft?.name ?? data.profiles.value?.here ?? null;
  const height = Math.max(1, dims.height - CHROME_ROWS);
  const w = dims.width;
  return (
    <box flexDirection="column" width={w} height={dims.height}>
      <box flexDirection="row" width={w} height={1}>
        <Header
          version={app.effects.version}
          profile={shown}
          active={shown !== null && shown === data.profiles.value?.here}
          label={hereWord(data.profiles.value ?? { repo: null })}
          dirty={dirty}
          mood={mood}
          width={checking ? w - 18 : w}
        />
        {checking ? (
          <box width={18}>
            <Spinner label="checking setup" />
          </box>
        ) : null}
      </box>
      <Tabs tab={state.tab} width={w} />
      <Rule width={w} />
      <Behind width={w} height={height}>
        {state.tab === "status" ? <StatusView width={w} height={height} /> : null}
        {state.tab === "profiles" ? <ProfilesView width={w} height={height} /> : null}
        {state.tab === "runs" ? <RunsView width={w} height={height} /> : null}
      </Behind>
      <Rule width={w} />
      <Footer width={w} />
      <DialogHost />
      <ToastHost />
    </box>
  );
}

/** Spec §9: one app, three tabs, dialogs and toasts over them. Must sit inside `Providers`. */
export function App(props: { story?: boolean }) {
  return (
    <DataProvider>
      <Screen story={props.story === true} />
    </DataProvider>
  );
}
