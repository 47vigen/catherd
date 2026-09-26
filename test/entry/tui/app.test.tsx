import { afterEach, describe, expect, it } from "bun:test";
import { COMMANDS, DEFAULT_KEYS, isPrintable, resolveKeybinds } from "../../../src/entry/tui/commands.ts";
import { fixtureEffects } from "../../../src/entry/tui/fixtures.ts";
import { ARM_MS } from "../../../src/entry/tui/state.ts";
import { App } from "../../../src/entry/tui/views/app.tsx";
import { CatherdError } from "../../../src/domain/errors.ts";
import { useApp } from "../../../src/entry/tui/providers/app.tsx";
import { snapshotEnv, withHome } from "../../helpers.ts";
import { type Harness, harness } from "./harness.tsx";

afterEach(snapshotEnv());
let h: Harness | null = null;
afterEach(async () => {
  await h?.s.close();
  h = null;
});

async function app(o: Parameters<typeof harness>[1] = {}) {
  withHome();
  const effects = o.effects ?? fixtureEffects();
  h = await harness(<App />, { ...o, effects });
  await h.advance(1);
  return { h, writes: (effects as ReturnType<typeof fixtureEffects>).writes };
}

const tabLine = () => h?.s.frame().split("\n")[3] ?? "";

describe("tabs and leaving (spec §9.2)", () => {
  it("switches tabs with 1-3, the leader and [ ]", async () => {
    await app();
    await h!.s.press("2");
    expect(tabLine()).toContain("PROFILE default");
    await h!.s.press("ctrl+x", "3");
    expect(tabLine()).toContain("RUNS");
    await h!.s.press("[", "[");
    expect(tabLine()).toContain("SETUP");
  });

  it("backs out with esc and never quits with it", async () => {
    await app();
    await h!.s.press("3", "return");
    expect(tabLine()).toContain("Jobs screen");
    await h!.s.press("escape");
    expect(tabLine()).toContain("RUNS");
    await h!.s.press("escape", "escape");
    expect(h!.exits).toEqual([]);
  });

  it("takes back an armed double press with esc, and backs out only on the next esc", async () => {
    const effects = fixtureEffects();
    effects.create("cheap");
    await app({ effects });
    await h!.s.press("ctrl+x", "l", "down", "ctrl+d");
    expect(h!.s.frame()).toContain("press ctrl+d again to delete");
    await h!.s.press("escape");
    expect(h!.app().getState().armed).toBeNull();
    expect(h!.app().getState().dialogs).toHaveLength(1);
    expect(h!.s.frame()).not.toContain("press ctrl+d again to delete");
    await h!.s.press("escape");
    expect(h!.app().getState().dialogs).toHaveLength(0);
  });

  it("quits with q, or ctrl+c, when nothing is unsaved", async () => {
    await app();
    await h!.s.press("q");
    expect(h!.exits.map((e) => e.code)).toEqual([0]);
    await h!.s.close();
    await app();
    await h!.s.press("ctrl+c");
    expect(h!.exits.map((e) => e.code)).toEqual([0]);
  });

  it("asks before q discards unsaved changes, defaulting to keep editing", async () => {
    await app();
    await h!.s.press("2", "j", "space", "q");
    expect(h!.s.frame()).toContain("Quit with unsaved changes?");
    await h!.s.press("return");
    expect(h!.exits).toEqual([]);
    await h!.s.press("q", "right", "return");
    expect(h!.exits.map((e) => e.code)).toEqual([0]);
  });

  it("with unsaved changes, ctrl+c twice within 1.5 s discards and exits 130; slower presses do not", async () => {
    await app();
    await h!.s.press("2", "j", "space", "ctrl+c");
    expect(h!.exits).toEqual([]);
    expect(h!.s.frame()).toContain("ctrl+c again to discard");
    await h!.advance(ARM_MS.interrupt + 1);
    await h!.s.press("ctrl+c");
    expect(h!.exits).toEqual([]);
    await h!.advance(500);
    await h!.s.press("ctrl+c");
    expect(h!.exits.map((e) => e.code)).toEqual([130]);
  });
});

