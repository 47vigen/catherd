import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { newDispatchId } from "../../src/domain/ids.ts";
import type { ScorecardTask, TaskScore } from "../../src/domain/scorecard.ts";
import { writeJsonAtomic } from "../../src/infra/store.ts";
import {
  loadTask,
  prepareTask,
  readPrepared,
  readScorecard,
  resultsFile,
  saveTaskScore,
  scoreTask,
} from "../../src/services/scorecard.ts";
import {
  appendLedger,
  appendRecord,
  createRun,
  type Run,
  supersededFile,
} from "../../src/services/run-store.ts";
import { snapshotEnv, tempDir, tempRepo, withHome } from "../helpers.ts";
import { makeRecord, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());

const t = (hhmm: string) => `2026-09-25T${hhmm}:00.000Z`;
const PREPARED_AT = new Date(t("09:00"));
const NOW = Date.parse(t("23:00"));

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

/** A source repo whose second commit adds a.txt and docs/plan.md. */
function source(): { repo: string; commit: string } {
  const repo = tempRepo();
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n");
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs", "plan.md"), "# plan\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "second");
  return { repo, commit: sh(repo, "rev-parse", "HEAD") };
}

function taskFor(commit: string, over: Record<string, unknown> = {}): ScorecardTask {
  return {
    schema: 1,
    id: "raqam-myanmar",
    title: "t",
    goal: "g",
    source: null,
    commit,
    plan: { file: "plan.md" },
    inject: null,
    limits: 0,
    setup: [],
    acceptance: "true",
    acceptanceTimeoutMin: 1,
    acceptFiles: [],
    prompt: "do {plan} then {acceptance}",
    ...over,
  } as ScorecardTask;
}

/** A scorecard root holding the task's plan file and accept files. */
function rootWith(files: Record<string, string> = {}): string {
  const root = tempDir("scorecard-root-");
  mkdirSync(join(root, "tasks", "raqam-myanmar", "accept"), { recursive: true });
  writeFileSync(join(root, "tasks", "raqam-myanmar", "plan.md"), "# the plan\n");
  for (const [f, text] of Object.entries(files)) writeFileSync(join(root, "tasks", "raqam-myanmar", f), text);
  return root;
}

async function prepared(over: Record<string, unknown> = {}, files: Record<string, string> = {}) {
  withHome();
  const src = source();
  const root = rootWith(files);
  const task = taskFor(src.commit, over);
  writeJsonAtomic(join(root, "tasks", "raqam-myanmar", "task.json"), task);
  const into = join(tempDir("scorecard-into-"), "raqam-myanmar-20260925-090000");
  const p = await prepareTask({ task, root, into, source: src.repo, now: PREPARED_AT, setup: true });
  return { src, root, task, into, p };
}

const runIn = (repo: string, at: string, title = "t"): Run =>
  createRun({ repo, title, aLines: [], version: "0.0.0-test", now: new Date(t(at)) });

const rec = (run: Run, over: Parameters<typeof makeRecord>[0] = {}) =>
  appendRecord(run, makeRecord({ runId: run.id, dispatchId: newDispatchId(), ...over }));

/** M1 landed, its digest saying so `landedAt`. */
function land(run: Run, landedAt: string): void {
  writeLane(run, "M1.L1", ["a.txt"]);
  appendLedger(run, "M1 | x | abc1234 | 5 | e");
  mkdirSync(join(run.dir, "digests"), { recursive: true });
  writeFileSync(
    join(run.dir, "digests", "M1.md"),
    `# M1\n\nCommit abc1234 · 5 min · landed ${t(landedAt)}\n`,
  );
}

const rejection = async (p: Promise<unknown>): Promise<{ code?: string; message: string }> => {
  try {
    await p;
  } catch (e) {
    return e as { code?: string; message: string };
  }
  throw new Error("did not reject");
};

