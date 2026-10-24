import { tryParseRung } from "./ids.ts";
import type { Difficulty, Kind } from "./lane.ts";

export const CHORE_WHY = "a chore lane: the cheapest capable rung";
export const LEARN_MIN_LANES = 5;

/** One finished lane of one run. firstPass = landed && start_ok && rounds === 1. */
export interface LaneRecord {
  /** the start rung */
  rung: string;
  kind: Kind | null;
  difficulty: Difficulty | null;
  chore: boolean;
  landed: boolean;
  firstPass: boolean;
  /** the lane's dispatches: first try, retries and fix rounds */
  rounds: number;
  /** reviewer BLOCKER and BUG findings on files the lane owns */
  findings: number;
}

export interface OutcomeStat {
  rung: string;
  /** `backend:model` and the effort word, apart */
  model: string;
  effort: string;
  kind: Kind | null;
  difficulty: Difficulty | null;
  chore: boolean;
  lanes: number;
  landed: number;
  firstPass: number;
  rounds: number;
  findings: number;
}

/** One stat per rung, kind, difficulty and chore flag, sorted by model, effort, kind, difficulty, chore. */
export function summarize(lanes: readonly LaneRecord[]): OutcomeStat[] {
  const by = new Map<string, OutcomeStat>();
  for (const l of lanes) {
    const key = [l.rung, l.kind, l.difficulty, l.chore].join("|");
    let s = by.get(key);
    if (!s) {
      const r = tryParseRung(l.rung);
      s = {
        rung: l.rung,
        model: r ? `${r.backend}:${r.model}` : l.rung,
        effort: r?.effort ?? "",
        kind: l.kind,
        difficulty: l.difficulty,
        chore: l.chore,
        lanes: 0,
        landed: 0,
        firstPass: 0,
        rounds: 0,
        findings: 0,
      };
      by.set(key, s);
    }
    s.lanes += 1;
    s.landed += l.landed ? 1 : 0;
    s.firstPass += l.firstPass ? 1 : 0;
    s.rounds += l.rounds;
    s.findings += l.findings;
  }
  const text = (s: OutcomeStat) =>
    [s.model, s.effort, s.kind ?? "", s.difficulty ?? "", s.chore ? 1 : 0].join("\0");
  return [...by.values()].sort((a, b) => text(a).localeCompare(text(b)));
}

/** One rung's lanes of `difficulty` over every kind, chore lanes left out. */
function totals(stats: readonly OutcomeStat[], rung: string, difficulty: Difficulty) {
  const t = { lanes: 0, firstPass: 0, rounds: 0 };
  for (const s of stats)
    if (s.rung === rung && s.difficulty === difficulty && !s.chore) {
      t.lanes += s.lanes;
      t.firstPass += s.firstPass;
      t.rounds += s.rounds;
    }
  return t;
}

const record = (rung: string, t: ReturnType<typeof totals>): string =>
  `${rung} ${t.firstPass}/${t.lanes} first pass, ${(t.rounds / t.lanes).toFixed(1)} rounds/lane`;

/**
 * Over every kind of `difficulty`, chore lanes left out: the first of `cheaper` (cost order, cheapest first) with at
 * least LEARN_MIN_LANES lanes whose first-pass rate is at least `start`'s and whose rounds per lane are at most
 * `start`'s, when `start` itself has LEARN_MIN_LANES lanes; else null. `why` names both records.
 */
export function learnedStart(
  stats: readonly OutcomeStat[],
  cheaper: readonly string[],
  difficulty: Difficulty,
  start: string,
): { rung: string; why: string } | null {
  const s = totals(stats, start, difficulty);
  if (s.lanes < LEARN_MIN_LANES) return null;
  for (const rung of cheaper) {
    if (rung === start) continue;
    const c = totals(stats, rung, difficulty);
    // cross-multiplied, so the comparison is exact
    if (
      c.lanes >= LEARN_MIN_LANES &&
      c.firstPass * s.lanes >= s.firstPass * c.lanes &&
      c.rounds * s.lanes <= s.rounds * c.lanes
    )
      return {
        rung,
        why: `learned from ${difficulty} lanes: ${record(rung, c)}, against ${record(start, s)}`,
      };
  }
  return null;
}
