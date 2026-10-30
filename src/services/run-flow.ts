import { deriveRunFlow, type FlowCheckRecord, type RunFlow } from "../domain/run-flow.ts";
import type { RunEvent } from "../domain/run-events.ts";
import type { RunRecord } from "../domain/record.ts";
import { db } from "../infra/db.ts";
import { ledgerTasks } from "./ledger-store.ts";
import { isDaemonRun, isEarlierRun } from "./run-events-store.ts";
import type { Run } from "./run-store.ts";

export function flowOf(run: Run, events: RunEvent[], records: RunRecord[], now: number): RunFlow | null {
  if (!isDaemonRun(run) || isEarlierRun(run)) return null;
  const row = db().query("SELECT legacy FROM runs WHERE id = ?").get(run.id) as { legacy: number } | null;
  if (!row || row.legacy === 1) return null;
  const rows = db()
    .query(
      "SELECT check_id, scope, command, base, exit, failures, at, cached, verdict FROM checks WHERE run_id = ? ORDER BY id",
    )
    .all(run.id) as {
    check_id: string;
    scope: string;
    command: string;
    base: number;
    exit: number | null;
    failures: string;
    at: string;
    cached: number;
    verdict: string | null;
  }[];
  const checks: FlowCheckRecord[] = rows.map((c) => ({
    checkId: c.check_id,
    scope: c.scope,
    command: c.command,
    base: Boolean(c.base),
    exit: c.exit,
    failures: JSON.parse(c.failures) as string[],
    at: c.at,
    cached: Boolean(c.cached),
    verdict: c.verdict,
  }));
  return deriveRunFlow({
    startedAt: events.find((e) => e.type === "run.started")?.at ?? run.meta.createdAt,
    now,
    events,
    records,
    ledgerTasks: ledgerTasks(run),
    checks,
  });
}
