import { describe, expect, it } from "bun:test";
import { lintLanes } from "../../src/domain/plan-lint.ts";

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
});
