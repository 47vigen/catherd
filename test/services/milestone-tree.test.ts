import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isCatherdError } from "../../src/domain/errors.ts";
import {
  branchPusher,
  claimTree,
  removeTree,
  treeDir,
  treeLimits,
  treeOf,
} from "../../src/services/milestone-tree.ts";
import { copyPlanInputs } from "../../src/services/plan-input.ts";
import { appendEvent } from "../../src/services/run-events-store.ts";
import { runPaths } from "../../src/services/run-store.ts";
import { startedFields } from "../domain/run-fixtures.ts";
import { commitInClone, snapshotEnv, tempDir } from "../helpers.ts";
import { branchRun, fakeDeps, freshRun } from "./helpers.ts";

afterEach(snapshotEnv());
const realLimits = { ...treeLimits };
afterEach(() => Object.assign(treeLimits, realLimits));

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (isCatherdError(e)) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

const deps = fakeDeps();
const plan = (run: { dir: string }, text: string) => writeFileSync(runPaths(run.dir).plan, text);

describe("claimTree", () => {
  it("claims a milestone from origin's base, not the local one, runs Setup: once, and finds the same tree again", async () => {
    const { repo, origin, run } = branchRun();
    plan(run, "# P\nSetup: echo ok > setup.txt\n");
    commitInClone(origin, "x"); // origin's main moves past the local main
    const a = await claimTree(deps, run, "M1", { known: false });
    expect([a.tree, a.branch, a.base]).toEqual([treeDir(run, "M1"), "t-m1", "main"]);
    expect(sh(a.tree, "rev-parse", "HEAD")).toBe(sh(repo, "rev-parse", "origin/main"));
    expect(sh(a.tree, "rev-parse", "HEAD")).not.toBe(sh(repo, "rev-parse", "main"));
    expect(existsSync(join(a.tree, "setup.txt"))).toBe(true);
    rmSync(join(a.tree, "setup.txt"));
    await claimTree(deps, run, "M1", { known: true });
    expect(existsSync(join(a.tree, "setup.txt"))).toBe(false); // .ready: no second setup
    expect([treeOf(run, "M1"), treeOf(run, null), treeOf(run, "M2")]).toEqual([
      a.tree,
      run.meta.repo,
      run.meta.repo,
    ]);
    expect(sh(a.tree, "for-each-ref", "--format=%(upstream)", "refs/heads/t-m1")).toBe(""); // --no-track
  });

  it("throws E_TREE on a failed Setup:, keeps the tree, and runs Setup: again on the next claim", async () => {
    const { run } = branchRun();
    plan(run, "# P\nSetup: echo boom; exit 3\n");
    const e = await refusal(claimTree(deps, run, "M1", { known: false }));
    expect(e.code).toBe("E_TREE");
    expect(e.message).toMatch(/exited 3/);
    expect(e.message).toContain("boom");
    expect(existsSync(treeDir(run, "M1"))).toBe(true);
    expect(existsSync(join(run.dir, "trees", "M1.ready"))).toBe(false);
    plan(run, "# P\nSetup: true\n");
    await claimTree(deps, run, "M1", { known: false });
    expect(existsSync(join(run.dir, "trees", "M1.ready"))).toBe(true);
  });

  it("times Setup: out at its limit", async () => {
    const { run } = branchRun();
    plan(run, "# P\nSetup: sleep 5\n");
    treeLimits.setupMs = 50;
    const e = await refusal(claimTree(deps, run, "M1", { known: false }));
    expect([e.code, /timed out/.test(e.message)]).toEqual(["E_TREE", true]);
  });

  it("refuses a branch with the milestone's name that is not this run's", async () => {
    const { repo, run } = branchRun();
    sh(repo, "branch", "t-m1");
    const sha = sh(repo, "rev-parse", "t-m1");
    const e = await refusal(claimTree(deps, run, "M1", { known: false }));
    expect([e.code, e.fix?.includes("git branch -m"), sh(repo, "rev-parse", "t-m1")]).toEqual([
      "E_TREE",
      true,
      sha,
    ]);
    expect(existsSync(treeDir(run, "M1"))).toBe(false);
  });

  it("refuses a folder that has another branch checked out", async () => {
    const { repo, run } = branchRun();
    mkdirSync(join(run.dir, "trees"), { recursive: true });
    sh(repo, "worktree", "add", "-b", "other", treeDir(run, "M1"), "main");
    const e = await refusal(claimTree(deps, run, "M1", { known: true }));
    expect([e.code, e.message]).toEqual(["E_TREE", `${treeDir(run, "M1")} has other checked out, not t-m1`]);
  });

  it("re-adds this run's branch when its tree folder is gone", async () => {
    const { run } = branchRun();
    const a = await claimTree(deps, run, "M1", { known: false });
    writeFileSync(join(a.tree, "work.txt"), "w");
    sh(a.tree, "add", "-A");
    sh(a.tree, "commit", "-q", "-m", "work");
    const tip = sh(a.tree, "rev-parse", "HEAD");
    rmSync(a.tree, { recursive: true, force: true });
    const b = await claimTree(deps, run, "M1", { known: true });
    expect([b.tree, sh(b.tree, "rev-parse", "HEAD")]).toEqual([a.tree, tip]);
  });

  it("resumes a claim a crash interrupted: the tree is reused and Setup: runs since it never finished", async () => {
    const { repo, run } = branchRun();
    plan(run, "# P\nSetup: echo ok > setup.txt\n");
    mkdirSync(join(run.dir, "trees"), { recursive: true });
    sh(repo, "worktree", "add", "--no-track", "-b", "t-m1", treeDir(run, "M1"), "origin/main");
    const a = await claimTree(deps, run, "M1", { known: false });
    expect(existsSync(join(a.tree, "setup.txt"))).toBe(true);
    expect(sh(repo, "branch", "--list", "t-m1*").split("\n")).toHaveLength(1);
  });

  it("restores a reused tree's tracked files when its checkout was cut off (no .ready)", async () => {
    const { origin, run } = branchRun();
    commitInClone(origin, "f", { path: "tracked.txt", text: "t" });
    const a = await claimTree(deps, run, "M1", { known: false });
    rmSync(join(run.dir, "trees", "M1.ready"));
    const tracked = "tracked.txt";
    rmSync(join(a.tree, tracked));
    writeFileSync(join(a.tree, "mine.txt"), "untracked");
    await claimTree(deps, run, "M1", { known: true });
    expect(existsSync(join(a.tree, tracked))).toBe(true);
    expect(existsSync(join(a.tree, "mine.txt"))).toBe(true); // no git clean
  });

  it("takes Setup: from the run's plan input copies when plan.md has none", async () => {
    const { run } = branchRun();
    const file = join(tempDir("tree-plan-"), "p.md");
    writeFileSync(file, "# Plan\nSetup: echo copied > setup.txt\n\n### Task 1: x\nbody\n");
    copyPlanInputs(run, [file]);
    await appendEvent(run, { type: "run.started", ...startedFields, plan: [file], base: "main" });
    const a = await claimTree(deps, run, "M1", { known: false });
    expect(existsSync(join(a.tree, "setup.txt"))).toBe(true);
  });

  it("works from the last fetch when origin cannot be reached, and says so", async () => {
    const { repo, run } = branchRun();
    sh(repo, "remote", "set-url", "origin", join(run.dir, "nonexistent"));
    const a = await claimTree(deps, run, "M1", { known: false });
    expect(a.hints.join(" ")).toMatch(/last fetch/);
    expect(existsSync(a.tree)).toBe(true);
  });

  it("refuses a run without a base", async () => {
    const { run } = freshRun();
    expect((await refusal(claimTree(deps, run, "M1", { known: false }))).code).toBe("E_INPUT_INVALID");
  });
});

