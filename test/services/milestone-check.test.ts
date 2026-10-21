import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendCheckRecord,
  baselineFor,
  type CheckJob,
  type CheckRecord,
  checkTools,
  execMilestoneCheck,
  machineGate,
  readChecks,
  secretScan,
} from "../../src/services/milestone-check.ts";
import { withRoleLock } from "../../src/infra/heavy-lock.ts";
import { createRun, type Run } from "../../src/services/run-store.ts";
import { snapshotEnv, tempDir, tempRepo, withHome } from "../helpers.ts";

afterEach(snapshotEnv());
const tools = { ...checkTools };
afterEach(() => Object.assign(checkTools, tools));

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
let repo: string;
let run: Run;
let HEAD_REAL: string;
const git = (cwd: string, ...a: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
  withHome();
  repo = tempRepo();
  HEAD_REAL = git(repo, "rev-parse", "HEAD");
  run = createRun({ repo, title: "t", aLines: ["A1"], version: "0.0.0-test", startHead: BASE });
  checkTools.gitleaks = () => null;
});

const job = (over: Partial<CheckJob> = {}): CheckJob => ({
  run: run.id,
  repo,
  cwd: repo,
  milestone: "M1",
  command: "true",
  head: HEAD_REAL,
  base: BASE,
  baseline: false,
  ...over,
});

const rec = (over: Partial<CheckRecord> = {}): CheckRecord => ({
  at: "2026-10-21T10:00:00.000Z",
  run: run.id,
  milestone: "M1",
  command: "bun test",
  head: HEAD,
  exit: 0,
  durationMs: 1,
  fails: [],
  log: "/x.log",
  secrets: "clean",
  ...over,
});

describe("execMilestoneCheck", () => {
  it("records the exit code and failing lines against HEAD, with its log", async () => {
    const r = await execMilestoneCheck(job({ command: "printf 'FAIL a.test > x [3ms]\\n'; exit 1" }));
    expect(r).toMatchObject({ exit: 1, fails: ["FAIL a.test > x"], head: HEAD_REAL, rerunOf: 1 });
    expect(readFileSync(r.log, "utf8")).toContain("FAIL a.test > x");
    expect(readChecks(repo).at(-1)).toEqual(r);
  });

  it("reruns a failure with new lines once, recording the first exit", async () => {
    const flag = join(tempDir("c-"), "once");
    const r = await execMilestoneCheck(
      job({ command: `test -f ${flag} || { touch ${flag}; echo 'FAIL flaky'; exit 1; }` }),
    );
    expect(r).toMatchObject({ exit: 0, rerunOf: 1, fails: [] });
  });

  it("does not rerun a failure the base already has", async () => {
    const command = "echo 'FAIL a.test > x'; exit 1";
    appendCheckRecord(
      repo,
      rec({ command, baseline: true, head: BASE, fails: ["FAIL a.test > x"], exit: 1 }),
    );
    const r = await execMilestoneCheck(job({ command, base: BASE }));
    expect(r.rerunOf).toBeUndefined();
  });

  it("gives the command an emptied TMPDIR of its own", async () => {
    const r = await execMilestoneCheck(
      job({ command: 'ls "$TMPDIR" | wc -l; test "$TMPDIR" = "$GOTMPDIR"' }),
    );
    expect(r.exit).toBe(0);
    expect(readFileSync(r.log, "utf8").trim()).toBe("0");
  });
});

describe("execMilestoneCheck on a moving checkout", () => {
  const commit = (m: string) => git(repo, "commit", "-q", "--allow-empty", "-m", m);

  it("records nothing for a HEAD that moved while the command ran", async () => {
    const e = await execMilestoneCheck(
      job({ command: `git -c user.name=t -c user.email=t@t commit -q --allow-empty -m moved` }),
    ).catch((x) => x);
    expect(e.code).toBe("E_INPUT_INVALID");
    expect(e.message).toContain("moved");
    expect(readChecks(repo)).toEqual([]);
  });

  it("records nothing, and never runs, for a HEAD that moved while it waited for the locks", async () => {
    const marker = join(tempDir("ran-"), "ran");
    let release = () => {};
    const held = withRoleLock("verifier", "run:other", () => new Promise<void>((r) => (release = r)));
    await Bun.sleep(50);
    const pending = execMilestoneCheck(job({ command: `touch ${marker}` })).catch((x) => x);
    commit("moved while waiting");
    release();
    await held;
    expect((await pending).code).toBe("E_INPUT_INVALID");
    expect(existsSync(marker)).toBe(false);
    expect(readChecks(repo)).toEqual([]);
  });

  it("refuses tracked edits made while the command ran", async () => {
    writeFileSync(join(repo, "tracked.txt"), "one");
    git(repo, "add", "-A");
    commit("tracked");
    const head = git(repo, "rev-parse", "HEAD");
    const e = await execMilestoneCheck(job({ head, command: "echo edit > tracked.txt" })).catch((x) => x);
    expect(e.code).toBe("E_INPUT_INVALID");
    expect(readChecks(repo)).toEqual([]);
  });
});

