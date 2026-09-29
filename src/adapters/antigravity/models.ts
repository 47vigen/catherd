import type { DiscoveredModel } from "../backend.ts";
import { foldEffortSlugs, stripAnsi } from "../discovery.ts";

/** `agy --effort` (research §4.3 [run]: "(low|medium|high|max)"); `#default` passes none. */
export const AGY_EFFORTS = ["low", "medium", "high", "max"];

/** A slug: lower-case, with a digit (`gemini-3.8-flash`, `gpt-oss-120b`); headers and tips start upper-case. */
const SLUG = /^[a-z][a-z0-9._-]*$/;

/**
 * `agy models` (spec 1.3 §6.6). Its format is unverified: 1.2.13 rejects the changelog's `--output-format json`
 * (research §4.5), so each line's first word is read as a slug when it looks like one, past a list bullet. Slugs
 * that differ by an `--effort` word fold into one model (`gemini-3.8-flash-high`) with the efforts listed, and
 * `default` when the bare slug is listed too; a model listed only bare offers every `--effort`, which picks
 * the variant (research §4.5).
 */
export function parseAgyModels(text: string): DiscoveredModel[] {
  const slugs = stripAnsi(text)
    .split("\n")
    .map(
      (l) =>
        l
          .trim()
          .replace(/^[*•-]\s+/, "")
          .split(/\s/)[0] ?? "",
    )
    .filter((w) => SLUG.test(w) && /\d/.test(w));
  return [...foldEffortSlugs(slugs, AGY_EFFORTS)].map(([id, efforts]) => ({
    id,
    efforts:
      efforts.size === 1 && efforts.has("default")
        ? ["default", ...AGY_EFFORTS]
        : ["default", ...AGY_EFFORTS].filter((e) => efforts.has(e)),
    context: null,
    imageIn: false,
  }));
}
