import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Action } from "../../src/domain/run-machine.ts";
import { VERSION } from "../../src/infra/version.ts";
import { briefFor, judgeBrief } from "../../src/services/run-briefs.ts";
import { scratchDir } from "../../src/services/dispatches.ts";
import { snapshotEnv } from "../helpers.ts";
import { endDispatch, runningLog, startDispatch } from "../domain/run-fixtures.ts";
import { briefFor as withLane, freshRun, writeLane } from "./helpers.ts";

afterEach(snapshotEnv());

type Dispatch = Extract<Action, { type: "dispatch" }>;
const act = (over: Partial<Dispatch>): Dispatch => ({
  type: "dispatch",
  unit: "M1.L1",
  name: "worker-M1.L1",
  role: "worker",
  lane: "M1.L1",
  rung: null,
  thread: null,
  failoverFrom: null,
  brief: "lane",
  notes: [],
  ...over,
});

describe("briefs", () => {
  it("gives a lane its file, fast check, lock wrapper, A-lines and notes", () => {
    const { run } = freshRun();
    writeLane(run, "M1.L1", ["src/a/"], "bun test src/a");
    const s = runningLog().state();
    const text = briefFor(run, s, act({ brief: "fix", notes: ["BUG src/a/x.ts:3 — wrong — fix it"] }));
    expect(text).toContain("A1 it works");
    expect(text).toContain("BUG src/a/x.ts:3 — wrong — fix it");
    expect(text).toContain(`catherd-cli@${VERSION} lock --`);
    // admission adds the lane file (and with it the fast check) around this text
    mkdirSync(scratchDir(run, "worker-M1.L1"), { recursive: true });
    const whole = withLane(run, text);
    expect(whole).toContain("Fast check: bun test src/a");
    expect(whole).toContain("Owns: src/a/");
  });

  it("asks a researcher for the dossier's eight parts", () => {
    const { run } = freshRun();
    const text = briefFor(
      run,
      runningLog().state(),
      act({ brief: "dossier", role: "researcher", lane: null, unit: "run" }),
    );
    for (const part of ["read_knowledge", "build, test and run commands", "risks:"])
      expect(text).toContain(part);
  });

  it("tells an architect with a plan to translate it, and a called-back one the findings", () => {
    const { run } = freshRun();
    const log = runningLog();
    const base = act({ brief: "architect", role: "architect", lane: null, unit: "run", name: "architect" });
    expect(briefFor(run, log.state(), base)).toContain("Owns: <repo-relative paths");
    const delta = briefFor(run, log.state(), {
      ...base,
      unit: "M1",
      notes: ["BUG the lanes miss the migration"],
    });
    expect(delta).toContain("called back on M1");
    expect(delta).toContain("BUG the lanes miss the migration");
  });

  it("gives a reviewer the milestone's range and the finding format, and a UI reviewer the screens", () => {
    const { run } = freshRun();
    const s = runningLog().state();
    const review = briefFor(
      run,
      s,
      act({ brief: "review", role: "reviewer", name: "reviewer-M1", unit: "M1", lane: null }),
    );
    expect(review).toContain("BLOCKER|BUG|NIT file:line — problem — fix");
    expect(review).toContain("CLEAN");
    expect(review).toMatch(/git diff \S+\.\.HEAD/);
    const ui = briefFor(
      run,
      s,
      act({ brief: "review", role: "ui-reviewer", name: "ui-reviewer-M1", unit: "M1", lane: null }),
    );
    expect(ui).toContain("agent-browser screenshot");
  });

  it("re-checks only the open BLOCKER and BUG lines of the last review", () => {
    const { run } = freshRun();
    const log = runningLog();
    const id = startDispatch(log, { name: "reviewer-M1", role: "reviewer", unit: "M1", lane: null });
    endDispatch(log, id, { name: "reviewer-M1", unit: "M1" });
    mkdirSync(join(run.dir, "roles", "reviewer-M1", id), { recursive: true });
    writeFileSync(
      join(run.dir, "roles", "reviewer-M1", id, "reply.md"),
      "BLOCKER src/a/x.ts:3 — wrong — fix\nNIT src/a/y.ts — style\nSTATUS: complete — done\n",
    );
    const text = briefFor(
      run,
      log.state(),
      act({ brief: "recheck", role: "reviewer", name: "reviewer-M1", unit: "M1", lane: null }),
    );
    expect(text).toContain("- BLOCKER src/a/x.ts:3 — wrong — fix");
    expect(text).not.toContain("style");
  });

  it("gives a verifier the verdict contract and what the last one said failed", () => {
    const { run } = freshRun();
    const log = runningLog();
    const id = startDispatch(log, { name: "verifier-M1", role: "verifier", unit: "M1", lane: null });
    endDispatch(log, id, { name: "verifier-M1", unit: "M1", verdict: "fail" });
    mkdirSync(join(run.dir, "roles", "verifier-M1", id), { recursive: true });
    writeFileSync(
      join(run.dir, "roles", "verifier-M1", id, "reply.md"),
      "VERDICT: FAIL\n- bun test src/a fails: 2 red\nSTATUS: complete — failed\n",
    );
    const text = briefFor(
      run,
      log.state(),
      act({ brief: "verify", role: "verifier", name: "verifier-M1", unit: "M1", lane: null }),
    );
    expect(text).toContain("VERDICT: PASS");
    expect(text).toContain(join(run.dir, "plan.md"));
    expect(text).toContain("- bun test src/a fails: 2 red");
  });

  it("gives a judge only its kind, unit, context, numbered findings and the lanes' Owns", () => {
    const { run } = freshRun();
    mkdirSync(join(run.dir, "roles", "worker-M1.L1", "D1"), { recursive: true });
    writeFileSync(
      join(run.dir, "roles", "worker-M1.L1", "D1", "reply.md"),
      `${"x\n".repeat(2000)}the real question\n`,
    );
    const text = judgeBrief(run, {
      id: "7",
      kind: "question",
      unit: "M1.L1",
      context: "Lane M1.L1: worker stopped.\nreply: roles/worker-M1.L1/D1/reply.md",
      findings: ["BUG src/a.ts — x", "NIT b.md — y"],
      lanes: [{ id: "M1.L1", owns: ["src/a/", "src/a2.ts"] }],
    });
    expect(text).toContain("Kind: question. Unit: M1.L1. Your verbs: answer, ask_owner.");
    expect(text).toContain("1. BUG src/a.ts — x");
    expect(text).toContain("2. NIT b.md — y");
    expect(text).toContain("- M1.L1: src/a/, src/a2.ts");
    expect(text).toContain("the real question");
    expect(text.length).toBeLessThan(5_000);
  });
});