describe("scorecard prepare", () => {
  it("clones the source at the task's commit onto scorecard/<task>, with no remote, and writes prepared.json last", async () => {
    const { src, into, p } = await prepared();
    expect(sh(join(into, "repo"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("scorecard/raqam-myanmar");
    expect(sh(join(into, "repo"), "remote")).toBe("");
    expect(p.startCommit).toBe(src.commit);
    expect(readPrepared(into)).toEqual(p);
    expect(p.prompt).toBe(`do ${join(into, "plan.md")} then true`);
  });

  it("resolves a relative local source against the caller's cwd, not the prepared folder", async () => {
    withHome();
    const src = source();
    const root = rootWith();
    const task = taskFor(src.commit);
    const into = join(tempDir("scorecard-into-"), "raqam-myanmar-20260925-090000");
    const rel = relative(process.cwd(), src.repo);
    const p = await prepareTask({ task, root, into, source: rel, now: PREPARED_AT, setup: true });
    expect(p.startCommit).toBe(src.commit);
  });

  it("applies each inject edit once and commits it; refuses an edit whose text is not there exactly once", async () => {
    const inject = (find: string) => ({ message: "test: x", edits: [{ path: "a.txt", find, replace: "2" }] });
    const ok = await prepared({ inject: inject("two") });
    expect(readFileSync(join(ok.into, "repo", "a.txt"), "utf8")).toBe("one\n2\n");
    expect(sh(join(ok.into, "repo"), "log", "-1", "--format=%s")).toBe("test: x");
    for (const find of ["three", "o"]) {
      const { src, root } = await prepared();
      const into = join(tempDir("scorecard-into-"), "x");
      const err = await rejection(
        prepareTask({
          task: taskFor(src.commit, { inject: inject(find) }),
          root,
          into,
          source: src.repo,
          now: PREPARED_AT,
          setup: true,
        }),
      );
      expect(err.code).toBe("E_CONFIG_INVALID");
      expect(existsSync(join(into, "prepared.json"))).toBe(false);
    }
  });

  it("copies a file plan beside the repo, and refuses a repoPath plan missing at the commit", async () => {
    const { into, p } = await prepared({ plan: { repoPath: "docs/plan.md" } });
    expect(p.plan).toBe(join(into, "repo", "docs", "plan.md"));
    const err = await rejection(prepared({ plan: { repoPath: "docs/none.md" } }));
    expect(err.code).toBe("E_CONFIG_INVALID");
  });

  it("lays out one token per limit and names the shim for an injected task", async () => {
    const { root, into, p } = await prepared({ limits: 2 });
    expect(readdirSync(join(into, "limits", "tokens")).sort()).toEqual(["1", "2"]);
    expect(p.limits).toBe(join(into, "limits"));
    expect(p.shim).toBe(join(root, "shim"));
  });

  it("refuses a task with no source when none is given, and a commit the source lacks", async () => {
    withHome();
    const src = source();
    const base = { root: rootWith(), now: PREPARED_AT, setup: true };
    const into = () => join(tempDir("scorecard-into-"), "x");
    const none = await rejection(prepareTask({ ...base, task: taskFor(src.commit), into: into() }));
    expect(none.code).toBe("E_INPUT_INVALID");
    const lacks = await rejection(
      prepareTask({ ...base, task: taskFor("f".repeat(40)), into: into(), source: src.repo }),
    );
    expect(lacks.code).toBe("E_INPUT_INVALID");
    expect(lacks.message).toMatch(/has no commit/);
  });

  it("runs the task's setup in the clone, and stops with its tail when a command fails", async () => {
    const ok = await prepared({ setup: ["echo ok > setup.txt"] });
    expect(readFileSync(join(ok.into, "repo", "setup.txt"), "utf8")).toBe("ok\n");
    const err = await rejection(prepared({ setup: ["echo broke; exit 3"] }));
    expect(err.code).toBe("E_IO_UNEXPECTED");
    expect(err.message).toMatch(/setup `echo broke; exit 3` failed.*broke/);
  });
});

describe("scorecard score", () => {
  it("scores a landed run: finished, its review rounds, wall-clock to its landing, acceptance passed and a first try", async () => {
    const { root, into, p } = await prepared({ acceptance: "test -f a.txt" });
    const run = runIn(p.repo, "10:00");
    land(run, "10:50");
    await rec(run, { name: "reviewer-M1", role: "reviewer", lane: null, endedAt: t("10:40") });
    const s = await scoreTask({ dir: into, root, now: NOW });
    expect(s).toMatchObject({
      task: "raqam-myanmar",
      run: run.id,
      finished: true,
      reviewRounds: 1,
      wallMinutes: 50,
      firstTry: true,
      interventions: { total: 0 },
      acceptance: { passed: true },
      catherdVersion: "0.0.0-test",
      injected: null,
      milestones: ["M1"],
      landed: ["M1"],
    });
  });

  it("scores a run that never landed as unfinished, its wall-clock to its last record", async () => {
    const { root, into, p } = await prepared();
    const run = runIn(p.repo, "10:00");
    await rec(run, { endedAt: t("10:20") });
    expect(await scoreTask({ dir: into, root, now: NOW })).toMatchObject({
      run: run.id,
      finished: false,
      firstTry: false,
      wallMinutes: 20,
    });
  });

  it("refuses a folder with no run, and one with two runs unless run names one, and counts the run it superseded", async () => {
    const { root, into, p } = await prepared();
    expect((await rejection(scoreTask({ dir: into, root, now: NOW }))).message).toMatch(/no run in/);
    const a = runIn(p.repo, "10:00", "a");
    const b = runIn(p.repo, "10:05", "b");
    const err = await rejection(scoreTask({ dir: into, root, now: NOW }));
    expect(err.code).toBe("E_INPUT_INVALID");
    expect(err.message).toContain(a.id);
    expect(err.message).toContain(b.id);
    expect((await scoreTask({ dir: into, root, run: b.id, now: NOW })).interventions.superseded).toBe(0);
    writeJsonAtomic(supersededFile(a), { schema: 1, by: b.id, at: t("10:05") });
    expect(await scoreTask({ dir: into, root, now: NOW })).toMatchObject({
      run: b.id,
      interventions: { superseded: 1 },
    });
  });

  it("copies the accept files in for acceptance and removes them after, even when the check fails; refuses one whose path the run already has", async () => {
    const acceptFiles = [{ from: "accept/ok.txt", to: "accept-ok.txt" }];
    const { root, into, p } = await prepared(
      { acceptFiles, acceptance: "test -f accept-ok.txt && exit 4" },
      { "accept/ok.txt": "hidden\n" },
    );
    runIn(p.repo, "10:00");
    const s = await scoreTask({ dir: into, root, now: NOW });
    expect(s.acceptance).toMatchObject({ passed: false, code: 4 });
    expect(existsSync(join(p.repo, "accept-ok.txt"))).toBe(false);
    writeFileSync(join(p.repo, "accept-ok.txt"), "mine\n");
    expect((await rejection(scoreTask({ dir: into, root, now: NOW }))).message).toMatch(/already exists/);
    expect(readFileSync(join(p.repo, "accept-ok.txt"), "utf8")).toBe("mine\n");
  });

  it("reports the injected limits the shim took and whether a stand-in ended ok", async () => {
    const { root, into, p } = await prepared({ limits: 1 });
    const run = runIn(p.repo, "10:00");
    renameSync(join(into, "limits", "tokens", "1"), join(into, "limits", "taken", "1"));
    await rec(run, { status: "limit", endedAt: t("10:05") });
    await rec(run, { failoverFrom: "codex:gpt-6-sol#medium", endedAt: t("10:10") });
    expect((await scoreTask({ dir: into, root, now: NOW })).injected).toEqual({ limits: 1, standInOk: true });
  });
});

describe("scorecard results", () => {
  const row = (task: TaskScore["task"], wallMinutes: number): TaskScore =>
    ({
      task,
      catherdVersion: "1.5.0",
      finished: true,
      interventions: {
        parks: 0,
        answers: 0,
        takeovers: 0,
        manualDispatches: 0,
        pauses: 0,
        superseded: 0,
        chat: 0,
        cancels: 0,
        approvals: 0,
        total: 0,
      },
      reviewRounds: 0,
      wallMinutes,
      quota: { backends: [], claudeAgentTokens: 0 },
      firstTry: true,
      injected: null,
    }) as unknown as TaskScore;

  it("writes one row per task under its label, replacing that task's earlier row; refuses a label that is not a plain name", () => {
    withHome();
    const dir = tempDir("scorecard-results-");
    const file = resultsFile(dir, "1.5.0");
    saveTaskScore(file, "1.5.0", row("raqam-myanmar", 1));
    saveTaskScore(file, "1.5.0", row("injected-lao", 5));
    saveTaskScore(file, "1.5.0", row("raqam-myanmar", 2));
    const f = readScorecard(file);
    expect(Object.keys(f?.tasks ?? {}).sort()).toEqual(["injected-lao", "raqam-myanmar"]);
    expect(f?.tasks["raqam-myanmar"]?.wallMinutes).toBe(2);
    expect(readScorecard(join(dir, "none.json"))).toBeNull();
    expect(() => resultsFile(dir, "../x")).toThrow();
  });

  it("refuses a hand-edited row that passBar cannot read, naming the label, task and field", () => {
    withHome();
    const dir = tempDir("scorecard-results-");
    const file = resultsFile(dir, "plan-9");
    saveTaskScore(file, "plan-9", row("raqam-myanmar", 1));
    const f = JSON.parse(readFileSync(file, "utf8"));
    f.tasks["raqam-myanmar"].interventions.total = "0";
    writeJsonAtomic(file, f);
    expect(() => readScorecard(file)).toThrow(/plan-9.*raqam-myanmar: interventions\.total/);
    f.tasks["raqam-myanmar"].interventions.total = 0;
    f.tasks["raqam-myanmar"].wallMinutes = null;
    writeJsonAtomic(file, f);
    expect(() => readScorecard(file)).toThrow(/raqam-myanmar: wallMinutes/);
  });

  it("loads a task by its id and refuses an unknown one with the four names", () => {
    const root = tempDir("scorecard-root-");
    mkdirSync(join(root, "tasks", "raqam-myanmar"), { recursive: true });
    writeJsonAtomic(join(root, "tasks", "raqam-myanmar", "task.json"), {
      ...taskFor("a".repeat(40)),
      source: "https://example.test/x.git",
    });
    expect(loadTask("raqam-myanmar", root).id).toBe("raqam-myanmar");
    try {
      loadTask("nope", root);
      throw new Error("did not throw");
    } catch (e) {
      const err = e as { code: string; message: string; fix: string };
      expect([err.code, err.message]).toEqual(["E_INPUT_INVALID", "no scorecard task nope"]);
      expect(err.fix).toBe(
        "catherd scorecard prepare raqam-myanmar|catherd-findings|sanitell-payment-3|injected-lao",
      );
    }
  });
});