describe("staged edits (spec §9.2: enter never saves)", () => {
  it("stages a toggle, counts it in the header, and writes nothing until the save dialog", async () => {
    const { writes } = await app();
    await h!.s.press("2", "j", "space", "return", "return");
    expect(h!.s.frame().split("\n")[0]).toContain("unsaved");
    expect(writes).toEqual([]);
    await h!.s.press("ctrl+s");
    expect(h!.s.frame()).toContain("Save profile default");
    expect(h!.s.frame()).toContain("roles.verifier.enabled");
    await h!.s.press("return");
    expect(writes).toEqual(['save default {"roles":{"verifier":{"enabled":false}}}']);
    expect(h!.s.frame().split("\n")[0]).not.toContain("unsaved");
  });

  it("saves and makes active from the dialog's second button, and keeps the session note for after exit", async () => {
    const effects = fixtureEffects();
    effects.create("cheap");
    await app({ effects });
    await h!.s.press("ctrl+x", "l");
    await h!.s.type("cheap");
    await h!.s.press("return", "j", "space", "ctrl+s", "right", "return");
    expect(effects.writes.slice(1)).toEqual([
      'save cheap {"roles":{"verifier":{"enabled":false}}}',
      "activate cheap",
    ]);
    await h!.s.press("q");
    expect(h!.exits[0]?.kept).toEqual([
      "catherd: start a new Claude Code session to use: catherd-cheap-architect-claude-opus-5-5-high",
    ]);
  });

  it("inside a bound repo, Save & make active binds it", async () => {
    const effects = fixtureEffects({ repo: "/r", bindings: { "/r": "default" } });
    effects.create("cheap");
    await app({ effects });
    await h!.s.press("ctrl+x", "l");
    await h!.s.type("cheap");
    await h!.s.press("return", "j", "space", "ctrl+s", "right", "return");
    expect(effects.writes.at(-1)).toBe("bind cheap /r");
    expect(h!.s.frame().split("\n")[0]).toContain("(this repo)");
  });

  it("undoes and redoes with the leader", async () => {
    await app();
    await h!.s.press("2", "j", "space");
    expect(h!.s.frame()).toContain("1 unsaved");
    await h!.s.press("ctrl+x", "u");
    expect(h!.s.frame()).not.toContain("unsaved");
    await h!.s.press("ctrl+x", "r");
    expect(h!.s.frame()).toContain("1 unsaved");
  });

  it("says there is nothing to save instead of opening an empty dialog", async () => {
    await app();
    await h!.s.press("2", "ctrl+s");
    expect(h!.s.frame()).toContain("No unsaved changes");
  });
});

describe("the command palette (spec §9.2)", () => {
  it("runs a command from the palette, which lists its key and CLI twin", async () => {
    await app();
    await h!.s.press("ctrl+p");
    expect(h!.s.frame()).toContain("catherd profile new <name>");
    await h!.s.type("go to runs");
    await h!.s.press("return");
    expect(tabLine()).toContain("RUNS");
  });
});

describe("the palette and help at 80x24 (P1)", () => {
  /** the option rows (indented under their group), and where each one's second column starts */
  const options = () => {
    const lines = h!.s.frame().split("\n");
    const margin = lines.find((l) => l.includes("> "))?.indexOf(">") ?? 0;
    const rows = lines.filter((l) => new RegExp(`^ {${margin + 2}}\\S`).test(l));
    const second = new Set(rows.map((l) => /^( *\S.*?\S {2,})\S/.exec(l)?.[1]?.length));
    return { rows, second };
  };

  it("fills the dialog's rows and lines up the key and CLI columns in the palette", async () => {
    await app();
    await h!.s.press("ctrl+p");
    const { rows, second } = options();
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(second.size).toBe(1);
    // the CLI twins start in one column too, in full
    const cli = new Set(rows.flatMap((l) => (l.includes("catherd ") ? [l.indexOf("catherd ")] : [])));
    expect(cli.size).toBe(1);
    expect(h!.s.frame()).toContain("catherd profile new <name>");
  });

  it("fills the dialog's rows and lines up the key column in help", async () => {
    await app();
    await h!.s.press("?");
    const { rows, second } = options();
    expect(rows.length).toBeGreaterThanOrEqual(7);
    expect(second.size).toBe(1);
  });
});

