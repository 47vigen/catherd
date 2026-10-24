import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { checkFailLines, FAIL_DISPLAY_CAP } from "../../src/domain/fail-lines.ts";
import { ROLE_ENV } from "../../src/domain/role-scope.ts";
import { LOCK_HELD_ENV, withRoleLock } from "../../src/infra/heavy-lock.ts";
import { DISPATCH_ID_ENV } from "../../src/infra/lock-activity.ts";
import { daemonLauncher } from "../../src/services/daemon.ts";
import { answerUnit } from "../../src/services/run-client.ts";
import { appendEvent } from "../../src/services/run-events-store.ts";
import { openQuestions, park } from "../../src/services/questions.ts";
import { PLAN, startedFields } from "../domain/run-fixtures.ts";
import { fakeDeps, passGate } from "./helpers.ts";
import { gateCheck, gatePass, recordedItems } from "../../src/services/gate-service.ts";
import { land } from "../../src/services/lane-service.ts";
import { createRun, type Run } from "../../src/services/run-store.ts";
import { snapshotEnv, tempDir, tempRepo, withHome } from "../helpers.ts";

afterEach(snapshotEnv());
const tools = { ...checkTools };
const launch = daemonLauncher.launch;
afterEach(() => {
  daemonLauncher.launch = launch;
});
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

