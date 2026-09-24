import { describe, expect, it } from "bun:test";
import {
  climbs,
  jevLine,
  liveLine,
  milestoneLine,
  recordLine,
  runLine,
  runMood,
} from "../../src/tui/watch-model.ts";
import type { RungId } from "../../src/types.ts";
import { fakeRecord } from "../records.ts";
import { fakeSummary } from "./helpers.ts";

const live = { name: "worker-M1.L2", rung: "gpt-6-sol#medium", secs: 252, pid: 1 };

describe("watch model", () => {
  it("gives a run the face of its state", () => {
    expect(runMood(fakeSummary({ live: [live] }))).toBe("working");
    expect(
      runMood(fakeSummary({ totals: { ...fakeSummary().totals, notOk: ["worker-M1.L1 (failed)"] } })),
    ).toBe("failed");
    expect(runMood(fakeSummary())).toBe("good");
    expect(runMood(fakeSummary({ totals: { ...fakeSummary().totals, runs: 0 } }))).toBe("waiting");
  });

  it("writes one line per live role: cat, name, rung, clock, face", () => {
    expect(liveLine(live, false)).toBe("🐈 worker-M1.L2  sol#medium  04:12  =o.o=");
    expect(liveLine(live, true)).toBe("* worker-M1.L2  sol#medium  04:12  =o.o=");
  });

  it("writes one line per run with its facts", () => {
    expect(runLine(fakeSummary({ live: [live], milestones: ["M1 | a | abc1234 | ok"] }), false)).toBe(
      "=o.o= Jobs screen · 1 live · 3 runs · 1 landed",
    );
  });

  it("tells a landed milestone from a ledger row, with the duration when the row has one", () => {
    expect(milestoneLine("M1 | jobs list | a1b2c3d4e5 | vitest 12/12", false)).toBe(
      "=^ω^= M1 landed · a1b2c3d",
    );
    expect(milestoneLine("M1 · 38m · a1b2c3d", false)).toBe("=^ω^= M1 landed · 38m · a1b2c3d");
    expect(milestoneLine("M2 | filters | def5678 | ok", true)).toBe("=^w^= M2 landed - def5678");
    expect(milestoneLine("something else", false)).toBe("=^ω^= something else");
  });

  it("sees a climb when a role comes back on another rung, once", () => {
    const seen = new Map<string, RungId>();
    const on = (rung: string) => fakeSummary({ live: [{ ...live, rung }] });
    expect(climbs(seen, on("gpt-6-luna#high"), false)).toEqual([]);
    expect(climbs(seen, on("gpt-6-luna#high"), false)).toEqual([]);
    expect(climbs(seen, on("gpt-6-sol#medium"), false)).toEqual([
      "Luna gave up, Sol takes over · worker-M1.L2 luna#high → sol#medium",
    ]);
    expect(climbs(seen, on("gpt-6-sol#medium"), false)).toEqual([]);
  });

  it("writes a record and a Jev decision as one line each", () => {
    expect(recordLine(fakeRecord("worker-M1.L1", { secs: 60 }), false)).toBe(
      "worker-M1.L1  sol#medium  ok  01:00 · complete",
    );
    expect(
      jevLine(
        { questions: ["kind", "difficulty"], used: "kind=repo_code difficulty=logic", source: "jev" },
        false,
      ),
    ).toBe("kind, difficulty → kind=repo_code difficulty=logic");
    expect(jevLine({ questions: ["finding"], used: "code", source: "default" }, true)).toBe(
      "finding -> code - fell back to the profile default",
    );
  });
});
