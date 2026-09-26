import { afterEach, describe, expect, it } from "bun:test";
import { useEffect, useState } from "react";
import { fixtureEffects } from "../../../src/entry/tui/fixtures.ts";
import { useApp, useDialogHandler } from "../../../src/entry/tui/providers/app.tsx";
import { DataProvider } from "../../../src/entry/tui/providers/data.tsx";
import { useCommandLayer } from "../../../src/entry/tui/providers/keymap.tsx";
import { defaultProfileDoc, type ProfilePatch } from "../../../src/domain/profile.ts";
import {
  type Action,
  type AppState,
  type Dialog,
  initialState,
  reduce,
} from "../../../src/entry/tui/state.ts";
import { DialogHost } from "../../../src/entry/tui/views/dialogs.tsx";
import { entriesOf, matchOptions } from "../../../src/entry/tui/widgets/dialog-select.tsx";
import { snapshotEnv, withHome } from "../../helpers.ts";
import { type Harness, harness, UI } from "./harness.tsx";
import { Shell } from "./shell.tsx";

afterEach(snapshotEnv());
let h: Harness | null = null;
afterEach(async () => {
  await h?.s.close();
  h = null;
});

const SELECT: Extract<Dialog, { kind: "select" }> = {
  kind: "select",
  purpose: { type: "profiles" },
  title: "Profiles",
  deletable: true,
  empty: "no profiles",
  suggested: ["cheap"],
  options: [
    { value: "default", title: "default", group: "Mine", current: true, detail: "active" },
    { value: "cheap", title: "cheap", group: "Mine" },
    { value: "fast", title: "fast", group: "Team" },
  ],
};

/** Opens `dialog`, records every answer, and closes on esc like the App does. */
function Host(props: { dialog: Dialog; answers: string[] }) {
  const app = useApp();
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (opened) return;
    setOpened(true);
    app.dispatch({ type: "open", dialog: props.dialog });
  }, [opened, app, props.dialog]);
  useCommandLayer("global", { "app.back": () => app.dispatch({ type: "close" }) });
  useDialogHandler(props.dialog.purpose.type, (_p, v) => void props.answers.push(v));
  return (
    <box flexDirection="column">
      <text>{`dialogs=${app.state.dialogs.length}`}</text>
      <DialogHost />
    </box>
  );
}

async function open(dialog: Dialog) {
  const answers: string[] = [];
  h = await harness(<Host dialog={dialog} answers={answers} />, { width: 80, height: 24 });
  return answers;
}

describe("DialogSelect", () => {
  it("matches every word against the title, group and detail", () => {
    expect(matchOptions(SELECT.options, "team").map((o) => o.value)).toEqual(["fast"]);
    expect(matchOptions(SELECT.options, "mine act").map((o) => o.value)).toEqual(["default"]);
    expect(entriesOf(SELECT, "").map((e) => e.key)).toEqual([
      "h:Suggested",
      "s:cheap",
      "h:Mine",
      "o:default",
      "o:cheap",
      "h:Team",
      "o:fast",
    ]);
    expect(entriesOf(SELECT, "fas").map((e) => e.key)).toEqual(["h:Team", "o:fast"]);
  });

  it("puts Suggested first, marks the current option, and moves with arrows and ctrl+n/ctrl+p", async () => {
    const answers = await open(SELECT);
    const f = h!.s.frame();
    expect(f.indexOf("Suggested")).toBeLessThan(f.indexOf("Mine"));
    expect(f).toContain("● default");
    await h!.s.press("ctrl+n", "down", "ctrl+p", "return");
    expect(answers).toEqual(["default"]);
  });

  it("gives the filter every letter, says when nothing matches, and esc closes", async () => {
    const answers = await open(SELECT);
    await h!.s.type("qjk?");
    expect(h!.s.frame()).toContain("No match");
    await h!.s.press("escape");
    expect(h!.s.frame()).toContain("dialogs=0");
    expect(answers).toEqual([]);
  });

  it("deletes on the second ctrl+d only, and says so on the row in between", async () => {
    const answers = await open(SELECT);
    await h!.s.press("ctrl+d");
    expect(h!.s.frame()).toContain("press ctrl+d again to delete");
    expect(answers).toEqual([]);
    await h!.s.press("ctrl+d");
    expect(answers).toEqual(["delete:cheap"]);
  });

  it("forgets a first ctrl+d when the cursor moves", async () => {
    const answers = await open(SELECT);
    await h!.s.press("ctrl+d", "down");
    expect(h!.s.frame()).not.toContain("again to delete");
    await h!.s.press("up", "ctrl+d");
    expect(answers).toEqual([]);
  });
});

describe("DialogConfirm", () => {
  const confirm = (destructive: boolean): Dialog => ({
    kind: "confirm",
    purpose: { type: "quit" },
    title: "Quit with unsaved changes?",
    message: ["2 unsaved changes will be lost."],
    yes: "Discard and quit",
    no: "Keep editing",
    destructive,
  });

  it("starts a destructive one on its no button: enter keeps working", async () => {
    const answers = await open(confirm(true));
    await h!.s.press("return");
    expect(answers).toEqual([]);
    expect(h!.s.frame()).toContain("dialogs=0");
  });

  it("answers yes from the yes button, reached with → or tab", async () => {
    const answers = await open(confirm(true));
    await h!.s.press("tab", "return");
    expect(answers).toEqual(["yes"]);
  });

  it("ignores every other key: no 'any other key cancels'", async () => {
    const answers = await open(confirm(false));
    await h!.s.press("y", "n", "q", "x");
    expect(h!.s.frame()).toContain("dialogs=1");
    expect(answers).toEqual([]);
  });
});

