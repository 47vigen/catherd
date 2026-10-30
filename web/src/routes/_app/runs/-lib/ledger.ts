import type { FlowTask } from "../../../../client";

/** The order the header reads a ledger in: what runs now, then what waits, then what is finished. */
const ORDER: FlowTask["state"][] = ["running", "review", "blocked", "impossible", "todo", "done"];

/**
 * "1 running · 2 blocked · 5 todo of 8": the ledger's own states and count, so a header never reports the graph's
 * nodes as if they were the plan. Null when the ledger is empty (there is nothing to count yet).
 */
export function ledgerSummary(tasks: readonly FlowTask[]): string | null {
  if (tasks.length === 0) return null;
  const counts = new Map<string, number>();
  for (const t of tasks) counts.set(t.state, (counts.get(t.state) ?? 0) + 1);
  const parts = ORDER.filter((state) => counts.has(state)).map((state) => `${counts.get(state)} ${state}`);
  return `${parts.join(" · ")} of ${tasks.length}`;
}

/** One ledger task, or the count of them: the noun the header uses in place of "milestones" on architect runs. */
export const ledgerTasks = (n: number): string => `${n} ${n === 1 ? "ledger task" : "ledger tasks"}`;
