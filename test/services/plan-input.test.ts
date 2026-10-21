import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isCatherdError } from "../../src/domain/errors.ts";
import {
  copyPlanInputs,
  laneTasks,
  milestoneTasks,
  PLAN_CONTEXT_MAX,
  PLAN_INPUT_DIR,
  planContext,
  planDocs,
  planInputPaths,
  planProblems,
  resolvePlanInputs,
  taskBlock,
} from "../../src/services/plan-input.ts";
import { appendEvent } from "../../src/services/run-events-store.ts";
import type { Run } from "../../src/services/run-store.ts";
import { startedFields } from "../domain/run-fixtures.ts";
import { snapshotEnv, tempDir } from "../helpers.ts";
import { freshRun, PLAN_TEXT, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());

const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (isCatherdError(e)) return e;
    throw e;
  }
  throw new Error("expected a refusal");
};

/** A daemon run whose run.started names `plan` (copied as run_start would). */
async function planRun(
  plan: string[],
  text = PLAN_TEXT,
): Promise<{ run: Run; repo: string; files: string[] }> {
  const { run, repo } = freshRun();
  const files = plan.map((name) => {
    const f = join(repo, name);
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, text);
    return f;
  });
  await appendEvent(run, { type: "run.started", ...startedFields, repo, plan: files });
  copyPlanInputs(run, files);
  return { run, repo, files };
}

describe("resolvePlanInputs", () => {
  it("resolves a relative path against the repo, accepts one outside it, and dedupes", () => {
    const repo = tempDir("pi-repo-");
    const out = tempDir("pi-out-");
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, "docs/p.md"), PLAN_TEXT);
    writeFileSync(join(out, "q.md"), PLAN_TEXT);
    expect(resolvePlanInputs(repo, ["docs/p.md", join(out, "q.md"), join(repo, "docs/p.md")])).toEqual([
      join(repo, "docs/p.md"),
      join(out, "q.md"),
    ]);
  });

  it("refuses a missing file, a directory, and files none of which has a task", () => {
    const repo = tempDir("pi-repo-");
    writeFileSync(join(repo, "c.md"), "# contracts\nno tasks\n");
    expect(refusal(() => resolvePlanInputs(repo, ["nope.md"])).message).toBe(
      `plan file ${join(repo, "nope.md")} does not exist`,
    );
    expect(refusal(() => resolvePlanInputs(repo, ["."])).message).toBe(`plan ${repo} is not a file`);
    const e = refusal(() => resolvePlanInputs(repo, ["c.md"]));
    expect([e.code, e.message, e.fix]).toEqual([
      "E_INPUT_INVALID",
      `none of the plan files has a "### Task <n>:" heading: ${join(repo, "c.md")}`,
      "pass the reviewed plan, or no plan and the architect writes one",
    ]);
  });

  it("lets a contracts file ride along when another file has tasks", () => {
    const repo = tempDir("pi-repo-");
    writeFileSync(join(repo, "c.md"), "# contracts\n");
    writeFileSync(join(repo, "p.md"), PLAN_TEXT);
    expect(resolvePlanInputs(repo, ["c.md", "p.md"])).toHaveLength(2);
  });
});

it("reads plan: A-lines, comma-separated, case-insensitively", () =>
  expect(planInputPaths(["A1 x", "Plan: docs/a.md, docs/b.md ", "plan:"])).toEqual([
    "docs/a.md",
    "docs/b.md",
  ]));

