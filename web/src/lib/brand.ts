export const BRANDS = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "deepseek",
  "meta",
  "alibaba",
  "mistral",
  "kimi",
  "zai",
  "opencode",
  "cursor",
  "other",
] as const;
export type Brand = (typeof BRANDS)[number];

const BACKENDS: Record<string, Brand> = {
  claude: "anthropic",
  "claude-code": "anthropic",
  "claude code": "anthropic",
  codex: "openai",
  opencode: "opencode",
  "opencode-go": "opencode",
  cursor: "cursor",
};

// Order matters only between disjoint prefixes; each model family names its own brand.
const PREFIXES: [string, Brand][] = [
  ["claude", "anthropic"],
  ["gpt", "openai"],
  ["gemini", "google"],
  ["grok", "xai"],
  ["deepseek", "deepseek"],
  ["llama", "meta"],
  ["qwen", "alibaba"],
  ["mistral", "mistral"],
  ["devstral", "mistral"],
  ["codestral", "mistral"],
  ["kimi", "kimi"],
  ["glm", "zai"],
];

/** A backend id or rung, a backend's display name, a Slopalytics lab id, a model id or path → its brand. */
export function brandOf(key: string | null | undefined): Brand {
  const k = (key ?? "").toLowerCase().split(":")[0]!.trim();
  const direct = BACKENDS[k];
  if (direct) return direct;
  if ((BRANDS as readonly string[]).includes(k)) return k as Brand;
  const last = (key ?? "").toLowerCase().split("/").pop()!;
  return PREFIXES.find(([p]) => last.startsWith(p))?.[1] ?? "other";
}

export const brandFill = (b: Brand): string => `var(--brand-${b})`;

/** A palette step, 100 (faintest) to 900 (the brand itself). */
export type Shade = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900;

/**
 * The brand at a palette step: lower steps fade it into the page background, so a step reads fainter in light and
 * dark alike and follows the theme with no second set of values. The steps share the range evenly from 100 (a
 * quarter of the brand, still a visible line) to 900, so neighbouring steps stay apart.
 */
export const brandShade = (b: Brand, step: Shade): string =>
  step === 900
    ? brandFill(b)
    : `color-mix(in oklab, ${brandFill(b)} ${Math.round(25 + (75 * (step - 100)) / 800)}%, var(--background))`;

// Literal class names, so Tailwind sees each one.
export const BRAND_BG: Record<Brand, string> = {
  anthropic: "bg-brand-anthropic",
  openai: "bg-brand-openai",
  google: "bg-brand-google",
  xai: "bg-brand-xai",
  deepseek: "bg-brand-deepseek",
  meta: "bg-brand-meta",
  alibaba: "bg-brand-alibaba",
  mistral: "bg-brand-mistral",
  kimi: "bg-brand-kimi",
  zai: "bg-brand-zai",
  opencode: "bg-brand-opencode",
  cursor: "bg-brand-cursor",
  other: "bg-brand-other",
};
export const BRAND_TEXT: Record<Brand, string> = {
  anthropic: "text-brand-anthropic",
  openai: "text-brand-openai",
  google: "text-brand-google",
  xai: "text-brand-xai",
  deepseek: "text-brand-deepseek",
  meta: "text-brand-meta",
  alibaba: "text-brand-alibaba",
  mistral: "text-brand-mistral",
  kimi: "text-brand-kimi",
  zai: "text-brand-zai",
  opencode: "text-brand-opencode",
  cursor: "text-brand-cursor",
  other: "text-brand-other",
};
