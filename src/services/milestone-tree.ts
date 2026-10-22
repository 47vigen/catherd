import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { milestoneBranch, planSetup } from "../domain/branch.ts";
import { CatherdError } from "../domain/errors.ts";
import { availableMemoryMb } from "../infra/memory.ts";
import { currentBranch, fetchBase, git, gitRun } from "../infra/git.ts";
import { heavySlots, withHeavySlot } from "../infra/heavy-lock.ts";
import { ensurePrivateDir } from "../infra/store.ts";
import type { Deps } from "./ports.ts";
import { planDocs } from "./plan-input.ts";
import { checkEnvFor, runCheck } from "./preflight.ts";
import { runProfile } from "./run-pin.ts";
import { type Run, runPaths } from "./run-store.ts";
import { readyFile, treeDir, treeOf } from "./tree-path.ts";

/** How long a plan's `Setup:` command may run (tests shorten it: it is the seam for a slow install). */
export const treeLimits = { setupMs: 15 * 60_000 };

/** The machine's available memory in MB; tests replace it. */
export const memoryReader = { read: (): number => availableMemoryMb() };

const PUSH_MS = 120_000;
const TAIL = 1_500;

/** `git -C <tree> push -u origin <branch>`: the one push catherd makes, on the owner's word. Tests replace it. */
export const branchPusher = {
  push: async (tree: string, branch: string): Promise<void> => {
    const r = await gitRun(tree, ["push", "-u", "origin", branch], PUSH_MS);
    if (r.code !== 0)
      throw new CatherdError(
        "E_TREE",
        `git push of ${branch} failed: ${r.timedOut ? `timed out after ${PUSH_MS / 1000} s` : tail(`${r.out}${r.err}`)}`,
        { fix: "fix the remote or push it yourself, then answer" },
      );
  },
};

const tail = (s: string): string => s.trim().slice(-TAIL);

export { treeDir, treeOf };

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
      const r = await gitRun(tree, ["submodule", "update", "--init", "--recursive"], treeLimits.setupMs);
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
 * Makes (or finds again) milestone `m`'s worktree: a branch from `origin/<base>` after a fetch, set up once. A claim a
 * crash interrupted reuses the folder and runs Setup: again, since `.ready` was never written. `known` says a
 * `tree.ready` happened for `m` before, so a branch of its name is this run's own.
 */
export async function claimTree(deps: Deps, run: Run, m: string, o: { known: boolean }): Promise<TreeClaim> {
  const base = run.meta.base;
  if (!base)
    throw new CatherdError("E_INPUT_INVALID", `run ${run.id} has no base branch`, {
      fix: "start the run with run_start base",
    });
  const repo = run.meta.repo;
  const branch = milestoneBranch(run.meta.title, m);
  const tree = treeDir(run, m);
  const hints: string[] = [];
  if (!(await fetchBase(repo, base)))
    hints.push(`fetch of origin/${base} failed: using the copy from the last fetch`);
  await git(repo, ["worktree", "prune"]);
  if (existsSync(tree)) {
    const have = await currentBranch(tree);
    if (have !== branch)
      throw tree_(
        `${tree} has ${have ?? "no branch"} checked out, not ${branch}`,
        "move the folder away, then answer",
      );
    // a `git worktree add` cut off mid-checkout leaves the right HEAD and a part of the files: not complete
    if (!existsSync(readyFile(run, m))) {
      const r = await gitRun(tree, ["reset", "--hard", "-q", "HEAD"]);
      if (r.code !== 0)
        throw tree_(
          `git reset of ${tree} failed: ${tail(`${r.out}${r.err}`)}`,
          "fix the folder, then answer",
        );
    }
  } else {
    ensurePrivateDir(join(run.dir, "trees"));
    const exists = await git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (exists.kind === "ok" && !o.known)
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
  if (!existsSync(readyFile(run, m))) {
    await setUp(deps, run, tree);
    mkdirSync(join(run.dir, "trees"), { recursive: true });
    writeFileSync(readyFile(run, m), "");
  }
  return { tree, branch, base, hints };
}

/**
 * Removes a merged milestone's worktree with `git worktree remove` (never `--force`), keeping its branch. A tree with
 * uncommitted or untracked files stays, with a hint that says so.
 */
export async function removeTree(run: Run, m: string): Promise<{ removed: boolean; hint: string | null }> {
  const tree = treeDir(run, m);
  if (!existsSync(tree)) return { removed: false, hint: null };
  const r = await gitRun(run.meta.repo, ["worktree", "remove", tree]);
  if (r.code !== 0)
    return {
      removed: false,
      hint: `kept ${tree}: ${tail(`${r.err}${r.out}`)}; git worktree remove it once that is settled`,
    };
  rmSync(readyFile(run, m), { force: true });
  return { removed: true, hint: null };
}
