import { tryParseRung } from "./ids.ts";
import type { Difficulty, Kind } from "./lane.ts";

/** One finished lane of one run. firstPass = landed && start_ok && rounds === 1. */
export interface LaneRecord {
  /** the start rung */
  rung: string;
  kind: Kind | null;
  difficulty: Difficulty | null;
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
  lanes: number;
  landed: number;
  firstPass: number;
  rounds: number;
  findings: number;
}

/** One stat per rung, kind and difficulty, sorted by model, effort, kind, difficulty. */
export function summarize(lanes: readonly LaneRecord[]): OutcomeStat[] {
  const by = new Map<string, OutcomeStat>();
  for (const l of lanes) {
    const key = [l.rung, l.kind, l.difficulty].join("|");
    let s = by.get(key);
    if (!s) {
      const r = tryParseRung(l.rung);
      s = {
        rung: l.rung,
        model: r ? `${r.backend}:${r.model}` : l.rung,
        effort: r?.effort ?? "",
        kind: l.kind,
        difficulty: l.difficulty,
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
  const text = (s: OutcomeStat) => [s.model, s.effort, s.kind ?? "", s.difficulty ?? ""].join("\0");
  return [...by.values()].sort((a, b) => text(a).localeCompare(text(b)));
}
