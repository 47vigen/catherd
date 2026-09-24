import stringWidth from "string-width";
import { describe, expect, it } from "bun:test";
import {
  climbLine,
  clock,
  costNote,
  detectUi,
  FACES,
  face,
  GLYPH_NAMES,
  glyph,
  HARNESS_HINT,
  HERDING,
  herdLine,
  INTRO,
  mascot,
  nick,
  SPINNER,
  shortRung,
  tint,
} from "../../src/tui/theme.ts";

const ascii = /^[\x20-\x7e]*$/;
const TONES = ["ginger", "cream", "charcoal", "pink"] as const;

describe("theme", () => {
  it("has one face per state, verbatim from the spec", () => {
    expect(FACES).toEqual({
      good: "=^.^=",
      working: "=o.o=",
      waiting: "=-.-=",
      failed: "=x.x=",
      landed: "=^ω^=",
    });
  });

  it("gives every face and glyph an ASCII fallback under --plain", () => {
    for (const m of Object.keys(FACES) as (keyof typeof FACES)[]) expect(face(m, true)).toMatch(ascii);
    for (const g of GLYPH_NAMES) expect(glyph(g, true)).toMatch(ascii);
    expect(face("landed", true)).toBe("=^w^=");
  });

  it("uses a paw for ticked and a circle for empty, of equal width so columns line up", () => {
    expect(glyph("on", false)).toBe("🐾");
    expect(glyph("off", false).trim()).toBe("○");
    expect(stringWidth(glyph("on", false))).toBe(stringWidth(glyph("off", false)));
    expect([glyph("on", true), glyph("off", true)]).toEqual(["[x]", "[ ]"]);
  });

  it("draws a three-line cat of even width whose face follows the mood", () => {
    const art = mascot("failed", false);
    expect(art).toHaveLength(3);
    expect(new Set(art.map((l) => stringWidth(l))).size).toBe(1);
    expect(art[1]).toContain("=x.x=");
    expect(mascot("landed", true)[1]).toContain("=^w^=");
  });

  it("uses one hex tint per tone above depth 1, and nothing at depth 1 (NO_COLOR); OpenTUI takes RGB only and downsamples itself", () => {
    for (const t of TONES) {
      for (const d of [24, 8, 4] as const) expect(tint(t, d)).toMatch(/^#[0-9A-F]{6}$/);
      expect(tint(t, 1)).toBeUndefined();
    }
  });

  it("reads the colour depth from the environment and honours NO_COLOR", () => {
    expect(detectUi([], { COLORTERM: "truecolor" }).depth).toBe(24);
    expect(detectUi([], { TERM: "xterm-256color" }).depth).toBe(8);
    expect(detectUi([], { TERM: "xterm" }).depth).toBe(4);
    expect(detectUi([], { NO_COLOR: "1", COLORTERM: "truecolor" }).depth).toBe(1);
  });

  it("turns on plain for --plain or a console without Unicode, and reduced motion for its flag", () => {
    expect(detectUi(["--plain"], { TERM: "xterm-256color" }).plain).toBe(true);
    expect(detectUi([], { TERM: "linux" }).plain).toBe(true);
    expect(detectUi([], { TERM: "xterm-256color" })).toMatchObject({ plain: false, reducedMotion: false });
    expect(detectUi(["--reduced-motion"], {}).reducedMotion).toBe(true);
  });

  it("rotates the herding copy", () => {
    expect(herdLine(0, false)).toBe("herding…");
    expect(herdLine(2, false)).toBe("negotiating with Luna…");
    expect(herdLine(HERDING.length, true)).toBe("herding...");
  });

  it("keeps spinner frames ASCII and of one width, and the intro under 1.5 s", () => {
    for (const f of SPINNER.frames) expect(f).toMatch(ascii);
    expect(new Set(SPINNER.frames.map((f) => f.length)).size).toBe(1);
    expect(INTRO.steps * INTRO.ms).toBeLessThan(1500);
  });

  it("keeps each harness hint on one 80-column line", () => {
    for (const h of Object.values(HARNESS_HINT)) expect(h.length).toBeLessThanOrEqual(80);
  });

  it("states the customization cost in thousands of tokens", () => {
    const base = { backend: "codex" as const, nativeRuns: 5, isolatedRuns: 3 };
    expect(costNote({ ...base, nativeMedian: 40_200, isolatedMedian: 28_100, extraPerRun: 12_100 })).toBe(
      "customizations ~12k tokens/run",
    );
    expect(
      costNote({ ...base, isolatedRuns: 0, nativeMedian: 40_200, isolatedMedian: null, extraPerRun: null }),
    ).toBe("native ~40k tokens/run");
  });

  it("formats clocks, short rungs and nicknames", () => {
    expect(clock(252)).toBe("04:12");
    expect(clock(3723)).toBe("1:02:03");
    expect(shortRung("gpt-6-sol#medium")).toBe("sol#medium");
    expect(shortRung("openrouter/qwen/qwen3-coder#high")).toBe("qwen3-coder#high");
    expect(shortRung("claude-opus-5-5#high")).toBe("claude-opus-5-5#high");
    expect(nick("gpt-6-luna#high")).toBe("Luna");
  });

  it("tells a climb as one line that still names the role and both rungs", () => {
    expect(climbLine("worker-M1.L2", "gpt-6-luna#high", "gpt-6-sol#medium", false)).toBe(
      "Luna gave up, Sol takes over · worker-M1.L2 luna#high → sol#medium",
    );
    expect(climbLine("worker-M1.L2", "gpt-6-sol#medium", "gpt-6-sol#high", true)).toBe(
      "Sol digs deeper - worker-M1.L2 sol#medium -> sol#high",
    );
  });
});
