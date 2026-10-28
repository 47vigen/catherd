import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isCatherdError } from "../../src/domain/errors.ts";
import type { RunEventInput } from "../../src/domain/run-events.ts";
import { daemonLauncher } from "../../src/services/daemon.ts";
import { answerUnit, cancelRun, profileTool, runResult, runStart } from "../../src/services/run-client.ts";
import { openQuestions, park } from "../../src/services/questions.ts";
import { appendEvent, readEvents } from "../../src/services/run-events-store.ts";
import { findRun, listRuns, type Run } from "../../src/services/run-store.ts";
import { startedFields } from "../domain/run-fixtures.ts";
import { repoWithOrigin, snapshotEnv, tempDir, tempRepo, withHome } from "../helpers.ts";
import { fakeDeps, fakeDispatch, freshRun, PLAN_TEXT } from "./helpers.ts";

afterEach(snapshotEnv());
const real = daemonLauncher.launch;
let launched: string[] = [];
beforeEach(() => {
  launched = [];
  daemonLauncher.launch = (id: string) => {
    launched.push(id);
    return 1;
  };
});
afterEach(() => {
  daemonLauncher.launch = real;
});

async function seed(run: Run, ...more: RunEventInput[]): Promise<void> {
  await appendEvent(run, { type: "run.started", ...startedFields });
  for (const e of more) await appendEvent(run, e);
}

async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    if (isCatherdError(e)) return e;
    throw e;
  }
  throw new Error("expected a refusal");
}

describe("runStart", () => {
  it("starts a run: run.started, a daemon, and the notify url", async () => {
    withHome();
    const repo = tempRepo();
    const deps = fakeDeps();
    const r = await runStart(deps, { repo, title: "wallet", aLines: ["A1 it works"] });
    const run = findRun(r.run);
    expect(readEvents(run)).toMatchObject([
      { type: "run.started", title: "wallet", aLines: ["A1 it works"], plan: [], base: null },
    ]);
    // the fake profile has no ui-reviewer: the run records it as off, and the reviewer as on
    const off = (readEvents(run)[0] as { rolesOff?: string[] }).rolesOff;
    expect(off).toContain("ui-reviewer");
    expect(off).not.toContain("reviewer");
    expect(launched).toEqual([run.id]);
    expect(r).toMatchObject({
      daemon: "revived",
      dir: run.dir,
      notifyUrl: "https://ntfy.sh/catherd-test",
    });
    expect(r.next).toContain("https://ntfy.sh/catherd-test");
  });

  it("starts an architect run by default: its plan files are input, not an approval (plan 48)", async () => {
    withHome();
    const repo = tempRepo();
    writeFileSync(join(repo, "PLAN.md"), PLAN_TEXT);
    const r = await runStart(fakeDeps(), {
      repo,
      title: "w",
      aLines: ["A1 x"],
      plan: ["PLAN.md"],
    });
    expect(readEvents(findRun(r.run)).map((e) => e.type)).toEqual(["run.started"]);
    expect(readEvents(findRun(r.run))[0]).toMatchObject({ plan: [expect.stringMatching(/PLAN\.md$/)] });
    expect(readEvents(findRun(r.run))[0]).not.toHaveProperty("engine");
    expect(r.next).toContain("architect drives the run");
  });

  it("refuses a base, creating no run (landing returns in plan 50)", async () => {
    withHome();
    const { repo } = repoWithOrigin();
    const before = listRuns().runs.length;
    const e = await refusal(runStart(fakeDeps(), { repo, title: "w", aLines: ["A1 x"], base: "main" }));
    expect([e.code, listRuns().runs.length]).toEqual(["E_INPUT_INVALID", before]);
  });

  it("run_start returns the run when the daemon launch fails", async () => {
    withHome();
    const repo = tempRepo();
    daemonLauncher.launch = () => {
      throw new Error("posix_spawn failed");
    };
    const r = await runStart(fakeDeps(), { repo, title: "t", aLines: ["A1 x"] });
    expect(r).toMatchObject({
      run: expect.any(String),
      daemon: "failed",
      warning: "the run started, its daemon did not: posix_spawn failed; status(run) starts it again",
    });
    expect(listRuns().runs.map((x) => x.id)).toEqual([r.run]);
  });

  it("a run without base has no meta.base and run.started.base null", async () => {
    withHome();
    const repo = tempRepo();
    const run = findRun((await runStart(fakeDeps(), { repo, title: "w", aLines: ["A1 x"] })).run);
    expect(run.meta.base).toBeUndefined();
    expect(readEvents(run)[0]).toMatchObject({ type: "run.started", base: null });
  });

  it("starts a run on its plan files: copies them and records them, approving nothing", async () => {
    withHome();
    const repo = tempRepo();
    const outside = join(tempDir("rc-out-"), "q.md");
    writeFileSync(outside, PLAN_TEXT);
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, "docs/p.md"), PLAN_TEXT);
    const r = await runStart(fakeDeps(), {
      repo,
      title: "t",
      aLines: ["A1 x"],
      plan: ["docs/p.md", outside],
    });
    const run = findRun(r.run);
    expect(r.plan).toEqual([join(repo, "docs/p.md"), outside]);
    expect(readEvents(run).map((e) => e.type)).toEqual(["run.started"]);
    expect(readEvents(run)[0]).toMatchObject({ plan: r.plan });
    expect(readFileSync(join(run.dir, "plan-input/p.md"), "utf8")).toBe(PLAN_TEXT);
    expect(readFileSync(join(run.dir, "plan-input/q.md"), "utf8")).toBe(PLAN_TEXT);
    expect(r.next).toContain("the architect drives the run");
  });

  it("reads an A-line plan: as plan input too", async () => {
    withHome();
    const repo = tempRepo();
    writeFileSync(join(repo, "p.md"), PLAN_TEXT);
    const r = await runStart(fakeDeps(), { repo, title: "t", aLines: ["A1 x", "plan: p.md"] });
    expect(r.plan).toEqual([join(repo, "p.md")]);
    expect(readEvents(findRun(r.run))[0]).toMatchObject({ aLines: ["A1 x", "plan: p.md"] });
  });

  it("refuses a missing plan file before creating the run", async () => {
    withHome();
    const repo = tempRepo();
    const e = await refusal(runStart(fakeDeps(), { repo, title: "t", aLines: [], plan: ["nope.md"] }));
    expect([e.code, e.message]).toEqual([
      "E_INPUT_INVALID",
      `plan file ${join(repo, "nope.md")} does not exist`,
    ]);
    expect(listRuns([repo]).runs).toHaveLength(0);
    expect(launched).toEqual([]);
  });

  it("refuses plan files none of which has a task, and a directory", async () => {
    withHome();
    const repo = tempRepo();
    writeFileSync(join(repo, "c.md"), "# contracts\n");
    const none = await refusal(runStart(fakeDeps(), { repo, title: "t", aLines: [], plan: ["c.md"] }));
    expect(none.message).toContain('none of the plan files has a "### Task <n>:" heading');
    const dir = await refusal(runStart(fakeDeps(), { repo, title: "t", aLines: [], plan: ["."] }));
    expect(dir.message).toBe(`plan ${repo} is not a file`);
    expect(listRuns([repo]).runs).toHaveLength(0);
  });

  it("starts a run with no plan and no approval event", async () => {
    withHome();
    const repo = tempRepo();
    const r = await runStart(fakeDeps(), { repo, title: "t", aLines: ["A1 x"] });
    expect(r.plan).toEqual([]);
    expect(readEvents(findRun(r.run)).map((e) => e.type)).toEqual(["run.started"]);
    expect(r.next).toContain("the architect drives the run");
  });

  it("refuses a repo outside git, creating nothing", async () => {
    withHome();
    const e = await refusal(runStart(fakeDeps(), { repo: "/", title: "t", aLines: [] }));
    expect(e.code).toBe("E_IO_PATH");
    expect(launched).toEqual([]);
  });
});

