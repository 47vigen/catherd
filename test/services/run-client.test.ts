import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isCatherdError } from "../../src/domain/errors.ts";
import type { RunEventInput } from "../../src/domain/run-events.ts";
import { daemonLauncher } from "../../src/services/daemon.ts";
import { answerUnit, cancelRun, profileTool, runResult, runStart } from "../../src/services/run-client.ts";
import { openQuestions, park } from "../../src/services/questions.ts";
import { appendEvent, readEvents } from "../../src/services/run-events-store.ts";
import { findRun, type Run } from "../../src/services/run-store.ts";
import { PLAN, startedFields } from "../domain/run-fixtures.ts";
import { snapshotEnv, tempRepo, withHome } from "../helpers.ts";
import { fakeDeps, fakeDispatch, freshRun } from "./helpers.ts";

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
  await appendEvent(run, { type: "plan.ready", milestones: PLAN });
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
      { type: "run.started", title: "wallet", aLines: ["A1 it works"], plan: [], base: null, engine: "2.0" },
    ]);
    expect(launched).toEqual([run.id]);
    expect(r).toMatchObject({
      daemon: "revived",
      dir: run.dir,
      notifyUrl: "https://ntfy.sh/catherd-test",
    });
    expect(r.next).toContain("https://ntfy.sh/catherd-test");
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
  it("returns the report and the milestones, and with a name the role's record", async () => {
    const { run } = freshRun();
    await seed(
      run,
      {
        type: "milestone.landed",
        milestone: "M1",
        commit: "a".repeat(40),
        knownIssues: ["a nit"],
        digestPath: "/d/M1.md",
      },
      { type: "run.ended", outcome: "done", reportPath: null },
    );
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
      milestones: [
        {
          id: "M1",
          status: "landed",
          commit: "a".repeat(40),
          digestPath: "/d/M1.md",
          knownIssues: ["a nit"],
        },
        { id: "M2", status: "waiting", digestPath: null },
      ],
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
