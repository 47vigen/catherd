import { describe, expect, it } from "bun:test";
import { isCatherdError } from "../../src/domain/errors.ts";
import {
  assertLabel,
  interventionTotal,
  type Interventions,
  INJECTED_TASK,
  passBar,
  runsOf,
  SCORECARD_TASKS,
  type ScorecardFile,
  ScorecardTaskSchema,
  type ScorecardTaskId,
  stageBar,
  type TaskScore,
} from "../../src/domain/scorecard.ts";

const ivs = (over: Partial<Omit<Interventions, "total">> = {}): Interventions => {
  const base = {
    parks: 0,
    answers: 0,
    takeovers: 0,
    manualDispatches: 0,
    pauses: 0,
    superseded: 0,
    chat: 0,
    cancels: 0,
    approvals: 0,
  };
  const i = { ...base, ...over };
  return { ...i, total: interventionTotal(i) };
};

const score = (task: ScorecardTaskId, over: Partial<TaskScore> = {}): TaskScore => ({
  task,
  run: "r",
  catherdVersion: "1.5.0",
  startCommit: "abc",
  head: "def",
  milestones: ["M1"],
  landed: ["M1"],
  finished: true,
  interventions: ivs(),
  reviewRounds: 1,
  lanes: { total: 1, landed: 1, climbs: 0 },
  wallMinutes: 60,
  pausedMinutes: 0,
  quota: { backends: [], claudeAgentTokens: 0 },
  acceptance: { passed: true, code: 0, timedOut: false, tail: [] },
  firstTry: true,
  injected: task === INJECTED_TASK ? { limits: 1, standInOk: true } : null,
  recordedAt: "2026-10-21T00:00:00.000Z",
  ...over,
});

const all = (min: number): Partial<Record<ScorecardTaskId, TaskScore>> =>
  Object.fromEntries(SCORECARD_TASKS.map((t) => [t, score(t, { wallMinutes: min })]));

const file = (label: string, tasks: Partial<Record<ScorecardTaskId, TaskScore>>): ScorecardFile => ({
  schema: 1,
  label,
  tasks,
});

const validTask = {
  schema: 1,
  id: "raqam-myanmar",
  title: "t",
  goal: "g",
  source: null,
  commit: "6795167".padEnd(40, "0"),
  plan: { file: "plan.md" },
  acceptance: "true",
  acceptanceTimeoutMin: 20,
  prompt: "do {plan}",
};

describe("scorecard", () => {
  it("refuses a short commit, a prompt without {plan}, and an unknown task id", () => {
    const ok = ScorecardTaskSchema.parse(validTask);
    expect(ok).toMatchObject({ limits: 0, setup: [], acceptFiles: [], inject: null });
    for (const bad of [{ commit: "6795167" }, { prompt: "do it" }, { id: "nope" }]) {
      expect(ScorecardTaskSchema.safeParse({ ...validTask, ...bad }).success).toBe(false);
    }
  });

  it("takes a version or plan label and refuses a path", () => {
    for (const l of ["1.5.0", "plan-29", "2.0.0-beta.3"]) expect(assertLabel(l)).toBe(l);
    for (const l of ["", "../x", "A", "a/b"]) {
      try {
        assertLabel(l);
        throw new Error("did not throw");
      } catch (e) {
        expect(isCatherdError(e) && e.code).toBe("E_INPUT_INVALID");
      }
    }
  });

  it("adds parks, takeovers, manual dispatches, pauses, superseded runs, chat, cancels and approvals, not answers", () => {
    expect(
      interventionTotal({
        parks: 1,
        answers: 5,
        takeovers: 2,
        manualDispatches: 3,
        pauses: 1,
        superseded: 1,
        chat: 2,
        cancels: 1,
        approvals: 1,
      }),
    ).toBe(12);
  });

  it("passes four finished tasks with no intervention, a recovered injected task and wall-clock within 10 % of the baseline", () => {
    expect(passBar(file("plan-29", all(66)), file("1.5.0", all(60)))).toEqual({
      pass: true,
      failures: [],
      notes: [],
      wall: { now: 264, baseline: 240 },
    });
  });

  it("notes an unfinished baseline row without failing the bar", () => {
    const baseline = file("1.5.0", {
      ...all(60),
      "raqam-myanmar": score("raqam-myanmar", { finished: false }),
    });
    expect(passBar(file("current", all(60)), baseline)).toMatchObject({
      pass: true,
      notes: [
        "baseline 1.5.0: raqam-myanmar did not finish, so its wall-clock stops where it was stopped and the wall-clock bar is lenient",
      ],
    });
  });

  it("fails a missing task, an unfinished one and one with interventions, naming each", () => {
    const tasks = all(60);
    delete tasks["raqam-myanmar"];
    tasks["catherd-findings"] = score("catherd-findings", { finished: false });
    tasks["sanitell-payment-3"] = score("sanitell-payment-3", { interventions: ivs({ parks: 1 }) });
    expect(passBar(file("x", tasks), file("1.5.0", all(60))).failures).toEqual([
      "raqam-myanmar: not recorded",
      "catherd-findings: not finished",
      "sanitell-payment-3: 1 intervention(s)",
    ]);
  });

  it("fails an injected task that never hit a limit, or whose stand-in did not end ok", () => {
    for (const injected of [{ limits: 0, standInOk: true }, { limits: 1, standInOk: false }, null]) {
      const tasks = { ...all(60), "injected-lao": score("injected-lao", { injected }) };
      expect(passBar(file("x", tasks), file("1.5.0", all(60))).failures).toEqual([
        "injected-lao: did not recover by itself",
      ]);
    }
  });

  it("fails a wall-clock more than 10 % over the baseline's total, and any comparison without a full baseline", () => {
    expect(passBar(file("x", all(67)), file("1.5.0", all(60))).failures).toEqual([
      "wall-clock 268 min against the baseline's 240 min (more than 10 % slower)",
    ]);
    expect(passBar(file("x", all(60)), null).failures).toEqual([
      "no full baseline to compare wall-clock against",
    ]);
    const one = { "raqam-myanmar": score("raqam-myanmar") };
    expect(passBar(file("x", all(60)), file("1.5.0", one)).pass).toBe(false);
  });

  it("never gates quota, review rounds or the first try", () => {
    const tasks = Object.fromEntries(
      SCORECARD_TASKS.map((t) => [
        t,
        score(t, {
          reviewRounds: 9,
          firstTry: false,
          quota: { backends: [], claudeAgentTokens: 9e9 },
        }),
      ]),
    );
    expect(passBar(file("x", tasks), file("1.5.0", all(60))).pass).toBe(true);
  });
});