describe("DialogPrompt", () => {
  const prompt: Dialog = {
    kind: "prompt",
    purpose: { type: "new" },
    title: "New profile",
    label: "name",
    value: "",
    error: null,
  };

  it("takes every printable key as text and answers with it", async () => {
    const answers = await open(prompt);
    await h!.s.type("q?/jk 1");
    await h!.s.press("return");
    expect(answers).toEqual(["q?/jk 1"]);
  });

  it("keeps what was typed next to the reason it was refused", async () => {
    await open(prompt);
    await h!.s.type("Fast");
    await h!.run(() => h!.app().dispatch({ type: "invalid", error: "use lowercase letters" }));
    expect(h!.s.frame()).toContain("> Fast");
    expect(h!.s.frame()).toContain("use lowercase letters");
  });
});

describe("SaveDialog (spec §9.2)", () => {
  const dirty = (patch: ProfilePatch) =>
    [
      { type: "show", name: "default", doc: defaultProfileDoc() },
      { type: "edit", patch },
    ].reduce<AppState>((s, a) => reduce(s, a as Action), initialState());

  async function save(patch: ProfilePatch, effects = fixtureEffects()) {
    withHome();
    const answers: string[] = [];
    h = await harness(
      <DataProvider>
        <Host
          dialog={{ kind: "save", purpose: { type: "save", name: "default" }, error: null }}
          answers={answers}
        />
      </DataProvider>,
      {
        effects,
        state: dirty(patch),
        width: 100,
        height: 30,
      },
    );
    return answers;
  }

  it("shows each change, the agent files and what applies when, and saves from its first button", async () => {
    const answers = await save({ budget: { usd: 5 }, roles: { verifier: { enabled: false } } });
    const f = h!.s.frame();
    expect(f).toContain("budget.usd  none → 5");
    expect(f).toContain("roles.verifier.enabled  true → false");
    expect(f).toContain("- catherd-default-verifier-claude-opus-5-5-low");
    expect(f).toContain("Applies to: native Claude agents in new Claude Code sessions");
    expect(f).toContain("[ Save ]  [ Save & make active ]  [ Cancel ]");
    await h!.s.press("return");
    expect(answers).toEqual(["save"]);
  });

  it("answers activate from the second button, and cancels from the third", async () => {
    const answers = await save({ budget: { usd: 5 } });
    await h!.s.press("right", "return");
    expect(answers).toEqual(["activate"]);
    await h!.s.press("right", "right", "return");
    expect(h!.s.frame()).toContain("dialogs=0");
  });

  it("offers only Cancel while the draft has an error, and lists the error", async () => {
    const answers = await save({ roles: { worker: { enabled: false } } });
    expect(h!.s.frame()).toContain("✗ roles.worker.enabled: the worker cannot be disabled");
    expect(h!.s.frame()).not.toContain("[ Save ]");
    await h!.s.press("return");
    expect(answers).toEqual([]);
    expect(h!.s.frame()).toContain("dialogs=0");
  });

  it("says Save & make active binds the repo when the dashboard stands in a bound repo", async () => {
    await save({ budget: { usd: 5 } }, fixtureEffects({ repo: "/r", bindings: { "/r": "default" } }));
    expect(h!.s.frame()).toContain("Save & make active binds /r to default.");
    expect(h!.s.frame()).toContain("[ Save ]  [ Save & make active ]  [ Cancel ]");
  });

  it("says nothing of binding outside a bound repo", async () => {
    await save({ budget: { usd: 5 } });
    expect(h!.s.frame()).not.toContain("binds");
  });
});

function Underneath(props: { dialog: Dialog }) {
  const app = useApp();
  useEffect(() => {
    app.dispatch({ type: "open", dialog: props.dialog });
  }, [app.dispatch, props.dialog]);
  return <text>{"UNDERNEATH ".repeat(7)}</text>;
}

describe("Behind (spec §9.3 dialogs, research A5)", () => {
  const confirm: Dialog = {
    kind: "confirm",
    purpose: { type: "quit" },
    title: "Quit?",
    message: [],
    yes: "Quit",
    no: "Stay",
    destructive: true,
  };

  it("hides what a dialog opens over when there is no colour to paint the panel with", async () => {
    withHome();
    h = await harness(
      <Shell width={80} height={24}>
        <Underneath dialog={confirm} />
      </Shell>,
      { ui: { ...UI, color: false } },
    );
    expect(h.s.frame()).toContain("Quit?");
    expect(h.s.frame()).not.toContain("UNDERNEATH");
  });

  it("keeps it, dimmed around the raised panel, with colour", async () => {
    withHome();
    h = await harness(
      <Shell width={80} height={24}>
        <Underneath dialog={confirm} />
      </Shell>,
      { ui: { ...UI, color: true } },
    );
    expect(h.s.frame()).toContain("Quit?");
    expect(h.s.frame()).toContain("UNDERNEATH");
  });
});