describe("execMilestoneCheck run by a verifier role", () => {
  let fixtureDir: string;
  let restoreEnv: () => void;

  beforeEach(() => {
    restoreEnv = snapshotEnv();
    delete process.env[ROLE_ENV];
    delete process.env[DISPATCH_ID_ENV];
    delete process.env.TMPDIR;
    // A worker's scratch would make the fixture's lock directory inherit that worker's role.
    const testTmp = join(import.meta.dir, "../../.superpowers");
    mkdirSync(testTmp, { recursive: true });
    fixtureDir = mkdtempSync(join(testTmp, "milestone-check-"));
    process.env.TMPDIR = fixtureDir;
    withHome();
    run = createRun({ repo, title: "t", aLines: ["A1"], version: "0.0.0-test", startHead: BASE });
  });

  afterEach(() => {
    restoreEnv();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  const probe = `bun -e 'import { roleScopeFromEnv } from "${join(import.meta.dir, "../../src/domain/role-scope.ts")}"; console.log(JSON.stringify(roleScopeFromEnv(process.env)))'`;

  it("runs the check as no role, in a slot or under a held lock", async () => {
    // the verifier's env: its identity, and a TMPDIR in its scratch
    const scratch = join(run.dir, "scratch", "verifier-M1", "tmp");
    mkdirSync(scratch, { recursive: true });
    process.env[ROLE_ENV] = `${run.id}/verifier-M1`;
    process.env[DISPATCH_ID_ENV] = "d-1";
    process.env.TMPDIR = scratch;
    const slotted = await execMilestoneCheck(job({ command: probe }));
    expect(readFileSync(slotted.log, "utf8").trim()).toBe("null");
    process.env[LOCK_HELD_ENV] = "1";
    const held = await execMilestoneCheck(job({ command: probe }));
    expect(readFileSync(held.log, "utf8").trim()).toBe("null");
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

describe("check records", () => {
  it("reads a record written before the timing fields, with none of them", () => {
    appendCheckRecord(repo, rec());
    const [r] = readChecks(repo);
    expect(r).toMatchObject({ exit: 0, head: HEAD });
    expect([r?.startedAt, r?.waitedMs, r?.carriedFrom]).toEqual([undefined, undefined, undefined]);
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

  it("a failing check on a red baseline blocks", async () => {
    appendCheckRecord(repo, rec({ baseline: true, head: BASE, exit: 1, fails: ["FAIL x", "FAIL y"] }));
    appendCheckRecord(repo, rec({ exit: 1, fails: ["FAIL x"] }));
    const g = await machineGate(run, "M1", HEAD);
    expect(g.missing[0]).toContain("pre-existing");
    expect(g.missing[0]).toContain("FAIL x");
    expect(g.audit).toEqual([]);
  });

  it("honors an owner accept through park/answer only for the baseline failures parked", async () => {
    const deps = fakeDeps({ now: () => Date.parse("2026-10-21T10:01:00.000Z") });
    daemonLauncher.launch = () => 1;
    appendCheckRecord(repo, rec({ baseline: true, head: BASE, exit: 1, fails: ["FAIL x"] }));
    appendCheckRecord(repo, rec({ exit: 1, fails: ["FAIL x"] }));
    const refused = await machineGate(run, "M1", HEAD);
    expect(refused.missing.join("\n")).toContain("pre-existing");
    await appendEvent(run, { type: "run.started", ...startedFields });
    await appendEvent(run, { type: "plan.ready", milestones: PLAN });
    const question = `land M1: the machine gate on ${HEAD.slice(0, 12)}: ${refused.missing.join("; ")}`;
    await park(deps, { run: run.id, milestone: "M1", question });
    await appendEvent(
      run,
      { type: "question.parked", unit: "M1", reason: "land", question },
      new Date(deps.now()),
    );
    expect((await machineGate(run, "M1", HEAD)).missing).not.toEqual([]);
    await answerUnit(deps, { run: run.id, unit: "M1", answer: "accept" });
    expect(openQuestions(run)).toEqual([]);
    const accepted = await machineGate(run, "M1", HEAD);
    expect(accepted.missing).toEqual([]);
    expect(accepted.audit.join("\n")).toContain("owner accepted");

    // A later rerun of the same failures retains the waiver.
    appendCheckRecord(repo, rec({ at: "2026-10-21T10:02:00.000Z", exit: 1, fails: ["FAIL x"] }));
    expect((await machineGate(run, "M1", HEAD)).missing).toEqual([]);
    // Even another red baseline cannot extend the accepted set of failures.
    appendCheckRecord(repo, rec({ baseline: true, head: BASE, exit: 1, fails: ["FAIL x", "FAIL later"] }));
    appendCheckRecord(
      repo,
      rec({ at: "2026-10-21T10:03:00.000Z", exit: 1, fails: ["FAIL x", "FAIL later"] }),
    );
    expect((await machineGate(run, "M1", HEAD)).missing.join("\n")).toContain("FAIL later");
    const otherHead = "c".repeat(40);
    appendCheckRecord(repo, rec({ head: otherHead, exit: 1, fails: ["FAIL x"] }));
    expect((await machineGate(run, "M1", otherHead)).missing.join("\n")).toContain("pre-existing");
    appendCheckRecord(
      repo,
      rec({ command: "another check", baseline: true, head: BASE, exit: 1, fails: ["FAIL x"] }),
    );
    appendCheckRecord(repo, rec({ command: "another check", exit: 1, fails: ["FAIL x"] }));
    expect((await machineGate(run, "M1", HEAD)).missing.join("\n")).toContain("`another check`");
  });

  it("lands an accepted red baseline through gate_check, park, answer, and land", async () => {
    const deps = fakeDeps();
    daemonLauncher.launch = () => 1;
    const base = HEAD_REAL;
    run = createRun({ repo, title: "waiver flow", aLines: ["A1"], version: "0.0.0-test", startHead: base });
    writeFileSync(join(repo, "tracked.txt"), "work");
    writeFileSync(join(repo, ".gitignore"), ".env\n");
    writeFileSync(join(repo, ".env"), "MODE=before\n");
    git(repo, "add", "tracked.txt", ".gitignore");
    git(repo, "commit", "-q", "-m", "work");
    const head = git(repo, "rev-parse", "HEAD");
    await passGate(run, "M1", undefined, head);
    const command = "(echo 'FAIL x'; exit 1)";
    appendCheckRecord(repo, rec({ command, head: base, baseline: true, exit: 1, fails: ["FAIL x"] }));
    appendCheckRecord(repo, rec({ command, head, exit: 1, fails: ["FAIL x"] }));
    await gateCheck(deps, {
      run: run.id,
      milestone: "M1",
      item: "root check",
      command: `true && ${command}`,
      paths: ["tracked.txt", ".env"],
    });
    const input = {
      run: run.id,
      milestone: "M1",
      what: "work",
      commit: head,
      evidence: "verified",
      next: "M2",
    };
    let refused;
    try {
      await land(deps, input);
    } catch (e) {
      refused = e as { code: string; message: string };
    }
    expect(refused?.code).toBe("E_LAND_GATE");
    expect(refused?.message).toContain("pre-existing");
    await appendEvent(run, { type: "run.started", ...startedFields });
    await appendEvent(run, { type: "plan.ready", milestones: PLAN });
    const question = refused!.message;
    await park(deps, { run: run.id, milestone: "M1", question });
    await appendEvent(run, { type: "question.parked", unit: "M1", reason: "land", question });
    await answerUnit(deps, { run: run.id, unit: "M1", answer: "accept" });
    expect((await machineGate(run, "M1", head)).missing).toEqual([]);
    expect((await recordedItems(run, "M1"))[0]?.passed).toBe(false);
    writeFileSync(join(repo, ".env"), "MODE=after\n");
    await expect(land(deps, input)).rejects.toMatchObject({ code: "E_LAND_GATE" });
    writeFileSync(join(repo, ".env"), "MODE=before\n");
    // Removing the ignored input from the registered paths must not carry the original waiver either.
    await gateCheck(deps, {
      run: run.id,
      milestone: "M1",
      item: "root check",
      command: `true && ${command}`,
      paths: ["tracked.txt"],
    });
    await expect(land(deps, input)).rejects.toMatchObject({ code: "E_LAND_GATE" });
    await gateCheck(deps, {
      run: run.id,
      milestone: "M1",
      item: "root check",
      command: `true && ${command}`,
      paths: ["tracked.txt", ".env"],
    });
    writeFileSync(join(repo, "tracked.txt"), "uncommitted change");
    await expect(land(deps, input)).rejects.toThrow("root check");
    git(repo, "checkout", "--", "tracked.txt");
    // A waiver for this failed check cannot stand in for another item's required pass.
    await gateCheck(deps, {
      run: run.id,
      milestone: "M1",
      item: "other check",
      command: "true",
      paths: ["tracked.txt"],
    });
    await expect(land(deps, input)).rejects.toThrow("other check");
    await gatePass(deps, {
      run: run.id,
      milestone: "M1",
      item: "other check",
      command: "true",
      paths: ["tracked.txt"],
      evidence: "passed",
    });
    await expect(land(deps, input)).resolves.toHaveProperty("ledger");
  });

  it("binds accept to the full record that caused refusal before an intervening rerun", async () => {
    const fails = Array.from({ length: FAIL_DISPLAY_CAP + 2 }, (_, n) => `FAIL case ${n}`);
    const rerunFails = [...fails.slice(0, -1), "FAIL unaccepted"];
    appendCheckRecord(
      repo,
      rec({ baseline: true, head: BASE, exit: 1, fails: [...fails, "FAIL unaccepted"] }),
    );
    appendCheckRecord(repo, rec({ exit: 1, fails }));
    const refused = await machineGate(run, "M1", HEAD);
    const question = `on ${HEAD.slice(0, 12)}: ${refused.missing.join("; ")}`;
    appendCheckRecord(repo, rec({ at: "2026-10-21T10:00:30.000Z", exit: 1, fails: rerunFails }));
    const parkedAt = new Date("2026-10-21T10:01:00.000Z");
    await appendEvent(run, { type: "question.parked", unit: "M1", reason: "land", question }, parkedAt);
    await appendEvent(
      run,
      { type: "question.answered", unit: "M1", by: "owner", answer: "accept" },
      parkedAt,
    );
    expect((await machineGate(run, "M1", HEAD)).missing).not.toEqual([]);
    appendCheckRecord(repo, rec({ at: "2026-10-21T10:02:00.000Z", exit: 1, fails }));
    expect((await machineGate(run, "M1", HEAD)).missing).toEqual([]);
  });

  it("does not waive a baseline for an unrelated question, unit, reason, or non-owner accept", async () => {
    appendCheckRecord(repo, rec({ baseline: true, head: BASE, exit: 1, fails: ["FAIL x"] }));
    appendCheckRecord(repo, rec({ exit: 1, fails: ["FAIL x"] }));
    const gate = await machineGate(run, "M1", HEAD);
    const question = `on ${HEAD.slice(0, 12)}: ${gate.missing.join("; ")}`;
    for (const [unit, reason, by, answer, text] of [
      ["M1", "land", "owner", "accept", "missing reviewer"],
      ["M2", "land", "owner", "accept", question],
      ["M1", "blocker", "owner", "accept", question],
      ["M1", "land", "owner", "continue", question],
      ["M1", "land", "judge", "accept", question],
    ] as const) {
      await appendEvent(run, { type: "question.parked", unit, reason, question: text });
      await appendEvent(run, { type: "question.answered", unit, by, answer });
      expect((await machineGate(run, "M1", HEAD)).missing.join("\n")).toContain("pre-existing");
    }
  });

  it("scopes a waiver to the full failure record beyond the displayed lines", async () => {
    const fails = Array.from({ length: FAIL_DISPLAY_CAP + 2 }, (_, n) => `FAIL case ${n}`);
    appendCheckRecord(repo, rec({ baseline: true, head: BASE, exit: 1, fails }));
    appendCheckRecord(repo, rec({ exit: 1, fails }));
    const gate = await machineGate(run, "M1", HEAD);
    const question = `on ${HEAD.slice(0, 12)}: ${gate.missing.join("; ")}`;
    const parkedAt = new Date("2026-10-21T10:01:00.000Z");
    await appendEvent(run, { type: "question.parked", unit: "M1", reason: "land", question }, parkedAt);
    await appendEvent(
      run,
      { type: "question.answered", unit: "M1", by: "owner", answer: "accept" },
      parkedAt,
    );
    expect((await machineGate(run, "M1", HEAD)).missing).toEqual([]);
    const changed = [...fails.slice(0, -1), "FAIL not accepted"];
    appendCheckRecord(repo, rec({ baseline: true, head: BASE, exit: 1, fails: changed }));
    appendCheckRecord(repo, rec({ at: "2026-10-21T10:02:00.000Z", exit: 1, fails: changed }));
    // The excerpt and failure count are unchanged, but a different full failure set must still block.
    expect((await machineGate(run, "M1", HEAD)).missing).not.toEqual([]);
  });

  it("checks additional recorded item failures alongside the planned items", async () => {
    writeFileSync(join(run.dir, "plan.md"), "## M1 — first\nCheck: true\n");
    appendCheckRecord(repo, rec({ command: "true" }));
    appendCheckRecord(repo, rec({ command: "false", exit: 1 }));
    expect((await machineGate(run, "M1", HEAD)).missing.join("\n")).toContain("`false` exits 1");
  });

  it("machineGate names an item with no record", async () => {
    writeFileSync(join(run.dir, "plan.md"), "## M1 — first\nCheck: a && b\n");
    appendCheckRecord(repo, rec({ command: "a" }));
    const g = await machineGate(run, "M1", HEAD);
    expect(g.missing).toHaveLength(1);
    expect(g.missing[0]).toContain("`b`");
  });

  it("names every planned item when no check is recorded on this head", async () => {
    writeFileSync(join(run.dir, "plan.md"), "## M1 — first\nCheck: a && b\n");
    const g = await machineGate(run, "M1", HEAD);
    expect(g.missing).toHaveLength(2);
    expect(g.missing[0]).toContain("`a`");
    expect(g.missing[1]).toContain("`b`");
  });

  it("requires items recorded on another head when the plan has no Check line", async () => {
    appendCheckRecord(repo, rec({ command: "a" }));
    appendCheckRecord(repo, rec({ command: "b", head: "c".repeat(40) }));
    expect((await machineGate(run, "M1", HEAD)).missing.join("\n")).toContain("`b`");
  });

  it("does not treat an old whole-command record as records of its items", async () => {
    appendCheckRecord(repo, rec({ command: "a && b" }));
    const g = await machineGate(run, "M1", HEAD);
    expect(g.missing.join("\n")).toContain("`a`");
    expect(g.missing.join("\n")).toContain("`b`");
  });

  it("judges item records rather than an obsolete whole-command failure", async () => {
    writeFileSync(join(run.dir, "plan.md"), "## M1 — first\nCheck: a && b\n");
    appendCheckRecord(repo, rec({ command: "a && b", exit: 1, fails: ["FAIL old"] }));
    appendCheckRecord(repo, rec({ command: "a" }));
    appendCheckRecord(repo, rec({ command: "b" }));
    expect(await machineGate(run, "M1", HEAD)).toEqual({ missing: [], audit: [] });
  });

  it("a fresh failure after line 60 is caught", async () => {
    const lines = Array.from({ length: 61 }, (_, n) => `FAIL case ${n}`);
    appendCheckRecord(
      repo,
      rec({ baseline: true, head: BASE, exit: 1, fails: checkFailLines(lines.join("\n")) }),
    );
    appendCheckRecord(repo, rec({ exit: 1, fails: checkFailLines([...lines, "FAIL fresh"].join("\n")) }));
    expect((await machineGate(run, "M1", HEAD)).missing.join("\n")).toContain("FAIL fresh");
  });

  it("caps displayed pre-existing lines only", async () => {
    const fails = Array.from({ length: FAIL_DISPLAY_CAP + 1 }, (_, n) => `FAIL case ${n}`);
    appendCheckRecord(repo, rec({ baseline: true, head: BASE, exit: 1, fails }));
    appendCheckRecord(repo, rec({ exit: 1, fails }));
    const g = await machineGate(run, "M1", HEAD);
    expect(g.missing.join("\n")).toContain(`FAIL case ${FAIL_DISPLAY_CAP - 1}`);
    expect(g.missing.join("\n")).not.toContain(`FAIL case ${FAIL_DISPLAY_CAP}`);
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

  it("judges the latest record of each planned command, and only this milestone's on this commit", async () => {
    writeFileSync(join(run.dir, "plan.md"), "## M1 — first\nCheck: bun test\n");
    appendCheckRecord(repo, rec({ exit: 1, fails: ["FAIL x"] }));
    appendCheckRecord(repo, rec({ exit: 0 }));
    appendCheckRecord(repo, rec({ milestone: "M2", command: "lint", exit: 1 }));
    appendCheckRecord(repo, rec({ head: "e".repeat(40), command: "lint", exit: 1 }));
    expect(await machineGate(run, "M1", HEAD)).toEqual({ missing: [], audit: [] });
  });
});
