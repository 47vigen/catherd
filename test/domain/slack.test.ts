import { describe, expect, it } from "bun:test";
import type { MilestonePlan } from "../../src/domain/run-events.ts";
import { laneSlack } from "../../src/domain/slack.ts";

const lane = (id: string, after: string[] = []) => ({
  id,
  role: "worker" as const,
  kind: null,
  after,
  owns: [],
});
const ms = (id: string, after: string[], lanes: ReturnType<typeof lane>[]): MilestonePlan => ({
  id,
  title: id,
  after,
  lanes,
});
const one = (id: string, after: string[] = []) => ms(id, after, [lane(`${id}.L1`)]);

describe("laneSlack", () => {
  it("a chain has no slack", () => {
    const s = laneSlack([one("M1"), one("M2", ["M1"]), one("M3", ["M2"])], new Set());
    expect([...s]).toEqual([
      ["M1.L1", 0],
      ["M2.L1", 0],
      ["M3.L1", 0],
    ]);
  });

  it("a short branch beside a long one has slack", () => {
    const s = laneSlack([one("M1"), one("M2", ["M1"]), one("M3", ["M2"]), one("M4", ["M1"])], new Set());
    expect(s.get("M4.L1")).toBe(2);
    expect(s.get("M1.L1")).toBe(0);
    expect(s.get("M2.L1")).toBe(0);
    expect(s.get("M3.L1")).toBe(0);
  });

  it("lanes inside a milestone", () => {
    const m = ms("M1", [], [lane("M1.L1"), lane("M1.L2", ["M1.L1"]), lane("M1.L3")]);
    const s = laneSlack([m], new Set());
    expect([s.get("M1.L1"), s.get("M1.L2"), s.get("M1.L3")]).toEqual([0, 0, 1]);
  });

  it("an After: on another milestone's lane waits for that milestone's gate", () => {
    const m2 = ms("M2", [], [lane("M2.L1", ["M1.L1"])]);
    const s = laneSlack([one("M1"), m2], new Set());
    expect([s.get("M1.L1"), s.get("M2.L1")]).toEqual([0, 0]);
  });

  it("a done milestone drops out", () => {
    const s = laneSlack(
      [one("M1"), one("M2", ["M1"]), one("M3", ["M2"]), one("M4", ["M1"])],
      new Set(["M1"]),
    );
    expect(s.has("M1.L1")).toBe(false);
    expect(s.get("M2.L1")).toBe(0);
    expect(s.get("M3.L1")).toBe(0);
    expect(s.get("M4.L1")).toBe(2);
  });

  it("a cycle or an unknown id", () => {
    expect(laneSlack([one("M1", ["M2"]), one("M2", ["M1"])], new Set()).size).toBe(0);
    const m = ms("M1", ["M9"], [lane("M1.L1", ["Z.L9"])]);
    expect(laneSlack([m], new Set()).get("M1.L1")).toBe(0);
  });

  it("a single lane has slack 0, and a lane outside the plan has no value", () => {
    const s = laneSlack([one("M1")], new Set());
    expect(s.get("M1.L1")).toBe(0);
    expect(s.has("M1.L2")).toBe(false);
  });
});