describe("the stage comparison, per task (plan 51, spec D17)", () => {
  const metrics = {
    wallMin: 60,
    idlePct: 20,
    concurrency: 1.2,
    blockedMin: { needs_user: 4 },
    checkShare: 0.25,
    rounds: { perTask: { L1: 2 }, max: 2, total: 2 },
    climbs: 1,
    costUsd: null,
    standingStartSec: null,
    ownerQuestions: 0,
    verifierFails: 0,
  };
  const twice = (label: string, wall: (t: ScorecardTaskId) => number[]): ScorecardFile => ({
    schema: 1,
    label,
    tasks: {},
    runs: Object.fromEntries(
      SCORECARD_TASKS.map((t) => [
        t,
        wall(t).map((w, i) => score(t, { run: `${t}-${i}`, wallMinutes: w, metrics })),
      ]),
    ),
  });

  it("passes when every task ran twice, finished, and kept its median wall time within 10 %", () => {
    const v = stageBar(
      twice("stage-1", () => [50, 70]),
      twice("stage-0", () => [60, 60]),
    );
    expect(v.failures).toEqual([]);
    expect(v.rows[0]).toMatchObject({
      runs: 2,
      wallMin: 60,
      baselineWallMin: 60,
      idlePct: 20,
      blockedMin: 4,
      rounds: 2,
      // a stage-1 run recorded no check wait (plan 53)
      checkWaitShare: null,
    });
  });

  it("takes the median check wait of runs that recorded one (plan 53)", () => {
    const waited = twice("stage-2", () => [60, 60]);
    for (const runs of Object.values(waited.runs ?? {}))
      runs.forEach((r, i) => {
        if (r.metrics) r.metrics = { ...r.metrics, checkWaitShare: [0.1, 0.3][i] ?? null };
      });
    const v = stageBar(
      waited,
      twice("stage-1", () => [60, 60]),
    );
    expect(v.rows[0]?.checkWaitShare).toBe(0.2);
  });

  it("fails a task with one run, an unfinished run, or a slower median, even when the total is better", () => {
    const current = twice("stage-1", (t) => (t === "catherd-findings" ? [80, 80] : [10, 10]));
    (current.runs as Record<string, unknown[]>)["raqam-myanmar"] = [
      score("raqam-myanmar", { finished: false }),
    ];
    expect(
      stageBar(
        current,
        twice("stage-0", () => [60, 60]),
      ).failures,
    ).toEqual([
      "raqam-myanmar: 1 run(s); a stage is compared on 2 or more per task",
      "raqam-myanmar: 1 of 1 runs did not finish",
      "catherd-findings: median wall 80 min against stage-0's 60 min (more than 10 % slower)",
    ]);
  });

  it("fails a task the baseline ran fewer than twice", () => {
    const v = stageBar(
      twice("stage-1", () => [50, 50]),
      file("stage-0", all(60)),
    );
    expect(v.failures).toContain(
      "raqam-myanmar: 1 run(s) in stage-0; a stage is compared on 2 or more per task",
    );
  });

  it("reads a file written before plan 51 as one run per task", () => {
    expect(runsOf(file("1.5.0", all(60)), "raqam-myanmar")).toHaveLength(1);
  });
});
