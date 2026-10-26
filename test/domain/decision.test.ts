import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  aboveFloor,
  DecisionFileSchema,
  decisionState,
  difficultyQuestions,
  familyOf,
  levelsOf,
  levelTexts,
  parseReply,
  pickLevel,
} from "../../src/domain/decision.ts";
import { ROLES } from "../../src/domain/roles.ts";

const root = join(import.meta.dir, "..", "..");
const read = (...p: string[]): unknown => JSON.parse(readFileSync(join(root, ...p), "utf8"));
const file = () => DecisionFileSchema.parse(read("catalog", "decision.json"));
const rungsOf = (ls: { rungs: string[] }[]) => ls.map((l) => l.rungs);

describe("levels", () => {
  const cands = [
    { rung: "b", intelligence: 40 },
    { rung: "a", intelligence: 30 },
    { rung: "c", intelligence: 40 },
    { rung: "d", intelligence: 50 },
  ];

  it("levels group equal intelligence, weakest first", () => {
    const ls = levelsOf(cands);
    expect(rungsOf(ls)).toEqual([["a"], ["b", "c"], ["d"]]);
    expect(ls.map((l) => [l.level, l.intelligence])).toEqual([
      [0, 30],
      [1, 40],
      [2, 50],
    ]);
  });

  it("the floor keeps its level, strict drops it", () => {
    const ls = levelsOf(cands);
    expect(rungsOf(aboveFloor(ls, "c", false))).toEqual([["b", "c"], ["d"]]);
    const strict = aboveFloor(ls, "c", true);
    expect(rungsOf(strict)).toEqual([["d"]]);
    expect(strict[0]?.level).toBe(0);
    expect(aboveFloor(ls, "d", true)).toEqual([]);
    expect(rungsOf(aboveFloor(ls, null, true))).toEqual(rungsOf(ls));
  });
});

describe("a floor that is no candidate", () => {
  const ls = levelsOf([
    { rung: "a", intelligence: 30 },
    { rung: "b", intelligence: 40 },
    { rung: "d", intelligence: 50 },
  ]);
  it("is placed by its intelligence", () => {
    expect(rungsOf(aboveFloor(ls, "x", false, 40))).toEqual([["b"], ["d"]]);
    expect(rungsOf(aboveFloor(ls, "x", true, 40))).toEqual([["d"]]);
    expect(aboveFloor(ls, "x", true, 50)).toEqual([]);
  });
  it("with no known intelligence, strict allows nothing and a plain floor everything", () => {
    expect(aboveFloor(ls, "x", true)).toEqual([]);
    expect(rungsOf(aboveFloor(ls, "x", false))).toEqual(rungsOf(ls));
  });
});

describe("parseReply", () => {
  const qs = { difficulty: { type: "score" as const, instructions: "", criteria: ["a", "b", "c"] } };
  const body = (probabilities: Record<string, number>) => ({
    model: "m",
    answers: { difficulty: { type: "score", score: 1, probabilities, confidence: 0.9 } },
  });
  it("a score with no probability mass is no answer", () => {
    expect(parseReply(qs, body({ "0": 0, "1": 0 }))).toMatchObject({ ok: false });
    expect(parseReply(qs, body({}))).toMatchObject({ ok: false });
    expect(parseReply(qs, body({ "1": 0.9 }))).toMatchObject({ ok: true });
  });
});

