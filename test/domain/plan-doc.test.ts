import { describe, expect, it } from "bun:test";
import {
  A_LINE_OWNERS,
  aLineOwner,
  approvalQuestion,
  baselineItems,
  CHECK_COVERED,
  decisionLines,
  depthProblems,
  formatCommand,
  isAccept,
  isApproval,
  milestoneCheck,
  milestoneSection,
  parsePlanDoc,
  planInputNames,
  readsALine,
  resolveTask,
  PROCESS_LINE,
} from "../../src/domain/plan-doc.ts";

describe("parsePlanDoc", () => {
  it("splits a plan into its preamble and its tasks, each ending at the next ## heading", () => {
    const d = parsePlanDoc(
      "p.md",
      '# P\nGoal: x\n\n## M1 — one\n\n### Task 1: add login\nAdd a login page.\n\n### Task 2: store\n**Interfaces:** `saveUser(u: User): Promise<void>`\n\n### Task 3: tests\nTest: `src/a.test.ts` — "refuses a bad token"\n\n## Contracts\nnames\n',
    );
    expect(d.preamble).toBe("# P\nGoal: x\n\n");
    expect(d.tasks.map((t) => [t.id, t.title, t.signature, t.test])).toEqual([
      ["1", "add login", false, false],
      ["2", "store", true, false],
      ["3", "tests", false, true],
    ]);
    expect(d.tasks[2]?.text).not.toContain("## Contracts");
    expect(d.tasks[0]?.text).toBe("### Task 1: add login\nAdd a login page.\n\n");
  });

  it("reads a plan with no task as all preamble", () => {
    const text = "# Contracts\n\n## 3. Names\nsome text\n";
    const d = parsePlanDoc("c.md", text);
    expect(d.tasks).toEqual([]);
    expect(d.preamble).toBe(text);
  });

  it("ends the preamble at the first milestone heading when it comes before any task", () => {
    expect(parsePlanDoc("p.md", "intro\n## M2 — x\ntext\n").preamble).toBe("intro\n");
  });

  it("a dotted task id is its own task", () => {
    const d = parsePlanDoc("p.md", "### Task 1.3: x\nTest: a.test.ts\n\n### Task 1.4: y\nTest: b.test.ts\n");
    expect(d.tasks.map((t) => [t.id, t.title])).toEqual([
      ["1.3", "x"],
      ["1.4", "y"],
    ]);
    expect(resolveTask([d], "1.3")).toMatchObject({ id: "1.3", title: "x" });
    expect(resolveTask([d], "p.md#1.4")).toMatchObject({ id: "1.4", title: "y" });
  });

  it("`### Task 1. Title` still parses as task 1", () => {
    const d = parsePlanDoc("p.md", "### Task 1. Title\nTest: a.test.ts\n");
    expect(d.tasks.map((t) => [t.id, t.title])).toEqual([["1", "Title"]]);
  });
});

describe("resolveTask", () => {
  const docs = [
    parsePlanDoc("a.md", "### Task 3: x\n```\n```\n"),
    parsePlanDoc("b.md", "### Task 3: y\nTest: t.test.ts\n\n### Task 4: z\nprose only\n"),
  ];

  it("resolves a task ref, refusing a missing task and a number two files share", () => {
    expect(resolveTask(docs, "b.md#3")).toMatchObject({ doc: "b.md", title: "y" });
    expect(resolveTask(docs, "4")).toMatchObject({ doc: "b.md", title: "z" });
    expect(resolveTask(docs, "3")).toBe("task 3 is in a.md and b.md: write a.md#3");
    expect(resolveTask(docs, "9")).toBe("no task 9 in a.md, b.md");
    expect(resolveTask(docs, "c.md#3")).toBe("no plan file c.md");
    expect(resolveTask(docs, "b.md#9")).toBe("no task 9 in b.md");
  });

  it("refuses a task number one file holds twice, naming the file and the number", () => {
    const twice = [
      parsePlanDoc("p.md", "## Task 13 — a\nTest: a.test.ts\n\n### Task 13: b\nTest: b.test.ts\n"),
    ];
    const note = "p.md holds Task 13 twice: renumber one of them";
    expect(resolveTask(twice, "13")).toBe(note);
    expect(resolveTask(twice, "p.md#13")).toBe(note);
  });
});

const FULL = [
  "# Plan",
  "## What already exists",
  "- `src/a.ts` — `a(): void` — the thing",
  "## Contracts",
  "`b(x: number): string`",
  "## Decisions",
  "D1 — use a map — rejected: an array — slower",
  "## M1 — one",
  "### Task 1: do it",
  "Test: `test/a.test.ts` — asserts a",
  "",
].join("\n");

