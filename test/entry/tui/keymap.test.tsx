import { afterEach, describe, expect, it } from "bun:test";
import type { InputRenderable } from "@opentui/core";
import { useRef, useState } from "react";
import { COMMANDS, DEFAULT_KEYS, isPrintable } from "../../../src/entry/tui/commands.ts";
import {
  type AppKeymap,
  AppKeymapProvider,
  reachableCommands,
  setModal,
  useCommandLayer,
  useKeymap,
} from "../../../src/entry/tui/providers/keymap.tsx";
import { mount, type Screen } from "./render.tsx";

let calls: string[] = [];
let screen: Screen | null = null;
afterEach(async () => {
  await screen?.close();
  screen = null;
  calls = [];
});

const log = (id: string) => () => void calls.push(id);

function Probe(props: { expose: (x: { keymap: AppKeymap; focus: () => void; blur: () => void }) => void }) {
  const keymap = useKeymap();
  const input = useRef<InputRenderable>(null);
  const [value, setValue] = useState("");
  useCommandLayer("global", { "app.interrupt": log("app.interrupt"), "app.back": log("app.back") });
  useCommandLayer("app", {
    "app.palette": log("app.palette"),
    "app.help": log("app.help"),
    "app.quit": log("app.quit"),
    "tab.runs": log("tab.runs"),
    "profile.new": log("profile.new"),
  });
  useCommandLayer("list", { "list.down": log("list.down"), "list.last": log("list.last") });
  useCommandLayer("row.profiles", { "tree.toggle": log("tree.toggle"), "tree.open": log("tree.open") });
  useCommandLayer("filter", { "filter.accept": log("filter.accept") });
  useCommandLayer("dialog", { "dialog.up": log("dialog.up"), "dialog.submit": log("dialog.submit") });
  props.expose({ keymap, focus: () => input.current?.focus(), blur: () => input.current?.blur() });
  return (
    <box flexDirection="column">
      <input ref={input} value={value} onInput={setValue} width={60} />
      <text>{`value=${value}`}</text>
    </box>
  );
}

async function setup() {
  let x!: { keymap: AppKeymap; focus: () => void; blur: () => void };
  screen = await mount(
    <AppKeymapProvider keybinds={DEFAULT_KEYS}>
      <Probe expose={(e) => (x = e)} />
    </AppKeymapProvider>,
    { width: 70, height: 4 },
  );
  return { s: screen, ...x };
}

describe("the keymap (spec §9.2)", () => {
  it("runs bare letters, chords and the ctrl+x leader when no input has focus", async () => {
    const { s } = await setup();
    await s.press(
      "q",
      "?",
      "ctrl+p",
      ":",
      "3",
      "j",
      "shift+g",
      "space",
      "return",
      "ctrl+x",
      "n",
      "ctrl+x",
      "3",
    );
    expect(calls).toEqual([
      "app.quit",
      "app.help",
      "app.palette",
      "app.palette",
      "tab.runs",
      "list.down",
      "list.last",
      "tree.toggle",
      "tree.open",
      "profile.new",
      "tab.runs",
    ]);
  });

  it("gives a focused input every printable key bound anywhere, as text", async () => {
    const { s, focus } = await setup();
    focus();
    await s.flush();
    const printable = [
      ...new Set(COMMANDS.flatMap((c) => DEFAULT_KEYS[c.id]).filter((k) => isPrintable(k) && k !== "space")),
    ];
    const text = printable.map((k) => (k.startsWith("shift+") ? k.slice(-1).toUpperCase() : k)).join("");
    await s.type(`${text} x`);
    expect(s.frame()).toContain(`value=${text} x`);
    expect(calls).toEqual([]);
  });

  it("keeps row keys off and the filter's keys on while an input has focus", async () => {
    const { s, focus, blur } = await setup();
    focus();
    await s.flush();
    await s.press("return", "ctrl+p", "ctrl+c");
    blur();
    await s.flush();
    await s.press("return");
    expect(calls).toEqual(["filter.accept", "app.palette", "app.interrupt", "tree.open"]);
  });

  it("in modal mode runs only dialog and global keys", async () => {
    const { s, keymap } = await setup();
    setModal(keymap, true);
    await s.press("q", "3", "j", "up", "ctrl+p", "return", "escape", "ctrl+c");
    setModal(keymap, false);
    await s.press("ctrl+p");
    expect(calls).toEqual([
      "dialog.up",
      "dialog.up",
      "dialog.submit",
      "app.back",
      "app.interrupt",
      "app.palette",
    ]);
  });

  it("lists the reachable commands with their palette fields", async () => {
    const { keymap } = await setup();
    const byId = new Map(reachableCommands(keymap).map((c) => [c.id, c]));
    expect(byId.get("app.quit")).toMatchObject({ title: "Quit", group: "App", palette: true });
    expect(byId.get("profile.new")).toMatchObject({ suggested: true, cli: "catherd profile new <name>" });
    expect(byId.get("app.palette")?.palette).toBe(false);
    expect(byId.has("dialog.submit")).toBe(false);
    expect(keymap.dispatchCommand("tab.runs").ok).toBe(true);
    expect(calls).toEqual(["tab.runs"]);
  });
});
