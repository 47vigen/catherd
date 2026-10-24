import { readFileSync } from "node:fs";
import { join } from "node:path";

import { BRANDS, brandOf } from "./brand";

const css = readFileSync(join(process.cwd(), "src/theme.css"), "utf8");

test("every backend, backend name, lab and model maps to its brand, anything else to other", () => {
  const keys = [
    "claude-code",
    "Claude Code",
    "codex:gpt-6-sol",
    "opencode-go",
    "deepseek",
    "openscale/deepseek/deepseek-v4.1-flash",
    "gemini-3-8-flash",
    "glm-4.6",
    "acme",
  ];
  expect(keys.map(brandOf)).toEqual([
    "anthropic",
    "anthropic",
    "openai",
    "opencode",
    "deepseek",
    "deepseek",
    "google",
    "zai",
    "other",
  ]);
  expect(brandOf(null)).toBe("other");
});

test("every brand has a light and a dark value and an alias", () => {
  for (const b of BRANDS) {
    expect(css.split(`--brand-${b}:`)).toHaveLength(3);
    expect(css.split(`--color-brand-${b}:`)).toHaveLength(2);
  }
});

function luminance(oklch: string): number {
  const [L, C, H] = oklch
    .match(/oklch\(([^)]+)\)/)![1]!
    .split(/\s+/)
    .map(Number) as [number, number, number];
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((v) => Math.min(1, Math.max(0, v)));
  // Clipped linear sRGB: the relative luminance weights apply to linear values.
  return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
}
const contrast = (x: string, y: string) => {
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

test("every brand colour holds 3:1 against its theme's surface", () => {
  const light = css.indexOf("color-scheme: light");
  const dark = css.indexOf("color-scheme: dark");
  expect(light).toBeGreaterThanOrEqual(0);
  expect(dark).toBeGreaterThan(light);
  for (const [name, block] of [
    ["light", css.slice(light, dark)],
    ["dark", css.slice(dark)],
  ] as const) {
    const surface = block.match(/--surface:\s*(oklch\([^)]+\))/)![1]!;
    for (const b of BRANDS) {
      const v = block.match(new RegExp(`--brand-${b}:\\s*(oklch\\([^)]+\\))`))![1]!;
      expect(contrast(v, surface), `${name} ${b}`).toBeGreaterThanOrEqual(3);
    }
  }
});