describe("depthProblems", () => {
  it("accepts a rejected alternative on a decision's wrapped line", () => {
    const wrapped = FULL.replace("D1 — use a map — rejected: an array — slower", "D1 — x\n  rejected: y — z");
    expect(depthProblems(parsePlanDoc("plan.md", wrapped))).toEqual([]);
  });

  it("asks a written plan for the three sections and a rejected alternative per decision, never a task's test", () => {
    expect(depthProblems(parsePlanDoc("plan.md", FULL))).toEqual([]);
    expect(depthProblems(parsePlanDoc("plan.md", "# P\n"))).toEqual([
      'plan.md has no "## What already exists" section',
      'plan.md has no "## Contracts" section',
      'plan.md has no "## Decisions" section',
    ]);
    const bad = FULL.replace("Test: `test/a.test.ts` — asserts a", "just do it")
      .replace(" — rejected: an array — slower", " — because")
      .replace("`src/a.ts` — `a(): void` — the thing", "nothing");
    expect(depthProblems(parsePlanDoc("plan.md", bad))).toEqual([
      "plan.md D1 names no rejected alternative: write D1 — <choice> — rejected: <alternative> — <why>",
      "plan.md's What already exists lists no path",
    ]);
  });
});

describe("approval", () => {
  it("reads a decision's wrapped lines and a numbered marker", () => {
    const a = "## Decisions\n1. D1 — x — rejected: y\n   because z\n\nD2 — p\n";
    expect(decisionLines(a).get("D1")).toBe("1. D1 — x — rejected: y because z");
    expect(decisionLines(a).get("D2")).toBe("D2 — p");
    expect(decisionLines("## Decisions\n- **D10** — a   b\n").get("D10")).toBe("- **D10** — a b");
  });

  it("approves only on a bare approving word", () => {
    expect(["approve", " Approved. ", "LGTM!", "ok", "yes"].every(isApproval)).toBe(true);
    expect(["ok but rename X", "approve after Task 2 changes", "", "no"].some(isApproval)).toBe(false);
  });

  it("words the questions exactly", () => {
    expect(approvalQuestion("r1")).toBe(
      "The architect's plan is ready for your review: catherd run-file read r1 plan.md. Answer approve, or say what to change.",
    );
  });
});

it("names plan copies by basename, numbering a repeat", () =>
  expect(planInputNames(["/a/plan.md", "/b/plan.md", "/c/x.md"])).toEqual(["plan.md", "plan-2.md", "x.md"]));

it("milestoneCheck reads the Check line of its section only", () => {
  const plan =
    "## M1 — first\nCheck: a && b\n## M2 — second\nCheck: c && d\n## M3 — none\n## M10 — tenth\nCheck: e\n";
  expect(milestoneCheck(plan, "M1")).toBe("a && b");
  expect(milestoneCheck(plan, "M2")).toBe("c && d");
  expect(milestoneCheck(plan, "M3")).toBeNull();
  expect(milestoneCheck(plan, "M4")).toBeNull();
});

it("milestoneCheck finds Check: under every heading form planOf accepts", () => {
  for (const heading of ["## M1 — t", "## M1 – t", "## M1 - t", "## M1: t", "## M1. t", "## M1 t", "## M1"]) {
    expect(milestoneCheck(`${heading}\nCheck: x && y\n`, "M1")).toBe("x && y");
  }
});

it("milestoneCheck does not take M10's check for M1 and ends at non-milestone headings", () => {
  const tenth = "## M10: t\nCheck: z\n";
  expect(milestoneCheck(tenth, "M1")).toBeNull();
  expect(milestoneCheck(tenth, "M10")).toBe("z");

  expect(milestoneCheck("## M1: t\n## Decisions\nCheck: x\n## M2: t\nCheck: y\n", "M1")).toBeNull();
});

it("isAccept takes accept with text after it", () => {
  expect(["accept", "Accept.", "accept: A8 is judged from the tree"].every(isAccept)).toBe(true);
  const notAccept = ["do not accept", "acceptance", "accepted", "acceptance criteria are met"];
  expect(notAccept.some(isAccept)).toBe(false);
});

it("CHECK_COVERED takes an A-line that ends (Check), a trailing period allowed", () => {
  const covered = [
    "- A1 the sum is right (Check)",
    "- A2 the page loads (Check).",
    "- A3 it is quick (check)",
  ];
  expect(covered.every((line) => CHECK_COVERED.test(line))).toBe(true);
  const uncovered = ["- A4 judged by eye", "- A5 (Check) and then more", "- A6 Check"];
  expect(uncovered.some((line) => CHECK_COVERED.test(line))).toBe(false);
});

