import stringWidth from "string-width";
import { describe, expect, it } from "bun:test";
import {
  climbLine,
  clock,
  costNote,
  detectUi,
  dot,
  dotTint,
  FACES,
  face,
  GLYPH_NAMES,
  glyph,
  harnessLine,
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
const TONES = ["ginger", "cream", "charcoal", "pink", "green", "amber", "red"] as const;

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

  it("uses a filled dot for ticked and a hollow one for empty, of equal width so columns line up", () => {
    expect(glyph("on", false)).toBe("●");
    expect(glyph("off", false)).toBe("○");
    expect(stringWidth(glyph("on", false))).toBe(stringWidth(glyph("off", false)));
    expect([glyph("on", true), glyph("off", true)]).toEqual(["*", "o"]);
  });

  it("paints ready/warn as the filled dot and missing as the hollow one, in green/amber/red", () => {
    expect(dot("ready", false)).toBe("●");
    expect(dot("warn", false)).toBe("●");
    expect(dot("missing", false)).toBe("○");
    expect([dot("ready", true), dot("warn", true), dot("missing", true)]).toEqual(["*", "*", "o"]);
    expect(dotTint("ready", 24)).toBe(tint("green", 24));
    expect(dotTint("warn", 24)).toBe(tint("amber", 24));
    expect(dotTint("missing", 24)).toBe(tint("red", 24));
    expect(dotTint("ready", 1)).toBeUndefined();
  });

  it("only the wordmark keeps a paw glyph, and only outside --plain", () => {
    expect(glyph("paw", false)).toBe("🐾");
    expect(glyph("paw", true)).toBe("");
  });

  it("lines up the harness's native/isolated choice with what it costs", () => {
    expect(harnessLine("codex", false, undefined, false)).toBe(`native · ${HARNESS_HINT.codex}`);
    const cost = {
      backend: "codex" as const,
      nativeRuns: 1,
      isolatedRuns: 1,
      nativeMedian: 40_000,
      isolatedMedian: null,
      extraPerRun: null,
    };
    expect(harnessLine("codex", true, cost, false)).toBe("isolated · native ~40k tokens/run");
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
