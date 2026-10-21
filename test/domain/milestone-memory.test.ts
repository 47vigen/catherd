import { describe, expect, it } from "bun:test";
import {
  MEMORY_LIMITS,
  type MemoryLimits,
  memoryLimitsOf,
  memoryLoad,
  mayStartMilestone,
  neededMb,
} from "../../src/domain/milestone-memory.ts";

const ms = (id: string, status: string, treeAt: string | null) => ({
  id,
  status,
  treeAt,
  tree: treeAt === null ? null : `/t/${id}`,
});

describe("the milestone memory rule", () => {
  it("always lets a milestone start when none is working", () =>
    expect(mayStartMilestone({ availableMb: 0, working: 0, ramping: 0 })).toBe(true));

  it("starts another milestone only with its estimate above the floor, counting ramping ones at theirs", () => {
    expect(mayStartMilestone({ availableMb: 5120, working: 1, ramping: 0 })).toBe(true); // 5120 − 2048 ≥ 3072
    expect(mayStartMilestone({ availableMb: 5119, working: 1, ramping: 0 })).toBe(false);
    expect(mayStartMilestone({ availableMb: 8191, working: 2, ramping: 1 })).toBe(false); // 8192 needed
    expect(neededMb(1)).toBe(8192);
  });

  it("admits on the profile's own memory limits", () => {
    const l = memoryLimitsOf({ limits: { memory: { reserveMb: 4096 } } });
    expect(l).toMatchObject({ reserveMb: 4096, perMilestoneMb: 3072, floorMb: 3072 });
    expect(l.rampMs).toBe(MEMORY_LIMITS.rampMs);
    expect(mayStartMilestone({ availableMb: 5120, working: 1, ramping: 0 }, l)).toBe(false); // admitted on the defaults
    const small: MemoryLimits = memoryLimitsOf({
      limits: { memory: { perMilestoneMb: 1024, floorMb: 1024 } },
    });
    expect(mayStartMilestone({ availableMb: 9000, working: 2, ramping: 1 }, small)).toBe(true);
    expect(neededMb(1, l)).toBe(10240);
    expect(memoryLimitsOf({})).toEqual(MEMORY_LIMITS);
  });

  it("counts working milestones, and ramping ones by their tree's age", () => {
    const now = Date.parse("2026-10-21T10:10:00.000Z");
    expect(
      memoryLoad(
        [
          ms("M1", "lanes", "2026-10-21T10:00:00.000Z"),
          ms("M2", "review", "2026-10-21T10:08:00.000Z"),
          ms("M3", "parked", "2026-10-21T10:09:00.000Z"),
          ms("M4", "waiting", null),
          ms("M5", "landed", "2026-10-21T10:09:00.000Z"),
        ],
        now,
      ),
    ).toEqual({ working: 2, ramping: 1 });
  });
});
