import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  INJECTED_TASK,
  interventionTotal,
  SCORECARD_TASKS,
  type ScorecardFile,
  type ScorecardTaskId,
  type TaskScore,
} from "../../src/domain/scorecard.ts";
import { formatComparison, formatPrepared } from "../../src/entry/scorecard-command.ts";
import { passBar } from "../../src/domain/scorecard.ts";
import { writeJsonAtomic } from "../../src/infra/store.ts";
import { type Prepared, saveTaskScore } from "../../src/services/scorecard.ts";
import { snapshotEnv, tempDir, withHome } from "../helpers.ts";
import { SRC } from "../import-graph.ts";

afterEach(snapshotEnv());

function catherd(args: string[], env: Record<string, string> = {}) {
  const inherited = { ...process.env };
  delete inherited.CATHERD_ROLE;
  const tmp = tempDir("scorecard-cli-");
  try {
    const p = Bun.spawnSync([process.execPath, join(SRC, "cli.ts"), ...args], {
      cwd: tmp,
      // A relative TMPDIR keeps the CLI from identifying the worker through its scratch path.
      env: { ...inherited, TMPDIR: ".", ANTHROPIC_API_KEY: "", NO_COLOR: "1", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const score = (task: ScorecardTaskId, over: Partial<TaskScore> = {}): TaskScore => {
  const i = {
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
  return {
    task,
    run: "r",
    catherdVersion: "1.5.0",
    startCommit: "abc",
    head: "def",
    milestones: ["M1"],
    landed: ["M1"],
    finished: true,
    interventions: { ...i, total: interventionTotal(i) },
    reviewRounds: 1,
    lanes: { total: 1, landed: 1, climbs: 0 },
    wallMinutes: 60,
    pausedMinutes: 0,
    quota: {
      backends: [{ backend: "codex", runs: 1, input: 12_000, cached: 0, output: 3000, limits: 0 }],
      claudeAgentTokens: 0,
    },
    acceptance: { passed: true, code: 0, timedOut: false, tail: [] },
    firstTry: true,
    injected: task === INJECTED_TASK ? { limits: 1, standInOk: true } : null,
    recordedAt: "2026-10-21T00:00:00.000Z",
    ...over,
  };
};

const file = (
  label: string,
  min: number,
  over: Partial<Record<ScorecardTaskId, Partial<TaskScore>>> = {},
): ScorecardFile => ({
  schema: 1,
  label,
  tasks: Object.fromEntries(SCORECARD_TASKS.map((t) => [t, score(t, { wallMinutes: min, ...over[t] })])),
});

const prepared = (over: Partial<Prepared> = {}): Prepared => ({
  schema: 1,
  task: "raqam-myanmar",
  dir: "/p/d",
  repo: "/p/d/repo",
  plan: "/p/d/plan.md",
  startCommit: "67951678b7cdb115b9f00eb63b3ea7f91a1c464d",
  limits: null,
  shim: null,
  preparedAt: "2026-10-21T00:00:00.000Z",
  prompt: "do /p/d/plan.md",
  ...over,
});

describe("catherd scorecard", () => {
  it("prints the folder, the start line, the prompt and the record command", () => {
    expect(formatPrepared(prepared(), "1.5.0")).toEqual([
      "✓ raqam-myanmar prepared in /p/d at 67951678",
      "  start:  cd /p/d/repo && claude",
      "  prompt: do /p/d/plan.md",
      "  record: catherd scorecard record /p/d --label 1.5.0",
    ]);
  });

  it("starts the injected task's session with the shim first on PATH and the limits dir", () => {
    const lines = formatPrepared(
      prepared({ task: INJECTED_TASK, limits: "/p/d/limits", shim: "/c/scorecard/shim" }),
    );
    expect(lines[1]).toBe(
      '  start:  cd /p/d/repo && CATHERD_SCORECARD_LIMITS=/p/d/limits PATH=/c/scorecard/shim:"$PATH" claude',
    );
    expect(lines[3]).toBe("  record: catherd scorecard record /p/d --label <label>");
  });

  it("shell-quotes every path it prints, so a pasted command survives spaces and quotes", () => {
    const dir = "/p/my dir/it's";
    const lines = formatPrepared(
      prepared({
        task: INJECTED_TASK,
        dir,
        repo: `${dir}/repo`,
        limits: `${dir}/limits`,
        shim: "/c/sh im",
      }),
      "1.5.0",
    );
    const q = `'/p/my dir/it'\\''s`;
    expect(lines[1]).toBe(
      `  start:  cd ${q}/repo' && CATHERD_SCORECARD_LIMITS=${q}/limits' PATH='/c/sh im':"$PATH" claude`,
    );
    expect(lines[3]).toBe(`  record: catherd scorecard record ${q}' --label 1.5.0`);
  });

  it("compares a label against its baseline, row by row, and ends with the verdict", () => {
    const current = file("plan-29", 66);
    const baseline = file("1.5.0", 60);
    const lines = formatComparison(current, baseline, passBar(current, baseline));
    expect(lines[0]).toBe("scorecard plan-29 against 1.5.0");
    expect(lines).toHaveLength(6);
    expect(lines[1]).toContain(
      "raqam-myanmar  1.5.0  finished yes  interventions 0  rounds 1  wall 66 min (60 min)",
    );
    expect(lines[1]).toEndWith("first try yes  quota 12k/3k");
    expect(lines.at(-1)).toBe("PASS");
    const unfinished = file("1.5.0", 60, { "raqam-myanmar": { finished: false } });
    const noted = formatComparison(current, unfinished, passBar(current, unfinished));
    expect(noted.slice(-2)).toEqual([
      "NOTE: baseline 1.5.0: raqam-myanmar did not finish, so its wall-clock stops where it was stopped and the wall-clock bar is lenient",
      "PASS",
    ]);
  });

  it("shows a task not recorded as a dash, a missing baseline as ?, and each failure", () => {
    const current = file("plan-29", 60);
    delete current.tasks["catherd-findings"];
    const lines = formatComparison(current, null, passBar(current, null));
    expect(lines[0]).toBe("scorecard plan-29 against no baseline");
    expect(lines[1]).toContain("wall 60 min (? min)");
    expect(lines[2]).toBe("catherd-findings  -");
    expect(lines.slice(-2)).toEqual([
      "FAIL: catherd-findings: not recorded",
      "FAIL: no full baseline to compare wall-clock against",
    ]);
  });

  it("refuses an unknown task with the four names, and exits 2", () => {
    withHome();
    const r = catherd(["scorecard", "prepare", "nope"]);
    expect([r.code, r.err]).toEqual([
      2,
      "error E_INPUT_INVALID: no scorecard task nope\nfix: catherd scorecard prepare raqam-myanmar|catherd-findings|sanitell-payment-3|injected-lao\n",
    ]);
  });

  it("compare exits 1 on a failing scorecard, 0 on a passing one, and 2 for a label never recorded", async () => {
    withHome();
    const results = tempDir("scorecard-results-");
    const put = async (f: ScorecardFile) => {
      for (const s of Object.values(f.tasks))
        await saveTaskScore(join(results, `${f.label}.json`), f.label, s);
    };
    await put(file("1.5.0", 60));
    await put(file("plan-29", 60));
    await put(file("plan-30", 60, { "raqam-myanmar": { finished: false } }));
    const compare = (label: string) => catherd(["scorecard", "compare", label, "--results", results]);
    expect(compare("plan-29").code).toBe(0);
    expect(compare("plan-29").out).toEndWith("PASS\n");
    const bad = compare("plan-30");
    expect([bad.code, bad.out]).toEqual([1, expect.stringContaining("FAIL: raqam-myanmar: not finished")]);
    const none = compare("plan-31");
    expect([none.code, none.err]).toEqual([
      2,
      "error E_INPUT_INVALID: no scorecard plan-31 yet\nfix: catherd scorecard record <dir> --label plan-31\n",
    ]);
    expect(
      JSON.parse(catherd(["scorecard", "compare", "plan-29", "--results", results, "--json"]).out).verdict
        .pass,
    ).toBe(true);
  });

  it("compare names the label, task and field of a malformed row instead of crashing or passing on NaN", () => {
    withHome();
    const results = tempDir("scorecard-results-");
    const bad = file("plan-bad", 60);
    const { interventions: _drop, ...broken } = bad.tasks["raqam-myanmar"] as TaskScore;
    writeJsonAtomic(join(results, "plan-bad.json"), {
      ...bad,
      tasks: {
        ...bad.tasks,
        "raqam-myanmar": broken,
      },
    });
    const r = catherd(["scorecard", "compare", "plan-bad", "--results", results]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("error E_INPUT_INVALID:");
    expect(r.err).toContain("plan-bad");
    expect(r.err).toContain("raqam-myanmar: interventions");
  });

  it("refuses a negative chat count, and refuses to run in a role's shell", () => {
    withHome();
    const dir = tempDir("scorecard-dir-");
    const chat = catherd(["scorecard", "record", dir, "--label", "x", "--chat=-1"]);
    expect([chat.code, chat.err]).toEqual([2, expect.stringContaining("--chat -1 is not a count")]);
    const role = catherd(["scorecard", "prepare", "raqam-myanmar"], {
      CATHERD_ROLE: "20260101-000000-x/worker-M1.L1",
    });
    expect(role.err).toContain("error E_ROLE_SCOPE: catherd scorecard prepare is the orchestrator's");
    expect(role.code).toBe(1);
  });

  it("lists scorecard in the top-level help", () => {
    expect(catherd(["--help"]).out).toContain("scorecard");
  });
});

describe("catherd scorecard stage (plan 51, spec D17)", () => {
  it("keeps every recorded run of a task, and compares two stages task by task", async () => {
    withHome();
    const results = tempDir("scorecard-results-");
    const put = async (label: string, run: string, min: number) => {
      for (const t of SCORECARD_TASKS)
        await saveTaskScore(
          join(results, `${label}.json`),
          label,
          score(t, { run: `${t}-${run}`, wallMinutes: min }),
        );
    };
    await put("stage-0", "a", 60);
    await put("stage-0", "b", 60);
    await put("stage-1", "a", 50);
    const stage = () =>
      catherd(["scorecard", "stage", "stage-1", "--baseline", "stage-0", "--results", results]);
    const one = stage();
    expect([one.code, one.out]).toEqual([1, expect.stringContaining("FAIL: raqam-myanmar: 1 run(s)")]);
    await put("stage-1", "b", 54);
    // recording a run again replaces it
    await put("stage-1", "b", 54);
    const two = stage();
    expect(two.code).toBe(0);
    expect(two.out).toContain("raqam-myanmar  runs 2 (2 finished)  wall 52 min (60 min)");
    expect(two.out).toEndWith("PASS\n");
  });

  it("refuses a stage whose baseline was never recorded", async () => {
    withHome();
    const results = tempDir("scorecard-results-");
    for (const t of SCORECARD_TASKS)
      await saveTaskScore(join(results, "stage-1.json"), "stage-1", score(t, { run: `${t}-a` }));
    const r = catherd(["scorecard", "stage", "stage-1", "--baseline", "nope", "--results", results]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("error E_INPUT_INVALID: no scorecard nope yet");
  });
});
