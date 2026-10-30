import { existsSync, rmSync, writeFileSync } from "node:fs";
import { CatherdError } from "../domain/errors.ts";
import { git, gitRun, snapshotTree } from "../infra/git.ts";
import type { Deps } from "./ports.ts";
import { claimRunTree, setUp } from "./run-tree.ts";
import type { Run } from "./run-store.ts";
import { checkpointRef, runTree, taskBranch, taskReadyFile, taskTreeDir } from "./tree-path.ts";

const tail = (s: string): string => s.trim().slice(-1_500);

/**
 * Plan 55, spec D5: a writer's own worktree, made (or found again) for the task that owns it: a branch of its own cut
 * from the run's branch as last committed, then set up as the run's tree is (submodules, the plan's Setup:, against
 * the package managers' shared caches). A tree a crash left half made is made again; one that is ready is reused.
 */
export async function claimTaskTree(deps: Deps, run: Run, owner: string): Promise<string> {
  const dir = taskTreeDir(run, owner);
  if (existsSync(taskReadyFile(run, owner)) && existsSync(dir)) return dir;
  await claimRunTree(deps, run);
  const repo = run.meta.repo;
  const branch = taskBranch(run, owner);
  // nothing worked in a tree before its ready mark: a half-made one goes, with its branch
  await gitRun(repo, ["worktree", "remove", "--force", dir]);
  rmSync(dir, { recursive: true, force: true });
  await gitRun(repo, ["worktree", "prune"]);
  await gitRun(repo, ["branch", "-D", branch]);
  const head = await git(runTree(run), ["rev-parse", "HEAD"]);
  if (head.kind !== "ok")
    throw new CatherdError("E_TREE", `the run's tree has no commit to cut ${owner}'s tree from`, {
      fix: "restore the run's tree, then delegate again",
    });
  const r = await gitRun(repo, ["worktree", "add", "--no-track", "-b", branch, dir, head.out.trim()]);
  if (r.code !== 0)
    throw new CatherdError("E_TREE", `git worktree add failed for ${branch}: ${tail(`${r.out}${r.err}`)}`, {
      fix: "fix the repository, then delegate again",
    });
  await setUp(deps, run, dir);
  writeFileSync(taskReadyFile(run, owner), "");
  return dir;
}

/** A merged writer's tree and branch go; its checkpoint refs stay. */
export async function removeTaskTree(run: Run, owner: string): Promise<void> {
  const dir = taskTreeDir(run, owner);
  rmSync(taskReadyFile(run, owner), { force: true });
  await gitRun(run.meta.repo, ["worktree", "remove", "--force", dir]);
  rmSync(dir, { recursive: true, force: true });
  await gitRun(run.meta.repo, ["worktree", "prune"]);
  await gitRun(run.meta.repo, ["branch", "-D", taskBranch(run, owner)]);
}

/**
 * Spec D5's checkpoint: the writer's tree as it is, committed or not, untracked files in, under
 * `refs/catherd/<run>/<owner>/<n>`; the writer's index and files are never touched. Null when there is no tree or git
 * fails.
 */
export async function checkpointTree(run: Run, owner: string, n: number): Promise<string | null> {
  const dir = taskTreeDir(run, owner);
  if (!existsSync(dir)) return null;
  const sha = await snapshotTree(dir);
  if (!sha) return null;
  const ref = checkpointRef(run, owner, n);
  return (await git(dir, ["update-ref", ref, sha])).kind === "ok" ? ref : null;
}
