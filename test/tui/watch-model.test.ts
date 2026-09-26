import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  budgetTone,
  climbs,
  jevLine,
  readJev,
  liveLine,
  milestoneLine,
  plainBudgetBar,
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
    expect(
      jevLine({ call: "route", questionSet: "route@3f2a", used: "kind=repo_code", source: "lane" }, false),
    ).toBe("route route@3f2a → kind=repo_code · fell back to the lane's declaration");
  });

  it("reads a 1.0 jev.jsonl: skips the schema header and shows the call and question set", () => {
    const dir = mkdtempSync(join(tmpdir(), "catherd-jev-"));
    const row = {
      at: "2026-09-26T00:00:00.000Z",
      call: "route",
      lane: "worker-M1.L1",
      questionSet: "route@3f2a",
      key: "k",
      stateHash: "h",
      model: null,
      requestId: null,
      usage: null,
      latencyMs: null,
      attempts: 1,
      cached: false,
      answers: { kind: { type: "choice", choice: "repo_code", probabilities: {}, confidence: 0.9 } },
      derived: null,
      used: "kind=repo_code",
      source: "jev",
      why: "",
    };
    const old = { questions: ["finding"], used: "code", source: "default" };
    writeFileSync(
      join(dir, "jev.jsonl"),
      `${[{ schema: 1, kind: "jev" }, row, { ...row, answers: null, source: "default" }, old]
        .map((r) => JSON.stringify(r))
        .join("\n")}\n`,
    );
    const lines = readJev(dir).map((e) => jevLine(e, false));
    expect(lines).toEqual([
      "route route@3f2a · kind → kind=repo_code",
      "route route@3f2a → kind=repo_code · fell back to the profile default",
      "finding → code · fell back to the profile default",
    ]);
  });

  it("draws a 10-cell ASCII bar with the rounded percent beside it", () => {
    expect(plainBudgetBar(0.52)).toBe("[#####-----] 52%");
    expect(plainBudgetBar(0)).toBe("[----------] 0%");
    expect(plainBudgetBar(1)).toBe("[##########] 100%");
    expect(plainBudgetBar(1.4)).toBe("[##########] 100%");
  });

  it("turns the bar's tone from the gradient to a warning at 80%, then an error at 100%", () => {
    expect(budgetTone(0)).toBe("gradient");
    expect(budgetTone(0.79)).toBe("gradient");
    expect(budgetTone(0.8)).toBe("warning");
    expect(budgetTone(0.99)).toBe("warning");
    expect(budgetTone(1)).toBe("error");
    expect(budgetTone(1.5)).toBe("error");
  });
});
