import { join } from "node:path";
import { type ArchState, heldOracles } from "../domain/architect-state.ts";
import { git, snapshotTree } from "../infra/git.ts";
import { writeTextAtomic } from "../infra/store.ts";
import { ledgerTasks } from "./ledger-store.ts";
import { replayRun } from "./run-events-store.ts";
import type { Run } from "./run-store.ts";
import { runTree } from "./tree-path.ts";

/** Plan 54: where a task's oracle diff is kept, in the run dir. */
export const oracleDiffFile = (taskId: string): string => `tasks/${taskId}/oracle.diff`;

/** The oracle paths of `ledgerTask`, or none. */
export const oracleOf = (run: Run, ledgerTask: string | null): string[] =>
  ledgerTask === null ? [] : (ledgerTasks(run).find((l) => l.id === ledgerTask)?.oracle ?? []);

const lines = (s: string): string[] =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * Plan 54, spec D9: what a writer task changed in its ledger task's oracle, against the tree it was delegated on, with
 * the diff written to the run dir. Null for any other task, an untouched oracle, or a git failure. On the shared tree
 * the diff holds every edit made while the task worked, its own and any other's.
 */
export async function oracleChange(
  run: Run,
  taskId: string,
): Promise<{ paths: string[]; diff: string } | null> {
  const t = replayRun(run).arch.tasks[taskId];
  if (!t?.snapshot || (t.role !== "worker" && t.role !== "writer")) return null;
  const oracle = oracleOf(run, t.ledgerTask);
  if (oracle.length === 0) return null;
  let tree: string;
  try {
    tree = runTree(run);
  } catch {
    return null;
  }
  const after = await snapshotTree(tree);
  if (!after) return null;
  const names = await git(tree, ["diff", "--name-only", t.snapshot, after, "--", ...oracle]);
  const paths = names.kind === "ok" ? lines(names.out) : [];
  if (paths.length === 0) return null;
  const diff = await git(tree, ["diff", t.snapshot, after, "--", ...paths]);
  writeTextAtomic(join(run.dir, oracleDiffFile(taskId)), diff.kind === "ok" ? diff.out : "");
  return { paths, diff: oracleDiffFile(taskId) };
}

/**
 * Plan 54, spec D9: each held oracle change the tree at HEAD still carries, as what land final needs; a change the
 * writer's next attempt restored is released. A diff git cannot take (its snapshot is gone) still holds.
 */
export async function unreleasedOracles(tree: string, a: ArchState): Promise<string[]> {
  const out: string[] = [];
  for (const t of heldOracles(a)) {
    const paths = t.oracle?.paths ?? [];
    const same =
      t.snapshot !== null &&
      (await git(tree, ["diff", "--quiet", t.snapshot, "HEAD", "--", ...paths])).kind === "ok";
    if (!same)
      out.push(
        `${t.taskId}'s change to ${paths.join(", ")}, the oracle of ${t.ledgerTask}, accepted with oracle_accept or restored`,
      );
  }
  return out;
}
