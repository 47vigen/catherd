import { CatherdError } from "../domain/errors.ts";
import type { RunRecord } from "../domain/record.ts";
import { awaitsCollect } from "../infra/dispatch-dir.ts";
import { type Dispatch, latestDispatch, listDispatches, liveDispatches, readFailover } from "./dispatches.ts";
import type { Deps } from "./ports.ts";
import { findRun, readRecords, type Run } from "./run-store.ts";
import { runOwner } from "./sessions.ts";

export const WAIT_TIMEOUT_MS = 50_000;
export const ORCHESTRATOR_STALL_MS = 5 * 60_000;
const POLL_MS = 250;

export interface WaitInput {
  run: string;
  names: string[];
  timeout_ms?: number;
}

export interface WaitTarget {
  name: string;
  dispatchId: string;
}

export interface WaitResult {
  run: string;
  status: "ready" | "timeout" | "cancelled";
  completed: WaitTarget[];
  pending: WaitTarget[];
}

/** Timers and cancellation listeners belong to this call and are released together. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
  });
}

/**
 * Waits for the first unread record among the named roles' current dispatches. The MCP server's existing
 * reconciliation owns finalization; this call only observes its durable records and never collects,
 * claims a run, settles a limit or starts a role. Snapshotting dispatch IDs excludes an older attempt;
 * only a persisted, linked automatic failover may replace that snapshot.
 */
export async function wait(_deps: Deps, input: WaitInput, signal?: AbortSignal): Promise<WaitResult> {
  const timeout = input.timeout_ms ?? WAIT_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > WAIT_TIMEOUT_MS)
    throw new CatherdError("E_INPUT_INVALID", `timeout_ms must be an integer from 0 to ${WAIT_TIMEOUT_MS}`);
  if (!input.names.length || input.names.some((name) => !name.trim()))
    throw new CatherdError("E_INPUT_INVALID", "wait requires at least one dispatch name");
  const run = findRun(input.run);
  const targets = [...new Set(input.names)].map((name) => {
    const d = latestDispatch(run, name);
    if (!d)
      throw new CatherdError("E_INPUT_INVALID", `No dispatch named ${name} in run ${run.id}`, {
        fix: "Use the names returned by dispatch or peek for this run.",
      });
    return d;
  });
  const deadline = performance.now() + timeout;
  for (;;) {
    const records = new Map(readRecords(run).records.map((r) => [r.dispatchId, r]));
    const dispatches = new Map(listDispatches(run).map((d) => [d.admit.dispatchId, d]));
    const completed: WaitTarget[] = [];
    const pending: WaitTarget[] = [];
    for (const original of targets) {
      let d = original;
      let settlingLimit = false;
      const visited = new Set<string>();
      while (records.get(d.admit.dispatchId)?.status === "limit") {
        visited.add(d.admit.dispatchId);
        const failover = readFailover(d.dir);
        // Finalization precedes settlement: a limit is not ready until its stand-in or pause is known.
        if (!failover) {
          settlingLimit = true;
          break;
        }
        if (!failover.standIn) break;
        const nextId = failover.standIn.dispatchId;
        const next =
          dispatches.get(nextId) ??
          listDispatches(run).find((candidate) => candidate.admit.dispatchId === nextId);
        if (
          !next ||
          visited.has(next.admit.dispatchId) ||
          next.admit.failoverOf !== d.admit.dispatchId ||
          next.admit.name !== original.admit.name ||
          next.admit.runId !== run.id
        )
          throw new CatherdError("E_INPUT_INVALID", `Invalid failover chain for ${original.admit.name}`, {
            fix: "Inspect this run with peek before waiting again; its failover evidence does not match the dispatch.",
          });
        d = next;
      }
      const target = { name: d.admit.name, dispatchId: d.admit.dispatchId };
      const latest = latestDispatch(run, target.name);
      if (latest?.admit.dispatchId !== target.dispatchId) {
        // Admission can publish a stand-in between our record snapshot and the failover receipt.
        // Recognize its admission ancestry, but wait for the persisted outcome before following it.
        let ancestor: Dispatch | null | undefined = latest;
        const ancestry = new Set<string>();
        while (
          ancestor &&
          ancestor.admit.name === target.name &&
          ancestor.admit.runId === run.id &&
          !ancestry.has(ancestor.admit.dispatchId) &&
          ancestor.admit.dispatchId !== target.dispatchId
        ) {
          ancestry.add(ancestor.admit.dispatchId);
          const parentId: string | undefined = ancestor.admit.failoverOf;
          ancestor = parentId
            ? (dispatches.get(parentId) ??
              listDispatches(run).find((candidate) => candidate.admit.dispatchId === parentId))
            : undefined;
        }
        const limit =
          records.get(target.dispatchId) ??
          readRecords(run).records.find((record) => record.dispatchId === target.dispatchId);
        if (ancestor?.admit.dispatchId === target.dispatchId && limit?.status === "limit") {
          pending.push(target);
          continue;
        }
        throw new CatherdError("E_INPUT_INVALID", `Dispatch ${target.name} changed while waiting`, {
          fix: "Use peek to inspect the new attempt, then call wait again for its name.",
        });
      }
      if (settlingLimit) {
        pending.push(target);
        continue;
      }
      if (!awaitsCollect(d.dir)) continue;
      (records.has(target.dispatchId) ? completed : pending).push(target);
    }
    const status = signal?.aborted
      ? "cancelled"
      : completed.length
        ? "ready"
        : !pending.length || performance.now() >= deadline
          ? "timeout"
          : null;
    if (status) return { run: run.id, status, completed, pending };
    await pause(Math.min(POLL_MS, Math.max(0, deadline - performance.now())), signal);
  }
}

export interface OrchestratorWait {
  since: string;
  seconds: number;
  stalled: boolean;
  unread: number;
}

/** Pure diagnostic: queue acceptance cannot show that the orchestrator processed a completion. */
export function orchestratorWait(
  run: Run,
  now: number,
  records: RunRecord[] = readRecords(run).records,
  hasLive = liveDispatches(run, now).length > 0,
): OrchestratorWait | null {
  const owner = runOwner(run);
  if (!owner || hasLive) return null;
  const unread = new Set(
    listDispatches(run)
      .filter((d) => awaitsCollect(d.dir))
      .map((d) => d.admit.dispatchId),
  );
  if (!records.some((r) => unread.has(r.dispatchId))) return null;
  const ended = records.map((r) => Date.parse(r.endedAt)).filter(Number.isFinite);
  if (!ended.length) return null;
  const since = Math.max(...ended, Date.parse(owner.since) || 0);
  const elapsed = Math.max(0, now - since);
  return {
    since: new Date(since).toISOString(),
    seconds: Math.floor(elapsed / 1000),
    stalled: elapsed >= ORCHESTRATOR_STALL_MS,
    unread: records.filter((r) => unread.has(r.dispatchId)).length,
  };
}