describe("secretScan", () => {
  it("scans base..HEAD with gitleaks: a hit is found, a clean scan clean, no gitleaks skipped", async () => {
    const dir = tempDir("gl-");
    const args = join(dir, "args");
    const codeFile = join(dir, "code");
    const bin = join(dir, "gitleaks");
    writeFileSync(bin, `#!/bin/sh\necho "$@" > ${args}\nexit $(cat ${codeFile})\n`);
    chmodSync(bin, 0o755);
    checkTools.gitleaks = () => bin;
    writeFileSync(codeFile, "1");
    expect(await secretScan(repo, BASE)).toBe("found");
    expect(readFileSync(args, "utf8")).toContain(`--log-opts=${BASE}..HEAD`);
    writeFileSync(codeFile, "0");
    expect(await secretScan(repo, BASE)).toBe("clean");
    writeFileSync(codeFile, "2");
    expect(await secretScan(repo, BASE)).toBe("skipped: gitleaks exited 2");
    checkTools.gitleaks = () => null;
    expect(await secretScan(repo, BASE)).toBe("skipped: gitleaks is not installed");
    expect(await secretScan(repo, null)).toBe("skipped: no base commit to scan from");
  });
});

describe("baselineFor", () => {
  it("takes only the baseline on the base: another commit's is no baseline, a missing base the newest", () => {
    appendCheckRecord(repo, rec({ baseline: true, head: BASE, exit: 1 }));
    appendCheckRecord(repo, rec({ baseline: true, head: "c".repeat(40), exit: 0 }));
    expect(baselineFor(repo, "bun test", BASE)?.head).toBe(BASE);
    expect(baselineFor(repo, "bun test", "d".repeat(40))).toBeNull();
    expect(baselineFor(repo, "bun test", null)?.head).toBe("c".repeat(40));
    expect(baselineFor(repo, "other", BASE)).toBeNull();
  });
});

describe("machineGate", () => {
  it("refuses a milestone with no check on the commit, naming gate_run", async () => {
    const g = await machineGate(run, "M1", HEAD);
    expect(g.missing[0]).toContain('gate_run(run, "M1"');
  });

  it("passes an exit 0 with a clean scan", async () => {
    appendCheckRecord(repo, rec());
    expect(await machineGate(run, "M1", HEAD)).toEqual({ missing: [], audit: [] });
  });

  it("lets a failure through whose every line the base has, with an audit line", async () => {
    appendCheckRecord(repo, rec({ baseline: true, head: BASE, exit: 1, fails: ["FAIL x", "FAIL y"] }));
    appendCheckRecord(repo, rec({ exit: 1, fails: ["FAIL x"] }));
    const g = await machineGate(run, "M1", HEAD);
    expect(g.missing).toEqual([]);
    expect(g.audit[0]).toContain("pre-existing");
  });

  it("refuses failing lines the base does not have, naming them", async () => {
    appendCheckRecord(repo, rec({ baseline: true, head: BASE, exit: 1, fails: ["FAIL x"] }));
    appendCheckRecord(repo, rec({ exit: 1, fails: ["FAIL x", "FAIL new"] }));
    expect((await machineGate(run, "M1", HEAD)).missing[0]).toContain("FAIL new");
  });

  it("refuses a failure with no baseline, and one with no line it can compare", async () => {
    appendCheckRecord(repo, rec({ exit: 1, fails: ["FAIL x"] }));
    expect((await machineGate(run, "M1", HEAD)).missing[0]).toContain("exits 1");
    appendCheckRecord(repo, rec({ baseline: true, head: BASE, exit: 1, fails: ["FAIL x"] }));
    appendCheckRecord(repo, rec({ exit: 2, fails: [] }));
    expect((await machineGate(run, "M1", HEAD)).missing[0]).toContain("no failing line");
  });

  it("does not excuse a failure by a baseline recorded on another commit", async () => {
    appendCheckRecord(repo, rec({ baseline: true, head: "c".repeat(40), exit: 1, fails: ["FAIL x"] }));
    appendCheckRecord(repo, rec({ exit: 1, fails: ["FAIL x"] }));
    expect((await machineGate(run, "M1", HEAD)).missing[0]).toContain("exits 1");
  });

  it("refuses a secret hit, and notes a skipped scan and a rerun in the audit", async () => {
    appendCheckRecord(repo, rec({ secrets: "found", log: "/found.log" }));
    expect((await machineGate(run, "M1", HEAD)).missing[0]).toContain("gitleaks found secrets");
    appendCheckRecord(repo, rec({ secrets: "skipped: gitleaks is not installed", rerunOf: 1 }));
    const g = await machineGate(run, "M1", HEAD);
    expect(g.missing).toEqual([]);
    expect(g.audit.join("\n")).toContain("secret scan skipped");
    expect(g.audit.join("\n")).toContain("rerun");
  });

  it("judges the latest record of each command, and only this milestone's on this commit", async () => {
    appendCheckRecord(repo, rec({ exit: 1, fails: ["FAIL x"] }));
    appendCheckRecord(repo, rec({ exit: 0 }));
    appendCheckRecord(repo, rec({ milestone: "M2", command: "lint", exit: 1 }));
    appendCheckRecord(repo, rec({ head: "e".repeat(40), command: "lint", exit: 1 }));
    expect(await machineGate(run, "M1", HEAD)).toEqual({ missing: [], audit: [] });
  });
});
