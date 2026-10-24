import { describe, expect, it } from "bun:test";
import {
  approvalQuestion,
  baselineItems,
  CHECK_COVERED,
  changedDecisions,
  coverageProblems,
  decisionLines,
  depthProblems,
  isAccept,
  isApproval,
  milestoneCheck,
  milestoneSection,
  parsePlanDoc,
  planInputNames,
  reapprovalQuestion,
  resolveTask,
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

describe("resolveTask and coverageProblems", () => {
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

  it("names a lane with no Tasks: line, an unresolved ref and a task with neither a signature nor a test", () => {
    expect(
      coverageProblems(docs, [
        { id: "M1.L1", tasks: [] },
        { id: "M1.L2", tasks: ["3", "b.md#3"] },
        { id: "M1.L3", tasks: ["b.md#4"] },
      ]),
    ).toEqual([
      { lane: "M1.L1", note: "lanes/M1.L1.md has no Tasks: line: name the plan tasks it implements" },
      { lane: "M1.L2", note: "lanes/M1.L2.md: Tasks: 3 — task 3 is in a.md and b.md: write a.md#3" },
      {
        lane: "",
        note: "b.md Task 4 has neither a signature nor a test: add its signatures (a code block or an Interfaces: line) or a Test: line",
      },
    ]);
  });

  it("refuses a task number one file holds twice, naming the file and the number", () => {
    const twice = [
      parsePlanDoc("p.md", "## Task 13 — a\nTest: a.test.ts\n\n### Task 13: b\nTest: b.test.ts\n"),
    ];
    const note = "p.md holds Task 13 twice: renumber one of them";
    expect(resolveTask(twice, "13")).toBe(note);
    expect(resolveTask(twice, "p.md#13")).toBe(note);
    expect(coverageProblems(twice, [{ id: "M1.L1", tasks: ["13"] }])).toEqual([
      { lane: "M1.L1", note: `lanes/M1.L1.md: Tasks: 13 — ${note}` },
    ]);
  });

  it("checks signature-or-test only on the tasks the lanes name", () => {
    const d = [parsePlanDoc("p.md", "### Task 1: a\nTest: a.test.ts\n\n### Task 2: publish\nprose only\n")];
    expect(coverageProblems(d, [{ id: "M1.L1", tasks: ["1"] }])).toEqual([]);
    expect(coverageProblems(d, [{ id: "M1.L1", tasks: ["1", "2"] }])).toEqual([
      {
        lane: "",
        note: "p.md Task 2 has neither a signature nor a test: add its signatures (a code block or an Interfaces: line) or a Test: line",
      },
    ]);
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

  it("asks a written plan for the three sections, a test per task and a rejected alternative per decision", () => {
    expect(depthProblems(parsePlanDoc("plan.md", FULL))).toEqual([]);
    expect(depthProblems(parsePlanDoc("plan.md", "# P\n"))).toEqual([
      'plan.md has no "## What already exists" section',
      'plan.md has no "## Contracts" section',
      'plan.md has no "## Decisions" section',
      'plan.md has no "### Task <n>:" heading',
    ]);
    const bad = FULL.replace("Test: `test/a.test.ts` — asserts a", "just do it")
      .replace(" — rejected: an array — slower", " — because")
      .replace("`src/a.ts` — `a(): void` — the thing", "nothing");
    expect(depthProblems(parsePlanDoc("plan.md", bad))).toEqual([
      "plan.md Task 1 has no test: add a Test: line naming its test file and case",
      "plan.md D1 names no rejected alternative: write D1 — <choice> — rejected: <alternative> — <why>",
      "plan.md's What already exists lists no path",
    ]);
  });
});

describe("approval", () => {
  it("reads a decision's wrapped lines and a numbered marker", () => {
    const a = "## Decisions\n1. D1 — x — rejected: y\n   because z\n\nD2 — p\n";
    expect(decisionLines(a).get("D1")).toBe("1. D1 — x — rejected: y because z");
    expect(changedDecisions(a, a.replace("because z", "because w"))).toEqual(["D1"]);
    expect(changedDecisions(a, a.replace("D2 — p", "D2 — p\n\nprose after a blank line"))).toEqual([]);
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
    expect(reapprovalQuestion("r1", ["D1", "D2"])).toBe(
      "The architect changed approved decisions D1, D2 of plan.md: catherd run-file read r1 plan.md. Answer approve, or say what to change.",
    );
  });

  it("names the decisions a revised plan added, removed or edited, and none for other edits", () => {
    const a =
      "## Decisions\nD1 — x — rejected: y — z\nD2 — p — rejected: q — r\n\n### Task 1: t\nTest: a.test.ts\n";
    expect(changedDecisions(a, a.replace("### Task 1: t", "### Task 1: renamed"))).toEqual([]);
    expect(changedDecisions(a, a.replace("D2 — p", "D2 — p2"))).toEqual(["D2"]);
    expect(changedDecisions(a, a.replace("D1 — x — rejected: y — z\n", ""))).toEqual(["D1"]);
    expect([...decisionLines("## Decisions\n- **D10** — a   b\n")]).toEqual([["D10", "- **D10** — a b"]]);
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

it("milestoneSection stops at the next ## heading", () => {
  const plan = "## M1 — one\nCheck: a && b\n### Task 1: x\nprose\n## M2 — two\nCheck: c && d\n";
  expect(milestoneSection(plan, "M1")).toBe("## M1 — one\nCheck: a && b\n### Task 1: x\nprose");
  expect(milestoneSection(plan, "M3")).toBeNull();
});