describe("level texts", () => {
  const six = ["0", "1", "2", "3", "4", "5"];
  it("N level texts are evenly spaced over six", () => {
    expect(levelTexts(six, 5)).toEqual(["0", "1", "3", "4", "5"]);
    expect(levelTexts(six, 4)).toEqual(["0", "2", "3", "5"]);
    expect(levelTexts(six, 2)).toEqual(["0", "5"]);
    expect(levelTexts(six, 6)).toEqual(six);
    expect(levelTexts(six, 1)).toEqual([]);
  });

  it("the catalog holds six texts per family, each a 'does well' line", () => {
    const f = file();
    for (const fam of ["code", "review", "plan"] as const) {
      expect(f.sets.difficulty.levels[fam]).toHaveLength(6);
      for (const t of f.sets.difficulty.levels[fam])
        expect(t).toStartWith("A model at this level does well: ");
    }
    expect(familyOf("worker")).toBe("code");
    expect(familyOf("verifier")).toBe("review");
    expect(familyOf("judge")).toBe("plan");
    for (const r of ROLES) expect(["code", "review", "plan"]).toContain(familyOf(r));
  });

  it("the difficulty question has N criteria and the noul signals ride along", () => {
    const q = difficultyQuestions(file(), "worker", 5);
    const d = q.difficulty;
    expect(d?.type === "score" && d.criteria).toHaveLength(5);
    expect(Object.keys(q).sort()).toEqual(
      ["cross_boundary", "difficulty", "mechanical", "outside_repo", "shared_state", "unclear_cause"].sort(),
    );
    expect(difficultyQuestions(file(), "worker", 1)).toEqual({});
  });
});

describe("pickLevel", () => {
  const rule = { floor: ["shared_state"], cap: ["mechanical"], noulMin: 0.8 };

  it("a sure level wins, else the cumulative from the top", () => {
    const spread = { "3": 0.54, "4": 0.16, "2": 0.2, "1": 0.08, "0": 0.02 };
    expect(pickLevel(spread, 5, 0.8).level).toBe(2);
    expect(pickLevel({ "0": 0.66, "1": 0.2, "2": 0.1, "3": 0.03, "4": 0.01 }, 5, 0.8).level).toBe(0);
    expect(pickLevel({ "1": 0.85 }, 3, 0.8).level).toBe(1);
    expect(pickLevel({ "1": 0.1, "2": 0.7 }, 3, 0.8).level).toBe(1);
    expect(pickLevel({}, 3, 0.8).level).toBe(2);
    expect(pickLevel({ "0": 1 }, 1, 0.8).level).toBe(0);
  });

  it("a noul floors at new logic and caps at the example", () => {
    const low = { "0": 0.9, "1": 0.1 };
    const high = { "4": 0.9, "3": 0.1 };
    expect(pickLevel(low, 5, 0.8, { shared_state: 0.9 }, rule).level).toBe(2);
    expect(pickLevel(high, 5, 0.8, { mechanical: 0.9 }, rule).level).toBe(1);
    expect(pickLevel(low, 5, 0.8, { shared_state: 0.9, mechanical: 0.9 }, rule).level).toBe(2);
    expect(pickLevel(high, 5, 0.8, { shared_state: 0.9, mechanical: 0.9 }, rule).level).toBe(4);
    expect(pickLevel(low, 5, 0.8, { shared_state: 0.7 }, rule).level).toBe(0);
    expect(pickLevel(low, 2, 0.8, { shared_state: 0.9 }, rule).level).toBe(1);
  });

  it("the probe states pick as recorded", () => {
    const fx = read("test", "fixtures", "decision", "probe-states.json") as {
      min: number;
      rows: {
        name: string;
        probabilities: Record<string, number>;
        expected: number;
        state: { role: (typeof ROLES)[number]; rungs: unknown[] };
      }[];
    };
    expect(fx.rows).toHaveLength(4);
    for (const r of fx.rows) {
      expect(pickLevel(r.probabilities, 5, fx.min).level).toBe(r.expected);
      const d = difficultyQuestions(file(), r.state.role, r.state.rungs.length).difficulty;
      expect(d?.type === "score" && d.criteria).toHaveLength(5);
    }
  });
});

describe("decisionState", () => {
  it("the state keeps the whole brief, secrets scrubbed", () => {
    const key = `sk-ant-${"a1b2c3d4".repeat(5)}`;
    const brief = `${"line of brief text\n".repeat(8300)}token ${key}\n`;
    expect(brief.length).toBeGreaterThan(150_000);
    const s = decisionState({
      role: "worker",
      unit: "lane-a",
      round: 1,
      isFix: false,
      floorRung: null,
      rungs: [],
      previous: [],
      spentFraction: 0,
      slack: null,
      brief,
    });
    expect(s.brief).not.toContain("sk-ant-");
    expect(s.brief.length).toBeGreaterThan(brief.length - key.length);
  });
});
