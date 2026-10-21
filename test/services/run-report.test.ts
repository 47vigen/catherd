import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import type { Finding } from "../../src/domain/run-events.ts";
import { appendCheckRecord } from "../../src/services/milestone-check.ts";
import { gateLines, roundsLine, writeRunReport } from "../../src/services/run-report.ts";
import { endDispatch, type Log, makeLog, startDispatch, startedFields } from "../domain/run-fixtures.ts";
import { snapshotEnv } from "../helpers.ts";
import { freshRun } from "./helpers.ts";

afterEach(snapshotEnv());

const f = (label: Finding["label"], text: string): Finding => ({
  label,
  text,
  file: /(src\/\S+?):/.exec(text)?.[1] ?? null,
});

function reviewed(
  log: Log,
  findings: Finding[],
  o: { name?: string; replyStatus?: "complete" | "partial" } = {},
): void {
  const name = o.name ?? "reviewer-M1";
  const id = startDispatch(log, { name, role: "reviewer", unit: "M1", lane: null });
  endDispatch(log, id, { name, unit: "M1", findings, replyStatus: o.replyStatus ?? "complete" });
}

const commit = (log: Log, round: number): void => {
  log.add("commit.made", { milestone: "M1", round, commit: `c${round}` });
};

describe("the run report (plan 34)", () => {
  it("says how many review rounds a milestone took and which findings they fixed (plan 34)", () => {
    const log = makeLog();
    commit(log, 0);
    reviewed(log, [f("BUG", "BUG src/a.ts:3 — x — y"), f("NIT", "NIT n — z")]);
    commit(log, 1);
    reviewed(log, [f("BUG", "BUG src/c.ts:1 — still broken")]);
    commit(log, 2);
    reviewed(log, [f("BUG", "BUG src/c.ts:9 — still broken")]);
    expect(roundsLine(log.events, "M1")).toBe("Rounds: 3 review round(s) · fixed: BUG src/a.ts:3 — x — y");
  });

  it("counts a partial review and its second pass as one round", () => {
    const log = makeLog();
    commit(log, 0);
    reviewed(log, [], { replyStatus: "partial" });
    reviewed(log, [], { name: "reviewer-M1-2" });
    expect(roundsLine(log.events, "M1")).toBe("Rounds: 1 review round(s)");
  });

  it("carries the gate's exit, duration and secret scan, per command (plan 34)", () => {
    const { run } = freshRun();
    const at = "2026-10-21T10:00:00.000Z";
    const base = {
      run: run.id,
      milestone: "M1",
      command: "bun test",
      fails: [],
      log: "",
      at,
      durationMs: 41_400,
    };
    appendCheckRecord(run.meta.repo, {
      ...base,
      head: "0123456789abcdef0123456789abcdef01234567",
      exit: 0,
      secrets: "clean",
    });
    appendCheckRecord(run.meta.repo, { ...base, head: "f".repeat(40), exit: 1, baseline: true });
    expect(gateLines(run, "M1")).toEqual([
      "Gate: `bun test` exit 0 on 0123456789ab · 41 s · secret scan: clean",
    ]);
    expect(gateLines(run, "M2")).toEqual(["Gate: not recorded"]);
  });

  it("quotes every known issue word for word", () => {
    const { run } = freshRun();
    const log = makeLog();
    log.add("run.started", startedFields);
    const issues = ["**NIT** src/b.ts:4 — later — z", "BUG src/c.ts:9 — still broken | x"];
    log.add("milestone.landed", {
      milestone: "M1",
      commit: "a".repeat(40),
      knownIssues: issues,
      digestPath: "d.md",
    });
    const text = readFileSync(writeRunReport(run, log.state(), log.events), "utf8");
    for (const line of issues) expect(text).toContain(line);
    const section = text.slice(text.indexOf("## M1"), text.indexOf("## Known issues"));
    expect(section).toContain("Rounds:");
    expect(section).toContain("Gate:");
  });

  it("lists plan lint per milestone, and no section without any", () => {
    const { run } = freshRun();
    const lint = "M1.L2: After: M1.L1 shares no file with it: …";
    const log = makeLog();
    log.add("run.started", startedFields);
    log.add("preflight.done", { milestone: "M1", blocking: [], confirm: null, lint: ["old"] });
    log.add("preflight.done", { milestone: "M1", blocking: [], confirm: null, lint: [lint] });
    const text = readFileSync(writeRunReport(run, log.state(), log.events), "utf8");
    expect(text).toContain(`## Plan lint\n\n- M1: ${lint}\n`);
    expect(text).not.toContain("- M1: old");
    const bare = makeLog();
    bare.add("run.started", startedFields);
    expect(readFileSync(writeRunReport(run, bare.state(), bare.events), "utf8")).not.toContain(
      "## Plan lint",
    );
  });
});
