import { type Dispatch, pendingDispatches } from "./dispatches.ts";
import { finalizeDispatch, waitForFinish } from "./finalize.ts";
import type { Deps } from "./ports.ts";
import { listRuns, type Run } from "./run-store.ts";
import { refreshState } from "./state.ts";
import { log } from "../infra/log.ts";

export interface ReconcileReport {
  finalized: string[];
  watching: string[];
  warnings: string[];
  /** settles once every watched dispatch is finalized */
  done: Promise<void>;
}

/**
 * Waits for a live dispatch this process did not start, then finalizes it. A state.md refresh that
 * fails rejects, after the record is written, with a message that says so.
 */
export async function watchAndFinalize(deps: Deps, run: Run, d: Dispatch): Promise<void> {
  await waitForFinish(d, { pollMs: deps.pollMs, tickMs: Number.POSITIVE_INFINITY, now: deps.now });
  await finalizeDispatch(run, d);
  const { hints } = await refreshState(run);
  if (hints[0]) throw new Error(hints[0]);
}

/**
 * Spec §4.7: on server start, finalize each finished dispatch that has no record, and watch each live
 * one until it finishes. A run that cannot be read is skipped with a warning; it never stops the server.
 */
export async function reconcileAll(deps: Deps): Promise<ReconcileReport> {
  const { runs, corrupt } = listRuns();
  const report: Omit<ReconcileReport, "done"> = {
    finalized: [],
    watching: [],
    warnings: corrupt.map((c) => `skipped run ${c.id}: ${c.reason}`),
  };
  const watchers: Promise<void>[] = [];
  const warn = (run: Run, e: unknown): void => {
    const w = `${run.id}: ${e instanceof Error ? e.message : String(e)}`;
    if (!report.warnings.includes(w)) report.warnings.push(w);
  };
  for (const run of runs) {
    let pending;
    try {
      pending = pendingDispatches(run, deps.now());
    } catch (e) {
      warn(run, e);
      continue;
    }
    for (const d of pending) {
      if (d.state !== "finished") {
        report.watching.push(d.admit.dispatchId);
        watchers.push(watchAndFinalize(deps, run, d).catch((e: unknown) => warn(run, e)));
        continue;
      }
      try {
        await finalizeDispatch(run, d);
      } catch (e) {
        warn(run, e);
        continue;
      }
      report.finalized.push(d.admit.dispatchId);
      for (const h of (await refreshState(run)).hints) warn(run, h);
    }
  }
  log("info", "reconcile", {
    runs: runs.length,
    finalized: report.finalized.length,
    watching: report.watching.length,
    warnings: report.warnings,
  });
  return { ...report, done: Promise.all(watchers).then(() => undefined) };
}
