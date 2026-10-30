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
  // a half-made folder goes; a branch stays when it holds commits the run's branch lacks (catherd's commit of the
  // writer's work), since the folder alone was lost
  await gitRun(repo, ["worktree", "remove", "--force", dir]);
  rmSync(dir, { recursive: true, force: true });
  await gitRun(repo, ["worktree", "prune"]);
  const head = await git(runTree(run), ["rev-parse", "HEAD"]);
  if (head.kind !== "ok")
    throw new CatherdError("E_TREE", `the run's tree has no commit to cut ${owner}'s tree from`, {
      fix: "restore the run's tree, then delegate again",
    });
  const kept = await git(repo, ["rev-list", "--count", `${head.out.trim()}..refs/heads/${branch}`]);
  const unmerged = kept.kind === "ok" && Number(kept.out.trim()) > 0;
  const add = unmerged
    ? ["worktree", "add", dir, branch]
    : await (async () => {
        await gitRun(repo, ["branch", "-D", branch]);
        // the writer's last checkpoint holds work the folder lost; else the run's branch as last committed
        return [
          "worktree",
          "add",
          "--no-track",
          "-b",
          branch,
          dir,
          (await latestCheckpoint(run, owner)) ?? head.out.trim(),
        ];
      })();
  const r = await gitRun(repo, add);
  if (r.code !== 0)
    throw new CatherdError("E_TREE", `git worktree add failed for ${branch}: ${tail(`${r.out}${r.err}`)}`, {
      fix: "fix the repository, then delegate again",
    });
  await setUp(deps, run, dir);
  writeFileSync(taskReadyFile(run, owner), "");
  return dir;
}

/** The sha of the owner's highest-numbered checkpoint ref, else null. */
async function latestCheckpoint(run: Run, owner: string): Promise<string | null> {
  const r = await git(run.meta.repo, [
    "for-each-ref",
    "--format=%(refname) %(objectname)",
    `refs/catherd/${run.id}/${owner}/`,
  ]);
  if (r.kind !== "ok") return null;
  const found = r.out
    .split("\n")
    .map((l) => /\/(\d+) ([0-9a-f]+)$/.exec(l.trim()))
    .filter((x): x is RegExpExecArray => x !== null)
    .map((x) => ({ n: Number(x[1]), sha: x[2] as string }));
  return found.sort((x, y) => y.n - x.n)[0]?.sha ?? null;
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
