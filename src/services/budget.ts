import { existsSync, readFileSync } from "node:fs";
import { adapterFor } from "../adapters/registry.ts";
import "../adapters/all.ts";
import { type Budget, type BudgetStatus, budgetStatus, type Spend } from "../domain/budget.ts";
import { CatherdError } from "../domain/errors.ts";
import type { RunRecord } from "../domain/record.ts";
import { dispatchPaths } from "../infra/dispatch-dir.ts";
import { type Dispatch, liveDispatches } from "./dispatches.ts";
import { readAgentRuns, readRecords, type Run } from "./run-store.ts";

/** Tokens a running dispatch has used so far, summed from the events its CLI has written. */
export function liveTokens(d: Dispatch, strict = false): number {
  const a = adapterFor(d.admit.backend);
  const file = dispatchPaths(d.dir).events;
  if (!a || !existsSync(file)) return 0;
  let n = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const t = a.parse(line).tokens;
      if (t) {
        if (strict && Object.values(t).some((value) => !Number.isFinite(value) || value < 0))
          throw new CatherdError("E_RUN_CORRUPT", `dispatch ${d.admit.dispatchId} has invalid token usage`);
        n += t.input + t.output;
      }
    } catch (error) {
      if (strict && error instanceof CatherdError) throw error;
      // a line the adapter cannot read adds nothing
    }
  }
  return n;
}

/**
 * Spec §4.6: minutes are wall clock since run_start; tokens and dollars sum every record (every
 * backend), every native subagent run the orchestrator reported, and what live roles used so far.
 */
export function spendOf(
  run: Run,
  records: RunRecord[],
  live: Dispatch[],
  now: number,
  strict = false,
): Spend {
  const agents = readAgentRuns(run, strict);
  if (strict) {
    const invalid = (value: number | null) => value !== null && (!Number.isFinite(value) || value < 0);
    if (
      records.some((record) => Object.values(record.tokens).some(invalid) || invalid(record.costUsd)) ||
      agents.some((agent) => invalid(agent.totalTokens) || invalid(agent.costUsd))
    )
      throw new CatherdError("E_RUN_CORRUPT", `run ${run.id} has invalid cost or token usage`);
  }
  const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((n, x) => n + f(x), 0);
  return {
    minutes: Math.max(0, (now - Date.parse(run.meta.createdAt)) / 60_000),
    tokens:
      sum(records, (r) => r.tokens.input + r.tokens.output) +
      sum(agents, (a) => a.totalTokens) +
      sum(live, (dispatch) => liveTokens(dispatch, strict)),
    usd: sum(records, (r) => r.costUsd ?? 0) + sum(agents, (a) => a.costUsd ?? 0),
  };
}

export function budgetOf(run: Run, budget: Budget, now: number): BudgetStatus | null {
  return budgetStatus(spendOf(run, readRecords(run).records, liveDispatches(run, now), now), budget);
}
