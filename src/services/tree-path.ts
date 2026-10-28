import { existsSync } from "node:fs";
import { join } from "node:path";
import { CatherdError } from "../domain/errors.ts";
import type { Run } from "./run-store.ts";

/** `<run dir>/trees/run`: the integration tree of a base run (spec D5), on the run's own branch. */
export const treeDir = (run: Run): string => join(run.dir, "trees", "run");

/** The marker beside the tree, never inside it, that Setup: finished. */
export const readyFile = (run: Run): string => join(run.dir, "trees", "run.ready");

/**
 * Where a run's roles and checks work: a base run's integration tree, else the repository's checkout. A base run whose
 * tree is not there is an error, never the checkout: its work, checks and push would land in the owner's own tree.
 * Kept apart from run-tree.ts so the services that only ask where a run works do not import the claiming code.
 */
export function runTree(run: Run): string {
  if (!run.meta.base) return run.meta.repo;
  const tree = treeDir(run);
  if (existsSync(tree) && existsSync(readyFile(run))) return tree;
  throw new CatherdError(
    "E_TREE",
    existsSync(readyFile(run))
      ? `the run's tree is gone: ${tree}`
      : `the run's tree is not set up yet: ${tree}`,
    { fix: "restore the tree (git worktree add it back on the run's branch) or cancel the run" },
  );
}

/** The compose project of a base run's tree (`-base` for its baseline tree): one stack per tree. */
export const composeProjectOf = (run: Run, baseline = false): string | null =>
  run.meta.base ? `catherd-${run.id.slice(0, 15).replace("-", "")}${baseline ? "-base" : ""}` : null;
