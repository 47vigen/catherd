import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkLimits, readChecks, runMilestoneCheck } from "../../src/services/milestone-check.ts";
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

  it("says how to record a baseline when a failing check has none", async () => {
    const r = await runMilestoneCheck({ ...i, command: "echo 'FAIL a'; exit 1" });
    expect(r.running === false && r.hints?.[0]).toContain("git worktree add --detach");
    expect(r.running === false && r.missing[0]).toContain("exits 1");
  });
});