describe("answerUnit", () => {
  it("refuses an answer for a unit with no open question, appending nothing", async () => {
    const { run } = freshRun();
    await seed(run, { type: "question.parked", unit: "M1.L2", question: "q", reason: "needs_user" });
    const before = readEvents(run).length;
    const e = await refusal(answerUnit(fakeDeps(), { run: run.id, unit: "M9", answer: "x" }));
    expect([e.code, e.fix?.includes("M1.L2")]).toEqual(["E_INPUT_INVALID", true]);
    expect(readEvents(run)).toHaveLength(before);
  });

  it("answers a lane's question, and wakes the daemon", async () => {
    const { run } = freshRun();
    await seed(run, { type: "question.parked", unit: "M1.L2", question: "q", reason: "needs_user" });
    const r = await answerUnit(fakeDeps(), { run: run.id, unit: "M1.L2", answer: "euros" });
    expect(r).toEqual({ unit: "M1.L2", parked: [] });
    expect(readEvents(run).at(-1)).toMatchObject({
      type: "question.answered",
      unit: "M1.L2",
      answer: "euros",
      by: "owner",
    });
    expect(launched).toEqual([run.id]);
  });

  it("answers a parked milestone in questions.jsonl too", async () => {
    const { run } = freshRun();
    const deps = fakeDeps();
    await seed(run);
    await park(deps, { run: run.id, milestone: "M1", question: "which currency?" });
    await appendEvent(run, {
      type: "question.parked",
      unit: "M1",
      question: "which currency?",
      reason: "needs_user",
    });
    expect(openQuestions(run)).toHaveLength(1);
    expect(await answerUnit(deps, { run: run.id, unit: "M1", answer: "euros" })).toEqual({
      unit: "M1",
      parked: [],
    });
    expect(openQuestions(run)).toEqual([]);
  });
});

