import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tryLock } from "../infra/filelock.ts";
import { liveDispatches } from "./dispatches.ts";
import { findRun, listRuns, type Run, runPaths } from "./run-store.ts";

export interface ScratchCleaned {
  /** the runs whose scratch folder was removed, with what it held */
  removed: { run: string; bytes: number }[];
  /** the runs left alone, and why: a role still writes there */
  kept: { run: string; why: string }[];
}

/** The bytes under `dir`, links not followed; 0 for what cannot be read. */
function sizeOf(dir: string): number {
  let total = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      total += e.isDirectory() ? sizeOf(p) : (lstatSync(p, { throwIfNoEntry: false })?.size ?? 0);
    }
  } catch {
    // gone or unreadable: counts as nothing
  }
  return total;
}

/**
 * Spec 1.5 plan 21: `catherd runs clean [run]` removes the roles' scratch folders (`<run>/scratch/`, each role's
 * TMPDIR) of a run with no live role, or of every such run. The run's own files, records and replies stay. A run
 * whose admission is in progress is kept: that admission may have just created a role's scratch.
 */
export function cleanScratch(o: { run?: string; now?: number } = {}): ScratchCleaned {
  const runs: Run[] = o.run ? [findRun(o.run)] : listRuns().runs;
  const out: ScratchCleaned = { removed: [], kept: [] };
  for (const run of runs) {
    const dir = runPaths(run.dir).scratch;
    if (!existsSync(dir)) continue;
    // admission creates a role's scratch and admits its dispatch under this lock, so while cleanup holds it no
    // scratch is half-admitted, and one an admission holds now belongs to a dispatch about to go live
    const release = tryLock(runPaths(run.dir).admission);
    if (!release) {
      out.kept.push({ run: run.id, why: "a dispatch is being admitted" });
      continue;
    }
    try {
      const live = liveDispatches(run, o.now ?? Date.now());
      if (live.length) {
        out.kept.push({ run: run.id, why: `${live.map((d) => d.admit.name).join(", ")} still running` });
        continue;
      }
      const bytes = sizeOf(dir);
      rmSync(dir, { recursive: true, force: true });
      out.removed.push({ run: run.id, bytes });
    } finally {
      release();
    }
  }
  return out;
}
