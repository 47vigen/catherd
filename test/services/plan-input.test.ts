import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isCatherdError } from "../../src/domain/errors.ts";
import {
  copyPlanInputs,
  deliveredALineTexts,
  laneTasks,
  milestoneTasks,
  numberedALines,
  PLAN_INPUT_DIR,
  planDocs,
  planInputPaths,
  planProblems,
  resolvePlanInputs,
  roleALines,
  taskBlock,
  UNIT_CONTEXT_MAX,
  uncoveredALines,
  unitContext,
} from "../../src/services/plan-input.ts";
import { appendEvent } from "../../src/services/run-events-store.ts";
import type { Run } from "../../src/services/run-store.ts";
import { startedFields } from "../domain/run-fixtures.ts";
import { snapshotEnv, tempDir } from "../helpers.ts";
import { freshRun, PLAN_TEXT, writeLane } from "./helpers.ts";

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, "../fixtures/briefs", name), "utf8");

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
  text: string | Record<string, string> = PLAN_TEXT,
): Promise<{ run: Run; repo: string; files: string[] }> {
  const { run, repo } = freshRun();
  const files = plan.map((name) => {
    const f = join(repo, name);
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, typeof text === "string" ? text : (text[name] as string));
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

  it("asks nothing of a lane's tasks, nor of plan.md's depth", async () => {
    const { run } = await planRun(["p.md"]);
    writeLane(run, "M1.L1", ["src/a.ts"]);
    writeLane(run, "M1.L2", ["src/b.ts"], "true", "Kind: repo_code\nDifficulty: build\nTasks: 9203\n");
    expect(planProblems(run).filter((p) => !p.includes("under no milestone"))).toEqual([]);
    const bare = freshRun().run;
    await appendEvent(bare, { type: "run.started", ...startedFields });
    writeFileSync(join(bare.dir, "plan.md"), "# P\n");
    // plan 48: no run waits for a plan approval, so nothing checks plan.md's depth
    expect(planProblems(bare).filter((p) => p.startsWith("plan.md"))).toEqual([]);
    expect(existsSync(join(run.dir, "plan.md"))).toBe(false);
  });

  it("refuses a plan that leaves an A-line with no milestone, naming the missing ids", () => {
    const { run } = freshRun();
    writeFileSync(join(run.dir, "plan.md"), "# P\n## M1 — core\n- A1 it works\n## M2 — docs\n- A3 x\n");
    // the run's lines: A1 (owned by M1), A2 and A3 as the architect wrote them
    run.meta.aLines = ["A1 it works", "A2 more", "A3 x", "plan: p.md"];
    writeLane(run, "M1.L1", ["src/a.ts"]);
    writeLane(run, "M2.L1", ["docs/a.md"]);
    const unowned = () => planProblems(run).filter((p) => p.includes("under no milestone"));
    expect(unowned()).toEqual([
      "A2 is cited under no milestone: under the milestone that delivers each, write it in plan.md as an A<n> line",
    ]);
    writeFileSync(join(run.dir, "plan.md"), "# P\n## M1 — core (A1, A2)\n## M2 — docs\n- A3 x\n");
    expect(unowned()).toEqual([]);
    // a section whose milestone has no lane never runs, so it owns nothing
    writeFileSync(
      join(run.dir, "plan.md"),
      "# P\n## M1 — core (A1, A2)\n## M2 — docs\n## M3 — gone\n- A3 x\n",
    );
    expect(unowned()).toEqual([
      "A3 is cited under no milestone: under the milestone that delivers each, write it in plan.md as an A<n> line",
    ]);
    // no plan.md: every numbered line is unowned
    rmSync(join(run.dir, "plan.md"));
    expect(unowned()).toEqual([
      "A1, A2, A3 are cited under no milestone: under the milestone that delivers each, write it in plan.md as an A<n> line",
    ]);
  });
});

it("numbers A-lines written without an id, and only when none has one", () => {
  expect(numberedALines(["truncate cuts at 8", "plan: p.md", "bun test passes"])).toEqual([
    { id: "A1", line: "A1 truncate cuts at 8" },
    { id: undefined, line: "plan: p.md" },
    { id: "A2", line: "A2 bun test passes" },
  ]);
  expect(numberedALines(["A3 x", "y"])).toEqual([
    { id: "A3", line: "A3 x" },
    { id: undefined, line: "y" },
  ]);
});

