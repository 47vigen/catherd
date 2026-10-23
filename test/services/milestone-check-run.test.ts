import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkBase, checkLimits, readChecks, runMilestoneCheck } from "../../src/services/milestone-check.ts";
import { claimTree } from "../../src/services/milestone-tree.ts";
import { branchRun, fakeDeps } from "./helpers.ts";
import { createRun, type Run } from "../../src/services/run-store.ts";
import { snapshotEnv, tempDir, tempRepo, withHome } from "../helpers.ts";

afterEach(snapshotEnv());
const limits = { ...checkLimits };
afterEach(() => Object.assign(checkLimits, limits));

const git = (cwd: string, ...a: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();

let repo: string;
let run: Run;
let BASE: string;
let HEAD: string;
let i: { run: string; milestone: string; command: string };

beforeEach(() => {
  checkLimits.pollMs = 20;
  withHome();
  process.env.ANTHROPIC_API_KEY = "";
  repo = tempRepo();
  BASE = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "tracked.txt"), "one");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "work");
  HEAD = git(repo, "rev-parse", "HEAD");
  run = createRun({ repo, title: "t", aLines: ["A1"], version: "0.0.0-test", startHead: BASE });
  i = { run: run.id, milestone: "M1", command: "echo ok" };
});

describe("runMilestoneCheck", () => {
  it("runs the check in a detached worker and returns its record", async () => {
    const r = await runMilestoneCheck(i);
    expect(r).toMatchObject({ running: false, cached: false, record: { exit: 0, head: HEAD } });
    expect(r.running === false && r.missing).toEqual([]);
  });

  it("reuses the record on the same HEAD, and runs again when forced", async () => {
    await runMilestoneCheck(i);
    expect(await runMilestoneCheck(i)).toMatchObject({ cached: true });
    expect(await runMilestoneCheck({ ...i, force: true })).toMatchObject({ cached: false });
    expect(readChecks(repo)).toHaveLength(2);
  });

  it("a two-item check writes two records and runs the second after the first fails", async () => {
    const first = "(echo 'FAIL first'; exit 1)";
    const second = "echo second";
    const command = `${first} && ${second}`;
    const r = await runMilestoneCheck({ ...i, command });
    expect(r).toMatchObject({ running: false, cached: false });
    expect(readChecks(repo).map((r) => [r.command, r.exit])).toEqual([
      [first, 1],
      [second, 0],
    ]);
    expect(r.running === false && r.missing.join("\n")).toContain("FAIL first");
    expect(await runMilestoneCheck({ ...i, command })).toMatchObject({ cached: true });
    expect(readChecks(repo)).toHaveLength(2);
  });

  it("caches finished items while a later item is still running", async () => {
    const go = join(tempDir("go-"), "go");
    const first = "echo first";
    const second = `while [ ! -f ${go} ]; do sleep 0.05; done; echo done`;
    const command = `${first} && ${second}`;
    // Finish the first item before exercising the running response on the second.
    await runMilestoneCheck({ ...i, command: first });
    checkLimits.waitMs = 50;
    let pending;
    try {
      pending = await runMilestoneCheck({ ...i, command });
    } finally {
      writeFileSync(go, "");
    }
    checkLimits.waitMs = 60_000;
    const r = await runMilestoneCheck({ ...i, command });
    expect(pending).toMatchObject({ running: true });
    expect(r).toMatchObject({ running: false });
    expect(readChecks(repo).map((r) => r.command)).toEqual([first, second]);
  });

  it("refuses tracked uncommitted changes: a record names a commit", async () => {
    writeFileSync(join(repo, "tracked.txt"), "edit");
    const e = await runMilestoneCheck(i).catch((x) => x);
    expect(e.code).toBe("E_INPUT_INVALID");
    expect(e.fix).toContain("commit the milestone first");
  });

  it("answers running past the wait budget, and a later call waits for the same run", async () => {
    const go = join(tempDir("go-"), "go");
    const command = `while [ ! -f ${go} ]; do sleep 0.05; done; echo done`;
    checkLimits.waitMs = 50;
    expect(await runMilestoneCheck({ ...i, command })).toMatchObject({ running: true });
    writeFileSync(go, "");
    checkLimits.waitMs = 60_000;
    expect(await runMilestoneCheck({ ...i, command })).toMatchObject({ running: false, record: { exit: 0 } });
    expect(readChecks(repo).filter((r) => r.command === command)).toHaveLength(1);
  });

  it("records a baseline from a checkout of the base, and refuses a checkout of another commit", async () => {
    const at = join(tempDir("base-"), "wt");
    git(repo, "worktree", "add", "--detach", at, BASE);
    const r = await runMilestoneCheck({ ...i, at });
    expect(r).toMatchObject({ running: false, record: { baseline: true, head: BASE } });
    const other = join(tempDir("base-"), "wt");
    git(repo, "worktree", "add", "--detach", other, HEAD);
    const e = await runMilestoneCheck({ ...i, at: other }).catch((x) => x);
    expect(e.code).toBe("E_INPUT_INVALID");
    expect(e.message).toContain(BASE.slice(0, 12));
  });

  it("records each baseline item and reruns each item when forced", async () => {
    const at = join(tempDir("base-"), "wt");
    git(repo, "worktree", "add", "--detach", at, BASE);
    const first = "(echo 'FAIL base'; exit 1)";
    const second = "echo second";
    const input = { ...i, at, command: `${first} && ${second}` };
    await runMilestoneCheck(input);
    expect(readChecks(repo).map((r) => [r.command, r.exit, r.baseline, r.head])).toEqual([
      [first, 1, true, BASE],
      [second, 0, true, BASE],
    ]);
    expect(await runMilestoneCheck(input)).toMatchObject({ cached: true });
    expect(await runMilestoneCheck({ ...input, force: true })).toMatchObject({ cached: false });
    expect(readChecks(repo).map((r) => r.command)).toEqual([first, second, first, second]);
  });

  it("says how to record a baseline when a failing check has none", async () => {
    const r = await runMilestoneCheck({ ...i, command: "echo 'FAIL a'; exit 1" });
    expect(r.running === false && r.hints?.[0]).toContain("git worktree add --detach");
    expect(r.running === false && r.missing[0]).toContain("exits 1");
  });
});

describe("runMilestoneCheck in a base run (plan 35)", () => {
  it("runs gate_run in the milestone's tree and takes its base from origin's base", async () => {
    const b = branchRun();
    const { tree } = await claimTree(fakeDeps(), b.run, "M1", { known: false });
    const originMain = git(b.repo, "rev-parse", "origin/main");
    writeFileSync(join(tree, "work.txt"), "w");
    git(tree, "add", "-A");
    git(tree, "commit", "-q", "-m", "work");
    const head = git(tree, "rev-parse", "HEAD");
    const r = await runMilestoneCheck({ run: b.run.id, milestone: "M1", command: "test -f work.txt" });
    expect(r).toMatchObject({ running: false, record: { exit: 0, head } });
    expect(head).not.toBe(git(b.repo, "rev-parse", "HEAD"));
    expect(await checkBase(b.run, "M1")).toBe(originMain);
  });

  it("checkBase is the start HEAD in a run without base", async () => {
    expect(await checkBase(run, "M1")).toBe(BASE);
    expect(await checkBase(run)).toBe(BASE);
  });
});