describe("keys that land in one tick (Review Focus 2)", () => {
  it("runs the command typed into the palette in the same tick as ctrl+p and enter", async () => {
    await app();
    await h!.s.burst("ctrl+p", "quit", "return");
    expect(h!.exits.map((e) => e.code)).toEqual([0]);
  });

  it("gives the palette opened with : the letter typed right after it", async () => {
    await app();
    await h!.s.burst(":", "q");
    expect(h!.s.frame()).toContain("> q ");
    expect(h!.s.frame()).toContain("Quit");
    expect(h!.exits).toEqual([]);
  });
});

describe("text inputs own printable keys (spec §9.2)", () => {
  const printable = [
    ...new Set(COMMANDS.flatMap((c) => DEFAULT_KEYS[c.id]).filter((k) => isPrintable(k) && k !== "space")),
  ].map((k) => (k.startsWith("shift+") ? k.slice(-1).toUpperCase() : k));
  const text = printable.join("");

  it.each([
    ["the tree's filter", ["2", "/"]],
    ["the palette's filter", ["ctrl+p"]],
    ["the new-profile prompt", ["ctrl+x", "n"]],
  ])("%s gets every bound letter as text, and nothing runs", async (_name, open) => {
    await app();
    await h!.s.press(...open);
    await h!.s.type(text);
    expect(h!.s.frame()).toContain(text.slice(0, 20));
    expect(h!.exits).toEqual([]);
  });
});

describe("an error while drawing", () => {
  function Boom(): never {
    throw new CatherdError("E_CONFIG_INVALID", "catalog.override.json is not valid JSON", {
      fix: "catherd catalog refresh",
    });
  }

  it("shows the error with its fix and quits with ctrl+c, printing it after exit", async () => {
    withHome();
    h = await harness(<Boom />);
    expect(h.s.frame()).toContain("catalog.override.json is not valid JSON");
    expect(h.s.frame()).toContain("fix: catherd catalog refresh");
    expect(h.s.frame()).toContain("press q or ctrl+c to quit");
    await h.s.press("ctrl+c");
    expect(h.exits).toEqual([
      {
        code: 1,
        kept: ["catherd: catalog.override.json is not valid JSON", "fix: catherd catalog refresh"],
      },
    ]);
  });

  /** throws as soon as a dialog opens */
  function BoomOnDialog() {
    if (useApp().state.dialogs.length) throw new Error("the dialog broke");
    return null;
  }

  it("quits with q too, when it broke with a dialog open", async () => {
    withHome();
    h = await harness(
      <>
        <App />
        <BoomOnDialog />
      </>,
      { effects: fixtureEffects() },
    );
    await h.s.press("ctrl+p");
    expect(h.s.frame()).toContain("the dialog broke");
    await h!.s.press("q");
    expect(h!.exits.map((e) => e.code)).toEqual([1]);
  });
});

describe("keybinds (spec §9.2 configurable)", () => {
  it("runs and shows a rebound key", async () => {
    await app({ keybinds: resolveKeybinds({ "profile.save": "ctrl+w" }) });
    await h!.s.press("2", "j", "space");
    expect(h!.s.frame()).toContain("ctrl+w save");
    await h!.s.press("ctrl+w");
    expect(h!.s.frame()).toContain("Save profile default");
  });
});