it("PROCESS_LINE takes process wording about the work, and leaves product lines alone", () => {
  const process = [
    "A1 — each commit subject reads exactly `feat(kit): add pin`",
    "A2 — red evidence: the new tests fail before the implementation",
    "A3 — this diff may not touch files outside packages/kit",
    "A4 — tests failed before the code",
    "A5 — TDD all the way",
    "A6 — commit subject reads feat: y",
    "A7 — the lane's commits name the task",
    "A8 — the parser lands in its own commit",
    "A9 — a red run first, then the code",
    "A10 — tests written first",
    "A11 — the change touches only the files of packages/kit",
  ];
  expect(process.filter((l) => !PROCESS_LINE.test(l))).toEqual([]);
  const product = [
    "A1 — Saving changes only the edited row",
    "A2 — the panel shows the commit message of each run",
    "A3 — the CLI prints the commit subject",
    "A4 — a schema change must not change existing rows",
    "A5 — the hook rejects a red run before push",
    "A6 — the CLI does not modify files outside the target directory",
  ];
  expect(product.filter((l) => PROCESS_LINE.test(l))).toEqual([]);
});

it("baselineItems reads the section and the preamble", () => {
  const plan = [
    "# P",
    "Baseline: bun test legacy",
    "## M1 — one",
    "Check: x",
    "## M2 — two",
    "Baseline: bun test m2",
    "## Out of scope",
    "Baseline: never",
    "",
  ].join("\n");
  expect(baselineItems(plan, "M2")).toEqual(["bun test legacy", "bun test m2"]);
  expect(baselineItems(plan, "M1")).toEqual(["bun test legacy"]);
});

it("formatCommand reads the section, then the preamble", () => {
  const plan = [
    "# P",
    "Format: bunx oxfmt",
    "## M1 — one",
    "Check: x",
    "## M2 — two",
    "Format: npx prettier --write",
    "",
  ].join("\n");
  expect(formatCommand(plan, "M2")).toBe("npx prettier --write");
  expect(formatCommand(plan, "M1")).toBe("bunx oxfmt");
  expect(formatCommand("# P\n## M1 — one\nCheck: x\n", "M1")).toBeNull();
});

it("milestoneSection stops at the next ## heading", () => {
  const plan = "## M1 — one\nCheck: a && b\n### Task 1: x\nprose\n## M2 — two\nCheck: c && d\n";
  expect(milestoneSection(plan, "M1")).toBe("## M1 — one\nCheck: a && b\n### Task 1: x\nprose");
  expect(milestoneSection(plan, "M3")).toBeNull();
});

describe("A-line owner tags", () => {
  it("an A-line names its owner", () => {
    expect(aLineOwner("A3 [verifier] — the build boots")).toBe("verifier");
    expect(aLineOwner("- A2 [run] — x")).toBe("run");
    expect(aLineOwner("A1 — y")).toBeNull();
    expect(aLineOwner("A4 [judge] — z")).toBeNull();
  });

  it("a role reads its own lines and run's", () => {
    for (const owner of ["worker", "run", null] as const) expect(readsALine("worker", owner)).toBe(true);
    expect(readsALine("worker", "reviewer")).toBe(false);
    expect(readsALine("writer", "worker")).toBe(true);
    expect(readsALine("ui-reviewer", "reviewer")).toBe(true);
    expect(readsALine("ui-reviewer", "verifier")).toBe(false);
    for (const owner of A_LINE_OWNERS) expect(readsALine("judge", owner)).toBe(true);
    expect(readsALine("architect", "verifier")).toBe(true);
  });
});

describe("fenced code in a plan", () => {
  const fence = "```";
  it("a heading inside a fence does not end a task, a section or a milestone", () => {
    const d = parsePlanDoc(
      "p.md",
      `# P\n\n## M1 — one\n\n### Task 1: readme\nWrite it:\n${fence}md\n## Usage\n### Task 9: not a task\n${fence}\nTest: \`src/a.test.ts\` — "x"\n\n## M2 — two\n`,
    );
    expect(d.tasks.map((t) => t.id)).toEqual(["1"]);
    expect(d.tasks[0]?.test).toBe(true);
    const plan = `## M1 — one\n${fence}sh\n## setup\n~~~\n${fence}\nCheck: bun test\n## M2 — two\n`;
    expect(milestoneCheck(plan, "M1")).toBe("bun test");
    expect(milestoneSection(plan, "M1")).toContain("Check: bun test");
    expect(baselineItems(`# P\n${fence}\n## M1 — fake\n${fence}\nBaseline: a\n## M1 — one\n`, "M1")).toEqual([
      "a",
    ]);
  });
});
