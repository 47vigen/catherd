import { describe, expect, it } from "bun:test";
import { lintLanes, lintPlan } from "../../src/domain/plan-lint.ts";

const lane = (id: string, owns: string[], after: string[] = [], kind = "repo_code") => ({
  id,
  text: [
    `# ${id} — t`,
    `Owns: ${owns.join(", ")}`,
    "Fast check: true",
    `Kind: ${kind}`,
    "Difficulty: build",
    ...(after.length ? [`After: ${after.join(", ")}`] : []),
    "",
    "x".repeat(250),
  ].join("\n"),
});

describe("lintLanes (plan 34)", () => {
  it("names lanes chained without a shared file and whole folders, with the critical path", () => {
    const lanes = [lane("M1.L1", ["a.ts"]), lane("M1.L2", ["b.ts"], ["M1.L1"]), lane("M1.L3", ["src/"])];
    expect(
      lintLanes(
        lanes,
        lanes.map((l) => l.id),
      ),
    ).toEqual({
      warnings: [
        "M1.L2: After: M1.L1 shares no file with it: drop it unless M1.L2 needs M1.L1's output",
        "M1.L3: Owns names whole folders (src/): name the files, unless the lane creates the folder",
        "info: M1 critical path 2 of 3 lanes",
      ],
      stuck: [],
    });
  });

  it("names an After: that can never finish as stuck", () => {
    const lanes = [
      lane("M1.L3", ["c.ts"], ["M1.L3", "M1.L9"]),
      lane("M1.L4", ["d.ts"], ["M1.L5"]),
      lane("M1.L5", ["e.ts"], ["M1.L4"]),
    ];
    expect(
      lintLanes(
        lanes,
        lanes.map((l) => l.id),
      ).stuck,
    ).toEqual([
      { lane: "M1.L3", note: "M1.L3: After: names the lane itself" },
      { lane: "M1.L3", note: "M1.L3: After: M1.L9 has no lane file" },
      { lane: "M1.L4", note: "After: cycle M1.L4 → M1.L5 → M1.L4: these lanes never start" },
    ]);
  });

  it("leaves research lanes out of the file checks", () => {
    const lanes = [lane("M1.R1", [], [], "research"), lane("M1.L1", ["a.ts"], ["M1.R1"])];
    expect(lintLanes(lanes, ["M1.R1", "M1.L1"])).toEqual({
      warnings: ["info: M1 critical path 2 of 2 lanes: fully serial"],
      stuck: [],
    });
  });

  it("says nothing for lanes with no After: and named files, and never throws on a file with no header", () => {
    const lanes = [lane("M1.L1", ["a.ts"]), lane("M1.L2", ["b.ts"])];
    expect(lintLanes(lanes, ["M1.L1", "M1.L2"])).toEqual({ warnings: [], stuck: [] });
    expect(lintLanes([{ id: "M1.L1", text: "no header here" }], ["M1.L1"])).toEqual({
      warnings: [],
      stuck: [],
    });
  });

  it("stops an After: on a lane of a milestone that is not finished, allows one on a finished milestone", () => {
    const lanes = [lane("M1.L1", ["a.ts"], ["M2.L1"]), lane("M2.L1", ["b.ts"], ["M1.L1"])];
    const known = ["M1.L1", "M2.L1", "M0.L1"];
    expect(lintLanes(lanes, known, []).stuck).toEqual([
      {
        lane: "M1.L1",
        note: "M1.L1: After: M2.L1 is in milestone M2, which has not finished: this lane never starts",
      },
      {
        lane: "M2.L1",
        note: "M2.L1: After: M1.L1 is in milestone M1, which has not finished: this lane never starts",
      },
      { lane: "M1.L1", note: "After: cycle M1.L1 → M2.L1 → M1.L1: these lanes never start" },
    ]);
    const landed = [lane("M1.L1", ["a.ts"], ["M0.L1"])];
    expect(lintLanes(landed, known, ["M0"]).stuck).toEqual([]);
    expect(lintLanes(landed, known, []).stuck).toHaveLength(1);
  });

  it("reads a bare milestone After: (plan 35): fine when finished, a stop when not, unknown is no lane", () => {
    const known = ["M1.L1", "M2.L1"];
    const dependent = [lane("M2.L1", ["b.ts"], ["M1"])];
    expect(lintLanes(dependent, known, ["M1"]).stuck).toEqual([]);
    expect(lintLanes(dependent, known, []).stuck).toEqual([
      {
        lane: "M2.L1",
        note: "M2.L1: After: M1 is in milestone M1, which has not finished: this lane never starts",
      },
    ]);
    expect(lintLanes([lane("M2.L1", ["b.ts"], ["M9"])], known, ["M1"]).stuck).toEqual([
      { lane: "M2.L1", note: "M2.L1: After: M9 has no lane file" },
    ]);
    expect(lintLanes([lane("M2.L1", ["b.ts"], ["M2"])], known, ["M1"]).stuck).toEqual([
      { lane: "M2.L1", note: "M2.L1: After: M2 is its own milestone: this lane never starts" },
    ]);
  });
});

describe("lintPlan (plan 40, D11)", () => {
  const plan = (check: string | null, lines: string[] = []) =>
    ["## M1 — one", ...(check === null ? [] : [`Check: ${check}`]), ...lines].join("\n");

  it("a loop item and a history A-line are warned", () => {
    expect(
      lintPlan(plan("for p in a b; do x; done && y", ["A8 — tests failed before the code"]), "M1", []),
    ).toEqual([
      "M1: Check item `for p in a b; do x; done` is a shell loop: one 30-minute budget for every package; write one item per package",
      "M1: A8 asks for commit history (failed before): catherd commits tests and code together; it is judged from the tree",
    ]);
  });

  it("a milestone without Check: is warned", () => {
    expect(lintPlan(plan(null, ["A1 — it works"]), "M1", [])).toEqual([
      "M1: no Check: line: the verifier must run the whole gate by hand",
    ]);
  });

  it("reads the run's own A-lines beside the milestone's", () => {
    expect(lintPlan(plan("true"), "M1", ["A2 — TDD all the way"])).toEqual([
      "M1: A2 asks for commit history (TDD): catherd commits tests and code together; it is judged from the tree",
    ]);
  });
});
