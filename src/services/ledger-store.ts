import { join } from "node:path";
import {
  applyLedgerPatch,
  type LedgerPatch,
  type LedgerTask,
  type LedgerView,
  ledgerView,
  renderProgress,
  type TaskAttempt,
} from "../domain/ledger.ts";
import { taskAttempts } from "../domain/architect-state.ts";
import type { RunState } from "../domain/run-state.ts";
import { db, ensureRunRow } from "../infra/db.ts";
import { writeTextAtomic } from "../infra/store.ts";
import type { Run } from "./run-store.ts";

/** Spec D2: the ledger's rows, rendered read-only into the run folder after each change. */
/** Plan 48: the ledger as the panel shows it, with the state its tasks' dispatches derive (plan 47 R19). */
export const ledgerOf = (run: Run, s: RunState): LedgerView[] =>
  ledgerView(ledgerTasks(run), taskAttempts(s.arch));

export const LEDGER_DIR = "ledger";

/** The run's ledger tasks, in the order the architect added them. */
export function ledgerTasks(run: Run): LedgerTask[] {
  return (
    db().query("SELECT body FROM ledger_tasks WHERE run_id = ? ORDER BY pos").all(run.id) as {
      body: string;
    }[]
  ).map((r) => JSON.parse(r.body) as LedgerTask);
}

/** The run's progress entries, oldest first. */
export function ledgerProgress(run: Run): { at: string; text: string }[] {
  return db().query("SELECT at, text FROM ledger_progress WHERE run_id = ? ORDER BY id").all(run.id) as {
    at: string;
    text: string;
  }[];
}

/**
 * Applies `patch` and appends `progress`, in one transaction: a patch that does not apply writes nothing
 * (E_INPUT_INVALID). Returns the task list after it.
 */
export function writeLedger(run: Run, i: { tasks?: LedgerPatch; progress?: string }, at: Date): LedgerTask[] {
  const d = db();
  return d
    .transaction(() => {
      ensureRunRow(d, run);
      const tasks = i.tasks ? applyLedgerPatch(ledgerTasks(run), i.tasks) : ledgerTasks(run);
      if (i.tasks) {
        d.query("DELETE FROM ledger_tasks WHERE run_id = ?").run(run.id);
        for (const [pos, t] of tasks.entries())
          d.query("INSERT INTO ledger_tasks (run_id, id, pos, body) VALUES (?, ?, ?, ?)").run(
            run.id,
            t.id,
            pos,
            JSON.stringify(t),
          );
      }
      const text = i.progress?.trim();
      if (text)
        d.query("INSERT INTO ledger_progress (run_id, at, text) VALUES (?, ?, ?)").run(
          run.id,
          at.toISOString(),
          text,
        );
      return tasks;
    })
    .immediate();
}

/** Writes `ledger/tasks.json`, `ledger/progress.md` and `ledger/progress-archive.md` from the rows. */
export function renderLedger(run: Run, attempts: readonly TaskAttempt[] = []): void {
  const dir = join(run.dir, LEDGER_DIR);
  writeTextAtomic(
    join(dir, "tasks.json"),
    `${JSON.stringify(ledgerView(ledgerTasks(run), attempts), null, 2)}\n`,
  );
  const { shown, archive } = renderProgress(ledgerProgress(run));
  writeTextAtomic(join(dir, "progress.md"), shown);
  writeTextAtomic(join(dir, "progress-archive.md"), archive);
}
