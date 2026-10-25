import { existsSync } from "node:fs";
import { join } from "node:path";
import { CatherdError } from "../domain/errors.ts";
import type { Run } from "./run-store.ts";

/** `<run dir>/trees/<m>`: where milestone `m` of a base run works. */
export const treeDir = (run: Run, m: string): string => join(run.dir, "trees", m);

/** The marker beside the tree, never inside it, that Setup: finished. */
export const readyFile = (run: Run, m: string): string => join(run.dir, "trees", `${m}.ready`);

/**
 * Where milestone `m` works: its worktree in a base run once it exists, else the repo (a run without base, the
 * run itself, a milestone not claimed yet). A claimed milestone whose folder is gone is an error, never the repo:
 * its commits, checks and merge would land in the owner's own checkout. Kept apart from milestone-tree.ts so the services that only ask
 * where a milestone works do not import the claiming code, which imports them.
 */
export function treeOf(run: Run, m: string | null): string {
  if (!run.meta.base || m === null) return run.meta.repo;
  const tree = treeDir(run, m);
  if (existsSync(tree)) return tree;
  if (existsSync(readyFile(run, m)))
    throw new CatherdError("E_TREE", `the worktree of ${m} is gone: ${tree}`, {
      fix: "restore the tree (git worktree add it back on the milestone's branch) or cancel the run",
    });
  return run.meta.repo;
}

/** The compose project of milestone `m`'s tree in a base run (`-base` for its baseline tree): one stack per tree. */
export const composeProjectOf = (run: Run, m: string | null, baseline = false): string | null =>
  !run.meta.base || m === null
    ? null
    : `catherd-${run.id.slice(0, 15).replace("-", "")}-${m.toLowerCase()}${baseline ? "-base" : ""}`;
