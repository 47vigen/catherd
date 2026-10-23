import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "../../src/domain/run-events.ts";
import { appendCheckRecord } from "../../src/services/milestone-check.ts";
import { gateLines, REPORT_LIST_CAP, roundsLine, writeRunReport } from "../../src/services/run-report.ts";
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

  it("shows at most REPORT_LIST_CAP known issues, then how many more and where", () => {
    const { run } = freshRun();
    const log = makeLog();
    log.add("run.started", startedFields);
    log.add("milestone.landed", {
      milestone: "M1",
      commit: "a".repeat(40),
      knownIssues: Array.from({ length: REPORT_LIST_CAP + 3 }, (_, i) => `issue ${i + 1}`),
      digestPath: "d.md",
    });
    const text = readFileSync(writeRunReport(run, log.state(), log.events), "utf8");
    expect(text).toContain("- M1: issue 40\n");
    expect(text).not.toContain("- M1: issue 41\n");
    expect(text).toContain("- +3 more in events.jsonl (milestone.landed) and digests/");
  });

  it.each([40, 41])("caps plan lint and audit lists at the boundary of %i lines", (count) => {
    const { run } = freshRun();
    const log = makeLog();
    log.add("run.started", startedFields);
    const items = Array.from({ length: count }, (_, i) => `item ${i + 1}`);
    log.add("preflight.done", { milestone: "M1", blocking: [], confirm: null, lint: items });
    const text = readFileSync(writeRunReport(run, log.state(), log.events, { M1: items }), "utf8");
    expect(text).toContain("- M1: item 40\n");
    expect(text).toContain("- M1 (check): item 40\n");
    expect(text).not.toContain("item 41\n");
    if (count === 40) expect(text).not.toContain("more in");
    else {
      expect(text).toContain("- +1 more in events.jsonl (preflight.done)");
      expect(text).toContain("- +1 more in events.jsonl and runs.jsonl");
    }
  });

  it("lists the worktrees still on disk, and no section without any", () => {
    const { run } = freshRun();
    const log = makeLog();
    log.add("run.started", startedFields);
    const report = () => readFileSync(writeRunReport(run, log.state(), log.events), "utf8");
    expect(report()).not.toContain("## Kept worktrees");
    mkdirSync(join(run.dir, "trees"));
    writeFileSync(join(run.dir, "trees", "M1.ready"), "");
    expect(report()).not.toContain("## Kept worktrees");
    for (const m of ["M10", "M2", "M1"]) mkdirSync(join(run.dir, "trees", m));
    const text = report();
    expect(text).toContain(
      `## Kept worktrees\n\nThese milestone worktrees are still on disk (uncommitted or untracked files, or a milestone not merged); remove each with \`git worktree remove <path>\` once its files are settled.\n- M1: ${join(run.dir, "trees", "M1")}\n- M2: ${join(run.dir, "trees", "M2")}\n- M10: ${join(run.dir, "trees", "M10")}\n\n## Audit`,
    );
    expect(text).not.toContain("M1.ready");
  });

  it("embeds a milestone digest without repeating its own H1 under the milestone heading", () => {
    const { run } = freshRun();
    writeFileSync(join(run.dir, "d.md"), "# M1 — truncate\n\nCommit abc · 4 min\nA-lines: none\n");
    const log = makeLog();
    log.add("run.started", startedFields);
    log.add("milestone.landed", {
      milestone: "M1",
      commit: "a".repeat(40),
      knownIssues: [],
      digestPath: "d.md",
    });
    const text = readFileSync(writeRunReport(run, log.state(), log.events), "utf8");
    expect(text).not.toContain("# M1 — truncate");
    expect(text).toContain("Commit abc · 4 min\nA-lines: none");
    expect(text.match(/^# /gm)).toHaveLength(1);
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

  it("lists each proposal with its command, quoting the text (plan 34)", () => {
    const { run } = freshRun();
    const log = makeLog();
    log.add("run.started", startedFields);
    const text = readFileSync(
      writeRunReport(run, log.state(), log.events, {}, [
        { op: "add", text: "[worker] run bun test <file>", why: "M1 round 2" },
        { op: "remove", text: "don't use the v1 client", why: "stale" },
      ]),
      "utf8",
    );
    expect(text).toContain("## Rules review");
    expect(text).toContain("1. ADD [worker] run bun test <file> — M1 round 2");
    expect(text).toContain("`catherd knowledge add '[worker] run bun test <file>'`");
    expect(text).toContain("2. REMOVE don't use the v1 client — stale");
    expect(text).toContain("`catherd knowledge rm 'don'\\''t use the v1 client'`");
  });

  it("says when the judge proposed nothing or gave no answer, and has no section for a cancelled run (plan 34)", () => {
    const { run } = freshRun();
    const log = makeLog();
    log.add("run.started", startedFields);
    const report = (proposals?: Parameters<typeof writeRunReport>[4]) =>
      readFileSync(writeRunReport(run, log.state(), log.events, {}, proposals), "utf8");
    expect(report([])).toContain("The judge proposed no change to the standing rules.");
    expect(report()).not.toContain("## Rules review");
    for (let i = 0; i < 2; i++) {
      startDispatch(log, { name: "judge-rules", role: "judge", unit: "run", lane: null, judgeKind: "rules" });
      log.add("judge.failed", { id: "rules", unit: "run", why: "unreadable" });
    }
    expect(report()).toContain("No rules review: the judge gave no readable answer.");
  });
});
