import { readFileSync, statSync } from "node:fs";
import { errorMessage } from "../domain/errors.ts";
import { dispatchPaths } from "../infra/dispatch-dir.ts";
import { log } from "../infra/log.ts";
import { writeJsonAtomic } from "../infra/store.ts";
import { recoverOwned, settle, stallPoll, unsettledLimits, watching } from "./dispatch-service.ts";
import { type Dispatch, listDispatches, pendingDispatches } from "./dispatches.ts";
import { finalizeDispatch, waitForFinish } from "./finalize.ts";
import type { Deps } from "./ports.ts";
import { listRuns, type Run } from "./run-store.ts";
import { ownsRun } from "./sessions.ts";

/**
 * Builds before the spec.json fix (plan-2 review I1) wrote every env value of the MCP server into
 * spec.json, readable by others. A spec is read once, when its supervisor starts, so such a file loses
 * its env and becomes 0600. Returns how many it scrubbed.
 */
function scrubOldSpecs(run: Run): number {
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
 * Waits for a live dispatch this process did not start, then finalizes and settles it (plan 10). A state.md
 * refresh that fails rejects, after the record is written, with a message that says so.
 */
async function watchAndFinalize(deps: Deps, run: Run, d: Dispatch): Promise<void> {
  watching.add(d.admit.dispatchId);
  try {
    await waitForFinish(d, { pollMs: deps.pollMs, now: deps.now, onPoll: stallPoll(run, d) });
    const record = await finalizeDispatch(run, d);
    // a limit of a run this session does not own waits, unread, for the session that claims the run
    if (record.status === "limit" && !ownsRun(deps, run)) return;
    const s = await settle(deps, run, d, record);
    if (s.stateHints[0]) throw new Error(s.stateHints[0]);
  } finally {
    watching.delete(d.admit.dispatchId);
  }
}

/**
 * Plan 22, final-review I2: a server that does not lead the boot still watches the live roles of the runs its
 * own session owns, so a coordinator's server that restarts mid-run (an /mcp reconnect, a crash) while another
 * session's server holds the boot lock still finalizes and announces them. It also records and announces the
 * roles of those runs that finished while it was away (no live process, no record: PR #47 P1), as a claim
 * does. A second watcher of a dispatch the lead also watches is harmless: finalize and failover run once, and
 * a role another live process is finalizing is left to it. A run that cannot be read is skipped, logged.
 */
export function adoptOwned(deps: Deps): void {
  for (const run of listRuns().runs) {
    try {
      if (!ownsRun(deps, run)) continue;
      recoverOwned(deps, run, { background: true }).catch((e: unknown) =>
        log("warn", "reconcile", { run: run.id, error: errorMessage(e) }),
      );
    } catch (e) {
      log("warn", "reconcile", { run: run.id, error: errorMessage(e) });
    }
  }
}

/**
 * Spec §4.7: on server start, finalize and settle each finished dispatch that has no record, settle each
 * unread usage limit that was never failed over (its server died between the two), and watch each live one
 * until it finishes. A run that cannot be read is skipped with a warning; it never stops the server.
 *
 * Plan 10 fix-round ruling: a usage limit fails over here only in a run this session owns. A limit of a run
 * another session owns, or no session does (a 1.0 run, a run started outside Claude Code), is only recorded:
 * the session that claims the run settles it then (`claim`), so no stale run starts a stand-in on its own.
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
    const mine = ownsRun(deps, run);
    for (const d of pending) {
      if (d.state !== "finished") {
        report.watching.push(d.admit.dispatchId);
        watchers.push(watchAndFinalize(deps, run, d).catch((e: unknown) => warn(run, e)));
        continue;
      }
      let hints: string[] = [];
      try {
        const record = await finalizeDispatch(run, d);
        if (record.status !== "limit" || mine) hints = (await settle(deps, run, d, record)).stateHints;
      } catch (e) {
        warn(run, e);
        continue;
      }
      report.finalized.push(d.admit.dispatchId);
      for (const h of hints) warn(run, h);
    }
    let limits: ReturnType<typeof unsettledLimits> = [];
    try {
      if (mine) limits = unsettledLimits(run);
    } catch (e) {
      warn(run, e);
    }
    for (const { d, record } of limits) {
      try {
        for (const h of (await settle(deps, run, d, record)).stateHints) warn(run, h);
      } catch (e) {
        warn(run, e);
      }
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