describe("removeTree", () => {
  it("never removes a tree with untracked files, and removes a clean one, ignored files and all, keeping its branch", async () => {
    const { repo, run } = branchRun();
    const a = await claimTree(deps, run, "M1", { known: false });
    writeFileSync(join(a.tree, "notes.txt"), "mine");
    const kept = await removeTree(run, "M1");
    expect(kept.removed).toBe(false);
    expect(kept.hint).toContain("kept");
    expect(kept.hint).toContain("use --force"); // git's own words
    expect(existsSync(join(a.tree, "notes.txt"))).toBe(true);
    rmSync(join(a.tree, "notes.txt"));
    writeFileSync(join(a.tree, ".git", "..", ".gitignore"), "build/\n");
    sh(a.tree, "add", "-A");
    sh(a.tree, "commit", "-q", "-m", "ignore build");
    mkdirSync(join(a.tree, "build"));
    writeFileSync(join(a.tree, "build", "out.js"), "x");
    expect(await removeTree(run, "M1")).toEqual({ removed: true, hint: null });
    expect(existsSync(a.tree)).toBe(false);
    expect(existsSync(join(run.dir, "trees", "M1.ready"))).toBe(false);
    expect(sh(repo, "rev-parse", "--verify", "t-m1").length).toBeGreaterThan(0);
    expect(await removeTree(run, "M1")).toEqual({ removed: false, hint: null });
  });
});

describe("treeOf", () => {
  it("is the repo for a run without base", () => {
    const { repo, run } = freshRun();
    expect(treeOf(run, "M1")).toBe(repo);
    expect(existsSync(join(run.dir, "trees"))).toBe(false);
  });
});

describe("treeOf of a claimed milestone whose folder is gone", () => {
  it("throws E_TREE instead of falling back to the repo, and the repo is untouched", async () => {
    const { repo, run } = branchRun();
    const a = await claimTree(deps, run, "M1", { known: false });
    rmSync(a.tree, { recursive: true, force: true });
    expect(treeOf(run, "M2")).toBe(repo); // not claimed: still the repo
    const e = await refusal(Promise.resolve().then(() => treeOf(run, "M1")));
    expect([e.code, e.message]).toEqual(["E_TREE", `the worktree of M1 is gone: ${a.tree}`]);
    expect(e.fix).toContain("cancel the run");
  });
});

describe("branchPusher", () => {
  it("pushes the branch to a local origin, and names git's failure", async () => {
    const { repo, origin, run } = branchRun();
    const a = await claimTree(deps, run, "M1", { known: false });
    await branchPusher.push(a.tree, a.branch);
    expect(sh(origin, "rev-parse", "--verify", "t-m1")).toBe(sh(a.tree, "rev-parse", "HEAD"));
    sh(repo, "remote", "set-url", "origin", join(run.dir, "nonexistent"));
    const e = await refusal(branchPusher.push(a.tree, a.branch));
    expect([e.code, e.message.startsWith("git push of t-m1 failed")]).toEqual(["E_TREE", true]);
  });
});
