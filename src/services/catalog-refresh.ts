import { writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { barPool, deriveBars } from "../domain/bars.ts";
import {
  buildCatalog,
  DIMS,
  type Dim,
  type ModelsFile,
  outranks,
  type Score,
  type ScoresFile,
  scoresOf,
} from "../domain/catalog.ts";
import { DIFFICULTIES, type Difficulty, KINDS, type Kind } from "../domain/lane.ts";
import type { SourcesFile } from "../domain/sources.ts";
import type { SourceTransport } from "../infra/sources/http.ts";
import { adjacent, derive, type RawAnswers } from "./source-derive.ts";
import { cachedAnswers, syncSources } from "./source-sync.ts";

/** Spec 1.2 §7: a value that moved by more than this is listed in the refresh PR. */
const MOVED = 0.05;

export interface RefreshReport {
  /** the day the data was read, `scores.json`'s new `version` */
  date: string;
  /** canonical rungs with no value in the shipped file before, and at least one now */
  newlyScored: string[];
  /** values that moved by more than 5 %, and values that appeared or went away on a rung already scored */
  moved: { rung: string; dim: Dim; from: number | null; to: number | null }[];
  /** every default threshold that moved, appeared or went away */
  barsMoved: { kind: Kind; difficulty: Difficulty; dim: Dim; from: number | null; to: number | null }[];
  /** shipped treat-likes dropped because their rung now has a value of its own on every dimension they lent */
  standInsDropped: string[];
}

const key = (s: Pick<Score, "rung" | "dim">) => `${s.rung} ${s.dim}`;

/** One value per rung and dimension, the one that outranks the others (spec 1.2 §4.3), in file order. */
function best(scores: Score[], now: number): Score[] {
  const out = new Map<string, Score>();
  for (const s of scores) {
    const had = out.get(key(s));
    if (!had || outranks(s, had, now)) out.set(key(s), s);
  }
  return [...out.values()].sort(
    (a, b) => a.rung.localeCompare(b.rung) || DIMS.indexOf(a.dim) - DIMS.indexOf(b.dim),
  );
}

/**
 * Spec 1.2 §5.2, §7: `catalog/scores.json` rebuilt from the keyless sources' answers. It keeps every hand-typed
 * value (one with no `source`), replaces the keyless values with what `raw` says now (Artificial Analysis is
 * never shipped, whatever `raw` holds), spreads every published value to the family's other efforts as
 * `adjacent` (plan 14 Ruling 3), keeps one value per rung and dimension, derives the default bars with their
 * `barsWhy`, and drops a shipped treat-like its rung no longer needs.
 */
export function rebuildShipped(
  raw: RawAnswers,
  ctx: { models: ModelsFile; scores: ScoresFile; sources: SourcesFile; now: number },
): { file: ScoresFile; report: RefreshReport } {
  const date = new Date(ctx.now).toISOString().slice(0, 10);
  const { "artificial-analysis": _aa, ...keyless } = raw;
  // hand-typed values, less the ones an earlier rebuild spread: those are spread again below
  const hand = ctx.scores.scores.filter((s) => s.source === undefined && s.confidence !== "adjacent");
  const synced = derive(keyless, { ...ctx, scores: { ...ctx.scores, scores: hand } }).scores.filter(
    (s) => s.source !== "artificial-analysis" && s.confidence !== "adjacent",
  );
  const direct = best([...hand, ...synced], ctx.now);
  // an inferred value is catherd's guess for its own rung only: it is never carried to another effort
  const spread = adjacent(
    ctx.models.families,
    direct.filter((s) => s.confidence !== "inferred"),
    new Set(),
    ctx.now,
  );
  const scores = best([...direct, ...spread], ctx.now);
  const benchmark = (d: Dim) => {
    const b = ctx.scores.benchmarks[d];
    return `${b.benchmark} ${b.version}`;
  };
  const { bars, barsWhy } = deriveBars(barPool(scores), benchmark, date);

  const draft: ScoresFile = { ...ctx.scores, version: date, scores, bars, barsWhy };
  const c = buildCatalog({ models: ctx.models, scores: { ...draft, treatLike: ctx.scores.treatLike } });
  const treatLike: ScoresFile["treatLike"] = {};
  const standInsDropped: string[] = [];
  for (const [rung, t] of Object.entries(ctx.scores.treatLike))
    if (scoresOf(c, rung)?.borrowed.length) treatLike[rung] = t;
    else standInsDropped.push(rung);
  const file: ScoresFile = { ...draft, treatLike };
  return { file, report: { date, ...diffShipped(ctx.scores, file), standInsDropped } };
}

const rungsOf = (f: ScoresFile) => new Set(f.scores.map((s) => s.rung));

/** What moved between two shipped files (spec 1.2 §7's PR body). */
function diffShipped(
  before: ScoresFile,
  after: ScoresFile,
): Pick<RefreshReport, "newlyScored" | "moved" | "barsMoved"> {
  const had = rungsOf(before);
  const newlyScored = [...rungsOf(after)].filter((r) => !had.has(r)).sort();
  const was = new Map(before.scores.map((s) => [key(s), s.value]));
  const now = new Map(after.scores.map((s) => [key(s), s.value]));
  const moved: RefreshReport["moved"] = [];
  for (const k of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const [rung, dim] = k.split(" ") as [string, Dim];
    if (newlyScored.includes(rung)) continue;
    const from = was.get(k) ?? null;
    const to = now.get(k) ?? null;
    const far =
      from === null || to === null || (from === 0 ? to !== 0 : Math.abs(to - from) / Math.abs(from) > MOVED);
    if (far) moved.push({ rung, dim, from, to });
  }
  const barsMoved: RefreshReport["barsMoved"] = [];
  for (const kind of KINDS)
    for (const difficulty of DIFFICULTIES)
      for (const dim of DIMS) {
        const from = before.bars[kind]?.[difficulty]?.[dim] ?? null;
        const to = after.bars[kind]?.[difficulty]?.[dim] ?? null;
        if (from !== to) barsMoved.push({ kind, difficulty, dim, from, to });
      }
  return { newlyScored, moved, barsMoved };
}

/** Whether the rebuilt file says anything new: its date and `barsWhy` wording alone never count. */
export function shippedChanged(before: ScoresFile, after: ScoresFile): boolean {
  // as the file reads back: no undefined fields, whatever the key order
  const strip = (f: ScoresFile): unknown => JSON.parse(JSON.stringify({ ...f, version: "", barsWhy: null }));
  return !isDeepStrictEqual(strip(before), strip(after));
}

const num = (v: number | null) => (v === null ? "none" : String(v));

/** Spec 1.2 §7: the refresh PR's body: rungs newly scored, values moved by more than 5 %, bars that moved. */
export function refreshBody(r: RefreshReport): string {
  const out = [
    `Weekly refresh of the shipped scores from the keyless public sources (data of ${r.date}).`,
    "",
    "Artificial Analysis values are never shipped. Merging this releases a patch through the Release workflow.",
    "",
    `### Rungs newly scored (${r.newlyScored.length})`,
    "",
    ...(r.newlyScored.length ? r.newlyScored.map((x) => `- \`${x}\``) : ["none"]),
    "",
    `### Values moved by more than 5 % (${r.moved.length})`,
    "",
    ...(r.moved.length
      ? ["| rung | dimension | was | now |", "| --- | --- | --- | --- |"].concat(
          r.moved.map((m) => `| \`${m.rung}\` | ${m.dim} | ${num(m.from)} | ${num(m.to)} |`),
        )
      : ["none"]),
    "",
    `### Bars that moved (${r.barsMoved.length})`,
    "",
    ...(r.barsMoved.length
      ? ["| kind | difficulty | dimension | was | now |", "| --- | --- | --- | --- | --- |"].concat(
          r.barsMoved.map(
            (b) => `| ${b.kind} | ${b.difficulty} | ${b.dim} | ${num(b.from)} | ${num(b.to)} |`,
          ),
        )
      : ["none"]),
  ];
  if (r.standInsDropped.length)
    out.push(
      "",
      "### Shipped stand-ins no longer needed",
      "",
      ...r.standInsDropped.map((x) => `- \`${x}\` now has values of its own`),
    );
  return `${out.join("\n")}\n`;
}

/**
 * Spec 1.2 §7, `scripts/catalog-refresh.ts`: syncs every keyless source now (no Artificial Analysis key, the
 * TTL ignored) into the current data folder, rebuilds the shipped file from the answers and, when it says
 * anything new, writes it to `out`. A keyless source that fails writes nothing: a refresh never ships a file
 * that lost a source's values (plan 14 Ruling 11).
 */
export async function refreshShipped(o: {
  out: string;
  current: ScoresFile;
  models: ModelsFile;
  sources: SourcesFile;
  transport?: SourceTransport;
  now?: () => number;
}): Promise<{ changed: boolean; failed: { source: string; error: string }[]; report: RefreshReport | null }> {
  const now = o.now ?? Date.now;
  const sync = await syncSources({ force: true, aaKey: null, transport: o.transport, now });
  if (sync.failed.length) return { changed: false, failed: sync.failed, report: null };
  const { file, report } = rebuildShipped(cachedAnswers(), {
    models: o.models,
    scores: o.current,
    sources: o.sources,
    now: now(),
  });
  const changed = shippedChanged(o.current, file);
  if (changed) writeFileSync(o.out, `${JSON.stringify(file, null, 2)}\n`);
  return { changed, failed: [], report };
}
