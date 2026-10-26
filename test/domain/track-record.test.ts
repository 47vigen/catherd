import { describe, expect, it } from "bun:test";
import { type LaneRecord, type OutcomeStat, summarize } from "../../src/domain/track-record.ts";

const SOL = "codex:gpt-6.1-sol#high";
const LUNA = "codex:gpt-6-luna#high";

const lane = (o: Partial<LaneRecord> = {}): LaneRecord => ({
  rung: SOL,
  kind: "repo_code",
  difficulty: "build",
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
  landed: o.lanes,
  firstPass: 0,
  rounds: o.lanes,
  findings: 0,
  ...o,
});

describe("summarize", () => {
  it("groups by rung, kind and difficulty", () => {
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
});
