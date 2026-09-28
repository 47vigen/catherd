import { effortWord } from "../../domain/sources.ts";
import { parseCsv } from "./csv.ts";
import { SourceError, type SourceTransport, sourceGet } from "./http.ts";
import { isoDay, keepHighest, num, type SourceRow, urlOr } from "./rows.ts";
import { unzip } from "./zip.ts";

/** Spec 1.2 §3.1: one CSV per benchmark in a zip (CC-BY; external tables keep their own license). */
export const EPOCH_URL = "https://epoch.ai/data/benchmark_data.zip";
export const EPOCH_PAGE = "https://epoch.ai/benchmarks";

/**
 * The tables catherd reads, by field: the file, its score column, whether that score is a fraction (read in
 * percent, as the shipped values are), and the column that dates a row, if any.
 */
export const EPOCH_TABLES = {
  frontiercode: { file: "frontiercode_external.csv", score: "Main score", fraction: true, dated: null },
  terminalbench: {
    file: "terminalbench_external.csv",
    score: "Accuracy mean",
    fraction: true,
    dated: "Run date",
  },
  webdev: { file: "webdev_arena_external.csv", score: "Arena Score", fraction: false, dated: "Last updated" },
} as const;
type EpochField = keyof typeof EPOCH_TABLES;
const FIELDS = Object.keys(EPOCH_TABLES) as EpochField[];

/** The zip's tables catherd reads, by file name (the answer catherd caches); a missing one fails the source. */
export async function fetchEpoch(t: SourceTransport = {}): Promise<Record<string, string>> {
  const r = await sourceGet(EPOCH_URL, t);
  const wanted = new Set<string>(FIELDS.map((f) => EPOCH_TABLES[f].file));
  let files: Map<string, Uint8Array>;
  try {
    files = unzip(r.bytes, (name) => wanted.has(name));
  } catch (e) {
    throw new SourceError(`the answer is not a readable zip: ${(e as Error).message}`, r.status);
  }
  const out: Record<string, string> = {};
  for (const name of wanted) {
    const data = files.get(name);
    if (!data) throw new SourceError(`the zip has no ${name}`, r.status);
    out[name] = new TextDecoder().decode(data);
  }
  return out;
}

/**
 * Spec 1.2 §3.4: Epoch's `Model version` as `<id>#<effort>`: the effort after the last `_` (`gpt-6-astra_max`),
 * else the row's `Reasoning effort` column; `_unknown` and suffixes that are not efforts (`_32K`) name none.
 */
export function epochRung(version: string, effortColumn = ""): string {
  const cut = version.lastIndexOf("_");
  const id = cut < 0 ? version : version.slice(0, cut);
  const effort = (cut < 0 ? null : effortWord(version.slice(cut + 1))) ?? effortWord(effortColumn);
  return effort ? `${id}#${effort}` : id;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** One row per model and table, the highest where a model has several (Terminal-Bench: one per agent). */
export function parseEpoch(tables: Record<string, string>, fetchedAt: string): SourceRow[] {
  const rows: SourceRow[] = [];
  for (const field of FIELDS) {
    const t = EPOCH_TABLES[field];
    const text = tables[t.file];
    if (typeof text !== "string") continue;
    for (const r of parseCsv(text)) {
      const version = (r["Model version"] ?? "").trim();
      const raw = num(r[t.score]);
      if (!version || raw === null) continue;
      const dated = t.dated ? (r[t.dated] ?? "").trim() : "";
      rows.push({
        rung: epochRung(version, r["Reasoning effort"] ?? ""),
        field,
        value: t.fraction ? Math.round(raw * 1e6) / 1e4 : raw,
        date: DAY.test(dated) ? dated : isoDay(fetchedAt),
        url: urlOr(r.Source, urlOr(r["Source Link"] ?? r["Source link (site from table)"], EPOCH_PAGE)),
      });
    }
  }
  return keepHighest(rows);
}
