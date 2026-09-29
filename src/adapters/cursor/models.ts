import type { DiscoveredModel } from "../backend.ts";
import { foldEffortSlugs, stripAnsi } from "../discovery.ts";

/** Effort suffixes Cursor puts on a legacy slug (`gpt-6-sol-xhigh`); any other suffix names a model. */
export const CURSOR_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

const LINE = /^\s*([a-z0-9][a-z0-9._-]*)\s+-\s+\S/;

/** Spec 1.3 §4.6: an effort is its own slug; `default` is the bare one, with no effort suffix. */
export const cursorSlug = (model: string, effort: string): string =>
  effort === "default" ? model : `${model}-${effort}`;

/**
 * `cursor-agent models` prints `<slug> - <Display Name>` lines under a header, with ` (current, default)`
 * markers and a tip (research §2.4). Slugs that differ only by an effort suffix fold into one model; its
 * efforts list `default` when the bare slug is listed too, since only then does a `#default` rung have a slug
 * to run. Bracket variant strings are never listed, so they are never built.
 */
export function parseCursorModels(text: string): DiscoveredModel[] {
  const slugs = stripAnsi(text)
    .split("\n")
    .map((l) => LINE.exec(l)?.[1])
    .filter((s): s is string => s !== undefined);
  return [...foldEffortSlugs(slugs, CURSOR_EFFORTS)].map(([id, efforts]) => ({
    id,
    efforts: ["default", ...CURSOR_EFFORTS].filter((e) => efforts.has(e)),
    context: null,
    imageIn: false,
  }));
}