it("uncoveredALines drops lines marked (Check)", () => {
  const { run } = freshRun();
  run.meta.aLines = ["A1 — x", "A2 — the root gate is green (Check)."];
  writeLane(run, "M1.L1", ["src/a.ts"]);
  writeFileSync(join(run.dir, "plan.md"), "## M1 — core\nA1 — x\nA2 — the root gate is green (Check).\n");
  expect(uncoveredALines(run, "M1")).toEqual(["A1 — x"]);
});

it("uncoveredALines leaves process lines to no one", () => {
  const { run } = freshRun();
  run.meta.aLines = ["A1 — x", "A2 — commit subject reads feat: y", "A3 — red evidence for z"];
  writeLane(run, "M1.L1", ["src/a.ts"]);
  writeFileSync(join(run.dir, "plan.md"), `## M1 — core\n${run.meta.aLines.join("\n")}\n`);
  expect(uncoveredALines(run, "M1")).toEqual(["A1 — x"]);
});

it("no role reads a process line among its A-lines", () => {
  const { run } = freshRun();
  run.meta.aLines = ["A1 — x", "A2 — commit subject reads feat: y", "A3 — red evidence for z"];
  writeLane(run, "M1.L1", ["src/a.ts"]);
  writeFileSync(join(run.dir, "plan.md"), `## M1 — core\n${run.meta.aLines.join("\n")}\n`);
  expect(roleALines(run, "worker", "M1.L1")).toEqual(["A1 — x"]);
});

it("uncoveredALines gives each line without its list marker", () => {
  const { run } = freshRun();
  run.meta.aLines = ["A1 — x", "A2 — y", "A3 — the root gate is green (Check)."];
  writeLane(run, "M1.L1", ["src/a.ts"]);
  writeFileSync(
    join(run.dir, "plan.md"),
    "## M1 — core\n- A1 — x\n  * A2 — y\n- A3 — the root gate is green (Check).\n",
  );
  expect(uncoveredALines(run, "M1")).toEqual(["A1 — x", "A2 — y"]);
});

it("deliveredALineTexts keeps the lines marked (Check), each without its list marker", () => {
  const { run } = freshRun();
  run.meta.aLines = ["A1 — x", "A2 — the root gate is green (Check)."];
  writeLane(run, "M1.L1", ["src/a.ts"]);
  writeFileSync(
    join(run.dir, "plan.md"),
    "## M1 — core\n- A1 — x\n  * A2 — the root gate is green (Check).\n",
  );
  expect(deliveredALineTexts(run, "M1")).toEqual(["A1 — x", "A2 — the root gate is green (Check)."]);
});

it("refuses an unnumbered A-line cited under no milestone", () => {
  const { run } = freshRun();
  run.meta.aLines = ["login works", "logout works"];
  writeLane(run, "M1.L1", ["src/a.ts"]);
  writeLane(run, "M2.L1", ["src/b.ts"]);
  writeFileSync(join(run.dir, "plan.md"), "## M1 — core\n- A1 login works\n## M2 — docs\n");
  expect(planProblems(run).filter((p) => p.includes("under no milestone"))).toEqual([
    "A2 is cited under no milestone: under the milestone that delivers each, write it in plan.md as an A<n> line",
  ]);
});

it("a one-milestone plan owns every A-line, and no plan.md owns none", () => {
  const { run } = freshRun();
  run.meta.aLines = ["A1 x", "A2 y"];
  writeLane(run, "M1.L1", ["src/a.ts"]);
  writeFileSync(join(run.dir, "plan.md"), "# P\n## M1 — all\n");
  const unowned = () => planProblems(run).filter((p) => p.includes("under no milestone"));
  expect(unowned()).toEqual([]);
  rmSync(join(run.dir, "plan.md"));
  expect(unowned()).toEqual([
    "A1, A2 are cited under no milestone: under the milestone that delivers each, write it in plan.md as an A<n> line",
  ]);
});