describe("answerUnit and the plan input", () => {
  it("copies the plan files again on every answer", async () => {
    withHome();
    const repo = tempRepo();
    writeFileSync(join(repo, "p.md"), PLAN_TEXT);
    const r = await runStart(fakeDeps(), { repo, title: "t", aLines: ["A1 x"], plan: ["p.md"] });
    const run = findRun(r.run);
    await appendEvent(run, { type: "question.parked", unit: "M1", question: "q", reason: "preflight" });
    writeFileSync(join(repo, "p.md"), `${PLAN_TEXT}fixed\n`);
    await answerUnit(fakeDeps(), { run: run.id, unit: "M1", answer: "fixed the plan" });
    expect(readFileSync(join(run.dir, "plan-input/p.md"), "utf8")).toBe(`${PLAN_TEXT}fixed\n`);
  });
});

describe("answerUnit, concurrently", () => {
  it("lets one of two simultaneous answers through, and refuses the other", async () => {
    const { run } = freshRun();
    const deps = fakeDeps();
    await seed(run);
    await park(deps, { run: run.id, milestone: "M1", question: "which currency?" });
    await appendEvent(run, {
      type: "question.parked",
      unit: "M1",
      question: "which currency?",
      reason: "needs_user",
    });
    const out = await Promise.allSettled([
      answerUnit(deps, { run: run.id, unit: "M1", answer: "euros" }),
      answerUnit(deps, { run: run.id, unit: "M1", answer: "dollars" }),
    ]);
    expect(out.map((o) => o.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(readEvents(run).filter((e) => e.type === "question.answered")).toHaveLength(1);
  });
});

describe("cancelRun", () => {
  it("cancels a run once: a second cancel appends nothing", async () => {
    const { run } = freshRun();
    await seed(run, {
      type: "dispatch.started",
      dispatchId: "D1",
      name: "worker-M1.L1",
      role: "worker",
      unit: "M1.L1",
      lane: "M1.L1",
      rung: "codex:gpt-6-sol#medium",
      thread: null,
    });
    const first = await cancelRun(fakeDeps(), { run: run.id });
    expect(first).toEqual({ cancelling: true, live: ["worker-M1.L1"] });
    const n = readEvents(run).length;
    expect(readEvents(run).at(-1)).toMatchObject({ type: "cancel.requested", by: "owner" });
    expect(await cancelRun(fakeDeps(), { run: run.id })).toEqual({
      cancelling: true,
      live: ["worker-M1.L1"],
    });
    expect(readEvents(run)).toHaveLength(n);
  });
});

describe("a 1.5 run", () => {
  it("is refused: this client does not drive it", async () => {
    const { run } = freshRun();
    for (const call of [
      () => answerUnit(fakeDeps(), { run: run.id, unit: "M1", answer: "x" }),
      () => cancelRun(fakeDeps(), { run: run.id }),
      () => runResult(fakeDeps(), { run: run.id }),
    ]) {
      const e = await refusal(call());
      expect([e.code, e.fix]).toEqual(["E_RUN_NOT_LIVE", "finish it with catherd 1.x"]);
    }
    expect(launched).toEqual([]);
  });
});

describe("runResult", () => {
  it("returns the report and the ledger's tasks, and with a name the role's record", async () => {
    const { run } = freshRun();
    await seed(run, { type: "run.ended", outcome: "done", reportPath: null });
    expect(await runResult(fakeDeps(), { run: run.id })).toMatchObject({
      phase: "ended",
      outcome: "done",
      reportPath: null,
      report: null,
    });
    writeFileSync(join(run.dir, "report.md"), "# wallet\n");
    await fakeDispatch(
      run,
      { name: "worker-M1.L1" },
      {
        proc: "dead",
        exit: { code: 0, signal: null, reason: "exited", endedAt: new Date().toISOString() },
        reply: "Done.\nSTATUS: complete — ok",
        collect: true,
      },
    );
    const r = await runResult(fakeDeps(), { run: run.id, name: "worker-M1.L1" });
    expect(r).toMatchObject({
      reportPath: join(run.dir, "report.md"),
      report: "# wallet\n",
      milestones: [],
      role: { name: "worker-M1.L1", state: "finished", reply: "Done.\nSTATUS: complete — ok" },
    });
  });
});

describe("profileTool", () => {
  it("reads, validates and sets a profile, and sets the phone's topic", () => {
    const deps = fakeDeps();
    expect(profileTool(deps, { action: "get" })).toMatchObject({ here: "test", profile: { name: "test" } });
    expect(profileTool(deps, { action: "validate" })).toEqual({ valid: true, errors: [], warnings: [] });
    expect(profileTool(deps, { action: "set", notifyUrl: "https://ntfy.sh/mine" })).toEqual({
      notifyUrl: "https://ntfy.sh/mine",
    });
    expect(deps.profiles.notifyUrl()).toBe("https://ntfy.sh/mine");
  });
});
