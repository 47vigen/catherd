import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isCatherdError } from "../../src/domain/errors.ts";
import { runPaths } from "../../src/services/run-store.ts";
import { branchPusher, claimRunTree, treeLimits } from "../../src/services/run-tree.ts";
import { readyFile, runTree, treeDir } from "../../src/services/tree-path.ts";
import { commitInClone, snapshotEnv, tempDir } from "../helpers.ts";
import { branchRun, fakeDeps, freshRun } from "./helpers.ts";

afterEach(snapshotEnv());
const realLimits = { ...treeLimits };
afterEach(() => Object.assign(treeLimits, realLimits));

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ANTHROPIC_API_KEY: "" },
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

describe("the run's integration tree (plan 50, spec D5 stage 1)", () => {
  it("claims the run's branch from origin's base, runs Setup: once, and finds the same tree again", async () => {
    const { repo, origin, run } = branchRun();
    plan(run, "# P\nSetup: echo ok > setup.txt\n");
    commitInClone(origin, "x"); // origin's main moves past the local main
    expect(() => runTree(run)).toThrow("not set up yet");
    const a = await claimRunTree(deps, run);
    expect([a.tree, a.branch, a.base]).toEqual([treeDir(run), "t", "main"]);
    expect(sh(a.tree, "rev-parse", "HEAD")).toBe(sh(repo, "rev-parse", "origin/main"));
    expect(existsSync(join(a.tree, "setup.txt"))).toBe(true);
    rmSync(join(a.tree, "setup.txt"));
    await claimRunTree(deps, run);
    expect(existsSync(join(a.tree, "setup.txt"))).toBe(false); // .ready: no second setup
    expect(runTree(run)).toBe(a.tree);
    expect(sh(a.tree, "for-each-ref", "--format=%(upstream)", "refs/heads/t")).toBe(""); // --no-track
  });

  it("works in the checkout without a base, and never in it with one", async () => {
    const { repo, run } = freshRun();
    expect(runTree(run)).toBe(repo);
    const b = branchRun();
    await claimRunTree(deps, b.run);
    rmSync(treeDir(b.run), { recursive: true, force: true });
    expect(() => runTree(b.run)).toThrow("the run's tree is gone");
  });

  it("throws E_TREE on a failed Setup:, and runs Setup: again on the next claim", async () => {
    const { run } = branchRun();
    plan(run, "# P\nSetup: echo boom; exit 3\n");
    const e = await refusal(claimRunTree(deps, run));
    expect([e.code, /exited 3/.test(e.message), e.message.includes("boom")]).toEqual(["E_TREE", true, true]);
    expect(existsSync(readyFile(run))).toBe(false);
    plan(run, "# P\nSetup: true\n");
    await claimRunTree(deps, run);
    expect(existsSync(readyFile(run))).toBe(true);
  });

  it("times Setup: out at its limit", async () => {
    const { run } = branchRun();
    plan(run, "# P\nSetup: sleep 5\n");
    treeLimits.setupMs = 50;
    const e = await refusal(claimRunTree(deps, run));
    expect([e.code, /timed out/.test(e.message)]).toEqual(["E_TREE", true]);
  });

  it("refuses a branch of the run's name that is not this run's, and the base's own name", async () => {
    const { repo, run } = branchRun();
    sh(repo, "branch", "t");
    const e = await refusal(claimRunTree(deps, run));
    expect([e.code, e.fix?.includes("git branch -m")]).toEqual(["E_TREE", true]);
    expect(existsSync(treeDir(run))).toBe(false);
    const main = branchRun("main");
    expect((await refusal(claimRunTree(deps, main.run))).message).toContain("the base");
  });

  it("refuses a folder that has another branch checked out", async () => {
    const { repo, run } = branchRun();
    mkdirSync(join(run.dir, "trees"), { recursive: true });
    sh(repo, "worktree", "add", "-b", "other", treeDir(run), "main");
    const e = await refusal(claimRunTree(deps, run));
    expect([e.code, e.message]).toEqual(["E_TREE", `${treeDir(run)} has other checked out, not t`]);
  });

  it("re-adds the run's branch when its tree folder is gone", async () => {
    const { run } = branchRun();
    const a = await claimRunTree(deps, run);
    writeFileSync(join(a.tree, "work.txt"), "w");
    sh(a.tree, "add", "-A");
    sh(a.tree, "commit", "-q", "-m", "work");
    const tip = sh(a.tree, "rev-parse", "HEAD");
    rmSync(a.tree, { recursive: true, force: true });
    const b = await claimRunTree(deps, run);
    expect([b.tree, sh(b.tree, "rev-parse", "HEAD")]).toEqual([a.tree, tip]);
  });

  it("leaves the owner's other stale worktree entries alone", async () => {
    const { repo, run } = branchRun();
    const own = tempDir("owner-tree-");
    sh(repo, "worktree", "add", "-b", "own", own, "main");
    rmSync(own, { recursive: true, force: true });
    await claimRunTree(deps, run);
    expect(sh(repo, "worktree", "list", "--porcelain")).toContain(own);
  });
});

describe("branchPusher", () => {
  it("pushes the branch to a local origin, and names git's failure", async () => {
    const { repo, origin, run } = branchRun();
    const a = await claimRunTree(deps, run);
    await branchPusher.push(a.tree, a.branch, sh(a.tree, "rev-parse", "HEAD"));
    expect(sh(origin, "rev-parse", "--verify", "t")).toBe(sh(a.tree, "rev-parse", "HEAD"));
    sh(repo, "remote", "set-url", "origin", join(run.dir, "nonexistent"));
    const e = await refusal(branchPusher.push(a.tree, a.branch, sh(a.tree, "rev-parse", "HEAD")));
    expect([e.code, e.message.startsWith("git push of t failed")]).toEqual(["E_TREE", true]);
  });
  it("pushes the sha it was given, not what HEAD became since", async () => {
    const { origin, run } = branchRun();
    const a = await claimRunTree(deps, run);
    const judged = sh(a.tree, "rev-parse", "HEAD");
    sh(a.tree, "commit", "-q", "--allow-empty", "-m", "after the judgement");
    await branchPusher.push(a.tree, a.branch, judged);
    expect(sh(origin, "rev-parse", "--verify", "t")).toBe(judged);
    expect(sh(a.tree, "rev-parse", "HEAD")).not.toBe(judged);
  });

  it("is neither forced nor retargeted by a push config of the repo", async () => {
    const { repo, origin, run } = branchRun();
    const a = await claimRunTree(deps, run);
    const first = sh(a.tree, "rev-parse", "HEAD");
    await branchPusher.push(a.tree, a.branch, first);
    sh(repo, "config", "remote.origin.push", "+refs/heads/*:refs/heads/other/*");
    sh(a.tree, "commit", "-q", "--allow-empty", "-m", "second");
    const second = sh(a.tree, "rev-parse", "HEAD");
    await branchPusher.push(a.tree, a.branch, second);
    expect(sh(origin, "rev-parse", "--verify", "t")).toBe(second);
    expect(sh(origin, "for-each-ref", "refs/heads/other")).toBe("");
    // a rewritten branch is rejected, not forced
    sh(a.tree, "reset", "-q", "--hard", first);
    sh(a.tree, "commit", "-q", "--allow-empty", "-m", "rewrite");
    await refusal(branchPusher.push(a.tree, a.branch, sh(a.tree, "rev-parse", "HEAD")));
    expect(sh(origin, "rev-parse", "--verify", "t")).toBe(second);
  });
});
