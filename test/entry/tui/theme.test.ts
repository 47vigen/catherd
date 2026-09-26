import { describe, expect, it } from "bun:test";
import {
  detectUi,
  FACES,
  GLYPH_NAMES,
  glyph,
  mascot,
  PALETTES,
  paint,
  SPINNER,
  TOKENS,
} from "../../../src/entry/tui/theme.ts";
import {
  ago,
  ascii,
  clock,
  fit,
  padEnd,
  shortRung,
  truncateEnd,
  width,
  wrap,
} from "../../../src/entry/tui/text.ts";

const printable = /^[\x20-\x7e]*$/;

function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("the theme (spec §9.3)", () => {
  it("has the 16 tokens, in both modes, as hex", () => {
    expect(TOKENS).toHaveLength(16);
    for (const mode of ["dark", "light"] as const)
      for (const t of TOKENS) expect(PALETTES[mode][t]).toMatch(/^#[0-9A-F]{6}$/);
    expect([PALETTES.dark.accent, PALETTES.light.accent]).toEqual(["#E8833A", "#B45309"]);
  });

  it("keeps every colour that carries text at 4.5:1 on both surfaces", () => {
    for (const mode of ["dark", "light"] as const) {
      const p = PALETTES[mode];
      for (const t of [
        "text",
        "muted",
        "accent",
        "success",
        "warning",
        "error",
        "info",
        "diffAdd",
        "diffDel",
      ] as const)
        for (const bg of [p.surface, p.surfaceRaised]) expect(contrast(p[t], bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.selectionText, p.selection)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(PALETTES.light.accent, "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
  });

  it("reads the terminal from the arguments and environment it is given, never the real terminal", () => {
    const utf = { LANG: "en_US.UTF-8", TERM: "xterm-256color" };
    expect(detectUi([], utf)).toEqual({ plain: false, color: true, reducedMotion: false });
    expect(detectUi([], {})).toEqual({ plain: false, color: true, reducedMotion: false });
    expect(detectUi([], { ...utf, NO_COLOR: "1" })).toMatchObject({ plain: false, color: false });
    expect(detectUi([], { ...utf, NO_COLOR: "" }).color).toBe(true);
    expect(detectUi(["--plain"], utf)).toMatchObject({ plain: true, color: false });
    expect(detectUi([], { TERM: "dumb" })).toMatchObject({ plain: true, color: false });
    expect(detectUi([], { TERM: "linux" })).toMatchObject({ plain: true, color: true });
    expect(detectUi([], { LANG: "C" }).plain).toBe(true);
    expect(detectUi([], { LANG: "C", LC_ALL: "en_GB.utf8" }).plain).toBe(false);
    expect(detectUi(["--reduced-motion"], utf).reducedMotion).toBe(true);
    expect(detectUi([], { ...utf, CATHERD_REDUCED_MOTION: "1" }).reducedMotion).toBe(true);
  });

  it("paints nothing without colour", () => {
    const ui = { plain: false, color: false, reducedMotion: false, mode: "dark" as const };
    expect(paint(ui, "accent")).toBeUndefined();
    expect(paint({ ...ui, color: true, mode: "light" }, "accent")).toBe("#B45309");
  });

  it("has an ASCII fallback for every glyph, face and the mascot", () => {
    for (const g of GLYPH_NAMES) expect(glyph(g, true)).toMatch(printable);
    for (const f of Object.values(FACES)) expect(f).toMatch(printable);
    for (const l of mascot("good")) expect(l).toMatch(printable);
    for (const f of SPINNER.plainFrames) expect(f).toMatch(printable);
    expect(glyph("on", false)).toBe("[x]");
    expect(glyph("ok", true)).toBe("+");
  });

  it("spins at 80 ms, shows after 500 ms and holds for 3 s", () => {
    expect([SPINNER.ms, SPINNER.showAfterMs, SPINNER.minShowMs, SPINNER.frames.length]).toEqual([
      80, 500, 3000, 10,
    ]);
  });
});

describe("text", () => {
  it("truncates at the end only, to the exact width", () => {
    expect(truncateEnd("codex not logged in", 10)).toBe("codex not…");
    expect(truncateEnd("codex not logged in", 10, true)).toBe("codex n...");
    expect(truncateEnd("short", 10)).toBe("short");
    expect(width(truncateEnd("日本語のテキスト", 7))).toBeLessThanOrEqual(7);
  });

  it("wraps ids and commands without losing a character", () => {
    const cmd = "claude plugin marketplace add 47vigen/catherd && claude plugin install catherd@catherd";
    const lines = wrap(cmd, 30);
    for (const l of lines) expect(width(l)).toBeLessThanOrEqual(30);
    expect(lines.join(" ")).toBe(cmd);
    expect(wrap("a".repeat(25), 10)).toEqual(["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
    expect(wrap("", 10)).toEqual([""]);
  });

  it("fits a left and a right part to one line, the left giving way", () => {
    expect(fit("worker", "4 rungs", 20)).toBe("worker       4 rungs");
    expect(width(fit("a very long label that will not fit", "value", 20))).toBe(20);
    expect(fit("a very long label that will not fit", "value", 20)).toEndWith("  value");
    expect(padEnd("ab", 4)).toBe("ab  ");
  });

  it("spells every glyph the TUI draws in ASCII for --plain", () => {
    expect(ascii("✓ ready — 0.156.1 · 2 live → sol… ▸ ▾ ● ┃")).toBe(
      "+ ready - 0.156.1 - 2 live -> sol... > v * |",
    );
    expect(ascii("日本")).toBe("??");
  });

  it("formats clocks, ages and short rungs", () => {
    expect([clock(252), clock(3723)]).toEqual(["04:12", "1:02:03"]);
    expect([ago(500), ago(12_000), ago(240_000), ago(7_200_000), ago(3 * 86_400_000)]).toEqual([
      "just now",
      "12s ago",
      "4m ago",
      "2h ago",
      "3d ago",
    ]);
    expect(shortRung("codex:gpt-6-sol#medium")).toBe("gpt-6-sol#medium");
    expect(shortRung("opencode:opencode-go/kimi-k3#max")).toBe("kimi-k3#max");
  });
});
