import { describe, expect, it } from "bun:test";
import {
  LEARN_MIN_LANES,
  type LaneRecord,
  learnedStart,
  type OutcomeStat,
  summarize,
} from "../../src/domain/track-record.ts";

const SOL = "codex:gpt-6.1-sol#high";
const LUNA = "codex:gpt-6-luna#high";

const lane = (o: Partial<LaneRecord> = {}): LaneRecord => ({
  rung: SOL,
  kind: "repo_code",
  difficulty: "build",
  chore: false,
  landed: true,
  firstPass: true,
  rounds: 1,
  findings: 0,
  ...o,
});

const stat = (o: Partial<OutcomeStat> & Pick<OutcomeStat, "rung" | "lanes">): OutcomeStat => ({
  model: o.rung.slice(0, o.rung.indexOf("#")),
  effort: o.rung.slice(o.rung.indexOf("#") + 1),
  kind: "repo_code",
  difficulty: "build",
  chore: false,
  landed: o.lanes,
  firstPass: 0,
  rounds: o.lanes,
  findings: 0,
  ...o,
});

describe("summarize", () => {
  it("groups by rung, kind, difficulty and chore", () => {
    const stats = summarize([
      lane({ rounds: 2, firstPass: false, findings: 1 }),
      lane({ rounds: 1, findings: 2 }),
      lane({ rung: LUNA, landed: false, firstPass: false, rounds: 3 }),
    ]);
    expect(stats).toEqual([
      stat({ rung: LUNA, lanes: 1, landed: 0, firstPass: 0, rounds: 3 }),
      stat({ rung: SOL, lanes: 2, landed: 2, firstPass: 1, rounds: 3, findings: 3 }),
    ]);
    // the model and the effort are apart
    expect(stats[1]).toMatchObject({ model: "codex:gpt-6.1-sol", effort: "high" });
  });

  it("keeps chore lanes apart from the same rung's others", () => {
    expect(summarize([lane(), lane({ chore: true })]).map((s) => [s.chore, s.lanes])).toEqual([
      [false, 1],
      [true, 1],
    ]);
  });
});

describe("learnedStart", () => {
  it("prefers a cheaper rung with an equal record", () => {
    const stats = [
      stat({ rung: SOL, lanes: 6, firstPass: 3, rounds: 11 }),
      stat({ rung: LUNA, lanes: 5, firstPass: 3, rounds: 8 }),
    ];
    const r = learnedStart(stats, [LUNA, SOL], "build", SOL);
    expect(r?.rung).toBe(LUNA);
    expect(r?.why).toContain(LUNA);
    expect(r?.why).toContain(SOL);
  });

  it("adds the kinds of one difficulty up", () => {
    const stats = [
      stat({ rung: SOL, lanes: 6, firstPass: 3, rounds: 11 }),
      stat({ rung: LUNA, lanes: 3, firstPass: 2, rounds: 4 }),
      stat({ rung: LUNA, kind: "ui", lanes: 2, firstPass: 1, rounds: 3 }),
    ];
    expect(learnedStart(stats, [LUNA], "build", SOL)?.rung).toBe(LUNA);
    expect(learnedStart(stats, [LUNA], "logic", SOL)).toBeNull();
  });

  it("learns nothing from too few lanes, a worse record or chore lanes", () => {
    const start = stat({ rung: SOL, lanes: 6, firstPass: 3, rounds: 11 });
    expect(LEARN_MIN_LANES).toBe(5);
    // 4 lanes
    expect(
      learnedStart([start, stat({ rung: LUNA, lanes: 4, firstPass: 4, rounds: 4 })], [LUNA], "build", SOL),
    ).toBeNull();
    // a lower first-pass rate
    expect(
      learnedStart([start, stat({ rung: LUNA, lanes: 5, firstPass: 2, rounds: 5 })], [LUNA], "build", SOL),
    ).toBeNull();
    // more rounds per lane
    expect(
      learnedStart([start, stat({ rung: LUNA, lanes: 5, firstPass: 3, rounds: 10 })], [LUNA], "build", SOL),
    ).toBeNull();
    // chore lanes only
    expect(
      learnedStart(
        [start, stat({ rung: LUNA, lanes: 5, firstPass: 5, rounds: 5, chore: true })],
        [LUNA],
        "build",
        SOL,
      ),
    ).toBeNull();
    // the start itself has too few
    expect(
      learnedStart(
        [
          stat({ rung: SOL, lanes: 4, firstPass: 4, rounds: 4 }),
          stat({ rung: LUNA, lanes: 9, firstPass: 9, rounds: 9 }),
        ],
        [LUNA],
        "build",
        SOL,
      ),
    ).toBeNull();
  });
});
