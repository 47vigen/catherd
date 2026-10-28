import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planSetup, runBranch } from "../domain/branch.ts";
import { CatherdError } from "../domain/errors.ts";
import { currentBranch, fetchBase, git, gitRun, updateSubmodules } from "../infra/git.ts";
import { heavySlots, withHeavySlot } from "../infra/heavy-lock.ts";
import { ensurePrivateDir } from "../infra/store.ts";
import type { Deps } from "./ports.ts";
import { planDocs } from "./plan-input.ts";
import { checkEnvFor, runCheck } from "./check-command.ts";
import { runProfile } from "./run-pin.ts";
import { type Run, runPaths } from "./run-store.ts";
import { readyFile, treeDir } from "./tree-path.ts";

/** How long a plan's `Setup:` command may run (tests shorten it: it is the seam for a slow install). */
export const treeLimits = { setupMs: 15 * 60_000 };

const PUSH_MS = 120_000;
const TAIL = 1_500;

/** `git -C <tree> push -u origin <branch>`, never forced: the one push catherd makes (spec D11). Tests replace it. */
export const branchPusher = {
  push: async (tree: string, branch: string): Promise<void> => {
    const r = await gitRun(tree, ["push", "-u", "origin", branch], PUSH_MS);
    if (r.code !== 0)
      throw new CatherdError(
        "E_TREE",
        `git push of ${branch} failed: ${r.timedOut ? `timed out after ${PUSH_MS / 1000} s` : tail(`${r.out}${r.err}`)}`,
        { fix: "fix the remote (a rejected push is never forced), then land again" },
      );
  },
};

const tail = (s: string): string => s.trim().slice(-TAIL);

export interface TreeClaim {
  tree: string;
  branch: string;
  base: string;
  hints: string[];
}

const tree_ = (message: string, fix: string) => new CatherdError("E_TREE", message, { fix });

const seconds = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.ceil(ms / 1000)} s`;

/** The first `Setup:` line of plan.md, else of the plan's input copies. */
function setupOf(run: Run): string | null {
  let own = "";
  try {
    own = readFileSync(runPaths(run.dir).plan, "utf8");
  } catch {
    // no plan.md: the input copies may have the line
  }
  for (const text of [own, ...planDocs(run).map((d) => d.text)]) {
    const cmd = planSetup(text);
    if (cmd) return cmd;
  }
  return null;
}

/** Submodules, then the plan's Setup: command, in a heavy slot with the gate's check env. */
async function setUp(deps: Deps, run: Run, tree: string): Promise<void> {
  const setup = setupOf(run);
  const submodules = existsSync(join(tree, ".gitmodules"));
  if (!setup && !submodules) return;
  const env = await checkEnvFor(run.meta.repo);
  await withHeavySlot(heavySlots(runProfile(deps, run).heavy), async (_slot, tmp) => {
    if (submodules) {
      const r = await updateSubmodules(tree, treeLimits.setupMs);
      if (r.code !== 0)
        throw tree_(
          `git submodule update failed in ${tree}: ${r.timedOut ? "timed out" : tail(`${r.out}${r.err}`)}`,
          "make the submodule host reachable, then answer",
        );
    }
    if (!setup) return;
    const r = await runCheck(tree, setup, treeLimits.setupMs, { ...env, TMPDIR: tmp, GOTMPDIR: tmp });
    if (r.timedOut || r.code !== 0)
      throw tree_(
        `Setup: ${setup} ${r.timedOut ? `timed out after ${seconds(treeLimits.setupMs)}` : `exited ${r.code}`} in ${tree}: ${tail(r.tail.join("\n"))}`,
        "correct the Setup: line in plan.md or the machine, then answer",
      );
  });
}

/**
 * Spec D5, stage 1: makes (or finds again) a base run's integration tree, one per run: the run's branch from
 * `origin/<base>` after a fetch, set up once. A claim a crash interrupted reuses the folder and runs Setup: again,
 * since `.ready` was never written. A branch of the run's name that this run did not make is refused.
 */
export async function claimRunTree(deps: Deps, run: Run): Promise<TreeClaim> {
  const base = run.meta.base;
  if (!base)
    throw new CatherdError("E_INPUT_INVALID", `run ${run.id} has no base branch`, {
      fix: "start the run with run_start base",
    });
  const repo = run.meta.repo;
  const branch = runBranch(run.meta.title);
  const tree = treeDir(run);
  const hints: string[] = [];
  if (branch === base)
    throw tree_(
      `the run's branch ${branch} is the base`,
      "start the run with a title that is not the base's name",
    );
  if (existsSync(readyFile(run)) && existsSync(tree)) return { tree, branch, base, hints };
  if (!(await fetchBase(repo, base)))
    hints.push(`fetch of origin/${base} failed: using the copy from the last fetch`);
  if (existsSync(tree)) {
    const have = await currentBranch(tree);
    if (have !== branch)
      throw tree_(
        `${tree} has ${have ?? "no branch"} checked out, not ${branch}`,
        "move the folder away, then answer",
      );
    // a `git worktree add` cut off mid-checkout leaves the right HEAD and a part of the files: not complete
    const r = await gitRun(tree, ["reset", "--hard", "-q", "HEAD"]);
    if (r.code !== 0)
      throw tree_(`git reset of ${tree} failed: ${tail(`${r.out}${r.err}`)}`, "fix the folder, then answer");
  } else {
    // a registered entry whose folder is gone blocks `worktree add`; clear only this tree's, never the owner's others
    await gitRun(repo, ["worktree", "remove", tree]);
    ensurePrivateDir(join(run.dir, "trees"));
    const exists = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    // a branch of the run's name is its own only when this run's tree was set up before (its folder since lost)
    const ours = existsSync(readyFile(run));
    if (exists.kind === "ok" && !ours)
      throw tree_(
        `branch ${branch} exists and is not this run's`,
        `rename it (git branch -m ${branch} ${branch}-old) or delete it, then answer`,
      );
    const args =
      exists.kind === "ok"
        ? ["worktree", "add", tree, branch]
        : ["worktree", "add", "--no-track", "-b", branch, tree, `origin/${base}`];
    const r = await gitRun(repo, args);
    if (r.code !== 0)
      throw tree_(
        `git worktree add failed for ${branch}: ${tail(`${r.out}${r.err}`)}`,
        "fix the repository, then answer",
      );
  }
  await setUp(deps, run, tree);
  writeFileSync(readyFile(run), "");
  return { tree, branch, base, hints };
}
