import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claimRunTree } from "../../src/services/run-tree.ts";
import { taskBranch, taskTreeDir } from "../../src/services/tree-path.ts";
import { checkpointTree, claimTaskTree, removeTaskTree } from "../../src/services/writer-tree.ts";
import { snapshotEnv } from "../helpers.ts";
import { branchRun, fakeDeps } from "./helpers.ts";

afterEach(snapshotEnv());

const git = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: dir,
    encoding: "utf8",
  }).trim();

describe("a writer's own worktree (plan 55, spec D5)", () => {
  it("cuts it from the run's branch as last committed, on a branch of its own, and finds it again", async () => {
    const { run } = branchRun("wallet");
    const deps = fakeDeps();
    const { tree: runTree } = await claimRunTree(deps, run);
    writeFileSync(join(runTree, "a.txt"), "committed\n");
    git(runTree, "add", "-A");
    git(runTree, "commit", "-q", "-m", "a");
    writeFileSync(join(runTree, "b.txt"), "not committed\n");
    const dir = await claimTaskTree(deps, run, "T1");
    expect(dir).toBe(taskTreeDir(run, "T1"));
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(taskBranch(run, "T1"));
    expect(git(dir, "rev-parse", "HEAD")).toBe(git(runTree, "rev-parse", "HEAD"));
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("committed\n");
    expect(existsSync(join(dir, "b.txt"))).toBe(false);
    writeFileSync(join(dir, "work.txt"), "mine\n");
    expect(await claimTaskTree(deps, run, "T1")).toBe(dir);
    expect(readFileSync(join(dir, "work.txt"), "utf8")).toBe("mine\n");
  });

  it("makes a half-made tree again: a crash before its ready mark left nothing anyone worked on", async () => {
    const { run } = branchRun("wallet");
    const deps = fakeDeps();
    await claimRunTree(deps, run);
    mkdirSync(taskTreeDir(run, "T2"), { recursive: true });
    writeFileSync(join(taskTreeDir(run, "T2"), "junk"), "x");
    const dir = await claimTaskTree(deps, run, "T2");
    expect(existsSync(join(dir, "junk"))).toBe(false);
    expect(git(dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(taskBranch(run, "T2"));
  });

  it("recreates a tree whose folder is gone on its own branch, keeping the commit catherd made of the writer's work (review I6)", async () => {
    const { run } = branchRun("wallet");
    const deps = fakeDeps();
    await claimRunTree(deps, run);
    const dir = await claimTaskTree(deps, run, "T1");
    writeFileSync(join(dir, "work.txt"), "committed by catherd\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "catherd: T1");
    const tip = git(dir, "rev-parse", "HEAD");
    rmSync(dir, { recursive: true, force: true });
    const again = await claimTaskTree(deps, run, "T1");
    expect(git(again, "rev-parse", "--abbrev-ref", "HEAD")).toBe(taskBranch(run, "T1"));
    expect(git(again, "rev-parse", "HEAD")).toBe(tip);
    expect(readFileSync(join(again, "work.txt"), "utf8")).toBe("committed by catherd\n");
  });

  it("prefers the latest checkpoint to the kept branch when the branch is behind it: uncommitted work after a send-back", async () => {
    const { run } = branchRun("wallet");
    const deps = fakeDeps();
    await claimRunTree(deps, run);
    const dir = await claimTaskTree(deps, run, "T1");
    writeFileSync(join(dir, "work.txt"), "committed by catherd\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "catherd: T1");
    // the send-back ran in the same tree and ended with more, uncommitted
    writeFileSync(join(dir, "more.txt"), "after the send-back\n");
    await checkpointTree(run, "T1", 1);
    rmSync(dir, { recursive: true, force: true });
    const again = await claimTaskTree(deps, run, "T1");
    expect(readFileSync(join(again, "work.txt"), "utf8")).toBe("committed by catherd\n");
    expect(readFileSync(join(again, "more.txt"), "utf8")).toBe("after the send-back\n");
    expect(git(again, "rev-parse", "--abbrev-ref", "HEAD")).toBe(taskBranch(run, "T1"));
  });

  it("keeps the branch when it is ahead of the latest checkpoint", async () => {
    const { run } = branchRun("wallet");
    const deps = fakeDeps();
    await claimRunTree(deps, run);
    const dir = await claimTaskTree(deps, run, "T1");
    writeFileSync(join(dir, "one.txt"), "first\n");
    await checkpointTree(run, "T1", 1);
    writeFileSync(join(dir, "two.txt"), "committed later\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "catherd: T1");
    rmSync(dir, { recursive: true, force: true });
    const again = await claimTaskTree(deps, run, "T1");
    expect(readFileSync(join(again, "two.txt"), "utf8")).toBe("committed later\n");
  });

  it("recreates a tree whose folder and branch are gone on its latest checkpoint (review I6)", async () => {
    const { run } = branchRun("wallet");
    const deps = fakeDeps();
    await claimRunTree(deps, run);
    const dir = await claimTaskTree(deps, run, "T1");
    writeFileSync(join(dir, "one.txt"), "first\n");
    await checkpointTree(run, "T1", 1);
    writeFileSync(join(dir, "two.txt"), "second\n");
    await checkpointTree(run, "T1", 2);
    rmSync(dir, { recursive: true, force: true });
    git(run.meta.repo, "worktree", "prune");
    git(run.meta.repo, "branch", "-D", taskBranch(run, "T1"));
    const again = await claimTaskTree(deps, run, "T1");
    expect(readFileSync(join(again, "one.txt"), "utf8")).toBe("first\n");
    expect(readFileSync(join(again, "two.txt"), "utf8")).toBe("second\n");
    expect(git(again, "rev-parse", "--abbrev-ref", "HEAD")).toBe(taskBranch(run, "T1"));
  });

  it("checkpoints the tree under a ref, untracked files in and the index untouched, and keeps the ref after removal", async () => {
    const { run } = branchRun("wallet");
    const deps = fakeDeps();
    const dir = await claimTaskTree(deps, run, "T1");
    writeFileSync(join(dir, "new.txt"), "untracked\n");
    const ref = await checkpointTree(run, "T1", 1);
    expect(ref).toBe(`refs/catherd/${run.id}/T1/1`);
    expect(git(dir, "show", `${ref}:new.txt`)).toBe("untracked");
    expect(git(dir, "status", "--porcelain")).toBe("?? new.txt");
    await removeTaskTree(run, "T1");
    expect(existsSync(dir)).toBe(false);
    expect(git(run.meta.repo, "branch", "--list", taskBranch(run, "T1"))).toBe("");
    expect(git(run.meta.repo, "show", `${ref}:new.txt`)).toBe("untracked");
    expect(await checkpointTree(run, "T1", 2)).toBeNull();
  });
});
