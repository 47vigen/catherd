import { describe, expect, it } from "bun:test";
import {
  COMMANDS,
  CONTEXTS,
  DEFAULT_KEYS,
  duplicateKeys,
  formatKey,
  formatKeys,
  isPrintable,
  keysIn,
  resolveKeybinds,
  SCOPES,
} from "../../../src/entry/tui/commands.ts";

describe("the command table (spec §9.2)", () => {
  it("gives every command a unique id, a title, a group and a known scope", () => {
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length);
    for (const c of COMMANDS) {
      expect(c.title.length).toBeGreaterThan(0);
      expect(c.group.length).toBeGreaterThan(0);
      expect(SCOPES).toContain(c.scope);
    }
  });

  it("never gives one key two meanings in any context that can be live", () => {
    expect(duplicateKeys(DEFAULT_KEYS)).toEqual([]);
  });

  it("binds the chords spec §9.2 names", () => {
    const k = (id: keyof typeof DEFAULT_KEYS) => DEFAULT_KEYS[id];
    expect(k("app.palette")).toContain("ctrl+p");
    for (const [id, n] of [
      ["tab.status", "1"],
      ["tab.profiles", "2"],
      ["tab.runs", "3"],
    ] as const)
      expect(k(id)).toEqual([n, `<leader>${n}`]);
    expect(k("profile.new")).toEqual(["<leader>n"]);
    expect(k("profile.list")).toEqual(["<leader>l"]);
    expect([k("edit.undo"), k("edit.redo")]).toEqual([["<leader>u"], ["<leader>r"]]);
    expect(k("app.quit")).toEqual(["q", "<leader>q"]);
    expect(k("profile.save")).toEqual(["ctrl+s"]);
    expect(k("app.back")).toEqual(["escape"]);
    expect(k("app.interrupt")).toEqual(["ctrl+c"]);
    expect(k("list.last")).toEqual(["end", "shift+g"]);
  });

  it("never lets enter save: return only opens, changes, chooses or keeps a filter", () => {
    const enter = COMMANDS.filter((c) => (c.keys as readonly string[]).includes("return")).map((c) => c.id);
    expect(enter.sort()).toEqual(["dialog.submit", "filter.accept", "runs.open", "status.open", "tree.open"]);
  });

  it("keeps printable keys out of every context where a text input has focus", () => {
    for (const ctx of CONTEXTS.filter((c) => c.typing))
      for (const [key, id] of keysIn(ctx, DEFAULT_KEYS))
        expect({ key, id, printable: isPrintable(key) }).toEqual({ key, id, printable: false });
  });
});

describe("keybinds from config.json", () => {
  it("replaces a command's keys, takes a list, and turns a command's keys off with none", () => {
    const k = resolveKeybinds({
      "profile.save": "ctrl+w",
      "list.down": ["down", "ctrl+n"],
      "app.help": "none",
    });
    expect(k["profile.save"]).toEqual(["ctrl+w"]);
    expect(k["list.down"]).toEqual(["down", "ctrl+n"]);
    expect(k["app.help"]).toEqual([]);
    expect(resolveKeybinds(undefined)).toEqual(DEFAULT_KEYS);
  });

  it("refuses an unknown id, a reserved command, a bad shape and a key that would mean two things", () => {
    for (const bad of [
      { "profile.saev": "ctrl+w" },
      { "app.interrupt": "ctrl+q" },
      { "profile.save": 5 },
      ["ctrl+s"],
      { "profile.activate": "ctrl+s" },
    ])
      expect(() => resolveKeybinds(bad)).toThrow(expect.objectContaining({ code: "E_CONFIG_KEYBIND" }));
  });
});

describe("formatKey", () => {
  it("reads as the footer and palette show it", () => {
    expect(formatKey("<leader>n")).toBe("ctrl+x n");
    expect(formatKey("return")).toBe("enter");
    expect(formatKey("escape")).toBe("esc");
    expect(formatKey("shift+g")).toBe("G");
    expect(formatKey("up")).toBe("↑");
    expect(formatKey("up", true)).toBe("up");
    expect(formatKeys(["ctrl+p", ":"])).toBe("ctrl+p/:");
    expect(formatKeys([])).toBe("");
  });
});
