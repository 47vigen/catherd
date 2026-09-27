import { readFileSync, statSync } from "node:fs";
import { errorMessage } from "../domain/errors.ts";
import { dispatchPaths } from "../infra/dispatch-dir.ts";
import { log } from "../infra/log.ts";
import { writeJsonAtomic } from "../infra/store.ts";
import { type Dispatch, listDispatches, pendingDispatches } from "./dispatches.ts";
import { finalizeDispatch, waitForFinish } from "./finalize.ts";
import type { Deps } from "./ports.ts";
import { listRuns, type Run } from "./run-store.ts";
import { refreshState } from "./state.ts";

/**
 * Builds before the spec.json fix (plan-2 review I1) wrote every env value of the MCP server into
 * spec.json, readable by others. A spec is read once, when its supervisor starts, so such a file loses
 * its env and becomes 0600. Returns how many it scrubbed.
 */
export function scrubOldSpecs(run: Run): number {
  let n = 0;
  for (const d of listDispatches(run)) {
    const file = dispatchPaths(d.dir).spec;
    try {
      if ((statSync(file).mode & 0o077) === 0) continue;
      const doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      writeJsonAtomic(file, { ...doc, env: {} }, { mode: 0o600 });
      n++;
    } catch {
      // no spec.json, or one that cannot be read: nothing to scrub
    }
  }
  return n;
}

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
    const w = `${run.id}: ${errorMessage(e)}`;
    if (!report.warnings.includes(w)) report.warnings.push(w);
  };
  for (const run of runs) {
    let pending;
    try {
      const scrubbed = scrubOldSpecs(run);
      if (scrubbed) log("warn", "reconcile", { run: run.id, scrubbedSpecs: scrubbed });
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
