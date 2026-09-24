import { createElement } from "react";
import { describe, expect, it, spyOn } from "bun:test";
import { isBare, mount } from "../../src/tui/commands.ts";

describe("tui commands", () => {
  it("treats only flag-only argv as the bare command", () => {
    expect(isBare([])).toBe(true);
    expect(isBare(["--plain", "--reduced-motion"])).toBe(true);
    expect(isBare(["watch"])).toBe(false);
    expect(isBare(["lock", "--", "pnpm", "test"])).toBe(false);
  });

  it("refuses a non-interactive stdin with one line instead of a raw-mode crash", async () => {
    const err = spyOn(console, "error").mockImplementation(() => {});
    expect(await mount(createElement("text", { content: "x" }), { isTTY: false })).toBe(1);
    expect(err.mock.calls[0]?.[0]).toMatch(/needs an interactive terminal/);
    err.mockRestore();
  });
});
