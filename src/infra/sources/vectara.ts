import { type SourceTransport, sourceGet } from "./http.ts";
import { isoDay, num, type SourceRow } from "./rows.ts";

/** Spec 1.2 §3.1: the leaderboard is a markdown table in the repository's README (Apache-2.0). */
export const VECTARA_URL =
  "https://raw.githubusercontent.com/vectara/hallucination-leaderboard/main/README.md";
export const VECTARA_PAGE = "https://github.com/vectara/hallucination-leaderboard";

export const fetchVectara = async (t: SourceTransport = {}): Promise<string> =>
  (await sourceGet(VECTARA_URL, t)).text();

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

/** "Last updated on September 22, 2026" as `2026-09-22`; null when the README has no such line. */
export function vectaraDate(markdown: string): string | null {
  const m = /Last updated on ([A-Za-z]+) (\d{1,2}), (\d{4})/.exec(markdown);
  const month = m ? MONTHS.indexOf((m[1] as string).toLowerCase()) : -1;
  if (!m || month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${(m[2] as string).padStart(2, "0")}`;
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/**
 * Two rows per model of the README's table: `factual_consistency` and `hallucination_rate`, in percent. The
 * model keeps its `vendor/` prefix and names no effort.
 */
export function parseVectara(markdown: string, fetchedAt: string): SourceRow[] {
  const lines = markdown.split("\n");
  const head = lines.findIndex((l) => /^\|\s*Model\s*\|/i.test(l));
  if (head < 0) return [];
  const columns = cells(lines[head] as string).map((c) => c.toLowerCase());
  const at = (name: string) => columns.findIndex((c) => c.startsWith(name));
  const [consistency, hallucination] = [at("factual consistency"), at("hallucination rate")];
  const date = vectaraDate(markdown) ?? isoDay(fetchedAt);
  const rows: SourceRow[] = [];
  for (const line of lines.slice(head + 2)) {
    if (!line.trim().startsWith("|")) break;
    const c = cells(line);
    const model = c[0];
    if (!model) continue;
    for (const [field, i] of [
      ["factual_consistency", consistency],
      ["hallucination_rate", hallucination],
    ] as const) {
      const value = i < 0 ? null : num((c[i] ?? "").replace("%", ""));
      if (value !== null) rows.push({ rung: model, field, value, date, url: VECTARA_PAGE });
    }
  }
  return rows;
}