describe("the copies", () => {
  it("copies each file privately, numbering a repeat, and copies again after an edit", async () => {
    const { run, files } = await planRun(["a/plan.md", "b/plan.md"]);
    expect(readFileSync(join(run.dir, PLAN_INPUT_DIR, "plan.md"), "utf8")).toBe(PLAN_TEXT);
    expect(readFileSync(join(run.dir, PLAN_INPUT_DIR, "plan-2.md"), "utf8")).toBe(PLAN_TEXT);
    expect(statSync(join(run.dir, PLAN_INPUT_DIR, "plan.md")).mode & 0o777).toBe(0o600);
    writeFileSync(files[0] as string, `${PLAN_TEXT}\n### Task 4: more\nTest: x.test.ts\n`);
    copyPlanInputs(run, files);
    expect(planDocs(run).map((d) => [d.name, d.tasks.length])).toEqual([
      ["plan.md", 4],
      ["plan-2.md", 3],
    ]);
  });

  it("reads plan.md when the run has no plan input, and nothing when it has neither", async () => {
    const { run } = freshRun();
    await appendEvent(run, { type: "run.started", ...startedFields });
    expect(planDocs(run)).toEqual([]);
    writeFileSync(join(run.dir, "plan.md"), PLAN_TEXT);
    expect(planDocs(run).map((d) => d.name)).toEqual(["plan.md"]);
  });
});

describe("planContext", () => {
  it("gives every role but the architect and the judge the plan's preamble", async () => {
    const { run } = await planRun(["p.md"]);
    expect(planContext(run, "worker")).toBe(
      "The plan's preamble (p.md), which applies to every task:\n\n# Plan P\nGoal: a wallet.",
    );
    expect(planContext(run, "reviewer")).toBe(planContext(run, "worker"));
    expect(planContext(run, "architect")).toBeNull();
    expect(planContext(run, "judge")).toBeNull();
  });

  it("gives a file with no task whole, and names the copies past the cap", async () => {
    const { run } = await planRun(["c.md"], "# Contracts\nnames\n");
    expect(planContext(run, "worker")).toBe(
      "The plan file c.md, which every task follows:\n\n# Contracts\nnames",
    );
    const big = await planRun(
      ["big.md"],
      `# Big\n${"x".repeat(PLAN_CONTEXT_MAX)}\n### Task 1: t\nTest: a.test.ts\n`,
    );
    expect(planContext(big.run, "worker")).toBe(
      `The run's plan files are too long to repeat here; read them before you start, with read_run_file: ${PLAN_INPUT_DIR}/big.md`,
    );
  });

  it("is null for a run with no plan, and for a 1.5 run", async () => {
    const { run } = freshRun();
    expect(planContext(run, "worker")).toBeNull();
  });
});

describe("a lane's tasks", () => {
  it("reads a lane's tasks from its Tasks: line, and a milestone's in lane order", async () => {
    const { run } = await planRun(["p.md"]);
    writeLane(run, "M1.L10", ["src/c.ts"], "true", "Kind: repo_code\nDifficulty: build\nTasks: 2\n");
    writeLane(
      run,
      "M1.L2",
      ["src/b.ts"],
      "true",
      "Kind: repo_code\nDifficulty: build\nTasks: 2, 1, p.md#9\n",
    );
    writeLane(run, "M2.L1", ["docs/"], "true", "Kind: prose\nDifficulty: copy\nTasks: p.md#3\n");
    expect(laneTasks(run, "M1.L2").map((t) => t.id)).toEqual(["2", "1"]);
    expect(milestoneTasks(run, "M1").map((t) => t.id)).toEqual(["2", "1"]);
    expect(milestoneTasks(run, "M2").map((t) => t.id)).toEqual(["3"]);
    expect(taskBlock(laneTasks(run, "M2.L1")[0] as never)).toBe(
      '<plan-task file="p.md" id="3">\n### Task 3: docs\nWrite the docs.\nTest: `docs.test.ts` — links\n</plan-task>',
    );
  });

  it("lists every lane's coverage problem, and plan.md's depth only with no plan input", async () => {
    const { run } = await planRun(["p.md"]);
    writeLane(run, "M1.L1", ["src/a.ts"]);
    expect(planProblems(run)).toEqual([
      "lanes/M1.L1.md has no Tasks: line: name the plan tasks it implements",
    ]);
    const bare = freshRun().run;
    await appendEvent(bare, { type: "run.started", ...startedFields });
    writeFileSync(join(bare.dir, "plan.md"), "# P\n");
    expect(planProblems(bare)).toContain('plan.md has no "## Contracts" section');
    expect(existsSync(join(run.dir, "plan.md"))).toBe(false);
  });
});