describe("the unit context", () => {
  const briefFiles = () => ({
    "plan.md": fixture("plan.md"),
    "spec.md": fixture("spec.md"),
    "credit.md": fixture("credit.md"),
  });
  const briefRun = async (files: Record<string, string> = briefFiles()) => {
    const { run } = await planRun(Object.keys(files), files);
    writeLane(run, "M1.L1", ["src/ledger.ts"], "true", "Kind: repo_code\nDifficulty: build\nTasks: 1\n");
    return run;
  };

  it("a task's §n resolves in its own files only", async () => {
    const run = await briefRun();
    const text = unitContext(run, "worker", "M1.L1").join("\n\n");
    expect(text).toContain("### Task 1: Implement the ledger");
    expect(text).toContain("PLAN-3.2-MARK");
    expect(text).toContain("SPEC-4-MARK");
    for (const absent of ["PLAN-3.1-MARK", "SPEC-3.1-MARK", "SPEC-3.2-MARK", "CREDIT-3-MARK", "SPEC-9-MARK"])
      expect(text).not.toContain(absent);
    const onDemand = text.slice(text.indexOf("Read on demand:"));
    expect(onDemand).toContain("plan-input/spec.md");
    expect(onDemand).toContain("plan-input/credit.md");
    expect(onDemand).not.toContain("plan-input/plan.md");
  });

  it("the unit context is capped with a pointer", async () => {
    const files = briefFiles();
    files["plan.md"] = files["plan.md"].replace("spec.md §4", "spec.md §9");
    const run = await briefRun(files);
    const text = unitContext(run, "worker", "M1.L1").join("\n\n");
    expect(text.length).toBeLessThanOrEqual(UNIT_CONTEXT_MAX);
    expect(text).toContain("cut: read plan-input/spec.md");
    expect(text).toContain("SPEC-9-MARK");
  });

  it("a heading inside a fence does not end a cited section", async () => {
    const files = briefFiles();
    files["spec.md"] = files["spec.md"].replace(
      "SPEC-4-MARK",
      "SPEC-4-MARK\n\n```sh\n# install deps\nSPEC-4-TAIL-MARK\n```",
    );
    const run = await briefRun(files);
    expect(unitContext(run, "worker", "M1.L1").join("\n\n")).toContain("SPEC-4-TAIL-MARK");
  });

  it("the whole unit context stays within the byte cap, naming where the rest is", async () => {
    const files = briefFiles();
    const big = `${"émoji 😀 line of a very large task\n".repeat(3_000)}`;
    files["plan.md"] = files["plan.md"].replace(
      "### Task 1: Implement the ledger\n",
      `### Task 1: Implement the ledger\n${big}`,
    );
    const run = await briefRun(files);
    const blocks = unitContext(run, "worker", "M1.L1");
    const text = blocks.join("\n\n");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(UNIT_CONTEXT_MAX + 400);
    expect(text).toContain("cut: read plan-input/plan.md");
    // the cut task block keeps its closing tag
    expect(blocks.find((b) => b.startsWith("<plan-task"))).toEndWith("</plan-task>");
    expect(text).toContain("Read on demand:");
    expect(text).not.toContain("\uFFFD");
  });

  it("the slim lane and the bloated lane render the same unit context", async () => {
    const slim = await briefRun();
    const files = briefFiles();
    files["spec.md"] += `\n## 12. Appendix\n\n${"unrelated appendix text ".repeat(4_200)}\n`;
    const bloated = await briefRun(files);
    expect(unitContext(bloated, "worker", "M1.L1")).toEqual(unitContext(slim, "worker", "M1.L1"));
  });

  it("a worker sees worker and run lines only", () => {
    const { run } = freshRun();
    writeFileSync(
      join(run.dir, "plan.md"),
      "# P\n## M1 — a\nA1 [worker] — x\nA2 [verifier] — y\nA3 — z\n## M2 — b\n",
    );
    run.meta.aLines = ["A1 [worker] — x", "A2 [verifier] — y", "A3 — z"];
    writeLane(run, "M1.L1", ["src/a.ts"]);
    writeLane(run, "M2.L1", ["src/b.ts"]);
    expect(roleALines(run, "worker", "M1.L1")).toEqual(["A1 [worker] — x", "A3 — z"]);
    expect(roleALines(run, "verifier", "M1")).toEqual(["A2 [verifier] — y", "A3 — z"]);
    expect(roleALines(run, "architect", "M1")).toHaveLength(3);
    expect(roleALines(run, "reviewer", "run")).toHaveLength(3);
    expect(unitContext(run, "verifier", "M1").join("\n")).toContain("A2 [verifier] — y");
    expect(unitContext(run, "verifier", "M1").join("\n")).not.toContain("A1 [worker]");
  });

  it("an untagged plan.md A-line is a plan problem", () => {
    const { run } = freshRun();
    writeFileSync(join(run.dir, "plan.md"), "# P\n## M1 — core\n- A1 — x\n- A2 [run] — y\nA3 [judge] — z\n");
    run.meta.aLines = ["A1 — x", "A2 [run] — y", "A3 [judge] — z"];
    writeLane(run, "M1.L1", ["src/a.ts"]);
    const tag = (p: string) => p.includes("has no owner tag");
    expect(planProblems(run).filter(tag)).toEqual([
      "A1 in plan.md has no owner tag: write it A1 [worker|reviewer|verifier|run]",
      "A3 in plan.md has no owner tag: write it A3 [worker|reviewer|verifier|run]",
    ]);
  });
});
