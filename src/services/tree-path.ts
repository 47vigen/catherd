import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Run } from "./run-store.ts";

/** `<run dir>/trees/<m>`: where milestone `m` of a base run works. */
export const treeDir = (run: Run, m: string): string => join(run.dir, "trees", m);

/**
 * Where milestone `m` works: its worktree in a base run once it exists, else the repo (a run without base, the
 * run itself, a milestone not claimed yet). Kept apart from milestone-tree.ts so the services that only ask
 * where a milestone works do not import the claiming code, which imports them.
 */
export function treeOf(run: Run, m: string | null): string {
  if (!run.meta.base || m === null) return run.meta.repo;
  const tree = treeDir(run, m);
  return existsSync(tree) ? tree : run.meta.repo;
}
